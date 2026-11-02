import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonValue, RetainPolicy } from '../protocol.js';
import type { ContentWrite, HistoryItem, StorePort, StoreRecord } from '../storage/port.js';
import type { ConversationSourceItem, InputAttachmentCaller, InputAttachmentLimits, InputAttachmentReference,
    InputConversationManifest, PreparedInputManifest, PrepareInputAttachment } from './input-types.js';

export const inputHash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
export function inputSignal(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AgentFault('E_ATTACHMENT_CANCELLED', '引用准备或读取已取消，原草稿和已保存分片仍保留');
}

export interface InputOwner extends Record<string, unknown> {
    principalId: string;
    state: string;
    retention: RetainPolicy;
    historyEpoch: number;
    appendSeq: number;
    viewRevision: number;
}

export interface ConversationInputHost {
    store: StorePort;
    limits: Readonly<InputAttachmentLimits>;
    now(): number;
    owner(conversationId: string, write?: boolean): Promise<StoreRecord<InputOwner>>;
    commit(manifest: PreparedInputManifest, contents?: ContentWrite[]): Promise<void>;
    copyReferences(sourceConversationId: string, targetConversationId: string, value: JsonValue, caller: InputAttachmentCaller, byteLength: number): Promise<void>;
}

export async function readInputJson(store: StorePort, conversationId: string, contentId: string,
    options: { maxBytes: number; sha256?: string; byteLength?: number; signal?: AbortSignal; frameBytes?: number }): Promise<JsonValue> {
    const pieces: Buffer[] = [];
    let offset = 0, sha256 = options.sha256, total = options.byteLength;
    do {
        inputSignal(options.signal);
        const page = await store.readArtifact({ conversationId, artifactId: contentId, offset, maxBytes: options.frameBytes ?? 192 * 1024 });
        sha256 ??= page.sha256; total ??= page.totalBytes;
        if (page.offset !== offset || page.sha256 !== sha256 || page.totalBytes !== total || total > options.maxBytes) throw new AgentFault('E_REFERENCE_CHANGED', '选中原始内容的版本、长度或SHA变化，或超过单内容读取上限');
        const bytes = Buffer.from(page.dataBase64, 'base64');
        if (bytes.toString('base64') !== page.dataBase64 || offset + bytes.length > total) throw new AgentFault('E_REFERENCE_CHANGED', '原内容分页与字节范围不一致');
        pieces.push(bytes); offset += bytes.length;
        if (page.complete) break;
        if (!bytes.length || page.nextOffset !== offset) throw new AgentFault('E_REFERENCE_SOURCE_GAP', '原内容分页没有连续前进');
    } while (offset < total!);
    const encoded = Buffer.concat(pieces, offset);
    if (offset !== total || inputHash(encoded) !== sha256) throw new AgentFault('E_REFERENCE_CHANGED', '原内容完整字节SHA校验失败');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded)) as JsonValue;
}

export function sourceReferenceIds(value: JsonValue): string[] {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.references)) return [];
    return value.references.map(reference => {
        if (!reference || typeof reference !== 'object' || Array.isArray(reference)) throw new AgentFault('E_REFERENCE_NOT_PREPARED', '源原文带有未准备的旧引用，请先固定原件');
        if (reference.kind === 'council_image' && typeof reference.dataBase64 === 'string') return null;
        if (typeof reference.referenceId !== 'string') throw new AgentFault('E_REFERENCE_NOT_PREPARED', '源原文引用缺少可读取的原件ID，无法把当前路径内容当作旧原件');
        return reference.referenceId;
    }).filter((value): value is string => value !== null);
}

