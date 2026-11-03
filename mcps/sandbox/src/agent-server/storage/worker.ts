import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { AgentEvent, JsonValue } from '../protocol.js';
import { receiptKey, storeKey } from './port.js';
import type { ModelStepPairingQuery } from './port.js';
import { modelStepPairing, validateModelStepPairingQuery } from './model-step-pairing.js';
import type { ReceiptKey, StoredReceipt, StoreCommitResult, StoreEventQuery, StoreKey,
    StorePage, StoreRecord, StoreRecordQuery, StoreTransition, HistoryQuery, ArtifactQuery, HistoryMetadataQuery } from './port.js';
import { DEFAULT_MAX_OBJECT_BYTES, MAX_METADATA_BYTES, MAX_PAGE_BYTES, MAX_WRITE_BATCH } from './internal.js';
import type { SqlDatabase, StorageOptions, WorkerRequest, WorkerResponse } from './internal.js';
import { loadMigrations, migrateDatabase, validateDatabaseVersion, STORAGE_SCHEMA_VERSION } from './migrations.js';
import { ObjectFiles } from './objects.js';
import type { PreparedObject } from './objects.js';
import { commitSegments, prepareSegments, rollbackSegments } from './segments.js';
import type { PreparedSegment } from './segments.js';
import { acquireStorageLock, recoverSegments } from './recovery.js';
import { assertRunMayStart, recordRetention, refreshRetention, scanExpired, recordRetentionOwnership, purgeExpiredConversation, collectRetentionGarbage, sweepRetention } from './retention.js';
import type { RetentionSweepOptions } from './port.js';
import { readHistory, readHistoryMetadata } from './history.js';
import { ProviderTransactions } from './provider-transactions.js';
import type { AccountingCommand, UpperBound } from '../accounting/budget-ledger.js';
import type { ProviderAttempt, NormalizedResponse } from '../providers/types.js';
import type { RecordedFailure } from '../providers/dispatch.js';
import { ConfigurationTransactions } from './configuration.js';
import type { ProfileCommand } from '../profiles/profile-store.js';
import type { ProtectedSecret } from '../profiles/secret-vault.js';
import type { CatalogSnapshot } from '../models/catalog.js';
import { WorkspaceTransactions } from './workspace-transactions.js';
import type { WorkspaceCommand, WorkspaceQuery } from './workspace-port.js';
import { MediaTransactions } from './media-transactions.js';
import { BinaryObjectFiles } from '../media/binary-files.js';
import type { MediaCommand, MediaQuery } from './media-port.js';
import { TemporaryFeeTransactions } from './temporary-transactions.js';
import type { TemporaryFeeCommand } from './temporary-finance.js';
import type { ReservationInput } from '../accounting/budget-ledger.js';
import { DurableConversationLifecycleAdapter } from '../conversation-lifecycle/storage-adapter.js';
import { LifecycleMigrationTransactions } from '../conversation-lifecycle/migration-storage.js';
import type { LifecycleSnapshotQuery, LifecycleMigrationCommand } from '../conversation-lifecycle/migration-contracts.js';
import type { LifecycleInspectWorkerParams, LifecycleCommitWorkerParams } from './internal.js';

const options = workerData as StorageOptions & { token: string };
const channel = parentPort!;
let database: SqlDatabase | undefined;
let releaseLock: (() => void) | undefined;
let files: ObjectFiles;
let recovery: { repaired: number; corrupt: number };
let providerTransactions: ProviderTransactions;
let configurationTransactions: ConfigurationTransactions;
let workspaceTransactions: WorkspaceTransactions;
let mediaTransactions: MediaTransactions;
let temporaryFees: TemporaryFeeTransactions;
let lifecycle: DurableConversationLifecycleAdapter;
let lifecycleMigration: LifecycleMigrationTransactions;

function fault(error: unknown, writing = false): AgentFault {
    if (error instanceof AgentFault) return error;
    const sqlite = error as { errcode?: number; code?: string };
    if (sqlite.errcode === 5 || sqlite.errcode === 6) {
        return new AgentFault('STORAGE_BUSY', '存储当前繁忙，本次事务未提交', { retryAfterMs: 2500 }, false, true);
    }
    return new AgentFault(writing ? 'STORAGE_DURABILITY_FAILED' : 'STORAGE_UNAVAILABLE',
        writing ? '持久存储事务未能可靠提交' : '持久存储操作失败', undefined, writing);
}

