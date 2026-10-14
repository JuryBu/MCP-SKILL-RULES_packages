import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const coordinatorModule = process.env.INNER_LIVE_HANDOFF_BASELINE
  ? `data:text/javascript;base64,${process.env.INNER_LIVE_HANDOFF_BASELINE}`
  : pathToFileURL(path.join(sourceRoot, "inner-proxy-coordinator.mjs")).href;
const { createInnerProxyCoordinator } = await import(coordinatorModule);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const specification = (readFile = fs.readFileSync) => {
  const sources = Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" });
  const hashes = entries => Object.fromEntries(entries.map(([name, file]) => [name, digest(readFile(path.join(sourceRoot, file)))]));
  const expectedHashes = hashes(sources);
  assert.deepEqual(hashes([...sources].reverse()), expectedHashes, "INNER_LIVE_SOURCE_CHANGED_DURING_PIN");
  return { runnerPath: path.join(sourceRoot, "codex-model-stream-proxy-runner.mjs"), expectedHashes };
};

async function fixture(context) {
  const pinnedSpecification = specification();
  const workerSpecification = () => {
    assert.deepEqual(specification(), pinnedSpecification, "INNER_LIVE_SOURCE_CHANGED_DURING_FIXTURE");
    return pinnedSpecification;
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inner-live-handoff-"));
  const events = [];
  const calls = [];
  const imageCalls = [];
  const memoryCalls = [];
  const held = [];
  let mode = "quota";
  const frame = value => `data: ${JSON.stringify(value)}\n\n`;
  const complete = response => response.end(frame({ type: "response.completed", response: { id: "live-fixture", status: "completed", output: [] } }));
  const upstream = http.createServer((request, response) => {
    if (request.method === "POST" && request.url === "/backend-api/codex/memories/trace_summarize") {
      const chunks = [];
      request.on("data", chunk => chunks.push(chunk));
      request.once("end", () => {
        memoryCalls.push({ metadata: request.headers["x-codex-turn-metadata"], body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ output: [{ trace_summary: "owned summary", memory_summary: "owned memory" }] }));
      });
      return;
    }
    if (request.method === "GET" && request.url.startsWith("/backend-api/codex/models")) {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ slug: "owned-fixture-model" }] }));
      return;
    }
    if (request.method === "POST" && ["/backend-api/codex/images/generations", "/backend-api/codex/images/edits"].includes(request.url)) {
      const chunks = [];
      request.on("data", chunk => chunks.push(chunk));
      request.once("end", () => {
        imageCalls.push({ path: request.url, authorization: request.headers.authorization,
          metadata: request.headers["x-codex-turn-metadata"], body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        response.writeHead(request.headers.authorization ? 200 : 401, { "content-type": "application/json", "x-owned-upstream": "retained" });
        response.end(JSON.stringify(request.headers.authorization ? { data: [{ b64_json: "owned-fixture" }] } : { error: "owned-auth-required" }));
      });
      return;
    }
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.once("end", () => {
      calls.push({ metadata: JSON.parse(request.headers["x-codex-turn-metadata"]), body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (mode === "quota") response.end(frame({ type: "response.failed", response: { id: "live-fixture", status: "failed", error: { code: "usage_limit_reached", message: "isolated fixture" } } }));
      else {
        response.write(frame({ type: "response.output_text.delta", delta: `owned-result-${calls.length}` }));
        if (mode === "hold") held.push(response);
        else complete(response);
      }
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const environment = {};
  for (const name of Object.keys(process.env)) if (/^(CODEX|OPENAI|MCP|MODEL_OBSERVER)_/u.test(name)) environment[name] = "";
  Object.assign(environment, { MODEL_OBSERVER_ENABLED: "false", CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100", CODEX_MODEL_STREAM_PROXY_DRAIN_TIMEOUT_MS: "1000" });
  const coordinator = createInnerProxyCoordinator({ ownerId: "live-test-owner", nativeSourceId: "live-test-native", checkpointRoot: root,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, environment, onEvent: event => events.push(event) });
  context.after(async () => {
    for (const response of held) if (!response.writableEnded) complete(response);
    await coordinator.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    assert.ok(coordinator.status().workers.every(worker => !worker.alive && worker.exitCode === 0));
    console.log(JSON.stringify({ evidence: "isolated-real-http-fork-workers-synthetic-native-events", calls, events, final: coordinator.status() }));
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true });
  });
  const endpoint = await coordinator.start(workerSpecification());
  const notify = (turnId, phase, threadId = "thread-a") => coordinator.observeNativeMessage("live-test-native", {
    method: `turn/${phase}`, params: { threadId, turn: { id: turnId, ...(phase === "completed" ? { status: "completed" } : {}) } } });
  const request = async (turnId, input = [], threadId = "thread-a") => {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/responses`, { method: "POST",
      headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: threadId, turn_id: turnId }) },
      body: JSON.stringify({ model: "synthetic", stream: true, input }) });
    return { status: response.status, body: await response.text() };
  };
  const waitUntil = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { assert.ok(Date.now() < deadline, "condition deadline"); await pause(10); }
  };
  return { root, endpoint, coordinator, events, calls, imageCalls, memoryCalls, notify, request, waitUntil, workerSpecification,
    setMode: value => { mode = value; }, release: () => { mode = "text"; for (const response of held) if (!response.writableEnded) complete(response); } };
}

test("live tool-wait handoff retains active native turn and recovery counts without fabricating terminal", { timeout: 20000 }, async context => {
  const state = await fixture(context);
  for (const turnId of ["one", "two"]) { await state.notify(turnId, "started"); await state.request(turnId); await state.notify(turnId, "completed"); }
  await state.notify("working", "started");
  const candidate = await state.coordinator.prepareCandidate(state.workerSpecification());
  await assert.rejects(state.coordinator.migrate({ threadId: "thread-a", candidateId: candidate.workerId }), /THREAD_NOT_READY/);
  const receipt = await state.coordinator.migrate({ threadId: "thread-a", candidateId: candidate.workerId, live: true });
  assert.equal(receipt.live, true);
  assert.equal(receipt.phase, "active");
  assert.equal(state.coordinator.status().threads[0].turnId, "working");
  assert.equal(state.coordinator.status().threads[0].workerId, candidate.workerId);
  const envelope = JSON.parse(fs.readFileSync(receipt.accepted.readPath, "utf8"));
  assert.equal(envelope.payload.native.phase, "active");
  assert.equal(Object.hasOwn(envelope.payload, "terminal"), false);
  assert.equal(envelope.payload.snapshot.state.emptyIdleTurns[0][1].count, 2);
  assert.match((await state.request("working")).body, /proxy_repeated_empty_idle/);
  const calls = state.calls.length;
  assert.match((await state.request("working")).body, /proxy_repeated_empty_idle/);
  assert.equal(state.calls.length, calls);
  await state.notify("working", "completed");
});

test("existing HTTP finishes once while queued same-turn tool result moves to candidate", { timeout: 20000 }, async context => {
  const state = await fixture(context);
  await state.notify("working", "started");
  const candidate = await state.coordinator.prepareCandidate(state.workerSpecification());
  state.setMode("hold");
  const original = state.request("working", [{ role: "user", content: "original request" }]);
  await state.waitUntil(() => state.calls.length === 1 && state.coordinator.status().threads[0].activeHttp === 1);
  const migration = state.coordinator.migrate({ threadId: "thread-a", candidateId: candidate.workerId, live: true, drainTimeoutMs: 1000 });
  await state.waitUntil(() => state.events.some(event => event.type === "migration_waiting_inflight"));
  const followupInput = [{ type: "function_call_output", call_id: "owned-tool-once", output: "tool-result-once" }];
  const followup = state.request("working", followupInput);
  await pause(50);
  assert.equal(state.calls.length, 1);
  state.release();
  assert.match((await original).body, /owned-result-1/);
  assert.equal((await migration).committed, true);
  assert.match((await followup).body, /owned-result-2/);
  assert.equal(state.calls.length, 2);
  assert.deepEqual(state.calls[1].body.input, followupInput);
  const routes = state.events.filter(event => event.type === "request_routed");
  assert.deepEqual(routes.map(event => event.workerId), [state.endpoint.workerId, candidate.workerId]);
  assert.equal(state.coordinator.status().threads[0].phase, "active");
  await state.notify("working", "completed");
});

test("unfinished HTTP keeps source and resumes original stream after bounded drain refusal", { timeout: 20000 }, async context => {
  const state = await fixture(context);
  await state.notify("working", "started");
  const candidate = await state.coordinator.prepareCandidate(state.workerSpecification());
  state.setMode("hold");
  const original = state.request("working");
  await state.waitUntil(() => state.calls.length === 1);
  await assert.rejects(state.coordinator.migrate({ threadId: "thread-a", candidateId: candidate.workerId, live: true, drainTimeoutMs: 40 }), /INFLIGHT_PENDING/);
  assert.equal(state.coordinator.status().threads[0].workerId, state.endpoint.workerId);
  assert.equal(state.coordinator.status().transactionActive, false);
  state.release();
  assert.match((await original).body, /owned-result-1/);
  assert.match((await state.request("working")).body, /owned-result-2/);
  assert.equal(state.calls.length, 2);
  assert.ok(state.events.filter(event => event.type === "request_routed").every(event => event.workerId === state.endpoint.workerId));
  await state.notify("working", "completed");
});

test("native epoch change during drain aborts handoff and preserves honest terminal relay", { timeout: 20000 }, async context => {
  const state = await fixture(context);
  await state.notify("working", "started");
  const candidate = await state.coordinator.prepareCandidate(state.workerSpecification());
  state.setMode("hold");
  const original = state.request("working");
  await state.waitUntil(() => state.calls.length === 1);
  const migration = state.coordinator.migrate({ threadId: "thread-a", candidateId: candidate.workerId, live: true });
  const refused = assert.rejects(migration, /COMMIT_PRECONDITION_CHANGED/);
  await state.waitUntil(() => state.events.some(event => event.type === "migration_waiting_inflight"));
  const terminal = state.notify("working", "completed");
  await refused;
  state.release();
  await original;
  await terminal;
  assert.equal(state.coordinator.status().threads[0].phase, "terminal");
  assert.equal(state.coordinator.status().threads[0].workerId, state.endpoint.workerId);
  assert.equal(state.coordinator.status().nativeHealthy, true);
});

test("aborted queued request is never dispatched or added to the active HTTP count", { timeout: 20000 }, async context => {
  const state = await fixture(context);
  await state.notify("working", "started");
  const candidate = await state.coordinator.prepareCandidate(state.workerSpecification());
  state.setMode("hold");
  const original = state.request("working");
  await state.waitUntil(() => state.calls.length === 1);
  const migration = state.coordinator.migrate({ threadId: "thread-a", candidateId: candidate.workerId, live: true });
  await state.waitUntil(() => state.events.some(event => event.type === "migration_waiting_inflight"));
  const abandoned = http.request({ hostname: "127.0.0.1", port: state.endpoint.port, path: "/v1/responses", method: "POST",
    headers: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-a", turn_id: "working" }) } });
  abandoned.on("error", () => {});
  abandoned.end("{}");
  await pause(25);
  abandoned.destroy();
  await pause(25);
  state.release();
  await original;
  await migration;
  await pause(25);
  assert.equal(state.calls.length, 1);
  assert.equal(state.coordinator.status().threads[0].activeHttp, 0);
  assert.equal((await state.request("working")).status, 200);
  assert.equal(state.calls.length, 2);
  await state.notify("working", "completed");
});

test("models catalog forwards without native turn while unidentified model and image POST stay guarded", { timeout: 20000 }, async context => {
  const state = await fixture(context);
  const origin = `http://127.0.0.1:${state.endpoint.port}`;
  const catalog = await fetch(`${origin}/backend-api/codex/models?client_version=owned-test`);
  assert.equal(catalog.status, 200);
  assert.equal((await catalog.json()).models[0].slug, "owned-fixture-model");
  assert.equal(state.coordinator.status().threads.length, 0);
  for (const endpoint of ["/v1/responses", "/backend-api/codex/models", "/backend-api/images/generations"]) {
    const denied = await fetch(`${origin}${endpoint}`, { method: "POST", body: "{}" });
    assert.equal(denied.status, 503);
    await denied.text();
  }
  assert.equal(state.calls.length, 0);
  assert.ok(state.events.filter(event => event.type === "request_rejected").every(event => event.code === "COORDINATOR_TURN_IDENTITY_REQUIRED"));
});

test("image background generation and edit preserve upstream identity and JSON without turn fabrication or retry", { timeout: 20000 }, async context => {
  const state = await fixture(context);
  const input = { model: "owned-image", prompt: "owned fixture", images: [{ image_url: "data:image/png;base64,b3duZWQ=" }] };
  for (const endpoint of ["/backend-api/codex/images/generations", "/backend-api/codex/images/edits"]) {
    const response = await fetch(`http://127.0.0.1:${state.endpoint.port}${endpoint}`, { method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer owned-test-credential" }, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-owned-upstream"), "retained");
    assert.equal((await response.json()).data[0].b64_json, "owned-fixture");
  }
  assert.equal(state.imageCalls.length, 2);
  assert.ok(state.imageCalls.every(call => call.authorization === "Bearer owned-test-credential" && call.metadata === undefined));
  assert.deepEqual(state.imageCalls.map(call => call.body), [input, input]);
  assert.equal(state.coordinator.status().threads.length, 0);
  assert.equal(state.calls.length, 0);
  const denied = await fetch(`http://127.0.0.1:${state.endpoint.port}/backend-api/codex/images/generations`, { method: "POST", body: "{}" });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error, "owned-auth-required");
  assert.equal(state.imageCalls.length, 3);
});

test("activate retains a stream over five seconds while new thread and catalog use candidate and tool output dispatches once", { timeout: 20000 }, async context => {
  const state = await fixture(context);
  await state.notify("working", "started");
  const candidate = await state.coordinator.prepareCandidate(state.workerSpecification());
  state.setMode("hold");
  let originalFinished = false;
  const original = state.request("working").then(result => { originalFinished = true; return result; });
  await state.waitUntil(() => state.calls.length === 1);
  const started = Date.now();
  const selected = await state.coordinator.activate({ candidateId: candidate.workerId });
  assert.ok(Date.now() - started < 1000);
  assert.equal(selected.selectionCommitted, true);
  assert.equal(selected.stateTransferComplete, false);
  assert.deepEqual(selected.deferredThreadIds, ["thread-a"]);
  state.setMode("text");
  const input = [{ type: "function_call_output", call_id: "activation-tool-once", output: "owned-tool-result" }];
  const followup = state.request("working", input);
  await state.notify("independent", "started", "thread-b");
  assert.match((await state.request("independent", [], "thread-b")).body, /owned-result-2/);
  const catalog = await fetch(`http://127.0.0.1:${state.endpoint.port}/backend-api/codex/models`);
  assert.equal(catalog.status, 200);
  await catalog.text();
  await pause(5200);
  assert.equal(originalFinished, false);
  assert.equal(state.calls.length, 2);
  assert.equal(state.coordinator.status().threads.find(thread => thread.threadId === "thread-a").activeHttp, 1);
  assert.ok(state.events.filter(event => event.type === "request_routed").slice(1).every(event => event.workerId === candidate.workerId));
  state.release();
  assert.match((await original).body, /owned-result-1/);
  assert.match((await followup).body, /owned-result-3/);
  assert.equal(state.calls.length, 3);
  assert.deepEqual(state.calls[2].body.input, input);
  assert.equal(state.calls.filter(call => call.body.input.some(item => item.call_id === "activation-tool-once")).length, 1);
  const current = state.coordinator.status().threads.find(thread => thread.threadId === "thread-a");
  assert.equal(current.workerId, candidate.workerId);
  assert.equal(current.phase, "active");
  assert.equal(current.pendingActivationId, null);
  await state.notify("working", "completed");
  await state.notify("independent", "completed", "thread-b");
});

test("activate at active HTTP zero transfers recovery counts on next request without terminal", { timeout: 20000 }, async context => {
  const state = await fixture(context);
  for (const turnId of ["one", "two"]) { await state.notify(turnId, "started"); await state.request(turnId); await state.notify(turnId, "completed"); }
  await state.notify("working", "started");
  const candidate = await state.coordinator.prepareCandidate(state.workerSpecification());
  await state.coordinator.activate({ candidateId: candidate.workerId });
  assert.match((await state.request("working")).body, /proxy_repeated_empty_idle/);
  assert.equal(state.coordinator.status().threads[0].workerId, candidate.workerId);
  assert.equal(state.coordinator.status().threads[0].phase, "active");
  assert.equal(state.calls.length, 3);
  await state.notify("working", "completed");
});

test("activation rollback restores default and pending source requests without replaying old HTTP", { timeout: 20000 }, async context => {
  const state = await fixture(context);
  await state.notify("working", "started");
  const candidate = await state.coordinator.prepareCandidate(state.workerSpecification());
  state.setMode("hold");
  const original = state.request("working");
  await state.waitUntil(() => state.calls.length === 1);
  const selected = await state.coordinator.activate({ candidateId: candidate.workerId });
  const followup = state.request("working", [{ type: "function_call_output", call_id: "rollback-tool-once", output: "once" }]);
  await pause(40);
  assert.equal(state.calls.length, 1);
  state.setMode("text");
  const restored = state.coordinator.rollbackActivation({ activationId: selected.activationId });
  assert.equal(restored.selectionRestored, true);
  assert.deepEqual(restored.retainedThreadIds, []);
  assert.equal(restored.defaultWorkerId, state.endpoint.workerId);
  await followup;
  state.release();
  await original;
  assert.equal(state.calls.length, 2);
  assert.ok(state.events.filter(event => event.type === "request_routed").every(event => event.workerId === state.endpoint.workerId));
  assert.equal(state.coordinator.status().threads[0].pendingActivationId, null);
  await state.notify("working", "completed");
});

test("rollback after adoption preserves candidate thread state and routes fresh threads to restored default", { timeout: 20000 }, async context => {
  const state = await fixture(context);
  await state.notify("working", "started");
  const candidate = await state.coordinator.prepareCandidate(state.workerSpecification());
  const selected = await state.coordinator.activate({ candidateId: candidate.workerId });
  await state.request("working");
  const restored = state.coordinator.rollbackActivation({ activationId: selected.activationId });
  assert.deepEqual(restored.retainedThreadIds, ["thread-a"]);
  await state.request("working");
  await state.notify("fresh", "started", "thread-b");
  await state.request("fresh", [], "thread-b");
  assert.deepEqual(state.events.filter(event => event.type === "request_routed").map(event => event.workerId), [candidate.workerId, candidate.workerId, state.endpoint.workerId]);
  await state.notify("working", "completed");
  await state.notify("fresh", "completed", "thread-b");
});

test("aborted activation waiter leaves no dispatch, snapshot or HTTP accounting", { timeout: 20000 }, async context => {
  const state = await fixture(context);
  await state.notify("working", "started");
  const candidate = await state.coordinator.prepareCandidate(state.workerSpecification());
  state.setMode("hold");
  const original = state.request("working");
  await state.waitUntil(() => state.calls.length === 1);
  const selected = await state.coordinator.activate({ candidateId: candidate.workerId });
  const abandoned = http.request({ hostname: "127.0.0.1", port: state.endpoint.port, path: "/v1/responses", method: "POST",
    headers: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-a", turn_id: "working" }) } });
  abandoned.on("error", () => {});
  abandoned.end("{}");
  await pause(40);
  abandoned.destroy();
  await pause(40);
  state.release();
  await original;
  await pause(40);
  assert.equal(state.calls.length, 1);
  assert.equal(state.coordinator.status().threads[0].activeHttp, 0);
  assert.equal(state.events.filter(event => event.type === "activation_thread_adopted").length, 0);
  state.coordinator.rollbackActivation({ activationId: selected.activationId });
  await state.notify("working", "completed");
});

test("official memory background path forwards once while compact, wrong method, malformed metadata and lookalikes remain guarded", { timeout: 20000 }, async context => {
  const state = await fixture(context);
  const origin = `http://127.0.0.1:${state.endpoint.port}`;
  const body = { model: "synthetic", traces: [{ id: "owned-trace", items: [] }] };
  const response = await fetch(`${origin}/backend-api/codex/memories/trace_summarize`, { method: "POST", body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).output[0].trace_summary, "owned summary");
  assert.deepEqual(state.memoryCalls, [{ metadata: undefined, body }]);
  for (const endpoint of ["/backend-api/codex/responses/compact", "/backend-api/codex/memories/trace_summarize-extra", "/backend-api/codex/models-extra"]) {
    const denied = await fetch(`${origin}${endpoint}`, { method: "POST", body: "{}" });
    assert.equal(denied.status, 503);
    await denied.text();
  }
  const malformed = await fetch(`${origin}/backend-api/codex/models`, { headers: { "x-codex-turn-metadata": "invalid" } });
  assert.equal(malformed.status, 503);
  await malformed.text();
  const wrongMethod = await fetch(`${origin}/backend-api/codex/memories/trace_summarize`);
  assert.equal(wrongMethod.status, 503);
  await wrongMethod.text();
  assert.equal(state.memoryCalls.length, 1);
  assert.equal(state.calls.length, 0);
  assert.equal(state.coordinator.status().threads.length, 0);
});

test("source pin rejects an interleaved source edit instead of combining worker versions", () => {
  let reads = 0;
  assert.throws(() => specification(file => {
    reads += 1;
    const bytes = Buffer.from(path.basename(file));
    return reads > 4 && path.basename(file) === "codex-model-stream-proxy.mjs" ? Buffer.concat([bytes, Buffer.from("changed")]) : bytes;
  }), /INNER_LIVE_SOURCE_CHANGED_DURING_PIN/);
  assert.equal(reads, 8);
});
