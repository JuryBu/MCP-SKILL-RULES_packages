import type { JsonObject } from '../protocol.js';
import { objectValue } from '../providers/assemble.js';
import type { ProviderProfile } from '../providers/types.js';
import type { ModelEntry, ParameterSpec } from './catalog.js';
import type { Evidence } from './evidence.js';
import { validateEvidence } from './evidence.js';
import { validatePrice } from '../accounting/usage.js';
import type { PriceEntry } from '../accounting/usage.js';
import { enrichDeepSeekCatalogEntry } from './deepseek.js';

const parameterSource = 'https://openrouter.ai/docs/api_reference/parameters';
const documentObservedAt = '2026-11-04T07:26:00.000Z';
const documentExpiresAt = '2026-11-11T07:26:00.000Z';
const contractReviewedAt = '2026-11-13T05:12:00.000Z';

function currentMetadataExpiry(profile: ProviderProfile, entry: ModelEntry, now: number): string | null {
    if (profile.routePolicy.kind !== 'direct' || entry.routeId !== null || entry.protocol !== profile.protocol
        || entry.retired || entry.rawMetadata.id !== entry.modelId) return null;
    const endpoint = profile.baseUrl.replace(/\/+$/, '');
    const evidence = [entry.contextWindow, entry.maxOutputTokens];
    try {
        for (const item of evidence) {
            validateEvidence(item);
            if (item.source !== 'api' || item.scope.endpoint !== endpoint || item.scope.modelId !== entry.modelId
                || item.scope.routeId !== null || Date.parse(item.observedAt) > now || Date.parse(item.expiresAt) <= now) return null;
        }
    } catch { return null; }
    return new Date(Math.min(...evidence.map(item => Date.parse(item.expiresAt)))).toISOString();
}

function evidenceWithValue<Value>(base: Evidence<unknown>, value: Value): Evidence<Value> {
    return { source: base.source, sourceRef: base.sourceRef, observedAt: base.observedAt, expiresAt: base.expiresAt,
        scope: base.scope, version: base.version, confidence: base.confidence, value, status: 'supported' };
}

function parameterSpec(value: unknown): ParameterSpec | null {
    const item = objectValue(value);
    if (!item || !['number', 'integer', 'string', 'boolean', 'object', 'array'].includes(String(item.type))
        || typeof item.wirePath !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(item.wirePath)
        || (['object', 'array'].includes(String(item.type)) && !objectValue(item.schema))
        || (item.min !== undefined && (typeof item.min !== 'number' || !Number.isFinite(item.min)))
        || (item.max !== undefined && (typeof item.max !== 'number' || !Number.isFinite(item.max)))
        || (typeof item.min === 'number' && typeof item.max === 'number' && item.min > item.max)
        || (item.enum !== undefined && !Array.isArray(item.enum))) return null;
    return item as unknown as ParameterSpec;
}

