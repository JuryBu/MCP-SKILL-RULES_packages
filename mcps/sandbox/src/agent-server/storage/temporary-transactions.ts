import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonValue } from '../protocol.js';
import type { UpperBound } from '../accounting/budget-ledger.js';
import type { SqlDatabase, SqlRow } from './internal.js';
import { AccountingTransactions } from './accounting.js';
import { sha256 } from './objects.js';
import { exactFields, financialId, validateTemporaryFence, validateTemporaryIntent, validateTemporarySettlement,
    validateTemporaryUpperBound } from './temporary-finance.js';
import type { TemporaryFeeCommand, TemporaryFeeFailure, TemporaryFeeResult, TemporaryFeeSettlement,
    TemporaryFinancialAttempt, TemporaryFinancialIntent, TemporaryRunFence } from './temporary-finance.js';

export type ReserveTemporaryFinancialIntent = (accounting: AccountingTransactions, intent: TemporaryFinancialIntent, upperBound: UpperBound) => void;

export class TemporaryFeeTransactions {
    private readonly accounting: AccountingTransactions;
    constructor(private readonly database: SqlDatabase, private readonly reserve: ReserveTemporaryFinancialIntent) {
        this.accounting = new AccountingTransactions(database);
    }

    execute(command: TemporaryFeeCommand): TemporaryFeeResult {
        switch (command.type) {
            case 'prepare':
                exactFields(command, ['type', 'intent', 'upperBound']);
                return this.prepare(command.intent, command.upperBound);
            case 'settle':
                exactFields(command, ['type', 'settlement']);
                return this.settle(command.settlement);
            case 'failure':
                exactFields(command, ['type', 'failure']);
                return this.failure(command.failure);
            case 'fence':
                exactFields(command, ['type', 'fence']);
                return this.fence(command.fence);
            case 'close_owner':
                exactFields(command, ['type', 'ownerInstanceId']);
                financialId(command.ownerInstanceId);
                return this.atomic(() => {
                    this.markPendingUnknown(command.ownerInstanceId);
                    this.database.prepare('UPDATE temporary_provider_fences SET active = 0,version = version + 1,updated_at = ? WHERE owner_instance_id = ?')
                        .run(new Date().toISOString(), command.ownerInstanceId);
                    return { status: 'updated' };
                });
            default: throw new AgentFault('INVALID_PARAMS', '未知临时费用事务');
        }
    }

    read(attemptId: string): TemporaryFinancialAttempt | undefined {
        financialId(attemptId);
        const row = this.row(attemptId);
        return row ? { intent: JSON.parse(String(row.intent_json)) as TemporaryFinancialIntent,
            upperBound: JSON.parse(String(row.upper_bound_json)) as UpperBound,
            state: row.state as TemporaryFinancialAttempt['state'] } : undefined;
    }

    hasConversationHolds(conversationId: string): boolean {
        financialId(conversationId);
        if (this.database.prepare('SELECT 1 FROM temporary_provider_fences WHERE cid = ? AND active = 1 LIMIT 1').get(conversationId)) return true;
        const held = `(reservation.attempt_id IS NULL OR reservation.state NOT IN ('settled','rejected')
            OR reservation.amount_unknown <> 0 OR COALESCE(json_extract(reservation.record_json,'$.callHeld'),1) <> 0
            OR COALESCE(json_extract(reservation.record_json,'$.heldMicros'),1) <> 0)`;
        if (this.database.prepare(`SELECT 1 FROM temporary_provider_attempts AS attempt
            LEFT JOIN reservations AS reservation ON reservation.attempt_id = attempt.attempt_id
            WHERE attempt.cid = ? AND (attempt.state NOT IN ('committed','rejected') OR ${held}) LIMIT 1`).get(conversationId)) return true;
        if (this.database.prepare(`SELECT 1 FROM attempts AS attempt
            LEFT JOIN provider_attempt_journal AS journal ON journal.attempt_id = attempt.attempt_id
            LEFT JOIN reservations AS reservation ON reservation.attempt_id = attempt.attempt_id
            WHERE attempt.cid = ? AND (journal.state IS NULL OR journal.state NOT IN ('committed','rejected') OR ${held}) LIMIT 1`).get(conversationId)) return true;
        if (this.database.prepare(`SELECT 1 FROM provider_budget_bindings AS binding JOIN budgets AS budget ON budget.root_budget_id = binding.root_budget_id
            WHERE binding.cid = ? AND (budget.held_calls <> 0 OR budget.held_micros <> 0) LIMIT 1`).get(conversationId)) return true;
        return Boolean(this.database.prepare(`SELECT 1 FROM provider_budget_bindings AS binding
            JOIN reservations AS reservation ON reservation.root_budget_id = binding.root_budget_id
            WHERE binding.cid = ? AND ${held} LIMIT 1`).get(conversationId));
    }

    recover(): void {
        this.atomic(() => {
            this.markPendingUnknown();
            this.database.prepare('UPDATE temporary_provider_fences SET active = 0,version = version + 1,updated_at = ? WHERE active = 1')
                .run(new Date().toISOString());
        });
    }

