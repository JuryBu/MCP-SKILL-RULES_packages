import fs from "fs";
import { z } from "zod";
import path from "path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity } from "../lifecycle.js";
import { isGuardEvidenceInsufficient, isGuardInfrastructureError, runGuardCheck } from "../guard-engine.js";
import {
    readGuardState, writeGuardState, clearGuardState,
    insertLockMark, removeLockMark, addCheckResult,
    getGuardLocks, createGuardId, isCurrentGuard, listGuardStates, normalizeChildScopeId,
    type GuardState,
    type GuardCheckHistoryItem,
    type GuardLockOperationResult,
} from "../guard-store.js";
import { CHAIN_COMPAT_INPUT_VALUES, DATA_CHAIN_INPUT_VALUES, DEFAULT_CHAIN, resolveChainSplit, decideBackground, type Chain, type DataChain } from "../chain.js";
import { loadConversationData } from "../conversation-bridge.js";
import {
    formatBackgroundTask,
    registerBackgroundTaskRecoveryHandler,
    startBackgroundTask,
    waitForBackgroundTask,
} from "../background-tasks.js";
import type { BackgroundTaskContext } from "../background-tasks.js";
import { formatToolError } from "../error-format.js";
import { dataChainInputSchema, modelChainInputSchema } from "./schema-utils.js";
import type { ResumePayloadValue } from "../background-recovery.js";
import { DATA_ROOT, writeJsonAtomic } from "../store.js";

/**
 * Stage Guard — 任务完整性自动验证工具
 * 
 * action:
 *   start  — 注册守卫（传入 Plan/Task 文件路径）
 *   check  — 调用 Flash 比对，验证任务是否完成
 *   status — 查看当前 guard 状态
 *   cancel — 取消守卫，移除 🔒 标记
 */

const StageGuardSchema = z.object({
    action: z.enum(["start", "check", "status", "cancel"])
        .describe("操作类型：start=注册守卫, check=执行检查, status=查看状态, cancel=取消。⚠️ 项目有 Plan_x + Task.md 时，Stage 开始前必须 start，完成后必须 check 通过才能标记完成并通知用户"),
    taskFiles: z.array(z.string()).optional()
        .describe("start 时必填：Task.md 路径列表（至少 1 个）"),
    planFiles: z.array(z.string()).optional()
        .describe("start 时可选：Plan 文件路径列表"),
    stageId: z.string().optional()
        .describe("start 时可选：Stage 标识，如 'Stage 3'"),
    childScopeId: z.string().optional()
        .describe("可选：子任务 Guard 的稳定范围 ID；传入时必须同时传 scopeSelectors"),
    scopeSelectors: z.array(z.string().min(1)).optional()
        .describe("可选：子任务审核范围的稳定 Task 编号、小标题或任务锚点"),
    force: z.boolean().optional()
        .describe("start 时可选：仅在同一 GuardKey 已活跃时允许精确替换旧 Guard"),
    listAll: z.boolean().optional()
        .describe("status 时可选：直接列出全部活跃 Guard，不读取对话"),
    conversationId: z.string().optional()
        .describe("可选：显式指定要守卫的对话 ID，跨宿主场景建议传入"),
    chain: z.enum(CHAIN_COMPAT_INPUT_VALUES).default(DEFAULT_CHAIN)
        .describe("兼容旧参数：chain=\"windsurf\" 只作为数据链路；chain=\"grok\"/\"agy\" 只作为模型链路"),
    dataChain: dataChainInputSchema("dataChain", "可选：Guard 读取执行记录的链路，支持 antigravity/codex/claude-code/windsurf；agy 与 Grok 只支持 modelChain，未填默认 auto"),
    modelChain: modelChainInputSchema("modelChain", "模型链路：auto=Grok→（MEMORY_STORE_AGY_AUTO_ENABLED=1 时）agy→Antigravity→Codex→可选 Claude Code CLI；agy=本地 CLI 的三模型内部 fallback；Windsurf 只支持 dataChain"),
    startRound: z.number().optional()
        .describe("start 时可选：起始轮次（默认当前轮次）。可手动设为更早的轮次以覆盖已完成的工作"),
    appealNote: z.string().optional()
        .describe("check 时可选：AI 申诉说明（附加给 Flash 参考）"),
    evidence: z.string().optional()
        .describe("check 时可选：补录证据（如 Guard start 之前完成的修改，格式：文件名:行号 内容描述）"),
    evidenceFiles: z.array(z.string()).optional()
        .describe("check 时可选：外部证据文件路径列表。PDF/Word/Excel/EPUB/图片/视频会先生成纯文本证据索引，再进入 Guard 审查"),
    evidenceAssets: z.array(z.object({
        path: z.string().describe("外部证据文件绝对路径或相对路径"),
        label: z.string().optional().describe("证据标签，便于 Guard 报告显示"),
        type: z.string().optional().describe("可选类型提示：text/csv/image/pdf/doc/sheet/epub/video/binary"),
        role: z.string().optional().describe("证据角色，如 report/screenshot/spec/output"),
        range: z.string().optional().describe("可选范围提示，如 1-80、first200、last120"),
        maxChars: z.number().optional().describe("该文件索引进入 Guard prompt 的最大字符数"),
    })).optional()
        .describe("check 时可选：结构化外部证据文件输入，比 evidenceFiles 能提供更多标签和范围信息"),
    evidenceIndexMode: z.enum(["auto", "reuse", "rebuild", "off"]).optional()
        .describe("外部证据索引策略：auto=复用新鲜索引或重建，reuse=只复用缓存，rebuild=强制重建，off=只记录未读取提示"),
        background: z.boolean().optional()
            .describe("check 三态后台：true=强制后台立即返回 taskId / false=强制同步 / 不传时保持同步；Guard 默认不自动后台化"),
    taskId: z.string().optional()
        .describe("查询后台 Guard 检查任务的 taskId"),
    waitSeconds: z.number().optional()
        .describe("查询后台任务时等待秒数(1-300)，任务完成时提前返回"),
});

