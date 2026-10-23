import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";

const sse = event => `data: ${JSON.stringify(event)}\n\n`;
const completed = sse({ type: "response.output_text.delta", delta: "DONE" }) + sse({ type: "response.completed", response: { id: "resp_ok", status: "completed" } });

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function send(port, { turnId = "turn-a", abortAfterFirstChunk = false, timeoutMs = 4000 } = {}) {
  const payload = Buffer.from(JSON.stringify({ model: "gpt-test", stream: true, input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] }));
  return new Promise(resolve => {
    const chunks = [];
    let done = false;
    const finish = result => { if (!done) { done = true; clearTimeout(timer); resolve({ body: Buffer.concat(chunks).toString("utf8"), ...result }); } };
    const req = http.request({ host: "127.0.0.1", port, path: "/backend-api/codex/responses", method: "POST", headers: {
      "content-type": "application/json", "content-length": String(payload.length), authorization: "Bearer test",
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: "thread-wsf", turn_id: turnId }),
    } }, res => {
      res.on("data", chunk => {
        chunks.push(chunk);
        if (abortAfterFirstChunk && /output_text\.delta/u.test(Buffer.concat(chunks).toString("utf8"))) { req.destroy(); finish({ aborted: true }); }
      });
      res.on("end", () => finish({ ended: true }));
      res.on("error", () => finish({ error: true }));
    });
    req.on("error", () => finish({ error: true }));
    const timer = setTimeout(() => { req.destroy(); finish({ timedOut: true }); }, timeoutMs);
    req.end(payload);
  });
}

async function harness(t, handler, extra = {}) {
  const state = { attempts: 0 };
  const upstream = http.createServer((req, res) => { state.attempts += 1; handler(req, res, state.attempts); });
  const upstreamPort = await listen(upstream);
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    managedRecovery: true, managedRetryBaseMs: 20, firstProgressTimeoutMs: 300, heartbeatIntervalMs: 100, ...extra });
  await proxy.start();
  t.after(async () => { await proxy.stop(); upstream.closeAllConnections?.(); upstream.close(); });
  return { state, port: proxy.status().port };
}

test("connection reset after the request body was sent reconnects automatically", async t => {
  const { state, port } = await harness(t, (req, res, n) => {
    req.resume();
    req.on("end", () => { if (n === 1) req.socket.destroy(); else { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(completed); } });
  });
  const result = await send(port);
  assert.equal(state.attempts, 2, `attempts=${state.attempts} body=${result.body.slice(-300)}`);
  assert.match(result.body, /DONE/u);
});

test("first-progress timeout with no output reconnects automatically", async t => {
  const { state, port } = await harness(t, (req, res, n) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (n === 1) res.write(sse({ type: "response.created", response: { id: "resp_slow", status: "in_progress" } }));
      else res.end(completed);
    });
  });
  const result = await send(port);
  assert.ok(state.attempts >= 2, `attempts=${state.attempts} body=${result.body.slice(-300)}`);
  assert.match(result.body, /DONE/u);
});

test("a new request in the same turn after the client cancelled (mid-turn steer) is forwarded", async t => {
  const { state, port } = await harness(t, (req, res, n) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (n === 1) res.write(sse({ type: "response.output_text.delta", delta: "partial" }));
      else res.end(completed);
    });
  });
  const first = await send(port, { abortAfterFirstChunk: true });
  assert.equal(first.aborted, true);
  await new Promise(resolve => setTimeout(resolve, 150));
  const second = await send(port);
  assert.equal(state.attempts, 2, `attempts=${state.attempts} body=${second.body.slice(-300)}`);
  assert.match(second.body, /DONE/u);
});

test("a disconnect after visible output hands the retry back to the native client instead of hanging", async t => {
  const { state, port } = await harness(t, (req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse({ type: "response.output_text.delta", delta: "visible" }));
      setTimeout(() => res.socket.destroy(), 30);
    });
  }, { fastRetryDelayMs: 50, rapidRetryMinimumMs: 50 });
  const result = await send(port, { timeoutMs: 3000 });
  assert.equal(result.timedOut, undefined, `stream hung: ${result.body.slice(-300)}`);
  assert.equal(state.attempts, 1);
  assert.match(result.body, /visible/u);
  assert.doesNotMatch(result.body, /自动重试已暂停|停止自动重发/u);
});

test("HTTP 503 before output reconnects automatically", async t => {
  const { state, port } = await harness(t, (req, res, n) => {
    req.resume();
    req.on("end", () => {
      if (n === 1) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "service_unavailable", message: "busy" } })); return; }
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end(completed);
    });
  });
  const result = await send(port);
  assert.equal(state.attempts, 2, `attempts=${state.attempts} body=${result.body.slice(-300)}`);
  assert.match(result.body, /DONE/u);
});

test("usage limit stops instead of retrying", async t => {
  const { state, port } = await harness(t, (req, res) => {
    req.resume();
    req.on("end", () => { res.writeHead(429, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "usage_limit_reached", message: "You've hit your usage limit" } })); });
  });
  await send(port, { timeoutMs: 1500 });
  assert.equal(state.attempts, 1);
});

test("authentication failure still stops instead of retrying", async t => {
  const { state, port } = await harness(t, (req, res) => {
    req.resume();
    req.on("end", () => { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code: "invalid_token", message: "token expired" } })); });
  });
  await send(port, { timeoutMs: 1500 });
  assert.equal(state.attempts, 1);
});
