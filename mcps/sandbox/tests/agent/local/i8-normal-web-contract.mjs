import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { NativeWebResourceAdapter, bindNativeWebResourceCall, inspectNativeWebAdapterContract } from '../../../src/agent-server/resources/web-native-adapter.ts';
import { MemoryResourceStore, ResourceRegistry } from '../../../src/agent-server/resources/registry.ts';

const schemaFile = process.env.I8_WEB_NATIVE_SCHEMA_FILE;
const actual = schemaFile ? JSON.parse(await readFile(schemaFile, 'utf8')).tools : undefined;

test('actual deployed schema uses Core tracking while ordinary ownership/output requirements remain', { skip: !actual }, () => {
    const contract = inspectNativeWebAdapterContract(actual, 'owned-core');
    assert.equal(contract.enabled, true);
    assert.equal(contract.leaseMode, 'core');
    assert.equal(contract.ephemeralContent, false);
    assert.equal(contract.upstreamMissing.length, 9);
    assert.equal(inspectNativeWebAdapterContract(actual, '').enabled, false);
    const missingOwner = structuredClone(actual);
    delete missingOwner.find(tool => tool.name === 'web_close_sessions').inputSchema.properties.ownerId;
    assert.equal(inspectNativeWebAdapterContract(missingOwner, 'owned-core').enabled, false);
    const missingInline = structuredClone(actual);
    missingInline.find(tool => tool.name === 'web_interact').inputSchema.properties.saveMode.enum = ['file'];
    assert.equal(inspectNativeWebAdapterContract(missingInline, 'owned-core').enabled, false);
});

test('unknown create retains the original request and only queries until its own session is observed', { skip: !actual }, async () => {
    const store = new MemoryResourceStore();
    let creates = 0; let ownerId; let visible = false; let closes = 0;
    const sessionId = 'session_11111111-1111-4111-8111-111111111111';
    const client = {
        async listTools() { return { tools: actual }; },
        async invoke(name, args) {
            if (name === 'web_interact') { creates++; ownerId = args.ownerId; throw new Error('unit: response unavailable'); }
            assert.equal(args.ownerId, ownerId);
            assert.equal(Object.hasOwn(args, 'requestId'), false);
            if (name === 'web_close_sessions') { closes++; assert.equal(args.sessionId, sessionId); visible = false; return { content: [] }; }
            assert.equal(name, 'web_list_sessions');
            return { content: [{ type: 'text', text: `活跃会话 (${visible ? 1 : 0})\n${visible ? `1. ${sessionId} ownerId=${ownerId} owned idle=0s` : '没有活跃会话。'}` }] };
        }, async close() {},
    };
    const registry = new ResourceRegistry(store, 'owned-core');
    const adapter = await NativeWebResourceAdapter.connect({ client, resourceStore: store, coreIssuerId: registry.issuerId,
        outputBudget: { reserve() {}, release() {} } });
    registry.register(adapter);
    const context = { principalId: 'principal', conversationId: 'conversation', runId: 'run', rootRunId: 'run', runEpoch: 1,
        roundId: 'round', actionId: 'action', attemptId: 'attempt', policyRevision: 1, roots: [], retention: { mode: 'archive' },
        deadlineAt: new Date(Date.now() + 60000).toISOString(), signal: new AbortController().signal, async assertCurrent() {} };
    const call = await bindNativeWebResourceCall('web_interact', { url: 'https://example.com', action: 'content' }, context);
    await assert.rejects(registry.create(adapter.adapterId, 'web_interact', call, context), { code: 'RESOURCE_UNRESOLVED' });
    const original = (await store.list(context.conversationId, context.rootRunId))[0];
    await assert.rejects(registry.create(adapter.adapterId, 'web_interact', call, context), { code: 'RESOURCE_UNRESOLVED' });
    assert.equal(creates, 1);
    visible = true;
    const recovered = await registry.create(adapter.adapterId, 'web_interact', call, context);
    assert.equal(recovered.requestId, original.requestId);
    assert.equal(recovered.externalId, sessionId);
    assert.equal(creates, 1);
    const closed = await registry.close(recovered.resourceId, context);
    assert.equal(closed.receipt.terminalConfirmed, true);
    assert.equal(closes, 1);
});
