import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createCodexAppServerProxy, createWakeJournal } from "../src/codex-app-server-proxy.mjs";

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("active-turn fixture timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function fixture(context, options = {}) {
  const [upstreamPort, downstreamPort, controlPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-active-turn-"));
  const journalPath = path.join(root, "journal.json");
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
  const requests = [];
  const messages = [];
  const history = [{ id: "human-opening", type: "userMessage", clientId: "human", content: [{ type: "text", text: "original input" }] }];
  const threadId = "thread-active-fixture";
  const turnId = "turn-active-fixture";
  upstream.on("connection", socket => socket.on("message", bytes => {
    const request = JSON.parse(bytes.toString("utf8"));
    requests.push(request);
    const respond = result => socket.send(JSON.stringify({ id: request.id, result }));
    if (request.method === "initialize") respond({});
    else if (request.method === "thread/resume") {
      respond({ thread: { id: threadId, status: { type: "active", activeFlags: [] }, turns: [] } });
    } else if (request.method === "thread/turns/list") {
      if (options.lookupUnavailable) socket.send(JSON.stringify({ id: request.id, error: { code: -32601, message: "unsupported" } }));
      else respond({ data: options.noActiveTurn ? [] : [{ id: options.emptyTurnId ? "" : turnId, status: "inProgress", items: [], itemsView: "notLoaded" }] });
    } else if (["turn/steer", "turn/start"].includes(request.method)) {
      const item = { id: `injected-${history.length}`, type: "userMessage", clientId: request.params.clientUserMessageId ?? null, content: request.params.input };
      history.push(item);
      const notify = () => {
        for (const method of ["item/started", "item/completed"]) socket.send(JSON.stringify({ method, params: { threadId, turnId, item } }));
      };
      if (!options.eventsAfterReply) notify();
      if (options.disconnectAfterEvents) socket.close();
      else respond({ turnId: options.wrongTurnReply ? "wrong-turn" : turnId });
      if (options.eventsAfterReply) setTimeout(notify, options.eventDelayMs ?? 0);
    } else if (request.method === "thread/read") {
      respond({ thread: { id: threadId, turns: [{ id: turnId, status: "inProgress", items: history }] } });
    }
  }));
  const proxy = createCodexAppServerProxy({
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`, downstreamPort, controlPort,
    controlToken: "active-fixture-token", journal: createWakeJournal({ filePath: journalPath }), requestTimeoutMs: 500,
  });
  let desktop;
  context.after(async () => {
    desktop?.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise(resolve => upstream.close(resolve));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("wake-active-turn-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await proxy.start();
  desktop = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
  desktop.on("message", bytes => messages.push(JSON.parse(bytes.toString("utf8"))));
  await new Promise((resolve, reject) => { desktop.once("open", resolve); desktop.once("error", reject); });
  desktop.send(JSON.stringify({ id: 1, method: "initialize", params: {} }));
  await waitFor(() => proxy.status().readyClientCount === 1);
  const wake = index => ({
    taskId: "task-active-fixture", generation: 1, threadId, localRole: "development",
    sourceMachine: "training", targetMachine: "development", trustedPeerQq: "1000000001",
    wakeId: `wake-${index}`, pendingThroughSequence: 100 - index,
    pendingThroughTime: `2026-10-06T00:00:0${index}.000Z`,
    prompt: `[NAPCAT_TASK_WAKE]\nwake_id=fixture-${index}`, messageVisibility: "hidden",
  });
  return { proxy, desktop, messages, requests, history, journalPath, threadId, turnId, wake };
}

for (const eventsAfterReply of [false, true]) {
  test(`first five middle wakes are hidden with omitted original events, reply first=${eventsAfterReply}`, { timeout: 10000 }, async context => {
    const state = await fixture(context, { eventsAfterReply });
    for (let index = 0; index < 5; index += 1) {
      const result = await state.proxy.wakeThread(state.wake(index));
      assert.equal(result.outcome, "accepted");
      assert.equal(result.injectionMethod, "turn/steer");
      assert.equal(result.turn.id, state.turnId);
    }
    const visible = await state.proxy.wakeThread({ ...state.wake(5), messageVisibility: "visible" });
    assert.equal(visible.outcome, "accepted");
    state.desktop.send(JSON.stringify({ id: 100, method: "thread/read", params: { threadId: state.threadId } }));
    await waitFor(() => state.messages.some(message => message.id === 100));
    assert.equal(state.requests.filter(request => request.method === "turn/start").length, 0);
    for (const request of state.requests.filter(request => request.method === "thread/turns/list")) {
      assert.deepEqual(request.params, { threadId: state.threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
    }
    for (const request of state.requests.filter(request => request.method === "turn/steer")) assert.equal(request.params.expectedTurnId, state.turnId);
    assert.deepEqual(state.messages.filter(message => message.params?.item?.type === "userMessage").map(message => message.params.item.id), ["injected-6", "injected-6"]);
    const rendered = state.messages.find(message => message.id === 100).result.thread.turns[0].items;
    assert.deepEqual(rendered.map(item => item.id), ["human-opening", "injected-6"]);
    assert.equal(state.history.length, 7);
    const journal = JSON.parse(fs.readFileSync(state.journalPath, "utf8"));
    assert.equal(Object.values(journal.wakes).length, 6);
    assert.ok(Object.values(journal.wakes).every(wake => wake.status === "accepted" && wake.turnId === state.turnId));
  });
}

for (const options of [{ lookupUnavailable: true }, { noActiveTurn: true }, { emptyTurnId: true }]) {
  test(`busy lookup does not mutate or invent a turn: ${JSON.stringify(options)}`, { timeout: 10000 }, async context => {
    const state = await fixture(context, options);
    const result = await state.proxy.wakeThread(state.wake(0));
    assert.equal(result.outcome, "busy");
    assert.equal(result.started, false);
    assert.equal(state.requests.some(request => ["turn/start", "turn/steer"].includes(request.method)), false);
    assert.equal(JSON.parse(fs.readFileSync(state.journalPath, "utf8")).wakes["wake-0"].status, "failed_before_send");
  });
}

test("a mismatched accepted turn is unknown and the same wake is never resent", { timeout: 10000 }, async context => {
  const state = await fixture(context, { wrongTurnReply: true });
  await assert.rejects(state.proxy.wakeThread(state.wake(0)), error => error.code === "WAKE_RESULT_IDENTITY_MISMATCH" && error.outcomeUnknown);
  assert.equal(JSON.parse(fs.readFileSync(state.journalPath, "utf8")).wakes["wake-0"].status, "unknown");
  const repeat = await state.proxy.wakeThread(state.wake(0));
  assert.equal(repeat.duplicateSuppressed, true);
  assert.equal(state.requests.filter(request => request.method === "turn/steer").length, 1);
});

test("late notifications persist the authoritative item identity after an accepted reply", { timeout: 10000 }, async context => {
  const state = await fixture(context, { eventsAfterReply: true, eventDelayMs: 80 });
  await state.proxy.wakeThread(state.wake(0));
  await waitFor(() => JSON.parse(fs.readFileSync(state.journalPath, "utf8")).wakes["wake-0"].visibilityItemKey != null);
  const wake = JSON.parse(fs.readFileSync(state.journalPath, "utf8")).wakes["wake-0"];
  assert.equal(wake.visibilityItemKey, JSON.stringify([state.threadId, state.turnId, "injected-1"]));
  assert.equal(wake.visibilityClientId, state.history[1].clientId);
  assert.equal(state.messages.some(message => message.params?.item?.id === "injected-1"), false);
});

test("disconnect after notification retains known identity and never repeats the mutation", { timeout: 10000 }, async context => {
  const state = await fixture(context, { disconnectAfterEvents: true });
  await assert.rejects(state.proxy.wakeThread(state.wake(0)), error => error.outcomeUnknown);
  const wake = JSON.parse(fs.readFileSync(state.journalPath, "utf8")).wakes["wake-0"];
  assert.equal(wake.status, "unknown");
  assert.equal(wake.turnId, state.turnId);
  assert.equal(wake.injectionMethod, "turn/steer");
  assert.equal(wake.visibilityItemKey, JSON.stringify([state.threadId, state.turnId, "injected-1"]));
  assert.equal((await state.proxy.wakeThread(state.wake(0))).duplicateSuppressed, true);
  assert.equal(state.requests.filter(request => request.method === "turn/steer").length, 1);
});
