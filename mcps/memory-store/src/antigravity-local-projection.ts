import { createHash } from "node:crypto";
import path from "node:path";
import type { ConversationAttachment } from "./conversation-attachments.js";
import { extractAntigravityToolImages } from "./conversation-attachments.js";
import { localPbResultToRounds } from "./conversation-source-adapters.js";
import type { LocalPbReadResult } from "./local-pb-reader.js";
import { mergeConsecutiveHumanRounds, type ConversationRound, type ConversationAnnotation } from "./trajectory.js";

export interface AntigravityLocalEvent {
    stepIndex: number;
    type: string;
    createdAt?: string;
    raw: Record<string, unknown>;
    sourcePath: string;
    line: number;
    fragment?: ConversationRound;
}

function text(value: unknown): string {
    return typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);
}

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function antigravityUserText(value: unknown): string {
    const content = text(value);
    const request = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/u.exec(content);
    return request ? request[1] : content;
}

function canonical(value: string): string {
    return value.replace(/\r\n/gu, "\n").trim();
}

function eventContent(event: AntigravityLocalEvent): string {
    if (event.type === "USER_INPUT") return canonical(antigravityUserText(event.raw.content));
    return canonical(text(event.raw.content || event.raw.error));
}

function compatible(left: AntigravityLocalEvent, right: AntigravityLocalEvent): boolean {
    if (left.stepIndex !== right.stepIndex || left.type !== right.type) return false;
    if (left.createdAt && right.createdAt && Math.abs(Date.parse(left.createdAt) - Date.parse(right.createdAt)) >= 1000) return false;
    const transcriptPair = path.dirname(left.sourcePath) === path.dirname(right.sourcePath)
        && new Set([path.basename(left.sourcePath), path.basename(right.sourcePath)]).size === 2
        && [left.sourcePath, right.sourcePath].every(filename => /[\\/]transcript(?:_full)?\.jsonl$/u.test(filename));
    if (transcriptPair && left.createdAt && left.createdAt === right.createdAt) return true;
    if (!left.raw.pb && !right.raw.pb && (left.raw.truncated_fields || right.raw.truncated_fields)
        && left.createdAt && left.createdAt === right.createdAt) return true;
    const leftText = eventContent(left);
    const rightText = eventContent(right);
    if (leftText && rightText && leftText !== rightText) {
        const shorter = left.raw.truncated_fields ? leftText : right.raw.truncated_fields ? rightText : "";
        const longer = left.raw.truncated_fields ? rightText : leftText;
        if (!shorter || !longer.startsWith(shorter.replace(/\s*\[.*truncat[\s\S]*$/iu, ""))) return false;
    }
    if (!left.fragment && !right.fragment && left.type === "USER_INPUT"
        && JSON.stringify(left.raw.media || []) !== JSON.stringify(right.raw.media || [])) return false;
    if (!left.fragment && !right.fragment && left.type === "PLANNER_RESPONSE"
        && JSON.stringify(left.raw.tool_calls || []) !== JSON.stringify(right.raw.tool_calls || [])) return false;
    return Boolean(leftText || rightText || left.createdAt && right.createdAt);
}

export function antigravityPbEvents(result: LocalPbReadResult, sourcePath: string): AntigravityLocalEvent[] {
    const projected = new Map<number, ConversationRound>();
    for (const round of localPbResultToRounds(result)) {
        const indices = new Set([...(round.semanticEvents || []).map(event => event.stepIndex), ...(round.userMessages || []).map(message => message.stepIndex), ...round.aiResponses.map(response => response.stepIndex)]);
        for (const index of indices) {
            if (index === undefined) continue;
            const fragment = emptyRound(index);
            fragment.userMessages = (round.userMessages || []).filter(message => message.stepIndex === index);
            fragment.userMessage = fragment.userMessages.map(message => message.text).join("\n\n");
            fragment.mediaAttachments = fragment.userMessages.flatMap(message => message.mediaAttachments || []);
            fragment.attachments = (round.attachments || []).filter(attachment => attachment.stepIndex === index);
            fragment.aiResponses = round.aiResponses.filter(response => response.stepIndex === index);
            fragment.toolCalls = round.toolCalls.filter(call => call.stepIndex === index);
            fragment.taskBoundaries = round.taskBoundaries.filter(boundary => boundary.stepIndex === index);
            fragment.codeActions = round.codeActions.filter(action => action.stepIndex === index);
            fragment.semanticEvents = (round.semanticEvents || []).filter(event => event.stepIndex === index);
            fragment.fileViews = (round.fileViews || []).filter(view => view.stepIndex === index);
            projected.set(index, fragment);
        }
    }
    return result.trajectory.steps.map(step => {
        const fragment = projected.get(step.index) || emptyRound(step.index);
        if (!projected.has(step.index)) {
            if (step.system) fragment.semanticEvents!.push({ stepIndex: step.index, semanticRole: "system", kind: result.label === "sqlite-step-format-0" ? "error" : "system", text: step.system });
            for (const variant of step.toolVariants) fragment.semanticEvents!.push({ stepIndex: step.index, semanticRole: "system", kind: "pb_wire_variant", name: variant.variantName, resultSummary: JSON.stringify(variant) });
        }
        const type = step.user ? "USER_INPUT" : step.planner ? "PLANNER_RESPONSE" : step.system ? "SYSTEM_MESSAGE" : "GENERIC";
        return { stepIndex: step.index, type, createdAt: step.timestamp?.iso, sourcePath, line: step.index + 1, fragment,
            raw: { content: step.user || step.planner?.response || step.system || "", thinking: step.planner?.thinking || "", pb: true } };
    });
}

export function mergeAntigravityEventSequences(left: AntigravityLocalEvent[], right: AntigravityLocalEvent[]): { events: AntigravityLocalEvent[]; matches: number } {
    const positions = new Map<number, number[]>();
    left.forEach((event, index) => positions.set(event.stepIndex, [...(positions.get(event.stepIndex) || []), index]));
    const merged: AntigravityLocalEvent[] = [];
    let leftCursor = 0;
    let rightCursor = 0;
    let matches = 0;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
        const incoming = right[rightIndex];
        const position = positions.get(incoming.stepIndex)?.find(index => index >= leftCursor && compatible(left[index], incoming));
        if (position === undefined) continue;
        merged.push(...left.slice(leftCursor, position), ...right.slice(rightCursor, rightIndex));
        const original = left[position];
        const primary = original.raw.pb || original.raw.truncated_fields && !incoming.raw.truncated_fields ? incoming : original;
        const secondary = primary === original ? incoming : original;
        const raw = { ...secondary.raw, ...primary.raw };
        if (!primary.raw.pb) delete raw.pb;
        if (!primary.raw.truncated_fields) delete raw.truncated_fields;
        if (text(secondary.raw.thinking).length > text(primary.raw.thinking).length) raw.thinking = secondary.raw.thinking;
        merged.push({ ...primary, raw, fragment: original.fragment || incoming.fragment });
        leftCursor = position + 1;
        rightCursor = rightIndex + 1;
        matches += 1;
    }
    merged.push(...left.slice(leftCursor), ...right.slice(rightCursor));
    return { events: merged, matches };
}

