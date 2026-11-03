import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { BudgetLedger, MemoryAccountingPort } from '../../../src/agent-server/accounting/budget-ledger.ts';
import { SqliteStore } from '../../../dist/agent-server/storage/sqlite.js';
import { createSqliteProviderPorts } from '../../../src/agent-server/storage/provider-journal.ts';
import { validateParams } from '../../../src/agent-server/protocol.ts';
import { parseArguments } from '../../../src/agent-cli/arguments.ts';
import { parseCommand, executeCommand } from '../../../src/agent-cli/commands.ts';
import { interactiveResultLines } from '../../../src/agent-cli/ui-results.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentRuntime } from '../../../src/agent-server/runtime.ts';
import { MemoryStore } from '../../../src/agent-server/storage/memory.ts';
import { createContextServerAdapter } from '../../../src/agent-server/context/server-adapter.ts';
import { createProviderServices } from '../../../src/agent-server/providers/services.ts';
import { MemoryProfilePort, newProfile } from '../../../src/agent-server/profiles/profile-store.ts';
import { MemoryCatalogPort } from '../../../src/agent-server/models/catalog.ts';

const now = Date.parse('2026-11-02T23:00:04.665Z');
const observedAt = new Date(now).toISOString();
const expiresAt = new Date(now + 86_400_000).toISOString();
const profile = () => ({ ...newProfile({ profileId: 'progrok-catalog-local', label: 'owned catalog fixture', protocol: 'progrok',
    baseUrl: 'http://127.0.0.1:41998/v1', modelId: 'grok-4.20-0309-non-reasoning' }),
    quotaScopeId: 'progrok-catalog-local-account', quotaLimitId: 'progrok-catalog-local-quota' });
const model = () => ({ id: 'grok-4.20-0309-non-reasoning', context_length: 1_000_000, object: 'model', owned_by: 'xai',
    prompt_text_token_price: 12_500, cached_prompt_text_token_price: 2_000, completion_text_token_price: 25_000,
    prompt_text_token_price_long_context: 25_000, cached_prompt_text_token_price_long_context: 4_000,
    completion_text_token_price_long_context: 50_000, long_context_threshold: 200_000, prompt_image_token_price: 12_500 });
const language = () => {
    const { context_length, ...metadata } = model();
    return { ...metadata, input_modalities: ['text', 'image'], output_modalities: ['text'], fingerprint: 'fixture-fingerprint',
        aliases: ['fixture-alias'], search_price: 0 };
};
const response = json => ({ status: 200, headers: {}, body: JSON.stringify(json) });

const estimatedUpper = amountMicros => ({ currency: 'USD', amountMicros, reliable: false, source: 'estimated',
    sourceRef: 'owned-local-estimate', estimateBasis: { inputTokens: 100, outputTokens: 256,
        outputLimitKind: 'visible_tokens', missingHardBounds: ['billable_output_tokens'] } });

async function ledgerFixture(port = new MemoryAccountingPort(), quotaMode = 'estimated', rootMode = 'estimated', maximum = 100_000) {
    const ledger = new BudgetLedger(port);
    const quotaLimitId = randomUUID();
    const definition = { quotaLimitId, ...(quotaMode ? { amountMode: quotaMode } : {}), currency: 'USD', maxCostMicros: maximum,
        quotaScopeIds: ['owned-estimated-account'], sourceRef: 'owned-local-estimate' };
    await ledger.createQuotaLimit(definition);
    const rootDefinition = { rootBudgetId: randomUUID(), quotaLimitId, mode: rootMode, currency: 'USD', maxCostMicros: maximum,
        maxModelCalls: 4, maxOutputTokens: 256, deadlineAt: new Date(Date.now() + 120_000).toISOString(), sourceRef: 'owned-local-estimate' };
    await ledger.create(rootDefinition);
    const reservation = (rootBudgetId = rootDefinition.rootBudgetId, amount = 100) => ({ rootBudgetId, attemptId: randomUUID(),
        actionId: randomUUID(), quotaScopeId: 'owned-estimated-account', snapshotHash: randomUUID(), upperBound: estimatedUpper(amount) });
    const settle = (attemptId, amount, revision = 1) => ledger.settle({ attemptId, usageRevision: revision, providerExecutionId: 'fixture-' + attemptId,
        complete: true, charges: [{ component: 'model_usage', amountMicros: amount, currency: 'USD', kind: 'provider_reported',
            usage: { cost_in_usd_ticks: String(amount * 10_000) } }] });
    return { ledger, definition, rootDefinition, reservation, settle };
}

