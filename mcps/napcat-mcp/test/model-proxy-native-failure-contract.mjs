import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import zlib from "node:zlib";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const argumentsMap = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!key.startsWith("--") || !value || argumentsMap.has(key)) throw new Error("EXPECTED_UNIQUE_NAMED_ARGUMENTS");
  argumentsMap.set(key, value);
}
const executable = argumentsMap.get("--codex");
const outputDirectory = argumentsMap.get("--out");
const sourceRoot = argumentsMap.get("--source-root");
const mode = argumentsMap.get("--mode") ?? "native";
for (const key of argumentsMap.keys()) if (!["--codex", "--out", "--source-root", "--source-manifest", "--mode", "--cases", "--ws-package-root", "--observation-ms", "--transport", "--native-idle-ms", "--recovery-wait-ms", "--ws-max-message-bytes"].includes(key)) throw new Error(`UNKNOWN_ARGUMENT:${key}`);
if (!executable || !outputDirectory || !path.isAbsolute(executable) || !path.isAbsolute(outputDirectory)
  || (sourceRoot && !path.isAbsolute(sourceRoot))) throw new Error("Usage: node model-proxy-native-failure-contract.mjs --codex ABSOLUTE_EXE --out NEW_ABSOLUTE_DIRECTORY [--source-root NAPCAT_SOURCE_ROOT] [--mode native|candidate --source-manifest FROZEN_MANIFEST] [--cases COMMA_SEPARATED_NATIVE_CASES]");
if (!["native", "candidate"].includes(mode)) throw new Error("UNKNOWN_MODE");
if (fs.existsSync(outputDirectory)) throw new Error("OUTPUT_EXISTS_PRESERVE_PREVIOUS_EVIDENCE");
if (mode === "candidate") {
  const manifestPath = argumentsMap.get("--source-manifest");
  if (!sourceRoot || !manifestPath || !path.isAbsolute(manifestPath)) throw new Error("CANDIDATE_REQUIRES_SOURCE_ROOT_AND_FROZEN_MANIFEST");
  const entry = fileURLToPath(new URL("./inner-managed-official-startup-native.mjs", import.meta.url));
  const candidateArguments = [entry, executable, "--contract-only", "--out", outputDirectory,
    "--source-root", sourceRoot, "--source-manifest", manifestPath];
  if (argumentsMap.has("--ws-package-root")) candidateArguments.push("--ws-package-root", argumentsMap.get("--ws-package-root"));
  for (const name of ["--transport", "--native-idle-ms", "--recovery-wait-ms", "--cases", "--ws-max-message-bytes"]) if (argumentsMap.has(name)) candidateArguments.push(name, argumentsMap.get(name));
  const child = spawn(process.execPath, candidateArguments, { stdio: "inherit", windowsHide: true });
  const [code] = await once(child, "exit");
  process.exitCode = code ?? 1;
} else {
  await nativeContract();
}

