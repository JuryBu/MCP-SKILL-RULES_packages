import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startLiveFromConfig } from "../src/live-runtime.mjs";
import { CoreError, digest, identityKey } from "../src/contracts.mjs";
import { MockAdapter } from "../src/adapters/mock.mjs";

const allowedOrigins = new Set();
const originalFetch = globalThis.fetch;
let forbiddenFetches = 0;

test.before(() => {
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!allowedOrigins.has(url.origin)) { forbiddenFetches += 1; throw new Error("test attempted unowned network"); }
    return originalFetch(input, options);
  };
});
test.after(() => { globalThis.fetch = originalFetch; assert.equal(forbiddenFetches, 0); });

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function nativeError(code) { return new CoreError(`OWNER_WINDOW_${code}`, "synthetic native error"); }

function target(conversationId, bindingId, host = "antigravity", surface = "desktop", adapterId = "synthetic-model-adapter") {
  return { machine_id: "synthetic-machine", host, surface, conversation_id: conversationId,
    binding_id: bindingId, binding_generation: 1, adapter_id: adapterId,
    capabilities: { next_model_boundary: true, when_idle: true }, evidence: "simulated" };
}

function configuration(enabled = true) {
  const modelA = target("synthetic-model-a", "synthetic-model-a-binding");
  const modelB = target("synthetic-model-b", "synthetic-model-b-binding");
  const source = target("synthetic-owner-target", "synthetic-qq-binding", "qq", "private", "synthetic-qq-adapter");
  return {
    adapter_mode: "live_test", window_ingress_enabled: enabled,
    allowed_conversation_ids: [modelA.conversation_id, modelB.conversation_id, source.conversation_id],
    adapters: [{ id: modelA.adapter_id, kind: "antigravity" },
      { id: source.adapter_id, kind: "napcat_owner", base_url: "http://127.0.0.1:9/napcat/mcp", route_key: "synthetic-legacy-quote-route",
        conversation_id: "synthetic-stable-component-cid", reply_events: { enabled: true, target_key: source.conversation_id,
          route_generation: 1, owner_sender_allowlist: ["100001"] } }],
    targets: [modelA, source, modelB],
    principals: [modelA, modelB].map((model, index) => ({ id: `synthetic-caller-${index}`, token: `synthetic-token-${index}`,
      identity: Object.fromEntries(["machine_id", "host", "surface", "conversation_id"].map(field => [field, model[field]])),
      allowed_targets: [model.binding_id, source.binding_id] })),
    channel_windows: [{ channel: "qq", component: "short-napcat", window_type: "private", window_id: "100001", binding_id: source.binding_id }],
  };
}

class FakeWindowTransport {
  calls = [];
  route = null;
  receipts = new Map();
  events = [];
  counter = 0;
  hooks = {};
  closed = 0;
  readsActive = 0;
  maxReads = 0;

  constructor({ type = "private", id = "100001" } = {}) { this.window = { channel: "qq", type, id, self_id: "200001" }; }

  async invoke(method, parameters, context, perform) {
    assert.ok(context.signal instanceof AbortSignal);
    this.calls.push({ method, parameters: copy(parameters), conversationId: context.conversationId, targetKey: context.targetKey, signal: context.signal });
    return this.hooks[method] ? this.hooks[method](parameters, context, perform) : perform();
  }

  async getOwnerWindowRoute(parameters, context) {
    return this.invoke("get", parameters, context, () => {
      if (!this.route) throw nativeError("SCOPE_MISMATCH");
      return { ok: true, route: copy(this.route), registration: copy(this.receipts.get(parameters.dedupe_key) ?? null) };
    });
  }

  applyRegister(parameters, context) {
    if (this.receipts.has(parameters.dedupe_key)) return { ok: true, route: copy(this.route), registration: copy(this.receipts.get(parameters.dedupe_key)) };
    if (parameters.expected_generation !== (this.route?.route_generation ?? 0)) throw nativeError("GENERATION_MISMATCH");
    const generation = (this.route?.route_generation ?? 0) + 1;
    this.route = { route_key: parameters.route_key, conversation_id: context.conversationId, target_key: parameters.target_key,
      route_generation: generation, status: "open", capture_owner_events: true, reply_delivery: "events_only", window_capture: true,
      window: copy(this.window), owner_sender_allowlist: ["100001"], window_binding: copy(parameters.window_binding) };
    const registration = { dedupe_key: parameters.dedupe_key, expected_generation: parameters.expected_generation,
      applied_generation: generation, fingerprint: digest(parameters) };
    this.receipts.set(parameters.dedupe_key, registration);
    return { ok: true, route: copy(this.route), registration: copy(registration) };
  }

  async registerOwnerWindowRoute(parameters, context) {
    return this.invoke("register", parameters, context, () => { context.onRequestStarted(); return this.applyRegister(parameters, context); });
  }

  async closeOwnerWindowRoute(parameters, context) {
    return this.invoke("close", parameters, context, () => {
      context.onRequestStarted();
      if (parameters.expected_generation !== this.route.route_generation) throw nativeError("GENERATION_MISMATCH");
      this.route.status = "closed";
      this.route.route_generation += 1;
      return { ok: true, route: copy(this.route) };
    });
  }

