import { AgentFault, canonicalJson, type JsonObject } from '../protocol.js';
import { tokenCount } from '../accounting/usage.js';
import { freezeOwned, sha256 } from './assemble.js';
import { GeminiAdapter, encodeGeminiCountTokensRequest } from './gemini.js';
import { decodeResponse } from './http.js';
import type { CredentialAccess } from './dispatch.js';
import type { HttpTransport, NativeSendView, ProviderProfile, RawProviderResponse } from './types.js';

export interface GeminiTokenCountResult {
    inputTokens: number;
    raw: RawProviderResponse;
    source: {
        kind: 'gemini_count_tokens';
        endpoint: string;
        modelId: string;
        profileId: string;
        profileRevision: number;
        credentialGeneration: number;
        requestHash: string;
        requestBodyHash: string;
        observedAt: string;
        deadlineAt: string;
        requestDeadlineAt?: string;
    };
}

export interface GeminiTokenCounterOptions {
    profiles: { get(profileId: string): Promise<ProviderProfile | null> };
    transport: HttpTransport;
    credentialAccess?: CredentialAccess;
    now?: () => number;
    requestTimeoutMs?: number;
}

export function createGeminiTokenCounter(options: GeminiTokenCounterOptions) {
    const now = options.now ?? Date.now;
    const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new AgentFault('E_COUNT_TOKENS_CONFIG', '原生计数单次期限必须为正数');
    const adapter = new GeminiAdapter();
    const active = new Map<AbortController, Promise<GeminiTokenCountResult>>();
    let closed = false;

    const countTokens = (profileId: string, modelId: string, view: NativeSendView, signal: AbortSignal | undefined,
        deadlineAt: string, parameters?: JsonObject): Promise<GeminiTokenCountResult> => {
        if (closed) return Promise.reject(new AgentFault('E_COUNT_TOKENS_CLOSED', '计数端口已经关闭'));
        const executionDeadline = Date.parse(deadlineAt);
        if (!Number.isFinite(executionDeadline) || executionDeadline <= now()) return Promise.reject(new AgentFault('E_COUNT_TOKENS_DEADLINE', '原生计数期限已经到期或无效'));
        const deadline = Math.min(executionDeadline, now() + Math.min(15_000, requestTimeoutMs));
        const timeoutCode = deadline < executionDeadline ? 'E_COUNT_TOKENS_TIMEOUT' : 'E_COUNT_TOKENS_DEADLINE';
        const timeoutMessage = deadline < executionDeadline ? '原生计数超过单次等待期限' : '原生计数超过本次执行期限';
        const controller = new AbortController();
        const stop = (code: string, message: string) => controller.abort(new AgentFault(code, message,
            { executionDeadlineAt: deadlineAt, requestDeadlineAt: new Date(deadline).toISOString() }));
        const check = () => {
            if (now() >= deadline && !controller.signal.aborted) stop(timeoutCode, timeoutMessage);
            if (controller.signal.aborted) throw controller.signal.reason;
        };
        const aborted = new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        });
        const cancel = () => stop('E_CANCELLED', '原生计数已取消');
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        const timer = setTimeout(() => stop(timeoutCode, timeoutMessage), Math.max(1, deadline - now()));
        const work = Promise.resolve().then(async (): Promise<GeminiTokenCountResult> => {
            check();
            const profile = await options.profiles.get(profileId);
            check();
            if (!profile) throw new AgentFault('E_PROFILE_NOT_FOUND', 'API配置不存在或已停用');
            if (profile.protocol !== 'gemini' || profile.routePolicy.kind !== 'direct') throw new AgentFault('E_COUNT_TOKENS_UNAVAILABLE', '该计数端口需要已确认的Gemini协议直接路由');
            const bareModel = modelId.replace(/^models\//, '');
            if (!profile.routePolicy.allowedModels.includes(modelId) && !profile.routePolicy.allowedModels.includes(bareModel)) {
                throw new AgentFault('E_MODEL_CONFLICT', '计数模型未列入已确认的路由范围');
            }
            const generationEndpoint = new URL(adapter.endpoint(profile, modelId));
            const endpoint = new URL(generationEndpoint.href.replace(/:generateContent$/, ':countTokens'));
            if (endpoint.origin !== generationEndpoint.origin || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
                || !endpoint.pathname.endsWith(`/models/${encodeURIComponent(bareModel)}:countTokens`)) {
                throw new AgentFault('E_COUNT_TOKENS_UNAVAILABLE', '原生计数须使用当前API配置同源同模型的countTokens端点');
            }
            const body = canonicalJson(encodeGeminiCountTokensRequest(view, modelId, parameters));
            if (Buffer.byteLength(body) > 64 * 1024 * 1024) throw new AgentFault('E_COUNT_TOKENS_LIMIT', '原生计数请求超过64MiB字节上限');
            if (profile.credentialRef && !options.credentialAccess) throw new AgentFault('E_SECRET_BACKEND', '原生计数缺少受保护的凭据读取端口');
            const requestBodyHash = sha256(body);
            const requestHash = sha256(canonicalJson({ method: 'POST', endpoint: endpoint.href, profileId: profile.profileId,
                profileRevision: profile.revision, credentialGeneration: profile.credentialGeneration, modelId: bareModel, requestBodyHash }));
            check();
            const send = async (credential?: string) => {
                check();
                if (credential !== undefined && (!credential || /[\r\n]/.test(credential))) throw new AgentFault('E_AUTH', '凭据内容无效');
                return decodeResponse(await options.transport.request({ method: 'POST', url: endpoint.href,
                    headers: { 'Content-Type': 'application/json', ...(credential ? { 'x-goog-api-key': credential } : {}) }, body,
                    timeoutMs: Math.max(1, deadline - now()), maxResponseBytes: 64 * 1024 }, controller.signal));
            };
            const raw = profile.credentialRef
                ? await options.credentialAccess!.withCredential(profile.credentialRef, profile.credentialGeneration, send) : await send();
            check();
            const inputTokens = tokenCount(raw.json.totalTokens);
            if (inputTokens === null) throw new AgentFault('E_COUNT_TOKENS_INVALID', '原生计数响应缺少明确的非负整数totalTokens');
            return freezeOwned({ inputTokens, raw, source: { kind: 'gemini_count_tokens' as const, endpoint: endpoint.href,
                modelId: bareModel, profileId: profile.profileId, profileRevision: profile.revision,
                credentialGeneration: profile.credentialGeneration, requestHash, requestBodyHash,
                observedAt: new Date(now()).toISOString(), deadlineAt, requestDeadlineAt: new Date(deadline).toISOString() } });
        });
        const result = Promise.race([work, aborted]).finally(() => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', cancel);
            active.delete(controller);
        });
        active.set(controller, result);
        return result;
    };

    const close = async (): Promise<void> => {
        closed = true;
        const waiting = [...active.values()];
        for (const controller of active.keys()) controller.abort(new AgentFault('E_COUNT_TOKENS_CLOSED', '计数端口正在关闭'));
        await Promise.allSettled(waiting);
    };

    return { countTokens, close };
}
