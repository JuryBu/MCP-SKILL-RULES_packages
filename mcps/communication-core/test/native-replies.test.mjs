import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CommunicationCore } from "../src/core.mjs";
import { AntigravityDeliveryAdapter } from "../src/adapters/antigravity.mjs";
import { encodeCursor } from "../src/contracts.mjs";
import { MessageStore } from "../src/store.mjs";

const SOURCE = { machine_id: "test-machine", host: "codex", surface: "desktop", conversation_id: "test-source" };
const RECEIVER = { machine_id: "test-machine", host: "antigravity", surface: "desktop", conversation_id: "test-cascade" };
const SOURCE_CONTEXT = { principal_id: "source-principal" };
const RECEIVER_CONTEXT = { principal_id: "receiver-principal" };

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

function sendInput(dedupeKey, patch = {}) {
  return {
    caller: SOURCE,
    origin: { kind: "agent_message", channel: "test", source_ref: "test-source-step" },
    target: { ...RECEIVER, binding_id: "receiver-binding", binding_generation: 7 },
    dedupe_key: dedupeKey,
    text: "原投递",
    expires_at: "2031-01-01T00:00:00Z",
    reply_required: true,
    ...patch,
  };
}

function nativeReply(request, patch = {}) {
  return {
    native_message_id: `${request.target.conversation_id}:7`,
    text: "宿主的实际回复",
    source_step_index: 7,
    cascade_id: request.target.conversation_id,
    trajectory_id: "test-trajectory",
    ...patch,
  };
}

function replyEvents(store, messageId) {
  return store.eventsAfter(messageId, 0, 1000).filter(event => event.kind === "reply");
}

