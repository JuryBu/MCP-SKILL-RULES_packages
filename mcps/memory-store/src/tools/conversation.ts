import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { touchActivity, appendTiming } from "../lifecycle.js";
import { saveTempFileAsync } from "../temp-store.js";
import {
    formatRound,
    formatOverview,
    formatRoundForMessageRoles,
    normalizeMessageRoles,
    searchInRounds,
    type ConversationMessageRole,
    type Depth,
    type ExtraType,
    type ConversationRound,
    type CompactionMode,
} from "../trajectory.js";
import { generateRecord, countPhasesInRecord, shouldAutoUpdateRecordAsync, validateRecordCandidateForWrite } from "../record-generator.js";
import { readRecordAsync, writeRecord, resolveWorkspaceHashForRecord, findRecordHashAsync } from "../record-store.js";
import { acquireRecordSingleFlightPermit, buildAndPersistRecordReaderIndex, withRecordPersistenceWrite } from "../record-update-coordination.js";
import { loadConversationData, resolveConversationChain } from "../conversation-bridge.js";
import { CHAIN_COMPAT_INPUT_VALUES, DATA_CHAIN_INPUT_VALUES, DEFAULT_CHAIN, DEFAULT_LINK_MODE, resolveChainSplit } from "../chain.js";
import { formatToolError } from "../error-format.js";
import { modelChainInputSchema } from "./schema-utils.js";
import { listConversationsByMtime } from "../ls-client.js";
import {
    deepLocateCodexConversations,
    findCodexContextProbeMatches,
    getCodexParentThread,
    getCodexThread,
    listCodexThreadsForMetadata,
    listRecentCodexThreads,
    type CodexDeepLocateResult,
    type CodexThreadInfo,
} from "../codex-client.js";
import {
    deepLocateClaudeCodeConversations,
    findClaudeCodeContextProbeMatches,
    getClaudeCodeThread,
    listRecentClaudeCodeThreads,
    type ClaudeCodeDeepLocateResult,
    type ClaudeCodeThreadInfo,
} from "../claude-code-client.js";
import { listRecentWindsurfThreads, type WindsurfConversationSummary } from "../windsurf-client.js";
import type { DataChain, ConversationLogicalChainMode } from "../chain.js";
import type { SearchMode, TextBlock } from "../search-engine.js";
import { formatAttachmentOverview, materializeRoundAttachments } from "../conversation-attachments.js";
import {
    cancelBackgroundTask,
    formatBackgroundTask,
    registerBackgroundTaskRecoveryHandler,
    startBackgroundTask,
    waitForBackgroundTask,
} from "../background-tasks.js";
import type { BackgroundTaskContext, BackgroundTaskProgress } from "../background-tasks.js";
import { exportConversation, formatConversationExportResult } from "../conversation-exporter.js";
import {
    listConversationCandidates,
    formatSourceStatuses,
    type SourceFailureMode,
    type IdResolutionMode,
    type WorkspaceMatchScope,
    type ConversationThreadMode,
} from "../conversation-filter.js";
import {
    createConversationBatchExportResumePayload,
    exportConversationBatch,
    formatConversationBatchExportResult,
    resumeConversationBatchExport,
    type ConversationBatchExportResumePayload,
} from "../conversation-batch-export.js";
import type { ResumePayloadValue } from "../background-recovery.js";

const CONVERSATION_FETCH_TEXT_MAX_CHARS = Number(process.env.MEMORY_STORE_CONVERSATION_FETCH_TEXT_MAX_CHARS || 2_000_000);
const CONVERSATION_READ_TEXT_BUILD_MAX_CHARS = Number(process.env.MEMORY_STORE_CONVERSATION_READ_TEXT_BUILD_MAX_CHARS || 2_000_000);
const CONVERSATION_SEARCH_BLOCK_MAX_CHARS = Number(process.env.MEMORY_STORE_CONVERSATION_SEARCH_BLOCK_MAX_CHARS || 60_000);
const CONVERSATION_LIST_TITLE_MAX_CHARS = Math.max(Number(process.env.MEMORY_STORE_CONVERSATION_LIST_TITLE_MAX_CHARS || 120), 20);
const CONVERSATION_DIRECT_ACTIONS = new Set(["fetch", "search", "read", "export"]);

function isBackgroundTaskAborted(taskContext?: Pick<BackgroundTaskContext, "isCancelled" | "isSettled">): boolean {
    return Boolean(taskContext?.isCancelled() || taskContext?.isSettled());
}

export function shouldRequireExplicitConversationId(
    action: string,
    dataChain: DataChain,
    conversationId?: string,
): boolean {
    return CONVERSATION_DIRECT_ACTIONS.has(action)
        && !conversationId?.trim()
        && dataChain !== "antigravity";
}

function formatMissingConversationIdMessage(action: string, dataChain: DataChain): string {
    return [
        `❌ conversation_read_original(${action}) 需要显式 conversationId`,
        `当前 dataChain=${dataChain}，共享后端不能安全推断“当前对话”，否则可能读到别的宿主或别的窗口里的对话。`,
        `做法：先用 conversation_read_original(action="list", dataChain="${dataChain === "auto" ? "codex|antigravity|claude-code|windsurf" : dataChain}", query="标题或关键词") 定位 ID，再把 conversationId 传给 ${action}。`,
        `注意：共享 broker 后端会拦截所有无 conversationId 的调用（含 antigravity）——跨 session 共享后端无法安全推断「当前对话」（与多窗口路由同源），「读当前窗口」兼容路径在 broker 下不可用，务必先 list 定位 ID 再显式传入。`,
    ].join("\n");
}

export function normalizeListQuery(input: string): string {
    return input
        .toLowerCase()
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}]+/gu, "");
}

function isUsefulListQueryTerm(term: string): boolean {
    if (!term) return false;
    if (/^[a-z0-9]$/u.test(term)) return false;
    return term.length >= 2 || /[\u3400-\u9fff]/u.test(term);
}

export function splitListQueryTerms(input: string): string[] {
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const rawTerm of input.trim().split(/\s+/u)) {
        const term = normalizeListQuery(rawTerm);
        if (!isUsefulListQueryTerm(term) || seen.has(term)) continue;
        seen.add(term);
        terms.push(term);
    }
    return terms;
}

export interface ConversationListCandidate {
    id: string;
    title: string;
    workspace: string;
    workspaces?: string[];
    updatedAt: string;
    detail: string;
    contextProbe?: string[];
    searchAliases?: string[];
    agentRole?: string | null;
    agentNickname?: string | null;
    parentConversationId?: string | null;
    rootConversationId?: string | null;
    isChildThread?: boolean;
    matchedChildConversationId?: string | null;
    matchedChildTitle?: string | null;
}

function uniqueWorkspaceLines(primary?: string, all?: string[]): string[] {
    const result: string[] = [];
    for (const item of [primary, ...(all || [])]) {
        const workspace = item?.trim();
        if (!workspace) continue;
        if (!result.some(existing => existing.toLowerCase() === workspace.toLowerCase())) {
            result.push(workspace);
        }
    }
    return result;
}

function formatWorkspaceLines(primary?: string, all?: string[]): string {
    const workspaces = uniqueWorkspaceLines(primary, all);
    if (workspaces.length === 0) return "";
    if (workspaces.length === 1) return `\n   工作区: ${workspaces[0]}`;
    return `\n   工作区: ${workspaces[0]}\n   关联工作区: ${workspaces.slice(1).join(" | ")}`;
}

function formatCodexSubagentSourceNote(loaded: { chainUsed?: string; codexData?: { thread?: CodexThreadInfo; parentThread?: CodexThreadInfo | null } }): string {
    if (loaded.chainUsed !== "codex") return "";
    const thread = loaded.codexData?.thread;
    if (!thread?.agentRole && !thread?.agentNickname) return "";
    const parentThread = loaded.codexData?.parentThread || getCodexParentThread(thread.id);
    return [
        "🤝 Codex 子代理线程",
        parentThread?.id ? `parentConversationId: ${parentThread.id}` : "parentConversationId: (未找到)",
        parentThread?.title ? `源头标题: ${formatConversationListTitleForTest(parentThread.title, 80)}` : "",
        thread.agentRole ? `子代理角色: ${thread.agentRole}` : "",
        thread.agentNickname ? `子代理名称: ${thread.agentNickname}` : "",
    ].filter(Boolean).join("\n");
}

function formatSubagentSourceNote(loaded: {
    chainUsed?: string;
    codexData?: { thread?: CodexThreadInfo; parentThread?: CodexThreadInfo | null };
    claudeCodeData?: { thread?: ClaudeCodeThreadInfo };
    windsurfData?: { thread?: WindsurfConversationSummary };
}): string {
    if (loaded.chainUsed === "codex") return formatCodexSubagentSourceNote(loaded);
    if (loaded.chainUsed === "claude-code") {
        const thread = loaded.claudeCodeData?.thread;
        if (!thread?.isChildThread && !thread?.parentConversationId) return "";
        return [
            "🤝 Claude Code 子代理线程",
            `parentConversationId: ${thread?.parentConversationId || "(未找到)"}`,
            thread?.agentRole ? `子代理角色: ${thread.agentRole}` : "",
            thread?.agentNickname ? `子代理名称: ${thread.agentNickname}` : "",
        ].filter(Boolean).join("\n");
    }
    if (loaded.chainUsed === "windsurf") {
        const thread = loaded.windsurfData?.thread;
        if (!thread?.isChildThread && !thread?.parentConversationId) return "";
        return [
            "🤝 Windsurf 子代理线程",
            `parentConversationId: ${thread?.parentConversationId || "(未找到)"}`,
            thread?.agentRole ? `子代理角色: ${thread.agentRole}` : "",
            thread?.agentNickname ? `子代理名称: ${formatConversationListTitleForTest(thread.agentNickname, 80)}` : "",
        ].filter(Boolean).join("\n");
    }
    return "";
}

function isLoadedSubagentThread(loaded: {
    chainUsed?: string;
    codexData?: { thread?: CodexThreadInfo };
    claudeCodeData?: { thread?: ClaudeCodeThreadInfo };
    windsurfData?: { thread?: WindsurfConversationSummary };
}): boolean {
    if (loaded.chainUsed === "codex") {
        return Boolean(loaded.codexData?.thread?.agentRole || loaded.codexData?.thread?.agentNickname || loaded.codexData?.thread?.parentConversationId);
    }
    if (loaded.chainUsed === "claude-code") {
        return Boolean(loaded.claudeCodeData?.thread?.isChildThread || loaded.claudeCodeData?.thread?.parentConversationId);
    }
    if (loaded.chainUsed === "windsurf") {
        return Boolean(loaded.windsurfData?.thread?.isChildThread || loaded.windsurfData?.thread?.parentConversationId);
    }
    return false;
}

function formatClaudeCodeLogicalChainNote(loaded: { chainUsed?: string; claudeCodeData?: any }): string {
    if (loaded.chainUsed !== "claude-code") return "";
    const info = loaded.claudeCodeData?.logicalChain;
    if (!info || info.mode === "off") return "";
    const candidates = (info.segments || [])
        .filter((item: any) => item.role !== "target")
        .slice(0, 5)
        .map((item: any) => {
            const role = item.role === "predecessor-merged" ? "已合并" : "候选";
            const title = formatConversationListTitleForTest(item.thread?.title || "(无标题)", 60);
            const negatives = item.negativeEvidence?.length ? `；否定证据: ${item.negativeEvidence.join(" / ")}` : "";
            return `- ${role} ${item.thread?.id || "(未知)"} | ${title} | score=${item.score}${negatives}`;
        });
    return [
        `🧩 Claude Code 逻辑续聊: mode=${info.mode}, ${info.merged ? "已合并恢复" : "未合并，保持物理对话"}`,
        ...(info.warnings || []).map((item: string) => `⚠️ ${item}`),
        ...candidates,
    ].filter(Boolean).join("\n");
}

function formatConversationSearchHeader(
    cascadeId: string,
    loaded: { chainUsed?: string; codexData?: { thread?: CodexThreadInfo; parentThread?: CodexThreadInfo | null }; claudeCodeData?: any; windsurfData?: any },
    modelChain?: string,
): string {
    const subagentNote = formatSubagentSourceNote(loaded);
    const logicalChainNote = formatClaudeCodeLogicalChainNote(loaded);
    return [
        `📂 对话: ${cascadeId}`,
        `🔗 数据链路: ${loaded.chainUsed}${modelChain ? ` | 模型链路: ${modelChain}` : ""}`,
        subagentNote,
        logicalChainNote,
    ].filter(Boolean).join("\n");
}

