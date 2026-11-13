import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    createAntigravityClient,
    discoverAntigravityEndpoints,
    getLsModelCandidates,
    inspectAntigravityLsProcesses,
    validateAntigravityHub,
} from '../src/ls-client.ts';
import { antigravityFailure } from '../src/antigravity-types.ts';
import { callAntigravityModel } from '../src/antigravity-rpc.ts';

const defaultModel = 'MODEL_PLACEHOLDER_M318';
const modernEntries = [
    ['Gemini 4 Carbon (Medium)', 437], ['Gemini 4 Carbon (High)', 427], ['Gemini 4 Carbon (Low)', 438],
    ['Gemini 4 Argon (Medium)', 418], ['Gemini 4 Argon (High)', 417], ['Gemini 4 Argon (Low)', 419],
    ['Gemini 4 Hydrogen (High)', 525], ['Gemini 4 Hydrogen (XHigh)', 528],
    ['Gemini 4 Hydrogen (Medium)', 526], ['Gemini 4 Hydrogen (Low)', 527],
    ['Orchestrator (Carbon)', 667], ['Orchestrator (Argon)', 681],
    ['Gemini 3.8 Flash (High)', 318], ['Gemini 3.8 Flash (Medium)', 319], ['Gemini 3.8 Flash (Low)', 320],
    ['Claude Opus 5.5 (Low)', 400], ['Claude Opus 5.5 (Medium)', 401], ['Claude Opus 5.5 (High)', 402],
    ['Claude Sonnet 5.5 (Low)', 403], ['Claude Sonnet 5.5 (Medium)', 404], ['Claude Sonnet 5.5 (High)', 405],
    ['GPT-OSS 120B (Medium)', 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM'],
];

function catalog(account = 'fixture-account-a', configure = () => {}) {
    const models = modernEntries.map(([label, id]) => ({
        label, modelOrAlias: { model: typeof id === 'number' ? `MODEL_PLACEHOLDER_M${id}` : id },
        disabled: false, quotaInfo: { remainingFraction: 0.75 },
    }));
    configure(models);
    return { userStatus: { userId: account, userTier: { name: 'Google AI Ultra' },
        cascadeModelConfigData: { clientModelConfigs: models } } };
}

function request(overrides = {}) {
    return { prompt: 'fixture prompt', deadline: performance.now() + 2000, ...overrides };
}

function success(transport = 'cli-agent') {
    return { text: 'fixture result', transport, model: defaultModel, outcome: 'success', submitted: true, safeToFallback: false };
}

async function endpointFixture(context, handler) {
    const requests = [];
    const sockets = new Set();
    const server = http.createServer((incoming, outgoing) => {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => {
            const operation = { method: incoming.url.split('/').at(-1), body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
            requests.push(operation);
            handler(operation, incoming, outgoing);
        });
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    });
    return { requests, endpoint: { host: '127.0.0.1', port: server.address().port, pid: process.pid,
        identity: `fixture:${server.address().port}`, transport: 'app-ls', csrfToken: 'fixture-secret' } };
}

function json(outgoing, data, status = 200) {
    outgoing.writeHead(status, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify(data));
}

function clientFor(endpoint, overrides = {}) {
    return createAntigravityClient({
        discover: async () => endpoint ? [endpoint] : [],
        cliEndpoint: async () => assert.fail('CLI must not start'),
        cliAgent: async () => assert.fail('CLI agent must not start'),
        cliInstalled: () => true,
        ...overrides,
    });
}

function generationRequests(fixture) {
    return fixture.requests.filter(operation => operation.method === 'GetModelResponse');
}

test('modern App uses the current 22-entry Ultra catalog and M318 without starting CLI', async context => {
    const fixture = await endpointFixture(context, (operation, _incoming, outgoing) =>
        json(outgoing, operation.method === 'GetUserStatus' ? catalog() : { response: 'app result' }));
    const client = clientFor(fixture.endpoint);
    const result = await client.callAntigravity(request());
    assert.deepEqual(result, { text: 'app result', transport: 'app-ls', model: defaultModel,
        outcome: 'success', submitted: true, safeToFallback: false });
    assert.deepEqual(fixture.requests.map(operation => operation.method), ['GetUserStatus', 'GetModelResponse']);
    assert.equal(generationRequests(fixture)[0].body.model, defaultModel);
    assert.equal(client.getLsStatus().port, fixture.endpoint.port);
    client.clearLsCache();
    assert.deepEqual(client.getLsStatus(), { available: false });
});

test('structured text keeps online App first and does not start a CLI agent', async context => {
    const fixture = await endpointFixture(context, (operation, _incoming, outgoing) =>
        json(outgoing, operation.method === 'GetUserStatus' ? catalog() : { response: '{"summary":"app result"}' }));
    const result = await clientFor(fixture.endpoint).callAntigravity(request({ schema: { type: 'object' } }));
    assert.equal(result.transport, 'app-ls');
    assert.equal(result.outcome, 'success');
});

test('absent App sends structured text directly to the isolated agent, preserving request and deadline', async () => {
    const original = request({ schema: { type: 'object' } });
    const client = clientFor(null, { cliAgent: async received => { assert.equal(received, original); return success(); } });
    assert.equal((await client.callAntigravity(original)).transport, 'cli-agent');
});

test('structured text agent preserves the configured explicit LS model and its selection errors', async () => {
    const previous = process.env.WEB_FETCHER_LS_MODEL;
    process.env.WEB_FETCHER_LS_MODEL = 'MODEL_PLACEHOLDER_M402';
    try {
        const client = clientFor(null, { cliAgent: async received => {
            assert.equal(received.model, 'MODEL_PLACEHOLDER_M402');
            return antigravityFailure('quota-exhausted', 'fixture explicit quota', 'cli-agent', received.model);
        } });
        assert.equal((await client.callAntigravity(request({ schema: {} }))).outcome, 'quota-exhausted');
    } finally {
        if (previous === undefined) delete process.env.WEB_FETCHER_LS_MODEL;
        else process.env.WEB_FETCHER_LS_MODEL = previous;
    }
});

test('unconfirmed cleanup blocks an otherwise safe pre-submission structured-agent fallback', async () => {
    const result = { ...antigravityFailure('unsupported', 'fixture pre-submission failure', 'cli-agent', null, false, true), cleanup: { confirmed: false, status: 'unconfirmed', warnings: ['pending cleanup'] } };
    const actual = await clientFor(null, { cliAgent: async () => result }).callAntigravity(request({ schema: {} }));
    assert.equal(actual.outcome, 'unsupported');
    assert.equal(actual.safeToFallback, false);
    assert.equal(actual.cleanup.confirmed, false);
});

for (const outcome of ['not-started', 'unsupported']) {
    test(`structured agent ${outcome} before submission permits the existing CLI-LS compatibility path`, async () => {
        let starts = 0;
        const client = clientFor(null, {
            cliAgent: async () => antigravityFailure(outcome, 'fixture unsupported entry', 'cli-agent', null, false, true),
            cliEndpoint: async () => { starts++; return success('cli-ls'); },
        });
        assert.equal((await client.callAntigravity(request({ schema: { type: 'object' } }))).transport, 'cli-ls');
        assert.equal(starts, 1);
    });
}

for (const outcome of ['auth-required', 'quota-exhausted', 'rejected', 'timeout-unknown', 'transport-unknown', 'invalid-response', 'cancelled']) {
    test(`structured agent ${outcome} stops without submitting to a second entry`, async () => {
        const result = antigravityFailure(outcome, 'fixture terminal failure', 'cli-agent', null, ['timeout-unknown', 'transport-unknown'].includes(outcome), true);
        const client = clientFor(null, { cliAgent: async () => result });
        assert.equal(await client.callAntigravity(request({ schema: { type: 'object' } })), result);
    });
}

test('submitted structured agent unsupported response never replays through CLI-LS', async () => {
    const result = antigravityFailure('unsupported', 'submitted fixture', 'cli-agent', null, true, true);
    assert.equal(await clientFor(null, { cliAgent: async () => result }).callAntigravity(request({ schema: {} })), result);
});

test('absent App uses one owned CLI endpoint with the same deadline and no cached borrowed port', async context => {
    const fixture = await endpointFixture(context, (operation, _incoming, outgoing) =>
        json(outgoing, operation.method === 'GetUserStatus' ? catalog() : { response: 'cli-ls result' }));
    const original = request();
    let starts = 0;
    const client = clientFor(null, {
        cliEndpoint: async (received, work) => {
            starts += 1;
            assert.equal(received, original);
            return work({ ...fixture.endpoint, transport: 'cli-ls' }, received);
        },
    });
    const result = await client.callAntigravity(original);
    assert.equal(result.text, 'cli-ls result');
    assert.equal(result.transport, 'cli-ls');
    assert.equal(starts, 1);
    assert.equal(generationRequests(fixture).length, 1);
    assert.deepEqual(client.getLsStatus(), { available: false });
});

test('CLI scoped cancellation and operation deadline control catalog and generation independently of the outer request', async context => {
    for (const mode of ['catalog-cancel', 'catalog-deadline', 'submitted-cancel']) {
        await context.test(mode, async subcontext => {
            const controller = new AbortController();
            const submitted = [];
            const fixture = await endpointFixture(subcontext, (operation, _incoming, outgoing) => {
                if (operation.method === 'GetUserStatus') {
                    if (mode === 'catalog-cancel') controller.abort();
                    else if (mode !== 'catalog-deadline') json(outgoing, catalog());
                } else controller.abort();
            });
            const original = request({ model: 'M319' });
            const client = clientFor(null, {
                cliEndpoint: async (received, work) => {
                    assert.equal(received, original);
                    return work({ ...fixture.endpoint, transport: 'cli-ls' }, { ...received,
                        deadline: performance.now() + 100, signal: controller.signal,
                        onSubmitted: selected => submitted.push(selected) });
                },
            });
            const startedAt = performance.now();
            const result = await client.callAntigravity(original);
            assert.equal(result.outcome, mode === 'catalog-deadline' ? 'not-started' : 'cancelled');
            assert.equal(result.submitted, mode === 'submitted-cancel');
            assert.equal(result.safeToFallback, false);
            assert.equal(original.signal, undefined);
            assert.ok(performance.now() - startedAt < 800);
            assert.deepEqual(submitted, mode === 'submitted-cancel' ? ['MODEL_PLACEHOLDER_M319'] : []);
            assert.equal(generationRequests(fixture).length, mode === 'submitted-cancel' ? 1 : 0);
        });
    }
});

test('images go directly to CLI agent with their original paths and never silently become text RPC', async () => {
    const original = request({ imagePaths: ['C:\\fixture folder\\图片.png'], schema: { type: 'object' } });
    let calls = 0;
    const client = clientFor(null, {
        discover: async () => assert.fail('image request must not discover App'),
        cliAgent: async received => { assert.equal(received, original); calls += 1; return success(); },
    });
    assert.equal((await client.callAntigravity(original)).transport, 'cli-agent');
    assert.equal(calls, 1);
});

test('availability and status never launch CLI or request model generation', async context => {
    const fixture = await endpointFixture(context, (operation, _incoming, outgoing) => {
        assert.equal(operation.method, 'Heartbeat');
        json(outgoing, {});
    });
    const client = clientFor(fixture.endpoint);
    assert.deepEqual(client.getLsStatus(), { available: false });
    assert.equal(await client.isLsAvailable(), true);
    assert.equal(await client.isAntigravityAvailable(), true);
    assert.equal(generationRequests(fixture).length, 0);
    const offline = clientFor(null);
    assert.equal(await offline.isLsAvailable(), false);
    assert.equal(await offline.isAntigravityAvailable(), true);
    const uninstalled = clientFor(null, { cliInstalled: () => false });
    assert.equal(await uninstalled.isAntigravityAvailable(), false);
});

test('endpoint identity changes and account switches cannot reuse cached port or quota', async context => {
    let account = 'fixture-account-a';
    const first = await endpointFixture(context, (operation, _incoming, outgoing) =>
        json(outgoing, operation.method === 'GetUserStatus' ? catalog() : { response: 'first' }));
    const second = await endpointFixture(context, (operation, _incoming, outgoing) =>
        json(outgoing, operation.method === 'GetUserStatus'
            ? catalog(account, models => {
                if (account.endsWith('-b')) models.find(item => item.modelOrAlias.model === defaultModel).quotaInfo.remainingFraction = 0;
            }) : { response: 'second' }));
    let endpoint = first.endpoint;
    const client = clientFor(null, { discover: async () => [endpoint] });
    assert.equal((await client.callAntigravity(request())).text, 'first');
    endpoint = { ...second.endpoint, pid: first.endpoint.pid, identity: 'restarted-same-pid-new-start-identity' };
    assert.equal((await client.callAntigravity(request())).text, 'second');
    assert.equal(client.getLsStatus().port, second.endpoint.port);
    account = 'fixture-account-b';
    const exhausted = await client.callAntigravity(request({ model: defaultModel }));
    assert.equal(exhausted.outcome, 'quota-exhausted');
    assert.equal(exhausted.submitted, false);
    assert.equal(generationRequests(first).length, 1);
    assert.equal(generationRequests(second).length, 1);
    assert.equal(second.requests.filter(operation => operation.method === 'GetUserStatus').length, 2);
});

test('malformed or empty modern GetUserStatus cannot silently enter the legacy model table', async context => {
    for (const body of [{}, { userStatus: {} }, { userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } } }]) {
        await context.test(JSON.stringify(body), async subcontext => {
            const fixture = await endpointFixture(subcontext, (_operation, _incoming, outgoing) => json(outgoing, body));
            const result = await clientFor(fixture.endpoint).callAntigravity(request());
            assert.equal(result.outcome, 'invalid-response');
            assert.equal(result.submitted, false);
            assert.equal(result.safeToFallback, false);
            assert.equal(generationRequests(fixture).length, 0);
        });
    }
});