async function fixture(testContext, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "communication-native-replies-"));
  const filePath = join(directory, "messages.sqlite");
  const targets = [
    { ...RECEIVER, binding_id: "receiver-binding", binding_generation: 7, adapter_id: "native-adapter", capabilities: { next_model_boundary: true, when_idle: true }, evidence: "test-only" },
    { ...SOURCE, binding_id: "source-binding", binding_generation: 3, adapter_id: "native-adapter", capabilities: { next_model_boundary: true, when_idle: true }, evidence: "test-only" },
  ];
  const principals = [
    { id: SOURCE_CONTEXT.principal_id, identity: SOURCE, allowed_targets: ["receiver-binding"], origin_kinds: ["agent_message"] },
    { id: RECEIVER_CONTEXT.principal_id, identity: RECEIVER, allowed_targets: ["source-binding"], origin_kinds: ["agent_message"] },
  ];
  const state = { writes: [], reads: [], queries: [] };
  const adapter = {
    deliver(request) {
      state.writes.push(request);
      return { outcome: "accepted", delivery_id: request.delivery.delivery_id, target_key: request.delivery.target_key };
    },
    query(request) {
      state.queries.push(request);
      return { outcome: "unknown", delivery_id: request.delivery.delivery_id, target_key: request.delivery.target_key };
    },
    ...(options.observeReply ? { observeReply(request) { state.reads.push(request); return options.observeReply(request, state); } } : {}),
  };
  const adapters = { "native-adapter": adapter };
  const stores = [];
  const cores = [];
  const open = () => {
    const store = new MessageStore({ filePath });
    stores.push(store);
    const core = new CommunicationCore({
      store, targets, principals, adapters,
      now: () => Date.parse("2030-01-01T00:00:00Z"),
      ...(options.deliveryTimeoutMs === undefined ? {} : { deliveryTimeoutMs: options.deliveryTimeoutMs }),
      maxConcurrent: options.maxConcurrent ?? 2,
    });
    cores.push(core);
    return { core, store };
  };
  testContext.after(async () => {
    try {
      await Promise.all(cores.map(core => core.close()));
    } finally {
      for (const store of stores) store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const { core, store } = open();
  await core.start();
  await core.drain();
  const send = async (dedupeKey, patch) => {
    const sent = await core.sendMessage(SOURCE_CONTEXT, sendInput(dedupeKey, patch));
    await core.drain();
    return core.getMessage(SOURCE_CONTEXT, { caller: SOURCE, message_id: sent.message.message_id });
  };
  return { core, store, state, adapter, adapters, targets, principals, filePath, open, send };
}

test("native observations persist only bounded reply fields on the original message and wake wait without acknowledging", async testContext => {
  const secret = "SECRET_NATIVE_THINKING_DO_NOT_PERSIST";
  const context = await fixture(testContext, {
    observeReply(request) {
      assert.equal(request.delivery.status, "accepted");
      assert.equal(request.target.host, RECEIVER.host);
      request.message.envelope.text = "adapter-mutated-copy";
      const result = nativeReply(request, { host: "forged-host", source: "forged-source", thinking: secret, raw: { secret } });
      result.circular = result;
      result.toJSON = () => { throw new Error("the external object must never be serialized"); };
      Object.defineProperty(result, "untrusted_extra", { enumerable: true, get() { throw new Error(secret); } });
      return result;
    },
  });
  const { core, store, state } = context;
  const original = await context.send("native-success");
  const before = core.result(original.message.message_id);
  const waiting = core.wait(SOURCE_CONTEXT, {
    caller: SOURCE, message_id: original.message.message_id,
    after_cursor: encodeCursor(original.message.message_id, store.lastSequence(original.message.message_id)),
    until: "reply", wait_ms: 1000,
  });
  assert.deepEqual(await core.pollReplies(), { checked: 1, replies: 1 });
  const response = await waiting;
  assert.equal(response.matched, true);
  assert.equal(response.matched_by, "reply");
  assert.equal(response.events.length, 1);
  const event = response.events[0];
  assert.equal(event.message_id, original.message.message_id);
  assert.equal(event.kind, "reply");
  assert.deepEqual(event.data, {
    delivery_id: original.delivery.delivery_id,
    native_message_id: "test-cascade:7",
    text: "宿主的实际回复",
    source_step_index: 7,
    native_conversation_id: RECEIVER.conversation_id,
    native_trajectory_id: "test-trajectory",
    cascade_id: RECEIVER.conversation_id,
    trajectory_id: "test-trajectory",
    evidence: {
      kind: "native_reply", source: "adapter.observeReply", ...RECEIVER,
      adapter_id: "native-adapter", binding_id: "receiver-binding", binding_generation: 7,
      observed_at: "2030-01-01T00:00:00.000Z",
    },
  });
  assert.deepEqual(core.result(original.message.message_id), before);
  assert.equal(before.message.processing, "pending");
  assert.equal(before.message.model_observed, "unknown");
  assert.equal(state.writes.length, 1);
  assert.equal(state.queries.length, 0);
  assert.equal(store.listDeliveries().length, 1);
  assert.equal(state.reads[0].signal.aborted, false);
  assert.equal(getEventListeners(state.reads[0].signal, "abort").length, 0);
  for (const suffix of ["", "-wal"]) {
    if (existsSync(context.filePath + suffix)) assert.equal(readFileSync(context.filePath + suffix).includes(Buffer.from(secret)), false);
  }
});

test("adapters without observation and all nonaccepted deliveries are skipped without dispatching or querying", async testContext => {
  const missing = await fixture(testContext);
  const missingOriginal = await missing.send("missing-observer");
  assert.deepEqual(await missing.core.pollReplies(), { checked: 0, replies: 0 });
  assert.equal(replyEvents(missing.store, missingOriginal.message.message_id).length, 0);
  assert.equal(missing.state.writes.length, 1);
  assert.equal(missing.state.queries.length, 0);
  const context = await fixture(testContext, { observeReply: nativeReply });
  const original = await context.send("nonaccepted");
  for (const status of ["prepared", "dispatching", "unknown", "busy", "failed_before_send", "unsupported", "expired"]) {
    context.store.transaction(() => {
      context.store.updateDelivery(original.delivery.delivery_id, { status });
      context.store.updateMessage(original.message.message_id, { delivery_status: status });
    });
    const before = context.core.result(original.message.message_id);
    assert.deepEqual(await context.core.pollReplies(), { checked: 0, replies: 0 }, status);
    assert.deepEqual(context.core.result(original.message.message_id), before, status);
  }
  assert.equal(context.state.reads.length, 0);
  assert.equal(context.state.writes.length, 1);
  assert.equal(context.state.queries.length, 0);
});

test("invalid observations and transient failures leave the original records and events unchanged and can be queried again", async testContext => {
  let returned;
  let thrown = false;
  const context = await fixture(testContext, { observeReply() { if (thrown) throw new Error("private transport error"); return returned; } });
  const original = await context.send("invalid-results");
  const request = context.state.writes[0];
  const before = context.core.result(original.message.message_id);
  const sequence = context.store.lastSequence(original.message.message_id);
  const invalid = [
    null, undefined, [], "raw text", {},
    nativeReply(request, { cascade_id: "another-cascade" }),
    nativeReply(request, { cascade_id: undefined }),
    ...[undefined, null, 123, "", " \n ", "标".repeat(86)].map(native_message_id => nativeReply(request, { native_message_id })),
    ...[undefined, null, 123, "", " \n ", "汉".repeat(87382)].map(text => nativeReply(request, { text })),
    ...[undefined, null, "0", -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1].map(source_step_index => nativeReply(request, { source_step_index })),
    ...[0, {}, "", "轨".repeat(86)].map(trajectory_id => nativeReply(request, { trajectory_id })),
    Object.defineProperty({}, "native_message_id", { get() { throw new Error("private getter"); } }),
  ];
  for (const [index, result] of invalid.entries()) {
    returned = result;
    assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 0 }, `invalid observation ${index}`);
    assert.deepEqual(context.core.result(original.message.message_id), before);
    assert.equal(context.store.lastSequence(original.message.message_id), sequence);
  }
  thrown = true;
  assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 0 });
  thrown = false;
  returned = nativeReply(request, { source_step_index: 0, trajectory_id: null });
  assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 1 });
  const event = replyEvents(context.store, original.message.message_id)[0];
  assert.equal(event.data.source_step_index, 0);
  assert.equal(Object.hasOwn(event.data, "trajectory_id"), false);
  assert.deepEqual(context.core.result(original.message.message_id), before);
  assert.equal(context.state.writes.length, 1);
  assert.equal(context.state.queries.length, 0);
});

