import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getAntigravityCapacityCandidates,
    getAntigravityModelCandidates,
    legacyAntigravityCatalog,
    parseAntigravityAgentCatalog,
    parseAntigravityCatalog,
    selectAntigravityModel,
} from '../src/antigravity-models.ts';
import { createAntigravityClient } from '../src/ls-client.ts';

const entries = [
    ['Gemini 4 Argon (High)', 'gemini-4-argon-high', 'M801'],
    ['Gemini 3.8 Flash (High)', 'gemini-3.8-flash-high', 'M802'],
    ['Gemini 4 Carbon (High)', 'gemini-4-carbon-high', 'M903'],
    ['Gemini 4 Hydrogen (High)', 'gemini-4-hydrogen-high', 'M902'],
    ['Gemini 4 Hydrogen (XHigh)', 'gemini-4-hydrogen-xhigh', 'M901'],
    ['Gemini 4 Hydrogen (Low)', 'gemini-4-hydrogen-low', 'M804'],
    ['Gemini 4 Carbon (Medium)', 'gemini-4-carbon-medium', 'M805'],
];

function status(configure = () => {}) {
    const models = entries.map(([label, modelId, model]) => ({
        label, modelId, modelOrAlias: { model: `MODEL_PLACEHOLDER_${model}` },
        disabled: false, supportsImages: true, quotaInfo: { remainingFraction: 0.8 },
    }));
    configure(models);
    return { userStatus: { clientModelConfigs: models } };
}

function preserveEnv(context, value) {
    const previous = process.env.WEB_FETCHER_LS_MODEL;
    if (value === undefined) delete process.env.WEB_FETCHER_LS_MODEL;
    else process.env.WEB_FETCHER_LS_MODEL = value;
    context.after(() => {
        if (previous === undefined) delete process.env.WEB_FETCHER_LS_MODEL;
        else process.env.WEB_FETCHER_LS_MODEL = previous;
    });
}

function harness(context, { configure, generate, rpc, discover, cliAgent, cliEndpoint } = {}) {
    preserveEnv(context, undefined);
    const attempts = [];
    const endpoint = { host: '127.0.0.1', port: 1, pid: process.pid, identity: 'policy-fixture', transport: 'app-ls' };
    const client = createAntigravityClient({
        discover: discover ?? (async () => [endpoint]),
        rpc: rpc ?? (async () => ({ status: 200, data: status(configure) })),
        generate: async (request, _endpoint, model) => {
            attempts.push({ model, request });
            return generate ? generate(request, model, attempts.length) : {
                text: 'local fixture', transport: 'app-ls', model, outcome: 'success', submitted: true, safeToFallback: false,
            };
        },
        cliInstalled: () => false,
        cliAgent: cliAgent ?? (async () => assert.fail('No CLI agent may start')),
        cliEndpoint: cliEndpoint ?? (async () => assert.fail('No CLI endpoint may start')),
    });
    return { attempts, call: overrides => client.callAntigravity({ prompt: 'local fixture', deadline: performance.now() + 5000, ...overrides }) };
}

function capacity(model, overrides = {}) {
    return { text: null, transport: 'app-ls', model, outcome: 'rejected', submitted: true,
        safeToFallback: true, error: 'No capacity available for fixture', ...overrides };
}

test('one shared helper ranks modern material and visual models without fixed RPC numbers', () => {
    const catalog = parseAntigravityCatalog(status());
    assert.deepEqual(getAntigravityModelCandidates(catalog).map(model => model.id), [
        'MODEL_PLACEHOLDER_M901', 'MODEL_PLACEHOLDER_M902', 'MODEL_PLACEHOLDER_M903',
    ]);
    assert.equal(selectAntigravityModel(catalog).model.id, 'MODEL_PLACEHOLDER_M901');
    assert.deepEqual(getAntigravityModelCandidates(catalog, 'visual-review').map(model => model.id), ['MODEL_PLACEHOLDER_M903']);
    assert.equal(selectAntigravityModel(catalog, undefined, 'visual-review').model.id, 'MODEL_PLACEHOLDER_M903');
    assert.deepEqual(getAntigravityCapacityCandidates(catalog, selectAntigravityModel(catalog).model).map(model => model.id), [
        'MODEL_PLACEHOLDER_M901', 'MODEL_PLACEHOLDER_M902', 'MODEL_PLACEHOLDER_M903',
    ]);
});