  async readOwnerWindowEvents(parameters, context) {
    this.readsActive += 1;
    this.maxReads = Math.max(this.maxReads, this.readsActive);
    try {
      return await this.invoke("read", parameters, context, () => {
        if (parameters.expected_route_generation !== this.route.route_generation) throw nativeError("GENERATION_MISMATCH");
        let start = 0;
        if (parameters.cursor) {
          const match = /^g(\d+)_s(\d+)$/.exec(parameters.cursor);
          if (!match || Number(match[1]) !== this.route.route_generation) throw nativeError("CURSOR_SCOPE_MISMATCH");
          start = Number(match[2]);
        }
        const available = this.events.filter(event => event.sequence > start);
        const page = available.slice(0, parameters.limit ?? 50);
        return { ok: true, route: copy(this.route), events: page.map(({ sequence, ...event }) => copy(event)),
          next_cursor: page.length ? `g${this.route.route_generation}_s${page.at(-1).sequence}` : parameters.cursor ?? null,
          partial: available.length > page.length,
          retention: { first_sequence: this.events[0]?.sequence ?? null, last_sequence: this.counter, evicted_through: 0, retained_count: this.events.length },
          source: { mode: "recent_history", max_messages_per_poll: 50, continuity: "not_guaranteed" } };
      });
    } finally { this.readsActive -= 1; }
  }

  append() {
    this.counter += 1;
    const event = { sequence: this.counter, event_id: digest(["runtime-window-event", this.counter]), message_id: String(300000 + this.counter),
      message_seq: this.counter, sender_id: "100001", text: `完整原生消息-${this.counter}`, content: `完整原生消息-${this.counter}`, source_kind: "human_message",
      route_key: this.route.route_key, conversation_id: this.route.conversation_id, target_key: this.route.target_key,
      route_generation: this.route.route_generation, window: copy(this.window), window_binding: copy(this.route.window_binding), owner_sender_allowlist: ["100001"] };
    this.events.push(event);
    return event;
  }

  async close() { this.closed += 1; }
}

async function fixture(context, value = configuration()) {
  const directory = await mkdtemp(join(tmpdir(), "communication-core-runtime-window-中文 "));
  const configPath = join(directory, "synthetic-配置.json");
  const stateDir = join(directory, "synthetic-状态");
  const cleanups = [];
  const modelAdapters = [];
  const native = new FakeWindowTransport();
  const errors = [];
  await writeFile(configPath, JSON.stringify(value), "utf8");
  context.after(async () => {
    const failures = [];
    for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch (error) { failures.push(error); } }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
    if (failures.length) throw new AggregateError(failures, "runtime window test cleanup failed");
  });
  return { directory, configPath, stateDir, value, native, errors, modelAdapters,
    cleanup(callback) { cleanups.push(callback); },
    async save() { await writeFile(configPath, JSON.stringify(value), "utf8"); },
    async open({ modelFactory = () => new MockAdapter(), qqFactory, ...options } = {}) {
      const service = await startLiveFromConfig({ configPath, stateDir, onError: message => errors.push(message),
        factories: { antigravity: () => { const adapter = modelFactory(); modelAdapters.push(adapter); return adapter; },
          napcat_owner: qqFactory ?? (() => ({ adapter: new MockAdapter(), windowTransport: native })) }, ...options });
      allowedOrigins.add(new URL(service.url).origin);
      cleanups.push(() => service.close());
      return service;
    } };
}

