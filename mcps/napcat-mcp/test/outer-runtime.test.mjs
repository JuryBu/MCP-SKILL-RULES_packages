import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { createOuterRuntime } from "../src/outer-runtime.mjs";

const sha = source => crypto.createHash("sha256").update(source).digest("hex");
const source = (version, extra = "") => `export default {apiVersion:1,version:${JSON.stringify(version)},createEngine:host=>({
  inspectThread:async input=>{await host.wait();return {input,version:${JSON.stringify(version)}};},
  subscribeThread:async()=>({}),subscribeTask:async()=>({}),wakeThread:async()=>({}),
  observeDownstream:(client,message)=>host.observe(${JSON.stringify(version)},"downstream",message),
  observeInjectedRequest:(client,message)=>host.observe(${JSON.stringify(version)},"injected_request",message),
  observeInjectedResponse:(client,message)=>host.observe(${JSON.stringify(version)},"injected_response",message),
  projectUpstream:(client,message)=>{host.observe(${JSON.stringify(version)},"upstream",message);return message;},${extra}
})};`;

function fixture(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "outer-runtime-unit-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const observed = [];
  let waiting = Promise.resolve();
  const runtime = createOuterRuntime({ ...options, candidateRoot: root, instanceId: "isolated", createHost: () => ({
    wait: () => waiting, observe: (version, action, message) => observed.push({ version, action, message }),
  }) });
  context.after(() => runtime.close());
  async function prepare(version, extra) {
    const bytes = source(version, extra);
    const candidate = `${version}.mjs`;
    fs.writeFileSync(path.join(root, candidate), bytes);
    return runtime.prepare({ candidate, sha256: sha(bytes), instanceId: "isolated", revision: runtime.status().revision });
  }
  return { runtime, root, observed, prepare, hold() { let release; waiting = new Promise(resolve => { release = resolve; }); return release; } };
}

test("outer entry retains an asynchronous operation while new work uses the replacement and restore", async context => {
  const { runtime, prepare, hold } = fixture(context);
  runtime.activate(await prepare("v1"));
  const release = hold();
  const pending = runtime.invoke("inspectThread", "old");
  const v2 = await prepare("v2");
  assert.equal(runtime.status().version, "v1");
  runtime.activate(v2);
  release();
  assert.deepEqual(await pending, { input: "old", version: "v1" });
  assert.deepEqual(await runtime.invoke("inspectThread", "new"), { input: "new", version: "v2" });
  assert.equal(runtime.restore().version, "v1");
  assert.equal(runtime.activate(v2).alreadyActivated, true);
  assert.equal(runtime.status().version, "v1");
  assert.equal(runtime.status().activeOperationCount, 0);
});

test("outer entry pins responses, old turn tools and cancellation without redispatch", async context => {
  const { runtime, prepare, observed } = fixture(context);
  runtime.activate(await prepare("v1"));
  const client = {};
  runtime.downstream(client, { id: 7, method: "turn/start", params: { threadId: "thread" } });
  runtime.upstream(client, { method: "turn/started", params: { threadId: "thread", turn: { id: "old-turn" } } });
  runtime.injectedRequest(client, { id: -7, method: "thread/read", params: { threadId: "thread" } });
  runtime.activate(await prepare("v2"));
  runtime.upstream(client, { id: 7, result: { turn: { id: "old-turn" } } });
  runtime.upstream(client, { id: "tool-7", method: "item/tool/call", params: { threadId: "thread", turnId: "old-turn" } });
  runtime.downstream(client, { id: "tool-7", result: { success: true } });
  runtime.downstream(client, { id: 8, method: "turn/interrupt", params: { threadId: "thread", turnId: "old-turn" } });
  runtime.injectedResponse(client, { id: -7, result: { thread: { id: "thread" } } });
  assert.equal(observed.every(item => item.version === "v1"), true);
  assert.equal(observed.filter(item => item.action === "downstream" && item.message.id === "tool-7").length, 1);
  runtime.downstream(client, { id: 9, method: "turn/start", params: { threadId: "thread" } });
  assert.equal(observed.at(-1).version, "v2");
  assert.equal(runtime.status().pendingToolCount, 0);
  runtime.closeClient(client);
  assert.equal(runtime.status().trackedRequestCount, 0);
});

