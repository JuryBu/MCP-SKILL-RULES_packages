import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(process.argv[2] ?? "");
const executable = path.resolve(process.argv[3] ?? "");
if (!path.basename(root).startsWith("outer-full-") || fs.existsSync(path.join(root, "result.json"))) throw new Error("INVALID_ISOLATED_ATTEMPT");
fs.mkdirSync(root, { recursive: true });
const candidateRoot = path.join(root, "reviewed-policy");
fs.mkdirSync(candidateRoot);
const digest = source => crypto.createHash("sha256").update(source).digest("hex");
const policySources = {
  "v1.mjs": 'export default {apiVersion:1,version:"entry-v1",decideReminder:({text})=>({visibility:"inherit",text:`[v1]${text}`})};',
  "v2.mjs": 'await new Promise(resolve=>setTimeout(resolve,800)); export default {apiVersion:1,version:"entry-v2",decideReminder:({text})=>({visibility:"visible",text:`[v2]${text}`})};',
  "bad.mjs": 'throw new Error("ENTRY_BAD_IMPORT");',
  "fault.mjs": 'export default {apiVersion:1,version:"entry-fault",decideReminder:({text,wakeId})=>{if(wakeId!=="display-policy-probe")throw new Error("ENTRY_BAD_DECISION");return {visibility:"inherit",text};}};',
};
for (const [name, source] of Object.entries(policySources)) fs.writeFileSync(path.join(candidateRoot, name), source);
const events = [];
const modelRequests = [];
const desktopMessages = [];
const cliResults = [];
const pending = new Map();
const replyCounts = new Map();
const toolIdentities = new Set();
const timers = new Set();
const files = Object.fromEntries(["runtime-state", "log", "stop-file", "lock", "journal", "token-file", "maintenance-file", "alert-file", "fallback-file"]
  .map(name => [name, path.join(root, `${name}.json`)]));
let identifier = 20;
let runner;
let client;
let model;
let toolRequest;
let toolCalls = 0;
let clientCloses = 0;
const result = { startedAt: new Date().toISOString(), ownerId: "outer-full-entry-20261011-0006", productionModified: false,
  nativeVersion: spawnSync(executable, ["--version"], { encoding: "utf8", windowsHide: true }).stdout.trim(), sourceHashes: {} };