function sourceFor(service) { return [...service.core.ownerWindows.sources.values()][0]; }
function recordFor(service, event) {
  const source = sourceFor(service);
  return service.core.store.findMessageByDedupe(identityKey(source.source_target), `owner-window-${digest([source.route_key, event.route_generation, event.event_id])}`);
}
function manageInput(value, action, expectedGeneration) {
  return { caller: value.principals[0].identity, action, channel: "qq", window_type: "private", window_id: "100001",
    ...(expectedGeneration === undefined ? {} : { expected_generation: expectedGeneration }) };
}
async function bind(files, service, generation = 0, principalIndex = 0) {
  return service.core.manageChannelBinding({ principal_id: files.value.principals[principalIndex].id },
    { ...manageInput(files.value, "bind", generation), caller: files.value.principals[principalIndex].identity });
}
async function waitUntil(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("runtime window test wait timed out");
    await delay(10);
  }
}
async function connectClient(files, service, index = 0) {
  const client = new Client({ name: "synthetic-runtime-window", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(service.url), {
    requestInit: { headers: { authorization: `Bearer ${files.value.principals[index].token}` } },
  });
  await client.connect(transport);
  files.cleanup(() => client.close());
  return client;
}

test("default false retains source specifications and model binding without opening capture", async context => {
  const value = configuration();
  delete value.window_ingress_enabled;
  const files = await fixture(context, value);
  const service = await files.open();
  const source = sourceFor(service);
  assert.equal(Object.keys(source).length, 11);
  assert.equal(Object.hasOwn(source, "transport"), false);
  assert.equal(source.component, "short-napcat");
  assert.equal(source.conversation_id, "synthetic-stable-component-cid");
  assert.equal(source.source_target.binding_id, "synthetic-qq-binding");
  assert.deepEqual(source.owner_sender_allowlist, ["100001"]);
  const result = await bind(files, service);
  assert.equal(result.capture.consumer_enabled, false);
  assert.equal(result.capture.status, "idle");
  assert.equal(service.core.store.getChannelBinding(source.window_key).target.conversation_id, "synthetic-model-a");
  assert.equal(files.native.calls.some(call => call.method === "register"), false);
  assert.equal(JSON.parse(await readFile(files.configPath, "utf8")).channel_windows.length, 1);
});

test("native window ingest preserves its ID and does not wait for an active reply scan", async context => {
  const files = await fixture(context);
  const service = await files.open();
  const bound = await bind(files, service);
  assert.equal(bound.capture.status, "ready");
  assert.notEqual(files.native.route.route_key, files.value.adapters[1].route_key);
  const pendingReply = Promise.withResolvers();
  let replyStarted = false;
  service.core.pollReplies = () => {
    replyStarted = true;
    return pendingReply.promise;
  };
  try {
    const event = files.native.append();
    await waitUntil(() => replyStarted);
    await waitUntil(() => recordFor(service, event)?.delivery_status === "accepted");
    await service.core.drain();
    const message = recordFor(service, event);
    assert.equal(message.native_window_source.event.event_id, event.event_id);
    assert.equal(message.envelope.target.conversation_id, "synthetic-model-a");
    assert.equal(message.envelope.origin.channel, "napcat_owner_window");
    assert.equal(message.envelope.text, event.text);
    assert.equal(files.modelAdapters[0].calls.length, 1);
    assert.equal(service.windowIngress.getStatus(bound.window_key).cursor, "g1_s1");
    assert.equal(files.native.maxReads, 1);
  } finally {
    pendingReply.resolve();
  }
});

test("MCP bind synchronizes only after successful CAS, and get/list expose bounded capture summary", async context => {
  const files = await fixture(context);
  const service = await files.open();
  const client = await connectClient(files, service);
  const call = argumentsValue => client.callTool({ name: "communication_manage_channel_binding", arguments: argumentsValue });
  const missing = await call(manageInput(files.value, "get"));
  assert.notEqual(missing.isError, true);
  assert.deepEqual(missing.structuredContent, { binding: null });
  const first = await call(manageInput(files.value, "bind", 0));
  assert.equal(first.isError, undefined);
  assert.equal(first.structuredContent.capture.status, "ready");
  const count = files.native.calls.length;
  const stale = await call(manageInput(files.value, "bind", 0));
  assert.equal(stale.isError, true);
  assert.equal(files.native.calls.length, count);
  const fetched = await call(manageInput(files.value, "get"));
  assert.equal(fetched.structuredContent.capture.status, "ready");
  const listed = await call({ caller: files.value.principals[0].identity, action: "list" });
  assert.equal(listed.structuredContent.bindings.length, 1);
  assert.equal(listed.structuredContent.bindings[0].capture.pending_operation, null);
  assert.equal(files.native.calls.length, count);
  for (const response of [fetched, listed]) {
    const capture = response === fetched ? response.structuredContent.capture : response.structuredContent.bindings[0].capture;
    assert.ok(!JSON.stringify(capture).match(/owner_key|window_binding|target|dedupe|cursor|conversation_id/));
  }
});

test("same native page replay uses actual Core durable dedupe after cursor persistence failure", async context => {
  const files = await fixture(context);
  const service = await files.open();
  const binding = await bind(files, service);
  const event = files.native.append();
  const put = service.core.store.putChannelIngressState.bind(service.core.store);
  let fail = true;
  service.core.store.putChannelIngressState = (key, state) => {
    if (state.cursor && fail) { fail = false; throw new Error("synthetic cursor fsync failure"); }
    return put(key, state);
  };
  await assert.rejects(service.windowIngress.poll(binding.window_key), { code: "window_ingress_persistence_failed" });
  const firstId = recordFor(service, event).message_id;
  assert.equal(service.windowIngress.getStatus(binding.window_key).cursor, null);
  await service.windowIngress.poll(binding.window_key);
  await service.core.drain();
  assert.equal(recordFor(service, event).message_id, firstId);
  assert.equal(files.modelAdapters[0].calls.length, 1);
  assert.equal(service.windowIngress.getStatus(binding.window_key).cursor, "g1_s1");
});

test("disabled restart keeps sources and old prepared Core queue, closes native route without deleting mapping", async context => {
  const files = await fixture(context);
  const first = await files.open();
  const binding = await bind(files, first);
  first.core.enqueue = async () => {};
  const event = files.native.append();
  await first.windowIngress.poll(binding.window_key);
  const messageId = recordFor(first, event).message_id;
  assert.equal(recordFor(first, event).delivery_status, "prepared");
  await first.close();
  files.value.window_ingress_enabled = false;
  await files.save();
  const second = await files.open();
  await second.windowIngress.synchronize(binding.window_key);
  await second.core.drain();
  assert.equal(sourceFor(second).window_key, binding.window_key);
  assert.equal(recordFor(second, event).message_id, messageId);
  assert.equal(recordFor(second, event).delivery_status, "accepted");
  assert.equal(files.modelAdapters[1].calls.length, 1);
  assert.equal(second.core.store.getChannelBinding(binding.window_key).deleted, false);
  assert.equal(files.native.route.status, "closed");
  assert.equal(second.windowIngress.getStatus(binding.window_key).status, "closed");
  assert.equal(JSON.parse(await readFile(files.configPath, "utf8")).channel_windows.length, 1);
  await second.close();
  files.value.window_ingress_enabled = true;
  await files.save();
  const third = await files.open();
  await third.windowIngress.synchronize(binding.window_key);
  assert.equal(files.native.route.status, "open");
  assert.equal(files.native.route.route_generation, 3);
  await third.windowIngress.poll(binding.window_key);
  await third.core.drain();
  assert.equal(recordFor(third, event).message_id, messageId);
  assert.equal(files.modelAdapters[2].calls.length, 0);
});

test("disable drains captured old native page and confirms close before reporting closed", async context => {
  const files = await fixture(context);
  const first = await files.open();
  const binding = await bind(files, first);
  const event = files.native.append();
  await first.close();
  files.value.window_ingress_enabled = false;
  await files.save();
  const second = await files.open();
  await waitUntil(() => files.native.route.status === "closed");
  await second.core.drain();
  assert.equal(recordFor(second, event).envelope.target.conversation_id, "synthetic-model-a");
  assert.equal(files.native.route.status, "closed");
  const reply = await second.core.manageChannelBinding({ principal_id: files.value.principals[0].id }, manageInput(files.value, "get"));
  assert.equal(reply.capture.consumer_enabled, false);
  assert.equal(reply.capture.status, "closed");
  assert.equal(reply.capture.native_status, "closed");
  assert.equal(second.core.store.getChannelBinding(binding.window_key).deleted, false);
  assert.deepEqual(files.native.calls.slice(-3).map(call => call.method), ["get", "read", "close"]);
});

test("unknown registration and released re-claim never leak old owner and resolve original intent first", async context => {
  const files = await fixture(context);
  let originalRequest;
  let originalContext;
  files.native.hooks.register = (parameters, scope, perform) => {
    if (parameters.expected_generation !== 0) return perform();
    originalRequest = copy(parameters);
    originalContext = scope;
    scope.onRequestStarted();
    throw new CoreError("napcat_mcp_unconfirmed", "synthetic delayed registration", { request_sent: true });
  };
  const service = await files.open();
  const binding = await bind(files, service);
  assert.equal(binding.capture.status, "pending");
  const removed = await service.core.manageChannelBinding({ principal_id: files.value.principals[0].id }, manageInput(files.value, "remove", 1));
  assert.equal(removed.generation, 2);
  const other = { principal_id: files.value.principals[1].id };
  const released = await service.core.manageChannelBinding(other, { ...manageInput(files.value, "get"), caller: files.value.principals[1].identity });
  assert.ok(!JSON.stringify(released).includes("synthetic-model-a"));
  const claimed = await bind(files, service, 2, 1);
  assert.equal(claimed.generation, 3);
  assert.equal(claimed.capture.pending_operation, "register");
  assert.ok(!JSON.stringify(claimed).includes("synthetic-model-a"));
  const oldGet = await service.core.manageChannelBinding({ principal_id: files.value.principals[0].id }, manageInput(files.value, "get"));
  assert.equal(oldGet, null);
  const oldList = await service.core.manageChannelBinding({ principal_id: files.value.principals[0].id }, { caller: files.value.principals[0].identity, action: "list" });
  assert.deepEqual(oldList.bindings, []);
  assert.equal(files.native.calls.filter(call => call.method === "register").length, 1);
  assert.ok(files.native.calls.filter(call => call.method === "get" && call.parameters.dedupe_key)
    .every(call => call.parameters.dedupe_key === originalRequest.dedupe_key));
  files.native.applyRegister(originalRequest, originalContext);
  const event = files.native.append();
  await service.windowIngress.synchronize(binding.window_key);
  await service.windowIngress.poll(binding.window_key);
  await service.core.drain();
  assert.equal(recordFor(service, event).envelope.target.conversation_id, "synthetic-model-a");
  assert.equal(files.native.route.window_binding.target.conversation_id, "synthetic-model-b");
  assert.equal(files.modelAdapters[0].calls.length, 1);
  assert.equal(files.native.calls.filter(call => call.method === "register").length, 2);
});

test("unknown close during disabled restart queries old route without repeating close", async context => {
  const files = await fixture(context);
  const first = await files.open();
  const binding = await bind(files, first);
  await first.close();
  files.value.window_ingress_enabled = false;
  await files.save();
  files.native.hooks.close = (parameters, scope) => { scope.onRequestStarted(); throw new CoreError("napcat_mcp_unconfirmed", "synthetic close unknown", { request_sent: true }); };
  const second = await files.open();
  await second.windowIngress.poll(binding.window_key);
  assert.equal(second.windowIngress.getStatus(binding.window_key).status, "pending");
  await second.close();
  const third = await files.open();
  await third.windowIngress.poll(binding.window_key);
  assert.equal(third.windowIngress.getStatus(binding.window_key).pending_close.expected_generation, 1);
  assert.equal(files.native.calls.filter(call => call.method === "close").length, 1);
  files.native.route.status = "closed";
  files.native.route.route_generation += 1;
  await third.windowIngress.synchronize(binding.window_key);
  assert.equal(third.windowIngress.getStatus(binding.window_key).status, "closed");
  assert.equal(files.native.calls.filter(call => call.method === "close").length, 1);
});

test("shutdown aborts Controller first, awaits native resource cleanup, then closes core/adapters/store", async context => {
  const files = await fixture(context);
  const order = [];
  const service = await files.open();
  const binding = await bind(files, service);
  const entered = deferred();
  const cleanup = deferred();
  let aborted = false;
  files.native.hooks.read = (parameters, scope) => new Promise((resolveRead, rejectRead) => {
    scope.signal.addEventListener("abort", async () => { aborted = true; await cleanup.promise; order.push("native-clean"); rejectRead(new Error("synthetic aborted read")); }, { once: true });
    entered.resolve();
  });
  const closeCore = service.core.close.bind(service.core);
  service.core.close = () => { order.push("core-close"); return closeCore(); };
  const closeStore = service.core.store.close.bind(service.core.store);
  service.core.store.close = () => { order.push("store-close"); return closeStore(); };
  files.modelAdapters[0].close = () => { order.push("adapter-close"); };
  const polling = service.windowIngress.poll(binding.window_key);
  await entered.promise;
  let done = false;
  const closing = service.close().then(() => { done = true; });
  await nextTurn();
  assert.equal(aborted, true);
  assert.equal(done, false);
  assert.deepEqual(order, []);
  cleanup.resolve();
  await Promise.all([polling, closing]);
  assert.ok(order.indexOf("native-clean") < order.indexOf("core-close"));
  assert.ok(order.indexOf("core-close") < order.indexOf("adapter-close"));
  assert.ok(order.indexOf("adapter-close") < order.indexOf("store-close"));
  assert.equal(files.native.closed, 0);
});

test("source selects exact configured QQ binding and surface with deterministic independent window routes", async context => {
  const value = configuration(false);
  const group = target("synthetic-group-target", "synthetic-group-binding", "qq", "group", "synthetic-group-adapter");
  value.targets.unshift(group);
  value.allowed_conversation_ids.push(group.conversation_id);
  value.adapters.push({ id: group.adapter_id, kind: "napcat_owner", base_url: "http://127.0.0.1:9/napcat/mcp", route_key: "synthetic-group-quote",
    conversation_id: "synthetic-group-component-cid", reply_events: { enabled: true, target_key: group.conversation_id, route_generation: 1, owner_sender_allowlist: ["100001"] } });
  value.channel_windows.push({ channel: "qq", component: "short-napcat", window_type: "group", window_id: "100002", binding_id: group.binding_id });
  const files = await fixture(context, value);
  const groupNative = new FakeWindowTransport({ type: "group", id: "100002" });
  const options = { qqFactory: entry => ({ adapter: new MockAdapter(), windowTransport: entry.id === group.adapter_id ? groupNative : files.native }) };
  const first = await files.open(options);
  await first.windowIngress.poll();
  const sources = [...first.core.ownerWindows.sources.values()];
  assert.equal(sources.length, 2);
  assert.equal(sources[0].source_target.binding_id, "synthetic-qq-binding");
  assert.equal(sources[1].source_target.binding_id, group.binding_id);
  assert.equal(sources[1].source_target.surface, "group");
  assert.equal(sources[1].target_key, group.conversation_id);
  assert.equal(groupNative.calls[0].conversationId, "synthetic-group-component-cid");
  assert.equal(files.native.calls[0].conversationId, "synthetic-stable-component-cid");
  const routeByKey = new Map(sources.map(source => [source.window_key, source.route_key]));
  await first.close();
  value.channel_windows.reverse();
  await files.save();
  const second = await files.open(options);
  assert.ok([...second.core.ownerWindows.sources.values()].every(source => source.route_key === routeByKey.get(source.window_key)));
});

test("invalid flag, mismatched window surface, missing owner policy and old quote route collision reject before factories", async context => {
  const changes = [value => { value.window_ingress_enabled = "false"; }, value => { value.window_ingress_enabled = null; },
    value => { value.targets.find(entry => entry.host === "qq").surface = "group"; },
    value => { value.adapters[1].reply_events = { enabled: false }; },
    value => { value.channel_windows.push(copy(value.channel_windows[0])); },
    value => { const window = value.channel_windows[0]; const key = `window:${digest([window.channel, window.component, window.window_type, window.window_id])}`;
      value.adapters[1].route_key = `communication-core-window:${digest([key, window.binding_id, value.adapters[1].conversation_id])}`; }];
  for (const change of changes) {
    const value = configuration();
    change(value);
    const files = await fixture(context, value);
    let made = 0;
    await assert.rejects(startLiveFromConfig({ configPath: files.configPath, stateDir: files.stateDir,
      factories: { antigravity: () => { made += 1; return new MockAdapter(); }, napcat_owner: () => { made += 1; return new MockAdapter(); } } }), { code: "invalid_config" });
    assert.equal(made, 0);
    await assert.rejects(stat(join(files.stateDir, "core.sqlite")), { code: "ENOENT" });
  }
});

test("missing custom window API remains blocked without preventing host startup, and borrowed resources stay borrowed", async context => {
  const files = await fixture(context, configuration(false));
  let closed = 0;
  const adapter = new MockAdapter();
  adapter.close = () => { closed += 1; };
  const unsupported = await files.open({ qqFactory: () => adapter });
  const unavailable = await bind(files, unsupported);
  assert.equal(unavailable.capture.status, "blocked");
  assert.equal(unavailable.capture.consumer_enabled, false);
  assert.equal(unavailable.capture.native_status, "unconfirmed");
  assert.equal(unavailable.capture.last_error, "OWNER_WINDOW_UNSUPPORTED");
  assert.equal(unsupported.core.closed, false);
  await unsupported.close();
  assert.equal(closed, 1);
  const borrowed = new MockAdapter();
  borrowed.close = () => { throw new Error("borrowed adapter must not close"); };
  const next = await files.open({ qqFactory: () => ({ adapter: borrowed, owned: false, windowTransport: files.native }) });
  await next.close();
  assert.equal(files.native.closed, 0);
});

test("no-window true and false retain existing direct delivery without native operations", async context => {
  for (const enabled of [false, true]) {
    const value = configuration(enabled);
    value.channel_windows = [];
    const files = await fixture(context, value);
    const service = await files.open();
    assert.equal(service.windowIngress, undefined);
    assert.equal(service.core.ownerWindows.sources.size, 0);
    assert.equal(files.native.calls.length, 0);
    const model = value.targets.find(entry => entry.conversation_id === "synthetic-model-a");
    const { adapter_id, capabilities, evidence, ...exactTarget } = model;
    const result = await service.core.sendMessage({ principal_id: value.principals[0].id }, { caller: value.principals[0].identity,
      origin: { kind: "agent_message", channel: "host_mcp", source_ref: "synthetic-no-window" }, target: exactTarget,
      dedupe_key: "synthetic-no-window", text: "现有无窗口路径", expires_at: new Date(Date.now() + 60000).toISOString(), reply_required: false });
    await service.core.drain();
    assert.equal(service.core.store.getDelivery(result.delivery.delivery_id).status, "accepted");
    assert.equal(files.modelAdapters[0].calls.length, 1);
  }
});

test("MCP CAS remains visible when capture persistence fails and retry uses the saved binding generation", async context => {
  const files = await fixture(context);
  const service = await files.open();
  const store = service.core.store;
  const put = store.putChannelIngressState.bind(store);
  store.putChannelIngressState = (key, state) => {
    if (state.pending_registration) throw new Error("synthetic private capture persistence failure");
    return put(key, state);
  };
  const saved = await bind(files, service);
  assert.equal(saved.generation, 1);
  assert.equal(saved.capture.status, "blocked");
  assert.equal(saved.capture.last_error, "window_ingress_synchronize_unconfirmed");
  assert.equal(store.getChannelBinding(saved.window_key).generation, 1);
  assert.equal(files.native.calls.filter(call => call.method === "register").length, 0);
  assert.ok(!JSON.stringify(saved).includes("synthetic private capture"));
  assert.ok(files.errors.every(message => !message.includes("synthetic private capture")));
  store.putChannelIngressState = put;
  const confirmed = await bind(files, service, 1);
  assert.equal(confirmed.generation, 1);
  assert.equal(confirmed.capture.status, "ready");
  assert.equal(files.native.calls.filter(call => call.method === "register").length, 1);
});

test("default Napcat factory reuses its actual SDK transport for native windows and closes the owned transport", async context => {
  const files = await fixture(context);
  const native = files.native;
  const methodByTool = { napcat_owner_window_route_register: "registerOwnerWindowRoute", napcat_owner_window_route_get: "getOwnerWindowRoute",
    napcat_owner_window_route_close: "closeOwnerWindowRoute", napcat_owner_window_events_read: "readOwnerWindowEvents" };
  const requests = [];
  const upstream = createServer(async (incoming, response) => {
    try {
      if (incoming.method !== "POST") { response.writeHead(405); response.end(); return; }
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.method.startsWith("notifications/")) { response.writeHead(202); response.end(); return; }
      let result;
      if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "synthetic-native-window", version: "0.0.0" } };
      else if (request.method === "tools/call") {
        const parameters = request.params.arguments;
        requests.push(request.params);
        assert.equal(incoming.headers["x-conversation-id"], "synthetic-stable-component-cid");
        assert.equal(parameters.conversation_id, "synthetic-stable-component-cid");
        try {
          const value = await native[methodByTool[request.params.name]](parameters, { conversationId: parameters.conversation_id,
            targetKey: "synthetic-owner-target", signal: new AbortController().signal, onRequestStarted() {} });
          result = { content: [{ type: "text", text: JSON.stringify(value) }] };
        } catch (error) {
          result = { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, code: error.code, outcomeUnknown: false }) }] };
        }
      } else throw new Error("unexpected synthetic protocol method");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise(resolveListen => upstream.listen(0, "127.0.0.1", resolveListen));
  files.cleanup(() => new Promise(resolveClose => { upstream.closeAllConnections(); upstream.close(resolveClose); }));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  allowedOrigins.add(origin);
  files.value.adapters[1].base_url = `${origin}/napcat/mcp`;
  await files.save();
  const model = new MockAdapter();
  const service = await files.open({ factories: { antigravity: () => model } });
  const qq = service.core.adapters.get("synthetic-qq-adapter");
  let gets = 0;
  const getRoute = qq.transport.getOwnerWindowRoute.bind(qq.transport);
  qq.transport.getOwnerWindowRoute = (...args) => { gets += 1; return getRoute(...args); };
  const binding = await bind(files, service);
  assert.equal(binding.capture.status, "ready");
  assert.equal(gets, 1);
  const event = native.append();
  await service.windowIngress.poll(binding.window_key);
  await service.core.drain();
  assert.equal(recordFor(service, event).delivery_status, "accepted");
  assert.equal(model.calls.length, 1);
  assert.ok(requests.every(request => Object.hasOwn(methodByTool, request.name)));
  assert.ok(requests.every(request => request.arguments.route_key !== "synthetic-legacy-quote-route"));
  await service.close();
  const before = requests.length;
  await assert.rejects(qq.transport.getOwnerWindowRoute({ route_key: sourceFor(service).route_key }, {
    conversationId: "synthetic-stable-component-cid", targetKey: "synthetic-owner-target",
  }), error => error.code === "napcat_mcp_unconfirmed" && error.details.request_sent === false);
  assert.equal(requests.length, before);
  assert.equal(qq.closed, true);
});

