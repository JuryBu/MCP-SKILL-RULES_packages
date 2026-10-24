import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { buildNetworkUpgradePayload } from "../ops/build-network-upgrade-payload.mjs";
import { MAX_UPLOAD_ALLOWANCE_MS } from "../src/request-wait-budget.mjs";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const names = ["codex-model-stream-proxy-runner.mjs", "codex-model-stream-proxy.mjs", "thread-recovery-handoff.mjs",
  "inner-runner-handoff-control.mjs", "incremental-responses-transport.mjs", "inner-cold-start-state.mjs",
  "inner-recovery-control-page.mjs", "model-failure-policy.mjs", "model-operation-ledger.mjs",
  "model-recovery-notifications.mjs", "upload-allowance-policy.mjs"];

function fixture(context, { nestedDataRoot = false } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "network-upgrade-payload-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, value) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
    return target;
  };
  const sourceRoot = path.join(root, "source");
  const installedRoot = path.join(root, "installed");
  const codexHome = path.join(root, "home");
  const dataRelative = nestedDataRoot ? "home/mcp-http-broker/napcat-mcp" : "data";
  const dataRoot = path.join(root, dataRelative);
  const stateRoot = path.join(dataRoot, "state", "old-inner");
  fs.mkdirSync(stateRoot, { recursive: true }); fs.mkdirSync(codexHome, { recursive: true });
  const files = names.map(name => {
    const relative = `src/${name}`;
    write(`source/${relative}`, `export const candidate = ${JSON.stringify(name)};`);
    write(`installed/${relative}`, `export const original = ${JSON.stringify(name)};`);
    return { relative, sha256: digest(fs.readFileSync(path.join(sourceRoot, relative))) };
  });
  const sourceSha256 = digest(JSON.stringify(files));
  const sourceManifestPath = write("source-manifest.json", { schemaVersion: 1, sourceSha256, files });
  const keys = ["runner", "core", "helper", "control"];
  const expectedHashes = Object.fromEntries(keys.map((key, index) => [key, digest(fs.readFileSync(path.join(installedRoot, "src", names[index])))]));
  const innerProfilePath = write(`${dataRelative}/state/old-inner/profile.json`, { schemaVersion: 1, mode: "production", ownerId: "fixture-owner",
    approvedUpstreamOrigin: "https://fixture.invalid", upstreamOrigin: "https://fixture.invalid",
    nativeSourceId: "fixture-source", stateRoot, outerStateRoot: path.join(dataRoot, "state"), innerPort: 18435,
    checkpointRoot: path.join(stateRoot, "checkpoints"), codexHome,
    installationRoot: installedRoot, initial: { runnerPath: path.join(installedRoot, "src", names[0]), expectedHashes },
    managedStatePath: path.join(stateRoot, "managed-runtime.json") });
  const innerProfileSha256 = digest(fs.readFileSync(innerProfilePath));
  const outerStartupPath = write(`${dataRelative}/state/codex-outer-runtime-startup.json`, { schemaVersion: 1, enabled: true, candidateRoot: "unchanged",
    innerManagedProfilePath: innerProfilePath, innerManagedProfileSha256: innerProfileSha256 });
  const configPath = write("home/config.toml", "model = 'fixture-model'\n");
  return { root, specification: { sourceRoot, installedRoot, dataRoot, sourceManifestPath, sourceManifestSha256: digest(fs.readFileSync(sourceManifestPath)),
    sourceSha256, innerProfilePath, innerProfileSha256, outerStartupPath, outerStartupSha256: digest(fs.readFileSync(outerStartupPath)),
    configPath, configSha256: digest(fs.readFileSync(configPath)), outputRoot: path.join(dataRoot, "state", "network-preparation") } };
}

function originalTargetHashes(specification) {
  return new Map([specification.configPath, specification.innerProfilePath, specification.outerStartupPath,
    ...names.map(name => path.join(specification.installedRoot, "src", name))]
    .map(filename => [filename, digest(fs.readFileSync(filename))]));
}

function assertOriginalTargetsUnchanged(hashes) {
  for (const [filename, sha256] of hashes) assert.equal(digest(fs.readFileSync(filename)), sha256, filename);
}

