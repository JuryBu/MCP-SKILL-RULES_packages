import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CommunicationCore } from "../src/core.mjs";
import { identityKey } from "../src/contracts.mjs";
import { createMcpHttpServer } from "../src/mcp-server.mjs";
import { MessageStore } from "../src/store.mjs";
import { MockAdapter } from "../src/adapters/mock.mjs";

const machine = "fixture-machine";
const first = { machine_id: machine, host: "codex", surface: "cli", conversation_id: "fixture-first" };
const second = { ...first, conversation_id: "fixture-second" };
const reserved = { ...first, conversation_id: "fixture-ungranted" };
const third = { ...first, conversation_id: "fixture-third" };
const external = { ...third, machine_id: "fixture-external-machine", conversation_id: "fixture-external" };
const dynamicScope = { machine_id: machine, host: "antigravity", surface: "desktop" };
const short = ({ host, conversation_id }) => ({ host, conversation_id });
const target = (identity, binding_id) => ({
  ...identity, binding_id, binding_generation: 1, adapter_id: "fixture-adapter",
  capabilities: { next_model_boundary: true, when_idle: true },
});
const targets = [target(first, "first-binding"), target(second, "second-binding"), target(reserved, "reserved-binding")];
const principals = [
  { id: "fixture-first-token", token: "synthetic-token-contact-first", identity: first, allowed_targets: ["second-binding"], origin_kinds: ["agent_message"], address_book_identity_bound: true },
  { id: "fixture-second-token", token: "synthetic-token-contact-second", identity: second, allowed_targets: ["first-binding"], origin_kinds: ["agent_message"], address_book_identity_bound: true },
  { id: "fixture-host-token", token: "synthetic-token-host", identity: { ...first, conversation_id: "*" }, allowed_targets: ["second-binding"], origin_kinds: ["agent_message"],
    caller_scope: { machine_id: machine, host: first.host, surface: first.surface } },
  { id: "fixture-readonly-host-token", token: "synthetic-token-readonly-host", identity: { ...first, conversation_id: "*" }, allowed_targets: ["second-binding"], origin_kinds: ["agent_message"],
    caller_scope: { machine_id: machine, host: first.host, surface: first.surface }, address_book_identity_bound: false },
  { id: "fixture-qq-channel-token", token: "synthetic-token-qq-channel", identity: { machine_id: machine, host: "qq", surface: "group", conversation_id: "fixture-qq-room" },
    allowed_targets: ["first-binding"], origin_kinds: ["human_message"], channel_component: "napcat_owner" },
  { id: "fixture-github-scope-token", token: "synthetic-token-github-scope", identity: { machine_id: machine, host: "github", surface: "webhook", conversation_id: "*" },
    allowed_targets: ["first-binding"], origin_kinds: ["agent_message"],
    caller_scope: { machine_id: machine, host: "github", surface: "webhook" } },
];
const sharedContacts = [{ id: "fixture-shared", alias: "共有", target: second, note: "公共备注" }];

