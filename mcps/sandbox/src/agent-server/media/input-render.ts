import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonValue } from '../protocol.js';
import type { StorePort } from '../storage/port.js';
import type { NativeSendView } from '../providers/types.js';
import { appendCouncilUser } from '../../council/api-input.js';
import { measureCanonicalJsonBytes } from './temporary-budget.js';
import { normalizeMime, validateMediaBytes } from './validation.js';
import { inputHash, inputSignal, readInputJson } from './input-conversations.js';
import type { AttachmentModelSelection, InputAttachmentLimits, InputAttachmentReference, InputConversationManifest } from './input-types.js';
import type { MediaArtifactChunk } from './types.js';

interface InputParts {
    text: string;
    images: { kind: string; mime: string; dataBase64: string; sha256: string; byteLength: number }[];
    bytes: number;
    references: number;
    objects: number;
    path: Set<string>;
}

export interface InputRenderPort {
    store: StorePort;
    limits: Readonly<InputAttachmentLimits>;
    get(conversationId: string, referenceId: string): Promise<InputAttachmentReference>;
    read(query: { conversationId: string; artifactId: string; offset?: number; maxBytes?: number }): Promise<MediaArtifactChunk>;
    checkModel(reference: InputAttachmentReference, selection: AttachmentModelSelection): void;
}

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

function selectedLines(text: string, range?: string): string {
    if (!range) return text;
    const match = /^#?L?(\d+)(?:-L?(\d+))?$/.exec(range);
    const first = Number(match?.[1]), last = Number(match?.[2] ?? match?.[1]);
    const lines = text.split(/\r?\n/);
    if (!match || !Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > lines.length) throw new AgentFault('E_REFERENCE_RANGE', '文本范围须为原文内的L10-L30');
    return lines.slice(first - 1, last).join('\n');
}

export class InputReferenceRenderer {
    constructor(private readonly port: InputRenderPort) {}

    private addText(parts: InputParts, text: string): void {
        parts.bytes += measureCanonicalJsonBytes(text, { maxBytes: this.port.limits.maxViewBytes }) + 16;
        if (parts.bytes > this.port.limits.maxViewBytes) throw new AgentFault('E_ATTACHMENT_VIEW_LIMIT', '原文与附件合计超过本次原生视图预算，原件仍保留');
        parts.text += text;
    }

    private image(parts: InputParts, mime: string, dataBase64: string, sha256?: string, byteLength?: number, selection?: AttachmentModelSelection, label = '原生块原图'): void {
        parts.bytes += dataBase64.length + 1024;
        if (parts.bytes > this.port.limits.maxViewBytes || parts.images.length >= this.port.limits.maxReferences) throw new AgentFault('E_ATTACHMENT_VIEW_LIMIT', '原图合计超过本次原生视图或图片数量预算，原件仍保留');
        const bytes = Buffer.from(dataBase64, 'base64'), actualHash = inputHash(bytes);
        if (bytes.toString('base64') !== dataBase64 || sha256 && sha256 !== actualHash || byteLength !== undefined && byteLength !== bytes.length) throw new AgentFault('E_ATTACHMENT_HASH_MISMATCH', '所选原图完整字节与原生来源SHA不同');
        const normalizedMime = normalizeMime(mime);
        validateMediaBytes('image', normalizedMime, { byteLength: bytes.length, sha256: actualHash, padded: true, prefix: bytes.subarray(0, 64), utf8Valid: true, containsNul: false });
        if (selection) this.port.checkModel({ attachmentType: 'image' } as InputAttachmentReference, selection);
        this.addText(parts, `\n[原图 ${parts.images.length + 1} | ${label} | ${normalizedMime} | SHA256 ${actualHash}]\n`);
        parts.images.push({ kind: 'council_image', mime: normalizedMime, dataBase64, sha256: actualHash, byteLength: bytes.length });
    }

    private sourceConversation(conversationId: string, reference: InputAttachmentReference, selection?: AttachmentModelSelection): string {
        const grant = selection?.selectionSource;
        if (!grant) return conversationId;
        if (grant.readerConversationId !== conversationId || !Array.isArray(grant.sources) || grant.sources.length > this.port.limits.maxReferences
            || grant.sources.some(source => typeof source.conversationId !== 'string' || !Array.isArray(source.references))
            || grant.sources.reduce((sum, source) => sum + source.references.length, 0) > this.port.limits.maxReferences) throw new AgentFault('E_REFERENCE_GRANT_STALE', '选中材料的读取许可与本次执行会话不同或超过明确名单上限');
        const sources = grant.sources.filter(source => source.references.some((allowed: Pick<InputAttachmentReference, 'referenceId' | 'sha256'>) =>
            allowed.referenceId === reference.referenceId && allowed.sha256 === reference.sha256));
        if (sources.length > 1) throw new AgentFault('E_REFERENCE_GRANT_STALE', '同一引用出现多个读取来源，请核冻结的派发材料');
        return sources[0]?.conversationId ?? conversationId;
    }

