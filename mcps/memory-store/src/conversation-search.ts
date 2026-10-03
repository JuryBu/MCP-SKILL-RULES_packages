import {
    getRoundAutomationEvents,
    getRoundSubagentSummaries,
    getRoundUserMessages,
    normalizeMessageRoles,
    parseResponseAnnotations,
    type ConversationMessageRole,
    type ConversationRound,
} from "./trajectory.js";
import { renderConversationAutomationEvent } from "./conversation-automation-event.js";
import { iterateCachedConversationSourceCacheRounds } from "./conversation-source-cache.js";
import type { ConversationLoadResult } from "./conversation-bridge.js";
import { sliceUnicodeSafe } from "./unicode-text.js";
import type { TextBlock } from "./search-engine.js";

export interface ConversationSearchFilter {
    messageRoles?: ConversationMessageRole[];
    startRound?: number;
    endRound?: number;
}

export interface ConversationSearchField {
    role: ConversationMessageRole;
    matchType: "user" | "ai" | "annotation" | "automation" | "system" | "tool" | "subagent";
    text: string;
    annotationIndex?: number;
    annotationField?: "selectedText" | "comment";
    annotationSelectedText?: string;
    annotationComment?: string;
}

export interface ConversationSearchMatch extends Omit<ConversationSearchField, "text"> {
    roundIndex: number;
    matchText: string;
    contextStart: number;
    hitCount: number;
}

export function validateConversationSearchFilter(filter: ConversationSearchFilter): void {
    for (const boundary of [filter.startRound, filter.endRound]) {
        if (boundary !== undefined && (!Number.isSafeInteger(boundary) || boundary < 1)) {
            throw new Error("startRound/endRound 必须为原始 1-based 正整数轮次");
        }
    }
    if (filter.endRound !== undefined && filter.endRound < (filter.startRound ?? 1)) {
        throw new Error("endRound 必须大于或等于 startRound");
    }
}

export function resolveConversationSearchLimit(limit?: number, maxHits?: number): number {
    if (limit !== undefined && maxHits !== undefined && limit !== maxHits) {
        throw new Error("search 的 limit 与 maxHits 冲突，请只传一个或使用相同值");
    }
    const resolved = maxHits ?? limit ?? 8;
    if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error("search limit/maxHits 必须为正整数");
    return resolved;
}

function searchableText(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === undefined || value === null) return "";
    try {
        return JSON.stringify(value) || "";
    } catch {
        return String(value);
    }
}

