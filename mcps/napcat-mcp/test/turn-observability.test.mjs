import assert from "node:assert/strict";
import test from "node:test";
import { createTurnLifecycleObserver } from "../src/turn-observability.mjs";

function fixture() {
  let currentMs = Date.parse("2026-08-15T12:00:00Z");
  const timers = new Map();
  let nextTimer = 1;
  const anomalies = [];
  const observer = createTurnLifecycleObserver({
    timeoutMs: 60_000,
    now: () => new Date(currentMs),
    setTimeoutImpl(callback, delayMs) {
      const id = nextTimer++;
      timers.set(id, { callback, dueAt: currentMs + delayMs });
      return id;
    },
    clearTimeoutImpl(id) { timers.delete(id); },
    onAnomaly(event) { anomalies.push(event); },
  });
  const advance = (milliseconds) => {
    currentMs += milliseconds;
    for (const [id, timer] of [...timers]) {
      if (timer.dueAt <= currentMs) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  return { observer, anomalies, advance };
}

function startTurn(observer) {
  const start = { id: 7, method: "turn/start", params: { threadId: "thread-private", input: [{ text: "secret prompt" }] } };
  observer.observeDownstream(start);
  observer.markForwarded(start);
  observer.observeUpstream({ id: 7, result: { turn: { id: "turn-private", threadId: "thread-private", status: "inProgress" } } });
  observer.observeUpstream({ method: "turn/started", params: { threadId: "thread-private", turn: { id: "turn-private" } } });
}

test("turn/started alone does not hide a 60 second empty-output anomaly", () => {
  const state = fixture();
  startTurn(state.observer);
  state.advance(60_000);
  assert.equal(state.anomalies.length, 1);
  assert.equal(state.anomalies[0].type, "app_server_turn_first_output_deadline_exceeded");
  assert.equal(state.anomalies[0].correlation, "exact");
  assert.equal(JSON.stringify(state.anomalies).includes("secret prompt"), false);
});

test("a semantic item before the deadline discards the normal trace", () => {
  const state = fixture();
  startTurn(state.observer);
  state.advance(10_000);
  state.observer.observeUpstream({
    method: "item/reasoning/summaryTextDelta",
    params: { threadId: "thread-private", turnId: "turn-private", delta: "private reasoning" },
  });
  state.advance(60_000);
  assert.deepEqual(state.anomalies, []);
  assert.equal(state.observer.status().active, 0);
});

test("a late semantic item records recovery without interrupting the turn", () => {
  const state = fixture();
  startTurn(state.observer);
  state.advance(60_000);
  state.advance(5_000);
  state.observer.observeUpstream({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-private", turnId: "turn-private", delta: "private answer" },
  });
  assert.deepEqual(state.anomalies.map((event) => event.type), [
    "app_server_turn_first_output_deadline_exceeded",
    "app_server_turn_first_output_recovered_after_deadline",
  ]);
  assert.equal(state.anomalies[1].elapsedMs, 65_000);
});

test("completion without any semantic item is classified explicitly", () => {
  const state = fixture();
  startTurn(state.observer);
  state.advance(2_000);
  state.observer.observeUpstream({
    method: "turn/completed",
    params: { threadId: "thread-private", turn: { id: "turn-private", status: "failed" } },
  });
  assert.equal(state.anomalies[0].type, "app_server_turn_completed_without_meaningful_output");
  assert.equal(state.anomalies[0].status, "failed");
});
