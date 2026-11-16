import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CommunicationCore } from "../src/core.mjs";
import { MessageStore } from "../src/store.mjs";
import { identityKey, normalizeIdentity } from "../src/contracts.mjs";
import { CodexDeliveryAdapter } from "../src/adapters/codex.mjs";
import { CodexProxyTransport } from "../src/transports/codex-proxy.mjs";

const relay = { host: "codex", conversation_id: "synthetic-retry-core" };
const source = { machine_id: "synthetic-retry-machine", host: "antigravity", surface: "test", conversation_id: "synthetic-retry-source" };
const target = { machine_id: source.machine_id, host: "codex", surface: "test", conversation_id: "synthetic-retry-target", binding_id: "synthetic-retry-binding", binding_generation: 3, adapter_id: "synthetic-retry-adapter", capabilities: { next_model_boundary: true, when_idle: true } };

function inputFor(kind = "agent", visibility) {
  const message = {
    message_id: "synthetic-retry-message",
    envelope: {
      caller: { ...source }, origin: { kind: "agent_message", channel: "synthetic-test", source_ref: "synthetic-event" },
      text: " \r\n[CQ:reply,id=80001] 原文\t\u0000 ", attachment_refs: [], delivery_policy: "when_idle",
      ...(visibility === undefined ? {} : { message_visibility: visibility }),
    },
  };
  if (kind === "human") {
    const eventId = "ab".repeat(32);
    message.envelope.caller = { ...source, host: "qq", surface: "group", conversation_id: "synthetic-retry-owner" };
    message.envelope.origin = { kind: "human_message", channel: "napcat_owner_reply", source_ref: `owner-event:${eventId}` };
    message.envelope.in_reply_to = "synthetic-original-message";
    message.forward_of = { message_id: "synthetic-original-message", delivery_id: "synthetic-original-delivery", native_source: {
      provider: "napcat_owner", route: { route_key: "synthetic-retry-route", conversation_id: relay.conversation_id, target_key: message.envelope.caller.conversation_id, generation: 7 },
      original_qq_message_id: "80001", event: { event_id: eventId, message_id: "80002", message_seq: 2, quoted_message_id: "80001", sender_id: "90001" },
    } };
  }
  return { target: structuredClone(target), message, delivery: {
    delivery_id: "synthetic-retry-delivery", message_id: message.message_id, target_key: identityKey(target), target_snapshot: structuredClone(target), status: "dispatching", attempt_count: 1,
  } };
}

function transportFor(fetchImpl) {
  return new CodexProxyTransport({ baseUrl: "http://127.0.0.1:12345", token: "synthetic-retry-token", relay, fetchImpl });
}

function receiptFor(body, outcome = "accepted") {
  return { ...structuredClone(body), thread_id: body.target.conversation_id, turn_id: "synthetic-retry-turn", outcome,
    request_sent: outcome === "accepted", injection_method: outcome === "accepted" ? "turn/start" : null };
}

function persistedBusy(input, result) {
  const resumed = structuredClone(input);
  resumed.delivery.status = "dispatching";
  resumed.delivery.attempt_count = 2;
  resumed.delivery.evidence = { ...result, evidence: { ...result.evidence, operation: "deliver" } };
  return resumed;
}

test("legacy missing visibility preserves the original visible eight-field JSON byte for byte", async () => {
  let raw;
  const transport = transportFor(async (url, options) => {
    raw = options.body;
    return Response.json({ ok: true, delivery: receiptFor(JSON.parse(raw)) });
  });
  try {
    const input = inputFor();
    const before = structuredClone(input);
    assert.equal((await new CodexDeliveryAdapter({ transport }).deliver(input)).outcome, "accepted");
    assert.equal(raw, JSON.stringify({ delivery_id: input.delivery.delivery_id, message_id: input.message.message_id, binding_generation: 3,
      origin: { kind: "agent", host: source.host, conversation_id: source.conversation_id },
      target: { host: "codex", conversation_id: target.conversation_id }, text: input.message.envelope.text,
      delivery_policy: "when_idle", message_visibility: "visible" }));
    assert.deepEqual(input, before);
  } finally { await transport.close(); }
});

