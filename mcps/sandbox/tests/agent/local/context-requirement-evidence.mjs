import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { activeRequirements, applyRequirementResolutions } from '../../../src/agent-server/context/requirements.ts';
import { COMPRESSION_INSTRUCTIONS } from '../../../src/agent-server/context/server-adapter.ts';
import { hashBytes } from '../../../src/agent-server/context/config.ts';
import { fixtureConfig } from './context-fixtures.mjs';

function fixture(originalQuote, evidenceQuote, role = 'user', state = 'succeeded') {
    const texts = [originalQuote, evidenceQuote];
    const blocks = texts.map((text, index) => ({ itemId: `opaque-${index}`, blockId: 'text', contentId: `content-${index}`,
        seq: index ? 7 : 1, roundId: `round-${index}`, kind: 'text', byteLength: Buffer.byteLength(text), sha256: hashBytes(text), retrieval: {} }));
    const anchor = index => ({ id: `requirement-${index}`, quote: texts[index], source: { itemId: blocks[index].itemId, blockId: 'text',
        startByte: 0, endByte: blocks[index].byteLength, sha256: blocks[index].sha256, blockHash: blocks[index].sha256, purpose: 'target' } });
    const original = anchor(0);
    const later = anchor(1);
    const snapshot = { conversationId: 'requirement-evidence-fixture', historyEpoch: 1, snapshotAppendSeq: 7, config: fixtureConfig(),
        manifest: { blocks, rounds: [] }, referenceBlocks: [], requirementSourceMetadata: blocks.map((block, index) => ({
            itemId: block.itemId, seq: block.seq, role: index ? role : 'user', roundId: block.roundId,
            ...(state ? { terminalOutcome: { state, stopReason: null } } : {}) })) };
    const sources = { describe: async () => blocks, read: async request => Buffer.from(texts[blocks.findIndex(block => block.itemId === request.block.itemId)])
        .subarray(request.startByte, request.endByte) };
    const proposal = (status, resolvedQuote = originalQuote) => ({ requirementId: original.id, status, resolvedQuote,
        evidence: [{ quote: later.quote, source: later.source }] });
    const apply = (resolutions, records = [original, later], changedSnapshot = snapshot) => applyRequirementResolutions({
        records, resolutions, snapshot: changedSnapshot, sources, signal: new AbortController().signal });
    return { original, later, snapshot, sources, proposal, apply };
}

test('superseded requires later real user metadata, including known replacement anchors', async () => {
    for (const role of ['assistant', 'tool', 'system', undefined]) {
        const value = fixture('Keep the unfinished final report.', 'I will retain the final report and complete it later.', role);
        if (role === undefined) delete value.snapshot.requirementSourceMetadata[1].role;
        for (const replacement of [false, true]) {
            const proposal = value.proposal('superseded');
            if (replacement) proposal.replacementRequirementId = value.later.id;
            const records = await value.apply([proposal]);
            assert.ok(activeRequirements(records).some(record => record.id === value.original.id), `${role}, replacement=${replacement}`);
        }
    }
});

test('known assistant anchor outside frozen blocks cannot cancel a user obligation', async () => {
    const value = fixture('Keep the unfinished final report.', 'Confirmed; I will do that.', 'assistant');
    value.snapshot.manifest.blocks = value.snapshot.manifest.blocks.slice(0, 1);
    const records = await value.apply([{ ...value.proposal('superseded'), replacementRequirementId: value.later.id }]);
    assert.ok(activeRequirements(records).some(record => record.id === value.original.id));
});

test('user 32-to-33 correction resolves only the threshold and retains four sections plus final report', async () => {
    const originalQuote = '报告中文，分「范围、方法、结果、待核」四节。初始异常标准是温度>=32且湿度>=75，最终报告稍后统一写。';
    const value = fixture(originalQuote, '更正异常标准：温度>=33且湿度>=75，其余格式和最终报告任务保留。');
    const originalBefore = structuredClone(value.original);
    const records = await value.apply([{ ...value.proposal('superseded', '初始异常标准是温度>=32且湿度>=75'),
        replacementRequirementId: value.later.id }]);
    const retired = records.find(record => record.id === value.original.id);
    assert.equal(retired.resolution.status, 'superseded');
    assert.equal(retired.quote, originalQuote);
    assert.deepEqual(retired.source, originalBefore.source);
    assert.deepEqual(value.original, originalBefore);
    const remainders = activeRequirements(records).filter(record => record.parentRequirementId === value.original.id);
    assert.deepEqual(remainders.map(record => record.quote), ['报告中文，分「范围、方法、结果、待核」四节', '最终报告稍后统一写']);
    assert.deepEqual(retired.resolution.remainingIds, remainders.map(record => record.id));
    for (const record of remainders) {
        assert.equal(Buffer.from(originalQuote).subarray(record.source.startByte, record.source.endByte).toString(), record.quote);
        assert.equal(record.source.sha256, hashBytes(record.quote));
        assert.equal(record.source.blockHash, value.original.source.blockHash);
    }
});

test('later user withdrawal needs no assistant completion or successful user round', async () => {
    const value = fixture('Write the final report.', 'Cancel the final report.', 'user', undefined);
    delete value.snapshot.requirementSourceMetadata[1].terminalOutcome;
    const records = await value.apply([value.proposal('superseded')]);
    assert.equal(records.find(record => record.id === value.original.id).resolution.status, 'superseded');
});

