import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const fixturePath = path.join(repoRoot, "tests", "fixtures", "broker-delay-mcp.mjs");
const brokerSourcePath = "C:\\Users\\Stardust\\.codex\\mcp-http-broker\\broker.mjs";
const toolName = "delay_echo";
const requestTimeoutMs = 250;
const waitTimeoutCapMs = 2500;
const backendConnectTimeoutMs = 2500;
const delayedCallMs = 900;

function replaceExactlyOnce(text, searchValue, replaceValue, label) {
  const firstIndex = text.indexOf(searchValue);
  assert.notEqual(firstIndex, -1, `${label}: expected source fragment not found`);
  const secondIndex = text.indexOf(searchValue, firstIndex + searchValue.length);
  assert.equal(secondIndex, -1, `${label}: source fragment matched more than once`);
  return text.replace(searchValue, replaceValue);
}

async function getFreePort() {
  const server = http.createServer((_req, res) => {
    res.statusCode = 204;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object", "expected a bound address");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForBrokerReady(port, statePath, brokerProcess, stderrBuffer) {
  const deadline = Date.now() + 10_000;
  const url = `http://127.0.0.1:${port}/memory-store/mcp`;
  while (Date.now() < deadline) {
    if (brokerProcess.exitCode !== null) {
      throw new Error(`temporary broker exited early with code ${brokerProcess.exitCode}: ${stderrBuffer.join("")}`);
    }
    if (fs.existsSync(statePath)) {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: { Accept: "text/event-stream" },
        });
        await response.body?.cancel();
        if (response.status === 200 || response.status === 400 || response.status === 405) {
          return;
        }
      } catch {
        // keep polling until ready
      }
    }
    await sleep(100);
  }
  throw new Error(`temporary broker did not become ready in time: ${stderrBuffer.join("")}`);
}

