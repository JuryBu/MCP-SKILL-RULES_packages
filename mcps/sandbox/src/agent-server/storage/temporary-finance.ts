import { AgentFault, canonicalJson } from '../protocol.js';
import type { UpperBound, ChargeInput, PostResponseUpperBound } from '../accounting/budget-ledger.js';
import { sha256 } from './objects.js';

export interface TemporaryFinancialIntent {
    ownerInstanceId: string;
    financialIntentId: string;
    dispatchNonce: string;
    attemptId: string;
    rootBudgetId: string;
    actionId: string;
    quotaScopeId: string;
    conversationId: string;
    runId: string;
    runEpoch: number;
    historyEpoch: number;
    fenceRevision: number;
    foregroundCallFloor?: 1;
}

export interface TemporaryRunFence {
    ownerInstanceId: string;
    conversationId: string;
    runId: string;
    runEpoch: number;
    historyEpoch: number;
    active: boolean;
    revision: number;
}

export interface TemporaryFeeUsage {
    basis: 'frozen_price_reported_usage' | 'provider_reported_cost' | 'incomplete';
    priceFingerprint: string | null;
    sourceFingerprint: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    reasoningTokens: number | null;
}

export interface TemporaryFeeCharge extends Omit<ChargeInput, 'usage'> {
    usage: TemporaryFeeUsage;
}

export interface TemporaryFeeSettlement {
    intent: TemporaryFinancialIntent;
    usageRevision: number;
    providerExecutionId: string | null;
    complete: boolean;
    charges: TemporaryFeeCharge[];
    postResponseUpperBound?: PostResponseUpperBound;
}

export interface TemporaryFeeFailure {
    intent: TemporaryFinancialIntent;
    acceptance: 'not_sent' | 'rejected' | 'accepted' | 'unknown';
    code: string;
}

export interface TemporaryFinancialAttempt {
    intent: TemporaryFinancialIntent;
    upperBound: UpperBound;
    state: 'dispatching' | 'committed' | 'unknown' | 'rejected';
}

export type TemporaryFeeCommand =
    | { type: 'prepare'; intent: TemporaryFinancialIntent; upperBound: UpperBound }
    | { type: 'settle'; settlement: TemporaryFeeSettlement }
    | { type: 'failure'; failure: TemporaryFeeFailure }
    | { type: 'fence'; fence: TemporaryRunFence }
    | { type: 'close_owner'; ownerInstanceId: string };

export type TemporaryFeeResult = { status: 'send' | 'already_dispatching' | 'unknown' | 'rejected' }
    | { status: 'committed'; fenceLive: boolean; replayed: boolean }
    | { status: 'updated' };

export function exactFields(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !(key in value))) {
        throw new AgentFault('TEMPORARY_FINANCE_INVALID', '临时费用记录只接受明确列出的最小费用字段');
    }
}

export function financialId(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.:@/+=-]{1,256}$/.test(value)) {
        throw new AgentFault('TEMPORARY_FINANCE_INVALID', '临时费用身份格式无效');
    }
}

function epoch(value: unknown): void {
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw new AgentFault('TEMPORARY_FINANCE_INVALID', '临时代次必须为正安全整数');
}

export function validateTemporaryIntent(intent: TemporaryFinancialIntent): void {
    exactFields(intent, ['ownerInstanceId', 'financialIntentId', 'dispatchNonce', 'attemptId', 'rootBudgetId', 'actionId',
        'quotaScopeId', 'conversationId', 'runId', 'runEpoch', 'historyEpoch', 'fenceRevision',
        ...(Object.hasOwn(intent, 'foregroundCallFloor') ? ['foregroundCallFloor'] : [])]);
    for (const [key, value] of Object.entries(intent)) if (key === 'runEpoch' || key === 'historyEpoch' || key === 'fenceRevision') epoch(value);
    else if (key === 'foregroundCallFloor') {
        if (value !== 1) throw new AgentFault('TEMPORARY_FINANCE_INVALID', '后台费用意图保留次数只能为1');
    }
    else financialId(value);
    for (const value of [intent.ownerInstanceId, intent.financialIntentId, intent.dispatchNonce]) {
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) {
            throw new AgentFault('TEMPORARY_FINANCE_INVALID', '临时费用能力标识必须是独立随机UUID');
        }
    }
}

export function validateTemporaryFence(fence: TemporaryRunFence): void {
    exactFields(fence, ['ownerInstanceId', 'conversationId', 'runId', 'runEpoch', 'historyEpoch', 'active', 'revision']);
    financialId(fence.ownerInstanceId); financialId(fence.conversationId); financialId(fence.runId);
    epoch(fence.runEpoch); epoch(fence.historyEpoch); epoch(fence.revision);
    if (typeof fence.active !== 'boolean') throw new AgentFault('TEMPORARY_FINANCE_INVALID', '临时代次状态无效');
}