export function normalizeExplicitMetadata(entry: ModelEntry): ModelEntry {
    const base = entry.contextWindow;
    const declared = <Value>(value: Value): Evidence<Value> => evidenceWithValue(base, value);
    const capabilities = objectValue(entry.rawMetadata.capabilities);
    const parameters = { ...entry.parameters };
    const definitions = objectValue(entry.rawMetadata.parameters);
    for (const [name, value] of Object.entries(definitions ?? {})) {
        const specification = parameterSpec(value);
        if (specification && parameters[name]?.status !== 'unsupported') parameters[name] = declared(specification);
    }
    let pricing = entry.pricing;
    const rawPrice = objectValue(entry.rawMetadata.pricing);
    if (pricing.status !== 'unsupported' && rawPrice && typeof rawPrice.currency === 'string' && typeof rawPrice.reasoningBilledSeparately === 'boolean'
        && ['included_in_tokens', 'separate', 'unknown'].includes(String(rawPrice.media))
        && ['disabled', 'separate', 'unknown'].includes(String(rawPrice.serverTools))
        && ['inputUncached', 'inputCacheRead', 'inputCacheWrite', 'output'].every(name => Object.hasOwn(rawPrice, name))) {
        try {
            validatePrice(rawPrice as unknown as PriceEntry, Date.parse(base.observedAt));
            pricing = declared(rawPrice as unknown as PriceEntry);
        } catch {}
    }
    const positiveCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
    const modalities = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0
        && value.every(item => typeof item === 'string' && item.trim());
    return { ...entry, parameters, pricing,
        ...(entry.contextWindow.status !== 'unsupported' && positiveCount(entry.rawMetadata.context_window) ? { contextWindow: declared(entry.rawMetadata.context_window) } : {}),
        ...(entry.maxOutputTokens.status !== 'unsupported' && positiveCount(entry.rawMetadata.max_output_tokens) ? { maxOutputTokens: declared(entry.rawMetadata.max_output_tokens) } : {}),
        ...(entry.inputModalities.status !== 'unsupported' && modalities(entry.rawMetadata.input_modalities) ? { inputModalities: declared(entry.rawMetadata.input_modalities) } : {}),
        ...(entry.outputModalities.status !== 'unsupported' && modalities(entry.rawMetadata.output_modalities) ? { outputModalities: declared(entry.rawMetadata.output_modalities) } : {}),
        ...(entry.tools.status !== 'unsupported' && typeof capabilities?.tools === 'boolean' ? { tools: declared(capabilities.tools) } : {}),
        ...(entry.streaming.status !== 'unsupported' && typeof capabilities?.streaming === 'boolean' ? { streaming: declared(capabilities.streaming) } : {}) };
}

export function normalizeGeminiMetadata(entry: ModelEntry): ModelEntry {
    const metadata = entry.rawMetadata;
    const parameters = { ...entry.parameters };
    const proof = <Value>(value: Value): Evidence<Value> => evidenceWithValue(entry.contextWindow, value);
    const maximum = entry.maxOutputTokens.value;
    if (maximum !== null && entry.maxOutputTokens.status === 'supported') {
        parameters.maxOutputTokens ??= proof({ type: 'integer', min: 1, max: maximum, wirePath: 'generationConfig.maxOutputTokens' });
    }
    if (typeof metadata.temperature === 'number' && Number.isFinite(metadata.temperature)
        && typeof metadata.maxTemperature === 'number' && Number.isFinite(metadata.maxTemperature)
        && metadata.temperature >= 0 && metadata.temperature <= metadata.maxTemperature) {
        parameters.temperature ??= proof({ type: 'number', min: 0, max: metadata.maxTemperature,
            default: metadata.temperature, wirePath: 'generationConfig.temperature' });
    }
    if (typeof metadata.topP === 'number' && Number.isFinite(metadata.topP) && metadata.topP >= 0 && metadata.topP <= 1) {
        parameters.topP ??= proof({ type: 'number', min: 0, max: 1, default: metadata.topP, wirePath: 'generationConfig.topP' });
    }
    if (typeof metadata.topK === 'number' && Number.isSafeInteger(metadata.topK) && metadata.topK > 0) {
        parameters.topK ??= proof({ type: 'integer', min: 1, default: metadata.topK, wirePath: 'generationConfig.topK' });
    }
    const methods = Array.isArray(metadata.supportedGenerationMethods) ? metadata.supportedGenerationMethods : [];
    return { ...entry, parameters,
        ...(typeof metadata.thinking === 'boolean' ? { thinking: proof(metadata.thinking) } : {}),
        ...(methods.includes('streamGenerateContent') ? { streaming: proof(true) } : {}) };
}

