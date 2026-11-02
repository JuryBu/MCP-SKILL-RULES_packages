import { createHash } from 'node:crypto';
import { AgentFault, METHOD_SPECS, type RpcResult } from '../agent-server/protocol.js';

export interface ArtifactData {
    artifactId: string;
    mime: string;
    totalBytes: number;
    sha256: string;
    bytes: Buffer;
}

export interface ArtifactReader {
    request<T>(method: string, params: Record<string, unknown>): Promise<RpcResult<T>>;
}

export interface ArtifactReadOptions {
    maxBytes?: number;
    maxTotalBytes?: number;
    signal?: AbortSignal;
    expected?: { sha256: string; totalBytes: number; mime?: string };
}

export async function readArtifactBytes(client: ArtifactReader, conversationId: string, artifactId: string, options: ArtifactReadOptions = {}): Promise<ArtifactData> {
    if (!METHOD_SPECS['conversations.readArtifact']) throw new AgentFault('METHOD_NOT_AVAILABLE', '核心尚未安装原文分片读取入口');
    const maxBytes = options.maxBytes ?? 256 * 1024;
    const maxTotalBytes = options.maxTotalBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024 || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 0) throw new AgentFault('INVALID_PARAMS', '原文读取上限无效');
    const chunks: Buffer[] = [];
    let offset = 0;
    let expected: { mime: string; totalBytes: number; sha256: string } | undefined;
    while (true) {
        if (options.signal?.aborted) throw new AgentFault('E_ARTIFACT_READ_CANCELLED', '本次原文读取已取消');
        const result = await client.request<Record<string, unknown>>('conversations.readArtifact', { conversationId, artifactId, offset, maxBytes });
        if (!result.ok) throw new AgentFault(result.error?.code ?? 'PROTOCOL_MISMATCH', result.error?.message ?? '原文分片读取失败', result.error?.details, result.error?.mayHaveStarted, result.error?.retryable);
        const page = result.data;
        if (page && (page.artifactId !== undefined && page.artifactId !== artifactId || page.offset !== undefined && page.offset !== offset)) throw new AgentFault('PROTOCOL_MISMATCH', '原文分片指向或偏移与本次请求不一致');
        if (!page || typeof page.mime !== 'string' || !Number.isSafeInteger(page.totalBytes) || Number(page.totalBytes) < 0 || typeof page.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(page.sha256)
            || typeof page.dataBase64 !== 'string' || typeof page.complete !== 'boolean') throw new AgentFault('PROTOCOL_MISMATCH', '原文分片缺少完整性字段');
        const descriptor = { mime: page.mime, totalBytes: Number(page.totalBytes), sha256: page.sha256.toLowerCase() };
        if (options.expected && (descriptor.sha256 !== options.expected.sha256.toLowerCase() || descriptor.totalBytes !== options.expected.totalBytes
            || options.expected.mime !== undefined && descriptor.mime !== options.expected.mime)) throw new AgentFault('E_ARTIFACT_CHANGED', '原文分片与选中的原始引用不一致', { artifactId });
        if (descriptor.totalBytes > maxTotalBytes) throw new AgentFault('E_ARTIFACT_TOO_LARGE', '原文超过本次内存读取上限，请缩小范围或显式提高maxTotalBytes', { artifactId, totalBytes: descriptor.totalBytes, maxTotalBytes });
        if (expected && (expected.mime !== descriptor.mime || expected.totalBytes !== descriptor.totalBytes || expected.sha256 !== descriptor.sha256)) throw new AgentFault('E_ARTIFACT_CHANGED', '原文在分页读取期间变化，请重新读取同一固定版本');
        expected ??= descriptor;
        const bytes = Buffer.from(page.dataBase64, 'base64');
        if (bytes.toString('base64') !== page.dataBase64 || bytes.length > maxBytes || offset + bytes.length > descriptor.totalBytes) throw new AgentFault('PROTOCOL_MISMATCH', '原文分片的编码或长度无效');
        chunks.push(bytes);
        offset += bytes.length;
        if (page.complete) {
            if (offset !== descriptor.totalBytes || page.nextOffset !== null && page.nextOffset !== undefined) throw new AgentFault('PROTOCOL_MISMATCH', '原文结束标记与完整长度不一致');
            const combined = Buffer.concat(chunks, offset);
            if (createHash('sha256').update(combined).digest('hex') !== descriptor.sha256) throw new AgentFault('E_ARTIFACT_HASH_MISMATCH', '原文完整哈希校验失败');
            return { artifactId, ...descriptor, bytes: combined };
        }
        if (!bytes.length || page.nextOffset !== offset) throw new AgentFault('PROTOCOL_MISMATCH', '原文分页没有前进或下一偏移不连续');
    }
}

export function decodeArtifactJson(artifact: ArtifactData): unknown {
    if (!/(?:application\/json|\+json)(?:;|$)/i.test(artifact.mime)) throw new AgentFault('E_ARTIFACT_MEDIA_TYPE', '该原文为非JSON内容，请按原媒体类型保存', { artifactId: artifact.artifactId, mime: artifact.mime });
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(artifact.bytes)); }
    catch { throw new AgentFault('PROTOCOL_MISMATCH', '原文JSON或UTF-8编码无效'); }
}
