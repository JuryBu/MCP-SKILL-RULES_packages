import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonValue } from '../protocol.js';
import type { ConversationData } from '../runtime.js';
import type { SqlDatabase, SqlRow, SqlValue } from '../storage/internal.js';
import type { ContentWrite, StoreCommitResult, StoreKey, StorePort, StoreRecord, StoredReceipt, TransitionExpected } from '../storage/port.js';
import { receiptKey, storeKey } from '../storage/port.js';
import { controlKey, requireControl } from '../controller.js';
import type { ControlLease } from '../controller.js';
import { ObjectFiles } from '../storage/objects.js';
import type { PreparedObject } from '../storage/objects.js';
import { commitSegments, prepareSegments, rollbackSegments } from '../storage/segments.js';
import type { PreparedSegment } from '../storage/segments.js';
import { convertedConversation, lifecycleBusinessValue, lifecycleFence, plainRetention, sameLifecycleFence } from './policy.js';
import type { BranchHistoryItem, ConversationLifecycleStoragePort, LifecycleCommit, LifecycleFence, LifecycleInventory } from './contracts.js';

export function createPersistentConversationLifecycleStorage(store: Pick<StorePort, 'getRecord'>,
    persistent: ConversationLifecycleStoragePort): ConversationLifecycleStoragePort {
    const route = async (conversationId: string, targetMode?: string) => {
        const source = await store.getRecord<ConversationData>(sourceKey(conversationId));
        if (source?.value.retention.mode === 'temporary' || targetMode === 'temporary') {
            throw new AgentFault('RETENTION_TRANSITION_BUSY', '临时保存的完整媒体、Provider、工作区工厂迁移仍在准备，原模式保持', {
                transitionState: 'pending', requiredRoute: source?.value.retention.mode === 'temporary' ? 'temporary_to_durable' : 'durable_to_temporary' });
        }
    };
    return {
        inspectConversationLifecycle: async input => { await route(input.source.conversationId, input.targetRetention?.mode); return persistent.inspectConversationLifecycle(input); },
        commitConversationLifecycle: async input => { await route(input.source.conversationId, input.target.value.retention.mode); return persistent.commitConversationLifecycle(input); },
    };
}

export interface LifecycleWorkerOptions {
    database: SqlDatabase;
    files: ObjectFiles;
    dataDir: string;
}

export type LifecycleWorkerCommand = { type: 'inspect'; input: { source: LifecycleFence; throughSeq?: number } }
    | { type: 'commit'; input: LifecycleCommit };

const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
const sourceKey = (conversationId: string): StoreKey => ({ conversationId, kind: 'conversation', id: conversationId });
const ownedManifestKinds = new Set(['media_artifact', 'input_attachment', 'input_conversation',
    'input_attachment_manifest', 'input_conversation_manifest']);

export const LIFECYCLE_CONVERSATION_TABLES = ['conversations', 'store_records', 'runs', 'content_items', 'items', 'segments', 'history_rounds',
    'manifests', 'candidates', 'attempts', 'state_items', 'receipts', 'events', 'resources', 'workspace_changes',
    'restore_plans', 'provider_budget_bindings', 'temporary_provider_fences', 'temporary_provider_attempts'] as const;

export const LIFECYCLE_FINANCIAL_QUERIES: Readonly<Record<string, string>> = Object.freeze({
    provider_attempt_journal: 'SELECT journal.* FROM provider_attempt_journal journal JOIN attempts USING(attempt_id) WHERE attempts.cid = ? ORDER BY journal.attempt_id',
    provider_tool_intents: 'SELECT intents.* FROM provider_tool_intents intents JOIN attempts USING(attempt_id) WHERE attempts.cid = ? ORDER BY intents.attempt_id,intents.tool_index',
    provider_tool_batches: 'SELECT batches.* FROM provider_tool_batches batches JOIN attempts USING(attempt_id) WHERE attempts.cid = ? ORDER BY batches.attempt_id',
    budgets: 'SELECT budgets.* FROM budgets WHERE root_budget_id IN (SELECT root_budget_id FROM provider_budget_bindings WHERE cid = ? UNION SELECT root_run_id FROM runs WHERE cid = ?) ORDER BY root_budget_id',
    reservations: 'SELECT reservations.* FROM reservations WHERE root_budget_id IN (SELECT root_budget_id FROM provider_budget_bindings WHERE cid = ? UNION SELECT root_run_id FROM runs WHERE cid = ?) ORDER BY attempt_id',
    charges: 'SELECT charges.* FROM charges WHERE root_budget_id IN (SELECT root_budget_id FROM provider_budget_bindings WHERE cid = ? UNION SELECT root_run_id FROM runs WHERE cid = ?) OR attempt_id IN (SELECT attempt_id FROM attempts WHERE cid = ?) ORDER BY quota_scope_id,execution_key,component',
});

