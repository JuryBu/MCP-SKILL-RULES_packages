import { AgentFault, canonicalJson } from '../protocol.js';
import { unlinkSync } from 'node:fs';
import type { JsonValue } from '../protocol.js';
import type { ConversationData } from '../runtime.js';
import type { SqlDatabase, SqlRow, SqlValue } from '../storage/internal.js';
import type { StoreRecord, StoredReceipt, ContentWrite, ReceiptKey } from '../storage/port.js';
import { storeKey, receiptKey } from '../storage/port.js';
import type { PreparedObject } from '../storage/objects.js';
import { ObjectFiles } from '../storage/objects.js';
import { prepareSegments, commitSegments, rollbackSegments } from '../storage/segments.js';
import type { PreparedSegment } from '../storage/segments.js';
import { BinaryObjectFiles } from '../media/binary-files.js';
import type { PreparedBinaryPayload } from '../media/types.js';
import { insertBinaryObject } from '../storage/media-transactions.js';
import { base64Chunks } from '../media/validation.js';
import { requireControl, controlKey } from '../controller.js';
import type { ControlLease } from '../controller.js';
import { approvalStorageId } from '../storage/workspace-port.js';
import { summarizePending } from '../tools/pending-types.js';
import type { PendingToolRecord } from '../tools/pending-types.js';
import { captureDurableLifecycle, captureLifecycleFinancialFacts, LIFECYCLE_FACTS_ID, LIFECYCLE_PROJECTION_TABLES } from './migration-capture.js';
import type { LifecycleSqlFacts } from './migration-capture.js';
import { DurableConversationLifecycleAdapter } from './storage-adapter.js';
import type { LifecycleWorkerOptions } from './storage-adapter.js';
import { lifecycleFence, sameLifecycleFence } from './policy.js';
import { lifecycleSnapshotHash, requireLifecycleSnapshotOwner } from './migration-snapshots.js';
import type { LifecycleConversationSnapshot } from './migration-snapshots.js';
import type { LifecycleMigrationCommand, LifecycleMigrationOperation, LifecycleMigrationResult, LifecycleSnapshotQuery, LifecycleSnapshotResult } from './migration-contracts.js';
import { collectLifecycleMigrationGarbage, queueLifecycleMigrationGarbage } from './migration-garbage.js';
import { isLifecycleMediaCanonicalReference, recoverLifecycleMediaReferences } from './media-reference-recovery.js';

type ImportCommand = Extract<LifecycleMigrationCommand, { type: 'import' | 'prepare_temporary' }>;

export class LifecycleMigrationTransactions {
    private readonly database: SqlDatabase;
    private readonly files: ObjectFiles;
    private readonly dataDir: string;
    private readonly durable: DurableConversationLifecycleAdapter;

    constructor(options: LifecycleWorkerOptions) {
        this.database = options.database; this.files = options.files; this.dataDir = options.dataDir;
        this.durable = new DurableConversationLifecycleAdapter(options);
    }

    snapshot(input: LifecycleSnapshotQuery): LifecycleSnapshotResult {
        if (input.type === 'financial') return { kind: 'financial', ...captureLifecycleFinancialFacts(this.database, input.conversationIds) };
        const inventory = this.durable.inspect({ source: input.source });
        const snapshots = [input.source.conversationId, ...inventory.dependentConversationIds].sort()
            .map(conversationId => captureDurableLifecycle(this.database, this.files, this.dataDir, conversationId));
        return { kind: 'snapshot', snapshots, inventory, snapshotHash: lifecycleSnapshotHash(snapshots),
            ...captureLifecycleFinancialFacts(this.database, snapshots.map(snapshot => snapshot.conversationId)) };
    }

    execute(input: LifecycleMigrationCommand): LifecycleMigrationResult {
        if (input.type === 'read') return { kind: 'operation', operation: this.operation(input.key, input.operationHash) };
        if (input.type === 'recover') return this.recover();
        if (input.type === 'complete_temporary') return this.complete(input.key, input.operationHash);
        this.validate(input);
        return input.type === 'import' ? this.import(input) : this.prepareTemporary(input);
    }

