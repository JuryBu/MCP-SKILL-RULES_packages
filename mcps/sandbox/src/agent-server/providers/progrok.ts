import { AgentFault } from '../protocol.js';
import type { JsonObject } from '../protocol.js';
import { normalizeProgrokUsage } from '../accounting/usage.js';
import { arrayObjects, assembleResponse, freezeOwned, gateDeclaredTools, objectValue, requireRoute, stringValue, verifySnapshot } from './assemble.js';
import { CompatibleChatAdapter, normalizeChatResponse } from './compatible-chat.js';
import { attemptTimeout, decodeResponse, endpointUrl } from './http.js';
import type { DiscoveryPage, NativeSendView, NormalizedResponse, ProviderAdapter, ProviderAttempt, ProviderProfile, RawProviderResponse, RequestSnapshot, SendContext, ToolResult } from './types.js';

function localApiBase(profile: ProviderProfile): string {
    const endpoint = new URL(endpointUrl(profile.baseUrl, ''));
    if (profile.protocol !== 'progrok' || endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)) {
        throw new AgentFault('E_PROFILE_INVALID', 'Progrok配置需要已有本机HTTP代理地址');
    }
    const pathname = endpoint.pathname.replace(/\/+$/, '');
    if (!['', '/v1', '/v1/chat/completions'].includes(pathname)) throw new AgentFault('E_PROFILE_INVALID', 'Progrok地址需要现有/v1 Chat路由');
    if (profile.credentialRef !== null || profile.credentialGeneration !== 0) throw new AgentFault('E_SECRET_SCOPE', 'Progrok复用既有代理认证，不接收新OAuth或API凭据');
    if (profile.routePolicy.kind !== 'direct') throw new AgentFault('E_ROUTE_UNVERIFIED', 'Progrok必须固定现有本机直接代理路由');
    return `${endpoint.origin}/v1`;
}

function localHeaders(context: SendContext): Record<string, string> {
    if (context.credential !== undefined) throw new AgentFault('E_SECRET_SCOPE', 'Progrok请求只使用既有代理的非秘密本机标识');
    return { 'Content-Type': 'application/json', Authorization: 'Bearer anything' };
}

export async function callProgrokConversation(attempt: ProviderAttempt, context: SendContext, signal?: AbortSignal): Promise<RawProviderResponse> {
    new ProgrokAdapter().validate(attempt.snapshot);
    return decodeResponse(await context.transport.request({ method: 'POST', url: attempt.snapshot.endpoint,
        headers: localHeaders(context), body: attempt.snapshot.body, timeoutMs: attemptTimeout(attempt) }, signal));
}

export class ProgrokAdapter implements ProviderAdapter {
    readonly protocol = 'progrok' as const;
    readonly version = 'progrok-local-chat-v1';
    private readonly chat = new CompatibleChatAdapter();

    endpoint(profile: ProviderProfile, _modelId: string): string {
        return `${localApiBase(profile)}/chat/completions`;
    }

    encode(view: NativeSendView, modelId: string, parameters: JsonObject): JsonObject {
        if (view.protocol !== this.protocol) throw new AgentFault('E_PROTOCOL_MISMATCH', 'Progrok需要完整原生messages发送视图');
        if (/composer/i.test(modelId)) throw new AgentFault('E_ROUTE_UNVERIFIED', '现有代理会改写Composer请求，尚无冻结参数与费用上界保证');
        if (['search_parameters', 'web_search_options', 'mcp_servers', 'previous_response_id'].some(name => Object.hasOwn(parameters, name))) {
            throw new AgentFault('E_PARAMETER_UNSUPPORTED', 'Progrok首版只使用显式本地函数工具，不接远端搜索或隐式历史');
        }
        return this.chat.encode({ ...view, protocol: 'compatible_chat' }, modelId, parameters);
    }

