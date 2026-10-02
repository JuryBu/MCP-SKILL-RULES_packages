import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import {
  createCodexAppServerProxy,
  createWakeJournal,
} from "../src/codex-app-server-proxy.mjs";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(predicate, label, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function rawJson(message) {
  return Buffer.from(` \n${JSON.stringify(message, null, 2)}\n `, "utf8");
}

function frame(data, isBinary = false) {
  const bytes = Buffer.from(data);
  return { bytes, isBinary, message: JSON.parse(bytes.toString("utf8")) };
}

function itemFieldDiff(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => !isDeepStrictEqual(before[field], after[field]));
}

function audit(context, label, original, received, beforeItem, afterItem) {
  context.diagnostic(JSON.stringify({
    label,
    originalUtf8: original.toString("utf8"),
    receivedUtf8: received.bytes.toString("utf8"),
    originalByteLength: original.length,
    receivedByteLength: received.bytes.length,
    sameBytes: original.equals(received.bytes),
    itemFieldDiff: beforeItem ? itemFieldDiff(beforeItem, afterItem) : [],
  }));
  assert.equal(received.isBinary, false, `${label}：文本帧类型不变`);
}

function assertBytePass(context, label, original, received, beforeItem, afterItem) {
  audit(context, label, original, received, beforeItem, afterItem);
  assert.deepEqual(received.bytes, original, `${label}：WebSocket payload 逐字节透传`);
  if (beforeItem) assert.deepEqual(afterItem, beforeItem, `${label}：item 字段不变`);
}

function assertProjection(context, label, original, received, beforeItem, afterItem, expected) {
  audit(context, label, original, received, beforeItem, afterItem);
  assert.deepEqual(itemFieldDiff(beforeItem, afterItem), ["summary"]);
  assert.deepEqual(received.message, expected, `${label}：除指定 summary 外完整消息不变`);
  assert.equal(original.equals(received.bytes), false);
  assert.deepEqual(JSON.parse(original.toString("utf8")).params?.item ?? beforeItem, beforeItem);
}

function completion(item, threadId = "transport-thread", turnId = "transport-turn") {
  return {
    jsonrpc: "2.0",
    method: "item/completed",
    params: { threadId, turnId, item, transportMetadata: { ordinal: 17, preserved: true } },
  };
}

const emptyItem = {
  type: "reasoning",
  id: "transport-empty-reasoning",
  summary: [],
  content: [],
  extension: { tokenCount: 37, preserved: "中文与空白" },
};

function internalResumeResult(threadId) {
  return {
    thread: {
      id: threadId,
      status: "inProgress",
      turns: [
        { id: "transport-hidden-turn", status: "inProgress", items: [] },
        { id: "internal-completed-turn", status: "completed", itemsView: "full", items: [emptyItem] },
      ],
    },
    internalMetadata: { preserved: true },
  };
}