function assertReadonlyConfigPayload(payload, specification, originalConfig) {
  assert.equal(payload.configPolicy, "readonly-exact-current-bytes");
  assert.deepEqual(payload.readOnlyDependencies, [{ role: "codex-config", path: specification.configPath,
    sha256: specification.configSha256 }]);
  assert.equal(payload.files.length, names.length + 2);
  for (const entry of payload.files) {
    assert.notEqual(entry.targetPath, specification.configPath);
    assert.doesNotMatch(entry.name, /config\.toml/iu);
    assert.equal(digest(fs.readFileSync(entry.payloadPath)), entry.candidateSha256);
  }
  const payloadRoot = path.dirname(payload.files[0].payloadPath);
  const binaryNames = fs.readdirSync(payloadRoot).filter(name => name.endsWith(".bin"));
  assert.equal(binaryNames.length, payload.files.length);
  for (const name of binaryNames) {
    assert.equal(fs.readFileSync(path.join(payloadRoot, name)).includes(originalConfig), false, name);
  }
}

test("default and explicit false preserve the legacy config copy policy", context => {
  for (const preserveUnchangedConfig of [undefined, false]) {
    const { specification } = fixture(context);
    if (preserveUnchangedConfig !== undefined) specification.preserveUnchangedConfig = preserveUnchangedConfig;
    const originalConfig = fs.readFileSync(specification.configPath);
    const hashes = originalTargetHashes(specification);
    const result = buildNetworkUpgradePayload(specification);
    const payload = JSON.parse(fs.readFileSync(result.payloadPath));
    const configEntry = payload.files.find(entry => entry.name === "private-runtime/config.toml");
    assert.equal(payload.files.length, names.length + 3);
    assert.equal(payload.configPolicy, "exact-current-bytes-preserved");
    assert.equal(payload.readOnlyDependencies, undefined);
    assert.equal(configEntry.targetPath, specification.configPath);
    assert.deepEqual(fs.readFileSync(configEntry.payloadPath), originalConfig);
    assertOriginalTargetsUnchanged(hashes);
  }
});

test("readonly config without a route records identity without copying config bytes", context => {
  const { specification } = fixture(context);
  specification.preserveUnchangedConfig = true;
  const originalConfig = fs.readFileSync(specification.configPath);
  const hashes = originalTargetHashes(specification);
  const result = buildNetworkUpgradePayload(specification);
  const payload = JSON.parse(fs.readFileSync(result.payloadPath));
  assert.equal(payload.configRoute, null);
  assertReadonlyConfigPayload(payload, specification, originalConfig);
  assertOriginalTargetsUnchanged(hashes);
});

test("readonly config accepts byte-identical routed config including BOM and CRLF without copying", context => {
  const { specification } = fixture(context);
  specification.preserveUnchangedConfig = true;
  specification.configRoute = { provider: "isolated", baseUrl: "http://127.0.0.1:18435/backend-api/codex" };
  const originalConfig = Buffer.from('\uFEFF# fixture-only config\r\nmodel = "fixture-model"\r\nmodel_provider = "isolated"\r\n'
    + '[model_providers.isolated]\r\nname = "isolated"\r\nbase_url = "http://127.0.0.1:18435/backend-api/codex"\r\n'
    + 'wire_api = "responses"\r\nrequires_openai_auth = true\r\nsupports_websockets = false\r\n');
  fs.writeFileSync(specification.configPath, originalConfig);
  specification.configSha256 = digest(originalConfig);
  const hashes = originalTargetHashes(specification);
  const result = buildNetworkUpgradePayload(specification);
  const payload = JSON.parse(fs.readFileSync(result.payloadPath));
  assert.equal(payload.configRoute.changed, false);
  assert.deepEqual(payload.configRoute.edits, []);
  assert.equal(payload.configRoute.originalSha256, specification.configSha256);
  assert.equal(payload.configRoute.candidateSha256, specification.configSha256);
  assertReadonlyConfigPayload(payload, specification, originalConfig);
  assertOriginalTargetsUnchanged(hashes);
});

test("readonly config refuses a required route change before creating any output", context => {
  const { specification } = fixture(context);
  specification.preserveUnchangedConfig = true;
  specification.configRoute = { provider: "isolated", baseUrl: "http://127.0.0.1:18435/backend-api/codex" };
  const hashes = originalTargetHashes(specification);
  assert.throws(() => buildNetworkUpgradePayload(specification), { message: "NETWORK_CONFIG_CHANGE_REFUSED" });
  assert.equal(fs.existsSync(specification.outputRoot), false);
  assertOriginalTargetsUnchanged(hashes);
});

test("readonly config keeps the original input-drift rejection with and without a route", context => {
  for (const configRoute of [undefined, { provider: "isolated", baseUrl: "http://127.0.0.1:18435/backend-api/codex" }]) {
    const { specification } = fixture(context);
    specification.preserveUnchangedConfig = true;
    if (configRoute) specification.configRoute = configRoute;
    fs.appendFileSync(specification.configPath, "# fixture drift\n");
    const hashes = originalTargetHashes(specification);
    assert.throws(() => buildNetworkUpgradePayload(specification), { message: "NETWORK_INPUT_CHANGED" });
    assert.equal(fs.existsSync(specification.outputRoot), false);
    assertOriginalTargetsUnchanged(hashes);
  }
});

