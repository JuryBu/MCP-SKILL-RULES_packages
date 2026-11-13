import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextCompactor, captureCompletedFragments, computeContextLimits, createContextServerControls, hashContext,
    readSelectedHistory, selectCompactionRounds } from '../index.ts';
import { createFixture } from '../../../../tests/agent/local/context-fixtures.mjs';

function appendSteps(fixture, count, { pendingLast = false } = {}) {
    const { port } = fixture;
    let active = port.capture.rounds.find(round => round.roundId === port.capture.activeRoundId);
    if (!active) {
        const roundId = `round-${port.capture.rounds.length + 1}`;
        const item = port.appendItem(`${roundId}-user`, { text: 'Keep the original task and its native signatures.', references: [] },
            { role: 'user', roundId, stepId: `${roundId}-input`, kind: 'input_consumed' });
        active = { roundId, firstSeq: item.seq, lastSeq: item.seq, itemIds: [item.itemId], complete: false,
            nativePairing: 'complete', lastStepSeq: 0 };
        port.capture.rounds.push(active);
        port.capture.activeRoundId = roundId;
        port.capture.execution.roundId = roundId;
    }
    for (let ordinal = 0; ordinal < count; ordinal++) {
        const stepId = `${active.roundId}-step-${++port.capture.stepSeq}`;
        const callId = `${stepId}-call`;
        const name = 'read_file';
        const text = `Completed source ${stepId}`;
        const model = port.appendItem(`${stepId}-model`, { kind: 'model', protocol: 'compatible_chat', response: {
            attemptId: `${stepId}-attempt`, modelId: fixture.config.model.model, complete: true, canExecuteTools: true, problems: [],
            blocks: [{ type: 'text', text, nativeRef: stepId, candidateIndex: 0, native: { text, thoughtSignature: `signature-${stepId}` } }],
            toolCalls: [{ callId, providerCallId: callId, name, arguments: { path: 'source.txt' }, nativeRef: `${stepId}-call`,
                index: 0, candidateIndex: 0, native: { name, arguments: { path: 'source.txt' }, thoughtSignature: `call-signature-${stepId}` } }],
            replayMessages: [{ role: 'assistant', content: text, tool_calls: [{ id: callId, type: 'function',
                function: { name, arguments: '{"path":"source.txt"}' } }] }],
            raw: { httpStatus: 200, headers: {}, body: text, json: { text } },
        } }, { role: 'assistant', roundId: active.roundId, stepId, kind: 'model_step', providerProtocol: 'compatible_chat' });
        active.itemIds.push(model.itemId);
        if (!(pendingLast && ordinal === count - 1)) {
            const tool = port.appendItem(`${stepId}-tool`, { kind: 'tool', result: { callId, name,
                result: { ok: true, data: { text: `Original tool result ${stepId}` } } } },
            { role: 'tool', roundId: active.roundId, stepId, callId, kind: 'tool_result', providerProtocol: 'compatible_chat' });
            active.itemIds.push(tool.itemId);
        }
        active.lastSeq = port.capture.appendSeq;
        active.lastStepSeq = port.capture.stepSeq;
    }
    active.nativePairing = pendingLast ? 'pending' : 'complete';
    return active;
}

function controls(fixture) {
    return createContextServerControls({ port: fixture.port, service: {},
        resolveConfiguration: async () => ({ config: fixture.config,
            limits: computeContextLimits(fixture.config.model.contextWindow, fixture.config.model.maxOutputTokens, fixture.config.policy) }),
        readMeasurement: () => undefined, model: fixture.model, withControl: async (_capture, operation) => operation(), now: Date.now });
}

async function publish(fixture) {
    const compactor = new ContextCompactor({ port: fixture.port, sources: fixture.sources, model: fixture.model });
    const capture = await fixture.port.inspect();
    const handle = await compactor.start({ conversationId: capture.conversationId, execution: capture.execution,
        config: fixture.config, reason: 'background' });
    assert.equal((await handle.completion).state, 'ready');
    await compactor.publish(capture.conversationId, capture.stepSeq);
    return compactor;
}

