import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { activeRequirements, applyRequirementResolutions, boundedRequirementGuidance, parseRequirementResolutions } from '../../../src/agent-server/context/requirements.ts';
import { mergeRequirements, renderSummary, sealSummaryNode, applySummaryFold } from '../../../src/agent-server/context/view.ts';
import { prepareCompaction, generateCompaction } from '../../../src/agent-server/context/compaction.ts';
import { hashBytes } from '../../../src/agent-server/context/config.ts';
import { createHistorySourcePort } from '../../../src/agent-server/context/sources.ts';
import { ProviderCompressionModelPort } from '../../../src/agent-server/context/server-adapter.ts';
import { openAgentStore } from '../../../src/agent-server/storage/index.ts';
import { StoreCompactionPort } from '../../../src/agent-server/storage/context-port.ts';
import { contextContent, contextStateKey, initialContextState } from '../../../src/agent-server/storage/context-transactions.ts';
import { FixturePort, fixtureConfig } from './context-fixtures.mjs';

const oldQuote = '初始异常标准是温度>=32且湿度>=75，最终报告稍后统一写。';
const changedQuote = '更正异常标准：温度门槛调整为33°C，湿度仍是75%，两者都包含等号，必须同时达到才计异常。之前32°C的版本作废。';
const oldClause = '初始异常标准是温度>=32且湿度>=75';
const completionQuote = '报告已写入 report.md，随后读取 report.md，内容与写入的完整中文报告一致。';
const countTokens = text => Buffer.byteLength(text);

function setup(quotes = [oldQuote, changedQuote, completionQuote]) {
    const textById = new Map([['opaque-original', quotes[0]], ['opaque-correction', quotes[1]], ['opaque-readback', quotes[2]]]);
    const blocks = [...textById].map(([itemId, text], index) => ({ itemId, blockId: 'text', contentId: itemId, seq: [1, 7, 20][index],
        roundId: `round-${index}`, kind: 'text', byteLength: Buffer.byteLength(text), sha256: hashBytes(text), retrieval: {} }));
    const anchor = (id, index) => ({ id, quote: textById.get(blocks[index].itemId), source: { itemId: blocks[index].itemId, blockId: 'text',
        startByte: 0, endByte: blocks[index].byteLength, sha256: blocks[index].sha256, blockHash: blocks[index].sha256, purpose: 'target' } });
    const original = anchor('old', 0);
    const correction = anchor('new', 1);
    const completion = anchor('done', 2);
    const config = fixtureConfig();
    const snapshot = { conversationId: 'lifecycle-conversation', historyEpoch: 3, snapshotAppendSeq: 20, config,
        manifest: { blocks, rounds: [] }, referenceBlocks: [], requirementSourceMetadata: blocks.map((block, index) => ({
            itemId: block.itemId, seq: block.seq, role: index === 2 ? 'tool' : 'user', roundId: block.roundId,
            terminalOutcome: { state: 'succeeded', stopReason: null } })) };
    const sources = { describe: async () => blocks, read: async request => Buffer.from(textById.get(request.block.itemId)).subarray(request.startByte, request.endByte) };
    const proposal = { requirementId: original.id, status: 'superseded', resolvedQuote: oldClause,
        replacementRequirementId: correction.id, evidence: [{ quote: correction.quote, source: correction.source }] };
    const apply = (resolutions = [proposal], records = [original, correction], changedSnapshot = snapshot) => applyRequirementResolutions({
        records, resolutions, snapshot: changedSnapshot, sources, signal: new AbortController().signal });
    return { original, correction, completion, snapshot, sources, proposal, apply, config };
}

function node(records, ordinal = 1) {
    return sealSummaryNode({ kind: 'batch', nodeId: `node-${ordinal}`, firstSeq: ordinal, lastSeq: ordinal, roundIds: [],
        sourceSpans: [], chunkIds: [], parentBatchIds: [], modelFingerprint: 'model', anchors: [],
        body: '历史值及更正均保留在原始来源。', skeleton: '当前更正可查回。', title: '温度与报告', unresolved: records });
}

test('pilot4 wording: later 33 replaces only old 32 clause, preserving a strict UTF-8 report remainder', async () => {
    const fixture = setup();
    const records = await fixture.apply();
    const original = records.find(record => record.id === 'old');
    const remaining = activeRequirements(records);
    assert.equal(original.resolution.status, 'superseded');
    assert.equal(original.quote, oldQuote);
    assert.deepEqual(original.source, fixture.original.source);
    const report = remaining.find(record => record.parentRequirementId === original.id);
    assert.equal(report.quote, '最终报告稍后统一写');
    assert.equal(Buffer.from(oldQuote).subarray(report.source.startByte, report.source.endByte).toString(), report.quote);
    assert.equal(report.source.sha256, hashBytes(report.quote));
    assert.ok(remaining.some(record => record.id === 'new'));
    assert.ok(!remaining.some(record => record.id === 'old'));
});

