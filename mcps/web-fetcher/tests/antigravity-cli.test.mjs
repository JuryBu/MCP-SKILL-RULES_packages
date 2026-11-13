import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { AntigravityCliClient, isAntigravityCliInstalled, getAntigravityCliStatus } from '../src/antigravity-cli.ts';

const fixture = fileURLToPath(new URL('./fixtures/antigravity-cli/mock-acp.mjs', import.meta.url));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const request = (overrides = {}) => ({ prompt: 'Inspect the attached image', deadline: performance.now() + 6000, ...overrides });
const success = endpoint => ({ text: 'mock', transport: endpoint.transport, model: 'mock-model', outcome: 'success', submitted: true, safeToFallback: false });
const healthyMemory = () => ({ valid: true, mode: 'windows', sourceId: 'mock', sequence: 1, sampledAt: performance.now(), physicalAvailableMB: 16000, commitAvailableMB: 24000, lowMemory: false });

function mockHttpRpc(endpoint, scopedRequest, method, model) {
    return new Promise((resolve, reject) => {
        const outgoing = http.request({ host: endpoint.host, port: endpoint.port, method: 'POST', path: `/mock.LanguageServerService/${method}`, signal: scopedRequest.signal }, incoming => {
            let data = '';
            incoming.setEncoding('utf8');
            incoming.on('data', chunk => { data += chunk; });
            incoming.once('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
        });
        outgoing.once('error', reject);
        if (method === 'GetModelResponse') outgoing.once('finish', () => scopedRequest.onSubmitted?.(model));
        outgoing.end('{}');
    });
}

async function harness(context, options = {}, dependencies = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-cli-test-'));
    const auditPath = path.join(root, 'audit.jsonl');
    const image = path.join(root, 'image.png');
    await fs.writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1kAAAAASUVORK5CYII=', 'base64'));
    const children = [];
    const client = new AntigravityCliClient({
        resolveCommand: () => process.execPath,
        memoryProvider: { snapshot: healthyMemory },
        spawnProcess(command, args, spawnOptions) {
            assert.equal(command, process.execPath);
            const child = spawn(process.execPath, [fixture, ...args], { ...spawnOptions, env: { ...process.env, MOCK_AGY_OPTIONS: JSON.stringify(options), MOCK_AGY_AUDIT: auditPath } });
            children.push(child);
            return child;
        },
        ...dependencies,
    });
    context.after(async () => { await client.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    const events = async () => {
        try { return (await fs.readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
        catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    };
    const waitFor = async predicate => {
        const end = performance.now() + 3000;
        while (performance.now() < end) { const found = (await events()).find(predicate); if (found) return found; await pause(10); }
        assert.fail('Mock ACP milestone did not arrive');
    };
    return { client, root, image, children, events, waitFor };
}

test('installed and status are passive filesystem observations', async context => {
    let starts = 0;
    let samples = 0;
    const client = new AntigravityCliClient({ resolveCommand: () => process.execPath, spawnProcess: () => { starts++; throw new Error('must not start'); }, memoryProvider: { snapshot: () => { samples++; return healthyMemory(); } } });
    assert.equal(client.isInstalled(), true);
    assert.deepEqual(client.getStatus(), { installed: true, running: false, closing: false, activeLeases: 0, queuedRequests: 0, maxConcurrency: 1, memoryProtection: 'startup-watermark-only' });
    assert.equal(starts, 0); assert.equal(samples, 0);
    assert.equal(typeof isAntigravityCliInstalled(), 'boolean');
    assert.equal(getAntigravityCliStatus().running, false);
    context.after(() => client.dispose());
});

test('text lease uses owned logged HTTP port and never sends session/prompt', async context => {
    const mock = await harness(context);
    const result = await mock.client.withEndpoint(request(), async endpoint => {
        assert.equal(endpoint.host, '127.0.0.1');
        assert.equal(endpoint.pid, mock.children[0].pid);
        assert.match(endpoint.identity, new RegExp(`:${endpoint.pid}$`));
        return success(endpoint);
    });
    assert.equal(result.outcome, 'success');
    const events = await mock.events();
    const messages = events.filter(event => event.kind === 'message').map(event => event.message);
    assert.deepEqual(messages.map(message => message.method), ['initialize', 'session/new']);
    assert.deepEqual(messages[0].params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    assert.deepEqual(messages[1].params.mcpServers, []);
    assert.notEqual(messages[1].params.cwd, process.cwd());
    assert.equal(events.some(event => event.kind === 'eof'), true);
    await assert.rejects(fs.stat(messages[1].params.cwd), { code: 'ENOENT' });
    assert.equal(mock.client.getStatus().running, false);
});

test('structured text agent needs no image capability and retains schema and isolated permissions', async context => {
    const mock = await harness(context, { image: false });
    const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
    const result = await mock.client.callAgent(request({ prompt: 'Summarize supplied text only', schema }));
    assert.equal(result.outcome, 'success');
    assert.equal(result.model, 'gemini-3.8-flash-high');
    assert.equal(result.cleanup.confirmed, true);
    assert.equal(result.cleanup.tempRemoved, true);
    const events = await mock.events();
    const prompt = events.find(event => event.kind === 'message' && event.message.method === 'session/prompt').message.params.prompt;
    assert.deepEqual(prompt, [{ type: 'text', text: 'Summarize supplied text only' }, { type: 'text', text: `Return JSON matching this schema: ${JSON.stringify(schema)}` }]);
    const args = events.find(event => event.kind === 'spawn').args;
    assert.equal(args.includes('--include-default-customizations=false'), true);
    assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).toolPermission, 'strict');
});

test('image sends real bytes and isolated deny settings, denies permissions and client tools', async context => {
    const mock = await harness(context, { permission: true, clientCalls: true, interimMessage: true });
    const result = await mock.client.callAgent(request({ imagePaths: [mock.image] }));
    assert.equal(result.outcome, 'success');
    assert.equal(result.text, '{"image":true}');
    assert.equal(result.model, 'gemini-3.8-flash-high');
    const events = await mock.events();
    const args = events.find(event => event.kind === 'spawn').args;
    assert.equal(args.includes('--dangerously-skip-permissions'), false);
    assert.equal(args.includes('--include-default-customizations=false'), true);
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    assert.equal(settings.toolPermission, 'strict');
    assert.equal(settings.permissions.deny.includes('read_file(*)'), true);
    assert.equal(settings.permissions.deny.includes('command(*)'), true);
    const messages = events.filter(event => event.kind === 'message').map(event => event.message);
    const prompt = messages.find(message => message.method === 'session/prompt').params.prompt;
    assert.equal(prompt[1].type, 'image'); assert.equal(prompt[1].mimeType, 'image/png');
    assert.deepEqual(Buffer.from(prompt[1].data, 'base64'), await fs.readFile(mock.image));
    assert.deepEqual(messages.find(message => message.id === 'permission-1').result, { outcome: { outcome: 'cancelled' } });
    assert.equal(messages.find(message => message.id === 'fs-1').error.code, -32601);
    assert.equal(messages.find(message => message.id === 'terminal-1').error.code, -32601);
    assert.equal(messages.find(message => message.method === 'session/set_model').params.modelId, result.model);
});

test('cancellation sends session/cancel and waits for original cancelled terminal before EOF', async context => {
    const mock = await harness(context, { hangPrompt: true, cancelDelay: 50 });
    const controller = new AbortController();
    const pending = mock.client.callAgent(request({ imagePaths: [mock.image], signal: controller.signal }));
    await mock.waitFor(event => event.kind === 'message' && event.message.method === 'session/prompt');
    controller.abort();
    const result = await pending;
    assert.equal(result.outcome, 'cancelled'); assert.equal(result.submitted, true); assert.equal(result.safeToFallback, false);
    const events = await mock.events();
    assert.ok(events.findIndex(event => event.kind === 'cancel') < events.findIndex(event => event.kind === 'cancelled-terminal'));
    assert.ok(events.findIndex(event => event.kind === 'cancelled-terminal') < events.findIndex(event => event.kind === 'eof'));
});

test('two leases serialize through EOF, queued cancellation never kills the active tenant', async context => {
    const mock = await harness(context, { eofDelay: 80 });
    let release;
    const first = mock.client.withEndpoint(request(), async endpoint => { await new Promise(resolve => { release = resolve; }); return success(endpoint); });
    await mock.waitFor(event => event.kind === 'message' && event.message.method === 'session/new');
    while (!release) await pause(10);
    const cancelQueued = new AbortController();
    const second = mock.client.withEndpoint(request({ signal: cancelQueued.signal }), async endpoint => success(endpoint));
    cancelQueued.abort();
    assert.equal((await second).outcome, 'cancelled');
    assert.equal(mock.children[0].exitCode, null);
    const third = mock.client.withEndpoint(request(), async endpoint => success(endpoint));
    release();
    assert.equal((await first).outcome, 'success'); assert.equal((await third).outcome, 'success');
    const events = await mock.events();
    const starts = events.filter(event => event.kind === 'spawn');
    const eof = events.find(event => event.kind === 'eof');
    assert.equal(starts.length, 2);
    assert.ok(starts[1].at >= eof.at + 60);
    assert.notEqual(starts[0].cwd, starts[1].cwd);
});

test('active cancellation leaves a queued independent request healthy', async context => {
    const mock = await harness(context);
    const controller = new AbortController();
    const first = mock.client.withEndpoint(request({ signal: controller.signal }), async () => new Promise(() => {}));
    await mock.waitFor(event => event.kind === 'message' && event.message.method === 'session/new');
    const second = mock.client.withEndpoint(request(), async endpoint => success(endpoint));
    controller.abort();
    assert.equal((await first).safeToFallback, false);
    assert.equal((await second).outcome, 'success');
});

test('one deadline includes queueing and generation; ignored cancel is bounded', async context => {
    const mock = await harness(context, { hangPrompt: true, ignoreCancel: true });
    const started = performance.now();
    const result = await mock.client.callAgent(request({ deadline: started + 1200, imagePaths: [mock.image] }));
    assert.equal(result.outcome, 'timeout-unknown'); assert.equal(result.submitted, true); assert.equal(result.safeToFallback, false);
    assert.ok(performance.now() - started < 1450);
    if (result.cleanup.confirmed) assert.equal(mock.client.getStatus().running, false);
    else {
        assert.equal(result.cleanup.status, 'unconfirmed');
        assert.equal(mock.client.getStatus().closing, true);
        assert.ok(result.cleanup.warnings.some(warning => warning.includes('尚未确认')));
    }
    await mock.client.dispose();
    assert.equal(mock.client.getStatus().running, false);
});

test('queue deadline expires without launching another CLI', async context => {
    const mock = await harness(context);
    let release;
    const first = mock.client.withEndpoint(request(), async endpoint => { await new Promise(resolve => { release = resolve; }); return success(endpoint); });
    while (!release) await pause(10);
    const result = await mock.client.withEndpoint(request({ deadline: performance.now() + 100 }), async endpoint => success(endpoint));
    assert.equal(result.outcome, 'not-started'); assert.equal(result.submitted, false);
    assert.equal(mock.children.length, 1);
    release(); await first;
});

test('post-submission EOF is unknown, never safe to fall back', async context => {
    const mock = await harness(context, { dieAfterPrompt: true });
    const result = await mock.client.callAgent(request({ imagePaths: [mock.image] }));
    assert.equal(result.outcome, 'transport-unknown'); assert.equal(result.submitted, true); assert.equal(result.safeToFallback, false);
});

test('startup failure is observed once and does not invoke callback', async context => {
    let starts = 0;
    const mock = await harness(context, {}, { spawnProcess() { starts++; return spawn(path.join(os.tmpdir(), 'agy-does-not-exist.exe'), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } });
    const result = await mock.client.withEndpoint(request(), async () => assert.fail('callback must not run'));
    assert.equal(result.outcome, 'not-started'); assert.equal(result.submitted, false); assert.equal(result.safeToFallback, true);
    assert.equal(starts, 1);
});

for (const [label, options, expected] of [
    ['missing image capability', { image: false }, 'unsupported'],
    ['protocol mismatch', { protocolVersion: 2 }, 'unsupported'],
    ['authentication rejection', { initializeError: { code: 401, message: 'token=PRIVATE unauthorized' } }, 'auth-required'],
    ['quota rejection', { promptError: { code: 429, message: 'quota exhausted token=PRIVATE' } }, 'quota-exhausted'],
    ['truncated final result', { stopReason: 'max_tokens' }, 'invalid-response'],
    ['refusal', { stopReason: 'refusal' }, 'rejected'],
    ['native tool invocation', { nativeTool: true }, 'rejected'],
    ['unbounded stream', { overflow: true }, 'invalid-response'],
    ['non-JSON protocol output', { invalidStdout: true }, 'invalid-response'],
    ['missing catalog model', { models: [] }, 'unsupported'],
    ['disabled catalog model', { models: [{ modelId: 'gemini-3.8-flash-high', disabled: true }] }, 'rejected'],
    ['model switch unsupported', { setModelError: { code: -32601, message: 'method not found' } }, 'unsupported'],
    ['bad final status', { terminal: { terminalStatus: 'failed' } }, 'invalid-response'],
]) {
    test(label, async context => {
        const mock = await harness(context, options);
        const result = await mock.client.callAgent(request({ imagePaths: [mock.image] }));
        assert.equal(result.outcome, expected);
        assert.equal(result.text, null);
        assert.equal(result.error.includes('PRIVATE'), false);
        if (result.submitted || ['auth-required', 'quota-exhausted', 'rejected'].includes(expected)) assert.equal(result.safeToFallback, false);
        assert.equal(mock.children.length, 1);
    });
}

test('missing and corrupt images never send prompt or silently become text', async context => {
    const mock = await harness(context);
    const missing = await mock.client.callAgent(request({ imagePaths: [path.join(mock.root, 'missing.png')] }));
    assert.equal(missing.outcome, 'rejected'); assert.equal(missing.submitted, false);
    await fs.writeFile(mock.image, 'not an image');
    const corrupt = await mock.client.callAgent(request({ imagePaths: [mock.image] }));
    assert.equal(corrupt.outcome, 'unsupported');
    assert.equal((await mock.events()).some(event => event.kind === 'message' && event.message.method === 'session/prompt'), false);
});

test('wrong logged PID never reaches endpoint callback', async context => {
    const mock = await harness(context, { wrongPid: true });
    const result = await mock.client.withEndpoint(request(), async () => assert.fail('unowned endpoint'));
    assert.equal(result.outcome, 'not-started'); assert.equal(result.submitted, false);
});

test('memory pressure prevents launch without retry or imaginary hard-limit claim', async context => {
    const mock = await harness(context, {}, { memoryProvider: { snapshot: () => ({ ...healthyMemory(), lowMemory: true }) } });
    const result = await mock.client.withEndpoint(request(), async () => assert.fail('not admitted'));
    assert.equal(result.outcome, 'rejected'); assert.equal(result.safeToFallback, false);
    assert.equal(mock.children.length, 0);
    assert.equal(mock.client.getStatus().memoryProtection, 'startup-watermark-only');
});

test('stale memory sampling waits only within original deadline', async context => {
    const mock = await harness(context, {}, { memoryProvider: { snapshot: () => ({ ...healthyMemory(), sampledAt: -Infinity }) } });
    const result = await mock.client.withEndpoint(request({ deadline: performance.now() + 100 }), async () => assert.fail('stale admission'));
    assert.equal(result.outcome, 'not-started'); assert.equal(mock.children.length, 0);
});

test('dispose cancels active and queued leases and permanently closes this client', async context => {
    const mock = await harness(context, { hangPrompt: true });
    const first = mock.client.callAgent(request({ imagePaths: [mock.image] }));
    await mock.waitFor(event => event.kind === 'message' && event.message.method === 'session/prompt');
    const second = mock.client.withEndpoint(request(), async () => assert.fail('disposed queue'));
    await mock.client.dispose();
    assert.equal((await first).outcome, 'cancelled'); assert.equal((await second).outcome, 'cancelled');
    assert.equal((await mock.client.withEndpoint(request(), async endpoint => success(endpoint))).outcome, 'cancelled');
    assert.equal(mock.client.getStatus().running, false);
});

test('monotonic request budget survives wall-clock changes in both directions', async context => {
    const mock = await harness(context);
    let wallNow = Date.now() + 365 * 24 * 60 * 60 * 1000;
    context.mock.method(Date, 'now', () => wallNow);
    const result = await mock.client.withEndpoint(request(), async endpoint => {
        wallNow = -1000000;
        await pause(20);
        return success(endpoint);
    });
    assert.equal(result.outcome, 'success');
});

test('EOF-resistant owned CLI is force-cleaned without touching an unrelated process', async context => {
    const sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    const siblingClosed = new Promise(resolve => sibling.once('close', resolve));
    context.after(async () => { sibling.kill(); await siblingClosed; });
    const mock = await harness(context, { ignoreEof: true });
    const result = await mock.client.withEndpoint(request(), async endpoint => success(endpoint));
    assert.equal(result.outcome, 'success'); assert.equal(result.text, 'mock');
    assert.equal(result.cleanup.status, 'terminated'); assert.equal(result.cleanup.confirmed, true);
    assert.equal(result.cleanup.method, 'owned-tree-terminate');
    assert.notEqual(result.cleanup.exitCode, 0);
    assert.equal(result.safeToFallback, false);
    assert.notEqual(mock.children[0].exitCode ?? mock.children[0].signalCode, null);
    assert.equal(sibling.exitCode, null); assert.equal(sibling.signalCode, null);
    assert.equal(mock.client.getStatus().running, false);
});

test('late permission during cleanup retains known output and records the independent protocol fault', async context => {
    const mock = await harness(context, { latePermission: true });
    const result = await mock.client.callAgent(request({ imagePaths: [mock.image] }));
    assert.equal(result.outcome, 'success'); assert.equal(result.text, '{"image":true}');
    assert.equal(result.cleanup.status, 'abnormal-exit');
    assert.equal(result.cleanup.fault.outcome, 'transport-unknown');
    assert.equal(result.safeToFallback, false);
});

test('bounded queue refuses excess work without launching or disturbing active work', async context => {
    const mock = await harness(context, {}, { queueLimit: 1 });
    let release;
    const first = mock.client.withEndpoint(request(), async endpoint => { await new Promise(resolve => { release = resolve; }); return success(endpoint); });
    while (!release) await pause(10);
    const second = mock.client.withEndpoint(request(), async endpoint => success(endpoint));
    const rejected = await mock.client.withEndpoint(request(), async () => assert.fail('queue overflow'));
    assert.equal(rejected.outcome, 'rejected'); assert.equal(rejected.safeToFallback, false);
    assert.equal(mock.children.length, 1);
    release();
    assert.equal((await first).outcome, 'success'); assert.equal((await second).outcome, 'success');
});

test('ordinary stderr diagnostics are drained without becoming a model result or auth failure', async context => {
    const mock = await harness(context, { stderr: 'authentication initialized; quota observation enabled\n' });
    const result = await mock.client.callAgent(request({ imagePaths: [mock.image] }));
    assert.equal(result.outcome, 'success'); assert.equal(result.text, '{"image":true}');
});

test('post-submission callback rejection remains unknown and cannot fall back', async context => {
    const mock = await harness(context);
    const result = await mock.client.withEndpoint(request(), async (_endpoint, scopedRequest) => { scopedRequest.onSubmitted('mock-model'); throw new Error('network failure token=PRIVATE'); });
    assert.equal(result.outcome, 'transport-unknown'); assert.equal(result.submitted, true); assert.equal(result.safeToFallback, false);
    assert.equal(result.error.includes('PRIVATE'), false);
});

test('nonzero exit after a confirmed terminal preserves the model result and reports the cleanup failure', async context => {
    const mock = await harness(context, { exitCode: 2 });
    const result = await mock.client.callAgent(request({ imagePaths: [mock.image] }));
    assert.equal(result.outcome, 'success'); assert.equal(result.model, 'gemini-3.8-flash-high');
    assert.equal(result.text, '{"image":true}'); assert.equal(result.cleanup.status, 'abnormal-exit');
    assert.equal(result.cleanup.exitCode, 2); assert.equal(result.cleanup.confirmed, true);
    assert.equal(result.cleanup.fault.outcome, 'transport-unknown');
});

test('unreadable image paths and empty prompts are rejected without silently generating text', async context => {
    const mock = await harness(context);
    const result = await mock.client.callAgent(request({ imagePaths: [mock.image], prompt: ' ' }));
    assert.equal(result.outcome, 'rejected'); assert.equal(mock.children.length, 0);
    const image = path.join(mock.root, '中文 image.png');
    await fs.copyFile(mock.image, image);
    assert.equal((await mock.client.callAgent(request({ imagePaths: [image] }))).outcome, 'success');
});

test('oversized ACP request is rejected before submission and never sends prompt', async context => {
    const mock = await harness(context);
    const result = await mock.client.callAgent(request({ prompt: 'x'.repeat(21 * 1024 * 1024), imagePaths: [mock.image] }));
    assert.equal(result.outcome, 'rejected'); assert.equal(result.submitted, false); assert.equal(result.safeToFallback, false);
    assert.equal((await mock.events()).some(event => event.kind === 'message' && event.message.method === 'session/prompt'), false);
});

test('metadata callback cancellation aborts downstream HTTP with zero generation submissions', async context => {
    const mock = await harness(context, { httpMetadataHang: true });
    const controller = new AbortController();
    const notified = [];
    let downstream;
    const original = request({ signal: controller.signal, onSubmitted: model => notified.push(model) });
    const pending = mock.client.withEndpoint(original, async (endpoint, scopedRequest) => {
        downstream = scopedRequest;
        assert.ok(scopedRequest.deadline < original.deadline);
        assert.notEqual(scopedRequest.signal, original.signal);
        await mockHttpRpc(endpoint, scopedRequest, 'GetUserStatus');
        assert.fail('cancelled metadata must not continue to generation');
    });
    await mock.waitFor(event => event.kind === 'http-request' && event.method === 'GetUserStatus');
    controller.abort();
    const result = await pending;
    assert.equal(result.outcome, 'cancelled'); assert.equal(result.submitted, false); assert.equal(result.safeToFallback, false);
    assert.equal(downstream.signal.aborted, true); assert.deepEqual(notified, []);
    const events = await mock.events();
    assert.equal(events.some(event => event.kind === 'http-request' && event.method === 'GetModelResponse'), false);
    assert.equal(events.some(event => event.kind === 'http-close' && event.method === 'GetUserStatus' && event.aborted), true);
});

test('metadata operation deadline aborts downstream HTTP before the cleanup deadline without submission', async context => {
    const mock = await harness(context, { httpMetadataHang: true });
    let downstream;
    let callbackError;
    const started = performance.now();
    const pending = mock.client.withEndpoint(request({ deadline: started + 1200 }), async (endpoint, scopedRequest) => {
        downstream = scopedRequest;
        try { await mockHttpRpc(endpoint, scopedRequest, 'GetUserStatus'); }
        catch (error) { callbackError = { name: error.name, code: error.code, message: error.message }; throw error; }
        assert.fail('timed out metadata must not generate');
    });
    const result = await pending;
    assert.equal(result.outcome, 'not-started'); assert.equal(result.submitted, false); assert.equal(result.safeToFallback, false, JSON.stringify({ callbackError, result }));
    assert.equal(downstream.signal.aborted, true);
    assert.ok(performance.now() - started < 1400);
    assert.equal((await mock.events()).some(event => event.kind === 'http-request' && event.method === 'GetModelResponse'), false);
});

test('generation hook records actual model, chains the original hook, and preserves submitted cancellation', async context => {
    const mock = await harness(context, { httpGenerationHang: true });
    const controller = new AbortController();
    const notified = [];
    const pending = mock.client.withEndpoint(request({ signal: controller.signal, onSubmitted: model => notified.push(model) }), async (endpoint, scopedRequest) => {
        await mockHttpRpc(endpoint, scopedRequest, 'GetUserStatus');
        assert.deepEqual(notified, []);
        await mockHttpRpc(endpoint, scopedRequest, 'GetModelResponse', 'actual-mock-model');
        assert.fail('cancelled generation must not complete');
    });
    await mock.waitFor(event => event.kind === 'http-request' && event.method === 'GetModelResponse');
    controller.abort();
    const result = await pending;
    assert.equal(result.outcome, 'cancelled'); assert.equal(result.submitted, true); assert.equal(result.safeToFallback, false);
    assert.equal(result.model, 'actual-mock-model'); assert.deepEqual(notified, ['actual-mock-model']);
    const events = await mock.events();
    assert.equal(events.some(event => event.kind === 'http-close' && event.method === 'GetModelResponse' && event.aborted), true);
});

test('EOF shutdown slower than 500ms remains graceful and preserves confirmed image output', async context => {
    const mock = await harness(context, { eofDelay: 900 });
    const started = performance.now();
    const result = await mock.client.callAgent(request({ deadline: started + 2400, imagePaths: [mock.image] }));
    assert.equal(result.outcome, 'success'); assert.equal(result.text, '{"image":true}');
    assert.equal(result.cleanup.status, 'graceful'); assert.equal(result.cleanup.method, 'stdin-eof');
    assert.equal(result.cleanup.confirmed, true); assert.equal(result.cleanup.exitCode, 0);
    assert.ok(result.cleanup.eofWaitMs >= 850); assert.equal(result.cleanup.fault, undefined);
    assert.equal(result.cleanup.tempRemoved, true); assert.ok(performance.now() - started < 2600);
});

test('long request reserves four seconds inside its original deadline for EOF and owned-tree cleanup', async context => {
    const mock = await harness(context);
    const original = request({ deadline: performance.now() + 30000 });
    const result = await mock.client.withEndpoint(original, async (endpoint, scopedRequest) => {
        assert.equal(original.deadline - scopedRequest.deadline, 4000);
        return success(endpoint);
    });
    assert.equal(result.outcome, 'success'); assert.equal(result.cleanup.status, 'graceful');
});
