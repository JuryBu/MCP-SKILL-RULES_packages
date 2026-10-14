import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { parseArguments } from "../src/codex-app-server-proxy-runner.mjs";
import { createManagedInnerProxySession } from "../src/inner-managed-session.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

export async function createResidualFixture(dataRoot) {
  const outerRoot = path.join(dataRoot, "state");
  const profile = { schemaVersion: 1, mode: "production", ownerId: "residual-fixture-owner", nativeSourceId: "residual-fixture-native",
    checkpointRoot: path.join(dataRoot, "checkpoint"), stateRoot: path.join(outerRoot, "inner"), outerStateRoot: outerRoot,
    codexHome: path.join(dataRoot, "home"), installationRoot: repository, managedStatePath: path.join(outerRoot, "inner", "managed.json"),
    upstreamOrigin: "http://127.0.0.1:9", ports: {}, initial: { runnerPath: path.join(repository, "src", "codex-model-stream-proxy-runner.mjs"), expectedHashes: {} },
    environment: { MODEL_OBSERVER_ENABLED: "false", CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100" } };
  for (const target of [profile.checkpointRoot, profile.stateRoot, profile.codexHome, path.join(dataRoot, "candidate")]) fs.mkdirSync(target, { recursive: true });
  for (const [target, kind] of [[profile.checkpointRoot, "checkpoint"], [profile.stateRoot, "state"]]) {
    fs.writeFileSync(path.join(target, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1, ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId, kind }));
  }
  for (const [name, file] of Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })) {
    profile.initial.expectedHashes[name] = digest(fs.readFileSync(path.join(repository, "src", file)));
  }
  for (const name of ["inner", "control", "downstream", "upstream", "probe"]) profile.ports[name] = await unusedPort();
  profile.innerPort = profile.ports.inner;
  const names = { "runtime-state": "codex-app-server-proxy-runtime.json", log: "codex-app-server-proxy.jsonl",
    "stop-file": "codex-app-server-proxy.stop", lock: "codex-app-server-proxy.lock", journal: "codex-app-server-wake-journal.json",
    "token-file": "codex-app-server-proxy-token.txt", "maintenance-file": "task-router.maintenance.json",
    "alert-file": "automation-alert.json", "fallback-file": "codex-app-server-proxy-fallback.json" };
  const argv = Object.entries(names).flatMap(([name, file]) => [`--${name}`, path.join(outerRoot, file)]);
  const token = crypto.randomUUID();
  const receiptPath = path.join(dataRoot, `launch-${token}.json`);
  argv.push("--codex-exe", process.execPath, "--instance-token", token, "--launch-receipt", receiptPath,
    "--empty-client-restart-ms", "0", "--startup-budget-ms", "10000", "--start-timeout-ms", "3000");
  for (const name of ["control", "downstream", "upstream", "probe"]) argv.push(`--${name}-port`, String(profile.ports[name]));
  const options = parseArguments(argv);
  profile.outerPaths = Object.fromEntries(Object.entries(options).filter(([name, value]) => name.endsWith("Path") && !["executablePath", "launchReceiptPath"].includes(name) && value !== null));
  const controlToken = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(options.tokenFilePath, controlToken);
  profile.controlTokenSha256 = digest(Buffer.from(controlToken));
  const receipt = JSON.stringify({ pid: process.pid, instanceToken: token, runtimeStatePath: options.runtimeStatePath });
  fs.writeFileSync(receiptPath, receipt);
  fs.writeFileSync(`${receiptPath}.ready`, JSON.stringify({ instanceToken: token, receiptSha256: digest(receipt) }));
  const profilePath = path.join(profile.stateRoot, "profile.json");
  fs.writeFileSync(profilePath, JSON.stringify(profile));
  const profileSha256 = digest(fs.readFileSync(profilePath));
  const configurationPath = path.join(outerRoot, "codex-outer-runtime-startup.json");
  fs.writeFileSync(configurationPath, JSON.stringify({ schemaVersion: 1, enabled: false, candidateRoot: path.join(dataRoot, "candidate"),
    innerManagedProfilePath: profilePath, innerManagedProfileSha256: profileSha256 }));
  return { input: { dataRoot, profilePath, profileSha256, configurationPath,
    ports: Object.fromEntries(Object.entries(profile.ports).filter(([name]) => name !== "inner")) }, profile, argv, options };
}