test('actual later tool read-back completes the report; absent, failed and cancelled outcomes keep it active', async () => {
    const fixture = setup();
    const records = await fixture.apply();
    const report = records.find(record => record.parentRequirementId === 'old');
    const resolution = { requirementId: report.id, status: 'fulfilled', resolvedQuote: report.quote,
        evidence: [{ quote: fixture.completion.quote, source: fixture.completion.source }] };
    const completed = await fixture.apply([resolution], records);
    assert.equal(activeRequirements(completed).some(record => record.id === report.id), false);
    for (const state of ['failed', 'cancelled', undefined]) {
        const snapshot = structuredClone(fixture.snapshot);
        if (state) snapshot.requirementSourceMetadata[2].terminalOutcome.state = state;
        else delete snapshot.requirementSourceMetadata[2].terminalOutcome;
        assert.ok(activeRequirements(await fixture.apply([resolution], records, snapshot)).some(record => record.id === report.id));
    }
    const snapshot = structuredClone(fixture.snapshot);
    snapshot.requirementSourceMetadata[2].role = 'user';
    assert.ok(activeRequirements(await fixture.apply([resolution], records, snapshot)).some(record => record.id === report.id));
});

test('unknown ID, absent evidence, wrong hash, wrong source, old source and ambiguous proposals preserve obligations', async () => {
    const fixture = setup();
    const wrongHash = structuredClone(fixture.proposal);
    wrongHash.evidence[0].source.sha256 = 'wrong';
    const wrongSource = structuredClone(fixture.proposal);
    wrongSource.evidence[0].source.itemId = 'unknown';
    const cases = [[{ ...fixture.proposal, requirementId: 'unknown' }], [{ ...fixture.proposal, evidence: [] }], [wrongHash], [wrongSource],
        [{ ...fixture.proposal, replacementRequirementId: undefined, evidence: [{ quote: fixture.original.quote, source: fixture.original.source }] }],
        [fixture.proposal, fixture.proposal]];
    for (const resolutions of cases) assert.ok(activeRequirements(await fixture.apply(resolutions)).some(record => record.id === 'old'));
    const snapshot = structuredClone(fixture.snapshot);
    snapshot.requirementSourceMetadata = [];
    assert.ok(activeRequirements(await fixture.apply(undefined, undefined, snapshot)).some(record => record.id === 'old'));
});

test('parser uses known IDs and exact frozen evidence; malformed optional resolutions leave a compatible digest', () => {
    const fixture = setup();
    const target = { text: fixture.completion.quote, span: fixture.completion.source };
    const request = { chunk: { body: JSON.stringify({ targets: [target], references: [], priorGuidance: JSON.stringify({ activeRequirements: [fixture.original, fixture.correction] }) }) } };
    assert.equal(parseRequirementResolutions([fixture.proposal], request, []).length, 1);
    assert.equal(parseRequirementResolutions([{ ...fixture.proposal, requirementId: 'invented' }], request, []).length, 0);
    assert.deepEqual(parseRequirementResolutions(undefined, request, []), []);
    const ambiguous = { ...request, chunk: { body: JSON.stringify({ targets: [target, { ...target, span: { ...target.span, startByte: 100, endByte: 100 + Buffer.byteLength(target.text) } }],
        priorGuidance: JSON.stringify({ activeRequirements: [fixture.original] }) }) } };
    assert.equal(parseRequirementResolutions([{ requirementId: 'old', status: 'fulfilled', resolvedQuote: oldQuote,
        evidence: [{ quote: target.text, source: { itemId: target.span.itemId, blockId: 'text' } }] }], ambiguous, []).length, 0);
});

test('later actual user continuation supersedes pure waits/confirmation; trusted closed assistant can fulfill without any tool', async () => {
    for (const quote of ['等待下一条资料。', '本轮只确认这些约定。']) {
        const fixture = setup([quote, '下一条资料：样本数为24，继续整理结果。', '这些约定已逐项确认，现采用33°C标准。']);
        const proposal = { ...fixture.proposal, resolvedQuote: quote };
        const records = await fixture.apply([proposal]);
        assert.equal(activeRequirements(records).some(record => record.id === 'old'), false);
        const snapshot = structuredClone(fixture.snapshot);
        snapshot.requirementSourceMetadata[2].role = 'assistant';
        const fulfillment = { requirementId: 'old', status: 'fulfilled', resolvedQuote: quote,
            evidence: [{ quote: fixture.completion.quote, source: fixture.completion.source }] };
        assert.equal(activeRequirements(await fixture.apply([fulfillment], undefined, snapshot)).some(record => record.id === 'old'), false);
        for (const state of ['failed', 'cancelled']) {
            snapshot.requirementSourceMetadata[2].terminalOutcome.state = state;
            assert.ok(activeRequirements(await fixture.apply([fulfillment], undefined, snapshot)).some(record => record.id === 'old'));
        }
        delete snapshot.requirementSourceMetadata[2].terminalOutcome;
        assert.ok(activeRequirements(await fixture.apply([fulfillment], undefined, snapshot)).some(record => record.id === 'old'));
    }
});

