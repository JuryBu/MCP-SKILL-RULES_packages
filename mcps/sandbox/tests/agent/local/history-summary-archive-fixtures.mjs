import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../../../src/agent-server/storage/memory.ts';
import { StoreCompactionPort } from '../../../src/agent-server/storage/context-port.ts';
import { contextContent, contextStateKey, initialContextState } from '../../../src/agent-server/storage/context-transactions.ts';
import { recordHistoryHit } from '../../../src/agent-server/context/feedback.ts';
import { createHistorySourcePort } from '../../../src/agent-server/context/sources.ts';
import { generateCompaction, prepareCompaction } from '../../../src/agent-server/context/compaction.ts';
import { sealSummaryNode } from '../../../src/agent-server/context/view.ts';
import { ToolRouter } from '../../../src/agent-server/tools/router.ts';
import { FixtureCompressionModel, FixturePort, execution, fixtureConfig } from './context-fixtures.mjs';

export const conversationId = 'fixture-conversation';

export const makeNode = ordinal => sealSummaryNode({ kind: 'batch', nodeId: `archive-summary-${ordinal}`, firstSeq: ordinal * 2 - 1,
    lastSeq: ordinal * 2, roundIds: [`round-${ordinal}`], sourceSpans: [], chunkIds: [], parentBatchIds: [],
    modelFingerprint: 'archive-local-fixture', anchors: [], unresolved: [], body: `旧摘要完整正文_${ordinal}，中文与🍁来源必须保留。`.repeat(90),
    skeleton: `摘要骨架_${ordinal}`, title: `旧摘要_${ordinal}` });

export async function seeded(store = new MemoryStore(), policy = {}) {
    const config = fixtureConfig({ policy: { stableHeadBatches: 1, stableTailBatches: 1, middleSkeletonBatches: 0,
        foldAfterBatches: 3, maxActiveNodes: 3, ...policy } });
    const raw = new FixturePort(config);
    for (let ordinal = 1; ordinal <= 8; ordinal++) raw.appendRound(`本地原文第${ordinal}轮，需要保留归属。`, { active: ordinal === 8 });
    const lease = execution();
    const view = { revision: 1, historyEpoch: 1, coveredEndSeq: 6, nodes: [1, 2, 3].map(makeNode) };
    const viewContentId = randomUUID();
    const key = { conversationId, kind: 'conversation', id: conversationId };
    const runKey = { conversationId, kind: 'run', id: lease.runId };
    const state = { ...initialContextState(), execution: lease, compressionGeneration: 'archive-generation',
        effectiveModelFingerprint: config.modelFingerprint, viewContentId };
    const models = raw.items.filter(item => item.role === 'assistant').map(item => ({
        key: { conversationId, kind: 'step', id: item.stepId }, revision: 1,
        value: { kind: 'model', complete: true, toolCalls: [], resolvedCallIds: [] } }));
    await store.commitTransition({ expected: [{ key, revision: null }, { key: runKey, revision: null },
        { key: contextStateKey(conversationId), revision: null }, ...models.map(record => ({ key: record.key, revision: null }))],
        records: [{ key, revision: 1, value: { conversationId, principalId: 'archive-test', state: 'open',
            retention: { mode: 'archive' }, activeRunId: lease.runId, historyEpoch: 1, appendSeq: 16, viewRevision: 1,
            workspaceRevision: 0, eventSeq: '0', historyRoot: 'archive-raw-root' } },
        { key: runKey, revision: 1, value: { conversationId, kind: lease.kind, runId: lease.runId, rootRunId: lease.rootBudgetId,
            rootBudgetId: lease.rootBudgetId, runEpoch: lease.runEpoch, state: 'running', activeRoundId: 'round-8', deadlineAt: lease.deadlineAt } },
        { key: contextStateKey(conversationId), revision: 1, value: state }, ...models],
        contents: [contextContent(conversationId, viewContentId, 'context_view', view), ...raw.items.map(item => {
            const { itemId, seq, contentId, kind, objectRef, ...history } = item;
            return { conversationId, contentId, kind, indexHistory: true, history, value: raw.contents.get(contentId) };
        })] });
    return attach(store, { config, lease, view });
}

