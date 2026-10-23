import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { CorpusMessageRole, CorpusProjection, CorpusProvider, CorpusSearchExpression, CorpusSearchRequest } from "../conversation-corpus-types.js";
import { normalizeCodexCorpusConversationId } from "../conversation-corpus-search.js";

const actions = new Set(["search_all", "search_all_status", "search_all_cancel", "search_all_resume", "read_hit", "read_fast"]);

export function isCorpusAction(action: string): boolean {
    return actions.has(action);
}

export interface CorpusToolParams {
    action: string;
    conversationId?: string;
    conversationIds?: string[];
    query?: string;
    allTerms?: string[];
    anyTerms?: string[];
    excludeTerms?: string[];
    searchExpression?: CorpusSearchExpression;
    intersectionScope?: "conversation" | "round" | "message";
    searchSort?: "latest_match" | "activity" | "occurrences" | "messages";
    caseSensitive?: boolean;
    workspaces?: string[];
    workspaceMode?: CorpusSearchRequest["workspaceMode"];
    messageRoles?: string[];
    forceRefresh?: boolean;
    taskId?: string;
    limit?: number;
    continuationCursor?: string;
    afterRevision?: number;
    waitSeconds?: number;
    sourceRevision?: string;
    startRound?: number;
    endRound?: number;
    lastRounds?: number;
    dataChain?: string;
    source?: string;
    prepareCache?: boolean;
}

interface TaskIdentity { ownerId: string; taskId: string }
export interface CorpusToolImplementation {
    provider: CorpusProvider;
    start: (args: { ownerId: string; request: CorpusSearchRequest; provider: CorpusProvider }) => Promise<unknown>;
    status: (args: TaskIdentity & { limit?: number; cursor?: string; afterRevision?: number; waitMs?: number }) => Promise<unknown>;
    cancel: (args: TaskIdentity) => Promise<unknown>;
    resume: (args: TaskIdentity & { provider: CorpusProvider }) => Promise<unknown>;
    readRounds: (conversation: Parameters<CorpusProvider["read"]>[0], request: {
        revision: string; startRound?: number; endRound?: number; lastRounds?: number; messageRoles?: CorpusMessageRole[];
    }) => Promise<CorpusProjection>;
    readFast: (conversation: Parameters<CorpusProvider["read"]>[0], request: {
        startRound?: number; endRound?: number; lastRounds?: number; messageRoles?: CorpusMessageRole[];
    }) => Promise<CorpusProjection>;
    prepareCache: (args: { ownerId: string; conversationId: string; provider: CorpusProvider }) => Promise<unknown>;
}

async function implementation(): Promise<CorpusToolImplementation> {
    const [tasks, reader, preparation] = await Promise.all([import("../conversation-corpus-task.js"), import("../conversation-corpus-reader-codex.js"), import("../conversation-corpus-preparation.js")]);
    return { provider: reader.codexCorpusProvider, start: tasks.startCorpusSearch, status: tasks.getCorpusSearchStatus,
        cancel: tasks.cancelCorpusSearch, resume: tasks.resumeCorpusSearch, readRounds: reader.readCodexCorpusRounds,
        readFast: reader.readCodexCorpusFast, prepareCache: preparation.startCorpusPreparation };
}

function selectedRoles(input?: string[]): CorpusMessageRole[] | undefined {
    if (!input?.length) return undefined;
    const roles = input.map(role => role === "model" ? "assistant" : role);
    if (roles.some(role => !["user", "assistant", "tool", "subagent"].includes(role))) {
        throw new Error("全库正文检索支持user/assistant/tool/subagent；规则、压缩摘要和自动提醒保留在原文的system详细视图");
    }
    return [...new Set(roles)] as CorpusMessageRole[];
}

