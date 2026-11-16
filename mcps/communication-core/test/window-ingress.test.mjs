import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoreError, digest, identityKey } from "../src/contracts.mjs";
import { WindowIngressController } from "../src/window-ingress.mjs";
import { NapcatMcpTransport } from "../src/transports/napcat-mcp.mjs";
import { MessageStore } from "../src/store.mjs";

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function providerError(code, details = {}) { return new CoreError(`OWNER_WINDOW_${code}`, "synthetic provider error", details); }

const windowConfig = Object.freeze({ window_key: "synthetic-window", channel: "qq", component: "synthetic-component",
  window_type: "private", window_id: "100001", channel_binding_id: "synthetic-qq-binding", target_key: "synthetic-owner",
  route_key: "synthetic-window-route", conversation_id: "synthetic-stable-component" });

function modelBinding(generation = 1, conversationId = "synthetic-model-a") {
  const target = { machine_id: "synthetic-machine", host: "codex", surface: "desktop", conversation_id: conversationId,
    binding_id: `binding-${conversationId}`, binding_generation: generation };
  return { ...windowConfig, generation, owner_key: identityKey(target), target, deleted: false };
}
function nativeBinding(binding) { return { generation: binding.generation, owner_key: binding.owner_key, target: clone(binding.target) }; }

class FakeNative {
  route = null;
  events = [];
  receipts = new Map();
  calls = [];
  hooks = {};
  evicted = 0;
  sequence = 0;
  closeCalls = 0;

  async invoke(method, args, context, perform) {
    this.calls.push({ method, args: clone(args), context });
    assert.equal(context.conversationId, windowConfig.conversation_id);
    assert.equal(context.targetKey, windowConfig.target_key);
    assert.ok(context.signal instanceof AbortSignal);
    return this.hooks[method] ? this.hooks[method](args, context, perform) : perform();
  }

  async getOwnerWindowRoute(args, context) {
    return this.invoke("get", args, context, () => {
      if (!this.route || this.route.window_capture !== true) throw providerError("SCOPE_MISMATCH");
      return { ok: true, route: clone(this.route), registration: clone(this.receipts.get(args.dedupe_key) ?? null) };
    });
  }

  applyRegister(args) {
    if (this.route && this.route.window_capture !== true) throw providerError("SCOPE_MISMATCH");
    if (this.receipts.has(args.dedupe_key)) return { ok: true, route: clone(this.route), registration: clone(this.receipts.get(args.dedupe_key)), duplicate: true };
    if (args.expected_generation !== (this.route?.route_generation ?? 0)) throw providerError("GENERATION_MISMATCH");
    const unchanged = this.route?.status === "open" && JSON.stringify(this.route.window_binding) === JSON.stringify(args.window_binding);
    const generation = (this.route?.route_generation ?? 0) + (unchanged ? 0 : 1);
    this.route = { route_key: args.route_key, conversation_id: windowConfig.conversation_id, target_key: args.target_key,
      route_generation: generation, status: "open", window_capture: true, capture_owner_events: true, reply_delivery: "events_only",
      window: { channel: "qq", type: "private", id: "100001", self_id: "200001" },
      owner_sender_allowlist: ["100001"], window_binding: clone(args.window_binding) };
    const registration = { dedupe_key: args.dedupe_key, fingerprint: digest(args), expected_generation: args.expected_generation, applied_generation: generation };
    this.receipts.set(args.dedupe_key, registration);
    return { ok: true, route: clone(this.route), registration: clone(registration), duplicate: false };
  }

  async registerOwnerWindowRoute(args, context) {
    return this.invoke("register", args, context, () => { context.onRequestStarted?.(); return this.applyRegister(args); });
  }

  async closeOwnerWindowRoute(args, context) {
    return this.invoke("close", args, context, () => {
      context.onRequestStarted?.();
      if (args.expected_generation !== this.route.route_generation) throw providerError("GENERATION_MISMATCH");
      this.route = { ...this.route, route_generation: this.route.route_generation + 1, status: "closed" };
      return { ok: true, route: clone(this.route) };
    });
  }

  async readOwnerWindowEvents(args, context) {
    return this.invoke("read", args, context, () => {
      if (args.expected_route_generation !== this.route.route_generation) throw providerError("GENERATION_MISMATCH");
      let after = 0;
      if (args.cursor) {
        const cursor = /^g(\d+)_s(\d+)$/.exec(args.cursor);
        if (!cursor) throw providerError("CURSOR_INVALID");
        if (Number(cursor[1]) !== this.route.route_generation) throw providerError("CURSOR_SCOPE_MISMATCH");
        after = Number(cursor[2]);
        if (after <= this.evicted) throw providerError("CURSOR_EXPIRED");
      } else if (this.evicted > 0) throw providerError("HISTORY_EXPIRED");
      const remaining = this.events.filter(event => event.sequence > after);
      const selected = remaining.slice(0, args.limit ?? 50);
      return { ok: true, route: clone(this.route), events: selected.map(({ sequence, ...event }) => clone(event)),
        next_cursor: selected.length ? `g${this.route.route_generation}_s${selected.at(-1).sequence}` : args.cursor ?? null,
        partial: remaining.length > selected.length,
        retention: { first_sequence: this.events[0]?.sequence ?? null, last_sequence: this.sequence, evicted_through: this.evicted,
          retained_count: this.events.length, cache_bytes: 100, max_cache_bytes: 1048576 },
        source: { mode: "recent_history", max_messages_per_poll: 50, continuity: "not_guaranteed" } };
    });
  }

  append(overrides = {}) {
    this.sequence += 1;
    const event = { sequence: this.sequence, event_id: digest(["event", this.sequence]), message_id: String(300000 + this.sequence),
      message_seq: this.sequence, sender_id: "100001", text: `message-${this.sequence}`, content: `message-${this.sequence}`,
      source_kind: "human_message", route_key: this.route.route_key, conversation_id: this.route.conversation_id,
      target_key: this.route.target_key, route_generation: this.route.route_generation, window: clone(this.route.window),
      window_binding: clone(this.route.window_binding), owner_sender_allowlist: ["100001"], ...overrides };
    this.events.push(event);
    return event;
  }

