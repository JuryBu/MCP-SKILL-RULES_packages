import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createThreadRecoveryHandoff } from "../src/thread-recovery-handoff.mjs";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";

const policy = { attemptStateTtlMs: 1000 };
function fixture(now = () => 2000) {
  const maps = Object.fromEntries(["attempts", "emptyIdleTurns", "businessProgress", "waitTerminals"].map(name => [name, new Map()]));
  const active = new Map();
  const handoff = createThreadRecoveryHandoff({ maps, active, policy, now });
  return { maps, active, handoff };
}

test("handoff transfers all thread-local channels as a detached snapshot", () => {
  const source = fixture();
  const target = fixture();
  source.maps.emptyIdleTurns.set("thread-a", { count: 2, turnId: "two", terminalTurnId: null, updatedAt: 1900 });
  for (const channel of ["attempts", "businessProgress", "waitTerminals"]) source.maps[channel].set("thread-a\u0000turn-a\u0000turn", { failures: 2, updatedAt: 1900 });
  source.maps.emptyIdleTurns.set("thread-b", { count: 8, updatedAt: 1900 });
  const snapshot = source.handoff.prepare("thread-a");
  assert.equal(source.handoff.blocked("thread-a"), true);
  assert.equal(source.handoff.blocked("thread-b"), false);
  assert.equal(target.handoff.accept(snapshot).importedEntries, 4);
  snapshot.state.emptyIdleTurns[0][1].count = 99;
  assert.equal(target.maps.emptyIdleTurns.get("thread-a").count, 2);
  assert.equal(source.maps.emptyIdleTurns.get("thread-a").count, 2);
  assert.equal(target.maps.emptyIdleTurns.has("thread-b"), false);
});

test("busy source and wrong cancel token preserve the original state", () => {
  const source = fixture();
  source.active.set("request", { threadId: "thread-a" });
  assert.throws(() => source.handoff.prepare("thread-a"), { code: "RECOVERY_HANDOFF_THREAD_BUSY" });
  source.active.clear();
  const snapshot = source.handoff.prepare("thread-a");
  assert.throws(() => source.handoff.cancel("thread-a", "wrong"), { code: "RECOVERY_HANDOFF_TOKEN_MISMATCH" });
  assert.equal(source.handoff.blocked("thread-a"), true);
  source.handoff.cancel("thread-a", snapshot.token);
  assert.equal(source.handoff.blocked("thread-a"), false);
});

test("used target rejects import and malformed snapshot is atomic", () => {
  const source = fixture();
  source.maps.attempts.set("thread-a\u0000turn-a\u0000turn", { failures: 2, updatedAt: 1900 });
  const snapshot = source.handoff.prepare("thread-a");
  const target = fixture();
  target.handoff.noteRequest("thread-a");
  assert.throws(() => target.handoff.accept(snapshot), { code: "RECOVERY_HANDOFF_THREAD_ALREADY_USED" });
  const fresh = fixture();
  snapshot.state.waitTerminals = [["other-thread\u0000turn\u0000turn", { updatedAt: 1900 }]];
  assert.throws(() => fresh.handoff.accept(snapshot), { code: "RECOVERY_HANDOFF_INVALID_SNAPSHOT" });
  assert.equal(fresh.maps.attempts.size, 0);
});

test("expired, future and incompatible snapshots are refused", () => {
  for (const change of [snapshot => { snapshot.capturedAt = 0; }, snapshot => { snapshot.capturedAt = 3000; }, snapshot => { snapshot.policyKey = "different"; }]) {
    const source = fixture();
    const snapshot = source.handoff.prepare("thread-a");
    change(snapshot);
    assert.throws(() => fixture().handoff.accept(snapshot), { code: "RECOVERY_HANDOFF_INVALID_SNAPSHOT" });
  }
});

async function networkFixture(context) {
  let mode = "quota";
  let calls = 0;
  const upstream = http.createServer((request, response) => {
    request.resume();
    calls += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = mode === "quota"
      ? { type: "response.failed", response: { id: "fixture", status: "failed", error: { code: "usage_limit_reached", message: "synthetic fixture" } } }
      : { type: "response.output_text.delta", delta: "actual progress" };
    response.end(`data: ${JSON.stringify(event)}\n\n` + (mode === "quota" ? "" : `data: ${JSON.stringify({ type: "response.completed", response: { id: "fixture", status: "completed", output: [] } })}\n\n`));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxies = [];
  const make = async () => {
    const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}` });
    await proxy.start();
    proxies.push(proxy);
    return proxy;
  };
  context.after(async () => { for (const proxy of proxies) await proxy.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const request = (proxy, turn, thread = "thread-a") => new Promise((resolve, reject) => {
    const client = http.request({ host: "127.0.0.1", port: proxy.status().port, path: "/v1/responses", method: "POST", headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: thread, turn_id: turn }) } }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode, body }));
    });
    client.once("error", reject);
    client.end(JSON.stringify({ stream: true, input: [] }));
  });
  return { make, request, count: () => calls, setMode: value => { mode = value; } };
}

test("two empty turns survive the real HTTP generation switch and the third stays terminal", async context => {
  const fixture = await networkFixture(context);
  const old = await fixture.make();
  await fixture.request(old, "one");
  await fixture.request(old, "two");
  const snapshot = old.prepareThreadHandoff("thread-a");
  const next = await fixture.make();
  next.acceptThreadHandoff(snapshot);
  assert.match((await fixture.request(next, "three")).body, /proxy_repeated_empty_idle/u);
  const before = fixture.count();
  assert.match((await fixture.request(next, "three")).body, /proxy_repeated_empty_idle/u);
  assert.equal(fixture.count(), before);
  assert.equal((await fixture.request(old, "four")).status, 503);
  assert.equal((await fixture.request(old, "other-one", "thread-b")).status, 200);
});

test("failed acceptance restores the old source without losing its counter", async context => {
  const fixture = await networkFixture(context);
  const old = await fixture.make();
  await fixture.request(old, "one");
  await fixture.request(old, "two");
  const snapshot = old.prepareThreadHandoff("thread-a");
  const next = await fixture.make();
  assert.throws(() => next.acceptThreadHandoff({ ...snapshot, schemaVersion: 99 }));
  old.cancelThreadHandoff("thread-a", snapshot.token);
  assert.match((await fixture.request(old, "three")).body, /proxy_repeated_empty_idle/u);
});

test("real progress after the transfer resets empty-turn count", async context => {
  const fixture = await networkFixture(context);
  const old = await fixture.make();
  await fixture.request(old, "one");
  await fixture.request(old, "two");
  const next = await fixture.make();
  next.acceptThreadHandoff(old.prepareThreadHandoff("thread-a"));
  fixture.setMode("success");
  assert.match((await fixture.request(next, "good")).body, /actual progress/u);
  fixture.setMode("quota");
  assert.doesNotMatch((await fixture.request(next, "new-one")).body, /proxy_repeated_empty_idle/u);
  assert.doesNotMatch((await fixture.request(next, "new-two")).body, /proxy_repeated_empty_idle/u);
  assert.match((await fixture.request(next, "new-three")).body, /proxy_repeated_empty_idle/u);
});
