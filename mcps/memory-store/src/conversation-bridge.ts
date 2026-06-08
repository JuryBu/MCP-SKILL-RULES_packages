import { normalizeDataChain, type DataChain, type ConversationLinkMode } from "./chain.js";
import {
    loadCodexConversation,
    resolveCurrentCodexThreadId,
    resolveCodexThreadId,
    isCodexSessionStoreAvailable,
    type CodexConversationData,
} from "./codex-client.js";
import {
    loadClaudeCodeConversation,
    resolveClaudeCodeThreadId,
    isClaudeCodeStoreAvailable,
    type ClaudeCodeConversationData,
} from "./claude-code-client.js";
import {
    loadWindsurfConversation,
    resolveWindsurfThreadId,
    isWindsurfStoreAvailable,
    type WindsurfConversationReadResult,
} from "./windsurf-client.js";
import { isAntigravityLS } from "./lifecycle.js";
import { fetchTrajectory, getCurrentCascadeId, isLsAvailable } from "./ls-client.js";
import { parseRounds, type ConversationRound } from "./trajectory.js";
import {
    resolveConversationIdAcrossSources,
    type IdResolutionMode,
    type SourceFailureMode,
} from "./conversation-filter.js";

export type ResolvedConversationChain = Exclude<DataChain, "auto">;

export interface ConversationLoadResult {
    chainUsed: ResolvedConversationChain;
    conversationId: string;
    rounds: ConversationRound[];
    totalSteps: number;
    fromCache?: boolean;
    codexData?: CodexConversationData;
    claudeCodeData?: ClaudeCodeConversationData;
    windsurfData?: WindsurfConversationReadResult;
    trajectory?: any;
}

export async function resolveConversationChain(chain: DataChain = "auto"): Promise<ResolvedConversationChain | null> {
    chain = normalizeDataChain(chain);
    if (chain === "antigravity") {
        return (await isLsAvailable()) ? "antigravity" : null;
    }
    if (chain === "codex") {
        return isCodexSessionStoreAvailable() ? "codex" : null;
    }
    if (chain === "claude-code") {
        return isClaudeCodeStoreAvailable() ? "claude-code" : null;
    }
    if (chain === "windsurf") {
        return (await isWindsurfStoreAvailable()) ? "windsurf" : null;
    }

    const preferLs = await isAntigravityLS();
    if (preferLs) {
        if (await isLsAvailable()) return "antigravity";
        if (isCodexSessionStoreAvailable()) return "codex";
        if (isClaudeCodeStoreAvailable()) return "claude-code";
        return null;
    }

    if (isCodexSessionStoreAvailable()) return "codex";
    if (await isLsAvailable()) return "antigravity";
    if (isClaudeCodeStoreAvailable()) return "claude-code";
    return null;
}

export async function resolveConversationId(
    requestedId: string | undefined,
    chain: ResolvedConversationChain,
    cwd: string = process.cwd(),
): Promise<string | null> {
    if (chain === "antigravity") {
        if (requestedId) return requestedId;
        return await getCurrentCascadeId();
    }
    if (chain === "claude-code") {
        if (requestedId) return resolveClaudeCodeThreadId(requestedId) || requestedId;
        return null;
    }
    if (chain === "windsurf") {
        if (requestedId) return await resolveWindsurfThreadId(requestedId) || requestedId;
        return null;
    }
    if (requestedId) return resolveCodexThreadId(requestedId) || requestedId;
    return resolveCurrentCodexThreadId(cwd);
}

export async function loadConversationData(
    chain: DataChain = "auto",
    conversationId?: string,
    options: {
        refresh?: boolean;
        link?: ConversationLinkMode;
        cwd?: string;
        dataChains?: DataChain[];
        idResolutionMode?: IdResolutionMode;
        sourceFailureMode?: SourceFailureMode;
    } = {},
): Promise<ConversationLoadResult | null> {
    chain = normalizeDataChain(chain);
    if (chain === "auto") {
        if (conversationId && (options.idResolutionMode || "unique") === "unique") {
            const resolvedAcrossSources = await resolveConversationIdAcrossSources(conversationId, {
                dataChains: options.dataChains,
                sourceFailureMode: options.sourceFailureMode || "warn",
            });
            if (resolvedAcrossSources.hits.length === 1) {
                const hit = resolvedAcrossSources.hits[0];
                return loadFromResolvedChain(hit.dataChain, hit.conversationId, options);
            }
            if (resolvedAcrossSources.hits.length > 1) {
                const candidates = resolvedAcrossSources.hits
                    .map(hit => `${hit.dataChain}:${hit.conversationId}${hit.title ? ` (${hit.title})` : ""}`)
                    .join("；");
                throw new Error(`conversationId 在多个数据源中命中，无法自动选择：${candidates}。请显式传 dataChain。`);
            }
            return null;
        }

        const preferLs = await isAntigravityLS();
        const candidates: ResolvedConversationChain[] = preferLs
            ? ["antigravity", "codex", "claude-code"]
            : ["codex", "antigravity", "claude-code"];
        if (conversationId) {
            candidates.push("windsurf");
        }

        for (const candidate of candidates) {
            const isAvailable = candidate === "antigravity"
                ? await isLsAvailable()
                : candidate === "codex"
                    ? isCodexSessionStoreAvailable()
                    : candidate === "claude-code"
                        ? isClaudeCodeStoreAvailable()
                        : await isWindsurfStoreAvailable();
            if (!isAvailable) continue;

            let loaded: ConversationLoadResult | null = null;
            try {
                loaded = await loadFromResolvedChain(candidate, conversationId, options);
            } catch {
                loaded = null;
            }
            if (loaded) return loaded;
        }

        return null;
    }

    const resolved = await resolveConversationChain(chain);
    if (!resolved) return null;
    return loadFromResolvedChain(resolved, conversationId, options);
}

async function loadFromResolvedChain(
    resolved: ResolvedConversationChain,
    conversationId: string | undefined,
    options: { refresh?: boolean; link?: ConversationLinkMode; cwd?: string },
): Promise<ConversationLoadResult | null> {
    const effectiveId = await resolveConversationId(conversationId, resolved, options.cwd);
    if (!effectiveId) return null;

    if (resolved === "antigravity") {
        const result = await fetchTrajectory(effectiveId, options.refresh);
        if (!result) return null;
        const trajectory = result.trajectory || {};
        const steps = trajectory.steps || [];
        return {
            chainUsed: "antigravity",
            conversationId: effectiveId,
            rounds: parseRounds(steps),
            totalSteps: trajectory.numTotalSteps || steps.length,
            fromCache: result.fromCache,
            trajectory,
        };
    }

    if (resolved === "claude-code") {
        const claudeCodeData = loadClaudeCodeConversation(effectiveId);
        if (!claudeCodeData) return null;
        return {
            chainUsed: "claude-code",
            conversationId: effectiveId,
            rounds: claudeCodeData.rounds,
            totalSteps: claudeCodeData.totalSteps,
            claudeCodeData,
        };
    }

    if (resolved === "windsurf") {
        const windsurfData = await loadWindsurfConversation(effectiveId);
        if (!windsurfData) return null;
        return {
            chainUsed: "windsurf",
            conversationId: effectiveId,
            rounds: windsurfData.rounds,
            totalSteps: windsurfData.totalSteps,
            windsurfData,
        };
    }

    const codexData = loadCodexConversation(effectiveId, options.link || "summary");
    if (!codexData) return null;
    return {
        chainUsed: "codex",
        conversationId: effectiveId,
        rounds: codexData.rounds,
        totalSteps: codexData.totalSteps,
        codexData,
    };
}
