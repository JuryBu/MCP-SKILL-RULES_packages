import { AgentFault } from '../protocol.js';
import type { JsonObject, JsonValue } from '../protocol.js';
import { normalizeUsage } from '../accounting/usage.js';
import type { ModelEntry, ParameterSpec } from '../models/catalog.js';
import type { Evidence } from '../models/evidence.js';
import { arrayObjects, assembleResponse, checkToolResults, freezeOwned, gateDeclaredTools, immutableJson, mediaBlock, objectValue, parseArguments, requireRoute, stringValue, validateTools, verifySnapshot } from './assemble.js';
import { attemptTimeout, bearerHeaders, decodeResponse, endpointUrl } from './http.js';
import { requestProviderResponse } from './streaming.js';
import type { DiscoveryPage, NativeBlock, NativeSendView, NormalizedResponse, ProviderAdapter, ProviderAttempt, ProviderProfile, RawProviderResponse, RequestSnapshot, SendContext, StopKind, ToolCall, ToolResult } from './types.js';

const reserved = new Set(['model', 'messages', 'contents', 'input', 'tools', 'stream', 'stream_options', 'provider', 'headers']);

export function normalizeCompatibleChatMetadata(entry: ModelEntry): ModelEntry {
    const metadata = entry.rawMetadata;
    const architecture = objectValue(metadata.architecture);
    const topProvider = objectValue(metadata.top_provider);
    const positiveCount = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
    const strings = (value: unknown): string[] | null => Array.isArray(value) && value.length > 0
        && value.every(item => typeof item === 'string' && item.trim().length > 0) ? [...new Set(value as string[])] : null;
    const declared = <Value>(template: Evidence<Value>, value: Value | null): Evidence<Value> => ({
        ...template, value, status: value === null ? 'unknown' : 'supported',
    });
    const maximum = positiveCount(Object.hasOwn(metadata, 'max_output_tokens') ? metadata.max_output_tokens : topProvider?.max_completion_tokens);
    const parameters = { ...entry.parameters };
    const { source, sourceRef, observedAt, expiresAt, scope, version, confidence } = entry.contextWindow;
    const parameter = (value: ParameterSpec): Evidence<ParameterSpec> => ({ source, sourceRef, observedAt, expiresAt,
        scope, version, confidence, value, status: 'supported' });
    if (maximum !== null) parameters.maxOutputTokens = parameter({ type: 'integer', min: 1, max: maximum, wirePath: 'max_tokens' });
    const effort = objectValue(metadata.effort);
    const levels = strings(effort?.supported_levels);
    if (levels) {
        const defaultLevel = typeof effort?.default_level === 'string' && levels.includes(effort.default_level) ? effort.default_level : null;
        parameters.reasoningEffort = parameter({ type: 'string', enum: levels, wirePath: 'reasoning_effort',
            ...(defaultLevel !== null ? { default: defaultLevel } : {}) });
    }
    return { ...entry, displayName: stringValue(metadata.displayName) ?? stringValue(metadata.name) ?? entry.modelId,
        contextWindow: declared(entry.contextWindow, positiveCount(Object.hasOwn(metadata, 'context_window') ? metadata.context_window : metadata.context_length)),
        maxOutputTokens: declared(entry.maxOutputTokens, maximum),
        inputModalities: declared(entry.inputModalities, strings(Object.hasOwn(metadata, 'input_modalities') ? metadata.input_modalities : architecture?.input_modalities)),
        outputModalities: declared(entry.outputModalities, strings(Object.hasOwn(metadata, 'output_modalities') ? metadata.output_modalities : architecture?.output_modalities)),
        parameters };
}

