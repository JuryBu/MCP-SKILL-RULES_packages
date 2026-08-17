import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import {
  classifyCodexModelRequest,
  createCodexModelStreamProxy,
  isMeaningfulResponsesSseFrame,
} from "../src/codex-model-stream-proxy.mjs";

function metadataHeader(options = {}) {
  return JSON.stringify({
    request_kind: options.requestKind ?? "turn",
    thread_id: options.threadId ?? "thread-test",
    turn_id: options.turnId ?? "turn-test",
  });
}

function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function completedText(text, responseId = "resp_upstream", messageId = "msg_upstream") {
  const item = {
    type: "message",
    id: messageId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
  return [
    { type: "response.created", response: { id: responseId, status: "in_progress" } },
    { type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: responseId, status: "completed", output: [item] } },
  ].map(sse).join("");
}

function completedTool(callId = "call-one") {
  const item = { type: "custom_tool_call", id: "tool-item", call_id: callId, name: "apply_patch", input: "*** Begin Patch" };
  return [
    { type: "response.created", response: { id: "resp_tool", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", input: "" } },
    { type: "response.custom_tool_call_input.delta", output_index: 0, item_id: item.id, delta: item.input },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_tool", status: "completed", output: [item] } },
  ].map(sse).join("");
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function request(port, options = {}) {
  const payload = Buffer.from(JSON.stringify(options.body ?? { stream: true }));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/backend-api/codex/responses",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(payload.length),
        "x-codex-turn-metadata": metadataHeader(options),
        authorization: "Bearer secret-test-token",
      },
    }, (res) => {
      const chunks = [];
      let settled = false;
      const finish = (aborted) => {
        if (settled) return;
        settled = true;
        resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers, aborted });
      };
      res.on("data", (chunk) => chunks.push(chunk));
      res.once("end", () => finish(false));
      res.once("aborted", () => finish(true));
      res.once("error", reject);
    });
    req.once("error", reject);
    req.end(payload);
  });
}

async function createFixture(t, upstreamHandler, options = {}) {
  const upstream = http.createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);
  const events = [];
  const proxy = createCodexModelStreamProxy({
    port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    firstProgressTimeoutMs: options.firstProgressTimeoutMs ?? 80,
    progressIdleTimeoutMs: options.progressIdleTimeoutMs ?? 80,
    compactionAttemptTimeoutMs: options.compactionAttemptTimeoutMs ?? 10_000,
    maxConsecutiveAttempts: options.maxConsecutiveAttempts ?? 6,
    onEvent: (event) => events.push(event),
  });
  await proxy.start();
  t.after(async () => {
    await proxy.stop();
    upstream.closeAllConnections?.();
    upstream.close();
  });
  return { proxy, events };
}

test("classification guards turns and compaction only", () => {
  assert.equal(classifyCodexModelRequest({ headers: { "x-codex-turn-metadata": metadataHeader() } }).guarded, true);
  assert.equal(classifyCodexModelRequest({ headers: { "x-codex-turn-metadata": metadataHeader({ requestKind: "compaction" }) } }).guarded, true);
  assert.equal(classifyCodexModelRequest({ headers: { "x-codex-turn-metadata": metadataHeader({ requestKind: "other" }) } }).guarded, false);
  assert.equal(classifyCodexModelRequest({ headers: {} }).guarded, false);
});

test("meaningful progress requires content, tool input, or completion", () => {
  assert.equal(isMeaningfulResponsesSseFrame(sse({ type: "response.in_progress" }).trim()), false);
  assert.equal(isMeaningfulResponsesSseFrame(sse({ type: "response.output_text.delta", delta: "a" }).trim()), true);
  assert.equal(isMeaningfulResponsesSseFrame(sse({ type: "response.reasoning_summary_text.delta", delta: "r" }).trim()), true);
  assert.equal(isMeaningfulResponsesSseFrame(sse({ type: "response.custom_tool_call_input.delta", input: "{}" }).trim()), true);
  assert.equal(isMeaningfulResponsesSseFrame(sse({ type: "response.completed" }).trim()), true);
});

