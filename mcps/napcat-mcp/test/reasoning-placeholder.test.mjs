import assert from "node:assert/strict";
import test from "node:test";
import { createReasoningPlaceholderView } from "../src/reasoning-placeholder.mjs";

function view(options = {}) {
  const projector = createReasoningPlaceholderView(options);
  projector.observeRequest({ id: 1, method: "initialize", params: { clientInfo: { name: "Codex Desktop" } } });
  return projector;
}

function reasoning(id = "reason-1", summary = [], content = []) {
  return { type: "reasoning", id, summary, content };
}

function notification(method, item, threadId = "thread-1", turnId = "turn-1") {
  return { method, params: { threadId, turnId, item, completedAtMs: 1000 } };
}

function startTurn(projector, threadId = "thread-1", turnId = "turn-1") {
  projector.project({ method: "turn/started", params: { threadId, turn: { id: turnId, items: [], status: "inProgress" } } });
}

function history(projector, method, result, params = { threadId: "thread-1" }) {
  projector.observeRequest({ id: 10, method, params });
  return projector.project({ id: 10, result });
}

test("only completed empty Desktop reasoning receives a cloned summary", () => {
  const projector = view();
  startTurn(projector);
  const item = Object.freeze({ ...reasoning(), summary: Object.freeze([]), content: Object.freeze([]) });
  const started = notification("item/started", item);
  assert.equal(projector.project(started), started);
  const completed = notification("item/completed", item);
  const projected = projector.project(completed);
  assert.deepEqual(projected.params.item.summary, ["推理片段1已收到，摘要为空"]);
  assert.equal(projected.params.item.id, item.id);
  assert.equal(projected.params.item.content, item.content);
  assert.deepEqual(item.summary, []);
  assert.equal(projected.params.completedAtMs, 1000);
});

test("real summaries, reasoning content and prior visible deltas remain original", () => {
  for (const item of [reasoning("real", ["检查协议"]), reasoning("content", [], ["可见正文"])]) {
    const projector = view();
    const message = notification("item/completed", item);
    assert.equal(projector.project(message), message);
  }
  for (const method of ["item/reasoning/summaryTextDelta", "item/reasoning/textDelta"]) {
    const projector = view();
    const delta = { method, params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "真实摘要" } };
    assert.equal(projector.project(delta), delta);
    const completed = notification("item/completed", reasoning());
    assert.equal(projector.project(completed), completed);
  }
});

test("a subsequent real authoritative item replaces placeholder without retaining synthetic text", () => {
  const projector = view();
  startTurn(projector);
  projector.project(notification("item/completed", reasoning()));
  const real = notification("item/completed", reasoning("reason-1", ["现在有真实文字"]));
  assert.equal(projector.project(real), real);
  assert.deepEqual(real.params.item.summary, ["现在有真实文字"]);
});

test("stable item ids do not increment numbering on repeated completion or history", () => {
  const projector = view();
  startTurn(projector);
  const first = notification("item/completed", reasoning());
  assert.deepEqual(projector.project(first).params.item.summary, ["推理片段1已收到，摘要为空"]);
  assert.deepEqual(projector.project(first).params.item.summary, ["推理片段1已收到，摘要为空"]);
  projector.project(notification("item/completed", reasoning("reason-2", ["真实第二段"])));
  const third = notification("item/completed", reasoning("reason-3"));
  assert.deepEqual(projector.project(third).params.item.summary, ["推理片段3已收到，摘要为空"]);
});

test("thread and turn scopes do not share item indexes or visible state", () => {
  const projector = view();
  for (const [threadId, turnId] of [["thread-1", "turn-1"], ["thread-2", "turn-1"], ["thread-1", "turn-2"]]) {
    startTurn(projector, threadId, turnId);
    assert.deepEqual(projector.project(notification("item/completed", reasoning(), threadId, turnId)).params.item.summary,
      ["推理片段1已收到，摘要为空"]);
  }
});