export function extractConversationSearchFields(round: ConversationRound, filter: ConversationSearchFilter = {}): ConversationSearchField[] {
    const roles = normalizeMessageRoles(filter.messageRoles);
    const includes = (role: ConversationMessageRole): boolean => roles.size === 0 || roles.has(role);
    const fields: ConversationSearchField[] = [];
    const add = (field: ConversationSearchField): void => {
        if (field.text && includes(field.role)) fields.push(field);
    };
    const userMessages = getRoundUserMessages(round);
    const explicitSystems = (round.semanticEvents || []).filter(event => event.semanticRole === "system" && event.kind !== "automation_event" && !event.automation);
    const userText = userMessages.map(message => message.text).join("\n").trimStart();
    const legacySystem = !userMessages.some(message => message.rawRole === "devin-user")
        && explicitSystems.length === 0
        && (Boolean(round.compactionSummaries?.some(summary => summary.provider === "claude-code"))
            || userText.startsWith("[Codex AGENTS/RULES 注入已折叠")
            || userText.startsWith("# AGENTS.md instructions")
            || userText.startsWith("[Claude Code compact summary folded")
            || userText.includes("<<<CLAUDE_CODE_COMPACT_SUMMARY>>>"));
    const seenAnnotations = new Set<string>();
    const userTexts: string[] = [];
    let annotationIndex = 0;
    for (const message of userMessages) {
        if (!includes("user") && !includes(legacySystem ? "system" : "user")) continue;
        const parsed = parseResponseAnnotations(message.text || "");
        if (parsed.text.trim()) userTexts.push(parsed.text);
        for (const annotation of [...parsed.annotations, ...(message.annotations || [])]) {
            const annotationKey = `${annotation.selectedText}\u0000${annotation.comment}`;
            if (seenAnnotations.has(annotationKey)) continue;
            seenAnnotations.add(annotationKey);
            annotationIndex += 1;
            for (const [fieldName, text] of [["selectedText", annotation.selectedText], ["comment", annotation.comment]] as const) {
                add({ role: "user", matchType: "annotation", text, annotationIndex, annotationField: fieldName,
                    annotationSelectedText: annotation.selectedText, annotationComment: annotation.comment });
            }
        }
    }
    add({ role: legacySystem ? "system" : "user", matchType: legacySystem ? "system" : "user", text: userTexts.join("\n") });
    if (includes("system")) add({ role: "system", matchType: "automation", text: getRoundAutomationEvents(round).map(item => renderConversationAutomationEvent(item.event)).join("\n") });
    for (const event of explicitSystems) add({ role: "system", matchType: "system", text: event.text || "" });
    for (const summary of round.compactionSummaries || []) add({ role: "system", matchType: "system", text: summary.text });
    const aiResponses = round.aiResponses.length > 0 ? round.aiResponses : (round.semanticEvents || [])
        .filter(event => event.semanticRole === "model" || event.semanticRole === "assistant")
        .map(event => ({ response: event.text || "", thinking: "", toolCalls: [] }));
    const seenModelTexts = new Set<string>();
    const seenToolTexts = new Set<string>();
    const addUnique = (value: unknown, role: "assistant" | "tool"): void => {
        if (!includes(role)) return;
        const text = searchableText(value);
        const seen = role === "assistant" ? seenModelTexts : seenToolTexts;
        if (!text || seen.has(text)) return;
        seen.add(text);
        add({ role, matchType: role === "assistant" ? "ai" : "tool", text });
    };
    for (const response of aiResponses) {
        addUnique(response.response, "assistant");
        addUnique(response.thinking, "assistant");
        if (includes("tool")) for (const toolCall of response.toolCalls) addUnique(toolCall.args, "tool");
    }
    const tools = !includes("tool") ? [] : round.toolCalls.length > 0 ? round.toolCalls : (round.semanticEvents || [])
        .filter(event => event.semanticRole === "tool")
        .map(event => ({ name: event.name || event.kind || "tool", argsFull: event.argsFull, argsSummary: "",
            resultFull: event.resultFull || event.resultSummary || event.text, resultSummary: event.resultSummary || event.text || "" }));
    for (const toolCall of tools) {
        addUnique(toolCall.name, "tool");
        addUnique(toolCall.argsFull || toolCall.argsSummary, "tool");
        addUnique(toolCall.resultFull || toolCall.resultSummary, "tool");
    }
    for (const task of includes("tool") ? round.taskBoundaries : []) addUnique(`${task.taskName}\n${task.taskStatus}`, "tool");
    for (const action of includes("tool") ? round.codeActions : []) {
        addUnique(action.description, "tool");
        addUnique(action.targetFile, "tool");
        for (const diff of action.diffs) {
            addUnique(diff.targetContent, "tool");
            addUnique(diff.replacementContent, "tool");
            addUnique(diff.unifiedDiff, "tool");
        }
    }
    for (const view of includes("tool") ? round.fileViews || [] : []) addUnique([view.kind, view.id, view.title, view.textSummary].filter(Boolean).join("\n"), "tool");
    for (const subagent of includes("subagent") ? getRoundSubagentSummaries(round) : []) {
        for (const text of [subagent.threadId, subagent.nickname, subagent.role, subagent.prompt, subagent.summary, subagent.status]) {
            add({ role: "subagent", matchType: "subagent", text: text || "" });
        }
    }
    return fields;
}

export function iterateConversationSearchRounds(loaded: ConversationLoadResult, filter: ConversationSearchFilter = {}): Iterable<ConversationRound> {
    validateConversationSearchFilter(filter);
    let source: Iterable<ConversationRound> = loaded.rounds;
    if (loaded.cacheKey || loaded.cacheGeneration) {
        if (!loaded.cacheKey || !loaded.cacheGeneration) throw new Error("fetch 缓存缺少完整 key/generation，无法搜索或读取；请重新 fetch");
        const cached = iterateCachedConversationSourceCacheRounds<ConversationRound>({ key: loaded.cacheKey, generation: loaded.cacheGeneration,
            startRound: filter.startRound, endRound: filter.endRound });
        if (!cached) throw new Error(`fetch 缓存 generation=${loaded.cacheGeneration} 缺失或损坏；请按相同 source/link 重新 fetch`);
        source = cached.rounds;
    } else if (loaded.rounds.length === 0) {
        throw new Error("没有完整已发布缓存 generation 或可读轮次，无法搜索或读取；请先 fetch");
    }
    return {
        *[Symbol.iterator](): Iterator<ConversationRound> {
            try {
                for (const round of source) {
                    if (round.roundIndex >= (filter.startRound ?? 1) && round.roundIndex <= (filter.endRound ?? Infinity)) yield round;
                }
            } catch (error) {
                if (!loaded.cacheGeneration) throw error;
                throw new Error(`fetch 缓存 generation=${loaded.cacheGeneration} 轮次正文缺失或损坏；请使用 action=fetch, source=auto 和相同 link 恢复 | ${error instanceof Error ? error.message : String(error)}`);
            }
        },
    };
}

