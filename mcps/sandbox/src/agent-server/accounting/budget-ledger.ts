import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonValue } from '../protocol.js';

export interface BudgetDefinition {
    rootBudgetId: string;
    mode?: 'hard' | 'estimated';
    currency: string;
    maxCostMicros: number | null;
    maxModelCalls: number;
    maxOutputTokens: number;
    deadlineAt: string;
    sourceRef: string;
    quotaLimitId?: string;
}

export interface QuotaLimitDefinition {
    quotaLimitId: string;
    currency: string;
    maxCostMicros: number;
    quotaScopeIds: string[];
    sourceRef: string;
}

export interface QuotaLimitRecord extends QuotaLimitDefinition {
    spentMicros: number;
    heldMicros: number;
    spentCalls: number;
    heldCalls: number;
    blockedReason: string | null;
    overdrawn: boolean;
    definitionHash: string;
    version: number;
}

export interface BudgetRecord extends BudgetDefinition {
    mode: 'hard' | 'estimated';
    spentCalls: number;
    heldCalls: number;
    spentMicros: number;
    heldMicros: number;
    amountUnknown: boolean;
    overdrawn: boolean;
    version: number;
    definitionHash: string;
    blockedReason: string | null;
}

export interface UpperBound {
    currency: string;
    amountMicros: number | null;
    reliable: boolean;
    source: 'price_table' | 'account_cap' | 'fixture' | 'estimated';
    sourceRef: string;
    expiresAt?: string;
}

export interface PostResponseUpperBound {
    amountMicros: number;
    currency: string;
    source: 'frozen_price_usage';
    sourceRef: string;
    priceVersion: string;
    usageRevision: number;
    inputTokens: number;
    originalMaxOutputTokens: number;
    boundedRemainingTokens: number;
    reportedTotalTokens: number | null;
    method: 'reported_total_tokens' | 'original_output_cap';
}

export type ReservationIdentity =
    | { snapshotHash: string; financialIntentId?: never }
    | { financialIntentId: string; snapshotHash?: never };

export type ReservationInput = { rootBudgetId: string; attemptId: string; actionId: string; quotaScopeId: string;
    upperBound: UpperBound; foregroundCallFloor?: 1 } & ReservationIdentity;

export type ReservationRecord = ReservationIdentity & {
    attemptId: string;
    rootBudgetId: string;
    actionId: string;
    quotaScopeId: string;
    upperMicros: number | null;
    originalUpperBound?: UpperBound;
    postResponseUpperBound?: PostResponseUpperBound;
    heldMicros: number;
    amountUnknown: boolean;
    state: 'reserved' | 'dispatched' | 'unknown' | 'unsettled' | 'settled' | 'rejected';
    dispatched: boolean;
    callHeld: boolean;
    intentHash: string;
    executionKey: string;
    reportedExecutionId: string | null;
    chargeKeys: string[];
    evidenceRef: string | null;
    version: number;
    expiresAt: string | null;
};

export interface ChargeRecord {
    quotaScopeId: string;
    executionKey: string;
    component: string;
    attemptId: string;
    rootBudgetId: string;
    usageRevision: number;
    amountMicros: number | null;
    currency: string;
    usage: JsonValue;
    kind: 'provider_reported' | 'calculated';
}

export interface ChargeInput {
    component: string;
    amountMicros: number | null;
    currency: string;
    usage: JsonValue;
    kind: 'provider_reported' | 'calculated';
}

export interface AccountingState {
    schemaVersion: 1;
    budgets: Record<string, BudgetRecord>;
    reservations: Record<string, ReservationRecord>;
    charges: Record<string, ChargeRecord>;
    quotaLimits: Record<string, QuotaLimitRecord>;
    quotaCarry?: Record<string, { spentMicros: number; heldMicros: number; spentCalls: number; heldCalls: number }>;
}

export type AccountingCommand =
    | { type: 'get_quota_limit'; quotaLimitId?: string }
    | { type: 'create_quota_limit'; definition: QuotaLimitDefinition }
    | { type: 'halt_quota_limit'; quotaLimitId: string; reason: string; evidenceRef: string }
    | { type: 'create_budget'; definition: BudgetDefinition }
    | { type: 'halt'; rootBudgetId: string; reason: string; evidenceRef: string }
    | ({ type: 'reserve' } & ReservationInput)
    | { type: 'dispatch' | 'unknown'; attemptId: string }
    | { type: 'reject'; attemptId: string; acceptance: 'not_sent' | 'rejected'; evidenceRef: string }
    | { type: 'settle'; attemptId: string; usageRevision: number; providerExecutionId: string | null; charges: ChargeInput[]; complete: boolean;
        postResponseUpperBound?: PostResponseUpperBound }
    | { type: 'reconcile'; attemptId: string; providerExecutionId: string; evidenceRef: string };

