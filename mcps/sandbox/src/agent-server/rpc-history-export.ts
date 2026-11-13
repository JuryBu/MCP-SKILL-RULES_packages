import { canonicalJson } from './protocol.js';
import type { HistoryItem, HistoryPage } from './storage/port.js';
import type { StorePort } from './storage/port.js';
import { contextStateKey } from './storage/context-transactions.js';

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function fence(text: string): string {
    const lengths = [...text.matchAll(/`+/g)].map(match => match[0].length);
    const marker = '`'.repeat(Math.max(3, ...lengths.map(length => length + 1)));
    return `${marker}\n${text}\n${marker}`;
}

function body(item: HistoryItem): string {
    const value = object(item.value);
    if (typeof item.value === 'string') return item.value;
    if (item.role === 'tool') return fence(canonicalJson(value.result ?? value));
    if (item.role === 'assistant') {
        const response = object(value.response);
        const blocks = Array.isArray(response.blocks) ? response.blocks : [];
        return blocks.map(object).filter(block => block.type === 'text' && block.thought !== true)
            .map(block => typeof block.text === 'string' ? block.text : '').join('');
    }
    const nested = object(value.value ?? value.summary ?? value.content);
    return [value.text, value.body, nested.text, nested.body].find(text => typeof text === 'string') as string | undefined ?? '';
}

export function renderHistoryExport(page: HistoryPage, input: {
    conversationId: string; snapshotCursor: string; observedAt: string; truncatedContentIds: string[];
}) {
    const truncated = new Set(input.truncatedContentIds);
    const sections = page.items.map(item => {
        const title = item.view === 'summary' ? '压缩摘要' : item.role === 'user' ? '用户' : item.role === 'assistant' ? '助手'
            : item.role === 'tool' ? '工具' : '系统';
        const text = truncated.has(item.contentId) ? '本页仅保留原件引用，正文可按原contentId分片读取。' : body(item) || '该条目保留原生结构，正文请查看原件。';
        const reference = `来源：${item.view === 'summary' ? '压缩记录' : '原文'}，${item.effective ? '当前有效' : '历史保留'}，序号 ${item.seq}，原件 \`${item.contentId}\``;
        return item.role === 'tool' ? `<details>\n<summary>工具记录 · ${item.seq}</summary>\n\n${text}\n\n${reference}\n\n</details>`
            : `### ${title}\n\n${text}\n\n${reference}`;
    });
    return { format: 'markdown' as const, markdown: sections.join('\n\n'), source: 'original_history' as const,
        conversationId: input.conversationId, historyEpoch: page.historyEpoch, appendSeq: page.appendSeq,
        viewRevision: page.viewRevision, snapshotCursor: input.snapshotCursor, observedAt: input.observedAt,
        items: page.items.map(({ value: _value, ...reference }) => reference), nextCursor: page.nextCursor,
        hasMore: page.hasMore, partial: page.hasMore || truncated.size > 0, truncatedContentIds: input.truncatedContentIds };
}

export async function readCompressionExport(store: Pick<StorePort, 'getRecord' | 'readArtifact'>,
    input: { conversationId: string; viewRevision: number; maxBytes: number }) {
    const state = await store.getRecord(contextStateKey(input.conversationId));
    const contentId = state?.value.viewContentId;
    if (typeof contentId !== 'string') return null;
    const chunk = await store.readArtifact({ conversationId: input.conversationId, artifactId: contentId, offset: 0, maxBytes: input.maxBytes });
    const reference = { method: 'conversations.readArtifact', conversationId: input.conversationId,
        artifactId: contentId, sha256: chunk.sha256, totalBytes: chunk.totalBytes };
    if (!chunk.complete) return { source: 'published_context_view', reference, partial: true,
        markdown: '### 压缩视图\n\n本页保留已发布压缩视图的原件引用，完整摘要可按原件分片读取。' };
    const view = object(JSON.parse(Buffer.from(chunk.dataBase64, 'base64').toString('utf8')));
    if (view.revision !== input.viewRevision) return { source: 'published_context_view', reference, partial: true,
        markdown: '### 压缩视图\n\n读取期间压缩视图版本已变化，请重新导出以读取同一版本。' };
    const nodes = (Array.isArray(view.nodes) ? view.nodes : []).map(object);
    return { source: 'published_context_view', reference, viewRevision: view.revision, partial: false,
        markdown: nodes.map(node => `### 压缩摘要${typeof node.title === 'string' ? `：${node.title}` : ''}\n\n`
            + `${typeof node.body === 'string' ? node.body : ''}\n\n来源：已发布${node.kind === 'fold' ? '折叠' : '批次'}原件，原文序号 ${String(node.firstSeq)}—${String(node.lastSeq)}`).join('\n\n') };
}
