import assert from 'node:assert/strict';
import test from 'node:test';
import { PageAdmissionController } from '../src/page-admission.ts';

function fixture(options = {}, initial = {}) {
    let now = 100;
    let sample = { valid: true, mode: 'windows', sourceId: 'test', sequence: 1, sampledAt: now,
        physicalAvailableMB: 16000, commitAvailableMB: 32000, lowMemory: false, ...initial };
    const listeners = new Set();
    const memory = { snapshot: () => ({ ...sample }), subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
    const controller = new PageAdmissionController({ maxPages: 8, memoryProvider: memory, now: () => now, ...options });
    return { controller, memory,
        advance(amount) { now += amount; controller.refresh(); },
        sample(patch = {}) { sample = { ...sample, sequence: sample.sequence + 1, sampledAt: now, ...patch }; for (const listener of listeners) listener(); },
        listeners,
    };
}

test('20 simultaneous requests never reserve more than eight, including opening leases', async () => {
    const { controller } = fixture();
    try {
        const pending = Array.from({ length: 20 }, (_, index) => controller.acquire({ ownerId: `owner-${index % 3}` }));
        assert.equal(controller.stats().reserved, 8);
        assert.equal(controller.stats().queued, 12);
        const completed = [];
        pending.forEach(promise => promise.then(lease => completed.push(lease)));
        let released = 0;
        while (released < 20) {
            await Promise.resolve();
            const lease = completed[released++];
            assert.ok(lease);
            assert.ok(controller.stats().used <= 8);
            assert.equal(lease.release(), true);
        }
        await Promise.all(pending);
        assert.equal(controller.stats().used, 0);
        assert.equal(controller.stats().queued, 0);
    } finally { controller.dispose(); }
});

test('queued owners rotate while preserving their own FIFO order', async () => {
    const { controller } = fixture({ maxPages: 1 });
    const order = [];
    try {
        const holder = await controller.acquire({ ownerId: 'alpha' });
        const requests = ['alpha', 'alpha', 'beta', 'gamma', 'beta'].map((ownerId, index) => controller.acquire({ ownerId }).then(lease => {
            order.push(`${ownerId}-${index}`); lease.release();
        }));
        holder.release();
        await Promise.all(requests);
        assert.deepEqual(order, ['beta-2', 'gamma-3', 'alpha-0', 'beta-4', 'alpha-1']);
    } finally { controller.dispose(); }
});

test('same snapshot burst reserves memory once and a heavy owner does not block a fitting owner', async () => {
    const state = fixture({ estimatedMemoryMB: 256, minPhysicalMB: 1000, minCommitMB: 1000 }, { physicalAvailableMB: 1600 });
    const { controller } = state;
    try {
        const first = await controller.acquire({ ownerId: 'first' });
        const heavyAbort = new AbortController();
        const heavy = controller.acquire({ ownerId: 'heavy', estimatedMemoryMB: 512, signal: heavyAbort.signal });
        const heavyRejected = assert.rejects(heavy, error => error.code === 'page_admission_cancelled');
        const second = await controller.acquire({ ownerId: 'small', estimatedMemoryMB: 128 });
        assert.equal(controller.stats().uncoveredMemoryMB, 384);
        assert.equal(controller.stats().used, 2);
        assert.equal(controller.stats().queued, 1);
        heavyAbort.abort();
        await heavyRejected;
        first.release(); second.release();
    } finally { controller.dispose(); }
});

test('uncreated memory does not expire; ready requires the startup window and a later source sample', async () => {
    const state = fixture({ startupWindowMs: 5000 });
    const { controller } = state;
    try {
        const lease = await controller.acquire({ ownerId: 'late' });
        state.advance(60000); state.sample();
        assert.equal(controller.stats().uncoveredMemoryMB, 256);
        assert.equal(lease.markReady(), false);
        lease.markCreated(); lease.markReady();
        state.advance(4000); state.sample();
        assert.equal(controller.stats().uncoveredMemoryMB, 256);
        state.advance(1001);
        assert.equal(controller.stats().uncoveredMemoryMB, 256);
        state.sample();
        assert.equal(controller.stats().uncoveredMemoryMB, 0);
        assert.equal(controller.stats().active, 1);
        lease.release();
    } finally { controller.dispose(); }
});

test('same source sequence cannot retire an estimate even with an altered timestamp', async () => {
    const state = fixture({ startupWindowMs: 10 });
    try {
        const lease = await state.controller.acquire({ ownerId: 'test' });
        lease.markCreated(); lease.markReady();
        state.advance(20); state.sample({ sequence: 1 });
        assert.equal(state.controller.stats().uncoveredMemoryMB, 256);
        state.sample();
        assert.equal(state.controller.stats().uncoveredMemoryMB, 0);
        lease.release();
    } finally { state.controller.dispose(); }
});

test('closing and failed close keep a slot; release is idempotent and does not fabricate reclaimed RAM', async () => {
    const state = fixture({ maxPages: 1 });
    const { controller } = state;
    try {
        const lease = await controller.acquire({ ownerId: 'closing' });
        lease.markCreated(); lease.markClosing();
        assert.equal(controller.stats().closing, 1);
        const next = controller.acquire({ ownerId: 'next' });
        assert.equal(controller.stats().queued, 1);
        assert.equal(lease.release(), true);
        assert.equal(lease.release(), false);
        assert.equal(lease.markCreated(), false);
        const replacement = await next;
        assert.equal(controller.stats().uncoveredMemoryMB, 512);
        assert.equal(controller.stats().used, 1);
        state.advance(1); state.sample();
        assert.equal(controller.stats().uncoveredMemoryMB, 256);
        replacement.release();
    } finally { controller.dispose(); }
});

test('abort after grant and late creation do not release or reopen a closing lease', async () => {
    const { controller } = fixture({ maxPages: 1 });
    try {
        const abort = new AbortController();
        const granted = controller.acquire({ ownerId: 'slow-create', signal: abort.signal });
        abort.abort();
        const lease = await granted;
        lease.markClosing(); lease.markCreated();
        assert.equal(controller.stats().closing, 1);
        assert.equal(controller.stats().active, 0);
        assert.equal(lease.markReady(), false);
        const nextAbort = new AbortController();
        const next = controller.acquire({ ownerId: 'waiting', signal: nextAbort.signal });
        const rejected = assert.rejects(next, error => error.code === 'page_admission_cancelled');
        nextAbort.abort();
        await rejected;
        assert.equal(controller.stats().queued, 0);
        assert.equal(controller.stats().used, 1);
        lease.release();
    } finally { controller.dispose(); }
});

test('deadline is checked before grant even if its timer has not fired', async () => {
    const state = fixture({ maxPages: 1 });
    try {
        const holder = await state.controller.acquire({ ownerId: 'holder' });
        const expired = state.controller.acquire({ ownerId: 'late', deadlineAt: 110 });
        const rejected = assert.rejects(expired, error => error.code === 'page_admission_timeout' && error.admissionDecision.pageCreated === false);
        state.advance(11);
        holder.release();
        await rejected;
        assert.equal(state.controller.stats().used, 0);
    } finally { state.controller.dispose(); }
});

for (const [name, patch, expected] of [
    ['unknown', { valid: false, reason: 'notification_failure' }, 'memory_sample_unavailable'],
    ['stale', { sampledAt: -5000 }, 'memory_sample_stale_or_incomplete'],
    ['incomplete', { commitAvailableMB: undefined }, 'memory_sample_stale_or_incomplete'],
    ['low-memory', { lowMemory: true }, 'windows_low_memory'],
    ['physical', { physicalAvailableMB: 1100 }, 'physical_memory'],
    ['commit', { commitAvailableMB: 2200 }, 'commit_memory'],
]) {
    test(`${name} samples block and provide explicit bounded diagnostics`, async () => {
        const state = fixture({}, patch);
        try {
            const pending = state.controller.acquire({ ownerId: 'blocked', timeoutMs: 10 });
            const rejected = assert.rejects(pending, error => error.code === 'page_admission_timeout'
                && error.admissionDecision.blockedBy === expected && /mayHaveStarted=false/.test(error.message));
            state.advance(11);
            await rejected;
            assert.equal(state.controller.stats().used, 0);
        } finally { state.controller.dispose(); }
    });
}

test('failed sampling can recover via notification without restarting the controller', async () => {
    const state = fixture({}, { valid: false });
    try {
        const pending = state.controller.acquire({ ownerId: 'recovery' });
        assert.equal(state.controller.stats().queued, 1);
        state.sample({ valid: true });
        (await pending).release();
        assert.equal(state.controller.stats().queued, 0);
    } finally { state.controller.dispose(); }
});

test('queue overflow is immediate, cancellation removes listeners, and dispose leaves active slots owned', async () => {
    const state = fixture({ maxPages: 1, maxQueue: 1 });
    const { controller } = state;
    const holder = await controller.acquire({ ownerId: 'holder' });
    const abort = new AbortController();
    const queued = controller.acquire({ ownerId: 'queued', signal: abort.signal });
    const rejected = assert.rejects(queued, error => error.code === 'page_admission_closed');
    await assert.rejects(controller.acquire({ ownerId: 'overflow' }), error => error.code === 'page_admission_queue_full');
    controller.dispose(); controller.dispose(); abort.abort();
    await rejected;
    assert.equal(state.listeners.size, 0);
    assert.equal(controller.stats().used, 1);
    assert.equal(controller.stats().queued, 0);
    assert.equal(holder.release(), true);
    await assert.rejects(controller.acquire({ ownerId: 'closed' }), error => error.code === 'page_admission_closed');
});

test('unsupported platforms explicitly fall back to five slots, not fictitious complete memory data', async () => {
    const state = fixture({}, { mode: 'unsupported', valid: false });
    try {
        const leases = await Promise.all(Array.from({ length: 5 }, () => state.controller.acquire({ ownerId: 'portable' })));
        assert.equal(state.controller.stats().max, 5);
        assert.equal(state.controller.stats().memoryMode, 'page_limit_only');
        assert.ok(state.controller.stats().warning);
        assert.equal(state.controller.stats().uncoveredMemoryMB, 0);
        leases.forEach(lease => lease.release());
    } finally { state.controller.dispose(); }
});

test('explicit legacy configuration wins over the alias and absent configuration defaults to eight', () => {
    const legacy = process.env.WEB_FETCHER_MAX_CONCURRENT_PAGES;
    const alias = process.env.WEB_FETCHER_MAX_PAGES;
    const make = () => new PageAdmissionController({ memoryProvider: { snapshot: () => ({ mode: 'unsupported', valid: false }) } });
    try {
        process.env.WEB_FETCHER_MAX_CONCURRENT_PAGES = '5'; process.env.WEB_FETCHER_MAX_PAGES = '9';
        let controller = make(); assert.equal(controller.stats().configuredMax, 5); controller.dispose();
        delete process.env.WEB_FETCHER_MAX_CONCURRENT_PAGES;
        controller = make(); assert.equal(controller.stats().configuredMax, 9); controller.dispose();
        delete process.env.WEB_FETCHER_MAX_PAGES;
        controller = make(); assert.equal(controller.stats().configuredMax, 8); controller.dispose();
    } finally {
        if (legacy === undefined) delete process.env.WEB_FETCHER_MAX_CONCURRENT_PAGES; else process.env.WEB_FETCHER_MAX_CONCURRENT_PAGES = legacy;
        if (alias === undefined) delete process.env.WEB_FETCHER_MAX_PAGES; else process.env.WEB_FETCHER_MAX_PAGES = alias;
    }
});

test('real queue timeout settles without a sample event', async () => {
    const controller = new PageAdmissionController({ queueTimeoutMs: 20, memoryProvider: {
        snapshot: () => ({ valid: false, mode: 'windows', sourceId: 'failed', sequence: 0, sampledAt: -Infinity }),
    } });
    try {
        await assert.rejects(controller.acquire({ ownerId: 'timer' }), error => error.code === 'page_admission_timeout');
        assert.equal(controller.stats().queued, 0);
    } finally { controller.dispose(); }
});

test('already-cancelled, expired and disposed calls do not start a native sampler', async () => {
    let probes = 0;
    const controller = new PageAdmissionController({ now: () => 100, memoryProvider: {
        snapshot() { probes++; throw new Error('must not sample'); },
    } });
    const abort = new AbortController(); abort.abort();
    await assert.rejects(controller.acquire({ ownerId: 'cancelled', signal: abort.signal }), error => error.code === 'page_admission_cancelled');
    await assert.rejects(controller.acquire({ ownerId: 'expired', deadlineAt: 99 }), error => error.code === 'page_admission_timeout');
    controller.dispose();
    await assert.rejects(controller.acquire({ ownerId: 'closed' }), error => error.code === 'page_admission_closed');
    assert.equal(probes, 0);
});

test('short caller deadline wins over the controller queue timeout', async () => {
    const state = fixture({}, { valid: false });
    try {
        const pending = state.controller.acquire({ ownerId: 'short', deadlineAt: 105, timeoutMs: 1000 });
        const rejected = assert.rejects(pending, error => error.code === 'page_admission_timeout'
            && error.admissionDecision.queueWaitMs === 6);
        state.advance(6);
        await rejected;
    } finally { state.controller.dispose(); }
});

test('new source sample with unchanged RAM values retires ready startup debt but not page slots', async () => {
    const state = fixture({ startupWindowMs: 5 });
    try {
        const lease = await state.controller.acquire({ ownerId: 'steady' });
        lease.markCreated(); lease.markReady();
        state.advance(6); state.sample();
        assert.equal(state.controller.stats().uncoveredMemoryMB, 0);
        assert.equal(state.controller.stats().active, 1);
        const successor = await state.controller.acquire({ ownerId: 'steady' });
        assert.equal(state.controller.stats().uncoveredMemoryMB, 256);
        lease.release(); successor.release();
    } finally { state.controller.dispose(); }
});
