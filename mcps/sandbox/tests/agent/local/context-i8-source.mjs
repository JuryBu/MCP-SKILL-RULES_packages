import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { canonicalJson } from '../../../src/agent-server/protocol.ts';
import { MemoryStore } from '../../../src/agent-server/storage/memory.ts';
import { CompatibleChatAdapter, normalizeChatResponse } from '../../../src/agent-server/providers/compatible-chat.ts';
import { ContextFault, ContextService, bootstrapCommunicationWindow, computeContextLimits, createCompressionChunks, createHistorySourcePort, createTaskPlanWorkspaceAdapter, createToolDeliveryStore, hashBytes, hashContext,
    projectToolDelivery, ProviderCompressionModelPort, readCommunicationRendering, renderCommunicationWindow, renderSummary, renderSummaryView, renderTaskPlanSnapshot, sealSummaryNode, validatePublication } from '../../../src/agent-server/context/index.ts';
import { FixturePort, createFixture, fixtureConfig, fixtureModel, ready, estimate } from './context-fixtures.mjs';

function semanticResult(request, result, continued = false) {
    const payload = JSON.parse(request.chunk.body);
    const tail = payload.semanticTail;
    if (!tail) return result;
    return { ...result, digest: { ...result.digest, continuesPrevious: tail.continuesPreviousRequired || continued,
        ...(!tail.continuesPreviousRequired && !continued ? { reorganizedTail: { body: tail.body, skeleton: tail.skeleton, title: tail.title } } : {}) } };
}

function closeActive(port) {
    for (const round of port.capture.rounds) round.complete = true;
    port.capture.activeRoundId = null;
}

function historyContext(port) {
    return { signal: new AbortController().signal,
        readHistory: query => port.readHistory({ ...query, view: 'raw', effectiveOnly: true }),
        readContent: contentId => port.readContent(port.capture.conversationId, contentId) };
}

test('raw bootstrap counts stored rounds rather than repeated user messages within the same round', async () => {
    const config = fixtureConfig({ policy: { communicationWindowSize: 2 } });
    const port = new FixturePort(config);
    port.appendRound('first ordinary topic');
    port.appendRound('second topic first input');
    port.appendItem('second-follow-up', { text: 'second topic additional input' }, { role: 'user', roundId: 'round-2', stepId: 'follow-up-step', kind: 'input_consumed' });
    port.appendItem('second-follow-up-reply', { kind: 'model', protocol: 'compatible_chat', response: {
        complete: true, blocks: [{ type: 'text', text: 'second topic follow-up answer' }], toolCalls: [] } },
    { role: 'assistant', roundId: 'round-2', stepId: 'follow-up-reply', kind: 'model_step', providerProtocol: 'compatible_chat' });
    port.appendRound('third ordinary topic');
    const window = await bootstrapCommunicationWindow({ conversationId: port.capture.conversationId, historyEpoch: 1,
        viewRevision: 0, coveredEndSeq: port.capture.appendSeq, policy: config.policy, history: port,
        sources: createHistorySourcePort(port, { conversationId: port.capture.conversationId }) });
    assert.deepEqual(window.entries.map(entry => entry.roundIds), [['round-2'], ['round-3']]);
    assert.equal(window.entries[0].originals.filter(part => part.role === 'user').length, 2);
    assert.equal(window.entries[0].originals.length, 4);
});

test('real compaction loop sends the old semantic tail, merges continuation, and freezes earlier segments', async () => {
    const fixture = createFixture({ config: fixtureConfig({ policy: { taskPlanManaged: true, keepCompleteRounds: 1 } }) });
    fixture.model.onGenerate = (request, signal, result) => semanticResult(request, result, ['round-2', 'round-4'].includes(request.chunk.roundId));
    const first = (await ready(fixture)).candidate;
    assert.deepEqual(first.nextView.nodes.map(node => node.roundIds), [['round-1', 'round-2'], ['round-3', 'round-4']]);
    assert.equal(JSON.parse(fixture.model.calls[1].chunk.body).semanticTail.nodeId, first.nextView.nodes[0].parentBatchIds[0]);
    await fixture.compactor.publish(fixture.port.capture.conversationId, 14);
    const fixed = structuredClone(fixture.port.capture.view.nodes[0]);
    closeActive(fixture.port);
    fixture.port.appendRound('new ordinary seventh round');
    fixture.port.appendRound('new active eighth round', { active: true });
    fixture.port.capture.execution.roundId = fixture.port.capture.activeRoundId;
    const second = (await ready(fixture)).candidate;
    assert.deepEqual(second.nextView.nodes[0], fixed);
    assert.equal(JSON.parse(fixture.model.calls.find(call => call.chunk.roundId === 'round-5').chunk.body).semanticTail.body, first.nextView.nodes.at(-1).body);
    assert.equal(second.nextView.coveredEndSeq, 12);
    assert.ok(second.nextView.renderedLevels.length);
});

