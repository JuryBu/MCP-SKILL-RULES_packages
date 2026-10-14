import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { repairDesktopLauncher } from "./build-startup-repair.mjs";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = code => { throw new Error(code); };
const workerNames = { runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
  helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" };
const startupFiles = ["src/control-plane.mjs", "src/codex-thread-bridge.mjs", "src/codex-app-server-proxy-runner.mjs",
  "src/windows-powershell-environment.mjs", "src/codex-runtime-bundle.mjs", "src/inner-startup-residual-recovery.mjs",
  "ops/start-codex-app-server-proxy.ps1", "ops/start-codex-model-stream-proxy.ps1", "ops/get-codex-model-stream-proxy-status.ps1",
  "ops/resolve-codex-outer-runtime-startup.ps1", "ops/recover-inner-startup.mjs", "ops/Run-NapCatSupervisorWatchdog.ps1"];
const plainFile = filename => {
  const resolved = path.resolve(filename);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync.native(resolved) !== resolved) fail("FULL_SOURCE_NOT_PLAIN");
  return resolved;
};
const json = filename => JSON.parse(fs.readFileSync(plainFile(filename), "utf8").replace(/^\uFEFF/u, ""));

export function readPinnedRuntimeDependency(pin) {
  if (!/^[a-f0-9]{64}$/u.test(pin?.sha256 ?? "")) fail("FULL_QQ_DEPENDENCY_PIN_INVALID");
  const resolved = path.resolve(pin.path);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync.native(resolved) !== resolved
    || (stat.nlink !== 1 && path.extname(resolved).toLowerCase() !== ".exe")) fail("FULL_QQ_DEPENDENCY_NOT_PLAIN");
  const bytes = fs.readFileSync(resolved);
  if (digest(bytes) !== pin.sha256) fail("FULL_QQ_POST_INSTALL_PIN_CHANGED");
  return bytes;
}

