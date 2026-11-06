import type { ConversationRound } from "./trajectory.js";
import { getRoundUserMessages } from "./trajectory.js";
import type { UnifiedConversationCandidate, ConversationSource } from "./conversation-filter.js";
import { matchContextProbeText } from "./context-probe-text.js";

export type LocateMode = "exact" | "fuzzy";
export type LocateRawSource = "auto" | "local" | "ls" | "cache";

export interface ConversationContextHit {
    conversationId: string;
    dataChain: ConversationSource;
    aliases?: string[];
    uuid?: string;
    sessionId?: string;
    sourceKind?: string;
    isChildThread?: boolean;
    parentConversationId?: string | null;
    title?: string;
    workspace?: string;
    source: "message_body_hit";
    mode: LocateMode;
    roundIndex: number;
    roundIndexIsRelative?: boolean;
    role: string;
    rawRole?: string;
    snippet: string;
    filePath?: string;
    byteOffset?: number;
    sourcePosition: {
        kind: "jsonl" | "round";
        roundIndex: number;
        stepIndex?: number;
        nodeId?: number | string;
        messageId?: number | string;
        childConversationId?: string;
    };
    freshness: "fresh" | "unknown";
}

export interface ConversationContextLocateResult {
    status: "found" | "partial_found_scanning" | "no_hit_after_full_scan" | "budget_exhausted" | "cancelled";
    scannedFiles: number;
    totalFiles: number;
    scannedBytes: number;
    totalBytes: number;
    hits: ConversationContextHit[];
    truncated: boolean;
    reason?: string;
    warnings: string[];
    resolution: "ambiguous" | "unique_in_scope" | "single_match_in_partial_scan" | "unverified" | "no_match";
    matchedConversationCount?: number;
    matchIdentityScope?: "provided_candidates" | "listed_threads";
    candidateFailures?: Array<{ dataChain: ConversationSource; conversationId: string; error: string }>;
    scope: "provided_candidates";
}

export interface ContextLocateReadBudget {
    maxBytes: number;
    maxHits: number;
    maxRounds: number;
    deadlineAt: number;
    isCancelled: () => boolean;
    source: LocateRawSource;
    probe: boolean;
    mode: LocateMode;
}

export interface ContextLocateRoundSource {
    rounds: Iterable<ConversationRound> | AsyncIterable<ConversationRound>;
    roundIndexIsRelative?: boolean;
    partial?: boolean;
    warnings?: string[];
    filePath?: string;
    freshness?: "fresh" | "unknown";
    verifiedIdentity?: Pick<UnifiedConversationCandidate, "aliases" | "uuid" | "sessionId">;
}

export interface ContextLocateScanResult {
    hits: ConversationContextHit[];
    scannedBytes: number;
    totalBytes?: number;
    partial?: boolean;
    cancelled?: boolean;
    warnings?: string[];
}

export interface ConversationContextLocateAdapters {
    readRounds(candidate: UnifiedConversationCandidate, budget: ContextLocateReadBudget): Promise<ContextLocateRoundSource>;
    scanStream?(candidate: UnifiedConversationCandidate, query: string, budget: ContextLocateReadBudget): Promise<ContextLocateScanResult | null>;
}

export interface ConversationContextLocateSharedBudget {
    remainingFiles: number;
    remainingBytes: number;
    remainingHits: number;
    activeReads: number;
    concurrency: number;
}

export interface ConversationContextLocateOptions {
    mode?: LocateMode;
    probe?: boolean;
    source?: LocateRawSource;
    maxFiles?: number;
    maxBytes?: number;
    maxHits?: number;
    maxRounds?: number;
    deadlineMs?: number;
    candidatesPartial?: boolean;
    isCancelled?: () => boolean;
    onProgress?: (progress: { current: number; total: number; scannedBytes: number; hits: number; stage: string; detail?: string }) => void;
    onCheckpoint?: (result: ConversationContextLocateResult) => void | Promise<void>;
    sharedBudget?: ConversationContextLocateSharedBudget;
    reserveFollowup?: boolean;
    adapters?: ConversationContextLocateAdapters;
}

export function locatePositiveInteger(value: number | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
    return Number.isFinite(value) && value! > 0 ? Math.min(Math.floor(value!), maximum) : fallback;
}

