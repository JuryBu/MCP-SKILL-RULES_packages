import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { executeOwnerAcceptance } from "../ops/verify-full-runtime-owner.mjs";

const hash = filename => crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceManifestPath = process.env.OWNER_TEST_SOURCE_MANIFEST;
const compilerPath = process.env.OWNER_TEST_COMPILER;
async function fixture(context, fault) {
  assert.ok(sourceManifestPath && compilerPath, "Explicit fixture source and compiler required");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-owner-hotcut-"));
  const candidateRoot = path.join(directory, "candidate");
  fs.mkdirSync(candidateRoot);
  const sources = JSON.parse(fs.readFileSync(sourceManifestPath));
  const installationRoot = path.join(directory, "installed");
  fs.mkdirSync(path.join(installationRoot, "src"), { recursive: true });
  for (const source of sources.files) if (source.path !== "proxy.cjs") {
    fs.copyFileSync(path.join(path.dirname(sourceManifestPath), source.path), path.join(installationRoot, "src", source.path));
  }
  const expectedHashes = Object.fromEntries(Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" }).map(([key, name]) => [key, sources.files.find(file => file.path === name).sha256]));
  const profilePath = path.join(directory, "profile.json");
  const managedStatePath = path.join(directory, "managed.json");
  fs.writeFileSync(managedStatePath, "{}");
  fs.writeFileSync(profilePath, JSON.stringify({ installationRoot, managedStatePath, initial: { expectedHashes }, ownerId: "fixture-owner", nativeSourceId: "fixture-native" }));
  const tokenPath = path.join(directory, "token");
  fs.writeFileSync(tokenPath, "fixture-token");
  let status = { ok: true, instanceId: "fixture-instance", revision: 0, selected: { id: "original" }, candidateRegistrySha256: null,
    busy: false, failed: false, participants: [{}, {}, {}, {}, {}], prepared: [], preparedWorkers: [] };
  let manifestSha256;
  let previousSelection;
  const posts = [];
  let failures = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    if (request.method === "GET") return response.end(JSON.stringify(status));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const method = request.url.split("/").at(-1);
    posts.push(method);
    assert.equal(input.instanceId, "fixture-instance");
    assert.equal(input.expectedRevision, status.revision);
    if (fault === method || (fault === "restore-once" && method === "restore" && failures++ === 0)) {
      response.statusCode = 409;
      return response.end(JSON.stringify({ ok: false, error: { code: "SYNTHETIC_" + method } }));
    }
    if (method === "register") {
      previousSelection = status.selected;
      assert.equal(input.expectedRegistrySha256, status.candidateRegistrySha256);
      const actual = JSON.parse(fs.readFileSync(input.manifestPath));
      assert.equal(hash(input.manifestPath), input.manifestSha256);
      assert.equal(actual.files.length, 48);
      manifestSha256 = input.manifestSha256;
      status = { ...status, candidateRegistrySha256: "registered" };
    } else if (method === "prepare") {
      assert.equal(input.workerCandidateId, "same-source-proof");
      return response.end(JSON.stringify({ ok: true, id: "prepared-id", revision: status.revision }));
    } else if (method === "activate") {
      assert.equal(input.preparationId, "prepared-id");
      status = { ...status, revision: status.revision + 1, selected: { id: "candidate", manifestSha256 } };
      if (fault === "snapshot") fs.renameSync(managedStatePath, managedStatePath + ".retained");
    } else if (method === "restore") {
      status = { ...status, revision: status.revision + 1, selected: previousSelection };
    } else assert.fail("unexpected method");
    response.end(JSON.stringify(status));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const controlUrl = `http://127.0.0.1:${server.address().port}`;
  const runtimePath = path.join(directory, "runtime.json");
  fs.writeFileSync(runtimePath, JSON.stringify({ pid: 123, instanceToken: "fixture-instance", appServerPid: 456, state: "running", controlUrl }));
  const builderPath = path.join(directory, "proxy-live-build.mjs");
  fs.copyFileSync(path.join(root, "src", "proxy-live-build.mjs"), builderPath);
  const input = { schemaVersion: 1, machine: "fixture", candidateId: "same-source-proof", candidateRoot,
    installationRoot: path.join(candidateRoot, "same-source-proof"), profilePath, builderPath, compilerPath, sourceManifestPath,
    controlUrl, tokenPath, runtimePath, parentPid: 123, appServerPid: 456, instanceId: "fixture-instance",
    pins: [profilePath, builderPath, compilerPath, sourceManifestPath].map(filename => ({ path: filename, sha256: hash(filename) })) };
  const inputPath = path.join(directory, "input.json");
  fs.writeFileSync(inputPath, JSON.stringify(input));
  context.diagnostic(JSON.stringify({ directory, productionActions: 0 }));
  return { inputPath, inputSha: hash(inputPath), posts, input, change: callback => { status = callback(status); } };
}
const confirm = prompt => Promise.resolve(prompt.startsWith("Type ACTIVATE") ? "ACTIVATE" : prompt.startsWith("Type RESTORE") ? "RESTORE-SAME-RUNTIME" : "TEST-HOT-SWITCH");

test("a subsequent upgrade restores its exact already-selected baseline", async context => {
  const value = await fixture(context);
  const selected = { id: "existing-version", manifestSha256: "a".repeat(64) };
  value.input.expectedRevision = 1;
  value.input.expectedSelection = selected;
  value.change(status => ({ ...status, revision: 1, selected }));
  fs.writeFileSync(value.inputPath, JSON.stringify(value.input));
  const result = await executeOwnerAcceptance(value.inputPath, hash(value.inputPath), "Run", confirm, () => {});
  assert.equal(result.status, "HOT_SWITCH_AND_RESTORE_PASSED");
  assert.equal(result.revision, 3);
});

test("a changed model core requires a pinned compatibility edge before registration", async context => {
  const value = await fixture(context);
  const nextRoot = path.join(path.dirname(value.inputPath), "changed-core");
  fs.mkdirSync(nextRoot);
  const manifest = JSON.parse(fs.readFileSync(value.input.sourceManifestPath));
  for (const file of manifest.files) fs.copyFileSync(path.join(path.dirname(value.input.sourceManifestPath), file.path), path.join(nextRoot, file.path));
  const core = manifest.files.find(file => file.path === "codex-model-stream-proxy.mjs");
  const helper = manifest.files.find(file => file.path === "thread-recovery-handoff.mjs");
  const source = { core: core.sha256, helper: helper.sha256 };
  fs.appendFileSync(path.join(nextRoot, core.path), "\nexport const bufferRevision = 2;\n");
  core.sha256 = hash(path.join(nextRoot, core.path));
  value.input.installedManifestPath = value.input.sourceManifestPath;
  value.input.sourceManifestPath = path.join(nextRoot, "manifest.json");
  fs.writeFileSync(value.input.sourceManifestPath, JSON.stringify(manifest));
  value.input.pins.push({ path: value.input.sourceManifestPath, sha256: hash(value.input.sourceManifestPath) });
  const compatibility = { schemaVersion: 1, edges: [{ source, target: { core: core.sha256, helper: helper.sha256 },
    checkpointSchemaVersion: 1, stateSchemaVersion: 1, stateSemantics: "state-v1" }] };
  value.input.compatibility = { manifest: compatibility, sha256: crypto.createHash("sha256").update(JSON.stringify(compatibility)).digest("hex") };
  fs.writeFileSync(value.inputPath, JSON.stringify(value.input));
  const result = await executeOwnerAcceptance(value.inputPath, hash(value.inputPath), "Run", confirm, () => {});
  assert.equal(result.status, "HOT_SWITCH_AND_RESTORE_PASSED");
  assert.deepEqual(value.posts, ["register", "prepare", "activate", "restore"]);
});

test("a pinned changed control source upgrades without changing installed baseline bytes", async context => {
  const value = await fixture(context);
  const nextRoot = path.join(path.dirname(value.inputPath), "changed-source");
  fs.mkdirSync(nextRoot);
  const manifest = JSON.parse(fs.readFileSync(value.input.sourceManifestPath));
  for (const file of manifest.files) fs.copyFileSync(path.join(path.dirname(value.input.sourceManifestPath), file.path), path.join(nextRoot, file.path));
  const control = manifest.files.find(file => file.path === "inner-runner-handoff-control.mjs");
  fs.appendFileSync(path.join(nextRoot, control.path), "\nexport const capacityRevision = 2;\n");
  control.sha256 = hash(path.join(nextRoot, control.path));
  value.input.installedManifestPath = value.input.sourceManifestPath;
  value.input.sourceManifestPath = path.join(nextRoot, "manifest.json");
  fs.writeFileSync(value.input.sourceManifestPath, JSON.stringify(manifest));
  value.input.pins.push({ path: value.input.sourceManifestPath, sha256: hash(value.input.sourceManifestPath) });
  fs.writeFileSync(value.inputPath, JSON.stringify(value.input));
  const result = await executeOwnerAcceptance(value.inputPath, hash(value.inputPath), "Apply", () => assert.fail("human prompt"), () => {}, { nonInteractive: true });
  assert.equal(result.status, "HOT_SWITCH_APPLIED");
  assert.deepEqual(value.posts, ["register", "prepare", "activate"]);
  const profile = JSON.parse(fs.readFileSync(value.input.profilePath));
  assert.notEqual(hash(path.join(profile.installationRoot, "src", control.path)), control.sha256);
  const restored = await executeOwnerAcceptance(value.inputPath, hash(value.inputPath), "Restore", () => assert.fail("human prompt"), () => {}, { nonInteractive: true });
  assert.equal(restored.status, "RESTORED_ORIGINAL");
});
test("non-interactive CLI uses current revision and never reads stdin", async context => {
  const value = await fixture(context);
  value.input.expectedRevision = 2;
  fs.writeFileSync(value.inputPath, JSON.stringify(value.input));
  value.change(status => ({ ...status, revision: 2 }));
  const child = spawn(process.execPath, [path.join(root, "ops", "verify-full-runtime-owner.mjs"), value.inputPath, hash(value.inputPath), "Run", "--non-interactive"],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  assert.equal(code, 0, stderr + stdout);
  assert.match(stdout, /HOT_SWITCH_AND_RESTORE_PASSED/);
  assert.match(stdout, /"revision":4/);
  assert.doesNotMatch(stdout, /Type ACTIVATE|Type TEST-HOT-SWITCH/);
  assert.deepEqual(value.posts, ["register", "prepare", "activate", "restore"]);
});
test("non-interactive Apply retains candidate and recorded Restore returns original", async context => {
  const value = await fixture(context);
  const neverPrompt = () => assert.fail("unexpected human prompt");
  const result = await executeOwnerAcceptance(value.inputPath, value.inputSha, "Apply", neverPrompt, () => {}, { nonInteractive: true });
  assert.equal(result.status, "HOT_SWITCH_APPLIED");
  assert.deepEqual(value.posts, ["register", "prepare", "activate"]);
  const restored = await executeOwnerAcceptance(value.inputPath, value.inputSha, "Restore", neverPrompt, () => {}, { nonInteractive: true });
  assert.equal(restored.status, "RESTORED_ORIGINAL");
  assert.deepEqual(value.posts, ["register", "prepare", "activate", "restore"]);
});
test("pre-existing registry is bound exactly during inspection and registration", async context => {
  const value = await fixture(context);
  const registrySha = "a".repeat(64);
  value.input.expectedRegistrySha256 = registrySha;
  fs.writeFileSync(value.inputPath, JSON.stringify(value.input));
  value.inputSha = hash(value.inputPath);
  value.change(status => ({ ...status, candidateRegistrySha256: registrySha }));
  assert.equal((await executeOwnerAcceptance(value.inputPath, value.inputSha, "Inspect", confirm)).status, "READY_NOT_EXECUTED");
  const result = await executeOwnerAcceptance(value.inputPath, value.inputSha, "Run", confirm, () => {});
  assert.equal(result.status, "HOT_SWITCH_AND_RESTORE_PASSED");
  assert.deepEqual(value.posts, ["register", "prepare", "activate", "restore"]);
});
test("pre-existing registry drift refuses before candidate creation or POST", async context => {
  const value = await fixture(context);
  value.input.expectedRegistrySha256 = "a".repeat(64);
  fs.writeFileSync(value.inputPath, JSON.stringify(value.input));
  value.change(status => ({ ...status, candidateRegistrySha256: "b".repeat(64) }));
  await assert.rejects(executeOwnerAcceptance(value.inputPath, hash(value.inputPath), "Run", confirm), /BASELINE_CHANGED/);
  assert.deepEqual(value.posts, []);
  assert.equal(fs.existsSync(value.input.installationRoot), false);
});
test("real interactive Node Run waits for both owner confirmations and exits with restore result", async context => {
  const value = await fixture(context);
  const child = spawn(process.execPath, [path.join(root, "ops", "verify-full-runtime-owner.mjs"), value.inputPath, value.inputSha, "Run"],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", firstSent = false, secondSent = false;
  child.stdout.on("data", chunk => {
    stdout += chunk;
    if (!firstSent && stdout.includes("Type TEST-HOT-SWITCH: ")) { firstSent = true; child.stdin.write("TEST-HOT-SWITCH\n"); }
    if (!secondSent && stdout.includes("Type ACTIVATE: ")) { secondSent = true; child.stdin.write("ACTIVATE\n"); }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  assert.equal(code, 0, stderr + stdout);
  assert.ok(firstSent && secondSent);
  assert.match(stdout, /HOT_SWITCH_AND_RESTORE_PASSED/);
  assert.deepEqual(value.posts, ["register", "prepare", "activate", "restore"]);
});
test("real same-source compilation and authenticated HTTP register, prepare, activate and restore", async context => {
  const value = await fixture(context);
  assert.equal((await executeOwnerAcceptance(value.inputPath, value.inputSha, "Inspect", confirm)).status, "READY_NOT_EXECUTED");
  assert.deepEqual(value.posts, []);
  const result = await executeOwnerAcceptance(value.inputPath, value.inputSha, "Run", confirm, () => {});
  assert.equal(result.status, "HOT_SWITCH_AND_RESTORE_PASSED");
  assert.deepEqual(value.posts, ["register", "prepare", "activate", "restore"]);
  await assert.rejects(executeOwnerAcceptance(value.inputPath, value.inputSha, "Run", confirm), /BASELINE_CHANGED/);
});
test("cancellation has no candidate or mutation", async context => {
  const value = await fixture(context);
  await assert.rejects(executeOwnerAcceptance(value.inputPath, value.inputSha, "Run", async () => "NO"), /OWNER_CANCELLED/);
  assert.deepEqual(value.posts, []);
  assert.equal(fs.existsSync(value.input.installationRoot), false);
});
test("pin drift refuses before HTTP writes", async context => {
  const value = await fixture(context);
  fs.appendFileSync(value.input.profilePath, " ");
  await assert.rejects(executeOwnerAcceptance(value.inputPath, value.inputSha, "Run", confirm), /PIN_CHANGED/);
  assert.deepEqual(value.posts, []);
});
test("prepare rejection preserves evidence and never activates or retries", async context => {
  const value = await fixture(context, "prepare");
  await assert.rejects(executeOwnerAcceptance(value.inputPath, value.inputSha, "Run", confirm, () => {}), /SYNTHETIC_prepare/);
  assert.deepEqual(value.posts, ["register", "prepare"]);
  assert.match(fs.readFileSync(path.join(path.dirname(value.inputPath), "acceptance-events.jsonl"), "utf8"), /failed_preserved/);
});
test("independent restore accepts only the recorded selected generation", async context => {
  const value = await fixture(context, "restore");
  await assert.rejects(executeOwnerAcceptance(value.inputPath, value.inputSha, "Run", confirm, () => {}), /SYNTHETIC_restore/);
  value.change(status => ({ ...status, revision: 3 }));
  await assert.rejects(executeOwnerAcceptance(value.inputPath, value.inputSha, "Restore", confirm), /RESTORE_SELECTION_CHANGED/);
  assert.deepEqual(value.posts, ["register", "prepare", "activate", "restore"]);
});
test("independent restore succeeds after explicit failed restoration and keeps records", async context => {
  const value = await fixture(context, "restore-once");
  await assert.rejects(executeOwnerAcceptance(value.inputPath, value.inputSha, "Run", confirm, () => {}), /SYNTHETIC_restore/);
  const result = await executeOwnerAcceptance(value.inputPath, value.inputSha, "Restore", confirm);
  assert.equal(result.status, "RESTORED_ORIGINAL");
  assert.deepEqual(value.posts, ["register", "prepare", "activate", "restore", "restore"]);
});
test("actual Node CLI Inspect completes with no mutation", async context => {
  const value = await fixture(context);
  const child = spawn(process.execPath, [path.join(root, "ops", "verify-full-runtime-owner.mjs"), value.inputPath, value.inputSha, "Inspect"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise(resolve => child.once("exit", resolve));
  assert.equal(exitCode, 0, stderr);
  assert.equal(JSON.parse(stdout).status, "READY_NOT_EXECUTED");
  assert.deepEqual(value.posts, []);
});
test("snapshot failure after activation still restores the original implementation", async context => {
  const value = await fixture(context, "snapshot");
  const result = await executeOwnerAcceptance(value.inputPath, value.inputSha, "Run", confirm, () => {});
  assert.equal(result.status, "HOT_SWITCH_AND_RESTORE_PASSED");
  assert.equal(result.evidenceWarnings.some(warning => warning.phase === "activated_snapshot"), true);
  assert.deepEqual(value.posts, ["register", "prepare", "activate", "restore"]);
});
test("independent restore survives missing build material and a torn final evidence line", async context => {
  const value = await fixture(context, "restore-once");
  await assert.rejects(executeOwnerAcceptance(value.inputPath, value.inputSha, "Run", confirm, () => {}), /SYNTHETIC_restore/);
  fs.renameSync(value.input.builderPath, value.input.builderPath + ".retained");
  const events = path.join(path.dirname(value.inputPath), "acceptance-events.jsonl");
  fs.appendFileSync(events, '{"at":');
  const before = fs.readFileSync(events);
  const result = await executeOwnerAcceptance(value.inputPath, value.inputSha, "Restore", confirm);
  assert.equal(result.status, "RESTORED_ORIGINAL");
  assert.deepEqual(fs.readFileSync(events), before);
  assert.notEqual(result.eventsPath, events);
});
test("partial activation log write is preserved while later records use another file and restore remains usable", async context => {
  const value = await fixture(context, "restore-once");
  const events = path.join(path.dirname(value.inputPath), "acceptance-events.jsonl");
  const append = fs.appendFileSync;
  let injected = false;
  context.mock.method(fs, "appendFileSync", (filename, content, ...options) => {
    if (!injected && filename === events && JSON.parse(content).phase === "activated") {
      injected = true;
      append(filename, '{"at":');
      throw new Error("SYNTHETIC_PARTIAL_APPEND");
    }
    return append(filename, content, ...options);
  });
  await assert.rejects(executeOwnerAcceptance(value.inputPath, value.inputSha, "Run", confirm, () => {}), /SYNTHETIC_restore/);
  assert.equal(injected, true);
  const original = fs.readFileSync(events, "utf8");
  assert.equal(original.endsWith('{"at":'), true);
  const continued = fs.readdirSync(path.dirname(events)).filter(name => name.startsWith("continued-events-"));
  assert.equal(continued.length, 1);
  const records = fs.readFileSync(path.join(path.dirname(events), continued[0]), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(records.some(record => record.phase === "activated_snapshot"));
  assert.ok(records.some(record => record.phase === "failed_preserved"));
  const result = await executeOwnerAcceptance(value.inputPath, value.inputSha, "Restore", confirm);
  assert.equal(result.status, "RESTORED_ORIGINAL");
  assert.equal(fs.readFileSync(events, "utf8"), original);
  assert.deepEqual(value.posts, ["register", "prepare", "activate", "restore", "restore"]);
});