function normalizeAnthropicMetadata(profile: ProviderProfile, entry: ModelEntry, endpoint: URL, now: number): ModelEntry {
    const observedAt = '2026-11-04T16:22:00.000Z';
    const expiresAt = '2026-11-11T16:22:00.000Z';
    const observed = Date.parse(entry.contextWindow.observedAt);
    const reviewed = now >= Date.parse(contractReviewedAt) && observed >= Date.parse(expiresAt);
    if (profile.protocol !== 'anthropic' || endpoint.hostname !== 'api.anthropic.com'
        || endpoint.pathname.replace(/\/+$/, '') !== '/v1'
        || (!reviewed && (observed < Date.parse(observedAt) || observed >= Date.parse(expiresAt)))) return entry;
    if (reviewed && entry.rawMetadata.lifecycle === 'retired') return { ...entry, retired: true };
    const apiExpiresAt = reviewed ? currentMetadataExpiry(profile, entry, now) : null;
    if (reviewed && (!apiExpiresAt || entry.rawMetadata.type !== 'model')) return entry;
    const proof = <Value>(value: Value, source: 'api' | 'official_doc' = 'api'): Evidence<Value> => ({ ...evidenceWithValue(entry.contextWindow, value), source,
        ...(apiExpiresAt ? { expiresAt: apiExpiresAt } : {}),
        ...(source === 'official_doc' ? { sourceRef: 'https://platform.claude.com/docs/en/build-with-claude/streaming',
            observedAt: reviewed ? contractReviewedAt : observedAt,
            expiresAt: apiExpiresAt ?? new Date(Math.min(Date.parse(entry.contextWindow.expiresAt), Date.parse(expiresAt))).toISOString(),
            version: reviewed ? 'anthropic-streaming-contract-2026-11-13' : 'anthropic-streaming-2026-11-05' } : {}) });
    const capabilities = objectValue(entry.rawMetadata.capabilities);
    const image = objectValue(capabilities?.image_input)?.supported;
    const pdf = objectValue(capabilities?.pdf_input)?.supported;
    const maximum = entry.rawMetadata.max_tokens;
    const input = entry.rawMetadata.max_input_tokens;
    const parameters = { ...entry.parameters };
    if (typeof maximum === 'number' && Number.isSafeInteger(maximum) && maximum > 0 && !parameters.maxOutputTokens
        && (!reviewed || entry.maxOutputTokens.status !== 'unsupported')) {
        parameters.maxOutputTokens = proof({ type: 'integer', min: 1, max: maximum, wirePath: 'max_tokens', required: true });
    }
    return { ...entry, parameters, contextLimitMode: 'separate',
        displayName: typeof entry.rawMetadata.display_name === 'string' ? entry.rawMetadata.display_name : entry.displayName,
        ...(typeof input === 'number' && Number.isSafeInteger(input) && input > 0 && (!reviewed || entry.contextWindow.status !== 'unsupported') ? { contextWindow: proof(input) } : {}),
        ...(typeof maximum === 'number' && Number.isSafeInteger(maximum) && maximum > 0 && (!reviewed || entry.maxOutputTokens.status !== 'unsupported') ? { maxOutputTokens: proof(maximum) } : {}),
        ...(typeof image === 'boolean' && typeof pdf === 'boolean' && entry.inputModalities.status === 'unknown'
            ? { inputModalities: proof(['text', ...(image ? ['image'] : []), ...(pdf ? ['file'] : [])]) } : {}),
        streaming: entry.streaming.status === 'unknown'
            ? reviewed && objectValue(capabilities?.streaming)?.supported === false ? proof(false) : proof(true, 'official_doc') : entry.streaming,
        retired: entry.retired || entry.rawMetadata.lifecycle === 'retired' };
}