export function redactLocateText(text: string): string {
    return text.replace(/data:[^\s;,]+;base64,[A-Za-z0-9+/=\r\n]+/gu, "[inline image omitted]")
        .replace(/(["']?base64_data["']?\s*:\s*["'])[^"']*(["'])/gu, "$1[omitted]$2");
}

function normalizedText(text: string): string {
    return text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

interface SearchableMessage {
    role: string;
    rawRole?: string;
    text: string;
    stepIndex?: number;
    childConversationId?: string;
}

function* roundMessages(round: ConversationRound): Iterable<SearchableMessage> {
    const seen = new Set<string>();
    const unique = function* (message: SearchableMessage): Iterable<SearchableMessage> {
        const key = `${message.role}:${message.stepIndex ?? ""}:${message.childConversationId || ""}:${message.text}`;
        if (!message.text || seen.has(key)) return;
        seen.add(key);
        yield message;
    };
    const hiddenSteps = new Set((round.semanticEvents || []).filter(event => event.semanticRole === "system").map(event => event.stepIndex));
    const userSteps = new Set((round.semanticEvents || []).filter(event => event.semanticRole === "user" && !event.automation).map(event => event.stepIndex));
    for (const message of getRoundUserMessages(round)) {
        if (message.stepIndex !== undefined && hiddenSteps.has(message.stepIndex) && !userSteps.has(message.stepIndex)) continue;
        yield* unique({ role: "user", rawRole: message.rawRole, text: message.text, stepIndex: message.stepIndex });
    }
    for (const response of round.aiResponses || []) {
        yield* unique({ role: "assistant", text: response.response, stepIndex: response.stepIndex });
        yield* unique({ role: "reasoning", text: response.thinking, stepIndex: response.stepIndex });
    }
    for (const tool of round.toolCalls || []) {
        yield* unique({ role: "tool_args", text: tool.argsFull || tool.argsSummary, stepIndex: tool.stepIndex });
        yield* unique({ role: "tool_result", text: tool.resultFull || tool.resultSummary, stepIndex: tool.stepIndex });
    }
    for (const agent of round.subagentSummaries || []) {
        yield* unique({ role: "subagent", rawRole: agent.rawRole, text: agent.summary || agent.prompt || "", childConversationId: agent.threadId });
    }
    for (const event of round.semanticEvents || []) {
        if (event.semanticRole === "system" || event.semanticRole === "user" || event.automation) continue;
        const role = event.semanticRole === "model" ? "assistant" : event.semanticRole;
        yield* unique({ role, rawRole: event.rawRole, text: event.text || "", stepIndex: event.stepIndex, childConversationId: event.subagent?.threadId });
        if (role === "tool") {
            yield* unique({ role: "tool_args", rawRole: event.rawRole, text: event.argsFull || "", stepIndex: event.stepIndex });
            yield* unique({ role: "tool_result", rawRole: event.rawRole, text: event.resultFull || event.resultSummary || "", stepIndex: event.stepIndex });
        }
    }
}

function matchingSnippet(text: string, query: string, mode: LocateMode, probe = false): string | null {
    const visible = redactLocateText(text);
    if (probe) return matchContextProbeText(visible, query);
    const display = visible.normalize("NFKC").replace(/\s+/gu, " ").trim();
    const normalized = display.toLowerCase();
    const needle = normalizedText(query);
    let offset = normalized.indexOf(needle);
    if (offset < 0 && mode === "fuzzy") {
        const terms = needle.split(" ").filter(Boolean);
        if (terms.length > 1 && terms.every(term => normalized.includes(term))) offset = normalized.indexOf(terms[0]);
    }
    if (offset < 0) return null;
    return display.slice(Math.max(0, offset - 80), offset + Math.min(needle.length, 240) + 100);
}

export function candidateHitIdentity(candidate: UnifiedConversationCandidate) {
    return {
        conversationId: candidate.id,
        dataChain: candidate.dataChain,
        aliases: candidate.aliases,
        uuid: candidate.uuid,
        sessionId: candidate.sessionId,
        sourceKind: candidate.sourceKind,
        isChildThread: candidate.isChildThread,
        parentConversationId: candidate.parentConversationId,
        title: candidate.title,
        workspace: candidate.workspace,
    };
}

async function scanRounds(candidate: UnifiedConversationCandidate, query: string, budget: ContextLocateReadBudget, adapters: ConversationContextLocateAdapters): Promise<ContextLocateScanResult> {
    const loaded = await adapters.readRounds(candidate, budget);
    const hits: ConversationContextHit[] = [];
    let scannedBytes = 0;
    let roundCount = 0;
    let partial = Boolean(loaded.partial);
    let budgetStopped = false;
    for await (const round of loaded.rounds) {
        if (budget.isCancelled()) return { hits, scannedBytes, partial: true, cancelled: true };
        if (++roundCount > budget.maxRounds || Date.now() >= budget.deadlineAt) { partial = true; break; }
        for (const message of roundMessages(round)) {
            if (budget.probe && message.role !== "user" && message.role !== "assistant") continue;
            if (Date.now() >= budget.deadlineAt || budget.isCancelled()) { budgetStopped = true; partial = true; break; }
            const bytes = Buffer.byteLength(message.text, "utf8");
            if (bytes > budget.maxBytes - scannedBytes) { budgetStopped = true; partial = true; break; }
            scannedBytes += bytes;
            const snippet = matchingSnippet(message.text, query, budget.mode, budget.probe);
            if (snippet !== null) {
                hits.push({
                    ...candidateHitIdentity(candidate), ...loaded.verifiedIdentity,
                    source: "message_body_hit", mode: budget.mode, roundIndex: round.roundIndex,
                    ...(loaded.roundIndexIsRelative ? { roundIndexIsRelative: true } : {}),
                    role: message.role, rawRole: message.rawRole, snippet,
                    filePath: loaded.filePath,
                    sourcePosition: { kind: "round", roundIndex: round.roundIndex, stepIndex: message.stepIndex, childConversationId: message.childConversationId },
                    freshness: loaded.freshness || "unknown",
                });
                if (hits.length >= budget.maxHits) { budgetStopped = true; partial = true; break; }
            }
        }
        if (budgetStopped) break;
        if (roundCount % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    return { hits, scannedBytes, partial, warnings: loaded.warnings };
}

export async function locateConversationContext(candidates: UnifiedConversationCandidate[], query: string, options: ConversationContextLocateOptions = {}): Promise<ConversationContextLocateResult> {
    if (!query.trim()) throw new Error("context locate requires a non-empty query");
    const maxFiles = locatePositiveInteger(options.maxFiles, options.probe ? 50 : 20, 20_000);
    const maxBytes = locatePositiveInteger(options.maxBytes, options.probe ? 16 * 1024 * 1024 : 512 * 1024 * 1024);
    const maxHits = locatePositiveInteger(options.maxHits, 20, 1000);
    const deadlineAt = Date.now() + locatePositiveInteger(options.deadlineMs, options.probe ? 12_000 : 300_000);
    const adapters = options.adapters || (await import("./conversation-context-locate-adapters.js")).defaultContextLocateAdapters;
    const seen = new Set<string>();
    const unique = candidates.filter(candidate => {
        const key = `${candidate.dataChain}:${candidate.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    const hits: ConversationContextHit[] = [];
    const warnings: string[] = [];
    const candidateFailures: NonNullable<ConversationContextLocateResult["candidateFailures"]> = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let totalBytes = 0;
    let partial = Boolean(options.candidatesPartial) || unique.length > maxFiles;
    let cancelled = false;
    const checkpoint = (): ConversationContextLocateResult => {
        const incomplete = partial || scannedFiles < unique.length || cancelled;
        const identities = new Set(hits.map(hit => `${hit.dataChain}:${hit.conversationId}`));
        return {
            status: cancelled ? "cancelled" : incomplete ? hits.length ? "partial_found_scanning" : "budget_exhausted" : hits.length ? "found" : "no_hit_after_full_scan",
            scannedFiles, totalFiles: unique.length, scannedBytes, totalBytes, hits: [...hits], truncated: incomplete,
            reason: cancelled ? "cancelled" : incomplete ? "bounded_or_incomplete_source_scan" : undefined,
            warnings: [...new Set(warnings)].slice(0, 20),
            resolution: contextLocateResolution(identities.size, incomplete),
            matchedConversationCount: identities.size, matchIdentityScope: "provided_candidates", candidateFailures: [...candidateFailures],
            scope: "provided_candidates",
        };
    };
    for (const candidate of unique.slice(0, maxFiles)) {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (options.isCancelled?.()) { cancelled = true; break; }
        if (Date.now() >= deadlineAt || scannedBytes >= maxBytes || hits.length >= maxHits) { partial = true; break; }
        const shared = options.sharedBudget;
        while (shared && shared.activeReads > 0 && shared.remainingFiles > 0 && (shared.remainingBytes <= 0 || shared.remainingHits <= 0)
            && Date.now() < deadlineAt && !options.isCancelled?.()) {
            await new Promise<void>(resolve => setTimeout(resolve, 5));
        }
        if (options.isCancelled?.()) { cancelled = true; break; }
        if (Date.now() >= deadlineAt || shared && (shared.remainingFiles <= 0 || shared.remainingBytes <= 0 || shared.remainingHits <= 0)) { partial = true; break; }
        const slots = shared ? Math.max(1, Math.min(shared.remainingFiles, maxFiles - scannedFiles,
            Math.max(1, shared.concurrency - shared.activeReads,
                Math.min(4, unique.length - scannedFiles + (options.reserveFollowup ? 1 : 0))))) : 1;
        const reservedBytes = Math.min(maxBytes - scannedBytes, shared ? Math.ceil(shared.remainingBytes / slots) : maxBytes);
        const reservedHits = Math.min(maxHits - hits.length, shared ? Math.ceil(shared.remainingHits / slots) : maxHits);
        if (shared) {
            shared.remainingFiles--;
            shared.remainingBytes -= reservedBytes;
            shared.remainingHits -= reservedHits;
            shared.activeReads++;
        }
        const remainingMs = deadlineAt - Date.now();
        const candidateMs = options.probe ? Math.min(remainingMs, Math.max(250, Math.min(3000, Math.floor(remainingMs / Math.min(4, Math.max(1, Math.min(maxFiles, unique.length) - scannedFiles)))))) : remainingMs;
        const budget: ContextLocateReadBudget = {
            maxBytes: reservedBytes, maxHits: reservedHits,
            maxRounds: locatePositiveInteger(options.maxRounds, options.probe ? 100 : 100_000),
            deadlineAt: Date.now() + candidateMs, isCancelled: () => Boolean(options.isCancelled?.()),
            source: options.source || "auto", probe: Boolean(options.probe), mode: options.mode || "exact",
        };
        let result: ContextLocateScanResult | undefined;
        try {
            result = await adapters.scanStream?.(candidate, query, budget)
                || await scanRounds(candidate, query, budget, adapters);
            hits.push(...result.hits.slice(0, budget.maxHits));
            scannedBytes += result.scannedBytes;
            totalBytes += result.totalBytes ?? result.scannedBytes;
            partial ||= Boolean(result.partial || candidate.sourcePartial) || Date.now() >= deadlineAt;
            cancelled ||= Boolean(result.cancelled);
            warnings.push(...(result.warnings || []));
        } catch (error) {
            partial = true;
            if (options.isCancelled?.()) cancelled = true;
            const message = error instanceof Error ? error.message : String(error);
            candidateFailures.push({ dataChain: candidate.dataChain, conversationId: candidate.id, error: message });
            warnings.push(`${candidate.dataChain}:${candidate.id}: ${message}`);
        } finally {
            if (shared) {
                shared.activeReads--;
                shared.remainingBytes += reservedBytes - (result ? Math.min(reservedBytes, Math.max(0, result.scannedBytes)) : reservedBytes);
                shared.remainingHits += reservedHits - Math.min(reservedHits, result?.hits.length || 0);
            }
        }
        scannedFiles++;
        options.onProgress?.({ current: scannedFiles, total: unique.length, scannedBytes, hits: hits.length, stage: "context_scan", detail: `${candidate.dataChain}:${candidate.id}` });
        await options.onCheckpoint?.(checkpoint());
        if (cancelled) break;
    }
    cancelled ||= Boolean(options.isCancelled?.());
    partial ||= scannedFiles < unique.length || cancelled;
    return checkpoint();
}

export function contextLocateResolution(matches: number, partial: boolean): ConversationContextLocateResult["resolution"] {
    return matches > 1 ? "ambiguous" : matches === 1 ? partial ? "single_match_in_partial_scan" : "unique_in_scope" : partial ? "unverified" : "no_match";
}

export function annotateContextLocateCandidates(candidates: UnifiedConversationCandidate[], result: ConversationContextLocateResult): UnifiedConversationCandidate[] {
    return candidates.map(candidate => {
        const hits = result.hits.filter(hit => hit.dataChain === candidate.dataChain && hit.conversationId === candidate.id);
        return hits.length ? { ...candidate,
            aliases: [...new Set([...(candidate.aliases ?? []), ...hits.flatMap(hit => hit.aliases ?? [])])],
            uuid: hits.find(hit => hit.uuid)?.uuid ?? candidate.uuid,
            sessionId: hits.find(hit => hit.sessionId)?.sessionId ?? candidate.sessionId,
            contextProbe: hits.slice(0, 3).map(hit => {
                const roundLabel = hit.roundIndexIsRelative ? `相对R${hit.roundIndex}（末段／尾窗起算）` : `R${hit.roundIndex}`;
                return `[${hit.role}] ${roundLabel}${hit.sourcePosition.childConversationId ? ` child=${hit.sourcePosition.childConversationId}` : ""} ${hit.snippet}`;
            }) } : candidate;
    });
}
