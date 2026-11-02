import { AgentFault, canonicalJson } from '../protocol.js';
import { mediaArtifactId } from '../media/service.js';
import { binaryObjectPath } from '../media/binary-files.js';
import { base64Chunks, inspectBase64, normalizeMime, requireMediaSlice, validateMediaBytes, validateRemoteUri } from '../media/validation.js';
import type { BinaryPayloadRef, BinaryPayloadStore, MediaArtifact, MediaArtifactChunk, MediaArtifactPage, MediaArtifactQuery, MediaPublishInput, PreparedBinaryPayload } from '../media/types.js';
import type { SqlDatabase } from './internal.js';
import type { ObjectFiles } from './objects.js';
import type { MediaCommand, MediaQuery, MediaResult } from './media-port.js';

export function insertBinaryObject(database: SqlDatabase, reference: BinaryPayloadRef): void {
    if (reference.path !== binaryObjectPath(reference.sha256) || !Number.isSafeInteger(reference.byteLength)
        || reference.byteLength < 0 || reference.byteLength > 32 * 1024 * 1024) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体字节引用路径或大小无效');
    normalizeMime(reference.mime);
    const current = database.prepare('SELECT raw_bytes,stored_bytes,stored_hash,codec,path,state FROM objects WHERE hash = ?').get(reference.sha256);
    if (current) {
        if (current.state !== 'ready') throw new AgentFault('STORAGE_BUSY', '媒体对象正在清理，须恢复原清理任务后重试',
            { hash: reference.sha256, state: current.state }, false, true);
        if (Number(current.raw_bytes) !== reference.byteLength || Number(current.stored_bytes) !== reference.byteLength
            || current.stored_hash !== reference.sha256 || current.codec !== 'identity' || current.path !== reference.path || current.state !== 'ready') {
            throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体内容寻址对象与已有索引冲突');
        }
        return;
    }
    database.prepare('INSERT INTO objects (hash,kind,mime,raw_bytes,stored_bytes,codec,stored_hash,path,state,generation) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(reference.sha256, 'media_payload', reference.mime, reference.byteLength, reference.byteLength,
            'identity', reference.sha256, reference.path, 'ready', 1);
}

export function attachBinaryPayloadReferences(database: SqlDatabase, owner: {
    conversationId: string; ownerKind: string; ownerId: string; slot: string;
}, references: readonly BinaryPayloadRef[]): void {
    if (references.length > 256) throw new AgentFault('MEDIA_CODEC_LIMIT', '单个对象的媒体引用数量超过上限');
    const statement = database.prepare('INSERT OR IGNORE INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id) VALUES (?,?,?,?,?,?)');
    for (const reference of references) {
        insertBinaryObject(database, reference);
        statement.run(owner.conversationId, owner.ownerKind, owner.ownerId, `${owner.slot}:media:${reference.sha256}`, 'object', reference.sha256);
    }
}

function samePublication(left: MediaArtifact, right: MediaArtifact): boolean {
    const stable = (artifact: MediaArtifact) => {
        const { createdAt: _createdAt, path: _path, absolutePath: _absolutePath, ...value } = artifact;
        return value;
    };
    return canonicalJson(stable(left)) === canonicalJson(stable(right));
}

export class MediaTransactions {
    constructor(private readonly database: SqlDatabase, private readonly files: ObjectFiles, private readonly binary: BinaryPayloadStore) { }

    execute(command: MediaCommand): MediaResult {
        if (command.type !== 'publish') throw new AgentFault('INVALID_PARAMS', '未知媒体事务');
        return { kind: 'artifact', artifact: this.publish(command.input) };
    }

    query(query: MediaQuery): MediaResult {
        if (query.type === 'get') return { kind: 'artifact', artifact: this.get(query.conversationId, query.artifactId) ?? null };
        if (query.type === 'read') return { kind: 'chunk', chunk: this.read(query.query) };
        if (query.type === 'list') return { kind: 'page', page: this.list(query) };
        throw new AgentFault('INVALID_PARAMS', '未知媒体查询');
    }