    private validate(input: ImportCommand): void {
        const commit = input.commit;
        if (commit.kind !== 'retention' || commit.operationId !== commit.receipt.key.clientCommandId
            || commit.source.conversationId !== commit.receipt.key.conversationId || !input.snapshots.length
            || new Set(input.snapshots.map(snapshot => snapshot.conversationId)).size !== input.snapshots.length) throw new AgentFault('INVALID_PARAMS', '迁移的原操作或会话清单不同');
        const root = input.snapshots.find(snapshot => snapshot.conversationId === commit.source.conversationId);
        if (!root) throw new AgentFault('INVALID_PARAMS', '迁移缺少原根会话');
        for (const snapshot of input.snapshots) {
            requireLifecycleSnapshotOwner(snapshot, snapshot.core.conversationId);
            const record = snapshot.core.records.find(record => record.key.kind === 'conversation' && record.key.id === snapshot.conversationId);
            if (!record || record.value.principalId !== commit.receipt.key.principalId || record.value.activeRunId
                || !['open', 'closed'].includes(String(record.value.state))) throw new AgentFault('RETENTION_TRANSITION_BUSY', '迁移源仍有执行或不属于原主体');
        }
        const target = root.core.records.find(record => record.key.kind === 'conversation')!;
        const normalizedTarget = structuredClone(target);
        delete normalizedTarget.value.lifecycleTransition;
        if (canonicalJson(normalizedTarget) !== canonicalJson(commit.target)) throw new AgentFault('INVALID_PARAMS', '迁移目标与已确认原目标不同');
        const expected = commit.expected.find(entry => storeKey(entry.key) === storeKey(controlKey(commit.source.conversationId)));
        const control = root.core.records.find(record => storeKey(record.key) === storeKey(controlKey(commit.source.conversationId))) as StoreRecord<ControlLease> | undefined;
        if (!expected || control?.revision !== expected.revision) throw new AgentFault('CONTROL_REQUIRED', '迁移缺少原控制记录版本');
        requireControl(control, control?.value ?? {}, commit.receipt.key, Date.now());
        if (captureLifecycleFinancialFacts(this.database, input.snapshots.map(snapshot => snapshot.conversationId)).financialHash !== input.financialHash) throw new AgentFault('RETENTION_PREVIEW_STALE', '原费用事实已变化，未复制或重发任何费用');
    }

    private atomic<Value>(objects: PreparedObject[], segments: PreparedSegment[], operation: () => Value,
        prepare?: () => void, binaries: PreparedBinaryPayload[] = []): Value {
        let active = false;
        try {
            prepare?.();
            this.database.exec('BEGIN IMMEDIATE'); active = true;
            for (const object of objects) this.files.insert(this.database, object);
            const result = operation(); this.database.exec('COMMIT'); active = false; return result;
        } catch (error) {
            if (active) {
                try { this.database.exec('ROLLBACK'); }
                catch { throw new AgentFault('STORAGE_COMMIT_UNKNOWN', '迁移回滚状态尚未确认，请沿原命令查询', { phase: 'rollback' }, true); }
            }
            try {
                rollbackSegments(this.dataDir, segments); this.files.discardUncommitted(this.database, objects);
                const binaryFiles = new BinaryObjectFiles(this.dataDir, 32 * 1024 * 1024);
                for (const binary of binaries) {
                    if (!binary.created || this.database.prepare('SELECT 1 FROM objects WHERE hash=? OR path=?').get(binary.sha256, binary.path)
                        || this.database.prepare("SELECT 1 FROM refs WHERE target_kind='object' AND target_id=?").get(binary.sha256)) continue;
                    try { unlinkSync(binaryFiles.absolutePath(binary)); }
                    catch (cleanup) { if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanup; }
                }
            } catch (cleanup) {
                throw new AgentFault('RETENTION_TRANSITION_BUSY', '原迁移尚未提交，自有staging清理仍待完成', { phase: 'staging_cleanup',
                    originalCode: error instanceof AgentFault ? error.code : (error as NodeJS.ErrnoException).code ?? 'STORAGE_DURABILITY_FAILED',
                    cleanupCode: (cleanup as NodeJS.ErrnoException).code ?? 'STORAGE_DURABILITY_FAILED' });
            }
            throw error;
        }
    }

    private reference(conversationId: string, ownerKind: string, ownerId: string, slot: string, hash: string): void {
        this.database.prepare('INSERT OR IGNORE INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id) VALUES (?,?,?,?,?,?)')
            .run(conversationId, ownerKind, ownerId, slot, 'object', hash);
    }

