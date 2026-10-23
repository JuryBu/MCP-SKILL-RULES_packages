import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import * as sessionModule from "../src/inner-managed-session.mjs";
import { parseArguments } from "../src/codex-app-server-proxy-runner.mjs";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const nativeFixture = fileURLToPath(new URL("./inner-runtime-profile-native.mjs", import.meta.url));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

export async function until(predicate, budgetMs = 8000) {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "isolated managed generation condition deadline");
    await sleep(15);
  }
}

async function allocatePort(used) {
  while (true) {
    const listener = net.createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    if (!used.has(port)) { used.add(port); return port; }
  }
}

export async function fixture(context, { start = true, parent = false, production = false, configure = async () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-session-code-generation-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const history = path.join(home, "history.json");
  fs.writeFileSync(history, '{"synthetic":"preserved"}');
  const events = [];
  const calls = [];
  const held = [];
  const children = [];
  const sockets = [];
  const turns = [];
  const serviceParticipants = [];
  const cleanup = [];
  const expectedWorkerExits = new Set();
  const upstream = http.createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      calls.push({ method: request.method, path: request.url });
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ models: [{ slug: "synthetic-owned" }] }));
      } else if (request.url.includes("/images/") || request.url.includes("/memories/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ b64_json: "owned-synthetic" }], output: [{ memory_summary: "owned-memory" }] }));
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"type":"response.output_text.delta","delta":"held"}\n\n');
        held.push(response);
      }
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const used = new Set([upstream.address().port]);
  const ports = {};
  for (const name of ["inner", "downstream", "control", "upstream", "probe"]) ports[name] = await allocatePort(used);
  const files = ["runtime-state", "log", "stop-file", "lock", "journal", "token-file", "maintenance-file", "alert-file", "fallback-file"];
  const outerArguments = files.flatMap(name => [`--${name}`, path.join(root, `${name}.json`)]);
  outerArguments.push("--codex-exe", process.execPath, "--empty-client-restart-ms", "0",
    "--instance-token", crypto.randomUUID(), "--startup-budget-ms", "10000", "--start-timeout-ms", "3000");
  for (const name of ["downstream", "control", "upstream", "probe"]) outerArguments.push(`--${name}-port`, String(ports[name]));
  const candidateRoot = path.join(root, "parent-candidates");
  if (parent) { fs.mkdirSync(candidateRoot); outerArguments.push("--outer-runtime-root", candidateRoot); }
  const environment = {};
  for (const name of Object.keys(process.env)) {
    if (!/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH)$/iu.test(name)) environment[name] = "";
  }
  Object.assign(environment, { MODEL_OBSERVER_ENABLED: "false", CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100",
    INNER_PROFILE_TEST_FRONT_ORIGIN: `http://127.0.0.1:${ports.inner}` });
  const expectedHashes = Object.fromEntries(Object.entries({ runner: "codex-model-stream-proxy-runner.mjs",
    core: "codex-model-stream-proxy.mjs", helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })
    .map(([key, name]) => [key, digest(fs.readFileSync(path.join(sourceRoot, name)))]));
  const configuration = { mode: "isolated", ownerId: "isolated-generation-owner", nativeSourceId: "isolated-generation-native",
    checkpointRoot: root, codexHome: home, innerPort: ports.inner, outerArguments, environment,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    initial: { runnerPath: path.join(sourceRoot, "codex-model-stream-proxy-runner.mjs"), expectedHashes } };
  if (production) {
    configuration.schemaVersion = 1;
    configuration.mode = "production";
    configuration.stateRoot = path.join(root, "state");
    configuration.checkpointRoot = path.join(root, "checkpoints");
    configuration.outerStateRoot = root;
    configuration.installationRoot = path.dirname(sourceRoot);
    configuration.approvedUpstreamOrigin = "https://chatgpt.com";
    configuration.ports = ports;
    configuration.managedStatePath = path.join(configuration.stateRoot, "managed.json");
    for (const [target, kind] of [[configuration.stateRoot, "state"], [configuration.checkpointRoot, "checkpoint"]]) {
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1, kind,
        ownerId: configuration.ownerId, nativeSourceId: configuration.nativeSourceId }));
    }
    const receiptPath = path.join(root, "launch-receipt.json");
    outerArguments.push("--launch-receipt", receiptPath);
    const options = parseArguments(outerArguments);
    configuration.outerPaths = Object.fromEntries(Object.entries(options).filter(([name, target]) =>
      target !== null && ((name.endsWith("Path") && !["executablePath", "launchReceiptPath"].includes(name))
        || ["outerRuntimeRoot", "displayPolicyRoot"].includes(name))));
    const token = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(options.tokenFilePath, token);
    configuration.controlTokenSha256 = digest(Buffer.from(token));
    const receipt = JSON.stringify({ pid: process.pid, instanceToken: options.instanceToken, runtimeStatePath: options.runtimeStatePath });
    fs.writeFileSync(receiptPath, receipt);
    fs.writeFileSync(`${receiptPath}.ready`, JSON.stringify({ instanceToken: options.instanceToken, receiptSha256: digest(receipt) }));
  }
  await configure({ root, candidateRoot, configuration, sourceRoot, ports });
  const serviceDependencies = {
    probeExecutable: async () => {}, verifyListenerOwner: async () => true,
    executableRefreshIntervalMs: 60000, lifecyclePollIntervalMs: 20, livenessIntervalMs: 100,
    onServiceCodeParticipant: participant => serviceParticipants.push(participant),
    spawnAppServer: (_executable, port, options) => {
      const child = spawn(process.execPath, [nativeFixture, String(port)], {
        windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: options.env,
      });
      children.push(child);
      return { child, stderr: () => "" };
    },
  };
  const createSession = () => sessionModule.createManagedInnerProxySession(configuration, event => events.push(event), serviceDependencies);
  let session = createSession();
  let participant = session.liveCodeParticipant();
  let shared = participant.snapshot().state;
  const release = () => {
    for (const response of held) if (!response.writableEnded) response.end('data: {"type":"response.completed","response":{"id":"owned","status":"completed","output":[]}}\n\n');
  };
  context.after(async () => {
    release();
    for (const action of cleanup) await action();
    if (!shared.closed && shared.nativeSource.status().healthy) {
      for (const [threadId, turnId] of turns) {
        await shared.nativeSource.observe({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
      }
    }
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, "close"); socket.terminate(); await closed; }
    }
    await until(() => shared.coordinator.status().threads.every(thread => thread.activeHttp === 0));
    if (start) { await session.close(); await shared.outerTask; }
    else await shared.coordinator.close();
    clearInterval(shared.resources.publicationTimer);
    for (const deadline of shared.resources.controlTimers) clearTimeout(deadline.timer);
    assert.equal(shared.resources.controlTimers.size, 0);
    const workers = shared.coordinator.status().workers;
    assert.ok(workers.every(worker => !worker.alive && (worker.exitCode === 0 || expectedWorkerExits.has(worker.pid))));
    assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
    assert.equal(fs.readFileSync(history, "utf8"), '{"synthetic":"preserved"}');
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true });
    assert.equal(fs.existsSync(root), false);
    context.diagnostic(JSON.stringify({ root, removed: true, mode: configuration.mode, paidRequests: 0, productionActions: 0,
      workers: workers.map(worker => ({ pid: worker.pid, exitCode: worker.exitCode })),
      children: children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })),
      postExecutions: calls.filter(call => call.method === "POST").length }));
  });
  let endpoint = start ? await session.start() : null;
  async function restart() {
    release();
    for (const [threadId, turnId] of turns) {
      await shared.nativeSource.observe({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    }
    await until(() => shared.coordinator.status().threads.every(thread => thread.activeHttp === 0));
    for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, "close");
      socket.close();
      await closed;
    }
    await session.close();
    await shared.outerTask;
    turns.length = 0;
    const argumentsNext = [...configuration.outerArguments];
    argumentsNext[argumentsNext.indexOf("--instance-token") + 1] = crypto.randomUUID();
    configuration.outerArguments = argumentsNext;
    if (production) {
      const options = parseArguments(argumentsNext);
      const receiptPath = argumentsNext[argumentsNext.indexOf("--launch-receipt") + 1];
      const receipt = JSON.stringify({ pid: process.pid, instanceToken: options.instanceToken, runtimeStatePath: options.runtimeStatePath });
      fs.writeFileSync(receiptPath, receipt);
      fs.writeFileSync(`${receiptPath}.ready`, JSON.stringify({ instanceToken: options.instanceToken, receiptSha256: digest(receipt) }));
    }
    session = createSession();
    participant = session.liveCodeParticipant();
    shared = participant.snapshot().state;
    endpoint = await session.start();
  }
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${ports.downstream}`);
    sockets.push(socket);
    await once(socket, "open");
    return socket;
  }
  async function rpc(socket, method, params = {}) {
    const id = crypto.randomUUID();
    const reply = new Promise((resolve, reject) => {
      const listener = bytes => {
        const message = JSON.parse(bytes.toString());
        if (message.id !== id) return;
        clearTimeout(timer);
        socket.off("message", listener);
        resolve(message);
      };
      const timer = setTimeout(() => { socket.off("message", listener); reject(new Error("ISOLATED_RPC_TIMEOUT")); }, 5000);
      socket.on("message", listener);
    });
    socket.send(JSON.stringify({ id, method, params }));
    return reply;
  }
  async function turn(socket, threadId, turnId) {
    turns.push([threadId, turnId]);
    await rpc(socket, "turn/start", { threadId, fixtureTurnId: turnId, fixtureHoldTurn: true });
    await until(() => shared.nativeSource.status().delivered >= turns.length);
  }
  async function request(threadId, turnId, input = []) {
    const response = await fetch(`http://127.0.0.1:${ports.inner}/v1/responses`, { method: "POST",
      headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: threadId, turn_id: turnId }) },
      body: JSON.stringify({ model: "synthetic", stream: true, input }) });
    return { status: response.status, body: await response.text() };
  }
  return { root, candidateRoot, ports, sourceRoot, get session() { return session; }, get participant() { return participant; },
    get shared() { return shared; }, get endpoint() { return endpoint; }, restart,
    events, calls, held, release, connect, rpc, turn, request, serviceParticipants, cleanup, expectedWorkerExits };
}
