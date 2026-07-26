import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const brokerRoot = path.resolve(__dirname, "..");
const mcpRoot = path.resolve(brokerRoot, "..");
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-smoke-"));
const memoryStoreCandidates = [
  process.env.MEMORY_STORE_MCP_ROOT,
  path.join(mcpRoot, "memory-store"),
  path.join(os.homedir(), ".gemini", "antigravity", "mcp-memory-store"),
].filter(Boolean);
const memoryStoreRoot = memoryStoreCandidates.find((candidate) =>
  fs.existsSync(path.join(candidate, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "server", "index.js")),
);

if (!memoryStoreRoot) {
  throw new Error("Broker startup smoke requires an installed memory-store MCP SDK dependency");
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

function readHealth(port) {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/health`, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`health returned HTTP ${response.statusCode}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    request.setTimeout(500, () => request.destroy(new Error("health request timed out")));
    request.once("error", reject);
  });
}

const port = await reservePort();
const child = spawn(process.execPath, [path.join(brokerRoot, "broker.mjs")], {
  cwd: brokerRoot,
  env: {
    ...process.env,
    CODEX_MCP_BROKER_PORT: String(port),
    CODEX_TOOLKIT_MCP_ROOT: mcpRoot,
    CODEX_TOOLKIT_DATA_ROOT: dataRoot,
    CODEX_TOOLKIT_BROKER_ROOT: brokerRoot,
    CODEX_TOOLKIT_ENABLE_NAPCAT_MCP: "1",
    MEMORY_STORE_MCP_ROOT: memoryStoreRoot,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

try {
  const deadline = Date.now() + 8000;
  let healthBody = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`broker exited with ${child.exitCode}: ${stderr}`);
    }
    try {
      healthBody = await readHealth(port);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!healthBody) {
    throw new Error(`broker health did not become ready: ${stderr}`);
  }
  const health = JSON.parse(healthBody);
  if (!Array.isArray(health?.endpoints) || !health.endpoints.includes("napcat")) {
    throw new Error("NapCat endpoint was not enabled during startup smoke test");
  }
  console.log("Broker startup smoke passed with NapCat enabled.");
} finally {
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
