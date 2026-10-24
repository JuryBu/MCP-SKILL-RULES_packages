import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { buildProxyParentLiveBundle } from "../src/proxy-live-build.mjs";
import { createProxyWholeRuntimeControl, createProxyWholeRuntimeControlImplementation } from "../src/proxy-whole-runtime-control.mjs";
import { CodexAppServerProxy } from "../src/codex-app-server-proxy.mjs";
import { createProxyClassCodeParticipant, loadProxyLiveCompiledBundle } from "../src/proxy-live-code-runtime.mjs";
import { fixture, until } from "./managed-session-code-fixture.mjs";

const require = createRequire(import.meta.url);
const compilerPath = process.env.CODEX_LIVE_ESBUILD_MODULE;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function legacyParentModule() {
  const manifestPath = process.env.CODEX_TEST_LEGACY_PARENT_MANIFEST;
  if (manifestPath) return loadProxyLiveCompiledBundle(path.dirname(manifestPath), manifestPath,
    process.env.CODEX_TEST_LEGACY_PARENT_SHA256).module;
  class LegacyProxy extends CodexAppServerProxy {
    async _liveHandleControlRequest(request, response) {
      this.legacyControlRequests = (this.legacyControlRequests ?? 0) + 1;
      if (new URL(request.url, "http://127.0.0.1").pathname === "/v1/full-runtime/discard") {
        response.statusCode = 404;
        response.end(JSON.stringify({ ok: false, error: { code: "NOT_FOUND" } }));
        return;
      }
      return super._liveHandleControlRequest(request, response);
    }
  }
  return { CodexAppServerProxy: LegacyProxy };
}