test("false after unknown registration keeps querying original dedupe, drains late acceptance, then closes", async context => {
  const files = await fixture(context);
  let originalRequest;
  let originalContext;
  files.native.hooks.register = (parameters, scope) => {
    originalRequest = copy(parameters);
    originalContext = scope;
    scope.onRequestStarted();
    throw new CoreError("napcat_mcp_unconfirmed", "synthetic unknown register", { request_sent: true });
  };
  const first = await files.open();
  const binding = await bind(files, first);
  await first.close();
  files.value.window_ingress_enabled = false;
  await files.save();
  const second = await files.open();
  await second.windowIngress.poll(binding.window_key);
  assert.equal(second.windowIngress.getStatus(binding.window_key).status, "pending");
  assert.equal(files.native.calls.filter(call => call.method === "register").length, 1);
  files.native.applyRegister(originalRequest, originalContext);
  const oldEvent = files.native.append();
  await second.windowIngress.synchronize(binding.window_key);
  await second.core.drain();
  assert.equal(recordFor(second, oldEvent).envelope.target.conversation_id, "synthetic-model-a");
  assert.equal(files.native.route.status, "closed");
  assert.equal(files.native.calls.filter(call => call.method === "register").length, 1);
  assert.ok(files.native.calls.filter(call => call.method === "get" && call.parameters.dedupe_key)
    .every(call => call.parameters.dedupe_key === originalRequest.dedupe_key));
  assert.equal(second.core.store.getChannelBinding(binding.window_key).deleted, false);
});

