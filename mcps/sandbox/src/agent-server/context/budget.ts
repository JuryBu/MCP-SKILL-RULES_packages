import type { ContextEstimate, ContextLimits, ContextPolicy, ConversationContextLimits, TokenCounter } from './contracts.js';
import { ContextFault } from './errors.js';
import { hashContext } from './config.js';

export const conservativeTextTokens: TokenCounter = text => Buffer.byteLength(text, 'utf8');

export function computeContextLimits(contextWindow: number, outputReserve: number, policy: ContextPolicy): ContextLimits {
    if (!Number.isSafeInteger(contextWindow) || !Number.isSafeInteger(outputReserve) || contextWindow < 1 || outputReserve < 1) {
        throw new ContextFault('CONFIG_INVALID', '模型窗口和实际最大输出须为正安全整数');
    }
    const margin = Math.max(1024, Math.ceil(0.03 * contextWindow));
    const inputBudget = Math.min(Math.floor(policy.hardThreshold * contextWindow), contextWindow - outputReserve - margin);
    const summaryBudget = Math.min(Math.floor(0.30 * contextWindow), Math.floor(0.40 * inputBudget));
    const target = Math.min(Math.floor(0.60 * contextWindow), inputBudget - margin);
    if (inputBudget <= 0 || target <= 0 || summaryBudget <= 0) throw new ContextFault('CONFIG_INVALID', '输出预留和安全余量已占满窗口');
    return { contextWindow, outputReserve, margin, inputBudget, summaryBudget, target };
}

export function computeConversationContextLimits(providerContextWindow: number, outputReserve: number, policy: ContextPolicy): ConversationContextLimits {
    const localContextWindowTokens = policy.localContextWindowTokens;
    if (localContextWindowTokens !== null && (!Number.isSafeInteger(localContextWindowTokens) || localContextWindowTokens < 2048)) {
        throw new ContextFault('CONFIG_INVALID', '本地工作窗口须为空或至少2048 token的安全整数');
    }
    if (!Number.isSafeInteger(providerContextWindow) || providerContextWindow < 1) throw new ContextFault('CONFIG_INVALID', '供应商窗口需要可核实的正安全整数');
    const contextWindow = localContextWindowTokens === null ? providerContextWindow : Math.min(providerContextWindow, localContextWindowTokens);
    return { ...computeContextLimits(contextWindow, outputReserve, policy), providerContextWindow, localContextWindowTokens,
        windowSource: localContextWindowTokens !== null && localContextWindowTokens < providerContextWindow ? 'local' : 'provider' };
}

export function totalContextTokens(estimate: ContextEstimate): number {
    if (estimate.confidence === 'unknown') {
        throw new ContextFault('CONFIG_INVALID', '最终请求包含未知窗口占用，需要能力数据或明确保守上界', { estimateConfidence: 'unknown' });
    }
    if (estimate.totalInputTokens !== undefined || estimate.tokenCountEvidence !== undefined) {
        const evidence = estimate.tokenCountEvidence;
        if (estimate.confidence !== 'actual' || !Number.isSafeInteger(estimate.totalInputTokens) || Number(estimate.totalInputTokens) < 1
            || !evidence || evidence.source !== 'provider_native_count_tokens' || evidence.scope !== 'complete_native_input'
            || !evidence.profileId || !evidence.modelId || !evidence.adapterVersion || !evidence.sourceRef
            || !Number.isSafeInteger(evidence.profileRevision) || evidence.profileRevision < 0
            || !Number.isSafeInteger(evidence.credentialGeneration) || evidence.credentialGeneration < 0
            || !['viewHash', 'parametersHash', 'requestHash', 'countRequestBodyHash'].every(field => /^[a-f0-9]{64}$/.test(String(evidence[field as keyof typeof evidence])))
            || !Number.isFinite(Date.parse(evidence.observedAt)) || !Number.isFinite(Date.parse(evidence.deadlineAt))
            || Date.parse(evidence.observedAt) > Date.parse(evidence.deadlineAt)) {
            throw new ContextFault('CONFIG_INVALID', '完整输入计数需要原生计数回执、请求指纹和有效来源');
        }
        return estimate.totalInputTokens!;
    }
    let total = 0;
    for (const field of ['rules', 'schema', 'native', 'summary', 'retained', 'media', 'protocol'] as const) {
        const amount = estimate[field];
        if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) {
            throw new ContextFault('CONFIG_INVALID', '请求占用估计须为非负安全整数', { field });
        }
        total += amount;
    }
    if (!Number.isSafeInteger(total)) throw new ContextFault('CONFIG_INVALID', '最终请求占用超出可表示范围');
    return total;
}

export function checkContextGate(estimate: ContextEstimate, limits: ContextLimits): { allowed: boolean; inputTokens: number; remaining: number } {
    const inputTokens = totalContextTokens(estimate);
    return { allowed: inputTokens < limits.inputBudget, inputTokens, remaining: limits.inputBudget - inputTokens };
}

export function backgroundTriggerTokens(limits: ContextLimits, policy: ContextPolicy): number {
    return Math.max(1, Math.min(limits.inputBudget - 1, Math.floor(policy.bpcThreshold * limits.contextWindow),
        Math.floor(limits.inputBudget * policy.bpcThreshold / policy.hardThreshold)));
}

export interface UsageIdentity {
    attemptId: string;
    bodyHash: string;
    modelFingerprint: string;
    adapterVersion: string;
    modality: string;
}

export class ContextUsageTracker {
    private readonly attempts = new Map<string, { identity: UsageIdentity; estimated: number; actual: number | null; cacheRead: number | null; cacheWrite: number | null }>();

    record(identity: UsageIdentity, estimated: number, usage: { inputTokens: number | null; cacheRead: number | null; cacheWrite: number | null }): void {
        for (const amount of [estimated, usage.inputTokens, usage.cacheRead, usage.cacheWrite]) {
            if (amount !== null && (!Number.isSafeInteger(amount) || amount < 0)) throw new ContextFault('USAGE_MISMATCH', 'usage数量无效', { attemptId: identity.attemptId });
        }
        const previous = this.attempts.get(identity.attemptId);
        if (previous && (hashContext(previous.identity) !== hashContext(identity)
            || (previous.actual !== null && usage.inputTokens !== null && previous.actual !== usage.inputTokens))) {
            throw new ContextFault('USAGE_MISMATCH', 'usage与原attempt身份或已确认数量冲突', { attemptId: identity.attemptId });
        }
        this.attempts.set(identity.attemptId, { identity: { ...identity }, estimated,
            actual: usage.inputTokens ?? previous?.actual ?? null,
            cacheRead: usage.cacheRead ?? previous?.cacheRead ?? null, cacheWrite: usage.cacheWrite ?? previous?.cacheWrite ?? null });
    }

    coefficient(bucket: Pick<UsageIdentity, 'modelFingerprint' | 'adapterVersion' | 'modality'>): number {
        const errors = [...this.attempts.values()].filter(entry => entry.identity.modelFingerprint === bucket.modelFingerprint
            && entry.identity.adapterVersion === bucket.adapterVersion && entry.identity.modality === bucket.modality
            && entry.actual !== null && entry.estimated > 0).map(entry => entry.actual! / entry.estimated).sort((left, right) => left - right);
        return errors.length < 20 ? 1.15 : Math.max(1, errors[Math.ceil(errors.length * 0.95) - 1]);
    }

    exact(identity: UsageIdentity): number | null {
        const entry = this.attempts.get(identity.attemptId);
        if (!entry || hashContext(entry.identity) !== hashContext(identity)) return null;
        return entry.actual;
    }
}
