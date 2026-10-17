import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import * as sessionModule from "../src/inner-managed-session.mjs";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const nativeFixture = fileURLToPath(new URL("./inner-runtime-profile-native.mjs", import.meta.url));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

import { fixture, until } from "./managed-session-code-fixture.mjs";

async function generation(fixtureState, label, markers) {
  const modulePath = path.join(fixtureState.root, `managed-${label}.mjs`);
  const source = fs.readFileSync(path.join(sourceRoot, "inner-managed-session.mjs"), "utf8")
    .replace(/from "\.\/([^"\n]+)"/gu, (_match, name) => `from ${JSON.stringify(pathToFileURL(path.join(sourceRoot, name)).href)}`);
  fs.writeFileSync(modulePath, `${source}\nexport const generationLabel = ${JSON.stringify(label)};\n`);
  const module = await import(pathToFileURL(modulePath).href);
  assert.equal(module.generationLabel, label);
  return fixtureState.participant.prepare({ [fixtureState.participant.exportName]: shared => {
    const implementation = module[fixtureState.participant.exportName](shared);
    return Object.fromEntries(Object.entries(implementation).map(([name, method]) => [name, (...args) => {
      markers.push({ label, name, generation: shared.implementationGeneration });
      return method(...args);
    }]));
  } });
}

function identity(shared) {
  return { coordinator: shared.coordinator, nativeSource: shared.nativeSource, stopIdentity: shared.stopIdentity,
    outerTask: shared.outerTask, completion: shared.completion, operations: shared.controlOperations,
    resources: shared.resources, controlTimers: shared.resources.controlTimers, publicationTimer: shared.resources.publicationTimer,
    serviceCodeParticipant: shared.serviceCodeParticipant };
}

test("concurrent native progress during terminal relay preserves both incoming starts", async () => {
  const thread = { threadId: "concurrent-thread", turnId: "old", workerId: "worker", phase: "active", activeHttp: 0 };
  let finishRelay;
  let completionEvents = 0;
  const relay = new Promise(resolve => { finishRelay = resolve; });
  const shared = { configuration: {}, options: {}, onEvent: () => {}, controlBusy: false,
    coordinator: { status: () => ({ nativeHealthy: true, threads: [{ ...thread }] }) },
    nativeSource: { status: () => ({ healthy: true }), observe: async message => {
      if (!message) return;
      completionEvents += 1;
      thread.phase = "terminal";
      await relay;
    } } };
  const implementation = sessionModule.createManagedInnerProxySessionImplementation(shared);
  const callbacks = { connectionActive: () => true,
    lookupTurns: async () => ({ data: [{ id: "old", status: "completed" }], nextCursor: null }) };
  const first = implementation.dispatchControl("recover-before-turn", { threadId: thread.threadId }, callbacks);
  await until(() => thread.phase === "terminal");
  assert.equal((await implementation.dispatchControl("recover-before-turn", { threadId: thread.threadId }, callbacks)).recovered, false);
  thread.turnId = "new";
  thread.phase = "active";
  finishRelay();
  assert.deepEqual(await first, { recovered: false, reason: "native_progress" });
  assert.equal(completionEvents, 1);
  assert.equal(thread.turnId, "new");
});

test("in-progress metadata cannot bypass health changes during its lookup", async () => {
  let healthy = true;
  const thread = { threadId: "health-thread", turnId: "old", workerId: "worker", phase: "active", activeHttp: 1 };
  const shared = { configuration: {}, options: {}, onEvent: () => {}, controlBusy: false,
    coordinator: { status: () => ({ nativeHealthy: healthy, threads: [{ ...thread }] }) },
    nativeSource: { status: () => ({ healthy }), observe: async () => {} } };
  const implementation = sessionModule.createManagedInnerProxySessionImplementation(shared);
  await assert.rejects(implementation.dispatchControl("recover-before-turn", { threadId: thread.threadId }, {
    connectionActive: () => true,
    lookupTurns: async () => { healthy = false; return { data: [{ id: "old", status: "inProgress" }] }; },
  }), /INNER_TURN_RECOVERY_STATE_CHANGED/u);
});

