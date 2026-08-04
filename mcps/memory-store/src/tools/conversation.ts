import { createHash } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { touchActivity, appendTiming, isRecordAutoUpdateEnabledForHost } from "../lifecycle.js";
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
import { shouldAutoUpdateRecordAsync } from "../record-generator.js";
import { readRecordAsync, resolveWorkspaceHashForRecord, findRecordHashAsync } from "../record-store.js";
import {
    loadConversationData,
    resolveConversationChain,
    type ConversationLoadResult,
    type ResolvedConversationChain,
} from "../conversation-bridge.js";
import { CHAIN_COMPAT_INPUT_VALUES, DATA_CHAIN_INPUT_VALUES, DEFAULT_CHAIN, DEFAULT_LINK_MODE, resolveChainSplit } from "../chain.js";
import { formatToolError } from "../error-format.js";
import { dataChainInputSchema, dataChainValueSchema, modelChainInputSchema } from "./schema-utils.js";
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
import type { Chain, DataChain, ConversationLogicalChainMode } from "../chain.js";
import type { SearchMode, SearchResult, TextBlock } from "../search-engine.js";
import { formatAttachmentOverview, materializeRoundAttachments } from "../conversation-attachments.js";
import {
    cancelBackgroundTask,
    formatBackgroundTask,
    getBackgroundTask,
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
import { iterateCachedConversationSourceCacheRounds, readFiniteIntegerEnv } from "../conversation-source-cache.js";
import { writeFetchedConversationArtifact, type StreamedFetchArtifact } from "../conversation-fetch-artifact.js";
import {
    buildCodexFetchTaskId,
    createCodexFetchWorkerPayload,
    estimateCodexFetchWork,
    runCodexFetchWorker,
} from "../conversation-fetch-worker-client.js";
import {
    isCodexFetchWorkerPayload,
    type CodexFetchWorkerPayload,
    type CodexFetchWorkerResult,
} from "../conversation-fetch-worker-types.js";
import { withConversationSourcePressure } from "../conversation-source-pressure.js";
import { listLocalPbConversationCandidates } from "../conversation-local-list.js";
import {
    formatConversationRecallRound,
    selectConversationRecallRange,
    writeConversationRecallArtifact,
    type ConversationRecallArtifact,
    type ConversationRecallMode,
} from "../conversation-recall.js";

const CONVERSATION_READ_TEXT_BUILD_MAX_CHARS = readFiniteIntegerEnv("MEMORY_STORE_CONVERSATION_READ_TEXT_BUILD_MAX_CHARS", 64 * 1024 * 1024);
const CONVERSATION_READ_WINDOW_MAX_CHARS = Math.max(100_000, readFiniteIntegerEnv("MEMORY_STORE_CONVERSATION_READ_WINDOW_MAX_CHARS", 8 * 1024 * 1024));
const DEFAULT_CONVERSATION_READ_DELIVERY_MAX_CHARS = 100_000;
const CONVERSATION_READ_DELIVERY_MAX_CHARS = readFiniteIntegerEnv("MEMORY_STORE_CONVERSATION_READ_DELIVERY_MAX_CHARS", DEFAULT_CONVERSATION_READ_DELIVERY_MAX_CHARS);
const CONVERSATION_READ_TAIL_PREVIEW_CHARS = readFiniteIntegerEnv("MEMORY_STORE_CONVERSATION_READ_TAIL_PREVIEW_CHARS", 2_000);
const CONVERSATION_LIST_TITLE_MAX_CHARS = Math.max(readFiniteIntegerEnv("MEMORY_STORE_CONVERSATION_LIST_TITLE_MAX_CHARS", 120), 20);
const CONVERSATION_DIRECT_ACTIONS = new Set(["fetch", "search", "read", "recall", "export"]);

function candidateLimitForLocalList(limit?: number): number {
    const requested = Math.min(Math.max(limit || 20, 1), 100);
    return Math.max(requested * 3, 300);
}

export interface ConversationReadSourcePosition {
    charPosition: number;
    roundIndex: number;
    stepIndex: number;
}

interface ConversationReadContinuationPayload {
    version: 1;
    conversationId: string;
    sourceFingerprint: string;
    roundIndex: number;
    stepIndex: number;
    charPosition: number;
}

interface ConversationReadContinuationCursor extends ConversationReadContinuationPayload {
    hash: string;
}

export interface ConversationReadDelivery {
    text: string;
    hasMore: boolean;
    cursor?: string;
    sourceFingerprint: string;
    startCharPosition: number;
    endCharPosition: number;
    roundIndex: number;
    stepIndex: number;
    tailPreview?: string;
    hardSplit?: boolean;
    splitReason?: "inside_code_fence" | "inside_details" | "inside_round";
}

function hashConversationReadValue(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function continuationPayloadHash(payload: ConversationReadContinuationPayload): string {
    return hashConversationReadValue(JSON.stringify(payload));
}

function encodeConversationReadCursor(payload: ConversationReadContinuationPayload): string {
    const cursor: ConversationReadContinuationCursor = {
        ...payload,
        hash: continuationPayloadHash(payload),
    };
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeConversationReadCursor(cursor: string): ConversationReadContinuationCursor {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
        throw new Error("conversation continuation cursor is malformed");
    }
    if (!parsed || typeof parsed !== "object") throw new Error("conversation continuation cursor is malformed");
    const value = parsed as Partial<ConversationReadContinuationCursor>;
    const payload: ConversationReadContinuationPayload = {
        version: value.version as 1,
        conversationId: value.conversationId || "",
        sourceFingerprint: value.sourceFingerprint || "",
        roundIndex: value.roundIndex as number,
        stepIndex: value.stepIndex as number,
        charPosition: value.charPosition as number,
    };
    if (payload.version !== 1
        || !payload.conversationId
        || !payload.sourceFingerprint
        || !Number.isInteger(payload.roundIndex)
        || !Number.isInteger(payload.stepIndex)
        || !Number.isInteger(payload.charPosition)
        || payload.charPosition < 0
        || typeof value.hash !== "string") {
        throw new Error("conversation continuation cursor is invalid");
    }
    if (value.hash !== continuationPayloadHash(payload)) {
        throw new Error("conversation continuation cursor integrity check failed");
    }
    return { ...payload, hash: value.hash };
}

function isLowSurrogateCodeUnit(value: number): boolean {
    return value >= 0xdc00 && value <= 0xdfff;
}

function isConversationReadCodePointBoundary(text: string, position: number): boolean {
    return position === 0 || position === text.length || !isLowSurrogateCodeUnit(text.charCodeAt(position));
}

function getConversationReadCodePointSize(text: string, position: number): { chars: number; bytes: number } {
    const value = text.codePointAt(position) || 0;
    if (value > 0xffff) return { chars: 2, bytes: 4 };
    if (value <= 0x7f) return { chars: 1, bytes: 1 };
    if (value <= 0x7ff) return { chars: 1, bytes: 2 };
    return { chars: 1, bytes: 3 };
}

function readOptionalFinitePositiveInteger(value: number | undefined): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : undefined;
}

function findConversationReadChunkEnd(text: string, start: number, maxChars: number, maxBytes?: number): number {
    let position = start;
    let chars = 0;
    let bytes = 0;
    while (position < text.length && chars < maxChars) {
        const size = getConversationReadCodePointSize(text, position);
        if (maxBytes !== undefined && bytes + size.bytes > maxBytes) break;
        position += size.chars;
        chars += 1;
        bytes += size.bytes;
    }
    return position;
}

interface ConversationReadMarkdownState {
    fenceCharacter: "`" | "~" | null;
    fenceLength: number;
    detailsDepth: number;
}

function updateConversationReadMarkdownState(line: string, state: ConversationReadMarkdownState): void {
    const fence = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
    if (fence) {
        const character = fence[0] as "`" | "~";
        if (state.fenceCharacter === null) {
            state.fenceCharacter = character;
            state.fenceLength = fence.length;
        } else if (state.fenceCharacter === character && fence.length >= state.fenceLength) {
            state.fenceCharacter = null;
            state.fenceLength = 0;
        }
    }
    if (state.fenceCharacter !== null) return;
    const openedDetails = line.match(/<details(?:\s[^>]*)?>/giu)?.length || 0;
    const closedDetails = line.match(/<\/details\s*>/giu)?.length || 0;
    state.detailsDepth = Math.max(0, state.detailsDepth + openedDetails - closedDetails);
}

function findConversationReadStructuralChunkEnd(input: {
    text: string;
    start: number;
    rawEnd: number;
    sourcePositions: ConversationReadSourcePosition[];
}): { end: number; hardSplit: boolean; splitReason?: ConversationReadDelivery["splitReason"] } {
    if (input.rawEnd >= input.text.length) return { end: input.rawEnd, hardSplit: false };
    const activeSourcePosition = resolveConversationReadSourcePosition(input.sourcePositions, input.start);
    const roundBoundary = input.sourcePositions
        .filter(position => position.charPosition > input.start
            && position.charPosition <= input.rawEnd
            && (position.roundIndex !== activeSourcePosition.roundIndex
                || position.stepIndex !== activeSourcePosition.stepIndex))
        .map(position => position.charPosition)
        .sort((left, right) => right - left)[0];
    if (roundBoundary !== undefined) return { end: roundBoundary, hardSplit: false };

    const anchor = input.sourcePositions
        .map(position => position.charPosition)
        .filter(position => position <= input.start)
        .sort((left, right) => right - left)[0] ?? 0;
    const state: ConversationReadMarkdownState = { fenceCharacter: null, fenceLength: 0, detailsDepth: 0 };
    let latestLineBoundary: number | undefined;
    let latestBlockBoundary: number | undefined;
    let lineStart = anchor;
    while (lineStart < input.rawEnd) {
        const newline = input.text.indexOf("\n", lineStart);
        if (newline < 0 || newline + 1 > input.rawEnd) break;
        const lineEnd = newline + 1;
        const line = input.text.slice(lineStart, lineEnd);
        updateConversationReadMarkdownState(line, state);
        if (lineEnd > input.start && state.fenceCharacter === null && state.detailsDepth === 0) {
            latestLineBoundary = lineEnd;
            if (line.trim().length === 0) latestBlockBoundary = lineEnd;
        }
        lineStart = lineEnd;
    }
    const structuralEnd = latestBlockBoundary ?? latestLineBoundary;
    if (structuralEnd !== undefined) return { end: structuralEnd, hardSplit: false };
    return {
        end: input.rawEnd,
        hardSplit: true,
        splitReason: state.fenceCharacter !== null
            ? "inside_code_fence"
            : state.detailsDepth > 0
                ? "inside_details"
                : "inside_round",
    };
}

function findConversationReadTailPreview(text: string): string {
    let start = Math.max(0, text.length - CONVERSATION_READ_TAIL_PREVIEW_CHARS);
    while (start < text.length && !isConversationReadCodePointBoundary(text, start)) start += 1;
    return text.slice(start);
}

function resolveConversationReadSourcePosition(
    sourcePositions: ConversationReadSourcePosition[],
    charPosition: number,
): ConversationReadSourcePosition {
    let current = sourcePositions[0] || { charPosition: 0, roundIndex: 0, stepIndex: 0 };
    for (const candidate of sourcePositions) {
        if (candidate.charPosition > charPosition) break;
        current = candidate;
    }
    return current;
}

export function paginateConversationReadText(input: {
    conversationId: string;
    text: string;
    sourcePositions: ConversationReadSourcePosition[];
    continuationCursor?: string;
    maxChars?: number;
    maxBytes?: number;
}): ConversationReadDelivery {
    const sourceFingerprint = hashConversationReadValue(input.text);
    const maxBytes = readOptionalFinitePositiveInteger(input.maxBytes);
    const maxChars = readOptionalFinitePositiveInteger(input.maxChars ?? maxBytes) ?? CONVERSATION_READ_DELIVERY_MAX_CHARS;
    let startCharPosition = 0;
    if (input.continuationCursor) {
        const cursor = decodeConversationReadCursor(input.continuationCursor);
        if (cursor.conversationId !== input.conversationId) throw new Error("conversation continuation cursor belongs to another conversation");
        if (cursor.sourceFingerprint !== sourceFingerprint) throw new Error("conversation continuation cursor source changed; restart the read");
        startCharPosition = cursor.charPosition;
    }
    if (startCharPosition > input.text.length || !isConversationReadCodePointBoundary(input.text, startCharPosition)) {
        throw new Error("conversation continuation cursor position is invalid");
    }
    const rawEndCharPosition = findConversationReadChunkEnd(input.text, startCharPosition, maxChars, maxBytes);
    const structuralEnd = findConversationReadStructuralChunkEnd({
        text: input.text,
        start: startCharPosition,
        rawEnd: rawEndCharPosition,
        sourcePositions: input.sourcePositions,
    });
    const endCharPosition = structuralEnd.end;
    if (endCharPosition === startCharPosition && startCharPosition < input.text.length) {
        throw new Error("maxBytes is too small to deliver the next Unicode character");
    }
    const sourcePosition = resolveConversationReadSourcePosition(input.sourcePositions, endCharPosition);
    const hasMore = endCharPosition < input.text.length;
    const cursor = hasMore
        ? encodeConversationReadCursor({
            version: 1,
            conversationId: input.conversationId,
            sourceFingerprint,
            roundIndex: sourcePosition.roundIndex,
            stepIndex: sourcePosition.stepIndex,
            charPosition: endCharPosition,
        })
        : undefined;
    return {
        text: input.text.slice(startCharPosition, endCharPosition),
        hasMore,
        cursor,
        sourceFingerprint,
        startCharPosition,
        endCharPosition,
        roundIndex: sourcePosition.roundIndex,
        stepIndex: sourcePosition.stepIndex,
        tailPreview: hasMore && startCharPosition === 0 ? findConversationReadTailPreview(input.text) : undefined,
        ...(structuralEnd.hardSplit ? { hardSplit: true, splitReason: structuralEnd.splitReason } : {}),
    };
}

export function formatConversationReadDelivery(
    delivery: ConversationReadDelivery,
    nextParams: Record<string, unknown>,
    terminalNextParams?: Record<string, unknown>,
): string {
    if (!delivery.hasMore) {
        if (!terminalNextParams) return delivery.text;
        return [delivery.text, "", "➡️ 下一段参数", JSON.stringify(terminalNextParams)].join("\n");
    }
    const phase = delivery.startCharPosition === 0 ? "开头正文" : "续读正文";
    if (delivery.hardSplit) {
        const reason = delivery.splitReason === "inside_code_fence"
            ? "代码围栏"
            : delivery.splitReason === "inside_details"
                ? "details 块"
                : "同一轮长内容";
        const lines = [
            `📖 ${phase}：已交付字符 ${delivery.startCharPosition}-${delivery.endCharPosition}，下一段从光标继续，不会重复已交付正文。`,
            "",
            `⚠️ 单个${reason}超过本次预算，本页只能在结构内部续切；完整内容仍保留在 fetch 缓存。为避免半截 Markdown 吞掉续读信息，光标参数先于正文显示。`,
            "➡️ 下一段参数",
            JSON.stringify({ ...nextParams, continuationCursor: delivery.cursor }),
        ];
        if (delivery.tailPreview) {
            lines.push("", "🔚 末尾预览（仅用于定位，不能与正文拼接）", delivery.tailPreview);
        }
        lines.push("", "📄 本页正文（原样片段）", delivery.text);
        return lines.join("\n");
    }
    const lines = [
        `📖 ${phase}：已交付字符 ${delivery.startCharPosition}-${delivery.endCharPosition}，下一段从光标继续，不会重复已交付正文。`,
        "",
        delivery.text,
        "",
        `⚠️ 对话共 ${delivery.sourceFingerprint.slice(0, 12)}… 指纹下的后续内容尚未交付，光标定位到 round ${delivery.roundIndex} / step ${delivery.stepIndex} / char ${delivery.endCharPosition}。`,
    ];
    if (delivery.tailPreview) {
        lines.push("", "🔚 末尾预览（仅用于定位，不能与正文拼接）", delivery.tailPreview);
    }
    lines.push("", "➡️ 下一段参数", JSON.stringify({ ...nextParams, continuationCursor: delivery.cursor }));
    return lines.join("\n");
}

export function formatPaginatedConversationReadText(input: {
    conversationId: string;
    text: string;
    sourcePositions: ConversationReadSourcePosition[];
    continuationCursor?: string;
    maxBytes?: number;
    nextParams: Record<string, unknown>;
    terminalNextParams?: Record<string, unknown>;
    detail?: string;
}): { text: string; delivery: ConversationReadDelivery } {
    const maxTotalBytes = readOptionalFinitePositiveInteger(input.maxBytes);
    const maxTotalChars = maxTotalBytes === undefined ? CONVERSATION_READ_DELIVERY_MAX_CHARS : undefined;
    let bodyMaxChars = maxTotalChars;
    let bodyMaxBytes = maxTotalBytes;
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const delivery = paginateConversationReadText({
            conversationId: input.conversationId,
            text: input.text,
            sourcePositions: input.sourcePositions,
            continuationCursor: input.continuationCursor,
            maxChars: bodyMaxChars,
            maxBytes: bodyMaxBytes,
        });
        const formatted = appendConversationReadDetail(
            formatConversationReadDelivery(delivery, input.nextParams, input.terminalNextParams),
            input.detail,
        );
        const finalChars = formatted.length;
        const finalBytes = Buffer.byteLength(formatted, "utf8") + 1_024;
        const charOverflow = maxTotalChars === undefined ? 0 : Math.max(0, finalChars - maxTotalChars);
        const byteOverflow = maxTotalBytes === undefined ? 0 : Math.max(0, finalBytes - maxTotalBytes);
        if (charOverflow === 0 && byteOverflow === 0) return { text: formatted, delivery };
        if (charOverflow > 0 && bodyMaxChars !== undefined) bodyMaxChars = Math.max(1, bodyMaxChars - charOverflow - 64);
        if (byteOverflow > 0 && bodyMaxBytes !== undefined) bodyMaxBytes = Math.max(1, bodyMaxBytes - byteOverflow - 64);
    }
    throw new Error("conversation read metadata exceeds the requested delivery budget; increase maxBytes");
}

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
    return readFiniteIntegerEnv(name, fallback, 0);
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
    const lines: string[] = (loaded.sourceDiagnostics || []).map(detail => `🔎 对话源: ${detail}`);
    if (loaded.cacheGeneration) {
        lines.push(`🧠 fetch 缓存: ${loaded.cacheState || "hit"} | generation=${loaded.cacheGeneration} | source=${loaded.sourceMode || "auto"}`);
    }
    if (loaded.chainUsed !== "windsurf" || !loaded.windsurfData) return lines.join("\n");
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
    if (loaded.chainUsed !== "windsurf" || (loaded.roundCount ?? loaded.rounds.length) > 0) return "";
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

