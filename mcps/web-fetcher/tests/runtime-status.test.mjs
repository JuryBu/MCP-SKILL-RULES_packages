import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    IDLE_EXIT_TIMEOUT_MS,
    RuntimeLifecycle,
    isProcessAlive,
    readRuntimeState,
    shouldExitForIdle,
} from '../src/runtime-status.ts';

const startedAtMs = Date.parse('2026-01-01T00:00:00.000Z');
const parentPid = 650001;
const instancePid = 650002;
const noticePattern = /从空闲休眠自动唤醒/;

function savedSnapshot(overrides = {}) {
    return {
        schemaVersion: 1,
        instanceId: 'previous-instance',
        state: 'sleeping',
        reason: 'idle-timeout',
        pid: instancePid + 10,
        parentPid,
        startedAt: new Date(startedAtMs - 2000).toISOString(),
        updatedAt: new Date(startedAtMs - 1000).toISOString(),
        startupMs: 25,
        previousExit: null,
        ...overrides,
    };
}

function fixture(context, seed) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'web-fetcher-runtime-status-test-'));
    context.after(() => {
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('web-fetcher-runtime-status-test-'));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const stateFile = path.join(directory, 'state.json');
    if (seed !== undefined) fs.writeFileSync(stateFile, typeof seed === 'string' ? seed : JSON.stringify(seed));
    const clock = { value: startedAtMs };
    const create = (options = {}) => new RuntimeLifecycle(stateFile, {
        pid: instancePid,
        parentPid,
        startedAtMs,
        now: () => clock.value,
        alive: () => false,
        ...options,
    });
    return { directory, stateFile, clock, create };
}

function successResult() {
    return {
        content: [
            { type: 'text', text: 'original tool text' },
            { type: 'image', mimeType: 'image/png', data: 'original-image-bytes' },
        ],
        _meta: { webFetcherPool: { activePages: 1 }, caller: 'fixture' },
        structuredContent: { value: 42 },
    };
}

function wakeNoticeCount(result) {
    return result.content.filter(item => item.type === 'text' && noticePattern.test(item.text)).length;
}

test('cold construction persists starting, ready records elapsed startup, and status is a copy', context => {
    const { stateFile, clock, create } = fixture(context);
    const lifecycle = create();
    assert.equal(lifecycle.status().state, 'starting');
    assert.equal(readRuntimeState(stateFile).state, 'starting');
    assert.equal(lifecycle.status().previousExit, null);
    clock.value += 175;
    lifecycle.ready();
    assert.equal(lifecycle.status().state, 'ready');
    assert.equal(lifecycle.status().startupMs, 175);
    assert.equal(readRuntimeState(stateFile).startupMs, 175);
    const status = lifecycle.status();
    status.state = 'sleeping';
    assert.equal(lifecycle.status().state, 'ready');
    assert.equal(wakeNoticeCount(lifecycle.decorate(successResult())), 0);
});

for (const [reason, expectedState] of [
    ['idle-timeout', 'sleeping'],
    ['startup-error', 'startup-failed'],
    ['stdin-end', 'stopped'],
    ['stdin-close', 'stopped'],
    ['stdin-error', 'stopped'],
    ['parent-exit', 'stopped'],
    ['duplicate-retirement', 'stopped'],
    ['signal-int', 'stopped'],
    ['signal-term', 'stopped'],
    ['unknown', 'stopped'],
]) {
    test(`exit ${reason} records ${expectedState} with the exact reason`, context => {
        const { stateFile, create } = fixture(context);
        const lifecycle = create();
        lifecycle.ready();
        lifecycle.exit(reason);
        assert.equal(lifecycle.status().state, expectedState);
        assert.equal(lifecycle.status().reason, reason);
        assert.equal(readRuntimeState(stateFile).state, expectedState);
        assert.equal(readRuntimeState(stateFile).reason, reason);
    });
}