test("five clean EOF retry signals are followed by a sixth completed idle notice", async (t) => {
  let upstreamAttempts = 0;
  const { proxy, events } = await createFixture(t, (_req, res) => {
    upstreamAttempts += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse({ type: "response.in_progress" }));
  });
  const results = [];
  for (let attempt = 0; attempt < 6; attempt += 1) results.push(await request(proxy.status().port));
  assert.equal(upstreamAttempts, 6);
  for (const result of results.slice(0, 5)) {
    assert.equal(result.statusCode, 200);
    assert.equal(result.aborted, false);
    assert.doesNotMatch(result.body, /response\.completed/u);
  }
  assert.match(results[5].body, /网络重试六次仍失败/u);
  assert.match(results[5].body, /response\.completed/u);
  assert.equal(events.filter((event) => event.type === "native_retry_signal").length, 5);
});

test("model capacity retries six times then completes idle", async (t) => {
  let upstreamAttempts = 0;
  const { proxy } = await createFixture(t, (_req, res) => {
    upstreamAttempts += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse({
      type: "response.failed",
      response: { error: { code: "server_overloaded", message: "Selected model is at capacity. Please try a different model." } },
    }));
  });
  let result = null;
  for (let attempt = 0; attempt < 6; attempt += 1) result = await request(proxy.status().port);
  assert.equal(upstreamAttempts, 6);
  assert.match(result.body, /当前模型暂时满载/u);
  assert.match(result.body, /response\.completed/u);
});

test("blank content-type valid SSE turn is not misclassified", async (t) => {
  let upstreamAttempts = 0;
  const { proxy, events } = await createFixture(t, (_req, res) => {
    upstreamAttempts += 1;
    res.statusCode = 200;
    res.end(completedText("空响应头也是真实回答"));
  });
  const result = await request(proxy.status().port);
  assert.equal(upstreamAttempts, 1);
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /空响应头也是真实回答/u);
  assert.match(result.body, /response\.completed/u);
  assert.doesNotMatch(result.body, /请求未能完成|不可重试的错误/u);
  assert.equal(events.some((event) => event.type === "permanent_failure_completed_idle"), false);
});

test("plain capacity response retries six times then completes idle", async (t) => {
  let upstreamAttempts = 0;
  const { proxy } = await createFixture(t, (_req, res) => {
    upstreamAttempts += 1;
    res.statusCode = 200;
    res.end("Selected model is at capacity. Please try a different model.");
  });
  let result = null;
  for (let attempt = 0; attempt < 6; attempt += 1) result = await request(proxy.status().port);
  assert.equal(upstreamAttempts, 6);
  assert.match(result.body, /当前模型暂时满载/u);
  assert.match(result.body, /response\.completed/u);
});

test("account usage limit does not retry and completes idle immediately", async (t) => {
  let upstreamAttempts = 0;
  const { proxy } = await createFixture(t, (_req, res) => {
    upstreamAttempts += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse({ type: "response.failed", response: { error: { code: "usage_limit_reached", message: "You've hit your usage limit" } } }));
  });
  const result = await request(proxy.status().port);
  assert.equal(upstreamAttempts, 1);
  assert.equal(result.aborted, false);
  assert.match(result.body, /当前账号额度已耗尽/u);
  assert.match(result.body, /response\.completed/u);
});

test("partial text is preserved and clean EOF delegates same-turn retry", async (t) => {
  let upstreamAttempts = 0;
  const { proxy } = await createFixture(t, (_req, res) => {
    upstreamAttempts += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (upstreamAttempts === 1) {
      res.end(sse({ type: "response.output_text.delta", delta: "我今天想吃" }));
      return;
    }
    res.end(completedText("恢复成功"));
  });
  const first = await request(proxy.status().port);
  const second = await request(proxy.status().port);
  assert.equal(first.aborted, false);
  assert.match(first.body, /我今天想吃/u);
  assert.doesNotMatch(first.body, /response\.completed/u);
  assert.match(second.body, /恢复成功/u);
  assert.match(second.body, /response\.completed/u);
});

