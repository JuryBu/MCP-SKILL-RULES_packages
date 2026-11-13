import type { ContextCapture, ContextHistoryPort, ContextPolicy, RoundBoundary, SourceManifest, ContextSourcePort, SourceBlock } from './contracts.js';
import type { HistoryItem } from '../storage/port.js';
import { canonicalJson } from '../protocol.js';
import { hashContext } from './config.js';
import { checkAbort, ContextFault } from './errors.js';

export interface RoundSelection {
    targets: RoundBoundary[];
    retained: RoundBoundary[];
    references: RoundBoundary[];
}

export function selectCompactionRounds(capture: ContextCapture, policy: ContextPolicy): RoundSelection {
    const rounds = capture.rounds;
    const seen = new Set<string>();
    let lastSeq = 0;
    for (const round of rounds) {
        if (!round.roundId || seen.has(round.roundId) || !Number.isSafeInteger(round.firstSeq) || round.firstSeq <= lastSeq || round.lastSeq < round.firstSeq
            || !Number.isSafeInteger(round.lastSeq) || !Number.isSafeInteger(round.lastStepSeq) || round.lastStepSeq < 0
            || round.lastSeq > capture.appendSeq || !round.itemIds.length
            || (round.roundNumber !== undefined && (!Number.isSafeInteger(round.roundNumber) || round.roundNumber < 1))
            || new Set(round.itemIds).size !== round.itemIds.length) {
            throw new ContextFault('SOURCE_GAP', '完整轮次索引存在缺口、冲突或无效顺序', { roundId: round.roundId });
        }
        seen.add(round.roundId);
        lastSeq = round.lastSeq;
    }
    if (capture.view.historyEpoch !== capture.historyEpoch || capture.view.revision !== capture.viewRevision
        || capture.view.coveredEndSeq > capture.appendSeq) throw new ContextFault('PARENT_STALE', '摘要视图与当前历史索引不一致');
    const prefix = capture.activeCompletedPrefix;
    const complete = rounds.filter(round => round.complete && round.roundId !== capture.activeRoundId);
    const retainedIds = new Set((prefix ? [] : complete.slice(Math.max(0, complete.length - policy.keepCompleteRounds))).map(round => round.roundId));
    if (capture.activeRoundId && !prefix) retainedIds.add(capture.activeRoundId);
    const targets: RoundBoundary[] = [];
    for (const original of rounds) {
        const round = original.roundId === capture.activeRoundId && prefix ? prefix : original;
        if (round.lastSeq <= capture.view.coveredEndSeq) continue;
        if (round.firstSeq <= capture.view.coveredEndSeq) throw new ContextFault('SOURCE_GAP', '已有压缩游标切断了完整轮次', { roundId: round.roundId });
        if (retainedIds.has(round.roundId) || !round.complete || round.nativePairing !== 'complete') break;
        targets.push(structuredClone(round));
    }
    const targetIds = new Set(targets.map(round => round.roundId));
    const first = targets.length ? rounds.findIndex(round => round.roundId === targets[0].roundId) : -1;
    const references = [rounds[first - 1]].filter((round): round is RoundBoundary => Boolean(round) && !targetIds.has(round.roundId));
    const retained = rounds.flatMap(round => {
        if (round.lastSeq <= capture.view.coveredEndSeq) return [];
        if (!targetIds.has(round.roundId)) return [round];
        if (!prefix || round.roundId !== prefix.roundId) return [];
        const consumed = new Set(prefix.itemIds);
        return [{ ...round, firstSeq: prefix.lastSeq + 1, itemIds: round.itemIds.filter(itemId => !consumed.has(itemId)) }];
    });
    return { targets, retained, references };
}

