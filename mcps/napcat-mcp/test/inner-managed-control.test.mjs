import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { fixture, nativeDependencies, installationRoot, digest } from "./inner-runtime-profile.test.mjs";
import { parseArguments, runManagedInnerProfile } from "../src/codex-app-server-proxy-runner.mjs";
import { validateInnerRuntimeProfile } from "../src/inner-runtime-profile.mjs";
import { createCodexAppServerProxy } from "../src/codex-app-server-proxy.mjs";

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function buildOwnedCandidate(value, delayFirstReply = false, originalBytes = false) {
  const root = path.join(value.root, originalBytes ? "approved-original" : "approved-candidate");
  const target = path.join(root, "src");
  fs.mkdirSync(target, { recursive: true });
  const copied = new Set();
  function copy(name) {
    if (copied.has(name)) return;
    copied.add(name);
    const bytes = fs.readFileSync(path.join(installationRoot, "src", name));
    fs.writeFileSync(path.join(target, name), bytes);
    for (const match of bytes.toString().matchAll(/["']\.\/([^"']+\.mjs)["']/gu)) copy(match[1]);
  }
  for (const name of ["codex-model-stream-proxy-runner.mjs", "codex-model-stream-proxy.mjs", "thread-recovery-handoff.mjs", "inner-runner-handoff-control.mjs"]) copy(name);
  if (!originalBytes) fs.appendFileSync(path.join(target, "codex-model-stream-proxy.mjs"), "\n");
  if (delayFirstReply) fs.appendFileSync(path.join(target, "codex-model-stream-proxy-runner.mjs"),
    '\nconst originalTestSend = process.send.bind(process); let delayedTestReply = false; process.send = (message, ...argumentsList) => { if (!delayedTestReply && message?.ok === true) { delayedTestReply = true; setTimeout(() => originalTestSend(message, ...argumentsList), 5200); return true; } return originalTestSend(message, ...argumentsList); };\n');
  fs.writeFileSync(path.join(root, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1, kind: "candidate",
    ownerId: value.profile.ownerId, nativeSourceId: value.profile.nativeSourceId }));
  const expectedHashes = {};
  for (const [key, name] of Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })) expectedHashes[key] = digest(fs.readFileSync(path.join(target, name)));
  if (originalBytes) assert.deepEqual(expectedHashes, value.profile.initial.expectedHashes);
  else assert.notEqual(expectedHashes.core, value.profile.initial.expectedHashes.core);
  return { id: originalBytes ? "reviewed-temp-original" : "reviewed-temp-bytes", installationRoot: root,
    runnerPath: path.join(target, "codex-model-stream-proxy-runner.mjs"), expectedHashes };
}

