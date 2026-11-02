import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readArtifactBytes, decodeArtifactJson } from '../../../dist/agent-client/artifacts.js';
import { executeCommand, parseCommand } from '../../../dist/agent-cli/commands.js';
import { parseArguments } from '../../../dist/agent-cli/arguments.js';
import { terminalSafeText } from '../../../dist/agent-cli/renderer.js';
import { resolveContentPage, resolveRunResult } from '../../../dist/agent-cli/watch.js';
import { artifactMetadata, formatExecutionText, humanJson } from '../../../dist/agent-cli/presentation.js';
import { saveVerifiedArtifact } from '../../../dist/agent-cli/output.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function readerFor(bytes, transform = page => page) {
    const calls = [];
    return { calls, request: async (method, params) => {
        calls.push({ method, params });
        const end = Math.min(params.offset + params.maxBytes, bytes.length);
        return { ok: true, data: transform({ mime: 'application/json', totalBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.subarray(params.offset, end).toString('base64'),
            nextOffset: end < bytes.length ? end : null, complete: end === bytes.length }, params) };
    } };
}

test('原文跨页字节完整恢复，中文分包后再解码并核全量哈希', async () => {
    const value = { text: '虚拟材料：中文👨‍👩‍👧‍👦\n第二行'.repeat(40), references: [] };
    const bytes = Buffer.from(JSON.stringify(value));
    const client = readerFor(bytes);
    const artifact = await readArtifactBytes(client, 'owned-conversation', 'owned-content', { maxBytes: 7 });
    assert.deepEqual(decodeArtifactJson(artifact), value);
    assert.deepEqual(artifact.bytes, bytes);
    assert.ok(client.calls.length > 10);
    assert.equal(client.calls[1].params.offset, 7);
    assert.ok(client.calls.every(call => call.method === 'conversations.readArtifact' && call.params.conversationId === 'owned-conversation'));
});

test('原文分页的长度、偏移和哈希变化均返回明确失败', async () => {
    const bytes = Buffer.from('{"text":"虚拟原文"}');
    await assert.rejects(readArtifactBytes(readerFor(bytes, page => ({ ...page, nextOffset: 0 })), 'owned-conversation', 'owned-content', { maxBytes: 4 }), /下一偏移/);
    await assert.rejects(readArtifactBytes(readerFor(bytes, (page, params) => ({ ...page, sha256: params.offset ? '1'.repeat(64) : page.sha256 })), 'owned-conversation', 'owned-content', { maxBytes: 4 }), /读取期间变化/);
    await assert.rejects(readArtifactBytes(readerFor(bytes, page => ({ ...page, sha256: '0'.repeat(64) })), 'owned-conversation', 'owned-content'), /哈希校验失败/);
    await assert.rejects(readArtifactBytes(readerFor(bytes), 'owned-conversation', 'owned-content', { maxTotalBytes: 2 }), /内存读取上限/);
    await assert.rejects(readArtifactBytes(readerFor(bytes), 'owned-conversation', 'owned-content', { expected: { sha256: '0'.repeat(64), totalBytes: bytes.length } }), /原始引用不一致/);
});

test('媒体原字节完整恢复，纯图结果显示实际元数据与保存入口', async () => {
    const bytes = Buffer.from([0, 255, 13, 10, 128, 17]);
    const artifact = await readArtifactBytes(readerFor(bytes, page => ({ ...page, mime: 'image/png' })), 'owned-conversation', 'media:owned', { maxBytes: 2 });
    assert.deepEqual(artifact.bytes, bytes); assert.equal(artifact.mime, 'image/png');
    assert.throws(() => decodeArtifactJson(artifact), /非JSON内容/);
    const value = { ...artifact, bytes: undefined, state: 'ready', type: 'image' };
    const metadata = artifactMetadata(value, 'owned-conversation', 'owned-data');
    assert.equal(metadata.totalBytes, bytes.length); assert.ok(metadata.saveArgs.includes('media:owned'));
    const text = formatExecutionText({ text: '', artifacts: [value] }, 'owned-conversation', 'owned-data');
    assert.match(text, /image\/png/); assert.match(text, /media:owned/); assert.match(text, /保存/);
    assert.equal(text.includes(bytes.toString('base64')), false);
    assert.equal(formatExecutionText({ artifacts: [{ artifactId: 'media:owned', mime: 'image/png\x1b]0;fixture\x07' }] }, 'owned-conversation').includes('\x1b'), false);
    const original = { inlineData: { mimeType: 'image/png', data: 'AA==' }, data: '普通文字', text: '完整正文' };
    const display = humanJson(original); assert.equal(display.includes('AA=='), false); assert.match(display, /普通文字/);
    assert.equal(original.inlineData.data, 'AA==');
});

test('保存原字节保留已有文件，明确覆盖后字节仍逐一一致', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'sandbox-agent-artifact-save-'));
    const destination = join(directory, '自有 原件.bin');
    const original = Buffer.from([0, 255, 10, 128, 13]); const updated = Buffer.from('自有新字节\n', 'utf8');
    try {
        assert.equal(await saveVerifiedArtifact(destination, original), destination);
        assert.deepEqual(await fs.readFile(destination), original);
        await assert.rejects(saveVerifiedArtifact(destination, updated), /目标已有文件/);
        assert.deepEqual(await fs.readFile(destination), original);
        await saveVerifiedArtifact(destination, updated, true);
        assert.deepEqual(await fs.readFile(destination), updated);
        assert.deepEqual(await fs.readdir(directory), ['自有 原件.bin']);
    } finally { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await fs.rm(directory, { recursive: true, force: true }); }
});

