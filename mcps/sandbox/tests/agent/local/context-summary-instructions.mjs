import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPRESSION_INSTRUCTIONS, ProviderCompressionModelPort } from '../../../src/agent-server/context/server-adapter.ts';

function parsedResult(digest, payload = { targets: [] }, snapshot = {}) {
    const model = new ProviderCompressionModelPort({});
    return model.result({ attemptId: 'request-1', inputBodyHash: 'body-hash', reason: 'background',
        snapshot: { effectiveModelFingerprint: 'model-1', ...snapshot }, chunk: { inputBodyHash: 'body-hash', body: JSON.stringify(payload), sourceSpans: [] } },
    { attemptId: 'provider-1', blocks: [{ type: 'text', text: JSON.stringify(digest) }], complete: true,
        stop: { kind: 'completed' }, toolCalls: [], problems: [], usage: {} }, { bodyHash: 'frozen-body-hash' });
}

test('working-memory instructions retain decisions, corrections, outcomes and source-grounded unfinished requirements', () => {
    for (const requirement of ['current user goal', 'exact identifiers, numbers, units, formulas', 'corrections', 'superseded values',
        'actual outputs', 'remaining uncertainty', 'exact quote', 'source itemId/blockId', 'Compress only targets',
        'useful-history feedback', 'unresolved obligations', 'concrete facts']) assert.ok(COMPRESSION_INSTRUCTIONS.includes(requirement), requirement);
    assert.match(COMPRESSION_INSTRUCTIONS, /test fixture result.*unverified claim.*failed action/);
});

test('structurally shaped but blank summary fields cannot become a complete compression result', () => {
    const digest = { body: 'Current threshold is 33 degrees.', skeleton: 'Threshold 33; source item-1.', title: 'Sensor task', unresolved: [] };
    assert.equal(parsedResult(digest).complete, true);
    for (const field of ['body', 'skeleton', 'title']) assert.equal(parsedResult({ ...digest, [field]: ' \n ' }).complete, false, field);
});

test('unresolved source accepts equivalent nested and top-level identities without guessing another item', () => {
    const text = '请保留全部三个区域，最终报告稍后写。';
    const span = { itemId: 'source-item', blockId: 'text', startByte: 0, endByte: Buffer.byteLength(text),
        sha256: 'source-hash', blockHash: 'source-hash', purpose: 'target' };
    const source = { itemId: span.itemId, blockId: span.blockId };
    const digest = { body: '保留三个区域，最终报告待写。', skeleton: '三个区域；待写报告。', title: '巡检范围',
        unresolved: [{ quote: '最终报告稍后写。', source }] };
    const nested = parsedResult(digest, { targets: [{ text, span }] });
    const flat = parsedResult({ ...digest, unresolved: [{ quote: '最终报告稍后写。', ...source }] }, { targets: [{ text, span }] });
    assert.equal(nested.complete, true);
    assert.equal(flat.complete, true);
    assert.deepEqual(flat.digest.unresolved, nested.digest.unresolved);
    assert.equal(flat.usage.digestValidation, 'valid');
    const wrong = parsedResult({ ...digest, unresolved: [{ quote: '最终报告稍后写。', itemId: 'different-item', blockId: 'text' }] },
        { targets: [{ text, span }] });
    assert.equal(wrong.complete, false);
    assert.equal(wrong.usage.digestValidation, 'unresolved source ambiguous');
});

