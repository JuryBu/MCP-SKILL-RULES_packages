import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAgentStore } from '../../../src/agent-server/storage/index.ts';
import { createAgentProviderPorts } from '../../../src/agent-server/storage/temporary-provider.ts';
import { freezeRequest, prepareAttempt } from '../../../src/agent-server/providers/assemble.ts';
import { ProgrokAdapter } from '../../../src/agent-server/providers/progrok.ts';
import { normalizeChatResponse } from '../../../src/agent-server/providers/compatible-chat.ts';
import { normalizeProgrokUsage } from '../../../src/agent-server/accounting/usage.ts';
import { newProfile } from '../../../src/agent-server/profiles/profile-store.ts';
import { failureHasExecutionEvidence } from '../../../src/agent-server/providers/failure-accounting.ts';

const deadline = () => new Date(Date.now() + 120000).toISOString();
const upper = { currency: 'USD', amountMicros: 100, reliable: true, source: 'fixture', sourceRef: 'owned-no-network-fixture' };

async function seed(store, mode) {
    const conversationId = randomUUID(), runId = randomUUID();
    const now = new Date().toISOString();
    const conversation = { key: { conversationId, kind: 'conversation', id: conversationId }, revision: 1,
        value: { conversationId, principalId: 'i8-owned-failure-fixture', state: 'open', retention: { mode,
            lastRunEnd: null, lastClose: null, expiresAt: null, activeRuns: 1 }, createdAt: now, updatedAt: now,
        historyEpoch: 1, appendSeq: 0, viewRevision: 0, workspaceRevision: 0, runEpoch: 1,
        eventGeneration: randomUUID(), eventSeq: '0', policyRevision: 1, activeRunId: runId, options: {} } };
    const run = { key: { conversationId, kind: 'run', id: runId }, revision: 1,
        value: { conversationId, runId, rootRunId: runId, parentRunId: null, kind: 'task', runEpoch: 1, state: 'running',
            phase: 'awaiting_response', effectState: 'none', cleanupState: 'pending', activeRoundId: randomUUID(), activeStepId: randomUUID(),
            pendingInteractionIds: [], budget: { rootBudgetId: runId }, resultStatus: null, stopReason: null,
            deadlineAt: deadline(), createdAt: now, updatedAt: now } };
    await store.commitTransition({ expected: [{ key: conversation.key, revision: null }, { key: run.key, revision: null }], records: [conversation, run] });
    return { conversationId, runId };
}

function makeAttempt(root, marker) {
    const adapter = new ProgrokAdapter();
    const profile = { ...newProfile({ label: 'owned fake transport', profileId: 'i8-fee-profile', protocol: 'progrok',
        baseUrl: 'http://127.0.0.1:39999/v1', modelId: 'fixture-progrok' }), revision: 1, quotaScopeId: 'i8-owned-account' };
    return prepareAttempt(freezeRequest({ adapter, profile, modelId: profile.defaultModel, rootBudgetId: root.runId,
        versions: { conversationId: root.conversationId, runId: root.runId, roundId: null, stepId: randomUUID(), actionId: randomUUID(),
            runEpoch: 1, historyEpoch: 1, appendSeq: 0, viewRevision: 0, workspaceRevision: 0, catalogVersion: 'fixture', capabilityVersion: 'fixture',
            priceVersion: null, toolSchemaHash: 'none', skillVersions: {}, attachmentManifestHash: 'none', nativeReplayHash: 'none' },
        view: { protocol: 'progrok', messages: [{ role: 'user', content: marker }] }, parameters: { max_tokens: 64 }, deadlineAt: deadline() }), root.runId);
}

function nativeResponse(attempt, marker, { complete = false, amount = null, input = 10, output = 3 } = {}) {
    const nativeUsage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output + 2,
        prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 2 },
        ...(amount === null ? {} : { cost_in_usd_ticks: String(amount * 10000) }) };
    const json = { id: `exec-${attempt.attemptId}`, model: attempt.snapshot.modelId,
        choices: [{ index: 0, message: { role: 'assistant', content: marker }, finish_reason: complete ? 'stop' : null }], usage: nativeUsage };
    const raw = { httpStatus: 200, headers: {}, body: JSON.stringify(json), json };
    return { ...normalizeChatResponse(attempt.attemptId, raw), usage: normalizeProgrokUsage(nativeUsage) };
}

const errorFor = (acceptance, response, marker) => ({ acceptance,
    error: { code: 'E_RESULT_UNKNOWN', message: marker, retryable: false, mayHaveStarted: true },
    partialResponse: response, usage: response.usage, rawResponse: response.raw });