    async collect(conversationId: string, supplied: InputAttachmentReference, parts: InputParts, selection?: AttachmentModelSelection, signal?: AbortSignal, depth = 0): Promise<void> {
        inputSignal(signal);
        if (!supplied || typeof supplied.referenceId !== 'string') throw new AgentFault('E_ATTACHMENT_REFERENCE', '输入引用缺少稳定原件ID');
        const key = `${conversationId}:${supplied.referenceId}`;
        if (depth > 4 || parts.path.has(key) || ++parts.references > this.port.limits.maxReferences) throw new AgentFault('E_REFERENCE_DEPTH_LIMIT', '引用嵌套或材料数量超过有界读取上限');
        parts.path.add(key);
        try {
            const reference = await this.port.get(conversationId, supplied.referenceId);
            if (reference.sha256 !== supplied.sha256 || reference.byteLength !== supplied.byteLength || reference.mediaType !== supplied.mediaType) throw new AgentFault('E_REFERENCE_CHANGED', '待发送引用与已固定的原件不同');
            if (selection) this.port.checkModel(reference, selection);
            if (reference.attachmentType === 'conversation') {
                if (supplied.range && supplied.range !== reference.range) throw new AgentFault('E_REFERENCE_RANGE', '会话轮次已固定，请重新准备另一范围的引用');
                const manifest = await this.port.store.readContent(conversationId, reference.referenceId) as unknown as InputConversationManifest;
                this.addText(parts, `\n\n[引用 ${reference.label} | 清单SHA256 ${reference.sha256} | 历史代次 ${manifest.sourceManifest.version.historyEpoch} | 截至seq ${manifest.sourceManifest.version.appendSeq}]`);
                for (const item of manifest.sourceManifest.items) {
                    if (++parts.objects > this.port.limits.maxConversationItems) throw new AgentFault('E_REFERENCE_SOURCE_LIMIT', '原内容数量超过本次引用读取上限');
                    const value = await readInputJson(this.port.store, conversationId, item.contentId, { maxBytes: this.port.limits.maxContentBytes,
                        byteLength: item.byteLength, sha256: item.objectHash, signal });
                    this.addText(parts, `\n[源会话 ${manifest.sourceManifest.sourceId} | 原内容 ${item.sourceContentId} | 角色 ${item.role} | SHA256 ${item.objectHash}]\n`);
                    await this.originalValue(conversationId, value, parts, selection, signal, depth + 1);
                }
                return;
            }
            if (supplied.range && reference.attachmentType !== 'text') throw new AgentFault('E_REFERENCE_RANGE', '行号范围只适用于文本原件');
            const estimated = reference.attachmentType === 'image' ? Math.ceil(reference.byteLength / 3) * 4 + 1024 : reference.byteLength + 1024;
            if (parts.bytes + estimated > this.port.limits.maxViewBytes) throw new AgentFault('E_ATTACHMENT_VIEW_LIMIT', '附件超过本次原生视图预算，原件仍保留');
            const pieces: Buffer[] = []; let offset = 0;
            do {
                inputSignal(signal);
                const page = await this.port.read({ conversationId, artifactId: reference.referenceId, offset, maxBytes: 192 * 1024 });
                const bytes = Buffer.from(page.dataBase64, 'base64');
                if (page.offset !== offset || page.sha256 !== reference.sha256 || page.totalBytes !== reference.byteLength || bytes.toString('base64') !== page.dataBase64) throw new AgentFault('E_REFERENCE_CHANGED', '原件分页与固定版本不同');
                pieces.push(bytes); offset += bytes.length;
                if (offset > reference.byteLength || !page.complete && (!bytes.length || page.nextOffset !== offset)) throw new AgentFault('E_REFERENCE_SOURCE_GAP', '原件分页未连续前进');
                if (page.complete) break;
            } while (offset < reference.byteLength);
            const bytes = Buffer.concat(pieces, offset);
            if (offset !== reference.byteLength || inputHash(bytes) !== reference.sha256) throw new AgentFault('E_ATTACHMENT_HASH_MISMATCH', '附件原字节SHA校验失败');
            if (reference.attachmentType === 'image') this.image(parts, reference.mediaType, bytes.toString('base64'), reference.sha256, reference.byteLength, selection, `${reference.label} | ${reference.referenceId}`);
            else this.addText(parts, `\n\n[附件 ${reference.label} | ${reference.referenceId} | SHA256 ${reference.sha256}${supplied.range ? ` | 范围 ${supplied.range}` : ''}]\n${selectedLines(new TextDecoder('utf-8', { fatal: true }).decode(bytes), supplied.range ?? reference.range)}`);
        } finally { parts.path.delete(key); }
    }