test('the real 50434 fixed-input receipt permits background compaction below hard capacity despite an unreachable target', async () => {
    const fixture = createFixture({ rounds: 5 });
    fixture.model.onGenerate = (request, signal, result) => semanticResult(request, result);
    const limits = computeContextLimits(65536, 2048, fixture.config.policy);
    assert.equal(limits.target, 39321);
    assert.equal(limits.inputBudget, 58982);
    const estimator = async (snapshot, summary) => ({ estimate: estimate(50434 + summary.tokens),
        nativeViewHash: hashContext(summary.text), modelId: fixtureModel.model, adapterVersion: fixtureModel.adapterVersion });
    const handle = await fixture.compactor.start({ conversationId: fixture.port.capture.conversationId,
        execution: fixture.port.capture.execution, config: fixture.config, reason: 'background', limits, estimateCompaction: estimator });
    const candidate = await handle.completion;
    assert.equal(candidate.snapshot.requestBudget.summaryBudget, 8547);
    assert.equal(candidate.state, 'ready');
    assert.ok(fixture.model.calls.length >= 2);
    assert.equal(candidate.nextView.fitEvidence.targetReached, false);
    assert.equal(candidate.nextView.fitEvidence.optimizationStoppedAtMinimum, false);
    assert.ok(candidate.nextView.fitEvidence.inputTokens < limits.inputBudget);
    assert.match(renderSummaryView(candidate.nextView, fixture.config.policy, candidate.nextView.summaryBudget).text, /fixture digest/);
    assert.ok(candidate.nextView.communicationWindow.entries.length);
    await fixture.compactor.publish(fixture.port.capture.conversationId, 14);
    assert.equal(fixture.port.capture.view.revision, 1);
});

test('empty text source headers split with the same budget checks as nonempty text', async () => {
    const fixture = createFixture({ rounds: 4, text: ordinal => ordinal === 1 ? 'ordinary source text '.repeat(900) : `source ${ordinal}`,
        config: fixtureConfig({ policy: { chunkInputTokens: 4000, referenceTokens: 100, keepCompleteRounds: 1 } }) });
    const item = fixture.port.items.find(entry => entry.itemId === 'model-1');
    const value = { kind: 'model', protocol: 'compatible_chat', response: { complete: true, toolCalls: [],
        blocks: Array.from({ length: 40 }, () => ({ type: 'text', text: '' })) } };
    fixture.port.contents.set(item.contentId, value);
    const bytes = Buffer.from(canonicalJson(value));
    item.objectRef = { hash: hashBytes(bytes), rawBytes: bytes.length };
    fixture.port.capture.historyRoot = hashContext(fixture.port.items.map(entry => [entry.itemId, entry.objectRef.hash]));
    fixture.model.onGenerate = (request, signal, result) => semanticResult(request, result);
    const candidate = (await ready(fixture)).candidate;
    assert.equal(candidate.state, 'ready', JSON.stringify(candidate.error));
    assert.ok(fixture.model.calls.every(call => call.chunk.inputTokens <= 4000));
    assert.equal(candidate.chunks.flatMap(chunk => chunk.sourceSpans).filter(span => span.itemId === item.itemId && span.startByte === span.endByte).length, 40);
});

test('unsent local preprocessing failure stays failed and never becomes the remote-unknown business gate', async () => {
    const fixture = createFixture({ config: fixtureConfig({ rules: 'oversized fixed rules '.repeat(12000) }) });
    const candidate = (await ready(fixture)).candidate;
    assert.equal(candidate.state, 'failed');
    assert.equal(candidate.pendingRequest, null);
    assert.equal(candidate.error.code, 'CONTEXT_CONFIG_INVALID');
    assert.equal(candidate.error.mayHaveStarted, false);
    assert.equal(fixture.model.calls.length, 0);
    const state = await fixture.compactor.context(fixture.port.capture.conversationId);
    assert.equal(state.scheduler.state, 'circuitBroken');
    fixture.port.checkpoints.set(fixture.port.capture.conversationId, { ...state.scheduler, state: 'hardPaused' });
    const allowed = await fixture.compactor.beforeRequest({ conversationId: fixture.port.capture.conversationId,
        execution: fixture.port.capture.execution, config: fixture.config, stepSeq: 14,
        limits: computeContextLimits(fixtureModel.contextWindow, fixtureModel.maxOutputTokens, fixture.config.policy), estimate: async () => estimate(1) });
    assert.equal(allowed.inputTokens, 1);
    assert.equal((await fixture.compactor.context(fixture.port.capture.conversationId)).scheduler.state, 'circuitBroken');
    const unknown = createFixture();
    unknown.model.onGenerate = () => { throw new ContextFault('ATTEMPT_UNKNOWN', 'Original request remains genuinely unresolved', {}, true); };
    await assert.rejects(ready(unknown), /genuinely unresolved/);
    assert.ok([...unknown.port.candidates.values()][0].pendingRequest);
    await assert.rejects(unknown.compactor.beforeRequest({ conversationId: unknown.port.capture.conversationId,
        execution: unknown.port.capture.execution, config: unknown.config, stepSeq: 14,
        limits: computeContextLimits(fixtureModel.contextWindow, fixtureModel.maxOutputTokens, unknown.config.policy), estimate: async () => estimate(1) }),
    error => error.code === 'CONTEXT_ATTEMPT_UNKNOWN');
    assert.equal(unknown.model.calls.length, 1);
});

test('subchunks of a single real round always carry and replace their preceding semantic subchunk', async () => {
    const fixture = createFixture({ rounds: 4, text: ordinal => ordinal === 1 ? 'ordinary long text '.repeat(900) : `round ${ordinal}`,
        config: fixtureConfig({ policy: { taskPlanManaged: true, keepCompleteRounds: 1, chunkInputTokens: 6000, referenceTokens: 200 } }) });
    fixture.model.onGenerate = (request, signal, result) => semanticResult(request, result);
    const candidate = (await ready(fixture)).candidate;
    const firstRound = fixture.model.calls.filter(call => call.chunk.roundId === 'round-1');
    assert.ok(firstRound.length > 1);
    assert.ok(firstRound.slice(1).every(call => JSON.parse(call.chunk.body).semanticTail.continuesPreviousRequired));
    assert.equal(candidate.nextView.nodes.filter(node => node.roundIds.includes('round-1')).length, 1);
    assert.equal(new Set(candidate.nextView.nodes[0].chunkIds).size, firstRound.length);
});

