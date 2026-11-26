import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCodexCommunicationControl } from "../src/codex-communication-control.mjs";
import { humanSourceFrom } from "../src/codex-communication-origin.mjs";
import { createCodexCommunicationTransport } from "../src/codex-communication-transport.mjs";
import { createWakeVisibilityAdapter } from "../src/wake-visibility.mjs";
import { createCodexDisplayPolicyManager } from "../src/codex-display-policy.mjs";

const TOKEN = "synthetic-window-test-secret";
const TARGET = { machine_id: "synthetic-local", host: "codex", surface: "desktop", conversation_id: "synthetic-model" };
const RELAY = { host: "codex", conversation_id: "synthetic-core" };
const ORIGINS = [{ ...RELAY, owner_reply_channels: ["napcat_owner_window"] }];

function input() {
  const text = "  本人普通窗口原文\r\n[CQ:at,qq=90002]\t\u0000 ";
  const eventId = "a1".repeat(32);
  return {
    delivery_id: "window-delivery", message_id: "window-core-message", binding_generation: 7,
    origin: { kind: "human_message", channel: "napcat_owner_window", source_ref: `owner-window-event:${eventId}` },
    relay: { ...RELAY }, target: { ...TARGET },
    window_source: {
      provider: "napcat_owner_window",
      route: { route_key: "window-route", conversation_id: RELAY.conversation_id, target_key: "owner-private", generation: 2 },
      window: { channel: "qq", type: "private", id: "90001", self_id: "90002" },
      window_binding: { generation: 3, owner_key: JSON.stringify(Object.values(TARGET)),
        target: { ...TARGET, binding_id: "synthetic-model-binding", binding_generation: 7 } },
      owner_sender_allowlist: ["90001"],
      event: { event_id: eventId, message_id: "-90003", message_seq: 0, sender_id: "90001", text, content: text },
    },
    text, delivery_policy: "next_model_boundary",
  };
}

function accepted(payload, overrides = {}) {
  return { outcome: "accepted", request_sent: true, injection_method: "turn/steer",
    thread_id: payload.target.conversation_id, turn_id: "synthetic-active-turn", ...overrides };
}

async function fixture(context, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-window-source-"));
  const ledgerPath = path.join(root, "ledger.json");
  const calls = [];
  const instances = [];
  const settings = {
    host: "127.0.0.1", port: 0, token: TOKEN, principalId: "synthetic-principal", allowedOrigins: ORIGINS,
    allowedTargets: [{ scope: "host", machine_id: TARGET.machine_id, host: TARGET.host,
      surface: TARGET.surface, binding_generation: 7 }], ledgerPath,
    transport: { async inspectAndDispatch(payload, hooks) {
      calls.push(structuredClone(payload));
      await hooks.beforeMutation({ injection_method: "turn/steer", turn_id: "synthetic-active-turn" });
      return accepted(payload);
    } }, ...overrides,
  };
  function create(changes = {}) {
    const control = createCodexCommunicationControl({ ...settings, ...changes });
    instances.push(control);
    return control;
  }
  context.after(async () => {
    for (const instance of instances) await instance.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const control = create();
  const address = await control.start();
  function request(method, pathname, value, destination = address) {
    return new Promise((resolve, reject) => {
      const connection = http.request({ host: destination.host, port: destination.port, method, path: pathname,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, agent: false }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        response.on("error", reject);
      });
      connection.on("error", reject);
      connection.end(value === undefined ? undefined : JSON.stringify(value));
    });
  }
  function queryPath(value = input(), changes = {}) {
    const source = value.relay ?? value.origin;
    const query = new URLSearchParams({ source_host: source.host, source_conversation_id: source.conversation_id,
      target_host: value.target.host, target_machine_id: value.target.machine_id, target_surface: value.target.surface,
      target_conversation_id: value.target.conversation_id, binding_generation: String(value.binding_generation), ...changes });
    return `/v1/communication/deliveries/${value.delivery_id}?${query}`;
  }
  return { root, ledgerPath, calls, control, create, settings, request, queryPath,
    post: (value = input(), destination) => request("POST", "/v1/communication/deliveries", value, destination),
    get: (value = input(), changes, destination) => request("GET", queryPath(value, changes), undefined, destination) };
}

test("window accepted source stays human, exact, hidden by default and durable with independent generations", async context => {
  const state = await fixture(context);
  const value = input();
  const original = structuredClone(value);
  const reply = await state.post(value);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.delivery.outcome, "accepted");
  assert.equal(reply.body.delivery.message_visibility, "hidden");
  for (const field of ["origin", "relay", "target", "text", "window_source"]) assert.deepEqual(reply.body.delivery[field], value[field]);
  for (const field of ["forward_of", "in_reply_to", "wake_id", "attachment_refs"]) assert.equal(Object.hasOwn(reply.body.delivery, field), false);
  assert.deepEqual(state.calls[0].target, { host: TARGET.host, conversation_id: TARGET.conversation_id });
  assert.deepEqual(state.calls[0].window_source, value.window_source);
  assert.deepEqual(value, original);
  const saved = fs.readFileSync(state.ledgerPath);
  const reordered = structuredClone(value);
  reordered.window_source = Object.fromEntries(Object.entries(reordered.window_source).reverse());
  reordered.window_source.window_binding.target = Object.fromEntries(Object.entries(reordered.window_source.window_binding.target).reverse());
  reordered.window_source.event = Object.fromEntries(Object.entries(reordered.window_source.event).reverse());
  reordered.message_visibility = "hidden";
  assert.equal((await state.post(reordered)).body.delivery.attempt_count, 1);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), saved);
  await state.control.close();
  const reopened = state.create({ allowedOrigins: [] });
  const address = await reopened.start();
  assert.equal((await state.get(value, {}, address)).status, 200);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), saved);
  assert.equal((await state.post(value, address)).status, 403);
  assert.equal(state.calls.length, 1);
});

