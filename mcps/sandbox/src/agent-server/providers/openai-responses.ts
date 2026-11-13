import { AgentFault } from '../protocol.js';
import type { JsonObject, JsonValue } from '../protocol.js';
import { normalizeUsage } from '../accounting/usage.js';
import { arrayObjects, assembleResponse, checkToolResults, freezeOwned, gateDeclaredTools, immutableJson, objectValue, parseArguments, requireRoute, stringValue, validateTools, verifySnapshot } from './assemble.js';
import { attemptTimeout, bearerHeaders, decodeResponse, endpointUrl } from './http.js';
import { CompatibleChatAdapter } from './compatible-chat.js';
import { requestProviderResponse } from './streaming.js';
import { providerRequestHeaders } from './request-identity.js';
import type { LookupResult, ProviderLookupHandle } from './types.js';
import type { DiscoveryPage, NativeBlock, NativeSendView, NormalizedResponse, ProviderAdapter, ProviderAttempt, ProviderProfile, RawProviderResponse, RequestSnapshot, SendContext, StopKind, ToolCall, ToolResult } from './types.js';

const reserved = new Set(['model', 'input', 'messages', 'contents', 'tools', 'stream', 'store', 'previous_response_id', 'conversation', 'background', 'instructions', 'provider', 'headers']);

export function normalizeResponsesResponse(attemptId: string, raw: RawProviderResponse): NormalizedResponse {
    const data = raw.json;
    const output = arrayObjects(data.output);
    const blocks: NativeBlock[] = [];
    const toolCalls: ToolCall[] = [];
    const problems: string[] = [];
    const status = stringValue(data.status);
    const complete = ['completed', 'failed', 'incomplete', 'cancelled'].includes(status ?? '') && Array.isArray(data.output);
    let stop: StopKind = status === 'completed' ? 'completed' : status === 'incomplete' ? 'truncated'
        : status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'unknown';
    if (output.length !== (Array.isArray(data.output) ? data.output.length : 0)) problems.push('E_RESPONSE_SCHEMA');
    output.forEach((item, index) => {
        const nativeRef = `output/${index}`;
        if (item.type === 'message') {
            if (item.role !== 'assistant' || !Array.isArray(item.content)) problems.push('E_RESPONSE_SCHEMA');
            for (const [partIndex, value] of (Array.isArray(item.content) ? item.content : []).entries()) {
                const part = objectValue(value);
                if (part?.type === 'output_text' && typeof part.text === 'string') {
                    blocks.push({ index: blocks.length, candidateIndex: 0, type: 'text', text: part.text, nativeRef: `${nativeRef}/content/${partIndex}`, native: part });
                } else if (part?.type === 'refusal' && typeof part.refusal === 'string') {
                    blocks.push({ index: blocks.length, candidateIndex: 0, type: 'refusal', text: part.refusal, nativeRef: `${nativeRef}/content/${partIndex}`, native: part });
                    stop = 'refused';
                } else {
                    blocks.push({ index: blocks.length, candidateIndex: 0, type: 'native_unknown', nativeRef: `${nativeRef}/content/${partIndex}`, native: value });
                    problems.push('E_NATIVE_BLOCK_UNSUPPORTED');
                }
            }
        } else if (item.type === 'function_call') {
            const callId = stringValue(item.call_id);
            const name = stringValue(item.name);
            const args = parseArguments(item.arguments);
            if (!callId || !name || !args || item.async === true || (item.status !== undefined && item.status !== 'completed')) {
                problems.push('E_TOOL_ARGUMENTS');
            } else toolCalls.push({ callId, providerCallId: callId, name, arguments: args, index, candidateIndex: 0, nativeRef, native: item });
        } else if (item.type !== 'reasoning') {
            blocks.push({ index: blocks.length, candidateIndex: 0, type: 'native_unknown', nativeRef, native: item });
            problems.push('E_NATIVE_BLOCK_UNSUPPORTED');
        }
    });
    if (!complete) problems.push('E_RESPONSE_INCOMPLETE');
    if (new Set(toolCalls.map(call => call.callId)).size !== toolCalls.length) problems.push('E_TOOL_PAIRING');
    if (problems.length && stop === 'completed') stop = 'unknown';
    if (stop === 'completed' && toolCalls.length) stop = 'tool_calls';
    return freezeOwned({ attemptId, providerRequestId: raw.headers['x-request-id'] ?? null, providerResponseId: stringValue(data.id),
        modelId: stringValue(data.model), routeId: stringValue(data.provider), blocks, toolCalls, stop: { kind: stop, native: { status: data.status ?? null,
            incomplete_details: data.incomplete_details ?? null, error: data.error ?? null } }, usage: normalizeUsage('openai_responses', data.usage), raw, complete,
        canExecuteTools: complete && !problems.length && stop === 'tool_calls', replayMessages: output, problems });
}

export class OpenAIResponsesAdapter implements ProviderAdapter {
    readonly protocol = 'openai_responses' as const;
    readonly version = 'openai-responses-v1';
    endpoint(profile: ProviderProfile, _modelId: string): string { return endpointUrl(profile.baseUrl, '/responses'); }