test("same real isolated session switches old listeners to new factory while its held request completes once", { timeout: 20000 }, async context => {
  const value = await fixture(context);
  const { session, participant, shared } = value;
  assert.strictEqual(session.liveCodeParticipant(), participant);
  assert.equal(participant.id, "managed-session");
  assert.equal(participant.stateSchema, "inner-managed-session-state-v1");
  assert.equal(participant.exportName, "createManagedInnerProxySessionImplementation");
  const publicStart = session.start;
  const completion = session.waitForClose();
  assert.equal(value.serviceParticipants.length, 1);
  assert.strictEqual(session.serviceCodeParticipant(), value.serviceParticipants[0]);
  assert.strictEqual(shared.serviceCodeParticipant, value.serviceParticipants[0]);
  const socket = await value.connect();
  await value.rpc(socket, "initialize", { clientInfo: { name: "isolated-generation", version: "1" } });
  await value.turn(socket, "held-thread", "held-turn");
  const inflight = value.request("held-thread", "held-turn");
  await until(() => value.held.length === 1);
  const activeFollowUp = await value.rpc(socket, "turn/start", { threadId: "held-thread", input: [], fixtureFollowUp: true });
  assert.equal(activeFollowUp.error, undefined);
  assert.equal(activeFollowUp.result.followUpAccepted, true);
  assert.equal(activeFollowUp.result.turn.id, "held-turn");
  const delayedTool = value.rpc(socket, "test/tool", { value: "old-inflight", replyDelayMs: 350 });
  const before = participant.snapshot();
  const resources = identity(shared);
  const workers = session.status().coordinator.workers;
  const nativeBefore = shared.nativeSource.status();
  const markers = [];
  const candidate = await generation(value, "new", markers);
  assert.deepEqual(participant.snapshot(), before);
  const token = participant.activate(candidate);
  assert.strictEqual(token.state, before.state);
  assert.strictEqual(token.implementation, before.implementation);
  assert.deepEqual(identity(shared), resources);
  assert.strictEqual(session.start, publicStart);
  assert.strictEqual(session.waitForClose(), completion);
  assert.strictEqual(session.serviceCodeParticipant(), value.serviceParticipants[0]);
  assert.deepEqual(session.status().coordinator.workers, workers);
  assert.deepEqual(shared.nativeSource.status(), nativeBefore);
  const hotFollowUp = await value.rpc(socket, "turn/start", { threadId: "held-thread", input: [], fixtureFollowUp: true });
  assert.equal(hotFollowUp.error, undefined);
  assert.equal(hotFollowUp.result.followUpAccepted, true);
  assert.equal(hotFollowUp.result.turn.id, "held-turn");
  assert.equal((await delayedTool).result.value, "old-inflight");
  await value.turn(socket, "new-thread", "new-turn");
  await until(() => markers.some(marker => marker.name === "handleNativeTurn"));
  const catalog = await fetch(`http://127.0.0.1:${value.endpoint.innerEndpoint.port}/backend-api/codex/models`);
  assert.equal(catalog.status, 200);
  await catalog.json();
  assert.ok(markers.some(marker => marker.name === "handleCoordinatorEvent"));
  await value.rpc(socket, "test/tool", { value: "new-code-event" });
  const secondSocket = await value.connect();
  await value.rpc(secondSocket, "initialize", { clientInfo: { name: "new-generation-client", version: "1" } });
  await until(() => markers.some(marker => marker.name === "handleOuterEvent"));
  const delivered = shared.nativeSource.status().delivered;
  participant.restore(token);
  const markerCount = markers.length;
  await value.rpc(socket, "test/complete", { threadId: "new-thread", turnId: "new-turn" });
  await until(() => shared.nativeSource.status().delivered > delivered);
  assert.equal(markers.length, markerCount);
  value.release();
  assert.equal((await inflight).status, 200);
  assert.equal(value.calls.filter(call => call.method === "POST").length, 1);
  await value.rpc(socket, "test/complete", { threadId: "held-thread", turnId: "held-turn" });
  await until(() => shared.coordinator.status().threads.every(thread => thread.phase === "terminal"));
  participant.activate(candidate);
  await session.close();
  assert.ok(markers.some(marker => marker.name === "handleOuterFinished"));
  assert.equal((await completion).state, "stopped");
  assert.equal(shared.outerFinished, true);
});

test("authoritative completion waits for the old HTTP close before restoring its terminal state", { timeout: 20000 }, async context => {
  const value = await fixture(context);
  const socket = await value.connect();
  await value.rpc(socket, "initialize", { clientInfo: { name: "completion-drain", version: "1" } });
  await value.turn(socket, "draining-thread", "draining-turn");
  const inflight = value.request("draining-thread", "draining-turn");
  await until(() => value.held.length === 1);
  await value.rpc(socket, "test/complete-silent", { threadId: "draining-thread", turnId: "draining-turn" });
  let recovered = false;
  const recovery = value.shared.dispatch("dispatchControl", "recover-before-turn", { threadId: "draining-thread" }, {
    connectionActive: () => true,
    lookupTurns: async params => (await value.rpc(socket, "thread/turns/list", params)).result,
  }).then(result => { recovered = true; return result; });
  await sleep(100);
  assert.equal(recovered, false);
  assert.equal(value.shared.coordinator.status().threads.find(thread => thread.threadId === "draining-thread").phase, "active");
  value.release();
  assert.equal((await inflight).status, 200);
  assert.equal((await recovery).recovered, true);
  const state = value.shared.coordinator.status();
  assert.equal(state.threads.find(thread => thread.threadId === "draining-thread").phase, "terminal");
  assert.equal(state.nativeHealthy, true);
});

