import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentClient } from '../../../src/agent-client/client.ts';
import { agentResultMarkdown, getCatalogVersion } from '../../../src/agent-client/results.ts';
import { conversationExportMarkdown, saveConversationExport } from '../../../src/agent-cli/output.ts';

function fixture() {
    const calls = [];
    const client = new AgentClient({ clientId: 'sdk-observation-fixture' });
    client.control = { connected: true, close() { this.connected = false; }, async request(method, params) {
        calls.push({ method, params });
        if (method === 'runs.observe') return { ok: true, data: { run: { runId: params.runId, state: 'failed' }, visibleText: '已接正文', textMode: 'delta',
            snapshotCursor: 'watermark-10', nextCursor: 'applied-7', textThroughCursor: 'applied-7', events: [], hasMore: true, final: true, partial: true }, eventCursor: 'watermark-10' };
        if (method === 'server.readBatch') return { ok: true, data: { source: 'read_dispatch', observedAt: '2026-11-13T04:00:00Z', results: [
            { index: 0, method: 'runs.get', result: { ok: true, data: { state: 'failed', runId: 'owned-run' } } },
            { index: 1, method: 'conversations.get', result: { ok: false, error: { code: 'NOT_FOUND', message: '原对象不存在', retryable: false, mayHaveStarted: false } } },
        ] } };
        return { ok: true, data: { source: 'closed_context_snapshot', final: true, partial: false, readOnly: true } };
    } };
    return { client, calls };
}

test('observeRun uses the exact registered RPC shape without advancing applied cursor to the snapshot watermark', async () => {
    const { client, calls } = fixture();
    try {
        client.eventCursor.reset('owned-conversation', 'applied-2', '2');
        const result = await client.observeRun('owned-conversation', 'owned-run', { afterCursor: 'applied-2', limit: 20, maxBytes: 8192 });
        assert.equal(result.ok, true);
        assert.deepEqual(calls[0], { method: 'runs.observe', params: { conversationId: 'owned-conversation', runId: 'owned-run', afterCursor: 'applied-2', limit: 20, maxBytes: 8192 } });
        assert.equal(result.data.textThroughCursor, 'applied-7');
        assert.equal(result.data.snapshotCursor, 'watermark-10');
        assert.equal(client.eventCursor.get('owned-conversation'), 'applied-2');
        assert.equal(result.data.partial, true);
        assert.equal(result.data.final, true);
    } finally { await client.close(); }
});

test('readBatch preserves query success, target failure and per-item failure separately', async () => {
    const { client, calls } = fixture();
    const requests = [{ method: 'runs.get', params: { conversationId: 'owned-conversation', runId: 'owned-run' } },
        { method: 'conversations.get', params: { conversationId: 'missing-conversation' } }];
    const original = structuredClone(requests);
    try {
        const result = await client.readBatch(requests, { maxBytes: 16384 });
        assert.equal(calls[0].method, 'server.readBatch');
        assert.deepEqual(calls[0].params, { requests, maxBytes: 16384 });
        assert.deepEqual(requests, original);
        assert.equal(result.ok, true);
        assert.equal(result.data.results[0].result.ok, true);
        assert.equal(result.data.results[0].result.data.state, 'failed');
        assert.equal(result.data.results[1].result.error.code, 'NOT_FOUND');
        assert.equal(result.data.results[1].index, 1);
    } finally { await client.close(); }
});

test('registered observation and batch bounds reject invalid requests before IPC', async () => {
    const { client, calls } = fixture();
    try {
        assert.equal((await client.observeRun('owned-conversation', 'owned-run', { maxBytes: 4095 })).error.code, 'INVALID_PARAMS');
        assert.equal((await client.readBatch([])).error.code, 'INVALID_PARAMS');
        assert.equal((await client.readBatch([{ method: 'server.info' }], { maxBytes: 4096 })).error.code, 'INVALID_PARAMS');
        assert.equal((await client.readBatch(Array.from({ length: 17 }, () => ({ method: 'server.info' })))).error.code, 'INVALID_PARAMS');
        assert.equal(calls.length, 0);
    } finally { await client.close(); }
});

test('readContext and exportConversation remain read-only thin entries', async () => {
    const { client, calls } = fixture();
    try {
        const final = await client.readContext('owned-conversation');
        assert.equal(final.data.final, true);
        assert.equal(final.data.readOnly, true);
        await client.exportConversation('owned-conversation', { cursor: 'history-page-2', limit: 10, maxBytes: 8192 });
        assert.deepEqual(calls.map(call => call.method), ['conversations.context', 'conversations.export']);
        assert.deepEqual(calls[1].params, { conversationId: 'owned-conversation', cursor: 'history-page-2', limit: 10, maxBytes: 8192 });
        assert.equal(client.leases.size, 0);
        assert.equal(client.commands.size, 0);
    } finally { await client.close(); }
});

