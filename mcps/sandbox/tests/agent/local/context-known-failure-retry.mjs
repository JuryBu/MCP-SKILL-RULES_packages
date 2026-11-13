import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { openAgentStore } from '../../../src/agent-server/storage/index.ts';
import { createAgentRuntime } from '../../../src/agent-server/runtime.ts';
import { createAgentServices } from '../../../src/agent-server/server-services.ts';
import { MemoryCatalogPort, entryFromMetadata, modelScope } from '../../../src/agent-server/models/catalog.ts';
import { newProfile } from '../../../src/agent-server/profiles/profile-store.ts';
import { AgentFault } from '../../../src/agent-server/protocol.ts';
import { hashContext } from '../../../src/agent-server/context/config.ts';

async function until(operation, predicate, label) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const value = await operation();
        if (predicate(value)) return value;
        await delay(5);
    }
    assert.fail(`${label} did not settle`);
}

test(process.env.SANDBOX_RETRY_FIXTURE_RESTART_DEFAULT_OUTPUT === '1'
    ? 'formal RPC restarts a rebound known truncation and freezes root-bounded compression output without retrying unknown'
    : 'formal RPC retries a known unsent compaction failure with a new maintenance root and retained committed chunks', async () => {
    const workerThreads = createRequire(import.meta.url)('node:worker_threads');
    const NativeWorker = workerThreads.Worker;
    workerThreads.Worker = class extends NativeWorker {
        constructor(entry, options) {
            super(entry instanceof URL && entry.pathname.endsWith('/src/agent-server/storage/worker.ts')
                ? new URL('../../../dist/agent-server/storage/worker.js', import.meta.url) : entry, options);
        }
    };
    syncBuiltinESMExports();
    const root = await mkdtemp(join(tmpdir(), 'sandbox-known-failure-fixture-'));
    const work = join(root, 'work');
    await mkdir(work);
    const requests = [];
    const withRestartDefaults = process.env.SANDBOX_RETRY_FIXTURE_RESTART_DEFAULT_OUTPUT === '1';
    let truncateNext = false;
    let disconnectNext = false;
    const withTailEvent = process.env.SANDBOX_RETRY_FIXTURE_TAIL_EVENT === '1';
    const withPriceChange = process.env.SANDBOX_RETRY_FIXTURE_PRICE_CHANGE === '1';
    const server = createServer(async (request, response) => {
        const pieces = [];
        for await (const piece of request) pieces.push(piece);
        const body = JSON.parse(Buffer.concat(pieces).toString('utf8'));
        const text = body.messages.filter(message => message.role === 'user').at(-1).content;
        let source;
        try { source = JSON.parse(text); } catch {}
        const compression = Array.isArray(source?.targets);
        requests.push({ compression, source: compression && source.targets.length > 0, hash: createHash('sha256').update(text).digest('hex'),
            maxTokens: body.max_tokens, ...(withRestartDefaults ? { wireBody: body } : {}) });
        if (compression && disconnectNext) { disconnectNext = false; response.destroy(); return; }
        const truncated = compression && truncateNext;
        if (truncated) truncateNext = false;
        const digestBody = withTailEvent && compression && source.targets.length > 0 && requests.filter(entry => entry.source).length <= 2
            ? 'Known fixture source fact. '.repeat(100) : 'Known fixture facts and exact source identities retained.';
        const content = compression ? JSON.stringify({ body: digestBody,
            skeleton: 'Fixture source index.', title: 'Fixture', unresolved: [], continuesPrevious: true }) : 'Fixture ordinary step completed.';
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: randomUUID(), model: 'fixture-model', choices: [{ index: 0,
            message: { role: 'assistant', content: truncated ? '{"body":"truncated fixture' : content }, finish_reason: truncated ? 'length' : 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 20 } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const client = { principalId: 'fixture-owner', clientId: 'fixture-client', callerHost: 'standalone-cli' };
    const dataDir = join(root, 'state');
    const catalogPort = new MemoryCatalogPort();
    let store;
    let runtime;
    let services;
    const open = async () => {
        store = await openAgentStore({ dataDir: join(dataDir, 'store') });
        runtime = createAgentRuntime({ store, cleanupGraceMs: 1000, onConversationClosed: conversation => services?.onConversationClosed(conversation) });
        services = await createAgentServices({ store, runtime, catalogPort, sharedServices: [], authority: {
            dataDir, runtimeDir: join(dataDir, 'runtime'), principalId: client.principalId, credentialRef: 'fixture-only',
            secret: Buffer.alloc(32), endpoint: 'fixture-only' } });
        await runtime.setExecutor(services.executor);
    };
    try {
        await open();
        const profile = (await services.provider.profiles.put(newProfile({ profileId: 'fixture-profile', label: 'Fixture loopback',
            protocol: 'compatible_chat', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId: 'fixture-model' }), 0, client, randomUUID())).profile;
        const observedAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 600000).toISOString();
        const evidence = value => ({ value, status: 'supported', source: 'verified_fixture', sourceRef: 'fixture-loopback',
            observedAt, expiresAt, scope: modelScope(profile, 'fixture-model', null), version: 'fixture-v1', confidence: 'contract_checked' });
        const entry = entryFromMetadata(profile, { id: 'fixture-model' }, observedAt, expiresAt);
        Object.assign(entry, { contextWindow: evidence(128000), maxInputTokens: evidence(128000), thinking: evidence(false),
            streaming: evidence(false), maxOutputTokens: evidence(4096), inputModalities: evidence(['text']),
            outputModalities: evidence(['text']), tools: evidence(true), parameters: {
                maxOutputTokens: evidence({ type: 'integer', min: 1, max: 4096, wirePath: 'max_tokens' }),
                temperature: evidence({ type: 'number', min: 0, max: 2, wirePath: 'temperature' }),
                topP: evidence({ type: 'number', min: 0, max: 1, wirePath: 'top_p' }) }, pricing: evidence({
                priceVersion: 'fixture-price', currency: 'USD', unitTokens: 1000000, inputUncached: 1000, inputCacheRead: 1000,
                inputCacheWrite: null, output: 1000, reasoningBilledSeparately: false, media: 'included_in_tokens', serverTools: 'disabled',
                sourceRef: 'verified_fixture', validFrom: observedAt, expiresAt, coversAllParameters: true }) });
        const pricedEvidence = structuredClone(entry.pricing);
        if (withRestartDefaults) {
            entry.contextWindow = evidence(1048576);
            entry.maxInputTokens = evidence(1048576);
            entry.maxOutputTokens = evidence(262144);
            entry.parameters.maxOutputTokens = evidence({ type: 'integer', min: 1, max: 262144, wirePath: 'max_tokens' });
        }
        if (withPriceChange) {
            entry.pricing = { ...entry.pricing, value: null, status: 'unknown' };
            const originals = [entry.contextWindow, entry.maxInputTokens, entry.thinking, entry.streaming, entry.maxOutputTokens,
                entry.inputModalities, entry.outputModalities, entry.tools, ...Object.values(entry.parameters)];
            assert.equal(originals.length, 11);
            for (const [index, original] of originals.entries()) original.source = index % 2 ? 'official_doc' : 'api';
        }
        await services.provider.models.port.publish({ schemaVersion: 1, catalogVersion: 'fixture-catalog', profileId: profile.profileId,
            profileRevision: profile.revision, observedAt, expiresAt, entries: [entry] }, null);
        await services.provider.ledger.createQuotaLimit({ quotaLimitId: 'fixture-total', currency: withPriceChange ? 'CNY' : 'USD', maxCostMicros: 1000000,
            quotaScopeIds: [profile.quotaScopeId], sourceRef: 'verified_fixture' });
        const budget = { costMode: withPriceChange ? 'metered' : 'hard', currency: withPriceChange ? 'XXX' : 'USD',
            quotaLimitId: withPriceChange ? undefined : 'fixture-total', maxCostMicros: withPriceChange ? null : 100000,
            maxModelCalls: 128, maxOutputTokens: 512, wallMs: 180000 };
        const created = await services.dispatch('conversations.create', { clientCommandId: randomUUID(), retention: { mode: 'archive' },
            options: { profileId: profile.profileId, modelId: 'fixture-model', writeRoots: [work], tools: [],
                ...(withPriceChange ? { parameters: { maxOutputTokens: 512 } } : {}),
                contextPolicy: { chunkInputTokens: 6000, referenceTokens: 1000 } } }, client);
        assert.equal(created.ok, true, JSON.stringify(created));
        const control = { conversationId: created.data.conversationId, controlLeaseId: created.data.controlLeaseId, controlEpoch: created.data.controlEpoch };
        const run = runId => services.dispatch('runs.get', { conversationId: control.conversationId, runId }, client);
        const start = async text => {
            const result = await services.dispatch(withPriceChange ? 'runs.startInteractive' : 'runs.start', { ...control, clientCommandId: randomUUID(),
                ...(withPriceChange ? {} : { budget }), input: { text } }, client);
            assert.equal(result.ok, true, JSON.stringify(result));
            return until(() => run(result.data.runId), value => ['failed', 'succeeded', 'outcome_unknown'].includes(value.data?.state), 'fixture task');
        };
        for (let ordinal = 0; ordinal < 3; ordinal++) {
            const ended = await start(ordinal ? `Fixture ordinary round ${ordinal}.` : 'Fixture source fact. '.repeat(1500));
            assert.equal(ended.data.state, 'succeeded', JSON.stringify(ended));
        }
        const updated = await services.dispatch('conversations.update', { ...control, clientCommandId: randomUUID(), expectedRevision: 1,
            options: { contextPolicy: { localContextWindowTokens: 24000, chunkInputTokens: 6000, referenceTokens: 1000 } } }, client);
        assert.equal(updated.ok, true, JSON.stringify(updated));
        const model = services.contextService.compressionModel;
        const generate = model.generate.bind(model);
        let committed = 0;
        model.generate = async (request, signal) => {
            if (committed === (withTailEvent ? 5 : 3)) {
                if (withRestartDefaults) truncateNext = true;
                else throw new AgentFault('E_BUDGET_EXCEEDED', 'Fixture known unsent budget failure', {
                    budgetReservationRejected: true, rootBudgetId: request.execution.rootBudgetId,
                    compressionRequestAttemptId: request.attemptId });
            }
            const result = await generate(request, signal);
            committed++;
            return result;
        };
        const failed = await start('Continue the existing fixture task.');
        assert.equal(failed.data.state, 'failed', JSON.stringify(failed));
        const before = await services.contextService.status({ conversationId: control.conversationId });
        const original = await services.contextService.compactionPort.getCandidate(control.conversationId, before.candidate.candidateId);
        assert.equal(original.state, 'failed');
        assert.equal(original.pendingRequest, null);
        assert.equal(original.chunks.length, withTailEvent ? 5 : 3);
        if (withTailEvent) assert.equal(original.semanticTailReorganizations?.length, 2);
        const originalBytes = JSON.stringify(original);
        const originalRunBytes = JSON.stringify(failed.data);
        const ledgerBefore = await services.provider.ledger.read(original.snapshot.execution.rootBudgetId);
        const originalHashes = original.chunks.map(chunk => chunk.inputBodyHash);
        if (withRestartDefaults) {
            const { checkRestartAndDefaultOutput } = await import('./context-restart-default-output.mjs');
            model.generate = generate;
            await checkRestartAndDefaultOutput({ services, store, client, control, profile, work, budget, requests,
                before, original, failed, ledgerBefore, until, disconnectNextCompression: () => { disconnectNext = true; } });
            return;
        }
        if (!withPriceChange) assert.notEqual(before.configuration.configFingerprint, original.snapshot.config.configFingerprint);
        let pricingCompatibility;
        let declareEntry;
        let initialCatalogVersion;
        if (withPriceChange) {
            const previous = await services.provider.models.get(profile.profileId, 'fixture-model');
            initialCatalogVersion = previous.catalog.catalogVersion;
            assert.equal(hashContext(previous.entry), original.snapshot.config.model.capabilityVersion);
            const serverControl = await services.dispatch('server.claimControl', { clientCommandId: randomUUID(), scope: 'server' }, client);
            assert.equal(serverControl.ok, true, JSON.stringify(serverControl));
            declareEntry = (value, expectedCatalogVersion) => services.dispatch('models.declare', {
                profileId: profile.profileId, entry: value, expectedCatalogVersion, clientCommandId: randomUUID(),
                controlLeaseId: serverControl.data.controlLeaseId, controlEpoch: serverControl.data.controlEpoch }, client);
            const priced = { ...structuredClone(previous.entry), pricing: { ...pricedEvidence,
                value: { ...pricedEvidence.value, currency: 'CNY', priceVersion: 'fixture-recovery-price' } } };
            const declared = await declareEntry(priced, previous.catalog.catalogVersion);
            assert.equal(declared.ok, true, JSON.stringify(declared));
            const current = await services.provider.models.get(profile.profileId, 'fixture-model');
            const { pricing: _previousPricing, ...previousCapabilities } = previous.entry;
            const { pricing: _currentPricing, ...currentCapabilities } = current.entry;
            assert.deepEqual(currentCapabilities, previousCapabilities);
            pricingCompatibility = { previousEntry: previous.entry, expectedCapabilityVersion: hashContext(current.entry) };
            assert.notEqual(pricingCompatibility.expectedCapabilityVersion, original.snapshot.config.model.capabilityVersion);
        }
        const maintenanceBudget = withPriceChange ? { ...budget, costMode: 'hard', currency: 'CNY', quotaLimitId: 'fixture-total', maxCostMicros: 100000 } : budget;
        const params = { ...control, clientCommandId: randomUUID(), candidateId: original.candidateId,
            retryKnownFailure: true, expectedHistoryEpoch: original.snapshot.historyEpoch,
            expectedRunEpoch: original.snapshot.runEpoch, expectedConfigFingerprint: original.snapshot.config.configFingerprint,
            budget: maintenanceBudget, ...(pricingCompatibility ? { pricingCompatibility } : {}) };
        const closed = await services.dispatch('conversations.close', { ...control, clientCommandId: randomUUID() }, client);
        assert.equal(closed.ok, true, JSON.stringify(closed));
        const closedState = await services.dispatch('conversations.get', { conversationId: control.conversationId }, client);
        assert.equal(closedState.data.state, 'closed');
        assert.equal(closedState.data.cleanupState, 'released');
        assert.ok(closedState.data.finalContextSnapshot);
        const closedRetry = await services.dispatch('conversations.recoverCompaction', { ...params, clientCommandId: randomUUID() }, client);
        assert.equal(closedRetry.ok, false);
        const reopened = await services.dispatch('conversations.reopen', { ...control, clientCommandId: randomUUID() }, client);
        assert.equal(reopened.ok, true, JSON.stringify(reopened));
        const reopenedState = await services.dispatch('conversations.get', { conversationId: control.conversationId }, client);
        assert.equal(reopenedState.data.state, 'open');
        assert.equal(reopenedState.data.activeRunId, null);
        assert.equal(reopenedState.data.historyEpoch, original.snapshot.historyEpoch);
        assert.equal(reopenedState.data.viewRevision, original.snapshot.parentViewRevision);
        assert.equal(JSON.stringify(await services.contextService.compactionPort.getCandidate(control.conversationId, original.candidateId)), originalBytes);
        if (withTailEvent) {
            const tampered = structuredClone(original);
            const eventIds = new Set(tampered.semanticTailReorganizations.map(event => event.chunkId));
            tampered.chunks.find(chunk => eventIds.has(chunk.chunkId)).digest.continuesPrevious = true;
            await assert.rejects(() => model.verifyCommittedChunks(tampered), error => error.code === 'CONTEXT_SOURCE_GAP');
        }
        const missingBudget = await services.dispatch('conversations.recoverCompaction', { ...params, clientCommandId: randomUUID(), budget: undefined }, client);
        assert.equal(missingBudget.ok, false);
        const wrongConfig = await services.dispatch('conversations.recoverCompaction', { ...params, clientCommandId: randomUUID(), expectedConfigFingerprint: 'wrong-fixture-config' }, client);
        assert.equal(wrongConfig.ok, false);
        const countBeforeRejected = requests.length;
        if (withPriceChange) {
            const meteredRetry = await services.dispatch('conversations.recoverCompaction', { ...params, clientCommandId: randomUUID(),
                budget: { ...maintenanceBudget, costMode: 'metered', maxCostMicros: null } }, client);
            assert.equal(meteredRetry.ok, false);
            const noBinding = await services.dispatch('conversations.recoverCompaction', { ...params, clientCommandId: randomUUID(), pricingCompatibility: undefined }, client);
            assert.equal(noBinding.ok, false);
            assert.equal(noBinding.error.code, 'CONTEXT_MODEL_STALE');
            const current = await services.provider.models.get(profile.profileId, 'fixture-model');
            const changed = { ...structuredClone(current.entry), maxOutputTokens: { ...current.entry.maxOutputTokens, value: 4095 } };
            const changedCapability = await declareEntry(changed, current.catalog.catalogVersion);
            assert.equal(changedCapability.ok, false);
            assert.equal(changedCapability.error.code, 'E_DECLARATION_SOURCE');
            const untrustedPricing = await declareEntry({ ...structuredClone(current.entry), pricing: { ...current.entry.pricing, source: 'api' } }, current.catalog.catalogVersion);
            assert.equal(untrustedPricing.ok, false);
            assert.equal(untrustedPricing.error.code, 'E_DECLARATION_SOURCE');
            const newModel = { ...structuredClone(current.entry), modelId: 'new-fixture-model' };
            for (const original of [newModel.contextWindow, newModel.maxInputTokens, newModel.thinking, newModel.streaming,
                newModel.maxOutputTokens, newModel.inputModalities, newModel.outputModalities, newModel.tools,
                ...Object.values(newModel.parameters), newModel.pricing]) original.scope.modelId = 'new-fixture-model';
            const newEntry = await declareEntry(newModel, current.catalog.catalogVersion);
            assert.equal(newEntry.ok, false);
            assert.equal(newEntry.error.code, 'E_DECLARATION_SOURCE');
            const staleCatalog = await declareEntry(current.entry, initialCatalogVersion);
            assert.equal(staleCatalog.ok, false);
            assert.equal(staleCatalog.error.code, 'E_CATALOG_CONFLICT');
        }
        const wrongHistory = await services.dispatch('conversations.recoverCompaction', { ...params, clientCommandId: randomUUID(),
            expectedHistoryEpoch: original.snapshot.historyEpoch + 1 }, client);
        assert.equal(wrongHistory.ok, false);
        const ordinaryRecover = await services.dispatch('conversations.recoverCompaction', { ...params, clientCommandId: randomUUID(), retryKnownFailure: false }, client);
        assert.equal(ordinaryRecover.ok, false);
        assert.equal(requests.length, countBeforeRejected);
        model.generate = generate;
        const recovered = await services.dispatch('conversations.recoverCompaction', params, client);
        assert.equal(recovered.ok, true, JSON.stringify(recovered));
        assert.notEqual(recovered.data.candidateId, original.candidateId);
        assert.deepEqual(await services.dispatch('conversations.recoverCompaction', params, client), recovered);
        const final = await until(() => services.contextService.compactionPort.getCandidate(control.conversationId, recovered.data.candidateId),
            candidate => ['published', 'failed', 'unknown'].includes(candidate?.state), 'new maintenance compaction');
        assert.equal(final.state, 'published', JSON.stringify(final.error));
        assert.equal(final.snapshot.retryOf.candidateId, original.candidateId);
        assert.equal(final.snapshot.sourceManifestHash, original.snapshot.sourceManifestHash);
        assert.equal(final.snapshot.sourcePrefixHash, original.snapshot.sourcePrefixHash);
        assert.notEqual(final.snapshot.execution.rootBudgetId, original.snapshot.execution.rootBudgetId);
        assert.notEqual(final.snapshot.execution.deadlineAt, original.snapshot.execution.deadlineAt);
        assert.equal(JSON.stringify(await services.contextService.compactionPort.getCandidate(control.conversationId, original.candidateId)), originalBytes);
        assert.equal(JSON.stringify((await run(failed.data.runId)).data), originalRunBytes);
        const ledgerAfter = await services.provider.ledger.read(original.snapshot.execution.rootBudgetId);
        for (const key of ['budget', 'reservations', 'charges']) assert.deepEqual(ledgerAfter[key], ledgerBefore[key]);
        for (const hash of originalHashes) assert.equal(requests.filter(request => request.hash === hash).length, 1);
        assert.ok(final.nextView.fitEvidence);
        if (withPriceChange) {
            assert.equal(final.snapshot.config.model.capabilityVersion, original.snapshot.config.model.capabilityVersion);
            assert.equal(final.snapshot.effectiveModelFingerprint, original.snapshot.effectiveModelFingerprint);
            const newLedger = await services.provider.ledger.read(final.snapshot.execution.rootBudgetId);
            assert.equal(newLedger.budget.mode, 'hard');
            assert.equal(newLedger.budget.currency, 'CNY');
            assert.ok(newLedger.charges.length > 0);
            assert.ok(newLedger.charges.every(charge => charge.amountMicros !== null));
            const binding = await store.getRecord({ conversationId: control.conversationId, kind: 'step', id: `context:pricing-compatibility:${final.candidateId}` });
            assert.equal(binding.value.currentCapabilityVersion, pricingCompatibility.expectedCapabilityVersion);
        }
        const staleRetry = await services.dispatch('conversations.recoverCompaction', { ...params, clientCommandId: randomUUID() }, client);
        assert.equal(staleRetry.ok, false);
        const requestCount = requests.length;
        await runtime.close(); await services.close(); await store.close();
        await open();
        const cold = await services.dispatch('conversations.recoverCompaction', { ...params, clientCommandId: randomUUID(),
            candidateId: final.candidateId, retryKnownFailure: false, budget: undefined, expectedRunEpoch: undefined }, client);
        assert.equal(cold.ok, true, JSON.stringify(cold));
        assert.equal(cold.data.state, 'published');
        assert.equal(requests.length, requestCount);
        console.log(JSON.stringify({ formalRpc: true, realProviderRequests: 0, importedChunks: original.chunks.length,
            importedTailEvents: original.semanticTailReorganizations?.length ?? 0,
            meteredToHardPriceChange: withPriceChange,
            originalEvidenceSourcesPreserved: withPriceChange ? 11 : 0,
            formalModelsDeclare: withPriceChange,
            archiveCloseReopen: true, originalRunPreserved: true, originalLedgerPreserved: true, coldRepublishedRequests: 0 }));
    } finally {
        await runtime?.close(); await services?.close(); await store?.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        assert.equal(dirname(root), tmpdir());
        assert.ok(basename(root).startsWith('sandbox-known-failure-fixture-'));
        await rm(root, { recursive: true, force: true });
        workerThreads.Worker = NativeWorker;
        syncBuiltinESMExports();
    }
});