test("the actual bound Antigravity adapter observes only its DONE response before the next user input", async testContext => {
  const context = await fixture(testContext);
  let submitted;
  let writes = 0;
  let steps = [];
  const adapter = new AntigravityDeliveryAdapter({ transport: {
    describe(target) { return { cascade_id: target.conversation_id, trajectory_id: "actual-adapter-trajectory", step_count: steps.length }; },
    call(method, payload) {
      assert.equal(method, "SendUserCascadeMessage");
      submitted = payload;
      writes += 1;
      return {};
    },
    readSteps(target, { signal }) {
      assert.equal(target.conversation_id, RECEIVER.conversation_id);
      assert.equal(signal.aborted, false);
      return { steps };
    },
  } });
  context.adapters["native-adapter"] = adapter;
  const original = await context.send("actual-ag-adapter");
  const input = { index: 0, type: "user_input", status: "DONE", user_input: { client_message_id: submitted.clientMessageId, text: submitted.items[0].text } };
  const response = { index: 1, type: "planner_response", status: "RUNNING", assistant_response: { text: "实际适配器正文", message_id: "actual-ag-native", final: true } };
  Object.defineProperty(response, "thinking", { get() { throw new Error("thinking must not be read"); } });
  steps = [input, response];
  assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 0 });
  response.status = "DONE";
  steps = [input, { index: 1, type: "user_input", user_input: { text: "下一条主人输入" } }, { ...response, index: 2 }];
  assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 0 });
  steps = [input, response, { index: 2, type: "user_input", user_input: { text: "下一条主人输入" } }];
  assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 1 });
  const event = replyEvents(context.store, original.message.message_id)[0];
  assert.equal(event.data.text, "实际适配器正文");
  assert.equal(event.data.native_message_id, "actual-ag-native");
  assert.equal(event.data.native_conversation_id, RECEIVER.conversation_id);
  assert.equal(event.data.native_trajectory_id, "actual-adapter-trajectory");
  assert.equal(event.data.evidence.host, "antigravity");
  assert.equal(context.store.getMessage(original.message.message_id).processing, "pending");
  assert.equal(writes, 1);
});

