import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { createAgentRuntime } from '../../../dist/agent-server/runtime.js';
import { createAgentServices } from '../../../dist/agent-server/server-services.js';
import { openAgentStore } from '../../../dist/agent-server/storage/index.js';
import { MemoryCatalogPort } from '../../../dist/agent-server/models/catalog.js';

const client = { principalId: 'i9-capability', clientId: 'i9-local', callerHost: 'standalone-cli' };

test('I9 bare runtime keeps its executor and automatic execution semantics', async () => {
    const runtime = createAgentRuntime();
    try {
        const result = await runtime.dispatch('server.info', {}, client);
        assert.equal(result.ok, true);
        assert.equal(result.data.capabilities.executor, false);
        assert.equal(result.data.capabilities.automaticModelExecution, false);
        assert.equal(Object.hasOwn(result.data.capabilities, 'executorActivation'), false);
    } finally { await runtime.close(); }
});

test('I9 formal services advertise available model execution without activating or calling it', async context => {
    const dataDir = await mkdtemp(join(tmpdir(), 'sandbox-i9-capability-'));
    const store = await openAgentStore({ dataDir });
    const runtime = createAgentRuntime({ store });
    let services;
    let activations = 0;
    const originalSetExecutor = runtime.setExecutor.bind(runtime);
    context.mock.method(runtime, 'setExecutor', async executor => { activations++; return originalSetExecutor(executor); });
    context.mock.method(globalThis, 'fetch', async () => { assert.fail('server.info must not make network requests'); });
    try {
        services = await createAgentServices({ authority: { principalId: client.principalId, dataDir,
            runtimeDir: join(dataDir, 'runtime') }, store, runtime, catalogPort: new MemoryCatalogPort(), sharedServices: [] });
        const bare = await runtime.dispatch('server.info', {}, client);
        const first = await services.dispatch('server.info', {}, client);
        const repeated = await services.dispatch('server.info', {}, client);
        assert.equal(first.ok, true);
        assert.deepEqual(repeated, first);
        assert.deepEqual(first.data, { ...bare.data, capabilities: { ...bare.data.capabilities,
            automaticModelExecution: true, executorActivation: 'on_profile_run' } });
        assert.equal(first.data.capabilities.executor, false);
        assert.equal(first.data.activeRunCount, 0);
        assert.equal(activations, 0);
        await runtime.setExecutor(services.executor);
        const active = await services.dispatch('server.info', {}, client);
        assert.equal(active.data.capabilities.executor, true);
        assert.equal(active.data.capabilities.automaticModelExecution, true);
        assert.equal(active.data.capabilities.executorActivation, 'active');
        assert.equal(activations, 1);
        const failure = { ok: false, error: { code: 'I9_TEST_FAILURE', message: 'original failure' } };
        context.mock.method(runtime, 'dispatch', async () => failure);
        assert.deepEqual(await services.dispatch('server.info', {}, client), failure);
    } finally {
        context.mock.restoreAll();
        try { await services?.close(); }
        finally {
            try { await runtime.close(); }
            finally {
                await store.close();
                assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
                assert.ok(basename(dataDir).startsWith('sandbox-i9-capability-'));
                await rm(dataDir, { recursive: true, force: true });
            }
        }
    }
});