test('successful acknowledgments and tool results retain recurring obligations, including partial quotes without their scope marker', async () => {
    for (const quote of ['每轮先保留约定并简短回答，本轮不要生成报告。', '每次回复先核对来源，并保留原始记录。',
        '始终使用中文回答。', 'Always retain the agreed format, and answer briefly.', 'For each turn, preserve the agreed format.',
        '每轮核对来源，并在本轮结束前简短回答。']) {
        const fixture = setup([quote, '本轮资料已提交。', '收到，本轮继续保持约定。']);
        for (const role of ['assistant', 'tool']) {
            fixture.snapshot.requirementSourceMetadata[2].role = role;
            for (const resolvedQuote of [quote, quote.replace(/^(?:每轮|每次|始终|Always |For each turn, )/u, ''),
                ...(quote.includes('并保留') ? ['保留原始记录'] : []), ...(quote.includes('结束前') ? ['简短回答'] : [])]) {
                const records = await fixture.apply([{ requirementId: 'old', status: 'fulfilled', resolvedQuote,
                    evidence: [{ quote: fixture.completion.quote, source: fixture.completion.source }] }]);
                assert.deepEqual(records.find(record => record.id === 'old'), fixture.original);
            }
        }
    }
});

test('local fulfillment and trusted user withdrawal retain exact recurring remainder identities across further partial resolutions', async () => {
    const recurring = '每轮使用中文并简短回答';
    const quote = `${recurring}，本轮写入报告并读回，另存校验记录。`;
    const fixture = setup([quote, '现在撤回每轮使用中文并简短回答的约定。', '报告已写入并读回，校验记录已另存。']);
    const fulfillment = resolvedQuote => ({ requirementId: 'old', status: 'fulfilled', resolvedQuote,
        evidence: [{ quote: fixture.completion.quote, source: fixture.completion.source }] });
    const records = await fixture.apply([fulfillment('本轮写入报告并读回')]);
    const remainders = activeRequirements(records).filter(record => record.parentRequirementId === 'old');
    assert.deepEqual(remainders.map(record => record.quote), [recurring, '另存校验记录']);
    for (const remainder of remainders) {
        assert.equal(Buffer.from(quote).subarray(remainder.source.startByte, remainder.source.endByte).toString(), remainder.quote);
        assert.equal(remainder.source.sha256, hashBytes(remainder.quote));
    }
    const second = await fixture.apply([{ ...fulfillment('另存校验记录'), requirementId: remainders[1].id }], records);
    assert.deepEqual(activeRequirements(second).filter(record => record.parentRequirementId === 'old').map(record => record.quote), [recurring]);
    assert.ok(activeRequirements(await fixture.apply([{ ...fulfillment(recurring), requirementId: remainders[0].id }], second))
        .some(record => record.id === remainders[0].id));
    const withdrawn = await fixture.apply([{ requirementId: remainders[0].id, status: 'superseded', resolvedQuote: recurring,
        evidence: [{ quote: fixture.correction.quote, source: fixture.correction.source }] }], second);
    assert.equal(activeRequirements(withdrawn).some(record => record.id === remainders[0].id), false);
});

test('an uncertain recurring fulfillment leaves unrelated local completions valid without invalidating the digest', async () => {
    const fixture = setup(['每轮保留格式，再简短回答。', '本轮只确认新增资料。', '新增资料已确认，本轮继续保留格式。']);
    const request = { chunk: { body: JSON.stringify({ targets: [{ text: fixture.completion.quote, span: fixture.completion.source }],
        priorGuidance: JSON.stringify({ activeRequirements: [fixture.original, fixture.correction] }) }) } };
    const raw = [fixture.original, fixture.correction].map(requirement => ({ requirementId: requirement.id,
        status: 'fulfilled', resolvedQuote: requirement.quote, evidence: [{ quote: fixture.completion.quote, source: fixture.completion.source }] }));
    const resolutions = parseRequirementResolutions(raw, request, []);
    assert.equal(resolutions.length, 2);
    const resolved = await fixture.apply(resolutions);
    assert.deepEqual(activeRequirements(resolved), [fixture.original]);
    assert.equal(resolved.find(record => record.id === fixture.correction.id).resolution.status, 'fulfilled');
    const withdrawal = { requirementId: fixture.original.id, status: 'superseded', resolvedQuote: fixture.original.quote,
        evidence: [{ quote: fixture.correction.quote, source: fixture.correction.source }] };
    for (const role of ['assistant', 'tool']) {
        const snapshot = structuredClone(fixture.snapshot);
        snapshot.requirementSourceMetadata[1].role = role;
        assert.deepEqual(activeRequirements(await fixture.apply([withdrawal], resolved, snapshot)), [fixture.original]);
    }
});