test("window invalid source fields and fabricated reply provenance fail before ledger or native calls", async context => {
  const state = await fixture(context, { maxBodyBytes: 2 * 1024 * 1024 });
  const changes = [
    value => { value.attachment_refs = []; },
    value => { value.in_reply_to = "invented-notification"; },
    value => { value.forward_of = {}; },
    value => { value.wake_id = "invented-wake"; },
    value => { value.quoted_message_id = "90003"; },
    value => { value.original_qq_message_id = "90003"; },
    value => { value.origin = { kind: "agent", host: RELAY.host, conversation_id: RELAY.conversation_id }; },
    value => { value.origin.channel = "napcat_owner_reply"; },
    value => { value.origin.source_ref = `owner-event:${value.window_source.event.event_id}`; },
    value => { value.origin.source_ref += "a"; },
    value => { value.origin.extra = true; },
    value => { value.relay.host = "antigravity"; },
    value => { value.relay.extra = true; },
    value => { value.window_source.provider = "napcat_owner"; },
    value => { value.window_source.extra = true; },
    value => { value.window_source.route.conversation_id = "different-core"; },
    value => { value.window_source.route.generation = 0; },
    value => { value.window_source.route.generation = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.window_source.route.route_key = " leading"; },
    value => { value.window_source.route.route_key = "r".repeat(257); },
    value => { value.window_source.route.target_key = ""; },
    value => { value.window_source.route.wake_id = "invented-wake"; },
    value => { value.window_source.window.channel = "wechat"; },
    value => { value.window_source.window.type = "channel"; },
    value => { value.window_source.window.id = "90004"; },
    value => { value.window_source.window.id = "-90001"; },
    value => { value.window_source.window.self_id = "0"; },
    value => { value.window_source.window.self_id = 90002; },
    value => { value.window_source.window.extra = true; },
    value => { value.window_source.window_binding.generation = 0; },
    value => { value.window_source.window_binding.owner_key = "[]"; },
    value => { value.window_source.window_binding.target.binding_generation = 8; },
    value => { value.window_source.window_binding.target.binding_id = ""; },
    value => { value.window_source.window_binding.target.machine_id = "different-machine"; },
    value => { value.window_source.window_binding.target.surface = "different-surface"; },
    value => { value.window_source.window_binding.target.conversation_id = "different-model"; },
    value => { value.window_source.window_binding.target.extra = true; },
    value => { delete value.target.machine_id; delete value.target.surface; },
    value => { delete value.target.surface; },
    value => { value.window_source.owner_sender_allowlist = []; },
    value => { value.window_source.owner_sender_allowlist = ["90004"]; },
    value => { value.window_source.owner_sender_allowlist = ["90001", "90001"]; },
    value => { value.window_source.owner_sender_allowlist = ["90001", "90004"]; },
    value => { value.window_source.event.event_id = "A".repeat(64); },
    value => { value.window_source.event.message_id = "0"; },
    value => { value.window_source.event.message_id = "1".repeat(21); },
    value => { value.window_source.event.sender_id = "090001"; },
    value => { value.window_source.event.message_seq = -1; },
    value => { value.window_source.event.message_seq = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.window_source.event.content += "changed"; },
    value => { value.window_source.event.text += "changed"; },
    value => { value.window_source.event.quoted_message_id = "90003"; },
    value => { value.window_source.event.text = value.window_source.event.content = value.text = "x".repeat(256 * 1024 + 1); },
  ];
  for (const [index, change] of changes.entries()) {
    const value = input();
    change(value);
    const response = await state.post(value);
    assert.equal(response.status, 400, `invalid fixture ${index}: ${change}`);
    assert.equal(response.body.error.code, "invalid_delivery");
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(state.ledgerPath)).deliveries, []);
  assert.equal(state.calls.length, 0);
  context.diagnostic(`malformed source fixtures: ${changes.length}`);
});

