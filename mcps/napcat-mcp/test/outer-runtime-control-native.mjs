import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { createWakeJournal } from "../src/codex-app-server-proxy.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(process.argv[2] ?? "");
const executable = path.resolve(process.argv[3] ?? "");
if (!path.basename(root).startsWith("outer-runtime-control-") || fs.existsSync(path.join(root, "result.json"))) throw new Error("ISOLATED_ATTEMPT_REQUIRED");
fs.mkdirSync(root, { recursive: true });
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const sourceNames = ["src/codex-app-server-proxy-runner.mjs", "src/codex-app-server-proxy.mjs", "src/outer-engine.mjs", "src/outer-runtime.mjs",
  "src/outer-runtime-contract.mjs", "src/outer-runtime-host.mjs", "ops/codex-outer-runtime.mjs", "test/outer-runtime-prepare.test.mjs",
  "test/outer-runtime-control.test.mjs", "test/outer-runtime-control-native.mjs"];
const result = { startedAt: new Date().toISOString(), ownerId: "outer-runtime-0213", productionModified: false, ports: {}, assertions: {},
  sourceHashes: Object.fromEntries(sourceNames.map(name => [name, digest(fs.readFileSync(path.join(repo, name)))])) };
const files = Object.fromEntries(["runtime-state", "log", "stop-file", "lock", "journal", "token-file", "maintenance-file", "alert-file", "fallback-file"]
  .map(name => [name, path.join(root, `${name}.json`)]));
