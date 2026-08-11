import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const brokerRoot = path.resolve(__dirname, "..");
const mcpRoot = path.resolve(brokerRoot, "..");
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-timeout-"));
const fakeSandboxRoot = path.join(dataRoot, "fake-sandbox");
const markerPath = path.join(dataRoot, "abort-marker.json");
const memoryStoreCandidates = [
  process.env.MEMORY_STORE_MCP_ROOT,
  path.join(mcpRoot, "memory-store"),
  path.join(os.homedir(), ".gemini", "antigravity", "mcp-memory-store"),
].filter(Boolean);
const memoryStoreRoot = memoryStoreCandidates.find((candidate) =>
  fs.existsSync(path.join(candidate, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "server", "index.js")),
);

if (!memoryStoreRoot) {
  throw new Error("Broker timeout smoke requires an installed memory-store MCP SDK dependency");
}

const sdkRoot = path.join(memoryStoreRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
  import(pathToFileURL(path.join(sdkRoot, "client", "index.js")).href),
  import(pathToFileURL(path.join(sdkRoot, "client", "streamableHttp.js")).href),
]);

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
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.setTimeout(500, () => request.destroy(new Error("health request timed out")));
    request.once("error", reject);
  });
}

function readDeepHealth(port, endpoint) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      `http://127.0.0.1:${port}/health?endpoint=${encodeURIComponent(endpoint)}&deep=1`,
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")));
      },
    );
    request.setTimeout(20000, () => request.destroy(new Error("deep health request timed out")));
    request.once("error", reject);
  });
}

fs.mkdirSync(path.join(fakeSandboxRoot, "dist"), { recursive: true });
fs.writeFileSync(path.join(fakeSandboxRoot, "dist", "index.js"), `
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const sdkRoot = ${JSON.stringify(sdkRoot)};
const [{ Server }, { StdioServerTransport }, types] = await Promise.all([
  import(pathToFileURL(sdkRoot + "/server/index.js").href),
  import(pathToFileURL(sdkRoot + "/server/stdio.js").href),
  import(pathToFileURL(sdkRoot + "/types.js").href),
]);
const server = new Server({ name: "fake-sandbox", version: "1.0.0" }, { capabilities: { tools: {} } });
let listCount = 0;
server.setRequestHandler(types.ListToolsRequestSchema, async () => {
  listCount += 1;
  if (listCount > 2) await new Promise(() => undefined);
  return { tools: [{ name: "delay", description: "delay", inputSchema: { type: "object" } }] };
});
server.setRequestHandler(types.CallToolRequestSchema, async (request, extra) => {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 5000);
    extra.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ meta: request.params._meta, aborted: true }));
      reject(extra.signal.reason || new Error("aborted"));
    }, { once: true });
  });
  return { content: [{ type: "text", text: "late" }] };
});
await server.connect(new StdioServerTransport());
`, "utf8");

const port = await reservePort();
const child = spawn(process.execPath, [path.join(brokerRoot, "broker.mjs")], {
  cwd: brokerRoot,
  env: {
    ...process.env,
    CODEX_MCP_BROKER_PORT: String(port),
    CODEX_TOOLKIT_MCP_ROOT: mcpRoot,
    CODEX_TOOLKIT_DATA_ROOT: dataRoot,
    CODEX_TOOLKIT_BROKER_ROOT: brokerRoot,
    CODEX_MCP_BROKER_REQUEST_TIMEOUT_MS: "2000",
    CODEX_MCP_BROKER_WAIT_TIMEOUT_MS: "5000",
    MEMORY_STORE_MCP_ROOT: memoryStoreRoot,
    SANDBOX_MCP_ROOT: fakeSandboxRoot,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

let client;
try {
  const deadline = Date.now() + 8000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`broker exited with ${child.exitCode}: ${stderr}`);
    }
    try {
      ready = (await readHealth(port)) === 200;
      if (ready) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(ready, true, `broker health did not become ready: ${stderr}`);
  const startupHealth = await readDeepHealth(port, "sandbox");
  assert.equal(startupHealth.healthy, true, `sandbox backend did not prewarm: ${JSON.stringify(startupHealth)}`);
  assert.equal(startupHealth.probeTimeoutMs, 15000);

  client = new Client({ name: "broker-timeout-smoke", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/sandbox/mcp`)));
  await client.listTools();
  const result = await client.callTool({ name: "delay", arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.errorType, "broker_backend_timeout");
  assert.equal(result.structuredContent?.timeoutMs, 2000);

  const markerDeadline = Date.now() + 2000;
  while (!fs.existsSync(markerPath) && Date.now() < markerDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.equal(marker.aborted, true);
  assert.equal(marker.meta?.["io.github.jurybu/broker"]?.timeoutMs, 2000);
  assert.equal(typeof marker.meta?.["io.github.jurybu/broker"]?.deadlineAtMs, "number");

  await assert.rejects(() => client.listTools(), /timed out/i);
  await assert.rejects(() => client.listTools(), /timed out/i);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const recoveredTools = await client.listTools();
  assert.deepEqual(recoveredTools.tools.map((tool) => tool.name), ["delay"]);
  console.log("Broker timeout smoke preserved tool timeout semantics and recovered an unresponsive idle backend.");
} finally {
  await client?.close().catch(() => undefined);
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
  fs.rmSync(dataRoot, { recursive: true, force: true });
}
