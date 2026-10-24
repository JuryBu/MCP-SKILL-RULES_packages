import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildNetworkConfigRoute } from "./network-config-route.mjs";
import { MAX_UPLOAD_ALLOWANCE_MS } from "../src/request-wait-budget.mjs";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = code => { throw new Error(code); };
const comparable = value => process.platform === "win32" ? value.toLowerCase() : value;
const inside = (root, target) => comparable(target).startsWith(`${comparable(root)}${path.sep}`);
const workerNames = { runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
  helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" };
const environmentBounds = Object.freeze({
  CODEX_MODEL_STREAM_PROXY_MANAGED_RECOVERY: [0, 1],
  CODEX_MODEL_STREAM_PROXY_INCREMENTAL_WS: [0, 1],
  CODEX_MODEL_STREAM_PROXY_INCREMENTAL_IMAGES: [0, 1],
  CODEX_MODEL_STREAM_PROXY_WS_MAX_SESSION_BYTES: [1024, 268435456],
  CODEX_MODEL_STREAM_PROXY_WS_MAX_MESSAGE_BYTES: [1024, 16777216],
  CODEX_MODEL_STREAM_PROXY_WS_MAX_SESSIONS: [1, 128],
  CODEX_MODEL_STREAM_PROXY_UPLOAD_ALLOWANCE_MS_PER_MIB: [0, 60000],
  CODEX_MODEL_STREAM_PROXY_MAX_UPLOAD_ALLOWANCE_MS: [0, MAX_UPLOAD_ALLOWANCE_MS],
  CODEX_MODEL_STREAM_PROXY_UPSTREAM_IDLE_TIMEOUT_MS: [1000, 300000],
  CODEX_MODEL_STREAM_PROXY_ADAPTIVE_WAIT_LIMIT_MS: [1000, 300000],
});

function checkedEnvironment(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("NETWORK_ENVIRONMENT_INVALID");
  for (const [name, setting] of Object.entries(value)) {
    const bounds = environmentBounds[name];
    if (!bounds || typeof setting !== "string" || !/^(0|[1-9][0-9]*)$/u.test(setting)
      || !Number.isSafeInteger(Number(setting)) || Number(setting) < bounds[0]
      || Number(setting) > bounds[1]) fail("NETWORK_ENVIRONMENT_INVALID");
  }
  return { ...value };
}

function checkedWebSocketBinding(value, profile) {
  if (typeof value !== "string" || !/^wss?:\/\/\S+$/u.test(value)) fail("NETWORK_WS_UPSTREAM_BINDING_REQUIRED");
  let approved;
  let upstream;
  let websocket;
  try {
    approved = new URL(profile.approvedUpstreamOrigin);
    upstream = new URL(profile.upstreamOrigin);
    websocket = new URL(value);
  } catch { fail("NETWORK_WS_UPSTREAM_BINDING_INVALID"); }
  const loopback = ["127.0.0.1", "[::1]"].includes(approved.hostname);
  if (approved.origin !== profile.approvedUpstreamOrigin || upstream.origin !== profile.upstreamOrigin
    || upstream.origin !== approved.origin || approved.username || approved.password || approved.search || approved.hash
    || upstream.username || upstream.password || upstream.search || upstream.hash
    || !["https:", ...(loopback ? ["http:"] : [])].includes(approved.protocol)
    || websocket.protocol !== (approved.protocol === "https:" ? "wss:" : "ws:")
    || websocket.host !== approved.host || websocket.username || websocket.password || websocket.search || websocket.hash
    || value !== websocket.href || !["/backend-api/codex/responses", "/v1/responses"].includes(websocket.pathname)) {
    fail("NETWORK_WS_UPSTREAM_BINDING_INVALID");
  }
  return websocket.href;
}

function plain(filename, existing = true) {
  if (!path.isAbsolute(filename ?? "")) fail("NETWORK_ABSOLUTE_PATH_REQUIRED");
  const resolved = path.resolve(filename);
  if (resolved === path.parse(resolved).root) fail("NETWORK_DRIVE_ROOT_REFUSED");
  for (let current = resolved; current !== path.dirname(current); current = path.dirname(current)) {
    if (fs.existsSync(current) && (fs.lstatSync(current).isSymbolicLink()
      || fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase())) fail("NETWORK_LINK_REFUSED");
  }
  if (existing && !fs.existsSync(resolved)) fail("NETWORK_INPUT_MISSING");
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isFile() && fs.lstatSync(resolved).nlink !== 1) fail("NETWORK_HARDLINK_REFUSED");
  return resolved;
}

