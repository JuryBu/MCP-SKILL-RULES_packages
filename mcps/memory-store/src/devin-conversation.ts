import { createHash } from "node:crypto";
import fs from "node:fs";
import type { ConversationLinkMode } from "./chain.js";
import { materializeRoundAttachments, type ConversationAttachment } from "./conversation-attachments.js";
import type { DevinDesktopMessage, DevinMessageNode, DevinRawConversation, DevinReadOptions } from "./devin-types.js";
import type { ConversationRound, SubagentSummary } from "./trajectory.js";
import { devinText as text, redactDevinBinary, devinDesktopText as desktopText, devinUserContent, addDevinToolDetails } from "./devin-conversation-content.js";
import { attachDevinToolImages } from "./devin-tool-attachments.js";
export { redactDevinBinary } from "./devin-conversation-content.js";

export interface DevinConversationOptions extends DevinReadOptions {
    link?: ConversationLinkMode;
}

export const DEVIN_NORMALIZATION_VERSION = 1;

function originalTime(node: DevinMessageNode): string | undefined {
    const original = node.message.metadata?.created_at;
    if (typeof original === "string" && Number.isFinite(Date.parse(original))) return original;
    const timestamp = typeof node.createdAt === "number" ? node.createdAt * 1000 : Date.parse(node.createdAt);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function emptyRound(index: number, step: number): ConversationRound {
    return { roundIndex: index, startStep: step, endStep: step, userMessage: "", mediaAttachments: [], aiResponses: [], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [], semanticEvents: [] };
}

function imageAttachment(image: Record<string, any>, step: number, reference: string): ConversationAttachment {
    const encoded = typeof image.base64_data === "string" ? image.base64_data : typeof image.data === "string" ? image.data : undefined;
    const mimeType = text(image.mime_type || image.mimeType || "image/png");
    const originalPath = typeof image.source_path === "string" ? image.source_path : undefined;
    let exists: boolean | undefined;
    if (originalPath) {
        try { exists = fs.statSync(originalPath).isFile(); } catch { exists = false; }
    }
    return {
        kind: "image", source: "devin-inline-image", mimeType, reference, stepIndex: step,
        width: Number.isFinite(image.width) ? image.width : undefined,
        height: Number.isFinite(image.height) ? image.height : undefined,
        originalPath, exists,
        ...(encoded ? { dataUrl: `data:${mimeType};base64,${encoded}`, sizeBytes: Math.floor(encoded.replace(/=+$/u, "").length * 3 / 4) } : {}),
    };
}

function desktopNodes(messages: DevinDesktopMessage[], prompt = ""): DevinMessageNode[] {
    const nodes: DevinMessageNode[] = [];
    if (prompt) nodes.push({ nodeId: -1, parentNodeId: null, createdAt: "", message: { role: "user", content: prompt, metadata: { is_user_input: true } }, metadata: {} });
    for (const entry of messages) {
        const payload = entry.payload;
        const timestamp = payload.sourceEventTimestampMs
            ? new Date(payload.sourceEventTimestampMs).toISOString()
            : payload.content?.[0]?._meta?.["cognition.ai/timestamp"];
        const metadata = { created_at: timestamp, is_user_input: entry.kind === "user_message" };
        if (entry.kind === "user_message" || entry.kind === "agent_message" || entry.kind === "agent_thought") {
            nodes.push({ nodeId: entry.position, parentNodeId: nodes.at(-1)?.nodeId ?? null, createdAt: timestamp || "", metadata: {}, message: {
                role: entry.kind === "user_message" ? "user" : "assistant", metadata,
                content: entry.kind === "agent_thought" ? "" : desktopText(payload),
                thinking: entry.kind === "agent_thought" ? desktopText(payload) : "",
                images: (Array.isArray(payload.content) ? payload.content : []).map((part: any) => part.content || part).filter((part: any) => part.type === "image"),
            } });
        } else if (entry.kind === "tool_call") {
            const call = Array.isArray(payload.content) ? payload : payload.content || payload;
            const toolId = text(call.toolCallId || payload.id || entry.position);
            const name = text(call._meta?.["cognition.ai/inferenceToolName"] || call.title || "tool");
            nodes.push({ nodeId: entry.position, parentNodeId: nodes.at(-1)?.nodeId ?? null, createdAt: timestamp || "", metadata: {}, message: {
                role: "assistant", content: "", metadata, tool_calls: [{ id: toolId, function: { name, arguments: call.rawInput || {} } }],
            } });
            nodes.push({ nodeId: entry.position, parentNodeId: entry.position, createdAt: timestamp || "", metadata: {}, message: {
                role: "tool", tool_call_id: toolId, content: desktopText(call), metadata,
            } });
        }
    }
    return nodes;
}

function childTranscript(payload: Record<string, any>): string {
    if (Array.isArray(payload.rawNodes) && payload.rawNodes.length) {
        const summaries = new Set((payload.compactions || []).map((item: any) => item.nodeId));
        return payload.rawNodes.filter((node: DevinMessageNode) => node.message.role !== "system" && !summaries.has(node.nodeId))
            .map((node: DevinMessageNode) => `### ${text(node.message.role)}\n${redactDevinBinary(node.message.content)}${node.message.tool_calls?.length ? `\n${redactDevinBinary(node.message.tool_calls)}` : ""}`).join("\n\n");
    }
    return (Array.isArray(payload.childMessages) ? payload.childMessages : [])
        .filter((child: any) => child.kind !== "agent_thought")
        .map((child: any) => {
            const body = desktopText(child);
            return body ? `### ${text(child.kind)}\n${body}` : "";
        }).filter(Boolean).join("\n\n");
}

export function selectDevinSubagents(raw: DevinRawConversation): Map<string, DevinDesktopMessage> {
    const subagents = new Map<string, DevinDesktopMessage>();
    for (const entry of raw.desktopMessages.filter(message => message.kind === "subagent")) {
        const agentId = text(entry.payload.agentId);
        if (!agentId) continue;
        const previous = subagents.get(agentId);
        if (previous && JSON.stringify(previous.payload) !== JSON.stringify(entry.payload)) {
            const previousTime = Date.parse(previous.payload.updatedAt || "");
            const nextTime = Date.parse(entry.payload.updatedAt || "");
            if (!Number.isFinite(previousTime) || !Number.isFinite(nextTime) || previousTime === nextTime) {
                raw.partial = true;
                raw.warnings.push(`DEVIN_SUBAGENT_CONFLICT:${agentId}`);
                continue;
            }
            if (previousTime > nextTime) continue;
        }
        subagents.set(agentId, entry);
    }
    return subagents;
}

export function devinSubagentId(parentId: string, agentId: string): string {
    return `${parentId}--subagent-${agentId}`;
}

export function splitDevinSubagentId(id: string): { parentId: string; agentId: string } | null {
    const match = /^(.*)--subagent-([a-zA-Z0-9_-]+)$/u.exec(id);
    return match ? { parentId: match[1], agentId: match[2] } : null;
}

export function devinRawToRounds(raw: DevinRawConversation, options: DevinConversationOptions = {}): ConversationRound[] {
    const rounds: ConversationRound[] = [];
    const calls = new Map<string, { round: ConversationRound; index: number }>();
    const nodeRounds = new Map<number, ConversationRound>();
    const nodes = raw.nodes.length ? raw.nodes : desktopNodes(raw.desktopMessages);
    const summaryIds = new Set(raw.compactions.map(compaction => compaction.nodeId));
    let current: ConversationRound | undefined;
    for (let step = 0; step < nodes.length; step++) {
        if (options.signal?.aborted || options.isCancelled?.() || (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs)) throw new Error("Devin conversion cancelled or deadline exceeded");
        const node = nodes[step];
        const message = node.message;
        if (message.role === "system" || node.metadata.is_system_prefix === true) continue;
        if (summaryIds.has(node.nodeId)) {
            if (current) { nodeRounds.set(node.nodeId, current); current.endStep = step; }
            continue;
        }
        if (message.role === "user" || !current) {
            current = emptyRound(rounds.length + 1, step);
            current.createdAt = originalTime(node);
            rounds.push(current);
        }
        current.endStep = step;
        nodeRounds.set(node.nodeId, current);
        const content = redactDevinBinary(message.content);
        if (message.role === "user") {
            const { content: userContent, images } = devinUserContent(message);
            const attachments = images.map((image: any, index: number) => imageAttachment(image, step, `devin:${raw.summary.canonicalId}:${node.nodeId}:${index}`));
            current.userMessage = userContent;
            current.attachments = attachments;
            current.userMessages = [{ text: userContent, stepIndex: step, rawRole: "devin-user", semanticRole: "user", attachments, createdAt: originalTime(node) }];
            current.semanticEvents!.push({ stepIndex: step, semanticRole: "user", rawRole: "user", text: userContent, attachments, createdAt: originalTime(node) });
        } else if (message.role === "assistant") {
            const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((call: any) => ({ name: text(call.function?.name || call.name), args: redactDevinBinary(call.function?.arguments ?? call.arguments ?? {}) }));
            if (content || message.thinking || toolCalls.length) current.aiResponses.push({ stepIndex: step, response: content, thinking: redactDevinBinary(message.thinking), toolCalls });
            if (content) current.semanticEvents!.push({ stepIndex: step, semanticRole: "assistant", rawRole: "assistant", text: content, createdAt: originalTime(node) });
            for (let index = 0; index < toolCalls.length; index++) {
                const call = toolCalls[index];
                calls.set(text(message.tool_calls[index].id), { round: current, index: current.toolCalls.length });
                current.toolCalls.push({ stepIndex: step, name: call.name, argsSummary: call.args.slice(0, 120), argsFull: call.args, resultSummary: "", resultFull: "" });
                addDevinToolDetails(current, call.name, call.args, step);
            }
        } else if (message.role === "tool") {
            const owner = calls.get(text(message.tool_call_id));
            const call = owner?.round.toolCalls[owner.index];
            if (call && owner) {
                call.resultFull = content;
                call.resultSummary = content.slice(0, 500);
                for (const view of owner.round.fileViews || []) if (view.stepIndex === call.stepIndex) view.textSummary = content;
                owner.round.endStep = Math.max(owner.round.endStep, step);
                owner.round.semanticEvents!.push({ stepIndex: step, semanticRole: "tool", rawRole: "tool", name: call.name, argsFull: call.argsFull, resultSummary: call.resultSummary, resultFull: content, createdAt: originalTime(node) });
            } else {
                current.toolCalls.push({ stepIndex: step, name: text(message.name || "tool"), argsSummary: "", resultSummary: content.slice(0, 500), resultFull: content });
            }
        }
    }
    for (const entry of raw.desktopMessages.filter(message => message.kind === "tool_call")) {
        const state = entry.payload.content || entry.payload;
        const owner = calls.get(text(state.toolCallId || entry.payload.id).replace(/^tool:/u, ""));
        if (!owner) continue;
        const call = owner.round.toolCalls[owner.index];
        const result = desktopText(state) || redactDevinBinary(state.rawOutput || "");
        if (!call.resultFull && result) {
            call.resultFull = result;
            call.resultSummary = result.slice(0, 500);
            owner.round.semanticEvents!.push({ stepIndex: call.stepIndex, semanticRole: "tool", rawRole: "tool", name: call.name, argsFull: call.argsFull, resultFull: result, resultSummary: call.resultSummary });
        }
        for (const block of Array.isArray(state.content) ? state.content : []) {
            if (block.type !== "diff" || !block.path) continue;
            const duplicate = owner.round.codeActions.some(action => action.stepIndex === call.stepIndex && action.targetFile === block.path);
            if (!duplicate) owner.round.codeActions.push({ stepIndex: call.stepIndex, description: call.name, targetFile: block.path, instruction: state.title || call.name, diffs: [{ targetContent: redactDevinBinary(block.oldText || ""), replacementContent: redactDevinBinary(block.newText || "") }] });
        }
    }
    for (const compaction of raw.compactions) {
        const owner = nodeRounds.get(compaction.nodeId) || nodeRounds.get(compaction.summarizedFrom) || rounds.at(-1);
        if (!owner) continue;
        owner.compactionSummaries ??= [];
        owner.compactionSummaries.push({ provider: "devin", kind: "compact_summary", text: redactDevinBinary(compaction.summary), summaryChars: compaction.summary.length, summarySha256: createHash("sha256").update(compaction.summary).digest("hex"), sourceNodeId: compaction.nodeId, boundaryNodeId: compaction.summarizedFrom, createdAt: compaction.createdAt, conversationId: raw.summary.canonicalId });
    }
    for (const entry of selectDevinSubagents(raw).values()) {
        const payload = entry.payload;
        const callId = text(payload.toolCallId || payload.tool_call_id || "");
        const callOwner = callId ? calls.get(callId)?.round : undefined;
        const matching = rounds.filter(round => round.toolCalls.some(call => {
            if (call.name !== "run_subagent" || !payload.task) return false;
            try { return JSON.parse(call.argsFull || "{}").task === payload.task; } catch { return false; }
        }));
        const owner = callOwner || (matching.length === 1 ? matching[0] : undefined);
        if (!owner) {
            raw.partial = true;
            raw.warnings.push(`DEVIN_SUBAGENT_PARENT_UNRESOLVED:${text(payload.agentId)}`);
            continue;
        }
        const summary: SubagentSummary = { threadId: devinSubagentId(raw.summary.canonicalId, text(payload.agentId)), nickname: text(payload.title || payload.agentId), role: text(payload.profile), prompt: options.link === "reference" ? undefined : redactDevinBinary(payload.task), summary: options.link === "reference" ? undefined : options.link === "expand_children" ? childTranscript(payload) || redactDevinBinary(payload.summary) : redactDevinBinary(payload.summary), status: text(payload.status), rawRole: "subagent", semanticRole: "subagent" };
        owner.subagentSummaries.push(summary);
        owner.semanticEvents!.push({ stepIndex: owner.endStep, rawRole: "subagent", semanticRole: "subagent", subagent: summary });
    }
    return rounds;
}

export async function readDevinConversation(id: string, options: DevinConversationOptions = {}): Promise<{ raw: DevinRawConversation; rounds: ConversationRound[] } | null> {
    const { readDevinRawConversation } = await import("./devin-sqlite.js");
    const child = splitDevinSubagentId(id);
    let raw = await readDevinRawConversation(child?.parentId || id, options);
    if (!raw) return null;
    if (child) {
        const payload = selectDevinSubagents(raw).get(child.agentId)?.payload;
        if (!payload) return null;
        const messages = (payload.childMessages || []).map((message: any, position: number) => ({ position, kind: message.kind, payload: message }));
        const canonicalId = devinSubagentId(raw.summary.canonicalId, child.agentId);
        raw = { ...raw, nodes: Array.isArray(payload.rawNodes) && payload.rawNodes.length ? payload.rawNodes : desktopNodes(messages, text(payload.task)), desktopMessages: messages.filter((message: DevinDesktopMessage) => message.kind === "subagent" || message.kind === "tool_call"), compactions: Array.isArray(payload.compactions) ? payload.compactions : [], partial: raw.partial || payload.partial === true, summary: { ...raw.summary, id: canonicalId, canonicalId, uuid: undefined, aliases: [canonicalId, id], isChildThread: true, parentConversationId: raw.summary.canonicalId, agentId: child.agentId, title: text(payload.title || child.agentId) } };
    }
    const converted = devinRawToRounds(raw, options);
    attachDevinToolImages(raw, converted);
    const materialized = await materializeRoundAttachments(converted, raw.summary.canonicalId, { deadlineAt: options.deadlineMs, shouldAbort: () => Boolean(options.signal?.aborted || options.isCancelled?.()) });
    for (const round of materialized.rounds) {
        const attachments = new Map((round.attachments || []).map(attachment => [attachment.reference, attachment]));
        for (const attachment of attachments.values()) {
            if (attachment.dataUrl && !attachment.tempPath && !attachment.originalPath) attachment.warning ||= "Image bytes omitted; materialization unavailable or over budget";
            delete attachment.dataUrl;
        }
        for (const message of round.userMessages || []) message.attachments = message.attachments?.map(attachment => attachments.get(attachment.reference) || { ...attachment, dataUrl: undefined });
        for (const event of round.semanticEvents || []) event.attachments = event.attachments?.map(attachment => attachments.get(attachment.reference) || { ...attachment, dataUrl: undefined });
    }
    return { raw, rounds: materialized.rounds };
}