function normalizeChatResponse(attemptId: string, raw: RawProviderResponse): NormalizedResponse {
    const data = raw.json;
    const choices = arrayObjects(data.choices);
    const blocks: NativeBlock[] = [];
    const toolCalls: ToolCall[] = [];
    const replayMessages: JsonObject[] = [];
    const problems: string[] = [];
    const reasons: JsonValue[] = [];
    const indices = new Set<number>();
    let complete = choices.length > 0;
    let stop: StopKind = 'completed';
    choices.forEach((choice, position) => {
        const candidateIndex = typeof choice.index === 'number' ? choice.index : position;
        if (!Number.isSafeInteger(candidateIndex) || candidateIndex < 0 || indices.has(candidateIndex)) problems.push('E_RESPONSE_SCHEMA');
        indices.add(candidateIndex);
        const message = objectValue(choice.message);
        const reason = stringValue(choice.finish_reason);
        reasons.push(reason);
        if (!reason || !message || message.role !== 'assistant') complete = false;
        if (message) replayMessages.push(message);
        if (reason === 'length') stop = 'truncated';
        else if (reason === 'content_filter') stop = 'refused';
        else if (reason && !['stop', 'tool_calls'].includes(reason)) { stop = 'unknown'; problems.push('E_STOP_UNKNOWN'); }
        if (!message) return;
        const nativeRef = `choices/${position}/message`;
        if (typeof message.content === 'string' && message.content.length) {
            blocks.push({ index: 0, candidateIndex, type: 'text', text: message.content, nativeRef: `${nativeRef}/content`, native: message.content });
        } else if (Array.isArray(message.content)) {
            message.content.forEach((value, index) => {
                const part = objectValue(value);
                if (part?.type === 'text' && typeof part.text === 'string') {
                    blocks.push({ index, candidateIndex, type: 'text', text: part.text, nativeRef: `${nativeRef}/content/${index}`, native: part });
                } else if (part?.type === 'image_url') {
                    const uri = stringValue(objectValue(part.image_url)?.url);
                    const inline = uri?.match(/^data:([^;,]+);base64,(.*)$/s);
                    if (inline) blocks.push(mediaBlock(part, { index, candidateIndex, nativeRef: `${nativeRef}/content/${index}`,
                        mime: inline[1], dataBase64: inline[2] }));
                    else if (uri) blocks.push(mediaBlock(part, { index, candidateIndex, nativeRef: `${nativeRef}/content/${index}`, mime: 'image/unknown', uri }));
                    else problems.push('E_MEDIA_INVALID');
                } else if (part?.type === 'refusal' && typeof part.refusal === 'string') {
                    blocks.push({ index, candidateIndex, type: 'refusal', text: part.refusal, nativeRef: `${nativeRef}/content/${index}`, native: part });
                    stop = 'refused';
                } else {
                    blocks.push({ index, candidateIndex, type: 'native_unknown', nativeRef: `${nativeRef}/content/${index}`, native: value });
                    problems.push('E_NATIVE_BLOCK_UNSUPPORTED');
                }
            });
        }
        if (typeof message.refusal === 'string' && message.refusal.length) {
            blocks.push({ index: blocks.length, candidateIndex, type: 'refusal', text: message.refusal, nativeRef: `${nativeRef}/refusal`, native: message.refusal });
            stop = 'refused';
        }
        for (const [index, call] of arrayObjects(message.tool_calls).entries()) {
            const fn = objectValue(call.function);
            const callId = stringValue(call.id);
            const name = stringValue(fn?.name);
            const args = parseArguments(fn?.arguments);
            if (call.type !== 'function' || !callId || !name || !args || reason !== 'tool_calls') {
                problems.push('E_TOOL_ARGUMENTS');
                continue;
            }
            toolCalls.push({ callId, providerCallId: callId, name, arguments: args, candidateIndex, index,
                nativeRef: `${nativeRef}/tool_calls/${index}`, native: call });
        }
        if (reason === 'tool_calls' && !arrayObjects(message.tool_calls).length) problems.push('E_TOOL_ARGUMENTS');
    });
    if (Array.isArray(data.choices) && choices.length !== data.choices.length) problems.push('E_RESPONSE_SCHEMA');
    if (new Set(toolCalls.map(call => call.callId)).size !== toolCalls.length) problems.push('E_TOOL_PAIRING');
    if (toolCalls.length && choices.length !== 1) problems.push('E_MULTIPLE_TOOL_CANDIDATES');
    if (!complete) { stop = 'unknown'; problems.push('E_RESPONSE_INCOMPLETE'); }
    if (problems.length && !['truncated', 'refused'].includes(stop)) stop = 'unknown';
    if (complete && !problems.length && stop === 'completed' && toolCalls.length) stop = 'tool_calls';
    if (complete && !blocks.length && !toolCalls.length) { stop = 'unknown'; problems.push('E_RESPONSE_EMPTY'); }
    return freezeOwned({ attemptId, providerRequestId: raw.headers['x-request-id'] ?? raw.headers['request-id'] ?? null,
        providerResponseId: stringValue(data.id), modelId: stringValue(data.model), routeId: stringValue(data.provider),
        blocks, toolCalls, stop: { kind: stop, native: reasons }, usage: normalizeUsage('compatible_chat', data.usage),
        raw, complete, canExecuteTools: complete && !problems.length && stop === 'tool_calls', replayMessages, problems });
}