for (const [state, reason, expectedReason, expectedNotice] of [
    ['sleeping', 'idle-timeout', 'idle-timeout', 1],
    ['startup-failed', 'startup-error', 'startup-error', 0],
    ['stopped', 'signal-term', 'signal-term', 0],
    ['stopped', 'unknown', 'unknown', 0],
    ['starting', 'startup', 'unknown', 0],
    ['ready', 'startup', 'unknown', 0],
]) {
    test(`restart from dead ${state}/${reason} preserves an honest previous exit`, context => {
        const { create } = fixture(context, savedSnapshot({ state, reason }));
        const lifecycle = create();
        lifecycle.ready();
        assert.equal(lifecycle.status().previousExit.reason, expectedReason);
        if (expectedReason === 'unknown' && state !== 'stopped') assert.equal(lifecycle.status().previousExit.at, null);
        assert.equal(wakeNoticeCount(lifecycle.decorate(successResult())), expectedNotice);
        const status = lifecycle.status();
        status.previousExit.reason = 'stdin-error';
        assert.equal(lifecycle.status().previousExit.reason, expectedReason);
    });
}

test('a different parent cannot inherit the previous parents idle wake notice', context => {
    const { create } = fixture(context, savedSnapshot({ parentPid: parentPid + 1 }));
    const lifecycle = create();
    lifecycle.ready();
    assert.equal(lifecycle.status().previousExit, null);
    assert.equal(wakeNoticeCount(lifecycle.decorate(successResult())), 0);
});

test('a live previous ready instance is not reported as an unobserved exit or overwritten', context => {
    const seed = savedSnapshot({ state: 'ready', reason: 'startup' });
    const { stateFile, create } = fixture(context, seed);
    const lifecycle = create({ alive: observedPid => observedPid === seed.pid });
    lifecycle.ready();
    assert.equal(lifecycle.status().previousExit, null);
    assert.equal(lifecycle.status().persistence, 'other-instance');
    assert.deepEqual(readRuntimeState(stateFile), seed);
    assert.equal(wakeNoticeCount(lifecycle.decorate(successResult())), 0);
});

test('unknown, missing, and corrupt state files allow cold startup without claiming idle wake', async context => {
    for (const seed of [undefined, '', '{broken', 'null', '[]']) {
        await context.test(`seed ${String(seed)}`, subcontext => {
            const { create } = fixture(subcontext, seed);
            const lifecycle = create();
            lifecycle.ready();
            assert.equal(lifecycle.status().previousExit, null);
            assert.equal(wakeNoticeCount(lifecycle.decorate(successResult())), 0);
        });
    }
});

test('small-file validation rejects malformed fields and accepts the exact 8192 byte boundary', async context => {
    const invalidFields = [
        { schemaVersion: 2 },
        { instanceId: 'x'.repeat(65) },
        { state: 'unknown' },
        { reason: 'crashed' },
        { pid: 0 },
        { parentPid: 0 },
        { startedAt: 'invalid-date' },
        { updatedAt: 'invalid-date' },
        { startupMs: -1 },
        { previousExit: { reason: 'crashed', at: null, pid: 1 } },
        { previousExit: { reason: 'unknown', at: 'invalid-date', pid: 1 } },
    ];
    for (const fields of invalidFields) {
        await context.test(JSON.stringify(fields), subcontext => {
            const { stateFile } = fixture(subcontext, savedSnapshot(fields));
            assert.equal(readRuntimeState(stateFile), null);
        });
    }
    const seed = savedSnapshot();
    const { stateFile } = fixture(context);
    const serialized = JSON.stringify(seed);
    fs.writeFileSync(stateFile, serialized + ' '.repeat(8192 - Buffer.byteLength(serialized)));
    assert.equal(fs.statSync(stateFile).size, 8192);
    assert.deepEqual(readRuntimeState(stateFile), seed);
    fs.appendFileSync(stateFile, ' ');
    assert.equal(readRuntimeState(stateFile), null);
});

test('invalid timestamp types and nonpositive previous PIDs are rejected as corrupt state', async context => {
    for (const fields of [
        { startedAt: 1 },
        { updatedAt: 1 },
        { previousExit: { reason: 'unknown', at: null, pid: 0 } },
        { previousExit: { reason: 'unknown', at: null, pid: -1 } },
        { previousExit: { reason: 'unknown', at: 1, pid: 1 } },
    ]) {
        await context.test(JSON.stringify(fields), subcontext => {
            const { stateFile } = fixture(subcontext, savedSnapshot(fields));
            assert.equal(readRuntimeState(stateFile), null);
        });
    }
});

