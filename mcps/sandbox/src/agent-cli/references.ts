import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { AgentFault } from '../agent-server/protocol.js';
import type { RpcResult } from '../agent-server/protocol.js';
import type { InputAttachmentReference } from '../agent-server/media/input-types.js';

export interface CliReferenceSource { kind: 'file' | 'attachment' | 'conversation'; source: string; range?: string; sourceHost?: string;
    mime?: string; expectedSha256?: string; expectedHistoryEpoch?: number; expectedViewRevision?: number; throughSeq?: number; contentIds?: string[] }
export interface CliAttachmentClient { request<Data = unknown>(method: string, params: Record<string, unknown>, options?: { clientCommandId?: string }): Promise<RpcResult<Data>> }

export function parseCliReferenceSource(value: string, cwd: string): CliReferenceSource {
    if (typeof value !== 'string' || !value) throw new AgentFault('E_CLI_REFERENCE', '请提供附件路径或原件引用ID');
    if (value.startsWith('@conversation:') || value.startsWith('conversation:')) {
        const match = /^@?conversation:([^:]+):([^#\s]+)(?:#(.*))?$/u.exec(value);
        if (!match) throw new AgentFault('E_CLI_REFERENCE', '会话引用使用@conversation:agent-server:<id>#round=12-15');
        if (match[1] !== 'agent-server') throw new AgentFault('E_REFERENCE_SOURCE_UNAVAILABLE', '该会话来源尚无只读原文适配，请选择agent-server会话');
        if (match[3] && !/^(?:round=\d+(?:-\d+)?|content=[^\s#]+)$/u.test(match[3])) throw new AgentFault('E_REFERENCE_RANGE', '会话范围使用round=12-15或content=<原内容ID>');
        return { kind: 'conversation', sourceHost: 'agent-server', source: match[2], ...(match[3] ? { range: match[3] } : {}) };
    }
    const explicitFile = value.startsWith('@file:');
    const explicitAttachment = value.startsWith('@attachment:');
    if (explicitAttachment) value = value.slice('@attachment:'.length);
    if (explicitFile) value = value.slice('@file:'.length);
    const range = value.match(/#L?\d+(?:-L?\d+)?$/u)?.[0];
    if (range) value = value.slice(0, -range.length);
    if (!explicitFile && (explicitAttachment || /^(?:attachment|media):/.test(value))) {
        if (!value) throw new AgentFault('E_CLI_REFERENCE', '附件引用ID不可为空');
        return { kind: 'attachment', source: /^[a-f0-9]{64}$/.test(value) ? `attachment:${value}` : value, ...(range ? { range } : {}) };
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!value) throw new AgentFault('E_CLI_REFERENCE', '附件路径不可为空');
    return { kind: 'file', source: resolve(cwd, value), ...(range ? { range } : {}) };
}

export function parseCliInputReferences(text: string, options: { attachments?: string[]; references?: string[]; cwd: string }): { text: string; sources: CliReferenceSource[] } {
    const sources: CliReferenceSource[] = [];
    const body = text.replace(/(^|\s)(?<!@)@(?:file:(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s]+))((?:#L?\d+(?:-L?\d+)?)?)|attachment:([^\s]+)|conversation:([^\s]+))/gu,
        (_token, prefix: string, doubleQuoted: string, singleQuoted: string, unquoted: string, range: string, id: string, conversation: string) => {
            const path = doubleQuoted !== undefined ? `"${doubleQuoted}"` : singleQuoted !== undefined ? `'${singleQuoted}'` : unquoted;
            const punctuation = (conversation ?? id)?.match(/[，。；！？、,;!?]+$/u)?.[0] ?? '';
            const token = conversation ?? id;
            const selected = punctuation ? token.slice(0, -punctuation.length) : token;
            sources.push(parseCliReferenceSource(conversation ? `@conversation:${selected}` : id ? `@attachment:${selected}` : `@file:${path}${range ?? ''}`, options.cwd));
            return prefix + punctuation;
        });
    if (/(^|\s)@conversation(?=:|\s|$)/u.test(body)) throw new AgentFault('E_CLI_REFERENCE', '会话引用格式未完整，请保留草稿并补齐来源和会话ID');
    for (const source of options.attachments ?? []) sources.push(parseCliReferenceSource(`@file:${source}`, options.cwd));
    for (const source of options.references ?? []) sources.push(parseCliReferenceSource(/^@?conversation:/.test(source) ? source : `@attachment:${source}`, options.cwd));
    if (sources.length > 32) throw new AgentFault('E_CLI_REFERENCE_LIMIT', '一条输入最多选择32份附件');
    return { text: body, sources };
}

export function normalizeCliDraftReference(value: unknown, cwd: string): CliReferenceSource {
    if (typeof value === 'string') return parseCliReferenceSource(value, cwd);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentFault('E_CLI_REFERENCE', '旧引用缺少类型和来源，请保留草稿并重新选择原件');
    const reference = value as Record<string, unknown>;
    if (reference.range !== undefined && typeof reference.range !== 'string') throw new AgentFault('E_REFERENCE_RANGE', '旧引用范围尚不能识别，请保留草稿并重新选择明确范围');
    if (reference.sha256 !== undefined && reference.sha256 !== '' && (typeof reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reference.sha256))) throw new AgentFault('E_REFERENCE_CHANGED', '旧引用SHA格式无效，请重新固定原件');
    const range = typeof reference.range === 'string' ? reference.range : undefined;
    const sha256 = typeof reference.sha256 === 'string' && /^[a-f0-9]{64}$/.test(reference.sha256) ? reference.sha256 : undefined;
    if (typeof reference.referenceId === 'string' && /^(?:attachment|media):[a-f0-9]{64}$/.test(reference.referenceId) && reference.prepareState !== 'preparing') {
        return { kind: 'attachment', source: reference.referenceId, ...(range ? { range } : {}), ...(sha256 ? { expectedSha256: sha256 } : {}) };
    }
    const source = typeof reference.source === 'string' ? reference.source : typeof reference.sourceId === 'string' ? reference.sourceId : typeof reference.path === 'string' ? reference.path : undefined;
    if (!source) throw new AgentFault('E_CLI_REFERENCE', '旧引用缺少原件ID、来源路径或源会话ID，请保留草稿并重新选择');
    if (reference.kind === 'file') {
        if (reference.sourceHost !== undefined && !['agent-server', 'local', 'filesystem', 'file-system'].includes(String(reference.sourceHost))) throw new AgentFault('E_REFERENCE_SOURCE_UNAVAILABLE', '旧文件引用的来源尚未适配');
        return { kind: 'file', source: resolve(cwd, source), ...(range ? { range } : {}), ...(sha256 ? { expectedSha256: sha256 } : {}),
            ...(typeof reference.mediaType === 'string' ? { mime: reference.mediaType } : {}) };
    }
    if (reference.kind === 'conversation') {
        const parsed = parseCliReferenceSource(`@conversation:${String(reference.sourceHost ?? 'agent-server')}:${source}${range ? `#${range.replace(/^#/, '')}` : ''}`, cwd);
        const version = reference.sourceVersion as { historyEpoch?: unknown; appendSeq?: unknown; viewRevision?: unknown } | undefined;
        return { ...parsed, ...(sha256 ? { expectedSha256: sha256 } : {}),
            ...(Number.isSafeInteger(version?.historyEpoch) ? { expectedHistoryEpoch: Number(version!.historyEpoch) } : {}),
            ...(Number.isSafeInteger(version?.viewRevision) ? { expectedViewRevision: Number(version!.viewRevision) } : {}),
            ...(Number.isSafeInteger(version?.appendSeq) ? { throughSeq: Number(version!.appendSeq) } : {}) };
    }
    if (reference.kind === 'attachment' && /^(?:attachment|media):[a-f0-9]{64}$/.test(source)) return { kind: 'attachment', source, ...(range ? { range } : {}), ...(sha256 ? { expectedSha256: sha256 } : {}) };
    throw new AgentFault('E_CLI_REFERENCE', '旧引用形状尚未适配，请保留原草稿并明确选择文件、原件或会话');
}

export async function prepareCliInputReferences(client: CliAttachmentClient, input: { conversationId: string; text: string;
    existing?: unknown[]; sources?: CliReferenceSource[]; cwd: string; commandId: string; attachments?: string[]; references?: string[];
    signal?: AbortSignal }): Promise<{ text: string; references: unknown[] }> {
    const parsed = parseCliInputReferences(input.text, input);
    const references: InputAttachmentReference[] = [];
    const existing = (input.existing ?? []).map(value => normalizeCliDraftReference(value, input.cwd));
    const sources = [...existing, ...(input.sources ?? []), ...parsed.sources];
    if (sources.length > 32) throw new AgentFault('E_CLI_REFERENCE_LIMIT', '一条输入最多选择32份附件');
    for (const [index, source] of sources.entries()) {
        if (input.signal?.aborted) throw new AgentFault('FRONTEND_CANCELLED', '前台已取消，原输入和附件仍保留');
        const clientCommandId = `cli-reference-${createHash('sha256').update(JSON.stringify({ commandId: input.commandId, index, source })).digest('hex')}`;
        const result = await client.request<{ reference: InputAttachmentReference }>('conversations.references.prepare', {
            conversationId: input.conversationId, clientCommandId, ...source,
        }, { clientCommandId });
        if (!result.ok) throw new AgentFault(result.error?.code ?? 'E_REFERENCE_PREPARE', result.error?.message ?? '附件准备未完成', result.error?.details, result.error?.mayHaveStarted, result.error?.retryable);
        if (!result.data?.reference || result.data.reference.prepareState !== 'ready') throw new AgentFault('E_REFERENCE_PREPARE', '附件准备回执缺少完整原件引用');
        references.push(result.data.reference);
    }
    return { text: parsed.text, references };
}
