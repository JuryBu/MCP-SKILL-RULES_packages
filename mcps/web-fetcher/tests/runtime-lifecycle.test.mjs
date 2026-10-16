import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const component = process.cwd();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(read, predicate, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await read().catch(() => null);
        if (predicate(value)) return value;
        await pause(50);
    }
    throw new Error('runtime fixture condition timed out');
}

function environment(root) {
    return { ...process.env, TEMP: root, TMP: root, WEB_FETCHER_PROFILE_BASE_DIR: path.join(root, 'profile'), WEB_FETCHER_RUNTIME_STATE_FILE: path.join(root, 'runtime.json') };
}

async function connect(env, args = []) {
    const client = new Client({ name: 'runtime-lifecycle-fixture', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [...args, 'dist/index.js'], cwd: component, env, stderr: 'pipe' });
    transport.stderr?.resume();
    try { await client.connect(transport); return { client, transport }; }
    catch (error) { await transport.close().catch(() => {}); throw error; }
}

test('real stdio idle exit, read-only sleeping status and one-shot restart notice', { timeout: 120000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-fetcher-runtime-'));
    const env = environment(root);
    const clock = path.join(root, 'clock.mjs');
    const marker = path.join(root, 'advance');
    await fs.writeFile(clock, `import fs from 'node:fs';\nconst originalNow=Date.now.bind(Date);\nconst interval=globalThis.setInterval;\nDate.now=()=>originalNow()+(fs.existsSync(${JSON.stringify(marker)})?3601000:0);\nglobalThis.setInterval=(callback,delay,...args)=>interval(callback,delay===60000?100:delay,...args);\n`);
    const read = async () => JSON.parse(await fs.readFile(env.WEB_FETCHER_RUNTIME_STATE_FILE, 'utf8'));
    let first;
    let second;
    try {
        first = await connect(env, ['--import', pathToFileURL(clock).href]);
        const initial = await first.client.callTool({ name: 'web_list_sessions', arguments: { ownerId: 'runtime-fixture' } });
        assert.equal(initial._meta.webFetcherLifecycle.resumedFromIdle, false);
        assert.equal(initial._meta.webFetcherLifecycle.state, 'ready');
        await fs.writeFile(marker, 'advance isolated fixture clock');
        const sleeping = await until(read, value => value?.state === 'sleeping');
        assert.equal(sleeping.reason, 'idle-timeout');
        const saved = await fs.readFile(env.WEB_FETCHER_RUNTIME_STATE_FILE, 'utf8');
        const observed = JSON.parse(execFileSync(process.execPath, ['scripts/runtime-status.mjs'], { cwd: component, env, encoding: 'utf8', windowsHide: true }));
        assert.equal(observed.readOnly, true);
        assert.equal(observed.startsBackend, false);
        assert.equal(observed.snapshots[0].state, 'sleeping');
        assert.equal(await fs.readFile(env.WEB_FETCHER_RUNTIME_STATE_FILE, 'utf8'), saved);
        await first.client.close().catch(() => {});
        await first.transport.close().catch(() => {});
        await fs.unlink(marker);
        second = await connect(env);
        const results = await Promise.all([0, 1, 2].map(() => second.client.callTool({ name: 'web_list_sessions', arguments: { ownerId: 'runtime-fixture' } })));
        assert.equal(results.filter(value => value._meta.webFetcherLifecycle.resumedFromIdle).length, 1);
        assert.equal(results.filter(value => value.content.some(item => item.text?.includes('从空闲休眠自动唤醒'))).length, 1);
        for (const result of results) {
            assert.equal(result._meta.webFetcherLifecycle.previousExit.reason, 'idle-timeout');
            assert.equal(result._meta.webFetcherLifecycle.previousExit.pid, sleeping.pid);
            assert.ok(result._meta.webFetcherLifecycle.startupMs > 0);
            assert.ok(result._meta.webFetcherTiming);
            assert.ok(result._meta.webFetcherPool);
        }
        const resource = await second.client.readResource({ uri: 'web-fetcher://runtime' });
        assert.equal(JSON.parse(resource.contents[0].text).state, 'ready');
    } finally {
        for (const connection of [first, second]) {
            await connection?.client.close().catch(() => {});
            await connection?.transport.close().catch(() => {});
        }
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test('real startup failure records reason and keeps stdout protocol-safe', { timeout: 30000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-fetcher-runtime-fail-'));
    const env = environment(root);
    await fs.writeFile(path.join(root, 'mcp-web-fetcher'), 'directory collision fixture');
    let child;
    try {
        child = spawn(process.execPath, ['dist/index.js'], { cwd: component, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        const outcome = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
        assert.equal(outcome.code, 1);
        assert.equal(stdout, '');
        assert.ok(stderr.includes('启动失败'));
        const status = JSON.parse(await fs.readFile(env.WEB_FETCHER_RUNTIME_STATE_FILE, 'utf8'));
        assert.equal(status.state, 'startup-failed');
        assert.equal(status.reason, 'startup-error');
        assert.equal(status.startupMs, null);
    } finally {
        if (child && child.exitCode === null) child.kill();
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
