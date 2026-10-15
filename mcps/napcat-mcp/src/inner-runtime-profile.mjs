import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const identity = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const equalPath = (left, right) => process.platform === "win32"
  ? left.toLowerCase() === right.toLowerCase() : left === right;
export const withinRuntimeRoot = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export function checkedRuntimePath(value, { directory = false, existing = false } = {}) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")
    || value.split(/[\\/]/u).includes("..")) fail("INNER_PROFILE_ABSOLUTE_PATH_REQUIRED");
  const resolved = path.resolve(value);
  if (equalPath(resolved, path.parse(resolved).root)) fail("INNER_PROFILE_ROOT_FORBIDDEN");
  let current = resolved;
  while (true) {
    try {
      const stats = fs.lstatSync(current);
      if (stats.isSymbolicLink() || !equalPath(fs.realpathSync(current), current)) fail("INNER_PROFILE_REPARSE_FORBIDDEN");
      if (current === resolved && directory && !stats.isDirectory()) fail("INNER_PROFILE_DIRECTORY_REQUIRED");
      if (current === resolved && !directory && existing && !stats.isFile()) fail("INNER_PROFILE_FILE_REQUIRED");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (current === resolved && (existing || directory)) fail("INNER_PROFILE_PATH_MISSING");
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}

export const INNER_RUNTIME_STATE_MAX_BYTES = 16777216;

function boundedJson(filePath, expectedSha256, maximum = 65536) {
  const target = checkedRuntimePath(filePath, { existing: true });
  if (fs.statSync(target).size > maximum) fail("INNER_PROFILE_FILE_TOO_LARGE");
  const bytes = fs.readFileSync(target);
  if (bytes.length > maximum) fail("INNER_PROFILE_FILE_TOO_LARGE");
  if (expectedSha256 !== undefined && (!/^[0-9a-f]{64}$/u.test(expectedSha256)
    || digest(bytes) !== expectedSha256)) fail("INNER_PROFILE_SHA256_MISMATCH");
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { fail("INNER_PROFILE_INVALID_JSON"); }
}

export function validateRuntimeOrigin(value, allowedOrigin) {
  let origin;
  try { origin = new URL(value); } catch { fail("INNER_PROFILE_ORIGIN_INVALID"); }
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
    || value !== origin.origin) fail("INNER_PROFILE_ORIGIN_INVALID");
  if (origin.protocol === "http:" && origin.hostname === "127.0.0.1") return origin.origin;
  if (origin.protocol !== "https:" || value !== allowedOrigin) fail("INNER_PROFILE_ORIGIN_NOT_APPROVED");
  return origin.origin;
}

export function approvedInnerCandidate(profile, candidateId) {
  const candidates = profile.approvedCandidates ?? [];
  if (!Array.isArray(candidates) || candidates.length > 4 || new Set(candidates.map(entry => entry.id)).size !== candidates.length) {
    fail("INNER_PROFILE_CANDIDATE_APPROVAL_INVALID");
  }
  const entry = candidates.find(candidate => candidate.id === candidateId);
  if (!entry || !identity(entry.id)) fail("COORDINATOR_UNVERIFIED_SOURCE");
  const installationRoot = checkedRuntimePath(entry.installationRoot, { directory: true });
  const owner = boundedJson(path.join(installationRoot, ".inner-runtime-owner.json"));
  if (owner.schemaVersion !== 1 || owner.kind !== "candidate" || owner.ownerId !== profile.ownerId
    || owner.nativeSourceId !== profile.nativeSourceId) fail("INNER_PROFILE_CANDIDATE_OWNER_MISMATCH");
  const runnerPath = checkedRuntimePath(entry.runnerPath, { existing: true });
  if (!equalPath(runnerPath, path.join(installationRoot, "src", "codex-model-stream-proxy-runner.mjs"))
    || Object.keys(entry.expectedHashes ?? {}).sort().join(",") !== "control,core,helper,runner") fail("COORDINATOR_UNVERIFIED_SOURCE");
  for (const [key, name] of Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })) {
    const target = checkedRuntimePath(path.join(installationRoot, "src", name), { existing: true });
    if (!/^[0-9a-f]{64}$/u.test(entry.expectedHashes[key]) || digest(fs.readFileSync(target)) !== entry.expectedHashes[key]) {
      fail("COORDINATOR_UNVERIFIED_SOURCE");
    }
  }
  return { id: entry.id, installationRoot, runnerPath, expectedHashes: { ...entry.expectedHashes }, port: 0 };
}

