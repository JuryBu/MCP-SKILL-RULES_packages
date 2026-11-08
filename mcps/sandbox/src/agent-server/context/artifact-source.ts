import type { JsonValue } from '../protocol.js';
import type { HistoryItem, StorePort } from '../storage/port.js';
import type { ContextSourcePort, SourceBlock } from './contracts.js';
import { hashBytes } from './config.js';
import { checkAbort, ContextFault } from './errors.js';
import { createHistorySourcePort, historyMatchesReference, MAX_MEDIA_HISTORY_SOURCE_BYTES, projectHistoryContent,
    validateMediaHistoryExpansion, validateSourceRead } from './sources.js';

export function contextArtifactFrameBytes(requested = 262144): number {
    if (!Number.isSafeInteger(requested) || requested < 1) throw new ContextFault('CONFIG_INVALID', 'Context原件分片上限须为正安全整数');
    return Math.min(requested, 262144);
}

type HistoryProjection = ReturnType<typeof projectHistoryContent>;

export class ArtifactProjectionCache {
    private readonly entries = new Map<string, { conversationId: string; hash: string; bytes: number; projection: HistoryProjection }>();
    private bytes = 0;

    constructor(readonly maximumBytes = 32 * 1024 * 1024) {
        if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new ContextFault('CONFIG_INVALID', '原文投影缓存上限须为正安全整数');
    }

    private key(conversationId: string, contentId: string): string { return JSON.stringify([conversationId, contentId]); }

    private remove(key: string): void {
        const previous = this.entries.get(key);
        if (previous) { this.bytes -= previous.bytes; this.entries.delete(key); }
    }

    get(conversationId: string, contentId: string, hash: string): HistoryProjection | undefined {
        const key = this.key(conversationId, contentId);
        const previous = this.entries.get(key);
        if (!previous) return undefined;
        if (previous.hash !== hash) { this.remove(key); return undefined; }
        this.entries.delete(key);
        this.entries.set(key, previous);
        return previous.projection;
    }

    set(conversationId: string, contentId: string, hash: string, projection: HistoryProjection): void {
        const bytes = projection.reduce((total, block) => total + block.bytes.length, 0);
        if (bytes > this.maximumBytes) throw new ContextFault('INPUT_BUDGET', '单个原生正文投影超过明确缓存预算', { maximumBytes: this.maximumBytes });
        const key = this.key(conversationId, contentId);
        this.remove(key);
        while (this.bytes + bytes > this.maximumBytes && this.entries.size) this.remove(this.entries.keys().next().value!);
        this.entries.set(key, { conversationId, hash, bytes, projection });
        this.bytes += bytes;
    }

    delete(conversationId: string, contentId: string): void { this.remove(this.key(conversationId, contentId)); }

    releaseConversation(conversationId: string): void {
        for (const [key, entry] of this.entries) if (entry.conversationId === conversationId) this.remove(key);
    }

    snapshot(): { bytes: number; entries: number; maximumBytes: number } {
        return { bytes: this.bytes, entries: this.entries.size, maximumBytes: this.maximumBytes };
    }
}

export async function readHistoryArtifact(store: Pick<StorePort, 'readArtifact'> & {
    readContextMediaContent?: (conversationId: string, contentId: string) => Promise<JsonValue | undefined>;
}, input: {
    conversationId: string; item: HistoryItem; maxBytes?: number; maxReadBytes?: number; signal?: AbortSignal; mediaExpansion?: boolean;
}): Promise<JsonValue> {
    const maximum = input.maxBytes ?? 32 * 1024 * 1024;
    const frameMaximum = contextArtifactFrameBytes(input.maxReadBytes);
    if (Number.isSafeInteger(maximum) && maximum >= 1 && input.item.objectRef.rawBytes > maximum && input.mediaExpansion
        && input.item.kind === 'model_step' && input.item.objectRef.rawBytes <= MAX_MEDIA_HISTORY_SOURCE_BYTES) {
        checkAbort(input.signal);
        if (!store.readContextMediaContent) throw new ContextFault('SOURCE_GAP', '大媒体历史需要专用有界原件读取端口',
            { itemId: input.item.itemId, requiredPort: 'readContextMediaContent' });
        const value = await store.readContextMediaContent(input.conversationId, input.item.contentId);
        checkAbort(input.signal);
        if (value === undefined || !historyMatchesReference(input.item, value)) {
            throw new ContextFault('HISTORY_STALE', '大媒体原件与历史引用的长度或哈希不一致', { itemId: input.item.itemId });
        }
        validateMediaHistoryExpansion(value);
        return value;
    }
    if (!Number.isSafeInteger(maximum) || maximum < 1 || input.item.objectRef.rawBytes > maximum) {
        throw new ContextFault('INPUT_BUDGET', '原生正文超过明确材料预算或读取帧上限', { itemId: input.item.itemId, maximum });
    }
    const chunks: Buffer[] = [];
    let offset = 0;
    do {
        checkAbort(input.signal);
        const requestMaximum = Math.min(frameMaximum, Math.max(1, input.item.objectRef.rawBytes - offset));
        const part = await store.readArtifact({ conversationId: input.conversationId, artifactId: input.item.contentId, offset, maxBytes: requestMaximum });
        if (part.artifactId !== input.item.contentId || part.offset !== offset || part.totalBytes !== input.item.objectRef.rawBytes
            || part.mime !== 'application/json' || part.sha256 !== input.item.objectRef.hash || part.dataBase64.length > Math.ceil(requestMaximum / 3) * 4 + 4) {
            throw new ContextFault('HISTORY_STALE', '原生正文分片的身份、范围或哈希与历史引用不同', { itemId: input.item.itemId, offset });
        }
        const bytes = Buffer.from(part.dataBase64, 'base64');
        if (bytes.length > requestMaximum || (!bytes.length && offset < part.totalBytes) || offset + bytes.length > maximum) {
            throw new ContextFault('SOURCE_GAP', '原生正文分片没有按有界范围推进', { itemId: input.item.itemId, offset });
        }
        chunks.push(bytes);
        offset += bytes.length;
        if (part.complete) {
            if (offset !== part.totalBytes || part.nextOffset !== null) throw new ContextFault('SOURCE_GAP', '原生正文结束标记与完整范围不同');
            break;
        }
        if (part.nextOffset !== offset) throw new ContextFault('SOURCE_GAP', '原生正文分片游标不连续');
        if (offset >= part.totalBytes) throw new ContextFault('SOURCE_GAP', '原生正文缺少完整结束标记');
    } while (offset < input.item.objectRef.rawBytes);
    const bytes = Buffer.concat(chunks, offset);
    if (bytes.length !== input.item.objectRef.rawBytes || hashBytes(bytes) !== input.item.objectRef.hash) {
        throw new ContextFault('HISTORY_STALE', '原生正文完整字节校验失败', { itemId: input.item.itemId });
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as JsonValue; }
    catch { throw new ContextFault('SOURCE_GAP', '原生正文不是完整UTF-8 JSON对象', { itemId: input.item.itemId }); }
}

