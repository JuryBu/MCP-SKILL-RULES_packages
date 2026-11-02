import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readSync,
    statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { ContentWrite } from './port.js';
import type { SqlDatabase } from './internal.js';
import { sha256, storagePath } from './objects.js';

const HEADER = Buffer.from([83, 65, 72, 49, 0, 0, 0, 1]);
const MAX_FRAME_BYTES = 256 * 1024;
const TARGET_SEGMENT_BYTES = 4 * 1024 * 1024;
const HARD_SEGMENT_BYTES = 32 * 1024 * 1024;

export interface SegmentFrame {
    content: ContentWrite;
    objectHash: string;
    seq: number;
    frameNo: number;
    offset: number;
    hash: string;
}

export interface PreparedSegment {
    segmentId: string;
    conversationId: string;
    path: string;
    originalOffset: number;
    committedOffset: number;
    firstSeq: number;
    generation: number;
    originalFrameCount: number;
    created: boolean;
    frames: SegmentFrame[];
}

export function prepareSegments(database: SqlDatabase, root: string,
    contents: { content: ContentWrite; objectHash: string }[]): PreparedSegment[] {
    const prepared: PreparedSegment[] = [];
    try {
        const byConversation = new Map<string, typeof contents>();
        for (const content of contents) {
            const group = byConversation.get(content.content.conversationId) ?? [];
            group.push(content);
            byConversation.set(content.content.conversationId, group);
        }
        for (const [conversationId, group] of byConversation) {
            const previous = database.prepare('SELECT * FROM segments WHERE cid = ? AND state = ? ORDER BY first_seq DESC LIMIT 1')
                .get(conversationId, 'tail');
            const conversation = database.prepare('SELECT append_seq FROM conversations WHERE cid = ?').get(conversationId);
            let seq = Number(conversation?.append_seq ?? 0);
            let current: PreparedSegment | undefined;
            if (previous && Number(previous.committed_offset) < TARGET_SEGMENT_BYTES) {
                current = { segmentId: String(previous.segment_id), conversationId, path: String(previous.path),
                    originalOffset: Number(previous.committed_offset), committedOffset: Number(previous.committed_offset),
                    firstSeq: Number(previous.first_seq), generation: Number(previous.generation),
                    originalFrameCount: Number(previous.frame_count), created: false, frames: [] };
                verifyTail(root, current);
            }
            for (const entry of group) {
                const payload = Buffer.from(canonicalJson({ contentId: entry.content.contentId, kind: entry.content.kind,
                    objectHash: entry.objectHash, history: entry.content.history }));
                if (payload.length > MAX_FRAME_BYTES) throw new AgentFault('STORAGE_CONTENT_LIMIT', '历史帧超过256KiB');
                const frameBytes = payload.length + 36;
                if (!current || current.committedOffset + frameBytes > TARGET_SEGMENT_BYTES) {
                    const segmentId = randomUUID();
                    current = { segmentId, conversationId,
                        path: join('segments', sha256(conversationId), `${segmentId}.sah`), originalOffset: 0,
                        committedOffset: HEADER.length, firstSeq: seq + 1, generation: 1,
                        originalFrameCount: 0, created: true, frames: [] };
                    prepared.push(current);
                    const fullPath = storagePath(root, current.path);
                    mkdirSync(dirname(fullPath), { recursive: true });
                    const descriptor = openSync(fullPath, 'wx', 0o600);
                    try { writeAll(descriptor, HEADER, 0); fsyncSync(descriptor); } finally { closeSync(descriptor); }
                } else if (!prepared.includes(current)) prepared.push(current);
                const hash = sha256(payload);
                const frame = Buffer.allocUnsafe(frameBytes);
                frame.writeUInt32BE(payload.length, 0);
                Buffer.from(hash, 'hex').copy(frame, 4);
                payload.copy(frame, 36);
                const descriptor = openSync(storagePath(root, current.path), 'r+');
                try {
                    writeAll(descriptor, frame, current.committedOffset);
                    fsyncSync(descriptor);
                } finally { closeSync(descriptor); }
                seq += 1;
                current.frames.push({ content: entry.content, objectHash: entry.objectHash, seq,
                    frameNo: current.originalFrameCount + current.frames.length, offset: current.committedOffset, hash });
                current.committedOffset += frameBytes;
            }
        }
        return prepared;
    } catch (error) {
        rollbackSegments(root, prepared);
        if (error instanceof AgentFault) throw error;
        throw new AgentFault('STORAGE_DURABILITY_FAILED', '历史帧未能可靠同步，追加未提交');
    }
}

