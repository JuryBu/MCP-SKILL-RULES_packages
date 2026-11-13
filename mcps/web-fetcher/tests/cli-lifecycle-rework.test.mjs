import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AntigravityCliClient } from '../src/antigravity-cli.ts';
import { detectParentHost, hasNewerSiblingInstance, queryLifecycleProcesses } from '../src/lifecycle.ts';
import { runWithRequestContext } from '../src/request-context.ts';

const fixture = fileURLToPath(new URL('./fixtures/antigravity-cli/mock-acp.mjs', import.meta.url));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const healthyMemory = () => ({ valid: true, sampledAt: performance.now(), physicalAvailableMB: 16000, commitAvailableMB: 24000, lowMemory: false });
const request = () => ({ prompt: 'Local cleanup fixture only', deadline: performance.now() + 6000 });
const success = endpoint => ({ text: 'confirmed fixture output', transport: endpoint.transport, model: 'fixture', outcome: 'success', submitted: true, safeToFallback: false });
const allowedModels = [
    { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
    { modelId: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' },
    { modelId: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
    { modelId: 'gemini-4-hydrogen-xhigh', name: 'Gemini 4 Hydrogen (XHigh)' },
];
const noCapacity = { code: 503, message: 'No capacity available' };

async function harness(context, terminator, fixtureOptions = { ignoreEof: true }) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'web-fetcher-cli-rework-'));
    const children = [];
    const client = new AntigravityCliClient({
        resolveCommand: () => process.execPath,
        memoryProvider: { snapshot: healthyMemory },
        terminateOwned: terminator,
        spawnProcess(command, args, options) {
            const selectedOptions = Array.isArray(fixtureOptions) ? fixtureOptions[Math.min(children.length, fixtureOptions.length - 1)] : fixtureOptions;
            const child = spawn(command, [fixture, ...args], { ...options, env: { ...process.env, MOCK_AGY_OPTIONS: JSON.stringify({ models: allowedModels, ...selectedOptions }), MOCK_AGY_AUDIT: path.join(root, 'audit.jsonl') } });
            child.fixtureStartedAt = performance.now();
            child.fixtureClosed = new Promise(resolve => child.once('close', resolve));
            children.push(child);
            return child;
        },
    });
    context.after(async () => {
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }
        await Promise.all(children.map(child => child.fixtureClosed));
        await client.dispose().catch(() => undefined);
        await fs.rm(root, { recursive: true, force: true });
        context.diagnostic(`owned fixture cleanup: ${JSON.stringify(children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signal: child.signalCode })))}; harnessRemoved=true`);
    });
    return { client, children, events: async () => (await fs.readFile(path.join(root, 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}

function expireCleanup(client) {
    const runtime = client.runtime;
    const close = runtime.close.bind(runtime);
    runtime.close = () => close(performance.now() - 1);
    return runtime;
}

test('expired cleanup deadline still terminates owned process and confirms exit, preserving borrowed process', { timeout: 10000 }, async context => {
    let terminations = 0;
    const borrowed = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    context.after(async () => {
        if (borrowed.exitCode === null && borrowed.signalCode === null) {
            const closed = new Promise(resolve => borrowed.once('close', resolve));
            borrowed.kill('SIGKILL');
            await closed;
        }
        context.diagnostic(`borrowed fixture released by its own test owner: pid=${borrowed.pid}, signal=${borrowed.signalCode}`);
    });
    const mock = await harness(context, async child => { terminations++; child.kill('SIGKILL'); });
    let ownedRoot;
    const started = performance.now();
    const result = await mock.client.withEndpoint(request(), async endpoint => {
        ownedRoot = expireCleanup(mock.client).root;
        return success(endpoint);
    });
    assert.equal(terminations, 1);
    assert.equal(result.text, 'confirmed fixture output');
    assert.equal(result.cleanup.status, 'terminated');
    assert.equal(result.cleanup.confirmed, true);
    assert.equal(result.cleanup.tempRemoved, true);
    await assert.rejects(fs.access(ownedRoot));
    assert.equal(mock.client.getStatus().activeLeases, 0);
    assert.ok(performance.now() - started < 4000);
    assert.doesNotThrow(() => process.kill(borrowed.pid, 0));
});

test('throwing cleanup entry still performs emergency owned cleanup and resolves the lease', { timeout: 10000 }, async context => {
    let terminations = 0;
    const mock = await harness(context, async child => { terminations++; child.kill('SIGKILL'); });
    const result = await mock.client.withEndpoint(request(), async endpoint => {
        mock.client.runtime.close = async () => { throw new Error('injected cleanup failure'); };
        return success(endpoint);
    });
    assert.equal(terminations, 1);
    assert.equal(result.outcome, 'success');
    assert.equal(result.cleanup.confirmed, true);
    assert.ok(result.cleanup.warnings.some(warning => warning.includes('兜底清理')));
    assert.equal(mock.client.getStatus().activeLeases, 0);
    await mock.client.dispose();
});

test('termination failure preserves quarantine and dispose still cleans after drain rejection', { timeout: 12000 }, async context => {
    let attempts = 0;
    const mock = await harness(context, async child => {
        attempts++;
        if (attempts === 1) throw new Error('injected termination failure');
        child.kill('SIGKILL');
    });
    let ownedRoot;
    const result = await mock.client.withEndpoint(request(), async endpoint => {
        ownedRoot = expireCleanup(mock.client).root;
        return success(endpoint);
    });
    assert.equal(result.cleanup.status, 'unconfirmed');
    assert.equal(result.cleanup.confirmed, false);
    assert.equal(result.cleanup.tempRemoved, false);
    assert.ok(result.cleanup.warnings.some(warning => warning.includes('终止请求失败')));
    await fs.access(ownedRoot);
    const blocked = await mock.client.withEndpoint(request(), async () => assert.fail('quarantined runtime must not be reused'));
    assert.equal(blocked.outcome, 'rejected');
    assert.equal(mock.children.length, 1);
    mock.client.draining = Promise.reject(new Error('injected drain rejection'));
    await assert.rejects(mock.client.dispose(), AggregateError);
    assert.equal(attempts, 2);
    assert.equal(mock.client.getStatus().running, false);
    await assert.rejects(fs.access(ownedRoot));
    await mock.client.dispose();
});

test('nonsettling termination remains bounded, unconfirmed, and retryable on dispose', { timeout: 12000 }, async context => {
    let attempts = 0;
    const mock = await harness(context, async child => {
        attempts++;
        if (attempts === 1) await new Promise(() => {});
        else child.kill('SIGKILL');
    });
    const started = performance.now();
    const result = await mock.client.withEndpoint(request(), async endpoint => { expireCleanup(mock.client); return success(endpoint); });
    assert.equal(result.cleanup.status, 'unconfirmed');
    assert.ok(performance.now() - started < 4000);
    await mock.client.dispose();
    assert.equal(attempts, 2);
    assert.equal(mock.client.getStatus().running, false);
});

test('CIM transport uses hidden PowerShell JSON and accepts Windows PowerShell single-object output', async () => {
    let call;
    const rows = await queryLifecycleProcesses('ProcessId=42', (command, args, options, callback) => {
        call = { command, args, options };
        callback(null, '\uFEFF{"ProcessId":42,"Name":"language_server_amd64.exe"}');
    });
    assert.equal(call.command, 'powershell.exe');
    assert.ok(call.args.includes('-NonInteractive'));
    assert.match(call.args.at(-1), /Get-CimInstance.*ConvertTo-Json/u);
    assert.doesNotMatch(call.args.at(-1), /wmic/iu);
    assert.equal(call.options.windowsHide, true);
    assert.equal(rows[0].ProcessId, 42);
    assert.equal(await queryLifecycleProcesses('ProcessId=42', (_command, _args, _options, callback) => callback(new Error('unavailable'), '')), null);
    assert.equal(await queryLifecycleProcesses('ProcessId=42', (_command, _args, _options, callback) => callback(null, 'invalid JSON')), null);
});

test('host query failure remains unknown and legacy language_server names remain recognized', async () => {
    const options = { platform: 'win32', parentPid: 42 };
    for (const query of [async () => null, async () => [], async () => { throw new Error('CIM denied'); }]) {
        assert.equal(await detectParentHost({ ...options, query }), 'unknown');
    }
    for (const name of ['language_server_amd64.exe', 'language_server_windows_x64.exe', 'LANGUAGE_SERVER.exe']) {
        assert.equal(await detectParentHost({ ...options, query: async () => [{ ProcessId: 42, Name: name }] }), 'antigravity-ls');
    }
    assert.equal(await detectParentHost({ ...options, query: async () => [{ ProcessId: 42, Name: 'node.exe' }] }), 'other');
});

test('sibling JSON preserves commas, Chinese paths, parent identity, and Windows slash compatibility', async () => {
    const options = { platform: 'win32', parentPid: 42, pid: 100, scriptPath: 'C:\\fixture,中文\\web-fetcher\\index.js' };
    const sibling = { ProcessId: 101, ParentProcessId: 42, CommandLine: 'node "c:/fixture,中文/web-fetcher/index.js"' };
    assert.equal(await hasNewerSiblingInstance({ ...options, query: async () => [sibling] }), true);
    assert.equal(await hasNewerSiblingInstance({ ...options, query: async () => [{ ...sibling, ParentProcessId: 43 }] }), false);
    assert.equal(await hasNewerSiblingInstance({ ...options, query: async () => null }), false);
});

test('real local CIM query observes only this test process without WMIC', { skip: process.platform !== 'win32' }, async () => {
    const rows = await queryLifecycleProcesses(`ProcessId=${process.pid}`);
    assert.ok(rows?.some(row => row.ProcessId === process.pid && row.ParentProcessId === process.ppid));
});

test('another owner summary can occupy the global CLI while two inspection pages each retain a fresh execution budget', { timeout: 12000 }, async context => {
    const mock = await harness(context, undefined, {});
    const parentDeadline = performance.now() + 9000;
    let releaseSummary;
    const summaryGate = new Promise(resolve => { releaseSummary = resolve; });
    let summaryReady;
    const ready = new Promise(resolve => { summaryReady = resolve; });
    const summary = runWithRequestContext({ ownerId: 'summary-owner', deadline: parentDeadline }, () => mock.client.withEndpoint({ ...request(), deadline: parentDeadline }, async endpoint => {
        summaryReady();
        await summaryGate;
        return success(endpoint);
    }));
    await ready;
    const budgets = [];
    const inspect = runWithRequestContext({ ownerId: 'inspection-owner', deadline: parentDeadline }, async () => {
        const results = [];
        for (const pageNumber of [1, 2]) {
            results.push(await mock.client.withEndpoint({ ...request(), deadline: parentDeadline, generationTimeoutMs: 1000 }, async (endpoint, scoped) => {
                budgets.push(scoped.deadline - mock.children.at(-1).fixtureStartedAt);
                await pause(100);
                return { ...success(endpoint), text: `page-${pageNumber}` };
            }));
        }
        return results;
    });
    await pause(1200);
    assert.equal(mock.children.length, 1);
    releaseSummary();
    assert.equal((await summary).outcome, 'success');
    const pages = await inspect;
    assert.deepEqual(pages.map(page => page.text), ['page-1', 'page-2']);
    for (const budget of budgets) assert.ok(budget > 950 && budget <= 1000, `fresh generation budget ${budget}`);
    assert.equal(mock.children.length, 3);
});

test('parent deadline and signal still stop the original queued request without starting another process', { timeout: 10000 }, async context => {
    const mock = await harness(context, undefined, {});
    let releaseSummary;
    const summaryGate = new Promise(resolve => { releaseSummary = resolve; });
    let summaryReady;
    const ready = new Promise(resolve => { summaryReady = resolve; });
    const summary = mock.client.withEndpoint(request(), async endpoint => { summaryReady(); await summaryGate; return success(endpoint); });
    await ready;
    let pageCalls = 0;
    const expired = mock.client.withEndpoint({ ...request(), deadline: performance.now() + 100, generationTimeoutMs: 1000 }, async () => { pageCalls++; assert.fail('expired queued inspection'); });
    const controller = new AbortController();
    const cancelled = mock.client.withEndpoint({ ...request(), signal: controller.signal, generationTimeoutMs: 1000 }, async () => { pageCalls++; assert.fail('cancelled queued inspection'); });
    controller.abort();
    assert.equal((await cancelled).outcome, 'cancelled');
    const result = await expired;
    assert.equal(result.outcome, 'not-started');
    assert.equal(result.submitted, false);
    assert.equal(mock.children.length, 1);
    assert.equal(pageCalls, 0);
    releaseSummary();
    await summary;
});

test('execution budget expiration aborts the submitted request once and retains unknown outcome', { timeout: 10000 }, async context => {
    const mock = await harness(context, undefined, {});
    let submissions = 0;
    const result = await mock.client.withEndpoint({ ...request(), generationTimeoutMs: 500 }, async (_endpoint, scoped) => {
        scoped.onSubmitted('fixture');
        submissions++;
        return await new Promise((_resolve, reject) => scoped.signal.addEventListener('abort', () => reject(new Error('fixture request aborted')), { once: true }));
    });
    assert.equal(result.outcome, 'timeout-unknown');
    assert.equal(result.submitted, true);
    assert.equal(result.safeToFallback, false);
    assert.equal(result.cleanup.confirmed, true);
    assert.equal(submissions, 1);
    assert.equal(mock.children.length, 1);
});

test('automatic complete capacity rejection uses shared Hydrogen XHigh/High/Carbon candidates only after confirmed cleanup', { timeout: 10000 }, async context => {
    const mock = await harness(context, undefined, [{ promptError: noCapacity }, { promptError: noCapacity }, {}]);
    const enqueue = mock.client.enqueue.bind(mock.client);
    const deadlines = [];
    mock.client.enqueue = (incoming, transport, work, executionDeadline) => { deadlines.push(executionDeadline); return enqueue(incoming, transport, work, executionDeadline); };
    const result = await mock.client.callAgent({ ...request(), generationTimeoutMs: 4000 });
    assert.equal(result.outcome, 'success');
    assert.equal(result.model, 'gemini-4-carbon-high');
    assert.equal(mock.children.length, 3);
    assert.equal(deadlines[0], undefined);
    assert.equal(typeof deadlines[1], 'number');
    assert.equal(deadlines[1], deadlines[2]);
    const events = await mock.events();
    const selected = events.filter(event => event.message?.method === 'session/set_model').map(event => event.message.params.modelId);
    assert.deepEqual(selected, ['gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-high', 'gemini-4-carbon-high']);
    for (const event of events.filter(event => event.kind === 'spawn')) await assert.rejects(fs.access(event.cwd));
    assert.equal(result.cleanup.confirmed, true);
});

test('visual default uses Carbon and explicit request or environment model remains frozen after capacity rejection', { timeout: 10000 }, async context => {
    const visual = await harness(context, undefined, {});
    assert.equal((await visual.client.callAgent({ ...request(), purpose: 'visual-review' })).model, 'gemini-4-carbon-high');
    const explicit = await harness(context, undefined, [{ promptError: noCapacity }, {}]);
    const explicitResult = await explicit.client.callAgent({ ...request(), model: 'hydrogen-high' });
    assert.equal(explicitResult.model, 'gemini-4-hydrogen-high');
    assert.equal(explicitResult.outcome, 'rejected');
    assert.equal(explicitResult.safeToFallback, false);
    assert.equal(explicit.children.length, 1);
    const previous = process.env.WEB_FETCHER_LS_MODEL;
    context.after(() => { if (previous === undefined) delete process.env.WEB_FETCHER_LS_MODEL; else process.env.WEB_FETCHER_LS_MODEL = previous; });
    process.env.WEB_FETCHER_LS_MODEL = 'gemini-4-carbon-high';
    const environment = await harness(context, undefined, [{ promptError: noCapacity }, {}]);
    const environmentResult = await environment.client.callAgent(request());
    assert.equal(environmentResult.model, 'gemini-4-carbon-high');
    assert.equal(environmentResult.safeToFallback, false);
    assert.equal(environment.children.length, 1);
});

test('auth, quota, unknown dispatch, and partial capacity output never replay another model', { timeout: 12000 }, async context => {
    for (const [scenario, outcome] of [
        [{ promptError: { code: 401, message: 'authentication required' } }, 'auth-required'],
        [{ promptError: { code: 429, message: 'quota exhausted' } }, 'quota-exhausted'],
        [{ dieAfterPrompt: true }, 'transport-unknown'],
        [{ chunks: ['partial output'], terminal: { error: noCapacity } }, 'rejected'],
    ]) {
        const mock = await harness(context, undefined, [scenario, {}]);
        const result = await mock.client.callAgent(request());
        assert.equal(result.outcome, outcome);
        assert.equal(result.safeToFallback, false);
        assert.equal(mock.children.length, 1);
    }
});

test('capacity rejection with independent cleanup protocol fault never replays', { timeout: 10000 }, async context => {
    const mock = await harness(context, undefined, [{ promptError: noCapacity, latePermission: true }, {}]);
    const result = await mock.client.callAgent(request());
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.cleanup.confirmed, true);
    assert.ok(result.cleanup.fault);
    assert.equal(result.safeToFallback, false);
    assert.equal(mock.children.length, 1);
});

test('capacity rejection with unconfirmed owned exit never replays another model', { timeout: 10000 }, async context => {
    const mock = await harness(context, async () => {}, [{ promptError: noCapacity, ignoreEof: true }, {}]);
    const pending = mock.client.callAgent(request());
    while (!mock.client.runtime) await pause(5);
    expireCleanup(mock.client);
    const result = await pending;
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.cleanup.confirmed, false);
    assert.equal(result.cleanup.tempRemoved, false);
    assert.equal(result.safeToFallback, false);
    assert.equal(mock.children.length, 1);
});

test('queued endpoint lease freezes the environment model at enqueue instead of rereading a later environment', { timeout: 10000 }, async context => {
    const mock = await harness(context, undefined, {});
    const previous = process.env.WEB_FETCHER_LS_MODEL;
    context.after(() => { if (previous === undefined) delete process.env.WEB_FETCHER_LS_MODEL; else process.env.WEB_FETCHER_LS_MODEL = previous; });
    let releaseFirst;
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    let firstReady;
    const ready = new Promise(resolve => { firstReady = resolve; });
    const first = mock.client.withEndpoint(request(), async endpoint => { firstReady(); await gate; return success(endpoint); });
    await ready;
    process.env.WEB_FETCHER_LS_MODEL = 'gemini-4-carbon-high';
    const queued = mock.client.withEndpoint(request(), async (endpoint, scoped) => {
        assert.equal(scoped.model, 'gemini-4-carbon-high');
        return success(endpoint);
    });
    process.env.WEB_FETCHER_LS_MODEL = 'gemini-4-hydrogen-high';
    releaseFirst();
    await first;
    assert.equal((await queued).outcome, 'success');
});
