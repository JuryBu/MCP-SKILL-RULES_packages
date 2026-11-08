import { AgentFault, canonicalJson } from '../protocol.js';
import type { AgentEvent, JsonValue, RetainPolicy } from '../protocol.js';
import { MemoryStore } from './memory.js';
import { SqliteStore } from './sqlite.js';
import type { SqliteStateMutationPort } from './sqlite.js';
import { recordRetention } from './retention.js';
import type { ReceiptKey, StoredReceipt, StoreCapabilities, StoreCommitResult, StoreEventQuery,
    StoreKey, StorePage, StorePort, StoreRecord, StoreRecordQuery, StoreTransition, HistoryQuery, HistoryPage, HistoryMetadataQuery, HistoryMetadataResult,
    ArtifactQuery, ArtifactChunk, StateMutationPort, StateMutationScope,
    TemporaryMetadataUsage, TemporaryMetadataSweepOptions, TemporaryMetadataSweepResult } from './port.js';
import type { StorageOptions } from './internal.js';
import { MAX_PAGE_BYTES } from './internal.js';
import { storeKey, normalizeHistoryMetadataQuery } from './port.js';
import type { ModelStepPairing, ModelStepPairingQuery } from './port.js';
import { modelStepPairing, validateModelStepPairingQuery } from './model-step-pairing.js';
import type { MediaCommand, MediaQuery, MediaResult } from './media-port.js';
import { TemporaryMemoryBudget, measureCanonicalJsonBytes } from '../media/temporary-budget.js';
import type { TemporaryBudgetAccount } from '../media/temporary-budget.js';

export interface AgentStoreOptions extends StorageOptions {
    maxTemporaryBytes?: number;
    maxTemporaryTotalBytes?: number;
}

interface MixedCursor {
    version: 1;
    kind: string;
    conversationId?: string | null;
    phase: 'persistent' | 'temporary';
    cursor?: string;
}

function transitionConversationIds(transition: StoreTransition): Set<string> {
    const ids = new Set<string>();
    for (const record of transition.records ?? []) if (record.key.conversationId) ids.add(record.key.conversationId);
    for (const expected of transition.expected) if (expected.key.conversationId) ids.add(expected.key.conversationId);
    for (const key of transition.remove ?? []) if (key.conversationId) ids.add(key.conversationId);
    for (const content of transition.contents ?? []) ids.add(content.conversationId);
    for (const event of transition.events ?? []) ids.add(event.conversationId);
    if (transition.receipt?.key.conversationId) ids.add(transition.receipt.key.conversationId);
    if (transition.purgeConversationId) ids.add(transition.purgeConversationId);
    return ids;
}

export class AgentStore implements StorePort {
    readonly capabilities: StoreCapabilities = { persistent: true, retentionModes: ['temporary', 'ttl', 'archive'], maxConversationBytes: 64 * 1024 * 1024 };
    readonly persistent: SqliteStore;
    readonly temporary: MemoryStore;
    readonly temporaryMemoryBudget: TemporaryMemoryBudget;
    private serial: Promise<unknown> = Promise.resolve();
    private closed = false;
    private closing?: Promise<void>;
    private readonly temporaryListeners = new Set<(transition: StoreTransition) => Promise<void>>();
    private readonly closingListeners = new Set<() => Promise<void>>();
    private readonly temporaryConversationIds = new Set<string>();
    private readonly pendingTemporaryIds = new Map<string, number>();
    private readonly transitionMemoryBudget: TemporaryBudgetAccount;
    private readonly memoryStoreBudget: TemporaryBudgetAccount;

    constructor(options: AgentStoreOptions) {
        this.temporaryMemoryBudget = new TemporaryMemoryBudget({ maxConversationBytes: options.maxTemporaryBytes,
            maxTotalBytes: options.maxTemporaryTotalBytes });
        this.capabilities.maxConversationBytes = this.temporaryMemoryBudget.maxConversationBytes;
        this.transitionMemoryBudget = this.temporaryMemoryBudget.scope('store-transition');
        this.memoryStoreBudget = this.temporaryMemoryBudget.scope('memory-store');
        this.persistent = new SqliteStore(options);
        this.temporary = new MemoryStore({ maxConversationBytes: this.temporaryMemoryBudget.maxConversationBytes,
            temporaryBudget: this.memoryStoreBudget });
    }