test('only explicit estimated root plus estimated new quota permits a finite nonzero estimate (local accounting)', async () => {
    for (const [rootMode, quotaMode] of [['hard', 'hard'], ['estimated', 'hard'], ['hard', 'estimated'], ['estimated', undefined]]) {
        const fixture = await ledgerFixture(new MemoryAccountingPort(), quotaMode ?? null, rootMode);
        await assert.rejects(fixture.ledger.reserve(fixture.reservation()), { code: 'BUDGET_UNBOUNDED' });
        assert.deepEqual((await fixture.ledger.read(fixture.rootDefinition.rootBudgetId)).reservations, []);
    }
    const fixture = await ledgerFixture();
    const request = fixture.reservation();
    await fixture.ledger.reserve(request);
    const view = await fixture.ledger.read(fixture.rootDefinition.rootBudgetId);
    assert.equal(view.quotaLimit.amountMode, 'estimated');
    assert.equal(view.quotaLimit.estimateNotice, 'single_request_cost_may_exceed_estimate');
    assert.equal(view.reservations[0].amountMode, 'estimated');
    assert.equal(view.reservations[0].originalUpperBound.reliable, false);
    assert.equal(view.reservations[0].originalUpperBound.source, 'estimated');
    assert.equal(view.budget.amountUnknown, true);
    assert.equal(view.quotaLimit.unsettledCalls, 0);
    for (const amount of [0, null]) await assert.rejects(fixture.ledger.reserve(fixture.reservation(undefined, amount)), { code: 'BUDGET_UNBOUNDED' });
});

test('old quota defaults and definition hash survive explicit hard replay; existing ID cannot become estimated (local accounting)', async () => {
    const fixture = await ledgerFixture(new MemoryAccountingPort(), null, 'estimated');
    const before = await fixture.ledger.getQuotaLimit(fixture.definition.quotaLimitId);
    const replay = await fixture.ledger.createQuotaLimit({ ...fixture.definition, amountMode: 'hard' });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.quotaLimit, before);
    await assert.rejects(fixture.ledger.createQuotaLimit({ ...fixture.definition, amountMode: 'estimated' }), { code: 'E_GLOBAL_BUDGET_CONFLICT' });
});

test('estimated hold is separate from actual charge; unresolved original cost stops new roots until settlement (local accounting)', async () => {
    const fixture = await ledgerFixture();
    const first = fixture.reservation();
    await fixture.ledger.reserve(first);
    await fixture.ledger.dispatched(first.attemptId);
    await fixture.settle(first.attemptId, 150);
    const known = await fixture.ledger.read(fixture.rootDefinition.rootBudgetId);
    assert.equal(known.budget.spentMicros, 150);
    assert.equal(known.budget.overdrawn, false);
    assert.equal(known.charges[0].kind, 'provider_reported');
    assert.equal(known.reservations[0].originalUpperBound.amountMicros, 100);
    const second = fixture.reservation();
    await fixture.ledger.reserve(second);
    await fixture.ledger.dispatched(second.attemptId);
    await fixture.ledger.unknown(second.attemptId);
    const otherRoot = { ...fixture.rootDefinition, rootBudgetId: randomUUID() };
    await fixture.ledger.create(otherRoot);
    await assert.rejects(fixture.ledger.reserve(fixture.reservation(otherRoot.rootBudgetId)), { code: 'E_GLOBAL_BUDGET_HALTED' });
    const unknown = await fixture.ledger.read(fixture.rootDefinition.rootBudgetId);
    assert.equal(unknown.quotaLimit.unsettledCalls, 1);
    assert.equal(unknown.reservations.find(value => value.attemptId === second.attemptId).heldMicros, 100);
    await fixture.settle(second.attemptId, 200);
    assert.equal((await fixture.ledger.read(fixture.rootDefinition.rootBudgetId)).quotaLimit.unsettledCalls, 0);
    await fixture.ledger.reserve(fixture.reservation(otherRoot.rootBudgetId));
});

