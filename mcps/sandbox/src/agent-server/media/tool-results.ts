import { AgentFault } from '../protocol.js';
import type { JsonObject, JsonValue } from '../protocol.js';
import type { NativeSendView, ToolResult } from '../providers/types.js';
import type { InputAttachmentService } from './input-attachments.js';
import type { AttachmentModelSelection, InputAttachmentReference, ToolImageOwner } from './input-types.js';
import { inspectBase64, normalizeMime, validateMediaBytes } from './validation.js';

function object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function mcpPayload(result: ToolResult): { root: Record<string, unknown>; payload: Record<string, unknown>; wrapped: boolean } | undefined {
    const root = object(result.result);
    if (!root) return undefined;
    const nested = object(root.data);
    if (Array.isArray(nested?.content)) return { root, payload: nested, wrapped: true };
    return Array.isArray(root.content) ? { root, payload: root, wrapped: false } : undefined;
}

export function hasMcpToolImages(result: ToolResult): boolean {
    return ((mcpPayload(result)?.payload.content ?? []) as unknown[]).some(part => object(part)?.type === 'image');
}

export function hasMcpToolImageReferences(result: ToolResult): boolean {
    const references = mcpPayload(result)?.payload.toolImageReferences;
    return Array.isArray(references) && references.length > 0;
}

function imageFailure(result: ToolResult, error: AgentFault, references: InputAttachmentReference[], protocol: string): ToolResult {
    const { nativeParts: discardedParts, ...saved } = result;
    return { ...saved, result: { ok: false, error: { ...error.toJSON(), details: {
        ...error.details, protocol, field: 'nativeParts', references } } } as unknown as JsonValue, isError: true };
}

export async function convertMcpToolResult(input: {
    result: ToolResult;
    owner: ToolImageOwner;
    attachments: InputAttachmentService;
    selection?: AttachmentModelSelection;
    signal?: AbortSignal;
}): Promise<ToolResult> {
    const located = mcpPayload(input.result);
    if (!located || !hasMcpToolImages(input.result)) return input.result;
    if (!input.selection?.profile || !input.selection.entry) throw new AgentFault('E_TOOL_IMAGE_SELECTION_REQUIRED', '工具图片需要当前冻结模型的真实选择', { field: 'selection' });
    const content = located.payload.content as unknown[];
    const images = content.flatMap((value, blockIndex) => {
        const part = object(value);
        return part?.type === 'image' ? [{ part, blockIndex }] : [];
    });
    const limits = input.attachments.toolImageLimits();
    if (images.length > Math.min(limits.maxBlocks, input.attachments.limits.maxReferences)) {
        throw new AgentFault('MEDIA_CONTENT_LIMIT', '工具图片数量超过当前媒体或附件上限', { field: 'content.image' });
    }
    let bytes = 0;
    for (const { part, blockIndex } of images) {
        if (typeof part.data !== 'string' || typeof part.mimeType !== 'string') throw new AgentFault('E_TOOL_IMAGE_CONTENT', 'MCP图片缺少原始字节或MIME', { field: `content[${blockIndex}].data/mimeType` });
        const info = inspectBase64(part.data, Math.min(limits.maxBlockBytes, input.attachments.limits.maxSourceBytes));
        validateMediaBytes('image', normalizeMime(part.mimeType), info);
        bytes += info.byteLength;
        if (bytes > limits.maxResponseBytes) throw new AgentFault('MEDIA_CONTENT_LIMIT', '工具图片总字节超过当前媒体响应上限', { field: 'content.image' });
    }
    const references: InputAttachmentReference[] = [];
    const slots = new Map<number, InputAttachmentReference>();
    for (const { part, blockIndex } of images) {
        const reference = await input.attachments.prepareToolImage({ owner: input.owner, blockIndex,
            mime: part.mimeType as string, dataBase64: part.data as string }, input.signal);
        references.push(reference);
        slots.set(blockIndex, reference);
    }
    const sanitized = content.map((part, blockIndex) => {
        const reference = slots.get(blockIndex);
        return reference ? { type: 'resource_link', uri: reference.referenceId, name: reference.label, mimeType: reference.mediaType,
            size: reference.byteLength, _meta: { sha256: reference.sha256, conversationId: input.owner.conversationId,
                runId: input.owner.runId, actionId: input.owner.actionId, stepId: input.owner.stepId } } : part;
    });
    const payload = { ...located.payload, content: sanitized, toolImageReferences: references };
    const result = (located.wrapped ? { ...located.root, data: payload } : payload) as unknown as JsonValue;
    const { nativeParts: discardedParts, ...original } = input.result;
    const saved: ToolResult = { ...original, result, isError: input.result.isError || located.payload.isError === true };
    const protocol = input.selection.profile.protocol;
    try {
        if (!['gemini', 'openai_responses', 'anthropic', 'compatible_chat', 'progrok'].includes(protocol)) {
            throw new AgentFault('E_TOOL_IMAGE_PROTOCOL_UNSUPPORTED', '当前协议尚无已消费的工具图像结构', { protocol });
        }
        input.attachments.assertToolImageSelection(input.selection);
        return saved;
    } catch (error) {
        if (!(error instanceof AgentFault)) throw error;
        return imageFailure(saved, error, references, protocol);
    }
}

