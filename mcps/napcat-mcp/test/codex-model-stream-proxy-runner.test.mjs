import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const runnerPath = fileURLToPath(new URL("../src/codex-model-stream-proxy-runner.mjs", import.meta.url));

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function reservePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

function readEvents(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("start script validates model stream lock PID by runner command line", () => {
  const startScript = fs.readFileSync(path.resolve("ops/start-codex-model-stream-proxy.ps1"), "utf8");
  const runtimeProcessCheckIndex = startScript.indexOf("Test-ExpectedModelStreamProxyProcess -ProcessId ([int]$Current.pid)");
  const lockProcessCheckIndex = startScript.indexOf("Test-ExpectedModelStreamProxyProcess -ProcessId ([int]$Lock.pid)");
  assert.match(startScript, /function Test-ExpectedModelStreamProxyProcess/u);
  assert.match(startScript, /Get-CimInstance Win32_Process/u);
  assert.match(startScript, /codex-model-stream-proxy-runner\.mjs/u);
  assert.match(startScript, /function Move-StaleModelStreamLock/u);
  assert.ok(runtimeProcessCheckIndex > 0, "runtime-state PID reuse must be fenced by command-line validation");
  assert.ok(lockProcessCheckIndex > runtimeProcessCheckIndex, "lock PID reuse must be fenced after runtime-state handling");
  assert.doesNotMatch(
    startScript,
    /throw "Model stream proxy lock belongs to a live process:[\s\S]{0,120}Get-Process -Id \(\[int\]\$Lock\.pid\)/u,
  );
});

test("stop script refuses stale model stream runtime PID before signalling stop", () => {
  const stopScript = fs.readFileSync(path.resolve("ops/stop-codex-model-stream-proxy.ps1"), "utf8");
  const processCheckIndex = stopScript.indexOf("Test-ExpectedModelStreamProxyProcess -ProcessId ([int]$Runtime.pid)");
  const stopFileIndex = stopScript.indexOf("Set-Content -LiteralPath $StopPath");
  const forceStopIndex = stopScript.indexOf("Stop-Process -Id ([int]$Runtime.pid) -Force");
  assert.match(stopScript, /function Test-ExpectedModelStreamProxyProcess/u);
  assert.match(stopScript, /Get-CimInstance Win32_Process/u);
  assert.match(stopScript, /codex-model-stream-proxy-runner\.mjs/u);
  assert.ok(processCheckIndex > 0, "runtime-state PID reuse must be fenced by command-line validation");
  assert.ok(stopFileIndex > processCheckIndex, "stop signal must not be written before PID identity validation");
  assert.ok(forceStopIndex > processCheckIndex, "force stop must not run before PID identity validation");
  assert.match(stopScript, /Refusing to stop PID/u);
});

async function modelRequest(port) {
  const payload = Buffer.from(JSON.stringify({ stream: true, tools: [{ type: "function", name: "safe" }] }));
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/backend-api/codex/responses",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(payload.length),
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: "runner-test", turn_id: "turn-test" }),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.once("error", reject);
    request.end(payload);
  });
}

test("runtime heartbeat write failure never aborts an active model stream and later recovers", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-proxy-runner-test-"));
  const runtimePath = path.join(root, "codex-model-stream-proxy-runtime.json");
  const runtimeBackupPath = `${runtimePath}.backup`;
  const logPath = path.join(root, "codex-model-stream-proxy.jsonl");
  let releaseUpstream;
  let upstreamReached;
  const upstreamReachedPromise = new Promise((resolve) => { upstreamReached = resolve; });
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sse({ type: "response.output_text.delta", delta: "before-lock" }));
    upstreamReached();
    releaseUpstream = () => response.end(
      sse({ type: "response.output_text.delta", delta: "after-lock" })
      + sse({ type: "response.completed" }),
    );
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await reservePort();
  const child = spawn(process.execPath, [runnerPath], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_MODEL_STREAM_PROXY_STATE_ROOT: root,
      CODEX_MODEL_STREAM_PROXY_PORT: String(proxyPort),
      CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN: `http://127.0.0.1:${upstreamPort}`,
      CODEX_MODEL_STREAM_PROXY_FIRST_PROGRESS_TIMEOUT_MS: "1000",
      CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100",
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`runner exited with ${child.exitCode}: ${stderr}`);
    return fs.existsSync(runtimePath) && readEvents(logPath).some((event) => event.type === "runner_started");
  });
  const requestPromise = modelRequest(proxyPort);
  await upstreamReachedPromise;

  fs.renameSync(runtimePath, runtimeBackupPath);
  fs.mkdirSync(runtimePath);
  await waitFor(() => readEvents(logPath).some((event) => event.type === "runtime_state_write_failed"), 3_000);
  assert.equal(child.exitCode, null, stderr);

  releaseUpstream();
  const result = await requestPromise;
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /before-lock/u);
  assert.match(result.body, /after-lock/u);
  assert.equal(child.exitCode, null, stderr);
  assert.equal(readEvents(logPath).some((event) => event.type === "runner_uncaught_exception"), false);

  fs.rmSync(runtimePath, { recursive: true, force: true });
  fs.renameSync(runtimeBackupPath, runtimePath);
  await waitFor(() => readEvents(logPath).some((event) => event.type === "runtime_state_write_recovered"), 3_000);
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  assert.equal(runtime.status, "running");
  assert.equal(runtime.heartbeatIntervalMs, 100);
});

