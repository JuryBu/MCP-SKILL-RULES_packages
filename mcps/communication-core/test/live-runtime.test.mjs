import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startLiveFromConfig } from "../src/live-runtime.mjs";
import { runLiveCli } from "../scripts/live.mjs";
import { startLiveService } from "../scripts/live-service.mjs";
import { MockAdapter } from "../src/adapters/mock.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const mockFactories = { antigravity: () => new MockAdapter() };

test("同stateDir第二runtime在adapter构造与SQLite调度前被拒绝", async context => {
  const files = await fixture(context);
  const first = await startLiveFromConfig({ ...files, factories: mockFactories });
  files.cleanup(() => first.close());
  let constructions = 0;
  let second;
  try {
    await assert.rejects((async () => {
      second = await startLiveFromConfig({ ...files, factories: { antigravity: () => { constructions += 1; return new MockAdapter(); } } });
    })(), error => error.code === "runtime_locked");
    assert.equal(constructions, 0);
  } finally {
    await second?.close();
  }
});

test("runtime关闭等待adapter完成才释放锁，关闭失败保留独占", async context => {
  const files = await fixture(context);
  let finish;
  let entered;
  const entering = new Promise(resolveEntered => { entered = resolveEntered; });
  const closing = new Promise(resolveFinish => { finish = resolveFinish; });
  const adapter = new MockAdapter();
  adapter.close = () => { entered(); return closing; };
  const service = await startLiveFromConfig({ ...files, factories: { antigravity: () => adapter } });
  files.cleanup(() => service.close());
  const stopped = service.close();
  await entering;
  try {
    await assert.rejects(startLiveFromConfig({ ...files, factories: mockFactories }), { code: "runtime_locked" });
    assert.ok((await stat(`${files.stateDir}.runtime-lock`)).isFile());
  } finally { finish(); }
  await stopped;
  assert.equal(JSON.parse(await readFile(`${files.stateDir}.runtime-lock`, "utf8")).state, "closed");
  const broken = new MockAdapter();
  broken.close = () => { throw new Error("synthetic-close-failure"); };
  const next = await startLiveFromConfig({ ...files, factories: { antigravity: () => broken } });
  files.cleanup(() => next.close().catch(() => {}));
  await assert.rejects(next.close(), { code: "shutdown_failed" });
  await assert.rejects(startLiveFromConfig({ ...files, factories: mockFactories }), { code: "runtime_locked" });
  await assert.rejects(startLiveFromConfig({ ...files, factories: mockFactories, recoverTerminated: true }), { code: "runtime_locked" });
});

test("旧无锁状态换endpoint仍在adapter与SQLite前拒绝", async context => {
  const files = await fixture(context);
  const service = await startLiveFromConfig({ ...files, factories: mockFactories });
  await service.close();
  await unlink(`${files.stateDir}.runtime-lock`);
  const database = await readFile(join(files.stateDir, "core.sqlite"));
  let constructed = 0;
  const endpointFile = join(files.directory, "synthetic-new-endpoint.json");
  await assert.rejects(startLiveService({ ...files, endpointFile }, { startRuntime: options => startLiveFromConfig({ ...options, factories: { antigravity: () => { constructed += 1; return new MockAdapter(); } } }) }), { code: "runtime_locked" });
  assert.equal(constructed, 0);
  assert.deepEqual(await readFile(join(files.stateDir, "core.sqlite")), database);
  await assert.rejects(stat(endpointFile), { code: "ENOENT" });
});

test("Codex私有连接默认工厂通过真实HTTP提交准确来源与原ID", async context => {
  const value = configuration();
  value.targets[0].host = "codex";
  value.adapters[0].kind = "codex_proxy";
  const files = await fixture(context, value);
  const calls = [];
  const upstream = createHttpServer(async (incoming, response) => {
    const buffers = [];
    for await (const chunk of incoming) buffers.push(chunk);
    const body = JSON.parse(Buffer.concat(buffers).toString("utf8"));
    calls.push({ url: incoming.url, token: incoming.headers.authorization, body });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, delivery: { ...body, thread_id: body.target.conversation_id, turn_id: "synthetic-native-turn", outcome: "accepted", request_sent: true, injection_method: "turn/start" } }));
  });
  await new Promise(resolveListen => upstream.listen(0, "127.0.0.1", resolveListen));
  files.cleanup(() => new Promise(resolveClose => { upstream.closeAllConnections(); upstream.close(resolveClose); }));
  const connectionPath = join(files.directory, "synthetic-private-connection.json");
  await writeFile(connectionPath, JSON.stringify({ base_url: `http://127.0.0.1:${upstream.address().port}`, token: "synthetic-control-token" }), "utf8");
  value.adapters[0].connection_file = connectionPath;
  await writeFile(files.configPath, JSON.stringify(value), "utf8");
  const service = await startLiveFromConfig(files);
  files.cleanup(() => service.close());
  const result = await service.core.sendMessage({ principal_id: value.principals[0].id }, sendInput(value));
  await service.core.drain();
  const snapshot = service.core.getMessage({ principal_id: value.principals[0].id }, { caller: value.principals[0].identity, message_id: result.message.message_id });
  assert.equal(snapshot.delivery.status, "accepted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/v1/communication/deliveries");
  assert.equal(calls[0].body.delivery_id, result.delivery.delivery_id);
  assert.equal(calls[0].body.origin.conversation_id, value.principals[0].identity.conversation_id);
  assert.equal(calls[0].body.target.conversation_id, value.targets[0].conversation_id);
  assert.equal(calls[0].token, "Bearer synthetic-control-token");
});

