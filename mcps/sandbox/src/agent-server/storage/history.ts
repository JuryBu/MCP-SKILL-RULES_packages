import { closeSync, openSync, readSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonValue } from '../protocol.js';
import { MAX_PAGE_BYTES } from './internal.js';
import type { SqlDatabase, SqlRow } from './internal.js';
import type { HistoryItem, HistoryMetadata, HistoryPage, HistoryQuery } from './port.js';
import { ObjectFiles, sha256, storagePath } from './objects.js';

const HISTORY_PAGE_WORK_MS = 10;

interface HistoryCursor {
    version: 1;
    conversationId: string;
    historyEpoch: number;
    lastSeq: number;
    throughSeq: number;
    direction: 'forward' | 'backward';
    view: 'raw' | 'summary' | 'all';
    effectiveOnly: boolean;
    startRound: number | null;
    endRound: number | null;
}

export function readHistory(database: SqlDatabase, files: ObjectFiles, root: string, query: HistoryQuery): HistoryPage {
    const startedAt = performance.now();
    const limit = query.limit ?? 50;
    const maxBytes = query.maxBytes ?? MAX_PAGE_BYTES;
    const direction = query.direction ?? 'forward';
    const view = query.view ?? 'raw';
    const effectiveOnly = query.effectiveOnly ?? false;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(maxBytes)
        || maxBytes < 1 || maxBytes > 512 * 1024 || !['forward', 'backward'].includes(direction)
        || !['raw', 'summary', 'all'].includes(view)) {
        throw new AgentFault('INVALID_PARAMS', '历史分页参数无效');
    }
    const conversation = database.prepare('SELECT history_epoch,append_seq,view_revision,state FROM conversations WHERE cid = ?').get(query.conversationId);
    if (!conversation) throw new AgentFault('NOT_FOUND', '找不到历史所属会话');
    const historyEpoch = Number(conversation.history_epoch);
    const currentSeq = Number(conversation.append_seq);
    if (query.expectedHistoryEpoch !== undefined && query.expectedHistoryEpoch !== historyEpoch) {
        throw new AgentFault('STORAGE_CURSOR_STALE', '历史版本已经变化');
    }
    const throughSeq = query.throughSeq ?? currentSeq;
    const cursor: HistoryCursor = { version: 1, conversationId: query.conversationId,
        historyEpoch, throughSeq, lastSeq: direction === 'forward' ? 0 : throughSeq + 1, direction,
        view, effectiveOnly, startRound: query.startRound ?? null, endRound: query.endRound ?? null };
    if (query.cursor) {
        try {
            const previous = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as HistoryCursor;
            if (previous.version !== 1 || previous.conversationId !== cursor.conversationId
                || previous.historyEpoch !== cursor.historyEpoch || previous.direction !== direction
                || previous.view !== view || previous.effectiveOnly !== effectiveOnly
                || previous.startRound !== cursor.startRound || previous.endRound !== cursor.endRound
                || !Number.isSafeInteger(previous.lastSeq) || !Number.isSafeInteger(previous.throughSeq)
                || previous.throughSeq < 0 || previous.throughSeq > currentSeq
                || (query.throughSeq !== undefined && query.throughSeq !== previous.throughSeq)) throw new Error('stale');
            cursor.lastSeq = previous.lastSeq;
            cursor.throughSeq = previous.throughSeq;
        } catch { throw new AgentFault('STORAGE_CURSOR_STALE', '历史游标版本或范围已经变化'); }
    }
    if (!Number.isSafeInteger(cursor.throughSeq) || cursor.throughSeq < 0 || cursor.throughSeq > currentSeq) {
        throw new AgentFault('STORAGE_CURSOR_STALE', '历史读取上限已经失效');
    }
    const comparison = direction === 'forward' ? '>' : '<';
    const ordering = direction === 'forward' ? 'ASC' : 'DESC';
    const rows = database.prepare(`SELECT items.*,segments.path,segments.committed_offset,segments.codec,segments.state AS segment_state,objects.raw_bytes FROM items JOIN segments USING(segment_id) JOIN objects ON objects.hash = items.object_hash LEFT JOIN history_rounds ON history_rounds.cid = items.cid AND history_rounds.round_id = items.round_id WHERE items.cid = ? AND items.history_indexed = 1 AND items.seq ${comparison} ? AND items.seq <= ? AND (? = 'all' OR items.history_view = ?) AND (? = 0 OR items.history_effective = 1) AND (? IS NULL OR history_rounds.round_no >= ?) AND (? IS NULL OR history_rounds.round_no <= ?) ORDER BY items.seq ${ordering} LIMIT ?`)
        .all(query.conversationId, cursor.lastSeq, cursor.throughSeq, view, view, effectiveOnly ? 1 : 0,
            cursor.startRound, cursor.startRound, cursor.endRound, cursor.endRound, limit + 1);
    const items: HistoryItem[] = [];
    const descriptors = new Map<string, number>();
    let bytes = 0;
    try {
        for (const row of rows) {
            if (items.length === limit || (items.length > 0 && performance.now() - startedAt >= HISTORY_PAGE_WORK_MS)) break;
            const frame = readFrame(root, row, descriptors);
            const item: HistoryItem = { ...frame.history, itemId: String(row.item_id), seq: Number(row.seq),
                contentId: frame.contentId, kind: String(row.kind), roundId: row.round_id === null ? null : String(row.round_id),
                stepId: row.step_id === null ? null : String(row.step_id),
                objectRef: { hash: String(row.object_hash), rawBytes: Number(row.raw_bytes) } };
            const referenceBytes = Buffer.byteLength(canonicalJson(item));
            if (bytes + referenceBytes > maxBytes) break;
            if (query.includeValues !== false && Number(row.raw_bytes) <= 64 * 1024 && bytes + referenceBytes + Number(row.raw_bytes) + 16 <= maxBytes) {
                item.value = files.read(database, String(row.object_hash)) as JsonValue;
            }
            const itemBytes = Buffer.byteLength(canonicalJson(item));
            if (bytes + itemBytes > maxBytes) break;
            items.push(item);
            bytes += itemBytes;
            cursor.lastSeq = item.seq;
        }
        if (rows.length && !items.length) throw new AgentFault('FRAME_TOO_LARGE', '历史引用超过当前分页预算');
        const hasMore = items.length < rows.length;
        return { items, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null,
            historyEpoch, appendSeq: cursor.throughSeq, viewRevision: Number(conversation.view_revision) };
    } finally {
        const closeErrors: unknown[] = [];
        for (const descriptor of descriptors.values()) {
            try { closeSync(descriptor); } catch (error) { closeErrors.push(error); }
        }
        if (closeErrors.length) throw closeErrors[0];
    }
}

