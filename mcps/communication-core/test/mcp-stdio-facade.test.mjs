import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CommunicationCore } from "../src/core.mjs";
import { MessageStore } from "../src/store.mjs";
import { MockAdapter } from "../src/adapters/mock.mjs";
import { communicationTools, createMcpHttpServer, listCommunicationToolDefinitions } from "../src/mcp-server.mjs";
import { createMcpStdioFacade, FACADE_INSTRUCTIONS } from "../src/mcp-stdio-facade.mjs";

const moduleRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const caller = { machine_id: "facade-synthetic-machine", host: "codex", surface: "test", conversation_id: "facade-synthetic-source" };
const receiver = { ...caller, host: "antigravity", conversation_id: "facade-synthetic-receiver" };
const identities = [caller, receiver];
const sentinel = "SYNTHETIC_SECRET_MUST_NOT_ESCAPE";
const listTool = "communication_list_conversations";

function result(value) {
  return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorCode(response) {
  return response.structuredContent?.error?.code;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "communication-facade-隔离 test-"));
  const closers = [];
  context.after(async () => {
    for (const close of closers.reverse()) await close();
    await rm(root, { recursive: true, force: true });
  });
  const endpointFile = join(root, "active.endpoint.json");
  const endpoint = { version: 1, state: "listening", owner_id: "synthetic-owner-1", pid: process.pid, config_path: join(root, "synthetic.config.json"), state_dir: root, endpoint_file: endpointFile, started_at: "2026-11-16T01:00:00+08:00", url: "http://127.0.0.1:1/mcp" };
  const profiles = identities.map((identity, index) => ({ endpoint_file: endpointFile, identity: { ...identity }, token: `synthetic-facade-token-${index}` }));
  const profileFiles = profiles.map((profile, index) => join(root, `connection-${index}.json`));
  const registryFile = join(root, "registry.json");
  const registry = { version: 1, connections: profileFiles.map(connection_file => ({ connection_file })) };
  await writeJson(endpointFile, endpoint);
  for (const [index, profile] of profiles.entries()) await writeJson(profileFiles[index], profile);
  await writeJson(registryFile, registry);
  return {
    root, endpoint, endpointFile, profiles, profileFiles, registry, registryFile,
    own(close) { closers.push(close); },
    async facade(options = {}) {
      const facade = await createMcpStdioFacade({ registryFile, ...options });
      closers.push(() => facade.close());
      return facade;
    },
  };
}

function mockClients(handler = async (request, options, connection) => result({ caller: request.arguments.caller, connection: connection.identity.conversation_id })) {
  const created = [];
  return {
    created,
    async clientFactory(connection) {
      const state = { connection, calls: [], closed: 0 };
      created.push(state);
      return {
        async callTool(request, schema, options) {
          state.calls.push({ request, options });
          return handler(request, options, connection);
        },
        async close() { state.closed += 1; },
      };
    },
  };
}

async function attachClient(files, facade) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "synthetic-facade-memory", version: "1" });
  files.own(() => client.close());
  await facade.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function coreFixture(context) {
  const files = await fixture(context);
  const targets = identities.map((identity, index) => ({ ...identity, binding_id: `synthetic-binding-${index}`, binding_generation: 1, adapter_id: "mock", capabilities: { next_model_boundary: true, when_idle: true }, evidence: "simulated" }));
  const principals = files.profiles.map((profile, index) => ({ id: `synthetic-principal-${index}`, ...profile, allowed_targets: [`synthetic-binding-${1 - index}`], origin_kinds: ["agent_message"] }));
  const store = new MessageStore({ filePath: join(files.root, "synthetic.sqlite") });
  const core = new CommunicationCore({ store, targets, principals, adapters: { mock: new MockAdapter() } });
  files.own(async () => { await core.close(); store.close(); });
  await core.start();
  const http = await createMcpHttpServer({ core, principals });
  files.own(() => http.close());
  files.endpoint.url = http.url;
  await writeJson(files.endpointFile, files.endpoint);
  return { ...files, http, core, store, targets, principals };
}

