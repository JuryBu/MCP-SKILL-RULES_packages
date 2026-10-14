import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createModelObserver } from "../src/model-observer.mjs";

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function blockedCoverage(context) {
  let timestamp = Date.now();
  let entered;
  let release;
  let pending = false;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const observer = createModelObserver({ filePath: "synthetic-events", statusPath: "synthetic-runtime", producerInstance: randomUUID(),
    now: () => ++timestamp, heartbeatMs: 10, fsAdapter: {
      async mkdir() {}, async stat() { return { size: 0 }; }, async rename() {}, async writeFile() {},
      async appendFile(path, line) {
        if (JSON.parse(line).type !== "model_watch_coverage") return;
        pending = true;
        entered();
        await gate;
        pending = false;
      },
    } });
  observer.observe({ request_id: randomUUID(), upstream_attempt: 0, endpoint: "responses", protocol: "pending",
    phase: "request.ended", observation_source: "proxy_lifecycle", outcome: "failed", request_sent: false });
  context.after(async () => { release(); await observer.close(); await observer.flush(); });
  return { observer, started, release, pending: () => pending };
}

test("close waits for coverage already started by heartbeat", { timeout: 10000 }, async context => {
  const state = blockedCoverage(context);
  await Promise.race([state.started, pause(500).then(() => { throw new Error("coverage did not start"); })]);
  let returned = false;
  const closing = state.observer.close().then(result => { returned = true; return result; });
  await pause(30);
  assert.equal(returned, false);
  assert.equal(state.pending(), true);
  state.release();
  assert.equal(await closing, true);
  assert.equal(state.pending(), false);
  assert.equal(state.observer.status().queue_depth, 0);
});

test("after close times out, runner fallback flush still waits for pending coverage", { timeout: 10000 }, async context => {
  const state = blockedCoverage(context);
  await Promise.race([state.started, pause(500).then(() => { throw new Error("coverage did not start"); })]);
  assert.equal(await state.observer.close(), false);
  let returned = false;
  const flushing = state.observer.flush().then(() => { returned = true; });
  await pause(30);
  assert.equal(returned, false);
  assert.equal(state.pending(), true);
  state.release();
  await flushing;
  assert.equal(state.pending(), false);
  assert.equal(state.observer.status().queue_depth, 0);
});
