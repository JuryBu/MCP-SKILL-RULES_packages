import assert from 'node:assert/strict';
import test from 'node:test';
import { createReasoningProgressTracker } from '../src/reasoning-progress.mjs';

const done = (id, encrypted_content = 'synthetic-ciphertext') => ({ type: 'response.output_item.done', item: { id, type: 'reasoning', encrypted_content } });
test('unique completed encrypted reasoning is progress; repeated IDs are not', () => {
  const observe = createReasoningProgressTracker();
  assert.equal(observe(done('rs_1')), true);
  assert.equal(observe(done('rs_1')), false);
  assert.equal(observe(done('rs_1', 'changed-payload')), false);
  assert.equal(observe(done('rs_2')), true);
});
test('added, heartbeat, empty, wrong type and missing ID are not progress', () => {
  const observe = createReasoningProgressTracker();
  for (const event of [null, { type: 'ping' }, { ...done('rs_a'), type: 'response.output_item.added' }, done('rs_b', ''), done('rs_c', '   '), done(null), { type: 'response.output_item.done', item: { id: 'fc_a', type: 'function_call', encrypted_content: 'cipher' } }]) assert.equal(observe(event), false);
  assert.equal(observe(done('rs_a')), true);
});
