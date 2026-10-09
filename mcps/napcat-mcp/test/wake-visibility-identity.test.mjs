import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createWakeVisibilityAdapter } from "../src/wake-visibility.mjs";

const prompt = "fixture-wake-body";
const threadId = "identity-thread";
const turnId = "identity-turn";
const itemKey = id => JSON.stringify([threadId, turnId, id]);
const user = (id, clientId = null, text = prompt) => ({ id, type: "userMessage", clientId, content: [{ type: "text", text }] });
const notice = item => ({ method: "item/completed", params: { threadId, turnId, item } });

function fixture(metadata = {}) {
  const bindings = [];
  const adapter = createWakeVisibilityAdapter({ onItemBound: registration => bindings.push(structuredClone(registration)) });
  adapter.registerWake({ threadId, wakeId: "identity-wake", promptSha256: crypto.createHash("sha256").update(prompt).digest("hex"),
    messageVisibility: "hidden", turnId, injectionMethod: "turn/steer", ...metadata });
  return { view: adapter.createView(), bindings };
}

function history(view, items, id = 7) {
  view.observeRequest({ id, method: "thread/read", params: { threadId } });
  return { id, result: { thread: { id: threadId, turns: [{ id: turnId, itemsView: "full", items }] } } };
}

test("hash-only legacy and unknown records preserve human copies and unproven wake items", () => {
  for (const metadata of [{ injectionMethod: "turn/start" }, { turnId: null, injectionMethod: null }, {}]) {
    const { view, bindings } = fixture(metadata);
    const items = [user("human-copy"), user("actual-wake")];
    const reply = history(view, items);
    assert.equal(view.project(reply), reply);
    assert.equal(view.shouldSuppress(notice(user("human-copy"))), false);
    assert.equal(bindings.length, 0);
    const different = notice(user("different-turn-copy"));
    different.params.turnId = "other-turn";
    assert.equal(view.shouldSuppress(different), false);
  }
});

test("the injected client identity distinguishes a human copy before the actual wake", () => {
  const { view, bindings } = fixture({ visibilityClientId: "owned-wake-client" });
  const items = [user("human-copy"), user("actual-wake", "owned-wake-client"), user("later-copy", "human-client")];
  const reply = history(view, items);
  const before = structuredClone(reply);
  assert.deepEqual(view.project(reply).result.thread.turns[0].items.map(item => item.id), ["human-copy", "later-copy"]);
  assert.deepEqual(reply, before);
  assert.equal(bindings[0].itemKey, itemKey("actual-wake"));
  assert.equal(bindings[0].turnId, turnId);
});

test("item history pagination hides only the exact known identity and preserves cursors", () => {
  const { view } = fixture({ itemKey: itemKey("actual-wake") });
  view.observeRequest({ id: 8, method: "thread/items/list", params: { threadId, turnId } });
  const page = { id: 8, result: { data: [{ turnId, item: user("human-copy") }, { turnId, item: user("actual-wake") },
    { turnId: "other-turn", item: user("actual-wake") }], nextCursor: "forward", backwardsCursor: "backward" } };
  const before = structuredClone(page);
  const result = view.project(page).result;
  assert.deepEqual(result.data.map(entry => [entry.turnId, entry.item.id]), [[turnId, "human-copy"], ["other-turn", "actual-wake"]]);
  assert.equal(result.nextCursor, "forward");
  assert.equal(result.backwardsCursor, "backward");
  assert.deepEqual(page, before);
});

test("complete history corrects a provisional opening decision only for a trusted item", () => {
  const { view } = fixture({ itemKey: itemKey("actual-wake"), injectionMethod: "turn/start" });
  assert.equal(view.shouldSuppress(notice(user("actual-wake"))), false);
  const reply = history(view, [user("human-opening", null, "hello"), user("actual-wake")]);
  assert.deepEqual(view.project(reply).result.thread.turns[0].items.map(item => item.id), ["human-opening"]);
});

test("server requests with the same numeric or string id leave pending history replies intact", () => {
  for (const id of [7, "7"]) {
    const { view } = fixture({ itemKey: itemKey("actual-wake") });
    const reply = history(view, [user("human-opening", null, "hello"), user("actual-wake")], id);
    const reverseRequest = { id, method: "item/tool/requestUserInput", params: { threadId, turnId, itemId: "tool", questions: [] } };
    assert.equal(view.project(reverseRequest), reverseRequest);
    assert.deepEqual(view.project(reply).result.thread.turns[0].items.map(item => item.id), ["human-opening"]);
  }
});
