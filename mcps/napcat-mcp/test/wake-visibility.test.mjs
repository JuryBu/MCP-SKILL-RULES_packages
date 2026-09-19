import assert from "node:assert/strict";
import test from "node:test";
import { createWakeVisibilityAdapter } from "../src/wake-visibility.mjs";

function notification(id, text, overrides = {}) {
  return {
    method: "item/started",
    params: {
      threadId: "thread-fixture",
      turnId: "turn-fixture",
      item: { type: "userMessage", id, clientId: null, content: [{ type: "text", text }] },
    },
    ...overrides,
  };
}

function setup(options) {
  const adapter = createWakeVisibilityAdapter(options);
  const view = adapter.createView();
  const register = (prompt, messageVisibility = "hidden", wakeId = prompt) => adapter.registerWake({
    threadId: "thread-fixture", wakeId, prompt, messageVisibility,
  });
  return { adapter, view, register };
}

test("an idle hidden opening stays visible and its intermediate notifications are hidden", () => {
  const { view, register } = setup();
  register("opening");
  register("middle");
  for (const method of ["item/started", "item/completed"]) {
    assert.equal(view.shouldSuppress(notification("first", "opening", { method })), false);
  }
  for (const method of ["item/started", "item/completed"]) {
    assert.equal(view.shouldSuppress(notification("next", "middle", { method })), true);
  }
});

test("hidden wakes after a genuine user opening are suppressed but visible wakes pass", () => {
  const { view, register } = setup();
  assert.equal(view.shouldSuppress(notification("human", "hello")), false);
  register("hidden");
  register("visible", "visible");
  assert.equal(view.shouldSuppress(notification("hidden", "hidden")), true);
  assert.equal(view.shouldSuppress(notification("visible", "visible")), false);
});

test("unregistered, explicit-client and altered messages pass through unchanged", () => {
  const { view, register } = setup();
  view.shouldSuppress(notification("first", "opening"));
  register("registered");
  const explicit = notification("explicit", "registered");
  explicit.params.item.clientId = "human-client";
  const messages = [notification("unknown", "unknown"), explicit, notification("changed", "registered\nextra")];
  for (const message of messages) {
    const before = structuredClone(message);
    assert.equal(view.shouldSuppress(message), false);
    assert.deepEqual(message, before);
  }
});

test("known item completions and repeats retain their original visibility", () => {
  const { adapter, view, register } = setup();
  view.shouldSuppress(notification("first", "opening"));
  const registration = register("hidden");
  assert.equal(view.shouldSuppress(notification("next", "hidden")), true);
  adapter.forgetWake(registration);
  assert.equal(view.shouldSuppress(notification("next", "hidden", { method: "item/completed" })), true);
  assert.equal(view.shouldSuppress(notification("first", "opening", { method: "item/completed" })), false);
  assert.equal(view.shouldSuppress(notification("next", "different", { method: "item/completed" })), false);
});

test("an item already shown is not retroactively hidden by later registration", () => {
  const { view, register } = setup();
  view.shouldSuppress(notification("first", "opening"));
  assert.equal(view.shouldSuppress(notification("next", "later")), false);
  register("later");
  assert.equal(view.shouldSuppress(notification("next", "later", { method: "item/completed" })), false);
});

test("RPC replies, tool events, terminal events and legacy events are untouched", () => {
  const { view, register } = setup();
  view.shouldSuppress(notification("first", "opening"));
  register("hidden");
  const tool = notification("tool", "hidden");
  tool.params.item.type = "mcpToolCall";
  const messages = [
    notification("rpc", "hidden", { id: 17 }), tool, null,
    ...["turn/completed", "turn/started", "error", "item/mcpToolCall/progress", "codex/event/user_message"]
      .map(method => notification(method, "hidden", { method })),
  ];
  for (const message of messages) {
    const before = structuredClone(message);
    assert.equal(view.shouldSuppress(message), false);
    assert.deepEqual(message, before);
  }
});

