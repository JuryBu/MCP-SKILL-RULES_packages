import { getRoundUserMessages, type ConversationMessageRole, type ConversationRound, type ConversationUserMessage } from "./trajectory.js";
import { projectRecordToolMaterial, type RecordRoundToolMaterial } from "./record-tool-material.js";

export interface ConversationRecordProjectionMessage {
    role: "user" | "assistant";
    text: string;
    rawRole?: string;
    semanticRole?: ConversationMessageRole;
    stepIndex?: number;
    recordToolMaterial?: RecordRoundToolMaterial;
    attachments?: ConversationRound["attachments"];
    mediaAttachments?: readonly string[];
    annotations?: ConversationUserMessage["annotations"];
}

export interface ConversationRecordProjectionRound {
    bodyMetadataVersion?: 2;
    recordToolMaterialVersion?: 1;
    roundIndex: number;
    messages: ConversationRecordProjectionMessage[];
}

export function projectConversationRoundForRecord(
    round: ConversationRound,
    index: number,
): ConversationRecordProjectionRound {
    const userMessages: ConversationUserMessage[] = getRoundUserMessages(round);
    const messages: ConversationRecordProjectionMessage[] = userMessages.map(message => {
        const projection: ConversationRecordProjectionMessage = {
            role: "user",
            text: message.text,
            stepIndex: message.stepIndex ?? round.startStep,
        };
        if (message.rawRole !== undefined) projection.rawRole = message.rawRole;
        if (message.semanticRole !== undefined) projection.semanticRole = message.semanticRole;
        if (message.attachments !== undefined) projection.attachments = message.attachments;
        if (message.mediaAttachments !== undefined) projection.mediaAttachments = message.mediaAttachments;
        if (message.annotations !== undefined) projection.annotations = message.annotations.map(annotation => ({ ...annotation }));
        return projection;
    });
    for (const response of round.aiResponses) {
        const attachments = (round.semanticEvents || []).filter(event => event.semanticRole === "model" && event.stepIndex === response.stepIndex).flatMap(event => event.attachments || []);
        if (!response.response && response.toolCalls.length > 0 && !attachments.length) continue;
        messages.push({ role: "assistant", text: response.response, stepIndex: response.stepIndex, ...(attachments.length ? { attachments } : {}) });
    }
    if (messages.length === 0) messages.push({ role: "assistant", text: "", stepIndex: round.startStep });
    messages[0].recordToolMaterial = projectRecordToolMaterial(round);
    return {
        bodyMetadataVersion: 2,
        recordToolMaterialVersion: 1,
        roundIndex: round.roundIndex || index + 1,
        messages,
    };
}