    private prepare(intent: TemporaryFinancialIntent, upperBound: UpperBound): TemporaryFeeResult {
        validateTemporaryIntent(intent); validateTemporaryUpperBound(upperBound);
        return this.atomic(() => {
            const previous = this.row(intent.attemptId);
            if (previous) {
                this.requireMatch(previous, intent);
                if (previous.upper_bound_json !== canonicalJson(upperBound)) throw new AgentFault('E_ATTEMPT_CONFLICT', '原临时费用上界已经冻结');
                if (previous.state === 'committed') return { status: 'committed', fenceLive: false, replayed: true };
                return { status: previous.state === 'dispatching' ? 'already_dispatching' : previous.state as 'unknown' | 'rejected' };
            }
            if (!this.live(intent)) throw new AgentFault('RUN_STALE', '临时执行的持久代次已失效，未授予发送权');
            this.reserve(this.accounting, intent, upperBound);
            this.accounting.apply({ type: 'dispatch', attemptId: intent.attemptId });
            this.database.prepare('INSERT INTO temporary_provider_attempts (attempt_id,root_budget_id,owner_instance_id,cid,run_id,run_epoch,history_epoch,financial_intent_id,dispatch_nonce,intent_json,upper_bound_json,state,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
                .run(intent.attemptId, intent.rootBudgetId, intent.ownerInstanceId, intent.conversationId, intent.runId,
                    intent.runEpoch, intent.historyEpoch, intent.financialIntentId, intent.dispatchNonce,
                    canonicalJson(intent), canonicalJson(upperBound), 'dispatching', new Date().toISOString());
            return { status: 'send' };
        });
    }

    private settle(settlement: TemporaryFeeSettlement): TemporaryFeeResult {
        validateTemporarySettlement(settlement);
        const hash = sha256(canonicalJson(settlement));
        return this.atomic(() => {
            const row = this.requireAttempt(settlement.intent);
            if (row.state === 'committed') {
                if (row.settlement_hash !== hash) throw new AgentFault('E_RESPONSE_CONFLICT', '临时费用尝试已经结算不同的费用事实');
                return { status: 'committed', fenceLive: false, replayed: true };
            }
            this.accounting.apply({ type: 'settle', attemptId: settlement.intent.attemptId,
                usageRevision: settlement.usageRevision, providerExecutionId: settlement.providerExecutionId,
                ...(settlement.postResponseUpperBound ? { postResponseUpperBound: settlement.postResponseUpperBound } : {}),
                complete: settlement.complete, charges: settlement.charges.map(charge => ({ ...charge, usage: { ...charge.usage } as JsonValue })) });
            const fenceLive = this.live(settlement.intent);
            this.database.prepare('UPDATE temporary_provider_attempts SET state = ?,settlement_hash = ?,updated_at = ? WHERE attempt_id = ?')
                .run('committed', hash, new Date().toISOString(), settlement.intent.attemptId);
            return { status: 'committed', fenceLive, replayed: false };
        });
    }

    private failure(failure: TemporaryFeeFailure): TemporaryFeeResult {
        exactFields(failure, ['intent', 'acceptance', 'code']);
        validateTemporaryIntent(failure.intent);
        if (!['not_sent', 'rejected', 'accepted', 'unknown'].includes(failure.acceptance) || !/^E_[A-Z0-9_]{1,80}$/.test(failure.code)) {
            throw new AgentFault('TEMPORARY_FINANCE_INVALID', '临时失败记录只接受接纳状态和固定错误码');
        }
        return this.atomic(() => {
            const row = this.requireAttempt(failure.intent);
            if (row.state === 'committed') return { status: 'committed', fenceLive: false, replayed: true };
            const rejected = failure.acceptance === 'not_sent' || failure.acceptance === 'rejected';
            if (row.state !== 'rejected') this.accounting.apply(rejected
                ? { type: 'reject', attemptId: failure.intent.attemptId, acceptance: failure.acceptance as 'not_sent' | 'rejected', evidenceRef: `temporary-fee:${failure.intent.financialIntentId}` }
                : { type: 'unknown', attemptId: failure.intent.attemptId });
            if (failure.code === 'E_QUOTA') this.accounting.apply({ type: 'halt', rootBudgetId: failure.intent.rootBudgetId,
                reason: 'E_QUOTA', evidenceRef: `temporary-fee:${failure.intent.financialIntentId}` });
            const state = row.state === 'rejected' || rejected ? 'rejected' : 'unknown';
            this.database.prepare('UPDATE temporary_provider_attempts SET state = ?,updated_at = ? WHERE attempt_id = ?')
                .run(state, new Date().toISOString(), failure.intent.attemptId);
            return { status: state };
        });
    }

    private fence(fence: TemporaryRunFence): TemporaryFeeResult {
        validateTemporaryFence(fence);
        return this.atomic(() => {
            const previous = this.database.prepare('SELECT version,run_epoch,history_epoch,active FROM temporary_provider_fences WHERE owner_instance_id = ? AND cid = ? AND run_id = ?')
                .get(fence.ownerInstanceId, fence.conversationId, fence.runId);
            if (previous && (Number(previous.version) > fence.revision || Number(previous.run_epoch) > fence.runEpoch
                || Number(previous.history_epoch) > fence.historyEpoch)) throw new AgentFault('RUN_STALE', '临时执行的旧代次更新已经失效');
            if (previous && Number(previous.version) === fence.revision && (Number(previous.active) !== Number(fence.active)
                || Number(previous.run_epoch) !== fence.runEpoch || Number(previous.history_epoch) !== fence.historyEpoch)) {
                throw new AgentFault('RUN_STALE', '临时执行的同一代次更新出现冲突');
            }
            this.database.prepare('INSERT INTO temporary_provider_fences (owner_instance_id,cid,run_id,run_epoch,history_epoch,active,version,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(owner_instance_id,cid,run_id) DO UPDATE SET run_epoch=excluded.run_epoch,history_epoch=excluded.history_epoch,active=excluded.active,version=excluded.version,updated_at=excluded.updated_at')
                .run(fence.ownerInstanceId, fence.conversationId, fence.runId, fence.runEpoch, fence.historyEpoch,
                    fence.active ? 1 : 0, fence.revision, new Date().toISOString());
            if (!fence.active) this.markPendingUnknown(fence.ownerInstanceId, fence.conversationId, fence.runId);
            return { status: 'updated' };
        });
    }

    private markPendingUnknown(ownerInstanceId?: string, conversationId?: string, runId?: string): void {
        const rows = this.database.prepare("SELECT attempt_id,intent_json FROM temporary_provider_attempts WHERE state = 'dispatching' AND (? IS NULL OR owner_instance_id = ?) AND (? IS NULL OR cid = ?) AND (? IS NULL OR run_id = ?) LIMIT 4097")
            .all(ownerInstanceId ?? null, ownerInstanceId ?? null, conversationId ?? null, conversationId ?? null, runId ?? null, runId ?? null);
        if (rows.length > 4096) throw new AgentFault('STORAGE_ACCOUNTING_LIMIT', '待恢复的临时费用超过本次有界恢复上限');
        for (const row of rows) {
            const intent = JSON.parse(String(row.intent_json)) as TemporaryFinancialIntent;
            validateTemporaryIntent(intent);
            const record = this.database.prepare('SELECT record_json FROM reservations WHERE attempt_id = ?').get(String(row.attempt_id));
            if (!record || typeof record.record_json !== 'string') throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '临时费用意图缺少对应预算预留');
            const reservation = JSON.parse(record.record_json) as { state: string };
            const state = reservation.state === 'settled' ? 'committed' : reservation.state === 'rejected' ? 'rejected' : 'unknown';
            if (state === 'unknown') this.accounting.apply({ type: 'unknown', attemptId: intent.attemptId });
            this.database.prepare('UPDATE temporary_provider_attempts SET state = ?,updated_at = ? WHERE attempt_id = ?')
                .run(state, new Date().toISOString(), intent.attemptId);
        }
    }

