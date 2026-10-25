import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { readDuringNavigation, isNavigationReadError, NavigationReadError, pageReadFailure } from '../src/navigation-read.ts';
import { runWithRequestContext, getRequestContext } from '../src/request-context.ts';

function makePage() {
    const page = new EventEmitter();
    const frame = {};
    page.currentUrl = 'http://example.test/start';
    page.closed = false;
    page.url = () => page.currentUrl;
    page.isClosed = () => page.closed;
    page.mainFrame = () => frame;
    page.waitForLoadState = async () => {};
    page.navigate = url => { page.currentUrl = url; page.emit('framenavigated', frame); };
    return page;
}

test('stable read runs exactly once without adding recovery wait', async () => {
    const page = makePage();
    let calls = 0;
    const started = performance.now();
    assert.equal(await readDuringNavigation(page, async () => { calls++; return 'body'; }, { phase: 'unit.content' }), 'body');
    assert.equal(calls, 1);
    assert.ok(performance.now() - started < 250);
    assert.equal(page.listenerCount('framenavigated'), 0);
});

for (const message of ['Execution context was destroyed, most likely because of a navigation', 'Unable to retrieve content because the page is navigating and changing the content.']) {
    test(`bounded read recovers supported navigation error: ${message}`, async () => {
        const page = makePage();
        let calls = 0;
        const result = await readDuringNavigation(page, async () => {
            calls++;
            if (calls === 1) { page.navigate('http://example.test/final'); throw new Error(message); }
            return 'final body';
        }, { phase: 'unit.content' });
        assert.equal(result, 'final body');
        assert.equal(calls, 2);
        assert.equal(page.listenerCount('framenavigated'), 0);
    });
}

test('a commit observed during a successful read invalidates the old result', async () => {
    const page = makePage();
    let calls = 0;
    const result = await readDuringNavigation(page, async () => {
        calls++;
        if (calls === 1) { page.navigate('http://example.test/final'); return 'stale'; }
        return 'current';
    }, { phase: 'unit.content' });
    assert.equal(result, 'current');
    assert.equal(calls, 2);
});

test('unrelated child-frame commit does not replay a main-frame read', async () => {
    const page = makePage();
    let calls = 0;
    assert.equal(await readDuringNavigation(page, async () => { calls++; page.emit('framenavigated', {}); return 'body'; }, { phase: 'unit.content' }), 'body');
    assert.equal(calls, 1);
});

test('non-navigation errors never replay', async () => {
    const page = makePage();
    let calls = 0;
    await assert.rejects(readDuringNavigation(page, async () => { calls++; throw new Error('Script syntax failed'); }, { phase: 'unit.content' }), error => {
        assert.ok(error instanceof NavigationReadError);
        assert.equal(error.diagnostics.retries, 0);
        return /Script syntax/.test(error.message);
    });
    assert.equal(calls, 1);
});

test('repeated navigation stops at the original retry bound and retains exact phase and URLs', async () => {
    const page = makePage();
    let calls = 0;
    await assert.rejects(readDuringNavigation(page, async () => { calls++; page.navigate('http://example.test/final'); throw new Error('Execution context was destroyed'); }, { phase: 'html.selector', maxRetries: 2 }), error => {
        const failure = pageReadFailure(error, 'fallback', 'http://example.test/start');
        assert.equal(failure.phase, 'html.selector');
        assert.equal(failure.finalUrl, 'http://example.test/final');
        assert.equal(failure.retries, 2);
        assert.equal(failure.code, 'navigation_read_interrupted');
        return true;
    });
    assert.equal(calls, 3);
    assert.equal(page.listenerCount('framenavigated'), 0);
});

test('closed page is not retried', async () => {
    const page = makePage();
    let calls = 0;
    await assert.rejects(readDuringNavigation(page, async () => { calls++; page.closed = true; throw new Error('Execution context was destroyed'); }, { phase: 'unit.content' }), /页面已关闭/);
    assert.equal(calls, 1);
    assert.equal(page.listenerCount('framenavigated'), 0);
});

test('detached frame is not retried', async () => {
    const page = makePage();
    let calls = 0;
    const frame = { page: () => page, isDetached: () => true, url: () => page.url() };
    await assert.rejects(readDuringNavigation(frame, async () => { calls++; return 'stale'; }, { phase: 'unit.frame' }), /frame 已脱离/);
    assert.equal(calls, 0);
});

test('cancel interrupts an outstanding read without replay and releases its event listener', async () => {
    const page = makePage();
    const controller = new AbortController();
    let calls = 0;
    await runWithRequestContext({ signal: controller.signal, timeoutMs: 2000 }, async () => {
        const timer = setTimeout(() => controller.abort(), 25);
        try {
            await assert.rejects(readDuringNavigation(page, async () => { calls++; return new Promise(() => {}); }, { phase: 'unit.cancel' }), error => error.code === 'request_cancelled');
        } finally { clearTimeout(timer); }
    });
    assert.equal(calls, 1);
    assert.equal(page.listenerCount('framenavigated'), 0);
});

test('request deadline is not extended while recovering navigation', async () => {
    const page = makePage();
    const started = performance.now();
    let calls = 0;
    await runWithRequestContext({ timeoutMs: 80 }, async () => {
        const original = getRequestContext().deadline;
        page.waitForLoadState = () => new Promise(() => {});
        await assert.rejects(readDuringNavigation(page, async () => { calls++; throw new Error('Execution context was destroyed'); }, { phase: 'unit.deadline' }), error => error.code === 'request_deadline_exceeded');
        assert.equal(getRequestContext().deadline, original);
    });
    assert.equal(calls, 1);
    assert.ok(performance.now() - started < 600);
    assert.equal(page.listenerCount('framenavigated'), 0);
});

test('already-expired request never starts the read', async () => {
    const page = makePage();
    let calls = 0;
    await runWithRequestContext({ deadline: performance.now() - 1 }, async () => {
        await assert.rejects(readDuringNavigation(page, async () => { calls++; return 'body'; }, { phase: 'unit.expired' }), error => error.code === 'request_deadline_exceeded');
    });
    assert.equal(calls, 0);
});

test('a local zero read budget never starts the read', async () => {
    const page = makePage();
    let calls = 0;
    await assert.rejects(readDuringNavigation(page, async () => { calls++; return 'body'; }, { phase: 'unit.local-expired', timeoutMs: 0 }), /读取期限已到/);
    assert.equal(calls, 0);
});

test('page and frame closure messages are excluded from navigation recovery', () => {
    assert.equal(isNavigationReadError(new Error('Target page, context or browser has been closed')), false);
    assert.equal(isNavigationReadError(new Error('Frame was detached')), false);
    assert.equal(isNavigationReadError(new Error('Execution context user validation failed')), false);
});