test('inconsistent state and reason pairs cannot manufacture an idle wake', async context => {
    for (const [state, reason] of [
        ['sleeping', 'unknown'],
        ['startup-failed', 'idle-timeout'],
        ['stopped', 'idle-timeout'],
    ]) {
        await context.test(`${state}/${reason}`, subcontext => {
            const { stateFile, create } = fixture(subcontext, savedSnapshot({ state, reason }));
            const restored = readRuntimeState(stateFile);
            const lifecycle = create();
            lifecycle.ready();
            assert.equal(wakeNoticeCount(lifecycle.decorate(successResult())), 0);
            assert.equal(restored, null);
        });
    }
});

test('idle exit retains the strict one-hour boundary and active-request exclusion', () => {
    assert.equal(IDLE_EXIT_TIMEOUT_MS, 3_600_000);
    for (const idleMs of [-1, 0, IDLE_EXIT_TIMEOUT_MS - 1, IDLE_EXIT_TIMEOUT_MS]) {
        assert.equal(shouldExitForIdle(idleMs, 0), false);
    }
    assert.equal(shouldExitForIdle(IDLE_EXIT_TIMEOUT_MS + 1, 0), true);
    for (const activeRequests of [1, 2, 100]) {
        assert.equal(shouldExitForIdle(IDLE_EXIT_TIMEOUT_MS + 1, activeRequests), false);
    }
});

test('wake decoration preserves text/image order, metadata, structured content, and immutable input', context => {
    const { create, clock } = fixture(context, savedSnapshot());
    const lifecycle = create();
    clock.value += 175;
    lifecycle.ready();
    const original = successResult();
    const before = structuredClone(original);
    Object.freeze(original.content);
    Object.freeze(original._meta);
    Object.freeze(original);
    const decorated = lifecycle.decorate(original);
    assert.deepEqual(original, before);
    assert.deepEqual(decorated.content.slice(0, 2), before.content);
    assert.equal(decorated.content[1], original.content[1]);
    assert.equal(decorated.content.length, 3);
    assert.match(decorated.content[2].text, /175 ms/);
    assert.deepEqual(decorated.structuredContent, before.structuredContent);
    assert.deepEqual(decorated._meta.webFetcherPool, before._meta.webFetcherPool);
    assert.equal(decorated._meta.caller, 'fixture');
    assert.equal(decorated._meta.webFetcherLifecycle.resumedFromIdle, true);
    const second = lifecycle.decorate(successResult());
    assert.equal(wakeNoticeCount(second), 0);
    assert.equal(second._meta.webFetcherLifecycle.resumedFromIdle, false);
});

test('error and non-content results do not consume the first successful wake feedback', context => {
    const { create } = fixture(context, savedSnapshot());
    const lifecycle = create();
    lifecycle.ready();
    for (let index = 0; index < 3; index++) {
        const error = { ...successResult(), isError: true };
        const decorated = lifecycle.decorate(error);
        assert.equal(decorated.isError, true);
        assert.equal(decorated.content, error.content);
        assert.equal(decorated._meta.webFetcherLifecycle.resumedFromIdle, false);
    }
    lifecycle.decorate({ structuredContent: { pending: true } });
    for (const value of [null, undefined, false, 0, 'unchanged']) assert.equal(lifecycle.decorate(value), value);
    assert.equal(wakeNoticeCount(lifecycle.decorate(successResult())), 1);
    assert.equal(wakeNoticeCount(lifecycle.decorate(successResult())), 0);
});

test('concurrent successful completions append exactly one wake notice', async context => {
    const { create } = fixture(context, savedSnapshot());
    const lifecycle = create();
    lifecycle.ready();
    const results = await Promise.all(Array.from({ length: 32 }, () => Promise.resolve().then(() => lifecycle.decorate(successResult()))));
    assert.equal(results.reduce((total, result) => total + wakeNoticeCount(result), 0), 1);
    assert.equal(results.filter(result => result._meta.webFetcherLifecycle.resumedFromIdle).length, 1);
    for (const result of results) assert.deepEqual(result.content.slice(0, 2), successResult().content);
});