export function formatConversationListTitleForTest(title: string, maxChars = CONVERSATION_LIST_TITLE_MAX_CHARS): string {
    const normalized = (title || "(无标题)").replace(/\s+/gu, " ").trim() || "(无标题)";
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, Math.max(maxChars - 19, 1)).trimEnd()}… [titleTruncated]`;
}

export function formatConversationListDisplayTitleForTest(
    title: string,
    options: { dataChain?: string; agentRole?: string | null; agentNickname?: string | null } = {},
    maxChars = CONVERSATION_LIST_TITLE_MAX_CHARS,
): string {
    const base = formatConversationListTitleForTest(title, maxChars);
    if (options.agentRole || options.agentNickname) {
        const role = options.agentRole || options.agentNickname || "subagent";
        return `子代理对话(${role})：${base}`;
    }
    return base;
}

function buildConversationListLines(
    resolved: DataChain,
    shown: ConversationListCandidate[],
    total: number,
    query?: string,
    matchMode?: string,
    notes: string[] = [],
): string[] {
    return [
        `🔎 链路: ${resolved}`,
        `候选对话: ${shown.length}/${total}${query ? ` | 关键词: ${query}` : ""}${matchMode ? ` | 匹配: ${matchMode}` : ""}`,
        ...(notes.length ? ["", ...notes] : []),
        "",
        ...shown.map((item, idx) => {
            const title = formatConversationListDisplayTitleForTest(item.title, {
                dataChain: resolved,
                agentRole: item.agentRole,
                agentNickname: item.agentNickname,
            });
            const ws = formatWorkspaceLines(item.workspace, item.workspaces);
            const detail = item.detail ? ` | ${item.detail}` : "";
            const probe = item.contextProbe?.length
                ? `\n   🎯 contextProbe: ${item.contextProbe.join("；")}`
                : "";
            return `${idx + 1}. ${title}\n   ID: ${item.id}\n   更新时间: ${item.updatedAt || "(未知)"}${detail}${ws}${probe}`;
        }),
    ];
}

function candidateFromCodexThread(item: CodexThreadInfo): ConversationListCandidate {
    const parentThread = item.parentConversationId ? null : ((item.agentRole || item.agentNickname) ? getCodexParentThread(item.id) : null);
    const parentConversationId = item.parentConversationId || parentThread?.id || null;
    return {
        id: item.id,
        title: item.title || "",
        workspace: item.cwd || "",
        updatedAt: item.updatedAtMs ? new Date(item.updatedAtMs).toISOString() : "",
        detail: [
            item.agentRole ? `agent=${item.agentRole}` : "",
            parentConversationId ? "childThread" : "",
            parentConversationId ? `parentConversationId=${parentConversationId}` : "",
            item.model,
            item.reasoningEffort,
        ].filter(Boolean).join(" / "),
        agentRole: item.agentRole || null,
        agentNickname: item.agentNickname || null,
        parentConversationId,
        rootConversationId: item.rootConversationId || parentConversationId,
        isChildThread: Boolean(parentConversationId),
    };
}

function applyDefaultMainThreadMode(candidates: ConversationListCandidate[]): ConversationListCandidate[] {
    const main = candidates.filter(item => !item.parentConversationId);
    const byId = new Map(main.map(item => [item.id, item]));
    for (const child of candidates.filter(item => item.parentConversationId)) {
        const parent = candidates.find(item => item.id === child.parentConversationId);
        if (!parent || byId.has(parent.id)) continue;
        const promoted: ConversationListCandidate = {
            ...parent,
            matchedChildConversationId: child.id,
            matchedChildTitle: child.title || child.agentNickname || child.id,
            detail: [
                parent.detail,
                `matchedChildConversationId=${child.id}`,
                child.title ? `matchedChildTitle=${child.title.slice(0, 80)}` : "",
            ].filter(Boolean).join(" / "),
        };
        main.push(promoted);
        byId.set(parent.id, promoted);
    }
    return main;
}

function candidateFromClaudeCodeThread(item: ClaudeCodeThreadInfo): ConversationListCandidate {
    const isChildThread = Boolean(item.isChildThread || item.parentConversationId);
    const parentConversationId = item.parentConversationId || null;
    return {
        id: item.id,
        title: item.title || "",
        workspace: item.cwd || "",
        updatedAt: item.updatedAtMs ? new Date(item.updatedAtMs).toISOString() : "",
        detail: [
            "claude-code",
            isChildThread ? "childThread" : "",
            parentConversationId ? `parentConversationId=${parentConversationId}` : "",
            item.agentRole ? `agent=${item.agentRole}` : "",
            item.agentNickname ? `agentNickname=${item.agentNickname}` : "",
            item.model,
            item.entrypoint,
            item.lastPrompt ? `lastPrompt=${item.lastPrompt.slice(0, 40)}` : "",
        ].filter(Boolean).join(" / "),
        agentRole: item.agentRole || null,
        agentNickname: item.agentNickname || null,
        parentConversationId,
        isChildThread,
        searchAliases: item.titleAliases,
    };
}

function candidateFromWindsurfThread(item: WindsurfConversationSummary): ConversationListCandidate {
    const isChildThread = Boolean(item.isChildThread || item.parentConversationId);
    const parentConversationId = item.parentConversationId || null;
    return {
        id: item.id,
        title: item.titleBestEffort || item.title || item.summary || "",
        workspace: item.cwd || "",
        workspaces: item.workspaceUris,
        updatedAt: item.lastModifiedTime || item.createdTime || "",
        detail: [
            "windsurf",
            item.titleSource === "renamedTitle" ? "title=renamedTitle" : "",
            item.titleBestEffort ? "title=titleBestEffort" : "",
            isChildThread ? "childThread" : "",
            parentConversationId ? `parentConversationId=${parentConversationId}` : "",
            item.agentRole ? `agent=${item.agentRole}` : "",
            item.agentNickname ? `agentNickname=${item.agentNickname}` : "",
            item.workspaceUris?.length ? `workspaces=${item.workspaceUris.length}` : "",
            item.referencedFiles?.length ? `referencedFiles=${item.referencedFiles.length}` : "",
            item.status,
            item.stepCount ? `${item.stepCount} steps` : "",
            item.lastGeneratorModelUid,
        ].filter(Boolean).join(" / "),
        agentRole: item.agentRole || null,
        agentNickname: item.agentNickname || null,
        parentConversationId,
        isChildThread,
    };
}

function formatWindsurfPartialWarning(loaded: Awaited<ReturnType<typeof loadConversationData>>): string {
    const skipped = loaded?.windsurfData?.skippedSteps || [];
    if (!loaded?.windsurfData?.partial || skipped.length === 0) return "";
    const shown = skipped.slice(0, 5).map(item => `offset ${item.offset}`).join(", ");
    const more = skipped.length > 5 ? ` 等 ${skipped.length} 个` : "";
    return [
        `⚠️ WSF 读取已降级：跳过超大 step ${shown}${more}`,
        "这些 step 超过 Windsurf LS 单步 4MB 限制，正文中会显示占位轮次；本次 fetch 不会自动触发 Record 更新，避免把不完整原文写成正式 Record。",
    ].join("\n");
}

type ConversationReadSegmentTiming = {
    label: "附件物化" | "格式化" | "临时文件";
    ms: number;
};

type ConversationReadTimingState = {
    action: "fetch" | "search" | "read";
    segments: ConversationReadSegmentTiming[];
};

function readPositiveEnvMs(name: string, fallback: number): number {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function isWindsurfReadTimingDebugEnabled(): boolean {
    return process.env.MEMORY_STORE_WINDSURF_READ_TIMING_DEBUG === "1";
}

function getWindsurfReadTimingSlowMs(): number {
    return readPositiveEnvMs("MEMORY_STORE_WINDSURF_READ_TIMING_SLOW_MS", 250);
}

function getReadAttachmentBudgetMs(): number {
    return readPositiveEnvMs("MEMORY_STORE_READ_ATTACHMENT_BUDGET_MS", 30_000);
}

function getReadFormatBudgetMs(): number {
    return readPositiveEnvMs("MEMORY_STORE_READ_FORMAT_BUDGET_MS", 60_000);
}

function createConversationReadTimingState(action: "fetch" | "search" | "read"): ConversationReadTimingState {
    return { action, segments: [] };
}

async function measureConversationReadSegment<T>(
    timing: ConversationReadTimingState,
    label: ConversationReadSegmentTiming["label"],
    work: () => Promise<T>,
): Promise<T> {
    const startedAt = Date.now();
    const result = await work();
    timing.segments.push({ label, ms: Math.max(0, Date.now() - startedAt) });
    return result;
}

const CONVERSATION_FORMAT_YIELD_INTERVAL = 5;

function yieldConversationEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

async function yieldConversationFormatIfNeeded(processed: number): Promise<void> {
    if (processed > 0 && processed % CONVERSATION_FORMAT_YIELD_INTERVAL === 0) {
        await yieldConversationEventLoop();
    }
}

function formatSegmentDuration(ms: number): string {
    if (ms >= 10_000) return `${(ms / 1000).toFixed(0)}s`;
    if (ms >= 1_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${ms}ms`;
}

function formatConversationReadSegmentTiming(timing: ConversationReadTimingState): string {
    if (timing.segments.length === 0) return "";
    const shouldShow = isWindsurfReadTimingDebugEnabled()
        || timing.segments.some(item => item.ms >= getWindsurfReadTimingSlowMs());
    if (!shouldShow) return "";
    return `⏱ ${timing.action} 分段: ${timing.segments.map(item => `${item.label} ${formatSegmentDuration(item.ms)}`).join(" | ")}`;
}

function appendConversationReadDetail(text: string, detail?: string): string {
    if (!detail) return text;
    return `${text}\n${detail}`;
}

async function materializeRoundAttachmentsWithOptionalBudget(
    rounds: ConversationRound[],
    conversationId: string,
    options: Parameters<typeof materializeRoundAttachments>[2] & { deadlineAt?: number } = {},
): Promise<Required<Pick<Awaited<ReturnType<typeof materializeRoundAttachments>>, "rounds" | "truncated">> & { budgetExceeded: boolean }> {
    const result = await materializeRoundAttachments(rounds, conversationId, options);
    return {
        rounds: result.rounds,
        truncated: result.truncated,
        budgetExceeded: Boolean(result.budgetExceeded),
    };
}

function formatRoundForMessageRolesWithOptionalBudget(
    round: ConversationRound,
    depth: Depth,
    extraTypes: ExtraType[],
    roles: Set<ConversationMessageRole>,
    compactionMode: CompactionMode,
    budgetOptions: { deadlineAt?: number } = {},
): { text: string; budgetExceeded: boolean } {
    const result = formatRoundForMessageRoles(round, depth, extraTypes, roles, compactionMode, budgetOptions);
    return {
        text: result.text,
        budgetExceeded: result.budgetExceeded,
    };
}

function formatWindsurfSourceDiagnostics(loaded: NonNullable<Awaited<ReturnType<typeof loadConversationData>>>): string {
    if (loaded.chainUsed !== "windsurf" || !loaded.windsurfData) return "";
    const lines: string[] = [];
    const warnings = loaded.windsurfData.warnings || [];
    if (warnings.length > 0) {
        lines.push(...warnings.map(warning => `⚠️ WSF 源: ${warning}`));
    }
    const cache = loaded.windsurfData.metadata?.cache;
    if (cache) {
        const details = [
            `status=${cache.status}`,
            `refresh=${cache.refreshRequested}`,
            Number.isFinite(cache.ageMs) ? `ageMs=${cache.ageMs}` : "",
            cache.reason ? `reason=${cache.reason}` : "",
        ].filter(Boolean);
        lines.push(`🧠 WSF 缓存: ${details.join(" | ")}`);
    }
    const timings = loaded.windsurfData.metadata?.timings;
    if (timings) {
        const details = [
            Number.isFinite(timings.resolveEndpointMs) ? `endpoint ${formatSegmentDuration(timings.resolveEndpointMs || 0)}` : "",
            Number.isFinite(timings.stepsReadMs) ? `steps ${formatSegmentDuration(timings.stepsReadMs || 0)}` : "",
            Number.isFinite(timings.enrichMs) ? `enrich ${formatSegmentDuration(timings.enrichMs || 0)}` : "",
            Number.isFinite(timings.roundConversionMs) ? `rounds ${formatSegmentDuration(timings.roundConversionMs || 0)}` : "",
            `total ${formatSegmentDuration(timings.totalMs)}`,
        ].filter(Boolean);
        lines.push(`⏱ WSF 源分段: ${details.join(" | ")}`);
    }
    const concurrency = loaded.windsurfData.metadata?.lsConcurrency;
    if (concurrency) {
        lines.push(`🚦 WSF LS: calls=${concurrency.calls} | activePeak=${concurrency.active} | pendingPeak=${concurrency.pending} | queueWaitMs=${concurrency.queueWaitMs} | maxQueueWaitMs=${concurrency.maxQueueWaitMs} | current=${concurrency.current} | max=${concurrency.max} | min=${concurrency.min} | limit=${concurrency.limit} | reserved=${concurrency.effectiveReserved}/${concurrency.configuredReserved} | active(fg/bg)=${concurrency.activeForeground}/${concurrency.activeBackground} | pending(fg/bg)=${concurrency.pendingForeground}/${concurrency.pendingBackground} | borrowing=${concurrency.borrowing}`);
    }
    return lines.join("\n");
}

function formatWindsurfIncompleteReadWarning(loaded: NonNullable<Awaited<ReturnType<typeof loadConversationData>>>): string {
    if (loaded.chainUsed !== "windsurf" || loaded.rounds.length > 0) return "";
    const partial = loaded.windsurfData?.partial === true;
    const totalSteps = loaded.totalSteps || 0;
    const stepCount = loaded.windsurfData?.thread?.stepCount || 0;
    if (!partial && totalSteps <= 0 && stepCount <= 0) return "";
    const stateBits = ["rounds=0"];
    if (partial) stateBits.push("partial=true");
    if (totalSteps > 0) stateBits.push(`totalSteps=${totalSteps}`);
    if (stepCount > 0) stateBits.push(`stepCount=${stepCount}`);
    return [
        `⚠️ Windsurf 源读取暂不完整：当前没有拿到可读轮次（${stateBits.join("，")}）`,
        "💡 先调用 fetch 强制 refresh；若仍为空，请稍后重试或回到对应 Windsurf 窗口再试。",
    ].join("\n");
}