    encode(view: NativeSendView, modelId: string, parameters: JsonObject): JsonObject {
        if (view.protocol !== this.protocol || !view.input?.length || view.messages || view.contents || view.systemInstruction
            || (view.system !== undefined && typeof view.system !== 'string')) throw new AgentFault('E_PROTOCOL_MISMATCH', 'Responses需要完整原生input发送视图');
        for (const name of Object.keys(parameters)) if (reserved.has(name)) throw new AgentFault('E_PARAMETER_CONFLICT', `参数${name}由核心固定`);
        validateTools(view);
        const pending = new Set<string>();
        for (const item of view.input) {
            if (item.type === 'function_call') {
                const callId = stringValue(item.call_id);
                if (!callId || pending.has(callId)) throw new AgentFault('E_TOOL_PAIRING', 'Responses函数调用身份无效或重复');
                pending.add(callId);
            } else if (item.type === 'function_call_output') {
                const callId = stringValue(item.call_id);
                if (!callId || !pending.delete(callId)) throw new AgentFault('E_TOOL_PAIRING', 'Responses工具结果缺少匹配调用');
            } else if (pending.size && item.role === 'user') throw new AgentFault('E_TOOL_PAIRING', 'Responses发送视图中仍有未配对的工具调用');
        }
        if (pending.size) throw new AgentFault('E_TOOL_PAIRING', 'Responses发送前必须补齐工具结果');
        const body: JsonObject = { ...parameters, model: modelId, input: view.input, stream: view.stream === true, store: false };
        if (view.system !== undefined) body.instructions = view.system;
        if (view.tools?.length) body.tools = view.tools.map(tool => ({ type: 'function', name: tool.name, parameters: tool.parameters,
            ...(tool.description !== undefined ? { description: tool.description } : {}), ...(tool.strict !== undefined ? { strict: tool.strict } : {}) }));
        return body;
    }

    validate(snapshot: RequestSnapshot): void {
        verifySnapshot(snapshot, this);
        requireRoute(snapshot);
        if (snapshot.profile.routePolicy.kind !== 'direct') throw new AgentFault('E_ROUTE_UNVERIFIED', 'Responses首版只接明确原生端点');
        const body = JSON.parse(snapshot.body) as JsonObject;
        if (body.model !== snapshot.modelId || body.stream !== (snapshot.streaming === true)
            || body.store !== (snapshot.profile.remoteRetention === 'allowed') || !Array.isArray(body.input) || !body.input.length) {
            throw new AgentFault('E_REQUEST_SCHEMA', '冻结的Responses请求不完整');
        }
    }

    async send(attempt: ProviderAttempt, context: SendContext, signal?: AbortSignal): Promise<NormalizedResponse> {
        this.validate(attempt.snapshot);
        const raw = await requestProviderResponse(attempt, context, { method: 'POST', url: attempt.snapshot.endpoint,
            headers: { 'Content-Type': 'application/json', ...bearerHeaders(context.credential) }, body: attempt.snapshot.body,
            timeoutMs: attemptTimeout(attempt) }, normalizeResponsesResponse, signal);
        const names = arrayObjects((JSON.parse(attempt.snapshot.body) as JsonObject).tools).map(tool => stringValue(tool.name) ?? '');
        return gateDeclaredTools(assembleResponse(attempt.attemptId, raw, normalizeResponsesResponse), names);
    }

    discover(profile: ProviderProfile, cursor: string | null, context: SendContext, signal?: AbortSignal): Promise<DiscoveryPage> {
        return new CompatibleChatAdapter().discover({ ...profile, baseUrl: profile.baseUrl.replace(/\/responses\/?$/, '') }, cursor, context, signal);
    }

    continueView(view: NativeSendView, response: NormalizedResponse, results: ToolResult[]): NativeSendView {
        if (view.protocol !== this.protocol || !response.complete || !response.canExecuteTools) throw new AgentFault('E_TOOL_COMMIT_REQUIRED', 'Responses工具续接需要完整有效响应');
        checkToolResults(response.toolCalls, results);
        const output = response.toolCalls.map(call => {
            const result = results.find(item => item.callId === call.callId)!;
            return { type: 'function_call_output', call_id: call.providerCallId!, output: result.nativeParts ?? (typeof result.result === 'string' ? result.result : JSON.stringify(result.result)) };
        });
        return immutableJson({ ...view, input: [...(view.input ?? []), ...response.replayMessages, ...output] });
    }

    async lookup(handle: ProviderLookupHandle, context: SendContext, signal?: AbortSignal): Promise<LookupResult> {
        const snapshot = handle.snapshot;
        if (!snapshot || snapshot.profile.remoteRetention !== 'allowed' || !handle.providerResponseId
            || JSON.parse(snapshot.body).store !== true) return { status: 'unsupported' };
        const endpoint = `${this.endpoint(snapshot.profile, snapshot.modelId)}/${encodeURIComponent(handle.providerResponseId)}`;
        const response = await context.transport.request({ method: 'GET', url: endpoint,
            headers: providerRequestHeaders(snapshot.profile, bearerHeaders(context.credential), { purpose: 'lookup', conversationId: snapshot.conversationId }), timeoutMs: 10_000 }, signal);
        if (response.status === 404) return { status: 'not_found', provesNotAccepted: false };
        const raw = decodeResponse(response, this.protocol);
        if (raw.json.id !== handle.providerResponseId) throw new AgentFault('E_RESPONSE_IDENTITY', '查回结果与原供应商响应身份不同');
        if (['queued', 'in_progress'].includes(String(raw.json.status))) return { status: 'pending' };
        const names = arrayObjects((JSON.parse(snapshot.body) as JsonObject).tools).map(tool => stringValue(tool.name) ?? '');
        return { status: 'found', response: gateDeclaredTools(assembleResponse(handle.attemptId, raw, normalizeResponsesResponse), names) };
    }
}