test("window capabilities stay channel-specific and require the exact stable Core relay", async context => {
  for (const allowedOrigins of [[], [{ ...RELAY }], [{ ...RELAY, owner_reply_channels: ["napcat_owner_reply"] }],
    [{ host: "codex", conversation_id: "different-core", owner_reply_channels: ["napcat_owner_window"] }],
    [{ scope: "host", machine_id: TARGET.machine_id, host: "codex", surface: "desktop" }]]) {
    const state = await fixture(context, { allowedOrigins });
    assert.equal((await state.post()).status, 403);
    assert.equal(state.calls.length, 0);
  }
  const state = await fixture(context);
  for (const owner_reply_channels of [["napcat_owner_window", "napcat_owner_window"], ["unknown"], ["napcat_owner_reply", "napcat_owner_window", "extra"]]) {
    assert.throws(() => state.create({ allowedOrigins: [{ ...RELAY, owner_reply_channels }] }), /invalid_allowed_origin/);
  }
  assert.throws(() => state.create({ allowedOrigins: [{ ...RELAY, host: "antigravity", owner_reply_channels: ["napcat_owner_window"] }] }), /invalid_allowed_origin/);
  const both = state.create({ allowedOrigins: [{ ...RELAY, owner_reply_channels: ["napcat_owner_reply", "napcat_owner_window"] }],
    ledgerPath: path.join(state.root, "both.json") });
  assert.equal((await state.post(input(), await both.start())).status, 200);
});

test("window source digest includes every frozen component and never changes opaque original text", async context => {
  const state = await fixture(context);
  assert.equal((await state.post()).status, 200);
  const changes = [
    value => { value.window_source.route.route_key = "another-route"; },
    value => { value.window_source.route.target_key = "another-private"; },
    value => { value.window_source.route.generation++; },
    value => { value.window_source.window_binding.generation++; },
    value => { value.window_source.window_binding.target.binding_id = "another-binding"; },
    value => { value.window_source.window.self_id = "90005"; },
    value => { value.window_source.event.message_id = "90006"; },
    value => { value.window_source.event.message_seq++; },
    value => { value.window_source.event.event_id = "b".repeat(64); value.origin.source_ref = `owner-window-event:${value.window_source.event.event_id}`; },
    value => { value.text = value.window_source.event.text = value.window_source.event.content = "changed original"; },
  ];
  const before = fs.readFileSync(state.ledgerPath);
  for (const change of changes) {
    const value = input();
    change(value);
    assert.equal((await state.post(value)).status, 409);
  }
  assert.equal(state.calls.length, 1);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), before);
});