export async function runCorpusAction(params: CorpusToolParams, supplied?: CorpusToolImplementation): Promise<unknown> {
    const ownerId = params.conversationId?.trim();
    if (!ownerId) throw new Error("全库检索和read_fast需要conversationId指定当前调用者，目标范围使用conversationIds；read_hit使用命中项的目标conversationId");
    if (params.dataChain && params.dataChain !== "auto" && params.dataChain !== "codex") throw new Error("search_all/read_hit/read_fast当前使用本机Codex来源，请指定dataChain=codex");
    if (params.source === "ls" || params.source === "cache") throw new Error("search_all/read_hit/read_fast使用来源校验后的正文投影，请使用source=auto/local；固定旧fetch缓存可用search/read");
    if (params.forceRefresh && params.action !== "search_all") throw new Error("forceRefresh仅用于新建search_all，既有任务和命中展开保持原来源版本");
    const api = supplied || await implementation();
    const roles = selectedRoles(params.messageRoles);
    if (params.action === "search_all") {
        return api.start({ ownerId, provider: api.provider, request: {
            query: params.query, allTerms: params.allTerms, anyTerms: params.anyTerms, excludeTerms: params.excludeTerms,
            expression: params.searchExpression, conversationIds: params.conversationIds, workspaces: params.workspaces,
            workspaceMode: params.workspaceMode, messageRoles: roles, intersectionScope: params.intersectionScope,
            sort: params.searchSort, caseSensitive: params.caseSensitive, forceRefresh: params.forceRefresh,
        } });
    }
    if (params.action === "read_hit" || params.action === "read_fast") {
        if (params.action === "read_fast" && params.conversationIds && params.conversationIds.length !== 1) throw new Error("read_fast的conversationIds只能指定一个目标，省略时读取当前对话");
        const targetId = normalizeCodexCorpusConversationId(params.action === "read_fast" ? params.conversationIds?.[0] || ownerId : ownerId);
        if (params.action === "read_hit" && !params.sourceRevision?.trim()) throw new Error("read_hit需要搜索命中项的sourceRevision，按同一来源版本展开轮次");
        if (params.action === "read_hit" && /^pending(?:[:/-]|$)/u.test(params.sourceRevision!.trim())) throw new Error("该搜索命中仍为暂计，来源尚未完整校验；请等待同一任务的最终sourceRevision，或用read_fast读取当前范围");
        if (params.action === "read_fast" && params.sourceRevision !== undefined) throw new Error("按固定sourceRevision展开请使用read_hit；read_fast读取当前已校验来源");
        if (params.startRound === undefined && params.endRound === undefined && params.lastRounds === undefined) throw new Error(`${params.action}需要startRound/endRound或lastRounds限定读取范围`);
        for (const round of [params.startRound, params.endRound, params.lastRounds]) {
            if (round !== undefined && (!Number.isSafeInteger(round) || round < 1)) throw new Error(`${params.action}轮次必须为正整数`);
        }
        if (params.lastRounds !== undefined && (params.startRound !== undefined || params.endRound !== undefined)) throw new Error("lastRounds与startRound/endRound择一使用");
        if (params.startRound !== undefined && params.endRound !== undefined && params.startRound > params.endRound) throw new Error("startRound必须小于或等于endRound");
        const conversations = await api.provider.list({ conversationIds: [targetId] }, {});
        const conversation = conversations.find(candidate => candidate.id === targetId);
        if (!conversation) throw new Error(`${params.action}目标对话在本机来源中不存在`);
        if (params.action === "read_fast") {
            const cachePreparation = params.prepareCache === false ? undefined : await api.prepareCache({ ownerId, conversationId: targetId, provider: api.provider });
            try {
                const projection = await api.readFast(conversation, { startRound: params.startRound, endRound: params.endRound,
                    lastRounds: params.lastRounds, messageRoles: roles });
                return { ...projection, requestedRangeComplete: projection.requestedRangeComplete === true || projection.complete,
                    fullSourceProjectionComplete: projection.complete, cachePreparation };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`${message}${cachePreparation ? `；已登记的缓存准备任务：${JSON.stringify(cachePreparation)}` : ""}`);
            }
        }
        return api.readRounds(conversation, { revision: params.sourceRevision!, startRound: params.startRound,
            endRound: params.endRound, lastRounds: params.lastRounds, messageRoles: roles });
    }
    if (!params.taskId?.trim()) throw new Error(`${params.action}需要原taskId`);
    const identity = { ownerId, taskId: params.taskId.trim() };
    if (params.action === "search_all_status") {
        const status = await api.status({ ...identity, limit: Math.min(50, Math.max(1, Math.floor(params.limit || 8))),
            cursor: params.continuationCursor, afterRevision: params.afterRevision,
            waitMs: Math.min(45000, Math.max(0, (params.waitSeconds || 0) * 1000)) });
        if (status && typeof status === "object" && "changes" in status) {
            const changes = status.changes as { throughRevision?: number } | undefined;
            return { ...status, nextAfterRevision: changes?.throughRevision };
        }
        return status;
    }
    if (params.action === "search_all_cancel") return api.cancel(identity);
    if (params.action === "search_all_resume") return api.resume({ ...identity, provider: api.provider });
    throw new Error("未知全库检索动作");
}

export async function corpusToolResult(result: unknown): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    const serialized = JSON.stringify(result, null, 2);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes <= 100000) return { content: [{ type: "text", text: serialized }] };
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-store-corpus-"));
    const artifactPath = path.join(directory, "result.json");
    await fs.writeFile(artifactPath, serialized, "utf8");
    return { content: [{ type: "text", text: JSON.stringify({ delivery: "artifact", complete: true,
        artifactPath, bytes, sha256: createHash("sha256").update(serialized).digest("hex"),
        description: "完整结果已写入JSON文件；此响应提供文件位置，文件内容包含全部请求结果" }, null, 2) }] };
}
