import { workspaceMatches } from "./conversation-filter.js";
export const CORPUS_QUERY_SEMANTIC_VERSION = "literal-corpus/v2";
import type {
    CorpusConversation,
    CorpusMessage,
    CorpusMessageRole,
    CorpusProjection,
    CorpusSearchExpression,
    CorpusSearchRequest,
    CorpusSourcePosition,
} from "./conversation-corpus-types.js";

export interface CorpusMatchSnippet {
    messageId: string;
    round: number;
    role: CorpusMessageRole;
    timestamp: string | null;
    term: string;
    matchStart: number;
    matchEnd: number;
    snippetStart: number;
    snippetEnd: number;
    text: string;
    position: CorpusSourcePosition;
    revision: string;
    sourceRevision: string;
    cacheGeneration?: string;
}

export interface CorpusConversationMatch {
    conversation: CorpusConversation;
    revision: string;
    sourceRevision: string;
    round: number | null;
    cacheGeneration?: string;
    provisional: boolean;
    termCounts: Record<string, number>;
    occurrences: number;
    matchedMessages: number;
    matchingScopes: number;
    rounds: number[];
    latestMatchAt: string | null;
    latestMatchTimeSource: "message_timestamp" | "unknown";
    snippets: CorpusMatchSnippet[];
    warnings: string[];
}

interface CompiledTerm {
    value: string;
    pattern: RegExp;
    positive: boolean;
}

export interface CompiledCorpusSearch {
    request: CorpusSearchRequest;
    terms: CompiledTerm[];
    expression: CorpusSearchExpression;
}

interface RoundCounts {
    counts: number[];
    matchedMessages: number;
    scannedMessages: number;
    matchingMessages: number;
    latestMatchAt: string | null;
    snippets: CorpusMatchSnippet[];
}

function literalPattern(term: string): string {
    return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validTerms(value: unknown, label: string): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(term => typeof term !== "string" || !term.trim())) {
        throw new Error(`${label} must be an array of nonempty literal terms`);
    }
    return value as string[];
}

function validateExpression(expression: CorpusSearchExpression, depth = 0, budget = { nodes: 0 }): void {
    if (!expression || typeof expression !== "object" || depth > 64 || ++budget.nodes > 1024) {
        throw new Error("Invalid or excessive corpus search expression");
    }
    const keys = Object.keys(expression);
    if (keys.length !== 1 || !["term", "all", "any", "not"].includes(keys[0])) {
        throw new Error("Each expression node must contain exactly one of term/all/any/not");
    }
    if (expression.term !== undefined) {
        if (typeof expression.term !== "string" || !expression.term.trim()) throw new Error("Empty expression term");
    } else if (expression.not !== undefined) {
        validateExpression(expression.not, depth + 1, budget);
    } else {
        const children = expression.all ?? expression.any;
        if (!Array.isArray(children) || !children.length) throw new Error("Expression all/any requires children");
        for (const child of children) validateExpression(child, depth + 1, budget);
    }
}