function sendInput(target = { ...receiver, binding_id: "synthetic-binding-1", binding_generation: 1 }) {
  return { caller, origin: { kind: "agent_message", channel: "synthetic_test", source_ref: "synthetic-source-event" }, target, dedupe_key: "synthetic-facade-dedupe-1", text: "isolated synthetic test only", expires_at: new Date(Date.now() + 60000).toISOString() };
}

test("initialize instructions and schemas/annotations exactly reuse the current registration", async context => {
  const files = await fixture(context);
  const mocks = mockClients();
  const facade = await files.facade(mocks);
  const client = await attachClient(files, facade);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, communicationTools.length);
  assert.deepEqual(tools.tools, listCommunicationToolDefinitions());
  assert.equal(client.getInstructions(), FACADE_INSTRUCTIONS);
  for (const word of ["caller", "machine_id", "host", "surface", "conversation_id", "登记", "QQ", "等待", "确认", "未知", "dedupe_key", "可信宿主CID"]) assert.ok(FACADE_INSTRUCTIONS.slice(0, 512).includes(word));
  assert.equal(mocks.created.length, 0);
});

test("startup fails closed without a valid absolute registry; no fallback client is started", async context => {
  const files = await fixture(context);
  const mocks = mockClients();
  for (const registryFile of [null, "registry.json", join(files.root, "missing.json")]) {
    await assert.rejects(createMcpStdioFacade({ registryFile, ...mocks }), { message: "facade_config_invalid" });
  }
  for (const registry of [{ version: 1, connections: [] }, { version: 1, connections: Array(129).fill(files.registry.connections[0]) }, { ...files.registry, unexpected: sentinel }, { version: 2, connections: files.registry.connections }]) {
    await writeJson(files.registryFile, registry);
    await assert.rejects(files.facade(mocks), { message: "facade_config_invalid" });
  }
  assert.equal(mocks.created.length, 0);
});

test("duplicate files, identities and tokens are rejected rather than selecting the first profile", async context => {
  const files = await fixture(context);
  await writeJson(files.registryFile, { version: 1, connections: [files.registry.connections[0], files.registry.connections[0]] });
  await assert.rejects(files.facade(), { message: "facade_config_invalid" });
  await writeJson(files.registryFile, files.registry);
  await writeJson(files.profileFiles[1], { ...files.profiles[1], identity: caller });
  await assert.rejects(files.facade(), { message: "facade_config_invalid" });
  await writeJson(files.profileFiles[1], { ...files.profiles[1], token: files.profiles[0].token });
  await assert.rejects(files.facade(), { message: "facade_config_invalid" });
});

test("endpoint/profile structure is checked locally before connecting", async context => {
  const files = await fixture(context);
  const mocks = mockClients();
  const urls = ["https://127.0.0.1/mcp", "http://example.com/mcp", "http://127.0.0.1/mcp?", "http://127.0.0.1/mcp#", "http://user:password@127.0.0.1/mcp", "http://127.0.0.1/other", "http://127.0.0.1:0/mcp", "http://127.0.0.1:65536/mcp", "http://127.0.0.1/a/../mcp"];
  for (const url of urls) {
    await writeJson(files.endpointFile, { ...files.endpoint, url });
    await assert.rejects(files.facade(mocks), { message: "facade_config_invalid" });
  }
  for (const patch of [{ state: "closed" }, { owner_id: "" }, { endpoint_file: join(files.root, "other.json") }, { config_path: "relative.json" }, { pid: 0 }]) {
    await writeJson(files.endpointFile, { ...files.endpoint, ...patch });
    await assert.rejects(files.facade(mocks), { message: "facade_config_invalid" });
  }
  await writeJson(files.endpointFile, files.endpoint);
  await writeJson(files.profileFiles[0], { ...files.profiles[0], token: undefined });
  await assert.rejects(files.facade(mocks), { message: "facade_config_invalid" });
  assert.equal(mocks.created.length, 0);
});

