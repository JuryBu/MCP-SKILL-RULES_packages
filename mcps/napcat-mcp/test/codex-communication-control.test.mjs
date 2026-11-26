import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createCodexCommunicationControl } from "../src/codex-communication-control.mjs";
import { createCodexCommunicationAttachment } from "../src/codex-communication-attachment.mjs";
import { createCodexCommunicationTransport } from "../src/codex-communication-transport.mjs";
import { createWakeVisibilityAdapter } from "../src/wake-visibility.mjs";
import { createCodexDisplayPolicyManager } from "../src/codex-display-policy.mjs";

const TOKEN = "fixture-only-communication-secret";
const SOURCE = { kind: "agent", host: "antigravity", conversation_id: "source-fixture" };
const TARGET = { host: "codex", conversation_id: "target-fixture" };

function input(overrides = {}) {
  return {
    delivery_id: "delivery-001", message_id: "message-001", binding_generation: 7,
    origin: { ...SOURCE }, target: { ...TARGET }, text: "  fixture message\n\n ",
    delivery_policy: "next_model_boundary", message_visibility: "visible", ...overrides,
  };
}

function humanInput(overrides = {}) {
  const eventId = "a1".repeat(32);
  return input({
    origin: { kind: "human_message", channel: "napcat_owner_reply", source_ref: `owner-event:${eventId}` },
    relay: { host: "codex", conversation_id: "core-fixture" }, in_reply_to: "original-core-message",
    forward_of: { message_id: "original-core-message", delivery_id: "original-core-delivery", native_source: {
      provider: "napcat_owner", route: { route_key: "owner-route", conversation_id: "core-fixture", target_key: "owner-target", generation: 3 },
      original_qq_message_id: "-80001", event: { event_id: eventId, message_id: "80002", message_seq: 0,
        quoted_message_id: "-80001", sender_id: "90001" },
    } }, text: "  [CQ:reply,id=-80001][CQ:at,qq=90001] 本人原文\r\n\t ", ...overrides,
  });
}

const humanOrigins = [{ host: "codex", conversation_id: "core-fixture", owner_reply_channels: ["napcat_owner_reply"] }];
const humanScope = { source_host: "codex", source_conversation_id: "core-fixture" };

test("new omitted visibility is hidden, persists full human provenance and treats explicit defaults idempotently", async context => {
  const state = await fixture(context, undefined, { allowedOrigins: humanOrigins });
  const value = humanInput();
  delete value.message_visibility;
  const first = await state.post(value);
  assert.equal(first.status, 200);
  assert.equal(first.body.delivery.message_visibility, "hidden");
  for (const key of ["origin", "relay", "forward_of", "in_reply_to", "text"]) assert.deepEqual(first.body.delivery[key], value[key]);
  const saved = fs.readFileSync(state.ledgerPath);
  assert.equal((await state.post({ ...value, message_visibility: "hidden" })).status, 200);
  assert.equal((await state.post({ ...value, message_visibility: "visible", retry_failed_before_send: true })).status, 409);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), saved);
  const read = await state.get(value.delivery_id, humanScope);
  assert.equal(read.body.delivery.message_visibility, "hidden");
  assert.deepEqual(read.body.delivery.forward_of, value.forward_of);
});

test("historical missing visibility preserves digest and bytes, reads visible and never resends on a new hidden default", async context => {
  const state = await fixture(context);
  await state.post();
  await state.control.close();
  const document = JSON.parse(fs.readFileSync(state.ledgerPath, "utf8"));
  delete document.deliveries[0].message_visibility;
  delete document.deliveries[0].agent_render_variant;
  const payload = input();
  delete payload.message_visibility;
  document.deliveries[0].digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  fs.writeFileSync(state.ledgerPath, JSON.stringify(document));
  const original = fs.readFileSync(state.ledgerPath);
  const reopened = state.create();
  const address = await reopened.start();
  const read = await state.get(undefined, {}, address);
  assert.equal(read.status, 200);
  assert.equal(read.body.delivery.message_visibility, "visible");
  assert.equal((await state.post(input(), {}, address)).status, 200);
  assert.equal((await state.post(payload, {}, address)).status, 409);
  assert.equal((await state.post(input({ message_visibility: "hidden", retry_failed_before_send: true }), {}, address)).status, 409);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), original);
});

test("hidden native binding is saved only in communication ledger and lazily queried after opening without rewriting records", async context => {
  const sources = [];
  const itemKey = JSON.stringify([TARGET.conversation_id, "turn-fixture", "hidden-item"]);
  const transport = {
    async inspectAndDispatch(payload, hooks) {
      await hooks.beforeMutation({ injection_method: "turn/steer", turn_id: "turn-fixture" });
      assert.equal(hooks.onVisibilityBound({ itemKey, turnId: "turn-fixture" }), true);
      return result(payload, { injection_method: "turn/steer" });
    },
    restoreVisibility: () => assert.fail("opening must not eagerly restore every historical delivery"),
    setVisibilitySource: source => sources.push(source),
  };
  const state = await fixture(context, undefined, { transport });
  assert.equal(sources.length, 1);
  const value = input({ message_visibility: "hidden" });
  const accepted = await state.post(value);
  assert.equal(Object.hasOwn(accepted.body.delivery, "visibility_item_key"), false);
  const saved = fs.readFileSync(state.ledgerPath);
  assert.equal(JSON.parse(saved).deliveries[0].visibility_item_key, itemKey);
  assert.equal(JSON.parse(saved).deliveries[0].agent_render_variant, "agent-priority-notice-v1");
  assert.equal(JSON.parse(saved).deliveries[0].digest, createHash("sha256").update(JSON.stringify(["agent-priority-notice-v1", value])).digest("hex"));
  await state.control.close();
  const reopened = state.create();
  await reopened.start();
  assert.equal(sources.length, 2);
  const restored = sources[1].lookup({ itemKey, threadId: TARGET.conversation_id, turnId: "turn-fixture" });
  assert.equal(restored.visibility_item_key, itemKey);
  assert.equal(Object.isFrozen(restored), true);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), saved);
});

test("2050 successful deliveries keep bounded hot projections and cold hidden identities across detach and ledger reload", { timeout: 240000 }, async context => {
  let client = {};
  const turnId = "capacity-turn";
  const savedItems = [];
  let calls = 0;
  let failNext = false;
  let expectedVisible = false;
  let maximumHot = 0;
  let maximumManagers = 0;
  let maximumViews = 0;
  let maximumItems = 0;
  const proxy = {
    wakeVisibility: createWakeVisibilityAdapter(), displayPolicy: createCodexDisplayPolicyManager(),
    _liveReadyClients: () => [client], _liveMaintenanceStatus: () => ({ active: false }),
    async subscribeThread() { return { threadId: TARGET.conversation_id, readyClients: [client],
      results: [{ thread: { id: TARGET.conversation_id, status: "active", turns: [{ id: turnId, status: "inProgress" }] } }] }; },
    async _liveInjectRequest(actualClient, method, params) {
      assert.equal(actualClient, client);
      assert.equal(method, "turn/steer");
      calls += 1;
      const item = { id: `capacity-native-${calls}`, type: "userMessage", clientId: params.clientUserMessageId, content: params.input };
      if (calls <= 2 || failNext) savedItems.push(item);
      const message = { method: "item/started", params: { threadId: TARGET.conversation_id, turnId, item } };
      assert.equal(project(message) !== null, expectedVisible);
      if (failNext) { failNext = false; throw Object.assign(new Error("capacity fixture lost receipt"), { outcomeUnknown: true }); }
      return { turnId };
    },
  };
  client.wakeVisibility = proxy.wakeVisibility.createView();
  client.displayPolicy = proxy.displayPolicy.createView();
  function project(message, viewer = client) {
    viewer.displayPolicy.observeUpstream(message);
    const suppressed = viewer.wakeVisibility.shouldSuppress(message);
    const stable = suppressed ? message : viewer.wakeVisibility.project(message);
    return viewer.displayPolicy.project(message, stable, suppressed);
  }
  const transport = createCodexCommunicationTransport(proxy);
  const state = await fixture(context, undefined, { transport });
  const started = Date.now();
  for (let index = 0; index < 2050; index += 1) {
    expectedVisible = index === 1;
    const response = await state.post(input({ delivery_id: `capacity-${index}`,
      message_id: index < 2 ? "capacity-shared-message" : `capacity-message-${index}`,
      message_visibility: expectedVisible ? "visible" : "hidden" }));
    assert.equal(response.status, 200);
    assert.equal(response.body.delivery.outcome, "accepted");
    const snapshot = transport.visibilitySnapshot();
    maximumHot = Math.max(maximumHot, snapshot.hotEntries);
    maximumManagers = Math.max(maximumManagers, snapshot.managers);
    maximumViews = Math.max(maximumViews, snapshot.cachedViews);
    maximumItems = Math.max(maximumItems, snapshot.itemIndex);
    assert.ok(snapshot.hotEntries <= snapshot.cacheLimit);
    assert.ok(snapshot.managers <= snapshot.cacheLimit);
    assert.ok(snapshot.cachedViews <= snapshot.cacheLimit * snapshot.activeViews);
    assert.ok(snapshot.itemIndex <= snapshot.cacheLimit);
    assert.equal(snapshot.retainedPromptChars, 0);
    if (index === 1) {
      const firstKey = JSON.parse(fs.readFileSync(state.ledgerPath, "utf8")).deliveries[0].visibility_item_key;
      assert.equal(firstKey, JSON.stringify([TARGET.conversation_id, turnId, savedItems[0].id]));
      const dynamic = { wakeVisibility: proxy.wakeVisibility.createView(), displayPolicy: proxy.displayPolicy.createView() };
      for (const viewer of [client, dynamic]) {
        const request = { id: "live-then-null-history", method: "thread/read", params: { threadId: TARGET.conversation_id } };
        viewer.wakeVisibility.observeRequest(request);
        viewer.displayPolicy.observeRequest(request);
        const opening = { id: "ordinary-opening", type: "userMessage", clientId: "human", content: [{ type: "text", text: "opening" }] };
        const response = { id: request.id, result: { thread: { id: TARGET.conversation_id, turns: [{ id: turnId,
          items: [opening, { ...savedItems[0], clientId: null }, { ...savedItems[1], clientId: null }] }] } } };
        assert.deepEqual(project(response, viewer).result.thread.turns[0].items.map(item => item.id), [opening.id, savedItems[1].id]);
      }
      dynamic.wakeVisibility.close();
      dynamic.displayPolicy.close();
    }
  }
  assert.equal(calls, 2050);
  assert.equal(savedItems[0].content[0].text, savedItems[1].content[0].text);
  assert.ok(transport.visibilitySnapshot().evictions >= 2050 - transport.visibilitySnapshot().cacheLimit);
  failNext = true;
  expectedVisible = false;
  const uncertainInput = input({ delivery_id: "capacity-unknown", message_id: "capacity-unknown-message", message_visibility: "hidden" });
  assert.equal((await state.post(uncertainInput)).body.delivery.outcome, "unknown");
  assert.equal(calls, 2051);
  const persisted = JSON.parse(fs.readFileSync(state.ledgerPath, "utf8"));
  const unknown = persisted.deliveries.find(record => record.delivery_id === uncertainInput.delivery_id);
  assert.equal(unknown.status, "unknown");
  assert.ok(unknown.visibility_item_key);
  await state.control.close();
  const fileBeforeReload = fs.readFileSync(state.ledgerPath);
  const resumedTransport = createCodexCommunicationTransport(proxy);
  const resumed = state.create({ transport: resumedTransport });
  const address = await resumed.start();
  assert.deepEqual(fs.readFileSync(state.ledgerPath), fileBeforeReload);
  assert.equal(resumedTransport.visibilitySnapshot().hotEntries, 0);
  assert.equal(resumedTransport.visibilitySnapshot().managers, 0);
  const request = { id: "capacity-history", method: "thread/items/list", params: { threadId: TARGET.conversation_id, turnId } };
  client.wakeVisibility.observeRequest(request);
  client.displayPolicy.observeRequest(request);
  const oldHidden = { ...savedItems[0], clientId: null };
  const oldVisible = { ...savedItems[1], clientId: null };
  const unknownItem = { ...savedItems[2], clientId: null };
  const copied = { ...oldHidden, id: "ordinary-copy", clientId: "human-client" };
  const reply = { id: request.id, result: { data: [oldHidden, oldVisible, unknownItem, copied].map(item => ({ turnId, item })), nextCursor: "capacity-next" } };
  const beforeHistory = resumedTransport.visibilitySnapshot();
  const history = project(reply);
  const afterHistory = resumedTransport.visibilitySnapshot();
  assert.deepEqual(history.result.data.map(entry => entry.item.id), [oldVisible.id, copied.id]);
  assert.equal(history.result.nextCursor, "capacity-next");
  assert.equal(afterHistory.inspectedItems - beforeHistory.inspectedItems, 4);
  assert.equal(afterHistory.coldLookups - beforeHistory.coldLookups, 4);
  const beforeOrdinary = resumedTransport.visibilitySnapshot();
  for (let index = 0; index < 1000; index += 1) {
    assert.ok(project({ method: "item/started", params: { threadId: TARGET.conversation_id, turnId,
      item: { ...copied, id: `ordinary-${index}` } } }));
    assert.ok(project({ method: "item/completed", params: { threadId: TARGET.conversation_id, turnId,
      item: { id: `tool-${index}`, type: "functionCall", name: "fixture" } } }));
  }
  const afterOrdinary = resumedTransport.visibilitySnapshot();
  assert.equal(afterOrdinary.coldLookups - beforeOrdinary.coldLookups, 1000);
  assert.equal(afterOrdinary.managersCreated, beforeOrdinary.managersCreated);
  assert.equal(afterOrdinary.hotEntries, beforeOrdinary.hotEntries);
  assert.equal((await state.post(uncertainInput, {}, address)).body.delivery.outcome, "unknown");
  assert.equal(calls, 2051);
  const continued = await state.post(input({ delivery_id: "capacity-2050", message_id: "capacity-message-2050", message_visibility: "hidden" }), {}, address);
  assert.equal(continued.body.delivery.outcome, "accepted");
  assert.equal(calls, 2052);
  assert.equal(JSON.parse(fs.readFileSync(state.ledgerPath, "utf8")).deliveries.find(record => record.delivery_id === uncertainInput.delivery_id).status, "unknown");
  await resumed.close();
  client.wakeVisibility.close();
  client.displayPolicy.close();
  client = {};
  const freshProxy = { ...proxy, wakeVisibility: createWakeVisibilityAdapter(), displayPolicy: createCodexDisplayPolicyManager() };
  client.wakeVisibility = freshProxy.wakeVisibility.createView();
  client.displayPolicy = freshProxy.displayPolicy.createView();
  const freshTransport = createCodexCommunicationTransport(freshProxy);
  const freshControl = state.create({ transport: freshTransport });
  const freshAddress = await freshControl.start();
  assert.equal(freshTransport.visibilitySnapshot().hotEntries, 0);
  assert.equal(freshTransport.visibilitySnapshot().managers, 0);
  const cold = project({ method: "item/started", params: { threadId: TARGET.conversation_id, turnId, item: oldHidden } });
  assert.equal(cold, null);
  const afterFresh = await state.post(input({ delivery_id: "capacity-2051", message_id: "capacity-message-2051", message_visibility: "hidden" }), {}, freshAddress);
  assert.equal(afterFresh.body.delivery.outcome, "accepted");
  assert.equal(calls, 2053);
  const metrics = { successfulDeliveries: 2052, nativeCalls: calls, unknownRecordsPreserved: 1,
    maximumHot, maximumManagers, maximumViews, maximumItems, historyItemsProcessed: 4,
    unrelatedUserLookups: afterOrdinary.coldLookups - beforeOrdinary.coldLookups,
    unrelatedManagersCreated: afterOrdinary.managersCreated - beforeOrdinary.managersCreated,
    elapsedMs: Date.now() - started, freshRuntime: true, final: freshTransport.visibilitySnapshot() };
  if (process.env.COMMUNICATION_CAPACITY_METRICS) fs.writeFileSync(process.env.COMMUNICATION_CAPACITY_METRICS, JSON.stringify(metrics, null, 2), "utf8");
  context.diagnostic(JSON.stringify(metrics));
  context.after(() => { client.wakeVisibility.close(); client.displayPolicy.close(); });
});

