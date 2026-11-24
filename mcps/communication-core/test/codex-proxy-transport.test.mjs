import test from "node:test";
import assert from "node:assert/strict";
import { CodexProxyTransport } from "../src/transports/codex-proxy.mjs";

const target = { machine_id: "test-machine", host: "codex", surface: "desktop", conversation_id: "test-target", binding_id: "target-binding", binding_generation: 3 };
const request = { delivery_id: "delivery-original", message_id: "message-original", source: { caller: { host: "antigravity", conversation_id: "test-source" }, origin: { kind: "agent_message", channel: "core", source_ref: "source-event" } }, target, body: { text: "请核材料", attachment_refs: [] }, delivery_policy: "next_model_boundary" };

function receipt(overrides = {}) {
  return { delivery_id: request.delivery_id, message_id: request.message_id, binding_generation: 3, origin: { kind: "agent", host: "antigravity", conversation_id: "test-source" }, target: { host: "codex", conversation_id: "test-target" }, thread_id: "test-target", turn_id: "test-turn", outcome: "accepted", request_sent: true, injection_method: "turn/steer", ...overrides };
}

function transport(fetchImpl) { return new CodexProxyTransport({ baseUrl: "http://127.0.0.1:12345", token: "private-sentinel-token", fetchImpl }); }

test("Codex reads use only their separate credential and no recovery or fallback when authorization fails", async () => {
  const calls = [];
  const absent = transport(async (...args) => { calls.push(args); throw new Error("unexpected upstream request"); });
  await assert.rejects(absent.readHostContent("list", { limit: 2 }), { code: "host_content_unavailable" });
  assert.deepEqual(calls, []);
  const options = { baseUrl: "http://127.0.0.1:12345", token: "synthetic-delivery", contentReadToken: "synthetic-read" };
  assert.throws(() => new CodexProxyTransport({ ...options, contentReadToken: options.token }), { code: "invalid_config" });
  const client = new CodexProxyTransport({ ...options, fetchImpl: async (url, options) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, authorization: options.headers.Authorization });
    if (pathname.endsWith("/snapshot")) {
      const targetId = JSON.parse(options.body).thread_id;
      const status = targetId === "busy-fixture" ? 429 : targetId === "timeout-fixture" ? 504 : 403;
      return Response.json({ error: "synthetic-error" }, { status });
    }
    if (pathname.endsWith("/list")) return Response.json({ threads: [], coverage: { partial: false } });
    return Response.json({ ok: true, delivery: receipt() });
  } });
  assert.deepEqual((await client.readHostContent("list", { limit: 2 })).threads, []);
  await assert.rejects(client.readHostContent("snapshot", { thread_id: "test-target" }), { code: "forbidden" });
  await assert.rejects(client.readHostContent("snapshot", { thread_id: "busy-fixture" }), { code: "host_content_busy" });
  await assert.rejects(client.readHostContent("snapshot", { thread_id: "timeout-fixture" }), { code: "host_content_timeout" });
  await client.query({ delivery_id: request.delivery_id }, { request });
  assert.deepEqual(calls.map(call => call.authorization), [...Array(4).fill("Bearer synthetic-read"), "Bearer synthetic-delivery"]);
  await Promise.all([client.close(), absent.close()]);
});

test("submission tracking precedes only POST and an aborted request cannot enter fetch", async () => {
  let reported = 0;
  let requests = 0;
  const client = transport(async (url, options) => {
    if (options.method === "POST") assert.equal(reported, 1);
    requests += 1;
    return Response.json({ ok: true, delivery: receipt() });
  });
  assert.equal(client.submissionTracking, true);
  await client.query({ delivery_id: request.delivery_id }, { request });
  assert.equal(reported, 0);
  await client.submit(request, { onRequestStarted() { reported += 1; } });
  assert.equal(reported, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.submit(request, { signal: controller.signal, onRequestStarted() { reported += 1; } }));
  assert.equal(requests, 2);
  assert.equal(reported, 1);
  await client.close();
});

test("准确映射通用来源，不构造QQ身份或模型覆盖", async () => {
  const calls = [];
  const client = transport(async (url, options) => { calls.push({ url, options }); return Response.json({ ok: true, delivery: receipt({ diagnostic: "private-sentinel-token" }) }); });
  const result = await client.submit(request);
  assert.equal(result.outcome, "accepted");
  assert.deepEqual(result.target, target);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.origin, { kind: "agent", host: "antigravity", conversation_id: "test-source" });
  assert.equal(body.message_visibility, "visible");
  assert.equal(body.delivery_id, request.delivery_id);
  assert.equal(body.binding_generation, 3);
  assert.equal(calls[0].options.headers.Authorization, "Bearer private-sentinel-token");
  for (const field of ["model", "trustedPeerQq", "taskId", "retry_failed_before_send"]) assert.equal(Object.hasOwn(body, field), false);
  assert.equal(JSON.stringify(result).includes("private-sentinel-token"), false);
  assert.equal(result.injection_method, "turn/steer");
});