async function startNormalEntry(value) {
  fs.writeFileSync(value.profilePath, JSON.stringify(value.profile));
  const argv = [...value.argv, "--inner-managed-profile", value.profilePath, "--inner-managed-profile-sha256", digest(fs.readFileSync(value.profilePath))];
  const options = parseArguments(argv);
  const task = runManagedInnerProfile(options, argv, nativeDependencies());
  const token = fs.readFileSync(options.tokenFilePath, "utf8").trim();
  const identity = { ownerId: value.profile.ownerId, nativeSourceId: value.profile.nativeSourceId, instanceToken: options.instanceToken };
  const base = `http://127.0.0.1:${options.controlPort}/v1/inner/`;
  async function get(extra = {}) {
    const response = await fetch(`${base}status`, { headers: { authorization: `Bearer ${token}`,
      "x-inner-owner-id": identity.ownerId, "x-inner-native-source-id": identity.nativeSourceId,
      "x-inner-instance-token": identity.instanceToken, ...extra } });
    return { httpStatus: response.status, body: await response.json() };
  }
  async function post(method, input, extra = {}) {
    const response = await fetch(`${base}${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
      body: typeof input === "string" ? input : JSON.stringify(input) });
    return { httpStatus: response.status, body: await response.json() };
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await get()).httpStatus === 200) return { options, identity, get, post, task }; } catch {}
    await sleep(25);
  }
  fs.writeFileSync(options.stopFilePath, "owned-test-stop");
  await task;
  throw new Error("TEMP_EXTERNAL_CONTROL_NOT_READY");
}

function command(control, status, fields) {
  return { ...control.identity, requestId: crypto.randomUUID(), expectedRevision: status.revision,
    selectedWorkerId: status.selectedWorkerId, selectedSourceHashes: status.selectedSourceHashes, ...fields };
}

test("normal managed HTTP prepare native turn migrate tool continuation restore and stop", { timeout: 30000 }, async () => {
  const value = await fixture();
  const candidate = buildOwnedCandidate(value);
  const original = buildOwnedCandidate(value, false, true);
  value.profile.approvedCandidates = [candidate, original];
  value.profile.workerLifecycle = { recycleRetiredWorkers: true };
  const control = await startNormalEntry(value);
  const historyPath = path.join(value.profile.codexHome, "preserved-history.json");
  const historyHash = digest(fs.readFileSync(historyPath));
  const requests = [];
  let client;
  try {
    const status = (await control.get()).body;
    const originalWorkerId = status.selectedWorkerId;
    const badIdentity = await control.get({ "x-inner-owner-id": "foreign-owner" });
    assert.equal(badIdentity.httpStatus, 409);
    assert.equal((await control.get({ authorization: "Bearer foreign-token" })).httpStatus, 401);
    assert.equal((await control.get({ "x-inner-instance-token": crypto.randomUUID() })).httpStatus, 409);
    assert.equal((await control.post("prepare", "")).httpStatus, 409);
    assert.equal((await control.post("prepare", " ".repeat(17000))).httpStatus, 413);
    assert.equal((await control.post("prepare", command(control, status, { candidateId: "unapproved-source" }))).httpStatus, 409);
    const candidateCore = path.join(candidate.installationRoot, "src", "codex-model-stream-proxy.mjs");
    const approvedBytes = fs.readFileSync(candidateCore);
    fs.appendFileSync(candidateCore, "\n");
    assert.equal((await control.post("prepare", command(control, status, { candidateId: candidate.id }))).httpStatus, 409);
    fs.writeFileSync(candidateCore, approvedBytes);
    const ownerPath = path.join(candidate.installationRoot, ".inner-runtime-owner.json");
    const ownerBytes = fs.readFileSync(ownerPath);
    fs.writeFileSync(ownerPath, JSON.stringify({ schemaVersion: 1, kind: "candidate", ownerId: "foreign-owner", nativeSourceId: value.profile.nativeSourceId }));
    assert.equal((await control.post("prepare", command(control, status, { candidateId: candidate.id }))).httpStatus, 409);
    fs.writeFileSync(ownerPath, ownerBytes);
    assert.equal((await control.get()).body.coordinator.workers.length, 1);
    const prepareInput = command(control, status, { candidateId: candidate.id });
    const prepare = await control.post("prepare", prepareInput);
    requests.push({ method: "prepare", ...prepare });
    assert.equal(prepare.httpStatus, 200);
    assert.equal(prepare.body.ok, true);
    const candidateWorkerId = prepare.body.result.workerId;
    assert.equal((await control.post("prepare", prepareInput)).httpStatus, 409);
    assert.equal((await control.post("prepare", command(control, status, { candidateId: candidate.id }))).httpStatus, 409);
    client = new WebSocket(`ws://127.0.0.1:${control.options.downstreamPort}`);
    await once(client, "open");
    const messages = [];
    client.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
    client.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "external-inner-test", version: "1" } } }));
    await sleep(50);
    client.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "http-owned-thread", input: [] } }));
    const deadline = Date.now() + 5000;
    while (!(await control.get()).body.coordinator.threads.some(thread => thread.phase === "terminal") && Date.now() < deadline) await sleep(25);
    const ready = (await control.get()).body;
    const compatibility = { manifest: { schemaVersion: 1, edges: [{ source: { core: value.profile.initial.expectedHashes.core, helper: value.profile.initial.expectedHashes.helper },
      target: { core: candidate.expectedHashes.core, helper: candidate.expectedHashes.helper }, checkpointSchemaVersion: 1, stateSchemaVersion: 1, stateSemantics: "state-v1" }] } };
    compatibility.sha256 = digest(JSON.stringify(compatibility.manifest));
    const migrate = await control.post("migrate", command(control, ready, { threadId: "http-owned-thread", candidateId: candidateWorkerId, compatibility }));
    requests.push({ method: "migrate", ...migrate });
    assert.equal(migrate.httpStatus, 200);
    assert.equal(migrate.body.result.committed, true);
    const migrated = (await control.get()).body;
    assert.equal(migrated.selectedWorkerId, candidateWorkerId);
    assert.equal(migrated.selectedSourceHashes.core, candidate.expectedHashes.core);
    client.send(JSON.stringify({ id: 3, method: "test/tool", params: { value: "continues-after-migration" } }));
    const toolDeadline = Date.now() + 3000;
    while (!messages.some(message => message.id === 3) && Date.now() < toolDeadline) await sleep(25);
    assert.equal(messages.some(message => message.id === 3 && message.result?.value === "continues-after-migration"), true);
    assert.equal(client.readyState, WebSocket.OPEN);
    const restoreCompatibility = { manifest: { schemaVersion: 1, edges: [{ source: compatibility.manifest.edges[0].target,
      target: compatibility.manifest.edges[0].source, checkpointSchemaVersion: 1, stateSchemaVersion: 1, stateSemantics: "state-v1" }] } };
    restoreCompatibility.sha256 = digest(JSON.stringify(restoreCompatibility.manifest));
    const reused = await control.post("migrate", command(control, migrated, { threadId: "http-owned-thread", candidateId: originalWorkerId, compatibility: restoreCompatibility }));
    assert.equal(reused.httpStatus, 409);
    assert.equal(reused.body.error.code, "COORDINATOR_FRESH_WORKER_REQUIRED");
    const fresh = await control.post("prepare", command(control, (await control.get()).body, { candidateId: original.id }));
    assert.equal(fresh.httpStatus, 200);
    assert.notEqual(fresh.body.result.workerId, originalWorkerId);
    const restored = await control.post("migrate", command(control, (await control.get()).body, { threadId: "http-owned-thread",
      candidateId: fresh.body.result.workerId, compatibility: restoreCompatibility }));
    requests.push({ method: "restore-via-fresh-prepare-migrate", ...restored });
    assert.equal(restored.httpStatus, 200);
    assert.equal((await control.get()).body.selectedWorkerId, fresh.body.result.workerId);
    assert.deepEqual((await control.get()).body.selectedSourceHashes, value.profile.initial.expectedHashes);
    assert.equal(digest(fs.readFileSync(historyPath)), historyHash);
    client.close(); await once(client, "close"); client = null;
    fs.writeFileSync(control.options.stopFilePath, "owned-http-stop");
    const result = await control.task;
    assert.equal(result.state, "stopped");
    const final = JSON.parse(fs.readFileSync(value.profile.managedStatePath));
    assert.equal(final.coordinator.workers.every(worker => !worker.alive), true);
    fs.writeFileSync(path.join(value.root, "external-control-evidence.json"), JSON.stringify({ requests, result, final,
      candidateCoreSha256: candidate.expectedHashes.core, initialCoreSha256: value.profile.initial.expectedHashes.core,
      historyHash, actualHttp: true, fixtureAppServer: true, sourceCoreSemanticsChanged: false }, null, 2));
    console.log(`external HTTP evidence: ${value.root}`);
  } finally {
    client?.terminate();
    if (!fs.existsSync(control.options.stopFilePath)) fs.writeFileSync(control.options.stopFilePath, "owned-http-test-cleanup");
    await control.task;
  }
});

