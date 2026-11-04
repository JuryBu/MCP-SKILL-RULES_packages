import type { JsonObject } from '../protocol.js';
import { assembleResponse, freezeOwned, immutableJson, objectValue, stringValue } from './assemble.js';
import { decodeResponse, responseUsage, safeTransportCause } from './http.js';
import { ProviderStreamAssembly } from './stream-assembly.js';
import { ProviderFault } from './types.js';
import type { HttpRequest, NormalizedResponse, ProviderAttempt, RawProviderResponse, SendContext } from './types.js';

class EventStreamDecoder {
    private readonly decoder = new TextDecoder('utf-8', { fatal: true });
    private buffer = '';
    private data: string[] = [];
    private eventType = 'message';
    private readonly wire: string[] = [];

    constructor(private readonly accept: (type: string, data: JsonObject | null) => Promise<void>) {}

    get body(): string { return this.wire.join(''); }

    async push(chunk: Uint8Array, final = false): Promise<void> {
        const text = this.decoder.decode(chunk, { stream: !final });
        this.wire.push(text);
        this.buffer += text;
        while (true) {
            const newline = this.buffer.search(/[\r\n]/);
            if (newline < 0 || !final && this.buffer[newline] === '\r' && newline === this.buffer.length - 1) break;
            const line = this.buffer.slice(0, newline);
            const skip = this.buffer[newline] === '\r' && this.buffer[newline + 1] === '\n' ? 2 : 1;
            this.buffer = this.buffer.slice(newline + skip);
            if (!line) {
                if (this.data.length) {
                    const payload = this.data.join('\n');
                    if (payload === '[DONE]') await this.accept('[DONE]', null);
                    else {
                        const event = objectValue(JSON.parse(payload));
                        if (!event) throw new Error('Stream data must be an object');
                        await this.accept(this.eventType === 'message' ? stringValue(event.type) ?? 'message' : this.eventType, event);
                    }
                }
                this.data = [];
                this.eventType = 'message';
            } else if (!line.startsWith(':')) {
                const separator = line.indexOf(':');
                const name = separator < 0 ? line : line.slice(0, separator);
                const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
                if (name === 'data') this.data.push(value);
                else if (name === 'event') this.eventType = value;
            }
        }
        if (final && (this.buffer.trim() || this.data.length)) throw new Error('Incomplete stream frame');
    }
}

export async function requestProviderResponse(attempt: ProviderAttempt, context: SendContext, request: HttpRequest,
    normalize: (attemptId: string, raw: RawProviderResponse) => NormalizedResponse, signal?: AbortSignal): Promise<RawProviderResponse> {
    const protocol = attempt.snapshot.profile.protocol;
    if (!attempt.snapshot.streaming) return decodeResponse(await context.transport.request(request, signal), protocol, request.url);
    const state = new ProviderStreamAssembly(protocol);
    let seq = 0;
    let streamed = false;
    let status = 200;
    let headers: Record<string, string> = {};
    const emit = async (type: string, native: JsonObject | null): Promise<void> => {
        const textDelta = state.accept(type, native);
        await context.onPartial?.({ attemptId: attempt.attemptId, seq: ++seq, receivedAt: new Date().toISOString(), kind: 'event',
            eventType: type, native: native ? immutableJson(native) : null, providerResponseId: state.responseId, ...(textDelta ? { textDelta } : {}) });
    };
    const decoder = new EventStreamDecoder(emit);
    const raw = (complete: boolean, body = decoder.body): RawProviderResponse => ({ httpStatus: status, headers, body,
        json: state.data, stream: { protocol, complete, eventCount: state.eventCount } });
    try {
        const response = await context.transport.request({ ...request, onChunk: async (chunk, metadata) => {
            status = metadata.status;
            headers = metadata.headers;
            if (status < 200 || status >= 300 || !/text\/event-stream/i.test(headers['content-type'] ?? '')) return;
            streamed = true;
            await context.onPartial?.({ attemptId: attempt.attemptId, seq: ++seq, receivedAt: new Date().toISOString(), kind: 'transport',
                eventType: 'transport.chunk', native: null, providerResponseId: state.responseId, receivedBytes: chunk.byteLength });
            await decoder.push(chunk);
        } }, signal);
        status = response.status;
        headers = response.headers;
        if (status < 200 || status >= 300 || !streamed && !/text\/event-stream/i.test(headers['content-type'] ?? '')) return decodeResponse(response, protocol, request.url);
        if (!streamed) { streamed = true; await decoder.push(Buffer.from(response.body)); }
        await decoder.push(new Uint8Array(), true);
        if (!state.complete) throw new ProviderFault(state.failed ? 'E_PROVIDER_STREAM' : 'E_RESPONSE_INCOMPLETE',
            '原生流未完整结束，原事件、部分结果和费用事实保留', { acceptance: 'accepted', rawResponse: raw(false) });
        return raw(true, response.body);
    } catch (error) {
        if (!streamed) throw error;
        const fault = error instanceof ProviderFault ? error : undefined;
        const original = raw(false, fault?.rawResponse?.body || decoder.body);
        let partialResponse: NormalizedResponse | undefined;
        try {
            const normalized = assembleResponse(attempt.attemptId, original, normalize);
            partialResponse = freezeOwned({ ...normalized, complete: false, canExecuteTools: false,
                usage: { ...normalized.usage, issues: [...normalized.usage.issues, 'partial_stream_usage'] },
                stop: { ...normalized.stop, kind: 'unknown' as const }, problems: [...normalized.problems, 'E_RESPONSE_INCOMPLETE'] });
        } catch {}
        const hasUsage = state.data.usage !== undefined || state.data.usageMetadata !== undefined;
        const usage = hasUsage ? responseUsage(protocol, state.data) : undefined;
        throw new ProviderFault(fault?.code ?? 'E_RESPONSE_INCOMPLETE', fault?.message ?? '原生流接收或保存中断，原请求保留，停止自动重发',
            { acceptance: 'accepted', phase: 'accepted', httpStatus: status, transportPhase: fault?.transportPhase,
                transportCause: fault?.transportCause ?? safeTransportCause(error), rawResponse: original, partialResponse,
                ...(usage ? { usage: { ...usage, issues: [...usage.issues, 'partial_stream_usage'] } } : {}) });
    }
}