    private assertOpen(): void {
        if (this.closed) throw new AgentFault('STORAGE_UNAVAILABLE', '会话存储已经关闭');
    }

    withConversationLifecycleMutation<Value>(operation: () => Promise<Value>): Promise<Value> {
        this.assertOpen();
        if (this.closing) return Promise.reject(new AgentFault('STORAGE_UNAVAILABLE', '会话存储正在关闭'));
        const pending = this.serial.then(operation);
        this.serial = pending.catch(() => undefined);
        return pending;
    }

    applyConversationLifecycleRoutes(conversationIds: string[], mode: RetainPolicy['mode']): void {
        for (const conversationId of conversationIds) {
            if (mode === 'temporary') this.temporaryConversationIds.add(conversationId);
            else this.temporaryConversationIds.delete(conversationId);
        }
    }

    temporaryMetadataUsage(): TemporaryMetadataUsage {
        this.assertOpen();
        return this.temporary.temporaryMetadataUsage();
    }

    collectTemporaryMetadata(options: TemporaryMetadataSweepOptions): Promise<TemporaryMetadataSweepResult> {
        return this.withConversationLifecycleMutation(async () => {
            const result = await this.temporary.collectTemporaryMetadata({ now: options.now, canCollect: async conversationId => {
                if (this.temporaryMemoryBudget.usage(conversationId).totalBytes !== this.memoryStoreBudget.usage(conversationId).totalBytes) return false;
                if (options.canCollect && !await options.canCollect(conversationId)) return false;
                return !await this.persistent.hasTemporaryFinancialHolds(conversationId);
            } });
            for (const conversationId of result.collectedConversationIds) this.temporaryConversationIds.delete(conversationId);
            return result;
        });
    }

    private async conversationStore(conversationId: string): Promise<StorePort> {
        const key: StoreKey = { conversationId, kind: 'conversation', id: conversationId };
        if (await this.temporary.getRecord(key)) return this.temporary;
        return this.persistent;
    }

    async getRecord<Value = Record<string, unknown>>(key: StoreKey): Promise<StoreRecord<Value> | undefined> {
        this.assertOpen();
        const memory = await this.temporary.getRecord<Value>(key);
        return memory ?? this.persistent.getRecord<Value>(key);
    }

    async readModelStepPairings(query: ModelStepPairingQuery): Promise<ModelStepPairing[]> {
        this.assertOpen();
        validateModelStepPairingQuery(query);
        const backend = await this.conversationStore(query.conversationId);
        if (backend.readModelStepPairings) return backend.readModelStepPairings(query);
        const pairings: ModelStepPairing[] = [];
        for (const stepId of query.stepIds) pairings.push(modelStepPairing((await backend.getRecord({ conversationId: query.conversationId, kind: 'step', id: stepId }))?.value));
        return pairings;
    }

    async listRecords<Value = Record<string, unknown>>(query: StoreRecordQuery): Promise<StorePage<StoreRecord<Value>>> {
        this.assertOpen();
        const limit = query.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new AgentFault('INVALID_PARAMS', '分页大小须为1至200');
        let cursor: MixedCursor = { version: 1, kind: query.kind, conversationId: query.conversationId, phase: 'persistent' };
        if (query.cursor) {
            try {
                cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as MixedCursor;
                if (cursor.version !== 1 || cursor.kind !== query.kind || cursor.conversationId !== query.conversationId
                    || !['persistent', 'temporary'].includes(cursor.phase) || (cursor.cursor !== undefined && typeof cursor.cursor !== 'string')) throw new Error('cursor');
            } catch { throw new AgentFault('STORAGE_CURSOR_STALE', '分页游标与当前查询不一致'); }
        }
        const items: StoreRecord<Value>[] = [];
        let bytes = 0;
        for (;;) {
            const backend = cursor.phase === 'persistent' ? this.persistent : this.temporary;
            const page = await backend.listRecords<Value>({ ...query, cursor: cursor.cursor, limit: Math.max(1, limit - items.length) });
            let position = cursor.cursor;
            for (const record of page.items) {
                const size = Buffer.byteLength(canonicalJson(record));
                if (!items.length && size > MAX_PAGE_BYTES) throw new AgentFault('FRAME_TOO_LARGE', '首条状态超过分页字节预算');
                if (items.length === limit || bytes + size > MAX_PAGE_BYTES) {
                    return { items, hasMore: true, nextCursor: encodeCursor({ ...cursor, cursor: position }) };
                }
                items.push(record);
                bytes += size;
                position = storeKey(record.key);
            }
            if (page.hasMore) return { items, hasMore: true, nextCursor: encodeCursor({ ...cursor, cursor: position }) };
            if (cursor.phase === 'temporary') return { items, hasMore: false, nextCursor: null };
            cursor = { ...cursor, phase: 'temporary', cursor: undefined };
        }
    }

