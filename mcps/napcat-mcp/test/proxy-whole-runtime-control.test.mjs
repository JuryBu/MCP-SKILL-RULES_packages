import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createProxyWholeRuntimeControl, createProxyWholeRuntimeControlImplementation } from "../src/proxy-whole-runtime-control.mjs";
import { readInnerCandidateRegistry } from "../src/inner-runtime-profile.mjs";
import { createProxyParentCodeRuntime } from "../src/proxy-live-parent-runtime.mjs";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(context, actualParent = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "whole-control-fixture-"));
  context.after(() => fs.rmSync(root, { recursive: true }));
  const installationRoot = path.join(root, "approved");
  const sourceRoot = path.join(installationRoot, "src");
  fs.mkdirSync(sourceRoot, { recursive: true });
  const names = { runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" };
  const files = [];
  const expectedHashes = {};
  for (const [key, name] of Object.entries(names)) {
    fs.writeFileSync(path.join(sourceRoot, name), `export const syntheticVersion = "${key}";`);
    expectedHashes[key] = digest(fs.readFileSync(path.join(sourceRoot, name)));
    files.push({ path: name, sha256: expectedHashes[key] });
  }
  fs.writeFileSync(path.join(sourceRoot, "proxy.cjs"), "module.exports = {};");
  files.push({ path: "proxy.cjs", sha256: digest(fs.readFileSync(path.join(sourceRoot, "proxy.cjs"))) });
  const manifestPath = path.join(sourceRoot, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, stateSchema: "proxy-live-state-v1", format: "commonjs-bundle",
    version: "owned", entry: "proxy.cjs", files }));
  const manifestSha256 = digest(fs.readFileSync(manifestPath));
  const stateRoot = path.join(root, "state");
  fs.mkdirSync(stateRoot);
  const profile = { ownerId: "owned-whole-fixture", nativeSourceId: "owned-native", stateRoot,
    initial: { runnerPath: path.join(root, "original", names.runner), expectedHashes: Object.fromEntries(Object.keys(names).map(key => [key, "a".repeat(64)])) } };
  fs.writeFileSync(path.join(installationRoot, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1, kind: "candidate",
    ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId }));
  fs.writeFileSync(path.join(stateRoot, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1, kind: "state",
    ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId }));
  profile.approvedCandidates = [{ id: "owned-candidate", installationRoot, runnerPath: path.join(sourceRoot, names.runner), expectedHashes }];
  const original = { workerId: "original", sourceHashes: profile.initial.expectedHashes, ready: true, alive: true };
  const workers = [original];
  const state = { revision: 0, defaultWorker: original, parentCalls: [], workerCalls: [], failActivation: false, failRestore: false, releasePreparation: null };
  const parent = {
    status: () => ({ revision: state.revision, busy: false, failed: false }),
    checkpoint() { return { revision: state.revision }; },
    rollbackCheckpoint() { state.parentCalls.push("rollback-checkpoint"); state.revision++; },
    prepare(input) { state.parentCalls.push("prepare"); return { id: "prepared", revision: state.revision }; },
    discard() { state.parentCalls.push("discard"); },
    activate(input) { state.parentCalls.push("activate"); if (state.failActivation) throw new Error("owned-parent-failure"); state.revision++; return { revision: state.revision }; },
    restore(input) { state.parentCalls.push("restore"); if (state.failRestore) throw new Error("owned-restore-failure"); state.revision++; return { revision: state.revision }; },
  };
  let beforeActivation;
  const coordinator = {
    status: () => ({ defaultWorkerId: state.defaultWorker.workerId, workers }),
    async prepareCandidate(specification) {
      state.workerCalls.push("prepare");
      if (state.failPreparation) throw new Error("owned-worker-preparation-failure");
      if (state.delayPreparation) await new Promise(resolve => { state.releasePreparation = resolve; });
      const worker = { workerId: `candidate-${workers.length}`, sourceHashes: specification.expectedHashes, ready: true, alive: true };
      workers.push(worker);
      return { workerId: worker.workerId };
    },
    async activate({ candidateId }) { state.workerCalls.push("activate"); beforeActivation = state.defaultWorker;
      state.defaultWorker = workers.find(worker => worker.workerId === candidateId); return { activationId: "activation", targetWorkerId: candidateId }; },
    rollbackActivation() { state.workerCalls.push("rollback"); state.defaultWorker = beforeActivation; },
    discardCandidate({ workerId }) { state.workerCalls.push("discard"); const worker = workers.find(entry => entry.workerId === workerId);
      assert.notEqual(worker, state.defaultWorker); worker.alive = false; },
  };
  const runtime = createProxyWholeRuntimeControl(actualParent ? null : parent, coordinator, profile, "instance", root);
  let boundParent = parent;
  let writtenVersions = 0;
  const writeActualBundle = (version, failFactory = false) => {
    const targetRoot = writtenVersions++ ? path.join(root, version, "src") : sourceRoot;
    if (targetRoot !== sourceRoot) {
      fs.mkdirSync(targetRoot, { recursive: true });
      for (const name of Object.values(names)) fs.copyFileSync(path.join(sourceRoot, name), path.join(targetRoot, name));
      fs.copyFileSync(path.join(installationRoot, ".inner-runtime-owner.json"), path.join(path.dirname(targetRoot), ".inner-runtime-owner.json"));
      profile.approvedCandidates.push({ id: `${version}-candidate`, installationRoot: path.dirname(targetRoot), runnerPath: path.join(targetRoot, names.runner), expectedHashes });
    }
    const exports = ["outer-proxy", "inner-coordinator", "managed-session", "proxy-service"].map(id => `${JSON.stringify(id)}:{version:${JSON.stringify(version)}}`).join(",");
    const body = `module.exports={${exports},createProxyWholeRuntimeControlImplementation(state){if(Object.isFrozen(state))return{status(){},register(){},prepare(){},activate(){},restore(){},recover(){}};if(${failFactory}){state.selected=null;state.preparations.clear();throw new Error("owned-factory-failure");}return state.implementation;}};`;
    fs.writeFileSync(path.join(targetRoot, "proxy.cjs"), body);
    files.find(file => file.path === "proxy.cjs").sha256 = digest(body);
    const targetManifest = path.join(targetRoot, "manifest.json");
    fs.writeFileSync(targetManifest, JSON.stringify({ schemaVersion: 1, stateSchema: "proxy-live-state-v1", format: "commonjs-bundle", version, entry: "proxy.cjs", files }));
    return { manifestPath: targetManifest, manifestSha256: digest(fs.readFileSync(targetManifest)), workerCandidateId: targetRoot === sourceRoot ? "owned-candidate" : `${version}-candidate` };
  };
  if (actualParent) {
    const participants = ["outer-proxy", "inner-coordinator", "managed-session", "proxy-service"].map(id => {
      const entry = { implementation: { version: "original" }, generation: 0 };
      return { id, stateSchema: `${id}-v1`, exportName: id,
        snapshot: () => ({ state: entry, implementation: entry.implementation, generation: entry.generation }),
        prepare: module => module[id], activate(value) { entry.implementation = value; entry.generation++; },
        restore(token) { entry.implementation = token.implementation; entry.generation++; } };
    });
    boundParent = createProxyParentCodeRuntime([...participants, runtime.liveCodeParticipant()], { instanceId: "instance", candidateRoot: root });
    runtime.attachParent(boundParent);
  }
  const compatibilityManifest = { schemaVersion: 1, edges: [{ source: { core: profile.initial.expectedHashes.core,
    helper: profile.initial.expectedHashes.helper }, target: { core: expectedHashes.core, helper: expectedHashes.helper },
    checkpointSchemaVersion: 1, stateSchemaVersion: 1, stateSemantics: "state-v1" }] };
  const input = { instanceId: "instance", expectedRevision: 0, manifestPath, manifestSha256, workerCandidateId: "owned-candidate",
    compatibility: { manifest: compatibilityManifest, sha256: digest(JSON.stringify(compatibilityManifest)) } };
  if (actualParent) Object.assign(input, writeActualBundle("owned-A"));
  return { runtime, state, input, profile, sourceRoot, workers, parent: boundParent, coordinator, original, root, writeActualBundle };
}

