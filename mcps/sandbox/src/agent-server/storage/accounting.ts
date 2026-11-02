import { AgentFault, canonicalJson } from '../protocol.js';
import { applyAccountingCommand, emptyAccountingState } from '../accounting/budget-ledger.js';
import type { AccountingCommand, AccountingResult, AccountingState, BudgetRecord, BudgetView,
    ChargeRecord, ReservationRecord, QuotaLimitRecord } from '../accounting/budget-ledger.js';
import type { SqlDatabase, SqlRow, SqlValue } from './internal.js';

const MAX_ACCOUNTING_ROWS = 4096;
const MAX_ACCOUNTING_BYTES = 8 * 1024 * 1024;
const stateKey = (value: string): string => JSON.stringify(value);
const chargeKey = (charge: ChargeRecord): string => JSON.stringify([charge.quotaScopeId, charge.executionKey, charge.component]);

function parseRecord<Value>(row: SqlRow | undefined): Value | undefined {
    if (!row) return undefined;
    if (typeof row.record_json !== 'string') throw new AgentFault('STORAGE_SCHEMA_UNSUPPORTED', '旧费用记录缺少可核验的完整定义，未更新旧账本');
    try { return JSON.parse(row.record_json) as Value; } catch {
        throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '费用元数据格式损坏');
    }
}