function metadata(value: unknown): string {
    const json = canonicalJson(value);
    if (Buffer.byteLength(json) > MAX_METADATA_BYTES) {
        throw new AgentFault('STORAGE_METADATA_LIMIT', '状态或回执元数据超过64KiB，请将正文放入内容对象');
    }
    return json;
}

const getRecordStatements = new WeakMap<SqlDatabase, ReturnType<SqlDatabase['prepare']>>();
const modelStepPairingStatements = new WeakMap<SqlDatabase, ReturnType<SqlDatabase['prepare']>>();

function getRecord(key: StoreKey): StoreRecord | undefined {
    const current = database!;
    let statement = getRecordStatements.get(current);
    if (!statement) {
        statement = current.prepare('SELECT revision,value_json FROM store_records WHERE record_key = ?');
        getRecordStatements.set(current, statement);
    }
    const row = statement.get(storeKey(key));
    return row ? { key, revision: Number(row.revision), value: JSON.parse(String(row.value_json)) as Record<string, unknown> } : undefined;
}

function readModelStepPairing(key: StoreKey) {
    const current = database!;
    let statement = modelStepPairingStatements.get(current);
    if (!statement) {
        statement = current.prepare("SELECT json_extract(value_json,'$.kind','$.complete','$.toolCalls','$.resolvedCallIds') AS pairing_json FROM store_records WHERE record_key = ?");
        modelStepPairingStatements.set(current, statement);
    }
    const row = statement.get(storeKey(key));
    if (!row) return 'incomplete';
    const [kind, complete, toolCalls, resolvedCallIds] = JSON.parse(String(row.pairing_json)) as unknown[];
    return modelStepPairing({ kind, complete, toolCalls, resolvedCallIds });
}

function listRecords(query: StoreRecordQuery): StorePage<StoreRecord> {
    const limit = query.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new AgentFault('INVALID_PARAMS', '分页大小须为1至200');
    const scoped = query.conversationId !== undefined;
    const rows = scoped
        ? database!.prepare('SELECT record_key,revision,value_json FROM store_records WHERE kind = ? AND scope_id = ? AND record_key > ? ORDER BY record_key LIMIT ?')
            .all(query.kind, query.conversationId ?? '', query.cursor ?? '', limit + 1)
        : database!.prepare('SELECT record_key,revision,value_json FROM store_records WHERE kind = ? AND record_key > ? ORDER BY record_key LIMIT ?')
            .all(query.kind, query.cursor ?? '', limit + 1);
    const items: StoreRecord[] = [];
    let bytes = 0;
    for (const row of rows) {
        const tuple = JSON.parse(String(row.record_key)) as [string | null, StoreKey['kind'], string];
        const record: StoreRecord = { key: { conversationId: tuple[0], kind: tuple[1], id: tuple[2] },
            revision: Number(row.revision), value: JSON.parse(String(row.value_json)) as Record<string, unknown> };
        const size = Buffer.byteLength(canonicalJson(record));
        if (items.length >= limit || bytes + size > MAX_PAGE_BYTES) break;
        items.push(record);
        bytes += size;
    }
    if (rows.length && !items.length) throw new AgentFault('FRAME_TOO_LARGE', '首条状态超过分页字节预算');
    const hasMore = items.length < rows.length;
    return { items, hasMore, nextCursor: hasMore ? storeKey(items.at(-1)!.key) : null };
}

function getReceipt(key: ReceiptKey): StoredReceipt | undefined {
    receiptKey(key);
    if (key.serverScope && key.serverScope !== 'server') {
        throw new AgentFault('STORAGE_SCOPE_CONFLICT', '当前全局回执契约仅接受server作用域');
    }
    if (key.conversationId) {
        const row = database!.prepare('SELECT result_hash FROM receipts WHERE principal_id = ? AND client_id = ? AND cid = ? AND command_id = ?')
            .get(key.principalId, key.clientId, key.conversationId, key.clientCommandId);
        return row ? files.read(database!, String(row.result_hash)) as StoredReceipt : undefined;
    }
    const row = database!.prepare('SELECT result_json FROM server_receipts WHERE principal_id = ? AND client_id = ? AND command_id = ?')
        .get(key.principalId, key.clientId, key.clientCommandId);
    if (!row) return undefined;
    const receipt = JSON.parse(String(row.result_json)) as StoredReceipt;
    if (receipt.key.serverScope !== key.serverScope) {
        throw new AgentFault('STORAGE_SCOPE_CONFLICT', '全局回执作用域与当前存储契约冲突');
    }
    return receipt;
}