test("Codex默认工厂只在显式固定hash模块的submit前触发来源恢复", async context => {
  const value = configuration();
  value.targets[0].host = "codex";
  value.adapters[0].kind = "codex_proxy";
  const files = await fixture(context, value);
  const calls = [];
  const tracePath = join(files.directory, "synthetic-recovery-trace.json");
  const upstream = createHttpServer(async (incoming, response) => {
    const buffers = [];
    for await (const chunk of incoming) buffers.push(chunk);
    const body = JSON.parse(Buffer.concat(buffers).toString("utf8"));
    calls.push(body);
    assert.deepEqual(JSON.parse(await readFile(tracePath, "utf8")), { mode: "ensure" });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, delivery: { ...body, thread_id: body.target.conversation_id, turn_id: "synthetic-native-turn", outcome: "accepted", request_sent: true, injection_method: "turn/start" } }));
  });
  await new Promise(resolveListen => upstream.listen(0, "127.0.0.1", resolveListen));
  files.cleanup(() => new Promise(resolveClose => { upstream.closeAllConnections(); upstream.close(resolveClose); }));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const modulePath = join(files.directory, "synthetic-recovery.mjs");
  const bytes = `import {writeFileSync} from 'node:fs'; export async function ensureCodexCommunication(options) { writeFileSync(${JSON.stringify(tracePath)}, JSON.stringify(options)); return {ok:true,status:'ready',endpoint:${JSON.stringify(baseUrl)},binding:{instance_id:'synthetic-instance',manifest_sha256:'${"a".repeat(64)}',configuration_sha256:'${"b".repeat(64)}'}}; }`;
  await writeFile(modulePath, bytes, "utf8");
  const connectionPath = join(files.directory, "synthetic-opt-in-connection.json");
  await writeFile(connectionPath, JSON.stringify({ base_url: baseUrl, token: "synthetic-control-token", source_recovery: { module_path: modulePath, sha256: createHash("sha256").update(bytes).digest("hex") } }), "utf8");
  value.adapters[0].connection_file = connectionPath;
  await writeFile(files.configPath, JSON.stringify(value), "utf8");
  const service = await startLiveFromConfig(files);
  files.cleanup(() => service.close());
  await assert.rejects(stat(tracePath), { code: "ENOENT" });
  const result = await service.core.sendMessage({ principal_id: value.principals[0].id }, sendInput(value));
  await service.core.drain();
  assert.equal(service.core.store.getDelivery(result.delivery.delivery_id).status, "accepted");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].delivery_id, result.delivery.delivery_id);
});

test("Codex私有连接拒绝显式空hook和未校验模块，不调用模块或业务", async context => {
  for (const sourceRecovery of [null, {}, { module_path: "relative.mjs", sha256: "0".repeat(64) }, { module_path: "file:///fixture.mjs", sha256: "0".repeat(64) }]) {
    const value = configuration();
    value.targets[0].host = "codex";
    value.adapters[0].kind = "codex_proxy";
    const files = await fixture(context, value);
    const connectionPath = join(files.directory, "synthetic-invalid-hook.json");
    await writeFile(connectionPath, JSON.stringify({ base_url: "http://127.0.0.1:12345", token: "synthetic-control-token", source_recovery: sourceRecovery }), "utf8");
    value.adapters[0].connection_file = connectionPath;
    await writeFile(files.configPath, JSON.stringify(value), "utf8");
    await assert.rejects(startLiveFromConfig(files), { code: "startup_failed" });
    await assert.rejects(stat(join(files.stateDir, "core.sqlite")), { code: "ENOENT" });
  }
});

