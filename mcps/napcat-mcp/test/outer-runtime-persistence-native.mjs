import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { createWakeJournal } from "../src/codex-app-server-proxy.mjs";
import { OUTER_RUNTIME_SELECTION_FILE } from "../src/outer-runtime-selection.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(process.argv[2] ?? "");
const executable = path.resolve(process.argv[3] ?? "");
const relative = path.relative(fs.realpathSync(os.tmpdir()), root);
if (!relative || relative.startsWith("..") || path.isAbsolute(relative)
  || !path.basename(root).startsWith("outer-runtime-persistence-native-") || fs.existsSync(root)) throw new Error("NEW_TEMP_ATTEMPT_REQUIRED");
fs.mkdirSync(root, { recursive: true });
const ownerId = "outer-runtime-persistence-0331";
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const sourceNames = ["src/outer-runtime.mjs", "src/outer-runtime-selection.mjs", "src/outer-runtime-host.mjs",
  "src/codex-app-server-proxy.mjs", "src/codex-app-server-proxy-runner.mjs", "ops/codex-outer-runtime.mjs",
  "test/outer-runtime-persistence.test.mjs", "test/outer-runtime-persistence-native.mjs"];
const hashes = () => Object.fromEntries(sourceNames.map(name => [name, digest(fs.readFileSync(path.join(repo, name)))]));
const result = { ownerId, startedAt: new Date().toISOString(), productionModified: false, sourceHashes: hashes(), cycles: [], assertions: {} };
const files = Object.fromEntries(["runtime-state", "log", "stop-file", "lock", "journal", "token-file", "maintenance-file", "alert-file", "fallback-file"]
  .map(name => [name, path.join(root, `${name}.json`)]));
