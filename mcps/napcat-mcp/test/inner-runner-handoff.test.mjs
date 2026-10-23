import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { HANDOFF_CHANNEL, isolatedHandoffConfiguration } from "../src/inner-runner-handoff-control.mjs";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const runnerPath = new URL("../src/codex-model-stream-proxy-runner.mjs", import.meta.url);

test("handoff requires both fork IPC and explicit isolation; absent IPC keeps defaults", () => {
  assert.equal(isolatedHandoffConfiguration({ environment: {}, ipc: { connected: true, send() {} } }), null);
  assert.equal(isolatedHandoffConfiguration({ environment: { CODEX_MODEL_STREAM_PROXY_HANDOFF_CONTROL: "invalid" }, ipc: {} }), null);
  assert.throws(() => isolatedHandoffConfiguration({ environment: { CODEX_MODEL_STREAM_PROXY_HANDOFF_CONTROL: "invalid" },
    ipc: { connected: true, send() {} } }), { code: "HANDOFF_INVALID_CONFIGURATION" });
});

test("isolation excludes production roots, external upstreams and non-loopback binds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inner-runner-config-"));
  const configuration = { schemaVersion: 1, mode: "isolated", ownerId: "synthetic", capability: "a".repeat(64), checkpointRoot: root };
  const args = { environment: { CODEX_MODEL_STREAM_PROXY_HANDOFF_CONTROL: JSON.stringify(configuration),
    CODEX_MODEL_STREAM_PROXY_STATE_ROOT: path.join(root, "state"), CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN: "http://127.0.0.1:1" },
    ipc: { connected: true, send() {} }, stateRoot: path.join(root, "state"), host: "127.0.0.1", upstreamOrigin: "http://127.0.0.1:1" };
  try {
    assert.equal(isolatedHandoffConfiguration(args).checkpointRoot, fs.realpathSync(root));
    assert.throws(() => isolatedHandoffConfiguration({ ...args, stateRoot: os.tmpdir() }), { code: "HANDOFF_STATE_OUTSIDE_OWNED_ROOT" });
    assert.throws(() => isolatedHandoffConfiguration({ ...args, upstreamOrigin: "https://example.test" }), { code: "HANDOFF_LOOPBACK_REQUIRED" });
    assert.throws(() => isolatedHandoffConfiguration({ ...args, host: "0.0.0.0" }), { code: "HANDOFF_INVALID_CONFIGURATION" });
  } finally {
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true });
  }
});

