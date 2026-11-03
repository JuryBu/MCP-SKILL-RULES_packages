import { AgentFault } from '../protocol.js';
import type { JsonObject, JsonValue } from '../protocol.js';
import { normalizeUsage } from '../accounting/usage.js';
import { arrayObjects, assembleResponse, checkToolResults, freezeOwned, gateDeclaredTools, immutableJson, mediaBlock, objectValue, parseArguments, requireRoute, stringValue, validateTools, verifySnapshot } from './assemble.js';
import { attemptTimeout, decodeResponse, endpointUrl } from './http.js';
import type { DiscoveryPage, NativeBlock, NativeSendView, NormalizedResponse, ProviderAdapter, ProviderAttempt, ProviderProfile, RawProviderResponse, RequestSnapshot, SendContext, StopKind, ToolCall, ToolResult } from './types.js';

const reserved = new Set(['model', 'contents', 'messages', 'input', 'tools', 'stream', 'systemInstruction', 'system_instruction', 'cachedContent', 'cached_content']);
const refusalReasons = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION']);

function geminiContentFields(view: NativeSendView): JsonObject {
    if (view.protocol !== 'gemini' || !view.contents?.length || view.messages || view.input || view.system !== undefined) {
        throw new AgentFault('E_PROTOCOL_MISMATCH', 'Gemini适配器需要完整的原生contents发送视图');
    }
    validateTools(view);
    const fields: JsonObject = { contents: view.contents };
    if (view.systemInstruction) fields.systemInstruction = view.systemInstruction;
    if (view.tools?.length) fields.tools = [{ functionDeclarations: view.tools.map(tool => ({ name: tool.name,
        parametersJsonSchema: tool.parameters, ...(tool.description !== undefined ? { description: tool.description } : {}) })) }];
    return fields;
}

