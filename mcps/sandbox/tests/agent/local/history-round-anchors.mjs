import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { MemoryStore } from '../../../src/agent-server/storage/memory.ts';
import { SqliteStore } from '../../../src/agent-server/storage/sqlite.ts';
import { HistoryRecallTools } from '../../../src/agent-server/tools/history.ts';
import { localArgumentSchemas, MODEL_FUNCTION_SCHEMAS } from '../../../src/agent-server/tools/schemas.ts';
import { validateToolArguments } from '../../../src/agent-server/tools/schema-cache.ts';
import { recordHistoryHit } from '../../../src/agent-server/context/feedback.ts';
import { seeded, appendRounds, candidateFor, publish } from './history-summary-archive-fixtures.mjs';

function assertHint(hint) {
    assert.ok(hint && typeof hint.tool === 'string');
    const schema = MODEL_FUNCTION_SCHEMAS.find(entry => entry.name === hint.tool);
    assert.ok(schema);
    validateToolArguments(hint.arguments, schema.parameters);
    assert.ok(localArgumentSchemas[hint.tool].safeParse(hint.arguments).success);
}

async function fixture(store = new MemoryStore()) {
    const conversationId = randomUUID();
    const key = { conversationId, kind: 'conversation', id: conversationId };
    const roundIds = Array.from({ length: 14 }, () => randomUUID());
    const contents = roundIds.flatMap((roundId, index) => ['user', 'assistant'].map(role => ({
        conversationId, contentId: randomUUID(), kind: 'input', value: { text: `anchor-${index + 1}-${role}` },
        indexHistory: true, history: { view: 'raw', effective: true, role, roundId, stepId: randomUUID() },
    })));
    await store.commitTransition({ expected: [{ key, revision: null }], records: [{ key, revision: 1,
        value: { conversationId, principalId: 'owned-history-round-anchors', state: 'open',
            retention: { mode: 'archive', lastRunEnd: null, lastClose: null, expiresAt: null, activeRuns: 0 }, options: {},
            historyEpoch: 1, appendSeq: 0, viewRevision: 0, workspaceRevision: 0, runEpoch: 0, activeRunId: null,
            eventGeneration: randomUUID(), eventSeq: '0', policyRevision: 1,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }], contents });
    const page = await store.readHistory({ conversationId, limit: 200, includeValues: false });
    const rounds = roundIds.map((roundId, index) => ({ roundId, firstSeq: index * 2 + 1, lastSeq: index * 2 + 2,
        itemIds: page.items.filter(item => item.roundId === roundId).map(item => item.itemId),
        complete: true, lastStepSeq: index + 1, nativePairing: 'complete' }));
    const capture = { conversationId, historyEpoch: 1, appendSeq: 28, viewRevision: 0, rounds,
        view: { revision: 0, historyEpoch: 1, coveredEndSeq: 0, nodes: [] } };
    const marks = [];
    const calls = [];
    const port = { inspect: async () => structuredClone(capture),
        readHistory: async query => { calls.push(query); return store.readHistory(query); },
        readArtifact: query => store.readArtifact(query), markHit: async hit => { marks.push(hit); return { accepted: true }; } };
    const context = { conversationId, actionId: randomUUID(), signal: new AbortController().signal };
    const tools = new HistoryRecallTools(port);
    const execute = (name, args) => tools.execute(name, localArgumentSchemas[name].parse(args), context);
    const publishTail = () => { capture.viewRevision = 1; capture.view = { revision: 1, historyEpoch: 1,
        coveredEndSeq: 24, nodes: [] }; capture.rounds = rounds.slice(11); };
    return { store, execute, publishTail, capture, roundIds, marks, calls };
}

test('original rounds 1, 6, 7 and 12 keep search/read/mark identity across a tail-only published capture', async context => {
    const owned = await fixture();
    context.after(() => owned.store.close());
    for (const phase of ['before', 'after']) {
        if (phase === 'after') owned.publishTail();
        for (const roundHit of [1, 6, 7, 12]) {
            const search = await owned.execute('history_search', { query: `anchor-${roundHit}-user` });
            assert.equal(search.items.length, 1);
            const hit = search.items[0];
            assert.equal(hit.roundNumber, roundHit, `${phase}: search round ${roundHit}`);
            assert.deepEqual(hit.usefulHit.arguments, { roundHit });
            assertHint(hit.originalRead);
            assertHint(hit.usefulHit);
            const text = await owned.execute(hit.originalRead.tool, hit.originalRead.arguments);
            assert.ok(text.text.includes(`anchor-${roundHit}-user`));
            const read = await owned.execute('history_read', { startRound: roundHit, endRound: roundHit });
            assert.deepEqual([...new Set(read.items.map(item => item.roundId))], [owned.roundIds[roundHit - 1]]);
            assertHint(read.originalRead);
            assertHint(read.usefulHit);
            assert.deepEqual(read.usefulHit.arguments, { roundHit });
            const mark = await owned.execute(hit.usefulHit.tool, hit.usefulHit.arguments);
            assert.deepEqual(mark.source.roundIds, [owned.roundIds[roundHit - 1]]);
            assert.equal(mark.source.firstSeq, roundHit * 2 - 1);
            assert.equal(mark.source.lastSeq, roundHit * 2);
        }
    }
});

test('owned SQLite cold reopen preserves original round anchors after a tail-only capture', async context => {
    const parent = await realpath(tmpdir());
    const directory = await mkdtemp(join(parent, 'history-round-anchors-'));
    let store;
    context.after(async () => {
        await store?.close();
        const resolved = await realpath(directory);
        assert.equal(dirname(resolved), parent);
        assert.ok(basename(resolved).startsWith('history-round-anchors-'));
        await rm(resolved, { recursive: true });
    });
    store = await SqliteStore.open({ dataDir: directory });
    const owned = await fixture(store);
    owned.publishTail();
    await store.close();
    store = await SqliteStore.open({ dataDir: directory });
    const tools = new HistoryRecallTools({ inspect: async () => structuredClone(owned.capture),
        readHistory: query => store.readHistory(query), readArtifact: query => store.readArtifact(query), markHit: async () => ({ accepted: true }) });
    const bound = { conversationId: owned.capture.conversationId, signal: new AbortController().signal, actionId: randomUUID() };
    for (const roundHit of [1, 6, 7, 12]) {
        const search = await tools.execute('history_search', localArgumentSchemas.history_search.parse({ query: `anchor-${roundHit}-user` }), bound);
        assert.equal(search.items[0].roundNumber, roundHit);
        assertHint(search.items[0].originalRead);
        assertHint(search.items[0].usefulHit);
        const result = await tools.execute('mark_history_hit', search.items[0].usefulHit.arguments, bound);
        assert.deepEqual(result.source.roundIds, [owned.roundIds[roundHit - 1]]);
        assert.equal(result.source.firstSeq, roundHit * 2 - 1);
        assert.equal(result.source.lastSeq, roundHit * 2);
    }
});

test('real local compaction publication keeps covered rounds 1, 6 and 7 and raw-tail rounds addressable', async context => {
    const owned = await seeded();
    context.after(() => owned.store.close());
    await appendRounds(owned, 6);
    const history = new HistoryRecallTools({ ...owned.history, markHit: async hit => recordHistoryHit(owned.store, {
        conversationId: hit.conversationId, historyEpoch: hit.historyEpoch, currentStep: 20,
        hitId: randomUUID(), roundId: hit.roundIds[0], signal: owned.context.signal }) });
    const execute = (name, args) => history.execute(name, localArgumentSchemas[name].parse(args), owned.context);
    const originals = new Map();
    for (const phase of ['before', 'after']) {
        if (phase === 'after') {
            const candidate = await candidateFor(owned);
            await publish(owned, candidate);
            const capture = await owned.port.inspect(owned.context.conversationId);
            assert.ok(capture.view.coveredEndSeq >= 12);
            assert.ok(!capture.rounds.some(round => round.roundId === 'round-1' || round.roundId === 'round-6'));
            console.log(JSON.stringify({ fixture: 'real-owned-publication', viewRevision: capture.viewRevision,
                coveredEndSeq: capture.view.coveredEndSeq, capturedRoundIds: capture.rounds.map(round => round.roundId), providerCalls: 0 }));
        }
        for (const roundHit of [1, 6, 7, 12]) {
            const read = await execute('history_read', { startRound: roundHit, endRound: roundHit });
            assert.deepEqual(read.usefulHit.arguments, { roundHit });
            const user = read.items.find(item => item.role === 'user');
            const query = user.value.text;
            const search = await execute('history_search', { query, startRound: roundHit, endRound: roundHit });
            assert.equal(search.items[0].roundNumber, roundHit);
            assertHint(search.items[0].originalRead);
            assertHint(search.items[0].usefulHit);
            const original = await execute(search.items[0].originalRead.tool, search.items[0].originalRead.arguments);
            assert.ok(original.text.includes(query));
            const mark = await execute(search.items[0].usefulHit.tool, search.items[0].usefulHit.arguments);
            const source = { roundIds: mark.source.roundIds, firstSeq: mark.source.firstSeq, lastSeq: mark.source.lastSeq };
            assert.equal(mark.receipt.target.id, `round-${roundHit}`);
            if (phase === 'before') originals.set(roundHit, source);
            else assert.deepEqual(source, originals.get(roundHit));
        }
    }
});

test('mark round 1 after publication uses original seq 1..2 rather than tail seq 23..24', async context => {
    const owned = await fixture();
    context.after(() => owned.store.close());
    owned.publishTail();
    const result = await owned.execute('mark_history_hit', { roundHit: 1 });
    assert.equal(result.source.firstSeq, 1);
    assert.equal(result.source.lastSeq, 2);
    assert.deepEqual(result.source.roundIds, [owned.roundIds[0]]);
});

test('mark covered round 6 succeeds even when capture contains only the raw tail', async context => {
    const owned = await fixture();
    context.after(() => owned.store.close());
    owned.publishTail();
    const result = await owned.execute('mark_history_hit', { roundHit: 6 });
    assert.deepEqual(result.source.roundIds, [owned.roundIds[5]]);
    assert.equal(result.source.firstSeq, 11);
    assert.equal(result.source.lastSeq, 12);
});
