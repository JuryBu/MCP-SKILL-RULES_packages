import { createHash } from 'node:crypto';
import { canonicalJson } from '../protocol.js';
import type { CompressionModelSelection, ContextPolicy, FrozenCompressionConfig } from './contracts.js';
import { ContextFault } from './errors.js';

export const DEFAULT_CONTEXT_POLICY: Readonly<ContextPolicy> = Object.freeze({
    localContextWindowTokens: null,
    bpcThreshold: 0.68, hardThreshold: 0.90, keepCompleteRounds: 2, deltaSteps: 2,
    chunkInputTokens: 16_000, referenceTokens: 1_000, readFrameBytes: 256 * 1024,
    stableHeadBatches: 2, stableTailBatches: 1, middleSkeletonBatches: 20,
    foldAfterBatches: 24, maxActiveNodes: 8, cooldownMs: 180_000,
    immediateRetriggerSteps: 1, immediateRetriggerLimit: 2,
});

export function hashContext(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function hashBytes(value: Uint8Array | string): string {
    return createHash('sha256').update(value).digest('hex');
}

export function derivedContextId(value: unknown): string {
    const hash = hashContext(value);
    const variant = ((Number.parseInt(hash[16], 16) & 3) | 8).toString(16);
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function freezeValue<Value>(value: Value): Value {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        for (const child of Object.values(value)) freezeValue(child);
    }
    return value;
}

export function validateContextPolicy(overrides: Partial<ContextPolicy> = {}): ContextPolicy {
    for (const key of Object.keys(overrides)) {
        if (!(key in DEFAULT_CONTEXT_POLICY)) throw new ContextFault('CONFIG_INVALID', '未知上下文配置字段', { field: key });
    }
    const policy = { ...DEFAULT_CONTEXT_POLICY, ...overrides };
    if (policy.localContextWindowTokens !== null && (!Number.isSafeInteger(policy.localContextWindowTokens) || policy.localContextWindowTokens < 2048)) {
        throw new ContextFault('CONFIG_INVALID', '本地工作窗口须为空或至少2048 token的安全整数');
    }
    if (!Number.isFinite(policy.bpcThreshold) || !Number.isFinite(policy.hardThreshold)
        || !(0 < policy.bpcThreshold && policy.bpcThreshold < policy.hardThreshold && policy.hardThreshold < 1)) {
        throw new ContextFault('CONFIG_INVALID', '阈值须满足0 < BPC < hard < 1');
    }
    for (const [field, value] of Object.entries(policy)) {
        if (field.endsWith('Threshold') || field === 'localContextWindowTokens') continue;
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ContextFault('CONFIG_INVALID', '上下文配置须为非负安全整数', { field });
    }
    if (policy.chunkInputTokens < 64 || policy.referenceTokens >= policy.chunkInputTokens
        || policy.readFrameBytes < 4 || policy.readFrameBytes > 256 * 1024
        || policy.maxActiveNodes < policy.stableHeadBatches + policy.stableTailBatches + 1
        || policy.foldAfterBatches < policy.maxActiveNodes || policy.immediateRetriggerLimit < 1) {
        throw new ContextFault('CONFIG_INVALID', '分块、读取或分层配置无法形成有效发送视图');
    }
    return policy;
}

export function policyWarnings(policy: ContextPolicy): string[] {
    return [policy.hardThreshold - policy.bpcThreshold < 0.20 ? '压缩阈值间隔小于0.20' : '',
        policy.bpcThreshold < 0.40 ? 'BPC阈值低于0.40' : ''].filter(Boolean);
}

export function freezeCompressionConfig(input: {
    currentModel: CompressionModelSelection;
    globalModel?: CompressionModelSelection | null;
    conversationModel?: CompressionModelSelection | null;
    policy?: Partial<ContextPolicy>;
    revision: number;
    rules?: string;
}): FrozenCompressionConfig {
    const modelSource = input.conversationModel ? 'conversation' : input.globalModel ? 'global' : 'current';
    const model = structuredClone(input.conversationModel ?? input.globalModel ?? input.currentModel);
    if (!Number.isSafeInteger(input.revision) || input.revision < 0
        || !Number.isSafeInteger(model.contextWindow) || !Number.isSafeInteger(model.maxOutputTokens)
        || model.contextWindow < 1 || model.maxOutputTokens < 1
        || model.maxOutputTokens >= model.contextWindow || !model.provider || !model.model || !model.adapterVersion
        || !model.endpoint || !model.protocol || !model.accountFingerprint
        || !Number.isSafeInteger(model.profileRevision) || !Number.isSafeInteger(model.credentialGeneration)) {
        throw new ContextFault('CONFIG_INVALID', '压缩模型配置或有效窗口不完整');
    }
    const policy = validateContextPolicy(input.policy);
    const rules = input.rules ?? 'Summarize only target sources. Preserve unresolved requirements verbatim with source anchors. References are context only. Return body, skeleton, title and unresolved anchors.';
    const modelFingerprint = hashContext(model);
    const configFingerprint = hashContext({ policy, modelFingerprint, rules, revision: input.revision });
    return freezeValue({ policy, model, modelSource, modelFingerprint, configFingerprint, revision: input.revision, rules });
}
