import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { touchActivity, appendTiming } from "../lifecycle.js";
import { saveTempFile } from "../temp-store.js";
import {
    formatRound,
    formatOverview,
    searchInRounds,
    type Depth,
    type ExtraType,
    type ConversationRound,
} from "../trajectory.js";
import { shouldAutoUpdateRecord } from "../record-generator.js";
import { generateRecord, countPhasesInRecord } from "../record-generator.js";
import { readRecord, writeRecord, resolveWorkspaceHashForRecord, findRecordHash, writeRecordSidecar } from "../record-store.js";
import { loadConversationData, resolveConversationChain } from "../conversation-bridge.js";
import { CHAIN_INPUT_VALUES, DEFAULT_CHAIN, DEFAULT_LINK_MODE, resolveChainSplit } from "../chain.js";
import { listConversationsByMtime } from "../ls-client.js";
import {
    deepLocateCodexConversations,
    findCodexContextProbeMatches,
    getCodexThread,
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
import type { SearchMode, TextBlock } from "../search-engine.js";
import { buildRecordReaderIndex } from "../record-reader.js";
import { formatAttachmentOverview, materializeRoundAttachments } from "../conversation-attachments.js";
import { cancelBackgroundTask, formatBackgroundTask, startBackgroundTask, waitForBackgroundTask } from "../background-tasks.js";

const CONVERSATION_FETCH_TEXT_MAX_CHARS = Number(process.env.MEMORY_STORE_CONVERSATION_FETCH_TEXT_MAX_CHARS || 2_000_000);
const CONVERSATION_READ_TEXT_BUILD_MAX_CHARS = Number(process.env.MEMORY_STORE_CONVERSATION_READ_TEXT_BUILD_MAX_CHARS || 2_000_000);
const CONVERSATION_SEARCH_BLOCK_MAX_CHARS = Number(process.env.MEMORY_STORE_CONVERSATION_SEARCH_BLOCK_MAX_CHARS || 60_000);

function normalizeListQuery(input: string): string {
    return input
        .toLowerCase()
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}]+/gu, "");
}

export interface ConversationListCandidate {
    id: string;
    title: string;
    workspace: string;
    updatedAt: string;
    detail: string;
    contextProbe?: string[];
}

function buildConversationListLines(
    resolved: "antigravity" | "codex" | "claude-code",
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
            const title = item.title || "(无标题)";
            const ws = item.workspace ? `\n   工作区: ${item.workspace}` : "";
            const detail = item.detail ? ` | ${item.detail}` : "";
            const probe = item.contextProbe?.length
                ? `\n   🎯 contextProbe: ${item.contextProbe.join("；")}`
                : "";
            return `${idx + 1}. ${title}\n   ID: ${item.id}\n   更新时间: ${item.updatedAt || "(未知)"}${detail}${ws}${probe}`;
        }),
    ];
}

function candidateFromCodexThread(item: CodexThreadInfo): ConversationListCandidate {
    return {
        id: item.id,
        title: item.title || "",
        workspace: item.cwd || "",
        updatedAt: item.updatedAtMs ? new Date(item.updatedAtMs).toISOString() : "",
        detail: [
            item.agentRole ? `agent=${item.agentRole}` : "",
            item.model,
            item.reasoningEffort,
        ].filter(Boolean).join(" / "),
    };
}