const candidateRoot = path.join(root, "reviewed-engines");
fs.mkdirSync(candidateRoot);
const selectionFile = path.join(candidateRoot, OUTER_RUNTIME_SELECTION_FILE);
const externalStopRecord = path.join(root, "external-stop-record.json");
fs.writeFileSync(externalStopRecord, JSON.stringify({ ownerId: "independent-owner", generation: 7, keep: true }));
const externalStopSha = digest(fs.readFileSync(externalStopRecord));
const record = (type, detail = {}) => fs.appendFileSync(path.join(root, "events.jsonl"), `${JSON.stringify({ at: Date.now(), type, ...detail })}\n`);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, label, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(20); }
  throw new Error(`TIMEOUT:${label}`);
}
async function freePort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
const runtime = () => JSON.parse(fs.readFileSync(files["runtime-state"], "utf8"));
const cliResults = [];
const messages = [];
const modelRequests = [];
const pending = new Map();
const timers = new Set();
let client;
let runner;
let cycle;
let model;
let locker;
let tool;
let toolCalls = 0;
let toolReplies = 0;
let identifier = 40;
const home = path.join(root, "empty-codex-home");
const env = { ...process.env, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" };
for (const key of Object.keys(env)) if (/^(OPENAI|CODEX|MCP)_/.test(key)) delete env[key];
env.CODEX_HOME = home;
const lockRelease = path.join(root, "release-selection-lock");
function rpc(method, params) {
  const id = ++identifier;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC_TIMEOUT:${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    record("desktop_rpc", { cycle: cycle.number, id, method, params });
    client.send(JSON.stringify({ id, method, params }));
  });
}
async function command(action, extra = []) {
  const args = [path.join(repo, "ops/codex-outer-runtime.mjs"), "--runtime-state", files["runtime-state"],
    "--token-file", files["token-file"], "--action", action, ...extra];
  const child = spawn(process.execPath, args, { cwd: repo, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [exitCode, signal] = await once(child, "close");
  const output = JSON.parse(stdout.trim());
  const entry = { cycle: cycle.number, action, args, pid: child.pid, exitCode, signal, output, stderr };
  cliResults.push(entry);
  record("independent_cli", entry);
  return output;
}
async function control(route, input) {
  const response = await fetch(`${runtime().controlUrl}${route}`, {
    method: input ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${fs.readFileSync(files["token-file"], "utf8").trim()}`, ...(input ? { "content-type": "application/json" } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  const output = { ...await response.json(), httpStatus: response.status };
  record("control", { cycle: cycle.number, route, output });
  return output;
}
const engineSource = fs.readFileSync(path.join(repo, "src/outer-engine.mjs"), "utf8");
const contractUrl = pathToFileURL(path.join(repo, "src/outer-runtime-contract.mjs")).href;
const sources = Object.fromEntries(["v1", "v2", "v3", "reject"].map(version => {
  let source = engineSource.replace('"./outer-runtime-contract.mjs"', JSON.stringify(contractUrl))
    .replace('version: "original"', `version: ${JSON.stringify(version)}`)
    .replace('return { threadId: normalizedThreadId, found: true, thread: result.thread };',
      `${version === "v1" ? 'await new Promise(resolve=>setTimeout(resolve,2500));' : ""}return { threadId: normalizedThreadId, found: true, thread: result.thread, businessVersion: ${JSON.stringify(version)} };`);
  if (version === "reject") source = source.replace("  async inspectThread(threadId)", '  beforeActivate(){throw new Error("PERSISTENCE_ACTIVATION_REJECTED");}\n  async inspectThread(threadId)');
  return [`${version}.mjs`, source];
}));
sources["bad.mjs"] = 'throw new Error("PERSISTENCE_BAD_IMPORT");';
for (const [name, source] of Object.entries(sources)) fs.writeFileSync(path.join(candidateRoot, name), source);
const receiptPath = name => path.join(root, `cycle-${cycle.number}-${name}.receipt.json`);
const prepare = name => command("prepare", ["--candidate", name, "--sha256", digest(sources[name]), "--receipt-out", receiptPath(name)]);
const activate = name => command("activate", ["--receipt", receiptPath(name)]);
const completed = turnId => messages.find(message => message.method === "turn/completed" && message.params?.turn?.id === turnId);
const stream = (response, value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
function finish(response, responseId, text) {
  const item = { id: `msg_${responseId}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  stream(response, { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  stream(response, { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: text });
  stream(response, { type: "response.output_item.done", output_index: 0, item });
  stream(response, { type: "response.completed", response: { id: responseId, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  response.end();
}
async function startRunner() {
  if (fs.existsSync(files["stop-file"])) {
    const saved = JSON.parse(fs.readFileSync(files["stop-file"], "utf8"));
    assert.equal(saved.ownerId, ownerId);
    fs.unlinkSync(files["stop-file"]);
  }
  cycle = { number: result.cycles.length + 1, startedAt: new Date().toISOString() };
  result.cycles.push(cycle);
  const args = [path.join(repo, "src/codex-app-server-proxy-runner.mjs"), ...Object.entries(files).flatMap(([name, value]) => [`--${name}`, value]),
    "--codex-exe", executable, "--outer-runtime-root", candidateRoot,
    ...["downstream", "control", "upstream", "probe"].flatMap(name => [`--${name}-port`, String(result.ports[name])])];
  cycle.command = [process.execPath, ...args];
  const stdout = fs.openSync(path.join(root, `runner-${cycle.number}.stdout.log`), "w");
  const stderr = fs.openSync(path.join(root, `runner-${cycle.number}.stderr.log`), "w");
  runner = spawn(process.execPath, args, { cwd: repo, env, windowsHide: true, stdio: ["ignore", stdout, stderr] });
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  cycle.runnerPid = runner.pid;
  const thisCycle = cycle;
  runner.once("exit", (code, signal) => { thisCycle.exit = { code, signal, at: new Date().toISOString() }; record("runner_exit", { cycle: thisCycle.number, ...thisCycle.exit }); });
  await until(() => {
    if (runner.exitCode !== null || runner.signalCode !== null) throw new Error("RUNNER_EXITED_BEFORE_READY");
    return fs.existsSync(files["runtime-state"]) && runtime().state === "running" && runtime().pid === runner.pid;
  }, "runner_running", 90000);
  cycle.nativePid = runtime().appServerPid;
  cycle.instanceToken = runtime().instanceToken;
  cycle.initialSelection = await command("status");
}
async function connect() {
  client = new WebSocket(runtime().downstreamUrl);
  client.on("error", error => record("desktop_error", { message: error.message }));
  client.on("message", raw => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    record("desktop_received", { cycle: cycle.number, message });
    if (message.id != null && !message.method) {
      const waiter = pending.get(message.id);
      if (waiter) {
        clearTimeout(waiter.timer); pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result);
      }
    } else if (message.method === "item/tool/call") { tool = message; toolCalls += 1; }
  });
  await once(client, "open");
  cycle.initialize = await rpc("initialize", { clientInfo: { name: "outer_runtime_persistence_fixture", version: "1" }, capabilities: { experimentalApi: true } });
  client.send(JSON.stringify({ method: "initialized", params: {} }));
}
async function stopRunner() {
  if (client?.readyState < WebSocket.CLOSING) {
    const closing = once(client, "close"); client.close(); await closing;
  }
  if (runner && runner.exitCode === null && runner.signalCode === null) {
    const stopRecord = { ownerId, cycle: cycle.number, reason: "isolated-normal-close" };
    fs.writeFileSync(files["stop-file"], JSON.stringify(stopRecord), { flag: "wx" });
    record("owned_stop_record", stopRecord);
    await until(() => runner.exitCode !== null || runner.signalCode !== null, "normal_runner_close", 90000);
    cycle.finalRuntime = runtime();
    assert.equal(cycle.exit.code, 0);
    assert.equal(cycle.finalRuntime.state, "stopped");
    assert.equal(cycle.finalRuntime.stopReason, "stop_file");
    assert.equal(fs.existsSync(files.lock), false);
  }
}
async function releaseLocker() {
  if (!locker) return;
  fs.writeFileSync(lockRelease, ownerId);
  await until(() => locker.exitCode !== null || locker.signalCode !== null, "selection_lock_release");
  assert.equal(locker.exitCode, 0);
}
try {
  createWakeJournal({ filePath: files.journal }).registerSubscription({ taskId: "isolated-persistence-preserved", generation: 1,
    threadId: "isolated-preserved-thread", localRole: "development", sourceMachine: "training", targetMachine: "development", trustedPeerQq: "1000000001" });
  model = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const count = modelRequests.length + 1;
    modelRequests.push({ count, body }); record("synthetic_model_request", { count, body });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const responseId = `resp_persistence_${count}`;
    stream(response, { type: "response.created", response: { id: responseId, object: "response", status: "in_progress", output: [] } });
    if (count === 2) {
      const item = { id: `fc_${responseId}`, type: "function_call", call_id: "persistence_once", name: "counter_once", arguments: "{}", status: "completed" };
      stream(response, { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: "" } });
      stream(response, { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments });
      stream(response, { type: "response.output_item.done", output_index: 0, item });
      stream(response, { type: "response.completed", response: { id: responseId, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      response.end();
    } else {
      const timer = setTimeout(() => { timers.delete(timer); if (!response.destroyed) finish(response, responseId, `SYNTHETIC_${count}`); }, 100);
      timers.add(timer);
      response.once("close", () => { clearTimeout(timer); timers.delete(timer); });
    }
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  result.ports = { model: model.address().port };
  for (const name of ["downstream", "control", "upstream", "probe"]) result.ports[name] = await freePort();
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "config.toml"), `model="gpt-6-luna"\nmodel_reasoning_effort="max"\nmodel_provider="isolated"\n[model_providers.isolated]\nname="isolated"\nbase_url="http://127.0.0.1:${result.ports.model}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
  result.nativeVersion = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true, env }).stdout.trim();
  result.nativeSha256 = digest(fs.readFileSync(executable));
  await startRunner();
  assert.equal(cycle.initialSelection.version, "original");
  assert.equal((await prepare("v1.mjs")).ok, true);
  assert.equal((await activate("v1.mjs")).version, "v1");
  await connect();
  const thread = (await rpc("thread/start", { cwd: root, model: "gpt-6-luna", modelProvider: "isolated", approvalPolicy: "never", sandbox: "danger-full-access",
    dynamicTools: [{ name: "counter_once", description: "Count an isolated effect once", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] })).thread;
  result.threadId = thread.id;
  const prelude = (await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "PRELUDE" }] })).turn;
  await until(() => completed(prelude.id), "prelude_persisted");
  const oldTurn = (await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "TOOL_ONCE" }] })).turn;
  await until(() => tool, "native_tool_wait");
  const beforeRecord = fs.readFileSync(selectionFile);
  const beforeJournal = fs.readFileSync(files.journal);
  assert.equal((await prepare("bad.mjs")).ok, false);
  assert.equal((await prepare("reject.mjs")).ok, true);
  assert.equal((await activate("reject.mjs")).error.code, "PERSISTENCE_ACTIVATION_REJECTED");
  assert.equal((await prepare("v2.mjs")).ok, true);
  const oldRead = control("/v1/threads/inspect", { threadId: thread.id });
  const lockingScript = "$stream=[System.IO.File]::Open($env:OUTER_PERSISTENCE_LOCK_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read);try{[Console]::WriteLine('LOCK_READY');while(-not(Test-Path -LiteralPath $env:OUTER_PERSISTENCE_RELEASE_PATH)){Start-Sleep -Milliseconds 25}}finally{$stream.Dispose()}";
  locker = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", lockingScript], { env: { ...env, OUTER_PERSISTENCE_LOCK_PATH: selectionFile, OUTER_PERSISTENCE_RELEASE_PATH: lockRelease }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  result.lockerPid = locker.pid;
  let lockOutput = "";
  locker.stdout.on("data", chunk => { lockOutput += chunk; });
  locker.stderr.on("data", chunk => record("selection_lock_error", { message: chunk.toString() }));
  await until(() => lockOutput.includes("LOCK_READY"), "exclusive_record_lock");
  result.writeFailure = await activate("v2.mjs");
  assert.equal(result.writeFailure.ok, false);
  assert.equal(result.writeFailure.error.code, "OUTER_RUNTIME_SELECTION_WRITE_FAILED");
  result.afterWriteFailure = await command("status");
  assert.equal(result.afterWriteFailure.version, "v1");
  assert.equal(result.afterWriteFailure.revision, 1);
  assert.equal(fs.readFileSync(selectionFile).equals(beforeRecord), true);
  assert.equal(fs.readFileSync(files.journal).equals(beforeJournal), true);
  assert.equal(fs.readdirSync(candidateRoot).some(name => name.endsWith(".tmp")), false);
  await releaseLocker();
  assert.equal((await activate("v2.mjs")).version, "v2");
  result.oldRead = await oldRead;
  assert.equal(result.oldRead.businessVersion, "v1");
  fs.appendFileSync(path.join(root, "tool-effects.jsonl"), JSON.stringify({ callId: tool.params.callId, ownerVersion: "v1" }) + "\n");
  client.send(JSON.stringify({ id: tool.id, result: { success: true, contentItems: [{ type: "inputText", text: "ONE_EFFECT" }] } }));
  toolReplies += 1;
  await until(() => completed(oldTurn.id), "old_native_turn_completed");
  const proxyEvents = fs.readFileSync(files.log, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(proxyEvents.find(event => event.type === "outer_runtime" && event.action === "downstream" && event.id === tool.id).version, "v1");
  assert.equal((await command("restore")).version, "v1");
  const selectedBeforeClose = fs.readFileSync(selectionFile);
  result.beforeClose = await command("status");
  await stopRunner();

  await startRunner();
  assert.equal(cycle.initialSelection.version, "v1");
  assert.equal(cycle.initialSelection.sha256, digest(sources["v1.mjs"]));
  assert.equal(cycle.initialSelection.revision, result.beforeClose.revision);
  assert.equal(fs.readFileSync(selectionFile).equals(selectedBeforeClose), true);
  assert.notEqual(result.cycles[0].instanceToken, cycle.instanceToken);
  await connect();
  cycle.resume = await rpc("thread/resume", { threadId: thread.id });
  cycle.nativeRead = await rpc("thread/read", { threadId: thread.id, includeTurns: true });
  cycle.businessRead = await control("/v1/threads/inspect", { threadId: thread.id });
  assert.equal(cycle.nativeRead.thread.id, thread.id);
  assert.equal(cycle.businessRead.businessVersion, "v1");
  const reopenedTurn = (await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "REOPENED_WORK" }] })).turn;
  await until(() => completed(reopenedTurn.id), "reopened_turn_completed");
  assert.equal((await command("restore")).version, "original");
  assert.equal((await prepare("v1.mjs")).ok, true);
  assert.equal((await activate("v1.mjs")).version, "v1");
  await stopRunner();

  const beforeDamage = fs.readFileSync(selectionFile);
  fs.appendFileSync(path.join(candidateRoot, "v1.mjs"), "\n");
  await startRunner();
  assert.equal(cycle.initialSelection.version, "original");
  assert.equal(cycle.initialSelection.persistence.state, "fallback");
  assert.equal(cycle.initialSelection.persistence.persistedVersion, "v1");
  assert.equal(fs.readFileSync(selectionFile).equals(beforeDamage), true);
  assert.equal(fs.readFileSync(path.join(candidateRoot, cycle.initialSelection.persistence.evidence)).equals(beforeDamage), true);
  await connect();
  await rpc("thread/resume", { threadId: thread.id });
  cycle.fallbackRead = await rpc("thread/read", { threadId: thread.id, includeTurns: true });
  assert.equal(cycle.fallbackRead.thread.id, thread.id);
  assert.equal((await prepare("v3.mjs")).ok, true);
  assert.equal((await activate("v3.mjs")).version, "v3");
  assert.equal((await control("/v1/threads/inspect", { threadId: thread.id })).businessVersion, "v3");
  await stopRunner();

  fs.writeFileSync(selectionFile, "{broken selection record");
  const invalidBytes = fs.readFileSync(selectionFile);
  await startRunner();
  assert.equal(cycle.initialSelection.version, "original");
  assert.equal(cycle.initialSelection.persistence.state, "invalid");
  assert.equal(fs.readFileSync(selectionFile).equals(invalidBytes), true);
  const invalidEvidence = path.join(candidateRoot, cycle.initialSelection.persistence.evidence);
  assert.equal(fs.readFileSync(invalidEvidence).equals(invalidBytes), true);
  await connect();
  await rpc("thread/resume", { threadId: thread.id });
  cycle.invalidRecordRead = await rpc("thread/read", { threadId: thread.id, includeTurns: true });
  assert.equal(cycle.invalidRecordRead.thread.id, thread.id);
  assert.equal((await prepare("v3.mjs")).ok, true);
  assert.equal((await activate("v3.mjs")).version, "v3");
  assert.equal(fs.readFileSync(invalidEvidence).equals(invalidBytes), true);
  result.assertions = { normalRunnerReopenedSameRootAndVersion: true, officialInitializeReadAndTool: true,
    failedPreparationActivationAndWritePreserveLiveRecord: true, oldToolAndOperationOwnedByV1: true,
    persistedRestoreAndIndependentRecovery: true, changedModuleAndBadRecordKeepNativeEntry: true,
    damagedEvidencePreserved: true, externalStopRecordPreserved: true };
  assert.equal(toolCalls, 1); assert.equal(toolReplies, 1);
  result.ok = true;
} catch (error) {
  result.ok = false; result.error = { message: error.message, stack: error.stack }; record("failure", result.error); process.exitCode = 1;
} finally {
  try { await releaseLocker(); await stopRunner(); }
  catch (error) { result.ok = false; result.cleanupError = error.message; process.exitCode = 1; }
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("FIXTURE_CLOSED")); }
  pending.clear();
  for (const timer of timers) clearTimeout(timer);
  if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  result.cleanup = { runnersAlive: result.cycles.filter(entry => alive(entry.runnerPid)).map(entry => entry.runnerPid),
    nativesAlive: result.cycles.filter(entry => entry.nativePid && alive(entry.nativePid)).map(entry => entry.nativePid),
    cliAlive: cliResults.filter(entry => alive(entry.pid)).map(entry => entry.pid), lockerAlive: result.lockerPid ? alive(result.lockerPid) : false,
    modelListening: model?.listening ?? false, desktopClosed: !client || client.readyState === WebSocket.CLOSED,
    lockReleased: !fs.existsSync(files.lock), ownedStopRecordPreserved: fs.existsSync(files["stop-file"]),
    externalStopRecordSha256: digest(fs.readFileSync(externalStopRecord)), temporarySelectionFiles: fs.readdirSync(candidateRoot).filter(name => name.endsWith(".tmp")) };
  result.sourceHashesAfter = hashes();
  try {
    if (result.ok) {
      assert.deepEqual(result.sourceHashesAfter, result.sourceHashes);
      assert.equal(result.cleanup.externalStopRecordSha256, externalStopSha);
      for (const field of ["runnersAlive", "nativesAlive", "cliAlive", "temporarySelectionFiles"]) assert.equal(result.cleanup[field].length, 0);
      assert.equal(result.cleanup.lockerAlive, false); assert.equal(result.cleanup.modelListening, false);
      assert.equal(result.cleanup.desktopClosed, true); assert.equal(result.cleanup.lockReleased, true);
    }
  } catch (error) { result.ok = false; result.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
  result.counts = { toolCalls, toolReplies, modelRequests: modelRequests.length, runnerCycles: result.cycles.length };
  result.finishedAt = new Date().toISOString();
  for (const [name, value] of Object.entries({ "cli-results.json": cliResults, "desktop-messages.json": messages, "model-requests.json": modelRequests })) fs.writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`);
  result.outputHashes = Object.fromEntries(fs.readdirSync(root).filter(name => name !== "result.json" && fs.statSync(path.join(root, name)).isFile()).map(name => [name, digest(fs.readFileSync(path.join(root, name)))]));
  fs.writeFileSync(path.join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ok: result.ok, error: result.error?.message, cleanupError: result.cleanupError, counts: result.counts, cleanup: result.cleanup, evidence: root }));
}