  async close() { this.closeCalls += 1; }
}

function fixture(options = {}) {
  const native = options.native ?? new FakeNative();
  const states = new Map();
  const writes = [];
  const delivered = [];
  const errors = [];
  let binding = modelBinding();
  let now = 100000;
  let beforeWrite;
  const create = (extra = {}) => new WindowIngressController({ windows: [{ ...windowConfig, transport: native }],
    getBinding: () => clone(binding), getState: key => clone(states.get(key) ?? null),
    putState: (key, state) => { beforeWrite?.(state); states.set(key, { ...clone(state), window_key: key }); writes.push(clone(state)); return clone(state); },
    onEvent: async (event, window) => { delivered.push({ event, window }); }, onError: (error, context) => { errors.push({ error, context }); },
    now: () => now, ...extra });
  const controller = create(options.controller);
  return { native, states, writes, delivered, errors, create, controller,
    get binding() { return binding; }, set binding(value) { binding = value; },
    get now() { return now; }, advance(milliseconds = 30000) { now += milliseconds; },
    failWrite(callback) { beforeWrite = callback; }, state() { return clone(states.get(windowConfig.window_key) ?? null); } };
}

test("empty controller opens no transport, owns no timers, and accepts repeated close", async () => {
  const controller = new WindowIngressController({ getBinding: () => null, getState: () => null, putState: () => {}, onEvent: () => {} });
  assert.deepEqual(await controller.start(), []);
  assert.deepEqual(await controller.poll(), []);
  assert.deepEqual(controller.getStatus(), []);
  await Promise.all([controller.close(), controller.close()]);
});

test("first registration queries exact route before CAS zero and persists intent before dispatch", async () => {
  const work = fixture();
  work.native.hooks.register = (args, context, perform) => {
    assert.equal(work.state().pending_registration.dedupe_key, args.dedupe_key);
    assert.equal(work.state().pending_registration.phase, "prepared");
    assert.equal(work.state().pending_registration.expected_generation, 0);
    return perform();
  };
  const [state] = await work.controller.start();
  assert.equal(state.status, "ready");
  assert.equal(state.provider_generation, 1);
  assert.equal(state.confirmed_mapping_generation, 1);
  assert.equal(state.pending_registration, null);
  assert.deepEqual(work.native.calls.map(call => call.method), ["get", "register"]);
  assert.equal(work.writes.find(state => state.pending_registration?.request_started)?.pending_registration.phase, "unknown");
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 4096);
  await work.controller.close();
});

test("unchanged synchronize queries only, status is detached, and binding tombstones are accepted", async () => {
  const work = fixture();
  await work.controller.start();
  const before = work.native.calls.length;
  assert.equal((await work.controller.synchronize(windowConfig.window_key)).status, "ready");
  assert.deepEqual(work.native.calls.slice(before).map(call => call.method), ["get"]);
  const state = work.controller.getStatus(windowConfig.window_key);
  state.provider_generation = 500;
  assert.equal(work.state().provider_generation, 1);
  work.binding = { ...work.binding, deleted: true, generation: 2 };
  assert.equal((await work.controller.synchronize(windowConfig.window_key)).status, "closed");
  await work.controller.close();
});

test("reload of unknown registration only queries original dedupe and accepts retained receipt", async () => {
  const work = fixture();
  work.native.hooks.register = (args, context, perform) => {
    perform();
    throw new CoreError("napcat_mcp_unconfirmed", "lost response", { request_sent: true });
  };
  await work.controller.start();
  const pending = work.state().pending_registration;
  assert.equal(pending.phase, "unknown");
  await work.controller.close();
  const replacement = work.create();
  const [state] = await replacement.start();
  assert.equal(state.status, "ready");
  assert.equal(state.pending_registration, null);
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  assert.equal(work.native.calls.at(-1).args.dedupe_key, pending.dedupe_key);
  await replacement.close();
});

test("unknown not yet accepted remains pending across reload and later receipt resolves same operation", async () => {
  const work = fixture();
  let original;
  work.native.hooks.register = (args, context) => {
    original = clone(args);
    context.onRequestStarted();
    throw new CoreError("napcat_mcp_unconfirmed", "not yet known", { request_sent: true });
  };
  await work.controller.start();
  await work.controller.close();
  const replacement = work.create();
  assert.equal((await replacement.start())[0].status, "pending");
  work.advance(5000);
  await replacement.poll();
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  assert.ok(work.native.calls.filter(call => call.method === "get" && call.args.dedupe_key)
    .every(call => call.args.dedupe_key === original.dedupe_key));
  work.native.applyRegister(original);
  work.advance(5000);
  assert.equal((await replacement.poll())[0].status, "ready");
  assert.equal(work.state().pending_registration, null);
  await replacement.close();
});

test("prepared intent after crash is queried rather than submitted", async () => {
  const work = fixture();
  work.native.hooks.register = (args, context) => { context.onRequestStarted(); throw new Error("lost"); };
  await work.controller.start();
  const pending = work.states.get(windowConfig.window_key).pending_registration;
  pending.request_started = false;
  pending.phase = "prepared";
  await work.controller.close();
  const replacement = work.create();
  await replacement.start();
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  assert.equal(work.native.calls.at(-1).method, "get");
  assert.equal(work.native.calls.at(-1).args.dedupe_key, pending.dedupe_key);
  await replacement.close();
});

test("unsent validation failure stays blocked during automatic poll and startup", async () => {
  const work = fixture();
  work.native.hooks.register = () => { throw new CoreError("napcat_mcp_unconfirmed", "local validation", { request_sent: false }); };
  await work.controller.start();
  assert.equal(work.state().status, "blocked");
  assert.equal(work.state().pending_registration.phase, "blocked");
  work.advance(60000);
  await work.controller.poll();
  await work.controller.start();
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  await work.controller.close();
});

