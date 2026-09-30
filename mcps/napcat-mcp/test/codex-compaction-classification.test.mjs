import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";

async function fixture(context) {
  const events = [];
  const timers = new Set();
  let calls = 0;
  const upstream = http.createServer((request, response) => {
    calls += 1;
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!response.destroyed) response.end(JSON.stringify({ output: [{ type: "compaction", encrypted_content: "opaque-classified" }] }));
    }, 7500);
    timers.add(timer);
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    compactionAttemptTimeoutMs: 10000, onEvent: event => events.push(event) });
  await proxy.start();
  context.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    await proxy.stop();
    upstream.closeAllConnections?.();
    await new Promise(resolve => upstream.close(resolve));
  });
  const send = sendBody => new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: "fixture-model", input: [] });
    const start = Date.now();
    const request = http.request({ host: "127.0.0.1", port: proxy.status().port,
      path: "/backend-api/codex/responses/compact", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text, elapsedMs: Date.now() - start }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.flushHeaders();
    if (sendBody) {
      const timer = setTimeout(() => { timers.delete(timer); request.end(body); }, 4000);
      timers.add(timer);
    }
  });
  return { send, events, calls: () => calls };
}

test("classified compaction body reception is bounded before upstream starts", { timeout: 16000 }, async context => {
  const setup = await fixture(context);
  const result = await setup.send(false);
  assert.equal(result.status, 504);
  assert.match(result.text, /proxy_compaction_timeout/u);
  assert.equal(setup.calls(), 0);
  assert.ok(result.elapsedMs >= 9900 && result.elapsedMs < 14000);
  assert.equal(setup.events.some(event => event.type === "compaction_preparation_timeout"), true);
});

test("reception time is deducted from the classified compaction upstream budget", { timeout: 16000 }, async context => {
  const setup = await fixture(context);
  const result = await setup.send(true);
  assert.equal(setup.calls(), 1);
  assert.ok(result.status >= 400);
  assert.doesNotMatch(result.text, /opaque-classified|assistant|response\.completed/u);
  assert.ok(result.elapsedMs >= 9900 && result.elapsedMs < 11200);
  const start = setup.events.find(event => event.type === "compaction_attempt_started");
  assert.ok(start.timeoutMs > 4500 && start.timeoutMs < 6500);
  assert.equal(start.classifiedTimeoutMs, 10000);
});