test("a reply append failure rolls back and a subsequent poll retries the read without changing or repeating delivery", async testContext => {
  const context = await fixture(testContext, { observeReply: nativeReply });
  const original = await context.send("append-failure");
  const before = context.core.result(original.message.message_id);
  const sequence = context.store.lastSequence(original.message.message_id);
  const appendEvent = context.store.appendEvent.bind(context.store);
  context.store.appendEvent = (...parameters) => {
    const event = appendEvent(...parameters);
    if (parameters[1] === "reply") throw new Error("controlled persistence failure after insert");
    return event;
  };
  try {
    await assert.rejects(context.core.pollReplies(), /controlled persistence failure/);
    assert.deepEqual(context.core.result(original.message.message_id), before);
    assert.equal(context.store.lastSequence(original.message.message_id), sequence);
    assert.equal(context.core.replyPollPromise, null);
    assert.equal(context.core.replyInvocations.size, 0);
  } finally {
    context.store.appendEvent = appendEvent;
  }
  assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 1 });
  assert.equal(context.state.reads.length, 2);
  assert.equal(context.state.writes.length, 1);
  assert.equal(context.state.queries.length, 0);
});

test("nonadvancing event pagination fails closed and can be read again after the store is corrected", async testContext => {
  const context = await fixture(testContext, { observeReply: nativeReply });
  const original = await context.send("pagination-failure");
  context.store.transaction(() => {
    for (let index = 0; index < 110; index += 1) context.store.appendEvent(original.message.message_id, "test-history", { index });
  });
  const eventsAfter = context.store.eventsAfter.bind(context.store);
  context.store.eventsAfter = (messageId, sequence, limit) => eventsAfter(messageId, 0, limit);
  try {
    await assert.rejects(context.core.pollReplies(), error => error.code === "store_pagination_error");
    assert.equal(context.state.reads.length, 0);
  } finally {
    context.store.eventsAfter = eventsAfter;
  }
  assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 1 });
  assert.equal(context.state.writes.length, 1);
});

test("byte limits and maximum safe step indexes are accepted at their exact boundaries", async testContext => {
  const context = await fixture(testContext, {
    observeReply(request) { return nativeReply(request, { native_message_id: "n".repeat(256), text: "x".repeat(262144), trajectory_id: "t".repeat(256), source_step_index: Number.MAX_SAFE_INTEGER }); },
  });
  const original = await context.send("exact-boundaries", { reply_required: false });
  assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 1 });
  const event = replyEvents(context.store, original.message.message_id)[0];
  assert.equal(event.data.text.length, 262144);
  assert.equal(event.data.native_message_id.length, 256);
  assert.equal(event.data.trajectory_id.length, 256);
  assert.equal(event.data.source_step_index, Number.MAX_SAFE_INTEGER);
});

test("generic conversation and turn identifiers support Codex-shaped observations without LS-specific fields", async testContext => {
  const context = await fixture(testContext, {
    observeReply(request) {
      return {
        native_message_id: "codex-item", text: "实际Codex回复", source_step_index: 0,
        native_conversation_id: request.target.conversation_id, native_turn_id: "codex-turn",
        native_trajectory_id: "native-history",
      };
    },
  });
  context.targets[0].host = "codex";
  const original = await context.send("generic-native-shape", { target: { ...RECEIVER, host: "codex", binding_id: "receiver-binding", binding_generation: 7 } });
  assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 1 });
  const event = replyEvents(context.store, original.message.message_id)[0];
  assert.equal(event.data.native_conversation_id, RECEIVER.conversation_id);
  assert.equal(event.data.native_turn_id, "codex-turn");
  assert.equal(event.data.native_trajectory_id, "native-history");
  assert.equal(event.data.evidence.host, "codex");
  assert.equal(Object.hasOwn(event.data, "cascade_id"), false);
  assert.equal(Object.hasOwn(event.data, "trajectory_id"), false);
  assert.equal(context.store.getMessage(original.message.message_id).processing, "pending");
});