test("默认Codex运行时close等待原来源恢复promise且取消后没有业务POST", async context => {
  const value = configuration();
  value.targets[0].host = "codex";
  value.adapters[0].kind = "codex_proxy";
  const files = await fixture(context, value);
  let entered;
  let release;
  const started = new Promise(resolveStarted => { entered = resolveStarted; });
  const pending = new Promise(resolvePending => { release = resolvePending; });
  const key = `synthetic-recovery-${files.directory}`;
  const state = { calls: 0, entered, pending };
  globalThis[key] = state;
  let posts = 0;
  const upstream = createHttpServer((incoming, response) => { posts += 1; response.writeHead(500); response.end(); });
  await new Promise(resolveListen => upstream.listen(0, "127.0.0.1", resolveListen));
  files.cleanup(() => new Promise(resolveClose => { upstream.closeAllConnections(); upstream.close(resolveClose); }));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  const result = { ok: true, status: "ready", endpoint: baseUrl, binding: { instance_id: "synthetic-instance", manifest_sha256: "a".repeat(64), configuration_sha256: "b".repeat(64) } };
  files.cleanup(() => { release(result); delete globalThis[key]; });
  const bytes = `export async function ensureCodexCommunication() { const state = globalThis[${JSON.stringify(key)}]; state.calls += 1; state.entered(); return state.pending; }`;
  const modulePath = join(files.directory, "synthetic-pending-recovery.mjs");
  await writeFile(modulePath, bytes, "utf8");
  const connectionPath = join(files.directory, "synthetic-pending-connection.json");
  await writeFile(connectionPath, JSON.stringify({ base_url: baseUrl, token: "synthetic-token", source_recovery: { module_path: modulePath, sha256: createHash("sha256").update(bytes).digest("hex") } }), "utf8");
  value.adapters[0].connection_file = connectionPath;
  await writeFile(files.configPath, JSON.stringify(value), "utf8");
  const service = await startLiveFromConfig(files);
  files.cleanup(async () => { release(result); await service.close(); });
  await service.core.sendMessage({ principal_id: value.principals[0].id }, sendInput(value));
  await started;
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  await delay(20);
  assert.equal(closed, false);
  assert.equal(state.calls, 1);
  release(result);
  await closing;
  assert.equal(posts, 0);
});

function configuration() {
  return {
    adapter_mode: "live_test",
    allowed_conversation_ids: ["synthetic-ag-target"],
    adapters: [{ id: "synthetic-ag-adapter", kind: "antigravity" }],
    targets: [{
      machine_id: "synthetic-machine", host: "antigravity", surface: "test", conversation_id: "synthetic-ag-target",
      binding_id: "synthetic-ag-binding", binding_generation: 1, adapter_id: "synthetic-ag-adapter",
      capabilities: { next_model_boundary: true, when_idle: true }, evidence: "simulated",
    }],
    principals: [{
      id: "synthetic-source", token: "synthetic-source-token",
      identity: { machine_id: "synthetic-machine", host: "codex", conversation_id: "synthetic-source-conversation" },
      allowed_targets: ["synthetic-ag-binding"],
    }],
  };
}

async function fixture(context, value = configuration()) {
  const directory = await mkdtemp(join(tmpdir(), "communication-core-live-中文 "));
  const cleanups = [];
  context.after(async () => {
    const results = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { results.push(error); }
    }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
    if (results.length) throw new AggregateError(results, "模拟运行资源清理失败");
  });
  const configPath = join(directory, "synthetic-配置.json");
  const stateDir = join(directory, "synthetic-状态");
  await writeFile(configPath, JSON.stringify(value), "utf8");
  return { directory, configPath, stateDir, value, cleanup: callback => cleanups.push(callback) };
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("模拟运行等待超时");
    await delay(10);
  }
}