    private live(intent: TemporaryFinancialIntent): boolean {
        const row = this.database.prepare('SELECT active,run_epoch,history_epoch,version FROM temporary_provider_fences WHERE owner_instance_id = ? AND cid = ? AND run_id = ?')
            .get(intent.ownerInstanceId, intent.conversationId, intent.runId);
        return Boolean(row && Number(row.active) === 1 && Number(row.run_epoch) === intent.runEpoch
            && Number(row.history_epoch) === intent.historyEpoch && Number(row.version) === intent.fenceRevision);
    }

    private row(attemptId: string): SqlRow | undefined {
        return this.database.prepare('SELECT intent_json,upper_bound_json,state,settlement_hash FROM temporary_provider_attempts WHERE attempt_id = ?').get(attemptId);
    }

    private requireMatch(row: SqlRow, intent: TemporaryFinancialIntent): void {
        if (row.intent_json !== canonicalJson(intent)) throw new AgentFault('E_ATTEMPT_CONFLICT', '临时费用尝试的所有者或独立发送权已经变化');
    }

    private requireAttempt(intent: TemporaryFinancialIntent): SqlRow {
        const row = this.row(intent.attemptId);
        if (!row) throw new AgentFault('E_ATTEMPT_MISSING', '临时费用尝试尚未持久预留');
        this.requireMatch(row, intent);
        return row;
    }

    private atomic<Value>(operation: () => Value): Value {
        this.database.exec('BEGIN IMMEDIATE');
        try { const result = operation(); this.database.exec('COMMIT'); return result; }
        catch (error) {
            try { this.database.exec('ROLLBACK'); }
            catch { throw new AgentFault('STORAGE_COMMIT_UNKNOWN', '临时费用事务结果未知，请核对原费用意图', undefined, true); }
            throw error;
        }
    }
}
