import { createHash, randomUUID } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { DispatchJournalPort, PreparedDispatch, RecordedFailure } from '../providers/dispatch.js';
import type { NormalizedResponse, ProviderAttempt } from '../providers/types.js';
import type { UpperBound } from '../accounting/budget-ledger.js';
import { settlementForResponse } from '../accounting/settlement.js';
import { failureHasExecutionEvidence, failureUsageResponse, financialInputTokens, nextProviderUsageRevision, preserveKnownProviderCharges, settlementForFailure } from '../providers/failure-accounting.js';
import type { StorePort, StoreTransition } from './port.js';
import type { SqliteStore } from './sqlite.js';
import { SqliteAccountingPort, SqliteDispatchJournalPort } from './provider-journal.js';
import type { PersistedProviderAttempt } from './provider-journal.js';
import { sha256 } from './objects.js';
import { minimalUpperBound } from './temporary-finance.js';
import type { TemporaryFinancialIntent, TemporaryRunFence, TemporaryFeeSettlement } from './temporary-finance.js';
import { assertContextDispatchFence, contextCandidateKey, contextStateKey } from './context-transactions.js';
import type { ContextStateData, ContextCandidateData, ContextDispatchSnapshot } from './context-transactions.js';
import { TemporaryMemoryBudget, measureCanonicalJsonBytes } from '../media/temporary-budget.js';
import type { TemporaryBudgetAccount } from '../media/temporary-budget.js';
import { canonicalJsonByteChunks } from '../media/payload-codec.js';
import { lifecycleFrozen, lifecycleSnapshotHash, requireLifecycleSnapshotOwner } from '../conversation-lifecycle/migration-snapshots.js';
import type { LifecycleCapture, LifecycleProviderSnapshot, LifecycleStage } from '../conversation-lifecycle/migration-snapshots.js';

export interface AgentProviderStore {
    readonly persistent: SqliteStore;
    readonly temporary: StorePort;
    readonly temporaryMemoryBudget: TemporaryMemoryBudget;
    onTemporaryTransition(listener: (transition: StoreTransition) => Promise<void>): () => void;
    onClosing(listener: () => Promise<void>): () => void;
}

export interface AgentProviderPortsOptions {
    maxMemoryAttempts?: number;
}

interface MemoryAttempt {
    intent: TemporaryFinancialIntent;
    state: PersistedProviderAttempt['state'];
    attempt?: ProviderAttempt;
    upperBound?: UpperBound;
    attemptHash?: string;
    upperHash?: string;
    response?: NormalizedResponse;
    responseHash?: string;
    failure?: RecordedFailure;
    toolsAuthorized: boolean;
    lateResponse: boolean;
    memoryBytes: number;
    commitUncertain?: boolean;
    failureBytes?: number;
    responseUsageRevision?: number;
}

function ownValue<Value>(value: Value): Value {
    const copy = structuredClone(value);
    const freeze = (entry: unknown): void => {
        if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) return;
        for (const child of Object.values(entry)) freeze(child);
        Object.freeze(entry);
    };
    freeze(copy);
    return copy;
}

export class AgentDispatchJournalPort implements DispatchJournalPort {
    private readonly persistentJournal: SqliteDispatchJournalPort;
    private readonly accounting: SqliteAccountingPort;
    private readonly ownerInstanceId = randomUUID();
    private readonly attempts = new Map<string, MemoryAttempt>();
    private readonly fences = new Map<string, TemporaryRunFence>();
    private readonly pending = new Map<string, Promise<unknown>>();
    private readonly closedConversations = new Set<string>();
    private readonly maxAttempts: number;
    private readonly memoryBudget: TemporaryBudgetAccount;
    private closing = false;
    private hasFees = false;
    private readonly lifecycleFrozenIds = new Set<string>();
    private readonly lifecycleStages = new Set<() => void>();
    private readonly pendingConversations = new Map<string, string>();
    private readonly migratedDurableAttempts = new Map<string, { value: PersistedProviderAttempt; bytes: number }>();
    private readonly migratedFenceBytes = new Map<string, number>();