test("false restart recovers original unknown Core delivery by query without a second submission", async context => {
  const files = await fixture(context);
  const adapter = new MockAdapter({ mode: "unknown" });
  const first = await files.open({ modelFactory: () => adapter });
  const binding = await bind(files, first);
  const event = files.native.append();
  await first.windowIngress.poll(binding.window_key);
  await first.core.drain();
  const originalMessage = recordFor(first, event);
  const deliveryId = first.core.store.getDeliveryForMessage(originalMessage.message_id).delivery_id;
  assert.equal(originalMessage.delivery_status, "unknown");
  assert.equal(adapter.calls.length, 1);
  await first.close();
  files.value.window_ingress_enabled = false;
  await files.save();
  const second = await files.open({ modelFactory: () => adapter });
  await second.core.drain();
  await waitUntil(() => adapter.queries.includes(deliveryId));
  assert.equal(recordFor(second, event).message_id, originalMessage.message_id);
  assert.equal(second.core.store.getDeliveryForMessage(originalMessage.message_id).delivery_id, deliveryId);
  assert.equal(adapter.calls.length, 1);
  assert.equal(recordFor(second, event).delivery_status, "unknown");
});

test("cold disabled closed state only queries current route and never repeats close", async context => {
  const files = await fixture(context);
  const first = await files.open();
  const binding = await bind(files, first);
  await first.close();
  files.value.window_ingress_enabled = false;
  await files.save();
  const second = await files.open();
  await second.windowIngress.synchronize(binding.window_key);
  assert.equal(files.native.route.status, "closed");
  assert.equal(files.native.calls.filter(call => call.method === "close").length, 1);
  await second.close();
  const before = files.native.calls.length;
  const third = await files.open();
  await third.windowIngress.synchronize(binding.window_key);
  assert.deepEqual(files.native.calls.slice(before).map(call => call.method), ["get"]);
  const result = await third.core.manageChannelBinding({ principal_id: files.value.principals[0].id }, manageInput(files.value, "get"));
  assert.equal(result.capture.consumer_enabled, false);
  assert.equal(result.capture.status, "closed");
  assert.equal(result.capture.native_status, "closed");
  assert.equal(third.core.store.getChannelBinding(binding.window_key).deleted, false);
  assert.equal(files.native.calls.filter(call => call.method === "close").length, 1);
});