function text(t: string) {
    return { content: [{ type: "text" as const, text: t }] };
}

function responseText(response: ReturnType<typeof text>): string {
    return response.content.map(item => item.text).join("\n");
}

function resolveModelChain(params: z.infer<typeof StageGuardSchema>): Chain {
    return resolveChainSplit({ chain: params.chain, modelChain: params.modelChain }).modelChain;
}

function resolveDataChain(params: z.infer<typeof StageGuardSchema>): DataChain {
    return resolveChainSplit({ chain: DEFAULT_CHAIN, dataChain: params.dataChain }).dataChain;
}

function normalizeScopeSelectors(scopeSelectors?: string[]): string[] {
    return [...new Set((scopeSelectors || []).map(selector => selector.trim()).filter(Boolean))];
}

function formatGuardIdentity(state: GuardState): string {
    return [
        `guardId=${state.guardId}`,
        `stageId=${state.stageId || "(empty)"}`,
        `childScopeId=${state.childScopeId || "main"}`,
        `startedAt=${state.startedAt}`,
    ].join(", ");
}

function formatAmbiguousGuardCandidates(candidates: GuardState[]): string {
    return candidates.slice(0, 8).map(state => `- ${formatGuardIdentity(state)}`).join("\n");
}

async function resolveActiveGuard(params: z.infer<typeof StageGuardSchema>): Promise<
    | { state: GuardState; conversationId: string; dataChain: DataChain }
    | { error: string }
> {
    let conversationId = params.conversationId?.trim() || "";
    let dataChain = resolveDataChain(params);
    if (!conversationId) {
        const resolved = await resolveGuardConversationId(params);
        conversationId = resolved.conversationId;
        dataChain = resolved.dataChain;
    }
    if (!conversationId) return { error: "❌ 无法通过当前宿主链路确定要守卫的对话" };

    const candidates = listGuardStates(conversationId).filter(state => {
        if (params.stageId !== undefined && state.stageId !== params.stageId.trim()) return false;
        if (params.childScopeId !== undefined && state.childScopeId !== normalizeChildScopeId(params.childScopeId)) return false;
        return true;
    });
    if (candidates.length === 0) return { error: "❌ 没有活跃的 Stage Guard 匹配当前选择器。请先调用 stage_guard(action=\"start\")" };
    if (candidates.length > 1) {
        return {
            error: [
                "⚠️ 当前对话存在多个匹配的 Stage Guard，拒绝静默选择。",
                formatAmbiguousGuardCandidates(candidates),
                "请补充 stageId 和 childScopeId 后重试。",
            ].join("\n"),
        };
    }

    const candidate = candidates[0];
    const state = readGuardState(conversationId, candidate.stageId, candidate.childScopeId) || candidate;
    return { state, conversationId, dataChain };
}

function staleGuardCheckText(): ReturnType<typeof text> {
    return text("⚠️ Stage Guard 检查结果已过期，Guard 已被替换或取消，未写入状态、锁或 PASS receipt。");
}

function basename(file: string): string {
    return file.split(/[\\/]/).pop() || file;
}

function summarizeLockResults(results: Array<{ file: string; result: GuardLockOperationResult }>): string[] {
    return results.map(({ file, result }) => {
        const name = basename(file);
        if (!result.ok) return `🔒 ${name}: 锁操作失败 (${result.error || "unknown"})`;
        const remaining = result.lockCount > 0 ? `，当前文件共有 ${result.lockCount} 个 Guard 锁` : "";
        const legacy = result.legacyLockPresent && !result.legacyLockRemoved ? "，检测到旧锁并已保留" : "";
        return `🔒 ${name}: ${result.inserted ? "已添加本 Guard 锁" : result.removed ? "已移除本 Guard 锁" : "本 Guard 锁无变化"}${remaining}${legacy}`;
    });
}

async function resolveGuardConversationId(params: z.infer<typeof StageGuardSchema>) {
    const dataChain = resolveDataChain(params);
    const loaded = await loadConversationData(dataChain, params.conversationId, { link: "summary" });
    return {
        conversationId: loaded?.conversationId || params.conversationId || "",
        dataChain: loaded?.chainUsed || dataChain,
        roundsLength: loaded?.rounds.length || 0,
    };
}