    private writeReceipt(receipt: StoredReceipt, object: PreparedObject): void {
        const key = receipt.key;
        if (!key.conversationId) {
            const previous = this.database.prepare('SELECT operation_hash,result_json FROM server_receipts WHERE principal_id=? AND client_id=? AND command_id=?').get(key.principalId, key.clientId, key.clientCommandId);
            if (previous && (previous.operation_hash !== receipt.operationHash || String(previous.result_json) !== canonicalJson(receipt))) throw new AgentFault('COMMAND_CONFLICT', '迁移的全局原回执已有不同结果');
            this.database.prepare('INSERT OR IGNORE INTO server_receipts (principal_id,client_id,command_id,operation_hash,result_json) VALUES (?,?,?,?,?)')
                .run(key.principalId, key.clientId, key.clientCommandId, receipt.operationHash, canonicalJson(receipt));
            return;
        }
        const previous = this.database.prepare('SELECT operation_hash FROM receipts WHERE principal_id=? AND client_id=? AND cid=? AND command_id=?').get(key.principalId, key.clientId, key.conversationId, key.clientCommandId);
        if (previous && previous.operation_hash !== receipt.operationHash) throw new AgentFault('COMMAND_CONFLICT', '迁移的原会话回执已用于不同参数');
        this.database.prepare('INSERT OR IGNORE INTO receipts (cid,principal_id,client_id,command_id,operation_hash,result_hash,state) VALUES (?,?,?,?,?,?,?)')
            .run(key.conversationId, key.principalId, key.clientId, key.clientCommandId, receipt.operationHash, object.hash, 'committed');
        this.reference(key.conversationId, 'receipt', receiptKey(key), 'result', object.hash);
    }

    private writeRecord(record: StoreRecord): void {
        const value = record.value, cid = record.key.conversationId!;
        this.database.prepare('INSERT INTO store_records (record_key,scope_id,cid,kind,record_id,revision,value_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(record_key) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json')
            .run(storeKey(record.key), cid, cid, record.key.kind, record.key.id, record.revision, canonicalJson(value));
        if (record.key.kind === 'run') {
            this.database.prepare('INSERT INTO runs (run_id,cid,root_run_id,parent_run_id,run_epoch,kind,state,phase,active_round_id,active_step_id,deadline_at,effect_state,cleanup_state,version,updated_at,snapshot_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET version=excluded.version,state=excluded.state,run_epoch=excluded.run_epoch,cleanup_state=excluded.cleanup_state,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at')
                .run(record.key.id, cid, String(value.rootRunId ?? record.key.id), typeof value.parentRunId === 'string' ? value.parentRunId : null,
                    Number(value.runEpoch), String(value.kind), String(value.state), typeof value.phase === 'string' ? value.phase : null,
                    typeof value.activeRoundId === 'string' ? value.activeRoundId : null, typeof value.activeStepId === 'string' ? value.activeStepId : null,
                    typeof value.deadlineAt === 'string' ? value.deadlineAt : null, String(value.effectState), String(value.cleanupState), record.revision, String(value.updatedAt), canonicalJson(value));
        } else if (record.key.kind !== 'conversation') this.database.prepare('INSERT INTO state_items (cid,kind,state_id,version,state,content_hash,anchor_id,order_key) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(cid,kind,state_id) DO UPDATE SET version=excluded.version,state=excluded.state,anchor_id=excluded.anchor_id,order_key=excluded.order_key')
            .run(cid, record.key.kind, record.key.id, record.revision, String(value.state ?? 'ready'), null, typeof value.contentId === 'string' ? value.contentId : null, typeof value.order === 'number' ? value.order : null);
    }