test('ACP adapters can use actual CLI slug IDs and the identical policy helper', () => {
    const availableModels = entries.map(([name, modelId]) => ({ name, modelId, disabled: false, supportsImages: true }));
    const catalog = parseAntigravityAgentCatalog(availableModels);
    assert.equal(selectAntigravityModel(catalog).model.id, 'gemini-4-hydrogen-xhigh');
    assert.equal(selectAntigravityModel(catalog, undefined, 'visual-review').model.id, 'gemini-4-carbon-high');
    assert.equal(selectAntigravityModel(catalog, 'hydrogen-high').model.id, 'gemini-4-hydrogen-high');
    assert.equal(selectAntigravityModel(catalog, 'Gemini 4 Hydrogen (High)').model.id, 'gemini-4-hydrogen-high');
    assert.equal(catalog.models.find(model => model.id === 'gemini-4-hydrogen-high').modelId, 'gemini-4-hydrogen-high');
});

test('ACP adaptation preserves stricter duplicate admission, zero quota, image evidence and safe fields only', () => {
    const catalog = parseAntigravityAgentCatalog([
        { name: 'Gemini 4 Hydrogen (XHigh)', modelId: 'h-xhigh', disabled: false, supportsImages: true, quotaInfo: { remainingFraction: 0.8 }, token: 'fixture-only' },
        { name: 'Gemini 4 Hydrogen (XHigh)', modelId: 'h-xhigh', disabled: true, supportsImages: false, quotaInfo: { remainingFraction: 0 } },
        { name: 'Gemini 4 Hydrogen (High)', modelId: 'h-high', supportsImages: true, quotaInfo: { remainingFraction: 0.5 } },
        { name: 'Gemini 4 Carbon (High)', modelId: 'carbon', available: false },
    ]);
    assert.equal(catalog.models.length, 3);
    assert.equal(catalog.models[0].disabled, true);
    assert.equal(catalog.models[0].quotaRemaining, 0);
    assert.equal(catalog.models[0].supportsImages, false);
    assert.equal(catalog.models[2].disabled, true);
    assert.equal(selectAntigravityModel(catalog).model.id, 'h-high');
    assert.ok(!JSON.stringify(catalog).includes('fixture-only'));
});

test('ACP malformed and empty directories never invent RPC IDs or legacy models', () => {
    for (const available of [undefined, {}, [], [null, {}, { name: 'Gemini 4 Carbon (High)' }]]) {
        const catalog = parseAntigravityAgentCatalog(available);
        assert.deepEqual(catalog.models, []);
        assert.equal(selectAntigravityModel(catalog).error.outcome, 'invalid-response');
    }
});

test('slugs, labels, RPC enums and high-grade aliases resolve precisely', () => {
    const catalog = parseAntigravityCatalog(status());
    for (const explicit of ['M901', 'MODEL_PLACEHOLDER_M901', 'gemini-4-hydrogen-xhigh', 'Gemini 4 Hydrogen (XHigh)', 'hydrogen', 'hydrogen-xhigh']) {
        assert.equal(selectAntigravityModel(catalog, explicit).model.id, 'MODEL_PLACEHOLDER_M901');
    }
    for (const explicit of ['carbon', 'carbon-high', 'gemini-4-carbon-high']) {
        assert.equal(selectAntigravityModel(catalog, explicit).model.id, 'MODEL_PLACEHOLDER_M903');
    }
    for (const explicit of ['Gemini 4 Hydrogen', 'gemini-4-hydrogen', 'Gemini 4 Hydrogen (XHigh) trailing', 'gemini-9-hydrogen-xhigh']) {
        assert.equal(selectAntigravityModel(catalog, explicit).error.outcome, 'rejected');
    }
});

test('missing exact XHigh never substitutes High, while the family alias can resolve High', () => {
    const catalog = parseAntigravityCatalog(status(models => models.splice(4, 1)));
    assert.equal(selectAntigravityModel(catalog, 'hydrogen-xhigh').error.outcome, 'rejected');
    assert.equal(selectAntigravityModel(catalog, 'hydrogen').model.id, 'MODEL_PLACEHOLDER_M902');
});

test('duplicate labels and slugs reject ambiguous explicit selections', () => {
    const raw = status(models => models.push({ ...models[4], modelOrAlias: { model: 'MODEL_PLACEHOLDER_M999' } }));
    for (const explicit of ['hydrogen-xhigh', 'gemini-4-hydrogen-xhigh', 'Gemini 4 Hydrogen (XHigh)']) {
        assert.equal(selectAntigravityModel(parseAntigravityCatalog(raw), explicit).error.outcome, 'invalid-response');
    }
});

test('limited-time labels retain exact grade matching and no fuzzy family substitution', () => {
    const catalog = parseAntigravityCatalog(status(models => { models[4].label += ' (Limited Time)'; }));
    assert.equal(selectAntigravityModel(catalog).model.id, 'MODEL_PLACEHOLDER_M901');
    assert.equal(selectAntigravityModel(catalog, 'gemini-4-hydrogen-xhigh').model.id, 'MODEL_PLACEHOLDER_M901');
});

