import http from 'node:http';
import https from 'node:https';
import {
    antigravityFailure,
    remainingAntigravityMs,
    type AntigravityEndpoint,
    type AntigravityOutcome,
    type AntigravityRequest,
    type AntigravityResult,
} from './antigravity-types.js';

const RPC_PREFIX = '/exa.language_server_pb.LanguageServerService/';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export interface AntigravityRpcResponse {
    status: number;
    data: unknown;
    submitted: boolean;
}

export interface AntigravityRpcOptions {
    deadline: number;
    signal?: AbortSignal;
    maxResponseBytes?: number;
    onSubmitted?: AntigravityRequest['onSubmitted'];
}

export class AntigravityRpcError extends Error {
    constructor(
        message: string,
        readonly outcome: AntigravityOutcome,
        readonly submitted: boolean,
        readonly safeToFallback: boolean,
    ) {
        super(message);
        this.name = 'AntigravityRpcError';
    }
}

function object(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function safeMessage(message: string, endpoint: AntigravityEndpoint): string {
    let sanitized = message;
    if (endpoint.csrfToken) sanitized = sanitized.split(endpoint.csrfToken).join('[redacted]');
    return sanitized
        .replace(/(?:bearer\s+)[\w.+/=-]+/gi, 'Bearer [redacted]')
        .replace(/((?:csrf[_-]?token|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
        .slice(0, 600);
}

export function callAntigravityRpc(
    endpoint: AntigravityEndpoint,
    method: string,
    payload: Record<string, unknown>,
    options: AntigravityRpcOptions,
): Promise<AntigravityRpcResponse> {
    const generation = method === 'GetModelResponse';
    if (endpoint.host !== '127.0.0.1' || !Number.isInteger(endpoint.port)
        || endpoint.port < 1 || endpoint.port > 65535
        || !Number.isInteger(endpoint.pid) || endpoint.pid <= 0 || !endpoint.identity
        || !/^[A-Za-z][A-Za-z0-9]*$/.test(method)) {
        return Promise.reject(new AntigravityRpcError('Invalid owned loopback endpoint or RPC method', 'not-started', false, false));
    }
    if (options.signal?.aborted) {
        return Promise.reject(new AntigravityRpcError('Antigravity request cancelled before dispatch', 'cancelled', false, false));
    }
    const remaining = remainingAntigravityMs(options);
    if (remaining <= 0) {
        return Promise.reject(new AntigravityRpcError('Antigravity deadline expired before dispatch', 'not-started', false, false));
    }
    let body: string;
    try {
        body = JSON.stringify(payload);
    } catch {
        return Promise.reject(new AntigravityRpcError('RPC payload is not JSON serializable', 'rejected', false, false));
    }
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
        return Promise.reject(new AntigravityRpcError('Antigravity request exceeds the byte limit', 'rejected', false, false));
    }
    if (remainingAntigravityMs(options) <= 0) {
        return Promise.reject(new AntigravityRpcError('Antigravity deadline expired while preparing the request', 'not-started', false, false));
    }
    const responseLimit = Number.isFinite(options.maxResponseBytes)
        ? Math.max(1, Math.min(MAX_RESPONSE_BYTES, Math.floor(options.maxResponseBytes!))) : MAX_RESPONSE_BYTES;
    return new Promise((resolve, reject) => {
        let settled = false;
        let dispatched = false;
        let response: http.IncomingMessage | undefined;
        let request: http.ClientRequest | undefined;
        let timer: NodeJS.Timeout | undefined;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
        };
        const fail = (outcome: AntigravityOutcome, message: string, allowFallback = false) => {
            if (settled) return;
            settled = true;
            cleanup();
            response?.destroy();
            request?.destroy();
            reject(new AntigravityRpcError(
                safeMessage(message, endpoint),
                outcome,
                generation && dispatched,
                allowFallback && !(generation && dispatched) && remainingAntigravityMs(options) > 0,
            ));
        };
        const abort = () => fail('cancelled', 'Antigravity request cancelled');
        const expire = () => fail(generation && dispatched ? 'timeout-unknown' : 'not-started',
            generation && dispatched ? 'Antigravity deadline expired after dispatch; generation outcome unknown'
                : 'Antigravity deadline expired before generation');
        timer = setTimeout(expire, Math.max(1, Math.min(remainingAntigravityMs(options), 2147483647)));
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) {
            abort();
            return;
        }
        try {
            const transport = endpoint.useHttps ? https : http;
            request = transport.request({
                hostname: endpoint.host,
                port: endpoint.port,
                path: `${RPC_PREFIX}${method}`,
                method: 'POST',
                agent: false,
                ...(endpoint.useHttps ? { rejectUnauthorized: false } : {}),
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'Connect-Protocol-Version': '1',
                    ...(endpoint.csrfToken ? { 'x-codeium-csrf-token': endpoint.csrfToken } : {}),
                },
            }, incoming => {
                response = incoming;
                const chunks: Buffer[] = [];
                let size = 0;
                const declaredLength = Number(incoming.headers['content-length']);
                if (Number.isFinite(declaredLength) && declaredLength > responseLimit) {
                    fail('invalid-response', 'Antigravity response exceeds the byte limit');
                    return;
                }
                incoming.on('data', (chunk: Buffer | string) => {
                    if (settled) return;
                    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    size += buffer.length;
                    if (size > responseLimit) {
                        fail('invalid-response', 'Antigravity response exceeds the byte limit');
                        return;
                    }
                    chunks.push(buffer);
                });
                incoming.once('aborted', () => fail(generation && dispatched ? 'transport-unknown' : 'not-started',
                    'Antigravity response was interrupted', true));
                incoming.once('error', () => fail(generation && dispatched ? 'transport-unknown' : 'not-started',
                    'Antigravity response stream failed', true));
                incoming.once('end', () => {
                    if (settled) return;
                    if (!incoming.complete) {
                        fail(generation && dispatched ? 'transport-unknown' : 'not-started',
                            'Antigravity response ended before completion', true);
                        return;
                    }
                    let data: unknown;
                    const raw = Buffer.concat(chunks, size).toString('utf8');
                    try {
                        data = raw ? JSON.parse(raw) : null;
                    } catch {
                        if ((incoming.statusCode ?? 0) >= 400) data = { message: raw.slice(0, 600) };
                        else { fail('invalid-response', 'Antigravity returned malformed JSON'); return; }
                    }
                    if (remainingAntigravityMs(options) <= 0) { expire(); return; }
                    settled = true;
                    cleanup();
                    resolve({ status: incoming.statusCode ?? 0, data, submitted: generation && dispatched });
                });
            });
            request.once('socket', socket => {
                socket.once(endpoint.useHttps ? 'secureConnect' : 'connect', () => { dispatched = true; });
            });
            request.once('finish', () => {
                dispatched = true;
                if (generation) {
                    try { options.onSubmitted?.(typeof payload.model === 'string' ? payload.model : undefined); }
                    catch { fail('transport-unknown', 'Antigravity submission tracking failed after dispatch'); }
                }
            });
            request.once('error', () => fail(generation && dispatched ? 'transport-unknown' : 'not-started',
                generation && dispatched ? 'Antigravity connection failed after dispatch; generation outcome unknown'
                    : 'Antigravity endpoint connection failed before dispatch', true));
            request.end(body);
        } catch {
            fail('not-started', 'Antigravity RPC could not be constructed');
        }
    });
}