function readEvents(query: StoreEventQuery): StorePage<AgentEvent> {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 200
        || !Number.isInteger(query.maxBytes) || query.maxBytes < 1 || query.maxBytes > 512 * 1024
        || !/^(0|[1-9]\d*)$/.test(query.afterSeq) || BigInt(query.afterSeq) > 9223372036854775807n) {
        throw new AgentFault('INVALID_PARAMS', '事件分页参数无效');
    }
    const rows = database!.prepare('SELECT payload_hash FROM events WHERE cid = ? AND event_seq > ? ORDER BY event_seq LIMIT ?')
        .all(query.conversationId, BigInt(query.afterSeq), query.limit + 1);
    const items: AgentEvent[] = [];
    let bytes = 0;
    const byteLimit = Math.min(query.maxBytes, MAX_PAGE_BYTES);
    for (const row of rows) {
        const event = files.read(database!, String(row.payload_hash)) as AgentEvent;
        const size = Buffer.byteLength(canonicalJson(event));
        if (!items.length && size > byteLimit) throw new AgentFault('FRAME_TOO_LARGE', '首个事件超过当前maxBytes', { requiredBytes: size });
        if (items.length >= query.limit || bytes + size > byteLimit) break;
        items.push(event);
        bytes += size;
    }
    return { items, nextCursor: items.at(-1)?.eventSeq ?? query.afterSeq, hasMore: items.length < rows.length };
}

function projectConversation(record: StoreRecord): void {
    const policy = recordRetention(record.value);
    if (policy.mode === 'temporary') throw new AgentFault('TEMPORARY_BACKEND_UNSUPPORTED', '临时会话只能进入内存存储');
    if (record.key.conversationId !== record.key.id || record.value.conversationId !== record.key.id) {
        throw new AgentFault('INVALID_PARAMS', '会话记录身份不一致');
    }
    const retention = record.value.retention as Record<string, unknown>;
    recordRetentionOwnership(database!, record);
    const previous = database!.prepare('SELECT mode,ttl_ms,policy_rev,state FROM conversations WHERE cid = ?').get(record.key.id);
    if (previous && (previous.mode !== policy.mode || previous.ttl_ms !== (policy.ttlDurationMs ?? null))) {
        throw new AgentFault('RETENTION_TRANSITION_BUSY', '保存方式转换尚未接入，原保存策略保持不变');
    }
    if (previous && ['expiryPending', 'tombstoned', 'gcPending', 'deleted', 'purging'].includes(String(previous.state))) {
        throw new AgentFault('RETENTION_EXPIRED', '会话已经到期或正在清理');
    }
    database!.prepare('INSERT INTO conversations (cid,mode,ttl_ms,last_run_end,last_close,expires_at,active_runs,policy_rev,history_epoch,view_revision,run_epoch,state,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(cid) DO UPDATE SET last_run_end=excluded.last_run_end,last_close=excluded.last_close,expires_at=excluded.expires_at,active_runs=excluded.active_runs,policy_rev=excluded.policy_rev,history_epoch=excluded.history_epoch,view_revision=excluded.view_revision,run_epoch=excluded.run_epoch,state=excluded.state,version=excluded.version')
        .run(record.key.id, policy.mode, policy.ttlDurationMs ?? null,
            typeof retention.lastRunEnd === 'string' ? retention.lastRunEnd : null,
            typeof retention.lastClose === 'string' ? retention.lastClose : null,
            typeof retention.expiresAt === 'string' ? retention.expiresAt : null,
            Number(retention.activeRuns ?? 0), Number(record.value.policyRevision ?? 1),
            Number(record.value.historyEpoch ?? 1), Number(record.value.viewRevision ?? 0),
            Number(record.value.runEpoch ?? 0), String(record.value.state ?? 'open'), record.revision);
}