test("caller must have all four exact fields; extra paths and business fields cannot change the connection", async context => {
  const files = await fixture(context);
  const mocks = mockClients();
  const facade = await files.facade(mocks);
  for (const field of Object.keys(caller)) {
    const incomplete = { ...caller };
    delete incomplete[field];
    assert.equal(errorCode(await facade.callTool(listTool, { caller: incomplete })), "invalid_input");
  }
  for (const patch of [{ host: "wrong" }, { surface: "wrong" }, { conversation_id: "unregistered" }, { machine_id: "wrong" }]) assert.equal(errorCode(await facade.callTool(listTool, { caller: { ...caller, ...patch } })), "caller_unregistered");
  for (const input of [{}, { caller, connection_file: files.profileFiles[1] }, { caller: { ...caller, token: sentinel } }, { caller, principal_id: "synthetic-principal-1" }]) assert.equal(errorCode(await facade.callTool(listTool, input)), "invalid_input");
  assert.equal(errorCode(await facade.callTool("unknown", { caller })), "invalid_input");
  assert.equal(errorCode(await facade.callTool("communication_wait", { caller, message_id: "synthetic", wait_ms: 45001 })), "invalid_input");
  assert.equal(mocks.created.length, 0);
});

test("an unsupported model field never reaches a backend, even for an exact profile", async context => {
  const files = await fixture(context);
  const mocks = mockClients();
  const facade = await files.facade(mocks);
  const client = await attachClient(files, facade);
  const send = (await client.listTools()).tools.find(tool => tool.name === "communication_send_message");
  assert.equal(Object.hasOwn(send.inputSchema.properties, "model_override"), false);
  const args = {
    caller,
    target: { host: receiver.host, conversation_id: receiver.conversation_id },
    origin: { kind: "agent_message", channel: "codex", source_ref: caller.conversation_id },
    dedupe_key: "facade-model-override",
    expires_at: "2026-11-18T07:00:00Z",
    text: "synthetic test",
  };
  const guarded = await facade.callTool("communication_send_message", { ...args, model_override: { model_id: "approved-model", expected_selection_revision: "1".repeat(64) } });
  assert.equal(errorCode(guarded), "invalid_input");
  assert.equal(mocks.created.length, 0);
  assert.equal(errorCode(await facade.callTool("communication_send_message", args)), undefined);
  assert.equal(mocks.created.length, 1);
});

test("interleaved origins have distinct credential/client caches and preserve structured results", async context => {
  const files = await fixture(context);
  const mocks = mockClients();
  const facade = await files.facade(mocks);
  const outputs = await Promise.all([caller, receiver, caller, receiver].map(identity => facade.callTool(listTool, { caller: identity })));
  assert.deepEqual(outputs.map(output => output.structuredContent.connection), [caller.conversation_id, receiver.conversation_id, caller.conversation_id, receiver.conversation_id]);
  assert.equal(mocks.created.length, 2);
  for (const state of mocks.created) {
    const index = identities.findIndex(identity => identity.conversation_id === state.connection.identity.conversation_id);
    assert.equal(state.connection.token, files.profiles[index].token);
    assert.equal(state.calls.length, 2);
    for (const { request, options } of state.calls) {
      assert.deepEqual(request.arguments.caller, identities[index]);
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.timeout, 49000);
    }
  }
});

test("registry revocation and profile rotation take effect on the next call", async context => {
  const files = await fixture(context);
  const mocks = mockClients();
  const facade = await files.facade(mocks);
  await facade.callTool(listTool, { caller });
  await writeJson(files.registryFile, { version: 1, connections: [files.registry.connections[1]] });
  assert.equal(errorCode(await facade.callTool(listTool, { caller })), "caller_unregistered");
  assert.equal(mocks.created[0].closed, 1);
  await writeJson(files.registryFile, files.registry);
  await writeJson(files.profileFiles[0], { ...files.profiles[0], token: "synthetic-rotated-facade-token" });
  assert.notEqual((await facade.callTool(listTool, { caller })).isError, true);
  assert.equal(mocks.created[1].connection.token, "synthetic-rotated-facade-token");
  await rm(files.profileFiles[0]);
  assert.equal(errorCode(await facade.callTool(listTool, { caller })), "facade_config_invalid");
});