async function fixture(context) {
  const parentRoot = process.env.INNER_RUNNER_TEST_ROOT ?? os.tmpdir();
  const root = fs.mkdtempSync(path.join(parentRoot, "inner-runner-control-"));
  const ownerId = "synthetic-control";
  const capability = crypto.randomBytes(32).toString("hex");
  const entries = [];
  let calls = 0;
  const upstream = http.createServer((request, response) => {
    request.resume();
    if (request.url !== "/v1/responses") { response.writeHead(404); response.end("upstream-owned-404"); return; }
    calls += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ type: "response.failed", response: { id: "synthetic", status: "failed",
      error: { code: "usage_limit_reached", message: "synthetic loopback only" } } })}\n\n`);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  context.after(async () => {
    for (const entry of entries) {
      if (entry.child.connected && entry.child.exitCode === null) await entry.rpc("shutdown");
      if (entry.child.exitCode === null) await once(entry.child, "exit");
      if (entry.ready) {
        const runtime = JSON.parse(fs.readFileSync(path.join(entry.stateRoot, "codex-model-stream-proxy-runtime.json"), "utf8"));
        const observer = JSON.parse(fs.readFileSync(path.join(entry.stateRoot, "codex-model-observer-runtime.json"), "utf8"));
        assert.equal(runtime.status, "stopped");
        assert.equal(observer.running, false);
        assert.equal(observer.queue_depth, 0);
        assert.equal(fs.existsSync(path.join(entry.stateRoot, "codex-model-stream-proxy.lock.json")), false);
      }
    }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.writeFileSync(path.join(root, "inner-runner-evidence.json"), JSON.stringify({ root, nodeVersion: process.version,
      runnerSha256: digest(fs.readFileSync(runnerPath)), calls, processes: entries.map(entry => ({ pid: entry.child.pid,
        instanceToken: entry.ready?.instanceToken, exitCode: entry.child.exitCode, stateRoot: entry.stateRoot, replies: entry.replies })) }, null, 2));
    console.log(`inner-runner evidence: ${root}`);
  });
  async function launch(label, failCheckpoint = false) {
    const stateRoot = path.join(root, label);
    const environment = { ...process.env };
    for (const name of Object.keys(environment)) if (/^(CODEX|OPENAI|MCP|MODEL_OBSERVER)_/u.test(name)) delete environment[name];
    Object.assign(environment, { HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1",
      CODEX_MODEL_STREAM_PROXY_STATE_ROOT: stateRoot, CODEX_MODEL_STREAM_PROXY_HOST: "127.0.0.1", CODEX_MODEL_STREAM_PROXY_PORT: "0",
      CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN: `http://127.0.0.1:${upstream.address().port}`,
      CODEX_MODEL_STREAM_PROXY_DRAIN_TIMEOUT_MS: "1000", CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100",
      CODEX_MODEL_STREAM_PROXY_HANDOFF_CONTROL: JSON.stringify({ schemaVersion: 1, mode: "isolated", ownerId, capability, checkpointRoot: root }) });
    const execArgv = [];
    if (failCheckpoint) {
      const faultPath = path.join(root, "inner-runner-checkpoint-write-fault.mjs");
      fs.writeFileSync(faultPath, `import fs from "node:fs";\nconst original = fs.writeFileSync;\nconst originalOpen = fs.openSync;\nlet descriptor;\nlet armed = true;\nfs.openSync = function(filePath, ...args) {\n  const opened = originalOpen.call(this, filePath, ...args);\n  if (armed && typeof filePath === "string" && filePath.endsWith(".pending")) descriptor = opened;\n  return opened;\n};\nfs.writeFileSync = function(filePath, ...args) {\n  if (armed && descriptor !== undefined && filePath === descriptor) { armed = false; throw Object.assign(new Error("owned injected EIO"), { code: "EIO" }); }\n  return original.call(this, filePath, ...args);\n};\n`);
      execArgv.push("--import", pathToFileURL(faultPath).href);
    }
    const child = fork(runnerPath, [], { env: environment, execArgv, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "";
    child.stdout.resume();
    child.stderr.on("data", chunk => { stderr += chunk; });
    const entry = { child, stateRoot, pending: new Map(), replies: [], sequence: 0 };
    entries.push(entry);
    child.on("message", reply => {
      entry.replies.push(reply);
      if (reply.event === "ready") entry.ready = reply;
      const pending = entry.pending.get(reply.requestId);
      if (pending) { entry.pending.delete(reply.requestId); clearTimeout(pending.timer);
        if (reply.ok) pending.resolve(reply.result); else pending.reject(Object.assign(new Error(reply.error.code), { code: reply.error.code })); }
    });
    const deadline = Date.now() + 10000;
    while (!entry.ready && child.exitCode === null && Date.now() < deadline) await pause(20);
    assert.ok(entry.ready, stderr);
    entry.rpc = (method, params = {}, overrides = {}) => new Promise((resolve, reject) => {
      const requestId = overrides.requestId ?? String(++entry.sequence);
      const timer = setTimeout(() => { entry.pending.delete(requestId); reject(new Error("IPC_REPLY_TIMEOUT")); }, 5000);
      entry.pending.set(requestId, { resolve, reject, timer });
      child.send({ channel: HANDOFF_CHANNEL, requestId, instanceToken: entry.ready.instanceToken,
        ownerId, capability, method, ...params, ...overrides });
    });
    return entry;
  }
  const request = async (entry, turnId) => {
    const response = await fetch(`http://127.0.0.1:${entry.ready.status.port}/v1/responses`, { method: "POST",
      headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: "thread-a", turn_id: turnId }) },
      body: JSON.stringify({ model: "synthetic", stream: true, input: [] }) });
    return { status: response.status, body: await response.text() };
  };
  const turn = (entry, sequence, turnId, phase) => entry.rpc("nativeTurn", { event: { threadId: "thread-a", turnId, phase, sequence,
    ...(phase === "terminal" ? { status: "completed" } : {}) } });
  return { root, launch, request, turn, calls: () => calls };
}

