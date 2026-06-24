import fs from "fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { touchActivity } from "../lifecycle.js";
import { isGuardEvidenceInsufficient, isGuardInfrastructureError, runGuardCheck } from "../guard-engine.js";
import {
    readGuardState, writeGuardState, clearGuardState,
    insertLockMark, removeLockMark, addCheckResult,
    getGuardLocks,
    type GuardState,
    type GuardLockOperationResult,
} from "../guard-store.js";
import { DATA_CHAIN_INPUT_VALUES, DEFAULT_CHAIN, resolveChainSplit, decideBackground, type Chain, type DataChain } from "../chain.js";
import { loadConversationData } from "../conversation-bridge.js";
import { startBackgroundTask, waitForBackgroundTask, formatBackgroundTask } from "../background-tasks.js";
import { formatToolError } from "../error-format.js";
import { modelChainInputSchema } from "./schema-utils.js";

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
    conversationId: z.string().optional()
        .describe("可选：显式指定要守卫的对话 ID，跨宿主场景建议传入"),
    chain: z.enum(DATA_CHAIN_INPUT_VALUES).default(DEFAULT_CHAIN)
        .describe("兼容旧参数：chain=\"windsurf\" 只作为数据链路；模型链路仍默认 auto"),
    dataChain: z.enum(DATA_CHAIN_INPUT_VALUES).optional()
        .describe("可选：Guard 读取执行记录的链路，支持 antigravity/codex/claude-code/windsurf；未填默认 auto"),
    modelChain: modelChainInputSchema("modelChain", "模型链路：auto=当前宿主优先，claude-code=显式 Claude Code CLI；Windsurf 只支持 dataChain"),
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
        .describe("check 三态后台：true=强制后台立即返回 taskId / false=强制同步 / 不传时仅 codex 链路自动转后台（避免 60s 超时），后续用同工具 taskId 查询"),
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

    // 自动获取当前轮次作为 startRound 默认值
    // 一轮 = 用户消息 + 模型所有内容，start 所在的这一轮也包含在内
    let startRound = params.startRound || 0;
    if (!startRound) startRound = Math.max(resolved.roundsLength, 1);
    if (!startRound) startRound = 1;

    // 创建 guard 状态
    const state: GuardState = {
        active: true,
        conversationId,
        chain: resolved.dataChain,
        modelChain: resolveModelChain(params),
        stageId: params.stageId || "",
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
        state.stageId ? `📋 Stage: ${state.stageId}` : "",
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

async function handleCheck(params: z.infer<typeof StageGuardSchema>, backgroundModel = false) {
    if (params.taskId) {
        const task = await waitForBackgroundTask(params.taskId, params.waitSeconds || 0);
        return text(formatBackgroundTask(task));
    }

    // C3 块B：三态 background 语义（详见 chain.ts decideBackground）。
    // 仅 codex 这类 heavy 链路在 background 未传时自动转后台（避免 60s 超时），其余链路未传仍同步（行为不变）。
    const decision = decideBackground(params.background, resolveModelChain(params));
    if (decision.useBackground) {
        const task = startBackgroundTask("stage-guard-check", async () => {
            const result = await handleCheck({ ...params, background: false, taskId: undefined, waitSeconds: undefined }, true);
            return responseText(result);
        });
        return text([
            "🚀 Stage Guard 检查已转入后台任务",
            decision.auto ? "（codex 重链路下未显式指定 background，已自动转后台以避免 60s 超时；如需同步请传 background=false）" : "",
            `🆔 taskId: ${task.id}`,
            `🧠 modelChain: ${resolveModelChain(params)}`,
            "💡 后续调用 stage_guard(action=\"check\", taskId=\"...\") 查询结果",
        ].filter(Boolean).join("\n"));
    }

    let convId = params.conversationId || "";
    let state = convId ? readGuardState(convId) : null;
    if (!state) {
        const resolved = await resolveGuardConversationId(params);
        convId = resolved.conversationId;
        state = readGuardState(convId);
    }
    if (!state) {
        return text("❌ 没有活跃的 Stage Guard。请先调用 stage_guard(action=\"start\")");
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
    });

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

    // 记录检查历史
    addCheckResult(
        convId,
        result.passed ? "pass" : "fail",
        result.summary,
        result.missingItems
    );

    if (result.passed) {
        // ✅ 通过 → 移除 🔒 + 清理 guard
        const lockResults = state.taskFiles.map(file => ({ file, result: removeLockMark(file, convId) }));
        const remainingLocks = lockResults.reduce((sum, item) => sum + Math.max(0, item.result.lockCount), 0);
        clearGuardState(convId);

        return text(
            `🛡 Stage Guard 检查: ✅ 通过\n` +
            `📊 ${result.summary}\n` +
            (result.selfReferenceResolved
                ? `⚠️ 已自动识别 Guard 自指收口项：实质证据已充分，缺口仅是 Guard 通过后才能写入的后置记录\n`
                : "") +
            `🔓 本 Guard 锁已移除${remainingLocks > 0 ? `，相关文件仍有 ${remainingLocks} 个其它 Guard 锁` : ""}\n` +
            summarizeLockResults(lockResults).join("\n") + "\n" +
            (result.reportPath ? `📄 详细报告: ${result.reportPath}\n` : "") +
            (result.evidenceIndexManifestPath ? `🧾 外部证据索引: ${result.evidenceIndexManifestPath}` : "")
        );
    }

    // ❌ 未通过
    const updatedState = readGuardState(convId);
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
    const resolved = await resolveGuardConversationId(params);
    const convId = resolved.conversationId;
    const state = readGuardState(convId);
    if (!state) {
        return text("🛡 Stage Guard: 未激活\n没有正在监控的 Stage。");
    }

    const checks = state.checkHistory;
    const lastCheck = checks.length > 0 ? checks[checks.length - 1] : null;

    const lines: string[] = [
        `🛡 Stage Guard: ✅ 活跃`,
        state.stageId ? `📋 Stage: ${state.stageId}` : "",
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
    const resolved = await resolveGuardConversationId(params);
    const convId = resolved.conversationId;
    const state = readGuardState(convId);
    if (!state) {
        return text("🛡 Stage Guard 未激活，无需取消。");
    }

    // 只移除当前 conversationId 对应的锁块，保留同文件上的其它 Guard 锁。
    const lockResults = state.taskFiles.map(file => ({ file, result: removeLockMark(file, convId) }));
    const remainingLocks = lockResults.reduce((sum, item) => sum + Math.max(0, item.result.lockCount), 0);

    clearGuardState(convId);

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