async function fixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "core-原账本 通讯录-"));
  const active = new Set();
  context.after(async () => {
    for (const close of active) await close();
    await rm(directory, { recursive: true, force: true });
  });
  return async ({ enableContacts = true, sharedEntries = sharedContacts, autoCompleteOnReply = false, enableMultiRecipient = false,
    extraGroupTargets = [], boardInvoke, boardPrincipalIndexes = [0, 1] } = {}) => {
    const filePath = join(directory, "core.sqlite");
    const store = new MessageStore({ filePath });
    const adapter = new MockAdapter();
    let configured = enableContacts ? principals : principals.map(({ address_book_identity_bound: omittedBookTrust, ...entry }) => entry);
    const groupTargets = enableMultiRecipient ? [...targets, target(third, "third-binding"), target(external, "external-binding"), ...extraGroupTargets] : targets;
    if (enableMultiRecipient) configured = [
      { ...configured[0], allowed_targets: ["second-binding", "third-binding", "external-binding", ...extraGroupTargets.map(entry => entry.binding_id)],
        allowed_target_scopes: [dynamicScope] },
      configured[1], configured[2],
      { ...configured[1], id: "fixture-third-token", identity: third, token: "synthetic-token-contact-third", allowed_targets: ["first-binding", "second-binding"] },
      configured[3], configured[4], configured[5],
    ];
    const conversationRoutes = enableMultiRecipient ? [{ ...dynamicScope, adapter_id: "fixture-adapter",
      capabilities: { next_model_boundary: true, when_idle: true } }] : [];
    const core = new CommunicationCore({ store, targets: groupTargets, principals: configured, adapters: { "fixture-adapter": adapter },
      conversationRoutes, autoCompleteOnReply });
    const clients = [];
    let server;
    const close = async () => {
      active.delete(close);
      for (const client of clients) await client.close();
      await server?.close();
      await core.close();
      store.close();
    };
    active.add(close);
    if (enableContacts) core.attachAddressBook({ machineId: machine, sharedContacts: sharedEntries });
    if (enableMultiRecipient) core.attachMessageBatches({ machineId: machine });
    const detachBoard = boardInvoke ? core.attachBoardEntry({
      invoke: boardInvoke, principalIds: boardPrincipalIndexes.map(index => configured[index].id),
    }) : undefined;
    await core.start();
    server = await createMcpHttpServer({ core, principals: configured });
    return {
      close, core, store, filePath, adapter, detachBoard,
      async connect(index, { shared = false } = {}) {
        const client = new Client({ name: "contact-integration-fixture", version: "1.0.0" });
        clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { Authorization: `Bearer ${configured[index].token}`, ...(shared ? { "X-Communication-Core-Shared-Facade": "1" } : {}) } },
        }));
        return client;
      },
    };
  };
}

async function call(client, tool, argumentsValue) {
  return client.callTool({ name: `communication_${tool}`, arguments: argumentsValue });
}

async function ok(client, tool, argumentsValue) {
  const result = await call(client, tool, argumentsValue);
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent;
}

async function expectError(client, tool, argumentsValue, code) {
  const result = await call(client, tool, argumentsValue);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, code);
}

async function delivered(client, caller, message_id) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await ok(client, "get_message", { caller, message_id });
    if (value.delivery?.status === "accepted") return value;
    await delay(15);
  }
  assert.fail("mock delivery did not arrive");
}