    async getReceipt(key: ReceiptKey): Promise<StoredReceipt | undefined> {
        this.assertOpen();
        const memory = await this.temporary.getReceipt(key);
        return memory ?? this.persistent.getReceipt(key);
    }

    async readContent(conversationId: string, contentId: string): Promise<JsonValue | undefined> {
        this.assertOpen();
        return (await this.conversationStore(conversationId)).readContent(conversationId, contentId);
    }

    async readContextMediaContent(conversationId: string, contentId: string): Promise<JsonValue | undefined> {
        this.assertOpen();
        const store: StorePort = await this.conversationStore(conversationId);
        return store.readContextMediaContent ? store.readContextMediaContent(conversationId, contentId)
            : store.readContent(conversationId, contentId);
    }

    async readArtifact(query: ArtifactQuery): Promise<ArtifactChunk> {
        this.assertOpen();
        return (await this.conversationStore(query.conversationId)).readArtifact(query);
    }

    async readEvents(query: StoreEventQuery): Promise<StorePage<AgentEvent>> {
        this.assertOpen();
        return (await this.conversationStore(query.conversationId)).readEvents(query);
    }

    async readHistory(query: HistoryQuery): Promise<HistoryPage> {
        this.assertOpen();
        const backend = await this.conversationStore(query.conversationId);
        return backend.readHistory(query);
    }

    async readHistoryMetadata(input: HistoryMetadataQuery): Promise<HistoryMetadataResult> {
        this.assertOpen();
        const query = normalizeHistoryMetadataQuery(input);
        const backend = await this.conversationStore(query.conversationId);
        if (!backend.readHistoryMetadata) throw new AgentFault('STORAGE_UNAVAILABLE', '当前会话存储未提供来源元数据查询');
        return backend.readHistoryMetadata(query);
    }

    executeMedia(command: MediaCommand): Promise<MediaResult> {
        this.assertOpen();
        return this.persistent.executeMedia(command);
    }

    queryMedia(query: MediaQuery): Promise<MediaResult> {
        this.assertOpen();
        return this.persistent.queryMedia(query);
    }

    commitTransition(transition: StoreTransition): Promise<StoreCommitResult> {
        this.assertOpen();
        if (this.closing) throw new AgentFault('STORAGE_UNAVAILABLE', '会话存储正在关闭');
        return this.submitTransition(transition, false);
    }

    mutateState<Value>(scope: StateMutationScope, operation: (port: StateMutationPort) => Promise<Value>): Promise<Value> {
        this.assertOpen();
        if (this.closing) throw new AgentFault('STORAGE_UNAVAILABLE', '会话存储正在关闭');
        if (!scope || scope.conversationId !== null && (typeof scope.conversationId !== 'string' || !scope.conversationId)) {
            throw new AgentFault('INVALID_PARAMS', '短状态事务需要明确会话范围');
        }
        const conversationId = scope.conversationId;
        const pending = this.serial.then(async () => {
            const backend = conversationId ? await this.conversationStore(conversationId) : this.persistent;
            if (backend === this.persistent) return this.persistent.mutateState(scope, port => this.executeStateMutation(conversationId, operation, port));
            return this.executeStateMutation(conversationId, operation);
        });
        this.serial = pending.catch(() => undefined);
        return pending;
    }