test("incomplete tool attempt is hidden and completed tool is forwarded once", async (t) => {
  let upstreamAttempts = 0;
  const { proxy } = await createFixture(t, (_req, res) => {
    upstreamAttempts += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (upstreamAttempts === 1) {
      res.end([
        { type: "response.created", response: { id: "resp_bad", status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { type: "custom_tool_call", id: "bad-item", call_id: "bad-call", name: "apply_patch", input: "" } },
        { type: "response.custom_tool_call_input.delta", output_index: 0, item_id: "bad-item", input: "partial" },
      ].map(sse).join(""));
      return;
    }
    res.end(completedTool("good-call"));
  });
  const first = await request(proxy.status().port);
  const second = await request(proxy.status().port);
  assert.equal(first.body, "");
  assert.doesNotMatch(second.body, /bad-call|partial/u);
  assert.match(second.body, /good-call/u);
  assert.equal((second.body.match(/"type":"response\.output_item\.done"/gu) ?? []).length, 1);
  assert.equal((second.body.match(/response\.completed/gu) ?? []).length, 1);
});

test("unknown permanent failure becomes a completed idle notice without retry", async (t) => {
  let upstreamAttempts = 0;
  const { proxy } = await createFixture(t, (_req, res) => {
    upstreamAttempts += 1;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "invalid_request", message: "bad request" } }));
  });
  const result = await request(proxy.status().port);
  assert.equal(upstreamAttempts, 1);
  assert.equal(result.statusCode, 200);
  assert.match(result.body, /不可重试的错误/u);
  assert.match(result.body, /response\.completed/u);
});

test("tool-buffered requests remain isolated from concurrent healthy turns", async (t) => {
  const { proxy } = await createFixture(t, (req, res) => {
    const metadata = JSON.parse(req.headers["x-codex-turn-metadata"]);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (metadata.thread_id === "slow-thread") {
      res.write(sse({ type: "response.output_item.added", item: { type: "custom_tool_call", id: "slow-tool" } }));
      setTimeout(() => res.end(), 100);
      return;
    }
    res.end(completedText("fast"));
  }, { firstProgressTimeoutMs: 200, progressIdleTimeoutMs: 200 });
  const slowPromise = request(proxy.status().port, { threadId: "slow-thread" });
  const startedAt = Date.now();
  const fast = await request(proxy.status().port, { threadId: "fast-thread", turnId: "fast-turn" });
  assert.ok(Date.now() - startedAt < 80);
  assert.match(fast.body, /fast/u);
  const slow = await slowPromise;
  assert.equal(slow.body, "");
});

test("compaction retries twice internally and returns only a real completed compaction", async (t) => {
  let upstreamAttempts = 0;
  const { proxy } = await createFixture(t, (_req, res) => {
    upstreamAttempts += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (upstreamAttempts === 1) {
      res.end(sse({ type: "response.in_progress" }));
      return;
    }
    const item = { type: "compaction", id: "compact-one", encrypted_content: "opaque" };
    res.end(sse({ type: "response.output_item.done", item }) + sse({ type: "response.completed", response: { output: [item] } }));
  });
  const result = await request(proxy.status().port, { requestKind: "compaction" });
  assert.equal(upstreamAttempts, 2);
  assert.match(result.body, /compact-one/u);
  assert.match(result.body, /response\.completed/u);
});

test("blank content-type valid compaction is accepted", async (t) => {
  let upstreamAttempts = 0;
  const { proxy } = await createFixture(t, (_req, res) => {
    upstreamAttempts += 1;
    const item = { type: "compaction", id: "compact-blank-content-type", encrypted_content: "opaque" };
    res.statusCode = 200;
    res.end(sse({ type: "response.output_item.done", item }) + sse({ type: "response.completed", response: { output: [item] } }));
  });
  const result = await request(proxy.status().port, { requestKind: "compaction" });
  assert.equal(upstreamAttempts, 1);
  assert.match(result.body, /compact-blank-content-type/u);
  assert.match(result.body, /response\.completed/u);
});

test("two incomplete compaction attempts return clean EOF for App Server retry", async (t) => {
  let upstreamAttempts = 0;
  const { proxy } = await createFixture(t, (_req, res) => {
    upstreamAttempts += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse({ type: "response.in_progress" }));
  });
  const result = await request(proxy.status().port, { requestKind: "compaction" });
  assert.equal(upstreamAttempts, 2);
  assert.equal(result.statusCode, 200);
  assert.equal(result.aborted, false);
  assert.equal(result.body, "");
});
