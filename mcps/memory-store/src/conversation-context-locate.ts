import type { ConversationRound } from "./trajectory.js";
import { getRoundUserMessages } from "./trajectory.js";
import type { UnifiedConversationCandidate, ConversationSource } from "./conversation-filter.js";

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
    resolution: "ambiguous" | "unique_in_scope" | "unverified" | "no_match";
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
    partial?: boolean;
    warnings?: string[];
    filePath?: string;
    freshness?: "fresh" | "unknown";
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
    for (const message of getRoundUserMessages(round)) {
        if (message.stepIndex !== undefined && hiddenSteps.has(message.stepIndex)) continue;
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

function matchingSnippet(text: string, query: string, mode: LocateMode): string | null {
    const visible = redactLocateText(text);
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
            if (Date.now() >= budget.deadlineAt || budget.isCancelled()) { budgetStopped = true; partial = true; break; }
            const bytes = Buffer.byteLength(message.text, "utf8");
            if (bytes > budget.maxBytes - scannedBytes) { budgetStopped = true; partial = true; break; }
            scannedBytes += bytes;
            const snippet = matchingSnippet(message.text, query, budget.mode);
            if (snippet !== null) {
                hits.push({
                    ...candidateHitIdentity(candidate),
                    source: "message_body_hit", mode: budget.mode, roundIndex: round.roundIndex,
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
    let scannedFiles = 0;
    let scannedBytes = 0;
    let totalBytes = 0;
    let partial = Boolean(options.candidatesPartial) || unique.length > maxFiles;
    let cancelled = false;
    for (const candidate of unique.slice(0, maxFiles)) {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (options.isCancelled?.()) { cancelled = true; break; }
        if (Date.now() >= deadlineAt || scannedBytes >= maxBytes || hits.length >= maxHits) { partial = true; break; }
        const budget: ContextLocateReadBudget = {
            maxBytes: maxBytes - scannedBytes, maxHits: maxHits - hits.length,
            maxRounds: locatePositiveInteger(options.maxRounds, options.probe ? 100 : 100_000),
            deadlineAt, isCancelled: () => Boolean(options.isCancelled?.()),
            source: options.source || "auto", probe: Boolean(options.probe), mode: options.mode || "exact",
        };
        try {
            const result = await adapters.scanStream?.(candidate, query, budget)
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
            warnings.push(`${candidate.dataChain}:${candidate.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        scannedFiles++;
        options.onProgress?.({ current: scannedFiles, total: unique.length, scannedBytes, hits: hits.length, stage: "context_scan", detail: `${candidate.dataChain}:${candidate.id}` });
        if (cancelled) break;
    }
    cancelled ||= Boolean(options.isCancelled?.());
    partial ||= scannedFiles < unique.length || cancelled;
    const identities = new Set(hits.map(hit => `${hit.dataChain}:${hit.conversationId}`));
    return {
        status: cancelled ? "cancelled" : partial ? hits.length ? "partial_found_scanning" : "budget_exhausted" : hits.length ? "found" : "no_hit_after_full_scan",
        scannedFiles, totalFiles: unique.length, scannedBytes, totalBytes, hits, truncated: partial,
        reason: cancelled ? "cancelled" : partial ? "bounded_or_incomplete_source_scan" : undefined,
        warnings: [...new Set(warnings)].slice(0, 20),
        resolution: identities.size > 1 ? "ambiguous" : partial ? "unverified" : identities.size === 1 ? "unique_in_scope" : "no_match",
        scope: "provided_candidates",
    };
}

export function annotateContextLocateCandidates(candidates: UnifiedConversationCandidate[], result: ConversationContextLocateResult): UnifiedConversationCandidate[] {
    return candidates.map(candidate => {
        const hits = result.hits.filter(hit => hit.dataChain === candidate.dataChain && hit.conversationId === candidate.id);
        return hits.length ? { ...candidate, contextProbe: hits.slice(0, 3).map(hit => `[${hit.role}] R${hit.roundIndex}${hit.sourcePosition.childConversationId ? ` child=${hit.sourcePosition.childConversationId}` : ""} ${hit.snippet}`) } : candidate;
    });
}
