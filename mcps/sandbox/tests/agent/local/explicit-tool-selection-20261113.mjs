import assert from 'node:assert/strict';
import test from 'node:test';
import { selectRequestedTools } from '../../../src/agent-server/models/tool-selection.ts';

const now = Date.parse('2026-11-13T05:00:00Z');
const profile = { baseUrl: 'https://api.example.test/v1' };
const proof = { status: 'supported', value: true, source: 'manual', sourceRef: 'reviewed-contract',
    observedAt: '2026-11-13T04:00:00Z', expiresAt: '2026-11-14T04:00:00Z', version: '1', confidence: 'declared',
    scope: { endpoint: profile.baseUrl, modelId: 'model-a', routeId: null } };
const entry = tools => ({ modelId: 'model-a', routeId: null, tools });

test('explicit tools require fresh scoped evidence before any provider dispatch', () => {
    let dispatched = 0;
    for (const evidence of [{ ...proof, status: 'unknown', value: null }, { ...proof, expiresAt: '2026-11-13T04:30:00Z' },
        { ...proof, scope: { ...proof.scope, endpoint: 'https://other.example.test/v1' } }]) {
        for (const options of [{ toolsEnabled: true }, { tools: ['read_file'] }]) {
            assert.throws(() => { selectRequestedTools(options, profile, entry(evidence), now); dispatched++; },
                error => error.code === 'E_CAPABILITY_UNKNOWN');
        }
    }
    assert.equal(dispatched, 0);
});

test('explicit plain chat overrides unavailable tools and leaves the old automatic default intact', () => {
    const unknown = entry({ ...proof, status: 'unknown', value: null });
    assert.deepEqual(selectRequestedTools({ toolsEnabled: false, tools: ['read_file'] }, profile, unknown, now), []);
    assert.deepEqual(selectRequestedTools({ toolsEnabled: true, tools: [] }, profile, unknown, now), []);
    assert.deepEqual(selectRequestedTools({}, profile, unknown, now), []);
});

test('supported tools retain automatic and explicit selections', () => {
    assert.equal(selectRequestedTools({ toolsEnabled: true }, profile, entry(proof), now), null);
    assert.equal(selectRequestedTools({}, profile, entry(proof), now), null);
    assert.deepEqual(selectRequestedTools({ tools: ['read_file'] }, profile, entry(proof), now), ['read_file']);
});

test('explicitly unsupported and false declarations are reported accurately', () => {
    for (const tools of [{ ...proof, status: 'unsupported', value: null }, { ...proof, value: false }]) {
        assert.throws(() => selectRequestedTools({ toolsEnabled: true }, profile, entry(tools), now),
            error => error.code === 'E_PARAMETER_UNSUPPORTED');
    }
});