export async function renderMcpToolResults(input: {
    conversationId: string;
    view: NativeSendView;
    results: ToolResult[];
    attachments: InputAttachmentService;
    selection?: AttachmentModelSelection;
    signal?: AbortSignal;
}): Promise<ToolResult[]> {
    if (!input.results.some(hasMcpToolImageReferences)) return input.results;
    if (!input.selection?.profile || !input.selection.entry) throw new AgentFault('E_TOOL_IMAGE_SELECTION_REQUIRED', '工具图片重放需要当前冻结模型的真实选择', { field: 'selection' });
    const protocol = input.selection.profile.protocol;
    if (input.view.protocol !== protocol) throw new AgentFault('E_TOOL_IMAGE_PROTOCOL_UNSUPPORTED', '工具图片重放与当前发送视图协议不同', { protocol, field: 'view.protocol' });
    const renderingProtocol = protocol === 'progrok' ? 'compatible_chat' : protocol;
    let renderingView: NativeSendView = { ...input.view, protocol: renderingProtocol };
    const results: ToolResult[] = [];
    for (const result of input.results) {
        if (!hasMcpToolImageReferences(result)) { results.push(result); continue; }
        const references = mcpPayload(result)!.payload.toolImageReferences as InputAttachmentReference[];
        try {
            if (!['gemini', 'openai_responses', 'anthropic', 'compatible_chat', 'progrok'].includes(protocol)) {
                throw new AgentFault('E_TOOL_IMAGE_PROTOCOL_UNSUPPORTED', '当前协议尚无已消费的工具图像结构', { protocol });
            }
            if (references.length > input.attachments.limits.maxReferences) throw new AgentFault('MEDIA_CONTENT_LIMIT', '工具图片引用数量超过当前附件上限');
            for (const reference of references) {
                if (!reference.toolSource || reference.attachmentType !== 'image' || reference.toolSource.callId !== result.callId
                    || reference.toolSource.toolName !== result.name) throw new AgentFault('E_TOOL_IMAGE_OWNER_STALE', '工具图片引用与原工具调用身份不同', { field: 'toolImageReferences.toolSource' });
            }
            const view = await input.attachments.appendUser(input.conversationId, renderingView,
                { text: `工具 ${result.name} 的图片原件，原调用 ${result.callId}`, references } as unknown as JsonValue,
                input.selection, input.signal);
            const message = renderingProtocol === 'gemini' ? view.contents?.at(-1) : renderingProtocol === 'openai_responses' ? view.input?.at(-1) : view.messages?.at(-1);
            const item = object(message);
            const parts = renderingProtocol === 'gemini' ? item?.parts : item?.content;
            if (!Array.isArray(parts) || !parts.some(part => {
                const block = object(part);
                return Boolean(block?.inlineData || block?.image_url || block?.type === 'input_image' || block?.type === 'image');
            })) throw new AgentFault('E_TOOL_IMAGE_NATIVE_PARTS_REQUIRED', '当前协议的入图渲染没有生成可消费图像字段', { protocol });
            renderingView = view;
            results.push({ ...result, nativeParts: parts as JsonObject[] });
        } catch (error) {
            if (!(error instanceof AgentFault)) throw error;
            results.push(imageFailure(result, error, references, protocol));
        }
    }
    return results;
}
