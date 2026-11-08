import { randomUUID } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { AgentEvent } from '../protocol.js';
import type { AccountingCommand, AccountingResult, BudgetView, UpperBound } from '../accounting/budget-ledger.js';
import type { PreparedDispatch, RecordedFailure } from '../providers/dispatch.js';
import type { NormalizedResponse, ProviderAttempt, RequestSnapshot } from '../providers/types.js';
import type { SqlDatabase, SqlRow } from './internal.js';
import { AccountingTransactions } from './accounting.js';
import { ObjectFiles, sha256 } from './objects.js';
import type { PreparedObject } from './objects.js';
import type { PersistedProviderAttempt } from './provider-journal.js';
import type { StoredReceipt } from './port.js';
import { receiptKey, storeKey } from './port.js';
import { requireSqlContextDispatchFence } from './context-transactions.js';
import { settlementForResponse } from '../accounting/settlement.js';
import { failureHasExecutionEvidence, failureUsageResponse, nextProviderUsageRevision, preserveKnownProviderCharges, settlementForFailure } from '../providers/failure-accounting.js';
import { readUsageSummary } from './usage.js';
import type { UsageQuery, UsageSummary } from './usage.js';

interface JournalEvent {
    event: AgentEvent;
    eventObject: PreparedObject;
    receipt: StoredReceipt;
    receiptObject: PreparedObject;
    recordKey: string;
    previousRevision: number;
    valueJson: string;
}

export class ProviderTransactions {
    private readonly accounting: AccountingTransactions;
    constructor(private readonly database: SqlDatabase, private readonly files: ObjectFiles) {
        this.accounting = new AccountingTransactions(database);
    }

    executeAccounting(command: AccountingCommand): AccountingResult {
        if (command.type === 'get_quota_limit') return this.accounting.apply(command);
        return this.atomic([], () => this.accounting.apply(command));
    }

    readAccounting(rootBudgetId: string): BudgetView { return this.accounting.read(rootBudgetId); }

    readUsage(query: UsageQuery): UsageSummary { return readUsageSummary(this.database, query); }

    readAttempt(attemptId: string): PersistedProviderAttempt | undefined {
        const row = this.row(attemptId);
        if (!row) return undefined;
        const rawArtifact = row.raw_object_hash ? this.database.prepare(
            'SELECT content_items.content_id,objects.hash,objects.raw_bytes FROM content_items JOIN objects ON objects.hash = content_items.object_hash WHERE content_items.cid = ? AND content_items.content_id = ? AND objects.hash = ?')
            .get(this.attemptConversationId(row), `provider-raw:${attemptId}`, String(row.raw_object_hash)) : undefined;
        return { state: row.state as PersistedProviderAttempt['state'],
            attempt: this.files.read(this.database, String(row.attempt_object_hash)) as ProviderAttempt,
            upperBound: JSON.parse(String(row.upper_bound_json)) as UpperBound,
            ...(row.response_object_hash ? { response: { ...this.files.readProviderResponse(this.database, String(row.response_object_hash)) as NormalizedResponse, canExecuteTools: false } } : {}),
            ...(rawArtifact ? { rawResponseArtifact: { artifactId: String(rawArtifact.content_id),
                sha256: String(rawArtifact.hash), totalBytes: Number(rawArtifact.raw_bytes) } } : {}),
            ...(row.failure_object_hash ? { failure: this.files.readProviderFailure(this.database, String(row.failure_object_hash)) as RecordedFailure } : {}),
            toolsAuthorized: Number(row.tools_authorized) === 1, lateResponse: Number(row.late_response) === 1 };
    }