test('only an unsupported catalog API enables legacy defaults and explicit legacy models stay explicit', async context => {
    for (const explicit of [undefined, 'MODEL_PLACEHOLDER_M132']) {
        await context.test(explicit ?? 'legacy defaults', async subcontext => {
            const fixture = await endpointFixture(subcontext, (operation, _incoming, outgoing) => {
                if (operation.method === 'GetUserStatus') json(outgoing, { code: 'unimplemented', message: 'unknown method' }, 501);
                else if (operation.body.model === 'MODEL_PLACEHOLDER_M132') json(outgoing, { code: 'unknown', message: 'unknown model key: model not found' }, 500);
                else json(outgoing, { response: 'legacy result' });
            });
            const result = await clientFor({ ...fixture.endpoint, transport: 'legacy-ls' }).callAntigravity(request({ model: explicit }));
            assert.equal(result.transport, 'legacy-ls');
            assert.equal(result.outcome, explicit ? 'unsupported' : 'success');
            assert.deepEqual(generationRequests(fixture).map(operation => operation.body.model),
                explicit ? ['MODEL_PLACEHOLDER_M132'] : ['MODEL_PLACEHOLDER_M132', 'MODEL_PLACEHOLDER_M20']);
        });
    }
});

test('auth, quota and forbidden catalogs stop before generation or another endpoint', async context => {
    for (const [status, code, message, outcome] of [
        [401, 'unauthenticated', 'login required', 'auth-required'],
        [403, 'permission_denied', 'quota exhausted', 'quota-exhausted'],
        [403, 'permission_denied', 'forbidden', 'rejected'],
        [403, 'unimplemented', 'forbidden', 'rejected'],
    ]) {
        await context.test(outcome, async subcontext => {
            const fixture = await endpointFixture(subcontext, (_operation, _incoming, outgoing) => json(outgoing, { code, message }, status));
            const client = clientFor(null, { discover: async () => [fixture.endpoint, { ...fixture.endpoint, identity: 'other' }] });
            const result = await client.callAntigravity(request());
            assert.equal(result.outcome, outcome);
            assert.equal(result.submitted, false);
            assert.equal(result.safeToFallback, false);
            assert.equal(fixture.requests.length, 1);
            assert.equal(generationRequests(fixture).length, 0);
        });
    }
});

