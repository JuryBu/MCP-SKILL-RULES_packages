import type { PriceEntry } from '../accounting/usage.js';
import type { ProviderProfile } from '../providers/types.js';
import type { ModelEntry, ParameterSpec } from './catalog.js';
import { requireEvidence } from './evidence.js';
import type { Evidence } from './evidence.js';

const pricingSource = 'https://ai.google.dev/gemini-api/docs/pricing';
const functionSource = 'https://ai.google.dev/gemini-api/docs/generate-content/function-calling';
const gemini38Source = 'https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.8';
const modelSource = 'https://ai.google.dev/gemini-api/docs/models';
const documentExpiresAt = '2026-10-30T16:00:00.000Z';
const generationSource = 'https://ai.google.dev/api/generate-content#v1beta.GenerationConfig';
interface GoogleDocument {
    sourceRef: string;
    observedAt: string;
    expiresAt?: string;
    inputTokenLimit: number;
    outputTokenLimit: number;
    inputModalities: string[];
    version?: string;
    pricingExpiresAt?: string;
}

const refreshedDocuments: Partial<Record<string, GoogleDocument>> = {
    'gemini-3.8-flash': { sourceRef: `${modelSource}/gemini-3.8-flash`, observedAt: '2026-11-01T15:57:28.000Z',
        expiresAt: '2026-11-08T15:57:28.000Z', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536,
        inputModalities: ['text', 'image', 'video', 'audio', 'pdf'] },
    'gemini-nano-banana-2.1': { sourceRef: `${modelSource}/gemini-nano-banana-2.1`, observedAt: '2026-11-01T15:57:28.000Z',
        expiresAt: '2026-11-08T15:57:28.000Z', inputTokenLimit: 131_072, outputTokenLimit: 32_768,
        inputModalities: ['text', 'image', 'video', 'pdf'] },
};

const reviewedAt = '2026-11-13T04:59:00.000Z';
const reviewedPricingExpiresAt = '2026-11-20T04:59:00.000Z';
const reviewedSource = 'https://aistudio.google.com/docs';
const reviewedDocuments: Partial<Record<string, GoogleDocument>> = {
    'gemini-3.8-flash': { sourceRef: `${reviewedSource}/models/gemini-3.8-flash`, observedAt: reviewedAt,
        version: 'google-contract-2026-11-13', pricingExpiresAt: reviewedPricingExpiresAt,
        inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, inputModalities: ['text', 'image', 'video', 'audio', 'pdf'] },
    'gemini-nano-banana-2.1': { sourceRef: `${reviewedSource}/models/gemini-nano-banana-2.1`, observedAt: reviewedAt,
        version: 'google-contract-2026-11-13', pricingExpiresAt: reviewedPricingExpiresAt,
        inputTokenLimit: 131_072, outputTokenLimit: 32_768, inputModalities: ['text', 'image', 'video', 'pdf'] },
};