// ============= Action Handlers =============

async function handleStart(params: z.infer<typeof StageGuardSchema>) {
    const taskFiles = params.taskFiles;
    if (!taskFiles || taskFiles.length === 0) {
        return text("❌ start 操作需要 taskFiles 参数（至少 1 个 Task.md 路径）");
    }

    // 验证文件存在
    const missing: string[] = [];
    for (const f of taskFiles) {
        if (!fs.existsSync(f)) missing.push(f);
    }
    for (const f of params.planFiles || []) {
        if (!fs.existsSync(f)) missing.push(f);
    }
    if (missing.length > 0) {
        return text(`❌ 文件不存在:\n${missing.map(f => `  - ${f}`).join("\n")}`);
    }

    const resolved = await resolveGuardConversationId(params);
    if (!resolved.conversationId) {
        return text(`❌ 无法通过当前宿主链路确定要守卫的对话`);
    }
    const conversationId = resolved.conversationId;
    const scopeSelectors = normalizeScopeSelectors(params.scopeSelectors);
    if (params.childScopeId !== undefined && scopeSelectors.length === 0) {
        return text("❌ childScopeId 必须同时提供至少一个非空 scopeSelectors，job_id 本身不能定义审核范围。");
    }
    const childScopeId = normalizeChildScopeId(params.childScopeId);

    const existing = readGuardState(conversationId, params.stageId || "", childScopeId);
    if (existing) {
        if (!params.force) {
            return text([
                "⚠️ 同一 GuardKey 已有活跃 Guard，未覆盖现有状态。",
                `📌 ${formatGuardIdentity(existing)}`,
                "如确认要替换，请显式传 force=true。",
            ].join("\n"));
        }
        const oldLockResults = existing.taskFiles.map(file => ({ file, result: removeLockMark(file, existing) }));
        if (oldLockResults.some(item => !item.result.ok)) {
            return text([
                "❌ force 覆盖前未能完整移除旧 Guard 锁，已保留旧状态以便恢复。",
                ...summarizeLockResults(oldLockResults),
            ].join("\n"));
        }
        if (!clearGuardState(existing)) {
            return text("❌ force 覆盖前未能清理旧 Guard 状态，已停止替换以保护现有 Guard。");
        }
    }

    // 自动获取当前轮次作为 startRound 默认值
    // 一轮 = 用户消息 + 模型所有内容，start 所在的这一轮也包含在内
    let startRound = params.startRound || 0;
    if (!startRound) startRound = Math.max(resolved.roundsLength, 1);
    if (!startRound) startRound = 1;

    // 创建 guard 状态
    const state: GuardState = {
        active: true,
        guardId: createGuardId(),
        conversationId,
        chain: resolved.dataChain,
        modelChain: resolveModelChain(params),
        stageId: params.stageId || "",
        childScopeId,
        scopeSelectors,
        taskFiles,
        planFiles: params.planFiles || [],
        startRound,
        startedAt: new Date().toISOString(),
        checkHistory: [],
    };
    writeGuardState(state);

    // 在所有 taskFile 头部插入当前 Guard 的独立 🔒 锁块。
    const lockResults = taskFiles.map(file => ({ file, result: insertLockMark(file, state) }));

    const lines: string[] = [
        `🛡 Stage Guard 已激活`,
        `🆔 Guard: ${state.guardId}`,
        state.stageId ? `📋 Stage: ${state.stageId}` : "",
        `🧩 子范围: ${state.childScopeId}`,
        state.scopeSelectors.length > 0 ? `🎯 审核选择器: ${state.scopeSelectors.join("；")}` : "",
        `📄 任务文件: ${taskFiles.map(basename).join(", ")}`,
        state.planFiles.length > 0
            ? `📄 计划文件: ${state.planFiles.map(basename).join(", ")}`
            : "",
        ...summarizeLockResults(lockResults),
        `🔗 对话链路: ${resolved.dataChain}`,
        `🧠 模型链路: ${state.modelChain || DEFAULT_CHAIN}`,
        state.startRound ? `⏱ 起始轮次: ${state.startRound}` : "",
        ``,
        `⚠️ 完成任务后请调用 stage_guard(action="check") 进行验证`,
    ].filter(Boolean);

    return text(lines.join("\n"));
}

function isBackgroundTaskAborted(taskContext?: Pick<BackgroundTaskContext, "isCancelled" | "isSettled">): boolean {
    return Boolean(taskContext?.isCancelled() || taskContext?.isSettled());
}

function formatAbortedGuardCheckText(taskContext?: Pick<BackgroundTaskContext, "isCancelled" | "isSettled">): ReturnType<typeof text> {
    if (taskContext?.isCancelled()) {
        return text("🛑 Stage Guard 后台检查已取消，未写入 Guard 报告或状态");
    }
    return text("🛑 Stage Guard 后台检查已结束，已跳过 Guard 报告和状态写回");
}

