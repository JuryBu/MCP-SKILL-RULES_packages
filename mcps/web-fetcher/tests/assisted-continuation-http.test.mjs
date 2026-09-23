import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const enabled = process.env.WEB_FETCHER_BROWSER_TESTS === '1';
const longRun = process.env.WEB_FETCHER_ASSISTANCE_600S_TEST === '1';
const textOf = result => result.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';

test('HTTP challenge short-return, browser-bound same-page continuation and owned cleanup', { skip: !enabled, timeout: longRun ? 690_000 : 100_000 }, async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'web-fetcher-assisted-'));
    process.env.WEB_FETCHER_PROFILE_BASE_DIR = path.join(temporary, 'auth');
    const { browserManager } = await import('../dist/browser.js');
    const { humanBrowserManager } = await import('../dist/human-browser/manager.js');
    const { sessionManager } = await import('../dist/session.js');
    const { installToolConcurrency } = await import('../dist/tool-concurrency.js');
    const { registerHumanBrowserTools } = await import('../dist/tools/human-browser.js');
    const { registerHumanVerification } = await import('../dist/tools/human-verification.js');
    const { registerFetchPage } = await import('../dist/tools/fetch-page.js');
    const { registerFetchRich } = await import('../dist/tools/fetch-rich.js');
    const { registerFetchScreenshot } = await import('../dist/tools/fetch-screenshot.js');
    const { registerInteract } = await import('../dist/tools/interact.js');
    const { registerPipeline } = await import('../dist/tools/pipeline.js');
    const { cancelBackgroundTask } = await import('../dist/background-tasks.js');
    const service = new McpServer({ name: 'assisted-http-fixture', version: '1' });
    installToolConcurrency(service);
    for (const register of [registerHumanBrowserTools, registerHumanVerification, registerFetchPage, registerFetchRich, registerFetchScreenshot, registerInteract, registerPipeline]) register(service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await service.connect(transport);
    const server = http.createServer((request, response) => {
        if (request.url?.startsWith('/mcp')) {
            void transport.handleRequest(request, response).catch(error => { if (!response.headersSent) response.writeHead(500); response.end(String(error)); });
        } else if (request.url === '/cdn-cgi/challenge-platform/pending.js') {
            response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
            response.flushHeaders();
        } else if (request.url === '/topic/hanging') {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end('<!doctype html><title>Just a moment</title><p>Checking your browser</p><script src="/cdn-cgi/challenge-platform/pending.js"></script>');
        } else if (request.url?.includes('challenge-platform')) {
            response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
            response.end(`function render(){document.title='Private fixture';document.body.innerHTML='<article class="topic-post"><h1>PRIVATE SAME PAGE CONTENT</h1><p>${'Browser-bound authorized fixture content. '.repeat(12)}</p></article>';}if(sessionStorage.getItem('fixture-session-token'))render();else document.querySelector('button').onclick=()=>{sessionStorage.setItem('fixture-session-token','fixture-only');render()};`);
        } else {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            response.end('<!doctype html><title>请稍候…</title><button>Complete fixture verification</button><script src="/cdn-cgi/challenge-platform/fixture.js"></script>');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const target = `${origin}/topic/42`;
    const portProbe = net.createServer();
    await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
    const cdpPort = portProbe.address().port;
    await new Promise(resolve => portProbe.close(resolve));
    const client = new Client({ name: 'host-neutral-http-client', version: '1' });
    const ownerId = 'assisted-http-owner';
    const call = (name, args, timeout = 15_000) => client.callTool({ name, arguments: { ownerId, humanAssistance: 'never', ...args } }, undefined, { timeout });
    let context;
    let managed;
    let taskId;
    let humanSessionId;
    try {
        context = await chromium.launchPersistentContext(path.join(temporary, 'edge-live'), { channel: 'msedge', headless: true, args: [`--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1'], viewport: { width: 800, height: 600 } });
        managed = await chromium.launchPersistentContext(path.join(temporary, 'edge-fetch'), { channel: 'msedge', headless: true });
        browserManager.context = managed;
        const originalOpen = humanBrowserManager.open;
        humanBrowserManager.open = async () => { throw new Error('Visible browser prohibited in fixture'); };
        try {
            await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
            const hangingStarted = performance.now();
            const hanging = await call('web_fetch_page', { url: `${origin}/topic/hanging`, timeout: 2000, waitFor: '.topic-post' });
            assert.equal(hanging.structuredContent?.pageAccess.status, 'challenge_required', textOf(hanging));
            assert.ok(performance.now() - hangingStarted < 7000, 'challenge already present at navigation timeout must not be retried as network failure');
            for (const name of ['web_fetch_page', 'web_fetch_rich', 'web_fetch_screenshot']) {
                const started = performance.now();
                const blocked = await call(name, { url: target, waitFor: '.topic-post', timeout: 10_000 });
                assert.equal(blocked.isError, true, textOf(blocked));
                assert.equal(blocked.structuredContent?.pageAccess.status, 'challenge_required');
                assert.ok(performance.now() - started < 8000, 'challenge must precede the 10-second selector wait');
                assert.ok(!blocked.content.some(part => part.type === 'image'), 'blocked result is not successful screenshot');
            }
            const page = context.pages()[0];
            await page.goto(target, { waitUntil: 'domcontentloaded' });
            const attached = await call('web_human_browser_attach', { port: cdpPort });
            assert.ok(!attached.isError, textOf(attached));
            const info = JSON.parse(textOf(attached).split('\n⏱')[0]);
            humanSessionId = info.humanSessionId;
            const pageId = info.pages.find(item => item.url === target).pageId;
            const start = await call('web_human_verification', { action: 'start', url: target, humanSessionId, pageId, waitFor: '.topic-post' });
            assert.ok(!start.isError, textOf(start));
            taskId = start.structuredContent.task.id;
            const again = await call('web_human_verification', { action: 'start', url: target, humanSessionId, pageId, waitFor: '.topic-post' });
            assert.equal(again.structuredContent.task.id, taskId, 'same owner/target deduplicates');
            const wrongOwner = await call('web_human_verification', { action: 'status', taskId, ownerId: 'other-owner' });
            assert.equal(wrongOwner.isError, true);
            const before = await call('web_human_verification', { action: 'status', taskId, waitSeconds: 1 });
            assert.equal(before.structuredContent.task.metadata.contentVerified, false);
            await page.locator('button').click();
            const ready = await call('web_human_verification', { action: 'status', taskId, waitSeconds: 5 });
            const task = ready.structuredContent.task;
            assert.equal(task.metadata.phase, 'ready', textOf(ready));
            assert.equal(task.metadata.contentVerified, true);
            assert.equal(task.maxRunMs, 600_000);
            assert.ok(new Date(task.deadlineAt) - new Date(task.metadata.windowReadyAt) >= 599_000);
            const sessionId = task.metadata.sessionId;
            const separatePage = await managed.newPage();
            await separatePage.goto(target);
            assert.equal(await separatePage.title(), '请稍候…', 'copying ordinary cookies cannot substitute for live sessionStorage');
            await separatePage.close();
            const continued = await call('web_fetch_page', { sessionId, outputMode: 'full' });
            assert.ok(!continued.isError, textOf(continued));
            assert.match(textOf(continued), /PRIVATE SAME PAGE CONTENT/);
            for (const name of ['web_fetch_rich', 'web_fetch_screenshot']) {
                const capture = await call(name, { sessionId, viewport: { width: 640, height: 480 }, fullPage: false });
                assert.ok(!capture.isError, textOf(capture));
                assert.ok(capture.content.some(part => part.type === 'image'), `${name} inline image`);
                assert.equal(page.isClosed(), false, 'read continuation must not close borrowed renderer');
            }
            const wrongTarget = await call('web_fetch_page', { sessionId, url: `${origin}/other` });
            assert.equal(wrongTarget.isError, true);
            assert.equal(page.url(), target);
            const midChallenge = await call('web_pipeline', { sessionId, keepSession: true, steps: [
                { action: 'evaluate', value: "document.title='Just a moment'; document.body.innerHTML='<p>Checking your browser</p><script src=\"/cdn-cgi/challenge-platform/stopped.js\"></script>'; window.afterChallenge=0;" },
                { action: 'evaluate', value: 'window.afterChallenge++' },
            ] });
            assert.equal(midChallenge.isError, true, textOf(midChallenge));
            assert.equal(await page.evaluate(() => window.afterChallenge), 0, 'pipeline must stop before the next action');
            const reblocked = await call('web_fetch_rich', { sessionId });
            assert.equal(reblocked.isError, true);
            assert.equal(reblocked.structuredContent.pageAccess.taskId, undefined, 'borrowed assisted page must not spawn another window');
            await page.evaluate(() => render());
            if (longRun) {
                while (Date.now() < new Date(task.deadlineAt).getTime() + 4000) {
                    await new Promise(resolve => setTimeout(resolve, Math.min(30_000, Math.max(1, new Date(task.deadlineAt).getTime() + 4000 - Date.now()))));
                    const status = await call('web_human_verification', { action: 'status', taskId }, 5000);
                    if (status.structuredContent?.task.status !== 'running') break;
                }
            } else {
                const closing = await call('web_human_verification', { action: 'close', taskId });
                assert.ok(['cancelling', 'cancelled'].includes(closing.structuredContent.task.status));
            }
            let final;
            for (let attempt = 0; attempt < 15; attempt++) {
                final = await call('web_human_verification', { action: 'status', taskId, waitSeconds: 1 });
                if (final.structuredContent.task.status !== 'cancelling' && final.structuredContent.task.status !== 'running') break;
            }
            assert.equal(final.structuredContent.task.cleanupStatus, 'done', textOf(final));
            assert.equal(final.structuredContent.task.status, longRun ? 'error' : 'cancelled');
            if (longRun) assert.equal(final.structuredContent.task.timedOut, true);
            assert.equal(page.isClosed(), false, 'external browser remains alive after task cleanup');
            const humanStillAlive = await humanBrowserManager.describe(humanSessionId, ownerId);
            assert.equal(humanStillAlive.alive, true, 'borrowed human session remains registered after task cleanup');
            assert.equal(sessionManager.get(sessionId, ownerId), null);
            assert.equal(browserManager.getPoolStats().activePages, 0);
            console.log(JSON.stringify({ samePage: true, shortReturn: true, inlineImages: 2, borrowedAlive: true, real600Seconds: longRun, cleanup: final.structuredContent.task.cleanupStatus }));
        } finally { humanBrowserManager.open = originalOpen; }
    } finally {
        if (taskId) await cancelBackgroundTask(taskId, ownerId).catch(() => {});
        if (humanSessionId) await humanBrowserManager.close(humanSessionId, ownerId).catch(() => {});
        await sessionManager.closeAll();
        await browserManager.shutdown();
        await context?.close().catch(() => {});
        await managed?.close().catch(() => {});
        await client.close().catch(() => {});
        await service.close().catch(() => {});
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        assert.ok(path.basename(temporary).startsWith('web-fetcher-assisted-'));
        await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