export function enrichGoogleCatalogEntry(profile: ProviderProfile, entry: ModelEntry, now = Date.now()): ModelEntry {
    const flash = entry.modelId === 'gemini-2.5-flash';
    const flash38 = entry.modelId === 'gemini-3.8-flash';
    const image = entry.modelId === 'gemini-nano-banana-2.1';
    const reviewed = now >= Date.parse(reviewedAt) ? reviewedDocuments[entry.modelId] : undefined;
    const refreshed = reviewed ?? refreshedDocuments[entry.modelId];
    const document = refreshed && now >= Date.parse(refreshed.observedAt) ? refreshed : null;
    const documentDeadline = document?.expiresAt ?? (reviewed ? entry.contextWindow.expiresAt : documentExpiresAt);
    let endpoint: URL;
    try { endpoint = new URL(profile.baseUrl); } catch { return entry; }
    if (profile.protocol !== 'gemini' || profile.routePolicy.kind !== 'direct' || entry.routeId !== null
        || endpoint.protocol !== 'https:' || endpoint.hostname !== 'generativelanguage.googleapis.com'
        || (endpoint.port !== '' && endpoint.port !== '443') || endpoint.username || endpoint.password
        || endpoint.search || endpoint.hash || (!flash && !flash38 && !image) || now >= Date.parse(documentDeadline)
        || (reviewed && !/^\/v1(?:beta)?\/?$/.test(endpoint.pathname))) return entry;
    const base = entry.contextWindow;
    if (document) {
        if (entry.protocol !== 'gemini' || entry.retired || entry.rawMetadata.name !== `models/${entry.modelId}`
            || !Array.isArray(entry.rawMetadata.supportedGenerationMethods) || !entry.rawMetadata.supportedGenerationMethods.includes('generateContent')
            || entry.rawMetadata.thinking === false || base.source !== 'api' || entry.maxOutputTokens.source !== 'api'
            || base.value !== entry.rawMetadata.inputTokenLimit || entry.maxOutputTokens.value !== entry.rawMetadata.outputTokenLimit) return entry;
        const scope = { endpoint: profile.baseUrl.replace(/\/+$/, ''), modelId: entry.modelId, routeId: entry.routeId };
        try {
            for (const evidence of [base, entry.maxOutputTokens]) {
                const value = requireEvidence(evidence, scope, now);
                if (!Number.isSafeInteger(value) || value < 1) return entry;
            }
        } catch { return entry; }
    }
    const expiresAt = new Date(Math.min(Date.parse(base.expiresAt), Date.parse(documentDeadline),
        ...(document ? [Date.parse(entry.maxOutputTokens.expiresAt)] : []),
        ...(!reviewed && flash38 ? [Date.parse('2027-01-01T00:00:00.000Z')] : []))).toISOString();
    const priceSource = reviewed ? `${reviewedSource}/pricing` : pricingSource;
    const thinkingSource = reviewed ? `${reviewedSource}/whats-new-gemini-3.8` : gemini38Source;
    const pricingExpiresAt = new Date(Math.min(Date.parse(expiresAt),
        ...(reviewed?.pricingExpiresAt ? [Date.parse(reviewed.pricingExpiresAt)] : []),
        ...(flash38 ? [Date.parse('2027-01-01T00:00:00.000Z')] : []))).toISOString();
    const declared = <Value>(value: Value, sourceRef = priceSource, deadline = expiresAt): Evidence<Value> => ({ value, status: 'supported', source: 'official_doc',
        sourceRef, observedAt: document?.observedAt ?? base.observedAt, expiresAt: deadline, scope: base.scope,
        version: document?.version ?? (document ? 'google-doc-2026-11-01' : 'google-doc-2026-10-30'), confidence: 'declared' });
    const supplement = <Value>(existing: Evidence<Value>, value: Evidence<Value>): Evidence<Value> =>
        reviewed && existing.status !== 'unknown' ? existing : value;
    const contextWindow = document && base.value! > document.inputTokenLimit ? declared(document.inputTokenLimit, document.sourceRef) : base;
    const maxOutputTokens = document && entry.maxOutputTokens.value! > document.outputTokenLimit
        ? declared(document.outputTokenLimit, document.sourceRef) : entry.maxOutputTokens;
    const maximum = maxOutputTokens.value;
    if (maximum === null) return entry;
    const parameters: Record<string, Evidence<ParameterSpec>> = {
        maxOutputTokens: declared({ type: 'integer', min: 1, max: maximum, default: Math.min(4096, maximum), required: true, wirePath: 'generationConfig.maxOutputTokens' }, maxOutputTokens.sourceRef),
    };
    if (!flash38 && !document) parameters.temperature = declared({ type: 'number', min: 0, max: 2, wirePath: 'generationConfig.temperature' }, functionSource);
    if (flash) parameters.thinkingBudget = declared({ type: 'integer', enum: [0], default: 0, wirePath: 'generationConfig.thinkingConfig.thinkingBudget' });
    if (flash38) {
        parameters.thinkingLevel = declared({ type: 'string', enum: ['low', 'medium', 'high', 'LOW', 'MEDIUM', 'HIGH'], default: 'medium', required: true,
            wirePath: 'generationConfig.thinkingConfig.thinkingLevel' }, thinkingSource);
        for (const name of ['thinkingBudget', 'temperature', 'topP', 'topK', 'candidateCount']) {
            parameters[name] = { ...declared<ParameterSpec>({ type: 'number', wirePath: name }, thinkingSource), value: null, status: 'unsupported' };
        }
    }
    if (image) {
        if (document) parameters.thinkingLevel = declared({ type: 'string', enum: ['MINIMAL', 'MEDIUM', 'HIGH'], default: 'MEDIUM',
            wirePath: 'generationConfig.thinkingConfig.thinkingLevel' }, document.sourceRef);
        parameters.responseModalities = declared({ type: 'array', default: ['TEXT', 'IMAGE'], wirePath: 'generationConfig.responseModalities',
            schema: { type: 'array', minItems: 1, maxItems: 2, ...(document ? { enum: [['IMAGE'], ['TEXT', 'IMAGE']] } : {}),
                items: { type: 'string', enum: ['TEXT', 'IMAGE'] } } }, document ? generationSource : pricingSource);
        parameters.imageSize = declared({ type: 'string', enum: ['1K', '2K', '4K'], default: '1K',
            wirePath: 'generationConfig.imageConfig.imageSize' }, document?.sourceRef ?? pricingSource);
    }
    const price: PriceEntry = { priceVersion: `google-standard-${reviewed ? '2026-11-13' : document ? '2026-11-01' : '2026-10-30'}-${entry.modelId}`, currency: 'USD', unitTokens: 1_000_000,
        inputUncached: flash38 ? 750_000 : flash ? 300_000 : 1_500_000, inputCacheRead: flash38 ? 75_000 : flash ? 30_000 : null,
        ...(image ? { inputCacheReadUpperBound: 1_500_000, outputByModality: { text: 7_500_000, image: 30_000_000 }, reasoning: 7_500_000 } : {}),
        inputCacheWrite: null, output: flash38 ? 3_750_000 : flash ? 2_500_000 : 30_000_000, reasoningBilledSeparately: true,
        media: 'included_in_tokens', serverTools: 'disabled', sourceRef: priceSource, validFrom: document?.observedAt ?? base.observedAt, expiresAt: pricingExpiresAt,
        coversAllParameters: true };
    const pricing = now < Date.parse(pricingExpiresAt) ? supplement(entry.pricing, declared(price, priceSource, pricingExpiresAt)) : entry.pricing;
    const mergedParameters = { ...entry.parameters, ...parameters };
    if (reviewed) for (const [name, evidence] of Object.entries(entry.parameters)) {
        if (evidence.status === 'unsupported') mergedParameters[name] = evidence;
    }
    return { ...entry, contextWindow, maxOutputTokens,
        inputModalities: supplement(entry.inputModalities, declared(document ? [...document.inputModalities] : flash38 ? ['text', 'image', 'video', 'audio', 'pdf'] : ['text', 'image'], document?.sourceRef ?? modelSource)),
        outputModalities: supplement(entry.outputModalities, declared(image ? ['text', 'image'] : ['text'], document?.sourceRef ?? modelSource)),
        streaming: entry.streaming.status === 'unknown' ? declared(true, 'https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent') : entry.streaming,
        ...(document ? { tools: supplement(entry.tools, declared(!image, document.sourceRef)) } : flash || flash38 ? { tools: declared(true, functionSource) } : {}),
        parameters: mergedParameters, pricing };
}
