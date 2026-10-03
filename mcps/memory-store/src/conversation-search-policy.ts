import type { ConversationLoadResult } from "./conversation-bridge.js";
import type { CodexFetchWorkerResult } from "./conversation-fetch-worker-types.js";

export interface ConversationSearchReadRequest {
    source: "auto" | "local" | "ls" | "cache";
    sourceExplicit: boolean;
    link: "reference" | "summary" | "expand_children";
    cacheGeneration?: string;
    logicalChain?: "off" | "explain" | "auto" | "strict";
}

export function shouldUsePublishedConversationCache(action: string, dataChain: string, sourceExplicit: boolean): boolean {
    return !sourceExplicit && (action === "search" || action === "read") && (dataChain === "codex" || dataChain === "auto");
}

export function assertConversationStrictCacheState(loaded: ConversationLoadResult, action: string, request: ConversationSearchReadRequest): void {
    if (loaded.cacheState !== "stale") return;
    if (action === "fetch" || (request.sourceExplicit && request.source !== "cache")) {
        throw new Error([
            "严格原文校验或 fetch 失败，上一份完整缓存仍保留",
            loaded.cacheBuildFailure ? `${loaded.cacheBuildFailure.name}: ${loaded.cacheBuildFailure.message}` : "当前返回 stale 缓存",
            `读取旧缓存：action=search/read, source=cache, link=${request.link}, cacheGeneration=${loaded.cacheGeneration || "unknown"}`,
        ].join("\n"));
    }
}

export function formatConversationSearchReadCache(loaded: ConversationLoadResult, request: ConversationSearchReadRequest, now = Date.now()): string {
    const createdAt = loaded.cacheCreatedAt || "unknown";
    const createdMs = Date.parse(createdAt);
    const age = Number.isFinite(createdMs) ? `${Math.max(0, Math.floor((now - createdMs) / 1_000))}s` : "unknown";
    const actualLink = loaded.cacheKey?.source.match(/(?:^|:)link=([^:]+)/)?.[1] || "unknown";
    const actualLogical = loaded.cacheKey?.source.match(/(?:^|:)logical=([^:]+)/)?.[1];
    const history = loaded.codexData?.historySource;
    const coverage = history?.totalBytes ?? loaded.cacheFingerprint?.size;
    const leaf = history?.segments.at(-1);
    const boundary = leaf ? `endByte=${leaf.endByte}, endOrdinalExclusive=${leaf.endOrdinalExclusive ?? "unknown"}` : "unknown";
    const verification = loaded.cacheReadPolicy === "verified" ? "yes" : loaded.cacheReadPolicy === "published" ? "no" : "unknown";
    return [
        `📌 cacheGeneration: ${loaded.cacheGeneration || "unknown"} | cacheState: ${loaded.cacheState || "unknown"}`,
        `🕒 createdAt: ${createdAt} | age: ${age}`,
        `📖 请求视图: source=${request.sourceExplicit ? request.source : "omitted"}, link=${request.link}${request.logicalChain ? `, logicalChain=${request.logicalChain}` : ""}${request.cacheGeneration ? `, cacheGeneration=${request.cacheGeneration}` : ""}`,
        `📚 实际视图: source=${loaded.cacheReadPolicy === "published" ? "cache" : loaded.sourceMode || "unknown"}, link=${actualLink}${actualLogical ? `, logicalChain=${actualLogical}` : ""} | cacheKey=${loaded.cacheKey?.source || "unknown"}`,
        `🔎 本次原文校验: ${verification} | cacheReadPolicy: ${loaded.cacheReadPolicy || "unknown"}`,
        `📏 源覆盖: ${coverage ?? "unknown"} bytes | ${history ? history.segments.length : "unknown"} files | 末端边界: ${boundary}`,
    ].join("\n");
}

export function conversationSearchReadNextParams(loaded: ConversationLoadResult, request: ConversationSearchReadRequest): Record<string, unknown> {
    const logicalChain = request.logicalChain || loaded.cacheKey?.source.match(/(?:^|:)logical=([^:]+)/)?.[1];
    return {
        source: loaded.cacheGeneration ? "cache" : request.source,
        link: request.link,
        ...(loaded.cacheGeneration ? { cacheGeneration: loaded.cacheGeneration } : {}),
        ...(logicalChain ? { logicalChain } : {}),
    };
}

export function formatConversationFetchCacheContinuation(result: Pick<CodexFetchWorkerResult,
    "conversationId" | "chainUsed" | "requestedLink" | "effectiveLink" | "cacheGeneration" | "cacheState" | "cacheCreatedAt" | "cacheReadPolicy"
    | "sourceCoverageBytes" | "sourceFileCount" | "sourceEndByte" | "sourceEndOrdinalExclusive" | "roundCount">, now = Date.now()): string {
    const createdMs = Date.parse(result.cacheCreatedAt || "");
    const age = Number.isFinite(createdMs) ? `${Math.max(0, Math.floor((now - createdMs) / 1000))}s` : "unknown";
    const output = [
        `📌 cacheGeneration: ${result.cacheGeneration || "unknown"} | cacheState: ${result.cacheState || "unknown"}`,
        `🕒 createdAt: ${result.cacheCreatedAt || "unknown"} | age: ${age}`,
        `📖 请求视图: link=${result.requestedLink} | 实际视图: source=cache, link=${result.effectiveLink}`,
        `🔎 本次原文校验: ${result.cacheReadPolicy === "verified" ? "yes" : result.cacheReadPolicy === "published" ? "no" : "unknown"} | cacheReadPolicy: ${result.cacheReadPolicy || "unknown"}`,
        `📏 源覆盖: ${result.sourceCoverageBytes ?? "unknown"} bytes | ${result.sourceFileCount ?? "unknown"} files | 末端边界: endByte=${result.sourceEndByte ?? "unknown"}, endOrdinalExclusive=${result.sourceEndOrdinalExclusive ?? "unknown"}`,
    ];
    if (result.cacheGeneration) {
        const common = { conversationId: result.conversationId, dataChain: result.chainUsed, source: "cache", link: result.effectiveLink, cacheGeneration: result.cacheGeneration };
        output.push("💡 固定同代查询参数", JSON.stringify({ action: "search", ...common, query: "关键词", mode: "exact" }));
        output.push("💡 固定同代读取参数", JSON.stringify({ action: "read", ...common, startRound: 1, endRound: Math.max(1, Math.min(3, result.roundCount)), depth: "brief" }));
    } else {
        output.push("缓存代次字段缺失，请重新 fetch 后使用完成回包中的固定同代参数");
    }
    return output.join("\n");
}

export function selectConversationFetchTaskId(baseTaskId: string, payload: { version: number; verificationDeferred?: boolean },
    getTask: (taskId: string) => { status: string } | null): string {
    const canReuseDone = payload.version === 1 && !payload.verificationDeferred;
    const reusable = (status: string): boolean => status === "running" || status === "suspended" || (canReuseDone && status === "done");
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const taskId = attempt === 0 ? baseTaskId : `${baseTaskId}-retry-${attempt}`;
        const task = getTask(taskId);
        if (!task || reusable(task.status)) return taskId;
    }
    throw new Error("conversation fetch 重试任务编号已耗尽");
}