test('disabled, exhausted and missing explicit models never generate or substitute a model', async context => {
    for (const failure of ['disabled', 'quota', 'missing']) {
        await context.test(failure, async subcontext => {
            const fixture = await endpointFixture(subcontext, (_operation, _incoming, outgoing) => json(outgoing,
                catalog('fixture', models => {
                    const opus = models.find(item => item.modelOrAlias.model === 'MODEL_PLACEHOLDER_M402');
                    if (failure === 'disabled') opus.disabled = true;
                    if (failure === 'quota') opus.quotaInfo.remainingFraction = 0;
                })));
            const result = await clientFor(fixture.endpoint).callAntigravity(request({ model: failure === 'missing' ? 'M999' : 'M402' }));
            assert.equal(result.outcome, failure === 'quota' ? 'quota-exhausted' : 'rejected');
            assert.equal(result.submitted, false);
            assert.equal(result.safeToFallback, false);
            assert.equal(generationRequests(fixture).length, 0);
        });
    }
});

test('modern model404 is explicit unsupported and does not trigger a second model or CLI', async context => {
    const fixture = await endpointFixture(context, (operation, _incoming, outgoing) => operation.method === 'GetUserStatus'
        ? json(outgoing, catalog()) : json(outgoing, { code: 'not_found', message: 'model not found' }, 404));
    const result = await clientFor(fixture.endpoint).callAntigravity(request());
    assert.equal(result.outcome, 'unsupported');
    assert.equal(result.submitted, true);
    assert.equal(result.safeToFallback, true);
    assert.equal(generationRequests(fixture).length, 1);
});