test("the board tool works for authorized dedicated and local shared host entries while blocking ungranted, disabled and external channel routes", async context => {
  const open = await fixture(context);
  const baseline = await open();
  const baselineClient = await baseline.connect(0);
  assert.ok(!(await baselineClient.listTools()).tools.some(tool => tool.name === "communication_board"));
  // External channel (including github/non-model host scopes) and explicitly disabled principals cannot be registered for board access
  assert.throws(() => baseline.core.attachBoardEntry({ invoke: () => ({}), principalIds: ["fixture-qq-channel-token"] }), { code: "invalid_config" });
  assert.throws(() => baseline.core.attachBoardEntry({ invoke: () => ({}), principalIds: ["fixture-github-scope-token"] }), { code: "invalid_config" });
  assert.throws(() => baseline.core.attachBoardEntry({ invoke: () => ({}), principalIds: ["fixture-readonly-host-token"] }), { code: "invalid_config" });
  await baseline.close();
  const requests = [];
  const live = await open({ boardPrincipalIndexes: [0, 2], boardInvoke: input => {
    requests.push(input);
    return { items: [{ board_id: "existing-board" }] };
  } });
  const direct = await live.connect(0);
  const shared = await live.connect(0, { shared: true });
  const host = await live.connect(2, { shared: true });
  const notGranted = await live.connect(1);
  const readonlyHost = await live.connect(3, { shared: true });
  const qqChannel = await live.connect(4);
  const githubScope = await live.connect(5, { shared: true });
  for (const allowed of [direct, shared, host]) {
    const definition = (await allowed.listTools()).tools.find(tool => tool.name === "communication_board");
    assert.ok(definition);
    assert.equal(definition.inputSchema.properties.action.enum.length, 13);
    assert.ok(definition.inputSchema.properties.action.enum.includes("subscribe"));
    assert.ok(definition.inputSchema.properties.action.enum.includes("unsubscribe"));
    assert.equal(definition.annotations.destructiveHint, true);
  }
  const input = { caller: short(first), action: "list" };
  for (const client of [notGranted, readonlyHost, qqChannel, githubScope]) {
    assert.ok(!(await client.listTools()).tools.some(tool => tool.name === "communication_board"));
    await expectError(client, "board", input, "invalid_input");
  }
  await expectError(direct, "board", { ...input, caller: short(second) }, "caller_mismatch");
  // Local shared host still blocks impersonating another host or another machine
  const wrongHost = await call(host, "board", { ...input, caller: { host: "antigravity", conversation_id: first.conversation_id } });
  assert.equal(wrongHost.isError, true);
  assert.equal(wrongHost.structuredContent?.error?.code, "caller_mismatch");
  assert.deepEqual(wrongHost.structuredContent?.caller, { host: "antigravity", conversation_id: first.conversation_id });
  const wrongMachine = await call(host, "board", { ...input, caller: { machine_id: "fixture-external-machine", host: first.host, conversation_id: first.conversation_id } });
  assert.equal(wrongMachine.isError, true);
  assert.equal(wrongMachine.structuredContent?.error?.code, "caller_mismatch");
  assert.deepEqual(wrongMachine.structuredContent?.caller, { machine_id: "fixture-external-machine", host: first.host, conversation_id: first.conversation_id });
  await expectError(host, "board", { ...input, caller: { ...short(first), conversation_id: "*" } }, "invalid_input");
  await expectError(direct, "board", { ...input, actorIdentity: second }, "invalid_input");
  assert.equal(requests.length, 0);
  // Pre-existing board alias registered for `first` is usable directly through the local shared host route
  const existingBoard = { machine_id: machine, board_id: "existing-board" };
  live.core.addressBook.saveBoardForIdentity(first, { ...existingBoard, baseTitle: "已有交流板" });
  assert.deepEqual(await ok(direct, "board", input), { items: [{ board_id: "existing-board" }], caller: input.caller });
  assert.deepEqual(await ok(shared, "board", input), { items: [{ board_id: "existing-board" }], caller: input.caller });
  assert.deepEqual(await ok(host, "board", { caller: short(first), action: "read", board: { contact: "已有交流板" } }),
    { items: [{ board_id: "existing-board" }], caller: short(first) });
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0].actorIdentity, first);
  assert.deepEqual(requests[2].actorIdentity, first);
  assert.deepEqual(requests[2].board, existingBoard);
  assert.ok(Object.isFrozen(requests[2].actorIdentity));
});

test("the board tool resolves only the caller's alias and checks each action's address and parameters", async context => {
  const open = await fixture(context);
  const requests = [];
  const live = await open({ boardInvoke: input => {
    requests.push(input);
    return { accepted: true };
  } });
  const owner = await live.connect(0);
  const other = await live.connect(1);
  const address = { machine_id: machine, board_id: "fixture-board" };
  assert.deepEqual(live.core.addressBook.saveBoardForIdentity(first, { ...address, baseTitle: "我的交流板" }),
    { alias_allocated: true, alias: "我的交流板" });
  const board = { contact: "我的交流板" };
  const operation = { caller: short(first), board, action: "subscribe" };
  await expectError(other, "board", { ...operation, caller: short(second) }, "contact_not_found");
  await expectError(owner, "board", { ...operation, board: { contact: "共有" } }, "invalid_input");
  await expectError(owner, "board", { ...operation, board: { ...address, contact: "我的交流板" } }, "invalid_input");
  await expectError(owner, "board", { ...operation, board: { ...address, board_id: "../other" } }, "invalid_input");
  await expectError(owner, "board", { ...operation, action: "delete_archived" }, "invalid_input");
  await expectError(owner, "board", { ...operation, limit: 5 }, "invalid_input");
  assert.equal(requests.length, 0);
  assert.deepEqual(await ok(owner, "board", operation), { accepted: true, caller: operation.caller });
  assert.deepEqual(await ok(owner, "board", { ...operation, action: "unsubscribe", board: { board_id: address.board_id } }),
    { accepted: true, caller: operation.caller });
  assert.deepEqual(requests.map(({ action, board: target }) => ({ action, target })), [
    { action: "subscribe", target: address },
    { action: "unsubscribe", target: address },
  ]);
});