async function createFixture(context) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reasoning-placeholder-transport-"));
  const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const connections = [];
  const downstreamSockets = new Set();
  const errors = [];
  let proxy;
  let closing;
  const close = () => {
    closing ??= (async () => {
      try {
        for (const socket of downstreamSockets) socket.terminate();
        for (const socket of upstream.clients) socket.terminate();
        proxy?.controlServer?.closeAllConnections?.();
        await proxy?.close();
      } finally {
        try {
          for (const socket of upstream.clients) socket.terminate();
          await new Promise((resolve) => upstream.close(resolve));
        } finally {
          fs.rmSync(temporaryRoot, { recursive: true, force: true });
        }
      }
      await waitFor(() => upstream.clients.size === 0
        && [...downstreamSockets].every((socket) => socket.readyState === WebSocket.CLOSED), "环回 socket close 事件完成");
      assert.equal(fs.existsSync(temporaryRoot), false);
      assert.equal(upstream.clients.size, 0);
      assert.equal(proxy?.status().clientCount ?? 0, 0);
      context.diagnostic("清理完成：本测试 TEMP 目录已移除，所有环回 socket/server 已关闭");
    })();
    return closing;
  };
  context.after(close);
  upstream.on("error", (error) => errors.push(error));
  upstream.on("connection", (socket) => {
    const connection = { upstream: socket, upstreamFrames: [], downstreamFrames: [] };
    connections.push(connection);
    socket.on("error", (error) => errors.push(error));
    socket.on("message", (data, isBinary) => {
      const received = frame(data, isBinary);
      connection.upstreamFrames.push(received);
      const message = received.message;
      if (typeof message.id !== "number" || message.id >= 0) return;
      let result;
      if (message.method === "thread/resume") result = internalResumeResult(message.params.threadId);
      else if (message.method === "turn/steer") {
        result = { turn: { id: message.params.expectedTurnId, status: "inProgress", items: [emptyItem] } };
      } else return;
      socket.send(rawJson({ jsonrpc: "2.0", id: message.id, result }), { binary: false });
    });
  });
  try {
    await waitFor(() => upstream.address(), "假上游监听");
    const upstreamPort = upstream.address().port;
    const usedPorts = new Set([upstreamPort]);
    const allocatePort = async () => {
      let port;
      do port = await freePort();
      while (usedPorts.has(port) || (port >= 18431 && port <= 18433));
      usedPorts.add(port);
      return port;
    };
    const downstreamPort = await allocatePort();
    const controlPort = await allocatePort();
    proxy = createCodexAppServerProxy({
      downstreamPort,
      controlPort,
      upstreamUrl: `ws://127.0.0.1:${upstreamPort}`,
      controlToken: "isolated-transport-fixture-token",
      journal: createWakeJournal({ filePath: path.join(temporaryRoot, "wake-journal.json") }),
      maintenanceFilePath: path.join(temporaryRoot, "maintenance.json"),
      requestTimeoutMs: 2000,
      resumeRequestTimeoutMs: 2000,
    });
    await proxy.start();
    context.diagnostic(JSON.stringify({
      scope: "真实环回 WebSocket payload 验证，不是 Desktop UI 验收",
      upstreamPort, downstreamPort, controlPort,
    }));
    return {
      proxy,
      close,
      async connect() {
        const index = connections.length;
        const downstream = new WebSocket(`ws://127.0.0.1:${downstreamPort}`);
        const received = [];
        downstreamSockets.add(downstream);
        downstream.on("message", (data, isBinary) => received.push(frame(data, isBinary)));
        downstream.on("error", (error) => errors.push(error));
        await waitFor(() => downstream.readyState === WebSocket.OPEN && connections.length > index, "双向连接");
        const connection = connections[index];
        connection.downstream = downstream;
        connection.downstreamFrames = received;
        return connection;
      },
      async request(connection, label, requestMessage, responseMessage) {
        const original = rawJson(requestMessage);
        const upstreamIndex = connection.upstreamFrames.length;
        const downstreamIndex = connection.downstreamFrames.length;
        connection.downstream.send(original, { binary: false });
        await waitFor(() => connection.upstreamFrames.length > upstreamIndex, `${label} 请求抵达上游`);
        assertBytePass(context, `${label} 外部请求`, original, connection.upstreamFrames[upstreamIndex]);
        assert.equal(connection.upstreamFrames.length, upstreamIndex + 1, "外部请求按顺序且没有多余请求");
        const responseRaw = rawJson(responseMessage);
        connection.upstream.send(responseRaw, { binary: false });
        await waitFor(() => connection.downstreamFrames.length > downstreamIndex, `${label} 响应抵达下游`);
        assert.equal(errors.length, 0, errors.map((error) => error.message).join("; "));
        return { original: responseRaw, received: connection.downstreamFrames[downstreamIndex] };
      },
      async deliver(connection, label, message) {
        const original = rawJson(message);
        const index = connection.downstreamFrames.length;
        connection.upstream.send(original, { binary: false });
        await waitFor(() => connection.downstreamFrames.length > index, label);
        assert.equal(errors.length, 0, errors.map((error) => error.message).join("; "));
        return { original, received: connection.downstreamFrames[index] };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function initialize(context, fixture, connection, name, id) {
  const clientInfo = name === undefined ? {} : { name, version: "transport-test", title: "本地隔离测试" };
  const reply = await fixture.request(connection, `${name ?? "missing-clientInfo.name"} initialize`, {
    jsonrpc: "2.0", id, method: "initialize",
    params: { clientInfo, capabilities: { experimentalApi: true } },
  }, { jsonrpc: "2.0", id, result: { serverInfo: { name: "isolated-fake-app-server" } } });
  assertBytePass(context, "initialize 响应", reply.original, reply.received);
  await waitFor(() => fixture.proxy.status().readyClientCount > 0, "initialize 完成");
}

test("Desktop completed-turn lifecycle stays bounded beyond 128 real socket rounds", { timeout: 15000 }, async (context) => {
  const fixture = await createFixture(context);
  try {
    const connection = await fixture.connect();
    await initialize(context, fixture, connection, "Codex Desktop", 1);
    for (let turnIndex = 1; turnIndex <= 150; turnIndex += 1) {
      const turnId = `lifetime-${turnIndex}`;
      const started = await fixture.request(connection, "confirmed Desktop turn/start", {
        id: 100 + turnIndex, method: "turn/start", params: { threadId: "lifetime-thread", input: [] },
      }, { id: 100 + turnIndex, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      assert.deepEqual(started.received.bytes, started.original);
      await fixture.deliver(connection, "new live turn", { method: "turn/started",
        params: { threadId: "lifetime-thread", turn: { id: turnId, status: "inProgress", items: [] } } });
      const item = { ...emptyItem, id: `lifetime-item-${turnIndex}`,
        summary: turnIndex % 10 === 0 ? ["合成真实摘要"] : [] };
      const message = { method: "turn/completed", params: { threadId: "lifetime-thread",
        turn: { id: turnId, status: "completed", itemsView: "full", items: [item] } } };
      const reply = await fixture.deliver(connection, "completed live turn", message);
      assert.deepEqual(reply.received.message.params.turn.items[0].summary,
        turnIndex % 10 === 0 ? ["合成真实摘要"] : ["推理片段1已收到，摘要为空"]);
      if (turnIndex % 10 === 0) assert.deepEqual(reply.original, reply.received.bytes);
    }
    const state = fixture.proxy.status().clients[0].reasoningPlaceholder;
    assert.equal(state.trackingAvailable, true);
    assert.equal(state.turnCount, 128);
    assert.equal(state.evictedTurns, 22);
    assert.ok(state.retainedBytes <= 1024 * 1024);
    const late = completion({ ...emptyItem, id: "lifetime-item-1" }, "lifetime-thread", "lifetime-1");
    const reply = await fixture.deliver(connection, "evicted late completion", late);
    assert.deepEqual(reply.original, reply.received.bytes);
    context.diagnostic(JSON.stringify({ lifetimeCompletedTurns: 150, state, latePayloadUnchanged: true }));
  } finally {
    await fixture.close();
  }
});

test("Desktop item overflow stays scoped across real sockets and preserves late genuine data", { timeout: 15000 }, async (context) => {
  const fixture = await createFixture(context);
  try {
    const connection = await fixture.connect();
    await initialize(context, fixture, connection, "Codex Desktop", 1);
    await fixture.deliver(connection, "long turn begins", { method: "turn/started",
      params: { threadId: "capacity-thread", turn: { id: "long", status: "inProgress", items: [] } } });
    const startingFrame = connection.downstreamFrames.length;
    for (let itemIndex = 1; itemIndex <= 512; itemIndex += 1) {
      connection.upstream.send(rawJson(completion({ ...emptyItem, id: `capacity-${itemIndex}` }, "capacity-thread", "long")), { binary: false });
    }
    await waitFor(() => connection.downstreamFrames.length >= startingFrame + 512, "512 real reasoning frames");
    for (let itemIndex = 1; itemIndex <= 512; itemIndex += 1) {
      assert.deepEqual(connection.downstreamFrames[startingFrame + itemIndex - 1].message.params.item.summary,
        [`推理片段${itemIndex}已收到，摘要为空`]);
    }
    const delta = { method: "item/reasoning/summaryTextDelta",
      params: { threadId: "capacity-thread", turnId: "long", itemId: "capacity-1", delta: "真实文字仍然保留" } };
    const deltaReply = await fixture.deliver(connection, "genuine delta before overflow", delta);
    assert.deepEqual(deltaReply.received.bytes, deltaReply.original);
    const overflow = completion({ ...emptyItem, id: "capacity-513" }, "capacity-thread", "long");
    const overflowReply = await fixture.deliver(connection, "overflow bypass", overflow);
    assert.deepEqual(overflowReply.received.bytes, overflowReply.original);
    const late = completion({ ...emptyItem, id: "capacity-1" }, "capacity-thread", "long");
    const lateReply = await fixture.deliver(connection, "late genuine item remains original", late);
    assert.deepEqual(lateReply.received.bytes, lateReply.original);
    await fixture.deliver(connection, "other thread begins", { method: "turn/started",
      params: { threadId: "healthy-thread", turn: { id: "fresh", status: "inProgress", items: [] } } });
    const freshReply = await fixture.deliver(connection, "healthy thread placeholder",
      completion({ ...emptyItem, id: "fresh-item" }, "healthy-thread", "fresh"));
    assert.deepEqual(freshReply.received.message.params.item.summary, ["推理片段1已收到，摘要为空"]);
    const state = fixture.proxy.status().clients[0].reasoningPlaceholder;
    assert.equal(state.trackingAvailable, true);
    assert.equal(state.disabledReason, null);
    assert.equal(state.suspendedTurns, 1);
    assert.equal(state.capacityBypasses, 1);
    assert.ok(state.retainedBytes - state.turnHistoryBytes < 1000);
    context.diagnostic(JSON.stringify({ liveReasoningFrames: 513, otherThreadHealthy: true,
      genuineAndOverflowWireUnchanged: true, state }));
  } finally {
    await fixture.close();
  }
});

test("Desktop 真实传输仅投影空 completed reasoning，外部请求及分页字段保真", { timeout: 15000 }, async (context) => {
  const fixture = await createFixture(context);
  try {
    const connection = await fixture.connect();
    await initialize(context, fixture, connection, "Codex Desktop", 1);
    for (const message of [
      { jsonrpc: "2.0", method: "turn/started", params: { threadId: "transport-thread", turn: { id: "transport-turn", status: "inProgress", items: [] } } },
      { ...completion(emptyItem), method: "item/started" },
    ]) {
      const reply = await fixture.deliver(connection, message.method, message);
      assertBytePass(context, message.method, reply.original, reply.received);
    }
    const message = completion(emptyItem);
    const projected = await fixture.deliver(connection, "空 completed reasoning", message);
    const expected = structuredClone(message);
    expected.params.item.summary = ["推理片段1已收到，摘要为空"];
    assertProjection(context, "空 completed reasoning", projected.original, projected.received,
      emptyItem, projected.received.message.params.item, expected);

    for (const item of [
      { ...emptyItem, id: "real-summary", summary: ["真实摘要，保留原文"] },
      { type: "agentMessage", id: "non-reasoning", text: "正文不变", summary: [], extension: { preserved: true } },
      { ...emptyItem, id: "real-content", content: ["真实 reasoning 内容"] },
      { ...emptyItem, summary: ["权威更新替换先前占位"] },
    ]) {
      const reply = await fixture.deliver(connection, item.id, completion(item));
      assertBytePass(context, item.id, reply.original, reply.received, item, reply.received.message.params.item);
    }
    const deltaItem = { ...emptyItem, id: "prior-visible-delta" };
    const delta = { jsonrpc: "2.0", method: "item/reasoning/summaryTextDelta", params: {
      threadId: "transport-thread", turnId: "transport-turn", itemId: deltaItem.id, delta: "可见的真实摘要片段",
    } };
    const deltaReply = await fixture.deliver(connection, "真实 delta", delta);
    assertBytePass(context, "真实 delta", deltaReply.original, deltaReply.received);
    const deltaCompletion = await fixture.deliver(connection, "真实 delta 后的空完成项", completion(deltaItem));
    assertBytePass(context, "真实 delta 后的空完成项", deltaCompletion.original, deltaCompletion.received,
      deltaItem, deltaCompletion.received.message.params.item);

    for (const [itemId, index] of [["after-real", 1], ["after-real", 1], ["following-empty", 2]]) {
      const item = { ...emptyItem, id: itemId };
      const message = completion(item);
      const reply = await fixture.deliver(connection, "真实文字后连续空摘要", message);
      const expected = structuredClone(message);
      expected.params.item.summary = [`推理片段${index}已收到，摘要为空`];
      assertProjection(context, "真实文字后连续空摘要", reply.original, reply.received,
        item, reply.received.message.params.item, expected);
    }

    const historyResult = {
      data: [
        { item: { ...emptyItem, id: "history-empty" }, turnId: "history-turn", completedAtMs: 1750000000000, ordinal: 9, rowMetadata: { preserved: true } },
        { item: { ...emptyItem, id: "history-in-progress" }, turnId: "history-turn", completedAtMs: null, ordinal: 10 },
        { item: { ...emptyItem, id: "history-real", summary: ["历史真实摘要"] }, turnId: "history-turn", completedAtMs: 1750000000001, ordinal: 11 },
        { item: { type: "agentMessage", id: "history-answer", text: "历史正文", summary: [] }, turnId: "history-turn", completedAtMs: 1750000000002, ordinal: 12 },
      ],
      nextCursor: "opaque:next/中文==",
      previousCursor: "opaque:previous==",
      itemsPagination: { hasMore: true, cursor: "nested-cursor" },
      resultMetadata: { total: 84, preserved: true },
    };
    const untracked = await fixture.deliver(connection, "未跟踪的分页响应", { jsonrpc: "2.0", id: 8001, result: historyResult });
    assertBytePass(context, "未跟踪的分页响应", untracked.original, untracked.received);
    const historyResponse = { jsonrpc: "2.0", id: 30, result: historyResult, envelopeMetadata: { preserved: true } };
    const historyReply = await fixture.request(connection, "tracked thread/items/list", {
      jsonrpc: "2.0", id: 30, method: "thread/items/list",
      params: { threadId: "history-thread", cursor: "opaque:requested==", sortDirection: "desc", limit: 4 },
    }, historyResponse);
    const expectedHistory = structuredClone(historyResponse);
    expectedHistory.result.data[0].item.summary = ["推理片段已收到，摘要为空"];
    assertProjection(context, "tracked thread/items/list", historyReply.original, historyReply.received,
      historyResult.data[0].item, historyReply.received.message.result.data[0].item, expectedHistory);
    const consumed = await fixture.deliver(connection, "已消费的 request id 不再投影", historyResponse);
    assertBytePass(context, "已消费的 request id 不再投影", consumed.original, consumed.received);
  } finally {
    await fixture.close();
  }
});

test("CLI、unknown 和缺少 name 的客户端对相同空 item 与 tracked history 逐字节透传", { timeout: 15000 }, async (context) => {
  const fixture = await createFixture(context);
  try {
    let requestId = 100;
    for (const name of ["codex_cli_rs", "codex_cli", "unknown-client", undefined]) {
      const connection = await fixture.connect();
      await initialize(context, fixture, connection, name, requestId++);
      const reply = await fixture.deliver(connection, `${name ?? "missing-name"} 相同 item`, completion(emptyItem));
      assertBytePass(context, `${name ?? "missing-name"} 相同 item`, reply.original, reply.received,
        emptyItem, reply.received.message.params.item);
      const id = requestId++;
      const result = { data: [{ item: emptyItem, turnId: "transport-turn", completedAtMs: 1750000000000 }], nextCursor: "cli-cursor", extra: { preserved: true } };
      const history = await fixture.request(connection, `${name ?? "missing-name"} tracked history`, {
        jsonrpc: "2.0", id, method: "thread/items/list", params: { threadId: "transport-thread" },
      }, { jsonrpc: "2.0", id, result });
      assertBytePass(context, `${name ?? "missing-name"} tracked history`, history.original, history.received,
        emptyItem, history.received.message.result.data[0].item);
    }
  } finally {
    await fixture.close();
  }
});

test("内部 RPC 不泄漏或投影，hidden busy wake 过滤与 Desktop reasoning 投影可共存", { timeout: 15000 }, async (context) => {
  const fixture = await createFixture(context);
  try {
    const connection = await fixture.connect();
    await initialize(context, fixture, connection, "Codex Desktop", 200);
    const beforeInternal = connection.downstreamFrames.length;
    const subscribed = await fixture.proxy.subscribeThread("transport-hidden-thread");
    assert.deepEqual(subscribed.results, [internalResumeResult("transport-hidden-thread")]);
    const prompt = "[NAPCAT_TASK_WAKE]\nwake_id=isolated-hidden-wake";
    const wake = await fixture.proxy.wakeThread({
      taskId: "isolated-transport-task", generation: 1,
      threadId: "transport-hidden-thread", localRole: "development",
      sourceMachine: "training", targetMachine: "development", trustedPeerQq: "1000000001",
      wakeId: "isolated-hidden-wake", pendingThroughSequence: 1,
      pendingThroughTime: "2026-09-30T00:00:00.000Z", prompt, messageVisibility: "hidden",
    });
    assert.equal(wake.started, true);
    assert.equal(wake.injectionMethod, "turn/steer");
    assert.equal(wake.messageVisibility, "hidden");
    assert.equal(wake.clientUserMessageId, null);
    assert.deepEqual(wake.raw, { turn: { id: "transport-hidden-turn", status: "inProgress", items: [emptyItem] } });
    const internalRequests = connection.upstreamFrames.filter((entry) => entry.message.id < 0);
    assert.deepEqual(internalRequests.map((entry) => entry.message.method), ["thread/resume", "thread/resume", "turn/steer"]);
    const steer = internalRequests[2].message;
    assert.deepEqual(steer.params, {
      threadId: "transport-hidden-thread", input: [{ type: "text", text: prompt }], expectedTurnId: "transport-hidden-turn",
    });
    context.diagnostic(JSON.stringify({
      label: "隔离 hidden wake 内部请求",
      originalUtf8: internalRequests.map((entry) => entry.bytes.toString("utf8")),
      internalResultItemFieldDiff: itemFieldDiff(emptyItem, wake.raw.turn.items[0]),
      clientUserMessageIdPresent: Object.hasOwn(steer.params, "clientUserMessageId"),
    }));
    const barrier = { jsonrpc: "2.0", method: "turn/started", params: {
      threadId: "transport-hidden-thread", turn: { id: "transport-hidden-turn", status: "inProgress", items: [] },
    } };
    const barrierReply = await fixture.deliver(connection, "内部响应后的 FIFO 屏障", barrier);
    assertBytePass(context, "内部响应后的 FIFO 屏障", barrierReply.original, barrierReply.received);
    assert.equal(connection.downstreamFrames.length, beforeInternal + 1, "内部 RPC 响应未泄漏到下游");
    const genuineUser = { type: "userMessage", id: "genuine-first-user", content: [{ type: "text", text: "原始用户消息" }] };
    const genuine = await fixture.deliver(connection, "真实用户项", completion(genuineUser, "transport-hidden-thread", "transport-hidden-turn"));
    assertBytePass(context, "真实用户项", genuine.original, genuine.received, genuineUser, genuine.received.message.params.item);
    const hiddenUser = { type: "userMessage", id: "hidden-wake-user", content: [{ type: "text", text: prompt }] };
    const beforeHidden = connection.downstreamFrames.length;
    for (const method of ["item/started", "item/completed"]) {
      const hiddenMessage = { ...completion(hiddenUser, "transport-hidden-thread", "transport-hidden-turn"), method };
      const original = rawJson(hiddenMessage);
      context.diagnostic(JSON.stringify({ label: `hidden wake ${method} 原始上游 payload`, originalUtf8: original.toString("utf8") }));
      connection.upstream.send(original, { binary: false });
    }
    const reasoningMessage = completion({ ...emptyItem, id: "reason-after-hidden" }, "transport-hidden-thread", "transport-hidden-turn");
    const reasoning = await fixture.deliver(connection, "hidden wake 后 reasoning FIFO 屏障", reasoningMessage);
    const expected = structuredClone(reasoningMessage);
    expected.params.item.summary = ["推理片段1已收到，摘要为空"];
    assertProjection(context, "hidden wake 后 reasoning FIFO 屏障", reasoning.original, reasoning.received,
      reasoningMessage.params.item, reasoning.received.message.params.item, expected);
    assert.equal(connection.downstreamFrames.length, beforeHidden + 1, "两条 hidden user 事件被过滤，reasoning 仍抵达");
  } finally {
    await fixture.close();
  }
});
