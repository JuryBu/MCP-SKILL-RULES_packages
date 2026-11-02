import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonValue, RetainPolicy } from '../protocol.js';
import type { StorePort, ContentWrite } from '../storage/port.js';
import type { NativeSendView } from '../providers/types.js';
import { modelScope } from '../models/catalog.js';
import { requireEvidence } from '../models/evidence.js';
import type { MediaService } from './service.js';
import type { MediaArtifactChunk, MediaLimits } from './types.js';
import { inspectBase64, normalizeMime, requireMediaSlice, validateMediaBytes } from './validation.js';
import { measureCanonicalJsonBytes } from './temporary-budget.js';
import { DEFAULT_INPUT_ATTACHMENT_LIMITS } from './input-types.js';
import type { AttachmentModelSelection, InputAttachmentCaller, InputAttachmentLimits, InputAttachmentManifest,
    InputAttachmentReference, InputConversationManifest, PreparedInputManifest, PrepareInputAttachment, PrepareInlineInputAttachment, ToolImageOwner } from './input-types.js';
import { prepareConversationInput, readInputJson, sourceReferenceIds, inputSignal } from './input-conversations.js';
import type { InputOwner } from './input-conversations.js';
import { InputReferenceRenderer } from './input-render.js';
import { matchesToolActionId } from '../tool-action-identity.js';
import { prepareInlineInput } from './input-inline.js';

const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const textMimes = new Set(['application/json', 'application/xml', 'application/javascript']);
const imageMimes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const mimeExtensions: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.json': 'application/json', '.xml': 'application/xml',
    '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.ts': 'text/plain', '.js': 'application/javascript',
    '.py': 'text/plain', '.yaml': 'text/plain', '.yml': 'text/plain', '.log': 'text/plain', '.html': 'text/html' };

function retentionPolicy(value: RetainPolicy): RetainPolicy {
    return value.mode === 'ttl' ? { mode: 'ttl', ttlDurationMs: value.ttlDurationMs } : { mode: value.mode };
}

function attachmentType(mime: string): 'image' | 'text' {
    if (imageMimes.has(mime)) return 'image';
    if (mime.startsWith('text/') || textMimes.has(mime)) return 'text';
    throw new AgentFault('E_ATTACHMENT_TYPE_UNSUPPORTED', '请先将该附件准备为UTF-8文本或PNG/JPEG/WebP/GIF原图', { mime });
}

function checkSignal(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AgentFault('E_ATTACHMENT_CANCELLED', '本次附件准备或读取已取消，已保存分片仍属原会话');
}

export interface InputAttachmentServiceOptions {
    store: StorePort;
    media?: Pick<MediaService, 'get' | 'read'> & Partial<Pick<MediaService, 'limits'>>;
    limits?: Partial<InputAttachmentLimits>;
    currentModel?: (conversationId: string) => Promise<AttachmentModelSelection>;
    now?: () => number;
    readNativeSource?: (source: NonNullable<InputAttachmentReference['nativeSource']>, signal?: AbortSignal) => Promise<{
        value: JsonValue; protocol: string; modelId: string | null;
    }>;
}