function initialStateRecords(profile) {
  if (profile?.initialStateFiles === undefined) return [];
  const names = new Set(["codex-model-stream-delivery-profiles.json", "codex-model-adaptive-delivery.json"]);
  if (!Array.isArray(profile.initialStateFiles) || profile.initialStateFiles.length > 2
    || new Set(profile.initialStateFiles.map(entry => entry.name)).size !== profile.initialStateFiles.length) fail("INNER_PROFILE_SEED_IDENTITY_REQUIRED");
  return profile.initialStateFiles.map(entry => {
    if (!names.has(entry.name) || !Number.isInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 131072
      || !/^[0-9a-f]{64}$/u.test(entry.sha256)) fail("INNER_PROFILE_SEED_IDENTITY_REQUIRED");
    const sourcePath = checkedRuntimePath(entry.sourcePath, { existing: true });
    if (fs.statSync(sourcePath).size > 131072) fail("INNER_PROFILE_SEED_FILE_TOO_LARGE");
    const bytes = fs.readFileSync(sourcePath);
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) fail("INNER_PROFILE_SEED_HASH_MISMATCH");
    return { name: entry.name, bytes };
  });
}

export function seedInnerWorkerState(profile, stateRoot) {
  const records = initialStateRecords(profile);
  if (!records.length) return;
  const targetRoot = checkedRuntimePath(stateRoot);
  if (!withinRuntimeRoot(profile.stateRoot, targetRoot) || fs.existsSync(targetRoot)) fail("INNER_PROFILE_SEED_TARGET_REQUIRED");
  fs.mkdirSync(targetRoot);
  for (const entry of records) fs.writeFileSync(path.join(targetRoot, entry.name), entry.bytes, { flag: "wx" });
}

