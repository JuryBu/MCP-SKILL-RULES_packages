import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real server advertises additive 7.2 tool and resource contracts', { timeout: 45000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-fetcher-contract-'));
    const client = new Client({ name: 'host-neutral-contract-test', version: '1' });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['dist/index.js'],
        cwd: process.cwd(),
        env: { ...process.env, TEMP: root, TMP: root, WEB_FETCHER_PROFILE_BASE_DIR: path.join(root, 'profile') },
        stderr: 'pipe',
    });
    transport.stderr?.resume();
    try {
        await client.connect(transport);
        assert.equal(client.getServerVersion()?.version, '7.2.0');
        const listed = await client.listTools();
        assert.equal(listed.tools.length, 32);
        const byName = new Map(listed.tools.map(tool => [tool.name, tool]));
        for (const name of ['web_fetch_page', 'web_fetch_screenshot', 'web_fetch_rich', 'web_interact', 'web_pipeline', 'web_inspect']) {
            const tool = byName.get(name);
            assert.ok(tool?.inputSchema.properties?.viewport, name);
            assert.ok(!tool.inputSchema.required?.includes('viewport'), name);
            assert.ok(tool.inputSchema.properties?.ownerId, name);
        }
        for (const name of ['web_fetch_screenshot', 'web_interact', 'web_pipeline', 'web_inspect', 'desktop_screenshot']) {
            assert.deepEqual(new Set(byName.get(name).inputSchema.properties.saveMode.enum), new Set(['inline', 'file']));
        }
        for (const name of ['web_fetch_page', 'web_fetch_rich', 'web_inspect']) {
            assert.ok(byName.get(name).inputSchema.properties.modelChain);
            assert.ok(byName.get(name).inputSchema.properties.chain);
        }
        const guide = await client.readResource({ uri: 'web-fetcher://guide' });
        const body = guide.contents.map(item => item.text ?? '').join('\n');
        for (const marker of ['viewport', '600', 'candidate', '全局共享', 'partial', '_meta.webFetcherTiming']) {
            assert.ok(body.includes(marker), marker);
        }
        const sessions = await client.callTool({ name: 'web_list_sessions', arguments: { ownerId: 'release-contract' } });
        assert.ok(!sessions.isError);
        assert.ok(sessions._meta?.webFetcherTiming);
        assert.ok(sessions._meta?.webFetcherPool);
    } finally {
        await client.close().catch(() => {});
        await transport.close().catch(() => {});
        assert.ok(path.basename(root).startsWith('web-fetcher-contract-'));
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