function boundedRecords(database: SqlDatabase, table: 'reservations' | 'charges', clause: string, values: SqlValue[]): SqlRow[] {
    const totals = database.prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(length(CAST(record_json AS BLOB))),0) AS bytes FROM (SELECT record_json FROM ${table} WHERE ${clause} LIMIT ?)`)
        .get(...values, MAX_ACCOUNTING_ROWS + 1);
    if (Number(totals?.total ?? 0) > MAX_ACCOUNTING_ROWS || Number(totals?.bytes ?? 0) > MAX_ACCOUNTING_BYTES) {
        throw new AgentFault('STORAGE_ACCOUNTING_LIMIT', '单根或同一供应商执行的费用记录超过有界读取上限');
    }
    return database.prepare(`SELECT record_json FROM ${table} WHERE ${clause} LIMIT ?`).all(...values, MAX_ACCOUNTING_ROWS);
}

export class AccountingTransactions {
    constructor(private readonly database: SqlDatabase) {}

    readBudget(rootBudgetId: string): BudgetRecord {
        const budget = parseRecord<BudgetRecord>(this.database.prepare('SELECT record_json FROM budgets WHERE root_budget_id = ?').get(rootBudgetId));
        if (!budget) throw new AgentFault('BUDGET_REQUIRED', '必须先创建明确的根预算');
        return budget;
    }

    read(rootBudgetId: string): BudgetView {
        const budget = this.readBudget(rootBudgetId);
        const reservations = boundedRecords(this.database, 'reservations', 'root_budget_id = ?', [rootBudgetId])
            .map(row => parseRecord<ReservationRecord>(row)!);
        const charges = boundedRecords(this.database, 'charges', 'root_budget_id = ?', [rootBudgetId])
            .map(row => parseRecord<ChargeRecord>(row)!);
        return { budget, reservations, charges, quotaLimit: budget.quotaLimitId ? this.quotaLimit(budget.quotaLimitId) ?? null : null };
    }

    apply(command: AccountingCommand, now = Date.now()): AccountingResult {
        if (command.type === 'get_quota_limit') {
            const state = emptyAccountingState();
            if (command.quotaLimitId) {
                const limit = this.quotaLimit(command.quotaLimitId);
                if (limit) state.quotaLimits[stateKey(limit.quotaLimitId)] = limit;
            } else {
                const totals = this.database.prepare('SELECT COUNT(*) AS total,COALESCE(SUM(length(CAST(value_json AS BLOB))),0) AS bytes FROM (SELECT value_json FROM server_state WHERE kind = ? LIMIT ?)')
                    .get('accountingQuotaLimit', MAX_ACCOUNTING_ROWS + 1);
                if (Number(totals?.total ?? 0) > MAX_ACCOUNTING_ROWS || Number(totals?.bytes ?? 0) > MAX_ACCOUNTING_BYTES) {
                    throw new AgentFault('STORAGE_ACCOUNTING_LIMIT', '供应商总限额列表超过有界读取上限');
                }
                for (const row of this.database.prepare('SELECT id,value_json FROM server_state WHERE kind = ? ORDER BY id LIMIT ?').all('accountingQuotaLimit', MAX_ACCOUNTING_ROWS)) {
                    state.quotaLimits[stateKey(String(row.id))] = JSON.parse(String(row.value_json)) as QuotaLimitRecord;
                }
            }
            return applyAccountingCommand(state, command, now).result;
        }
        if (command.type === 'create_quota_limit' || command.type === 'halt_quota_limit') {
            const state = emptyAccountingState();
            const quotaLimitId = command.type === 'create_quota_limit' ? command.definition.quotaLimitId : command.quotaLimitId;
            const existing = this.quotaLimit(quotaLimitId);
            if (existing) state.quotaLimits[stateKey(quotaLimitId)] = existing;
            const result = applyAccountingCommand(state, command, now);
            this.persist(state, result.state);
            return result.result;
        }
        const rootBudgetId = command.type === 'create_budget' ? command.definition.rootBudgetId
            : 'rootBudgetId' in command ? command.rootBudgetId : this.reservation(command.attemptId)?.rootBudgetId;
        if (!rootBudgetId) throw new AgentFault('E_RESERVATION_MISSING', '该尝试尚未完成费用预留');
        const previous = this.load(rootBudgetId, command);
        const result = applyAccountingCommand(previous, command, now);
        this.persist(previous, result.state);
        return result.result;
    }

    private quotaLimit(quotaLimitId: string): QuotaLimitRecord | undefined {
        const row = this.database.prepare('SELECT value_json FROM server_state WHERE kind = ? AND id = ?').get('accountingQuotaLimit', quotaLimitId);
        return row ? JSON.parse(String(row.value_json)) as QuotaLimitRecord : undefined;
    }

    private reservation(attemptId: string): ReservationRecord | undefined {
        return parseRecord<ReservationRecord>(this.database.prepare('SELECT record_json FROM reservations WHERE attempt_id = ?').get(attemptId));
    }

    private load(rootBudgetId: string, command: AccountingCommand): AccountingState {
        const state = emptyAccountingState();
        const roots = new Set([rootBudgetId]);
        const loaded = new Set<string>();
        const loadQuota = (quotaLimitId: string): void => {
            if (state.quotaLimits[stateKey(quotaLimitId)]) return;
            const quota = this.quotaLimit(quotaLimitId);
            if (quota) state.quotaLimits[stateKey(quotaLimitId)] = quota;
        };
        if (command.type === 'create_budget' && command.definition.quotaLimitId) loadQuota(command.definition.quotaLimitId);
        if (command.type === 'reserve') {
            const previous = this.reservation(command.attemptId);
            if (previous) roots.add(previous.rootBudgetId);
        }
        const addCharge = (row: SqlRow): void => {
            const charge = parseRecord<ChargeRecord>(row)!;
            state.charges[chargeKey(charge)] = charge;
            roots.add(charge.rootBudgetId);
        };
        if (command.type === 'settle' || command.type === 'reconcile') {
            const reservation = this.reservation(command.attemptId);
            if (reservation) {
                const execution = command.providerExecutionId ? `execution:${command.providerExecutionId}` : reservation.executionKey;
                for (const row of boundedRecords(this.database, 'charges', 'quota_scope_id = ? AND execution_key IN (?,?)',
                    [reservation.quotaScopeId, reservation.executionKey, execution])) addCharge(row);
                for (const row of boundedRecords(this.database, 'reservations', 'quota_scope_id = ? AND execution_key IN (?,?)',
                    [reservation.quotaScopeId, reservation.executionKey, execution])) roots.add(parseRecord<ReservationRecord>(row)!.rootBudgetId);
            }
        }
        while (loaded.size < roots.size) {
            if (roots.size > MAX_ACCOUNTING_ROWS) throw new AgentFault('STORAGE_ACCOUNTING_LIMIT', '同一执行关联的根预算过多，保留原账本等待核对');
            const next = [...roots].find(root => !loaded.has(root))!;
            loaded.add(next);
            const budget = parseRecord<BudgetRecord>(this.database.prepare('SELECT record_json FROM budgets WHERE root_budget_id = ?').get(next));
            if (budget) {
                state.budgets[stateKey(next)] = budget;
                if (budget.quotaLimitId) loadQuota(budget.quotaLimitId);
            }
            const reservations = boundedRecords(this.database, 'reservations', 'root_budget_id = ?', [next]);
            for (const row of reservations) {
                const reservation = parseRecord<ReservationRecord>(row)!;
                state.reservations[stateKey(reservation.attemptId)] = reservation;
                for (const identity of reservation.chargeKeys) {
                    if (state.charges[identity]) continue;
                    let parts: string[];
                    try {
                        parts = JSON.parse(identity) as string[];
                        if (!Array.isArray(parts) || parts.length !== 3 || parts.some(part => typeof part !== 'string')) throw new Error();
                    } catch { throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '费用组件引用格式损坏'); }
                    const charge = this.database.prepare('SELECT record_json FROM charges WHERE quota_scope_id = ? AND execution_key = ? AND component = ?')
                        .get(parts[0], parts[1], parts[2]);
                    if (!charge) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '费用组件引用缺失');
                    addCharge(charge);
                }
            }
            for (const row of boundedRecords(this.database, 'charges', 'root_budget_id = ?', [next])) addCharge(row);
            if (Object.keys(state.reservations).length + Object.keys(state.charges).length > MAX_ACCOUNTING_ROWS
                || Buffer.byteLength(canonicalJson(state)) > MAX_ACCOUNTING_BYTES) {
                throw new AgentFault('STORAGE_ACCOUNTING_LIMIT', '相关费用状态超过本次事务的有界读取上限');
            }
        }
        state.quotaCarry = {};
        for (const quota of Object.values(state.quotaLimits)) {
            const total = this.database.prepare('SELECT COALESCE(SUM(spent_micros),0) AS spentMicros,COALESCE(SUM(held_micros),0) AS heldMicros,COALESCE(SUM(spent_calls),0) AS spentCalls,COALESCE(SUM(held_calls),0) AS heldCalls FROM budgets WHERE quota_limit_id = ?')
                .get(quota.quotaLimitId)!;
            const included = Object.values(state.budgets).filter(budget => budget.quotaLimitId === quota.quotaLimitId);
            const carry = { spentMicros: Number(total.spentMicros), heldMicros: Number(total.heldMicros),
                spentCalls: Number(total.spentCalls), heldCalls: Number(total.heldCalls) };
            for (const budget of included) {
                carry.spentMicros -= budget.spentMicros;
                carry.heldMicros -= budget.heldMicros;
                carry.spentCalls -= budget.spentCalls;
                carry.heldCalls -= budget.heldCalls;
            }
            if (Object.values(carry).some(value => !Number.isSafeInteger(value) || value < 0)) {
                throw new AgentFault('STORAGE_ACCOUNTING_LIMIT', '已有费用聚合与当前根预算统计无法精确对应，原账本未改变');
            }
            state.quotaCarry[stateKey(quota.quotaLimitId)] = carry;
        }
        return state;
    }

    private persist(previous: AccountingState, next: AccountingState): void {
        for (const [identity, limit] of Object.entries(next.quotaLimits)) {
            if (previous.quotaLimits[identity] && canonicalJson(previous.quotaLimits[identity]) === canonicalJson(limit)) continue;
            this.database.prepare('INSERT INTO server_state (kind,id,revision,value_json) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json')
                .run('accountingQuotaLimit', limit.quotaLimitId, limit.version, canonicalJson(limit));
        }
        for (const [identity, budget] of Object.entries(next.budgets)) {
            if (previous.budgets[identity] && canonicalJson(previous.budgets[identity]) === canonicalJson(budget)) continue;
            this.database.prepare('INSERT INTO budgets (root_budget_id,mode,currency,limit_micros,max_model_calls,spent_calls,held_calls,spent_micros,held_micros,deadline_at,version,record_json,quota_limit_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(root_budget_id) DO UPDATE SET spent_calls=excluded.spent_calls,held_calls=excluded.held_calls,spent_micros=excluded.spent_micros,held_micros=excluded.held_micros,version=excluded.version,record_json=excluded.record_json')
                .run(budget.rootBudgetId, budget.mode, budget.currency, budget.maxCostMicros, budget.maxModelCalls,
                    budget.spentCalls, budget.heldCalls, budget.spentMicros, budget.heldMicros, budget.deadlineAt, budget.version, canonicalJson(budget), budget.quotaLimitId ?? null);
        }
        for (const [identity, reservation] of Object.entries(next.reservations)) {
            if (previous.reservations[identity] && canonicalJson(previous.reservations[identity]) === canonicalJson(reservation)) continue;
            this.database.prepare('INSERT INTO reservations (attempt_id,root_budget_id,upper_micros,amount_unknown,state,version,action_id,quota_scope_id,execution_key,record_json) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET amount_unknown=excluded.amount_unknown,state=excluded.state,version=excluded.version,execution_key=excluded.execution_key,record_json=excluded.record_json')
                .run(reservation.attemptId, reservation.rootBudgetId, reservation.upperMicros, reservation.amountUnknown ? 1 : 0,
                    reservation.state, reservation.version, reservation.actionId, reservation.quotaScopeId,
                    reservation.executionKey, canonicalJson(reservation));
        }
        for (const [identity, charge] of Object.entries(previous.charges)) {
            if (!next.charges[identity]) this.database.prepare('DELETE FROM charges WHERE quota_scope_id = ? AND execution_key = ? AND component = ?')
                .run(charge.quotaScopeId, charge.executionKey, charge.component);
        }
        for (const [identity, charge] of Object.entries(next.charges)) {
            if (previous.charges[identity] && canonicalJson(previous.charges[identity]) === canonicalJson(charge)) continue;
            this.database.prepare('INSERT INTO charges (quota_scope_id,execution_key,component,attempt_id,usage_revision,amount_micros,usage_json,root_budget_id,record_json) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(quota_scope_id,execution_key,component) DO UPDATE SET usage_revision=excluded.usage_revision,amount_micros=excluded.amount_micros,usage_json=excluded.usage_json,record_json=excluded.record_json')
                .run(charge.quotaScopeId, charge.executionKey, charge.component, charge.attemptId, charge.usageRevision,
                    charge.amountMicros, canonicalJson(charge.usage), charge.rootBudgetId, canonicalJson(charge));
        }
    }
}