test("pending control receipt and the original timers survive a switch and finish without replay", { timeout: 20000 }, async context => {
  const value = await fixture(context);
  const { shared, participant } = value;
  const markers = [];
  const oldCandidate = await generation(value, "old-observer", markers);
  participant.activate(oldCandidate);
  shared.resources.publicationTimer = setInterval(shared.bindDispatch("refreshPublishedStatus"), 20);
  shared.resources.publicationTimer.unref();
  const control = shared.bindDispatch("dispatchControl");
  const binding = { ownerId: shared.configuration.ownerId, nativeSourceId: shared.configuration.nativeSourceId,
    instanceToken: shared.options.instanceToken };
  const selection = await control("status", binding);
  let releaseOperation;
  let executions = 0;
  const gate = new Promise(resolve => { releaseOperation = resolve; });
  const originalMigrate = shared.coordinator.migrate;
  shared.coordinator.migrate = async () => { executions += 1; await gate; return { migrated: "synthetic-control" }; };
  value.cleanup.push(async () => {
    releaseOperation();
    await until(() => !shared.controlBusy);
    shared.coordinator.migrate = originalMigrate;
  });
  const input = { ...binding, requestId: "isolated-control-operation", expectedRevision: selection.revision,
    selectedWorkerId: selection.selectedWorkerId, selectedSourceHashes: selection.selectedSourceHashes,
    candidateId: selection.selectedWorkerId, threadId: "synthetic-control", live: false };
  const operation = control("migrate", input);
  await until(() => executions === 1 && shared.resources.controlTimers.size === 1);
  const receipt = shared.controlOperations.get(input.requestId);
  const timer = [...shared.resources.controlTimers][0];
  const resources = identity(shared);
  const candidate = await generation(value, "new-control", markers);
  const token = participant.activate(candidate);
  assert.deepEqual(identity(shared), resources);
  assert.strictEqual([...shared.resources.controlTimers][0], timer);
  assert.equal(shared.controlRevision, 1);
  assert.equal(shared.controlBusy, true);
  await until(() => markers.some(marker => marker.label === "new-control" && marker.name === "refreshPublishedStatus"));
  const pending = await operation;
  assert.equal(pending.httpStatus, 202);
  assert.equal(receipt.state, "unknown");
  assert.ok(markers.some(marker => marker.label === "new-control" && marker.name === "handleControlDeadline"));
  assert.equal(markers.filter(marker => marker.label === "new-control" && marker.name === "dispatchControl").length, 0);
  releaseOperation();
  await until(() => receipt.state === "completed" && !shared.controlBusy);
  assert.strictEqual(shared.controlOperations.get(input.requestId), receipt);
  assert.deepEqual(receipt.result, { migrated: "synthetic-control" });
  assert.equal(shared.resources.controlTimers.size, 0);
  assert.equal(executions, 1);
  const after = await control("status", binding);
  assert.equal(after.operations.length, 1);
  assert.equal(after.revision, 1);
  await assert.rejects(control("migrate", input), /INNER_CONTROL_DUPLICATE_REQUEST_CHECK_STATUS/u);
  assert.equal(executions, 1);
  participant.restore(token);
  const newMarkers = markers.filter(marker => marker.label === "new-control").length;
  await sleep(60);
  assert.equal(markers.filter(marker => marker.label === "new-control").length, newMarkers);
  assert.strictEqual(shared.resources.publicationTimer, resources.publicationTimer);
  shared.coordinator.migrate = originalMigrate;
});