export function createArtifactHistorySourcePort(store: Pick<StorePort, 'readContent' | 'readArtifact'>, input: {
    conversationId: string; maxBytes?: number; maxReadBytes?: number; maxCacheBytes?: number; cache?: ArtifactProjectionCache; preferProjection?: boolean;
}): ContextSourcePort {
    const maxReadBytes = contextArtifactFrameBytes(input.maxReadBytes);
    const cache = input.cache ?? new ArtifactProjectionCache(input.maxCacheBytes);
    const blockHashes = new WeakMap<Buffer, string>();
    const blockHash = (bytes: Buffer): string => {
        let hash = blockHashes.get(bytes);
        if (!hash) { hash = hashBytes(bytes); blockHashes.set(bytes, hash); }
        return hash;
    };
    const load = async (item: HistoryItem, signal?: AbortSignal): Promise<HistoryProjection> => {
        checkAbort(signal);
        const existing = cache.get(input.conversationId, item.contentId, item.objectRef.hash);
        if (existing) return existing;
        const value = await readHistoryArtifact(store, { ...input, item, maxReadBytes, signal, mediaExpansion: true });
        const projection = projectHistoryContent(item, value);
        cache.set(input.conversationId, item.contentId, item.objectRef.hash, projection);
        return projection;
    };
    const large: ContextSourcePort = {
        async describe(item, signal) {
            return (await load(item, signal)).map(block => ({ itemId: item.itemId, blockId: block.blockId, contentId: item.contentId, seq: item.seq,
                roundId: item.roundId!, kind: block.kind, byteLength: block.bytes.length, sha256: blockHash(block.bytes),
                retrieval: { ...block.retrieval, historyKind: item.kind }, ...(block.mediaType ? { mediaType: block.mediaType } : {}) }));
        },
        async read(request) {
            validateSourceRead(request, maxReadBytes);
            const hash = request.block.retrieval.rawObjectHash;
            const size = request.block.retrieval.rawObjectBytes;
            if (typeof hash !== 'string' || typeof size !== 'number') throw new ContextFault('SOURCE_GAP', '大正文缺少不可变原文引用');
            const item: HistoryItem = { itemId: request.block.itemId, contentId: request.block.contentId, seq: request.block.seq,
                roundId: request.block.roundId, role: 'system', kind: request.block.retrieval.historyKind === 'model_step' ? 'model_step' : 'source',
                view: 'raw', effective: true, runId: null, runEpoch: null, stepId: null,
                objectRef: { hash, rawBytes: size } };
            const block = (await load(item, request.signal)).find(entry => entry.blockId === request.block.blockId);
            if (!block || block.bytes.length !== request.block.byteLength || blockHash(block.bytes) !== request.block.sha256) {
                throw new ContextFault('HISTORY_STALE', '大正文投影与冻结来源块不同');
            }
            return block.bytes.subarray(request.startByte, request.endByte);
        },
    };
    const source = createHistorySourcePort(store, { conversationId: input.conversationId, maxReadBytes, largeContent: large });
    return { ...(input.preferProjection ? { describe: async (item: HistoryItem, signal?: AbortSignal) => (await large.describe(item, signal)).map(block => ({
        ...block, retrieval: { ...block.retrieval, rawObjectHash: item.objectRef.hash, rawObjectBytes: item.objectRef.rawBytes } })), read: large.read } : source),
    releaseCached(blocks: readonly SourceBlock[]) { for (const block of blocks) cache.delete(input.conversationId, block.contentId); } };
}