const record = (type, detail = {}) => fs.appendFileSync(path.join(root, "events.jsonl"), `${JSON.stringify({ at: Date.now(), type, ...detail })}\n`);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, label, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(20); }
  throw new Error(`TIMEOUT:${label}`);
}
async function port() {
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const assigned = listener.address().port; await new Promise(resolve => listener.close(resolve)); return assigned;
}
const modelRequests = [];
const downstreamMessages = [];
const cliResults = [];
const pending = new Map();
const responseCounts = new Map();
const timers = new Set();
let client;
let runner;
let model;
let tool;
let toolCalls = 0;
let toolReplies = 0;
let clientCloses = 0;
let cancelResponse;
let identifier = 30;
const runtime = () => JSON.parse(fs.readFileSync(files["runtime-state"], "utf8"));
const proxyEvents = () => fs.existsSync(files.log) ? fs.readFileSync(files.log, "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
function rpc(method, params) {
  const id = ++identifier;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC_TIMEOUT:${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); record("desktop_rpc_sent", { id, method, params });
    client.send(JSON.stringify({ id, method, params }));
  });
}
function streamEvent(response, value) { response.write(`data: ${JSON.stringify(value)}\n\n`); }
function finishModel(response, id, text) {
  const item = { id: `msg_${id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  streamEvent(response, { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  streamEvent(response, { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: text });
  streamEvent(response, { type: "response.output_item.done", output_index: 0, item });
  streamEvent(response, { type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  response.end();
}
const completed = turnId => downstreamMessages.find(message => message.method === "turn/completed" && message.params?.turn?.id === turnId);
const wakeInput = (threadId, wakeId, prompt) => ({ taskId: "isolated-outer-runtime-entry", generation: 1, threadId,
  localRole: "development", sourceMachine: "training", targetMachine: "development", trustedPeerQq: "1000000001",
  wakeId, prompt, pendingThroughSequence: identifier, pendingThroughTime: new Date().toISOString(), messageVisibility: "hidden" });
async function command(action, extra = [], tokenPath = files["token-file"]) {
  const args = [path.join(repo, "ops/codex-outer-runtime.mjs"), "--runtime-state", files["runtime-state"], "--token-file", tokenPath, "--action", action, ...extra];
  const child = spawn(process.execPath, args, { cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const [exitCode, signal] = await once(child, "close");
  const output = JSON.parse(stdout.trim()); const entry = { action, args, pid: child.pid, exitCode, signal, output, stderr };
  cliResults.push(entry); record("independent_cli", entry); return output;
}
async function control(route, input) {
  const response = await fetch(`${runtime().controlUrl}${route}`, {
    method: input ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${fs.readFileSync(files["token-file"], "utf8").trim()}`, ...(input ? { "content-type": "application/json" } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  const output = { ...await response.json(), httpStatus: response.status }; record("normal_control", { route, output }); return output;
}
try {
  const candidateRoot = path.join(root, "reviewed-engines"); fs.mkdirSync(candidateRoot);
  const contractUrl = pathToFileURL(path.join(repo, "src/outer-runtime-contract.mjs")).href;
  const fullEngineSource = fs.readFileSync(path.join(repo, "src/outer-engine.mjs"), "utf8");
  function moduleSource(version, reject = false) {
    let source = fullEngineSource.replace('"./outer-runtime-contract.mjs"', JSON.stringify(contractUrl))
      .replace('version: "original"', `version: ${JSON.stringify(version)}`)
      .replace('return { threadId: normalizedThreadId, found: true, thread: result.thread };',
        `${version === "v1" ? 'await new Promise(resolve => setTimeout(resolve, 1500));\n    ' : ''}return { threadId: normalizedThreadId, found: true, thread: result.thread, businessVersion: ${JSON.stringify(version)} };`);
    if (version === "v2") source = source
      .replace('requiredString(input.prompt, "prompt", 100000)', 'requiredString("V2::" + input.prompt, "prompt", 100000)')
      .replace('return client.reasoningPlaceholder.project(displayProjection);', 'const projected = client.reasoningPlaceholder.project(displayProjection);\n    return projected?.method === "item/agentMessage/delta" ? { ...projected, params: { ...projected.params, delta: "[v2]" + projected.params.delta } } : projected;');
    if (reject) source = source.replace('  async inspectThread(threadId)', '  beforeActivate() { throw new Error("ENTRY_ACTIVATION_REJECTED"); }\n\n  async inspectThread(threadId)');
    return source;
  }
  const sources = { "v1.mjs": moduleSource("v1"), "v2.mjs": moduleSource("v2"), "reject.mjs": moduleSource("reject", true), "bad.mjs": 'throw new Error("ENTRY_BAD_IMPORT");' };
  sources["factory-write.mjs"] = moduleSource("factory-write").replace('return new OuterEngine(host);', 'host.state.journal.writeWake("entry-old-wake",{status:"corrupted-by-factory"});throw new Error("FAIL_AFTER_FACTORY_WRITE");');
  sources["validate-write.mjs"] = moduleSource("validate-write").replace('  async inspectThread(threadId)', '  validate() { this.host.state.journal.registerSubscription({taskId:"isolated-outer-runtime-entry",generation:2,threadId:"unexpected-thread",localRole:"development",sourceMachine:"training",targetMachine:"development",trustedPeerQq:"1000000001"});throw new Error("FAIL_AFTER_VALIDATE_WRITE"); }\n\n  async inspectThread(threadId)');
  for (const [name, source] of Object.entries(sources)) fs.writeFileSync(path.join(candidateRoot, name), source);
  result.candidateHashes = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, { sha256: digest(source), bytes: Buffer.byteLength(source) }]));
  const receiptPath = name => path.join(root, `${name}.receipt.json`);
  const prepare = name => command("prepare", ["--candidate", name, "--sha256", digest(sources[name]), "--receipt-out", receiptPath(name)]);
  model = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const count = modelRequests.length + 1; modelRequests.push({ count, body }); record("model_request", { count, body });
    response.writeHead(200, { "content-type": "text/event-stream" }); const id = `resp_outer_entry_${count}`;
    streamEvent(response, { type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } });
    if (count === 2) {
      const item = { id: `fc_${id}`, type: "function_call", call_id: "outer_entry_once", name: "counter_once", arguments: "{}", status: "completed" };
      streamEvent(response, { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: "" } });
      streamEvent(response, { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments });
      streamEvent(response, { type: "response.output_item.done", output_index: 0, item });
      streamEvent(response, { type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); response.end();
    } else if (count === 4) {
      cancelResponse = response; const item = { id: `msg_${id}`, type: "message", role: "assistant", status: "in_progress", content: [] };
      streamEvent(response, { type: "response.output_item.added", output_index: 0, item });
      streamEvent(response, { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "CANCEL_STREAM" });
      response.once("close", () => record("cancelled_model_connection_closed"));
    } else {
      const timer = setTimeout(() => { timers.delete(timer); if (!response.destroyed) finishModel(response, id, count === 1 ? "PRELUDE" : count === 3 ? "OLD_DONE" : "RESTORED_DONE"); }, 300);
      timers.add(timer); response.once("close", () => { clearTimeout(timer); timers.delete(timer); });
    }
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening"); result.ports.model = model.address().port;
  const home = path.join(root, "empty-codex-home"); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "config.toml"), `model="gpt-6-luna"\nmodel_reasoning_effort="max"\nmodel_provider="isolated"\n[model_providers.isolated]\nname="isolated"\nbase_url="http://127.0.0.1:${result.ports.model}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
  const env = { ...process.env, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" };
  for (const key of Object.keys(env)) if (/^(OPENAI|CODEX|MCP)_/.test(key)) delete env[key]; env.CODEX_HOME = home;
  result.nativeVersion = spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true }).stdout.trim(); result.nativeSha256 = digest(fs.readFileSync(executable));
  for (const name of ["downstream", "control", "upstream", "probe"]) result.ports[name] = await port();
  const args = [path.join(repo, "src/codex-app-server-proxy-runner.mjs"), ...Object.entries(files).flatMap(([name, value]) => [`--${name}`, value]),
    "--codex-exe", executable, "--outer-runtime-root", candidateRoot, "--display-policy-root", candidateRoot,
    ...["downstream", "control", "upstream", "probe"].flatMap(name => [`--${name}-port`, String(result.ports[name])])];
  result.runnerCommand = [process.execPath, ...args];
  const stdout = fs.openSync(path.join(root, "runner.stdout.log"), "w"); const stderr = fs.openSync(path.join(root, "runner.stderr.log"), "w");
  runner = spawn(process.execPath, args, { cwd: repo, env, windowsHide: true, stdio: ["ignore", stdout, stderr] });
  fs.closeSync(stdout); fs.closeSync(stderr); result.runnerPid = runner.pid; result.runnerCreatedAt = new Date().toISOString();
  runner.once("exit", (code, signal) => { result.runnerExit = { code, signal, at: new Date().toISOString() }; record("runner_exit", result.runnerExit); });
  await until(() => {
    if (runner.exitCode !== null || runner.signalCode !== null) throw new Error("RUNNER_EXITED_BEFORE_READY");
    return fs.existsSync(files["runtime-state"]) && runtime().state === "running";
  }, "normal_runner_running", 90000);
  result.nativePid = runtime().appServerPid; result.nativeCreatedAt = runtime().updatedAt;
  assert.equal((await command("status")).enabled, true); assert.equal((await command("status")).version, "original");
  result.displayPolicyBefore = await control("/v1/display-policy"); assert.equal(result.displayPolicyBefore.enabled, true);
  assert.equal((await prepare("v1.mjs")).ok, true); assert.equal((await command("activate", ["--receipt", receiptPath("v1.mjs")])).version, "v1");
  client = new WebSocket(runtime().downstreamUrl);
  client.on("error", error => record("desktop_error", { message: error.message })); client.on("close", () => { clientCloses += 1; });
  client.on("message", raw => {
    const message = JSON.parse(raw.toString()); downstreamMessages.push(message); record("desktop_received", { message });
    if (message.id != null && !message.method) {
      responseCounts.set(message.id, (responseCounts.get(message.id) ?? 0) + 1); const waiter = pending.get(message.id);
      if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result); }
    } else if (message.method === "item/tool/call") {
      tool = message; toolCalls += 1; fs.appendFileSync(path.join(root, "tool-effects.jsonl"), `${JSON.stringify({ callId: message.params.callId, invocation: toolCalls })}\n`); record("actual_tool_wait", { message });
    }
  });
  await once(client, "open");
  await rpc("initialize", { clientInfo: { name: "outer_runtime_normal_entry_fixture", version: "1" }, capabilities: { experimentalApi: true } });
  client.send(JSON.stringify({ method: "initialized", params: {} }));
  const thread = (await rpc("thread/start", { cwd: root, model: "gpt-6-luna", modelProvider: "isolated", approvalPolicy: "never", sandbox: "danger-full-access",
    dynamicTools: [{ name: "counter_once", description: "Record an isolated checkpoint once", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] })).thread;
  const prelude = (await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "PRELUDE" }] })).turn;
  await until(() => completed(prelude.id), "prelude_persisted");
  result.oldWake = await control("/v1/wakes", wakeInput(thread.id, "entry-old-wake", "OLD_WORK")); assert.equal(result.oldWake.ok, true);
  await until(() => tool, "actual_tool_wait");
  result.before = await control("/status"); const connectedAt = result.before.clients[0].connectedAt;
  const wrongTokenPath = path.join(root, "wrong-token.txt"); fs.writeFileSync(wrongTokenPath, "wrong-token");
  result.wrongToken = await command("status", [], wrongTokenPath); assert.equal(result.wrongToken.httpStatus, 401);
  result.wrongInstance = await command("restore", ["--instance", "other-instance"]); assert.equal(result.wrongInstance.error.code, "OUTER_RUNTIME_INSTANCE_MISMATCH");
  result.badImport = await prepare("bad.mjs"); assert.equal(result.badImport.error.code, "ENTRY_BAD_IMPORT");
  assert.equal((await command("status")).version, "v1");
  const beforeFailedPreparation = fs.readFileSync(files.journal); result.journalBeforeFailedPreparationSha256 = digest(beforeFailedPreparation);
  for (const name of ["factory-write.mjs", "validate-write.mjs"]) {
    const failed = await prepare(name); assert.equal(failed.error.code, "OUTER_RUNTIME_PREPARE_SIDE_EFFECT_BLOCKED");
    assert.equal(fs.readFileSync(files.journal).equals(beforeFailedPreparation), true); assert.equal((await command("status")).version, "v1");
  }
  assert.equal((await prepare("reject.mjs")).ok, true);
  result.rejectedActivation = await command("activate", ["--receipt", receiptPath("reject.mjs")]); assert.equal(result.rejectedActivation.error.code, "ENTRY_ACTIVATION_REJECTED");
  assert.equal((await command("status")).version, "v1");
  result.wrongSha = await command("prepare", ["--candidate", "v2.mjs", "--sha256", "0".repeat(64)]); assert.equal(result.wrongSha.error.code, "OUTER_RUNTIME_SHA_MISMATCH");
  assert.equal((await prepare("v2.mjs")).ok, true);
  const oldInspect = control("/v1/threads/inspect", { threadId: thread.id }); oldInspect.catch(() => {});
  await until(async () => (await control("/v1/outer-runtime")).activeOperationCount === 1, "old_business_operation_waiting");
  const beforeJournal = fs.readFileSync(files.journal); result.journalBeforeSwitchSha256 = digest(beforeJournal);
  result.activation = await command("activate", ["--receipt", receiptPath("v2.mjs")]); assert.equal(result.activation.version, "v2");
  assert.equal(fs.readFileSync(files.journal).equals(beforeJournal), true);
  result.oldInspect = await oldInspect; assert.equal(result.oldInspect.businessVersion, "v1");
  assert.equal((await control("/status")).clients[0].connectedAt, connectedAt); assert.equal(clientCloses, 0);
  client.send(JSON.stringify({ id: tool.id, result: { success: true, contentItems: [{ type: "inputText", text: "ENTRY_ONCE_OK" }] } })); toolReplies += 1; record("actual_tool_reply", { id: tool.id });
  await until(() => completed(result.oldWake.turn.id), "old_turn_completed");
  assert.equal(downstreamMessages.some(message => message.method === "item/agentMessage/delta" && message.params.delta === "OLD_DONE"), true);
  result.newInspect = await control("/v1/threads/inspect", { threadId: thread.id }); assert.equal(result.newInspect.businessVersion, "v2");
  result.newWake = await control("/v1/wakes", wakeInput(thread.id, "entry-new-wake", "CANCEL_WORK")); assert.equal(result.newWake.ok, true);
  await until(() => downstreamMessages.some(message => message.method === "item/agentMessage/delta" && message.params.delta === "[v2]CANCEL_STREAM"), "new_business_projection");
  assert.equal(JSON.stringify(modelRequests.at(-1).body).includes("V2::CANCEL_WORK"), true);
  const state = await command("status"); result.restoration = await command("restore", ["--revision", String(state.revision)]); assert.equal(result.restoration.version, "v1");
  result.staleRestore = await command("restore", ["--revision", String(state.revision)]); assert.equal(result.staleRestore.error.code, "OUTER_RUNTIME_REVISION_MISMATCH");
  result.duplicateAfterRestore = await command("activate", ["--receipt", receiptPath("v2.mjs")]); assert.equal(result.duplicateAfterRestore.alreadyActivated, true); assert.equal(result.duplicateAfterRestore.version, "v1");
  await rpc("turn/interrupt", { threadId: thread.id, turnId: result.newWake.turn.id });
  await until(() => completed(result.newWake.turn.id), "cancelled_turn_completed"); assert.equal(completed(result.newWake.turn.id).params.turn.status, "interrupted");
  const cancelObservation = proxyEvents().find(event => event.type === "outer_runtime" && event.action === "downstream" && event.method === "turn/interrupt");
  assert.equal(cancelObservation.version, "v2");
  result.restoredWake = await control("/v1/wakes", wakeInput(thread.id, "entry-restored-wake", "RESTORED_WORK")); assert.equal(result.restoredWake.ok, true);
  await until(() => completed(result.restoredWake.turn.id), "restored_turn_completed"); assert.equal(JSON.stringify(modelRequests.at(-1).body).includes("V2::RESTORED_WORK"), false);
  const persisted = JSON.parse(fs.readFileSync(files.journal, "utf8"));
  assert.deepEqual(persisted.wakes["entry-old-wake"], JSON.parse(beforeJournal.toString()).wakes["entry-old-wake"]);
  for (const wakeId of ["entry-old-wake", "entry-new-wake", "entry-restored-wake"]) {
    assert.equal(persisted.wakes[wakeId].attempt, 1); assert.equal(proxyEvents().filter(event => event.type === "display_reminder_bound" && event.wakeId === wakeId).length, 1);
  }
  result.reloadedJournal = createWakeJournal({ filePath: files.journal }).status(); assert.equal(result.reloadedJournal.wakeCount, 3);
  result.after = await control("/status"); assert.equal(result.after.clients[0].connectedAt, connectedAt);
  assert.equal(result.after.clients[0].pendingInjectionCount, 0); assert.equal(result.after.outerRuntime.trackedRequestCount, 0);
  assert.equal(toolCalls, 1); assert.equal(toolReplies, 1); assert.equal(clientCloses, 0); assert.equal(modelRequests.length, 5);
  assert.equal(proxyEvents().filter(event => event.type === "upstream_connected").length, 1);
  assert.equal([...responseCounts.values()].every(count => count === 1), true);
  result.displayPolicyAfter = await control("/v1/display-policy");
  for (const field of ["apiVersion", "version", "revision", "rootId", "instanceId", "enabled", "failures", "preparationId"]) assert.equal(result.displayPolicyAfter[field], result.displayPolicyBefore[field]);
  assert.equal(result.displayPolicyAfter.boundReminders, result.displayPolicyBefore.boundReminders + 3);
  assert.equal(result.displayPolicyAfter.retainedDecisions, result.displayPolicyBefore.retainedDecisions + 3);
  result.assertions = { sameDesktopAndUpstream: true, oldOperationReturnsV1: true, newBusinessV2: true, toolOnce: true, cancelledTurnOwnedByV2: true,
    failedPreparationPreservesJournal: true, journalBytesUnchangedBySwitch: true, journalOldEntryPreserved: true, savedJournalReloaded: true, displayPolicyUnchanged: true };
  result.counts = { toolCalls, toolReplies, clientClosesDuringSwitch: clientCloses, modelRequests: modelRequests.length,
    nativeTurns: downstreamMessages.filter(message => ["turn/started", "turn/completed"].includes(message.method)).length };
  result.ok = true;
} catch (error) {
  result.ok = false; result.error = { message: error.message, stack: error.stack }; record("failure", result.error); process.exitCode = 1;
} finally {
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("FIXTURE_CLOSED")); } pending.clear();
  if (client?.readyState < WebSocket.CLOSING) { const closed = once(client, "close"); client.close(); await closed; }
  if (runner && runner.exitCode === null && runner.signalCode === null) {
    fs.writeFileSync(files["stop-file"], "isolated-test-complete\n"); record("normal_stop_file_written", { runnerPid: runner.pid });
    await until(() => runner.exitCode !== null || runner.signalCode !== null, "normal_runner_stop", 90000);
  }
  for (const timer of timers) clearTimeout(timer); cancelResponse?.destroy();
  if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  result.finalRuntime = fs.existsSync(files["runtime-state"]) ? runtime() : null;
  result.cleanup = { runnerAlive: result.runnerPid ? alive(result.runnerPid) : false, nativeAlive: result.nativePid ? alive(result.nativePid) : false,
    cliAlive: cliResults.filter(entry => alive(entry.pid)).map(entry => entry.pid), modelListening: model?.listening ?? false,
    desktopClosed: !client || client.readyState === WebSocket.CLOSED, lockReleased: !fs.existsSync(files.lock), stopFilePreserved: fs.existsSync(files["stop-file"]) };
  result.internalRpcCounts = {};
  for (const entry of proxyEvents()) {
    if (entry.type !== "outer_runtime" || !["injected_request", "injected_response"].includes(entry.action)) continue;
    const counts = result.internalRpcCounts[entry.id] ??= { method: entry.method, version: entry.version, written: 0, consumed: 0 };
    counts[entry.action === "injected_request" ? "written" : "consumed"] += 1;
  }
  try {
    if (result.ok) {
      for (const counts of Object.values(result.internalRpcCounts)) { assert.equal(counts.written, 1); assert.equal(counts.consumed, 1); }
      assert.equal(Object.keys(result.internalRpcCounts).length, 8); assert.equal(result.counts.nativeTurns, 8);
      assert.equal(result.finalRuntime.state, "stopped"); assert.equal(result.finalRuntime.stopReason, "stop_file");
      assert.equal(result.runnerExit.code, 0); assert.equal(result.cleanup.runnerAlive, false); assert.equal(result.cleanup.nativeAlive, false);
      assert.equal(result.cleanup.lockReleased, true); assert.equal(result.cleanup.stopFilePreserved, true);
      result.sourceHashesAfter = Object.fromEntries(sourceNames.map(name => [name, digest(fs.readFileSync(path.join(repo, name)))]));
      assert.deepEqual(result.sourceHashesAfter, result.sourceHashes);
    }
  } catch (error) { result.ok = false; result.error = { message: error.message, stack: error.stack }; record("failure", result.error); process.exitCode = 1; }
  result.finishedAt = new Date().toISOString();
  for (const [name, value] of Object.entries({ "cli-results.json": cliResults, "desktop-messages.json": downstreamMessages, "model-requests.json": modelRequests })) fs.writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`);
  result.outputHashes = Object.fromEntries(["events.jsonl", "log.json", "journal.json", "tool-effects.jsonl", "cli-results.json", "desktop-messages.json", "model-requests.json", "runner.stdout.log", "runner.stderr.log"].filter(name => fs.existsSync(path.join(root, name))).map(name => [name, digest(fs.readFileSync(path.join(root, name)))]));
  fs.writeFileSync(path.join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ok: result.ok, error: result.error?.message, counts: result.counts, runnerExit: result.runnerExit, cleanup: result.cleanup, evidence: root }));
}