function sendInput(value, dedupeKey = "synthetic-live-request") {
  const target = value.targets[0];
  return {
    caller: value.principals[0].identity,
    origin: { kind: "agent_message", channel: "host_mcp", source_ref: "synthetic-live-event" },
    target: {
      machine_id: target.machine_id, host: target.host, surface: target.surface,
      conversation_id: target.conversation_id, binding_id: target.binding_id, binding_generation: target.binding_generation,
    },
    dedupe_key: dedupeKey, text: "模拟入口验证，不发送真实消息", reply_required: true,
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
}

function ownerConfiguration(replyEvents) {
  const value = configuration();
  value.allowed_conversation_ids = ["synthetic-owner-target"];
  value.targets[0].host = "qq";
  value.targets[0].surface = "group";
  value.targets[0].conversation_id = "synthetic-owner-target";
  value.adapters[0] = { id: value.adapters[0].id, kind: "napcat_owner", base_url: "http://127.0.0.1:12345/napcat/mcp", route_key: "synthetic-owner-route", conversation_id: "synthetic-maintenance-route", ...(replyEvents === undefined ? {} : { reply_events: replyEvents }) };
  return value;
}

test("QQ回信配置默认关闭，只保留显式真实代次与本人allowlist的接入准备", async context => {
  for (const option of [undefined, { enabled: false }, { enabled: true, target_key: "synthetic-owner-target", route_generation: 7, owner_sender_allowlist: ["90001"] }]) {
    const files = await fixture(context, ownerConfiguration(option));
    let captured;
    const service = await startLiveFromConfig({ ...files, factories: { napcat_owner: entry => { captured = entry; return new MockAdapter(); } } });
    files.cleanup(() => service.close());
    assert.equal(captured.conversation_id, "synthetic-maintenance-route");
    if (option?.enabled) assert.deepEqual(captured.reply_events, { enabled: true, targetKey: "synthetic-owner-target", routeGeneration: 7, ownerSenderAllowlist: ["90001"] });
    else assert.deepEqual(captured.reply_events, option);
    await service.close();
  }
});

test("QQ回信配置缺少代次或本人授权时在构造和创建状态前拒绝", async context => {
  const valid = { enabled: true, target_key: "synthetic-owner-target", route_generation: 7, owner_sender_allowlist: ["90001"] };
  const files = await fixture(context, ownerConfiguration());
  let constructions = 0;
  const factories = { napcat_owner: () => { constructions += 1; return new MockAdapter(); } };
  const invalid = [null, {}, { enabled: "true" }, { ...valid, route_generation: 0 }, { ...valid, route_generation: 1.5 }, { ...valid, route_generation: undefined }, { ...valid, target_key: "another-target" }, { ...valid, owner_sender_allowlist: [] }, { ...valid, owner_sender_allowlist: [90001] }, { ...valid, owner_sender_allowlist: ["0"] }, { ...valid, owner_sender_allowlist: ["90001", "90001"] }, { ...valid, owner_sender_allowlist: ["90001", null] }, { ...valid, arbitrary_account: "private-data" }, { enabled: false, route_generation: 1 }];
  for (const option of invalid) {
    await writeFile(files.configPath, JSON.stringify(ownerConfiguration(option)), "utf8");
    await assert.rejects(startLiveFromConfig({ ...files, factories }), { code: "invalid_config" });
    assert.equal(constructions, 0);
    await assert.rejects(stat(files.stateDir), { code: "ENOENT" });
  }
});

function forwardingConfiguration() {
  const value = ownerConfiguration({ enabled: true, target_key: "synthetic-owner-target", route_generation: 7, owner_sender_allowlist: ["90001"] });
  const returnTarget = { ...configuration().targets[0], binding_id: "synthetic-return-binding", adapter_id: "synthetic-return-adapter" };
  value.allowed_conversation_ids.push(returnTarget.conversation_id);
  value.targets.push(returnTarget);
  value.adapters.push({ id: returnTarget.adapter_id, kind: "antigravity" });
  value.principals[0].identity = { machine_id: returnTarget.machine_id, host: returnTarget.host, surface: returnTarget.surface, conversation_id: returnTarget.conversation_id };
  value.reply_forwarding = [{ id: "synthetic-runtime-forward", source_principal_id: value.principals[0].id, from_binding_id: value.targets[0].binding_id, to_binding_id: returnTarget.binding_id, ttl_ms: 60000 }];
  return value;
}

test("QQ自动回推从已验证reader配置取得本人allowlist，内部授权不暴露HTTP token", async context => {
  const files = await fixture(context, forwardingConfiguration());
  const service = await startLiveFromConfig({ ...files, factories: { napcat_owner: () => new MockAdapter(), antigravity: () => new MockAdapter() } });
  files.cleanup(() => service.close());
  assert.deepEqual(service.core.replyForwarding[0].owner_sender_allowlist, ["90001"]);
  assert.equal(service.core.replyForwardPrincipals.length, 1);
  assert.equal(service.core.principals.length, 1);
  assert.equal(Object.hasOwn(service.core.replyForwardPrincipals[0], "token"), false);
  const denied = await fetch(service.url, { headers: { Authorization: `Bearer ${service.core.replyForwardPrincipals[0].id}` } });
  assert.equal(denied.status, 401);
  await denied.body?.cancel();
});

test("QQ自动回推的禁用reader、错来源及私自扩大allowlist在构造和建库前拒绝", async context => {
  const files = await fixture(context, forwardingConfiguration());
  let constructions = 0;
  const factories = { napcat_owner: () => { constructions += 1; return new MockAdapter(); }, antigravity: () => { constructions += 1; return new MockAdapter(); } };
  const mutations = [
    value => { value.adapters[0].reply_events = { enabled: false }; },
    value => { value.reply_forwarding[0].source_principal_id = "foreign-principal"; },
    value => { value.reply_forwarding[0].from_binding_id = value.targets[1].binding_id; },
    value => { value.reply_forwarding[0].to_binding_id = value.targets[0].binding_id; },
    value => { value.reply_forwarding[0].owner_sender_allowlist = ["90002"]; },
    value => { value.reply_forwarding[0].ttl_ms = 0; },
    value => { value.reply_forwarding[0].adopt_reply_events = [{ message_id: "synthetic-message", native_event_id: "" }]; },
  ];
  for (const mutation of mutations) {
    const value = forwardingConfiguration();
    mutation(value);
    await writeFile(files.configPath, JSON.stringify(value), "utf8");
    await assert.rejects(startLiveFromConfig({ ...files, factories }), { code: "invalid_config" });
    assert.equal(constructions, 0);
    await assert.rejects(stat(files.stateDir), { code: "ENOENT" });
  }
});

test("live配置拒绝越界、未知字段与重复授权，校验失败不构造adapter或创建状态目录", async context => {
  const files = await fixture(context);
  let constructions = 0;
  const factories = { antigravity: () => { constructions += 1; return new MockAdapter(); } };
  const mutations = [
    value => { delete value.adapter_mode; },
    value => { value.adapter_mode = "mock"; },
    value => { value.adapter_mode = "real"; },
    value => { value.host = "0.0.0.0"; },
    value => { value.host = "::1"; },
    value => { value.host = null; },
    value => { value.port = -1; },
    value => { value.port = 65536; },
    value => { value.port = 1.5; },
    value => { value.port = null; },
    value => { value.delivery_timeout_ms = 999; },
    value => { value.delivery_timeout_ms = 30001; },
    value => { value.delivery_timeout_ms = "15000"; },
    value => { value.delivery_timeout_ms = null; },
    value => { value.unknown = "synthetic-secret"; },
    value => { delete value.allowed_conversation_ids; },
    value => { value.allowed_conversation_ids = []; },
    value => { value.allowed_conversation_ids = ["synthetic-other-target"]; },
    value => { value.allowed_conversation_ids.push(value.allowed_conversation_ids[0]); },
    value => { value.allowed_conversation_ids = [" "]; },
    value => { value.allowed_conversation_ids = Array.from({ length: 257 }, (_, index) => `synthetic-${index}`); },
    value => { delete value.adapters; },
    value => { value.adapters = []; },
    value => { value.adapters = Array.from({ length: 257 }, (_, index) => ({ id: `synthetic-${index}`, kind: "antigravity" })); },
    value => { value.adapters[0].kind = "codex"; },
    value => { value.adapters[0].kind = "__proto__"; },
    value => { value.adapters[0].fields = {}; },
    value => { value.adapters[0].transport = {}; },
    value => { value.adapters.push({ ...value.adapters[0] }); },
    value => { delete value.targets; },
    value => { value.targets = []; },
    value => { value.targets = Array.from({ length: 257 }, () => ({ ...value.targets[0] })); },
    value => { value.targets.push({ ...value.targets[0] }); },
    value => { value.targets.push({ ...value.targets[0], binding_id: "synthetic-second-binding" }); },
    value => { value.targets[0].adapter_id = "synthetic-missing-adapter"; },
    value => { value.targets[0].binding_generation = 0; },
    value => { value.targets[0].unknown = true; },
    value => { value.targets[0].capabilities.unknown = true; },
    value => { value.targets[0].capabilities.next_model_boundary = "true"; },
    value => { delete value.principals; },
    value => { value.principals = []; },
    value => { value.principals = Array.from({ length: 257 }, () => ({ ...value.principals[0] })); },
    value => { value.principals.push({ ...value.principals[0], token: "synthetic-second-token" }); },
    value => { value.principals.push({ ...value.principals[0], id: "synthetic-second-principal" }); },
    value => { value.principals[0].token = "synthetic invalid token"; },
    value => { value.principals[0].token = "x".repeat(4097); },
    value => { value.principals[0].id = " "; },
    value => { value.principals[0].unknown = true; },
    value => { value.principals[0].identity.unknown = true; },
    value => { delete value.principals[0].identity.conversation_id; },
    value => { delete value.principals[0].allowed_targets; },
    value => { value.principals[0].allowed_targets = ["synthetic-missing-binding"]; },
    value => { value.principals[0].allowed_targets.push(value.principals[0].allowed_targets[0]); },
    value => { value.principals[0].origin_kinds = []; },
    value => { value.principals[0].origin_kinds = ["agent_message", "agent_message"]; },
    value => { value.principals[0].origin_kinds = Array.from({ length: 33 }, (_, index) => `synthetic-${index}`); },
    value => { value.principals[0].channel_component = " "; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const value = configuration();
    mutate(value);
    await writeFile(files.configPath, JSON.stringify(value), "utf8");
    await assert.rejects(startLiveFromConfig({ ...files, factories }), error => error.code === "invalid_config" && !error.message.includes("synthetic-secret"), `配置拒绝案例${index}`);
    await assert.rejects(stat(files.stateDir), { code: "ENOENT" });
  }
  assert.equal(constructions, 0);
});

test("live配置拒绝畸形、超大、目录及缺失文件，路径必须显式给出", async context => {
  const files = await fixture(context);
  for (const content of ["{synthetic-secret", " ".repeat(1048577), "null", "[]"]) {
    await writeFile(files.configPath, content, "utf8");
    await assert.rejects(startLiveFromConfig({ ...files, factories: mockFactories }), { code: "invalid_config" });
  }
  for (const options of [
    { configPath: files.directory, stateDir: files.stateDir },
    { configPath: join(files.directory, "missing.json"), stateDir: files.stateDir },
    { configPath: files.configPath },
    { stateDir: files.stateDir },
    { configPath: files.configPath, stateDir: " " },
  ]) await assert.rejects(startLiveFromConfig({ ...options, factories: mockFactories }), { code: "invalid_config" });
  await assert.rejects(stat(files.stateDir), { code: "ENOENT" });
});

test("live工厂固定kind，所有adapter构造成功才创建状态，失败清理已拥有实例并隐藏原错误", async context => {
  const files = await fixture(context);
  for (const factories of [{ codex: () => new MockAdapter() }, { antigravity: true }]) {
    await assert.rejects(startLiveFromConfig({ ...files, factories }), { code: "invalid_config" });
  }
  files.value.adapters.push({ id: "synthetic-second-adapter", kind: "antigravity" });
  await writeFile(files.configPath, JSON.stringify(files.value), "utf8");
  let closed = 0;
  const received = [];
  await assert.rejects(startLiveFromConfig({ ...files, factories: {
    antigravity: entry => {
      received.push(entry);
      if (entry.id === "synthetic-second-adapter") throw new Error("synthetic-private-token-and-ls-path");
      const adapter = new MockAdapter();
      adapter.close = () => { closed += 1; };
      return adapter;
    },
  } }), error => error.code === "startup_failed" && !/private|token|ls-path/.test(error.message));
  assert.deepEqual(received, files.value.adapters);
  assert.equal(closed, 1);
  await assert.rejects(stat(files.stateDir), { code: "ENOENT" });
  await assert.rejects(startLiveFromConfig({ ...files, factories: { antigravity: () => ({ close() { closed += 1; } }) } }), { code: "startup_failed" });
  assert.equal(closed, 2);
  await assert.rejects(stat(files.stateDir), { code: "ENOENT" });
});

test("UTF8 BOM、单个AG目标和仅来源principal可走真实MCP，关闭重开保留SQLite与去重身份", { timeout: 15000 }, async context => {
  const files = await fixture(context);
  await writeFile(files.configPath, `\uFEFF${JSON.stringify(files.value)}`, "utf8");
  let adapter;
  const factories = { antigravity: () => {
    adapter = new MockAdapter();
    adapter.observeReply = ({ target }) => ({
      native_message_id: "synthetic-native-reply", text: "模拟关联回信", source_step_index: 7,
      cascade_id: target.conversation_id, trajectory_id: "synthetic-trajectory",
    });
    return adapter;
  } };
  let service = await startLiveFromConfig({ ...files, factories });
  const client = new Client({ name: "synthetic-live-runtime", version: "0.1.0" });
  files.cleanup(async () => { await client.close(); await service.close(); });
  assert.equal(service.address.address, "127.0.0.1");
  assert.equal(service.core.deliveryTimeoutMs, 15000);
  assert.equal(service.core.targets.length, 1);
  assert.equal(service.core.principals[0].identity.surface, "desktop");
  assert.equal(service.core.principals[0].identity.conversation_id, "synthetic-source-conversation");
  assert.ok(!files.value.allowed_conversation_ids.includes("synthetic-source-conversation"));
  assert.deepEqual(service.core.principals[0].origin_kinds, ["agent_message"]);
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url), {
    requestInit: { headers: { Authorization: `Bearer ${files.value.principals[0].token}` } },
  }));
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 10);
  assert.ok(!tools.some(tool => /inject|fake|forge/i.test(tool.name)));
  const request = sendInput(files.value);
  const sent = await client.callTool({ name: "communication_send_message", arguments: request });
  assert.notEqual(sent.isError, true);
  const original = sent.structuredContent;
  await service.core.drain();
  assert.equal(adapter.calls.length, 1);
  assert.equal(service.core.result(original.message.message_id).delivery.status, "accepted");
  const reply = await client.callTool({ name: "communication_wait", arguments: {
    caller: files.value.principals[0].identity, message_id: original.message.message_id, until: "reply", wait_ms: 3000,
  } });
  assert.notEqual(reply.isError, true);
  assert.equal(reply.structuredContent.matched, true);
  assert.equal(reply.structuredContent.matched_by, "reply");
  assert.equal(service.core.result(original.message.message_id).message.processing, "pending");
  const url = service.url;
  await client.close();
  assert.strictEqual(service.close(), service.close());
  await service.close();
  await assert.rejects(fetch(url));
  const database = await stat(join(files.stateDir, "core.sqlite"));
  assert.ok(database.size > 0);
  service = await startLiveFromConfig({ ...files, factories });
  const restored = await service.core.sendMessage({ principal_id: files.value.principals[0].id }, request);
  assert.equal(restored.duplicate, true);
  assert.equal(restored.message.message_id, original.message.message_id);
  assert.equal(restored.delivery.delivery_id, original.delivery.delivery_id);
  assert.equal(adapter.calls.length, 0);
  assert.equal(service.core.result(original.message.message_id).delivery.status, "accepted");
  assert.equal(service.core.hasReply(original.message.message_id), true);
});

