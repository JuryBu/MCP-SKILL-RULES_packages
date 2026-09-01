import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import zlib from "node:zlib";
import {
  classifyCodexModelRequest,
  createCodexModelStreamProxy,
  isMeaningfulResponsesSseFrame,
} from "../src/codex-model-stream-proxy.mjs";

function metadataHeader(requestKind = "turn", threadId = "thread-test") {
  return JSON.stringify({ request_kind: requestKind, thread_id: threadId, turn_id: "turn-test" });
}

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function request(port, body, options = {}) {
  const json = Buffer.from(JSON.stringify(body));
  const payload = options.contentEncoding === "gzip"
    ? zlib.gzipSync(json)
    : options.contentEncoding === "zstd"
      ? zlib.zstdCompressSync(json)
      : json;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/backend-api/codex/responses",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(payload.length),
        ...(options.contentEncoding ? { "content-encoding": options.contentEncoding } : {}),
        "x-codex-turn-metadata": metadataHeader(options.requestKind ?? "turn", options.threadId),
        authorization: "Bearer secret-test-token",
      },
    }, (res) => {
      const chunks = [];
      let settled = false;
      const finish = (aborted = false) => {
        if (settled) return;
        settled = true;
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers, aborted });
      };
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => finish(false));
      res.on("aborted", () => finish(true));
      res.on("error", reject);
    });
    req.once("error", reject);
    req.end(payload);
  });
}

test("request classification uses x-codex-turn-metadata and guards resumable turn kinds", () => {
  assert.deepEqual(classifyCodexModelRequest({ headers: { "x-codex-turn-metadata": metadataHeader("turn") } }).requestKind, "turn");
  assert.equal(classifyCodexModelRequest({ headers: { "x-codex-turn-metadata": metadataHeader("turn") } }).guarded, true);
  assert.equal(classifyCodexModelRequest({ headers: { "x-codex-turn-metadata": metadataHeader("compaction") } }).guarded, true);
  assert.equal(classifyCodexModelRequest({ headers: {} }).guarded, false);
});

test("late output from a timed out attempt is discarded before the client retry exposes output", async (t) => {
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (attempts === 1) {
      res.write(sse({ type: "response.in_progress" }));
      setTimeout(() => {
        res.write(sse({ type: "response.output_text.delta", delta: "OLD" }));
        res.end(sse({ type: "response.completed" }));
      }, 120);
      return;
    }
    res.end(sse({ type: "response.output_text.delta", delta: "NEW" }) + sse({ type: "response.completed" }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createCodexModelStreamProxy({
    port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    firstProgressTimeoutMs: 40,
    maxConsecutiveAttempts: 2,
  });
  await proxy.start();
  t.after(async () => { await proxy.stop(); upstream.closeAllConnections?.(); upstream.close(); });

  const first = await request(proxy.status().port, { stream: true, tools: [{ type: "function", name: "safe" }] }, { threadId: "late-output-thread" });
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(attempts, 1);
  assert.doesNotMatch(first.body, /OLD|NEW/u);
  const result = await request(proxy.status().port, { stream: true, tools: [{ type: "function", name: "safe" }] }, { threadId: "late-output-thread" });
  assert.equal(attempts, 2);
  assert.match(result.body, /NEW/u);
  assert.doesNotMatch(result.body, /OLD/u);
});

test("a stream that already exposed meaningful output is never replayed after disconnect", async (t) => {
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ type: "response.output_text.delta", delta: "visible" }));
    setTimeout(() => res.destroy(new Error("simulated disconnect")), 10);
  });
  const upstreamPort = await listen(upstream);
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, firstProgressTimeoutMs: 40 });
  await proxy.start();
  t.after(async () => { await proxy.stop(); upstream.closeAllConnections?.(); upstream.close(); });

  const result = await request(proxy.status().port, { stream: true, tools: [{ type: "function", name: "safe" }] });
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(result.aborted, true);
  assert.equal(attempts, 1);
  assert.match(result.body, /visible/u);
});

test("SSE progress ignores status-only frames and accepts text, reasoning, tool arguments, and completion", () => {
  assert.equal(isMeaningfulResponsesSseFrame(sse({ type: "response.in_progress" }).trim()), false);
  assert.equal(isMeaningfulResponsesSseFrame(sse({ type: "response.output_text.delta", item_id: "metadata-only" }).trim()), false);
  assert.equal(isMeaningfulResponsesSseFrame(sse({ type: "response.output_text.delta", delta: "a" }).trim()), true);
  assert.equal(isMeaningfulResponsesSseFrame(sse({ type: "response.reasoning_summary_text.delta", delta: "r" }).trim()), true);
  assert.equal(isMeaningfulResponsesSseFrame(sse({ type: "response.function_call_arguments.delta", delta: "{}" }).trim()), true);
  assert.equal(isMeaningfulResponsesSseFrame(sse({ type: "response.completed" }).trim()), true);
});

