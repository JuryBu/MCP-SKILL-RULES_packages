import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { buildProxyParentLiveBundle } from "../src/proxy-live-build.mjs";
import { fixture, until } from "./managed-session-code-fixture.mjs";

const require = createRequire(import.meta.url);
const compilerPath = process.env.CODEX_LIVE_ESBUILD_MODULE;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

test("six full HTTP registration and activation cycles reclaim distinct retired source approvals", { timeout: 30000, skip: !compilerPath }, async context => {
  const candidates = [];
  const value = await fixture(context, { parent: true, production: true, async configure({ candidateRoot, configuration, sourceRoot }) {
    const controlPath = path.join(sourceRoot, "inner-runner-handoff-control.mjs");
    const original = fs.readFileSync(controlPath, "utf8");
    const names = { runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
      helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" };
    try {
      for (let index = 0; index < 6; index += 1) {
        const installationRoot = path.join(candidateRoot, `whole-generation-${index}`);
        const source = path.join(installationRoot, "src");
        fs.mkdirSync(installationRoot);
        fs.writeFileSync(controlPath, original + `\nexport const registrationGeneration = ${index};\n`);
        const built = await buildProxyParentLiveBundle({ sourceRoot, destinationRoot: source,
          version: `whole-generation-${index}`, compiler: require(compilerPath) });
        const expectedHashes = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, digest(fs.readFileSync(path.join(source, name)))]));
        fs.writeFileSync(path.join(installationRoot, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1, kind: "candidate",
          ownerId: configuration.ownerId, nativeSourceId: configuration.nativeSourceId }));
        candidates.push({ built, candidate: { id: `whole-generation-${index}`, installationRoot,
          runnerPath: path.join(source, names.runner), expectedHashes } });
      }
    } finally { fs.writeFileSync(controlPath, original); }
    configuration.approvedCandidates = [];
  } });
  const token = fs.readFileSync(value.shared.options.tokenFilePath, "utf8").trim();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const endpoint = `http://127.0.0.1:${value.ports.control}/v1/full-runtime`;
  const status = async () => (await fetch(endpoint, { headers })).json();
  const call = async (method, body) => {
    const response = await fetch(`${endpoint}/${method}`, { method: "POST", headers, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const socket = await value.connect();
  await value.rpc(socket, "initialize", { clientInfo: { name: "repeated-whole-source", version: "1" } });
  for (const [index, entry] of candidates.entries()) {
    const threadId = `finished-generation-${index}`;
    const turnId = `finished-turn-${index}`;
    await value.turn(socket, threadId, turnId);
    await value.rpc(socket, "test/complete", { threadId, turnId });
    await until(() => value.shared.coordinator.status().threads.find(thread => thread.threadId === threadId)?.phase === "terminal");
    const before = await status();
    const binding = { instanceId: before.instanceId, expectedRevision: before.revision };
    await call("register", { ...binding, expectedRegistrySha256: before.candidateRegistrySha256,
      manifestPath: entry.built.manifestPath, manifestSha256: entry.built.manifestSha256, candidate: entry.candidate });
    const prepared = await call("prepare", { ...binding, manifestPath: entry.built.manifestPath,
      manifestSha256: entry.built.manifestSha256, workerCandidateId: entry.candidate.id });
    await call("activate", { ...binding, preparationId: prepared.id });
  }
  const final = await status();
  assert.equal(final.revision, 6);
  assert.equal(final.approvedCandidateIds.length, 4);
  assert.ok(value.shared.coordinator.status().reclaimedWorkers.length >= 3);
  assert.equal(socket.readyState, 1);
  assert.equal((await value.rpc(socket, "test/tool", { value: "after-six-registrations" })).result.value, "after-six-registrations");
  context.diagnostic(JSON.stringify({ fullHttpCycles: 6, distinctSourceApprovals: 4,
    reclaimedWorkers: value.shared.coordinator.status().reclaimedWorkers.length, sameSocket: true, paidRequests: 0 }));
});

test("the same pinned whole source registers then switches five parents and a model worker through authenticated production-mode HTTP", { timeout: 20000, skip: !compilerPath }, async context => {
  let built;
  let approved;
  let compatibility;
  const value = await fixture(context, { parent: true, production: true, async configure({ candidateRoot, configuration, sourceRoot }) {
    const installationRoot = path.join(candidateRoot, "whole-source");
    fs.mkdirSync(installationRoot);
    const target = path.join(installationRoot, "src");
    built = await buildProxyParentLiveBundle({ sourceRoot, destinationRoot: target, version: "whole-with-worker", compiler: require(compilerPath) });
    const names = { runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
      helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" };
    const expectedHashes = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, digest(fs.readFileSync(path.join(target, name)))]));
    assert.deepEqual(expectedHashes, configuration.initial.expectedHashes);
    fs.writeFileSync(path.join(installationRoot, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1, kind: "candidate",
      ownerId: configuration.ownerId, nativeSourceId: configuration.nativeSourceId }));
    approved = { id: "whole-source-model-worker", installationRoot, runnerPath: path.join(target, names.runner), expectedHashes };
    configuration.approvedCandidates = [];
    const oldRoot = path.join(configuration.outerStateRoot, "owned-original-version");
    const oldSource = path.join(oldRoot, "src");
    fs.mkdirSync(oldSource, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(built.manifestPath, "utf8"));
    for (const file of manifest.files.filter(file => file.path.endsWith(".mjs"))) {
      fs.copyFileSync(path.join(target, file.path), path.join(oldSource, file.path));
    }
    const oldCorePath = path.join(oldSource, names.core);
    const oldCore = fs.readFileSync(oldCorePath, "utf8");
    assert.ok(oldCore.includes("fastRetryThresholdMs = 8000"));
    fs.writeFileSync(oldCorePath, oldCore.replace("fastRetryThresholdMs = 8000", "fastRetryThresholdMs = 12000"));
    configuration.installationRoot = oldRoot;
    configuration.initial = { runnerPath: path.join(oldSource, names.runner), expectedHashes:
      Object.fromEntries(Object.entries(names).map(([key, name]) => [key, digest(fs.readFileSync(path.join(oldSource, name)))])) };
    assert.notEqual(configuration.initial.expectedHashes.core, approved.expectedHashes.core);
    const compatibilityManifest = { schemaVersion: 1, edges: [{ source: { core: configuration.initial.expectedHashes.core,
      helper: configuration.initial.expectedHashes.helper }, target: { core: expectedHashes.core, helper: expectedHashes.helper },
      checkpointSchemaVersion: 1, stateSchemaVersion: 1, stateSemantics: "state-v1" }] };
    compatibility = { manifest: compatibilityManifest, sha256: digest(JSON.stringify(compatibilityManifest)) };
  } });
  const { session, shared } = value;
  const token = fs.readFileSync(shared.options.tokenFilePath, "utf8").trim();
  const identity = { ownerId: shared.configuration.ownerId, nativeSourceId: shared.configuration.nativeSourceId,
    instanceToken: shared.options.instanceToken };
  async function status() {
    const response = await fetch(`http://127.0.0.1:${value.ports.control}/v1/inner/status`, { headers: { authorization: `Bearer ${token}`,
      "x-inner-owner-id": identity.ownerId, "x-inner-native-source-id": identity.nativeSourceId, "x-inner-instance-token": identity.instanceToken } });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function control(method, fields) {
    const current = await status();
    const response = await fetch(`http://127.0.0.1:${value.ports.control}/v1/inner/${method}`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...identity, requestId: crypto.randomUUID(), expectedRevision: current.revision,
        selectedWorkerId: current.selectedWorkerId, selectedSourceHashes: current.selectedSourceHashes, ...fields }) });
    const receipt = await response.json();
    assert.equal(response.status, 200, JSON.stringify(receipt));
    assert.equal(receipt.ok, true);
    return receipt.result;
  }
  const originalWorker = (await status()).selectedWorkerId;
  const runtime = session.parentCodeRuntime();
  const binding = { instanceId: identity.instanceToken, expectedRevision: 0 };
  async function whole(method, input) {
    const response = await fetch(`http://127.0.0.1:${value.ports.control}/v1/full-runtime/${method}`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
    return result;
  }
  const registered = await whole("register", { ...binding, expectedRegistrySha256: null,
    manifestPath: built.manifestPath, manifestSha256: built.manifestSha256, candidate: approved });
  assert.deepEqual(registered.approvedCandidateIds, [approved.id]);
  assert.equal(runtime.status().participants.length, 5);
  const parent = await whole("prepare", { ...binding, ...built, workerCandidateId: approved.id, compatibility });
  const candidate = { workerId: parent.workerId };
  const socket = await value.connect();
  await value.rpc(socket, "initialize", { clientInfo: { name: "whole-production-source", version: "1" } });
  await value.turn(socket, "whole-thread", "whole-turn");
  const stream = value.request("whole-thread", "whole-turn", [{ role: "user", content: "held-once" }]);
  await until(() => value.held.length === 1);
  const tool = value.rpc(socket, "test/tool", { value: "whole-tool-once", replyDelayMs: 200 });
  await whole("activate", { ...binding, preparationId: parent.id });
  assert.equal((await status()).selectedWorkerId, candidate.workerId);
  const followupInput = [{ type: "function_call_output", call_id: "whole-tool", output: "whole-tool-once" }];
  let continuationResult;
  const continuation = value.request("whole-thread", "whole-turn", followupInput).then(result => { continuationResult = result; return result; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(value.held.length, 1);
  assert.equal((await tool).result.value, "whole-tool-once");
  value.release();
  assert.equal((await stream).status, 200);
  try { await until(() => value.held.length === 2); }
  catch (error) {
    context.diagnostic(JSON.stringify({ continuationResult, coordinator: shared.coordinator.status(), events: value.events.slice(-18) }));
    throw error;
  }
  value.release();
  assert.equal((await continuation).status, 200);
  assert.equal(value.calls.filter(call => call.path === "/v1/responses").length, 2);
  const requests = value.events.filter(event => event.type === "request_routed" && event.requestClass === "turn");
  assert.deepEqual(requests.map(event => event.workerId), [originalWorker, candidate.workerId]);
  for (const target of ["images/generations", "images/edits", "memories/trace_summarize"]) {
    const response = await fetch(`http://127.0.0.1:${value.ports.inner}/backend-api/codex/${target}`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ synthetic: target }) });
    assert.equal(response.status, 200);
    await response.json();
  }
  assert.equal((await fetch(`http://127.0.0.1:${value.ports.inner}/backend-api/codex/models?owned=1`)).status, 200);
  const restored = await whole("restore", { instanceId: identity.instanceToken, expectedRevision: runtime.status().revision });
  const restoredStatus = await status();
  assert.notEqual(restoredStatus.selectedWorkerId, originalWorker);
  assert.deepEqual(restoredStatus.selectedSourceHashes, shared.configuration.initial.expectedHashes);
  assert.equal(restored.modelWorker.freshWorker, true);
  assert.equal(runtime.status().selected.version, "original");
  assert.equal((await value.rpc(socket, "test/tool", { value: "restored-tool" })).result.value, "restored-tool");
  assert.equal(socket.readyState, 1);
  const restoredRequest = value.request("whole-thread", "whole-turn", [{ role: "user", content: "after-whole-restore" }]);
  await until(() => value.held.length === 3);
  value.release();
  assert.equal((await restoredRequest).status, 200);
  assert.equal(value.calls.filter(call => call.path === "/v1/responses").length, 3);
  assert.equal(value.events.filter(event => event.type === "request_routed" && event.requestClass === "turn").at(-1).workerId,
    restoredStatus.selectedWorkerId);
  context.diagnostic(JSON.stringify({ sourceFiles: built.sourceFiles, expectedHashes: approved.expectedHashes,
    workerChanged: true, sameWebSocket: true, paidRequests: 0, restorationFreshWorker: true }));
});

