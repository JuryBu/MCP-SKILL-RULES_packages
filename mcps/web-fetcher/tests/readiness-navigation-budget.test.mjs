import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { getPageReadiness, waitForPageReadiness } from '../src/readiness.ts';
import { getRequestContext, runWithRequestContext } from '../src/request-context.ts';

function readySnapshot(documentVersion, overrides = {}) {
    return {
        total: 1, ready: 1, failed: 0, pending: 0, fontsReady: true,
        scanLimited: false, meaningful: true, uninspectedFrames: 0,
        primaryBusy: false, emptyRoot: false, documentVersion, documentAgeMs: 10_000,
        signature: 'document-' + documentVersion,
        ...overrides,
    };
}

function makeFixture(hooks = {}) {
    const page = new EventEmitter();
    const mainFrame = {};
    const pending = [];
    const state = { closed: false, primes: 0, lazyReads: 0, restores: 0, samples: [], events: [] };
    const hold = () => new Promise(resolve => pending.push(resolve));
    const record = (kind, extra = {}) => state.events.push({ kind, at: performance.now(), prime: state.primes, ...extra });
    Object.assign(page, {
        url: () => 'http://readiness-budget.test/page',
        mainFrame: () => mainFrame,
        isClosed: () => state.closed,
        waitForLoadState: async () => {},
    });
    page.evaluate = async (callback, argument) => {
        if (argument && typeof argument.visual === 'boolean') {
            const snapshot = hooks.sample?.(state) ?? readySnapshot(1);
            state.samples.push({ at: performance.now(), ...snapshot });
            record('sample', { documentVersion: snapshot.documentVersion });
            return snapshot;
        }
        if (String(callback).includes('scrollX')) {
            state.primes++;
            record('original');
            return { x: 0, y: 120, height: 720, documentVersion: hooks.documentVersion?.(state) ?? 1 };
        }
        if (typeof argument === 'number') {
            state.lazyReads++;
            record('lazy');
            return hooks.lazy?.({ page, state, hold, argument }) ?? {
                bottom: 720, height: 720, documentVersion: hooks.documentVersion?.(state) ?? 1,
            };
        }
        if (argument && typeof argument.documentVersion === 'number') {
            state.restores++;
            record('restore', { documentVersion: argument.documentVersion });
            return hooks.restore?.({ page, state, hold, argument });
        }
        throw new Error('Unexpected readiness evaluation: ' + String(callback).slice(0, 100));
    };
    return {
        page, state,
        async cleanup() {
            for (const resolve of pending.splice(0)) resolve();
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(page.listenerCount('framenavigated'), 0);
        },
    };
}

const visualOptions = maxWait => ({ mode: 'visual', fullPage: true, maxWait, minimumObserveMs: 0, quietMs: 0 });

test('short first-prime budget does not start a restoration when no scroll ran', { timeout: 5000 }, async () => {
    const fixture = makeFixture({ restore: ({ hold }) => hold() });
    const started = performance.now();
    try {
        const result = await waitForPageReadiness(fixture.page, visualOptions(90));
        assert.equal(fixture.state.primes, 1);
        assert.equal(fixture.state.lazyReads, 0);
        assert.equal(fixture.state.restores, 0);
        assert.equal(result.complete, false);
        assert.match(result.note, /懒加载遍历未完成/);
        assert.ok(performance.now() - started < 300);
    } finally { await fixture.cleanup(); }
});

test('slow first-prime restoration consumes only its original one-third budget', { timeout: 5000 }, async () => {
    const budget = 900;
    const fixture = makeFixture({ restore: ({ hold }) => hold() });
    const started = performance.now();
    try {
        const result = await waitForPageReadiness(fixture.page, visualOptions(budget));
        assert.equal(fixture.state.primes, 1);
        assert.equal(fixture.state.lazyReads, 1);
        assert.equal(fixture.state.restores, 1);
        assert.ok(fixture.state.samples.length > 0);
        const firstSampleMs = fixture.state.samples[0].at - started;
        assert.ok(firstSampleMs <= budget / 3 + 100, 'First sample began after the original prime budget: ' + firstSampleMs);
        assert.equal(result.complete, false);
        assert.match(result.note, /懒加载遍历未完成/);
        assert.equal(getPageReadiness(fixture.page), result);
    } finally { await fixture.cleanup(); }
});