    private async originalValue(conversationId: string, value: JsonValue, parts: InputParts, selection?: AttachmentModelSelection, signal?: AbortSignal, depth = 0): Promise<void> {
        const root = object(value);
        if (typeof value === 'string') { this.addText(parts, value); return; }
        const response = root?.kind === 'model' ? object(root.response) : Array.isArray(root?.blocks) ? root : null;
        if (response) {
            if (response.complete !== true || !Array.isArray(response.blocks)) throw new AgentFault('E_REFERENCE_NATIVE_INCOMPLETE', '选中模型原生响应尚不完整，原对象已保留');
            for (const entry of response.blocks) {
                const block = object(entry);
                if (typeof block?.text === 'string' && block.thought !== true) this.addText(parts, block.text);
                else if (block?.type === 'image' && typeof block.dataBase64 === 'string' && typeof block.mime === 'string') this.image(parts, block.mime, block.dataBase64,
                    typeof block.sha256 === 'string' ? block.sha256 : undefined, typeof block.byteLength === 'number' ? block.byteLength : undefined, selection);
                else if (block?.thought === true) continue;
                else throw new AgentFault('E_REFERENCE_NATIVE_UNSUPPORTED', '选中原生块尚不能作为文本或原图输入，请保留原对象并选择兼容材料', { type: block?.type ?? 'unknown' });
            }
            if (Array.isArray(response.toolCalls) && response.toolCalls.length) this.addText(parts, `\n[原工具调用引文]\n${canonicalJson(response.toolCalls as JsonValue)}`);
            return;
        }
        if (root?.kind === 'tool') { this.addText(parts, canonicalJson((root.result ?? null) as JsonValue)); return; }
        if (typeof root?.text === 'string') {
            this.addText(parts, root.text);
            if (Array.isArray(root.references)) for (const entry of root.references) {
                const reference = object(entry);
                if (reference?.kind === 'council_image' && typeof reference.dataBase64 === 'string' && typeof reference.mime === 'string') this.image(parts, reference.mime, reference.dataBase64,
                    typeof reference.sha256 === 'string' ? reference.sha256 : undefined, typeof reference.byteLength === 'number' ? reference.byteLength : undefined, selection);
                else await this.collect(conversationId, entry as InputAttachmentReference, parts, selection, signal, depth);
            }
            return;
        }
        if (root && ('candidates' in root || 'replayMessages' in root || 'raw' in root)) throw new AgentFault('E_REFERENCE_NATIVE_UNSUPPORTED', '请选中规范原生消息内容，完整原始对象仍由来源ID保留');
        this.addText(parts, canonicalJson(value));
    }

    async append(conversationId: string, view: NativeSendView, content: JsonValue, selection: AttachmentModelSelection, signal?: AbortSignal): Promise<NativeSendView> {
        const input = (typeof content === 'string' ? { text: content } : object(content)) as { text?: string; references?: InputAttachmentReference[] } | null;
        if (!input || input.text !== undefined && typeof input.text !== 'string' || input.references !== undefined && !Array.isArray(input.references)
            || input.text === undefined && !input.references?.length) throw new AgentFault('E_ATTACHMENT_INPUT_TYPE', '输入须包含文本或已准备的原件引用');
        const parts: InputParts = { text: '', images: [], bytes: measureCanonicalJsonBytes(view, { maxBytes: this.port.limits.maxViewBytes }), references: 0, objects: 0, path: new Set() };
        this.addText(parts, input.text ?? '');
        for (const reference of input.references ?? []) await this.collect(this.sourceConversation(conversationId, reference, selection), reference, parts, selection, signal);
        return appendCouncilUser(view, { text: parts.text, references: parts.images } as unknown as JsonValue);
    }

    async selection(conversationId: string, references: InputAttachmentReference[], signal?: AbortSignal): Promise<number> {
        const parts: InputParts = { text: '', images: [], bytes: 1024, references: 0, objects: 0, path: new Set() };
        for (const reference of references) await this.collect(conversationId, reference, parts, undefined, signal);
        return parts.bytes;
    }
}