test("a fresh managed session recovers its durable whole-source selection before accepting business and restores independently", { timeout: 25000, skip: !compilerPath }, async context => {
  const value = await fixture(context, { parent: true, production: true, configure({ configuration }) {
    configuration.approvedCandidates = [];
  } });
  const installationRoot = path.join(value.candidateRoot, "durable-whole");
  fs.mkdirSync(installationRoot);
  const built = await buildProxyParentLiveBundle({ sourceRoot: value.sourceRoot, destinationRoot: path.join(installationRoot, "src"),
    version: "durable-whole", compiler: require(compilerPath) });
  fs.writeFileSync(path.join(installationRoot, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1, kind: "candidate",
    ownerId: value.shared.configuration.ownerId, nativeSourceId: value.shared.configuration.nativeSourceId }));
  const candidate = { id: "durable-worker", installationRoot,
    runnerPath: path.join(installationRoot, "src", "codex-model-stream-proxy-runner.mjs"), expectedHashes: value.shared.configuration.initial.expectedHashes };
  const runtime = value.session.parentCodeRuntime();
  const binding = { instanceId: value.shared.options.instanceToken, expectedRevision: runtime.status().revision };
  runtime.register({ ...binding, expectedRegistrySha256: null, manifestPath: built.manifestPath, manifestSha256: built.manifestSha256, candidate });
  const prepared = await runtime.prepare({ ...binding, manifestPath: built.manifestPath, manifestSha256: built.manifestSha256,
    workerCandidateId: candidate.id });
  await runtime.activate({ ...binding, preparationId: prepared.id });
  const previousWorker = runtime.status().modelWorker.workerId;
  const previousInstance = value.shared.options.instanceToken;
  await value.restart();
  const recovered = value.session.parentCodeRuntime();
  assert.notEqual(value.shared.options.instanceToken, previousInstance);
  assert.equal(recovered.status().selected.version, "durable-whole");
  assert.notEqual(recovered.status().modelWorker.workerId, previousWorker);
  assert.deepEqual(recovered.status().modelWorker.sourceHashes, candidate.expectedHashes);
  assert.equal(recovered.status().participants.length, 5);
  const socket = await value.connect();
  await value.rpc(socket, "initialize", { clientInfo: { name: "durable-session-business", version: "1" } });
  await value.turn(socket, "durable-thread", "durable-turn");
  const stream = value.request("durable-thread", "durable-turn");
  await until(() => value.held.length === 1);
  assert.equal((await value.rpc(socket, "test/tool", { value: "durable-tool" })).result.value, "durable-tool");
  value.release();
  assert.equal((await stream).status, 200);
  assert.equal(value.calls.filter(call => call.method === "POST").length, 1);
  await recovered.restore({ instanceId: value.shared.options.instanceToken, expectedRevision: recovered.status().revision });
  assert.equal(recovered.status().selected.version, "original");
  assert.equal(JSON.parse(fs.readFileSync(path.join(value.shared.runtimeProfile.stateRoot, "inner-candidate-approvals.json"))).selection, null);
  assert.equal(socket.readyState, 1);
  context.diagnostic(JSON.stringify({ freshSessionRecovered: true, freshWorker: true, versions: 1, postExecutions: 1,
    restoreAfterReload: true, paidRequests: 0, productionActions: 0 }));
});