test("a conversation can rename an inherited contact via dedicated or local shared host route without changing defaults or peers", async context => {
  const open = await fixture(context);
  const live = await open();
  const owner = await live.connect(0);
  const other = await live.connect(1);
  const sharedHost = await live.connect(2, { shared: true });
  const readonlyHost = await live.connect(3, { shared: true });
  const qqChannel = await live.connect(4);
  const githubScope = await live.connect(5, { shared: true });
  const input = { caller: short(first), action: "rename", contact: "共有", alias: "我的名字" };
  await expectError(readonlyHost, "contacts", input, "caller_unverified");
  await expectError(qqChannel, "contacts", { ...input, caller: { host: "qq", conversation_id: "fixture-qq-room" } }, "caller_unverified");
  await expectError(githubScope, "contacts", { ...input, caller: { host: "github", conversation_id: "fixture-pr-1" } }, "caller_unverified");
  await expectError(owner, "contacts", { ...input, caller: short(second) }, "caller_mismatch");
  // Local shared host renames directly for `first` and echoes the exact submitted short caller
  const result = await ok(sharedHost, "contacts", input);
  assert.deepEqual(result.caller, input.caller);
  // Dedicated entry and shared host entry see the exact same personal book for `first`
  for (const client of [owner, sharedHost]) {
    const renamed = await ok(client, "contacts", { caller: short(first), action: "get", contact: input.alias });
    assert.equal(renamed.alias, input.alias);
    assert.deepEqual(renamed.target, second);
    assert.equal(renamed.note, "公共备注");
    assert.deepEqual(renamed.caller, short(first));
  }
  for (const [client, caller] of [[other, short(second)], [sharedHost, short(third)], [readonlyHost, short(first)]]) {
    const missing = await call(client, "contacts", { caller, action: "get", contact: input.alias });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent?.error?.code, "contact_not_found");
    assert.deepEqual(missing.structuredContent?.caller, caller);
    const entry = await ok(client, "contacts", { caller, action: "get", contact: "共有" });
    assert.equal(entry.alias, "共有");
    assert.deepEqual(entry.target, second);
  }
});

test("group send through MCP commits per recipient, hides private labels, and uses only one reply event", async context => {
  const open = await fixture(context);
  const service = await open({ enableMultiRecipient: true, autoCompleteOnReply: true });
  const owner = await service.connect(0);
  const secondClient = await service.connect(1);
  const thirdClient = await service.connect(3);
  const definition = (await owner.listTools()).tools.find(tool => tool.name === "communication_send_message");
  assert.equal(definition.inputSchema.properties.targets.maxItems, 16);
  await ok(owner, "contacts", { caller: short(first), action: "save", alias: "第三位", target: third });
  await ok(secondClient, "contacts", { caller: short(second), action: "save", alias: "我这边的名字", target: third, note: "仅本册" });
  const input = { caller: short(first), targets: [second, { contact: "第三位" }, second], text: "发给两位的隔离测试", dedupe_key: "fixture-batch-key" };
  const raw = await call(owner, "send_message", input);
  const batch = raw.structuredContent;
  assert.notEqual(raw.isError, true, JSON.stringify(batch));
  assert.ok(Buffer.byteLength(JSON.stringify(raw), "utf8") < 9216);
  assert.equal(batch.succeeded_count, 0);
  assert.equal(batch.pending_count, 2);
  assert.deepEqual(batch.results.map(row => row.target), [second, third]);
  assert.equal(batch.deduplicated_count, 1);
  const [one, two] = batch.results;
  const secondDelivery = await delivered(owner, input.caller, one.message_id);
  await delivered(owner, input.caller, two.message_id);
  assert.equal(secondDelivery.message.batch_meta.recipient_labels, undefined);
  assert.deepEqual(service.store.getMessage(one.message_id).batch_meta.recipient_labels, ["我这边的名字"]);
  assert.equal(JSON.stringify(raw).includes("仅本册"), false);
  assert.equal(JSON.stringify(raw).includes("我这边的名字"), false);
  await expectError(secondClient, "get_message", { caller: short(second), message_id: two.message_id }, "forbidden");
  const repeated = await ok(owner, "send_message", { ...input, targets: [third, second] });
  assert.equal(repeated.duplicate, true);
  assert.deepEqual(repeated.results.map(row => row.delivery_id), [one.delivery_id, two.delivery_id]);
  await expectError(owner, "send_message", { ...input, text: "此次与原内容不同" }, "dedupe_conflict");
  await expectError(owner, "send_message", { ...input, targets: [second, reserved], dedupe_key: "atomic-denied" }, "forbidden");
  assert.equal(service.core.messageBatches.find(identityKey(first), "atomic-denied"), null);
  assert.equal(service.adapter.calls.length, 2);
  await ok(secondClient, "ack_processing", { caller: short(second), message_id: one.message_id, processing: "done" });
  assert.equal((await ok(owner, "get_message", { caller: input.caller, message_id: two.message_id })).message.processing, "pending");
  const reply = await ok(thirdClient, "send_message", { caller: short(third), targets: [first, second], text: "回复并让另一位看到",
    in_reply_to: two.message_id, dedupe_key: "fixture-batch-reply" });
  const [originalAuthor, copyRecipient] = reply.results;
  assert.equal(service.store.getMessage(originalAuthor.message_id).envelope.in_reply_to, two.message_id);
  assert.equal(service.store.getMessage(copyRecipient.message_id).envelope.in_reply_to, null);
  assert.equal(service.store.getMessage(copyRecipient.message_id).batch_meta.reply_to_message_id, two.message_id);
  assert.equal(service.store.eventsAfter(two.message_id, 0, 100).filter(event => event.kind === "reply").length, 1);
  assert.equal(service.store.eventsAfter(one.message_id, 0, 100).filter(event => event.kind === "reply").length, 0);
  assert.equal((await ok(owner, "get_message", { caller: input.caller, message_id: two.message_id })).message.processing, "done");
});

