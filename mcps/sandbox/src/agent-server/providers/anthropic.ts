import { AgentFault } from '../protocol.js';
import type { JsonObject } from '../protocol.js';
import { normalizeUsage } from '../accounting/usage.js';
import { arrayObjects, assembleResponse, checkToolResults, freezeOwned, gateDeclaredTools, immutableJson, mediaBlock, objectValue, requireRoute, stringValue, validateTools, verifySnapshot } from './assemble.js';
import { attemptTimeout, decodeResponse, endpointUrl } from './http.js';
import { requestProviderResponse } from './streaming.js';
import type { DiscoveryPage, NativeBlock, NativeSendView, NormalizedResponse, ProviderAdapter, ProviderAttempt, ProviderProfile, RawProviderResponse, RequestSnapshot, SendContext, StopKind, ToolCall, ToolResult } from './types.js';

const reserved = new Set(['model', 'messages', 'input', 'contents', 'tools', 'stream', 'system', 'headers']);

export function normalizeAnthropicResponse(attemptId: string, raw: RawProviderResponse): NormalizedResponse {
    const data = raw.json;
    const content = arrayObjects(data.content);
    const blocks: NativeBlock[] = [];
    const toolCalls: ToolCall[] = [];
    const problems: string[] = [];
    const reason = stringValue(data.stop_reason);
    const complete = reason !== null && Array.isArray(data.content) && data.type === 'message' && data.role === 'assistant';
    let stop: StopKind = reason === 'tool_use' ? 'tool_calls' : ['end_turn', 'stop_sequence'].includes(reason ?? '') ? 'completed'
        : ['max_tokens', 'model_context_window_exceeded'].includes(reason ?? '') ? 'truncated'
        : reason === 'pause_turn' ? 'paused' : reason === 'refusal' ? 'refused' : 'unknown';
    if (content.length !== (Array.isArray(data.content) ? data.content.length : 0)) problems.push('E_RESPONSE_SCHEMA');
    content.forEach((part, index) => {
        const nativeRef = `content/${index}`;
        if (part.type === 'text' && typeof part.text === 'string') blocks.push({ index, candidateIndex: 0, type: 'text', text: part.text, nativeRef, native: part });
        else if (part.type === 'tool_use') {
            const callId = stringValue(part.id);
            const name = stringValue(part.name);
            const args = objectValue(part.input);
            if (!callId || !name || !args || reason !== 'tool_use') problems.push('E_TOOL_ARGUMENTS');
            else toolCalls.push({ callId, providerCallId: callId, name, arguments: args, candidateIndex: 0, index, nativeRef, native: part });
        } else if (part.type === 'image') {
            const source = objectValue(part.source);
            const mime = stringValue(source?.media_type);
            const encoded = stringValue(source?.data);
            if (source?.type === 'base64' && mime && encoded) blocks.push(mediaBlock(part, { index, candidateIndex: 0, nativeRef, mime, dataBase64: encoded }));
            else { blocks.push({ index, candidateIndex: 0, type: 'native_unknown', nativeRef, native: part }); problems.push('E_NATIVE_BLOCK_UNSUPPORTED'); }
        } else if (!['thinking', 'redacted_thinking'].includes(String(part.type))) {
            blocks.push({ index, candidateIndex: 0, type: 'native_unknown', nativeRef, native: part });
            problems.push('E_NATIVE_BLOCK_UNSUPPORTED');
        }
    });
    if (!complete) problems.push('E_RESPONSE_INCOMPLETE');
    if (stop === 'tool_calls' && !toolCalls.length) problems.push('E_TOOL_ARGUMENTS');
    if (new Set(toolCalls.map(call => call.callId)).size !== toolCalls.length) problems.push('E_TOOL_PAIRING');
    if (problems.length && stop !== 'refused' && stop !== 'truncated') stop = 'unknown';
    return freezeOwned({ attemptId, providerRequestId: raw.headers['request-id'] ?? null, providerResponseId: stringValue(data.id),
        modelId: stringValue(data.model), routeId: null, blocks, toolCalls, stop: { kind: stop, native: reason }, usage: normalizeUsage('anthropic', data.usage),
        raw, complete, canExecuteTools: complete && !problems.length && stop === 'tool_calls', replayMessages: [{ role: 'assistant', content: data.content ?? [] }], problems });
}

export class AnthropicAdapter implements ProviderAdapter {
    readonly protocol = 'anthropic' as const;
    readonly version = 'anthropic-messages-v1-2023-06-01';
    endpoint(profile: ProviderProfile, _modelId: string): string { return endpointUrl(profile.baseUrl, '/messages'); }