test('incremental compaction reads only pre-target references and preserves the earlier published prefix', async () => {
    const fixture = createFixture({ config: fixtureConfig({ policy: { keepCompleteRounds: 1 } }) });
    fixture.model.onGenerate = (request, signal, result) => semanticResult(request, result);
    const first = (await ready(fixture)).candidate;
    await fixture.compactor.publish(fixture.port.capture.conversationId, 14);
    const originalNodes = structuredClone(fixture.port.capture.view.nodes);
    closeActive(fixture.port);
    fixture.port.appendRound('Retained future correction must stay in the current raw tail.');
    fixture.port.appendRound('new active user round', { active: true });
    fixture.port.capture.execution.roundId = fixture.port.capture.activeRoundId;
    const second = (await ready(fixture)).candidate;
    assert.equal(second.state, 'ready');
    assert.deepEqual(second.coverage.gaps, []);
    assert.ok(second.snapshot.referenceBlocks.length > 0);
    assert.ok(second.snapshot.referenceBlocks.every(block => block.seq < second.snapshot.coveredStartSeq));
    for (const request of fixture.model.calls.filter(call => call.snapshot.parentViewRevision === first.nextView.revision)) {
        const payload = JSON.parse(request.chunk.body);
        assert.ok(payload.semanticTail);
        assert.ok(payload.references.every(part => second.snapshot.referenceBlocks.some(block => block.itemId === part.span.itemId
            && block.blockId === part.span.blockId && block.seq < second.snapshot.coveredStartSeq)));
        assert.ok(payload.references.every(part => !part.text.includes('Retained future correction')));
    }
    assert.deepEqual(second.nextView.nodes.slice(0, originalNodes.length), originalNodes);
    await fixture.compactor.publish(fixture.port.capture.conversationId, 18);
    assert.deepEqual(fixture.port.capture.view.nodes.slice(0, originalNodes.length), originalNodes);
    const futureItem = fixture.port.items.find(item => item.itemId === 'user-7');
    const futureBlocks = await fixture.sources.describe(futureItem);
    const preserved = structuredClone(second.snapshot);
    preserved.referenceBlocks = structuredClone(futureBlocks);
    const referenceHash = hashContext(preserved.referenceBlocks);
    const chunks = createCompressionChunks({ snapshot: preserved, sources: fixture.sources, signal: new AbortController().signal });
    const chunk = await chunks.next();
    await chunks.return();
    assert.deepEqual(JSON.parse(chunk.value.body).references, []);
    assert.equal(hashContext(preserved.referenceBlocks), referenceHash);
    assert.ok(fixture.port.contents.has(futureItem.contentId));
});

test('communication windows filter invisible assistant text across bootstrap and incremental publication without changing source coverage', async () => {
    const fixture = createFixture();
    for (const [ordinal, text] of [[1, ''], [2, ' \r\n\t']]) {
        const item = fixture.port.items.find(entry => entry.itemId === `model-${ordinal}`);
        const value = structuredClone(fixture.port.contents.get(item.contentId));
        value.response.blocks[0].text = text;
        fixture.port.contents.set(item.contentId, value);
        const bytes = Buffer.from(canonicalJson(value));
        item.objectRef = { hash: hashBytes(bytes), rawBytes: bytes.length };
    }
    fixture.port.capture.historyRoot = hashContext(fixture.port.items.map(entry => [entry.itemId, entry.objectRef.hash]));
    fixture.model.onGenerate = (request, signal, result) => semanticResult(request, result);
    const first = (await ready(fixture)).candidate;
    assert.equal(first.state, 'ready');
    assert.deepEqual(first.coverage.gaps, []);
    for (const itemId of ['model-1', 'model-2']) assert.ok(first.chunks.some(chunk => chunk.sourceSpans.some(span =>
        span.itemId === itemId && span.blockId === 'response.blocks.0.text' && span.purpose === 'target')));
    const clean = first.nextView.communicationWindow;
    assert.equal(clean.entries.length, 3);
    assert.equal(clean.entries.flatMap(entry => entry.originals).filter(part => part.role === 'user').length, 3);
    assert.deepEqual(clean.entries.flatMap(entry => entry.originals).filter(part => part.role === 'assistant').map(part => part.itemId), ['model-3']);
    const bootstrapped = await bootstrapCommunicationWindow({ conversationId: fixture.port.capture.conversationId, historyEpoch: 1,
        viewRevision: 0, coveredEndSeq: first.nextView.coveredEndSeq, policy: fixture.config.policy, history: fixture.port, sources: fixture.sources });
    assert.deepEqual(bootstrapped.entries.flatMap(entry => entry.originals).filter(part => part.role === 'assistant').map(part => part.itemId), ['model-3']);
    const { hash: ignoredHash, ...legacyContent } = structuredClone(clean);
    legacyContent.entries[0].originals.push({ itemId: 'legacy-empty-assistant', blockId: 'response.blocks.0.text', seq: 2,
        role: 'assistant', text: '', complete: true, byteLength: 0, sha256: hashBytes(''), retrieval: { contentId: 'legacy-empty-original' } });
    const legacy = { ...legacyContent, hash: hashContext(legacyContent) };
    assert.equal(renderCommunicationWindow(legacy), renderCommunicationWindow(clean));
    const frozenText = 'Previously delivered prefix remains fixed until explicit publication.';
    assert.equal(readCommunicationRendering(legacy, { windowHash: legacy.hash, text: frozenText, hash: hashBytes(frozenText), mode: 'originals' }), frozenText);
    await fixture.compactor.publish(fixture.port.capture.conversationId, 14);
    fixture.port.capture.view.communicationWindow = legacy;
    closeActive(fixture.port);
    fixture.port.appendRound('new visible user input');
    fixture.port.appendRound('new active input', { active: true });
    fixture.port.capture.execution.roundId = fixture.port.capture.activeRoundId;
    const next = (await ready(fixture)).candidate;
    assert.deepEqual(next.coverage.gaps, []);
    assert.ok(next.nextView.communicationWindow.entries.flatMap(entry => entry.originals).every(part => part.itemId !== 'legacy-empty-assistant'));
    assert.ok(next.nextView.communicationWindow.entries.flatMap(entry => entry.originals).some(part => part.itemId === 'user-1'));
});