test("ordinary turn records a retry signal and exposes only the client retry output", async (t) => {
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts += 1;
    assert.equal(req.headers.authorization, "Bearer secret-test-token");
    assert.equal(req.headers["accept-encoding"], "identity");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ type: "response.in_progress", attempt: attempts }));
    if (attempts === 2) {
      res.end(sse({ type: "response.output_text.delta", delta: "recovered" }) + sse({ type: "response.completed" }));
    }
  });
  const upstreamPort = await listen(upstream);
  const events = [];
  const proxy = createCodexModelStreamProxy({
    port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    firstProgressTimeoutMs: 80,
    maxConsecutiveAttempts: 2,
    onEvent: (event) => events.push(event),
  });
  await proxy.start();
  t.after(async () => { await proxy.stop(); upstream.closeAllConnections?.(); upstream.close(); });

  const first = await request(proxy.status().port, { stream: true, tools: [{ type: "function", name: "safe" }] }, { threadId: "ordinary-retry-thread" });
  assert.equal(first.statusCode, 200);
  assert.equal(attempts, 1);
  assert.doesNotMatch(first.body, /recovered|attempt/u);
  assert.equal(events.filter((event) => event.type === "native_retry_signal").length, 1);
  const result = await request(proxy.status().port, { stream: true, tools: [{ type: "function", name: "safe" }] }, { threadId: "ordinary-retry-thread" });
  assert.equal(result.statusCode, 200);
  assert.equal(attempts, 2);
  assert.match(result.body, /recovered/u);
  assert.doesNotMatch(result.body, /"attempt":1/u);
  assert.equal(events.filter((event) => event.type === "retry_exhausted_completed_idle").length, 0);
});

test("concurrent healthy request is not delayed or cancelled by another stalled request", async (t) => {
  const attempts = new Map();
  const upstream = http.createServer((req, res) => {
    const key = req.headers["x-codex-turn-metadata"].includes("slow-thread") ? "slow" : "fast";
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (key === "fast" || attempts.get(key) === 2) {
      res.end(sse({ type: "response.output_text.delta", delta: key }) + sse({ type: "response.completed" }));
    } else {
      res.write(sse({ type: "response.in_progress" }));
    }
  });
  const upstreamPort = await listen(upstream);
  const proxy = createCodexModelStreamProxy({
    port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    firstProgressTimeoutMs: 100,
    maxConsecutiveAttempts: 2,
  });
  await proxy.start();
  t.after(async () => { await proxy.stop(); upstream.closeAllConnections?.(); upstream.close(); });

  const slow = request(proxy.status().port, { stream: true, tools: [{ type: "function", name: "safe" }] }, { threadId: "slow-thread" });
  const started = Date.now();
  const fast = await request(proxy.status().port, { stream: true, tools: [{ type: "function", name: "safe" }] }, { threadId: "fast-thread" });
  assert.equal(fast.statusCode, 200);
  assert.ok(Date.now() - started < 80, "fast request should complete before the slow watchdog fires");
  assert.match(fast.body, /fast/u);
  const slowFirst = await slow;
  assert.doesNotMatch(slowFirst.body, /slow/u);
  const slowResult = await request(proxy.status().port, { stream: true, tools: [{ type: "function", name: "safe" }] }, { threadId: "slow-thread" });
  assert.match(slowResult.body, /slow/u);
});

test("compaction uses bounded internal retry while ordinary hosted turns use the retry guard", async (t) => {
  let attempts = 0;
  let turnAttempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const metadata = JSON.parse(req.headers["x-codex-turn-metadata"]);
    if (metadata.request_kind === "compaction") {
      res.end(sse({ type: "response.in_progress" }));
      return;
    }
    turnAttempts += 1;
    if (turnAttempts === 1) {
      res.write(sse({ type: "response.in_progress" }));
      return;
    }
    res.end(sse({ type: "response.output_text.delta", delta: "recovered" }) + sse({ type: "response.completed" }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createCodexModelStreamProxy({
    port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    firstProgressTimeoutMs: 40,
    maxConsecutiveAttempts: 2,
  });
  await proxy.start();
  t.after(async () => { await proxy.stop(); upstream.closeAllConnections?.(); upstream.close(); });

  const compact = await request(proxy.status().port, { stream: true, tools: [] }, { requestKind: "compaction" });
  assert.equal(compact.statusCode, 200);
  assert.equal(attempts, 2);
  assert.equal(proxy.status().counters.compactionInternalRetries, 1);
  const firstHosted = await request(proxy.status().port, { tools: [{ type: "web_search" }] }, { contentEncoding: "zstd", threadId: "hosted-thread" });
  assert.doesNotMatch(firstHosted.body, /recovered/u);
  const hosted = await request(proxy.status().port, { tools: [{ type: "web_search" }] }, { contentEncoding: "zstd", threadId: "hosted-thread" });
  assert.equal(hosted.statusCode, 200);
  assert.match(hosted.body, /recovered/u);
  assert.equal(attempts, 4);
  assert.equal(turnAttempts, 2);
});

test("two stalled client attempts end with a synthetic no-side-effect completion", async (t) => {
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ type: "response.in_progress" }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createCodexModelStreamProxy({
    port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    firstProgressTimeoutMs: 50,
    maxConsecutiveAttempts: 2,
  });
  await proxy.start();
  t.after(async () => { await proxy.stop(); upstream.closeAllConnections?.(); upstream.close(); });
  const first = await request(proxy.status().port, { stream: true, tools: [{ type: "function", name: "safe" }] }, { threadId: "stalled-thread" });
  assert.equal(first.statusCode, 200);
  assert.doesNotMatch(first.body, /网络重试/u);
  const started = Date.now();
  const result = await request(proxy.status().port, { stream: true, tools: [{ type: "function", name: "safe" }] }, { threadId: "stalled-thread" });
  assert.equal(result.statusCode, 200);
  assert.equal(attempts, 2);
  assert.ok(Date.now() - started < 250);
  assert.match(result.body, /网络重试|response.completed/u);
});