for (const kind of ["agent", "human"]) {
  for (const visibility of [undefined, "hidden", "visible"]) {
    test(`${kind} visibility ${String(visibility)} reaches the wire without additional RPC fields`, async () => {
      let body;
      const transport = transportFor(async (url, options) => {
        body = JSON.parse(options.body);
        return Response.json({ ok: true, delivery: receiptFor(body) });
      });
      try {
        const input = inputFor(kind, visibility);
        assert.equal((await new CodexDeliveryAdapter({ transport }).deliver(input)).outcome, "accepted");
        assert.equal(body.message_visibility, visibility ?? "visible");
        assert.equal(Object.hasOwn(body, "retry_failed_before_send"), false);
        for (const forbidden of ["hidden", "visible", "model", "clientUserMessageId", "expectedTurnId"]) assert.equal(Object.hasOwn(body, forbidden), false);
      } finally { await transport.close(); }
    });
  }

  test(`${kind} retries only a persisted same-delivery busy unsent receipt`, async () => {
    const bodies = [];
    const transport = transportFor(async (url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return Response.json({ ok: true, delivery: receiptFor(body, bodies.length === 1 ? "busy" : "accepted") });
    });
    try {
      const adapter = new CodexDeliveryAdapter({ transport });
      const input = inputFor(kind, "hidden");
      const first = await adapter.deliver(input);
      assert.equal(first.outcome, "busy");
      assert.equal(first.evidence.request_sent, false);
      const resumed = persistedBusy(input, first);
      const before = structuredClone(resumed);
      assert.equal((await adapter.deliver(resumed)).outcome, "accepted");
      assert.equal(Object.hasOwn(bodies[0], "retry_failed_before_send"), false);
      assert.equal(bodies[1].retry_failed_before_send, true);
      assert.deepEqual({ ...bodies[1], retry_failed_before_send: undefined }, { ...bodies[0], retry_failed_before_send: undefined });
      assert.deepEqual(resumed, before);
    } finally { await transport.close(); }
  });
}

test("human receipts strictly echo the requested hidden or visible mode", async () => {
  for (const visibility of ["hidden", "visible"]) {
    let originalBody;
    let gets = 0;
    const transport = transportFor(async (url, options) => {
      if (options.method === "POST") originalBody = JSON.parse(options.body);
      else gets += 1;
      return Response.json({ ok: true, delivery: { ...receiptFor(originalBody), message_visibility: visibility === "hidden" ? "visible" : "hidden" } });
    });
    try {
      const input = inputFor("human", visibility);
      const adapter = new CodexDeliveryAdapter({ transport });
      assert.equal((await adapter.deliver(input)).outcome, "unknown");
      await assert.rejects(transport.query({ delivery_id: input.delivery.delivery_id }, { request: adapter.request(input) }), { code: "codex_receipt_identity_mismatch" });
      assert.equal(gets, 1);
    }
    finally { await transport.close(); }
  }
});

test("agent explicit visibility rejects mismatched and missing modes on POST and original GET receipts", async () => {
  for (const visibility of ["hidden", "visible"]) {
    for (const returned of [undefined, visibility === "hidden" ? "visible" : "hidden"]) {
      let originalBody;
      const transport = transportFor(async (url, options) => {
        if (options.method === "POST") originalBody = JSON.parse(options.body);
        const delivery = receiptFor(originalBody);
        if (returned === undefined) delete delivery.message_visibility;
        else delivery.message_visibility = returned;
        return Response.json({ ok: true, delivery });
      });
      try {
        const input = inputFor("agent", visibility);
        const adapter = new CodexDeliveryAdapter({ transport });
        assert.equal((await adapter.deliver(input)).outcome, "unknown");
        await assert.rejects(transport.query({ delivery_id: input.delivery.delivery_id }, { request: adapter.request(input) }), { code: "codex_receipt_identity_mismatch" });
      } finally { await transport.close(); }
    }
  }
});

test("legacy agent omits request mode and accepts only missing or visible receipt modes", async () => {
  for (const returned of [undefined, "visible", "hidden"]) {
    let body;
    const transport = transportFor(async (url, options) => {
      if (options.method === "POST") body = JSON.parse(options.body);
      const delivery = receiptFor(body);
      if (returned === undefined) delete delivery.message_visibility;
      else delivery.message_visibility = returned;
      return Response.json({ ok: true, delivery });
    });
    try {
      const input = inputFor();
      const adapter = new CodexDeliveryAdapter({ transport });
      assert.equal(Object.hasOwn(adapter.request(input), "message_visibility"), false);
      assert.equal((await adapter.deliver(input)).outcome, returned === "hidden" ? "unknown" : "accepted");
      assert.equal((await adapter.query(input)).outcome, returned === "hidden" ? "unknown" : "accepted");
      assert.equal(body.message_visibility, "visible");
    } finally { await transport.close(); }
  }
});

test("unsupported visibility is rejected locally before HTTP or submission tracking", async () => {
  let calls = 0;
  let started = 0;
  const transport = transportFor(async () => { calls += 1; assert.fail("invalid visibility reached HTTP"); });
  try {
    for (const visibility of [null, "", "other", true, {}, ["hidden"]]) {
      const input = inputFor("human", visibility);
      const result = await new CodexDeliveryAdapter({ transport }).deliver({ ...input, onRequestStarted() { started += 1; } });
      assert.equal(result.outcome, "failed_before_send");
    }
    assert.equal(calls, 0);
    assert.equal(started, 0);
  } finally { await transport.close(); }
});