test('actual cumulative amount beyond the configured estimate threshold is retained and stops following requests (local accounting)', async () => {
    const fixture = await ledgerFixture(new MemoryAccountingPort(), 'estimated', 'estimated', 100);
    const request = fixture.reservation(undefined, 90);
    await fixture.ledger.reserve(request);
    await fixture.ledger.dispatched(request.attemptId);
    await fixture.settle(request.attemptId, 101);
    const view = await fixture.ledger.read(fixture.rootDefinition.rootBudgetId);
    assert.equal(view.budget.spentMicros, 101);
    assert.equal(view.quotaLimit.spentMicros, 101);
    assert.equal(view.quotaLimit.overdrawn, true);
    await assert.rejects(fixture.ledger.reserve(fixture.reservation(undefined, 1)), { code: 'E_GLOBAL_BUDGET_HALTED' });
});

test('estimated mode, original hold and unresolved global stop survive SQLite cold open (owned local store)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'sandbox-progrok-estimated-'));
    let store;
    try {
        store = await SqliteStore.open({ dataDir });
        const fixture = await ledgerFixture(createSqliteProviderPorts(store).accountingPort);
        const request = fixture.reservation();
        await fixture.ledger.reserve(request);
        await fixture.ledger.dispatched(request.attemptId);
        const other = { ...fixture.rootDefinition, rootBudgetId: randomUUID() };
        await fixture.ledger.create(other);
        const waiting = fixture.reservation(other.rootBudgetId);
        await fixture.ledger.reserve(waiting);
        await fixture.ledger.unknown(request.attemptId);
        await store.close();
        store = await SqliteStore.open({ dataDir });
        const ledger = new BudgetLedger(createSqliteProviderPorts(store).accountingPort);
        const reopened = await ledger.read(fixture.rootDefinition.rootBudgetId);
        assert.equal(reopened.quotaLimit.amountMode, 'estimated');
        assert.equal(reopened.quotaLimit.unsettledCalls, 1);
        assert.equal(reopened.reservations[0].heldMicros, 100);
        assert.deepEqual(reopened.reservations[0].originalUpperBound, estimatedUpper(100));
        assert.equal(reopened.quotaLimit.heldMicros, 200);
        await assert.rejects(ledger.reserve(fixture.reservation(other.rootBudgetId)), { code: 'E_GLOBAL_BUDGET_HALTED' });
        await assert.rejects(ledger.dispatched(waiting.attemptId), { code: 'E_GLOBAL_BUDGET_HALTED' });
        await ledger.settle({ attemptId: request.attemptId, usageRevision: 1, providerExecutionId: 'local-cold-response', complete: true,
            charges: [{ component: 'model_usage', amountMicros: 150, currency: 'USD', kind: 'provider_reported', usage: { fixture: true } }] });
        await ledger.dispatched(waiting.attemptId);
        assert.equal((await ledger.read(other.rootBudgetId)).quotaLimit.unsettledCalls, 0);
    } finally {
        await store?.close();
        assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
        assert.ok(basename(dataDir).startsWith('sandbox-progrok-estimated-'));
        await rm(dataDir, { recursive: true, force: true });
    }
});

