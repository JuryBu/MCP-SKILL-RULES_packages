import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AgentFault, canonicalJson, operationHash } from '../protocol.js';
import type { JsonValue, RetainPolicy, RpcResult } from '../protocol.js';
import type { ConversationData } from '../runtime.js';
import type { ReceiptKey, StorePort, StoreRecord, StoredReceipt, TransitionExpected } from '../storage/port.js';
import { controlKey, requireControl } from '../controller.js';
import type { ControlLease } from '../controller.js';
import type { BranchInput, BranchPreview, PreviewBranchInput, ConversationLifecycleStoragePort, LifecycleCaller, LifecycleCommit, LifecycleFence,
    LifecycleInventory, PreviewRetentionInput, RetentionPreview, SetRetentionInput } from './contracts.js';
import { captureBranchHistory, lifecycleSignal } from './history.js';
import { branchConversation, convertedConversation, lifecycleBusinessValue, lifecycleFence, plainRetention, sameLifecycleFence } from './policy.js';
import { CONVERSATION_LIFECYCLE_RPC_METHOD_SPECS } from './rpc-signatures.js';

export interface ConversationLifecycleServiceOptions {
    store: StorePort;
    storage?: ConversationLifecycleStoragePort;
    authorizeRead?(caller: LifecycleCaller, params: Record<string, unknown>): Promise<unknown>;
    authorizeWrite(caller: LifecycleCaller, params: Record<string, unknown>): Promise<TransitionExpected | void>;
    requireIdle(conversation: StoreRecord<ConversationData>, caller: LifecycleCaller, purpose: 'branch' | 'retention'): Promise<void>;
    now?: () => number;
    previewSecret?: Uint8Array;
}

interface RetentionPreviewClaims {
    version: 1;
    principalId: string;
    target: RetainPolicy;
    source: Omit<LifecycleFence, 'revision'>;
    sourceStateHash: string;
    inventoryHash: string;
}

interface BranchPreviewClaims {
    version: 1;
    kind: 'branch';
    principalId: string;
    source: Omit<LifecycleFence, 'revision'>;
    sourceStateHash: string;
    inventoryHash: string;
    manifestHash: string;
    target: PreviewBranchInput;
}

type PreviewClaims = RetentionPreviewClaims | BranchPreviewClaims;

export function branchOperationHash(input: BranchInput): string {
    const { previewToken: _previewToken, ...business } = input;
    return operationHash('conversations.branch', business as unknown as Record<string, unknown>);
}

function commandKey(input: { conversationId: string; clientCommandId: string }, caller: LifecycleCaller): ReceiptKey {
    return { principalId: caller.principalId, clientId: caller.clientId, conversationId: input.conversationId,
        clientCommandId: input.clientCommandId };
}

