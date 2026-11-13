import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function checkRestartAndDefaultOutput(fixture) {
    const { services, client, control, profile, work, budget, requests, before, original, failed, ledgerBefore, until } = fixture;
    const port = services.contextService.compactionPort;
    const evidence = { formalServices: true, sqlite: true, externalApiCalls: 0, observations: [] };
    const call = (method, params = {}, selectedControl = control) => services.dispatch(method,
        { ...selectedControl, clientCommandId: randomUUID(), ...params }, client);
    const originalBytes = JSON.stringify(original);
    const failedBytes = JSON.stringify(failed.data);
    assert.equal(before.scheduler.state, 'hardPaused', JSON.stringify(before.scheduler));
    assert.equal(original.pendingRequest, null);
    assert.equal(before.scheduler.lastFailure.details.compressionOutputTruncated, true);
    const updated = await call('conversations.update', { expectedRevision: 2, options: {
        parameters: { maxOutputTokens: 131072 }, contextPolicy: { localContextWindowTokens: 1048576,
            chunkInputTokens: 16000, referenceTokens: 1000 } } });
    assert.equal(updated.ok, true, JSON.stringify(updated));
    const countBeforeBind = requests.length;
    const rebound = await call('runs.start', { budget: { ...budget, maxOutputTokens: 131072 },
        input: { text: 'Continue the existing fixture after the configuration change.' } });
    assert.equal(rebound.ok, true, JSON.stringify(rebound));
    const reboundRun = await until(() => services.dispatch('runs.get', { conversationId: control.conversationId,
        runId: rebound.data.runId }, client), value => ['failed', 'succeeded', 'outcome_unknown'].includes(value.data?.state), 'new config binding');
    assert.equal(reboundRun.data.state, 'failed', JSON.stringify(reboundRun));
    assert.equal(requests.length, countBeforeBind);
    const currentConfig = await port.readConfig(control.conversationId);
    assert.notEqual(currentConfig.configFingerprint, original.snapshot.config.configFingerprint);
    assert.equal(currentConfig.model.maxOutputTokens, 131072);
    const staleHistory = await call('conversations.restartCompaction', { candidateId: original.candidateId,
        expectedHistoryEpoch: original.snapshot.historyEpoch + 1 });
    assert.equal(staleHistory.ok, false);
    assert.equal(staleHistory.error.code, 'CONTEXT_HISTORY_STALE');
    const staleRun = await call('conversations.restartCompaction', { candidateId: original.candidateId,
        expectedRunEpoch: original.snapshot.runEpoch });
    assert.equal(staleRun.ok, false);
    assert.equal(staleRun.error.code, 'CONTEXT_HISTORY_STALE');
    const restarted = await call('conversations.restartCompaction', { candidateId: original.candidateId });
    assert.equal(restarted.ok, true, JSON.stringify(restarted));
    assert.equal(restarted.data.status.scheduler.state, 'idle');
    assert.equal(restarted.data.status.scheduler.lastFailure, null);
    assert.equal(JSON.stringify(await port.getCandidate(control.conversationId, original.candidateId)), originalBytes);
    assert.equal(JSON.stringify((await services.dispatch('runs.get', { conversationId: control.conversationId,
        runId: failed.data.runId }, client)).data), failedBytes);
    const ledgerAfter = await services.provider.ledger.read(original.snapshot.execution.rootBudgetId);
    for (const key of ['budget', 'reservations', 'charges']) assert.deepEqual(ledgerAfter[key], ledgerBefore[key]);
    assert.equal(requests.length, countBeforeBind);
    evidence.observations.push({ scenario: 'known-truncation-config-rebound-restart', before, reboundRun,
        currentConfig, staleHistory, staleRun, restarted, originalCandidate: original, originalRun: failed.data,
        ledgerBefore, ledgerAfter, originalCandidateUnchanged: true, originalRunUnchanged: true,
        oldLedgerUnchanged: true, zeroModelBindAndRestart: true });

    const selectionCases = [
        { label: 'omitted-32768', root: 32768, selected: undefined, expected: 32768 },
        { label: 'omitted-131072', root: 131072, selected: undefined, expected: 131072 },
        { label: 'explicit-2048', root: 131072, selected: 2048, expected: 2048 },
        { label: 'selected-over-root', root: 32768, selected: 131072, expected: 32768 },
        { label: 'unknown-pending-no-resend', root: 32768, selected: undefined, expected: 32768, unknown: true },
    ];
    for (const selected of selectionCases) {
        const created = await call('conversations.create', { retention: { mode: 'archive' }, options: {
            profileId: profile.profileId, modelId: 'fixture-model', writeRoots: [work], tools: [],
            contextPolicy: { localContextWindowTokens: 1048576, chunkInputTokens: 16000, referenceTokens: 1000 },
            compressionModelSelection: { profileId: profile.profileId, modelId: 'fixture-model',
                ...(selected.selected === undefined ? {} : { maxOutputTokens: selected.selected }) } } }, {});
        assert.equal(created.ok, true, JSON.stringify(created));
        const selectedControl = { conversationId: created.data.conversationId,
            controlLeaseId: created.data.controlLeaseId, controlEpoch: created.data.controlEpoch };
        for (let ordinal = 0; ordinal < 3; ordinal++) {
            const started = await call('runs.start', { budget, input: { text: `Fixture default-output source round ${ordinal}.` } }, selectedControl);
            assert.equal(started.ok, true, JSON.stringify(started));
            const done = await until(() => services.dispatch('runs.get', { conversationId: selectedControl.conversationId,
                runId: started.data.runId }, client), value => ['succeeded', 'failed', 'outcome_unknown'].includes(value.data?.state), selected.label);
            assert.equal(done.data.state, 'succeeded', JSON.stringify(done));
        }
        const countBefore = requests.length;
        if (selected.unknown) fixture.disconnectNextCompression();
        const compacted = await call('conversations.compact', { mode: 'manual', budget: { ...budget, maxOutputTokens: selected.root } }, selectedControl);
        assert.equal(compacted.ok, true, JSON.stringify(compacted));
        assert.equal(compacted.data.started, true, JSON.stringify(compacted));
        const candidate = await until(() => port.getCandidate(selectedControl.conversationId, compacted.data.candidateId),
            value => ['published', 'failed', 'unknown'].includes(value?.state), selected.label);
        assert.equal(candidate.state, selected.unknown ? 'unknown' : 'published', JSON.stringify(candidate.error));
        assert.equal(candidate.snapshot.config.model.maxOutputTokens, selected.expected);
        assert.equal(candidate.snapshot.config.model.parameters.maxOutputTokens, selected.expected);
        const wire = requests.slice(countBefore).filter(request => request.compression);
        assert.ok(wire.length > 0);
        for (const request of wire) assert.equal(request.maxTokens, selected.expected);
        if (selected.unknown) {
            assert.ok(candidate.pendingRequest?.attemptId);
            const candidateBytes = JSON.stringify(candidate);
            const requestCount = requests.length;
            const scheduler = await until(() => port.loadScheduler(selectedControl.conversationId),
                value => value?.state === 'hardPaused', 'unknown scheduler checkpoint');
            const ledger = await services.provider.ledger.read(candidate.snapshot.execution.rootBudgetId);
            const blocked = await call('conversations.restartCompaction', { candidateId: candidate.candidateId }, selectedControl);
            assert.equal(blocked.ok, false, JSON.stringify(blocked));
            assert.equal(blocked.error.code, 'CONTEXT_ATTEMPT_UNKNOWN');
            assert.equal(blocked.error.details.attemptId, candidate.pendingRequest.attemptId);
            assert.equal(requests.length, requestCount);
            assert.equal(JSON.stringify(await port.getCandidate(selectedControl.conversationId, candidate.candidateId)), candidateBytes);
            assert.deepEqual(await port.loadScheduler(selectedControl.conversationId), scheduler);
            const unchanged = await services.provider.ledger.read(candidate.snapshot.execution.rootBudgetId);
            for (const key of ['budget', 'reservations', 'charges']) assert.deepEqual(unchanged[key], ledger[key]);
            evidence.observations.push({ scenario: selected.label, blocked, candidate, noResend: true,
                schedulerUnchanged: true, ledgerUnchanged: true });
        }
        evidence.observations.push({ ...selected, selected: selected.selected ?? 'omitted',
            frozenSelection: candidate.snapshot.config.model, wire, candidateId: candidate.candidateId, state: candidate.state });
    }
    evidence.passed = true;
    const output = process.env.SANDBOX_CONTEXT_TAIL_EVIDENCE_DIR;
    if (output) {
        await mkdir(output, { recursive: true });
        await writeFile(join(output, 'context-restart-default-output.result.json'), JSON.stringify(evidence, null, 2), 'utf8');
    }
    console.log(JSON.stringify({ targetedRestartAndDefaults: true, passed: true, externalApiCalls: 0,
        knownTruncatedFailure: true, zeroModelBind: true, restart: 'idle', originalCandidateAndLedgerUnchanged: true,
        selectionCases: selectionCases.map(value => ({ ...value, selected: value.selected ?? 'omitted' })) }));
}