test("bad or side-effecting factories keep the current implementation and foreign tokens are rejected", { timeout: 20000 }, async context => {
  const value = await fixture(context);
  const foreign = await fixture(context, { start: false });
  const { participant, shared } = value;
  const before = participant.snapshot();
  const resources = identity(shared);
  const factory = sessionModule.createManagedInnerProxySessionImplementation;
  assert.throws(() => participant.prepare({}), /LIVE_CODE_EXPORT_MISSING/u);
  assert.throws(() => participant.prepare({ [participant.exportName]: () => { throw new Error("BAD_FACTORY"); } }), /BAD_FACTORY/u);
  assert.throws(() => participant.prepare({ [participant.exportName]: () => Promise.resolve({}) }), /LIVE_CODE_METHOD_MISSING/u);
  for (const name of Object.keys(before.implementation)) {
    assert.throws(() => participant.prepare({ [participant.exportName]: state => {
      const implementation = factory(state);
      delete implementation[name];
      return implementation;
    } }), /LIVE_CODE_METHOD_MISSING/u);
  }
  for (const mutation of [state => { state.started = false; }, state => { state.resources.publicationTimer = "foreign"; },
    state => state.controlOperations.set("foreign", {}), state => state.coordinator.close(),
    state => state.nativeSource.invalidate("foreign"), state => state.resolveCompletion("foreign")]) {
    assert.throws(() => participant.prepare({ [participant.exportName]: state => { mutation(state); return factory(state); } }), /FACTORY_SIDE_EFFECT/u);
  }
  const candidate = participant.prepare({ [participant.exportName]: factory });
  const foreignCandidate = foreign.participant.prepare({ [foreign.participant.exportName]: factory });
  assert.throws(() => participant.activate(foreignCandidate), /CANDIDATE_INVALID/u);
  assert.throws(() => participant.activate({ ...candidate }), /CANDIDATE_INVALID/u);
  assert.throws(() => participant.restore(foreign.participant.snapshot()), /SNAPSHOT_INVALID/u);
  assert.throws(() => participant.restore({ ...before }), /SNAPSHOT_INVALID/u);
  assert.deepEqual(participant.snapshot(), before);
  assert.deepEqual(identity(shared), resources);
  assert.equal(value.session.status().outer.state, "running");
  const token = participant.activate(candidate);
  assert.equal(value.session.status().outer.state, "running");
  participant.restore(token);
  assert.strictEqual(participant.snapshot().implementation, before.implementation);
});

test("legacy native closure is replaced only on first live notification while active ownership and repeats survive", { timeout: 20000 }, async context => {
  const value = await fixture(context);
  const { shared, participant } = value;
  const socket = await value.connect();
  await value.rpc(socket, "initialize", { clientInfo: { name: "legacy-native-handoff", version: "1" } });
  await value.turn(socket, "held-native-thread", "held-native-turn");
  const original = shared.nativeSource;
  const legacy = { observe: original.observe, status: original.status, invalidate: original.invalidate };
  shared.nativeSource = legacy;
  delete shared.nativeSourceGeneration;
  const coordinator = shared.coordinator;
  const stateBefore = coordinator.liveCodeParticipant().snapshot().state;
  const activeBefore = stateBefore.threads.get("held-native-thread");
  const sequenceBefore = stateBefore.nativeSequence;
  const markers = [];
  const candidate = await generation(value, "native-handoff", markers);
  assert.strictEqual(shared.nativeSource, legacy);
  assert.strictEqual(stateBefore.threads.get("held-native-thread"), activeBefore);
  participant.activate(candidate);
  assert.strictEqual(shared.nativeSource, legacy);
  const started = { method: "turn/started", params: { threadId: "held-native-thread", turn: { id: "held-native-turn" } } };
  await shared.dispatch("handleNativeTurn", started);
  assert.notStrictEqual(shared.nativeSource, legacy);
  assert.strictEqual(shared.coordinator, coordinator);
  assert.strictEqual(stateBefore.threads.get("held-native-thread"), activeBefore);
  await shared.dispatch("handleNativeTurn", started);
  assert.equal(stateBefore.nativeSequence, sequenceBefore);
  assert.equal(stateBefore.threads.get("held-native-thread").phase, "active");
  const completed = { method: "turn/completed", params: { threadId: "held-native-thread", turn: { id: "held-native-turn", status: "completed" } } };
  await shared.dispatch("handleNativeTurn", completed);
  await shared.dispatch("handleNativeTurn", completed);
  assert.equal(stateBefore.nativeSequence, sequenceBefore + 1);
  assert.equal(stateBefore.threads.get("held-native-thread").phase, "terminal");
  const current = shared.nativeSource;
  shared.dispatch("handleOuterEvent", {}, { type: "upstream_session_lost" });
  assert.equal(value.session.status().nativeSource.healthy, true);
  current.invalidate("NATIVE_SOURCE_CONFLICTING_DUPLICATE");
  const unavailable = await generation(value, "lost-native", markers);
  participant.activate(unavailable);
  assert.throws(() => shared.dispatch("handleNativeTurn", started), /UNAVAILABLE/u);
  assert.strictEqual(shared.nativeSource, current);
  assert.equal(value.session.status().nativeSource.failureCode, "NATIVE_SOURCE_CONFLICTING_DUPLICATE");
  console.log(JSON.stringify({ case: "legacy-native-live-factory-handoff", prepareMutation: false, sameCoordinator: true,
    sameActiveState: true, sequenceBefore, sequenceAfterCompletion: stateBefore.nativeSequence, duplicateRelay: false,
    eventGapPreservesSource: true, eventConflictPreserved: true, productionActions: 0, modelRequests: 0 }));
});
