import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolRouter } from '../../../src/agent-server/tools/router.ts';
import { SharedMcpCatalog } from '../../../src/agent-server/tools/catalog.ts';
import { settleIndependentReads } from '../../../src/agent-server/tools/parallel.ts';
import { executeToolFixture } from './tools-execution-fixture-20261113.mjs';

test('independent reads overlap with a bound of four, preserve native ids and record provider order', async () => {
    let active = 0;
    let peak = 0;
    const finished = [];
    const calls = Array.from({ length: 7 }, (_, index) => ({ name: 'read_file', callId: `native-${index}`, args: { path: `unit-${index}` } }));
    const result = await executeToolFixture({ script: [calls], execute: async (name, args, binding) => {
        active++;
        peak = Math.max(peak, active);
        await delay(12 + (7 - Number(args.path.slice(5))) * 5);
        finished.push(binding.callId);
        active--;
        return { ok: true, data: { path: args.path, binding: { actionId: binding.actionId, callId: binding.callId } } };
    } });
    assert.equal(result.outcome.status, 'succeeded', JSON.stringify(result.outcome));
    assert.equal(peak, 4);
    assert.notDeepEqual(finished, calls.map(call => call.callId));
    const tools = result.steps.filter(step => step.kind === 'tool');
    assert.deepEqual(tools.map(step => step.result.callId), calls.map(call => call.callId));
    assert.equal(new Set(tools.map(step => step.actionId)).size, 7);
    assert.ok(tools.every(step => step.actionId !== step.result.callId));
    assert.equal(active, 0);
});

test('writes and control calls form serial barriers between read groups', async () => {
    let active = 0;
    let revision = 0;
    const events = [];
    const script = [[{ name: 'read_file', args: { path: 'before-a' } }, { name: 'list_files', args: { path: 'before-b' } },
        { name: 'write_file' }, { name: 'read_file', args: { path: 'after-a' } }, { name: 'read_file', args: { path: 'after-b' } },
        { name: 'tool_load', args: { names: ['read_file'] } }, { name: 'read_file', args: { path: 'after-control' } }]];
    const result = await executeToolFixture({ script, execute: async (name, args) => {
        const read = ['read_file', 'list_files'].includes(name);
        if (!read) { assert.equal(active, 0); revision++; }
        const observed = revision;
        active++;
        events.push(`${name}:start:${observed}`);
        await delay(10);
        assert.equal(revision, observed);
        active--;
        return { ok: true, data: { observed } };
    } });
    assert.equal(result.outcome.status, 'succeeded');
    assert.deepEqual(result.steps.filter(step => step.kind === 'tool').map(step => step.result.result.data.observed), [0, 0, 1, 1, 1, 2, 2]);
    assert.equal(active, 0);
});

test('parallel reads settle fully after cancellation and preserve completed call records', async () => {
    const controller = new AbortController();
    let active = 0;
    const calls = Array.from({ length: 6 }, (_, index) => ({ name: 'read_file', args: { path: `unit-${index}` } }));
    const result = await executeToolFixture({ script: [calls], controller, captureFailure: true, execute: async (name, args, binding) => {
        active++;
        await delay(10);
        controller.abort();
        await delay(10);
        active--;
        return { ok: false, error: { code: 'TOOL_CANCELLED', message: 'unit cancellation', mayHaveStarted: false,
            retryable: false, actionId: binding.actionId, attemptId: binding.attemptId } };
    } });
    assert.equal(result.failure.code, 'E_CANCELLED');
    assert.equal(result.failure.facts.cleanupEvidence, 'no_resources_created');
    assert.equal(active, 0);
    assert.equal(result.steps.filter(step => step.kind === 'tool').length, 4);
    assert.equal(result.requests.length, 1);
});

test('batch settlement waits for sibling reads on a thrown error', async () => {
    let siblingFinished = false;
    await assert.rejects(settleIndependentReads([async () => { throw new Error('unit failure'); },
        async () => { await delay(15); siblingFinished = true; }]), /unit failure/);
    assert.equal(siblingFinished, true);
});

test('a local refusal in a read group retains settled sibling results and skips the following write', async () => {
    const executed = [];
    const calls = Array.from({ length: 4 }, (_, index) => ({ name: 'read_file', callId: `read-${index}`, args: { path: `unit-${index}` } }));
    calls.push({ name: 'write_file', callId: 'unstarted-write', args: {} });
    const result = await executeToolFixture({ script: [calls], execute: async (name, args, binding) => {
        executed.push(binding.callId);
        await delay(5);
        return binding.callId === 'read-1' ? { ok: false, error: { code: 'TOOL_NOT_ALLOWED', message: 'unit refusal',
            mayHaveStarted: false, retryable: false, actionId: binding.actionId, attemptId: binding.attemptId,
            details: { source: 'local', localPolicyViolation: true, pauseConversation: true, stopAutomaticRetry: true } } }
            : { ok: true, data: { checked: true } };
    } });
    assert.equal(result.outcome.stopReason, 'LOCAL_POLICY_REVIEW_REQUIRED');
    assert.deepEqual(executed, ['read-0', 'read-1', 'read-2', 'read-3']);
    const tools = result.steps.filter(step => step.kind === 'tool');
    assert.deepEqual(tools.map(step => step.result.callId), [...executed, 'unstarted-write']);
    assert.equal(tools.at(-1).result.result.disposition, 'not_executed');
    assert.equal(result.outcome.result.action.callId, 'read-1');
    assert.equal(result.outcome.result.action.actionId, tools[1].actionId);
});

test('classification excludes writes, loading, commands, approvals and mutating shared actions', async () => {
    const shared = new SharedMcpCatalog([{ serviceId: 'sandbox', endpoint: 'http://127.0.0.1:14588/sandbox/mcp', revision: 'unit', enabled: true }]);
    const router = new ToolRouter({ shared });
    const context = { signal: new AbortController().signal };
    try {
        assert.equal(router.isIndependentRead('read_file', { path: 'unit' }, context), true);
        for (const name of ['write_file', 'patch_file', 'move_file', 'delete_file', 'mkdir', 'run_command', 'tool_load', 'tool_describe', 'mark_history_hit', 'child_wait']) {
            assert.equal(router.isIndependentRead(name, {}, context), false, name);
        }
        assert.equal(router.isIndependentRead('read_file', {}, { ...context, approvalRequiredTools: ['read_file'] }), false);
        assert.equal(router.isIndependentRead('mcp_sandbox__sandbox_status', { action: 'envs' }, context), true);
        assert.equal(router.isIndependentRead('mcp_sandbox__sandbox_status', { action: 'gc' }, context), false);
        assert.equal(router.isIndependentRead('mcp_sandbox__smart_search', { mode: 'smart' }, context), false);
        assert.equal(router.isIndependentRead('mcp_sandbox__smart_search', { queries: [{ mode: 'smart' }] }, context), false);
        assert.equal(router.isIndependentRead('mcp_sandbox__smart_search', { cancel: true }, context), false);
    } finally { await shared.close(); }
});
