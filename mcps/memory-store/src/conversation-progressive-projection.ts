import { createHash } from "node:crypto";
import { codexCorpusAttachmentReferences } from "./conversation-corpus-reader-projection.js";
import { ProgressiveCacheError } from "./conversation-progressive-cache.js";
import { normalizeProgressiveProjection, PROGRESSIVE_MESSAGE_ROLES, type ProgressiveRequest } from "./conversation-progressive-task-types.js";
import type { ProgressiveBlock, ProgressiveCache, ProgressivePublishInput, ProgressiveSource, ProgressiveWriter } from "./conversation-progressive-types.js";
import type { CorpusMessageRole } from "./conversation-corpus-types.js";
import type { ConversationRound } from "./trajectory.js";

type Projection = ReturnType<typeof normalizeProgressiveProjection>;
const format = "progressive-projection/v1";

export function projectProgressiveSource(source: ProgressiveSource, request: Pick<ProgressiveRequest, "messageRoles" | "depth">): ProgressiveSource {
    const projection = { format, ...normalizeProgressiveProjection(request.messageRoles, request.depth) };
    return { ...source, revision: createHash("sha256").update(JSON.stringify([source.revision, projection])).digest("hex"),
        snapshot: { source: source.snapshot, projection } };
}

export function availableProgressiveRoles(source: ProgressiveSource): readonly CorpusMessageRole[] {
    const projection = (source.snapshot as { projection?: { format?: string; messageRoles?: string[]; depth?: string } })?.projection;
    if (!projection) return PROGRESSIVE_MESSAGE_ROLES;
    if (projection.format !== format || !projection.messageRoles?.length) throw new Error("Invalid progressive projection metadata");
    return normalizeProgressiveProjection(projection.messageRoles, projection.depth).messageRoles;
}

export function projectProgressiveRound(round: ConversationRound, projection: Projection): ConversationRound {
    const { messageRoles, depth } = projection;
    if (depth === "full" && PROGRESSIVE_MESSAGE_ROLES.every(role => messageRoles.includes(role))) return round;
    const user = messageRoles.includes("user");
    const assistant = messageRoles.includes("assistant");
    const tools = messageRoles.includes("tool");
    const subagent = messageRoles.includes("subagent");
    const references = codexCorpusAttachmentReferences(round);
    return {
        ...round,
        userMessage: user ? round.userMessage : "",
        mediaAttachments: user ? references.mediaAttachments || [] : [],
        attachments: user ? references.attachments : undefined,
        userMessages: user ? round.userMessages?.map(message => {
            const attachments = codexCorpusAttachmentReferences(message);
            return { ...message, attachments: attachments.attachments, mediaAttachments: attachments.mediaAttachments };
        }) : [],
        aiResponses: assistant ? round.aiResponses.map(response => ({ ...response,
            thinking: depth === "full" ? response.thinking : "", toolCalls: tools ? response.toolCalls : [] })) : [],
        toolCalls: tools ? round.toolCalls : [],
        taskBoundaries: tools ? round.taskBoundaries : [],
        codeActions: tools ? round.codeActions : [],
        fileViews: tools ? round.fileViews : undefined,
        compactionSummaries: depth === "full" ? round.compactionSummaries : undefined,
        subagentSummaries: subagent ? round.subagentSummaries : [],
        semanticEvents: round.semanticEvents?.filter(event => messageRoles.includes(event.semanticRole === "model" ? "assistant" : event.semanticRole as CorpusMessageRole))
            .map(event => tools ? event : { ...event, argsFull: undefined, resultFull: undefined, resultSummary: undefined,
                ...codexCorpusAttachmentReferences(event) }),
    };
}

export function projectProgressiveInput(input: ProgressivePublishInput, request: Pick<ProgressiveRequest, "messageRoles" | "depth">): ProgressivePublishInput {
    const projection = normalizeProgressiveProjection(request.messageRoles, request.depth);
    return { ...input, rounds: input.rounds.map(round => projectProgressiveRound(round, projection)),
        messages: input.messages.filter(message => projection.messageRoles.includes(message.role)) };
}

export async function publishProgressiveBlocks(cache: ProgressiveCache, writer: ProgressiveWriter, input: ProgressivePublishInput, check: () => void = () => {}): Promise<ProgressiveBlock[]> {
    check();
    try { return [await cache.publish(writer, input)]; }
    catch (error) {
        if (!(error instanceof ProgressiveCacheError) || error.code !== "size_limit" || !error.message.startsWith("Block/row budget exceeded")) throw error;
        if (input.rounds.length <= 1) {
            const bytes = Buffer.byteLength(JSON.stringify({ round: input.rounds[0], messages: input.messages })) + 1;
            throw new ProgressiveCacheError("size_limit", "Single canonical round " + input.rounds[0]?.roundIndex + " exceeds the progressive block/row budget; serialized row=" + bytes
                + " UTF-8 bytes. Requested content was retained. Use the legacy read/fetch path with progressive=false for this target. " + error.message);
        }
        const middle = Math.floor(input.rounds.length / 2);
        const blocks: ProgressiveBlock[] = [];
        for (const [offset, rounds] of [[0, input.rounds.slice(0, middle)], [middle, input.rounds.slice(middle)]] as const) {
            const startRound = rounds[0].roundIndex;
            const endRound = rounds.at(-1)!.roundIndex;
            blocks.push(...await publishProgressiveBlocks(cache, writer, { ...input, rounds,
                coverage: { ...input.coverage, startRound, endRound },
                ...(input.order === undefined ? {} : { order: input.order + offset }),
                messages: input.messages.filter(message => message.round >= startRound && message.round <= endRound),
            }, check));
        }
        return blocks;
    }
}
