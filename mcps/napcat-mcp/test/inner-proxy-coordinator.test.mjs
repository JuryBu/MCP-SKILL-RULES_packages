import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createInnerProxyCoordinator } from "../src/inner-proxy-coordinator.mjs";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const specification = () => ({ runnerPath: path.join(sourceRoot, "codex-model-stream-proxy-runner.mjs"),
  expectedHashes: Object.fromEntries(Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" }).map(([name, file]) => [name, digest(fs.readFileSync(path.join(sourceRoot, file)))])) });

async function setup(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inner-coordinator-unit-"));
  const events = [];
  const upstream = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ type: "response.failed", response: { id: "fixture", status: "failed",
      error: { code: "usage_limit_reached", message: "synthetic loopback only" } } })}\n\n`);
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const coordinator = createInnerProxyCoordinator({ ownerId: "unit-owner", nativeSourceId: "unit-native", checkpointRoot: root,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    environment: { CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100", CODEX_MODEL_STREAM_PROXY_DRAIN_TIMEOUT_MS: "1000" },
    onEvent: event => events.push(event) });
  context.after(async () => {
    await coordinator.close();
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    const status = coordinator.status();
    assert.ok(status.workers.every(worker => !worker.alive && worker.exitCode !== null));
    fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify({ kind: "synthetic-native-events", status, events }, null, 2));
    console.log(`coordinator unit evidence: ${root}`);
  });
  const starting = coordinator.start(specification());
  await assert.rejects(coordinator.start(specification()), /ALREADY_STARTED/);
  const endpoint = await starting;
  const notify = (threadId, turnId, phase) => coordinator.observeNativeMessage("unit-native", { method: `turn/${phase}`,
    params: { threadId, turn: { id: turnId, ...(phase === "completed" ? { status: "completed" } : {}) } } });
  const request = async (threadId, turnId) => {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/responses`, { method: "POST",
      headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: threadId, turn_id: turnId }) },
      body: JSON.stringify({ model: "synthetic", stream: true, input: [] }) });
    return { status: response.status, body: await response.text() };
  };
  return { root, coordinator, endpoint, notify, request, events };
}

test("fixed entry migrates only a terminal thread while another tool-wait simulation stays on its old worker", { timeout: 30000 }, async context => {
  const fixture = await setup(context);
  const { coordinator, notify, request } = fixture;
  assert.throws(() => coordinator.observeNativeMessage("wrong-source", {}), /SOURCE_MISMATCH/);
  await notify("thread-a", "a1", "started");
  await request("thread-a", "a1");
  const candidate = await coordinator.prepareCandidate(specification());
  await assert.rejects(coordinator.migrate({ threadId: "thread-a", candidateId: candidate.workerId }), /THREAD_NOT_READY/);
  for (let turn = 1; turn <= 2; turn += 1) {
    await notify("thread-b", `b${turn}`, "started");
    assert.equal((await request("thread-b", `b${turn}`)).status, 200);
    await notify("thread-b", `b${turn}`, "completed");
  }
  const result = await coordinator.migrate({ threadId: "thread-b", candidateId: candidate.workerId });
  assert.equal(result.committed, true);
  assert.equal(result.accepted.importedEntries, 1);
  const status = coordinator.status();
  assert.equal(status.threads.find(thread => thread.threadId === "thread-a").workerId, fixture.endpoint.workerId);
  assert.equal(status.threads.find(thread => thread.threadId === "thread-b").workerId, candidate.workerId);
  await notify("thread-b", "b3", "started");
  const continued = await request("thread-b", "b3");
  assert.match(continued.body, /Three distinct turns/);
  await notify("thread-b", "b3", "completed");
  assert.equal((await request("thread-a", "a1")).status, 200);
  await notify("thread-a", "a1", "completed");
  assert.equal(coordinator.status().nativeHealthy, true);
});

test("candidate bind failure preserves source, fixed entry and its next request", { timeout: 30000 }, async context => {
  const { coordinator, endpoint, notify, request } = await setup(context);
  const occupied = http.createServer(); occupied.listen(0, "127.0.0.1"); await once(occupied, "listening");
  try {
    await assert.rejects(coordinator.prepareCandidate({ ...specification(), port: occupied.address().port }), /WORKER_EXITED|STARTUP_FAILED/);
    await notify("still-old", "turn-old", "started");
    assert.equal((await request("still-old", "turn-old")).status, 200);
    await notify("still-old", "turn-old", "completed");
    assert.equal(coordinator.status().threads[0].workerId, endpoint.workerId);
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});

test("unverified candidates and HTTP-only identities cannot expand authority", { timeout: 30000 }, async context => {
  const { coordinator, endpoint } = await setup(context);
  const input = specification(); input.expectedHashes.core = "0".repeat(64);
  await assert.rejects(coordinator.prepareCandidate(input), /UNVERIFIED_SOURCE/);
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/responses`, { method: "POST", body: "{}" });
  assert.equal(response.status, 503);
  assert.equal((await response.text()), "COORDINATOR_REQUEST_NOT_ACCEPTED");
  assert.equal(coordinator.status().workers.length, 1);
});