    publish(input: MediaPublishInput): MediaArtifact {
        const artifact = structuredClone(input.artifact);
        this.validateOwner(artifact);
        artifact.mime = normalizeMime(artifact.mime);
        let payload: PreparedBinaryPayload | undefined;
        let pendingPayload: Omit<BinaryPayloadRef, 'path'> | undefined;
        if (artifact.state === 'ready') {
            if (typeof input.dataBase64 !== 'string') throw new AgentFault('MEDIA_PAYLOAD_MISSING', '媒体发布缺少原件');
            const info = inspectBase64(input.dataBase64, 32 * 1024 * 1024);
            artifact.mimeVerification = validateMediaBytes(artifact.type, artifact.mime, info);
            if (artifact.byteLength !== info.byteLength) throw new AgentFault('MEDIA_LENGTH_MISMATCH', '媒体提交长度不一致');
            if (artifact.sha256 !== info.sha256) throw new AgentFault('MEDIA_HASH_MISMATCH', '媒体提交SHA256不一致');
            pendingPayload = { sha256: info.sha256, byteLength: info.byteLength, mime: artifact.mime };
            const reference = { ...pendingPayload, path: binaryObjectPath(info.sha256) };
            artifact.storage = 'objects';
            artifact.path = reference.path;
            artifact.absolutePath = this.binary.absolutePath?.(reference) ?? null;
        } else if (artifact.state === 'remote_pending') {
            if (input.dataBase64 !== undefined || !artifact.uri || artifact.sha256 !== null || artifact.byteLength !== null) {
                throw new AgentFault('MEDIA_PAYLOAD_MISSING', '远端待取回媒体的描述无效');
            }
            validateRemoteUri(artifact.uri);
            artifact.storage = 'remote';
            artifact.mimeVerification = 'remote_pending';
            artifact.path = null;
            artifact.absolutePath = null;
        } else throw new AgentFault('INVALID_PARAMS', '媒体发布状态无效');
        const previous = this.get(artifact.conversationId, artifact.artifactId);
        if (previous) {
            if (!samePublication(previous, artifact)) throw new AgentFault('MEDIA_PUBLICATION_CONFLICT', '同一媒体位置已有不同原件');
            return previous;
        }
        if (Buffer.byteLength(canonicalJson(artifact)) > 16 * 1024) throw new AgentFault('MEDIA_CONTENT_LIMIT', '媒体原件元数据超过上限');
        if (pendingPayload) payload = this.binary.prepare(base64Chunks(input.dataBase64!), pendingPayload);
        const metadata = this.files.prepare(artifact, 'media_artifact');
        this.database.exec('BEGIN IMMEDIATE');
        try {
            this.validateOwner(artifact);
            const existing = this.get(artifact.conversationId, artifact.artifactId);
            if (existing) {
                if (!samePublication(existing, artifact)) throw new AgentFault('MEDIA_PUBLICATION_CONFLICT', '同一媒体位置已有不同原件');
                this.database.exec('COMMIT');
                return existing;
            }
            if (payload) insertBinaryObject(this.database, payload);
            this.files.insert(this.database, metadata);
            this.database.prepare('INSERT INTO content_items (cid,content_id,kind,object_hash) VALUES (?,?,?,?)')
                .run(artifact.conversationId, artifact.artifactId, 'media_artifact', metadata.hash);
            const statement = this.database.prepare('INSERT INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id) VALUES (?,?,?,?,?,?)');
            statement.run(artifact.conversationId, 'media', artifact.artifactId, 'metadata', 'object', metadata.hash);
            if (payload) statement.run(artifact.conversationId, 'media', artifact.artifactId, 'payload', 'object', payload.sha256);
            this.database.exec('COMMIT');
            return artifact;
        } catch (error) {
            this.database.exec('ROLLBACK');
            this.files.discardUncommitted(this.database, [metadata]);
            throw error;
        }
    }

    get(conversationId: string, artifactId: string): MediaArtifact | undefined {
        const row = this.database.prepare('SELECT content_items.object_hash,objects.raw_bytes FROM content_items JOIN objects ON objects.hash = content_items.object_hash WHERE cid = ? AND content_id = ? AND content_items.kind = ?')
            .get(conversationId, artifactId, 'media_artifact');
        if (!row) return undefined;
        if (Number(row.raw_bytes) > 16 * 1024) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体元数据大小异常');
        const artifact = this.files.read(this.database, String(row.object_hash)) as MediaArtifact;
        if (artifact.conversationId !== conversationId || artifact.artifactId !== artifactId || artifact.schemaVersion !== 1) {
            throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体元数据归属校验失败');
        }
        if (artifact.state === 'ready') artifact.absolutePath = this.binary.absolutePath?.(this.reference(artifact)) ?? null;
        return artifact;
    }

