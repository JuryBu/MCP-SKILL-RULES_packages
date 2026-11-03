import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { renderSummary, sealSummaryNode } from '../../../src/agent-server/context/view.ts';
import { hashBytes } from '../../../src/agent-server/context/config.ts';
import { createFixture } from './context-fixtures.mjs';

function fixtureRequirements(count = 15, shared = true) {
    return Array.from({ length: count }, (_, index) => {
        const quote = `Keep the accepted rule ${index} and finish the outstanding report.`;
        return { id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, quote,
            source: { itemId: shared ? `${'a'.repeat(64)}:${index}` : `${String(index).padStart(64, 'b')}:entry`,
                blockId: 'text', startByte: index * 100, endByte: index * 100 + Buffer.byteLength(quote),
                sha256: hashBytes(quote), blockHash: 'c'.repeat(64), purpose: 'target' } };
    });
}

function node(requirements) {
    return sealSummaryNode({ kind: 'batch', nodeId: 'render-fixture', firstSeq: 1, lastSeq: 30,
        roundIds: [], sourceSpans: [], chunkIds: [], parentBatchIds: [], modelFingerprint: 'fixture',
        body: 'Verified working facts.', skeleton: 'Working index.', title: 'Current task', unresolved: requirements, anchors: [] });
}

function decodeRows(text) {
    const lines = text.split('\n');
    const sourceLine = lines.find(line => line.startsWith('Source items: '));
    assert.ok(sourceLine, 'The visible source table must be present');
    const sources = JSON.parse(sourceLine.slice('Source items: '.length));
    const start = lines.findIndex(line => line.startsWith('Rows=[requirementId,'));
    assert.ok(start >= 0);
    return lines.slice(start + 1).filter(line => line.startsWith('[')).map(line => {
        const [id, quote, sourceItemIndex, blockId, startByte, endByte] = JSON.parse(line);
        return { id, quote, source: { itemId: sources.prefix + sources.suffixes[sourceItemIndex], blockId, startByte, endByte } };
    });
}

function verifyAddresses(text, requirements) {
    const decoded = decodeRows(text);
    assert.equal(decoded.length, requirements.length);
    for (const [index, requirement] of requirements.entries()) {
        const { itemId, blockId, startByte, endByte } = requirement.source;
        assert.deepEqual(decoded[index], { id: requirement.id, quote: requirement.quote, source: { itemId, blockId, startByte, endByte } });
    }
}

test('visible requirement rows fit without forwarding duplicate proof hashes or changing the archived source', () => {
    const requirements = fixtureRequirements();
    const summary = node(requirements);
    const before = JSON.stringify(summary);
    const rendered = renderSummary([summary], createFixture().config.policy, 3500);
    verifyAddresses(rendered.text, requirements);
    assert.ok(!rendered.text.includes(requirements[0].source.blockHash));
    assert.ok(!rendered.text.includes(requirements[0].source.sha256));
    assert.equal(JSON.stringify(summary), before);
    assert.equal(summary.unresolved[0].source.blockHash, 'c'.repeat(64));
});

test('source aliases reconstruct unrelated identifiers and exact escaped quotes', () => {
    const requirements = fixtureRequirements(3, false);
    requirements[0].quote = '保持「原句」\nincluding "quotes" and \\ paths';
    requirements[0].source.endByte = Buffer.byteLength(requirements[0].quote);
    const rendered = renderSummary([node(requirements)], createFixture().config.policy);
    verifyAddresses(rendered.text, requirements);
});

test('source item prefixes preserve complete Unicode characters', () => {
    const requirements = fixtureRequirements(2);
    requirements[0].source.itemId = 'shared-prefix-long-🐈:first';
    requirements[1].source.itemId = 'shared-prefix-long-🐉:second';
    const rendered = renderSummary([node(requirements)], createFixture().config.policy);
    verifyAddresses(rendered.text, requirements);
    const sources = JSON.parse(rendered.text.split('\n').find(line => line.startsWith('Source items: ')).slice(14));
    assert.equal(sources.prefix, 'shared-prefix-long-');
});

test('optional original failed batches retain every active quote and address within their original request allowance', async () => {
    if (!process.env.SUMMARY_RENDERING_ORIGINAL) return;
    const paths = JSON.parse(await readFile(process.env.SUMMARY_RENDERING_ORIGINAL, 'utf8'));
    for (const file of paths) {
        const candidate = JSON.parse(await readFile(file, 'utf8'));
        const before = JSON.stringify(candidate.batch);
        const rendered = renderSummary([candidate.batch], candidate.snapshot.config.policy, candidate.snapshot.requestBudget.summaryBudget);
        const requirements = candidate.batch.unresolved.filter(requirement => !requirement.resolvedBy?.length);
        verifyAddresses(rendered.text, requirements);
        assert.equal(JSON.stringify(candidate.batch), before);
        console.log(JSON.stringify({ source: file, activeRequirements: requirements.length, summaryTokens: rendered.tokens,
            summaryBudget: candidate.snapshot.requestBudget.summaryBudget, originalMinimumTokens: candidate.error.details.summaryTokens,
            originalRecordsChanged: false, paidRequests: 0 }));
    }
});