test("新transport能从持久原请求恢复原ID查询，无需发送缓存", async () => {
  const calls = [];
  const client = transport(async (url, options) => { calls.push({ url, options }); return Response.json({ ok: true, delivery: receipt() }); });
  const result = await client.query({ delivery_id: request.delivery_id }, { request });
  assert.equal(result.outcome, "accepted");
  const address = new URL(calls[0].url);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(address.pathname, "/v1/communication/deliveries/delivery-original");
  assert.equal(address.searchParams.get("source_host"), "antigravity");
  assert.equal(address.searchParams.get("source_conversation_id"), "test-source");
  assert.equal(address.searchParams.get("target_conversation_id"), "test-target");
  assert.equal(address.searchParams.get("binding_generation"), "3");
  assert.equal(calls[0].options.body, undefined);
});

test("来源目标原消息代次任一不符均拒绝受理结果", async () => {
  for (const patch of [
    { delivery_id: "other" }, { message_id: "other" }, { binding_generation: 4 }, { thread_id: "other" },
    { origin: { kind: "agent", host: "codex", conversation_id: "test-source" } },
    { origin: { kind: "agent", host: "antigravity", conversation_id: "other" } },
    { target: { host: "codex", conversation_id: "other" } },
  ]) {
    const client = transport(async () => Response.json({ ok: true, delivery: receipt(patch) }));
    await assert.rejects(client.submit(request), { code: "codex_receipt_identity_mismatch" });
  }
});

test("只有明确未发送的busy或failed_before_send保留可恢复语义", async () => {
  for (const outcome of ["busy", "failed_before_send"]) {
    for (const requestSent of [true, null, undefined, false]) {
      const client = transport(async () => Response.json({ ok: true, delivery: receipt({ outcome, request_sent: requestSent }) }));
      assert.equal((await client.submit(request)).outcome, requestSent === false ? outcome : "unknown");
    }
  }
});

test("accepted缺少发送证据时保持unknown，异常只提交一次", async () => {
  const uncertain = transport(async () => Response.json({ ok: true, delivery: receipt({ request_sent: null }) }));
  assert.equal((await uncertain.submit(request)).outcome, "unknown");
  let submissions = 0;
  const client = transport(async () => { submissions += 1; throw new Error("private-sentinel-token"); });
  await assert.rejects(client.submit(request), error => !error.message.includes("private-sentinel-token"));
  assert.equal(submissions, 1);
});

test("附件、非代理来源、非Codex目标及错误查询身份在HTTP前拒绝", async () => {
  let calls = 0;
  const client = transport(async () => { calls += 1; return Response.json({}); });
  for (const changed of [{ ...request, body: { ...request.body, attachment_refs: ["unmapped"] } }, { ...request, source: { ...request.source, origin: { kind: "owner_message" } } }, { ...request, target: { ...target, host: "other" } }]) await assert.rejects(client.submit(changed), { code: "codex_unsupported_request" });
  await assert.rejects(client.query({ delivery_id: "other" }, { request }), { code: "codex_query_identity_mismatch" });
  assert.equal(calls, 0);
});

test("控制端点只接受明确回环HTTP根地址", () => {
  for (const baseUrl of ["https://127.0.0.1:12345", "http://example.com:12345", "http://127.0.0.1", "http://user:secret@127.0.0.1:12345", "http://127.0.0.1:12345/path", "http://127.0.0.1:12345/?secret=1"]) assert.throws(() => new CodexProxyTransport({ baseUrl, token: "test" }), { code: "invalid_config" });
});

test("关闭后清令牌并拒绝发送，HTTP诊断保持有限错误", async () => {
  const client = transport(async () => new Response("private-sentinel-token", { status: 403 }));
  await assert.rejects(client.submit(request), error => error.code === "codex_control_http_error" && !error.message.includes("private-sentinel-token"));
  await client.close();
  assert.equal(client.token, "");
  await assert.rejects(client.submit(request), { code: "closed" });
});

test("只读回信逐页核同一原身份和completed轮次，游标保持不透明", async () => {
  const urls = [];
  const client = transport(async url => {
    urls.push(url);
    const later = new URL(url).searchParams.get("cursor") === "opaque_next";
    return Response.json({ ok: true, delivery: receipt({ injection_method: "turn/start" }), replies: { supported: true, outcome: "completed", thread_id: "test-target", turn_id: "test-turn", turn_status: "completed", replies: [{ item_id: later ? "final-item" : "first-item", text: later ? "最终正文" : "第一段", turn_status: "completed" }], cursor: later ? null : "opaque_next", partial: !later } });
  });
  const result = await client.observeReply(request);
  assert.equal(result.text, "第一段\n\n最终正文");
  assert.equal(result.native_message_id, "final-item");
  assert.equal(result.native_conversation_id, "test-target");
  assert.equal(result.native_turn_id, "test-turn");
  assert.equal(urls.length, 2);
  assert.equal(new URL(urls[1]).searchParams.get("cursor"), "opaque_next");
  assert.equal(new URL(urls[0]).pathname.endsWith("/replies"), true);
});

