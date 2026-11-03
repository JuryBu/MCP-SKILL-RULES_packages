import fs from "node:fs";
import { deepLocateCodexConversations, matchCodexContextProbeInRollout, getCodexThread, type CodexThreadInfo } from "./codex-client.js";
import { deepLocateClaudeCodeConversations, matchClaudeCodeContextProbeInJsonl, getClaudeCodeThread, type ClaudeCodeThreadInfo } from "./claude-code-client.js";
import { conversationSourceIsPartial, loadConversationData } from "./conversation-bridge.js";
import { iterateCachedConversationSourceCacheRounds, readCachedConversationSourceCache } from "./conversation-source-cache.js";
import type { ConversationRound } from "./trajectory.js";
import { candidateHitIdentity, locateConversationContext, redactLocateText, type ContextLocateReadBudget, type ContextLocateScanResult, type ConversationContextLocateAdapters } from "./conversation-context-locate.js";
import type { UnifiedConversationCandidate } from "./conversation-filter.js";
import { splitDevinSubagentId } from "./devin-conversation.js";
import type { DevinIdentityCache } from "./devin-identity-cache.js";
import type { DevinRoundRange } from "./devin-types.js";

type DevinContextReader = typeof import("./devin-conversation.js").readDevinConversation;
const DEVIN_PROBE_WINDOW_ROUNDS = 12;
const DEVIN_PROBE_SOURCE_BYTES = 128 * 1024 * 1024;

function isDevinSource(candidate: UnifiedConversationCandidate, budget: ContextLocateReadBudget): boolean {
    return candidate.dataChain === "windsurf" && Boolean(candidate.sourceKind?.startsWith("devin-")) && budget.source !== "ls" && budget.source !== "cache";
}

