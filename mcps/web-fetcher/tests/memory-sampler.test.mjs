import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { MemorySampleDecoder, MemorySampler } from '../src/memory-sampler.ts';

function message(patch = {}) {
    return JSON.stringify({ sequence: 1, sourceMonotonicMs: 10000, sampledAtUnixMs: 100000,
        valid: true, physicalAvailableMB: 8000, commitAvailableMB: 16000,
        lowMemory: false, highMemory: true, ...patch });
}

function fakeChild() {
    const child = new EventEmitter();
    child.pid = 1234;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.killCount = 0;
    child.kill = () => { child.killCount++; queueMicrotask(() => child.emit('close', 0)); return true; };
    return child;
}

test('sample times preserve transport delay instead of timestamping receipt as fresh', () => {
    const decoder = new MemorySampleDecoder('source');
    const sample = decoder.decode(message(), 10000, 105000);
    assert.equal(sample.valid, true);
    assert.equal(sample.sampledAt, 5000);
    assert.equal(sample.sequence, 1);
});

test('monotonic source clock prevents buffered or reordered samples from becoming fresh', () => {
    const decoder = new MemorySampleDecoder('source');
    decoder.decode(message(), 5000, 100000);
    const buffered = decoder.decode(message({ sequence: 2, sourceMonotonicMs: 10500, sampledAtUnixMs: 100500 }), 15000, 110000);
    assert.equal(buffered.sampledAt, 5500);
    assert.equal(decoder.decode(message({ sequence: 2 }), 16000, 110001).valid, false);
    assert.equal(decoder.decode(message({ sequence: 3, sourceMonotonicMs: 10001 }), 16000, 110002).valid, false);
});

test('invalid, incomplete, notification-failed and malformed samples are never valid', () => {
    for (const patch of [
        { valid: false, reason: 'QueryMemoryResourceNotification_failed' },
        { highMemory: null }, { lowMemory: null }, { commitAvailableMB: null },
        { physicalAvailableMB: -1 }, { sequence: null }, { sourceMonotonicMs: null },
    ]) {
        const decoder = new MemorySampleDecoder('source');
        assert.equal(decoder.decode(message(patch), 5000, 100000).valid, false);
    }
    const decoder = new MemorySampleDecoder('source');
    for (const invalid of ['{', 'null', '42', '[]']) assert.equal(decoder.decode(invalid).valid, false);
});

test('future wall-clock samples fail closed', () => {
    assert.equal(new MemorySampleDecoder('source').decode(message(), 1000, 90000).reason, 'sample_clock_mismatch');
});

test('one lazy hidden process is reused, publishes source samples and closes idempotently', async () => {
    const child = fakeChild();
    const calls = [];
    const sampler = new MemorySampler({ platform: 'win32', spawnProcess: (...args) => { calls.push(args); return child; } });
    let updates = 0;
    const unsubscribe = sampler.subscribe(() => updates++);
    assert.equal(calls.length, 0);
    for (let index = 0; index < 20; index++) sampler.snapshot();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2].windowsHide, true);
    assert.ok(calls[0][1].includes('Hidden'));
    assert.equal(sampler.snapshot().valid, false);
    const line = message({ sampledAtUnixMs: Date.now() });
    child.stdout.write(line.slice(0, 20)); child.stdout.write(line.slice(20) + '\n');
    assert.equal(sampler.snapshot().valid, true);
    assert.equal(updates, 1);
    unsubscribe();
    await Promise.all([sampler.close(), sampler.close()]);
    assert.equal(child.killCount, 1);
    assert.equal(sampler.snapshot().reason, 'sampler_closed');
    assert.equal(calls.length, 1);
});

test('failed process invalidates the sample and repeated reads do not cause a spawn storm', async () => {
    const child = fakeChild();
    let starts = 0;
    const sampler = new MemorySampler({ platform: 'win32', restartDelayMs: 60000, spawnProcess: () => { starts++; return child; } });
    sampler.snapshot();
    child.stdout.write(message({ sampledAtUnixMs: Date.now() }) + '\n');
    assert.equal(sampler.snapshot().valid, true);
    child.emit('error', new Error('failure')); child.emit('close', 1);
    for (let index = 0; index < 20; index++) assert.equal(sampler.snapshot().valid, false);
    assert.equal(starts, 1);
    await sampler.close();
});