test("endpoint owner/URL changes replace the HTTP client; invalid endpoints recover through a later read-only call", async context => {
  const files = await fixture(context);
  const mocks = mockClients();
  const facade = await files.facade(mocks);
  await facade.callTool(listTool, { caller });
  await writeJson(files.endpointFile, { ...files.endpoint, state: "closed" });
  assert.equal(errorCode(await facade.callTool(listTool, { caller })), "facade_config_invalid");
  await writeJson(files.endpointFile, { ...files.endpoint, owner_id: "synthetic-owner-2", url: "http://localhost:2/mcp" });
  assert.notEqual((await facade.callTool(listTool, { caller })).isError, true);
  assert.equal(mocks.created.length, 2);
  assert.equal(mocks.created[0].closed, 1);
  assert.equal(mocks.created[1].connection.url, "http://localhost:2/mcp");
});

test("cancellation reaches only the selected request, including concurrent calls on the same principal", async context => {
  const files = await fixture(context);
  const pending = [];
  const mocks = mockClients(async (request, options) => {
    if (request.name !== "communication_wait") return result({ caller: request.arguments.caller });
    return new Promise((resolve, reject) => {
      pending.push({ caller: request.arguments.caller, signal: options.signal, resolve });
      options.signal.addEventListener("abort", () => reject(new Error(sentinel)), { once: true });
    });
  });
  const facade = await files.facade(mocks);
  const abort = new AbortController();
  const first = facade.callTool("communication_wait", { caller, message_id: "synthetic-1", wait_ms: 45000 }, { signal: abort.signal });
  const same = facade.callTool("communication_wait", { caller, message_id: "synthetic-2", wait_ms: 45000 });
  const other = facade.callTool("communication_wait", { caller: receiver, message_id: "synthetic-3", wait_ms: 45000 });
  while (pending.length < 3) await delay(5);
  abort.abort();
  const cancelled = await first;
  assert.equal(errorCode(cancelled), "request_cancelled");
  assert.ok(!JSON.stringify(cancelled).includes(sentinel));
  assert.equal(pending.filter(entry => entry.signal.aborted).length, 1);
  for (const entry of pending.filter(entry => !entry.signal.aborted)) entry.resolve(result({ caller: entry.caller }));
  assert.notEqual((await same).isError, true);
  assert.notEqual((await other).isError, true);
});

test("restricting the legacy registry rejects new reads while an already forwarded read must drain", { timeout: 5000 }, async context => {
  const files = await fixture(context);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let settled = false;
  const mocks = mockClients(async () => {
    started.resolve();
    await release.promise;
    return result({ epoch: "legacy" });
  });
  const facade = await files.facade(mocks);
  const input = { caller, host: "codex", scope: "host" };
  const oldRead = facade.callTool(listTool, input).finally(() => { settled = true; });
  try {
    await started.promise;
    await writeJson(files.registryFile, { version: 1, connections: [files.registry.connections[1]] });
    assert.equal(errorCode(await facade.callTool(listTool, input)), "caller_unregistered");
    assert.equal(settled, false);
    assert.equal(mocks.created[0].closed, 0);
    assert.equal(mocks.created[0].calls.length, 1);
  } finally {
    release.resolve();
    const original = await oldRead;
    assert.equal(original.structuredContent.epoch, "legacy");
  }
  assert.equal(settled, true);
  assert.equal(mocks.created[0].closed, 1);
  assert.equal(errorCode(await facade.callTool(listTool, input)), "caller_unregistered");
});