test("rejects non-boolean readonly config policies before creating output", context => {
  const { specification } = fixture(context);
  const hashes = originalTargetHashes(specification);
  for (const preserveUnchangedConfig of [null, "true", "false", 0, 1, {}, []]) {
    assert.throws(() => buildNetworkUpgradePayload({ ...specification, preserveUnchangedConfig }),
      { message: "NETWORK_CONFIG_POLICY_INVALID" });
    assert.equal(fs.existsSync(specification.outputRoot), false);
    assertOriginalTargetsUnchanged(hashes);
  }
});

test("prepares complete runtime and joint profile/startup/config without changing original targets", context => {
  const { specification } = fixture(context);
  specification.runtimeEnvironment = { CODEX_MODEL_STREAM_PROXY_MANAGED_RECOVERY: "1",
    CODEX_MODEL_STREAM_PROXY_INCREMENTAL_WS: "1", CODEX_MODEL_STREAM_PROXY_INCREMENTAL_IMAGES: "1",
    CODEX_MODEL_STREAM_PROXY_WS_MAX_SESSION_BYTES: "268435456", CODEX_MODEL_STREAM_PROXY_WS_MAX_MESSAGE_BYTES: "16777216",
    CODEX_MODEL_STREAM_PROXY_WS_MAX_SESSIONS: "4", CODEX_MODEL_STREAM_PROXY_UPLOAD_ALLOWANCE_MS_PER_MIB: "16000",
    CODEX_MODEL_STREAM_PROXY_MAX_UPLOAD_ALLOWANCE_MS: "600000" };
  specification.websocketUpstreamUrl = "wss://fixture.invalid/v1/responses";
  specification.configRoute = { provider: "isolated", baseUrl: "http://127.0.0.1:18435/v1" };
  const originalProfile = fs.readFileSync(specification.innerProfilePath);
  const originalStartup = fs.readFileSync(specification.outerStartupPath);
  const result = buildNetworkUpgradePayload(specification);
  const payload = JSON.parse(fs.readFileSync(result.payloadPath));
  assert.equal(payload.files.length, names.length + 3);
  assert.equal(result.productionActions, 0);
  assert.equal(result.readyForInstall, false);
  assert.deepEqual(fs.readFileSync(specification.innerProfilePath), originalProfile);
  assert.deepEqual(fs.readFileSync(specification.outerStartupPath), originalStartup);
  assert.equal(fs.existsSync(result.newProfilePath), false);
  const profileEntry = payload.files.find(entry => entry.name === "private-runtime/new-inner-profile.json");
  const nextProfile = JSON.parse(fs.readFileSync(profileEntry.payloadPath));
  const nextStartup = JSON.parse(fs.readFileSync(payload.files.find(entry => entry.name === "private-runtime/outer-startup.json").payloadPath));
  assert.equal(nextProfile.codexHome, JSON.parse(originalProfile).codexHome);
  assert.equal(nextProfile.stateRoot, result.candidateStateRoot);
  assert.ok(result.newProfilePath.startsWith(path.join(specification.dataRoot, "state") + path.sep));
  const expectedEnvironment = { ...specification.runtimeEnvironment,
    CODEX_MODEL_STREAM_PROXY_WS_UPSTREAM_URL: specification.websocketUpstreamUrl };
  assert.deepEqual(nextProfile.environment, expectedEnvironment);
  assert.deepEqual(payload.runtimeEnvironment, expectedEnvironment);
  assert.equal(nextStartup.innerManagedProfileSha256, profileEntry.candidateSha256);
  assert.equal(nextStartup.innerManagedProfilePath, result.newProfilePath);
  assert.equal(profileEntry.beforeSha256, null);
  for (const entry of payload.files) assert.equal(digest(fs.readFileSync(entry.payloadPath)), entry.candidateSha256);
});

test("refuses modified candidate before creating output", context => {
  const { specification } = fixture(context);
  fs.appendFileSync(path.join(specification.sourceRoot, "src", names[0]), "modified");
  assert.throws(() => buildNetworkUpgradePayload(specification), /NETWORK_INPUT_CHANGED/u);
  assert.equal(fs.existsSync(specification.outputRoot), false);
});

test("refuses original config drift before creating output", context => {
  const { specification } = fixture(context);
  fs.appendFileSync(specification.configPath, "drift");
  assert.throws(() => buildNetworkUpgradePayload(specification), /NETWORK_INPUT_CHANGED/u);
  assert.equal(fs.existsSync(specification.outputRoot), false);
});