test("existing non-window route cannot be adopted or overwritten", async () => {
  const native = new FakeNative();
  native.route = { window_capture: false, route_generation: 9, synthetic_quote: true };
  const before = clone(native.route);
  const work = fixture({ native });
  await work.controller.start();
  assert.deepEqual(native.route, before);
  assert.equal(native.calls.find(call => call.method === "register").args.expected_generation, 0);
  work.advance();
  await work.controller.poll();
  assert.equal(native.calls.filter(call => call.method === "register").length, 1);
  assert.equal(work.state().status, "blocked");
  await work.controller.close();
});

test("known route scope mismatch is blocked without a new CAS zero registration", async () => {
  const work = fixture();
  await work.controller.start();
  work.native.hooks.get = () => { throw providerError("SCOPE_MISMATCH"); };
  assert.equal((await work.controller.synchronize())[0].status, "blocked");
  assert.equal(work.state().provider_generation, 1);
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  await work.controller.close();
});

test("page cursor commits only after all durable callbacks, failures replay the page idempotently", async () => {
  const seen = new Set();
  const attempts = [];
  let fail = true;
  const work = fixture({ controller: { onEvent: async event => {
    attempts.push(event.event_id);
    if (event.text === "message-2" && fail) throw new Error("storage failure");
    seen.add(`${event.route_generation}:${event.event_id}`);
  } } });
  await work.controller.start();
  const first = work.native.append();
  const second = work.native.append();
  assert.equal((await work.controller.poll())[0].status, "pending");
  assert.equal(work.state().cursor, null);
  assert.equal(seen.size, 1);
  fail = false;
  work.advance(5000);
  assert.equal((await work.controller.poll())[0].status, "ready");
  assert.equal(work.state().cursor, "g1_s2");
  assert.deepEqual(attempts, [first.event_id, second.event_id, first.event_id, second.event_id]);
  assert.equal(seen.size, 2);
  assert.equal(JSON.stringify(work.state()).includes("message-1"), false);
  await work.controller.close();
});

test("explicit unpersisted callback response preserves cursor", async () => {
  const work = fixture({ controller: { onEvent: () => ({ persisted: false }) } });
  await work.controller.start();
  work.native.append();
  await work.controller.poll();
  assert.equal(work.state().cursor, null);
  assert.equal(work.state().last_error, "window_ingress_event_unpersisted");
  await work.controller.close();
});

test("read page rejection leaves original cursor and retries at bounded delay", async () => {
  const work = fixture();
  await work.controller.start();
  work.native.append();
  await work.controller.poll();
  const cursor = work.state().cursor;
  work.advance();
  work.native.append();
  work.native.hooks.read = () => { throw new CoreError("napcat_mcp_unconfirmed", "synthetic read failure", { request_sent: true }); };
  await work.controller.poll();
  assert.equal(work.state().cursor, cursor);
  const count = work.native.calls.length;
  await work.controller.poll();
  assert.equal(work.native.calls.length, count);
  delete work.native.hooks.read;
  work.advance(5000);
  await work.controller.poll();
  assert.equal(work.state().cursor, "g1_s2");
  await work.controller.close();
});

test("concurrent same-window polls coalesce to one native page and no duplicate callbacks", async () => {
  const work = fixture();
  await work.controller.start();
  work.native.append();
  const entered = deferred();
  const release = deferred();
  work.native.hooks.read = async (args, context, perform) => { entered.resolve(); await release.promise; return perform(); };
  const first = work.controller.poll(windowConfig.window_key);
  await entered.promise;
  const second = work.controller.poll(windowConfig.window_key);
  assert.equal(first, second);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(work.native.calls.filter(call => call.method === "read").length, 1);
  assert.equal(work.delivered.length, 1);
  await work.controller.close();
});

test("rebind drains old snapshot and replays retained history under new cursor generation without retargeting", async () => {
  const work = fixture();
  await work.controller.start();
  const old = work.native.append();
  work.binding = modelBinding(2, "synthetic-model-b");
  await work.controller.synchronize();
  assert.equal(work.delivered[0].event.window_binding.target.conversation_id, "synthetic-model-a");
  assert.equal(work.state().provider_generation, 2);
  assert.equal(work.state().cursor_generation, 1);
  const next = work.native.append();
  work.advance();
  await work.controller.poll();
  const call = work.native.calls.filter(call => call.method === "read").at(-1);
  assert.equal(call.args.expected_route_generation, 2);
  assert.equal(Object.hasOwn(call.args, "cursor"), false);
  const deliveries = work.delivered.map(({ event }) => [event.event_id, event.route_generation, event.window_binding.target.conversation_id]);
  assert.deepEqual(deliveries, [[old.event_id, 1, "synthetic-model-a"], [old.event_id, 1, "synthetic-model-a"], [next.event_id, 2, "synthetic-model-b"]]);
  assert.equal(work.state().cursor_generation, 2);
  assert.equal(work.state().cursor, "g2_s2");
  assert.ok(Object.isFrozen(work.delivered[0].event.window_binding.target));
  await work.controller.close();
});

test("rebind with multiple retained pages waits to drain all before registration", async () => {
  const work = fixture();
  await work.controller.start();
  for (let index = 0; index < 51; index += 1) work.native.append();
  work.binding = modelBinding(2, "synthetic-model-b");
  assert.equal((await work.controller.synchronize())[0].status, "pending");
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  assert.equal(work.delivered.length, 50);
  assert.equal((await work.controller.synchronize())[0].status, "ready");
  assert.equal(work.delivered.length, 51);
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 2);
  await work.controller.close();
});

