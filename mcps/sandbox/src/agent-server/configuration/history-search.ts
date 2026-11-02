import { AgentFault, canonicalJson } from '../protocol.js';
import type { StorePort, HistoryItem } from '../storage/port.js';
import { configurationHash } from '../storage/configuration-extra.js';

interface SearchCursor {
    version: 1;
    fingerprint: string;
    historyCursor?: string;
    historyEpoch?: number;
    throughSeq?: number;
    itemSeq?: number;
    byteOffset: number;
}

export async function searchConfigurationHistory(store: Pick<StorePort, 'readHistory' | 'readArtifact'>, params: {
    conversationId: string; query: string; scope?: 'input' | 'conversation'; cursor?: string; limit?: number; maxBytes?: number;
}) {
    const scope = params.scope ?? 'conversation';
    const limit = params.limit ?? 20;
    const budget = params.maxBytes ?? 128 * 1024;
    if (!params.query || params.query.length > 512 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
        || !Number.isSafeInteger(budget) || budget < 4096 || budget > 1024 * 1024 || !['input', 'conversation'].includes(scope)) {
        throw new AgentFault('INVALID_PARAMS', '历史搜索需要非空字面查询、1至100个命中及4KiB至1MiB扫描预算');
    }
    const fingerprint = configurationHash({ conversationId: params.conversationId, query: params.query, scope, sourceHost: 'agent-server' });
    let position: SearchCursor = { version: 1, fingerprint, byteOffset: 0 };
    if (params.cursor) {
        try {
            const saved = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')) as SearchCursor;
            if (saved.version !== 1 || saved.fingerprint !== fingerprint || !Number.isSafeInteger(saved.byteOffset) || saved.byteOffset < 0
                || saved.historyCursor !== undefined && typeof saved.historyCursor !== 'string'
                || saved.historyEpoch !== undefined && (!Number.isSafeInteger(saved.historyEpoch) || saved.historyEpoch < 0)
                || saved.throughSeq !== undefined && (!Number.isSafeInteger(saved.throughSeq) || saved.throughSeq < 0)
                || saved.itemSeq !== undefined && (!Number.isSafeInteger(saved.itemSeq) || saved.itemSeq < 1)) throw new Error();
            position = saved;
        } catch { throw new AgentFault('STORAGE_CURSOR_STALE', '搜索游标与当前会话、查询或范围不一致'); }
    }
    const needle = Buffer.from(JSON.stringify(params.query).slice(1, -1));
    const hits: Record<string, unknown>[] = [];
    let scannedBytes = 0;
    let metadataBytes = 0;
    let scannedItems = 0;
    let resultBytes = 0;
    let exhausted = false;
    const maxResultBytes = Math.min(64 * 1024, budget);
    const finish = () => ({ query: params.query, scope, sourceHost: 'agent-server', representation: 'canonical_json_literal',
        items: hits, hasMore: !exhausted, nextCursor: exhausted ? null : Buffer.from(JSON.stringify(position)).toString('base64url'),
        scannedBytes, scannedItems, metadataBytes, scanBudgetBytes: budget, historyEpoch: position.historyEpoch, throughSeq: position.throughSeq });
    const hit = (item: HistoryItem, bytes: Buffer, index: number, absoluteOffset: number) => ({
        sourceHost: 'agent-server', conversationId: params.conversationId, historyEpoch: position.historyEpoch,
        roundId: item.roundId, runId: item.runId, role: item.role, seq: item.seq, itemId: item.itemId,
        contentId: item.contentId, artifactId: item.contentId, sha256: item.objectRef.hash,
        byteOffset: absoluteOffset, byteLength: needle.length,
        snippet: bytes.subarray(Math.max(0, index - 80), Math.min(bytes.length, index + Math.min(needle.length, 256) + 160)).toString('utf8'),
        originalRef: { method: 'conversations.readArtifact', params: { conversationId: params.conversationId, artifactId: item.contentId,
            offset: Math.max(0, absoluteOffset - 80), maxBytes: Math.min(512 * 1024, needle.length + 240) } },
    });
    while (scannedItems < 64 && scannedBytes < budget) {
        const page = await store.readHistory({ conversationId: params.conversationId, cursor: position.historyCursor, limit: 1, maxBytes: 4096,
            view: 'raw', effectiveOnly: false, expectedHistoryEpoch: position.historyEpoch, throughSeq: position.throughSeq });
        position.historyEpoch = page.historyEpoch;
        position.throughSeq = page.appendSeq;
        const item = page.items[0];
        if (!item) { exhausted = true; break; }
        if (position.itemSeq !== undefined && position.itemSeq !== item.seq) throw new AgentFault('STORAGE_CURSOR_STALE', '搜索中的原文项已变化');
        metadataBytes += Buffer.byteLength(canonicalJson(page));
        scannedItems++;
        position.itemSeq = item.seq;
        if (scope !== 'input' || item.role === 'user') {
            const total = item.objectRef.rawBytes;
            if (position.byteOffset > total) throw new AgentFault('STORAGE_CURSOR_STALE', '搜索字节游标超过原文边界');
            while (position.byteOffset < total) {
                const offset = Math.max(0, position.byteOffset - needle.length + 1);
                const remaining = budget - scannedBytes;
                if (remaining <= position.byteOffset - offset) return finish();
                const chunk = await store.readArtifact({ conversationId: params.conversationId, artifactId: item.contentId,
                    offset, maxBytes: Math.min(16 * 1024, remaining) });
                const bytes = Buffer.from(chunk.dataBase64, 'base64');
                if (chunk.sha256 !== item.objectRef.hash || chunk.totalBytes !== total || chunk.offset !== offset
                    || bytes.length === 0 || offset + bytes.length > total) throw new AgentFault('CONFIGURATION_HISTORY_CHANGED', '原文分片的来源、边界或哈希已变化');
                scannedBytes += bytes.length;
                let index = bytes.indexOf(needle);
                while (index >= 0) {
                    const absolute = offset + index;
                    if (absolute + needle.length > position.byteOffset) {
                        const itemHit = hit(item, bytes, index, absolute);
                        const size = Buffer.byteLength(canonicalJson(itemHit));
                        if (!hits.length && size > maxResultBytes) throw new AgentFault('FRAME_TOO_LARGE', '首个命中的来源字段超过结果预算，请增大maxBytes', { requiredBytes: size });
                        if (resultBytes + size > maxResultBytes) return finish();
                        hits.push(itemHit);
                        resultBytes += size;
                        position.byteOffset = absolute + needle.length;
                        if (hits.length === limit) return finish();
                    }
                    index = bytes.indexOf(needle, index + 1);
                }
                position.byteOffset = offset + bytes.length;
            }
        }
        if (!page.hasMore) { exhausted = true; break; }
        if (!page.nextCursor) throw new AgentFault('STORAGE_CURSOR_STALE', '历史页没有提供继续游标');
        position = { ...position, historyCursor: page.nextCursor, byteOffset: 0, itemSeq: undefined };
    }
    return finish();
}
