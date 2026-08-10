import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const brokerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpRoot = path.resolve(brokerRoot, "..");

function findMemoryStoreRoot() {
  return [
    process.env.MEMORY_STORE_MCP_ROOT,
    path.join(mcpRoot, "memory-store"),
    path.join(os.homedir(), ".gemini", "antigravity", "mcp-memory-store"),
  ].filter(Boolean).find((candidate) => fs.existsSync(path.join(
    candidate,
    "node_modules",
    "@modelcontextprotocol",
    "sdk",
    "dist",
    "esm",
    "server",
    "index.js",
  )));
}

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

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}${pathname}`, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    });
    request.setTimeout(2000, () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
  });
}

test("backend connection failures preserve child stderr without PATH node", async () => {
  const memoryStoreRoot = findMemoryStoreRoot();
  assert.ok(memoryStoreRoot, "diagnostic test requires the memory-store MCP SDK");
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-diagnostics-"));
  const napcatRoot = path.join(testRoot, "napcat-mcp");
  const logPath = path.join(testRoot, "broker.log");
  fs.mkdirSync(path.join(napcatRoot, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(napcatRoot, "src", "index.mjs"),
    'process.stderr.write("NAPCAT_DIAGNOSTIC_SENTINEL\\n"); process.exit(17);\n',
    "utf8",
  );

  const port = await reservePort();
  const child = spawn(process.execPath, [path.join(brokerRoot, "broker.mjs")], {
    cwd: brokerRoot,
    env: {
      ...process.env,
      PATH: "",
      CODEX_MCP_BROKER_PORT: String(port),
      CODEX_MCP_BROKER_LOG: logPath,
      CODEX_MCP_BROKER_STATE: path.join(testRoot, "broker-state.json"),
      CODEX_TOOLKIT_DATA_ROOT: testRoot,
      CODEX_TOOLKIT_ENABLE_NAPCAT_MCP: "1",
      MEMORY_STORE_MCP_ROOT: memoryStoreRoot,
      NAPCAT_MCP_ROOT: napcatRoot,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });

  try {
    const deadline = Date.now() + 8000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const health = await getJson(port, "/health");
        ready = health.ok === true;
        if (ready) break;
      } catch {
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, "broker did not become ready");
    const deepHealth = await getJson(port, "/health?endpoint=napcat&deep=1");
    assert.equal(deepHealth.healthy, false);
    const logDeadline = Date.now() + 2000;
    let logText = "";
    while (Date.now() < logDeadline) {
      logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
      if (logText.includes("NAPCAT_DIAGNOSTIC_SENTINEL")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(logText, /"message":"backend connect failed"/);
    assert.match(logText, /"endpoint":"napcat"/);
    assert.match(logText, /"backendStderr":"NAPCAT_DIAGNOSTIC_SENTINEL/);
  } finally {
    if (child.exitCode === null) child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});