test("whole discard through authenticated production-mode HTTP preserves unrelated live work and retry state", {
  timeout: 45000, skip: !compilerPath,
}, async context => {
  const entries = [];
  let ownerId;
  const value = await fixture(context, { parent: true, production: true,
    async configure({ candidateRoot, configuration, sourceRoot }) {
      ownerId = configuration.ownerId;
      for (const id of ["discard-first", "discard-next"]) {
        const installationRoot = path.join(candidateRoot, id);
        fs.mkdirSync(installationRoot);
        const source = path.join(installationRoot, "src");
        const built = await buildProxyParentLiveBundle({ sourceRoot, destinationRoot: source,
          version: id, compiler: require(compilerPath) });
        const names = { runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
          helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" };
        const expectedHashes = Object.fromEntries(Object.entries(names)
          .map(([key, name]) => [key, digest(fs.readFileSync(path.join(source, name)))]));
        fs.writeFileSync(path.join(installationRoot, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1,
          kind: "candidate", ownerId, nativeSourceId: configuration.nativeSourceId }));
        entries.push({ built, candidate: { id, installationRoot, runnerPath: path.join(source, names.runner), expectedHashes } });
      }
      configuration.approvedCandidates = [];
    } });
  const token = fs.readFileSync(value.shared.options.tokenFilePath, "utf8").trim();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const endpoint = `http://127.0.0.1:${value.ports.control}/v1/full-runtime`;
  const status = async () => (await fetch(endpoint, { headers })).json();
  const call = async (method, input, code, authorization = headers.authorization) => {
    const response = await fetch(`${endpoint}/${method}`, { method: "POST",
      headers: { ...headers, authorization }, body: JSON.stringify(input) });
    const result = await response.json();
    if (code) {
      assert.notEqual(response.status, 200, JSON.stringify(result));
      assert.equal(result.ok, false);
      assert.equal(result.error.code, code, JSON.stringify(result));
    } else {
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.ok, true);
    }
    return result;
  };
  const binding = { instanceId: (await status()).instanceId, expectedRevision: 0 };
  const registration = async entry => ({ ...binding, expectedRegistrySha256: (await status()).candidateRegistrySha256,
    manifestPath: entry.built.manifestPath, manifestSha256: entry.built.manifestSha256, candidate: entry.candidate });
  const prepare = entry => call("prepare", { ...binding, manifestPath: entry.built.manifestPath,
    manifestSha256: entry.built.manifestSha256, workerCandidateId: entry.candidate.id });
  const discard = prepared => ({ ...binding, ownerId, preparationId: prepared.id });
  await call("register", await registration(entries[0]));
  const socket = await value.connect();
  await value.rpc(socket, "initialize", { clientInfo: { name: "whole-discard-owned", version: "1" } });
  await value.turn(socket, "unrelated-inflight", "unrelated-turn");
  const inflight = value.request("unrelated-inflight", "unrelated-turn");
  await until(() => value.held.length === 1);
  const originalWorker = value.shared.coordinator.status().defaultWorkerId;
  const first = await prepare(entries[0]);
  const other = await prepare(entries[0]);
  const registryBeforeDiscard = (await status()).candidateRegistrySha256;
  const wholeState = value.shared.parentCodeRuntime.liveCodeParticipant().snapshot().state;
  const coordinatorState = value.shared.coordinator.liveCodeParticipant().snapshot().state;
  const beforeReplacement = await prepare(entries[0]);
  await call("discard", discard(beforeReplacement));
  const afterReplacement = await prepare(entries[0]);
  const proxy = value.shared.recoveryProxy;
  const classParticipant = createProxyClassCodeParticipant(proxy);
  const legacyModule = legacyParentModule();
  const originalClass = classParticipant.activate(classParticipant.prepare(legacyModule));
  assert.equal(Object.getPrototypeOf(proxy), legacyModule.CodexAppServerProxy.prototype);
  const wholeParticipant = value.shared.parentCodeRuntime.liveCodeParticipant();
  if (legacyModule.createProxyWholeRuntimeControlImplementation) {
    wholeParticipant.activate(wholeParticipant.prepare(legacyModule));
  }
  await call("discard?legacy-parent=1", discard(afterReplacement));
  if (legacyModule.createProxyWholeRuntimeControlImplementation) {
    wholeState.preparations.get(first.id).discardPending = true;
    await call("activate", { ...binding, preparationId: first.id }, "LIVE_WHOLE_DISCARD_PENDING");
    delete wholeState.preparations.get(first.id).discardPending;
    wholeParticipant.activate(wholeParticipant.prepare({ createProxyWholeRuntimeControlImplementation }));
  }
  await status();
  if (!process.env.CODEX_TEST_LEGACY_PARENT_MANIFEST) assert.ok(proxy.legacyControlRequests > 0);
  context.diagnostic("discard HTTP status before and after legacy parent replacement: 200 -> 200");

  await context.test("identity, revision, owner, token, explicit ID and extra worker override are checked before mutation", async () => {
    const before = await status();
    for (const [change, code] of [
      [{ instanceId: "wrong-instance" }, "LIVE_WHOLE_STALE_BINDING"],
      [{ expectedRevision: 9 }, "LIVE_WHOLE_STALE_BINDING"],
      [{ ownerId: "wrong-owner" }, "LIVE_WHOLE_OWNER_MISMATCH"],
      [{ ownerId: undefined }, "LIVE_WHOLE_OWNER_MISMATCH"],
      [{ preparationId: undefined }, "LIVE_WHOLE_DISCARD_INVALID"],
      [{ preparationId: "not-found" }, "LIVE_WHOLE_PREPARATION_REQUIRED"],
      [{ workerId: other.workerId }, "LIVE_WHOLE_DISCARD_INVALID"],
    ]) await call("discard", { ...discard(first), ...change }, code);
    await call("discard", discard(first), "UNAUTHORIZED", "Bearer wrong-token");
    assert.deepEqual((await status()).preparedWorkers, before.preparedWorkers);
    assert.deepEqual((await status()).prepared, before.prepared);
    assert.equal(value.shared.coordinator.status().workers.length, 3);
  });

  await context.test("a worker referenced by an in-flight request remains protected and cancellation remains retryable", async () => {
    const worker = coordinatorState.workers.get(other.workerId);
    coordinatorState.requests.set("owned-discard-reference", { worker });
    try {
      await call("discard", discard(other), "COORDINATOR_CANDIDATE_PROTECTED");
      assert.equal(coordinatorState.workers.get(other.workerId), worker);
      assert.ok((await status()).prepared.some(entry => entry.id === other.id));
      assert.equal((await status()).preparedWorkers.find(entry => entry.id === other.id).discardPending, true);
      await call("activate", { ...binding, preparationId: other.id }, "LIVE_WHOLE_DISCARD_PENDING");
    } finally { coordinatorState.requests.delete("owned-discard-reference"); }
  });

  await context.test("worker discard failure keeps both records and concurrent mutations remain serialized", async () => {
    const workerDiscard = wholeState.coordinator.discardCandidate;
    let release;
    wholeState.coordinator.discardCandidate = async () => {
      await new Promise(resolve => { release = resolve; });
      throw Object.assign(new Error("OWNED_WORKER_DISCARD_FAILURE"), { code: "OWNED_WORKER_DISCARD_FAILURE" });
    };
    const pending = call("discard", discard(first), "OWNED_WORKER_DISCARD_FAILURE");
    try {
      await until(() => Boolean(release));
      await call("discard", discard(other), "LIVE_WHOLE_RUNTIME_BUSY_OR_FAILED");
      await call("register", await registration(entries[1]), "LIVE_WHOLE_RUNTIME_BUSY_OR_FAILED");
    } finally {
      release?.();
      await pending;
      wholeState.coordinator.discardCandidate = workerDiscard;
    }
    const failed = await status();
    assert.equal(failed.busy, false);
    assert.equal(failed.prepared.length, 2);
    assert.equal(failed.preparedWorkers.length, 2);
    assert.ok(value.shared.coordinator.status().workers.find(entry => entry.workerId === first.workerId).alive);
  });

  await context.test("cancellation removes only the named preparation while the existing stream and next gate survive", async () => {
    const result = await call("discard", discard(first));
    assert.equal(result.discarded, true);
    assert.equal(result.worker.workerId, first.workerId);
    assert.equal(result.worker.discarded, true);
    assert.deepEqual((await status()).preparedWorkers.map(entry => entry.id), [other.id]);
    assert.deepEqual((await status()).prepared.map(entry => entry.id), [other.id]);
    assert.equal(value.shared.coordinator.status().defaultWorkerId, originalWorker);
    assert.ok(value.shared.coordinator.status().workers.find(entry => entry.workerId === other.workerId).alive);
    assert.equal(value.held[0].writableEnded, false);
    await call("register", await registration(entries[1]), "LIVE_WHOLE_PREPARATIONS_PENDING");
    await call("discard", discard(first), "LIVE_WHOLE_PREPARATION_REQUIRED");
  });

  await context.test("parent failure retains the binding after worker shutdown and retry uses the original receipt", async () => {
    const parentDiscard = wholeState.parent.discard;
    wholeState.parent.discard = () => { throw Object.assign(new Error("OWNED_PARENT_DISCARD_FAILURE"), { code: "OWNED_PARENT_DISCARD_FAILURE" }); };
    try {
      await call("discard", discard(other), "OWNED_PARENT_DISCARD_FAILURE");
      const failed = await status();
      assert.equal(failed.busy, false);
      assert.ok(failed.prepared.some(entry => entry.id === other.id));
      assert.equal(failed.preparedWorkers.find(entry => entry.id === other.id).discardPending, true);
      assert.ok(value.shared.coordinator.status().reclaimedWorkers.some(entry => entry.workerId === other.workerId));
      await call("register", await registration(entries[1]), "LIVE_WHOLE_PREPARATIONS_PENDING");
    } finally { wholeState.parent.discard = parentDiscard; }
    const retried = await call("discard", discard(other));
    assert.equal(retried.worker.alreadyDiscarded, true);
    assert.deepEqual((await status()).preparedWorkers, []);
    assert.deepEqual((await status()).prepared, []);
    assert.equal((await status()).candidateRegistrySha256, registryBeforeDiscard);
    const receipts = value.shared.coordinator.status().reclaimedWorkers;
    assert.ok(receipts.filter(entry => [first.workerId, other.workerId].includes(entry.workerId))
      .every(entry => entry.exitCode === 0));
    context.diagnostic(JSON.stringify({ discardedWorkers: receipts.map(({ workerId, pid, exitCode }) => ({ workerId, pid, exitCode })),
      registryUnchangedByDiscard: true }));
    await call("register", await registration(entries[1]));
    assert.equal((await status()).revision, 0);
    assert.equal((await status()).selected.id, "original");
    assert.equal((await status()).modelWorker, null);
    assert.equal(value.shared.coordinator.status().defaultWorkerId, originalWorker);
    value.release();
    assert.equal((await inflight).status, 200);
    assert.equal((await value.rpc(socket, "test/tool", { value: "after-discard" })).result.value, "after-discard");
  });

  await context.test("the dynamically activated whole implementation refuses cancellation of its selected candidate", async () => {
    const prepared = await prepare(entries[1]);
    await call("activate", { ...binding, preparationId: prepared.id });
    const before = await status();
    await call("discard", { ...discard(prepared), expectedRevision: before.revision }, "LIVE_WHOLE_CANDIDATE_PROTECTED");
    assert.deepEqual((await status()).selected, before.selected);
    assert.equal(value.shared.coordinator.status().defaultWorkerId, prepared.workerId);
    assert.ok(value.shared.coordinator.status().workers.find(entry => entry.workerId === prepared.workerId).alive);
  });

  await context.test("restoring the original proxy class preserves the guarded discard route", async () => {
    classParticipant.restore(originalClass);
    await call("discard", { ...binding, expectedRevision: (await status()).revision, ownerId,
      preparationId: "not-found-after-class-restore" }, "LIVE_WHOLE_PREPARATION_REQUIRED");
  });
});

test("the fixed facade keeps guarded discard available after a legacy whole implementation is selected", async () => {
  const runtime = createProxyWholeRuntimeControl({ status: () => ({ revision: 0 }) },
    { status: () => ({ defaultWorkerId: "serving" }) }, { ownerId: "owned" }, "instance", null);
  const participant = runtime.liveCodeParticipant();
  const legacy = Object.fromEntries(["status", "register", "prepare", "activate", "restore", "recover"].map(name => [name, () => ({})]));
  participant.activate(participant.prepare({ createProxyWholeRuntimeControlImplementation: () => legacy }));
  await assert.rejects(runtime.discard({ instanceId: "instance", expectedRevision: 0,
    ownerId: "owned", preparationId: "missing" }), { code: "LIVE_WHOLE_PREPARATION_REQUIRED" });
  participant.snapshot().state.preparations.set("pending", { discardPending: true });
  assert.throws(() => runtime.activate({ instanceId: "instance", expectedRevision: 0,
    preparationId: "pending" }), { code: "LIVE_WHOLE_DISCARD_PENDING" });
});