    private insertProjection(table: string, row: SqlRow): void {
        const allowed = [...LIFECYCLE_PROJECTION_TABLES, 'provider_attempt_journal', 'provider_tool_intents', 'provider_tool_batches'];
        if (!allowed.includes(table)) throw new AgentFault('INVALID_PARAMS', '未知生命周期内部投影');
        const columns = Object.keys(row), known = new Set(this.database.prepare(`PRAGMA table_info(${table})`).all().map(entry => String(entry.name)));
        if (!columns.length || columns.some(column => !known.has(column))) throw new AgentFault('STORAGE_SNAPSHOT_INVALID', '生命周期投影字段与当前schema不同');
        this.database.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...columns.map(column => row[column]));
    }

    private import(input: ImportCommand): LifecycleMigrationResult {
        const prepared: PreparedObject[] = [], segments: PreparedSegment[] = [], binaries: PreparedBinaryPayload[] = [];
        const object = (value: unknown, kind: string) => { const next = this.files.prepare(value, kind, payload => binaries.push(payload)); prepared.push(next); return next; };
        const contentObjects = new Map<string, PreparedObject>();
        let receipt: PreparedObject | undefined;
        return this.atomic(prepared, segments, () => {
            for (const snapshot of input.snapshots) {
                const root = snapshot.core.records.find(record => record.key.kind === 'conversation') as unknown as StoreRecord<ConversationData>;
                const value = root.value, retention = value.retention;
                if (retention.mode === 'temporary') throw new AgentFault('INVALID_PARAMS', '持久导入不能写temporary模式');
                const existing = this.database.prepare('SELECT state FROM conversations WHERE cid=?').get(snapshot.conversationId);
                if (existing && existing.state !== 'deleted') throw new AgentFault('REVISION_CONFLICT', '迁移目标已有有效持久源');
                this.database.prepare('INSERT INTO conversations (cid,mode,ttl_ms,last_run_end,last_close,expires_at,active_runs,policy_rev,history_epoch,append_seq,event_seq,view_revision,run_epoch,state,version) VALUES (?,?,?,?,?,?,0,?,?,0,?,?,?,?,?) ON CONFLICT(cid) DO UPDATE SET mode=excluded.mode,ttl_ms=excluded.ttl_ms,last_run_end=excluded.last_run_end,last_close=excluded.last_close,expires_at=excluded.expires_at,active_runs=0,policy_rev=excluded.policy_rev,history_epoch=excluded.history_epoch,append_seq=0,event_seq=excluded.event_seq,view_revision=excluded.view_revision,run_epoch=excluded.run_epoch,state=excluded.state,version=excluded.version')
                    .run(value.conversationId, retention.mode, retention.ttlDurationMs ?? null, retention.lastRunEnd, retention.lastClose, retention.expiresAt, value.policyRevision, value.historyEpoch,
                        BigInt(value.eventSeq), value.viewRevision, value.runEpoch, value.state, root.revision);
                this.database.prepare("UPDATE segments SET state='sealed' WHERE cid=?").run(snapshot.conversationId);
                for (const record of snapshot.core.records) this.writeRecord(record);
                for (const content of snapshot.core.contents) {
                    const saved = contentObjects.get(JSON.stringify([snapshot.conversationId, content.contentId]))!;
                    this.database.prepare('INSERT INTO content_items (cid,content_id,kind,object_hash) VALUES (?,?,?,?)').run(snapshot.conversationId, content.contentId, content.kind, saved.hash);
                    this.reference(snapshot.conversationId, 'content', content.contentId, 'value', saved.hash);
                    if (content.kind === 'lifecycle_binary_payload') {
                        const binary = content.value as { sha256: string; mime: string; byteLength: number; dataBase64: string };
                        const payload = new BinaryObjectFiles(this.dataDir, 32 * 1024 * 1024).prepare(base64Chunks(binary.dataBase64), { sha256: binary.sha256, mime: binary.mime, byteLength: binary.byteLength });
                        binaries.push(payload);
                        insertBinaryObject(this.database, payload); this.reference(snapshot.conversationId, 'lifecycle_original', content.contentId, 'binary', binary.sha256);
                    }
                }
                const frames = snapshot.core.history.map(item => {
                    const content = snapshot.core.contents.find(content => content.contentId === item.contentId);
                    if (!content || content.sha256 !== item.objectRef.hash) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '导入历史缺少原正文');
                    const { itemId: _itemId, seq: _seq, contentId, kind, objectRef: _ref, value: _value, ...history } = item;
                    return { content: { conversationId: snapshot.conversationId, contentId, kind, value: null, indexHistory: true, history } as ContentWrite, objectHash: content.sha256 };
                });
                const staged = prepareSegments(this.database, this.dataDir, frames); segments.push(...staged); commitSegments(this.database, staged);
                for (const item of snapshot.core.history) this.database.prepare('UPDATE items SET item_id=? WHERE cid=? AND seq=?').run(item.itemId, snapshot.conversationId, item.seq);
                for (const original of snapshot.core.receipts) { const saved = object(original, 'receipt'); this.files.insert(this.database, saved); this.writeReceipt(original, saved); }
                for (const event of snapshot.core.events) {
                    const saved = object(event, 'event'); this.files.insert(this.database, saved);
                    this.database.prepare('INSERT INTO events (cid,event_seq,event_id,type,payload_hash) VALUES (?,?,?,?,?)').run(snapshot.conversationId, BigInt(event.eventSeq), event.eventId, event.type, saved.hash);
                    this.reference(snapshot.conversationId, 'event', event.eventId, 'payload', saved.hash);
                }
                this.importFactoryFacts(snapshot, object);
                if (typeof value.options.parentConversationId === 'string') this.database.prepare("INSERT INTO server_state (kind,id,revision,value_json) VALUES ('retentionOwner',?,1,?) ON CONFLICT(kind,id) DO UPDATE SET value_json=excluded.value_json")
                    .run(value.conversationId, canonicalJson({ conversationId: value.conversationId, parentConversationId: value.options.parentConversationId }));
            }
            this.writeReceipt(input.commit.receipt, receipt!);
            return { kind: 'committed', result: { replayed: false, receipt: input.commit.receipt } };
        }, () => {
            for (const snapshot of input.snapshots) for (const content of snapshot.core.contents) {
                const next = object(content.value, content.kind);
                if (next.hash !== content.sha256 || next.bytes !== content.rawBytes) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '导入正文与原SHA或大小不同');
                contentObjects.set(JSON.stringify([snapshot.conversationId, content.contentId]), next);
            }
            receipt = object(input.commit.receipt, 'receipt');
        }, binaries);
    }

    private importFactoryFacts(snapshot: LifecycleConversationSnapshot, object: (value: unknown, kind: string) => PreparedObject): void {
        const cid = snapshot.conversationId;
        const facts = snapshot.core.contents.find(content => content.contentId === LIFECYCLE_FACTS_ID)?.value as unknown as LifecycleSqlFacts | undefined;
        if (facts) {
            requireLifecycleSnapshotOwner(facts, cid);
            for (const table of LIFECYCLE_PROJECTION_TABLES) for (const row of facts.projections[table] ?? []) {
                if (row.cid !== cid || table === 'resources' && !['released', 'not_needed'].includes(String(row.state))) throw new AgentFault('STORAGE_SNAPSHOT_INVALID', '原投影包含其它会话或活动资源');
                if (table === 'workspace_changes' || table === 'restore_plans') continue;
                this.insertProjection(table, row);
            }
            for (const row of facts.journals) this.insertProjection('provider_attempt_journal', row);
            for (const row of facts.toolIntents) this.insertProjection('provider_tool_intents', row);
            for (const row of facts.toolBatches) this.insertProjection('provider_tool_batches', row);
            for (const ref of facts.refs) if (ref.cid === cid && ref.target_kind === 'object'
                && !(ref.owner_kind === 'content' && ref.owner_id === LIFECYCLE_FACTS_ID && ref.slot === 'value')
                && !isLifecycleMediaCanonicalReference(this.database, cid, ref)) {
                this.reference(cid, String(ref.owner_kind), String(ref.owner_id), String(ref.slot), String(ref.target_id));
            }
        }
        recoverLifecycleMediaReferences(this.database, this.files, cid);
        for (const entry of snapshot.provider.temporaryAttempts) {
            if (!entry.attempt || !entry.upperBound) continue;
            const attempt = entry.attempt, savedAttempt = object(attempt, 'provider_attempt'), savedSnapshot = object(attempt.snapshot, 'provider_snapshot');
            this.files.insert(this.database, savedAttempt); this.files.insert(this.database, savedSnapshot);
            const response = entry.response ? object(entry.response, 'provider_response') : undefined, failure = entry.failure ? object(entry.failure, 'provider_failure') : undefined;
            const raw = entry.response?.raw ? object(entry.response.raw, 'provider_raw') : undefined;
            for (const saved of [response, failure, raw]) if (saved) this.files.insert(this.database, saved);
            this.insertProjection('attempts', { attempt_id: attempt.attemptId, action_id: attempt.snapshot.actionId, cid, run_id: attempt.snapshot.runId,
                run_epoch: attempt.snapshot.runEpoch, state: entry.state, body_hash: attempt.snapshot.bodyHash, provider_request_id: null,
                response_id: entry.response?.providerResponseId ?? null, snapshot_hash: attempt.snapshot.snapshotHash, usage_hash: null, reservation_id: attempt.attemptId, updated_at: new Date().toISOString() });
            this.insertProjection('provider_attempt_journal', { attempt_id: attempt.attemptId, root_budget_id: attempt.rootBudgetId,
                intent_hash: lifecycleSnapshotHash({ attemptId: attempt.attemptId, rootBudgetId: attempt.rootBudgetId, snapshotHash: attempt.snapshot.snapshotHash,
                    bodyHash: attempt.snapshot.bodyHash, idempotencyKey: attempt.idempotencyKey ?? null, upperBound: entry.upperBound }),
                attempt_object_hash: savedAttempt.hash, snapshot_object_hash: savedSnapshot.hash, upper_bound_json: canonicalJson(entry.upperBound), state: entry.state,
                dispatch_granted: 1, response_object_hash: response?.hash ?? null, raw_object_hash: raw?.hash ?? null, failure_object_hash: failure?.hash ?? null,
                tools_authorized: entry.toolsAuthorized ? 1 : 0, late_response: entry.lateResponse ? 1 : 0, updated_at: new Date().toISOString() });
            for (const [slot, saved] of Object.entries({ attempt: savedAttempt, snapshot: savedSnapshot, response, raw, failure })) if (saved) this.reference(cid, 'provider_attempt', attempt.attemptId, slot, saved.hash);
            this.database.prepare('INSERT OR IGNORE INTO provider_budget_bindings (root_budget_id,cid,root_run_id) VALUES (?,?,?)').run(attempt.rootBudgetId, cid, attempt.rootBudgetId);
        }
        const save = (value: unknown, kind: string) => { const saved = object(value, kind); this.files.insert(this.database, saved); return saved; };
        for (const action of snapshot.workspace.actions) {
            const saved = save(action, 'workspace_change');
            this.database.prepare('INSERT INTO workspace_changes (action_id,cid,run_id,round_id,attempt_id,policy_revision,workspace_revision_before,workspace_revision_after,state,content_hash,version) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
                .run(action.actionId, cid, action.runId, action.roundId, action.attemptId, action.policyRevision, action.workspaceRevisionBefore, action.workspaceRevisionAfter ?? null, action.state, saved.hash,
                    Number(facts?.projections.workspace_changes?.find(row => row.action_id === action.actionId)?.version ?? (action.state === 'prepared' ? 1 : 2)));
            this.reference(cid, 'workspace_change', action.actionId, 'value', saved.hash);
        }
        for (const plan of snapshot.workspace.restorePlans) {
            const saved = save(plan, 'restore_plan');
            this.database.prepare('INSERT INTO restore_plans (restore_plan_id,cid,mode,history_epoch,workspace_revision,state,content_hash,version) VALUES (?,?,?,?,?,?,?,?)')
                .run(plan.restorePlanId, cid, plan.mode, plan.historyEpoch, plan.workspaceRevision, plan.state, saved.hash, plan.revision);
            this.reference(cid, 'restore_plan', plan.restorePlanId, 'value', saved.hash);
        }
        for (const [kind, entries] of [['ticket', snapshot.workspace.tickets.map(ticket => ({ key: ticket.approvalId, value: ticket }))],
            ['receipt', snapshot.workspace.approvalReceipts.map(receipt => ({ key: receipt.key, value: receipt }))]] as const) for (const entry of entries) {
            const identity = approvalStorageId(kind, entry.key);
            this.database.prepare('INSERT INTO server_state (kind,id,revision,value_json) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json')
                .run(identity.kind, identity.id, Number(facts?.serverState?.find(row => row.kind === identity.kind && row.id === identity.id)?.revision ?? 1), canonicalJson(entry.value));
        }
        for (const pendingToolId of snapshot.pending.pendingToolIds) {
            const content = snapshot.core.contents.find(content => content.contentId === `pending-tool:${pendingToolId}`);
            if (!content) throw new AgentFault('STORAGE_SNAPSHOT_INVALID', '持久导入缺少原待办');
            const record = content.value as unknown as PendingToolRecord, frozen = save(record.frozen, 'pending_tool_origin');
            const { frozen: _frozen, ...mutable } = record;
            const state = save({ ...mutable, frozenHash: frozen.hash }, 'pending_tool_state');
            this.database.prepare('INSERT INTO server_state (kind,id,revision,value_json) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json')
                .run('workspacePendingTool', pendingToolId, record.revision, canonicalJson({ ...summarizePending(record), frozenHash: frozen.hash, stateHash: state.hash }));
            this.reference(cid, 'pending_tool', pendingToolId, 'frozen', frozen.hash); this.reference(cid, 'pending_tool', pendingToolId, 'state', state.hash);
        }
    }

    private prepareTemporary(input: ImportCommand): LifecycleMigrationResult {
        const source = this.snapshot({ type: 'durable', source: input.commit.source });
        if (source.kind !== 'snapshot' || source.snapshotHash !== input.sourceSnapshotHash || source.inventory.inventoryHash !== input.commit.inventoryHash) throw new AgentFault('RETENTION_PREVIEW_STALE', '权威提交前的持久原件清单已变化');
        const operation: LifecycleMigrationOperation = { schemaVersion: 1, conversationId: input.commit.source.conversationId,
            conversationIds: input.snapshots.map(snapshot => snapshot.conversationId), operationId: input.commit.operationId, principalId: input.commit.receipt.key.principalId,
            clientId: input.commit.receipt.key.clientId, status: 'awaiting_memory', receipt: input.commit.receipt, updatedAt: input.commit.confirmedAt };
        this.atomic([], [], () => {
            for (const expected of input.commit.expected) {
                const row = this.database.prepare('SELECT revision FROM store_records WHERE record_key=?').get(storeKey(expected.key));
                if (Number(row?.revision) !== expected.revision) throw new AgentFault('REVISION_CONFLICT', '权威提交前的原控制记录已变化');
            }
            for (const cid of operation.conversationIds) {
                queueLifecycleMigrationGarbage(this.database, cid, operation.operationId);
                this.database.prepare("DELETE FROM provider_tool_intents WHERE attempt_id IN (SELECT journal.attempt_id FROM provider_attempt_journal journal JOIN attempts USING(attempt_id) WHERE cid=? AND journal.state NOT IN ('dispatching','unknown'))").run(cid);
                this.database.prepare("DELETE FROM provider_tool_batches WHERE attempt_id IN (SELECT journal.attempt_id FROM provider_attempt_journal journal JOIN attempts USING(attempt_id) WHERE cid=? AND journal.state NOT IN ('dispatching','unknown'))").run(cid);
                this.database.prepare("DELETE FROM provider_attempt_journal WHERE attempt_id IN (SELECT attempt_id FROM attempts WHERE cid=?) AND state NOT IN ('dispatching','unknown')").run(cid);
                for (const table of ['candidates', 'workspace_changes', 'restore_plans', 'content_items', 'items', 'history_rounds', 'search_chunks', 'state_items', 'receipts', 'events', 'resources', 'store_records']) this.database.prepare(`DELETE FROM ${table} WHERE cid=?`).run(cid);
                this.database.prepare("DELETE FROM refs WHERE cid=? AND NOT (owner_kind='provider_attempt' AND owner_id IN (SELECT journal.attempt_id FROM provider_attempt_journal journal JOIN attempts USING(attempt_id) WHERE cid=? AND journal.state IN ('dispatching','unknown')))").run(cid, cid);
                this.database.prepare('DELETE FROM manifests WHERE cid=? AND NOT EXISTS (SELECT 1 FROM refs WHERE target_kind=? AND target_id=manifests.manifest_id)').run(cid, 'manifest');
                this.database.prepare("DELETE FROM server_state WHERE kind IN ('workspaceApprovalTicket','workspacePendingTool') AND json_extract(value_json,'$.conversationId')=?").run(cid);
                for (const receipt of source.snapshots.find(snapshot => snapshot.conversationId === cid)!.core.receipts) if (!receipt.key.conversationId) this.database.prepare('DELETE FROM server_receipts WHERE principal_id=? AND client_id=? AND command_id=?')
                    .run(receipt.key.principalId, receipt.key.clientId, receipt.key.clientCommandId);
                for (const receipt of source.snapshots.find(snapshot => snapshot.conversationId === cid)!.workspace.approvalReceipts) this.database.prepare("DELETE FROM server_state WHERE kind='workspaceApprovalReceipt' AND id=?").run(approvalStorageId('receipt', receipt.key).id);
                this.database.prepare("UPDATE conversations SET state='deleted',active_runs=0,history_root=NULL,view_root=NULL WHERE cid=?").run(cid);
                this.database.prepare("UPDATE segments SET state='sealed' WHERE cid=?").run(cid);
                this.database.prepare("UPDATE runs SET snapshot_json=json_object('conversationId',cid,'runId',run_id,'state',state,'retentionMigrated',json('true')) WHERE cid=?").run(cid);
            }
            this.writeOperation(operation);
        });
        return { kind: 'temporary_prepared', operation };
    }

    private operation(key: ReceiptKey, hash: string): LifecycleMigrationOperation | null {
        const row = this.database.prepare("SELECT value_json FROM server_state WHERE kind='policyTransition' AND id=?").get(key.conversationId ?? '');
        if (!row) return null;
        const operation = JSON.parse(String(row.value_json)) as LifecycleMigrationOperation;
        if (operation.operationId !== key.clientCommandId) return null;
        if (operation.principalId !== key.principalId || operation.clientId !== key.clientId || operation.receipt.operationHash !== hash) throw new AgentFault('COMMAND_CONFLICT', '原迁移命令的主体、客户端或参数不同');
        return operation;
    }

    private writeOperation(operation: LifecycleMigrationOperation): void {
        this.database.prepare("INSERT INTO server_state (kind,id,revision,value_json) VALUES ('policyTransition',?,1,?) ON CONFLICT(kind,id) DO UPDATE SET revision=server_state.revision+1,value_json=excluded.value_json")
            .run(operation.conversationId, canonicalJson(operation));
    }

    private complete(key: ReceiptKey, hash: string): LifecycleMigrationResult {
        const operation = this.operation(key, hash);
        if (!operation) throw new AgentFault('NOT_FOUND', '找不到原迁移操作');
        if (operation.status !== 'awaiting_memory') return { kind: 'committed', result: { replayed: true, receipt: operation.receipt } };
        const garbage = collectLifecycleMigrationGarbage(this.database, this.dataDir, operation.operationId);
        if (garbage.failures.length) throw new AgentFault('RETENTION_TRANSITION_BUSY', '原迁移的自有持久引用仍在清理', { operationId: operation.operationId, garbage });
        const saved = this.files.prepare(operation.receipt, 'receipt');
        this.atomic([saved], [], () => { this.writeReceipt(operation.receipt, saved); operation.status = 'complete'; operation.updatedAt = new Date().toISOString(); this.writeOperation(operation); });
        return { kind: 'committed', result: { replayed: false, receipt: operation.receipt } };
    }

    private recover(): LifecycleMigrationResult {
        let afterConversationId: string | undefined;
        for (;;) {
            const row = this.database.prepare(`SELECT DISTINCT cid FROM content_items WHERE ((content_id=? AND kind=?) OR kind='media_artifact')
                ${afterConversationId === undefined ? '' : 'AND cid>?'} ORDER BY cid LIMIT 1`)
                .get(LIFECYCLE_FACTS_ID, 'lifecycle_sql_facts', ...(afterConversationId === undefined ? [] : [afterConversationId]));
            if (!row) break;
            const cid = String(row.cid);
            this.atomic([], [], () => {
                const canonicalFacts = this.database.prepare('SELECT object_hash FROM content_items WHERE cid=? AND content_id=? AND kind=?')
                    .get(cid, LIFECYCLE_FACTS_ID, 'lifecycle_sql_facts');
                if (canonicalFacts) {
                    const objectHash = String(canonicalFacts.object_hash);
                    const facts = this.files.read(this.database, objectHash) as LifecycleSqlFacts;
                    if (facts.schemaVersion !== 1 || facts.conversationId !== cid) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '生命周期内部清单的原会话归属不同');
                    this.database.prepare("DELETE FROM refs WHERE cid=? AND owner_kind='content' AND owner_id=? AND slot='value' AND target_kind='object' AND target_id<>?")
                        .run(cid, LIFECYCLE_FACTS_ID, objectHash);
                    this.reference(cid, 'content', LIFECYCLE_FACTS_ID, 'value', objectHash);
                }
                recoverLifecycleMediaReferences(this.database, this.files, cid);
            });
            afterConversationId = cid;
        }
        const operations: LifecycleMigrationOperation[] = [];
        for (const row of this.database.prepare("SELECT value_json FROM server_state WHERE kind='policyTransition' ORDER BY id").all()) {
            const operation = JSON.parse(String(row.value_json)) as LifecycleMigrationOperation;
            if (operation.schemaVersion !== 1 || operation.status !== 'awaiting_memory') continue;
            collectLifecycleMigrationGarbage(this.database, this.dataDir, operation.operationId);
            operation.status = 'temporary_lost'; operation.updatedAt = new Date().toISOString();
            operation.receipt = { ...operation.receipt, result: { ok: false, receiptId: operation.receipt.result.receiptId,
                error: { code: 'TEMPORARY_CONTENT_LOST', message: '原转换的内存工厂随实例退出，临时内容已丢失；原费用尝试保持原ID查询', retryable: false, mayHaveStarted: true,
                    details: { operationId: operation.operationId, conversationId: operation.conversationId } } } };
            const saved = this.files.prepare(operation.receipt, 'receipt');
            this.atomic([saved], [], () => { this.writeReceipt(operation.receipt, saved); this.writeOperation(operation); }); operations.push(operation);
        }
        return { kind: 'recovered', operations };
    }
}