test('unwritable parent and rename failure keep tool results available and remove temporary files', async context => {
    for (const failure of ['parent-is-file', 'target-is-directory']) {
        await context.test(failure, subcontext => {
            const { directory } = fixture(subcontext);
            const target = path.join(directory, 'blocked');
            if (failure === 'parent-is-file') fs.writeFileSync(target, 'occupied');
            else fs.mkdirSync(target);
            const stateFile = failure === 'parent-is-file' ? path.join(target, 'state.json') : target;
            const lifecycle = new RuntimeLifecycle(stateFile, { pid: instancePid, parentPid, startedAtMs, now: () => startedAtMs, alive: () => false });
            assert.equal(lifecycle.status().persistence, 'unavailable');
            lifecycle.ready();
            assert.equal(lifecycle.status().state, 'ready');
            assert.deepEqual(lifecycle.decorate(successResult()).content, successResult().content);
            lifecycle.exit('idle-timeout');
            assert.equal(lifecycle.status().state, 'sleeping');
            assert.equal(lifecycle.status().persistence, 'unavailable');
            assert.deepEqual(fs.readdirSync(directory), ['blocked']);
        });
    }
});

test('an older instance is fenced after ownership loss even after the newer instance exits', context => {
    const { stateFile, clock, create } = fixture(context);
    const newerPid = instancePid + 1;
    const livePids = new Set([instancePid, newerPid]);
    const alive = observedPid => livePids.has(observedPid);
    const older = create({ alive });
    older.ready();
    assert.equal(older.status().persistence, 'saved');
    older.exit('duplicate-retirement');
    clock.value += 1000;
    const newer = create({ alive, pid: newerPid, startedAtMs: clock.value });
    newer.ready();
    older.exit('signal-int');
    assert.equal(older.status().persistence, 'other-instance');
    assert.equal(readRuntimeState(stateFile).instanceId, newer.status().instanceId);
    newer.exit('signal-term');
    livePids.delete(newerPid);
    const finalRecord = fs.readFileSync(stateFile, 'utf8');
    clock.value += 1000;
    older.exit('parent-exit');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), finalRecord);
    assert.equal(older.status().persistence, 'other-instance');
    assert.equal(readRuntimeState(stateFile).reason, 'signal-term');
    fs.unlinkSync(stateFile);
    older.ready();
    assert.equal(fs.existsSync(stateFile), false);
    fs.writeFileSync(stateFile, '{broken');
    older.exit('stdin-close');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), '{broken');
});

test('a late old exit cannot replace a newer terminal record before noticing ownership loss', context => {
    const { stateFile, clock, create } = fixture(context);
    const newerPid = instancePid + 1;
    const livePids = new Set([instancePid, newerPid]);
    const alive = observedPid => livePids.has(observedPid);
    const older = create({ alive });
    older.ready();
    older.exit('duplicate-retirement');
    clock.value += 1000;
    const newer = create({ alive, pid: newerPid, startedAtMs: clock.value });
    newer.ready();
    newer.exit('idle-timeout');
    livePids.delete(newerPid);
    const finalRecord = fs.readFileSync(stateFile, 'utf8');
    older.exit('parent-exit');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), finalRecord);
    assert.equal(readRuntimeState(stateFile).reason, 'idle-timeout');
});

test('recovering an initially unwritable old instance cannot overwrite a newer terminal record', context => {
    const { directory, clock } = fixture(context);
    const blockedParent = path.join(directory, 'blocked-parent');
    const stateFile = path.join(blockedParent, 'state.json');
    fs.writeFileSync(blockedParent, 'occupied');
    const newerPid = instancePid + 1;
    const livePids = new Set([instancePid, newerPid]);
    const options = {
        pid: instancePid,
        parentPid,
        startedAtMs,
        now: () => clock.value,
        alive: observedPid => livePids.has(observedPid),
    };
    const older = new RuntimeLifecycle(stateFile, options);
    older.ready();
    assert.equal(older.status().persistence, 'unavailable');
    fs.unlinkSync(blockedParent);
    clock.value += 1000;
    const newer = new RuntimeLifecycle(stateFile, { ...options, pid: newerPid, startedAtMs: clock.value });
    newer.ready();
    newer.exit('idle-timeout');
    livePids.delete(newerPid);
    const finalRecord = fs.readFileSync(stateFile, 'utf8');
    older.exit('parent-exit');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), finalRecord);
});