function projectRecord(record: StoreRecord, now: string): void {
    const json = metadata(record.value);
    if (record.key.kind === 'run') {
        const value = record.value;
        const existing = database!.prepare('SELECT state FROM runs WHERE run_id = ?').get(record.key.id);
        if (!existing || ['succeeded', 'failed', 'cancelled'].includes(String(existing.state))) {
            if (!['succeeded', 'failed', 'cancelled'].includes(String(value.state))) assertRunMayStart(database!, record.key.conversationId!, now);
        }
        database!.prepare('INSERT INTO runs (run_id,cid,root_run_id,parent_run_id,run_epoch,kind,state,phase,active_round_id,active_step_id,deadline_at,effect_state,cleanup_state,version,updated_at,snapshot_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET run_epoch=excluded.run_epoch,state=excluded.state,phase=excluded.phase,active_round_id=excluded.active_round_id,active_step_id=excluded.active_step_id,deadline_at=excluded.deadline_at,effect_state=excluded.effect_state,cleanup_state=excluded.cleanup_state,version=excluded.version,updated_at=excluded.updated_at,snapshot_json=excluded.snapshot_json')
            .run(record.key.id, record.key.conversationId, String(value.rootRunId ?? record.key.id),
                typeof value.parentRunId === 'string' ? value.parentRunId : null, Number(value.runEpoch),
                String(value.kind ?? 'task'), String(value.state), typeof value.phase === 'string' ? value.phase : null,
                typeof value.activeRoundId === 'string' ? value.activeRoundId : null,
                typeof value.activeStepId === 'string' ? value.activeStepId : null,
                typeof value.deadlineAt === 'string' ? value.deadlineAt : null,
                String(value.effectState ?? 'none'), String(value.cleanupState ?? 'not_needed'), record.revision,
                typeof value.updatedAt === 'string' ? value.updatedAt : now, json);
    } else if (record.key.conversationId && record.key.kind !== 'conversation') {
        database!.prepare('INSERT INTO state_items (cid,kind,state_id,version,state,content_hash,anchor_id,order_key) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(cid,kind,state_id) DO UPDATE SET version=excluded.version,state=excluded.state,content_hash=excluded.content_hash,anchor_id=excluded.anchor_id,order_key=excluded.order_key')
            .run(record.key.conversationId, record.key.kind, record.key.id, record.revision,
                String(record.value.state ?? 'ready'), null,
                typeof record.value.contentId === 'string' ? record.value.contentId : null,
                typeof record.value.order === 'number' ? record.value.order : null);
    } else if (!record.key.conversationId) {
        database!.prepare('INSERT INTO server_state (kind,id,revision,value_json) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json')
            .run(record.key.kind, record.key.id, record.revision, json);
    }
    database!.prepare('INSERT INTO store_records (record_key,scope_id,cid,kind,record_id,revision,value_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(record_key) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json')
        .run(storeKey(record.key), record.key.conversationId ?? '', record.key.conversationId,
            record.key.kind, record.key.id, record.revision, json);
}

function reference(conversationId: string, ownerKind: string, ownerId: string, slot: string, hash: string): void {
    database!.prepare('INSERT OR IGNORE INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id) VALUES (?,?,?,?,?,?)')
        .run(conversationId, ownerKind, ownerId, slot, 'object', hash);
}

