import { AgentFault } from '../protocol.js';
import type { JsonObject } from '../protocol.js';
import { objectValue, stringValue } from './assemble.js';
import { normalizeProgrokUsage, normalizeUsage } from '../accounting/usage.js';
import { ProviderFault } from './types.js';
import { createProviderNetwork, ProviderNetworkError } from './network.js';
import type { ProviderNetwork, ProviderNetworkOptions } from './network.js';
import type { HttpRequest, HttpResponse, HttpTransport, ProviderAttempt, ProviderProtocol, RawProviderResponse, TransportCause, TransportPhase } from './types.js';

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const safeErrorNames = new Set(['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError', 'FetchError', 'SystemError', 'AggregateError', 'DOMException', 'ProviderNetworkError']);
const safeErrorCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
    'ENETDOWN', 'EPIPE', 'ETIMEDOUT', 'EADDRNOTAVAIL', 'EACCES', 'EPERM', 'ABORT_ERR', 'ERR_INVALID_URL', 'ERR_INVALID_ARG_TYPE',
    'ERR_HTTP_INVALID_HEADER_VALUE', 'ERR_INVALID_CHAR', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_INVALID_ARG',
    'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'UND_ERR_RESPONSE_STATUS_CODE', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED',
    'E_NETWORK_CONFIGURATION', 'E_PROXY_CONFIGURATION', 'E_NETWORK_URL', 'E_NETWORK_CLOSED']);

function errorField(error: unknown, key: string): unknown {
    try { return error && typeof error === 'object' ? (error as Record<string, unknown>)[key] : undefined; }
    catch { return undefined; }
}

export function safeTransportCause(error: unknown): TransportCause {
    const nativeName = errorField(error, 'name');
    const name = typeof nativeName === 'string' && safeErrorNames.has(nativeName) ? nativeName : 'Error';
    const code = errorField(error, 'code');
    const causeCode = errorField(errorField(error, 'cause'), 'code');
    const accepted = (value: unknown): value is string | number => typeof value === 'string' ? safeErrorCodes.has(value)
        : (name === 'AbortError' && value === 20) || (name === 'TimeoutError' && value === 23);
    return { name, ...(accepted(code) ? { code } : {}), ...(accepted(causeCode) ? { causeCode } : {}) };
}

export function transportFailure(error: unknown, input: { phase: TransportPhase; httpStatus?: number; aborted?: boolean; timedOut?: boolean }): ProviderFault {
    const unsent = input.phase === 'preflight';
    const accepted = !unsent && input.httpStatus !== undefined && input.httpStatus >= 200 && input.httpStatus < 300;
    const message = unsent ? '请求发送前的网络准备或参数校验未完成'
        : input.timedOut ? '网络请求超时，远端受理状态待核实，保留原尝试及费用预留'
        : input.aborted ? '请求已取消，远端受理状态待核实，保留原尝试及费用预留'
        : '网络请求结果未知，保留原尝试及费用预留';
    return new ProviderFault(unsent ? 'E_TRANSPORT_UNSENT' : 'E_RESULT_UNKNOWN', message,
        { acceptance: unsent ? 'not_sent' : accepted ? 'accepted' : 'unknown', phase: unsent ? 'prepared' : accepted ? 'accepted' : 'dispatching',
            httpStatus: input.httpStatus, transportPhase: input.phase, transportCause: safeTransportCause(error), retryable: false });
}

function validateHttpRequest(request: HttpRequest): number {
    const url = new URL(request.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !['GET', 'POST'].includes(request.method)
        || (request.body !== undefined && typeof request.body !== 'string') || (request.method === 'GET' && request.body !== undefined)) {
        throw new TypeError('HTTP request preflight failed');
    }
    new Headers(request.headers);
    const maximum = request.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new RangeError('HTTP response bound is invalid');
    return Math.min(maximum, MAX_RESPONSE_BYTES);
}

export class FetchTransport implements HttpTransport {
    private network?: ProviderNetwork;
    private closed = false;
    private closing?: Promise<void>;

    constructor(private readonly networkOptions: ProviderNetworkOptions = {}) {}

