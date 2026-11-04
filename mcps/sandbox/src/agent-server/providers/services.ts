import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonObject } from '../protocol.js';
import { BudgetLedger } from '../accounting/budget-ledger.js';
import type { AccountingPort, UpperBound } from '../accounting/budget-ledger.js';
import { estimateUpperBound } from '../accounting/usage.js';
import { ModelCatalog, modelScope, resolveParameters, validateCapabilities } from '../models/catalog.js';
import type { CatalogPort } from '../models/catalog.js';
import { requireEvidence } from '../models/evidence.js';
import { enrichGoogleCatalogEntry } from '../models/google.js';
import { ProfileStore } from '../profiles/profile-store.js';
import type { ProfilePort } from '../profiles/profile-store.js';
import { freezeRequest, sha256 } from './assemble.js';
import { CompatibleChatAdapter } from './compatible-chat.js';
import { GeminiAdapter } from './gemini.js';
import { OpenAIResponsesAdapter } from './openai-responses.js';
import { AnthropicAdapter } from './anthropic.js';
import { ProgrokAdapter } from './progrok.js';
import { createGeminiTokenCounter } from './gemini-count-tokens.js';
import { ProviderDispatcher } from './dispatch.js';
import type { CredentialAccess, DispatchJournalPort, DispatchOptions } from './dispatch.js';
import { FetchTransport } from './http.js';
import type { HttpTransport, NativeSendView, ProviderAdapter, ProviderProtocol, RequestSnapshot, RequestVersions } from './types.js';

export interface ProviderServiceOptions {
    accountingPort: AccountingPort;
    profilePort: ProfilePort;
    catalogPort: CatalogPort;
    credentialAccess?: CredentialAccess;
    transport?: HttpTransport;
    now?: () => number;
}

export interface PrepareProviderRequest {
    rootBudgetId: string;
    profileId: string;
    modelId: string;
    routeId?: string | null;
    parameters: JsonObject;
    view: NativeSendView;
    versions: Omit<RequestVersions, 'catalogVersion' | 'capabilityVersion' | 'priceVersion'>;
    inputModalities: string[];
    outputModalities: string[];
    inputTokenUpperBound: number;
    inputUpperBoundReliable: boolean;
    maxOutputTokens: number;
    timeoutMs?: number;
    deadlineAt?: string;
}

