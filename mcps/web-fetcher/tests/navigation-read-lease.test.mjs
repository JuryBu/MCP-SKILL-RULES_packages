import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import test, { after, before } from 'node:test';
import { browserManager } from '../src/browser.ts';
import { readDuringNavigation } from '../src/navigation-read.ts';
import { getActiveRequestCount, getRequestContext, runWithRequestContext } from '../src/request-context.ts';
import { SessionManager, sessionManager } from '../src/session.ts';
import { ToolConcurrency } from '../src/tool-concurrency.ts';
import { registerFetchHtml } from '../src/tools/fetch-html.ts';
import { registerFetchPage } from '../src/tools/fetch-page.ts';

const originalNavigateTo = browserManager.navigateTo;
const readProbe = () => document.title;
const successfulResult = () => ({ content: [{ type: 'text', text: 'completed' }] });
let fixtureSequence = 0;

before(() => {
    browserManager.navigateTo = async () => { throw new Error('A lease test must not launch or navigate a browser'); };
});
after(() => { browserManager.navigateTo = originalNavigateTo; });

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function waitFor(predicate, description) {
    const until = performance.now() + 2500;
    while (!predicate()) {
        assert.ok(performance.now() < until, description);
        await delay(1);
    }
}

async function flushEvents() {
    await nextTurn();
    await nextTurn();
}

