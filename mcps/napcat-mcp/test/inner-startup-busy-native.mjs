import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { repairDesktopLauncher } from "../ops/build-startup-repair.mjs";
import { inspectStartupRecoveryHost } from "../src/inner-startup-residual-recovery.mjs";

const [codexPath, launcherPath, evidencePath] = process.argv.slice(2);
if (![codexPath, evidencePath].every(value => value && path.isAbsolute(value))
  || (launcherPath !== "-" && !path.isAbsolute(launcherPath ?? ""))) throw new Error("ABSOLUTE_INPUTS_REQUIRED");
const repository = fileURLToPath(new URL("../", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-busy-native-"));
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const read = target => JSON.parse(fs.readFileSync(target, "utf8").replace(/^\uFEFF/u, ""));
const write = (target, value) => fs.writeFileSync(target, JSON.stringify(value));
const result = { root, startedAt: new Date().toISOString(), productionModified: false, paidModelCalls: false, operations: [] };
const powershell = process.env.NAPCAT_TEST_POWERSHELL ?? path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
let profile;
let socket;
let upstream;
let requestCount = 0;
let newInstance;
let originalInstance;
let clean = false;
async function until(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const actual = await predicate();
    if (actual) return actual;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`TIMEOUT:${label}`);
}
const environment = { ...process.env, CODEX_TOOLKIT_NODE_EXE: process.execPath,
  HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" };
for (const name of Object.keys(environment)) if (/^(OPENAI|ANTHROPIC|GEMINI|MODEL_OBSERVER|AZURE_OPENAI)_/u.test(name)) delete environment[name];
async function execute(entry, args) {
  const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", entry, ...args],
    { cwd: root, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes.toString(); });
  child.stderr.on("data", bytes => { stderr += bytes.toString(); });
  const [exitCode] = await once(child, "exit");
  result.operations.push({ entry, args, exitCode, stdout, stderr });
  assert.equal(exitCode, 0, stderr + stdout);
  return JSON.parse(stdout.replace(/^\uFEFF/u, ""));
}
try {
  const generated = spawnSync(process.execPath, [path.join(repository, "test/inner-startup-residual-native.mjs"), root, "history"],
    { encoding: "utf8", windowsHide: true, timeout: 25000, env: environment });
  assert.equal(generated.status, 0, generated.stderr);
  const input = read(path.join(root, "native-evidence.json"));
  const oldPids = [input.parentPid, input.appServerPid, ...input.workers];
  await until(() => {
    const observed = inspectStartupRecoveryHost();
    result.residualProcessInventory = observed.processes.filter(entry => oldPids.includes(entry.ProcessId) || oldPids.includes(entry.ParentProcessId));
    return result.residualProcessInventory.length === 0;
  }, "fixture-process-tree-exited");
  profile = read(input.profilePath);
  upstream = http.createServer((_request, response) => { requestCount += 1; response.writeHead(503); response.end("OWNED_TEST_UNEXPECTED_REQUEST"); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  profile.upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  profile.outerPaths.outerRuntimeRoot = path.join(root, "state", "outer-candidates");
  fs.mkdirSync(profile.outerPaths.outerRuntimeRoot);
  environment.CODEX_HOME = profile.codexHome;
  fs.writeFileSync(path.join(profile.codexHome, "config.toml"), `model = "gpt-6-luna"\nmodel_provider = "isolated"\n[model_providers.isolated]\nname = "isolated"\nbase_url = "http://127.0.0.1:${profile.innerPort}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`);
  write(input.profilePath, profile);
  const configuration = read(input.configurationPath);
  configuration.enabled = true;
  configuration.candidateRoot = profile.outerPaths.outerRuntimeRoot;
  configuration.innerManagedProfileSha256 = hash(fs.readFileSync(input.profilePath));
  write(input.configurationPath, configuration);
  const managed = read(profile.managedStatePath);
  managed.coordinator.activeHttp = 9;
  managed.coordinator.threads.find(thread => thread.phase === "active").activeHttp = 9;
  write(profile.managedStatePath, managed);
  const outer = read(profile.outerPaths.runtimeStatePath);
  originalInstance = outer.instanceToken;
  outer.lastKnownGoodExecutablePath = codexPath;
  outer.executablePath = codexPath;
  outer.proxy.outerRuntime.trackedRequestCount = 10;
  outer.proxy.outerRuntime.pendingToolCount = 2;
  outer.proxy.outerRuntime.activeOperationCount = 1;
  outer.proxy.journal.wakeCount = 2;
  outer.proxy.journal.unknownWakeCount = 1;
  write(profile.outerPaths.runtimeStatePath, outer);
  write(profile.outerPaths.journalPath, { schemaVersion: 2, subscriptions: {}, wakes: {
    "owned-unknown": { status: "unknown", outcomeUnknown: true }, "owned-completed": { status: "completed" },
  } });
  const workerFiles = [];
  for (const worker of managed.coordinator.workers) {
    const target = path.join(profile.stateRoot, worker.workerId, "codex-model-stream-proxy-runtime.json");
    const runtime = read(target);
    runtime.upstreamOrigin = profile.upstreamOrigin;
    runtime.activeRequests = 9;
    write(target, runtime);
    workerFiles.push(target);
  }
  const originals = [profile.outerPaths.runtimeStatePath, profile.managedStatePath, profile.outerPaths.lockPath,
    profile.outerPaths.journalPath, ...workerFiles].map(target => ({ target, bytes: fs.readFileSync(target) }));
  result.recoverySha256 = hash(fs.readFileSync(path.join(repository, "src/inner-startup-residual-recovery.mjs")));
  if (launcherPath === "-") {
    const started = await execute(path.join(repository, "ops/start-codex-model-stream-proxy.ps1"), ["-DataRoot", root, "-CodexExecutablePath", codexPath]);
    assert.equal(started.mode, "managed");
    result.ready = { ready: started.running, modelProxyPid: started.pid, appProxyPid: started.pid };
  } else {
    const launcher = repairDesktopLauncher(fs.readFileSync(launcherPath, "utf8").replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n"));
    assert.ok(!launcher.includes("$ClaimsActive="));
    assert.ok(!launcher.includes("$Mg.coordinator=$null"));
    const candidateLauncher = path.join(root, "launch.ps1");
    fs.writeFileSync(candidateLauncher, "\uFEFF" + launcher);
    write(path.join(root, "transition.json"), { state: "active" });
    const planPath = path.join(root, "plan.json");
    write(planPath, { codeRoot: repository, dataRoot: root, codexHome: profile.codexHome, nodePath: process.execPath,
      modelHealthUrl: `http://127.0.0.1:${profile.innerPort}/health`, downstreamPort: profile.ports.downstream,
      controlPort: profile.ports.control, upstreamPort: profile.ports.upstream, probePort: profile.ports.probe });
    result.launcherSha256 = hash(fs.readFileSync(candidateLauncher));
    result.ready = await execute(candidateLauncher, ["-PlanPath", planPath, "-OriginalLauncher", path.join(root, "unused-launcher.cmd"), "-SuppressRecoveryDialog", "-VerifyOnly"]);
  }
  assert.equal(result.ready.ready, true);
  newInstance = read(profile.outerPaths.runtimeStatePath);
  assert.notEqual(newInstance.instanceToken, outer.instanceToken);
  assert.equal(newInstance.pid, result.ready.appProxyPid);
  const recoveryRoots = fs.readdirSync(profile.checkpointRoot).filter(name => name.startsWith("startup-recovery-"));
  assert.equal(recoveryRoots.length, 1);
  const recoveryRoot = path.join(profile.checkpointRoot, recoveryRoots[0]);
  const manifest = read(path.join(recoveryRoot, "manifest.json"));
  for (const original of originals) {
    const saved = manifest.originals.find(entry => entry.path === original.target);
    assert.ok(saved, original.target);
    assert.deepEqual(fs.readFileSync(saved.backupPath), original.bytes);
  }
  assert.ok(fs.existsSync(path.join(recoveryRoot, "applied.json")));
  for (const original of originals.filter(entry => entry.target === profile.outerPaths.journalPath || workerFiles.includes(entry.target))) {
    assert.deepEqual(fs.readFileSync(original.target), original.bytes);
  }
  socket = new WebSocket(newInstance.downstreamUrl);
  await once(socket, "open");
  const initialized = new Promise(resolve => socket.on("message", bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.id === "owned-init") resolve(message);
  }));
  socket.send(JSON.stringify({ id: "owned-init", method: "initialize", params: { clientInfo: { name: "owned_busy_recovery", version: "1.0" } } }));
  const native = await Promise.race([initialized, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("NATIVE_INIT_TIMEOUT")), 15000); timer.unref(); })]);
  assert.ok(/codex/iu.test(native.result?.userAgent), JSON.stringify(native));
  socket.send(JSON.stringify({ method: "initialized", params: {} }));
  const current = await until(() => {
    const value = read(profile.managedStatePath);
    return value.coordinator?.nativeHealthy ? value : null;
  }, "native-ready");
  assert.equal(current.coordinator.activeHttp, 0);
  assert.equal(current.coordinator.threads.length, 0);
  assert.equal(current.controlOperations.length, 0);
  const status = await execute(path.join(repository, "ops/get-codex-app-server-proxy-status.ps1"), ["-DataRoot", root]);
  assert.equal(status.ok, true);
  assert.equal(status.control.journal.unknownWakeCount, 1);
  assert.equal(requestCount, 0);
  result.verified = { busyCounts: [9, 10, 9], nativeInitialization: true, originalFilesPreserved: originals.length,
    newActiveHttp: current.coordinator.activeHttp, unknownWakeCount: 1, upstreamRequests: requestCount };
} catch (error) {
  result.error = String(error.stack ?? error);
  const launchError = path.join(root, "last-launch-error.txt");
  if (fs.existsSync(launchError)) result.launchError = fs.readFileSync(launchError, "utf8");
  process.exitCode = 1;
} finally {
  if (socket && socket.readyState < WebSocket.CLOSING) { const closed = once(socket, "close"); socket.close(); await closed; }
  try {
    const runtime = profile && fs.existsSync(profile.outerPaths.runtimeStatePath) && read(profile.outerPaths.runtimeStatePath);
    if (runtime?.pid && originalInstance && runtime.instanceToken !== originalInstance && runtime.state !== "stopped") {
      if (!fs.existsSync(profile.outerPaths.stopFilePath)) write(profile.outerPaths.stopFilePath, { ownerId: profile.ownerId, instanceToken: runtime.instanceToken, testStop: true });
      await until(() => read(profile.managedStatePath).state === "closed", "owned-stop");
    }
    result.portsReleased = [];
    for (const port of Object.values(profile?.ports ?? {})) {
      const listener = net.createServer();
      const released = await new Promise(resolve => { listener.once("error", () => resolve(false)); listener.listen(port, "127.0.0.1", () => listener.close(() => resolve(true))); });
      result.portsReleased.push({ port, released });
      assert.equal(released, true);
    }
    clean = true;
  } catch (error) { result.cleanupError = String(error); process.exitCode = 1; }
  if (upstream?.listening) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  result.finishedAt = new Date().toISOString();
  if (clean) {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    result.cleaned = !result.error;
    if (!result.error) fs.rmSync(root, { recursive: true, force: true });
  }
  write(evidencePath, result);
  console.log(JSON.stringify({ evidencePath, root, ready: result.ready, verified: result.verified,
    error: result.error ?? null, cleanupError: result.cleanupError ?? null, cleaned: result.cleaned, portsReleased: result.portsReleased }));
}
