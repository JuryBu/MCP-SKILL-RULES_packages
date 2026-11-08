import { canonicalJson } from '../protocol.js';
import { createHash } from 'node:crypto';
import { canonicalJsonByteChunks, MediaPayloadCodec } from '../media/payload-codec.js';
import { MemoryBinaryPayloads } from '../media/memory-payloads.js';
import { inspectBase64, normalizeMime, validateMediaBytes } from '../media/validation.js';
import type { JsonObject, JsonValue } from '../protocol.js';
import type { HistoryItem } from '../storage/port.js';
import type { ContextHistoryPort, ContextSourcePort, SourceBlock, SourceRead } from './contracts.js';
import { hashBytes } from './config.js';
import { checkAbort, ContextFault } from './errors.js';

interface ProjectedBlock { blockId: string; kind: 'text' | 'nativeAnchor'; bytes: Buffer; mediaType?: string; retrieval: JsonObject }

const objectValue = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

export const MAX_MEDIA_HISTORY_SOURCE_BYTES = 256 * 1024 * 1024;
export const MAX_ORDINARY_HISTORY_BYTES = 32 * 1024 * 1024;

function historyDigest(value: unknown, maxBytes = MAX_MEDIA_HISTORY_SOURCE_BYTES): { bytes: number; hash: string } {
    const checksum = createHash('sha256');
    let bytes = 0;
    for (const chunk of canonicalJsonByteChunks(value, { maxBytes })) { bytes += chunk.length; checksum.update(chunk); }
    return { bytes, hash: checksum.digest('hex') };
}

export function historyMatchesReference(item: HistoryItem, value: JsonValue): boolean {
    try {
        const actual = historyDigest(value, Math.min(item.objectRef.rawBytes, MAX_MEDIA_HISTORY_SOURCE_BYTES));
        return actual.bytes === item.objectRef.rawBytes && actual.hash === item.objectRef.hash;
    } catch { return false; }
}

export function hasInlineHistoryMedia(value: JsonValue): boolean {
    const root = objectValue(value), response = objectValue(root?.response);
    return root?.kind === 'model' && Array.isArray(response?.blocks) && response.blocks.some(entry => {
        const block = objectValue(entry);
        return block && ['image', 'audio', 'video', 'file'].includes(String(block.type)) && typeof block.dataBase64 === 'string';
    });
}

export function validateMediaHistoryExpansion(value: JsonValue): void {
    if (!hasInlineHistoryMedia(value)) throw new ContextFault('INPUT_BUDGET', '仅合法内联媒体历史可使用额外恢复预算');
    const binary = new MemoryBinaryPayloads(MAX_ORDINARY_HISTORY_BYTES);
    try {
        const response = objectValue(objectValue(value)!.response)!;
        for (const entry of response.blocks as JsonValue[]) {
            const block = objectValue(entry);
            if (!block || typeof block.dataBase64 !== 'string' || !['image', 'audio', 'video', 'file'].includes(String(block.type))) continue;
            const info = inspectBase64(block.dataBase64, MAX_ORDINARY_HISTORY_BYTES);
            validateMediaBytes(block.type as 'image' | 'audio' | 'video' | 'file', normalizeMime(block.mime), info);
        }
        const codec = new MediaPayloadCodec(binary, { maxSourceBytes: MAX_MEDIA_HISTORY_SOURCE_BYTES,
            maxMetadataBytes: MAX_ORDINARY_HISTORY_BYTES, maxTotalPayloadBytes: MAX_ORDINARY_HISTORY_BYTES });
        if (!codec.encode(value)) throw new ContextFault('INPUT_BUDGET', '媒体历史没有可验证的有界原件');
    } catch (error) {
        if (error instanceof ContextFault) throw error;
        throw new ContextFault('INPUT_BUDGET', '媒体历史超过原件或元数据恢复预算',
            { cause: error instanceof Error ? error.message : String(error) });
    } finally { binary.close(); }
}

