import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const fail = code => { throw new Error(code); };
const readJson = filename => JSON.parse(fs.readFileSync(filename, "utf8").replace(/^\uFEFF/u, ""));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function pinned(filename, expected) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || !/^[a-f0-9]{64}$/u.test(expected)
    || digest(fs.readFileSync(filename)) !== expected) fail("PIN_CHANGED:" + filename);
}
function samePath(left, right) { return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }
function under(root, child) {
  const relative = path.relative(fs.realpathSync(root), path.resolve(child));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}
export async function inspectOwnerInput(inputPath, inputSha256, restoreOnly = false) {
  pinned(inputPath, inputSha256);
  const input = readJson(inputPath);
  if (input.schemaVersion !== 1 || !["development", "training", "fixture"].includes(input.machine)
    || !/^[a-zA-Z0-9_-]{1,80}$/u.test(input.candidateId)) fail("INPUT_INVALID");
  if (input.expectedRegistrySha256 != null && !/^[a-f0-9]{64}$/u.test(input.expectedRegistrySha256)) fail("REGISTRY_BASELINE_INVALID");
  if (input.expectedRevision != null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)) fail("REVISION_BASELINE_INVALID");
  if (!restoreOnly) for (const pin of input.pins) pinned(pin.path, pin.sha256);
  if (!input.pins.some(pin => samePath(pin.path, input.profilePath))
    || !input.pins.some(pin => samePath(pin.path, input.builderPath))
    || !input.pins.some(pin => samePath(pin.path, input.compilerPath))
    || !input.pins.some(pin => samePath(pin.path, input.sourceManifestPath))) fail("INPUT_PINS_INCOMPLETE");
  const profile = restoreOnly ? {} : readJson(input.profilePath);
  const sourceManifest = restoreOnly ? { files: [] } : readJson(input.sourceManifestPath);
  if (!restoreOnly && (!Array.isArray(sourceManifest.files) || sourceManifest.files.length !== 48)) fail("SOURCE_MANIFEST_INVALID");
  for (const source of sourceManifest.files) {
    if (!/^[a-zA-Z0-9_.-]+$/u.test(source.path)) fail("SOURCE_NAME_INVALID");
    pinned(path.join(path.dirname(input.sourceManifestPath), source.path), source.sha256);
  }
  if (!restoreOnly) {
    if (input.installedManifestPath && !input.pins.some(pin => samePath(pin.path, input.installedManifestPath))) fail("INSTALLED_BASELINE_PIN_MISSING");
    const installedManifest = input.installedManifestPath ? readJson(input.installedManifestPath) : sourceManifest;
    if (!Array.isArray(installedManifest.files) || installedManifest.files.length !== 48
      || JSON.stringify(installedManifest.files.map(file => file.path).sort()) !== JSON.stringify(sourceManifest.files.map(file => file.path).sort())) fail("INSTALLED_BASELINE_INVALID");
    for (const source of installedManifest.files) {
      if (source.path !== "proxy.cjs") pinned(path.join(profile.installationRoot, "src", source.path), source.sha256);
    }
  }
  if (!restoreOnly && (!under(input.candidateRoot, input.installationRoot)
    || !samePath(path.dirname(input.installationRoot), input.candidateRoot))) fail("CANDIDATE_ROOT_INVALID");
  const control = new URL(input.controlUrl);
  if (control.protocol !== "http:" || control.hostname !== "127.0.0.1" || control.pathname !== "/"
    || control.search || control.hash || control.username || control.password) fail("CONTROL_LOOPBACK_REQUIRED");
  const token = fs.readFileSync(input.tokenPath, "utf8").trim();
  const request = async (method, body) => {
    const response = await fetch(`${input.controlUrl}/v1/full-runtime${method ? "/" + method : ""}`, {
      method: method ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(method ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000), redirect: "error",
    });
    const value = await response.json();
    if (!response.ok || value.ok !== true) fail(value.error?.code ?? `HTTP_${response.status}`);
    return value;
  };
  const verifyInstance = () => {
    const runtime = readJson(input.runtimePath);
    if (runtime.pid !== input.parentPid || runtime.instanceToken !== input.instanceId || runtime.appServerPid !== input.appServerPid
      || runtime.state !== "running" || runtime.controlUrl !== input.controlUrl) fail("RUNNING_INSTANCE_CHANGED");
  };
  verifyInstance();
  const status = await request();
  if (status.instanceId !== input.instanceId || status.busy || status.failed || status.participants?.length !== 5) fail("RUNTIME_NOT_READY");
  return { input, profile, sourceManifest, request, verifyInstance, status };
}

