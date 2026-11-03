import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { HistoryItem } from '../storage/port.js';
import type { HistoryRecallPort, HistorySearchArguments } from './history.js';
import { assertHistoryCurrent, readHistoryRoundNumbers } from './history.js';
import type { ToolExecutionContext } from './types.js';

interface SearchPosition {
    kind: 'history_search';
    version: 1;
    fingerprint: string;
    historyCursor?: string;
    historyEpoch?: number;
    throughSeq?: number;
    itemSeq?: number;
    itemHash?: string;
    byteOffset: number;
}

export async function searchHistory(port: Pick<HistoryRecallPort, 'readHistory' | 'readArtifact' | 'inspect'>,
    args: HistorySearchArguments, context: ToolExecutionContext): Promise<unknown> {
    await assertHistoryCurrent(context);
    const capture = await port.inspect(context.conversationId);
    await assertHistoryCurrent(context);
    const roundNumbers = new Map(capture.rounds.filter(round => Number.isSafeInteger(round.roundNumber) && round.roundNumber! > 0)
        .map(round => [round.roundId, round.roundNumber!]));
    const fingerprint = createHash('sha256').update(canonicalJson([context.conversationId, args.query,
        args.startRound ?? null, args.endRound ?? null])).digest('hex');
    let position: SearchPosition = { kind: 'history_search', version: 1, fingerprint, byteOffset: 0 };
    if (args.cursor) {
        try {
            const saved = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')) as SearchPosition;
            if (saved.kind !== 'history_search' || saved.version !== 1 || saved.fingerprint !== fingerprint
                || !Number.isSafeInteger(saved.byteOffset) || saved.byteOffset < 0
                || saved.historyCursor !== undefined && typeof saved.historyCursor !== 'string'
                || saved.historyEpoch !== undefined && (!Number.isSafeInteger(saved.historyEpoch) || saved.historyEpoch < 0)
                || saved.throughSeq !== undefined && (!Number.isSafeInteger(saved.throughSeq) || saved.throughSeq < 0)
                || saved.itemSeq !== undefined && (!Number.isSafeInteger(saved.itemSeq) || saved.itemSeq < 1)
                || saved.itemHash !== undefined && typeof saved.itemHash !== 'string') throw new Error();
            position = saved;
        } catch { throw new AgentFault('STORAGE_CURSOR_STALE', '历史搜索游标与当前查询、会话或轮范围不一致'); }
    }
    const needle = Buffer.from(JSON.stringify(args.query).slice(1, -1));
    const hits: Record<string, unknown>[] = [];
    let scannedBytes = 0;
    let scannedItems = 0;
    let resultBytes = 0;
    let exhausted = false;
    let firstSeq: number | null = null;
    let lastSeq: number | null = null;
    const resumedFrom = { seq: position.itemSeq ?? null, byteOffset: position.byteOffset };
    const finish = () => ({ sourceHost: 'agent-server', representation: 'canonical_json_literal', query: args.query, items: hits,
        hasMore: !exhausted, nextCursor: exhausted ? null : Buffer.from(JSON.stringify(position)).toString('base64url'),
        historyEpoch: position.historyEpoch, throughSeq: position.throughSeq, scannedBytes, scannedItems,
        coverage: { requestedStartRound: args.startRound ?? null, requestedEndRound: args.endRound ?? null,
            firstSeq, lastSeq, complete: exhausted, scanBudgetBytes: args.scanBytes, scannedBytes, resumedFrom,
            scannedThrough: { seq: position.itemSeq ?? lastSeq, byteOffset: position.byteOffset } }, usefulHitTool: 'mark_history_hit' });
    const makeHit = async (item: HistoryItem, bytes: Buffer, index: number, absoluteOffset: number) => {
        if (item.roundId && capture.historyEpoch === position.historyEpoch && !roundNumbers.has(item.roundId)) {
            const numbers = await readHistoryRoundNumbers(port, { ...capture, appendSeq: position.throughSeq! }, context, new Set([item.roundId]));
            for (const [roundId, number] of numbers) roundNumbers.set(roundId, number);
        }
        return {
            itemId: item.itemId, contentId: item.contentId, seq: item.seq, roundId: item.roundId,
            roundNumber: item.roundId && capture.historyEpoch === position.historyEpoch ? roundNumbers.get(item.roundId) ?? null : null,
            role: item.role, kind: item.kind, sha256: item.objectRef.hash, byteOffset: absoluteOffset, byteLength: needle.length,
            snippet: bytes.subarray(Math.max(0, index - 96), Math.min(bytes.length, index + Math.min(needle.length, 512) + 160)).toString('utf8'),
            originalRead: { tool: 'history_read', arguments: { artifactId: item.contentId, offset: Math.max(0, absoluteOffset - 96), maxBytes: args.maxBytes } },
            usefulHit: item.roundId && capture.historyEpoch === position.historyEpoch && roundNumbers.has(item.roundId)
                ? { tool: 'mark_history_hit', arguments: { roundHit: roundNumbers.get(item.roundId)! } } : null,
        };
    };
    while (scannedItems < 64 && scannedBytes < args.scanBytes) {
        await assertHistoryCurrent(context);
        const page = await port.readHistory({ conversationId: context.conversationId, cursor: position.historyCursor,
            startRound: args.startRound, endRound: args.endRound, direction: 'forward', limit: 1, maxBytes: 4096,
            view: 'raw', effectiveOnly: true, includeValues: false, expectedHistoryEpoch: position.historyEpoch, throughSeq: position.throughSeq });
        await assertHistoryCurrent(context);
        position.historyEpoch = page.historyEpoch;
        position.throughSeq = page.appendSeq;
        const item = page.items[0];
        if (!item) { exhausted = true; break; }
        if (position.itemSeq !== undefined && (position.itemSeq !== item.seq || position.itemHash !== item.objectRef.hash)) {
            throw new AgentFault('STORAGE_CURSOR_STALE', '搜索中的原文项或来源hash已变化');
        }
        firstSeq ??= item.seq;
        lastSeq = item.seq;
        position.itemSeq = item.seq;
        position.itemHash = item.objectRef.hash;
        scannedItems++;
        while (position.byteOffset < item.objectRef.rawBytes) {
            await assertHistoryCurrent(context);
            const offset = Math.max(0, position.byteOffset - needle.length + 1);
            const remaining = args.scanBytes - scannedBytes;
            if (remaining <= position.byteOffset - offset) return finish();
            const chunk = await port.readArtifact({ conversationId: context.conversationId, artifactId: item.contentId,
                offset, maxBytes: Math.min(64 * 1024, remaining) });
            await assertHistoryCurrent(context);
            if (chunk.sha256 !== item.objectRef.hash || chunk.totalBytes !== item.objectRef.rawBytes || chunk.offset !== offset) {
                throw new AgentFault('STORAGE_CURSOR_STALE', '搜索读取的原文与来源引用不一致');
            }
            const bytes = Buffer.from(chunk.dataBase64, 'base64');
            if (offset + bytes.length <= position.byteOffset) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '原文分片未向前推进');
            scannedBytes += bytes.length;
            const searchedThrough = position.byteOffset;
            for (let index = bytes.indexOf(needle); index >= 0; index = bytes.indexOf(needle, index + needle.length)) {
                const absoluteOffset = offset + index;
                if (absoluteOffset + needle.length <= searchedThrough) continue;
                const hit = await makeHit(item, bytes, index, absoluteOffset);
                let size = Buffer.byteLength(canonicalJson(hit)) + 1;
                if (!hits.length && size > args.maxBytes - 2048) {
                    hit.snippet = hit.snippet.slice(0, 128);
                    size = Buffer.byteLength(canonicalJson(hit)) + 1;
                    if (size > args.maxBytes - 2048) throw new AgentFault('FRAME_TOO_LARGE', '单个历史命中引用超过输出预算，请增大maxBytes', { requiredBytes: size + 2048 });
                }
                if (resultBytes + size > args.maxBytes - 2048) {
                    position.byteOffset = Math.max(position.byteOffset, absoluteOffset);
                    return finish();
                }
                hits.push(hit);
                resultBytes += size;
                position.byteOffset = absoluteOffset + needle.length;
                if (hits.length >= args.limit) return finish();
            }
            position.byteOffset = offset + bytes.length;
        }
        if (!page.hasMore) { exhausted = true; break; }
        if (!page.nextCursor || page.nextCursor === position.historyCursor) throw new AgentFault('STORAGE_CURSOR_STALE', '历史分页未向前推进');
        position.historyCursor = page.nextCursor;
        delete position.itemSeq;
        delete position.itemHash;
        position.byteOffset = 0;
    }
    return finish();
}