export class CompatibleChatAdapter implements ProviderAdapter {
    readonly protocol = 'compatible_chat' as const;
    readonly version = 'compatible-chat-v1';

    endpoint(profile: ProviderProfile, _modelId: string): string {
        return endpointUrl(profile.baseUrl, '/chat/completions');
    }

    encode(view: NativeSendView, modelId: string, parameters: JsonObject): JsonObject {
        if (view.protocol !== this.protocol || !view.messages?.length || view.contents || view.input || view.system !== undefined || view.systemInstruction) {
            throw new AgentFault('E_PROTOCOL_MISMATCH', 'Chat适配器需要完整的原生messages发送视图');
        }
        for (const key of Object.keys(parameters)) if (reserved.has(key)) throw new AgentFault('E_PARAMETER_CONFLICT', `参数${key}由核心固定`);
        if (parameters.n !== undefined && parameters.n !== 1) throw new AgentFault('E_PARAMETER_UNSUPPORTED', '工具执行首版仅支持一个响应候选');
        validateTools(view);
        const pending = new Set<string>();
        for (const message of view.messages) {
            if (message.role === 'tool') {
                const callId = stringValue(message.tool_call_id);
                if (!callId || !pending.delete(callId)) throw new AgentFault('E_TOOL_PAIRING', 'Chat发送视图含未配对或重复的工具结果');
            } else {
                if (pending.size) throw new AgentFault('E_TOOL_PAIRING', 'Chat发送视图有尚未返回结果的工具调用');
                for (const call of arrayObjects(message.tool_calls)) {
                    const callId = stringValue(call.id);
                    if (message.role !== 'assistant' || !callId || pending.has(callId)) throw new AgentFault('E_TOOL_PAIRING', 'Chat工具调用身份无效或重复');
                    pending.add(callId);
                }
            }
        }
        if (pending.size) throw new AgentFault('E_TOOL_PAIRING', 'Chat发送前必须补齐工具结果');
        const body: JsonObject = { ...parameters, model: modelId, messages: view.messages, stream: view.stream === true };
        if (view.stream) body.stream_options = { include_usage: true };
        if (view.tools?.length) body.tools = view.tools.map(tool => ({ type: 'function', function: { name: tool.name,
            parameters: tool.parameters, ...(tool.description !== undefined ? { description: tool.description } : {}),
            ...(tool.strict !== undefined ? { strict: tool.strict } : {}) } }));
        return body;
    }

    validate(snapshot: RequestSnapshot): void {
        verifySnapshot(snapshot, this);
        requireRoute(snapshot);
        const body = JSON.parse(snapshot.body) as JsonObject;
        if (body.model !== snapshot.modelId || body.stream !== (snapshot.streaming === true) || !Array.isArray(body.messages) || !body.messages.length) {
            throw new AgentFault('E_REQUEST_SCHEMA', '冻结的Chat请求不完整');
        }
        const policy = snapshot.profile.routePolicy;
        if (policy.kind === 'pinned_aggregator') {
            const provider = objectValue(body.provider);
            if (provider?.allow_fallbacks !== false || provider.require_parameters !== true || !Array.isArray(provider.only)
                || provider.only.length !== 1 || provider.only[0] !== policy.provider) {
                throw new AgentFault('E_ROUTE_UNVERIFIED', '冻结请求未完整固定聚合路由');
            }
        }
    }