export function applyCodexContextProbeMatchesToCandidates(
    candidates: ConversationListCandidate[],
    matches: ReturnType<typeof findCodexContextProbeMatches>,
): ConversationListCandidate[] {
    const byId = new Map(candidates.map(item => [item.id, item]));
    for (const match of matches) {
        if (!byId.has(match.thread.id)) {
            const candidate = candidateFromCodexThread(match.thread);
            candidates.push(candidate);
            byId.set(candidate.id, candidate);
        }
        const firstHit = match.hits[0];
        const direct = byId.get(match.thread.id);
        if (direct) {
            const relation = match.parentThread
                ? `命中子线程 ${match.thread.id.slice(0, 8)} (${match.thread.agentNickname || match.thread.title || "subagent"})`
                : `命中本线程`;
            const directTag = match.parentThread
                ? "[child-hit]"
                : (firstHit?.role?.startsWith("tool_") ? "[tool-hit]" : "[direct-hit]");
            direct.contextProbe = [
                ...(direct.contextProbe || []),
                `${directTag} ${relation} R${firstHit?.roundIndex || "?"}/${firstHit?.role || "?"}: ${firstHit?.snippet || ""}`,
            ];
        }
        if (match.parentThread) {
            if (!byId.has(match.parentThread.id)) {
                const candidate = candidateFromCodexThread(match.parentThread);
                candidates.push(candidate);
                byId.set(candidate.id, candidate);
            }
            const parent = byId.get(match.parentThread.id);
            if (parent) {
                parent.contextProbe = [
                    ...(parent.contextProbe || []),
                    `[parent-of-hit] 其子线程 ${match.thread.id.slice(0, 8)} 命中；此项可能是主线母线程`,
                ];
            }
        }
        if (match.rootThread && match.rootThread.id !== match.parentThread?.id) {
            if (!byId.has(match.rootThread.id)) {
                const candidate = candidateFromCodexThread(match.rootThread);
                candidates.push(candidate);
                byId.set(candidate.id, candidate);
            }
            const root = byId.get(match.rootThread.id);
            if (root) {
                root.contextProbe = [
                    ...(root.contextProbe || []),
                    `[root-of-hit] 后代线程 ${match.thread.id.slice(0, 8)} 命中；此项可能是主线根线程`,
                ];
            }
        }
    }

    return candidates;
}

function annotateCodexContextProbeCandidates(
    candidates: ConversationListCandidate[],
    threads: CodexThreadInfo[],
    probe: string | undefined,
): { candidates: ConversationListCandidate[]; matchMode: string; hitCount: number } {
    if (!probe?.trim()) return { candidates, matchMode: "", hitCount: 0 };
    const matches = findCodexContextProbeMatches(threads, probe);
    if (matches.length === 0) return { candidates, matchMode: "context-probe-miss", hitCount: 0 };

    return {
        candidates: applyCodexContextProbeMatchesToCandidates(candidates, matches),
        matchMode: "context-probe",
        hitCount: matches.length,
    };
}

function annotateClaudeCodeContextProbeCandidates(
    candidates: ConversationListCandidate[],
    threads: ClaudeCodeThreadInfo[],
    probe: string | undefined,
): { candidates: ConversationListCandidate[]; matchMode: string; hitCount: number } {
    if (!probe?.trim()) return { candidates, matchMode: "", hitCount: 0 };
    const matches = findClaudeCodeContextProbeMatches(threads, probe);
    if (matches.length === 0) return { candidates, matchMode: "context-probe-miss", hitCount: 0 };
    const byId = new Map(candidates.map(item => [item.id, item]));
    for (const match of matches) {
        if (!byId.has(match.thread.id)) {
            const candidate = candidateFromClaudeCodeThread(match.thread);
            candidates.push(candidate);
            byId.set(candidate.id, candidate);
        }
        const target = byId.get(match.thread.id);
        const firstHit = match.hits[0];
        if (target) {
            target.contextProbe = [
                ...(target.contextProbe || []),
                `[direct-hit] 命中 Claude Code 线程 R${firstHit?.roundIndex || "?"}/${firstHit?.role || "?"}: ${firstHit?.snippet || ""}`,
            ];
        }
    }
    return { candidates, matchMode: "context-probe", hitCount: matches.length };
}

function contextProbePriority(item: ConversationListCandidate): number {
    const notes = item.contextProbe || [];
    if (notes.some(note => note.includes("[direct-hit]"))) return 0;
    if (notes.some(note => note.includes("[root-of-hit]"))) return 1;
    if (notes.some(note => note.includes("[parent-of-hit]"))) return 2;
    if (notes.some(note => note.includes("[child-hit]"))) return 3;
    if (notes.some(note => note.includes("[tool-hit]"))) return 4;
    if (notes.length > 0) return 5;
    return 9;
}

export function sortContextProbeFirst(items: ConversationListCandidate[]): ConversationListCandidate[] {
    return [...items].sort((a, b) => {
        const priority = contextProbePriority(a) - contextProbePriority(b);
        if (priority !== 0) return priority;
        return (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0);
    });
}

function listCandidateHaystack(item: ConversationListCandidate): string {
    return normalizeListQuery([
        item.id,
        item.title,
        item.workspace,
        ...(item.workspaces || []),
        ...(item.searchAliases || []),
        item.agentRole || "",
        item.agentNickname || "",
    ].join("\n"));
}

function listQueryTermsMatch(haystack: string, queryTerms: string[]): boolean {
    return queryTerms.length > 1 && queryTerms.some(term => haystack.includes(term));
}

export function listCandidateMatchesQuery(item: ConversationListCandidate, normalizedQuery: string, queryTerms: string[] = []): boolean {
    if (!normalizedQuery) return true;
    const haystack = listCandidateHaystack(item);
    return haystack.includes(normalizedQuery) || listQueryTermsMatch(haystack, queryTerms);
}

function listFieldIncludesAny(field: string, queryTerms: string[]): boolean {
    return queryTerms.length > 1 && queryTerms.some(term => field.includes(term));
}

function listQueryPriority(item: ConversationListCandidate, normalizedQuery: string, queryTerms: string[] = []): number {
    if (!normalizedQuery) return 9;
    const id = normalizeListQuery(item.id);
    const title = normalizeListQuery(item.title || "");
    const workspace = normalizeListQuery(item.workspace || "");
    const workspaces = normalizeListQuery((item.workspaces || []).join("\n"));
    const aliases = normalizeListQuery((item.searchAliases || []).join("\n"));
    const agent = normalizeListQuery([item.agentRole || "", item.agentNickname || ""].join("\n"));
    const haystack = [id, title, aliases, workspace, workspaces, agent].join("\n");
    if (id === normalizedQuery) return 0;
    if (normalizedQuery.length >= 8 && id.startsWith(normalizedQuery)) return 1;
    if (title === normalizedQuery) return 2;
    if (title.includes(normalizedQuery)) return 3;
    if (aliases === normalizedQuery) return 4;
    if (aliases.includes(normalizedQuery)) return 5;
    if (workspace.includes(normalizedQuery)) return 6;
    if (listFieldIncludesAny(title, queryTerms) || listFieldIncludesAny(aliases, queryTerms)) return 7;
    if (listFieldIncludesAny(workspace, queryTerms) || listFieldIncludesAny(workspaces, queryTerms)) return 8;
    if (listFieldIncludesAny(agent, queryTerms)) return 9;
    if (listQueryTermsMatch(haystack, queryTerms)) return 10;
    return 11;
}

export function sortListMatchesByQuery(items: ConversationListCandidate[], normalizedQuery: string, queryTerms: string[] = []): ConversationListCandidate[] {
    return [...items].sort((a, b) => {
        const priority = listQueryPriority(a, normalizedQuery, queryTerms) - listQueryPriority(b, normalizedQuery, queryTerms);
        if (priority !== 0) return priority;
        return (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0);
    });
}

export interface ConversationListFallbackPlan {
    includeRawPreview: boolean;
    allowSmartSearch: boolean;
    returnContextProbeHitsFirst: boolean;
    deepSearchSuggested: boolean;
    skipped: string[];
}

export function getConversationListFallbackPlan(
    resolved: DataChain,
    requestedMode: SearchMode,
    contextProbeHitCount: number,
): ConversationListFallbackPlan {
    if (resolved === "antigravity") {
        return {
            includeRawPreview: requestedMode === "smart",
            allowSmartSearch: requestedMode === "auto" || requestedMode === "smart",
            returnContextProbeHitsFirst: false,
            deepSearchSuggested: false,
            skipped: [],
        };
    }

    if (resolved === "windsurf") {
        return {
            includeRawPreview: false,
            allowSmartSearch: requestedMode === "smart",
            returnContextProbeHitsFirst: false,
            deepSearchSuggested: false,
            skipped: [
                "raw-trajectory-preview",
                requestedMode === "auto" ? "smart-auto" : "",
                "deep-locate-unsupported",
            ].filter(Boolean),
        };
    }

    return {
        includeRawPreview: false,
        allowSmartSearch: requestedMode === "smart",
        returnContextProbeHitsFirst: contextProbeHitCount > 0,
        deepSearchSuggested: true,
        skipped: [
            "raw-jsonl-preview",
            requestedMode === "auto" ? "smart-auto" : "",
        ].filter(Boolean),
    };
}

function contextProbeMatchedCandidates(candidates: ConversationListCandidate[]): ConversationListCandidate[] {
    return sortContextProbeFirst(candidates.filter(item => item.contextProbe?.length));
}

function buildListQueryTokens(query: string): string[] {
    const rawTokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 0);
    const cjk = /[\u4e00-\u9fff\u3400-\u4dbf\uF900-\uFAFF]/;
    const tokens = new Set<string>();
    for (const token of rawTokens) {
        tokens.add(token);
        if (token.length > 2 && cjk.test(token)) {
            for (let i = 0; i < token.length - 1; i++) {
                tokens.add(token.slice(i, i + 2));
            }
        }
    }
    return [...tokens].slice(0, 32);
}

function buildRoundsPreview(rounds: ConversationRound[], maxChars: number, query = ""): string {
    const tokens = buildListQueryTokens(query);
    const scored = tokens.length === 0
        ? []
        : rounds.map(round => {
            const text = `${round.userMessage}\n${round.aiResponses.map(a => a.response).join("\n")}`.toLowerCase();
            const score = tokens.reduce((sum, token) => sum + (text.includes(token) ? 1 : 0), 0);
            return { round, score };
        }).filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || a.round.roundIndex - b.round.roundIndex)
            .slice(0, 8)
            .sort((a, b) => a.round.roundIndex - b.round.roundIndex)
            .map(item => item.round);

    const selected = scored.length > 0
        ? scored
        : (rounds.length <= 8 ? rounds : [...rounds.slice(0, 3), ...rounds.slice(-5)]);
    const parts: string[] = [];
    for (const round of selected) {
        parts.push(`轮次 ${round.roundIndex}`);
        if (round.userMessage) parts.push(`用户: ${round.userMessage.slice(0, 500)}`);
        const aiText = round.aiResponses.map(a => a.response).join("\n").slice(0, 800);
        if (aiText) parts.push(`回复: ${aiText}`);
        if (parts.join("\n").length >= maxChars) break;
    }
    return parts.join("\n").slice(0, maxChars);
}

function contentHasQuerySignal(content: string, query: string): boolean {
    const tokens = buildListQueryTokens(query);
    if (tokens.length === 0) return true;
    const lower = content.toLowerCase();
    return tokens.some(token => lower.includes(token));
}

async function buildListSearchBlocks(
    resolved: DataChain,
    candidates: ConversationListCandidate[],
    includeRawPreview: boolean,
    query = "",
): Promise<TextBlock[]> {
    const rawScanLimit = Math.min(
        Math.max(Number(process.env.MEMORY_STORE_CONVERSATION_LIST_RAW_SCAN_LIMIT || 8), 0),
        candidates.length,
    );
    const blocks: TextBlock[] = [];

    for (let i = 0; i < candidates.length; i++) {
        const item = candidates[i];
        const hash = await findRecordHashAsync(item.id);
        const recordPreview = hash ? ((await readRecordAsync(hash, item.id)) || "").slice(0, 2500) : "";
        let rawPreview = "";

        if (includeRawPreview && i < rawScanLimit && (recordPreview.length === 0 || !contentHasQuerySignal(recordPreview, query))) {
            try {
                const loaded = await loadConversationData(resolved, item.id, { link: "summary" });
                if (loaded?.rounds?.length) {
                    rawPreview = buildRoundsPreview(loaded.rounds, 3000, query);
                }
            } catch (error) {
                rawPreview = `原文预览读取失败: ${error instanceof Error ? error.message : String(error)}`;
            }
        }

        blocks.push({
            id: item.id,
            title: item.title || item.id,
            content: [
                `ID: ${item.id}`,
                `标题: ${item.title}`,
                item.searchAliases?.length ? `标题别名: ${item.searchAliases.join(" | ")}` : "",
                `工作区: ${item.workspace}`,
                `详情: ${item.detail}`,
                recordPreview ? `Record:\n${recordPreview}` : "",
                rawPreview ? `原文预览:\n${rawPreview}` : "",
            ].filter(Boolean).join("\n"),
            metadata: { candidate: item },
        });
    }

    return blocks;
}

async function buildConversationText(
    conversationId: string,
    rounds: ConversationRound[],
    totalSteps: number,
    depth: Depth,
    extraTypes: ExtraType[] = [],
    expandedChildren: Array<{ thread: { id: string; title: string }; rounds: ConversationRound[] }> = [],
    childDiagnostics: Array<{ threadId: string; nickname?: string; reason: string; detail: string }> = [],
    compactionMode: CompactionMode = "folded",
): Promise<string> {
    const lines: string[] = [];
    let usedChars = 0;
    let truncated = false;
    const pushLine = (line: string): boolean => {
        if (truncated) return false;
        const nextChars = usedChars + line.length + 1;
        if (nextChars > CONVERSATION_FETCH_TEXT_MAX_CHARS) {
            truncated = true;
            lines.push(`\n⚠️ conversation_read_original(fetch) 临时文件已按 ${CONVERSATION_FETCH_TEXT_MAX_CHARS} 字预算截断；请用 read(startRound,endRound) 分段读取完整原文。`);
            return false;
        }
        lines.push(line);
        usedChars = nextChars;
        return true;
    };

    pushLine(`# 对话原文: ${conversationId}`);
    pushLine(`> 步骤: ${totalSteps} | 轮次: ${rounds.length}`);
    pushLine("");

    for (let index = 0; index < rounds.length; index++) {
        const round = rounds[index];
        if (!pushLine(formatRound(round, depth, extraTypes, { compactionMode }))) break;
        if (!pushLine("")) break;
        await yieldConversationFormatIfNeeded(index + 1);
    }

    if (!truncated && expandedChildren.length > 0) {
        pushLine("# 子代理线程展开");
        pushLine("");
        for (const child of expandedChildren) {
            if (!pushLine(`## 子线程 ${child.thread.id.slice(0, 8)}... ${child.thread.title ? `| ${child.thread.title}` : ""}`)) break;
            if (!pushLine("")) break;
            for (let index = 0; index < child.rounds.length; index++) {
                const round = child.rounds[index];
                if (!pushLine(formatRound(round, depth, extraTypes, { compactionMode }))) break;
                if (!pushLine("")) break;
                await yieldConversationFormatIfNeeded(index + 1);
            }
            if (truncated) break;
        }
    }

    if (!truncated && childDiagnostics.length > 0) {
        pushLine("# 子代理线程诊断");
        pushLine("");
        for (const item of childDiagnostics) {
            const label = item.nickname ? `${item.nickname} (${item.threadId.slice(0, 8)}...)` : item.threadId;
            if (!pushLine(`- ${label}: ${item.reason} — ${item.detail}`)) break;
        }
    }

    return lines.join("\n");
}

