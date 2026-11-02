import { AgentFault } from '../protocol.js';
import type { MediaArtifact } from '../media/types.js';
import type { SqlDatabase, SqlRow } from '../storage/internal.js';
import type { ObjectFiles } from '../storage/objects.js';

export function isLifecycleMediaCanonicalReference(database: SqlDatabase, conversationId: string, reference: SqlRow): boolean {
    if (reference.cid !== conversationId || reference.target_kind !== 'object'
        || !(reference.owner_kind === 'content' && reference.slot === 'value'
            || reference.owner_kind === 'media' && reference.slot === 'metadata')) return false;
    return Boolean(database.prepare("SELECT 1 FROM content_items WHERE cid=? AND content_id=? AND kind='media_artifact'")
        .get(conversationId, reference.owner_id));
}

function readMetadataObject(database: SqlDatabase, files: ObjectFiles, conversationId: string, artifactId: string, objectHash: string): Partial<MediaArtifact> {
    const object = database.prepare('SELECT raw_bytes,state FROM objects WHERE hash=?').get(objectHash);
    if (!object || object.state !== 'ready' || !Number.isSafeInteger(Number(object.raw_bytes))
        || Number(object.raw_bytes) < 0 || Number(object.raw_bytes) > 16 * 1024) {
        throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体原件元数据对象尚未完整恢复', { conversationId, artifactId, objectHash });
    }
    const artifact = files.read(database, objectHash) as Partial<MediaArtifact> | null;
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact) || artifact.schemaVersion !== 1
        || typeof artifact.conversationId !== 'string' || typeof artifact.artifactId !== 'string') {
        throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体原件元数据格式校验失败', { conversationId, artifactId, objectHash });
    }
    return artifact;
}

function validateMetadata(database: SqlDatabase, files: ObjectFiles, conversationId: string, artifactId: string, objectHash: string): void {
    const artifact = readMetadataObject(database, files, conversationId, artifactId, objectHash);
    if (artifact.conversationId !== conversationId || artifact.artifactId !== artifactId) {
        throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体规范引用的元数据归属校验失败', { conversationId, artifactId, objectHash });
    }
}

function preservePreviousMetadata(database: SqlDatabase, files: ObjectFiles, conversationId: string, artifactId: string, objectHash: string): void {
    let previousHash: string | undefined;
    for (;;) {
        const previous = database.prepare(`SELECT DISTINCT refs.target_id FROM refs JOIN objects ON objects.hash=refs.target_id
            WHERE refs.cid=? AND refs.owner_id=? AND refs.target_kind='object' AND refs.target_id<>?
            AND ((refs.owner_kind='content' AND refs.slot='value') OR (refs.owner_kind='media' AND refs.slot='metadata'))
            ${previousHash === undefined ? '' : 'AND refs.target_id>?'} ORDER BY refs.target_id LIMIT 1`)
            .get(conversationId, artifactId, objectHash, ...(previousHash === undefined ? [] : [previousHash]));
        if (!previous) return;
        previousHash = String(previous.target_id);
        readMetadataObject(database, files, conversationId, artifactId, previousHash);
        const contentId = `lifecycle:object:${previousHash}`;
        const alias = database.prepare('SELECT object_hash FROM content_items WHERE cid=? AND content_id=?').get(conversationId, contentId);
        if (alias && alias.object_hash !== previousHash) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体原版本别名与原对象不同', { conversationId, contentId });
        if (!alias) database.prepare('INSERT INTO content_items (cid,content_id,kind,object_hash) VALUES (?,?,?,?)')
            .run(conversationId, contentId, 'lifecycle_original', previousHash);
        database.prepare('INSERT OR IGNORE INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id) VALUES (?,?,?,?,?,?)')
            .run(conversationId, 'content', contentId, 'value', 'object', previousHash);
    }
}

export function recoverLifecycleMediaReferences(database: SqlDatabase, files: ObjectFiles, conversationId: string): void {
    let afterContentId: string | undefined;
    for (;;) {
        const content = database.prepare(`SELECT content_id,object_hash FROM content_items WHERE cid=? AND kind='media_artifact'
            ${afterContentId === undefined ? '' : 'AND content_id>?'} ORDER BY content_id LIMIT 1`)
            .get(conversationId, ...(afterContentId === undefined ? [] : [afterContentId]));
        if (!content) return;
        const artifactId = String(content.content_id), objectHash = String(content.object_hash);
        validateMetadata(database, files, conversationId, artifactId, objectHash);
        preservePreviousMetadata(database, files, conversationId, artifactId, objectHash);
        database.prepare(`DELETE FROM refs WHERE cid=? AND owner_id=? AND target_kind='object' AND target_id<>?
            AND ((owner_kind='content' AND slot='value') OR (owner_kind='media' AND slot='metadata'))`)
            .run(conversationId, artifactId, objectHash);
        for (const [ownerKind, slot] of [['content', 'value'], ['media', 'metadata']]) {
            database.prepare('INSERT OR IGNORE INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id) VALUES (?,?,?,?,?,?)')
                .run(conversationId, ownerKind, artifactId, slot, 'object', objectHash);
        }
        afterContentId = artifactId;
    }
}