test("refuses candidate preparation inside the installed runtime", context => {
  const { specification } = fixture(context);
  specification.outputRoot = path.join(specification.installedRoot, "new-root");
  assert.throws(() => buildNetworkUpgradePayload(specification), /NETWORK_OUTPUT_OVERLAP/u);
  assert.equal(fs.existsSync(specification.outputRoot), false);
});

test("preserves the current slow-upload allowance beyond ten minutes", context => {
  const { specification } = fixture(context);
  specification.preserveUnchangedConfig = true;
  specification.runtimeEnvironment = {
    CODEX_MODEL_STREAM_PROXY_UPLOAD_ALLOWANCE_MS_PER_MIB: "33555",
    CODEX_MODEL_STREAM_PROXY_MAX_UPLOAD_ALLOWANCE_MS: "4295040",
  };
  const hashes = originalTargetHashes(specification);
  const result = buildNetworkUpgradePayload(specification);
  const payload = JSON.parse(fs.readFileSync(result.payloadPath));
  const profileEntry = payload.files.find(entry => entry.name === "private-runtime/new-inner-profile.json");
  const nextProfile = JSON.parse(fs.readFileSync(profileEntry.payloadPath));
  assert.deepEqual(nextProfile.environment, specification.runtimeEnvironment);
  assert.deepEqual(payload.runtimeEnvironment, specification.runtimeEnvironment);
  assertOriginalTargetsUnchanged(hashes);
});

test("rejects unapproved or out-of-range runtime environment before creating output", context => {
  const { specification } = fixture(context);
  for (const runtimeEnvironment of [{ OPENAI_API_KEY: "fixture" },
    { CODEX_MODEL_STREAM_PROXY_MAX_UPLOAD_ALLOWANCE_MS: String(MAX_UPLOAD_ALLOWANCE_MS + 1) },
    { CODEX_MODEL_STREAM_PROXY_MANAGED_RECOVERY: "true" },
    { CODEX_MODEL_STREAM_PROXY_UPLOAD_ALLOWANCE_MS_PER_MIB: 16000 }]) {
    assert.throws(() => buildNetworkUpgradePayload({ ...specification, runtimeEnvironment }), /NETWORK_ENVIRONMENT_INVALID/u);
    assert.equal(fs.existsSync(specification.outputRoot), false);
  }
});

test("refuses a preparation root outside the normal startup data state", context => {
  const { root, specification } = fixture(context);
  specification.outputRoot = path.join(root, "private-but-not-startable");
  assert.throws(() => buildNetworkUpgradePayload(specification), /NETWORK_OUTPUT_OUTSIDE_DATA_STATE/u);
  assert.equal(fs.existsSync(specification.outputRoot), false);
});

test("refuses a startup file not bound to the explicit data root", context => {
  const { root, specification } = fixture(context);
  const unrelatedRoot = path.join(root, "unrelated-data");
  fs.mkdirSync(unrelatedRoot);
  assert.throws(() => buildNetworkUpgradePayload({ ...specification, dataRoot: unrelatedRoot }), /NETWORK_STARTUP_DATA_ROOT_MISMATCH/u);
  assert.equal(fs.existsSync(specification.outputRoot), false);
});

test("incremental preparation requires a clean same-origin Responses websocket endpoint", context => {
  const { specification } = fixture(context);
  specification.runtimeEnvironment = { CODEX_MODEL_STREAM_PROXY_MANAGED_RECOVERY: "1", CODEX_MODEL_STREAM_PROXY_INCREMENTAL_WS: "1" };
  assert.throws(() => buildNetworkUpgradePayload(specification), /NETWORK_WS_UPSTREAM_BINDING_REQUIRED/u);
  for (const websocketUpstreamUrl of ["wss://other.invalid/v1/responses", "wss://user:secret@fixture.invalid/v1/responses",
    "wss://fixture.invalid/v1/responses?key=secret", "wss://fixture.invalid/v1/responses#fragment",
    "ws://fixture.invalid/v1/responses", "wss://fixture.invalid/unapproved-path", "wss://fixture.invalid:444/v1/responses"]) {
    assert.throws(() => buildNetworkUpgradePayload({ ...specification, websocketUpstreamUrl }), /NETWORK_WS_UPSTREAM_BINDING_INVALID/u);
    assert.equal(fs.existsSync(specification.outputRoot), false);
  }
});