interface StageGuardCheckResumePayloadV1 {
    version: 1;
    conversationId: string;
    stageId: string;
    guardStartedAt: string;
    chain: z.infer<typeof StageGuardSchema>["chain"];
    dataChain?: z.infer<typeof StageGuardSchema>["dataChain"];
    modelChain?: z.infer<typeof StageGuardSchema>["modelChain"];
    appealNote?: string;
    evidence?: string;
    evidenceFiles?: string[];
    evidenceAssets?: z.infer<typeof StageGuardSchema>["evidenceAssets"];
    evidenceIndexMode?: z.infer<typeof StageGuardSchema>["evidenceIndexMode"];
}

interface StageGuardCheckResumePayloadV2 extends Omit<StageGuardCheckResumePayloadV1, "version"> {
    version: 2;
    guardId: string;
    childScopeId: string;
    scopeSelectors: string[];
}

type StageGuardCheckResumePayload = StageGuardCheckResumePayloadV1 | StageGuardCheckResumePayloadV2;

interface StageGuardPassReceiptV1 {
    version: 1;
    taskId: string;
    conversationId: string;
    stageId: string;
    guardStartedAt: string;
    checkedAt: string;
    taskFiles: string[];
    summary: string;
    selfReferenceResolved: boolean;
    reportPath?: string;
    evidenceIndexManifestPath?: string;
}

interface StageGuardPassReceiptV2 extends Omit<StageGuardPassReceiptV1, "version"> {
    version: 2;
    guardId: string;
    childScopeId: string;
    scopeSelectors: string[];
}

type StageGuardPassReceipt = StageGuardPassReceiptV1 | StageGuardPassReceiptV2;

function guardPassReceiptPath(taskId: string): string {
    return path.join(DATA_ROOT, "tasks", `${taskId}.guard-pass`);
}

function writeGuardPassReceipt(receipt: StageGuardPassReceipt): void {
    writeJsonAtomic(guardPassReceiptPath(receipt.taskId), receipt);
}

function readGuardPassReceipt(taskId: string): StageGuardPassReceipt | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(guardPassReceiptPath(taskId), "utf8")) as StageGuardPassReceipt;
        if (
            (parsed.version !== 1 && parsed.version !== 2)
            || parsed.taskId !== taskId
            || typeof parsed.conversationId !== "string"
            || typeof parsed.stageId !== "string"
            || typeof parsed.guardStartedAt !== "string"
            || !Array.isArray(parsed.taskFiles)
            || typeof parsed.summary !== "string"
        ) {
            return null;
        }
        if (parsed.version === 2 && (
            typeof (parsed as StageGuardPassReceiptV2).guardId !== "string"
            || typeof (parsed as StageGuardPassReceiptV2).childScopeId !== "string"
            || !Array.isArray((parsed as StageGuardPassReceiptV2).scopeSelectors)
        )) return null;
        return parsed;
    } catch {
        return null;
    }
}

function finalizeGuardPassReceipt(receipt: StageGuardPassReceipt, recovered: boolean): string {
    const childScopeId = receipt.version === 2 ? receipt.childScopeId : "main";
    const currentState = readGuardState(receipt.conversationId, receipt.stageId, childScopeId);
    const receiptMatchesCurrent = Boolean(currentState
        && currentState.startedAt === receipt.guardStartedAt
        && currentState.stageId === receipt.stageId
        && currentState.childScopeId === normalizeChildScopeId(childScopeId)
        && (receipt.version === 1 || currentState.guardId === receipt.guardId));
    if (!receiptMatchesCurrent || !currentState) {
        throw new Error("Guard PASS receipt 已过期，拒绝清理较新的 Guard 状态");
    }
    const lockResults = receipt.taskFiles.map(file => ({
        file,
        result: removeLockMark(file, currentState),
    }));
    if (lockResults.some(item => !item.result.ok)) {
        throw new Error("Guard PASS receipt 未能完整移除本 Guard 锁，已保留 Guard 状态便于恢复");
    }
    const remainingLocks = lockResults.reduce((sum, item) => sum + Math.max(0, item.result.lockCount), 0);
    if (!clearGuardState(currentState)) {
        throw new Error("Guard PASS receipt 未能清理本 Guard 状态，已停止收口");
    }
    return [
        "🛡 Stage Guard 检查: ✅ 通过",
        `📊 ${receipt.summary}`,
        receipt.selfReferenceResolved
            ? "⚠️ 已自动识别 Guard 自指收口项：实质证据已充分，缺口仅是 Guard 通过后才能写入的后置记录"
            : "",
        recovered ? "♻️ 已从持久化 PASS receipt 完成幂等收口，未重复调用审核模型" : "",
        `🔓 本 Guard 锁已移除${remainingLocks > 0 ? `，相关文件仍有 ${remainingLocks} 个其它 Guard 锁` : ""}`,
        ...summarizeLockResults(lockResults),
        receipt.reportPath ? `📄 详细报告: ${receipt.reportPath}` : "",
        receipt.evidenceIndexManifestPath ? `🧾 外部证据索引: ${receipt.evidenceIndexManifestPath}` : "",
    ].filter(Boolean).join("\n");
}

