import { createHash } from "node:crypto";
import { createCodexRoundCollector } from "./codex-client.js";
import { createConsecutiveHumanRoundMerger, getRoundUserMessages, type ConversationRound } from "./trajectory.js";
import type { CorpusMessage, CorpusMessageRole, CorpusSourcePosition } from "./conversation-corpus-types.js";
import type { CodexStreamingHistoryPosition } from "./codex-history-source.js";
import type { ConversationAttachment } from "./conversation-attachments.js";

export interface CodexCorpusThreadOrigin { sourceThreadId: string; isChildThread: boolean; parentConversationId?: string; agentNickname?: string; agentRole?: string }

export function codexCorpusThreadOrigin(metadata: Record<string, unknown>, fallbackId: string): CodexCorpusThreadOrigin {
    let source: any = metadata.source;
    if (typeof source === "string") { try { source = JSON.parse(source); } catch {} }
    const spawn = source?.subagent?.thread_spawn;
    const parent = metadata.parent_thread_id || spawn?.parent_thread_id;
    const nickname = metadata.agent_nickname || spawn?.agent_nickname;
    const role = metadata.agent_role || spawn?.agent_role;
    return { sourceThreadId: typeof metadata.id === "string" ? metadata.id : fallbackId, isChildThread: Boolean(source?.subagent || source === "subagent"), parentConversationId: typeof parent === "string" ? parent : undefined, agentNickname: typeof nickname === "string" ? nickname : undefined, agentRole: typeof role === "string" ? role : undefined };
}

function attachmentReference(attachment: ConversationAttachment): Omit<ConversationAttachment, "dataUrl"> {
    const { dataUrl, ...reference } = attachment;
    let inlineData = dataUrl;
    for (const key of ["reference", "originalPath", "tempPath", "name"] as const) {
        if (/^data:[^;,]+;base64,/iu.test(reference[key] || "")) {
            inlineData ||= reference[key];
            delete reference[key];
        }
    }
    if (inlineData) {
        reference.sha256 ||= `sha256:${createHash("sha256").update(inlineData).digest("hex")}`;
        reference.warning = [reference.warning, "attachment_inline_data_omitted"].filter(Boolean).join("; ");
    }
    return reference;
}

export function codexCorpusAttachmentReferences(details: { attachments?: readonly ConversationAttachment[]; mediaAttachments?: readonly string[] }, stepIndex?: number): Pick<CorpusMessage, "attachments" | "mediaAttachments"> {
    const attachments = (details.attachments || []).map(attachmentReference);
    const mediaAttachments: string[] = [];
    for (const media of details.mediaAttachments || []) {
        if (/^data:/iu.test(media)) attachments.push(attachmentReference({ kind: "image", source: "codex-data-url", dataUrl: media, ...(stepIndex === undefined ? {} : { stepIndex }) }));
        else mediaAttachments.push(media);
    }
    return { ...(attachments.length ? { attachments } : {}), ...(mediaAttachments.length ? { mediaAttachments } : {}) };
}

export function projectCodexCorpusRound(
    conversationId: string,
    round: ConversationRound,
    positions: Map<number, { position: CorpusSourcePosition; timestamp?: string }>,
    roles: readonly CorpusMessageRole[] = ["user", "assistant"],
    fallbackPath?: string,
    originsByPath?: ReadonlyMap<string, CodexCorpusThreadOrigin>,
): CorpusMessage[] {
    const messages: Array<CorpusMessage & { step: number; sequence: number }> = [];
    let sequence = 0;
    const append = (role: CorpusMessageRole, text: string, step: number, timestamp?: string, details: Pick<CorpusMessage, "attachments" | "mediaAttachments" | "annotations"> & { attachments?: ConversationAttachment[] } = {}): void => {
        const metadata = positions.get(step);
        const position = metadata?.position || { path: fallbackPath, ordinal: step };
        const origin = position.path ? originsByPath?.get(position.path) : undefined;
        if (origin?.isChildThread && (role === "user" || role === "assistant")) role = "subagent";
        if (!roles.includes(role)) return;
        const identity = JSON.stringify([conversationId, position.path, position.startByte ?? position.ordinal, position.messageId, role, sequence]);
        messages.push({ id: createHash("sha256").update(identity).digest("hex"), round: round.roundIndex, role, authorKind: role, sourceThreadId: origin?.sourceThreadId || conversationId, text, timestamp: metadata?.timestamp || timestamp, position: { ...position }, ...codexCorpusAttachmentReferences(details, step), ...(details.annotations?.length ? { annotations: details.annotations.map(annotation => ({ ...annotation })) } : {}), step, sequence: sequence++ });
    };
    for (const message of getRoundUserMessages(round)) append("user", message.text, message.stepIndex ?? round.startStep, message.createdAt, message);
    for (const response of round.aiResponses) {
        const attachments = (round.semanticEvents || []).filter(event => event.semanticRole === "model" && event.stepIndex === response.stepIndex).flatMap(event => event.attachments || []);
        if (response.response.trim() || attachments.length) append("assistant", response.response, response.stepIndex, undefined, { attachments });
    }
    for (const event of round.semanticEvents || []) {
        if (event.semanticRole === "subagent" && (event.text || event.attachments?.length)) append("subagent", event.text || "", event.stepIndex ?? round.endStep, event.createdAt, { attachments: event.attachments || event.subagent?.attachments });
    }
    if (roles.includes("subagent") && !(round.semanticEvents || []).some(event => event.semanticRole === "subagent")) {
        for (const child of round.subagentSummaries) append("subagent", [child.nickname, child.summary || child.status || ""].filter(Boolean).join("\n"), round.endStep, undefined, { attachments: child.attachments });
    }
    for (const tool of round.toolCalls) append("tool", [tool.name, tool.argsFull || tool.argsSummary, tool.resultFull || tool.resultSummary].filter(Boolean).join("\n"), tool.stepIndex);
    return messages.sort((left, right) => left.step - right.step || left.sequence - right.sequence).map(({ step: _step, sequence: _sequence, ...message }) => message);
}