test('complete capacity rejection alone permits default Flash Medium and Low once within the original deadline', async context => {
    const deadline = performance.now() + 2000;
    const fixture = await endpointFixture(context, (operation, _incoming, outgoing) => {
        if (operation.method === 'GetUserStatus') json(outgoing, catalog());
        else if (operation.body.model === 'MODEL_PLACEHOLDER_M320') json(outgoing, { response: 'low capacity fallback' });
        else json(outgoing, { code: 'unavailable', message: `No capacity available for ${operation.body.model}` }, 503);
    });
    const client = clientFor(fixture.endpoint, {
        generate: async (received, endpoint, model) => {
            assert.equal(received.deadline, deadline);
            return callAntigravityModel(received, endpoint, model);
        },
    });
    const result = await client.callAntigravity(request({ deadline }));
    assert.equal(result.outcome, 'success');
    assert.equal(result.model, 'MODEL_PLACEHOLDER_M320');
    assert.equal(result.text, 'low capacity fallback');
    assert.deepEqual(generationRequests(fixture).map(operation => operation.body.model),
        [defaultModel, 'MODEL_PLACEHOLDER_M319', 'MODEL_PLACEHOLDER_M320']);
});

test('explicit M318 capacity rejection preserves submitted and never substitutes M319', async context => {
    const fixture = await endpointFixture(context, (operation, _incoming, outgoing) => operation.method === 'GetUserStatus'
        ? json(outgoing, catalog()) : json(outgoing, { code: 'unavailable', message: 'No capacity available for gemini-3.8-flash-high' }, 503));
    const result = await clientFor(fixture.endpoint).callAntigravity(request({ model: 'M318' }));
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.model, defaultModel);
    assert.equal(result.submitted, true);
    assert.equal(result.safeToFallback, true);
    assert.equal(generationRequests(fixture).length, 1);
});