function buildStageGuardCheckResumePayload(
    params: z.infer<typeof StageGuardSchema>,
    state: GuardState,
): StageGuardCheckResumePayload {
    return {
        version: 2,
        conversationId: state.conversationId,
        stageId: state.stageId || "",
        guardStartedAt: state.startedAt,
        guardId: state.guardId,
        childScopeId: state.childScopeId,
        scopeSelectors: [...state.scopeSelectors],
        chain: params.chain,
        dataChain: params.dataChain,
        modelChain: params.modelChain,
        appealNote: params.appealNote,
        evidence: params.evidence,
        evidenceFiles: params.evidenceFiles ? [...params.evidenceFiles] : undefined,
        evidenceAssets: params.evidenceAssets ? params.evidenceAssets.map(asset => ({ ...asset })) : undefined,
        evidenceIndexMode: params.evidenceIndexMode,
    };
}

function isStageGuardCheckResumePayload(value: unknown): value is StageGuardCheckResumePayload {
    if (!value || typeof value !== "object") return false;
    const payload = value as Partial<StageGuardCheckResumePayload>;
    const isBasePayload = (payload.version === 1 || payload.version === 2)
        && typeof payload.conversationId === "string"
        && typeof payload.stageId === "string"
        && typeof payload.guardStartedAt === "string";
    if (!isBasePayload) return false;
    return payload.version !== 2 || (
        typeof payload.guardId === "string"
        && typeof payload.childScopeId === "string"
        && Array.isArray(payload.scopeSelectors)
    );
}

function buildStageGuardCheckParamsFromPayload(payload: StageGuardCheckResumePayload): z.infer<typeof StageGuardSchema> {
    return {
        action: "check",
        conversationId: payload.conversationId,
        stageId: payload.stageId,
        childScopeId: payload.version === 2 ? payload.childScopeId : "main",
        scopeSelectors: payload.version === 2 ? [...payload.scopeSelectors] : undefined,
        chain: payload.chain || DEFAULT_CHAIN,
        dataChain: payload.dataChain,
        modelChain: payload.modelChain,
        appealNote: payload.appealNote,
        evidence: payload.evidence,
        evidenceFiles: payload.evidenceFiles ? [...payload.evidenceFiles] : undefined,
        evidenceAssets: payload.evidenceAssets ? payload.evidenceAssets.map(asset => ({ ...asset })) : undefined,
        evidenceIndexMode: payload.evidenceIndexMode,
        background: false,
    };
}

function resumePayloadMatchesState(state: GuardState, payload: StageGuardCheckResumePayload): boolean {
    return state.stageId === payload.stageId
        && state.startedAt === payload.guardStartedAt
        && state.childScopeId === normalizeChildScopeId(payload.version === 2 ? payload.childScopeId : "main")
        && (payload.version === 1 || state.guardId === payload.guardId);
}

function receiptMatchesPayload(receipt: StageGuardPassReceipt, payload: StageGuardCheckResumePayload): boolean {
    if (receipt.conversationId !== payload.conversationId
        || receipt.stageId !== payload.stageId
        || receipt.guardStartedAt !== payload.guardStartedAt) return false;
    if (receipt.version === 1 || payload.version === 1) return true;
    return receipt.guardId === payload.guardId && receipt.childScopeId === payload.childScopeId;
}

function findCommittedCheckFromSameRun(
    taskStartedAt: string,
    state: GuardState,
): GuardCheckHistoryItem | null {
    const taskStartedMs = new Date(taskStartedAt).getTime();
    if (!Number.isFinite(taskStartedMs)) return null;
    const latest = state.checkHistory[state.checkHistory.length - 1];
    if (!latest) return null;
    const checkedAtMs = new Date(latest.checkedAt).getTime();
    if (!Number.isFinite(checkedAtMs) || checkedAtMs < taskStartedMs) return null;
    return latest;
}

function formatRecoveredCommittedGuardCheck(
    state: GuardState,
    history: GuardCheckHistoryItem,
): string {
    if (history.result === "pass") {
        throw new Error("Guard 历史已记录 PASS，但 Guard 状态仍存在；恢复时无法安全对账");
    }
    const maxChecks = 3;
    const lines = [
        `🛡 Stage Guard 检查: ❌ 未通过（第 ${history.checkNumber} 次）`,
        ``,
        `📊 ${history.summary}`,
    ];
    if (history.missingItems.length > 0) {
        lines.push(``, `遗漏 ${history.missingItems.length} 项:`);
        history.missingItems.forEach((item, index) => {
            lines.push(`${index + 1}. ${item}`);
        });
    }
    lines.push(
        ``,
        `♻️ 检测到同一次 Guard 检查结果已写入历史，本次恢复未重复调用模型，也未重复追加检查记录。`,
    );
    if (history.checkNumber >= maxChecks) {
        lines.push(
            ``,
            `⛔ 已连续 ${maxChecks} 次未通过，请上报用户裁定。`,
            `用户可查看现有报告或补齐证据后再决定下一步。`,
        );
    } else {
        lines.push(
            ``,
            `⚠️ 请补充遗漏项后再次调用 stage_guard(action="check")`,
            `（如认为 Flash 误判，可传入 appealNote 说明理由）`,
        );
    }
    return lines.join("\n");
}