test("real runner retains 128 active turns and rejects unauthorised terminal restoration atomically", { timeout: 15000 }, async context => {
  const value = await fixture(context);
  const worker = await value.launch("active-boundary");
  for (let index = 0; index < 128; index += 1) await worker.rpc("nativeTurn", { event: {
    threadId: `active-${index}`, turnId: `turn-${index}`, phase: "active", sequence: index + 1,
  } });
  await assert.rejects(worker.rpc("nativeTurn", { event: {
    threadId: "overflow", turnId: "overflow-turn", phase: "active", sequence: 129,
  } }), { code: "HANDOFF_THREAD_LIMIT" });
  await worker.rpc("nativeTurn", { event: { threadId: "active-0", turnId: "turn-0", phase: "terminal",
    sequence: 129, status: "completed" } });
  await assert.rejects(worker.rpc("restoreTerminal", { event: { threadId: "missing", turnId: "missing-turn",
    phase: "terminal", sequence: 130, status: "completed" } }), { code: "MIGRATION_PLAN_INVALID" });
  const state = await worker.rpc("check", { threadId: "active-1" });
  assert.equal(state.native.phase, "active");
  assert.deepEqual(state.nativeHistory, { retained: 128, archived: 0, limit: 128 });
  await worker.rpc("nativeTurn", { event: { threadId: "overflow", turnId: "overflow-turn", phase: "active", sequence: 130 } });
  assert.equal((await worker.rpc("check", { threadId: "overflow" })).native.sequence, 130);
  assert.equal(value.calls(), 0);
});

test("coordinator control continues beyond 4096 calls while rejecting old and unauthorised sequence identities", { timeout: 30000 }, async context => {
  const state = await fixture(context);
  const worker = await state.launch("continuous-control");
  await assert.rejects(worker.rpc("check", {}, { requestId: "coordinator-99999", capability: "b".repeat(64) }), { code: "HANDOFF_UNAUTHORIZED" });
  for (let sequence = 1; sequence <= 4200; sequence += 1) {
    assert.equal((await worker.rpc("check", {}, { requestId: `coordinator-${sequence}` })).status.running, true);
  }
  for (const requestId of ["coordinator-1", "coordinator-4199", "coordinator-4200"]) {
    await assert.rejects(worker.rpc("check", {}, { requestId }), { code: "HANDOFF_REQUEST_REPLAY" });
  }
  await assert.rejects(worker.rpc("check", {}, { requestId: "coordinator-9007199254740992" }), { code: "HANDOFF_INVALID_REQUEST_ID" });
  assert.equal((await worker.rpc("check", {}, { requestId: "coordinator-4201" })).status.running, true);
  assert.equal(state.calls(), 0);
});

test("normal fork runner authenticates, bounds and correlates IPC without a management HTTP route", { timeout: 30000 }, async context => {
  const state = await fixture(context);
  const old = await state.launch("old");
  await assert.rejects(old.rpc("check", {}, { capability: "b".repeat(64) }), { code: "HANDOFF_UNAUTHORIZED" });
  await assert.rejects(old.rpc("check", {}, { instanceToken: crypto.randomUUID() }), { code: "HANDOFF_UNAUTHORIZED" });
  await assert.rejects(old.rpc("check", {}, { ownerId: "another-owner" }), { code: "HANDOFF_UNAUTHORIZED" });
  await assert.rejects(old.rpc("accept", { snapshot: {} }), { code: "HANDOFF_INVALID_THREAD" });
  await assert.rejects(old.rpc("unknown"), { code: "HANDOFF_UNKNOWN_METHOD" });
  await assert.rejects(old.rpc("check", { padding: "x".repeat(17000) }), { code: "HANDOFF_MESSAGE_TOO_LARGE" });
  await old.rpc("check", {}, { requestId: "replay-id" });
  await assert.rejects(old.rpc("check", {}, { requestId: "replay-id" }), { code: "HANDOFF_REQUEST_REPLAY" });
  await assert.rejects(old.rpc("prepare", { threadId: "thread-a", fileName: "inner-runner-early.json" }), { code: "NATIVE_TURN_NOT_TERMINAL" });
  await state.turn(old, 1, "one", "active");
  assert.equal((await old.rpc("check")).status.activeRequests, 0);
  await assert.rejects(old.rpc("prepare", { threadId: "thread-a", fileName: "inner-runner-tool-wait.json" }), { code: "NATIVE_TURN_NOT_TERMINAL" });
  await state.turn(old, 2, "one", "terminal");
  await assert.rejects(state.turn(old, 2, "one", "terminal"), { code: "HANDOFF_INVALID_NATIVE_EVENT" });
  const response = await fetch(`http://127.0.0.1:${old.ready.status.port}/handoff`, { method: "POST", body: "{}" });
  assert.equal(response.status, 404);
  await response.text();
});