    validate(snapshot: RequestSnapshot): void {
        verifySnapshot(snapshot, this);
        requireRoute(snapshot);
        localApiBase(snapshot.profile);
        const body = JSON.parse(snapshot.body) as JsonObject;
        if (body.model !== snapshot.modelId || body.stream !== false || !Array.isArray(body.messages) || !body.messages.length) {
            throw new AgentFault('E_REQUEST_SCHEMA', '冻结的Progrok Chat请求不完整');
        }
    }

    async send(attempt: ProviderAttempt, context: SendContext, signal?: AbortSignal): Promise<NormalizedResponse> {
        const raw = await callProgrokConversation(attempt, context, signal);
        const names = arrayObjects((JSON.parse(attempt.snapshot.body) as JsonObject).tools).map(tool => stringValue(objectValue(tool.function)?.name) ?? '');
        const normalized = assembleResponse(attempt.attemptId, raw, normalizeChatResponse);
        return gateDeclaredTools(freezeOwned({ ...normalized, usage: normalizeProgrokUsage(raw.json.usage) }), names);
    }

    async discover(profile: ProviderProfile, cursor: string | null, context: SendContext, signal?: AbortSignal): Promise<DiscoveryPage> {
        const headers = localHeaders(context);
        const base = localApiBase(profile);
        const [page, languageResponse] = await Promise.all([
            this.chat.discover({ ...profile, baseUrl: base }, cursor, {
                transport: { request(request, requestSignal) { return context.transport.request({ ...request, headers }, requestSignal); } },
            }, signal),
            context.transport.request({ method: 'GET', url: `${base}/language-models`, headers, timeoutMs: 10_000,
                maxResponseBytes: 4 * 1024 * 1024 }, signal),
        ]);
        if ([404, 405].includes(languageResponse.status)) return page;
        const languageCatalog = decodeResponse(languageResponse).json;
        if (!Array.isArray(languageCatalog.models) || languageCatalog.models.some(model => !objectValue(model) || !stringValue(objectValue(model)?.id))
            || languageCatalog.has_more === true || stringValue(languageCatalog.next_cursor)) {
            throw new AgentFault('E_CATALOG_INCOMPLETE', 'Progrok语言模型目录缺少完整models数组');
        }
        const languages = new Map<string, JsonObject>();
        for (const model of languageCatalog.models as JsonObject[]) {
            const modelId = stringValue(model.id)!;
            if (languages.has(modelId)) throw new AgentFault('E_CATALOG_INCOMPLETE', 'Progrok语言模型目录含重复精确ID');
            languages.set(modelId, model);
        }
        return { ...page, models: page.models.map(model => {
            const language = languages.get(stringValue(model.id) ?? '');
            return language ? { ...model, progrokLanguageModel: language } : model;
        }) };
    }

    continueView(view: NativeSendView, response: NormalizedResponse, results: ToolResult[]): NativeSendView {
        if (view.protocol !== this.protocol) throw new AgentFault('E_PROTOCOL_MISMATCH', 'Progrok工具结果需要原协议发送视图');
        const next = this.chat.continueView({ ...view, protocol: 'compatible_chat' }, response, results);
        const images = results.flatMap(result => result.nativeParts ?? []).filter(part => part.type === 'image_url');
        for (const image of images) {
            const url = objectValue(image.image_url)?.url;
            const consumed = arrayObjects(next.messages).some(message => message.role === 'user'
                && arrayObjects(message.content).some(part => part.type === 'image_url' && objectValue(part.image_url)?.url === url));
            if (!consumed) throw new AgentFault('E_TOOL_IMAGE_NATIVE_PARTS_UNSUPPORTED', 'Progrok工具图片尚未进入原生用户图像消息', {
                protocol: this.protocol, field: 'messages[user].content[image_url]',
            });
        }
        return freezeOwned({ ...next, protocol: this.protocol });
    }

    async lookup(): Promise<{ status: 'unsupported' }> { return { status: 'unsupported' }; }
}