export async function prepareConversationInput(host: ConversationInputHost, input: PrepareInputAttachment, caller: InputAttachmentCaller,
    referenceId: string, operationHash: string): Promise<InputAttachmentReference> {
    if ((input.sourceHost ?? 'agent-server') !== 'agent-server') throw new AgentFault('E_REFERENCE_SOURCE_UNAVAILABLE', '该会话来源尚无只读原文适配，请选择agent-server会话');
    const target = await host.owner(input.conversationId, true);
    if (target.value.principalId !== caller.principalId) throw new AgentFault('NOT_FOUND', '找不到当前主体可写入的会话');
    const previous = await host.store.readContent(input.conversationId, referenceId) as unknown as InputConversationManifest | undefined;
    if (previous && (previous.kind !== 'input_conversation' || previous.operationHash !== operationHash)) throw new AgentFault('COMMAND_CONFLICT', '同一准备命令已经绑定其它原文选择');
    if (previous?.state === 'ready') return structuredClone(previous.reference);
    const source = await host.owner(input.source);
    if (source.value.principalId !== caller.principalId) throw new AgentFault('NOT_FOUND', '找不到当前主体可读取的源会话');
    const version = previous?.sourceManifest.version ?? { historyEpoch: input.expectedHistoryEpoch ?? source.value.historyEpoch,
        appendSeq: input.throughSeq ?? source.value.appendSeq, viewRevision: input.expectedViewRevision ?? source.value.viewRevision };
    if (version.historyEpoch !== source.value.historyEpoch || version.appendSeq > source.value.appendSeq || version.viewRevision > source.value.viewRevision) throw new AgentFault('E_REFERENCE_CHANGED', '所选会话历史代次或读取边界已经变化，请重新选择');
    let manifest = previous;
    if (!manifest) {
        const range = input.range?.replace(/^#/, '');
        const rounds = range ? /^round=(\d+)(?:-(\d+))?$/.exec(range) : null;
        const selectedIds = input.contentIds ?? (range?.startsWith('content=') ? [range.slice('content='.length)] : undefined);
        if (range && !rounds && !selectedIds || rounds && selectedIds) throw new AgentFault('E_REFERENCE_RANGE', '会话引用使用round=12-15，或明确选择contentIds');
        const startRound = rounds ? Number(rounds[1]) : undefined, endRound = rounds ? Number(rounds[2] ?? rounds[1]) : undefined;
        if (rounds && (!Number.isSafeInteger(startRound) || !Number.isSafeInteger(endRound) || startRound! < 1 || endRound! < startRound!)) throw new AgentFault('E_REFERENCE_RANGE', '会话轮次范围无效');
        const items: ConversationSourceItem[] = [];
        const add = (item: { contentId: string; objectRef: { hash: string; rawBytes: number }; itemId?: string; roundId?: string | null; seq?: number; role?: string; providerProtocol?: string | null }) => {
            if (item.objectRef.rawBytes > host.limits.maxContentBytes || items.length >= host.limits.maxConversationItems
                || items.reduce((sum, current) => sum + current.byteLength, item.objectRef.rawBytes) > host.limits.maxSourceBytes) throw new AgentFault('E_REFERENCE_SOURCE_LIMIT', '所选原内容超过有界引用上限，请缩小轮次或内容范围');
            items.push({ contentId: `conversation-content:${inputHash(`${input.source}:${item.contentId}:${item.objectRef.hash}`)}`,
                sourceContentId: item.contentId, objectHash: item.objectRef.hash, byteLength: item.objectRef.rawBytes,
                itemId: item.itemId ?? null, roundId: item.roundId ?? null, seq: item.seq ?? null, role: item.role ?? 'source', providerProtocol: item.providerProtocol ?? null });
        };
        if (selectedIds) {
            if (!selectedIds.length || selectedIds.length > host.limits.maxConversationItems || new Set(selectedIds).size !== selectedIds.length) throw new AgentFault('E_REFERENCE_RANGE', '选中原内容ID须非空、唯一且在引用数量上限内');
            for (const contentId of selectedIds) {
                inputSignal(caller.signal);
                const page = await host.store.readArtifact({ conversationId: input.source, artifactId: contentId, offset: 0, maxBytes: 1 });
                add({ contentId, objectRef: { hash: page.sha256, rawBytes: page.totalBytes } });
            }
        } else {
            if (endRound !== undefined) {
                const last = await host.store.readHistory({ conversationId: input.source, view: 'raw', effectiveOnly: false, startRound: endRound, endRound,
                    expectedHistoryEpoch: version.historyEpoch, throughSeq: version.appendSeq, limit: 1, maxBytes: 64 * 1024 });
                if (!last.items.length) throw new AgentFault('E_REFERENCE_RANGE', '会话没有所选结束轮，未把已有片段当成完整范围');
            }
            let cursor: string | undefined;
            const cursors = new Set<string>();
            do {
                inputSignal(caller.signal);
                const page = await host.store.readHistory({ conversationId: input.source, view: 'raw', effectiveOnly: false, startRound, endRound,
                    expectedHistoryEpoch: version.historyEpoch, throughSeq: version.appendSeq, limit: 16, maxBytes: 64 * 1024, ...(cursor ? { cursor } : {}) });
                for (const item of page.items) add(item as HistoryItem);
                if (!page.hasMore) break;
                if (!page.items.length || !page.nextCursor || cursors.has(page.nextCursor)) throw new AgentFault('E_REFERENCE_SOURCE_GAP', '源会话原文分页未前进');
                cursors.add(page.nextCursor); cursor = page.nextCursor;
            } while (cursor);
        }
        if (!items.length) throw new AgentFault('E_REFERENCE_SOURCE_EMPTY', '所选范围没有原始内容，未使用摘要替代');
        const sourceManifest = { schemaVersion: 1 as const, sourceHost: 'agent-server' as const, sourceId: input.source, version,
            range: range ?? null, totalSourceBytes: items.reduce((sum, item) => sum + item.byteLength, 0), items };
        const encoded = canonicalJson(sourceManifest);
        if (Buffer.byteLength(encoded) > 64 * 1024) throw new AgentFault('E_REFERENCE_SOURCE_LIMIT', '原文来源清单超过64KiB，请缩小选择范围');
        const reference: InputAttachmentReference = { schemaVersion: 1, referenceId, kind: 'conversation', sourceHost: 'agent-server', sourceId: input.source,
            revision: 1, sha256: inputHash(encoded), byteLength: Buffer.byteLength(encoded), mediaType: 'application/vnd.sandbox.conversation-reference+json',
            attachmentType: 'conversation', prepareState: 'ready', label: `会话 ${input.source}${range ? ` #${range}` : ''}`, sourceVersion: version, ...(range ? { range } : {}) };
        if (input.expectedSha256 && reference.sha256 !== input.expectedSha256) throw new AgentFault('E_REFERENCE_CHANGED', '所选原文清单SHA与固定的版本不同');
        manifest = { schemaVersion: 1, kind: 'input_conversation', conversationId: input.conversationId, reference, retention: target.value.retention,
            state: 'preparing', operationHash, sourceManifest, copiedContentIds: [], createdAt: new Date(host.now()).toISOString() };
        await host.commit(manifest);
    }
    for (const item of manifest.sourceManifest.items) {
        inputSignal(caller.signal);
        if (manifest.copiedContentIds.includes(item.contentId)) continue;
        const current = await host.owner(input.source);
        if (current.value.historyEpoch !== version.historyEpoch) throw new AgentFault('E_REFERENCE_CHANGED', '复制原文期间历史代次变化，已保存原件保持原样');
        const value = await readInputJson(host.store, input.source, item.sourceContentId, { sha256: item.objectHash, byteLength: item.byteLength,
            maxBytes: host.limits.maxContentBytes, signal: caller.signal });
        await host.copyReferences(input.source, input.conversationId, value, caller, item.byteLength);
        manifest.copiedContentIds.push(item.contentId);
        await host.commit(manifest, [{ conversationId: input.conversationId, contentId: item.contentId, kind: 'conversation_source', value, indexHistory: false }]);
    }
    manifest.state = 'ready'; await host.commit(manifest);
    return structuredClone(manifest.reference);
}
