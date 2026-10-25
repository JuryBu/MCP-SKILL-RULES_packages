import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const enabled = process.env.WEB_FETCHER_BROWSER_TESTS === '1';
const sourceRoot = process.env.WEB_FETCHER_TEST_BUILD === 'dist' ? '../dist/' : '../src/';
const extension = sourceRoot === '../src/' ? 'ts' : 'js';
const loadModule = name => import(new URL(`${sourceRoot}${name}.${extension}`, import.meta.url));
const textOf = result => result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
const normalizedText = result => textOf(result).replace(/\\([_*-])/g, '$1');
const sleep = duration => new Promise(resolve => setTimeout(resolve, duration));
const article = token => `<!doctype html><html><head><title>DOCUMENT GAP FINAL ${token}</title></head><body><article id="article"><h1>DOCUMENT GAP FINAL ${token}</h1><p>${'The final article contains useful paragraphs after the short-link document transition. '.repeat(10)}</p><p><a href="?source-proof=1">SOURCE PROOF LINK</a></p><p>FINAL ARTICLE END ${token}</p></article><a id="absolute-proof" href="/article/${token}">FINAL HREF</a></body></html>`;

function installDocumentGap(page, { stage, destination, delay = 180, readRequestContext }) {
    const evaluate = page.evaluate.bind(page);
    const evidence = { stage, snapshots: 0, scrollCommands: 0, gaps: 0, bodyNull: false, commits: [], nativeErrors: [] };
    let requestContext;
    const open = async () => {
        evidence.gaps++;
        evidence.bodyNull = await evaluate(({ destination, delay }) => {
            document.body.remove();
            setTimeout(() => location.replace(destination), delay);
            return document.body === null;
        }, { destination, delay });
        evidence.gapIntroducedAt = performance.now();
    };
    const onNavigation = frame => {
        if (frame === page.mainFrame()) evidence.commits.push(frame.url());
    };
    page.on('framenavigated', onNavigation);
    page.evaluate = async (callback, argument) => {
        const currentRequest = readRequestContext?.();
        if (currentRequest && !requestContext) {
            requestContext = currentRequest;
            evidence.deadlineBefore = currentRequest.deadline;
            evidence.requestStartedAt = currentRequest.startedAt;
        }
        const source = callback.toString();
        if (stage === 'readiness' && argument && typeof argument.visual === 'boolean' && typeof argument.fullPage === 'boolean') {
            evidence.readinessSamples = (evidence.readinessSamples ?? 0) + 1;
            if (!evidence.gaps) {
                evidence.injectionPhase = `readiness.${argument.visual ? 'visual' : 'content'}.sample`;
                evidence.injectionSample = evidence.readinessSamples;
                await open();
            }
        }
        if (/\bscrollTo\s*\(/.test(source)) evidence.scrollCommands++;
        if (source.includes('scrollY') && source.includes('scrollHeight')) {
            evidence.snapshots++;
            if (!evidence.gaps && evidence.snapshots === (stage === 'before' ? 1 : 2)) {
                await open();
            }
        }
        try { return await evaluate(callback, argument); }
        catch (error) {
            evidence.nativeErrors.push(error.message);
            throw error;
        }
    };
    return {
        evidence,
        open,
        get deadlineAfter() { return requestContext?.deadline; },
        get pageClosed() { return page.isClosed(); },
        restore() {
            page.evaluate = evaluate;
            page.off('framenavigated', onNavigation);
        },
    };
}

function assertGap(evidence) {
    assert.equal(evidence.gaps, 1, 'exactly one real DOM gap must be introduced');
    assert.equal(evidence.bodyNull, true, 'Edge must actually observe document.body === null');
    assert.ok(evidence.scrollCommands <= 1, 'read recovery must not replay the scrolling mutation');
}

test('document gaps retain real final articles through scroll and HTTP tools in headless Edge', { skip: !enabled, timeout: 75_000 }, async suite => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'web-fetcher-document-gap-'));
    const previousProfileBase = process.env.WEB_FETCHER_PROFILE_BASE_DIR;
    process.env.WEB_FETCHER_PROFILE_BASE_DIR = path.join(temporary, 'auth');
    const { browserManager } = await loadModule('browser');
    const { humanBrowserManager } = await loadModule('human-browser/manager');
    const { sessionManager } = await loadModule('session');
    const { installToolConcurrency } = await loadModule('tool-concurrency');
    const { registerFetchPage } = await loadModule('tools/fetch-page');
    const { registerFetchHtml } = await loadModule('tools/fetch-html');
    const { registerInteract } = await loadModule('tools/interact');
    const { waitForPageReadiness } = await loadModule('readiness');
    const { readDuringNavigation, DocumentChangedError } = await loadModule('navigation-read');
    const { runWithRequestContext, getRequestContext, remainingRequestMs } = await loadModule('request-context');
    const ownerId = `document-gap-${randomUUID()}`;
    const service = new McpServer({ name: 'document-gap-http-fixture', version: '1' });
    const concurrencyOptions = { defaultTimeoutMs: 30_000 };
    installToolConcurrency(service, concurrencyOptions);
    registerFetchPage(service);
    registerFetchHtml(service);
    registerInteract(service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    const client = new Client({ name: 'document-gap-http-client', version: '1' });
    const requests = [];
    const effects = new Map();
    const progressiveRequests = new Map();
    const progressiveStreams = new Map();
    const quietStreams = new Map();
    const timers = new Set();
    const server = http.createServer((request, response) => {
        const target = new URL(request.url, 'http://127.0.0.1');
        if (target.pathname === '/mcp') {
            void transport.handleRequest(request, response).catch(error => {
                if (!response.headersSent) response.writeHead(500);
                response.end(String(error));
            });
            return;
        }
        requests.push({ method: request.method, path: target.pathname });
        const token = target.pathname.split('/').at(-1);
        if (target.pathname.startsWith('/effect/')) {
            if (request.method === 'POST') effects.set(token, (effects.get(token) ?? 0) + 1);
            response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            response.end(JSON.stringify({ count: effects.get(token) ?? 0 }));
            return;
        }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        if (target.pathname.startsWith('/quiet/')) {
            const state = { finishedAt: undefined };
            quietStreams.set(token, state);
            response.write('<!doctype html><html><head><title>Quiet stream</title></head><body><article><h1>UNCHANGED VISIBLE DOCUMENT</h1><p>Identical visible text and identical layout throughout the loading transition.</p></article>');
            const timer = setTimeout(() => {
                timers.delete(timer);
                state.finishedAt = performance.now();
                response.end('<!-- parser completion only --></body></html>');
            }, 850);
            timers.add(timer);
            response.once('close', () => { clearTimeout(timer); timers.delete(timer); });
        } else if (target.pathname.startsWith('/progressive/')) {
            const count = (progressiveRequests.get(token) ?? 0) + 1;
            progressiveRequests.set(token, count);
            if (count === 1 && target.searchParams.get('stream') !== '1') {
                response.end('<!doctype html><title>SHORT LINK TRANSITION</title><body><p>SHORT LINK TRANSITION BODY</p></body>');
                return;
            }
            const state = { partialSent: false, finalSent: false, closed: false, pendingTimers: new Set() };
            progressiveStreams.set(token, state);
            response.write(`<!doctype html><html><head><title>DOCUMENT GAP FINAL ${token}</title>`);
            state.start = () => {
                if (state.started || state.closed) return;
                state.started = true;
                const partialTimer = setTimeout(() => {
                    timers.delete(partialTimer);
                    state.pendingTimers.delete(partialTimer);
                    state.partialSent = true;
                    response.write(`</head><body><article id="article"><h1>DOCUMENT GAP FINAL ${token}</h1><p>PARTIAL STREAM MARKER ${'Readable early article paragraphs while the final HTTP document is still loading. '.repeat(12)}</p>`);
                }, 80);
                const finalTimer = setTimeout(() => {
                    timers.delete(finalTimer);
                    state.pendingTimers.delete(finalTimer);
                    state.finalSent = true;
                    response.end(`<p><a href="?source-proof=1">SOURCE PROOF LINK</a></p><p>FINAL ARTICLE END ${token}</p></article></body></html>`);
                }, target.searchParams.get('slow') === '1' ? 2500 : 1200);
                for (const timer of [partialTimer, finalTimer]) {
                    timers.add(timer);
                    state.pendingTimers.add(timer);
                }
            };
            if (target.searchParams.get('headGate') !== '1') state.start();
            response.once('close', () => {
                state.closed = true;
                for (const timer of state.pendingTimers) { clearTimeout(timer); timers.delete(timer); }
                state.pendingTimers.clear();
            });
        } else if (target.pathname.startsWith('/stream/') || target.pathname.startsWith('/submit/')) {
            if (target.pathname.startsWith('/submit/') && request.method === 'POST') effects.set(token, (effects.get(token) ?? 0) + 1);
            const destination = `/article/${token}`;
            response.write(`<!doctype html><html><head><title>HEAD ONLY TRANSITION</title><script>if(window.__documentGapObserved)void window.__documentGapObserved({bodyNull:document.body===null,href:location.href});setTimeout(()=>location.replace(${JSON.stringify(destination)}),650)</script>`);
            const timer = setTimeout(() => response.end('</head><body>EXPIRED TRANSITION BODY</body></html>'), 1400);
            timers.add(timer);
            response.once('close', () => { clearTimeout(timer); timers.delete(timer); });
        } else if (target.pathname.startsWith('/article/')) {
            response.end(article(token));
        } else if (target.pathname.startsWith('/actions/')) {
            response.end(`<!doctype html><title>Action fixture</title><body><h1>ACTION FIXTURE</h1><button id="counter-click" onclick="fetch('/effect/${token}',{method:'POST'}).then(()=>{document.body.remove();if(window.__documentGapObserved)void window.__documentGapObserved({bodyNull:document.body===null,href:location.href});setTimeout(()=>location.replace('/article/${token}'),180)})">Count one click</button><form action="/submit/${token}" method="post"><button id="counter-submit" type="submit">Count one submit</button></form></body>`);
        } else {
            response.end('<!doctype html><title>SHORT LINK TRANSITION</title><body><p>SHORT LINK TRANSITION BODY</p></body>');
        }
    });
    const originalHumanOpen = humanBrowserManager.open;
    let visibleOpenAttempts = 0;
    humanBrowserManager.open = async () => {
        visibleOpenAttempts++;
        throw new Error('Document-gap tests must never open a visible browser');
    };
    let context;
    let contextClosed = false;
    let connected = false;
    let activeGap;
    let latestGap;
    const restorers = new Set();
    const call = (name, args) => client.callTool({ name, arguments: { ownerId, humanAssistance: 'never', timeout: 30_000, ...args } }, undefined, { timeout: 40_000 });
    const directPage = async handler => {
        const page = await context.newPage();
        try { await handler(page); }
        finally { await page.close().catch(() => {}); }
    };
    try {
        await service.connect(transport);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const installProgressiveReload = targetUrl => {
            const originalNavigateTo = browserManager.navigateTo;
            const evidence = { pageClosed: false };
            browserManager.navigateTo = async (...arguments_) => {
                const page = await originalNavigateTo.apply(browserManager, arguments_);
                if (arguments_[0] !== targetUrl) return page;
                evidence.previousVersion = await page.evaluate(() => performance.timeOrigin);
                page.once('close', () => { evidence.pageClosed = true; });
                try {
                    await page.unroute('**/*');
                    evidence.rawStreamingTransport = true;
                    await page.evaluate(() => { setTimeout(() => location.reload(), 20); });
                    await page.waitForFunction(previousVersion => performance.timeOrigin !== previousVersion && document.body?.textContent?.includes('PARTIAL STREAM MARKER') && document.readyState === 'loading', evidence.previousVersion,
                        { timeout: Math.max(1, Math.min(600, remainingRequestMs())), polling: 20 });
                    Object.assign(evidence, await page.evaluate(() => ({ readyState: document.readyState, bodyLength: document.body.innerText.length, documentVersion: performance.timeOrigin, href: location.href })));
                    return page;
                } catch (error) {
                    await page.close().catch(() => {});
                    throw error;
                }
            };
            return { evidence, restore() { browserManager.navigateTo = originalNavigateTo; } };
        };
        context = await chromium.launchPersistentContext(path.join(temporary, 'edge'), {
            channel: 'msedge', headless: true, viewport: { width: 800, height: 600 },
        });
        context.on('close', () => { contextClosed = true; });
        if (sourceRoot === '../src/') {
            await context.addInitScript(() => {
                Object.defineProperty(window, '__name', {
                    value: (target, name) => Object.defineProperty(target, 'name', { value: name, configurable: true }),
                    configurable: true,
                });
            });
        }
        context.on('page', page => {
            if (activeGap) {
                latestGap = installDocumentGap(page, activeGap);
                restorers.add(latestGap);
            }
        });
        browserManager.context = context;
        await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
        connected = true;
        const sourceHashes = {};
        for (const name of ['browser', 'readiness', 'navigation-read', 'tools/fetch-page', 'tools/fetch-html', 'tools/interact']) {
            sourceHashes[name] = createHash('sha256').update(await fs.readFile(new URL(`${sourceRoot}${name}.${extension}`, import.meta.url))).digest('hex');
        }
        console.log(JSON.stringify({ fixture: 'document-gap', sourceRoot, sourceHashes, node: process.version, browser: context.browser()?.version(), headless: true, isolatedProfile: true }));

        for (const stage of ['before', 'after']) {
            await suite.test(`BrowserManager.scrollPage waits through a native body gap at scroll.${stage}`, async () => {
                await directPage(async page => {
                    const token = randomUUID();
                    const destination = `${origin}/article/${token}`;
                    await page.goto(`${origin}/bridge/${token}`);
                    const gap = installDocumentGap(page, { stage, destination });
                    try {
                        await runWithRequestContext({ ownerId, timeoutMs: 3500 }, () => browserManager.scrollPage(page, 1));
                        assertGap(gap.evidence);
                        assert.equal(page.url(), destination, 'scroll must not finish on an empty transition document');
                        assert.equal(await page.title(), `DOCUMENT GAP FINAL ${token}`);
                        assert.match(await page.locator('article').innerText(), new RegExp(`FINAL ARTICLE END ${token}`));
                        assert.equal(await page.locator('#absolute-proof').evaluate(element => element.href), destination);
                    } finally {
                        console.log(JSON.stringify({ test: 'direct-scroll', ...gap.evidence, hrefAtReturn: page.url() }));
                        gap.restore();
                    }
                });
            });
        }

        await suite.test('readiness rejects a streaming head and partial body until the final document is parsed', async () => {
            await directPage(async page => {
                const token = randomUUID();
                const destination = `${origin}/progressive/${token}?stream=1&headGate=1`;
                await page.goto(destination, { waitUntil: 'commit' });
                await page.waitForFunction(() => document.title.startsWith('DOCUMENT GAP FINAL') && document.body === null, undefined, { polling: 20, timeout: 1500 });
                progressiveStreams.get(token).start();
                const started = performance.now();
                const readiness = await runWithRequestContext({ ownerId, timeoutMs: 2400 }, () => waitForPageReadiness(page, { mode: 'content', maxWait: 2000, minimumObserveMs: 0, quietMs: 60 }));
                console.log(JSON.stringify({ test: 'streaming-head-readiness', readiness, elapsedMs: Math.round(performance.now() - started), hrefAtReturn: page.url() }));
                assert.equal(readiness.complete, true);
                assert.equal(page.url(), destination, 'head-only loading must not be accepted as a completed document');
                assert.equal(await page.title(), `DOCUMENT GAP FINAL ${token}`);
                assert.match(await page.locator('article').innerText(), /FINAL ARTICLE END/);
                assert.equal(await page.evaluate(() => document.readyState === 'loading'), false);
                assert.equal(progressiveStreams.get(token).finalSent, true);
            });
        });

        await suite.test('readiness restarts its quiet window when parsing ends with unchanged text and layout', async () => {
            await directPage(async page => {
                const token = randomUUID();
                let readyAt;
                const onReady = () => { readyAt ??= performance.now(); };
                page.on('domcontentloaded', onReady);
                try {
                    await page.goto(`${origin}/quiet/${token}`, { waitUntil: 'commit' });
                    await page.waitForFunction(() => !!document.body && document.readyState === 'loading', undefined, { polling: 20 });
                    const layout = () => page.evaluate(() => {
                        const rectangle = document.querySelector('article').getBoundingClientRect();
                        return { text: document.body.innerText, elements: document.querySelectorAll('*').length, width: rectangle.width, height: rectangle.height };
                    });
                    const before = await layout();
                    const readiness = await runWithRequestContext({ ownerId, timeoutMs: 2600 }, () => waitForPageReadiness(page, { mode: 'content', maxWait: 2400, minimumObserveMs: 0, quietMs: 360 }));
                    const returnedAt = performance.now();
                    const after = await layout();
                    console.log(JSON.stringify({ test: 'readiness-post-parse-quiet-window', readiness, quietAfterDOMContentLoadedMs: Math.round(returnedAt - readyAt), quietAfterResponseEndMs: Math.round(returnedAt - quietStreams.get(token).finishedAt), unchangedLayout: JSON.stringify(before) === JSON.stringify(after) }));
                    assert.equal(readiness.complete, true);
                    assert.ok(Number.isFinite(readyAt), 'a real DOMContentLoaded event must occur');
                    assert.deepEqual(after, before, 'parsing completion must leave visible text, element count and layout unchanged');
                    assert.ok(returnedAt - readyAt >= 320, `the completed document received only ${Math.round(returnedAt - readyAt)}ms of its 360ms quiet window`);
                } finally { page.off('domcontentloaded', onReady); }
            });
        });

        await suite.test('readiness continues inside the original budget after DocumentChangedError exhausts the inner retries', async () => {
            await directPage(async page => {
                await page.goto(`${origin}/article/${randomUUID()}`);
                const evaluate = page.evaluate.bind(page);
                let interruptions = 0;
                let samples = 0;
                let deadlineBefore;
                let deadlineAfter;
                page.evaluate = async (callback, argument) => {
                    if (argument && typeof argument.visual === 'boolean' && typeof argument.fullPage === 'boolean') {
                        samples++;
                        if (interruptions < 3) { interruptions++; throw new DocumentChangedError(); }
                    }
                    return evaluate(callback, argument);
                };
                try {
                    const started = performance.now();
                    const readiness = await runWithRequestContext({ ownerId, timeoutMs: 1500 }, async () => {
                        deadlineBefore = getRequestContext().deadline;
                        try { return await waitForPageReadiness(page, { mode: 'content', maxWait: 1200, minimumObserveMs: 0, quietMs: 80 }); }
                        finally { deadlineAfter = getRequestContext().deadline; }
                    });
                    console.log(JSON.stringify({ test: 'readiness-exhausted-document-changed', interruptions, samples, readiness, elapsedMs: Math.round(performance.now() - started), deadlineBefore, deadlineAfter }));
                    assert.equal(interruptions, 3, 'the first pure sample must exhaust all three attempts');
                    assert.ok(samples > 3, 'outer readiness sampling must resume after the wrapped navigation_read_interrupted');
                    assert.equal(readiness.complete, true);
                    assert.equal(deadlineAfter, deadlineBefore);
                    assert.ok(performance.now() - started < 1300);
                } finally { page.evaluate = evaluate; }
            });
        });

        await suite.test('readiness propagates an ordinary native TypeError instead of continuing its sampling loop', async () => {
            await directPage(async page => {
                await page.goto(`${origin}/article/${randomUUID()}`);
                const evaluate = page.evaluate.bind(page);
                let attempts = 0;
                page.evaluate = async (callback, argument) => {
                    if (argument && typeof argument.visual === 'boolean' && typeof argument.fullPage === 'boolean') {
                        attempts++;
                        return evaluate(() => { const unrelatedMissingValue = null; return unrelatedMissingValue.unrelatedReadinessProperty; });
                    }
                    return evaluate(callback, argument);
                };
                let failure;
                try {
                    try {
                        await runWithRequestContext({ ownerId, timeoutMs: 800 }, () => waitForPageReadiness(page, { mode: 'content', maxWait: 600, minimumObserveMs: 0 }));
                    } catch (error) { failure = error; }
                    console.log(JSON.stringify({ test: 'readiness-typeerror-no-retry', attempts, diagnostics: failure?.diagnostics }));
                    assert.match(failure?.message ?? '', /TypeError.*unrelatedReadinessProperty/s);
                    assert.equal(failure.diagnostics.code, 'page_read_failed');
                    assert.equal(failure.diagnostics.retries, 0);
                    assert.equal(attempts, 1);
                } finally { page.evaluate = evaluate; }
            });
        });

        for (const name of ['web_fetch_page', 'web_fetch_html']) {
            for (const stage of ['before', 'after']) {
                await suite.test(`${name} returns final title, body and href after scroll.${stage} loses its body`, async () => {
                    const token = randomUUID();
                    const destination = `${origin}/article/${token}`;
                    activeGap = { stage, destination };
                    latestGap = undefined;
                    try {
                        const result = await call(name, { url: `${origin}/bridge/${token}`, scrollCount: 1, ...(name === 'web_fetch_page' ? { outputMode: 'full' } : {}) });
                        assert.ok(latestGap, 'the real tool-created page must be instrumented');
                        assertGap(latestGap.evidence);
                        console.log(JSON.stringify({ test: 'http-tool-gap', tool: name, ...latestGap.evidence, isError: result.isError, result: textOf(result).slice(0, 550) }));
                        assert.ok(!result.isError, textOf(result));
                        assert.match(normalizedText(result), new RegExp(`DOCUMENT GAP FINAL ${token}`));
                        assert.match(normalizedText(result), new RegExp(`FINAL ARTICLE END ${token}`));
                        assert.doesNotMatch(normalizedText(result), /SHORT LINK TRANSITION/);
                        assert.ok(latestGap.evidence.commits.includes(destination), 'the final article must really commit');
                        if (name === 'web_fetch_page') {
                            assert.ok(normalizedText(result).includes(`${destination}?source-proof=1`), 'relative Markdown links must use the final document href');
                        } else {
                            assert.match(textOf(result), /<title>DOCUMENT GAP FINAL/);
                            assert.ok(textOf(result).includes(`href="/article/${token}"`), 'returned HTML must contain the final document link');
                        }
                    } finally {
                        activeGap = undefined;
                        latestGap?.restore();
                        restorers.delete(latestGap);
                    }
                });
            }
            if (name === 'web_fetch_page') await suite.test('web_fetch_page sessionId does not restart its HTTP request budget for a long body gap', async () => {
                const token = randomUUID();
                const previousBudget = concurrencyOptions.defaultTimeoutMs;
                let sessionId;
                let gap;
                try {
                    const opened = await call('web_interact', { url: `${origin}/bridge/${token}`, action: 'wait', selector: 'body' });
                    sessionId = textOf(opened).match(/SessionId:\s*(session_[\w-]+)/)?.[1];
                    assert.ok(!opened.isError && sessionId, textOf(opened));
                    const page = sessionManager.get(sessionId, ownerId);
                    assert.ok(page, 'the standard HTTP session must retain its owned bridge page');
                    const warmed = await call('web_fetch_page', { sessionId, outputMode: 'full' });
                    assert.ok(!warmed.isError, textOf(warmed));
                    gap = installDocumentGap(page, { stage: 'before', destination: `${origin}/article/${token}`, delay: 2500, readRequestContext: getRequestContext });
                    await gap.open();
                    assertGap(gap.evidence);
                    concurrencyOptions.defaultTimeoutMs = 1000;
                    const started = performance.now();
                    const result = await call('web_fetch_page', { sessionId, scrollCount: 1, timeout: 1000, outputMode: 'full' });
                    const elapsedMs = performance.now() - started;
                    assertGap(gap.evidence);
                    console.log(JSON.stringify({ test: 'http-original-deadline', tool: 'web_fetch_page', sessionId, prewarmed: true, elapsedMs: Math.round(elapsedMs), deadlineAfter: gap.deadlineAfter, isError: result.isError, result: textOf(result).slice(0, 550), ...gap.evidence }));
                    assert.equal(result.isError, true, 'an unfinished body gap must not yield empty success');
                    assert.match(textOf(result), /deadline|timeout|time.*out|期限|超时/i);
                    assert.equal(gap.evidence.deadlineBefore - gap.evidence.requestStartedAt, 1000, 'the measured request must receive exactly the original 1000ms budget');
                    assert.equal(gap.deadlineAfter, gap.evidence.deadlineBefore, 'body recovery must not replace or extend the original deadline');
                    assert.ok(elapsedMs >= 800 && elapsedMs < 1800, `the original 1000ms request consumed ${Math.round(elapsedMs)}ms`);
                    await sessionManager.close(sessionId, ownerId);
                    assert.equal(page.isClosed(), true, 'the timed-out owned session must really close');
                    assert.equal(requests.some(request => request.path === `/article/${token}`), false, 'the late destination must not be requested after the caller budget expires');
                } finally {
                    concurrencyOptions.defaultTimeoutMs = previousBudget;
                    gap?.restore();
                    if (sessionId) await sessionManager.close(sessionId, ownerId);
                }
            });
            await suite.test(`${name} waits for the complete body after a same-URL streaming HTTP 200 reload`, async () => {
                const token = randomUUID();
                const targetUrl = `${origin}/progressive/${token}`;
                const reload = installProgressiveReload(targetUrl);
                try {
                    const result = await call(name, { url: targetUrl });
                    const state = progressiveStreams.get(token);
                    console.log(JSON.stringify({ test: 'http-partial-body-complete', tool: name, ...reload.evidence, partialSent: state?.partialSent, finalSent: state?.finalSent, isError: result.isError, hasFinalTail: normalizedText(result).includes(`FINAL ARTICLE END ${token}`), ...(result.isError ? { result: textOf(result).slice(0, 450) } : {}) }));
                    assert.equal(reload.evidence.readyState, 'loading', 'the tool must receive a genuinely incomplete native document');
                    assert.ok(reload.evidence.bodyLength > 500, 'a substantial, readable partial body must exist');
                    assert.notEqual(reload.evidence.documentVersion, reload.evidence.previousVersion, 'the identical URL must contain a new document');
                    assert.equal(reload.evidence.href, targetUrl);
                    assert.ok(!result.isError, textOf(result));
                    assert.match(normalizedText(result), new RegExp(`DOCUMENT GAP FINAL ${token}`));
                    assert.match(normalizedText(result), new RegExp(`FINAL ARTICLE END ${token}`));
                    assert.equal(state.finalSent, true, 'the server must actually deliver the late body before success');
                    assert.equal(progressiveRequests.get(token), 2, 'the reader must not repeat the reload or navigation');
                    assert.equal(reload.evidence.pageClosed, true, 'the tool-owned page must close after the completed read');
                    if (name === 'web_fetch_page') assert.ok(normalizedText(result).includes(`${targetUrl}?source-proof=1`));
                    else assert.match(textOf(result), /href="\?source-proof=1"/);
                } finally { reload.restore(); }
            });
            await suite.test(`${name} expires and closes a partially streamed body within the original request deadline`, async () => {
                const token = randomUUID();
                const targetUrl = `${origin}/progressive/${token}?slow=1`;
                const reload = installProgressiveReload(targetUrl);
                const previousBudget = concurrencyOptions.defaultTimeoutMs;
                concurrencyOptions.defaultTimeoutMs = 1400;
                const started = performance.now();
                try {
                    const result = await call(name, { url: targetUrl });
                    const elapsedMs = performance.now() - started;
                    const state = progressiveStreams.get(token);
                    for (let attempt = 0; state && !state.closed && attempt < 12; attempt++) await sleep(25);
                    console.log(JSON.stringify({ test: 'http-partial-body-deadline-cleanup', tool: name, elapsedMs: Math.round(elapsedMs), ...reload.evidence, isError: result.isError, partialSent: state?.partialSent, finalSent: state?.finalSent, responseClosed: state?.closed, pendingTimers: state?.pendingTimers.size, result: textOf(result).slice(0, 300) }));
                    assert.equal(reload.evidence.readyState, 'loading');
                    assert.equal(result.isError, true, 'a readable partial article must not be returned as a complete result');
                    assert.match(textOf(result), /deadline|timeout|time.*out|期限|超时/i);
                    assert.ok(elapsedMs >= 1100 && elapsedMs < 2200, `the original 1400ms budget consumed ${Math.round(elapsedMs)}ms`);
                    assert.equal(reload.evidence.pageClosed, true);
                    assert.equal(state.partialSent, true);
                    assert.equal(state.finalSent, false, 'expiry must stop the server before the late article tail is sent');
                    assert.equal(state.closed, true);
                    assert.equal(state.pendingTimers.size, 0);
                    assert.equal(progressiveRequests.get(token), 2);
                } finally {
                    concurrencyOptions.defaultTimeoutMs = previousBudget;
                    reload.restore();
                }
            });
        }

        await suite.test('web_fetch_html URL keeps its 1000ms deadline when initial readiness loses the body', async () => {
            const token = randomUUID();
            const warm = await call('web_fetch_html', { url: `${origin}/bridge/${randomUUID()}` });
            assert.ok(!warm.isError, textOf(warm));
            const previousBudget = concurrencyOptions.defaultTimeoutMs;
            activeGap = { stage: 'readiness', destination: `${origin}/article/${token}`, delay: 2500, readRequestContext: getRequestContext };
            latestGap = undefined;
            concurrencyOptions.defaultTimeoutMs = 1000;
            const started = performance.now();
            try {
                const result = await call('web_fetch_html', { url: `${origin}/bridge/${token}`, scrollCount: 1, timeout: 1000 });
                const elapsedMs = performance.now() - started;
                assert.ok(latestGap, 'the real HTML URL tool must create an instrumented fixture page');
                const evidence = latestGap.evidence;
                const failure = result._meta?.webFetcherReadFailure;
                console.log(JSON.stringify({ test: 'html-url-readiness-body-gap-deadline', elapsedMs: Math.round(elapsedMs), isError: result.isError, failure, deadlineAfter: latestGap.deadlineAfter, pageClosed: latestGap.pageClosed, lateTargetRequests: requests.filter(request => request.path === `/article/${token}`).length, result: textOf(result).slice(0, 650), ...evidence }));
                assertGap(evidence);
                assert.equal(evidence.injectionPhase, 'readiness.content.sample');
                assert.equal(evidence.injectionSample, 1, 'the gap must open during the first readiness sample');
                assert.ok(evidence.gapIntroducedAt < evidence.deadlineBefore, 'native body-null must occur before expiry');
                assert.equal(evidence.deadlineBefore - evidence.requestStartedAt, 1000);
                assert.equal(latestGap.deadlineAfter, evidence.deadlineBefore, 'HTML readiness must not extend the original deadline');
                assert.equal(evidence.snapshots, 0, 'this failure must happen in readiness before any scroll metrics read');
                assert.equal(evidence.scrollCommands, 0);
                assert.equal(result.isError, true, 'an incomplete HTML document must not yield empty success');
                assert.match(textOf(result), /deadline|timeout|time.*out|期限|超时/i);
                assert.match(failure?.phase ?? '', /^readiness\.content(?:\.sample)?$/);
                assert.ok(elapsedMs >= 800 && elapsedMs < 1800, `the original HTML 1000ms request consumed ${Math.round(elapsedMs)}ms`);
                assert.equal(latestGap.pageClosed, true, 'the expired HTML-owned page must really close');
                assert.equal(requests.some(request => request.path === `/article/${token}`), false, 'the 2500ms destination must never be requested');
            } finally {
                concurrencyOptions.defaultTimeoutMs = previousBudget;
                activeGap = undefined;
                latestGap?.restore();
                restorers.delete(latestGap);
            }
        });

        await suite.test('cancelling a pending complete-document read closes its page and never calls the reader', async () => {
            await directPage(async page => {
                const token = randomUUID();
                await page.goto(`${origin}/progressive/${token}?stream=1&slow=1`, { waitUntil: 'commit' });
                await page.waitForFunction(() => document.body?.textContent?.includes('PARTIAL STREAM MARKER') && document.readyState === 'loading');
                const controller = new AbortController();
                const listenersBefore = page.listenerCount('framenavigated');
                let closeOperation;
                const onAbort = () => { closeOperation = page.close(); };
                controller.signal.addEventListener('abort', onAbort, { once: true });
                const abortTimer = setTimeout(() => controller.abort(), 80);
                const started = performance.now();
                let readAttempts = 0;
                let deadlineBefore;
                let deadlineAfter;
                let failure;
                try {
                    await runWithRequestContext({ ownerId, timeoutMs: 1400, signal: controller.signal }, async () => {
                        getRequestContext().leasedPages.add(page);
                        deadlineBefore = getRequestContext().deadline;
                        try {
                            await readDuringNavigation(page, () => { readAttempts++; return page.content(); }, { phase: 'fixture.partial-body-cancel', requireDocumentReady: true });
                        } catch (error) { failure = error; }
                        finally { deadlineAfter = getRequestContext().deadline; }
                    });
                    await closeOperation;
                    const elapsedMs = performance.now() - started;
                    const state = progressiveStreams.get(token);
                    for (let attempt = 0; !state.closed && attempt < 12; attempt++) await sleep(25);
                    console.log(JSON.stringify({ test: 'partial-body-cancel-cleanup', elapsedMs: Math.round(elapsedMs), readAttempts, deadlineBefore, deadlineAfter, code: failure?.code, pageClosed: page.isClosed(), responseClosed: state.closed, pendingTimers: state.pendingTimers.size, listenersBefore, listenersAfter: page.listenerCount('framenavigated') }));
                    assert.equal(failure?.code, 'request_cancelled');
                    assert.equal(readAttempts, 0, 'the final read bundle must not run while document.readyState is loading');
                    assert.equal(deadlineAfter, deadlineBefore);
                    assert.ok(elapsedMs >= 60 && elapsedMs < 700);
                    assert.equal(page.isClosed(), true);
                    assert.equal(page.listenerCount('framenavigated'), listenersBefore);
                    assert.equal(state.closed, true);
                    assert.equal(state.finalSent, false);
                    assert.equal(state.pendingTimers.size, 0);
                } finally {
                    clearTimeout(abortTimer);
                    controller.signal.removeEventListener('abort', onAbort);
                    await closeOperation?.catch(() => {});
                }
            });
        });

        await suite.test('a body gap outliving the scroll request expires within the original total deadline', async () => {
            await directPage(async page => {
                const token = randomUUID();
                await page.goto(`${origin}/bridge/${token}`);
                const gap = installDocumentGap(page, { stage: 'before', destination: `${origin}/article/${token}`, delay: 2500 });
                const started = performance.now();
                let deadlineBefore;
                let deadlineAfter;
                let failure;
                try {
                    await runWithRequestContext({ ownerId, timeoutMs: 220 }, async () => {
                        deadlineBefore = getRequestContext().deadline;
                        try { await browserManager.scrollPage(page, 1); }
                        catch (error) { failure = error; }
                        finally { deadlineAfter = getRequestContext().deadline; }
                    });
                    const elapsedMs = performance.now() - started;
                    console.log(JSON.stringify({ test: 'original-scroll-deadline', elapsedMs: Math.round(elapsedMs), deadlineBefore, deadlineAfter, message: failure?.message, diagnostics: failure?.diagnostics, ...gap.evidence }));
                    assertGap(gap.evidence);
                    assert.ok(failure, 'an unfinished document gap must fail rather than report blank success');
                    assert.match(failure.message, /deadline|timeout|time.*out|期限|超时/i);
                    assert.equal(deadlineAfter, deadlineBefore, 'document recovery must not replace or extend the caller deadline');
                    assert.ok(elapsedMs >= 150 && elapsedMs < 850, `the 220ms request consumed ${Math.round(elapsedMs)}ms`);
                    assert.ok(!gap.evidence.commits.some(url => url.includes(`/article/${token}`)), 'the late article must not be fetched after expiry');
                } finally { gap.restore(); }
            });
        });

        await suite.test('an ordinary native script TypeError on a stable document is attempted once', async () => {
            await directPage(async page => {
                await page.goto(`${origin}/article/${randomUUID()}`);
                let attempts = 0;
                let failure;
                try {
                    await runWithRequestContext({ ownerId, timeoutMs: 900 }, () => readDuringNavigation(page, () => {
                        attempts++;
                        return page.evaluate(() => { const ordinaryMissingValue = null; return ordinaryMissingValue.unrelatedProperty; });
                    }, { phase: 'fixture.ordinary-script', maxRetries: 5 }));
                } catch (error) { failure = error; }
                console.log(JSON.stringify({ test: 'ordinary-typeerror-no-retry', attempts, diagnostics: failure?.diagnostics }));
                assert.match(failure?.message ?? '', /TypeError.*unrelatedProperty/s);
                assert.equal(attempts, 1);
                assert.equal(failure.diagnostics.retries, 0);
                assert.equal(failure.diagnostics.code, 'page_read_failed');
            });
        });

        for (const action of ['click', 'submit']) {
            await suite.test(`web_interact ${action} commits one server-side effect across a bodyless transition`, async () => {
                const token = randomUUID();
                const destination = `${origin}/article/${token}`;
                let sessionId;
                let clickCount = 0;
                let originalClick;
                let ownedPage;
                const observedGaps = [];
                try {
                    const opened = await call('web_interact', { url: `${origin}/actions/${token}`, action: 'wait', selector: '#counter-click' });
                    sessionId = textOf(opened).match(/SessionId:\s*(session_[\w-]+)/)?.[1];
                    assert.ok(!opened.isError && sessionId, textOf(opened));
                    ownedPage = sessionManager.get(sessionId, ownerId);
                    assert.ok(ownedPage);
                    await ownedPage.exposeFunction('__documentGapObserved', observation => { observedGaps.push(observation); });
                    originalClick = ownedPage.click.bind(ownedPage);
                    ownedPage.click = async (...arguments_) => { clickCount++; return originalClick(...arguments_); };
                    const result = await call('web_interact', { sessionId, action: 'click', selector: action === 'click' ? '#counter-click' : '#counter-submit', waitForEvents: false });
                    const content = await call('web_fetch_page', { sessionId, scrollCount: 1 });
                    console.log(JSON.stringify({ test: 'action-no-replay', action, clickCount, effects: effects.get(token), observedGaps, finalHref: ownedPage.url(), isError: result.isError, result: textOf(result).slice(0, 250), contentIsError: content.isError }));
                    assert.ok(!result.isError, textOf(result));
                    assert.ok(observedGaps.some(observation => observation.bodyNull), 'the real click/submit transition must actually lack a body');
                    assert.ok(!content.isError, textOf(content));
                    assert.match(normalizedText(content), new RegExp(`FINAL ARTICLE END ${token}`));
                    assert.equal(ownedPage.url(), destination);
                    assert.equal(clickCount, 1, 'a click or form submission must not be dispatched twice');
                    assert.equal(effects.get(token), 1, 'the HTTP server must record exactly one real POST effect');
                    const posts = requests.filter(request => request.method === 'POST' && request.path === `/${action === 'click' ? 'effect' : 'submit'}/${token}`);
                    assert.equal(posts.length, 1);
                } finally {
                    if (ownedPage && originalClick) ownedPage.click = originalClick;
                    if (sessionId) await sessionManager.close(sessionId, ownerId);
                }
            });
        }
        assert.equal(visibleOpenAttempts, 0);
    } finally {
        activeGap = undefined;
        for (const restorer of restorers) restorer.restore();
        humanBrowserManager.open = originalHumanOpen;
        const cleanupErrors = [];
        await sessionManager.closeAllForOwner(ownerId).catch(error => cleanupErrors.push(error.message));
        await browserManager.shutdown().catch(error => cleanupErrors.push(error.message));
        await context?.close().catch(() => {});
        if (connected) await client.close().catch(() => {});
        await service.close().catch(() => {});
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections();
        if (server.listening) await new Promise(resolve => server.close(resolve));
        assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(temporary).startsWith('web-fetcher-document-gap-'));
        await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        if (previousProfileBase === undefined) delete process.env.WEB_FETCHER_PROFILE_BASE_DIR;
        else process.env.WEB_FETCHER_PROFILE_BASE_DIR = previousProfileBase;
        console.log(JSON.stringify({ fixture: 'document-gap-cleanup', browserClosed: !context || contextClosed, serverClosed: !server.listening, temporaryRemoved: true, pendingStreamTimers: timers.size, visibleOpenAttempts, cleanupErrors }));
        assert.equal(!context || contextClosed, true);
        assert.deepEqual(cleanupErrors, []);
        assert.equal(visibleOpenAttempts, 0);
    }
});