test("generic and legacy aliases must agree and optional generic identifiers stay bounded", async testContext => {
  let patch;
  const context = await fixture(testContext, { observeReply(request) { return nativeReply(request, patch); } });
  const original = await context.send("generic-alias-validation");
  const invalid = [
    { native_conversation_id: "wrong-conversation" },
    { native_conversation_id: null },
    { native_conversation_id: RECEIVER.conversation_id, cascade_id: "wrong-legacy-cascade" },
    { native_conversation_id: RECEIVER.conversation_id, cascade_id: null },
    { native_conversation_id: undefined, cascade_id: undefined },
    { native_trajectory_id: "conflicting-native-trajectory" },
    ...[0, {}, "", "轮".repeat(86)].map(native_turn_id => ({ native_turn_id })),
    ...[0, {}, "", "迹".repeat(86)].map(native_trajectory_id => ({ native_trajectory_id, trajectory_id: undefined })),
  ];
  for (const value of invalid) {
    patch = value;
    assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 0 });
    assert.equal(replyEvents(context.store, original.message.message_id).length, 0);
  }
  patch = { native_conversation_id: RECEIVER.conversation_id, native_turn_id: "t".repeat(256), native_trajectory_id: "test-trajectory" };
  assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 1 });
  const event = replyEvents(context.store, original.message.message_id)[0];
  assert.equal(event.data.native_conversation_id, event.data.cascade_id);
  assert.equal(event.data.native_trajectory_id, event.data.trajectory_id);
  assert.equal(event.data.native_turn_id.length, 256);
});

test("any persisted reply after multiple event pages suppresses observation across an actual SQLite reopen", async testContext => {
  const context = await fixture(testContext, { observeReply: nativeReply });
  const original = await context.send("deep-existing-reply");
  context.store.transaction(() => {
    for (let index = 0; index < 225; index += 1) context.store.appendEvent(original.message.message_id, "test-history", { index });
    context.store.appendEvent(original.message.message_id, "reply", { text: "此前的普通回复" });
  });
  const eventCalls = [];
  const eventsAfter = context.store.eventsAfter.bind(context.store);
  context.store.eventsAfter = (...parameters) => { eventCalls.push(parameters); return eventsAfter(...parameters); };
  assert.deepEqual(await context.core.pollReplies(), { checked: 0, replies: 0 });
  assert.deepEqual(eventCalls.map(parameters => parameters[1]), [0, 100, 200]);
  assert.ok(eventCalls.every(parameters => parameters[2] === 100));
  await context.core.close();
  context.store.close();
  const reopened = context.open();
  await reopened.core.start();
  await reopened.core.drain();
  assert.deepEqual(await reopened.core.pollReplies(), { checked: 0, replies: 0 });
  assert.equal(context.state.reads.length, 0);
  assert.equal(replyEvents(reopened.store, original.message.message_id).length, 1);
});

test("a native reply remains idempotent after reopen even if the adapter would return another native ID", async testContext => {
  let nativeId = "first-native-id";
  const context = await fixture(testContext, { observeReply(request) { return nativeReply(request, { native_message_id: nativeId }); } });
  const original = await context.send("native-reopen");
  assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 1 });
  await context.core.close();
  context.store.close();
  nativeId = "later-native-id";
  const reopened = context.open();
  await reopened.core.start();
  await reopened.core.drain();
  assert.deepEqual(await reopened.core.pollReplies(), { checked: 0, replies: 0 });
  assert.equal(context.state.reads.length, 1);
  assert.equal(context.state.writes.length, 1);
  assert.equal(replyEvents(reopened.store, original.message.message_id).length, 1);
  assert.equal(replyEvents(reopened.store, original.message.message_id)[0].data.native_message_id, "first-native-id");
});

