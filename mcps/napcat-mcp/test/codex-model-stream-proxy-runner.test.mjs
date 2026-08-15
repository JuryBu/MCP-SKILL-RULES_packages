import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  fs.copyFileSync(runtimeBackupPath, runtimePath);
  fs.rmSync(runtimeBackupPath, { force: true });
  await waitFor(() => readEvents(logPath).some((event) => event.type === "runtime_state_write_recovered"), 3_000);
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  assert.equal(runtime.status, "running");
  assert.equal(runtime.heartbeatIntervalMs, 100);
});
