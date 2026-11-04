import type { ChunkDigest, CompactionSnapshot, SummaryBatch, SummaryNode } from './contracts.js';
import { derivedContextId, hashContext } from './config.js';
import { sealSummaryNode } from './view.js';
import { ContextFault } from './errors.js';
import { feedbackSourceNodeIds } from './feedback.js';

export function semanticTailInput(nodes: SummaryNode[], roundId?: string) {
    const tail = nodes.at(-1);
    if (!tail) return null;
    return { nodeId: tail.nodeId, hash: tail.hash, firstSeq: tail.firstSeq, lastSeq: tail.lastSeq,
        roundIds: tail.roundIds, body: tail.body, skeleton: tail.skeleton, title: tail.title,
        sourceSpanCount: tail.sourceSpans.length, anchorCount: tail.anchors.length,
        retrieval: { nodeId: tail.nodeId, hash: tail.hash },
        continuesPreviousRequired: roundId !== undefined && tail.roundIds.includes(roundId) };
}

export function applySemanticChunk(nodes: SummaryNode[], chunk: ChunkDigest, snapshot: CompactionSnapshot): SummaryNode[] {
    const round = snapshot.manifest.rounds.find(entry => entry.roundId === chunk.roundId);
    if (!round) throw new ContextFault('SOURCE_GAP', '语义增量块缺少冻结完整轮来源');
    const tail = nodes.at(-1);
    const sameRound = tail?.roundIds.includes(chunk.roundId) === true;
    if (sameRound && chunk.digest.continuesPrevious === false) throw new ContextFault('SOURCE_GAP', '同一轮的亚轮摘要须接续已有末段');
    const continuing = tail !== undefined && (sameRound || chunk.digest.continuesPrevious === true);
    const prefix = tail && continuing ? nodes.slice(0, -1) : [...nodes];
    if (tail && !continuing && chunk.digest.reorganizedTail) {
        const { hash: _hash, ...content } = tail;
        const reorganized = chunk.digest.reorganizedTail;
        prefix[prefix.length - 1] = sealSummaryNode({ ...content, body: reorganized.body, skeleton: reorganized.skeleton, title: reorganized.title });
    }
    const unique = <Value>(values: Value[]) => [...new Map(values.map(value => [hashContext(value), value])).values()];
    const previous = continuing ? tail : undefined;
    const node = sealSummaryNode<SummaryBatch>({ kind: 'batch', nodeId: derivedContextId([snapshot.candidateId, chunk.chunkId, 'semantic']),
        firstSeq: previous?.firstSeq ?? round.firstSeq, lastSeq: round.lastSeq,
        roundIds: [...new Set([...(previous?.roundIds ?? []), round.roundId])],
        sourceSpans: unique([...(previous?.sourceSpans ?? []), ...chunk.sourceSpans]),
        chunkIds: [...(previous?.chunkIds ?? []), chunk.chunkId], parentBatchIds: previous ? [previous.nodeId] : snapshot.parentBatchIds,
        modelFingerprint: snapshot.effectiveModelFingerprint, body: chunk.digest.body, skeleton: chunk.digest.skeleton, title: chunk.digest.title,
        unresolved: structuredClone(previous?.unresolved ?? []),
        anchors: unique([...(previous?.anchors ?? []), ...chunk.anchors]),
        exchangeId: previous?.exchangeId ?? previous?.nodeId ?? derivedContextId(['exchange', snapshot.conversationId, snapshot.historyEpoch, round.roundId]),
        ...(previous ? { feedbackSourceNodeIds: feedbackSourceNodeIds(previous) } : {}) });
    return [...prefix, node];
}