test("unknown clients, missing initialization and disabled feature are byte-pass-through objects", () => {
  const message = notification("item/completed", reasoning());
  for (const clientName of ["codex_cli", "codex_app_tools", "codex_desktop", "desktop", null]) {
    const projector = createReasoningPlaceholderView();
    projector.observeRequest({ id: 1, method: "initialize", params: { clientInfo: { name: clientName } } });
    assert.equal(projector.project(message), message);
  }
  assert.equal(createReasoningPlaceholderView().project(message), message);
  assert.equal(view({ enabled: false }).project(message), message);
});

test("partial history uses an unnumbered label while full completed history uses exact order", () => {
  const completed = { id: "turn-1", status: "completed", itemsView: "full", items: [reasoning(), reasoning("reason-2")] };
  const full = history(view(), "thread/read", { thread: { id: "thread-1", turns: [completed] } });
  assert.deepEqual(full.result.thread.turns[0].items[1].summary, ["推理片段2已收到，摘要为空"]);
  const partial = history(view(), "thread/turns/list", { data: [{ ...completed, itemsView: "summary" }], nextCursor: "opaque" });
  assert.deepEqual(partial.result.data[0].items[0].summary, ["推理片段已收到，摘要为空"]);
  assert.equal(partial.result.nextCursor, "opaque");
});

