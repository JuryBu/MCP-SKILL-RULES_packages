import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ToolRouter } from '../../../src/agent-server/tools/router.ts';
import { SharedMcpCatalog } from '../../../src/agent-server/tools/catalog.ts';
import { ToolCatalogService } from '../../../src/agent-server/tools/service.ts';
import { requireSupportedSchema, validateToolArguments } from '../../../src/agent-server/tools/schema-cache.ts';
import { FILE_OPERATION_SCHEMAS } from '../../../src/agent-server/workspace/file-operations.ts';
import { DELEGATION_FUNCTION_SCHEMAS } from '../../../src/agent-server/tools/delegation.ts';

function binding(root, overrides = {}) {
    const runId = randomUUID();
    return { conversationId: randomUUID(), runId, rootRunId: runId, runEpoch: 1, roundId: randomUUID(),
        principalId: 'tools-upgrade-unit', roots: [root], signal: new AbortController().signal,
        actionId: randomUUID(), attemptId: randomUUID(), policyRevision: 1, retention: { mode: 'temporary' }, ...overrides };
}

test('patch schema supports not and required-only branches while preserving all three mutually exclusive modes', () => {
    const schema = FILE_OPERATION_SCHEMAS.find(entry => entry.name === 'patch_file').parameters;
    requireSupportedSchema(schema);
    const target = { path: path.join(os.tmpdir(), 'schema-only.txt'), expectedVersion: 'a'.repeat(64) };
    for (const mode of [{ oldText: '猫', newText: '新猫' }, { appendText: '喵\n' },
        { edits: [{ offset: 0, deleteBytes: 0, content: 'text' }] }]) validateToolArguments({ ...target, ...mode }, schema);
    for (const mode of [{}, { oldText: '猫' }, { newText: '新猫' }, { edits: [] }, { oldText: '', newText: '' },
        { oldText: '猫', newText: '新猫', appendText: 'x' }, { appendText: 'x', edits: [] }, { unknown: 'x', appendText: 'x' }]) {
        assert.throws(() => validateToolArguments({ ...target, ...mode }, schema), error => error.code === 'INVALID_PARAMS');
    }
    assert.throws(() => requireSupportedSchema({ not: { patternProperties: {} } }), error => error.code === 'TOOL_CAPABILITY_UNVERIFIED');
    validateToolArguments({ permitted: true }, { not: { required: ['forbidden'] } });
    assert.throws(() => validateToolArguments({ forbidden: false }, { not: { required: ['forbidden'] } }), error => error.code === 'INVALID_PARAMS');
});

test('model describe, load, catalog and actual patch share one local schema hash and retain UTF-8 readback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sandbox-tools-upgrade-'));
    const context = binding(root);
    const router = new ToolRouter();
    try {
        const target = path.join(root, '原件.txt');
        await writeFile(target, '原文，猫🐾\n');
        const version = await router.execute('read_file', { path: target }, context);
        assert.equal(version.ok, true);
        const described = await router.execute('tool_describe', { name: 'local.patch_file' }, context);
        assert.equal(described.ok, true, JSON.stringify(described));
        assert.equal(described.data.schemaHash, router.list().find(entry => entry.name === 'patch_file').schemaHash);
        const catalog = new ToolCatalogService(router);
        assert.equal((await catalog.describe({ name: 'patch_file' })).schemaHash, described.data.schemaHash);
        assert.equal(catalog.list({ limit: 100 }).entries.find(entry => entry.name === 'patch_file').schemaHash, described.data.schemaHash);
        const loaded = await router.execute('tool_load', { names: ['patch_file'] }, context);
        assert.equal(loaded.ok, true, JSON.stringify(loaded));
        assert.equal(loaded.data.loaded[0].schemaHash, described.data.schemaHash);
        const patched = await router.execute('patch_file', { path: target, expectedVersion: version.data.version.versionToken,
            oldText: '原文，猫🐾', newText: '新文，猫🐾' }, { ...context, actionId: randomUUID(), toolSchemaHash: described.data.schemaHash });
        assert.equal(patched.ok, true, JSON.stringify(patched));
        assert.equal(await readFile(target, 'utf8'), '新文，猫🐾\n');
    } finally { await router.cleanup(context); await rm(root, { recursive: true, force: true }); }
});