async function nativeContract() {
  const nativeCases = ["success", "http503", "transport-disconnect", "transport-reset-before-headers", "stream-disconnect", "sse-temporary", "sse-usage-limit",
    "sse-insufficient-quota", "sse-authentication-error", "sse-invalid-request-error", "http429-usage-limit", "http401",
    "http401-authentication", "http400-authentication", "hold-cancel", "cancel-backoff", "after-cancel-success", "connection-refused"];
  const selectedCases = argumentsMap.has("--cases") ? argumentsMap.get("--cases").split(",") : nativeCases;
  if (!selectedCases.length || selectedCases.some(name => !nativeCases.includes(name)) || new Set(selectedCases).size !== selectedCases.length) throw new Error("INVALID_NATIVE_CASE_SELECTION");
  if (selectedCases.includes("connection-refused") && selectedCases.at(-1) !== "connection-refused") throw new Error("CONNECTION_REFUSED_MUST_BE_LAST");
  const connectionObservationMs = Number(argumentsMap.get("--observation-ms") ?? 5000);
  if (!Number.isInteger(connectionObservationMs) || connectionObservationMs < 100 || connectionObservationMs > 60000) throw new Error("OBSERVATION_MS_MUST_BE_100_TO_60000");
  fs.mkdirSync(outputDirectory, { recursive: true });
  const home = path.join(outputDirectory, "codex-home");
  const workspace = path.join(outputDirectory, "workspace");
  fs.mkdirSync(home); fs.mkdirSync(workspace);
  const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
  const append = (name, value) => fs.appendFileSync(path.join(outputDirectory, name), JSON.stringify(value) + "\n");
  const write = (name, value) => fs.writeFileSync(path.join(outputDirectory, name), JSON.stringify(value, null, 2) + "\n");
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const messages = [], requests = [], results = [], unexpectedRequests = [];
  const waiters = new Map(), sockets = new Set(), activeResponses = new Set();
  let sequence = 0, phase = "initializing", child, server, threadId;
  const probeBytes = fs.readFileSync(fileURLToPath(import.meta.url));
  fs.writeFileSync(path.join(outputDirectory, "probe-source.txt"), probeBytes);
  const summary = { schemaVersion: 1, mode: "native", startedAt: new Date().toISOString(), executable,
    command: [process.execPath, ...process.argv.slice(1)],
    executableSha256: digest(fs.readFileSync(executable)), probeSha256: digest(probeBytes),
    retryConfiguration: { requestMaxRetries: 1, streamMaxRetries: 1, streamIdleTimeoutMs: 10000, unboundedConnectionRetries: true },
    sourceRoot: sourceRoot ?? null, candidateExecuted: false, home, workspace, node: process.version,
    selectedCases, isolation: { freshHome: true, formalAuthCopied: false, formalConfigCopied: false, loopbackOnlyFixture: true,
      plugins: false, remote_plugin: false, apps: false, analytics: false, realModelCalls: false }, results };
  async function until(predicate, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const actual = predicate(); if (actual) return actual; await delay(10); }
    throw new Error(`TIMEOUT:${label}`);
  }
  function rpc(method, params) {
    const id = ++sequence;
    append("client.jsonl", { at: new Date().toISOString(), id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`RPC_TIMEOUT:${method}`)); }, 15000);
      waiters.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  function event(response, value) {
    append("fixture-events.jsonl", { at: new Date().toISOString(), phase, event: value });
    response.write("data: " + JSON.stringify(value) + "\n\n");
  }
  function complete(response) {
    const responseId = `resp_synthetic_${requests.length}`, itemId = `msg_synthetic_${requests.length}`;
    const item = { id: itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "SYNTHETIC_OK", annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    event(response, { type: "response.created", response: { id: responseId, status: "in_progress", output: [] } });
    event(response, { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
    event(response, { type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: "SYNTHETIC_OK" });
    event(response, { type: "response.output_item.done", output_index: 0, item });
    event(response, { type: "response.completed", response: { id: responseId, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    response.end();
  }
  async function runTurn(nextPhase, expectedStatus, cancelInBackoff = false) {
    phase = nextPhase;
    const startIndex = messages.length, requestIndex = requests.length, started = Date.now();
    const begun = await rpc("turn/start", { threadId, input: [{ type: "text", text: `SYNTHETIC_${phase}` }] });
    const turnId = begun.turn.id;
    const findTerminal = () => messages.slice(startIndex).find(message => message.method === "turn/completed" && message.params?.turn?.id === turnId);
    let interruptAt = null, interruptResponse = null, retryObserved = null, observation = null;
    if (cancelInBackoff) {
      retryObserved = await until(() => messages.slice(startIndex).find(message =>
        ["error", "turn/error"].includes(message.method) && message.params?.turnId === turnId && message.params?.willRetry === true), "retry-notification");
      interruptAt = Date.now();
      interruptResponse = await rpc("turn/interrupt", { threadId, turnId });
    } else if (phase === "hold-cancel") {
      await until(() => requests.length > requestIndex, "held-http-request");
      interruptAt = Date.now();
      interruptResponse = await rpc("turn/interrupt", { threadId, turnId });
    } else if (phase === "connection-refused") {
      const observedFrom = Date.now();
      await until(() => findTerminal() || Date.now() - observedFrom >= connectionObservationMs, "connection-refused-observation", connectionObservationMs + 2000);
      observation = { budgetMs: connectionObservationMs, actualMs: Date.now() - observedFrom, terminalBeforeInterrupt: findTerminal() ?? null,
        acceptedHttpRequests: requests.length - requestIndex, connectionAttemptCount: null };
      if (!findTerminal()) {
        interruptAt = Date.now();
        interruptResponse = await rpc("turn/interrupt", { threadId, turnId });
      }
    }
    const terminal = await until(() => messages.slice(startIndex).find(message => message.method === "turn/completed" && message.params?.turn?.id === turnId), phase);
    const terminalAt = Date.now(), requestsAtTerminal = requests.length;
    if (interruptAt !== null) await delay(1500);
    const relevant = messages.slice(startIndex).filter(message => ["error", "turn/error", "turn/started", "turn/completed", "thread/status/changed"].includes(message.method));
    const result = { phase, turnId, expectedStatus, status: terminal.params.turn.status, error: terminal.params.turn.error ?? null,
      elapsedMs: terminalAt - started, requests: requests.slice(requestIndex), requestCount: requestsAtTerminal - requestIndex,
      notifications: relevant, retryObserved, interruptResponse, observation,
      errorInfo: relevant.filter(message => ["error", "turn/error"].includes(message.method)).map(message => ({
        willRetry: message.params?.willRetry, codexErrorInfo: message.params?.error?.codexErrorInfo, message: message.params?.error?.message,
        additionalDetails: message.params?.error?.additionalDetails })),
      threadStatuses: relevant.filter(message => message.method === "thread/status/changed").map(message => message.params.status),
      cancellationLatencyMs: interruptAt === null ? null : terminalAt - interruptAt,
      postCancellationObservationMs: interruptAt !== null ? 1500 : 0,
      requestsAfterCancellationTerminal: requests.length - requestsAtTerminal,
      openHttpResponsesAfterObservation: activeResponses.size,
      passed: (Array.isArray(expectedStatus) ? expectedStatus.includes(terminal.params.turn.status) : terminal.params.turn.status === expectedStatus)
        && requests.length === requestsAtTerminal && (interruptAt === null || activeResponses.size === 0) };
    results.push(result); write("progress.json", summary);
  }
  try {
    server = http.createServer(async (request, response) => {
      try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const encoded = Buffer.concat(chunks);
        let decoded = encoded;
        if (request.headers["content-encoding"] === "zstd") decoded = zlib.zstdDecompressSync(encoded);
        if (request.headers["content-encoding"] === "gzip") decoded = zlib.gunzipSync(encoded);
        const record = { at: new Date().toISOString(), phase, method: request.method, url: request.url,
          encodedBytes: encoded.length, decodedBytes: decoded.length, sha256: digest(decoded) };
        activeResponses.add(response);
        response.once("close", () => {
          activeResponses.delete(response); record.closedAt = new Date().toISOString();
          append("http-close.jsonl", { phase: record.phase, requestedAt: record.at, closedAt: record.closedAt, writableEnded: response.writableEnded });
        });
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          unexpectedRequests.push(record); append("unexpected-requests.jsonl", record); response.writeHead(404); response.end(); return;
        }
        requests.push(record); append("requests.jsonl", record);
        if (phase === "transport-disconnect") { request.socket.destroy(); return; }
        if (phase === "transport-reset-before-headers") { request.socket.resetAndDestroy(); return; }
        if (phase === "stream-disconnect") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          event(response, { type: "response.created", response: { id: "resp_synthetic_reset", status: "in_progress", output: [] } });
          setTimeout(() => response.destroy(), 20); return;
        }
        if (["http503", "cancel-backoff"].includes(phase)) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { code: "server_error", message: "SYNTHETIC_HTTP_503" } })); return;
        }
        if (["http401", "http401-authentication", "http400-authentication", "http429-usage-limit"].includes(phase)) {
          const statusCode = phase.startsWith("http401") ? 401 : phase === "http400-authentication" ? 400 : 429;
          const errorCode = phase.endsWith("authentication") ? "authentication_error" : phase === "http401" ? "invalid_api_key" : "usage_limit_reached";
          const body = { error: { type: errorCode, code: errorCode, message: `SYNTHETIC_${errorCode.toUpperCase()}` } };
          append("fixture-events.jsonl", { at: new Date().toISOString(), phase, httpStatus: statusCode, body });
          response.writeHead(statusCode, { "content-type": "application/json" });
          response.end(JSON.stringify(body)); return;
        }
        const sseErrorCodes = { "sse-temporary": "server_error", "sse-usage-limit": "usage_limit_reached",
          "sse-insufficient-quota": "insufficient_quota", "sse-authentication-error": "authentication_error", "sse-invalid-request-error": "invalid_request_error" };
        if (Object.hasOwn(sseErrorCodes, phase)) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          event(response, { type: "response.created", response: { id: "resp_synthetic_quota", status: "in_progress", output: [] } });
          event(response, { type: "response.failed", response: { id: "resp_synthetic_quota", status: "failed",
            error: { code: sseErrorCodes[phase], message: `SYNTHETIC_${sseErrorCodes[phase].toUpperCase()}` } } }); response.end(); return;
        }
        if (phase === "hold-cancel") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          event(response, { type: "response.created", response: { id: "resp_synthetic_hold", status: "in_progress", output: [] } }); return;
        }
        complete(response);
      } catch (error) { append("fixture-errors.jsonl", { error: String(error) }); response.destroy(); }
    });
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    summary.port = server.address().port;
    const baseUrl = `http://127.0.0.1:${summary.port}/v1`;
    const config = `model = "gpt-5.4"\nmodel_provider = "isolated"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[analytics]\nenabled = false\n[features]\nplugins = false\nremote_plugin = false\napps = false\nunbounded_connection_retries = true\n[model_providers.isolated]\nname = "OpenAI"\nbase_url = "${baseUrl}"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 1\nstream_max_retries = 1\nstream_idle_timeout_ms = 10000\n`;
    fs.writeFileSync(path.join(home, "config.toml"), config);
    const environment = { ...process.env };
    for (const name of Object.keys(environment)) if (/^(OPENAI|CODEX|CHATGPT|AZURE_OPENAI|ANTHROPIC|GEMINI|MODEL_OBSERVER)_/iu.test(name)
      || /^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/iu.test(name)) delete environment[name];
    Object.assign(environment, { CODEX_HOME: home, OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: "synthetic-local-only",
      HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "127.0.0.1,localhost", RUST_LOG: "warn" });
    const version = spawnSync(executable, ["--version"], { env: environment, encoding: "utf8", windowsHide: true, timeout: 10000 });
    summary.version = version.stdout?.trim(); summary.versionExitCode = version.status;
    if (version.status !== 0) throw new Error(`VERSION_FAILED:${version.stderr}`);
    const features = spawnSync(executable, ["features", "list"], { env: environment, encoding: "utf8", windowsHide: true, timeout: 10000 });
    fs.writeFileSync(path.join(outputDirectory, "features.txt"), features.stdout ?? "");
    summary.featuresExitCode = features.status;
    summary.unboundedFeature = features.stdout?.split(/\r?\n/u).find(line => line.startsWith("unbounded_connection_retries"));
    child = spawn(executable, ["app-server", "--listen", "stdio://"], { env: environment, cwd: workspace,
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    summary.pid = child.pid;
    child.on("error", error => { summary.childError = String(error); });
    child.stderr.on("data", bytes => fs.appendFileSync(path.join(outputDirectory, "stderr.txt"), bytes));
    readline.createInterface({ input: child.stdout }).on("line", line => {
      fs.appendFileSync(path.join(outputDirectory, "server.jsonl"), line + "\n");
      let message; try { message = JSON.parse(line); } catch { return; }
      messages.push(message); append("timed-server.jsonl", { at: new Date().toISOString(), message });
      const waiter = waiters.get(message.id);
      if (waiter) { clearTimeout(waiter.timer); waiters.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result); }
    });
    summary.initialize = await rpc("initialize", { clientInfo: { name: "native_failure_contract", version: "1.0.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const created = await rpc("thread/start", { model: "gpt-5.4", modelProvider: "isolated", cwd: workspace,
      approvalPolicy: "never", sandbox: "read-only", ephemeral: true });
    threadId = created.thread.id; summary.threadId = threadId;
    for (const name of selectedCases) {
      if (name === "connection-refused") {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        summary.connectionRefusedListenerClosed = !server.listening;
      }
      await runTurn(name, ["success", "after-cancel-success"].includes(name) ? "completed"
        : ["cancel-backoff", "hold-cancel"].includes(name) ? "interrupted" : name === "connection-refused" ? ["failed", "interrupted"] : "failed", name === "cancel-backoff");
    }
    summary.finalThread = await rpc("thread/read", { threadId, includeTurns: false });
    summary.completed = results.every(result => result.passed) && unexpectedRequests.length === 0;
    if (!summary.completed) process.exitCode = 1;
  } catch (error) { summary.completed = false; summary.error = String(error.stack ?? error); process.exitCode = 1; }
  finally {
    for (const waiter of waiters.values()) clearTimeout(waiter.timer);
    summary.ownedProcessesBeforeShutdown = child?.pid ? [{ ProcessId: child.pid, ParentProcessId: process.pid, Name: path.basename(executable) }] : [];
    if (process.platform === "win32" && child?.pid && child.exitCode === null && child.signalCode === null) {
      const script = `$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name); $ids = @(${child.pid}); do { $next = @($all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId }); $ids += @($next | ForEach-Object { $_.ProcessId }) } while ($next.Count -gt 0); ConvertTo-Json -InputObject @($all | Where-Object { $ids -contains $_.ProcessId }) -Compress`;
      const audit = spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 10000 });
      summary.processTreeAudit = { exitCode: audit.status, stderr: audit.stderr };
      if (audit.status === 0) {
        try { summary.ownedProcessesBeforeShutdown = JSON.parse(audit.stdout.replace(/^\uFEFF/u, "")); }
        catch (error) { summary.processTreeAudit.error = String(error); }
      }
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await Promise.race([once(child, "exit"), delay(1500)]);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.race([once(child, "exit"), delay(1500)]);
    }
    summary.childExitCode = child?.exitCode ?? null; summary.childSignal = child?.signalCode ?? null;
    summary.childAlive = false;
    if (child?.pid) { try { process.kill(child.pid, 0); summary.childAlive = true; } catch {} }
    summary.ownedProcessesAliveAfterShutdown = summary.ownedProcessesBeforeShutdown.filter(entry => {
      try { process.kill(entry.ProcessId, 0); return true; } catch { return false; }
    });
    for (const socket of sockets) socket.destroy();
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (summary.port) {
      const listener = net.createServer();
      summary.portReleased = await new Promise(resolve => { listener.once("error", () => resolve(false));
        listener.listen(summary.port, "127.0.0.1", () => listener.close(() => resolve(true))); });
    }
    summary.finishedAt = new Date().toISOString(); summary.requestCount = requests.length;
    summary.unexpectedRequestCount = unexpectedRequests.length;
    summary.isolatedHomeRetained = true;
    if (summary.childAlive || summary.portReleased === false || summary.ownedProcessesAliveAfterShutdown.length > 0) { summary.completed = false; process.exitCode = 1; }
    write("summary.json", summary);
    console.log(JSON.stringify({ completed: summary.completed, version: summary.version, outputDirectory, error: summary.error,
      results: results.map(({ phase: name, status, requestCount, cancellationLatencyMs }) => ({ phase: name, status, requestCount, cancellationLatencyMs })),
      cleanup: { childAlive: summary.childAlive, portReleased: summary.portReleased } }, null, 2));
  }
}
