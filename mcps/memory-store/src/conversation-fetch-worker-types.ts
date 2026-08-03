import type { ConversationSourceCacheBuildFailure, ConversationSourceCacheKey, ConversationSourceFingerprint } from "./conversation-source-cache.js";
import type { StreamedFetchArtifact } from "./conversation-fetch-artifact.js";
import type { Chain } from "./chain.js";

export interface CodexFetchWorkerPayload {
    version: 1;
    conversationId: string;
    link: "reference" | "summary" | "expand_children";
    source: "auto" | "local" | "cache";
    sourcePath: string;
    sourceSize: number;
    sourceMtimeMs: number;
    artifactBucket: number;
    modelChain: Chain;
}

export interface CodexFetchWorkerThreadSummary {
    id: string;
    title: string;
    cwd: string;
    parentConversationId?: string;
    agentRole?: string;
    agentNickname?: string;
}

export type CodexFetchWorkerLoadLink = Exclude<CodexFetchWorkerPayload["link"], "expand_children">;

export interface CodexFetchWorkerLinkResolution {
    requestedLink: CodexFetchWorkerPayload["link"];
    effectiveLink: CodexFetchWorkerLoadLink;
}

export interface CodexFetchWorkerLinkDiagnostic {
    code: "expand_children_downgraded_to_reference" | "child_conversation_fetch_required";
    message: string;
    conversationId?: string;
    nickname?: string;
}

export function resolveCodexFetchWorkerLink(link: CodexFetchWorkerPayload["link"]): CodexFetchWorkerLinkResolution {
    return {
        requestedLink: link,
        effectiveLink: link === "expand_children" ? "reference" : link,
    };
}

export function createCodexFetchWorkerLinkDiagnostics(
    resolution: CodexFetchWorkerLinkResolution,
    childThreads: Array<{ threadId: string; nickname?: string }>,
): CodexFetchWorkerLinkDiagnostic[] {
    if (resolution.requestedLink !== "expand_children") return [];
    return [
        {
            code: "expand_children_downgraded_to_reference",
            message: "Codex 后台 fetch 请求的 link=expand_children 已安全降级为 link=reference，不会递归加载父/子 raw JSONL；子代理请使用各自的 conversationId 单独发起 fetch。",
        },
        ...childThreads.map((child) => ({
            code: "child_conversation_fetch_required" as const,
            conversationId: child.threadId,
            nickname: child.nickname,
            message: `子代理未在父请求中展开，请使用 conversationId=${child.threadId} 单独发起 fetch。`,
        })),
    ];
}

export interface CodexFetchWorkerResult {
    artifact: StreamedFetchArtifact;
    chainUsed: "codex";
    conversationId: string;
    totalSteps: number;
    roundCount: number;
    requestedLink: CodexFetchWorkerPayload["link"];
    effectiveLink: CodexFetchWorkerLoadLink;
    linkDiagnostics: CodexFetchWorkerLinkDiagnostic[];
    cacheKey?: ConversationSourceCacheKey;
    cacheGeneration?: string;
    cacheState?: "hit" | "built" | "stale";
    cacheBuildFailure?: ConversationSourceCacheBuildFailure;
    cacheFingerprint?: ConversationSourceFingerprint | null;
    sourceMode?: "auto" | "local" | "ls" | "cache";
    sourceDiagnostics?: string[];
    thread: CodexFetchWorkerThreadSummary;
    parentThread?: Pick<CodexFetchWorkerThreadSummary, "id" | "title"> | null;
    timings: {
        cacheMs: number;
        artifactMs: number;
        totalMs: number;
    };
}

export type CodexFetchWorkerMessage =
    | { type: "progress"; stage: string; detail: string }
    | { type: "artifact_path"; path: string }
    | { type: "result"; result: CodexFetchWorkerResult }
    | { type: "error"; name: string; message: string; stack?: string };

export type CodexFetchWorkerCommand =
    | { type: "run"; payload: CodexFetchWorkerPayload }
    | { type: "cancel" };

export function isCodexFetchWorkerPayload(value: unknown): value is CodexFetchWorkerPayload {
    if (!value || typeof value !== "object") return false;
    const payload = value as Partial<CodexFetchWorkerPayload>;
    return payload.version === 1
        && typeof payload.conversationId === "string"
        && (payload.link === "reference" || payload.link === "summary" || payload.link === "expand_children")
        && (payload.source === "auto" || payload.source === "local" || payload.source === "cache")
        && typeof payload.sourcePath === "string"
        && payload.sourcePath.length > 0
        && Number.isFinite(payload.sourceSize)
        && Number.isFinite(payload.sourceMtimeMs)
        && Number.isInteger(payload.artifactBucket)
        && ["auto", "antigravity", "codex", "claude-code", "grok", "agy"].includes(payload.modelChain || "");
}