export interface AccountingResult {
    budget?: BudgetRecord;
    quotaLimit?: QuotaLimitRecord;
    quotaLimits?: QuotaLimitRecord[];
    reservation?: ReservationRecord;
    replayed: boolean;
}

export interface BudgetView {
    budget: BudgetRecord;
    reservations: ReservationRecord[];
    charges: ChargeRecord[];
    quotaLimit: QuotaLimitRecord | null;
}

export interface AccountingPort {
    execute(command: AccountingCommand): Promise<AccountingResult>;
    read(rootBudgetId: string): Promise<BudgetView>;
}

const key = (value: string): string => JSON.stringify(value);
const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
const chargeKey = (scope: string, execution: string, component: string): string => JSON.stringify([scope, execution, component]);
const exactAmount = (amount: unknown): amount is number => typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0;

function requiredIdentity(value: string): void {
    if (!value || value.length > 512) throw new AgentFault('E_ACCOUNTING_IDENTITY', '费用记录身份为空或过长');
}

function safeAdd(left: number, right: number): number {
    const sum = left + right;
    if (!Number.isSafeInteger(sum) || sum < 0) throw new AgentFault('E_ACCOUNTING_RANGE', '费用统计超出精确整数范围');
    return sum;
}

export function emptyAccountingState(): AccountingState {
    return { schemaVersion: 1, budgets: {}, reservations: {}, charges: {}, quotaLimits: {} };
}

function quotaLimitFor(state: AccountingState, quotaLimitId: string): QuotaLimitRecord {
    const limit = state.quotaLimits[key(quotaLimitId)];
    if (!limit) throw new AgentFault('E_GLOBAL_BUDGET_REQUIRED', '必须先创建跨全部根任务的供应商总限额');
    return limit;
}

function budgetFor(state: AccountingState, rootBudgetId: string): BudgetRecord {
    const budget = state.budgets[key(rootBudgetId)];
    if (!budget) throw new AgentFault('BUDGET_REQUIRED', '必须先创建明确的根预算');
    return budget;
}

function refreshTotals(state: AccountingState): void {
    for (const limit of Object.values(state.quotaLimits)) {
        const carry = state.quotaCarry?.[key(limit.quotaLimitId)];
        if (carry && Object.values(carry).some(value => !exactAmount(value))) {
            throw new AgentFault('E_ACCOUNTING_RANGE', '供应商已有费用统计超出精确整数范围');
        }
        limit.spentMicros = carry?.spentMicros ?? 0;
        limit.heldMicros = carry?.heldMicros ?? 0;
        limit.spentCalls = carry?.spentCalls ?? 0;
        limit.heldCalls = carry?.heldCalls ?? 0;
    }
    for (const budget of Object.values(state.budgets)) {
        budget.spentCalls = 0;
        budget.heldCalls = 0;
        budget.spentMicros = 0;
        budget.heldMicros = 0;
        budget.amountUnknown = false;
    }
    for (const charge of Object.values(state.charges)) {
        const budget = budgetFor(state, charge.rootBudgetId);
        budget.spentMicros = safeAdd(budget.spentMicros, charge.amountMicros ?? 0);
    }
    for (const reservation of Object.values(state.reservations)) {
        const budget = budgetFor(state, reservation.rootBudgetId);
        budget.spentCalls += reservation.dispatched ? 1 : 0;
        budget.heldCalls += reservation.callHeld ? 1 : 0;
        budget.heldMicros = safeAdd(budget.heldMicros, reservation.heldMicros);
        if (!['settled', 'rejected'].includes(reservation.state) && reservation.amountUnknown) budget.amountUnknown = true;
    }
    for (const budget of Object.values(state.budgets)) {
        budget.overdrawn = budget.overdrawn || (budget.maxCostMicros !== null && budget.spentMicros + budget.heldMicros > budget.maxCostMicros);
        if (budget.quotaLimitId) {
            const limit = quotaLimitFor(state, budget.quotaLimitId);
            limit.spentMicros = safeAdd(limit.spentMicros, budget.spentMicros);
            limit.heldMicros = safeAdd(limit.heldMicros, budget.heldMicros);
            limit.spentCalls += budget.spentCalls;
            limit.heldCalls += budget.heldCalls;
            if (budget.overdrawn) limit.overdrawn = true;
        }
    }
    for (const limit of Object.values(state.quotaLimits)) limit.overdrawn = limit.overdrawn || limit.spentMicros + limit.heldMicros > limit.maxCostMicros;
}