test('a superseded idle successor cannot announce a wake on its first successful result', context => {
    const { stateFile, clock, create } = fixture(context, savedSnapshot());
    const newerPid = instancePid + 1;
    const livePids = new Set([instancePid, newerPid]);
    const alive = observedPid => livePids.has(observedPid);
    const older = create({ alive });
    older.ready();
    assert.equal(older.status().previousExit.reason, 'idle-timeout');
    older.exit('duplicate-retirement');
    clock.value += 1000;
    const newer = create({ alive, pid: newerPid, startedAtMs: clock.value });
    newer.ready();
    older.exit('parent-exit');
    assert.equal(older.status().persistence, 'other-instance');
    const finalRecord = fs.readFileSync(stateFile, 'utf8');
    const result = older.decorate(successResult());
    assert.equal(wakeNoticeCount(result), 0);
    assert.equal(result._meta.webFetcherLifecycle.resumedFromIdle, false);
    assert.deepEqual(result.content, successResult().content);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), finalRecord);
});

test('process liveness rejects invalid PIDs and observes the current test process', () => {
    for (const invalidPid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(isProcessAlive(invalidPid), false);
    assert.equal(isProcessAlive(process.pid), true);
});

function runSourceStatusCli(stateFile) {
    const scriptUrl = new URL('../scripts/runtime-status.mjs', import.meta.url).href;
    const sourceUrl = new URL('../src/runtime-status.ts', import.meta.url).href;
    const loader = `export async function resolve(specifier, context, nextResolve) {
        if (specifier === '../dist/runtime-status.js' && context.parentURL === ${JSON.stringify(scriptUrl)}) return nextResolve(${JSON.stringify(sourceUrl)}, context);
        if (/(?:^|\\/)(?:index|browser)\\.(?:js|ts)$/.test(specifier)) throw new Error('read-only status imported backend: ' + specifier);
        return nextResolve(specifier, context);
    }`;
    const bootstrap = `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url); await import(${JSON.stringify(scriptUrl)});`;
    return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', bootstrap], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, WEB_FETCHER_RUNTIME_STATE_FILE: stateFile },
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
    }));
}

test('status CLI source remains read-only for missing, dead-ready, sleeping, failed, and live records', async context => {
    for (const [name, seed, expectedState, expectedReason] of [
        ['missing', undefined, 'unknown', 'missing-or-invalid'],
        ['dead-ready', savedSnapshot({ pid: 2147483647, state: 'ready', reason: 'startup' }), 'unknown', 'unobserved-exit'],
        ['sleeping', savedSnapshot({ pid: 2147483647 }), 'sleeping', 'idle-timeout'],
        ['startup-failed', savedSnapshot({ pid: 2147483647, state: 'startup-failed', reason: 'startup-error' }), 'startup-failed', 'startup-error'],
        ['live', savedSnapshot({ pid: process.pid, state: 'ready', reason: 'startup' }), 'ready', 'startup'],
    ]) {
        await context.test(name, subcontext => {
            const { directory, stateFile } = fixture(subcontext, seed);
            const before = seed === undefined ? null : fs.readFileSync(stateFile, 'utf8');
            const filesBefore = fs.readdirSync(directory);
            const output = runSourceStatusCli(stateFile);
            assert.equal(output.readOnly, true);
            assert.equal(output.startsBackend, false);
            assert.equal(output.snapshots.length, 1);
            assert.equal(output.snapshots[0].state, expectedState);
            assert.equal(output.snapshots[0].reason, expectedReason);
            assert.deepEqual(fs.readdirSync(directory), filesBefore);
            if (before !== null) assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
            else assert.equal(fs.existsSync(stateFile), false);
        });
    }
});