test("未完成、错轮次、重复游标或未支持均不伪造回信", async () => {
  const normal = { supported: true, thread_id: "test-target", turn_id: "test-turn", turn_status: "completed", replies: [{ item_id: "item", text: "正文", turn_status: "completed" }], partial: false };
  for (const changed of [{ supported: false }, { thread_id: "other" }, { turn_id: "other" }, { turn_status: "inProgress" }, { partial: true, cursor: null }, { replies: [{ item_id: "item", text: "正文", turn_status: "inProgress" }] }]) {
    const client = transport(async () => Response.json({ ok: true, delivery: receipt({ injection_method: "turn/start" }), replies: { ...normal, ...changed } }));
    assert.equal(await client.observeReply(request), null);
  }
  const repeating = transport(async () => Response.json({ ok: true, delivery: receipt({ injection_method: "turn/start" }), replies: { ...normal, partial: true, cursor: "same_cursor", replies: [] } }));
  assert.equal(await repeating.observeReply(request), null);
});

const unresolvedTurnPage = { supported: true, outcome: "ok", thread_id: "test-target", turn_id: "test-turn",
  turn_status: null, replies: [], cursor: "unresolved_cursor", partial: true };

test("原轮尚未出现在一批历史页时沿同一原身份继续，直到确认完成", async () => {
  const calls = [];
  const client = transport(async url => {
    const address = new URL(url);
    calls.push(address.searchParams.get("cursor"));
    assert.ok(address.pathname.endsWith("/delivery-original/replies"));
    assert.equal(address.searchParams.get("target_conversation_id"), target.conversation_id);
    const replies = calls.length === 1 ? unresolvedTurnPage : {
      ...unresolvedTurnPage, turn_status: "completed", replies: [{ item_id: "expected-old-reply", text: "旧轮回复", turn_status: "completed" }],
      partial: false, cursor: null,
    };
    return Response.json({ ok: true, delivery: receipt({ injection_method: "turn/start" }), replies });
  });
  const result = await client.observeReply(request);
  assert.equal(result.native_message_id, "expected-old-reply");
  assert.equal(result.native_turn_id, "test-turn");
  assert.equal(result.text, "旧轮回复");
  assert.deepEqual(calls, [null, "unresolved_cursor"]);
});

test("未找到原轮时只接纳没有正文且有效的续页", async () => {
  for (const changed of [
    { outcome: "unavailable" }, { turn_status: "inProgress" }, { turn_id: "other" }, { thread_id: "other" },
    { replies: [{ item_id: "unverified", text: "unverified", turn_status: "completed" }] },
    { cursor: null }, { cursor: "not a cursor" }, { partial: false }, { supported: false },
  ]) {
    let reads = 0;
    const client = transport(async () => {
      reads += 1;
      return Response.json({ ok: true, delivery: receipt({ injection_method: "turn/start" }),
        replies: { ...unresolvedTurnPage, ...changed } });
    });
    assert.equal(await client.observeReply(request), null);
    assert.equal(reads, 1);
    await client.close();
  }
});

test("原轮续页不延长原查询上限，已确认的轮次不得反向降为未确认", async () => {
  let reads = 0;
  const bounded = transport(async () => {
    reads += 1;
    return Response.json({ ok: true, delivery: receipt({ injection_method: "turn/start" }),
      replies: { ...unresolvedTurnPage, cursor: "page_" + reads } });
  });
  assert.equal(await bounded.observeReply(request), null);
  assert.equal(reads, 8);
  let attempt = 0;
  const downgrading = transport(async () => {
    attempt += 1;
    return Response.json({ ok: true, delivery: receipt({ injection_method: "turn/start" }),
      replies: attempt === 1 ? { ...unresolvedTurnPage, turn_status: "completed", cursor: "confirmed_cursor",
        replies: [{ item_id: "first", text: "已确认但未取全", turn_status: "completed" }] } : unresolvedTurnPage });
  });
  assert.equal(await downgrading.observeReply(request), null);
  assert.equal(attempt, 2);
  await Promise.all([bounded.close(), downgrading.close()]);
});

test("steer回合的旧助手正文不作为本次消息回信", async () => {
  let reads = 0;
  const client = transport(async () => {
    reads += 1;
    return Response.json({ ok: true, delivery: receipt(), replies: { supported: true, thread_id: "test-target", turn_id: "test-turn", turn_status: "completed", replies: [{ item_id: "old-agent-item", text: "本次注入前的正文", turn_status: "completed" }], partial: false } });
  });
  assert.equal(await client.observeReply(request), null);
  assert.equal(reads, 1);
  await client.close();
});
