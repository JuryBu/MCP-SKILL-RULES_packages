import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { parseArguments, runManagedInnerProfile } from "../src/codex-app-server-proxy-runner.mjs";
import { createManagedInnerProxySession, validateManagedSessionConfiguration } from "../src/inner-managed-session.mjs";
import { validateInnerRuntimeProfile, readInnerRuntimeProfile } from "../src/inner-runtime-profile.mjs";
import { isolatedHandoffConfiguration } from "../src/inner-runner-handoff-control.mjs";

export const digest = value => crypto.createHash("sha256").update(value).digest("hex");
export const installationRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/u, "");
const nativeFixture = fileURLToPath(new URL("./inner-runtime-profile-native.mjs", import.meta.url));
const evidenceRoots = [];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const managedArguments = value => [...value.argv, "--inner-managed-profile", value.profilePath,
  "--inner-managed-profile-sha256", digest(fs.readFileSync(value.profilePath))];

async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

export async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inner-production-profile-"));
  evidenceRoots.push(root);
  const profile = { schemaVersion: 1, mode: "production", ownerId: "temp-profile-owner", nativeSourceId: "temp-native-source",
    checkpointRoot: path.join(root, "checkpoints"), stateRoot: path.join(root, "state"), codexHome: path.join(root, "home"),
    installationRoot, upstreamOrigin: "http://127.0.0.1:9", approvedUpstreamOrigin: "https://chatgpt.com",
    ports: {}, initial: { runnerPath: path.join(installationRoot, "src", "codex-model-stream-proxy-runner.mjs"), expectedHashes: {} },
    environment: { MODEL_OBSERVER_ENABLED: "false", CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100" } };
  for (const target of [profile.checkpointRoot, profile.stateRoot, profile.codexHome]) fs.mkdirSync(target);
  for (const [target, kind] of [[profile.checkpointRoot, "checkpoint"], [profile.stateRoot, "state"]]) {
    fs.writeFileSync(path.join(target, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1,
      ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId, kind }));
  }
  fs.writeFileSync(path.join(profile.codexHome, "preserved-history.json"), '{"conversation":"preserve-temp-history"}');
  for (const [name, file] of Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })) {
    profile.initial.expectedHashes[name] = digest(fs.readFileSync(path.join(installationRoot, "src", file)));
  }
  for (const name of ["inner", "control", "downstream", "upstream", "probe"]) profile.ports[name] = await unusedPort();
  profile.innerPort = profile.ports.inner;
  profile.managedStatePath = path.join(profile.stateRoot, "managed.json");
  const names = ["runtime-state", "log", "stop-file", "lock", "journal", "token-file", "maintenance-file", "alert-file", "fallback-file", "launch-receipt"];
  const argv = names.flatMap(name => [`--${name}`, path.join(profile.stateRoot, `${name}.json`)]);
  const instanceToken = crypto.randomUUID();
  argv.push("--codex-exe", process.execPath, "--instance-token", instanceToken,
    "--empty-client-restart-ms", "0", "--startup-budget-ms", "10000", "--start-timeout-ms", "3000");
  for (const name of ["control", "downstream", "upstream", "probe"]) argv.push(`--${name}-port`, String(profile.ports[name]));
  const options = parseArguments(argv);
  profile.outerPaths = Object.fromEntries(Object.entries(options).filter(([name, value]) => name.endsWith("Path")
    && !["executablePath", "launchReceiptPath"].includes(name) && value !== null));
  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(options.tokenFilePath, token);
  profile.controlTokenSha256 = digest(Buffer.from(token));
  const receipt = JSON.stringify({ pid: process.pid, instanceToken, runtimeStatePath: options.runtimeStatePath });
  fs.writeFileSync(options.launchReceiptPath, receipt);
  fs.writeFileSync(`${options.launchReceiptPath}.ready`, JSON.stringify({ instanceToken, receiptSha256: digest(receipt) }));
  const profilePath = path.join(profile.stateRoot, "profile.json");
  const configuration = { ...profile, outerArguments: argv };
  fs.writeFileSync(profilePath, JSON.stringify(profile));
  return { root, profile, profilePath, options, argv, configuration };
}