test('a transient capacity rejection never disables or skips M318 in the next request', async context => {
    let rejected = false;
    const fixture = await endpointFixture(context, (operation, _incoming, outgoing) => {
        if (operation.method === 'GetUserStatus') json(outgoing, catalog());
        else if (operation.body.model === defaultModel && !rejected) {
            rejected = true;
            json(outgoing, { code: 'unavailable', message: 'No capacity available for gemini-3.8-flash-high' }, 503);
        } else json(outgoing, { response: 'capacity recovered' });
    });
    const client = clientFor(fixture.endpoint);
    assert.equal((await client.callAntigravity(request())).model, 'MODEL_PLACEHOLDER_M319');
    assert.equal((await client.callAntigravity(request())).model, defaultModel);
    assert.deepEqual(generationRequests(fixture).map(operation => operation.body.model),
        [defaultModel, 'MODEL_PLACEHOLDER_M319', defaultModel]);
});

test('capacity fallback only uses models present and enabled in the current catalog', async context => {
    const fixture = await endpointFixture(context, (operation, _incoming, outgoing) => {
        if (operation.method === 'GetUserStatus') json(outgoing, catalog('fixture', models => {
            models.find(item => item.modelOrAlias.model === 'MODEL_PLACEHOLDER_M319').disabled = true;
        }));
        else if (operation.body.model === defaultModel) json(outgoing, { code: 'unavailable', message: 'No capacity available for gemini-3.8-flash-high' }, 503);
        else json(outgoing, { response: 'enabled low' });
    });
    const result = await clientFor(fixture.endpoint).callAntigravity(request());
    assert.equal(result.model, 'MODEL_PLACEHOLDER_M320');
    assert.deepEqual(generationRequests(fixture).map(operation => operation.body.model), [defaultModel, 'MODEL_PLACEHOLDER_M320']);
});