test("signed file handoff preserves real core state; tampering, half files and duplicate accepts fail atomically", { timeout: 30000 }, async context => {
  const state = await fixture(context);
  const old = await state.launch("old");
  const candidate = await state.launch("candidate");
  for (const entry of [old, candidate]) {
    await state.turn(entry, 1, "one", "active");
    if (entry === old) await state.request(entry, "one");
    await state.turn(entry, 2, "one", "terminal");
    await state.turn(entry, 3, "two", "active");
    if (entry === old) await state.request(entry, "two");
    await state.turn(entry, 4, "two", "terminal");
  }
  const saved = await old.rpc("prepare", { threadId: "thread-a", fileName: "inner-runner-real.json" });
  const envelope = JSON.parse(fs.readFileSync(saved.filePath, "utf8"));
  const expectedState = structuredClone(envelope.payload.snapshot.state);
  assert.deepEqual(Object.keys(expectedState).sort(), ["attempts", "businessProgress", "emptyIdleTurns", "waitTerminals"]);
  assert.deepEqual(expectedState.attempts, []);
  assert.deepEqual(expectedState.businessProgress, []);
  assert.equal(expectedState.emptyIdleTurns.length, 1);
  assert.equal(expectedState.emptyIdleTurns[0][0], "thread-a");
  assert.deepEqual(expectedState.waitTerminals.map(([key]) => key).sort(), ["thread-a\u0000one\u0000turn", "thread-a\u0000two\u0000turn"]);
  assert.ok(expectedState.waitTerminals.every(([, value]) => value.category === "quota"
    && value.reason === "usage_limit_reached" && value.acceptance === "rejected"));
  assert.equal(envelope.payload.snapshot.state.emptyIdleTurns[0][1].count, 2);
  assert.equal((await state.request(old, "blocked")).status, 503);
  const accept = (fileName, bytes, overrides = {}) => candidate.rpc("accept", { threadId: "thread-a", fileName,
    sha256: digest(bytes), sourceInstanceToken: old.ready.instanceToken, ...overrides });
  const bytes = fs.readFileSync(saved.filePath);
  const half = bytes.subarray(0, Math.floor(bytes.length / 2));
  fs.writeFileSync(path.join(state.root, "inner-runner-half.json"), half);
  await assert.rejects(accept("inner-runner-half.json", half), { code: "CHECKPOINT_INVALID_JSON" });
  envelope.payload.snapshot.state.emptyIdleTurns[0][1].count = 99;
  const forged = Buffer.from(JSON.stringify(envelope));
  fs.writeFileSync(path.join(state.root, "inner-runner-forged.json"), forged);
  await assert.rejects(accept("inner-runner-forged.json", forged), { code: "CHECKPOINT_AUTHENTICATION_FAILED" });
  await assert.rejects(accept("inner-runner-real.json", bytes, { sourceInstanceToken: crypto.randomUUID() }), { code: "CHECKPOINT_IDENTITY_MISMATCH" });
  await assert.rejects(accept("../inner-runner-real.json", bytes), { code: "CHECKPOINT_INVALID_NAME" });
  await assert.rejects(accept("inner-runner-real.json", bytes, { sha256: "0".repeat(64) }), { code: "CHECKPOINT_HASH_MISMATCH" });
  const oversized = Buffer.alloc(1024 * 1024 + 16 * 1024 + 1);
  fs.writeFileSync(path.join(state.root, "inner-runner-oversized.json"), oversized);
  await assert.rejects(accept("inner-runner-oversized.json", oversized), { code: "CHECKPOINT_TOO_LARGE" });
  const untouched = await candidate.rpc("prepare", { threadId: "thread-a", fileName: "inner-runner-untouched.json" });
  assert.ok(Object.values(JSON.parse(fs.readFileSync(untouched.filePath, "utf8")).payload.snapshot.state).every(entries => entries.length === 0));
  await candidate.rpc("cancel", { threadId: "thread-a", token: untouched.token });
  const accepted = await accept("inner-runner-real.json", bytes);
  assert.equal(accepted.readSha256, saved.sha256);
  assert.equal(accepted.importedEntries, Object.values(expectedState).reduce((total, entries) => total + entries.length, 0));
  await assert.rejects(accept("inner-runner-real.json", bytes), { code: "RECOVERY_HANDOFF_THREAD_ALREADY_USED" });
  const transferred = await candidate.rpc("prepare", { threadId: "thread-a", fileName: "inner-runner-transferred.json" });
  assert.deepEqual(JSON.parse(fs.readFileSync(transferred.filePath, "utf8")).payload.snapshot.state, expectedState);
  await candidate.rpc("cancel", { threadId: "thread-a", token: transferred.token });
  await state.turn(candidate, 5, "three", "active");
  assert.match((await state.request(candidate, "three")).body, /proxy_repeated_empty_idle/u);
  const before = state.calls();
  assert.match((await state.request(candidate, "three")).body, /proxy_repeated_empty_idle/u);
  assert.equal(state.calls(), before);
  await state.turn(candidate, 6, "three", "terminal");
  const retained = await candidate.rpc("prepare", { threadId: "thread-a", fileName: "inner-runner-retained.json" });
  assert.equal(JSON.parse(fs.readFileSync(retained.filePath, "utf8")).payload.snapshot.state.emptyIdleTurns[0][1].count, 3);
  await candidate.rpc("cancel", { threadId: "thread-a", token: retained.token });
  await assert.rejects(old.rpc("cancel", { threadId: "thread-a", token: crypto.randomUUID() }), { code: "RECOVERY_HANDOFF_TOKEN_MISMATCH" });
  await old.rpc("cancel", { threadId: "thread-a", token: saved.token });
  const stillTwo = await old.rpc("prepare", { threadId: "thread-a", fileName: "inner-runner-old-retained.json" });
  assert.equal(JSON.parse(fs.readFileSync(stillTwo.filePath, "utf8")).payload.snapshot.state.emptyIdleTurns[0][1].count, 2);
  await old.rpc("cancel", { threadId: "thread-a", token: stillTwo.token });
});