    async send(attempt: ProviderAttempt, context: SendContext, signal?: AbortSignal): Promise<NormalizedResponse> {
        this.validate(attempt.snapshot);
        const policy = attempt.snapshot.profile.routePolicy;
        const body = attempt.snapshot.body;
        if (policy.kind === 'pinned_aggregator') {
            const parsed = JSON.parse(body) as JsonObject;
            if (!objectValue(parsed.provider)) throw new AgentFault('E_ROUTE_UNVERIFIED', '聚合路由设置必须在冻结前写入实际请求');
        }
        const raw = await requestProviderResponse(attempt, context, { method: 'POST', url: attempt.snapshot.endpoint,
            headers: { 'Content-Type': 'application/json', ...bearerHeaders(context.credential) },
            body, timeoutMs: attemptTimeout(attempt) }, normalizeChatResponse, signal);
        const names = arrayObjects((JSON.parse(body) as JsonObject).tools).map(tool => stringValue(objectValue(tool.function)?.name) ?? '');
        return gateDeclaredTools(assembleResponse(attempt.attemptId, raw, normalizeChatResponse), names);
    }

    async discover(profile: ProviderProfile, cursor: string | null, context: SendContext, signal?: AbortSignal): Promise<DiscoveryPage> {
        const base = profile.baseUrl.replace(/\/chat\/completions\/?$/, '');
        const url = new URL(endpointUrl(base, '/models'));
        url.searchParams.set('limit', String(profile.discovery.pageSize));
        if (cursor) url.searchParams.set('after', cursor);
        const raw = decodeResponse(await context.transport.request({ method: 'GET', url: url.href,
            headers: bearerHeaders(context.credential), timeoutMs: 10_000, maxResponseBytes: 4 * 1024 * 1024 }, signal));
        if (!Array.isArray(raw.json.data) || raw.json.data.some(model => !objectValue(model))) {
            throw new AgentFault('E_CATALOG_INCOMPLETE', '模型目录页缺少完整data数组');
        }
        const hasMore = raw.json.has_more === true;
        const nextCursor = stringValue(raw.json.next_cursor) ?? (hasMore ? stringValue(raw.json.last_id) : null);
        if (hasMore && !nextCursor) throw new AgentFault('E_CATALOG_INCOMPLETE', '模型目录声明有下一页但缺少游标');
        return { models: raw.json.data as JsonObject[], nextCursor, complete: !hasMore && !nextCursor };
    }

    continueView(view: NativeSendView, response: NormalizedResponse, results: ToolResult[]): NativeSendView {
        return immutableJson(this.continueHistoryView(view, response, results));
    }

    continueHistoryView(view: NativeSendView, response: NormalizedResponse, results: ToolResult[]): NativeSendView {
        if (view.protocol !== this.protocol || !response.canExecuteTools || !response.complete) {
            throw new AgentFault('E_TOOL_COMMIT_REQUIRED', '只有完整有效并经核心提交的工具响应可继续');
        }
        checkToolResults(response.toolCalls, results);
        const toolMessages: JsonObject[] = [];
        const imageMessages: JsonObject[] = [];
        for (const call of response.toolCalls) {
            const result = results.find(entry => entry.callId === call.callId)!;
            toolMessages.push({ role: 'tool', tool_call_id: call.providerCallId!, content: typeof result.result === 'string'
                ? result.result : JSON.stringify(result.result) });
            if (!result.nativeParts) continue;
            for (const [index, part] of result.nativeParts.entries()) {
                const image = objectValue(part.image_url);
                if (part.type === 'text' && typeof part.text === 'string') continue;
                if (part.type === 'image_url' && typeof image?.url === 'string' && image.url.startsWith('data:image/')) continue;
                throw new AgentFault('E_TOOL_IMAGE_NATIVE_PARTS_UNSUPPORTED', 'Compatible Chat工具图像只消费text与原始image_url块', {
                    protocol: this.protocol, field: `nativeParts[${index}]`, type: part.type ?? null,
                });
            }
            imageMessages.push({ role: 'user', content: [{ type: 'text', text: `原工具调用 ${call.callId}（${call.name}）返回的图片原件` }, ...result.nativeParts] });
        }
        return { ...view, messages: [...(view.messages ?? []), ...response.replayMessages, ...toolMessages, ...imageMessages] };
    }

    async lookup(): Promise<{ status: 'unsupported' }> { return { status: 'unsupported' }; }
}

export { normalizeChatResponse };