test("window GET and replies use exact relay scope and all original target identity fields", async context => {
  let replyReads = 0;
  const state = await fixture(context);
  state.settings.transport.readCompletedReplies = async delivery => {
    replyReads++;
    assert.deepEqual(delivery.window_source, input().window_source);
    return { outcome: "available", replies: [], cursor: null };
  };
  await state.post();
  for (const change of [{ source_host: "antigravity" }, { source_conversation_id: "different-core" },
    { target_host: "antigravity" }, { target_machine_id: "different-machine" }, { target_surface: "different-surface" },
    { target_conversation_id: "different-model" }, { binding_generation: "8" }]) assert.equal((await state.get(input(), change)).status, 403);
  assert.equal((await state.get()).status, 200);
  const pathWithQuery = state.queryPath();
  const separator = pathWithQuery.indexOf("?");
  const replyPath = `${pathWithQuery.slice(0, separator)}/replies${pathWithQuery.slice(separator)}`;
  assert.equal((await state.request("GET", replyPath)).status, 200);
  assert.equal(replyReads, 1);
  assert.equal((await state.request("GET", `${pathWithQuery}&source_conversation_id=${RELAY.conversation_id}`)).status, 400);
  assert.equal((await state.request("GET", `${pathWithQuery}&source_machine_id=${TARGET.machine_id}&source_surface=desktop`)).status, 403);
  const legacy = new URLSearchParams({ source_host: RELAY.host, source_conversation_id: RELAY.conversation_id,
    target_conversation_id: TARGET.conversation_id, binding_generation: "7" });
  assert.equal((await state.request("GET", `/v1/communication/deliveries/window-delivery?${legacy}`)).status, 403);
});

test("window unknown retains original IDs and exact source through retry, new-ID refusal and reload", async context => {
  let dispatches = 0;
  const state = await fixture(context, { transport: { async inspectAndDispatch(payload, hooks) {
    dispatches++;
    await hooks.beforeMutation({ injection_method: "turn/steer", turn_id: "synthetic-active-turn" });
    throw new Error("synthetic lost response");
  } } });
  const first = await state.post();
  assert.equal(first.body.delivery.outcome, "unknown");
  assert.deepEqual(first.body.delivery.window_source, input().window_source);
  assert.equal((await state.post({ ...input(), retry_failed_before_send: true })).body.delivery.outcome, "unknown");
  assert.equal((await state.post({ ...input(), delivery_id: "new-window-delivery" })).body.error.code, "message_delivery_unknown");
  const before = fs.readFileSync(state.ledgerPath);
  await state.control.close();
  const reopened = state.create();
  const address = await reopened.start();
  assert.equal((await state.get(input(), {}, address)).body.delivery.outcome, "unknown");
  assert.equal((await state.post({ ...input(), retry_failed_before_send: true }, address)).body.delivery.attempt_count, 1);
  assert.equal(dispatches, 1);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), before);
});

test("window prepared and dispatching restart preserve frozen source and never replay", async context => {
  for (const status of ["prepared", "dispatching"]) await context.test(status, async child => {
    const state = await fixture(child);
    await state.post();
    await state.control.close();
    const document = JSON.parse(fs.readFileSync(state.ledgerPath));
    Object.assign(document.deliveries[0], { status, outcome: null, request_sent: null,
      evidence: { adapter_accepted: "unknown", model_observed: "unknown", ui_observed: "unknown", processing: "unknown" } });
    fs.writeFileSync(state.ledgerPath, JSON.stringify(document));
    const restarted = state.create();
    const address = await restarted.start();
    const reply = await state.get(input(), {}, address);
    assert.equal(reply.body.delivery.outcome, "unknown");
    assert.equal(reply.body.delivery.error.code, "restart_outcome_unknown");
    assert.deepEqual(reply.body.delivery.window_source, input().window_source);
    await state.post({ ...input(), retry_failed_before_send: true }, address);
    assert.equal(state.calls.length, 1);
  });
});

test("window corrupted persisted source fails closed even if its digest is recomputed", async context => {
  const state = await fixture(context);
  await state.post();
  await state.control.close();
  const document = JSON.parse(fs.readFileSync(state.ledgerPath));
  document.deliveries[0].window_source.event.content = "tampered";
  const keys = ["delivery_id", "message_id", "binding_generation", "origin", "target", "text", "delivery_policy", "message_visibility", "relay", "window_source"];
  document.deliveries[0].digest = createHash("sha256").update(JSON.stringify(Object.fromEntries(keys.map(key => [key, document.deliveries[0][key]])))).digest("hex");
  fs.writeFileSync(state.ledgerPath, JSON.stringify(document));
  await assert.rejects(state.create({ allowedOrigins: [] }).start(), /ledger_invalid/);
});