function releaseKnownCosts(state: AccountingState, reservation: ReservationRecord, complete: boolean): void {
    let known = 0;
    for (const chargeId of reservation.chargeKeys) {
        const charge = state.charges[chargeId];
        if (charge?.attemptId === reservation.attemptId) known = safeAdd(known, charge.amountMicros ?? 0);
    }
    const effectiveUpper = reservation.postResponseUpperBound?.amountMicros ?? reservation.upperMicros ?? 0;
    reservation.heldMicros = complete ? 0 : Math.max(0, effectiveUpper - known);
    reservation.amountUnknown = !complete;
    reservation.state = complete ? 'settled' : 'unsettled';
    reservation.callHeld = false;
    reservation.dispatched = true;
    if ((reservation.postResponseUpperBound || reservation.upperMicros !== null) && known > effectiveUpper) {
        budgetFor(state, reservation.rootBudgetId).overdrawn = true;
    }
}

function mergeExecution(state: AccountingState, reservation: ReservationRecord, providerExecutionId: string): void {
    requiredIdentity(providerExecutionId);
    const executionKey = `execution:${providerExecutionId}`;
    if (reservation.executionKey.startsWith('execution:') && reservation.executionKey !== executionKey) {
        throw new AgentFault('E_EXECUTION_CONFLICT', '同一尝试已经关联另一个供应商执行身份');
    }
    const oldKeys = [...reservation.chargeKeys];
    for (const oldKey of oldKeys) {
        const old = state.charges[oldKey];
        if (!old || old.executionKey === executionKey) continue;
        const nextKey = chargeKey(old.quotaScopeId, executionKey, old.component);
        const existing = state.charges[nextKey];
        if (existing) {
            if (existing.currency !== old.currency || (existing.usageRevision === old.usageRevision
                && hash({ amount: existing.amountMicros, usage: existing.usage }) !== hash({ amount: old.amountMicros, usage: old.usage }))) {
                throw new AgentFault('E_USAGE_CONFLICT', '查回的同一执行存在冲突费用，需要保留并核对');
            }
            if (old.usageRevision > existing.usageRevision) {
                existing.usageRevision = old.usageRevision;
                existing.amountMicros = old.amountMicros;
                existing.usage = old.usage;
                existing.kind = old.kind;
            }
        } else state.charges[nextKey] = { ...old, executionKey };
        delete state.charges[oldKey];
        for (const related of Object.values(state.reservations)) {
            related.chargeKeys = [...new Set(related.chargeKeys.map(value => value === oldKey ? nextKey : value))];
        }
    }
    reservation.executionKey = executionKey;
    reservation.reportedExecutionId = providerExecutionId;
}