test('I8 even an empty reported usage object preserves acceptance uncertainty; absent usage alone is not execution evidence', () => {
    assert.equal(failureHasExecutionEvidence({ rawResponse: { httpStatus: 400, headers: {}, body: '', json: { usage: {} } } }), true);
    assert.equal(failureHasExecutionEvidence({ rawResponse: { httpStatus: 400, headers: {}, body: '', json: { error: { code: 'bad_request' } } } }), false);
});

async function diskBytes(directory) {
    const buffers = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        buffers.push(entry.isDirectory() ? await diskBytes(file) : await readFile(file));
    }
    return Buffer.concat(buffers);
}

for (const mode of ['archive', 'temporary']) {
    test(`I8 ${mode} failure usage reaches the original ledger, partial native amount remains unknown, final supplement and replay charge once`, { timeout: 20000 }, async () => {
        const directory = await mkdtemp(join(tmpdir(), `sandbox-i8-failure-${mode}-`));
        const marker = `I8-PRIVATE-NATIVE-${randomUUID()}`;
        let store = await openAgentStore({ dataDir: directory });
        try {
            let ports = createAgentProviderPorts(store);
            const root = await seed(store, mode);
            await ports.accountingPort.createBudget({ rootBudgetId: root.runId, mode: 'hard', currency: 'USD', maxCostMicros: 1000,
                maxModelCalls: 8, maxOutputTokens: 64, deadlineAt: deadline(), sourceRef: 'owned-no-network-fixture' });
            const attempt = makeAttempt(root, marker);
            assert.equal((await ports.journal.prepareAttempt(attempt, upper)).status, 'send');
            const partial = nativeResponse(attempt, marker);
            await ports.journal.recordFailure(attempt, errorFor('unknown', partial, marker));
            let view = await ports.accountingPort.read(root.runId);
            assert.equal(view.charges.length, 1);
            assert.equal(view.charges[0].amountMicros, null);
            assert.equal(view.reservations[0].state, 'unknown');
            assert.equal(view.budget.heldMicros, 100);
            assert.equal(view.budget.amountUnknown, true);
            if (mode === 'archive') assert.equal((await store.persistent.readUsage({ rootBudgetIds: [root.runId] })).inputTokens, 10);
            else assert.equal(view.charges[0].usage.inputTokens, 10);
            const reported = nativeResponse(attempt, marker, { amount: 30, input: 11, output: 4 });
            const rawError = { id: reported.providerResponseId, error: { code: 'invalid_request', message: marker }, usage: reported.usage.raw };
            const rejectedWithUsage = { acceptance: 'rejected', error: { code: 'E_PARAMETER_INVALID', message: marker, retryable: false, mayHaveStarted: false },
                rawResponse: { httpStatus: 400, headers: {}, body: JSON.stringify(rawError), json: rawError } };
            await ports.journal.recordFailure(attempt, rejectedWithUsage);
            await ports.journal.recordFailure(attempt, rejectedWithUsage);
            view = await ports.accountingPort.read(root.runId);
            assert.equal(view.charges.length, 1);
            assert.equal(view.charges[0].amountMicros, 30);
            assert.equal(view.charges[0].kind, 'provider_reported');
            assert.equal(view.charges[0].currency, 'USD');
            assert.equal(view.budget.spentMicros, 30);
            assert.equal(view.budget.heldMicros, 70);
            assert.equal(view.budget.spentCalls, 1);
            assert.equal(view.reservations[0].state, 'unknown');
            assert.equal((await ports.journal.readAttempt(attempt.attemptId)).state, 'unknown');
            const noNewPrice = nativeResponse(attempt, marker, { input: 12, output: 5 });
            await ports.journal.recordFailure(attempt, errorFor('unknown', noNewPrice, marker));
            view = await ports.accountingPort.read(root.runId);
            assert.equal(view.charges[0].amountMicros, 30);
            assert.equal(view.budget.heldMicros, 70);
            const completed = nativeResponse(attempt, marker, { complete: true, amount: 70, input: 12, output: 5 });
            if (mode === 'temporary') {
                const executeFee = store.persistent.executeTemporaryFee.bind(store.persistent);
                let interruptOnce = true;
                store.persistent.executeTemporaryFee = async command => {
                    if (command.type === 'settle' && interruptOnce) { interruptOnce = false; throw Error('owned lost commit receipt fixture'); }
                    return executeFee(command);
                };
                await assert.rejects(ports.journal.commitResponse(attempt, completed), /owned lost commit receipt fixture/);
                await ports.journal.recordFailure(attempt, errorFor('unknown', completed, marker));
                const uncertain = await ports.accountingPort.read(root.runId);
                assert.equal(uncertain.budget.spentMicros, 70);
                assert.equal(uncertain.budget.heldMicros, 30);
                assert.equal(uncertain.reservations[0].state, 'unknown');
                store.persistent.executeTemporaryFee = executeFee;
            }
            await ports.journal.commitResponse(attempt, completed);
            await ports.journal.commitResponse(attempt, completed);
            view = await ports.accountingPort.read(root.runId);
            assert.equal(view.charges.length, 1);
            assert.equal(view.charges[0].amountMicros, 70);
            assert.equal(view.charges[0].usageRevision > 1, true);
            assert.equal(view.budget.spentMicros, 70);
            assert.equal(view.budget.spentCalls, 1);
            assert.equal(view.budget.heldMicros, 0);
            assert.equal(view.reservations[0].state, 'settled');
            if (mode === 'archive') {
                const summary = await store.persistent.readUsage({ rootBudgetIds: [root.runId] });
                assert.equal(summary.inputTokens, 12);
                assert.equal(summary.outputTokens, 5);
                assert.deepEqual(summary.costs, [{ currency: 'USD', amountMicros: 70 }]);
            }
            const unsent = makeAttempt(root, marker);
            await ports.journal.prepareAttempt(unsent, upper);
            await ports.journal.recordFailure(unsent, { acceptance: 'not_sent', error: { code: 'E_TRANSPORT_UNSENT', message: 'owned preflight fixture',
                retryable: false, mayHaveStarted: false } });
            assert.equal((await ports.journal.readAttempt(unsent.attemptId)).state, 'rejected');
            assert.equal((await ports.accountingPort.read(root.runId)).budget.spentMicros, 70);
            const metered = await seed(store, mode);
            await ports.accountingPort.createBudget({ rootBudgetId: metered.runId, mode: 'metered', currency: 'XXX', maxCostMicros: null,
                maxModelCalls: 8, maxOutputTokens: 64, deadlineAt: deadline(), sourceRef: 'owned-metered-fixture' });
            const meteredAttempt = makeAttempt(metered, marker);
            await ports.journal.prepareAttempt(meteredAttempt, { ...upper, currency: 'XXX', amountMicros: null, reliable: false, source: 'estimated' });
            await ports.journal.recordFailure(meteredAttempt, errorFor('unknown', nativeResponse(meteredAttempt, marker, { input: 4, output: 1 }), marker));
            await ports.journal.recordFailure(meteredAttempt, errorFor('unknown', nativeResponse(meteredAttempt, marker, { amount: 10, input: 4, output: 1 }), marker));
            const nativeMetered = await ports.accountingPort.read(metered.runId);
            assert.equal(nativeMetered.charges.length, 1);
            assert.equal(nativeMetered.charges[0].currency, 'USD');
            assert.equal(nativeMetered.charges[0].amountMicros, 10);
            assert.equal(nativeMetered.reservations[0].amountUnknown, true);
            const meteredFinal = nativeResponse(meteredAttempt, marker, { complete: true, amount: 15, input: 4, output: 1 });
            await ports.journal.commitResponse(meteredAttempt, meteredFinal);
            await ports.journal.commitResponse(meteredAttempt, meteredFinal);
            const nativeSummary = await store.persistent.readUsage({ rootBudgetIds: [metered.runId] });
            assert.deepEqual(nativeSummary.costs, [{ currency: 'USD', amountMicros: 15 }]);
            let coldUnknown;
            if (mode === 'temporary') {
                coldUnknown = await seed(store, mode);
                await ports.accountingPort.createBudget({ rootBudgetId: coldUnknown.runId, mode: 'hard', currency: 'USD', maxCostMicros: 1000,
                    maxModelCalls: 8, maxOutputTokens: 64, deadlineAt: deadline(), sourceRef: 'owned-no-network-fixture' });
                const unknown = makeAttempt(coldUnknown, marker);
                await ports.journal.prepareAttempt(unknown, upper);
                await ports.journal.recordFailure(unknown, errorFor('unknown', nativeResponse(unknown, marker, { amount: 20, input: 4, output: 1 }), marker));
            }
            await store.close();
            if (mode === 'temporary') assert.equal((await diskBytes(directory)).includes(Buffer.from(marker)), false);
            store = await openAgentStore({ dataDir: directory });
            ports = createAgentProviderPorts(store);
            const reopened = await ports.accountingPort.read(root.runId);
            assert.equal(reopened.budget.spentMicros, 70);
            assert.equal(reopened.charges.length, 1);
            assert.equal(reopened.budget.spentCalls, 2);
            if (coldUnknown) {
                const pending = await ports.accountingPort.read(coldUnknown.runId);
                assert.equal(pending.budget.spentMicros, 20);
                assert.equal(pending.budget.heldMicros, 80);
                assert.equal(pending.budget.amountUnknown, true);
                assert.equal(pending.reservations[0].state, 'unknown');
                assert.equal(pending.charges[0].usage.inputTokens, 4);
            }
        } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
    });
}