test('1000-byte pilot budget rotates all nine IDs, exposing old32/new33 together and the tail wait on a later page', () => {
    const quotes = [oldQuote, '本轮不要生成报告，不运行终端、不派子代理。', '报告中文，分「范围、方法、结果、待核」四节，温度单位°C、湿度单位%，不画图。',
        changedQuote + '请说清现在采用哪一版，然后等待下一条资料。',
        '我提议过把south区全部去掉，现在撤回这个提议，三个区仍全保留。只剔除S017，这条记录校准无效；其它记录无论数值多大都要保留。请把这个决定留在任务上下文。',
        'P95采用nearest-rank，排序后第ceil(0.95*N)项，不做插值。', '最终数字保留两位小数。', '本轮只确认这些约定。', '等待下一条资料。'];
    const fixture = setup();
    const records = quotes.map((quote, index) => ({ ...fixture.original, id: `10000000-0000-0000-0000-${String(index).padStart(12, '0')}`, quote }));
    const first = boundedRequirementGuidance(records, 750, countTokens);
    assert.ok(first.some(record => record.id === records[0].id));
    assert.ok(first.some(record => record.id === records[3].id));
    const seen = new Set();
    let cursor = 0;
    for (let page = 0; page < records.length; page++) {
        const selected = boundedRequirementGuidance(records, 750, countTokens, cursor);
        assert.ok(countTokens(JSON.stringify(selected.map(({ id, quote }) => ({ id, quote })))) <= 750);
        for (const record of selected) seen.add(record.id);
        cursor += Math.max(1, selected.length);
    }
    assert.equal(seen.size, 9);
    assert.ok(seen.has(records[8].id));
});

test('merge and fold are monotonic, original nodes immutable, and only active obligations are rendered/budgeted', async () => {
    const fixture = setup();
    const originalNode = node([fixture.original, fixture.correction]);
    const before = JSON.stringify(originalNode);
    const records = await fixture.apply();
    const resolvedNode = node(records, 2);
    const merged = mergeRequirements([records, [fixture.original], records]);
    assert.equal(activeRequirements(merged).some(record => record.id === 'old'), false);
    const rendered = renderSummary([originalNode, resolvedNode], fixture.config.policy);
    const activeText = rendered.text.split('Unresolved requirements (verbatim):')[1];
    assert.ok(!activeText.includes('"id":"old"'));
    assert.ok(activeText.includes('最终报告稍后统一写'));
    const { hash: resolvedHash, ...resolvedContent } = resolvedNode;
    const folded = sealSummaryNode({ ...resolvedContent, kind: 'fold', nodeId: 'fold',
        firstSeq: 1, lastSeq: 2, children: [originalNode, resolvedNode].map(child => ({ nodeId: child.nodeId, hash: child.hash, firstSeq: child.firstSeq, lastSeq: child.lastSeq })) });
    const { hash: unused, ...foldContent } = folded;
    const validFold = sealSummaryNode(foldContent);
    assert.equal(applySummaryFold([originalNode, resolvedNode], { children: [originalNode, resolvedNode], startIndex: 0, endIndex: 2 }, validFold).length, 1);
    assert.equal(JSON.stringify(originalNode), before);
    assert.equal(activeRequirements(validFold.unresolved).length, 2);
    const selected = boundedRequirementGuidance(records, 2000, countTokens);
    assert.ok(countTokens(JSON.stringify(selected.map(({ id, quote }) => ({ id, quote })))) <= 2000);
    assert.ok(!selected.some(record => record.id === 'old'));
    const pilotBudget = boundedRequirementGuidance([fixture.original, fixture.correction], 750, countTokens);
    assert.deepEqual(pilotBudget.map(record => record.id), ['old', 'new']);
});

test('duplicate requirement replacement chains advance strictly by real metadata, independent of opaque item IDs', async () => {
    const fixture = setup([oldQuote, changedQuote, '异常阈值再调为34°C，湿度75%，报告要求不变。']);
    fixture.snapshot.requirementSourceMetadata[2].role = 'user';
    const records = await fixture.apply();
    const next = { ...fixture.completion, id: 'later-duplicate' };
    const chained = await fixture.apply([{ requirementId: 'new', status: 'superseded', resolvedQuote: fixture.correction.quote,
        replacementRequirementId: next.id, evidence: [{ quote: next.quote, source: next.source }] }], [...records, next]);
    assert.equal(chained.find(record => record.id === 'new').resolution.replacementRequirementId, next.id);
    const cycle = await fixture.apply([{ requirementId: next.id, status: 'superseded', resolvedQuote: next.quote,
        replacementRequirementId: 'old', evidence: [{ quote: fixture.original.quote, source: fixture.original.source }] }], chained);
    assert.ok(activeRequirements(cycle).some(record => record.id === next.id));
});