test("managed HTTP activates and rolls back while a native turn and tool response remain active", { timeout: 20000 }, async () => {
  const value = await fixture();
  const candidate = buildOwnedCandidate(value);
  value.profile.approvedCandidates = [candidate];
  const control = await startNormalEntry(value);
  const messages = [];
  let client;
  try {
    const originalStatus = (await control.get()).body;
    const prepared = await control.post("prepare", command(control, originalStatus, { candidateId: candidate.id }));
    assert.equal(prepared.httpStatus, 200);
    client = new WebSocket(`ws://127.0.0.1:${control.options.downstreamPort}`);
    await once(client, "open");
    client.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
    client.send(JSON.stringify({ id: 31, method: "initialize", params: { clientInfo: { name: "owned-active-control", version: "1" } } }));
    await sleep(50);
    client.send(JSON.stringify({ id: 32, method: "turn/start", params: {
      threadId: "owned-active-thread", fixtureTurnId: "owned-active-turn", fixtureHoldTurn: true, input: [],
    } }));
    const deadline = Date.now() + 3000;
    while (!(await control.get()).body.coordinator.threads.some(thread => thread.phase === "active") && Date.now() < deadline) await sleep(10);
    const active = (await control.get()).body;
    assert.equal(active.coordinator.threads[0].phase, "active");
    client.send(JSON.stringify({ id: 33, method: "test/tool", params: { value: "one-tool-result", replyDelayMs: 500 } }));
    const compatibility = { manifest: { schemaVersion: 1, edges: [{
      source: { core: value.profile.initial.expectedHashes.core, helper: value.profile.initial.expectedHashes.helper },
      target: { core: candidate.expectedHashes.core, helper: candidate.expectedHashes.helper },
      checkpointSchemaVersion: 1, stateSchemaVersion: 1, stateSemantics: "state-v1",
    }] } };
    compatibility.sha256 = digest(JSON.stringify(compatibility.manifest));
    const activated = await control.post("activate", command(control, active, { candidateId: prepared.body.result.workerId, compatibility }));
    assert.equal(activated.httpStatus, 200);
    assert.equal(activated.body.result.selectionCommitted, true);
    assert.equal((await control.get()).body.selectedWorkerId, prepared.body.result.workerId);
    assert.equal(client.readyState, WebSocket.OPEN);
    const restored = await control.post("rollback", command(control, (await control.get()).body, {
      activationId: activated.body.result.activationId,
    }));
    assert.equal(restored.httpStatus, 200);
    assert.equal(restored.body.result.selectionRestored, true);
    assert.equal((await control.get()).body.selectedWorkerId, originalStatus.selectedWorkerId);
    while (!messages.some(message => message.id === 33) && Date.now() < deadline) await sleep(10);
    assert.equal(messages.filter(message => message.id === 33 && message.result?.value === "one-tool-result").length, 1);
    client.send(JSON.stringify({ id: 34, method: "test/complete", params: { threadId: "owned-active-thread", turnId: "owned-active-turn" } }));
    while ((await control.get()).body.coordinator.threads.some(thread => thread.phase === "active") && Date.now() < deadline) await sleep(10);
    assert.equal((await control.get()).body.coordinator.threads[0].phase, "terminal");
    console.log(JSON.stringify({ evidence: "normal-managed-http-active-turn", activation: activated.body.result,
      rollback: restored.body.result, toolResults: 1, retainedWebSocket: client.readyState === WebSocket.OPEN }));
  } finally {
    client?.terminate();
    if (!fs.existsSync(control.options.stopFilePath)) fs.writeFileSync(control.options.stopFilePath, "owned-active-control-cleanup");
    await control.task;
  }
});