test('K=10 window counts semantic exchanges, retains actual originals, and only enters the newly compressed delta', async () => {
    const fixture = createFixture({ rounds: 14,
        config: fixtureConfig({ policy: { taskPlanManaged: true, keepCompleteRounds: 1, communicationTextChars: 4096 } }) });
    fixture.model.onGenerate = (request, signal, result) => semanticResult(request, result);
    const first = (await ready(fixture)).candidate;
    const oldWindow = first.nextView.communicationWindow;
    assert.equal(oldWindow.entries.length, 10);
    const sent = renderSummaryView(first.nextView, fixture.config.policy, first.nextView.summaryBudget);
    assert.equal(sent.communicationRendering.mode, 'originals');
    assert.ok(sent.text.endsWith(renderCommunicationWindow(oldWindow)));
    assert.deepEqual(oldWindow.entries.map(entry => entry.roundIds), Array.from({ length: 10 }, (_, index) => [`round-${index + 3}`]));
    assert.ok(oldWindow.entries.every(entry => entry.originals.some(part => part.role === 'user' && part.text.startsWith('normal fixture input'))));
    assert.ok(oldWindow.entries.every(entry => entry.originals.every(part => part.role !== 'tool')));
    await fixture.compactor.publish(fixture.port.capture.conversationId, 40);
    closeActive(fixture.port);
    fixture.port.appendRound('new original entering the compressed range');
    fixture.port.appendRound('active latest original', { active: true });
    fixture.port.capture.execution.roundId = fixture.port.capture.activeRoundId;
    const second = (await ready(fixture)).candidate;
    const window = second.nextView.communicationWindow;
    assert.deepEqual(window.entries.map(entry => entry.roundIds), Array.from({ length: 10 }, (_, index) => [`round-${index + 5}`]));
    assert.deepEqual(window.entries[0], oldWindow.entries[2]);
    assert.match(renderCommunicationWindow(window), /original.*read=history_read/s);
    assert.equal(window.hash, hashContext((({ hash, ...content }) => content)(window)));
});

test('tool originals persist once and their first shortened delivery stays byte-stable on replay', async () => {
    const store = new MemoryStore();
    const deliveries = createToolDeliveryStore(store);
    const identity = { conversationId: 'tool-window-fixture', runId: 'fixture-run', runEpoch: 1, stepId: 'fixture-step', callId: 'fixture-call' };
    const original = { callId: identity.callId, name: 'commands.run', result: { state: 'succeeded', exitCode: 0, stdout: 'head\n' + 'long log '.repeat(5000) + '\ntail', stderr: '' } };
    const first = await deliveries.preserve(identity, original, { maxTextChars: 256, upstreamCompleteness: 'partial' });
    assert.equal(first.shortened, true);
    assert.match(first.sent.result.stdout, /工具发送短版/);
    assert.match(first.sent.result.stdout, /上游完整性=partial/);
    assert.equal(first.sent.result.exitCode, 0);
    const replay = await deliveries.preserve(identity, original, { maxTextChars: 30000 });
    assert.deepEqual(replay, first);
    let bytes = Buffer.alloc(0);
    for (let offset = 0;;) {
        const page = await store.readArtifact({ conversationId: identity.conversationId, artifactId: first.source.artifactId, offset, maxBytes: 1024 });
        bytes = Buffer.concat([bytes, Buffer.from(page.dataBase64, 'base64')]);
        if (page.complete) break;
        offset = page.nextOffset;
    }
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), original);
    assert.equal(hashBytes(bytes), first.source.sha256);
    await assert.rejects(deliveries.preserve(identity, { ...original, result: { changed: true } }), /原件不同/);
});

test('explicit original-history pages and structured receipts remain complete', () => {
    const source = { artifactId: 'fixture-source', sha256: '0'.repeat(64), byteLength: 40000, receivedComplete: true, upstreamCompleteness: 'complete' };
    const page = { callId: 'page-call', name: 'history.read', result: 'original page '.repeat(5000) };
    assert.deepEqual(projectToolDelivery(page, source, { maxTextChars: 256 }), { sent: page, shortened: false });
    const receipt = { callId: 'receipt-call', name: 'ordinary_task', result: { taskId: 'fixture-task', state: 'pending', error: { message: 'keep' }, nextCursor: 'fixture-cursor', text: 'receipt '.repeat(5000) } };
    assert.deepEqual(projectToolDelivery(receipt, source, { maxTextChars: 256 }), { sent: receipt, shortened: false });
    const contentArray = { callId: 'mcp-array-call', name: 'ordinary_mcp_array', result: { ok: true, data: [{ type: 'text', text: 'MCP content text '.repeat(1000) }, { type: 'resource', resource: { uri: 'fixture:original' } }] } };
    const projected = projectToolDelivery(contentArray, source, { maxTextChars: 256 });
    assert.match(projected.sent.result.data[0].text, /工具发送短版/);
    assert.deepEqual(projected.sent.result.data[1], contentArray.result.data[1]);
});