type LoadedConversationData = NonNullable<Awaited<ReturnType<typeof loadConversationData>>>;

export interface FetchRecordUpdateInput {
    conversationId: string;
    chainUsed: ResolvedConversationChain;
    modelChain: Chain;
    artifact: StreamedFetchArtifact;
    totalSteps: number;
    workspace?: string;
    partial?: boolean;
    subagent?: boolean;
    cacheKey?: ConversationLoadResult["cacheKey"];
    cacheGeneration?: string;
    cacheFingerprint?: ConversationLoadResult["cacheFingerprint"];
    cacheState?: ConversationLoadResult["cacheState"];
    cacheBuildFailure?: ConversationLoadResult["cacheBuildFailure"];
    sourceMode?: ConversationLoadResult["sourceMode"];
}

export interface FetchRecordAutoUpdateDependencies {
    isEnabled?: () => boolean;
    findRecordHash?: (conversationId: string) => Promise<string | null>;
    resolveWorkspaceHash?: () => string;
    shouldUpdate?: (hash: string, conversationId: string, roundCount: number) => Promise<boolean>;
    admit?: (input: Parameters<typeof import("./record.js")["admitRecordAutoUpdate"]>[0]) => Promise<string>;
}

async function scheduleFetchRecordAutoUpdate(
    input: FetchRecordUpdateInput,
    dependencies: FetchRecordAutoUpdateDependencies = {},
): Promise<string> {
    try {
        if (input.partial) return "\n📋 Record 自动更新已跳过：WSF 本次原文读取不完整";
        if (!(dependencies.isEnabled || isRecordAutoUpdateEnabledForHost)()) return "\n📋 Record 自动更新已关闭";
        if (input.cacheState === "stale") {
            const failure = input.cacheBuildFailure
                ? `（${input.cacheBuildFailure.name}: ${input.cacheBuildFailure.message}）`
                : "";
            return `\n📋 Record 自动更新已跳过：fetch 缓存更新失败，继续提供上一份完整缓存${failure}`;
        }
        if (input.subagent) return "\n📋 Record 自动更新已跳过：子代理线程默认由源头主对话统一记录";

        const recordHash = await (dependencies.findRecordHash || findRecordHashAsync)(input.conversationId)
            || (dependencies.resolveWorkspaceHash || resolveWorkspaceHashForRecord)();
        if (!await (dependencies.shouldUpdate || shouldAutoUpdateRecordAsync)(recordHash, input.conversationId, input.artifact.roundCount)) {
            return "\n📋 Record 自动更新无需执行：新增轮次未达到阈值";
        }
        const admit = dependencies.admit || (await import("./record.js")).admitRecordAutoUpdate;
        const result = await admit({
            workspaceHash: recordHash,
            conversationId: input.conversationId,
            ...(input.workspace ? { workspace: input.workspace } : {}),
            dataChain: input.chainUsed,
            modelChain: input.modelChain,
            ...(input.cacheKey && input.cacheGeneration ? {
                cacheGeneration: {
                    key: input.cacheKey,
                    generation: input.cacheGeneration,
                    fingerprint: input.cacheFingerprint || null,
                },
                sourceSnapshot: {
                    kind: "conversation-fetch-cache" as const,
                    sourceMode: input.sourceMode || "auto",
                    chainUsed: input.chainUsed,
                    roundCount: input.artifact.roundCount,
                    totalSteps: input.totalSteps,
                },
            } : {}),
        });
        console.error(`[record] 自动更新 scheduler: ${result.replace(/\n/gu, " | ")}`);
        return /Record scheduler 已接纳更新/u.test(result)
            ? `\n📋 ${result}`
            : `\n📋 Record 自动更新未被确认接纳：\n${result}`;
    } catch (error) {
        return `\n📋 Record 自动更新未接纳：${error instanceof Error ? error.message : String(error)}`;
    }
}