    private async executeStateMutation<Value>(conversationId: string | null, operation: (port: StateMutationPort) => Promise<Value>,
        persistentPort?: SqliteStateMutationPort): Promise<Value> {
        let active = true;
        let reads = 0;
        let committed = false;
        let pendingCommit: Promise<StoreCommitResult> | undefined;
        const requireActive = () => {
            if (!active) throw new AgentFault('INVALID_STATE', '短状态事务已经结束');
        };
        const port: StateMutationPort = {
            getRecord: async <RecordValue = Record<string, unknown>>(key: StoreKey) => {
                requireActive();
                if (committed || ++reads > 16) throw new AgentFault('INVALID_STATE', '短状态事务只允许在提交前读取最多16条记录');
                if (key.conversationId !== conversationId) throw new AgentFault('INVALID_PARAMS', '短状态事务的状态读取超出声明范围');
                return (persistentPort ?? this).getRecord<RecordValue>(key);
            },
            commitTransition: transition => {
                requireActive();
                if (committed) throw new AgentFault('INVALID_STATE', '短状态事务只允许提交一次');
                const keys = [...transition.expected.map(item => item.key), ...(transition.records ?? []).map(item => item.key), ...(transition.remove ?? [])];
                if (transition.purgeConversationId || transition.retainReceiptKeys || keys.some(key => key.conversationId !== conversationId)
                    || [...transitionConversationIds(transition)].some(id => id !== conversationId)) {
                    throw new AgentFault('INVALID_PARAMS', '短状态事务只提交声明范围内的单次状态变更');
                }
                committed = true;
                pendingCommit = this.submitTransition(transition, true, persistentPort);
                void pendingCommit.catch(() => undefined);
                return pendingCommit;
            },
        };
        let result: Value | undefined;
        let rejected = false;
        let rejection: unknown;
        try { result = await operation(port); }
        catch (error) { rejected = true; rejection = error; }
        active = false;
        try { await pendingCommit; }
        catch (error) { if (!rejected) { rejected = true; rejection = error; } }
        if (rejected) throw rejection;
        return result as Value;
    }

    private submitTransition(transition: StoreTransition, withinMutation: boolean, persistentPort?: SqliteStateMutationPort): Promise<StoreCommitResult> {
        const temporaryIds = (transition.records ?? []).filter(record => record.key.kind === 'conversation'
            && recordRetention(record.value).mode === 'temporary').map(record => record.key.id);
        const temporaryId = temporaryIds[0] ?? [...transitionConversationIds(transition)].find(conversationId =>
            this.temporaryConversationIds.has(conversationId) || this.pendingTemporaryIds.has(conversationId));
        let scratchBytes = 0;
        let frozen: StoreTransition;
        try {
            if (temporaryId) {
                scratchBytes = measureCanonicalJsonBytes(transition, { maxBytes: this.temporaryMemoryBudget.maxTotalBytes });
                this.transitionMemoryBudget.reserve(temporaryId, scratchBytes, 'scratch');
            }
            try { frozen = structuredClone(transition); }
            catch (error) {
                if (temporaryId) this.transitionMemoryBudget.release(temporaryId, scratchBytes, 'scratch');
                throw error;
            }
        } catch (error) { return Promise.reject(error); }
        for (const conversationId of temporaryIds) this.pendingTemporaryIds.set(conversationId, (this.pendingTemporaryIds.get(conversationId) ?? 0) + 1);
        const commit = async () => {
            try {
                const result = await this.commit(frozen, persistentPort);
                for (const conversationId of temporaryIds) this.temporaryConversationIds.add(conversationId);
                return result;
            } finally {
                for (const conversationId of temporaryIds) {
                    const pending = (this.pendingTemporaryIds.get(conversationId) ?? 0) - 1;
                    if (pending > 0) this.pendingTemporaryIds.set(conversationId, pending); else this.pendingTemporaryIds.delete(conversationId);
                }
                if (temporaryId) this.transitionMemoryBudget.release(temporaryId, scratchBytes, 'scratch');
            }
        };
        const operation = withinMutation ? Promise.resolve().then(commit) : this.serial.then(commit);
        if (!withinMutation) this.serial = operation.catch(() => undefined);
        return operation;
    }

