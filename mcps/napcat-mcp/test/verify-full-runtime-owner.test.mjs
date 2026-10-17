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
async function fixture(context, fault, withRegistry = false) {
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
  const stateRoot = path.join(directory, "state");
  const registryPath = path.join(stateRoot, "inner-candidate-approvals.json");
  if (withRegistry) fs.mkdirSync(stateRoot);
  fs.writeFileSync(managedStatePath, "{}");
  fs.writeFileSync(profilePath, JSON.stringify({ installationRoot, managedStatePath, ...(withRegistry ? { stateRoot } : {}),
    initial: { expectedHashes }, ownerId: "fixture-owner", nativeSourceId: "fixture-native" }));
  const tokenPath = path.join(directory, "token");
  fs.writeFileSync(tokenPath, "fixture-token");
  let status = { ok: true, instanceId: "fixture-instance", revision: 0, selected: { id: "original" }, candidateRegistrySha256: null,
    busy: false, failed: false, participants: [{}, {}, {}, {}, {}], prepared: [], preparedWorkers: [] };
  let manifestSha256;
  let manifestPath;
  let compatibility;
  let previousSelection;
  let registeredRegistry;
  const posts = [];
  let failures = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    if (request.method === "GET") {
      if (posts.includes("activate") && !posts.includes("restore")) {
        if (fault === "activated-status-error") {
          response.statusCode = 503;
          return response.end(JSON.stringify({ ok: false, error: { code: "SYNTHETIC_STATUS_UNAVAILABLE" } }));
        }
        if (fault === "activated-status-drift") return response.end(JSON.stringify({ ...status, revision: status.revision + 1 }));
      }
      return response.end(JSON.stringify(status));
    }
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
      manifestPath = input.manifestPath;
      status = { ...status, candidateRegistrySha256: "registered" };
      if (withRegistry) {
        fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: 1, selection: { candidateId: previousSelection.id,
          manifestSha256: previousSelection.manifestSha256 ?? null }, candidates: [input.candidate] }));
        registeredRegistry = fs.readFileSync(registryPath);
        status.candidateRegistrySha256 = hash(registryPath);
      }
    } else if (method === "prepare") {
      assert.equal(input.workerCandidateId, "same-source-proof");
      compatibility = input.compatibility;
      if (withRegistry && fault === "prepare-registry") fs.appendFileSync(registryPath, " ");
      return response.end(JSON.stringify({ ok: true, id: "prepared-id", revision: status.revision }));
    } else if (method === "activate") {
      assert.equal(input.preparationId, "prepared-id");
      status = { ...status, revision: status.revision + 1, selected: { id: "candidate", manifestSha256 } };
      if (withRegistry) {
        const registry = JSON.parse(fs.readFileSync(registryPath));
        registry.selection = { candidateId: "same-source-proof", manifestPath, manifestSha256, compatibility };
        fs.writeFileSync(registryPath, JSON.stringify(registry));
        status.candidateRegistrySha256 = hash(registryPath);
        if (fault === "activated-registry") fs.appendFileSync(registryPath, " ");
        if (fault === "activated-response") status.candidateRegistrySha256 = "f".repeat(64);
      }
      if (fault === "snapshot") fs.renameSync(managedStatePath, managedStatePath + ".retained");
      const activationResponse = { ...status };
      delete activationResponse.candidateRegistrySha256;
      return response.end(JSON.stringify(activationResponse));
    } else if (method === "restore") {
      status = { ...status, revision: status.revision + 1, selected: previousSelection };
      if (withRegistry) {
        fs.writeFileSync(registryPath, registeredRegistry);
        status.candidateRegistrySha256 = hash(registryPath);
      }
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
  return { inputPath, inputSha: hash(inputPath), posts, input, registryPath, change: callback => { status = callback(status); } };
}
const confirm = prompt => Promise.resolve(prompt.startsWith("Type ACTIVATE") ? "ACTIVATE" : prompt.startsWith("Type RESTORE") ? "RESTORE-SAME-RUNTIME" : "TEST-HOT-SWITCH");