    encode(view: NativeSendView, modelId: string, parameters: JsonObject): JsonObject {
        if (view.protocol !== this.protocol || !view.messages?.length || view.input || view.contents || view.systemInstruction) {
            throw new AgentFault('E_PROTOCOL_MISMATCH', 'Anthropic需要完整原生messages发送视图');
        }
        for (const name of Object.keys(parameters)) if (reserved.has(name)) throw new AgentFault('E_PARAMETER_CONFLICT', `参数${name}由核心固定`);
        if (!Number.isSafeInteger(parameters.max_tokens) || Number(parameters.max_tokens) < 1) throw new AgentFault('E_PARAMETER_INVALID', 'Anthropic请求必须明确正整数max_tokens');
        validateTools(view);
        const body: JsonObject = { ...parameters, model: modelId, messages: view.messages, stream: view.stream === true };
        if (view.system !== undefined) body.system = view.system;
        if (view.tools?.length) body.tools = view.tools.map(tool => ({ name: tool.name, input_schema: tool.parameters,
            ...(tool.description !== undefined ? { description: tool.description } : {}), ...(tool.strict !== undefined ? { strict: tool.strict } : {}) }));
        return body;
    }

    validate(snapshot: RequestSnapshot): void {
        verifySnapshot(snapshot, this);
        requireRoute(snapshot);
        if (snapshot.profile.routePolicy.kind !== 'direct') throw new AgentFault('E_ROUTE_UNVERIFIED', 'Anthropic首版只接明确原生端点');
        const body = JSON.parse(snapshot.body) as JsonObject;
        if (body.model !== snapshot.modelId || body.stream !== (snapshot.streaming === true) || !Array.isArray(body.messages) || !body.messages.length) throw new AgentFault('E_REQUEST_SCHEMA', '冻结的Anthropic请求不完整');
    }

    async send(attempt: ProviderAttempt, context: SendContext, signal?: AbortSignal): Promise<NormalizedResponse> {
        this.validate(attempt.snapshot);
        if (context.credential !== undefined && (!context.credential || /[\r\n]/.test(context.credential))) throw new AgentFault('E_AUTH', '凭据内容无效');
        const raw = await requestProviderResponse(attempt, context, { method: 'POST', url: attempt.snapshot.endpoint,
            headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', ...(context.credential ? { 'x-api-key': context.credential } : {}) },
            body: attempt.snapshot.body, timeoutMs: attemptTimeout(attempt) }, normalizeAnthropicResponse, signal);
        const names = arrayObjects((JSON.parse(attempt.snapshot.body) as JsonObject).tools).map(tool => stringValue(tool.name) ?? '');
        return gateDeclaredTools(assembleResponse(attempt.attemptId, raw, normalizeAnthropicResponse), names);
    }

    async discover(profile: ProviderProfile, cursor: string | null, context: SendContext, signal?: AbortSignal): Promise<DiscoveryPage> {
        const url = new URL(endpointUrl(profile.baseUrl.replace(/\/messages\/?$/, ''), '/models'));
        url.searchParams.set('limit', String(profile.discovery.pageSize));
        if (cursor) url.searchParams.set('after_id', cursor);
        const raw = decodeResponse(await context.transport.request({ method: 'GET', url: url.href, timeoutMs: 10_000, maxResponseBytes: 4 * 1024 * 1024,
            headers: { 'anthropic-version': '2023-06-01', ...(context.credential ? { 'x-api-key': context.credential } : {}) } }, signal));
        if (!Array.isArray(raw.json.data) || raw.json.data.some(value => !objectValue(value))) throw new AgentFault('E_CATALOG_INCOMPLETE', 'Anthropic模型目录缺少完整data数组');
        const hasMore = raw.json.has_more === true;
        const nextCursor = hasMore ? stringValue(raw.json.last_id) : null;
        if (hasMore && !nextCursor) throw new AgentFault('E_CATALOG_INCOMPLETE', 'Anthropic目录缺少下一页身份');
        return { models: raw.json.data as JsonObject[], nextCursor, complete: !hasMore };
    }

    continueView(view: NativeSendView, response: NormalizedResponse, results: ToolResult[]): NativeSendView {
        if (view.protocol !== this.protocol || !response.complete || !response.canExecuteTools) throw new AgentFault('E_TOOL_COMMIT_REQUIRED', 'Anthropic工具续接需要完整有效响应');
        checkToolResults(response.toolCalls, results);
        const content = response.toolCalls.map(call => {
            const result = results.find(item => item.callId === call.callId)!;
            return { type: 'tool_result', tool_use_id: call.providerCallId!, content: result.nativeParts ?? (typeof result.result === 'string' ? result.result : JSON.stringify(result.result)),
                ...(result.isError ? { is_error: true } : {}) };
        });
        return immutableJson({ ...view, messages: [...(view.messages ?? []), ...response.replayMessages, { role: 'user', content }] });
    }

    async lookup(): Promise<{ status: 'unsupported' }> { return { status: 'unsupported' }; }
}