export async function executeOwnerAcceptance(inputPath, inputSha256, action, confirm, emit = console.log, options = {}) {
  if (!["Inspect", "Run", "Apply", "Restore"].includes(action)) fail("ACTION_INVALID");
  const context = await inspectOwnerInput(inputPath, inputSha256, action === "Restore");
  const { input, profile, sourceManifest, request, verifyInstance, status: before } = context;
  const baselineRevision = input.expectedRevision ?? 0;
  const baselineSelection = input.expectedSelection ?? { id: "original", manifestSha256: null };
  if (typeof baselineSelection.id !== "string" || !baselineSelection.id
    || (baselineSelection.id === "original" ? baselineSelection.manifestSha256 != null
      : !/^[a-f0-9]{64}$/u.test(baselineSelection.manifestSha256))) fail("SELECTION_BASELINE_INVALID");
  const isBaselineSelection = selection => selection?.id === baselineSelection.id
    && (selection.manifestSha256 ?? null) === (baselineSelection.manifestSha256 ?? null);
  const confirmAction = async (prompt, expected) => {
    if (options.nonInteractive === true) return;
    if (await confirm(prompt) !== expected) fail("OWNER_CANCELLED");
  };
  let eventsPath = path.join(path.dirname(inputPath), "acceptance-events.jsonl");
  const evidenceWarnings = [];
  const record = (phase, value) => {
    try {
      fs.appendFileSync(eventsPath, JSON.stringify({ at: new Date().toISOString(), inputSha256, phase, value }) + "\n");
    } catch (error) {
      const originalPath = eventsPath;
      eventsPath = path.join(path.dirname(inputPath), `continued-events-${crypto.randomUUID()}.jsonl`);
      evidenceWarnings.push({ phase, originalPath, continuedPath: eventsPath, error: error.message });
      throw error;
    }
  };
  const observe = (phase, value) => {
    try { record(phase, typeof value === "function" ? value() : value); }
    catch (error) { evidenceWarnings.push({ phase, error: error.message }); }
  };
  const snapshot = () => {
    const runtime = readJson(input.runtimePath);
    const managed = profile.managedStatePath ? readJson(profile.managedStatePath) : null;
    return { runtime: { pid: runtime.pid, instanceToken: runtime.instanceToken, appServerPid: runtime.appServerPid,
      state: runtime.state, updatedAt: runtime.updatedAt, proxy: runtime.proxy }, managed };
  };
  const binding = status => ({ instanceId: input.instanceId, expectedRevision: status.revision });
  const ensureBaseline = () => {
    if (before.revision !== baselineRevision || !isBaselineSelection(before.selected) || before.candidateRegistrySha256 !== (input.expectedRegistrySha256 ?? null)
      || before.prepared?.length || before.preparedWorkers?.length) fail("BASELINE_CHANGED");
  };
  if (action === "Inspect") {
    ensureBaseline();
    return { status: "READY_NOT_EXECUTED", machine: input.machine, parentPid: input.parentPid, revision: before.revision, sourceFiles: 47 };
  }
  if (action === "Restore") {
    if (!fs.existsSync(eventsPath)) fail("RESTORE_RECORD_MISSING");
    const originalText = fs.readFileSync(eventsPath, "utf8");
    const lines = originalText.split(/\r?\n/u);
    const records = [];
    let incompleteTail = false;
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index] && index === lines.length - 1) continue;
      try { records.push(JSON.parse(lines[index])); }
      catch (error) {
        if (index !== lines.length - 1 || originalText.endsWith("\n")) throw error;
        incompleteTail = true;
      }
    }
    if (records.some(entry => entry.inputSha256 !== inputSha256)) fail("RESTORE_RECORD_IDENTITY_CHANGED");
    const candidates = records.filter(entry => entry.phase === "candidate");
    const prepared = candidates.length === 1 ? candidates[0] : null;
    if (!prepared || before.selected?.manifestSha256 !== prepared.value.manifestSha256 || before.revision !== baselineRevision + 1) fail("RESTORE_SELECTION_CHANGED");
    await confirmAction("Type RESTORE-SAME-RUNTIME: ", "RESTORE-SAME-RUNTIME");
    if (incompleteTail) {
      const originalPath = eventsPath;
      eventsPath = path.join(path.dirname(inputPath), `restore-events-${crypto.randomUUID()}.jsonl`);
      observe("incomplete_original_preserved", { originalPath, sha256: digest(Buffer.from(originalText)) });
    }
    verifyInstance();
    observe("restore_requested", binding(before));
    const restored = await request("restore", binding(before));
    observe("restored", restored);
    if (restored.revision !== baselineRevision + 2 || !isBaselineSelection(restored.selected) || restored.failed || restored.busy) fail("RESTORE_NOT_CONFIRMED");
    verifyInstance();
    return { status: baselineSelection.id === "original" ? "RESTORED_ORIGINAL" : "RESTORED_PREVIOUS", revision: restored.revision, parentPid: input.parentPid, eventsPath, evidenceWarnings };
  }
  ensureBaseline();
  if (fs.existsSync(eventsPath) || fs.existsSync(input.installationRoot)) fail("ATTEMPT_ALREADY_EXISTS_PRESERVE");
  await confirmAction("Keep both Codex windows OPEN. Type TEST-HOT-SWITCH: ", "TEST-HOT-SWITCH");
  verifyInstance();
  fs.writeFileSync(eventsPath, JSON.stringify({ at: new Date().toISOString(), inputSha256, phase: "started", value: before }) + "\n", { flag: "wx" });
  record("before_snapshot", snapshot());
  let phase = "candidate_build";
  try {
    const require = createRequire(import.meta.url);
    const compiler = require(input.compilerPath);
    if (compiler.version !== "0.28.2") fail("COMPILER_VERSION_CHANGED");
    const { buildProxyParentLiveBundle } = await import(pathToFileURL(input.builderPath).href);
    fs.mkdirSync(input.installationRoot);
    const built = await buildProxyParentLiveBundle({ sourceRoot: path.dirname(input.sourceManifestPath),
      destinationRoot: path.join(input.installationRoot, "src"), version: input.candidateId, compiler });
    fs.writeFileSync(path.join(input.installationRoot, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1,
      kind: "candidate", ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId }), { flag: "wx" });
    const hashes = Object.fromEntries(Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
      helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })
      .map(([key, name]) => [key, sourceManifest.files.find(file => file.path === name)?.sha256]));
    const unchanged = input.installedManifestPath ? ["core", "helper"] : Object.keys(hashes);
    let compatibility;
    if (input.compatibility) {
      const { fixedHandoffCompatibility } = await import(pathToFileURL(path.join(path.dirname(input.sourceManifestPath), "inner-handoff-compatibility.mjs")));
      compatibility = fixedHandoffCompatibility(input.compatibility);
      const sources = [profile.initial.expectedHashes, before.modelWorker?.sourceHashes ?? profile.initial.expectedHashes];
      for (const source of sources) {
        if (source.core === hashes.core && source.helper === hashes.helper) continue;
        if (!compatibility.manifest.edges.some(edge => edge.source.core === source.core && edge.source.helper === source.helper
          && edge.target.core === hashes.core && edge.target.helper === hashes.helper)) fail("WORKER_COMPATIBILITY_EDGE_MISSING");
      }
    } else if (unchanged.some(key => hashes[key] !== profile.initial.expectedHashes[key])) fail("WORKER_BASELINE_CHANGED");
    record("candidate", built);
    const candidate = { id: input.candidateId, installationRoot: input.installationRoot,
      runnerPath: path.join(input.installationRoot, "src", "codex-model-stream-proxy-runner.mjs"), expectedHashes: hashes };
    phase = "register";
    verifyInstance();
    record("register_requested", { ...built, candidate });
    const registered = await request("register", { ...binding(before), expectedRegistrySha256: input.expectedRegistrySha256 ?? null,
      manifestPath: built.manifestPath, manifestSha256: built.manifestSha256, candidate });
    record("registered", registered);
    phase = "prepare";
    const prepared = await request("prepare", { ...binding(registered), manifestPath: built.manifestPath,
      manifestSha256: built.manifestSha256, workerCandidateId: candidate.id, ...(compatibility ? { compatibility } : {}) });
    record("prepared", prepared);
    emit(options.nonInteractive === true ? "CANDIDATE_READY. Continuing non-interactively." : "CANDIDATE_READY. Send READY in this Codex conversation, then type ACTIVATE here. Do not close Codex.");
    await confirmAction("Type ACTIVATE: ", "ACTIVATE");
    phase = "activate";
    verifyInstance();
    const current = await request();
    if (current.revision !== baselineRevision || current.instanceId !== input.instanceId || current.failed || current.busy) fail("PRE_ACTIVATE_STATE_CHANGED");
    record("activate_requested", { ...binding(current), preparationId: prepared.id });
    const activated = await request("activate", { ...binding(current), preparationId: prepared.id });
    if (activated.selected?.manifestSha256 !== built.manifestSha256 || activated.revision !== baselineRevision + 1 || activated.failed || activated.busy) fail("ACTIVATION_NOT_CONFIRMED");
    observe("activated", activated);
    if (profile.stateRoot) observe("activated_registry", () => {
      const registryPath = path.join(profile.stateRoot, "inner-candidate-approvals.json");
      const bytes = fs.readFileSync(registryPath);
      const registry = JSON.parse(bytes.toString("utf8"));
      if (registry.selection?.candidateId !== input.candidateId || registry.selection?.manifestSha256 !== built.manifestSha256) fail("ACTIVATED_REGISTRY_CHANGED");
      return { registryPath, registrySha256: digest(bytes), candidateId: input.candidateId, manifestSha256: built.manifestSha256 };
    });
    observe("activated_snapshot", snapshot);
    if (action === "Apply") return { status: "HOT_SWITCH_APPLIED", machine: input.machine, revision: activated.revision,
      parentPid: input.parentPid, appServerPid: input.appServerPid, eventsPath, evidenceWarnings };
    emit("HOT_SWITCHED. Keeping the new implementation for 60 seconds, then restoring the original implementation.");
    await delay(input.machine === "fixture" ? 1 : 60000);
    phase = "restore";
    verifyInstance();
    const selected = await request();
    if (selected.revision !== baselineRevision + 1 || selected.selected?.manifestSha256 !== built.manifestSha256 || selected.failed || selected.busy) fail("PRE_RESTORE_STATE_CHANGED");
    observe("restore_requested", binding(selected));
    const restored = await request("restore", binding(selected));
    observe("restored", restored);
    if (restored.revision !== baselineRevision + 2 || !isBaselineSelection(restored.selected) || restored.failed || restored.busy) fail("RESTORE_NOT_CONFIRMED");
    verifyInstance();
    observe("restored_snapshot", snapshot);
    return { status: "HOT_SWITCH_AND_RESTORE_PASSED", machine: input.machine, revision: restored.revision,
      parentPid: input.parentPid, appServerPid: input.appServerPid, eventsPath, evidenceWarnings, conversationContinuity: "REQUIRES_MAIN_THREAD_EVIDENCE" };
  } catch (error) {
    let actual;
    try { actual = await request(); } catch (statusError) { actual = { statusError: statusError.message }; }
    observe("failed_preserved", { phase, error: error.message, actual });
    emit(JSON.stringify({ status: "FAILED_PRESERVED", phase, error: error.message, actual, eventsPath, retryAllowed: false }));
    throw error;
  }
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  const [, , inputPath, inputSha256, action = "Inspect", ...flags] = process.argv;
  const nonInteractive = flags.includes("--non-interactive");
  const terminal = nonInteractive ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (flags.some(flag => flag !== "--non-interactive")) fail("ARGUMENT_INVALID");
    const result = await executeOwnerAcceptance(inputPath, inputSha256, action, prompt => terminal.question(prompt), console.log, { nonInteractive });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { terminal?.close(); }
}