test('quota protocol, CLI and readable result preserve explicit opt-in while omitted mode stays hard-compatible (local public command fixture)', async () => {
    const definition = { quotaLimitId: 'local-cli-quota', currency: 'USD', maxCostMicros: 100_000,
        quotaScopeIds: ['local-cli-account'], sourceRef: 'local-cli-selection' };
    assert.equal(validateParams('budgets.configureLimit', { clientCommandId: randomUUID(), definition }).definition.amountMode, undefined);
    assert.equal(validateParams('budgets.configureLimit', { clientCommandId: randomUUID(), definition: { ...definition, amountMode: 'estimated' } }).definition.amountMode, 'estimated');
    let captured;
    const parsed = parseArguments(['budget', 'configure-limit', '--quota-limit-id', definition.quotaLimitId, '--currency', 'USD',
        '--max-cost-micros', '100000', '--quota-scope-ids', '["local-cli-account"]', '--source-ref', definition.sourceRef, '--amount-mode', 'estimated']);
    await executeCommand(parseCommand(parsed), { cwd: process.cwd(), client: { async request(method, params) {
        captured = { method, params };
        return { ok: true, data: { quotaLimit: { ...params.definition } } };
    } } });
    assert.equal(captured.method, 'budgets.configureLimit');
    assert.equal(captured.params.definition.amountMode, 'estimated');
    assert.match(interactiveResultLines({ method: 'budgets.configureLimit', result: { ok: true,
        data: { quotaLimit: { amountMode: 'estimated' } } } })[0], /单次实际费用/);
});