test('capacity fallback skips a known zero-quota Medium without blocking an available Low', async context => {
    const fixture = await endpointFixture(context, (operation, _incoming, outgoing) => {
        if (operation.method === 'GetUserStatus') json(outgoing, catalog('fixture', models => {
            models.find(item => item.modelOrAlias.model === 'MODEL_PLACEHOLDER_M319').quotaInfo.remainingFraction = 0;
        }));
        else if (operation.body.model === defaultModel) json(outgoing, { code: 'unavailable', message: 'No capacity available for gemini-3.8-flash-high' }, 503);
        else json(outgoing, { response: 'available Low' });
    });
    const result = await clientFor(fixture.endpoint).callAntigravity(request());
    assert.equal(result.outcome, 'success');
    assert.equal(result.model, 'MODEL_PLACEHOLDER_M320');
    assert.deepEqual(generationRequests(fixture).map(operation => operation.body.model), [defaultModel, 'MODEL_PLACEHOLDER_M320']);
});

test('auth, 403, 429, generic503 and reset during capacity fallback stop before Low', async context => {
    const failures = [
        [401, 'unauthenticated', 'login required', 'auth-required'],
        [403, 'permission_denied', 'quota exhausted', 'quota-exhausted'],
        [403, 'permission_denied', 'forbidden', 'rejected'],
        [429, 'resource_exhausted', 'rate limit', 'quota-exhausted'],
        [503, 'unavailable', 'generic service unavailable', 'transport-unknown'],
        [0, '', '', 'transport-unknown'],
    ];
    for (const [status, code, message, outcome] of failures) {
        await context.test(`${status} ${outcome}`, async subcontext => {
            const fixture = await endpointFixture(subcontext, (operation, incoming, outgoing) => {
                if (operation.method === 'GetUserStatus') json(outgoing, catalog());
                else if (operation.body.model === defaultModel) json(outgoing, { code: 'unavailable', message: 'No capacity available for gemini-3.8-flash-high' }, 503);
                else if (!status) incoming.socket.destroy();
                else json(outgoing, { code, message }, status);
            });
            const result = await clientFor(fixture.endpoint).callAntigravity(request());
            assert.equal(result.outcome, outcome);
            assert.equal(result.submitted, true);
            assert.equal(result.safeToFallback, false);
            assert.deepEqual(generationRequests(fixture).map(operation => operation.body.model), [defaultModel, 'MODEL_PLACEHOLDER_M319']);
        });
    }
});

test('generation reset, cancellation and timeout cannot fall through to CLI or another model', async context => {
    for (const mode of ['reset', 'cancel', 'timeout']) {
        await context.test(mode, async subcontext => {
            const controller = new AbortController();
            const fixture = await endpointFixture(subcontext, (operation, incoming, outgoing) => {
                if (operation.method === 'GetUserStatus') json(outgoing, catalog());
                else if (mode === 'reset') incoming.socket.destroy();
                else if (mode === 'cancel') controller.abort();
            });
            const startedAt = performance.now();
            const result = await clientFor(fixture.endpoint).callAntigravity(request({ deadline: startedAt + 150, signal: controller.signal }));
            assert.equal(result.outcome, mode === 'reset' ? 'transport-unknown' : mode === 'cancel' ? 'cancelled' : 'timeout-unknown');
            assert.equal(result.submitted, true);
            assert.equal(result.safeToFallback, false);
            assert.equal(generationRequests(fixture).length, 1);
            assert.ok(performance.now() - startedAt < 1000);
        });
    }
});

test('catalog latency consumes the same deadline used by generation', async context => {
    const fixture = await endpointFixture(context, (operation, _incoming, outgoing) => {
        if (operation.method === 'GetUserStatus') setTimeout(() => json(outgoing, catalog()), 80);
    });
    const startedAt = performance.now();
    const result = await clientFor(fixture.endpoint).callAntigravity(request({ deadline: startedAt + 160 }));
    assert.equal(result.outcome, 'timeout-unknown');
    assert.equal(result.submitted, true);
    assert.equal(generationRequests(fixture).length, 1);
    assert.ok(performance.now() - startedAt < 500);
});

test('expired or cancelled facade request does not discover or start CLI', async () => {
    const client = clientFor(null, { discover: async () => assert.fail('discovery must not start') });
    assert.equal((await client.callAntigravity(request({ deadline: performance.now() - 1 }))).outcome, 'not-started');
    const controller = new AbortController();
    controller.abort();
    assert.equal((await client.callAntigravity(request({ signal: controller.signal }))).outcome, 'cancelled');
});