function commitTransition(transition: StoreTransition): StoreCommitResult {
    if (!Array.isArray(transition.expected) || (transition.records?.length ?? 0) + (transition.contents?.length ?? 0)
        + (transition.events?.length ?? 0) + (transition.remove?.length ?? 0) > MAX_WRITE_BATCH) {
        throw new AgentFault('INVALID_PARAMS', '存储写入批次最多100项且必须提供版本前提');
    }
    if (transition.purgeConversationId) {
        if (transition.receipt || (transition.records?.length ?? 0) + (transition.contents?.length ?? 0) + (transition.events?.length ?? 0) + (transition.remove?.length ?? 0)) throw new AgentFault('INVALID_PARAMS', '持久限时清理须单独提交');
        for (const expected of transition.expected) if ((getRecord(expected.key)?.revision ?? null) !== expected.revision) throw new AgentFault('REVISION_CONFLICT', '清理前的存储状态版本已经变化');
        const result = purgeExpiredConversation(database!, transition.purgeConversationId, new Date().toISOString());
        if (result.state === 'deferred') throw new AgentFault('RETENTION_TRANSITION_BUSY', '所属任务或资源尚未确认清理', { reason: result.reason });
        collectRetentionGarbage(database!, options.dataDir, 100);
        return { replayed: false };
    }
    const writeIds = new Set<string>();
    for (const record of transition.records ?? []) if (record.key.conversationId) writeIds.add(record.key.conversationId);
    for (const content of transition.contents ?? []) writeIds.add(content.conversationId);
    for (const event of transition.events ?? []) writeIds.add(event.conversationId);
    for (const conversationId of writeIds) {
        const current = database!.prepare('SELECT state FROM conversations WHERE cid = ?').get(conversationId);
        if (current && ['deleted', 'purging', 'gcPending', 'expiryPending'].includes(String(current.state))) throw new AgentFault('RETENTION_EXPIRED', '会话已经到期或正在清理');
    }
    const replay = transition.receipt && getReceipt(transition.receipt.key);
    if (replay) {
        if (replay.operationHash !== transition.receipt!.operationHash) throw new AgentFault('COMMAND_CONFLICT', '同一命令ID已经用于不同参数');
        return { replayed: true, receipt: replay };
    }
    const prepared: PreparedObject[] = [];
    const contentObjects = new Map<string, PreparedObject>();
    const eventObjects = new Map<string, PreparedObject>();
    let receiptObject: PreparedObject | undefined;
    let segments: PreparedSegment[] = [];
    let transactionOpen = false;
    let committed = false;
    const now = new Date().toISOString();
    try {
        for (const record of transition.records ?? []) {
            const expected = transition.expected.find(entry => storeKey(entry.key) === storeKey(record.key));
            if (!expected || !Number.isSafeInteger(record.revision) || record.revision !== (expected.revision ?? 0) + 1) {
                throw new AgentFault('REVISION_CONFLICT', '每份状态写入须声明原版本并递增一次');
            }
            metadata(record.value);
        }
        for (const content of transition.contents ?? []) {
            const object = files.prepare(content.value, content.kind);
            prepared.push(object);
            const indexed = database!.prepare('SELECT object_hash,history_json FROM items WHERE cid = ? AND content_id = ? AND history_indexed = 1')
                .get(content.conversationId, content.contentId);
            if (indexed && indexed.object_hash !== object.hash) throw new AgentFault('INPUT_FROZEN', '已经进入历史的正文不可覆盖');
            if (content.indexHistory === true) {
                if (!content.history || !['raw', 'summary'].includes(content.history.view) || typeof content.history.effective !== 'boolean') {
                    throw new AgentFault('INVALID_PARAMS', '进入历史的内容必须有完整历史元数据');
                }
                if (indexed && indexed.history_json !== canonicalJson(content.history)) {
                    throw new AgentFault('COMMAND_CONFLICT', '同一历史内容不能改变来源元数据');
                }
            }
            contentObjects.set(JSON.stringify([content.conversationId, content.contentId]), object);
        }
        for (const event of transition.events ?? []) {
            metadata(event);
            const object = files.prepare(event, 'event');
            prepared.push(object);
            eventObjects.set(event.eventId, object);
        }
        if (transition.receipt) {
            receiptKey(transition.receipt.key);
            metadata(transition.receipt);
            if (transition.receipt.key.conversationId) {
                receiptObject = files.prepare(transition.receipt, 'receipt');
                prepared.push(receiptObject);
            }
        }
        const changedContents = (transition.contents ?? []).filter(content => {
            if (content.indexHistory !== true) return false;
            const existing = database!.prepare('SELECT item_id FROM items WHERE cid = ? AND content_id = ? AND history_indexed = 1')
                .get(content.conversationId, content.contentId);
            return !existing;
        }).map(content => ({ content, objectHash: contentObjects.get(JSON.stringify([content.conversationId, content.contentId]))!.hash }));
        segments = prepareSegments(database!, options.dataDir, changedContents);
        database!.exec('BEGIN IMMEDIATE');
        transactionOpen = true;
        if (transition.receipt) {
            const existing = getReceipt(transition.receipt.key);
            if (existing) {
                if (existing.operationHash !== transition.receipt.operationHash) throw new AgentFault('COMMAND_CONFLICT', '同一命令ID已经用于不同参数');
                database!.exec('ROLLBACK');
                transactionOpen = false;
                rollbackSegments(options.dataDir, segments);
                files.discardUncommitted(database!, prepared);
                return { replayed: true, receipt: existing };
            }
        }
        for (const expected of transition.expected) {
            const actual = getRecord(expected.key);
            if ((actual?.revision ?? null) !== expected.revision) throw new AgentFault('REVISION_CONFLICT', '存储状态版本已经变化',
                { key: expected.key, expectedRevision: expected.revision, currentRevision: actual?.revision ?? null });
        }
        for (const record of transition.records ?? []) {
            if (record.key.kind !== 'run' || ['succeeded', 'failed', 'cancelled'].includes(String(record.value.state))) continue;
            const existing = database!.prepare('SELECT run_id FROM runs WHERE run_id = ?').get(record.key.id);
            const existingConversation = database!.prepare('SELECT cid FROM conversations WHERE cid = ?').get(record.key.conversationId);
            if (!existing && existingConversation) assertRunMayStart(database!, record.key.conversationId!, now);
        }
        for (const record of transition.records ?? []) if (record.key.kind === 'conversation') projectConversation(record);
        for (const object of prepared) files.insert(database!, object);
        for (const key of transition.remove ?? []) {
            if (key.kind === 'conversation' || key.kind === 'run') throw new AgentFault('INVALID_PARAMS', '不可直接删除会话或执行来源');
            database!.prepare('DELETE FROM store_records WHERE record_key = ?').run(storeKey(key));
            if (key.conversationId) database!.prepare('DELETE FROM state_items WHERE cid = ? AND kind = ? AND state_id = ?')
                .run(key.conversationId, key.kind, key.id);
            else database!.prepare('DELETE FROM server_state WHERE kind = ? AND id = ?').run(key.kind, key.id);
        }
        for (const record of transition.records ?? []) projectRecord(record, now);
        commitSegments(database!, segments);
        for (const content of transition.contents ?? []) {
            const object = contentObjects.get(JSON.stringify([content.conversationId, content.contentId]))!;
            database!.prepare('INSERT INTO content_items (cid,content_id,kind,object_hash) VALUES (?,?,?,?) ON CONFLICT(cid,content_id) DO UPDATE SET kind=excluded.kind,object_hash=excluded.object_hash')
                .run(content.conversationId, content.contentId, content.kind, object.hash);
            database!.prepare('DELETE FROM refs WHERE cid = ? AND owner_kind = ? AND owner_id = ? AND slot = ?')
                .run(content.conversationId, 'content', content.contentId, 'value');
            reference(content.conversationId, 'content', content.contentId, 'value', object.hash);
        }
        for (const segment of segments) for (const frame of segment.frames) {
            reference(segment.conversationId, 'history', String(frame.seq), 'value', frame.objectHash);
        }
        for (const event of transition.events ?? []) {
            if (!/^[1-9]\d*$/.test(event.eventSeq) || BigInt(event.eventSeq) > 9223372036854775807n) throw new AgentFault('INVALID_PARAMS', '事件序号无效');
            const previous = database!.prepare('SELECT CAST(event_seq AS TEXT) AS seq FROM conversations WHERE cid = ?').get(event.conversationId);
            if (!previous || BigInt(event.eventSeq) !== BigInt(String(previous.seq)) + 1n) throw new AgentFault('REVISION_CONFLICT', '事件序号须连续递增');
            const object = eventObjects.get(event.eventId)!;
            database!.prepare('INSERT INTO events (cid,event_seq,event_id,type,payload_hash) VALUES (?,?,?,?,?)')
                .run(event.conversationId, BigInt(event.eventSeq), event.eventId, event.type, object.hash);
            database!.prepare('UPDATE conversations SET event_seq = ? WHERE cid = ?').run(BigInt(event.eventSeq), event.conversationId);
            reference(event.conversationId, 'event', event.eventId, 'payload', object.hash);
        }
        if (transition.receipt) {
            const receipt = transition.receipt;
            if (receipt.key.conversationId) {
                database!.prepare('INSERT INTO receipts (principal_id,client_id,cid,command_id,operation_hash,result_hash,state) VALUES (?,?,?,?,?,?,?)')
                    .run(receipt.key.principalId, receipt.key.clientId, receipt.key.conversationId,
                        receipt.key.clientCommandId, receipt.operationHash, receiptObject!.hash, 'committed');
                reference(receipt.key.conversationId, 'receipt', receiptKey(receipt.key), 'result', receiptObject!.hash);
            } else {
                database!.prepare('INSERT INTO server_receipts (principal_id,client_id,command_id,operation_hash,result_json) VALUES (?,?,?,?,?)')
                    .run(receipt.key.principalId, receipt.key.clientId, receipt.key.clientCommandId, receipt.operationHash, metadata(receipt));
            }
        }
        const affected = new Set((transition.records ?? []).map(record => record.key.conversationId).filter((value): value is string => Boolean(value)));
        for (const conversationId of affected) refreshRetention(database!, conversationId);
        database!.exec('COMMIT');
        transactionOpen = false;
        committed = true;
        return { replayed: false, ...(transition.receipt ? { receipt: transition.receipt } : {}) };
    } catch (error) {
        if (transactionOpen) {
            try { database!.exec('ROLLBACK'); transactionOpen = false; } catch {
                throw new AgentFault('STORAGE_COMMIT_UNKNOWN', '存储提交状态未知，请先查询原命令回执', undefined, true);
            }
        }
        if (!committed) {
            rollbackSegments(options.dataDir, segments);
            files.discardUncommitted(database!, prepared);
        }
        throw fault(error, true);
    }
}