test("new same-source candidate registration persists across control reload and keeps the live approval array", async context => {
  const value = fixture(context);
  const candidate = value.profile.approvedCandidates[0];
  const approvals = value.profile.approvedCandidates;
  approvals.splice(0);
  const registered = value.runtime.register({ instanceId: "instance", expectedRevision: 0, expectedRegistrySha256: null,
    manifestPath: value.input.manifestPath, manifestSha256: value.input.manifestSha256, candidate });
  assert.equal(registered.registeredCandidateId, candidate.id);
  assert.strictEqual(value.profile.approvedCandidates, approvals);
  assert.deepEqual(readInnerCandidateRegistry(value.profile).candidates, [candidate]);
  const prepared = await value.runtime.prepare(value.input);
  assert.ok(prepared.workerId);
  assert.equal(value.runtime.status().approvedCandidateIds[0], candidate.id);
});

test("registration rejects stale registry, foreign owner and mismatched source without changing approvals", context => {
  const value = fixture(context);
  const candidate = value.profile.approvedCandidates[0];
  const input = { instanceId: "instance", expectedRevision: 0, expectedRegistrySha256: null,
    manifestPath: value.input.manifestPath, manifestSha256: value.input.manifestSha256, candidate };
  assert.throws(() => value.runtime.register({ ...input, manifestSha256: "f".repeat(64) }), /MANIFEST_CHANGED/);
  assert.equal(readInnerCandidateRegistry(value.profile), null);
  value.runtime.register(input);
  assert.throws(() => value.runtime.register(input), /REGISTRY_CHANGED/);
  assert.deepEqual(value.profile.approvedCandidates, [candidate]);
  const ownerPath = path.join(candidate.installationRoot, ".inner-runtime-owner.json");
  fs.writeFileSync(ownerPath, JSON.stringify({ schemaVersion: 1, kind: "candidate", ownerId: "foreign", nativeSourceId: value.profile.nativeSourceId }));
  assert.throws(() => value.runtime.register(input), /OWNER_MISMATCH/);
});