export function scheduleFetchRecordAutoUpdateForTest(
    input: FetchRecordUpdateInput,
    dependencies: FetchRecordAutoUpdateDependencies,
): Promise<string> {
    return scheduleFetchRecordAutoUpdate(input, dependencies);
}

function formatCodexFetchWorkerSubagentNote(result: CodexFetchWorkerResult): string {
    const thread = result.thread;
    if (!thread.agentRole && !thread.agentNickname && !thread.parentConversationId) return "";
    return [
        "🤝 Codex 子代理线程",
        `parentConversationId: ${thread.parentConversationId || result.parentThread?.id || "(未找到)"}`,
        result.parentThread?.title ? `源头标题: ${formatConversationListTitleForTest(result.parentThread.title, 80)}` : "",
        thread.agentRole ? `子代理角色: ${thread.agentRole}` : "",
        thread.agentNickname ? `子代理名称: ${thread.agentNickname}` : "",
    ].filter(Boolean).join("\n");
}

function formatCodexFetchWorkerCompletion(result: CodexFetchWorkerResult, recordNote: string): string {
    const attachmentOverview = result.artifact.attachmentCount > 0
        ? `📎 附件引用: ${result.artifact.attachmentCount} 个（详细关系已写入 fetch 文件）`
        : "";
    const subagentNote = formatCodexFetchWorkerSubagentNote(result);
    const sourceDiagnostics = result.sourceDiagnostics?.length
        ? result.sourceDiagnostics.map(item => `⚠️ ${item}`).join("\n")
        : "";
    const text = [
        `📂 对话: ${result.conversationId}`,
        `📊 统计: ${result.artifact.roundCount} 轮对话 | ${result.totalSteps} 步骤 | AI 回复 ${result.artifact.aiResponseCount} 条 | 工具调用 ${result.artifact.toolCallCount} 次 (Codex 本地会话)`,
        subagentNote,
        "🔗 数据链路: codex",
        sourceDiagnostics,
        attachmentOverview,
        `📁 临时文件: ${result.artifact.tempPath}`,
        `💡 使用 search(query="关键词") 搜索或 read(startRound=1, endRound=3) 阅读${recordNote}`,
        `⏱ fetch 分段: 缓存 ${formatSegmentDuration(result.timings.cacheMs)} | 格式化 ${formatSegmentDuration(result.timings.artifactMs)} | 总计 ${formatSegmentDuration(result.timings.totalMs)}`,
    ].filter(Boolean).join("\n");
    return text;
}