function readTextContent(result) {
  return (result?.content || [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

async function createClient(endpointUrl) {
  const client = new Client({ name: "broker-wait-timeout-smoke", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(endpointUrl));
  await client.connect(transport);
  return client;
}

async function callDelay(endpointUrl, args) {
  const client = await createClient(endpointUrl);
  const startedAt = Date.now();
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    const elapsedMs = Date.now() - startedAt;
    if (result.isError) {
      return { ok: false, elapsedMs, error: readTextContent(result) || "tool returned isError=true" };
    }
    return {
      ok: true,
      elapsedMs,
      payload: JSON.parse(readTextContent(result)),
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

let tempRoot = "";
let brokerProcess = null;

try {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-broker-wait-smoke-"));
  const tempBrokerPath = path.join(tempRoot, "broker.mjs");
  const logPath = path.join(tempRoot, "broker.log");
  const statePath = path.join(tempRoot, "broker-state.json");
  const port = await getFreePort();

  let brokerSource = fs.readFileSync(brokerSourcePath, "utf8").replace(/^\uFEFF/, "");
  brokerSource = replaceExactlyOnce(
    brokerSource,
    'args: [path.join(antigravityRoot, "mcp-memory-store", "dist", "index.js")],',
    `args: [${JSON.stringify(fixturePath)}],`,
    "patch memory-store args",
  );
  brokerSource = replaceExactlyOnce(
    brokerSource,
    'cwd: path.join(antigravityRoot, "mcp-memory-store"),',
    `cwd: ${JSON.stringify(repoRoot)},`,
    "patch memory-store cwd",
  );
  brokerSource = replaceExactlyOnce(
    brokerSource,
    "Number(connectTimeoutMs || requestTimeoutMs),",
    "Number(connectTimeoutMs || process.env.BROKER_BACKEND_CONNECT_TIMEOUT_MS || requestTimeoutMs),",
    "patch backend connect timeout fallback",
  );
  fs.writeFileSync(tempBrokerPath, brokerSource, "utf8");

  const stderrBuffer = [];
  brokerProcess = spawn(process.execPath, [tempBrokerPath], {
    cwd: tempRoot,
    env: {
      ...process.env,
      CODEX_MCP_BROKER_HOST: "127.0.0.1",
      CODEX_MCP_BROKER_PORT: String(port),
      CODEX_MCP_BROKER_LOG: logPath,
      CODEX_MCP_BROKER_STATE: statePath,
      CODEX_MCP_BROKER_REQUEST_TIMEOUT_MS: String(requestTimeoutMs),
      CODEX_MCP_BROKER_WAIT_TIMEOUT_MS: String(waitTimeoutCapMs),
      BROKER_BACKEND_CONNECT_TIMEOUT_MS: String(backendConnectTimeoutMs),
      BROKER_DELAY_TOOL_NAME: toolName,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  brokerProcess.stdout?.on("data", () => {});
  brokerProcess.stderr?.on("data", (chunk) => {
    stderrBuffer.push(String(chunk));
    if (stderrBuffer.length > 20) stderrBuffer.shift();
  });

  await waitForBrokerReady(port, statePath, brokerProcess, stderrBuffer);

  const endpointUrl = `http://127.0.0.1:${port}/memory-store/mcp`;
  const warmup = await callDelay(endpointUrl, {
    delayMs: 20,
    label: "warmup-connect",
    waitSeconds: 1,
  });
  assert.equal(warmup.ok, true, `warmup should establish backend connection: ${warmup.error || ""}`);

  const noWait = await callDelay(endpointUrl, {
    delayMs: delayedCallMs,
    label: "base-timeout",
  });
  assert.equal(noWait.ok, false, "call without waitSeconds/timeout should time out");
  assert.match(noWait.error || "", /250ms|timed out|timeout/iu);
  assert.ok(
    noWait.elapsedMs >= 150 && noWait.elapsedMs <= 1200,
    `base timeout should fail around ${requestTimeoutMs}ms, actual ${noWait.elapsedMs}ms`,
  );

  await sleep(delayedCallMs + 250);

  const withWait = await callDelay(endpointUrl, {
    delayMs: delayedCallMs,
    label: "wait-seconds",
    waitSeconds: 1,
  });
  assert.equal(withWait.ok, true, `waitSeconds should allow a delay longer than base timeout: ${withWait.error || ""}`);
  assert.equal(withWait.payload.delayMs, delayedCallMs);
  assert.equal(withWait.payload.waitSeconds, 1);
  assert.ok(
    withWait.elapsedMs >= delayedCallMs - 100 && withWait.elapsedMs < waitTimeoutCapMs,
    `waitSeconds call should complete after the delayed backend response, actual ${withWait.elapsedMs}ms`,
  );

  const withTimeout = await callDelay(endpointUrl, {
    delayMs: delayedCallMs,
    label: "timeout-override",
    timeout: 800,
  });
  assert.equal(withTimeout.ok, true, `timeout arg should allow a delay longer than base timeout: ${withTimeout.error || ""}`);
  assert.equal(withTimeout.payload.delayMs, delayedCallMs);
  assert.equal(withTimeout.payload.timeout, 800);
  assert.ok(
    withTimeout.elapsedMs >= delayedCallMs - 100 && withTimeout.elapsedMs < waitTimeoutCapMs,
    `timeout override call should complete after the delayed backend response, actual ${withTimeout.elapsedMs}ms`,
  );

  console.log(
    JSON.stringify(
      {
        pass: true,
        endpointUrl,
        requestTimeoutMs,
        waitTimeoutCapMs,
        backendConnectTimeoutMs,
        delayedCallMs,
        noWait,
        withWait: {
          ok: withWait.ok,
          elapsedMs: withWait.elapsedMs,
          payload: withWait.payload,
        },
        withTimeout: {
          ok: withTimeout.ok,
          elapsedMs: withTimeout.elapsedMs,
          payload: withTimeout.payload,
        },
        tempArtifacts: { tempBrokerPath, logPath, statePath },
      },
      null,
      2,
    ),
  );
  console.log("broker-wait-timeout-smoke.mjs PASS");
} finally {
  if (brokerProcess && brokerProcess.exitCode === null) {
    brokerProcess.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => brokerProcess.once("exit", resolve)),
      sleep(5_000).then(() => {
        brokerProcess.kill("SIGKILL");
      }),
    ]).catch(() => {});
  }
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
