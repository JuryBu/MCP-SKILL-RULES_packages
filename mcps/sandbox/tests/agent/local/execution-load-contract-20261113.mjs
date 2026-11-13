import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRouter } from '../../../src/agent-server/tools/router.ts';
import { SharedMcpCatalog } from '../../../src/agent-server/tools/catalog.ts';
import { executeToolFixture } from './tools-execution-fixture-20261113.mjs';

test('every successful load receipt matches the next actual request and its frozen hash', async () => {
    const shared = new SharedMcpCatalog([{ serviceId: 'sequential-thinking', revision: 'unit', enabled: true }]);
    const router = new ToolRouter({ shared });
    try {
        const result = await executeToolFixture({ router, script: [[{ name: 'tool_load', args: { names: ['patch_file', 'sequential-thinking.sequentialthinking'] } }]] });
        assert.equal(result.outcome.status, 'succeeded', JSON.stringify(result.outcome));
        const receipt = result.steps.find(step => step.kind === 'tool').result.result;
        assert.equal(receipt.ok, true, JSON.stringify(receipt));
        const offered = result.requests[1].view.tools;
        for (const loaded of receipt.data.loaded) {
            assert.ok(offered.some(schema => schema.name === loaded.name), loaded.name);
            assert.match(loaded.schemaHash, /^[a-f0-9]{64}$/);
        }
        assert.equal(receipt.data.unavailable.length, 0);
        assert.equal(shared.modelFunctionSchemas(result.trusted).length, 0);
    } finally { await shared.close(); }
});

test('fixed selection refuses excluded tools instead of promising schemas that will be filtered', async () => {
    const result = await executeToolFixture({ toolNames: ['tool_load', 'read_file'],
        script: [[{ name: 'tool_load', args: { names: ['read_file', 'mkdir'] } }]] });
    assert.equal(result.outcome.status, 'succeeded');
    const receipt = result.steps.find(step => step.kind === 'tool').result.result;
    assert.deepEqual(receipt.data.loaded.map(entry => entry.name), ['read_file']);
    assert.equal(receipt.data.unavailable[0].toolId, 'local.mkdir');
    assert.deepEqual(result.requests[1].view.tools.map(schema => schema.name), ['read_file', 'tool_load']);
});