function pinned(filename, expected) {
  if (!/^[a-f0-9]{64}$/u.test(expected ?? "")) fail("NETWORK_PIN_REQUIRED");
  const bytes = fs.readFileSync(plain(filename));
  if (digest(bytes) !== expected) fail("NETWORK_INPUT_CHANGED");
  return bytes;
}

export function buildNetworkUpgradePayload(specification) {
  if (specification.preserveUnchangedConfig !== undefined && typeof specification.preserveUnchangedConfig !== "boolean") {
    fail("NETWORK_CONFIG_POLICY_INVALID");
  }
  const preserveUnchangedConfig = specification.preserveUnchangedConfig === true;
  const { sourceRoot, sourceManifestPath, sourceManifestSha256, sourceSha256, installedRoot,
    innerProfilePath, innerProfileSha256, outerStartupPath, outerStartupSha256,
    configPath, configSha256, outputRoot, dataRoot } = specification;
  const runtimeEnvironment = checkedEnvironment(specification.runtimeEnvironment);
  const source = plain(sourceRoot);
  const installation = plain(installedRoot);
  const output = plain(outputRoot, false);
  const data = plain(dataRoot);
  const dataStateRoot = path.join(data, "state");
  if (comparable(plain(outerStartupPath)) !== comparable(path.join(dataStateRoot, "codex-outer-runtime-startup.json"))) {
    fail("NETWORK_STARTUP_DATA_ROOT_MISMATCH");
  }
  const manifest = JSON.parse(pinned(sourceManifestPath, sourceManifestSha256));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length < 1
    || manifest.files.length > 256 || manifest.sourceSha256 !== sourceSha256
    || digest(JSON.stringify(manifest.files)) !== sourceSha256) fail("NETWORK_SOURCE_MANIFEST_INVALID");
  const profileBytes = pinned(innerProfilePath, innerProfileSha256);
  const startupBytes = pinned(outerStartupPath, outerStartupSha256);
  const configuration = pinned(configPath, configSha256);
  const profile = JSON.parse(profileBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  const startup = JSON.parse(startupBytes.toString("utf8").replace(/^\uFEFF/u, ""));
  if (profile.schemaVersion !== 1 || profile.mode !== "production" || profile.activeCandidateId !== undefined
    || comparable(path.resolve(profile.installationRoot)) !== comparable(installation)
    || comparable(path.resolve(profile.initial?.runnerPath ?? "")) !== comparable(path.join(installation, "src", workerNames.runner))
    || startup.schemaVersion !== 1
    || startup.enabled !== true || path.resolve(startup.innerManagedProfilePath) !== path.resolve(innerProfilePath)
    || startup.innerManagedProfileSha256 !== innerProfileSha256
    || ![profile.ownerId, profile.nativeSourceId].every(value => /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value ?? ""))) {
    fail("NETWORK_PROFILE_BASELINE_INVALID");
  }
  const effectiveEnvironment = { ...profile.environment, ...runtimeEnvironment };
  if (effectiveEnvironment.CODEX_MODEL_STREAM_PROXY_INCREMENTAL_IMAGES === "1"
    && effectiveEnvironment.CODEX_MODEL_STREAM_PROXY_INCREMENTAL_WS !== "1") fail("NETWORK_INCREMENTAL_FLAGS_INVALID");
  if (effectiveEnvironment.CODEX_MODEL_STREAM_PROXY_INCREMENTAL_WS === "1") {
    if (effectiveEnvironment.CODEX_MODEL_STREAM_PROXY_MANAGED_RECOVERY !== "1") fail("NETWORK_INCREMENTAL_FLAGS_INVALID");
    runtimeEnvironment.CODEX_MODEL_STREAM_PROXY_WS_UPSTREAM_URL = checkedWebSocketBinding(specification.websocketUpstreamUrl, profile);
  }
  if (comparable(plain(configPath)) !== comparable(path.join(plain(profile.codexHome), "config.toml"))) fail("NETWORK_CONFIG_HOME_MISMATCH");
  if (effectiveEnvironment.CODEX_MODEL_STREAM_PROXY_INCREMENTAL_WS === "1" && !specification.configRoute) fail("NETWORK_CONFIG_ROUTE_REQUIRED");
  const routedConfiguration = specification.configRoute
    ? buildNetworkConfigRoute(configuration, specification.configRoute, profile, runtimeEnvironment.CODEX_MODEL_STREAM_PROXY_WS_UPSTREAM_URL)
    : { bytes: configuration, evidence: null };
  if (preserveUnchangedConfig && !configuration.equals(routedConfiguration.bytes)) fail("NETWORK_CONFIG_CHANGE_REFUSED");
  if (profile.outerStateRoot && comparable(plain(profile.outerStateRoot)) !== comparable(dataStateRoot)) fail("NETWORK_PROFILE_DATA_STATE_MISMATCH");
  for (const protectedRoot of [installation, source, plain(profile.stateRoot), ...(profile.checkpointRoot ? [plain(profile.checkpointRoot, false)] : [])]) {
    if (comparable(output) === comparable(protectedRoot) || inside(protectedRoot, output) || inside(output, protectedRoot)) fail("NETWORK_OUTPUT_OVERLAP");
  }
  if (!inside(dataStateRoot, output)) fail("NETWORK_OUTPUT_OUTSIDE_DATA_STATE");
  const home = plain(profile.codexHome);
  if (inside(home, output) && !profile.outerStateRoot) fail("NETWORK_PROFILE_DATA_STATE_BINDING_REQUIRED");
  if (comparable(output) === comparable(home) || inside(output, home)
    || (inside(home, output) && !(inside(home, dataStateRoot) && inside(dataStateRoot, output)))) fail("NETWORK_OUTPUT_OVERLAP");
  if (fs.existsSync(output)) fail("NETWORK_NEW_OUTPUT_REQUIRED");
  const files = new Map();
  const seen = new Set();
  for (const entry of manifest.files) {
    if (typeof entry.relative !== "string" || !/^[a-zA-Z0-9_./-]+$/u.test(entry.relative)
      || entry.relative.split("/").some(part => ["", ".", ".."].includes(part))
      || seen.has(entry.relative.toLowerCase())) fail("NETWORK_MANIFEST_PATH_INVALID");
    seen.add(entry.relative.toLowerCase());
    const bytes = pinned(path.join(source, entry.relative), entry.sha256);
    if (/^(?:src\/|ops\/|node_modules\/ws\/)/u.test(entry.relative)) files.set(entry.relative, bytes);
    else if (!entry.relative.startsWith("test/")) fail("NETWORK_RUNTIME_PREFIX_REFUSED");
  }
  const hashes = {};
  for (const [key, filename] of Object.entries(workerNames)) {
    const candidate = files.get(`src/${filename}`);
    if (!candidate || digest(fs.readFileSync(plain(path.join(installation, "src", filename)))) !== profile.initial?.expectedHashes?.[key]) {
      fail("NETWORK_WORKER_BASELINE_CHANGED");
    }
    hashes[key] = digest(candidate);
  }
  for (const filename of ["incremental-responses-transport.mjs", "inner-cold-start-state.mjs", "inner-recovery-control-page.mjs",
    "model-failure-policy.mjs", "model-operation-ledger.mjs", "model-recovery-notifications.mjs", "upload-allowance-policy.mjs"]) {
    if (!files.has(`src/${filename}`)) fail("NETWORK_NEW_MODULE_MISSING");
  }
  const stateRoot = path.join(output, "candidate-state");
  const checkpointRoot = path.join(stateRoot, "checkpoints");
  const nextProfilePath = path.join(stateRoot, "inner-managed-profile.json");
  const nextProfile = { ...profile, stateRoot, checkpointRoot, managedStatePath: path.join(stateRoot, "managed-runtime.json"),
    initial: { ...profile.initial, expectedHashes: hashes }, environment: { ...profile.environment, ...runtimeEnvironment } };
  const nextProfileBytes = Buffer.from(JSON.stringify(nextProfile, null, 2));
  const nextStartupBytes = Buffer.from(JSON.stringify({ ...startup, innerManagedProfilePath: nextProfilePath,
    innerManagedProfileSha256: digest(nextProfileBytes) }, null, 2));
  const planned = [...files].map(([name, bytes]) => ({ name, targetPath: path.join(installation, name), bytes }));
  planned.push({ name: "private-runtime/new-inner-profile.json", targetPath: nextProfilePath, bytes: nextProfileBytes },
    { name: "private-runtime/outer-startup.json", targetPath: plain(outerStartupPath), bytes: nextStartupBytes });
  if (!preserveUnchangedConfig) {
    planned.push({ name: "private-runtime/config.toml", targetPath: plain(configPath), bytes: routedConfiguration.bytes });
  }
  const targets = new Set();
  for (const entry of planned) {
    const target = plain(entry.targetPath, false);
    if (targets.has(target.toLowerCase())) fail("NETWORK_DUPLICATE_TARGET");
    targets.add(target.toLowerCase());
    entry.before = fs.existsSync(target) ? fs.readFileSync(target) : null;
  }
  pinned(innerProfilePath, innerProfileSha256);
  pinned(outerStartupPath, outerStartupSha256);
  pinned(configPath, configSha256);
  fs.mkdirSync(checkpointRoot, { recursive: true });
  for (const [root, kind] of [[stateRoot, "state"], [checkpointRoot, "checkpoint"]]) {
    fs.writeFileSync(path.join(root, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1,
      ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId, kind }), { flag: "wx" });
  }
  const payloadRoot = path.join(output, "payload");
  fs.mkdirSync(payloadRoot);
  const entries = planned.map((entry, index) => {
    const payloadPath = path.join(payloadRoot, `${index}.bin`);
    fs.writeFileSync(payloadPath, entry.bytes, { flag: "wx" });
    return { name: entry.name, targetPath: entry.targetPath, payloadPath, candidateSha256: digest(entry.bytes),
      beforeSha256: entry.before === null ? null : digest(entry.before), provenance: { kind: "pinned-network-runtime",
        sourceSha256, originalProfilePath: plain(innerProfilePath), originalProfileSha256: innerProfileSha256 } };
  });
  const payloadPath = path.join(payloadRoot, "payload.json");
  const payload = { schemaVersion: 1, targetRoot: installation, scope: "network-runtime-upgrade-v1", files: entries,
    sourceSha256, sourceManifestSha256, productionActions: 0, oldStateRoot: profile.stateRoot,
    candidateStateRoot: stateRoot, preservedCodexHome: profile.codexHome, oldRootPreserved: true,
    configPolicy: preserveUnchangedConfig ? "readonly-exact-current-bytes"
      : routedConfiguration.evidence ? "minimal-inner-route-with-exact-joint-rollback" : "exact-current-bytes-preserved",
    ...(preserveUnchangedConfig ? { readOnlyDependencies: [{ role: "codex-config", path: plain(configPath), sha256: configSha256 }] } : {}),
    configRoute: routedConfiguration.evidence, approvedDataStateRoot: dataStateRoot,
    candidateStateWithinCodexHome: inside(home, stateRoot), runtimeEnvironment, needsOwnerWindow: true };
  fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2), { flag: "wx" });
  return { payloadPath, payloadSha256: digest(fs.readFileSync(payloadPath)), fileCount: entries.length,
    candidateStateRoot: stateRoot, newProfilePath: nextProfilePath, productionActions: 0, readyForInstall: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [specificationPath, specificationSha256] = process.argv.slice(2);
  console.log(JSON.stringify(buildNetworkUpgradePayload(JSON.parse(pinned(specificationPath, specificationSha256)))));
}