export function attach(store, existing) {
    const port = new StoreCompactionPort(store);
    const context = { conversationId, runId: existing.lease.runId, rootRunId: existing.lease.rootBudgetId, runEpoch: 1,
        roundId: 'round-8', actionId: randomUUID(), attemptId: randomUUID(), roots: [], signal: new AbortController().signal,
        retention: { mode: 'archive' } };
    const sink = [];
    const history = { readHistory: query => store.readHistory(query), readArtifact: query => store.readArtifact(query),
        inspect: id => port.inspect(id), ...(typeof port.readSummary === 'function' ? { readSummary: input => port.readSummary(input) } : {}),
        markHit: async hit => {
            const capture = await port.inspect(conversationId);
            assert.equal(hit.historyEpoch, capture.historyEpoch);
            assert.equal(hit.viewRevision, capture.viewRevision);
            const node = capture.view.nodes.find(entry => entry.nodeId === hit.summaryId)
                ?? await port.readSummary({ conversationId, historyEpoch: capture.historyEpoch, nodeId: hit.summaryId, hash: hit.summaryHash });
            assert.equal(node.hash, hit.summaryHash);
            assert.equal(node.firstSeq, hit.firstSeq);
            assert.equal(node.lastSeq, hit.lastSeq);
            assert.deepEqual(node.roundIds, hit.roundIds);
            sink.push(hit);
            return recordHistoryHit(store, { conversationId, historyEpoch: capture.historyEpoch, currentStep: capture.stepSeq,
                hitId: hit.hitId, nodeId: hit.summaryId, signal: context.signal });
        } };
    return { ...existing, store, port, sources: createHistorySourcePort(port, { conversationId }), context, sink,
        history, router: new ToolRouter({ history }) };
}

export async function candidateFor(fixture) {
    const current = await fixture.port.inspect(conversationId);
    const capture = await fixture.port.claim({ conversationId, expectedHistoryEpoch: current.historyEpoch,
        expectedViewRevision: current.viewRevision, expectedGeneration: current.compressionGeneration,
        compressionGeneration: randomUUID(), execution: fixture.lease });
    const candidate = await prepareCompaction({ port: fixture.port, sources: fixture.sources, capture,
        config: fixture.config, execution: fixture.lease, reason: 'hard' });
    await fixture.port.saveCandidate(candidate);
    const fixtureModel = new FixtureCompressionModel();
    await generateCompaction({ candidate, priorView: capture.view, port: fixture.port, sources: fixture.sources,
        model: fixtureModel, signal: new AbortController().signal });
    return candidate;
}

export async function publish(fixture, candidate) {
    return fixture.port.publishCandidate({ candidate, receiptKey: { principalId: 'archive-test', clientId: 'archive-test',
        conversationId, clientCommandId: randomUUID() } });
}

export async function appendRounds(fixture, count = 3) {
    const key = { conversationId, kind: 'conversation', id: conversationId };
    const previous = await fixture.store.getRecord(key);
    const runKey = { conversationId, kind: 'run', id: fixture.lease.runId };
    const run = await fixture.store.getRecord(runKey);
    const previousCount = Number(previous.value.appendSeq) / 2;
    const raw = new FixturePort(fixture.config);
    for (let ordinal = 1; ordinal <= previousCount + count; ordinal++) raw.appendRound(`后续原文第${ordinal}轮。`);
    const added = raw.items.filter(item => item.seq > previous.value.appendSeq);
    const models = added.filter(item => item.role === 'assistant').map(item => ({
        key: { conversationId, kind: 'step', id: item.stepId }, revision: 1,
        value: { kind: 'model', complete: true, toolCalls: [], resolvedCallIds: [] } }));
    await fixture.store.commitTransition({ expected: [{ key, revision: previous.revision }, { key: runKey, revision: run.revision },
        ...models.map(record => ({ key: record.key, revision: null }))],
        records: [{ ...previous, revision: previous.revision + 1, value: { ...previous.value, appendSeq: (previousCount + count) * 2 } },
            { ...run, revision: run.revision + 1, value: { ...run.value, activeRoundId: `round-${previousCount + count}` } }, ...models],
        contents: added.map(item => {
            const { itemId, seq, contentId, kind, objectRef, ...history } = item;
            return { conversationId, contentId, kind, indexHistory: true, history, value: raw.contents.get(contentId) };
        }) });
}

export async function execute(fixture, name, args) {
    const result = await fixture.router.execute(name, args, fixture.context);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result.data;
}