test("cancelled connection waiters do not cancel another caller's shared initialize", async context => {
  const files = await fixture(context);
  let release;
  let factorySignal;
  const facade = await files.facade({ clientFactory: async options => {
    factorySignal = options.signal;
    await new Promise(resolve => { release = resolve; });
    return { callTool: async () => result({ ok: true }), close: async () => {} };
  } });
  const abort = new AbortController();
  const first = facade.callTool(listTool, { caller }, { signal: abort.signal });
  const second = facade.callTool(listTool, { caller });
  while (!release) await delay(5);
  await delay(20);
  abort.abort();
  assert.equal(errorCode(await first), "request_cancelled");
  assert.equal(factorySignal.aborted, false);
  release();
  assert.deepEqual((await second).structuredContent, { ok: true });
});

for (const change of ["revoke", "rotate", "endpoint"]) {
  test(`unforwarded initialize waiters reject ${change} before the first tool call`, async context => {
    const files = await fixture(context);
    let release;
    let sends = 0;
    let closes = 0;
    const facade = await files.facade({ clientFactory: async () => {
      await new Promise(resolve => { release = resolve; });
      return { callTool: async () => { sends += 1; return result({ ok: true }); }, close: async () => { closes += 1; } };
    } });
    const pending = facade.callTool("communication_send_message", sendInput());
    while (!release) await delay(5);
    if (change === "revoke") await writeJson(files.registryFile, { version: 1, connections: [files.registry.connections[1]] });
    if (change === "rotate") await writeJson(files.profileFiles[0], { ...files.profiles[0], token: "synthetic-rotated-facade-token" });
    if (change === "endpoint") await writeJson(files.endpointFile, { ...files.endpoint, owner_id: "synthetic-replaced-owner" });
    release();
    assert.equal(errorCode(await pending), "caller_unregistered");
    assert.equal(sends, 0);
    assert.equal(closes, 1);
  });
}

test("connect failure and started-call failure are static, secret-free and never replay a send", async context => {
  const files = await fixture(context);
  let attempts = 0;
  const disconnected = await files.facade({ clientFactory: async () => { attempts += 1; throw new Error(`headers body token stack ${sentinel}`); } });
  const before = await disconnected.callTool("communication_send_message", sendInput());
  assert.equal(errorCode(before), "core_connect_failed");
  assert.equal(attempts, 1);
  const mocks = mockClients(async () => { throw new Error(`headers body token stack ${sentinel}`); });
  const facade = await files.facade(mocks);
  const after = await facade.callTool("communication_send_message", sendInput());
  assert.equal(errorCode(after), "core_call_failed");
  assert.equal(mocks.created.length, 1);
  assert.equal(mocks.created[0].calls.length, 1);
  assert.ok(!JSON.stringify([before, after]).includes(sentinel));
  assert.notEqual(errorCode(before), errorCode(after));
});