export class InputAttachmentService {
    readonly limits: Readonly<InputAttachmentLimits>;
    constructor(private readonly options: InputAttachmentServiceOptions) {
        this.limits = Object.freeze({ ...DEFAULT_INPUT_ATTACHMENT_LIMITS, ...options.limits });
        if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value < 1)
            || this.limits.chunkBytes > 192 * 1024 || this.limits.maxReferences > 100 || this.limits.maxSourceBytes > 32 * 1024 * 1024) {
            throw new AgentFault('INVALID_PARAMS', '输入附件上限超出当前有界分片合同');
        }
    }

    private async conversation(conversationId: string, write = false) {
        const record = await this.options.store.getRecord<InputOwner & { retention: RetainPolicy & { expiresAt?: string | null; activeRuns?: number } }>({ conversationId, kind: 'conversation', id: conversationId });
        if (!record || !['open', 'closed'].includes(record.value.state) || write && record.value.state !== 'open') throw new AgentFault('E_ATTACHMENT_OWNER_STALE', '附件所属会话当前不可读写');
        const retention = record.value.retention;
        if (retention.mode === 'ttl' && retention.expiresAt && Date.parse(retention.expiresAt) <= (this.options.now?.() ?? Date.now())
            && !retention.activeRuns) throw new AgentFault('RETENTION_EXPIRED', '附件所属会话已到期，原字节按会话引用清理');
        return record;
    }

    private checkModel(reference: InputAttachmentReference, selection: AttachmentModelSelection): void {
        const modalities = requireEvidence(selection.entry.inputModalities, modelScope(selection.profile, selection.entry.modelId, selection.entry.routeId));
        const required = reference.attachmentType === 'image' ? 'image' : 'text';
        if (!modalities.includes(required)) throw new AgentFault('E_ATTACHMENT_MODALITY_UNSUPPORTED', '当前模型无法读取该附件模态，请保留原件并选择兼容模型', { modelId: selection.entry.modelId, required, supported: modalities });
    }

    private async commit(manifest: PreparedInputManifest, values: ContentWrite[] = []): Promise<void> {
        const conversation = await this.conversation(manifest.conversationId, true);
        if (canonicalJson(retentionPolicy(conversation.value.retention)) !== canonicalJson(retentionPolicy(manifest.retention))) throw new AgentFault('RETENTION_POLICY_STALE', '附件准备期间保存方式改变，请核原会话后继续');
        await this.options.store.commitTransition({ expected: [{ key: conversation.key, revision: conversation.revision }], contents: [...values,
            { conversationId: manifest.conversationId, contentId: manifest.reference.referenceId, kind: 'input_attachment_manifest', value: manifest as unknown as JsonValue, indexHistory: false }] });
    }

    toolImageLimits(): Readonly<MediaLimits> {
        const limits = this.options.media?.limits;
        if (!limits) throw new AgentFault('E_TOOL_IMAGE_LIMITS_REQUIRED', '工具图片尚未接入当前MediaService限额', { field: 'media.limits' });
        return limits;
    }

    assertToolImageSelection(selection: AttachmentModelSelection): void {
        this.checkModel({ attachmentType: 'image' } as InputAttachmentReference, selection);
    }

    async prepareToolImage(input: { owner: ToolImageOwner; blockIndex: number; mime: string; dataBase64: string }, signal?: AbortSignal): Promise<InputAttachmentReference> {
        const source = input.owner;
        const owner: ToolImageOwner = { conversationId: source.conversationId, runId: source.runId, rootRunId: source.rootRunId,
            runEpoch: source.runEpoch, actionId: source.actionId, stepId: source.stepId, attemptId: source.attemptId,
            callId: source.callId, toolName: source.toolName, principalId: source.principalId };
        const { blockIndex } = input;
        inputSignal(signal);
        if (!Number.isSafeInteger(blockIndex) || blockIndex < 0 || !Number.isSafeInteger(owner.runEpoch)
            || Object.values(owner).some(value => typeof value !== 'string' && typeof value !== 'number')) {
            throw new AgentFault('E_TOOL_IMAGE_OWNER_STALE', '工具图片缺少有效的可信归属', { field: 'owner' });
        }
        const conversation = await this.conversation(owner.conversationId, true);
        if (conversation.value.principalId !== owner.principalId) throw new AgentFault('E_TOOL_IMAGE_OWNER_STALE', '工具图片所属调用方已经变化', { field: 'principalId' });
        const run = await this.options.store.getRecord<{ runId: string; rootRunId?: string; runEpoch: number; state: string }>({
            conversationId: owner.conversationId, kind: 'run', id: owner.runId });
        const step = await this.options.store.getRecord<{ runId: string; attemptId: string; complete: boolean; toolCalls: { callId: string; name: string }[] }>({
            conversationId: owner.conversationId, kind: 'step', id: owner.stepId });
        if (!run || run.value.runEpoch !== owner.runEpoch || (run.value.rootRunId ?? run.value.runId) !== owner.rootRunId
            || !['running', 'recovering', 'waiting'].includes(run.value.state) || !step?.value.complete
            || step.value.runId !== owner.runId || step.value.attemptId !== owner.attemptId
            || !matchesToolActionId(owner.actionId, owner) || !step.value.toolCalls.some(call => call.callId === owner.callId && call.name === owner.toolName)) {
            throw new AgentFault('E_TOOL_IMAGE_OWNER_STALE', '工具图片须绑定当前运行与完整原工具调用', { field: 'run/action/step' });
        }
        const mime = normalizeMime(input.mime);
        const info = inspectBase64(input.dataBase64, Math.min(this.limits.maxSourceBytes, this.toolImageLimits().maxBlockBytes));
        validateMediaBytes('image', mime, info);
        const referenceId = `attachment:${hash(canonicalJson({ kind: 'tool_image', owner, blockIndex }))}`;
        const operationHash = hash(canonicalJson({ owner, blockIndex, mime, sha256: info.sha256, byteLength: info.byteLength }));
        const previous = await this.options.store.readContent(owner.conversationId, referenceId) as unknown as InputAttachmentManifest | undefined;
        if (previous && previous.operationHash !== operationHash) throw new AgentFault('E_REFERENCE_CHANGED', '原工具图片已经保存，新的字节保持为未提交', { referenceId });
        if (previous?.state === 'ready') return structuredClone(previous.reference);
        const reference: InputAttachmentReference = { schemaVersion: 1, referenceId, kind: 'attachment', sourceHost: 'agent-server',
            sourceId: `tool:${owner.runId}:${owner.actionId}:${blockIndex}`, revision: 1, sha256: info.sha256, byteLength: info.byteLength,
            mediaType: mime, attachmentType: 'image', prepareState: 'ready', label: `${owner.toolName} 图片${blockIndex + 1}`,
            toolSource: { ...owner, blockIndex } };
        const manifest: InputAttachmentManifest = previous ?? { schemaVersion: 1, kind: 'input_attachment', conversationId: owner.conversationId,
            reference, retention: retentionPolicy(conversation.value.retention), state: 'preparing', operationHash,
            source: { kind: 'tool_image', owner: structuredClone(owner), blockIndex }, chunks: [], createdAt: new Date(this.options.now?.() ?? Date.now()).toISOString() };
        await this.commit(manifest);
        const bytes = Buffer.from(input.dataBase64, 'base64');
        try {
            for (let offset = 0, index = 0; offset < bytes.length; offset += this.limits.chunkBytes, index++) {
                inputSignal(signal);
                const part = bytes.subarray(offset, Math.min(bytes.length, offset + this.limits.chunkBytes));
                const partHash = hash(part);
                const contentId = `attachment-chunk:${hash(`${referenceId}:${index}:${partHash}`)}`;
                const chunk = { contentId, offset, byteLength: part.length, sha256: partHash };
                if (manifest.chunks[index]) {
                    if (canonicalJson(manifest.chunks[index]) !== canonicalJson(chunk)) throw new AgentFault('E_REFERENCE_CHANGED', '原工具图片分片已变化');
                } else {
                    manifest.chunks.push(chunk);
                    await this.commit(manifest, [{ conversationId: owner.conversationId, contentId, kind: 'input_attachment_chunk',
                        value: { mime, dataBase64: part.toString('base64') }, indexHistory: false }]);
                }
            }
            manifest.state = 'ready';
            await this.commit(manifest);
            return structuredClone(reference);
        } finally { bytes.fill(0); }
    }

    prepareInline(input: PrepareInlineInputAttachment, caller: InputAttachmentCaller): Promise<InputAttachmentReference> {
        return prepareInlineInput({ store: this.options.store, limits: this.limits, now: this.options.now ?? Date.now,
            owner: conversationId => this.conversation(conversationId, true), commit: (manifest, contents) => this.commit(manifest, contents),
            checkModel: this.options.currentModel ? async (reference, conversationId) => {
                this.checkModel(reference, await this.options.currentModel!(conversationId));
            } : undefined }, input, caller);
    }

    async prepare(input: PrepareInputAttachment, caller: InputAttachmentCaller): Promise<InputAttachmentReference> {
        checkSignal(caller.signal);
        const conversation = await this.conversation(input.conversationId, true);
        if (input.kind === 'conversation') {
            const referenceId = `attachment:${hash(canonicalJson({ conversationId: input.conversationId, principalId: caller.principalId, clientId: caller.clientId, commandId: input.clientCommandId }))}`;
            const copies = { bytes: 0, seen: new Set<string>() };
            return prepareConversationInput({ store: this.options.store, limits: this.limits, now: this.options.now ?? Date.now,
                owner: (conversationId, write) => this.conversation(conversationId, write), commit: (manifest, values) => this.commit(manifest, values),
                copyReferences: (source, target, value, identity, byteLength) => {
                    copies.bytes += byteLength;
                    if (copies.bytes > this.limits.maxSourceBytes) throw new AgentFault('E_REFERENCE_SOURCE_LIMIT', '原文和原件合计超过本次复制上限');
                    return this.copyReferences(source, target, value, identity, copies, 0);
                } },
            input, caller, referenceId, hash(canonicalJson(input)));
        }
        if (input.kind === 'attachment') {
            const reference = await this.get(input.conversationId, input.source);
            if (input.expectedSha256 && input.expectedSha256 !== reference.sha256) throw new AgentFault('E_REFERENCE_CHANGED', '附件原件SHA256与选中的引用不同');
            if (input.range && reference.attachmentType === 'image' || reference.attachmentType === 'conversation' && input.range && input.range !== reference.range) throw new AgentFault('E_REFERENCE_RANGE', '原图无行号范围，已有会话引用的范围需保持原选择');
            const result = { ...reference, ...(input.range ? { range: input.range } : {}) };
            if (this.options.currentModel) this.checkModel(result, await this.options.currentModel(input.conversationId));
            return result;
        }
        const sourcePath = resolve(input.source);
        const mime = normalizeMime(input.mime ?? mimeExtensions[extname(sourcePath).toLowerCase()] ?? 'text/plain').split(';', 1)[0];
        const type = attachmentType(mime);
        if (input.range && type !== 'text') throw new AgentFault('E_REFERENCE_RANGE', '行号范围仅适用于UTF-8文本附件');
        const referenceId = `attachment:${hash(canonicalJson({ conversationId: input.conversationId, principalId: caller.principalId, clientId: caller.clientId, commandId: input.clientCommandId }))}`;
        const operationHash = hash(canonicalJson({ ...input, source: sourcePath }));
        const previous = await this.options.store.readContent(input.conversationId, referenceId) as unknown as InputAttachmentManifest | undefined;
        if (previous && previous.operationHash !== operationHash) throw new AgentFault('COMMAND_CONFLICT', '同一附件准备命令已绑定其它原件或范围');
        if (previous?.state === 'ready') return structuredClone(previous.reference);
        const file = await open(sourcePath, 'r');
        try {
            const before = await file.stat();
            if (!before.isFile() || before.size > this.limits.maxSourceBytes || type === 'text' && before.size > this.limits.maxTextBytes) throw new AgentFault('E_ATTACHMENT_SOURCE_LIMIT', '附件原件超过当前类型的有界读取上限', { bytes: before.size, maxBytes: type === 'text' ? this.limits.maxTextBytes : this.limits.maxSourceBytes });
            const checksum = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true });
            const buffer = Buffer.allocUnsafe(this.limits.chunkBytes);
            let prefix = Buffer.alloc(0), offset = 0, containsNul = false;
            while (offset < before.size) {
                checkSignal(caller.signal);
                const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
                if (!bytesRead) throw new AgentFault('E_REFERENCE_CHANGED', '读取期间原件长度变化');
                const part = buffer.subarray(0, bytesRead); checksum.update(part);
                if (!prefix.length) prefix = Buffer.from(part.subarray(0, 64));
                if (type === 'text') {
                    try { decoder.decode(part, { stream: true }); } catch { throw new AgentFault('E_ATTACHMENT_TEXT_ENCODING', '文本附件须为完整UTF-8原字节'); }
                    containsNul ||= part.includes(0);
                }
                offset += bytesRead;
            }
            if (type === 'text') { try { decoder.decode(); } catch { throw new AgentFault('E_ATTACHMENT_TEXT_ENCODING', '文本附件末尾不是完整UTF-8字符'); } }
            const sha256 = checksum.digest('hex');
            if (input.expectedSha256 && sha256 !== input.expectedSha256 || previous && previous.reference.sha256 !== sha256) throw new AgentFault('E_REFERENCE_CHANGED', '原件已变化，原引用和已保存分片保持原样');
            validateMediaBytes(type === 'image' ? 'image' : 'file', mime, { byteLength: before.size, sha256, padded: true, prefix, utf8Valid: true, containsNul });
            const reference: InputAttachmentReference = { schemaVersion: 1, referenceId, kind: 'attachment', sourceHost: 'agent-server', sourceId: sourcePath,
                revision: 1, sha256, byteLength: before.size, mediaType: mime, attachmentType: type, prepareState: 'ready', label: basename(sourcePath), ...(input.range ? { range: input.range } : {}) };
            if (this.options.currentModel) this.checkModel(reference, await this.options.currentModel(input.conversationId));
            const manifest: InputAttachmentManifest = previous ?? { schemaVersion: 1, kind: 'input_attachment', conversationId: input.conversationId,
                reference, retention: retentionPolicy(conversation.value.retention), state: 'preparing', operationHash,
                source: { path: sourcePath, byteLength: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs }, chunks: [], createdAt: new Date(this.options.now?.() ?? Date.now()).toISOString() };
            await this.commit(manifest);
            const copied = createHash('sha256'); offset = 0;
            for (let index = 0; offset < before.size; index++) {
                checkSignal(caller.signal);
                const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
                if (!bytesRead) throw new AgentFault('E_REFERENCE_CHANGED', '复制期间原件长度变化');
                const part = buffer.subarray(0, bytesRead), partHash = hash(part); copied.update(part);
                const contentId = `attachment-chunk:${hash(`${referenceId}:${index}:${partHash}`)}`;
                const chunk = { contentId, offset, byteLength: bytesRead, sha256: partHash };
                if (manifest.chunks[index]) {
                    if (canonicalJson(manifest.chunks[index]) !== canonicalJson(chunk)) throw new AgentFault('E_REFERENCE_CHANGED', '待续附件的原分片发生变化');
                } else {
                    manifest.chunks.push(chunk);
                    await this.commit(manifest, [{ conversationId: input.conversationId, contentId, kind: 'input_attachment_chunk',
                        value: { mime, dataBase64: part.toString('base64') }, indexHistory: false }]);
                }
                offset += bytesRead;
            }
            const after = await file.stat();
            const pathAfter = await stat(sourcePath);
            if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
                || pathAfter.ino !== before.ino || pathAfter.dev !== before.dev || pathAfter.mtimeMs !== before.mtimeMs
                || pathAfter.ctimeMs !== before.ctimeMs || copied.digest('hex') !== sha256) throw new AgentFault('E_REFERENCE_CHANGED', '原件在准备期间改变，尚未发布为可用引用');
            manifest.state = 'ready'; await this.commit(manifest);
            return structuredClone(reference);
        } finally { await file.close(); }
    }

    async get(conversationId: string, referenceId: string): Promise<InputAttachmentReference> {
        await this.conversation(conversationId);
        const value = await this.options.store.readContent(conversationId, referenceId) as unknown as PreparedInputManifest | undefined;
        if (value && ['input_attachment', 'input_conversation'].includes(value.kind)) {
            if (value.conversationId !== conversationId || value.state !== 'ready') throw new AgentFault('E_ATTACHMENT_NOT_READY', '该会话的引用尚未完整准备');
            if (value.kind === 'input_conversation' && (hash(canonicalJson(value.sourceManifest)) !== value.reference.sha256
                || Buffer.byteLength(canonicalJson(value.sourceManifest)) !== value.reference.byteLength)) throw new AgentFault('E_REFERENCE_CHANGED', '原文来源清单SHA或字节数与固定引用不同');
            return structuredClone(value.reference);
        }
        if (referenceId.startsWith('media:')) {
            const artifact = await this.options.media?.get(conversationId, referenceId);
            if (!artifact || artifact.state !== 'ready' || !artifact.sha256 || artifact.byteLength === null) throw new AgentFault('E_ATTACHMENT_NOT_READY', '原媒体尚无可用原字节，请核原产物状态');
            return { schemaVersion: 1, referenceId, kind: 'attachment', sourceHost: 'agent-server', sourceId: artifact.nativeRef, revision: 1,
                sha256: artifact.sha256, byteLength: artifact.byteLength, mediaType: artifact.mime, attachmentType: attachmentType(artifact.mime), prepareState: 'ready', label: referenceId,
                nativeSource: { conversationId, runId: artifact.runId, attemptId: artifact.attemptId, nativeRef: artifact.nativeRef } };
        }
        if (!/^attachment:[a-f0-9]{64}$/.test(referenceId)) throw new AgentFault('E_ATTACHMENT_REFERENCE', '输入附件引用ID无效');
        throw new AgentFault('E_ATTACHMENT_NOT_READY', '该会话的引用尚未完整准备');
    }

    private async chunk(conversationId: string, contentId: string): Promise<Buffer> {
        const parts: Buffer[] = []; let offset = 0, expectedHash: string | undefined, total = 0;
        do {
            const page = await this.options.store.readArtifact({ conversationId, artifactId: contentId, offset, maxBytes: 64 * 1024 });
            expectedHash ??= page.sha256; total = page.totalBytes;
            if (page.sha256 !== expectedHash || page.offset !== offset || total > this.limits.chunkBytes * 2 + 1024) throw new AgentFault('E_ATTACHMENT_CHUNK_CHANGED', '附件分片的存储描述变化或超出上限');
            const bytes = Buffer.from(page.dataBase64, 'base64');
            if (bytes.toString('base64') !== page.dataBase64 || !bytes.length && !page.complete) throw new AgentFault('E_ATTACHMENT_CHUNK_INVALID', '附件存储分页未前进');
            parts.push(bytes); offset += bytes.length;
            if (page.complete) break;
            if (page.nextOffset !== offset) throw new AgentFault('E_ATTACHMENT_CHUNK_INVALID', '附件分页偏移不连续');
        } while (offset < total);
        const encoded = Buffer.concat(parts, offset);
        if (offset !== total || hash(encoded) !== expectedHash) throw new AgentFault('E_ATTACHMENT_CHUNK_INVALID', '附件分片JSON完整性校验失败');
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded));
        const bytes = Buffer.from(String(value.dataBase64), 'base64');
        if (bytes.toString('base64') !== value.dataBase64 || bytes.length > this.limits.chunkBytes) throw new AgentFault('E_ATTACHMENT_CHUNK_INVALID', '附件原字节分片不完整');
        return bytes;
    }

    async read(query: { conversationId: string; artifactId: string; offset?: number; maxBytes?: number }): Promise<MediaArtifactChunk> {
        const reference = await this.get(query.conversationId, query.artifactId);
        const stored = await this.options.store.readContent(query.conversationId, query.artifactId) as unknown as PreparedInputManifest | undefined;
        if (stored?.kind !== 'input_attachment' && stored?.kind !== 'input_conversation') {
            if (query.artifactId.startsWith('media:') && this.options.media) return this.options.media.read(query);
            throw new AgentFault('E_ATTACHMENT_SOURCE_GAP', '所选原件缺少完整输入清单，原始记录保持原样');
        }
        const { offset, maxBytes } = requireMediaSlice(query.offset, query.maxBytes);
        if (offset > reference.byteLength) throw new AgentFault('INVALID_PARAMS', '附件读取偏移超过原件长度');
        const end = Math.min(reference.byteLength, offset + maxBytes);
        if (stored?.kind === 'input_conversation') {
            const bytes = Buffer.from(canonicalJson(stored.sourceManifest)).subarray(offset, end);
            return { artifactId: reference.referenceId, mime: reference.mediaType, offset, totalBytes: reference.byteLength, sha256: reference.sha256,
                dataBase64: bytes.toString('base64'), nextOffset: end < reference.byteLength ? end : null, complete: end === reference.byteLength };
        }
        const manifest = stored as InputAttachmentManifest;
        const parts: Buffer[] = [];
        for (const item of manifest.chunks) {
            if (item.offset >= end || item.offset + item.byteLength <= offset) continue;
            const bytes = await this.chunk(query.conversationId, item.contentId);
            if (bytes.length !== item.byteLength || hash(bytes) !== item.sha256) throw new AgentFault('E_ATTACHMENT_CHUNK_INVALID', '附件原件分片与清单不一致');
            parts.push(bytes.subarray(Math.max(0, offset - item.offset), Math.min(item.byteLength, end - item.offset)));
        }
        const bytes = Buffer.concat(parts);
        if (bytes.length !== end - offset) throw new AgentFault('E_ATTACHMENT_SOURCE_GAP', '附件原件存在缺失分片');
        return { artifactId: reference.referenceId, mime: reference.mediaType, offset, totalBytes: reference.byteLength, sha256: reference.sha256,
            dataBase64: bytes.toString('base64'), nextOffset: end < reference.byteLength ? end : null, complete: end === reference.byteLength };
    }

    private renderer(): InputReferenceRenderer {
        return new InputReferenceRenderer({ store: this.options.store, limits: this.limits, get: (conversationId, referenceId) => this.get(conversationId, referenceId),
            read: query => this.read(query), checkModel: (reference, selection) => this.checkModel(reference, selection) });
    }

    private async copyReferences(source: string, target: string, value: JsonValue, caller: InputAttachmentCaller,
        budget: { bytes: number; seen: Set<string> }, depth: number): Promise<void> {
        const references = sourceReferenceIds(value);
        if (references.length > this.limits.maxReferences) throw new AgentFault('E_REFERENCE_SOURCE_LIMIT', '源消息的原件引用数量超过上限');
        for (const referenceId of references) await this.copyReference(source, target, referenceId, caller, budget, depth);
    }

    private async copyReference(source: string, target: string, referenceId: string, caller: InputAttachmentCaller,
        budget: { bytes: number; seen: Set<string> }, depth: number): Promise<void> {
        checkSignal(caller.signal);
        const owner = await this.conversation(source), targetOwner = await this.conversation(target, true);
        if (owner.value.principalId !== caller.principalId || targetOwner.value.principalId !== caller.principalId) throw new AgentFault('NOT_FOUND', '找不到当前主体可读取和保存的原件');
        const reference = await this.get(source, referenceId);
        if (source === target) return;
        if (depth > 4) throw new AgentFault('E_REFERENCE_DEPTH_LIMIT', '原文引用嵌套超过当前有界复制上限');
        const key = `${source}:${referenceId}`;
        if (budget.seen.has(key)) return;
        budget.seen.add(key);
        const sourceManifest = await this.options.store.readContent(source, referenceId) as unknown as PreparedInputManifest | undefined;
        const existing = await this.options.store.readContent(target, referenceId) as unknown as PreparedInputManifest | undefined;
        if (existing?.state === 'ready') {
            if (existing.reference.sha256 !== reference.sha256) throw new AgentFault('E_REFERENCE_CHANGED', '目标会话已有不同版本的同名原件');
            return;
        }
        if (sourceManifest?.kind === 'input_conversation') {
            const copied: InputConversationManifest = { ...structuredClone(sourceManifest), conversationId: target, retention: retentionPolicy(targetOwner.value.retention), state: 'preparing', copiedContentIds: [] };
            await this.commit(copied);
            for (const item of sourceManifest.sourceManifest.items) {
                budget.bytes += item.byteLength;
                if (budget.bytes > this.limits.maxSourceBytes) throw new AgentFault('E_REFERENCE_SOURCE_LIMIT', '原文和原件合计超过本次复制上限');
                const value = await readInputJson(this.options.store, source, item.contentId, { maxBytes: this.limits.maxContentBytes,
                    byteLength: item.byteLength, sha256: item.objectHash, signal: caller.signal });
                await this.copyReferences(source, target, value, caller, budget, depth + 1);
                copied.copiedContentIds.push(item.contentId);
                await this.commit(copied, [{ conversationId: target, contentId: item.contentId, kind: 'conversation_source', value, indexHistory: false }]);
            }
            copied.state = 'ready'; await this.commit(copied); return;
        }
        budget.bytes += reference.byteLength;
        if (budget.bytes > this.limits.maxSourceBytes) throw new AgentFault('E_REFERENCE_SOURCE_LIMIT', '原文和原件合计超过本次复制上限');
        const manifest: InputAttachmentManifest = { schemaVersion: 1, kind: 'input_attachment', conversationId: target, reference: structuredClone(reference),
            retention: retentionPolicy(targetOwner.value.retention), state: 'preparing', operationHash: hash(canonicalJson({ source, referenceId, sha256: reference.sha256 })),
            source: sourceManifest?.kind === 'input_attachment' ? structuredClone(sourceManifest.source) : { path: reference.sourceId, byteLength: reference.byteLength, mtimeMs: 0, ctimeMs: 0 },
            chunks: [], createdAt: new Date(this.options.now?.() ?? Date.now()).toISOString(), origin: { conversationId: source, referenceId, sha256: reference.sha256 } };
        await this.commit(manifest);
        if (reference.nativeSource) {
            let native: { value: JsonValue; protocol: string; modelId: string | null };
            if (sourceManifest?.kind === 'input_attachment' && sourceManifest.nativeOrigin) {
                const original = sourceManifest.nativeOrigin;
                native = { value: await readInputJson(this.options.store, source, original.contentId, { maxBytes: this.limits.maxContentBytes,
                    sha256: original.sha256, byteLength: original.byteLength, signal: caller.signal }), protocol: original.protocol, modelId: original.modelId };
            } else {
                if (!this.options.readNativeSource) throw new AgentFault('E_REFERENCE_NATIVE_SOURCE_REQUIRED', '该媒体的原生签名来源读取尚未接入，请先接原journal再复制引用，原件保持原样');
                native = await this.options.readNativeSource(reference.nativeSource, caller.signal);
            }
            const response = native.value as { complete?: boolean; attemptId?: string; blocks?: { nativeRef?: string; dataBase64?: string }[] };
            if (!response || response.complete !== true || response.attemptId !== reference.nativeSource.attemptId || !Array.isArray(response.blocks)) throw new AgentFault('E_REFERENCE_NATIVE_INCOMPLETE', '原journal返回的响应身份或完整状态与该媒体来源不同');
            const block = response.blocks.find(item => item.nativeRef === reference.nativeSource!.nativeRef);
            if (!block || typeof block.dataBase64 === 'string' && hash(Buffer.from(block.dataBase64, 'base64')) !== reference.sha256) throw new AgentFault('E_REFERENCE_CHANGED', '所选媒体与原native块的原件SHA或位置不同');
            const byteLength = measureCanonicalJsonBytes(native.value, { maxBytes: this.limits.maxContentBytes });
            const sha256 = hash(canonicalJson(native.value));
            budget.bytes += byteLength;
            if (byteLength > this.limits.maxContentBytes || budget.bytes > this.limits.maxSourceBytes) throw new AgentFault('E_REFERENCE_SOURCE_LIMIT', '所选媒体的原生来源超过有界原内容上限，未截断保存');
            const contentId = `conversation-native:${hash(`${source}:${referenceId}:${sha256}`)}`;
            manifest.nativeOrigin = { contentId, sha256, byteLength, protocol: native.protocol, modelId: native.modelId };
            manifest.reference.nativeSource = { ...reference.nativeSource, snapshotConversationId: target, contentId, sha256, byteLength };
            await this.commit(manifest, [{ conversationId: target, contentId, kind: 'conversation_native_source', value: native.value, indexHistory: false }]);
        }
        const checksum = createHash('sha256'); let offset = 0;
        do {
            checkSignal(caller.signal);
            const page = await this.read({ conversationId: source, artifactId: referenceId, offset, maxBytes: this.limits.chunkBytes });
            const bytes = Buffer.from(page.dataBase64, 'base64');
            if (page.offset !== offset || page.sha256 !== reference.sha256 || page.totalBytes !== reference.byteLength
                || bytes.toString('base64') !== page.dataBase64 || !page.complete && (!bytes.length || page.nextOffset !== offset + bytes.length)) throw new AgentFault('E_REFERENCE_CHANGED', '复制原件时原分页与固定版本不同');
            checksum.update(bytes);
            const contentId = `attachment-chunk:${hash(`${target}:${referenceId}:${offset}:${hash(bytes)}`)}`;
            manifest.chunks.push({ contentId, offset, byteLength: bytes.length, sha256: hash(bytes) }); offset += bytes.length;
            await this.commit(manifest, [{ conversationId: target, contentId, kind: 'input_attachment_chunk', value: { mime: reference.mediaType, dataBase64: bytes.toString('base64') }, indexHistory: false }]);
            if (page.complete) break;
        } while (offset < reference.byteLength);
        if (offset !== reference.byteLength || checksum.digest('hex') !== reference.sha256) throw new AgentFault('E_REFERENCE_CHANGED', '复制原件的完整SHA或长度不同');
        manifest.state = 'ready'; await this.commit(manifest);
    }

    async resolveSelection(refs: readonly (string | InputAttachmentReference)[], parentCID: string, caller: InputAttachmentCaller, signal?: AbortSignal): Promise<{
        content: JsonValue; contextTokens: number; provenance: JsonValue;
    }> {
        checkSignal(signal ?? caller.signal);
        const owner = await this.conversation(parentCID);
        if (owner.value.principalId !== caller.principalId) throw new AgentFault('NOT_FOUND', '找不到当前主体可读取的父会话材料');
        if (refs.length > this.limits.maxReferences) throw new AgentFault('E_REFERENCE_SOURCE_LIMIT', '选中材料超过引用数量上限');
        const references: InputAttachmentReference[] = [];
        for (const selected of refs) {
            checkSignal(signal ?? caller.signal);
            const referenceId = typeof selected === 'string' ? selected : selected.referenceId;
            if (typeof referenceId !== 'string' || !/^(?:attachment|media):[a-f0-9]{64}$/.test(referenceId)) throw new AgentFault('E_REFERENCE_NOT_PREPARED', '内部派发只接受父会话中已准备的原件或会话引用ID，请先通过正常引用准备入口固定材料');
            const reference = await this.get(parentCID, referenceId);
            if (typeof selected !== 'string' && selected.sha256 !== reference.sha256) throw new AgentFault('E_REFERENCE_CHANGED', '选中派发材料的SHA与父会话原件不同');
            references.push(typeof selected === 'string' ? reference : { ...reference, ...(selected.range ? { range: selected.range } : {}) });
        }
        const contextTokens = await this.renderer().selection(parentCID, references, signal ?? caller.signal);
        return { content: { text: '', references: references as unknown as JsonValue }, contextTokens,
            provenance: { source: 'prepared_input_references', estimateBasis: 'conservative_native_utf8_bytes',
                sources: [{ conversationId: parentCID, references: references.map(reference => ({ referenceId: reference.referenceId, sha256: reference.sha256 })) }],
                references: references as unknown as JsonValue } };
    }

    async appendUser(conversationId: string, view: NativeSendView, content: JsonValue, selection: AttachmentModelSelection, signal?: AbortSignal): Promise<NativeSendView> {
        await this.conversation(conversationId);
        return this.renderer().append(conversationId, view, content, selection, signal);
    }
}