async function runCodexFetchBackgroundTask(
    payload: CodexFetchWorkerPayload,
    taskContext: BackgroundTaskContext,
): Promise<string> {
    const result = await withConversationSourcePressure(
        "background",
        () => runCodexFetchWorker(payload, taskContext),
    );
    if (isBackgroundTaskAborted(taskContext)) {
        throw new Error(taskContext.isCancelled()
            ? "conversation fetch cancelled after worker completion"
            : "conversation fetch settled before result publication");
    }
    const recordNote = await scheduleFetchRecordAutoUpdate({
        conversationId: result.conversationId,
        chainUsed: result.chainUsed,
        modelChain: payload.modelChain,
        artifact: result.artifact,
        totalSteps: result.totalSteps,
        workspace: result.thread.cwd || undefined,
        subagent: Boolean(result.thread.agentRole || result.thread.agentNickname || result.thread.parentConversationId),
        cacheKey: result.cacheKey,
        cacheGeneration: result.cacheGeneration,
        cacheFingerprint: result.cacheFingerprint,
        cacheState: result.cacheState,
        cacheBuildFailure: result.cacheBuildFailure,
        sourceMode: result.sourceMode,
    });
    taskContext.updateProgress({ stage: "done", detail: "Codex fetch 缓存与可读文件均已完成" });
    return formatCodexFetchWorkerCompletion(result, recordNote);
}

function selectCodexFetchTaskId(payload: CodexFetchWorkerPayload): string {
    const baseTaskId = buildCodexFetchTaskId(payload);
    const baseTask = getBackgroundTask(baseTaskId);
    if (!baseTask || baseTask.status === "running" || baseTask.status === "suspended" || baseTask.status === "done") {
        return baseTaskId;
    }
    for (let attempt = 1; attempt < 1_000; attempt += 1) {
        const retryTaskId = `${baseTaskId}-retry-${attempt}`;
        const retryTask = getBackgroundTask(retryTaskId);
        if (!retryTask || retryTask.status === "running" || retryTask.status === "suspended" || retryTask.status === "done") {
            return retryTaskId;
        }
    }
    throw new Error("conversation fetch 重试任务编号已耗尽");
}

function formatLoadedOverview(loaded: LoadedConversationData, stats?: Omit<StreamedFetchArtifact, "tempPath" | "attachmentCount">): string {
    const roundCount = stats?.roundCount ?? loaded.roundCount ?? loaded.rounds.length;
    const aiResponseCount = stats?.aiResponseCount ?? loaded.aiResponseCount
        ?? loaded.rounds.reduce((sum, round) => sum + round.aiResponses.length, 0);
    const toolCallCount = stats?.toolCallCount ?? loaded.toolCallCount
        ?? loaded.rounds.reduce((sum, round) => sum + round.toolCalls.length, 0);
    return [
        `📂 对话: ${loaded.conversationId}`,
        `📊 统计: ${roundCount} 轮对话 | ${loaded.totalSteps} 步骤 | AI 回复 ${aiResponseCount} 条 | 工具调用 ${toolCallCount} 次`,
    ].join("\n");
}

function searchLoadedConversationExact(loaded: LoadedConversationData, query: string, limit?: number) {
    if (loaded.rounds.length > 0) return searchInRounds(loaded.rounds, query, limit);
    if (!loaded.cacheKey || !loaded.cacheGeneration) return [];
    const cached = iterateCachedConversationSourceCacheRounds<ConversationRound>({
        key: loaded.cacheKey,
        generation: loaded.cacheGeneration,
    });
    if (!cached) return [];
    const matches: ReturnType<typeof searchInRounds> = [];
    const maxMatches = Math.max(1, limit || 20);
    for (const round of cached.rounds) {
        matches.push(...searchInRounds([round], query, maxMatches - matches.length));
        if (matches.length >= maxMatches) break;
    }
    return matches;
}

function loadConversationRoundWindow(
    loaded: LoadedConversationData,
    startRound: number,
    endRound: number,
): { rounds: ConversationRound[]; endRound: number; hasMore: boolean } {
    const totalRoundCount = loaded.roundCount ?? loaded.rounds.length;
    const boundedEnd = Math.min(endRound, totalRoundCount);
    const cached = loaded.cacheKey && loaded.cacheGeneration
        ? iterateCachedConversationSourceCacheRounds<ConversationRound>({
            key: loaded.cacheKey,
            generation: loaded.cacheGeneration,
            startRound,
            endRound: boundedEnd,
        })
        : null;
    const source = cached?.rounds || loaded.rounds.slice(startRound - 1, boundedEnd);
    const rounds: ConversationRound[] = [];
    let estimatedChars = 0;
    for (const round of source) {
        const roundChars = JSON.stringify(round).length;
        if (rounds.length > 0 && estimatedChars + roundChars > CONVERSATION_READ_WINDOW_MAX_CHARS) break;
        rounds.push(round);
        estimatedChars += roundChars;
    }
    const loadedEndRound = rounds.at(-1)?.roundIndex || startRound - 1;
    return {
        rounds,
        endRound: loadedEndRound,
        hasMore: loadedEndRound < boundedEnd,
    };
}

export function iterateConversationRecallRounds(
    loaded: LoadedConversationData,
    startRound: number,
    endRound: number,
): Iterable<ConversationRound> {
    if (loaded.cacheKey && loaded.cacheGeneration) {
        const cached = iterateCachedConversationSourceCacheRounds<ConversationRound>({
            key: loaded.cacheKey,
            generation: loaded.cacheGeneration,
            startRound,
            endRound,
        });
        if (!cached) {
            throw new Error(`Recall cache generation ${loaded.cacheGeneration} is missing or corrupt; refusing to return incomplete context`);
        }
        return cached.rounds;
    }
    if (loaded.rounds.length === 0) {
        throw new Error("Recall has neither a committed cache generation nor loaded rounds; refusing to return empty context");
    }
    return loaded.rounds.filter(round => round.roundIndex >= startRound && round.roundIndex <= endRound);
}

function formatRecallArtifactNote(artifact: ConversationRecallArtifact): string {
    return [
        "📦 完整 context-only Recall 临时文件",
        `路径: ${artifact.path}`,
        `SHA256: ${artifact.sha256}`,
        `大小: ${artifact.bytes} bytes | 人类轮次: ${artifact.startRound}-${artifact.endRound} | 实际有内容 ${artifact.rounds} 轮`,
        `过期时间: ${artifact.expiresAt}`,
    ].join("\n");
}

function buildConversationRecallText(
    loaded: LoadedConversationData,
    selection: NonNullable<ReturnType<typeof selectConversationRecallRange>>,
    artifact?: ConversationRecallArtifact,
): { text: string; sourcePositions: ConversationReadSourcePosition[] } {
    const latest = loaded.cacheState !== "stale";
    const lines = [
        "🧠 Conversation Recall（context-only）",
        `📂 对话: ${loaded.conversationId}`,
        `🔗 数据链路: ${loaded.chainUsed}`,
        `📌 cacheGeneration: ${loaded.cacheGeneration || "(unknown)"}`,
        `🕒 缓存截至: ${loaded.cacheCreatedAt || "(unknown)"} | isLatest=${latest}`,
        `📖 回溯轮次: ${selection.startRound}-${selection.endRound}`,
        `🎯 选择原因: ${selection.reason}`,
        ...(loaded.cacheBuildFailure ? [`⚠️ 刷新失败: ${loaded.cacheBuildFailure.name}: ${loaded.cacheBuildFailure.message}`] : []),
        ...(artifact ? ["", formatRecallArtifactNote(artifact)] : []),
        "",
    ];
    const sourcePositions: ConversationReadSourcePosition[] = [{
        charPosition: 0,
        roundIndex: selection.startRound,
        stepIndex: 0,
    }];
    let builtChars = lines.reduce((sum, item) => sum + item.length + 1, 0);
    for (const round of iterateConversationRecallRounds(loaded, selection.startRound, selection.endRound)) {
        const formatted = formatConversationRecallRound(round);
        if (!formatted) continue;
        sourcePositions.push({
            charPosition: Math.max(0, builtChars - 1),
            roundIndex: round.roundIndex,
            stepIndex: round.startStep,
        });
        lines.push(formatted, "");
        builtChars += formatted.length + 2;
        if (builtChars > CONVERSATION_READ_TEXT_BUILD_MAX_CHARS) {
            throw new Error(`recall context-only output exceeds ${CONVERSATION_READ_TEXT_BUILD_MAX_CHARS} characters; use recallMode=full`);
        }
    }
    return { text: lines.join("\n"), sourcePositions };
}