test('catalog version helper reads old and nested return paths and rejects contradictory versions', () => {
    assert.equal(getCatalogVersion({ catalogVersion: 'version-a' }), 'version-a');
    assert.equal(getCatalogVersion({ catalog: { catalogVersion: 'version-a' }, entry: {} }), 'version-a');
    assert.equal(getCatalogVersion({ ok: true, data: { catalog: { catalogVersion: 'version-a' } } }), 'version-a');
    assert.equal(getCatalogVersion({ catalogVersion: null }), null);
    assert.equal(getCatalogVersion({}), undefined);
    assert.throws(() => getCatalogVersion({ catalogVersion: 'version-a', catalog: { catalogVersion: 'version-b' } }), error => error.code === 'PROTOCOL_MISMATCH');
});

test('shared Markdown shows query success and target failure without mutating machine state', () => {
    const result = { ok: true, data: { run: { runId: 'owned-run', state: 'outcome_unknown', resultStatus: 'partial', failure: { attemptId: 'owned-attempt',
        error: { code: 'E_RESULT_UNKNOWN', message: '供应商响应待核实' } } }, visibleText: '已接正文', final: false, partial: true,
        snapshotCursor: 'watermark-10', nextCursor: 'applied-7', textThroughCursor: 'applied-7' } };
    const original = structuredClone(result);
    const text = agentResultMarkdown('runs.observe', result);
    assert.match(text, /查询已完成/);
    assert.match(text, /outcome_unknown/);
    assert.match(text, /E_RESULT_UNKNOWN/);
    assert.match(text, /已接正文/);
    assert.match(text, /部分内容/);
    assert.match(text, /正文水位：applied-7/);
    assert.deepEqual(result, original);
});

test('readable batch output keeps target failure and per-item lookup failure visible', async () => {
    const { client } = fixture();
    try {
        const result = await client.readBatch([{ method: 'runs.get', params: { conversationId: 'owned-conversation', runId: 'owned-run' } }]);
        const text = agentResultMarkdown('server.readBatch', result);
        assert.match(text, /批量查询已完成/);
        assert.match(text, /目标执行状态：failed/);
        assert.match(text, /NOT_FOUND/);
        assert.match(text, /项目 2/);
        assert.equal(result.ok, true);
    } finally { await client.close(); }
});

test('readable original history preserves user text and excludes private thought blocks', () => {
    const result = { ok: true, eventCursor: 'history-watermark', data: { historyEpoch: 2, appendSeq: 2, viewRevision: 1, hasMore: true, nextCursor: 'history-next',
        items: [{ itemId: 'user-item', seq: 1, role: 'user', view: 'raw', effective: true, contentId: 'user-content', value: { text: '用户原文' } },
            { itemId: 'assistant-item', seq: 2, role: 'assistant', view: 'raw', effective: true, contentId: 'assistant-content',
                value: { response: { blocks: [{ type: 'text', text: '可见正文' }, { type: 'text', thought: true, text: 'private-thought-fixture' }] } } }] } };
    const text = agentResultMarkdown('conversations.readHistory', result);
    assert.match(text, /用户原文/);
    assert.match(text, /可见正文/);
    assert.match(text, /assistant-content/);
    assert.match(text, /history-next/);
    assert.match(text, /部分内容/);
    assert.doesNotMatch(text, /private-thought-fixture/);
});

test('native readable export preserves Markdown and partial provenance and never overwrites implicitly', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sdk-readable-export-'));
    const destination = join(directory, '对话.md');
    const page = { format: 'markdown', markdown: '### 用户\n\n原文喵～\n\n<details><summary>工具记录</summary>\n\n```json\n{}\n```\n</details>',
        conversationId: 'owned-conversation', source: 'original_history', snapshotCursor: 'snapshot-10', observedAt: '2026-11-13T04:00:00Z',
        items: [], nextCursor: 'page-2', hasMore: true, partial: true, truncatedContentIds: ['original-content'], historyEpoch: 2, appendSeq: 10, viewRevision: 3 };
    try {
        const markdown = conversationExportMarkdown(page);
        assert.match(markdown, /部分内容/);
        assert.match(markdown, /page-2/);
        assert.match(markdown, /original-content/);
        assert.match(markdown, /原文喵～/);
        const saved = await saveConversationExport(destination, page);
        const bytes = await readFile(destination);
        assert.equal(saved.sha256, createHash('sha256').update(bytes).digest('hex'));
        assert.equal(saved.totalBytes, bytes.length);
        assert.equal(saved.partial, true);
        await assert.rejects(saveConversationExport(destination, { ...page, markdown: 'replacement' }), error => error.code === 'E_CLI_OUTPUT');
        assert.equal(await readFile(destination, 'utf8'), markdown);
        await writeFile(destination, 'old-content');
        await saveConversationExport(destination, page, true);
        assert.equal(await readFile(destination, 'utf8'), markdown);
        assert.deepEqual(await readdir(directory), ['对话.md']);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