test('cancellation after catalog prevents generation and image-agent errors preserve unknown state', async () => {
    const controller = new AbortController();
    const endpoint = { host: '127.0.0.1', port: 12345, pid: 123, identity: 'fixture', transport: 'app-ls' };
    const client = clientFor(endpoint, {
        rpc: async () => { controller.abort(); return { status: 200, data: catalog(), submitted: false }; },
        generate: async () => assert.fail('cancelled request must not generate'),
        cliAgent: async () => { throw new Error('unexpected fixture failure'); },
    });
    assert.equal((await client.callAntigravity(request({ signal: controller.signal }))).outcome, 'cancelled');
    const failed = await client.callAntigravity(request({ imagePaths: ['fixture.png'] }));
    assert.equal(failed.outcome, 'transport-unknown');
    assert.equal(failed.submitted, true);
    assert.equal(failed.safeToFallback, false);
});

test('proven pre-dispatch App failure can use one CLI endpoint', async () => {
    const endpoint = { host: '127.0.0.1', port: 12345, pid: 123, identity: 'fixture', transport: 'app-ls' };
    let starts = 0;
    const client = clientFor(endpoint, {
        rpc: async () => { const { AntigravityRpcError } = await import('../src/antigravity-rpc.ts'); throw new AntigravityRpcError('offline', 'not-started', false, true); },
        cliEndpoint: async () => { starts += 1; return antigravityFailure('not-started', 'fixture CLI missing', 'cli-ls'); },
    });
    assert.equal((await client.callAntigravity(request())).outcome, 'not-started');
    assert.equal(starts, 1);
});

function modernProcess(overrides = {}) {
    const executable = 'C:\\Programs\\antigravity\\resources\\bin\\language_server.exe';
    return { pid: 1234, executable, startedAt: Date.now() - 10000,
        commandLine: `"${executable}" --override_ide_name antigravity --subclient_type hub`,
        listeners: [{ address: '127.0.0.1', port: 50001 }], ...overrides };
}

function hub(overrides = {}) {
    return { pid: 1234, httpPort: 50001, httpsPort: 50000, csrfToken: 'fixture-token', lsVersion: '2.31.0', ...overrides };
}

function directoryFixture(context) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'web-fetcher-antigravity-ls-'));
    context.after(() => {
        assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('web-fetcher-antigravity-ls-'));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return directory;
}

test('hub validation binds PID, executable, launch identity, file identity and owned loopback port', () => {
    const processInfo = modernProcess();
    const valid = validateAntigravityHub(hub(), 'hub_50001.json', Date.now(), processInfo);
    assert.equal(valid.port, 50001);
    assert.equal(valid.pid, 1234);
    assert.equal(valid.transport, 'app-ls');
    assert.ok(!valid.identity.includes('fixture-token'));
    const cases = [
        [hub({ pid: 1235 }), processInfo, 'hub_50001.json', Date.now()],
        [hub(), { ...processInfo, executable: 'C:\\Other\\language_server.exe' }, 'hub_50001.json', Date.now()],
        [hub(), { ...processInfo, commandLine: processInfo.commandLine.replace('subclient_type hub', 'subclient_type cli') }, 'hub_50001.json', Date.now()],
        [hub(), { ...processInfo, commandLine: processInfo.commandLine.replace('override_ide_name antigravity', 'override_ide_name devin') }, 'hub_50001.json', Date.now()],
        [hub(), { ...processInfo, listeners: [{ address: '0.0.0.0', port: 50001 }] }, 'hub_50001.json', Date.now()],
        [hub(), { ...processInfo, listeners: [{ address: '127.0.0.1', port: 50002 }] }, 'hub_50001.json', Date.now()],
        [hub(), processInfo, 'hub_50002.json', Date.now()],
        [hub(), processInfo, 'hub_50001.json', processInfo.startedAt - 5000],
        [hub({ csrfToken: 'bad\r\nheader' }), processInfo, 'hub_50001.json', Date.now()],
        [hub({ httpPort: '50001' }), processInfo, 'hub_50001.json', Date.now()],
    ];
    for (const [record, snapshot, filename, modifiedAt] of cases) assert.equal(validateAntigravityHub(record, filename, modifiedAt, snapshot), null);
    const restarted = { ...processInfo, startedAt: processInfo.startedAt + 5000 };
    assert.notEqual(validateAntigravityHub(hub(), 'hub_50001.json', Date.now(), restarted).identity, valid.identity);
    const https = validateAntigravityHub(hub(), 'hub_50001.json', Date.now(),
        { ...processInfo, listeners: [{ address: '127.0.0.1', port: 50000 }] });
    assert.equal(https.port, 50000);
    assert.equal(https.useHttps, true);
});

