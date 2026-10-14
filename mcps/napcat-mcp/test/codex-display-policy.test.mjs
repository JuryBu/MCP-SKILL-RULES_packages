import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createCodexAppServerProxy, createWakeJournal } from "../src/codex-app-server-proxy.mjs";
import { createCodexDisplayPolicyManager } from "../src/codex-display-policy.mjs";

function temporaryRoot(context) {
  const base = process.env.NAPCAT_DISPLAY_TEST_ROOT ?? os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "outer-full-display-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function policyFile(root, version, body) {
  const target = path.join(root, `${version}.mjs`);
  fs.writeFileSync(target, `export default { apiVersion: 1, version: ${JSON.stringify(version)}, decideReminder: ${body} };\n`);
  return target;
}

async function port() {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const result = server.address().port; await new Promise(resolve => server.close(resolve)); return result;
}

async function waitFor(predicate) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("WAIT_TIMEOUT");
}

test("display preparation validates a bounded synchronous decision and activation keeps the previous choice", async context => {
  const root = temporaryRoot(context);
  const manager = createCodexDisplayPolicyManager();
  const prepared = await manager.prepare(policyFile(root, "v1", '({ text }) => ({ visibility: "visible", text })'));
  assert.equal(prepared.prepared, true); assert.equal(manager.status().version, "original");
  assert.equal(manager.activate({ ...prepared }).activated, false);
  assert.equal(manager.activate(prepared).activated, true);
  assert.equal(manager.activate(prepared).activated, false);
  const illegal = await manager.prepare(policyFile(root, "illegal", '() => ({ visibility: "hidden", id: 7 })'));
  assert.equal(illegal.prepared, false); assert.equal(manager.status().version, "v1");
  const asynchronous = await manager.prepare(policyFile(root, "async-policy", 'async () => ({ visibility: "visible" })'));
  assert.equal(asynchronous.prepared, false); assert.equal(manager.status().version, "v1");
  const rejected = await manager.prepare(policyFile(root, "rejected-policy", '() => Promise.reject(new Error("ASYNC_FAILED"))'));
  assert.equal(rejected.prepared, false); assert.equal(manager.status().version, "v1");
  const broken = path.join(root, "broken.mjs"); fs.writeFileSync(broken, 'throw new Error("BAD_IMPORT");');
  assert.equal((await manager.prepare(broken)).prepared, false); assert.equal(manager.status().version, "v1");
});

test("a completed turn awaiting its start reply cannot claim a later turn's strategy", async context => {
  const root = temporaryRoot(context);
  const manager = createCodexDisplayPolicyManager();
  manager.activate(await manager.prepare(policyFile(root, "old", '() => ({ visibility: "inherit" })')));
  const view = manager.createView();
  view.observeRequest({ id: 888, method: "turn/start", params: { threadId: "thread" } });
  view.observeUpstream({ method: "turn/started", params: { threadId: "thread", turn: { id: "old-turn" } } });
  view.observeUpstream({ method: "turn/completed", params: { threadId: "thread", turn: { id: "old-turn", status: "completed" } } });
  manager.activate(await manager.prepare(policyFile(root, "new", '() => ({ visibility: "visible" })')));
  view.observeRequest({ id: 889, method: "turn/start", params: { threadId: "thread" } });
  view.observeUpstream({ method: "turn/started", params: { threadId: "thread", turn: { id: "new-turn" } } });
  assert.equal(view.policyForTurn("thread", "new-turn").policy.version, "new");
  view.observeUpstream({ id: 888, result: { turn: { id: "old-turn" } } });
  assert.equal(view.policyForTurn("thread", "old-turn").policy.version, "old");
  view.observeUpstream({ id: 889, result: { turn: { id: "new-turn" } } });
  assert.equal(view.snapshot().requests, 0);
});