test("the whole control implementation itself switches and restores with state and live selection preserved", async context => {
  const value = fixture(context);
  const prepared = await value.runtime.prepare(value.input);
  await value.runtime.activate({ instanceId: "instance", expectedRevision: 0, preparationId: prepared.id });
  const participant = value.runtime.liveCodeParticipant();
  const originalWorker = value.runtime.status().modelWorker.workerId;
  for (let version = 1; version <= 5; version += 1) {
    const candidate = participant.prepare({ createProxyWholeRuntimeControlImplementation(state) {
      const implementation = createProxyWholeRuntimeControlImplementation(state);
      return { ...implementation, status: () => ({ ...implementation.status(), observedVersion: version }) };
    } });
    const token = participant.activate(candidate);
    assert.equal(value.runtime.status().observedVersion, version);
    assert.equal(value.runtime.status().modelWorker.workerId, originalWorker);
    participant.restore(token);
    assert.equal(value.runtime.status().observedVersion, undefined);
  }
  const result = await value.runtime.restore({ instanceId: "instance", expectedRevision: 1 });
  assert.equal(result.modelWorker.freshWorker, true);
});

test("a fresh control recovers the durable version and an independent restore clears the boot selection", async context => {
  const value = fixture(context);
  const prepared = await value.runtime.prepare(value.input);
  await value.runtime.activate({ instanceId: "instance", expectedRevision: 0, preparationId: prepared.id });
  assert.equal(readInnerCandidateRegistry(value.profile).selection.candidateId, "owned-candidate");
  value.state.revision = 0;
  value.state.defaultWorker = value.original;
  value.workers.splice(1);
  const fresh = createProxyWholeRuntimeControl(value.parent, value.coordinator, value.profile, "fresh-instance", value.root);
  const recovered = await fresh.recover();
  assert.equal(recovered.modelWorker.targetWorkerId, fresh.status().modelWorker.workerId);
  assert.deepEqual(fresh.status().modelWorker.sourceHashes, value.profile.approvedCandidates[0].expectedHashes);
  await fresh.restore({ instanceId: "fresh-instance", expectedRevision: fresh.status().revision });
  assert.equal(readInnerCandidateRegistry(value.profile).selection, null);
  assert.deepEqual(value.state.defaultWorker.sourceHashes, value.profile.initial.expectedHashes);
});