test("concurrent cores sharing SQLite check for any reply inside the same append transaction", async testContext => {
  const bothStarted = deferred();
  const release = deferred();
  let started = 0;
  const context = await fixture(testContext, {
    async observeReply(request) {
      started += 1;
      if (started === 2) bothStarted.resolve();
      await release.promise;
      return nativeReply(request);
    },
  });
  const original = await context.send("two-core-race");
  const other = context.open();
  await other.core.start();
  await other.core.drain();
  const first = context.core.pollReplies();
  const second = other.core.pollReplies();
  try {
    await bothStarted.promise;
  } finally {
    release.resolve();
  }
  const results = await Promise.all([first, second]);
  assert.equal(results.reduce((count, result) => count + result.checked, 0), 2);
  assert.equal(results.reduce((count, result) => count + result.replies, 0), 1);
  assert.equal(replyEvents(context.store, original.message.message_id).length, 1);
  assert.equal(replyEvents(other.store, original.message.message_id).length, 1);
  assert.equal(context.state.writes.length, 1);
});

test("ordinary reply and explicit processing acknowledgements retain their original behavior during native observation", async testContext => {
  const started = deferred();
  const release = deferred();
  const context = await fixture(testContext, {
    async observeReply(request) { started.resolve(); await release.promise; return nativeReply(request); },
  });
  const original = await context.send("manual-reply-race");
  context.core.ackProcessing(RECEIVER_CONTEXT, {
    caller: RECEIVER, message_id: original.message.message_id, delivery_id: original.delivery.delivery_id, binding_generation: 7, processing: "processing",
  });
  const polling = context.core.pollReplies();
  try {
    await started.promise;
    await context.core.sendMessage(RECEIVER_CONTEXT, sendInput("ordinary-reply", {
      caller: RECEIVER,
      target: { ...SOURCE, binding_id: "source-binding", binding_generation: 3 },
      text: "普通回复", in_reply_to: original.message.message_id,
    }));
    await context.core.drain();
  } finally {
    release.resolve();
  }
  assert.deepEqual(await polling, { checked: 1, replies: 0 });
  const events = replyEvents(context.store, original.message.message_id);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.text, "普通回复");
  assert.equal(Object.hasOwn(events[0].data, "native_message_id"), false);
  assert.equal(context.store.getMessage(original.message.message_id).processing, "processing");
  context.core.ackProcessing(RECEIVER_CONTEXT, {
    caller: RECEIVER, message_id: original.message.message_id, delivery_id: original.delivery.delivery_id, binding_generation: 7, processing: "done",
  });
  assert.equal(context.store.getMessage(original.message.message_id).processing, "done");
  assert.equal(context.state.writes.length, 2);
});

test("native observation preserves an existing processing acknowledgement until the receiver explicitly finishes", async testContext => {
  const context = await fixture(testContext, { observeReply: nativeReply });
  const original = await context.send("processing-preserved");
  const acknowledgement = { caller: RECEIVER, message_id: original.message.message_id, delivery_id: original.delivery.delivery_id, binding_generation: 7, processing: "processing" };
  context.core.ackProcessing(RECEIVER_CONTEXT, acknowledgement);
  assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 1 });
  assert.equal(context.store.getMessage(original.message.message_id).processing, "processing");
  context.core.ackProcessing(RECEIVER_CONTEXT, { ...acknowledgement, processing: "done" });
  assert.equal(context.store.getMessage(original.message.message_id).processing, "done");
});