export function nativeDependencies() {
  return { probeExecutable: async () => {}, verifyListenerOwner: async () => true,
    executableRefreshIntervalMs: 60000,
    spawnAppServer: (_executable, port, options) => ({ child: spawn(process.execPath, [nativeFixture, String(port)], {
      windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: options.env,
    }), stderr: () => "" }) };
}

test("production profile requires explicit identities roots pins ports token and source", async () => {
  const value = await fixture();
  assert.equal(validateManagedSessionConfiguration(value.configuration).runtimeProfile.mode, "production");
  const checks = [
    [{ ...value.profile, mode: "other" }, /PRODUCTION_REQUIRED/],
    [{ ...value.profile, checkpointRoot: path.parse(value.root).root }, /ROOT_FORBIDDEN/],
    [{ ...value.profile, ownerId: "other-owner" }, /ROOT_OWNER_MISMATCH/],
    [{ ...value.profile, initial: { ...value.profile.initial, expectedHashes: { ...value.profile.initial.expectedHashes, core: "0".repeat(64) } } }, /SOURCE_HASH_MISMATCH/],
    [{ ...value.profile, initial: { ...value.profile.initial, port: 18435 } }, /BACKEND_PORT_INVALID/],
    [{ ...value.profile, ports: { ...value.profile.ports, inner: value.profile.ports.control }, innerPort: value.profile.ports.control }, /PORTS_INVALID/],
    [{ ...value.profile, controlTokenSha256: "0".repeat(64) }, /CONTROL_TOKEN_MISMATCH/],
  ];
  for (const [profile, error] of checks) assert.throws(() => validateInnerRuntimeProfile(profile, { options: value.options }), error);
  assert.throws(() => validateInnerRuntimeProfile(value.profile, { options: { ...value.options, instanceToken: null } }), /RUNTIME_INSTANCE_REQUIRED/);
  assert.throws(() => validateManagedSessionConfiguration({ ...value.configuration, mode: "other" }), /PROFILE_MODE_MISMATCH/);
  assert.throws(() => validateManagedSessionConfiguration({ ...value.configuration, mode: "isolated" }), /PROFILE_MODE_MISMATCH/);
  assert.throws(() => validateInnerRuntimeProfile(value.profile, { options: { ...value.options,
    runtimeStatePath: path.join(value.root, "outside.json") } }), /OUTER_PATH_MISMATCH/);
});