test('replacement chains advance by real later user metadata and reject a backward cycle', async () => {
    const value = fixture('Threshold >=32.', 'Change the threshold to >=33.');
    const first = await value.apply([{ ...value.proposal('superseded'), replacementRequirementId: value.later.id }]);
    const nextQuote = 'Change the threshold to >=34.';
    const nextSource = { ...value.later.source, itemId: 'opaque-next', endByte: Buffer.byteLength(nextQuote),
        sha256: hashBytes(nextQuote), blockHash: hashBytes(nextQuote) };
    const next = { id: 'next-user-requirement', quote: nextQuote, source: nextSource };
    value.snapshot.snapshotAppendSeq = 20;
    value.snapshot.requirementSourceMetadata.push({ itemId: nextSource.itemId, seq: 20, role: 'user', roundId: null });
    const chained = await value.apply([{ requirementId: value.later.id, status: 'superseded', resolvedQuote: value.later.quote,
        replacementRequirementId: next.id, evidence: [{ quote: next.quote, source: next.source }] }], [...first, next]);
    assert.equal(chained.find(record => record.id === value.later.id).resolution.replacementRequirementId, next.id);
    const cycle = await value.apply([{ requirementId: next.id, status: 'superseded', resolvedQuote: next.quote,
        evidence: [{ quote: value.original.quote, source: value.original.source }] }], chained);
    assert.ok(activeRequirements(cycle).some(record => record.id === next.id));
});

test('successful scope reply fulfills just the reply clause and preserves the ongoing report remainder', async () => {
    const value = fixture('请简短说明这批核查范围，并保持此前未完成的最终报告任务。', '本批核查三个区域，最终报告任务仍待完成。', 'assistant');
    const records = await value.apply([value.proposal('fulfilled', '请简短说明这批核查范围')]);
    const retired = records.find(record => record.id === value.original.id);
    assert.equal(retired.resolution.status, 'fulfilled');
    assert.equal(retired.quote, value.original.quote);
    const remainder = activeRequirements(records).find(record => record.parentRequirementId === value.original.id);
    assert.equal(remainder.quote, '并保持此前未完成的最终报告任务');
    assert.equal(Buffer.from(value.original.quote).subarray(remainder.source.startByte, remainder.source.endByte).toString(), remainder.quote);
    assert.deepEqual(retired.resolution.remainingIds, [remainder.id]);
});

test('actual report write/read-back can fulfill while failed, cancelled and unclosed actions cannot', async () => {
    for (const role of ['tool', 'assistant']) {
        const value = fixture('Write and verify the final report.', 'Wrote report.md, read it back, and verified all four sections.', role);
        assert.equal(activeRequirements(await value.apply([value.proposal('fulfilled')])).some(record => record.id === value.original.id), false);
        for (const state of ['failed', 'cancelled', undefined]) {
            const snapshot = structuredClone(value.snapshot);
            if (state) snapshot.requirementSourceMetadata[1].terminalOutcome.state = state;
            else delete snapshot.requirementSourceMetadata[1].terminalOutcome;
            assert.ok(activeRequirements(await value.apply([value.proposal('fulfilled')], undefined, snapshot)).some(record => record.id === value.original.id));
        }
    }
});

test('superseded rejects old, future, changed-byte and mismatched-block evidence', async () => {
    for (const change of ['old', 'future', 'hash', 'blockHash', 'range']) {
        const value = fixture('Threshold >=32; report still due.', 'Change the threshold to >=33.');
        const proposal = value.proposal('superseded', 'Threshold >=32');
        if (change === 'old') value.snapshot.requirementSourceMetadata[1].seq = 1;
        if (change === 'future') value.snapshot.requirementSourceMetadata[1].seq = 8;
        if (change === 'hash') proposal.evidence[0].source.sha256 = hashBytes('different');
        if (change === 'blockHash') proposal.evidence[0].source.blockHash = hashBytes('different block');
        if (change === 'range') proposal.evidence[0].source.startByte = 1;
        const records = await value.apply([proposal]);
        assert.ok(activeRequirements(records).some(record => record.id === value.original.id), change);
    }
});

test('instructions distinguish user cancellation, conversational completion, promise and ongoing obligations', () => {
    for (const phrase of ['trusted later user source', 'assistant or tool restatement', 'acknowledgment is not delivery',
        'smallest exact resolvedQuote', 'original format', 'numerical threshold change', 'ongoing report remains active']) {
        assert.ok(COMPRESSION_INSTRUCTIONS.includes(phrase), phrase);
    }
});

test('prepareView preserves explicit overrides without injecting a derived summary allowance', async () => {
    const source = await readFile(new URL('../../../src/agent-server/context/server-adapter.ts', import.meta.url), 'utf8');
    const prepareView = source.slice(source.indexOf('const prepareView = service.createPrepareView'), source.indexOf('const postStep ='));
    assert.ok(prepareView.includes('...overrides'));
    assert.ok(prepareView.includes('compression: binding'));
    assert.doesNotMatch(prepareView, /summaryBudget:\s*binding\.limits\.summaryBudget/);
});