test("remove during in-flight poll delivers frozen old event, then serialized synchronization closes route", async () => {
  const work = fixture();
  await work.controller.start();
  work.native.append();
  const entered = deferred();
  const release = deferred();
  work.native.hooks.read = async (args, context, perform) => { entered.resolve(); await release.promise; return perform(); };
  const polling = work.controller.poll();
  await entered.promise;
  work.binding = { ...work.binding, generation: 2, deleted: true };
  const removing = work.controller.synchronize();
  release.resolve();
  await Promise.all([polling, removing]);
  assert.equal(work.native.route.status, "closed");
  assert.equal(work.state().status, "closed");
  assert.equal(work.delivered[0].event.window_binding.target.conversation_id, "synthetic-model-a");
  assert.equal(work.native.calls.filter(call => call.method === "close").length, 1);
  await work.controller.close();
});

test("failed old event blocks removal and rebind, retaining native events", async () => {
  const work = fixture({ controller: { onEvent: () => { throw new Error("persist old event failed"); } } });
  await work.controller.start();
  work.native.append();
  work.binding = modelBinding(2, "synthetic-model-b");
  await work.controller.synchronize();
  assert.equal(work.native.route.window_binding.generation, 1);
  work.binding = { ...work.binding, generation: 3, deleted: true };
  await work.controller.synchronize();
  assert.equal(work.native.route.status, "open");
  assert.equal(work.native.events.length, 1);
  assert.equal(work.native.calls.filter(call => call.method === "close").length, 0);
  await work.controller.close();
});

test("unknown close is queried once per cycle, never reissued, and confirmed closed only after native receipt", async () => {
  const work = fixture();
  await work.controller.start();
  work.binding = null;
  work.native.hooks.close = (args, context) => { context.onRequestStarted(); throw new CoreError("napcat_mcp_unconfirmed", "lost close", { request_sent: true }); };
  await work.controller.synchronize();
  assert.equal(work.state().status, "pending");
  assert.ok(work.state().pending_close);
  await work.controller.close();
  const replacement = work.create();
  await replacement.start();
  assert.equal(work.state().status, "pending");
  assert.equal(work.native.calls.filter(call => call.method === "close").length, 1);
  work.native.route.status = "closed";
  work.native.route.route_generation += 1;
  work.advance(5000);
  await replacement.poll();
  assert.equal(work.state().status, "closed");
  assert.equal(work.state().pending_close, null);
  await replacement.close();
});

test("closed unknown registration receipt resolves without reopening by old dedupe", async () => {
  const work = fixture();
  work.native.hooks.register = (args, context, perform) => { perform(); throw new CoreError("napcat_mcp_unconfirmed", "lost", { request_sent: true }); };
  await work.controller.start();
  work.binding = null;
  work.native.route.status = "closed";
  work.native.route.route_generation += 1;
  await work.controller.synchronize();
  assert.equal(work.state().status, "closed");
  assert.equal(work.state().pending_registration, null);
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  await work.controller.close();
});

test("cursor expiry is sticky explicit gap and preserves original anchor across reload", async () => {
  const work = fixture();
  await work.controller.start();
  work.native.append();
  await work.controller.poll();
  const cursor = work.state().cursor;
  work.native.evicted = 1;
  work.native.events = [];
  work.advance();
  await work.controller.poll();
  assert.equal(work.state().status, "gap");
  assert.equal(work.state().gap.code, "OWNER_WINDOW_CURSOR_EXPIRED");
  assert.equal(work.state().cursor, cursor);
  await work.controller.close();
  const replacement = work.create();
  const before = work.native.calls.length;
  await replacement.start();
  assert.equal(work.native.calls.length, before);
  assert.equal(work.state().cursor, cursor);
  await replacement.close();
});

test("generation refresh replays retained page, history gap preserves old-generation cursor", async () => {
  const work = fixture();
  await work.controller.start();
  work.native.append();
  await work.controller.poll();
  work.native.route.route_generation += 1;
  work.native.evicted = 1;
  work.native.events = [];
  work.advance();
  await work.controller.poll();
  assert.equal(work.state().status, "gap");
  assert.equal(work.state().gap.code, "OWNER_WINDOW_HISTORY_EXPIRED");
  assert.equal(work.state().cursor, "g1_s1");
  assert.equal(work.state().cursor_generation, 1);
  assert.equal(work.state().provider_generation, 2);
  const last = work.native.calls.at(-1);
  assert.equal(last.args.expected_route_generation, 2);
  assert.equal(Object.hasOwn(last.args, "cursor"), false);
  await work.controller.close();
});

test("malformed page never advances cursor or delivers a foreign route event", async () => {
  const work = fixture();
  await work.controller.start();
  work.native.append({ route_key: "foreign-route" });
  await work.controller.poll();
  assert.equal(work.state().status, "blocked");
  assert.equal(work.state().cursor, null);
  assert.equal(work.delivered.length, 0);
  await work.controller.close();
});

test("persistence failure before dispatch prevents registration and does not overwrite shared binding", async () => {
  const work = fixture();
  work.failWrite(state => { if (state.pending_registration) throw new Error("fsync failed"); });
  await assert.rejects(work.controller.start(), { code: "window_ingress_persistence_failed" });
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 0);
  assert.equal(work.binding.target.conversation_id, "synthetic-model-a");
  await work.controller.close();
});

test("persistence failure while confirming response retains pending original key for reload", async () => {
  const work = fixture();
  work.failWrite(state => { if (!state.pending_registration && state.provider_generation > 0) throw new Error("fsync confirmation failed"); });
  await assert.rejects(work.controller.start(), { code: "window_ingress_persistence_failed" });
  assert.equal(work.state().pending_registration.phase, "unknown");
  const key = work.state().pending_registration.dedupe_key;
  work.failWrite(undefined);
  await work.controller.close();
  const replacement = work.create();
  assert.equal((await replacement.start())[0].status, "ready");
  assert.equal(work.native.calls.at(-1).args.dedupe_key, key);
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  await replacement.close();
});