test("polls coalesce into one promise and scan accepted deliveries in small keyset pages with bounded network concurrency", async testContext => {
  let active = 0;
  let maximum = 0;
  const context = await fixture(testContext, {
    maxConcurrent: 2,
    async observeReply(request) {
      active += 1;
      maximum = Math.max(maximum, active);
      try { await delay(2); return nativeReply(request); } finally { active -= 1; }
    },
  });
  const originals = [];
  for (let index = 0; index < 61; index += 1) originals.push(await context.send(`paged-${index}`));
  const pageCalls = [];
  const listDeliveries = context.store.listDeliveries.bind(context.store);
  context.store.listDeliveries = input => { pageCalls.push(input); return listDeliveries(input); };
  const first = context.core.pollReplies();
  const second = context.core.pollReplies();
  assert.equal(first, second);
  assert.deepEqual(await first, { checked: 61, replies: 61 });
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.equal(context.state.reads.length, 61);
  assert.equal(new Set(context.state.reads.map(request => request.delivery.delivery_id)).size, 61);
  assert.equal(pageCalls.length, 3);
  assert.ok(pageCalls.every(input => input.limit === 25 && input.statuses.join() === "accepted"));
  assert.equal(pageCalls[0].after_id, undefined);
  assert.ok(pageCalls[1].after_id < pageCalls[2].after_id);
  for (const original of originals) assert.equal(replyEvents(context.store, original.message.message_id).length, 1);
  assert.deepEqual(await context.core.pollReplies(), { checked: 0, replies: 0 });
  assert.equal(context.state.writes.length, 61);
});

test("revoked authority and changed binding identity generation or adapter cannot redirect observation", async testContext => {
  const context = await fixture(testContext, { observeReply: nativeReply });
  const original = await context.send("binding-before-poll");
  const target = { ...context.targets[0] };
  for (const patch of [{ conversation_id: "other-cascade" }, { binding_generation: 8 }, { adapter_id: "new-adapter" }]) {
    context.targets[0] = { ...target, ...patch };
    assert.deepEqual(await context.core.pollReplies(), { checked: 0, replies: 0 });
  }
  context.targets[0] = target;
  context.principals[0].allowed_targets = [];
  assert.deepEqual(await context.core.pollReplies(), { checked: 0, replies: 0 });
  assert.equal(context.state.reads.length, 0);
  assert.equal(replyEvents(context.store, original.message.message_id).length, 0);
  context.principals[0].allowed_targets = ["receiver-binding"];
  assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 1 });
});

test("rebinding and adapter replacement while a read is in flight discard the observation without changing delivery", async testContext => {
  for (const replacement of ["binding", "adapter"]) {
    const started = deferred();
    const release = deferred();
    const context = await fixture(testContext, {
      async observeReply(request) { started.resolve(); await release.promise; return nativeReply(request); },
    });
    const original = await context.send(`inflight-${replacement}`);
    const before = context.core.result(original.message.message_id);
    const polling = context.core.pollReplies();
    try {
      await started.promise;
      if (replacement === "binding") context.targets[0].binding_generation += 1;
      else context.adapters["native-adapter"] = { ...context.adapter };
    } finally {
      release.resolve();
    }
    assert.deepEqual(await polling, { checked: 1, replies: 0 });
    assert.deepEqual(context.core.result(original.message.message_id), before);
    assert.equal(replyEvents(context.store, original.message.message_id).length, 0);
  }
});

test("close aborts observation, waits for adapter resource release and never invokes queued observations", async testContext => {
  const started = deferred();
  const aborted = deferred();
  const release = deferred();
  let released = false;
  const context = await fixture(testContext, {
    maxConcurrent: 1,
    async observeReply(request) {
      started.resolve();
      await new Promise(resolve => request.signal.addEventListener("abort", () => { aborted.resolve(); resolve(); }, { once: true }));
      await release.promise;
      released = true;
      return nativeReply(request);
    },
  });
  const originals = [await context.send("close-active"), await context.send("close-queued")];
  const polling = context.core.pollReplies();
  await started.promise;
  let closed = false;
  const closing = context.core.close().then(result => { closed = true; return result; });
  try {
    await aborted.promise;
    await Promise.resolve();
    assert.equal(closed, false);
    assert.equal(released, false);
  } finally {
    release.resolve();
  }
  assert.deepEqual(await polling, { checked: 1, replies: 0 });
  assert.deepEqual(await closing, { closed: true });
  assert.equal(released, true);
  assert.equal(context.state.reads.length, 1);
  assert.equal(context.state.reads[0].signal.reason.code, "closed");
  assert.equal(getEventListeners(context.state.reads[0].signal, "abort").length, 0);
  assert.equal(context.core.replyInvocations.size, 0);
  assert.equal(context.core.controllers.size, 0);
  for (const original of originals) assert.equal(replyEvents(context.store, original.message.message_id).length, 0);
  assert.throws(() => context.core.pollReplies(), error => error.code === "closed");
  assert.deepEqual(await context.core.close(), { closed: true });
});