function emptyRound(stepIndex: number): ConversationRound {
    return { roundIndex: 1, startStep: stepIndex, endStep: stepIndex, userMessage: "", mediaAttachments: [], attachments: [],
        aiResponses: [], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [], userMessages: [], legacyRoundIndices: [], semanticEvents: [] };
}

function annotations(value: unknown): ConversationAnnotation[] {
    return (Array.isArray(value) ? value : []).map(item => {
        const annotation = object(item);
        return { selectedText: text(annotation.selectedText ?? annotation.selected_text ?? annotation.quote), comment: text(annotation.comment ?? annotation.text) };
    }).filter(item => item.selectedText || item.comment);
}

function attachments(value: unknown, stepIndex: number, semanticRole: "user" | "tool" = "user"): ConversationAttachment[] {
    return (Array.isArray(value) ? value : []).flatMap(item => {
        const media = object(item);
        const uri = text(media.uri || media.path || media.url);
        if (!uri) return [];
        const mimeType = text(media.mime_type || media.mimeType);
        return [{ kind: mimeType.startsWith("image/") || /\.(png|jpe?g|webp|gif)(?:$|[?#])/iu.test(uri) ? "image" as const : "file" as const,
            source: "antigravity-raw-attachment" as const, reference: uri, originalPath: uri, mimeType: mimeType || undefined, stepIndex, semanticRole }];
    });
}

function reindexFragment(fragment: ConversationRound, stepIndex: number): ConversationRound {
    const mapped = <Value extends { stepIndex?: number }>(values: Value[] | undefined): Value[] => (values || []).map(value => ({ ...value, stepIndex }));
    return { ...fragment, startStep: stepIndex, endStep: stepIndex,
        userMessages: mapped(fragment.userMessages).map(message => ({ ...message, attachments: mapped(message.attachments) })), attachments: mapped(fragment.attachments),
        aiResponses: mapped(fragment.aiResponses), toolCalls: mapped(fragment.toolCalls), taskBoundaries: mapped(fragment.taskBoundaries),
        codeActions: mapped(fragment.codeActions), semanticEvents: mapped(fragment.semanticEvents).map(event => ({ ...event, attachments: mapped(event.attachments) })), fileViews: mapped(fragment.fileViews) };
}

function addFragment(target: ConversationRound, source: ConversationRound): void {
    target.userMessages!.push(...(source.userMessages || []));
    target.userMessage = target.userMessages!.map(message => message.text).filter(Boolean).join("\n\n");
    target.mediaAttachments.push(...source.mediaAttachments);
    target.attachments!.push(...(source.attachments || []));
    target.aiResponses.push(...source.aiResponses);
    target.toolCalls.push(...source.toolCalls);
    target.taskBoundaries.push(...source.taskBoundaries);
    target.codeActions.push(...source.codeActions);
    target.subagentSummaries.push(...source.subagentSummaries);
    target.semanticEvents!.push(...(source.semanticEvents || []));
    target.fileViews = [...(target.fileViews || []), ...(source.fileViews || [])];
    target.endStep = source.endStep;
}

export function antigravityEventsToRounds(events: AntigravityLocalEvent[]): ConversationRound[] {
    const rounds: ConversationRound[] = [];
    let current: ConversationRound | undefined;
    let pendingTools: string[] = [];
    for (const [stepIndex, event] of events.entries()) {
        const raw = event.raw;
        const fragment = event.fragment ? reindexFragment(event.fragment, stepIndex) : emptyRound(stepIndex);
        const isUser = event.type === "USER_INPUT";
        const rawRole = raw.memoryStoreHostKind === "cli" ? `antigravity-cli.jsonl.${event.type}.source=${text(raw.source) || "unknown"}` : `antigravity.jsonl.${event.type}`;
        const createdAt = event.createdAt;
        if (isUser && !event.fragment) {
            const messageText = antigravityUserText(raw.content);
            const media = attachments(raw.media ?? raw.attachments, stepIndex);
            const selectedAnnotations = annotations(raw.annotations ?? object(raw.user_input).annotations);
            fragment.userMessages = [{ text: messageText, stepIndex, createdAt, rawRole, semanticRole: "user", attachments: media,
                mediaAttachments: media.filter(item => item.kind === "image").map(item => item.reference!), ...(selectedAnnotations.length ? { annotations: selectedAnnotations } : {}) }];
            fragment.userMessage = messageText;
            fragment.attachments = media;
            fragment.mediaAttachments = fragment.userMessages[0].mediaAttachments || [];
            fragment.semanticEvents!.push({ stepIndex, createdAt, rawRole, semanticRole: "user", kind: "message", text: messageText, attachments: media });
        } else if (isUser && event.fragment && !raw.pb) {
            const media = attachments(raw.media ?? raw.attachments, stepIndex);
            fragment.attachments!.push(...media);
            fragment.mediaAttachments.push(...media.filter(item => item.kind === "image").map(item => item.reference!));
            for (const message of fragment.userMessages || []) {
                message.attachments = [...(message.attachments || []), ...media];
                const selectedAnnotations = annotations(raw.annotations);
                if (selectedAnnotations.length) message.annotations = selectedAnnotations;
            }
        }
        if (isUser) for (const message of fragment.userMessages || []) {
            if (createdAt && !message.createdAt) message.createdAt = createdAt;
            if (raw.memoryStoreHostKind === "cli") message.rawRole = rawRole;
        }
        if (event.type === "PLANNER_RESPONSE" || event.type === "MODEL_RESPONSE") {
            const calls = (Array.isArray(raw.tool_calls) ? raw.tool_calls : []).map(item => {
                const call = object(item);
                const nested = object(call.function);
                return { name: text(call.name || nested.name), args: text(call.args ?? call.arguments ?? call.arguments_json ?? nested.arguments) };
            });
            pendingTools.push(...calls.map(call => call.name));
            const response = text(raw.content);
            const thinking = text(raw.thinking);
            if (event.fragment && fragment.aiResponses.length) {
                const previous = fragment.aiResponses[0];
                previous.response = response || previous.response;
                if (thinking.length > previous.thinking.length) previous.thinking = thinking;
                previous.toolCalls.push(...calls);
            } else {
                fragment.aiResponses.push({ stepIndex, response, thinking, toolCalls: calls });
                fragment.semanticEvents!.push({ stepIndex, createdAt, rawRole, semanticRole: "model", kind: "response", text: response });
            }
            if (thinking) fragment.semanticEvents!.push({ stepIndex, createdAt, rawRole, semanticRole: "model", kind: "thinking", text: thinking });
            for (const call of calls) fragment.semanticEvents!.push({ stepIndex, createdAt, rawRole, semanticRole: "tool", kind: "tool_call", name: call.name, argsFull: call.args });
        } else if (event.type === "GENERIC" && !raw.pb) {
            const result = text(raw.content);
            const name = text(raw.tool_name || raw.name) || pendingTools.shift() || "antigravity-generic";
            const media = [...attachments(raw.media ?? raw.attachments, stepIndex, "tool"), ...extractAntigravityToolImages({ resultString: result }, stepIndex)];
            fragment.toolCalls.push({ stepIndex, name, argsSummary: "", resultSummary: result.slice(0, 500), resultFull: result });
            fragment.semanticEvents!.push({ stepIndex, createdAt, rawRole, semanticRole: "tool", kind: "tool", name, resultSummary: result.slice(0, 500), resultFull: result, attachments: media });
            fragment.attachments!.push(...media);
        } else if (!isUser && event.type !== "PLANNER_RESPONSE" && event.type !== "MODEL_RESPONSE" && !raw.pb) {
            fragment.semanticEvents!.push({ stepIndex, createdAt, rawRole, semanticRole: "system", kind: event.type === "ERROR_MESSAGE" ? "error" : event.type.toLowerCase(), text: text(raw.error || raw.content) });
        }
        const subagent = object(raw.subagent);
        const threadId = text(subagent.conversation_id || subagent.thread_id || subagent.id);
        if (threadId) {
            const summary = { threadId, nickname: text(subagent.agent_name || subagent.name), role: "subagent", summary: text(subagent.summary || subagent.content), rawRole, semanticRole: "subagent" as const };
            fragment.subagentSummaries.push(summary);
            fragment.semanticEvents!.push({ stepIndex, createdAt, rawRole, semanticRole: "subagent", kind: "subagent", subagent: summary });
        }
        fragment.semanticEvents!.push({ stepIndex, createdAt, rawRole: raw.sqlite ? "antigravity.sqlite" : event.fragment ? "antigravity.local-pb" : rawRole, semanticRole: "system", kind: "source_record",
            text: JSON.stringify({ step_index: event.stepIndex, sourcePath: event.sourcePath, line: event.line }) });
        const modelActivity = current && (current.aiResponses.length || current.toolCalls.length || current.semanticEvents?.some(item => ["model", "tool", "subagent"].includes(item.semanticRole)));
        if (!current || isUser && modelActivity) {
            if (current) rounds.push(current);
            current = emptyRound(stepIndex);
            current.createdAt = createdAt;
        }
        addFragment(current, fragment);
    }
    if (current) rounds.push(current);
    const normalized = rounds.map((round, index) => ({ ...round, roundIndex: index + 1, legacyRoundIndices: [index + 1] }));
    const grouped = mergeConsecutiveHumanRounds(normalized);
    return grouped.length ? grouped : normalized;
}

export function antigravityEventDigest(events: AntigravityLocalEvent[]): string {
    const hash = createHash("sha256");
    for (const event of events) hash.update(JSON.stringify([event.stepIndex, event.type, event.createdAt, event.raw]));
    return hash.digest("hex");
}