test("a failed second group insert rolls back the batch, children and dispatch", async context => {
  const open = await fixture(context);
  const service = await open({ enableMultiRecipient: true });
  const owner = await service.connect(0);
  const dynamic = { ...dynamicScope, conversation_id: "fixture-new-dynamic-recipient" };
  await expectError(owner, "send_message", { caller: short(first), targets: [dynamic, reserved], text: "测试无权群发" }, "forbidden");
  await expectError(owner, "send_message", { caller: short(first), targets: [dynamic, external], text: "测试未接入跨机群发" }, "unsupported_op");
  assert.equal(service.store.findBindingByIdentity(identityKey(dynamic)), null);
  const original = service.store.insertDelivery.bind(service.store);
  let inserts = 0;
  service.store.insertDelivery = record => {
    if (++inserts === 2) throw new Error("synthetic second insert failure");
    return original(record);
  };
  const input = { caller: short(first), targets: [second, third], text: "事务内部中断测试", dedupe_key: "fixture-batch-failure" };
  await expectError(owner, "send_message", input, "internal_error");
  const check = new DatabaseSync(service.filePath, { readOnly: true });
  try {
    for (const table of ["message_batches", "messages", "deliveries", "message_events", "conversation_bindings"]) {
      assert.equal(check.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0);
    }
  } finally { check.close(); }
  assert.equal(service.adapter.calls.length, 0);
  service.store.insertDelivery = original;
  const after = await ok(owner, "send_message", input);
  assert.equal(after.results.length, 2);
});

test("sixteen authorized recipients return their full identities and one bounded preview", async context => {
  const open = await fixture(context);
  const extraGroupTargets = Array.from({ length: 14 }, (_, index) => target({ ...first, conversation_id: `fixture-bulk-${index}` }, `bulk-binding-${index}`));
  const service = await open({ enableMultiRecipient: true, extraGroupTargets });
  const owner = await service.connect(0);
  const recipients = [second, third, ...extraGroupTargets.map(({ machine_id, host, surface, conversation_id }) => ({ machine_id, host, surface, conversation_id }))];
  const text = "长篇隔离正文。".repeat(1000);
  const result = await call(owner, "send_message", { caller: short(first), targets: recipients, text, dedupe_key: "fixture-sixteen" });
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 9216);
  const { text_preview, text_truncated, results } = result.structuredContent;
  assert.ok([...text_preview].length <= 200 && text_truncated);
  assert.deepEqual(results.map(entry => entry.target), recipients);
  assert.equal(new Set(results.map(entry => entry.message_id)).size, 16);
  assert.equal(new Set(results.map(entry => entry.delivery_id)).size, 16);
});