test("attempt counts and incomplete or mismatched busy evidence cannot enable retries", async () => {
  const bodies = [];
  const transport = transportFor(async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    return Response.json({ ok: true, delivery: receiptFor(body) });
  });
  const base = inputFor();
  const valid = persistedBusy(base, { outcome: "busy", delivery_id: base.delivery.delivery_id, target_key: identityKey(target), evidence: { kind: "receipt", request_sent: false } });
  const changes = [
    input => { delete input.delivery.evidence; input.delivery.attempt_count = 100000; },
    input => { input.delivery.evidence.outcome = "unknown"; },
    input => { input.delivery.evidence.delivery_id = "synthetic-other-delivery"; },
    input => { input.delivery.evidence.target_key = "synthetic-other-target"; },
    input => { input.delivery.target_key = "synthetic-other-target"; },
    input => { input.delivery.message_id = "synthetic-other-message"; },
    input => { delete input.delivery.target_snapshot; },
    input => { input.delivery.target_snapshot.binding_generation += 1; },
    input => { input.delivery.target_snapshot.binding_id = "synthetic-other-binding"; },
    input => { input.delivery.target_snapshot.adapter_id = "synthetic-other-adapter"; },
    input => { input.delivery.status = "accepted"; },
    input => { input.delivery.evidence.evidence.operation = "resolve"; },
    input => { input.delivery.evidence.evidence.kind = "query"; },
    input => { delete input.delivery.evidence.evidence.request_sent; },
    input => { input.delivery.evidence.evidence.request_sent = null; },
    input => { input.delivery.evidence.evidence.request_sent = true; },
    input => { input.delivery.evidence.evidence.request_sent = "false"; },
  ];
  try {
    const adapter = new CodexDeliveryAdapter({ transport });
    for (const change of changes) {
      const input = structuredClone(valid);
      change(input);
      await adapter.deliver(input);
      assert.equal(Object.hasOwn(bodies.at(-1), "retry_failed_before_send"), false, change.toString());
    }
  } finally { await transport.close(); }
});

test("connect refusal remains retryable without claiming a persisted upstream busy receipt", async () => {
  const bodies = [];
  const transport = transportFor(async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (bodies.length === 1) throw new TypeError("synthetic refusal", { cause: Object.assign(new Error("synthetic connect"), { code: "ECONNREFUSED", syscall: "connect" }) });
    return Response.json({ ok: true, delivery: receiptFor(body) });
  });
  try {
    const adapter = new CodexDeliveryAdapter({ transport });
    const input = inputFor();
    const first = await adapter.deliver(input);
    assert.equal(first.outcome, "busy");
    assert.equal(first.evidence.kind, "query");
    assert.equal(first.evidence.request_sent, undefined);
    assert.equal((await adapter.deliver(persistedBusy(input, first))).outcome, "accepted");
    assert.ok(bodies.every(body => !Object.hasOwn(body, "retry_failed_before_send")));
  } finally { await transport.close(); }
});

for (const kind of ["agent", "human"]) {
  test(`${kind} unknown delivery uses GET only even if deliver is called again`, async () => {
    const calls = [];
    let originalBody;
    const transport = transportFor(async (url, options) => {
      calls.push({ method: options.method, body: options.body });
      if (options.method === "POST") {
        originalBody = JSON.parse(options.body);
        throw new Error("synthetic lost receipt");
      }
      return Response.json({ ok: true, delivery: receiptFor(originalBody) });
    });
    try {
      const adapter = new CodexDeliveryAdapter({ transport });
      const input = inputFor(kind, "hidden");
      assert.equal((await adapter.deliver(input)).outcome, "unknown");
      input.delivery.status = "unknown";
      input.delivery.attempt_count = 100000;
      assert.equal((await adapter.deliver(input)).outcome, "accepted");
      assert.deepEqual(calls.map(call => call.method), ["POST", "GET"]);
      assert.equal(calls[1].body, undefined);
    } finally { await transport.close(); }
  });
}

