import test from "node:test";
import assert from "node:assert/strict";
import { createAdaptiveDeliveryRegistry, deliveryProfileKey } from "../src/adaptive-delivery.mjs";

const keyFor = (account = "sample-account", model = "sample-model") => deliveryProfileKey({ "chatgpt-account-id": account }, { model }, "https://example.invalid");
const created = { type: "response.created" };
const heartbeat = { type: "keepalive" };
const delta = (text) => ({ type: "response.output_text.delta", delta: text });
function begin(registry, startedAt, extra = {}) {
  return registry.begin({ key: keyFor(), startedAt, firstProgressTimeoutMs: 40_000, waitLimitMs: 300_000, upstreamIdleTimeoutMs: 90_000, ...extra });
}
function streamed(attempt, start) {
  for (let index = 0; index < 12; index++) attempt.observe(delta("code "), start + index * 200);
}

test("profile identity requires account and model and isolates each account/model/provider", () => {
  assert.equal(deliveryProfileKey({}, { model: "model" }, "https://example.invalid"), null);
  assert.equal(deliveryProfileKey({ "chatgpt-account-id": "account" }, {}, "https://example.invalid"), null);
  assert.match(keyFor(), /^[a-f0-9]{64}$/u);
  assert.notEqual(keyFor(), keyFor("other"));
  assert.notEqual(keyFor(), keyFor("sample-account", "other"));
  assert.notEqual(keyFor(), deliveryProfileKey({ "chatgpt-account-id": "sample-account" }, { model: "sample-model" }, "https://other.invalid"));
});

test("one live probe learns buffered mode only from successful concentrated delivery", () => {
  const now = Date.now();
  const registry = createAdaptiveDeliveryRegistry();
  const attempt = begin(registry, now);
  attempt.observe(created, now + 1000);
  assert.equal(attempt.tryProbe(now + 40_000), false);
  attempt.observe(heartbeat, now + 31_000);
  assert.equal(attempt.tryProbe(now + 40_000), true);
  attempt.observe(delta("x".repeat(4000)), now + 70_000);
  attempt.complete(now + 70_100);
  assert.equal(registry.snapshot().profiles[0].mode, "buffered");
  assert.equal(begin(registry, now + 71_000).active(), true);
  assert.equal(begin(registry, now + 71_000, { key: keyFor("other") }).active(), false);
});

test("late streaming success retains forty-second default and consumes probe opportunity", () => {
  const now = Date.now();
  const events = [];
  const registry = createAdaptiveDeliveryRegistry();
  const attempt = begin(registry, now, { onEvent: event => events.push(event) });
  attempt.observe(heartbeat, now + 31_000);
  assert.equal(attempt.tryProbe(now + 40_000), true);
  streamed(attempt, now + 50_000);
  attempt.complete(now + 55_000);
  assert.equal(registry.snapshot().profiles[0].mode, "streaming");
  assert.ok(events.some(event => event.type === "adaptive_late_streaming_success"));
  const next = begin(registry, now + 60_000);
  next.observe(heartbeat, now + 91_000);
  assert.equal(next.active(), false);
  assert.equal(next.tryProbe(now + 100_000), false);
  assert.deepEqual(next.deadline(now + 100_000, "FIRST_PROGRESS_TIMEOUT"), { at: now + 100_000, reason: "FIRST_PROGRESS_TIMEOUT" });
});

test("thousands of events in one burst are not evidence of streaming restoration", () => {
  const now = Date.now();
  const registry = createAdaptiveDeliveryRegistry();
  const attempt = begin(registry, now);
  attempt.observe(heartbeat, now + 31_000);
  attempt.tryProbe(now + 40_000);
  for (let index = 0; index < 2000; index++) attempt.observe(delta("abc"), now + 70_000);
  attempt.complete(now + 70_100);
  assert.equal(registry.snapshot().profiles[0].mode, "buffered");
  const recovered = begin(registry, now + 80_000);
  streamed(recovered, now + 85_000);
  recovered.complete(now + 90_000);
  assert.equal(registry.snapshot().profiles[0].mode, "streaming");
});

test("heartbeats never move the hard cap and a silent upstream has an earlier deadline", () => {
  const now = Date.now();
  const registry = createAdaptiveDeliveryRegistry();
  const attempt = begin(registry, now);
  attempt.observe(heartbeat, now + 31_000);
  attempt.tryProbe(now + 40_000);
  assert.deepEqual(attempt.deadline(now + 40_000, "FIRST_PROGRESS_TIMEOUT"), { at: now + 121_000, reason: "ADAPTIVE_UPSTREAM_IDLE_TIMEOUT" });
  attempt.observe(heartbeat, now + 290_000);
  assert.deepEqual(attempt.deadline(now + 330_000, "PROGRESS_IDLE_TIMEOUT"), { at: now + 300_000, reason: "ADAPTIVE_WAIT_LIMIT" });
});