function rpcErrorDetails(response: AntigravityRpcResponse): { code: string; message: string; failed: boolean } {
    const data = object(response.data);
    const nested = object(data?.error);
    const codeValue = nested?.code ?? data?.code;
    const messageValue = nested?.message ?? data?.message ?? data?.error;
    const code = typeof codeValue === 'string' ? codeValue.toLowerCase().replace(/-/g, '_') : '';
    const message = typeof messageValue === 'string' ? messageValue : '';
    const failed = response.status < 200 || response.status >= 300
        || (data?.error !== undefined && data.error !== null && data.error !== '')
        || (data?.errors !== undefined && data.errors !== null)
        || (code !== '' && code !== 'ok' && code !== '0');
    return { code, message, failed };
}

export function isAntigravityRpcUnsupported(response: AntigravityRpcResponse): boolean {
    const { code, message, failed } = rpcErrorDetails(response);
    const data = object(response.data);
    if (!failed || [401, 403, 429, 503].includes(response.status)
        || ['unauthenticated', 'permission_denied', 'resource_exhausted'].includes(code)
        || /quota|rate.?limit|resource.?exhausted|credit.?exhausted/i.test(message)
        || (typeof data?.response === 'string' && data.response.length > 0)) return false;
    return code === 'unimplemented'
        || ([404, 405, 501].includes(response.status)
            && (response.data === null || /(?:unknown|unimplemented|unsupported|not found|not implemented).*(?:method|rpc|service)|(?:method|rpc|service).*(?:unknown|unsupported|not found|not implemented)/i.test(message)));
}