test("preparing a whole control implementation cannot mutate nested live approvals or call a coordinator action", context => {
  const value = fixture(context);
  const participant = value.runtime.liveCodeParticipant();
  const approvalBefore = structuredClone(value.profile.approvedCandidates);
  assert.throws(() => participant.prepare({ createProxyWholeRuntimeControlImplementation(view) {
    view.profile.approvedCandidates.splice(0);
    return createProxyWholeRuntimeControlImplementation(view);
  } }), TypeError);
  assert.throws(() => participant.prepare({ createProxyWholeRuntimeControlImplementation(view) {
    view.coordinator.rollbackActivation();
    return createProxyWholeRuntimeControlImplementation(view);
  } }), TypeError);
  assert.deepEqual(value.profile.approvedCandidates, approvalBefore);
  assert.deepEqual(value.state.workerCalls, []);
  assert.equal(value.runtime.status().controlGeneration, 0);
});

test("a worker preparation failure discards its parent preparation and leaves the controller usable", async context => {
  const value = fixture(context);
  value.state.failPreparation = true;
  await assert.rejects(value.runtime.prepare(value.input), /owned-worker-preparation-failure/);
  assert.deepEqual(value.state.parentCalls, ["prepare", "discard"]);
  assert.equal(value.runtime.status().busy, false);
  value.state.failPreparation = false;
  assert.equal((await value.runtime.prepare(value.input)).id, "prepared");
});

test("a version without an approved boot compatibility edge is refused before preparation", async context => {
  const value = fixture(context);
  await assert.rejects(value.runtime.prepare({ ...value.input, compatibility: undefined }), /BOOT_COMPATIBILITY_REQUIRED/);
  assert.deepEqual(value.state.parentCalls, []);
  assert.deepEqual(value.state.workerCalls, []);
  assert.equal(readInnerCandidateRegistry(value.profile), null);
});

test("whole control rejects stale identity and unknown source before parent or worker changes", async context => {
  const value = fixture(context);
  await assert.rejects(value.runtime.prepare({ ...value.input, instanceId: "foreign" }), /STALE_BINDING/);
  await assert.rejects(value.runtime.prepare({ ...value.input, expectedRevision: 3 }), /STALE_BINDING/);
  await assert.rejects(value.runtime.prepare({ ...value.input, workerCandidateId: "unapproved" }), /UNVERIFIED_SOURCE/);
  assert.deepEqual(value.state.parentCalls, []);
  assert.deepEqual(value.state.workerCalls, []);
});

test("whole operations reject parent-only preparation, unknown activation and repeated partial restore", async context => {
  const value = fixture(context);
  await assert.rejects(value.runtime.prepare({ ...value.input, workerCandidateId: undefined }), /WORKER_CANDIDATE_REQUIRED/);
  await assert.rejects(value.runtime.activate({ instanceId: "instance", expectedRevision: 0, preparationId: "unknown" }), /PREPARATION_REQUIRED/);
  await assert.rejects(value.runtime.restore({ instanceId: "instance", expectedRevision: 0 }), /RESTORE_UNAVAILABLE/);
  assert.deepEqual(value.state.parentCalls, []);
  const prepared = await value.runtime.prepare(value.input);
  await value.runtime.activate({ instanceId: "instance", expectedRevision: 0, preparationId: prepared.id });
  await value.runtime.restore({ instanceId: "instance", expectedRevision: 1 });
  const parentCalls = [...value.state.parentCalls];
  const workerCalls = [...value.state.workerCalls];
  await assert.rejects(value.runtime.restore({ instanceId: "instance", expectedRevision: 2 }), /RESTORE_UNAVAILABLE/);
  assert.deepEqual(value.state.parentCalls, parentCalls);
  assert.deepEqual(value.state.workerCalls, workerCalls);
});

