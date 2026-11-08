import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { AgentFault } from '../protocol.js';
import type { AgentError, AgentEvent, JsonValue } from '../protocol.js';
import type { ReceiptKey, StoredReceipt, StoreCapabilities, StoreCommitResult, StoreEventQuery,
    StoreKey, StorePage, StorePort, StoreRecord, StoreRecordQuery, StoreTransition, HistoryQuery, HistoryPage,
    ArtifactQuery, ArtifactChunk, StateMutationPort, StateMutationScope, HistoryMetadataQuery, HistoryMetadataResult } from './port.js';
import { DEFAULT_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES, normalizeHistoryMetadataQuery } from './port.js';
import type { RetentionSweepOptions, RetentionSweepResult } from './port.js';
import type { ModelStepPairing, ModelStepPairingQuery } from './port.js';
import { validateModelStepPairingQuery } from './model-step-pairing.js';
import { DEFAULT_MAX_OBJECT_BYTES, MAX_METADATA_BYTES } from './internal.js';
import type { StorageOptions, WorkerResponse } from './internal.js';
import type { LifecycleInspectWorkerParams, LifecycleInspectWorkerResult, LifecycleCommitWorkerParams, LifecycleCommitWorkerResult,
    LifecycleSnapshotQuery, LifecycleSnapshotResult, LifecycleMigrationCommand, LifecycleMigrationResult } from './internal.js';
import { releaseOwnedStorageLock } from './recovery.js';
import type { AccountingCommand, AccountingResult, BudgetView, UpperBound } from '../accounting/budget-ledger.js';
import type { PreparedDispatch, RecordedFailure } from '../providers/dispatch.js';
import type { NormalizedResponse, ProviderAttempt } from '../providers/types.js';
import type { PersistedProviderAttempt } from './provider-journal.js';
import type { ProfileCommand, ProfileResult } from '../profiles/profile-store.js';
import type { ProviderProfile } from '../providers/types.js';
import type { ProtectedSecret } from '../profiles/secret-vault.js';
import type { CatalogSnapshot } from '../models/catalog.js';
import type { WorkspaceCommand, WorkspaceMutationResult, WorkspaceQuery, WorkspaceReadResult } from './workspace-port.js';
import type { MediaCommand, MediaQuery, MediaResult } from './media-port.js';
import { requireMediaSlice } from '../media/validation.js';
import type { TemporaryFeeCommand, TemporaryFeeResult, TemporaryFinancialAttempt } from './temporary-finance.js';

interface PendingRequest {
    resolve(value: unknown): void;
    reject(error: Error): void;
    writing: boolean;
}

export type SqliteStateMutationPort = StateMutationPort & Pick<StorePort, 'getReceipt'>;

function fromWorker(error: AgentError): AgentFault {
    return new AgentFault(error.code, error.message, error.details, error.mayHaveStarted, error.retryable);
}

export class SqliteStore implements StorePort {
    readonly capabilities: StoreCapabilities = { persistent: true, retentionModes: ['archive', 'ttl'], maxConversationBytes: Number.MAX_SAFE_INTEGER };
    readonly dataDir: string;
    private readonly options: StorageOptions;
    private readonly lockToken = randomUUID();
    private worker?: Worker;
    private ready?: Promise<void>;
    private exited?: Promise<void>;
    private readonly pending = new Map<number, PendingRequest>();
    private nextRequestId = 1;
    private closing?: Promise<void>;
    private closed = false;
    private failed?: AgentFault;
    private catalogObserved = false;
    private mutationSerial: Promise<unknown> = Promise.resolve();
    private acceptedMutations = 0;