for (const name of ["src/codex-app-server-proxy-runner.mjs", "src/codex-app-server-proxy.mjs", "src/codex-display-policy.mjs", "ops/codex-display-policy.mjs", "test/codex-display-policy-control-native.mjs", "test/codex-display-policy-control.test.mjs", "test/codex-display-policy.test.mjs", "docs/codex-display-policy-control.md"]) {
  result.sourceHashes[name] = digest(fs.readFileSync(path.join(repo, name)));
}
function record(type, detail = {}) {
  const entry = { at: Date.now(), type, ...detail };
  events.push(entry);
  fs.appendFileSync(path.join(root, "events.jsonl"), `${JSON.stringify(entry)}\n`);
}
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, label, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(20); }
  throw new Error(`TIMEOUT:${label}`);
}
async function port() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const assigned = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return assigned;
}
const runtime = () => JSON.parse(fs.readFileSync(files["runtime-state"], "utf8"));
const journal = () => JSON.parse(fs.readFileSync(files.journal, "utf8"));
const savedWake = wakeId => Object.values(journal().wakes ?? {}).find(wake => wake.wakeId === wakeId);
async function command(action, extra = [], tokenPath = files["token-file"]) {
  const args = [path.join(repo, "ops/codex-display-policy.mjs"), "--runtime-state", files["runtime-state"], "--token-file", tokenPath, "--action", action, ...extra];
  const child = spawn(process.execPath, args, { cwd: repo, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [exitCode, signal] = await once(child, "exit");
  const output = JSON.parse(stdout.trim());
  const entry = { action, args, pid: child.pid, exitCode, signal, output, stderr };
  cliResults.push(entry);
  record("independent_cli", entry);
  return output;
}
async function control(route, input) {
  const response = await fetch(`${runtime().controlUrl}${route}`, {
    method: input ? "POST" : "GET", headers: { authorization: `Bearer ${fs.readFileSync(files["token-file"], "utf8").trim()}`,
      ...(input ? { "content-type": "application/json" } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}),
  });
  return { ...await response.json(), httpStatus: response.status };
}
async function prepare(name, extra = [], receiptName = name) {
  const current = await command("status");
  return command("prepare", ["--root-id", current.rootId, "--candidate", name, "--sha256", digest(policySources[name]),
    "--receipt-out", path.join(root, `${receiptName}.receipt.json`), ...extra]);
}
function rpc(method, params, id = ++identifier) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC_TIMEOUT:${method}`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }, timer });
    record("desktop_rpc_sent", { id, method, params });
    client.send(JSON.stringify({ id, method, params }));
  });
}
function finishModel(response, id, text) {
  const event = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
  const item = { id: `msg_${id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  event({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  event({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: text });
  event({ type: "response.output_item.done", output_index: 0, item });
  event({ type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  response.end();
}
const completed = turnId => desktopMessages.find(message => message.method === "turn/completed" && message.params?.turn?.id === turnId);
const wakeInput = (threadId, wakeId, prompt) => ({ taskId: "outer-entry-isolated-task", generation: 1, threadId,
  localRole: "development", sourceMachine: "training", targetMachine: "development", trustedPeerQq: "1000000001",
  wakeId, prompt, pendingThroughSequence: identifier, pendingThroughTime: new Date().toISOString(), messageVisibility: "hidden" });
try {
  model = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const count = modelRequests.length + 1;
    modelRequests.push({ count, body }); record("loopback_model_request", { count });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
    const id = `resp_entry_${count}`;
    event({ type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } });
    if (count === 2) {
      const item = { id: `fc_${id}`, type: "function_call", call_id: "entry_counter_once", name: "counter_once", arguments: "{}", status: "completed" };
      event({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: "" } });
      event({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments });
      event({ type: "response.output_item.done", output_index: 0, item });
      event({ type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); response.end();
    } else {
      const timer = setTimeout(() => { if (!response.destroyed) finishModel(response, id, count === 1 ? "PRELUDE" : "ENTRY_COMPLETE"); }, 800);
      timers.add(timer);
      response.once("close", () => { clearTimeout(timer); timers.delete(timer); });
    }
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  const home = path.join(root, "empty-codex-home"); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, "config.toml"), `model="gpt-6-luna"\nmodel_reasoning_effort="max"\nmodel_provider="isolated"\n[model_providers.isolated]\nname="isolated"\nbase_url="http://127.0.0.1:${model.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`);
  const env = { ...process.env, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" };
  for (const key of Object.keys(env)) if (/^(OPENAI|CODEX|MCP)_/.test(key)) delete env[key];
  env.CODEX_HOME = home;
  const args = [path.join(repo, "src/codex-app-server-proxy-runner.mjs"), ...Object.entries(files).flatMap(([name, value]) => [`--${name}`, value]),
    "--codex-exe", executable, "--display-policy-root", candidateRoot,
    ...await Promise.all(["downstream-port", "control-port", "upstream-port", "probe-port"].map(async name => [`--${name}`, String(await port())])).then(entries => entries.flat())];
  result.runnerCommand = [process.execPath, ...args];
  const stdout = fs.openSync(path.join(root, "runner.stdout.log"), "w");
  const stderr = fs.openSync(path.join(root, "runner.stderr.log"), "w");
  runner = spawn(process.execPath, args, { cwd: repo, env, windowsHide: true, stdio: ["ignore", stdout, stderr] });
  fs.closeSync(stdout); fs.closeSync(stderr); result.runnerPid = runner.pid;
  await until(() => fs.existsSync(files["runtime-state"]) && runtime().state === "running", "normal_runner_running", 60000);
  result.nativePid = runtime().appServerPid;
  const initial = await command("status"); assert.equal(initial.version, "original"); assert.equal(initial.enabled, true);
  const v1 = await prepare("v1.mjs"); assert.equal(v1.prepared, true);
  assert.equal((await command("activate", ["--receipt", path.join(root, "v1.mjs.receipt.json")])).activated, true);
  client = new WebSocket(runtime().downstreamUrl);
  client.on("error", error => record("desktop_error", { error: error.message }));
  client.on("close", () => { clientCloses += 1; });
  client.on("message", raw => {
    const message = JSON.parse(raw.toString()); desktopMessages.push(message); record("desktop_received", { message });
    if (message.id != null && !message.method) {
      replyCounts.set(message.id, (replyCounts.get(message.id) ?? 0) + 1);
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result); }
    } else if (message.method === "item/tool/call") {
      const identity = JSON.stringify([message.params.threadId, message.params.turnId, message.params.callId]);
      if (toolIdentities.has(identity)) throw new Error("UNEXPECTED_TOOL_REPLAY");
      toolIdentities.add(identity); toolCalls += 1; toolRequest = message;
      fs.appendFileSync(path.join(root, "tool-effects.jsonl"), `${JSON.stringify({ callId: message.params.callId, invocation: toolCalls })}\n`);
      record("actual_tool_wait", { id: message.id, identity });
    }
  });
  await once(client, "open");
  await rpc("initialize", { clientInfo: { name: "outer_entry_isolated_fixture", version: "1" }, capabilities: { experimentalApi: true } });
  client.send(JSON.stringify({ method: "initialized", params: {} }));
  const thread = (await rpc("thread/start", { cwd: root, model: "gpt-6-luna", modelProvider: "isolated", approvalPolicy: "never", sandbox: "danger-full-access",
    dynamicTools: [{ name: "counter_once", description: "Record isolated checkpoint once", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] })).thread;
  const old = (await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "OLD_WORK" }] })).turn;
  await until(() => modelRequests.length === 1, "old_model_wait");
  result.oldWake = await control("/v1/wakes", wakeInput(thread.id, "entry-old-hidden", "HIDDEN_OLD_REMINDER"));
  await until(() => savedWake("entry-old-hidden")?.visibilityItemKey, "old_hidden_registered");
  await until(() => toolRequest, "actual_tool_wait");
  result.oldIdentity = savedWake("entry-old-hidden");
  assert.equal(result.oldIdentity.displayPolicyVersion, "entry-v1");
  assert.equal(JSON.stringify(desktopMessages).includes("HIDDEN_OLD_REMINDER"), false);
  result.beforeSwitch = await control("/status");
  const connectedAt = result.beforeSwitch.clients[0].connectedAt;
  const wrongTokenPath = path.join(root, "old-token.txt"); fs.writeFileSync(wrongTokenPath, "old-token");
  result.wrongToken = await command("status", [], wrongTokenPath); assert.equal(result.wrongToken.httpStatus, 401);
  result.wrongInstance = await command("restore", ["--instance", "wrong-instance"]); assert.equal(result.wrongInstance.error.code, "DISPLAY_POLICY_INSTANCE_MISMATCH");
  const current = await command("status");
  result.wrongInstanceServer = await control("/v1/display-policy/restore", { instanceId: "wrong-instance", rootId: current.rootId, expectedRevision: current.revision });
  assert.equal(result.wrongInstanceServer.error.code, "DISPLAY_POLICY_INSTANCE_MISMATCH");
  result.wrongSha = await command("prepare", ["--root-id", current.rootId, "--candidate", "v2.mjs", "--sha256", "0".repeat(64)]);
  assert.equal(result.wrongSha.error.code, "DISPLAY_POLICY_SHA_MISMATCH");
  result.badImport = await prepare("bad.mjs"); assert.equal(result.badImport.error.code, "ENTRY_BAD_IMPORT");
  result.rootEscape = await command("prepare", ["--root-id", current.rootId, "--candidate", "../v2.mjs", "--sha256", digest(policySources["v2.mjs"])]);
  assert.equal(result.rootEscape.error.code, "INVALID_DISPLAY_POLICY_CANDIDATE");
  const prepareArgs = ["--root-id", current.rootId, "--candidate", "v2.mjs", "--sha256", digest(policySources["v2.mjs"])];
  result.concurrent = await Promise.all([command("prepare", [...prepareArgs, "--receipt-out", path.join(root, "concurrent-a.receipt.json")]),
    command("prepare", [...prepareArgs, "--receipt-out", path.join(root, "concurrent-b.receipt.json")])]);
  assert.equal(result.concurrent.filter(value => value.prepared).length, 1);
  assert.equal(result.concurrent.find(value => !value.ok).error.code, "DISPLAY_POLICY_PREPARE_BUSY");
  const receiptPath = path.join(root, fs.existsSync(path.join(root, "concurrent-a.receipt.json")) ? "concurrent-a.receipt.json" : "concurrent-b.receipt.json");
  assert.equal((await command("status")).version, "entry-v1");
  result.preparationPending = await prepare("fault.mjs", [], "pending-fault");
  assert.equal(result.preparationPending.error.code, "DISPLAY_POLICY_PREPARATION_PENDING");
  fs.writeFileSync(path.join(candidateRoot, "v2.mjs"), `${policySources["v2.mjs"]}\n`);
  result.changedCandidateActivation = await command("activate", ["--receipt", receiptPath]);
  assert.equal(result.changedCandidateActivation.error.code, "DISPLAY_POLICY_SHA_MISMATCH");
  assert.equal((await command("status")).version, "entry-v1");
  fs.writeFileSync(path.join(candidateRoot, "v2.mjs"), policySources["v2.mjs"]);
  const inspection = control("/v1/threads/inspect", { threadId: thread.id });
  const history = rpc("thread/read", { threadId: thread.id, includeTurns: true }, 777);
  result.activation = await command("activate", ["--receipt", receiptPath]); assert.equal(result.activation.activated, true);
  result.inspection = await inspection; assert.equal(result.inspection.ok, true);
  result.oldHistory = await history; assert.equal(replyCounts.get(777), 1);
  result.duplicateActivation = await command("activate", ["--receipt", receiptPath]); assert.equal(result.duplicateActivation.alreadyActivated, true);
  result.concurrentDuplicateActivation = await Promise.all([command("activate", ["--receipt", receiptPath]), command("activate", ["--receipt", receiptPath])]);
  assert.equal(result.concurrentDuplicateActivation.every(value => value.alreadyActivated && !value.activated), true);
  const after = await control("/status"); assert.equal(after.clients[0].connectedAt, connectedAt); assert.equal(after.clients[0].pendingInjectionCount, 0);
  assert.deepEqual(after.maintenance, result.beforeSwitch.maintenance);
  assert.deepEqual(after.lastError, result.beforeSwitch.lastError);
  assert.deepEqual(after.lastIncident, result.beforeSwitch.lastIncident);
  assert.equal(clientCloses, 0); assert.equal(toolCalls, 1);
  client.send(JSON.stringify({ id: toolRequest.id, result: { success: true, contentItems: [{ type: "inputText", text: "checkpoint-1" }] } }));
  record("tool_reply_once", { id: toolRequest.id });
  await until(() => completed(old.id), "old_tool_turn_complete");
  assert.equal(JSON.stringify(modelRequests[2].body).includes("checkpoint-1"), true);
  const next = (await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "NEW_WORK" }] })).turn;
  result.newWake = await control("/v1/wakes", wakeInput(thread.id, "entry-new-visible", "NEW_REMINDER"));
  await until(() => savedWake("entry-new-visible")?.visibilityItemKey, "new_visible_bound");
  await until(() => completed(next.id), "new_turn_complete");
  result.newIdentity = savedWake("entry-new-visible"); assert.equal(result.newIdentity.displayPolicyVersion, "entry-v2");
  assert.equal(JSON.stringify(desktopMessages).includes("[v2]NEW_REMINDER"), true);
  result.history = await rpc("thread/read", { threadId: thread.id, includeTurns: true }, 778);
  assert.equal(JSON.stringify(result.history).includes("HIDDEN_OLD_REMINDER"), false);
  assert.equal(JSON.stringify(result.history).includes("[v2]NEW_REMINDER"), true);
  const fault = await prepare("fault.mjs"); assert.equal(fault.prepared, true);
  assert.equal((await command("activate", ["--receipt", path.join(root, "fault.mjs.receipt.json")])).activated, true);
  const faultyTurn = (await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "FAULT_WORK" }] })).turn;
  await control("/v1/wakes", wakeInput(thread.id, "entry-fault-fallback", "FAULT_REMINDER"));
  await until(() => savedWake("entry-fault-fallback")?.visibilityItemKey, "faulty_decision_bound_once");
  await until(() => completed(faultyTurn.id), "faulty_turn_complete");
  result.faultFallback = await command("status"); assert.equal(result.faultFallback.version, "entry-v2"); assert.equal(result.faultFallback.failures, 1);
  result.restoration = await command("restore", ["--revision", String(result.faultFallback.revision)]); assert.equal(result.restoration.version, "entry-v1");
  result.staleRestore = await command("restore", ["--revision", String(result.faultFallback.revision)]); assert.equal(result.staleRestore.error.code, "DISPLAY_POLICY_REVISION_MISMATCH");
  result.duplicateAfterRestore = await command("activate", ["--receipt", receiptPath]);
  assert.equal(result.duplicateAfterRestore.alreadyActivated, true);
  assert.equal(result.duplicateAfterRestore.version, "entry-v1");
  const restored = (await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "RESTORED_WORK" }] })).turn;
  await control("/v1/wakes", wakeInput(thread.id, "entry-restored-hidden", "RESTORED_REMINDER"));
  await until(() => savedWake("entry-restored-hidden")?.visibilityItemKey, "restored_old_selection_bound");
  await until(() => completed(restored.id), "restored_turn_complete");
  result.restoredIdentity = savedWake("entry-restored-hidden"); assert.equal(result.restoredIdentity.displayPolicyVersion, "entry-v1");
  assert.equal(JSON.stringify(desktopMessages).includes("RESTORED_REMINDER"), false);
  result.restoredHistory = await rpc("thread/read", { threadId: thread.id, includeTurns: true }, 779);
  assert.equal(JSON.stringify(result.restoredHistory).includes("[v2]NEW_REMINDER"), true);
  assert.equal(JSON.stringify(result.restoredHistory).includes("HIDDEN_OLD_REMINDER"), false);
  assert.equal(JSON.stringify(result.restoredHistory).includes("RESTORED_REMINDER"), false);
  result.finalStatus = await control("/status"); assert.equal(result.finalStatus.clients[0].connectedAt, connectedAt);
  assert.equal(result.finalStatus.clients[0].pendingInjectionCount, 0); assert.equal(clientCloses, 0);
  result.replyCounts = Object.fromEntries(replyCounts); result.toolCalls = toolCalls; result.clientClosesDuringSwitch = clientCloses;
  result.completed = true;
} catch (error) {
  result.fixtureError = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  if (client?.readyState < WebSocket.CLOSING) { const closed = once(client, "close"); client.close(); await closed; }
  if (runner && runner.exitCode === null && runner.signalCode === null) {
    const exit = once(runner, "exit"); fs.writeFileSync(files["stop-file"], "isolated-test-complete\n");
    const [exitCode, signal] = await exit; result.runnerExit = { exitCode, signal };
  } else result.runnerExit = runner ? { exitCode: runner.exitCode, signal: runner.signalCode } : null;
  for (const timer of timers) clearTimeout(timer);
  if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  result.cleanup = { runnerAlive: result.runnerPid ? alive(result.runnerPid) : false, nativeAlive: result.nativePid ? alive(result.nativePid) : false,
    cliAlive: cliResults.filter(entry => alive(entry.pid)).map(entry => entry.pid), modelListening: model?.listening ?? false,
    desktopState: client?.readyState ?? WebSocket.CLOSED, pendingDesktopRpc: pending.size };
  result.finishedAt = new Date().toISOString();
  if (fs.existsSync(files.log)) result.proxyEvents = fs.readFileSync(files.log, "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  result.internalRpcCounts = {};
  for (const entry of result.proxyEvents ?? []) {
    if (entry.type !== "display_policy_rpc_observed") continue;
    const counts = result.internalRpcCounts[entry.id] ??= { method: entry.method, written: 0, consumed: 0 };
    counts[entry.stage] += 1;
  }
  if (result.completed) {
    assert.equal(Object.keys(result.internalRpcCounts).length > 0, true);
    for (const counts of Object.values(result.internalRpcCounts)) { assert.equal(counts.written, 1); assert.equal(counts.consumed, 1); }
  }
  for (const [name, value] of Object.entries({ "result.json": result, "cli-results.json": cliResults, "desktop-messages.json": desktopMessages, "loopback-model-requests.json": modelRequests })) {
    fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
  }
  console.log(JSON.stringify({ completed: result.completed ?? false, fixtureError: result.fixtureError, nativeVersion: result.nativeVersion,
    toolCalls, modelRequests: modelRequests.length, runnerExit: result.runnerExit, cleanup: result.cleanup, resultPath: path.join(root, "result.json") }));
}