test('provider digest ignores task-state output even before entity Task/Plan takes over legacy display', () => {
    const model = new ProviderCompressionModelPort({});
    const request = { attemptId: 'semantic-request', inputBodyHash: 'fixture-body', reason: 'background',
        snapshot: { effectiveModelFingerprint: 'fixture-model', config: { policy: { taskPlanManaged: false } } },
        chunk: { body: JSON.stringify({ semanticTail: { nodeId: 'old-tail', continuesPreviousRequired: false }, targets: [] }), inputBodyHash: 'fixture-body', sourceSpans: [] } };
    const response = digest => ({ attemptId: 'semantic-provider', complete: true, stop: { kind: 'completed' }, toolCalls: [], problems: [], usage: {},
        blocks: [{ type: 'text', text: JSON.stringify(digest) }] });
    const digest = { body: 'combined factual text', skeleton: 'combined factual index', title: 'same discussion', continuesPrevious: true,
        unresolved: [{ quote: 'model attempts task ownership' }], resolutions: [{ status: 'fulfilled', requirementId: 'fabricated' }] };
    const result = model.result(request, response(digest), { bodyHash: 'fixture-body' });
    assert.equal(result.complete, true);
    assert.equal(result.digest.continuesPrevious, true);
    assert.deepEqual(result.digest.unresolved, []);
    assert.equal(result.digest.resolutions, undefined);
    const missingReorganization = model.result(request, response({ ...digest, continuesPrevious: false }), { bodyHash: 'fixture-body' });
    assert.equal(missingReorganization.complete, false);
    const replacement = model.result(request, response({ ...digest, continuesPrevious: false,
        reorganizedTail: { body: 'old discussion kept', skeleton: 'old index', title: 'previous topic' } }), { bodyHash: 'fixture-body' });
    assert.equal(replacement.complete, true);
    assert.equal(replacement.digest.reorganizedTail.body, 'old discussion kept');
});

test('real compaction preserves legacy task records read-only before and after entity takeover', async () => {
    for (const { taskPlanManaged, continuesPrevious } of [false, true].flatMap(taskPlanManaged =>
        [false, true].map(continuesPrevious => ({ taskPlanManaged, continuesPrevious })))) {
        const quote = 'Keep the unfinished report until the main model reconciles its Task and Plan originals.';
        const fixture = createFixture({ text: ordinal => ordinal === 1 ? quote : `new factual input ${ordinal}`,
            config: fixtureConfig({ policy: { taskPlanManaged } }) });
        const user = fixture.port.items[0];
        const block = (await fixture.sources.describe(user))[0];
        const source = { itemId: user.itemId, blockId: block.blockId, startByte: 0, endByte: Buffer.byteLength(quote),
            sha256: hashBytes(quote), blockHash: block.sha256, purpose: 'target' };
        const requirement = { id: 'legacy-unfinished-report', quote, source };
        const node = sealSummaryNode({ kind: 'batch', nodeId: 'legacy-report-handoff', firstSeq: 1, lastSeq: 2, roundIds: ['round-1'],
            sourceSpans: [source], chunkIds: [], parentBatchIds: [], anchors: [], modelFingerprint: fixture.config.modelFingerprint,
            body: 'The report remains unfinished.', skeleton: 'Unfinished report.', title: 'Legacy report', unresolved: [requirement] });
        fixture.port.capture.viewRevision = 1;
        fixture.port.capture.view = { revision: 1, historyEpoch: 1, coveredEndSeq: 2, nodes: [node] };
        fixture.model.onGenerate = (request, signal, result) => {
            const output = semanticResult(request, { ...result, digest: { ...result.digest,
                unresolved: [{ id: 'new-compressor-owned-task', quote: 'Invented task state', source }],
                resolutions: [{ requirementId: requirement.id, status: 'fulfilled', resolvedQuote: quote, evidence: [] }] } }, continuesPrevious);
            if (output.digest.reorganizedTail) output.digest.reorganizedTail.unresolved = [];
            return output;
        };
        const candidate = (await ready(fixture)).candidate;
        assert.equal(candidate.state, 'ready');
        assert.deepEqual(candidate.nextView.nodes.flatMap(entry => entry.unresolved), [requirement]);
        assert.ok(candidate.chunks.every(chunk => !chunk.digest.unresolved.length && chunk.digest.resolutions === undefined));
        assert.deepEqual(fixture.port.capture.view.nodes, [node]);
        assert.ok(fixture.model.calls.every(call => {
            const payload = JSON.parse(call.chunk.body);
            return payload.taskStateOwner === 'main_model' && payload.legacyRequirementsReadOnly === true
                && payload.taskPlanManaged === taskPlanManaged && /Never create, edit or resolve task state/.test(payload.rules);
        }));
        const text = renderSummary(candidate.nextView.nodes, fixture.config.policy).text;
        assert.equal(text.includes('Unresolved requirements (verbatim):'), !taskPlanManaged);
        if (!taskPlanManaged) assert.ok(text.includes(quote) && text.includes('Read-only legacy task handoff'));
        await fixture.compactor.publish(fixture.port.capture.conversationId, 14);
        assert.deepEqual(fixture.port.capture.view.nodes.flatMap(entry => entry.unresolved), [requirement]);
    }
});