test("close immediately after poll coalescing prevents the first observer invocation", async testContext => {
  const context = await fixture(testContext, { observeReply: nativeReply });
  const original = await context.send("close-before-observe");
  const polling = context.core.pollReplies();
  await context.core.close();
  assert.deepEqual(await polling, { checked: 0, replies: 0 });
  assert.equal(context.state.reads.length, 0);
  assert.equal(replyEvents(context.store, original.message.message_id).length, 0);
});

test("a timed-out uncooperative observer retains its concurrency slot and close waits for its late resource release", async testContext => {
  const release = deferred();
  const context = await fixture(testContext, {
    maxConcurrent: 1, deliveryTimeoutMs: 20,
    async observeReply(request) { await release.promise; return nativeReply(request); },
  });
  const original = await context.send("late-result");
  try {
    assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 0 });
    assert.equal(context.state.reads[0].signal.aborted, true);
    assert.equal(context.state.reads[0].signal.reason.code, "delivery_timeout");
    assert.deepEqual(await context.core.pollReplies(), { checked: 0, replies: 0 });
    assert.equal(context.state.reads.length, 1);
  } finally {
    release.resolve();
  }
  await context.core.close();
  assert.equal(replyEvents(context.store, original.message.message_id).length, 0);
  assert.equal(context.core.replyInvocations.size, 0);
  assert.equal(context.state.writes.length, 1);
});

test("the default five-second deadline aborts a real HTTP read and a later read succeeds without redelivery", { timeout: 15000 }, async testContext => {
  let available = false;
  let requests = 0;
  let active = 0;
  const server = createServer((request, response) => {
    requests += 1;
    if (available) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ native_message_id: "http-native", text: "真实HTTP只读结果", source_step_index: 1, cascade_id: RECEIVER.conversation_id, trajectory_id: "http-trajectory" }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  testContext.after(async () => {
    const closing = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closing;
  });
  const context = await fixture(testContext, {
    async observeReply({ signal }) {
      active += 1;
      try { return await (await fetch(`http://127.0.0.1:${server.address().port}/reply`, { signal })).json(); }
      finally { active -= 1; }
    },
  });
  const original = await context.send("http-deadline");
  const before = context.core.result(original.message.message_id);
  const beganAt = performance.now();
  assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 0 });
  const elapsedMs = performance.now() - beganAt;
  assert.ok(elapsedMs >= 4900 && elapsedMs < 10000, `actual network deadline: ${elapsedMs}ms`);
  assert.equal(context.state.reads[0].signal.aborted, true);
  assert.equal(context.state.reads[0].signal.reason.code, "delivery_timeout");
  assert.deepEqual(context.core.result(original.message.message_id), before);
  assert.equal(replyEvents(context.store, original.message.message_id).length, 0);
  available = true;
  assert.deepEqual(await context.core.pollReplies(), { checked: 1, replies: 1 });
  await context.core.close();
  assert.equal(active, 0);
  assert.equal(requests, 2);
  assert.equal(replyEvents(context.store, original.message.message_id)[0].data.native_message_id, "http-native");
  assert.deepEqual(context.core.result(original.message.message_id), before);
  assert.equal(context.state.writes.length, 1);
  assert.equal(context.state.queries.length, 0);
  testContext.diagnostic(`default HTTP deadline ${Math.round(elapsedMs)}ms; 2 reads, 1 original delivery, 0 active reads after close`);
});