test("production profile keeps automatic executable discovery and rejects explicit invalid paths", async () => {
  const value = await fixture();
  try {
    for (const executablePath of [null, undefined, process.execPath]) {
      assert.equal(validateInnerRuntimeProfile(value.profile, {
        options: { ...value.options, executablePath },
      }).mode, "production");
    }
    const automaticArguments = [...value.argv];
    automaticArguments.splice(automaticArguments.indexOf("--codex-exe"), 2);
    assert.equal(validateInnerRuntimeProfile(value.profile, {
      options: parseArguments(automaticArguments),
    }).mode, "production");
    for (const executablePath of ["", path.join(value.root, "missing-codex.exe")]) {
      assert.throws(() => validateInnerRuntimeProfile(value.profile, {
        options: { ...value.options, executablePath },
      }), /ABSOLUTE_PATH_REQUIRED|PATH_MISSING/u);
    }
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("production profile keeps Temp containment and launch parent checks", async () => {
  const value = await fixture();
  try {
    assert.equal(validateInnerRuntimeProfile(value.profile, { options: value.options }).mode, "production");
    const temporaryRoot = fs.realpathSync.native(os.tmpdir());
    assert.throws(() => validateInnerRuntimeProfile(value.profile, {
      options: { ...value.options, launchReceiptPath: path.join(path.dirname(temporaryRoot), "outside-launch.json") },
    }), /LAUNCH_TEMP_REQUIRED/u);
    assert.throws(() => validateInnerRuntimeProfile(value.profile, {
      options: { ...value.options, launchReceiptPath: path.join(value.root, "missing-parent", "launch.json") },
    }), /PATH_MISSING/u);
    const junction = path.join(value.root, "receipt-junction");
    fs.symlinkSync(value.profile.stateRoot, junction, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => validateInnerRuntimeProfile(value.profile, {
      options: { ...value.options, launchReceiptPath: path.join(junction, "launch.json") },
    }), /REPARSE_FORBIDDEN/u);
    fs.unlinkSync(junction);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
});

test("HTTPS origin and production worker configuration are validated without a network request", async () => {
  const value = await fixture();
  const profile = { ...value.profile, upstreamOrigin: "https://chatgpt.com" };
  assert.equal(validateInnerRuntimeProfile(profile).upstreamOrigin, "https://chatgpt.com");
  for (const origin of ["https://other.invalid", "https://user:secret@chatgpt.com", "https://chatgpt.com?x=1",
    "https://chatgpt.com#fragment", "https://chatgpt.com/path", "http://example.invalid", "https://chatgpt.com/"]) {
    assert.throws(() => validateInnerRuntimeProfile({ ...profile, upstreamOrigin: origin }), /ORIGIN/);
  }
  const stateRoot = path.join(profile.stateRoot, "worker-uncreated");
  const environment = { CODEX_HOME: profile.codexHome, CODEX_MODEL_STREAM_PROXY_STATE_ROOT: stateRoot,
    CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN: profile.upstreamOrigin,
    CODEX_MODEL_STREAM_PROXY_HANDOFF_CONTROL: JSON.stringify({ schemaVersion: 1, mode: "production", ownerId: profile.ownerId,
      nativeSourceId: profile.nativeSourceId, capability: "a".repeat(64), checkpointRoot: profile.checkpointRoot, runtimeProfile: profile }) };
  const validated = isolatedHandoffConfiguration({ environment, ipc: { send() {}, connected: true }, stateRoot, host: "127.0.0.1", upstreamOrigin: profile.upstreamOrigin });
  assert.equal(validated.mode, "production");
  assert.throws(() => isolatedHandoffConfiguration({ environment, ipc: { send() {}, connected: true },
    stateRoot: path.join(value.root, "escaped"), host: "127.0.0.1", upstreamOrigin: profile.upstreamOrigin }), /WORKER_STATE_ESCAPE/);
  fs.writeFileSync(path.join(value.root, "https-validation-evidence.json"), JSON.stringify({ validated: true, networkRequests: 0, sourceHashes: profile.initial.expectedHashes }));
});

test("reparse profile roots and unresolved lease fail before state mutation", async () => {
  const value = await fixture();
  const link = path.join(value.root, "state-link");
  fs.symlinkSync(value.profile.stateRoot, link, process.platform === "win32" ? "junction" : "dir");
  try { assert.throws(() => validateInnerRuntimeProfile({ ...value.profile, stateRoot: link }), /REPARSE_FORBIDDEN/); }
  finally { fs.unlinkSync(link); }
  fs.writeFileSync(value.options.lockPath, "foreign-lease");
  assert.throws(() => createManagedInnerProxySession(value.configuration), /EXISTING_LEASE/);
  assert.equal(fs.readFileSync(value.options.lockPath, "utf8"), "foreign-lease");
  assert.equal(fs.existsSync(value.profile.managedStatePath), false);
  fs.unlinkSync(value.options.lockPath);
  const runtimeBytes = '{"state":"running","pid":123,"appServerPid":456}';
  fs.writeFileSync(value.options.runtimeStatePath, runtimeBytes);
  assert.throws(() => createManagedInnerProxySession(value.configuration), /OUTER_RUNTIME_UNRESOLVED/);
  assert.equal(fs.readFileSync(value.options.runtimeStatePath, "utf8"), runtimeBytes);
});

test("existing stop requirement and unpublished launch fail without acquiring resources", async () => {
  const value = await fixture();
  fs.writeFileSync(value.options.stopFilePath, "foreign-stop");
  assert.throws(() => createManagedInnerProxySession(value.configuration), /STOP_REQUIREMENT_PRESENT/);
  assert.equal(fs.readFileSync(value.options.stopFilePath, "utf8"), "foreign-stop");
  fs.unlinkSync(value.options.stopFilePath);
  fs.writeFileSync(`${value.options.launchReceiptPath}.ready`, "{}");
  const argv = managedArguments(value);
  await assert.rejects(runManagedInnerProfile({ ...parseArguments(argv), launchPublicationTimeoutMs: 30 }, argv), /START_LAUNCH_NOT_PUBLISHED/);
  assert.equal(fs.existsSync(value.options.lockPath), false);
  assert.equal(fs.existsSync(value.profile.managedStatePath), false);
});

test("occupied Temp port with HTTPS preserves foreign listener and creates no worker", async () => {
  const value = await fixture();
  const foreign = net.createServer(socket => socket.end("foreign-preserved"));
  foreign.listen(value.profile.ports.downstream, "127.0.0.1");
  await once(foreign, "listening");
  const session = createManagedInnerProxySession({ ...value.configuration, upstreamOrigin: "https://chatgpt.com" });
  try {
    await assert.rejects(session.start(), /EADDRINUSE/);
    assert.equal(session.status().coordinator.workers.length, 0);
    assert.equal(foreign.listening, true);
    assert.equal(fs.existsSync(value.options.lockPath), false);
    assert.equal(fs.existsSync(value.profile.managedStatePath), false);
    fs.writeFileSync(path.join(value.root, "occupied-https-evidence.json"), JSON.stringify({ code: "EADDRINUSE", workers: 0, foreignListening: true, networkRequests: 0 }));
  } finally { await new Promise(resolve => foreign.close(resolve)); }
});

test("Temp production session uses normal outer service and closes then reopens persistent roots", { timeout: 30000 }, async () => {
  const value = await fixture();
  const history = path.join(value.profile.codexHome, "preserved-history.json");
  const historyHash = digest(fs.readFileSync(history));
  const stableProfileSha256 = digest(fs.readFileSync(value.profilePath));
  const traces = [];
  const runs = [];
  for (const generation of [1, 2]) {
    if (generation === 2) {
      assert.throws(() => createManagedInnerProxySession(value.configuration), /RETIRED_INSTANCE_REUSED/);
      const instanceToken = crypto.randomUUID();
      value.argv[value.argv.indexOf("--instance-token") + 1] = instanceToken;
      const launchRoot = path.join(value.root, `launch-${instanceToken}`);
      fs.mkdirSync(launchRoot);
      const launchReceiptPath = path.join(launchRoot, "receipt.json");
      value.argv[value.argv.indexOf("--launch-receipt") + 1] = launchReceiptPath;
      const receipt = JSON.stringify({ pid: process.pid, instanceToken, runtimeStatePath: value.options.runtimeStatePath });
      fs.writeFileSync(launchReceiptPath, receipt);
      fs.writeFileSync(`${launchReceiptPath}.ready`, JSON.stringify({ instanceToken, receiptSha256: digest(receipt) }));
    }
    const session = createManagedInnerProxySession(value.configuration, event => traces.push(event), nativeDependencies());
    try {
      const endpoint = await session.start();
      assert.equal(endpoint.mode, "production");
      assert.equal(session.status().outer.pid, process.pid);
      assert.equal(session.status().outer.instanceToken, value.argv[value.argv.indexOf("--instance-token") + 1]);
      assert.equal(JSON.parse(fs.readFileSync(value.profile.managedStatePath)).state, "running");
      const firstLiveness = JSON.parse(fs.readFileSync(value.profile.managedStatePath)).livenessAt;
      await sleep(1050);
      const published = JSON.parse(fs.readFileSync(value.profile.managedStatePath));
      assert.equal(published.healthy, true);
      assert.equal(published.front.pid, process.pid);
      assert.equal(published.front.port, value.profile.innerPort);
      assert.notEqual(published.livenessAt, firstLiveness);
      const client = new WebSocket(endpoint.downstreamUrl);
      await once(client, "open");
      const completed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("TEMP_NATIVE_EVENT_TIMEOUT")), 3000);
        client.on("message", bytes => {
          if (JSON.parse(bytes.toString()).method === "turn/completed") { clearTimeout(timer); resolve(); }
        });
      });
      client.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "temp-profile", version: "1" } } }));
      await sleep(50);
      client.send(JSON.stringify({ id: 2, method: "turn/start", params: { threadId: "temp-profile-thread", input: [] } }));
      await completed;
      const terminalDeadline = Date.now() + 3000;
      while (session.status().coordinator.threads[0]?.phase !== "terminal" && Date.now() < terminalDeadline) await sleep(25);
      assert.equal(session.status().coordinator.threads[0]?.phase, "terminal");
      client.close();
      await once(client, "close");
      await assert.rejects(session.prepareCandidate({ ...value.profile.initial, expectedHashes: { ...value.profile.initial.expectedHashes, runner: "0".repeat(64) } }), /UNVERIFIED_SOURCE/);
      assert.equal(session.status().coordinator.workers.filter(worker => worker.alive).length, 1);
      await assert.rejects(session.migrate({ threadId: "temp-profile-thread", candidateId: "missing-candidate" }), /THREAD_NOT_READY/);
      assert.equal(session.status().coordinator.workers.filter(worker => worker.alive).length, 1);
      await session.close();
      const result = await session.waitForClose();
      assert.equal(result.state, "stopped");
      assert.equal(fs.existsSync(value.options.stopFilePath), false);
      assert.equal(fs.existsSync(value.options.lockPath), false);
      assert.equal(session.status().coordinator.workers.every(worker => !worker.alive && worker.exitCode === 0), true);
      assert.equal(digest(fs.readFileSync(history)), historyHash);
      runs.push({ generation, endpoint, status: session.status() });
    } finally { if (!session.status().closed) await session.close(); }
  }
  assert.notEqual(runs[0].endpoint.innerEndpoint.workerId, runs[1].endpoint.innerEndpoint.workerId);
  assert.notEqual(runs[0].status.outer.instanceToken, runs[1].status.outer.instanceToken);
  assert.equal(digest(fs.readFileSync(value.profilePath)), stableProfileSha256);
  fs.writeFileSync(path.join(value.root, "lifecycle-evidence.json"), JSON.stringify({ runs, traces, historyHash,
    stableProfileSha256, fixtureAppServer: true, officialExeCopied: false, productionTouched: false,
    progress2015: "startup validation wired; Temp verification pending at 20:15" }, null, 2));
  console.log(`lifecycle evidence: ${value.root}`);
});