export function commitSegments(database: SqlDatabase, segments: PreparedSegment[]): void {
    for (const segment of segments) {
        if (!segment.frames.length) continue;
        database.prepare('UPDATE segments SET state = ? WHERE cid = ? AND state = ? AND segment_id <> ?')
            .run('sealed', segment.conversationId, 'tail', segment.segmentId);
        database.prepare('INSERT INTO segments (segment_id,cid,first_seq,last_seq,raw_bytes,stored_bytes,codec,path,committed_offset,state,generation,frame_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(segment_id) DO UPDATE SET last_seq=excluded.last_seq,raw_bytes=excluded.raw_bytes,stored_bytes=excluded.stored_bytes,committed_offset=excluded.committed_offset,frame_count=excluded.frame_count')
            .run(segment.segmentId, segment.conversationId, segment.firstSeq, segment.frames.at(-1)!.seq,
                segment.committedOffset, segment.committedOffset, 'identity', segment.path, segment.committedOffset,
                'tail', segment.generation, segment.originalFrameCount + segment.frames.length);
        for (const frame of segment.frames) {
            const history = frame.content.history!;
            if (history.view === 'raw' && history.role === 'user' && history.roundId) {
                database.prepare('INSERT OR IGNORE INTO history_rounds (cid,round_id,round_no) SELECT ?,?,COALESCE(MAX(round_no),0)+1 FROM history_rounds WHERE cid = ?')
                    .run(segment.conversationId, history.roundId, segment.conversationId);
            }
            database.prepare('INSERT INTO items (cid,seq,item_id,round_id,step_id,kind,segment_id,frame_no,frame_offset,payload_hash,object_hash,content_id,history_json,history_view,history_effective,history_indexed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)')
                .run(segment.conversationId, frame.seq, `${sha256(segment.conversationId)}:${frame.seq}`,
                    history.roundId, history.stepId, frame.content.kind,
                    segment.segmentId, frame.frameNo, frame.offset, frame.hash, frame.objectHash,
                    frame.content.contentId, canonicalJson(history), history.view, history.effective ? 1 : 0);
        }
        database.prepare('UPDATE conversations SET append_seq = ? WHERE cid = ?')
            .run(segment.frames.at(-1)!.seq, segment.conversationId);
        database.prepare('INSERT OR IGNORE INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id) VALUES (?,?,?,?,?,?)')
            .run(segment.conversationId, 'history', segment.segmentId, 'segment', 'segment', segment.segmentId);
    }
}

export function rollbackSegments(root: string, segments: PreparedSegment[]): void {
    for (const segment of segments) {
        const fullPath = storagePath(root, segment.path);
        if (!existsSync(fullPath)) continue;
        if (segment.created) unlinkSync(fullPath);
        else {
            const descriptor = openSync(fullPath, 'r+');
            try { ftruncateSync(descriptor, segment.originalOffset); fsyncSync(descriptor); } finally { closeSync(descriptor); }
        }
    }
}

export function verifyTail(root: string, segment: Pick<PreparedSegment, 'path' | 'committedOffset'>): void {
    const fullPath = storagePath(root, segment.path);
    try {
        const size = statSync(fullPath).size;
        if (segment.committedOffset < HEADER.length || segment.committedOffset > HARD_SEGMENT_BYTES || size < segment.committedOffset) throw new Error('size');
        const descriptor = openSync(fullPath, 'r');
        try {
            const header = Buffer.alloc(HEADER.length);
            if (readSync(descriptor, header, 0, header.length, 0) !== header.length || !header.equals(HEADER)) throw new Error('header');
        } finally { closeSync(descriptor); }
        if (size !== segment.committedOffset) throw new AgentFault('STORAGE_RECOVERY_REQUIRED', '历史尾部存在未提交字节，需先完成恢复');
    } catch (error) {
        if (error instanceof AgentFault) throw error;
        throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '历史段缺失或头部校验失败');
    }
}

function writeAll(descriptor: number, bytes: Buffer, position: number): void {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset, position + offset);
}
