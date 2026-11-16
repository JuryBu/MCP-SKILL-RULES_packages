import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceBrokerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceSdkRoot = [
  process.env.CODEX_MCP_BROKER_SDK_ROOT,
  path.join(sourceBrokerRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm"),
  path.join(sourceBrokerRoot, "..", "communication-core", "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm"),
].find(candidate => candidate && ["server/index.js", "client/index.js", "client/streamableHttp.js", "types.js"].every(file => fs.existsSync(path.join(candidate, file))));
assert.ok(sourceSdkRoot, "an installed MCP SDK or explicit CODEX_MCP_BROKER_SDK_ROOT is required");
const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
  import(pathToFileURL(path.join(sourceSdkRoot, "client", "index.js")).href),
  import(pathToFileURL(path.join(sourceSdkRoot, "client", "streamableHttp.js")).href),
]);
const legacyEndpoints = ["playwright", "sequential-thinking", "exa", "memory-store", "web-fetcher", "sandbox", "subagent"].sort();
const fixtureTool = { name: "communication_fixture_echo_env_path", description: "Isolated environment/path fixture only", inputSchema: { type: "object", properties: {}, additionalProperties: false } };

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function requestJson(port, requestPath, { method = "GET", timeoutMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: requestPath, method, agent: false }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }); } catch (error) { reject(error); }
      });
      response.once("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("isolated_request_timeout")));
    request.once("error", reject);
    request.end();
  });
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function readEvents(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

async function isolatedBroker(context, { enabled, customRoot = false, registry = "nonempty" } = {}) {
  assert.equal(fs.existsSync(path.join(sourceSdkRoot, "server", "index.js")), true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-communication-endpoint-"));
  const brokerRoot = path.join(root, "broker");
  const toolkitRoot = path.join(root, "isolated toolkit 中文");
  const coreRoot = customRoot ? path.join(root, "custom core 中文 path") : path.join(toolkitRoot, "communication-core");
  const coreScript = path.join(coreRoot, "scripts", "broker-stdio.mjs");
  const eventsFile = path.join(root, "fixture-events.jsonl");
  const stateFile = path.join(root, "broker-state.json");
  const registryFile = path.join(root, "synthetic registry 中文.json");
  const clients = [];
  let child;
  let exited;
  context.after(async () => {
    for (const client of clients) await client.close();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (exited) {
      let timer;
      const closed = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); })]).finally(() => clearTimeout(timer));
      assert.equal(closed, true, "owned temporary broker did not exit");
    }
    for (const event of readEvents(eventsFile).filter(event => event.kind === "started")) {
      assert.equal(event.script, coreScript);
      assert.ok(Number.isSafeInteger(event.pid) && event.pid > 0);
      const deadline = Date.now() + 1500;
      while (alive(event.pid) && Date.now() < deadline) await delay(20);
      if (alive(event.pid)) process.kill(event.pid);
      const killedDeadline = Date.now() + 1500;
      while (alive(event.pid) && Date.now() < killedDeadline) await delay(20);
      assert.equal(alive(event.pid), false, "owned fixture backend did not exit");
    }
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(fs.existsSync(root), false);
  });
  fs.mkdirSync(brokerRoot, { recursive: true });
  fs.mkdirSync(path.dirname(coreScript), { recursive: true });
  for (const name of ["broker.mjs", "endpoint-config.mjs", "request-lifecycle.mjs"]) fs.copyFileSync(path.join(sourceBrokerRoot, name), path.join(brokerRoot, name));
  fs.writeFileSync(path.join(brokerRoot, "broker-private.env.json"), "{}", "utf8");
  fs.writeFileSync(registryFile, JSON.stringify({ fixture_only: true }), "utf8");
  fs.writeFileSync(coreScript, `
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const eventsFile = ${JSON.stringify(eventsFile)};
const record = value => fs.appendFileSync(eventsFile, JSON.stringify(value) + "\\n", "utf8");
const sdkRoot = process.env.CODEX_MCP_BROKER_SDK_ROOT;
const [{ Server }, { StdioServerTransport }, types] = await Promise.all([
  import(pathToFileURL(path.join(sdkRoot, "server", "index.js")).href),
  import(pathToFileURL(path.join(sdkRoot, "server", "stdio.js")).href),
  import(pathToFileURL(path.join(sdkRoot, "types.js")).href),
]);
record({ kind: "started", pid: process.pid, script: process.argv[1] });
const server = new Server({ name: "isolated-communication-endpoint-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(types.ListToolsRequestSchema, async () => ({ tools: [${JSON.stringify(fixtureTool)}] }));
server.setRequestHandler(types.CallToolRequestSchema, async request => {
  if (request.params.name !== ${JSON.stringify(fixtureTool.name)}) return { isError: true, content: [{ type: "text", text: "unknown fixture tool" }] };
  const snapshot = {
    cwd: process.cwd(), executable: process.execPath, argv: process.argv.slice(1),
    wrapper: process.env.CODEX_MCP_WRAPPER, toolName: process.env.CODEX_MCP_TOOL_NAME,
    registryPresent: Object.hasOwn(process.env, "COMMUNICATION_CORE_FACADE_REGISTRY"),
    registry: process.env.COMMUNICATION_CORE_FACADE_REGISTRY ?? null,
  };
  return { structuredContent: snapshot, content: [{ type: "text", text: JSON.stringify(snapshot) }] };
});
const transport = new StdioServerTransport();
await server.connect(transport);
const handle = transport.onmessage;
transport.onmessage = (message, extra) => { record({ kind: "request", method: message.method }); handle(message, extra); };
process.stdin.once("end", async () => { await server.close(); record({ kind: "stopped", pid: process.pid }); process.exit(0); });
`, "utf8");
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const port = await reservePort();
  Object.assign(env, {
    CODEX_MCP_BROKER_HOST: "127.0.0.1", CODEX_MCP_BROKER_PORT: String(port),
    CODEX_MCP_BROKER_SDK_ROOT: sourceSdkRoot, CODEX_TOOLKIT_MCP_ROOT: toolkitRoot,
    CODEX_TOOLKIT_BROKER_ROOT: brokerRoot, CODEX_TOOLKIT_DATA_ROOT: path.join(root, "data"),
    CODEX_MCP_BROKER_STATE: stateFile, CODEX_MCP_BROKER_LOG: path.join(root, "broker.log"),
    CODEX_TOOLKIT_ENABLE_NAPCAT_MCP: "0", CODEX_TOOLKIT_ENABLE_WECHAT_DOCS_MCP: "0",
    CODEX_MCP_WRAPPER: "synthetic-parent-wrapper", CODEX_MCP_TOOL_NAME: "synthetic-parent-tool",
  });
  if (enabled !== undefined) env.CODEX_TOOLKIT_ENABLE_COMMUNICATION_CORE_MCP = enabled;
  if (customRoot) env.COMMUNICATION_CORE_MCP_ROOT = coreRoot;
  if (registry !== "unset") env.COMMUNICATION_CORE_FACADE_REGISTRY = registry === "nonempty" ? registryFile : "";
  child = spawn(process.execPath, [path.join(brokerRoot, "broker.mjs")], { cwd: brokerRoot, env, stdio: ["ignore", "ignore", "pipe"] });
  exited = new Promise(resolve => child.once("close", resolve));
  let stderr = "";
  let spawnError;
  child.once("error", error => { spawnError = error; });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString("utf8")).slice(-8000); });
  const deadline = Date.now() + 6000;
  let health;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`isolated broker exited: ${stderr}`);
    try { health = await requestJson(port, "/health", { timeoutMs: 300 }); } catch {}
    if (health?.body.ok === true) break;
    await delay(30);
  }
  assert.equal(health?.body.ok, true, `isolated broker not ready: ${stderr}`);
  assert.equal(health.body.pid, child.pid);
  return {
    root, coreRoot, coreScript, eventsFile, registryFile, port, health,
    state: () => JSON.parse(fs.readFileSync(stateFile, "utf8")),
    async client() {
      const client = new Client({ name: "isolated-communication-endpoint-test", version: "1" });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/communication-core/mcp`)), { timeout: 4000 });
      return client;
    },
  };
}

async function assertLegacyUnchanged(broker) {
  const health = await requestJson(broker.port, "/health");
  assert.deepEqual(health.body.endpoints.filter(name => name !== "communication-core").sort(), legacyEndpoints);
  for (const endpoint of legacyEndpoints) {
    assert.equal((await requestJson(broker.port, `/${endpoint}/mcp`, { method: "PUT" })).status, 405);
    const state = broker.state().endpoints[endpoint];
    assert.equal(state.path, `/${endpoint}/mcp`);
    assert.equal(state.sessions, 0);
    assert.equal(state.backend.connected, false);
    assert.equal(state.backend.lastPid, null);
  }
}

async function assertEnabled(broker, expectedRegistry) {
  assert.ok(broker.health.body.endpoints.includes("communication-core"));
  assert.equal(broker.state().endpoints["communication-core"].backend.connected, false);
  const client = await broker.client();
  assert.deepEqual((await client.listTools()).tools, [fixtureTool]);
  const response = await client.callTool({ name: fixtureTool.name, arguments: {} });
  assert.deepEqual(response.structuredContent, {
    cwd: broker.coreRoot, executable: process.execPath, argv: [broker.coreScript],
    wrapper: "1", toolName: "communication-core", registryPresent: true, registry: expectedRegistry,
  });
  assert.deepEqual(await client.listResources(), { resources: [] });
  assert.deepEqual(await client.listResourceTemplates(), { resourceTemplates: [] });
  const events = readEvents(broker.eventsFile);
  assert.equal(events.filter(event => event.kind === "started").length, 1);
  assert.equal(events.some(event => event.method?.startsWith("resources/")), false);
  const deep = await requestJson(broker.port, "/health?endpoint=communication-core&deep=1");
  assert.equal(deep.body.healthy, true);
  assert.equal(deep.body.toolCount, 1);
  await assertLegacyUnchanged(broker);
}

test("communication-core defaults disabled with 404 and unchanged legacy endpoints", { timeout: 12000 }, async context => {
  const broker = await isolatedBroker(context);
  assert.deepEqual(broker.health.body.endpoints.sort(), legacyEndpoints);
  assert.equal((await requestJson(broker.port, "/communication-core/mcp")).status, 404);
  await assertLegacyUnchanged(broker);
  assert.deepEqual(readEvents(broker.eventsFile), []);
});

test("communication-core requires the exact enable value 1", { timeout: 12000 }, async context => {
  const broker = await isolatedBroker(context, { enabled: "true" });
  assert.deepEqual(broker.health.body.endpoints.sort(), legacyEndpoints);
  assert.equal((await requestJson(broker.port, "/communication-core/mcp")).status, 404);
  assert.deepEqual(readEvents(broker.eventsFile), []);
});

test("enabled communication-core uses the default toolkit root, real stdio and exact registry path", { timeout: 15000 }, async context => {
  const broker = await isolatedBroker(context, { enabled: "1" });
  await assertEnabled(broker, broker.registryFile);
});

test("enabled communication-core honors a custom root and explicitly forwards an empty registry", { timeout: 15000 }, async context => {
  const broker = await isolatedBroker(context, { enabled: "1", customRoot: true, registry: "empty" });
  await assertEnabled(broker, "");
});

test("enabled communication-core supplies an empty registry when the parent variable is absent", { timeout: 15000 }, async context => {
  const broker = await isolatedBroker(context, { enabled: "1", customRoot: true, registry: "unset" });
  await assertEnabled(broker, "");
});