export function validateInnerRuntimeProfile(profile, { options, workerStateRoot, upstreamOrigin, host, runnerPath } = {}) {
  if (profile?.schemaVersion !== 1 || profile.mode !== "production") fail("INNER_PROFILE_PRODUCTION_REQUIRED");
  if (!identity(profile.ownerId) || !identity(profile.nativeSourceId)) fail("INNER_PROFILE_IDENTITY_REQUIRED");
  if (profile.workerLifecycle !== undefined && (!profile.workerLifecycle || typeof profile.workerLifecycle !== "object"
    || Array.isArray(profile.workerLifecycle) || Object.keys(profile.workerLifecycle).join(",") !== "recycleRetiredWorkers"
    || typeof profile.workerLifecycle.recycleRetiredWorkers !== "boolean")) fail("INNER_PROFILE_WORKER_LIFECYCLE_INVALID");
  const checkpointRoot = checkedRuntimePath(profile.checkpointRoot, { directory: true });
  const stateRoot = checkedRuntimePath(profile.stateRoot, { directory: true });
  const outerStateRoot = checkedRuntimePath(profile.outerStateRoot ?? profile.stateRoot, { directory: true });
  const codexHome = checkedRuntimePath(profile.codexHome, { directory: true });
  const installationRoot = checkedRuntimePath(profile.installationRoot, { directory: true });
  initialStateRecords(profile);
  if (new Set([checkpointRoot, stateRoot, codexHome]).size !== 3) fail("INNER_PROFILE_DISTINCT_ROOTS_REQUIRED");
  for (const [root, kind] of [[checkpointRoot, "checkpoint"], [stateRoot, "state"]]) {
    const owner = boundedJson(path.join(root, ".inner-runtime-owner.json"));
    if (owner.schemaVersion !== 1 || owner.ownerId !== profile.ownerId || owner.nativeSourceId !== profile.nativeSourceId
      || owner.kind !== kind) fail("INNER_PROFILE_ROOT_OWNER_MISMATCH");
  }
  const origin = validateRuntimeOrigin(profile.upstreamOrigin, profile.approvedUpstreamOrigin);
  if (upstreamOrigin !== undefined && upstreamOrigin !== origin) fail("INNER_PROFILE_ORIGIN_MISMATCH");
  if (host !== undefined && host !== "127.0.0.1") fail("INNER_PROFILE_HOST_MISMATCH");
  const initial = profile.initial;
  if (profile.activeCandidateId !== undefined) {
    if (options) fail("INNER_PROFILE_INITIAL_CANDIDATE_FORBIDDEN");
    const candidate = approvedInnerCandidate(profile, profile.activeCandidateId);
    if (!equalPath(candidate.installationRoot, installationRoot) || !equalPath(candidate.runnerPath, initial?.runnerPath ?? "")
      || Object.entries(candidate.expectedHashes).some(([key, value]) => initial?.expectedHashes?.[key] !== value)) {
      fail("COORDINATOR_UNVERIFIED_SOURCE");
    }
  }
  if (profile.approvedCandidates !== undefined) {
    if (!Array.isArray(profile.approvedCandidates)) fail("INNER_PROFILE_CANDIDATE_APPROVAL_INVALID");
    for (const entry of profile.approvedCandidates) approvedInnerCandidate(profile, entry.id);
  }
  if (initial?.port !== undefined && initial.port !== 0) fail("INNER_PROFILE_BACKEND_PORT_INVALID");
  const source = checkedRuntimePath(initial?.runnerPath, { existing: true });
  if (!equalPath(source, path.join(installationRoot, "src", "codex-model-stream-proxy-runner.mjs"))
    || Object.keys(initial?.expectedHashes ?? {}).sort().join(",") !== "control,core,helper,runner") fail("INNER_PROFILE_SOURCE_REQUIRED");
  for (const [key, name] of Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })) {
    const target = checkedRuntimePath(path.join(installationRoot, "src", name), { existing: true });
    if (!/^[0-9a-f]{64}$/u.test(initial.expectedHashes[key]) || digest(fs.readFileSync(target)) !== initial.expectedHashes[key]) {
      fail("INNER_PROFILE_SOURCE_HASH_MISMATCH");
    }
  }
  const ports = profile.ports;
  if (!ports || Object.keys(ports).sort().join(",") !== "control,downstream,inner,probe,upstream"
    || Object.values(ports).some(port => !Number.isInteger(port) || port < 1 || port > 65535)
    || new Set(Object.values(ports)).size !== 5 || profile.innerPort !== ports.inner) fail("INNER_PROFILE_PORTS_INVALID");
  if (workerStateRoot !== undefined) {
    const worker = checkedRuntimePath(workerStateRoot);
    if (!withinRuntimeRoot(stateRoot, worker)) fail("INNER_PROFILE_WORKER_STATE_ESCAPE");
  }
  const managedStatePath = checkedRuntimePath(profile.managedStatePath);
  if (!withinRuntimeRoot(stateRoot, managedStatePath)) fail("INNER_PROFILE_MANAGED_STATE_ESCAPE");
  if (runnerPath && !equalPath(checkedRuntimePath(runnerPath, { existing: true }),
    path.join(installationRoot, "src", "codex-app-server-proxy-runner.mjs"))) fail("INNER_PROFILE_OUTER_SOURCE_MISMATCH");
  if (options) {
    if (!identity(options.instanceToken)) fail("INNER_PROFILE_RUNTIME_INSTANCE_REQUIRED");
    if (!options.launchReceiptPath) fail("INNER_PROFILE_LAUNCH_PUBLICATION_REQUIRED");
    const launchReceiptPath = checkedRuntimePath(options.launchReceiptPath);
    const launchTempRoot = fs.realpathSync.native(checkedRuntimePath(os.tmpdir(), { directory: true }));
    const launchReceiptParent = fs.realpathSync.native(checkedRuntimePath(path.dirname(launchReceiptPath), { directory: true }));
    if (!withinRuntimeRoot(launchTempRoot, path.join(launchReceiptParent, path.basename(launchReceiptPath)))) fail("INNER_PROFILE_LAUNCH_TEMP_REQUIRED");
    checkedRuntimePath(`${options.launchReceiptPath}.ready`);
    for (const [name, value] of Object.entries(options)) {
      if (!(name.endsWith("Path") && name !== "executablePath" && name !== "innerManagedProfilePath")
        && !["displayPolicyRoot", "outerRuntimeRoot"].includes(name)) continue;
      if (name === "launchReceiptPath") continue;
      if (value === null) continue;
      const target = checkedRuntimePath(value);
      if (!withinRuntimeRoot(outerStateRoot, target) || !equalPath(target, profile.outerPaths?.[name] ?? "")) fail("INNER_PROFILE_OUTER_PATH_MISMATCH");
      if (equalPath(target, managedStatePath)) fail("INNER_PROFILE_STATE_COLLISION");
    }
    for (const name of ["downstream", "control", "upstream", "probe"]) {
      if (options[`${name}Port`] !== ports[name]) fail("INNER_PROFILE_OUTER_PORT_MISMATCH");
    }
    if (options.executablePath !== null && options.executablePath !== undefined) {
      checkedRuntimePath(options.executablePath, { existing: true });
    }
    if (fs.existsSync(options.stopFilePath)) fail("MANAGED_SESSION_STOP_REQUIREMENT_PRESENT");
    if (fs.existsSync(options.lockPath)) fail("INNER_PROFILE_EXISTING_LEASE");
    const token = checkedRuntimePath(options.tokenFilePath, { existing: true });
    const tokenBytes = fs.readFileSync(token);
    if (tokenBytes.length < 32 || tokenBytes.length > 4096 || tokenBytes.toString("utf8").trim().length < 32
      || digest(tokenBytes) !== profile.controlTokenSha256) fail("INNER_PROFILE_CONTROL_TOKEN_MISMATCH");
    if (fs.existsSync(options.runtimeStatePath)) {
      const previous = boundedJson(options.runtimeStatePath, undefined, INNER_RUNTIME_STATE_MAX_BYTES);
      if (previous.state !== "stopped" || previous.appServerPid) fail("INNER_PROFILE_OUTER_RUNTIME_UNRESOLVED");
    }
    if (fs.existsSync(managedStatePath)) {
      const previous = boundedJson(managedStatePath, undefined, INNER_RUNTIME_STATE_MAX_BYTES);
      if (previous.ownerId !== profile.ownerId || previous.nativeSourceId !== profile.nativeSourceId
        || previous.state !== "closed") fail("INNER_PROFILE_PREVIOUS_SESSION_UNRESOLVED");
      if (previous.instanceToken === options.instanceToken) fail("INNER_PROFILE_RETIRED_INSTANCE_REUSED");
    }
  }
  return Object.freeze({ ...profile, checkpointRoot, stateRoot, outerStateRoot, codexHome, installationRoot, managedStatePath,
    initial: { ...initial, runnerPath: source }, upstreamOrigin: origin });
}