test("compiled five-object failures compensate real workers, preserve the prior restore and keep durable selection coherent", { timeout: 30000, skip: !compilerPath }, async context => {
  const value = await fixture(context, { parent: true, production: true, configure({ configuration }) {
    configuration.approvedCandidates = [];
  } });
  const { session, shared } = value;
  const runtime = session.parentCodeRuntime();
  const compiler = require(compilerPath);
  async function prepareVersion(version, failFactory = false) {
    const installationRoot = path.join(value.candidateRoot, version);
    fs.mkdirSync(installationRoot);
    const built = await buildProxyParentLiveBundle({ sourceRoot: value.sourceRoot,
      destinationRoot: path.join(installationRoot, "src"), version, compiler: failFactory ? {
        build: compiler.build, version: compiler.version,
        transform(source, options) {
          const marker = "export function createProxyWholeRuntimeControlImplementation(state) {";
          if (source.includes(marker)) source = source.replace(marker,
            `${marker}\nif (!Object.isFrozen(state)) { state.selected = null; state.preparations.clear(); throw new Error("SYNTHETIC_FACTORY_ACTIVATION_FAILED"); }`);
          return compiler.transform(source, options);
        },
      } : compiler });
    fs.writeFileSync(path.join(installationRoot, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1, kind: "candidate",
      ownerId: shared.configuration.ownerId, nativeSourceId: shared.configuration.nativeSourceId }));
    const candidate = { id: `${version}-worker`, installationRoot,
      runnerPath: path.join(installationRoot, "src", "codex-model-stream-proxy-runner.mjs"), expectedHashes: shared.configuration.initial.expectedHashes };
    const binding = { instanceId: shared.options.instanceToken, expectedRevision: runtime.status().revision };
    runtime.register({ ...binding, expectedRegistrySha256: runtime.status().candidateRegistrySha256,
      manifestPath: built.manifestPath, manifestSha256: built.manifestSha256, candidate });
    const prepared = await runtime.prepare({ ...binding, ...built, workerCandidateId: candidate.id });
    return { ...binding, preparationId: prepared.id };
  }
  const initial = await prepareVersion("failure-A");
  await runtime.activate(initial);
  const selectedWorker = runtime.status().modelWorker.workerId;
  const originalRename = fs.renameSync;
  const failDurable = (...arguments_) => {
    if (String(arguments_[1]).endsWith("inner-candidate-approvals.json")) throw new Error("SYNTHETIC_DURABLE_WRITE_FAILED");
    return originalRename(...arguments_);
  };
  const next = await prepareVersion("failure-B");
  fs.renameSync = failDurable;
  try { await assert.rejects(runtime.activate(next), /SYNTHETIC_DURABLE_WRITE_FAILED/); }
  finally { fs.renameSync = originalRename; }
  assert.equal(runtime.status().selected.version, "failure-A");
  assert.equal(runtime.status().previous.version, "original");
  assert.equal(runtime.status().modelWorker.workerId, selectedWorker);
  assert.equal(runtime.status().preparedWorkers.length, 0);
  assert.equal(runtime.status().prepared.length, 0);
  const throwing = await prepareVersion("failure-C", true);
  await assert.rejects(runtime.activate(throwing), /SYNTHETIC_FACTORY_ACTIVATION_FAILED/);
  assert.equal(runtime.status().selected.version, "failure-A");
  assert.equal(runtime.status().modelWorker.workerId, selectedWorker);
  const binding = { instanceId: shared.options.instanceToken, expectedRevision: runtime.status().revision };
  fs.renameSync = failDurable;
  try { await assert.rejects(runtime.restore(binding), /SYNTHETIC_DURABLE_WRITE_FAILED/); }
  finally { fs.renameSync = originalRename; }
  assert.equal(runtime.status().selected.version, "failure-A");
  assert.equal(runtime.status().modelWorker.workerId, selectedWorker);
  assert.equal((await runtime.recover()).failed, false);
  const registryPath = path.join(shared.runtimeProfile.stateRoot, "inner-candidate-approvals.json");
  assert.equal(JSON.parse(fs.readFileSync(registryPath)).selection.candidateId, "failure-A-worker");
  await runtime.restore({ instanceId: shared.options.instanceToken, expectedRevision: runtime.status().revision });
  assert.equal(runtime.status().selected.version, "original");
  assert.equal(JSON.parse(fs.readFileSync(registryPath)).selection, null);
  assert.deepEqual(shared.coordinator.status().workers.find(worker => worker.workerId === shared.coordinator.status().defaultWorkerId).sourceHashes,
    shared.configuration.initial.expectedHashes);
  const socket = await value.connect();
  await value.rpc(socket, "initialize", { clientInfo: { name: "whole-failure-recovered", version: "1" } });
  await value.turn(socket, "failure-thread", "failure-turn");
  const stream = value.request("failure-thread", "failure-turn");
  await until(() => value.held.length === 1);
  value.release();
  assert.equal((await stream).status, 200);
  assert.equal(value.calls.filter(call => call.method === "POST").length, 1);
  context.diagnostic(JSON.stringify({ failureCases: 3, parentAndWorkerCompensated: true, durableCoherent: true,
    independentRestorePreserved: true, postExecutions: 1, paidRequests: 0, productionActions: 0 }));
});