test('built npm runtime status entry reads an isolated record without changing it or starting a backend', {
    skip: !fs.existsSync(new URL('../dist/runtime-status.js', import.meta.url)),
}, context => {
    const { directory, stateFile } = fixture(context, savedSnapshot({ pid: 2147483647 }));
    const before = fs.readFileSync(stateFile, 'utf8');
    const beforeModified = fs.statSync(stateFile).mtimeMs;
    const output = JSON.parse(execSync('npm run --silent runtime:status', {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, WEB_FETCHER_RUNTIME_STATE_FILE: stateFile },
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
    }));
    assert.equal(output.readOnly, true);
    assert.equal(output.startsBackend, false);
    assert.equal(output.snapshots.length, 1);
    assert.equal(output.snapshots[0].state, 'sleeping');
    assert.equal(output.snapshots[0].reason, 'idle-timeout');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
    assert.equal(fs.statSync(stateFile).mtimeMs, beforeModified);
    assert.deepEqual(fs.readdirSync(directory), ['state.json']);
});

test('both registration adapters preserve schemas, errors, timing metadata, and image results', async context => {
    const { stateFile } = fixture(context, savedSnapshot({ parentPid: process.ppid, pid: 2147483647 }));
    const runtime = await import('../src/runtime-status.ts');
    const previousFile = process.env.WEB_FETCHER_RUNTIME_STATE_FILE;
    let lifecycle;
    try {
        process.env.WEB_FETCHER_RUNTIME_STATE_FILE = stateFile;
        lifecycle = runtime.initializeRuntimeLifecycle();
    } finally {
        if (previousFile === undefined) delete process.env.WEB_FETCHER_RUNTIME_STATE_FILE;
        else process.env.WEB_FETCHER_RUNTIME_STATE_FILE = previousFile;
    }
    lifecycle.ready();
    const { installToolConcurrency } = await import('../src/tool-concurrency.ts');
    const { sessionManager } = await import('../src/session.ts');
    const { z } = await import('zod');
    context.after(() => sessionManager.closeAll());
    const registered = new Map();
    const server = {
        registerTool(name, config, handler) { registered.set(name, { config, handler }); },
        tool(name, description, schema, handler) { registered.set(name, { description, schema, handler }); },
    };
    const controller = installToolConcurrency(server);
    assert.equal(installToolConcurrency(server), controller);
    const urlSchema = z.string().optional();
    const inputSchema = { url: urlSchema };
    const config = { title: 'fixture', inputSchema };
    server.registerTool('fixture_modern', config, async args => ({ ...successResult(), ...(args.fail ? { isError: true } : {}) }));
    server.tool('fixture_legacy', 'legacy description', inputSchema, async () => successResult());
    server.registerTool('fixture_throw', { inputSchema }, async () => { throw new Error('fixture handler error'); });
    assert.deepEqual(Object.keys(inputSchema), ['url']);
    assert.equal(registered.get('fixture_modern').config.inputSchema.url, urlSchema);
    assert.equal(registered.get('fixture_legacy').schema.url, urlSchema);
    assert.equal(registered.get('fixture_legacy').description, 'legacy description');
    assert.equal(config.inputSchema, inputSchema);
    await assert.rejects(registered.get('fixture_throw').handler({}), /fixture handler error/);
    const failed = await registered.get('fixture_modern').handler({ fail: true });
    assert.equal(failed.isError, true);
    assert.equal(wakeNoticeCount(failed), 0);
    assert.deepEqual(failed.content, successResult().content);
    lifecycle.status();
    const firstSuccess = await registered.get('fixture_legacy').handler({});
    assert.equal(wakeNoticeCount(firstSuccess), 1);
    assert.deepEqual(firstSuccess.content.slice(0, 2), successResult().content);
    assert.deepEqual(firstSuccess._meta.webFetcherPool, successResult()._meta.webFetcherPool);
    assert.ok(firstSuccess._meta.webFetcherTiming);
    assert.equal(firstSuccess._meta.webFetcherLifecycle.resumedFromIdle, true);
    const secondSuccess = await registered.get('fixture_modern').handler({});
    assert.equal(wakeNoticeCount(secondSuccess), 0);
    assert.deepEqual(secondSuccess.content, successResult().content);
});