export function antigravityRpcFailure(
    response: AntigravityRpcResponse,
    endpoint: AntigravityEndpoint,
    model: string | null = null,
): AntigravityResult | null {
    const { code, message, failed } = rpcErrorDetails(response);
    if (!failed) return null;
    const error = safeMessage(message || `Antigravity RPC returned HTTP ${response.status}${code ? ` (${code})` : ''}`, endpoint);
    if (response.status === 401 || code === 'unauthenticated') {
        return antigravityFailure('auth-required', error, endpoint.transport, model, response.submitted);
    }
    if (response.status === 429 || code === 'resource_exhausted' || /quota|rate.?limit|resource.?exhausted|credit.?exhausted/i.test(message)) {
        return antigravityFailure('quota-exhausted', error, endpoint.transport, model, response.submitted);
    }
    if (response.status === 403 || code === 'permission_denied') {
        return antigravityFailure('rejected', error, endpoint.transport, model, response.submitted);
    }
    const generatedText = object(response.data)?.response;
    if (response.status === 503) {
        if (/\bno capacity available\b/i.test(message)
            && (generatedText === undefined || generatedText === null || generatedText === '')) {
            return antigravityFailure('rejected', error, endpoint.transport, model, response.submitted, true);
        }
        return antigravityFailure(response.submitted ? 'transport-unknown' : 'rejected', error,
            endpoint.transport, model, response.submitted);
    }
    const missingModel = !object(response.data)?.response
        && /(?:unknown model(?: key)?|model[^\n]{0,100}(?:not found|does not exist|not available|unsupported))/i.test(message);
    if (isAntigravityRpcUnsupported(response) || missingModel) {
        return antigravityFailure('unsupported', error, endpoint.transport, model, response.submitted, true);
    }
    if (code === 'cancelled' || code === 'canceled') {
        return antigravityFailure('cancelled', error, endpoint.transport, model, response.submitted);
    }
    if (code === 'deadline_exceeded' || response.status === 408 || response.status === 504) {
        return antigravityFailure(response.submitted ? 'timeout-unknown' : 'not-started', error,
            endpoint.transport, model, response.submitted);
    }
    return antigravityFailure(response.submitted ? 'transport-unknown' : 'rejected', error,
        endpoint.transport, model, response.submitted);
}

export function antigravityRpcException(
    error: unknown,
    endpoint: AntigravityEndpoint,
    model: string | null = null,
): AntigravityResult {
    if (error instanceof AntigravityRpcError) {
        return antigravityFailure(error.outcome, safeMessage(error.message, endpoint), endpoint.transport,
            model, error.submitted, error.safeToFallback);
    }
    return antigravityFailure('transport-unknown', 'Unexpected Antigravity RPC failure; submission state unknown',
        endpoint.transport, model, true);
}

export async function callAntigravityModel(
    request: AntigravityRequest,
    endpoint: AntigravityEndpoint,
    model: string,
): Promise<AntigravityResult> {
    try {
        const response = await callAntigravityRpc(endpoint, 'GetModelResponse', { prompt: request.prompt, model }, request);
        const failure = antigravityRpcFailure(response, endpoint, model);
        if (failure) return failure;
        const data = object(response.data);
        const terminal = data?.terminalStatus;
        const complete = terminal === undefined || (typeof terminal === 'string'
            && ['success', 'succeeded', 'complete', 'completed', 'done', 'ok'].includes(terminal.toLowerCase()));
        if (!data || typeof data.response !== 'string' || !data.response.trim() || !complete
            || data.done === false || data.complete === false) {
            return antigravityFailure('invalid-response', 'Antigravity returned no complete terminal text response',
                endpoint.transport, model, response.submitted);
        }
        return { text: data.response, transport: endpoint.transport, model, outcome: 'success',
            submitted: response.submitted, safeToFallback: false };
    } catch (error) {
        return antigravityRpcException(error, endpoint, model);
    }
}
