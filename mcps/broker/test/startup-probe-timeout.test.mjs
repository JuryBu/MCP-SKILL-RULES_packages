import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourceBrokerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceMcpRoot = path.resolve(sourceBrokerRoot, "..");
const sourceSdkRoot = path.join(sourceBrokerRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function requestJson(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.body ? Buffer.from(JSON.stringify(options.body)) : null;
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method: options.method || "GET",
      headers: {
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
      }));
    });
    request.setTimeout(options.timeoutMs || 4000, () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
    request.end(payload);
  });
}

test("private endpoint startup timeout allows a slow backend and survives scoped reload", { timeout: 15000 }, async () => {
  assert.equal(fs.existsSync(path.join(sourceSdkRoot, "server", "index.js")), true);
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-slow-startup-"));
  const brokerRoot = path.join(testRoot, "broker");
  const memoryStoreRoot = path.join(testRoot, "missing-memory-store");
  const napcatRoot = path.join(testRoot, "napcat-mcp");
  const dataRoot = path.join(testRoot, "data");
  const controlToken = "slow-startup-control-token";
  fs.mkdirSync(brokerRoot, { recursive: true });
  fs.mkdirSync(path.join(napcatRoot, "src"), { recursive: true });
  for (const name of ["broker.mjs", "endpoint-config.mjs", "request-lifecycle.mjs"]) {
    fs.copyFileSync(path.join(sourceBrokerRoot, name), path.join(brokerRoot, name));
  }
  fs.writeFileSync(path.join(brokerRoot, "broker-private.env.json"), JSON.stringify({
    CODEX_MCP_BROKER_CONTROL_TOKEN: controlToken,
    CODEX_MCP_BROKER_NAPCAT_STARTUP_TIMEOUT_MS: "1500",
  }), "utf8");
  fs.writeFileSync(path.join(napcatRoot, "src", "index.mjs"), `
import path from "node:path";
import { pathToFileURL } from "node:url";
await new Promise((resolve) => setTimeout(resolve, 450));
const sdkRoot = process.env.MCP_SDK_ROOT;
const [{ Server }, { StdioServerTransport }, types] = await Promise.all([
  import(pathToFileURL(path.join(sdkRoot, "server", "index.js")).href),
  import(pathToFileURL(path.join(sdkRoot, "server", "stdio.js")).href),
  import(pathToFileURL(path.join(sdkRoot, "types.js")).href),
]);
const server = new Server({ name: "slow-napcat", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(types.ListToolsRequestSchema, async () => ({
  tools: [{ name: "slow_fixture", description: "slow fixture", inputSchema: { type: "object" } }],
}));
await server.connect(new StdioServerTransport());
`, "utf8");

  const port = await reservePort();
  const child = spawn(process.execPath, [path.join(brokerRoot, "broker.mjs")], {
    cwd: brokerRoot,
    env: {
      ...process.env,
      CODEX_MCP_BROKER_PORT: String(port),
      CODEX_MCP_BROKER_CONTROL_TOKEN: controlToken,
      CODEX_MCP_BROKER_SDK_ROOT: sourceSdkRoot,
      CODEX_TOOLKIT_MCP_ROOT: sourceMcpRoot,
      CODEX_TOOLKIT_DATA_ROOT: dataRoot,
      CODEX_TOOLKIT_ENABLE_NAPCAT_MCP: "1",
      MEMORY_STORE_MCP_ROOT: memoryStoreRoot,
      NAPCAT_MCP_TOKEN: "",
      NAPCAT_MCP_ROOT: napcatRoot,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  try {
    const readyDeadline = Date.now() + 5000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      if (child.exitCode !== null) throw new Error(`broker exited with ${child.exitCode}: ${stderr}`);
      try {
        ready = (await requestJson(port, "/health", { timeoutMs: 500 })).body.ok === true;
        if (ready) break;
      } catch {
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, `broker did not become ready: ${stderr}`);

    const firstStartedAt = Date.now();
    const firstHealth = await requestJson(port, "/health?endpoint=napcat&deep=1");
    assert.equal(firstHealth.body.healthy, true);
    assert.equal(firstHealth.body.probeTimeoutMs, 1500);
    assert.equal(firstHealth.body.startupProbeTimeoutMs, 1500);
    assert.equal(firstHealth.body.toolCount, 1);
    assert.ok(Date.now() - firstStartedAt >= 350, "slow fixture did not exercise the startup wait");
    const warmHealth = await requestJson(port, "/health?endpoint=napcat&deep=1");
    assert.equal(warmHealth.body.healthy, true);
    assert.equal(warmHealth.body.probeTimeoutMs, 15000);
    assert.equal(warmHealth.body.startupProbeTimeoutMs, 1500);

    fs.writeFileSync(path.join(brokerRoot, "broker-private.env.json"), JSON.stringify({
      CODEX_MCP_BROKER_CONTROL_TOKEN: controlToken,
      CODEX_MCP_BROKER_NAPCAT_STARTUP_TIMEOUT_MS: "1900",
    }), "utf8");
    const reload = await requestJson(port, "/__control/reload-backend", {
      method: "POST",
      token: controlToken,
      body: { endpoint: "napcat", timeoutMs: 3000 },
    });
    assert.equal(reload.statusCode, 200);
    assert.equal(reload.body.ok, true);
    assert.equal(reload.body.brokerPid, child.pid);
    assert.equal(reload.body.configRefresh.startupProbeTimeoutMs, 1900);

    const secondHealth = await requestJson(port, "/health?endpoint=napcat&deep=1");
    assert.equal(secondHealth.body.healthy, true);
    assert.equal(secondHealth.body.probeTimeoutMs, 1900);
    assert.equal(secondHealth.body.startupProbeTimeoutMs, 1900);
    assert.equal(secondHealth.body.pid, child.pid);
  } finally {
    if (child.exitCode === null) child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});