function dispatch(request: WorkerRequest): unknown {
    switch (request.method) {
        case 'lifecycle.inspect': return lifecycle.inspect(request.params as LifecycleInspectWorkerParams);
        case 'lifecycle.commit': return lifecycle.commit(request.params as LifecycleCommitWorkerParams);
        case 'lifecycle.snapshot': return lifecycleMigration.snapshot(request.params as LifecycleSnapshotQuery);
        case 'lifecycle.migrate': return lifecycleMigration.execute(request.params as LifecycleMigrationCommand);
        case 'getRecord': return getRecord(request.params as StoreKey);
        case 'readModelStepPairings': {
            const query = request.params as ModelStepPairingQuery;
            validateModelStepPairingQuery(query);
            return query.stepIds.map(stepId => readModelStepPairing({ conversationId: query.conversationId, kind: 'step', id: stepId }));
        }
        case 'listRecords': return listRecords(request.params as StoreRecordQuery);
        case 'getReceipt': return getReceipt(request.params as ReceiptKey);
        case 'readContent': {
            const params = request.params as { conversationId: string; contentId: string };
            const row = database!.prepare('SELECT object_hash FROM content_items WHERE cid = ? AND content_id = ?').get(params.conversationId, params.contentId);
            return row ? files.read(database!, String(row.object_hash)) as JsonValue : undefined;
        }
        case 'readArtifact': {
            const params = request.params as ArtifactQuery;
            const row = database!.prepare('SELECT object_hash FROM content_items WHERE cid = ? AND content_id = ?')
                .get(params.conversationId, params.artifactId);
            if (!row) throw new AgentFault('NOT_FOUND', '找不到该会话内的正文引用');
            return { artifactId: params.artifactId,
                ...files.readSlice(database!, String(row.object_hash), params.offset, params.maxBytes) };
        }
        case 'readEvents': return readEvents(request.params as StoreEventQuery);
        case 'readHistory': return readHistory(database!, files, options.dataDir, request.params as HistoryQuery);
        case 'readHistoryMetadata': return readHistoryMetadata(database!, request.params as HistoryMetadataQuery);
        case 'accounting.execute': return providerTransactions.executeAccounting(request.params as AccountingCommand);
        case 'accounting.read': return providerTransactions.readAccounting((request.params as { rootBudgetId: string }).rootBudgetId);
        case 'provider.prepareAttempt': {
            const params = request.params as { attempt: ProviderAttempt; upperBound: UpperBound };
            return providerTransactions.prepareAttempt(params.attempt, params.upperBound);
        }
        case 'provider.commitResponse': {
            const params = request.params as { attempt: ProviderAttempt; response: NormalizedResponse };
            return providerTransactions.commitResponse(params.attempt, params.response);
        }
        case 'provider.recordFailure': {
            const params = request.params as { attempt: ProviderAttempt; failure: RecordedFailure };
            return providerTransactions.recordFailure(params.attempt, params.failure);
        }
        case 'provider.readAttempt': return providerTransactions.readAttempt((request.params as { attemptId: string }).attemptId);
        case 'profile.execute': return configurationTransactions.executeProfile(request.params as ProfileCommand);
        case 'profile.get': {
            const params = request.params as { profileId: string; revision?: number };
            return configurationTransactions.getProfile(params.profileId, params.revision);
        }
        case 'profile.list': return configurationTransactions.listProfiles();
        case 'secret.get': {
            const params = request.params as { credentialRef: string; generation: number };
            return configurationTransactions.getProtectedSecret(params.credentialRef, params.generation);
        }
        case 'secret.put': return configurationTransactions.putProtectedSecret(request.params as ProtectedSecret);
        case 'secret.revoke': {
            const params = request.params as { credentialRef: string; generation: number };
            return configurationTransactions.revokeProtectedSecret(params.credentialRef, params.generation);
        }
        case 'catalog.read': return configurationTransactions.readCatalog((request.params as { profileId: string }).profileId);
        case 'catalog.publish': {
            const params = request.params as { snapshot: CatalogSnapshot; expectedVersion: string | null };
            return configurationTransactions.publishCatalog(params.snapshot, params.expectedVersion);
        }
        case 'workspace.execute': return workspaceTransactions.execute(request.params as WorkspaceCommand);
        case 'workspace.read': return workspaceTransactions.read(request.params as WorkspaceQuery);
        case 'media.execute': return mediaTransactions.execute(request.params as MediaCommand);
        case 'media.query': return mediaTransactions.query(request.params as MediaQuery);
        case 'temporaryFee.execute': return temporaryFees.execute(request.params as TemporaryFeeCommand);
        case 'temporaryFee.read': return temporaryFees.read((request.params as { attemptId: string }).attemptId);
        case 'temporaryFee.hasConversationHolds': return temporaryFees.hasConversationHolds((request.params as { conversationId: string }).conversationId);
        case 'commitTransition': return commitTransition(request.params as StoreTransition);
        case 'scanRetention': {
            database!.exec('BEGIN IMMEDIATE');
            try {
                const result = scanExpired(database!, new Date().toISOString());
                database!.exec('COMMIT');
                return result;
            } catch (error) { database!.exec('ROLLBACK'); throw error; }
        }
        case 'sweepRetention': return sweepRetention(database!, options.dataDir, request.params as RetentionSweepOptions);
        case 'diagnostics': return { schemaVersion: STORAGE_SCHEMA_VERSION, recovery,
            legacyHistoryItems: Number(database!.prepare('SELECT COUNT(*) AS total FROM items WHERE history_indexed = 0').get()?.total ?? 0),
            journalMode: database!.prepare('PRAGMA journal_mode').get()?.journal_mode,
            foreignKeys: database!.prepare('PRAGMA foreign_keys').get()?.foreign_keys,
            synchronous: database!.prepare('PRAGMA synchronous').get()?.synchronous };
        case 'close': database!.close(); database = undefined; releaseLock?.(); releaseLock = undefined; return null;
        default: throw new AgentFault('METHOD_NOT_AVAILABLE', '存储方法不可用');
    }
}

