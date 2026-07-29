import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fingerprintApiKey } from "../exa-key-pool.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const brokerRoot = path.resolve(__dirname, "..");
const mcpRoot = path.resolve(brokerRoot, "..");
const memoryStoreCandidates = [
  process.env.MEMORY_STORE_MCP_ROOT,
  path.join(mcpRoot, "memory-store"),
  path.join(os.homedir(), ".gemini", "antigravity", "mcp-memory-store"),
].filter(Boolean);
const memoryStoreRoot = memoryStoreCandidates.find((candidate) =>
  fs.existsSync(
    path.join(
      candidate,
      "node_modules",
      "@modelcontextprotocol",
      "sdk",
      "dist",
      "esm",
      "client",
      "index.js",
    ),
  ),
);

if (!memoryStoreRoot) {
  throw new Error("Exa bridge failover test requires an installed MCP SDK");
}

const sdkRoot = path.join(
  memoryStoreRoot,
  "node_modules",
  "@modelcontextprotocol",
  "sdk",
  "dist",
  "esm",
);
const [{ Client }, { StdioClientTransport }] = await Promise.all([
  import(pathToFileURL(path.join(sdkRoot, "client", "index.js")).href),
  import(pathToFileURL(path.join(sdkRoot, "client", "stdio.js")).href),
]);

test("bridge hides an MCP-body 402 and retries the call with the next key", async () => {
  const quotaKey = "quota-key";
  const healthyKey = "healthy-key";
  const seenKeys = [];
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exa-bridge-failover-"));
  const statePath = path.join(dataRoot, "state.json");
  const remoteServer = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const apiKey = String(request.headers["x-api-key"] || "");
      seenKeys.push(apiKey);
      const result =
        apiKey === quotaKey
          ? {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "web_search_exa error (402): You have exceeded your credits limit",
                },
              ],
            }
          : {
              isError: false,
              content: [{ type: "text", text: "healthy-key-result" }],
            };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result,
        })}\n\n`,
      );
    });
  });

  await new Promise((resolve, reject) => {
    remoteServer.once("error", reject);
    remoteServer.listen(0, "127.0.0.1", resolve);
  });
  const address = remoteServer.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const remoteUrl = `http://127.0.0.1:${port}/mcp`;
  const client = new Client({ name: "exa-bridge-failover-test", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(brokerRoot, "exa-stateless-stdio.mjs")],
    cwd: brokerRoot,
    env: {
      ...process.env,
      MEMORY_STORE_MCP_ROOT: memoryStoreRoot,
      EXA_MCP_REMOTE_URL: `${remoteUrl}?exaApiKey=${quotaKey}`,
      EXA_MCP_REMOTE_BASE_URL: remoteUrl,
      EXA_MCP_API_KEYS: healthyKey,
      EXA_MCP_PUBLIC_FALLBACK_ENABLED: "0",
      EXA_MCP_POOL_STATE_PATH: statePath,
      EXA_MCP_KEY_COOLDOWN_MS: "86400000",
      EXA_MCP_KEY_COOLDOWN_JITTER_MS: "0",
      EXA_STATELESS_CALL_MAX_ATTEMPTS: "1",
    },
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const first = await client.callTool({
      name: "web_search_exa",
      arguments: { query: "first" },
    });
    assert.equal(first.isError, false);
    assert.equal(first.content[0].text, "healthy-key-result");
    assert.deepEqual(seenKeys, [quotaKey, healthyKey]);

    const persistedText = fs.readFileSync(statePath, "utf8");
    assert.equal(persistedText.includes(quotaKey), false);
    assert.equal(persistedText.includes(healthyKey), false);
    assert.equal(persistedText.includes(remoteUrl), false);
    const persisted = JSON.parse(persistedText);
    assert.equal(persisted.endpoints[fingerprintApiKey(quotaKey)].status, "open");

    const second = await client.callTool({
      name: "web_search_exa",
      arguments: { query: "second" },
    });
    assert.equal(second.content[0].text, "healthy-key-result");
    assert.deepEqual(seenKeys, [quotaKey, healthyKey, healthyKey]);
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => remoteServer.close(resolve));
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