export function nativeHistoryMaterialBytes(value: JsonValue, maxBytes: number): number {
    const root = objectValue(value), response = objectValue(root?.response);
    const material = root?.kind === 'model' && Array.isArray(response?.replayMessages) ? response.replayMessages : value;
    try { return historyDigest(material, maxBytes).bytes; }
    catch { throw new ContextFault('INPUT_BUDGET', '实际原生重放材料超过发送视图预算', { maxViewBytes: maxBytes }); }
}

export function projectHistoryContent(item: HistoryItem, value: JsonValue): ProjectedBlock[] {
    const blocks: ProjectedBlock[] = [];
    const add = (blockId: string, content: string, kind: 'text' | 'nativeAnchor' = 'text', mediaType?: string, nativeType?: string) => {
        blocks.push({ blockId, kind, bytes: Buffer.from(content, 'utf8'), ...(mediaType ? { mediaType } : {}),
            retrieval: { contentId: item.contentId, itemId: item.itemId, blockId, ...(nativeType ? { nativeType } : {}) } });
    };
    const root = objectValue(value);
    if (typeof value === 'string') add('text', value);
    else if (root?.kind === 'model' && objectValue(root.response)) {
        const response = root.response as Record<string, unknown>;
        if (Array.isArray(response.blocks)) response.blocks.forEach((part, index) => {
            const block = objectValue(part);
            if (!block) throw new ContextFault('SOURCE_GAP', '原生响应块格式无效', { itemId: item.itemId, index });
            if (typeof block.text === 'string' && block.thought !== true) add(`response.blocks.${index}.text`, block.text);
            else add(`response.blocks.${index}.native`, canonicalJson({ type: block.type ?? 'native_unknown', nativeRef: block.nativeRef ?? null,
                sha256: block.sha256 ?? null, mime: block.mime ?? null, byteLength: block.byteLength ?? null }), 'nativeAnchor',
            typeof block.mime === 'string' ? block.mime : undefined, typeof block.type === 'string' ? block.type : 'native_unknown');
        });
        if (Array.isArray(response.toolCalls)) response.toolCalls.forEach((call, index) => add(`response.toolCalls.${index}`, canonicalJson(call)));
        add('response.raw', canonicalJson({ contentId: item.contentId, protocol: root.protocol ?? item.providerProtocol ?? null,
            complete: response.complete ?? false, rawHash: historyDigest(response.raw ?? null).hash }), 'nativeAnchor');
    } else if (root?.kind === 'tool') add('result', canonicalJson(root.result ?? null));
    else if (root && typeof root.text === 'string') {
        add('text', root.text);
        for (const [key, content] of Object.entries(root)) {
            if (key !== 'text') add(`metadata.${key}`, canonicalJson(content), 'nativeAnchor');
        }
    } else add('value', canonicalJson(value));
    return blocks;
}