export function readInnerRuntimeProfile(filePath, validation) {
  let profile = validateInnerRuntimeProfile(boundedJson(filePath, validation?.options?.innerManagedProfileSha256), validation);
  if (!withinRuntimeRoot(profile.stateRoot, checkedRuntimePath(filePath, { existing: true }))) fail("INNER_PROFILE_CONFIG_ESCAPE");
  const registry = readInnerCandidateRegistry(profile);
  if (registry) profile = validateInnerRuntimeProfile({ ...profile, approvedCandidates: registry.candidates }, validation);
  return profile;
}

export function innerCandidateRegistryPath(profile) {
  const root = checkedRuntimePath(profile.stateRoot, { directory: true });
  const owner = boundedJson(path.join(root, ".inner-runtime-owner.json"));
  if (owner.schemaVersion !== 1 || owner.kind !== "state" || owner.ownerId !== profile.ownerId
    || owner.nativeSourceId !== profile.nativeSourceId) fail("INNER_PROFILE_ROOT_OWNER_MISMATCH");
  return checkedRuntimePath(path.join(root, "inner-candidate-approvals.json"));
}

export function readInnerCandidateRegistry(profile) {
  const target = innerCandidateRegistryPath(profile);
  if (!fs.existsSync(target)) return null;
  const registry = boundedJson(target);
  if (!["candidates,nativeSourceId,ownerId,schemaVersion", "candidates,nativeSourceId,ownerId,schemaVersion,selection"].includes(Object.keys(registry).sort().join(","))
    || registry.schemaVersion !== 1 || registry.ownerId !== profile.ownerId
    || registry.nativeSourceId !== profile.nativeSourceId || !Array.isArray(registry.candidates)) {
    fail("INNER_PROFILE_CANDIDATE_REGISTRY_INVALID");
  }
  for (const candidate of registry.candidates) approvedInnerCandidate({ ...profile, approvedCandidates: registry.candidates }, candidate.id);
  if (registry.selection !== undefined && registry.selection !== null) {
    const selection = registry.selection;
    const candidate = registry.candidates.find(entry => entry.id === selection.candidateId);
    if (!candidate || Object.keys(selection).sort().join(",") !== "candidateId,compatibility,manifestPath,manifestSha256"
      || !equalPath(checkedRuntimePath(selection.manifestPath, { existing: true }), path.join(candidate.installationRoot, "src", "manifest.json"))) {
      fail("INNER_PROFILE_CANDIDATE_SELECTION_INVALID");
    }
    boundedJson(selection.manifestPath, selection.manifestSha256);
  }
  return { ...registry, sha256: digest(fs.readFileSync(target)) };
}