function nativeFixture(mode, inject) {
  const client = {};
  const calls = [];
  const turnId = "synthetic-active-turn";
  const proxy = {
    wakeVisibility: createWakeVisibilityAdapter(), displayPolicy: createCodexDisplayPolicyManager(),
    _liveReadyClients: () => [client], _liveMaintenanceStatus: () => ({ active: false }),
    async subscribeThread(threadId) {
      return { threadId, readyClients: [client], results: [{ thread: { id: threadId,
        status: mode === "busy" ? "active" : "idle", turns: mode === "busy" ? [{ id: turnId, status: "inProgress" }] : [] } }] };
    },
    async _liveInjectRequest(actualClient, method, params, options) {
      assert.equal(actualClient, client);
      calls.push({ method, params, options });
      if (inject) return inject(calls.length);
      return { turn: { id: turnId, status: "inProgress" } };
    },
  };
  client.wakeVisibility = proxy.wakeVisibility.createView();
  client.displayPolicy = proxy.displayPolicy.createView();
  return { calls, proxy, client, transport: createCodexCommunicationTransport(proxy) };
}

test("window native hidden and visible deliveries retain ordinary idle start and mid-turn steer exactly once", async context => {
  for (const mode of ["idle", "busy"]) for (const visibility of ["hidden", "visible"]) await context.test(`${mode}-${visibility}`, async child => {
    const native = nativeFixture(mode);
    const state = await fixture(child, { transport: native.transport });
    const value = { ...input(), message_visibility: visibility };
    const response = await state.post(value);
    assert.equal(response.body.delivery.outcome, "accepted");
    assert.equal(response.body.delivery.injection_method, mode === "busy" ? "turn/steer" : "turn/start");
    assert.equal(native.calls.length, 1);
    const call = native.calls[0];
    assert.equal(call.params.expectedTurnId, mode === "busy" ? "synthetic-active-turn" : undefined);
    assert.equal(call.params.input[0].text, `【主人QQ回复，经可信交流核心转交】\n\n${value.text}\n\n消息 ID：${value.message_id}`);
    assert.equal((await state.post(value)).body.delivery.attempt_count, 1);
    assert.equal(native.calls.length, 1);
    await state.control.close();
    const reopened = state.create({ transport: nativeFixture(mode).transport });
    const address = await reopened.start();
    assert.deepEqual((await state.get(value, {}, address)).body.delivery.window_source, value.window_source);
  });
});

test("window group source uses captured owner allowlist and accepts provider numeric and sequence boundaries", async context => {
  const state = await fixture(context);
  const value = input();
  value.window_source.window.type = "group";
  value.window_source.window.id = "9".repeat(20);
  value.window_source.event.message_id = `-${"8".repeat(20)}`;
  value.window_source.event.message_seq = Number.MAX_SAFE_INTEGER;
  value.window_source.route.generation = Number.MAX_SAFE_INTEGER;
  value.window_source.window_binding.generation = Number.MAX_SAFE_INTEGER;
  assert.equal((await state.post(value)).body.delivery.outcome, "accepted");
  assert.deepEqual(humanSourceFrom(value).window_source, value.window_source);
  value.window_source.owner_sender_allowlist = ["90004"];
  assert.equal((await state.post(value)).status, 400);
});

test("window recoverable native maintenance failure resumes only with explicit original-ID retry", async context => {
  const native = nativeFixture("busy");
  native.proxy._liveMaintenanceStatus = () => ({ active: true });
  const state = await fixture(context, { transport: native.transport });
  const first = await state.post();
  assert.equal(first.body.delivery.outcome, "failed_before_send");
  assert.equal(first.body.delivery.request_sent, false);
  assert.equal(native.calls.length, 0);
  native.proxy._liveMaintenanceStatus = () => ({ active: false });
  assert.equal((await state.post()).body.delivery.outcome, "failed_before_send");
  assert.equal(native.calls.length, 0);
  const retry = await state.post({ ...input(), retry_failed_before_send: true });
  assert.equal(retry.body.delivery.outcome, "accepted");
  assert.equal(retry.body.delivery.attempt_count, 2);
  assert.deepEqual(retry.body.delivery.window_source, input().window_source);
  assert.equal(native.calls.length, 1);
});

