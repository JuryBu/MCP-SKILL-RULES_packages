import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startLiveFromConfig } from "../src/live-runtime.mjs";
import { MockAdapter } from "../src/adapters/mock.mjs";
import { InMemoryRelayBus } from "../src/transports/napcat-relay.mjs";
import * as relayEnvelope from "../src/relay-envelope.mjs";

const machineA = "relay-fixture-a";
const machineB = "relay-fixture-b";
const scope = { host: "antigravity", surface: "desktop" };
const identity = (machine_id, conversation_id) => ({ machine_id, ...scope, conversation_id });
const sender = identity(machineA, "sender");
const otherSender = identity(machineA, "other-sender");
const first = identity(machineB, "first");
const second = identity(machineB, "second");
const route = { relay_key: "relay-fixture", group_id: "relay-group-fixture", route_generation: 1 };
const callAs = who => ({ host: who.host, conversation_id: who.conversation_id });
const token = address => `fixture-token-${address.conversation_id}`;
const binding = address => `fixture-binding-${address.conversation_id}`;

async function lab(context, { bundleEnabled = false, snapshotEnabled = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "core-machine-integration-"));
  const resources = new Set();
  context.after(async () => {
    const cleanup = await Promise.allSettled([...resources].reverse().map(async resource => resource.close()));
    if (cleanup.some(result => result.status === "rejected")) throw new Error("隔离服务未结束");
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const bus = new InMemoryRelayBus({ frameCodec: relayEnvelope });
  bus.registerMachine({ machine_id: machineA, qq_id: "acct-a" });
  bus.registerMachine({ machine_id: machineB, qq_id: "acct-b" });
  bus.registerRoute({ ...route, members: [machineA, machineB], expected_group_name: "Fixture",
    allow_recipient_list_disclosure: true, allow_file_bundle_write: bundleEnabled, legacy_training_coexistence: false });
  const issued = { messages: 0, bundles: 0, replies: 0, snapshots: 0, snapshotBundles: 0, nativeReads: 0,
    loseMessageResult: false, loseProcessingResult: false, processingReceipts: 0, breakInbound: false,
    hideBundleSender: false, holdDelivery: false, held: [], errors: [] };
  async function start(machineId, addresses, peer, legacyStart) {
    const name = machineId === machineA ? "a" : "b";
    const configPath = join(directory, `${name}.json`);
    const addressBook = join(directory, `${name}-contacts.json`);
    await writeFile(addressBook, JSON.stringify({ schema_version: 1, machine_id: machineId, entries: [] }), "utf8");
    const configuredScope = { machine_id: peer.machine_id, ...scope };
    await writeFile(configPath, JSON.stringify({
      adapter_mode: "live_test", port: 0,
      ...(!legacyStart ? { local_machine_id: machineId, multi_recipient_enabled: true, address_book_file: addressBook } : {}),
      allowed_conversation_ids: addresses.map(who => who.conversation_id),
      adapters: [{ id: "fixture-local-adapter", kind: "antigravity" }],
      targets: addresses.map(who => ({ ...who, binding_id: binding(who), binding_generation: 1, adapter_id: "fixture-local-adapter",
        capabilities: { next_model_boundary: true, when_idle: true } })),
      principals: addresses.map(who => ({
        id: `fixture-principal-${who.conversation_id}`, token: token(who), identity: who,
        ...(!legacyStart ? { address_book_identity_bound: true, allowed_target_scopes: [configuredScope], allowed_host_lists: [configuredScope] } : {}),
        allowed_targets: addresses.map(binding),
        ...(machineId === machineA && snapshotEnabled ? { allowed_host_snapshots: [first, second] } : {}),
      })),
    }), "utf8");
    const transport = bus.createTransportFor(machineId, { bundleEnabled });
    const originalSend = transport.sendFrame.bind(transport);
    transport.sendFrame = async (input, opts) => {
      if (input.op === "snapshot_query") issued.snapshots++;
      if (input.op === "message") {
        issued.messages++;
        if (issued.loseMessageResult) {
          await originalSend(input, opts);
          return { status: "unknown" };
        }
      } else if (input.op === "delivery_ack") {
        issued.replies++;
        if (issued.holdDelivery) {
          issued.held.push(() => originalSend(input, opts));
          return { status: "sent_verified" };
        }
      } else if (input.op === "processing_ack") {
        issued.processingReceipts++;
        if (issued.loseProcessingResult) {
          await originalSend(input, opts);
          return { status: "unknown" };
        }
      }
      return originalSend(input, opts);
    };
    const rawEvents = transport.readEvents.bind(transport);
    transport.readEvents = async (...args) => {
      const result = await rawEvents(...args);
      if (machineId !== machineB || !issued.breakInbound) return result;
      return { ...result, events: result.events.map(event => ({ ...event, sender_id: "different-transport-account" })) };
    };
    if (bundleEnabled) {
      const originalBundle = transport.sendBundle.bind(transport);
      transport.sendBundle = async (input, opts) => {
        if (input.op === "message") issued.bundles++;
        if (input.op === "snapshot_reply") issued.snapshotBundles++;
        return originalBundle(input, opts);
      };
      const rawBundleEvents = transport.readBundleEvents.bind(transport);
      transport.readBundleEvents = async (...args) => {
        const result = await rawBundleEvents(...args);
        if (machineId !== machineB || !issued.hideBundleSender) return result;
        return { ...result, events: result.events.map(({ sender_id, ...event }) => event) };
      };
    }
    const adapter = new MockAdapter();
    const stateDir = join(directory, `${name}-state`);
    const service = await (legacyStart ?? startLiveFromConfig)({
      configPath, stateDir,
      factories: { antigravity: () => ({ adapter,
        statusReader: { source: "fixture-host-reader", configured_delivery_modes: { next_model_boundary: true, when_idle: true },
          async getHostStatus() { return { host_online: true, host_can_receive: false }; },
          async describeConversation() { return { conversation_exists: true, conversation_running: false }; } },
        contentProvider: { async list(address, { cursor }) {
          return { conversations: [{ conversation_id: cursor ? "page-two" : "page-one" }], next_cursor: cursor ? null : "x".repeat(512) };
        }, async readRecent(address) {
          issued.nativeReads++;
          return { ...address, status: "idle", workspace: "fixture-private-local-workspace", project_id: "fixture-private-project-id", rounds: [{
            messages: [
              { role: "user", text: "隔离快照的普通问题" },
              { role: "assistant", text: "这句长但可分享的回答。".repeat(150) + "尾句固定。" },
              { role: "external", text: "夹在快照里的隐藏文本", visibility: "hidden" },
              { role: "tool", text: "夹在快照里的工具原件" },
            ],
          }] };
        } },
      }) },
      ...(!legacyStart ? { relay: { transport, peers: [peer], autoPoll: false, onError: error => issued.errors.push(error?.code ?? String(error)) } } : {}),
    });
    resources.add(service);
    return { ...service, adapter, databasePath: join(stateDir, "core.sqlite"),
      async stop() { await service.close(); resources.delete(service); } };
  }
  async function connect(service, who, shared = false) {
    const client = new Client({ name: "relay-core-integration", version: "1.0.0" });
    resources.add(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), {
      requestInit: { headers: { Authorization: `Bearer ${token(who)}`, ...(shared ? { "X-Communication-Core-Shared-Facade": "1" } : {}) } },
    }));
    return client;
  }
  const peerA = { ...route, machine_id: machineB, sender_account: "acct-b", outbound_scopes: [scope], inbound_targets: [sender],
    allow_recipient_lists: true, trust_source_identity: true };
  const peerB = { ...route, machine_id: machineA, sender_account: "acct-a", outbound_scopes: [scope], inbound_targets: [first, second],
    status_targets: [first], directory_scopes: [scope], allow_recipient_lists: true, trust_source_identity: true,
    ...(snapshotEnabled ? { snapshot_permissions: [{ caller: sender, target: first }] } : {}) };
  let active = route;
  const configuredPeer = peer => ({ ...peer, ...active, ...(active === route ? {} : { draining_routes: [route] }) });
  return { issued, getSpoolStats: machineId => bus.getSpoolStats(machineId),
    startA: legacyStart => start(machineA, snapshotEnabled ? [sender, otherSender] : [sender], configuredPeer(peerA), legacyStart),
    startB: legacyStart => start(machineB, [first, second], configuredPeer(peerB), legacyStart), connect,
    rotate() {
      active = { relay_key: "relay-new-fixture", group_id: "relay-group-next-fixture", route_generation: 2 };
      bus.rotateRoute({ from_relay_key: route.relay_key, new_relay_key: active.relay_key, new_group_id: active.group_id, new_generation: 2 });
    } };
}