export function createCodexCorpusCollector(options: {
    conversationId: string;
    cwd?: string;
    roles?: CorpusMessageRole[];
    startRound?: number;
    originsByPath?: ReadonlyMap<string, CodexCorpusThreadOrigin>;
    retainPositions?: boolean;
    onRound?: (round: number, messages: CorpusMessage[]) => void;
    onCanonicalRound?: (round: ConversationRound, messages: CorpusMessage[]) => void;
}): {
    addEvent(event: any, position: CodexStreamingHistoryPosition): void;
    finish(): { messages: CorpusMessage[]; lastRoundStart?: CodexStreamingHistoryPosition; roundCount: number };
} {
    const positions = new Map<number, { position: CorpusSourcePosition; timestamp?: string }>();
    const messages: CorpusMessage[] = [];
    const roles = options.roles || ["user", "assistant"];
    let step = 0;
    let roundCount = 0;
    let lastRoundStart: CodexStreamingHistoryPosition | undefined;
    const merger = createConsecutiveHumanRoundMerger(round => {
        roundCount = round.roundIndex;
        const projected = projectCodexCorpusRound(options.conversationId, round, positions, roles, undefined, options.originsByPath);
        const first = getRoundUserMessages(round)[0];
        const anchor = first ? positions.get(first.stepIndex ?? round.startStep)?.position : undefined;
        if (anchor?.path && anchor.startByte !== undefined && anchor.endByte !== undefined && anchor.ordinal !== undefined) lastRoundStart = anchor as CodexStreamingHistoryPosition;
        if (options.onRound) options.onRound(round.roundIndex, projected);
        else if (!options.onCanonicalRound) messages.push(...projected);
        options.onCanonicalRound?.(round, projected);
        let lastStep = round.startStep;
        for (const message of getRoundUserMessages(round)) lastStep = Math.max(lastStep, message.stepIndex ?? round.startStep);
        for (const response of round.aiResponses) lastStep = Math.max(lastStep, response.stepIndex);
        for (const event of round.semanticEvents || []) lastStep = Math.max(lastStep, event.stepIndex ?? round.startStep);
        if (!options.retainPositions) for (const key of positions.keys()) if (key <= lastStep) positions.delete(key);
    }, options.startRound || 1);
    const collector = createCodexRoundCollector({ cwd: options.cwd, retainRounds: false, bodyOnly: !roles.includes("tool"), onRound: round => merger.append(round) });
    return {
        addEvent(event, position) {
            step += 1;
            const payload = event?.payload || {};
            const messageId = payload.message_id || payload.messageId || payload.item_id || payload.itemId || payload.id || event?.message_id || event?.id;
            const timestamp = typeof event?.timestamp === "string" ? event.timestamp : typeof payload.timestamp === "string" ? payload.timestamp : undefined;
            if (options.retainPositions || roles.includes("tool") || (event?.type === "response_item" && payload.type === "message") || (event?.type === "event_msg" && (payload.type === "user_message" || payload.type === "agent_message" || payload.type === "item_completed" || payload.type === "collab_waiting_end" || payload.type === "collab_agent_spawn_end"))) positions.set(step, { position: { ...position, ...(typeof messageId === "string" ? { messageId } : {}) }, timestamp });
            collector.addEvent(event, position.startByte);
        },
        finish() {
            collector.finish();
            merger.finish();
            return { messages, lastRoundStart, roundCount };
        },
    };
}