test("window native lost receipt stays unknown and never duplicates the mutating call", async context => {
  const native = nativeFixture("busy", () => { throw Object.assign(new Error("synthetic receipt lost"), { outcomeUnknown: true }); });
  const state = await fixture(context, { transport: native.transport });
  const first = await state.post();
  assert.equal(first.body.delivery.outcome, "unknown");
  assert.equal(first.body.delivery.request_sent, null);
  assert.deepEqual(first.body.delivery.window_source, input().window_source);
  assert.equal((await state.post({ ...input(), retry_failed_before_send: true })).body.delivery.outcome, "unknown");
  assert.equal((await state.post({ ...input(), delivery_id: "different-window-delivery" })).body.error.code, "message_delivery_unknown");
  assert.equal(native.calls.length, 1);
  assert.equal((await state.get()).body.delivery.outcome, "unknown");
});

test("window concurrent duplicate HTTP submissions execute one native mutation", async context => {
  let notifyEntered;
  let release;
  const entered = new Promise(resolve => { notifyEntered = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  const native = nativeFixture("busy", async () => {
    notifyEntered();
    await released;
    return { turn: { id: "synthetic-active-turn", status: "inProgress" } };
  });
  const state = await fixture(context, { transport: native.transport });
  const first = state.post();
  await entered;
  const second = state.post();
  release();
  const responses = await Promise.all([first, second]);
  assert.ok(responses.every(response => response.body.delivery.outcome === "accepted"));
  assert.equal(native.calls.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(state.ledgerPath)).deliveries.length, 1);
});

test("window failed prepared persistence retains unknown provenance and sends nothing", async context => {
  const state = await fixture(context);
  const rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (...args) => {
    if (!injected && args[1] === state.ledgerPath) {
      injected = true;
      throw Object.assign(new Error("synthetic atomic write failure"), { code: "EIO" });
    }
    return rename(...args);
  };
  let response;
  try { response = await state.post(); }
  finally { fs.renameSync = rename; }
  assert.equal(injected, true);
  assert.equal(response.body.delivery.outcome, "unknown");
  assert.equal(response.body.delivery.error.code, "ledger_write_failed");
  assert.deepEqual(response.body.delivery.window_source, input().window_source);
  assert.equal(state.calls.length, 0);
  await state.control.close();
  const reopened = state.create();
  const address = await reopened.start();
  assert.equal((await state.get(input(), {}, address)).body.delivery.outcome, "unknown");
  assert.equal((await state.post({ ...input(), retry_failed_before_send: true }, address)).body.delivery.outcome, "unknown");
  assert.equal(state.calls.length, 0);
  assert.ok(fs.readdirSync(state.root).every(name => !name.endsWith(".tmp")));
});

test("window all native source fields are required at the HTTP boundary", async context => {
  const state = await fixture(context);
  const paths = [["origin"], ["relay"], ["window_source"], ["window_source", "route"],
    ["window_source", "window"], ["window_source", "window_binding"],
    ["window_source", "window_binding", "target"], ["window_source", "event"]];
  let checked = 0;
  for (const fields of paths) {
    const original = fields.reduce((current, field) => current[field], input());
    for (const field of Object.keys(original)) {
      const value = input();
      const holder = fields.reduce((current, key) => current[key], value);
      delete holder[field];
      const response = await state.post(value);
      assert.equal(response.status, 400, `missing ${[...fields, field].join(".")}`);
      checked++;
    }
  }
  assert.equal(state.calls.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(state.ledgerPath)).deliveries, []);
  context.diagnostic(`missing required native fields: ${checked}`);
});

function project(native, message) {
  native.client.displayPolicy.observeUpstream(message);
  const suppressed = native.client.wakeVisibility.shouldSuppress(message);
  const stable = suppressed ? message : native.client.wakeVisibility.project(message);
  return native.client.displayPolicy.project(message, stable, suppressed);
}