test('modern defaults refuse excluded families and low effort, while legacy defaults remain unchanged', () => {
    const catalog = parseAntigravityCatalog(status(models => models.splice(2, 3)));
    assert.equal(selectAntigravityModel(catalog).error.outcome, 'rejected');
    const legacy = legacyAntigravityCatalog();
    assert.equal(selectAntigravityModel(legacy).model.id, 'MODEL_PLACEHOLDER_M132');
    assert.deepEqual(getAntigravityModelCandidates(legacy), legacy.models);
});

test('disabled candidates are skipped before generation and a selected zero quota stops', () => {
    const disabled = parseAntigravityCatalog(status(models => { models[4].disabled = true; }));
    assert.equal(selectAntigravityModel(disabled).model.id, 'MODEL_PLACEHOLDER_M902');
    const exhausted = parseAntigravityCatalog(status(models => { models[4].quotaInfo.remainingFraction = 0; }));
    assert.equal(selectAntigravityModel(exhausted).error.outcome, 'quota-exhausted');
});

test('only safe pure capacity rejection walks Hydrogen XHigh, High, then Carbon High once', async context => {
    const fixture = harness(context, { generate: async (_request, model, attempt) => attempt < 3 ? capacity(model) : {
        text: 'third candidate', transport: 'app-ls', model, outcome: 'success', submitted: true, safeToFallback: false,
    } });
    assert.equal((await fixture.call()).text, 'third candidate');
    assert.deepEqual(fixture.attempts.map(attempt => attempt.model), ['MODEL_PLACEHOLDER_M901', 'MODEL_PLACEHOLDER_M902', 'MODEL_PLACEHOLDER_M903']);
    assert.ok(fixture.attempts.every(attempt => attempt.request.deadline === fixture.attempts[0].request.deadline));
});

for (const overrides of [
    { safeToFallback: false }, { safeToFallback: undefined }, { safeToFallback: 'true' },
    { outcome: 'transport-unknown' }, { outcome: 'timeout-unknown' }, { outcome: 'quota-exhausted' },
    { outcome: 'auth-required' }, { error: 'generic unavailable 503' },
    { text: 'partial provider output' },
    { cleanup: { confirmed: false } },
    { cleanup: { confirmed: true, fault: { outcome: 'invalid-response', error: 'cleanup protocol fault' } } },
]) {
    test(`unsafe rejection stops candidate changes: ${JSON.stringify(overrides)}`, async context => {
        const fixture = harness(context, { generate: async (_request, model) => capacity(model, overrides) });
        await fixture.call();
        assert.equal(fixture.attempts.length, 1);
    });
}

for (const model of ['M902', 'gemini-4-hydrogen-high', 'Gemini 4 Hydrogen (High)']) {
    test(`request model freezes capacity selection: ${model}`, async context => {
        const fixture = harness(context, { generate: async (_request, selected) => capacity(selected) });
        const result = await fixture.call({ model });
        assert.equal(result.model, 'MODEL_PLACEHOLDER_M902');
        assert.equal(fixture.attempts.length, 1);
    });
}

test('environment model is snapshotted before discovery and freezes capacity selection', async context => {
    const fixture = harness(context, { rpc: async () => {
        process.env.WEB_FETCHER_LS_MODEL = 'gemini-4-carbon-high';
        return { status: 200, data: status() };
    }, generate: async (_request, model) => capacity(model) });
    process.env.WEB_FETCHER_LS_MODEL = 'gemini-4-hydrogen-high';
    await fixture.call();
    assert.deepEqual(fixture.attempts.map(attempt => attempt.model), ['MODEL_PLACEHOLDER_M902']);
    assert.equal(fixture.attempts[0].request.model, 'gemini-4-hydrogen-high');
});

test('a newly configured environment model cannot change an already started automatic request', async context => {
    const fixture = harness(context, { rpc: async () => {
        process.env.WEB_FETCHER_LS_MODEL = 'gemini-4-carbon-high';
        return { status: 200, data: status() };
    } });
    await fixture.call();
    assert.equal(fixture.attempts[0].model, 'MODEL_PLACEHOLDER_M901');
    assert.equal(fixture.attempts[0].request.model, undefined);
});

for (const extra of [{ imagePaths: ['fixture-image.png'] }, { schema: { type: 'object' } }]) {
    test(`environment model reaches the ACP branch: ${JSON.stringify(extra)}`, async context => {
        let received;
        const fixture = harness(context, { discover: async () => [], cliAgent: async request => {
            received = request;
            return { text: 'fixture', transport: 'cli-agent', model: request.model, outcome: 'success', submitted: true, safeToFallback: false };
        } });
        process.env.WEB_FETCHER_LS_MODEL = 'gemini-4-carbon-high';
        await fixture.call(extra);
        assert.equal(received.model, 'gemini-4-carbon-high');
        assert.equal(fixture.attempts.length, 0);
    });
}