function pushOutputWithBuildBudget(output: string[], text: string, state: { chars: number; truncated: boolean }, note: string): boolean {
    if (state.truncated) return false;
    const nextChars = state.chars + text.length + 1;
    if (nextChars > CONVERSATION_READ_TEXT_BUILD_MAX_CHARS) {
        state.truncated = true;
        output.push(`\n⚠️ ${note} 已按 ${CONVERSATION_READ_TEXT_BUILD_MAX_CHARS} 字构建预算提前截断；请缩小轮次范围或使用 depth=brief。`);
        return false;
    }
    output.push(text);
    state.chars = nextChars;
    return true;
}

function buildSearchBlockContent(round: ConversationRound): string {
    const content = [
        round.userMessage,
        ...round.aiResponses.map(item => item.response),
    ].filter(Boolean).join("\n");
    if (content.length <= CONVERSATION_SEARCH_BLOCK_MAX_CHARS) return content;
    return `${content.slice(0, CONVERSATION_SEARCH_BLOCK_MAX_CHARS)}\n\n[... 搜索索引临时块过长，已截断 ${content.length - CONVERSATION_SEARCH_BLOCK_MAX_CHARS} 字 ...]`;
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "0B";
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

export function formatDeepLocateResult(result: CodexDeepLocateResult | ClaudeCodeDeepLocateResult, query: string): string {
    const lines: string[] = [
        `🔎 deep_locate 完成`,
        `📌 状态: ${result.status}`,
        `🔤 query: ${query}`,
        `📈 扫描: ${result.scannedFiles}/${result.totalFiles} 文件，${formatBytes(result.scannedBytes)} / ${formatBytes(result.totalBytes)}`,
        `🎯 命中: ${result.hits.length}${result.truncated ? "（partial/truncated）" : ""}`,
    ];
    if (result.reason) lines.push(`⚠️ 原因: ${result.reason}`);
    if (result.hits.length > 0) {
        lines.push("");
        for (const [idx, hit] of result.hits.slice(0, 20).entries()) {
            lines.push(`${idx + 1}. ${hit.title || hit.conversationId}`);
            lines.push(`   ID: ${hit.conversationId}`);
            lines.push(`   来源: ${hit.source} / ${hit.mode} / R${hit.roundIndex} / ${hit.role}`);
            lines.push(`   文件: ${hit.filePath}`);
            lines.push(`   offset: ${hit.byteOffset}`);
            lines.push(`   片段: ${hit.snippet}`);
        }
    }
    if (result.status === "budget_exhausted" || result.status === "partial_found_scanning") {
        lines.push("");
        lines.push("💡 结果受预算限制，后续可扩大 maxFiles/maxBytes/maxHits 或使用更窄 scope 重试。");
    }
    return lines.join("\n");
}

function selectBalancedBatchCandidates<T extends { dataChain: string }>(candidates: T[], max: number, balanced: boolean): T[] {
    if (!balanced) return candidates.slice(0, max);
    const groups = new Map<string, T[]>();
    for (const candidate of candidates) {
        if (!groups.has(candidate.dataChain)) groups.set(candidate.dataChain, []);
        groups.get(candidate.dataChain)?.push(candidate);
    }
    const selected: T[] = [];
    const keys = [...groups.keys()];
    while (selected.length < max && keys.length > 0) {
        let progressed = false;
        for (const key of keys) {
            const item = groups.get(key)?.shift();
            if (item) {
                selected.push(item);
                progressed = true;
                if (selected.length >= max) break;
            }
        }
        if (!progressed) break;
    }
    return selected;
}

interface DeepLocateResumePayload {
    version: 1;
    query: string;
    dataChain: "codex" | "claude-code";
    mode: "exact" | "fuzzy";
    conversationIds?: string[];
    maxFiles: number;
    maxBytes: number;
    maxHits: number;
}

function buildDeepLocateResumePayload(args: {
    query: string;
    dataChain: "codex" | "claude-code";
    mode: "exact" | "fuzzy";
    conversationIds?: string[];
    maxFiles: number;
    maxBytes: number;
    maxHits: number;
}): DeepLocateResumePayload {
    return {
        version: 1,
        query: args.query,
        dataChain: args.dataChain,
        mode: args.mode,
        conversationIds: args.conversationIds?.length ? [...args.conversationIds] : undefined,
        maxFiles: args.maxFiles,
        maxBytes: args.maxBytes,
        maxHits: args.maxHits,
    };
}

function isConversationBatchExportResumePayload(value: unknown): value is ConversationBatchExportResumePayload {
    if (!value || typeof value !== "object") return false;
    const batchDir = (value as { batchDir?: unknown }).batchDir;
    const options = (value as { options?: unknown }).options;
    return typeof batchDir === "string"
        && Boolean(options)
        && typeof options === "object"
        && Array.isArray((options as { candidates?: unknown }).candidates);
}

registerBackgroundTaskRecoveryHandler("conversation-batch-export", async (task) => {
    if (!isConversationBatchExportResumePayload(task.resumePayload)) {
        throw new Error("conversation-batch-export 缺少可恢复的 batchDir/options payload");
    }
    const payload = task.resumePayload;
    return {
        mode: "restart",
        run: async ({ isCancelled, isSettled }) => {
            const result = await resumeConversationBatchExport(payload, {
                exportConversation: async (exportOptions) => {
                    if (isCancelled() || isSettled()) {
                        throw new Error(isCancelled()
                            ? "conversation batch export cancelled before item export"
                            : "conversation batch export settled before item export");
                    }
                    return exportConversation({
                        ...exportOptions,
                        isCancelled,
                        isSettled,
                    });
                },
            });
            return formatConversationBatchExportResult(result);
        },
    };
});

/**
 * conversation_read_original — 读取对话原文
 *
 * 五类操作：
 *   list   — 按标题/路径/ID/Record/contextProbe 列出候选对话
 *   fetch  — 拉取对话数据到缓存并返回概览
 *   search — 在对话中关键词搜索
 *   read   — 读取指定轮次范围的对话内容
 *   export — 将可读对话原文持久化导出为 Markdown / PDF
 *   deep_locate — 后台流式深搜 Codex / Claude Code JSONL，用正文片段定位 conversationId
 */
export function registerConversation(server: McpServer): void {
    server.tool(
        "conversation_read_original",
        `读取对话的原始完整内容（绕过上下文压缩机制）。
操作模式:
  list — 按标题/路径/ID/Record/contextProbe 列出候选对话
  fetch — 拉取对话数据到缓存，返回概览统计
  search — 在对话中关键词搜索，返回匹配的上下文
  read — 读取指定轮次范围的对话内容
  export — 将可读对话原文持久化导出为 Markdown / PDF
  deep_locate — Codex/Claude Code 后台深搜正文片段以定位 conversationId
fetch/search/read/export 必须传 conversationId（共享 broker 后端拦截所有无 ID 调用，含 antigravity——跨 session 共享后端无法安全推断「当前对话」）。先用 action="list" 定位 ID。`,
        {
            action: z.enum(["list", "fetch", "search", "read", "export", "deep_locate", "deep_locate_status", "deep_locate_cancel"]).default("search")
                .describe("操作模式：list=列出候选 / fetch=拉取缓存 / search=关键词搜索 / read=范围阅读 / export=导出 Markdown/PDF / deep_locate=后台深搜定位对话"),
            conversationId: z.string().optional()
                .describe("对话 UUID；fetch/search/read/export 建议总是显式传入，避免共享后端串到其它当前对话"),
            conversationIds: z.array(z.string()).optional()
                .describe("[deep_locate] 可选：限制只扫描这些 Codex conversationId"),
            query: z.string().optional()
                .describe("[list/search] 搜索关键词"),
            contextProbe: z.string().optional()
                .describe("[list] Codex/Claude Code：从当前可见对话截取的 50-120 字上下文指纹，用 fixed-string 语义的硬匹配标记候选；不会自动选中"),
            depth: z.enum(["brief", "normal", "full"]).default("normal")
                .describe("[fetch/search/read] 返回详细度：brief=截断100字 / normal=完整文本 / full=含思考+工具结果"),
            compactionMode: z.enum(["folded", "full", "omit"]).optional()
                .describe("[read] Claude Code 压缩续聊摘要读取方式：folded=默认折叠为临时文件 / full=展开但标记 / omit=仅保留省略标记；未传时 depth=full 自动 full，其余 folded"),
            mode: z.enum(["auto", "exact", "fuzzy", "smart"]).optional()
                .describe("[list/search] 匹配模式：auto/exact/fuzzy/smart，默认 auto"),
            contextRounds: z.number().default(2).optional()
                .describe("[search] 匹配位置前后显示多少轮对话"),
            limit: z.number().default(8).optional()
                .describe("[list/search] 最多返回多少个匹配"),
            background: z.boolean().optional()
                .describe("[deep_locate/exportBatch] 三态后台：true=强制后台 / false=同步兜底（deep_locate 不支持）/ 不传时自动后台返回 taskId"),
            taskId: z.string().optional()
                .describe("[deep_locate_status/deep_locate_cancel] 后台任务 ID"),
            waitSeconds: z.number().optional()
                .describe("[deep_locate_status] 等待秒数，建议 30-45"),
            maxFiles: z.number().optional()
                .describe("[deep_locate] 最大扫描文件数"),
            maxBytes: z.number().optional()
                .describe("[deep_locate] 最大扫描字节数"),
            maxHits: z.number().optional()
                .describe("[deep_locate] 最大命中数"),
            startRound: z.number().optional()
                .describe("[read] 起始轮次（1-indexed）"),
            endRound: z.number().optional()
                .describe("[read] 结束轮次"),
            exportFormat: z.enum(["markdown", "pdf", "both"]).optional()
                .describe("[export] 导出格式，markdown=只导出 Markdown，pdf=Markdown+PDF 且以 PDF 为目标，both=两者都生成"),
            exportScope: z.enum(["full", "rounds", "search"]).optional()
                .describe("[export] full=整篇对话，rounds=按 startRound/endRound，search=按 query 命中窗口"),
            outputDir: z.string().optional()
                .describe("[export] 自定义导出目录；不存在时自动创建。未传则写入 memory-store/exports/conversations/..."),
            overwrite: z.boolean().optional()
                .describe("[export] true=允许覆盖 outputDir 下本工具生成的同名文件；默认创建时间戳子目录"),
            includeAssets: z.boolean().optional()
                .describe("[export] 是否复制图片/文件到 assets 并重写链接，默认 true"),
            pdfEmbedAttachments: z.enum(["off", "auto", "force"]).optional()
                .describe("[export] PDF 原生附件嵌入策略；auto=可用时尝试，off=只生成链接/清单，force=失败时报 warning/失败状态"),
            extraTypes: z.array(z.enum(["thinking", "tool_results", "code_actions", "code_diffs", "file_views"])).optional()
                .describe("[fetch/search/read] 额外拉取的内容类型"),
            messageRoles: z.array(z.enum(["user", "system", "model", "assistant", "tool"])).optional()
                .describe("[read/export] 按消息角色选择性读取或导出。user=用户输入，system=规则/压缩/系统注入类内容，model/assistant=模型回复，tool=工具/代码/任务事件"),
            chain: z.enum(CHAIN_COMPAT_INPUT_VALUES).default(DEFAULT_CHAIN)
                .describe("兼容旧参数：dataChain/modelChain 未填时沿用此链路；chain=\"windsurf\" 只作为 dataChain，chain=\"grok\" 只作为 modelChain"),
            dataChain: z.enum(DATA_CHAIN_INPUT_VALUES).optional()
                .describe("读取对话数据的宿主链路；未填用 chain。支持 antigravity/codex/claude-code/windsurf"),
            dataChains: z.array(z.enum(DATA_CHAIN_INPUT_VALUES)).optional()
                .describe("[list/export] 批量模式：并行查询多个数据源；例如 [\"codex\",\"windsurf\"]。未传时保持旧单 dataChain 行为"),
            workspaces: z.array(z.string()).optional()
                .describe("[list/export] 批量模式：按工作区路径过滤，可传一个或多个目录"),
            workspaceMode: z.enum(["contains", "exact", "under", "any", "all"]).optional()
                .describe("工作区过滤：contains=父子目录任意包含，exact=精确路径，under=候选在指定目录下，any/all=多工作区聚合；默认 contains"),
            workspaceScope: z.enum(["any", "primary"]).optional()
                .describe("工作区过滤范围：any=主工作区或关联工作区任意命中，primary=只匹配主工作区；默认 any，保持旧行为"),
            exportBatch: z.boolean().optional()
                .describe("[export] true=按 dataChains/workspaces/query 过滤后批量导出多条对话，每条对话独立目录"),
            batchLimit: z.number().optional()
                .describe("[export] exportBatch 时最多导出多少条候选，默认沿用 limit"),
            batchConcurrency: z.number().optional()
                .describe("[export] exportBatch 时并发导出数，默认 2，最多 4"),
            sourceFailureMode: z.enum(["warn", "fail"]).optional()
                .describe("多源查询/导出：warn=单源失败只警告并继续，fail=任一源失败即整体失败；默认 warn"),
            idResolutionMode: z.enum(["unique", "priority"]).optional()
                .describe("dataChain=auto 且传 conversationId 时：unique=并行全源唯一匹配，priority=保留旧优先级顺序；默认 unique"),
            threadMode: z.enum(["main", "children", "all"]).optional()
                .describe("[list/export] Codex 线程过滤：main=默认只返回主线程，children=只列某个父线程的子线程，all=主线程和子线程都返回"),
            parentConversationId: z.string().optional()
                .describe("[list/export] threadMode=children 时指定父线程 conversationId"),
            parentQuery: z.string().optional()
                .describe("[list/export] threadMode=children 时用标题/ID/工作区唯一定位父线程；不唯一会返回诊断"),
            parentDataChain: z.enum(DATA_CHAIN_INPUT_VALUES).optional()
                .describe("预留：父线程定位的数据源；当前主要用于 Codex 子线程过滤"),
            modelChain: modelChainInputSchema("modelChain", "smart 搜索调用模型的链路；未填用 chain；grok=本机 progrok proxy。Windsurf 只支持 dataChain"),
            link: z.enum(["reference", "summary", "expand_children"]).default(DEFAULT_LINK_MODE)
                .describe("Codex 链路下对子代理线程的呈现方式"),
            logicalChain: z.enum(["off", "explain", "auto", "strict"]).optional()
                .describe("Claude Code 链路：off=默认只读指定物理 ID；explain=只展示可能续聊候选；auto/strict=强证据时合并为逻辑对话"),
        },
        async (params) => {
            touchActivity();
            const startTime = Date.now();

            try {
                const {
                    action,
                    conversationId,
                    query,
                    contextProbe,
                    depth = "normal",
                    compactionMode,
                    mode = "auto",
                    contextRounds = 2,
                    limit = 8,
                    startRound,
                    endRound,
                    exportFormat,
                    exportScope,
                    outputDir,
                    overwrite,
                    includeAssets,
                    pdfEmbedAttachments,
                    extraTypes = [],
                    messageRoles,
                    background,
                    taskId,
                    waitSeconds,
                    maxFiles,
                    maxBytes,
                    maxHits,
                    conversationIds,
                    chain = DEFAULT_CHAIN,
                    dataChain,
                    dataChains,
                    workspaces,
                    workspaceMode = "contains",
                    workspaceScope = "any",
                    exportBatch,
                    batchLimit,
                    batchConcurrency,
                    sourceFailureMode = "warn",
                    idResolutionMode = "unique",
                    threadMode,
                    parentConversationId,
                    parentQuery,
                    parentDataChain,
                    modelChain,
                    link = DEFAULT_LINK_MODE,
                    logicalChain,
                } = params;
                const chains = resolveChainSplit({ chain, dataChain, modelChain });
                const effectiveCompactionMode: CompactionMode = compactionMode || (depth === "full" ? "full" : "folded");
                const isBatchConversationExport = action === "export" && !conversationId?.trim() && Boolean(exportBatch || dataChains?.length || workspaces?.length);

                if (!isBatchConversationExport && shouldRequireExplicitConversationId(action, chains.dataChain, conversationId)) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: formatMissingConversationIdMessage(action, chains.dataChain) }],
                    }, startTime);
                }

                if (action === "deep_locate_status") {
                    const task = await waitForBackgroundTask(taskId || "", waitSeconds || 0);
                    return appendTiming({
                        content: [{ type: "text" as const, text: formatBackgroundTask(task) }],
                    }, startTime);
                }

                if (action === "deep_locate_cancel") {
                    const task = cancelBackgroundTask(taskId || "", "deep_locate_cancel");
                    return appendTiming({
                        content: [{ type: "text" as const, text: formatBackgroundTask(task) }],
                    }, startTime);
                }

                if (action === "deep_locate") {
                    const resolved = await resolveConversationChain(chains.dataChain);
                    if (resolved !== "codex" && resolved !== "claude-code") {
                        return appendTiming({
                            content: [{ type: "text" as const, text: `❌ deep_locate 支持 dataChain=\"codex\" 或 \"claude-code\"；当前为 ${resolved || chains.dataChain}` }],
                        }, startTime);
                    }
                    if (!query?.trim()) {
                        return appendTiming({
                            content: [{ type: "text" as const, text: "❌ deep_locate 需要 query 正文片段" }],
                        }, startTime);
                    }
                    if (background === false) {
                        return appendTiming({
                            content: [{ type: "text" as const, text: "❌ deep_locate 不支持 background=false；这是可能扫描大 JSONL 的后台重任务，请省略 background 或设为 true。" }],
                        }, startTime);
                    }
                    const requestedMode = (mode === "fuzzy" ? "fuzzy" : "exact") as "exact" | "fuzzy";
                    const deepLocatePayload = buildDeepLocateResumePayload({
                        query,
                        dataChain: resolved,
                        mode: requestedMode,
                        conversationIds: conversationIds?.length ? [...conversationIds] : undefined,
                        maxFiles: maxFiles || 20,
                        maxBytes: maxBytes || 512 * 1024 * 1024,
                        maxHits: maxHits || limit || 20,
                    });
                    const task = startBackgroundTask("conversation-deep-locate", async ({ updateProgress, isCancelled }) => {
                        const threads = resolved === "codex"
                            ? (conversationIds?.length
                                ? conversationIds.map(id => getCodexThread(id)).filter((item): item is CodexThreadInfo => Boolean(item))
                                : listRecentCodexThreads(Math.max(maxFiles || 20, 1)))
                            : (conversationIds?.length
                                ? conversationIds.map(id => getClaudeCodeThread(id)).filter((item): item is ClaudeCodeThreadInfo => Boolean(item))
                                : listRecentClaudeCodeThreads(Math.max(maxFiles || 20, 1)));
                        const result: CodexDeepLocateResult | ClaudeCodeDeepLocateResult = resolved === "codex"
                            ? deepLocateCodexConversations(query, threads as CodexThreadInfo[], {
                                mode: requestedMode,
                                maxFiles: maxFiles || 20,
                                maxBytes: maxBytes || 512 * 1024 * 1024,
                                maxHits: maxHits || limit || 20,
                                deadlineMs: Number(process.env.MEMORY_STORE_DEEP_LOCATE_DEFAULT_MAX_MS || 5 * 60 * 1000),
                                isCancelled,
                                onProgress: progress => updateProgress({
                                    stage: progress.stage,
                                    detail: progress.detail ? `${progress.detail}；已扫 ${formatBytes(progress.scannedBytes || 0)}；命中 ${progress.hits || 0}` : undefined,
                                    current: progress.current,
                                    total: progress.total,
                                    unit: "文件",
                                }),
                            })
                            : deepLocateClaudeCodeConversations(query, threads as ClaudeCodeThreadInfo[], {
                            mode: requestedMode,
                            maxFiles: maxFiles || 20,
                            maxBytes: maxBytes || 512 * 1024 * 1024,
                            maxHits: maxHits || limit || 20,
                            deadlineMs: Number(process.env.MEMORY_STORE_DEEP_LOCATE_DEFAULT_MAX_MS || 5 * 60 * 1000),
                            isCancelled,
                            onProgress: progress => updateProgress({
                                stage: progress.stage,
                                detail: progress.detail ? `${progress.detail}；已扫 ${formatBytes(progress.scannedBytes || 0)}；命中 ${progress.hits || 0}` : undefined,
                                current: progress.current,
                                total: progress.total,
                                unit: "文件",
                            }),
                        });
                        return formatDeepLocateResult(result, query);
                    }, {
                        maxRunMs: Number(process.env.MEMORY_STORE_DEEP_LOCATE_BACKGROUND_MAX_RUN_MS || 10 * 60 * 1000),
                        timeoutMessage: "deep_locate 后台扫描超时；可缩小 conversationIds/maxFiles/maxBytes 后重试",
                        resumePayload: deepLocatePayload as unknown as ResumePayloadValue,
                    });
                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: [
                                background === true ? "🚀 deep_locate 已转入后台任务" : "🚀 deep_locate 未显式指定 background，已自动转入后台任务",
                                `🆔 taskId: ${task.id}`,
                                `🔗 dataChain: ${resolved}`,
                                `🔎 mode: ${requestedMode}`,
                                `📁 maxFiles: ${maxFiles || 20}`,
                                `💾 maxBytes: ${formatBytes(maxBytes || 512 * 1024 * 1024)}`,
                                `🎯 maxHits: ${maxHits || limit || 20}`,
                                "💡 后续调用 conversation_read_original(action=\"deep_locate_status\", taskId=\"...\") 查询进度",
                            ].join("\n"),
                        }],
                    }, startTime);
                }

                if (action === "list") {
                    if (dataChains?.length || workspaces?.length || threadMode || parentConversationId || parentQuery) {
                        const result = await listConversationCandidates({
                            dataChains: dataChains?.length ? dataChains : [chains.dataChain],
                            query,
                            workspaces,
                            workspaceMode,
                            workspaceScope: workspaceScope as WorkspaceMatchScope,
                            threadMode: threadMode as ConversationThreadMode | undefined,
                            parentConversationId,
                            parentQuery,
                            parentDataChain,
                            limit,
                            sourceFailureMode: sourceFailureMode as SourceFailureMode,
                        });
                        const failedSources = result.statuses.filter(item => item.status === "failed");
                        if (sourceFailureMode === "fail" && failedSources.length > 0) {
                            return appendTiming({
                                content: [{
                                    type: "text" as const,
                                    text: [
                                        "❌ 多源候选查询严格失败",
                                        "sourceFailureMode=fail 要求任一数据源失败时停止使用候选结果；已保留诊断如下。",
                                        "",
                                        "🔗 数据源状态:",
                                        ...formatSourceStatuses(result.statuses),
                                    ].join("\n"),
                                }],
                            }, startTime);
                        }
                        const lines = [
                            "🔎 多源候选查询",
                            `候选对话: ${result.candidates.length}${query ? ` | 关键词: ${query}` : ""}`,
                            workspaces?.length ? `工作区过滤: ${workspaces.join(" | ")} (${workspaceMode}, ${workspaceScope})` : "",
                            threadMode ? `线程模式: ${threadMode}${parentConversationId ? ` | parent=${parentConversationId}` : ""}${parentQuery ? ` | parentQuery=${parentQuery}` : ""}` : "",
                            "",
                            "🔗 数据源状态:",
                            ...formatSourceStatuses(result.statuses),
                            "",
                            ...result.candidates.map((item, idx) => {
                                const title = formatConversationListDisplayTitleForTest(item.title, {
                                    dataChain: item.dataChain,
                                    agentRole: item.agentRole,
                                    agentNickname: item.agentNickname,
                                });
                                const workspaceLine = formatWorkspaceLines(item.workspace, item.workspaces);
                                const detail = item.detail ? ` | ${item.detail}` : "";
                                return `${idx + 1}. [${item.dataChain}] ${title}\n   ID: ${item.id}\n   更新时间: ${item.updatedAt || "(未知)"}${detail}${workspaceLine}`;
                            }),
                        ].filter(Boolean);
                        return appendTiming({
                            content: [{ type: "text" as const, text: lines.join("\n") }],
                        }, startTime);
                    }

                    const resolved = await resolveConversationChain(chains.dataChain);
                    if (!resolved) {
                        return appendTiming({
                            content: [{ type: "text" as const, text: `❌ 无法通过 dataChain=${chains.dataChain} 列出对话` }],
                        }, startTime);
                    }

                    const normalizedQuery = normalizeListQuery(query || "");
                    const max = Math.min(Math.max(limit || 20, 1), 100);
                    const candidateLimit = normalizedQuery
                        ? Math.max(max * 3, Number(process.env.MEMORY_STORE_CONVERSATION_LIST_CANDIDATE_LIMIT || 300))
                        : Math.max(max * 3, 30);
                    const claudeCodeCandidateLimit = normalizedQuery
                        ? Math.max(
                            candidateLimit,
                            Number(process.env.MEMORY_STORE_CLAUDE_CODE_METADATA_THREAD_LIMIT || process.env.MEMORY_STORE_CONVERSATION_METADATA_THREAD_LIMIT || 20_000),
                        )
                        : candidateLimit;
                    let codexThreads: CodexThreadInfo[] = [];
                    let claudeCodeThreads: ClaudeCodeThreadInfo[] = [];
                    let windsurfThreads: WindsurfConversationSummary[] = [];
                    let candidates: ConversationListCandidate[] = resolved === "antigravity"
                        ? listConversationsByMtime({ limit: candidateLimit }).map(item => ({
                            id: item.id,
                            title: item.title || "",
                            workspace: "",
                            updatedAt: item.mtime.toISOString(),
                            detail: `${item.sizeKB.toFixed(1)} KB`,
                        }))
                        : resolved === "codex"
                            ? (codexThreads = normalizedQuery
                                ? listCodexThreadsForMetadata(Number(process.env.MEMORY_STORE_CODEX_METADATA_THREAD_LIMIT || 20_000))
                                : listRecentCodexThreads(candidateLimit)).map(candidateFromCodexThread)
                            : resolved === "claude-code"
                                ? (claudeCodeThreads = listRecentClaudeCodeThreads(claudeCodeCandidateLimit)).map(candidateFromClaudeCodeThread)
                                : (windsurfThreads = await listRecentWindsurfThreads(candidateLimit)).map(candidateFromWindsurfThread);
                    if (resolved === "codex" && normalizedQuery) {
                        const exactThread = getCodexThread(query || "");
                        if (exactThread && !codexThreads.some(item => item.id === exactThread.id)) {
                            codexThreads = [exactThread, ...codexThreads];
                            candidates = [candidateFromCodexThread(exactThread), ...candidates];
                        }
                    }
                    if (resolved === "claude-code" && normalizedQuery) {
                        const exactThread = getClaudeCodeThread(query || "");
                        if (exactThread && !claudeCodeThreads.some(item => item.id === exactThread.id)) {
                            claudeCodeThreads = [exactThread, ...claudeCodeThreads];
                            candidates = [candidateFromClaudeCodeThread(exactThread), ...candidates];
                        }
                    }
                    if (resolved === "windsurf" && normalizedQuery) {
                        const exactThread = windsurfThreads.find(item =>
                            item.id.toLowerCase() === (query || "").toLowerCase() ||
                            item.cascadeId.toLowerCase() === (query || "").toLowerCase()
                        );
                        if (exactThread && !candidates.some(item => item.id === exactThread.id)) {
                            candidates = [candidateFromWindsurfThread(exactThread), ...candidates];
                        }
                    }

                    const probeResult = resolved === "codex"
                        ? annotateCodexContextProbeCandidates(candidates, codexThreads, contextProbe)
                        : resolved === "claude-code"
                            ? annotateClaudeCodeContextProbeCandidates(candidates, claudeCodeThreads, contextProbe)
                        : { candidates, matchMode: "", hitCount: 0 };

                    const queryTerms = splitListQueryTerms(query || "");
                    const directMatches = normalizedQuery
                        ? probeResult.candidates.filter(item => listCandidateMatchesQuery(item, normalizedQuery, queryTerms))
                        : probeResult.candidates;

                    let filtered = normalizedQuery ? sortListMatchesByQuery(directMatches, normalizedQuery, queryTerms) : directMatches;
                    if ((resolved === "codex" || resolved === "claude-code" || resolved === "windsurf") && !threadMode) {
                        filtered = applyDefaultMainThreadMode(filtered);
                    }
                    let matchMode = normalizedQuery ? (queryTerms.length > 1 ? "metadata-or" : "exact") : "";
                    const listNotes: string[] = [];
                    if (probeResult.matchMode) {
                        filtered = probeResult.hitCount > 0
                            ? sortContextProbeFirst(filtered)
                            : filtered;
                        matchMode = [matchMode, probeResult.matchMode].filter(Boolean).join("+");
                    }

                    if (normalizedQuery && filtered.length === 0) {
                        const requestedMode = mode as SearchMode;
                        const fallbackPlan = getConversationListFallbackPlan(resolved, requestedMode, probeResult.hitCount);
                        if (fallbackPlan.returnContextProbeHitsFirst) {
                            filtered = contextProbeMatchedCandidates(probeResult.candidates);
                            matchMode = "context-probe+query-miss-fast";
                            listNotes.push("⚠️ query 未命中标题/ID/工作区；已返回 contextProbe 命中候选，未执行原文全文扫描。");
                            if (fallbackPlan.deepSearchSuggested) {
                                listNotes.push("💡 若需要搜索古老正文或尾部窗口未覆盖内容，请使用后续 deep_locate 后台深搜能力。");
                            }
                        }
                    }

                    if (normalizedQuery && filtered.length === 0) {
                        const { search: engineSearch } = await import("../search-engine.js");
                        const requestedMode = mode as SearchMode;
                        const fallbackPlan = getConversationListFallbackPlan(resolved, requestedMode, probeResult.hitCount);
                        const initialBlocks = await buildListSearchBlocks(
                            resolved,
                            probeResult.candidates,
                            fallbackPlan.includeRawPreview,
                            query || "",
                        );

                        const contentExactResults = (requestedMode === "auto" || requestedMode === "exact")
                            ? await engineSearch(initialBlocks, query || "", {
                                mode: "exact",
                                limit: max,
                                dataChain: resolved,
                                modelChain: chains.modelChain,
                            })
                            : [];

                        let results = contentExactResults;
                        matchMode = contentExactResults.length > 0 ? "exact-content" : matchMode;

                        const fuzzyResults = results.length > 0 || requestedMode === "exact" || requestedMode === "smart"
                            ? []
                            : await engineSearch(initialBlocks, query || "", {
                                mode: requestedMode === "auto" ? "fuzzy" : requestedMode,
                                limit: max,
                                dataChain: resolved,
                                modelChain: chains.modelChain,
                            });

                        if (fuzzyResults.length > 0) {
                            results = fuzzyResults;
                            matchMode = "fuzzy";
                        }

                        if (results.length === 0 && resolved === "antigravity" && (requestedMode === "auto" || requestedMode === "smart")) {
                            const smartBlocks = requestedMode === "smart"
                                ? initialBlocks
                                : await buildListSearchBlocks(resolved, probeResult.candidates, true, query || "");
                            if (requestedMode === "auto") {
                                results = await engineSearch(smartBlocks, query || "", {
                                    mode: "exact",
                                    limit: max,
                                    dataChain: resolved,
                                    modelChain: chains.modelChain,
                                });
                                matchMode = results.length > 0 ? "exact-raw-preview" : matchMode;
                            }
                        }

                        if (results.length === 0 && fallbackPlan.allowSmartSearch) {
                            const smartBlocks = requestedMode === "smart"
                                ? initialBlocks
                                : await buildListSearchBlocks(resolved, candidates, true, query || "");
                            results = await engineSearch(smartBlocks, query || "", {
                                mode: "smart",
                                limit: max,
                                dataChain: resolved,
                                modelChain: chains.modelChain,
                            });
                            matchMode = results.length > 0 ? (resolved === "codex" ? "smart-lightweight" : "smart") : matchMode;
                        }

                        if (results.length > 0) {
                            filtered = results
                                .map(r => r.metadata?.candidate as ConversationListCandidate | undefined)
                                .filter((item): item is ConversationListCandidate => Boolean(item));
                            if (probeResult.hitCount > 0) {
                                const seen = new Set(filtered.map(item => item.id));
                                const probeMatches = probeResult.candidates.filter(item => item.contextProbe?.length && !seen.has(item.id));
                                filtered = sortContextProbeFirst([...probeMatches, ...filtered]);
                                matchMode = [matchMode, "context-probe"].filter(Boolean).join("+");
                            }
                        } else if ((resolved === "codex" || resolved === "claude-code" || resolved === "windsurf") && fallbackPlan.deepSearchSuggested) {
                            const skipped = fallbackPlan.skipped.length ? `；已跳过 ${fallbackPlan.skipped.join(", ")}` : "";
                            listNotes.push(`⚠️ 快速定位未命中${skipped}；未执行 ${resolved} 原文全文扫描。`);
                            listNotes.push("💡 若 query 是正文片段，需使用后续 deep_locate 后台深搜；若已知对话，请传完整 conversationId。");
                        }
                    }

                    const shown = filtered.slice(0, max);
                    if (shown.length === 0) {
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: [
                                    `🔎 链路: ${resolved}`,
                                    `未找到匹配候选：${query || "(无关键词)"}`,
                                    normalizedQuery
                                        ? `已尝试: ${resolved === "codex" ? "metadata/record exact-fuzzy fast-list" : (mode === "exact" ? "exact" : "exact/fuzzy/smart")}`
                                        : "",
                                    ...listNotes,
                                ].filter(Boolean).join("\n"),
                            }],
                        }, startTime);
                    }

                    const lines = buildConversationListLines(
                        resolved,
                        shown,
                        filtered.length,
                        normalizedQuery ? query : undefined,
                        matchMode,
                        listNotes,
                    );

                    return appendTiming({
                        content: [{ type: "text" as const, text: lines.join("\n") }],
                    }, startTime);
                }

                if (action === "export" && isBatchConversationExport) {
                    const balancedBatch = Boolean(dataChains && dataChains.length > 1);
                    const runBatchExport = async (
                        updateProgress?: (progress: BackgroundTaskProgress) => void,
                        taskContext?: Pick<BackgroundTaskContext, "isCancelled" | "isSettled">,
                    ): Promise<string> => {
                        const requestedBatchLimit = batchLimit || limit;
                        const batchSources = dataChains?.length ? dataChains : [chains.dataChain];
                        updateProgress?.({
                            stage: "list_candidates",
                            detail: `查询批量导出候选 (${batchSources.join(", ")})`,
                            current: 0,
                            total: requestedBatchLimit,
                            unit: "条",
                        });
                        const listResult = balancedBatch
                            ? {
                                candidates: [],
                                statuses: [],
                            } as Awaited<ReturnType<typeof listConversationCandidates>>
                            : await listConversationCandidates({
                                dataChains: batchSources,
                                query,
                                workspaces,
                                workspaceMode,
                                workspaceScope: workspaceScope as WorkspaceMatchScope,
                                threadMode: threadMode as ConversationThreadMode | undefined,
                                parentConversationId,
                                parentQuery,
                                parentDataChain,
                                limit: requestedBatchLimit,
                                sourceFailureMode: sourceFailureMode as SourceFailureMode,
                            });
                        if (balancedBatch) {
                            const perSourceResults = await Promise.all(batchSources.map(source => listConversationCandidates({
                                dataChains: [source],
                                query,
                                workspaces,
                                workspaceMode,
                                workspaceScope: workspaceScope as WorkspaceMatchScope,
                                threadMode: threadMode as ConversationThreadMode | undefined,
                                parentConversationId,
                                parentQuery,
                                parentDataChain,
                                limit: requestedBatchLimit,
                                sourceFailureMode: sourceFailureMode as SourceFailureMode,
                            })));
                            listResult.candidates = perSourceResults.flatMap(result => result.candidates);
                            listResult.statuses = perSourceResults.flatMap(result => result.statuses);
                        }
                        const buildFrozenBatchExport = (): { message: string } | {
                            options: Parameters<typeof exportConversationBatch>[0];
                            selectedCount: number;
                        } => {
                            const failedSources = listResult.statuses.filter(item => item.status === "failed");
                            if (sourceFailureMode === "fail" && failedSources.length > 0) {
                                return {
                                    message: [
                                        "❌ 批量导出严格失败",
                                        "sourceFailureMode=fail 要求任一数据源失败时不继续导出；已保留诊断如下。",
                                        "",
                                        "🔗 数据源状态:",
                                        ...formatSourceStatuses(listResult.statuses),
                                    ].join("\n"),
                                };
                            }
                            if (listResult.candidates.length === 0) {
                                return {
                                    message: [
                                        "❌ 批量导出未找到候选对话",
                                        query ? `关键词: ${query}` : "",
                                        workspaces?.length ? `工作区: ${workspaces.join(" | ")}` : "",
                                        workspaces?.length ? `工作区范围: ${workspaceScope}` : "",
                                        "",
                                        "🔗 数据源状态:",
                                        ...formatSourceStatuses(listResult.statuses),
                                    ].filter(Boolean).join("\n"),
                                };
                            }
                            const selected = selectBalancedBatchCandidates(listResult.candidates, requestedBatchLimit, balancedBatch);
                            return {
                                options: {
                                    candidates: selected,
                                    batchLimit: requestedBatchLimit,
                                    batchConcurrency,
                                    sourceStatuses: listResult.statuses,
                                    link,
                                    scope: exportScope || (query ? "search" : (startRound || endRound ? "rounds" : "full")),
                                    query,
                                    workspaces,
                                    workspaceMode,
                                    workspaceScope: workspaceScope as WorkspaceMatchScope,
                                    startRound,
                                    endRound,
                                    contextRounds,
                                    limit,
                                    mode: mode as SearchMode,
                                    depth: depth as Depth,
                                    extraTypes: extraTypes as ExtraType[],
                                    messageRoles: messageRoles as ConversationMessageRole[] | undefined,
                                    compactionMode: effectiveCompactionMode,
                                    outputDir,
                                    overwrite,
                                    format: exportFormat || "markdown",
                                    includeAssets,
                                    pdfEmbedAttachments: pdfEmbedAttachments || "auto",
                                },
                                selectedCount: selected.length,
                            };
                        };

                        const runFrozenBatchExport = async (
                            frozenOptions: Parameters<typeof exportConversationBatch>[0],
                            selectedCount: number,
                            taskProgress?: (progress: BackgroundTaskProgress) => void,
                            runTaskContext?: Pick<BackgroundTaskContext, "isCancelled" | "isSettled">,
                        ) => {
                            taskProgress?.({
                                stage: "export_batch",
                                detail: `开始导出 ${selectedCount} 条对话`,
                                current: 0,
                                total: selectedCount,
                                unit: "条",
                            });
                            if (isBackgroundTaskAborted(runTaskContext)) {
                                return runTaskContext?.isCancelled()
                                    ? "🛑 批量导出后台任务已取消，已停止后续文件导出"
                                    : "🛑 批量导出后台任务已结束，已停止后续文件导出";
                            }
                            const result = await exportConversationBatch(frozenOptions, {
                                exportConversation: async (exportOptions) => {
                                    if (isBackgroundTaskAborted(runTaskContext)) {
                                        throw new Error(runTaskContext?.isCancelled()
                                            ? "conversation batch export cancelled before item export"
                                            : "conversation batch export settled before item export");
                                    }
                                    return exportConversation({
                                        ...exportOptions,
                                        isCancelled: runTaskContext?.isCancelled,
                                        isSettled: runTaskContext?.isSettled,
                                    });
                                },
                            });
                            taskProgress?.({
                                stage: "export_batch",
                                detail: "批量导出已完成",
                                current: selectedCount,
                                total: selectedCount,
                                unit: "条",
                            });
                            return formatConversationBatchExportResult(result);
                        };

                        const frozen = buildFrozenBatchExport();
                        if (!("options" in frozen)) return frozen.message || "❌ 批量导出准备失败";
                        return runFrozenBatchExport(frozen.options, frozen.selectedCount, updateProgress, taskContext);
                    };

                    if (background === false) {
                        const text = await runBatchExport();
                        return appendTiming({
                            content: [{ type: "text" as const, text }],
                        }, startTime);
                    }

                    const listResult = await (async () => {
                        const batchSources = dataChains?.length ? dataChains : [chains.dataChain];
                        const requestedBatchLimit = Math.max(1, Math.min(batchLimit || limit || 10, 50));
                        let result = await listConversationCandidates({
                            dataChains: batchSources,
                            query,
                            workspaces,
                            workspaceMode,
                            workspaceScope: workspaceScope as WorkspaceMatchScope,
                            threadMode: threadMode as ConversationThreadMode | undefined,
                            parentConversationId,
                            parentQuery,
                            parentDataChain,
                            limit: requestedBatchLimit,
                            sourceFailureMode: sourceFailureMode as SourceFailureMode,
                        });
                        if (balancedBatch) {
                            const perSourceResults = await Promise.all(batchSources.map(source => listConversationCandidates({
                                dataChains: [source],
                                query,
                                workspaces,
                                workspaceMode,
                                workspaceScope: workspaceScope as WorkspaceMatchScope,
                                threadMode: threadMode as ConversationThreadMode | undefined,
                                parentConversationId,
                                parentQuery,
                                parentDataChain,
                                limit: requestedBatchLimit,
                                sourceFailureMode: sourceFailureMode as SourceFailureMode,
                            })));
                            result.candidates = perSourceResults.flatMap(item => item.candidates);
                            result.statuses = perSourceResults.flatMap(item => item.statuses);
                        }
                        return { result, requestedBatchLimit };
                    })();
                    const failedSources = listResult.result.statuses.filter(item => item.status === "failed");
                    if (sourceFailureMode === "fail" && failedSources.length > 0) {
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: [
                                    "❌ 批量导出严格失败",
                                    "sourceFailureMode=fail 要求任一数据源失败时不继续导出；已保留诊断如下。",
                                    "",
                                    "🔗 数据源状态:",
                                    ...formatSourceStatuses(listResult.result.statuses),
                                ].join("\n"),
                            }],
                        }, startTime);
                    }
                    if (listResult.result.candidates.length === 0) {
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: [
                                    "❌ 批量导出未找到候选对话",
                                    query ? `关键词: ${query}` : "",
                                    workspaces?.length ? `工作区: ${workspaces.join(" | ")}` : "",
                                    workspaces?.length ? `工作区范围: ${workspaceScope}` : "",
                                    "",
                                    "🔗 数据源状态:",
                                    ...formatSourceStatuses(listResult.result.statuses),
                                ].filter(Boolean).join("\n"),
                            }],
                        }, startTime);
                    }
                    const selected = selectBalancedBatchCandidates(listResult.result.candidates, listResult.requestedBatchLimit, balancedBatch);
                    const frozenBatchOptions: Parameters<typeof exportConversationBatch>[0] = {
                        candidates: selected,
                        batchLimit: listResult.requestedBatchLimit,
                        batchConcurrency,
                        sourceStatuses: listResult.result.statuses,
                        link,
                        scope: exportScope || (query ? "search" : (startRound || endRound ? "rounds" : "full")),
                        query,
                        workspaces,
                        workspaceMode,
                        workspaceScope: workspaceScope as WorkspaceMatchScope,
                        startRound,
                        endRound,
                        contextRounds,
                        limit,
                        mode: mode as SearchMode,
                        depth: depth as Depth,
                        extraTypes: extraTypes as ExtraType[],
                        messageRoles: messageRoles as ConversationMessageRole[] | undefined,
                        compactionMode: effectiveCompactionMode,
                        outputDir,
                        overwrite,
                        format: exportFormat || "markdown",
                        includeAssets,
                        pdfEmbedAttachments: pdfEmbedAttachments || "auto",
                    };
                    const resumePayload = createConversationBatchExportResumePayload(frozenBatchOptions);
                    const task = startBackgroundTask("conversation-batch-export", async (taskContext) => {
                        const result = await resumeConversationBatchExport(resumePayload, {
                            exportConversation: async (exportOptions) => {
                                if (isBackgroundTaskAborted(taskContext)) {
                                    throw new Error(taskContext?.isCancelled()
                                        ? "conversation batch export cancelled before item export"
                                        : "conversation batch export settled before item export");
                                }
                                return exportConversation({
                                    ...exportOptions,
                                    isCancelled: taskContext?.isCancelled,
                                    isSettled: taskContext?.isSettled,
                                });
                            },
                        });
                        taskContext.updateProgress({
                            stage: "export_batch",
                            detail: "批量导出已完成",
                            current: selected.length,
                            total: selected.length,
                            unit: "条",
                        });
                        return formatConversationBatchExportResult(result);
                    }, {
                        timeoutMessage: "conversation batch export 后台导出超时；可缩小 batchLimit/筛选范围后重试",
                        resumePayload: resumePayload as unknown as ResumePayloadValue,
                    });
                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: [
                                "🚀 批量导出已转入后台任务",
                                `🆔 taskId: ${task.id}`,
                                `🔗 dataChains: ${(dataChains?.length ? dataChains : [chains.dataChain]).join(", ")}`,
                                `📦 batchLimit: ${listResult.requestedBatchLimit}`,
                                "💡 后续调用 conversation_read_original(action=\"deep_locate_status\", taskId=\"...\") 查询进度",
                            ].join("\n"),
                        }],
                    }, startTime);
                }

                const loaded = await loadConversationData(chains.dataChain, conversationId, {
                    refresh: action === "fetch",
                    link,
                    dataChains: dataChains as DataChain[] | undefined,
                    idResolutionMode: idResolutionMode as IdResolutionMode,
                    sourceFailureMode: sourceFailureMode as SourceFailureMode,
                    logicalChain: logicalChain as ConversationLogicalChainMode | undefined,
                });
                if (!loaded) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: `❌ 无法通过 dataChain=${chains.dataChain} 获取对话数据` }],
                    }, startTime);
                }

                const cascadeId = loaded.conversationId;
                const rounds = loaded.rounds;
                const totalSteps = loaded.totalSteps;
                const windsurfSourceDiagnostics = formatWindsurfSourceDiagnostics(loaded);
                const expandedChildren = loaded.codexData?.expandedChildren || [];
                const childDiagnostics = loaded.codexData?.childDiagnostics || [];

                if (action === "export") {
                    const partialWarning = formatWindsurfPartialWarning(loaded);
                    const result = await exportConversation({
                        conversationId: cascadeId,
                        chainUsed: loaded.chainUsed,
                        rounds,
                        totalSteps,
                        expandedChildren,
                        childDiagnostics,
                        partialWarning,
                        scope: exportScope || (query ? "search" : (startRound || endRound ? "rounds" : "full")),
                        query,
                        startRound,
                        endRound,
                        contextRounds,
                        limit,
                        mode: mode as SearchMode,
                        depth: depth as Depth,
                        extraTypes: extraTypes as ExtraType[],
                        messageRoles: messageRoles as ConversationMessageRole[] | undefined,
                        compactionMode: effectiveCompactionMode,
                        outputDir,
                        overwrite,
                        format: exportFormat || "markdown",
                        includeAssets,
                        pdfEmbedAttachments: pdfEmbedAttachments || "auto",
                    });
                    return appendTiming({
                        content: [{ type: "text" as const, text: formatConversationExportResult(result) }],
                    }, startTime);
                }

                // === fetch 模式 ===
                if (action === "fetch") {
                    const fetchTiming = createConversationReadTimingState("fetch");
                    const attachmentOverview = formatAttachmentOverview(rounds);
                    const fetchTempText = await measureConversationReadSegment(
                        fetchTiming,
                        "格式化",
                        () => buildConversationText(cascadeId, rounds, totalSteps, "normal", [], expandedChildren, childDiagnostics, "omit"),
                    );
                    const tempPath = await measureConversationReadSegment(
                        fetchTiming,
                        "临时文件",
                        () => saveTempFileAsync(
                            "conv",
                            cascadeId.slice(0, 8),
                            fetchTempText,
                        ),
                    );
                    const overview = formatOverview(cascadeId, rounds, totalSteps);
                    const subagentNote = formatSubagentSourceNote(loaded);
                    const logicalChainNote = formatClaudeCodeLogicalChainNote(loaded);
                    const partialWarning = formatWindsurfPartialWarning(loaded);
                    const cacheNote = loaded.chainUsed === "antigravity"
                        ? (loaded.fromCache ? " (从缓存)" : " (新拉取)")
                        : loaded.chainUsed === "codex"
                            ? " (Codex 本地会话)"
                            : loaded.chainUsed === "claude-code"
                                ? " (Claude Code 本地会话)"
                                : " (Windsurf Cascade)";

                    // v1.8: 自动触发 Record 更新检查
                    let recordNote = "";
                    try {
                        if (loaded.windsurfData?.partial) {
                            recordNote = "\n📋 Record 自动更新已跳过：WSF 本次原文读取不完整";
                        } else if (isLoadedSubagentThread(loaded)) {
                            recordNote = "\n📋 Record 自动更新已跳过：子代理线程默认由源头主对话统一记录";
                        } else {
                        const recordHash = await findRecordHashAsync(cascadeId) || resolveWorkspaceHashForRecord();
                        if (await shouldAutoUpdateRecordAsync(recordHash, cascadeId, rounds.length)) {
                            // 异步更新，不阻塞返回
                            void (async () => {
                                const singleFlightPermit = await acquireRecordSingleFlightPermit(cascadeId);
                                try {
                                    if (!await shouldAutoUpdateRecordAsync(recordHash, cascadeId, rounds.length)) return;
                                    const res = await generateRecord(recordHash, cascadeId, "auto", rounds, totalSteps, chains.modelChain, {
                                        background: chains.modelChain === "codex",
                                    });
                                    if (!res.success || !res.content) return;
                                    const content = res.content;
                                    const oldRecord = await readRecordAsync(recordHash, cascadeId) || "";
                                    const gate = validateRecordCandidateForWrite(content, cascadeId, rounds.length, res.coveredRounds || rounds.length, {
                                        oldRecord,
                                    });
                                    if (!gate.ok) {
                                        console.error(`[record] 自动更新候选被拒绝: ${gate.error}`);
                                        return;
                                    }
                                    const phases = countPhasesInRecord(content);
                                    await withRecordPersistenceWrite(async () => {
                                        await writeRecord(recordHash, cascadeId, content, {
                                            totalRounds: rounds.length,
                                            totalSteps,
                                            lastUpdatedRound: res.coveredRounds || rounds.length,
                                            phases,
                                            tags: res.tags,
                                        });
                                        const readerIndex = await buildAndPersistRecordReaderIndex(recordHash, cascadeId, content);
                                        if (readerIndex.error) {
                                            console.error(`[record] reader index rebuild degraded: ${readerIndex.error instanceof Error ? readerIndex.error.message : String(readerIndex.error)}`);
                                        }
                                    });
                                    console.error(`[record] 自动更新完成: ${cascadeId.slice(0, 8)}... (${phases} Phase)`);
                                } finally {
                                    singleFlightPermit.release();
                                }
                            })().catch(err => console.error(`[record] 自动更新失败:`, err));
                            recordNote = "\n📋 Record 自动更新已触发（后台进行中）";
                        }
                        }
                    } catch { /* 忽略 Record 检查错误 */ }

                    const fetchText = appendConversationReadDetail(
                        `${overview}${cacheNote}${subagentNote ? `\n${subagentNote}` : ""}${logicalChainNote ? `\n${logicalChainNote}` : ""}\n🔗 数据链路: ${loaded.chainUsed}${partialWarning ? `\n${partialWarning}` : ""}${windsurfSourceDiagnostics ? `\n${windsurfSourceDiagnostics}` : ""}${attachmentOverview ? `\n${attachmentOverview}` : ""}\n📁 临时文件: ${tempPath}\n💡 使用 search(query="关键词") 搜索或 read(startRound=1, endRound=3) 阅读${recordNote}`,
                        formatConversationReadSegmentTiming(fetchTiming),
                    );
                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: fetchText,
                        }],
                    }, startTime);
                }

                // === search 模式 ===
                if (action === "search") {
                    const searchTiming = createConversationReadTimingState("search");
                    if (!query) {
                        return appendTiming({
                            content: [{ type: "text" as const, text: "❌ search 模式需要提供 query 参数" }],
                        }, startTime);
                    }

                    const matches = (mode === "auto" || mode === "exact")
                        ? searchInRounds(rounds, query, limit)
                        : [];
                    const searchHeader = formatConversationSearchHeader(cascadeId, loaded);
                    if (matches.length === 0 && mode === "exact") {
                        return appendTiming({
                                    content: [{ type: "text" as const, text: `${searchHeader}\n🔍 搜索 "${query}" — exact 模式未找到匹配` }],
                        }, startTime);
                    }
                    if (matches.length === 0) {
                        // fuzzy fallback：将每轮对话构建为 TextBlock，用三级搜索引擎
                        const { search: engineSearch } = await import("../search-engine.js");
                        const blocks = rounds.map(r => ({
                            id: String(r.roundIndex),
                            title: `轮次 ${r.roundIndex}`,
                            content: buildSearchBlockContent(r),
                            tags: [] as string[],
                        }));
                        const requestedMode = mode as "auto" | "exact" | "fuzzy" | "smart";
                        let fuzzyResults = requestedMode === "smart"
                            ? []
                            : await engineSearch(blocks, query, {
                                mode: requestedMode === "auto" ? "fuzzy" : requestedMode,
                                limit,
                                dataChain: loaded.chainUsed,
                                modelChain: chains.modelChain,
                            });
                        if (fuzzyResults.length === 0 && (requestedMode === "auto" || requestedMode === "smart")) {
                            const smartResults = await engineSearch(blocks, query, {
                                mode: "smart",
                                limit,
                                dataChain: loaded.chainUsed,
                                modelChain: chains.modelChain,
                            });
                            if (smartResults.length === 0) {
                                return appendTiming({
                                    content: [{ type: "text" as const, text: `${searchHeader}\n🔍 搜索 "${query}" — 未找到匹配` }],
                                }, startTime);
                            }
                            const smartRoundIndices = smartResults.map(r => Number(r.id));
                            const output: string[] = [`🔍 搜索 "${query}" — smart 模式命中 ${smartResults.length} 轮\n`];
                            const selectedRounds = smartRoundIndices
                                .map(ri => rounds[ri - 1])
                                .filter((round): round is ConversationRound => Boolean(round));
                            const { rounds: displayRounds, truncated } = await measureConversationReadSegment(
                                searchTiming,
                                "附件物化",
                                () => materializeRoundAttachmentsWithOptionalBudget(selectedRounds, cascadeId),
                            );
                            await measureConversationReadSegment(searchTiming, "格式化", async () => {
                                for (let index = 0; index < smartRoundIndices.length; index++) {
                                    const ri = smartRoundIndices[index];
                                    const round = displayRounds.find(item => item.roundIndex === ri);
                                    if (!round) continue;
                                    output.push(formatRound(round, depth as Depth, extraTypes as ExtraType[], { compactionMode: effectiveCompactionMode }));
                                    output.push("");
                                    await yieldConversationFormatIfNeeded(index + 1);
                                }
                            });
                            if (truncated > 0) output.push(`⚠️ ${truncated} 个附件超过单次生成上限，未生成临时文件\n`);
                            let text = output.join("\n");
                            if (text.length > 8000) text = text.slice(0, 8000) + "\n\n⚠️ 结果过长已截断";
                            text = appendConversationReadDetail(text, formatConversationReadSegmentTiming(searchTiming));
                            return appendTiming({
                                content: [{ type: "text" as const, text: `${formatConversationSearchHeader(cascadeId, loaded, chains.modelChain)}\n\n${text}` }],
                            }, startTime);
                        }
                        // 将 fuzzy 结果转换回轮次索引
                        const fuzzyRoundIndices = fuzzyResults.map(r => Number(r.id));
                        const output: string[] = [`🔍 搜索 "${query}" — fuzzy 模式命中 ${fuzzyResults.length} 轮\n`];
                        const selectedRounds = fuzzyRoundIndices
                            .map(ri => rounds[ri - 1])
                            .filter((round): round is ConversationRound => Boolean(round));
                        const { rounds: displayRounds, truncated } = await measureConversationReadSegment(
                            searchTiming,
                            "附件物化",
                            () => materializeRoundAttachmentsWithOptionalBudget(selectedRounds, cascadeId),
                        );
                        await measureConversationReadSegment(searchTiming, "格式化", async () => {
                            for (let index = 0; index < fuzzyRoundIndices.length; index++) {
                                const ri = fuzzyRoundIndices[index];
                                const round = displayRounds.find(item => item.roundIndex === ri);
                                if (!round) continue;
                                output.push(formatRound(round, depth as Depth, extraTypes as ExtraType[], { compactionMode: effectiveCompactionMode }));
                                output.push("");
                                await yieldConversationFormatIfNeeded(index + 1);
                            }
                        });
                        if (truncated > 0) output.push(`⚠️ ${truncated} 个附件超过单次生成上限，未生成临时文件\n`);
                        let text = output.join("\n");
                        if (text.length > 8000) text = text.slice(0, 8000) + "\n\n⚠️ 结果过长已截断";
                        text = appendConversationReadDetail(text, formatConversationReadSegmentTiming(searchTiming));
                        return appendTiming({
                            content: [{ type: "text" as const, text: `${searchHeader}\n\n${text}` }],
                        }, startTime);
                    }

                    const output: string[] = [];
                    output.push(`🔍 搜索 "${query}" — 命中 ${matches.length} 处\n`);

                    // 收集需要展示的轮次（去重 + 上下文）
                    const roundsToShow = new Set<number>();
                    for (const m of matches) {
                        const ctx = contextRounds ?? 1;
                        for (let r = Math.max(1, m.roundIndex - ctx); r <= Math.min(rounds.length, m.roundIndex + ctx); r++) {
                            roundsToShow.add(r);
                        }
                    }

                    const sortedRounds = [...roundsToShow].sort((a, b) => a - b);
                    const selectedRounds = sortedRounds
                        .map(ri => rounds[ri - 1])
                        .filter((round): round is ConversationRound => Boolean(round));
                    const { rounds: displayRounds, truncated } = await measureConversationReadSegment(
                        searchTiming,
                        "附件物化",
                        () => materializeRoundAttachmentsWithOptionalBudget(selectedRounds, cascadeId),
                    );
                    await measureConversationReadSegment(searchTiming, "格式化", async () => {
                        for (let index = 0; index < sortedRounds.length; index++) {
                            const ri = sortedRounds[index];
                            const round = displayRounds.find(item => item.roundIndex === ri);
                            if (!round) continue;
                            output.push(formatRound(round, depth as Depth, extraTypes as ExtraType[], { compactionMode: effectiveCompactionMode }));
                            output.push("");
                            await yieldConversationFormatIfNeeded(index + 1);
                        }
                    });
                    if (truncated > 0) output.push(`⚠️ ${truncated} 个附件超过单次生成上限，未生成临时文件\n`);

                    // 上下文大小控制
                    let text = output.join("\n");
                    const MAX_SEARCH = 8000;
                    if (depth === "full" && text.length > MAX_SEARCH) {
                        // full 深度不截断，写入临时文件
                        const slug = cascadeId.slice(0, 8);
                        const tmpPath = await measureConversationReadSegment(searchTiming, "临时文件", () => saveTempFileAsync("search", slug, text));
                        const summary = appendConversationReadDetail(
                            `${searchHeader}\n\n${text.slice(0, 2000)}\n\n📄 完整搜索结果已写入: ${tmpPath}\n(共 ${text.length} 字)`,
                            formatConversationReadSegmentTiming(searchTiming),
                        );
                        return appendTiming({
                            content: [{ type: "text" as const, text: summary }],
                        }, startTime);
                    } else if (text.length > MAX_SEARCH) {
                        text = text.slice(0, MAX_SEARCH) + `\n\n⚠️ 结果过长已截断（${text.length}→${MAX_SEARCH}字），请用更精确的关键词或 depth=brief`;
                    }
                    text = appendConversationReadDetail(text, formatConversationReadSegmentTiming(searchTiming));

                    return appendTiming({
                        content: [{ type: "text" as const, text: `${searchHeader}\n\n${text}` }],
                    }, startTime);
                }

                // === read 模式 ===
                if (action === "read") {
                    const readTiming = createConversationReadTimingState("read");
                    const start = startRound || 1;
                    const end = endRound || rounds.length;
                    const incompleteWindsurfWarning = formatWindsurfIncompleteReadWarning(loaded);
                    if (incompleteWindsurfWarning) {
                        const output = [
                            formatOverview(cascadeId, rounds, totalSteps),
                            `🔗 数据链路: ${loaded.chainUsed}`,
                            windsurfSourceDiagnostics,
                            incompleteWindsurfWarning,
                        ].filter(Boolean).join("\n");
                        return appendTiming({
                            content: [{ type: "text" as const, text: appendConversationReadDetail(output, formatConversationReadSegmentTiming(readTiming)) }],
                        }, startTime);
                    }

                    if (start > rounds.length) {
                        return appendTiming({
                            content: [{ type: "text" as const, text: `❌ startRound ${start} 超出范围（共 ${rounds.length} 轮）` }],
                        }, startTime);
                    }

                    const output: string[] = [];
                    const buildState = { chars: 0, truncated: false };
                    const overview = formatOverview(cascadeId, rounds, totalSteps);
                    pushOutputWithBuildBudget(output, overview, buildState, "read 输出");
                    pushOutputWithBuildBudget(output, `🔗 数据链路: ${loaded.chainUsed}`, buildState, "read 输出");
                    const subagentNote = formatSubagentSourceNote(loaded);
                    if (subagentNote) pushOutputWithBuildBudget(output, subagentNote, buildState, "read 输出");
                    const logicalChainNote = formatClaudeCodeLogicalChainNote(loaded);
                    if (logicalChainNote) pushOutputWithBuildBudget(output, logicalChainNote, buildState, "read 输出");
                    const roleFilter = normalizeMessageRoles(messageRoles as ConversationMessageRole[] | undefined);
                    pushOutputWithBuildBudget(output, `📖 读取轮次 ${start}-${Math.min(end, rounds.length)}${roleFilter.size ? ` | 角色过滤: ${[...roleFilter].join(", ")}` : ""}\n`, buildState, "read 输出");
                    if (windsurfSourceDiagnostics) {
                        pushOutputWithBuildBudget(output, windsurfSourceDiagnostics, buildState, "read 输出");
                        pushOutputWithBuildBudget(output, "", buildState, "read 输出");
                    }

                    const selectedRounds = rounds.slice(start - 1, Math.min(end, rounds.length));
                    const attachmentDeadlineAt = Date.now() + getReadAttachmentBudgetMs();
                    const { rounds: displayRounds, truncated, budgetExceeded: attachmentBudgetExceeded } = await measureConversationReadSegment(
                        readTiming,
                        "附件物化",
                        () => materializeRoundAttachmentsWithOptionalBudget(selectedRounds, cascadeId, { deadlineAt: attachmentDeadlineAt }),
                    );
                    const formatDeadlineAt = Date.now() + getReadFormatBudgetMs();
                    let formatBudgetExceeded = false;
                    await measureConversationReadSegment(readTiming, "格式化", async () => {
                        for (let i = start; i <= Math.min(end, rounds.length); i++) {
                            const round = displayRounds[i - start];
                            if (!round) continue;
                            const formatted = formatRoundForMessageRolesWithOptionalBudget(
                                round,
                                depth as Depth,
                                extraTypes as ExtraType[],
                                roleFilter,
                                effectiveCompactionMode,
                                { deadlineAt: formatDeadlineAt },
                            );
                            if (formatted.budgetExceeded) {
                                formatBudgetExceeded = true;
                            }
                            if (!formatted.text) {
                                if (formatted.budgetExceeded) break;
                                continue;
                            }
                            if (!pushOutputWithBuildBudget(output, formatted.text, buildState, "read 输出")) break;
                            if (!pushOutputWithBuildBudget(output, "", buildState, "read 输出")) break;
                            if (formatted.budgetExceeded) break;
                            await yieldConversationFormatIfNeeded(i - start + 1);
                        }
                    });
                    if (truncated > 0) output.push(`⚠️ ${truncated} 个附件超过单次生成上限，未生成临时文件\n`);
                    if (attachmentBudgetExceeded || formatBudgetExceeded) {
                        output.push("⚠️ 本次 read 在预算内先返回了部分结果；请缩小轮次范围后重试（例如减小 endRound-startRound）。\n");
                    }

                    if (!buildState.truncated && expandedChildren.length > 0) {
                        pushOutputWithBuildBudget(output, "# 子代理线程展开", buildState, "read 输出");
                        pushOutputWithBuildBudget(output, "", buildState, "read 输出");
                        for (const child of expandedChildren) {
                            if (!pushOutputWithBuildBudget(output, `## 子线程 ${child.thread.id.slice(0, 8)}... ${child.thread.title ? `| ${child.thread.title}` : ""}`, buildState, "read 输出")) break;
                            if (!pushOutputWithBuildBudget(output, "", buildState, "read 输出")) break;
                            const { rounds: childDisplayRounds, truncated: childTruncated } = await materializeRoundAttachmentsWithOptionalBudget(child.rounds, child.thread.id);
                            for (let index = 0; index < childDisplayRounds.length; index++) {
                                const round = childDisplayRounds[index];
                                const formatted = formatRoundForMessageRolesWithOptionalBudget(round, depth as Depth, extraTypes as ExtraType[], roleFilter, effectiveCompactionMode);
                                if (!formatted.text) continue;
                                if (!pushOutputWithBuildBudget(output, formatted.text, buildState, "read 输出")) break;
                                if (!pushOutputWithBuildBudget(output, "", buildState, "read 输出")) break;
                                await yieldConversationFormatIfNeeded(index + 1);
                            }
                            if (childTruncated > 0) output.push(`⚠️ 子线程 ${child.thread.id.slice(0, 8)} 有 ${childTruncated} 个附件超过单次生成上限，未生成临时文件\n`);
                            if (buildState.truncated) break;
                        }
                    }
                    if (!buildState.truncated && childDiagnostics.length > 0) {
                        pushOutputWithBuildBudget(output, "# 子代理线程诊断", buildState, "read 输出");
                        pushOutputWithBuildBudget(output, "", buildState, "read 输出");
                        for (const item of childDiagnostics) {
                            const label = item.nickname ? `${item.nickname} (${item.threadId.slice(0, 8)}...)` : item.threadId;
                            if (!pushOutputWithBuildBudget(output, `- ${label}: ${item.reason} — ${item.detail}`, buildState, "read 输出")) break;
                        }
                    }

                    // 上下文大小控制
                    let text = output.join("\n");
                    const MAX_READ = 15000;
                    if (depth === "full" && text.length > MAX_READ) {
                        // full 深度不截断，写入临时文件供完整阅读
                        const slug = cascadeId.slice(0, 8);
                        const tmpPath = await measureConversationReadSegment(readTiming, "临时文件", () => saveTempFileAsync("read", slug, text));
                        const summary = appendConversationReadDetail(
                            `${text.slice(0, 2000)}\n\n📄 完整内容已写入: ${tmpPath}\n(共 ${text.length} 字，${output.length} 段)`,
                            formatConversationReadSegmentTiming(readTiming),
                        );
                        return appendTiming({
                            content: [{ type: "text" as const, text: summary }],
                        }, startTime);
                    } else if (text.length > MAX_READ) {
                        text = text.slice(0, MAX_READ) + `\n\n⚠️ 结果过长已截断（${text.length}→${MAX_READ}字），请用更小的轮次范围或 brief 深度`;
                    }
                    text = appendConversationReadDetail(text, formatConversationReadSegmentTiming(readTiming));

                    return appendTiming({
                        content: [{ type: "text" as const, text }],
                    }, startTime);
                }

                return appendTiming({
                    content: [{ type: "text" as const, text: `❌ 未知 action: ${action}` }],
                }, startTime);

            } catch (error) {
                return appendTiming({
                    content: [{
                        type: "text" as const,
                        text: formatToolError(`conversation_read_original(${params.action})`, error, {
                            action: params.action,
                            conversationId: params.conversationId,
                            query: params.query,
                            mode: params.mode,
                            chain: params.chain,
                            dataChain: params.dataChain,
                            modelChain: params.modelChain,
                        }),
                    }],
                }, startTime);
            }
        }
    );
}