test("historical human record with missing visibility keeps its original digest, provenance and visible GET without resending", async context => {
  const state = await fixture(context, undefined, { allowedOrigins: humanOrigins });
  const value = humanInput();
  await state.post(value);
  await state.control.close();
  const document = JSON.parse(fs.readFileSync(state.ledgerPath, "utf8"));
  delete value.message_visibility;
  delete document.deliveries[0].message_visibility;
  document.deliveries[0].digest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  fs.writeFileSync(state.ledgerPath, JSON.stringify(document));
  const original = fs.readFileSync(state.ledgerPath);
  const reopened = state.create();
  const address = await reopened.start();
  const read = await state.get(value.delivery_id, humanScope, address);
  assert.equal(read.status, 200);
  assert.equal(read.body.delivery.message_visibility, "visible");
  assert.deepEqual(read.body.delivery.forward_of, value.forward_of);
  assert.equal((await state.post({ ...value, message_visibility: "visible" }, {}, address)).status, 200);
  assert.equal((await state.post(value, {}, address)).status, 409);
  assert.equal(state.calls.length, 1);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), original);
});

function result(payload, overrides = {}) {
  return {
    outcome: "accepted", injection_method: "turn/start", thread_id: payload.target.conversation_id,
    turn_id: "turn-fixture", request_sent: true, ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(context, dispatch, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-communication-test-"));
  const ledgerPath = path.join(root, "ledger.json");
  const calls = [];
  const instances = [];
  const settings = {
    host: "127.0.0.1", port: 0, token: TOKEN, principalId: "issuer-fixture",
    allowedOrigins: [{ host: SOURCE.host, conversation_id: SOURCE.conversation_id }],
    allowedTargets: [{ conversation_id: TARGET.conversation_id, binding_generation: 7 }],
    ledgerPath, now: () => new Date("2026-11-15T10:30:00.000Z"),
    transport: {
      async inspectAndDispatch(payload, hooks) {
        calls.push(payload);
        if (dispatch) return dispatch(payload, hooks, calls.length);
        await hooks.beforeMutation();
        return result(payload);
      },
    },
    ...overrides,
  };
  function create(extra = {}) {
    const control = createCodexCommunicationControl({ ...settings, ...extra });
    instances.push(control);
    return control;
  }
  context.after(async () => {
    for (const instance of instances) await instance.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const control = create();
  const address = await control.start();
  function request(method, pathname, body, headers = {}, destination = address) {
    return new Promise((resolve, reject) => {
      const serialized = body === undefined ? undefined : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      const connection = http.request({
        host: destination.host, port: destination.port, method, path: pathname,
        headers: {
          authorization: `Bearer ${TOKEN}`, ...(serialized === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        }, agent: false,
      }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        response.on("error", reject);
      });
      connection.on("error", reject);
      connection.end(serialized);
    });
  }
  const post = (body = input(), headers, destination) => request("POST", "/v1/communication/deliveries", body, headers, destination);
  const queryPath = (deliveryId = "delivery-001", changes = {}) => `/v1/communication/deliveries/${encodeURIComponent(deliveryId)}?${new URLSearchParams({
    source_host: SOURCE.host, source_conversation_id: SOURCE.conversation_id,
    target_conversation_id: TARGET.conversation_id, binding_generation: "7", ...changes,
  })}`;
  const get = (deliveryId, changes, destination) => request("GET", queryPath(deliveryId, changes), undefined, {}, destination);
  return { root, ledgerPath, calls, control, address, create, request, post, get, queryPath, settings };
}

test("authentication, agent-only origins, exact targets and generations reject before creating a record", async context => {
  const current = await fixture(context);
  const cases = [
    [input(), { authorization: "Bearer wrong" }, 401],
    [input(), { authorization: "" }, 401],
    [input({ origin: { ...SOURCE, kind: "qq" } }), {}, 403],
    [input({ origin: { ...SOURCE, host: "qq" } }), {}, 403],
    [input({ origin: { ...SOURCE, conversation_id: "stranger" } }), {}, 403],
    [input({ target: { ...TARGET, conversation_id: "stranger" } }), {}, 403],
    [input({ target: { ...TARGET, host: "windsurf" } }), {}, 403],
    [input({ binding_generation: 6 }), {}, 409],
    [input({ message_visibility: "invalid" }), {}, 422],
  ];
  for (const [body, headers, status] of cases) assert.equal((await current.post(body, headers)).status, status);
  assert.equal(current.calls.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(current.ledgerPath, "utf8")).deliveries, []);
  assert.equal((await current.get()).status, 404);
});

test("HTTP JSON boundary is bounded and validates options without acquiring locks", async context => {
  const current = await fixture(context, undefined, { maxBodyBytes: 1024 });
  assert.equal((await current.post(input(), { "content-type": "text/plain" })).status, 415);
  assert.equal((await current.post("{")).status, 400);
  assert.equal((await current.post(input({ text: "x".repeat(2048) }))).status, 413);
  assert.equal((await current.post(input({ text: "x".repeat(2048) }), { "transfer-encoding": "chunked" })).status, 413);
  assert.equal((await current.post(Buffer.from([123, 255, 125]))).status, 400);
  assert.equal((await current.post(input({ unexpected: true }))).status, 400);
  const poisoned = JSON.stringify(input()).replace('"origin":{', '"origin":{"__proto__":{"polluted":true},');
  assert.equal((await current.post(poisoned)).status, 400);
  for (const options of [{ host: "0.0.0.0" }, { host: "localhost" }, { token: "" }, { principalId: "bad id" }, { transport: {} }]) {
    assert.throws(() => createCodexCommunicationControl({ ...current.settings, ledgerPath: path.join(current.root, "unused.json"), ...options }));
  }
  assert.equal(fs.existsSync(path.join(current.root, "unused.json.lock")), false);
  assert.equal(current.calls.length, 0);
});

test("prepared precedes inspection and durable dispatching precedes mutation; accepted records keep exact source and whitespace", async context => {
  let current;
  current = await fixture(context, async (payload, { beforeMutation }) => {
    const read = () => JSON.parse(fs.readFileSync(current.ledgerPath, "utf8")).deliveries[0];
    assert.equal(read().status, "prepared");
    await beforeMutation();
    await beforeMutation();
    assert.equal(read().status, "dispatching");
    const lookup = await current.get();
    assert.equal(lookup.body.delivery.status, "dispatching");
    return result(payload);
  });
  const response = await current.post();
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  const delivery = response.body.delivery;
  for (const [key, value] of Object.entries(input())) assert.deepEqual(delivery[key], value);
  assert.equal(current.calls[0].text, input().text);
  assert.equal(delivery.status, "confirmed");
  assert.equal(delivery.outcome, "accepted");
  assert.deepEqual(delivery.evidence, { adapter_accepted: "observed", model_observed: "unknown", ui_observed: "unknown", processing: "unknown" });
  assert.deepEqual((await current.get()).body.delivery, delivery);
  const durable = JSON.parse(fs.readFileSync(current.ledgerPath, "utf8")).deliveries[0];
  assert.equal(durable.status, "confirmed");
  assert.equal(durable.principal_id, "issuer-fixture");
});

test("concurrent identical IDs share one dispatch and changed stable fields conflict", async context => {
  const entered = deferred();
  const release = deferred();
  const current = await fixture(context, async (payload, { beforeMutation }) => {
    await beforeMutation();
    entered.resolve();
    await release.promise;
    return result(payload);
  });
  const first = current.post();
  await entered.promise;
  const second = current.post();
  assert.equal((await current.post(input({ text: "changed" }))).status, 409);
  release.resolve();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses[0].body, responses[1].body);
  assert.equal(current.calls.length, 1);
  const variations = [
    { text: input().text + " " }, { message_id: "message-changed" }, { binding_generation: 8 },
    { delivery_policy: "when_idle" }, { origin: { ...SOURCE, host: "codex" } },
    { target: { ...TARGET, conversation_id: "another-target" } },
    { origin: { ...SOURCE, kind: "qq" } }, { message_visibility: "hidden" },
  ];
  for (const variation of variations) assert.equal((await current.post(input(variation))).status, 409);
  assert.equal((await current.post()).body.delivery.attempt_count, 1);
  assert.equal(current.calls.length, 1);
});

test("different deliveries to the same target serialize through the whole control call", async context => {
  const firstEntered = deferred();
  const release = deferred();
  const events = [];
  const current = await fixture(context, async (payload, { beforeMutation }, count) => {
    events.push(`inspect:${count}`);
    await beforeMutation();
    if (count === 1) {
      firstEntered.resolve();
      await release.promise;
    } else {
      const prior = JSON.parse(fs.readFileSync(current.ledgerPath, "utf8")).deliveries[0];
      assert.equal(prior.status, "confirmed");
    }
    events.push(`complete:${count}`);
    return result(payload);
  });
  const first = current.post();
  await firstEntered.promise;
  const second = current.post(input({ delivery_id: "delivery-002", message_id: "message-002" }));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(current.calls.length, 1);
  release.resolve();
  assert.ok((await Promise.all([first, second])).every(response => response.status === 200));
  assert.deepEqual(events, ["inspect:1", "complete:1", "inspect:2", "complete:2"]);
});

test("busy and failed-before-send require an explicit original-ID retry and definite request_sent false", async context => {
  const current = await fixture(context, async (payload, { beforeMutation }, count) => {
    if (count < 3) return result(payload, { outcome: count === 1 ? "busy" : "failed_before_send", request_sent: false, injection_method: null, turn_id: null });
    await beforeMutation();
    return result(payload, { injection_method: "turn/steer" });
  });
  assert.equal((await current.post()).body.delivery.outcome, "busy");
  assert.equal((await current.post()).body.delivery.outcome, "busy");
  assert.equal(current.calls.length, 1);
  assert.equal((await current.post(input({ retry_failed_before_send: true }))).body.delivery.outcome, "failed_before_send");
  const retried = await current.post(input({ retry_failed_before_send: true }));
  assert.equal(retried.body.delivery.status, "confirmed");
  assert.equal(retried.body.delivery.attempt_count, 3);
  assert.equal((await current.post(input({ retry_failed_before_send: true }))).body.delivery.attempt_count, 3);
  assert.equal(current.calls.length, 3);
});

test("concurrent explicit retries share a single retry attempt", async context => {
  const entered = deferred();
  const release = deferred();
  const current = await fixture(context, async (payload, { beforeMutation }, count) => {
    if (count === 1) return result(payload, { outcome: "busy", request_sent: false, injection_method: null, turn_id: null });
    await beforeMutation();
    entered.resolve();
    await release.promise;
    return result(payload);
  });
  await current.post();
  const first = current.post(input({ retry_failed_before_send: true }));
  await entered.promise;
  const second = current.post(input({ retry_failed_before_send: true }));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(current.calls.length, 2);
  release.resolve();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses[0].body, responses[1].body);
  assert.equal(responses[0].body.delivery.attempt_count, 2);
  assert.equal(current.calls.length, 2);
});

test("different targets can dispatch independently without losing either ledger record", async context => {
  const entered = deferred();
  const release = deferred();
  const current = await fixture(context, async (payload, { beforeMutation }, count) => {
    await beforeMutation();
    if (count === 1) {
      entered.resolve();
      await release.promise;
    }
    return result(payload);
  }, { allowedTargets: [{ conversation_id: TARGET.conversation_id, binding_generation: 7 }, { conversation_id: "target-other", binding_generation: 9 }] });
  const first = current.post();
  await entered.promise;
  const second = await current.post(input({ delivery_id: "delivery-002", message_id: "message-002", target: { host: "codex", conversation_id: "target-other" }, binding_generation: 9 }));
  assert.equal(second.body.delivery.status, "confirmed");
  assert.equal((await current.get()).body.delivery.status, "dispatching");
  release.resolve();
  await first;
  const records = JSON.parse(fs.readFileSync(current.ledgerPath, "utf8")).deliveries;
  assert.equal(records.length, 2);
  assert.ok(records.every(record => record.status === "confirmed"));
});

test("unknown outcomes are queryable, immutable under retries, and cannot be resent with a new delivery ID", async context => {
  const current = await fixture(context, async (payload, { beforeMutation }) => {
    await beforeMutation();
    return result(payload, { outcome: "unknown", request_sent: null, turn_id: null });
  });
  const first = await current.post();
  assert.equal(first.body.delivery.status, "unknown");
  assert.equal(first.body.delivery.evidence.adapter_accepted, "unknown");
  assert.deepEqual((await current.post(input({ retry_failed_before_send: true }))).body, first.body);
  assert.equal((await current.post(input({ delivery_id: "replacement-delivery" }))).status, 409);
  assert.deepEqual((await current.get()).body, first.body);
  assert.equal(current.calls.length, 1);
});

test("transport exceptions and false accepted results remain unknown instead of confirmed or retried", async context => {
  let count = 0;
  const current = await fixture(context, async payload => {
    count += 1;
    if (count === 1) throw new Error("transport closed");
    return result(payload);
  });
  assert.equal((await current.post()).body.delivery.outcome, "unknown");
  assert.equal((await current.post(input({ retry_failed_before_send: true }))).body.delivery.outcome, "unknown");
  const invalid = await current.post(input({ delivery_id: "delivery-002", message_id: "message-002" }));
  assert.equal(invalid.body.delivery.outcome, "unknown");
  assert.equal(invalid.body.delivery.error.code, "transport_contract_violation");
  assert.equal(current.calls.length, 2);
});

test("a lost POST response is recovered by exact GET with the original delivery ID", async context => {
  const entered = deferred();
  const release = deferred();
  const completed = deferred();
  const current = await fixture(context, async (payload, { beforeMutation }) => {
    await beforeMutation();
    entered.resolve();
    await release.promise;
    completed.resolve();
    return result(payload);
  });
  const connection = http.request({ host: current.address.host, port: current.address.port, path: "/v1/communication/deliveries", method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } });
  connection.on("error", () => {});
  connection.end(JSON.stringify(input()));
  await entered.promise;
  connection.destroy();
  release.resolve();
  await completed.promise;
  const recovered = await current.get();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.delivery.status, "confirmed");
  assert.equal(current.calls.length, 1);
});