async function recoveryFixture(context, fault) {
  const value = await fixture(context, fault, true);
  value.input.requireRecoveryPreparation = true;
  fs.writeFileSync(value.inputPath, JSON.stringify(value.input));
  value.inputSha = hash(value.inputPath);
  return value;
}
function prepareRecoveryFiles(context) {
  const directory = path.dirname(context.inputPath);
  const targetRegistryPath = path.join(directory, "recovery-target.json");
  const sourceRegistryPath = path.join(directory, "recovery-source.json");
  const recoveryPath = path.join(directory, "recovery.mjs");
  const configurationPath = path.join(directory, "recovery-configuration.json");
  fs.copyFileSync(context.registryPath, targetRegistryPath);
  const source = JSON.parse(fs.readFileSync(targetRegistryPath));
  source.selection = { candidateId: context.candidate.id, manifestPath: context.built.manifestPath,
    manifestSha256: context.built.manifestSha256, compatibility: context.compatibility };
  fs.writeFileSync(sourceRegistryPath, JSON.stringify(source));
  fs.writeFileSync(recoveryPath, "export const fixtureRecovery = true;\n");
  fs.writeFileSync(configurationPath, JSON.stringify({ registryPath: context.registryPath, sourceRegistryPath, targetRegistryPath,
    pins: [sourceRegistryPath, targetRegistryPath, recoveryPath].map(filename => ({ path: filename, sha256: hash(filename) })) }));
  return { registryPath: context.registryPath, sourceRegistryPath, sourceRegistrySha256: hash(sourceRegistryPath),
    targetRegistryPath, targetRegistrySha256: hash(targetRegistryPath), configurationPath, configurationSha256: hash(configurationPath) };
}
function acceptanceRecords(value) {
  return fs.readFileSync(path.join(path.dirname(value.inputPath), "acceptance-events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
}

test("required recovery hook is checked by Inspect without executing or creating a candidate", async context => {
  const value = await recoveryFixture(context);
  for (const action of ["Inspect", "Apply", "Run"]) {
    await assert.rejects(executeOwnerAcceptance(value.inputPath, value.inputSha, action, confirm, () => {}), /RECOVERY_PREPARATION_REQUIRED/);
  }
  const result = await executeOwnerAcceptance(value.inputPath, value.inputSha, "Inspect", confirm, () => {}, {
    prepareRecovery: () => assert.fail("Inspect executed recovery hook"),
  });
  assert.equal(result.status, "READY_NOT_EXECUTED");
  assert.deepEqual(value.posts, []);
  assert.equal(fs.existsSync(value.input.installationRoot), false);
  assert.equal(fs.existsSync(path.join(path.dirname(value.inputPath), "acceptance-events.jsonl")), false);
});

test("Inspect rejects required recovery without the pinned profile state root", async context => {
  const value = await fixture(context);
  value.input.requireRecoveryPreparation = true;
  fs.writeFileSync(value.inputPath, JSON.stringify(value.input));
  await assert.rejects(executeOwnerAcceptance(value.inputPath, hash(value.inputPath), "Inspect", confirm, () => {}, {
    prepareRecovery: () => assert.fail("Inspect executed recovery hook"),
  }), /RECOVERY_STATE_ROOT_REQUIRED/);
  assert.deepEqual(value.posts, []);
});

test("required recovery failure preserves prepared evidence and never activates", async context => {
  const value = await recoveryFixture(context);
  const emitted = [];
  await assert.rejects(executeOwnerAcceptance(value.inputPath, value.inputSha, "Apply", confirm, line => emitted.push(line), {
    prepareRecovery: async hookContext => {
      assert.deepEqual(value.posts, ["register", "prepare"]);
      assert.equal(hash(hookContext.registryPath), hookContext.registered.candidateRegistrySha256);
      throw new Error("SYNTHETIC_RECOVERY_FAILURE");
    },
  }), /SYNTHETIC_RECOVERY_FAILURE/);
  assert.deepEqual(value.posts, ["register", "prepare"]);
  assert.equal(acceptanceRecords(value).at(-1).phase, "failed_preserved");
  assert.equal(JSON.parse(emitted.at(-1)).status, "FAILED_PRESERVED");
});

test("registry drift during prepare prevents calling recovery and activation", async context => {
  const value = await recoveryFixture(context, "prepare-registry");
  await assert.rejects(executeOwnerAcceptance(value.inputPath, value.inputSha, "Apply", confirm, () => {}, {
    prepareRecovery: () => assert.fail("recovery called with drifted registered registry"),
  }), /PIN_CHANGED/);
  assert.deepEqual(value.posts, ["register", "prepare"]);
  assert.equal(acceptanceRecords(value).at(-1).phase, "failed_preserved");
});

test("recovery awaits fixed isolated context between prepared and activation and binds actual registry", async context => {
  const value = await recoveryFixture(context);
  let receipt;
  const result = await executeOwnerAcceptance(value.inputPath, value.inputSha, "Apply", confirm, () => {}, {
    prepareRecovery: async hookContext => {
      assert.deepEqual(Object.keys(hookContext).sort(), ["inputPath", "inputSha256", "action", "input", "profile", "sourceManifest",
        "before", "registered", "prepared", "built", "candidate", "compatibility", "registryPath"].sort());
      assert.equal(hookContext.inputSha256, value.inputSha);
      assert.equal(hookContext.action, "Apply");
      assert.equal(hookContext.prepared.id, "prepared-id");
      assert.equal(hookContext.registryPath, value.registryPath);
      assert.equal(acceptanceRecords(value).filter(entry => entry.phase === "prepared").length, 1);
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.deepEqual(value.posts, ["register", "prepare"]);
      receipt = prepareRecoveryFiles(hookContext);
      hookContext.input.candidateId = "callback-mutated-copy";
      hookContext.registered.candidateRegistrySha256 = "callback-mutated-copy";
      return receipt;
    },
  });
  assert.equal(result.status, "HOT_SWITCH_APPLIED");
  assert.equal(result.evidenceWarnings.length, 0);
  assert.equal(hash(value.registryPath), receipt.sourceRegistrySha256);
  const phases = acceptanceRecords(value).map(entry => entry.phase);
  assert.ok(phases.indexOf("prepared") < phases.indexOf("recovery_preparation_requested"));
  assert.ok(phases.indexOf("recovery_preparation_requested") < phases.indexOf("recovery_prepared"));
  assert.ok(phases.indexOf("recovery_prepared") < phases.indexOf("activate_requested"));
  assert.deepEqual(value.posts, ["register", "prepare", "activate"]);
  const restored = await executeOwnerAcceptance(value.inputPath, value.inputSha, "Restore", confirm, () => {});
  assert.equal(restored.status, "RESTORED_ORIGINAL");
});

for (const mutation of ["registry-file", "registry-status", "source", "target", "configuration", "pin"]) {
  test(`recovery ${mutation} drift at final confirmation never activates`, async context => {
    const value = await recoveryFixture(context);
    let receipt;
    const mutateAtConfirmation = async prompt => {
      if (prompt.startsWith("Type ACTIVATE")) {
        if (mutation === "registry-status") value.change(status => ({ ...status, candidateRegistrySha256: "e".repeat(64) }));
        else fs.appendFileSync(mutation === "registry-file" ? value.registryPath : mutation === "source" ? receipt.sourceRegistryPath
          : mutation === "target" ? receipt.targetRegistryPath : mutation === "configuration" ? receipt.configurationPath
          : JSON.parse(fs.readFileSync(receipt.configurationPath)).pins.at(-1).path, " ");
      }
      return confirm(prompt);
    };
    await assert.rejects(executeOwnerAcceptance(value.inputPath, value.inputSha, "Apply", mutateAtConfirmation, () => {}, {
      prepareRecovery: hookContext => { receipt = prepareRecoveryFiles(hookContext); return receipt; },
    }), /PIN_CHANGED|PRE_ACTIVATE_REGISTRY_CHANGED/);
    assert.deepEqual(value.posts, ["register", "prepare"]);
    assert.equal(acceptanceRecords(value).some(entry => entry.phase === "activate_requested"), false);
    assert.equal(acceptanceRecords(value).at(-1).phase, "failed_preserved");
  });
}

for (const mutation of ["missing-receipt", "strings-only", "wrong-registry-path", "wrong-target-sha", "source-sha", "configuration-sha", "empty-pins", "missing-source", "missing-target", "missing-pin", "pin-sha", "configuration-binding", "missing-registry-pin"]) {
  test(`recovery receipt rejects ${mutation} without activation`, async context => {
    const value = await recoveryFixture(context);
    await assert.rejects(executeOwnerAcceptance(value.inputPath, value.inputSha, "Apply", confirm, () => {}, {
      prepareRecovery: hookContext => {
        const receipt = prepareRecoveryFiles(hookContext);
        if (mutation === "missing-receipt") return undefined;
        if (mutation === "strings-only") return { registryPath: receipt.registryPath, sourceRegistrySha256: receipt.sourceRegistrySha256,
          targetRegistrySha256: receipt.targetRegistrySha256 };
        if (mutation === "wrong-registry-path") receipt.registryPath = receipt.targetRegistryPath;
        if (mutation === "wrong-target-sha") receipt.targetRegistrySha256 = "e".repeat(64);
        if (mutation === "source-sha") receipt.sourceRegistrySha256 = "e".repeat(64);
        if (mutation === "missing-source") receipt.sourceRegistryPath += ".missing";
        if (mutation === "missing-target") receipt.targetRegistryPath += ".missing";
        const configuration = JSON.parse(fs.readFileSync(receipt.configurationPath));
        if (mutation === "empty-pins") configuration.pins = [];
        if (mutation === "missing-pin") configuration.pins.at(-1).path += ".missing";
        if (mutation === "pin-sha") configuration.pins.at(-1).sha256 = "e".repeat(64);
        if (mutation === "configuration-binding") configuration.registryPath = receipt.targetRegistryPath;
        if (mutation === "missing-registry-pin") configuration.pins.shift();
        fs.writeFileSync(receipt.configurationPath, JSON.stringify(configuration));
        receipt.configurationSha256 = hash(receipt.configurationPath);
        if (mutation === "configuration-sha") receipt.configurationSha256 = "e".repeat(64);
        return receipt;
      },
    }), /RECOVERY_RECEIPT_INVALID|RECOVERY_TARGET_REGISTRY_CHANGED|RECOVERY_PINS_INVALID|RECOVERY_CONFIGURATION_BINDING_CHANGED|RECOVERY_REGISTRY_PIN_MISSING|PIN_CHANGED|ENOENT/);
    assert.deepEqual(value.posts, ["register", "prepare"]);
    assert.equal(acceptanceRecords(value).at(-1).phase, "failed_preserved");
  });
}

for (const fault of ["activated-registry", "activated-response"]) {
  test(`${fault} SHA failure preserves activated state without warning-only success or restore`, async context => {
    const value = await recoveryFixture(context, fault);
    const emitted = [];
    await assert.rejects(executeOwnerAcceptance(value.inputPath, value.inputSha, "Run", confirm, line => emitted.push(line), {
      prepareRecovery: prepareRecoveryFiles,
    }), /PIN_CHANGED|ACTIVATED_RECOVERY_REGISTRY_CHANGED/);
    assert.deepEqual(value.posts, ["register", "prepare", "activate"]);
    const failed = acceptanceRecords(value).at(-1);
    assert.equal(failed.phase, "failed_preserved");
    assert.equal(failed.value.phase, "activated_recovery_binding");
    assert.equal(failed.value.actual.revision, 1);
    assert.equal(JSON.parse(emitted.at(-1)).status, "FAILED_PRESERVED");
    assert.equal(JSON.parse(emitted.at(-1)).retryAllowed, false);
  });
}

test("activation response without registry SHA verifies the real subsequent status and disk", async context => {
  const value = await recoveryFixture(context);
  const result = await executeOwnerAcceptance(value.inputPath, value.inputSha, "Apply", confirm, () => {}, {
    prepareRecovery: prepareRecoveryFiles,
  });
  assert.equal(result.status, "HOT_SWITCH_APPLIED");
  assert.deepEqual(value.posts, ["register", "prepare", "activate"]);
  assert.equal(acceptanceRecords(value).some(entry => entry.phase === "failed_preserved"), false);
});

for (const fault of ["activated-status-error", "activated-status-drift"]) {
  test(`${fault} preserves the already activated candidate`, async context => {
    const value = await recoveryFixture(context, fault);
    await assert.rejects(executeOwnerAcceptance(value.inputPath, value.inputSha, "Apply", confirm, () => {}, {
      prepareRecovery: prepareRecoveryFiles,
    }), /SYNTHETIC_STATUS_UNAVAILABLE|ACTIVATED_RECOVERY_STATE_CHANGED/);
    assert.deepEqual(value.posts, ["register", "prepare", "activate"]);
    assert.equal(acceptanceRecords(value).at(-1).value.phase, "activated_recovery_binding");
  });
}

for (const flag of [undefined, false]) {
  test(`an optional recovery callback is ignored when the input flag is ${flag}`, async context => {
    const value = await fixture(context);
    if (flag !== undefined) {
      value.input.requireRecoveryPreparation = flag;
      fs.writeFileSync(value.inputPath, JSON.stringify(value.input));
    }
    const result = await executeOwnerAcceptance(value.inputPath, hash(value.inputPath), "Run", confirm, () => {}, {
      prepareRecovery: () => assert.fail("optional callback executed without flag"),
    });
    assert.equal(result.status, "HOT_SWITCH_AND_RESTORE_PASSED");
    assert.deepEqual(value.posts, ["register", "prepare", "activate", "restore"]);
  });
}

test("required recovery Run retains the original restore flow", async context => {
  const value = await recoveryFixture(context);
  let receipt;
  const result = await executeOwnerAcceptance(value.inputPath, value.inputSha, "Run", confirm, () => {}, {
    prepareRecovery: hookContext => { receipt = prepareRecoveryFiles(hookContext); return receipt; },
  });
  assert.equal(result.status, "HOT_SWITCH_AND_RESTORE_PASSED");
  assert.equal(hash(value.registryPath), receipt.targetRegistrySha256);
  assert.deepEqual(value.posts, ["register", "prepare", "activate", "restore"]);
});

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