test("whole control requires the approved worker bytes to belong to the very same parent package", async context => {
  const value = fixture(context);
  const wrongRoot = path.join(path.dirname(value.sourceRoot), "other");
  fs.mkdirSync(wrongRoot);
  const otherManifest = path.join(wrongRoot, "manifest.json");
  for (const name of fs.readdirSync(value.sourceRoot)) fs.copyFileSync(path.join(value.sourceRoot, name), path.join(wrongRoot, name));
  await assert.rejects(value.runtime.prepare({ ...value.input, manifestPath: otherManifest }), /SOURCE_PACKAGE_MISMATCH/);
  assert.deepEqual(value.state.workerCalls, []);
});

test("whole control serializes parent-only calls while its candidate worker is being prepared", async context => {
  const value = fixture(context);
  value.state.delayPreparation = true;
  const preparation = value.runtime.prepare(value.input);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(value.runtime.prepare({ ...value.input, workerCandidateId: undefined }), /BUSY_OR_FAILED/);
  await assert.rejects(value.runtime.activate({ instanceId: "instance", expectedRevision: 0, preparationId: "other" }), /BUSY_OR_FAILED/);
  value.state.releasePreparation();
  await preparation;
  assert.equal(value.runtime.status().busy, false);
});

test("a parent activation failure restores the old model selection and remains usable", async context => {
  const value = fixture(context);
  const prepared = await value.runtime.prepare(value.input);
  value.state.failActivation = true;
  await assert.rejects(value.runtime.activate({ instanceId: "instance", expectedRevision: 0, preparationId: prepared.id }), /owned-parent-failure/);
  assert.equal(value.state.defaultWorker.workerId, "original");
  assert.equal(value.runtime.status().failed, false);
  assert.deepEqual(value.state.workerCalls, ["prepare", "activate", "rollback"]);
});

test("whole restore starts fresh original bytes rather than reusing a worker with business history", async context => {
  const value = fixture(context);
  const prepared = await value.runtime.prepare(value.input);
  await value.runtime.activate({ instanceId: "instance", expectedRevision: 0, preparationId: prepared.id });
  const receipt = await value.runtime.restore({ instanceId: "instance", expectedRevision: 1 });
  assert.equal(receipt.modelWorker.freshWorker, true);
  assert.notEqual(value.state.defaultWorker.workerId, "original");
  assert.deepEqual(value.state.defaultWorker.sourceHashes, value.profile.initial.expectedHashes);
});

test("a compensated restore failure retains the running version and permits a corrected restore", async context => {
  const value = fixture(context);
  const prepared = await value.runtime.prepare(value.input);
  await value.runtime.activate({ instanceId: "instance", expectedRevision: 0, preparationId: prepared.id });
  value.state.failRestore = true;
  await assert.rejects(value.runtime.restore({ instanceId: "instance", expectedRevision: 1 }), /owned-restore-failure/);
  assert.equal(value.runtime.status().failed, false);
  assert.deepEqual(value.state.defaultWorker.sourceHashes, value.profile.approvedCandidates[0].expectedHashes);
  value.state.failRestore = false;
  await value.runtime.restore({ instanceId: "instance", expectedRevision: value.runtime.status().revision });
  assert.deepEqual(value.state.defaultWorker.sourceHashes, value.profile.initial.expectedHashes);
});