test("original runner managed branch waits for service completion and honors existing stop publication", { timeout: 20000 }, async () => {
  const value = await fixture();
  const argv = managedArguments(value);
  const options = parseArguments(argv);
  assert.equal(readInnerRuntimeProfile(value.profilePath, { options }).mode, "production");
  const resultTask = runManagedInnerProfile(options, argv, nativeDependencies());
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (fs.existsSync(value.profile.managedStatePath) && JSON.parse(fs.readFileSync(value.profile.managedStatePath)).state === "running") break;
    await sleep(50);
  }
  assert.equal(JSON.parse(fs.readFileSync(value.profile.managedStatePath)).state, "running");
  fs.writeFileSync(value.options.stopFilePath, "external-owned-stop");
  const result = await resultTask;
  assert.equal(result.state, "stopped");
  assert.equal(fs.readFileSync(value.options.stopFilePath, "utf8"), "external-owned-stop");
  const managed = JSON.parse(fs.readFileSync(value.profile.managedStatePath));
  assert.equal(managed.state, "closed");
  assert.equal(managed.coordinator.workers.every(worker => !worker.alive), true);
  assert.equal(parseArguments(value.argv).innerManagedProfilePath, undefined);
  fs.writeFileSync(path.join(value.root, "entry-stop-evidence.json"), JSON.stringify({ result, managed, entry: "codex-app-server-proxy-runner.mjs", stdinDependency: false }, null, 2));
});

