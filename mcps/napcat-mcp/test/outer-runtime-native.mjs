import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { createCodexAppServerProxy, createWakeJournal } from "../src/codex-app-server-proxy.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(process.argv[2] ?? "");
const executable = path.resolve(process.argv[3] ?? "");
if (!path.basename(root).startsWith("outer-runtime-") || fs.existsSync(path.join(root, "result.json"))) throw new Error("ISOLATED_ATTEMPT_REQUIRED");
fs.mkdirSync(root, { recursive: true });
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const result = { startedAt: new Date().toISOString(), productionModified: false, sourceHashes: {}, ports: {}, assertions: {} };
for (const name of ["src/codex-app-server-proxy.mjs", "src/outer-engine.mjs", "src/outer-runtime.mjs", "src/outer-runtime-contract.mjs", "test/outer-runtime.test.mjs", "test/outer-runtime-native.mjs"]) result.sourceHashes[name] = digest(fs.readFileSync(path.join(repo, name)));
const record = (type, detail = {}) => fs.appendFileSync(path.join(root, "events.jsonl"), `${JSON.stringify({ at: Date.now(), type, ...detail })}\n`);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, label, milliseconds = 15000) {
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
const pending = new Map();
const responseCounts = new Map();
const proxyEvents = [];
const nativeTurns = [];
const gateConnections = [];
const gateRequests = new Map();
let client;
let native;
let model;
let gate;
let proxy;
let tool;
let toolCalls = 0;
let toolReplies = 0;
let clientCloses = 0;
let holdInspect = false;
let heldInspect = null;
let cancelResponse;
let identifier = 30;
const timers = new Set();
function rpc(method, params) {
  const id = ++identifier;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC_TIMEOUT:${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    record("desktop_rpc_sent", { id, method, params });
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
const wakeInput = (threadId, wakeId, prompt) => ({ taskId: "isolated-outer-runtime", generation: 1, threadId,
  localRole: "development", sourceMachine: "training", targetMachine: "development", trustedPeerQq: "1000000001",
  wakeId, prompt, pendingThroughSequence: identifier, pendingThroughTime: new Date().toISOString(), messageVisibility: "hidden" });
async function control(action, input, token = "isolated-control") {
  const response = await fetch(`http://127.0.0.1:${result.ports.control}/v1/outer-runtime${action ? `/${action}` : ""}`, {
    method: action ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(action ? { body: JSON.stringify(input) } : {}),
  });
  const output = { ...await response.json(), httpStatus: response.status }; record("runtime_control", { action, output }); return output;
}
try {
  const candidateRoot = path.join(root, "reviewed-engines"); fs.mkdirSync(candidateRoot);
  const contractUrl = pathToFileURL(path.join(repo, "src/outer-runtime-contract.mjs")).href;
  const fullEngineSource = fs.readFileSync(path.join(repo, "src/outer-engine.mjs"), "utf8");
  function moduleSource(version, reject = false) {
    let source = fullEngineSource.replace('"./outer-runtime-contract.mjs"', JSON.stringify(contractUrl))
      .replace('version: "original"', `version: ${JSON.stringify(version)}`)
      .replace('return { threadId: normalizedThreadId, found: true, thread: result.thread };', `return { threadId: normalizedThreadId, found: true, thread: result.thread, businessVersion: ${JSON.stringify(version)} };`);
    if (version === "v2") source = source
      .replace('requiredString(input.prompt, "prompt", 100000)', 'requiredString("V2::" + input.prompt, "prompt", 100000)')
      .replace('return client.reasoningPlaceholder.project(displayProjection);', 'const projected = client.reasoningPlaceholder.project(displayProjection);\n    return projected?.method === "item/agentMessage/delta" ? { ...projected, params: { ...projected.params, delta: "[v2]" + projected.params.delta } } : projected;');
    if (reject) source = source.replace('  async inspectThread(threadId)', '  beforeActivate() { throw new Error("ACTIVATION_REJECTED"); }\n\n  async inspectThread(threadId)');
    return source;
  }
  const sources = { "v1.mjs": moduleSource("v1"), "v2.mjs": moduleSource("v2"), "reject.mjs": moduleSource("reject", true), "bad.mjs": 'throw new Error("BAD_IMPORT");' };
  for (const [name, source] of Object.entries(sources)) fs.writeFileSync(path.join(candidateRoot, name), source);
  result.candidateHashes = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, { sha256: digest(source), bytes: Buffer.byteLength(source) }]));
  async function prepare(name) {
    const state = await control();
    return control("prepare", { instanceId: state.instanceId, revision: state.revision, candidate: name, sha256: digest(sources[name]) });
  }
  model = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const count = modelRequests.length + 1; modelRequests.push({ count, body }); record("model_request", { count, body });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const id = `resp_outer_${count}`;
    streamEvent(response, { type: "response.created", response: { id, object: "response", status: "in_progress", output: [] } });
    if (count === 2) {
      const item = { id: `fc_${id}`, type: "function_call", call_id: "outer_once", name: "counter_once", arguments: "{}", status: "completed" };
      streamEvent(response, { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: "" } });
      streamEvent(response, { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments });
      streamEvent(response, { type: "response.output_item.done", output_index: 0, item });
      streamEvent(response, { type: "response.completed", response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); response.end();
    } else if (count === 4) {
      cancelResponse = response;
      const item = { id: `msg_${id}`, type: "message", role: "assistant", status: "in_progress", content: [] };
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
  for (const name of Object.keys(env)) if (/^(OPENAI|CODEX|MCP)_/.test(name)) delete env[name];
  env.CODEX_HOME = home;
  result.nativeVersion = spawnSync(executable, ["--version"], { windowsHide: true, encoding: "utf8" }).stdout.trim();
  result.nativeExecutableSha256 = digest(fs.readFileSync(executable));
  result.ports.native = await port(); result.ports.downstream = await port(); result.ports.control = await port();
  const nativeArgs = ["app-server", "--listen", `ws://127.0.0.1:${result.ports.native}`];
  result.nativeCommand = [executable, ...nativeArgs];
  native = spawn(executable, nativeArgs, { cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  result.nativePid = native.pid; result.nativeCreatedAt = new Date().toISOString();
  native.stdout.on("data", chunk => fs.appendFileSync(path.join(root, "native.stdout.log"), chunk));
  native.stderr.on("data", chunk => fs.appendFileSync(path.join(root, "native.stderr.log"), chunk));
  native.once("exit", (code, signal) => { result.nativeExit = { code, signal, at: new Date().toISOString() }; record("native_exit", result.nativeExit); });
  await until(async () => {
    const socket = new net.Socket(); const connected = await new Promise(resolve => { socket.once("error", () => resolve(false)); socket.connect(result.ports.native, "127.0.0.1", () => resolve(true)); }); socket.destroy(); return connected;
  }, "native_listener");
  gate = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(gate, "listening"); result.ports.gate = gate.address().port;
  gate.on("connection", downstream => {
    const upstream = new WebSocket(`ws://127.0.0.1:${result.ports.native}`); const queued = []; const pair = { downstream, upstream }; gateConnections.push(pair);
    upstream.on("error", error => record("gate_error", { message: error.message }));
    upstream.on("open", () => { record("official_ws_connected"); for (const raw of queued.splice(0)) upstream.send(raw, { binary: false }); });
    downstream.on("message", raw => {
      const message = JSON.parse(raw.toString()); record("proxy_to_native", { message });
      if (message.id != null && message.method) gateRequests.set(message.id, message.method);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(raw, { binary: false }); else queued.push(raw);
    });
    upstream.on("message", raw => {
      const message = JSON.parse(raw.toString()); record("native_to_proxy", { message });
      if (holdInspect && !message.method && gateRequests.get(message.id) === "thread/read") {
        heldInspect = { raw, downstream, id: message.id }; record("actual_inspect_response_held", { id: message.id }); return;
      }
      downstream.send(raw, { binary: false });
    });
    downstream.on("close", () => upstream.close()); upstream.on("close", () => { if (downstream.readyState < WebSocket.CLOSING) downstream.close(); });
  });
  const journal = createWakeJournal({ filePath: path.join(root, "journal.json") });
  proxy = createCodexAppServerProxy({ upstreamUrl: `ws://127.0.0.1:${result.ports.gate}`, downstreamPort: result.ports.downstream,
    controlPort: result.ports.control, controlToken: "isolated-control", outerRuntimeRoot: candidateRoot, instanceToken: "isolated-runtime-instance",
    requestTimeoutMs: 15000, journal, onEvent: event => { proxyEvents.push(event); record("proxy_event", { event }); },
    onNativeTurn: event => { nativeTurns.push(event); record("on_native_turn", { event }); } });
  await proxy.start();
  result.wrongToken = await control("", null, "wrong-token"); assert.equal(result.wrongToken.httpStatus, 401);
  const first = await prepare("v1.mjs"); assert.equal(first.ok, true); assert.equal((await control("activate", first)).version, "v1");
  client = new WebSocket(`ws://127.0.0.1:${result.ports.downstream}`);
  client.on("error", error => record("desktop_error", { message: error.message })); client.on("close", () => { clientCloses += 1; });
  client.on("message", raw => {
    const message = JSON.parse(raw.toString()); downstreamMessages.push(message); record("desktop_received", { message });
    if (message.id != null && !message.method) {
      responseCounts.set(message.id, (responseCounts.get(message.id) ?? 0) + 1);
      const waiter = pending.get(message.id); if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result); }
    } else if (message.method === "item/tool/call") { tool = message; toolCalls += 1; fs.appendFileSync(path.join(root, "tool-effects.jsonl"), `${JSON.stringify({ callId: message.params.callId, invocation: toolCalls })}\n`); record("actual_tool_wait", { message }); }
  });
  await once(client, "open");
  await rpc("initialize", { clientInfo: { name: "outer_runtime_isolated_fixture", version: "1" }, capabilities: { experimentalApi: true } });
  client.send(JSON.stringify({ method: "initialized", params: {} }));
  const thread = (await rpc("thread/start", { cwd: root, model: "gpt-6-luna", modelProvider: "isolated", approvalPolicy: "never", sandbox: "danger-full-access",
    dynamicTools: [{ name: "counter_once", description: "Record an isolated checkpoint once", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] })).thread;
  const prelude = (await rpc("turn/start", { threadId: thread.id, input: [{ type: "text", text: "PRELUDE" }] })).turn;
  await until(() => completed(prelude.id), "prelude_persisted");
  result.oldWake = await proxy.wakeThread(wakeInput(thread.id, "old-wake", "OLD_WORK"));
  await until(() => tool, "actual_tool_wait");
  const originalClient = [...proxy.clients][0]; const originalUpstream = originalClient.upstream; const originalInjected = originalClient.injected; const originalQueue = originalClient.queued;
  holdInspect = true;
  const oldInspect = proxy.inspectThread(thread.id); oldInspect.catch(() => {});
  await until(() => heldInspect, "actual_inspect_response_held");
  const beforeJournal = fs.readFileSync(journal.filePath); result.before = proxy.status();
  const rawPath = await control("prepare", path.join(candidateRoot, "v2.mjs"));
  assert.equal(rawPath.ok, false); assert.equal(rawPath.error.code, "OUTER_RUNTIME_REQUEST_INVALID");
  const bounded = await control();
  const outside = await control("prepare", { instanceId: bounded.instanceId, revision: bounded.revision, candidate: "../journal.json", sha256: digest(beforeJournal) });
  assert.equal(outside.ok, false); assert.equal(outside.error.code, "OUTER_RUNTIME_PATH_OUTSIDE_ROOT");
  const bad = await prepare("bad.mjs"); assert.equal(bad.ok, false); assert.equal((await control()).version, "v1");
  const rejected = await prepare("reject.mjs"); assert.equal(rejected.ok, true); assert.equal((await control("activate", rejected)).ok, false); assert.equal((await control()).version, "v1");
  const second = await prepare("v2.mjs"); assert.equal(second.ok, true); assert.equal((await control("activate", second)).version, "v2");
  assert.equal(proxy.journal, journal); assert.equal([...proxy.clients][0], originalClient); assert.equal(originalClient.upstream, originalUpstream);
  assert.equal(originalClient.injected, originalInjected); assert.equal(originalClient.queued, originalQueue); assert.equal(fs.readFileSync(journal.filePath).equals(beforeJournal), true);
  result.assertions.sameStableObjects = true; result.assertions.journalUnchangedBySwitch = true;
  holdInspect = false; heldInspect.downstream.send(heldInspect.raw, { binary: false }); record("actual_inspect_response_released", { id: heldInspect.id });
  result.oldInspect = await oldInspect; assert.equal(result.oldInspect.businessVersion, "v1");
  client.send(JSON.stringify({ id: tool.id, result: { success: true, contentItems: [{ type: "inputText", text: "ONCE_OK" }] } })); toolReplies += 1; record("actual_tool_reply", { id: tool.id });
  await until(() => completed(result.oldWake.turn.id), "old_turn_completed");
  assert.equal(downstreamMessages.some(message => message.method === "item/agentMessage/delta" && message.params.delta === "OLD_DONE"), true);
  result.newInspect = await proxy.inspectThread(thread.id); assert.equal(result.newInspect.businessVersion, "v2");
  result.newWake = await proxy.wakeThread(wakeInput(thread.id, "new-wake", "CANCEL_WORK"));
  await until(() => downstreamMessages.some(message => message.method === "item/agentMessage/delta" && message.params.delta === "[v2]CANCEL_STREAM"), "new_business_projection");
  assert.equal(JSON.stringify(modelRequests.at(-1).body).includes("V2::CANCEL_WORK"), true);
  const newVersionState = await control(); assert.equal((await control("restore", { instanceId: newVersionState.instanceId, revision: newVersionState.revision })).version, "v1");
  await rpc("turn/interrupt", { threadId: thread.id, turnId: result.newWake.turn.id });
  await until(() => completed(result.newWake.turn.id), "cancelled_turn_completed");
  assert.equal(completed(result.newWake.turn.id).params.turn.status, "interrupted");
  const cancelObservation = proxyEvents.find(event => event.type === "outer_runtime" && event.action === "downstream" && event.method === "turn/interrupt");
  assert.equal(cancelObservation.version, "v2"); result.assertions.cancelRetainsOriginalVersion = true;
  result.restoredWake = await proxy.wakeThread(wakeInput(thread.id, "restored-wake", "RESTORED_WORK"));
  await until(() => completed(result.restoredWake.turn.id), "restored_turn_completed");
  assert.equal(JSON.stringify(modelRequests.at(-1).body).includes("V2::RESTORED_WORK"), false);
  result.reloadedJournal = createWakeJournal({ filePath: journal.filePath }).status(); assert.equal(result.reloadedJournal.wakeCount, 3);
  const persisted = JSON.parse(fs.readFileSync(journal.filePath, "utf8"));
  assert.deepEqual(persisted.wakes["old-wake"], JSON.parse(beforeJournal.toString()).wakes["old-wake"]);
  for (const wakeId of ["old-wake", "new-wake", "restored-wake"]) {
    assert.equal(persisted.wakes[wakeId].attempt, 1);
    assert.equal(proxyEvents.filter(event => event.type === "display_reminder_bound" && event.wakeId === wakeId).length, 1);
  }
  result.assertions.journalOldEntryPreserved = true;
  result.after = proxy.status();
  assert.equal(toolCalls, 1); assert.equal(toolReplies, 1); assert.equal(gateConnections.length, 1); assert.equal(clientCloses, 0);
  assert.equal(proxyEvents.filter(event => event.type === "upstream_connected").length, 1);
  assert.equal(result.after.clients[0].pendingInjectionCount, 0); assert.equal(result.after.outerRuntime.trackedRequestCount, 0);
  assert.equal([...responseCounts.values()].every(count => count === 1), true);
  const internal = proxyEvents.filter(event => event.type === "outer_runtime" && event.action === "injected_request");
  const consumed = proxyEvents.filter(event => event.type === "outer_runtime" && event.action === "injected_response");
  assert.equal(internal.every(request => consumed.filter(response => response.id === request.id).length === 1), true);
  assert.equal(nativeTurns.filter(event => event.method === "turn/started").length, 4); assert.equal(nativeTurns.filter(event => event.method === "turn/completed").length, 4);
  result.assertions.oneConnection = true; result.assertions.toolOnce = true; result.assertions.internalRpcExactlyOnce = true;
  result.counts = { toolCalls, toolReplies, clientClosesDuringSwitch: clientCloses, modelRequests: modelRequests.length,
    internalRpcWritten: internal.length, internalRpcConsumed: consumed.length, nativeTurns: nativeTurns.length };
  result.ok = true;
} catch (error) {
  result.ok = false; result.error = { message: error.message, stack: error.stack }; record("failure", result.error); process.exitCode = 1;
} finally {
  for (const timer of timers) clearTimeout(timer);
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("FIXTURE_CLOSED")); }
  pending.clear(); cancelResponse?.destroy();
  if (client?.readyState === WebSocket.OPEN) { client.close(); await once(client, "close"); }
  await proxy?.close();
  for (const pair of gateConnections) { pair.downstream.close(); pair.upstream.close(); }
  if (gate) await new Promise(resolve => gate.close(resolve));
  if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
  if (native && native.exitCode === null && native.signalCode === null) {
    native.stdin.end();
    await Promise.race([once(native, "exit"), sleep(1500)]);
    if (native.exitCode === null && native.signalCode === null) { record("isolated_native_termination_requested"); native.kill(); await once(native, "exit"); }
  }
  result.finishedAt = new Date().toISOString(); result.cleanup = { desktopClosed: !client || client.readyState === WebSocket.CLOSED,
    proxyClosed: proxy?.status().closed ?? true, nativeExited: !native || native.exitCode !== null || native.signalCode !== null, gateClosed: !gate || !gate.address(), modelClosed: !model || !model.listening };
  result.outputHashes = Object.fromEntries(["events.jsonl", "journal.json", "tool-effects.jsonl", "native.stdout.log", "native.stderr.log"].filter(name => fs.existsSync(path.join(root, name))).map(name => [name, digest(fs.readFileSync(path.join(root, name)))]));
  fs.writeFileSync(path.join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ok: result.ok, error: result.error?.message, counts: result.counts, cleanup: result.cleanup, evidence: root }));
}
