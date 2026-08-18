import {
    mergeConsecutiveHumanRounds,
    type ConversationRound,
    type ConversationSemanticEvent,
    type ConversationUserMessage,
} from "./trajectory.js";
import {
    projectConversationAutomationInput,
    renderConversationAutomationEvent,
} from "./conversation-automation-event.js";
import type { DshSessionReadResult, DshSessionEvent } from "./dsh-session-reader.js";

export interface DshConversionDiagnostic {
    eventIndex: number;
    eventType: string;
    code: "unknown_content_block" | "malformed_event";
    detail: string;
}

export interface DshConversationConversionResult {
    rounds: ConversationRound[];
    diagnostics: DshConversionDiagnostic[];
}

interface ContentProjection {
    visibleText: string;
    reasoning: string;
    references: string[];
    fullText: string;
    toolCalls: Array<{ id?: string; name: string; args: string }>;
}

interface ChunkState {
    thinking: string[];
    toolCalls: Map<string, { name: string; args: string }>;
    emitted: boolean;
}

interface PendingToolResult {
    summary: string;
    full: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as UnknownRecord
        : null;
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function clip(value: string, maxChars: number): string {
    const normalized = value.replace(/[\r\n\t]+/gu, " ").trim();
    return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}…`;
}

function safeJson(value: unknown, maxChars = 800): string {
    try {
        return clip(JSON.stringify(value), maxChars);
    } catch {
        return "[unserializable value]";
    }
}

function contentBlocks(value: unknown): unknown[] {
    return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function firstReference(block: UnknownRecord): string | undefined {
    const containers = [block, asRecord(block.attachment), asRecord(block.file), asRecord(block.image)];
    for (const container of containers) {
        if (!container) continue;
        for (const key of ["uri", "url", "path", "id", "name", "sha256", "hash"]) {
            const value = asString(container[key]);
            if (value) return clip(value, 240);
        }
    }
    return undefined;
}

function projectContent(
    value: unknown,
    eventIndex: number,
    eventType: string,
    diagnostics: DshConversionDiagnostic[],
): ContentProjection {
    const visible: string[] = [];
    const reasoning: string[] = [];
    const references: string[] = [];
    const unknown: string[] = [];
    const toolCalls: Array<{ id?: string; name: string; args: string }> = [];

    const visit = (block: unknown): void => {
        const record = asRecord(block);
        const type = record ? asString(record.type) : undefined;
        if (!record || !type) {
            const detail = safeJson(block);
            diagnostics.push({ eventIndex, eventType, code: "unknown_content_block", detail });
            unknown.push(`【未识别内容块】${detail}`);
            return;
        }
        if (type === "text") {
            const text = asString(record.text);
            if (text) visible.push(text);
            return;
        }
        if (type === "reasoning") {
            const text = asString(record.text);
            if (text) reasoning.push(text);
            return;
        }
        if (type === "tool-call") {
            toolCalls.push({
                id: asString(record.id),
                name: asString(record.name) || "unknown_tool",
                args: asString(record.arguments) || "",
            });
            return;
        }
        if (type === "tool-result") {
            for (const nested of contentBlocks(record.content)) visit(nested);
            return;
        }
        if (type === "image" || type === "file" || type === "attachment") {
            const reference = firstReference(record) || safeJson(record, 300);
            references.push(`【${type} 引用：${reference}】`);
            return;
        }
        const detail = safeJson(record);
        diagnostics.push({ eventIndex, eventType, code: "unknown_content_block", detail: `${type}: ${detail}` });
        unknown.push(`【未识别内容块 ${type}】${detail}`);
    };

    for (const block of contentBlocks(value)) visit(block);
    const visibleText = visible.join("\n");
    const reasoningText = reasoning.join("\n");
    return {
        visibleText,
        reasoning: reasoningText,
        references,
        fullText: [visibleText, reasoningText, ...references, ...unknown].filter(Boolean).join("\n"),
        toolCalls,
    };
}

function newRound(roundIndex: number, stepIndex: number): ConversationRound {
    return {
        roundIndex,
        startStep: stepIndex,
        endStep: stepIndex,
        userMessage: "",
        mediaAttachments: [],
        aiResponses: [],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
        userMessages: [],
        legacyRoundIndices: [],
        semanticEvents: [],
    };
}

function hasModelSideActivity(round: ConversationRound): boolean {
    return round.aiResponses.length > 0
        || round.toolCalls.length > 0
        || round.taskBoundaries.length > 0
        || round.codeActions.length > 0
        || round.subagentSummaries.length > 0
        || Boolean(round.semanticEvents?.some(event => event.semanticRole === "model" || event.semanticRole === "assistant" || event.semanticRole === "tool" || event.semanticRole === "subagent"));
}

function getMessage(data: UnknownRecord): UnknownRecord | null {
    const nested = asRecord(data.message);
    if (nested) return nested;
    if (typeof data.role === "string" && ("content" in data || "source" in data)) return data;
    return null;
}

function getMessageContent(message: UnknownRecord | null): unknown {
    return message?.content;
}

function getSourceKind(message: UnknownRecord | null): string | undefined {
    return asString(asRecord(message?.source)?.kind);
}

function chunkKey(data: UnknownRecord): string {
    return `${String(data.turn ?? "?")}:${String(data.step ?? "?")}`;
}

function findToolResultId(value: unknown): string | undefined {
    for (const block of contentBlocks(value)) {
        const record = asRecord(block);
        if (!record) continue;
        if (record.type === "tool-result") return asString(record.toolCallId);
        const nested = findToolResultId(record.content);
        if (nested) return nested;
    }
    return undefined;
}

function resultStatus(data: UnknownRecord): string {
    const reason = asRecord(data.reason);
    return asString(reason?.kind) || "ended";
}

function readEvents(result: unknown): unknown[] {
    const record = asRecord(result);
    const direct = record?.events;
    if (Array.isArray(direct)) return direct;
    const session = asRecord(record?.session);
    return Array.isArray(session?.events) ? session.events : [];
}

function readHeader(result: unknown): unknown {
    const record = asRecord(result);
    return record?.header ?? asRecord(record?.session)?.header;
}

export function normalizeDshSessionReadResult(result: DshSessionReadResult): DshConversationConversionResult {
    return normalizeDshSessionEvents(readEvents(result) as DshSessionEvent[], readHeader(result));
}

export function normalizeDshSessionEvents(
    events: readonly DshSessionEvent[],
    header?: unknown,
): DshConversationConversionResult {
    const diagnostics: DshConversionDiagnostic[] = [];
    const rawRounds: ConversationRound[] = [];
    const chunks = new Map<string, ChunkState>();
    const toolCallSlots = new Map<string, { round: ConversationRound; index: number }>();
    const pendingToolResults = new Map<string, PendingToolResult>();
    let currentRound: ConversationRound | null = null;
    const canonicalHumanMessageIds = new Set<string>();

    for (const rawEvent of events) {
        const event = asRecord(rawEvent);
        if (asString(event?.type) !== "user/message") continue;
        const data = asRecord(event?.data);
        if (!data) continue;
        const message = getMessage(data);
        if (message?.role !== "user" || getSourceKind(message) !== "user") continue;
        const id = asString(message.id);
        if (id) canonicalHumanMessageIds.add(id);
    }

    const ensureRound = (stepIndex: number): ConversationRound => {
        if (!currentRound) currentRound = newRound(rawRounds.length + 1, stepIndex);
        currentRound.endStep = Math.max(currentRound.endStep, stepIndex);
        return currentRound;
    };

    const appendSemanticEvent = (stepIndex: number, event: ConversationSemanticEvent): void => {
        ensureRound(stepIndex).semanticEvents?.push(event);
    };

    const appendTaskBoundary = (stepIndex: number, taskName: string, taskStatus: string): void => {
        ensureRound(stepIndex).taskBoundaries.push({ stepIndex, taskName, taskStatus });
    };

    const registerToolCall = (stepIndex: number, callId: string | undefined, name: string, args: string): void => {
        const round = ensureRound(stepIndex);
        const existing = callId ? toolCallSlots.get(callId) : undefined;
        if (existing) {
            const tool = existing.round.toolCalls[existing.index];
            tool.name = name || tool.name;
            tool.argsFull = args || tool.argsFull;
            tool.argsSummary = clip(args || tool.argsFull || "", 60);
            return;
        }
        const index = round.toolCalls.push({
            stepIndex,
            name: name || "unknown_tool",
            argsSummary: clip(args, 60),
            resultSummary: "",
            argsFull: args,
        }) - 1;
        if (!callId) return;
        toolCallSlots.set(callId, { round, index });
        const pending = pendingToolResults.get(callId);
        if (!pending) return;
        const tool = round.toolCalls[index];
        tool.resultSummary = pending.summary;
        tool.resultFull = pending.full;
        pendingToolResults.delete(callId);
    };

    const appendToolResult = (stepIndex: number, callId: string | undefined, projection: ContentProjection): void => {
        const summary = clip(projection.fullText, 500);
        const full = projection.fullText;
        if (!callId) {
            registerToolCall(stepIndex, undefined, "unknown_tool", "");
            const tool = ensureRound(stepIndex).toolCalls.at(-1);
            if (tool) {
                tool.resultSummary = summary;
                tool.resultFull = full;
            }
            return;
        }
        const slot = toolCallSlots.get(callId);
        if (slot) {
            const tool = slot.round.toolCalls[slot.index];
            tool.resultSummary = summary;
            tool.resultFull = full;
            return;
        }
        pendingToolResults.set(callId, { summary, full });
        registerToolCall(stepIndex, callId, "unknown_tool", "");
    };

    const getChunkState = (data: UnknownRecord): ChunkState => {
        const key = chunkKey(data);
        const existing = chunks.get(key);
        if (existing) return existing;
        const created: ChunkState = { thinking: [], toolCalls: new Map(), emitted: false };
        chunks.set(key, created);
        return created;
    };

    const appendMessage = (stepIndex: number, eventType: string, message: UnknownRecord): void => {
        const projection = projectContent(getMessageContent(message), stepIndex, eventType, diagnostics);
        const isHuman = message.role === "user" && getSourceKind(message) === "user";
        if (isHuman) {
            const userText = [projection.visibleText, ...projection.references].filter(Boolean).join("\n");
            if (currentRound && currentRound.userMessages?.length && hasModelSideActivity(currentRound)) {
                rawRounds.push(currentRound);
                currentRound = newRound(rawRounds.length + 1, stepIndex);
            }
            const round = ensureRound(stepIndex);
            const userMessage: ConversationUserMessage = {
                stepIndex,
                text: userText,
                rawRole: eventType,
                semanticRole: "user",
                mediaAttachments: projection.references,
            };
            round.userMessages?.push(userMessage);
            round.userMessage = (round.userMessages || []).map(item => item.text).filter(Boolean).join("\n\n");
            round.mediaAttachments.push(...projection.references);
            round.legacyRoundIndices?.push(round.legacyRoundIndices.length + 1);
            appendSemanticEvent(stepIndex, {
                stepIndex,
                rawRole: eventType,
                semanticRole: "user",
                kind: "message",
                text: userText,
            });
            return;
        }
        const sourceKind = getSourceKind(message) || "unknown";
        const rawText = projection.fullText || safeJson(message);
        const automation = projectConversationAutomationInput(rawText);
        appendSemanticEvent(stepIndex, {
            stepIndex,
            rawRole: `${eventType}:${sourceKind}`,
            semanticRole: "system",
            kind: automation ? "automation_event" : `${sourceKind}_message`,
            text: automation ? renderConversationAutomationEvent(automation.event) : rawText,
            ...(automation ? { automation: automation.event } : {}),
        });
    };

    const appendHeader = (): void => {
        const record = asRecord(header);
        if (!record) return;
        const id = asString(record.id);
        const parentSession = asString(record.parentSession);
        const origin = asString(record.origin);
        if (!id && !parentSession && !origin) return;
        const details = [
            id ? `id=${id}` : "",
            parentSession ? `parentSession=${parentSession}` : "",
            origin ? `origin=${origin}` : "",
        ].filter(Boolean).join(" | ");
        appendSemanticEvent(0, {
            stepIndex: 0,
            rawRole: "dsh/session_header",
            semanticRole: "system",
            kind: "session_header",
            text: `DSH session header | ${details}`,
        });
    };

    appendHeader();

    for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
        const event = asRecord(events[eventIndex]);
        if (!event) {
            diagnostics.push({ eventIndex, eventType: "unknown", code: "malformed_event", detail: safeJson(events[eventIndex]) });
            continue;
        }
        const eventType = asString(event.type) || "unknown";
        const data = asRecord(event.data);
        if (!data) {
            diagnostics.push({ eventIndex, eventType, code: "malformed_event", detail: safeJson(event) });
            continue;
        }
        if (eventType === "turn/start") {
            appendTaskBoundary(eventIndex, `turn ${String(data.turn ?? "?")}`, "started");
            continue;
        }
        if (eventType === "turn/end") {
            appendTaskBoundary(eventIndex, `turn ${String(data.turn ?? "?")}`, resultStatus(data));
            continue;
        }
        if (eventType === "step/start") {
            appendTaskBoundary(eventIndex, `step ${String(data.step ?? "?")}`, "started");
            continue;
        }
        if (eventType === "step/end") {
            appendTaskBoundary(eventIndex, `step ${String(data.step ?? "?")}`, "completed");
            continue;
        }
        if (eventType === "assistant/chunk") {
            const chunk = asRecord(data.chunk);
            const state = getChunkState(data);
            if (chunk?.type === "reasoning-delta") {
                const text = asString(chunk.text);
                if (text) state.thinking.push(text);
            } else if (chunk?.type === "tool-call-delta") {
                const id = asString(chunk.id) || `${data.turn ?? "?"}:${data.step ?? "?"}:${state.toolCalls.size}`;
                const existing = state.toolCalls.get(id) || { name: "unknown_tool", args: "" };
                state.toolCalls.set(id, {
                    name: asString(chunk.name) || existing.name,
                    args: `${existing.args}${asString(chunk.argumentsDelta) || ""}`,
                });
            } else if (chunk?.type === "block-end") {
                const projection = projectContent(chunk.block, eventIndex, eventType, diagnostics);
                if (projection.reasoning) state.thinking.push(projection.reasoning);
                for (const toolCall of projection.toolCalls) {
                    state.toolCalls.set(toolCall.id || `${data.turn ?? "?"}:${data.step ?? "?"}:${state.toolCalls.size}`, {
                        name: toolCall.name,
                        args: toolCall.args,
                    });
                }
            }
            continue;
        }
        if (eventType === "assistant/message") {
            const message = getMessage(data);
            const projection = projectContent(getMessageContent(message), eventIndex, eventType, diagnostics);
            const state = getChunkState(data);
            const responseToolCalls = [...projection.toolCalls];
            for (const [id, toolCall] of state.toolCalls) {
                if (!responseToolCalls.some(item => item.id === id || (item.name === toolCall.name && item.args === toolCall.args))) {
                    responseToolCalls.push({ id, ...toolCall });
                }
            }
            const response = [projection.visibleText, ...projection.references].filter(Boolean).join("\n");
            const thinking = [...state.thinking, projection.reasoning].filter(Boolean).join("\n");
            const round = ensureRound(eventIndex);
            round.aiResponses.push({
                stepIndex: eventIndex,
                response,
                thinking,
                toolCalls: responseToolCalls.map(item => ({ name: item.name, args: item.args })),
            });
            appendSemanticEvent(eventIndex, {
                stepIndex: eventIndex,
                rawRole: eventType,
                semanticRole: "assistant",
                kind: "message",
                text: projection.fullText,
            });
            state.emitted = true;
            continue;
        }
        if (eventType === "tool/call") {
            registerToolCall(
                eventIndex,
                asString(data.callId),
                asString(data.name) || "unknown_tool",
                asString(data.arguments) || "",
            );
            appendSemanticEvent(eventIndex, {
                stepIndex: eventIndex,
                rawRole: eventType,
                semanticRole: "tool",
                kind: "call",
                name: asString(data.name) || "unknown_tool",
                argsFull: asString(data.arguments) || "",
            });
            continue;
        }
        if (eventType === "tool/result") {
            const message = getMessage(data);
            const projection = projectContent(getMessageContent(message), eventIndex, eventType, diagnostics);
            const callId = asString(asRecord(message?.source)?.callId) || findToolResultId(getMessageContent(message));
            appendToolResult(eventIndex, callId, projection);
            appendSemanticEvent(eventIndex, {
                stepIndex: eventIndex,
                rawRole: eventType,
                semanticRole: "tool",
                kind: "result",
                resultSummary: clip(projection.fullText, 500),
                resultFull: projection.fullText,
            });
            continue;
        }
        if (eventType === "agent/inbox/spliced") {
            const inserted = Array.isArray(data.inserted) ? data.inserted : [];
            for (const candidate of inserted) {
                const message = asRecord(candidate);
                if (!message) continue;
                const messageId = asString(message.id);
                const isHuman = message.role === "user" && getSourceKind(message) === "user";
                if (isHuman && messageId && canonicalHumanMessageIds.has(messageId)) continue;
                appendMessage(eventIndex, `${eventType}:${asString(data.target) || "unknown"}`, message);
            }
            if (inserted.length === 0) {
                appendSemanticEvent(eventIndex, {
                    stepIndex: eventIndex,
                    rawRole: eventType,
                    semanticRole: "system",
                    kind: "inbox_splice",
                    text: `DSH inbox splice | target=${asString(data.target) || "unknown"} | inserted=0 | removed=${String(data.removedCount ?? 0)}`,
                });
            }
            continue;
        }
        if (eventType === "user/message") {
            const message = getMessage(data);
            if (message) appendMessage(eventIndex, eventType, message);
            else diagnostics.push({ eventIndex, eventType, code: "malformed_event", detail: safeJson(data) });
            continue;
        }
        appendSemanticEvent(eventIndex, {
            stepIndex: eventIndex,
            rawRole: eventType,
            semanticRole: "system",
            kind: "provenance",
            text: safeJson(data),
        });
    }

    for (const [key, state] of chunks) {
        if (state.emitted || (!state.thinking.length && !state.toolCalls.size)) continue;
        const [, step = "0"] = key.split(":");
        const stepIndex = Number(step) || 0;
        ensureRound(stepIndex).aiResponses.push({
            stepIndex,
            response: "",
            thinking: state.thinking.join("\n"),
            toolCalls: [...state.toolCalls.values()].map(item => ({ name: item.name, args: item.args })),
        });
    }
    if (currentRound) rawRounds.push(currentRound);
    const merged = mergeConsecutiveHumanRounds(rawRounds);
    return {
        rounds: merged.length || rawRounds.length === 0
            ? merged
            : rawRounds.map((round, index) => ({ ...round, roundIndex: index + 1 })),
        diagnostics,
    };
}
