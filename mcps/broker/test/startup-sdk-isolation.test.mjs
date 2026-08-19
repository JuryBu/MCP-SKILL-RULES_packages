import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const brokerRoot = path.resolve(__dirname, "..");
const mcpRoot = path.resolve(brokerRoot, "..");
const brokerSdkRoot = path.join(brokerRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");

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

function requestJson(port, requestPath, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}${requestPath}`, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
      }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
  });
}

test("broker startup is isolated from the memory-store installation", { timeout: 20000 }, async () => {
  assert.equal(fs.existsSync(path.join(brokerSdkRoot, "server", "index.js")), true);
  assert.equal(fs.existsSync(path.join(brokerSdkRoot, "client", "index.js")), true);

  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-sdk-isolation-"));
  const dataRoot = path.join(testRoot, "data");
  const missingMemoryStoreRoot = path.join(testRoot, "missing-memory-store");
  const port = await reservePort();
  const child = spawn(process.execPath, [path.join(brokerRoot, "broker.mjs")], {
    cwd: brokerRoot,
    env: {
      ...process.env,
      CODEX_MCP_BROKER_PORT: String(port),
      CODEX_TOOLKIT_MCP_ROOT: mcpRoot,
      CODEX_TOOLKIT_DATA_ROOT: dataRoot,
      CODEX_TOOLKIT_BROKER_ROOT: brokerRoot,
      MEMORY_STORE_MCP_ROOT: missingMemoryStoreRoot,
      CODEX_TOOLKIT_ENABLE_NAPCAT_MCP: "0",
      CODEX_TOOLKIT_ENABLE_WECHAT_DOCS_MCP: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    const deadline = Date.now() + 8000;
    let health;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`broker exited with ${child.exitCode}: ${stderr}`);
      try {
        health = await requestJson(port, "/health", 500);
        if (health.body?.ok === true) break;
      } catch {
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(health?.body?.ok, true, `broker health did not become ready: ${stderr}`);
    assert.equal(health.body.healthy, true);
    assert.ok(health.body.endpoints.includes("memory-store"));

    const memoryStoreHealth = await requestJson(port, "/health?endpoint=memory-store&deep=1", 20000);
    assert.equal(memoryStoreHealth.statusCode, 200);
    assert.equal(memoryStoreHealth.body.healthy, false);
    assert.match(memoryStoreHealth.body.error, /memory-store|no such file|ENOENT|Cannot find module/i);

    const healthAfterFailure = await requestJson(port, "/health", 1000);
    assert.equal(healthAfterFailure.body.ok, true);
    assert.equal(healthAfterFailure.body.pid, child.pid);
  } finally {
    if (child.exitCode === null) child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});