test('second-prime slow work and restoration stay inside the existing visual deadline', { timeout: 5000 }, async () => {
    const budget = 950;
    const started = performance.now();
    const fixture = makeFixture({
        documentVersion: state => state.primes === 1 ? 1 : 2,
        sample: () => readySnapshot(2, { ready: 0, pending: 1, signature: 'new-document-pending' }),
        async lazy({ state }) {
            if (state.primes === 2) await delay(Math.max(0, started + budget - 120 - performance.now()));
            return { bottom: 720, height: 720, documentVersion: state.primes === 1 ? 1 : 2 };
        },
        restore: ({ state, hold }) => state.primes === 2 ? hold() : undefined,
    });
    try {
        const result = await waitForPageReadiness(fixture.page, visualOptions(budget));
        const elapsed = performance.now() - started;
        assert.equal(fixture.state.primes, 2);
        assert.equal(fixture.state.restores, 2);
        assert.equal(result.complete, false);
        assert.ok(elapsed <= budget + 140, 'Second prime rebuilt the visual deadline: ' + elapsed);
        assert.ok(fixture.state.events.some(event => event.kind === 'restore' && event.documentVersion === 2));
    } finally { await fixture.cleanup(); }
});

test('replacement document retains its pending images and fonts after the second prime', { timeout: 5000 }, async () => {
    const fixture = makeFixture({
        documentVersion: state => state.primes === 1 ? 1 : 2,
        sample: () => readySnapshot(2, {
            total: 2, ready: 0, pending: 2, fontsReady: false, signature: 'new-document-resources-pending',
        }),
    });
    try {
        const result = await waitForPageReadiness(fixture.page, visualOptions(700));
        assert.equal(fixture.state.primes, 2);
        assert.equal(fixture.state.restores, 2);
        assert.equal(result.complete, false);
        assert.equal(result.pending, 2);
        assert.equal(result.ready, 0);
        assert.equal(result.fontsReady, false);
        assert.match(result.note, /2 个可见资源仍在加载/);
        assert.match(result.note, /字体尚未就绪/);
        assert.ok(fixture.state.samples.every(snapshot => snapshot.documentVersion === 2));
    } finally { await fixture.cleanup(); }
});

for (const cancelledPrime of [1, 2]) {
    test('cancelling prime ' + cancelledPrime + ' stops without another scroll or restoration', { timeout: 5000 }, async () => {
        const controller = new AbortController();
        const fixture = makeFixture({
            documentVersion: state => state.primes === 1 ? 1 : 2,
            sample: () => readySnapshot(2, { ready: 0, pending: 1 }),
            lazy({ state, hold }) {
                if (state.primes === cancelledPrime) {
                    queueMicrotask(() => controller.abort());
                    return hold();
                }
                return { bottom: 720, height: 720, documentVersion: 1 };
            },
        });
        try {
            await runWithRequestContext({ signal: controller.signal, timeoutMs: 2000 }, async () => {
                const deadline = getRequestContext().deadline;
                await assert.rejects(waitForPageReadiness(fixture.page, visualOptions(1200)), error => error.code === 'request_cancelled');
                assert.equal(getRequestContext().deadline, deadline);
            });
            assert.equal(fixture.state.primes, cancelledPrime);
            assert.equal(fixture.state.lazyReads, cancelledPrime);
            assert.equal(fixture.state.restores, cancelledPrime - 1);
            assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        } finally { await fixture.cleanup(); }
    });
}

test('closed page during lazy priming fails instead of restoring or restarting it', { timeout: 5000 }, async () => {
    const fixture = makeFixture({
        lazy({ page, state }) {
            state.closed = true;
            page.emit('close');
            throw new Error('Execution context was destroyed');
        },
    });
    try {
        await assert.rejects(waitForPageReadiness(fixture.page, visualOptions(1200)), /页面已关闭/);
        assert.equal(fixture.state.primes, 1);
        assert.equal(fixture.state.lazyReads, 1);
        assert.equal(fixture.state.restores, 0);
    } finally { await fixture.cleanup(); }
});
