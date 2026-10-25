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
const article = marker => `<!doctype html><html><head><title>${marker}</title></head><body><article id="article"><h1>${marker}</h1><p>${'A local article with useful, readable paragraphs for navigation regression coverage. '.repeat(12)}</p><p><a href="?source-proof=1">SOURCE PROOF LINK</a></p><p>FINAL ARTICLE END</p></article></body></html>`;

function installReadRace(page, options) {
    const originalEvaluate = page.evaluate.bind(page);
    const originalContent = page.content.bind(page);
    const originalQuery = page.$.bind(page);
    const originalLocator = page.locator.bind(page);
    const evidence = { injected: 0, nativeErrors: [], commits: [], selectorLookups: 0 };
    const frameRestorers = [];
    const recordNavigation = frame => {
        if (frame === page.mainFrame()) evidence.commits.push({ url: frame.url(), at: performance.now() });
    };
    page.on('framenavigated', recordNavigation);
    const interrupt = async () => {
        evidence.injected++;
        try {
            await originalEvaluate(async ({ destination, navigationDelay, evaluationDelay }) => {
                setTimeout(() => location.replace(destination), navigationDelay);
                await new Promise(resolve => setTimeout(resolve, evaluationDelay));
            }, { destination: options.destination, navigationDelay: options.navigationDelay ?? 30, evaluationDelay: options.evaluationDelay ?? 300 });
        } catch (error) {
            evidence.nativeErrors.push({ name: error.name, message: error.message });
            await options.afterInterruption?.();
            throw error;
        }
    };
    if (options.stage === 'readiness') {
        page.evaluate = async (callback, argument) => {
            if (!evidence.injected && argument && typeof argument.visual === 'boolean' && typeof argument.fullPage === 'boolean') await interrupt();
            return originalEvaluate(callback, argument);
        };
    } else if (options.stage === 'content') {
        page.content = async () => {
            if (!evidence.injected) await interrupt();
            return originalContent();
        };
    } else if (options.stage === 'selector') {
        const interruptElement = async (evaluate, all = false) => {
            evidence.injected++;
            try {
                await evaluate(async (element, { destination, all }) => {
                    setTimeout(() => location.replace(destination), 30);
                    await new Promise(resolve => setTimeout(resolve, 300));
                    return all ? element[0]?.outerHTML ?? null : element.outerHTML;
                }, { destination: options.destination, all });
            } catch (error) {
                evidence.nativeErrors.push({ name: error.name, message: error.message });
                throw error;
            }
        };
        page.$ = async selector => {
            evidence.selectorLookups++;
            const element = await originalQuery(selector);
            if (element && !evidence.injected) {
                const originalElementEvaluate = element.evaluate.bind(element);
                element.evaluate = async (...arguments_) => {
                    if (!evidence.injected) await interruptElement(originalElementEvaluate);
                    return originalElementEvaluate(...arguments_);
                };
            }
            return element;
        };
        const wrapLocator = locator => {
            const originalLocatorEvaluate = locator.evaluate.bind(locator);
            const originalEvaluateAll = locator.evaluateAll.bind(locator);
            const originalFirst = locator.first.bind(locator);
            locator.evaluate = async (...evaluationArguments) => {
                if (!evidence.injected) await interruptElement(originalLocatorEvaluate);
                return originalLocatorEvaluate(...evaluationArguments);
            };
            locator.evaluateAll = async (...evaluationArguments) => {
                if (!evidence.injected) await interruptElement(originalEvaluateAll, true);
                return originalEvaluateAll(...evaluationArguments);
            };
            locator.first = () => wrapLocator(originalFirst());
            return locator;
        };
        page.locator = (...arguments_) => {
            evidence.selectorLookups++;
            return wrapLocator(originalLocator(...arguments_));
        };
    } else if (options.stage === 'after-content') {
        evidence.contentReads = 0;
        evidence.contentTitles = [];
        page.content = async () => {
            const html = await originalContent();
            evidence.contentReads++;
            evidence.contentTitles.push(html.match(/<title>([^<]*)<\/title>/i)?.[1]);
            return html;
        };
        page.evaluate = async (callback, argument) => {
            const source = callback.toString();
            if (!evidence.injected && evidence.contentReads > 0 && source.includes('hasPasswordInput') && source.includes('scriptUrls')) await interrupt();
            return originalEvaluate(callback, argument);
        };
    } else if (options.stage === 'frame-bundle') {
        evidence.oldFrameExtracts = 0;
        evidence.detachedFrames = 0;
        const recordFrame = frame => {
            const originalFrameEvaluate = frame.evaluate.bind(frame);
            frame.evaluate = async (...arguments_) => {
                const result = await originalFrameEvaluate(...arguments_);
                if (typeof result === 'string' && result.includes('IFRAME STALE CONTENT')) evidence.oldFrameExtracts++;
                return result;
            };
            frameRestorers.push(() => { frame.evaluate = originalFrameEvaluate; });
        };
        const recordDetachment = () => { evidence.detachedFrames++; };
        page.on('frameattached', recordFrame);
        page.on('framedetached', recordDetachment);
        frameRestorers.push(() => {
            page.off('frameattached', recordFrame);
            page.off('framedetached', recordDetachment);
        });
        page.evaluate = async (callback, argument) => {
            const source = callback.toString();
            if (!evidence.injected && evidence.oldFrameExtracts > 0 && source.includes('documentVersion') && source.includes('title')) await interrupt();
            return originalEvaluate(callback, argument);
        };
    }
    return {
        evidence,
        restore() {
            page.evaluate = originalEvaluate;
            page.content = originalContent;
            page.$ = originalQuery;
            page.locator = originalLocator;
            page.off('framenavigated', recordNavigation);
            for (const restore of frameRestorers) restore();
        },
    };
}