function launchRunner(root, port, overrides = {}) {
  const child = spawn(process.execPath, [runnerPath], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CODEX_MODEL_STREAM_PROXY_STATE_ROOT: root,
      CODEX_MODEL_STREAM_PROXY_PORT: String(port),
      CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100",
      ...overrides,
    },
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

async function cleanupRunner(child, root) {
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(resolve, 3000))]);
  }
  assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), "codex-model-proxy-runner-test-")));
  fs.rmSync(root, { recursive: true, force: true });
}

test("invalid environment exits without claiming a persistent runner lock", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-proxy-runner-test-"));
  const child = launchRunner(root, await reservePort(), { CODEX_MODEL_STREAM_PROXY_PROGRESS_IDLE_TIMEOUT_MS: "invalid" });
  try {
    await waitFor(() => child.exitCode !== null);
    assert.notEqual(child.exitCode, 0);
    assert.equal(fs.existsSync(path.join(root, "codex-model-stream-proxy.lock.json")), false);
  } finally {
    await cleanupRunner(child, root);
  }
});

test("occupied listen port reports failed startup and releases its own lock", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-proxy-runner-test-"));
  const occupied = http.createServer((_request, response) => response.end("other service"));
  const child = launchRunner(root, await listen(occupied));
  try {
    await waitFor(() => child.exitCode !== null);
    assert.notEqual(child.exitCode, 0);
    assert.equal(fs.existsSync(path.join(root, "codex-model-stream-proxy.lock.json")), false);
    const runtime = JSON.parse(fs.readFileSync(path.join(root, "codex-model-stream-proxy-runtime.json"), "utf8"));
    assert.equal(runtime.status, "failed");
    assert.equal(runtime.error.code, "EADDRINUSE");
  } finally {
    await cleanupRunner(child, root);
    await new Promise(resolve => occupied.close(resolve));
  }
});

test("stop file drains an active request before releasing lock and port", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-proxy-runner-test-"));
  let releaseUpstream;
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sse({ type: "response.output_text.delta", delta: "protected text" }));
    releaseUpstream = () => response.end(sse({ type: "response.completed", response: { id: "resp_drain", status: "completed", output: [] } }));
  });
  const upstreamPort = await listen(upstream);
  const port = await reservePort();
  const child = launchRunner(root, port, {
    CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN: `http://127.0.0.1:${upstreamPort}`,
    CODEX_MODEL_STREAM_PROXY_DRAIN_TIMEOUT_MS: "3000",
  });
  const runtimePath = path.join(root, "codex-model-stream-proxy-runtime.json");
  try {
    await waitFor(() => fs.existsSync(runtimePath));
    const before = await fetch(`http://127.0.0.1:${port}/health`).then(response => response.json());
    assert.equal(before.pid, child.pid);
    assert.equal(before.progressIdleTimeoutMs, 40000);
    assert.ok(before.instanceToken);
    assert.ok(before.implementationVersion);
    const pending = modelRequest(port);
    await waitFor(() => releaseUpstream);
    fs.writeFileSync(path.join(root, "codex-model-stream-proxy.stop"), "test drain", "utf8");
    await waitFor(() => JSON.parse(fs.readFileSync(runtimePath, "utf8")).status === "draining");
    assert.equal(child.exitCode, null);
    const rejected = await modelRequest(port);
    assert.equal(rejected.statusCode, 503);
    releaseUpstream();
    const completed = await pending;
    assert.match(completed.body, /protected text/);
    assert.match(completed.body, /response.completed/);
    await waitFor(() => child.exitCode !== null);
    assert.equal(child.exitCode, 0);
    assert.equal(fs.existsSync(path.join(root, "codex-model-stream-proxy.lock.json")), false);
    assert.equal(JSON.parse(fs.readFileSync(runtimePath, "utf8")).status, "stopped");
  } finally {
    await cleanupRunner(child, root);
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test("valid maintenance lease fences unattended start without touching a runner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-proxy-runner-test-"));
  try {
    const stateRoot = path.join(root, "state");
    fs.mkdirSync(stateRoot);
    const marker = path.join(stateRoot, "codex-model-stream-proxy.maintenance.json");
    fs.writeFileSync(marker, JSON.stringify({ token: "release-fixture", expiresAt: new Date(Date.now() + 60000).toISOString() }), "utf8");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.resolve("ops/start-codex-model-stream-proxy.ps1"), "-DataRoot", root], { windowsHide: true, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).reason, "model_proxy_maintenance");
    assert.equal(fs.existsSync(path.join(stateRoot, "codex-model-stream-proxy.lock.json")), false);
    assert.equal(fs.existsSync(path.join(stateRoot, "codex-model-stream-proxy-runtime.json")), false);
    assert.equal(fs.existsSync(marker), true);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), "codex-model-proxy-runner-test-")));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