test("original CLI entry with ignored stdin fails closed on existing stop and keeps identity arguments", { timeout: 10000 }, async () => {
  const value = await fixture();
  const argv = managedArguments(value);
  fs.writeFileSync(value.options.stopFilePath, "cli-foreign-stop");
  const runnerPath = path.join(installationRoot, "src", "codex-app-server-proxy-runner.mjs");
  const child = spawn(process.execPath, [runnerPath, ...argv], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", bytes => { stderr += bytes.toString(); });
  const [code] = await once(child, "exit");
  assert.equal(code, 1);
  assert.match(stderr, /STOP_REQUIREMENT_PRESENT/);
  assert.equal(fs.existsSync(value.options.lockPath), false);
  assert.equal(fs.existsSync(value.profile.managedStatePath), false);
  assert.equal(fs.readFileSync(value.options.stopFilePath, "utf8"), "cli-foreign-stop");
  fs.writeFileSync(path.join(value.root, "cli-fail-close-evidence.json"), JSON.stringify({ code, stderr, runnerPath,
    stdin: "ignore", identityArguments: argv.filter((_value, index) => index % 2 === 0) }, null, 2));
});

test("profile CLI SHA pair and exact original bytes fail closed on tamper", async () => {
  const value = await fixture();
  assert.throws(() => parseArguments([...value.argv, "--inner-managed-profile", value.profilePath]), /PATH_SHA256_PAIR_REQUIRED/);
  const argv = managedArguments(value);
  const options = parseArguments(argv);
  fs.appendFileSync(value.profilePath, "\n");
  await assert.rejects(runManagedInnerProfile(options, argv), /SHA256_MISMATCH/);
  assert.equal(fs.existsSync(value.profile.managedStatePath), false);
  assert.equal(fs.existsSync(value.options.lockPath), false);
  await assert.rejects(runManagedInnerProfile(options, [...argv, "--control-port", String(options.controlPort)]), /DUPLICATE_ARGUMENTS/);
});

test("default isolated Temp validation retains its limits without production fields", async () => {
  const value = await fixture();
  const isolated = { mode: "isolated", checkpointRoot: value.root, codexHome: value.profile.codexHome,
    innerPort: value.profile.innerPort, outerArguments: value.argv };
  assert.equal(validateManagedSessionConfiguration(isolated).runtimeProfile, undefined);
  assert.throws(() => validateManagedSessionConfiguration({ ...isolated, mode: "unknown" }), /ISOLATED_ONLY/);
  assert.throws(() => validateManagedSessionConfiguration({ ...isolated, codexHome: os.tmpdir() }), /HOME_REQUIRED/);
  assert.equal(parseArguments(value.argv).innerManagedProfilePath, undefined);
  assert.equal(parseArguments(value.argv).innerManagedProfileSha256, undefined);
});

test("published front and worker health reflects an owned worker exit without stopping foreign processes", { timeout: 15000 }, async () => {
  const value = await fixture();
  const session = createManagedInnerProxySession(value.configuration, () => {}, nativeDependencies());
  try {
    await session.start();
    const worker = session.status().coordinator.workers[0];
    process.kill(worker.pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    let published;
    while (Date.now() < deadline) {
      published = JSON.parse(fs.readFileSync(value.profile.managedStatePath));
      if (published.state === "degraded" && published.coordinator.workers.every(current => !current.alive)) break;
      await sleep(25);
    }
    assert.equal(published.healthy, false);
    assert.equal(published.state, "degraded");
    assert.equal(published.front.listening, true);
    assert.equal(published.coordinator.workers[0].alive, false);
    await session.close();
    assert.equal((await session.waitForClose()).state, "stopped");
    fs.writeFileSync(path.join(value.root, "worker-health-evidence.json"), JSON.stringify({ ownedPid: worker.pid, observed: published,
      closed: JSON.parse(fs.readFileSync(value.profile.managedStatePath)) }, null, 2));
  } finally { if (!session.status().closed) await session.close(); }
});

test.after(() => { console.log(`profile evidence roots: ${JSON.stringify(evidenceRoots)}`); });