test('discovery reads real hub-shaped fixtures and rejects malformed or stale logs', async context => {
    const directory = directoryFixture(context);
    fs.writeFileSync(path.join(directory, 'hub_50001.json'), JSON.stringify(hub()));
    fs.writeFileSync(path.join(directory, 'hub_50002.json'), 'invalid json');
    fs.writeFileSync(path.join(directory, 'backend.log'), 'Listening on http://127.0.0.1:59999');
    fs.writeFileSync(path.join(directory, 'hub_59999.json'), JSON.stringify(hub({ pid: 9999, httpPort: 59999 })));
    const endpoints = await discoverAntigravityEndpoints(request(), { daemonDirectory: directory,
        inspectProcesses: async () => [modernProcess()] });
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0].port, 50001);
    fs.writeFileSync(path.join(directory, 'hub_50001.json'), 'x'.repeat(32769));
    assert.deepEqual(await discoverAntigravityEndpoints(request(), { daemonDirectory: directory,
        inspectProcesses: async () => [modernProcess()] }), []);
    assert.deepEqual(await discoverAntigravityEndpoints(request(), { daemonDirectory: directory,
        inspectProcesses: async () => [] }), []);
});

test('legacy process commandline discovery keeps quoted CSRF and excludes extension and public listeners', async context => {
    const directory = directoryFixture(context);
    const executable = 'C:\\Programs\\antigravity\\resources\\app\\extensions\\antigravity\\bin\\language_server_windows_x64.exe';
    const processInfo = { ...modernProcess(), executable,
        commandLine: `"${executable}" --csrf_token "legacy-secret" --extension_server_port 50002 --http_port 50001`,
        listeners: [{ address: '127.0.0.1', port: 50001 }, { address: '127.0.0.1', port: 50002 }, { address: '0.0.0.0', port: 50003 }] };
    const endpoints = await discoverAntigravityEndpoints(request(), { daemonDirectory: directory, inspectProcesses: async () => [processInfo] });
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0].port, 50001);
    assert.equal(endpoints[0].csrfToken, 'legacy-secret');
    assert.equal(endpoints[0].transport, 'legacy-ls');
    assert.deepEqual(getLsModelCandidates('MODEL_PLACEHOLDER_M132'), [
        'MODEL_PLACEHOLDER_M132', 'MODEL_PLACEHOLDER_M20', 'MODEL_PLACEHOLDER_M18', 'MODEL_PLACEHOLDER_M16', 'MODEL_PLACEHOLDER_M36',
    ]);
});

test('discovery cancellation is checked before process inspection and after it completes', async context => {
    const directory = directoryFixture(context);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(discoverAntigravityEndpoints(request({ signal: controller.signal }), { daemonDirectory: directory,
        inspectProcesses: async () => assert.fail('inspection must not run') }), error => error.outcome === 'cancelled');
    const afterInspection = new AbortController();
    await assert.rejects(discoverAntigravityEndpoints(request({ signal: afterInspection.signal }), { daemonDirectory: directory,
        inspectProcesses: async () => { afterInspection.abort(); return [modernProcess()]; } }), error => error.outcome === 'cancelled');
});

test('Windows inspection passes an integer timeout to its asynchronous process runner',
    { skip: process.platform !== 'win32' }, async context => {
        let ticks = 0;
        const interval = setInterval(() => ticks += 1, 5);
        const startedAt = performance.now();
        try {
            const records = await inspectAntigravityLsProcesses(request({ deadline: performance.now() + 5000.5 }),
                (_command, _args, options, callback) => {
                    assert.ok(Number.isInteger(options.timeout));
                    assert.ok(options.timeout > 0 && options.timeout <= 5001);
                    setTimeout(() => callback(null, '[]', ''), 15);
                });
            assert.ok(Array.isArray(records));
            assert.ok(ticks > 0);
            context.diagnostic(`mock processCount=${records.length}; eventLoopTicks=${ticks}; elapsedMs=${Math.round(performance.now() - startedAt)}`);
        } finally {
            clearInterval(interval);
        }
    });
