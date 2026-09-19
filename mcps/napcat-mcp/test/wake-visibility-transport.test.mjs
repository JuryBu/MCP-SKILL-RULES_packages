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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("transport fixture timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("real WebSocket forwarding hides only registered middle wakes across Desktop connections", { timeout: 15000 }, async context => {
  const [upstreamPort, downstreamPort, controlPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-visibility-transport-"));
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: upstreamPort });
  const requests = [];
  const history = [];
  const threadId = "thread-transport";
  const turnId = "turn-transport";
  const notify = message => {
    for (const socket of upstream.clients) socket.send(JSON.stringify(message));
  };
  const emitUser = (id, content, clientId = null) => {
    const item = { type: "userMessage", id, clientId, content };
    history.push(item);
    for (const method of ["item/started", "item/completed"]) {
      notify({ jsonrpc: "2.0", method, params: { threadId, turnId, item } });
    }
  };
  upstream.on("connection", socket => socket.on("message", data => {
    const message = JSON.parse(data.toString("utf8"));
    const respond = result => socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") respond({});
    else if (message.method === "thread/resume") {
      respond({ thread: { id: threadId, status: { type: history.length ? "active" : "idle" }, turns: [] } });
    } else if (message.method === "turn/start") {
      requests.push(structuredClone(message.params));
      if (!history.length) notify({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
      emitUser(`wake-item-${requests.length}`, message.params.input, message.params.clientUserMessageId ?? null);
      respond({ turn: { id: turnId, status: "inProgress" } });
    } else if (message.method === "thread/read") {
      respond({ thread: { id: threadId, turns: [{ id: turnId, items: history, status: "inProgress" }] } });
    }
  }));
  const journalPath = path.join(root, "wake-journal.json");
  const proxy = createCodexAppServerProxy({
    upstreamUrl: `ws://127.0.0.1:${upstreamPort}`, downstreamPort, controlPort,
    controlToken: "transport-fixture", journal: createWakeJournal({ filePath: journalPath }),
  });
  const desktops = [];
  context.after(async () => {
    for (const { socket } of desktops) socket.terminate();
    await proxy.close();
    for (const socket of upstream.clients) socket.terminate();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await proxy.start();
  for (let index = 0; index < 2; index += 1) {
    const socket = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
    const messages = [];
    desktops.push({ socket, messages });
    socket.on("message", data => messages.push(JSON.parse(data.toString("utf8"))));
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: index + 1, method: "initialize", params: {} }));
  }
  await waitFor(() => proxy.status().readyClientCount === 2);
  const base = {
    taskId: "task-transport", generation: 1, threadId, localRole: "development",
    sourceMachine: "training", targetMachine: "development", trustedPeerQq: "1000000001",
  };
  const prompts = ["[NAPCAT_TASK_WAKE]\nwake_id=opening", "[NAPCAT_TASK_WAKE]\nwake_id=middle", "[NAPCAT_TASK_WAKE]\nwake_id=visible"];
  for (let index = 0; index < prompts.length; index += 1) {
    const result = await proxy.wakeThread({
      ...base, wakeId: `wake-${index}`, pendingThroughSequence: index + 1,
      pendingThroughTime: `2026-09-19T00:00:0${index}.000Z`, prompt: prompts[index],
      messageVisibility: index === 2 ? "visible" : "hidden",
    });
    assert.equal(result.outcome, "accepted");
    assert.equal(result.turn.id, turnId);
    assert.deepEqual(requests[index].input, [{ type: "text", text: prompts[index] }]);
  }
  emitUser("manual-user", [{ type: "text", text: prompts[1] }], "human-client-id");
  emitUser("unregistered", [{ type: "text", text: "[NAPCAT_TASK_WAKE]\nwake_id=unknown" }]);
  const toolNotification = {
    method: "item/completed", params: { threadId, turnId, item: { type: "mcpToolCall", id: "tool-fixture", status: "completed" } },
  };
  notify(toolNotification);
  notify({ method: "thread/name/updated", params: { threadId, threadName: "barrier-final" } });
  await waitFor(() => desktops.every(({ messages }) => messages.some(message => message.params?.threadName === "barrier-final")));
  for (const { messages } of desktops) {
    const userItems = messages.filter(message => message.params?.item?.type === "userMessage");
    assert.deepEqual(userItems.map(message => message.params.item.id), [
      "wake-item-1", "wake-item-1", "wake-item-3", "wake-item-3",
      "manual-user", "manual-user", "unregistered", "unregistered",
    ]);
    assert.ok(messages.some(message => JSON.stringify(message) === JSON.stringify(toolNotification)));
    assert.equal(messages.some(message => typeof message.id === "number" && message.id < 0), false);
  }
  desktops[0].socket.send(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "thread/read", params: { threadId } }));
  await waitFor(() => desktops[0].messages.some(message => message.id === 99));
  const persisted = desktops[0].messages.find(message => message.id === 99).result.thread.turns[0].items;
  assert.deepEqual(persisted, history);
  assert.equal(persisted.some(item => item.id === "wake-item-2"), true);
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  assert.equal(Object.values(journal.wakes).every(wake => wake.status === "accepted"), true);
});
