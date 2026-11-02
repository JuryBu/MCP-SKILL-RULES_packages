import { canonicalJson } from '../protocol.js';
import type { JsonObject } from '../protocol.js';
import { encodeGeminiCountTokensRequest } from '../providers/gemini.js';
import type { GeminiTokenCountResult } from '../providers/gemini-count-tokens.js';
import type { NativeSendView, ProviderProfile, ProviderProtocol } from '../providers/types.js';
import type { ContextEstimate, ContextViewEstimator, TokenCounter } from './contracts.js';
import { conservativeTextTokens, totalContextTokens } from './budget.js';
import { hashContext } from './config.js';
import { checkAbort, ContextFault } from './errors.js';

export interface ContextNativeTokenCountPort {
    countTokens(profileId: string, modelId: string, view: NativeSendView, signal: AbortSignal | undefined,
        deadlineAt: string, parameters?: JsonObject): Promise<GeminiTokenCountResult>;
}

export interface GeminiContextEstimatorOptions {
    counter: ContextNativeTokenCountPort;
    profile: Pick<ProviderProfile, 'profileId' | 'revision' | 'credentialGeneration' | 'protocol'>;
    modelId: string;
    adapterVersion: string;
    parameters?: JsonObject;
    deadlineAt: string;
    signal?: AbortSignal;
    countText?: boolean;
}

export function nativeViewHasMedia(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(nativeViewHasMedia);
    if (!value || typeof value !== 'object') return false;
    const object = value as Record<string, unknown>;
    if (typeof object.type === 'string' && (/^(?:input_|output_)?(?:image|audio|video|file)(?:_url|_data)?$/.test(object.type) || object.type === 'document')) return true;
    return Object.entries(object).some(([key, child]) => ['inlineData', 'inline_data', 'fileData', 'file_data', 'image_url', 'audio_url', 'dataBase64', 'input_audio'].includes(key)
        || nativeViewHasMedia(child));
}

export function estimateNativeTextView(view: NativeSendView, details: { baseView: NativeSendView; summaryTokens: number },
    countTokens: TokenCounter = conservativeTextTokens): ContextEstimate {
    if (nativeViewHasMedia(view)) return { rules: null, schema: null, native: null, summary: details.summaryTokens,
        retained: null, media: null, protocol: null, confidence: 'unknown' };
    const baseTokens = countTokens(canonicalJson(details.baseView));
    const schemaTokens = countTokens(canonicalJson(details.baseView.tools ?? []));
    return { rules: Math.max(0, baseTokens - schemaTokens), schema: schemaTokens,
        native: Math.max(0, countTokens(canonicalJson(view)) - baseTokens - details.summaryTokens), summary: details.summaryTokens,
        retained: 0, media: 0, protocol: 0, confidence: 'conservative' };
}

function canonicalModel(protocol: ProviderProtocol, modelId: string): string {
    return protocol === 'gemini' ? modelId.replace(/^models\//, '') : modelId;
}

export function validateContextEstimateForView(estimate: ContextEstimate, view: NativeSendView,
    target: { modelId: string; adapterVersion?: string }): void {
    const evidence = estimate.tokenCountEvidence;
    if (estimate.totalInputTokens === undefined && evidence === undefined) return;
    totalContextTokens(estimate);
    if (!evidence || evidence.protocol !== view.protocol || evidence.viewHash !== hashContext(view)
        || canonicalModel(view.protocol, evidence.modelId) !== canonicalModel(view.protocol, target.modelId)
        || (target.adapterVersion !== undefined && evidence.adapterVersion !== target.adapterVersion)) {
        throw new ContextFault('HISTORY_STALE', '原生计数与当前完整视图、模型或适配器版本不一致');
    }
}

export function createGeminiContextEstimator(options: GeminiContextEstimatorOptions): ContextViewEstimator {
    const identity = { profileId: options.profile.profileId, profileRevision: options.profile.revision,
        credentialGeneration: options.profile.credentialGeneration, modelId: canonicalModel('gemini', options.modelId),
        adapterVersion: options.adapterVersion, parametersHash: hashContext(options.parameters ?? {}), deadlineAt: options.deadlineAt };
    if (options.profile.protocol !== 'gemini' || !identity.profileId || !identity.modelId || !identity.adapterVersion
        || !Number.isFinite(Date.parse(identity.deadlineAt))) throw new ContextFault('CONFIG_INVALID', '原生视图计数需要明确的Gemini模型、配置版本和执行期限');
    return async (view, details) => {
        checkAbort(options.signal);
        if (view.protocol !== 'gemini') throw new ContextFault('PROTOCOL_INCOMPATIBLE', 'Gemini原生计数器需要Gemini完整发送视图');
        if (!options.countText && !nativeViewHasMedia(view)) return estimateNativeTextView(view, details);
        const viewHash = hashContext(view);
        const countRequestBodyHash = hashContext(encodeGeminiCountTokensRequest(view, identity.modelId, options.parameters));
        const result = await options.counter.countTokens(identity.profileId, identity.modelId, view, options.signal, identity.deadlineAt, options.parameters);
        checkAbort(options.signal);
        const source = result.source;
        const requestHash = hashContext({ method: 'POST', endpoint: source.endpoint, profileId: identity.profileId,
            profileRevision: identity.profileRevision, credentialGeneration: identity.credentialGeneration,
            modelId: identity.modelId, requestBodyHash: countRequestBodyHash });
        if (source.kind !== 'gemini_count_tokens' || source.profileId !== identity.profileId || source.profileRevision !== identity.profileRevision
            || source.credentialGeneration !== identity.credentialGeneration || source.modelId !== identity.modelId
            || source.requestBodyHash !== countRequestBodyHash || source.requestHash !== requestHash || source.deadlineAt !== identity.deadlineAt
            || result.raw.httpStatus < 200 || result.raw.httpStatus >= 300 || result.raw.json.totalTokens !== result.inputTokens
            || hashContext(view) !== viewHash) throw new ContextFault('HISTORY_STALE', '原生计数回执与完整输入或冻结配置不一致');
        const estimate: ContextEstimate = { rules: null, schema: null, native: null, summary: null, retained: null, media: null, protocol: null,
            confidence: 'actual', totalInputTokens: result.inputTokens, tokenCountEvidence: { source: 'provider_native_count_tokens',
                scope: 'complete_native_input', protocol: 'gemini', profileId: identity.profileId, profileRevision: identity.profileRevision,
                credentialGeneration: identity.credentialGeneration, modelId: identity.modelId, adapterVersion: identity.adapterVersion,
                viewHash, parametersHash: identity.parametersHash, requestHash, countRequestBodyHash, sourceRef: source.endpoint,
                observedAt: source.observedAt, deadlineAt: source.deadlineAt } };
        validateContextEstimateForView(estimate, view, identity);
        return estimate;
    };
}
