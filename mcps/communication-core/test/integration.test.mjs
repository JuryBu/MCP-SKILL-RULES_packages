import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MessageStore } from "../src/store.mjs";
import { CommunicationCore } from "../src/core.mjs";
import { createMcpHttpServer } from "../src/mcp-server.mjs";
import { MockAdapter } from "../src/adapters/mock.mjs";

const sourceIdentity = { machine_id: "isolation-machine", host: "codex", surface: "test", conversation_id: "synthetic-source" };
const receiverIdentity = { machine_id: "isolation-machine", host: "antigravity", surface: "test", conversation_id: "synthetic-receiver" };
const targets = [
  { ...sourceIdentity, binding_id: "source-binding", binding_generation: 1, adapter_id: "mock", capabilities: { next_model_boundary: true, when_idle: true }, evidence: "simulated" },
  { ...receiverIdentity, binding_id: "receiver-binding", binding_generation: 1, adapter_id: "mock", capabilities: { next_model_boundary: true, when_idle: true }, evidence: "simulated" },
];
const principals = [
  { id: "source", token: "synthetic-source-token-for-isolated-tests", identity: sourceIdentity, allowed_targets: ["receiver-binding"], origin_kinds: ["agent_message"] },
  { id: "receiver", token: "synthetic-receiver-token-for-isolated-tests", identity: receiverIdentity, allowed_targets: ["source-binding"], origin_kinds: ["agent_message"] },
];

function address(target) {
  return {
    machine_id: target.machine_id,
    host: target.host,
    surface: target.surface,
    conversation_id: target.conversation_id,
    binding_id: target.binding_id,
    binding_generation: target.binding_generation,
  };
}