export function conversationSearchSnippet(text: string, position = 0, matchedLength = 0): string {
    const start = Math.max(0, position - 100);
    const end = Math.min(text.length, position + Math.min(matchedLength, 160) + 100);
    return `${start > 0 ? "…" : ""}${sliceUnicodeSafe(text, start, end)}${end < text.length ? "…" : ""}`;
}

export function iterateConversationSearchBlocks(rounds: Iterable<ConversationRound>, filter: ConversationSearchFilter = {}): Iterable<TextBlock> {
    validateConversationSearchFilter(filter);
    return {
        *[Symbol.iterator](): Iterator<TextBlock> {
            for (const round of rounds) {
                if (round.roundIndex < (filter.startRound ?? 1) || round.roundIndex > (filter.endRound ?? Infinity)) continue;
                for (const [fieldIndex, field] of extractConversationSearchFields(round, filter).entries()) {
                    let start = 0;
                    while (start < field.text.length) {
                        const end = Math.min(field.text.length, start + 1_800);
                        yield { id: `${round.roundIndex}:${fieldIndex}:${start}`, title: `轮次 ${round.roundIndex}`,
                            content: sliceUnicodeSafe(field.text, start, end), tags: [],
                            metadata: { roundIndex: round.roundIndex, role: field.role, matchType: field.matchType,
                                ...(field.annotationIndex ? { annotationIndex: field.annotationIndex, annotationField: field.annotationField } : {}) } };
                        if (end === field.text.length) break;
                        start = end - 200;
                    }
                }
            }
        },
    };
}

export function searchConversationRoundsExact(rounds: Iterable<ConversationRound>, query: string, limit = 8,
    filter: ConversationSearchFilter = {}): ConversationSearchMatch[] {
    validateConversationSearchFilter(filter);
    resolveConversationSearchLimit(limit);
    const tokens = query.split(/\s+/).filter(token => token.length > 0).map(token => token.toLowerCase());
    const matches: ConversationSearchMatch[] = [];
    for (const round of rounds) {
        if (round.roundIndex < (filter.startRound ?? 1) || round.roundIndex > (filter.endRound ?? Infinity)) continue;
        for (const field of extractConversationSearchFields(round, filter)) {
            const lower = field.text.toLowerCase();
            const hits = tokens.filter(token => lower.includes(token));
            if (hits.length === 0) continue;
            const contextStart = lower.indexOf(hits[0]);
            const { text, ...metadata } = field;
            matches.push({ ...metadata, roundIndex: round.roundIndex, contextStart, hitCount: hits.length,
                matchText: conversationSearchSnippet(text, contextStart, hits[0].length) });
            matches.sort((left, right) => right.hitCount - left.hitCount || left.roundIndex - right.roundIndex);
            if (matches.length > limit) matches.pop();
        }
    }
    return matches;
}

export function conversationSearchContextIndices(matches: readonly { roundIndex: number }[], totalRounds: number,
    contextRounds: number, filter: ConversationSearchFilter = {}): number[] {
    validateConversationSearchFilter(filter);
    if (!Number.isSafeInteger(contextRounds) || contextRounds < 0) throw new Error("contextRounds 必须为非负整数");
    const indices = new Set<number>();
    for (const match of matches) {
        const first = Math.max(filter.startRound ?? 1, match.roundIndex - contextRounds);
        const last = Math.min(filter.endRound ?? totalRounds, totalRounds, match.roundIndex + contextRounds);
        for (let roundIndex = first; roundIndex <= last; roundIndex += 1) indices.add(roundIndex);
    }
    return [...indices].sort((left, right) => left - right);
}
