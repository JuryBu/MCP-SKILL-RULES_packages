import fs from "node:fs";
import { deepLocateCodexConversations, matchCodexContextProbeInRollout, getCodexThread, type CodexThreadInfo } from "./codex-client.js";
import { deepLocateClaudeCodeConversations, matchClaudeCodeContextProbeInJsonl, getClaudeCodeThread, type ClaudeCodeThreadInfo } from "./claude-code-client.js";
import { loadConversationData } from "./conversation-bridge.js";
import { iterateCachedConversationSourceCacheRounds, readCachedConversationSourceCache } from "./conversation-source-cache.js";
import type { ConversationRound } from "./trajectory.js";
import { candidateHitIdentity, redactLocateText, type ContextLocateReadBudget, type ContextLocateScanResult, type ConversationContextLocateAdapters } from "./conversation-context-locate.js";
import type { UnifiedConversationCandidate } from "./conversation-filter.js";

function streamThread(candidate: UnifiedConversationCandidate): CodexThreadInfo | ClaudeCodeThreadInfo | null {
    if (candidate.dataChain === "codex") {
        return candidate.sourcePath ? {
            id: candidate.id, rolloutPath: candidate.sourcePath, title: candidate.title, cwd: candidate.workspace,
            source: "codex", model: "", reasoningEffort: "", updatedAtMs: Date.parse(candidate.updatedAt),
        } : getCodexThread(candidate.id);
    }
    return candidate.sourcePath ? {
        id: candidate.id, jsonlPath: candidate.sourcePath, title: candidate.title, cwd: candidate.workspace, source: "claude-code",
    } : getClaudeCodeThread(candidate.id);
}

async function scanStream(candidate: UnifiedConversationCandidate, query: string, budget: ContextLocateReadBudget): Promise<ContextLocateScanResult | null> {
    if (candidate.dataChain !== "codex" && candidate.dataChain !== "claude-code") return null;
    if (budget.source === "ls") throw new Error(`${candidate.dataChain} does not expose LS`);
    if (budget.source === "cache") return null;
    if (budget.maxBytes < 64 * 1024 || budget.deadlineAt - Date.now() < 1000) {
        return { hits: [], scannedBytes: 0, partial: true, warnings: ["stream minimum read/time budget not available"] };
    }
    const thread = streamThread(candidate);
    if (!thread) throw new Error("source thread not found");
    const filePath = "rolloutPath" in thread ? thread.rolloutPath : thread.jsonlPath;
    if (!filePath || !fs.existsSync(filePath)) throw new Error("source JSONL is missing");
    const size = fs.statSync(filePath).size;
    if (budget.probe) {
        const rawHits = candidate.dataChain === "codex"
            ? matchCodexContextProbeInRollout(filePath, query, { maxBytes: budget.maxBytes })
            : matchClaudeCodeContextProbeInJsonl(filePath, query, { maxBytes: budget.maxBytes });
        return {
            hits: rawHits.slice(0, budget.maxHits).map(hit => ({
                ...candidateHitIdentity(candidate), ...hit, snippet: redactLocateText(hit.snippet),
                source: "message_body_hit", mode: "exact", filePath,
                sourcePosition: { kind: "round", roundIndex: hit.roundIndex }, freshness: "unknown",
            })),
            scannedBytes: Math.min(size, budget.maxBytes), totalBytes: size,
            partial: size > budget.maxBytes || rawHits.length >= Math.min(5, budget.maxHits) || query.trim().length < 12,
            warnings: size > budget.maxBytes ? ["contextProbe searched the bounded JSONL tail, not the entire conversation"] : undefined,
        };
    }
    const options = {
        mode: budget.mode, maxFiles: 1, maxBytes: budget.maxBytes, maxHits: budget.maxHits,
        deadlineMs: budget.deadlineAt - Date.now(), isCancelled: budget.isCancelled,
    };
    const result = candidate.dataChain === "codex"
        ? deepLocateCodexConversations(query, [thread as CodexThreadInfo], options)
        : deepLocateClaudeCodeConversations(query, [thread as ClaudeCodeThreadInfo], options);
    return {
        hits: result.hits.map(hit => ({
            ...candidateHitIdentity(candidate), ...hit, snippet: redactLocateText(hit.snippet),
            sourcePosition: { kind: "jsonl", roundIndex: hit.roundIndex },
        })),
        scannedBytes: result.scannedBytes, totalBytes: result.totalBytes,
        partial: result.truncated, cancelled: result.status === "cancelled",
    };
}

