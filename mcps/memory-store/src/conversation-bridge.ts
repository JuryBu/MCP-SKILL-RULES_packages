import { normalizeChain, type Chain, type ConversationLinkMode } from "./chain.js";
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
import { isAntigravityLS } from "./lifecycle.js";
import { fetchTrajectory, getCurrentCascadeId, isLsAvailable } from "./ls-client.js";
import { parseRounds, type ConversationRound } from "./trajectory.js";

export type ResolvedConversationChain = Exclude<Chain, "auto">;

export interface ConversationLoadResult {
    chainUsed: ResolvedConversationChain;
    conversationId: string;
    rounds: ConversationRound[];
    totalSteps: number;
    fromCache?: boolean;
    codexData?: CodexConversationData;
    claudeCodeData?: ClaudeCodeConversationData;
    trajectory?: any;
}

export async function resolveConversationChain(chain: Chain = "auto"): Promise<ResolvedConversationChain | null> {
    chain = normalizeChain(chain);
    if (chain === "antigravity") {
        return (await isLsAvailable()) ? "antigravity" : null;
    }
    if (chain === "codex") {
        return isCodexSessionStoreAvailable() ? "codex" : null;
    }
    if (chain === "claude-code") {
        return isClaudeCodeStoreAvailable() ? "claude-code" : null;
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
    if (requestedId) return resolveCodexThreadId(requestedId) || requestedId;
    return resolveCurrentCodexThreadId(cwd);
}

export async function loadConversationData(
    chain: Chain = "auto",
    conversationId?: string,
    options: { refresh?: boolean; link?: ConversationLinkMode; cwd?: string } = {},
): Promise<ConversationLoadResult | null> {
    chain = normalizeChain(chain);
    if (chain === "auto") {
        const preferLs = await isAntigravityLS();
        const candidates: ResolvedConversationChain[] = preferLs
            ? ["antigravity", "codex", "claude-code"]
            : ["codex", "antigravity", "claude-code"];

        for (const candidate of candidates) {
            const isAvailable = candidate === "antigravity"
                ? await isLsAvailable()
                : candidate === "codex"
                    ? isCodexSessionStoreAvailable()
                    : isClaudeCodeStoreAvailable();
            if (!isAvailable) continue;

            const loaded = await loadFromResolvedChain(candidate, conversationId, options);
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
