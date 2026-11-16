import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { communicationTools } from "../src/mcp-server.mjs";
import { createMcpStdioFacade, FACADE_INSTRUCTIONS } from "../src/mcp-stdio-facade.mjs";

const caller = { machine_id: "synthetic-host-scope-machine", host: "codex", surface: "synthetic-test", conversation_id: "synthetic-legacy-cid" };
const listTool = "communication_list_conversations";
const scopeFields = { machine_id: 128, host: 64, surface: 64 };

function result(value) {
  return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorCode(response) {
  return response.structuredContent?.error?.code;
}

function legacyProfile(identity = caller, token = "synthetic-legacy-token") {
  return { identity: { ...identity }, token };
}

function scopeProfile(identity = caller, token = "synthetic-host-token") {
  return { identity: { ...identity, conversation_id: "*" }, token, caller_scope: Object.fromEntries(Object.keys(scopeFields).map(field => [field, identity[field]])) };
}

function deferred() {
  let resolve;
  const promise = new Promise(release => { resolve = release; });
  return { promise, resolve };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
}

async function fixture(context, suppliedProfiles = [scopeProfile()]) {
  const root = await mkdtemp(join(tmpdir(), "communication-facade-host-scope-隔离 test-"));
  const closers = [];
  context.after(async () => {
    try {
      for (const close of closers.reverse()) await close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  const endpointFile = join(root, "synthetic.endpoint.json");
  const endpoint = { version: 1, state: "listening", owner_id: "synthetic-host-scope-owner", pid: process.pid, config_path: join(root, "synthetic.config.json"), state_dir: root, endpoint_file: endpointFile, started_at: "2026-11-16T06:00:00+08:00", url: "http://127.0.0.1:1/mcp" };
  const profiles = suppliedProfiles.map(profile => ({ endpoint_file: endpointFile, ...profile }));
  const profileFiles = profiles.map((profile, index) => join(root, `synthetic-connection-${index}.json`));
  const registryFile = join(root, "synthetic.registry.json");
  const registry = { version: 1, connections: profileFiles.map(connection_file => ({ connection_file })) };
  await writeJson(endpointFile, endpoint);
  for (const [index, profile] of profiles.entries()) await writeJson(profileFiles[index], profile);
  await writeJson(registryFile, registry);
  return {
    root, endpoint, endpointFile, profiles, profileFiles, registry, registryFile,
    own(close) { closers.push(close); },
    async facade(options) {
      const facade = await createMcpStdioFacade({ registryFile, ...options });
      closers.push(() => facade.close());
      return facade;
    },
  };
}

function mockClients(handler = async (request, options, connection) => result({ caller: request.arguments.caller, token: connection.token })) {
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

test("initialize and listTools reuse current communicationTools definitions without a fixed tool count", async context => {
  const files = await fixture(context);
  const mocks = mockClients();
  const facade = await files.facade(mocks);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "synthetic-host-scope-client", version: "1" });
  files.own(() => client.close());
  await facade.connect(serverTransport);
  await client.connect(clientTransport);
  assert.deepEqual((await client.listTools()).tools, communicationTools.map(entry => entry.definition));
  assert.equal(client.getInstructions(), FACADE_INSTRUCTIONS);
  assert.equal(mocks.created.length, 0);
});

test("a host profile accepts fresh concrete CIDs and shares one client without replacing the real caller", async context => {
  const files = await fixture(context);
  const mocks = mockClients();
  const facade = await files.facade(mocks);
  const callers = ["synthetic-brand-new-1", "synthetic-brand-new-2", "*literal-suffix"].map(conversation_id => ({ ...caller, conversation_id }));
  const responses = await Promise.all(callers.map(identity => facade.callTool(listTool, { caller: identity })));
  assert.deepEqual(responses.map(response => response.structuredContent), callers.map(identity => ({ caller: identity, token: files.profiles[0].token })));
  assert.equal(mocks.created.length, 1);
  assert.deepEqual(mocks.created[0].connection.identity, { ...caller, conversation_id: "*" });
  assert.equal(mocks.created[0].connection.timeoutMs, 4000);
  assert.equal(mocks.created[0].calls.length, callers.length);
  for (const { options } of mocks.created[0].calls) {
    assert.equal(options.timeout, 49000);
    assert.equal(options.maxTotalTimeout, 49000);
    assert.equal(options.resetTimeoutOnProgress, false);
  }
});

test("legacy three-field profiles remain exact; adding a host scope overrides them in either registry order", async context => {
  const files = await fixture(context, [legacyProfile(), scopeProfile()]);
  const legacyBytes = await readFile(files.profileFiles[0]);
  const legacyOnly = { version: 1, connections: [files.registry.connections[0]] };
  await writeJson(files.registryFile, legacyOnly);
  const mocks = mockClients();
  const facade = await files.facade(mocks);
  assert.equal((await facade.callTool(listTool, { caller })).structuredContent.token, files.profiles[0].token);
  const freshCaller = { ...caller, conversation_id: "synthetic-new-after-migration" };
  assert.equal(errorCode(await facade.callTool(listTool, { caller: freshCaller })), "caller_unregistered");
  for (const connections of [files.registry.connections, [...files.registry.connections].reverse()]) {
    await writeJson(files.registryFile, { version: 1, connections });
    for (const identity of [caller, freshCaller]) assert.equal((await facade.callTool(listTool, { caller: identity })).structuredContent.token, files.profiles[1].token);
  }
  assert.equal(mocks.created.length, 2);
  assert.deepEqual(await readFile(files.profileFiles[0]), legacyBytes);
  await writeJson(files.registryFile, legacyOnly);
  assert.equal((await facade.callTool(listTool, { caller })).structuredContent.token, files.profiles[0].token);
  assert.equal(errorCode(await facade.callTool(listTool, { caller: freshCaller })), "caller_unregistered");
  assert.equal(mocks.created[1].closed, 1);
});

test("scope matching is exact for machine, host and surface and never borrows another endpoint credential", async context => {
  const files = await fixture(context);
  const mocks = mockClients();
  const facade = await files.facade(mocks);
  for (const field of Object.keys(scopeFields)) {
    for (const value of [`other-${caller[field]}`, caller[field].toUpperCase(), `${caller[field]} `]) {
      assert.equal(errorCode(await facade.callTool(listTool, { caller: { ...caller, [field]: value } })), "caller_unregistered");
    }
  }
  assert.equal(mocks.created.length, 0);
});

test("different host, machine and surface profiles use only their own token", async context => {
  const identities = [caller, { ...caller, host: "antigravity" }, { ...caller, machine_id: "synthetic-other-machine" }, { ...caller, surface: "synthetic-other-surface" }];
  const files = await fixture(context, identities.map((identity, index) => scopeProfile(identity, `synthetic-host-token-${index}`)));
  const mocks = mockClients();
  const facade = await files.facade(mocks);
  for (const [index, identity] of identities.entries()) {
    const actual = { ...identity, conversation_id: `synthetic-fresh-${index}` };
    assert.deepEqual((await facade.callTool(listTool, { caller: actual })).structuredContent, { caller: actual, token: files.profiles[index].token });
  }
  assert.equal(mocks.created.length, identities.length);
});

test("a real caller cannot use the profile wildcard, omit identity fields or add caller_scope", async context => {
  const files = await fixture(context);
  const mocks = mockClients();
  const facade = await files.facade(mocks);
  const withoutSurface = { ...caller };
  delete withoutSurface.surface;
  for (const identity of [{ ...caller, conversation_id: "*" }, { ...caller, conversation_id: " " }, withoutSurface, { ...caller, caller_scope: files.profiles[0].caller_scope }]) {
    assert.equal(errorCode(await facade.callTool(listTool, { caller: identity })), "invalid_input");
  }
  assert.equal(mocks.created.length, 0);
});

test("scoped and legacy identities enforce the wildcard contract and exact matching fields", async context => {
  const files = await fixture(context);
  const mocks = mockClients();
  const profile = files.profiles[0];
  const invalidProfiles = [
    { ...profile, identity: { ...profile.identity, conversation_id: caller.conversation_id } },
    { ...profile, identity: { ...profile.identity, conversation_id: " * " } },
    { endpoint_file: files.endpointFile, ...legacyProfile({ ...caller, conversation_id: "*" }) },
    ...Object.keys(scopeFields).map(field => ({ ...profile, identity: { ...profile.identity, [field]: `other-${profile.identity[field]}` } })),
    { ...profile, identity: { ...profile.identity, unknown: "pollution" } },
  ];
  for (const invalid of invalidProfiles) {
    await writeJson(files.profileFiles[0], invalid);
    await assert.rejects(files.facade(mocks), { message: "facade_config_invalid" });
  }
  assert.equal(mocks.created.length, 0);
});

test("caller_scope accepts exactly three bounded nonempty text fields and rejects pollution", async context => {
  const files = await fixture(context);
  const mocks = mockClients();
  const profile = files.profiles[0];
  const scopes = [null, [], "scope", {}, { ...profile.caller_scope, conversation_id: "*" }, { ...profile.caller_scope, token: "synthetic-pollution" }, JSON.parse('{"machine_id":"synthetic","host":"codex","surface":"test","__proto__":{"polluted":true}}')];
  for (const [field, maximum] of Object.entries(scopeFields)) {
    const incomplete = { ...profile.caller_scope };
    delete incomplete[field];
    scopes.push(incomplete);
    for (const value of [undefined, null, 1, {}, [], "", " \t", "a".repeat(maximum + 1), "机".repeat(Math.ceil((maximum + 1) / 3))]) scopes.push({ ...profile.caller_scope, [field]: value });
  }
  for (const caller_scope of scopes) {
    await writeJson(files.profileFiles[0], { ...profile, caller_scope });
    await assert.rejects(files.facade(mocks), { message: "facade_config_invalid" });
  }
  await writeJson(files.profileFiles[0], { ...profile, unexpected: "synthetic-pollution" });
  await assert.rejects(files.facade(mocks), { message: "facade_config_invalid" });
  assert.equal(mocks.created.length, 0);
  assert.equal(Object.prototype.polluted, undefined);
});

test("scope field byte limits accept ASCII and multibyte boundary values without trimming", async context => {
  for (const multibyte of [false, true]) {
    const identity = { ...caller, ...Object.fromEntries(Object.entries(scopeFields).map(([field, maximum]) => [field, multibyte ? "机".repeat(Math.floor(maximum / 3)) + "a".repeat(maximum % 3) : "a".repeat(maximum)])) };
    const files = await fixture(context, [scopeProfile(identity)]);
    const mocks = mockClients();
    const facade = await files.facade(mocks);
    assert.deepEqual((await facade.callTool(listTool, { caller: identity })).structuredContent.caller, identity);
  }
});

test("all registry entries are validated, including duplicate scopes, tokens, profiles and polluted entries", async context => {
  const cases = [
    [scopeProfile(), scopeProfile(caller, "synthetic-other-scope-token")],
    [legacyProfile(), scopeProfile(caller, "synthetic-legacy-token")],
    [scopeProfile(), scopeProfile({ ...caller, host: "antigravity" }, "synthetic-host-token")],
    [legacyProfile(), legacyProfile(caller, "synthetic-other-exact-token")],
  ];
  for (const profiles of cases) {
    const files = await fixture(context, profiles);
    const mocks = mockClients();
    await assert.rejects(files.facade(mocks), { message: "facade_config_invalid" });
    assert.equal(mocks.created.length, 0);
  }
  const files = await fixture(context);
  const mocks = mockClients();
  const connection = files.registry.connections[0];
  for (const connections of [[connection, connection], [{ ...connection, connection_file: join(files.root, "subdir", "..", "synthetic-connection-0.json") }, connection], [{ ...connection, caller_scope: files.profiles[0].caller_scope }], [{ ...connection, identity: caller }]]) {
    await writeJson(files.registryFile, { version: 1, connections });
    await assert.rejects(files.facade(mocks), { message: "facade_config_invalid" });
  }
  await writeJson(files.registryFile, { ...files.registry, caller_scope: files.profiles[0].caller_scope });
  await assert.rejects(files.facade(mocks), { message: "facade_config_invalid" });
  assert.equal(mocks.created.length, 0);
});

test("a malformed unrelated scope fails the whole hot registry and valid profiles recover on the next call", async context => {
  const files = await fixture(context, [scopeProfile(), scopeProfile({ ...caller, host: "antigravity" }, "synthetic-other-host-token")]);
  const mocks = mockClients();
  const facade = await files.facade(mocks);
  await facade.callTool(listTool, { caller });
  await writeJson(files.profileFiles[1], { ...files.profiles[1], caller_scope: { ...files.profiles[1].caller_scope, unknown: true } });
  assert.equal(errorCode(await facade.callTool(listTool, { caller })), "facade_config_invalid");
  assert.equal(mocks.created[0].calls.length, 1);
  assert.equal(mocks.created[0].closed, 1);
  await writeJson(files.profileFiles[1], files.profiles[1]);
  assert.equal((await facade.callTool(listTool, { caller })).structuredContent.token, files.profiles[0].token);
  assert.equal(mocks.created.length, 2);
});

for (const change of ["scope-added", "scope-removed", "token-rotated", "endpoint-replaced"]) {
  test(`the pre-call fingerprint recheck rejects ${change} without forwarding or replay`, { timeout: 5000 }, async context => {
    const files = await fixture(context, [legacyProfile(), scopeProfile()]);
    const legacyOnly = { version: 1, connections: [files.registry.connections[0]] };
    if (change === "scope-added") await writeJson(files.registryFile, legacyOnly);
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    const mocks = mockClients(async () => { calls += 1; return result({ ok: true }); });
    const facade = await files.facade({ clientFactory: async connection => {
      const client = await mocks.clientFactory(connection);
      if (mocks.created.length === 1) { entered.resolve(); await release.promise; }
      return client;
    } });
    files.own(() => release.resolve());
    const pending = facade.callTool(listTool, { caller });
    await entered.promise;
    if (change === "scope-added") await writeJson(files.registryFile, files.registry);
    if (change === "scope-removed") await writeJson(files.registryFile, legacyOnly);
    if (change === "token-rotated") await writeJson(files.profileFiles[1], { ...files.profiles[1], token: "synthetic-rotated-host-token" });
    if (change === "endpoint-replaced") await writeJson(files.endpointFile, { ...files.endpoint, owner_id: "synthetic-replaced-owner" });
    release.resolve();
    assert.equal(errorCode(await pending), "caller_unregistered");
    assert.equal(calls, 0);
    assert.equal(mocks.created.length, 1);
    assert.equal(mocks.created[0].closed, 1);
    assert.equal((await facade.callTool(listTool, { caller })).structuredContent.ok, true);
    const expectedToken = change === "scope-removed" ? files.profiles[0].token : change === "token-rotated" ? "synthetic-rotated-host-token" : files.profiles[1].token;
    assert.equal(mocks.created[1].connection.token, expectedToken);
    assert.equal(calls, 1);
  });
}

test("host token rotation retires an active shared client after its original call and preserves old concrete callers", { timeout: 5000 }, async context => {
  const files = await fixture(context);
  const entered = deferred();
  const release = deferred();
  const mocks = mockClients(async (request, options, connection) => {
    if (connection.token === files.profiles[0].token) { entered.resolve(); await release.promise; }
    return result({ caller: request.arguments.caller, token: connection.token });
  });
  const facade = await files.facade(mocks);
  files.own(() => release.resolve());
  const original = facade.callTool(listTool, { caller });
  await entered.promise;
  await writeJson(files.profileFiles[0], { ...files.profiles[0], token: "synthetic-rotated-host-token" });
  const freshCaller = { ...caller, conversation_id: "synthetic-new-during-rotation" };
  assert.equal((await facade.callTool(listTool, { caller: freshCaller })).structuredContent.token, "synthetic-rotated-host-token");
  assert.equal(mocks.created[0].closed, 0);
  assert.equal(mocks.created[0].connection.signal.aborted, false);
  release.resolve();
  assert.deepEqual((await original).structuredContent, { caller, token: files.profiles[0].token });
  assert.equal(mocks.created[0].closed, 1);
  assert.deepEqual((await facade.callTool(listTool, { caller })).structuredContent, { caller, token: "synthetic-rotated-host-token" });
  assert.equal(mocks.created.length, 2);
});

test("cancelling one CID's active call does not cancel another CID on the shared host client", { timeout: 5000 }, async context => {
  const files = await fixture(context);
  const entered = deferred();
  const release = deferred();
  const requests = [];
  const mocks = mockClients(async (request, options) => {
    requests.push({ caller: request.arguments.caller, signal: options.signal });
    if (requests.length === 2) entered.resolve();
    if (request.arguments.caller.conversation_id === caller.conversation_id) {
      return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("synthetic-cancelled")), { once: true }));
    }
    await release.promise;
    return result({ caller: request.arguments.caller });
  });
  const facade = await files.facade(mocks);
  files.own(() => release.resolve());
  const abort = new AbortController();
  const cancelled = facade.callTool(listTool, { caller }, { signal: abort.signal });
  const otherCaller = { ...caller, conversation_id: "synthetic-other-waiting-cid" };
  const other = facade.callTool(listTool, { caller: otherCaller });
  await entered.promise;
  abort.abort();
  assert.equal(errorCode(await cancelled), "request_cancelled");
  assert.equal(requests.filter(request => request.signal.aborted).length, 1);
  assert.equal(mocks.created[0].connection.signal.aborted, false);
  assert.equal(mocks.created[0].closed, 0);
  release.resolve();
  assert.deepEqual((await other).structuredContent.caller, otherCaller);
  assert.equal(mocks.created.length, 1);
});

test("a failed scoped call returns a static error after exactly one attempt", async context => {
  const files = await fixture(context);
  const sentinel = "SYNTHETIC_SCOPE_SECRET";
  const mocks = mockClients(async () => { throw new Error(sentinel); });
  const facade = await files.facade(mocks);
  const response = await facade.callTool(listTool, { caller });
  assert.equal(errorCode(response), "core_call_failed");
  assert.equal(mocks.created.length, 1);
  assert.equal(mocks.created[0].calls.length, 1);
  assert.equal(mocks.created[0].closed, 1);
  assert.ok(!JSON.stringify(response).includes(sentinel));
});

test("instructions describe host access and caller declarations while keeping delivery and ACK guidance", () => {
  for (const text of ["machine_id", "host", "surface", "conversation_id", "宿主统一入口", "无需逐个登记CID", "按端和对话ID", "next_model_boundary", "能中途插入就插入", "仅明确延后时用when_idle", "hidden", "QQ来信回原QQ", "实际处理后才ACK", "原请求ID", "dedupe_key", "不启动服务", "broker未提供可信宿主CID", "未鉴别实际宿主来源"]) assert.ok(FACADE_INSTRUCTIONS.includes(text), text);
});