function candidateFromClaudeCodeThread(item: ClaudeCodeThreadInfo): ConversationListCandidate {
    return {
        id: item.id,
        title: item.title || "",
        workspace: item.cwd || "",
        updatedAt: item.updatedAtMs ? new Date(item.updatedAtMs).toISOString() : "",
        detail: [
            "claude-code",
            item.model,
            item.entrypoint,
            item.lastPrompt ? `lastPrompt=${item.lastPrompt.slice(0, 40)}` : "",
        ].filter(Boolean).join(" / "),
    };
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

function listQueryPriority(item: ConversationListCandidate, normalizedQuery: string): number {
    if (!normalizedQuery) return 9;
    const id = normalizeListQuery(item.id);
    const title = normalizeListQuery(item.title || "");
    const workspace = normalizeListQuery(item.workspace || "");
    if (id === normalizedQuery) return 0;
    if (normalizedQuery.length >= 8 && id.startsWith(normalizedQuery)) return 1;
    if (title === normalizedQuery) return 2;
    if (title.includes(normalizedQuery)) return 3;
    if (workspace.includes(normalizedQuery)) return 4;
    return 9;
}

export function sortListMatchesByQuery(items: ConversationListCandidate[], normalizedQuery: string): ConversationListCandidate[] {
    return [...items].sort((a, b) => {
        const priority = listQueryPriority(a, normalizedQuery) - listQueryPriority(b, normalizedQuery);
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
    resolved: "antigravity" | "codex" | "claude-code",
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
    resolved: "antigravity" | "codex" | "claude-code",
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
        const hash = findRecordHash(item.id);
        const recordPreview = hash ? (readRecord(hash, item.id) || "").slice(0, 2500) : "";
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

function buildConversationText(
    conversationId: string,
    rounds: ConversationRound[],
    totalSteps: number,
    depth: Depth,
    extraTypes: ExtraType[] = [],
    expandedChildren: Array<{ thread: { id: string; title: string }; rounds: ConversationRound[] }> = [],
    childDiagnostics: Array<{ threadId: string; nickname?: string; reason: string; detail: string }> = [],
): string {
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

    for (const round of rounds) {
        if (!pushLine(formatRound(round, depth, extraTypes))) break;
        if (!pushLine("")) break;
    }

    if (!truncated && expandedChildren.length > 0) {
        pushLine("# 子代理线程展开");
        pushLine("");
        for (const child of expandedChildren) {
            if (!pushLine(`## 子线程 ${child.thread.id.slice(0, 8)}... ${child.thread.title ? `| ${child.thread.title}` : ""}`)) break;
            if (!pushLine("")) break;
            for (const round of child.rounds) {
                if (!pushLine(formatRound(round, depth, extraTypes))) break;
                if (!pushLine("")) break;
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

/**
 * conversation_read_original — 读取对话原文
 *
 * 五类操作：
 *   list   — 按标题/路径/ID/Record/contextProbe 列出候选对话
 *   fetch  — 拉取对话数据到缓存并返回概览
 *   search — 在对话中关键词搜索
 *   read   — 读取指定轮次范围的对话内容
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
  deep_locate — Codex/Claude Code 后台深搜正文片段以定位 conversationId
不填 conversationId 默认读取当前对话。`,
        {
            action: z.enum(["list", "fetch", "search", "read", "deep_locate", "deep_locate_status", "deep_locate_cancel"]).default("search")
                .describe("操作模式：list=列出候选 / fetch=拉取缓存 / search=关键词搜索 / read=范围阅读 / deep_locate=后台深搜定位对话"),
            conversationId: z.string().optional()
                .describe("对话 UUID（不填默认当前对话）"),
            conversationIds: z.array(z.string()).optional()
                .describe("deep_locate 可选：限制只扫描这些 Codex conversationId"),
            query: z.string().optional()
                .describe("list/search 模式：搜索关键词"),
            contextProbe: z.string().optional()
                .describe("Codex/Claude Code list 模式：从当前可见对话截取的 50-120 字上下文指纹，用 fixed-string 语义的硬匹配标记候选；不会自动选中"),
            depth: z.enum(["brief", "normal", "full"]).default("normal")
                .describe("返回详细度：brief=截断100字 / normal=完整文本 / full=含思考+工具结果"),
            mode: z.enum(["auto", "exact", "fuzzy", "smart"]).optional()
                .describe("list/search 模式：auto/exact/fuzzy/smart，默认 auto"),
            contextRounds: z.number().default(2).optional()
                .describe("search 模式：匹配位置前后显示多少轮对话"),
            limit: z.number().default(8).optional()
                .describe("search 模式：最多返回多少个匹配"),
            background: z.boolean().optional()
                .describe("deep_locate 必须使用后台模式；true=返回 taskId 后轮询"),
            taskId: z.string().optional()
                .describe("deep_locate_status / deep_locate_cancel 的后台任务 ID"),
            waitSeconds: z.number().optional()
                .describe("deep_locate_status 等待秒数，建议 30-45"),
            maxFiles: z.number().optional()
                .describe("deep_locate 最大扫描文件数"),
            maxBytes: z.number().optional()
                .describe("deep_locate 最大扫描字节数"),
            maxHits: z.number().optional()
                .describe("deep_locate 最大命中数"),
            startRound: z.number().optional()
                .describe("read 模式：起始轮次（1-indexed）"),
            endRound: z.number().optional()
                .describe("read 模式：结束轮次"),
            extraTypes: z.array(z.enum(["thinking", "tool_results", "code_actions", "code_diffs", "file_views"])).optional()
                .describe("额外拉取的内容类型"),
            chain: z.enum(CHAIN_INPUT_VALUES).default(DEFAULT_CHAIN)
                .describe("兼容旧参数：dataChain/modelChain 未填时沿用此链路，默认 auto"),
            dataChain: z.enum(CHAIN_INPUT_VALUES).optional()
                .describe("读取对话数据的宿主链路；未填用 chain。支持 antigravity/codex/claude-code"),
            modelChain: z.enum(CHAIN_INPUT_VALUES).optional()
                .describe("smart 搜索调用模型的链路；未填用 chain"),
            link: z.enum(["reference", "summary", "expand_children"]).default(DEFAULT_LINK_MODE)
                .describe("Codex 链路下对子代理线程的呈现方式"),
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
                    mode = "auto",
                    contextRounds = 2,
                    limit = 8,
                    startRound,
                    endRound,
                    extraTypes = [],
                    background,
                    taskId,
                    waitSeconds,
                    maxFiles,
                    maxBytes,
                    maxHits,
                    conversationIds,
                    chain = DEFAULT_CHAIN,
                    dataChain,
                    modelChain,
                    link = DEFAULT_LINK_MODE,
                } = params;
                const chains = resolveChainSplit({ chain, dataChain, modelChain });

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
                    if (!background) {
                        return appendTiming({
                            content: [{ type: "text" as const, text: "❌ deep_locate 必须 background=true；这是可能扫描大 JSONL 的后台重任务，不能同步执行。" }],
                        }, startTime);
                    }
                    const requestedMode = (mode === "fuzzy" ? "fuzzy" : "exact") as "exact" | "fuzzy";
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
                    });
                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: [
                                "🚀 deep_locate 已转入后台任务",
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
                    let codexThreads: CodexThreadInfo[] = [];
                    let claudeCodeThreads: ClaudeCodeThreadInfo[] = [];
                    const candidates: ConversationListCandidate[] = resolved === "antigravity"
                        ? listConversationsByMtime({ limit: candidateLimit }).map(item => ({
                            id: item.id,
                            title: item.title || "",
                            workspace: "",
                            updatedAt: item.mtime.toISOString(),
                            detail: `${item.sizeKB.toFixed(1)} KB`,
                        }))
                        : resolved === "codex"
                            ? (codexThreads = listRecentCodexThreads(candidateLimit)).map(candidateFromCodexThread)
                            : (claudeCodeThreads = listRecentClaudeCodeThreads(candidateLimit)).map(candidateFromClaudeCodeThread);

                    const probeResult = resolved === "codex"
                        ? annotateCodexContextProbeCandidates(candidates, codexThreads, contextProbe)
                        : resolved === "claude-code"
                            ? annotateClaudeCodeContextProbeCandidates(candidates, claudeCodeThreads, contextProbe)
                        : { candidates, matchMode: "", hitCount: 0 };

                    const directMatches = normalizedQuery
                        ? probeResult.candidates.filter(item => {
                            const haystack = normalizeListQuery(`${item.id}\n${item.title}\n${item.workspace}`);
                            return haystack.includes(normalizedQuery);
                        })
                        : probeResult.candidates;

                    let filtered = normalizedQuery ? sortListMatchesByQuery(directMatches, normalizedQuery) : directMatches;
                    let matchMode = normalizedQuery ? "exact" : "";
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

                        if (results.length === 0 && resolved !== "codex" && (requestedMode === "auto" || requestedMode === "smart")) {
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
                        } else if ((resolved === "codex" || resolved === "claude-code") && fallbackPlan.deepSearchSuggested) {
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

                const loaded = await loadConversationData(chains.dataChain, conversationId, {
                    refresh: action === "fetch",
                    link,
                });
                if (!loaded) {
                    return appendTiming({
                        content: [{ type: "text" as const, text: `❌ 无法通过 dataChain=${chains.dataChain} 获取对话数据` }],
                    }, startTime);
                }

                const cascadeId = loaded.conversationId;
                const rounds = loaded.rounds;
                const totalSteps = loaded.totalSteps;
                const expandedChildren = loaded.codexData?.expandedChildren || [];
                const childDiagnostics = loaded.codexData?.childDiagnostics || [];

                // === fetch 模式 ===
                if (action === "fetch") {
                    const attachmentOverview = formatAttachmentOverview(rounds);
                    const tempPath = saveTempFile(
                        "conv",
                        cascadeId.slice(0, 8),
                        buildConversationText(cascadeId, rounds, totalSteps, "normal", [], expandedChildren, childDiagnostics),
                    );
                    const overview = formatOverview(cascadeId, rounds, totalSteps);
                    const cacheNote = loaded.chainUsed === "antigravity"
                        ? (loaded.fromCache ? " (从缓存)" : " (新拉取)")
                        : loaded.chainUsed === "codex"
                            ? " (Codex 本地会话)"
                            : " (Claude Code 本地会话)";

                    // v1.8: 自动触发 Record 更新检查
                    let recordNote = "";
                    try {
                        const recordHash = findRecordHash(cascadeId) || resolveWorkspaceHashForRecord();
                        if (shouldAutoUpdateRecord(recordHash, cascadeId, rounds.length)) {
                            // 异步更新，不阻塞返回
                            generateRecord(recordHash, cascadeId, "auto", rounds, totalSteps, chains.modelChain, {
                                background: chains.modelChain === "codex",
                            })
                                .then(async (res) => {
                                    if (res.success && res.content) {
                                        const phases = countPhasesInRecord(res.content);
                                        await writeRecord(recordHash, cascadeId, res.content, {
                                            totalRounds: rounds.length,
                                            totalSteps,
                                            lastUpdatedRound: res.coveredRounds || rounds.length,
                                            phases,
                                            tags: res.tags,
                                        });
                                        try {
                                            await writeRecordSidecar(recordHash, cascadeId, "record_index.json", buildRecordReaderIndex(cascadeId, res.content));
                                        } catch (err) {
                                            console.error(`[record] reader index build failed: ${err instanceof Error ? err.message : String(err)}`);
                                        }
                                        console.error(`[record] 自动更新完成: ${cascadeId.slice(0, 8)}... (${phases} Phase)`);
                                    }
                                })
                                .catch(err => console.error(`[record] 自动更新失败:`, err));
                            recordNote = "\n📋 Record 自动更新已触发（后台进行中）";
                        }
                    } catch { /* 忽略 Record 检查错误 */ }

                    return appendTiming({
                        content: [{
                            type: "text" as const,
                            text: `${overview}${cacheNote}\n🔗 数据链路: ${loaded.chainUsed}${attachmentOverview ? `\n${attachmentOverview}` : ""}\n📁 临时文件: ${tempPath}\n💡 使用 search(query="关键词") 搜索或 read(startRound=1, endRound=3) 阅读${recordNote}`,
                        }],
                    }, startTime);
                }

                // === search 模式 ===
                if (action === "search") {
                    if (!query) {
                        return appendTiming({
                            content: [{ type: "text" as const, text: "❌ search 模式需要提供 query 参数" }],
                        }, startTime);
                    }

                    const matches = (mode === "auto" || mode === "exact")
                        ? searchInRounds(rounds, query, limit)
                        : [];
                    if (matches.length === 0 && mode === "exact") {
                        return appendTiming({
                            content: [{ type: "text" as const, text: `🔍 搜索 "${query}" — exact 模式未找到匹配` }],
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
                                    content: [{ type: "text" as const, text: `🔍 搜索 "${query}" — 未找到匹配` }],
                                }, startTime);
                            }
                            const smartRoundIndices = smartResults.map(r => Number(r.id));
                            const output: string[] = [`🔍 搜索 "${query}" — smart 模式命中 ${smartResults.length} 轮\n`];
                            const selectedRounds = smartRoundIndices
                                .map(ri => rounds[ri - 1])
                                .filter((round): round is ConversationRound => Boolean(round));
                            const { rounds: displayRounds, truncated } = await materializeRoundAttachments(selectedRounds, cascadeId);
                            for (const ri of smartRoundIndices) {
                                const round = displayRounds.find(item => item.roundIndex === ri);
                                if (!round) continue;
                                output.push(formatRound(round, depth as Depth, extraTypes as ExtraType[]));
                                output.push("");
                            }
                            if (truncated > 0) output.push(`⚠️ ${truncated} 个附件超过单次生成上限，未生成临时文件\n`);
                            let text = output.join("\n");
                            if (text.length > 8000) text = text.slice(0, 8000) + "\n\n⚠️ 结果过长已截断";
                            return appendTiming({
                                content: [{ type: "text" as const, text: `🔗 数据链路: ${loaded.chainUsed} | 模型链路: ${chains.modelChain}\n\n${text}` }],
                            }, startTime);
                        }
                        // 将 fuzzy 结果转换回轮次索引
                        const fuzzyRoundIndices = fuzzyResults.map(r => Number(r.id));
                        const output: string[] = [`🔍 搜索 "${query}" — fuzzy 模式命中 ${fuzzyResults.length} 轮\n`];
                        const selectedRounds = fuzzyRoundIndices
                            .map(ri => rounds[ri - 1])
                            .filter((round): round is ConversationRound => Boolean(round));
                        const { rounds: displayRounds, truncated } = await materializeRoundAttachments(selectedRounds, cascadeId);
                        for (const ri of fuzzyRoundIndices) {
                            const round = displayRounds.find(item => item.roundIndex === ri);
                            if (!round) continue;
                            output.push(formatRound(round, depth as Depth, extraTypes as ExtraType[]));
                            output.push("");
                        }
                        if (truncated > 0) output.push(`⚠️ ${truncated} 个附件超过单次生成上限，未生成临时文件\n`);
                        let text = output.join("\n");
                        if (text.length > 8000) text = text.slice(0, 8000) + "\n\n⚠️ 结果过长已截断";
                        return appendTiming({
                            content: [{ type: "text" as const, text: `🔗 数据链路: ${loaded.chainUsed}\n\n${text}` }],
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
                    const { rounds: displayRounds, truncated } = await materializeRoundAttachments(selectedRounds, cascadeId);
                    for (const ri of sortedRounds) {
                        const round = displayRounds.find(item => item.roundIndex === ri);
                        if (!round) continue;
                        output.push(formatRound(round, depth as Depth, extraTypes as ExtraType[]));
                        output.push("");
                    }
                    if (truncated > 0) output.push(`⚠️ ${truncated} 个附件超过单次生成上限，未生成临时文件\n`);

                    // 上下文大小控制
                    let text = output.join("\n");
                    const MAX_SEARCH = 8000;
                    if (depth === "full" && text.length > MAX_SEARCH) {
                        // full 深度不截断，写入临时文件
                        const slug = cascadeId.slice(0, 8);
                        const tmpPath = saveTempFile("search", slug, text);
                        const summary = `🔗 数据链路: ${loaded.chainUsed}\n\n` + text.slice(0, 2000) + `\n\n📄 完整搜索结果已写入: ${tmpPath}\n(共 ${text.length} 字)`;
                        return appendTiming({
                            content: [{ type: "text" as const, text: summary }],
                        }, startTime);
                    } else if (text.length > MAX_SEARCH) {
                        text = text.slice(0, MAX_SEARCH) + `\n\n⚠️ 结果过长已截断（${text.length}→${MAX_SEARCH}字），请用更精确的关键词或 depth=brief`;
                    }

                    return appendTiming({
                        content: [{ type: "text" as const, text: `🔗 数据链路: ${loaded.chainUsed}\n\n${text}` }],
                    }, startTime);
                }

                // === read 模式 ===
                if (action === "read") {
                    const start = startRound || 1;
                    const end = endRound || rounds.length;

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
                    pushOutputWithBuildBudget(output, `📖 读取轮次 ${start}-${Math.min(end, rounds.length)}\n`, buildState, "read 输出");

                    const selectedRounds = rounds.slice(start - 1, Math.min(end, rounds.length));
                    const { rounds: displayRounds, truncated } = await materializeRoundAttachments(selectedRounds, cascadeId);
                    for (let i = start; i <= Math.min(end, rounds.length); i++) {
                        if (!pushOutputWithBuildBudget(output, formatRound(displayRounds[i - start], depth as Depth, extraTypes as ExtraType[]), buildState, "read 输出")) break;
                        if (!pushOutputWithBuildBudget(output, "", buildState, "read 输出")) break;
                    }
                    if (truncated > 0) output.push(`⚠️ ${truncated} 个附件超过单次生成上限，未生成临时文件\n`);

                    if (!buildState.truncated && expandedChildren.length > 0) {
                        pushOutputWithBuildBudget(output, "# 子代理线程展开", buildState, "read 输出");
                        pushOutputWithBuildBudget(output, "", buildState, "read 输出");
                        for (const child of expandedChildren) {
                            if (!pushOutputWithBuildBudget(output, `## 子线程 ${child.thread.id.slice(0, 8)}... ${child.thread.title ? `| ${child.thread.title}` : ""}`, buildState, "read 输出")) break;
                            if (!pushOutputWithBuildBudget(output, "", buildState, "read 输出")) break;
                            const { rounds: childDisplayRounds, truncated: childTruncated } = await materializeRoundAttachments(child.rounds, child.thread.id);
                            for (const round of childDisplayRounds) {
                                if (!pushOutputWithBuildBudget(output, formatRound(round, depth as Depth, extraTypes as ExtraType[]), buildState, "read 输出")) break;
                                if (!pushOutputWithBuildBudget(output, "", buildState, "read 输出")) break;
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
                        const tmpPath = saveTempFile("read", slug, text);
                        const summary = text.slice(0, 2000) + `\n\n📄 完整内容已写入: ${tmpPath}\n(共 ${text.length} 字，${output.length} 段)`;
                        return appendTiming({
                            content: [{ type: "text" as const, text: summary }],
                        }, startTime);
                    } else if (text.length > MAX_READ) {
                        text = text.slice(0, MAX_READ) + `\n\n⚠️ 结果过长已截断（${text.length}→${MAX_READ}字），请用更小的轮次范围或 brief 深度`;
                    }

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
                        text: `❌ conversation_read_original 失败: ${error instanceof Error ? error.message : String(error)}`,
                    }],
                }, startTime);
            }
        }
    );
}