function assertRealInterruption(evidence, destination) {
    assert.equal(evidence.injected, 1, 'the intended read must have been interrupted');
    assert.equal(evidence.nativeErrors.length, 1, 'a real browser evaluation must reject');
    assert.match(evidence.nativeErrors[0].message, /context.*destroyed|navigation|document.*unload/i);
    assert.ok(evidence.commits.some(commit => commit.url === destination), `missing real main-frame commit: ${JSON.stringify(evidence)}`);
}

test('navigation-safe reads through real HTTP MCP and isolated headless Edge', { skip: !enabled, timeout: 90_000 }, async suite => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'web-fetcher-navigation-read-'));
    const previousProfileBase = process.env.WEB_FETCHER_PROFILE_BASE_DIR;
    process.env.WEB_FETCHER_PROFILE_BASE_DIR = path.join(temporary, 'auth');
    const { browserManager } = await loadModule('browser');
    const { humanBrowserManager } = await loadModule('human-browser/manager');
    const { installToolConcurrency } = await loadModule('tool-concurrency');
    const { registerFetchPage } = await loadModule('tools/fetch-page');
    const { registerFetchHtml } = await loadModule('tools/fetch-html');
    const { registerInteract } = await loadModule('tools/interact');
    const { sessionManager } = await loadModule('session');
    const { TEMP_PAGE_PREFIX } = await loadModule('constants');
    const { waitForPageReadiness } = await loadModule('readiness');
    const { readDuringNavigation } = await loadModule('navigation-read');
    const { safePageContent } = await loadModule('extractor');
    const { runWithRequestContext, getRequestContext } = await loadModule('request-context');
    const service = new McpServer({ name: 'navigation-read-http-fixture', version: '1' });
    installToolConcurrency(service, { defaultTimeoutMs: 6000 });
    registerFetchPage(service);
    registerFetchHtml(service);
    registerInteract(service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    const requests = [];
    const sideEffects = new Map();
    const savedMarkdown = new Set();
    const server = http.createServer((request, response) => {
        const target = new URL(request.url, 'http://127.0.0.1');
        if (target.pathname === '/mcp') {
            void transport.handleRequest(request, response).catch(error => {
                if (!response.headersSent) response.writeHead(500);
                response.end(String(error));
            });
            return;
        }
        requests.push(target.pathname);
        if (target.pathname.startsWith('/evaluate-counter/')) {
            const key = target.pathname.slice('/evaluate-counter/'.length);
            if (request.method === 'POST') sideEffects.set(key, (sideEffects.get(key) ?? 0) + 1);
            response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            response.end(JSON.stringify({ count: sideEffects.get(key) ?? 0 }));
            return;
        }
        if (target.pathname === '/redirect') {
            response.writeHead(302, { Location: '/final', 'Cache-Control': 'no-store' });
            response.end();
            return;
        }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        if (target.pathname === '/delayed' || target.pathname === '/chain/first' || target.pathname === '/chain/second') {
            const destination = target.pathname === '/chain/first' ? '/chain/second' : '/final';
            response.end(`<!doctype html><title>Moving</title><main aria-busy="true">Moving to the article</main><script>setTimeout(()=>location.replace('${destination}'),120)</script>`);
        } else if (target.pathname.startsWith('/same/')) {
            response.end('<!doctype html><title>Same document shape</title><main><h1>Identical text</h1><p>Identical text and identical geometry.</p></main>');
        } else if (target.pathname === '/challenge') {
            response.end('<!doctype html><title>Just a moment</title><p>Checking your browser</p><script src="/cdn-cgi/challenge-platform/fixture.js"></script>');
        } else if (target.pathname.includes('/challenge-platform/')) {
            response.end('');
        } else if (target.pathname === '/short') {
            response.end('<!doctype html><title>Ready</title><main>OK</main>');
        } else if (target.pathname === '/frame-parent') {
            response.end('<!doctype html><title>Frame parent</title><h1>FRAME PARENT</h1><iframe name="fixtureChild" src="/frame-child"></iframe>');
        } else if (target.pathname === '/frame-child') {
            response.end(article('IFRAME STALE CONTENT'));
        } else if (target.pathname === '/selector-two') {
            response.end('<!doctype html><title>Selector fixture</title><main>Readable fixture page</main><article class="choice" id="first-match">FIRST MATCH CONTENT</article><article class="choice" id="second-match">SECOND MATCH CONTENT</article>');
        } else if (target.pathname === '/selector-vanish') {
            response.end('<!doctype html><title>Selector fixture</title><main>Readable fixture page remains after the selected element disappears.</main><article id="vanishing">VANISHING MATCH CONTENT</article>');
        } else {
            response.end(article(target.pathname === '/final' ? 'NAVIGATION FINAL CONTENT' : 'NAVIGATION INITIAL CONTENT'));
        }
    });
    const client = new Client({ name: 'navigation-read-http-client', version: '1' });
    const ownerId = `navigation-read-${randomUUID()}`;
    const call = (name, args) => client.callTool({ name, arguments: { ownerId, humanAssistance: 'never', timeout: 4000, ...args } }, undefined, { timeout: 9000 });
    const originalHumanOpen = humanBrowserManager.open;
    let visibleOpenAttempts = 0;
    humanBrowserManager.open = async () => {
        visibleOpenAttempts++;
        throw new Error('A visible browser must never be opened by navigation tests');
    };
    let context;
    let contextClosed = false;
    let activeRace;
    let latestRace;
    let connected = false;
    const directPage = async handler => {
        const page = await context.newPage();
        try { await handler(page); }
        finally { await page.close().catch(() => {}); }
    };
    try {
        await service.connect(transport);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
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
            if (activeRace) latestRace = installReadRace(page, activeRace);
        });
        browserManager.context = context;
        await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
        connected = true;
        const sourceHashes = {};
        const hashedModules = ['readiness', 'browser', 'extractor', 'tools/fetch-page', 'tools/fetch-html', 'tools/interact', 'navigation-read', 'page-access'];
        for (const name of hashedModules) {
            sourceHashes[name] = createHash('sha256').update(await fs.readFile(new URL(`${sourceRoot}${name}.${extension}`, import.meta.url))).digest('hex');
        }
        console.log(JSON.stringify({ fixture: 'navigation-read', sourceRoot, sourceHashes, node: process.version, browser: context.browser()?.version(), headless: true, isolatedProfile: true }));

        for (const name of ['web_fetch_page', 'web_fetch_html']) {
            for (const route of ['/redirect', '/delayed', '/chain/first']) {
                await suite.test(`${name} follows ${route} to the final article`, async () => {
                    const result = await call(name, { url: `${origin}${route}` });
                    assert.ok(!result.isError, textOf(result));
                    assert.match(normalizedText(result), /NAVIGATION FINAL CONTENT/);
                    assert.match(normalizedText(result), /FINAL ARTICLE END/);
                });
            }
            await suite.test(`${name} recovers a real first-readiness location.replace interruption`, async () => {
                activeRace = { stage: 'readiness', destination: `${origin}/final` };
                latestRace = undefined;
                try {
                    const result = await call(name, { url: `${origin}/initial?readiness=${name}` });
                    assert.ok(latestRace, 'an isolated fetch page must have been instrumented');
                    console.log(JSON.stringify({ tool: name, stage: 'readiness', ...latestRace.evidence, isError: result.isError, result: textOf(result).slice(0, 450) }));
                    assertRealInterruption(latestRace.evidence, `${origin}/final`);
                    assert.ok(!result.isError, textOf(result));
                    assert.match(normalizedText(result), /NAVIGATION FINAL CONTENT/);
                } finally { activeRace = undefined; latestRace?.restore(); }
            });
            await suite.test(`${name} re-reads final document after a content/selector interruption`, async () => {
                const destination = name === 'web_fetch_page' ? `${origin}/final?freeze=${randomUUID()}` : `${origin}/final`;
                activeRace = { stage: name === 'web_fetch_html' ? 'selector' : 'content', destination };
                latestRace = undefined;
                try {
                    const result = await call(name, { url: `${origin}/initial?content=${name}`, ...(name === 'web_fetch_html' ? { selector: '#article' } : { outputMode: 'summary' }) });
                    let summaryPath;
                    if (name === 'web_fetch_page') {
                        summaryPath = textOf(result).match(/已保存到:\s*([^\r\n]+)/)?.[1];
                        if (summaryPath) {
                            assert.equal(path.dirname(summaryPath), os.tmpdir());
                            assert.ok(path.basename(summaryPath).startsWith(TEMP_PAGE_PREFIX));
                            savedMarkdown.add(summaryPath);
                        }
                    }
                    assert.ok(latestRace);
                    console.log(JSON.stringify({ tool: name, stage: activeRace.stage, ...latestRace.evidence, isError: result.isError, result: textOf(result).slice(0, 450) }));
                    assertRealInterruption(latestRace.evidence, destination);
                    assert.ok(!result.isError, textOf(result));
                    assert.match(normalizedText(result), /NAVIGATION FINAL CONTENT/);
                    if (name === 'web_fetch_html') {
                        assert.match(textOf(result), /^<article\b/);
                        assert.doesNotMatch(textOf(result), /<!doctype|<html\b/i);
                    } else {
                        assert.ok(summaryPath, textOf(result));
                        const expectedHash = createHash('md5').update(destination).digest('hex').slice(0, 10);
                        assert.ok(path.basename(summaryPath).endsWith(`_${expectedHash}.md`), 'summary filename must identify the frozen snapshot URL');
                        const content = await fs.readFile(summaryPath, 'utf8');
                        const proofUrl = new URL('?source-proof=1', destination).href;
                        console.log(JSON.stringify({ stage: 'frozen-url-content', snapshotUrl: destination, expectedHash, savedFile: path.basename(summaryPath), proofUrl, correctTitle: /^# NAVIGATION FINAL CONTENT/.test(content) }));
                        assert.match(content, /^# NAVIGATION FINAL CONTENT/);
                        assert.match(content, /FINAL ARTICLE END/);
                        assert.ok(content.includes(proofUrl), 'relative link, formatted filename and body must refer to the same snapshot URL');
                    }
                } finally { activeRace = undefined; latestRace?.restore(); }
            });
        }

        await suite.test('web_fetch_html returns the first of two matching elements', async () => {
            const result = await call('web_fetch_html', { url: `${origin}/selector-two`, selector: '.choice' });
            assert.ok(!result.isError, textOf(result));
            assert.match(textOf(result), /<article\b[^>]*id="first-match"/);
            assert.match(textOf(result), /FIRST MATCH CONTENT/);
            assert.doesNotMatch(textOf(result), /SECOND MATCH CONTENT|second-match/);
            console.log(JSON.stringify({ stage: 'selector-first-match', isError: result.isError, firstOnly: true, result: textOf(result) }));
        });

        await suite.test('web_fetch_html returns immediate not-found when a selector disappears after navigateTo', async () => {
            const originalNavigateTo = browserManager.navigateTo;
            let removed = 0;
            let missingAt;
            browserManager.navigateTo = async (...arguments_) => {
                const page = await originalNavigateTo.apply(browserManager, arguments_);
                removed = await page.locator('#vanishing').evaluateAll(elements => {
                    for (const element of elements) element.remove();
                    return elements.length;
                });
                missingAt = performance.now();
                return page;
            };
            try {
                const result = await call('web_fetch_html', { url: `${origin}/selector-vanish`, selector: '#vanishing' });
                const emptyReadMs = performance.now() - missingAt;
                console.log(JSON.stringify({ stage: 'selector-vanished-after-navigation', removed, emptyReadMs: Math.round(emptyReadMs), isError: result.isError, result: textOf(result) }));
                assert.equal(removed, 1, 'navigateTo must first find the real selector before it is removed');
                assert.equal(result.isError, true, textOf(result));
                assert.match(textOf(result), /未找到选择器 "#vanishing" 匹配的元素/);
                assert.ok(emptyReadMs < 750, `zero matches waited ${Math.round(emptyReadMs)}ms instead of returning immediately`);
                assert.doesNotMatch(textOf(result), /Timeout|超时|页面读取期限已到/i);
            } finally { browserManager.navigateTo = originalNavigateTo; }
        });

        await suite.test('same-shaped replacement document receives a fresh quiet window', async () => {
            await directPage(async page => {
                await page.goto(`${origin}/same/first`, { waitUntil: 'domcontentloaded' });
                let committedAt;
                page.on('framenavigated', frame => { if (frame === page.mainFrame() && frame.url() === `${origin}/same/final`) committedAt = performance.now(); });
                await page.evaluate(destination => { setTimeout(() => location.replace(destination), 260); }, `${origin}/same/final`);
                const result = await waitForPageReadiness(page, { mode: 'content', maxWait: 2400, quietMs: 450, minimumObserveMs: 0 });
                const quietAfterCommit = performance.now() - committedAt;
                console.log(JSON.stringify({ stage: 'same-shaped-document', complete: result.complete, quietAfterCommit: Math.round(quietAfterCommit), waited: result.waited }));
                assert.equal(page.url(), `${origin}/same/final`);
                assert.ok(Number.isFinite(committedAt), 'the replacement document must really commit');
                assert.equal(result.complete, true);
                assert.ok(quietAfterCommit >= 425, `new document was quiet for only ${Math.round(quietAfterCommit)}ms; required 450ms`);
            });
        });

        await suite.test('same-URL reload receives a new document quiet window', async () => {
            await directPage(async page => {
                const target = `${origin}/same/reload`;
                await page.goto(target, { waitUntil: 'domcontentloaded' });
                const previousOrigin = await page.evaluate(() => performance.timeOrigin);
                let committedAt;
                page.on('framenavigated', frame => { if (frame === page.mainFrame() && frame.url() === target) committedAt = performance.now(); });
                await page.evaluate(() => { setTimeout(() => location.reload(), 260); });
                const result = await waitForPageReadiness(page, { mode: 'content', maxWait: 2400, quietMs: 450, minimumObserveMs: 0 });
                const quietAfterCommit = performance.now() - committedAt;
                const nextOrigin = await page.evaluate(() => performance.timeOrigin);
                console.log(JSON.stringify({ stage: 'same-url-reload', complete: result.complete, quietAfterCommit: Math.round(quietAfterCommit), waited: result.waited, previousOrigin, nextOrigin }));
                assert.equal(page.url(), target);
                assert.notEqual(nextOrigin, previousOrigin, 'reload must create a genuinely new document at the identical URL');
                assert.ok(Number.isFinite(committedAt));
                assert.equal(result.complete, true);
                assert.ok(quietAfterCommit >= 425, `reloaded document was quiet for only ${Math.round(quietAfterCommit)}ms`);
            });
        });

        await suite.test('detaching a reading frame terminates recovery without replay', async () => {
            await directPage(async page => {
                await page.goto(`${origin}/frame-parent?detach=1`, { waitUntil: 'domcontentloaded' });
                const iframe = await page.waitForSelector('iframe[name="fixtureChild"]', { timeout: 1000 });
                const frame = await iframe.contentFrame();
                assert.ok(frame, 'the real child frame must exist');
                await frame.waitForURL(`${origin}/frame-child`, { timeout: 1000 });
                await frame.waitForLoadState('domcontentloaded');
                let detachAction;
                let readAttempts = 0;
                const nativeErrors = [];
                let detachedEvents = 0;
                page.on('framedetached', detached => { if (detached === frame) detachedEvents++; });
                await page.exposeFunction('__navigationReadStarted', () => {
                    detachAction ??= sleep(30).then(() => page.locator('iframe[name="fixtureChild"]').evaluate(element => element.remove()));
                });
                const started = performance.now();
                try {
                    await assert.rejects(runWithRequestContext({ ownerId, timeoutMs: 1200 }, () => readDuringNavigation(frame, async () => {
                        readAttempts++;
                        try {
                            return await frame.evaluate(async () => {
                                await window.__navigationReadStarted();
                                await new Promise(resolve => setTimeout(resolve, 600));
                                return document.body.innerText;
                            });
                        } catch (error) { nativeErrors.push(error.message); throw error; }
                    }, { phase: 'fixture.frame-detached', timeoutMs: 1000 })), error => /detached|脱离|frame.*closed/i.test(error.message));
                    await detachAction;
                    console.log(JSON.stringify({ stage: 'frame-detached', elapsed: Math.round(performance.now() - started), readAttempts, detachedEvents, nativeErrors }));
                    assert.equal(frame.isDetached(), true);
                    assert.equal(detachedEvents, 1);
                    assert.equal(readAttempts, 1);
                    assert.equal(nativeErrors.length, 1);
                    assert.match(nativeErrors[0], /detached|context.*destroyed|frame.*closed/i);
                    assert.equal(page.isClosed(), false);
                    assert.ok(performance.now() - started < 1000);
                } finally { await detachAction?.catch(() => {}); }
            });
        });

        await suite.test('web_fetch_page discards extracted old iframe content after a parent document change', async () => {
            const destination = `${origin}/final?frame-bundle=1`;
            activeRace = { stage: 'frame-bundle', destination };
            latestRace = undefined;
            try {
                const result = await call('web_fetch_page', { url: `${origin}/frame-parent?bundle=1` });
                assert.ok(latestRace);
                console.log(JSON.stringify({ tool: 'web_fetch_page', stage: 'frame-bundle', ...latestRace.evidence, isError: result.isError, result: textOf(result).slice(0, 450) }));
                assertRealInterruption(latestRace.evidence, destination);
                assert.ok(latestRace.evidence.oldFrameExtracts > 0, 'old child text must actually have been read before the replacement');
                assert.ok(latestRace.evidence.detachedFrames > 0);
                assert.ok(!result.isError, textOf(result));
                assert.match(normalizedText(result), /NAVIGATION FINAL CONTENT/);
                assert.doesNotMatch(normalizedText(result), /IFRAME STALE CONTENT/);
            } finally { activeRace = undefined; latestRace?.restore(); }
        });

        await suite.test('stable short content avoids an additional fixed navigation delay', async () => {
            await directPage(async page => {
                await page.goto(`${origin}/short`, { waitUntil: 'domcontentloaded' });
                const started = performance.now();
                const result = await waitForPageReadiness(page, { mode: 'content', maxWait: 3000 });
                assert.equal(result.complete, true);
                const elapsed = performance.now() - started;
                console.log(JSON.stringify({ stage: 'stable-short-page', waited: result.waited, elapsed: Math.round(elapsed) }));
                assert.ok(elapsed < 1400, `stable short page needed ${Math.round(elapsed)}ms`);
            });
        });

        await suite.test('read recovery retains the original short request deadline', async () => {
            await directPage(async page => {
                await page.goto(`${origin}/initial`, { waitUntil: 'domcontentloaded' });
                const race = installReadRace(page, { stage: 'content', destination: `${origin}/final`, navigationDelay: 220, evaluationDelay: 600 });
                const started = performance.now();
                let deadlineBefore;
                let deadlineAfter;
                try {
                    await assert.rejects(runWithRequestContext({ ownerId, toolName: 'navigation-deadline-fixture', timeoutMs: 120 }, async () => {
                        deadlineBefore = getRequestContext().deadline;
                        try { return await safePageContent(page); }
                        finally { deadlineAfter = getRequestContext().deadline; }
                    }), error => error.code === 'request_deadline_exceeded' || /期限|deadline/i.test(error.message));
                    const elapsed = performance.now() - started;
                    console.log(JSON.stringify({ stage: 'original-deadline', budget: 120, elapsed: Math.round(elapsed), deadlineUnchanged: deadlineBefore === deadlineAfter }));
                    assert.equal(deadlineAfter, deadlineBefore, 'read recovery must not extend the original request deadline');
                    assert.ok(elapsed < 500, `120ms request deadline needed ${Math.round(elapsed)}ms`);
                    await page.waitForURL(`${origin}/final`, { timeout: 1000 });
                    await sleep(10);
                    assertRealInterruption(race.evidence, `${origin}/final`);
                } finally { race.restore(); }
            });
        });

        await suite.test('cancellation wins over a real navigation interruption', async () => {
            await directPage(async page => {
                await page.goto(`${origin}/initial`, { waitUntil: 'domcontentloaded' });
                const controller = new AbortController();
                const race = installReadRace(page, { stage: 'readiness', destination: `${origin}/final`, afterInterruption: () => controller.abort() });
                const started = performance.now();
                try {
                    await assert.rejects(runWithRequestContext({ ownerId, signal: controller.signal, timeoutMs: 1500 }, () => waitForPageReadiness(page, { mode: 'content', maxWait: 4000 })), error => error.code === 'request_cancelled' || /取消|abort|cancel/i.test(error.message));
                    assert.ok(performance.now() - started < 1000);
                    await page.waitForURL(`${origin}/final`, { timeout: 1000 });
                    await sleep(10);
                    assertRealInterruption(race.evidence, `${origin}/final`);
                } finally { race.restore(); }
            });
        });

        await suite.test('closed page terminates recovery without opening a replacement', async () => {
            await directPage(async page => {
                await page.goto(`${origin}/initial`, { waitUntil: 'domcontentloaded' });
                const race = installReadRace(page, { stage: 'readiness', destination: `${origin}/final`, afterInterruption: () => page.close() });
                const started = performance.now();
                const pagesBefore = context.pages().length;
                try {
                    await assert.rejects(runWithRequestContext({ ownerId, timeoutMs: 1500 }, () => waitForPageReadiness(page, { mode: 'content', maxWait: 4000 })));
                    assert.ok(performance.now() - started < 1000);
                    assert.equal(page.isClosed(), true);
                    assert.equal(race.evidence.injected, 1);
                    assert.equal(context.pages().length, pagesBefore - 1, 'closed target must not be replaced by another page');
                } finally { race.restore(); }
            });
        });

        for (const name of ['web_fetch_page', 'web_fetch_html']) {
            await suite.test(`${name} detects a challenge reached during final content reading`, async () => {
                const destination = `${origin}/challenge?after-read=${name}`;
                activeRace = { stage: 'after-content', destination };
                latestRace = undefined;
                try {
                    const result = await call(name, { url: `${origin}/initial?after-read-challenge=${name}` });
                    assert.ok(latestRace);
                    console.log(JSON.stringify({ tool: name, stage: 'late-challenge', ...latestRace.evidence, isError: result.isError, status: result.structuredContent?.pageAccess?.status }));
                    assertRealInterruption(latestRace.evidence, destination);
                    assert.equal(result.isError, true, textOf(result));
                    assert.equal(result.structuredContent?.pageAccess?.status, 'challenge_required', textOf(result));
                    assert.ok(latestRace.evidence.contentReads >= 2, 'the HTML/access bundle must be re-read after the document changes');
                    assert.equal(latestRace.evidence.contentTitles[0], 'NAVIGATION INITIAL CONTENT');
                    assert.equal(latestRace.evidence.contentTitles.at(-1), 'Just a moment');
                    assert.equal(visibleOpenAttempts, 0);
                } finally { activeRace = undefined; latestRace?.restore(); }
            });
            await suite.test(`${name} returns a never-mode challenge without a visible window`, async () => {
                const started = performance.now();
                const result = await call(name, { url: `${origin}/challenge` });
                assert.equal(result.isError, true, textOf(result));
                assert.equal(result.structuredContent?.pageAccess?.status, 'challenge_required', textOf(result));
                assert.equal(visibleOpenAttempts, 0);
                assert.ok(performance.now() - started < 2500);
            });
        }

        await suite.test('web_interact arbitrary evaluate records one server-side effect before real navigation and is never replayed', async () => {
            const token = randomUUID();
            const destination = `${origin}/final?arbitrary-evaluate=${token}`;
            activeRace = { stage: 'observe', destination };
            latestRace = undefined;
            let sessionId;
            try {
                const result = await call('web_interact', {
                    url: `${origin}/initial?arbitrary-evaluate=${token}`,
                    action: 'evaluate',
                    value: `(async () => { await fetch('/evaluate-counter/${token}', { method: 'POST', body: 'increment' }); location.replace(${JSON.stringify(destination)}); await new Promise(resolve => setTimeout(resolve, 700)); return 'UNREACHED EVALUATE RESULT'; })()`,
                });
                sessionId = textOf(result).match(/SessionId:\s*(session_[\w-]+)/)?.[1];
                assert.ok(sessionId, textOf(result));
                const page = sessionManager.get(sessionId, ownerId);
                assert.ok(page, 'normal MCP session creation must retain the owned page');
                await page.waitForURL(destination, { timeout: 1000 });
                console.log(JSON.stringify({ tool: 'web_interact', stage: 'arbitrary-evaluate-no-replay', counter: sideEffects.get(token), commits: latestRace?.evidence.commits, isError: result.isError, result: textOf(result).slice(0, 450) }));
                assert.equal(result.isError, true, textOf(result));
                assert.match(textOf(result), /context.*destroyed|navigation/i);
                assert.ok(latestRace?.evidence.commits.some(commit => commit.url === destination));
                assert.equal(sideEffects.get(token), 1, 'arbitrary code must not repeat its server-side effect');
                assert.doesNotMatch(textOf(result), /evaluate 完成|UNREACHED EVALUATE RESULT/);
            } finally {
                activeRace = undefined;
                latestRace?.restore();
                if (sessionId) await sessionManager.close(sessionId, ownerId);
            }
        });
        assert.ok(requests.includes('/final'), 'the fixture server must receive real final-document requests');
        assert.equal(visibleOpenAttempts, 0);
    } finally {
        activeRace = undefined;
        latestRace?.restore();
        humanBrowserManager.open = originalHumanOpen;
        const cleanupErrors = [];
        await sessionManager.closeAllForOwner(ownerId).catch(error => cleanupErrors.push(error));
        await browserManager.shutdown().catch(error => cleanupErrors.push(error));
        await context?.close().catch(() => {});
        if (connected) await client.close().catch(() => {});
        await service.close().catch(() => {});
        server.closeAllConnections();
        if (server.listening) await new Promise(resolve => server.close(resolve));
        for (const file of savedMarkdown) await fs.rm(file, { force: true });
        assert.ok(path.basename(temporary).startsWith('web-fetcher-navigation-read-'));
        await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        if (previousProfileBase === undefined) delete process.env.WEB_FETCHER_PROFILE_BASE_DIR;
        else process.env.WEB_FETCHER_PROFILE_BASE_DIR = previousProfileBase;
        console.log(JSON.stringify({ fixture: 'navigation-read-cleanup', browserClosed: !context || contextClosed, serverClosed: !server.listening, temporaryRemoved: true, markdownFilesRemoved: savedMarkdown.size, visibleOpenAttempts }));
        assert.equal(!context || contextClosed, true, 'owned browser context must really close');
        assert.deepEqual(cleanupErrors, []);
    }
});