export function normalizeCodexCorpusConversationId(value: string): string {
    return value.trim().replace(/^codex:\/\/threads\//iu, "").toLowerCase();
}

export function compileCorpusSearch(request: CorpusSearchRequest): CompiledCorpusSearch {
    if (!request || typeof request !== "object") throw new Error("Corpus search request is required");
    const copy = JSON.parse(JSON.stringify(request)) as CorpusSearchRequest;
    if (copy.purpose !== undefined && copy.purpose !== "prepare") throw new Error("Invalid corpus purpose");
    if (copy.purpose === "prepare" && (!Array.isArray(copy.conversationIds) || copy.conversationIds.length !== 1)) {
        throw new Error("Corpus preparation requires exactly one target conversation");
    }
    if (copy.query !== undefined && (typeof copy.query !== "string" || !copy.query.trim())) {
        throw new Error("query must be a nonempty literal string");
    }
    const allTerms = validTerms(copy.allTerms, "allTerms");
    const anyTerms = validTerms(copy.anyTerms, "anyTerms");
    const excludeTerms = validTerms(copy.excludeTerms, "excludeTerms");
    for (const key of ["workspaces", "conversationIds"] as const) validTerms(copy[key], key);
    if (copy.conversationIds) copy.conversationIds = [...new Set(copy.conversationIds.map(normalizeCodexCorpusConversationId))];
    if (copy.intersectionScope && !["conversation", "round", "message"].includes(copy.intersectionScope)) {
        throw new Error("Invalid intersectionScope");
    }
    if (copy.sort && !["latest_match", "activity", "occurrences", "messages"].includes(copy.sort)) {
        throw new Error("Invalid corpus sort");
    }
    if (copy.workspaceMode && !["contains", "exact", "under", "any", "all"].includes(copy.workspaceMode)) {
        throw new Error("Invalid workspaceMode");
    }
    if (copy.caseSensitive !== undefined && typeof copy.caseSensitive !== "boolean") throw new Error("Invalid caseSensitive");
    if (copy.forceRefresh !== undefined && typeof copy.forceRefresh !== "boolean") throw new Error("Invalid forceRefresh");
    if (copy.messageRoles !== undefined && (!Array.isArray(copy.messageRoles) || !copy.messageRoles.length
        || copy.messageRoles.some(role => !["user", "assistant", "tool", "subagent"].includes(role)))) {
        throw new Error("Invalid messageRoles");
    }
    const children: CorpusSearchExpression[] = [];
    if (copy.query) children.push({ term: copy.query });
    children.push(...allTerms.map(term => ({ term })));
    if (anyTerms.length) children.push({ any: anyTerms.map(term => ({ term })) });
    children.push(...excludeTerms.map(term => ({ not: { term } })));
    if (copy.expression) {
        validateExpression(copy.expression);
        children.push(copy.expression);
    }
    if (copy.purpose === "prepare" && children.length) throw new Error("Corpus preparation does not accept search conditions");
    if (!children.length && copy.purpose !== "prepare") throw new Error("At least one corpus search condition is required");
    const expression: CorpusSearchExpression = { all: children };
    const terms: CompiledTerm[] = [];
    const indexed = new Map<string, CompiledTerm>();
    const visit = (node: CorpusSearchExpression, positive = true): void => {
        if (node.term !== undefined) {
            const key = node.term;
            const known = indexed.get(key);
            if (known) known.positive ||= positive;
            else {
                const term = { value: node.term, pattern: new RegExp(literalPattern(node.term), copy.caseSensitive ? "gu" : "giu"), positive };
                terms.push(term);
                indexed.set(key, term);
            }
        } else if (node.not) visit(node.not, !positive);
        else for (const child of node.all ?? node.any ?? []) visit(child, positive);
    };
    visit(expression);
    copy.intersectionScope ??= "conversation";
    copy.messageRoles ??= ["user", "assistant"];
    if (copy.purpose === "prepare") copy.messageRoles = ["user", "assistant", "subagent"];
    copy.sort ??= "latest_match";
    copy.caseSensitive ??= false;
    return { request: copy, terms, expression };
}

export function corpusConversationMatchesScope(conversation: CorpusConversation, request: CorpusSearchRequest): boolean {
    return (!request.conversationIds?.length || request.conversationIds.includes(conversation.id))
        && workspaceMatches(conversation.workspace, request.workspaces, request.workspaceMode ?? "contains");
}

function evaluate(expression: CorpusSearchExpression, present: Set<string>): boolean {
    if (expression.term !== undefined) return present.has(expression.term);
    if (expression.not) return !evaluate(expression.not, present);
    if (expression.all) return expression.all.every(child => evaluate(child, present));
    return expression.any!.some(child => evaluate(child, present));
}

function laterTimestamp(current: string | null, candidate: string | undefined | null): string | null {
    if (!candidate || !Number.isFinite(Date.parse(candidate))) return current;
    return !current || Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

export class CorpusSearchAccumulator {
    readonly compiled: CompiledCorpusSearch;
    private readonly groups = new Map<number, RoundCounts>();
    private readonly seen = new Map<string, number>();
    private readonly mirrorsByRound = new Map<number, number>();
    private readonly warnings: string[];
    private readonly maxSnippets: number;
    private readonly snippetChars: number;
    private mirrorCount = 0;

    constructor(
        readonly conversation: CorpusConversation,
        request: CorpusSearchRequest | CompiledCorpusSearch,
        readonly source: { revision: string; cacheGeneration?: string; warnings?: string[] },
        options: { maxSnippets?: number; snippetChars?: number } = {},
    ) {
        this.compiled = "terms" in request ? request as CompiledCorpusSearch : compileCorpusSearch(request);
        this.warnings = [...source.warnings ?? []];
        this.maxSnippets = Math.max(0, Math.min(10, Math.floor(options.maxSnippets ?? 3)));
        this.snippetChars = Math.max(32, Math.min(1000, Math.floor(options.snippetChars ?? 180)));
    }

    get scannedMessages(): number { return this.seen.size; }
    get mirrorMessagesSkipped(): number { return this.mirrorCount; }

    private matches(counts: number[]): boolean {
        const present = new Set<string>();
        this.compiled.terms.forEach((term, index) => {
            if (counts[index]) present.add(term.value);
        });
        return evaluate(this.compiled.expression, present);
    }

    append(message: CorpusMessage): void {
        if (!this.compiled.request.messageRoles!.includes(message.role)) return;
        if (typeof message.id !== "string" || !message.id || !Number.isInteger(message.round) || message.round < 1
            || typeof message.text !== "string") throw new Error("Invalid corpus message identity/round/text");
        if (this.seen.has(message.id)) {
            this.mirrorCount++;
            const originalRound = this.seen.get(message.id)!;
            this.mirrorsByRound.set(originalRound, (this.mirrorsByRound.get(originalRound) ?? 0) + 1);
            return;
        }
        this.seen.set(message.id, message.round);
        const counts: number[] = [];
        let firstHit: { term: string; start: number; end: number } | undefined;
        for (const term of this.compiled.terms) {
            term.pattern.lastIndex = 0;
            let count = 0;
            let match: RegExpExecArray | null;
            while ((match = term.pattern.exec(message.text)) !== null) {
                count++;
                if (term.positive && !firstHit) firstHit = { term: term.value, start: match.index, end: match.index + match[0].length };
            }
            counts.push(count);
        }
        let group = this.groups.get(message.round);
        if (!group) {
            group = { counts: counts.map(() => 0), matchedMessages: 0, scannedMessages: 0, matchingMessages: 0, latestMatchAt: null, snippets: [] };
            this.groups.set(message.round, group);
        }
        group.scannedMessages++;
        const matchesMessage = this.matches(counts);
        if (this.compiled.request.intersectionScope === "message" && !matchesMessage) return;
        group.matchingMessages++;
        counts.forEach((count, index) => group!.counts[index] += count);
        if (firstHit || matchesMessage) {
            group.matchedMessages++;
            group.latestMatchAt = laterTimestamp(group.latestMatchAt, message.timestamp);
        }
        if (!firstHit) return;
        if (group.snippets.length < this.maxSnippets) {
            const snippetStart = Math.max(0, firstHit.start - Math.floor(this.snippetChars / 3));
            const snippetEnd = Math.min(message.text.length, snippetStart + this.snippetChars);
            group.snippets.push({
                messageId: message.id, round: message.round, role: message.role, timestamp: message.timestamp ?? null,
                term: firstHit.term, matchStart: firstHit.start, matchEnd: firstHit.end, snippetStart, snippetEnd,
                text: message.text.slice(snippetStart, snippetEnd), position: { ...message.position },
                revision: this.source.revision, sourceRevision: this.source.revision, cacheGeneration: this.source.cacheGeneration,
            });
        }
    }

    replaceFromRound(round: number, messages: Iterable<CorpusMessage>, source?: { revision: string; cacheGeneration?: string }): void {
        if (!Number.isInteger(round) || round < 1) throw new Error("replaceFromRound must be a positive normalized round");
        const replacement = [...messages];
        if (replacement.some(message => message.round < round)) throw new Error("Replacement contains messages before replaceFromRound");
        for (const key of this.groups.keys()) if (key >= round) this.groups.delete(key);
        for (const [messageId, messageRound] of this.seen) if (messageRound >= round) this.seen.delete(messageId);
        for (const [messageRound, count] of this.mirrorsByRound) if (messageRound >= round) {
            this.mirrorCount -= count;
            this.mirrorsByRound.delete(messageRound);
        }
        if (source) {
            Object.assign(this.source, source);
            for (const group of this.groups.values()) for (const snippet of group.snippets) {
                snippet.revision = source.revision;
                snippet.sourceRevision = source.revision;
                snippet.cacheGeneration = source.cacheGeneration;
            }
        }
        for (const message of replacement) this.append(message);
    }

    snapshot(complete = false): CorpusConversationMatch | null {
        if (this.compiled.request.purpose === "prepare") return null;
        if (!corpusConversationMatchesScope(this.conversation, this.compiled.request)) return null;
        const counts = this.compiled.terms.map(() => 0);
        const scope = this.compiled.request.intersectionScope;
        const groups = [...this.groups.entries()].sort(([left], [right]) => left - right);
        const eligible = scope === "conversation" ? groups : groups.filter(([, group]) => scope === "round"
            ? this.matches(group.counts) : group.matchingMessages > 0);
        let matchedMessages = 0;
        let matchingScopes = 0;
        let latestMatchAt: string | null = null;
        const rounds: number[] = [];
        const snippets: CorpusMatchSnippet[] = [];
        const hasPositive = this.compiled.terms.some(term => term.positive);
        for (const [round, group] of eligible) {
            group.counts.forEach((count, index) => counts[index] += count);
            matchedMessages += group.matchedMessages;
            matchingScopes += scope === "message" ? group.matchingMessages : 1;
            latestMatchAt = laterTimestamp(latestMatchAt, group.latestMatchAt);
            if (group.matchedMessages || !hasPositive) rounds.push(round);
            if (snippets.length < this.maxSnippets) snippets.push(...group.snippets.slice(0, this.maxSnippets - snippets.length));
        }
        if (scope === "conversation" ? !this.matches(counts) : !matchingScopes) return null;
        const termCounts = Object.fromEntries(this.compiled.terms.map((term, index) => [term.value, counts[index]]));
        return {
            conversation: { ...this.conversation }, revision: this.source.revision, sourceRevision: this.source.revision,
            round: snippets[0]?.round ?? (hasPositive ? rounds[0] ?? null : null), cacheGeneration: this.source.cacheGeneration,
            provisional: !complete, termCounts,
            occurrences: this.compiled.terms.reduce((total, term, index) => total + (term.positive ? counts[index] : 0), 0),
            matchedMessages, matchingScopes: scope === "conversation" ? 1 : matchingScopes, rounds,
            latestMatchAt, latestMatchTimeSource: latestMatchAt ? "message_timestamp" : "unknown", snippets,
            warnings: [...this.warnings],
        };
    }
}

export function searchCorpusProjection(projection: CorpusProjection, request: CorpusSearchRequest): CorpusConversationMatch | null {
    const accumulator = new CorpusSearchAccumulator(projection.conversation, request, projection);
    for (const message of projection.messages) accumulator.append(message);
    return accumulator.snapshot(projection.complete);
}

export function sortCorpusMatches(matches: Iterable<CorpusConversationMatch>, sort: CorpusSearchRequest["sort"] = "latest_match"): CorpusConversationMatch[] {
    const timestamp = (value: string | undefined | null): number => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : -Infinity;
    const score = (item: CorpusConversationMatch): number => sort === "occurrences" ? item.occurrences
        : sort === "messages" ? item.matchedMessages : sort === "activity" ? timestamp(item.conversation.updatedAt) : timestamp(item.latestMatchAt);
    return [...matches].sort((left, right) => {
        const leftScore = score(left);
        const rightScore = score(right);
        if (leftScore !== rightScore) return leftScore > rightScore ? -1 : 1;
        return left.conversation.id < right.conversation.id ? -1 : left.conversation.id > right.conversation.id ? 1 : 0;
    });
}