async function scanDevinProbe(candidate: UnifiedConversationCandidate, query: string, budget: ContextLocateReadBudget,
    read: DevinContextReader): Promise<ContextLocateScanResult> {
    const hits: ContextLocateScanResult["hits"] = [];
    const warnings: string[] = [];
    const child = Boolean(candidate.isChildThread || splitDevinSubagentId(candidate.id));
    const physicalDesktop = !child && candidate.sourceKind === "devin-desktop" && !candidate.sessionId;
    let remainingSourceBytes = DEVIN_PROBE_SOURCE_BYTES;
    let remainingRounds = budget.maxRounds;
    let scannedBytes = 0;
    let nextEndRound: number | undefined;
    let sourcePartial = false;
    let scanPartial = false;
    let fallbackDeadline = budget.deadlineAt;
    let identityCache: DevinIdentityCache | undefined;
    const { isIsolatedSourceWorker } = await import("./conversation-isolated-source.js");
    if (isIsolatedSourceWorker()) identityCache = new (await import("./devin-identity-cache.js")).DevinIdentityCache();
    try {
        while (remainingRounds > 0 && remainingSourceBytes > 0 && scannedBytes < budget.maxBytes && hits.length < budget.maxHits) {
            if (budget.isCancelled() || Date.now() >= fallbackDeadline) { scanPartial = true; break; }
            const windowRounds = Math.min(DEVIN_PROBE_WINDOW_ROUNDS, remainingRounds);
            const roundRange: DevinRoundRange | undefined = child || physicalDesktop ? undefined
                : nextEndRound === undefined ? { tailRounds: windowRounds }
                    : { startRound: Math.max(1, nextEndRound - windowRounds + 1), endRound: nextEndRound };
            let loaded: Awaited<ReturnType<DevinContextReader>>;
            try {
                loaded = await read(candidate.id, { maxBytes: remainingSourceBytes, deadlineMs: fallbackDeadline,
                    isCancelled: () => budget.isCancelled() || Date.now() >= fallbackDeadline,
                    link: "summary", materializeAttachments: false, roundRange, identityCache,
                    ...(physicalDesktop ? { identityMode: "physical", physicalSourceKind: "devin-desktop" } : {}),
                });
            } catch (error) {
                const code = (error as { code?: string }).code;
                if (!code || !/^DEVIN_(?:BYTE_BUDGET|NODE_BUDGET|DEADLINE|ABORTED|RANGE_UNAVAILABLE)$/u.test(code)) throw error;
                warnings.push(`devin_context_source_budget:${candidate.id}:${code}`);
                scanPartial = true;
                break;
            }
            if (!loaded) throw new Error("Devin conversation source is unavailable");
            remainingSourceBytes = Math.max(0, remainingSourceBytes - (loaded.raw.readMetrics?.bytesRead ?? remainingSourceBytes));
            sourcePartial ||= loaded.raw.partial;
            warnings.push(...loaded.raw.warnings);
            const coverage = loaded.raw.coverage;
            const selectedRounds = coverage ? coverage.endRound - coverage.startRound + 1 : Math.min(remainingRounds, loaded.rounds.length);
            const result = await locateConversationContext([{ ...candidate, sourcePartial: undefined }], query, {
                probe: true, source: budget.source, mode: budget.mode, maxFiles: 1,
                maxBytes: budget.maxBytes - scannedBytes, maxHits: budget.maxHits - hits.length,
                maxRounds: Math.max(1, selectedRounds), deadlineMs: Math.max(1, fallbackDeadline - Date.now()),
                isCancelled: budget.isCancelled,
                adapters: { readRounds: async () => ({ rounds: loaded!.rounds,
                    filePath: loaded!.raw.summary.sourcePath, freshness: loaded!.raw.partial ? "unknown" : "fresh",
                    verifiedIdentity: { aliases: loaded!.raw.summary.aliases, uuid: loaded!.raw.summary.uuid, sessionId: loaded!.raw.summary.sessionId },
                }) },
            });
            hits.push(...result.hits);
            scannedBytes += result.scannedBytes;
            scanPartial ||= result.truncated;
            warnings.push(...result.warnings);
            remainingRounds -= Math.max(1, selectedRounds);
            nextEndRound = coverage ? coverage.startRound - 1 : 0;
            if (coverage) warnings.push(`devin_context_probe_range:${candidate.id}:R${coverage.startRound}-R${coverage.endRound}/${coverage.totalRounds}`);
            if (!coverage && loaded.rounds.length > selectedRounds) scanPartial = true;
            if (hits.length || nextEndRound <= 0 || scanPartial) break;
            if (fallbackDeadline === budget.deadlineAt) fallbackDeadline = Math.min(budget.deadlineAt,
                Date.now() + Math.max(0, Math.floor((budget.deadlineAt - Date.now()) / 2)));
        }
    } finally { identityCache?.close(); }
    const partial = sourcePartial || scanPartial || nextEndRound === undefined || nextEndRound > 0;
    if (partial) warnings.push("contextProbe searched bounded Devin rounds; older content or child transcripts may remain unread");
    return { hits, scannedBytes, totalBytes: scannedBytes, partial, cancelled: budget.isCancelled(), warnings: [...new Set(warnings)] };
}

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
            hits: rawHits.filter(hit => hit.role === "user" || hit.role === "assistant").slice(0, budget.maxHits).map(hit => ({
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

export function createContextLocateAdapters(readDevin?: DevinContextReader): ConversationContextLocateAdapters {
    const read: DevinContextReader = readDevin || (async (id, options) => (await import("./devin-conversation.js")).readDevinConversation(id, options));
    return {
    scanStream: (candidate, query, budget) => isDevinSource(candidate, budget) && budget.probe
        ? scanDevinProbe(candidate, query, budget, read) : scanStream(candidate, query, budget),
    readRounds: async (candidate, budget) => {
        if (budget.source === "cache") {
            if (!candidate.cacheKey || !candidate.cacheGeneration) throw new Error("cache-only candidate has no verified cache generation");
            const loaded = readCachedConversationSourceCache<Record<string, any>>({ key: candidate.cacheKey, generation: candidate.cacheGeneration });
            if (!loaded) throw new Error("cache-only candidate generation is unavailable");
            const firstRound = budget.probe ? Math.max(1, loaded.roundCount - budget.maxRounds + 1) : 1;
            const cached = iterateCachedConversationSourceCacheRounds<ConversationRound>({ key: candidate.cacheKey, generation: candidate.cacheGeneration, startRound: firstRound });
            if (!cached) throw new Error("cache-only candidate rounds are unavailable");
            if (cached.roundsBytes > budget.maxBytes) return { rounds: [], partial: true, warnings: ["normalized cache exceeds remaining locate budget"] };
            const partial = firstRound > 1 || candidate.sourcePartial || conversationSourceIsPartial(loaded.snapshot) || loaded.snapshot.cacheState === "stale";
            return { rounds: cached.rounds, partial, freshness: "unknown", warnings: partial ? ["cache-only scan contains partial source or bounded recent rounds"] : undefined };
        }
        const devinSource = isDevinSource(candidate, budget);
        if (candidate.sourceBytes !== undefined && candidate.sourceBytes > budget.maxBytes && !(devinSource && budget.probe)) {
            return { rounds: [], partial: true, warnings: ["source size exceeds remaining locate budget; increase maxBytes or use a narrower source"] };
        }
        const cancelled = () => budget.isCancelled() || Date.now() >= budget.deadlineAt;
        if (devinSource) {
            const physicalDesktop = budget.probe && !candidate.isChildThread && !splitDevinSubagentId(candidate.id)
                && candidate.sourceKind === "devin-desktop" && !candidate.sessionId;
            const loaded = await read(candidate.id, {
                maxBytes: budget.probe ? DEVIN_PROBE_SOURCE_BYTES : budget.maxBytes, deadlineMs: budget.deadlineAt, isCancelled: cancelled,
                link: "summary", materializeAttachments: false,
                roundRange: budget.probe && !physicalDesktop && !candidate.isChildThread && !splitDevinSubagentId(candidate.id)
                    ? { tailRounds: Math.min(DEVIN_PROBE_WINDOW_ROUNDS, budget.maxRounds) } : undefined,
                ...(physicalDesktop ? { identityMode: "physical", physicalSourceKind: "devin-desktop" } : {}),
            });
            if (cancelled()) return { rounds: [], partial: true, warnings: ["Devin context scan was cancelled or exceeded its deadline"] };
            if (!loaded) throw new Error("Devin conversation source is unavailable");
            const coverage = loaded.raw.coverage;
            const firstRound = coverage?.startRound ?? (budget.probe ? Math.max(1, loaded.rounds.length - budget.maxRounds + 1) : 1);
            const bounded = firstRound > 1 || Boolean(coverage && coverage.endRound < coverage.totalRounds);
            const partial = bounded || loaded.raw.partial;
            return { rounds: loaded.rounds.filter(round => round.roundIndex >= firstRound), partial,
                filePath: loaded.raw.summary.sourcePath, freshness: loaded.raw.partial ? "unknown" : "fresh",
                verifiedIdentity: { aliases: loaded.raw.summary.aliases, uuid: loaded.raw.summary.uuid, sessionId: loaded.raw.summary.sessionId },
                warnings: [...loaded.raw.warnings, ...(bounded ? ["contextProbe searched a bounded recent-round window"] : [])] };
        }
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
        const partial = firstRound > 1 || candidate.sourcePartial || loaded.cacheState === "stale" || Boolean(loaded.cacheBuildFailure) || conversationSourceIsPartial(loaded) || (!cached && !loaded.rounds.length);
        return {
            rounds: cached?.rounds || loaded.rounds.filter(round => round.roundIndex >= firstRound),
            partial,
            filePath: loaded.cacheFingerprint?.path || candidate.sourcePath,
            freshness: partial ? "unknown" : "fresh",
            warnings: partial ? [firstRound > 1 ? "contextProbe searched a bounded recent-round window" : "source cache is stale or source reported incomplete content"] : undefined,
        };
    },
    };
}

export const defaultContextLocateAdapters: ConversationContextLocateAdapters = createContextLocateAdapters();