test('request model wins over environment and an empty environment model is rejected before discovery', async context => {
    const fixture = harness(context);
    process.env.WEB_FETCHER_LS_MODEL = 'gemini-4-carbon-high';
    await fixture.call({ model: 'M902' });
    assert.equal(fixture.attempts[0].model, 'MODEL_PLACEHOLDER_M902');
    process.env.WEB_FETCHER_LS_MODEL = '';
    const result = await fixture.call();
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.submitted, false);
    assert.equal(fixture.attempts.length, 1);
});

test('visual requests select Carbon High and do not capacity-fallback into Hydrogen', async context => {
    const fixture = harness(context, { generate: async (_request, model) => capacity(model) });
    await fixture.call({ purpose: 'visual-review' });
    assert.deepEqual(fixture.attempts.map(attempt => attempt.model), ['MODEL_PLACEHOLDER_M903']);
});

test('capacity fallback skips known zero-quota alternatives without changing the selected model rule', async context => {
    const fixture = harness(context, { configure: models => { models[3].quotaInfo.remainingFraction = 0; },
        generate: async (_request, model) => capacity(model) });
    await fixture.call();
    assert.deepEqual(fixture.attempts.map(attempt => attempt.model), ['MODEL_PLACEHOLDER_M901', 'MODEL_PLACEHOLDER_M903']);
});

test('App RPC execution budget starts at the RPC phase and all capacity candidates share it', async context => {
    const observed = [];
    const parentDeadline = performance.now() + 5000;
    const startedAt = performance.now();
    const fixture = harness(context, { rpc: async (_endpoint, _method, _body, request) => {
        observed.push(request);
        return { status: 200, data: status() };
    }, generate: async (request, model) => {
        observed.push(request);
        return capacity(model);
    } });
    await fixture.call({ deadline: parentDeadline, generationTimeoutMs: 60000 });
    assert.ok(observed.every(request => request.deadline === parentDeadline));
    observed.length = 0;
    await fixture.call({ deadline: parentDeadline, generationTimeoutMs: 1000 });
    assert.equal(observed.length, 4);
    assert.ok(observed[0].deadline >= startedAt + 1000);
    assert.ok(observed[0].deadline < parentDeadline);
    assert.ok(observed.every(request => request.deadline === observed[0].deadline));
});

test('App catalog latency consumes the execution budget and prevents a late generation', async context => {
    const fixture = harness(context, { rpc: async () => {
        await new Promise(resolve => setTimeout(resolve, 45));
        return { status: 200, data: status() };
    } });
    const result = await fixture.call({ generationTimeoutMs: 20 });
    assert.equal(result.outcome, 'not-started');
    assert.equal(result.submitted, false);
    assert.equal(fixture.attempts.length, 0);
});

test('queued CLI and image handoffs retain the parent deadline and the separate execution budget', async context => {
    const observed = [];
    const parentDeadline = performance.now() + 5000;
    const fixture = harness(context, { discover: async () => [],
        cliEndpoint: async request => {
            observed.push(request);
            return capacity(null, { outcome: 'not-started', submitted: false, safeToFallback: false });
        },
        cliAgent: async request => {
            observed.push(request);
            return capacity(null, { outcome: 'not-started', submitted: false, safeToFallback: false });
        } });
    await fixture.call({ deadline: parentDeadline, generationTimeoutMs: 1000 });
    await fixture.call({ deadline: parentDeadline, generationTimeoutMs: 1000, imagePaths: ['fixture.png'] });
    assert.equal(observed.length, 2);
    assert.ok(observed.every(request => request.deadline === parentDeadline && request.generationTimeoutMs === 1000));
});

test('the parent signal still stops App generation after catalog work', async context => {
    const controller = new AbortController();
    const fixture = harness(context, { rpc: async () => {
        controller.abort();
        return { status: 200, data: status() };
    } });
    const result = await fixture.call({ generationTimeoutMs: 1000, signal: controller.signal });
    assert.equal(result.outcome, 'cancelled');
    assert.equal(fixture.attempts.length, 0);
});

for (const generationTimeoutMs of [0, -1, Infinity, NaN, '1000']) {
    test(`invalid execution budget is rejected before discovery: ${generationTimeoutMs}`, async context => {
        const fixture = harness(context, { discover: async () => assert.fail('Invalid input must not reach discovery') });
        const result = await fixture.call({ generationTimeoutMs });
        assert.equal(result.outcome, 'rejected');
        assert.equal(result.submitted, false);
    });
}