function makeFixture(closeSettlement) {
    const pending = deferred();
    const started = deferred();
    const events = [];
    const page = new EventEmitter();
    const mainFrame = {};
    const lateError = new Error('late-browser-rejection-must-not-replace-the-stop-error');
    const url = 'https://lease.example.test/article';
    const state = { reads: 0, ended: false, closes: 0, closed: false };
    const read = () => {
        state.reads++;
        events.push('read:start');
        started.resolve();
        return pending.promise.then(value => {
            state.ended = true;
            events.push('read:resolve');
            return value;
        }, error => {
            state.ended = true;
            events.push('read:reject');
            throw error;
        });
    };
    const settle = completion => {
        if (completion === 'reject') pending.reject(lateError);
        else pending.resolve('<article>Late readable article content</article>');
    };
    page.url = () => url;
    page.isClosed = () => state.closed;
    page.mainFrame = () => mainFrame;
    page.waitForLoadState = async () => {};
    page.content = read;
    page.title = async () => 'Lease fixture';
    page.evaluate = async callback => {
        if (callback === readProbe) return read();
        const source = String(callback);
        if (/querySelectorAll\(["']iframe["']\)/.test(source)) return { names: [], documentVersion: 1 };
        if (source.includes('__mcpPdfInfo')) return undefined;
        if (source.includes('documentVersion:')) return { title: 'Lease fixture', documentVersion: 1 };
        return {
            title: 'Lease fixture',
            visibleText: 'Ordinary readable article content. '.repeat(12),
            html: '<article>Ordinary readable article content</article>',
            readyState: 'complete',
            scriptUrls: [],
            iframeUrls: [],
            hasPasswordInput: false,
            hasBusinessForm: false,
            hasVisualContent: false,
        };
    };
    page.close = async () => {
        state.closes++;
        state.closed = true;
        events.push('page:close');
        if (closeSettlement) {
            settle(closeSettlement);
            await flushEvents();
        }
        page.emit('close');
    };
    const frame = {
        page: () => page,
        url: () => url,
        isDetached: () => false,
        waitForLoadState: async () => {},
        evaluate: read,
    };
    return { page, frame, started, state, events, settle, lateError };
}

function handlerFor(register) {
    let registered;
    register({ registerTool(_name, _definition, handler) { registered = handler; } });
    assert.equal(typeof registered, 'function');
    return registered;
}

function observe(promise, onSettled = () => {}) {
    return promise.then(result => {
        onSettled();
        return { result };
    }, error => {
        onSettled();
        return { error };
    });
}

async function exerciseLease({ targetKind, stopKind, completion, realFetchPage = false }) {
    const fixture = makeFixture();
    const sessions = realFetchPage ? sessionManager : new SessionManager();
    const ownerId = 'navigation-read-lease-' + (++fixtureSequence);
    const sessionId = sessions.registerPage(fixture.page, ownerId, { ownership: 'borrowed', closePolicy: 'noop', browserSource: 'external-page' });
    const controller = new ToolConcurrency({ maxActive: 1, sessions, defaultTimeoutMs: stopKind === 'request' ? 350 : 2000 });
    const abortController = new AbortController();
    const unhandled = [];
    const onUnhandled = error => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    let request;
    let originalDeadline;
    let observedError;
    let firstSettled = false;
    let samePageStarted = false;
    let otherStarted = false;
    let queuedPage;
    let queuedOther;
    const readHandler = realFetchPage ? handlerFor(registerFetchPage) : async () => {
        const target = targetKind === 'frame-evaluate' ? fixture.frame : fixture.page;
        const read = targetKind === 'page-content' ? () => fixture.page.content()
            : () => target.evaluate(readProbe);
        try {
            await readDuringNavigation(target, read, { phase: 'lease.' + targetKind, ...(stopKind === 'local' ? { timeoutMs: 35 } : {}) });
            assert.fail('Stopped reads must not return late content as a success');
        } catch (error) {
            observedError = error;
            throw error;
        }
    };
    const args = { ownerId, sessionId, humanAssistance: 'never', outputMode: 'full' };
    const first = observe(controller.run('web_fetch_page', args, async params => {
        request = getRequestContext();
        originalDeadline = request.deadline;
        assert.equal(request.leasedPages.has(fixture.page), true);
        return readHandler(params);
    }, { signal: abortController.signal }), () => { firstSettled = true; });
    try {
        await waitFor(() => fixture.state.reads === 1, 'The underlying browser read did not start');
        assert.ok(getEventListeners(abortController.signal, 'abort').length > 0);
        if (stopKind === 'cancel') abortController.abort();
        await waitFor(() => getEventListeners(abortController.signal, 'abort').length === 0, 'The race did not stop and clean its abort listener');
        if (stopKind === 'request') assert.ok(performance.now() >= originalDeadline);
        if (stopKind === 'local') assert.ok(performance.now() < originalDeadline);
        await flushEvents();
        assert.equal(firstSettled, false, 'The tool returned while its leased-page read was still running');
        assert.equal(fixture.state.ended, false);
        assert.equal(request.deadline, originalDeadline);
        assert.equal(request.leasedPages.has(fixture.page), true);
        assert.equal(controller.getStats().normal.active, 1);
        assert.equal(sessions.getOperationStats().active, 1);
        assert.equal(fixture.state.closes, 0);
        queuedPage = observe(controller.run('web_interact', { ownerId, sessionId, action: 'visible', humanAssistance: 'never' }, async () => {
            samePageStarted = true;
            fixture.events.push('same-page:start');
            return successfulResult();
        }));
        queuedOther = observe(controller.run('web_fetch_page', { ownerId: ownerId + '-other', humanAssistance: 'never' }, async () => {
            otherStarted = true;
            fixture.events.push('other-tool:start');
            return successfulResult();
        }));
        await waitFor(() => sessions.getOperationStats().queued === 1 && controller.getStats().normal.queued === 1, 'The next page action and tool did not remain queued');
        assert.equal(samePageStarted, false);
        assert.equal(otherStarted, false);
        assert.equal(firstSettled, false);
        assert.equal(controller.getStats().normal.active, 1);
        assert.equal(sessions.getOperationStats().active, 1);
        fixture.settle(completion);
        const outcome = await first;
        const pageOutcome = await queuedPage;
        const otherOutcome = await queuedOther;
        const expectedCode = stopKind === 'cancel' ? 'request_cancelled' : stopKind === 'request' ? 'request_deadline_exceeded' : 'page_read_timeout';
        if (stopKind === 'local') {
            assert.equal(outcome.error?.diagnostics.code, expectedCode);
            assert.equal(observedError, outcome.error);
            assert.equal(outcome.error.diagnostics.retries, 0);
        } else {
            assert.equal(outcome.result?.isError, true);
            assert.equal(outcome.result?._meta.webFetcherConcurrency.code, expectedCode);
            if (realFetchPage) assert.equal(outcome.result._meta.webFetcherReadFailure.code, expectedCode);
            else assert.equal(observedError?.code, expectedCode);
        }
        assert.equal(pageOutcome.error, undefined);
        assert.equal(pageOutcome.result.isError, undefined);
        assert.equal(otherOutcome.error, undefined);
        assert.equal(otherOutcome.result.isError, undefined);
        assert.equal(samePageStarted, true);
        assert.equal(otherStarted, true);
        const endEvent = fixture.events.indexOf('read:' + completion);
        assert.ok(endEvent > fixture.events.indexOf('read:start'));
        assert.ok(fixture.events.indexOf('same-page:start') > endEvent);
        assert.ok(fixture.events.indexOf('other-tool:start') > endEvent);
        assert.equal(fixture.state.reads, 1);
        assert.equal(request.deadline, originalDeadline);
        assert.equal(request.leasedPages.has(fixture.page), false);
        assert.equal(fixture.page.listenerCount('framenavigated'), 0);
        assert.equal(getEventListeners(abortController.signal, 'abort').length, 0);
        assert.equal(controller.getStats().normal.active, 0);
        assert.equal(controller.getStats().normal.queued, 0);
        assert.equal(sessions.getOperationStats().active, 0);
        assert.equal(sessions.getOperationStats().queued, 0);
        assert.equal(fixture.state.closes, 0);
        assert.equal(sessions.get(sessionId, ownerId), fixture.page);
        assert.doesNotMatch(JSON.stringify(outcome.result ?? { message: outcome.error?.message }), /late-browser-rejection/);
        await flushEvents();
        assert.deepEqual(unhandled, []);
    } finally {
        fixture.settle('resolve');
        abortController.abort();
        await Promise.allSettled([first, queuedPage, queuedOther].filter(Boolean));
        await sessions.close(sessionId, ownerId);
        if (!realFetchPage) await sessions.closeAll();
        await flushEvents();
        process.off('unhandledRejection', onUnhandled);
    }
    assert.equal(fixture.state.closes, 0, 'Removing a borrowed session must not close its Page');
    assert.equal(getActiveRequestCount(), 0);
}

for (const targetKind of ['page-content', 'page-evaluate', 'frame-evaluate']) {
    for (const stopKind of ['cancel', 'request', 'local']) {
        for (const completion of ['resolve', 'reject']) {
            test(targetKind + ' keeps its page lease and tool permit through ' + stopKind + ' until late ' + completion, { timeout: 7000 }, async () => {
                await exerciseLease({ targetKind, stopKind, completion });
            });
        }
    }
}

for (const completion of ['resolve', 'reject']) {
    test('actual borrowed web_fetch_page cancellation keeps the Page open through late ' + completion, { timeout: 7000 }, async () => {
        await exerciseLease({ targetKind: 'page-content', stopKind: 'cancel', completion, realFetchPage: true });
    });
}

for (const stopKind of ['cancel', 'request']) {
    for (const completion of ['resolve', 'reject']) {
        test('actual temporary web_fetch_html finally closes after ' + stopKind + ' and late ' + completion, { timeout: 7000 }, async () => {
            const fixture = makeFixture(completion);
            const sessions = new SessionManager();
            const controller = new ToolConcurrency({ maxActive: 1, sessions, defaultTimeoutMs: stopKind === 'request' ? 350 : 2000 });
            const abortController = new AbortController();
            const previousNavigateTo = browserManager.navigateTo;
            const unhandled = [];
            const onUnhandled = error => unhandled.push(error);
            let request;
            let originalDeadline;
            let closeActive;
            const close = fixture.page.close;
            fixture.page.close = async () => {
                closeActive = controller.getStats().normal.active;
                assert.equal(getRequestContext().leasedPages.has(fixture.page), false);
                await close();
            };
            browserManager.navigateTo = async () => fixture.page;
            process.on('unhandledRejection', onUnhandled);
            const callback = handlerFor(registerFetchHtml);
            const running = observe(controller.run('web_fetch_html', { url: fixture.page.url(), ownerId: 'temporary-lease-test', humanAssistance: 'never' }, async params => {
                request = getRequestContext();
                originalDeadline = request.deadline;
                return callback(params);
            }, { signal: abortController.signal }));
            try {
                await waitFor(() => fixture.state.reads === 1, 'Temporary-page content read did not start');
                if (stopKind === 'cancel') abortController.abort();
                const outcome = await running;
                const expectedCode = stopKind === 'cancel' ? 'request_cancelled' : 'request_deadline_exceeded';
                assert.equal(outcome.error, undefined);
                assert.equal(outcome.result.isError, true);
                assert.equal(outcome.result._meta.webFetcherReadFailure.code, expectedCode);
                assert.equal(outcome.result._meta.webFetcherConcurrency.code, expectedCode);
                assert.equal(fixture.state.closes, 1);
                assert.equal(fixture.state.ended, true);
                assert.equal(fixture.state.reads, 1);
                assert.ok(fixture.events.indexOf('page:close') < fixture.events.indexOf('read:' + completion));
                assert.equal(closeActive, 1);
                assert.equal(request.deadline, originalDeadline);
                assert.equal(controller.getStats().normal.active, 0);
                assert.equal(fixture.page.listenerCount('framenavigated'), 0);
                assert.equal(getEventListeners(abortController.signal, 'abort').length, 0);
                assert.doesNotMatch(JSON.stringify(outcome.result), /late-browser-rejection/);
                await flushEvents();
                assert.deepEqual(unhandled, []);
            } finally {
                fixture.settle('resolve');
                abortController.abort();
                await running;
                browserManager.navigateTo = previousNavigateTo;
                process.off('unhandledRejection', onUnhandled);
                await sessions.closeAll();
            }
            assert.equal(getActiveRequestCount(), 0);
        });
    }
}

test('cancellation between scheduling and the read microtask starts no browser read', async () => {
    const fixture = makeFixture();
    const controller = new AbortController();
    let calls = 0;
    await runWithRequestContext({ signal: controller.signal, timeoutMs: 2000 }, async () => {
        const running = readDuringNavigation(fixture.page, async () => { calls++; return 'unexpected'; }, { phase: 'lease.microtask' });
        controller.abort();
        await assert.rejects(running, error => error.code === 'request_cancelled');
    });
    await flushEvents();
    assert.equal(calls, 0);
    assert.equal(fixture.page.listenerCount('framenavigated'), 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(getActiveRequestCount(), 0);
});
