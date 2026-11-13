import { createHash } from 'node:crypto';
import { AgentFault } from './protocol.js';
import type { RpcResult } from './protocol.js';
import { canonicalJsonByteChunks } from './media/payload-codec.js';
import type { PersistedProviderAttempt } from './storage/provider-journal.js';
import type { ArtifactChunk } from './storage/port.js';

export function failureArtifactReference(conversationId: string, attemptId: string) {
    return { method: 'conversations.readArtifact', conversationId, artifactId: `attempt:${attemptId}`,
        source: 'provider_attempt_journal', availability: 'lookup_required' };
}

export function readAttemptArtifact(record: PersistedProviderAttempt | undefined, input: {
    conversationId: string; attemptId: string; offset: number; maxBytes: number;
}): ArtifactChunk {
    if (!record || record.attempt.attemptId !== input.attemptId || record.attempt.snapshot.conversationId !== input.conversationId) {
        throw new AgentFault('NOT_FOUND', '找不到该会话内的原供应商尝试');
    }
    const original = record.failure ?? record.response?.raw;
    if (!original) throw new AgentFault('NOT_FOUND', '原尝试尚无可读取的失败或响应原件');
    const value = { source: 'provider_attempt_journal', conversationId: input.conversationId,
        runId: record.attempt.snapshot.runId, attemptId: input.attemptId, original };
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for (const chunk of canonicalJsonByteChunks(value, { maxBytes: 64 * 1024 * 1024 })) {
        hash.update(chunk);
        const start = Math.max(0, input.offset - totalBytes);
        const end = Math.min(chunk.length, input.offset + input.maxBytes - totalBytes);
        if (end > start) chunks.push(chunk.subarray(start, end));
        totalBytes += chunk.length;
    }
    if (input.offset > totalBytes) throw new AgentFault('INVALID_PARAMS', '原件读取offset超过完整大小', { totalBytes });
    const end = Math.min(totalBytes, input.offset + input.maxBytes);
    return { artifactId: `attempt:${input.attemptId}`, mime: 'application/json', offset: input.offset, totalBytes,
        sha256: hash.digest('hex'), dataBase64: Buffer.concat(chunks).toString('base64'),
        nextOffset: end < totalBytes ? end : null, complete: end === totalBytes };
}

export function readableRunResult(result: RpcResult): RpcResult {
    if (!result.ok || !result.data || typeof result.data !== 'object') return result;
    const run = result.data as Record<string, unknown>;
    const original = run.failure as { error?: { code?: string; message?: string }; acceptance?: string; attemptId?: string } | null | undefined;
    if (!original && !['failed', 'outcome_unknown'].includes(String(run.state)) && run.resultStatus !== 'unknown') return result;
    const state = run.resultStatus === 'unknown' || run.state === 'outcome_unknown' ? '原执行结果待核实'
        : run.state === 'failed' ? '原执行失败' : `原执行状态：${String(run.state)}`;
    const acceptance = original?.acceptance === 'not_sent' ? '本次停止处的下一条模型请求未发送；此前请求、已写文件和费用记录仍保留。' : original?.acceptance === 'rejected'
        ? '供应商已拒绝原请求。' : original?.acceptance === 'accepted' ? '供应商已受理原请求。' : '原请求的受理情况继续按原回执核对。';
    const reference = typeof original?.attemptId === 'string' && typeof run.conversationId === 'string'
        ? failureArtifactReference(run.conversationId, original.attemptId) : null;
    return { ...result, data: { ...run, ...(reference ? { failureArtifact: reference } : {}) },
        presentation: { format: 'markdown', text: `### ${state}\n\n${original?.error?.message ?? String(run.stopReason ?? '请查看原执行状态。')}\n\n${acceptance}`
            + (reference ? `\n\n原件：\`${reference.artifactId}\`，可通过 conversations.readArtifact 分片读取。` : '') } };
}
