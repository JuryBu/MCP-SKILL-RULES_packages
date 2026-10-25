import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const enabled = process.env.WEB_FETCHER_BROWSER_TESTS === '1';
const sourceRoot = process.env.WEB_FETCHER_TEST_BUILD === 'dist' ? '../dist/' : '../src/';
const extension = sourceRoot === '../src/' ? 'ts' : 'js';
const loadModule = name => import(new URL(`${sourceRoot}${name}.${extension}`, import.meta.url));
const textOf = result => result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
const article = status => `<!doctype html><html><head><title>REDIRECT FINAL ${status}</title><link rel="stylesheet" href="layout.css"></head><body><img id="asset" src="asset.svg" width="96" height="64"><button id="count-button" onclick="fetch('/effect/click',{method:'POST'}).then(response=>response.json()).then(result=>document.getElementById('count').textContent=result.count)">Count once</button><output id="count">0</output><article><h1>REDIRECT FINAL ${status}</h1><p>FINAL ARTICLE START ${status}</p><p>${'A complete local article verifies native redirects and final document identity. '.repeat(16)}</p><p><a id="relative" href="next?proof=${status}">SOURCE PROOF LINK</a></p><p>FINAL ARTICLE END ${status}</p></article></body></html>`;

test('redirect interception preserves native navigation in isolated headless Edge', { skip: !enabled, timeout: 120_000 }, async suite => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'web-fetcher-redirect-interception-'));
    const previousProfileBase = process.env.WEB_FETCHER_PROFILE_BASE_DIR;
    process.env.WEB_FETCHER_PROFILE_BASE_DIR = path.join(temporary, 'auth');
    const { browserManager } = await loadModule('browser');
    const { humanBrowserManager } = await loadModule('human-browser/manager');
    const { installToolConcurrency } = await loadModule('tool-concurrency');
    const { registerFetchPage } = await loadModule('tools/fetch-page');
    const { registerFetchHtml } = await loadModule('tools/fetch-html');
    const { registerFetchScreenshot } = await loadModule('tools/fetch-screenshot');
    const { registerInteract } = await loadModule('tools/interact');
    const { runWithRequestContext } = await loadModule('request-context');
    const { sessionManager } = await loadModule('session');
    const ownerId = `redirect-interception-${randomUUID()}`;
    const requests = [];
    const responses = [];
    const service = new McpServer({ name: 'redirect-interception-fixture', version: '1' });
    installToolConcurrency(service, { defaultTimeoutMs: 12_000 });
    registerFetchPage(service);
    registerFetchHtml(service);
    registerFetchScreenshot(service);
    registerInteract(service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    let clicks = 0;
    const server = http.createServer((request, response) => {
        const target = new URL(request.url, 'http://127.0.0.1');
        if (target.pathname === '/mcp') {
            void transport.handleRequest(request, response).catch(error => {
                if (!response.headersSent) response.writeHead(500);
                response.end(String(error));
            });
            return;
        }
        const entry = { method: request.method, pathname: target.pathname, search: target.search, body: '' };
        requests.push(entry);
        const redirect = target.pathname.match(/^\/start\/(302|307|308)$/);
        if (redirect) {
            const status = Number(redirect[1]);
            response.writeHead(status, { Location: `/article/${status}/final${target.search}`, 'Cache-Control': 'no-store', 'Content-Type': 'text/html' });
            response.end('<!doctype html><title>REDIRECT PLACEHOLDER</title>');
            return;
        }
        const submission = target.pathname.match(/^\/submit\/(303|307|308)$/);
        if (submission) {
            request.setEncoding('utf8');
            request.on('data', chunk => { entry.body += chunk; });
            request.on('end', () => {
                const status = Number(submission[1]);
                response.writeHead(status, { Location: `/receipt/${status}`, 'Cache-Control': 'no-store', 'Content-Type': 'text/html' });
                response.end('<!doctype html><title>SUBMISSION REDIRECT</title>');
            });
            return;
        }
        const receipt = target.pathname.match(/^\/receipt\/(303|307|308)$/);
        if (receipt) {
            request.setEncoding('utf8');
            request.on('data', chunk => { entry.body += chunk; });
            request.on('end', () => {
                response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
                response.end(`<!doctype html><title>Receipt ${receipt[1]}</title><main>RECEIPT FINAL ${receipt[1]}</main>`);
            });
            return;
        }
        const form = target.pathname.match(/^\/form\/(303|307|308)$/);
        if (form) {
            response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
            response.end(`<!doctype html><title>Form ${form[1]}</title><form method="post" action="/submit/${form[1]}"><input name="payload" value="once-${form[1]}"><button>Submit once</button></form>`);
            return;
        }
        if (target.pathname === '/effect/click') {
            if (request.method === 'POST') clicks++;
            request.resume();
            response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            response.end(JSON.stringify({ count: clicks }));
            return;
        }
        if (/^\/article\/(302|307|308)\/asset\.svg$/.test(target.pathname)) {
            response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
            response.end('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="96" height="64" fill="#e03131"/></svg>');
            return;
        }
        if (/^\/article\/(302|307|308)\/layout\.css$/.test(target.pathname)) {
            response.writeHead(200, { 'Content-Type': 'text/css', 'Cache-Control': 'no-store' });
            response.end('body { background: rgb(247, 249, 251); }');
            return;
        }
        const next = target.pathname.match(/^\/article\/(302|307|308)\/next$/);
        if (next) {
            response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
            response.end(`<!doctype html><title>Next ${next[1]}</title><main>NEXT FINAL ${next[1]}</main>`);
            return;
        }
        const final = target.pathname.match(/^\/article\/(302|307|308)\/final$/);
        if (final) {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            response.end(article(final[1]));
            return;
        }
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('FIXTURE NOT FOUND');
    });
    const client = new Client({ name: 'redirect-interception-client', version: '1' });
    const originalHumanOpen = humanBrowserManager.open;
    let visibleOpenAttempts = 0;
    humanBrowserManager.open = async () => {
        visibleOpenAttempts++;
        throw new Error('Redirect regression must not open a visible browser');
    };
    let context;
    let contextClosed = false;
    let connected = false;
    let origin;
    const call = (name, args) => client.callTool({ name, arguments: { ownerId, humanAssistance: 'never', timeout: 8000, ...args } }, undefined, { timeout: 15_000 });
    const readHashes = async () => {
        const hashes = {};
        for (const name of ['browser', 'navigation-read', 'readiness', 'tools/fetch-page', 'tools/fetch-html', 'tools/fetch-screenshot', 'tools/interact']) {
            hashes[name] = createHash('sha256').update(await fs.readFile(new URL(`${sourceRoot}${name}.${extension}`, import.meta.url))).digest('hex');
        }
        return hashes;
    };
    const withPage = handler => runWithRequestContext({ ownerId, timeoutMs: 10_000, humanAssistance: 'never', intent: 'redirect-regression' }, async () => {
        let page;
        try {
            const navigate = async pathname => {
                page = await browserManager.navigateTo(`${origin}${pathname}`, { timeout: 8000 });
                return page;
            };
            await handler(navigate);
        } finally { await page?.close(); }
    });
    try {
        await service.connect(transport);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        origin = `http://127.0.0.1:${server.address().port}`;
        context = await chromium.launchPersistentContext(path.join(temporary, 'edge'), {
            channel: 'msedge', headless: true, viewport: { width: 800, height: 600 },
        });
        context.on('close', () => { contextClosed = true; });
        if (sourceRoot === '../src/') await context.addInitScript(() => {
            Object.defineProperty(window, '__name', {
                value: (target, name) => Object.defineProperty(target, 'name', { value: name, configurable: true }),
                configurable: true,
            });
        });
        context.on('response', response => {
            if (response.request().isNavigationRequest()) responses.push({ url: response.url(), status: response.status(), location: response.headers().location });
        });
        browserManager.context = context;
        await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
        connected = true;
        const sourceHashes = await readHashes();
        console.log(JSON.stringify({ fixture: 'redirect-interception', sourceRoot, sourceHashes, node: process.version, browser: context.browser()?.version(), headless: true, isolatedProfile: true }));

        for (const status of [302, 307, 308]) {
            await suite.test(`${status} preserves Location, browser final URL, relative assets and href navigation`, async () => {
                const start = requests.length;
                const responseStart = responses.length;
                await withPage(async navigate => {
                    const page = await navigate(`/start/${status}?proof=${status}`);
                    const finalUrl = `${origin}/article/${status}/final?proof=${status}`;
                    assert.equal(page.url(), finalUrl);
                    const chain = responses.slice(responseStart);
                    assert.ok(chain.some(entry => entry.url === `${origin}/start/${status}?proof=${status}` && entry.status === status && entry.location === `/article/${status}/final?proof=${status}`), JSON.stringify(chain));
                    assert.ok(chain.some(entry => entry.url === finalUrl && entry.status === 200), JSON.stringify(chain));
                    await page.waitForFunction(() => document.querySelector('#asset').complete && document.querySelector('#asset').naturalWidth === 96);
                    assert.equal(await page.locator('#relative').evaluate(element => element.href), `${origin}/article/${status}/next?proof=${status}`);
                    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(247, 249, 251)');
                    assert.ok(requests.slice(start).some(entry => entry.pathname === `/article/${status}/asset.svg`));
                    assert.ok(requests.slice(start).some(entry => entry.pathname === `/article/${status}/layout.css`));
                    await Promise.all([page.waitForURL(`${origin}/article/${status}/next?proof=${status}`), page.locator('#relative').click()]);
                    assert.match(await page.locator('main').innerText(), new RegExp(`NEXT FINAL ${status}`));
                    console.log(JSON.stringify({ status, finalUrl, redirectResponses: chain, relativeAsset: true, relativeHref: page.url() }));
                });
            });
        }

        for (const status of [303, 307, 308]) {
            await suite.test(`POST ${status} is submitted once and preserves native redirect method semantics`, async () => {
                const start = requests.length;
                await withPage(async navigate => {
                    const page = await navigate(`/form/${status}`);
                    await Promise.all([page.waitForURL(`${origin}/receipt/${status}`), page.getByRole('button', { name: 'Submit once' }).click()]);
                    assert.match(await page.locator('main').innerText(), new RegExp(`RECEIPT FINAL ${status}`));
                    const submitted = requests.slice(start).filter(entry => entry.pathname === `/submit/${status}`);
                    const received = requests.slice(start).filter(entry => entry.pathname === `/receipt/${status}`);
                    assert.equal(submitted.length, 1, JSON.stringify(submitted));
                    assert.equal(submitted[0].method, 'POST');
                    assert.equal(submitted[0].body, `payload=once-${status}`);
                    assert.equal(received.length, 1, JSON.stringify(received));
                    assert.equal(received[0].method, status === 303 ? 'GET' : 'POST');
                    assert.equal(received[0].body, status === 303 ? '' : `payload=once-${status}`);
                    console.log(JSON.stringify({ status, submitted, received, finalUrl: page.url() }));
                });
            });
        }

        for (const status of [302, 307, 308]) for (const name of ['web_fetch_page', 'web_fetch_html']) {
            await suite.test(`${name} returns the final complete article after ${status} through HTTP MCP`, async () => {
                const result = await call(name, { url: `${origin}/start/${status}?proof=tool`, ...(name === 'web_fetch_page' ? { outputMode: 'full' } : {}) });
                const content = textOf(result);
                assert.ok(!result.isError, content);
                assert.match(content, new RegExp(`REDIRECT FINAL ${status}`));
                assert.match(content, new RegExp(`FINAL ARTICLE START ${status}`));
                assert.match(content, new RegExp(`FINAL ARTICLE END ${status}`));
                assert.doesNotMatch(content, /REDIRECT PLACEHOLDER|FIXTURE NOT FOUND/);
                if (name === 'web_fetch_page') assert.ok(content.includes(`${origin}/article/${status}/next?proof=${status}`), content);
                console.log(JSON.stringify({ tool: name, status, finalStart: true, finalEnd: true, textChars: content.length }));
            });
        }

        await suite.test('redirected HTTP MCP session supports one click, evaluate and a nonblank inline screenshot', async () => {
            let sessionId;
            try {
                const navigated = await call('web_interact', { url: `${origin}/start/302`, action: 'content' });
                assert.ok(!navigated.isError, textOf(navigated));
                sessionId = textOf(navigated).match(/session_[\w-]+/)?.[0];
                assert.ok(sessionId, textOf(navigated));
                const clicked = await call('web_interact', { sessionId, action: 'click', selector: '#count-button', waitForEvents: false });
                assert.ok(!clicked.isError, textOf(clicked));
                const page = sessionManager.get(sessionId, ownerId);
                await page.waitForFunction(() => document.getElementById('count').textContent === '1');
                const evaluated = await call('web_interact', { sessionId, action: 'evaluate', value: 'document.getElementById("count").textContent' });
                assert.ok(!evaluated.isError, textOf(evaluated));
                assert.match(textOf(evaluated), /1/);
                assert.equal(clicks, 1);
                assert.equal(requests.filter(entry => entry.pathname === '/effect/click' && entry.method === 'POST').length, 1);
                const screenshot = await call('web_fetch_screenshot', { sessionId, quality: 'default', fullPage: false });
                assert.ok(!screenshot.isError, textOf(screenshot));
                const images = screenshot.content.filter(part => part.type === 'image');
                assert.equal(images.length, 1);
                const bytes = Buffer.from(images[0].data, 'base64');
                const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
                assert.ok(info.width >= 400 && info.height >= 300, JSON.stringify(info));
                let redPixels = 0;
                for (let offset = 0; offset < data.length; offset += info.channels) {
                    if (data[offset] > 180 && data[offset + 1] < 100 && data[offset + 2] < 100) redPixels++;
                }
                assert.ok(redPixels > 200, `expected actual rendered red asset, received ${redPixels} red pixels`);
                assert.equal(page.url(), `${origin}/article/302/final`);
                console.log(JSON.stringify({ tool: 'web_interact+web_fetch_screenshot', clicks, finalUrl: page.url(), imageBytes: bytes.length, imageSha256: createHash('sha256').update(bytes).digest('hex'), width: info.width, height: info.height, redPixels }));
            } finally { if (sessionId) await sessionManager.close(sessionId, ownerId); }
        });

        assert.deepEqual(await readHashes(), sourceHashes, 'tested source must remain unchanged throughout the run');
        assert.equal(visibleOpenAttempts, 0);
    } finally {
        humanBrowserManager.open = originalHumanOpen;
        const cleanupErrors = [];
        await sessionManager.closeAllForOwner(ownerId).catch(error => cleanupErrors.push(error));
        await browserManager.shutdown().catch(error => cleanupErrors.push(error));
        await context?.close().catch(error => cleanupErrors.push(error));
        if (connected) await client.close().catch(error => cleanupErrors.push(error));
        await service.close().catch(error => cleanupErrors.push(error));
        server.closeAllConnections();
        if (server.listening) await new Promise(resolve => server.close(resolve));
        const relative = path.relative(os.tmpdir(), temporary);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        assert.ok(path.basename(temporary).startsWith('web-fetcher-redirect-interception-'));
        await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        if (previousProfileBase === undefined) delete process.env.WEB_FETCHER_PROFILE_BASE_DIR;
        else process.env.WEB_FETCHER_PROFILE_BASE_DIR = previousProfileBase;
        console.log(JSON.stringify({ fixture: 'redirect-interception-cleanup', browserClosed: !context || contextClosed, serverClosed: !server.listening, temporaryRemoved: true, visibleOpenAttempts }));
        assert.ok(!context || contextClosed, 'owned Edge context must close');
        assert.deepEqual(cleanupErrors, []);
    }
});