test("incremental image and websocket flags cannot omit their required mode", context => {
  const { specification } = fixture(context);
  for (const runtimeEnvironment of [{ CODEX_MODEL_STREAM_PROXY_INCREMENTAL_IMAGES: "1" }, { CODEX_MODEL_STREAM_PROXY_INCREMENTAL_WS: "1" }]) {
    assert.throws(() => buildNetworkUpgradePayload({ ...specification, runtimeEnvironment }), /NETWORK_INCREMENTAL_FLAGS_INVALID/u);
    assert.equal(fs.existsSync(specification.outputRoot), false);
  }
});

test("allows only the bound data state child when DataRoot is inside CODEX_HOME", context => {
  const { specification } = fixture(context, { nestedDataRoot: true });
  const beforeConfig = fs.readFileSync(specification.configPath);
  const result = buildNetworkUpgradePayload(specification);
  const payload = JSON.parse(fs.readFileSync(result.payloadPath));
  assert.equal(payload.candidateStateWithinCodexHome, true);
  assert.equal(payload.approvedDataStateRoot, path.join(specification.dataRoot, "state"));
  assert.deepEqual(fs.readFileSync(specification.configPath), beforeConfig);
  assert.equal(result.productionActions, 0);
});

test("nested DataRoot never permits old state, CODEX_HOME siblings, or state ancestors", context => {
  const { specification } = fixture(context, { nestedDataRoot: true });
  const profile = JSON.parse(fs.readFileSync(specification.innerProfilePath));
  for (const outputRoot of [profile.codexHome, path.join(profile.codexHome, "unrelated"), specification.dataRoot,
    path.join(specification.dataRoot, "state"), path.join(profile.stateRoot, "new-child")]) {
    assert.throws(() => buildNetworkUpgradePayload({ ...specification, outputRoot }), /NETWORK_OUTPUT_(?:OVERLAP|OUTSIDE_DATA_STATE)/u);
  }
  assert.equal(fs.existsSync(specification.outputRoot), false);
});

test("nested CODEX_HOME exception requires a matching original outer state binding", context => {
  const { specification } = fixture(context, { nestedDataRoot: true });
  const profile = JSON.parse(fs.readFileSync(specification.innerProfilePath));
  delete profile.outerStateRoot;
  fs.writeFileSync(specification.innerProfilePath, JSON.stringify(profile));
  specification.innerProfileSha256 = digest(fs.readFileSync(specification.innerProfilePath));
  const startup = JSON.parse(fs.readFileSync(specification.outerStartupPath));
  startup.innerManagedProfileSha256 = specification.innerProfileSha256;
  fs.writeFileSync(specification.outerStartupPath, JSON.stringify(startup));
  specification.outerStartupSha256 = digest(fs.readFileSync(specification.outerStartupPath));
  assert.throws(() => buildNetworkUpgradePayload(specification), /NETWORK_PROFILE_DATA_STATE_BINDING_REQUIRED/u);
  assert.equal(fs.existsSync(specification.outputRoot), false);
});

test("incremental WebSocket mode requires the formal native config route", context => {
  const { specification } = fixture(context);
  specification.runtimeEnvironment = { CODEX_MODEL_STREAM_PROXY_MANAGED_RECOVERY: "1", CODEX_MODEL_STREAM_PROXY_INCREMENTAL_WS: "1" };
  specification.websocketUpstreamUrl = "wss://fixture.invalid/backend-api/codex/responses";
  assert.throws(() => buildNetworkUpgradePayload(specification), /NETWORK_CONFIG_ROUTE_REQUIRED/u);
  assert.equal(fs.existsSync(specification.outputRoot), false);
});

test("protects an independent old checkpoint tree from candidate output", context => {
  const { specification } = fixture(context, { nestedDataRoot: true });
  const profile = JSON.parse(fs.readFileSync(specification.innerProfilePath));
  profile.checkpointRoot = path.join(specification.dataRoot, "state", "old-checkpoints");
  fs.mkdirSync(profile.checkpointRoot);
  fs.writeFileSync(specification.innerProfilePath, JSON.stringify(profile));
  specification.innerProfileSha256 = digest(fs.readFileSync(specification.innerProfilePath));
  const startup = JSON.parse(fs.readFileSync(specification.outerStartupPath));
  startup.innerManagedProfileSha256 = specification.innerProfileSha256;
  fs.writeFileSync(specification.outerStartupPath, JSON.stringify(startup));
  specification.outerStartupSha256 = digest(fs.readFileSync(specification.outerStartupPath));
  specification.outputRoot = path.join(profile.checkpointRoot, "fresh");
  assert.throws(() => buildNetworkUpgradePayload(specification), /NETWORK_OUTPUT_OVERLAP/u);
  assert.equal(fs.existsSync(specification.outputRoot), false);
});
