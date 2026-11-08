import { codexCorpusAttachmentReferences } from "./conversation-corpus-reader-projection.js";
import { projectProgressiveRound } from "./conversation-progressive-projection.js";
import { normalizeProgressiveProjection } from "./conversation-progressive-task-types.js";
import type { CorpusMessageRole, CorpusProjection } from "./conversation-corpus-types.js";
import type { ConversationRound, Depth, ExtraType } from "./trajectory.js";

export interface CorpusReadOutputOptions {
    depth?: Depth;
    messageRoles?: readonly string[];
    extraTypes?: readonly ExtraType[];
}

function requestedRoundDetails(
    round: ConversationRound,
    messageRoles: CorpusMessageRole[],
    extraTypes: ReadonlySet<ExtraType>,
    subagentSource = false,
): Record<string, unknown> {
    const projected = projectProgressiveRound(round, { messageRoles, depth: "full" }, subagentSource);
    const details: Record<string, unknown> = {};
    if (extraTypes.has("thinking")) {
        details.thinking = projected.aiResponses.filter(response => response.thinking).map(response => ({
            stepIndex: response.stepIndex, thinking: response.thinking,
        }));
    }
    if (extraTypes.has("tool_results")) {
        details.toolCalls = projected.toolCalls;
        const sourceEvents = round.semanticEvents?.filter(event => ["pb_wire_variant", "local_pb_activity"].includes(event.kind || ""));
        if (sourceEvents?.length) details.sourceEvents = sourceEvents;
    }
    if (extraTypes.has("code_actions") || extraTypes.has("code_diffs")) {
        details.codeActions = projected.codeActions.map(action => ({
            stepIndex: action.stepIndex,
            description: action.description,
            targetFile: action.targetFile,
            ...(extraTypes.has("code_actions") ? { instruction: action.instruction } : {}),
            ...(extraTypes.has("code_diffs") ? { diffs: action.diffs } : {}),
        }));
    }
    if (extraTypes.has("file_views")) details.fileViews = projected.fileViews;
    return details;
}

export function formatCorpusReadProjection(
    projection: CorpusProjection,
    options: CorpusReadOutputOptions = {},
): unknown {
    const selection = normalizeProgressiveProjection(options.messageRoles === undefined && projection.conversation.isChildThread ? ["subagent"] : options.messageRoles, options.depth);
    const extraTypes = new Set(options.extraTypes || []);
    const { rounds: canonicalRounds, messages: canonicalMessages, ...metadata } = projection;
    const subagentSource = Boolean(projection.conversation.isChildThread);
    const messages = canonicalMessages.filter(message => selection.messageRoles.includes(message.role))
        .map(message => selection.depth === "brief" && message.text.length > 100
            ? { ...message, text: message.text.slice(0, 100) + "…", truncated: true, originalTextChars: message.text.length }
            : message);
    if (selection.depth === "full") {
        return {
            ...metadata,
            messages,
            ...(canonicalRounds ? { rounds: canonicalRounds.map(round => projectProgressiveRound(round, selection, subagentSource)) } : {}),
        };
    }
    const messageIdsByRound = new Map<number, string[]>();
    for (const message of messages) {
        const messageIds = messageIdsByRound.get(message.round);
        if (messageIds) messageIds.push(message.id);
        else messageIdsByRound.set(message.round, [message.id]);
    }
    const detailRoles = [...selection.messageRoles];
    if (options.messageRoles === undefined && !detailRoles.includes("tool")
        && [...extraTypes].some(extra => extra !== "thinking")) detailRoles.push("tool");
    const rounds = canonicalRounds?.map(round => ({
        roundIndex: round.roundIndex,
        startStep: round.startStep,
        endStep: round.endStep,
        ...(round.createdAt === undefined ? {} : { createdAt: round.createdAt }),
        ...(round.legacyRoundIndices ? { legacyRoundIndices: [...round.legacyRoundIndices] } : {}),
        messageIds: messageIdsByRound.get(round.roundIndex) || [],
        ...(selection.messageRoles.includes("user") ? codexCorpusAttachmentReferences(round) : {}),
        ...(extraTypes.size ? requestedRoundDetails(round, detailRoles, extraTypes, subagentSource) : {}),
    }));
    return { ...metadata, messages, ...(rounds ? { rounds } : {}) };
}