test("real SDK HTTP proxy keeps original core target authorization and message dedupe", { timeout: 15000 }, async context => {
  const files = await coreFixture(context);
  const facade = await files.facade();
  const client = await attachClient(files, facade);
  const listed = await client.callTool({ name: listTool, arguments: { caller } });
  assert.equal(listed.structuredContent.targets.length, 1);
  const refused = await client.callTool({ name: "communication_send_message", arguments: sendInput({ ...caller, binding_id: "synthetic-binding-0", binding_generation: 1 }) });
  assert.equal(errorCode(refused), "forbidden");
  const input = sendInput();
  const sent = await client.callTool({ name: "communication_send_message", arguments: input });
  assert.notEqual(sent.isError, true);
  const duplicate = await client.callTool({ name: "communication_send_message", arguments: input });
  assert.notEqual(duplicate.isError, true);
  assert.equal(duplicate.structuredContent.message.message_id, sent.structuredContent.message.message_id);
  assert.equal(duplicate.structuredContent.duplicate, true);
  const read = await client.callTool({ name: "communication_get_message", arguments: { caller: receiver, message_id: sent.structuredContent.message.message_id } });
  assert.equal(read.structuredContent.message.message_id, sent.structuredContent.message.message_id);
  await facade.close();
  assert.equal((await fetch(files.http.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
  assert.equal(files.store.getMessage(sent.structuredContent.message.message_id).envelope.text, "isolated synthetic test only");
});

test("real stdio entry handshakes, lists current tools and proxies an isolated HTTP read with protocol-only stdout", { timeout: 15000 }, async context => {
  const files = await coreFixture(context);
  let stderr = "";
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(moduleRoot, "scripts", "broker-stdio.mjs")], cwd: moduleRoot, env: { ...process.env, COMMUNICATION_CORE_FACADE_REGISTRY: files.registryFile }, stderr: "pipe" });
  transport.stderr.on("data", chunk => { stderr += chunk; });
  const client = new Client({ name: "synthetic-broker-stdio-test", version: "1" });
  files.own(() => client.close());
  const protocolErrors = [];
  client.onerror = error => protocolErrors.push(error);
  await client.connect(transport, { timeout: 5000 });
  assert.equal((await client.listTools()).tools.length, communicationTools.length);
  const response = await client.callTool({ name: listTool, arguments: { caller } });
  assert.equal(response.structuredContent.targets[0].conversation_id, receiver.conversation_id);
  assert.deepEqual(protocolErrors, []);
  assert.equal(stderr, "");
  await client.close();
  assert.equal((await fetch(files.http.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
});

test("invalid stdio startup exits nonzero with static stderr and empty stdout", { timeout: 10000 }, async context => {
  const files = await fixture(context);
  const child = spawn(process.execPath, [join(moduleRoot, "scripts", "broker-stdio.mjs")], { cwd: moduleRoot, env: { ...process.env, COMMUNICATION_CORE_FACADE_REGISTRY: join(files.root, sentinel) }, stdio: ["pipe", "pipe", "pipe"] });
  files.own(async () => { if (child.exitCode === null) { child.kill(); await once(child, "close"); } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "close");
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.equal(stderr, "communication-core facade startup failed\n");
  assert.ok(!stderr.includes(sentinel));
});

test("default SDK refuses redirects without forwarding credentials or replaying a failed tool call", { timeout: 10000 }, async context => {
  const files = await fixture(context);
  const requests = [];
  let redirectHits = 0;
  const destination = createServer((request, response) => { redirectHits += 1; response.end(sentinel); });
  await new Promise(resolve => destination.listen(0, "127.0.0.1", resolve));
  const redirect = createServer((request, response) => {
    requests.push(request.method);
    response.writeHead(307, { Location: `http://127.0.0.1:${destination.address().port}/mcp`, "Content-Type": "text/plain" });
    response.end(sentinel);
  });
  await new Promise(resolve => redirect.listen(0, "127.0.0.1", resolve));
  files.own(async () => { redirect.closeAllConnections(); destination.closeAllConnections(); await Promise.all([new Promise(resolve => redirect.close(resolve)), new Promise(resolve => destination.close(resolve))]); });
  await writeJson(files.endpointFile, { ...files.endpoint, url: `http://127.0.0.1:${redirect.address().port}/mcp` });
  const facade = await files.facade();
  const response = await facade.callTool("communication_send_message", sendInput());
  assert.equal(errorCode(response), "core_connect_failed");
  await delay(100);
  assert.deepEqual(requests, ["POST"]);
  assert.equal(redirectHits, 0);
  assert.ok(!JSON.stringify(response).includes(sentinel));
});

test("facade close is idempotent, aborts its own pending waits and closes only its owned clients", async context => {
  const files = await fixture(context);
  let started = false;
  const mocks = mockClients(async (request, options) => {
    started = true;
    return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error(sentinel)), { once: true }));
  });
  const facade = await files.facade(mocks);
  const pending = facade.callTool("communication_wait", { caller, message_id: "synthetic", wait_ms: 45000 });
  while (!started) await delay(5);
  await Promise.all([facade.close(), facade.close()]);
  assert.equal(errorCode(await pending), "request_cancelled");
  assert.equal(mocks.created[0].closed, 1);
  assert.equal(errorCode(await facade.callTool(listTool, { caller })), "facade_closed");
  assert.equal(JSON.parse(await readFile(files.endpointFile, "utf8")).state, "listening");
});

test("real HTTP request cancellation is isolated across principals and concurrent requests", { timeout: 10000 }, async context => {
  const files = await fixture(context);
  const pending = [];
  const core = Object.fromEntries(communicationTools.map(entry => [entry.method, async () => ({ ok: true })]));
  core.wait = (requestContext, input) => new Promise((resolve, reject) => {
    pending.push({ signal: requestContext.signal, resolve, caller: input.caller });
    requestContext.signal.addEventListener("abort", () => reject(new Error(sentinel)), { once: true });
  });
  const http = await createMcpHttpServer({ core, principals: files.profiles.map((profile, index) => ({ ...profile, id: `synthetic-http-${index}` })) });
  files.own(() => http.close());
  await writeJson(files.endpointFile, { ...files.endpoint, url: http.url });
  const facade = await files.facade();
  const abort = new AbortController();
  const cancelled = facade.callTool("communication_wait", { caller, message_id: "synthetic-http-1", wait_ms: 45000 }, { signal: abort.signal });
  const same = facade.callTool("communication_wait", { caller, message_id: "synthetic-http-2", wait_ms: 45000 });
  const other = facade.callTool("communication_wait", { caller: receiver, message_id: "synthetic-http-3", wait_ms: 45000 });
  while (pending.length < 3) await delay(5);
  abort.abort();
  assert.equal(errorCode(await cancelled), "request_cancelled");
  const deadline = Date.now() + 1000;
  while (!pending.some(entry => entry.signal.aborted) && Date.now() < deadline) await delay(5);
  assert.equal(pending.filter(entry => entry.signal.aborted).length, 1);
  for (const entry of pending.filter(entry => !entry.signal.aborted)) entry.resolve({ caller: entry.caller, ok: true });
  assert.notEqual((await same).isError, true);
  assert.notEqual((await other).isError, true);
});

test("real HTTP caller/principal mismatch is still rejected by the original core", { timeout: 10000 }, async context => {
  const files = await coreFixture(context);
  await writeJson(files.profileFiles[0], { ...files.profiles[0], token: "synthetic-wrong-principal-token" });
  await writeJson(files.profileFiles[1], { ...files.profiles[1], token: files.profiles[0].token });
  const facade = await files.facade();
  const response = await facade.callTool(listTool, { caller: receiver });
  assert.equal(errorCode(response), "caller_mismatch");
});

test("real HTTP endpoint replacement reuses the same isolated core/store through a new client", { timeout: 10000 }, async context => {
  const files = await coreFixture(context);
  const facade = await files.facade();
  const first = await facade.callTool(listTool, { caller });
  await files.http.close();
  await writeJson(files.endpointFile, { ...files.endpoint, state: "closed" });
  assert.equal(errorCode(await facade.callTool(listTool, { caller })), "facade_config_invalid");
  const replacement = await createMcpHttpServer({ core: files.core, principals: files.principals });
  files.own(() => replacement.close());
  await writeJson(files.endpointFile, { ...files.endpoint, owner_id: "synthetic-reopened-owner", url: replacement.url });
  const recovered = await facade.callTool(listTool, { caller });
  assert.deepEqual(recovered.structuredContent, first.structuredContent);
});

test("real SDK HTTP started-call failure never retries and cannot expose raw response secrets", { timeout: 10000 }, async context => {
  const files = await fixture(context);
  let calls = 0;
  const http = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.method === "initialize") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "synthetic-failure-server", version: "1" } } }));
    } else if (body.method === "notifications/initialized") {
      response.writeHead(202).end();
    } else if (body.method === "tools/call") {
      calls += 1;
      response.writeHead(500, { "Content-Type": "text/plain", "X-Synthetic-Secret": sentinel });
      response.end(`body token stack ${sentinel}`);
    } else response.writeHead(202).end();
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  files.own(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  await writeJson(files.endpointFile, { ...files.endpoint, url: `http://127.0.0.1:${http.address().port}/mcp` });
  const facade = await files.facade();
  const response = await facade.callTool("communication_send_message", sendInput());
  assert.equal(errorCode(response), "core_call_failed");
  await delay(100);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(response).includes(sentinel));
});