function parsedInput<Expected>(method: keyof typeof CONVERSATION_LIFECYCLE_RPC_METHOD_SPECS, supplied: unknown): Expected {
    const parsed = CONVERSATION_LIFECYCLE_RPC_METHOD_SPECS[method].schema.safeParse(supplied);
    if (!parsed.success) throw new AgentFault('INVALID_PARAMS', '对话生命周期参数无效', {
        issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
    return parsed.data as Expected;
}

function storagePort(options: ConversationLifecycleServiceOptions): ConversationLifecycleStoragePort | undefined {
    const candidate = options.storage ?? options.store as StorePort & Partial<ConversationLifecycleStoragePort>;
    return typeof candidate.inspectConversationLifecycle === 'function' && typeof candidate.commitConversationLifecycle === 'function'
        ? candidate as ConversationLifecycleStoragePort : undefined;
}

export class ConversationLifecycleService {
    private readonly pending = new Map<string, Promise<unknown>>();
    private readonly previewSecret: Buffer;
    private readonly now: () => number;
    private closed = false;

    constructor(private readonly options: ConversationLifecycleServiceOptions) {
        this.now = options.now ?? Date.now;
        this.previewSecret = Buffer.from(options.previewSecret ?? randomBytes(32));
        if (this.previewSecret.length < 32) throw new AgentFault('INVALID_PARAMS', '生命周期预览签名需要至少32字节服务端秘密');
    }

    private serialized<Value>(conversationId: string, operation: () => Promise<Value>): Promise<Value> {
        if (this.closed) return Promise.reject(new AgentFault('INVALID_STATE', '对话生命周期服务已经关闭'));
        const previous = this.pending.get(conversationId) ?? Promise.resolve();
        const pending = previous.catch(() => undefined).then(operation);
        this.pending.set(conversationId, pending);
        void pending.finally(() => { if (this.pending.get(conversationId) === pending) this.pending.delete(conversationId); }).catch(() => undefined);
        return pending;
    }

    private backend(): ConversationLifecycleStoragePort {
        const backend = storagePort(this.options);
        if (!backend) throw new AgentFault('RETENTION_TRANSITION_BUSY', '完整原文、原件和费用根的原子迁移入口尚未接入，源会话保持原保存方式', {
            requiredMethods: ['inspectConversationLifecycle', 'commitConversationLifecycle'] });
        return backend;
    }

    private async authorize(caller: LifecycleCaller, params: Record<string, unknown>): Promise<TransitionExpected[]> {
        const granted = await this.options.authorizeWrite(caller, params);
        const key = controlKey(String(params.conversationId));
        if (granted) {
            if (canonicalJson(granted.key) !== canonicalJson(key) || !Number.isSafeInteger(granted.revision) || Number(granted.revision) < 1) {
                throw new AgentFault('CONTROL_REQUIRED', '生命周期写入需要原会话控制记录的明确版本');
            }
            return [{ key: { ...granted.key }, revision: granted.revision }];
        }
        const record = await this.options.store.getRecord<ControlLease>(key);
        requireControl(record, params, caller, this.now());
        return [{ key, revision: record!.revision }];
    }

    private async source(conversationId: string, caller: LifecycleCaller, purpose: 'branch' | 'retention'): Promise<StoreRecord<ConversationData>> {
        lifecycleSignal(caller.signal);
        const record = await this.options.store.getRecord<ConversationData>({ conversationId, kind: 'conversation', id: conversationId });
        if (!record || record.value.principalId !== caller.principalId) throw new AgentFault('NOT_FOUND', '找不到当前主体的源会话');
        const value = record.value;
        if (!['open', 'closed'].includes(value.state) || value.activeRunId || value.retention.activeRuns !== 0
            || !['released', 'not_needed'].includes(value.cleanupState) || value.workspaceQuiesce || value.lifecycleTransition) {
            throw new AgentFault('RETENTION_TRANSITION_BUSY', '源会话或恢复操作尚未空闲，源历史和保存方式保持不变');
        }
        if (value.retention.mode === 'ttl' && value.retention.expiresAt !== null && Date.parse(value.retention.expiresAt) <= this.now()) {
            throw new AgentFault('RETENTION_EXPIRED', '源会话已经到期，请先查原清理状态');
        }
        await this.options.requireIdle(record, caller, purpose);
        lifecycleSignal(caller.signal);
        return record;
    }

    private async inventory(source: StoreRecord<ConversationData>, caller: LifecycleCaller, purpose: 'branch' | 'retention', throughSeq?: number, targetRetention?: RetainPolicy): Promise<LifecycleInventory> {
        const fence = lifecycleFence(source);
        const inventory = await this.backend().inspectConversationLifecycle({ source: fence, ...(throughSeq !== undefined ? { throughSeq } : {}),
            ...(targetRetention ? { targetRetention } : {}) });
        if (!inventory.complete || inventory.schemaVersion !== 1 || !sameLifecycleFence(inventory.fence, fence)
            || !/^[a-f0-9]{64}$/.test(inventory.inventoryHash)
            || [inventory.totalBytes, inventory.contentCount, inventory.originalCount, inventory.retainedSharedObjects]
                .some(value => !Number.isSafeInteger(value) || value < 0)
            || !inventory.retentionRootConversationId || !Array.isArray(inventory.dependentConversationIds)
            || !Array.isArray(inventory.unknownAttemptIds) || !Array.isArray(inventory.activeResourceIds)) {
            throw new AgentFault('RETENTION_TRANSITION_BUSY', '存储尚未取得完整、同版本的原文与原件清单');
        }
        if (inventory.activeResourceIds.length) throw new AgentFault('RETENTION_TRANSITION_BUSY', '源会话仍有未释放的自有资源', { resourceIds: inventory.activeResourceIds });
        if (purpose === 'retention' && inventory.retentionRootConversationId !== source.value.conversationId) {
            throw new AgentFault('RETENTION_TRANSITION_BUSY', '派生会话的保存归属须从原根会话整体转换', { rootConversationId: inventory.retentionRootConversationId });
        }
        for (const conversationId of new Set(inventory.dependentConversationIds)) {
            if (conversationId === source.value.conversationId) continue;
            await this.source(conversationId, caller, purpose);
        }
        const current = await this.options.store.getRecord<ConversationData>(source.key);
        if (!current || !sameLifecycleFence(lifecycleFence(current), fence)) throw new AgentFault('E_HISTORY_CONFLICT', '核对原件清单期间源会话版本已变化');
        return inventory;
    }

    private sign(claims: PreviewClaims): string {
        const body = Buffer.from(canonicalJson(claims)).toString('base64url');
        return `${body}.${createHmac('sha256', this.previewSecret).update(body).digest('base64url')}`;
    }

    private confirm(token: string, expected: PreviewClaims, code = 'RETENTION_PREVIEW_STALE'): void {
        const parts = token.split('.');
        if (parts.length !== 2) throw new AgentFault(code, '确认需要当前服务生成的原预览');
        const signature = createHmac('sha256', this.previewSecret).update(parts[0]).digest();
        const supplied = Buffer.from(parts[1], 'base64url');
        if (signature.length !== supplied.length || !timingSafeEqual(signature, supplied)) throw new AgentFault(code, '原预览已失效，请重新预览实际范围');
        let claims: unknown;
        try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
        catch { throw new AgentFault(code, '原预览内容无效'); }
        if (canonicalJson(claims) !== canonicalJson(expected)) throw new AgentFault(code, '源版本、原件、费用事实或目标参数已变化，请重新预览');
    }

    private async replay(key: ReceiptKey, hash: string): Promise<RpcResult<JsonValue> | undefined> {
        const receipt = await this.options.store.getReceipt(key);
        if (!receipt) return undefined;
        if (receipt.operationHash !== hash) throw new AgentFault('COMMAND_CONFLICT', '同一命令ID已用于不同的生命周期操作');
        return receipt.result as RpcResult<JsonValue>;
    }

    private async coldLossReceipt(key: ReceiptKey): Promise<StoredReceipt | undefined> {
        const receipt = await this.options.store.getReceipt(key);
        const error = receipt?.result.error;
        if (!receipt || error?.code !== 'TEMPORARY_CONTENT_LOST' || canonicalJson(receipt.key) !== canonicalJson(key)
            || error.details?.conversationId !== key.conversationId || typeof error.details?.operationId !== 'string') return undefined;
        return receipt;
    }

    async readColdLossReceipt(conversationId: string, targetClientCommandId: string, caller: LifecycleCaller): Promise<RpcResult<JsonValue> | undefined> {
        lifecycleSignal(caller.signal);
        const receipt = await this.coldLossReceipt({ principalId: caller.principalId, clientId: caller.clientId, conversationId,
            clientCommandId: targetClientCommandId });
        return receipt ? { ok: true, data: { found: true, result: receipt.result as unknown as JsonValue } } : undefined;
    }

    private async apply(input: LifecycleCommit, caller: LifecycleCaller): Promise<RpcResult<JsonValue>> {
        lifecycleSignal(caller.signal);
        const outcome = await this.backend().commitConversationLifecycle(input);
        const receipt = outcome.receipt;
        if (!receipt || canonicalJson(receipt.key) !== canonicalJson(input.receipt.key)
            || receipt.operationHash !== input.receipt.operationHash || !receipt.result.ok) {
            throw new AgentFault('STORAGE_COMMIT_UNKNOWN', '生命周期提交尚无可核对的完整成功回执，请查原命令', { operationId: input.operationId }, true);
        }
        const target = await this.options.store.getRecord<ConversationData>(input.target.key);
        if (!target || canonicalJson(plainRetention(target.value.retention)) !== canonicalJson(plainRetention(input.target.value.retention))
            || target.value.conversationId !== input.target.value.conversationId) {
            throw new AgentFault('STORAGE_COMMIT_UNKNOWN', '回执后的实际会话路由或保存方式尚未确认，请查原命令', { operationId: input.operationId }, true);
        }
        return receipt.result as RpcResult<JsonValue>;
    }

    private async retentionState(input: PreviewRetentionInput, caller: LifecycleCaller) {
            const source = await this.source(input.conversationId, caller, 'retention');
            if (input.expectedPolicyRevision !== source.value.policyRevision) throw new AgentFault('RETENTION_POLICY_STALE', '保存策略版本已变化', { policyRevision: source.value.policyRevision });
            const from = plainRetention(source.value.retention), to = plainRetention(input);
            if (canonicalJson(from) === canonicalJson(to)) throw new AgentFault('RETENTION_UNCHANGED', '目标保存方式和TTL时长与当前相同');
            if (!this.options.store.capabilities.retentionModes.includes(to.mode) || to.mode !== 'temporary' && !this.options.store.capabilities.persistent) {
                throw new AgentFault('PERSISTENCE_UNAVAILABLE', '当前存储未提供目标保存方式');
            }
            const inventory = await this.inventory(source, caller, 'retention', undefined, to);
            if (to.mode === 'temporary' && inventory.totalBytes > this.options.store.capabilities.maxConversationBytes) {
                throw new AgentFault('TEMPORARY_CONTENT_LIMIT', '完整原件和恢复资料超过当前临时会话内存限额', {
                    requiredBytes: inventory.totalBytes, maxBytes: this.options.store.capabilities.maxConversationBytes });
            }
            const { revision: _recordRevision, ...sourceVersion } = lifecycleFence(source);
            const claims: RetentionPreviewClaims = { version: 1, principalId: caller.principalId,
                target: to, source: sourceVersion, sourceStateHash: createHash('sha256').update(canonicalJson(lifecycleBusinessValue(source.value))).digest('hex'),
                inventoryHash: inventory.inventoryHash };
            return { source, inventory, from, to, claims };
    }

    previewRetention(supplied: unknown, caller: LifecycleCaller): Promise<RpcResult<JsonValue>> {
        const input = parsedInput<PreviewRetentionInput>('conversations.previewRetention', supplied);
        return this.serialized(input.conversationId, async () => {
            lifecycleSignal(caller.signal);
            await this.options.authorizeRead?.(caller, supplied as Record<string, unknown>);
            const { source, inventory, from, to, claims } = await this.retentionState(input, caller);
                const preview: RetentionPreview = { preview: true, conversationId: input.conversationId,
                    source: lifecycleFence(source), from, to, previewToken: this.sign(claims), effects: {
                        contentCount: inventory.contentCount, originalCount: inventory.originalCount, bytes: inventory.totalBytes,
                        dependentConversationIds: [...inventory.dependentConversationIds], retainedSharedObjects: inventory.retainedSharedObjects,
                        unknownAttemptIds: [...inventory.unknownAttemptIds], durableSources: to.mode === 'temporary' ? 'remove_after_memory_verified' : 'preserve',
                        workspaceFiles: 'unchanged', ttlAnchor: to.mode === 'ttl' ? 'confirmation_time' : null } };
                return { ok: true, data: preview as unknown as JsonValue };
        });
    }

    setRetention(supplied: unknown, caller: LifecycleCaller): Promise<RpcResult<JsonValue>> {
        const input = parsedInput<SetRetentionInput>('conversations.setRetention', supplied);
        return this.serialized(input.conversationId, async () => {
            lifecycleSignal(caller.signal);
            const key = commandKey(input, caller);
            const hash = operationHash('conversations.setRetention', input as unknown as Record<string, unknown>);
            const coldLoss = await this.coldLossReceipt(key);
            if (coldLoss) {
                if (coldLoss.operationHash !== hash) throw new AgentFault('COMMAND_CONFLICT', '同一命令ID已用于不同的生命周期操作');
                return coldLoss.result as RpcResult<JsonValue>;
            }
            const expected = await this.authorize(caller, supplied as Record<string, unknown>);
            const replay = await this.replay(key, hash);
            if (replay) return replay;
            const resumed = await this.backend().resumeConversationLifecycle?.(key, hash);
            if (resumed?.receipt) {
                if (resumed.receipt.operationHash !== hash || canonicalJson(resumed.receipt.key) !== canonicalJson(key)) throw new AgentFault('STORAGE_COMMIT_UNKNOWN', '原迁移回执身份尚未确认', { operationId: input.clientCommandId }, true);
                return resumed.receipt.result as RpcResult<JsonValue>;
            }
            const { source, inventory, to, claims } = await this.retentionState(input, caller);
            this.confirm(input.previewToken, claims);
            const confirmedAt = new Date(this.now()).toISOString();
            const target = convertedConversation(source, to, confirmedAt);
            const result: RpcResult<JsonValue> = { ok: true, receiptId: randomUUID(), data: { conversationId: input.conversationId,
                mode: to.mode, retention: target.value.retention as unknown as JsonValue, policyRevision: target.value.policyRevision,
                revision: target.revision, cleanupState: 'released', workspaceFiles: 'unchanged', unknownAttemptIds: inventory.unknownAttemptIds } };
            const receipt: StoredReceipt = { key, operationHash: hash, result, createdAt: confirmedAt };
            return this.apply({ schemaVersion: 1, kind: 'retention', operationId: input.clientCommandId,
                source: lifecycleFence(source), inventoryHash: inventory.inventoryHash, expected, target, receipt, confirmedAt,
                removeDurableSources: to.mode === 'temporary', preserveFinancialFacts: true }, caller);
        });
    }

    private async branchState(input: PreviewBranchInput, caller: LifecycleCaller) {
        const source = await this.source(input.conversationId, caller, 'branch');
        if (input.expectedHistoryEpoch !== source.value.historyEpoch) throw new AgentFault('E_HISTORY_CONFLICT', '分支所选历史版本已变化');
        if (source.value.retention.mode === 'ttl' && input.ttlDurationMs === undefined) throw new AgentFault('RETENTION_DURATION_REQUIRED', 'TTL分支必须重新明确提供保存时长');
        this.backend();
        const manifest = await captureBranchHistory(this.options.store, source, input.roundId, caller.signal);
        const inventory = await this.inventory(source, caller, 'branch', manifest.throughSeq);
        const { revision: _revision, ...version } = lifecycleFence(source);
        const target: PreviewBranchInput = { conversationId: input.conversationId, roundId: input.roundId,
            expectedHistoryEpoch: input.expectedHistoryEpoch, writeRoots: [...input.writeRoots],
            ...(input.title !== undefined ? { title: input.title } : {}), ...(input.ttlDurationMs !== undefined ? { ttlDurationMs: input.ttlDurationMs } : {}) };
        const claims: BranchPreviewClaims = { version: 1, kind: 'branch', principalId: caller.principalId, source: version,
            sourceStateHash: createHash('sha256').update(canonicalJson(lifecycleBusinessValue(source.value))).digest('hex'),
            inventoryHash: inventory.inventoryHash, manifestHash: manifest.sourceHash, target };
        return { source, manifest, inventory, claims };
    }

    previewBranch(supplied: unknown, caller: LifecycleCaller): Promise<RpcResult<JsonValue>> {
        const input = parsedInput<PreviewBranchInput>('conversations.previewBranch', supplied);
        return this.serialized(input.conversationId, async () => {
            lifecycleSignal(caller.signal);
            await this.options.authorizeRead?.(caller, supplied as Record<string, unknown>);
            const { source, manifest, inventory, claims } = await this.branchState(input, caller);
            const preview: BranchPreview = { preview: true, conversationId: input.conversationId, source: lifecycleFence(source),
                roundId: manifest.selectedRoundId, roundNumber: manifest.selectedRoundNumber, throughSeq: manifest.throughSeq,
                historyManifestHash: manifest.sourceHash, historyItems: manifest.items.length,
                retention: { ...plainRetention(source.value.retention), ...(source.value.retention.mode === 'ttl' ? { ttlDurationMs: input.ttlDurationMs } : {}) },
                title: input.title ?? null, writeRoots: [...input.writeRoots], workspaceFiles: 'unchanged',
                contextPolicy: manifest.contextPolicy, unknownAttemptIds: [...inventory.unknownAttemptIds], previewToken: this.sign(claims) };
            return { ok: true, data: preview as unknown as JsonValue };
        });
    }

    branch(supplied: unknown, caller: LifecycleCaller): Promise<RpcResult<JsonValue>> {
        const input = parsedInput<BranchInput>('conversations.branch', supplied);
        return this.serialized(input.conversationId, async () => {
            lifecycleSignal(caller.signal);
            const key = commandKey(input, caller), hash = branchOperationHash(input);
            const replay = await this.replay(key, hash);
            if (replay) return replay;
            if (!input.previewToken) throw new AgentFault('PREVIEW_REQUIRED', '新分支需要同一来源和目标参数的只读预览令牌');
            const expected = await this.authorize(caller, supplied as Record<string, unknown>);
            const { source, manifest, inventory, claims } = await this.branchState(input, caller);
            this.confirm(input.previewToken, claims, 'BRANCH_PREVIEW_STALE');
            expected.push(...manifest.toolOutcomeProvenance?.expected ?? []);
            const createdAt = new Date(this.now()).toISOString();
            const target = branchConversation(source, { conversationId: randomUUID(), eventGeneration: randomUUID(), createdAt,
                title: input.title, ttlDurationMs: input.ttlDurationMs, writeRoots: input.writeRoots,
                appendSeq: manifest.items.length, sourceManifestHash: manifest.sourceHash, selectedRoundId: manifest.selectedRoundId });
            const result: RpcResult<JsonValue> = { ok: true, receiptId: randomUUID(), data: { conversationId: target.value.conversationId,
                sourceConversationId: input.conversationId, sourceHistoryEpoch: source.value.historyEpoch,
                roundId: manifest.selectedRoundId, roundNumber: manifest.selectedRoundNumber, throughSeq: manifest.throughSeq,
                historyManifestHash: manifest.sourceHash, historyItems: manifest.items.length, retention: target.value.retention as unknown as JsonValue,
                writeRoots: input.writeRoots, workspaceFiles: 'unchanged', contextPolicy: manifest.contextPolicy, unknownAttemptIds: inventory.unknownAttemptIds } };
            const receipt: StoredReceipt = { key, operationHash: hash, result, createdAt };
            return this.apply({ schemaVersion: 1, kind: 'branch', operationId: input.clientCommandId, source: lifecycleFence(source),
                inventoryHash: inventory.inventoryHash, expected, target, receipt, confirmedAt: createdAt, manifest,
                preserveSource: true, copyOriginals: true }, caller);
        });
    }

    hasActiveWork(): boolean { return this.pending.size > 0; }

    async close(): Promise<void> {
        this.closed = true;
        await Promise.allSettled([...this.pending.values()]);
        this.previewSecret.fill(0);
    }
}
