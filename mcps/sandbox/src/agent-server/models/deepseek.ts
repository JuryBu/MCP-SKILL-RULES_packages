import type { ProviderProfile } from '../providers/types.js';
import type { ModelEntry, ParameterSpec } from './catalog.js';
import type { Evidence } from './evidence.js';

const apiSource = 'https://api-docs.deepseek.com/api/create-chat-completion';
const contextSource = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';
const aliasSource = 'https://api-docs.deepseek.com/news/news260910';
const observedAt = '2026-11-04T16:35:00.000Z';
const documentExpiresAt = '2026-11-11T16:35:00.000Z';
const refreshedObservedAt = '2026-11-13T04:51:00.000Z';
const documentedModels = new Set(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']);

export function enrichDeepSeekCatalogEntry(profile: ProviderProfile, entry: ModelEntry): ModelEntry {
    let endpoint: URL;
    try { endpoint = new URL(profile.baseUrl); } catch { return entry; }
    const observed = Date.parse(entry.contextWindow.observedAt);
    const refreshed = observed >= Date.parse(refreshedObservedAt);
    if (profile.protocol !== 'compatible_chat' || endpoint.protocol !== 'https:' || endpoint.hostname !== 'api.deepseek.com'
        || endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || !['', '/v1'].includes(endpoint.pathname.replace(/\/+$/, '')) || !documentedModels.has(entry.modelId)
        || entry.routeId !== null || observed < Date.parse(observedAt)
        || !refreshed && observed >= Date.parse(documentExpiresAt)) return entry;
    const proof = <Value>(value: Value, sourceRef = apiSource): Evidence<Value> => ({ value, status: 'supported', source: 'official_doc', sourceRef,
        observedAt: refreshed ? refreshedObservedAt : observedAt,
        expiresAt: refreshed ? entry.contextWindow.expiresAt
            : new Date(Math.min(Date.parse(entry.contextWindow.expiresAt), Date.parse(documentExpiresAt))).toISOString(),
        scope: entry.contextWindow.scope, version: refreshed ? 'deepseek-api-contract-reviewed-2026-11-13' : 'deepseek-doc-2026-11-05', confidence: 'declared' });
    const parameters: Record<string, Evidence<ParameterSpec>> = {
        maxOutputTokens: proof({ type: 'integer', min: 1, max: 393216, default: 4096, required: true, wirePath: 'max_tokens',
            outputLimitKind: 'all_output_tokens', outputLimitSourceRef: apiSource }),
        reasoningEffort: proof({ type: 'string', enum: ['none', 'low', 'high', 'max'], wirePath: 'reasoning_effort' }),
        temperature: proof({ type: 'number', min: 0, max: 2, wirePath: 'temperature' }),
        topP: proof({ type: 'number', min: Number.MIN_VALUE, max: 1, wirePath: 'top_p' }),
        thinking: proof({ type: 'object', wirePath: 'thinking', schema: { type: 'object', properties: { type: { type: 'string', enum: ['enabled', 'disabled'] } },
            required: ['type'], additionalProperties: false } }),
    };
    return { ...entry,
        contextWindow: entry.contextWindow.status === 'unknown' ? proof(1_000_000, contextSource) : entry.contextWindow,
        maxOutputTokens: entry.maxOutputTokens.status === 'unknown' ? proof(393216) : entry.maxOutputTokens,
        inputModalities: entry.inputModalities.status === 'unknown' ? proof(entry.modelId === 'deepseek-flash' ? ['text', 'image'] : ['text'], aliasSource) : entry.inputModalities,
        outputModalities: entry.outputModalities.status === 'unknown' ? proof(['text']) : entry.outputModalities,
        tools: entry.tools.status === 'unknown' ? proof(true) : entry.tools,
        streaming: entry.streaming.status === 'unknown' ? proof(true) : entry.streaming,
        parameters: { ...parameters, ...entry.parameters } };
}
