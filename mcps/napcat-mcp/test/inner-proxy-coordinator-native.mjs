import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

const [fixturePath, runId, scenario, frozenRootArgument] = process.argv.slice(2);
const scenarios = ["freeze", "quota-handoff", "split-threads", "listen-failure", "accept-refusal", "startup-failure", "exit-after-accept"];
if (!fixturePath || !/^inner-coordinator-0147-[a-z0-9-]+$/u.test(runId ?? "") || !scenarios.includes(scenario)) {
  throw new Error("INVALID_COORDINATOR_NATIVE_ARGUMENTS");
}
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const driverPath = fileURLToPath(import.meta.url);
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const tempRoot = path.join(os.tmpdir(), "napcat-hot-switch-20261010");
const runRoot = path.join(tempRoot, runId);
fs.mkdirSync(tempRoot, { recursive: true });
fs.mkdirSync(runRoot);
const write = (name, value) => fs.writeFileSync(path.join(runRoot, name), JSON.stringify(value, null, 2));
const append = (name, value) => fs.appendFileSync(path.join(runRoot, name), `${JSON.stringify(value)}\n`);
const fixture = fs.readFileSync(fixturePath, "utf8");
const fixtureSha256 = digest(fixture);
if (fixtureSha256 !== "583b022c813ce2c18813b26ab3cffa5220a2b8e6ff89fe712740993a57eeb035") {
  throw new Error("UNREVIEWED_OFFICIAL_NATIVE_FIXTURE");
}
const codexPath = fixture.match(/^const codexPath = '([^'\r\n]+)';$/mu)?.[1];
const helperStart = fixture.indexOf("function event(response, value)");
const helperEnd = fixture.indexOf("async function newThread()", helperStart);
if (!codexPath || helperStart < 0 || helperEnd < 0) throw new Error("NATIVE_FIXTURE_HELPERS_CHANGED");
const helpersPath = path.join(runRoot, "responses-fixture.mjs");
const helpers = `${fixture.slice(helperStart, helperEnd)}\nexport { event, completeText, completeTool };\n`;
fs.writeFileSync(helpersPath, helpers);
const { event, completeText, completeTool } = await import(pathToFileURL(helpersPath).href);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function collectDependencies(root) {
  const collected = new Map();
  function visit(relative) {
    if (collected.has(relative)) return;
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("DEPENDENCY_OUTSIDE_SOURCE");
    const bytes = fs.readFileSync(path.join(root, relative));
    collected.set(relative, { relative, bytes, sha256: digest(bytes) });
    for (const match of bytes.toString("utf8").matchAll(/["'](\.\/[\w./-]+\.mjs)["']/gu)) {
      visit(path.normalize(path.join(path.dirname(relative), match[1])));
    }
  }
  visit("inner-proxy-coordinator.mjs");
  visit("codex-model-stream-proxy-runner.mjs");
  return [...collected.values()];
}

function manifestOf(root, entries) {
  return entries.map(entry => {
    const bytes = fs.readFileSync(path.join(root, entry.relative));
    return { relative: entry.relative, sha256: digest(bytes), bytes: bytes.length };
  });
}

function assertManifest(root, entries) {
  if (!entries.every(entry => digest(fs.readFileSync(path.join(root, entry.relative))) === entry.sha256)) {
    throw new Error("FROZEN_BUILD_BYTES_CHANGED");
  }
}

let frozenRoot;
let sourceManifest;
if (scenario === "freeze") {
  if (frozenRootArgument) throw new Error("FREEZE_INPUT_NOT_ALLOWED");
  const dependencies = collectDependencies(sourceRoot);
  frozenRoot = path.join(runRoot, "source-build");
  for (const entry of dependencies) {
    const destination = path.join(frozenRoot, entry.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, entry.bytes, { flag: "wx" });
  }
  sourceManifest = manifestOf(frozenRoot, dependencies);
  assertManifest(sourceRoot, sourceManifest);
  assertManifest(frozenRoot, sourceManifest);
  fs.copyFileSync(driverPath, path.join(runRoot, "driver-frozen.mjs"));
  write("frozen-build.json", { testOnly: true, frozenAt: new Date().toISOString(), sourceRoot, frozenRoot,
    sourceManifest, manifestSha256: digest(JSON.stringify(sourceManifest)), fixturePath, fixtureSha256,
    driverSha256: digest(fs.readFileSync(driverPath)), helpersSha256: digest(helpers) });
  console.log(JSON.stringify({ frozenRoot, sourceManifest, sourceStableDuringFreeze: true }));
  process.exitCode = 0;
} else {
  if (!frozenRootArgument) throw new Error("FROZEN_BUILD_REQUIRED");
  frozenRoot = fs.realpathSync(frozenRootArgument);
  const relative = path.relative(fs.realpathSync(tempRoot), frozenRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("BUILD_NOT_IN_OWNED_TEMP");
  const frozen = JSON.parse(fs.readFileSync(path.join(frozenRoot, "..", "frozen-build.json"), "utf8"));
  sourceManifest = frozen.sourceManifest;
  if (digest(JSON.stringify(sourceManifest)) !== frozen.manifestSha256) throw new Error("FROZEN_MANIFEST_HASH_MISMATCH");
  assertManifest(frozenRoot, sourceManifest);
  await runNativeScenario();
}

async function runNativeScenario() {
  const { createInnerProxyCoordinator } = await import(pathToFileURL(path.join(frozenRoot, "inner-proxy-coordinator.mjs")).href);
  const result = { scenario, runRoot, frozenRoot, startedAt: new Date().toISOString(), harnessPid: process.pid,
    command: [process.execPath, driverPath, fixturePath, runId, scenario, frozenRootArgument], nodeVersion: process.version,
    platform: process.platform, architecture: process.arch, fixtureSha256, helpersSha256: digest(helpers),
    driverSha256: digest(fs.readFileSync(driverPath)), sourceManifest,
    sourceManifestSha256: digest(JSON.stringify(sourceManifest)),
    compatibilityFixtureSha256: digest(fs.readFileSync(new URL("./inner-handoff-compatibility-native.mjs", import.meta.url))),
    nativeExecutable: { path: codexPath, sha256: digest(fs.readFileSync(codexPath)) },
    productionModified: false, paidModelCalls: false, manuallySelectedRoutes: false, fabricatedNativeEvents: false,
    assertions: [], turns: [], steps: [], cleanup: [],
    unverified: ["production installation or activation", "Desktop GUI", "legacy runner lacking handoff IPC", "cross-machine deployment"] };
  const nativeEvents = [];
  const coordinatorEvents = [];
  const modelRequests = [];
  const modes = new Map();
  const nativePending = new Map();
  const nativeState = new Map();
  const relayErrors = [];
  const childRecords = [];
  const observedPorts = new Set();
  const nativeSourceId = `${runId}:official-app-server`;
  const checkpoints = path.join(runRoot, "checkpoints");
  fs.mkdirSync(checkpoints);
  const environment = {};
  const nativeEnvironment = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^(OPENAI|CODEX|MCP|ANTHROPIC|GEMINI|MODEL_OBSERVER|AZURE_OPENAI)_/u.test(key)) {
      environment[key] = "";
      delete nativeEnvironment[key];
    }
  }
  Object.assign(environment, { HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost", MODEL_OBSERVER_ENABLED: "false",
    CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100", CODEX_MODEL_STREAM_PROXY_DRAIN_TIMEOUT_MS: "1000" });
  Object.assign(nativeEnvironment, environment);
  let coordinator;
  let upstream;
  let occupied;
  let native;
  let toolRequest;
  let toolCalls = 0;
  let nativeSequence = 0;
  let relay = Promise.resolve();
  let targetRoot;
  let targetManifest;
  let compatibility;
  let oldWorkerId;
  write("intent.json", result);

  function record(type, fields = {}) {
    const entry = { at: new Date().toISOString(), type, ...fields };
    result.steps.push(entry);
    write("progress.json", result);
    console.log(JSON.stringify(entry));
  }

  function check(name, condition, fields = {}) {
    const entry = { name, passed: Boolean(condition), ...fields };
    result.assertions.push(entry);
    write("progress.json", result);
    if (!condition) throw new Error(`ASSERTION_FAILED:${name}`);
  }

  async function waitUntil(predicate, timeout, label) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await sleep(35);
    }
    throw new Error(`TIMEOUT:${label}`);
  }

  function hashes(root) {
    return Object.fromEntries(Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
      helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })
      .map(([key, fileName]) => [key, digest(fs.readFileSync(path.join(root, fileName)))]));
  }

  function specification(root, extra = {}) {
    return { runnerPath: path.join(root, "codex-model-stream-proxy-runner.mjs"), expectedHashes: hashes(root), ...extra };
  }

  function buildTarget(fault) {
    if (targetRoot) throw new Error("TARGET_ALREADY_BUILT");
    targetRoot = path.join(runRoot, "target-build");
    for (const entry of sourceManifest) {
      const destination = path.join(targetRoot, entry.relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(frozenRoot, entry.relative), destination);
    }
    const corePath = path.join(targetRoot, "codex-model-stream-proxy.mjs");
    const originalCore = fs.readFileSync(corePath, "utf8");
    const oldDiagnostic = "Three distinct turns ended without model text or completed tool work. The proxy stopped native retry for this turn.";
    const newDiagnostic = `${oldDiagnostic} COMPAT_V2_DIAGNOSIS: the cross-turn recovery budget is exhausted; completed model or tool progress clears the empty-turn count.`;
    if (originalCore.split(oldDiagnostic).length !== 3) throw new Error("CORE_DIAGNOSTIC_PATTERN_CHANGED");
    fs.writeFileSync(corePath, originalCore.split(oldDiagnostic).join(newDiagnostic));
    if (fault === "startup-failure") {
      const runnerPath = path.join(targetRoot, "codex-model-stream-proxy-runner.mjs");
      const original = fs.readFileSync(runnerPath, "utf8");
      const needle = '"./codex-model-stream-proxy.mjs"';
      if (original.split(needle).length !== 2) throw new Error("RUNNER_IMPORT_PATTERN_CHANGED");
      fs.writeFileSync(runnerPath, original.replace(needle, '"./native-test-absent-core.mjs"'));
    }
    if (fault === "accept-refusal") {
      const controlPath = path.join(targetRoot, "inner-runner-handoff-control.mjs");
      const original = fs.readFileSync(controlPath, "utf8");
      const needle = "function accept(message) {";
      if (original.split(needle).length !== 2) throw new Error("CONTROL_ACCEPT_FAULT_PATTERN_CHANGED");
      fs.writeFileSync(controlPath, original.replace(needle,
        'function accept(message) {\n    fs.appendFileSync(checkpointPath(message.fileName), "\\n");'));
    }
    if (fault === "exit-after-accept") {
      const controlPath = path.join(targetRoot, "inner-runner-handoff-control.mjs");
      let original = fs.readFileSync(controlPath, "utf8");
      const replaceOnce = (needle, replacement) => {
        if (original.split(needle).length !== 2) throw new Error("CONTROL_FAULT_PATTERN_CHANGED");
        original = original.replace(needle, replacement);
      };
      replaceOnce("let migrationGeneration = 0;", "let migrationGeneration = 0;\n  let nativeTestAccepted = false;");
      replaceOnce("const result = execute(message);", `if (message.method === "check" && nativeTestAccepted) {
        onEvent({ type: "native_test_exit_after_real_accept" });
        void shutdown("native_test_exit_after_real_accept");
        return;
      }
      const result = execute(message);
      if (message.method === "accept") nativeTestAccepted = true;`);
      fs.writeFileSync(controlPath, original);
    }
    targetManifest = manifestOf(targetRoot, sourceManifest);
    const sourceHashes = hashes(frozenRoot);
    const targetHashes = hashes(targetRoot);
    const manifest = { schemaVersion: 1, edges: [{ source: { core: sourceHashes.core, helper: sourceHashes.helper },
      target: { core: targetHashes.core, helper: targetHashes.helper }, checkpointSchemaVersion: 1,
      stateSchemaVersion: 1, stateSemantics: "state-v1" }] };
    compatibility = { manifest, sha256: digest(JSON.stringify(manifest)) };
    result.targetManifest = targetManifest;
    result.compatibility = compatibility;
    result.upgradeBehavior = { before: oldDiagnostic, after: newDiagnostic, changedSites: 2, fault: fault ?? null };
    record("target_constructed_after_old_ready", { targetRoot, targetHashes, compatibilitySha256: compatibility.sha256 });
    check("old_ready_precedes_unknown_target_construction", coordinatorEvents.some(entry => entry.type === "worker_ready" && entry.workerId === oldWorkerId));
  }

  function rpc(method, params) {
    const requestId = ++nativeSequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { nativePending.delete(requestId); reject(new Error(`RPC_TIMEOUT:${method}`)); }, 60_000);
      nativePending.set(requestId, { resolve, reject, timer });
      native.child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    });
  }

  async function newThread() {
    const started = await rpc("thread/start", { cwd: runRoot, model: "gpt-6-luna", modelProvider: "isolated",
      approvalPolicy: "never", sandbox: "danger-full-access", ephemeral: false,
      dynamicTools: [{ name: "counter_once", description: "Append one owned synthetic test effect",
        inputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false } }] });
    return started.thread.id;
  }

  const completed = (threadId, turnId) => nativeEvents.find(entry => entry.method === "turn/completed"
    && entry.params?.threadId === threadId && entry.params?.turn?.id === turnId);

  async function startTurn(threadId, label) {
    const started = await rpc("turn/start", { threadId, input: [{ type: "text", text: `NATIVE_HANDOFF_${label}` }] });
    return started.turn.id;
  }

  async function endTurn(threadId, turnId, label) {
    const completion = await waitUntil(() => completed(threadId, turnId), 60_000, `${label}_terminal`);
    await relay;
    await waitUntil(() => coordinator.status().threads.find(entry => entry.threadId === threadId)?.activeHttp === 0,
      10_000, `${label}_http_idle`);
    const summary = { label, threadId, turnId, completion,
      modelRequests: modelRequests.filter(entry => entry.turnId === turnId).length,
      routes: coordinatorEvents.filter(entry => entry.type === "request_routed" && entry.turnId === turnId),
      errors: nativeEvents.filter(entry => entry.method === "error" && entry.params?.turnId === turnId) };
    result.turns.push(summary);
    record("official_turn_terminal", { label, threadId, turnId, status: completion.params.turn.status,
      modelRequests: summary.modelRequests, routedRequests: summary.routes.length });
    return summary;
  }

  const runTurn = async (threadId, label) => endTurn(threadId, await startTurn(threadId, label), label);

  async function firstTwo(threadId) {
    const first = await runTurn(threadId, "QUOTA_ONE");
    const second = await runTurn(threadId, "QUOTA_TWO");
    check("two_real_native_soft_completions", first.completion.params.turn.status === "completed"
      && second.completion.params.turn.status === "completed" && first.modelRequests === 1 && second.modelRequests === 1);
    return [first, second];
  }

  function checkpointFrom(receipt) {
    const saved = fs.readFileSync(receipt.accepted.readPath);
    const envelope = JSON.parse(saved.toString("utf8"));
    result.checkpoint = { path: receipt.accepted.readPath, sha256: digest(saved), bytes: saved.length, payload: envelope.payload };
    check("actual_checkpoint_read_preserves_two_empty_turns", digest(saved) === receipt.checkpointSha256
      && receipt.accepted.readSha256 === receipt.checkpointSha256 && envelope.payload.snapshot.state.emptyIdleTurns[0]?.[1]?.count === 2);
    check("exact_directed_parent_approval_accepted", receipt.accepted.versionAcceptance.mode === "compatible-version"
      && receipt.accepted.versionAcceptance.manifestSha256 === compatibility.sha256
      && receipt.source.core === compatibility.manifest.edges[0].source.core
      && receipt.target.core === compatibility.manifest.edges[0].target.core
      && envelope.payload.migrationPlanSha256?.length === 64);
  }

  async function thirdFails(threadId, expectedWorkerId, upgraded) {
    const third = await runTurn(threadId, "QUOTA_THREE");
    check("third_real_turn_failed_without_budget_reset", third.completion.params.turn.status === "failed"
      && third.modelRequests === 1 && third.routes.length >= 2
      && third.routes.every(entry => entry.workerId === expectedWorkerId), { third });
    check("actual_upgrade_diagnosis_visible", JSON.stringify(third.completion).includes("COMPAT_V2_DIAGNOSIS") === upgraded
      && JSON.stringify(third.errors).includes("COMPAT_V2_DIAGNOSIS") === upgraded);
    return third;
  }

  async function rejected(label, action) {
    try { await action(); } catch (error) {
      const detail = { label, code: error.code ?? error.message, at: new Date().toISOString() };
      (result.refusals ??= []).push(detail);
      record("real_coordinator_refusal", detail);
      return detail;
    }
    throw new Error(`EXPECTED_REFUSAL:${label}`);
  }

  function threadWorker(threadId) { return coordinator.status().threads.find(entry => entry.threadId === threadId)?.workerId; }

  try {
    upstream = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      const metadata = JSON.parse(request.headers["x-codex-turn-metadata"] ?? "{}");
      const modelMode = modes.get(metadata.thread_id) ?? "quota";
      const entry = { at: new Date().toISOString(), threadId: metadata.thread_id, turnId: metadata.turn_id,
        count: modelRequests.filter(previous => previous.turnId === metadata.turn_id).length + 1,
        modelMode, method: request.method, url: request.url, metadata, requestHash: digest(raw), body: JSON.parse(raw) };
      modelRequests.push(entry);
      append("model-requests.jsonl", entry);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const responseId = `resp_native_handoff_${modelRequests.length}`;
      event(response, { type: "response.created", response: { id: responseId, object: "response", status: "in_progress", output: [] } });
      if (modelMode === "tool") completeTool(response, responseId);
      else if (modelMode === "text") completeText(response, responseId, "REAL_SYNTHETIC_TEXT_PROGRESS");
      else {
        event(response, { type: "response.failed", response: { id: responseId, status: "failed",
          error: { code: "usage_limit_reached", message: "SYNTHETIC_LOOPBACK_FIXTURE_QUOTA_ONLY" } } });
        response.end();
      }
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    observedPorts.add(upstream.address().port);
    result.upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
    coordinator = createInnerProxyCoordinator({ ownerId: runId, nativeSourceId, checkpointRoot: checkpoints,
      upstreamOrigin: result.upstreamOrigin, environment, onEvent: value => {
        const entry = { at: new Date().toISOString(), ...value };
        coordinatorEvents.push(entry);
        append("coordinator-events.jsonl", entry);
        if (value.type === "worker_ready") {
          childRecords.push({ label: value.workerId, pid: value.pid, createdAt: entry.at, sourceHashes: value.sourceHashes });
        }
        if (value.type === "worker_exited") {
          let child = childRecords.find(previous => previous.pid === value.pid);
          if (!child) {
            child = { label: value.workerId, pid: value.pid, neverReady: true };
            childRecords.push(child);
          }
          Object.assign(child, { exitedAt: entry.at, exitCode: value.code, signalCode: value.signal });
        }
        write("owned-processes.json", childRecords);
      } });
    result.start = await coordinator.start(specification(frozenRoot));
    oldWorkerId = result.start.workerId;
    observedPorts.add(result.start.port);
    record("normal_coordinator_started_without_target", { ...result.start, status: coordinator.status() });
    check("no_target_or_manifest_preconfigured_at_old_start", !targetRoot && !compatibility && coordinator.status().workers.length === 1);
    const codexHome = path.join(runRoot, "codex-home");
    fs.mkdirSync(codexHome);
    check("native_home_started_empty", fs.readdirSync(codexHome).length === 0);
    fs.writeFileSync(path.join(codexHome, "config.toml"), `model = "gpt-6-luna"\nmodel_reasoning_effort = "max"\nmodel_provider = "isolated"\n[model_providers.isolated]\nname = "isolated"\nbase_url = "http://127.0.0.1:${result.start.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nstream_max_retries = 5\nstream_idle_timeout_ms = 150000\n`);
    const stderr = fs.openSync(path.join(runRoot, "native.stderr.log"), "wx");
    native = { child: spawn(codexPath, ["app-server"], { cwd: runRoot, env: { ...nativeEnvironment, CODEX_HOME: codexHome },
      windowsHide: true, stdio: ["pipe", "pipe", stderr] }) };
    fs.closeSync(stderr);
    native.record = { label: "official-app-server", pid: native.child.pid, createdAt: new Date().toISOString() };
    childRecords.push(native.record);
    native.child.once("exit", (code, signal) => {
      Object.assign(native.record, { exitedAt: new Date().toISOString(), exitCode: code, signalCode: signal });
      write("owned-processes.json", childRecords);
    });
    native.child.once("error", error => { result.nativeSpawnError = String(error); });
    readline.createInterface({ input: native.child.stdout }).on("line", line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const at = new Date().toISOString();
      nativeEvents.push({ at, ...message });
      append("native.stdout.jsonl", { at, ...message });
      if (["turn/started", "turn/completed"].includes(message.method)) {
        try {
          relay = coordinator.observeNativeMessage(nativeSourceId, message);
          nativeState.set(message.params.threadId, { phase: message.method === "turn/started" ? "active" : "terminal",
            turnId: message.params.turn.id, status: message.params.turn.status, at });
          append("native-observations.jsonl", { at, sourceId: nativeSourceId, message });
        } catch (error) {
          relayErrors.push({ at, code: error.code ?? error.message, message });
        }
      }
      if (message.method === "item/tool/call" && message.params?.tool === "counter_once") {
        toolCalls += 1;
        toolRequest = message;
        append("tool-effects.jsonl", { at, invocation: toolCalls, callId: message.params.callId,
          threadId: message.params.threadId, turnId: message.params.turnId });
        return;
      }
      const pending = nativePending.get(message.id);
      if (pending) {
        nativePending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error))); else pending.resolve(message.result);
      }
    });
    result.initialize = await rpc("initialize", { clientInfo: { name: "isolated_native_parent_coordinator", version: "1.0.0" },
      capabilities: { experimentalApi: true } });
    native.child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    check("official_native_0162_alpha2", /0\.162\.0-alpha\.2/u.test(result.initialize.userAgent), { initialize: result.initialize });
    const threadId = await newThread();
    result.threadId = threadId;
    await firstTwo(threadId);
    buildTarget(["startup-failure", "exit-after-accept", "accept-refusal"].includes(scenario) ? scenario : undefined);
    if (scenario === "quota-handoff") {
      const candidate = await coordinator.prepareCandidate(specification(targetRoot));
      result.candidate = candidate;
      result.receipt = await coordinator.migrate({ threadId, candidateId: candidate.workerId, compatibility });
      checkpointFrom(result.receipt);
      await thirdFails(threadId, candidate.workerId, true);
    } else if (scenario === "split-threads") {
      const activeThread = await newThread();
      result.activeThreadId = activeThread;
      modes.set(activeThread, "tool");
      const toolTurnId = await startTurn(activeThread, "A_TOOL_WAIT");
      await waitUntil(() => toolCalls === 1 && toolRequest, 15_000, "official_tool_call");
      await waitUntil(() => coordinator.status().threads.find(entry => entry.threadId === activeThread)?.activeHttp === 0,
        10_000, "tool_http_finished");
      result.toolPending = { threadId: activeThread, turnId: toolTurnId, status: coordinator.status(),
        effectSha256: digest(fs.readFileSync(path.join(runRoot, "tool-effects.jsonl"))) };
      const candidate = await coordinator.prepareCandidate(specification(targetRoot));
      result.candidate = candidate;
      const refusal = await rejected("active_A_cannot_migrate", () => coordinator.migrate({ threadId: activeThread,
        candidateId: candidate.workerId, compatibility }));
      check("official_tool_pending_gate", refusal.code === "COORDINATOR_THREAD_NOT_READY" && !completed(activeThread, toolTurnId));
      result.receipt = await coordinator.migrate({ threadId, candidateId: candidate.workerId, compatibility });
      checkpointFrom(result.receipt);
      check("B_migrated_independently_while_A_stays_old", threadWorker(activeThread) === oldWorkerId
        && threadWorker(threadId) === candidate.workerId && !completed(activeThread, toolTurnId), { status: coordinator.status() });
      await thirdFails(threadId, candidate.workerId, true);
      modes.set(activeThread, "text");
      native.child.stdin.write(`${JSON.stringify({ id: toolRequest.id, result: { success: true,
        contentItems: [{ type: "inputText", text: "owned-effect-checkpoint-1" }] } })}\n`);
      toolRequest = null;
      const toolTurn = await endTurn(activeThread, toolTurnId, "A_TOOL_DONE_AFTER_B_MIGRATION");
      const continued = modelRequests.filter(entry => entry.turnId === toolTurnId);
      check("A_all_requests_still_old_and_tool_exactly_once", toolTurn.completion.params.turn.status === "completed"
        && toolTurn.routes.length === 2 && toolTurn.routes.every(entry => entry.workerId === oldWorkerId)
        && toolCalls === 1 && continued.length === 2 && JSON.stringify(continued[1].body).includes("owned-effect-checkpoint-1")
        && digest(fs.readFileSync(path.join(runRoot, "tool-effects.jsonl"))) === result.toolPending.effectSha256,
        { toolCalls, requests: continued, routes: toolTurn.routes });
      const freshThread = await newThread();
      modes.set(freshThread, "text");
      const freshTurn = await runTurn(freshThread, "FRESH_THREAD_DEFAULT_NEW");
      check("new_thread_default_commits_only_after_accept", freshTurn.completion.params.turn.status === "completed"
        && freshTurn.routes.length === 1 && freshTurn.routes[0].workerId === candidate.workerId);
    } else {
      if (scenario === "listen-failure") {
        occupied = net.createServer();
        occupied.listen(0, "127.0.0.1");
        await once(occupied, "listening");
        observedPorts.add(occupied.address().port);
        result.faultPort = occupied.address().port;
        await rejected("actual_EADDRINUSE", () => coordinator.prepareCandidate(specification(targetRoot, { port: result.faultPort })));
        await waitUntil(() => coordinator.status().workers.length === 2 && !coordinator.status().workers[1].alive,
          15_000, "listen_failed_worker_exit");
        const failedWorker = coordinator.status().workers.find(entry => entry.workerId !== oldWorkerId);
        const failedRuntimePath = path.join(checkpoints, failedWorker.workerId, "codex-model-stream-proxy-runtime.json");
        const failedRuntime = JSON.parse(fs.readFileSync(failedRuntimePath, "utf8"));
        result.listenFailureEvidence = { failedRuntimePath, failedRuntime };
        check("real_listen_error_EADDRINUSE", failedRuntime.error?.code === "EADDRINUSE", result.listenFailureEvidence);
      } else if (scenario === "startup-failure") {
        await rejected("actual_missing_module_startup", () => coordinator.prepareCandidate(specification(targetRoot)));
        await waitUntil(() => coordinator.status().workers.length === 2 && !coordinator.status().workers[1].alive,
          15_000, "startup_failed_worker_exit");
        const errorText = fs.readdirSync(checkpoints).filter(name => name.endsWith(".stderr.log"))
          .map(name => fs.readFileSync(path.join(checkpoints, name), "utf8")).join("\n");
        check("real_startup_module_error", errorText.includes("ERR_MODULE_NOT_FOUND"));
      } else {
        const candidate = await coordinator.prepareCandidate(specification(targetRoot));
        result.candidate = candidate;
        const refusal = await rejected(scenario, () => coordinator.migrate({ threadId, candidateId: candidate.workerId, compatibility }));
        if (scenario === "accept-refusal") {
          const eventsPath = path.join(checkpoints, candidate.workerId, "codex-model-stream-proxy.jsonl");
          const logs = fs.readFileSync(eventsPath, "utf8");
          result.acceptRefusalEvidence = { eventsPath, fault: "newline appended to owned checkpoint before actual target accept validation" };
          check("real_target_accept_hash_refusal", refusal.code === "CHECKPOINT_HASH_MISMATCH"
            && logs.includes('"method":"accept","ok":false,"code":"CHECKPOINT_HASH_MISMATCH"'));
        }
        else {
          await waitUntil(() => !coordinator.status().workers.find(entry => entry.workerId === candidate.workerId).alive,
            15_000, "accepted_target_exited");
          const eventsPath = path.join(checkpoints, candidate.workerId, "codex-model-stream-proxy.jsonl");
          result.faultWorkerEventsPath = eventsPath;
          const files = fs.readdirSync(path.join(checkpoints, candidate.workerId)).filter(name => name.endsWith(".jsonl"));
          const logs = files.map(name => fs.readFileSync(path.join(checkpoints, candidate.workerId, name), "utf8")).join("\n");
          check("actual_accept_precedes_graceful_target_exit", logs.includes('"method":"accept","ok":true')
            && logs.includes("native_test_exit_after_real_accept"));
        }
      }
      check("failure_preserves_source_and_no_commit", threadWorker(threadId) === oldWorkerId
        && coordinator.status().nativeHealthy && !coordinatorEvents.some(entry => entry.type === "migration_committed"),
        { status: coordinator.status() });
      await thirdFails(threadId, oldWorkerId, false);
    }
    for (const identity of new Set(result.turns.map(turn => turn.threadId))) {
      const read = await rpc("thread/read", { threadId: identity, includeTurns: true });
      write(`thread-read-${identity}.json`, read);
      check(`official_history_${identity}`, result.turns.filter(turn => turn.threadId === identity)
        .every(turn => read.thread.turns.some(saved => saved.id === turn.turnId)));
    }
    await relay;
    if (result.receipt) {
      result.controlEvidence = [oldWorkerId, result.candidate.workerId].map(workerId => {
        const logPath = path.join(checkpoints, workerId, "codex-model-stream-proxy.jsonl");
        const logEvents = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
        return { workerId, logPath, entries: logEvents.filter(entry => entry.type === "handoff_control_result") };
      });
      check("one_actual_parent_authorization_on_each_worker", result.controlEvidence.every(worker =>
        worker.entries.filter(entry => entry.method === "authorizeMigration" && entry.ok === true).length === 1)
        && result.controlEvidence[0].entries.some(entry => entry.method === "prepare" && entry.ok === true)
        && result.controlEvidence[1].entries.some(entry => entry.method === "accept" && entry.ok === true),
        { controlEvidence: result.controlEvidence });
    }
    check("all_real_native_events_observed_and_relayed", relayErrors.length === 0 && coordinator.status().nativeHealthy
      && nativeEvents.filter(entry => ["turn/started", "turn/completed"].includes(entry.method)).length
        === coordinatorEvents.filter(entry => entry.type === "native_turn_relayed").length, { relayErrors });
    check("all_synthetic_upstream_requests_have_real_native_identity", modelRequests.every(entry => entry.threadId && entry.turnId
      && nativeEvents.some(nativeEvent => nativeEvent.method === "turn/started" && nativeEvent.params.threadId === entry.threadId
        && nativeEvent.params.turn.id === entry.turnId)));
    assertManifest(frozenRoot, sourceManifest);
    assertManifest(targetRoot, targetManifest);
    result.completed = true;
  } catch (error) {
    result.fixtureError = String(error.stack ?? error);
    process.exitCode = 1;
    record("native_coordinator_test_failed", { error: result.fixtureError, status: coordinator?.status() });
  } finally {
    if (native && native.child.exitCode === null && native.child.signalCode === null) {
      if (toolRequest) native.child.stdin.write(`${JSON.stringify({ id: toolRequest.id, result: { success: false,
        contentItems: [{ type: "inputText", text: "owned fixture stopping" }] } })}\n`);
      for (const [threadId, state] of nativeState) {
        if (state.phase === "active") {
          try { await rpc("turn/interrupt", { threadId, turnId: state.turnId }); } catch (error) {
            (result.cleanupErrors ??= []).push(String(error));
          }
        }
      }
      native.child.stdin.end();
      try { await waitUntil(() => native.child.exitCode !== null || native.child.signalCode !== null, 10_000, "native_normal_exit"); }
      catch (error) { (result.cleanupErrors ??= []).push(String(error)); }
    }
    try { await relay; await coordinator?.close(); }
    catch (error) { (result.cleanupErrors ??= []).push(String(error)); }
    if (upstream?.listening) await new Promise(resolve => upstream.close(resolve));
    if (occupied?.listening) await new Promise(resolve => occupied.close(resolve));
    result.coordinatorEnd = coordinator?.status();
    result.cleanup = childRecords.map(entry => ({ ...entry, forced: false, alive: !entry.exitedAt }));
    result.workerShutdown = [];
    for (const worker of result.coordinatorEnd?.workers ?? []) {
      const runtimePath = path.join(checkpoints, worker.workerId, "codex-model-stream-proxy-runtime.json");
      if (!fs.existsSync(runtimePath)) continue;
      const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
      const runnerLogPath = path.join(checkpoints, worker.workerId, "codex-model-stream-proxy.jsonl");
      const runnerEvents = fs.existsSync(runnerLogPath)
        ? fs.readFileSync(runnerLogPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
      const runnerStarted = runnerEvents.find(entry => entry.type === "runner_started");
      const actualPort = runnerStarted?.endpoint ? Number(new URL(runnerStarted.endpoint).port) : null;
      if (Number.isInteger(actualPort) && actualPort > 0) observedPorts.add(actualPort);
      const observerPath = path.join(checkpoints, worker.workerId, "codex-model-observer-runtime.json");
      const observer = fs.existsSync(observerPath) ? JSON.parse(fs.readFileSync(observerPath, "utf8")) : null;
      result.workerShutdown.push({ workerId: worker.workerId, pid: worker.pid, runtime, observer, runnerLogPath, runnerStarted, actualPort,
        lockExists: fs.existsSync(path.join(checkpoints, worker.workerId, "codex-model-stream-proxy.lock.json")) });
    }
    result.portsClosed = [];
    for (const port of observedPorts) {
      const probe = net.createServer();
      const released = await new Promise(resolve => {
        probe.once("error", error => resolve({ port, released: false, code: error.code }));
        probe.listen(port, "127.0.0.1", () => probe.close(() => resolve({ port, released: true })));
      });
      result.portsClosed.push(released);
    }
    result.allOwnedChildrenExited = result.cleanup.every(entry => !entry.alive)
      && (result.coordinatorEnd?.workers ?? []).every(entry => entry.exitCode !== null || entry.signalCode !== null);
    result.frozenBuildUnchanged = sourceManifest.every(entry => digest(fs.readFileSync(path.join(frozenRoot, entry.relative))) === entry.sha256);
    result.targetBuildUnchanged = !targetManifest || targetManifest.every(entry => digest(fs.readFileSync(path.join(targetRoot, entry.relative))) === entry.sha256);
    result.cleanupPassed = result.allOwnedChildrenExited && !result.cleanupErrors?.length && result.portsClosed.every(entry => entry.released)
      && result.workerShutdown.filter(entry => entry.runtime.status !== "failed").every(entry => entry.runtime.status === "stopped"
        && entry.runtime.activeRequests === 0 && !entry.lockExists && (!entry.observer || entry.observer.running === false && entry.observer.queue_depth === 0));
    result.totalModelRequests = modelRequests.length;
    result.toolCalls = toolCalls;
    result.endedAt = new Date().toISOString();
    write("native-events.json", nativeEvents);
    write("coordinator-events.json", coordinatorEvents);
    write("model-requests.json", modelRequests);
    write("relay-errors.json", relayErrors);
    write("result.json", result);
    write("owned-processes.json", childRecords);
    if (!result.cleanupPassed || !result.frozenBuildUnchanged || !result.targetBuildUnchanged) process.exitCode = 1;
    console.log(JSON.stringify({ runRoot, completed: result.completed === true, fixtureError: result.fixtureError,
      assertions: result.assertions.map(entry => ({ name: entry.name, passed: entry.passed })),
      totalModelRequests: result.totalModelRequests, toolCalls, cleanupPassed: result.cleanupPassed,
      cleanup: result.cleanup, portsClosed: result.portsClosed }));
  }
}