test('ordinary BPC and Provider prepare keep visible 256 separate from unknown model maximum in explicitly estimated mode (local transport fixture)', async () => {
    const store = new MemoryStore();
    let captured;
    let release;
    const held = new Promise(resolveHeld => { release = resolveHeld; });
    const runtime = createAgentRuntime({ store, executor: { capabilities: { hardBudget: true }, async execute(context) {
        captured = context;
        await held;
        return { status: 'succeeded', cleanupState: 'not_needed', effectState: 'none', result: { text: 'local preparation completed' } };
    } } });
    const requests = [];
    const services = createProviderServices({ accountingPort: new MemoryAccountingPort(), profilePort: new MemoryProfilePort(),
        catalogPort: new MemoryCatalogPort(), transport: { async request(request) {
            requests.push(request);
            assert.equal(request.method, 'GET');
            return new URL(request.url).pathname.endsWith('/language-models') ? response({ models: [language()] }) : response({ data: [model()] });
        } } });
    try {
        const config = (await services.profiles.put(profile(), 0, { principalId: 'bpc-fixture', clientId: 'bpc-fixture' }, randomUUID())).profile;
        await services.refreshModels(config.profileId);
        await services.ledger.createQuotaLimit({ quotaLimitId: config.quotaLimitId, amountMode: 'estimated', currency: 'USD',
            maxCostMicros: 100_000, quotaScopeIds: [config.quotaScopeId], sourceRef: 'owned-local-estimate' });
        const client = { principalId: 'bpc-fixture', clientId: 'bpc-fixture' };
        const preparedCreate = await runtime.dispatch('conversations.prepareTemporaryCreate', {}, client);
        assert.equal(preparedCreate.ok, true, JSON.stringify(preparedCreate));
        const created = await runtime.dispatch('conversations.create', { clientCommandId: preparedCreate.data.clientCommandId, retention: { mode: 'temporary' },
            options: { profileId: config.profileId, modelId: config.defaultModel,
                modelSelection: { profileId: config.profileId, modelId: config.defaultModel } } }, client);
        assert.equal(created.ok, true, JSON.stringify(created));
        const started = await runtime.dispatch('runs.start', { conversationId: created.data.conversationId,
            controlLeaseId: created.data.controlLeaseId, controlEpoch: created.data.controlEpoch, clientCommandId: randomUUID(),
            input: { text: 'ordinary local preparation' }, budget: { costMode: 'estimated', currency: 'USD', maxCostMicros: 100_000,
                maxModelCalls: 4, maxOutputTokens: 256, wallMs: 120_000 } }, client);
        assert.equal(started.ok, true);
        const until = Date.now() + 5000;
        while (!captured && Date.now() < until) await delay(2);
        assert.ok(captured);
        const rootBudgetId = captured.snapshot.rootRunId ?? captured.snapshot.runId;
        const deadlineAt = new Date(Date.now() + 120_000).toISOString();
        await services.ledger.create({ rootBudgetId, quotaLimitId: config.quotaLimitId, mode: 'estimated', currency: 'USD',
            maxCostMicros: 100_000, maxModelCalls: 4, maxOutputTokens: 256, deadlineAt, sourceRef: 'owned-local-estimate' });
        const { catalog, entry } = await services.models.get(config.profileId, config.defaultModel);
        const plan = { profile: config, adapter: services.adapterFor('progrok'), modelId: config.defaultModel, rootBudgetId,
            deadlineAt, parameters: { maxOutputTokens: 256 }, maxOutputTokens: 256, maxModelCalls: 4,
            catalogVersion: catalog.catalogVersion, capabilityVersion: 'local-fixture', priceVersion: entry.pricing.value.priceVersion, toolNames: [] };
        const adapter = createContextServerAdapter({ store, provider: services,
            dispatcher: { async execute() { assert.fail('local BPC preparation must not send'); }, async lookup() { return { status: 'unknown' }; } },
            journal: { async readAttempt() { return undefined; } } });
        const preparedView = await adapter.prepareView(captured, plan, { tools: [] });
        const binding = await adapter.bind(captured, plan);
        assert.equal(binding.config.model.maxOutputTokens, 256);
        assert.equal(entry.maxOutputTokens.value, null);
        const prepared = await services.prepareRequest({ rootBudgetId, profileId: config.profileId, modelId: config.defaultModel,
            parameters: plan.parameters, view: preparedView.view, versions: { conversationId: created.data.conversationId,
                runId: captured.snapshot.runId, roundId: randomUUID(), stepId: randomUUID(), actionId: randomUUID(),
                runEpoch: captured.snapshot.runEpoch, historyEpoch: preparedView.history.historyEpoch, appendSeq: preparedView.history.appendSeq,
                viewRevision: preparedView.history.viewRevision, workspaceRevision: 0, toolSchemaHash: 'local-tools', skillVersions: {},
                attachmentManifestHash: preparedView.attachmentManifestHash, nativeReplayHash: 'local-replay' },
            inputModalities: ['text'], outputModalities: ['text'], inputTokenUpperBound: 1000, inputUpperBoundReliable: true,
            maxOutputTokens: 256, deadlineAt });
        assert.equal(JSON.parse(prepared.snapshot.body).max_tokens, 256);
        assert.equal(prepared.upperBound.source, 'estimated');
        assert.equal(prepared.upperBound.reliable, false);
        assert.ok(prepared.upperBound.amountMicros > 0);
        assert.deepEqual(prepared.upperBound.estimateBasis.missingHardBounds, ['billable_output_tokens']);
        assert.equal(requests.filter(request => request.method === 'POST').length, 0);
    } finally { release(); await runtime.close(); await services.close(); }
});

