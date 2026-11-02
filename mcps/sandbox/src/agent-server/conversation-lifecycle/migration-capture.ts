import { readFileSync } from 'node:fs';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { AgentEvent, JsonValue } from '../protocol.js';
import type { ConversationData } from '../runtime.js';
import type { SqlDatabase, SqlRow } from '../storage/internal.js';
import type { HistoryItem, StoreRecord, StoredReceipt } from '../storage/port.js';
import { storeKey } from '../storage/port.js';
import { ObjectFiles, sha256, storagePath } from '../storage/objects.js';
import { readHistory } from '../storage/history.js';
import { BinaryObjectFiles } from '../media/binary-files.js';
import { MediaTransactions } from '../storage/media-transactions.js';
import { WorkspaceTransactions } from '../storage/workspace-transactions.js';
import type { PersistedProviderAttempt } from '../storage/provider-journal.js';
import type { MediaArtifact } from '../media/types.js';
import type { PendingToolRecord } from '../tools/pending-types.js';
import { summarizePending } from '../tools/pending-types.js';
import { lifecycleReceiptOwner, lifecycleSnapshotHash } from './migration-snapshots.js';
import type { LifecycleContentSnapshot, LifecycleConversationSnapshot } from './migration-snapshots.js';
import type { LifecycleFinancialFacts } from './migration-contracts.js';

export const LIFECYCLE_FACTS_ID = 'lifecycle:durable-facts';
export const LIFECYCLE_PROJECTION_TABLES = ['manifests', 'candidates', 'attempts', 'resources', 'provider_budget_bindings', 'workspace_changes', 'restore_plans'] as const;
export interface LifecycleSqlFacts {
    schemaVersion: 1;
    conversationId: string;
    projections: Partial<Record<typeof LIFECYCLE_PROJECTION_TABLES[number], SqlRow[]>>;
    journals: SqlRow[];
    toolIntents: SqlRow[];
    toolBatches: SqlRow[];
    refs: SqlRow[];
    serverState?: SqlRow[];
}

export function captureLifecycleFinancialFacts(database: SqlDatabase, conversationIds: string[]): LifecycleFinancialFacts {
    const unknown = new Set<string>();
    const facts = [...new Set(conversationIds)].sort().map(conversationId => {
        const temporary = database.prepare('SELECT * FROM temporary_provider_attempts WHERE cid=? ORDER BY attempt_id').all(conversationId);
        const attempts = database.prepare('SELECT * FROM attempts WHERE cid=? ORDER BY attempt_id').all(conversationId);
        const journals = database.prepare('SELECT journal.* FROM provider_attempt_journal journal JOIN attempts USING(attempt_id) WHERE cid=? ORDER BY attempt_id').all(conversationId);
        for (const row of [...temporary, ...journals]) if (row.state === 'unknown' || row.state === 'dispatching') unknown.add(String(row.attempt_id));
        const roots = [...new Set([...temporary.map(row => String(row.root_budget_id)),
            ...database.prepare('SELECT root_budget_id FROM provider_budget_bindings WHERE cid=? UNION SELECT root_run_id FROM runs WHERE cid=?').all(conversationId, conversationId).map(row => String(row.root_budget_id))])].sort();
        const budgets = roots.map(root => ({ budget: database.prepare('SELECT * FROM budgets WHERE root_budget_id=?').get(root) ?? null,
            reservations: database.prepare('SELECT * FROM reservations WHERE root_budget_id=? ORDER BY attempt_id').all(root),
            charges: database.prepare('SELECT * FROM charges WHERE root_budget_id=? ORDER BY quota_scope_id,execution_key,component').all(root) }));
        return { conversationId, temporary, attempts, journals, budgets };
    });
    return { financialHash: lifecycleSnapshotHash(facts), unknownAttemptIds: [...unknown].sort() };
}