function loadConversationRoundsByIndex(loaded: LoadedConversationData, roundIndices: readonly number[]): ConversationRound[] {
    if (roundIndices.length === 0) return [];
    const wanted = new Set(roundIndices);
    if (loaded.rounds.length > 0) return loaded.rounds.filter(round => wanted.has(round.roundIndex));
    if (!loaded.cacheKey || !loaded.cacheGeneration) return [];
    const sorted = [...wanted].sort((left, right) => left - right);
    const rounds: ConversationRound[] = [];
    let groupStart = sorted[0];
    let groupEnd = sorted[0];
    const readGroup = (): boolean => {
        const cached = iterateCachedConversationSourceCacheRounds<ConversationRound>({
            key: loaded.cacheKey!,
            generation: loaded.cacheGeneration!,
            startRound: groupStart,
            endRound: groupEnd,
        });
        if (!cached) return false;
        for (const round of cached.rounds) if (wanted.has(round.roundIndex)) rounds.push(round);
        return true;
    };
    for (const roundIndex of sorted.slice(1)) {
        if (roundIndex === groupEnd + 1) {
            groupEnd = roundIndex;
            continue;
        }
        if (!readGroup()) return [];
        groupStart = roundIndex;
        groupEnd = roundIndex;
    }
    if (!readGroup()) return [];
    return rounds;
}

function iterateLoadedConversationSearchBlocks(loaded: LoadedConversationData): Iterable<TextBlock> {
    const cached = loaded.rounds.length === 0 && loaded.cacheKey && loaded.cacheGeneration
        ? iterateCachedConversationSourceCacheRounds<ConversationRound>({ key: loaded.cacheKey, generation: loaded.cacheGeneration })
        : null;
    const source = cached?.rounds || loaded.rounds;
    return {
        *[Symbol.iterator](): Iterator<TextBlock> {
            for (const round of source) {
                yield {
                    id: String(round.roundIndex),
                    title: `轮次 ${round.roundIndex}`,
                    content: buildSearchBlockContent(round).slice(0, 8_000),
                    tags: [],
                };
            }
        },
    };
}