test("cursor persistence failure replays already durable callbacks instead of losing page", async () => {
  const work = fixture();
  await work.controller.start();
  work.native.append();
  work.failWrite(state => { if (state.cursor) throw new Error("cursor fsync failed"); });
  await assert.rejects(work.controller.poll(), { code: "window_ingress_persistence_failed" });
  assert.equal(work.state().cursor, null);
  assert.equal(work.delivered.length, 1);
  work.failWrite(undefined);
  await work.controller.poll();
  assert.equal(work.delivered.length, 2);
  assert.equal(work.delivered[0].event.event_id, work.delivered[1].event.event_id);
  assert.equal(work.state().cursor, "g1_s1");
  await work.controller.close();
});

test("close aborts owned request signal, waits for native cleanup, and never closes borrowed transport", async () => {
  const work = fixture();
  await work.controller.start();
  const entered = deferred();
  const cleanup = deferred();
  let aborted = false;
  let released = false;
  work.native.hooks.read = (args, context) => new Promise((resolve, reject) => {
    context.signal.addEventListener("abort", async () => {
      aborted = true;
      await cleanup.promise;
      released = true;
      reject(new CoreError("napcat_mcp_unconfirmed", "aborted", { request_sent: true }));
    }, { once: true });
    entered.resolve();
  });
  const polling = work.controller.poll();
  await entered.promise;
  let closed = false;
  const closing = work.controller.close().then(() => { closed = true; });
  await nextTurn();
  assert.equal(aborted, true);
  assert.equal(closed, false);
  assert.equal(released, false);
  cleanup.resolve();
  await Promise.all([polling, closing]);
  assert.equal(released, true);
  assert.equal(work.native.closeCalls, 0);
  const before = work.native.calls.length;
  assert.equal((await work.controller.poll())[0].status, "stopped");
  assert.equal(work.native.calls.length, before);
});

test("local close during callback waits, stops remaining events, and leaves whole-page cursor for replay", async () => {
  const entered = deferred();
  const release = deferred();
  const seen = [];
  const work = fixture({ controller: { onEvent: async event => { seen.push(event.event_id); entered.resolve(); await release.promise; } } });
  await work.controller.start();
  work.native.append();
  work.native.append();
  const polling = work.controller.poll();
  await entered.promise;
  const closing = work.controller.close();
  release.resolve();
  await Promise.all([polling, closing]);
  assert.equal(seen.length, 1);
  assert.equal(work.state().cursor, null);
  assert.equal(work.native.closeCalls, 0);
});

test("short native timeout aborts resource and leaves registration outcome unknown", async () => {
  const work = fixture({ controller: { requestTimeoutMs: 10 } });
  let aborted = false;
  work.native.hooks.register = (args, context) => {
    context.onRequestStarted();
    return new Promise((resolve, reject) => context.signal.addEventListener("abort", () => {
      aborted = true;
      reject(new CoreError("napcat_mcp_unconfirmed", "timeout", { request_sent: true }));
    }, { once: true }));
  };
  await work.controller.start();
  assert.equal(aborted, true);
  assert.equal(work.state().pending_registration.phase, "unknown");
  assert.equal(work.state().status, "pending");
  await work.controller.close();
});

test("malformed registration acknowledgement remains pending until original receipt is queried", async () => {
  const work = fixture();
  work.native.hooks.register = (args, context, perform) => {
    const result = perform();
    result.registration.dedupe_key = "wrong-key";
    return result;
  };
  await work.controller.start();
  const key = work.state().pending_registration.dedupe_key;
  assert.equal(work.state().status, "pending");
  await work.controller.synchronize();
  assert.equal(work.state().status, "ready");
  assert.equal(work.native.calls.at(-1).args.dedupe_key, key);
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  await work.controller.close();
});

test("missing retained registration receipt does not authorize adoption or a new mapping registration", async () => {
  const work = fixture();
  work.native.hooks.register = (args, context, perform) => { perform(); throw new Error("unknown reply"); };
  await work.controller.start();
  const originalKey = work.state().pending_registration.dedupe_key;
  work.native.receipts.clear();
  work.binding = modelBinding(2, "synthetic-model-b");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    work.advance();
    await work.controller.poll();
  }
  assert.equal(work.state().status, "pending");
  assert.equal(work.state().pending_registration.dedupe_key, originalKey);
  assert.equal(work.native.route.window_binding.target.conversation_id, "synthetic-model-a");
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  assert.equal(work.native.calls.filter(call => call.method === "read").length, 0);
  await work.controller.close();
});

test("duplicate native event IDs are handed to durable dedupe without replacing original route generation", async () => {
  const durable = new Set();
  const attempts = [];
  const work = fixture({ controller: { onEvent: event => { attempts.push(event); durable.add(`${event.route_generation}:${event.event_id}`); } } });
  await work.controller.start();
  const original = work.native.append();
  await work.controller.poll();
  work.native.append({ event_id: original.event_id });
  work.advance();
  await work.controller.poll();
  assert.equal(attempts.length, 2);
  assert.equal(durable.size, 1);
  assert.equal(work.state().cursor, "g1_s2");
  assert.ok(attempts.every(event => event.route_generation === 1 && event.event_id === original.event_id));
  await work.controller.close();
});

test("generation change during read retains cursor then refreshes current generation for replay", async () => {
  const work = fixture();
  await work.controller.start();
  const original = work.native.append();
  await work.controller.poll();
  work.advance();
  work.native.hooks.read = () => {
    work.native.route.route_generation += 1;
    delete work.native.hooks.read;
    throw providerError("GENERATION_MISMATCH");
  };
  await work.controller.poll();
  assert.equal(work.state().status, "pending");
  assert.equal(work.state().cursor, "g1_s1");
  work.advance(5000);
  await work.controller.poll();
  assert.equal(work.state().cursor, "g2_s1");
  assert.equal(work.delivered.length, 2);
  assert.equal(work.delivered[1].event.event_id, original.event_id);
  assert.equal(work.delivered[1].event.route_generation, 1);
  await work.controller.close();
});