test("production worker lifecycle profile rejects unknown policy and keeps explicit opt-in", async () => {
  const value = await fixture();
  assert.equal(validateInnerRuntimeProfile(value.profile, { options: value.options }).workerLifecycle, undefined);
  for (const workerLifecycle of [null, [], { recycleRetiredWorkers: "true" }, { recycleRetiredWorkers: true, maxLiveWorkers: 5 }]) {
    assert.throws(() => validateInnerRuntimeProfile({ ...value.profile, workerLifecycle }, { options: value.options }), /WORKER_LIFECYCLE_INVALID/);
  }
  assert.equal(validateInnerRuntimeProfile({ ...value.profile, workerLifecycle: { recycleRetiredWorkers: true } },
    { options: value.options }).workerLifecycle.recycleRetiredWorkers, true);
});

test("fresh production workers retain quota state through six HTTP migrations and protect referenced workers", { timeout: 30000 }, async () => {
  const value = await fixture();
  const candidate = buildOwnedCandidate(value);
  const original = buildOwnedCandidate(value, false, true);
  const upstream = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ type: "response.failed", response: { id: crypto.randomUUID(), status: "failed",
      error: { code: "usage_limit_reached", message: "OWNED_SYNTHETIC_QUOTA" } } })}\n\n`);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  value.profile.upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  value.profile.approvedCandidates = [candidate, original];
  value.profile.workerLifecycle = { recycleRetiredWorkers: true };
  value.profile.environment.INNER_PROFILE_TEST_FRONT_ORIGIN = `http://127.0.0.1:${value.profile.innerPort}`;
  const control = await startNormalEntry(value);
  const historyPath = path.join(value.profile.codexHome, "preserved-history.json");
  const historyHash = digest(fs.readFileSync(historyPath));
  const steps = [];
  let client;
  try {
    const initial = (await control.get()).body;
    const pinnedWorkerId = initial.selectedWorkerId;
    client = new WebSocket(`ws://127.0.0.1:${control.options.downstreamPort}`);
    await once(client, "open");
    const messages = [];
    client.on("message", bytes => messages.push(JSON.parse(bytes.toString())));
    client.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "fresh-worker-state-test", version: "1" } } }));
    await sleep(50);
    async function turn(threadId, requestId, fixtureModelRequests = 0) {
      const turnId = crypto.randomUUID();
      client.send(JSON.stringify({ id: requestId, method: "turn/start", params: { threadId, fixtureTurnId: turnId, fixtureModelRequests, input: [] } }));
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const status = (await control.get()).body;
        if (status.coordinator.threads.some(thread => thread.threadId === threadId && thread.turnId === turnId && thread.phase === "terminal")) return;
        await sleep(25);
      }
      throw new Error("FRESH_QUOTA_NATIVE_TURN_TIMEOUT");
    }
    await turn("fresh-quota-thread", 2, 1);
    await turn("fresh-quota-thread", 3, 1);
    await turn("pinned-other-thread", 4);
    const workerIds = new Set([pinnedWorkerId]);
    for (let index = 0; index < 6; index += 1) {
      const approval = index % 2 === 0 ? candidate : original;
      const status = (await control.get()).body;
      const prepared = await control.post("prepare", command(control, status, { candidateId: approval.id }));
      assert.equal(prepared.httpStatus, 200);
      assert.equal(workerIds.has(prepared.body.result.workerId), false);
      workerIds.add(prepared.body.result.workerId);
      const ready = (await control.get()).body;
      const compatibility = { manifest: { schemaVersion: 1, edges: [{ source: { core: ready.selectedSourceHashes.core,
        helper: ready.selectedSourceHashes.helper }, target: { core: approval.expectedHashes.core, helper: approval.expectedHashes.helper },
        checkpointSchemaVersion: 1, stateSchemaVersion: 1, stateSemantics: "state-v1" }] } };
      compatibility.sha256 = digest(JSON.stringify(compatibility.manifest));
      const migrated = await control.post("migrate", command(control, ready, { threadId: "fresh-quota-thread",
        candidateId: prepared.body.result.workerId, compatibility }));
      assert.equal(migrated.httpStatus, 200);
      assert.equal(migrated.body.result.committed, true);
      assert.ok(migrated.body.result.accepted.importedEntries > 0);
      const checkpoint = JSON.parse(fs.readFileSync(migrated.body.result.accepted.readPath)).payload;
      const emptyCount = checkpoint.snapshot.state.emptyIdleTurns.find(([threadId]) => threadId === "fresh-quota-thread")[1].count;
      assert.equal(emptyCount, 2);
      const current = (await control.get()).body;
      assert.deepEqual(current.selectedSourceHashes, approval.expectedHashes);
      assert.equal(current.coordinator.workers.find(worker => worker.workerId === pinnedWorkerId).alive, true);
      assert.equal(current.coordinator.threads.find(thread => thread.threadId === "pinned-other-thread").workerId, pinnedWorkerId);
      assert.ok(current.coordinator.workers.filter(worker => worker.alive).length <= 4);
      assert.ok(migrated.body.actualMs < 5000);
      steps.push({ index, prepared, migrated, emptyCount, liveWorkers: current.coordinator.workers.filter(worker => worker.alive).length,
        reclaimed: current.coordinator.reclaimedWorkers.length });
    }
    const current = (await control.get()).body;
    assert.ok(current.coordinator.reclaimedWorkers.length >= 4);
    assert.equal(current.coordinator.reclaimedWorkers.some(worker => worker.workerId === pinnedWorkerId), false);
    for (const worker of current.coordinator.reclaimedWorkers) {
      assert.equal(worker.exitCode, 0);
      assert.equal(fs.existsSync(worker.stateRoot), true);
      assert.throws(() => process.kill(worker.pid, 0));
    }
    client.send(JSON.stringify({ id: 5, method: "test/tool", params: { value: "tool-after-six-fresh-workers" } }));
    const deadline = Date.now() + 3000;
    while (!messages.some(message => message.id === 5) && Date.now() < deadline) await sleep(25);
    assert.equal(messages.some(message => message.id === 5 && message.result?.value === "tool-after-six-fresh-workers"), true);
    assert.equal(client.readyState, WebSocket.OPEN);
    assert.equal(digest(fs.readFileSync(historyPath)), historyHash);
    client.close(); await once(client, "close"); client = null;
    fs.writeFileSync(control.options.stopFilePath, "owned-fresh-worker-stop");
    const result = await control.task;
    assert.equal(result.state, "stopped");
    const final = JSON.parse(fs.readFileSync(value.profile.managedStatePath));
    assert.equal(final.coordinator.workers.every(worker => !worker.alive), true);
    fs.writeFileSync(path.join(value.root, "fresh-worker-lifecycle-evidence.json"), JSON.stringify({ steps, result, final,
      pinnedWorkerId, distinctWorkers: workerIds.size, historyHash, actualHttp: true, fixtureAppServer: true,
      modelBudgetStateCreatedThroughHttp: true, automaticRetries: 0 }, null, 2));
    console.log(`fresh lifecycle HTTP evidence: ${value.root}`);
  } finally {
    client?.terminate();
    if (!fs.existsSync(control.options.stopFilePath)) fs.writeFileSync(control.options.stopFilePath, "owned-fresh-worker-cleanup");
    await control.task;
    await new Promise(resolve => upstream.close(resolve));
  }
});

