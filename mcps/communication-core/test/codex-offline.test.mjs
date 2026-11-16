import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommunicationCore } from "../src/core.mjs";
import { MessageStore } from "../src/store.mjs";
import { CodexDeliveryAdapter } from "../src/adapters/codex.mjs";
import { CodexProxyTransport } from "../src/transports/codex-proxy.mjs";

const source = { machine_id: "test-machine", host: "antigravity", surface: "desktop", conversation_id: "offline-source" };
const target = { machine_id: "test-machine", host: "codex", surface: "desktop", conversation_id: "offline-target", binding_id: "offline-binding", binding_generation: 1, adapter_id: "codex", capabilities: { next_model_boundary: true, when_idle: true }, evidence: "controlled-local-test" };
const context = { principal_id: "offline-principal" };

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(server.address().port); });
  });
}

function closeServer(server) {
  server.closeAllConnections();
  return new Promise(resolve => server.close(resolve));
}

test("关闭的真实回环HTTP入口先待送，重开核心和入口后沿原ID只投递一次", async () => {
  const probe = createServer();
  const port = await listen(probe, 0);
  await closeServer(probe);
  const directory = mkdtempSync(join(tmpdir(), "communication-codex-offline-"));
  let now = Date.parse("2030-01-01T00:00:00Z");
  const received = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, delivery: { ...body, thread_id: target.conversation_id, turn_id: "controlled-turn", outcome: "accepted", request_sent: true, injection_method: "turn/start" } }));
  });
  let active;
  const open = () => {
    const transport = new CodexProxyTransport({ baseUrl: `http://127.0.0.1:${port}`, token: "fixture-only-token" });
    const store = new MessageStore({ filePath: join(directory, "core.sqlite") });
    const core = new CommunicationCore({ store, targets: [target], principals: [{ id: context.principal_id, identity: source, allowed_targets: [target.binding_id], origin_kinds: ["agent_message"] }], adapters: { codex: new CodexDeliveryAdapter({ transport }) }, now: () => now });
    return { core, store, transport };
  };
  const stop = async () => { if (active) { await active.core.close(); active.store.close(); await active.transport.close(); active = null; } };
  const input = { caller: source, origin: { kind: "agent_message", channel: "test", source_ref: "offline-source" }, target: { machine_id: target.machine_id, host: target.host, surface: target.surface, conversation_id: target.conversation_id, binding_id: target.binding_id, binding_generation: 1 }, dedupe_key: "offline-original", text: "等待B端恢复", expires_at: "2030-01-01T01:00:00Z" };
  try {
    active = open();
    await active.core.start();
    const sent = await active.core.sendMessage(context, input);
    await active.core.drain();
    const queued = active.store.getDelivery(sent.delivery.delivery_id);
    assert.equal(queued.status, "prepared");
    assert.equal(queued.evidence.evidence.retry_after_ms, 1000);
    assert.equal(queued.attempt_count, 1);
    await stop();
    now += 500;
    active = open();
    await active.core.start();
    await active.core.drain();
    assert.equal(active.store.getDelivery(sent.delivery.delivery_id).attempt_count, 1);
    await listen(server, port);
    now += 501;
    await active.core.dispatchPending();
    await active.core.drain();
    const delivered = active.core.getMessage(context, { caller: source, message_id: sent.message.message_id });
    assert.equal(delivered.delivery.status, "accepted");
    assert.equal(delivered.delivery.delivery_id, sent.delivery.delivery_id);
    assert.equal(received.length, 1);
    assert.equal(received[0].message_id, sent.message.message_id);
    assert.equal(received[0].delivery_id, sent.delivery.delivery_id);
    assert.equal(delivered.message.processing, "pending");
    assert.equal((await active.core.sendMessage(context, input)).duplicate, true);
    await active.core.drain();
    assert.equal(received.length, 1);
  } finally {
    await stop();
    await closeServer(server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("已收到HTTP响应后的读取失败及混合连接错误继续保持未知", async () => {
  const request = { delivery_id: "test-delivery", message_id: "test-message", source: { caller: source, origin: { kind: "agent_message" } }, target, body: { text: "正文", attachment_refs: [] }, delivery_policy: "next_model_boundary" };
  const refused = Object.assign(new Error("controlled refusal"), { code: "ECONNREFUSED" });
  const reset = Object.assign(new Error("controlled reset"), { code: "ECONNRESET" });
  for (const fetchImpl of [
    async () => new Response(new ReadableStream({ start(controller) { controller.error(refused); } })),
    async () => { throw new TypeError("fetch failed", { cause: new AggregateError([refused, reset]) }); },
    async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("unverified phase"), { code: "ECONNREFUSED", syscall: "read" }) }); },
  ]) {
    const transport = new CodexProxyTransport({ baseUrl: "http://127.0.0.1:12345", token: "fixture-only-token", fetchImpl });
    const adapter = new CodexDeliveryAdapter({ transport });
    const result = await adapter.deliver({ message: { message_id: request.message_id, envelope: { caller: source, origin: request.source.origin, text: request.body.text, attachment_refs: [], delivery_policy: request.delivery_policy } }, delivery: { delivery_id: request.delivery_id, attempt_count: 1 }, target });
    assert.equal(result.outcome, "unknown");
    assert.equal(result.evidence?.retry_after_ms, undefined);
    await transport.close();
  }
});