    private networkForRequest(): ProviderNetwork {
        if (this.closed) throw new ProviderNetworkError('E_NETWORK_CLOSED', '供应商HTTP传输已关闭');
        return this.network ??= createProviderNetwork(this.networkOptions);
    }

    close(): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true;
        this.closing = this.network?.close() ?? Promise.resolve();
        return this.closing;
    }

    async request(request: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
        if (signal?.aborted) throw new ProviderFault('E_CANCELLED', '请求发送前已取消', { acceptance: 'not_sent' });
        if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 2_147_483_647) {
            throw new ProviderFault('E_DEADLINE', '请求发送前已到期限', { acceptance: 'not_sent' });
        }
        let maximum: number;
        try { maximum = validateHttpRequest(request); }
        catch (error) { throw transportFailure(error, { phase: 'preflight' }); }
        const controller = new AbortController();
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const abort = (): void => {
            controller.abort();
            void reader?.cancel().catch(() => {});
        };
        signal?.addEventListener('abort', abort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; abort(); }, request.timeoutMs);
        const deadlineAt = Date.now() + request.timeoutMs;
        let status: number | undefined;
        let transportPhase: TransportPhase = 'preflight';
        const chunks: Uint8Array[] = [];
        const headers: Record<string, string> = {};
        try {
            if (signal?.aborted) throw new ProviderFault('E_CANCELLED', '请求发送前已取消', { acceptance: 'not_sent', transportPhase });
            const network = this.networkForRequest();
            if (controller.signal.aborted || signal?.aborted) throw new ProviderFault('E_CANCELLED', '网络准备期间请求已取消', { acceptance: 'not_sent', transportPhase });
            if (Date.now() >= deadlineAt) throw new ProviderFault('E_DEADLINE', '网络准备完成前已到请求期限', { acceptance: 'not_sent', transportPhase });
            transportPhase = 'fetch_invoked';
            try { request.onPhase?.(transportPhase, { route: network.routeFor(request.url) }); } catch {}
            const response = await network.fetch(request.url, { method: request.method, headers: request.headers,
                body: request.body, signal: controller.signal, redirect: 'error' });
            status = response.status;
            response.headers.forEach((value, name) => {
                if (!/authorization|cookie|api.?key|token|secret/i.test(name)) headers[name] = value;
            });
            transportPhase = 'response_headers';
            try { request.onPhase?.(transportPhase, { httpStatus: status }); } catch {}
            const declared = Number(response.headers.get('content-length'));
            if (Number.isFinite(declared) && declared > maximum) {
                await response.body?.cancel();
                throw new ProviderFault('E_RESPONSE_LIMIT', '供应商响应超过本次接收上限',
                    { acceptance: status >= 200 && status < 300 ? 'accepted' : 'unknown', httpStatus: status, transportPhase });
            }
            transportPhase = 'response_body';
            try { request.onPhase?.(transportPhase, { httpStatus: status }); } catch {}
            reader = response.body?.getReader();
            let total = 0;
            if (reader) {
                try {
                    while (true) {
                        const item = await reader.read();
                        controller.signal.throwIfAborted();
                        if (item.done) break;
                        total += item.value.byteLength;
                        if (total > maximum) {
                            await reader.cancel();
                            throw new ProviderFault('E_RESPONSE_LIMIT', '供应商响应超过本次接收上限',
                                { acceptance: status >= 200 && status < 300 ? 'accepted' : 'unknown', httpStatus: status, transportPhase });
                        }
                        chunks.push(item.value);
                        await request.onChunk?.(item.value, { status, headers });
                    }
                } catch (error) {
                    await reader.cancel().catch(() => {});
                    throw error;
                } finally { reader.releaseLock(); }
            }
            return { status, headers, body: Buffer.concat(chunks).toString('utf8') };
        } catch (error) {
            controller.abort();
            const fault = error instanceof ProviderFault ? error : error instanceof ProviderNetworkError
                ? transportFailure(error, { phase: 'preflight' })
                : transportFailure(error, { phase: transportPhase, httpStatus: status, aborted: signal?.aborted, timedOut });
            if (!fault.rawResponse && chunks.length && status !== undefined) {
                throw new ProviderFault(fault.code, fault.message, { acceptance: fault.acceptance, phase: fault.phase,
                    httpStatus: status, transportPhase: fault.transportPhase ?? transportPhase, transportCause: fault.transportCause,
                    rawResponse: { httpStatus: status, headers, body: Buffer.concat(chunks).toString('utf8'), json: {} } });
            }
            throw fault;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
    }
}