export function createHistorySourcePort(history: Pick<ContextHistoryPort, 'readContent'>, options: {
    conversationId: string;
    maxReadBytes?: number;
    largeContent?: ContextSourcePort;
}): ContextSourcePort {
    const maxReadBytes = options.maxReadBytes ?? 256 * 1024;
    if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 4 || maxReadBytes > 256 * 1024) {
        throw new ContextFault('CONFIG_INVALID', '原文对象读取帧须为4至262144字节');
    }
    const content = async (item: HistoryItem): Promise<ProjectedBlock[]> => {
        if (item.objectRef.rawBytes > maxReadBytes) throw new ContextFault('SOURCE_GAP', '大正文需要有界来源读取端口',
            { itemId: item.itemId, bytes: item.objectRef.rawBytes, maxReadBytes, requiredPort: 'ContextSourcePort' });
        const value = item.value ?? await history.readContent(options.conversationId, item.contentId);
        if (value === undefined) throw new ContextFault('SOURCE_GAP', '来源正文已经缺失', { itemId: item.itemId });
        const bytes = Buffer.from(canonicalJson(value), 'utf8');
        if (bytes.length !== item.objectRef.rawBytes || bytes.length > maxReadBytes || hashBytes(bytes) !== item.objectRef.hash) {
            throw new ContextFault('HISTORY_STALE', '原文对象与不可变引用的长度或哈希不一致', { itemId: item.itemId });
        }
        return projectHistoryContent(item, value);
    };
    return {
        async describe(item, signal) {
            checkAbort(signal);
            if (item.objectRef.rawBytes > maxReadBytes && options.largeContent) return (await options.largeContent.describe(item, signal)).map(block => ({
                ...block, retrieval: { ...block.retrieval, rawObjectHash: item.objectRef.hash, rawObjectBytes: item.objectRef.rawBytes } }));
            return (await content(item)).map(block => ({ itemId: item.itemId, blockId: block.blockId, contentId: item.contentId,
                seq: item.seq, roundId: item.roundId!, kind: block.kind, byteLength: block.bytes.length,
                sha256: hashBytes(block.bytes), retrieval: { ...block.retrieval, rawObjectHash: item.objectRef.hash, rawObjectBytes: item.objectRef.rawBytes },
                ...(block.mediaType ? { mediaType: block.mediaType } : {}) }));
        },
        async read(request) {
            checkAbort(request.signal);
            validateSourceRead(request, maxReadBytes);
            const rawObjectHash = request.block.retrieval.rawObjectHash;
            const rawObjectBytes = request.block.retrieval.rawObjectBytes;
            if (typeof rawObjectHash !== 'string' || typeof rawObjectBytes !== 'number' || !Number.isSafeInteger(rawObjectBytes) || rawObjectBytes < 0) {
                throw new ContextFault('SOURCE_GAP', '来源块缺少原文对象的不可变引用', { itemId: request.block.itemId });
            }
            const item: HistoryItem = { itemId: request.block.itemId, contentId: request.block.contentId, seq: request.block.seq,
                kind: 'source', role: 'system', view: 'raw', effective: true, roundId: request.block.roundId,
                stepId: null, runId: null, runEpoch: null, objectRef: { hash: rawObjectHash, rawBytes: rawObjectBytes } };
            if (item.objectRef.rawBytes > maxReadBytes && options.largeContent) return options.largeContent.read(request);
            const block = (await content(item)).find(entry => entry.blockId === request.block.blockId);
            if (!block || hashBytes(block.bytes) !== request.block.sha256 || block.bytes.length !== request.block.byteLength) {
                throw new ContextFault('HISTORY_STALE', '来源块已经改变', { itemId: item.itemId, blockId: request.block.blockId });
            }
            return block.bytes.subarray(request.startByte, request.endByte);
        },
    };
}

export function validateSourceRead(request: SourceRead, maxReadBytes = 256 * 1024): void {
    if (!Number.isSafeInteger(request.startByte) || !Number.isSafeInteger(request.endByte) || request.startByte < 0
        || request.endByte < request.startByte || request.endByte > request.block.byteLength
        || request.endByte - request.startByte > request.maxBytes || request.maxBytes > maxReadBytes || request.maxBytes < 1) {
        throw new ContextFault('SOURCE_GAP', '来源读取范围超过有界帧或原文范围', { itemId: request.block.itemId, blockId: request.block.blockId });
    }
}

export async function readSourceFrame(port: ContextSourcePort, request: SourceRead): Promise<Buffer> {
    checkAbort(request.signal);
    validateSourceRead(request);
    const bytes = Buffer.from(await port.read(request));
    checkAbort(request.signal);
    if (bytes.length !== request.endByte - request.startByte) throw new ContextFault('SOURCE_GAP', '来源读取帧长度与请求不一致',
        { itemId: request.block.itemId, blockId: request.block.blockId, startByte: request.startByte, endByte: request.endByte });
    return bytes;
}

export function utf8Boundary(bytes: Buffer, maximum: number): number {
    let endByte = Math.min(maximum, bytes.length);
    while (endByte > 0 && endByte < bytes.length && (bytes[endByte] & 0xc0) === 0x80) endByte--;
    return endByte;
}
