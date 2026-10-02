import assert from "node:assert/strict";
import test from "node:test";
import { createReasoningPlaceholderView } from "../src/reasoning-placeholder.mjs";

function view(options = {}) {
  const projector = createReasoningPlaceholderView(options);
  projector.observeRequest({ method: "initialize", params: { clientInfo: { name: "Codex Desktop" } } });
  return projector;
}

function start(projector, turnId, threadId = "thread") {
  projector.project({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
}

function empty(itemId, turnId, threadId = "thread") {
  return { method: "item/completed", params: { threadId, turnId,
    item: { type: "reasoning", id: itemId, summary: [], content: [] } } };
}

function finish(projector, turnId, status = "completed", threadId = "thread") {
  projector.project({ method: "turn/completed", params: { threadId, turn: { id: turnId, status, items: [] } } });
}

function read(projector, turns, requestId = "read") {
  projector.observeRequest({ id: requestId, method: "thread/read", params: { threadId: "thread" } });
  return projector.project({ id: requestId, result: { thread: { id: "thread", turns } } });
}

test("513 reasoning items bypass only the overlong turn and release its item storage", () => {
  const projector = view();
  start(projector, "long");
  for (let itemIndex = 1; itemIndex <= 512; itemIndex += 1) {
    assert.deepEqual(projector.project(empty(`item-${itemIndex}`, "long")).params.item.summary,
      [`推理片段${itemIndex}已收到，摘要为空`]);
  }
  const bytesBefore = projector.status().retainedBytes;
  const overflow = empty("item-513", "long");
  assert.equal(projector.project(overflow), overflow);
  assert.equal(projector.status().trackingAvailable, true);
  assert.equal(projector.status().disabledReason, null);
  assert.deepEqual(projector.status().lastCapacity, { reason: "items_capacity", scope: JSON.stringify(["thread", "long"]) });
  assert.ok(projector.status().retainedBytes < bytesBefore / 2);
  const late = empty("item-1", "long");
  assert.equal(projector.project(late), late);
  start(projector, "healthy", "another-thread");
  assert.deepEqual(projector.project(empty("fresh", "healthy", "another-thread")).params.item.summary,
    ["推理片段1已收到，摘要为空"]);
  finish(projector, "long");
  assert.equal(projector.status().capacityBypasses, 1);
});

test("overflow cannot invent a placeholder for a genuine delta received before or after bypass", () => {
  const projector = view({ maximumItems: 2 });
  start(projector, "long");
  for (const itemId of ["visible", "first-overflow", "later-visible"]) {
    projector.project({ method: "item/reasoning/summaryTextDelta",
      params: { threadId: "thread", turnId: "long", itemId, delta: "真实摘要" } });
  }
  for (const itemId of ["visible", "first-overflow", "later-visible", "another-empty"]) {
    const message = empty(itemId, "long");
    assert.equal(projector.project(message), message);
  }
  finish(projector, "long");
  start(projector, "next");
  assert.deepEqual(projector.project(empty("fresh", "next")).params.item.summary,
    ["推理片段1已收到，摘要为空"]);
});

test("an overlong full snapshot remains entirely original without disabling other turns in its response", () => {
  const projector = view({ maximumItems: 2 });
  const large = { id: "large", status: "completed", itemsView: "full",
    items: ["one", "two", "three"].map(id => empty(id, "large").params.item) };
  const ordinary = { id: "ordinary", status: "completed", itemsView: "full", items: [empty("one", "ordinary").params.item] };
  const output = read(projector, [large, ordinary]);
  assert.equal(output.result.thread.turns[0], large);
  assert.deepEqual(output.result.thread.turns[1].items[0].summary, ["推理片段1已收到，摘要为空"]);
  assert.equal(projector.status().trackingAvailable, true);
});

test("more active turns bypass unknown turns but preserve existing real text and recover for fresh starts", () => {
  const projector = view({ maximumTurns: 1 });
  start(projector, "active");
  projector.project({ method: "item/reasoning/textDelta",
    params: { threadId: "thread", turnId: "active", itemId: "real", delta: "正文" } });
  start(projector, "skipped");
  const skipped = empty("unknown", "skipped");
  assert.equal(projector.project(skipped), skipped);
  const real = empty("real", "active");
  assert.equal(projector.project(real), real);
  finish(projector, "active");
  start(projector, "fresh");
  assert.deepEqual(projector.project(empty("new", "fresh")).params.item.summary,
    ["推理片段1已收到，摘要为空"]);
  assert.equal(projector.project(skipped), skipped);
  assert.equal(projector.status().trackingAvailable, true);
  assert.equal(projector.status().turnCount, 1);
});

test("item byte pressure releases only the affected turn while retaining active visible state", () => {
  const projector = view({ maximumRetainedBytes: 800 });
  start(projector, "real-turn");
  projector.project({ method: "item/reasoning/textDelta",
    params: { threadId: "thread", turnId: "real-turn", itemId: "real", delta: "正文" } });
  start(projector, "long-turn");
  projector.project(empty("small", "long-turn"));
  const large = empty("x".repeat(240), "long-turn");
  assert.equal(projector.project(large), large);
  assert.equal(projector.status().suspendedTurns, 1);
  assert.ok(projector.status().retainedBytes <= 800);
  const visible = empty("real", "real-turn");
  assert.equal(projector.project(visible), visible);
  assert.equal(projector.status().trackingAvailable, true);
});

test("failed and interrupted history releases retained turns without completing unknown items", () => {
  for (const status of ["failed", "interrupted"]) {
    const projector = view({ maximumTurns: 2 });
    for (let turnIndex = 0; turnIndex < 150; turnIndex += 1) {
      const turn = { id: `old-${turnIndex}`, status, itemsView: "full", items: [empty("unfinished", "unused").params.item] };
      const output = read(projector, [turn]);
      assert.equal(output.result.thread.turns[0], turn);
    }
    start(projector, "fresh");
    assert.deepEqual(projector.project(empty("new", "fresh")).params.item.summary,
      ["推理片段1已收到，摘要为空"]);
    assert.equal(projector.status().trackingAvailable, true);
    assert.ok(projector.status().turnCount <= 2);
  }
});

test("a terminal history turn with omitted items still releases known live state", () => {
  const projector = view({ maximumTurns: 1 });
  start(projector, "old");
  projector.project(empty("old-item", "old"));
  read(projector, [{ id: "old", status: "interrupted" }]);
  start(projector, "new");
  assert.deepEqual(projector.project(empty("new-item", "new")).params.item.summary,
    ["推理片段1已收到，摘要为空"]);
});

test("old item-list history cannot fill active slots or disable a live stream", () => {
  const projector = view({ maximumTurns: 2 });
  start(projector, "live");
  for (let pageIndex = 0; pageIndex < 150; pageIndex += 1) {
    projector.observeRequest({ id: pageIndex, method: "thread/items/list", params: { threadId: "thread" } });
    projector.project({ id: pageIndex, result: { data: [{ turnId: `old-${pageIndex}`, completedAtMs: 1000,
      item: empty("old-item", "unused").params.item }] } });
  }
  assert.deepEqual(projector.project(empty("live-item", "live")).params.item.summary,
    ["推理片段1已收到，摘要为空"]);
  assert.equal(projector.status().trackingAvailable, true);
});

test("RPC capacity skips only new requests and resumes tracking after pending responses", () => {
  const projector = view({ maximumRequests: 1 });
  projector.observeRequest({ id: "pending", method: "thread/read", params: { threadId: "thread" } });
  projector.observeRequest({ id: "skipped", method: "thread/read", params: { threadId: "thread" } });
  const skipped = { id: "skipped", result: { thread: { id: "thread", turns: [] } } };
  assert.equal(projector.project(skipped), skipped);
  projector.project({ id: "pending", error: { code: 1 } });
  const turn = { id: "history", status: "completed", itemsView: "full", items: [empty("new", "history").params.item] };
  const output = read(projector, [turn], "next");
  assert.deepEqual(output.result.thread.turns[0].items[0].summary, ["推理片段1已收到，摘要为空"]);
  assert.equal(projector.status().requestCount, 0);
  assert.equal(projector.status().trackingAvailable, true);
});

test("duplicate pending requests count every response without charging count or bytes twice", () => {
  const projector = view({ maximumRequests: 1, maximumRetainedBytes: 400 });
  const request = { id: "same", method: "thread/read", params: { threadId: "thread" } };
  projector.observeRequest(request);
  const before = projector.status().retainedBytes;
  for (let repeat = 0; repeat < 1000; repeat += 1) projector.observeRequest(request);
  assert.equal(projector.status().retainedBytes, before);
  assert.equal(projector.status().requestCount, 1);
  assert.equal(projector.status().capacityBypasses, 0);
  for (let responseIndex = 0; responseIndex <= 1000; responseIndex += 1) {
    const response = { id: "same", error: { code: 1 } };
    assert.equal(projector.project(response), response);
    assert.equal(projector.status().requestCount, responseIndex === 1000 ? 0 : 1);
  }
  assert.equal(projector.status().retainedBytes, projector.status().turnHistoryBytes);
});

test("bidirectional server requests do not consume a matching client history response", () => {
  const projector = view();
  projector.observeRequest({ id: "collision", method: "thread/read", params: { threadId: "thread" } });
  const request = { id: "collision", method: "item/commandExecution/requestApproval", params: {} };
  assert.equal(projector.project(request), request);
  assert.equal(projector.status().requestCount, 1);
  const turn = { id: "history", status: "completed", itemsView: "full", items: [empty("new", "history").params.item] };
  const output = projector.project({ id: "collision", result: { thread: { id: "thread", turns: [turn] } } });
  assert.deepEqual(output.result.thread.turns[0].items[0].summary, ["推理片段1已收到，摘要为空"]);
  assert.equal(projector.status().requestCount, 0);
});

test("capacity diagnostics reset at initialization without changing fatal invalid-ID behavior", () => {
  const projector = view({ maximumItems: 1 });
  start(projector, "long");
  projector.project(empty("one", "long"));
  projector.project(empty("two", "long"));
  projector.observeRequest({ method: "initialize", params: { clientInfo: { name: "Codex Desktop" } } });
  assert.equal(projector.status().capacityBypasses, 0);
  assert.equal(projector.status().lastCapacity, null);
  assert.equal(projector.status().suspendedTurns, 0);
  start(projector, "fresh");
  const invalid = empty("", "fresh");
  assert.equal(projector.project(invalid), invalid);
  assert.equal(projector.status().disabledReason, "invalid_item_id");
});

test("a denied turn cannot forget a genuine delta through replayed start after a slot becomes free", () => {
  const projector = view();
  for (let turnIndex = 0; turnIndex < 128; turnIndex += 1) start(projector, `active-${turnIndex}`);
  start(projector, "denied");
  assert.equal(projector.status().lastCapacity.reason, "active_turns_capacity");
  projector.project({ method: "item/reasoning/textDelta",
    params: { threadId: "thread", turnId: "denied", itemId: "real", delta: "真实正文" } });
  finish(projector, "active-0");
  start(projector, "denied");
  const real = empty("real", "denied");
  assert.equal(projector.project(real), real);
  start(projector, "genuinely-new");
  assert.deepEqual(projector.project(empty("new", "genuinely-new")).params.item.summary,
    ["推理片段1已收到，摘要为空"]);
});

test("byte-denied turn remains original after pending bytes drain and its start is replayed", () => {
  const projector = view({ maximumRetainedBytes: 350 });
  projector.observeRequest({ id: "pending", method: "thread/read", params: { threadId: "thread" } });
  start(projector, "byte-denied");
  assert.equal(projector.status().turnCount, 0);
  assert.equal(projector.status().lastCapacity.reason, "retained_bytes_capacity");
  projector.project({ method: "item/reasoning/textDelta",
    params: { threadId: "thread", turnId: "byte-denied", itemId: "real", delta: "真实正文" } });
  projector.project({ id: "pending", error: { code: 1 } });
  start(projector, "byte-denied");
  const real = empty("real", "byte-denied");
  assert.equal(projector.project(real), real);
  start(projector, "fresh");
  assert.deepEqual(projector.project(empty("new", "fresh")).params.item.summary,
    ["推理片段1已收到，摘要为空"]);
  assert.ok(projector.status().retainedBytes <= 450);
});

test("an evicted completed genuine turn cannot be re-admitted by replaying its start", () => {
  const projector = view({ maximumTurns: 1 });
  start(projector, "old");
  projector.project({ method: "item/reasoning/textDelta",
    params: { threadId: "thread", turnId: "old", itemId: "real", delta: "真实正文" } });
  finish(projector, "old");
  start(projector, "new");
  finish(projector, "new");
  start(projector, "old");
  const message = empty("real", "old");
  assert.equal(projector.project(message), message);
  assert.equal(projector.status().trackingAvailable, true);
});

test("overflow in an items page reverts all entries of that turn but retains unrelated projections", () => {
  const projector = view({ maximumItems: 1 });
  projector.observeRequest({ id: "page", method: "thread/items/list", params: { threadId: "thread" } });
  const first = { turnId: "long", completedAtMs: 1000, item: empty("one", "long").params.item };
  const second = { turnId: "long", completedAtMs: 1001, item: empty("two", "long").params.item };
  const healthy = { turnId: "healthy", completedAtMs: 1002, item: empty("fresh", "healthy").params.item };
  const output = projector.project({ id: "page", result: { data: [first, second, healthy] } });
  assert.equal(output.result.data[0], first);
  assert.equal(output.result.data[1], second);
  assert.deepEqual(output.result.data[2].item.summary, ["推理片段1已收到，摘要为空"]);
  assert.equal(projector.status().projectedItems, 1);
});

test("conflicting request ids cannot project a prior response in another thread", () => {
  const projector = view();
  start(projector, "active", "original-thread");
  projector.project({ method: "item/reasoning/textDelta",
    params: { threadId: "original-thread", turnId: "active", itemId: "real", delta: "真实正文" } });
  for (const threadId of ["original-thread", "different-thread"]) {
    projector.observeRequest({ id: "conflict", method: "thread/items/list", params: { threadId } });
  }
  for (let responseIndex = 0; responseIndex < 2; responseIndex += 1) {
    const response = { id: "conflict", result: { data: [{ turnId: "active", completedAtMs: 1000,
      item: empty("real", "active").params.item }] } };
    assert.equal(projector.project(response), response);
  }
  assert.equal(projector.status().requestCount, 0);
});

test("an ascending first items page establishes order before numbering previously discovered items", () => {
  const projector = view();
  start(projector, "active");
  projector.project(empty("second", "active"));
  projector.observeRequest({ id: "page", method: "thread/items/list", params: { threadId: "thread", sortDirection: "asc" } });
  const data = ["first", "second"].map(itemId => ({ turnId: "active", completedAtMs: 1000,
    item: empty(itemId, "active").params.item }));
  const output = projector.project({ id: "page", result: { data } });
  assert.deepEqual(output.result.data.map(entry => entry.item.summary[0]),
    ["推理片段1已收到，摘要为空", "推理片段2已收到，摘要为空"]);
});

test("a reverted partial turn projection does not increment the projection counter", () => {
  const projector = view({ maximumItems: 1 });
  const turn = { id: "partial", status: "completed", itemsView: "partial",
    items: [empty("one", "partial").params.item, empty("two", "partial").params.item] };
  assert.equal(read(projector, [turn]).result.thread.turns[0], turn);
  assert.equal(projector.status().projectedItems, 0);
});

test("confirmed new Desktop turns remain displayable beyond bounded unavailable-history saturation", () => {
  const projector = view();
  for (let turnIndex = 0; turnIndex < 25000; turnIndex += 1) {
    const turnId = `confirmed-${turnIndex}`;
    projector.observeRequest({ id: "new-turn", method: "turn/start", params: { threadId: "thread", input: [] } });
    const response = { id: "new-turn", result: { turn: { id: turnId, status: "inProgress", items: [] } } };
    assert.equal(projector.project(response), response);
    start(projector, turnId);
    assert.deepEqual(projector.project(empty("reasoning", turnId)).params.item.summary,
      ["推理片段1已收到，摘要为空"]);
    finish(projector, turnId);
  }
  const old = empty("reasoning", "confirmed-0");
  start(projector, "confirmed-0");
  assert.equal(projector.project(old), old);
  assert.equal(projector.status().projectedItems, 25000);
  assert.equal(projector.status().trackingAvailable, true);
  assert.ok(projector.status().retainedBytes <= 1024 * 1024);
  assert.equal(projector.status().requestCount, 0);
});

test("turn-start responses cannot erase reasoning received before a delayed response", () => {
  const projector = view({ maximumTurns: 1 });
  start(projector, "busy");
  projector.observeRequest({ id: "start", method: "turn/start", params: { threadId: "thread" } });
  start(projector, "denied");
  projector.project({ method: "item/reasoning/summaryTextDelta",
    params: { threadId: "thread", turnId: "denied", itemId: "visible", delta: "真实文字" } });
  finish(projector, "busy");
  const response = { id: "start", result: { turn: { id: "denied", status: "inProgress", items: [] } } };
  assert.equal(projector.project(response), response);
  const completion = empty("visible", "denied");
  assert.equal(projector.project(completion), completion);
  assert.equal(projector.status().requestCount, 0);
});

test("duplicate pending turn-start requests do not fabricate an authoritative new-turn response", () => {
  const projector = view({ maximumTurns: 1 });
  start(projector, "old");
  finish(projector, "old");
  start(projector, "fresh");
  for (let requestIndex = 0; requestIndex < 2; requestIndex += 1) {
    projector.observeRequest({ id: "duplicate-start", method: "turn/start", params: { threadId: "thread" } });
  }
  for (const turnId of ["old", "another"]) {
    const response = { id: "duplicate-start", result: { turn: { id: turnId, status: "inProgress", items: [] } } };
    assert.equal(projector.project(response), response);
  }
  const completion = empty("reasoning", "old");
  start(projector, "old");
  assert.equal(projector.project(completion), completion);
  assert.equal(projector.status().requestCount, 0);
});

test("history and whole-turn reasoning observations prevent late start-response re-admission", () => {
  for (const source of ["items", "whole-turn"]) {
    const projector = view({ maximumTurns: 1 });
    start(projector, "busy", "busy-thread");
    projector.observeRequest({ id: "start", method: "turn/start", params: { threadId: "thread" } });
    start(projector, "denied");
    const item = { ...empty("real", "denied").params.item, summary: ["真实摘要"] };
    if (source === "items") {
      projector.observeRequest({ id: "history", method: "thread/items/list", params: { threadId: "thread" } });
      projector.project({ id: "history", result: { data: [{ turnId: "denied", completedAtMs: 1, item }] } });
    } else {
      projector.project({ method: "turn/completed", params: { threadId: "thread",
        turn: { id: "denied", status: "completed", itemsView: "full", items: [item] } } });
    }
    finish(projector, "busy", "completed", "busy-thread");
    projector.project({ id: "start", result: { turn: { id: "denied", status: "inProgress", items: [] } } });
    const completion = empty("real", "denied");
    assert.equal(projector.project(completion), completion, source);
  }
});

test("mixed duplicate history and start requests retain all pending responses before id reuse", () => {
  const projector = view({ maximumTurns: 1 });
  start(projector, "old");
  projector.project({ method: "item/reasoning/textDelta",
    params: { threadId: "thread", turnId: "old", itemId: "real", delta: "真实正文" } });
  finish(projector, "old");
  start(projector, "other", "busy-thread");
  const history = { id: "mixed", method: "thread/read", params: { threadId: "thread" } };
  projector.observeRequest(history);
  projector.observeRequest(history);
  projector.observeRequest({ id: "mixed", method: "turn/start", params: { threadId: "thread" } });
  for (let responseIndex = 0; responseIndex < 2; responseIndex += 1) {
    const response = { id: "mixed", result: { thread: { id: "thread", turns: [] } } };
    assert.equal(projector.project(response), response);
  }
  assert.equal(projector.status().requestCount, 1);
  projector.observeRequest({ id: "mixed", method: "turn/start", params: { threadId: "thread" } });
  finish(projector, "other", "completed", "busy-thread");
  for (const turnId of ["old", "new"]) {
    const response = { id: "mixed", result: { turn: { id: turnId, status: "inProgress", items: [] } } };
    assert.equal(projector.project(response), response);
  }
  assert.equal(projector.status().requestCount, 0);
  const completion = empty("real", "old");
  start(projector, "old");
  assert.equal(projector.project(completion), completion);
});

test("terminal evidence precedes a delayed in-progress start snapshot without creating an active turn", () => {
  const projector = view({ maximumTurns: 1 });
  start(projector, "busy", "busy-thread");
  projector.observeRequest({ id: "start", method: "turn/start", params: { threadId: "thread" } });
  start(projector, "denied");
  projector.project({ method: "turn/completed", params: { threadId: "thread", turn: { id: "denied", status: "interrupted" } } });
  finish(projector, "busy", "completed", "busy-thread");
  projector.project({ id: "start", result: { turn: { id: "denied", status: "inProgress", items: [] } } });
  projector.observeRequest({ id: "next", method: "turn/start", params: { threadId: "thread" } });
  projector.project({ id: "next", result: { turn: { id: "fresh", status: "inProgress", items: [] } } });
  assert.deepEqual(projector.project(empty("new", "fresh")).params.item.summary, ["推理片段1已收到，摘要为空"]);
  assert.equal(projector.status().lastCapacity.reason, "active_turns_capacity");
});