test("a retry uses the original absolute wait deadline instead of gaining a fresh budget", () => {
  const now = Date.now();
  const registry = createAdaptiveDeliveryRegistry();
  const attempt = begin(registry, now + 200_000, { waitDeadlineAt: now + 300_000 });
  attempt.observe(heartbeat, now + 231_000);
  assert.equal(attempt.tryProbe(now + 240_000), true);
  attempt.observe(heartbeat, now + 290_000);
  assert.deepEqual(attempt.deadline(now + 340_000, "FIRST_PROGRESS_TIMEOUT"), { at: now + 300_000, reason: "ADAPTIVE_WAIT_LIMIT" });
});

test("in-flight probes cannot multiply and a failed request does not learn buffered mode", () => {
  const now = Date.now();
  const registry = createAdaptiveDeliveryRegistry();
  const first = begin(registry, now);
  const concurrent = begin(registry, now);
  first.observe(heartbeat, now + 31_000);
  concurrent.observe(heartbeat, now + 31_000);
  assert.equal(first.tryProbe(now + 40_000), true);
  assert.equal(concurrent.tryProbe(now + 40_000), false);
  first.observe(delta("x".repeat(1000)), now + 65_000);
  assert.equal(registry.snapshot().profiles[0].mode, "streaming");
});

test("persisted profiles restore without raw identity and reject malformed values", () => {
  const now = Date.now();
  const state = { schemaVersion: 1, profiles: [{ key: keyFor(), mode: "buffered", updatedAt: now, probeAfter: now, evidenceStartedAt: now - 10 }] };
  const restored = createAdaptiveDeliveryRegistry({ state });
  assert.equal(begin(restored, now).active(), true);
  assert.equal(JSON.stringify(restored.snapshot()).includes("sample-account"), false);
  assert.throws(() => createAdaptiveDeliveryRegistry({ state: { schemaVersion: 1, profiles: [{ key: "raw-account" }] } }));
  assert.equal(createAdaptiveDeliveryRegistry({ state: { schemaVersion: 1, profiles: [{ ...state.profiles[0], updatedAt: now - 90_000_000 }] } }).summary().profiles, 0);
});

test("an older completion cannot overwrite newer delivery evidence", () => {
  const now = Date.now();
  const registry = createAdaptiveDeliveryRegistry();
  const older = begin(registry, now);
  older.observe(heartbeat, now + 31_000);
  older.tryProbe(now + 40_000);
  const newer = begin(registry, now + 41_000);
  streamed(newer, now + 42_000);
  newer.complete(now + 45_000);
  older.observe(delta("x".repeat(1000)), now + 60_000);
  older.complete(now + 60_010);
  assert.equal(registry.snapshot().profiles[0].mode, "streaming");
});

test("persistence failure cannot prevent an upstream completion", () => {
  const now = Date.now();
  let errors = 0;
  const registry = createAdaptiveDeliveryRegistry({ onChange: () => { throw new Error("disk full"); }, onPersistenceError: () => errors++ });
  const attempt = begin(registry, now);
  streamed(attempt, now + 5000);
  assert.doesNotThrow(() => attempt.complete(now + 10_000));
  assert.equal(errors, 1);
});

test("a newer quick burst cannot suppress learning from a successful buffered probe", () => {
  const now = Date.now();
  const registry = createAdaptiveDeliveryRegistry();
  const probe = begin(registry, now);
  probe.observe(heartbeat, now + 31_000);
  assert.equal(probe.tryProbe(now + 40_000), true);
  const quick = begin(registry, now + 41_000);
  quick.observe(delta("x".repeat(1000)), now + 45_000);
  quick.complete(now + 45_010);
  assert.equal(registry.snapshot().profiles[0].evidenceStartedAt, 0);
  probe.observe(delta("x".repeat(4000)), now + 60_000);
  probe.complete(now + 60_010);
  assert.equal(registry.snapshot().profiles[0].mode, "buffered");
  assert.equal(begin(registry, now + 61_000).active(), true);
  const delayedQuick = begin(registry, now + 41_000);
  delayedQuick.observe(delta("x".repeat(1000)), now + 65_000);
  delayedQuick.complete(now + 65_010);
  assert.equal(registry.snapshot().profiles[0].mode, "buffered");
});

test("validated partial content refreshes transport liveness without extending the hard budget", () => {
  const now = Date.now();
  const registry = createAdaptiveDeliveryRegistry();
  const attempt = begin(registry, now);
  attempt.observe(heartbeat, now + 31_000);
  attempt.tryProbe(now + 40_000);
  attempt.notePartialProgress(now + 190_000);
  assert.equal(attempt.deadline(now + 40_000, "FIRST_PROGRESS_TIMEOUT").at, now + 280_000);
  attempt.notePartialProgress(now + 290_000);
  assert.equal(attempt.deadline(now + 40_000, "FIRST_PROGRESS_TIMEOUT").at, now + 300_000);
});