async function ok(client, tool, args) {
  const result = await client.callTool({ name: `communication_${tool}`, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent;
}
async function pump(source, target, condition) {
  for (let iteration = 0; iteration < 40; iteration++) {
    await target.relayDispatcher.pollOnce();
    await source.relayDispatcher.pollOnce();
    if (condition()) return;
    await delay(10);
  }
  assert.fail("隔离跨机原回执未到");
}

const legacyRoot = process.env.CORE_ISOLATED_LEGACY_FIXTURE_ROOT;
const retreatGuard = process.env.CORE_ISOLATED_LEGACY_FIXTURE_GUARD;
if (legacyRoot && retreatGuard) test("explicit legacy rollback preserves pending relay work and restores an original unforwarded processing receipt", async context => {
  const entry = pathToFileURL(join(legacyRoot, "src", "live-runtime.mjs"));
  assert.equal(createHash("sha256").update(await readFile(entry)).digest("hex"),
    "86c2d089ae0056b4d9d9fc96fd3868ef66c16118c3173d4722a74a42230dc454");
  const { startLiveFromConfig: bootLegacy } = await import(entry);
  const { inspectQuiescentRelayDatabase } = await import(pathToFileURL(retreatGuard));
  const group = (key, body) => ({ caller: callAs(sender), targets: [first, second], text: body, dedupe_key: key });
  const fixture = await lab(context);
  const originalSource = await fixture.startA();
  const originalTarget = await fixture.startB();
  const client = await fixture.connect(originalSource, sender);
  fixture.issued.loseMessageResult = true;
  fixture.issued.holdDelivery = true;
  const sent = await ok(client, "send_message", group("rollback-unknown", "已发原件，请留未知状态"));
  await originalSource.core.dispatchPending();
  assert.equal(fixture.issued.messages, 1);
  assert.ok(sent.results.every(row => originalSource.core.store.getDelivery(row.delivery_id)?.status === "unknown"));
  await originalTarget.relayDispatcher.pollOnce();
  assert.equal(originalTarget.adapter.calls.length, 2);
  const arrivals = new Map(originalTarget.adapter.calls.map(call => {
    const stored = originalTarget.core.store.getMessage(call.message_id);
    return [stored.envelope.target.conversation_id, stored.message_id];
  }));
  fixture.issued.loseProcessingResult = true;
  const firstClient = await fixture.connect(originalTarget, first);
  await ok(firstClient, "ack_processing", { caller: callAs(first), message_id: arrivals.get(first.conversation_id), processing: "done" });
  await originalTarget.relayDispatcher.flushOutbox();
  assert.equal(fixture.issued.processingReceipts, 1);

  originalSource.core.enqueue = async () => {};
  const queued = await ok(client, "send_message", group("rollback-queued", "还未发送，旧版不能接手"));
  await originalSource.stop();
  const blocked = inspectQuiescentRelayDatabase(originalSource.databasePath);
  assert.equal(blocked.can_restore_legacy_queue, false);
  assert.equal(blocked.unsent_relay_deliveries, 2);
  assert.equal(blocked.unknown_relay_deliveries, 2);
  assert.equal(fixture.issued.messages, 1);

  const drainOwner = await fixture.startA();
  await drainOwner.core.dispatchPending();
  assert.equal(fixture.issued.messages, 2);
  assert.ok(queued.results.every(row => drainOwner.core.store.getDelivery(row.delivery_id)?.status === "unknown"));
  await drainOwner.stop();
  await originalTarget.stop();
  assert.equal(inspectQuiescentRelayDatabase(drainOwner.databasePath).can_restore_legacy_queue, true);
  assert.equal(inspectQuiescentRelayDatabase(originalTarget.databasePath).unknown_processing_receipts, 1);

  const oldSource = await fixture.startA(bootLegacy);
  const oldTarget = await fixture.startB(bootLegacy);
  await Promise.all([oldSource.core.dispatchPending(), oldTarget.core.dispatchPending()]);
  for (const row of [...sent.results, ...queued.results]) {
    const old = oldSource.core.store.getDelivery(row.delivery_id);
    assert.equal(old.status, "unknown");
    assert.equal(old.attempt_count, 1);
  }
  const oldSend = await fixture.connect(oldSource, sender);
  const local = await ok(oldSend, "send_message", {
    caller: sender, target: sender, text: "退回期间旧版普通投递",
    origin: { kind: "agent_message", channel: scope.host, source_ref: sender.conversation_id }, dedupe_key: "old-still-delivers",
  });
  await oldSource.core.dispatchPending();
  assert.equal(oldSource.core.store.getDelivery(local.delivery.delivery_id)?.status, "accepted");
  const oldReceive = await fixture.connect(oldTarget, second);
  await ok(oldReceive, "ack_processing", { caller: second, message_id: arrivals.get(second.conversation_id), processing: "done" });
  assert.equal(fixture.issued.processingReceipts, 1);
  await Promise.all([oldSource.stop(), oldTarget.stop()]);
  assert.equal(inspectQuiescentRelayDatabase(oldTarget.databasePath).unknown_processing_receipts, 1);

  fixture.issued.holdDelivery = false;
  fixture.issued.loseProcessingResult = false;
  const restoredSource = await fixture.startA();
  const restoredTarget = await fixture.startB();
  await restoredTarget.relayDispatcher.flushOutbox();
  await pump(restoredSource, restoredTarget, () => sent.results.every(row =>
    restoredSource.core.store.getMessage(row.message_id)?.processing === "done") && queued.results.every(row =>
    restoredSource.core.store.getDelivery(row.delivery_id)?.status === "accepted"));
  assert.equal(restoredTarget.adapter.calls.length, 2);
  assert.equal(fixture.issued.messages, 2);
  assert.equal(fixture.issued.processingReceipts, 2);
  assert.equal(restoredSource.core.store.getDelivery(local.delivery.delivery_id)?.status, "accepted");
});

test("two live MCP cores use one physical group send; each recipient owns the durable local receipt", async context => {
  const fixture = await lab(context);
  const source = await fixture.startA();
  const target = await fixture.startB();
  const sending = await fixture.connect(source, sender);
  const receiving = await fixture.connect(target, first);
  await ok(receiving, "contacts", { caller: callAs(first), action: "save", alias: "我的同伴", note: "仅本册", target: second });
  const request = { caller: callAs(sender), targets: [first, second], text: "跨机同一份隔离正文", dedupe_key: "fixture-live-group" };
  const sent = await ok(sending, "send_message", request);
  assert.equal(sent.results.length, 2);
  assert.equal(sent.succeeded_count, 0);
  await pump(source, target, () => sent.results.every(row => source.core.store.getDelivery(row.delivery_id)?.status === "accepted"));
  assert.equal(fixture.issued.messages, 1);
  assert.equal(fixture.issued.replies, 1);
  assert.equal(target.adapter.calls.length, 2);
  const local = target.adapter.calls.map(call => target.core.store.getMessage(call.message_id));
  const recipient = local.find(message => message.envelope.target.conversation_id === first.conversation_id);
  assert.equal(recipient.envelope.caller.machine_id, machineA);
  assert.equal(recipient.source_identity_verified, true);
  assert.deepEqual(recipient.batch_meta.recipient_labels, ["我的同伴"]);
  await ok(receiving, "contacts", { caller: callAs(first), action: "save_sender", message_id: recipient.message_id, alias: "远端发件人" });

  await ok(receiving, "ack_processing", { caller: callAs(first), message_id: recipient.message_id, processing: "done" });
  await pump(source, target, () => source.core.store.getMessage(sent.results[0].message_id)?.processing === "done");
  assert.equal(source.core.store.getMessage(sent.results[1].message_id)?.processing, "pending");
  const replay = await ok(sending, "send_message", { ...request, targets: [second, first] });
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.results.map(row => row.delivery_id), sent.results.map(row => row.delivery_id));
  assert.equal(fixture.issued.messages, 1);
});

test("a long shared message waits for the original file sender and is taken over once for both recipients", async context => {
  const fixture = await lab(context, { bundleEnabled: true });
  const source = await fixture.startA();
  const target = await fixture.startB();
  const sending = await fixture.connect(source, sender);
  const text = "这是整段长正文，用于逐字验收。\n".repeat(420) + "完整结尾。";
  const input = { caller: callAs(sender), targets: [first, second], text, dedupe_key: "fixture-live-bundle" };
  fixture.issued.hideBundleSender = true;
  const sent = await ok(sending, "send_message", input);
  await pump(source, target, () => fixture.getSpoolStats(machineB).incomingCount === 1);
  assert.equal(fixture.issued.bundles, 1);
  assert.equal(fixture.issued.messages, 0);
  assert.equal(target.adapter.calls.length, 0);
  assert.equal(fixture.getSpoolStats(machineA).outgoingCount, 1);

  fixture.issued.hideBundleSender = false;
  await pump(source, target, () => sent.results.every(row => source.core.store.getDelivery(row.delivery_id)?.status === "accepted"));
  assert.equal(target.adapter.calls.length, 2);
  for (const call of target.adapter.calls) {
    const delivered = target.core.store.getMessage(call.message_id);
    const recipient = delivered.envelope.target.conversation_id === first.conversation_id ? first : second;
    assert.equal(delivered.envelope.text, text);
    assert.equal(delivered.source_identity_verified, true);
    const receiving = await fixture.connect(target, recipient);
    await ok(receiving, "ack_processing", { caller: callAs(recipient), message_id: call.message_id, processing: "done" });
  }
  await pump(source, target, () => sent.results.every(row => source.core.store.getMessage(row.message_id)?.processing === "done"));
  assert.equal((await ok(sending, "send_message", input)).duplicate, true);
  assert.equal(fixture.issued.bundles, 1);
  assert.equal(fixture.getSpoolStats(machineA).outgoingCount, 0);
  assert.equal(fixture.getSpoolStats(machineB).incomingCount, 0);
});

test("remote snapshot reads require the two exact conversations and return only public snapshot fields via the bundle", async context => {
  const fixture = await lab(context, { bundleEnabled: true, snapshotEnabled: true });
  const source = await fixture.startA();
  const target = await fixture.startB();
  const primary = await fixture.connect(source, sender);
  const other = await fixture.connect(source, otherSender);
  const shared = await fixture.connect(source, sender, true);
  const read = (client, caller, to) => client.callTool({ name: "communication_read_recent_snapshot",
    arguments: { caller: callAs(caller), target: to, last_rounds: 1 } });
  const throughRelay = async request => {
    let finished = false;
    const tracked = request.finally(() => { finished = true; });
    tracked.catch(() => {});
    await pump(source, target, () => finished);
    return tracked;
  };
  const noOwner = await read(shared, sender, first);
  assert.equal(noOwner.isError, true);
  assert.equal(fixture.issued.snapshots, 0);
  const deniedTarget = await throughRelay(read(primary, sender, second));
  assert.equal(deniedTarget.isError, true);
  assert.match(JSON.stringify(deniedTarget), /forbidden/);
  const deniedSource = await throughRelay(read(other, otherSender, first));
  assert.equal(deniedSource.isError, true);
  assert.match(JSON.stringify(deniedSource), /forbidden/);
  assert.equal(fixture.issued.nativeReads, 0);

  const allowed = await throughRelay(read(primary, sender, first));
  const projected = JSON.stringify(allowed);
  assert.notEqual(allowed.isError, true, projected);
  assert.equal(allowed.structuredContent.target.conversation_id, first.conversation_id);
  const markdown = allowed.content[0].text;
  assert.match(markdown, /隔离快照的普通问题/);
  assert.match(markdown, /尾句固定/);
  assert.doesNotMatch(projected, /隐藏文本|工具原件|fixture-private-/);
  assert.equal(fixture.issued.nativeReads, 1);
  assert.equal(fixture.issued.snapshotBundles, 1);
});

test("a remote reply-all references only the original sender and refuses a different recipient quoting the same message", async context => {
  const fixture = await lab(context);
  const source = await fixture.startA();
  const target = await fixture.startB();
  const client = await fixture.connect(source, sender);
  const recipient = await fixture.connect(target, first);
  const secondRecipient = await fixture.connect(target, second);
  const original = await ok(client, "send_message", { caller: callAs(sender), targets: [first, second],
    text: "请两位收件后回复", dedupe_key: "remote-original-reply-all" });
  await pump(source, target, () => original.results.every(row => source.core.store.getDelivery(row.delivery_id)?.status === "accepted"));
  const localChild = target.adapter.calls.find(call => target.core.store.getMessage(call.message_id).envelope.target.conversation_id === first.conversation_id);
  const foreign = await secondRecipient.callTool({ name: "communication_send_message",
    arguments: { caller: callAs(second), target: sender, text: "未获授权引用", in_reply_to: localChild.message_id } });
  assert.equal(foreign.isError, true);
  assert.match(JSON.stringify(foreign), /invalid_reply/);
  assert.equal(fixture.issued.messages, 1);
  const answer = await ok(recipient, "send_message", { caller: callAs(first), targets: [sender, second],
    text: "这条引用另抄送第二位", in_reply_to: localChild.message_id, dedupe_key: "remote-reply-all-valid" });
  await pump(target, source, () => source.adapter.calls.length === 1 && answer.results.every(row =>
    target.core.store.getDelivery(row.delivery_id)?.status === "accepted"));
  assert.equal(fixture.issued.messages, 2);
  const originalCallerChild = original.results.find(row => source.core.store.getMessage(row.message_id).envelope.target.conversation_id === first.conversation_id);
  const reply = source.core.store.getMessage(source.adapter.calls[0].message_id);
  assert.equal(reply.envelope.in_reply_to, originalCallerChild.message_id);
  assert.equal(reply.envelope.text, "这条引用另抄送第二位");
  const copied = answer.results.find(row => target.core.store.getMessage(row.message_id).envelope.target.conversation_id === second.conversation_id);
  assert.equal(target.core.store.getMessage(copied.message_id).envelope.in_reply_to, null);
  assert.equal(original.results.filter(row => source.core.store.getMessage(row.message_id).processing === "done").length, 1);
  await target.stop();
  fixture.rotate();
  const moved = await fixture.startB();
  const movedClient = await fixture.connect(moved, first);
  const clipped = await movedClient.callTool({ name: "communication_send_message", arguments:
    { caller: callAs(first), target: sender, text: "不把引用改投新群", in_reply_to: localChild.message_id } });
  assert.equal(clipped.isError, true);
  assert.match(JSON.stringify(clipped), /relay_route_changed/);
  assert.equal(fixture.issued.messages, 2);
});

test("shared status and directory calls reach the authorized other machine and only its observed states", async context => {
  const fixture = await lab(context);
  const source = await fixture.startA();
  const target = await fixture.startB();
  const client = await fixture.connect(source, sender);
  async function remote(callback) {
    let complete = false;
    const request = callback().finally(() => { complete = true; });
    request.catch(() => {});
    await pump(source, target, () => complete);
    return request;
  }
  const status = await remote(() => ok(client, "get_status", { caller: callAs(sender), ...first }));
  assert.equal(status.source, "remote_core_relay");
  assert.equal(status.host_online, true);
  assert.equal(status.can_deliver, false);
  assert.equal(status.transport_ready, "unknown");
  const forbidden = await remote(() => ok(client, "get_status", { caller: callAs(sender), ...second }));
  assert.equal(forbidden.code, "forbidden");
  assert.equal(forbidden.host_online, "unknown");
  const search = { caller: callAs(sender), machine_id: machineB, ...scope, scope: "host", limit: 1 };
  const page = await remote(() => ok(client, "list_conversations", search));
  assert.equal(page.conversations[0].conversation_id, "page-one");
  assert.ok(page.next_cursor.length <= 1024);
  const next = await remote(() => ok(client, "list_conversations", { ...search, cursor: page.next_cursor }));
  assert.equal(next.conversations[0].conversation_id, "page-two");
  assert.equal(next.has_more, false);
});

test("an unknown physical send is not repeated when the whole source node reopens", async context => {
  const fixture = await lab(context);
  const source = await fixture.startA();
  fixture.issued.loseMessageResult = true;
  const client = await fixture.connect(source, sender);
  const input = { caller: callAs(sender), target: first, text: "隔离发送结果未知", dedupe_key: "fixture-unknown-before-reopen" };
  const sent = await ok(client, "send_message", input);
  for (let index = 0; index < 35 && source.core.store.getDelivery(sent.delivery.delivery_id)?.status !== "unknown"; index++) await delay(15);
  assert.equal(source.core.store.getDelivery(sent.delivery.delivery_id)?.status, "unknown");
  await source.stop();
  fixture.issued.loseMessageResult = false;
  const reopened = await fixture.startA();
  const reconnected = await fixture.connect(reopened, sender);
  const read = await ok(reconnected, "get_message", { caller: callAs(sender), message_id: sent.message.message_id });
  assert.equal(read.delivery.status, "unknown");
  assert.equal(read.delivery.attempt_count, 1);
  assert.equal((await ok(reconnected, "send_message", input)).duplicate, true);
  await reopened.core.dispatchPending();
  assert.equal(fixture.issued.messages, 1);
  assert.deepEqual(read.remote_delivery, { relay_stage: "unknown", target_core: "unknown", target_host: "unknown" });
  const receiver = await fixture.startB();
  await pump(reopened, receiver, () => reopened.core.store.getDelivery(sent.delivery.delivery_id).status === "accepted");
  assert.equal(fixture.issued.messages, 1);
  assert.equal(receiver.adapter.calls.length, 1);
});

test("after restart and route rotation, early processing still binds to the old receipt and new send takes the new route", async context => {
  const fixture = await lab(context);
  const originalSource = await fixture.startA();
  const target = await fixture.startB();
  const send = await fixture.connect(originalSource, sender);
  const receive = await fixture.connect(target, first);
  fixture.issued.holdDelivery = true;
  const sent = await ok(send, "send_message", { caller: callAs(sender), target: first, text: "确认先到", dedupe_key: "fixture-processing-first" });
  await pump(originalSource, target, () => fixture.issued.held.length === 1);
  assert.equal(target.adapter.calls.length, 1);
  const messageId = target.adapter.calls[0].message_id;
  await originalSource.stop();
  fixture.rotate();
  const reopened = await fixture.startA();
  const reconnected = await fixture.connect(reopened, sender);
  await ok(receive, "ack_processing", { caller: callAs(first), message_id: messageId, processing: "done" });
  await target.relayDispatcher.flushOutbox();
  await pump(reopened, target, () => reopened.core.store.getMessage(sent.message.message_id).processing === "done");
  const before = await ok(reconnected, "get_message", { caller: callAs(sender), message_id: sent.message.message_id });
  assert.equal(before.delivery.status, "accepted");
  assert.deepEqual(before.remote_delivery, { relay_stage: "accepted", target_core: "accepted", target_host: "accepted" });
  fixture.issued.holdDelivery = false;
  await fixture.issued.held.shift()();
  await reopened.relayDispatcher.pollOnce();
  const after = await ok(reconnected, "get_message", { caller: callAs(sender), message_id: sent.message.message_id });
  assert.equal(after.message.processing, "done");
  assert.equal(after.delivery.delivery_id, before.delivery.delivery_id);
  assert.equal(fixture.issued.messages, 1);
  await target.stop();
  const nextTarget = await fixture.startB();
  const newSign = await ok(reconnected, "send_message", { caller: callAs(sender), target: first, text: "走新中继", dedupe_key: "fixture-next-relay" });
  await pump(reopened, nextTarget, () => reopened.core.store.getDelivery(newSign.delivery.delivery_id).status === "accepted");
  assert.equal(nextTarget.adapter.calls.length, 1);
  assert.equal(fixture.issued.messages, 2);
});

test("the relay account check drops only the unverified event and the next trusted message is accepted", async context => {
  const fixture = await lab(context);
  const source = await fixture.startA();
  const target = await fixture.startB();
  const client = await fixture.connect(source, sender);
  const args = { caller: callAs(sender), target: first, text: "账号校验对照" };
  fixture.issued.breakInbound = true;
  const denied = await ok(client, "send_message", { ...args, dedupe_key: "fixture-wrong-account" });
  await pump(source, target, () => fixture.issued.messages === 1 && source.core.store.getDelivery(denied.delivery.delivery_id).status === "unknown");
  assert.equal(target.adapter.calls.length, 0);
  fixture.issued.breakInbound = false;
  const allowed = await ok(client, "send_message", { ...args, dedupe_key: "fixture-current-account" });
  await pump(source, target, () => source.core.store.getDelivery(allowed.delivery.delivery_id).status === "accepted");
  assert.equal(target.adapter.calls.length, 1);
  assert.equal(source.core.store.getDelivery(denied.delivery.delivery_id).status, "unknown");
});

test("an authenticated peer may send only to its allowed recipients; denial is distinct and does not block the next message", async context => {
  const fixture = await lab(context);
  const source = await fixture.startA();
  const target = await fixture.startB();
  const client = await fixture.connect(source, sender, true);
  const receiving = await fixture.connect(target, first);
  const args = { caller: callAs(sender), text: "独立授权对照" };
  const denied = await ok(client, "send_message", { ...args, target: identity(machineB, "not-authorized"), dedupe_key: "fixture-no-inbound-grant" });
  await pump(source, target, () => source.core.result(denied.message.message_id).remote_delivery.target_core === "rejected");
  assert.equal(target.adapter.calls.length, 0);
  const rejected = await ok(client, "get_message", { caller: args.caller, message_id: denied.message.message_id });
  assert.deepEqual(rejected.remote_delivery, { relay_stage: "accepted", target_core: "rejected", target_host: "unknown", code: "forbidden" });
  const allowed = await ok(client, "send_message", { ...args, target: first, dedupe_key: "fixture-allowed-shared-caller" });
  await pump(source, target, () => source.core.store.getDelivery(allowed.delivery.delivery_id).status === "accepted");
  assert.equal(target.adapter.calls.length, 1);
  const original = target.core.store.getMessage(target.adapter.calls[0].message_id);
  assert.notEqual(original.source_identity_verified, true);
  const blocked = await receiving.callTool({ name: "communication_contacts", arguments: {
    caller: callAs(first), action: "save_sender", message_id: original.message_id, alias: "不能收录" } });
  assert.equal(blocked.structuredContent.error.code, "message_not_recipient");
});