test('configured shared tools distinguish pending schema, observed failure and successful recovery', async () => {
    let supplied = false;
    const shared = new SharedMcpCatalog([{ serviceId: 'sandbox', endpoint: 'http://127.0.0.1:14588/sandbox/mcp', revision: 'unit-v1', enabled: true }], async () => ({
        listTools: async () => ({ tools: supplied ? [{ name: 'sandbox_status', inputSchema: { type: 'object',
            properties: { action: { type: 'string' } }, additionalProperties: false } }] : [] }), close: async () => {},
    }));
    try {
        const entry = () => shared.list().entries.find(item => item.toolId === 'sandbox.sandbox_status');
        assert.equal(entry().availability, 'schema_pending');
        assert.equal(entry().schemaStatus, 'pending');
        assert.equal(shared.childToolFacts().find(item => item.toolId === 'sandbox.sandbox_status').availability, 'unknown');
        await assert.rejects(shared.describe('sandbox.sandbox_status'), error => error.code === 'TOOL_SERVICE_UNAVAILABLE');
        assert.equal(entry().availability, 'unavailable');
        supplied = true;
        await shared.describe('sandbox.sandbox_status');
        assert.equal(entry().availability, 'available');
        assert.equal(entry().schemaStatus, 'verified');
    } finally { await shared.close(); }
});

test('English and Chinese catalog queries find environment tools and no-match fallback is bounded and pageable', async () => {
    const shared = new SharedMcpCatalog([{ serviceId: 'sandbox', endpoint: 'http://127.0.0.1:14588/sandbox/mcp', revision: 'unit-v1', enabled: true }]);
    const router = new ToolRouter({ shared });
    const context = binding(os.tmpdir());
    try {
        for (const query of ['environment', 'system', '运行环境']) {
            const result = await router.execute('tool_catalog', { query, limit: 100 }, context);
            assert.equal(result.ok, true);
            assert.ok(result.data.entries.some(entry => entry.toolId === 'sandbox.sandbox_status'));
        }
        const ids = [];
        let cursor;
        do {
            const result = await router.execute('tool_catalog', { query: 'no-such-term-20261113', limit: 3, ...(cursor ? { cursor } : {}) }, context);
            assert.equal(result.ok, true);
            assert.equal(result.data.fallback, 'bounded_catalog');
            assert.ok(result.data.entries.length <= 3);
            ids.push(...result.data.entries.map(entry => entry.toolId));
            cursor = result.data.nextCursor;
        } while (cursor);
        assert.equal(new Set(ids).size, ids.length);
        assert.ok(ids.includes('sandbox.sandbox_status'));
    } finally { await router.cleanup(context); await shared.close(); }
});

test('load receipts respect the final selection and default-disabled internal delegation', async () => {
    const router = new ToolRouter({ delegation: { modelFunctionSchemas: DELEGATION_FUNCTION_SCHEMAS, handles: () => false } });
    const context = binding(os.tmpdir(), { modelToolNames: ['tool_catalog', 'tool_describe', 'tool_load', 'read_file'], allowInternalDelegation: false });
    try {
        const result = await router.execute('tool_load', { names: ['read_file', 'mkdir'] }, context);
        assert.equal(result.ok, true);
        assert.deepEqual(result.data.loaded.map(entry => entry.name), ['read_file']);
        assert.equal(result.data.unavailable[0].toolId, 'local.mkdir');
        assert.match(result.data.unavailable[0].reason, /固定工具选择/);
        const children = await router.execute('tool_load', { names: ['child_spawn'] }, context);
        assert.equal(children.ok, false);
        assert.equal(children.error.code, 'TOOL_NOT_ALLOWED');
        const catalog = await router.execute('tool_catalog', { limit: 100 }, context);
        assert.ok(catalog.data.entries.every(entry => entry.resourceKind !== 'internal_child'));
    } finally { await router.cleanup(context); }
});

test('trusted task work kind enables multi-step plans and keeps simple QA lightweight', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sandbox-task-kind-'));
    const router = new ToolRouter();
    const context = binding(root);
    try {
        for (const [taskPlanWorkKind, planRequired] of [['simple_qa', false], ['single_image', false], ['multi_step', true]]) {
            const snapshot = await router.readTaskPlan({ ...context, taskPlanWorkKind });
            assert.equal(snapshot.planRequired, planRequired);
            assert.equal(snapshot.scope.workKind, taskPlanWorkKind);
            assert.equal(snapshot.task, null);
        }
        assert.match(router.describe('task_plan_write').description, /read back.*actual verification/s);
    } finally { await router.cleanup(context); await rm(root, { recursive: true, force: true }); }
});

test('temporary-session load receipts explain retention exclusions before any metadata connection', async () => {
    let connections = 0;
    const shared = new SharedMcpCatalog([{ serviceId: 'exa', endpoint: 'http://127.0.0.1:14588/exa/mcp', revision: 'unit', enabled: true }], async () => {
        connections++;
        throw new Error('this excluded route must not connect');
    });
    const router = new ToolRouter({ shared });
    const context = binding(os.tmpdir());
    try {
        const result = await router.execute('tool_load', { names: ['exa.web_search_exa'] }, context);
        assert.equal(result.ok, true);
        assert.deepEqual(result.data.loaded, []);
        assert.match(result.data.unavailable[0].reason, /临时会话/);
        assert.equal(result.data.effectiveFrom, null);
        assert.equal(connections, 0);
    } finally { await router.cleanup(context); await shared.close(); }
});