test('owned SQLite close/reopen preserves resolution evidence, original anchors and active view', async () => {
    const fixture = setup();
    const records = await fixture.apply();
    const root = await mkdtemp(join(process.env.REQUIREMENT_LIFECYCLE_EVIDENCE_ROOT ?? tmpdir(), 'requirement-lifecycle-'));
    const key = { conversationId: null, kind: 'step', id: 'context-requirement-lifecycle' };
    let store = await openAgentStore({ dataDir: root });
    const value = { view: { revision: 2, historyEpoch: 3, coveredEndSeq: 20, nodes: [node(records)], requirementGuidanceCursor: 7 }, original: fixture.original };
    try {
        await store.commitTransition({ expected: [{ key, revision: null }], records: [{ key, revision: 1, value,
            createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z' }] });
    } finally { await store.close(); }
    store = await openAgentStore({ dataDir: root });
    try {
        const loaded = await store.getRecord(key);
        assert.deepEqual(loaded.value, value);
        assert.equal(loaded.value.view.requirementGuidanceCursor, 7);
        assert.equal(activeRequirements(mergeRequirements(loaded.value.view.nodes.map(child => child.unresolved))).length, 2);
        assert.equal(loaded.value.view.nodes[0].unresolved.find(record => record.id === 'old').resolvedBy.length, 1);
        console.log(JSON.stringify({ ownedSqlite: root, closedTwice: true, apiCalls: 0, coreStarts: 0 }));
    } finally { await store.close(); }
});

test('prepare/generate/CAS retains recurring requirements after a valid digest proposes an overbroad fulfillment', async () => {
    const quote = '每次回复保留约定并简短回答，本轮只确认资料。';
    const acknowledgment = '本轮资料已确认，继续保持此前约定。';
    const config = fixtureConfig({ policy: { keepCompleteRounds: 2, stableHeadBatches: 0, stableTailBatches: 0,
        foldAfterBatches: 1, maxActiveNodes: 1, referenceTokens: 1000 } });
    const port = new FixturePort(config);
    port.appendRound(quote);
    port.appendRound('本轮新增资料。', { modelValue: { kind: 'model', protocol: 'compatible_chat', response: {
        attemptId: 'recurring-ack', modelId: 'context-fixture-model', complete: true, blocks: [{ type: 'text', text: acknowledgment }],
        toolCalls: [], raw: { httpStatus: 200, headers: {}, body: acknowledgment, json: {} } } } });
    for (let ordinal = 3; ordinal <= 6; ordinal++) port.appendRound(`普通资料${ordinal}`, { active: ordinal === 6 });
    const fixture = setup([quote, '后续更正另行说明。', acknowledgment]);
    const original = { ...fixture.original, source: { ...fixture.original.source, itemId: 'user-1' } };
    const { hash: priorHash, ...priorContent } = node([original]);
    port.capture.view = { revision: 1, historyEpoch: 1, coveredEndSeq: 2,
        nodes: [sealSummaryNode({ ...priorContent, lastSeq: 2, roundIds: ['round-1'] })] };
    port.capture.viewRevision = 1;
    port.readRequirementSourceMetadata = async ({ historyEpoch, itemIds }) => ({ historyEpoch,
        items: port.items.filter(item => itemIds.includes(item.itemId)).map(({ itemId, seq, role, roundId }) => ({ itemId, seq, role, roundId,
            terminalOutcome: { state: 'succeeded', stopReason: null } })) });
    const sources = createHistorySourcePort(port, { conversationId: port.capture.conversationId });
    const candidate = await prepareCompaction({ port, sources, capture: await port.inspect(), config, execution: port.capture.execution, reason: 'manual' });
    const parser = new ProviderCompressionModelPort({});
    let proposals = 0;
    const model = { async generate(request) {
        const target = JSON.parse(request.chunk.body).targets.find(part => part.text === acknowledgment);
        const digest = { body: '本轮资料已收到，后续仍按约定处理。', skeleton: '资料已收，约定保持。', title: '资料确认', unresolved: [] };
        if (target && request.reason !== 'fold') {
            digest.resolutions = [{ requirementId: original.id, status: 'fulfilled', resolvedQuote: quote,
                evidence: [{ quote: acknowledgment, source: { itemId: target.span.itemId, blockId: target.span.blockId } }] }];
            proposals++;
        }
        const result = parser.result(request, { attemptId: request.attemptId, blocks: [{ type: 'text', text: JSON.stringify(digest) }],
            complete: true, stop: { kind: 'completed' }, toolCalls: [], problems: [], usage: {} }, { bodyHash: 'offline-recurring-digest' });
        assert.equal(result.complete, true);
        assert.equal(result.usage.validationRepairEligible, false);
        return result;
    } };
    const generated = await generateCompaction({ candidate, priorView: port.capture.view, port, sources, model, signal: new AbortController().signal });
    assert.equal(generated.state, 'ready');
    assert.equal(proposals, 1);
    await port.publishCandidate({ candidate: generated, receiptKey: { conversationId: port.capture.conversationId, commandId: 'recurring-publication' } });
    assert.equal(port.commits, 1);
    const records = mergeRequirements(generated.nextView.nodes.map(child => child.unresolved));
    assert.deepEqual(activeRequirements(records), [original]);
    const rendered = renderSummary(generated.nextView.nodes, config.policy);
    assert.ok(rendered.text.includes(original.id));
    assert.ok(rendered.text.includes(quote));
});

test('prepare/generate/CAS pipeline consumes a later exact correction and keeps old no-resolutions model output compatible', async () => {
    const config = fixtureConfig({ policy: { keepCompleteRounds: 2, stableHeadBatches: 0, stableTailBatches: 0,
        foldAfterBatches: 1, maxActiveNodes: 1, referenceTokens: 1000 } });
    const port = new FixturePort(config);
    port.appendRound(oldQuote, { modelValue: { kind: 'model', protocol: 'compatible_chat', response: {
        attemptId: 'old-ack', modelId: 'context-fixture-model', complete: true, blocks: [{ type: 'text', text: '等待下一条资料。' }],
        toolCalls: [], raw: { httpStatus: 200, headers: {}, body: '等待下一条资料。', json: {} } } } });
    port.appendRound(changedQuote);
    for (let ordinal = 3; ordinal <= 6; ordinal++) port.appendRound(`后续资料${ordinal}`, { active: ordinal === 6 });
    const fixture = setup();
    const old = { ...fixture.original, source: { ...fixture.original.source, itemId: 'user-1' } };
    const waitQuote = '等待下一条资料。';
    const wait = { id: 'old-wait', quote: waitQuote, source: { itemId: 'model-1', blockId: 'response.blocks.0.text',
        startByte: 0, endByte: Buffer.byteLength(waitQuote), sha256: hashBytes(waitQuote), blockHash: hashBytes(waitQuote), purpose: 'target' } };
    const { hash: oldHash, ...oldContent } = node([old, wait]);
    const oldNode = sealSummaryNode({ ...oldContent, lastSeq: 2, roundIds: ['round-1'] });
    port.capture.view = { revision: 1, historyEpoch: 1, coveredEndSeq: 2, nodes: [oldNode] };
    port.capture.viewRevision = 1;
    port.readRequirementSourceMetadata = async ({ historyEpoch, itemIds }) => ({ historyEpoch,
        items: port.items.filter(item => itemIds.includes(item.itemId)).map(({ itemId, seq, role, roundId }) => ({ itemId, seq, role, roundId })) });
    const sources = createHistorySourcePort(port, { conversationId: port.capture.conversationId });
    const candidate = await prepareCompaction({ port, sources, capture: await port.inspect(), config, execution: port.capture.execution, reason: 'manual' });
    const parser = new ProviderCompressionModelPort({});
    let resolutionsSeen = 0;
    const model = { async generate(request) {
        const payload = JSON.parse(request.chunk.body);
        const target = payload.targets.find(part => part.text.includes(changedQuote));
        const digest = { body: '当前标准33°C，报告仍待写。', skeleton: '33°C；报告待办。', title: '异常标准更正', unresolved: [] };
        if (target && request.reason !== 'fold') {
            assert.ok(JSON.parse(payload.priorGuidance).activeRequirements.some(record => record.id === old.id));
            digest.unresolved = [{ quote: changedQuote, source: { itemId: target.span.itemId, blockId: target.span.blockId } }];
            digest.resolutions = [{ requirementId: old.id, status: 'superseded', resolvedQuote: oldClause,
                evidence: [{ quote: changedQuote, source: { itemId: target.span.itemId, blockId: target.span.blockId } }] },
            { requirementId: wait.id, status: 'superseded', resolvedQuote: wait.quote,
                evidence: [{ quote: changedQuote, source: { itemId: target.span.itemId, blockId: target.span.blockId } }] }];
            resolutionsSeen++;
        }
        return parser.result(request, { attemptId: request.attemptId, blocks: [{ type: 'text', text: JSON.stringify(digest) }], complete: true,
            stop: { kind: 'completed' }, toolCalls: [], problems: [], usage: {} }, { bodyHash: 'offline-fixed-model' });
    } };
    const generated = await generateCompaction({ candidate, priorView: port.capture.view, port, sources, model, signal: new AbortController().signal });
    assert.equal(generated.state, 'ready');
    assert.equal(generated.folds.length, 1);
    assert.equal(generated.nextView.nodes.length, 1);
    assert.ok(Number.isSafeInteger(generated.nextView.requirementGuidanceCursor));
    assert.equal(resolutionsSeen, 1);
    const receiptKey = { conversationId: port.capture.conversationId, commandId: 'requirement-lifecycle-publication' };
    await port.publishCandidate({ candidate: generated, receiptKey });
    const records = mergeRequirements(generated.nextView.nodes.map(child => child.unresolved));
    assert.equal(activeRequirements(records).some(record => record.id === old.id), false);
    assert.equal(activeRequirements(records).some(record => record.id === wait.id), false);
    assert.ok(activeRequirements(records).some(record => record.parentRequirementId === old.id));
});

for (const inheritedCount of [0, 70]) test(`real SQLite StoreCompactionPort inspect -> prepare enriches ordinary assistant metadata with ${inheritedCount} other inherited sources`, async () => {
    const root = await mkdtemp(join(process.env.REQUIREMENT_LIFECYCLE_EVIDENCE_ROOT ?? tmpdir(), 'requirement-real-port-'));
    const store = await openAgentStore({ dataDir: root });
    const conversationId = randomUUID();
    const roundIds = Array.from({ length: 5 }, () => randomUUID());
    const oldRunId = randomUUID();
    const acknowledgmentRunId = randomUUID();
    const activeRunId = randomUUID();
    const quote = '本轮只确认这些约定。';
    const acknowledgment = '这些约定已经逐项确认，现采用33°C标准。';
    const config = fixtureConfig({ policy: { keepCompleteRounds: 2, referenceTokens: 1000 } });
    const lease = { kind: 'task', conversationId, runId: activeRunId, runEpoch: 2, rootBudgetId: activeRunId,
        roundId: roundIds[4], stepId: randomUUID(), deadlineAt: '2099-01-01T00:00:00.000Z' };
    const record = (kind, id, value) => ({ key: { conversationId, kind, id }, revision: 1, value });
    const records = [record('conversation', conversationId, { conversationId, principalId: 'requirement-real-port', state: 'open',
        retention: { mode: 'archive' }, options: {}, activeRunId, historyEpoch: 1, appendSeq: 9, viewRevision: 0,
        workspaceRevision: 0, runEpoch: 2, eventSeq: '0', eventGeneration: randomUUID(), historyRoot: 'requirement-real-port-root' }),
    record('run', oldRunId, { conversationId, runId: oldRunId, rootRunId: oldRunId, kind: 'task', runEpoch: 1,
        state: 'failed', activeRoundId: null, cleanupState: 'released', internalOwnCleanupState: 'released' }),
    record('run', acknowledgmentRunId, { conversationId, runId: acknowledgmentRunId, rootRunId: acknowledgmentRunId, kind: 'task', runEpoch: 1,
        state: 'succeeded', activeRoundId: null, cleanupState: 'released', internalOwnCleanupState: 'released' }),
    record('run', activeRunId, { ...lease, rootRunId: activeRunId, state: 'running', activeRoundId: roundIds[4] }),
    { key: contextStateKey(conversationId), revision: 1, value: { ...initialContextState(), execution: lease,
        compressionGeneration: randomUUID(), effectiveModelFingerprint: config.modelFingerprint } }];
    const contents = [];
    const add = (ordinal, role, text, runId) => {
        const stepId = randomUUID();
        const contentId = randomUUID();
        contents.push({ conversationId, contentId, kind: role === 'assistant' ? 'model_step' : 'user', value: { text },
            indexHistory: true, history: { role, roundId: roundIds[ordinal], stepId, runId, runEpoch: 1, view: 'raw', effective: true } });
        if (role === 'assistant') records.push(record('step', stepId, { kind: 'model', complete: true, toolCalls: [], resolvedCallIds: [] }));
        return contentId;
    };
    const inheritedContents = Array.from({ length: inheritedCount }, (_, index) => {
        const text = `历史要求${index}继续保留，等待后续完成。`;
        return { contentId: add(0, 'user', text, oldRunId), text };
    });
    const originalContentId = add(0, 'user', quote, oldRunId);
    add(0, 'assistant', '留待下一轮确认。', oldRunId);
    add(1, 'user', '现在逐项确认前面的约定。', acknowledgmentRunId);
    const acknowledgmentContentId = add(1, 'assistant', acknowledgment, acknowledgmentRunId);
    for (let ordinal = 2; ordinal <= 3; ordinal++) {
        add(ordinal, 'user', `继续提供资料${ordinal}`, null);
        add(ordinal, 'assistant', `已接收资料${ordinal}`, null);
    }
    add(4, 'user', '当前活动任务继续，保留原文。', activeRunId);
    records[0].value.appendSeq = contents.length;
    const port = new StoreCompactionPort(store);
    try {
        await store.commitTransition({ expected: records.map(entry => ({ key: entry.key, revision: null })), records, contents });
        const history = { items: [] };
        let cursor;
        const cursors = new Set();
        do {
            const page = await store.readHistory({ conversationId, view: 'raw', effectiveOnly: true, includeValues: false, limit: 200, cursor });
            history.items.push(...page.items);
            cursor = page.nextCursor ?? undefined;
            assert.ok(!page.hasMore || cursor);
            assert.ok(!cursor || !cursors.has(cursor));
            if (cursor) cursors.add(cursor);
        } while (cursor);
        const originalItem = history.items.find(item => item.contentId === originalContentId);
        const acknowledgmentItem = history.items.find(item => item.contentId === acknowledgmentContentId);
        assert.ok(originalItem && acknowledgmentItem);
        const sources = createHistorySourcePort(store, { conversationId });
        const originalBlock = (await sources.describe(originalItem)).find(block => block.blockId === 'text');
        const original = { id: randomUUID(), quote, source: { itemId: originalItem.itemId, blockId: originalBlock.blockId, startByte: 0,
            endByte: Buffer.byteLength(quote), sha256: hashBytes(quote), blockHash: originalBlock.sha256, purpose: 'target' } };
        const inherited = [];
        for (const entry of inheritedContents) {
            const item = history.items.find(item => item.contentId === entry.contentId);
            const block = (await sources.describe(item)).find(block => block.blockId === 'text');
            inherited.push({ id: randomUUID(), quote: entry.text, source: { itemId: item.itemId, blockId: block.blockId, startByte: 0,
                endByte: Buffer.byteLength(entry.text), sha256: hashBytes(entry.text), blockHash: block.sha256, purpose: 'target' } });
        }
        const { hash: priorHash, ...priorContent } = node([...inherited, original]);
        const coveredEndSeq = inheritedCount + 2;
        const priorNode = sealSummaryNode({ ...priorContent, firstSeq: 1, lastSeq: coveredEndSeq, roundIds: [roundIds[0]] });
        const viewContentId = randomUUID();
        const conversationKey = { conversationId, kind: 'conversation', id: conversationId };
        const conversation = await store.getRecord(conversationKey);
        const state = await store.getRecord(contextStateKey(conversationId));
        await store.commitTransition({ expected: [{ key: conversationKey, revision: conversation.revision }, { key: state.key, revision: state.revision }],
            records: [{ ...conversation, revision: conversation.revision + 1, value: { ...conversation.value, viewRevision: 1 } },
                { ...state, revision: state.revision + 1, value: { ...state.value, viewContentId } }],
            contents: [contextContent(conversationId, viewContentId, 'context_view', { revision: 1, historyEpoch: 1, coveredEndSeq, nodes: [priorNode] })] });
        const capture = await port.inspect(conversationId);
        assert.equal(capture.rounds.find(round => round.roundId === roundIds[1]).terminalOutcome, undefined);
        const metadataQueries = [];
        const readMetadata = port.readRequirementSourceMetadata.bind(port);
        port.readRequirementSourceMetadata = async input => {
            assert.ok(input.itemIds.length <= 64);
            metadataQueries.push([...input.itemIds]);
            return readMetadata(input);
        };
        const candidate = await prepareCompaction({ port, sources, capture, config, execution: lease, reason: 'manual' });
        assert.ok(metadataQueries.flat().includes(acknowledgmentItem.itemId));
        if (inheritedCount > 64) assert.ok(metadataQueries.length > 1);
        const enriched = candidate.snapshot.requirementSourceMetadata.find(item => item.itemId === acknowledgmentItem.itemId);
        if (!enriched.terminalOutcome) console.log(JSON.stringify({ enrichmentDiagnostic: {
            item: acknowledgmentItem,
            metadata: await store.readHistoryMetadata({ conversationId, historyEpoch: 1, itemIds: [acknowledgmentItem.itemId] }),
            portMetadata: await port.readRequirementSourceMetadata({ conversationId, historyEpoch: 1, itemIds: [acknowledgmentItem.itemId] }),
            run: await store.getRecord({ conversationId, kind: 'run', id: acknowledgmentRunId }) } }));
        assert.equal(enriched.role, 'assistant');
        assert.equal(enriched.seq, acknowledgmentItem.seq);
        assert.deepEqual(enriched.terminalOutcome, { state: 'succeeded', stopReason: null });
        const block = candidate.snapshot.manifest.blocks.find(entry => entry.itemId === acknowledgmentItem.itemId && entry.blockId === 'text');
        assert.ok(block);
        const resolved = await applyRequirementResolutions({ records: [...inherited, original], resolutions: [{ requirementId: original.id, status: 'fulfilled',
            resolvedQuote: original.quote, evidence: [{ quote: acknowledgment, source: { itemId: block.itemId, blockId: block.blockId, startByte: 0,
                endByte: Buffer.byteLength(acknowledgment), sha256: hashBytes(acknowledgment), blockHash: block.sha256, purpose: 'target' } }] }],
        snapshot: candidate.snapshot, sources, signal: new AbortController().signal });
        assert.equal(activeRequirements(resolved).length, inheritedCount);
        const fulfilled = resolved.find(record => record.id === original.id);
        assert.equal(fulfilled.resolution.status, 'fulfilled');
        assert.equal(fulfilled.resolution.conversationId, conversationId);
        console.log(JSON.stringify({ realStoreSourceMetadata: true, ownedSqlite: root, conversationId,
            originalSeq: originalItem.seq, evidenceSeq: acknowledgmentItem.seq, inspectAssistantOutcome: null,
            preparedAssistantOutcome: enriched.terminalOutcome, inheritedCount, metadataQuerySizes: metadataQueries.map(ids => ids.length),
            remaining: activeRequirements(resolved).length, coreStarts: 0 }));
    } finally {
        port.releaseConversation(conversationId);
        await store.close();
    }
});