function readFrame(root: string, row: SqlRow, descriptors: Map<string, number>): { contentId: string; kind: string; objectHash: string; history: HistoryMetadata } {
    if (row.codec !== 'identity' || row.segment_state === 'corrupt') {
        throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '该历史段表示不可读', { firstSeq: Number(row.seq), lastSeq: Number(row.seq) });
    }
    const offset = Number(row.frame_offset);
    const committedOffset = Number(row.committed_offset);
    try {
        if (!Number.isSafeInteger(offset) || offset < 8 || offset + 36 > committedOffset) throw new Error('offset');
        const path = storagePath(root, String(row.path));
        let descriptor = descriptors.get(path);
        if (descriptor === undefined) {
            descriptor = openSync(path, 'r');
            descriptors.set(path, descriptor);
        }
        const header = Buffer.alloc(36);
        if (readSync(descriptor, header, 0, header.length, offset) !== header.length) throw new Error('header');
        const length = header.readUInt32BE(0);
        if (length < 1 || length > 256 * 1024 || offset + 36 + length > committedOffset) throw new Error('length');
        const payload = Buffer.alloc(length);
        if (readSync(descriptor, payload, 0, length, offset + 36) !== length) throw new Error('payload');
        const hash = sha256(payload);
        if (hash !== header.subarray(4).toString('hex') || hash !== row.payload_hash) throw new Error('hash');
        const frame = JSON.parse(payload.toString('utf8')) as { contentId: string; kind: string; objectHash: string; history: HistoryMetadata };
        if (frame.objectHash !== row.object_hash || frame.kind !== row.kind || frame.contentId !== row.content_id
            || canonicalJson(frame.history) !== row.history_json) throw new Error('identity');
        return frame;
    } catch {
        throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '历史帧边界或哈希校验失败', { firstSeq: Number(row.seq), lastSeq: Number(row.seq) });
    }
}