export function normalizeDocumentedMetadata(profile: ProviderProfile, entry: ModelEntry, now = Date.now()): ModelEntry {
    const explicit = normalizeExplicitMetadata(profile.protocol === 'gemini' ? normalizeGeminiMetadata(entry) : entry);
    let endpoint: URL;
    try { endpoint = new URL(profile.baseUrl); } catch { return explicit; }
    if (endpoint.protocol !== 'https:' || endpoint.port && endpoint.port !== '443' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return explicit;
    if (profile.protocol === 'compatible_chat' && endpoint.hostname === 'api.deepseek.com') return enrichDeepSeekCatalogEntry(profile, explicit);
    const anthropic = normalizeAnthropicMetadata(profile, explicit, endpoint, now);
    if (profile.protocol === 'anthropic') return anthropic;
    const observed = Date.parse(entry.contextWindow.observedAt);
    const reviewed = now >= Date.parse(contractReviewedAt) && observed >= Date.parse(documentExpiresAt);
    if (profile.protocol !== 'compatible_chat' || endpoint.protocol !== 'https:' || endpoint.hostname !== 'openrouter.ai'
        || endpoint.port && endpoint.port !== '443' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || endpoint.pathname.replace(/\/+$/, '') !== '/api/v1'
        || (!reviewed && (observed < Date.parse(documentObservedAt) || observed >= Date.parse(documentExpiresAt)))) return explicit;
    const apiExpiresAt = reviewed ? currentMetadataExpiry(profile, explicit, now) : null;
    if (reviewed && !apiExpiresAt) return explicit;
    const supported = entry.rawMetadata.supported_parameters;
    if (!Array.isArray(supported) || supported.some(name => typeof name !== 'string')) return explicit;
    const names = new Set(supported);
    const specifications: Record<string, ParameterSpec> = {
        temperature: { type: 'number', min: 0, max: 2, wirePath: 'temperature' },
        top_p: { type: 'number', min: 0, max: 1, wirePath: 'top_p' },
        top_k: { type: 'integer', min: 0, wirePath: 'top_k' },
        frequency_penalty: { type: 'number', min: -2, max: 2, wirePath: 'frequency_penalty' },
        presence_penalty: { type: 'number', min: -2, max: 2, wirePath: 'presence_penalty' },
        repetition_penalty: { type: 'number', min: 0, max: 2, wirePath: 'repetition_penalty' },
        min_p: { type: 'number', min: 0, max: 1, wirePath: 'min_p' },
        top_a: { type: 'number', min: 0, max: 1, wirePath: 'top_a' },
        seed: { type: 'integer', wirePath: 'seed' },
        logprobs: { type: 'boolean', wirePath: 'logprobs' },
        top_logprobs: { type: 'integer', min: 0, max: 20, wirePath: 'top_logprobs' },
        parallel_tool_calls: { type: 'boolean', wirePath: 'parallel_tool_calls' },
        include_reasoning: { type: 'boolean', wirePath: 'include_reasoning' },
        stop: { type: 'array', wirePath: 'stop', schema: { type: 'array', items: { type: 'string' } } },
    };
    const parameters = { ...explicit.parameters };
    for (const [name, specification] of Object.entries(specifications)) {
        if (!names.has(name) || parameters[name]) continue;
        parameters[name] = { ...evidenceWithValue(entry.contextWindow, specification), source: 'official_doc', sourceRef: parameterSource,
            observedAt: reviewed ? contractReviewedAt : documentObservedAt,
            expiresAt: apiExpiresAt ?? new Date(Math.min(Date.parse(entry.contextWindow.expiresAt), Date.parse(documentExpiresAt))).toISOString(),
            value: specification, status: 'supported', version: reviewed ? 'openrouter-parameters-contract-2026-11-13' : 'openrouter-parameters-2026-11-04' };
    }
    const declaredTools = objectValue(explicit.rawMetadata.tools) ?? objectValue(objectValue(explicit.rawMetadata.capabilities)?.tools);
    const tools = reviewed ? explicit.tools.status === 'unknown'
        ? { ...evidenceWithValue(explicit.contextWindow, declaredTools?.supported === false ? false : names.has('tools')), expiresAt: apiExpiresAt!,
            version: `${explicit.contextWindow.version}+openrouter-parameters-contract-2026-11-13` } : explicit.tools
        : { ...entry.tools, value: names.has('tools'), status: 'supported' as const };
    return { ...explicit, parameters, tools };
}
