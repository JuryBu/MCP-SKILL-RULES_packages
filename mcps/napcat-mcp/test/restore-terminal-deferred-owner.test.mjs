import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkTerminalDeferred, restoreTerminalDeferred } from "../ops/restore-terminal-deferred-owner.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const hashes = { runner: "a".repeat(64), core: "b".repeat(64), helper: "c".repeat(64), control: "d".repeat(64) };
function state() {
  return { ok: true, ownerId: "owner", nativeSourceId: "native", instanceToken: "instance", revision: 0, busy: false,
    selectedWorkerId: "new", selectedSourceHashes: hashes, coordinator: {
      running: true, nativeHealthy: true, transactionActive: false, workerMaintenance: false, pendingControl: 0,
      defaultWorkerId: "new", activation: { active: true, activationId: "activation", sourceWorkerId: "old", targetWorkerId: "new", deferredThreadIds: ["finished"] },
      threads: [{ threadId: "finished", phase: "terminal", activeHttp: 0, activationError: null, workerId: "old", pendingActivationId: "activation" },
        { threadId: "working", phase: "active", activeHttp: 1, workerId: "new", pendingActivationId: null }],
      workers: ["old", "new"].map(workerId => ({ workerId, alive: true, ready: true, cleanupPending: false, sourceHashes: hashes })) } };
}
const identity = { ownerId: "owner", nativeSourceId: "native", instanceId: "instance" };
for (const [name, mutate] of Object.entries({
  active: current => { current.coordinator.threads[0].phase = "active"; },
  inflight: current => { current.coordinator.threads[0].activeHttp = 1; },
  transaction: current => { current.coordinator.transactionActive = true; },
  changedActivation: current => { current.coordinator.activation.activationId = "other"; },
  deadSource: current => { current.coordinator.workers[0].alive = false; },
  changedSource: current => { current.coordinator.workers[0].sourceHashes = { ...hashes, core: "e".repeat(64) }; },
})) test(`refuses ${name} without mutating state`, () => {
  const current = state(); const activation = structuredClone(current.coordinator.activation); mutate(current);
  const original = JSON.stringify(current);
  assert.throws(() => checkTerminalDeferred(current, activation, identity));
  assert.equal(JSON.stringify(current), original);
});