export function applyAccountingCommand(previous: AccountingState, command: AccountingCommand, now = Date.now()): { state: AccountingState; result: AccountingResult } {
    if (previous.schemaVersion !== 1) throw new AgentFault('E_SCHEMA_VERSION', '费用状态版本不受支持');
    const state = structuredClone({ ...previous, quotaLimits: previous.quotaLimits ?? {} });
    if (command.type === 'get_quota_limit') {
        const limit = command.quotaLimitId ? state.quotaLimits[key(command.quotaLimitId)] : undefined;
        return { state, result: { ...(limit ? { quotaLimit: structuredClone(limit) } : {}),
            quotaLimits: structuredClone(Object.values(state.quotaLimits).filter(value => !command.quotaLimitId || value.quotaLimitId === command.quotaLimitId)), replayed: false } };
    }
    if (command.type === 'create_quota_limit' || command.type === 'halt_quota_limit') {
        let limit: QuotaLimitRecord;
        let replayed = false;
        if (command.type === 'create_quota_limit') {
            const definition = command.definition;
            requiredIdentity(definition.quotaLimitId);
            if (!/^[A-Z]{3}$/.test(definition.currency) || !exactAmount(definition.maxCostMicros) || !definition.sourceRef
                || !definition.quotaScopeIds.length || definition.quotaScopeIds.some(scope => !scope)) {
                throw new AgentFault('E_GLOBAL_BUDGET_REQUIRED', '供应商总限额必须明确币种、金额、账户配额组和授权来源');
            }
            const existing = state.quotaLimits[key(definition.quotaLimitId)];
            if (existing && existing.definitionHash !== hash(definition)) throw new AgentFault('E_GLOBAL_BUDGET_CONFLICT', '同一供应商总限额不能被重新创建为新额度');
            limit = existing ?? { ...definition, spentMicros: 0, heldMicros: 0, spentCalls: 0, heldCalls: 0,
                blockedReason: null, overdrawn: false, definitionHash: hash(definition), version: 1 };
            replayed = Boolean(existing);
            state.quotaLimits[key(definition.quotaLimitId)] = limit;
        } else {
            limit = quotaLimitFor(state, command.quotaLimitId);
            if (!command.reason || !command.evidenceRef) throw new AgentFault('E_ACCEPTANCE_EVIDENCE', '停止供应商总限额需记录原因与证据');
            limit.blockedReason = command.reason;
            limit.version++;
        }
        return { state, result: { quotaLimit: structuredClone(limit), replayed } };
    }
    let budget: BudgetRecord;
    let reservation: ReservationRecord | undefined;
    let replayed = false;
    if (command.type === 'halt') {
        budget = budgetFor(state, command.rootBudgetId);
        if (!command.reason || !command.evidenceRef) throw new AgentFault('E_ACCEPTANCE_EVIDENCE', '停止新增付费请求必须记录原因与证据');
        budget.blockedReason = command.reason;
        if (budget.quotaLimitId && command.reason === 'E_QUOTA') quotaLimitFor(state, budget.quotaLimitId).blockedReason = command.reason;
        budget.version++;
    } else if (command.type === 'create_budget') {
        const definition = { ...command.definition, mode: command.definition.mode ?? 'hard' };
        requiredIdentity(definition.rootBudgetId);
        if (!['hard', 'estimated'].includes(definition.mode) || !/^[A-Z]{3}$/.test(definition.currency) || !definition.sourceRef
            || !exactAmount(definition.maxModelCalls) || definition.maxModelCalls < 1
            || !exactAmount(definition.maxOutputTokens) || definition.maxOutputTokens < 1
            || !Number.isFinite(Date.parse(definition.deadlineAt)) || Date.parse(definition.deadlineAt) <= now
            || (definition.maxCostMicros !== null && !exactAmount(definition.maxCostMicros))) {
            throw new AgentFault('BUDGET_REQUIRED', '根预算必须明确币种、次数、输出上限、期限和来源');
        }
        if (definition.mode === 'hard' && definition.maxCostMicros === null) throw new AgentFault('BUDGET_REQUIRED', '硬金额预算必须提供明确金额');
        if (definition.quotaLimitId) {
            const globalLimit = quotaLimitFor(state, definition.quotaLimitId);
            if (globalLimit.currency !== definition.currency) throw new AgentFault('E_CURRENCY_MISMATCH', '根预算与供应商总限额币种不同');
            if (globalLimit.blockedReason || globalLimit.overdrawn) throw new AgentFault('E_GLOBAL_BUDGET_HALTED', '供应商总限额已停止新增请求');
        }
        const existing = state.budgets[key(definition.rootBudgetId)];
        if (existing && existing.definitionHash !== hash(definition)) throw new AgentFault('E_BUDGET_CONFLICT', '同一根预算不能被重新创建为其他额度');
        budget = existing ?? { ...definition, spentCalls: 0, heldCalls: 0, spentMicros: 0, heldMicros: 0,
            amountUnknown: false, overdrawn: false, blockedReason: null, version: 1, definitionHash: hash(definition) };
        replayed = Boolean(existing);
        state.budgets[key(definition.rootBudgetId)] = budget;
    } else if (command.type === 'reserve') {
        if (command.foregroundCallFloor !== undefined && command.foregroundCallFloor !== 1) {
            throw new AgentFault('E_ACCOUNTING_RANGE', '后台请求保留次数只能为1');
        }
        for (const value of [command.attemptId, command.actionId, command.quotaScopeId]) requiredIdentity(value);
        const snapshotIdentity = typeof command.snapshotHash === 'string' && command.financialIntentId === undefined;
        const financialIdentity = typeof command.financialIntentId === 'string' && command.snapshotHash === undefined;
        if (!snapshotIdentity && !financialIdentity) throw new AgentFault('E_ACCOUNTING_IDENTITY', '费用预留必须选择一种固定请求身份');
        const reservationIdentity: ReservationIdentity = snapshotIdentity
            ? { snapshotHash: command.snapshotHash! } : { financialIntentId: command.financialIntentId! };
        requiredIdentity(snapshotIdentity ? command.snapshotHash! : command.financialIntentId!);
        if (financialIdentity && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(command.financialIntentId!)) {
            throw new AgentFault('E_ACCOUNTING_IDENTITY', '临时费用身份必须为独立随机UUID');
        }
        budget = budgetFor(state, command.rootBudgetId);
        const existing = state.reservations[key(command.attemptId)];
        if (existing) {
            if (existing.intentHash !== hash(command)) throw new AgentFault('E_ATTEMPT_CONFLICT', '同一尝试的预算或请求内容发生冲突');
            return { state, result: structuredClone({ budget, reservation: existing, replayed: true }) };
        }
        const rejectBudget = (code: string, message: string): never => {
            throw new AgentFault(command.foregroundCallFloor === 1 ? 'E_BACKGROUND_BUDGET_DEFERRED' : code, message,
                { budgetReservationRejected: true, acceptance: 'not_sent', phase: 'reserve', originalCode: code,
                    rootBudgetId: command.rootBudgetId, attemptId: command.attemptId });
        };
        if (financialIdentity && Object.values(state.reservations).some(entry => entry.financialIntentId === command.financialIntentId)) {
            throw new AgentFault('E_ATTEMPT_CONFLICT', '临时费用身份已用于其他尝试');
        }
        const upper = command.upperBound;
        const globalLimit = budget.quotaLimitId ? quotaLimitFor(state, budget.quotaLimitId) : null;
        if (!globalLimit && upper.source !== 'fixture') throw new AgentFault('E_GLOBAL_BUDGET_REQUIRED', '真实模型请求必须关联跨全部根任务的供应商总限额');
        if (globalLimit && (!globalLimit.quotaScopeIds.includes(command.quotaScopeId) || globalLimit.blockedReason || globalLimit.overdrawn)) {
            throw new AgentFault('E_GLOBAL_BUDGET_HALTED', '供应商总限额不可用于该账户或已经停止新增请求');
        }
        if (upper.currency !== budget.currency) throw new AgentFault('E_CURRENCY_MISMATCH', '请求计价币种与根预算不同');
        if (upper.amountMicros !== null && !exactAmount(upper.amountMicros)) throw new AgentFault('E_PRICE_UNKNOWN', '预留金额必须为非负整数微金额');
        if (!upper.sourceRef || (upper.expiresAt !== undefined && (!Number.isFinite(Date.parse(upper.expiresAt)) || Date.parse(upper.expiresAt) <= now))) {
            throw new AgentFault('E_PRICE_UNKNOWN', '费用上界缺少有效来源或已过期');
        }
        if (budget.mode === 'hard' && (upper.amountMicros === null || !upper.reliable || upper.source === 'estimated')) {
            throw new AgentFault('BUDGET_UNBOUNDED', '该动作缺少可靠费用上界，硬预算阻止付费');
        }
        if (globalLimit && (upper.amountMicros === null || !upper.reliable || upper.source === 'estimated')) {
            throw new AgentFault('BUDGET_UNBOUNDED', '供应商总限额为硬上限，根任务的estimated模式不能绕过可靠上界');
        }
        if (Date.parse(budget.deadlineAt) <= now) throw new AgentFault('E_BUDGET_DEADLINE', '根预算已经到期');
        if (budget.blockedReason) throw new AgentFault('E_BUDGET_HALTED', '该根预算已停止新增模型请求', { reason: budget.blockedReason });
        if (globalLimit && globalLimit.spentMicros + globalLimit.heldMicros + (upper.amountMicros ?? 0) > globalLimit.maxCostMicros) {
            rejectBudget('E_GLOBAL_BUDGET_EXCEEDED', '跨全部根任务的供应商总限额不足');
        }
        if (budget.overdrawn || budget.spentCalls + budget.heldCalls >= budget.maxModelCalls
            || (budget.maxCostMicros !== null && budget.spentMicros + budget.heldMicros + (upper.amountMicros ?? 0) > budget.maxCostMicros)) {
            rejectBudget('E_BUDGET_EXCEEDED', '根预算的金额或请求次数不足');
        }
        if (command.foregroundCallFloor === 1 && budget.spentCalls + budget.heldCalls + 2 > budget.maxModelCalls) {
            rejectBudget('E_BUDGET_EXCEEDED', '后台压缩延期，根预算保留最后一次普通调用');
        }
        const attempts = Object.values(state.reservations).filter(entry => entry.rootBudgetId === command.rootBudgetId && entry.actionId === command.actionId);
        if (attempts.length >= 3) throw new AgentFault('E_ATTEMPT_LIMIT', '同一动作最多提交三次尝试');
        reservation = { attemptId: command.attemptId, rootBudgetId: command.rootBudgetId, actionId: command.actionId,
            quotaScopeId: command.quotaScopeId, ...reservationIdentity, upperMicros: upper.amountMicros, originalUpperBound: structuredClone(upper),
            heldMicros: upper.amountMicros ?? 0, amountUnknown: upper.amountMicros === null || !upper.reliable,
            state: 'reserved', dispatched: false, callHeld: true, intentHash: hash(command),
            executionKey: `attempt:${command.attemptId}`, reportedExecutionId: null, chargeKeys: [], evidenceRef: null, version: 1, expiresAt: upper.expiresAt ?? null };
        state.reservations[key(command.attemptId)] = reservation;
        budget.version++;
    } else {
        reservation = state.reservations[key(command.attemptId)];
        if (!reservation) throw new AgentFault('E_RESERVATION_MISSING', '该尝试尚未完成费用预留');
        budget = budgetFor(state, reservation.rootBudgetId);
        if (command.type === 'dispatch') {
            if (reservation.state === 'dispatched') replayed = true;
            else {
                if (reservation.state !== 'reserved') throw new AgentFault('E_ATTEMPT_STATE', '该尝试已经发送或结束，不能再次发送');
                if (Date.parse(budget.deadlineAt) <= now || budget.overdrawn || budget.blockedReason) throw new AgentFault('E_BUDGET_EXCEEDED', '根预算已到期限、超额或停止新增请求');
                if (reservation.expiresAt && Date.parse(reservation.expiresAt) <= now) throw new AgentFault('E_PRICE_UNKNOWN', '实际发送前费用上界已过期');
                if (budget.quotaLimitId) {
                    const limit = quotaLimitFor(state, budget.quotaLimitId);
                    if (limit.blockedReason || limit.overdrawn) throw new AgentFault('E_GLOBAL_BUDGET_HALTED', '供应商总限额已停止新增请求');
                }
                reservation.dispatched = true;
                reservation.callHeld = false;
                reservation.state = 'dispatched';
            }
        } else if (command.type === 'unknown') {
            if (['settled', 'rejected'].includes(reservation.state)) throw new AgentFault('E_ATTEMPT_STATE', '已结算或证实未受理的尝试不能改为未知');
            reservation.state = 'unknown';
            reservation.amountUnknown = true;
            reservation.dispatched = true;
            reservation.callHeld = false;
        } else if (command.type === 'reject') {
            if (!command.evidenceRef) throw new AgentFault('E_ACCEPTANCE_EVIDENCE', '释放预留必须保留未受理证据');
            if (reservation.chargeKeys.length) throw new AgentFault('E_USAGE_CONFLICT', '已有费用事实的尝试需要对账，不能直接释放');
            reservation.state = 'rejected';
            reservation.amountUnknown = false;
            reservation.heldMicros = 0;
            reservation.callHeld = false;
            reservation.evidenceRef = command.evidenceRef;
        } else if (command.type === 'reconcile') {
            if (!command.evidenceRef) throw new AgentFault('E_ACCEPTANCE_EVIDENCE', '费用合并必须有供应商执行身份的查回证据');
            mergeExecution(state, reservation, command.providerExecutionId);
            reservation.evidenceRef = command.evidenceRef;
        } else if (command.type === 'settle') {
            if (!exactAmount(command.usageRevision) || command.usageRevision < 1 || reservation.state === 'rejected') {
                throw new AgentFault('E_USAGE_CONFLICT', 'usage版本或尝试状态无效');
            }
            const narrowed = command.postResponseUpperBound;
            if (narrowed) {
                if (narrowed.source !== 'frozen_price_usage' || narrowed.currency !== budget.currency
                    || narrowed.usageRevision !== command.usageRevision || !narrowed.sourceRef || !narrowed.priceVersion
                    || !exactAmount(narrowed.amountMicros) || reservation.upperMicros === null || narrowed.amountMicros > reservation.upperMicros
                    || !exactAmount(narrowed.inputTokens) || !exactAmount(narrowed.originalMaxOutputTokens) || narrowed.originalMaxOutputTokens < 1
                    || !exactAmount(narrowed.boundedRemainingTokens)
                    || (narrowed.reportedTotalTokens !== null && !exactAmount(narrowed.reportedTotalTokens))
                    || !['reported_total_tokens', 'original_output_cap'].includes(narrowed.method)
                    || (narrowed.method === 'reported_total_tokens' && (narrowed.reportedTotalTokens === null
                        || narrowed.reportedTotalTokens < narrowed.inputTokens
                        || narrowed.boundedRemainingTokens !== narrowed.reportedTotalTokens - narrowed.inputTokens))
                    || (narrowed.method === 'original_output_cap' && (narrowed.reportedTotalTokens !== null
                        || narrowed.boundedRemainingTokens !== narrowed.originalMaxOutputTokens))) {
                    throw new AgentFault('E_UPPER_BOUND_CONFLICT', '响应后费用上界缺少完整来源、usage版本或超过原始预留');
                }
                requiredIdentity(narrowed.sourceRef);
                requiredIdentity(narrowed.priceVersion);
                const previousBound = reservation.postResponseUpperBound;
                if (previousBound && (narrowed.usageRevision < previousBound.usageRevision
                    || narrowed.amountMicros > previousBound.amountMicros
                    || (narrowed.usageRevision === previousBound.usageRevision && hash(narrowed) !== hash(previousBound)))) {
                    throw new AgentFault('E_UPPER_BOUND_CONFLICT', '响应后费用上界只允许按新usage版本继续收紧，同版本重放须完全一致');
                }
                reservation.postResponseUpperBound = structuredClone(narrowed);
            }
            if (command.providerExecutionId) {
                reservation.reportedExecutionId = command.providerExecutionId;
                if (!reservation.quotaScopeId.startsWith('unverified-provider:')) mergeExecution(state, reservation, command.providerExecutionId);
            }
            if (reservation.state === 'settled' && !command.complete) throw new AgentFault('E_USAGE_CONFLICT', '已完成结算不能退回不完整结算');
            if (new Set(command.charges.map(charge => charge.component)).size !== command.charges.length) {
                throw new AgentFault('E_USAGE_CONFLICT', '同次结算的费用组件重复');
            }
            if (command.complete && (!command.charges.length || command.charges.some(charge => charge.amountMicros === null))) {
                throw new AgentFault('E_USAGE_INCOMPLETE', '未知费用仍需保留预留');
            }
            for (const charge of command.charges) {
                requiredIdentity(charge.component);
                if (charge.currency !== budget.currency) throw new AgentFault('E_CURRENCY_MISMATCH', '结算费用与根预算币种不同');
                if (charge.amountMicros !== null && !exactAmount(charge.amountMicros)) throw new AgentFault('E_PRICE_UNKNOWN', '结算金额超出精确整数范围');
                if (Buffer.byteLength(canonicalJson(charge.usage)) > 65_536) throw new AgentFault('E_USAGE_LIMIT', '费用usage元数据超过64KiB');
                const identity = chargeKey(reservation.quotaScopeId, reservation.executionKey, charge.component);
                const existing = state.charges[identity];
                if (existing) {
                    if (command.usageRevision < existing.usageRevision) throw new AgentFault('E_USAGE_STALE', 'usage补报版本已经过期');
                    if (command.usageRevision === existing.usageRevision) {
                        if (hash({ amount: charge.amountMicros, usage: charge.usage }) !== hash({ amount: existing.amountMicros, usage: existing.usage })) {
                            throw new AgentFault('E_USAGE_CONFLICT', '同一usage版本的费用内容冲突');
                        }
                        replayed = true;
                    } else {
                        if (existing.amountMicros !== null && charge.amountMicros === null) throw new AgentFault('E_USAGE_CONFLICT', '未知补报不能覆盖已有明确费用');
                        Object.assign(existing, { usageRevision: command.usageRevision, amountMicros: charge.amountMicros,
                            usage: charge.usage, kind: charge.kind });
                    }
                } else state.charges[identity] = { ...charge, quotaScopeId: reservation.quotaScopeId,
                    executionKey: reservation.executionKey, attemptId: reservation.attemptId, rootBudgetId: reservation.rootBudgetId,
                    usageRevision: command.usageRevision };
                if (!reservation.chargeKeys.includes(identity)) reservation.chargeKeys.push(identity);
            }
            reservation.chargeKeys = [...new Set([...reservation.chargeKeys, ...Object.entries(state.charges)
                .filter(([, charge]) => charge.quotaScopeId === reservation!.quotaScopeId && charge.executionKey === reservation!.executionKey)
                .map(([identity]) => identity)])];
            if (command.complete && reservation.chargeKeys.some(identity => state.charges[identity]?.amountMicros === null)) {
                throw new AgentFault('E_USAGE_INCOMPLETE', '仍有未知费用组件，继续保留预留');
            }
            releaseKnownCosts(state, reservation, command.complete);
            for (const related of Object.values(state.reservations)) {
                if (related.attemptId !== reservation.attemptId && related.quotaScopeId === reservation.quotaScopeId
                    && related.executionKey === reservation.executionKey && ['unsettled', 'unknown', 'dispatched'].includes(related.state)) {
                    related.chargeKeys = [...new Set([...related.chargeKeys, ...reservation.chargeKeys])];
                    releaseKnownCosts(state, related, command.complete);
                    related.version++;
                }
            }
        }
        reservation.version++;
        budget.version++;
    }
    refreshTotals(state);
    for (const [identity, updated] of Object.entries(state.budgets)) {
        const old = previous.budgets[identity];
        if (old) {
            const { version: oldVersion, ...oldValue } = old;
            const { version: _newVersion, ...newValue } = updated;
            updated.version = canonicalJson(oldValue) === canonicalJson(newValue) ? oldVersion : oldVersion + 1;
        }
    }
    for (const [identity, updated] of Object.entries(state.quotaLimits)) {
        const old = previous.quotaLimits?.[identity];
        if (old) {
            const { version: oldVersion, ...oldValue } = old;
            const { version: _newVersion, ...newValue } = updated;
            updated.version = canonicalJson(oldValue) === canonicalJson(newValue) ? oldVersion : oldVersion + 1;
        }
    }
    return { state, result: structuredClone({ budget, ...(budget.quotaLimitId ? { quotaLimit: quotaLimitFor(state, budget.quotaLimitId) } : {}),
        ...(reservation ? { reservation } : {}), replayed }) };
}