export class DurableConversationLifecycleAdapter {
    private readonly database: SqlDatabase;
    private readonly files: ObjectFiles;
    private readonly dataDir: string;

    constructor(options: LifecycleWorkerOptions) {
        this.database = options.database;
        this.files = options.files;
        this.dataDir = options.dataDir;
    }

    execute(command: LifecycleWorkerCommand): LifecycleInventory | StoreCommitResult {
        return command.type === 'inspect' ? this.inspect(command.input) : this.commit(command.input);
    }

    private record(conversationId: string): StoreRecord<ConversationData> {
        const key = sourceKey(conversationId);
        const row = this.database.prepare('SELECT revision,value_json FROM store_records WHERE record_key = ?').get(storeKey(key));
        if (!row) throw new AgentFault('NOT_FOUND', '找不到生命周期操作所属会话');
        return { key, revision: Number(row.revision), value: JSON.parse(String(row.value_json)) as ConversationData };
    }

    private family(conversationId: string): { root: string; members: string[] } {
        const seen = new Set<string>();
        let root = conversationId;
        while (true) {
            if (seen.has(root)) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '保存归属链存在重复来源');
            seen.add(root);
            const owner = this.database.prepare("SELECT value_json FROM server_state WHERE kind = 'retentionOwner' AND id = ?").get(root);
            const parent = owner ? JSON.parse(String(owner.value_json)).parentConversationId : this.record(root).value.options.parentConversationId;
            if (parent === undefined) break;
            if (typeof parent !== 'string' || !parent) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '保存归属缺少有效父会话');
            root = parent;
        }
        const members: string[] = [];
        const pending = [root];
        while (pending.length) {
            const current = pending.shift()!;
            if (members.includes(current)) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '保存家族出现重复成员');
            members.push(current);
            let after = '';
            while (true) {
                const rows = this.database.prepare("SELECT id FROM server_state WHERE kind = 'retentionOwner' AND json_extract(value_json,'$.parentConversationId') = ? AND id > ? ORDER BY id LIMIT 50").all(current, after);
                for (const row of rows) pending.push(String(row.id));
                if (rows.length < 50) break;
                after = String(rows.at(-1)!.id);
            }
        }
        return { root, members };
    }

    private *rows(table: typeof LIFECYCLE_CONVERSATION_TABLES[number], conversationId: string): Iterable<SqlRow> {
        let after = 0;
        while (true) {
            const rows = this.database.prepare(`SELECT rowid AS lifecycle_rowid,* FROM ${table} WHERE cid = ? AND rowid > ? ORDER BY rowid LIMIT 50`).all(conversationId, after);
            for (const row of rows) {
                after = Number(row.lifecycle_rowid);
                const { lifecycle_rowid: _rowid, ...value } = row;
                yield value;
            }
            if (rows.length < 50) break;
        }
    }

    private *financialRows(table: string, conversationId: string): Iterable<SqlRow> {
        const query = LIFECYCLE_FINANCIAL_QUERIES[table];
        if (!query) throw new AgentFault('INVALID_PARAMS', '未知生命周期费用清单');
        const count = (query.match(/\?/g) ?? []).length;
        let offset = 0;
        while (true) {
            const page = this.database.prepare(`${query} LIMIT 50 OFFSET ?`).all(...Array<SqlValue>(count).fill(conversationId), offset);
            yield* page;
            if (page.length < 50) return;
            offset += page.length;
        }
    }

    private isControlReceipt(row: SqlRow): boolean {
        const receipt = this.files.read(this.database, String(row.result_hash)) as StoredReceipt;
        const data = receipt.result.data as Record<string, unknown> | undefined;
        return typeof data?.controlLeaseId === 'string' && typeof data?.controlEpoch === 'number';
    }

    inspect(input: { source: LifecycleFence; throughSeq?: number }): LifecycleInventory {
        const source = this.record(input.source.conversationId);
        if (!sameLifecycleFence(lifecycleFence(source), input.source)) throw new AgentFault('REVISION_CONFLICT', '生命周期源版本已经变化');
        const family = this.family(source.key.id);
        const checksum = createHash('sha256');
        const objectRoots = new Set<string>();
        const unknown = new Set<string>(), activeResources = new Set<string>();
        let totalBytes = 0, contentCount = 0, originalCount = 0, retainedSharedObjects = 0;
        const digestRow = (table: string, conversationId: string, value: unknown) => {
            const encoded = canonicalJson({ table, conversationId, value });
            checksum.update(encoded).update('\n'); totalBytes += Buffer.byteLength(encoded);
        };
        checksum.update(canonicalJson({ throughSeq: input.throughSeq ?? null }));
        for (const conversationId of family.members) {
            const record = this.record(conversationId);
            if (record.value.principalId !== source.value.principalId) throw new AgentFault('POLICY_CHANGED', '保存家族所属主体不一致');
            if (record.value.activeRunId || record.value.retention.activeRuns || !['open', 'closed'].includes(record.value.state)
                || !['released', 'not_needed'].includes(record.value.cleanupState)) activeResources.add(`conversation:${conversationId}`);
            const ignoredEvents = new Set<string>(), ignoredReceipts = new Set<string>();
            for (const row of this.rows('events', conversationId)) if (row.type === 'control.changed') ignoredEvents.add(String(row.event_id));
            for (const row of this.rows('receipts', conversationId)) if (this.isControlReceipt(row)) ignoredReceipts.add(receiptKey({
                principalId: String(row.principal_id), clientId: String(row.client_id), conversationId, clientCommandId: String(row.command_id) }));
            digestRow('source', conversationId, lifecycleBusinessValue(record.value));
            for (const table of LIFECYCLE_CONVERSATION_TABLES) for (const row of this.rows(table, conversationId)) {
                if (table === 'conversations') {
                    const { event_seq: _eventSeq, version: _version, ...business } = row;
                    digestRow(table, conversationId, business);
                    continue;
                }
                if (table === 'store_records' && ['conversation', 'control', 'eventAck'].includes(String(row.kind))
                    || table === 'state_items' && ['control', 'eventAck'].includes(String(row.kind))
                    || table === 'events' && ignoredEvents.has(String(row.event_id))
                    || table === 'receipts' && this.isControlReceipt(row)) continue;
                digestRow(table, conversationId, row);
                if (table === 'content_items') { contentCount++; if (ownedManifestKinds.has(String(row.kind))) originalCount++; }
                if (table === 'attempts' && ['unknown', 'outcome_unknown', 'dispatching'].includes(String(row.state))) unknown.add(String(row.attempt_id));
                if (table === 'temporary_provider_attempts' && ['unknown', 'dispatching'].includes(String(row.state))) unknown.add(String(row.attempt_id));
                if (table === 'resources' && !['released', 'not_needed'].includes(String(row.state))) activeResources.add(String(row.resource_id));
            }
            for (const table of Object.keys(LIFECYCLE_FINANCIAL_QUERIES)) for (const row of this.financialRows(table, conversationId)) {
                digestRow(table, conversationId, row);
                if (table === 'provider_attempt_journal' && ['unknown', 'dispatching'].includes(String(row.state))) unknown.add(String(row.attempt_id));
            }
            let after = 0;
            while (true) {
                const rows = this.database.prepare('SELECT rowid AS lifecycle_rowid,* FROM refs WHERE cid = ? AND rowid > ? ORDER BY rowid LIMIT 50').all(conversationId, after);
                for (const row of rows) {
                    after = Number(row.lifecycle_rowid);
                    if (row.owner_kind === 'event' && ignoredEvents.has(String(row.owner_id)) || row.owner_kind === 'receipt' && ignoredReceipts.has(String(row.owner_id))) continue;
                    const { lifecycle_rowid: _rowid, ...reference } = row;
                    digestRow('refs', conversationId, reference);
                    if (row.target_kind === 'object') objectRoots.add(String(row.target_id));
                    else if (row.target_kind === 'manifest') {
                        const manifest = this.database.prepare('SELECT object_hash FROM manifests WHERE manifest_id = ?').get(row.target_id);
                        if (!manifest) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '来源清单缺少原manifest');
                        objectRoots.add(String(manifest.object_hash));
                    }
                }
                if (rows.length < 50) break;
            }
            const runs = this.database.prepare("SELECT run_id FROM runs WHERE cid = ? AND (state NOT IN ('succeeded','failed','cancelled') OR cleanup_state NOT IN ('released','not_needed')) LIMIT 1").get(conversationId);
            if (runs) activeResources.add(`run:${String(runs.run_id)}`);
        }
        const pending = [...objectRoots], seen = new Set<string>();
        while (pending.length) {
            const objectHash = pending.shift()!;
            if (seen.has(objectHash)) continue;
            seen.add(objectHash);
            const object = this.database.prepare('SELECT * FROM objects WHERE hash = ?').get(objectHash);
            if (!object || object.state !== 'ready') throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '生命周期清单中的原件对象缺失或尚未恢复', { objectHash });
            digestRow('object', '', object);
            totalBytes += Number(object.raw_bytes);
            if (this.database.prepare(`SELECT 1 AS shared FROM refs WHERE target_kind = ? AND target_id = ? AND cid NOT IN (${family.members.map(() => '?').join(',')}) LIMIT 1`).get('object', objectHash, ...family.members)
                || this.database.prepare('SELECT 1 AS shared FROM server_refs WHERE target_id = ? LIMIT 1').get(objectHash)) retainedSharedObjects++;
            for (const dependency of this.database.prepare('SELECT payload_hash FROM object_dependencies WHERE source_hash = ? ORDER BY payload_hash').all(objectHash)) pending.push(String(dependency.payload_hash));
        }
        const current = this.record(source.key.id);
        if (!sameLifecycleFence(lifecycleFence(current), input.source)) throw new AgentFault('REVISION_CONFLICT', '生命周期清单完成前源版本已经变化');
        return { schemaVersion: 1, fence: input.source, inventoryHash: checksum.digest('hex'), totalBytes, contentCount,
            originalCount, retentionRootConversationId: family.root, dependentConversationIds: family.members.filter(id => id !== source.key.id),
            retainedSharedObjects, unknownAttemptIds: [...unknown].sort(), activeResourceIds: [...activeResources].sort(), complete: true };
    }

    private receipt(input: LifecycleCommit): StoredReceipt | undefined {
        const key = input.receipt.key;
        if (!key.conversationId || key.serverScope !== undefined) throw new AgentFault('INVALID_PARAMS', '生命周期回执必须绑定原会话');
        const row = this.database.prepare('SELECT operation_hash,result_hash FROM receipts WHERE principal_id = ? AND client_id = ? AND cid = ? AND command_id = ?')
            .get(key.principalId, key.clientId, key.conversationId, key.clientCommandId);
        if (!row) return undefined;
        if (row.operation_hash !== input.receipt.operationHash) throw new AgentFault('COMMAND_CONFLICT', '原生命周期命令已用于不同参数');
        return this.files.read(this.database, String(row.result_hash)) as StoredReceipt;
    }

    private reference(conversationId: string, kind: string, ownerId: string, slot: string, objectHash: string): void {
        this.database.prepare('INSERT OR IGNORE INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id) VALUES (?,?,?,?,?,?)')
            .run(conversationId, kind, ownerId, slot, 'object', objectHash);
    }

    private writeRecord(record: StoreRecord<ConversationData>): void {
        this.database.prepare('INSERT INTO store_records (record_key,scope_id,cid,kind,record_id,revision,value_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(record_key) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json')
            .run(storeKey(record.key), record.key.id, record.key.id, 'conversation', record.key.id, record.revision, canonicalJson(record.value));
    }

    private writeReceipt(receipt: StoredReceipt, object: PreparedObject): void {
        const key = receipt.key;
        if (!key.conversationId || key.serverScope !== undefined) throw new AgentFault('INVALID_PARAMS', '生命周期回执必须绑定原会话');
        this.database.prepare('INSERT INTO receipts (principal_id,client_id,cid,command_id,operation_hash,result_hash,state) VALUES (?,?,?,?,?,?,?)')
            .run(key.principalId, key.clientId, key.conversationId, key.clientCommandId, receipt.operationHash, object.hash, 'committed');
        this.reference(key.conversationId!, 'receipt', receiptKey(key), 'result', object.hash);
    }

    commit(input: LifecycleCommit): StoreCommitResult {
        if (input.schemaVersion !== 1 || input.operationId !== input.receipt.key.clientCommandId
            || input.receipt.key.conversationId !== input.source.conversationId
            || input.target.key.kind !== 'conversation' || input.target.key.conversationId !== input.target.key.id
            || input.target.value.conversationId !== input.target.key.id) throw new AgentFault('INVALID_PARAMS', '生命周期提交身份、操作或目标记录不一致');
        if (!Array.isArray(input.expected) || !input.expected.some(expected => canonicalJson(expected.key) === canonicalJson(controlKey(input.source.conversationId))
            && Number.isSafeInteger(expected.revision) && Number(expected.revision) >= 1)) throw new AgentFault('CONTROL_REQUIRED', '生命周期提交缺少原控制记录的CAS前提');
        const previous = this.receipt(input);
        if (previous) return { replayed: true, receipt: previous };
        const inventory = this.inspect({ source: input.source, ...(input.kind === 'branch' ? { throughSeq: input.manifest.throughSeq } : {}) });
        const source = this.record(input.source.conversationId);
        if (source.value.principalId !== input.receipt.key.principalId || input.target.value.principalId !== source.value.principalId) {
            throw new AgentFault('NOT_FOUND', '找不到该主体可提交的生命周期源会话');
        }
        if (inventory.inventoryHash !== input.inventoryHash) throw new AgentFault('RETENTION_PREVIEW_STALE', '完整原件或费用清单已经变化');
        if (inventory.activeResourceIds.length) throw new AgentFault('RETENTION_TRANSITION_BUSY', '来源家族仍有活动执行或未释放资源', { resourceIds: inventory.activeResourceIds });
        if (input.target.value.retention.mode === 'temporary') throw new AgentFault('RETENTION_TRANSITION_BUSY', '持久转临时须先完成原内存工厂接纳、持久清理和路由原子切换', { requiredRoute: 'durable_to_temporary', inventory });
        return input.kind === 'branch' ? this.commitBranch(input) : this.commitRetention(input, inventory);
    }

    private commitRetention(input: Extract<LifecycleCommit, { kind: 'retention' }>, inventory: LifecycleInventory): StoreCommitResult {
        const source = this.record(input.source.conversationId);
        if (inventory.retentionRootConversationId !== source.key.id) throw new AgentFault('POLICY_CHANGED', '保存转换须从原家族根执行');
        const family = [source.key.id, ...inventory.dependentConversationIds].map(id => this.record(id));
        const targets = family.map(record => convertedConversation(record, plainRetention(input.target.value.retention), input.confirmedAt));
        if (canonicalJson(targets[0]) !== canonicalJson(input.target)) throw new AgentFault('INVALID_PARAMS', '保存转换目标含未预览的会话变化');
        const prepared: PreparedObject[] = [];
        const replacements: { conversationId: string; contentId: string; kind: string; oldHash: string; object: PreparedObject }[] = [];
        for (const target of targets) for (const row of this.rows('content_items', target.key.id)) {
            if (!ownedManifestKinds.has(String(row.kind))) continue;
            const value = this.files.read(this.database, String(row.object_hash)) as Record<string, unknown>;
            const next = { ...value, retention: plainRetention(target.value.retention) };
            const object = this.files.prepare(next, String(row.kind)); prepared.push(object);
            replacements.push({ conversationId: target.key.id, contentId: String(row.content_id), kind: String(row.kind), oldHash: String(row.object_hash), object });
        }
        const receipt = this.files.prepare(input.receipt, 'receipt'); prepared.push(receipt);
        return this.transaction(prepared, [], () => {
            for (let index = 0; index < family.length; index++) {
                if (this.record(family[index].key.id).revision !== family[index].revision) throw new AgentFault('REVISION_CONFLICT', '保存家族版本已变化');
                const target = targets[index], value = target.value, retention = value.retention;
                this.database.prepare('UPDATE conversations SET mode=?,ttl_ms=?,last_run_end=?,last_close=?,expires_at=?,active_runs=0,policy_rev=?,version=? WHERE cid=?')
                    .run(retention.mode, retention.ttlDurationMs ?? null, retention.lastRunEnd, retention.lastClose, retention.expiresAt, value.policyRevision, target.revision, target.key.id);
                this.writeRecord(target);
            }
            for (const replacement of replacements) this.attachContent(replacement);
            this.writeReceipt(input.receipt, receipt);
        }, input.receipt, input.expected);
    }

    private attachContent(input: { conversationId: string; contentId: string; kind: string; oldHash?: string; object: { hash: string } }): void {
        this.database.prepare('INSERT INTO content_items (cid,content_id,kind,object_hash) VALUES (?,?,?,?) ON CONFLICT(cid,content_id) DO UPDATE SET kind=excluded.kind,object_hash=excluded.object_hash')
            .run(input.conversationId, input.contentId, input.kind, input.object.hash);
        if (input.oldHash && input.oldHash !== input.object.hash) this.database.prepare('INSERT OR IGNORE INTO object_dependencies (source_hash,payload_hash) SELECT ?,payload_hash FROM object_dependencies WHERE source_hash=?')
            .run(input.object.hash, input.oldHash);
        this.database.prepare("DELETE FROM refs WHERE cid=? AND owner_kind='content' AND owner_id=? AND slot='value'").run(input.conversationId, input.contentId);
        this.reference(input.conversationId, 'content', input.contentId, 'value', input.object.hash);
    }

    private commitBranch(input: Extract<LifecycleCommit, { kind: 'branch' }>): StoreCommitResult {
        const manifest = input.manifest;
        const { sourceHash, ...manifestValue } = manifest;
        if (hash(manifestValue) !== sourceHash || manifest.sourceConversationId !== input.source.conversationId || input.target.key.id === input.source.conversationId) {
            throw new AgentFault('INVALID_PARAMS', '分支来源清单、哈希或新会话身份不一致');
        }
        if (this.database.prepare('SELECT cid FROM conversations WHERE cid=?').get(input.target.key.id)) throw new AgentFault('REVISION_CONFLICT', '分支独立会话ID已存在');
        const copied = new Map<string, { conversationId: string; contentId: string; kind: string; oldHash?: string; object: { hash: string } }>();
        const prepared: PreparedObject[] = [];
        const copy = (contentId: string): void => {
            if (copied.has(contentId)) return;
            const row = this.database.prepare('SELECT kind,object_hash FROM content_items WHERE cid=? AND content_id=?').get(input.source.conversationId, contentId);
            if (!row) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '分支缺少所选原文或原件正文', { contentId });
            const descriptor = { conversationId: input.target.key.id, contentId, kind: String(row.kind), oldHash: String(row.object_hash), object: { hash: String(row.object_hash) } };
            copied.set(contentId, descriptor);
            const value = this.files.read(this.database, String(row.object_hash)) as JsonValue;
            const visit = (entry: JsonValue): void => {
                if (typeof entry === 'string') {
                    if (this.database.prepare('SELECT 1 AS present FROM content_items WHERE cid=? AND content_id=?').get(input.source.conversationId, entry)) copy(entry);
                } else if (entry && typeof entry === 'object') for (const nested of Object.values(entry)) visit(nested);
            };
            visit(value);
            if (ownedManifestKinds.has(descriptor.kind) && value && typeof value === 'object' && !Array.isArray(value)) {
                const object = this.files.prepare({ ...value, conversationId: input.target.key.id, retention: plainRetention(input.target.value.retention) }, descriptor.kind);
                prepared.push(object); descriptor.object = object;
            }
        };
        const frames = manifest.items.map(item => {
            const row = this.database.prepare('SELECT object_hash,content_id FROM items WHERE cid=? AND seq=? AND history_indexed=1 AND history_effective=1')
                .get(input.source.conversationId, item.sourceSeq);
            if (!row || row.object_hash !== item.objectHash || row.content_id !== item.contentId) throw new AgentFault('E_HISTORY_CONFLICT', '分支指定原文的来源版本不一致');
            copy(item.contentId);
            return { content: this.branchFrame(input.target.key.id, item), objectHash: item.objectHash };
        });
        const selectedAttempts = new Set(manifest.items.flatMap(item => item.attemptId ? [item.attemptId] : []));
        for (const row of this.rows('content_items', input.source.conversationId)) {
            if (row.kind !== 'media_artifact') continue;
            const artifact = this.files.read(this.database, String(row.object_hash)) as { attemptId?: string };
            if (artifact.attemptId && selectedAttempts.has(artifact.attemptId)) copy(String(row.content_id));
        }
        const provenance = this.branchProvenance(input);
        for (const group of manifest.toolOutcomeProvenance?.groups ?? []) for (const call of group.calls) {
            if (!call.content) continue;
            const row = this.database.prepare('SELECT object_hash FROM content_items WHERE cid=? AND content_id=?')
                .get(input.source.conversationId, call.content.contentId);
            if (!row || row.object_hash !== call.content.objectHash) throw new AgentFault('E_REFERENCE_CHANGED', '分支原工具结果引用在提交前变化');
            copy(call.content.contentId);
        }
        for (const contentId of provenance.sourceContentIds) copy(contentId);
        for (const original of provenance.originals) copied.set(original.artifactId, {
            conversationId: input.target.key.id, contentId: original.artifactId, kind: `lifecycle_original_${original.slot}`,
            object: { hash: original.objectHash },
        });
        const provenanceObject = this.files.prepare({ ...manifest, provenance }, 'branch_source'); prepared.push(provenanceObject);
        copied.set(`lifecycle:source:${input.target.key.id}`, { conversationId: input.target.key.id, contentId: `lifecycle:source:${input.target.key.id}`, kind: 'branch_source', object: provenanceObject });
        const receipt = this.files.prepare(input.receipt, 'receipt'); prepared.push(receipt);
        let segments: PreparedSegment[] = [];
        try {
            segments = prepareSegments(this.database, this.dataDir, frames);
            return this.transaction(prepared, segments, () => {
                if (!sameLifecycleFence(lifecycleFence(this.record(input.source.conversationId)), input.source)) throw new AgentFault('REVISION_CONFLICT', '分支提交前源版本已经变化');
                const value = input.target.value, retention = value.retention;
                this.database.prepare('INSERT INTO conversations (cid,mode,ttl_ms,last_run_end,last_close,expires_at,active_runs,policy_rev,history_epoch,append_seq,event_seq,view_revision,run_epoch,state,version) VALUES (?,?,?,?,?,?,0,?,1,0,0,0,0,?,1)')
                    .run(value.conversationId, retention.mode, retention.ttlDurationMs ?? null, null, null, null, value.policyRevision, value.state);
                this.writeRecord(input.target);
                for (const content of copied.values()) this.attachContent(content);
                for (const objectHash of provenance.objectHashes) this.reference(value.conversationId, 'branch_source', provenanceObject.hash, 'original', objectHash);
                commitSegments(this.database, segments);
                for (const frame of frames) this.reference(value.conversationId, 'history', frame.content.contentId, 'value', frame.objectHash);
                this.writeReceipt(input.receipt, receipt);
            }, input.receipt, [...input.expected, ...(manifest.toolOutcomeProvenance?.expected ?? [])]);
        } catch (error) {
            if (!segments.length) this.files.discardUncommitted(this.database, prepared);
            throw error;
        }
    }

    private branchFrame(conversationId: string, item: BranchHistoryItem): ContentWrite {
        const { itemId: _itemId, sourceSeq: _sourceSeq, localSeq: _localSeq, contentId, kind, objectHash: _objectHash, rawBytes: _rawBytes, ...history } = item;
        return { conversationId, contentId, kind, value: null, indexHistory: true, history };
    }

    private branchProvenance(input: Extract<LifecycleCommit, { kind: 'branch' }>) {
        const attemptIds = new Set(input.manifest.items.flatMap(item => item.attemptId ? [item.attemptId] : []));
        const objectHashes = new Set<string>();
        const sourceContentIds = new Set<string>();
        const sourceItems: { itemId: string; contentId: string; sourceSeq: number; objectHash: string }[] = [];
        const context: { record: SqlRow; value: unknown }[] = [];
        for (const row of this.rows('store_records', input.source.conversationId)) {
            if (row.kind !== 'step') continue;
            const state = JSON.parse(String(row.value_json)) as Record<string, unknown>;
            if (state.kind !== 'context_candidate' || typeof state.contentId !== 'string' || state.historyEpoch !== input.source.historyEpoch) continue;
            const candidate = this.database.prepare('SELECT object_hash FROM content_items WHERE cid=? AND content_id=?').get(input.source.conversationId, state.contentId);
            if (!candidate) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '分支BPC来源候选缺少原件');
            const value = this.files.read(this.database, String(candidate.object_hash)) as Record<string, unknown>;
            const snapshot = value.snapshot as { snapshotAppendSeq?: number; coveredEndSeq?: number;
                sourceSpans?: { itemId?: string }[] } | undefined;
            if (!snapshot || !Number.isSafeInteger(snapshot.snapshotAppendSeq) || !Number.isSafeInteger(snapshot.coveredEndSeq)
                || snapshot.snapshotAppendSeq! > input.manifest.throughSeq || snapshot.coveredEndSeq! > input.manifest.throughSeq) continue;
            context.push({ record: row, value }); objectHashes.add(String(candidate.object_hash));
            sourceContentIds.add(state.contentId);
            const visit = (entry: unknown): void => {
                if (typeof entry === 'string' && this.database.prepare('SELECT 1 AS present FROM attempts WHERE cid=? AND attempt_id=?').get(input.source.conversationId, entry)) attemptIds.add(entry);
                else if (entry && typeof entry === 'object') for (const nested of Object.values(entry)) visit(nested);
            };
            visit(state); visit(value);
            for (const span of snapshot.sourceSpans ?? []) {
                if (!span.itemId) continue;
                const original = this.database.prepare('SELECT content_id,seq,object_hash FROM items WHERE cid=? AND item_id=? AND seq<=?')
                    .get(input.source.conversationId, span.itemId, input.manifest.throughSeq);
                if (!original) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', 'BPC来源片段缺少指定轮次内的原文');
                objectHashes.add(String(original.object_hash));
                sourceContentIds.add(String(original.content_id));
                sourceItems.push({ itemId: span.itemId, contentId: String(original.content_id), sourceSeq: Number(original.seq), objectHash: String(original.object_hash) });
            }
        }
        const attempts: SqlRow[] = [], journals: SqlRow[] = [], charges: SqlRow[] = [], reservations: SqlRow[] = [];
        const originals: { artifactId: string; attemptId: string; slot: string; objectHash: string; sourceConversationId?: string }[] = [];
        const parentRow = this.database.prepare('SELECT object_hash FROM content_items WHERE cid=? AND content_id=?')
            .get(input.source.conversationId, `lifecycle:source:${input.source.conversationId}`);
        const parent = parentRow ? this.files.read(this.database, String(parentRow.object_hash)) as {
            provenance?: { originals?: typeof originals } } : undefined;
        for (const attemptId of attemptIds) {
            const attempt = this.database.prepare('SELECT * FROM attempts WHERE cid=? AND attempt_id=?').get(input.source.conversationId, attemptId);
            if (attempt) attempts.push(attempt);
            const journal = this.database.prepare('SELECT * FROM provider_attempt_journal WHERE attempt_id=?').get(attemptId);
            if (journal) {
                journals.push(journal);
                const originalAttempt = this.files.read(this.database, String(journal.attempt_object_hash)) as { snapshot?: { conversationId?: string } };
                for (const slot of ['attempt', 'snapshot', 'response', 'raw', 'failure']) {
                    const column = `${slot}_object_hash`;
                    if (typeof journal[column] !== 'string') continue;
                    const objectHash = String(journal[column]); objectHashes.add(objectHash);
                    originals.push({ artifactId: `lifecycle:attempt:${attemptId}:${slot}`, attemptId, slot, objectHash,
                        ...(originalAttempt.snapshot?.conversationId ? { sourceConversationId: originalAttempt.snapshot.conversationId } : {}) });
                }
            } else {
                for (const original of parent?.provenance?.originals ?? []) if (original.attemptId === attemptId) {
                    const saved = this.database.prepare('SELECT object_hash FROM content_items WHERE cid=? AND content_id=?')
                        .get(input.source.conversationId, original.artifactId);
                    if (!saved || saved.object_hash !== original.objectHash) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '嵌套分支的冻结原生来源缺少原对象');
                    this.files.read(this.database, original.objectHash);
                    originals.push({ ...original }); objectHashes.add(original.objectHash);
                }
            }
            const reservation = this.database.prepare('SELECT * FROM reservations WHERE attempt_id=?').get(attemptId);
            if (reservation) reservations.push(reservation);
            charges.push(...this.database.prepare('SELECT * FROM charges WHERE attempt_id=? ORDER BY quota_scope_id,execution_key,component').all(attemptId));
        }
        return { sourceConversationId: input.source.conversationId, attempts, journals, charges, reservations, context,
            originals, sourceItems, sourceContentIds: [...sourceContentIds], objectHashes: [...objectHashes].sort(),
            financialPolicy: 'original_facts_no_new_charge', contextPolicy: 'rebuild_from_selected_raw' };
    }

    private transaction(prepared: PreparedObject[], segments: PreparedSegment[], write: () => void, receipt: StoredReceipt, expected: TransitionExpected[]): StoreCommitResult {
        let open = false;
        try {
            this.database.exec('BEGIN IMMEDIATE'); open = true;
            for (const condition of expected) {
                const row = this.database.prepare('SELECT revision,value_json FROM store_records WHERE record_key=?').get(storeKey(condition.key));
                if ((row ? Number(row.revision) : null) !== condition.revision) throw new AgentFault('REVISION_CONFLICT', '生命周期提交前控制记录版本已变化', { key: condition.key });
                if (condition.key.kind === 'control' && row) {
                    const value = JSON.parse(String(row.value_json)) as ControlLease;
                    requireControl({ key: condition.key, revision: Number(row.revision), value },
                        { controlLeaseId: value.controlLeaseId, controlEpoch: value.controlEpoch },
                        { principalId: receipt.key.principalId, clientId: receipt.key.clientId }, Date.now());
                }
            }
            for (const object of prepared) this.files.insert(this.database, object);
            write();
            this.database.exec('COMMIT'); open = false;
            return { replayed: false, receipt };
        } catch (error) {
            if (open) {
                try { this.database.exec('ROLLBACK'); open = false; }
                catch { throw new AgentFault('STORAGE_COMMIT_UNKNOWN', '生命周期事务状态未知，须查原命令回执', { clientCommandId: receipt.key.clientCommandId }, true); }
            }
            rollbackSegments(this.dataDir, segments);
            this.files.discardUncommitted(this.database, prepared);
            if (error instanceof AgentFault) throw error;
            throw new AgentFault('STORAGE_DURABILITY_FAILED', '生命周期原子事务未提交，源会话保持原状态');
        }
    }
}