test("可选字段沿用S1授权，localhost仅监听回环，投递期限接受两个边界", async context => {
  for (const timeoutMs of [1000, 30000]) {
    const value = configuration();
    value.host = "localhost";
    value.port = 0;
    value.delivery_timeout_ms = timeoutMs;
    value.principals[0].allowed_targets = [];
    value.principals[0].channel_component = "synthetic-channel";
    delete value.targets[0].capabilities;
    delete value.targets[0].evidence;
    const files = await fixture(context, value);
    const service = await startLiveFromConfig({ ...files, factories: mockFactories });
    files.cleanup(() => service.close());
    assert.equal(service.address.address, "127.0.0.1");
    assert.match(service.url, /^http:\/\/localhost:\d+\/mcp$/);
    assert.equal(service.core.deliveryTimeoutMs, timeoutMs);
    assert.deepEqual(service.core.principals[0].allowed_targets, []);
    assert.equal(service.core.principals[0].channel_component, "synthetic-channel");
    assert.deepEqual(service.core.targets[0].capabilities, { next_model_boundary: false, when_idle: false });
    await service.close();
  }
});

test("250ms调度与约1秒回信检查串行，close等待在途工作且停止后续调度", { timeout: 10000 }, async context => {
  const files = await fixture(context);
  const service = await startLiveFromConfig({ ...files, factories: mockFactories });
  files.cleanup(() => service.close());
  await service.core.drain();
  let active = 0;
  let maximum = 0;
  let dispatches = 0;
  const polls = [];
  service.core.dispatchPending = async () => {
    dispatches += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    await delay(300);
    active -= 1;
  };
  service.core.pollReplies = async () => {
    polls.push(Date.now());
    active += 1;
    maximum = Math.max(maximum, active);
    await delay(80);
    active -= 1;
  };
  await waitUntil(() => polls.length >= 2);
  await service.close();
  assert.equal(active, 0);
  assert.equal(maximum, 1);
  assert.ok(dispatches >= 3);
  assert.ok(polls[1] - polls[0] >= 1000);
  const count = dispatches;
  await delay(350);
  assert.equal(dispatches, count);
  assert.equal(polls.length, 2);
});

