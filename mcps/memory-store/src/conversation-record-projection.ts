import { getRoundUserMessages, type ConversationMessageRole, type ConversationRound, type ConversationUserMessage } from "./trajectory.js";

export interface ConversationRecordProjectionMessage {
    role: "user" | "assistant";
    text: string;
    rawRole?: string;
    semanticRole?: ConversationMessageRole;
    attachments?: ConversationRound["attachments"];
    mediaAttachments?: readonly string[];
}

export interface ConversationRecordProjectionRound {
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
        };
        if (message.rawRole !== undefined) projection.rawRole = message.rawRole;
        if (message.semanticRole !== undefined) projection.semanticRole = message.semanticRole;
        if (message.attachments !== undefined) projection.attachments = message.attachments;
        if (message.mediaAttachments !== undefined) projection.mediaAttachments = message.mediaAttachments;
        return projection;
    });
    for (const response of round.aiResponses) {
        if (!response.response && response.toolCalls.length > 0) continue;
        messages.push({ role: "assistant", text: response.response });
    }
    return {
        roundIndex: round.roundIndex || index + 1,
        messages,
    };
}