try {
    const migrations = loadMigrations();
    mkdirSync(options.dataDir, { recursive: true });
    releaseLock = acquireStorageLock(options.dataDir, options.token);
    const catalogPath = join(options.dataDir, 'catalog.sqlite');
    const newDatabase = !existsSync(catalogPath);
    database = new DatabaseSync(catalogPath, { enableForeignKeyConstraints: true });
    validateDatabaseVersion(database, migrations, newDatabase);
    database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2500; PRAGMA temp_store=MEMORY;');
    migrateDatabase(database, migrations, newDatabase);
    files = new ObjectFiles(options.dataDir, options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES);
    lifecycle = new DurableConversationLifecycleAdapter({ database, files, dataDir: options.dataDir });
    lifecycleMigration = new LifecycleMigrationTransactions({ database, files, dataDir: options.dataDir });
    providerTransactions = new ProviderTransactions(database, files);
    configurationTransactions = new ConfigurationTransactions(database, files);
    workspaceTransactions = new WorkspaceTransactions(database, files);
    mediaTransactions = new MediaTransactions(database, files, new BinaryObjectFiles(options.dataDir, options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES));
    temporaryFees = new TemporaryFeeTransactions(database, (accounting, intent, upperBound) => {
        const reservation: ReservationInput = { rootBudgetId: intent.rootBudgetId, attemptId: intent.attemptId,
            actionId: intent.actionId, quotaScopeId: intent.quotaScopeId, financialIntentId: intent.financialIntentId, upperBound,
            ...(intent.foregroundCallFloor === 1 ? { foregroundCallFloor: 1 as const } : {}) };
        accounting.apply({ type: 'reserve', ...reservation });
    });
    temporaryFees.recover();
    recovery = recoverSegments(database, options.dataDir);
    channel.postMessage({ id: 0, ok: true, data: { schemaVersion: migrations.length } } satisfies WorkerResponse);
    channel.on('message', (request: WorkerRequest) => {
        try {
            const data = dispatch(request);
            channel.postMessage({ id: request.id, ok: true, data } satisfies WorkerResponse);
            if (request.method === 'close') channel.close();
        } catch (error) {
            channel.postMessage({ id: request.id, ok: false, error: fault(error,
                request.method === 'commitTransition' || request.method === 'temporaryFee.execute' || request.method === 'lifecycle.commit' || request.method === 'lifecycle.migrate').toJSON() } satisfies WorkerResponse);
        }
    });
} catch (error) {
    try { database?.close(); } finally { releaseLock?.(); }
    channel.postMessage({ id: 0, ok: false, error: fault(error).toJSON() } satisfies WorkerResponse);
    channel.close();
}