    private async commit(transition: StoreTransition, persistentPort?: SqliteStateMutationPort): Promise<StoreCommitResult> {
        if (transition.receipt) {
            const existing = await (persistentPort ?? this).getReceipt(transition.receipt.key);
            if (existing) {
                if (existing.operationHash !== transition.receipt.operationHash) throw new AgentFault('COMMAND_CONFLICT', '同一命令ID已经用于不同参数');
                return { replayed: true, receipt: existing };
            }
        }
        const records = new Map((transition.records ?? []).filter(record => record.key.kind === 'conversation')
            .map(record => [record.key.id, record]));
        const ids = transitionConversationIds(transition);
        const destinations = new Set<StorePort>();
        for (const conversationId of ids) {
            const replacement = records.get(conversationId);
            const existing = await (persistentPort ?? this).getRecord({ conversationId, kind: 'conversation', id: conversationId });
            if (replacement) {
                const mode = recordRetention(replacement.value).mode;
                if (existing && recordRetention(existing.value).mode !== mode) throw new AgentFault('RETENTION_TRANSITION_BUSY', '保存方式转换尚未接入，原会话保持原存储');
                destinations.add(mode === 'temporary' ? this.temporary : this.persistent);
            } else destinations.add(await this.conversationStore(conversationId));
        }
        if (destinations.size > 1) throw new AgentFault('STORAGE_TRANSITION_CROSS_MODE', '一次存储事务不能同时修改临时与持久会话');
        let destination = destinations.values().next().value as StorePort | undefined;
        if (!destination) {
            const temporaryKeys = await Promise.all(transition.expected.map(expected => this.temporary.getRecord(expected.key)));
            if (temporaryKeys.some(Boolean)) destination = this.temporary;
        }
        if (persistentPort && destination && destination !== this.persistent) throw new AgentFault('STORAGE_TRANSITION_CROSS_MODE', '短状态事务的保存方式已经变化');
        const result = await (destination === this.persistent || !destination ? persistentPort ?? this.persistent : destination).commitTransition(transition);
        if (destination === this.temporary && !result.replayed) {
            try { for (const listener of this.temporaryListeners) await listener(transition); }
            catch { throw new AgentFault('TEMPORARY_FENCE_UPDATE_UNKNOWN', '临时状态已更新，费用代次更新须先核对原回执', undefined, true); }
        }
        return result;
    }

    onTemporaryTransition(listener: (transition: StoreTransition) => Promise<void>): () => void {
        this.assertOpen();
        this.temporaryListeners.add(listener);
        return () => this.temporaryListeners.delete(listener);
    }

    onClosing(listener: () => Promise<void>): () => void {
        this.assertOpen();
        this.closingListeners.add(listener);
        return () => this.closingListeners.delete(listener);
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        if (this.closed) return Promise.resolve();
        this.closing = (async () => {
            await this.serial;
            this.closed = true;
            const failures: unknown[] = [];
            for (const listener of this.closingListeners) {
                try { await listener(); } catch (error) { failures.push(error); }
            }
            this.closingListeners.clear();
            this.temporaryListeners.clear();
            const results = await Promise.allSettled([this.temporary.close(), this.persistent.close()]);
            this.temporaryConversationIds.clear();
            this.pendingTemporaryIds.clear();
            for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
            if (failures.length) throw failures[0];
        })();
        return this.closing;
    }
}

function encodeCursor(cursor: MixedCursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export async function openAgentStore(options: AgentStoreOptions): Promise<AgentStore> {
    return new AgentStore(options);
}

export { SqliteStore } from './sqlite.js';
export { createSqliteProviderPorts, SqliteAccountingPort, SqliteDispatchJournalPort } from './provider-journal.js';
export { createAgentProviderPorts, AgentDispatchJournalPort } from './temporary-provider.js';
export type { AgentProviderPortsOptions } from './temporary-provider.js';
export { createSqliteConfigurationPorts, SqliteProfilePort, SqliteProtectedSecretPort, SqliteCatalogPort } from './configuration.js';
export { createSqliteWorkspacePorts } from './workspace-port.js';
export { createAgentPendingToolStore, AgentPendingToolStore } from './temporary-pending.js';
export { createAgentWorkspacePorts } from './temporary-workspace.js';
export { createStoreCompactionPort, StoreCompactionPort } from './context-port.js';
export { createSqliteMediaPort, SqliteMediaPort } from './media-port.js';
export type { StorePort } from './port.js';
export type { HistoryItem, HistoryQuery, HistoryPage } from './port.js';
