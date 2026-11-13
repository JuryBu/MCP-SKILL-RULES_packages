import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeCommandOutput } from '../../../src/agent-server/tools/command-output.ts';
import { ToolRouter } from '../../../src/agent-server/tools/router.ts';

test('UTF-8 and BOM-marked UTF-16 command output decode strictly without replacement characters', () => {
    const text = '中文输出，猫🐾\n';
    const utf8 = decodeCommandOutput(Buffer.from(text).toString('base64'));
    assert.equal(utf8.text, text);
    assert.equal(utf8.status, 'valid');
    const utf16 = decodeCommandOutput(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]).toString('base64'));
    assert.equal(utf16.text, text);
    assert.equal(utf16.source, 'bom');
});

test('Windows GBK errors remain recoverable raw bytes and carry an explicit candidate encoding', () => {
    const bytes = Buffer.from('d6d0cec4b4edcef3', 'hex');
    const automatic = decodeCommandOutput(bytes.toString('base64'), 'auto', 'win32');
    assert.equal(automatic.text, '中文错误');
    assert.equal(automatic.encoding, 'gb18030');
    assert.equal(automatic.status, 'candidate');
    assert.equal(automatic.source, 'windows_legacy_candidate');
    const explicit = decodeCommandOutput(bytes.toString('base64'), 'gb18030');
    assert.equal(explicit.text, '中文错误');
    assert.equal(explicit.source, 'explicit');
    assert.equal(explicit.status, 'valid');
    assert.equal(decodeCommandOutput(bytes.toString('base64'), 'utf8').status, 'unresolved');
});

test('incomplete multibyte command output is reported as unresolved and retains a raw-byte recovery instruction', () => {
    const decoded = decodeCommandOutput(Buffer.from([0xd6]).toString('base64'), 'auto', 'win32');
    assert.equal(decoded.status, 'unresolved');
    assert.match(decoded.text, /原始输出已保存/);
    assert.doesNotMatch(decoded.text, /�/);
});

test('an actual ordinary Windows Job command preserves GBK stderr bytes, readable Chinese and terminal cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sandbox-command-encoding-'));
    const runId = randomUUID();
    const context = { conversationId: randomUUID(), runId, rootRunId: runId, roots: [root],
        retention: { mode: 'temporary' }, signal: new AbortController().signal };
    const router = new ToolRouter();
    try {
        const result = await router.execute('run_command', { application: process.execPath, cwd: root,
            args: ['-e', "process.stdout.write('utf8-ok');process.stderr.write(Buffer.from('d6d0cec4b4edcef3','hex'));process.exitCode=17"],
            maxMemoryMB: 256, timeoutMs: 10000, maxOutputBytes: 8192 }, context);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.data.stdout, 'utf8-ok');
        assert.equal(result.data.stderr, '中文错误');
        assert.equal(Buffer.from(result.data.stderrBase64, 'base64').toString('hex'), 'd6d0cec4b4edcef3');
        assert.equal(result.data.outputDecoding.stderr.status, 'candidate');
        assert.equal(result.data.childExitCode, 17);
        assert.equal(result.data.cleanupState, 'released');
        assert.equal(router.list().find(entry => entry.name === 'run_command').availability, 'available');
    } finally { await router.cleanup(context); await rm(root, { recursive: true, force: true }); }
});
