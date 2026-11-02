import { AgentFault } from '../protocol.js';
import type { ProfileStore } from '../profiles/profile-store.js';
import type { DelegationCatalogPort } from '../delegation/children.js';
import { modelScope } from './catalog.js';
import type { ModelCatalog } from './catalog.js';
import { requireEvidence } from './evidence.js';

export function createDelegationCatalog(provider: {
    profiles: Pick<ProfileStore, 'get'>;
    models: Pick<ModelCatalog, 'get'>;
}, now: () => number = Date.now): DelegationCatalogPort {
    return { resolve: async (profileId, modelId) => {
        const profile = await provider.profiles.get(profileId);
        if (!profile) throw new AgentFault('E_PROFILE_NOT_FOUND', '内部派发选择的API配置不存在或已停用');
        const { catalog, entry } = await provider.models.get(profileId, modelId);
        const time = now();
        if (catalog.profileRevision !== profile.revision || Date.parse(catalog.expiresAt) <= time || entry.retired) {
            throw new AgentFault('E_CAPABILITY_UNKNOWN', '内部派发模型目录已过期、版本变化或模型已停用');
        }
        const scope = modelScope(profile, entry.modelId, entry.routeId);
        const maxOutputTokens = requireEvidence(entry.maxOutputTokens, scope, time);
        const effort = entry.parameters.reasoningEffort;
        const reasoningEfforts = effort?.status === 'supported'
            ? (requireEvidence(effort, scope, time).enum ?? []).filter((value): value is string => typeof value === 'string') : [];
        const capabilities = new Set<string>();
        for (const [direction, evidence] of [['input', entry.inputModalities], ['output', entry.outputModalities]] as const) {
            if (evidence.status !== 'supported') continue;
            for (const modality of requireEvidence(evidence, scope, time)) {
                capabilities.add(`${direction}:${modality}`);
                if (direction === 'input') capabilities.add(modality);
            }
        }
        for (const [name, evidence] of [['tools', entry.tools], ['streaming', entry.streaming]] as const) {
            if (evidence.status === 'supported' && requireEvidence(evidence, scope, time)) capabilities.add(name);
        }
        return { profileRevision: profile.revision, modelId: entry.modelId, reasoningEfforts,
            capabilities: [...capabilities], maxOutputTokens, available: reasoningEfforts.length > 0,
            quotaLimitId: profile.quotaLimitId ?? null, quotaScopeId: profile.quotaScopeId,
            currency: entry.pricing.status === 'supported' ? requireEvidence(entry.pricing, scope, time).currency : null };
    } };
}