export function minimalUpperBound(upper: UpperBound): UpperBound {
    if (typeof upper.sourceRef !== 'string' || !upper.sourceRef
        || (upper.expiresAt !== undefined && !Number.isFinite(Date.parse(upper.expiresAt)))) {
        throw new AgentFault('E_PRICE_UNKNOWN', '临时费用上界缺少有效来源或期限');
    }
    return { currency: upper.currency, amountMicros: upper.amountMicros, reliable: upper.reliable, source: upper.source,
        sourceRef: `sha256:${sha256(upper.sourceRef)}`,
        ...(upper.expiresAt ? { expiresAt: new Date(upper.expiresAt).toISOString() } : {}) };
}

export function validateTemporaryUpperBound(upper: UpperBound): void {
    const fields = ['currency', 'amountMicros', 'reliable', 'source', 'sourceRef'];
    exactFields(upper, upper.expiresAt === undefined ? fields : [...fields, 'expiresAt']);
    if (!/^[A-Z]{3}$/.test(upper.currency) || (upper.amountMicros !== null && (!Number.isSafeInteger(upper.amountMicros) || upper.amountMicros < 0))
        || typeof upper.reliable !== 'boolean' || !['price_table', 'account_cap', 'fixture', 'estimated'].includes(upper.source)
        || !/^sha256:[a-f0-9]{64}$/.test(upper.sourceRef)
        || (upper.expiresAt !== undefined && (!Number.isFinite(Date.parse(upper.expiresAt)) || new Date(upper.expiresAt).toISOString() !== upper.expiresAt))) {
        throw new AgentFault('TEMPORARY_FINANCE_INVALID', '临时费用上界只接受金额、币种和不含原文的来源指纹');
    }
}

export function validateTemporarySettlement(settlement: TemporaryFeeSettlement): void {
    const fields = ['intent', 'usageRevision', 'providerExecutionId', 'complete', 'charges'];
    exactFields(settlement, settlement.postResponseUpperBound ? [...fields, 'postResponseUpperBound'] : fields);
    validateTemporaryIntent(settlement.intent);
    epoch(settlement.usageRevision);
    if (settlement.providerExecutionId !== null) financialId(settlement.providerExecutionId);
    if (typeof settlement.complete !== 'boolean' || !Array.isArray(settlement.charges) || settlement.charges.length > 8) {
        throw new AgentFault('TEMPORARY_FINANCE_INVALID', '临时费用结算状态或组件数量无效');
    }
    for (const charge of settlement.charges) {
        exactFields(charge, ['component', 'amountMicros', 'currency', 'kind', 'usage']);
        if (charge.component !== 'model_usage' || !['calculated', 'provider_reported'].includes(charge.kind)
            || !/^[A-Z]{3}$/.test(charge.currency) || (charge.amountMicros !== null && (!Number.isSafeInteger(charge.amountMicros) || charge.amountMicros < 0))) {
            throw new AgentFault('TEMPORARY_FINANCE_INVALID', '临时费用组件无效');
        }
        const usage = charge.usage;
        exactFields(usage, ['basis', 'priceFingerprint', 'sourceFingerprint', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']);
        if (!['frozen_price_reported_usage', 'provider_reported_cost', 'incomplete'].includes(usage.basis)) {
            throw new AgentFault('TEMPORARY_FINANCE_INVALID', '临时费用计算依据无效');
        }
        for (const [key, value] of Object.entries(usage)) {
            if (key === 'basis') continue;
            if (key.endsWith('Fingerprint')) {
                if (value !== null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
                    throw new AgentFault('TEMPORARY_FINANCE_INVALID', '临时费用来源指纹无效');
                }
            } else if (value !== null && (!Number.isSafeInteger(value) || Number(value) < 0)) {
                throw new AgentFault('TEMPORARY_FINANCE_INVALID', '临时用量只接受非负整数计数');
            }
        }
    }
    if (settlement.postResponseUpperBound) {
        const bound = settlement.postResponseUpperBound;
        exactFields(bound, ['amountMicros', 'currency', 'source', 'sourceRef', 'priceVersion', 'usageRevision',
            'inputTokens', 'originalMaxOutputTokens', 'boundedRemainingTokens', 'reportedTotalTokens', 'method']);
        if (bound.source !== 'frozen_price_usage' || !/^[A-Z]{3}$/.test(bound.currency)
            || !/^sha256:[a-f0-9]{64}$/.test(bound.sourceRef) || !/^sha256:[a-f0-9]{64}$/.test(bound.priceVersion)
            || bound.usageRevision !== settlement.usageRevision || !['reported_total_tokens', 'original_output_cap'].includes(bound.method)) {
            throw new AgentFault('TEMPORARY_FINANCE_INVALID', '临时响应后上界只接受冻结价格的费用来源指纹');
        }
        for (const value of [bound.amountMicros, bound.inputTokens, bound.originalMaxOutputTokens, bound.boundedRemainingTokens, bound.reportedTotalTokens]) {
            if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new AgentFault('TEMPORARY_FINANCE_INVALID', '临时响应后上界的计数无效');
        }
    }
    if (Buffer.byteLength(canonicalJson(settlement)) > 16 * 1024) throw new AgentFault('TEMPORARY_FINANCE_INVALID', '临时费用结算元数据超过上限');
}
