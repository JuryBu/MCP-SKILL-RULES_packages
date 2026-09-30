import assert from "node:assert/strict";
import test from "node:test";
import { createRequestProgressTracker, mergeRequestProgressState } from "../src/request-wait-budget.mjs";

test("sequence identities survive retries while equal text with fresh sequences remains progress", () => {
  const first = createRequestProgressTracker(null, "attempt-1");
  assert.equal(first.observe({ type: "response.created", sequence_number: 0, response: { id: "response-1" } }), true);
  const delta = { type: "response.reasoning_text.delta", sequence_number: 2, item_id: "item-1", delta: "same" };
  assert.equal(first.observe(delta), true);
  assert.equal(first.observe(delta), false);
  assert.equal(first.observe({ ...delta, sequence_number: 1 }), false);
  assert.equal(first.observe({ ...delta, sequence_number: 3 }), true);
  const retry = createRequestProgressTracker(first.snapshot(), "attempt-2");
  assert.equal(retry.observe({ type: "response.created", sequence_number: 0, response: { id: "response-1" } }), false);
  assert.equal(retry.observe(delta), false);
  assert.equal(retry.observe({ ...delta, sequence_number: 4 }), true);
  assert.equal(retry.observe({ type: "response.created", sequence_number: 0, response: { id: "response-2" } }), true);
  assert.equal(retry.observe(delta), true);
});

test("completed-item identity is retained without deduplicating unsequenced text", () => {
  const first = createRequestProgressTracker(null, "attempt-1");
  first.observe({ type: "response.created", response: { id: "response-1" } });
  const done = { type: "response.output_item.done", item: { id: "item-1", type: "reasoning" } };
  assert.equal(first.observe(done), true);
  assert.equal(first.observe(done), false);
  const retry = createRequestProgressTracker(first.snapshot(), "attempt-2");
  retry.observe({ type: "response.created", response: { id: "response-1" } });
  assert.equal(retry.observe(done), false);
  const delta = { type: "response.reasoning_text.delta", delta: "same" };
  assert.equal(retry.observe(delta), true);
  assert.equal(retry.observe(delta), true);
});

test("concurrent progress snapshots merge monotonically and saturated identities are never evicted", () => {
  const combined = mergeRequestProgressState({ sequences: [["response-1", 10]], completedItems: ["done-1"] },
    { sequences: [["response-1", 2], ["response-2", 1]], completedItems: ["done-2"] });
  assert.deepEqual(combined.sequences, [["response-1", 10], ["response-2", 1]]);
  const tracker = createRequestProgressTracker(combined, "attempt-3");
  for (let index = 3; index <= 66; index += 1) tracker.observe({ type: "response.created",
    sequence_number: 0, response: { id: `response-${index}` } });
  assert.equal(tracker.snapshot().saturated, true);
  assert.equal(tracker.observe({ type: "response.created", sequence_number: 0, response: { id: "response-1" } }), false);
});