async function searchLoadedConversationRanked(
    loaded: LoadedConversationData,
    query: string,
    mode: "fuzzy" | "smart",
    limit: number | undefined,
    modelChain: Chain,
): Promise<SearchResult[]> {
    const { search: engineSearch } = await import("../search-engine.js");
    const maxResults = Math.max(1, limit || 20);
    const results = new Map<string, SearchResult>();
    let blocks: TextBlock[] = [];
    let blockChars = 0;
    const flush = async (): Promise<void> => {
        if (blocks.length === 0) return;
        const chunkResults = await engineSearch(blocks, query, {
            mode,
            limit: maxResults,
            dataChain: loaded.chainUsed,
            modelChain,
        });
        for (const result of chunkResults) {
            const previous = results.get(result.id);
            if (!previous || result.score > previous.score) results.set(result.id, result);
        }
        blocks = [];
        blockChars = 0;
    };
    for (const block of iterateLoadedConversationSearchBlocks(loaded)) {
        if (blocks.length >= 128 || blockChars + block.content.length > 512_000) await flush();
        blocks.push(block);
        blockChars += block.content.length;
    }
    await flush();
    return [...results.values()].sort((left, right) => right.score - left.score).slice(0, maxResults);
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

function pushConversationReadRoundOutput(
    output: string[],
    text: string,
    state: { chars: number; truncated: boolean },
    sourcePositions: ConversationReadSourcePosition[],
    round: ConversationRound,
): boolean {
    const charPosition = output.length === 0 ? 0 : state.chars;
    const pushed = pushOutputWithBuildBudget(output, text, state, "read 输出");
    if (pushed) {
        sourcePositions.push({
            charPosition,
            roundIndex: round.roundIndex,
            stepIndex: round.startStep,
        });
    }
    return pushed;
}

function buildSearchBlockContent(round: ConversationRound): string {
    return [
        round.userMessage,
        ...round.aiResponses.map(item => item.response),
    ].filter(Boolean).join("\n");
}

function formatConversationSearchDelivery(text: string, roundIndices: number[]): string {
    if (text.length <= CONVERSATION_READ_DELIVERY_MAX_CHARS) return text;
    const uniqueRounds = [...new Set(roundIndices)].sort((left, right) => left - right);
    const hint = uniqueRounds.length > 0
        ? `请用 read(startRound=${uniqueRounds[0]}, endRound=${uniqueRounds[uniqueRounds.length - 1]}) 从 fetch 缓存分段读取命中轮次。`
        : "请用 read(startRound,endRound) 从 fetch 缓存分段读取命中范围。";
    const omittedNote = `\n\n⚠️ 搜索结果超过单次约 ${CONVERSATION_READ_DELIVERY_MAX_CHARS} 字交付预算；完整内容仍保留在 fetch 缓存。${hint}\n\n`;
    const available = Math.max(2, CONVERSATION_READ_DELIVERY_MAX_CHARS - omittedNote.length);
    const headEnd = findConversationReadChunkEnd(text, 0, Math.floor(available * 0.8));
    let tailStart = Math.max(headEnd, text.length - (available - headEnd));
    if (!isConversationReadCodePointBoundary(text, tailStart)) tailStart += 1;
    return `${text.slice(0, headEnd)}${omittedNote}${text.slice(tailStart)}`;
}

function truncateAnnotationSearchField(text: string, maxCodePoints: number): string {
    const codePoints = Array.from(text);
    return codePoints.length <= maxCodePoints
        ? text
        : `${codePoints.slice(0, maxCodePoints).join("")}…`;
}

function formatAnnotationSearchMatch(match: ReturnType<typeof searchInRounds>[number]): string {
    const field = match.annotationField === "comment" ? "用户评论" : "被批注文本";
    const selectedText = truncateAnnotationSearchField(match.annotationSelectedText || "", 1_200);
    const comment = truncateAnnotationSearchField(match.annotationComment || "", 1_200);
    return [
        `## 轮次 ${match.roundIndex} · Annotation ${match.annotationIndex || 1}`,
        `- 命中字段: ${field}`,
        `- 命中片段: ${match.matchText}`,
        `- 被批注文本: ${selectedText}`,
        `- 用户评论: ${comment}`,
    ].join("\n");
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

registerBackgroundTaskRecoveryHandler("conversation-fetch", async task => {
    if (!isCodexFetchWorkerPayload(task.resumePayload)) {
        throw new Error("conversation-fetch 缺少可恢复的 Codex fetch payload");
    }
    const payload = task.resumePayload;
    return {
        mode: "restart",
        run: context => runCodexFetchBackgroundTask(payload, context),
        timeoutMessage: "Codex 巨型对话 fetch 后台任务超时；缓存未完成发布时仍保留上一份完整可用缓存",
    };
});

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
 * 六类操作：
 *   list   — 按标题/路径/ID/Record/contextProbe 列出候选对话
 *   fetch  — 拉取对话数据到缓存并返回概览
 *   search — 在对话中关键词搜索
 *   read   — 读取指定轮次范围的对话内容
 *   recall — 从最新 fetch 缓存恢复压缩前的 context-only 上下文
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
  recall — 自动、按轮次或全量恢复 context-only 上下文
  export — 将可读对话原文持久化导出为 Markdown / PDF
  deep_locate — Codex/Claude Code 后台深搜正文片段以定位 conversationId
fetch/search/read/recall/export 必须传 conversationId（共享 broker 后端拦截所有无 ID 调用，含 antigravity——跨 session 共享后端无法安全推断「当前对话」）。先用 action="list" 定位 ID。`,
        {
            action: z.enum(["list", "fetch", "search", "read", "recall", "export", "deep_locate", "deep_locate_status", "deep_locate_cancel"]).default("search")
                .describe("操作模式：list=列出候选 / fetch=拉取缓存 / search=关键词搜索 / read=范围阅读 / recall=恢复压缩上下文 / export=导出 Markdown/PDF / deep_locate=后台深搜定位对话"),
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
                .describe("[deep_locate] 最大扫描字节数；[read] 单段交付字节上限，会覆盖默认约 100K 字符预算"),
            maxHits: z.number().optional()
                .describe("[deep_locate] 最大命中数"),
            startRound: z.number().optional()
                .describe("[read/recall manual] 起始轮次（1-indexed）"),
            endRound: z.number().optional()
                .describe("[read/recall manual] 结束轮次"),
            recallMode: z.enum(["auto", "manual", "full"]).optional()
                .describe("[recall] auto=按宿主压缩信号恢复 / manual=按 startRound/endRound / full=全部 context-only 内容写临时文件"),
            continuationCursor: z.string().optional()
                .describe("[read] 上一段返回的续读光标；来源或参数变化时会拒绝，避免重复或串读"),
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
            messageRoles: z.array(z.enum(["user", "system", "model", "assistant", "tool", "subagent"])).optional()
                .describe("[read/export] 按消息角色选择性读取或导出。user=真实人类输入，system=规则/压缩/系统注入，model/assistant=模型回复，tool=工具/代码/任务事件，subagent=挂在父轮的子代理摘要"),
            chain: z.enum(CHAIN_COMPAT_INPUT_VALUES).default(DEFAULT_CHAIN)
                .describe("兼容旧参数：dataChain/modelChain 未填时沿用此链路；chain=\"windsurf\" 只作为 dataChain，chain=\"grok\"/\"agy\" 只作为 modelChain"),
            dataChain: dataChainInputSchema("dataChain", "读取对话数据的宿主链路；未填用 chain。agy 与 Grok 只支持 modelChain"),
            source: z.enum(["auto", "local", "ls", "cache"]).default("auto")
                .describe("fetch/read/search/export 原文来源：auto=本地一等来源并按需比较 LS；local=只读 JSONL/PB；ls=仅 Windsurf/Antigravity；cache=只读已发布 fetch 缓存"),
            dataChains: z.array(dataChainValueSchema("dataChains")).optional()
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
            parentDataChain: dataChainInputSchema("parentDataChain", "预留：父线程定位的数据源；当前主要用于 Codex 子线程过滤。agy 与 Grok 只支持 modelChain"),
            modelChain: modelChainInputSchema("modelChain", "smart 搜索调用模型的链路；未填用 chain；agy=本地 agy CLI（三模型内部 fallback），Grok=本机 progrok proxy。Windsurf 只支持 dataChain"),
            link: z.enum(["reference", "summary", "expand_children"]).default(DEFAULT_LINK_MODE)
                .describe("Codex 链路下对子代理线程的呈现方式"),
            logicalChain: z.enum(["off", "explain", "auto", "strict"]).optional()
                .describe("Claude Code 链路：off=默认只读指定物理 ID；explain=只展示可能续聊候选；auto/strict=强证据时合并为逻辑对话"),
        },
        async (params) => {
            touchActivity({ skipRecordAutoCheck: true });
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
                    recallMode = "auto",
                    continuationCursor,
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
                    source = "auto",
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
                    if (source === "local" && (chains.dataChain === "auto" || chains.dataChain === "antigravity" || chains.dataChain === "windsurf")) {
                        const hosts = chains.dataChain === "auto"
                            ? (["antigravity", "windsurf"] as const)
                            : ([chains.dataChain] as Array<"antigravity" | "windsurf">);
                        const localCandidates = hosts.flatMap(host => listLocalPbConversationCandidates(host, { limit: candidateLimitForLocalList(limit), query })
                            .map(candidate => ({ host, ...candidate })));
                        localCandidates.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
                        const selected = localCandidates.slice(0, Math.min(Math.max(limit || 20, 1), 100));
                        const lines = [
                            "🔎 本地 PB 对话目录（仅元数据，未解密正文）",
                            `候选对话: ${selected.length}${query ? ` | 关键词: ${query}` : ""}`,
                            "说明: active/cascade 与 implicit 同 ID 已合并；implicit 仅表示本机仍存在的隐藏/归档候选。",
                            "",
                            ...selected.map((item, index) => [
                                `${index + 1}. [${item.host}] ${item.id}`,
                                `   ID: ${item.id}`,
                                `   位置: ${item.kinds.join("+")} | 更新时间: ${item.updatedAt} | ${formatBytes(item.bytes)}${item.files > 1 ? ` | ${item.files} 个候选文件` : ""}`,
                            ].join("\n")),
                        ];
                        return appendTiming({ content: [{ type: "text" as const, text: lines.join("\n") }] }, startTime);
                    }
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

                if (action === "fetch" && conversationId && source !== "ls") {
                    const resolvedFetchChain = await resolveConversationChain(chains.dataChain);
                    const estimate = resolvedFetchChain === "codex"
                        ? estimateCodexFetchWork(conversationId)
                        : null;
                    if (estimate?.shouldBackground && background === false) {
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: [
                                    "❌ 该 Codex 对话不允许以前台同步方式执行 fetch",
                                    `源文件大小: ${(estimate.sourceSize / (1024 * 1024)).toFixed(1)} MiB`,
                                    `自动后台阈值: ${(estimate.thresholdBytes / (1024 * 1024)).toFixed(1)} MiB`,
                                    "原因：同步读取会阻塞 Memory Store 控制链路，并可能先触发 broker -32001 超时。请省略 background 或设为 true。",
                                ].join("\n"),
                            }],
                        }, startTime);
                    }
                    if (estimate && (background === true || estimate.shouldBackground)) {
                        const payload = createCodexFetchWorkerPayload({
                            conversationId,
                            link,
                            source: source as CodexFetchWorkerPayload["source"],
                            estimate,
                            modelChain: chains.modelChain,
                        });
                        const stableTaskId = selectCodexFetchTaskId(payload);
                        const task = startBackgroundTask(
                            "conversation-fetch",
                            taskContext => runCodexFetchBackgroundTask(payload, taskContext),
                            {
                                taskId: stableTaskId,
                                resumePayload: payload as unknown as ResumePayloadValue,
                                timeoutMessage: "Codex 巨型对话 fetch 后台任务超时；缓存未完成发布时仍保留上一份完整可用缓存",
                            },
                        );
                        if (task.status === "done" && task.result) {
                            return appendTiming({
                                content: [{ type: "text" as const, text: task.result }],
                            }, startTime);
                        }
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: [
                                    estimate.shouldBackground
                                        ? "🚀 巨型 Codex 对话 fetch 已自动转入独立后台进程"
                                        : "🚀 Codex 对话 fetch 已按 background=true 转入独立后台进程",
                                    `🆔 taskId: ${task.id}`,
                                    `📦 源文件: ${(estimate.sourceSize / (1024 * 1024)).toFixed(1)} MiB | 自动后台阈值 ${(estimate.thresholdBytes / (1024 * 1024)).toFixed(1)} MiB`,
                                    `📍 当前状态: ${task.status}${task.progress?.detail ? ` | ${task.progress.detail}` : ""}`,
                                    "💡 使用 background_task_status(taskId=\"...\", waitSeconds=30-45) 查询；取消时使用 background_task_cancel(taskId=\"...\")。",
                                    "♻️ 相同源版本、link/source 与 1 小时临时文件窗口会复用同一稳定 taskId；进程热重启后也从该 ID 恢复。",
                                ].join("\n"),
                            }],
                        }, startTime);
                    }
                }

                const loaded = await loadConversationData(chains.dataChain, conversationId, {
                    refresh: action === "fetch" || action === "recall",
                    link,
                    dataChains: dataChains as DataChain[] | undefined,
                    idResolutionMode: idResolutionMode as IdResolutionMode,
                    sourceFailureMode: sourceFailureMode as SourceFailureMode,
                    logicalChain: logicalChain as ConversationLogicalChainMode | undefined,
                    source,
                    includeRounds: action === "recall"
                        ? false
                        : action === "export"
                            && (exportScope === "search" || (!exportScope && Boolean(query))),
                    requireCompactionMetadata: action === "recall",
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

                if (action === "recall") {
                    if (!loaded.cacheKey || !loaded.cacheGeneration || !loaded.compactionMetadata) {
                        return appendTiming({
                            content: [{ type: "text" as const, text: "❌ Recall 需要已完整发布且带压缩元数据的 fetch cache generation" }],
                        }, startTime);
                    }
                    if (sourceFailureMode === "fail" && loaded.cacheState === "stale") {
                        const failure = loaded.cacheBuildFailure;
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: `❌ Recall 刷新失败，sourceFailureMode=fail 禁止使用旧缓存${failure ? `：${failure.name}: ${failure.message}` : ""}`,
                            }],
                        }, startTime);
                    }
                    const selection = selectConversationRecallRange(
                        loaded.compactionMetadata,
                        recallMode as ConversationRecallMode,
                        startRound,
                        endRound,
                    );
                    if (!selection) {
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: [
                                    "ℹ️ 当前 fetch cache generation 未检测到可回溯的压缩事件",
                                    `📂 对话: ${cascadeId}`,
                                    `🔗 数据链路: ${loaded.chainUsed}`,
                                    `📌 cacheGeneration: ${loaded.cacheGeneration}`,
                                    `🕒 缓存截至: ${loaded.cacheCreatedAt || "(unknown)"} | isLatest=${loaded.cacheState !== "stale"}`,
                                ].join("\n"),
                            }],
                        }, startTime);
                    }
                    if (selection.selectedContextChars <= 0) {
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: [
                                    "ℹ️ 检测到压缩边界，但压缩后当前可见上下文已经达到压缩前规模的约 60%，无需额外注入",
                                    `📂 对话: ${cascadeId}`,
                                    `📌 cacheGeneration: ${loaded.cacheGeneration}`,
                                    `🎯 ${selection.reason}`,
                                ].join("\n"),
                            }],
                        }, startTime);
                    }
                    const artifactForSelection = async (): Promise<ConversationRecallArtifact> => writeConversationRecallArtifact({
                        conversationId: cascadeId,
                        dataChain: loaded.chainUsed,
                        cacheGeneration: loaded.cacheGeneration!,
                        selection,
                        rounds: iterateConversationRecallRounds(loaded, selection.startRound, selection.endRound),
                    });
                    if (recallMode === "full") {
                        const artifact = await artifactForSelection();
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: [
                                    "🧠 Conversation Recall（full / context-only）",
                                    `📂 对话: ${cascadeId}`,
                                    `🔗 数据链路: ${loaded.chainUsed}`,
                                    `📌 cacheGeneration: ${loaded.cacheGeneration}`,
                                    `🕒 缓存截至: ${loaded.cacheCreatedAt || "(unknown)"} | isLatest=${loaded.cacheState !== "stale"}`,
                                    ...(loaded.cacheBuildFailure ? [`⚠️ 刷新失败: ${loaded.cacheBuildFailure.name}: ${loaded.cacheBuildFailure.message}`] : []),
                                    "",
                                    formatRecallArtifactNote(artifact),
                                ].join("\n"),
                            }],
                        }, startTime);
                    }

                    let built = buildConversationRecallText(loaded, selection);
                    const exceedsDefault = maxBytes === undefined
                        ? built.text.length > CONVERSATION_READ_DELIVERY_MAX_CHARS
                        : Buffer.byteLength(built.text, "utf8") + 1_024 > maxBytes;
                    if (exceedsDefault) {
                        const artifact = await artifactForSelection();
                        built = buildConversationRecallText(loaded, selection, artifact);
                    }
                    const nextParams = {
                        action: "recall",
                        conversationId: cascadeId,
                        dataChain: loaded.chainUsed,
                        recallMode,
                        source,
                        sourceFailureMode,
                        ...(recallMode === "manual" ? { startRound: selection.startRound, endRound: selection.endRound } : {}),
                        ...(maxBytes !== undefined ? { maxBytes } : {}),
                        link,
                    };
                    const { text } = formatPaginatedConversationReadText({
                        conversationId: cascadeId,
                        text: built.text,
                        sourcePositions: built.sourcePositions,
                        continuationCursor,
                        maxBytes,
                        nextParams,
                    });
                    return appendTiming({ content: [{ type: "text" as const, text }] }, startTime);
                }

                if (action === "export") {
                    const partialWarning = formatWindsurfPartialWarning(loaded);
                    const result = await exportConversation({
                        conversationId: cascadeId,
                        chainUsed: loaded.chainUsed,
                        rounds,
                        totalSteps,
                        cacheKey: loaded.cacheKey,
                        cacheGeneration: loaded.cacheGeneration,
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
                    const artifact = await measureConversationReadSegment(
                        fetchTiming,
                        "格式化",
                        () => writeFetchedConversationArtifact(loaded, expandedChildren, childDiagnostics),
                    );
                    const tempPath = artifact.tempPath;
                    const attachmentOverview = artifact.attachmentCount > 0
                        ? `📎 附件引用: ${artifact.attachmentCount} 个（详细关系已写入 fetch 文件）`
                        : "";
                    const overview = formatLoadedOverview(loaded, artifact);
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

                    const workspace = loaded.codexData?.thread.cwd
                        || loaded.claudeCodeData?.thread.cwd
                        || loaded.windsurfData?.thread.cwd;
                    const recordNote = await scheduleFetchRecordAutoUpdate({
                        conversationId: cascadeId,
                        chainUsed: loaded.chainUsed,
                        modelChain: chains.modelChain,
                        artifact,
                        totalSteps,
                        ...(workspace ? { workspace } : {}),
                        partial: Boolean(loaded.windsurfData?.partial),
                        subagent: isLoadedSubagentThread(loaded),
                        cacheKey: loaded.cacheKey,
                        cacheGeneration: loaded.cacheGeneration,
                        cacheFingerprint: loaded.cacheFingerprint,
                        cacheState: loaded.cacheState,
                        cacheBuildFailure: loaded.cacheBuildFailure,
                        sourceMode: loaded.sourceMode,
                    });

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
                        ? searchLoadedConversationExact(loaded, query, limit)
                        : [];
                    const searchHeader = formatConversationSearchHeader(cascadeId, loaded);
                    if (matches.length === 0 && mode === "exact") {
                        return appendTiming({
                                    content: [{ type: "text" as const, text: `${searchHeader}\n🔍 搜索 "${query}" — exact 模式未找到匹配` }],
                        }, startTime);
                    }
                    if (matches.length === 0) {
                        const requestedMode = mode as "auto" | "exact" | "fuzzy" | "smart";
                        let fuzzyResults = requestedMode === "smart"
                            ? []
                            : await searchLoadedConversationRanked(loaded, query, "fuzzy", limit, chains.modelChain);
                        if (fuzzyResults.length === 0 && (requestedMode === "auto" || requestedMode === "smart")) {
                            const smartResults = await searchLoadedConversationRanked(loaded, query, "smart", limit, chains.modelChain);
                            if (smartResults.length === 0) {
                                return appendTiming({
                                    content: [{ type: "text" as const, text: `${searchHeader}\n🔍 搜索 "${query}" — 未找到匹配` }],
                                }, startTime);
                            }
                            const smartRoundIndices = smartResults.map(r => Number(r.id));
                            const output: string[] = [`🔍 搜索 "${query}" — smart 模式命中 ${smartResults.length} 轮\n`];
                            const selectedRounds = loadConversationRoundsByIndex(loaded, smartRoundIndices);
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
                            let text = formatConversationSearchDelivery(output.join("\n"), smartRoundIndices);
                            text = appendConversationReadDetail(text, formatConversationReadSegmentTiming(searchTiming));
                            return appendTiming({
                                content: [{ type: "text" as const, text: `${formatConversationSearchHeader(cascadeId, loaded, chains.modelChain)}\n\n${text}` }],
                            }, startTime);
                        }
                        // 将 fuzzy 结果转换回轮次索引
                        const fuzzyRoundIndices = fuzzyResults.map(r => Number(r.id));
                        const output: string[] = [`🔍 搜索 "${query}" — fuzzy 模式命中 ${fuzzyResults.length} 轮\n`];
                        const selectedRounds = loadConversationRoundsByIndex(loaded, fuzzyRoundIndices);
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
                        let text = formatConversationSearchDelivery(output.join("\n"), fuzzyRoundIndices);
                        text = appendConversationReadDetail(text, formatConversationReadSegmentTiming(searchTiming));
                        return appendTiming({
                            content: [{ type: "text" as const, text: `${searchHeader}\n\n${text}` }],
                        }, startTime);
                    }

                    const output: string[] = [];
                    output.push(`🔍 搜索 "${query}" — 命中 ${matches.length} 处\n`);

                    const annotationMatches = matches.filter(match => match.matchType === "annotation");
                    const roundMatches = matches.filter(match => match.matchType !== "annotation");
                    for (const match of annotationMatches) {
                        output.push(formatAnnotationSearchMatch(match));
                        output.push("");
                    }

                    // 收集需要展示的轮次（去重 + 上下文）
                    const roundsToShow = new Set<number>();
                    const totalRoundCount = loaded.roundCount ?? rounds.length;
                    for (const m of roundMatches) {
                        const ctx = contextRounds ?? 1;
                        for (let r = Math.max(1, m.roundIndex - ctx); r <= Math.min(totalRoundCount, m.roundIndex + ctx); r++) {
                            roundsToShow.add(r);
                        }
                    }

                    const sortedRounds = [...roundsToShow].sort((a, b) => a - b);
                    const selectedRounds = loadConversationRoundsByIndex(loaded, sortedRounds);
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

                    const matchedRoundIndices = matches.map(match => match.roundIndex);
                    let text = formatConversationSearchDelivery(output.join("\n"), matchedRoundIndices);
                    text = appendConversationReadDetail(text, formatConversationReadSegmentTiming(searchTiming));

                    return appendTiming({
                        content: [{ type: "text" as const, text: `${searchHeader}\n\n${text}` }],
                    }, startTime);
                }

                // === read 模式 ===
                if (action === "read") {
                    const readTiming = createConversationReadTimingState("read");
                    const totalRoundCount = loaded.roundCount ?? rounds.length;
                    const start = startRound || 1;
                    const end = endRound || totalRoundCount;
                    const incompleteWindsurfWarning = formatWindsurfIncompleteReadWarning(loaded);
                    if (incompleteWindsurfWarning) {
                        const output = [
                            formatLoadedOverview(loaded),
                            `🔗 数据链路: ${loaded.chainUsed}`,
                            windsurfSourceDiagnostics,
                            incompleteWindsurfWarning,
                        ].filter(Boolean).join("\n");
                        return appendTiming({
                            content: [{ type: "text" as const, text: appendConversationReadDetail(output, formatConversationReadSegmentTiming(readTiming)) }],
                        }, startTime);
                    }

                    if (start > totalRoundCount) {
                        return appendTiming({
                            content: [{ type: "text" as const, text: `❌ startRound ${start} 超出范围（共 ${totalRoundCount} 轮）` }],
                        }, startTime);
                    }
                    const roundWindow = loadConversationRoundWindow(loaded, start, end);
                    if (roundWindow.rounds.length === 0) {
                        return appendTiming({
                            content: [{ type: "text" as const, text: `❌ 无法从 fetch 缓存读取第 ${start}-${Math.min(end, totalRoundCount)} 轮` }],
                        }, startTime);
                    }

                    const output: string[] = [];
                    const buildState = { chars: 0, truncated: false };
                    const overview = formatLoadedOverview(loaded);
                    pushOutputWithBuildBudget(output, overview, buildState, "read 输出");
                    pushOutputWithBuildBudget(output, `🔗 数据链路: ${loaded.chainUsed}`, buildState, "read 输出");
                    const subagentNote = formatSubagentSourceNote(loaded);
                    if (subagentNote) pushOutputWithBuildBudget(output, subagentNote, buildState, "read 输出");
                    const logicalChainNote = formatClaudeCodeLogicalChainNote(loaded);
                    if (logicalChainNote) pushOutputWithBuildBudget(output, logicalChainNote, buildState, "read 输出");
                    const roleFilter = normalizeMessageRoles(messageRoles as ConversationMessageRole[] | undefined);
                    pushOutputWithBuildBudget(output, `📖 读取轮次 ${start}-${roundWindow.endRound}${roleFilter.size ? ` | 角色过滤: ${[...roleFilter].join(", ")}` : ""}\n`, buildState, "read 输出");
                    if (windsurfSourceDiagnostics) {
                        pushOutputWithBuildBudget(output, windsurfSourceDiagnostics, buildState, "read 输出");
                        pushOutputWithBuildBudget(output, "", buildState, "read 输出");
                    }

                    const selectedRounds = roundWindow.rounds;
                    const sourcePositions: ConversationReadSourcePosition[] = [{
                        charPosition: 0,
                        roundIndex: selectedRounds[0]?.roundIndex || start,
                        stepIndex: selectedRounds[0]?.startStep || 0,
                    }];
                    const attachmentDeadlineAt = Date.now() + getReadAttachmentBudgetMs();
                    const { rounds: displayRounds, truncated, budgetExceeded: attachmentBudgetExceeded } = await measureConversationReadSegment(
                        readTiming,
                        "附件物化",
                        () => materializeRoundAttachmentsWithOptionalBudget(selectedRounds, cascadeId, { deadlineAt: attachmentDeadlineAt }),
                    );
                    const formatDeadlineAt = Date.now() + getReadFormatBudgetMs();
                    let formatBudgetExceeded = false;
                    await measureConversationReadSegment(readTiming, "格式化", async () => {
                        for (let index = 0; index < displayRounds.length; index++) {
                            const round = displayRounds[index];
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
                            if (!pushConversationReadRoundOutput(output, formatted.text, buildState, sourcePositions, round)) break;
                            if (!pushOutputWithBuildBudget(output, "", buildState, "read 输出")) break;
                            if (formatted.budgetExceeded) break;
                            await yieldConversationFormatIfNeeded(index + 1);
                        }
                    });
                    if (truncated > 0) output.push(`⚠️ ${truncated} 个附件超过单次生成上限，未生成临时文件\n`);
                    if (attachmentBudgetExceeded || formatBudgetExceeded) {
                        output.push("⚠️ 本次 read 在预算内先返回了部分结果；请缩小轮次范围后重试（例如减小 endRound-startRound）。\n");
                    }
                    if (roundWindow.hasMore) {
                        pushOutputWithBuildBudget(
                            output,
                            `➡️ 本次按 ${CONVERSATION_READ_WINDOW_MAX_CHARS} 字缓存窗口读取到第 ${roundWindow.endRound} 轮；下一段请使用 startRound=${roundWindow.endRound + 1}${end < totalRoundCount ? `, endRound=${end}` : ""}。`,
                            buildState,
                            "read 输出",
                        );
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
                                if (!pushConversationReadRoundOutput(output, formatted.text, buildState, sourcePositions, round)) break;
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

                    if (buildState.truncated) {
                        return appendTiming({
                            content: [{
                                type: "text" as const,
                                text: `❌ read 源内容超过明确构建安全上限 ${CONVERSATION_READ_TEXT_BUILD_MAX_CHARS} 字，未返回不完整前缀；请缩小 startRound/endRound 范围后重试。`,
                            }],
                        }, startTime);
                    }
                    const { text } = formatPaginatedConversationReadText({
                        conversationId: cascadeId,
                        text: output.join("\n"),
                        sourcePositions,
                        continuationCursor,
                        maxBytes,
                        detail: formatConversationReadSegmentTiming(readTiming),
                        nextParams: {
                            action: "read",
                            conversationId: cascadeId,
                            dataChain: loaded.chainUsed,
                            depth,
                            compactionMode: effectiveCompactionMode,
                            startRound: start,
                            endRound: end,
                            ...(extraTypes.length ? { extraTypes } : {}),
                            ...(messageRoles?.length ? { messageRoles } : {}),
                            ...(maxBytes !== undefined ? { maxBytes } : {}),
                            link,
                        },
                        ...(roundWindow.hasMore ? {
                            terminalNextParams: {
                                action: "read",
                                conversationId: cascadeId,
                                dataChain: loaded.chainUsed,
                                depth,
                                compactionMode: effectiveCompactionMode,
                                startRound: roundWindow.endRound + 1,
                                endRound: end,
                                ...(extraTypes.length ? { extraTypes } : {}),
                                ...(messageRoles?.length ? { messageRoles } : {}),
                                ...(maxBytes !== undefined ? { maxBytes } : {}),
                                link,
                            },
                        } : {}),
                    });

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