test("exact GET rejects other source, target, generation and authenticated principal", async context => {
  const current = await fixture(context);
  await current.post();
  for (const changes of [{ source_host: "codex" }, { source_conversation_id: "other-source" }, { target_conversation_id: "other-target" }, { binding_generation: "8" }]) {
    assert.equal((await current.get(undefined, changes)).status, 403);
  }
  assert.equal((await current.request("GET", current.queryPath() + "&binding_generation=7")).status, 400);
  assert.equal((await current.get("absent")).status, 404);
  await current.control.close();
  const other = current.create({ principalId: "other-issuer" });
  const address = await other.start();
  assert.equal((await current.get(undefined, undefined, address)).status, 403);
  assert.equal((await current.post(input(), {}, address)).status, 403);
});

test("prototype-like IDs use data entries and corrupt or duplicate ledger entries fail closed", async context => {
  const current = await fixture(context);
  assert.equal((await current.post(input({ delivery_id: "__proto__", message_id: "constructor" }))).body.delivery.status, "confirmed");
  assert.equal((await current.get("__proto__")).body.delivery.delivery_id, "__proto__");
  assert.equal({}.polluted, undefined);
  await current.control.close();
  const valid = fs.readFileSync(current.ledgerPath, "utf8");
  const data = JSON.parse(valid);
  for (const serialized of ["{", '{"version":1,"deliveries":[],"__proto__":{"polluted":true}}', JSON.stringify({ ...data, deliveries: [...data.deliveries, data.deliveries[0]] }), valid.replace('"confirmed"', '"prepared"')]) {
    fs.writeFileSync(current.ledgerPath, serialized, "utf8");
    const broken = current.create();
    await assert.rejects(broken.start(), { code: "ledger_invalid" });
    assert.equal(fs.existsSync(`${current.ledgerPath}.lock`), false);
    await broken.close();
  }
});

test("reopening prepared or dispatching crash records makes them permanently unknown without dispatch", async context => {
  const current = await fixture(context);
  await current.post();
  await current.control.close();
  const valid = JSON.parse(fs.readFileSync(current.ledgerPath, "utf8"));
  for (const status of ["prepared", "dispatching"]) {
    const data = structuredClone(valid);
    Object.assign(data.deliveries[0], { status, outcome: null, request_sent: null, injection_method: null, turn_id: null, evidence: { adapter_accepted: "unknown", model_observed: "unknown", ui_observed: "unknown", processing: "unknown" } });
    fs.writeFileSync(current.ledgerPath, JSON.stringify(data), "utf8");
    const reopened = current.create();
    const address = await reopened.start();
    assert.equal((await current.get(undefined, undefined, address)).body.delivery.status, "unknown");
    assert.equal((await current.post(input({ retry_failed_before_send: true }), {}, address)).body.delivery.status, "unknown");
    assert.equal((await current.post(input({ delivery_id: "new-delivery" }), {}, address)).status, 409);
    assert.equal(JSON.parse(fs.readFileSync(current.ledgerPath, "utf8")).deliveries[0].status, "unknown");
    await reopened.close();
  }
  assert.equal(current.calls.length, 1);
});