test("missing identity, mixed input and text annotations remain visible", () => {
  const { view, register } = setup();
  view.shouldSuppress(notification("first", "opening"));
  register("hidden");
  const missingTurn = notification("missing-turn", "hidden");
  delete missingTurn.params.turnId;
  const missingItem = notification("missing-item", "hidden");
  delete missingItem.params.item.id;
  const mixed = notification("mixed", "hidden");
  mixed.params.item.content.push({ type: "image", url: "fixture" });
  const annotated = notification("annotated", "hidden");
  annotated.params.item.content[0].text_elements = [{ fixture: true }];
  for (const message of [missingTurn, missingItem, mixed, annotated]) {
    assert.equal(view.shouldSuppress(message), false);
  }
});

test("thread and turn identity cannot hide the first item of another turn", () => {
  const { view, register } = setup();
  register("hidden");
  view.shouldSuppress(notification("first", "opening"));
  const otherThread = notification("other", "opening");
  otherThread.params.threadId = "other-thread";
  view.shouldSuppress(otherThread);
  const otherMessage = notification("other-next", "hidden");
  otherMessage.params.threadId = "other-thread";
  assert.equal(view.shouldSuppress(otherMessage), false);
  const otherTurn = notification("new-first", "hidden");
  otherTurn.params.turnId = "other-turn";
  assert.equal(view.shouldSuppress(otherTurn), false);
});

test("later Desktop connections reuse the same known server opening and item decisions", () => {
  const { adapter, view, register } = setup();
  register("hidden");
  view.shouldSuppress(notification("first", "opening"));
  assert.equal(view.shouldSuppress(notification("next", "hidden")), true);
  const fresh = adapter.createView();
  assert.equal(fresh.shouldSuppress(notification("next", "hidden", { method: "item/completed" })), true);
  assert.equal(fresh.shouldSuppress(notification("first", "opening")), false);
  fresh.close();
  assert.equal(view.shouldSuppress(notification("next", "hidden", { method: "item/completed" })), true);
});

test("a completely unknown turn fails open rather than hiding its apparent opening", () => {
  const { view, register } = setup();
  register("hidden");
  assert.equal(view.shouldSuppress(notification("only-observed", "hidden", { method: "item/completed" })), false);
});

test("ambiguous registrations never hide a new item", () => {
  const { view, register } = setup();
  view.shouldSuppress(notification("first", "opening"));
  register("same", "hidden", "wake-one");
  register("same", "visible", "wake-two");
  assert.equal(view.shouldSuppress(notification("ambiguous", "same")), false);
});

test("one wake binds to one server item rather than hiding later text copies", () => {
  const { view, register } = setup();
  view.shouldSuppress(notification("first", "opening"));
  register("hidden");
  assert.equal(view.shouldSuppress(notification("actual", "hidden")), true);
  assert.equal(view.shouldSuppress(notification("text-copy", "hidden")), false);
  assert.equal(view.shouldSuppress(notification("actual", "hidden", { method: "item/completed" })), true);
});

test("failed-before-send registration removal and stale removal are scoped", () => {
  const { adapter, view, register } = setup();
  view.shouldSuppress(notification("first", "opening"));
  const failed = register("failed");
  adapter.forgetWake(failed);
  assert.equal(view.shouldSuppress(notification("failed", "failed")), false);
  const previous = register("retry");
  register("retry");
  adapter.forgetWake(previous);
  assert.equal(view.shouldSuppress(notification("retry", "retry")), true);
});

test("state is bounded and connection cleanup releases its turn records", () => {
  const { adapter, view, register } = setup({ maxWakes: 2, maxTurns: 2, maxItemsPerTurn: 2 });
  for (let index = 0; index < 5; index += 1) register(`wake-${index}`);
  assert.equal(adapter.snapshot().registeredWakes, 2);
  for (let index = 0; index < 5; index += 1) {
    const message = notification(`first-${index}`, "opening");
    message.params.turnId = `turn-${index}`;
    assert.equal(view.shouldSuppress(message), false);
  }
  assert.equal(view.snapshot().trackedTurns, 2);
  view.close();
  assert.equal(view.snapshot().trackedTurns, 0);
  adapter.close();
  assert.equal(adapter.snapshot().trackedTurns, 0);
  assert.equal(adapter.snapshot().registeredWakes, 0);
});