test("host MCP starts before an unavailable native query and remains usable while the query is pending", async context => {
  const files = await fixture(context, configuration(false));
  const entered = deferred();
  files.native.hooks.get = (parameters, scope) => new Promise((resolveGet, rejectGet) => {
    scope.signal.addEventListener("abort", () => rejectGet(new CoreError("napcat_mcp_unconfirmed", "synthetic unavailable provider", { request_sent: true })), { once: true });
    entered.resolve();
  });
  const service = await files.open();
  assert.equal(files.native.calls.length, 0);
  const polling = service.windowIngress.poll();
  await entered.promise;
  const client = await connectClient(files, service);
  const response = await client.callTool({ name: "communication_list_conversations", arguments: { caller: files.value.principals[0].identity } });
  assert.equal(response.isError, undefined);
  assert.equal(service.core.closed, false);
  await client.close();
  await service.close();
  await polling;
  assert.equal(files.native.closed, 0);
});

test("public bind recovers known-unsent registration after a restart without startup or poll resubmission", async context => {
  const files = await fixture(context);
  files.native.hooks.register = () => { throw new CoreError("napcat_mcp_unconfirmed", "backend not started", { request_sent: false }); };
  const first = await files.open();
  const blocked = await bind(files, first);
  assert.equal(blocked.capture.status, "blocked");
  assert.equal(blocked.capture.blocked_retry_count, 0);
  const originalKey = files.native.calls.find(call => call.method === "register").parameters.dedupe_key;
  await first.close();
  delete files.native.hooks.register;
  const second = await files.open();
  await delay(1200);
  assert.equal(files.native.calls.filter(call => call.method === "register").length, 1);
  assert.equal(second.windowIngress.getStatus(blocked.window_key).status, "blocked");
  const client = await connectClient(files, second);
  const response = await client.callTool({ name: "communication_manage_channel_binding", arguments: manageInput(files.value, "bind", 1) });
  assert.equal(response.isError, undefined);
  assert.equal(response.structuredContent.generation, 1);
  assert.equal(response.structuredContent.capture.status, "ready");
  assert.equal(response.structuredContent.capture.blocked_retry_count, 1);
  assert.equal(files.native.calls.filter(call => call.method === "register").length, 2);
  assert.ok(files.native.calls.filter(call => call.method === "register").every(call => call.parameters.dedupe_key === originalKey));
});