registerBackgroundTaskRecoveryHandler("stage-guard-check", async (task) => {
    if (!isStageGuardCheckResumePayload(task.resumePayload)) {
        throw new Error("stage-guard-check 缺少可恢复的 conversationId/stageId/guardStartedAt payload");
    }
    const payload = task.resumePayload;
    return {
        mode: "restart",
        run: async (taskContext) => {
            const passReceipt = readGuardPassReceipt(task.id);
            if (passReceipt) {
                if (!receiptMatchesPayload(passReceipt, payload)) {
                    throw new Error("Guard PASS receipt 与恢复 payload 不匹配");
                }
                return finalizeGuardPassReceipt(passReceipt, true);
            }
            const state = readGuardState(
                payload.conversationId,
                payload.stageId,
                payload.version === 2 ? payload.childScopeId : "main",
            );
            if (!state) {
                throw new Error("Guard 状态缺失，无法安全恢复；请人工确认后重新执行 stage_guard(check)");
            }
            if (!resumePayloadMatchesState(state, payload)) {
                throw new Error("Guard 状态与恢复 payload 不匹配，无法安全恢复本次检查");
            }
            const committed = findCommittedCheckFromSameRun(task.startedAt, state);
            if (committed) {
                return formatRecoveredCommittedGuardCheck(state, committed);
            }
            const response = await handleCheck(
                buildStageGuardCheckParamsFromPayload(payload),
                true,
                taskContext,
                state,
            );
            return responseText(response);
        },
    };
});

