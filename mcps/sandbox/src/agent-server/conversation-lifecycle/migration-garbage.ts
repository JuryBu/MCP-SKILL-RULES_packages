import { unlinkSync } from 'node:fs';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { SqlDatabase } from '../storage/internal.js';
import { storagePath } from '../storage/objects.js';

const unreferencedObject = `NOT EXISTS (SELECT 1 FROM refs WHERE target_kind='object' AND target_id=objects.hash)
    AND NOT EXISTS (SELECT 1 FROM server_refs WHERE target_id=objects.hash)
    AND NOT EXISTS (SELECT 1 FROM object_dependencies WHERE payload_hash=objects.hash)
    AND NOT EXISTS (SELECT 1 FROM content_items WHERE object_hash=objects.hash)
    AND NOT EXISTS (SELECT 1 FROM items WHERE object_hash=objects.hash)
    AND NOT EXISTS (SELECT 1 FROM manifests WHERE object_hash=objects.hash)
    AND NOT EXISTS (SELECT 1 FROM receipts WHERE result_hash=objects.hash)
    AND NOT EXISTS (SELECT 1 FROM events WHERE payload_hash=objects.hash)
    AND NOT EXISTS (SELECT 1 FROM workspace_changes WHERE content_hash=objects.hash)
    AND NOT EXISTS (SELECT 1 FROM restore_plans WHERE content_hash=objects.hash)
    AND NOT EXISTS (SELECT 1 FROM provider_attempt_journal WHERE objects.hash IN (attempt_object_hash,snapshot_object_hash,response_object_hash,raw_object_hash,failure_object_hash))
    AND NOT EXISTS (SELECT 1 FROM provider_tool_intents WHERE object_hash=objects.hash)
    AND NOT EXISTS (SELECT 1 FROM provider_tool_batches WHERE object_hash=objects.hash)`;

interface MigrationGarbage { operationId: string; conversationId: string; kind: 'object' | 'segment'; targetId: string; path: string; lastError?: string }

export function queueLifecycleMigrationGarbage(database: SqlDatabase, conversationId: string, operationId: string): void {
    const hashes = new Set(database.prepare("SELECT target_id FROM refs WHERE cid=? AND target_kind='object' UNION SELECT object_hash FROM content_items WHERE cid=? UNION SELECT content_hash FROM workspace_changes WHERE cid=? UNION SELECT content_hash FROM restore_plans WHERE cid=?")
        .all(conversationId, conversationId, conversationId, conversationId).map(row => String(row.target_id)));
    for (const row of database.prepare("SELECT value_json FROM server_state WHERE kind='workspacePendingTool' AND json_extract(value_json,'$.conversationId')=?").all(conversationId)) {
        const value = JSON.parse(String(row.value_json));
        if (typeof value.stateHash === 'string') hashes.add(value.stateHash);
        if (typeof value.frozenHash === 'string') hashes.add(value.frozenHash);
    }
    for (const hash of hashes) for (const row of database.prepare('SELECT payload_hash FROM object_dependencies WHERE source_hash=?').all(hash)) hashes.add(String(row.payload_hash));
    const write = (value: MigrationGarbage) => database.prepare("INSERT OR IGNORE INTO server_state (kind,id,revision,value_json) VALUES ('policyTransitionGc',?,1,?)")
        .run(`${operationId}:${value.kind}:${value.targetId}`, canonicalJson(value));
    for (const hash of hashes) {
        const row = database.prepare('SELECT path FROM objects WHERE hash=?').get(hash);
        if (row) write({ operationId, conversationId, kind: 'object', targetId: hash, path: String(row.path) });
    }
    for (const row of database.prepare('SELECT segment_id,path FROM segments WHERE cid=?').all(conversationId)) write({ operationId, conversationId, kind: 'segment', targetId: String(row.segment_id), path: String(row.path) });
}

export function collectLifecycleMigrationGarbage(database: SqlDatabase, dataDir: string, operationId: string): {
    removed: number; bytesRemoved: number; retained: number; failures: { targetId: string; code: string }[];
} {
    const result = { removed: 0, bytesRemoved: 0, retained: 0, failures: [] as { targetId: string; code: string }[] };
    const failed = new Set<string>();
    for (;;) {
        let progress = false;
        const rows = database.prepare("SELECT id,value_json FROM server_state WHERE kind='policyTransitionGc' AND json_extract(value_json,'$.operationId')=? ORDER BY id").all(operationId);
        for (const entry of rows) {
            const id = String(entry.id), value = JSON.parse(String(entry.value_json)) as MigrationGarbage;
            if (failed.has(id)) continue;
            const object = value.kind === 'object';
            const row = object ? database.prepare(`SELECT path,stored_bytes FROM objects WHERE hash=? AND ${unreferencedObject}`).get(value.targetId)
                : database.prepare("SELECT path,stored_bytes FROM segments WHERE segment_id=? AND NOT EXISTS (SELECT 1 FROM items WHERE items.segment_id=segments.segment_id) AND NOT EXISTS (SELECT 1 FROM refs WHERE target_kind='segment' AND target_id=segments.segment_id)").get(value.targetId);
            if (!row) {
                const exists = object ? database.prepare('SELECT 1 FROM objects WHERE hash=?').get(value.targetId) : database.prepare('SELECT 1 FROM segments WHERE segment_id=?').get(value.targetId);
                if (!exists) { database.prepare("DELETE FROM server_state WHERE kind='policyTransitionGc' AND id=?").run(id); progress = true; }
                continue;
            }
            try {
                const path = String(row.path).replaceAll('\\', '/');
                const valid = object ? /^objects\/[a-f0-9]{2}\/[a-f0-9]{64}(?:\.media-json)?$/.test(path) : /^segments\/[a-f0-9]{64}\/[a-f0-9-]+\.sah$/.test(path);
                if (!valid || String(row.path) !== value.path) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '迁移清理位置与原托管对象不同');
                try { unlinkSync(storagePath(dataDir, String(row.path))); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
                database.exec('BEGIN IMMEDIATE');
                try {
                    if (object) database.prepare('DELETE FROM objects WHERE hash=?').run(value.targetId); else database.prepare('DELETE FROM segments WHERE segment_id=?').run(value.targetId);
                    database.prepare("DELETE FROM server_state WHERE kind='policyTransitionGc' AND id=?").run(id); database.exec('COMMIT');
                } catch (error) { database.exec('ROLLBACK'); throw error; }
                result.removed++; result.bytesRemoved += Number(row.stored_bytes); progress = true;
            } catch (error) {
                const code = error instanceof AgentFault ? error.code : (error as NodeJS.ErrnoException).code ?? 'STORAGE_DURABILITY_FAILED';
                failed.add(id); result.failures.push({ targetId: value.targetId, code });
                database.prepare("UPDATE server_state SET revision=revision+1,value_json=? WHERE kind='policyTransitionGc' AND id=?")
                    .run(canonicalJson({ ...value, lastError: code, failedAt: new Date().toISOString() }), id);
            }
        }
        if (!progress) break;
    }
    const remaining = database.prepare("SELECT id FROM server_state WHERE kind='policyTransitionGc' AND json_extract(value_json,'$.operationId')=?").all(operationId);
    if (!result.failures.length) {
        result.retained = remaining.length;
        database.prepare("DELETE FROM server_state WHERE kind='policyTransitionGc' AND json_extract(value_json,'$.operationId')=?").run(operationId);
    }
    return result;
}