test("dedicated and local shared host routes share each caller's personal book; disabled and channel routes stay read-only", async context => {
  const open = await fixture(context);
  const service = await open();
  const primary = await service.connect(0);
  const partner = await service.connect(1);
  const sharedEntry = await service.connect(2);
  const sharedPathForExact = await service.connect(0, { shared: true });
  const readonlyHost = await service.connect(3, { shared: true });
  const qqChannel = await service.connect(4);
  const githubScope = await service.connect(5, { shared: true });
  assert.ok((await primary.listTools()).tools.some(tool => tool.name === "communication_contacts"));
  await ok(primary, "contacts", { caller: short(first), action: "save", alias: "同伴", target: second, note: "我的备注" });
  await ok(sharedEntry, "contacts", { caller: short(first), action: "set_note", contact: "共有", note: "我的共有备注" });
  for (const client of [primary, sharedEntry, sharedPathForExact]) {
    const view = await ok(client, "contacts", { caller: short(first), action: "list" });
    assert.equal(view.contacts.length, 2);
    assert.equal((await ok(client, "contacts", { caller: short(first), action: "get", contact: "共有" })).note, "我的共有备注");
    assert.equal((await ok(client, "contacts", { caller: short(first), action: "get", contact: "同伴" })).note, "我的备注");
  }
  assert.equal((await ok(partner, "contacts", { caller: short(second), action: "list" })).contacts[0].note, "公共备注");
  await expectError(primary, "contacts", { caller: short(second), action: "list" }, "caller_mismatch");
  for (const [restricted, caller] of [
    [readonlyHost, short(first)],
    [qqChannel, { host: "qq", conversation_id: "fixture-qq-room" }],
    [githubScope, { host: "github", conversation_id: "fixture-pr-1" }],
  ]) {
    const view = await ok(restricted, "contacts", { caller, action: "list" });
    assert.deepEqual(view.contacts.map(contact => contact.note), ["公共备注"]);
    await expectError(restricted, "contacts", { caller, action: "get", contact: "同伴" }, "contact_not_found");
    await expectError(restricted, "contacts", { caller, action: "set_note", contact: "共有", note: "拒绝" }, "caller_unverified");
  }
  await ok(sharedEntry, "contacts", { caller: short(first), action: "remove", contact: "共有" });
  assert.equal((await ok(primary, "contacts", { caller: short(first), action: "get", contact: "共有" })).note, "公共备注");
});

test("short send stores a canonical origin and resolved address; receiving the original permits sender collection", async context => {
  const open = await fixture(context);
  const service = await open();
  const primary = await service.connect(0);
  const partner = await service.connect(1);
  const caller = short(first);
  await ok(primary, "contacts", { caller, action: "save", alias: "同伴", target: second });
  await ok(primary, "contacts", { caller, action: "save", alias: "不可发", target: reserved });
  await expectError(primary, "send_message", { caller, target: { contact: "不可发" }, text: "拒绝" }, "forbidden");
  await expectError(primary, "send_message", { caller, target: { contact: "同伴", ...second }, text: "拒绝" }, "invalid_input");
  const sent = await ok(primary, "send_message", { caller, target: { contact: "同伴" }, dedupe_key: "fixture-first-send", text: "隔离发送" });
  assert.equal(sent.resolved_target?.conversation_id, second.conversation_id);
  assert.equal(sent.resolved_target?.via_contact, "同伴");
  assert.deepEqual(sent.message.envelope.caller, first);
  assert.deepEqual(sent.message.envelope.origin, { kind: "agent_message", channel: first.host, source_ref: first.conversation_id });
  const receipt = await delivered(partner, short(second), sent.message.message_id);
  const saved = await ok(partner, "contacts", { caller: short(second), action: "save_sender", message_id: sent.message.message_id, alias: "原信发件人" });
  assert.deepEqual(saved.target, first);
  await expectError(primary, "contacts", { caller, action: "save_sender", message_id: sent.message.message_id, alias: "自己发的信" }, "message_not_recipient");
  await ok(primary, "contacts", { caller, action: "remove", contact: "同伴" });
  const restored = await ok(primary, "get_message", { caller, message_id: sent.message.message_id });
  assert.equal(restored.delivery.delivery_id, receipt.delivery.delivery_id);
  assert.equal(restored.delivery.target_snapshot.conversation_id, second.conversation_id);
});