test("older model binding cannot overwrite a newer native mapping", async () => {
  const work = fixture();
  await work.controller.start();
  work.native.route.route_generation = 5;
  work.native.route.window_binding = nativeBinding(modelBinding(4, "synthetic-newer-model"));
  await work.controller.synchronize();
  assert.equal(work.state().status, "blocked");
  assert.equal(work.state().last_error, "window_ingress_mapping_conflict");
  assert.equal(work.native.route.window_binding.generation, 4);
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  await work.controller.close();
});

test("unsent close is blocked and never reported as confirmed closed", async () => {
  const work = fixture();
  await work.controller.start();
  work.binding = null;
  work.native.hooks.close = () => { throw new CoreError("napcat_mcp_unconfirmed", "local rejection", { request_sent: false }); };
  await work.controller.synchronize();
  assert.equal(work.state().status, "blocked");
  assert.equal(work.state().pending_close.phase, "blocked");
  assert.equal(work.native.route.status, "open");
  work.advance();
  await work.controller.poll();
  assert.equal(work.native.calls.filter(call => call.method === "close").length, 1);
  await work.controller.close();
});

test("local shutdown during registration ignores late response and preserves recoverable unknown intent", async () => {
  const work = fixture();
  const entered = deferred();
  const release = deferred();
  work.native.hooks.register = async (args, context) => {
    context.onRequestStarted();
    entered.resolve();
    await release.promise;
    return work.native.applyRegister(args);
  };
  const starting = work.controller.start();
  await entered.promise;
  let closed = false;
  const closing = work.controller.close().then(() => { closed = true; });
  await nextTurn();
  assert.equal(closed, false);
  release.resolve();
  await Promise.all([starting, closing]);
  assert.equal(work.state().pending_registration.phase, "unknown");
  assert.equal(work.state().provider_generation, 0);
  const replacement = work.create();
  assert.equal((await replacement.start())[0].status, "ready");
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  assert.equal(work.native.closeCalls, 0);
  await replacement.close();
});

test("request-start persistence failure leaves prepared intent and prevents native mutation", async () => {
  const work = fixture();
  work.failWrite(state => { if (state.pending_registration?.request_started) throw new Error("fsync marker failed"); });
  await assert.rejects(work.controller.start(), { code: "window_ingress_persistence_failed" });
  assert.equal(work.native.route, null);
  assert.equal(work.state().pending_registration.phase, "prepared");
  work.failWrite(undefined);
  await work.controller.close();
  const replacement = work.create();
  await replacement.start();
  assert.equal(work.state().status, "pending");
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  await replacement.close();
});

test("structured provider errors preserve gap classification without a tail reset", async () => {
  const work = fixture();
  await work.controller.start();
  work.native.append();
  await work.controller.poll();
  work.advance();
  work.native.hooks.read = () => ({ ok: false, code: "OWNER_WINDOW_CURSOR_EXPIRED", outcomeUnknown: false, details: { evicted_through: 1 } });
  await work.controller.poll();
  assert.equal(work.state().status, "gap");
  assert.equal(work.state().cursor, "g1_s1");
  assert.equal(work.state().gap.code, "OWNER_WINDOW_CURSOR_EXPIRED");
  await work.controller.close();
});

test("startup connection failure retries reads with backoff before any registration", async () => {
  const work = fixture();
  work.native.hooks.get = () => { throw new CoreError("napcat_mcp_unconfirmed", "connect unavailable", { request_sent: false }); };
  await work.controller.start();
  assert.equal(work.state().status, "pending");
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 0);
  delete work.native.hooks.get;
  const before = work.native.calls.length;
  await work.controller.poll();
  assert.equal(work.native.calls.length, before);
  work.advance(5000);
  await work.controller.poll();
  assert.equal(work.state().status, "ready");
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  await work.controller.close();
});

test("same-version transport preserves native errors through SDK-shaped JSON without real network", async () => {
  const native = new FakeNative();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  let clientCloses = 0;
  const methodByTool = { napcat_owner_window_route_register: "registerOwnerWindowRoute", napcat_owner_window_route_get: "getOwnerWindowRoute",
    napcat_owner_window_route_close: "closeOwnerWindowRoute", napcat_owner_window_events_read: "readOwnerWindowEvents" };
  const transport = new NapcatMcpTransport({ baseUrl: "http://127.0.0.1:14588/napcat/mcp", conversationId: windowConfig.conversation_id,
    clientFactory: () => ({ connect: async () => {}, close: async () => { clientCloses += 1; },
      async callTool(request, schema, options) {
        try {
          const result = await native[methodByTool[request.name]](request.arguments, {
            conversationId: windowConfig.conversation_id, targetKey: windowConfig.target_key, signal: options.signal,
          });
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, code: error.code, message: "synthetic provider",
            outcomeUnknown: false, details: error.details }) }] };
        }
      } }) });
  let transportCloses = 0;
  const closeTransport = transport.close.bind(transport);
  transport.close = () => { transportCloses += 1; return closeTransport(); };
  const work = fixture({ native: transport });
  globalThis.fetch = async () => { fetches += 1; throw new Error("real network forbidden by test fixture"); };
  try {
    assert.equal((await work.controller.start())[0].status, "ready");
    native.append();
    await work.controller.poll();
    assert.equal(work.delivered.length, 1);
    assert.equal(work.state().cursor, "g1_s1");
    native.evicted = 1;
    native.events = [];
    work.advance();
    await work.controller.poll();
    assert.equal(work.state().status, "gap");
    assert.equal(work.state().gap.code, "OWNER_WINDOW_CURSOR_EXPIRED");
    assert.equal(work.state().cursor, "g1_s1");
    await work.controller.close();
    assert.equal(transportCloses, 0);
  } finally {
    await work.controller.close();
    await transport.close();
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 0);
  assert.equal(transportCloses, 1);
  assert.ok(clientCloses >= 1);
});

