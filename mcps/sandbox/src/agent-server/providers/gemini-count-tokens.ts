import { AgentFault, canonicalJson, type JsonObject } from '../protocol.js';
import { setTimeout as delay } from 'node:timers/promises';
import { tokenCount } from '../accounting/usage.js';
import { freezeOwned, sha256 } from './assemble.js';
import { GeminiAdapter, encodeGeminiCountTokensRequest } from './gemini.js';
import { decodeResponse, safeTransportCause } from './http.js';
import { ProviderFault } from './types.js';
import { geminiCredentialHeaders, providerRequestHeaders } from './request-identity.js';
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
        requestAttempts?: number;
        requestBodyBytes?: number;
        requestBudgetMs?: number;
        requestTimeline?: JsonObject[];
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
    const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new AgentFault('E_COUNT_TOKENS_CONFIG', '原生计数单次期限必须为正数');
    const adapter = new GeminiAdapter();
    const active = new Map<AbortController, Promise<GeminiTokenCountResult>>();
    let closed = false;

    const countTokens = (profileId: string, modelId: string, view: NativeSendView, signal: AbortSignal | undefined,
        deadlineAt: string, parameters?: JsonObject, identity?: { conversationId: string }): Promise<GeminiTokenCountResult> => {
        if (closed) return Promise.reject(new AgentFault('E_COUNT_TOKENS_CLOSED', '计数端口已经关闭'));
        const executionDeadline = Date.parse(deadlineAt);
        if (!Number.isFinite(executionDeadline) || executionDeadline <= now()) return Promise.reject(new AgentFault('E_COUNT_TOKENS_DEADLINE', '原生计数期限已经到期或无效'));
        const startedAt = now();
        let requestBudgetMs = Math.min(15_000, requestTimeoutMs);
        let deadline = Math.min(executionDeadline, startedAt + requestBudgetMs);
        const requestTimeline: JsonObject[] = [];
        const progress: JsonObject = { requestPurpose: 'input_token_count', generationDispatch: 'not_started', requestAttempts: 0, phase: 'preparing', requestTimeline };
        let finished = false;
        const controller = new AbortController();
        const stop = (code: string, message: string) => controller.abort(new AgentFault(code, message,
            { ...structuredClone(progress), executionDeadlineAt: deadlineAt, requestDeadlineAt: new Date(deadline).toISOString(), requestBudgetMs }));
        const stopTimeout = () => stop(deadline < executionDeadline ? 'E_COUNT_TOKENS_TIMEOUT' : 'E_COUNT_TOKENS_DEADLINE',
            deadline < executionDeadline ? '原生计数超过当前输入的等待期限' : '原生计数超过本次执行期限');
        const check = () => {
            if (now() >= deadline && !controller.signal.aborted) stopTimeout();
            if (controller.signal.aborted) throw controller.signal.reason;
        };
        const aborted = new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        });
        const cancel = () => stop('E_CANCELLED', '原生计数已取消');
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        let timer = setTimeout(stopTimeout, Math.max(1, deadline - now()));
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
            const requestBodyBytes = Buffer.byteLength(body);
            if (requestBodyBytes > 64 * 1024 * 1024) throw new AgentFault('E_COUNT_TOKENS_LIMIT', '原生计数请求超过64MiB字节上限');
            check();
            requestBudgetMs = options.requestTimeoutMs === undefined
                ? requestBodyBytes <= 256 * 1024 ? 15_000 : Math.min(120_000, 15_000 + Math.ceil(requestBodyBytes / (1024 * 1024)) * 15_000)
                : Math.min(120_000, requestTimeoutMs);
            deadline = Math.min(executionDeadline, startedAt + requestBudgetMs);
            clearTimeout(timer);
            timer = setTimeout(stopTimeout, Math.max(1, deadline - now()));
            if (profile.credentialRef && !options.credentialAccess) throw new AgentFault('E_SECRET_BACKEND', '原生计数缺少受保护的凭据读取端口');
            const requestBodyHash = sha256(body);
            const requestHash = sha256(canonicalJson({ method: 'POST', endpoint: endpoint.href, profileId: profile.profileId,
                profileRevision: profile.revision, credentialGeneration: profile.credentialGeneration, modelId: bareModel, requestBodyHash }));
            Object.assign(progress, { endpoint: endpoint.href, modelId: bareModel, profileId, profileRevision: profile.revision,
                requestBodyHash, requestHash, requestBodyBytes });
            check();
            const send = async (credential?: string) => {
                check();
                if (credential !== undefined && (!credential || /[\r\n]/.test(credential))) throw new AgentFault('E_AUTH', '凭据内容无效');
                requestAttempts++;
                const attempt = requestAttempts;
                Object.assign(progress, { requestAttempts, phase: 'count_request' });
                return decodeResponse(await options.transport.request({ method: 'POST', url: endpoint.href,
                    headers: providerRequestHeaders(profile, { 'Content-Type': 'application/json', ...geminiCredentialHeaders(profile, credential) },
                        { purpose: 'count', conversationId: identity?.conversationId }), body,
                    timeoutMs: Math.max(1, deadline - now()), maxResponseBytes: 64 * 1024,
                    onPhase: (phase, detail) => {
                        if (finished || controller.signal.aborted) return;
                        Object.assign(progress, { transportPhase: phase, ...detail });
                        if (requestTimeline.length < 16) requestTimeline.push({ attempt, phase, elapsedMs: now() - startedAt, ...detail });
                    } }, controller.signal), 'gemini', endpoint.href);
            };
            let raw: RawProviderResponse | undefined;
            let requestAttempts = 0;
            let attemptCycles = 0;
            while (!raw) {
                check();
                attemptCycles++;
                for (const field of ['httpStatus', 'transportPhase', 'route', 'retryAfterMs']) delete progress[field];
                Object.assign(progress, { attemptCycle: attemptCycles, phase: profile.credentialRef ? 'credential_preparation' : 'preparing_http' });
                try {
                    raw = profile.credentialRef
                        ? await options.credentialAccess!.withCredential(profile.credentialRef, profile.credentialGeneration, send) : await send();
                } catch (error) {
                    const cause = error instanceof ProviderFault ? error.transportCause : safeTransportCause(error);
                    if (!controller.signal.aborted && !finished) progress.lastAttemptFailure = {
                        code: error instanceof AgentFault ? error.code : 'E_COUNT_TOKENS_ERROR',
                        httpStatus: error instanceof ProviderFault ? error.httpStatus ?? null : null,
                        ...(cause ? { transportCause: { ...cause } } : {}) };
                    check();
                    const transient = error instanceof ProviderFault && !['E_AUTH', 'E_QUOTA', 'E_MODEL_UNAVAILABLE', 'E_PROVIDER_POLICY', 'E_PARAMETER_INVALID', 'E_CANCELLED', 'E_RESPONSE_LIMIT'].includes(error.code)
                        && (['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(cause?.causeCode ?? cause?.code))
                            || [500, 502, 503, 504].includes(error.httpStatus ?? 0) || error.code === 'E_RATE_LIMIT' && error.retryable);
                    const wait = Math.max(250 * 2 ** (attemptCycles - 1) + Math.floor(Math.random() * 250),
                        error instanceof ProviderFault ? error.retryAfterMs ?? 0 : 0);
                    if (transient && attemptCycles < 3 && now() + wait < deadline) {
                        Object.assign(progress, { phase: 'retry_backoff', retryAfterMs: wait, lastTransportCause: cause });
                        await delay(wait, undefined, { signal: controller.signal });
                        continue;
                    }
                    if (!(error instanceof ProviderFault)) throw error;
                    const fault = new ProviderFault(['E_RESULT_UNKNOWN', 'E_TRANSPORT_UNSENT'].includes(error.code)
                        ? 'E_COUNT_TOKENS_TRANSPORT' : error.code, '输入计数请求未完成，生成请求尚未派发', {
                        acceptance: 'not_sent', phase: 'prepared', httpStatus: error.httpStatus,
                        nativeCode: error.nativeCode, nativeReason: error.nativeReason,
                        transportCause: cause, transportPhase: error.transportPhase, retryable: transient,
                        retryAfterMs: error.retryAfterMs, rawResponse: error.rawResponse,
                    });
                    Object.assign(fault.details!, { requestPurpose: 'input_token_count', generationDispatch: 'not_started',
                        countRequestAcceptance: error.acceptance, originalErrorCode: error.code, endpoint: endpoint.href,
                        modelId: bareModel, profileId, profileRevision: profile.revision, requestHash, requestBodyHash,
                        requestAttempts, requestBodyBytes, requestBudgetMs, requestTimeline, executionDeadlineAt: deadlineAt, requestDeadlineAt: new Date(deadline).toISOString(),
                        ...(error.rawResponse ? { countResponse: { httpStatus: error.rawResponse.httpStatus, body: error.rawResponse.body } } : {}) });
                    throw fault;
                }
            }
            check();
            const inputTokens = tokenCount(raw.json.totalTokens);
            if (inputTokens === null) throw new AgentFault('E_COUNT_TOKENS_INVALID', '原生计数响应缺少明确的非负整数totalTokens');
            return freezeOwned({ inputTokens, raw, source: { kind: 'gemini_count_tokens' as const, endpoint: endpoint.href,
                modelId: bareModel, profileId: profile.profileId, profileRevision: profile.revision,
                credentialGeneration: profile.credentialGeneration, requestHash, requestBodyHash,
                observedAt: new Date(now()).toISOString(), deadlineAt, requestDeadlineAt: new Date(deadline).toISOString(), requestAttempts,
                requestBodyBytes, requestBudgetMs, requestTimeline } });
        });
        const result = Promise.race([work, aborted]).finally(() => {
            finished = true;
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