test("separate outer shared state root needs no inner ownership marker and keeps exact path pins", async () => {
  const value = await fixture();
  const sharedRoot = value.profile.stateRoot;
  const innerRoot = path.join(sharedRoot, "inner-managed");
  fs.mkdirSync(innerRoot);
  fs.writeFileSync(path.join(innerRoot, ".inner-runtime-owner.json"), fs.readFileSync(path.join(sharedRoot, ".inner-runtime-owner.json")));
  fs.unlinkSync(path.join(sharedRoot, ".inner-runtime-owner.json"));
  const profile = { ...value.profile, outerStateRoot: sharedRoot, stateRoot: innerRoot, managedStatePath: path.join(innerRoot, "managed.json") };
  assert.equal(validateInnerRuntimeProfile(profile, { options: value.options }).outerStateRoot, sharedRoot);
  assert.equal(fs.existsSync(path.join(sharedRoot, ".inner-runtime-owner.json")), false);
  assert.throws(() => validateInnerRuntimeProfile(profile, { options: { ...value.options, journalPath: path.join(sharedRoot, "other-ledger.json") } }), /OUTER_PATH_MISMATCH/);
});

test("normal external controller preserves unknown operation and rejects duplicate execution", { timeout: 20000 }, async () => {
  const value = await fixture();
  const candidate = buildOwnedCandidate(value, true);
  value.profile.approvedCandidates = [candidate];
  const control = await startNormalEntry(value);
  let client;
  try {
    const initial = (await control.get()).body;
    const prepare = await control.post("prepare", command(control, initial, { candidateId: candidate.id }));
    assert.equal(prepare.httpStatus, 200);
    client = new WebSocket(`ws://127.0.0.1:${control.options.downstreamPort}`);
    await once(client, "open");
    client.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "unknown-temp", version: "1" } } }));
    await sleep(50);
    client.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "unknown-http-thread", input: [] } }));
    const nativeDeadline = Date.now() + 3000;
    while (!(await control.get()).body.coordinator.threads.some(thread => thread.phase === "terminal") && Date.now() < nativeDeadline) await sleep(25);
    const ready = (await control.get()).body;
    const compatibility = { manifest: { schemaVersion: 1, edges: [{ source: { core: value.profile.initial.expectedHashes.core, helper: value.profile.initial.expectedHashes.helper },
      target: { core: candidate.expectedHashes.core, helper: candidate.expectedHashes.helper }, checkpointSchemaVersion: 1, stateSchemaVersion: 1, stateSemantics: "state-v1" }] } };
    compatibility.sha256 = digest(JSON.stringify(compatibility.manifest));
    const input = command(control, ready, { threadId: "unknown-http-thread", candidateId: prepare.body.result.workerId, compatibility });
    const beganAt = Date.now();
    const unknown = await control.post("migrate", input);
    const responseMs = Date.now() - beganAt;
    assert.equal(unknown.httpStatus, 202);
    assert.equal(unknown.body.outcome, "unknown");
    const persisted = JSON.parse(fs.readFileSync(value.profile.managedStatePath));
    assert.equal(persisted.controlOperations.some(operation => operation.requestId === input.requestId && operation.state === "unknown"), true);
    assert.equal((await control.post("migrate", input)).httpStatus, 409);
    const completionDeadline = Date.now() + 5000;
    let status;
    while (Date.now() < completionDeadline) {
      status = (await control.get()).body;
      if (status.operations.find(operation => operation.requestId === input.requestId)?.state === "completed") break;
      await sleep(25);
    }
    const receipt = status.operations.find(operation => operation.requestId === input.requestId);
    assert.equal(receipt.state, "completed");
    assert.equal(receipt.result.committed, true);
    assert.equal(status.operations.filter(operation => operation.requestId === input.requestId).length, 1);
    fs.writeFileSync(path.join(value.root, "unknown-http-evidence.json"), JSON.stringify({ unknown, responseMs, receipt,
      automaticRetries: 0, requestCount: 1, sourcePreservedDuringWait: true }, null, 2));
    console.log(`unknown HTTP evidence: ${value.root}`);
  } finally {
    client?.terminate();
    const waitDeadline = Date.now() + 10000;
    while ((await control.get()).body.busy && Date.now() < waitDeadline) await sleep(25);
    if (!fs.existsSync(control.options.stopFilePath)) fs.writeFileSync(control.options.stopFilePath, "owned-unknown-test-stop");
    await control.task;
  }
});

test("old production profile cannot approve candidate bytes and normal default routes stay disabled", { timeout: 10000 }, async () => {
  const value = await fixture();
  const control = await startNormalEntry(value);
  try {
    const status = (await control.get()).body;
    const rejected = await control.post("prepare", command(control, status, { candidateId: "reviewed-temp-bytes" }));
    assert.equal(rejected.httpStatus, 409);
    assert.equal((await control.get()).body.coordinator.workers.length, 1);
  } finally {
    fs.writeFileSync(control.options.stopFilePath, "owned-old-profile-stop");
    await control.task;
  }
  const proxy = createCodexAppServerProxy({ downstreamPort: value.options.downstreamPort, controlPort: value.options.controlPort,
    upstreamUrl: "ws://127.0.0.1:9", upstreamPaused: true, controlToken: "a".repeat(64) });
  try {
    await proxy.start();
    const response = await fetch(`http://127.0.0.1:${value.options.controlPort}/v1/inner/status`, { headers: { authorization: `Bearer ${"a".repeat(64)}` } });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, "INNER_MANAGED_CONTROL_DISABLED");
  } finally { await proxy.close(); }
});