test('空exec正文先拒绝，未创建会话或发出任何远程写入', async () => {
    const calls = [];
    const client = { request: async (...args) => { calls.push(args); throw new Error('unexpected RPC'); } };
    const command = parseCommand(parseArguments(['exec', '--text', '   ', '--budget', '{"maxCostMicros":0,"currency":"USD"}']));
    await assert.rejects(executeCommand(command, { client, cwd: process.cwd(), readInput: async () => '   ' }), /非空正文/);
    assert.deepEqual(calls, []);
});

test('配置创建按需加载正式Profile构造与校验，保持原默认值', async () => {
    const calls = [];
    const client = { request: async (method, params) => { calls.push({ method, params }); return { ok: true, data: params.profile }; } };
    const command = parseCommand(parseArguments(['profile', 'add', '--label', '自有配置', '--protocol', 'compatible_chat', '--base-url', 'https://provider.example.invalid/v1', '--model', 'owned-model']));
    const result = await executeCommand(command, { client, cwd: process.cwd(), readInput: async () => undefined });
    assert.equal(result.result.ok, true); assert.equal(calls.length, 1); assert.equal(calls[0].method, 'profiles.put');
    assert.equal(calls[0].params.expectedRevision, 0); assert.equal(calls[0].params.profile.credentialRef, null);
    assert.equal(calls[0].params.profile.defaultModel, 'owned-model'); assert.equal(calls[0].params.profile.quotaLimitId, null);
});

test('Key导入只传不存在的文件引用和格式元数据，不读取文件', async () => {
    const calls = [];
    const client = { request: async (method, params) => { calls.push({ method, params }); return { ok: true, data: { credentialRef: 'fixture-reference' } }; } };
    const command = parseCommand(parseArguments(['key', 'set', 'fixture-profile', '--secret-file', 'does-not-exist.env', '--secret-format', 'env', '--secret-field', 'FIXTURE_ONLY', '--revision', '0']));
    const result = await executeCommand(command, { client, cwd: process.cwd(), readInput: async () => { throw new Error('must not read input'); } });
    assert.equal(result.result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'profiles.importSecret');
    assert.equal(calls[0].params.format, 'env');
    assert.equal(calls[0].params.field, 'FIXTURE_ONLY');
    assert.match(calls[0].params.sourcePath, /does-not-exist\.env$/);
    assert.equal('secret' in calls[0].params, false);
});

test('定稿输出保留换行，去掉终端控制序列', () => {
    assert.equal(terminalSafeText('第一行\n\x1b[31m第二行\x1b[0m\t末尾'), '第一行\n第二行\t末尾');
    assert.equal(terminalSafeText('正文\x1b]0;虚拟窗口标题\x07完'), '正文完');
});

test('结果、队列和大条历史均恢复原JSON，状态和原引用保持不变', async () => {
    const values = { result: { text: '实际存储结果', artifacts: [] }, queued: { text: '完整原输入', references: [{ referenceId: 'owned-ref' }] }, history: { role: 'user', text: '大条原文' } };
    const calls = [];
    const client = { readArtifact: async (conversationId, artifactId) => {
        calls.push({ conversationId, artifactId }); const bytes = Buffer.from(JSON.stringify(values[artifactId]));
        return { ok: true, data: { artifactId, mime: 'application/json', totalBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytes } };
    } };
    const result = await resolveRunResult(client, 'owned-conversation', { ok: true, data: { resultContentId: 'result', state: 'succeeded', cleanupState: 'released' }, eventCursor: 'owned-cursor' });
    assert.deepEqual(result.data.result, values.result); assert.equal(result.data.cleanupState, 'released'); assert.equal(result.eventCursor, 'owned-cursor');
    const queue = await resolveContentPage(client, 'owned-conversation', { ok: true, data: { items: [{ inputId: 'owned-input', contentId: 'queued' }] } }, 'content');
    assert.deepEqual(queue.data.items[0].content, values.queued);
    const history = await resolveContentPage(client, 'owned-conversation', { ok: true, data: { items: [{ contentId: 'small', value: { text: '已有完整值' } }, { contentId: 'history' }] } }, 'value');
    assert.deepEqual(history.data.items[1].value, values.history);
    assert.deepEqual(calls.map(call => call.artifactId), ['result', 'queued', 'history']);
});

test('exec明确命令ID派生稳定创建ID，原正文读取只发生一次', async () => {
    const calls = [];
    let reads = 0;
    const client = { request: async (method, params, options) => { calls.push({ method, params, options }); return { ok: true, data: method === 'conversations.create' ? { conversationId: 'owned-conversation' } : { runId: 'owned-run', conversationId: 'owned-conversation' } }; } };
    const args = ['exec', '--command-id', 'owned-root-command', '--text', '自有正文', '--budget', '{"currency":"USD","maxCostMicros":0}'];
    for (let attempt = 0; attempt < 2; attempt += 1) await executeCommand(parseCommand(parseArguments(args)), { client, cwd: process.cwd(), readInput: async () => { reads += 1; return '自有正文'; } });
    assert.equal(reads, 2);
    assert.equal(calls[0].params.clientCommandId, calls[2].params.clientCommandId);
    assert.match(calls[0].params.clientCommandId, /^cli-exec-create-[a-f0-9]{64}$/);
    assert.equal(calls[1].params.clientCommandId, 'owned-root-command'); assert.equal(calls[3].params.clientCommandId, 'owned-root-command');
    assert.equal(calls[1].params.input.text, '自有正文');
});