test("normal runner cancels its own freeze after an injected checkpoint write failure", { timeout: 30000 }, async context => {
  const state = await fixture(context);
  const old = await state.launch("old", true);
  for (const [sequence, turnId] of [[1, "one"], [3, "two"]]) {
    await state.turn(old, sequence, turnId, "active");
    await state.request(old, turnId);
    await state.turn(old, sequence + 1, turnId, "terminal");
  }
  await assert.rejects(old.rpc("prepare", { threadId: "thread-a", fileName: "inner-runner-write-failure.json" }), { code: "EIO" });
  assert.equal((await old.rpc("check", { threadId: "thread-a" })).prepared, false);
  assert.equal(fs.existsSync(path.join(state.root, "inner-runner-write-failure.json")), false);
  assert.equal(fs.readdirSync(state.root).filter(name => name.endsWith(".pending")).length, 0);
  const retained = await old.rpc("prepare", { threadId: "thread-a", fileName: "inner-runner-after-failure.json" });
  assert.equal(JSON.parse(fs.readFileSync(retained.filePath, "utf8")).payload.snapshot.state.emptyIdleTurns[0][1].count, 2);
  await old.rpc("cancel", { threadId: "thread-a", token: retained.token });
  await state.turn(old, 5, "three", "active");
  assert.match((await state.request(old, "three")).body, /proxy_repeated_empty_idle/u);
  await state.turn(old, 6, "three", "terminal");
});