    read(query: MediaArtifactQuery): MediaArtifactChunk {
        const { offset, maxBytes } = requireMediaSlice(query.offset, query.maxBytes);
        const artifact = this.get(query.conversationId, query.artifactId);
        if (!artifact) throw new AgentFault('MEDIA_NOT_FOUND', '当前会话没有这份媒体原件');
        if (artifact.state !== 'ready') throw new AgentFault('MEDIA_REMOTE_PENDING', '远端媒体尚未取回原件', { uri: artifact.uri });
        const reference = this.reference(artifact);
        const row = this.database.prepare('SELECT raw_bytes,stored_bytes,codec,stored_hash,path,state FROM objects WHERE hash = ?').get(reference.sha256);
        if (!row || Number(row.raw_bytes) !== reference.byteLength || Number(row.stored_bytes) !== reference.byteLength
            || row.codec !== 'identity' || row.stored_hash !== reference.sha256 || row.path !== reference.path || row.state !== 'ready') {
            throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体对象索引与元数据不一致');
        }
        if (offset > reference.byteLength) throw new AgentFault('INVALID_PARAMS', '媒体偏移超过原件长度');
        const end = Math.min(reference.byteLength, offset + maxBytes);
        const page = Buffer.alloc(end - offset);
        let position = 0;
        for (const chunk of this.binary.chunks(reference)) {
            const start = Math.max(offset, position);
            const stop = Math.min(end, position + chunk.byteLength);
            if (start < stop) page.set(chunk.subarray(start - position, stop - position), start - offset);
            position += chunk.byteLength;
        }
        return { artifactId: artifact.artifactId, mime: artifact.mime, offset, totalBytes: reference.byteLength,
            sha256: reference.sha256, dataBase64: page.toString('base64'), nextOffset: end < reference.byteLength ? end : null,
            complete: end === reference.byteLength };
    }

    list(query: { conversationId: string; cursor?: string; limit?: number; maxBytes?: number }): MediaArtifactPage {
        const limit = query.limit ?? 50;
        const maxBytes = query.maxBytes ?? 256 * 1024;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024) {
            throw new AgentFault('INVALID_PARAMS', '媒体列表分页参数无效');
        }
        const rows = this.database.prepare('SELECT content_id FROM content_items WHERE cid = ? AND kind = ? AND content_id > ? ORDER BY content_id LIMIT ?')
            .all(query.conversationId, 'media_artifact', query.cursor ?? '', limit + 1);
        const items: MediaArtifact[] = [];
        let bytes = 0;
        let hasMore = false;
        for (const row of rows) {
            const artifact = this.get(query.conversationId, String(row.content_id))!;
            const size = Buffer.byteLength(canonicalJson(artifact));
            if (items.length >= limit || bytes + size > maxBytes) { hasMore = true; break; }
            items.push(artifact);
            bytes += size;
        }
        if (hasMore && !items.length) throw new AgentFault('MEDIA_PAGE_LIMIT', '媒体页预算无法容纳一条元数据');
        return { items, nextCursor: hasMore ? items.at(-1)!.artifactId : null, hasMore };
    }

    private reference(artifact: MediaArtifact): BinaryPayloadRef {
        if (artifact.sha256 === null || artifact.byteLength === null || artifact.path === null) {
            throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '已发布媒体缺少原字节引用');
        }
        return { sha256: artifact.sha256, byteLength: artifact.byteLength, mime: artifact.mime, path: artifact.path };
    }

    private validateOwner(artifact: MediaArtifact): void {
        if (artifact.schemaVersion !== 1 || artifact.retention.mode === 'temporary' || artifact.artifactId !== mediaArtifactId(artifact)
            || !Number.isSafeInteger(artifact.runEpoch) || artifact.runEpoch < 1 || !Number.isSafeInteger(artifact.blockIndex)
            || artifact.blockIndex < 0 || !Number.isSafeInteger(artifact.candidateIndex) || artifact.candidateIndex < 0
            || !['image', 'audio', 'video', 'file'].includes(artifact.type)) throw new AgentFault('MEDIA_OWNER_INVALID', '持久媒体归属无效');
        const conversation = this.database.prepare('SELECT mode,state,run_epoch FROM conversations WHERE cid = ?').get(artifact.conversationId);
        const run = this.database.prepare('SELECT cid,run_epoch FROM runs WHERE run_id = ?').get(artifact.runId);
        if (!conversation || conversation.state !== 'open' || conversation.mode !== artifact.retention.mode
            || !run || run.cid !== artifact.conversationId || Number(run.run_epoch) !== artifact.runEpoch
            || Number(conversation.run_epoch) !== artifact.runEpoch) throw new AgentFault('MEDIA_OWNER_STALE', '媒体所属会话或运行版本已变化');
    }
}