test("调度异常只回报安全文本并关闭HTTP、adapter与store，onError抛错也完成清理", { timeout: 10000 }, async context => {
  const files = await fixture(context);
  const errors = [];
  let closed = 0;
  const adapter = new MockAdapter();
  adapter.close = () => { closed += 1; };
  const service = await startLiveFromConfig({ ...files, factories: { antigravity: () => adapter }, onError: message => {
    errors.push(message);
    throw new Error("synthetic-onError-private-token");
  } });
  files.cleanup(() => service.close());
  await service.core.drain();
  service.core.pollReplies = async () => { throw new Error("synthetic-private-LS-token"); };
  await waitUntil(() => closed === 1);
  await service.close();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /调度异常/);
  assert.ok(!errors[0].includes("synthetic"));
  assert.equal(service.core.closed, true);
  await assert.rejects(fetch(service.url));
  assert.throws(() => service.core.store.getMessage("synthetic-missing"));
  assert.ok((await stat(join(files.stateDir, "core.sqlite"))).size > 0);
});

test("close中止真实core在途模拟投递，等待后清理自有adapter且保留外部adapter所有权", { timeout: 10000 }, async context => {
  const files = await fixture(context);
  let signal;
  let aborted = false;
  let closed = 0;
  const adapter = new MockAdapter();
  adapter.deliver = options => {
    signal = options.signal;
    return new Promise(resolveDelivery => options.signal.addEventListener("abort", () => {
      aborted = true;
      resolveDelivery({ outcome: "unknown", delivery_id: options.delivery.delivery_id, target_key: options.delivery.target_key });
    }, { once: true }));
  };
  adapter.close = () => { assert.equal(aborted, true); closed += 1; };
  const service = await startLiveFromConfig({ ...files, factories: { antigravity: () => adapter } });
  files.cleanup(() => service.close());
  await service.core.sendMessage({ principal_id: files.value.principals[0].id }, sendInput(files.value));
  await waitUntil(() => signal !== undefined);
  await service.close();
  assert.equal(signal.aborted, true);
  assert.equal(closed, 1);
  const borrowed = new MockAdapter();
  borrowed.close = () => { throw new Error("不得关闭外部adapter"); };
  const reopened = await startLiveFromConfig({ ...files, factories: { antigravity: () => ({ adapter: borrowed, owned: false }) } });
  files.cleanup(() => reopened.close());
  await reopened.close();
  assert.equal(reopened.core.closed, true);
});