export const defaultContextLocateAdapters: ConversationContextLocateAdapters = {
    scanStream,
    readRounds: async (candidate, budget) => {
        if (budget.source === "cache") {
            if (!candidate.cacheKey || !candidate.cacheGeneration) throw new Error("cache-only candidate has no verified cache generation");
            const loaded = readCachedConversationSourceCache<Record<string, any>>({ key: candidate.cacheKey, generation: candidate.cacheGeneration });
            if (!loaded) throw new Error("cache-only candidate generation is unavailable");
            const firstRound = budget.probe ? Math.max(1, loaded.roundCount - budget.maxRounds + 1) : 1;
            const cached = iterateCachedConversationSourceCacheRounds<ConversationRound>({ key: candidate.cacheKey, generation: candidate.cacheGeneration, startRound: firstRound });
            if (!cached) throw new Error("cache-only candidate rounds are unavailable");
            if (cached.roundsBytes > budget.maxBytes) return { rounds: [], partial: true, warnings: ["normalized cache exceeds remaining locate budget"] };
            const partial = firstRound > 1 || candidate.sourcePartial || Boolean(loaded.snapshot.windsurfData?.partial || loaded.snapshot.cacheState === "stale");
            return { rounds: cached.rounds, partial, freshness: "unknown", warnings: partial ? ["cache-only scan contains partial source or bounded recent rounds"] : undefined };
        }
        if (candidate.sourceBytes !== undefined && candidate.sourceBytes > budget.maxBytes) {
            return { rounds: [], partial: true, warnings: ["source size exceeds remaining locate budget; increase maxBytes or use a narrower source"] };
        }
        const cancelled = () => budget.isCancelled() || Date.now() >= budget.deadlineAt;
        const loaded = await loadConversationData(candidate.dataChain, candidate.id, {
            source: budget.source, includeRounds: false, link: "summary", isCancelled: cancelled,
            sourceReadBudget: { maxBytes: budget.maxBytes, deadlineMs: budget.deadlineAt, isCancelled: cancelled },
        });
        if (cancelled()) return { rounds: [], partial: true, warnings: ["source load exceeded locate deadline or was cancelled"] };
        if (!loaded) throw new Error("conversation source is unavailable");
        const firstRound = budget.probe ? Math.max(1, (loaded.roundCount || loaded.rounds.length) - budget.maxRounds + 1) : 1;
        const cached = loaded.cacheKey && loaded.cacheGeneration
            ? iterateCachedConversationSourceCacheRounds<ConversationRound>({ key: loaded.cacheKey, generation: loaded.cacheGeneration, startRound: firstRound })
            : null;
        if (cached && cached.roundsBytes > budget.maxBytes) {
            return { rounds: [], partial: true, warnings: ["normalized source exceeds remaining locate budget; no oversized round was materialized"] };
        }
        const partial = firstRound > 1 || candidate.sourcePartial || loaded.cacheState === "stale" || Boolean(loaded.cacheBuildFailure || loaded.windsurfData?.partial) || (!cached && !loaded.rounds.length);
        return {
            rounds: cached?.rounds || loaded.rounds.filter(round => round.roundIndex >= firstRound),
            partial,
            filePath: loaded.cacheFingerprint?.path || candidate.sourcePath,
            freshness: partial ? "unknown" : "fresh",
            warnings: partial ? [firstRound > 1 ? "contextProbe searched a bounded recent-round window" : "source cache is stale or source reported incomplete content"] : undefined,
        };
    },
};