async function connect(url, principal) {
  const client = new Client({ name: `isolation-${principal.id}`, version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${principal.token}` } },
  }));
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  assert.ok(result.structuredContent, "MCP工具应返回结构化结果");
  return result.structuredContent;
}

test("real MCP clients resolve, send, receive a correlated reply and reopen persisted state", { timeout: 20000 }, async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "communication-core-集成 test-"));
  const databasePath = path.join(directory, "core.sqlite");
  let runtime;
  const clients = [];
  async function open() {
    const store = new MessageStore({ filePath: databasePath });
    const adapter = new MockAdapter();
    const core = new CommunicationCore({ store, targets, principals, adapters: { mock: adapter } });
    runtime = { store, adapter, core, server: null };
    await core.start();
    const server = await createMcpHttpServer({ core, principals, port: 0 });
    runtime.server = server;
    return runtime;
  }
  async function close() {
    await Promise.allSettled(clients.splice(0).map(client => client.close()));
    if (!runtime) return;
    await runtime.server?.close();
    await runtime.core.close();
    runtime.store.close();
    runtime = null;
  }
  context.after(async () => {
    await close();
    fs.rmSync(directory, { recursive: true });
  });
  await open();
  const source = await connect(runtime.server.url, principals[0]);
  const receiver = await connect(runtime.server.url, principals[1]);
  clients.push(source, receiver);
  const listed = await call(source, "communication_list_conversations", { caller: sourceIdentity });
  assert.equal(listed.targets.length, 1);
  assert.equal(listed.targets[0].conversation_id, receiverIdentity.conversation_id);
  const resolved = await call(source, "communication_resolve_target", { caller: sourceIdentity, binding_id: "receiver-binding" });
  const request = {
    caller: sourceIdentity,
    origin: { kind: "agent_message", channel: "host_mcp", source_ref: "synthetic-request-event" },
    target: address(resolved.target),
    dedupe_key: "isolation-send-1",
    text: "请在保留原工作进度的同时核对测试材料",
    delivery_policy: "next_model_boundary",
    reply_required: true,
    expires_at: "2099-01-01T00:00:00Z",
  };
  const sent = await call(source, "communication_send_message", request);
  const originalMessageId = sent.message.message_id;
  const originalDeliveryId = sent.delivery.delivery_id;
  await runtime.core.drain();
  const duplicate = await call(source, "communication_send_message", request);
  assert.equal(duplicate.message.message_id, originalMessageId);
  assert.equal(duplicate.delivery.delivery_id, originalDeliveryId);
  assert.equal(duplicate.duplicate, true);
  assert.equal(runtime.adapter.calls.length, 1);
  const delivered = await call(source, "communication_get_message", { caller: sourceIdentity, message_id: originalMessageId });
  assert.equal(delivered.delivery.status, "accepted");
  assert.equal(delivered.message.processing, "pending");
  assert.equal(delivered.message.model_observed, "unknown");
  assert.equal(delivered.message.ui_observed, "unknown");
  const sourceTarget = await call(receiver, "communication_resolve_target", { caller: receiverIdentity, binding_id: "source-binding" });
  const reply = await call(receiver, "communication_send_message", {
    caller: receiverIdentity,
    origin: { kind: "agent_message", channel: "host_mcp", source_ref: "synthetic-reply-event" },
    target: address(sourceTarget.target),
    dedupe_key: "isolation-reply-1",
    text: "材料已经核对，具体结果保存在这条关联回信中",
    in_reply_to: originalMessageId,
    expires_at: "2099-01-01T00:00:00Z",
  });
  const waited = await call(source, "communication_wait", { caller: sourceIdentity, message_id: originalMessageId, until: "reply", wait_ms: 50 });
  assert.equal(waited.matched, true);
  assert.equal(waited.matched_by, "reply");
  const replySnapshot = await call(source, "communication_get_message", { caller: sourceIdentity, message_id: reply.message.message_id });
  assert.equal(replySnapshot.message.envelope.in_reply_to, originalMessageId);
  assert.equal(replySnapshot.message.envelope.text, "材料已经核对，具体结果保存在这条关联回信中");
  assert.equal((await call(source, "communication_get_message", { caller: sourceIdentity, message_id: originalMessageId })).message.processing, "pending");
  await call(receiver, "communication_ack_processing", { caller: receiverIdentity, message_id: originalMessageId, delivery_id: originalDeliveryId, binding_generation: 1, processing: "done" });
  await runtime.core.drain();
  await close();
  await open();
  const reopenedSource = await connect(runtime.server.url, principals[0]);
  clients.push(reopenedSource);
  const persisted = await call(reopenedSource, "communication_get_message", { caller: sourceIdentity, message_id: originalMessageId });
  assert.equal(persisted.message.processing, "done");
  assert.equal(persisted.delivery.delivery_id, originalDeliveryId);
  const repeated = await call(reopenedSource, "communication_send_message", request);
  assert.equal(repeated.message.message_id, originalMessageId);
  await runtime.core.drain();
  assert.equal(runtime.adapter.calls.length, 0);
});

test("real SQLite recovers pending and unknown deliveries using their original identities", { timeout: 10000 }, async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "communication-core-recovery-"));
  const databasePath = path.join(directory, "core.sqlite");
  let currentCore;
  let currentStore;
  async function open(adapter) {
    currentStore = new MessageStore({ filePath: databasePath });
    currentCore = new CommunicationCore({ store: currentStore, targets, principals, adapters: { mock: adapter } });
    await currentCore.start();
    await currentCore.drain();
  }
  async function close() {
    await currentCore?.close();
    currentStore?.close();
    currentCore = null;
    currentStore = null;
  }
  context.after(async () => {
    await close();
    fs.rmSync(directory, { recursive: true });
  });
  const caller = { principal_id: "source" };
  const request = {
    caller: sourceIdentity,
    origin: { kind: "agent_message", channel: "host_mcp", source_ref: "recovery-event" },
    target: address(targets[1]),
    dedupe_key: "pending-before-reopen",
    text: "待投递状态必须在重开后继续",
    expires_at: "2099-01-01T00:00:00Z",
  };
  const busyAdapter = new MockAdapter({ mode: "busy" });
  await open(busyAdapter);
  const pending = await currentCore.sendMessage(caller, request);
  await currentCore.drain();
  assert.equal(pending.delivery.status, "prepared");
  await close();
  const acceptedAdapter = new MockAdapter();
  await open(acceptedAdapter);
  const recovered = currentCore.getMessage(caller, { caller: sourceIdentity, message_id: pending.message.message_id });
  assert.equal(recovered.delivery.status, "accepted");
  assert.equal(recovered.delivery.delivery_id, pending.delivery.delivery_id);
  assert.equal(acceptedAdapter.calls.length, 1);
  acceptedAdapter.mode = "throw_after_accept";
  const initiallyUncertain = await currentCore.sendMessage(caller, { ...request, dedupe_key: "unknown-before-reopen" });
  await currentCore.drain();
  const uncertain = currentCore.getMessage(caller, { caller: sourceIdentity, message_id: initiallyUncertain.message.message_id });
  assert.equal(uncertain.delivery.status, "unknown");
  const submittedBeforeClose = acceptedAdapter.calls.length;
  await close();
  acceptedAdapter.mode = "accept";
  await open(acceptedAdapter);
  const reconciled = currentCore.getMessage(caller, { caller: sourceIdentity, message_id: uncertain.message.message_id });
  assert.equal(reconciled.delivery.status, "accepted");
  assert.equal(reconciled.delivery.delivery_id, uncertain.delivery.delivery_id);
  assert.equal(acceptedAdapter.calls.length, submittedBeforeClose);
  assert.ok(acceptedAdapter.queries.includes(uncertain.delivery.delivery_id));
  assert.equal(reconciled.message.processing, "pending");
});

test("HTTP cancellation removes the real Core waiter without changing message state", { timeout: 10000 }, async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "communication-core-cancel-"));
  const store = new MessageStore({ filePath: path.join(directory, "core.sqlite") });
  const core = new CommunicationCore({ store, targets, principals, adapters: { mock: new MockAdapter() } });
  let server;
  let client;
  context.after(async () => {
    await client?.close();
    await server?.close();
    await core.close();
    store.close();
    fs.rmSync(directory, { recursive: true });
  });
  await core.start();
  server = await createMcpHttpServer({ core, principals, port: 0 });
  client = await connect(server.url, principals[0]);
  const sent = await call(client, "communication_send_message", {
    caller: sourceIdentity,
    origin: { kind: "agent_message", channel: "host_mcp", source_ref: "cancellation-event" },
    target: address(targets[1]),
    dedupe_key: "cancellation-is-read-only",
    text: "取消等待应只清理等待资源",
    expires_at: "2099-01-01T00:00:00Z",
  });
  const messageId = sent.message.message_id;
  await core.drain();
  const before = core.getMessage({ principal_id: "source" }, { caller: sourceIdentity, message_id: messageId });
  const controller = new AbortController();
  const waiting = client.callTool({ name: "communication_wait", arguments: { caller: sourceIdentity, message_id: messageId, until: "reply", wait_ms: 45000 } }, undefined, { signal: controller.signal }).catch(error => error);
  const readyDeadline = Date.now() + 2000;
  while (core.waiters.size === 0 && Date.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(core.waiters.size, 1);
  controller.abort();
  await waiting;
  const cleanupDeadline = Date.now() + 2000;
  while (core.waiters.size > 0 && Date.now() < cleanupDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(core.waiters.size, 0);
  assert.deepEqual(core.getMessage({ principal_id: "source" }, { caller: sourceIdentity, message_id: messageId }), before);
});

test("structured adapter diagnostics never reach MCP results or persisted SQLite", { timeout: 10000 }, async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "communication-core-redaction-"));
  const databasePath = path.join(directory, "core.sqlite");
  const store = new MessageStore({ filePath: databasePath });
  const sentinel = "FICTIONAL_SECRET_SENTINEL_structured_receipt";
  const adapter = {
    async deliver({ delivery, target }) {
      return {
        outcome: "unknown",
        delivery_id: delivery.delivery_id,
        target_key: JSON.stringify([target.machine_id, target.host, target.surface ?? "desktop", target.conversation_id]),
        headers: { authorization: `Bearer ${sentinel}` },
        debug_url: `https://invalid.example/?token=${sentinel}`,
        error: { code: "remote_error", message: sentinel },
        evidence: { kind: "simulated", debug: sentinel },
      };
    },
  };
  const core = new CommunicationCore({ store, targets, principals, adapters: { mock: adapter } });
  let server;
  const clients = [];
  context.after(async () => {
    await Promise.allSettled(clients.map(client => client.close()));
    await server?.close();
    await core.close();
    store.close();
    fs.rmSync(directory, { recursive: true });
  });
  await core.start();
  server = await createMcpHttpServer({ core, principals, port: 0 });
  clients.push(await connect(server.url, principals[0]), await connect(server.url, principals[1]));
  const sent = await call(clients[0], "communication_send_message", {
    caller: sourceIdentity,
    origin: { kind: "agent_message", channel: "host_mcp", source_ref: "redaction-event" },
    target: address(targets[1]),
    dedupe_key: "redaction-request",
    text: "只保存可安全归还的回执",
    expires_at: "2099-01-01T00:00:00Z",
  });
  await core.drain();
  const snapshots = [sent];
  snapshots.push(await call(clients[0], "communication_get_message", { caller: sourceIdentity, message_id: sent.message.message_id }));
  snapshots.push(await call(clients[1], "communication_get_message", { caller: receiverIdentity, message_id: sent.message.message_id }));
  assert.equal(JSON.stringify(snapshots).includes(sentinel), false);
  for (const filePath of [databasePath, `${databasePath}-wal`]) {
    if (fs.existsSync(filePath)) assert.equal(fs.readFileSync(filePath).includes(Buffer.from(sentinel)), false);
  }
});