export class MemoryAccountingPort implements AccountingPort {
    private state: AccountingState;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(private readonly now: () => number = Date.now, initialState = emptyAccountingState()) {
        this.state = structuredClone(initialState);
    }

    execute(command: AccountingCommand): Promise<AccountingResult> {
        const copied = structuredClone(command);
        const result = this.queue.then(() => {
            const transition = applyAccountingCommand(this.state, copied, this.now());
            this.state = transition.state;
            return transition.result;
        });
        this.queue = result.catch(() => undefined);
        return result;
    }

    async read(rootBudgetId: string): Promise<BudgetView> {
        await this.queue;
        return structuredClone({ budget: budgetFor(this.state, rootBudgetId),
            reservations: Object.values(this.state.reservations).filter(entry => entry.rootBudgetId === rootBudgetId),
            charges: Object.values(this.state.charges).filter(entry => entry.rootBudgetId === rootBudgetId),
            quotaLimit: budgetFor(this.state, rootBudgetId).quotaLimitId ? quotaLimitFor(this.state, budgetFor(this.state, rootBudgetId).quotaLimitId!) : null });
    }

    async exportState(): Promise<AccountingState> { await this.queue; return structuredClone(this.state); }
}

export class BudgetLedger {
    constructor(readonly port: AccountingPort) {}
    create(definition: BudgetDefinition): Promise<AccountingResult> { return this.port.execute({ type: 'create_budget', definition }); }
    createQuotaLimit(definition: QuotaLimitDefinition): Promise<AccountingResult> { return this.port.execute({ type: 'create_quota_limit', definition }); }
    async getQuotaLimit(quotaLimitId: string): Promise<QuotaLimitRecord | null> {
        const result = await this.port.execute({ type: 'get_quota_limit', quotaLimitId });
        return result.quotaLimit ?? null;
    }
    async listQuotaLimits(): Promise<QuotaLimitRecord[]> {
        return (await this.port.execute({ type: 'get_quota_limit' })).quotaLimits ?? [];
    }
    haltQuotaLimit(quotaLimitId: string, reason: string, evidenceRef: string): Promise<AccountingResult> {
        return this.port.execute({ type: 'halt_quota_limit', quotaLimitId, reason, evidenceRef });
    }
    halt(rootBudgetId: string, reason: string, evidenceRef: string): Promise<AccountingResult> {
        return this.port.execute({ type: 'halt', rootBudgetId, reason, evidenceRef });
    }
    reserve(command: ReservationInput): Promise<AccountingResult> {
        return this.port.execute({ type: 'reserve', ...command });
    }
    dispatched(attemptId: string): Promise<AccountingResult> { return this.port.execute({ type: 'dispatch', attemptId }); }
    unknown(attemptId: string): Promise<AccountingResult> { return this.port.execute({ type: 'unknown', attemptId }); }
    reject(attemptId: string, acceptance: 'not_sent' | 'rejected', evidenceRef: string): Promise<AccountingResult> {
        return this.port.execute({ type: 'reject', attemptId, acceptance, evidenceRef });
    }
    settle(command: Omit<Extract<AccountingCommand, { type: 'settle' }>, 'type'>): Promise<AccountingResult> {
        return this.port.execute({ type: 'settle', ...command });
    }
    reconcile(attemptId: string, providerExecutionId: string, evidenceRef: string): Promise<AccountingResult> {
        return this.port.execute({ type: 'reconcile', attemptId, providerExecutionId, evidenceRef });
    }
    read(rootBudgetId: string): Promise<BudgetView> { return this.port.read(rootBudgetId); }
}