test("监听失败和退出清理失败保留SQLite，仍清理其余自有资源且隐藏内部错误", async context => {
  const files = await fixture(context);
  const occupied = createServer();
  await new Promise(resolveListening => occupied.listen(0, "127.0.0.1", resolveListening));
  files.cleanup(() => new Promise(resolveClosed => occupied.close(resolveClosed)));
  files.value.port = occupied.address().port;
  await writeFile(files.configPath, JSON.stringify(files.value), "utf8");
  let closed = 0;
  const adapter = new MockAdapter();
  adapter.close = () => { closed += 1; };
  await assert.rejects(startLiveFromConfig({ ...files, factories: { antigravity: () => adapter } }), error => error.code === "startup_failed" && !error.message.includes("EADDRINUSE"));
  assert.equal(closed, 1);
  assert.ok((await stat(join(files.stateDir, "core.sqlite"))).size > 0);
  files.value.port = 0;
  await writeFile(files.configPath, JSON.stringify(files.value), "utf8");
  const service = await startLiveFromConfig({ ...files, factories: { antigravity: () => {
    const broken = new MockAdapter();
    broken.close = () => { throw new Error("synthetic-private-shutdown-token"); };
    return broken;
  } } });
  files.cleanup(() => service.close().catch(() => {}));
  await assert.rejects(service.close(), error => error.code === "shutdown_failed" && !error.message.includes("synthetic"));
  await assert.rejects(fetch(service.url));
  assert.throws(() => service.core.store.getMessage("synthetic-missing"));
});