export function createProviderServices(options: ProviderServiceOptions) {
    const now = options.now ?? Date.now;
    const ledger = new BudgetLedger(options.accountingPort);
    const profiles = new ProfileStore(options.profilePort);
    const models = new ModelCatalog(options.catalogPort, now);
    const transport = options.transport ?? new FetchTransport();
    const tokenCounter = createGeminiTokenCounter({ profiles, transport, credentialAccess: options.credentialAccess, now });
    const adapters = new Map<ProviderProtocol, ProviderAdapter>([
        ['compatible_chat', new CompatibleChatAdapter()], ['gemini', new GeminiAdapter()],
        ['openai_responses', new OpenAIResponsesAdapter()], ['anthropic', new AnthropicAdapter()], ['progrok', new ProgrokAdapter()],
    ]);
    const adapterFor = (protocol: ProviderProtocol): ProviderAdapter => {
        const adapter = adapters.get(protocol);
        if (!adapter) throw new AgentFault('E_PROTOCOL_UNAVAILABLE', '该协议尚未接入正式Provider');
        return adapter;
    };

    const refreshModels = async (profileId: string, signal?: AbortSignal) => {
        const profile = await profiles.get(profileId);
        if (!profile) throw new AgentFault('E_PROFILE_NOT_FOUND', 'API配置不存在或已停用');
        const adapter = adapterFor(profile.protocol);
        const enrich = (entry: import('../models/catalog.js').ModelEntry) => enrichGoogleCatalogEntry(profile, entry, now());
        if (!profile.credentialRef || profile.protocol === 'progrok') return models.refresh(profile, adapter, { transport }, { signal, enrich });
        if (!options.credentialAccess) throw new AgentFault('E_SECRET_BACKEND', '缺少受保护的凭据读取端口');
        return options.credentialAccess.withCredential(profile.credentialRef, profile.credentialGeneration,
            credential => models.refresh(profile, adapter, { transport, credential }, { signal, enrich }));
    };

    const prepare = async (input: PrepareProviderRequest): Promise<{ adapter: ProviderAdapter; snapshot: RequestSnapshot; upperBound: UpperBound; missingPricing: string[] }> => {
        const profile = await profiles.get(input.profileId);
        if (!profile) throw new AgentFault('E_PROFILE_NOT_FOUND', 'API配置不存在或已停用');
        const adapter = adapterFor(profile.protocol);
        const { catalog, entry } = await models.get(input.profileId, input.modelId, input.routeId ?? null);
        if (catalog.profileRevision !== profile.revision || Date.parse(catalog.expiresAt) <= now()) {
            throw new AgentFault('E_CAPABILITY_UNKNOWN', '目录与当前API配置版本不同或已过期');
        }
        const account = await ledger.read(input.rootBudgetId);
        const metered = account.budget.mode === 'metered';
        if (!metered && (!account.budget.quotaLimitId || !account.quotaLimit)) throw new AgentFault('E_GLOBAL_BUDGET_REQUIRED', '正式Provider必须关联跨全部根任务的供应商总限额');
        const estimatedAmountMode = account.budget.mode === 'estimated' && account.quotaLimit?.amountMode === 'estimated';
        if (input.maxOutputTokens > account.budget.maxOutputTokens) throw new AgentFault('E_BUDGET_EXCEEDED', '请求最大输出超过根预算上限');
        validateCapabilities(entry, profile, { inputModalities: input.inputModalities, outputModalities: input.outputModalities,
            usesTools: Boolean(input.view.tools?.length), inputTokenUpperBound: input.inputTokenUpperBound,
            maxOutputTokens: input.maxOutputTokens, now: now() });
        const parameters = resolveParameters(entry, profile, input.parameters, now());
        if (['mcp_servers', 'container', 'skills', 'web_search_options', 'cachedContent'].some(name => Object.hasOwn(parameters, name))) {
            throw new AgentFault('BUDGET_UNBOUNDED', '首版硬预算尚未接入这些远端工具或存储费用');
        }
        const nativeMaximum = profile.protocol === 'gemini'
            ? (parameters.generationConfig as JsonObject | undefined)?.maxOutputTokens
            : parameters.max_tokens ?? parameters.max_completion_tokens ?? parameters.max_output_tokens;
        if (nativeMaximum !== input.maxOutputTokens) throw new AgentFault('E_BUDGET_UNBOUNDED', '实际请求必须包含与预算一致的最大输出限制');
        let billableOutputMaximum = input.maxOutputTokens;
        let billableOutputReliable = true;
        const outputSpecification = entry.parameters.maxOutputTokens?.value;
        const visibleOutputOnly = outputSpecification?.outputLimitKind === 'visible_tokens'
            || profile.protocol === 'progrok' && outputSpecification?.wirePath === 'max_tokens' && outputSpecification.outputLimitKind !== 'all_output_tokens';
        if (visibleOutputOnly) {
            if (!metered && !estimatedAmountMode) throw new AgentFault('BUDGET_UNBOUNDED', '可见回答限额之外的计费输出缺少可核实上界');
            billableOutputReliable = false;
        }
        const scope = modelScope(profile, entry.modelId, entry.routeId);
        let supportsStreaming = false;
        try { supportsStreaming = requireEvidence(entry.streaming, scope, now()) === true; }
        catch (error) { if (input.view.stream === true) throw error; }
        const streaming = input.view.stream ?? supportsStreaming;
        if (streaming && !supportsStreaming) throw new AgentFault('E_PARAMETER_UNSUPPORTED', '当前模型缺少有效流式支持声明');
        if (entry.pricing.source === 'verified_fixture' && !['127.0.0.1', '[::1]'].includes(new URL(profile.baseUrl).hostname)) {
            throw new AgentFault('BUDGET_UNBOUNDED', 'fixture价格只用于本地确定性端点，真实服务需要人工或官方的有效计价证据');
        }
        let price = null;
        try { price = requireEvidence(entry.pricing, scope, now()); }
        catch (error) { if (account.budget.mode === 'hard') throw new AgentFault('BUDGET_UNBOUNDED', '当前模型缺少可靠价格，硬预算阻止付费'); }
        if (price && price.coversAllParameters !== true && price.parameterHash !== sha256(canonicalJson(parameters))) {
            if (metered) price = null;
            else throw new AgentFault('E_PRICE_SCOPE', '冻结价格没有覆盖本次实际参数或明确的最坏情况');
        }
        const estimate = price ? estimateUpperBound({ price, maxInputTokens: input.inputTokenUpperBound, maxOutputTokens: billableOutputMaximum,
            maxCacheWriteTokens: input.inputTokenUpperBound,
            includesMedia: input.inputModalities.concat(input.outputModalities).some(modality => modality !== 'text'), now: now() }) : null;
        if (price && price.currency !== account.budget.currency) throw new AgentFault('E_CURRENCY_MISMATCH', '模型价格与根预算币种不同');
        const reliable = Boolean(input.inputUpperBoundReliable && billableOutputReliable && estimate?.amountMicros !== null && estimate?.amountMicros !== undefined);
        if (!metered && !estimatedAmountMode && !reliable) throw new AgentFault('BUDGET_UNBOUNDED', '本次请求缺少可靠输入或费用上界');
        if (estimatedAmountMode && (estimate?.amountMicros === null || estimate?.amountMicros === undefined || estimate.amountMicros < 1)) {
            throw new AgentFault('BUDGET_UNBOUNDED', '估计金额累计模式需要有效单价和有限非零预留金额');
        }
        const deadline = Math.min(Date.parse(account.budget.deadlineAt), input.deadlineAt ? Date.parse(input.deadlineAt) : Infinity);
        if (!Number.isFinite(deadline) || deadline <= now()) throw new AgentFault('E_BUDGET_DEADLINE', '请求期限无效或已到期');
        const snapshot = freezeRequest({ adapter, profile, versions: { ...input.versions, catalogVersion: catalog.catalogVersion,
            capabilityVersion: sha256(canonicalJson(entry)), priceVersion: price?.priceVersion ?? null }, modelId: input.modelId,
            view: input.view, stream: streaming, parameters, rootBudgetId: input.rootBudgetId, pricingSnapshot: price ?? undefined,
            requirePricingSnapshot: account.budget.mode === 'hard' || Boolean(account.quotaLimit), frozenAt: new Date(now()).toISOString(),
            timeoutMs: input.timeoutMs, deadlineAt: new Date(deadline).toISOString() });
        return { adapter, snapshot, upperBound: { currency: account.budget.currency, amountMicros: estimate?.amountMicros ?? null,
            reliable, source: reliable ? 'price_table' : 'estimated', sourceRef: price?.sourceRef ?? 'explicit-estimated-root-budget',
            ...(!reliable ? { estimateBasis: { inputTokens: input.inputTokenUpperBound, outputTokens: billableOutputMaximum,
                outputLimitKind: visibleOutputOnly ? 'visible_tokens' : entry.parameters.maxOutputTokens?.value?.outputLimitKind ?? 'all_output_tokens',
                missingHardBounds: [...(!input.inputUpperBoundReliable ? ['input_tokens'] : []), ...(!billableOutputReliable ? ['billable_output_tokens'] : [])] } } : {}),
            ...(price ? { expiresAt: price.expiresAt } : {}) }, missingPricing: estimate?.missing ?? ['price'] };
    };

    const createDispatcher = (journal: DispatchJournalPort, overrides: Omit<DispatchOptions, 'journal' | 'transport' | 'credentials'> = {}) =>
        new ProviderDispatcher({ journal, transport, credentials: options.credentialAccess, now, ...overrides });

    const countRequestTokens = async (profileId: string, modelId: string, view: NativeSendView,
        signal: AbortSignal | undefined, deadlineAt: string, parameters: JsonObject) => {
        const profile = await profiles.get(profileId);
        if (!profile) throw new AgentFault('E_PROFILE_NOT_FOUND', 'API配置不存在或已停用');
        const { catalog, entry } = await models.get(profileId, modelId);
        if (catalog.profileRevision !== profile.revision || Date.parse(catalog.expiresAt) <= now()) {
            throw new AgentFault('E_CAPABILITY_UNKNOWN', '计数目录与当前API配置版本不同或已过期');
        }
        return tokenCounter.countTokens(profileId, modelId, view, signal, deadlineAt,
            resolveParameters(entry, profile, parameters, now()));
    };

    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= tokenCounter.close().then(() => options.transport ? undefined : transport.close?.());

    return { ledger, profiles, models, credentialAccess: options.credentialAccess, adapterFor, prepareRequest: prepare, refreshModels, createDispatcher,
        countTokens: tokenCounter.countTokens, countRequestTokens, close };
}