async function fixture(context, fault) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-recovery-owner-"));
  const current = state(); const activation = structuredClone(current.coordinator.activation);
  const posts = []; const digest = "f".repeat(64);
  let full = { ok: true, instanceId: "instance", revision: 1, selected: { id: "candidate", manifestSha256: digest },
    busy: false, failed: false, participants: [{}, {}, {}, {}, {}] };
  const server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    assert.equal(request.headers.authorization, "Bearer local-token");
    if (request.method === "GET") return response.end(JSON.stringify(request.url.endsWith("/status") ? current : full));
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); posts.push(request.url);
    if (request.url === "/v1/inner/rollback") {
      assert.equal(body.activationId, activation.activationId); assert.equal(body.expectedRevision, 0);
      assert.equal(body.selectedWorkerId, "new"); assert.deepEqual(body.selectedSourceHashes, hashes);
      current.revision = 1; current.selectedWorkerId = "old"; current.coordinator.defaultWorkerId = "old";
      current.coordinator.activation.active = false;
      current.coordinator.threads[0].pendingActivationId = null;
      if (fault === "ownership") current.coordinator.threads[1].workerId = "old";
      return response.end(JSON.stringify({ ok: true, result: { selectionRestored: true } }));
    }
    assert.equal(request.url, "/v1/full-runtime/restore"); assert.equal(body.expectedRevision, 1);
    if (fault === "restore") { response.statusCode = 503; return response.end(JSON.stringify({ ok: false, error: { code: "SYNTHETIC_RESTORE_FAILURE" } })); }
    full = { ...full, revision: 2, selected: { id: "original" } }; response.end(JSON.stringify(full));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(directory, { recursive: true }); });
  const controlUrl = `http://127.0.0.1:${server.address().port}`;
  const profilePath = path.join(directory, "profile.json"); fs.writeFileSync(profilePath, JSON.stringify(identity));
  const tokenPath = path.join(directory, "token"); fs.writeFileSync(tokenPath, "local-token");
  const runtimePath = path.join(directory, "runtime.json");
  fs.writeFileSync(runtimePath, JSON.stringify({ pid: 123, appServerPid: 456, instanceToken: "instance", state: "running", controlUrl }));
  const input = { schemaVersion: 1, machine: "fixture", candidateId: "candidate", profilePath, tokenPath, runtimePath,
    builderPath: "builder", compilerPath: "compiler", sourceManifestPath: "manifest", controlUrl, parentPid: 123, appServerPid: 456, instanceId: "instance",
    pins: [{ path: profilePath, sha256: hash(fs.readFileSync(profilePath)) }, ...["builder", "compiler", "manifest"].map(filename => ({ path: filename, sha256: digest }))] };
  const inputPath = path.join(directory, "input.json"); fs.writeFileSync(inputPath, JSON.stringify(input));
  const inputSha = hash(fs.readFileSync(inputPath));
  fs.writeFileSync(path.join(directory, "acceptance-events.jsonl"), [
    { phase: "candidate", value: { manifestSha256: digest } },
    { phase: "activated_snapshot", value: { managed: { coordinator: { activation } } } },
    { phase: "failed_preserved", value: { phase: "restore", error: "COORDINATOR_ACTIVATION_BUSY" } },
  ].map(record => JSON.stringify({ ...record, inputSha256: inputSha })).join("\n") + "\n");
  return { inputPath, inputSha, posts, current, directory };
}
test("existing rollback then full restore retains the running thread and returns original revision", async context => {
  const value = await fixture(context);
  const result = await restoreTerminalDeferred(value.inputPath, value.inputSha, async () => "RECOVER-TERMINAL-DEFERRED", () => {});
  assert.equal(result.status, "RESTORED_ORIGINAL"); assert.equal(result.revision, 2);
  assert.equal(value.current.coordinator.threads[1].workerId, "new");
  assert.deepEqual(value.posts, ["/v1/inner/rollback", "/v1/full-runtime/restore"]);
  assert.ok(fs.readFileSync(result.outputPath, "utf8").includes("full_restored"));
});
test("owner cancellation has no HTTP writes", async context => {
  const value = await fixture(context);
  await assert.rejects(restoreTerminalDeferred(value.inputPath, value.inputSha, async () => "NO", () => {}), /OWNER_CANCELLED/);
  assert.deepEqual(value.posts, []);
});
test("state changed during confirmation stops before writing", async context => {
  const value = await fixture(context);
  await assert.rejects(restoreTerminalDeferred(value.inputPath, value.inputSha, async () => {
    value.current.coordinator.threads[0].phase = "active"; return "RECOVER-TERMINAL-DEFERRED";
  }, () => {}), /RECOVERY_PENDING_THREAD_NOT_TERMINAL/);
  assert.deepEqual(value.posts, []);
});
test("ownership drift after rollback stops before full restore", async context => {
  const value = await fixture(context, "ownership");
  await assert.rejects(restoreTerminalDeferred(value.inputPath, value.inputSha, async () => "RECOVER-TERMINAL-DEFERRED", () => {}), /RECOVERY_THREAD_OWNERSHIP_CHANGED/);
  assert.deepEqual(value.posts, ["/v1/inner/rollback"]);
});
test("restore failure preserves one attempt without retry", async context => {
  const value = await fixture(context, "restore");
  await assert.rejects(restoreTerminalDeferred(value.inputPath, value.inputSha, async () => "RECOVER-TERMINAL-DEFERRED", () => {}), /SYNTHETIC_RESTORE_FAILURE/);
  assert.deepEqual(value.posts, ["/v1/inner/rollback", "/v1/full-runtime/restore"]);
  assert.ok(fs.readFileSync(path.join(value.directory, "terminal-deferred-recovery.jsonl"), "utf8").includes("failed_preserved"));
});

test("the real owner CLI waits for confirmation and exits after both operations", async context => {
  const value = await fixture(context);
  const entry = process.env.TERMINAL_RECOVERY_TEST_ENTRY ?? fileURLToPath(new URL("../ops/restore-terminal-deferred-owner.mjs", import.meta.url));
  const child = spawn(process.execPath, [entry, value.inputPath, value.inputSha], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", sent = false;
  child.stdout.on("data", chunk => {
    stdout += chunk;
    if (!sent && stdout.includes("Type RECOVER-TERMINAL-DEFERRED: ")) { sent = true; child.stdin.write("RECOVER-TERMINAL-DEFERRED\n"); }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  assert.equal(code, 0, stderr + stdout); assert.equal(sent, true); assert.match(stdout, /RESTORED_ORIGINAL/);
  assert.deepEqual(value.posts, ["/v1/inner/rollback", "/v1/full-runtime/restore"]);
});