async function handleCheck(
    params: z.infer<typeof StageGuardSchema>,
    backgroundModel = false,
    taskContext?: Pick<BackgroundTaskContext, "taskId" | "isCancelled" | "isSettled">,
    expectedGuard?: GuardState,
) {
    if (params.taskId) {
        const task = await waitForBackgroundTask(params.taskId, params.waitSeconds || 0);
        return text(formatBackgroundTask(task));
    }

    const decision = decideBackground(params.background, resolveModelChain(params), "never");

    const resolvedGuard = await resolveActiveGuard(params);
    if ("error" in resolvedGuard) return text(resolvedGuard.error);
    const { state, conversationId: convId } = resolvedGuard;
    if (expectedGuard && state.guardId !== expectedGuard.guardId) return staleGuardCheckText();
    if (isBackgroundTaskAborted(taskContext)) {
        return formatAbortedGuardCheckText(taskContext);
    }

    // Plan_30：stage_guard check 默认保持同步，避免阶段还未明确通过就被提前标记完成；
    // 仅显式 background=true 时才转后台。
    if (decision.useBackground) {
        const resumePayload = buildStageGuardCheckResumePayload(params, state);
        const task = startBackgroundTask("stage-guard-check", async (backgroundTaskContext) => {
            const result = await handleCheck(
                {
                    ...params,
                    background: false,
                    taskId: undefined,
                    waitSeconds: undefined,
                    conversationId: state.conversationId,
                    stageId: state.stageId,
                    childScopeId: state.childScopeId,
                    scopeSelectors: [...state.scopeSelectors],
                },
                true,
                backgroundTaskContext,
                state,
            );
            return responseText(result);
        }, {
            resumePayload: resumePayload as unknown as ResumePayloadValue,
        });
        return text([
            "🚀 Stage Guard 检查已转入后台任务",
            decision.auto ? "（未显式指定 background，已自动转后台；如需同步请传 background=false）" : "",
            `🆔 taskId: ${task.id}`,
            `🧠 modelChain: ${resolveModelChain(params)}`,
            "💡 后续调用 stage_guard(action=\"check\", taskId=\"...\") 查询结果",
        ].filter(Boolean).join("\n"));
    }

    // 调用 Flash 比对引擎
    const effectiveState = { ...state, modelChain: params.modelChain ? resolveModelChain(params) : (state.modelChain || resolveModelChain(params)) };
    const evidenceAssets = [
        ...(params.evidenceFiles || []).map(filePath => ({ path: filePath })),
        ...(params.evidenceAssets || []),
    ];
    const result = await runGuardCheck(effectiveState, params.appealNote, params.evidence, {
        background: backgroundModel,
        evidenceAssets,
        evidenceIndexMode: params.evidenceIndexMode,
        isCancelled: taskContext?.isCancelled,
        isSettled: taskContext?.isSettled,
    });
    if (result.cancelled || isBackgroundTaskAborted(taskContext)) {
        return formatAbortedGuardCheckText(taskContext);
    }
    if (!isCurrentGuard(state)) return staleGuardCheckText();

    if (isGuardInfrastructureError(result)) {
        const checkCount = state.checkHistory.length;
        return text([
            `🛡 Stage Guard 检查: ⚠️ 未完成（模型链路失败，未计入未通过次数）`,
            ``,
            `📊 ${result.summary}`,
            ``,
            `🔍 当前已记录的审查未通过次数仍为 ${checkCount} 次。`,
            `💡 请稍后重试 stage_guard(action="check")，或改用可用的 modelChain；这不是任务内容缺口。`,
        ].join("\n"));
    }

    if (isGuardEvidenceInsufficient(result)) {
        const checkCount = state.checkHistory.length;
        return text([
            `🛡 Stage Guard 检查: ⚠️ 未完成（证据不足或截断风险，未计入未通过次数）`,
            ``,
            `📊 ${result.summary}`,
            result.evidenceInsufficientReason ? `📌 类型: ${result.evidenceInsufficientReason}` : "",
            result.reportPath ? `📄 详细报告: ${result.reportPath}` : "",
            result.evidenceIndexManifestPath ? `🧾 外部证据索引: ${result.evidenceIndexManifestPath}` : "",
            ``,
            `🔍 当前已记录的审查未通过次数仍为 ${checkCount} 次。`,
            `💡 请补充 evidence、缩小 stageId，或根据报告里的 coverage 补读缺失片段后重试。`,
        ].filter(Boolean).join("\n"));
    }

    let passReceipt: StageGuardPassReceipt | null = null;
    if (result.passed && taskContext?.taskId) {
        passReceipt = {
            version: 2,
            taskId: taskContext.taskId,
            conversationId: convId,
            stageId: state.stageId,
            guardStartedAt: state.startedAt,
            guardId: state.guardId,
            childScopeId: state.childScopeId,
            scopeSelectors: [...state.scopeSelectors],
            checkedAt: new Date().toISOString(),
            taskFiles: [...state.taskFiles],
            summary: result.summary,
            selfReferenceResolved: result.selfReferenceResolved === true,
            reportPath: result.reportPath,
            evidenceIndexManifestPath: result.evidenceIndexManifestPath,
        };
        writeGuardPassReceipt(passReceipt);
    }

    // 记录检查历史
    const recordedState = addCheckResult(
        state,
        result.passed ? "pass" : "fail",
        result.summary,
        result.missingItems
    );
    if (!recordedState || !isCurrentGuard(state)) return staleGuardCheckText();

    if (result.passed) {
        if (passReceipt) {
            return text(finalizeGuardPassReceipt(passReceipt, false));
        }

        const lockResults = state.taskFiles.map(file => ({ file, result: removeLockMark(file, state) }));
        if (lockResults.some(item => !item.result.ok)) {
            return text(["❌ Guard 已记录 PASS，但本 Guard 锁未能完整移除，已保留状态便于恢复。", ...summarizeLockResults(lockResults)].join("\n"));
        }
        const remainingLocks = lockResults.reduce((sum, item) => sum + Math.max(0, item.result.lockCount), 0);
        if (!clearGuardState(state)) return staleGuardCheckText();
        return text([
            "🛡 Stage Guard 检查: ✅ 通过",
            `📊 ${result.summary}`,
            result.selfReferenceResolved
                ? "⚠️ 已自动识别 Guard 自指收口项：实质证据已充分，缺口仅是 Guard 通过后才能写入的后置记录"
                : "",
            `🔓 本 Guard 锁已移除${remainingLocks > 0 ? `，相关文件仍有 ${remainingLocks} 个其它 Guard 锁` : ""}`,
            ...summarizeLockResults(lockResults),
            result.reportPath ? `📄 详细报告: ${result.reportPath}` : "",
            result.evidenceIndexManifestPath ? `🧾 外部证据索引: ${result.evidenceIndexManifestPath}` : "",
        ].filter(Boolean).join("\n"));
    }

    // ❌ 未通过
    const updatedState = readGuardState(state.conversationId, state.stageId, state.childScopeId);
    const checkCount = updatedState?.checkHistory.length || 1;
    const maxChecks = 3;

    const lines = [
        `🛡 Stage Guard 检查: ❌ 未通过（第 ${checkCount} 次）`,
        ``,
        `📊 ${result.summary}`,
    ];

    if (result.missingItems.length > 0) {
        lines.push(``, `遗漏 ${result.missingItems.length} 项:`);
        result.missingItems.forEach((item, i) => {
            lines.push(`${i + 1}. ${item}`);
        });
    }

    if (result.reportPath) {
        lines.push(``, `📄 详细报告: ${result.reportPath}`);
    }
    if (result.evidenceIndexManifestPath) {
        lines.push(`🧾 外部证据索引: ${result.evidenceIndexManifestPath}`);
    }

    if (checkCount >= maxChecks) {
        lines.push(
            ``,
            `⛔ 已连续 ${maxChecks} 次未通过，请上报用户裁定。`,
            `用户可查看报告后决定是否 cancel 或继续补做。`
        );
    } else {
        lines.push(
            ``,
            `⚠️ 请补充遗漏项后再次调用 stage_guard(action="check")`,
            `（如认为 Flash 误判，可传入 appealNote 说明理由）`
        );
    }

    return text(lines.join("\n"));
}