test("live CLI只接受config和state-dir，缺参、help、重复参数不启动", async () => {
  const output = [];
  const errors = [];
  for (const argumentsList of [[], ["--help"], ["-h"], ["--config", "a"], ["--unknown", "a", "--state-dir", "b"], ["--config", "a", "--config", "b", "--state-dir", "c"]]) {
    assert.equal(await runLiveCli(argumentsList, { stdout: { write: message => output.push(message) }, stderr: { write: message => errors.push(message) } }), 1);
  }
  assert.equal(output.length, 0);
  assert.equal(errors.length, 6);
  assert.ok(errors.every(message => /--config/.test(message) && /--state-dir/.test(message)));
});

function launch(context, files, { signal, direct = false } = {}) {
  const liveModule = pathToFileURL(join(root, "scripts", "live.mjs")).href;
  const mockModule = pathToFileURL(join(root, "src", "adapters", "mock.mjs")).href;
  const source = `import { runLiveCli } from ${JSON.stringify(liveModule)}; import { MockAdapter } from ${JSON.stringify(mockModule)}; process.exitCode = await runLiveCli(process.argv.slice(1), { factories: { antigravity: () => new MockAdapter() } }); ${signal ? `if (process.exitCode === 0) setTimeout(() => process.emit(${JSON.stringify(signal)}), 25);` : ""}`;
  const argumentsList = ["--config", files.configPath, "--state-dir", files.stateDir];
  const child = spawn(process.execPath, direct ? [join(root, "scripts", "live.mjs"), ...argumentsList] : ["--input-type=module", "-e", source, "--", ...argumentsList], {
    cwd: files.directory, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  child.stdin.on("error", () => {});
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal, stdout, stderr }));
  });
  files.cleanup(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return {
    child, exited,
    async listening() {
      await waitUntil(() => stdout.includes("\n") || child.exitCode !== null);
      assert.equal(child.exitCode, null, stderr);
      const event = JSON.parse(stdout.trim());
      assert.deepEqual(Object.keys(event).sort(), ["event", "url"]);
      assert.equal(event.event, "listening");
      assert.match(event.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      return event;
    },
  };
}

async function boundedExit(exited) {
  let timer;
  try {
    return await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("CLI退出超时，stdin可能仍被持有")), 5000); })]);
  } finally {
    clearTimeout(timer);
  }
}

test("live CLI在持有stdin管道时shutdown正常退出，随后同状态重开", { timeout: 15000 }, async context => {
  const files = await fixture(context);
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const running = launch(context, files);
    await running.listening();
    running.child.stdin.write("shutdown\n");
    const result = await boundedExit(running.exited);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.ok(!/synthetic-source-token|stack|Error:/.test(result.stdout + result.stderr));
    assert.ok((await stat(join(files.stateDir, "core.sqlite"))).size > 0);
  }
});

test("live CLI信号处理和stdin EOF释放句柄，直接入口启动失败不泄露配置", { timeout: 20000 }, async context => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const files = await fixture(context);
    const running = launch(context, files, { signal });
    await running.listening();
    const result = await boundedExit(running.exited);
    assert.equal(result.code, 0, result.stderr);
    assert.ok((await stat(join(files.stateDir, "core.sqlite"))).size > 0);
  }
  const files = await fixture(context);
  const running = launch(context, files);
  await running.listening();
  running.child.stdin.end();
  assert.equal((await boundedExit(running.exited)).code, 0);
  await writeFile(files.configPath, '{"synthetic-private-token":', "utf8");
  const failed = launch(context, files, { direct: true });
  const result = await boundedExit(failed.exited);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /启动失败/);
  assert.ok(!/synthetic-private-token|SyntaxError|ENOENT/.test(result.stderr));
  assert.ok((await readFile(files.configPath, "utf8")).includes("synthetic-private-token"));
});