test("the actual proxy keeps hidden identity, waiting tool and RPC owners through activation and journal reload", { timeout: 20000 }, async context => {
  const root = temporaryRoot(context);
  const journalPath = path.join(root, "journal.json");
  const journal = createWakeJournal({ filePath: journalPath });
  const writes = [];
  const write = journal.writeWake;
  journal.writeWake = (...args) => { writes.push(args); return write(...args); };
  const server = new WebSocketServer({ host: "127.0.0.1", port: await port() }); await once(server, "listening");
  const upstreamRequests = [];
  const held = [];
  const sockets = [];
  const turns = [];
  let holdReads = false;
  let turnCount = 0;
  let toolReplies = 0;
  function send(socket, message) { socket.send(JSON.stringify(message)); }
  function notify(socket, method, params) { send(socket, { method, params }); }
  const userItem = (id, text, clientId = null) => ({ type: "userMessage", id, clientId, content: [{ type: "text", text, text_elements: [] }] });
  server.on("connection", socket => {
    sockets.push(socket);
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString()); upstreamRequests.push(message);
      if (!message.method) { if (message.id === 700) toolReplies += 1; return; }
      const reply = value => send(socket, { id: message.id, result: value });
      if (message.method === "initialize") reply({ serverInfo: { name: "display-fixture" } });
      else if (message.method === "turn/start") {
        const turn = { id: `turn-${++turnCount}`, status: "inProgress", itemsView: "full", items: [userItem(`human-${turnCount}`, message.params.input[0].text)] }; turns.push(turn);
        reply({ turn }); notify(socket, "turn/started", { threadId: "thread", turn });
        notify(socket, "item/started", { threadId: "thread", turnId: turn.id, item: turn.items[0] });
        if (turnCount === 1) send(socket, { id: 700, method: "item/tool/call", params: { threadId: "thread", turnId: turn.id, callId: "once", tool: "counter" } });
      } else if (message.method === "thread/resume") reply({ thread: { id: "thread", status: { type: "active" }, turns } });
      else if (message.method === "thread/turns/list") reply({ data: turns });
      else if (message.method === "turn/steer") {
        const turn = turns.at(-1); const item = userItem(`wake-${turnCount}`, message.params.input[0].text, message.params.clientUserMessageId);
        turn.items.push(item); reply({ turnId: turn.id });
        for (const method of ["item/started", "item/completed"]) notify(socket, method, { threadId: "thread", turnId: turn.id, item });
      } else if (message.method === "thread/read") {
        const response = { id: message.id, result: { thread: { id: "thread", status: { type: "active" }, turns } } };
        if (holdReads) held.push({ socket, response: JSON.parse(JSON.stringify(response)) }); else send(socket, response);
      } else if (message.method === "turn/interrupt") {
        const turn = turns.find(value => value.id === message.params.turnId); turn.status = "interrupted";
        reply({}); notify(socket, "turn/completed", { threadId: "thread", turn });
      }
    });
  });
  const proxy = createCodexAppServerProxy({ upstreamUrl: `ws://127.0.0.1:${server.address().port}`, downstreamPort: await port(), controlPort: await port(), controlToken: "isolated-token", journal });
  const policy1 = policyFile(root, "v1", '() => ({ visibility: "inherit" })');
  const policy2 = policyFile(root, "v2", '({ text }) => ({ visibility: "visible", text: `[v2]${text}` })');
  assert.equal(proxy.activateDisplayPolicy(await proxy.prepareDisplayPolicy(policy1)).activated, true);
  await proxy.start();
  const client = new WebSocket(proxy.status().downstreamUrl);
  const messages = [];
  const waiting = new Map();
  const counts = new Map();
  let sequence = 1;
  let closes = 0;
  let reload;
  client.on("close", () => { closes += 1; });
  client.on("message", raw => {
    const message = JSON.parse(raw.toString()); messages.push(message);
    if (message.id != null && !message.method) { counts.set(message.id, (counts.get(message.id) ?? 0) + 1); const resolver = waiting.get(message.id); if (resolver) { waiting.delete(message.id); resolver(message.result); } }
  });
  context.after(async () => { client.close(); await proxy.close(); await reload?.close(); for (const socket of server.clients) socket.close(); await new Promise(resolve => server.close(resolve)); });
  await once(client, "open");
  function rpc(method, params, id = ++sequence) { return new Promise(resolve => { waiting.set(id, resolve); client.send(JSON.stringify({ id, method, params })); }); }
  await rpc("initialize", { clientInfo: { name: "fixture" } });
  const oldTurn = (await rpc("turn/start", { threadId: "thread", input: [{ type: "text", text: "human-old" }] })).turn;
  await waitFor(() => messages.some(message => message.method === "item/tool/call"));
  const wakeInput = (wakeId, prompt) => ({ taskId: "task", generation: 1, threadId: "thread", localRole: "development", sourceMachine: "training", targetMachine: "development", trustedPeerQq: "1000000001", wakeId, prompt, pendingThroughSequence: 1, pendingThroughTime: "2026-01-01T00:00:00Z", messageVisibility: "hidden" });
  await proxy.wakeThread(wakeInput("hidden-old", "secret-old")); await waitFor(() => journal.getWake("hidden-old")?.visibilityItemKey);
  assert.equal(messages.some(message => message.params?.item?.content?.[0]?.text === "secret-old"), false);
  holdReads = true;
  const history = rpc("thread/read", { threadId: "thread", includeTurns: true }, 777);
  let inspectCompletions = 0;
  const internal = proxy.inspectThread("thread").then(value => { inspectCompletions += 1; return value; });
  await waitFor(() => held.length === 2);
  const prepared = await proxy.prepareDisplayPolicy(policy2); assert.equal(proxy.status().displayPolicy.version, "v1");
  assert.equal(proxy.activateDisplayPolicy(prepared).activated, true);
  holdReads = false; for (const value of held.splice(0)) send(value.socket, value.response);
  assert.equal(JSON.stringify(await history).includes("secret-old"), false); await internal;
  assert.equal(counts.get(777), 1); assert.equal(inspectCompletions, 1);
  client.send(JSON.stringify({ id: 700, result: { success: true } })); await waitFor(() => toolReplies === 1);
  turns[0].status = "completed"; notify(sockets[0], "turn/completed", { threadId: "thread", turn: turns[0] });
  const newTurn = (await rpc("turn/start", { threadId: "thread", input: [{ type: "text", text: "human-new" }] })).turn;
  await proxy.wakeThread(wakeInput("new-reminder", "new-reminder")); await waitFor(() => journal.getWake("new-reminder")?.visibilityItemKey);
  assert.equal(journal.getWake("hidden-old").displayPolicyVersion, "v1"); assert.equal(journal.getWake("new-reminder").displayPolicyVersion, "v2");
  await waitFor(() => messages.some(message => message.params?.item?.content?.[0]?.text === "[v2]new-reminder"));
  const reRead = await rpc("thread/read", { threadId: "thread", includeTurns: true });
  assert.equal(JSON.stringify(reRead).includes("secret-old"), false); assert.equal(JSON.stringify(reRead).includes("[v2]new-reminder"), true);
  const fault = policyFile(root, "fault", '({ text }) => { if (text !== "display-policy-probe") throw new Error("PROCESSING_FAILED"); return { visibility: "inherit" }; }');
  assert.equal(proxy.activateDisplayPolicy(await proxy.prepareDisplayPolicy(fault)).activated, true);
  await rpc("turn/start", { threadId: "thread", input: [{ type: "text", text: "human-fault" }] });
  await proxy.wakeThread(wakeInput("fault-reminder", "fault-reminder")); await waitFor(() => journal.getWake("fault-reminder")?.visibilityItemKey);
  assert.equal(proxy.status().displayPolicy.version, "v2"); assert.equal(proxy.status().displayPolicy.failures, 1);
  assert.equal(writes.filter(([, patch]) => patch.displayDecision).length, 3);
  const hidden = policyFile(root, "hidden-policy", '() => ({ visibility: "hidden" })');
  assert.equal(proxy.activateDisplayPolicy(await proxy.prepareDisplayPolicy(hidden)).activated, true);
  await rpc("turn/start", { threadId: "thread", input: [{ type: "text", text: "human-visible-test" }] });
  await proxy.wakeThread({ ...wakeInput("visible-to-hidden", "visible-to-hidden"), messageVisibility: "visible" });
  await waitFor(() => journal.getWake("visible-to-hidden")?.visibilityItemKey);
  assert.equal(journal.getWake("visible-to-hidden").displayPolicyVersion, "hidden-policy");
  assert.equal(journal.getWake("visible-to-hidden").displayDecision.visibility, "hidden");
  assert.equal(messages.some(message => message.params?.item?.content?.[0]?.text === "visible-to-hidden"), false);
  await rpc("turn/interrupt", { threadId: "thread", turnId: oldTurn.id });
  assert.equal(proxy.status().clients[0].pendingInjectionCount, 0); assert.equal(closes, 0); assert.equal(sockets.length, 1);
  assert.equal(newTurn.id, "turn-2");
  reload = createCodexAppServerProxy({ upstreamUrl: `ws://127.0.0.1:${server.address().port}`, downstreamPort: await port(), controlPort: await port(), controlToken: "reload-token", journal: createWakeJournal({ filePath: journalPath }) });
  await reload.start(); const reloadClient = new WebSocket(reload.status().downstreamUrl); await once(reloadClient, "open");
  context.after(() => reloadClient.close());
  const reloadResult = new Promise(resolve => reloadClient.once("message", raw => resolve(JSON.parse(raw.toString()).result)));
  reloadClient.send(JSON.stringify({ id: 901, method: "thread/read", params: { threadId: "thread", includeTurns: true } }));
  const loaded = await reloadResult; assert.equal(JSON.stringify(loaded).includes("secret-old"), false); assert.equal(JSON.stringify(loaded).includes("[v2]new-reminder"), true);
});