test("actual SQLite callbacks preserve unknown intent and durable cursor through close/reopen", async context => {
  const prefix = resolve(tmpdir(), "communication-core-window-ingress-");
  const directory = mkdtempSync(prefix);
  assert.ok(resolve(directory).startsWith(prefix));
  const filePath = join(directory, "窗口游标 重载.sqlite");
  const native = new FakeNative();
  let store = new MessageStore({ filePath });
  let now = 100000;
  const controllers = [];
  const received = new Set();
  let callbacks = 0;
  const create = () => {
    const controller = new WindowIngressController({ windows: [{ ...windowConfig, transport: native }],
      getBinding: () => modelBinding(), getState: key => store.getChannelIngressState(key),
      putState: (key, state) => store.putChannelIngressState(key, state), now: () => now,
      onEvent: event => { received.add(`${event.route_generation}:${event.event_id}`); callbacks += 1; } });
    controllers.push(controller);
    return controller;
  };
  context.after(async () => {
    await Promise.all(controllers.map(controller => controller.close()));
    store.close();
    assert.ok(resolve(directory).startsWith(prefix));
    rmSync(directory, { recursive: true, force: true });
    assert.equal(existsSync(directory), false);
  });
  native.hooks.register = (args, scope, perform) => { perform(); throw new CoreError("napcat_mcp_unconfirmed", "lost reply", { request_sent: true }); };
  const first = create();
  await first.start();
  const key = store.getChannelIngressState(windowConfig.window_key).pending_registration.dedupe_key;
  await first.close();
  store.close();
  store = new MessageStore({ filePath });
  assert.equal(store.getChannelIngressState(windowConfig.window_key).pending_registration.dedupe_key, key);
  const second = create();
  await second.start();
  assert.equal(store.getChannelIngressState(windowConfig.window_key).pending_registration, null);
  assert.equal(native.calls.filter(call => call.method === "register").length, 1);
  native.append();
  await second.poll();
  assert.equal(store.getChannelIngressState(windowConfig.window_key).cursor, "g1_s1");
  await second.close();
  store.close();
  store = new MessageStore({ filePath });
  const third = create();
  now += 30000;
  await third.start();
  await third.poll();
  assert.equal(native.calls.at(-1).args.cursor, "g1_s1");
  assert.equal(callbacks, 1);
  assert.equal(received.size, 1);
  native.evicted = 1;
  native.events = [];
  now += 30000;
  await third.poll();
  assert.equal(store.getChannelIngressState(windowConfig.window_key).status, "gap");
  assert.equal(store.getChannelIngressState(windowConfig.window_key).cursor, "g1_s1");
});

test("empty incremental page cannot invent a new tail or clear the persisted cursor", async () => {
  for (const nextCursor of [null, "g1_s999"]) {
    const work = fixture();
    await work.controller.start();
    work.native.append();
    await work.controller.poll();
    work.advance();
    work.native.hooks.read = (args, context, perform) => ({ ...perform(), next_cursor: nextCursor });
    await work.controller.poll();
    assert.equal(work.state().status, "blocked");
    assert.equal(work.state().last_error, "window_ingress_page_invalid");
    assert.equal(work.state().cursor, "g1_s1");
    assert.equal(work.delivered.length, 1);
    await work.controller.close();
  }
});

test("released-window claim waits for unknown original close, then preserves late captured old-owner events", async () => {
  const work = fixture();
  await work.controller.start();
  work.native.append();
  work.binding = { ...work.binding, deleted: true, generation: 2 };
  let lateEvent;
  work.native.hooks.close = (args, scope) => {
    scope.onRequestStarted();
    lateEvent = work.native.append();
    throw new CoreError("napcat_mcp_unconfirmed", "original close still unknown", { request_sent: true });
  };
  await work.controller.synchronize();
  const originalClose = clone(work.state().pending_close);
  work.binding = modelBinding(3, "synthetic-new-claimant");
  await work.controller.synchronize();
  assert.equal(work.state().status, "pending");
  assert.equal(work.state().pending_close.expected_generation, originalClose.expected_generation);
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  assert.equal(work.native.route.window_binding.target.conversation_id, "synthetic-model-a");
  work.native.route = { ...work.native.route, status: "closed", route_generation: 2 };
  const before = work.native.calls.length;
  await work.controller.synchronize();
  assert.deepEqual(work.native.calls.slice(before).map(call => call.method), ["get", "register"]);
  assert.equal(work.native.calls.at(-1).args.expected_generation, 2);
  assert.equal(work.state().confirmed_mapping_generation, 3);
  assert.equal(work.native.calls.filter(call => call.method === "close").length, 1);
  await work.controller.poll();
  assert.ok(work.delivered.some(({ event }) => event.event_id === lateEvent.event_id));
  assert.ok(work.delivered.every(({ event }) => event.window_binding.target.conversation_id === "synthetic-model-a" && event.route_generation === 1));
  assert.equal(work.native.route.window_binding.target.conversation_id, "synthetic-new-claimant");
  await work.controller.close();
});

test("new claimant mapping follows original unknown registration receipt and never retargets captured old events", async () => {
  const work = fixture();
  work.native.hooks.register = (args, scope, perform) => {
    const result = perform();
    if (args.expected_generation === 0) throw new CoreError("napcat_mcp_unconfirmed", "first receipt delayed", { request_sent: true });
    return result;
  };
  await work.controller.start();
  const originalKey = work.state().pending_registration.dedupe_key;
  const oldEvent = work.native.append();
  work.binding = modelBinding(3, "synthetic-new-claimant");
  const before = work.native.calls.length;
  await work.controller.synchronize();
  const calls = work.native.calls.slice(before);
  assert.deepEqual(calls.map(call => call.method), ["get", "read", "register"]);
  assert.equal(calls[0].args.dedupe_key, originalKey);
  assert.notEqual(calls[2].args.dedupe_key, originalKey);
  assert.equal(calls[2].args.expected_generation, 1);
  assert.equal(work.state().confirmed_mapping_generation, 3);
  await work.controller.poll();
  assert.ok(work.delivered.filter(({ event }) => event.event_id === oldEvent.event_id).length >= 2);
  assert.ok(work.delivered.every(({ event }) => event.window_binding.target.conversation_id === "synthetic-model-a" && event.route_generation === 1));
  assert.equal(work.native.route.window_binding.target.conversation_id, "synthetic-new-claimant");
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 2);
  await work.controller.close();
});