test("compiled whole parent switches four real objects with the same WebSocket, held response and pending tool, then restores", { timeout: 30000, skip: !compilerPath }, async context => {
  const value = await fixture(context, { parent: true });
  const { session, shared } = value;
  const serviceState = session.serviceCodeParticipant().snapshot().state;
  const proxy = serviceState.proxy;
  const participants = [shared.sessionCodeParticipant, shared.coordinator.liveCodeParticipant(), session.serviceCodeParticipant()];
  const coordinatorState = participants[1].snapshot().state;
  const retained = { proxy, coordinator: shared.coordinator, native: shared.nativeSource, workerMap: coordinatorState.workers,
    threads: coordinatorState.threads, controlOperations: shared.controlOperations, completion: shared.completion,
    stopIdentity: shared.stopIdentity, webSocketServer: proxy.websocketServer, controlServer: proxy.controlServer,
    clients: proxy.clients, lock: serviceState.lock, appServer: serviceState.appServer };
  const selectedWorker = session.status().coordinator.defaultWorkerId;
  const socket = await value.connect();
  let closes = 0;
  socket.on("close", () => { closes++; });
  await value.rpc(socket, "initialize", { clientInfo: { name: "whole-parent-live", version: "1" } });
  await value.turn(socket, "parent-thread", "parent-turn");
  const stream = value.request("parent-thread", "parent-turn");
  await until(() => value.held.length === 1);
  const pendingTool = value.rpc(socket, "test/tool", { value: "pending-tool", replyDelayMs: 500 });
  const originalPrototype = Object.getPrototypeOf(proxy);
  const originalImplementations = participants.map(participant => participant.snapshot().implementation);
  const completion = session.waitForClose();
  const token = fs.readFileSync(shared.options.tokenFilePath, "utf8").trim();
  async function control(method, input) {
    const response = await fetch(`http://127.0.0.1:${value.ports.control}/v1/full-runtime${method ? "/" + method : ""}`, {
      method: method ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(method ? { body: JSON.stringify(input) } : {}) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  }
  const compiler = require(compilerPath);
  let retired;
  for (let generation = 1; generation <= 5; generation++) {
    const built = await buildProxyParentLiveBundle({ sourceRoot: value.sourceRoot,
      destinationRoot: path.join(value.candidateRoot, `generation-${generation}`), version: `whole-${generation}`, compiler });
    assert.ok(built.sourceFiles > 10);
    const before = await control();
    assert.equal(before.participants.length, 4);
    const input = { instanceId: shared.options.instanceToken, expectedRevision: before.revision };
    const prepared = await control("prepare", { ...input, manifestPath: built.manifestPath, manifestSha256: built.manifestSha256 });
    const activated = await control("activate", { ...input, preparationId: prepared.id });
    assert.equal(activated.selected.version, `whole-${generation}`);
    assert.ok(activated.actualMs < 1000);
    assert.notStrictEqual(Object.getPrototypeOf(proxy), originalPrototype);
    participants.forEach((participant, index) => assert.notStrictEqual(participant.snapshot().implementation, originalImplementations[index]));
    if (generation === 1) retired = [new WeakRef(Object.getPrototypeOf(proxy)),
      ...participants.map(participant => new WeakRef(participant.snapshot().implementation))];
    assert.strictEqual(proxy, retained.proxy);
    assert.strictEqual(shared.coordinator, retained.coordinator);
    assert.strictEqual(shared.nativeSource, retained.native);
    assert.strictEqual(coordinatorState.workers, retained.workerMap);
    assert.strictEqual(coordinatorState.threads, retained.threads);
    assert.strictEqual(shared.controlOperations, retained.controlOperations);
    assert.strictEqual(session.waitForClose(), completion);
    assert.equal(shared.stopIdentity, retained.stopIdentity);
    assert.strictEqual(proxy.websocketServer, retained.webSocketServer);
    assert.strictEqual(proxy.controlServer, retained.controlServer);
    assert.strictEqual(proxy.clients, retained.clients);
    assert.strictEqual(serviceState.lock, retained.lock);
    assert.strictEqual(serviceState.appServer, retained.appServer);
    assert.equal(session.status().coordinator.defaultWorkerId, selectedWorker);
    assert.equal((await value.rpc(socket, "test/tool", { value: `generation-${generation}` })).result.value, `generation-${generation}`);
    const catalog = await fetch(`http://127.0.0.1:${value.ports.inner}/backend-api/codex/models`);
    assert.equal(catalog.status, 200);
    await catalog.json();
    assert.equal(closes, 0);
  }
  const status = await control();
  const restored = await control("restore", { instanceId: shared.options.instanceToken, expectedRevision: status.revision });
  assert.equal(restored.selected.version, "whole-4");
  assert.equal((await pendingTool).result.value, "pending-tool");
  value.release();
  const response = await stream;
  assert.equal(response.status, 200);
  assert.match(response.body, /response.completed/);
  assert.equal(value.calls.filter(call => call.method === "POST").length, 1);
  assert.equal(closes, 0);
  if (typeof globalThis.gc === "function") {
    await new Promise(resolve => setTimeout(resolve, 100));
    await new Promise(resolve => setImmediate(resolve));
    globalThis.gc();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(retired.every(reference => reference.deref() === undefined), "all four retired compiled implementations are collected");
  }
  await value.rpc(socket, "test/complete", { threadId: "parent-thread", turnId: "parent-turn" });
  await until(() => shared.coordinator.status().threads.every(thread => thread.phase === "terminal"));
  context.diagnostic(JSON.stringify({ sourceFiles: fs.readdirSync(value.candidateRoot).length, generations: 5,
    sameWebSocket: true, retries: 0, postExecutions: 1, toolResult: "pending-tool", restoration: "whole-4" }));
});

test("five production objects and workers switch five versions during one active turn, preserve each stream and collect old code", { timeout: 30000, skip: !compilerPath }, async context => {
  const value = await fixture(context, { parent: true, production: true, configure({ configuration }) {
    configuration.approvedCandidates = [];
  } });
  const { session, shared } = value;
  const runtime = session.parentCodeRuntime();
  const participants = [shared.coordinator.liveCodeParticipant(), shared.sessionCodeParticipant,
    session.serviceCodeParticipant(), runtime.liveCodeParticipant()];
  const service = session.serviceCodeParticipant().snapshot().state;
  const proxy = service.proxy;
  const socket = await value.connect();
  let closes = 0;
  socket.on("close", () => { closes += 1; });
  await value.rpc(socket, "initialize", { clientInfo: { name: "five-production-objects", version: "1" } });
  await value.turn(socket, "five-thread", "five-turn");
  const compiler = require(compilerPath);
  let retired;
  for (let generation = 1; generation <= 5; generation += 1) {
    const installationRoot = path.join(value.candidateRoot, `five-${generation}`);
    fs.mkdirSync(installationRoot);
    const built = await buildProxyParentLiveBundle({ sourceRoot: value.sourceRoot,
      destinationRoot: path.join(installationRoot, "src"), version: `five-${generation}`, compiler });
    fs.writeFileSync(path.join(installationRoot, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1, kind: "candidate",
      ownerId: shared.configuration.ownerId, nativeSourceId: shared.configuration.nativeSourceId }));
    const candidate = { id: `five-worker-${generation}`, installationRoot,
      runnerPath: path.join(installationRoot, "src", "codex-model-stream-proxy-runner.mjs"), expectedHashes: shared.configuration.initial.expectedHashes };
    const binding = { instanceId: shared.options.instanceToken, expectedRevision: runtime.status().revision };
    runtime.register({ ...binding, expectedRegistrySha256: runtime.status().candidateRegistrySha256,
      manifestPath: built.manifestPath, manifestSha256: built.manifestSha256, candidate });
    const prepared = await runtime.prepare({ ...binding, manifestPath: built.manifestPath, manifestSha256: built.manifestSha256,
      workerCandidateId: candidate.id });
    const heldBefore = value.held.length;
    const stream = value.request("five-thread", "five-turn", [{ role: "user", content: `generation-${generation}` }]);
    await until(() => value.held.length === heldBefore + 1);
    await runtime.activate({ ...binding, preparationId: prepared.id });
    assert.equal(runtime.status().selected.version, `five-${generation}`);
    assert.equal(runtime.status().participants.length, 5);
    if (generation === 1) retired = [new WeakRef(Object.getPrototypeOf(proxy)),
      ...participants.map(participant => new WeakRef(participant.snapshot().implementation))];
    assert.equal(socket.readyState, 1);
    assert.equal((await value.rpc(socket, "test/tool", { value: `five-tool-${generation}` })).result.value, `five-tool-${generation}`);
    assert.equal(closes, 0);
    assert.ok(shared.runtimeProfile.approvedCandidates.length <= 4);
    const continuation = value.request("five-thread", "five-turn", [{ type: "function_call_output",
      call_id: `five-tool-${generation}`, output: `five-tool-${generation}` }]);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(value.held.length, heldBefore + 1);
    value.release();
    assert.equal((await stream).status, 200);
    await until(() => value.held.length === heldBefore + 2);
    value.release();
    assert.equal((await continuation).status, 200);
    assert.equal(value.calls.filter(call => call.method === "POST").length, generation * 2);
    assert.notEqual(shared.coordinator.status().threads.find(thread => thread.id === "five-thread")?.phase, "terminal");
  }
  await runtime.restore({ instanceId: shared.options.instanceToken, expectedRevision: runtime.status().revision });
  assert.equal(runtime.status().selected.version, "five-4");
  assert.equal(value.calls.filter(call => call.method === "POST").length, 10);
  if (typeof globalThis.gc === "function") {
    await new Promise(resolve => setTimeout(resolve, 100));
    await new Promise(resolve => setImmediate(resolve));
    globalThis.gc();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(retired.every(reference => reference.deref() === undefined), "five old implementations are collected");
  }
  context.diagnostic(JSON.stringify({ productionObjects: 5, versions: 5, retries: 0, postExecutions: 10,
    streamsPreserved: 5, legitimateContinuations: 5, nativeTurnCompletedBeforeSwitch: false,
    controllerIncluded: true, restoredVersion: "five-4", paidRequests: 0 }));
});

test("a failing compiled whole-parent candidate restores every real object and the original socket", { timeout: 15000, skip: !compilerPath }, async context => {
  const value = await fixture(context, { parent: true });
  const { session, shared } = value;
  const service = session.serviceCodeParticipant().snapshot().state;
  const proxy = service.proxy;
  const original = [Object.getPrototypeOf(proxy), shared.coordinator.liveCodeParticipant().snapshot().implementation,
    shared.sessionCodeParticipant.snapshot().implementation, session.serviceCodeParticipant().snapshot().implementation];
  const socket = await value.connect();
  await value.rpc(socket, "initialize", { clientInfo: { name: "failed-whole-parent", version: "1" } });
  const compiler = require(compilerPath);
  const built = await buildProxyParentLiveBundle({ sourceRoot: value.sourceRoot,
    destinationRoot: path.join(value.candidateRoot, "failing"), version: "failing", compiler: {
      build: compiler.build, version: compiler.version,
      transform(source, options) {
        if (source.includes("export class CodexAppServerProxy")) {
          source = source.replace("  status() {", '  status() { throw new Error("SYNTHETIC_WHOLE_ACTIVATION_FAILED");');
        }
        return compiler.transform(source, options);
      },
    } });
  const runtime = session.parentCodeRuntime();
  const binding = { instanceId: shared.options.instanceToken, expectedRevision: 0 };
  const candidate = runtime.prepare({ ...binding, ...built });
  assert.throws(() => runtime.activate({ ...binding, preparationId: candidate.id }), /SYNTHETIC_WHOLE_ACTIVATION_FAILED/);
  assert.equal(runtime.status().selected.version, "original");
  assert.equal(runtime.status().failed, false);
  const restored = [Object.getPrototypeOf(proxy), shared.coordinator.liveCodeParticipant().snapshot().implementation,
    shared.sessionCodeParticipant.snapshot().implementation, session.serviceCodeParticipant().snapshot().implementation];
  restored.forEach((implementation, index) => assert.strictEqual(implementation, original[index]));
  assert.equal((await value.rpc(socket, "test/tool", { value: "after-rollback" })).result.value, "after-rollback");
  assert.equal(socket.readyState, 1);
  assert.equal(service.status.state, "running");
  assert.equal(proxy.liveCodeRuntime.status().revision, 0);
});