test("window cold hidden projection uses exact retained source without rewriting ledger or hiding ordinary tools", async context => {
  const native = nativeFixture("busy");
  const state = await fixture(context, { transport: native.transport });
  assert.equal((await state.post()).body.delivery.outcome, "accepted");
  const call = native.calls[0];
  const item = { id: "window-hidden-item", type: "userMessage", clientId: call.params.clientUserMessageId,
    content: [{ type: "text", text: call.params.input[0].text }] };
  const event = { method: "item/started", params: { threadId: TARGET.conversation_id, turnId: "synthetic-active-turn", item } };
  assert.equal(project(native, event), null);
  const before = fs.readFileSync(state.ledgerPath);
  assert.equal(JSON.parse(before).deliveries[0].visibility_item_key,
    JSON.stringify([TARGET.conversation_id, "synthetic-active-turn", item.id]));
  await state.control.close();
  const cold = nativeFixture("busy");
  const reopened = state.create({ transport: cold.transport });
  await reopened.start();
  assert.equal(cold.transport.visibilitySnapshot().hotEntries, 0);
  const request = { id: "synthetic-window-history", method: "thread/items/list",
    params: { threadId: TARGET.conversation_id, turnId: "synthetic-active-turn" } };
  cold.client.wakeVisibility.observeRequest(request);
  cold.client.displayPolicy.observeRequest(request);
  const entries = [{ ...item, clientId: null }, { ...item, id: "ordinary-copy", clientId: "ordinary-human" },
    { id: "ordinary-tool", type: "functionCall", name: "fixture" }];
  const response = { id: request.id, result: { data: entries.map(current => ({ turnId: "synthetic-active-turn", item: current })), nextCursor: null } };
  const displayed = project(cold, response);
  assert.deepEqual(displayed.result.data.map(entry => entry.item.id), ["ordinary-copy", "ordinary-tool"]);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), before);
  assert.equal(native.calls.length, 1);
  assert.equal(cold.calls.length, 0);
});

test("window channel withdrawal retains the complete mixed ledger and continues fresh quote and agent deliveries", async context => {
  const quote = input();
  delete quote.window_source;
  quote.delivery_id = "legacy-quote-delivery";
  quote.message_id = "legacy-quote-message";
  quote.origin = { kind: "human_message", channel: "napcat_owner_reply", source_ref: `owner-event:${"c".repeat(64)}` };
  quote.in_reply_to = "original-notification-message";
  quote.forward_of = { message_id: quote.in_reply_to, delivery_id: "original-notification-delivery", native_source: {
    provider: "napcat_owner", route: { route_key: "legacy-route", conversation_id: RELAY.conversation_id, target_key: "owner-private", generation: 1 },
    original_qq_message_id: "-80001", event: { event_id: "c".repeat(64), message_id: "80002", message_seq: 0,
      quoted_message_id: "-80001", sender_id: "90001" },
  } };
  const agent = { delivery_id: "legacy-agent-delivery", message_id: "legacy-agent-message", binding_generation: 7,
    origin: { kind: "agent", host: "antigravity", conversation_id: "synthetic-agent-source" },
    target: { ...TARGET }, text: "synthetic agent original", delivery_policy: "next_model_boundary" };
  const legacyOrigins = [{ ...RELAY, owner_reply_channels: ["napcat_owner_reply"] },
    { host: agent.origin.host, conversation_id: agent.origin.conversation_id }];
  const state = await fixture(context, { allowedOrigins: [{ ...RELAY, owner_reply_channels: ["napcat_owner_reply", "napcat_owner_window"] }, legacyOrigins[1]] });
  for (const value of [quote, agent, input()]) assert.equal((await state.post(value)).body.delivery.outcome, "accepted");
  const before = fs.readFileSync(state.ledgerPath);
  await state.control.close();
  const withdrawn = state.create({ allowedOrigins: legacyOrigins });
  const address = await withdrawn.start();
  for (const value of [quote, agent, input()]) assert.equal((await state.get(value, {}, address)).status, 200);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), before);
  assert.equal((await state.post({ ...input(), delivery_id: "blocked-new-window", message_id: "blocked-new-window-message" }, address)).status, 403);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), before);
  for (const value of [quote, agent]) {
    const fresh = { ...value, delivery_id: `${value.delivery_id}-continued`, message_id: `${value.message_id}-continued` };
    assert.equal((await state.post(fresh, address)).body.delivery.outcome, "accepted");
  }
  const records = JSON.parse(fs.readFileSync(state.ledgerPath)).deliveries;
  assert.equal(records.length, 5);
  assert.deepEqual(records.find(record => record.delivery_id === "window-delivery").window_source, input().window_source);
  assert.equal(state.calls.length, 5);
});