test("public remove retries a known-unsent close, and same owner can bind the next mapping generation", async context => {
  const files = await fixture(context);
  const service = await files.open();
  await bind(files, service);
  const client = await connectClient(files, service);
  const call = input => client.callTool({ name: "communication_manage_channel_binding", arguments: input });
  files.native.hooks.close = () => { throw new CoreError("napcat_mcp_unconfirmed", "close backend unavailable", { request_sent: false }); };
  const blocked = await call(manageInput(files.value, "remove", 1));
  assert.equal(blocked.structuredContent.generation, 2);
  assert.equal(blocked.structuredContent.capture.status, "blocked");
  assert.equal(blocked.structuredContent.capture.native_status, "unconfirmed");
  delete files.native.hooks.close;
  await service.windowIngress.start();
  assert.equal(files.native.calls.filter(request => request.method === "close").length, 1);
  const recovered = await call(manageInput(files.value, "remove", 2));
  assert.equal(recovered.structuredContent.generation, 2);
  assert.equal(recovered.structuredContent.capture.status, "closed");
  assert.equal(recovered.structuredContent.capture.blocked_retry_count, 1);
  const rebound = await call(manageInput(files.value, "bind", 2));
  assert.equal(rebound.structuredContent.generation, 3);
  assert.equal(rebound.structuredContent.capture.status, "ready");
  assert.equal(files.native.route.window_binding.generation, 3);
  assert.equal(files.native.route.window_binding.target.conversation_id, "synthetic-model-a");
  assert.equal(files.native.calls.filter(request => request.method === "close").length, 2);
});