test("in-progress history never projects uncompleted items", () => {
  const projector = view();
  const result = { thread: { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress", itemsView: "full", items: [reasoning()] }] } };
  const output = history(projector, "thread/read", result);
  assert.equal(output.result, result);
  projector.project(notification("item/completed", reasoning()));
  assert.deepEqual(history(projector, "thread/read", result).result.thread.turns[0].items[0].summary,
    ["推理片段1已收到，摘要为空"]);
});

test("item-list paging preserves cursors and only changes completed entries", () => {
  for (const params of [{ threadId: "thread-1", cursor: "opaque" }, { threadId: "thread-1", sortDirection: "desc" }]) {
    const result = { data: [
      { turnId: "turn-1", item: reasoning(), completedAtMs: 1000 },
      { turnId: "turn-1", item: reasoning("running"), completedAtMs: null },
    ], nextCursor: "next", backwardsCursor: "previous" };
    const output = history(view(), "thread/items/list", result, params);
    assert.deepEqual(output.result.data[0].item.summary, ["推理片段已收到，摘要为空"]);
    assert.equal(output.result.data[1], result.data[1]);
    assert.equal(output.result.nextCursor, "next");
    assert.equal(output.result.backwardsCursor, "previous");
  }
});

test("known turn/thread notification schemas are projected without scanning unrelated fields", () => {
  const projector = view();
  const turn = { id: "turn-1", status: "completed", itemsView: "full", items: [reasoning()] };
  const message = { method: "turn/completed", params: { threadId: "thread-1", turn } };
  assert.deepEqual(projector.project(message).params.turn.items[0].summary, ["推理片段1已收到，摘要为空"]);
  const unrelated = { method: "other", params: { turn } };
  assert.equal(projector.project(unrelated), unrelated);
  projector.observeRequest({ id: 9, method: "other", params: {} });
  const response = { id: 9, result: { thread: { id: "thread-1", turns: [turn] } } };
  assert.equal(projector.project(response), response);
});

test("malformed, unknown and non-reasoning item shapes are untouched", () => {
  const projector = view();
  for (const item of [null, { type: "agentMessage", id: "a", text: "正文" }, reasoning("", []),
    { type: "reasoning", id: "x", summary: null, content: [] }, reasoning("x", [null])]) {
    const message = notification("item/completed", item);
    assert.equal(projector.project(message), message);
  }
  for (const message of [null, "string", [], {}, { method: "item/completed" }]) {
    assert.equal(projector.project(message), message);
  }
});

test("bounded state does not overwrite genuine content at item overflow", () => {
  const projector = view({ maximumTurns: 1, maximumItems: 1, maximumRequests: 1 });
  startTurn(projector);
  projector.project(notification("item/completed", reasoning()));
  const real = notification("item/completed", reasoning("overflow", ["真实内容"]));
  assert.equal(projector.project(real), real);
  startTurn(projector, "other", "other");
  assert.equal(projector.status().turnCount, 1);
  projector.observeRequest({ id: 3, method: "thread/read", params: { threadId: "t" } });
  projector.observeRequest({ id: 4, method: "thread/read", params: { threadId: "t" } });
  assert.equal(projector.status().requestCount, 0);
  assert.equal(projector.status().trackingAvailable, false);
  projector.close();
  assert.equal(projector.status().enabled, false);
  assert.equal(projector.status().turnCount, 0);
});

test("JSON-RPC errors and untracked responses retain original identity", () => {
  const projector = view();
  projector.observeRequest({ id: "rpc", method: "thread/read", params: { threadId: "thread-1" } });
  const error = { id: "rpc", error: { code: 1, message: "failure" } };
  assert.equal(projector.project(error), error);
  assert.equal(projector.status().requestCount, 0);
  const response = { id: "unknown", result: { data: [reasoning()] } };
  assert.equal(projector.project(response), response);
});

test("unknown content and deep nested arrays pass through without recursive parsing", () => {
  const projector = view();
  let nested = [];
  for (let depth = 0; depth < 12000; depth += 1) nested = [nested];
  for (const content of [null, {}, [{ unknown: "block" }], nested]) {
    const message = notification("item/completed", { ...reasoning(), content });
    assert.equal(projector.project(message), message);
  }
});

test("capacity exhaustion cannot forget prior genuine delta or project an evicted turn", () => {
  const projector = view();
  startTurn(projector);
  for (let index = 0; index < 512; index += 1) projector.project(notification("item/started", reasoning(`item-${index}`)));
  projector.project({ method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-513", delta: "真实摘要" } });
  const message = notification("item/completed", reasoning("item-513"));
  assert.equal(projector.project(message), message);
  assert.equal(projector.status().trackingAvailable, false);
  const turnLimited = view({ maximumTurns: 1 });
  startTurn(turnLimited);
  turnLimited.project({ method: "item/reasoning/summaryTextDelta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "reason-1", delta: "真实摘要" } });
  startTurn(turnLimited, "other", "other");
  const previousCompleted = notification("item/completed", reasoning());
  assert.equal(turnLimited.project(previousCompleted), previousCompleted);
});

test("full authoritative history fixes numbering after out-of-order or partial discovery", () => {
  for (const partial of [false, true]) {
    const projector = view();
    if (!partial) startTurn(projector);
    projector.project(notification("item/completed", reasoning("reason-3")));
    const turn = { id: "turn-1", itemsView: "full", status: "completed", items: [reasoning(), reasoning("reason-2"), reasoning("reason-3")] };
    const result = history(projector, "thread/read", { thread: { id: "thread-1", turns: [turn] } });
    assert.deepEqual(result.result.thread.turns[0].items.map(item => item.summary[0]),
      [1, 2, 3].map(index => `推理片段${index}已收到，摘要为空`));
  }
});

test("retained budget and long ids disable only display tracking while passing original data", () => {
  const projector = view({ maximumRetainedBytes: 200 });
  startTurn(projector);
  const message = notification("item/completed", reasoning());
  assert.equal(projector.project(message), message);
  assert.equal(projector.status().trackingAvailable, false);
  assert.ok(projector.status().retainedBytes <= 200);
  const longId = notification("item/completed", reasoning("x".repeat(257)));
  assert.equal(view().project(longId), longId);
  const requests = view({ maximumRequests: 1 });
  requests.observeRequest({ id: 1, method: "thread/read", params: { threadId: "thread-1", unrelated: "x".repeat(200000) } });
  assert.ok(requests.status().retainedBytes < 1000);
  requests.observeRequest({ id: 2, method: "thread/read", params: { threadId: "thread-1" } });
  assert.equal(requests.status().requestCount, 1);
  assert.equal(requests.status().trackingAvailable, false);
});
