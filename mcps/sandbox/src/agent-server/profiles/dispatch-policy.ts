import { ProviderFault } from '../providers/types.js';
import type { ProviderProfile } from '../providers/types.js';

export interface ProfileSpend {
    amountMicros: number | null;
    currency: string;
    status: 'known' | 'partial' | 'unknown';
    sourceRef: string;
    observedAt: string;
}

export interface ProfileDispatchDecision {
    allowed: boolean;
    reason: 'allowed' | 'disabled' | 'expired' | 'cost_limit' | 'cost_unresolved';
    expiresAt: string | null;
    scope: 'local_profile_new_dispatch';
}

export function evaluateProfileDispatchPolicy(profile: ProviderProfile, spend?: ProfileSpend, now = Date.now()): ProfileDispatchDecision {
    const policy = profile.dispatchPolicy;
    const result = (reason: ProfileDispatchDecision['reason']): ProfileDispatchDecision => ({ allowed: reason === 'allowed', reason,
        expiresAt: policy?.expiresAt ?? null, scope: 'local_profile_new_dispatch' });
    if (policy?.enabled === false) return result('disabled');
    if (policy?.expiresAt && (!Number.isFinite(Date.parse(policy.expiresAt)) || Date.parse(policy.expiresAt) <= now)) return result('expired');
    const limit = policy?.maxCumulativeCost;
    if (limit) {
        if (!Number.isSafeInteger(limit.amountMicros) || limit.amountMicros < 0 || !/^[A-Z]{3}$/.test(limit.currency)
            || !spend || spend.currency !== limit.currency || spend.amountMicros === null
            || !Number.isSafeInteger(spend.amountMicros) || spend.amountMicros < 0 || !spend.sourceRef
            || !Number.isFinite(Date.parse(spend.observedAt)) || Date.parse(spend.observedAt) > now) return result('cost_unresolved');
        if (spend.amountMicros >= limit.amountMicros) return result('cost_limit');
        if (spend.status !== 'known') return result('cost_unresolved');
    }
    return result('allowed');
}

export function assertProfileCanSend(profile: ProviderProfile, spend?: ProfileSpend, now = Date.now()): void {
    const decision = evaluateProfileDispatchPolicy(profile, spend, now);
    if (decision.allowed) return;
    const descriptions = { disabled: '此API配置已在本地停止新请求', expired: '此API配置已达到所设到期时间',
        cost_limit: '此API配置已达到所设累计费用', cost_unresolved: '此API配置设置了累计费用停止条件，现有费用仍待核实' };
    throw new ProviderFault(`E_PROFILE_${decision.reason.toUpperCase()}`, descriptions[decision.reason as keyof typeof descriptions], { acceptance: 'not_sent' });
}