test('conversations.context status remains a read-only query after publishing an active prefix without new groups', async () => {
    const fixture = createFixture({ rounds: 0 });
    appendSteps(fixture, 6);
    await publish(fixture);
    const original = hashContext({ capture: fixture.port.capture, contents: [...fixture.port.contents], calls: fixture.model.calls });
    const status = await controls(fixture).status({ conversationId: fixture.port.capture.conversationId });
    assert.ok(status.history.coveredEndSeq > 0);
    assert.deepEqual(status.preview.roundIds, []);
    assert.deepEqual(status.preview.retainedRoundIds, [fixture.port.capture.activeRoundId]);
    assert.equal(original, hashContext({ capture: fixture.port.capture, contents: [...fixture.port.contents], calls: fixture.model.calls }));
});

test('recapturing a published active prefix clears stale fragments and retains its tail exactly once', async () => {
    const fixture = createFixture({ rounds: 0 });
    appendSteps(fixture, 6);
    const previous = await captureCompletedFragments(fixture.port, await fixture.port.inspect(), fixture.config.policy);
    await publish(fixture);
    const current = await fixture.port.inspect();
    const capture = await captureCompletedFragments(fixture.port, { ...current, activeCompletedPrefix: previous.activeCompletedPrefix }, fixture.config.policy);
    assert.equal(capture.activeCompletedPrefix, undefined);
    const selected = selectCompactionRounds(capture, fixture.config.policy);
    assert.deepEqual(selected.targets, []);
    assert.equal(selected.retained.length, 1);
    assert.equal(selected.retained[0].firstSeq, current.view.coveredEndSeq + 1);
    assert.deepEqual(selected.retained[0].itemIds, fixture.port.items.filter(item => item.seq > current.view.coveredEndSeq).map(item => item.itemId));
});

test('an unfinished new group keeps the last two completed groups raw after publication', async () => {
    const fixture = createFixture({ rounds: 0 });
    appendSteps(fixture, 6);
    await publish(fixture);
    appendSteps(fixture, 1, { pendingLast: true });
    const capture = await captureCompletedFragments(fixture.port, await fixture.port.inspect(), fixture.config.policy);
    assert.equal(capture.activeCompletedPrefix, undefined);
    assert.deepEqual(selectCompactionRounds(capture, fixture.config.policy).targets, []);
    assert.deepEqual((await controls(fixture).status({ conversationId: capture.conversationId })).preview.roundIds, []);
});

test('a second active prefix consumes only newly eligible groups and preserves the later raw signatures and tool pairs', async () => {
    const fixture = createFixture({ rounds: 0 });
    appendSteps(fixture, 6);
    await publish(fixture);
    const covered = fixture.port.capture.view.coveredEndSeq;
    appendSteps(fixture, 2);
    const originals = hashContext(fixture.port.items.map(item => fixture.port.contents.get(item.contentId)));
    const capture = await captureCompletedFragments(fixture.port, await fixture.port.inspect(), fixture.config.policy);
    const selected = selectCompactionRounds(capture, fixture.config.policy);
    assert.equal(selected.targets[0].firstSeq, covered + 1);
    assert.equal(selected.retained.length, 1);
    assert.equal(selected.retained[0].itemIds.length, 4);
    assert.ok(selected.targets[0].itemIds.every(itemId => !selected.retained[0].itemIds.includes(itemId)));
    const raw = await readSelectedHistory(fixture.port, capture, selected.retained, fixture.config.policy.readFrameBytes);
    assert.deepEqual(raw.map(item => item.role), ['assistant', 'tool', 'assistant', 'tool']);
    assert.ok(raw.filter(item => item.role === 'assistant').every(item => fixture.port.contents.get(item.contentId).response.blocks[0].native.thoughtSignature));
    await publish(fixture);
    assert.ok(fixture.port.capture.view.coveredEndSeq > covered);
    assert.deepEqual((await controls(fixture).status({ conversationId: capture.conversationId })).preview.roundIds, []);
    assert.equal(originals, hashContext(fixture.port.items.map(item => fixture.port.contents.get(item.contentId))));
});