async function handleStatus(params: z.infer<typeof StageGuardSchema>) {
    if (params.listAll) {
        const states = listGuardStates();
        if (states.length === 0) return text("🛡 Stage Guard: 未激活\n没有正在监控的 Stage。");
        return text([
            `🛡 Stage Guard: ✅ 共 ${states.length} 个活跃 Guard（未读取对话）`,
            ...states.map(state => [
                `🆔 ${state.guardId}`,
                `📋 ${state.stageId || "未指定 Stage"}`,
                `🧩 ${state.childScopeId || "main"}`,
                `🔗 ${state.conversationId}`,
                state.scopeSelectors.length > 0 ? `🎯 ${state.scopeSelectors.join("；")}` : "",
            ].filter(Boolean).join(" | ")),
        ].join("\n"));
    }
    const resolvedGuard = await resolveActiveGuard(params);
    if ("error" in resolvedGuard) return text(resolvedGuard.error);
    const { state } = resolvedGuard;

    const checks = state.checkHistory;
    const lastCheck = checks.length > 0 ? checks[checks.length - 1] : null;

    const lines: string[] = [
        `🛡 Stage Guard: ✅ 活跃`,
        `🆔 Guard: ${state.guardId}`,
        state.stageId ? `📋 Stage: ${state.stageId}` : "",
        `🧩 子范围: ${state.childScopeId || "main"}`,
        state.scopeSelectors.length > 0 ? `🎯 审核选择器: ${state.scopeSelectors.join("；")}` : "",
        `📄 任务文件: ${state.taskFiles.map(basename).join(", ")}`,
        state.planFiles.length > 0
            ? `📄 计划文件: ${state.planFiles.map(basename).join(", ")}`
            : "",
        `🔒 文件锁: ${state.taskFiles.map(f => `${basename(f)}=${getGuardLocks(f).length}`).join(", ")}`,
        `⏱ 激活时间: ${state.startedAt}`,
        `🔗 对话链路: ${state.chain || DEFAULT_CHAIN}`,
        `🧠 模型链路: ${state.modelChain || state.chain || DEFAULT_CHAIN}`,
        state.startRound ? `📍 起始轮次: ${state.startRound}` : "",
        `🔍 检查次数: ${checks.length}`,
        lastCheck
            ? `📝 最近结果: ${lastCheck.result === "pass" ? "✅ 通过" : "❌ 未通过"} — ${lastCheck.summary}`
            : "",
    ].filter(Boolean);

    return text(lines.join("\n"));
}

async function handleCancel(params: z.infer<typeof StageGuardSchema>) {
    const resolvedGuard = await resolveActiveGuard(params);
    if ("error" in resolvedGuard) {
        return text(resolvedGuard.error.includes("没有活跃的 Stage Guard 匹配当前选择器")
            ? "🛡 Stage Guard 未激活，无需取消。"
            : resolvedGuard.error);
    }
    const { state } = resolvedGuard;

    const lockResults = state.taskFiles.map(file => ({ file, result: removeLockMark(file, state) }));
    if (lockResults.some(item => !item.result.ok)) {
        return text(["❌ 未能完整移除本 Guard 锁，已保留 Guard 状态便于恢复。", ...summarizeLockResults(lockResults)].join("\n"));
    }
    const remainingLocks = lockResults.reduce((sum, item) => sum + Math.max(0, item.result.lockCount), 0);

    if (!clearGuardState(state)) return staleGuardCheckText();

    return text(
        `🛡 Stage Guard 已取消\n` +
        `🔓 本 Guard 锁已移除${remainingLocks > 0 ? `，相关文件仍有 ${remainingLocks} 个其它 Guard 锁` : ""}\n` +
        summarizeLockResults(lockResults).join("\n")
    );
}

// ============= 工具注册 =============

/**
 * stage_guard 工具主入口（从注册回调抽出，便于单测直接调用）。
 * ⚠️ C3 块A：注册回调原本没有顶层 try/catch——任一 handler 抛异常会冒泡到 MCP
 * 协议层导致服务崩溃。这里补一层兜底，把异常转成结构化错误文本返回，绝不让它冒泡。
 */
export async function runStageGuard(params: z.infer<typeof StageGuardSchema>): Promise<ReturnType<typeof text>> {
    touchActivity();
    try {
        switch (params.action) {
            case "start":
                return await handleStart(params);
            case "check":
                return await handleCheck(params);
            case "status":
                return handleStatus(params);
            case "cancel":
                return handleCancel(params);
            default:
                return text(`❌ 未知 action: ${params.action}`);
        }
    } catch (err) {
        return text(formatToolError(`stage_guard(${params.action})`, err, {
            action: params.action,
            conversationId: params.conversationId,
            stageId: params.stageId,
            chain: params.chain,
            dataChain: params.dataChain,
            modelChain: params.modelChain,
            background: params.background,
        }));
    }
}

export function registerStageGuard(server: McpServer): void {
    server.tool(
        "stage_guard",
        "任务完整性自动验证：start 注册守卫 → check Flash比对检查 → status 查看状态 → cancel 取消。" +
        "配合 RULES 强制调用，每个 Stage 完成前必须 check 通过后才能标记完成。",
        StageGuardSchema.shape,
        async (params) => runStageGuard(params),
    );
}