export async function generateNativeResidual(dataRoot, withHistory = false) {
  const fixture = await createResidualFixture(dataRoot);
  const nativePath = fileURLToPath(new URL("./inner-runtime-profile-native.mjs", import.meta.url));
  const session = createManagedInnerProxySession({ ...fixture.profile, outerArguments: fixture.argv }, () => {}, {
    probeExecutable: async () => {}, verifyListenerOwner: async () => true, executableRefreshIntervalMs: 60000,
    livenessIntervalMs: 100, lifecyclePollIntervalMs: 50,
    spawnAppServer: (_executable, port, options) => ({ child: spawn(process.execPath, [nativePath, String(port)], {
      windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: options.env }), stderr: () => "" }) });
  await session.start();
  let completeHistory = async () => {};
  if (withHistory) {
    const socket = new WebSocket(`ws://127.0.0.1:${fixture.profile.ports.downstream}`);
    await once(socket, "open");
    const request = async message => {
      const reply = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("RESIDUAL_HISTORY_RESPONSE_TIMEOUT")), 5000);
        const listener = bytes => {
          const value = JSON.parse(bytes.toString());
          if (value.id !== message.id) return;
          clearTimeout(timer);
          socket.off("message", listener);
          resolve(value);
        };
        socket.on("message", listener);
      });
      socket.send(JSON.stringify(message));
      return reply;
    };
    await request({ id: "initialize", method: "initialize", params: { clientInfo: { name: "owned-residual-history", version: "1" } } });
    await request({ id: "completed", method: "turn/start", params: { threadId: "owned-completed-history", fixtureTurnId: "completed-turn" } });
    await request({ id: "interrupted", method: "turn/start", params: { threadId: "owned-interrupted-history", fixtureTurnId: "interrupted-turn", fixtureHoldTurn: true } });
    const closed = once(socket, "close");
    socket.close();
    await closed;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const state = JSON.parse(fs.readFileSync(fixture.profile.managedStatePath));
      const outerState = JSON.parse(fs.readFileSync(fixture.options.runtimeStatePath));
      if (state.nativeSource.delivered >= 3 && outerState.proxy.clientCount === 0) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    completeHistory = async () => {
      const completionSocket = new WebSocket(`ws://127.0.0.1:${fixture.profile.ports.downstream}`);
      await once(completionSocket, "open");
      completionSocket.send(JSON.stringify({ id: "initialize-finish", method: "initialize", params: { clientInfo: { name: "owned-history-cleanup", version: "1" } } }));
      completionSocket.send(JSON.stringify({ id: "finish", method: "test/complete", params: { threadId: "owned-interrupted-history", turnId: "interrupted-turn" } }));
      const finishDeadline = Date.now() + 5000;
      while (Date.now() < finishDeadline) {
        const state = JSON.parse(fs.readFileSync(fixture.profile.managedStatePath));
        if (state.coordinator.threads.every(thread => thread.phase === "terminal")) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const finishClosed = once(completionSocket, "close");
      completionSocket.close();
      await finishClosed;
    };
  }
  const outer = JSON.parse(fs.readFileSync(fixture.options.runtimeStatePath));
  const managed = JSON.parse(fs.readFileSync(fixture.profile.managedStatePath));
  const paths = [fixture.options.runtimeStatePath, fixture.options.lockPath, fixture.profile.managedStatePath];
  for (const worker of managed.coordinator.workers) {
    const workerRoot = path.join(fixture.profile.stateRoot, worker.workerId);
    paths.push(path.join(workerRoot, "codex-model-stream-proxy-runtime.json"), path.join(workerRoot, "codex-model-stream-proxy.lock.json"),
      path.join(workerRoot, "codex-model-stream-proxy.jsonl"));
  }
  const snapshots = paths.map(target => ({ target, bytes: fs.readFileSync(target) }));
  await completeHistory();
  await session.close();
  for (const snapshot of snapshots) fs.writeFileSync(snapshot.target, snapshot.bytes);
  fs.writeFileSync(path.join(dataRoot, "native-evidence.json"), JSON.stringify({ ...fixture.input,
    generatedBySource: true, parentPid: process.pid, appServerPid: outer.appServerPid, workers: managed.coordinator.workers.map(worker => worker.pid) }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateNativeResidual(process.argv[2], process.argv[3] === "history");
}