test("explicit synchronize retries one known-unsent registration per call while poll and startup never retry it", async () => {
  const work = fixture();
  work.native.hooks.register = () => { throw new CoreError("napcat_mcp_unconfirmed", "backend not started", { request_sent: false }); };
  await work.controller.start();
  const originalKey = work.state().pending_registration.dedupe_key;
  assert.equal(work.state().blocked_retry_count, 0);
  await work.controller.synchronize();
  assert.equal(work.state().blocked_retry_count, 1);
  assert.equal(work.state().status, "blocked");
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 2);
  work.advance(60000);
  await work.controller.poll();
  await work.controller.start();
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 2);
  delete work.native.hooks.register;
  await work.controller.synchronize();
  assert.equal(work.state().status, "ready");
  assert.equal(work.state().blocked_retry_count, 2);
  assert.equal(work.state().last_blocked_retry_at, work.now);
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 3);
  assert.ok(work.native.calls.filter(call => call.method === "register").every(call => call.args.dedupe_key === originalKey));
  await work.controller.close();
});

test("same-owner new mapping can explicitly recover a registration that was never started", async () => {
  const work = fixture();
  work.native.hooks.register = () => { throw new CoreError("napcat_mcp_unconfirmed", "backend unavailable", { request_sent: false }); };
  await work.controller.start();
  delete work.native.hooks.register;
  work.binding = modelBinding(2, "synthetic-model-a");
  await work.controller.synchronize(windowConfig.window_key);
  assert.equal(work.state().status, "ready");
  assert.equal(work.state().confirmed_mapping_generation, 2);
  assert.equal(work.state().blocked_retry_count, 1);
  assert.equal(work.native.route.window_binding.owner_key, work.binding.owner_key);
  assert.equal(work.native.route.window_binding.generation, 2);
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 2);
  await work.controller.close();
});

test("explicit native rejection can recover after backend repair without requiring database edits", async () => {
  const work = fixture();
  work.native.hooks.register = (args, context) => { context.onRequestStarted(); throw providerError("TRUST_UNAVAILABLE"); };
  await work.controller.start();
  assert.equal(work.state().pending_registration.phase, "blocked");
  assert.equal(work.state().pending_registration.request_started, true);
  delete work.native.hooks.register;
  await work.controller.start();
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  await work.controller.synchronize();
  assert.equal(work.state().status, "ready");
  assert.equal(work.state().blocked_retry_count, 1);
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 2);
  await work.controller.close();
});

test("unknown registration never creates a new POST even after backend repair and explicit new mapping", async () => {
  const work = fixture();
  work.native.hooks.register = (args, context) => { context.onRequestStarted(); throw new CoreError("napcat_mcp_unconfirmed", "unknown acceptance", { request_sent: true }); };
  await work.controller.start();
  const original = clone(work.state().pending_registration);
  delete work.native.hooks.register;
  work.binding = modelBinding(2, "synthetic-model-a");
  for (let retry = 0; retry < 3; retry += 1) await work.controller.synchronize(windowConfig.window_key);
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 1);
  assert.deepEqual(work.state().pending_registration, original);
  assert.equal(work.state().blocked_retry_count, 0);
  assert.ok(work.native.calls.filter(call => call.method === "get" && call.args.dedupe_key)
    .every(call => call.args.dedupe_key === original.dedupe_key));
  await work.controller.close();
});

test("remove explicitly recovers known-unsent close and preserves already captured events", async () => {
  const work = fixture();
  await work.controller.start();
  const oldEvent = work.native.append();
  work.binding = { ...work.binding, deleted: true, generation: 2 };
  work.native.hooks.close = () => { throw new CoreError("napcat_mcp_unconfirmed", "close not started", { request_sent: false }); };
  await work.controller.synchronize();
  assert.equal(work.state().pending_close.phase, "blocked");
  delete work.native.hooks.close;
  await work.controller.start();
  work.advance(60000);
  await work.controller.poll();
  assert.equal(work.native.calls.filter(call => call.method === "close").length, 1);
  await work.controller.synchronize();
  assert.equal(work.state().status, "closed");
  assert.equal(work.state().blocked_retry_count, 1);
  assert.equal(work.native.calls.filter(call => call.method === "close").length, 2);
  assert.ok(work.delivered.some(({ event }) => event.event_id === oldEvent.event_id));
  await work.controller.close();
});

test("remove cancels only a known-rejected rebind and closes the old route without registering the rejected target", async () => {
  const work = fixture();
  await work.controller.start();
  work.binding = modelBinding(2, "synthetic-model-b");
  work.native.hooks.register = () => { throw new CoreError("napcat_mcp_unconfirmed", "rebind unsent", { request_sent: false }); };
  await work.controller.synchronize();
  assert.equal(work.state().pending_registration.phase, "blocked");
  const lateOld = work.native.append();
  work.binding = { ...work.binding, deleted: true, generation: 3 };
  delete work.native.hooks.register;
  await work.controller.synchronize();
  assert.equal(work.state().status, "closed");
  assert.equal(work.native.calls.filter(call => call.method === "register").length, 2);
  assert.equal(work.native.calls.filter(call => call.method === "close").length, 1);
  assert.ok(work.delivered.some(({ event }) => event.event_id === lateOld.event_id && event.window_binding.target.conversation_id === "synthetic-model-a"));
  await work.controller.close();
});