test('unknown recovery and no-plan QA compaction never acquire task-state ownership', async () => {
    const fixture = createFixture();
    let first = true;
    fixture.model.onGenerate = (request, signal, result) => {
        const output = semanticResult(request, { ...result, digest: { ...result.digest,
            unresolved: [{ id: 'new-compressor-owned-task', quote: 'A simple answer needs no extra task table.' }],
            resolutions: [{ requirementId: 'legacy', status: 'fulfilled' }] } });
        if (first) {
            first = false;
            fixture.model.results.set(request.attemptId, structuredClone(output));
            throw new ContextFault('ATTEMPT_UNKNOWN', 'Fixture response awaits original-attempt lookup', {}, true);
        }
        return output;
    };
    const handle = await fixture.compactor.start({ conversationId: fixture.port.capture.conversationId,
        execution: fixture.port.capture.execution, config: fixture.config, reason: 'background' });
    await assert.rejects(handle.completion, /original-attempt lookup/);
    assert.equal(fixture.port.candidates.get(handle.candidateId).state, 'unknown');
    const resumed = await fixture.compactor.recover(fixture.port.capture.conversationId, handle.candidateId);
    const candidate = resumed.completion ? await resumed.completion : resumed;
    assert.equal(candidate.state, 'ready');
    assert.equal(fixture.model.lookups.length, 1);
    assert.ok(candidate.chunks.every(chunk => !chunk.digest.unresolved.length && chunk.digest.resolutions === undefined));
    assert.deepEqual(candidate.nextView.nodes.flatMap(node => node.unresolved), []);
    assert.doesNotMatch(renderSummary(candidate.nextView.nodes, fixture.config.policy).text, /Unresolved requirements/);
});

test('raw is durably readable before image transformation, nested data/text are shortened, and replay never transforms again', async () => {
    const store = new MemoryStore();
    const deliveries = createToolDeliveryStore(store);
    const identity = { conversationId: 'raw-before-image-fixture', runId: 'fixture-run', runEpoch: 1, stepId: 'fixture-step', callId: 'fixture-image-call' };
    const original = { callId: identity.callId, name: 'ordinary_mcp', result: { ok: true, data: {
        taskId: 'fixture-task', stdout: 'nested log '.repeat(2000), error: { code: 'KEEP_RECEIPT' },
        content: [{ type: 'text', text: 'MCP text '.repeat(2000) }, { type: 'image', data: 'fixture-base64-original', mimeType: 'image/png' }] } } };
    let transformations = 0;
    const transform = async raw => {
        transformations++;
        const artifactId = `context:tool-original:${hashContext(identity)}:${hashContext(original)}`;
        const source = await store.readArtifact({ conversationId: identity.conversationId, artifactId, offset: 0, maxBytes: 1 });
        assert.equal(source.sha256, hashContext(original));
        const content = raw.result.data.content;
        content[1] = { type: 'image', assetRef: 'fixture-image-ref', mimeType: 'image/png' };
        await wait(5);
        return raw;
    };
    const [first, second] = await Promise.all([deliveries.preserve(identity, original, { maxTextChars: 256 }, transform),
        deliveries.preserve(identity, original, { maxTextChars: 256 }, transform)]);
    assert.equal(transformations, 1);
    assert.deepEqual(first, second);
    assert.match(first.sent.result.data.stdout, /工具发送短版/);
    assert.match(first.sent.result.data.content[0].text, /工具发送短版/);
    assert.equal(first.sent.result.data.content[1].assetRef, 'fixture-image-ref');
    assert.equal(first.sent.result.data.content[1].data, undefined);
    assert.equal(first.sent.result.data.error.code, 'KEEP_RECEIPT');
    assert.equal(first.sent.result.data.taskId, 'fixture-task');
    assert.equal(first.receivedHash, hashContext(original));
    assert.match(first.sent.result.data.stdout, new RegExp(first.source.artifactId));
    await deliveries.preserve(identity, original, {}, async () => { throw new Error('replay must not transform'); });
    await assert.rejects(deliveries.read(identity, first.sent), /原件不同/);
    const page = { callId: 'page', name: 'shared_page', result: { ok: true, data: { nextOffset: null, text: 'complete original '.repeat(2000) } } };
    assert.deepEqual(projectToolDelivery(page, first.source, { maxTextChars: 256 }), { sent: page, shortened: false });
});