test("an unknown delivery only queries until a confirmed busy receipt authorizes its next prepared attempt", async () => {
  const calls = [];
  let originalBody;
  const transport = transportFor(async (url, options) => {
    calls.push({ method: options.method, body: options.body });
    if (options.method === "POST") {
      const body = JSON.parse(options.body);
      if (!originalBody) { originalBody = body; throw new Error("synthetic busy receipt lost"); }
      return Response.json({ ok: true, delivery: receiptFor(body) });
    }
    return Response.json({ ok: true, delivery: receiptFor(originalBody, "busy") });
  });
  try {
    const input = inputFor("human", "hidden");
    const adapter = new CodexDeliveryAdapter({ transport });
    assert.equal((await adapter.deliver(input)).outcome, "unknown");
    input.delivery.status = "unknown";
    const queried = await adapter.deliver(input);
    assert.equal(queried.outcome, "busy");
    assert.equal(queried.evidence.kind, "receipt");
    assert.equal(queried.evidence.request_sent, false);
    const prepared = persistedBusy(input, queried);
    prepared.delivery.evidence.evidence.operation = "query";
    assert.equal((await adapter.deliver(prepared)).outcome, "accepted");
    assert.deepEqual(calls.map(call => call.method), ["POST", "GET", "POST"]);
    assert.equal(calls[1].body, undefined);
    assert.equal(JSON.parse(calls[2].body).retry_failed_before_send, true);
  } finally { await transport.close(); }
});

for (const firstOutcome of ["busy", "unknown"]) {
  test(`SQLite reload retains confirmed unsent busy proof and resumes the same original delivery once (${firstOutcome})`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "communication-codex-busy-retry-"));
    const principal = { id: "synthetic-retry-principal", identity: source, allowed_targets: [target.binding_id], origin_kinds: ["agent_message"] };
    const ledger = new Map();
    const bodies = [];
    let mode = "busy";
    let loseBusyReceipt = firstOutcome === "unknown";
    let gets = 0;
    let nativeInputs = 0;
    let now = Date.parse("2030-01-01T00:00:00Z");
    let active;
    const fetchImpl = async (url, options) => {
      if (options.method === "GET") {
        gets += 1;
        return Response.json({ ok: true, delivery: ledger.get(decodeURIComponent(new URL(url).pathname.split("/").at(-1))) });
      }
      const body = JSON.parse(options.body);
      bodies.push(body);
      let receipt = ledger.get(body.delivery_id);
      if (!receipt || body.retry_failed_before_send === true) {
        receipt = receiptFor(body, mode === "busy" ? "busy" : "accepted");
        delete receipt.retry_failed_before_send;
        ledger.set(body.delivery_id, receipt);
        if (receipt.outcome === "accepted") nativeInputs += 1;
      }
      if (loseBusyReceipt) { loseBusyReceipt = false; throw new Error("synthetic busy receipt lost before reload"); }
      return Response.json({ ok: true, delivery: receipt });
    };
    const open = () => {
      const transport = transportFor(fetchImpl);
      const store = new MessageStore({ filePath: join(directory, "core.sqlite") });
      const core = new CommunicationCore({ store, targets: [target], principals: [principal], adapters: { [target.adapter_id]: new CodexDeliveryAdapter({ transport }) }, now: () => now });
      return { core, store, transport };
    };
    const stop = async () => {
      if (!active) return;
      await active.core.close();
      active.store.close();
      await active.transport.close();
      active = null;
    };
    try {
      active = open();
      await active.core.start();
      const input = inputFor().message.envelope;
      const sent = await active.core.sendMessage({ principal_id: principal.id }, { ...input,
        target: { ...normalizeIdentity(target), binding_id: target.binding_id, binding_generation: target.binding_generation },
        dedupe_key: "synthetic-retry-key", expires_at: "2031-01-01T00:00:00Z", message_visibility: "visible" });
      await active.core.drain();
      const before = active.store.getDelivery(sent.delivery.delivery_id);
      assert.equal(before.status, firstOutcome === "unknown" ? "unknown" : "prepared");
      if (firstOutcome === "busy") assert.equal(before.evidence.evidence.request_sent, false);
      await stop();
      mode = "idle";
      now += 1001;
      active = open();
      await active.core.start();
      await active.core.drain();
      if (firstOutcome === "unknown") {
        const confirmed = active.store.getDelivery(sent.delivery.delivery_id);
        assert.equal(confirmed.status, "prepared");
        assert.equal(confirmed.evidence.evidence.operation, "query");
        assert.equal(confirmed.evidence.evidence.request_sent, false);
        assert.equal(nativeInputs, 0);
        now += 1001;
        await active.core.dispatchPending();
        await active.core.drain();
      }
      const after = active.store.getDelivery(sent.delivery.delivery_id);
      assert.equal(after.status, "accepted");
      assert.equal(after.delivery_id, before.delivery_id);
      assert.equal(after.message_id, before.message_id);
      assert.equal(bodies.length, 2);
      assert.equal(Object.hasOwn(bodies[0], "retry_failed_before_send"), false);
      assert.equal(bodies[1].retry_failed_before_send, true);
      assert.equal(nativeInputs, 1);
      assert.equal(gets, firstOutcome === "unknown" ? 1 : 0);
    } finally {
      await stop();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