test("an old ledger keeps its original message, binding and ACK when contact tables are added and reopened", async context => {
  const open = await fixture(context);
  const legacy = await open({ enableContacts: false });
  const legacyPrimary = await legacy.connect(0);
  const legacyPartner = await legacy.connect(1);
  assert.ok(!(await legacyPrimary.listTools()).tools.some(tool => tool.name === "communication_contacts"));
  const old = await ok(legacyPrimary, "send_message", {
    caller: first, origin: { kind: "agent_message", channel: first.host, source_ref: first.conversation_id },
    target: second, text: "旧发送", dedupe_key: "fixture-existing-message",
  });
  const prior = await delivered(legacyPartner, second, old.message.message_id);
  await ok(legacyPartner, "ack_processing", { caller: second, message_id: old.message.message_id, processing: "done",
    delivery_id: prior.delivery.delivery_id, binding_generation: prior.delivery.target_snapshot.binding_generation });
  const before = await ok(legacyPrimary, "get_message", { caller: first, message_id: old.message.message_id });
  await legacy.close();

  const withContacts = await open();
  const primary = await withContacts.connect(0);
  const once = await ok(primary, "get_message", { caller: short(first), message_id: old.message.message_id });
  assert.deepEqual(once, before);
  await ok(primary, "contacts", { caller: short(first), action: "set_note", contact: "共有", note: "重开保留" });
  await withContacts.close();

  const reopened = await open();
  const reader = await reopened.connect(0);
  assert.deepEqual(await ok(reader, "get_message", { caller: first, message_id: old.message.message_id }), before);
  assert.equal((await ok(reader, "contacts", { caller: short(first), action: "get", contact: "共有" })).note, "重开保留");
});

test("a reserved board entry stays out of the conversation directory and cannot be used as a recipient", async context => {
  const open = await fixture(context);
  const service = await open({ sharedEntries: [...sharedContacts, {
    id: "fixture-board-entry", entry_kind: "board", alias: "交流板占位", target: { board_id: "fixture-board-id" },
  }] });
  const client = await service.connect(0);
  const caller = short(first);
  assert.equal((await ok(client, "contacts", { caller, action: "get", contact: "交流板占位" })).entry_kind, "board");
  await expectError(client, "send_message", { caller, target: { contact: "交流板占位" }, text: "不能投给板子" }, "board_not_direct_target");
  const bindings = await ok(client, "list_conversations", { caller });
  assert.ok(bindings.targets.every(entry => entry.conversation_id !== "fixture-board-id"));
});

test("first send opens a book only on commit; rollback, denied caller and retry retain zero or one whole delivery", async context => {
  const open = await fixture(context);
  const runtime = await open();
  const firstContext = { principal_id: principals[0].id };
  const input = { caller: short(first), target: second, dedupe_key: "fixture-atomic-send", text: "同次建册并发信" };
  const rowCounts = () => {
    const database = new DatabaseSync(runtime.filePath, { readOnly: true });
    try {
      return ["caller_books", "messages", "deliveries", "message_events"].map(table =>
        database.prepare("SELECT count(*) AS total FROM " + table).get().total);
    } finally {
      database.close();
    }
  };
  await assert.rejects(runtime.core.sendMessage(firstContext, { ...input, caller: short(reserved) }), { code: "caller_mismatch" });
  assert.deepEqual(rowCounts(), [0, 0, 0, 0]);
  const append = runtime.store.appendEvent.bind(runtime.store);
  runtime.store.appendEvent = (messageId, kind, content) => {
    append(messageId, kind, content);
    throw new Error("fixture abort after persisted message, delivery and event");
  };
  await assert.rejects(runtime.core.sendMessage(firstContext, input), /fixture abort/);
  await runtime.core.drain();
  assert.deepEqual(rowCounts(), [0, 0, 0, 0]);
  await runtime.close();
  const recovered = await open();
  assert.deepEqual(rowCounts(), [0, 0, 0, 0]);
  const sent = await recovered.core.sendMessage(firstContext, input);
  await recovered.core.drain();
  const retry = await recovered.core.sendMessage(firstContext, input);
  assert.equal(retry.duplicate, true);
  assert.equal(sent.message.message_id, retry.message.message_id);
  assert.equal(sent.delivery.delivery_id, retry.delivery.delivery_id);
  assert.equal(retry.delivery.status, "accepted");
  assert.equal(retry.delivery.attempt_count, 1);
  const [books, messages, deliveries, events] = rowCounts();
  assert.deepEqual([books, messages, deliveries], [1, 1, 1]);
  assert.ok(events >= 1);
});