test('ContextService actually uses the same stable tool delivery before native replay', async () => {
    const port = new FixturePort();
    const stepId = 'tool-model-step';
    port.appendItem('tool-user', { text: 'run an ordinary tool' }, { role: 'user', roundId: 'tool-round', stepId: 'user-step', kind: 'input_consumed' });
    const response = normalizeChatResponse('tool-attempt', { httpStatus: 200, headers: {}, json: { model: fixtureModel.model,
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'large-tool-call', type: 'function', function: { name: 'commands.run', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] } });
    port.appendItem('tool-model', { kind: 'model', protocol: 'compatible_chat', response }, { role: 'assistant', roundId: 'tool-round', stepId, kind: 'model_step', providerProtocol: 'compatible_chat' });
    const result = { callId: 'large-tool-call', name: 'commands.run', result: 'large output '.repeat(2000) };
    const deliveries = createToolDeliveryStore(new MemoryStore());
    const saved = await deliveries.preserve({ conversationId: port.capture.conversationId, runId: port.capture.execution.runId,
        runEpoch: port.capture.execution.runEpoch, stepId, callId: result.callId }, result, { maxTextChars: 256 });
    port.appendItem('tool-result', { kind: 'tool', result: saved.sent }, { role: 'tool', roundId: 'tool-round', stepId, callId: result.callId, kind: 'tool_step', providerProtocol: 'compatible_chat' });
    const service = new ContextService({ readToolDelivery: deliveries.read,
        preserveToolResult: async () => { throw new Error('production sent history must reuse the persisted delivery'); } });
    const input = { conversationId: port.capture.conversationId, context: historyContext(port), adapter: new CompatibleChatAdapter(), modelId: fixtureModel.model, baseView: { protocol: 'compatible_chat', messages: [] } };
    const first = await service.buildView(input);
    const second = await service.buildView(input);
    assert.deepEqual(first.view, second.view);
    assert.match(first.view.messages.at(-1).content, /工具发送短版/);
    assert.deepEqual(port.contents.get('tool-result-content').result, saved.sent);
});

test('main-model Task/Plan writes actual port originals, verifies versions, and injects their current state at the request tail', async () => {
    const files = new Map();
    const workspace = createTaskPlanWorkspaceAdapter({
        async read({ path }) { return structuredClone(files.get(path) ?? null); },
        async write({ path, text, expectedSha256 }) {
            if ((files.get(path)?.sha256 ?? null) !== expectedSha256) throw new Error('fixture version conflict');
            const file = { path, text, sha256: hashBytes(text) };
            files.set(path, file);
            return structuredClone(file);
        },
    });
    const scope = { conversationId: 'fixture-conversation', taskId: 'fixture-task', directory: '.sandbox-agent/fixture-task', workKind: 'multi_step' };
    assert.equal((await workspace.read(scope)).planRequired, true);
    const plan = await workspace.execute(scope, 'task_plan_write', { document: 'plan', text: '# Plan\n- Implement\n- Verify', expectedSha256: null });
    await workspace.write(scope, { document: 'task', text: '# Task\n- [ ] Verify original source', expectedSha256: null });
    await assert.rejects(workspace.write(scope, { document: 'plan', text: 'stale overwrite', expectedSha256: null }), /version conflict/);
    assert.equal((await workspace.read({ ...scope, workKind: 'simple_qa' })).planRequired, false);
    assert.equal((await workspace.read({ ...scope, workKind: 'single_image' })).planRequired, false);
    const port = new FixturePort();
    port.appendItem('task-user', { text: 'ordinary multi-step work' }, { role: 'user', roundId: 'task-round', stepId: 'task-user-step', kind: 'input_consumed' });
    const service = new ContextService();
    const baseView = { protocol: 'compatible_chat', messages: [{ role: 'system', content: 'stable common rules' }] };
    const first = await service.buildView({ conversationId: scope.conversationId, context: historyContext(port), adapter: new CompatibleChatAdapter(), modelId: fixtureModel.model, baseView,
        dynamicContext: async () => renderTaskPlanSnapshot(await workspace.read(scope)) });
    assert.equal(first.view.messages[0].content, 'stable common rules');
    assert.equal(first.view.messages[1].content, 'ordinary multi-step work');
    assert.match(first.view.messages.at(-1).content, /workspace original.*Plan.md/s);
    assert.match(first.view.messages.at(-1).content, /\[ \] Verify original source/);
    await workspace.write(scope, { document: 'plan', text: '# Plan\n- Verified original', expectedSha256: plan.sha256 });
    const second = await service.buildView({ conversationId: scope.conversationId, context: historyContext(port), adapter: new CompatibleChatAdapter(), modelId: fixtureModel.model, baseView,
        dynamicContext: async () => renderTaskPlanSnapshot(await workspace.read(scope)) });
    assert.deepEqual(first.view.messages.slice(0, -1), second.view.messages.slice(0, -1));
    assert.match(second.view.messages.at(-1).content, /Verified original/);
});

test('useful history promotes detail at the next actual publication and its frozen levels are replayed', async () => {
    const config = fixtureConfig({ policy: { keepCompleteRounds: 1, stableHeadBatches: 1, stableTailBatches: 1, middleSkeletonBatches: 1 } });
    const fixture = createFixture({ rounds: 8, config });
    let feedback = { historyEpoch: 1, revision: 0, entries: [] };
    fixture.port.readHistoryFeedback = async () => structuredClone(feedback);
    fixture.model.onGenerate = (request, signal, result) => semanticResult(request, result);
    const candidate = (await ready(fixture)).candidate;
    const target = candidate.nextView.nodes[1];
    assert.equal(candidate.nextView.renderedLevels.find(entry => entry.nodeId === target.nodeId).level, 'title');
    feedback = { historyEpoch: 1, revision: 1, entries: [{ target: { kind: 'node', id: target.nodeId }, hitCount: 3, lastHitStep: 20, feedbackRevision: 1 }] };
    await fixture.compactor.publish(fixture.port.capture.conversationId, 20);
    const published = fixture.port.capture.view;
    assert.equal(published.renderedLevels.find(entry => entry.nodeId === target.nodeId).level, 'body');
    const rendered = renderSummary(published.nodes, config.policy, Number.MAX_SAFE_INTEGER, undefined, published.renderedLevels);
    const later = renderSummary(published.nodes, { ...config.policy, middleSkeletonBatches: 0 }, Number.MAX_SAFE_INTEGER, undefined, published.renderedLevels);
    assert.equal(rendered.text, later.text);
    const service = new ContextService();
    const built = await service.buildView({ conversationId: fixture.port.capture.conversationId, context: {
        signal: new AbortController().signal, readContent: async () => { throw new Error('covered originals must not reload'); },
        readHistory: async () => ({ historyEpoch: published.historyEpoch, appendSeq: published.coveredEndSeq,
            viewRevision: published.revision, items: [], hasMore: false, nextCursor: null }) },
        adapter: new CompatibleChatAdapter(), modelId: fixtureModel.model, summaryView: published,
        policy: { ...config.policy, middleSkeletonBatches: 0 }, baseView: { protocol: 'compatible_chat', messages: [] } });
    assert.ok(built.view.messages[0].content.startsWith(rendered.text));
    assert.match(built.view.messages[0].content, /Communication originals/);
});

