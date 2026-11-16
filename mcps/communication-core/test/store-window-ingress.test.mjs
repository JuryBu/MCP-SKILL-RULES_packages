import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MessageStore } from "../src/store.mjs";

async function fixture(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "communication-window-state-中文 space-"));
  const filePath = path.join(directory, "core.sqlite");
  let store = new MessageStore({ filePath });
  context.after(async () => {
    store.close();
    await fs.rm(directory, { recursive: true });
    await assert.rejects(fs.stat(directory), { code: "ENOENT" });
  });
  return { get store() { return store; }, reopen() { store.close(); store = new MessageStore({ filePath }); return store; } };
}

test("window registration intent and event cursor persist in their exact window across restart", async context => {
  const files = await fixture(context);
  const state = { phase: "registration_unknown", pending: { dedupe_key: "original-register", expected_generation: 2, request_started: true }, cursor: "original-cursor" };
  assert.equal(files.store.getChannelIngressState("window:a"), null);
  const saved = files.store.putChannelIngressState("window:a", state);
  state.pending.dedupe_key = "outside-mutation";
  saved.pending.dedupe_key = "result-mutation";
  assert.equal(files.reopen().getChannelIngressState("window:a").pending.dedupe_key, "original-register");
  assert.equal(files.store.getChannelIngressState("window:b"), null);
});

test("window ingress cursor update rolls back with the surrounding transaction", async context => {
  const { store } = await fixture(context);
  store.putChannelIngressState("window:a", { cursor: "before" });
  assert.throws(() => store.transaction(() => { store.putChannelIngressState("window:a", { cursor: "after" }); throw new Error("synthetic commit failure"); }));
  assert.equal(store.getChannelIngressState("window:a").cursor, "before");
});

test("window ingress state rejects foreign scope, unsafe values and oversized records without overwriting the original", async context => {
  const { store } = await fixture(context);
  store.putChannelIngressState("window:a", { cursor: "before" });
  for (const state of [{ window_key: "window:b" }, { value: "x".repeat(100000) }, { value: () => {} }, JSON.parse('{"__proto__":{"polluted":true}}')]) {
    assert.throws(() => store.putChannelIngressState("window:a", state), { code: "invalid_input" });
  }
  assert.equal(store.getChannelIngressState("window:a").cursor, "before");
  assert.equal({}.polluted, undefined);
});