test('reference-only requirements remain outside target coverage and report a concrete validation reason', () => {
    const payload = { targets: [{ text: '记录已读。', span: { itemId: 'target', blockId: 'text', startByte: 0 } }],
        references: [{ text: '最终报告须读回。', span: { itemId: 'reference', blockId: 'text', startByte: 0 } }] };
    const result = parsedResult({ body: '已读记录。', skeleton: '记录已读。', title: '读取',
        unresolved: [{ quote: '最终报告须读回。', source: { itemId: 'reference', blockId: 'text' } }] }, payload);
    assert.equal(result.complete, false);
    assert.equal(result.usage.digestValidation, 'unresolved source ambiguous');
    assert.equal(result.usage.providerComplete, true);
    assert.equal(result.usage.providerStop, 'completed');
    assert.match(COMPRESSION_INSTRUCTIONS, /Never add unresolved entries quoted only from references/);
    assert.match(COMPRESSION_INSTRUCTIONS, /"source":\{"itemId"/);
});

test('unique exact Chinese quotes with explicit item and block derive host byte offsets and retain the model offset diagnostic', () => {
    const text = '统计方法确认：每个区分别统计有效记录数。';
    const quote = '每个区分别统计有效记录数';
    const span = { itemId: 'methods', blockId: 'text', startByte: 120, endByte: 120 + Buffer.byteLength(text),
        sha256: 'source-hash', blockHash: 'source-hash', purpose: 'target' };
    const payload = { targets: [{ text, span }] };
    const digest = { body: '按区统计有效记录数。', skeleton: '按区计数。', title: '方法',
        unresolved: [{ quote, source: { itemId: 'methods', blockId: 'text', startByte: 8 } }] };
    const result = parsedResult(digest, payload);
    const actualStart = 120 + Buffer.byteLength('统计方法确认：');
    assert.equal(result.complete, true);
    assert.equal(result.digest.unresolved[0].source.startByte, actualStart);
    assert.equal(result.digest.unresolved[0].source.endByte, actualStart + Buffer.byteLength(quote));
    assert.deepEqual(result.usage.normalizedRequirementSources, [{ itemId: 'methods', blockId: 'text', providedStartByte: 8,
        startByte: actualStart, endByte: actualStart + Buffer.byteLength(quote) }]);
    assert.equal(digest.unresolved[0].source.startByte, 8);
    for (const source of [{ itemId: 'different', blockId: 'text', startByte: 8 }, { itemId: 'methods', blockId: 'different', startByte: 8 },
        { blockId: 'text', startByte: 8 }, { itemId: 'methods', startByte: 8 },
        { itemId: 'methods', blockId: 'text', startByte: -1 }, { itemId: 'methods', blockId: 'text', startByte: 1.5 }]) {
        assert.equal(parsedResult({ ...digest, unresolved: [{ quote, source }] }, payload).complete, false);
    }
    assert.equal(parsedResult({ ...digest, unresolved: [{ ...digest.unresolved[0], quote: '虚构的要求' }] }, payload).complete, false);
    assert.match(COMPRESSION_INSTRUCTIONS, /host computes its exact UTF-8 byte offset/);
});

test('repeated quotes still require an exact offset and never select a guessed occurrence', () => {
    const text = '待核；待核。';
    const span = { itemId: 'repeated', blockId: 'text', startByte: 0, endByte: Buffer.byteLength(text),
        sha256: 'source-hash', blockHash: 'source-hash', purpose: 'target' };
    const payload = { targets: [{ text, span }] };
    const digest = { body: '两处待核。', skeleton: '待核。', title: '核验',
        unresolved: [{ quote: '待核', source: { itemId: 'repeated', blockId: 'text' } }] };
    assert.equal(parsedResult(digest, payload).complete, false);
    assert.equal(parsedResult({ ...digest, unresolved: [{ quote: '待核', source: { itemId: 'repeated', blockId: 'text', startByte: 3 } }] }, payload).complete, false);
    const result = parsedResult({ ...digest, unresolved: [{ quote: '待核', source: { itemId: 'repeated', blockId: 'text', startByte: 9 } }] }, payload);
    assert.equal(result.complete, true);
    assert.equal(result.digest.unresolved[0].source.startByte, 9);
    assert.deepEqual(result.usage.normalizedRequirementSources, []);
    assert.equal(parsedResult({ ...digest, unresolved: [{ quote: '待核', source: { itemId: 'repeated', blockId: 'text', startByte: 3 } }] },
        { targets: [{ text: '待核', span }, { text: '待核', span }] }).complete, false);
});

test('normal exact quote matching requires both source identities with omitted or correct offsets', () => {
    const text = '待写最终报告。';
    const span = { itemId: 'task', blockId: 'text', startByte: 0, endByte: Buffer.byteLength(text),
        sha256: 'source-hash', blockHash: 'source-hash', purpose: 'target' };
    const payload = { targets: [{ text, span }] };
    const digest = { body: '最终报告待写。', skeleton: '待写报告。', title: '报告', unresolved: [] };
    for (const entry of [{ quote: text }, { quote: text, source: {} }, { quote: text, source: { itemId: 'task' } },
        { quote: text, source: { blockId: 'text' } }, { quote: text, source: { itemId: 'task', startByte: 0 } },
        { quote: text, source: { blockId: 'text', startByte: 0 } }, { quote: text, itemId: 'task' }]) {
        const result = parsedResult({ ...digest, unresolved: [entry] }, payload);
        assert.equal(result.complete, false);
        assert.equal(result.usage.digestValidation, 'unresolved source identity');
    }
    assert.equal(parsedResult({ ...digest, unresolved: [{ quote: text, source: { itemId: 'task', blockId: 'text' } }] }, payload).complete, true);
});

test('one extra requirement uniquely grounded in preserved raw tail cannot discard a valid target digest', () => {
    const target = { text: '保留全部区域。', span: { itemId: 'target', blockId: 'text', startByte: 0,
        endByte: 21, purpose: 'target', blockHash: 'target-hash' } };
    const reference = { text: '最终报告须读回。', span: { itemId: 'reference', blockId: 'text', startByte: 0,
        endByte: 24, purpose: 'reference', blockHash: 'reference-hash' } };
    const payload = { targets: [target], references: [reference] };
    const snapshot = { manifest: { rounds: [{ lastSeq: 5 }] }, referenceBlocks: [{ itemId: 'reference', blockId: 'text',
        seq: 8, byteLength: 24, sha256: 'reference-hash' }] };
    const valid = { quote: target.text, source: { itemId: 'target', blockId: 'text' } };
    const extra = { quote: reference.text, itemId: 'reference', blockId: 'text' };
    const digest = { body: '全部区域保留。', skeleton: '全部区域。', title: '区域范围', unresolved: [valid, extra] };
    const result = parsedResult(digest, payload, snapshot);
    assert.equal(result.complete, true);
    assert.equal(result.digest.unresolved.length, 1);
    assert.equal(result.digest.unresolved[0].quote, target.text);
    assert.equal(result.usage.omittedReferenceRequirements.length, 1);
    assert.equal(result.usage.omittedReferenceRequirements[0].purpose, 'reference');
    const cases = [
        [digest, { ...payload, references: [reference, reference] }, snapshot],
        [digest, { ...payload, targets: [target, { ...target, text: reference.text }] }, snapshot],
        [digest, payload, { ...snapshot, referenceBlocks: [{ ...snapshot.referenceBlocks[0], seq: 5 }] }],
        [digest, payload, { ...snapshot, referenceBlocks: [{ ...snapshot.referenceBlocks[0], sha256: 'different' }] }],
        [{ ...digest, unresolved: [valid, { ...extra, itemId: 'different' }] }, payload, snapshot],
        [{ ...digest, unresolved: [valid, { ...extra, quote: '并未出现的要求。' }] }, payload, snapshot],
        [{ ...digest, unresolved: [extra] }, payload, snapshot],
    ];
    for (const [changedDigest, changedPayload, changedSnapshot] of cases) {
        assert.equal(parsedResult(changedDigest, changedPayload, changedSnapshot).complete, false);
    }
});
