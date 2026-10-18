import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import * as coordinatorModule from "../src/inner-proxy-coordinator.mjs";
import { createManagedEventObserver } from "../src/inner-managed-events.mjs";
import { createManagedInnerProxySessionImplementation } from "../src/inner-managed-session.mjs";

const threadId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const otherTurnId = "33333333-3333-4333-8333-333333333333";
const hash16 = value => crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

async function fixture(context, { legacyObserver = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inner-rejection-diagnostics-"));
  const events = [];
  const observed = [];
  const calls = [];
  const upstream = http.createServer((request, response) => {
    calls.push(request.url);
    request.resume();
    response.end("owned-loopback-accepted");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const observe = legacyObserver ? event => observed.push({ type: event.type, code: event.code })
    : createManagedEventObserver({ writer: { append: event => observed.push(event) } });
  const coordinator = coordinatorModule.createInnerProxyCoordinator({ ownerId: "diagnostics-test", nativeSourceId: "diagnostics-native",
    checkpointRoot: root, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    onEvent: event => { events.push(event); observe(event); } });
  const participant = coordinator.liveCodeParticipant();
  const shared = participant.snapshot().state;
  const worker = { workerId: "diagnostics-worker", activeHttp: 0,
    ready: { status: { port: upstream.address().port } }, child: { connected: true, exitCode: null, signalCode: null } };
  shared.defaultWorker = worker;
  const state = { threadId, turnId, phase: "active", activeHttp: 0, worker };
  shared.threads.set(threadId, state);
  shared.server.listen(0, "127.0.0.1");
  await once(shared.server, "listening");
  context.after(async () => {
    await coordinator.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true });
    assert.equal(fs.existsSync(root), false);
  });
  const request = async (metadata = { thread_id: threadId, turn_id: turnId }) => {
    const response = await fetch(`http://127.0.0.1:${shared.server.address().port}/v1/responses?private-query`, {
      method: "POST", headers: { "x-codex-turn-metadata": typeof metadata === "string" ? metadata : JSON.stringify(metadata),
        authorization: "private-token", "content-type": "application/json" }, body: '{"prompt":"private-body"}' });
    return { status: response.status, body: await response.text() };
  };
  return { root, coordinator, participant, shared, state, worker, events, observed, calls, request };
}

const beforeCases = [
  ["native_unhealthy", value => { value.shared.nativeHealthy = false; }],
  ["thread_not_found", value => { value.shared.threads.clear(); }],
  ["phase_not_active", value => { value.state.phase = "terminal"; }],
  ["turn_mismatch", value => { value.state.turnId = otherTurnId; }],
  ["worker_dead", value => { value.worker.child.connected = false; }],
];

for (const [reason, mutate] of beforeCases) {
  test(`turn rejection captures ${reason} before adopt without changing 503`, async context => {
    const value = await fixture(context);
    mutate(value);
    assert.deepEqual(await value.request(), { status: 503, body: "COORDINATOR_REQUEST_NOT_ACCEPTED" });
    const recent = value.coordinator.status().recentRejections;
    assert.equal(recent.length, 1);
    assert.equal(recent[0].code, "COORDINATOR_TURN_UNAVAILABLE");
    assert.equal(recent[0].reason, reason);
    assert.equal(recent[0].decisionPoint, "before_adopt");
    assert.equal(recent[0].threadHash, hash16(threadId));
    assert.equal(recent[0].turnHash, hash16(turnId));
    assert.equal(recent[0].nativeHealthy, value.shared.nativeHealthy);
    assert.equal(recent[0].workerAlive, reason !== "thread_not_found" && reason !== "worker_dead");
    assert.equal(recent[0].coordinatorActiveHttp, 0);
    if (reason !== "thread_not_found") {
      assert.equal(recent[0].currentTurnHash, hash16(value.state.turnId));
      assert.equal(recent[0].activeHttp, 0);
      assert.equal(recent[0].workerActiveHttp, 0);
    }
    assert.equal(value.calls.length, 0);
    assert.equal(value.observed[0].reason, reason);
    const evidence = JSON.stringify([recent, value.events, value.observed]);
    for (const secret of [threadId, turnId, otherTurnId, "private-token", "private-body", "private-query"]) {
      assert.equal(evidence.includes(secret), false, secret);
    }
  });
}

for (const [reason, mutate] of beforeCases.filter(([reason]) => reason !== "thread_not_found")) {
  test(`turn rejection snapshots ${reason} after adopt`, async context => {
    const value = await fixture(context);
    value.shared.implementation = { ...value.shared.implementation, adoptForRequest: async () => mutate(value) };
    assert.equal((await value.request()).status, 503);
    const recent = value.coordinator.status().recentRejections[0];
    assert.equal(recent.reason, reason);
    assert.equal(recent.decisionPoint, "after_adopt");
    assert.equal(value.calls.length, 0);
  });
}

for (const reason of ["phase_not_active", "turn_mismatch", "worker_dead", "adoption_target_dead"]) {
  test(`adopt rejection preserves its existing code and records ${reason}`, async context => {
    const value = await fixture(context);
    const target = { ...value.worker, child: { ...value.worker.child } };
    value.shared.activation = { id: "diagnostics-activation", active: true, source: value.worker, target };
    value.state.pendingActivation = value.shared.activation;
    const original = value.shared.implementation.adoptForRequest;
    value.shared.implementation = { ...value.shared.implementation, adoptForRequest: async (...args) => {
      if (reason === "phase_not_active") value.state.phase = "terminal";
      if (reason === "turn_mismatch") value.state.turnId = otherTurnId;
      if (reason === "worker_dead") value.worker.child.connected = false;
      if (reason === "adoption_target_dead") target.child.connected = false;
      return original(...args);
    } };
    assert.equal((await value.request()).status, 503);
    const recent = value.coordinator.status().recentRejections[0];
    assert.equal(recent.reason, reason);
    assert.equal(recent.decisionPoint, "during_adopt");
    assert.equal(recent.code, ["worker_dead", "adoption_target_dead"].includes(reason)
      ? "COORDINATOR_WORKER_UNAVAILABLE" : "COORDINATOR_TURN_UNAVAILABLE");
    assert.equal(value.calls.length, 0);
  });
}

test("an active matching request still reaches the owned loopback worker without a rejection", async context => {
  const value = await fixture(context);
  assert.deepEqual(await value.request(), { status: 200, body: "owned-loopback-accepted" });
  assert.deepEqual(value.calls, ["/v1/responses?private-query"]);
  assert.deepEqual(value.coordinator.status().recentRejections, []);
  assert.equal(value.state.activeHttp, 0);
  assert.equal(value.worker.activeHttp, 0);
  assert.equal(value.shared.requests.size, 0);
});

test("old shared state hot-adopts diagnostics while the legacy observer closure remains unchanged", async context => {
  const value = await fixture(context, { legacyObserver: true });
  delete value.shared.recentRejections;
  const threads = value.shared.threads;
  const requests = value.shared.requests;
  const observer = value.shared.onEvent;
  value.participant.activate(value.participant.prepare(coordinatorModule));
  assert.deepEqual(value.coordinator.status().recentRejections, []);
  value.shared.threads.clear();
  assert.equal((await value.request()).status, 503);
  value.participant.activate(value.participant.prepare(coordinatorModule));
  assert.equal(value.coordinator.status().recentRejections[0].reason, "thread_not_found");
  assert.equal(Object.hasOwn(value.observed[0], "reason"), false);
  assert.strictEqual(value.shared.threads, threads);
  assert.strictEqual(value.shared.requests, requests);
  assert.strictEqual(value.shared.onEvent, observer);
});

test("recent rejections retain exactly the newest 32 entries and status returns copies", async context => {
  const value = await fixture(context);
  value.shared.threads.clear();
  for (let index = 0; index < 35; index += 1) {
    assert.equal((await value.request({ thread_id: `missing-${index}`, turn_id: turnId })).status, 503);
    assert.equal(value.coordinator.status().recentRejections.length, Math.min(index + 1, 32));
  }
  const recent = value.coordinator.status().recentRejections;
  assert.equal(recent[0].threadHash, hash16("missing-3"));
  assert.equal(recent.at(-1).threadHash, hash16("missing-34"));
  recent[0].reason = "modified";
  recent.pop();
  assert.equal(value.coordinator.status().recentRejections[0].reason, "thread_not_found");
  assert.equal(value.coordinator.status().recentRejections.length, 32);
});

test("only bounded allowlisted identity strings are hashed, and metadata errors retain 503", async context => {
  const value = await fixture(context);
  value.shared.threads.clear();
  for (const identity of [null, 123, {}, [], "", "private secret", "private/token", "private\u0000token", "x".repeat(129)]) {
    assert.equal((await value.request({ thread_id: identity, turn_id: identity, prompt: "private-prompt" })).status, 503);
    const recent = value.coordinator.status().recentRejections.at(-1);
    assert.equal(Object.hasOwn(recent, "threadHash"), false);
    assert.equal(Object.hasOwn(recent, "turnHash"), false);
  }
  assert.equal((await value.request("not-json-private-token")).status, 503);
  assert.equal(value.coordinator.status().recentRejections.at(-1).code, "COORDINATOR_TURN_IDENTITY_REQUIRED");
  assert.equal(JSON.stringify(value.coordinator.status().recentRejections).includes("private"), false);
});

test("foreign error properties cannot inject sensitive fields into the rejection ring", async context => {
  const value = await fixture(context);
  value.shared.implementation = { ...value.shared.implementation, adoptForRequest: async () => {
    throw Object.assign(new Error("private-error-message"), { code: "COORDINATOR_TEST_FAILURE", rejectionDiagnostics: {
      body: "private-body", headers: { authorization: "private-token" }, threadId, turnId, prompt: "private-prompt" } });
  } };
  assert.equal((await value.request()).status, 503);
  const recent = value.coordinator.status().recentRejections[0];
  assert.equal(recent.reason, "request_failed");
  assert.equal(recent.decisionPoint, "during_adopt");
  for (const secret of ["private", threadId, turnId]) assert.equal(JSON.stringify(recent).includes(secret), false);
});

test("diagnostic identity validation leaves the original admission rules unchanged", async context => {
  const value = await fixture(context);
  const identity = "private/accepted identity";
  value.shared.threads.clear();
  Object.assign(value.state, { threadId: identity, turnId: identity });
  value.shared.threads.set(identity, value.state);
  assert.equal((await value.request({ thread_id: identity, turn_id: identity })).status, 200);
  value.worker.child.connected = false;
  assert.equal((await value.request({ thread_id: identity, turn_id: identity })).status, 503);
  const recent = value.coordinator.status().recentRejections[0];
  for (const name of ["threadHash", "turnHash", "currentTurnHash"]) assert.equal(Object.hasOwn(recent, name), false);
  assert.equal(JSON.stringify(recent).includes(identity), false);
});

test("identity hashing accepts the exact 1 and 128 character boundaries", async context => {
  const value = await fixture(context);
  value.shared.threads.clear();
  for (const identity of ["a", "a".repeat(128)]) {
    assert.equal((await value.request({ thread_id: identity, turn_id: identity })).status, 503);
    const recent = value.coordinator.status().recentRejections.at(-1);
    assert.equal(recent.threadHash, hash16(identity));
    assert.equal(recent.turnHash, hash16(identity));
  }
});

test("hot-swapped adopt errors retain the decision-point snapshot across implementations", async context => {
  const value = await fixture(context);
  value.shared.activation = { id: "diagnostics-activation", active: true, source: value.worker,
    target: { ...value.worker, child: { ...value.worker.child } } };
  value.state.pendingActivation = value.shared.activation;
  value.shared.implementation = { ...value.shared.implementation, adoptForRequest: async (...args) => {
    value.participant.activate(value.participant.prepare(coordinatorModule));
    value.state.phase = "terminal";
    try { await value.shared.dispatch("adoptForRequest", ...args); }
    catch (error) { value.state.phase = "active"; throw error; }
  } };
  assert.equal((await value.request()).status, 503);
  assert.equal(value.state.phase, "active");
  const recent = value.coordinator.status().recentRejections[0];
  assert.equal(recent.phase, "terminal");
  assert.equal(recent.reason, "phase_not_active");
  assert.equal(recent.decisionPoint, "during_adopt");
});

test("metadata-free catalog keeps its original native-health bypass and worker failure code", async context => {
  const value = await fixture(context);
  value.shared.nativeHealthy = false;
  const catalog = () => fetch(`http://127.0.0.1:${value.shared.server.address().port}/backend-api/codex/models`);
  const accepted = await catalog();
  assert.equal(accepted.status, 200);
  await accepted.text();
  value.worker.child.connected = false;
  const rejected = await catalog();
  assert.equal(rejected.status, 503);
  assert.equal(await rejected.text(), "COORDINATOR_REQUEST_NOT_ACCEPTED");
  const recent = value.coordinator.status().recentRejections[0];
  assert.equal(recent.reason, "worker_dead");
  assert.equal(recent.code, "COORDINATOR_WORKER_UNAVAILABLE");
  assert.equal(recent.nativeHealthy, false);
});

test("rejection categories and parent hashes identify request purpose without changing admission", async context => {
  const value = await fixture(context);
  const parentId = "44444444-4444-4444-8444-444444444444";
  value.shared.threads.clear();
  for (const requestKind of ["turn", "prewarm", "compaction", "memory"]) {
    for (const subagentKind of ["review", "compact", "thread_spawn", "memory_consolidation"]) {
      assert.deepEqual(await value.request({ thread_id: threadId, turn_id: turnId, request_kind: requestKind,
        subagent_kind: subagentKind, parent_thread_id: parentId }),
      { status: 503, body: "COORDINATOR_REQUEST_NOT_ACCEPTED" });
      const recent = value.coordinator.status().recentRejections.at(-1);
      assert.equal(recent.requestKind, requestKind);
      assert.equal(recent.subagentKind, subagentKind);
      assert.equal(recent.parentThreadHash, hash16(parentId));
      assert.equal(recent.threadRegistry, "absent");
      assert.equal(recent.reason, "thread_not_found");
      assert.equal(Object.hasOwn(recent, "terminalTurnMatches"), false);
    }
  }
  assert.equal(value.calls.length, 0);
  assert.equal(JSON.stringify([value.events, value.coordinator.status().recentRejections]).includes(parentId), false);
  value.shared.threads.set(threadId, value.state);
  assert.equal((await value.request({ thread_id: threadId, turn_id: turnId,
    request_kind: "private-custom", subagent_kind: {}, parent_thread_id: "private/parent" })).status, 200);
});

test("diagnostic categories redact unknown values and validate parent identities", async context => {
  const value = await fixture(context);
  value.shared.threads.clear();
  for (const field of [undefined, null, 123, {}, [], "", "private-custom", "x".repeat(129)]) {
    assert.equal((await value.request({ thread_id: threadId, turn_id: turnId,
      request_kind: field, subagent_kind: field, parent_thread_id: field })).status, 503);
    const recent = value.coordinator.status().recentRejections.at(-1);
    assert.equal(recent.requestKind, field === undefined ? "missing" : "unknown");
    assert.equal(recent.subagentKind, field === undefined ? "missing" : "unknown");
    assert.equal(Object.hasOwn(recent, "parentThreadHash"), field === "private-custom");
  }
  const evidence = JSON.stringify([value.events, value.observed, value.coordinator.status().recentRejections]);
  for (const secret of ["private-custom", "private-token", "private-body", threadId, turnId]) {
    assert.equal(evidence.includes(secret), false);
  }
});

test("rejection registry separates current terminal, retained history, and absent records", async context => {
  const value = await fixture(context);
  value.state.phase = "terminal";
  assert.equal((await value.request()).status, 503);
  assert.equal(value.coordinator.status().recentRejections.at(-1).threadRegistry, "current");
  assert.equal(value.coordinator.status().recentRejections.at(-1).phase, "terminal");
  value.shared.threads.delete(threadId);
  value.shared.terminalThreads.set(threadId, value.state);
  for (const requestedTurn of [turnId, otherTurnId, "private/invalid"]) {
    assert.equal((await value.request({ thread_id: threadId, turn_id: requestedTurn })).status, 503);
    const recent = value.coordinator.status().recentRejections.at(-1);
    assert.equal(recent.threadRegistry, "terminal_history");
    assert.equal(recent.reason, "thread_not_found");
    assert.equal(recent.terminalTurnMatches, requestedTurn === "private/invalid" ? undefined : requestedTurn === turnId);
  }
  value.shared.terminalThreads.clear();
  assert.equal((await value.request()).status, 503);
  assert.equal(value.coordinator.status().recentRejections.at(-1).threadRegistry, "absent");
  assert.equal(value.calls.length, 0);
});

test("origin diagnostics survive hot adoption and restore in the managed publication file", async context => {
  const value = await fixture(context, { legacyObserver: true });
  const statePath = path.join(value.root, "managed-state.json");
  const publishedEvents = [];
  const managed = createManagedInnerProxySessionImplementation({ configuration: { ownerId: "diagnostics-test",
    nativeSourceId: "diagnostics-native" }, onEvent: event => publishedEvents.push(event), serviceDependencies: {}, options: {},
    runtimeProfile: { managedStatePath: statePath }, coordinator: value.coordinator, nativeSource: { status: () => ({ healthy: true }) },
    controlOperations: new Map(), publicationStarted: true });
  const observer = value.shared.onEvent;
  const original = value.participant.activate(value.participant.prepare(coordinatorModule));
  value.shared.threads.clear();
  assert.equal((await value.request({ thread_id: threadId, turn_id: turnId, request_kind: "compaction",
    parent_thread_id: otherTurnId, subagent_kind: "compact" })).status, 503);
  managed.handleCoordinatorEvent(value.events.at(-1));
  const readPublished = () => JSON.parse(fs.readFileSync(statePath, "utf8")).coordinator.recentRejections;
  const recorded = readPublished();
  assert.equal(recorded[0].requestKind, "compaction");
  assert.equal(recorded[0].parentThreadHash, hash16(otherTurnId));
  assert.equal(recorded[0].subagentKind, "compact");
  assert.equal(recorded[0].threadRegistry, "absent");
  assert.equal(Object.hasOwn(value.observed[0], "requestKind"), false);
  value.participant.restore(original);
  managed.refreshPublishedStatus();
  assert.deepEqual(readPublished(), recorded);
  assert.strictEqual(value.shared.onEvent, observer);
  assert.equal(publishedEvents.some(event => event.type === "managed_state_publish_failed"), false);
  for (const secret of [threadId, turnId, otherTurnId, "private-body", "private-token"]) {
    assert.equal(JSON.stringify(recorded).includes(secret), false);
  }
});