test("real Core ACK and the original reply stage the same remote route without splitting the commit", async context => {
  const open = await fixture(context);
  const runtime = await open({ autoCompleteOnReply: true });
  let messageId;
  const wakes = [];
  const journal = runtime.core.attachRelayAcknowledgements({ onReady: () => wakes.push(runtime.core.result(messageId).message.processing) });
  const source = await runtime.connect(0);
  const receiver = await runtime.connect(1);
  const sent = await ok(source, "send_message", { caller: short(first), target: second, text: "隔离的原跨机请求" });
  messageId = sent.message.message_id;
  await delivered(receiver, short(second), messageId);
  journal.bindInbound({ local_message_id: messageId, origin_relay_id: "fixture-remote-relay",
    origin_message_id: "fixture-original-remote-message", from_machine: first.machine_id, target_key: identityKey(second),
    reply_relay_key: "fixture-original-group", reply_group_id: "fixture-original-group-id", reply_route_generation: 3 });
  const savedStage = journal.stageProcessing.bind(journal);
  journal.stageProcessing = (...args) => {
    savedStage(...args);
    throw new Error("fixture interrupts after writing relay outbox row");
  };
  const receipt = { caller: short(second), message_id: messageId, processing: "processing" };
  const auth = { principal_id: principals[1].id };
  assert.throws(() => runtime.core.ackProcessing(auth, receipt), /fixture interrupts/);
  assert.equal(runtime.core.result(messageId).message.processing, "pending");
  assert.deepEqual(journal.ready(), []);
  assert.deepEqual(wakes, []);
  journal.stageProcessing = savedStage;
  const accepted = runtime.core.ackProcessing(auth, receipt);
  assert.equal(accepted.message.processing, "processing");
  assert.equal(typeof accepted.then, "undefined");
  assert.equal(journal.ready()[0].ack_seq, 1);
  await delay(0);
  assert.deepEqual(wakes, ["processing"]);
  assert.equal(runtime.core.ackProcessing(auth, { ...receipt, processing: "done" }).message.processing, "done");
  await delay(0);
  assert.deepEqual(wakes, ["processing", "done"]);
  assert.deepEqual(journal.ready().map(item => [item.ack_seq, item.processing, item.reply_route_generation]),
    [[1, "processing", 3], [2, "done", 3]]);
  const pending = await ok(source, "send_message", { caller: short(first), target: second, text: "隔离的另一个待处理请求" });
  messageId = pending.message.message_id;
  await delivered(receiver, short(second), messageId);
  journal.bindInbound({ local_message_id: messageId, origin_relay_id: "fixture-further-received-relay",
    origin_message_id: "fixture-further-origin-message", from_machine: first.machine_id, target_key: identityKey(second),
    reply_relay_key: "fixture-original-group", reply_group_id: "fixture-original-group-id", reply_route_generation: 3 });
  await ok(receiver, "send_message", { caller: short(second), target: first, in_reply_to: messageId, text: "按原规则回复待处理原信" });
  await delay(0);
  assert.deepEqual(wakes, ["processing", "done", "done"]);
  assert.deepEqual(journal.ready().filter(item => item.local_message_id === messageId).map(item => [item.ack_seq, item.processing]),
    [[1, "done"]]);
});
