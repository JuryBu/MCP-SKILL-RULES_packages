import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const repository = fileURLToPath(new URL("../", import.meta.url));
const [codexPath, fixturePath] = process.argv.slice(2);
if (!codexPath || !fixturePath || !path.isAbsolute(codexPath) || !path.isAbsolute(fixturePath)) throw new Error("ABSOLUTE_NATIVE_INPUTS_REQUIRED");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-inner-official-startup-"));
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const result = { schemaVersion: 1, root, startedAt: new Date().toISOString(), productionModified: false,
  paidModelCalls: false, manualNativeRelay: false, assertions: [], operations: [], turns: [], cleanup: [] };
const write = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
const append = (name, value) => fs.appendFileSync(path.join(root, name), JSON.stringify(value) + "\n");
function check(name, condition, extra = {}) {
  result.assertions.push({ name, passed: Boolean(condition), ...extra });
  write("progress.json", result);
  if (!condition) throw new Error(`ASSERTION_FAILED:${name}`);
}
async function until(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const actual = await predicate(); if (actual) return actual; await sleep(30); }
  throw new Error(`TIMEOUT:${label}`);
}
async function unusedPort() {
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
const frozenRoot = path.join(root, "source-build");
const manifest = [];
const collected = new Set();
function collect(relative) {
  relative = relative.replaceAll("\\", "/");
  if (collected.has(relative)) return;
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("SOURCE_ESCAPE");
  collected.add(relative);
  const origin = path.join(repository, relative);
  const bytes = fs.readFileSync(origin);
  const target = path.join(frozenRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: "wx" });
  manifest.push({ relative, bytes: bytes.length, sha256: digest(bytes), origin });
  if (relative.endsWith(".mjs")) {
    for (const match of bytes.toString().matchAll(/["'](\.\.?\/[\w./-]+\.mjs)["']/gu)) collect(path.normalize(path.join(path.dirname(relative), match[1])));
  }
}
for (const relative of ["src/codex-app-server-proxy-runner.mjs", "src/codex-model-stream-proxy-runner.mjs",
  "ops/start-codex-model-stream-proxy.ps1", "ops/start-codex-app-server-proxy.ps1", "ops/get-codex-model-stream-proxy-status.ps1",
  "ops/resolve-codex-outer-runtime-startup.ps1", "ops/resolve-napcat-data-root.ps1"]) collect(relative);
function collectPackage(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) collectPackage(target); else collect(path.relative(repository, target));
  }
}
collectPackage(path.join(repository, "node_modules", "ws"));
if (manifest.some(entry => digest(fs.readFileSync(entry.origin)) !== entry.sha256)) throw new Error("SOURCE_CHANGED_DURING_FREEZE");
const fixture = fs.readFileSync(fixturePath, "utf8");
const helperStart = fixture.indexOf("function event(response, value)");
const helperEnd = fixture.indexOf("async function newThread()", helperStart);
if (helperStart < 0 || helperEnd < 0) throw new Error("LOOPBACK_HELPERS_NOT_FOUND");
const helperPath = path.join(root, "responses-fixture.mjs");
fs.writeFileSync(helperPath, fixture.slice(helperStart, helperEnd) + "\nexport {event,completeText,completeTool};\n");
const { event, completeText, completeTool } = await import(pathToFileURL(helperPath).href);
const { parseArguments } = await import(pathToFileURL(path.join(frozenRoot, "src/codex-app-server-proxy-runner.mjs")).href);
const dataRoot = path.join(root, "data");
const outerStateRoot = path.join(dataRoot, "state");
const stateRoot = path.join(outerStateRoot, "inner-managed");
const checkpointRoot = path.join(stateRoot, "checkpoints");
const codexHome = path.join(root, "codex-home");
const candidateRoot = path.join(outerStateRoot, "outer-candidates");
for (const target of [stateRoot, checkpointRoot, codexHome, candidateRoot]) fs.mkdirSync(target, { recursive: true });
const profile = { schemaVersion: 1, mode: "production", ownerId: "official-startup-owned", nativeSourceId: "official-startup-native",
  stateRoot, outerStateRoot, checkpointRoot, codexHome, installationRoot: frozenRoot, approvedUpstreamOrigin: "https://chatgpt.com", ports: {},
  workerLifecycle: { recycleRetiredWorkers: true },
  managedStatePath: path.join(stateRoot, "managed-runtime.json"), initial: { runnerPath: path.join(frozenRoot, "src/codex-model-stream-proxy-runner.mjs") },
  environment: { MODEL_OBSERVER_ENABLED: "false", CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100", WS_NO_BUFFER_UTIL: "1", WS_NO_UTF_8_VALIDATE: "1" } };
const seedRoot = path.join(root, "initial-state-files");
fs.mkdirSync(seedRoot);
const { createAdaptiveDeliveryRegistry } = await import(pathToFileURL(path.join(frozenRoot, "src/adaptive-delivery.mjs")).href);
profile.initialStateFiles = Object.entries({ "codex-model-stream-delivery-profiles.json": { schemaVersion: 1, bufferedToolIdentityHashes: [] },
  "codex-model-adaptive-delivery.json": createAdaptiveDeliveryRegistry().snapshot() }).map(([name, value]) => {
  const sourcePath = path.join(seedRoot, name), bytes = Buffer.from(JSON.stringify(value));
  fs.writeFileSync(sourcePath, bytes, { flag: "wx" });
  return { name, sourcePath, bytes: bytes.length, sha256: digest(bytes) };
});
for (const [target, kind] of [[stateRoot, "state"], [checkpointRoot, "checkpoint"]]) fs.writeFileSync(path.join(target, ".inner-runtime-owner.json"),
  JSON.stringify({ schemaVersion: 1, ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId, kind }));
const hashes = targetRoot => Object.fromEntries(Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
  helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" }).map(([key, name]) => [key, digest(fs.readFileSync(path.join(targetRoot, "src", name)))]));
profile.initial.expectedHashes = hashes(frozenRoot);
const targetRoot = path.join(root, "candidate-build");
for (const entry of manifest.filter(entry => entry.relative.startsWith("src/"))) {
  const target = path.join(targetRoot, entry.relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(frozenRoot, entry.relative), target);
}
const candidateCorePath = path.join(targetRoot, "src/codex-model-stream-proxy.mjs");
const candidateCore = fs.readFileSync(candidateCorePath, "utf8");
const diagnostic = "Three distinct turns ended without model text or completed tool work. The proxy stopped native retry for this turn.";
if (!candidateCore.includes(diagnostic)) throw new Error("CANDIDATE_DIAGNOSTIC_NOT_FOUND");
fs.writeFileSync(candidateCorePath, candidateCore.split(diagnostic).join(diagnostic + " OWNED_NATIVE_RELEASE: compatible cross-turn recovery state is retained."));
fs.writeFileSync(path.join(targetRoot, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1, kind: "candidate", ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId }));
profile.approvedCandidates = [{ id: "native-release-two", installationRoot: targetRoot,
  runnerPath: path.join(targetRoot, "src/codex-model-stream-proxy-runner.mjs"), expectedHashes: hashes(targetRoot) },
  { id: "native-original-fresh", installationRoot: frozenRoot, runnerPath: profile.initial.runnerPath, expectedHashes: profile.initial.expectedHashes }];
fs.writeFileSync(path.join(frozenRoot, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1, kind: "candidate", ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId }));
for (const name of ["inner", "downstream", "control", "upstream", "probe"]) profile.ports[name] = await unusedPort();
profile.innerPort = profile.ports.inner;
const outerPaths = { "runtime-state": "codex-app-server-proxy-runtime.json", log: "codex-app-server-proxy.jsonl", "stop-file": "codex-app-server-proxy.stop",
  lock: "codex-app-server-proxy.lock", journal: "codex-app-server-wake-journal.json", "token-file": "codex-app-server-proxy-token.txt",
  "maintenance-file": "task-router.maintenance.json", "alert-file": "automation-alert.json", "fallback-file": "codex-app-server-proxy-fallback.json" };
const argv = Object.entries(outerPaths).flatMap(([name, file]) => [`--${name}`, path.join(outerStateRoot, file)]);
argv.push("--codex-exe", codexPath, "--outer-runtime-root", candidateRoot);
for (const name of ["downstream", "control", "upstream", "probe"]) argv.push(`--${name}-port`, String(profile.ports[name]));
const options = parseArguments(argv);
profile.outerPaths = Object.fromEntries(Object.entries(options).filter(([name, value]) => name.endsWith("Path") && !["executablePath", "launchReceiptPath", "innerManagedProfilePath"].includes(name) && value !== null));
profile.outerPaths.outerRuntimeRoot = candidateRoot;
const token = crypto.randomBytes(32).toString("hex"); fs.writeFileSync(options.tokenFilePath, token);
profile.controlTokenSha256 = digest(Buffer.from(token));
const profilePath = path.join(stateRoot, "inner-managed-profile.json");
let modelMode = "quota";
let upstream;
let client;
let managedPid;
let managedInstance;
let toolCalls = 0;
const modelRequests = [];
const messages = [];
const waiters = new Map();
let sequence = 0;
const environment = { ...process.env, CODEX_HOME: codexHome, CODEX_TOOLKIT_NODE_EXE: process.execPath,
  HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" };
for (const name of Object.keys(environment)) if (/^(OPENAI|ANTHROPIC|GEMINI|MODEL_OBSERVER|AZURE_OPENAI)_/u.test(name)) delete environment[name];
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
async function executePs(name, relative, argumentsList) {
  const command = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(frozenRoot, relative), ...argumentsList];
  const child = spawn(powershell, command, { env: environment, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes.toString(); }); child.stderr.on("data", bytes => { stderr += bytes.toString(); });
  const [exitCode, signal] = await once(child, "exit");
  const operation = { name, command: [powershell, ...command], exitCode, signal, stdout, stderr };
  result.operations.push(operation); write("powershell-results.json", result.operations);
  if (exitCode !== 0) throw new Error(`NORMAL_PS_FAILED:${name}:${stderr}`);
  return JSON.parse(stdout.replace(/^\uFEFF/u, ""));
}
async function status() {
  const response = await fetch(`http://127.0.0.1:${profile.ports.control}/v1/inner/status`, { headers: { authorization: `Bearer ${token}`,
    "x-inner-owner-id": profile.ownerId, "x-inner-native-source-id": profile.nativeSourceId, "x-inner-instance-token": managedInstance } });
  const body = await response.json(); if (response.status !== 200) throw new Error(`CONTROL_STATUS:${response.status}:${JSON.stringify(body)}`); return body;
}
async function control(method, fields) {
  const current = await status();
  const input = { ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId, instanceToken: managedInstance, requestId: crypto.randomUUID(),
    expectedRevision: current.revision, selectedWorkerId: current.selectedWorkerId, selectedSourceHashes: current.selectedSourceHashes, ...fields };
  const startedAt = Date.now();
  const response = await fetch(`http://127.0.0.1:${profile.ports.control}/v1/inner/${method}`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json(); result.operations.push({ method, input, body, httpStatus: response.status, actualMs: Date.now() - startedAt });
  if (response.status !== 200 || body.ok !== true) throw new Error(`CONTROL_RESULT:${JSON.stringify(body)}`); return body.result;
}
function rpc(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`RPC_TIMEOUT:${method}`)); }, 30000);
    waiters.set(id, { resolve, reject, timer }); client.send(JSON.stringify({ id, method, params }));
  });
}
async function turn(threadId, label) {
  const started = await rpc("turn/start", { threadId, input: [{ type: "text", text: label }] });
  const completion = await until(() => messages.find(message => message.method === "turn/completed" && message.params?.turn?.id === started.turn.id), label);
  const current = await until(async () => { const actual = await status(); return actual.coordinator.threads.some(thread => thread.threadId === threadId && thread.phase === "terminal" && thread.activeHttp === 0) ? actual : null; }, "native-terminal");
  const completed = { label, turnId: started.turn.id, completion, status: current };
  result.turns.push(completed); check(label + " completed", completion.params.turn.status === "completed"); return completed;
}
try {
  upstream = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks); const metadata = JSON.parse(request.headers["x-codex-turn-metadata"] ?? "{}");
    const entry = { at: new Date().toISOString(), mode: modelMode, metadata, requestSha256: digest(body) };
    modelRequests.push(entry); append("model-requests.jsonl", entry);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const responseId = `resp_normal_owned_${modelRequests.length}`;
    event(response, { type: "response.created", response: { id: responseId, object: "response", status: "in_progress", output: [] } });
    if (modelMode === "tool") completeTool(response, responseId);
    else if (modelMode === "text") completeText(response, responseId, "OWNED_OFFICIAL_NORMAL_TOOL_COMPLETED");
    else { event(response, { type: "response.failed", response: { id: responseId, status: "failed", error: { code: "usage_limit_reached", message: "OWNED_SYNTHETIC_QUOTA" } } }); response.end(); }
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  profile.upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  fs.writeFileSync(path.join(codexHome, "config.toml"), `model = "gpt-6-luna"\nmodel_reasoning_effort = "max"\nmodel_provider = "isolated"\n[model_providers.isolated]\nname = "isolated"\nbase_url = "http://127.0.0.1:${profile.innerPort}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nstream_max_retries = 5\nstream_idle_timeout_ms = 150000\n`);
  fs.writeFileSync(profilePath, JSON.stringify(profile));
  fs.writeFileSync(path.join(outerStateRoot, "codex-outer-runtime-startup.json"), JSON.stringify({ schemaVersion: 1, enabled: true, candidateRoot,
    innerManagedProfilePath: profilePath, innerManagedProfileSha256: digest(fs.readFileSync(profilePath)) }));
  result.manifest = manifest; result.profile = profile; result.nativeExecutablePath = codexPath; result.fixtureSha256 = digest(Buffer.from(fixture));
  write("intent.json", result);
  result.started = await executePs("normal-inner-start", "ops/start-codex-model-stream-proxy.ps1", ["-DataRoot", dataRoot, "-CodexExecutablePath", codexPath]);
  const runtime = JSON.parse(fs.readFileSync(options.runtimeStatePath, "utf8")); managedPid = runtime.pid; managedInstance = runtime.instanceToken;
  check("normal WinPS delegates to real managed runner", result.started.mode === "managed" && result.started.running && result.started.pid === managedPid);
  client = new WebSocket(runtime.downstreamUrl);
  client.on("message", bytes => {
    const message = JSON.parse(bytes.toString()); messages.push(message); append("native-websocket.jsonl", message);
    if (message.method === "item/tool/call" && message.params?.tool === "counter_once") {
      toolCalls += 1; modelMode = "text"; append("tool-effects.jsonl", { invocation: toolCalls, params: message.params });
      client.send(JSON.stringify({ id: message.id, result: { success: true, contentItems: [{ type: "inputText", text: "OWNED_TOOL_ONCE" }] } }));
    }
    const waiting = waiters.get(message.id);
    if (waiting) { clearTimeout(waiting.timer); waiters.delete(message.id); if (message.error) waiting.reject(new Error(JSON.stringify(message.error))); else waiting.resolve(message.result); }
  });
  await once(client, "open");
  result.initialize = await rpc("initialize", { clientInfo: { name: "owned_normal_startup", version: "1.0.0" }, capabilities: { experimentalApi: true } });
  client.send(JSON.stringify({ method: "initialized", params: {} }));
  check("official native initialization", /codex/iu.test(result.initialize.userAgent));
  const thread = await rpc("thread/start", { cwd: root, model: "gpt-6-luna", modelProvider: "isolated", approvalPolicy: "never", sandbox: "danger-full-access",
    ephemeral: false, dynamicTools: [{ name: "counter_once", description: "One owned synthetic effect", inputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false } }] });
  const threadId = thread.thread.id; result.threadId = threadId;
  const oldStatus = await status(); result.originalWorkerId = oldStatus.selectedWorkerId;
  await turn(threadId, "FIRST_QUOTA"); await turn(threadId, "SECOND_QUOTA");
  result.prepared = await control("prepare", { candidateId: "native-release-two" });
  const source = profile.initial.expectedHashes, target = profile.approvedCandidates[0].expectedHashes;
  const compatibilityManifest = { schemaVersion: 1, edges: [[source, target], [target, source]].map(([before, after]) => ({ source: { core: before.core, helper: before.helper },
    target: { core: after.core, helper: after.helper }, checkpointSchemaVersion: 1, stateSchemaVersion: 1, stateSemantics: "state-v1" })) };
  const compatibility = { manifest: compatibilityManifest, sha256: digest(JSON.stringify(compatibilityManifest)) };
  result.migrated = await control("migrate", { candidateId: result.prepared.workerId, threadId, compatibility });
  check("real external migration completes within five seconds", result.migrated.committed && result.operations.at(-1).actualMs < 5000);
  const checkpoint = fs.readFileSync(result.migrated.accepted.readPath);
  result.checkpoint = { sha256: digest(checkpoint), payload: JSON.parse(checkpoint).payload };
  check("two old empty-turn counts retained", result.checkpoint.payload.snapshot.state.emptyIdleTurns[0]?.[1]?.count === 2);
  modelMode = "tool"; await turn(threadId, "MIGRATED_TOOL_CONTINUE");
  check("actual dynamic tool executes exactly once", toolCalls === 1);
  result.freshOriginal = await control("prepare", { candidateId: "native-original-fresh" });
  result.restored = await control("migrate", { candidateId: result.freshOriginal.workerId, threadId, compatibility });
  check("original source bytes restored to a fresh worker within five seconds", result.restored.committed && result.operations.at(-1).actualMs < 5000
    && result.restored.target.core === source.core && result.restored.target.pid !== result.migrated.source.pid);
  await turn(threadId, "RESTORED_TEXT_CONTINUE");
  result.rollingMigrations = [];
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const candidateId = iteration % 2 === 0 ? "native-release-two" : "native-original-fresh";
    const prepared = await control("prepare", { candidateId });
    const migrated = await control("migrate", { candidateId: prepared.workerId, threadId, compatibility });
    const current = await status();
    const aliveWorkers = current.coordinator.workers.filter(worker => worker.alive).length;
    result.rollingMigrations.push({ iteration, candidateId, prepared, migrated, status: current, aliveWorkers });
    check(`rolling migration ${iteration + 1} retains bounded workers`, migrated.committed && result.operations.at(-1).actualMs < 5000 && aliveWorkers <= 4);
    await turn(threadId, `ROLLING_TEXT_CONTINUE_${iteration + 1}`);
  }
  result.statusFromPs = await executePs("normal-inner-status", "ops/get-codex-model-stream-proxy-status.ps1", ["-DataRoot", dataRoot]);
  check("normal WinPS reads real manager health", result.statusFromPs.running && result.statusFromPs.healthy && result.statusFromPs.instanceToken === managedInstance);
  check("one WebSocket and original official runner kept", JSON.parse(fs.readFileSync(options.runtimeStatePath, "utf8")).pid === managedPid && client.readyState === WebSocket.OPEN);
  result.functionalCompleted = true;
} catch (error) { result.error = String(error.stack ?? error); process.exitCode = 1; }
finally {
  for (const waiting of waiters.values()) { clearTimeout(waiting.timer); waiting.reject(new Error("OWNED_TEST_CLOSING")); } waiters.clear();
  if (client && client.readyState < WebSocket.CLOSING) { const closed = once(client, "close"); client.close(); await closed; }
  if (managedPid) {
    const stopBytes = JSON.stringify({ ownerId: profile.ownerId, instanceToken: managedInstance, testStop: crypto.randomUUID() });
    if (!fs.existsSync(options.stopFilePath)) fs.writeFileSync(options.stopFilePath, stopBytes, { flag: "wx" });
    try {
      const closed = await until(() => { try { const actual = JSON.parse(fs.readFileSync(profile.managedStatePath, "utf8")); return actual.state === "closed" ? actual : null; } catch { return null; } }, "normal-managed-stop", 30000);
      result.closed = closed;
      check("all owned workers close normally", closed.coordinator.workers.every(worker => !worker.alive && worker.exitCode === 0));
      check("official child ended through normal runner", closed.outerResult?.state === "stopped" && closed.outerResult?.appServerPid == null);
    } catch (error) { result.cleanup.push(String(error)); process.exitCode = 1; }
  }
  if (upstream?.listening) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  result.portsReleased = [];
  for (const port of Object.values(profile.ports)) {
    const listener = net.createServer(); const released = await new Promise(resolve => { listener.once("error", () => resolve(false)); listener.listen(port, "127.0.0.1", () => listener.close(() => resolve(true))); });
    result.portsReleased.push({ port, released }); if (!released) process.exitCode = 1;
  }
  for (const entry of manifest) if (digest(fs.readFileSync(path.join(frozenRoot, entry.relative))) !== entry.sha256) { result.cleanup.push(`FROZEN_BYTES_CHANGED:${entry.relative}`); process.exitCode = 1; }
  result.sourceStillMatches = manifest.every(entry => digest(fs.readFileSync(entry.origin)) === entry.sha256);
  result.finishedAt = new Date().toISOString(); write("result.json", result);
  console.log(JSON.stringify({ root, functionalCompleted: result.functionalCompleted ?? false, error: result.error ?? null,
    cleanupErrors: result.cleanup, checks: result.assertions.length, allPassed: result.assertions.every(checkpoint => checkpoint.passed), portsReleased: result.portsReleased }));
}