test('public candidate MCP uses its own estimated profile and quota, reads a file through a function turn, and cold-recovers original receipts (owned HTTP fixture)', { timeout: 90_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-progrok-mcp-estimated-'));
    const workdir = join(root, 'workdir');
    const dataDir = join(root, 'agent-data');
    await mkdir(workdir);
    await mkdir(join(root, 'temp'));
    const csv = 'item,count\napple,7\npear,11\nplum,5\n';
    const inputPath = join(workdir, 'inventory.csv');
    await writeFile(inputPath, csv, 'utf8');
    const requests = [];
    const rpcLog = [];
    const owner = 'estimated-mcp-fixture-' + randomUUID();
    const commandId = label => owner + ':' + label;
    const profileId = owner + '-profile';
    const quotaLimitId = owner + '-quota';
    const coreIds = [];
    let client;
    let transport;
    let completed = false;
    let stderr = '';
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
    const fixture = createServer(async (request, reply) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text ? JSON.parse(text) : null;
        requests.push({ method: request.method, url: request.url, body });
        let result;
        if (request.method === 'GET') result = request.url.startsWith('/v1/language-models') ? { models: [language()] } : { data: [model()] };
        else {
            const ordinal = requests.filter(value => value.method === 'POST').length;
            assert.equal(body.max_tokens, 256);
            const tool = body.messages.findLast(message => message.role === 'tool');
            if (tool) assert.ok(tool.content.includes('apple') && tool.content.includes('pear') && tool.content.includes('plum'), tool.content);
            result = { id: 'owned-response-' + ordinal, model: model().id, choices: [{ index: 0,
                finish_reason: tool ? 'stop' : 'tool_calls', message: tool ? { role: 'assistant', content: 'apple 7, pear 11, plum 5; total 23' }
                    : { role: 'assistant', content: null, tool_calls: [{ id: 'owned-read-' + ordinal, type: 'function',
                        function: { name: 'read_file', arguments: JSON.stringify({ path: inputPath, encoding: 'utf8' }) } }] } }],
                usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 0 },
                    completion_tokens_details: { reasoning_tokens: 0 }, cost_in_usd_ticks: 100_000 } };
        }
        reply.writeHead(200, { 'Content-Type': 'application/json' });
        reply.end(JSON.stringify(result));
    });
    fixture.listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    const rpc = async (action, params = {}) => {
        const raw = await client.callTool({ name: 'sandbox_grok', arguments: { action, params, callerHost: 'codex', callerConversationId: owner } },
            undefined, { timeout: 25_000 });
        const result = raw.structuredContent ?? JSON.parse(raw.content.find(value => value.type === 'text').text);
        rpcLog.push({ action, params, result });
        assert.equal(result.ok, true, JSON.stringify(result));
        return result;
    };
    const open = async () => {
        const environment = {};
        for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']) {
            if (process.env[name]) environment[name] = process.env[name];
        }
        Object.assign(environment, { TEMP: join(root, 'temp'), TMP: join(root, 'temp'), SANDBOX_AGENT_HOME: dataDir,
            SANDBOX_DATA_ROOT: join(root, 'sandbox-data'), CODEX_TOOLKIT_DATA_ROOT: root, SANDBOX_COUNCIL_AUTO_GC: '0', SANDBOX_ENABLE_DUPLICATE_RETIREMENT: '0' });
        transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../../../dist/index.js', import.meta.url))],
            cwd: workdir, env: environment, stderr: 'pipe' });
        transport.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-20_000); });
        client = new Client({ name: owner, version: '1.0.0' }, { capabilities: {} });
        await client.connect(transport);
        await rpc('server.info');
        const descriptor = JSON.parse(await readFile(join(dataDir, 'runtime/server.json'), 'utf8'));
        coreIds.push({ pid: descriptor.pid, instance: descriptor.serverInstanceId });
    };
    const close = async () => {
        if (!client) return;
        await rpc('server.shutdown', { clientCommandId: commandId('shutdown-' + coreIds.length), mode: 'drain', graceMs: 5000 });
        const identity = coreIds.at(-1);
        const deadline = Date.now() + 10_000;
        while (identity && alive(identity.pid) && Date.now() < deadline) await delay(25);
        await client.close();
        client = undefined;
        assert.ok(!identity || !alive(identity.pid));
    };
    const start = async (conversationId, label) => {
        const launched = await rpc('runs.start', { conversationId, clientCommandId: commandId(label), input: { text: 'Read the owned inventory CSV and give the total: ' + inputPath },
            budget: { costMode: 'estimated', currency: 'USD', maxCostMicros: 100_000, maxModelCalls: 4, maxOutputTokens: 256, wallMs: 120_000, quotaLimitId } });
        const deadline = Date.now() + 30_000;
        let run;
        while (Date.now() < deadline) {
            run = (await rpc('runs.get', { conversationId, runId: launched.data.runId })).data;
            if (['succeeded', 'failed', 'cancelled', 'outcome_unknown', 'waiting', 'paused'].includes(run.state)) break;
            await delay(25);
        }
        assert.equal(run.state, 'succeeded', JSON.stringify(run));
        assert.equal(run.budget.effectiveAmountMode, 'estimated');
        return run;
    };
    try {
        await open();
        await rpc('budgets.configureLimit', { clientCommandId: commandId('quota'), definition: { quotaLimitId, amountMode: 'estimated', currency: 'USD',
            maxCostMicros: 100_000, quotaScopeIds: [owner], sourceRef: 'owned-local-http-fixture-no-external-billing' } });
        const config = { ...newProfile({ profileId, label: 'owned MCP estimate fixture', protocol: 'progrok',
            baseUrl: `http://127.0.0.1:${fixture.address().port}/v1`, modelId: model().id }), quotaScopeId: owner, quotaLimitId };
        await rpc('profiles.put', { clientCommandId: commandId('profile'), profile: config, expectedRevision: 0 });
        await rpc('models.refresh', { clientCommandId: commandId('refresh'), profileId });
        const created = await rpc('conversations.create', { clientCommandId: commandId('create'), retention: { mode: 'archive' }, options: {
            profileId, modelId: model().id, modelSelection: { profileId, modelId: model().id }, workingDirectory: workdir,
            writeRoots: [workdir], tools: ['read_file'], allowSubagents: false } });
        const conversationId = created.data.conversationId;
        const first = await start(conversationId, 'first');
        const beforeReceipt = await rpc('server.getReceipt', { conversationId, targetClientCommandId: commandId('first') });
        const beforeLedger = await rpc('budgets.get', { rootBudgetId: first.rootRunId });
        assert.equal(beforeLedger.data.budget.spentCalls, 2);
        assert.equal(beforeLedger.data.budget.spentMicros, 20);
        assert.equal(beforeLedger.data.budget.heldMicros, 0);
        assert.ok(beforeLedger.data.reservations.every(value => value.amountMode === 'estimated' && value.originalUpperBound.reliable === false));
        assert.ok(beforeLedger.data.charges.every(value => value.kind === 'provider_reported'));
        const artifact = await rpc('conversations.readArtifact', { conversationId, artifactId: first.resultContentId, offset: 0, maxBytes: 262144 });
        assert.ok(Buffer.from(artifact.data.dataBase64, 'base64').toString('utf8').includes('total 23'));
        await close();
        await open();
        assert.notEqual(coreIds[0].instance, coreIds[1].instance);
        assert.deepEqual((await rpc('server.getReceipt', { conversationId, targetClientCommandId: commandId('first') })).data, beforeReceipt.data);
        assert.deepEqual((await rpc('budgets.get', { rootBudgetId: first.rootRunId })).data, beforeLedger.data);
        await start(conversationId, 'second');
        assert.equal(requests.filter(value => value.method === 'POST').length, 3);
        assert.equal(await readFile(inputPath, 'utf8'), csv);
        completed = true;
    } finally {
        try { await close(); } finally {
            fixture.closeAllConnections();
            await new Promise(resolveClose => fixture.close(resolveClose));
        }
        if (completed) {
            assert.equal(dirname(resolve(root)), resolve(tmpdir()));
            assert.ok(basename(root).startsWith('sandbox-progrok-mcp-estimated-'));
            await rm(root, { recursive: true, force: true });
        } else {
            await writeFile(join(root, 'failure-evidence.json'), JSON.stringify({ rpcLog, requests, stderr, coreIds }, null, 2), 'utf8');
            console.error('Owned MCP fixture evidence retained: ' + root);
        }
    }
});
