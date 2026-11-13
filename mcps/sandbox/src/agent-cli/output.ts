import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AgentFault } from '../agent-server/protocol.js';
import type { ConversationExportPage } from '../agent-client/observations.js';
import { formatLocalTimestamp } from '../agent-client/results.js';

export function conversationExportMarkdown(page: ConversationExportPage): string {
    if (page.format !== 'markdown' || typeof page.markdown !== 'string' || typeof page.conversationId !== 'string'
        || typeof page.snapshotCursor !== 'string' || typeof page.observedAt !== 'string' || typeof page.partial !== 'boolean' || typeof page.hasMore !== 'boolean'
        || page.nextCursor !== null && typeof page.nextCursor !== 'string' || page.hasMore && (!page.partial || !page.nextCursor)
        || !Array.isArray(page.truncatedContentIds) || page.truncatedContentIds.some(value => typeof value !== 'string')
        || page.truncatedContentIds.length > 0 && !page.partial) throw new AgentFault('PROTOCOL_MISMATCH', '导出页缺少正文、归属或完整性字段');
    const quote = (value: string) => value.replace(/[\r\n\x00-\x1f\x7f]/g, ' ');
    const header = [`# Sandbox Agent 对话导出`, `> 对话：${quote(page.conversationId)}`, `> 快照游标：${quote(page.snapshotCursor)}`,
        `> 读取时间：${formatLocalTimestamp(page.observedAt)}`, `> 本页范围：${page.partial ? '部分内容' : '本次读取范围完整'}`];
    if (page.hasMore && typeof page.nextCursor === 'string') header.push(`> 继续读取：${quote(page.nextCursor)}`);
    if (page.truncatedContentIds.length) header.push(`> 正文未展开的原件：${page.truncatedContentIds.map(quote).join('，')}`);
    return header.join('\n') + '\n\n' + page.markdown + '\n';
}

export async function saveConversationExport(path: string, page: ConversationExportPage, force = false): Promise<{
    path: string; sha256: string; totalBytes: number; partial: boolean; nextCursor: string | null; snapshotCursor: string;
}> {
    const bytes = Buffer.from(conversationExportMarkdown(page), 'utf8');
    const destination = await saveVerifiedArtifact(path, bytes, force);
    return { path: destination, sha256: createHash('sha256').update(bytes).digest('hex'), totalBytes: bytes.length,
        partial: page.partial, nextCursor: page.nextCursor, snapshotCursor: page.snapshotCursor };
}

export async function saveVerifiedArtifact(path: string, bytes: Buffer, force = false): Promise<string> {
    const destination = resolve(path);
    const temporary = join(dirname(destination), '.sandbox-agent-export-' + randomUUID() + '.tmp');
    try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        if (force) await fs.rename(temporary, destination);
        else { await fs.link(temporary, destination); await fs.unlink(temporary); }
        return destination;
    } catch (error) {
        throw new AgentFault('E_CLI_OUTPUT', '产物保存未完成，目标已有文件时需要明确--force', { path: destination, reason: error instanceof Error ? error.message : String(error) });
    } finally { await fs.unlink(temporary).catch(() => {}); }
}