export function encodeGeminiCountTokensRequest(view: NativeSendView, modelId: string, parameters?: JsonObject): JsonObject {
    const model = modelId.replace(/^models\//, '');
    if (!model || !/^[a-zA-Z0-9._-]+$/.test(model)) throw new AgentFault('E_MODEL_INVALID', 'Gemini模型ID格式无效');
    return { generateContentRequest: { model: `models/${model}`,
        ...(parameters === undefined ? geminiContentFields(view) : new GeminiAdapter().encodeForMeasurement(view, modelId, parameters)) } };
}

function normalizeGeminiResponse(attemptId: string, raw: RawProviderResponse): NormalizedResponse {
    const data = raw.json;
    const candidates = arrayObjects(data.candidates);
    const blocks: NativeBlock[] = [];
    const toolCalls: ToolCall[] = [];
    const replayMessages: JsonObject[] = [];
    const problems: string[] = [];
    const reasons: JsonValue[] = [];
    const blocked = stringValue(objectValue(data.promptFeedback)?.blockReason);
    let complete = candidates.length > 0 || Boolean(blocked);
    let stop: StopKind = blocked ? 'refused' : 'completed';
    const indices = new Set<number>();
    candidates.forEach((candidate, position) => {
        const candidateIndex = typeof candidate.index === 'number' ? candidate.index : position;
        if (!Number.isSafeInteger(candidateIndex) || candidateIndex < 0 || indices.has(candidateIndex)) problems.push('E_RESPONSE_SCHEMA');
        indices.add(candidateIndex);
        const reason = stringValue(candidate.finishReason ?? candidate.finish_reason);
        reasons.push(reason);
        if (!reason) complete = false;
        if (reason === 'MAX_TOKENS') stop = 'truncated';
        else if (reason && refusalReasons.has(reason)) stop = 'refused';
        else if (reason === 'CONTINUATION') stop = 'paused';
        else if (reason !== 'STOP') { stop = 'unknown'; problems.push('E_STOP_UNKNOWN'); }
        const content = objectValue(candidate.content);
        if (content) replayMessages.push(content);
        if (content && content.role !== 'model') problems.push('E_RESPONSE_SCHEMA');
        if (!content && reason === 'STOP') problems.push('E_RESPONSE_SCHEMA');
        const parts = content?.parts;
        if (parts !== undefined && !Array.isArray(parts)) problems.push('E_RESPONSE_SCHEMA');
        if (!Array.isArray(parts)) return;
        parts.forEach((value, index) => {
            const part = objectValue(value);
            const nativeRef = `candidates/${position}/content/parts/${index}`;
            if (!part) { problems.push('E_NATIVE_BLOCK_UNSUPPORTED'); return; }
            const signature = stringValue(part.thoughtSignature ?? part.thought_signature);
            if (typeof part.text === 'string') {
                blocks.push({ index, candidateIndex, type: 'text', text: part.text, nativeRef, native: part,
                    ...(signature ? { thoughtSignature: signature } : {}), ...(part.thought === true ? { thought: true } : {}) });
            } else if (objectValue(part.functionCall ?? part.function_call)) {
                const fn = objectValue(part.functionCall ?? part.function_call)!;
                const name = stringValue(fn.name);
                const args = parseArguments(fn.args ?? {});
                const providerCallId = stringValue(fn.id);
                if (!name || !args || reason !== 'STOP') { problems.push('E_TOOL_ARGUMENTS'); return; }
                toolCalls.push({ callId: providerCallId ?? `${attemptId}:${candidateIndex}:${index}`, providerCallId,
                    name, arguments: args, candidateIndex, index, nativeRef, native: part });
            } else if (objectValue(part.inlineData ?? part.inline_data)) {
                const inline = objectValue(part.inlineData ?? part.inline_data)!;
                const mime = stringValue(inline.mimeType ?? inline.mime_type);
                const dataBase64 = stringValue(inline.data);
                if (!mime || dataBase64 === null) { problems.push('E_MEDIA_INVALID'); return; }
                blocks.push(mediaBlock(part, { index, candidateIndex, nativeRef, mime, dataBase64 }));
            } else if (objectValue(part.fileData ?? part.file_data)) {
                const file = objectValue(part.fileData ?? part.file_data)!;
                const mime = stringValue(file.mimeType ?? file.mime_type);
                const uri = stringValue(file.fileUri ?? file.file_uri);
                if (!mime || !uri) { problems.push('E_MEDIA_INVALID'); return; }
                blocks.push(mediaBlock(part, { index, candidateIndex, nativeRef, mime, uri }));
            } else {
                blocks.push({ index, candidateIndex, type: 'native_unknown', nativeRef, native: part });
                problems.push('E_NATIVE_BLOCK_UNSUPPORTED');
            }
        });
    });
    if (Array.isArray(data.candidates) && candidates.length !== data.candidates.length) problems.push('E_RESPONSE_SCHEMA');
    if (new Set(toolCalls.map(call => call.callId)).size !== toolCalls.length) problems.push('E_TOOL_PAIRING');
    if (toolCalls.length && candidates.length !== 1) problems.push('E_MULTIPLE_TOOL_CANDIDATES');
    if (!complete) { stop = 'unknown'; problems.push('E_RESPONSE_INCOMPLETE'); }
    if (problems.length && !['truncated', 'refused'].includes(stop)) stop = 'unknown';
    if (complete && !problems.length && stop === 'completed' && toolCalls.length) stop = 'tool_calls';
    if (complete && !blocks.length && !toolCalls.length && stop === 'completed') { stop = 'unknown'; problems.push('E_RESPONSE_EMPTY'); }
    return freezeOwned({ attemptId, providerRequestId: raw.headers['x-request-id'] ?? raw.headers['x-goog-request-id'] ?? null,
        providerResponseId: stringValue(data.responseId), modelId: stringValue(data.modelVersion), routeId: null,
        blocks, toolCalls, stop: { kind: stop, native: blocked ?? reasons }, usage: normalizeUsage('gemini', data.usageMetadata),
        raw, complete, canExecuteTools: complete && !problems.length && stop === 'tool_calls', replayMessages, problems });
}

export class GeminiAdapter implements ProviderAdapter {
    readonly protocol = 'gemini' as const;
    readonly version = 'gemini-generate-content-v3-thinking-level';

    endpoint(profile: ProviderProfile, modelId: string): string {
        const model = modelId.replace(/^models\//, '');
        if (!model || !/^[a-zA-Z0-9._-]+$/.test(model)) throw new AgentFault('E_MODEL_INVALID', 'Gemini模型ID格式无效');
        const suffix = `/models/${encodeURIComponent(model)}:generateContent`;
        const url = endpointUrl(profile.baseUrl, '');
        if (/:generateContent$/.test(url)) {
            if (!url.endsWith(suffix)) throw new AgentFault('E_MODEL_CONFLICT', '固定Gemini端点与选定模型不同');
            return url;
        }
        return endpointUrl(profile.baseUrl, suffix);
    }

    encode(view: NativeSendView, modelId: string, parameters: JsonObject): JsonObject {
        return this.encodeRequest(view, modelId, parameters, false);
    }

    encodeForMeasurement(view: NativeSendView, modelId: string, parameters: JsonObject): JsonObject {
        return this.encodeRequest(view, modelId, parameters, true);
    }

    private encodeRequest(view: NativeSendView, modelId: string, parameters: JsonObject, completedTailForMeasurement: boolean): JsonObject {
        const contentFields = geminiContentFields(view);
        for (const key of Object.keys(parameters)) if (reserved.has(key)) throw new AgentFault('E_PARAMETER_CONFLICT', `参数${key}由核心固定`);
        let generation = objectValue(parameters.generationConfig);
        if (modelId.replace(/^models\//, '') === 'gemini-3.8-flash') {
            if (!generation || ['temperature', 'topP', 'top_p', 'topK', 'top_k', 'candidateCount', 'candidate_count'].some(key => Object.hasOwn(generation!, key))) {
                throw new AgentFault('E_PARAMETER_UNSUPPORTED', 'Gemini 3.8需要thinkingLevel，且不接受旧采样参数或candidateCount');
            }
            const thinking = objectValue(generation.thinkingConfig);
            const level = stringValue(thinking?.thinkingLevel)?.toUpperCase();
            if (!thinking || Object.hasOwn(thinking, 'thinkingBudget') || Object.hasOwn(thinking, 'thinking_budget')
                || !level || !['LOW', 'MEDIUM', 'HIGH'].includes(level)) {
                throw new AgentFault('E_PARAMETER_UNSUPPORTED', 'Gemini 3.8 thinkingLevel只接受low、medium或high，不能使用thinkingBudget或minimal');
            }
            if (!completedTailForMeasurement && view.contents?.at(-1)?.role === 'model') throw new AgentFault('E_PARAMETER_UNSUPPORTED', 'Gemini 3.8不接受预填model轮次');
            generation = { ...generation, thinkingConfig: { ...thinking, thinkingLevel: level } };
        }
        if (generation?.candidateCount !== undefined && generation.candidateCount !== 1) {
            throw new AgentFault('E_PARAMETER_UNSUPPORTED', '工具执行首版仅支持一个响应候选');
        }
        const body: JsonObject = { ...parameters, ...contentFields };
        if (generation) body.generationConfig = generation;
        return body;
    }

    validate(snapshot: RequestSnapshot): void {
        verifySnapshot(snapshot, this);
        requireRoute(snapshot);
        if (snapshot.profile.routePolicy.kind !== 'direct') throw new AgentFault('E_ROUTE_UNVERIFIED', 'Gemini首版只接明确的原生端点');
        const body = JSON.parse(snapshot.body) as JsonObject;
        if (!Array.isArray(body.contents) || !body.contents.length || body.stream !== undefined || body.cachedContent !== undefined) {
            throw new AgentFault('E_REQUEST_SCHEMA', '冻结的Gemini请求不完整或启用了尚未计价的显式缓存');
        }
    }

    async send(attempt: ProviderAttempt, context: SendContext, signal?: AbortSignal): Promise<NormalizedResponse> {
        this.validate(attempt.snapshot);
        if (context.credential !== undefined && (!context.credential || /[\r\n]/.test(context.credential))) {
            throw new AgentFault('E_AUTH', '凭据内容无效');
        }
        const raw = decodeResponse(await context.transport.request({ method: 'POST', url: attempt.snapshot.endpoint,
            headers: { 'Content-Type': 'application/json', ...(context.credential ? { 'x-goog-api-key': context.credential } : {}) },
            body: attempt.snapshot.body, timeoutMs: attemptTimeout(attempt) }, signal));
        const definitions = arrayObjects((JSON.parse(attempt.snapshot.body) as JsonObject).tools)
            .flatMap(tool => arrayObjects(tool.functionDeclarations));
        const normalized = gateDeclaredTools(assembleResponse(attempt.attemptId, raw, normalizeGeminiResponse), definitions.map(tool => stringValue(tool.name) ?? ''));
        if (attempt.snapshot.modelId.replace(/^models\//, '') === 'gemini-3.8-flash' && normalized.toolCalls.some(call => !call.providerCallId)) {
            return freezeOwned({ ...normalized, canExecuteTools: false, stop: { ...normalized.stop, kind: 'unknown' as const }, problems: [...normalized.problems, 'E_TOOL_PAIRING'] });
        }
        return normalized;
    }

    async discover(profile: ProviderProfile, cursor: string | null, context: SendContext, signal?: AbortSignal): Promise<DiscoveryPage> {
        const base = profile.baseUrl.replace(/\/models\/[^/]+:generateContent\/?$/, '');
        const url = new URL(endpointUrl(base, '/models'));
        url.searchParams.set('pageSize', String(profile.discovery.pageSize));
        if (cursor) url.searchParams.set('pageToken', cursor);
        const raw = decodeResponse(await context.transport.request({ method: 'GET', url: url.href,
            headers: context.credential ? { 'x-goog-api-key': context.credential } : {}, timeoutMs: 10_000, maxResponseBytes: 4 * 1024 * 1024 }, signal));
        if (!Array.isArray(raw.json.models) || raw.json.models.some(model => !objectValue(model))) {
            throw new AgentFault('E_CATALOG_INCOMPLETE', 'Gemini目录页缺少完整models数组');
        }
        const nextCursor = stringValue(raw.json.nextPageToken);
        return { models: raw.json.models as JsonObject[], nextCursor, complete: !nextCursor };
    }

    continueView(view: NativeSendView, response: NormalizedResponse, results: ToolResult[]): NativeSendView {
        if (view.protocol !== this.protocol || !response.canExecuteTools || !response.complete) {
            throw new AgentFault('E_TOOL_COMMIT_REQUIRED', '只有完整有效并经核心提交的工具响应可继续');
        }
        checkToolResults(response.toolCalls, results);
        const parts = response.toolCalls.map(call => {
            const result = results.find(entry => entry.callId === call.callId)!;
            const payload = objectValue(result.result) ?? { result: result.result };
            return { functionResponse: { name: call.name, ...(call.providerCallId ? { id: call.providerCallId } : {}),
                response: result.isError ? { error: payload } : payload,
                ...(result.nativeParts ? { parts: result.nativeParts } : {}) } };
        });
        return immutableJson({ ...view, contents: [...(view.contents ?? []), ...response.replayMessages, { role: 'user', parts }] });
    }

    async lookup(): Promise<{ status: 'unsupported' }> { return { status: 'unsupported' }; }
}

export { normalizeGeminiResponse };
