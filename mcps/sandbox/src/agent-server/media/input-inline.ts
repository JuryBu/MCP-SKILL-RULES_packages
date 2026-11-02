import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { ContentWrite, StorePort, StoreRecord } from '../storage/port.js';
import type { JsonValue } from '../protocol.js';
import type { InputOwner } from './input-conversations.js';
import { inputSignal } from './input-conversations.js';
import type { InputAttachmentCaller, InputAttachmentLimits, InputAttachmentManifest, InputAttachmentReference,
    PreparedInputManifest, PrepareInlineInputAttachment } from './input-types.js';
import { normalizeMime, validateMediaBytes } from './validation.js';

const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');

export interface InlineInputHost {
    store: StorePort;
    limits: Readonly<InputAttachmentLimits>;
    now(): number;
    owner(conversationId: string): Promise<StoreRecord<InputOwner>>;
    commit(manifest: PreparedInputManifest, contents?: ContentWrite[]): Promise<void>;
    checkModel?(reference: InputAttachmentReference, conversationId: string): Promise<void>;
}

export async function prepareInlineInput(host: InlineInputHost, input: PrepareInlineInputAttachment,
    caller: InputAttachmentCaller): Promise<InputAttachmentReference> {
    inputSignal(caller.signal);
    for (const value of [input.conversationId, input.clientCommandId, input.sourceId, caller.principalId, caller.clientId]) {
        if (typeof value !== 'string' || value.length < 1 || value.length > 2048) {
            throw new AgentFault('INVALID_PARAMS', '内存附件须带完整且有界的会话、命令及来源标识');
        }
    }
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > Math.min(host.limits.maxSourceBytes, host.limits.maxTextBytes)) {
        throw new AgentFault('E_ATTACHMENT_SOURCE_LIMIT', '内存文本附件超过当前有界读取上限');
    }
    if (typeof input.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.expectedSha256)
        || input.label !== undefined && (typeof input.label !== 'string' || input.label.length > 512)) {
        throw new AgentFault('INVALID_PARAMS', '内存附件须带完整SHA256和有界标签');
    }
    const mime = normalizeMime(input.mime).split(';', 1)[0];
    if (!mime.startsWith('text/') && !['application/json', 'application/xml', 'application/javascript'].includes(mime)) {
        throw new AgentFault('E_ATTACHMENT_TYPE_UNSUPPORTED', '内存附件入口当前接收完整UTF-8文本', { mime });
    }
    const bytes = Buffer.from(input.bytes);
    try {
        const sha256 = hash(bytes);
        if (sha256 !== input.expectedSha256.toLowerCase()) throw new AgentFault('E_REFERENCE_CHANGED', '内存附件原字节SHA256与回执不同');
        const decoder = new TextDecoder('utf-8', { fatal: true });
        try {
            for (let offset = 0; offset < bytes.length; offset += host.limits.chunkBytes) {
                decoder.decode(bytes.subarray(offset, offset + host.limits.chunkBytes), { stream: true });
            }
            decoder.decode();
        } catch { throw new AgentFault('E_ATTACHMENT_TEXT_ENCODING', '内存文本附件须保留完整UTF-8原字节'); }
        validateMediaBytes('file', mime, { byteLength: bytes.length, sha256, padded: true,
            prefix: bytes.subarray(0, 64), utf8Valid: true, containsNul: bytes.includes(0) });
        const conversation = await host.owner(input.conversationId);
        inputSignal(caller.signal);
        if (conversation.value.principalId !== caller.principalId) throw new AgentFault('E_ATTACHMENT_OWNER_STALE', '内存附件所属调用方已经变化');
        const referenceId = `attachment:${hash(canonicalJson({ conversationId: input.conversationId,
            principalId: caller.principalId, clientId: caller.clientId, commandId: input.clientCommandId }))}`;
        const operationHash = hash(canonicalJson({ kind: 'inline', conversationId: input.conversationId,
            clientCommandId: input.clientCommandId, sourceId: input.sourceId, mime, sha256,
            byteLength: bytes.length, label: input.label ?? '文本附件' }));
        const previous = await host.store.readContent(input.conversationId, referenceId) as unknown as InputAttachmentManifest | undefined;
        inputSignal(caller.signal);
        if (previous && previous.operationHash !== operationHash) throw new AgentFault('COMMAND_CONFLICT', '同一附件准备命令已经绑定其它原件');
        const reference: InputAttachmentReference = { schemaVersion: 1, referenceId, kind: 'attachment', sourceHost: 'agent-server',
            sourceId: `inline:${input.sourceId}`, revision: 1, sha256, byteLength: bytes.length, mediaType: mime,
            attachmentType: 'text', prepareState: 'ready', label: input.label ?? '文本附件' };
        await host.checkModel?.(reference, input.conversationId);
        inputSignal(caller.signal);
        if (previous?.state === 'ready') return structuredClone(previous.reference);
        const retention = conversation.value.retention;
        const manifest: InputAttachmentManifest = previous ? structuredClone(previous) : { schemaVersion: 1, kind: 'input_attachment',
            conversationId: input.conversationId, reference, retention: retention.mode === 'ttl'
                ? { mode: 'ttl', ttlDurationMs: retention.ttlDurationMs } : { mode: retention.mode },
            state: 'preparing', operationHash, source: { kind: 'inline', sourceId: input.sourceId, byteLength: bytes.length, sha256 },
            chunks: [], createdAt: new Date(host.now()).toISOString() };
        await host.commit(manifest);
        for (let offset = 0, index = 0; offset < bytes.length; offset += host.limits.chunkBytes, index++) {
            inputSignal(caller.signal);
            const part = bytes.subarray(offset, Math.min(bytes.length, offset + host.limits.chunkBytes));
            const partHash = hash(part);
            const contentId = `attachment-chunk:${hash(`${referenceId}:${index}:${partHash}`)}`;
            const chunk = { contentId, offset, byteLength: part.length, sha256: partHash };
            if (manifest.chunks[index]) {
                if (canonicalJson(manifest.chunks[index]) !== canonicalJson(chunk)) throw new AgentFault('E_REFERENCE_CHANGED', '待续内存附件的原分片发生变化');
            } else {
                manifest.chunks.push(chunk);
                await host.commit(manifest, [{ conversationId: input.conversationId, contentId, kind: 'input_attachment_chunk',
                    value: { mime, dataBase64: part.toString('base64') } as JsonValue, indexHistory: false }]);
            }
        }
        inputSignal(caller.signal);
        manifest.state = 'ready';
        await host.commit(manifest);
        return structuredClone(reference);
    } finally { bytes.fill(0); }
}