export async function readSelectedHistory(port: ContextHistoryPort, capture: ContextCapture, rounds: RoundBoundary[], maxBytes: number,
    signal?: AbortSignal, includeValues = true): Promise<HistoryItem[]> {
    if (!rounds.length) return [];
    const expected = new Map(rounds.flatMap(round => round.itemIds.map(itemId => [itemId, round] as const)));
    const selected = new Map<string, HistoryItem>();
    const roundNumbers = rounds.map(round => round.roundNumber ?? capture.rounds.findIndex(entry => entry.roundId === round.roundId) + 1);
    const numbered = rounds.every(round => round.roundNumber !== undefined) || capture.rounds[0]?.firstSeq === 1;
    let cursor: string | undefined;
    let previousSeq = 0;
    const cursors = new Set<string>();
    do {
        checkAbort(signal);
        const page = await port.readHistory({ conversationId: capture.conversationId, cursor, limit: 50, maxBytes,
            direction: 'forward', view: 'raw', effectiveOnly: true, includeValues, expectedHistoryEpoch: capture.historyEpoch,
            throughSeq: capture.appendSeq, ...(numbered ? { startRound: Math.min(...roundNumbers), endRound: Math.max(...roundNumbers) } : {}) });
        if (page.historyEpoch !== capture.historyEpoch || page.appendSeq !== capture.appendSeq) {
            throw new ContextFault('HISTORY_STALE', '来源历史页与冻结版本或追加上限不一致');
        }
        if (page.viewRevision !== capture.viewRevision) throw new ContextFault('PARENT_STALE', '读取期间摘要视图已经变化');
        if (Buffer.byteLength(canonicalJson(page.items)) > maxBytes) throw new ContextFault('SOURCE_GAP', '来源历史页超过读取上限');
        for (const item of page.items) {
            if (item.seq <= previousSeq || item.seq > capture.appendSeq || !item.effective || item.view !== 'raw') {
                throw new ContextFault('SOURCE_GAP', '来源历史页顺序、消费状态或范围无效', { itemId: item.itemId });
            }
            previousSeq = item.seq;
            const round = expected.get(item.itemId);
            if (!round) continue;
            if (selected.has(item.itemId) || item.roundId !== round.roundId || item.seq < round.firstSeq || item.seq > round.lastSeq) {
                throw new ContextFault('SOURCE_GAP', '来源项目与完整轮次清单冲突', { itemId: item.itemId });
            }
            selected.set(item.itemId, item);
        }
        if (!page.hasMore) break;
        if (!page.items.length || !page.nextCursor || cursors.has(page.nextCursor)) throw new ContextFault('SOURCE_GAP', '历史分页未推进');
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
    } while (cursor);
    const missing = [...expected.keys()].filter(itemId => !selected.has(itemId));
    if (missing.length) throw new ContextFault('SOURCE_GAP', '有效已消费历史缺少完整轮次列出的项目', { itemIds: missing });
    return [...selected.values()].sort((left, right) => left.seq - right.seq);
}

export async function createSourceManifest(port: ContextSourcePort, items: HistoryItem[], rounds: RoundBoundary[], signal?: AbortSignal): Promise<SourceManifest> {
    const blocks: SourceBlock[] = [];
    const keys = new Set<string>();
    for (const item of items) {
        checkAbort(signal);
        const described = await port.describe(item, signal);
        if (!described.length) throw new ContextFault('SOURCE_GAP', '来源项目缺少正文或可检索原生锚点', { itemId: item.itemId });
        for (const block of described) {
            const key = JSON.stringify([block.itemId, block.blockId]);
            if (keys.has(key) || block.itemId !== item.itemId || block.contentId !== item.contentId || block.seq !== item.seq
                || block.roundId !== item.roundId || !Number.isSafeInteger(block.byteLength) || block.byteLength < 0
                || !/^[a-f0-9]{64}$/.test(block.sha256) || (block.kind !== 'text' && block.kind !== 'nativeAnchor')) {
                throw new ContextFault('SOURCE_GAP', '来源块身份、长度或哈希无效', { itemId: item.itemId, blockId: block.blockId });
            }
            keys.add(key);
            blocks.push(structuredClone(block));
        }
    }
    return { blocks, rounds: structuredClone(rounds), hash: hashContext({ blocks, rounds }),
        prefixHash: hashContext(blocks.map(block => [block.itemId, block.blockId, block.seq, block.sha256, block.byteLength])) };
}