export function buildFullUpgradePayload({ sourceRoot, installedRoot, desktopLauncherPath, outputRoot,
  runtimeManifestPath, runtimeManifestSha256, innerProfilePath, outerStartupPath,
  qqCanonicalManifestPath, qqCanonicalManifestSha256, qqStateRoot }) {
  const installation = fs.realpathSync.native(installedRoot);
  const output = path.resolve(outputRoot);
  if (output === installation || output.startsWith(`${installation}${path.sep}`) || fs.existsSync(output)) fail("FULL_OUTPUT_MUST_BE_NEW");
  const manifestBytes = fs.readFileSync(plainFile(runtimeManifestPath));
  if (!/^[a-f0-9]{64}$/u.test(runtimeManifestSha256 ?? "") || digest(manifestBytes) !== runtimeManifestSha256) fail("FULL_RUNTIME_MANIFEST_CHANGED");
  const runtime = JSON.parse(manifestBytes);
  if (runtime.schemaVersion !== 1 || runtime.format !== "commonjs-bundle" || runtime.entry !== "proxy.cjs"
    || runtime.stateSchema !== "proxy-live-state-v1" || !Array.isArray(runtime.files) || runtime.files.length > 128) fail("FULL_RUNTIME_MANIFEST_INVALID");
  const seen = new Set();
  const candidateBytes = new Map();
  for (const entry of runtime.files) {
    if (!/^(?:[a-zA-Z0-9_-]+\.mjs|proxy\.cjs)$/u.test(entry.path ?? "") || seen.has(entry.path)
      || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "")) fail("FULL_RUNTIME_FILE_INVALID");
    seen.add(entry.path);
    const bundled = fs.readFileSync(plainFile(path.join(path.dirname(runtimeManifestPath), entry.path)));
    if (digest(bundled) !== entry.sha256) fail("FULL_RUNTIME_FILE_CHANGED");
    if (entry.path === "proxy.cjs") continue;
    const source = fs.readFileSync(plainFile(path.join(sourceRoot, "src", entry.path)));
    if (!source.equals(bundled)) fail("FULL_UNIQUE_SOURCE_CHANGED");
    candidateBytes.set(`src/${entry.path}`, source);
  }
  for (const required of ["proxy-live-parent-entry.mjs", "proxy-whole-runtime-control.mjs", "request-body-inspector-worker.mjs", ...Object.values(workerNames)]) {
    if (!seen.has(required)) fail("FULL_RUNTIME_DEPENDENCY_MISSING");
  }
  for (const filename of startupFiles) candidateBytes.set(filename, fs.readFileSync(plainFile(path.join(sourceRoot, filename))));
  const profile = json(innerProfilePath);
  const startup = json(outerStartupPath);
  if (profile.schemaVersion !== 1 || profile.mode !== "production" || profile.activeCandidateId !== undefined
    || path.resolve(profile.installationRoot) !== installation || path.resolve(profile.initial?.runnerPath ?? "") !== path.join(installation, "src", workerNames.runner)
    || startup.schemaVersion !== 1 || path.resolve(startup.innerManagedProfilePath ?? "") !== path.resolve(innerProfilePath)
    || startup.innerManagedProfileSha256 !== digest(fs.readFileSync(innerProfilePath))) fail("FULL_PROFILE_BASELINE_INVALID");
  const hashes = {};
  for (const [key, filename] of Object.entries(workerNames)) {
    if (profile.initial.expectedHashes?.[key] !== digest(fs.readFileSync(plainFile(path.join(installation, "src", filename))))) fail("FULL_WORKER_BASELINE_CHANGED");
    hashes[key] = digest(candidateBytes.get(`src/${filename}`));
  }
  const newProfile = Buffer.from(JSON.stringify({ ...profile, initial: { ...profile.initial, expectedHashes: hashes } }, null, 2));
  const newStartup = Buffer.from(JSON.stringify({ ...startup, innerManagedProfileSha256: digest(newProfile) }, null, 2));
  const qqFiles = [];
  let taskUpgrade = null;
  if (qqCanonicalManifestPath) {
    const canonicalBytes = fs.readFileSync(plainFile(qqCanonicalManifestPath));
    if (digest(canonicalBytes) !== qqCanonicalManifestSha256 || !qqStateRoot) fail("FULL_QQ_CANONICAL_BINDING_CHANGED");
    const canonical = JSON.parse(canonicalBytes.toString("utf8").replace(/^\uFEFF/u, ""));
    if (canonical.schemaVersion !== 1 || canonical.kind !== "PrivateCanonicalReadonlyInputNotInstallable"
      || canonical.qq5Mappings?.length !== 5 || canonical.task?.name !== "CodexNapCatSupervisor") fail("FULL_QQ_CANONICAL_INVALID");
    const inputRoot = path.dirname(path.resolve(qqCanonicalManifestPath));
    const readInput = entry => {
      if (!entry || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/u).some(part => part === ".." || part === ".")) fail("FULL_QQ_INPUT_ESCAPE");
      const bytes = fs.readFileSync(plainFile(path.join(inputRoot, entry.path)));
      if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) fail("FULL_QQ_INPUT_CHANGED");
      return bytes;
    };
    for (const entry of canonical.files ?? []) readInput(entry);
    const allowedTargets = { login: path.join(installation, "ops", "start-napcat-login.ps1"),
      recovery: path.join(installation, "ops", "start-napcat-account-recovery.ps1"),
      wrapper: path.join(installation, "ops", "Start-QqThenExistingWatchdog.ps1"),
      deployment: path.join(path.resolve(qqStateRoot), "deployment.json"), plan: path.join(path.resolve(qqStateRoot), "startup-ps7.json") };
    const targetBytes = new Map([...candidateBytes].map(([filename, bytes]) => [path.join(installation, filename).toLowerCase(), bytes]));
    const mappingNames = new Set();
    for (const mapping of canonical.qq5Mappings) {
      if (!allowedTargets[mapping.name] || mappingNames.has(mapping.name)
        || path.resolve(mapping.target) !== allowedTargets[mapping.name]) fail("FULL_QQ_TARGET_CHANGED");
      mappingNames.add(mapping.name);
      const current = fs.existsSync(mapping.target) ? fs.readFileSync(plainFile(mapping.target)) : null;
      if (Boolean(current) !== mapping.originalExists || (current ? digest(current) : null) !== mapping.originalSha256) fail("FULL_QQ_BASELINE_CHANGED");
      if (current && !current.equals(readInput(mapping.original))) fail("FULL_QQ_ORIGINAL_CHANGED");
      let bytes = readInput(mapping.candidate);
      if (mapping.name === "wrapper") bytes = fs.readFileSync(plainFile(path.join(sourceRoot, "ops", "Start-QqThenExistingWatchdog.ps1")));
      qqFiles.push({ name: `qq-startup/${mapping.name}`, targetPath: mapping.target, bytes,
        provenance: { kind: mapping.name === "wrapper" ? "unique_source_qq_wrapper" : "private_qq_canonical_input",
          sourceSha256: mapping.name === "wrapper" ? digest(bytes) : null,
          canonicalCandidateSha256: mapping.candidate.sha256, canonicalManifestSha256: qqCanonicalManifestSha256,
          originalSddl: mapping.originalSddl } });
      targetBytes.set(path.resolve(mapping.target).toLowerCase(), bytes);
    }
    const watchdog = canonical.sharedWatchdogTransition;
    if (path.resolve(watchdog.target) !== path.join(installation, "ops", "Run-NapCatSupervisorWatchdog.ps1")
      || digest(fs.readFileSync(plainFile(watchdog.target))) !== watchdog.baselineSha256
      || digest(targetBytes.get(path.resolve(watchdog.target).toLowerCase())) !== watchdog.candidateSha256) fail("FULL_QQ_WATCHDOG_PHASE_CHANGED");
    const planFile = qqFiles.find(entry => entry.name === "qq-startup/plan");
    const plan = JSON.parse(planFile.bytes.toString("utf8").replace(/^\uFEFF/u, ""));
    if (plan.schema !== "qq.fixed-ps7-startup/v1" || plan.state !== "active" || !Array.isArray(plan.inputs)) fail("FULL_QQ_PLAN_INVALID");
    const wrapperPin = plan.inputs.find(pin => path.resolve(pin.path) === allowedTargets.wrapper);
    if (!wrapperPin) fail("FULL_QQ_WRAPPER_PIN_REQUIRED");
    wrapperPin.sha256 = digest(targetBytes.get(allowedTargets.wrapper.toLowerCase()));
    planFile.bytes = Buffer.from(JSON.stringify(plan, null, 2));
    planFile.provenance.kind = "private_qq_plan_source_wrapper_pin_only";
    for (const pin of plan.inputs) {
      const bytes = targetBytes.get(path.resolve(pin.path).toLowerCase()) ?? readPinnedRuntimeDependency(pin);
      if (digest(bytes) !== pin.sha256) fail("FULL_QQ_POST_INSTALL_PIN_CHANGED");
    }
    readInput(canonical.task.originalXml);
    readInput(canonical.task.proposedXml);
    taskUpgrade = { taskName: canonical.task.name,
      originalXmlPath: path.join(inputRoot, canonical.task.originalXml.path), originalXmlSha256: canonical.task.originalXml.sha256,
      candidateXmlPath: path.join(inputRoot, canonical.task.proposedXml.path), candidateXmlSha256: canonical.task.proposedXml.sha256,
      originalTaskFileSddl: canonical.task.liveReadonly.sddl, postInstallPins: plan.inputs,
      deriveCandidateAction: true,
      canonicalManifestSha256: qqCanonicalManifestSha256,
      action: { execute: plan.ps7Path,
        arguments: `-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "${allowedTargets.wrapper}" -PlanPath "${allowedTargets.plan}" -PlanSha256 ${digest(qqFiles.find(entry => entry.name === "qq-startup/plan").bytes)}`,
        workingDirectory: installation } };
  } else if (qqCanonicalManifestSha256 || qqStateRoot) fail("FULL_QQ_CANONICAL_REQUIRED");
  fs.mkdirSync(output, { recursive: true });
  const files = [];
  const save = (name, targetPath, bytes, provenance) => {
    const original = fs.existsSync(targetPath) ? fs.readFileSync(plainFile(targetPath)) : null;
    if (original?.equals(bytes)) return;
    const payloadPath = path.join(output, `${files.length}.bin`);
    fs.writeFileSync(payloadPath, bytes, { flag: "wx" });
    files.push({ name, targetPath: path.resolve(targetPath), payloadPath, candidateSha256: digest(bytes),
      beforeSha256: original ? digest(original) : null, provenance });
  };
  for (const [filename, bytes] of candidateBytes) save(filename, path.join(installation, filename), bytes,
    { kind: "unique_source", sourceSha256: digest(bytes), runtimeManifestSha256 });
  const privateName = filename => {
    const relative = path.relative(installation, path.resolve(filename));
    return relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? `private-runtime/${path.basename(filename)}` : relative.replaceAll(path.sep, "/");
  };
  save(privateName(innerProfilePath), innerProfilePath, newProfile, { kind: "worker_source_pins_only", expectedHashes: hashes });
  save(privateName(outerStartupPath), outerStartupPath, newStartup, { kind: "inner_profile_hash_only", innerManagedProfileSha256: digest(newProfile) });
  for (const entry of qqFiles) save(entry.name, entry.targetPath, entry.bytes, entry.provenance);
  if (desktopLauncherPath) {
    const original = fs.readFileSync(plainFile(desktopLauncherPath));
    const normalized = original.toString("utf8").replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
    const repaired = repairDesktopLauncher(normalized);
    if (repaired !== normalized) save("desktop-launcher.ps1", desktopLauncherPath, Buffer.from(`\uFEFF${repaired}`), { kind: "remove_legacy_recovery_only" });
  }
  const payloadPath = path.join(output, "payload.json");
  fs.writeFileSync(payloadPath, JSON.stringify({ schemaVersion: 1, targetRoot: installation, files,
    scope: "full-runtime-and-startup", fullHotUpgradeIncluded: true, runtimeManifestSha256, expectedHashes: hashes,
    productionActions: 0, sourceFiles: candidateBytes.size, taskUpgrade }, null, 2), { flag: "wx" });
  return { payloadPath, fileCount: files.length, productionActions: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceRoot, installedRoot, desktopLauncherPath, outputRoot, runtimeManifestPath, runtimeManifestSha256, innerProfilePath, outerStartupPath,
    qqCanonicalManifestPath, qqCanonicalManifestSha256, qqStateRoot] = process.argv.slice(2);
  console.log(JSON.stringify(buildFullUpgradePayload({ sourceRoot, installedRoot, desktopLauncherPath: desktopLauncherPath === "-" ? null : desktopLauncherPath,
    outputRoot, runtimeManifestPath, runtimeManifestSha256, innerProfilePath, outerStartupPath,
    qqCanonicalManifestPath, qqCanonicalManifestSha256, qqStateRoot })));
}
