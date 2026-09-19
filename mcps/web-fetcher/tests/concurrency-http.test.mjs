import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

test('shared HTTP backend admits eight pages and serializes per-page operations without blocking controls', { skip: !enabled, timeout: 120000 }, async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'web-fetcher-concurrency-'));
    process.env.WEB_FETCHER_PROFILE_BASE_DIR = path.join(temporary, 'auth');
    process.env.WEB_FETCHER_MAX_CONCURRENT_PAGES = '8';
    const { browserManager } = await import('../dist/browser.js');
    const { sessionManager } = await import('../dist/session.js');
    const { installToolConcurrency } = await import('../dist/tool-concurrency.js');
    const { registerInteract } = await import('../dist/tools/interact.js');
    const { registerSessionTools } = await import('../dist/tools/sessions.js');
    const service = new McpServer({ name: 'isolated-concurrency-http', version: '1' });
    const gates = installToolConcurrency(service);
    registerInteract(service); registerSessionTools(service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await service.connect(transport);
    const server = http.createServer((request, response) => {
        if (request.url?.startsWith('/mcp')) {
            void transport.handleRequest(request, response).catch(error => {
                if (!response.headersSent) response.writeHead(500);
                response.end(String(error));
            });
        } else {
            response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
            response.end('<!doctype html><html><body><h1>Concurrency fixture</h1><button>Safe</button><script>window.order=[]</script></body></html>');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const client = new Client({ name: 'four-host-neutral-fixture', version: '1' });
    const textOf = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 45000 });
    let context;
    let pending;
    try {
        context = await chromium.launchPersistentContext(path.join(temporary, 'edge'), { channel: 'msedge', headless: true, viewport: { width: 800, height: 600 } });
        browserManager.context = context;
        browserManager.userAssistedVerification = async () => { throw new Error('Manual verification forbidden in fixture'); };
        await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
        const created = await Promise.all(Array.from({ length: 8 }, (_, index) => call('web_interact', {
            url: `${origin}/page?slot=${index}`, action: 'evaluate', value: 'document.title', ownerId: `owner-${index % 4}`,
        })));
        for (const result of created) assert.equal(result.isError, undefined, textOf(result));
        const sessions = created.map(result => textOf(result).match(/session_[a-f0-9-]+/)?.[0]);
        assert.equal(sessions.filter(Boolean).length, 8);
        assert.equal(browserManager.getPoolStats().activePages, 8);
        assert.equal(browserManager.getPoolStats().admission.used, 8);
        pending = call('web_interact', { url: `${origin}/ninth`, action: 'evaluate', value: '1', ownerId: 'queued-owner' });
        const beforeList = performance.now();
        const listed = await call('web_list_sessions', { ownerId: 'owner-0' });
        assert.equal(listed.isError, undefined);
        assert.ok(performance.now() - beforeList < 2000, 'control request must not queue behind full pages');
        const denied = await call('web_interact', { sessionId: sessions[0], action: 'evaluate', value: '99', ownerId: 'wrong-owner' });
        assert.equal(denied.isError, true);
        const closed = await call('web_close_sessions', { sessionId: sessions[4], ownerId: 'owner-0' });
        assert.equal(closed.isError, undefined);
        const ninth = await pending;
        pending = undefined;
        assert.equal(ninth.isError, undefined, textOf(ninth));
        assert.equal(browserManager.getPoolStats().activePages, 8);
        const edits = Array.from({ length: 4 }, (_, index) => call('web_interact', {
            sessionId: sessions[0], ownerId: 'owner-0', action: 'evaluate',
            value: `(async () => { window.order.push('start-${index}'); await new Promise(resolve=>setTimeout(resolve,100)); window.order.push('end-${index}'); return window.order; })()`,
        }));
        const otherPage = await call('web_interact', { sessionId: sessions[1], ownerId: 'owner-1', action: 'evaluate', value: '2+3' });
        assert.equal(otherPage.isError, undefined);
        await Promise.all(edits);
        const page = sessionManager.get(sessions[0], 'owner-0');
        const order = await page.evaluate(() => window.order);
        assert.equal(order.length, 8);
        for (let index = 0; index < order.length; index += 2) assert.equal(order[index].replace('start-', ''), order[index + 1].replace('end-', ''));
        for (const ownerId of ['owner-0', 'owner-1', 'owner-2', 'owner-3', 'queued-owner']) {
            const result = await call('web_close_sessions', { ownerId, closeAllForOwner: true });
            assert.equal(result.isError, undefined);
        }
        assert.equal(browserManager.getPoolStats().activePages, 0);
        assert.equal(browserManager.getPoolStats().admission.used, 0);
        assert.equal(gates.getStats().normal.active, 0);
        assert.equal(gates.getStats().normal.queued, 0);
        assert.equal(sessionManager.getOperationStats().active, 0);
        console.log(JSON.stringify({ pool: browserManager.getPoolStats(), operations: gates.getStats(), sessions: sessionManager.getOperationStats() }));
    } finally {
        await pending?.catch(() => {});
        await sessionManager.closeAll();
        await browserManager.shutdown();
        await context?.close().catch(() => {});
        await client.close();
        await service.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(temporary, { recursive: true, force: true });
    }
});