test("ledger locks exclude other processes and failed competitors do not release the owner's lock", async context => {
  const current = await fixture(context);
  const lockPath = `${current.ledgerPath}.lock`;
  const owner = fs.readFileSync(lockPath, "utf8");
  const competitor = current.create();
  await assert.rejects(competitor.start(), { code: "ledger_locked" });
  await competitor.close();
  assert.equal(fs.readFileSync(lockPath, "utf8"), owner);
  const moduleUrl = pathToFileURL(path.resolve("src/codex-communication-control.mjs")).href;
  const childSettings = { ...current.settings, transport: undefined, now: undefined };
  const program = `import { createCodexCommunicationControl } from ${JSON.stringify(moduleUrl)}; const control = createCodexCommunicationControl({ ...${JSON.stringify(childSettings)}, transport: { inspectAndDispatch() { throw Error('must not dispatch'); } } }); try { await control.start(); process.exitCode=1; } catch(error) { console.log(error.code); } finally { await control.close(); }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", program], { windowsHide: true });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(exitCode, 0);
  assert.equal(output.trim(), "ledger_locked");
  assert.equal(fs.readFileSync(lockPath, "utf8"), owner);
  await current.control.close();
  assert.equal(fs.existsSync(lockPath), false);
  const reopened = current.create();
  await reopened.start();
});

test("accepted-result persistence failures are unknown and block retries even after reopening", async context => {
  let failRename = false;
  let current;
  current = await fixture(context, async (payload, { beforeMutation }) => {
    await beforeMutation();
    failRename = true;
    return result(payload);
  });
  const original = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (failRename && destination === current.ledgerPath) throw Object.assign(new Error("fixture disk failure"), { code: "EIO" });
    return original(source, destination);
  };
  try {
    const failed = await current.post();
    assert.equal(failed.body.delivery.status, "unknown");
    assert.equal(failed.body.delivery.error.code, "ledger_write_failed");
    assert.equal((await current.post(input({ retry_failed_before_send: true }))).body.delivery.status, "unknown");
    assert.equal((await current.get()).body.delivery.status, "unknown");
    assert.equal((await current.post(input({ delivery_id: "new-delivery" }))).status, 409);
    assert.equal((await current.post(input({ delivery_id: "other", message_id: "other" }))).status, 503);
    assert.equal(current.calls.length, 1);
  } finally {
    fs.renameSync = original;
  }
  await current.control.close();
  const reopened = current.create();
  const address = await reopened.start();
  assert.equal((await current.get(undefined, undefined, address)).body.delivery.status, "unknown");
  assert.equal((await current.post(input({ retry_failed_before_send: true }), {}, address)).body.delivery.status, "unknown");
  assert.equal(current.calls.length, 1);
});

test("prepared and dispatching persistence failures prevent all transport mutations", async context => {
  for (const failAt of [1, 2]) {
    let mutations = 0;
    const current = await fixture(context, async (payload, { beforeMutation }) => {
      await beforeMutation();
      mutations += 1;
      return result(payload);
    });
    const original = fs.renameSync;
    let writes = 0;
    fs.renameSync = (source, destination) => {
      if (destination === current.ledgerPath && ++writes >= failAt) throw Object.assign(new Error("fixture write failure"), { code: "EIO" });
      return original(source, destination);
    };
    try {
      const response = await current.post();
      assert.equal(response.body.delivery.status, "unknown");
      assert.equal(response.body.delivery.error.code, "ledger_write_failed");
      assert.equal(mutations, 0);
      assert.equal(current.calls.length, failAt - 1);
      assert.equal((await current.post(input({ retry_failed_before_send: true }))).body.delivery.status, "unknown");
    } finally {
      fs.renameSync = original;
    }
    await current.control.close();
  }
});

test("an unchanged original delivery remains queryable after the allowed binding rotates", async context => {
  const current = await fixture(context);
  const original = await current.post();
  await current.control.close();
  const rotated = current.create({ allowedTargets: [{ conversation_id: TARGET.conversation_id, binding_generation: 8 }] });
  const address = await rotated.start();
  assert.deepEqual((await current.get(undefined, undefined, address)).body, original.body);
  assert.deepEqual((await current.post(input(), {}, address)).body, original.body);
  assert.equal((await current.post(input({ delivery_id: "new-id", message_id: "new-message" }), {}, address)).status, 409);
  assert.equal(current.calls.length, 1);
});

test("close waits for in-flight dispatch, closes its listener, and only then releases the ledger lock", async context => {
  const entered = deferred();
  const release = deferred();
  const current = await fixture(context, async (payload, { beforeMutation }) => {
    await beforeMutation();
    entered.resolve();
    await release.promise;
    return result(payload);
  });
  const pending = current.post();
  await entered.promise;
  let closed = false;
  const closing = current.control.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(closed, false);
  assert.equal(fs.existsSync(`${current.ledgerPath}.lock`), true);
  const competitor = current.create();
  await assert.rejects(competitor.start(), { code: "ledger_locked" });
  release.resolve();
  assert.equal((await pending).body.delivery.status, "confirmed");
  await closing;
  assert.equal(fs.existsSync(`${current.ledgerPath}.lock`), false);
  await assert.rejects(current.get(), { code: "ECONNREFUSED" });
  assert.equal(JSON.parse(fs.readFileSync(current.ledgerPath, "utf8")).deliveries[0].status, "confirmed");
});

test("listener startup failure releases its own lock and never steals a preexisting stale lock", async context => {
  const current = await fixture(context);
  const otherPath = path.join(current.root, "other-ledger.json");
  const conflict = current.create({ ledgerPath: otherPath, port: current.address.port });
  await assert.rejects(conflict.start(), { code: "EADDRINUSE" });
  assert.equal(fs.existsSync(`${otherPath}.lock`), false);
  await current.control.close();
  fs.writeFileSync(`${current.ledgerPath}.lock`, "stale external lock", "utf8");
  const stale = current.create();
  await assert.rejects(stale.start(), { code: "ledger_locked" });
  await stale.close();
  assert.equal(fs.readFileSync(`${current.ledgerPath}.lock`, "utf8"), "stale external lock");
});

test("readonly replies retain authenticated delivery identity and opaque continuation without ledger writes", async context => {
  const reads = [];
  const cursor = { method: "thread/items/list", value: "fixture-page-2", thread_id: TARGET.conversation_id, turn_id: "turn-fixture" };
  const current = await fixture(context, null, { transport: {
    async inspectAndDispatch(payload, hooks) { await hooks.beforeMutation(); return result(payload); },
    async readCompletedReplies(delivery) {
      reads.push(delivery);
      return { outcome: "ok", supported: true, thread_id: delivery.thread_id, turn_id: delivery.turn_id,
        turn_status: "completed", replies: [{ item_id: "reply-1", text: "  reply\n", turn_status: "completed" }],
        partial: !delivery.reply_cursor, cursor: delivery.reply_cursor ? null : cursor };
    },
  } });
  await current.post();
  const saved = fs.readFileSync(current.ledgerPath);
  const route = current.queryPath().replace("?", "/replies?");
  const first = await current.request("GET", route);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.delivery.origin, SOURCE);
  assert.equal(first.body.replies.replies[0].text, "  reply\n");
  assert.deepEqual(JSON.parse(Buffer.from(first.body.replies.cursor, "base64url").toString("utf8")), cursor);
  const next = await current.request("GET", `${route}&cursor=${first.body.replies.cursor}`);
  assert.equal(next.body.replies.partial, false);
  assert.deepEqual(reads[1].reply_cursor, cursor);
  assert.equal((await current.request("GET", route, undefined, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await current.request("GET", route.replace("target-fixture", "stranger"))).status, 403);
  assert.equal((await current.request("GET", `${route}&cursor=invalid`)).status, 400);
  assert.equal((await current.request("GET", `${route}&cursor=e30&cursor=e30`)).status, 400);
  assert.equal(reads.length, 2);
  assert.deepEqual(fs.readFileSync(current.ledgerPath), saved);
});

test("unavailable readonly transport is explicit and generation zero is rejected before sending", async context => {
  const current = await fixture(context);
  assert.equal((await current.post(input({ binding_generation: 0 }))).status, 400);
  assert.equal(current.calls.length, 0);
  await current.post();
  assert.equal((await current.request("GET", current.queryPath().replace("?", "/replies?"))).status, 501);
});

test("an undelivered busy record cannot read the preexisting turn as its own reply", async context => {
  let readCalls = 0;
  const current = await fixture(context, null, { transport: {
    async inspectAndDispatch(payload) { return result(payload, { outcome: "busy", request_sent: false,
      injection_method: null, turn_id: "preexisting-turn" }); },
    async readCompletedReplies() { readCalls += 1; return { outcome: "ok", replies: [{ text: "unrelated private reply" }] }; },
  } });
  const posted = await current.post(input({ delivery_policy: "when_idle" }));
  assert.equal(posted.body.delivery.turn_id, "preexisting-turn");
  const response = await current.request("GET", current.queryPath().replace("?", "/replies?"));
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "delivery_not_accepted");
  assert.equal(readCalls, 0);
});

test("human authorization is explicit, exact and independent of agent permission and bearer", async context => {
  for (const allowedOrigins of [[], [{ host: "codex", conversation_id: "core-fixture" }],
    [{ host: "codex", conversation_id: "core-fixture", owner_reply_channels: [] }],
    [{ host: "codex", conversation_id: "another-core", owner_reply_channels: ["napcat_owner_reply"] }],
    [{ host: SOURCE.host, conversation_id: SOURCE.conversation_id }]]) {
    await context.test(JSON.stringify(allowedOrigins), async child => {
      const state = await fixture(child, undefined, { allowedOrigins });
      assert.equal((await state.post(humanInput())).status, 403);
      assert.equal(state.calls.length, 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(state.ledgerPath, "utf8")).deliveries, []);
    });
  }
  const state = await fixture(context, undefined, { allowedOrigins: humanOrigins });
  assert.equal((await state.post(humanInput(), { authorization: "Bearer wrong" })).status, 401);
  assert.equal(state.calls.length, 0);
  const sent = await state.post(humanInput());
  assert.equal(sent.status, 200);
  assert.equal(sent.body.delivery.status, "confirmed");
  for (const [key, value] of Object.entries(humanInput())) assert.deepEqual(sent.body.delivery[key], value);
  assert.deepEqual(state.calls[0], humanInput());
  assert.equal((await state.post(input({ delivery_id: "agent-core", origin: { kind: "agent", host: "codex", conversation_id: "core-fixture" } }))).status, 200);
});

test("finite human source rejects forged references, hosts, generations and unknown fields before inspection", async context => {
  const state = await fixture(context, undefined, { allowedOrigins: humanOrigins });
  const invalid = [
    body => { body.origin.source_ref = `owner-event:${"b".repeat(64)}`; },
    body => { body.origin.channel = "other"; },
    body => { body.origin.host = "codex"; },
    body => { body.origin.source_ref = ""; },
    body => { body.origin.source_ref = "x".repeat(300); },
    body => { body.in_reply_to = "another-notification"; },
    body => { body.in_reply_to = ""; },
    body => { body.forward_of.message_id = "another-notification"; },
    body => { body.forward_of.delivery_id = "x".repeat(201); },
    body => { body.forward_of.native_source.provider = "other"; },
    body => { body.forward_of.native_source.original_qq_message_id = "0"; },
    body => { body.forward_of.native_source.event.quoted_message_id = "1"; },
    body => { body.forward_of.native_source.route.conversation_id = "another-core"; },
    body => { body.forward_of.native_source.route.route_key = ""; },
    body => { body.forward_of.native_source.route.target_key = "x".repeat(257); },
    body => { body.forward_of.native_source.route.route_key = "x".repeat(257); },
    body => { body.forward_of.native_source.route.route_key = " leading"; },
    body => { body.forward_of.native_source.route.target_key = "invalid\u0000key"; },
    body => { body.forward_of.native_source.route.generation = 0; },
    body => { body.forward_of.native_source.route.generation = Number.MAX_SAFE_INTEGER + 1; },
    body => { body.forward_of.native_source.event.message_seq = -1; },
    body => { body.forward_of.native_source.event.message_seq = Number.MAX_SAFE_INTEGER + 1; },
    body => { body.forward_of.native_source.event.message_id = "1".repeat(21); },
    body => { body.forward_of.native_source.event.message_id = 80002; },
    body => { body.forward_of.native_source.event.sender_id = "01"; },
    body => { body.forward_of.native_source.event.event_id = "A".repeat(64); },
    body => { body.relay.host = "antigravity"; },
    body => { body.relay.conversation_id = "x".repeat(201); },
    body => { body.target.extra = true; },
    body => { body.forward_of.text = "second body"; },
    body => { body.forward_of.native_source.token = "extra"; },
    body => { body.forward_of.native_source.route.source_path = "arbitrary"; },
    body => { body.forward_of.native_source.event.attachment = "binary"; },
    body => { body.relay.extra = true; },
    body => { body.attachment_refs = []; },
    body => { delete body.relay; },
    body => { delete body.forward_of.native_source.event.message_seq; },
  ];
  for (const change of invalid) {
    const body = humanInput();
    change(body);
    assert.equal((await state.post(body)).status, 400, change.toString());
  }
  const stranger = humanInput();
  stranger.relay.conversation_id = stranger.forward_of.native_source.route.conversation_id = "another-core";
  assert.equal((await state.post(stranger)).status, 403);
  assert.equal((await state.post(humanInput({ binding_generation: 6 }))).status, 409);
  for (const field of ["relay", "in_reply_to", "forward_of"]) {
    assert.equal((await state.post(input({ [field]: humanInput()[field] }))).status, 400);
  }
  assert.equal(state.calls.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(state.ledgerPath, "utf8")).deliveries, []);
});

test("owner channel configuration rejects malformed grants without granting other host agents", async context => {
  const state = await fixture(context);
  for (const owner_reply_channels of [null, "napcat_owner_reply", ["other"], ["napcat_owner_reply", "napcat_owner_reply"]]) {
    assert.throws(() => state.create({ allowedOrigins: [{ host: "codex", conversation_id: "core-fixture", owner_reply_channels }] }), /invalid_allowed_origin/);
  }
  for (const host of ["antigravity", "windsurf"]) {
    assert.throws(() => state.create({ allowedOrigins: [{ host, conversation_id: "core-fixture", owner_reply_channels: ["napcat_owner_reply"] }] }), /invalid_allowed_origin/);
  }
});

test("human delivery digest includes every source field and changed provenance conflicts for the original id", async context => {
  const state = await fixture(context, undefined, { allowedOrigins: humanOrigins });
  assert.equal((await state.post(humanInput())).status, 200);
  const changes = [
    body => { body.origin.source_ref = `owner-event:${"b".repeat(64)}`; body.forward_of.native_source.event.event_id = "b".repeat(64); },
    body => { body.forward_of.delivery_id = "another-original-delivery"; },
    body => { body.forward_of.native_source.route.route_key = "another-route"; },
    body => { body.forward_of.native_source.route.target_key = "another-owner"; },
    body => { body.forward_of.native_source.route.generation += 1; },
    body => { body.forward_of.native_source.event.message_id = "80003"; },
    body => { body.forward_of.native_source.event.message_seq += 1; },
    body => { body.forward_of.native_source.event.sender_id = "90002"; },
    body => { body.forward_of.native_source.original_qq_message_id = body.forward_of.native_source.event.quoted_message_id = "80004"; },
    body => { body.in_reply_to = body.forward_of.message_id = "another-notification"; },
    body => { body.relay.conversation_id = body.forward_of.native_source.route.conversation_id = "another-core"; },
  ];
  for (const change of changes) {
    const body = humanInput();
    change(body);
    const response = await state.post(body);
    assert.equal(response.status, 409, change.toString());
    assert.equal(response.body.error.code, "delivery_id_conflict");
  }
  assert.equal((await state.post(humanInput())).body.delivery.attempt_count, 1);
  assert.equal(state.calls.length, 1);
});

test("human records reopen with complete provenance and remain readable after the capability is disabled", async context => {
  const readCalls = [];
  let sent = 0;
  const transport = {
    async inspectAndDispatch(payload, hooks) { sent += 1; await hooks.beforeMutation(); return result(payload); },
    async readCompletedReplies(delivery) { readCalls.push(delivery); return { outcome: "ok", replies: [{ item_id: "reply", text: "answer" }], cursor: null }; },
  };
  const state = await fixture(context, undefined, { allowedOrigins: humanOrigins, transport });
  const delivered = (await state.post(humanInput())).body.delivery;
  const saved = fs.readFileSync(state.ledgerPath);
  await state.control.close();
  const reopened = state.create({ allowedOrigins: [] });
  const address = await reopened.start();
  assert.deepEqual(fs.readFileSync(state.ledgerPath), saved);
  assert.deepEqual((await state.get(undefined, humanScope, address)).body.delivery, delivered);
  assert.equal((await state.post(humanInput(), {}, address)).status, 403);
  const repliesPath = state.queryPath().replace("?", "/replies?");
  assert.equal((await state.request("GET", repliesPath, undefined, {}, address)).status, 403);
  const scopedPath = state.queryPath(undefined, humanScope).replace("?", "/replies?");
  const response = await state.request("GET", scopedPath, undefined, {}, address);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.delivery.origin, humanInput().origin);
  assert.deepEqual(readCalls[0].relay, humanInput().relay);
  assert.deepEqual(readCalls[0].forward_of, humanInput().forward_of);
  for (const changes of [{ source_host: "windsurf" }, { source_conversation_id: "another-core" }, { binding_generation: "8" }]) {
    assert.equal((await state.get(undefined, { ...humanScope, ...changes }, address)).status, 403);
  }
  assert.equal(readCalls.length, 1);
  assert.equal(sent, 1);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), saved);
});

test("human unknown and safe retry states preserve original identities across reopening", async context => {
  for (const outcome of ["unknown", "failed_before_send", "busy"]) await context.test(outcome, async child => {
    const state = await fixture(child, async (payload, hooks, attempt) => {
      if (attempt > 1) { await hooks.beforeMutation(); return result(payload); }
      if (outcome === "unknown") await hooks.beforeMutation();
      return result(payload, { outcome, request_sent: outcome === "unknown" ? null : false, injection_method: null, turn_id: null });
    }, { allowedOrigins: humanOrigins });
    assert.equal((await state.post(humanInput())).body.delivery.outcome, outcome);
    await state.control.close();
    const reopened = state.create();
    const address = await reopened.start();
    assert.equal((await state.post(humanInput(), {}, address)).body.delivery.outcome, outcome);
    const retried = await state.post(humanInput({ retry_failed_before_send: true }), {}, address);
    assert.equal(retried.body.delivery.outcome, outcome === "unknown" ? "unknown" : "accepted");
    assert.deepEqual(retried.body.delivery.forward_of, humanInput().forward_of);
    assert.equal(state.calls.length, outcome === "unknown" ? 1 : 2);
    if (outcome === "unknown") {
      const freshId = await state.post(humanInput({ delivery_id: "new-delivery" }), {}, address);
      assert.equal(freshId.status, 409);
      assert.equal(freshId.body.error.code, "message_delivery_unknown");
      assert.equal(state.calls.length, 1);
    }
  });
});

test("human prepared and dispatching crash recovery retain source and never auto resend", async context => {
  for (const status of ["prepared", "dispatching"]) await context.test(status, async child => {
    const state = await fixture(child, undefined, { allowedOrigins: humanOrigins });
    await state.post(humanInput());
    await state.control.close();
    const ledger = JSON.parse(fs.readFileSync(state.ledgerPath, "utf8"));
    Object.assign(ledger.deliveries[0], { status, outcome: null, request_sent: null, injection_method: null, turn_id: null,
      evidence: { adapter_accepted: "unknown", model_observed: "unknown", ui_observed: "unknown", processing: "unknown" } });
    fs.writeFileSync(state.ledgerPath, JSON.stringify(ledger));
    const reopened = state.create();
    const address = await reopened.start();
    const read = await state.get(undefined, humanScope, address);
    assert.equal(read.body.delivery.outcome, "unknown");
    assert.equal(read.body.delivery.error.code, "restart_outcome_unknown");
    assert.deepEqual(read.body.delivery.forward_of, humanInput().forward_of);
    assert.equal((await state.post(humanInput({ retry_failed_before_send: true }), {}, address)).body.delivery.outcome, "unknown");
    assert.equal(state.calls.length, 1);
  });
});

test("legacy agent payload digest and serialized records remain byte compatible on reopening", async context => {
  const state = await fixture(context, undefined, { writeAgentPriorityNotice: false });
  await state.post();
  const legacyPayload = { delivery_id: "delivery-001", message_id: "message-001", binding_generation: 7,
    origin: { kind: "agent", host: "antigravity", conversation_id: "source-fixture" },
    target: { host: "codex", conversation_id: "target-fixture" }, text: "  fixture message\n\n ",
    delivery_policy: "next_model_boundary", message_visibility: "visible" };
  const original = fs.readFileSync(state.ledgerPath);
  const record = JSON.parse(original).deliveries[0];
  assert.equal(record.digest, createHash("sha256").update(JSON.stringify(legacyPayload)).digest("hex"));
  assert.deepEqual(state.calls[0], legacyPayload);
  assert.equal(Object.hasOwn(record, "relay"), false);
  await state.control.close();
  const reopened = state.create({ allowedOrigins: [] });
  const address = await reopened.start();
  assert.equal((await state.get(undefined, {}, address)).status, 200);
  assert.equal((await state.post(input(), {}, address)).body.delivery.outcome, "accepted");
  assert.deepEqual(fs.readFileSync(state.ledgerPath), original);
  assert.equal(state.calls.length, 1);
});

test("tampered human ledger provenance fails closed even when its capability is absent", async context => {
  const state = await fixture(context, undefined, { allowedOrigins: humanOrigins });
  await state.post(humanInput());
  await state.control.close();
  const ledger = JSON.parse(fs.readFileSync(state.ledgerPath, "utf8"));
  ledger.deliveries[0].forward_of.native_source.event.quoted_message_id = "99999";
  fs.writeFileSync(state.ledgerPath, JSON.stringify(ledger));
  await assert.rejects(state.create({ allowedOrigins: [] }).start(), /ledger_invalid/);
  assert.equal(state.calls.length, 1);
});

test("human finite source accepts provider limits and hashes canonical key order without changing opaque text", async context => {
  const state = await fixture(context, undefined, { allowedOrigins: humanOrigins });
  const body = humanInput();
  body.forward_of.native_source.route.route_key = "路线".repeat(128);
  body.forward_of.native_source.route.target_key = "目标".repeat(128);
  body.forward_of.native_source.route.generation = Number.MAX_SAFE_INTEGER;
  body.forward_of.native_source.original_qq_message_id = body.forward_of.native_source.event.quoted_message_id = `-${"9".repeat(20)}`;
  body.forward_of.native_source.event.message_id = "9".repeat(20);
  body.forward_of.native_source.event.sender_id = "8".repeat(20);
  body.forward_of.native_source.event.message_seq = Number.MAX_SAFE_INTEGER;
  assert.equal((await state.post(body)).body.delivery.outcome, "accepted");
  const reordered = structuredClone(body);
  reordered.origin = { source_ref: body.origin.source_ref, channel: body.origin.channel, kind: body.origin.kind };
  reordered.forward_of.native_source.event = Object.fromEntries(Object.entries(body.forward_of.native_source.event).reverse());
  assert.equal((await state.post(reordered)).body.delivery.attempt_count, 1);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].text, body.text);
});

test("human unknown dedupe uses the exact relay scope rather than missing origin host fields", async context => {
  const allowedOrigins = [...humanOrigins, { host: "codex", conversation_id: "second-core", owner_reply_channels: ["napcat_owner_reply"] }];
  const state = await fixture(context, async (payload, hooks) => {
    await hooks.beforeMutation();
    return result(payload, { outcome: "unknown", request_sent: null, injection_method: null, turn_id: null });
  }, { allowedOrigins });
  assert.equal((await state.post(humanInput())).body.delivery.outcome, "unknown");
  const second = humanInput({ delivery_id: "second-delivery" });
  second.relay.conversation_id = second.forward_of.native_source.route.conversation_id = "second-core";
  assert.equal((await state.post(second)).body.delivery.outcome, "unknown");
  assert.equal(state.calls.length, 2);
  assert.equal((await state.post(humanInput({ delivery_id: "third-delivery" }))).body.error.code, "message_delivery_unknown");
  assert.equal(state.calls.length, 2);
});

test("human concurrent originals and explicit retries share one in-flight mutation", async context => {
  const waiting = deferred();
  let inspecting = false;
  const state = await fixture(context, async (payload, hooks) => {
    inspecting = true;
    await waiting.promise;
    await hooks.beforeMutation();
    return result(payload);
  }, { allowedOrigins: humanOrigins });
  const first = state.post(humanInput());
  while (!inspecting) await new Promise(resolve => setTimeout(resolve, 1));
  const second = state.post(humanInput({ retry_failed_before_send: true }));
  const changed = humanInput();
  changed.forward_of.native_source.event.sender_id = "90002";
  assert.equal((await state.post(changed)).body.error.code, "delivery_id_conflict");
  waiting.resolve();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses[0].body.delivery, responses[1].body.delivery);
  assert.equal(state.calls.length, 1);
});

const HOST_SCOPE_IDENTITY = { machine_id: "host-scope-machine-fixture", surface: "desktop" };

function hostScopeSettings() {
  return {
    allowedOrigins: ["codex", "antigravity"].map(host => ({ scope: "host", ...HOST_SCOPE_IDENTITY, host })),
    allowedTargets: [{ scope: "host", ...HOST_SCOPE_IDENTITY, host: "codex", binding_generation: 7 }],
  };
}

function hostScopeInput(overrides = {}) {
  return input({
    origin: { ...SOURCE, ...HOST_SCOPE_IDENTITY, conversation_id: "new-source-fixture" },
    target: { ...TARGET, ...HOST_SCOPE_IDENTITY, conversation_id: "new-target-fixture" },
    ...overrides,
  });
}

function hostScopeQuery(value = hostScopeInput()) {
  return {
    source_host: value.origin.host, source_conversation_id: value.origin.conversation_id,
    source_machine_id: value.origin.machine_id, source_surface: value.origin.surface,
    target_host: value.target.host, target_conversation_id: value.target.conversation_id,
    target_machine_id: value.target.machine_id, target_surface: value.target.surface,
    binding_generation: String(value.binding_generation),
  };
}

test("host scopes admit fresh concrete CIDs and preserve the actual source and target identities", async context => {
  const state = await fixture(context, undefined, hostScopeSettings());
  for (const host of ["antigravity", "codex"]) {
    const value = hostScopeInput({ delivery_id: `host-scope-${host}`, message_id: `host-message-${host}` });
    value.origin.host = host;
    value.origin.conversation_id = `actual-${host}-source`;
    value.target.conversation_id = `actual-${host}-target`;
    const posted = await state.post(value);
    assert.equal(posted.status, 200);
    assert.equal(posted.body.delivery.outcome, "accepted");
    assert.deepEqual(posted.body.delivery.origin, value.origin);
    assert.deepEqual(posted.body.delivery.target, value.target);
    assert.deepEqual(state.calls.at(-1).origin, value.origin);
    assert.deepEqual((await state.get(value.delivery_id, hostScopeQuery(value))).body.delivery, posted.body.delivery);
  }
  assert.equal(state.calls.length, 2);
});

test("host scopes keep legacy grants exact and never infer a host grant from an old CID", async context => {
  const legacy = await fixture(context);
  assert.equal((await legacy.post(input())).status, 200);
  assert.equal((await legacy.post(input({ delivery_id: "legacy-new-source", origin: { ...SOURCE, conversation_id: "new-source" } }))).status, 403);
  assert.equal((await legacy.post(input({ delivery_id: "legacy-new-target", target: { ...TARGET, conversation_id: "new-target" } }))).status, 403);
  const complete = hostScopeInput({ delivery_id: "full-on-legacy", origin: { ...SOURCE, ...HOST_SCOPE_IDENTITY }, target: { ...TARGET, ...HOST_SCOPE_IDENTITY } });
  assert.equal((await legacy.post(complete)).status, 403);
  assert.equal(legacy.calls.length, 1);
  const scoped = await fixture(context, undefined, hostScopeSettings());
  assert.equal((await scoped.post(input())).status, 403);
  const mixed = await fixture(context, undefined, {
    allowedOrigins: [...hostScopeSettings().allowedOrigins, { host: SOURCE.host, conversation_id: SOURCE.conversation_id }],
    allowedTargets: [...hostScopeSettings().allowedTargets, { conversation_id: TARGET.conversation_id, binding_generation: 7 }],
  });
  assert.equal((await mixed.post(input())).status, 200);
  assert.equal((await mixed.post(hostScopeInput({ delivery_id: "mixed-complete", message_id: "mixed-complete-message" }))).status, 200);
  assert.equal(mixed.calls.length, 2);
});

test("host scopes reject wrong machines hosts and surfaces before ledger or transport mutation", async context => {
  const state = await fixture(context, undefined, hostScopeSettings());
  for (const side of ["origin", "target"]) for (const [field, replacement] of [
    ["machine_id", "unapproved-remote-machine"], ["host", side === "origin" ? "windsurf" : "antigravity"], ["surface", "web"],
  ]) {
    const value = hostScopeInput();
    value[side][field] = replacement;
    const rejected = await state.post(value);
    assert.equal(rejected.status, 403, `${side}.${field}`);
    assert.equal(rejected.body.error.code, side === "origin" ? "origin_not_allowed" : "target_not_allowed");
  }
  assert.equal((await state.post(hostScopeInput({ binding_generation: 8 }))).body.error.code, "binding_generation_mismatch");
  assert.equal(state.calls.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(state.ledgerPath, "utf8")).deliveries, []);
});

test("host scopes reject wildcard actual identities and incomplete machine surface pairs", async context => {
  const state = await fixture(context, undefined, hostScopeSettings());
  for (const side of ["origin", "target"]) {
    for (const field of ["machine_id", "surface", "conversation_id"]) {
      const value = hostScopeInput();
      value[side][field] = "*";
      assert.equal((await state.post(value)).status, 400, `${side}.${field}`);
    }
    for (const field of ["machine_id", "surface"]) {
      const value = hostScopeInput();
      delete value[side][field];
      assert.equal((await state.post(value)).status, 400, `missing ${side}.${field}`);
    }
    const extra = hostScopeInput();
    extra[side].scope = "host";
    assert.equal((await state.post(extra)).status, 400);
  }
  assert.equal(state.calls.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(state.ledgerPath, "utf8")).deliveries, []);
});

test("host scopes validate explicit grants without enabling wildcards other hosts or QQ relays", async context => {
  const state = await fixture(context);
  const origin = hostScopeSettings().allowedOrigins[0];
  const target = hostScopeSettings().allowedTargets[0];
  const invalidOrigins = [
    { ...origin, scope: "all" }, { ...origin, machine_id: "*" }, { ...origin, surface: "*" },
    { ...origin, host: "windsurf" }, { ...origin, surface: "web" }, { ...origin, conversation_id: "*" },
    { ...origin, conversation_id: "concrete-profile-cid" }, { ...origin, owner_reply_channels: ["napcat_owner_reply"] },
    { scope: "host", host: "codex", surface: "desktop" }, { scope: "host", host: "codex", machine_id: origin.machine_id },
  ];
  const invalidTargets = [
    { ...target, scope: "all" }, { ...target, machine_id: "*" }, { ...target, surface: "*" },
    { ...target, host: "antigravity" }, { ...target, surface: "web" }, { ...target, binding_generation: 0 },
    { ...target, conversation_id: "*" }, { ...target, conversation_id: "concrete-profile-cid" },
    { scope: "host", host: "codex", surface: "desktop", binding_generation: 7 },
  ];
  for (const grant of invalidOrigins) assert.throws(() => state.create({ allowedOrigins: [grant] }), /invalid_allowed_origin/);
  for (const grant of invalidTargets) assert.throws(() => state.create({ allowedTargets: [grant] }), /invalid_allowed_target/);
  assert.throws(() => state.create({ allowedTargets: [target, { ...target, binding_generation: 8 }] }), /invalid_allowed_target/);
  const scoped = await fixture(context, undefined, { ...hostScopeSettings(), allowedTargets: state.settings.allowedTargets });
  assert.equal((await scoped.post(humanInput())).status, 403);
  const exactOwner = await fixture(context, undefined, {
    ...hostScopeSettings(), allowedOrigins: [...hostScopeSettings().allowedOrigins, ...humanOrigins], allowedTargets: state.settings.allowedTargets,
  });
  assert.equal((await exactOwner.post(humanInput())).status, 200);
  const wrongOwner = humanInput({ delivery_id: "wrong-owner-relay" });
  wrongOwner.relay.conversation_id = wrongOwner.forward_of.native_source.route.conversation_id = "new-core-fixture";
  assert.equal((await exactOwner.post(wrongOwner)).status, 403);
});

test("host scopes protect GET and replies with the original complete delivery identities and generation", async context => {
  const reads = [];
  const state = await fixture(context, undefined, {
    ...hostScopeSettings(),
    transport: {
      async inspectAndDispatch(payload, hooks) { await hooks.beforeMutation(); return result(payload); },
      async readCompletedReplies(delivery) { reads.push(delivery); return { outcome: "ok", replies: [{ text: "scoped reply" }], cursor: null }; },
    },
  });
  const value = hostScopeInput();
  const posted = await state.post(value);
  assert.equal(posted.status, 200);
  const original = fs.readFileSync(state.ledgerPath);
  const query = hostScopeQuery(value);
  const route = state.queryPath(value.delivery_id, query);
  assert.deepEqual((await state.get(value.delivery_id, query)).body.delivery, posted.body.delivery);
  assert.equal((await state.request("GET", route.replace("?", "/replies?"))).status, 200);
  const changes = {
    source_host: "codex", source_conversation_id: "another-source", source_machine_id: "another-machine", source_surface: "web",
    target_host: "antigravity", target_conversation_id: "another-target", target_machine_id: "another-machine", target_surface: "web",
    binding_generation: "8",
  };
  for (const [field, replacement] of Object.entries(changes)) {
    const changed = state.queryPath(value.delivery_id, { ...query, [field]: replacement });
    assert.equal((await state.request("GET", changed)).status, 403, field);
    assert.equal((await state.request("GET", changed.replace("?", "/replies?"))).status, 403, field);
  }
  assert.equal((await state.get(value.delivery_id, { source_conversation_id: value.origin.conversation_id, target_conversation_id: value.target.conversation_id })).status, 403);
  for (const field of ["source_machine_id", "source_surface", "target_machine_id", "target_surface", "target_host"]) {
    const missing = new URL(route, "http://fixture");
    missing.searchParams.delete(field);
    assert.equal((await state.request("GET", `${missing.pathname}${missing.search}`)).status, 400, `missing ${field}`);
    assert.equal((await state.request("GET", `${route}&${field}=${query[field]}`)).status, 400, `duplicate ${field}`);
    assert.equal((await state.get(value.delivery_id, { ...query, [field]: "*" })).status, 400, `wildcard ${field}`);
  }
  assert.equal((await state.request("GET", `${route}&unknown=true`)).status, 400);
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].origin, value.origin);
  assert.deepEqual(reads[0].target, value.target);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), original);
});

test("host scopes persist canonical full identities without rewriting legacy bytes or resending after rotation", async context => {
  const state = await fixture(context, undefined, hostScopeSettings());
  const value = hostScopeInput();
  const delivered = await state.post(value);
  assert.equal(delivered.status, 200);
  const reordered = structuredClone(value);
  reordered.origin = Object.fromEntries(Object.entries(reordered.origin).reverse());
  reordered.target = Object.fromEntries(Object.entries(reordered.target).reverse());
  assert.equal((await state.post(reordered)).body.delivery.attempt_count, 1);
  for (const side of ["origin", "target"]) for (const field of ["machine_id", "surface", "conversation_id"]) {
    const changed = structuredClone(value);
    changed[side][field] = "another-identity";
    assert.equal((await state.post(changed)).body.error.code, "delivery_id_conflict");
  }
  const saved = fs.readFileSync(state.ledgerPath);
  await state.control.close();
  const rotated = state.create({ allowedOrigins: [], allowedTargets: [{ ...hostScopeSettings().allowedTargets[0], binding_generation: 8 }] });
  const address = await rotated.start();
  assert.deepEqual((await state.get(value.delivery_id, hostScopeQuery(value), address)).body, delivered.body);
  assert.deepEqual((await state.post(value, {}, address)).body, delivered.body);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), saved);
  const other = state.create({ principalId: "other-scoped-principal" });
  await rotated.close();
  const otherAddress = await other.start();
  assert.equal((await state.get(value.delivery_id, hostScopeQuery(value), otherAddress)).status, 403);
  assert.equal(state.calls.length, 1);
});

test("host scopes keep unknown delivery dedupe inside the full machine host surface and target identity", async context => {
  const secondMachine = "second-authorized-fixture-machine";
  const settings = hostScopeSettings();
  settings.allowedOrigins.push({ ...settings.allowedOrigins[1], machine_id: secondMachine });
  settings.allowedTargets.push({ ...settings.allowedTargets[0], machine_id: secondMachine });
  const state = await fixture(context, async (payload, hooks) => {
    await hooks.beforeMutation();
    return result(payload, { outcome: "unknown", request_sent: null, turn_id: null });
  }, settings);
  const first = hostScopeInput();
  assert.equal((await state.post(first)).body.delivery.outcome, "unknown");
  const second = hostScopeInput({ delivery_id: "second-machine-delivery" });
  second.origin.machine_id = secondMachine;
  assert.equal((await state.post(second)).body.delivery.outcome, "unknown");
  const third = structuredClone(second);
  third.delivery_id = "second-target-machine-delivery";
  third.target.machine_id = secondMachine;
  assert.equal((await state.post(third)).body.delivery.outcome, "unknown");
  const same = { ...third, delivery_id: "duplicate-third-delivery" };
  assert.equal((await state.post(same)).body.error.code, "message_delivery_unknown");
  assert.equal((await state.post({ ...first, retry_failed_before_send: true })).body.delivery.outcome, "unknown");
  assert.equal(state.calls.length, 3);
});

test("host scopes pass through the existing attachment configuration into isolated native transport", async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-host-scope-attachment-"));
  const tokenFile = path.join(root, "token.txt");
  const configPath = path.join(root, "control.json");
  const client = {};
  const nativeCalls = [];
  const value = hostScopeInput();
  const proxy = {
    wakeVisibility: createWakeVisibilityAdapter(), displayPolicy: createCodexDisplayPolicyManager(),
    _liveReadyClients: () => [client], _liveMaintenanceStatus: () => ({ active: false }),
    async subscribeThread(threadId) {
      return { threadId, readyClients: [client], results: [{ thread: { id: threadId, status: "idle", turns: [] } }] };
    },
    async _liveInjectRequest(actualClient, method, params) {
      assert.equal(actualClient, client);
      nativeCalls.push({ method, params });
      return { turn: { id: "host-scope-native-turn" } };
    },
  };
  client.wakeVisibility = proxy.wakeVisibility.createView();
  client.displayPolicy = proxy.displayPolicy.createView();
  const attachment = createCodexCommunicationAttachment(proxy);
  context.after(async () => {
    await attachment.close();
    client.wakeVisibility.close();
    client.displayPolicy.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const settings = hostScopeSettings();
  fs.writeFileSync(tokenFile, TOKEN, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(configPath, JSON.stringify({ host: "127.0.0.1", port: 0, token_file: tokenFile,
    ledger_path: path.join(root, "ledger.json"), principal_id: "host-scope-attachment-principal",
    allowed_origins: settings.allowedOrigins, allowed_targets: settings.allowedTargets }), "utf8");
  const attached = await attachment.attach({ config_path: configPath });
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const response = await fetch(`${attached.endpoint}/v1/communication/deliveries`, { method: "POST", headers, body: JSON.stringify(value) });
  assert.equal(response.status, 200);
  const posted = await response.json();
  assert.equal(posted.delivery.outcome, "accepted");
  assert.deepEqual(posted.delivery.origin, value.origin);
  assert.deepEqual(posted.delivery.target, value.target);
  assert.equal(nativeCalls.length, 1);
  assert.equal(nativeCalls[0].method, "turn/start");
  assert.equal(nativeCalls[0].params.threadId, value.target.conversation_id);
  const recovered = await fetch(`${attached.endpoint}/v1/communication/deliveries/${value.delivery_id}?${new URLSearchParams(hostScopeQuery(value))}`, { headers });
  assert.equal(recovered.status, 200);
  assert.deepEqual((await recovered.json()).delivery, posted.delivery);
  const denied = structuredClone(value);
  denied.delivery_id = "host-scope-wrong-machine";
  denied.origin.machine_id = "unapproved-remote-machine";
  const rejected = await fetch(`${attached.endpoint}/v1/communication/deliveries`, { method: "POST", headers, body: JSON.stringify(denied) });
  assert.equal(rejected.status, 403);
  await rejected.json();
  assert.equal(nativeCalls.length, 1);
});

function humanHostScopeSettings() {
  return {
    allowedOrigins: humanOrigins,
    allowedTargets: [
      { conversation_id: TARGET.conversation_id, binding_generation: 7 },
      { scope: "host", ...HOST_SCOPE_IDENTITY, host: "codex", binding_generation: 1 },
    ],
  };
}

function humanHostScopeInput(overrides = {}) {
  return humanInput({ binding_generation: 1, target: { ...TARGET, ...HOST_SCOPE_IDENTITY, conversation_id: "new-human-target" }, ...overrides });
}

function humanHostScopeQuery(value = humanHostScopeInput()) {
  return {
    source_host: value.relay.host, source_conversation_id: value.relay.conversation_id,
    target_host: value.target.host, target_conversation_id: value.target.conversation_id,
    target_machine_id: value.target.machine_id, target_surface: value.target.surface,
    binding_generation: String(value.binding_generation),
  };
}

test("human host targets preserve exact QQ provenance and dispatch new gen1 and legacy gen7 through native transport", async context => {
  const client = {};
  const nativeCalls = [];
  const newTarget = humanHostScopeInput();
  const turnFor = threadId => threadId === newTarget.target.conversation_id ? "human-scoped-turn" : "human-legacy-turn";
  const proxy = {
    wakeVisibility: createWakeVisibilityAdapter(), displayPolicy: createCodexDisplayPolicyManager(),
    _liveReadyClients: () => [client], _liveMaintenanceStatus: () => ({ active: false }),
    async subscribeThread(threadId) {
      const active = threadId === newTarget.target.conversation_id;
      return { threadId, readyClients: [client], results: [{ thread: { id: threadId, status: active ? "active" : "idle",
        turns: active ? [{ id: turnFor(threadId), status: "inProgress" }] : [] } }] };
    },
    async _liveInjectRequest(actualClient, method, params) {
      assert.equal(actualClient, client);
      nativeCalls.push({ method, params });
      if (method === "thread/turns/list") return { data: [{ id: turnFor(params.threadId), status: "completed" }], nextCursor: null };
      if (method === "thread/items/list") return { data: [{ turnId: params.turnId,
        item: { id: "human-native-reply", type: "agentMessage", text: "QQ reply response" } }], nextCursor: null };
      return method === "turn/steer" ? { turnId: turnFor(params.threadId) } : { turn: { id: turnFor(params.threadId) } };
    },
  };
  client.wakeVisibility = proxy.wakeVisibility.createView();
  client.displayPolicy = proxy.displayPolicy.createView();
  const state = await fixture(context, undefined, { ...humanHostScopeSettings(), transport: createCodexCommunicationTransport(proxy) });
  context.after(() => { client.wakeVisibility.close(); client.displayPolicy.close(); });
  const posted = await state.post(newTarget);
  assert.equal(posted.status, 200);
  assert.equal(posted.body.delivery.outcome, "accepted");
  assert.equal(posted.body.delivery.injection_method, "turn/steer");
  for (const key of ["origin", "relay", "forward_of", "in_reply_to", "text", "target"]) assert.deepEqual(posted.body.delivery[key], newTarget[key]);
  assert.deepEqual(nativeCalls[0], { method: "turn/steer", params: {
    threadId: newTarget.target.conversation_id, expectedTurnId: "human-scoped-turn",
    input: [{ type: "text", text: `【主人QQ回复，经可信交流核心转交】\n\n${newTarget.text}\n\n消息 ID：${newTarget.message_id}` }],
    clientUserMessageId: `communication-${createHash("sha256").update(newTarget.delivery_id).digest("hex")}`,
  } });
  const legacy = humanInput({ delivery_id: "human-legacy-delivery", message_id: "human-legacy-message" });
  const oldPosted = await state.post(legacy);
  assert.equal(oldPosted.body.delivery.outcome, "accepted");
  assert.equal(oldPosted.body.delivery.binding_generation, 7);
  assert.equal(oldPosted.body.delivery.injection_method, "turn/start");
  assert.deepEqual(oldPosted.body.delivery.relay, posted.body.delivery.relay);
  assert.deepEqual(oldPosted.body.delivery.origin, posted.body.delivery.origin);
  assert.deepEqual(oldPosted.body.delivery.target, legacy.target);
  const query = humanHostScopeQuery(newTarget);
  assert.deepEqual((await state.get(newTarget.delivery_id, query)).body.delivery, posted.body.delivery);
  assert.deepEqual((await state.get(legacy.delivery_id, humanScope)).body.delivery, oldPosted.body.delivery);
  const replies = await state.request("GET", state.queryPath(newTarget.delivery_id, query).replace("?", "/replies?"));
  assert.equal(replies.status, 200);
  assert.deepEqual(replies.body.delivery.target, newTarget.target);
  assert.equal(replies.body.replies.replies[0].text, "QQ reply response");
  const saved = fs.readFileSync(state.ledgerPath);
  const records = JSON.parse(saved).deliveries;
  assert.deepEqual(records[0].target, newTarget.target);
  assert.deepEqual(records[1].target, legacy.target);
  await state.control.close();
  const reopened = state.create();
  const address = await reopened.start();
  assert.deepEqual(fs.readFileSync(state.ledgerPath), saved);
  assert.deepEqual((await state.get(newTarget.delivery_id, query, address)).body.delivery, posted.body.delivery);
  assert.deepEqual((await state.get(legacy.delivery_id, humanScope, address)).body.delivery, oldPosted.body.delivery);
});

test("human host targets reject fake QQ sources unapproved relays and mismatched target scopes without mutation", async context => {
  const state = await fixture(context, undefined, humanHostScopeSettings());
  const invalidSources = [
    body => { body.origin.kind = "agent"; },
    body => { body.origin.channel = "qq"; },
    body => { body.origin.source_ref = `owner-event:${"b".repeat(64)}`; },
    body => { body.origin.machine_id = HOST_SCOPE_IDENTITY.machine_id; },
    body => { body.relay.host = "antigravity"; },
    body => { body.relay.conversation_id = "*"; },
    body => { body.relay.machine_id = HOST_SCOPE_IDENTITY.machine_id; },
    body => { body.forward_of.native_source.event.quoted_message_id = "80099"; },
    body => { body.forward_of.native_source.route.conversation_id = "another-relay"; },
    body => { body.forward_of.native_source.route.generation = 0; },
    body => { body.in_reply_to = "unrelated-notification"; },
  ];
  for (const change of invalidSources) {
    const value = humanHostScopeInput();
    change(value);
    assert.equal((await state.post(value)).status, 400, change.toString());
  }
  const unapproved = humanHostScopeInput();
  unapproved.relay.conversation_id = unapproved.forward_of.native_source.route.conversation_id = "unapproved-relay";
  assert.equal((await state.post(unapproved)).body.error.code, "origin_not_allowed");
  for (const [field, replacement] of [["machine_id", "remote-machine"], ["host", "antigravity"], ["surface", "web"]]) {
    const value = humanHostScopeInput();
    value.target[field] = replacement;
    assert.equal((await state.post(value)).body.error.code, "target_not_allowed", field);
  }
  for (const field of ["machine_id", "surface", "conversation_id"]) {
    const value = humanHostScopeInput();
    value.target[field] = "*";
    assert.equal((await state.post(value)).status, 400, field);
  }
  for (const field of ["machine_id", "surface"]) {
    const value = humanHostScopeInput();
    delete value.target[field];
    assert.equal((await state.post(value)).status, 400, field);
  }
  assert.equal((await state.post(humanHostScopeInput({ binding_generation: 7 }))).body.error.code, "binding_generation_mismatch");
  assert.equal((await state.post(humanInput({ binding_generation: 1 }))).body.error.code, "binding_generation_mismatch");
  const noScope = humanHostScopeInput();
  delete noScope.target.machine_id;
  delete noScope.target.surface;
  assert.equal((await state.post(noScope)).body.error.code, "target_not_allowed");
  assert.equal(state.calls.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(state.ledgerPath, "utf8")).deliveries, []);
  const noRelay = await fixture(context, undefined, { ...humanHostScopeSettings(), allowedOrigins: hostScopeSettings().allowedOrigins });
  assert.equal((await noRelay.post(humanHostScopeInput())).body.error.code, "origin_not_allowed");
  assert.equal(noRelay.calls.length, 0);
});

test("human host targets require mixed exact relay and complete target identity for GET and replies", async context => {
  const reads = [];
  const state = await fixture(context, undefined, { ...humanHostScopeSettings(), transport: {
    async inspectAndDispatch(payload, hooks) { await hooks.beforeMutation(); return result(payload); },
    async readCompletedReplies(delivery) { reads.push(delivery); return { outcome: "ok", replies: [{ text: "human answer" }], cursor: null }; },
  } });
  const value = humanHostScopeInput();
  assert.equal((await state.post(value)).status, 200);
  const legacy = humanInput({ delivery_id: "legacy-human-query" });
  assert.equal((await state.post(legacy)).status, 200);
  const saved = fs.readFileSync(state.ledgerPath);
  const query = humanHostScopeQuery(value);
  const route = state.queryPath(value.delivery_id, query);
  for (const suffix of ["", "/replies"]) {
    const pathname = route.replace("?", `${suffix}?`);
    assert.equal((await state.request("GET", pathname)).status, 200);
    for (const [field, replacement] of Object.entries({
      source_host: "antigravity", source_conversation_id: "wrong-relay", target_host: "antigravity",
      target_machine_id: "wrong-machine", target_surface: "web", target_conversation_id: "wrong-target", binding_generation: "2",
    })) {
      const changed = state.queryPath(value.delivery_id, { ...query, [field]: replacement }).replace("?", `${suffix}?`);
      assert.equal((await state.request("GET", changed)).status, 403, field);
    }
    const inventedSource = `${pathname}&source_machine_id=${HOST_SCOPE_IDENTITY.machine_id}&source_surface=desktop`;
    assert.equal((await state.request("GET", inventedSource)).status, 403);
    const missingTarget = state.queryPath(value.delivery_id, { ...humanScope, target_conversation_id: value.target.conversation_id, binding_generation: "1" }).replace("?", `${suffix}?`);
    assert.equal((await state.request("GET", missingTarget)).status, 403);
    for (const field of ["target_host", "target_machine_id", "target_surface"]) {
      const incomplete = new URL(pathname, "http://fixture");
      incomplete.searchParams.delete(field);
      assert.equal((await state.request("GET", `${incomplete.pathname}${incomplete.search}`)).status, 400);
    }
    const inventedLegacyTarget = state.queryPath(legacy.delivery_id, { ...humanScope, target_host: "codex",
      target_machine_id: HOST_SCOPE_IDENTITY.machine_id, target_surface: "desktop" }).replace("?", `${suffix}?`);
    assert.equal((await state.request("GET", inventedLegacyTarget)).status, 403);
    assert.equal((await state.request("GET", state.queryPath(legacy.delivery_id, humanScope).replace("?", `${suffix}?`))).status, 200);
  }
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[0].target, value.target);
  assert.deepEqual(reads[0].origin, value.origin);
  assert.deepEqual(reads[0].relay, value.relay);
  assert.deepEqual(reads[1].target, legacy.target);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), saved);
});

test("human host targets retain hidden native identity across cold reload and reject changed delivery provenance", async context => {
  const client = {};
  const value = humanHostScopeInput({ message_visibility: "hidden" });
  const turnId = "human-hidden-turn";
  let item;
  let nativeCalls = 0;
  const proxy = {
    wakeVisibility: createWakeVisibilityAdapter(), displayPolicy: createCodexDisplayPolicyManager(),
    _liveReadyClients: () => [client], _liveMaintenanceStatus: () => ({ active: false }),
    async subscribeThread(threadId) { return { threadId, readyClients: [client], results: [{ thread: { id: threadId, status: "active", turns: [{ id: turnId, status: "inProgress" }] } }] }; },
    async _liveInjectRequest(actualClient, method, params) {
      assert.equal(actualClient, client);
      assert.equal(method, "turn/steer");
      nativeCalls += 1;
      item = { id: "human-hidden-item", type: "userMessage", clientId: params.clientUserMessageId, content: params.input };
      assert.equal(project({ method: "item/started", params: { threadId: value.target.conversation_id, turnId, item } }), null);
      return { turnId };
    },
  };
  client.wakeVisibility = proxy.wakeVisibility.createView();
  client.displayPolicy = proxy.displayPolicy.createView();
  function project(message) {
    client.displayPolicy.observeUpstream(message);
    const suppressed = client.wakeVisibility.shouldSuppress(message);
    const stable = suppressed ? message : client.wakeVisibility.project(message);
    return client.displayPolicy.project(message, stable, suppressed);
  }
  const transport = createCodexCommunicationTransport(proxy);
  const state = await fixture(context, undefined, { ...humanHostScopeSettings(), transport });
  context.after(() => { client.wakeVisibility.close(); client.displayPolicy.close(); });
  assert.equal((await state.post(value)).body.delivery.outcome, "accepted");
  const saved = fs.readFileSync(state.ledgerPath);
  const record = JSON.parse(saved).deliveries[0];
  assert.deepEqual(record.target, value.target);
  assert.equal(record.visibility_item_key, JSON.stringify([value.target.conversation_id, turnId, item.id]));
  for (const change of [
    body => { body.target.machine_id = "other-machine"; },
    body => { body.target.surface = "other-surface"; },
    body => { body.target.conversation_id = "other-target"; },
    body => { body.binding_generation = 2; },
    body => { body.forward_of.native_source.event.sender_id = "90002"; },
    body => { body.relay.conversation_id = body.forward_of.native_source.route.conversation_id = "other-relay"; },
  ]) {
    const changed = structuredClone(value);
    change(changed);
    assert.equal((await state.post(changed)).body.error.code, "delivery_id_conflict");
  }
  await state.control.close();
  const reopened = state.create({ transport: createCodexCommunicationTransport(proxy) });
  const address = await reopened.start();
  const request = { id: "human-hidden-history", method: "thread/items/list", params: { threadId: value.target.conversation_id, turnId } };
  client.wakeVisibility.observeRequest(request);
  client.displayPolicy.observeRequest(request);
  const history = project({ id: request.id, result: { data: [{ turnId, item: { ...item, clientId: null } }], nextCursor: null } });
  assert.deepEqual(history.result.data, []);
  assert.deepEqual((await state.get(value.delivery_id, humanHostScopeQuery(value), address)).body.delivery.target, value.target);
  assert.equal((await state.post(value, {}, address)).body.delivery.outcome, "accepted");
  assert.equal(nativeCalls, 1);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), saved);
});

test("unknown identity migration blocks duplicate dispatch while preserving original records and strict lookups", async context => {
  const scenarios = [
    { first: "legacy", next: "source" }, { first: "legacy", next: "target" },
    { first: "legacy", next: "complete" }, { first: "complete", next: "legacy" },
    { human: true, first: "legacy", next: "target" }, { human: true, first: "target", next: "legacy" },
    { first: "legacy", next: "complete", hostOnly: true },
    { human: true, first: "legacy", next: "target", hostOnly: true },
  ];
  for (const scenario of scenarios) await context.test(JSON.stringify(scenario), async child => {
    const scoped = hostScopeSettings();
    const settings = {
      allowedOrigins: [...humanOrigins, { host: SOURCE.host, conversation_id: SOURCE.conversation_id }, ...scoped.allowedOrigins],
      allowedTargets: [{ conversation_id: TARGET.conversation_id, binding_generation: 7 }, ...scoped.allowedTargets],
    };
    const state = await fixture(child, async (payload, hooks) => {
      await hooks.beforeMutation();
      return result(payload, { outcome: "unknown", request_sent: null, injection_method: null, turn_id: null });
    }, settings);
    function valueFor(mode) {
      const value = scenario.human ? humanInput() : input();
      if (!scenario.human && ["source", "complete"].includes(mode)) Object.assign(value.origin, HOST_SCOPE_IDENTITY);
      if (["target", "complete"].includes(mode)) Object.assign(value.target, HOST_SCOPE_IDENTITY);
      return value;
    }
    function queryFor(value) {
      const source = scenario.human ? value.relay : value.origin;
      return {
        source_host: source.host, source_conversation_id: source.conversation_id,
        target_conversation_id: value.target.conversation_id, binding_generation: String(value.binding_generation),
        ...(source.machine_id ? { source_machine_id: source.machine_id, source_surface: source.surface } : {}),
        ...(value.target.machine_id ? { target_host: value.target.host, target_machine_id: value.target.machine_id, target_surface: value.target.surface } : {}),
      };
    }
    const original = valueFor(scenario.first);
    const first = await state.post(original);
    assert.equal(first.body.delivery.outcome, "unknown");
    const saved = fs.readFileSync(state.ledgerPath);
    await state.control.close();
    const reopened = state.create(scenario.hostOnly ? {
      allowedOrigins: scenario.human ? humanOrigins : scoped.allowedOrigins,
      allowedTargets: scoped.allowedTargets.map(target => ({ ...target, binding_generation: 1 })),
    } : {});
    const address = await reopened.start();
    assert.deepEqual((await state.get(original.delivery_id, queryFor(original), address)).body, first.body);
    assert.deepEqual((await state.post({ ...original, retry_failed_before_send: true }, {}, address)).body, first.body);
    const next = valueFor(scenario.next);
    next.delivery_id = "migrated-delivery";
    if (scenario.hostOnly) next.binding_generation = 1;
    const duplicate = await state.post(next, {}, address);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, "message_delivery_unknown");
    assert.equal((await state.post({ ...next, delivery_id: original.delivery_id }, {}, address)).body.error.code, "delivery_id_conflict");
    assert.equal((await state.get(original.delivery_id, queryFor(next), address)).status, 403);
    assert.equal(state.calls.length, 1);
    assert.deepEqual(fs.readFileSync(state.ledgerPath), saved);
    const persisted = JSON.parse(saved).deliveries;
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].outcome, "unknown");
  });
});

test("unknown identity migration keeps fully specified authorized source and target machines independent", async context => {
  const scoped = hostScopeSettings();
  const machines = [HOST_SCOPE_IDENTITY.machine_id, "other-authorized-machine-fixture"];
  const state = await fixture(context, async (payload, hooks) => {
    await hooks.beforeMutation();
    return result(payload, { outcome: "unknown", request_sent: null, injection_method: null, turn_id: null });
  }, {
    allowedOrigins: machines.flatMap(machine_id => scoped.allowedOrigins.map(origin => ({ ...origin, machine_id }))),
    allowedTargets: machines.flatMap(machine_id => scoped.allowedTargets.map(target => ({ ...target, machine_id }))),
  });
  const originals = [];
  for (const sourceMachine of machines) for (const targetMachine of machines) {
    const value = hostScopeInput({ delivery_id: `complete-machine-pair-${originals.length}` });
    value.origin.machine_id = sourceMachine;
    value.target.machine_id = targetMachine;
    assert.equal((await state.post(value)).body.delivery.outcome, "unknown");
    originals.push(value);
  }
  assert.equal(state.calls.length, 4);
  const saved = fs.readFileSync(state.ledgerPath);
  await state.control.close();
  const address = await state.create().start();
  for (const original of originals) {
    assert.equal((await state.get(original.delivery_id, hostScopeQuery(original), address)).status, 200);
    assert.equal((await state.post({ ...original, delivery_id: `${original.delivery_id}-duplicate` }, {}, address)).body.error.code, "message_delivery_unknown");
    for (const field of ["source_machine_id", "target_machine_id"]) {
      const query = hostScopeQuery(original);
      query[field] = machines.find(machine => machine !== query[field]);
      assert.equal((await state.get(original.delivery_id, query, address)).status, 403);
    }
  }
  assert.equal(state.calls.length, 4);
  assert.deepEqual(fs.readFileSync(state.ledgerPath), saved);
});