export function saveInnerCandidateRegistry(profile, candidates, expectedSha256, selection) {
  const target = innerCandidateRegistryPath(profile);
  const existing = readInnerCandidateRegistry(profile);
  if ((existing?.sha256 ?? null) !== expectedSha256) fail("INNER_PROFILE_CANDIDATE_REGISTRY_CHANGED");
  if (!Array.isArray(candidates) || candidates.length > 4) fail("INNER_PROFILE_CANDIDATE_APPROVAL_INVALID");
  for (const candidate of candidates) approvedInnerCandidate({ ...profile, approvedCandidates: candidates }, candidate.id);
  const retainedSelection = selection === undefined ? existing?.selection ?? null : selection;
  if (retainedSelection !== null && !candidates.some(candidate => candidate.id === retainedSelection.candidateId)) {
    fail("INNER_PROFILE_CANDIDATE_SELECTION_INVALID");
  }
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, ownerId: profile.ownerId,
    nativeSourceId: profile.nativeSourceId, candidates, selection: retainedSelection }));
  if (bytes.length > 65536) fail("INNER_PROFILE_FILE_TOO_LARGE");
  const pending = checkedRuntimePath(`${target}.${crypto.randomUUID()}.pending`);
  let handle;
  try {
    handle = fs.openSync(pending, "wx", 0o600);
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    if ((readInnerCandidateRegistry(profile)?.sha256 ?? null) !== expectedSha256) fail("INNER_PROFILE_CANDIDATE_REGISTRY_CHANGED");
    fs.renameSync(pending, target);
  } finally {
    if (handle !== null && handle !== undefined) fs.closeSync(handle);
    if (fs.existsSync(pending)) fs.unlinkSync(pending);
  }
  return digest(bytes);
}