test("bad import, changed candidate, stale receipt and activation failure keep the old business version", async context => {
  const { runtime, prepare, root } = fixture(context);
  runtime.activate(await prepare("v1"));
  fs.writeFileSync(path.join(root, "bad.mjs"), 'throw new Error("BAD_IMPORT");');
  await assert.rejects(runtime.prepare(path.join(root, "bad.mjs")), /BAD_IMPORT/);
  const changed = await prepare("changed");
  fs.appendFileSync(path.join(root, "changed.mjs"), "\n");
  assert.throws(() => runtime.activate(changed), /SHA_MISMATCH/);
  const rejected = await prepare("rejected", 'beforeActivate:()=>{throw new Error("REJECTED");},');
  assert.throws(() => runtime.activate(rejected), /REJECTED/);
  assert.equal(runtime.status().version, "v1");
  const stale = await prepare("stale");
  runtime.activate(await prepare("newer"));
  assert.throws(() => runtime.activate(stale), /REVISION_MISMATCH/);
  assert.equal(runtime.status().version, "newer");
});

test("a timed-out written turn retains the old owner for late native events and tools", async context => {
  const { runtime, prepare, observed } = fixture(context, { maximumTurns: 1 });
  runtime.activate(await prepare("v1"));
  const client = {};
  runtime.injectedRequest(client, { id: -8, method: "turn/start", params: { threadId: "old-thread" } });
  runtime.forgetRequest(client, -8, { retainTurn: true });
  runtime.activate(await prepare("v2"));
  runtime.downstream(client, { id: 10, method: "turn/start", params: { threadId: "new-thread" } });
  runtime.upstream(client, { method: "turn/started", params: { threadId: "new-thread", turn: { id: "new-turn" } } });
  runtime.upstream(client, { method: "turn/started", params: { threadId: "old-thread", turn: { id: "old-turn" } } });
  runtime.orphanResponse(client, { id: -8, result: { turn: { id: "old-turn" } } });
  runtime.upstream(client, { id: "late-tool", method: "item/tool/call", params: { threadId: "old-thread", turnId: "old-turn" } });
  runtime.downstream(client, { id: "late-tool", result: { success: true } });
  assert.equal(observed.at(-1).version, "v1");
  assert.equal(observed.filter(item => item.action === "injected_request").length, 1);
});

test("asynchronous rejected activation is consumed and keeps the live version", async context => {
  const { runtime, prepare } = fixture(context);
  runtime.activate(await prepare("v1"));
  const rejected = await prepare("async-rejected", 'beforeActivate:async()=>{throw new Error("ASYNC_REJECTED");},');
  assert.throws(() => runtime.activate(rejected), /ASYNC_ACTIVATION_INVALID/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runtime.status().version, "v1");
});

test("a completed turn with a withheld start reply cannot claim the next business version", async context => {
  const { runtime, prepare, observed } = fixture(context);
  runtime.activate(await prepare("v1"));
  const client = {};
  runtime.downstream(client, { id: 11, method: "turn/start", params: { threadId: "thread" } });
  runtime.upstream(client, { method: "turn/started", params: { threadId: "thread", turn: { id: "first" } } });
  runtime.upstream(client, { method: "turn/completed", params: { threadId: "thread", turn: { id: "first" } } });
  runtime.activate(await prepare("v2"));
  runtime.downstream(client, { id: 12, method: "turn/start", params: { threadId: "thread" } });
  runtime.upstream(client, { method: "turn/started", params: { threadId: "thread", turn: { id: "second" } } });
  assert.equal(observed.at(-1).version, "v2");
  runtime.upstream(client, { id: 11, result: { turn: { id: "first" } } });
  assert.equal(observed.at(-1).version, "v1");
  runtime.upstream(client, { id: 12, result: { turn: { id: "second" } } }, { projectionMessage: null });
  assert.equal(runtime.status().trackedRequestCount, 0);
});