test('helper process and output pipes do not keep an otherwise idle owner alive', async () => {
    const child = fakeChild();
    const released = [];
    child.unref = () => released.push('process');
    child.stdout.unref = () => released.push('stdout');
    child.stderr.unref = () => released.push('stderr');
    const sampler = new MemorySampler({ platform: 'win32', spawnProcess: () => child });
    sampler.snapshot();
    assert.deepEqual(released, ['process', 'stdout', 'stderr']);
    await sampler.close();
    assert.equal(child.killCount, 1);
});

test('synchronous spawn failure is visible and backoff prevents spawning on every request', async () => {
    let attempts = 0;
    const sampler = new MemorySampler({ platform: 'win32', spawnProcess() { attempts++; throw new Error('spawn unavailable'); } });
    for (let index = 0; index < 10; index++) assert.equal(sampler.snapshot().reason, 'sampler_spawn_failed');
    assert.equal(attempts, 1);
    await sampler.close();
});

test('unsupported platforms return an explicit incomplete mode and start no helper', async () => {
    const sampler = new MemorySampler({ platform: 'linux', spawnProcess: () => { throw new Error('must not spawn'); } });
    assert.deepEqual(sampler.snapshot(), {
        valid: false, mode: 'unsupported', sourceId: 'sampler-0', sequence: 0,
        sampledAt: -Infinity, reason: 'unsupported_platform_page_limit_only',
    });
    await sampler.close();
});

test('oversized helper output fails closed and recovers on the next complete line', async () => {
    const child = fakeChild();
    const sampler = new MemorySampler({ platform: 'win32', spawnProcess: () => child });
    sampler.snapshot();
    child.stdout.write('x'.repeat(65537));
    assert.equal(sampler.snapshot().reason, 'sample_buffer_overflow');
    child.stdout.write(message({ sampledAtUnixMs: Date.now() }) + '\n');
    assert.equal(sampler.snapshot().valid, true);
    await sampler.close();
});

test('real Windows sampler provides complete increasing source samples and confirms shutdown', {
    skip: process.platform !== 'win32' || process.env.WEB_FETCHER_TEST_MEMORY_SAMPLER !== '1',
    timeout: 20000,
}, async () => {
    const sampler = new MemorySampler({ intervalMs: 250 });
    try {
        const deadline = performance.now() + 12000;
        let first;
        let second;
        while (performance.now() < deadline) {
            const sample = sampler.snapshot();
            if (sample.valid && !first) first = sample;
            else if (sample.valid && sample.sequence > first?.sequence) { second = sample; break; }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(first?.valid, JSON.stringify(sampler.snapshot()));
        assert.ok(second?.valid, 'Expected a second native source sample');
        assert.ok(second.sampledAt > first.sampledAt);
        assert.ok(second.physicalAvailableMB > 0);
        assert.ok(second.commitAvailableMB >= 0);
        assert.ok(performance.now() - second.sampledAt < 2000);
    } finally { await sampler.close(); }
    assert.equal(sampler.snapshot().valid, false);
});

test('native sampler exits when its monitored parent exits, without an application exit handler', {
    skip: process.platform !== 'win32' || process.env.WEB_FETCHER_TEST_MEMORY_SAMPLER !== '1',
    timeout: 20000,
}, async () => {
    const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    const parentClosed = new Promise(resolve => parent.once('close', resolve));
    let helper;
    let helperClosed;
    let helperExited = false;
    let data = '';
    try {
        assert.ok(parent.pid);
        helper = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
            '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../native/memory-sampler.ps1', import.meta.url)),
            '-ParentProcessId', String(parent.pid), '-IntervalMs', '250'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        helperClosed = new Promise(resolve => helper.once('close', code => { helperExited = true; resolve(code); }));
        helper.stdout.setEncoding('utf8'); helper.stdout.on('data', chunk => { data += chunk; });
        helper.stderr.resume();
        const startDeadline = performance.now() + 10000;
        while (!data.includes('\n') && !helperExited && performance.now() < startDeadline) await new Promise(resolve => setTimeout(resolve, 50));
        assert.ok(data.includes('\n'), 'Native sampler must have started before parent exit');
        parent.kill(); await parentClosed;
        const exitDeadline = performance.now() + 3000;
        while (!helperExited && performance.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(helperExited, true, 'Native sampler must self-terminate after its parent exits');
    } finally {
        if (!parent.killed) parent.kill();
        await parentClosed;
        if (helper && !helperExited) helper.kill();
        if (helperClosed) await helperClosed;
    }
});