    constructor(readonly store: AgentProviderStore, readonly options: AgentProviderPortsOptions = {}) {
        this.persistentJournal = new SqliteDispatchJournalPort(store.persistent);
        this.accounting = new SqliteAccountingPort(store.persistent);
        this.memoryBudget = store.temporaryMemoryBudget.scope('provider-journal');
        this.maxAttempts = options.maxMemoryAttempts ?? 1024;
        if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 4096) {
            throw new AgentFault('INVALID_PARAMS', '临时费用内存尝试上限须为1至4096');
        }
        store.onTemporaryTransition(transition => this.afterTransition(transition));
        store.onClosing(() => this.close());
    }

    prepareAttempt(attempt: ProviderAttempt, upperBound: UpperBound): Promise<PreparedDispatch> {
        return this.serial<PreparedDispatch>(attempt.attemptId, attempt.snapshot.conversationId, async () => {
            this.assertOpen();
            const migrated = this.migratedDurableAttempts.get(attempt.attemptId)?.value;
            if (migrated) {
                if (migrated.attempt.snapshot.snapshotHash !== attempt.snapshot.snapshotHash) throw new AgentFault('E_ATTEMPT_CONFLICT', '原迁移尝试的冻结请求已经变化');
                if (migrated.state === 'committed' && migrated.response) return { status: 'committed', response: { ...migrated.response, canExecuteTools: false } };
                return { status: migrated.state === 'dispatching' ? 'already_dispatching' : migrated.state === 'committed' ? 'unknown' : migrated.state };
            }
            const existing = this.attempts.get(attempt.attemptId);
            if (existing) {
                if (!existing.attempt) return { status: 'unknown' };
                this.verifyAttempt(attempt);
                if (existing.attemptHash !== this.attemptIdentityHash(attempt)
                    || existing.upperHash !== this.hashCanonical(attempt.snapshot.conversationId, upperBound)) {
                    throw new AgentFault('E_ATTEMPT_CONFLICT', '同一临时尝试的冻结请求或费用上界已经变化');
                }
                if (existing.response && existing.state === 'committed') return { status: 'committed', response: { ...existing.response, canExecuteTools: false } };
                return { status: existing.state === 'dispatching' ? 'already_dispatching' : existing.state === 'committed' ? 'unknown' : existing.state };
            }
            const conversation = await this.store.temporary.getRecord({ conversationId: attempt.snapshot.conversationId,
                kind: 'conversation', id: attempt.snapshot.conversationId });
            if (!conversation) return this.persistentJournal.prepareAttempt(attempt, upperBound);
            this.verifyAttempt(attempt);
            await this.requireLive(attempt);
            if (this.attempts.size >= this.maxAttempts) throw new AgentFault('TEMPORARY_CONTENT_LIMIT', '当前实例的临时尝试记录已达到有界上限');
            const cleanUpper = minimalUpperBound(upperBound);
            const memoryBytes = this.measure(attempt) + this.measure(upperBound) + 4096;
            this.memoryBudget.reserve(attempt.snapshot.conversationId, memoryBytes);
            let entry: MemoryAttempt | undefined;
            try {
                const attemptHash = this.attemptIdentityHash(attempt);
                const upperHash = this.hashCanonical(attempt.snapshot.conversationId, upperBound);
                const ownedAttempt = ownValue(attempt);
                const ownedUpper = ownValue(upperBound);
                const fence = await this.ensureFence(attempt);
                await this.requireLive(attempt);
                const intent: TemporaryFinancialIntent = { ownerInstanceId: this.ownerInstanceId, financialIntentId: randomUUID(), dispatchNonce: randomUUID(),
                    profileId: attempt.snapshot.profile.profileId,
                    attemptId: attempt.attemptId, rootBudgetId: attempt.rootBudgetId, actionId: attempt.snapshot.actionId,
                    quotaScopeId: attempt.snapshot.profile.quotaScopeId, conversationId: attempt.snapshot.conversationId,
                    runId: attempt.snapshot.runId, runEpoch: attempt.snapshot.runEpoch, historyEpoch: attempt.snapshot.historyEpoch, fenceRevision: fence.revision,
                    ...(attempt.snapshot.compressionOriginReason === 'background' ? { foregroundCallFloor: 1 as const } : {}) };
                entry = { intent, state: 'dispatching', attempt: ownedAttempt, upperBound: ownedUpper,
                    attemptHash, upperHash,
                    toolsAuthorized: false, lateResponse: false, memoryBytes };
                this.attempts.set(attempt.attemptId, entry);
                this.hasFees = true;
                const prepared = await this.store.persistent.executeTemporaryFee({ type: 'prepare', intent, upperBound: cleanUpper });
                if (prepared.status !== 'send') {
                    entry.state = prepared.status === 'already_dispatching' ? 'dispatching'
                        : prepared.status === 'committed' ? 'committed' : prepared.status === 'updated' ? 'unknown' : prepared.status;
                    return { status: entry.state === 'committed' ? 'unknown' : entry.state === 'dispatching' ? 'already_dispatching' : entry.state };
                }
                if (!await this.live(attempt)) {
                    await this.store.persistent.executeTemporaryFee({ type: 'failure', failure: { intent, acceptance: 'not_sent', code: 'E_CANCELLED' } });
                    entry.state = 'rejected';
                    throw new AgentFault('RUN_STALE', '临时执行在发送权提交期间已经失效，请求未发送');
                }
                return { status: 'send' };
            } catch (error) {
                if (entry && error instanceof AgentFault && !error.mayHaveStarted
                    && error.details?.budgetReservationRejected === true && error.details.attemptId === attempt.attemptId
                    && error.details.rootBudgetId === attempt.rootBudgetId) {
                    this.attempts.delete(attempt.attemptId);
                    this.memoryBudget.release(attempt.snapshot.conversationId, memoryBytes);
                }
                else if (entry) { entry.state = 'unknown'; }
                else this.memoryBudget.release(attempt.snapshot.conversationId, memoryBytes);
                throw error;
            }
        });
    }

    commitResponse(attempt: ProviderAttempt, response: NormalizedResponse): Promise<{ canExecuteTools: boolean }> {
        return this.serial<{ canExecuteTools: boolean }>(attempt.attemptId, attempt.snapshot.conversationId, async () => {
            const migrated = this.migratedDurableAttempts.get(attempt.attemptId)?.value;
            if (migrated) {
                if (migrated.attempt.snapshot.snapshotHash !== attempt.snapshot.snapshotHash || !migrated.response
                    || lifecycleSnapshotHash(migrated.response) !== lifecycleSnapshotHash(response)) throw new AgentFault('E_ATTEMPT_STATE', '迁移的原持久尝试须沿原尝试查询恢复');
                return { canExecuteTools: false };
            }
            const entry = this.attempts.get(attempt.attemptId);
            if (!entry) {
                if (this.closing) throw new AgentFault('STORAGE_UNAVAILABLE', '临时Provider已经关闭');
                const temporary = await this.store.temporary.getRecord({ conversationId: attempt.snapshot.conversationId,
                    kind: 'conversation', id: attempt.snapshot.conversationId });
                if (temporary) throw new AgentFault('E_ATTEMPT_MISSING', '临时尝试尚未取得独立持久费用意图');
                return this.persistentJournal.commitResponse(attempt, response);
            }
            this.verifyEntry(entry, attempt);
            if (response.attemptId !== attempt.attemptId) throw new AgentFault('E_RESPONSE_IDENTITY', '临时响应与原尝试不一致');
            const maySave = !this.closing && !this.closedConversations.has(entry.intent.conversationId) && entry.attempt !== undefined;
            const responseHash = entry.responseHash || maySave ? this.hashCanonical(entry.intent.conversationId, response) : undefined;
            if (entry.responseHash) {
                if (entry.responseHash !== responseHash) throw new AgentFault('E_RESPONSE_CONFLICT', '原临时尝试已经返回不同响应');
                if (entry.state === 'committed') return { canExecuteTools: false };
            }
            const finance = await this.accounting.read(attempt.rootBudgetId);
            entry.responseUsageRevision ??= nextProviderUsageRevision(finance, attempt, response.providerResponseId);
            const calculated = preserveKnownProviderCharges(settlementForResponse({ attempt, response, currency: finance.budget.currency,
                usageRevision: entry.responseUsageRevision }), finance, attempt);
            const price = attempt.snapshot.pricingSnapshot ?? attempt.snapshot.price;
            const settlement: TemporaryFeeSettlement = { intent: entry.intent, usageRevision: calculated.usageRevision,
                providerExecutionId: calculated.providerExecutionId, complete: calculated.complete,
                ...(calculated.postResponseUpperBound ? { postResponseUpperBound: { ...calculated.postResponseUpperBound,
                    sourceRef: `sha256:${sha256(calculated.postResponseUpperBound.sourceRef)}`,
                    priceVersion: `sha256:${sha256(calculated.postResponseUpperBound.priceVersion)}` } } : {}),
                charges: calculated.charges.map(charge => ({ ...charge, usage: {
                    basis: charge.amountMicros === null ? 'incomplete' : charge.kind === 'calculated' ? 'frozen_price_reported_usage' : 'provider_reported_cost',
                    priceFingerprint: price ? this.hashCanonical(entry.intent.conversationId, price) : null,
                    sourceFingerprint: price ? sha256(price.sourceRef) : null,
                    inputTokens: financialInputTokens(response.usage), outputTokens: response.usage.outputTokens,
                    cacheReadTokens: response.usage.cacheReadTokens, cacheWriteTokens: response.usage.cacheWriteTokens,
                    reasoningTokens: response.usage.reasoningTokens } })) };
            const memoryBytes = maySave ? this.measure(response) : 0;
            let saved = Boolean(entry.response);
            if (!saved && maySave) {
                let reserved = false;
                try {
                    this.memoryBudget.reserve(entry.intent.conversationId, memoryBytes);
                    reserved = true;
                    entry.response = ownValue(response);
                    entry.memoryBytes += memoryBytes;
                    entry.responseHash = responseHash;
                    saved = true;
                } catch (error) {
                    if (entry.response) { entry.response = undefined; entry.responseHash = undefined; }
                    if (reserved) this.memoryBudget.release(entry.intent.conversationId, memoryBytes);
                    const fee = await this.store.persistent.executeTemporaryFee({ type: 'settle', settlement });
                    if (fee.status === 'committed') entry.state = 'committed';
                    throw error;
                }
            }
            let committed;
            try { committed = await this.store.persistent.executeTemporaryFee({ type: 'settle', settlement }); }
            catch (error) { entry.state = 'unknown'; entry.commitUncertain = true; throw error; }
            if (committed.status !== 'committed') throw new AgentFault('STORAGE_RESPONSE_INVALID', '临时费用提交回执无效');
            entry.state = 'committed';
            const memoryLive = await this.live(attempt);
            const authorized = saved && !entry.commitUncertain && !committed.replayed && committed.fenceLive && memoryLive
                && response.complete && response.canExecuteTools && response.toolCalls.length <= 128
                && new Set(response.toolCalls.map(call => call.callId)).size === response.toolCalls.length && !entry.toolsAuthorized;
            entry.toolsAuthorized = authorized;
            entry.lateResponse = !memoryLive || !committed.fenceLive;
            return { canExecuteTools: authorized };
        });
    }

    recordFailure(attempt: ProviderAttempt, failure: RecordedFailure): Promise<void> {
        return this.serial<void>(attempt.attemptId, attempt.snapshot.conversationId, async () => {
            const migrated = this.migratedDurableAttempts.get(attempt.attemptId)?.value;
            if (migrated) {
                if (migrated.attempt.snapshot.snapshotHash !== attempt.snapshot.snapshotHash || !migrated.failure
                    || lifecycleSnapshotHash(migrated.failure) !== lifecycleSnapshotHash(failure)) throw new AgentFault('E_ATTEMPT_STATE', '迁移的原持久失败须沿原尝试查询恢复');
                return;
            }
            const entry = this.attempts.get(attempt.attemptId);
            if (!entry) {
                if (this.closing) return;
                const temporary = await this.store.temporary.getRecord({ conversationId: attempt.snapshot.conversationId,
                    kind: 'conversation', id: attempt.snapshot.conversationId });
                if (temporary) throw new AgentFault('E_ATTEMPT_MISSING', '临时失败缺少独立费用意图');
                return this.persistentJournal.recordFailure(attempt, failure);
            }
            this.verifyEntry(entry, attempt);
            if (entry.state === 'committed') return;
            const observed = failureUsageResponse(attempt, failure);
            const finance = await this.accounting.read(attempt.rootBudgetId);
            const reservation = finance.reservations.find(item => item.attemptId === attempt.attemptId);
            const hasUsage = failureHasExecutionEvidence(failure) || Boolean(reservation?.chargeKeys.length);
            if (observed && reservation?.state !== 'settled') {
                const calculated = settlementForFailure(attempt, observed, finance);
                const price = attempt.snapshot.pricingSnapshot ?? attempt.snapshot.price;
                await this.accounting.execute({ type: 'settle', ...calculated, charges: calculated.charges.map(charge => ({ ...charge,
                    usage: { basis: charge.kind === 'provider_reported' ? 'provider_reported_cost' : 'incomplete',
                        priceFingerprint: price ? this.hashCanonical(entry.intent.conversationId, price) : null,
                        sourceFingerprint: charge.kind === 'provider_reported' ? sha256(canonicalJson({ protocol: attempt.snapshot.profile.protocol,
                            field: observed.usage.providerCostBasis?.field ?? 'provider_reported_cost' })) : price ? sha256(price.sourceRef) : null,
                        inputTokens: financialInputTokens(observed.usage), outputTokens: observed.usage.outputTokens,
                        cacheReadTokens: observed.usage.cacheReadTokens, cacheWriteTokens: observed.usage.cacheWriteTokens,
                        reasoningTokens: observed.usage.reasoningTokens } })) });
                entry.responseUsageRevision = undefined;
            }
            const code = /^E_[A-Z0-9_]{1,80}$/.test(failure.error.code) ? failure.error.code : 'E_TEMPORARY_PROVIDER_FAILURE';
            const result = reservation?.state === 'settled' ? { status: 'unknown' as const }
                : await this.store.persistent.executeTemporaryFee({ type: 'failure', failure: { intent: entry.intent,
                    acceptance: hasUsage ? 'unknown' : failure.acceptance, code } });
            entry.state = result.status === 'rejected' ? 'rejected' : result.status === 'committed' ? 'committed' : 'unknown';
            if (entry.attempt && !this.closing && !this.closedConversations.has(entry.intent.conversationId)) {
                const bytes = this.measure(failure);
                this.memoryBudget.reserve(entry.intent.conversationId, bytes);
                try {
                    const previousBytes = entry.failureBytes ?? 0;
                    entry.failure = ownValue(failure);
                    entry.memoryBytes += bytes - previousBytes;
                    entry.failureBytes = bytes;
                    if (previousBytes) this.memoryBudget.release(entry.intent.conversationId, previousBytes);
                } catch (error) { this.memoryBudget.release(entry.intent.conversationId, bytes); throw error; }
            }
        });
    }

    async readAttempt(attemptId: string): Promise<PersistedProviderAttempt | undefined> {
        const migrated = this.migratedDurableAttempts.get(attemptId);
        if (migrated) return ownValue({ ...migrated.value, ...(migrated.value.response ? { response: { ...migrated.value.response, canExecuteTools: false } } : {}) });
        const entry = this.attempts.get(attemptId);
        if (!entry) return this.persistentJournal.readAttempt(attemptId);
        if (!entry.attempt || !entry.upperBound) return undefined;
        return { state: entry.state, attempt: entry.attempt, upperBound: entry.upperBound,
            ...(entry.response ? { response: { ...entry.response, canExecuteTools: false } } : {}),
            ...(entry.failure ? { failure: entry.failure } : {}), toolsAuthorized: entry.toolsAuthorized, lateResponse: entry.lateResponse };
    }

    temporaryUsage(conversationId: string): { bytes: number; attempts: number; retainedBodies: number } {
        const entries = [...this.attempts.values()].filter(entry => entry.intent.conversationId === conversationId);
        const migrated = [...this.migratedDurableAttempts.values()].filter(entry => entry.value.attempt.snapshot.conversationId === conversationId);
        return { bytes: entries.reduce((total, entry) => total + entry.memoryBytes, 0) + migrated.reduce((total, entry) => total + entry.bytes, 0), attempts: entries.length + migrated.length,
            retainedBodies: entries.filter(entry => entry.attempt !== undefined || entry.response !== undefined || entry.failure !== undefined).length + migrated.length };
    }

    private assertOpen(): void {
        if (this.closing) throw new AgentFault('STORAGE_UNAVAILABLE', '临时Provider已经关闭');
    }

    private verifyEntry(entry: MemoryAttempt, attempt: ProviderAttempt): void {
        if (entry.intent.attemptId !== attempt.attemptId || entry.intent.rootBudgetId !== attempt.rootBudgetId
            || entry.intent.conversationId !== attempt.snapshot.conversationId || entry.intent.runId !== attempt.snapshot.runId
            || entry.intent.runEpoch !== attempt.snapshot.runEpoch
            || (entry.attemptHash && entry.attemptHash !== this.attemptIdentityHash(attempt))) {
            throw new AgentFault('E_ATTEMPT_CONFLICT', '临时尝试与已登记的内存意图不同');
        }
    }

    private async live(attempt: ProviderAttempt): Promise<boolean> {
        if (this.closing || this.closedConversations.has(attempt.snapshot.conversationId)) return false;
        const snapshot = attempt.snapshot as typeof attempt.snapshot & ContextDispatchSnapshot;
        const conversation = await this.store.temporary.getRecord({ conversationId: snapshot.conversationId, kind: 'conversation', id: snapshot.conversationId });
        const run = await this.store.temporary.getRecord({ conversationId: snapshot.conversationId, kind: 'run', id: snapshot.runId });
        if (!conversation || !run || conversation.value.state !== 'open' || run.value.state !== 'running'
            || Number(run.value.runEpoch) !== snapshot.runEpoch || Number(conversation.value.historyEpoch) !== snapshot.historyEpoch
            || conversation.value.activeRunId !== snapshot.runId
            || (conversation.value.retention as { mode?: string } | undefined)?.mode !== 'temporary') return false;
        if (snapshot.compressionGeneration !== undefined || snapshot.compressionCandidateId !== undefined) {
            const state = await this.store.temporary.getRecord<ContextStateData>(contextStateKey(snapshot.conversationId));
            const candidate = snapshot.compressionCandidateId ? await this.store.temporary.getRecord<ContextCandidateData>(contextCandidateKey(snapshot.conversationId, snapshot.compressionCandidateId)) : undefined;
            try { assertContextDispatchFence(state?.value, candidate?.value, snapshot); }
            catch (error) { if (error instanceof AgentFault) return false; throw error; }
        }
        return !this.closing && !this.closedConversations.has(snapshot.conversationId);
    }

    private async requireLive(attempt: ProviderAttempt): Promise<void> {
        if (!await this.live(attempt)) throw new AgentFault('RUN_STALE', '临时执行已经取消、关闭或切换代次');
    }

    private async ensureFence(attempt: ProviderAttempt): Promise<TemporaryRunFence> {
        const key = JSON.stringify([attempt.snapshot.conversationId, attempt.snapshot.runId]);
        const previous = this.fences.get(key);
        if (previous?.active && previous.runEpoch === attempt.snapshot.runEpoch && previous.historyEpoch === attempt.snapshot.historyEpoch) return previous;
        const fence: TemporaryRunFence = { ownerInstanceId: this.ownerInstanceId, conversationId: attempt.snapshot.conversationId,
            runId: attempt.snapshot.runId, runEpoch: attempt.snapshot.runEpoch, historyEpoch: attempt.snapshot.historyEpoch,
            active: true, revision: (previous?.revision ?? 0) + 1 };
        this.fences.set(key, fence);
        this.hasFees = true;
        await this.store.persistent.executeTemporaryFee({ type: 'fence', fence });
        return fence;
    }

    private dropBody(entry: MemoryAttempt): void {
        const bytes = entry.memoryBytes;
        entry.attempt = undefined; entry.upperBound = undefined; entry.attemptHash = undefined; entry.upperHash = undefined;
        entry.response = undefined; entry.responseHash = undefined; entry.failure = undefined; entry.failureBytes = undefined; entry.memoryBytes = 0;
        entry.toolsAuthorized = false;
        if (bytes) this.memoryBudget.release(entry.intent.conversationId, bytes);
    }

    private async afterTransition(transition: StoreTransition): Promise<void> {
        const closingIds = new Set<string>();
        if (transition.purgeConversationId) closingIds.add(transition.purgeConversationId);
        for (const record of transition.records ?? []) {
            if (record.key.kind === 'conversation' && record.value.state !== 'open') closingIds.add(record.key.id);
        }
        for (const conversationId of closingIds) {
            if (![...this.attempts.values()].some(entry => entry.intent.conversationId === conversationId)
                && ![...this.fences.values()].some(fence => fence.conversationId === conversationId)) continue;
            this.closedConversations.add(conversationId);
            for (const entry of this.attempts.values()) if (entry.intent.conversationId === conversationId) this.dropBody(entry);
        }
        const relevant = [...this.fences.values()].filter(fence => closingIds.has(fence.conversationId)
            || (transition.records ?? []).some(record => record.key.conversationId === fence.conversationId
                && (record.key.kind === 'conversation' || record.key.kind === 'run')));
        for (const previous of relevant) {
            const run = await this.store.temporary.getRecord({ conversationId: previous.conversationId, kind: 'run', id: previous.runId });
            const conversation = await this.store.temporary.getRecord({ conversationId: previous.conversationId, kind: 'conversation', id: previous.conversationId });
            const active = !closingIds.has(previous.conversationId) && run?.value.state === 'running' && conversation?.value.state === 'open'
                && conversation.value.activeRunId === previous.runId;
            const runEpoch = Math.max(previous.runEpoch, Number(run?.value.runEpoch ?? previous.runEpoch));
            const historyEpoch = Math.max(previous.historyEpoch, Number(conversation?.value.historyEpoch ?? previous.historyEpoch));
            if (active === previous.active && runEpoch === previous.runEpoch && historyEpoch === previous.historyEpoch) continue;
            const next = { ...previous, active, runEpoch, historyEpoch, revision: previous.revision + 1 };
            this.fences.set(JSON.stringify([previous.conversationId, previous.runId]), next);
            await this.store.persistent.executeTemporaryFee({ type: 'fence', fence: next });
        }
    }

    async close(): Promise<void> {
        if (this.closing) return;
        this.closing = true;
        for (const discard of this.lifecycleStages) discard();
        for (const entry of this.attempts.values()) this.dropBody(entry);
        for (const entry of this.migratedDurableAttempts.values()) this.memoryBudget.release(entry.value.attempt.snapshot.conversationId, entry.bytes);
        for (const [conversationId, bytes] of this.migratedFenceBytes) this.memoryBudget.release(conversationId, bytes);
        this.migratedFenceBytes.clear();
        this.migratedDurableAttempts.clear(); this.lifecycleFrozenIds.clear();
        if (this.hasFees) await this.store.persistent.executeTemporaryFee({ type: 'close_owner', ownerInstanceId: this.ownerInstanceId });
        this.attempts.clear(); this.fences.clear(); this.closedConversations.clear();
    }

    private serial<Value>(attemptId: string, conversationId: string, operation: () => Promise<Value>): Promise<Value> {
        if (this.lifecycleFrozenIds.has(conversationId)) return Promise.reject(lifecycleFrozen(conversationId));
        const result = (this.pending.get(attemptId) ?? Promise.resolve()).catch(() => undefined).then(operation);
        this.pending.set(attemptId, result);
        this.pendingConversations.set(attemptId, conversationId);
        const clear = () => { if (this.pending.get(attemptId) === result) { this.pending.delete(attemptId); this.pendingConversations.delete(attemptId); } };
        void result.then(clear, clear);
        return result;
    }

    async freezeConversationLifecycle(conversationId: string): Promise<() => void> {
        this.assertOpen();
        if (this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        this.lifecycleFrozenIds.add(conversationId);
        await Promise.allSettled([...this.pending].filter(([attemptId]) => this.pendingConversations.get(attemptId) === conversationId).map(([, pending]) => pending));
        return () => this.lifecycleFrozenIds.delete(conversationId);
    }

    captureConversationLifecycle(conversationId: string): LifecycleCapture<LifecycleProviderSnapshot> {
        this.assertOpen();
        if (!this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        const temporaryAttempts = [...this.attempts.values()].filter(entry => entry.intent.conversationId === conversationId);
        const durableAttempts = [...this.migratedDurableAttempts.values()].filter(entry => entry.value.attempt.snapshot.conversationId === conversationId).map(entry => entry.value);
        const fences = [...this.fences.values()].filter(entry => entry.conversationId === conversationId);
        const source = { schemaVersion: 1 as const, conversationId, temporaryAttempts, durableAttempts, fences, closed: this.closedConversations.has(conversationId) };
        const bytes = this.measure(source) * 3;
        this.memoryBudget.reserve(conversationId, bytes, 'scratch');
        let released = false;
        try { return { value: structuredClone(source), release: () => { if (!released) { released = true; this.memoryBudget.release(conversationId, bytes, 'scratch'); } } }; }
        catch (error) { this.memoryBudget.release(conversationId, bytes, 'scratch'); throw error; }
    }

    stageConversationLifecycle(snapshot: LifecycleProviderSnapshot): LifecycleStage {
        this.assertOpen();
        const conversationId = snapshot.conversationId;
        requireLifecycleSnapshotOwner(snapshot, conversationId);
        if (!this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        if ([...this.attempts.values()].some(entry => entry.intent.conversationId === conversationId)
            || [...this.migratedDurableAttempts.values()].some(entry => entry.value.attempt.snapshot.conversationId === conversationId)) throw new AgentFault('REVISION_CONFLICT', '临时Provider目标已有原尝试');
        const temporary = new Map<string, MemoryAttempt>(), durable = new Map<string, { value: PersistedProviderAttempt; bytes: number }>();
        let bytes = 0, settled = false;
        const discard = () => { if (!settled) { settled = true; this.lifecycleStages.delete(discard); this.memoryBudget.release(conversationId, bytes); } };
        try {
            if (this.attempts.size + snapshot.temporaryAttempts.length + this.migratedDurableAttempts.size + snapshot.durableAttempts.length > this.maxAttempts) throw new AgentFault('TEMPORARY_CONTENT_LIMIT', '迁移后Provider尝试数超过原工厂上限');
            for (const entry of snapshot.temporaryAttempts) {
                const attemptId = entry.intent.attemptId;
                if (entry.intent.conversationId !== conversationId || temporary.has(attemptId) || this.attempts.has(attemptId)
                    || this.migratedDurableAttempts.has(attemptId) || entry.attempt && entry.attempt.attemptId !== attemptId) throw new AgentFault('E_ATTEMPT_CONFLICT', '迁移的临时尝试ID或原归属不同');
                if (entry.attempt) this.verifyAttempt(entry.attempt);
                const held = Math.max(entry.memoryBytes, this.measure(entry));
                this.memoryBudget.reserve(conversationId, held); bytes += held;
                temporary.set(attemptId, { ...ownValue(entry), memoryBytes: held });
            }
            for (const value of snapshot.durableAttempts) {
                const attemptId = value.attempt.attemptId;
                if (value.attempt.snapshot.conversationId !== conversationId || temporary.has(attemptId) || durable.has(attemptId)
                    || this.attempts.has(attemptId) || this.migratedDurableAttempts.has(attemptId)) throw new AgentFault('E_ATTEMPT_CONFLICT', '迁移的原持久尝试ID或归属不同');
                this.verifyAttempt(value.attempt);
                const held = this.measure(value); this.memoryBudget.reserve(conversationId, held); bytes += held;
                durable.set(attemptId, { value: ownValue(value), bytes: held });
            }
            const fenceBytes = this.measure(snapshot.fences);
            this.memoryBudget.reserve(conversationId, fenceBytes); bytes += fenceBytes;
            const fences = snapshot.fences.map(fence => {
                if (fence.conversationId !== conversationId || fence.active) throw new AgentFault('RETENTION_TRANSITION_BUSY', '迁移的Provider原代次仍有活动执行');
                return ownValue(fence);
            });
            this.lifecycleStages.add(discard);
            return { discard, activate: () => {
                if (settled) return;
                settled = true; this.lifecycleStages.delete(discard);
                for (const [attemptId, entry] of temporary) this.attempts.set(attemptId, entry);
                for (const [attemptId, entry] of durable) this.migratedDurableAttempts.set(attemptId, entry);
                for (const fence of fences) this.fences.set(JSON.stringify([conversationId, fence.runId]), fence);
                this.migratedFenceBytes.set(conversationId, fenceBytes);
                if (snapshot.closed) this.closedConversations.add(conversationId); else this.closedConversations.delete(conversationId);
                if (temporary.size) this.hasFees = true;
            } };
        } catch (error) { discard(); throw error; }
    }

    releaseConversationLifecycle(conversationId: string): void {
        if (!this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        for (const [attemptId, entry] of this.attempts) if (entry.intent.conversationId === conversationId) { this.dropBody(entry); this.attempts.delete(attemptId); }
        for (const [attemptId, entry] of this.migratedDurableAttempts) if (entry.value.attempt.snapshot.conversationId === conversationId) {
            this.memoryBudget.release(conversationId, entry.bytes); this.migratedDurableAttempts.delete(attemptId);
        }
        for (const [key, fence] of this.fences) if (fence.conversationId === conversationId) this.fences.delete(key);
        const fenceBytes = this.migratedFenceBytes.get(conversationId) ?? 0;
        this.memoryBudget.release(conversationId, fenceBytes); this.migratedFenceBytes.delete(conversationId);
        this.closedConversations.delete(conversationId);
    }

    private measure(value: unknown): number {
        return measureCanonicalJsonBytes(value, { maxBytes: this.store.temporaryMemoryBudget.maxConversationBytes });
    }

    private attemptIdentityHash(attempt: ProviderAttempt): string {
        return this.hashCanonical(attempt.snapshot.conversationId, { attemptId: attempt.attemptId,
            rootBudgetId: attempt.rootBudgetId, snapshotHash: attempt.snapshot.snapshotHash, bodyHash: attempt.snapshot.bodyHash,
            idempotencyKey: attempt.idempotencyKey ?? null });
    }

    private hashCanonical(conversationId: string, value: unknown): string {
        const bytes = this.measure(value);
        const scratch = Math.min(512 * 1024, bytes * 3 + 256);
        this.memoryBudget.reserve(conversationId, scratch, 'scratch');
        try {
            const checksum = createHash('sha256');
            for (const chunk of canonicalJsonByteChunks(value, { maxBytes: bytes })) checksum.update(chunk);
            return checksum.digest('hex');
        } finally { this.memoryBudget.release(conversationId, scratch, 'scratch'); }
    }

    private verifyAttempt(attempt: ProviderAttempt): void {
        const { snapshotHash, ...fixed } = attempt.snapshot;
        const conversationId = attempt.snapshot.conversationId;
        const scratch = Math.min(512 * 1024, Buffer.byteLength(attempt.snapshot.body) * 3 + 256);
        this.memoryBudget.reserve(conversationId, scratch, 'scratch');
        let bodyHash: string;
        try {
            const checksum = createHash('sha256');
            for (let offset = 0; offset < attempt.snapshot.body.length;) {
                let end = Math.min(attempt.snapshot.body.length, offset + 16 * 1024);
                const code = attempt.snapshot.body.charCodeAt(end - 1);
                if (end < attempt.snapshot.body.length && code >= 0xd800 && code <= 0xdbff) end += 1;
                checksum.update(attempt.snapshot.body.slice(offset, end)); offset = end;
            }
            bodyHash = checksum.digest('hex');
        } finally { this.memoryBudget.release(conversationId, scratch, 'scratch'); }
        if (!attempt.attemptId || !attempt.rootBudgetId || bodyHash !== attempt.snapshot.bodyHash
            || this.hashCanonical(conversationId, fixed) !== snapshotHash
            || (attempt.snapshot.rootBudgetId !== undefined && attempt.snapshot.rootBudgetId !== attempt.rootBudgetId)) {
            throw new AgentFault('E_SNAPSHOT_MISMATCH', '临时请求的冻结身份或字节校验失败');
        }
    }
}

const providerPorts = new WeakMap<AgentProviderStore, { options: AgentProviderPortsOptions; accountingPort: SqliteAccountingPort; journal: AgentDispatchJournalPort }>();

export function createAgentProviderPorts(store: AgentProviderStore, options: AgentProviderPortsOptions = {}): {
    accountingPort: SqliteAccountingPort; journal: AgentDispatchJournalPort;
} {
    const previous = providerPorts.get(store);
    if (previous) {
        if (previous.options.maxMemoryAttempts !== options.maxMemoryAttempts) {
            throw new AgentFault('TEMPORARY_PROVIDER_CONFIG_CONFLICT', '同一存储实例的临时Provider内存预算配置已经确定');
        }
        return previous;
    }
    const created = { options, accountingPort: new SqliteAccountingPort(store.persistent), journal: new AgentDispatchJournalPort(store, options) };
    providerPorts.set(store, created);
    return created;
}