    constructor(options: StorageOptions) {
        if (!options.dataDir || typeof options.dataDir !== 'string') throw new TypeError('dataDir is required');
        const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
        if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1 || maxObjectBytes > 64 * 1024 * 1024) {
            throw new TypeError('maxObjectBytes must be between 1 and 64 MiB');
        }
        const maxPendingRequests = options.maxPendingRequests ?? 128;
        if (!Number.isSafeInteger(maxPendingRequests) || maxPendingRequests < 1 || maxPendingRequests > 1024) {
            throw new TypeError('maxPendingRequests must be between 1 and 1024');
        }
        this.dataDir = resolve(options.dataDir);
        this.options = { dataDir: this.dataDir, maxObjectBytes, maxPendingRequests };
        this.catalogObserved = existsSync(join(this.dataDir, 'catalog.sqlite'));
    }

    static async open(options: StorageOptions): Promise<SqliteStore> {
        const store = new SqliteStore(options);
        try { await store.start(); } catch (error) { await store.close(); throw error; }
        return store;
    }

    private assertOpen(accepted = false): void {
        if (this.closed || this.closing && !accepted) throw new AgentFault('STORAGE_UNAVAILABLE', '持久存储已经关闭');
        if (this.failed) throw this.failed;
    }

    private start(accepted = false): Promise<void> {
        if (this.ready) return this.ready;
        this.assertOpen(accepted);
        const workerUrl = new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url);
        const worker = new Worker(workerUrl, { workerData: { ...this.options, token: this.lockToken },
            resourceLimits: { maxYoungGenerationSizeMb: 16 } });
        this.worker = worker;
        this.exited = new Promise(resolveExit => worker.once('exit', () => {
            releaseOwnedStorageLock(this.dataDir, this.lockToken);
            resolveExit();
        }));
        this.ready = new Promise<void>((resolveReady, rejectReady) => {
            worker.on('message', (message: WorkerResponse) => {
                if (message.id === 0) {
                    this.catalogObserved ||= existsSync(join(this.dataDir, 'catalog.sqlite'));
                    if (message.ok) resolveReady();
                    else { this.failed = fromWorker(message.error); rejectReady(this.failed); }
                    return;
                }
                const pending = this.pending.get(message.id);
                if (!pending) return;
                this.pending.delete(message.id);
                if (message.ok) pending.resolve(message.data);
                else pending.reject(fromWorker(message.error));
            });
            const failed = (error?: Error | number) => {
                this.catalogObserved ||= existsSync(join(this.dataDir, 'catalog.sqlite'));
                const workerCode = typeof error === 'object' && error && 'code' in error ? String(error.code) : undefined;
                this.failed ??= new AgentFault('STORAGE_UNAVAILABLE', '存储执行单元已经退出', workerCode ? { workerCode } : undefined);
                rejectReady(this.failed);
                for (const request of this.pending.values()) request.reject(new AgentFault('STORAGE_COMMIT_UNKNOWN',
                    '存储执行单元失联，请先核对原命令回执', undefined, request.writing));
                this.pending.clear();
            };
            worker.once('error', failed);
            worker.once('exit', failed);
        });
        return this.ready;
    }

    private async request<Result>(method: string, params?: unknown, writing = false): Promise<Result> {
        if (writing) return this.enqueueMutation(() => this.requestDirect<Result>(method, params, true, true));
        return this.requestDirect<Result>(method, params);
    }

    private enqueueMutation<Value>(operation: () => Promise<Value>): Promise<Value> {
        this.assertOpen();
        if (this.pending.size + this.acceptedMutations >= this.options.maxPendingRequests!) {
            return Promise.reject(new AgentFault('STORAGE_BUSY', '存储请求队列已满，请稍后查询原状态', { retryAfterMs: 100 }, false, true));
        }
        this.acceptedMutations++;
        const pending = this.mutationSerial.then(async () => {
            try { return await operation(); }
            finally { this.acceptedMutations--; }
        });
        this.mutationSerial = pending.catch(() => undefined);
        return pending;
    }

    private async requestDirect<Result>(method: string, params?: unknown, writing = false, accepted = false): Promise<Result> {
        if (this.closed || this.closing && !accepted) this.assertOpen(accepted);
        const catalogExists = existsSync(join(this.dataDir, 'catalog.sqlite'));
        this.catalogObserved ||= catalogExists;
        if (!writing && (!this.worker || this.failed) && !this.catalogObserved && !catalogExists) {
            if (method === 'readModelStepPairings') return (params as ModelStepPairingQuery).stepIds.map(() => 'incomplete') as Result;
            if (method === 'listRecords') return { items: [], nextCursor: null, hasMore: false } as Result;
            if (method === 'readEvents') return { items: [], nextCursor: (params as StoreEventQuery).afterSeq, hasMore: false } as Result;
            if (method === 'readHistory' || method === 'readHistoryMetadata') throw new AgentFault('NOT_FOUND', '找不到历史所属会话');
            if (method === 'readArtifact') throw new AgentFault('NOT_FOUND', '找不到该会话内的正文引用');
            if (method === 'accounting.read') throw new AgentFault('BUDGET_REQUIRED', '必须先创建明确的根预算');
            if (method === 'accounting.usage') return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
                totalTokens: 0, costs: [], amountStatus: 'known', tokensStatus: 'known' } as Result;
            if (method === 'profile.get' || method === 'secret.get' || method === 'catalog.read') return null as Result;
            if (method === 'profile.list') return [] as Result;
            if (method === 'temporaryFee.read') return undefined as Result;
            if (method === 'temporaryFee.hasConversationHolds') return false as Result;
            if (method === 'media.query') {
                const query = params as MediaQuery;
                if (query.type === 'get') return { kind: 'artifact', artifact: null } as Result;
                if (query.type === 'list') return { kind: 'page', page: { items: [], nextCursor: null, hasMore: false } } as Result;
                throw new AgentFault('MEDIA_NOT_FOUND', '当前会话没有这份媒体原件');
            }
            if (method === 'accounting.execute' && (params as AccountingCommand).type === 'get_quota_limit') {
                return { quotaLimits: [], replayed: false } as Result;
            }
            if (method === 'workspace.read') {
                const query = params as WorkspaceQuery;
                if (query.type === 'change.get') return { kind: 'change', action: null } as Result;
                if (query.type === 'restore.get') return { kind: 'restore', plan: null } as Result;
                if (query.type === 'change.list' || query.type === 'recovery.list' || query.type === 'workspace.revision') {
                    throw new AgentFault('CONVERSATION_NOT_FOUND', '工作区所属持久会话不存在');
                }
                if (query.type === 'approval.snapshot') {
                    if (query.tickets.length + query.receipts.length > 64) {
                        throw new AgentFault('STORAGE_WORKSPACE_LIMIT', '批准快照一次最多64项');
                    }
                    if ([...query.tickets, ...query.receipts].some(key => !key || key.length > MAX_METADATA_BYTES)) {
                        throw new AgentFault('INVALID_PARAMS', '批准记录标识无效');
                    }
                    return { kind: 'approval_snapshot', entries: [
                        ...query.tickets.map(key => ({ kind: 'ticket', key, revision: null, value: null })),
                        ...query.receipts.map(key => ({ kind: 'receipt', key, revision: null, value: null })),
                    ] } as Result;
                }
            }
            if (method === 'diagnostics') return { schemaVersion: 0, unopened: true } as Result;
            return undefined as Result;
        }
        this.assertOpen(accepted);
        await this.start(accepted);
        this.assertOpen(accepted);
        if (this.pending.size + (accepted ? 0 : this.acceptedMutations) >= this.options.maxPendingRequests!) {
            throw new AgentFault('STORAGE_BUSY', '存储请求队列已满，请稍后查询原状态', { retryAfterMs: 100 }, false, true);
        }
        const id = this.nextRequestId++;
        return new Promise<Result>((resolveRequest, reject) => {
            this.pending.set(id, { resolve: value => resolveRequest(value as Result), reject, writing });
            try { this.worker!.postMessage({ id, method, params }); } catch {
                this.pending.delete(id);
                reject(new AgentFault('STORAGE_UNAVAILABLE', '存储请求未能交给执行单元', undefined, false));
            }
        });
    }

    getRecord<Value = Record<string, unknown>>(key: StoreKey): Promise<StoreRecord<Value> | undefined> {
        return this.request('getRecord', key);
    }

    readModelStepPairings(query: ModelStepPairingQuery): Promise<ModelStepPairing[]> {
        validateModelStepPairingQuery(query);
        return query.stepIds.length ? this.request('readModelStepPairings', query) : Promise.resolve([]);
    }

    listRecords<Value = Record<string, unknown>>(query: StoreRecordQuery): Promise<StorePage<StoreRecord<Value>>> {
        return this.request('listRecords', query);
    }

    getReceipt(key: ReceiptKey): Promise<StoredReceipt | undefined> {
        return this.request('getReceipt', key);
    }

    readContent(conversationId: string, contentId: string): Promise<JsonValue | undefined> {
        return this.request('readContent', { conversationId, contentId });
    }

    readContextMediaContent(conversationId: string, contentId: string): Promise<JsonValue | undefined> {
        return this.request('readContextMediaContent', { conversationId, contentId });
    }

    inspectConversationLifecycle(input: LifecycleInspectWorkerParams): Promise<LifecycleInspectWorkerResult> {
        return this.request('lifecycle.inspect', input);
    }

    commitConversationLifecycle(input: LifecycleCommitWorkerParams): Promise<LifecycleCommitWorkerResult> {
        return this.request('lifecycle.commit', input, true);
    }

    readConversationLifecycleSnapshot(input: LifecycleSnapshotQuery): Promise<LifecycleSnapshotResult> {
        return this.request('lifecycle.snapshot', input);
    }

    executeConversationLifecycleMigration(input: LifecycleMigrationCommand): Promise<LifecycleMigrationResult> {
        return this.request('lifecycle.migrate', input, true);
    }

    readArtifact(query: ArtifactQuery): Promise<ArtifactChunk> {
        this.assertOpen();
        const offset = query.offset ?? 0;
        const maxBytes = query.maxBytes ?? DEFAULT_ARTIFACT_BYTES;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes)
            || maxBytes < 1 || maxBytes > MAX_ARTIFACT_BYTES) {
            return Promise.reject(new AgentFault('INVALID_PARAMS', '原件分片参数无效', { maxBytes: MAX_ARTIFACT_BYTES }));
        }
        return this.request('readArtifact', { ...query, offset, maxBytes });
    }

    readEvents(query: StoreEventQuery): Promise<StorePage<AgentEvent>> {
        return this.request('readEvents', query);
    }

    readHistory(query: HistoryQuery): Promise<HistoryPage> {
        return this.request('readHistory', query);
    }

    async readHistoryMetadata(query: HistoryMetadataQuery): Promise<HistoryMetadataResult> {
        return this.request('readHistoryMetadata', normalizeHistoryMetadataQuery(query));
    }

    executeMedia(command: MediaCommand): Promise<MediaResult> {
        if (command.input.artifact.retention.mode === 'temporary') {
            return Promise.reject(new AgentFault('MEDIA_OWNER_INVALID', '临时媒体只允许使用当前会话的内存原件'));
        }
        return this.request('media.execute', command, true);
    }

    executeTemporaryFee(command: TemporaryFeeCommand): Promise<TemporaryFeeResult> {
        return this.request('temporaryFee.execute', command, true);
    }

    readTemporaryFeeAttempt(attemptId: string): Promise<TemporaryFinancialAttempt | undefined> {
        return this.request('temporaryFee.read', { attemptId });
    }

    hasTemporaryFinancialHolds(conversationId: string): Promise<boolean> {
        return this.request('temporaryFee.hasConversationHolds', { conversationId });
    }

    queryMedia(query: MediaQuery): Promise<MediaResult> {
        if (query.type === 'read') requireMediaSlice(query.query.offset, query.query.maxBytes);
        if (query.type === 'list') {
            const limit = query.limit ?? 50;
            const maxBytes = query.maxBytes ?? 256 * 1024;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(maxBytes)
                || maxBytes < 1 || maxBytes > 256 * 1024) {
                return Promise.reject(new AgentFault('INVALID_PARAMS', '媒体列表分页参数无效'));
            }
        }
        return this.request('media.query', query);
    }

    executeAccounting(command: AccountingCommand): Promise<AccountingResult> {
        return this.request('accounting.execute', command, command.type !== 'get_quota_limit');
    }

    readAccounting(rootBudgetId: string): Promise<BudgetView> {
        return this.request('accounting.read', { rootBudgetId });
    }

    readUsage(query: import('./usage.js').UsageQuery): Promise<import('./usage.js').UsageSummary> {
        return this.request('accounting.usage', query);
    }

    prepareProviderAttempt(attempt: ProviderAttempt, upperBound: UpperBound): Promise<PreparedDispatch> {
        return this.request('provider.prepareAttempt', { attempt, upperBound }, true);
    }

    commitProviderResponse(attempt: ProviderAttempt, response: NormalizedResponse): Promise<{ canExecuteTools: boolean }> {
        return this.request('provider.commitResponse', { attempt, response }, true);
    }

    recordProviderFailure(attempt: ProviderAttempt, failure: RecordedFailure): Promise<void> {
        return this.request('provider.recordFailure', { attempt, failure }, true);
    }

    readProviderAttempt(attemptId: string): Promise<PersistedProviderAttempt | undefined> {
        return this.request('provider.readAttempt', { attemptId });
    }

    executeProfile(command: ProfileCommand): Promise<ProfileResult> {
        return this.request('profile.execute', command, true);
    }

    getProfile(profileId: string, revision?: number): Promise<ProviderProfile | null> {
        return this.request('profile.get', { profileId, revision });
    }

    listProfiles(): Promise<ProviderProfile[]> { return this.request('profile.list'); }

    getProtectedSecret(credentialRef: string, generation: number): Promise<ProtectedSecret | null> {
        return this.request('secret.get', { credentialRef, generation });
    }

    putProtectedSecret(secret: ProtectedSecret): Promise<void> {
        return this.request('secret.put', secret, true);
    }

    revokeProtectedSecret(credentialRef: string, generation: number): Promise<void> {
        return this.request('secret.revoke', { credentialRef, generation }, true);
    }

    readCatalog(profileId: string): Promise<CatalogSnapshot | null> { return this.request('catalog.read', { profileId }); }

    publishCatalog(snapshot: CatalogSnapshot, expectedVersion: string | null): Promise<void> {
        return this.request('catalog.publish', { snapshot, expectedVersion }, true);
    }

    executeWorkspace(command: WorkspaceCommand): Promise<WorkspaceMutationResult> {
        return this.request('workspace.execute', command, true);
    }

    readWorkspace(query: WorkspaceQuery): Promise<WorkspaceReadResult> {
        return this.request('workspace.read', query);
    }

    commitTransition(transition: StoreTransition): Promise<StoreCommitResult> {
        return this.request('commitTransition', transition, true);
    }

    mutateState<Value>(scope: StateMutationScope, operation: (port: SqliteStateMutationPort) => Promise<Value>): Promise<Value> {
        if (!scope || scope.conversationId !== null && (typeof scope.conversationId !== 'string' || !scope.conversationId)) {
            throw new AgentFault('INVALID_PARAMS', '短状态事务需要明确会话范围');
        }
        const conversationId = scope.conversationId;
        return this.enqueueMutation(async () => {
            let active = true;
            let reads = 0;
            let committed = false;
            let pendingCommit: Promise<StoreCommitResult> | undefined;
            const requireRead = (owner: string | null) => {
                if (!active || committed || ++reads > 16) throw new AgentFault('INVALID_STATE', '短状态事务只允许在结束或提交前读取最多16条状态');
                if (owner !== conversationId) throw new AgentFault('INVALID_PARAMS', '短状态事务的状态读取超出声明范围');
            };
            const port: SqliteStateMutationPort = {
                getRecord: <RecordValue = Record<string, unknown>>(key: StoreKey) => {
                    requireRead(key.conversationId);
                    return this.requestDirect<StoreRecord<RecordValue> | undefined>('getRecord', key, false, true);
                },
                getReceipt: key => {
                    requireRead(key.conversationId ?? null);
                    return this.requestDirect<StoredReceipt | undefined>('getReceipt', key, false, true);
                },
                commitTransition: transition => {
                    if (!active || committed) throw new AgentFault('INVALID_STATE', '短状态事务只允许在结束前提交一次');
                    const keys = [...transition.expected.map(item => item.key), ...(transition.records ?? []).map(item => item.key), ...(transition.remove ?? [])];
                    if (transition.purgeConversationId || transition.retainReceiptKeys || keys.some(key => key.conversationId !== conversationId)
                        || (transition.contents ?? []).some(content => content.conversationId !== conversationId)
                        || (transition.events ?? []).some(event => event.conversationId !== conversationId)
                        || transition.receipt && (transition.receipt.key.conversationId ?? null) !== conversationId) {
                        throw new AgentFault('INVALID_PARAMS', '短状态事务只提交声明范围内的单次状态变更');
                    }
                    committed = true;
                    pendingCommit = this.requestDirect<StoreCommitResult>('commitTransition', transition, true, true);
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
        });
    }

    scanRetention(): Promise<{ conversationId: string; policyRevision: number; deferred: boolean }[]> {
        return this.request('scanRetention', undefined, true);
    }

    sweepRetention(options: RetentionSweepOptions = {}): Promise<RetentionSweepResult> {
        return this.request('sweepRetention', options, true);
    }

    diagnostics(): Promise<Record<string, unknown>> {
        return this.request('diagnostics');
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        if (this.closed) return Promise.resolve();
        this.closing = (async () => {
            try {
                await this.mutationSerial;
                if (this.ready) {
                    try { await this.ready; } catch { await this.exited; return; }
                    const id = this.nextRequestId++;
                    await new Promise<void>((resolveClose, reject) => {
                        this.pending.set(id, { resolve: () => resolveClose(), reject, writing: false });
                        this.worker!.postMessage({ id, method: 'close' });
                    });
                    await this.exited;
                }
            } finally { this.closed = true; }
        })();
        return this.closing;
    }
}

export type { StorageOptions } from './internal.js';