test('cancelled unknown recovery settles only its original attempt and never regenerates or publishes it', async () => {
    const fixture = createFixture();
    let release;
    const paused = new Promise(resolve => { release = resolve; });
    fixture.model.cancelStatus = 'unknown';
    fixture.model.onGenerate = async (request, signal, result) => { await paused; return semanticResult(request, result); };
    const handle = await fixture.compactor.start({ conversationId: fixture.port.capture.conversationId, execution: fixture.port.capture.execution, config: fixture.config, reason: 'background' });
    while (!fixture.model.calls.length) await wait(1);
    const cancellation = await fixture.compactor.cancel(fixture.port.capture.conversationId, { human: false });
    assert.equal(cancellation.state, 'unknown');
    release();
    await handle.completion.catch(() => {});
    const recovered = await fixture.compactor.recover(fixture.port.capture.conversationId, handle.candidateId);
    assert.equal(recovered.state, 'discarded');
    assert.equal(recovered.pendingRequest, null);
    assert.equal(fixture.model.calls.length, 1);
    assert.equal(fixture.port.commits, 0);
    assert.equal(fixture.port.capture.candidateId, null);
    assert.equal((await fixture.compactor.context(fixture.port.capture.conversationId)).scheduler.state, 'idle');
});

test('a safe request does not wait for BPC just because the old fixed replacement step passed', async () => {
    const fixture = createFixture();
    let release;
    const paused = new Promise(resolve => { release = resolve; });
    fixture.model.onGenerate = async (request, signal, result) => { await paused; return semanticResult(request, result); };
    const handle = await fixture.compactor.start({ conversationId: fixture.port.capture.conversationId, execution: fixture.port.capture.execution, config: fixture.config, reason: 'background' });
    while (!fixture.model.calls.length) await wait(1);
    const limits = computeContextLimits(fixtureModel.contextWindow, fixtureModel.maxOutputTokens, fixture.config.policy);
    try {
        const result = await Promise.race([fixture.compactor.beforeRequest({ conversationId: fixture.port.capture.conversationId, execution: fixture.port.capture.execution,
            config: fixture.config, stepSeq: 100000, limits, estimate: async () => estimate(1) }), wait(250).then(() => { throw new Error('waited on fixed BPC step'); })]);
        assert.equal(result.inputTokens, 1);
        await fixture.compactor.cancel(fixture.port.capture.conversationId, { human: false });
    } finally { release(); await handle.completion.catch(() => {}); }
});

test('hard takeover retains the old unknown attempt and late completion cannot replace the new published view', async () => {
    const fixture = createFixture();
    fixture.port.revokeCandidatePublication = async candidate => {
        fixture.port.candidates.set(candidate.candidateId, structuredClone(candidate));
        if (fixture.port.capture.candidateId === candidate.candidateId) fixture.port.capture.candidateId = null;
    };
    let release;
    const paused = new Promise(resolve => { release = resolve; });
    let first = true;
    fixture.model.cancelStatus = 'unknown';
    fixture.model.onGenerate = async (request, signal, result) => {
        if (first) { first = false; await paused; }
        return semanticResult(request, result);
    };
    const handle = await fixture.compactor.start({ conversationId: fixture.port.capture.conversationId, execution: fixture.port.capture.execution, config: fixture.config, reason: 'background' });
    while (!fixture.model.calls.length) await wait(1);
    const limits = computeContextLimits(fixtureModel.contextWindow, fixtureModel.maxOutputTokens, fixture.config.policy);
    try {
        await fixture.compactor.beforeRequest({ conversationId: fixture.port.capture.conversationId, execution: fixture.port.capture.execution,
            config: fixture.config, stepSeq: 18, limits,
            estimate: async () => estimate(fixture.port.capture.view.coveredEndSeq ? 1 : limits.inputBudget + 1) });
        const retained = fixture.port.candidates.get(handle.candidateId);
        assert.equal(retained.state, 'unknown');
        assert.equal(retained.publicationRevoked.reason, 'hard_takeover');
        assert.ok(retained.pendingRequest.attemptId);
        const current = structuredClone(fixture.port.capture.view);
        release();
        await handle.completion.catch(() => {});
        assert.deepEqual(fixture.port.capture.view, current);
        assert.deepEqual(fixture.port.candidates.get(handle.candidateId), retained);
        assert.throws(() => validatePublication(retained, fixture.port.capture, retained.snapshot.sourcePrefixHash), /资格已经撤销/);
    } finally { release(); await handle.completion.catch(() => {}); }
});
