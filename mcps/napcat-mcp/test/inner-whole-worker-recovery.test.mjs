import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { buildProxyParentLiveBundle } from "../src/proxy-live-build.mjs";
import { readInnerCandidateRegistry } from "../src/inner-runtime-profile.mjs";
import { fixture, until } from "./managed-session-code-fixture.mjs";

const compilerPath = process.env.CODEX_LIVE_ESBUILD_MODULE;
const oldInstallation = process.env.RECOVERY_OLD_INSTALLATION_ROOT;
const require = createRequire(import.meta.url);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

test("real whole cross-version candidate death restores old bytes and durable selection before managed restart", {
  timeout: 45000, skip: !compilerPath || !oldInstallation,
}, async context => {
  let built;
  let approved;
  let compatibility;
  const value = await fixture(context, { parent: true, production: true, async configure({ candidateRoot, configuration, sourceRoot }) {
    const installationRoot = path.join(candidateRoot, "owned-recovery-candidate");
    fs.mkdirSync(installationRoot);
    const target = path.join(installationRoot, "src");
    built = await buildProxyParentLiveBundle({ sourceRoot, destinationRoot: target, version: "owned-recovery-candidate", compiler: require(compilerPath) });
    const names = { runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
      helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" };
    const hashes = source => Object.fromEntries(Object.entries(names).map(([key, name]) => [key, digest(fs.readFileSync(path.join(source, name)))]));
    const expectedHashes = hashes(target);
    fs.writeFileSync(path.join(installationRoot, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1, kind: "candidate",
      ownerId: configuration.ownerId, nativeSourceId: configuration.nativeSourceId }));
    approved = { id: "owned-recovery-candidate", installationRoot, runnerPath: path.join(target, names.runner), expectedHashes };
    configuration.approvedCandidates = [];
    configuration.installationRoot = fs.realpathSync(oldInstallation);
    const oldSource = path.join(configuration.installationRoot, "src");
    configuration.initial = { runnerPath: path.join(oldSource, names.runner), expectedHashes: hashes(oldSource) };
    configuration.environment.CODEX_MODEL_STREAM_PROXY_MANAGED_RECOVERY = "1";
    assert.notEqual(configuration.initial.expectedHashes.core, expectedHashes.core);
    assert.notEqual(configuration.initial.expectedHashes.helper, expectedHashes.helper);
    const manifest = { schemaVersion: 1, edges: [{ source: { core: configuration.initial.expectedHashes.core,
      helper: configuration.initial.expectedHashes.helper }, target: { core: expectedHashes.core, helper: expectedHashes.helper },
      checkpointSchemaVersion: 1, stateSchemaVersion: 1, stateSemantics: "state-v1" }] };
    compatibility = { manifest, sha256: digest(JSON.stringify(manifest)) };
  } });
  const token = fs.readFileSync(value.shared.options.tokenFilePath, "utf8").trim();
  const binding = { instanceId: value.shared.options.instanceToken, expectedRevision: 0 };
  const whole = async (method, input) => {
    const response = await fetch(`http://127.0.0.1:${value.ports.control}/v1/full-runtime/${method}`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const socket = await value.connect();
  await value.rpc(socket, "initialize", { clientInfo: { name: "whole-recovery-owned", version: "1" } });
  await value.turn(socket, "old-inflight", "old-turn");
  const original = value.request("old-inflight", "old-turn");
  await until(() => value.held.length === 1);
  await value.turn(socket, "adopted", "working");
  await whole("register", { ...binding, expectedRegistrySha256: null, manifestPath: built.manifestPath,
    manifestSha256: built.manifestSha256, candidate: approved });
  const prepared = await whole("prepare", { ...binding, manifestPath: built.manifestPath,
    manifestSha256: built.manifestSha256, workerCandidateId: approved.id, compatibility });
  await whole("activate", { ...binding, preparationId: prepared.id });
  assert.equal(readInnerCandidateRegistry(value.shared.runtimeProfile).selection.candidateId, approved.id);
  const adopted = value.request("adopted", "working", [{ type: "function_call_output", call_id: "whole-owned-once", output: "once" }]);
  await until(() => value.held.length === 2);
  value.held[1].end('data: {"type":"response.completed","response":{"id":"owned-adopted","status":"completed","output":[]}}\n\n');
  assert.equal((await adopted).status, 200);
  await value.turn(socket, "candidate-new", "new-turn");
  const partial = value.request("candidate-new", "new-turn").catch(error => ({ error: error.message }));
  await until(() => value.held.length === 3);
  await new Promise(resolve => setTimeout(resolve, 50));
  const tool = await value.rpc(socket, "test/tool", { value: "whole-owned-once" });
  assert.equal(tool.result.value, "whole-owned-once");
  const worker = value.shared.coordinator.status().workers.find(worker => worker.workerId === prepared.workerId);
  value.expectedWorkerExits.add(worker.pid);
  process.kill(worker.pid);
  await until(() => value.events.some(event => event.type === "worker_recovered" || event.type === "worker_recovery_failed"));
  const failure = value.events.find(event => event.type === "worker_recovery_failed");
  assert.equal(failure, undefined, JSON.stringify(value.events.slice(-25)));
  await value.shared.selectionRecoveryTask;
  assert.equal(value.shared.selectionRecoveryError, null);
  assert.equal(readInnerCandidateRegistry(value.shared.runtimeProfile).selection, null);
  assert.ok((await partial).error);
  const recovered = value.events.find(event => event.type === "worker_recovered");
  const replacement = value.shared.coordinator.status().workers.find(worker => worker.workerId === recovered.replacementWorkerId);
  assert.deepEqual(replacement.sourceHashes, value.shared.configuration.initial.expectedHashes);
  const callsBeforeRetry = value.calls.length;
  const cancelRetry = new AbortController();
  const protectedRequest = fetch(`http://127.0.0.1:${value.ports.inner}/v1/responses`, { method: "POST", headers: {
    "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: "candidate-new", turn_id: "new-turn" }) },
  body: JSON.stringify({ model: "synthetic", stream: true, input: [] }), signal: cancelRetry.signal }).then(response => response.text()).catch(error => error.name);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(value.calls.length, callsBeforeRetry);
  cancelRetry.abort(); await protectedRequest;
  value.held[0].end('data: {"type":"response.completed","response":{"id":"owned-old","status":"completed","output":[]}}\n\n');
  assert.equal((await original).status, 200);
  const continued = value.request("adopted", "working", [{ type: "function_call_output", call_id: "whole-owned-next", output: "next" }]);
  await until(() => value.held.length === 4);
  value.release(); assert.equal((await continued).status, 200);
  assert.equal(value.shared.coordinator.status().nativeHealthy, true);
  const priorFailedId = prepared.workerId;
  await value.restart();
  assert.equal(readInnerCandidateRegistry(value.shared.runtimeProfile).selection, null);
  const boot = value.shared.coordinator.status();
  assert.equal(boot.workers.length, 1);
  assert.deepEqual(boot.workers[0].sourceHashes, value.shared.configuration.initial.expectedHashes);
  assert.notEqual(boot.defaultWorkerId, priorFailedId);
  context.diagnostic(JSON.stringify({ evidence: "whole-real-cross-version-crash-restart", oldInstallation,
    originalHashes: value.shared.configuration.initial.expectedHashes, candidateHashes: approved.expectedHashes,
    replacementHashes: replacement.sourceHashes, registrySelection: null, replayUpstreamCalls: 0,
    nativeToolReplies: 1, restartWorkers: boot.workers.length, paidRequests: 0, productionActions: 0 }));
});