test("a failed durable activation preserves the preceding parent's original restore target", async context => {
  const value = fixture(context, true);
  const first = await value.runtime.prepare(value.input);
  await value.runtime.activate({ instanceId: "instance", expectedRevision: 0, preparationId: first.id });
  const nextInput = value.writeActualBundle("owned-B");
  const next = await value.runtime.prepare({ ...value.input, ...nextInput, expectedRevision: 1 });
  const originalRename = fs.renameSync;
  fs.renameSync = (...arguments_) => { if (String(arguments_[1]).endsWith("inner-candidate-approvals.json")) throw new Error("owned-write-failure"); return originalRename(...arguments_); };
  try { await assert.rejects(value.runtime.activate({ instanceId: "instance", expectedRevision: 1, preparationId: next.id }), /owned-write-failure/); }
  finally { fs.renameSync = originalRename; }
  assert.equal(value.runtime.status().selected.version, "owned-A");
  assert.equal(value.runtime.status().previous.version, "original");
  assert.deepEqual(value.runtime.status().preparedWorkers, []);
  assert.deepEqual(value.runtime.status().prepared, []);
  await value.runtime.restore({ instanceId: "instance", expectedRevision: value.runtime.status().revision });
  assert.equal(value.runtime.status().selected.version, "original");
  assert.deepEqual(value.state.defaultWorker.sourceHashes, value.profile.initial.expectedHashes);
  assert.equal(readInnerCandidateRegistry(value.profile).selection, null);
});

test("a throwing fifth factory restores its selected record and keeps the preceding restore usable", async context => {
  const value = fixture(context, true);
  const first = await value.runtime.prepare(value.input);
  await value.runtime.activate({ instanceId: "instance", expectedRevision: 0, preparationId: first.id });
  const nextInput = value.writeActualBundle("owned-B", true);
  const next = await value.runtime.prepare({ ...value.input, ...nextInput, expectedRevision: 1 });
  await assert.rejects(value.runtime.activate({ instanceId: "instance", expectedRevision: 1, preparationId: next.id }), /owned-factory-failure/);
  assert.equal(value.runtime.status().selected.version, "owned-A");
  assert.ok(value.runtime.status().modelWorker);
  assert.equal(value.runtime.status().failed, false);
  await value.runtime.restore({ instanceId: "instance", expectedRevision: value.runtime.status().revision });
  assert.equal(value.runtime.status().selected.version, "original");
});

test("a failed durable restore compensates the parent and worker and can be retried without boot drift", async context => {
  const value = fixture(context, true);
  const first = await value.runtime.prepare(value.input);
  await value.runtime.activate({ instanceId: "instance", expectedRevision: 0, preparationId: first.id });
  const candidateWorker = value.state.defaultWorker;
  const originalRename = fs.renameSync;
  fs.renameSync = (...arguments_) => { if (String(arguments_[1]).endsWith("inner-candidate-approvals.json")) throw new Error("owned-write-failure"); return originalRename(...arguments_); };
  try { await assert.rejects(value.runtime.restore({ instanceId: "instance", expectedRevision: 1 }), /owned-write-failure/); }
  finally { fs.renameSync = originalRename; }
  assert.equal(value.runtime.status().selected.version, "owned-A");
  assert.strictEqual(value.state.defaultWorker, candidateWorker);
  assert.equal(readInnerCandidateRegistry(value.profile).selection.candidateId, "owned-candidate");
  assert.equal((await value.runtime.recover()).failed, false);
  await value.runtime.restore({ instanceId: "instance", expectedRevision: value.runtime.status().revision });
  assert.equal(value.runtime.status().selected.version, "original");
  assert.equal(readInnerCandidateRegistry(value.profile).selection, null);
});

test("a prepared worker whose source selection changes is discarded with its parent preparation", async context => {
  const value = fixture(context);
  const prepare = value.coordinator.prepareCandidate;
  value.coordinator.prepareCandidate = async specification => { const receipt = await prepare(specification); value.state.defaultWorker = { ...value.original, workerId: "changed-source" }; value.workers.push(value.state.defaultWorker); return receipt; };
  await assert.rejects(value.runtime.prepare(value.input), /SELECTION_CHANGED/);
  assert.equal(value.workers[1].alive, false);
  assert.deepEqual(value.state.parentCalls, ["prepare", "discard"]);
  assert.deepEqual(value.runtime.status().preparedWorkers, []);
});