    prepareAttempt(attempt: ProviderAttempt, upperBound: UpperBound): PreparedDispatch {
        this.verifyAttempt(attempt);
        const intentHash = this.intentHash(attempt, upperBound);
        const previous = this.row(attempt.attemptId);
        if (previous) {
            if (previous.intent_hash !== intentHash) throw new AgentFault('E_ATTEMPT_CONFLICT', '同一尝试的冻结请求或费用上界已经变化');
            if (previous.state === 'committed') return { status: 'committed', response: {
                ...this.files.readProviderResponse(this.database, String(previous.response_object_hash)) as NormalizedResponse, canExecuteTools: false } };
            return { status: previous.state === 'dispatching' ? 'already_dispatching' : previous.state as 'unknown' | 'rejected' };
        }
        this.requireLiveRun(attempt.snapshot, true);
        const snapshot = this.files.prepare(attempt.snapshot, 'provider_snapshot');
        const savedAttempt = this.files.prepare(attempt, 'provider_attempt');
        const event = this.prepareEvent(attempt, 'provider.attempt_prepared', { attemptId: attempt.attemptId, rootBudgetId: attempt.rootBudgetId }, intentHash);
        return this.atomic([snapshot, savedAttempt, event.eventObject, event.receiptObject], () => {
            const run = this.requireLiveRun(attempt.snapshot, true)!;
            const existingReservation = this.database.prepare('SELECT state FROM reservations WHERE attempt_id = ?').get(attempt.attemptId);
            if (existingReservation && existingReservation.state !== 'reserved') {
                throw new AgentFault('E_ATTEMPT_STATE', '该尝试已有费用派发事实，不能再次取得发送权');
            }
            this.accounting.apply({ type: 'reserve', rootBudgetId: attempt.rootBudgetId, attemptId: attempt.attemptId,
                actionId: attempt.snapshot.actionId, quotaScopeId: attempt.snapshot.profile.quotaScopeId,
                snapshotHash: attempt.snapshot.snapshotHash, upperBound,
                ...(attempt.snapshot.compressionOriginReason === 'background' ? { foregroundCallFloor: 1 as const } : {}) });
            this.accounting.apply({ type: 'dispatch', attemptId: attempt.attemptId });
            this.database.prepare('INSERT OR IGNORE INTO provider_budget_bindings (root_budget_id,cid,root_run_id) VALUES (?,?,?)')
                .run(attempt.rootBudgetId, attempt.snapshot.conversationId, String(run.root_run_id));
            this.database.prepare('INSERT INTO attempts (attempt_id,action_id,cid,run_id,run_epoch,state,body_hash,snapshot_hash,reservation_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
                .run(attempt.attemptId, attempt.snapshot.actionId, attempt.snapshot.conversationId, attempt.snapshot.runId,
                    attempt.snapshot.runEpoch, 'dispatching', attempt.snapshot.bodyHash, attempt.snapshot.snapshotHash, attempt.attemptId, event.event.occurredAt);
            this.database.prepare('INSERT INTO provider_attempt_journal (attempt_id,root_budget_id,intent_hash,attempt_object_hash,snapshot_object_hash,upper_bound_json,state,dispatch_granted,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
                .run(attempt.attemptId, attempt.rootBudgetId, intentHash, savedAttempt.hash, snapshot.hash,
                    canonicalJson(upperBound), 'dispatching', 1, event.event.occurredAt);
            this.reference(attempt, 'snapshot', snapshot.hash);
            this.reference(attempt, 'attempt', savedAttempt.hash);
            this.commitEvent(event);
            return { status: 'send' as const };
        });
    }

    commitResponse(attempt: ProviderAttempt, response: NormalizedResponse): { canExecuteTools: boolean } {
        const row = this.requireAttempt(attempt);
        if (response.attemptId !== attempt.attemptId) throw new AgentFault('E_RESPONSE_IDENTITY', '响应与原尝试身份不一致');
        if (row.state === 'committed') {
            if (row.response_object_hash !== sha256(canonicalJson(response))) throw new AgentFault('E_RESPONSE_CONFLICT', '该尝试已经提交不同原生响应');
            return { canExecuteTools: false };
        }
        const raw = this.files.prepare(response.raw, 'provider_raw_response');
        this.atomic([raw], () => {
            const current = this.requireAttempt(attempt);
            if (current.raw_object_hash && current.raw_object_hash !== raw.hash) {
                throw new AgentFault('E_RESPONSE_CONFLICT', '该尝试已经保存不同的原生响应');
            }
            this.database.prepare('UPDATE provider_attempt_journal SET raw_object_hash = ?,updated_at = ? WHERE attempt_id = ?')
                .run(raw.hash, new Date().toISOString(), attempt.attemptId);
            this.database.prepare('INSERT INTO content_items (cid,content_id,kind,object_hash) VALUES (?,?,?,?) ON CONFLICT(cid,content_id) DO NOTHING')
                .run(attempt.snapshot.conversationId, `provider-raw:${attempt.attemptId}`, 'provider_raw_response', raw.hash);
            this.reference(attempt, 'raw', raw.hash);
        });
        const normalized = this.files.prepare(response, 'provider_response');
        const usage = this.files.prepare(response.usage, 'provider_usage');
        const tools = this.files.prepare(response.toolCalls, 'provider_tool_intents');
        const toolObjects = response.toolCalls.length <= 128 ? response.toolCalls.map(call => this.files.prepare(call, 'provider_tool_intent')) : [];
        const live = this.requireLiveRun(attempt.snapshot, false);
        const canExecuteTools = Boolean(live && response.complete && response.canExecuteTools && response.toolCalls.length <= 128
            && new Set(response.toolCalls.map(call => call.callId)).size === response.toolCalls.length);
        const event = this.prepareEvent(attempt, 'provider.response_committed', { attemptId: attempt.attemptId,
            canExecuteTools, lateResponse: !live, toolCallCount: response.toolCalls.length }, normalized.hash);
        return this.atomic([normalized, raw, usage, tools, ...toolObjects, event.eventObject, event.receiptObject], () => {
            const current = this.requireAttempt(attempt);
            if (current.state === 'committed') return { canExecuteTools: false };
            const actualLive = this.requireLiveRun(attempt.snapshot, false);
            const authorized = canExecuteTools && Boolean(actualLive);
            const finance = this.accounting.read(attempt.rootBudgetId);
            const settlement = preserveKnownProviderCharges(settlementForResponse({ attempt, response, currency: finance.budget.currency,
                usageRevision: nextProviderUsageRevision(finance, attempt, response.providerResponseId) }), finance, attempt);
            const pricingSnapshot = attempt.snapshot.pricingSnapshot ?? attempt.snapshot.price;
            this.accounting.apply({ type: 'settle', ...settlement, charges: settlement.charges.map(charge => ({ ...charge,
                usage: { settlement: charge.usage, priceSourceRef: pricingSnapshot?.sourceRef ?? null,
                    frozenAt: attempt.snapshot.frozenAt, snapshotHash: attempt.snapshot.snapshotHash,
                    basis: charge.kind === 'calculated' ? 'frozen_price_reported_usage' : 'provider_reported_cost' } })) });
            this.database.prepare('UPDATE attempts SET state = ?,provider_request_id = ?,response_id = ?,usage_hash = ?,updated_at = ? WHERE attempt_id = ?')
                .run('committed', response.providerRequestId, response.providerResponseId, usage.hash, event.event.occurredAt, attempt.attemptId);
            this.database.prepare('UPDATE provider_attempt_journal SET state = ?,response_object_hash = ?,raw_object_hash = ?,tools_authorized = ?,late_response = ?,updated_at = ? WHERE attempt_id = ?')
                .run('committed', normalized.hash, raw.hash, authorized ? 1 : 0, actualLive ? 0 : 1, event.event.occurredAt, attempt.attemptId);
            this.database.prepare('INSERT INTO provider_tool_batches (attempt_id,object_hash,call_count,state) VALUES (?,?,?,?)')
                .run(attempt.attemptId, tools.hash, response.toolCalls.length, authorized ? 'authorized' : 'blocked');
            for (let index = 0; index < toolObjects.length; index += 1) {
                this.database.prepare('INSERT INTO provider_tool_intents (attempt_id,tool_index,call_id,run_id,run_epoch,state,object_hash) VALUES (?,?,?,?,?,?,?)')
                    .run(attempt.attemptId, index, response.toolCalls[index].callId, attempt.snapshot.runId,
                        attempt.snapshot.runEpoch, authorized ? 'authorized' : 'blocked', toolObjects[index].hash);
                this.reference(attempt, `tool:${index}`, toolObjects[index].hash);
            }
            for (const [slot, object] of [['response', normalized], ['raw', raw], ['usage', usage], ['toolBatch', tools]] as const) this.reference(attempt, slot, object.hash);
            this.commitEvent(event);
            return { canExecuteTools: authorized };
        });
    }

    recordFailure(attempt: ProviderAttempt, failure: RecordedFailure): void {
        const row = this.requireAttempt(attempt);
        if (row.state === 'committed') return;
        const saved = this.files.prepare(failure, 'provider_failure');
        const observed = failureUsageResponse(attempt, failure);
        const finance = this.accounting.read(attempt.rootBudgetId);
        const reservation = finance.reservations.find(item => item.attemptId === attempt.attemptId);
        const rejected = !failureHasExecutionEvidence(failure) && !reservation?.chargeKeys.length
            && (failure.acceptance === 'not_sent' || failure.acceptance === 'rejected');
        const state = rejected ? 'rejected' : 'unknown';
        if (row.state === state && row.failure_object_hash === saved.hash) return;
        const observedUsage = observed ? this.files.prepare(observed.usage, 'provider_usage') : undefined;
        const event = this.prepareEvent(attempt, `provider.attempt_${state}`, { attemptId: attempt.attemptId,
            acceptance: observed ? 'accepted' : failure.acceptance, errorCode: failure.error.code }, saved.hash);
        this.atomic([saved, ...(observedUsage ? [observedUsage] : []), event.eventObject, event.receiptObject], () => {
            if (observed && reservation?.state !== 'settled') {
                const settlement = settlementForFailure(attempt, observed, finance);
                const price = attempt.snapshot.pricingSnapshot ?? attempt.snapshot.price;
                this.accounting.apply({ type: 'settle', ...settlement, charges: settlement.charges.map(charge => ({ ...charge,
                    usage: { settlement: charge.usage, priceSourceRef: price?.sourceRef ?? null, frozenAt: attempt.snapshot.frozenAt,
                        snapshotHash: attempt.snapshot.snapshotHash, basis: charge.kind === 'provider_reported' ? 'provider_reported_cost' : 'incomplete' } })) });
            }
            if (reservation?.state !== 'settled') this.accounting.apply(rejected ? { type: 'reject', attemptId: attempt.attemptId,
                acceptance: failure.acceptance as 'not_sent' | 'rejected', evidenceRef: `object:${saved.hash}` }
                : { type: 'unknown', attemptId: attempt.attemptId });
            if (failure.error.code === 'E_QUOTA') this.accounting.apply({ type: 'halt', rootBudgetId: attempt.rootBudgetId,
                reason: 'E_QUOTA', evidenceRef: `object:${saved.hash}` });
            this.database.prepare('UPDATE attempts SET state = ?,updated_at = ? WHERE attempt_id = ?').run(state, event.event.occurredAt, attempt.attemptId);
            this.database.prepare('UPDATE provider_attempt_journal SET state = ?,failure_object_hash = ?,updated_at = ? WHERE attempt_id = ?')
                .run(state, saved.hash, event.event.occurredAt, attempt.attemptId);
            this.reference(attempt, 'failure', saved.hash);
            if (observedUsage) {
                this.database.prepare('UPDATE attempts SET usage_hash = ?,response_id = COALESCE(?,response_id) WHERE attempt_id = ?')
                    .run(observedUsage.hash, observed!.providerResponseId, attempt.attemptId);
                this.reference(attempt, 'usage', observedUsage.hash);
            }
            this.commitEvent(event);
        });
    }

    private row(attemptId: string): SqlRow | undefined {
        return this.database.prepare('SELECT * FROM provider_attempt_journal WHERE attempt_id = ?').get(attemptId);
    }

    private attemptConversationId(row: SqlRow): string {
        const attempt = this.database.prepare('SELECT cid FROM attempts WHERE attempt_id = ?').get(String(row.attempt_id));
        return String(attempt?.cid ?? '');
    }

    private requireAttempt(attempt: ProviderAttempt): SqlRow {
        this.verifyAttempt(attempt);
        const row = this.row(attempt.attemptId);
        if (!row) throw new AgentFault('E_ATTEMPT_MISSING', '尝试尚未取得持久发送回执');
        const bound = JSON.parse(String(row.upper_bound_json)) as UpperBound;
        if (row.intent_hash !== this.intentHash(attempt, bound)) throw new AgentFault('E_ATTEMPT_CONFLICT', '尝试与持久冻结请求不一致');
        return row;
    }

    private intentHash(attempt: ProviderAttempt, upperBound: UpperBound): string {
        return sha256(canonicalJson({ attemptId: attempt.attemptId, rootBudgetId: attempt.rootBudgetId,
            snapshotHash: attempt.snapshot.snapshotHash, bodyHash: attempt.snapshot.bodyHash,
            idempotencyKey: attempt.idempotencyKey ?? null, upperBound }));
    }

    private verifyAttempt(attempt: ProviderAttempt): void {
        const { snapshotHash, ...fixed } = attempt.snapshot;
        if (!attempt.attemptId || !attempt.rootBudgetId || !attempt.snapshot.runId
            || attempt.snapshot.bodyHash !== sha256(attempt.snapshot.body) || snapshotHash !== sha256(canonicalJson(fixed))) {
            throw new AgentFault('E_SNAPSHOT_MISMATCH', '请求快照身份或字节哈希校验失败');
        }
    }

    private requireLiveRun(snapshot: RequestSnapshot, required: boolean): SqlRow | undefined {
        const run = this.database.prepare('SELECT runs.*,conversations.history_epoch FROM runs JOIN conversations ON conversations.cid = runs.cid WHERE run_id = ?')
            .get(snapshot.runId);
        const valid = run && run.cid === snapshot.conversationId && Number(run.run_epoch) === snapshot.runEpoch
            && run.state === 'running' && Number(run.history_epoch) === snapshot.historyEpoch;
        if (valid) {
            try { requireSqlContextDispatchFence(this.database, snapshot); }
            catch (error) {
                if (required || !(error instanceof AgentFault)) throw error;
                return undefined;
            }
            return run;
        }
        if (required) throw new AgentFault('RUN_STALE', '原执行已经结束、取消或切换代次，未授予发送权');
        return undefined;
    }

    private reference(attempt: ProviderAttempt, slot: string, hash: string): void {
        this.database.prepare('INSERT OR IGNORE INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id) VALUES (?,?,?,?,?,?)')
            .run(attempt.snapshot.conversationId, 'providerAttempt', attempt.attemptId, slot, 'object', hash);
    }

    private prepareEvent(attempt: ProviderAttempt, type: string, payload: Record<string, unknown>, operationHash: string): JournalEvent {
        const recordKey = storeKey({ conversationId: attempt.snapshot.conversationId, kind: 'conversation', id: attempt.snapshot.conversationId });
        const row = this.database.prepare('SELECT revision,value_json FROM store_records WHERE record_key = ?').get(recordKey);
        const sequence = this.database.prepare('SELECT CAST(event_seq AS TEXT) AS seq FROM conversations WHERE cid = ?').get(attempt.snapshot.conversationId);
        if (!row || !sequence) throw new AgentFault('CONVERSATION_NOT_FOUND', '尝试所属会话已不存在');
        const value = JSON.parse(String(row.value_json)) as Record<string, unknown>;
        const eventSeq = (BigInt(String(sequence.seq)) + 1n).toString();
        const occurredAt = new Date().toISOString();
        value.eventSeq = eventSeq;
        value.updatedAt = occurredAt;
        const event: AgentEvent = { schemaVersion: 1, eventId: randomUUID(), eventSeq,
            conversationId: attempt.snapshot.conversationId, runId: attempt.snapshot.runId,
            runEpoch: attempt.snapshot.runEpoch, occurredAt, type, payload };
        const receipt: StoredReceipt = { key: { principalId: 'sandbox-agent-provider', clientId: 'dispatch-journal',
            conversationId: attempt.snapshot.conversationId, clientCommandId: `${type}:${attempt.attemptId}:${operationHash}` },
            operationHash, result: { ok: true, data: payload }, createdAt: occurredAt };
        return { event, eventObject: this.files.prepare(event, 'event'), receipt,
            receiptObject: this.files.prepare(receipt, 'receipt'), recordKey,
            previousRevision: Number(row.revision), valueJson: canonicalJson(value) };
    }

    private commitEvent(context: JournalEvent): void {
        const changed = this.database.prepare('UPDATE store_records SET revision = ?,value_json = ? WHERE record_key = ? AND revision = ?')
            .run(context.previousRevision + 1, context.valueJson, context.recordKey, context.previousRevision);
        if (Number(changed.changes) !== 1) throw new AgentFault('REVISION_CONFLICT', '提交尝试时会话版本已经变化');
        this.database.prepare('UPDATE conversations SET event_seq = ?,version = ? WHERE cid = ?')
            .run(BigInt(context.event.eventSeq), context.previousRevision + 1, context.event.conversationId);
        this.database.prepare('INSERT INTO events (cid,event_seq,event_id,type,payload_hash) VALUES (?,?,?,?,?)')
            .run(context.event.conversationId, BigInt(context.event.eventSeq), context.event.eventId, context.event.type, context.eventObject.hash);
        const receipt = context.receipt;
        this.database.prepare('INSERT INTO receipts (cid,principal_id,client_id,command_id,operation_hash,result_hash,state) VALUES (?,?,?,?,?,?,?)')
            .run(receipt.key.conversationId!, receipt.key.principalId, receipt.key.clientId,
                receipt.key.clientCommandId, receipt.operationHash, context.receiptObject.hash, 'committed');
        this.database.prepare('INSERT INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id) VALUES (?,?,?,?,?,?)')
            .run(context.event.conversationId, 'event', context.event.eventId, 'payload', 'object', context.eventObject.hash);
        this.database.prepare('INSERT INTO refs (cid,owner_kind,owner_id,slot,target_kind,target_id) VALUES (?,?,?,?,?,?)')
            .run(context.event.conversationId, 'receipt', receiptKey(receipt.key), 'result', 'object', context.receiptObject.hash);
    }

    private atomic<Value>(objects: PreparedObject[], operation: () => Value): Value {
        let active = false;
        try {
            this.database.exec('BEGIN IMMEDIATE');
            active = true;
            for (const object of objects) this.files.insert(this.database, object);
            const result = operation();
            this.database.exec('COMMIT');
            active = false;
            return result;
        } catch (error) {
            if (active) {
                try { this.database.exec('ROLLBACK'); } catch {
                    throw new AgentFault('STORAGE_COMMIT_UNKNOWN', '请求事务结果未知，请查询原尝试', undefined, true);
                }
            }
            this.files.discardUncommitted(this.database, objects);
            throw error;
        }
    }
}