export function captureDurableLifecycle(database: SqlDatabase, files: ObjectFiles, dataDir: string, conversationId: string): LifecycleConversationSnapshot {
    const sourceRow = database.prepare('SELECT value_json FROM store_records WHERE record_key=?').get(storeKey({ conversationId, kind: 'conversation', id: conversationId }));
    if (!sourceRow) throw new AgentFault('NOT_FOUND', '完整快照的源会话不存在');
    const source = JSON.parse(String(sourceRow.value_json)) as ConversationData;
    const records = database.prepare('SELECT * FROM store_records WHERE cid=? ORDER BY record_key').all(conversationId).map(row => ({
        key: { conversationId, kind: String(row.kind), id: String(row.record_id) }, revision: Number(row.revision), value: JSON.parse(String(row.value_json)) })) as StoreRecord[];
    const contents: LifecycleContentSnapshot[] = [];
    const contentIds = new Set<string>(), represented = new Set<string>();
    const addContent = (contentId: string, kind: string, value: JsonValue, expectedHash?: string, expectedBytes?: number) => {
        if (contentIds.has(contentId)) return;
        const rawBytes = Buffer.byteLength(canonicalJson(value)), checksum = lifecycleSnapshotHash(value);
        if (expectedHash && checksum !== expectedHash || expectedBytes !== undefined && rawBytes !== expectedBytes) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '迁移快照与原对象SHA或字节数不同');
        contentIds.add(contentId); represented.add(checksum); contents.push({ contentId, kind, value, sha256: checksum, rawBytes });
    };
    for (const row of database.prepare('SELECT content_items.*,objects.raw_bytes FROM content_items JOIN objects ON hash=object_hash WHERE cid=? ORDER BY content_id').all(conversationId)) {
        addContent(String(row.content_id), String(row.kind), files.read(database, String(row.object_hash)) as JsonValue, String(row.object_hash), Number(row.raw_bytes));
    }
    const history: HistoryItem[] = [];
    let cursor: string | undefined;
    do {
        const page = readHistory(database, files, dataDir, { conversationId, cursor, limit: 50, maxBytes: 262144, view: 'all', effectiveOnly: false });
        for (const { value: _value, ...item } of page.items) history.push(item);
        cursor = page.hasMore ? page.nextCursor! : undefined;
    } while (cursor);
    const receipts = database.prepare('SELECT result_hash FROM receipts WHERE cid=? ORDER BY principal_id,client_id,command_id').all(conversationId)
        .map(row => files.read(database, String(row.result_hash)) as StoredReceipt);
    for (const row of database.prepare("SELECT result_json FROM server_receipts WHERE json_extract(result_json,'$.result.data.conversationId')=? ORDER BY principal_id,client_id,command_id").all(conversationId)) {
        const receipt = JSON.parse(String(row.result_json)) as StoredReceipt;
        if (lifecycleReceiptOwner(receipt) === conversationId) receipts.push(receipt);
    }
    const events = database.prepare('SELECT payload_hash FROM events WHERE cid=? ORDER BY event_seq').all(conversationId).map(row => files.read(database, String(row.payload_hash)) as AgentEvent);
    const projections: LifecycleSqlFacts['projections'] = {};
    for (const table of LIFECYCLE_PROJECTION_TABLES) projections[table] = database.prepare(`SELECT * FROM ${table} WHERE cid=? ORDER BY rowid`).all(conversationId);
    const journals = database.prepare('SELECT journal.* FROM provider_attempt_journal journal JOIN attempts USING(attempt_id) WHERE cid=? ORDER BY attempt_id').all(conversationId);
    const toolIntents = database.prepare('SELECT tools.* FROM provider_tool_intents tools JOIN attempts USING(attempt_id) WHERE cid=? ORDER BY attempt_id,tool_index').all(conversationId);
    const toolBatches = database.prepare('SELECT tools.* FROM provider_tool_batches tools JOIN attempts USING(attempt_id) WHERE cid=? ORDER BY attempt_id').all(conversationId);
    const durableAttempts: PersistedProviderAttempt[] = journals.map(row => ({ state: String(row.state) as PersistedProviderAttempt['state'],
        attempt: files.read(database, String(row.attempt_object_hash)) as PersistedProviderAttempt['attempt'], upperBound: JSON.parse(String(row.upper_bound_json)),
        ...(row.response_object_hash ? { response: files.read(database, String(row.response_object_hash)) as PersistedProviderAttempt['response'] } : {}),
        ...(row.failure_object_hash ? { failure: files.read(database, String(row.failure_object_hash)) as PersistedProviderAttempt['failure'] } : {}),
        toolsAuthorized: row.tools_authorized === 1, lateResponse: row.late_response === 1 }));
    const workspace = new WorkspaceTransactions(database, files);
    const pendingToolIds: string[] = [];
    for (const row of database.prepare("SELECT id FROM server_state WHERE kind='workspacePendingTool' AND json_extract(value_json,'$.conversationId')=? ORDER BY id").all(conversationId)) {
        const result = workspace.read({ type: 'pending.get', pendingToolId: String(row.id) });
        if (result.kind !== 'pending' || !result.record) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '迁移缺少原待办正文');
        const record = result.record as PendingToolRecord, contentId = `pending-tool:${record.pendingToolId}`;
        addContent(contentId, 'pending_tool', record as unknown as JsonValue);
        const key = { conversationId, kind: 'control' as const, id: contentId };
        if (!records.some(entry => storeKey(entry.key) === storeKey(key))) records.push({ key, revision: record.revision,
            value: { type: 'temporary_pending_tool', summary: summarizePending(record), contentId } });
        pendingToolIds.push(record.pendingToolId);
    }
    const tickets = database.prepare("SELECT value_json FROM server_state WHERE kind='workspaceApprovalTicket' AND json_extract(value_json,'$.conversationId')=? ORDER BY id").all(conversationId).map(row => JSON.parse(String(row.value_json)));
    const approvalIds = new Set(tickets.map(ticket => String(ticket.approvalId)));
    const approvalReceipts = database.prepare("SELECT value_json FROM server_state WHERE kind='workspaceApprovalReceipt' ORDER BY id").all()
        .map(row => JSON.parse(String(row.value_json))).filter(receipt => {
            try { const key = JSON.parse(receipt.key); return key[0] === 'request' ? key[2] === conversationId
                : key[0] === 'respond' ? key[3] === conversationId : key[0] === 'consume' && approvalIds.has(String(key[1])); } catch { return false; }
        });
    const changes = database.prepare('SELECT content_hash FROM workspace_changes WHERE cid=? ORDER BY rowid').all(conversationId).map(row => files.read(database, String(row.content_hash)));
    const plans = database.prepare('SELECT content_hash FROM restore_plans WHERE cid=? ORDER BY restore_plan_id').all(conversationId).map(row => files.read(database, String(row.content_hash)));
    const mediaTransactions = new MediaTransactions(database, files, new BinaryObjectFiles(dataDir, 32 * 1024 * 1024));
    const artifacts = contents.filter(content => content.kind === 'media_artifact').map(content => content.value as unknown as MediaArtifact);
    const payloads: LifecycleConversationSnapshot['media']['payloads'] = [];
    for (const artifact of artifacts) {
        if (artifact.state !== 'ready' || payloads.some(payload => payload.sha256 === artifact.sha256)) continue;
        const chunks: Buffer[] = []; let offset = 0;
        do { const chunk = mediaTransactions.read({ conversationId, artifactId: artifact.artifactId, offset, maxBytes: 262144 });
            chunks.push(Buffer.from(chunk.dataBase64, 'base64')); if (chunk.nextOffset === null) break; offset = chunk.nextOffset;
        } while (true);
        const bytes = Buffer.concat(chunks);
        if (sha256(bytes) !== artifact.sha256 || bytes.length !== artifact.byteLength) throw new AgentFault('MEDIA_HASH_MISMATCH', '迁移的媒体原件与原索引不同');
        payloads.push({ sha256: artifact.sha256!, byteLength: bytes.length, dataBase64: bytes.toString('base64') });
    }
    const refs = database.prepare('SELECT * FROM refs WHERE cid=? ORDER BY owner_kind,owner_id,slot,target_id').all(conversationId)
        .filter(row => !(row.owner_kind === 'content' && row.owner_id === LIFECYCLE_FACTS_ID && row.slot === 'value'));
    const hashes = new Set(refs.filter(row => row.target_kind === 'object').map(row => String(row.target_id)));
    for (const rows of [...Object.values(projections), journals, toolIntents, toolBatches]) for (const row of rows ?? []) for (const [key, value] of Object.entries(row)) {
        if ((key.endsWith('_hash') || key.endsWith('_object_hash')) && typeof value === 'string' && database.prepare('SELECT 1 FROM objects WHERE hash=?').get(value)) hashes.add(value);
    }
    for (const objectHash of hashes) {
        if (represented.has(objectHash)) continue;
        const row = database.prepare('SELECT * FROM objects WHERE hash=? AND state=?').get(objectHash, 'ready');
        if (!row) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '完整迁移清单的原件不在ready状态');
        if (row.kind === 'media_payload') {
            const bytes = readFileSync(storagePath(dataDir, String(row.path)));
            if (sha256(bytes) !== objectHash || bytes.length !== Number(row.raw_bytes)) throw new AgentFault('MEDIA_HASH_MISMATCH', '原二进制对象与SHA不同');
            addContent(`lifecycle:binary:${objectHash}`, 'lifecycle_binary_payload', { sha256: objectHash, mime: String(row.mime), byteLength: bytes.length, dataBase64: bytes.toString('base64') });
        } else addContent(`lifecycle:object:${objectHash}`, 'lifecycle_original', files.read(database, objectHash) as JsonValue, objectHash, Number(row.raw_bytes));
    }
    const serverState = database.prepare("SELECT * FROM server_state WHERE kind IN ('workspaceApprovalTicket','workspacePendingTool') AND json_extract(value_json,'$.conversationId')=? ORDER BY kind,id").all(conversationId);
    for (const receipt of approvalReceipts) {
        const row = database.prepare("SELECT * FROM server_state WHERE kind='workspaceApprovalReceipt' AND json_extract(value_json,'$.key')=?").get(String(receipt.key));
        if (row) serverState.push(row);
    }
    const facts: LifecycleSqlFacts = { schemaVersion: 1, conversationId, projections, journals, toolIntents, toolBatches, refs, serverState };
    const previousFacts = contents.findIndex(content => content.contentId === LIFECYCLE_FACTS_ID);
    if (previousFacts >= 0) { contents.splice(previousFacts, 1); contentIds.delete(LIFECYCLE_FACTS_ID); }
    addContent(LIFECYCLE_FACTS_ID, 'lifecycle_sql_facts', facts as unknown as JsonValue);
    return { schemaVersion: 1, conversationId, core: { schemaVersion: 1, conversationId, records, contents, receipts, events, history },
        provider: { schemaVersion: 1, conversationId, temporaryAttempts: [], durableAttempts, fences: [], closed: source.state !== 'open' },
        workspace: { schemaVersion: 1, conversationId, journalRevision: source.workspaceRevision, actions: changes as LifecycleConversationSnapshot['workspace']['actions'],
            tickets, approvalReceipts, restorePlans: plans as LifecycleConversationSnapshot['workspace']['restorePlans'] },
        media: { schemaVersion: 1, conversationId, artifacts, payloads }, pending: { schemaVersion: 1, conversationId, pendingToolIds: pendingToolIds.sort() } };
}