export function endpointUrl(baseUrl: string, suffix: string): string {
    let parsed: URL;
    try { parsed = new URL(baseUrl); } catch { throw new AgentFault('E_PROFILE_INVALID', 'API地址必须为有效HTTP或HTTPS地址'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new AgentFault('E_PROFILE_INVALID', 'API地址不得包含凭据、查询参数或片段');
    }
    const normalized = parsed.href.replace(/\/+$/, '');
    return normalized.endsWith(suffix) ? normalized : `${normalized}${suffix}`;
}

export function attemptTimeout(attempt: ProviderAttempt, now = Date.now()): number {
    const remaining = Date.parse(attempt.snapshot.deadlineAt) - now;
    if (!Number.isFinite(remaining) || remaining <= 0) {
        throw new ProviderFault('E_DEADLINE', '请求发送前已到根期限', { acceptance: 'not_sent' });
    }
    return Math.min(attempt.snapshot.timeoutMs, remaining, 2_147_483_647);
}

export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

function modelUnavailableReason(httpStatus: number, native: JsonObject | null): string | undefined {
    if (![403, 404, 410].includes(httpStatus) || !native) return undefined;
    const message = (stringValue(native.message) ?? '').slice(0, 4096);
    const code = stringValue(native.code) ?? stringValue(native.type) ?? '';
    if (!/\bmodels?\b/i.test(message) && !/model[_-](?:not[_-]found|unavailable|access)/i.test(code)) return undefined;
    if (/(?:no longer available|not available|unavailable).{0,60}(?:new users|new accounts)/i.test(message)) return 'model_unavailable_for_new_users';
    if (httpStatus === 403 && /access|permission|authoriz|your account|your project/i.test(message)) return 'model_account_access_unavailable';
    if ([404, 410].includes(httpStatus) && /not[_ -]found|does not exist|not supported|no longer available|not available|unavailable|retired|deprecated|decommission/i.test(`${code} ${message}`)) {
        return 'model_not_found_or_unsupported';
    }
    return undefined;
}

export function responseUsage(protocol: ProviderProtocol, json: JsonObject): import('../accounting/usage.js').NormalizedUsage {
    return protocol === 'progrok' ? normalizeProgrokUsage(json.usage)
        : normalizeUsage(protocol, protocol === 'gemini' ? json.usageMetadata : json.usage);
}

function knownTemporaryRejection(protocol: ProviderProtocol | undefined, endpoint: string | undefined, status: number,
    nativeCode: string | undefined, native: JsonObject | null, retryAfterMs: number | undefined): boolean {
    if (!endpoint || !protocol) return false;
    let url: URL;
    try { url = new URL(endpoint); } catch { return false; }
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
    const type = stringValue(native?.type);
    if (protocol === 'openai_responses' && url.hostname === 'api.openai.com') {
        return status === 429 && retryAfterMs !== undefined && (['rate_limit_exceeded', 'slow_down'].includes(nativeCode ?? '') || type === 'rate_limit_error')
            || status === 503 && nativeCode === 'server_is_overloaded';
    }
    if (protocol === 'anthropic' && url.hostname === 'api.anthropic.com') {
        return status === 429 && type === 'rate_limit_error' && retryAfterMs !== undefined || status === 529 && type === 'overloaded_error';
    }
    if (protocol === 'gemini' && url.hostname === 'generativelanguage.googleapis.com' && status === 429 && nativeCode === 'RESOURCE_EXHAUSTED') {
        const details = Array.isArray(native?.details) ? native.details.map(objectValue).filter(value => value !== null) : [];
        return retryAfterMs !== undefined && details.some(detail => detail.reason === 'RATE_LIMIT_EXCEEDED');
    }
    return false;
}

export function decodeResponse(response: HttpResponse, protocol?: ProviderProtocol, endpoint?: string): RawProviderResponse {
    let json: JsonObject | null = null;
    try { json = objectValue(JSON.parse(response.body)); } catch {}
    if (!json) {
        throw new ProviderFault('E_RESPONSE_INCOMPLETE', '供应商未返回完整JSON对象',
            { acceptance: response.status >= 200 && response.status < 300 ? 'accepted' : 'unknown', httpStatus: response.status,
                rawResponse: { httpStatus: response.status, headers: response.headers, body: response.body, json: {}, parseError: 'invalid_json_or_non_object' } });
    }
    const raw = { httpStatus: response.status, headers: response.headers, body: response.body, json };
    if (response.status >= 200 && response.status < 300 && (!json.error || protocol === 'openai_responses'
        && ['failed', 'incomplete', 'cancelled'].includes(String(json.status)) && Array.isArray(json.output))) return raw;
    const native = objectValue(json.error);
    const nativeValue = stringValue(native?.code) ?? stringValue(native?.status) ?? stringValue(native?.type);
    const nativeCode = nativeValue && /^[A-Za-z0-9_.-]{1,80}$/.test(nativeValue) ? nativeValue : undefined;
    const httpStatus = response.status;
    const quota = httpStatus === 402 || /insufficient_quota|insufficient_balance|billing_hard_limit|quota_exceeded|credit_balance_exhausted|(?:organization|project)_(?:spend|usage)_limit_exceeded/i.test(nativeCode ?? '');
    const retryAfterMs = parseRetryAfter(response.headers['retry-after']);
    const temporary = !quota && knownTemporaryRejection(protocol, endpoint, httpStatus, nativeCode, native, retryAfterMs);
    const nativeReason = modelUnavailableReason(httpStatus, native);
    const code = quota ? 'E_QUOTA' : nativeReason ? 'E_MODEL_UNAVAILABLE' : [401, 403].includes(httpStatus) ? 'E_AUTH' : httpStatus === 429 ? 'E_RATE_LIMIT' : temporary ? 'E_PROVIDER_TEMPORARY'
        : [400, 404, 405, 413, 422].includes(httpStatus) ? 'E_PARAMETER_INVALID' : 'E_RESULT_UNKNOWN';
    const executionEvidence = json.usage != null || json.usageMetadata != null
        || (Array.isArray(json.output) && json.output.length > 0) || (Array.isArray(json.candidates) && json.candidates.length > 0)
        || (Array.isArray(json.choices) && json.choices.length > 0);
    const rejected = !executionEvidence && ([400, 401, 402, 403, 404, 405, 410, 413, 422].includes(httpStatus) || temporary) && native !== null;
    const summary = nativeReason === 'model_unavailable_for_new_users' ? '供应商当前未向新用户提供所选模型，请核对账户可用性与目录'
        : nativeReason === 'model_account_access_unavailable' ? '当前账户或项目无权使用所选模型，请核对账户可用性'
        : nativeReason ? '供应商未找到所选模型或不支持该模型操作，请核对最新目录与账户可用性' : '供应商请求未成功';
    throw new ProviderFault(code, `${summary}（HTTP ${httpStatus}），原始响应已保留`,
        { acceptance: executionEvidence ? 'accepted' : rejected ? 'rejected' : 'unknown', phase: executionEvidence ? 'accepted' : rejected ? 'rejected' : 'unknown',
            httpStatus, nativeCode, ...(nativeReason ? { nativeReason } : {}),
            retryAfterMs, rawResponse: raw, retryable: temporary && rejected,
            ...(protocol && (json.usage !== undefined || json.usageMetadata !== undefined) ? { usage: responseUsage(protocol, json) } : {}) });
}

export function bearerHeaders(credential?: string): Record<string, string> {
    if (credential === undefined) return {};
    if (!credential || /[\r\n]/.test(credential)) throw new ProviderFault('E_AUTH', '凭据内容无效', { acceptance: 'not_sent' });
    return { Authorization: `Bearer ${credential}` };
}