test('a completed formerly active round joins ordinary compaction while the latest two complete user rounds stay raw', async () => {
    const fixture = createFixture({ rounds: 0 });
    const active = appendSteps(fixture, 6);
    await publish(fixture);
    const covered = fixture.port.capture.view.coveredEndSeq;
    active.complete = true;
    fixture.port.capture.activeRoundId = null;
    for (let ordinal = 0; ordinal < 3; ordinal++) fixture.port.appendRound(`Follow-up user round ${ordinal}`);
    const capture = await captureCompletedFragments(fixture.port, await fixture.port.inspect(), fixture.config.policy);
    const selected = selectCompactionRounds(capture, fixture.config.policy);
    assert.deepEqual(selected.targets.map(round => round.roundId), [active.roundId, 'round-2']);
    assert.equal(selected.targets[0].firstSeq, covered + 1);
    assert.deepEqual(selected.retained.map(round => round.roundId), ['round-3', 'round-4']);
    assert.deepEqual((await controls(fixture).status({ conversationId: capture.conversationId })).preview.roundIds, [active.roundId, 'round-2']);
});

test('an unprepared cursor crossing still reports SOURCE_GAP instead of silently dropping its prefix', () => {
    const fixture = createFixture({ rounds: 3, active: false });
    fixture.port.capture.view.coveredEndSeq = 1;
    assert.throws(() => selectCompactionRounds(fixture.port.capture, fixture.config.policy), error => error.code === 'CONTEXT_SOURCE_GAP');
});

test('manual preview with no newly eligible group returns without starting another candidate', async () => {
    const fixture = createFixture({ rounds: 0 });
    appendSteps(fixture, 6);
    const compactor = await publish(fixture);
    const calls = fixture.model.calls.length;
    const result = await compactor.manual({ conversationId: fixture.port.capture.conversationId, config: fixture.config });
    assert.deepEqual(result.preview.roundIds, []);
    assert.equal(result.handle, null);
    assert.equal(fixture.model.calls.length, calls);
    assert.equal(fixture.port.commits, 1);
});

test('capture rejects a cursor that cuts a native tool pair even with a matching summary node', async () => {
    const fixture = createFixture({ rounds: 0 });
    appendSteps(fixture, 6);
    await publish(fixture);
    fixture.port.capture.view.coveredEndSeq--;
    fixture.port.capture.view.nodes.at(-1).lastSeq--;
    await assert.rejects(captureCompletedFragments(fixture.port, await fixture.port.inspect(), fixture.config.policy),
        error => error.code === 'CONTEXT_SOURCE_GAP');
});

test('capture requires published coverage before accepting a crossing round tail', async () => {
    const fixture = createFixture({ rounds: 0 });
    appendSteps(fixture, 6);
    fixture.port.capture.view.coveredEndSeq = 5;
    await assert.rejects(captureCompletedFragments(fixture.port, await fixture.port.inspect(), fixture.config.policy),
        error => error.code === 'CONTEXT_SOURCE_GAP');
});

test('an earlier blocked round prevents selection without duplicating an eligible active tail', async () => {
    const fixture = createFixture({ rounds: 1, active: false });
    fixture.port.capture.rounds[0].nativePairing = 'pending';
    const active = appendSteps(fixture, 6);
    const capture = await captureCompletedFragments(fixture.port, await fixture.port.inspect(), fixture.config.policy);
    const selected = selectCompactionRounds(capture, fixture.config.policy);
    assert.deepEqual(selected.targets, []);
    assert.equal(selected.retained.filter(round => round.roundId === active.roundId).length, 1);
    assert.deepEqual(selected.retained.at(-1).itemIds, active.itemIds);
});
