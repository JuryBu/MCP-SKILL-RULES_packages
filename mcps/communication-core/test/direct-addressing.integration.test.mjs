import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CommunicationCore } from "../src/core.mjs";
import { identityKey } from "../src/contracts.mjs";
import { MessageStore } from "../src/store.mjs";
import { createMcpHttpServer } from "../src/mcp-server.mjs";
import { createMcpStdioFacade } from "../src/mcp-stdio-facade.mjs";
import { planOwnerReplyForward } from "../src/reply-forwarding.mjs";
import { loadCodexStatusSource } from "../src/codex-source-recovery.mjs";
import { createCodexStatusReader, HostStatusProvider } from "../src/host-status.mjs";

const machineId = "synthetic-direct-addressing-machine";
const capabilities = { next_model_boundary: true, when_idle: true };
const identity = (conversationId, host = "codex") => ({ machine_id: machineId, host, surface: "desktop", conversation_id: conversationId });
const callers = ["A", "B", "C"].map(name => identity(`synthetic-fresh-${name}`));
const [callerA, callerB, callerC] = callers;
const agCaller = identity("synthetic-fresh-AG", "antigravity");
const address = target => ({ host: target.host, surface: target.surface, conversation_id: target.conversation_id });
const boundAddress = target => ({ ...address(target), machine_id: target.machine_id, binding_id: target.binding_id, binding_generation: target.binding_generation });
const owner = {
  machine_id: machineId, host: "qq", surface: "group", conversation_id: "synthetic-owner-window",
  binding_id: "synthetic-owner-binding", binding_generation: 3, adapter_id: "synthetic-qq",
  capabilities, evidence: "synthetic-receipt-provider",
};

function sendInput(caller, target, dedupeKey = "synthetic-shared-dedupe", extra = {}) {
  return {
    origin: { kind: "agent_message", channel: "synthetic-integration", source_ref: `synthetic:${caller.conversation_id}` },
    target: address(target), dedupe_key: dedupeKey, text: "隔离测试原文",
    expires_at: "2031-01-01T00:00:00.000Z", ...extra,
  };
}

function resultContent(response) {
  assert.notEqual(response.isError, true, JSON.stringify(response.structuredContent));
  assert.ok(response.structuredContent);
  return response.structuredContent;
}

function expectFailure(response, code) {
  assert.equal(response.isError, true, JSON.stringify(response.structuredContent));
  assert.equal(response.structuredContent?.error?.code, code);
}

async function fixture(context, { legacy = false, legacyCollision = false, scoped = true, routes = true, statusProvider } = {}) {
  const root = mkdtempSync(join(tmpdir(), "communication-direct-addressing-隔离 test-"));
  const filePath = join(root, "旧消息与目录.sqlite");
  let clock = Date.now();
  const modes = new Map();
  const queryModes = new Map();
  const calls = { deliveries: [], queries: [], qq: [], observations: [] };
  const scopeFor = host => ({ machine_id: machineId, host, surface: "desktop" });
  const scopedPrincipals = ["codex", "antigravity"].map(host => ({
    id: `synthetic-${host}-host`, token: `synthetic-${host}-host-token`,
    identity: { ...scopeFor(host), conversation_id: "*" }, caller_scope: scopeFor(host),
    allowed_target_scopes: [scopeFor("codex"), scopeFor("antigravity")],
    allowed_targets: [owner.binding_id], origin_kinds: ["agent_message"],
  }));
  const legacySource = legacyCollision ? callerA : identity("synthetic-legacy-source");
  const legacyReceiver = identity("synthetic-legacy-receiver");
  const legacyReturn = { ...legacySource, binding_id: "synthetic-legacy-return", binding_generation: 4, adapter_id: "synthetic-codex", capabilities, evidence: "synthetic-legacy-binding" };
  const legacyTarget = { ...legacyReceiver, binding_id: "synthetic-legacy-target", binding_generation: 5, adapter_id: "synthetic-codex", capabilities, evidence: "synthetic-legacy-binding" };
  const legacyPrincipal = { id: "synthetic-legacy-source", token: "synthetic-legacy-source-token", identity: legacySource, allowed_targets: [owner.binding_id, legacyTarget.binding_id], origin_kinds: ["agent_message"] };
  const legacyReceiverPrincipal = { id: "synthetic-legacy-receiver", token: "synthetic-legacy-receiver-token", identity: legacyReceiver, allowed_targets: [legacyReturn.binding_id], origin_kinds: ["agent_message"] };
  const targets = legacy ? [structuredClone(owner), legacyReturn, legacyTarget] : [structuredClone(owner)];
  const legacyRules = legacy ? [{ id: "synthetic-legacy-forward", source_principal_id: legacyPrincipal.id,
    from_binding_id: owner.binding_id, to_binding_id: legacyReturn.binding_id, ttl_ms: 60000, owner_sender_allowlist: ["90001"] }] : [];
  let scopedEnabled = scoped;
  let repliesEnabled = false;
  let replyPatch = reply => reply;
  let currentRoute = { route_key: "synthetic-owner-events", conversation_id: "synthetic-old-reader-CID", target_key: owner.conversation_id, generation: 7 };
  const hostAdapter = {
    async deliver({ message, delivery, target, signal }) {
      assert.equal(signal.aborted, false);
      const outcome = modes.get(target.conversation_id) ?? "accepted";
      calls.deliveries.push(structuredClone({ message, delivery, target, outcome }));
      return { delivery_id: delivery.delivery_id, target_key: identityKey(target), outcome,
        evidence: { kind: outcome === "busy" ? "query" : "transport", ...(outcome === "busy" ? { retry_after_ms: 100 } : {}) } };
    },
    async query({ message, delivery, target }) {
      calls.queries.push(structuredClone({ message, delivery, target }));
      return { delivery_id: delivery.delivery_id, target_key: identityKey(target), outcome: queryModes.get(target.conversation_id) ?? "accepted", evidence: { kind: "query" } };
    },
  };
  const qqAdapter = {
    async deliver({ message, delivery, target }) {
      const nativeId = String(81001 + calls.qq.length);
      const route = structuredClone(currentRoute);
      calls.qq.push(structuredClone({ message, delivery, target, nativeId, route }));
      return { delivery_id: delivery.delivery_id, target_key: identityKey(target), outcome: "accepted", evidence: {
        kind: "receipt", native_receipt: { provider: "napcat_owner", message_id: nativeId,
          verified: true, state_persisted: true, reply_route: route },
      } };
    },
    async observeReply({ message, delivery, target }) {
      if (!repliesEnabled) return null;
      const receipt = delivery.evidence.evidence.native_receipt;
      calls.observations.push(structuredClone({ message_id: message.message_id, receipt }));
      const nativeId = String(Number(receipt.message_id) + 1000);
      const step = Number(receipt.message_id);
      return replyPatch({ native_message_id: nativeId, native_conversation_id: target.conversation_id,
        source_step_index: step, text: `引用原通知的回信：${message.envelope.caller.conversation_id}`,
        native_source: { provider: "napcat_owner", route: structuredClone(receipt.reply_route), original_qq_message_id: receipt.message_id,
          event: { event_id: `synthetic-owner-event:${nativeId}`, message_id: nativeId, message_seq: step,
            quoted_message_id: receipt.message_id, sender_id: "90001" } } }, message);
    },
  };
  const adapters = { "synthetic-codex": hostAdapter, "synthetic-antigravity": hostAdapter, "synthetic-qq": qqAdapter };
  let store;
  let core;
  let service;
  const clients = new Map();
  const facadeResources = [];
  const principals = () => [...(scopedEnabled ? scopedPrincipals : []), ...(legacy ? [legacyPrincipal, legacyReceiverPrincipal] : [])];
  const defaultPrincipal = caller => {
    const selected = scopedPrincipals.find(principal => principal.identity.host === caller.host);
    assert.ok(selected, "fixture requires an explicit synthetic host principal");
    return selected;
  };
  async function stopNetwork() {
    for (const { client, facade } of facadeResources.splice(0)) { await client.close(); await facade.close(); }
    for (const client of clients.values()) await client.close();
    clients.clear();
    if (service) { await service.close(); service = null; }
  }
  async function open() {
    store = new MessageStore({ filePath });
    core = new CommunicationCore({ store, targets, principals: principals(), adapters, replyForwarding: legacyRules,
      conversationRoutes: scopedEnabled && routes ? ["codex", "antigravity"].map(host => ({ ...scopeFor(host), adapter_id: `synthetic-${host}`, capabilities })) : [],
      automaticReplyForwarding: [{ binding_id: owner.binding_id, owner_sender_allowlist: ["90001"], ttl_ms: 60000 }],
      statusProvider, now: () => clock });
    await core.start();
    await core.drain();
  }
  async function httpService() {
    if (!service) service = await createMcpHttpServer({ core, principals: principals() });
    return service;
  }
  async function clientFor(principal) {
    if (!clients.has(principal.id)) {
      const client = new Client({ name: "synthetic-direct-addressing-client", version: "1" });
      clients.set(principal.id, client);
      const endpoint = await httpService();
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${principal.token}` } } }));
    }
    return clients.get(principal.id);
  }
  async function raw(caller, method, fields = {}, principal = defaultPrincipal(caller)) {
    return (await clientFor(principal)).callTool({ name: `communication_${method}`, arguments: { caller, ...fields } });
  }
  context.after(async () => {
    try { await stopNetwork(); await core?.close(); } finally {
      store?.close();
      await rm(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false, `synthetic fixture cleanup failed: ${root}`);
    }
  });
  await open();
  return {
    root, filePath, calls, modes, queryModes, targets, scopedPrincipals, legacyPrincipal, legacyReceiverPrincipal, legacySource, legacyReceiver, legacyReturn, legacyTarget,
    get core() { return core; }, get store() { return store; },
    raw,
    async call(caller, method, fields = {}, principal) { return resultContent(await raw(caller, method, fields, principal)); },
    async send(caller, target, dedupeKey, extra, principal) { return resultContent(await raw(caller, "send_message", sendInput(caller, target, dedupeKey, extra), principal)); },
    advance(milliseconds) { clock += milliseconds; },
    enableReplies(patch = reply => reply) { repliesEnabled = true; replyPatch = patch; },
    setRoute(route) { currentRoute = structuredClone(route); },
    setAdapterEnabled(host, enabled) { if (enabled) adapters[`synthetic-${host}`] = hostAdapter; else delete adapters[`synthetic-${host}`]; },
    snapshots() { return store.listDeliveries({ limit: 100 }).map(delivery => core.result(delivery.message_id)); },
    async reopen(options = {}) {
      await stopNetwork(); await core.close(); store.close();
      scopedEnabled = options.scoped ?? scopedEnabled;
      await open();
    },
    async facadeClient({ legacyFirst = true } = {}) {
      const endpoint = await httpService();
      const endpointFile = join(root, "synthetic.endpoint.json");
      writeFileSync(endpointFile, JSON.stringify({ version: 1, state: "listening", owner_id: "synthetic-direct-addressing-owner", pid: process.pid,
        config_path: join(root, "synthetic.config.json"), state_dir: root, endpoint_file: endpointFile,
        started_at: new Date(clock).toISOString(), url: endpoint.url }), "utf8");
      const entries = legacyFirst ? principals().toReversed() : principals();
      const connections = entries.map((principal, index) => {
        const connectionFile = join(root, `synthetic-profile-${facadeResources.length}-${index}.json`);
        writeFileSync(connectionFile, JSON.stringify({ endpoint_file: endpointFile, identity: principal.identity, token: principal.token,
          ...(principal.caller_scope ? { caller_scope: principal.caller_scope } : {}) }), "utf8");
        return { connection_file: connectionFile };
      });
      const registryFile = join(root, `synthetic-registry-${facadeResources.length}.json`);
      writeFileSync(registryFile, JSON.stringify({ version: 1, connections }), "utf8");
      const facade = await createMcpStdioFacade({ registryFile });
      const client = new Client({ name: "synthetic-in-memory-facade-client", version: "1" });
      facadeResources.push({ facade, client });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await facade.connect(serverTransport);
      await client.connect(clientTransport);
      return client;
    },
  };
}

test("fresh A/B/C use one host principal and host+CID through MCP, with concrete-source dedupe and isolated reads/ACKs", async context => {
  const state = await fixture(context);
  assert.deepEqual(state.store.listBindings(), []);
  assert.equal(state.targets.some(target => callers.some(caller => identityKey(caller) === identityKey(target))), false);
  const pairs = [[callerA, callerB, callerC], [callerB, callerC, callerA], [callerC, callerA, callerB]];
  const sent = [];
  for (const [source, target] of pairs) {
    const resolved = await state.call(source, "resolve_target", address(target));
    assert.equal(identityKey(resolved.target), identityKey(target));
    assert.equal(resolved.target.binding_generation, 1);
    sent.push(await state.send(source, target));
  }
  await state.core.drain();
  assert.equal(new Set(sent.map(snapshot => snapshot.message.message_id)).size, 3);
  assert.equal(new Set(sent.map(snapshot => snapshot.delivery.delivery_id)).size, 3);
  for (const [index, [source, target, stranger]] of pairs.entries()) {
    const original = sent[index];
    const sourceView = await state.call(source, "get_message", { message_id: original.message.message_id });
    const receiverView = await state.call(target, "get_message", { message_id: original.message.message_id });
    assert.equal(sourceView.delivery.status, "accepted");
    assert.deepEqual(receiverView.message, sourceView.message);
    assert.equal(sourceView.message.principal_id, state.scopedPrincipals[0].id);
    assert.equal(sourceView.message.source_key, identityKey(source));
    assert.equal(sourceView.message.target_key, identityKey(target));
    assert.deepEqual(sourceView.message.envelope.caller, source);
    const duplicate = await state.send(source, target);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.message.message_id, original.message.message_id);
    assert.equal(duplicate.delivery.delivery_id, original.delivery.delivery_id);
    expectFailure(await state.raw(source, "send_message", sendInput(source, target, undefined, { text: "changed payload" })), "dedupe_conflict");
    for (const method of ["get_message", "wait", "ack_processing"]) {
      const fields = method === "ack_processing" ? { message_id: original.message.message_id, delivery_id: original.delivery.delivery_id,
        binding_generation: original.message.envelope.target.binding_generation, processing: "done" } : { message_id: original.message.message_id };
      expectFailure(await state.raw(stranger, method, fields), "forbidden");
    }
    const ack = { message_id: original.message.message_id, delivery_id: original.delivery.delivery_id,
      binding_generation: original.message.envelope.target.binding_generation, processing: "done" };
    expectFailure(await state.raw(source, "ack_processing", ack), "forbidden");
    expectFailure(await state.raw(target, "ack_processing", { ...ack, delivery_id: sent[(index + 1) % sent.length].delivery.delivery_id }), "delivery_mismatch");
    expectFailure(await state.raw(target, "ack_processing", { ...ack, binding_generation: ack.binding_generation + 1 }), "binding_changed");
    assert.equal(state.core.result(original.message.message_id).message.processing, "pending");
    const confirmed = await state.call(target, "ack_processing", ack);
    assert.equal(confirmed.message.processing, "done");
    assert.equal((await state.call(target, "ack_processing", ack)).duplicate, true);
  }
  assert.equal(state.calls.deliveries.length, 3);
});

test("MCP defaults remain next_model_boundary+hidden, explicit when_idle/visible survive unchanged, and host identity is part of the address", async context => {
  const state = await fixture(context);
  const byDefault = await state.send(callerA, callerB, "synthetic-defaults");
  const deferred = await state.send(callerB, callerA, "synthetic-explicit-idle", { delivery_policy: "when_idle", message_visibility: "visible" });
  const crossHost = await state.send(callerC, agCaller, "synthetic-cross-host");
  const sameCidOtherHost = await state.send(agCaller, { ...callerB, host: "antigravity" }, "synthetic-same-cid-other-host");
  await state.core.drain();
  assert.equal(byDefault.message.envelope.delivery_policy, "next_model_boundary");
  assert.equal(byDefault.message.envelope.message_visibility, "hidden");
  assert.equal(deferred.message.envelope.delivery_policy, "when_idle");
  assert.equal(deferred.message.envelope.message_visibility, "visible");
  assert.equal(Object.hasOwn(crossHost.message.envelope, "message_visibility"), false);
  assert.notEqual(sameCidOtherHost.message.target_key, byDefault.message.target_key);
  assert.notEqual(sameCidOtherHost.message.envelope.target.binding_id, byDefault.message.envelope.target.binding_id);
  for (const snapshot of [byDefault, deferred, crossHost, sameCidOtherHost]) {
    const invocation = state.calls.deliveries.find(call => call.message.message_id === snapshot.message.message_id);
    assert.ok(invocation);
    assert.deepEqual(invocation.message.envelope, snapshot.message.envelope);
    assert.equal(invocation.delivery.delivery_id, snapshot.delivery.delivery_id);
    assert.equal(state.core.result(snapshot.message.message_id).delivery.status, "accepted");
  }
});

test("host scope enforces machine/host/surface and target scope without publishing a forbidden target binding", async context => {
  const state = await fixture(context);
  for (const [field, value] of [["machine_id", "synthetic-other-machine"], ["host", "antigravity"], ["surface", "synthetic-other-surface"]]) {
    expectFailure(await state.raw({ ...callerA, [field]: value }, "resolve_target", address(callerB), state.scopedPrincipals[0]), "caller_mismatch");
  }
  expectFailure(await state.raw({ ...callerA, conversation_id: "*" }, "resolve_target", address(callerB)), "invalid_input");
  state.scopedPrincipals[0].allowed_target_scopes = [];
  expectFailure(await state.raw(callerA, "resolve_target", address(callerB)), "forbidden");
  expectFailure(await state.raw(callerA, "send_message", sendInput(callerA, callerB)), "forbidden");
  assert.equal(state.store.findBindingByIdentity(identityKey(callerB)), null);
  assert.equal(state.snapshots().length, 0);
  assert.equal(state.calls.deliveries.length, 0);
});

test("directory pagination and message cursors cannot be reused by another concrete CID on the same principal", async context => {
  const state = await fixture(context);
  for (const caller of [callerB, callerC]) await state.call(callerA, "resolve_target", address(caller));
  const first = await state.call(callerA, "list_conversations", { limit: 1 });
  assert.equal(first.has_more, true);
  assert.ok(first.next_cursor);
  expectFailure(await state.raw(callerB, "list_conversations", { limit: 1, cursor: first.next_cursor }), "invalid_cursor");
  const seen = [...first.targets];
  let cursor = first.next_cursor;
  while (cursor) {
    const page = await state.call(callerA, "list_conversations", { limit: 1, cursor });
    seen.push(...page.targets);
    cursor = page.next_cursor;
    assert.ok(seen.length <= 4, "directory pagination must terminate without duplicates");
  }
  assert.equal(new Set(seen.map(target => target.binding_id)).size, seen.length);
  assert.deepEqual(new Set(seen.map(target => target.conversation_id)), new Set([owner.conversation_id, ...callers.map(caller => caller.conversation_id)]));
  const firstMessage = await state.send(callerA, callerB, "synthetic-first-cursor");
  const secondMessage = await state.send(callerA, callerB, "synthetic-second-cursor");
  await state.core.drain();
  expectFailure(await state.raw(callerB, "wait", { message_id: secondMessage.message.message_id, after_cursor: firstMessage.next_cursor, wait_ms: 0 }), "invalid_cursor");
});

test("reopening SQLite retains direct bindings/generations, original messages/events and dedupe IDs without another delivery", async context => {
  const state = await fixture(context);
  const resolved = await state.call(callerA, "resolve_target", address(callerB));
  const original = await state.send(callerA, callerB, "synthetic-reopen");
  await state.core.drain();
  const before = state.core.result(original.message.message_id);
  const events = state.store.eventsAfter(original.message.message_id);
  const bindings = state.store.listBindings();
  await state.reopen();
  assert.deepEqual(state.store.listBindings(), bindings);
  assert.deepEqual((await state.call(callerC, "resolve_target", address(callerB))).target, resolved.target);
  assert.deepEqual(await state.call(callerA, "get_message", { message_id: original.message.message_id }), before);
  assert.deepEqual(state.store.eventsAfter(original.message.message_id), events);
  const repeated = await state.send(callerA, callerB, "synthetic-reopen");
  assert.equal(repeated.duplicate, true);
  assert.equal(repeated.message.message_id, original.message.message_id);
  assert.equal(repeated.delivery.delivery_id, original.delivery.delivery_id);
  assert.equal(repeated.message.envelope.target.binding_generation, resolved.target.binding_generation);
  assert.equal(state.calls.deliveries.length, 1);
});

test("temporarily missing host adapter recovers the original addressed message and delivery after reopen", async context => {
  const state = await fixture(context);
  state.setAdapterEnabled("codex", false);
  const original = await state.send(callerA, callerB, "synthetic-absent-host");
  await state.core.drain();
  assert.equal(state.core.result(original.message.message_id).delivery.status, "unsupported");
  assert.equal(state.calls.deliveries.length, 0);
  state.setAdapterEnabled("codex", true);
  await state.reopen();
  const restored = await state.call(callerB, "get_message", { message_id: original.message.message_id });
  assert.equal(restored.delivery.status, "accepted");
  assert.equal(restored.delivery.delivery_id, original.delivery.delivery_id);
  assert.deepEqual(restored.message.envelope.target, original.message.envelope.target);
  assert.equal(state.calls.deliveries.length, 1);
});

test("temporarily absent exact target keeps the prepared outbox until the same binding/generation is restored", async context => {
  const state = await fixture(context, { legacy: true });
  state.modes.set(state.legacyReceiver.conversation_id, "busy");
  const original = await state.send(callerA, state.legacyTarget, "synthetic-missing-target");
  await state.core.drain();
  assert.equal(state.core.result(original.message.message_id).delivery.status, "prepared");
  assert.equal(state.calls.deliveries.length, 1);
  state.targets.splice(state.targets.indexOf(state.legacyTarget), 1);
  state.advance(100);
  await state.reopen();
  const absent = await state.call(callerA, "get_message", { message_id: original.message.message_id });
  assert.equal(absent.delivery.status, "prepared");
  assert.equal(absent.delivery.error.code, "target_not_found");
  assert.equal(absent.delivery.delivery_id, original.delivery.delivery_id);
  assert.equal(state.calls.deliveries.length, 1);
  state.targets.push(state.legacyTarget);
  state.modes.set(state.legacyReceiver.conversation_id, "accepted");
  state.advance(5000);
  await state.reopen();
  const restored = await state.call(callerA, "get_message", { message_id: original.message.message_id });
  assert.equal(restored.delivery.status, "accepted");
  assert.equal(restored.delivery.delivery_id, original.delivery.delivery_id);
  assert.deepEqual(restored.message.envelope.target, original.message.envelope.target);
  assert.equal(state.calls.deliveries.length, 2);
});

test("busy recipient keeps prepared and the same IDs through retry backoff and SQLite reopen", async context => {
  const state = await fixture(context);
  state.modes.set(callerB.conversation_id, "busy");
  const original = await state.send(callerA, callerB, "synthetic-busy");
  await state.core.drain();
  assert.equal(state.core.result(original.message.message_id).delivery.status, "prepared");
  assert.equal(state.calls.deliveries.length, 1);
  await state.core.dispatchPending();
  await state.reopen();
  assert.equal(state.calls.deliveries.length, 1);
  assert.equal((await state.send(callerA, callerB, "synthetic-busy")).duplicate, true);
  state.modes.set(callerB.conversation_id, "accepted");
  state.advance(100);
  await state.core.dispatchPending();
  const restored = await state.call(callerB, "get_message", { message_id: original.message.message_id });
  assert.equal(restored.delivery.status, "accepted");
  assert.equal(restored.delivery.delivery_id, original.delivery.delivery_id);
  assert.equal(restored.delivery.attempt_count, 2);
  assert.deepEqual(state.calls.deliveries.map(call => [call.message.message_id, call.delivery.delivery_id]), Array(2).fill([original.message.message_id, original.delivery.delivery_id]));
});

test("unknown delivery is queried under its frozen target after retries/reopen, never redelivered", async context => {
  const state = await fixture(context);
  state.modes.set(callerB.conversation_id, "unknown");
  state.queryModes.set(callerB.conversation_id, "unknown");
  const original = await state.send(callerA, callerB, "synthetic-unknown");
  await state.core.drain();
  assert.equal(state.core.result(original.message.message_id).delivery.status, "unknown");
  const binding = state.store.getBinding(original.message.envelope.target.binding_id);
  const newer = state.store.putBinding({ ...binding, evidence: "synthetic-new-directory-generation" }, { expectedGeneration: binding.binding_generation });
  assert.equal(newer.binding_generation, original.message.envelope.target.binding_generation + 1);
  assert.equal((await state.call(callerC, "resolve_target", address(callerB))).target.binding_generation, newer.binding_generation);
  await state.core.dispatchPending();
  await state.reopen();
  assert.equal(state.core.result(original.message.message_id).delivery.status, "unknown");
  assert.equal((await state.send(callerA, callerB, "synthetic-unknown")).duplicate, true);
  state.queryModes.set(callerB.conversation_id, "accepted");
  await state.core.dispatchPending();
  assert.equal(state.core.result(original.message.message_id).delivery.status, "accepted");
  assert.equal(state.calls.deliveries.length, 1);
  assert.equal(state.calls.queries.length, 3);
  for (const query of state.calls.queries) {
    assert.equal(query.message.message_id, original.message.message_id);
    assert.equal(query.delivery.delivery_id, original.delivery.delivery_id);
    assert.deepEqual(query.target, state.calls.deliveries[0].target);
  }
});

test("legacy exact credentials, bindings and already-persisted messages still work after enabling host-scoped addressing", async context => {
  const state = await fixture(context, { legacy: true, scoped: false });
  const original = await state.send(state.legacySource, state.legacyTarget, "synthetic-legacy-message", { target: boundAddress(state.legacyTarget) }, state.legacyPrincipal);
  await state.core.drain();
  const oldSnapshot = state.core.result(original.message.message_id);
  const oldEvents = state.store.eventsAfter(original.message.message_id);
  await state.reopen({ scoped: true });
  assert.deepEqual(await state.call(state.legacySource, "get_message", { message_id: original.message.message_id }, state.legacyPrincipal), oldSnapshot);
  assert.deepEqual(state.store.eventsAfter(original.message.message_id), oldEvents);
  const resolved = await state.call(state.legacySource, "resolve_target", { binding_id: state.legacyTarget.binding_id }, state.legacyPrincipal);
  assert.deepEqual(resolved.target, state.legacyTarget);
  expectFailure(await state.raw(callerA, "resolve_target", { binding_id: state.legacyTarget.binding_id }, state.legacyPrincipal), "caller_mismatch");
  expectFailure(await state.raw(state.legacySource, "resolve_target", address(callerB), state.legacyPrincipal), "forbidden");
  const duplicate = await state.send(state.legacySource, state.legacyTarget, "synthetic-legacy-message", { target: boundAddress(state.legacyTarget) }, state.legacyPrincipal);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.delivery.delivery_id, original.delivery.delivery_id);
  assert.equal((await state.call(state.legacyReceiver, "ack_processing", { message_id: original.message.message_id, delivery_id: original.delivery.delivery_id,
    binding_generation: state.legacyTarget.binding_generation, processing: "done" }, state.legacyReceiverPrincipal)).message.processing, "done");
  const fresh = await state.send(callerA, callerB, "synthetic-after-legacy");
  await state.core.drain();
  assert.equal(state.core.result(fresh.message.message_id).delivery.status, "accepted");
  assert.equal(state.calls.deliveries.length, 2);
});

for (const legacyFirst of [true, false]) {
  test(`real facade scope wins over an old exact CID (${legacyFirst ? "legacy-first" : "scope-first"}) and freezes two distinct QQ return origins`, async context => {
    const state = await fixture(context, { legacy: true, legacyCollision: true });
    const client = await state.facadeClient({ legacyFirst });
    const windowKey = "synthetic-qq-window";
    state.store.putChannelBinding({ window_key: windowKey, channel: "qq", target: address(state.legacySource) }, { ownerKey: identityKey(callerA), expectedGeneration: 0 });
    const originals = [];
    for (const caller of [callerA, callerB]) {
      const original = resultContent(await client.callTool({ name: "communication_send_message", arguments: { caller, ...sendInput(caller, owner) } }));
      assert.equal(original.message.principal_id, state.scopedPrincipals[0].id);
      assert.equal(original.message.source_key, identityKey(caller));
      assert.equal(identityKey(original.message.reply_forward_binding.to_target), identityKey(caller));
      assert.equal(original.message.reply_forward_binding.source_principal_id, state.scopedPrincipals[0].id);
      originals.push(original);
    }
    await state.core.drain();
    assert.equal(state.calls.qq.length, 2);
    assert.notEqual(originals[0].message.message_id, originals[1].message.message_id);
    assert.notEqual(originals[0].message.reply_forward_binding.rule_id, originals[1].message.reply_forward_binding.rule_id);
    const changed = state.store.putChannelBinding({ window_key: windowKey, channel: "qq", target: address(callerC) }, { ownerKey: identityKey(callerA), expectedGeneration: 1 });
    assert.equal(changed.generation, 2);
    await state.reopen();
    assert.deepEqual(state.store.getChannelBinding(windowKey), changed);
    state.setRoute({ route_key: "synthetic-new-window-route", conversation_id: callerC.conversation_id, target_key: owner.conversation_id, generation: 8 });
    state.enableReplies();
    assert.equal((await state.core.pollReplies()).replies, 2);
    await state.core.drain();
    const forwards = state.snapshots().filter(snapshot => snapshot.message.forward_of);
    assert.equal(forwards.length, 2);
    for (const [index, caller] of [callerA, callerB].entries()) {
      const original = state.core.result(originals[index].message.message_id);
      const forward = forwards.find(snapshot => snapshot.message.envelope.in_reply_to === original.message.message_id);
      assert.ok(forward);
      assert.equal(forward.delivery.status, "accepted");
      assert.equal(forward.message.target_key, identityKey(caller));
      assert.equal(forward.message.source_key, identityKey(owner));
      assert.equal(forward.message.envelope.origin.kind, "human_message");
      assert.equal(forward.message.envelope.origin.channel, "napcat_owner_reply");
      assert.equal(forward.message.envelope.delivery_policy, "next_model_boundary");
      assert.equal(forward.message.envelope.message_visibility, "hidden");
      assert.equal(forward.message.forward_of.delivery_id, original.delivery.delivery_id);
      assert.equal(forward.message.forward_of.native_source.route.generation, 7);
      assert.equal(forward.message.forward_of.native_source.route.conversation_id, "synthetic-old-reader-CID");
      assert.notEqual(forward.message.target_key, identityKey(callerC));
      const events = (await state.call(caller, "wait", { message_id: original.message.message_id, until: "reply", wait_ms: 0 })).events;
      const nativeReply = events.find(event => event.kind === "reply");
      const plan = planOwnerReplyForward({ message: original.message, delivery: original.delivery, reply: nativeReply.data,
        binding: original.message.reply_forward_binding, observedAt: nativeReply.created_at });
      assert.ok(plan);
      assert.equal(forward.message.envelope.text, plan.envelope.text);
      assert.equal(forward.message.envelope.dedupe_key, plan.envelope.dedupe_key);
      assert.deepEqual(forward.message.forward_of, plan.forward_of);
      assert.equal((await state.call(caller, "get_message", { message_id: forward.message.message_id })).message.message_id, forward.message.message_id);
      expectFailure(await state.raw(index === 0 ? callerB : callerA, "get_message", { message_id: forward.message.message_id }), "forbidden");
      const acknowledgement = { message_id: forward.message.message_id, delivery_id: forward.delivery.delivery_id,
        binding_generation: forward.message.envelope.target.binding_generation, processing: "done" };
      expectFailure(await state.raw(index === 0 ? callerB : callerA, "ack_processing", acknowledgement), "forbidden");
      assert.equal((await state.call(caller, "ack_processing", acknowledgement)).message.processing, "done");
      assert.equal(original.message.processing, "pending");
    }
    const frozenIds = forwards.map(snapshot => [snapshot.message.message_id, snapshot.delivery.delivery_id]).sort();
    await state.core.pollReplies();
    await state.reopen();
    assert.deepEqual(state.snapshots().filter(snapshot => snapshot.message.forward_of).map(snapshot => [snapshot.message.message_id, snapshot.delivery.delivery_id]).sort(), frozenIds);
    assert.equal(state.calls.qq.length, 2);
    assert.equal(state.calls.deliveries.length, 2);
    assert.equal(state.calls.observations.length, 2);
  });
}

for (const invalid of ["foreign-sender", "wrong-quote", "changed-route-generation", "other-CID-route"]) {
  test(`scoped automatic QQ return rejects ${invalid} and waits for exact frozen native evidence`, async context => {
    const state = await fixture(context, { legacy: true });
    const original = await state.send(callerB, owner, "synthetic-qq-invalid");
    await state.core.drain();
    state.enableReplies(reply => {
      if (invalid === "foreign-sender") reply.native_source.event.sender_id = "90002";
      if (invalid === "wrong-quote") reply.native_source.event.quoted_message_id = "89999";
      if (invalid === "changed-route-generation") reply.native_source.route.generation += 1;
      if (invalid === "other-CID-route") reply.native_source.route.conversation_id = callerC.conversation_id;
      return reply;
    });
    await state.core.pollReplies();
    await state.core.drain();
    assert.equal(state.snapshots().filter(snapshot => snapshot.message.forward_of).length, 0);
    assert.equal(state.calls.deliveries.length, 0);
    assert.equal(state.core.result(original.message.message_id).message.processing, "pending");
    const rejected = await state.call(callerB, "wait", { message_id: original.message.message_id, until: "reply", wait_ms: 0 });
    state.enableReplies();
    await state.core.pollReplies();
    await state.core.drain();
    const forwards = state.snapshots().filter(snapshot => snapshot.message.forward_of);
    assert.equal(rejected.matched, false, JSON.stringify({ invalid, reply_wait_matched: rejected.matched,
      events: rejected.events.map(event => ({ kind: event.kind, sender_id: event.data.native_source?.event?.sender_id, code: event.data.code })),
      observations_after_valid_retry: state.calls.observations.length, forwards_after_valid_retry: forwards.length }));
    assert.equal(rejected.events.some(event => event.kind === "reply"), false);
    assert.equal(forwards.length, 1);
    assert.equal(forwards[0].message.target_key, identityKey(callerB));
    assert.equal(forwards[0].delivery.status, "accepted");
    assert.equal(state.calls.qq.length, 1);
  });
}

for (const mode of ["busy", "unknown"]) {
  test(`automatic QQ return survives ${mode} and reopen using its original IDs without sending another QQ notice`, async context => {
    const state = await fixture(context);
    const original = await state.send(callerB, owner, `synthetic-qq-${mode}`);
    await state.core.drain();
    state.modes.set(callerB.conversation_id, mode);
    state.queryModes.set(callerB.conversation_id, "unknown");
    state.enableReplies();
    await state.core.pollReplies();
    await state.core.drain();
    const [pending] = state.snapshots().filter(snapshot => snapshot.message.forward_of);
    assert.ok(pending);
    assert.equal(pending.delivery.status, mode === "busy" ? "prepared" : "unknown");
    await state.reopen();
    assert.equal(state.calls.deliveries.length, 1);
    state.modes.set(callerB.conversation_id, "accepted");
    state.queryModes.set(callerB.conversation_id, "accepted");
    state.advance(100);
    await state.core.dispatchPending();
    const [restored] = state.snapshots().filter(snapshot => snapshot.message.forward_of);
    assert.equal(restored.delivery.status, "accepted");
    assert.equal(restored.message.message_id, pending.message.message_id);
    assert.equal(restored.delivery.delivery_id, pending.delivery.delivery_id);
    assert.equal(restored.message.envelope.in_reply_to, original.message.message_id);
    assert.equal(restored.message.target_key, identityKey(callerB));
    assert.equal(state.calls.qq.length, 1);
    assert.equal(state.calls.deliveries.length, mode === "busy" ? 2 : 1);
    if (mode === "unknown") {
      assert.equal(state.calls.queries.length, 2);
      assert.ok(state.calls.queries.every(query => query.delivery.delivery_id === pending.delivery.delivery_id && query.message.message_id === pending.message.message_id));
    }
  });
}

function statusModule(root, name, source) {
  const modulePath = join(root, `synthetic-status-${name}.mjs`);
  writeFileSync(modulePath, source, "utf8");
  return { module_path: modulePath, sha256: createHash("sha256").update(source, "utf8").digest("hex") };
}

test("checked status_source loads only its two functions and serves route-free MCP conversation/whole-host status without directory writes", async context => {
  const provider = new HostStatusProvider();
  const state = await fixture(context, { routes: false, statusProvider: provider });
  context.after(() => provider.close());
  const configuration = statusModule(state.root, "valid", `
const requests = { host: [], threads: [] };
export async function readHostStatus(target) {
  requests.host.push(structuredClone(target));
  return { control_enabled: true, proxy: { ok: true, closed: false, readyClientCount: 1,
    clients: [{ initialized: true, upstreamReady: true, downstreamState: 1, upstreamState: 1 }] } };
}
export async function inspectThread(conversationId) {
  requests.threads.push(conversationId);
  return { ok: true, threadId: conversationId, found: true,
    thread: { id: conversationId, status: { type: "active" }, canAcceptDirectInput: true } };
}
export function ensureCodexCommunication() { throw new Error("status must not run source recovery"); }
readHostStatus.requests = requests;
inspectThread.requests = requests;
`);
  const source = await loadCodexStatusSource(configuration);
  assert.deepEqual(Object.keys(source).sort(), ["inspectThread", "readHostStatus"]);
  assert.equal(typeof source.readHostStatus, "function");
  assert.equal(typeof source.inspectThread, "function");
  assert.deepEqual(source.readHostStatus.requests, { host: [], threads: [] });
  provider.providers.set("codex", createCodexStatusReader({ ...source, configured_delivery_modes: capabilities }));
  assert.equal(state.core.directory, null);
  const before = state.store.listBindings();
  const status = await state.call(callerA, "get_status", { host: "codex", conversation_id: callerB.conversation_id });
  assert.deepEqual(status.target, callerB);
  assert.equal(status.host_online, true);
  assert.equal(status.conversation_exists, true);
  assert.equal(status.conversation_running, true);
  assert.equal(status.raw_status, "active");
  assert.equal(status.source, "codex_proxy_status_and_thread_inspect");
  assert.ok(Number.isFinite(Date.parse(status.observed_at)));
  assert.deepEqual(source.readHostStatus.requests.host, [callerB]);
  assert.deepEqual(source.inspectThread.requests.threads, [callerB.conversation_id]);
  const wholeHost = await state.call(callerA, "get_status", { host: "codex" });
  const triple = { machine_id: machineId, host: "codex", surface: "desktop" };
  assert.deepEqual(wholeHost.target, triple);
  assert.deepEqual(source.readHostStatus.requests.host.at(-1), triple);
  assert.equal(wholeHost.host_online, true);
  assert.equal(wholeHost.conversation_exists, "unknown");
  assert.equal(wholeHost.conversation_running, "unknown");
  assert.equal(wholeHost.can_deliver, "unknown");
  assert.equal(source.inspectThread.requests.threads.length, 1);
  assert.deepEqual(state.store.listBindings(), before);
  assert.equal(state.snapshots().length, 0);
  expectFailure(await state.raw(callerA, "resolve_target", address(callerB)), "host_not_enabled");
  assert.equal(state.calls.deliveries.length, 0);
  assert.equal(state.calls.queries.length, 0);
});

test("status permission is checked before any host/thread probe for cross-scope addresses and whole hosts", async context => {
  const probes = [];
  const reader = {
    source: "synthetic-no-cross-scope-probe", configured_delivery_modes: capabilities,
    async getHostStatus(target) { probes.push({ kind: "host", target }); return { host_online: true }; },
    async describeConversation(target) { probes.push({ kind: "conversation", target }); return { conversation_exists: true, conversation_running: true }; },
  };
  const provider = new HostStatusProvider({ providers: { codex: reader, antigravity: reader } });
  const state = await fixture(context, { routes: false, statusProvider: provider });
  context.after(() => provider.close());
  state.scopedPrincipals[0].allowed_target_scopes = [{ machine_id: machineId, host: "codex", surface: "desktop" }];
  for (const reference of [
    { ...address(callerB), machine_id: "synthetic-other-machine" },
    { ...address(callerB), host: "antigravity" },
    { ...address(callerB), surface: "synthetic-other-surface" },
    { host: "antigravity" },
    { host: "codex", machine_id: "synthetic-other-machine" },
    { host: "codex", surface: "synthetic-other-surface" },
  ]) expectFailure(await state.raw(callerA, "get_status", reference), "forbidden");
  assert.deepEqual(probes, []);
  assert.deepEqual(state.store.listBindings(), []);
  assert.equal(state.snapshots().length, 0);
  const permitted = await state.call(callerA, "get_status", address(callerB));
  assert.equal(permitted.conversation_running, true);
  assert.equal(probes.length, 2);
  assert.deepEqual(state.store.listBindings(), []);
});

test("status_source rejects a mismatched SHA before importing a module with top-level effects", async context => {
  const state = await fixture(context, { routes: false });
  const marker = Symbol.for("synthetic-direct-addressing-bad-status-sha");
  context.after(() => { delete globalThis[marker]; });
  const configuration = statusModule(state.root, "bad-sha", `
globalThis[Symbol.for("synthetic-direct-addressing-bad-status-sha")] = true;
export function readHostStatus() {}
export function inspectThread() {}
`);
  const badSha = `${configuration.sha256[0] === "a" ? "b" : "a"}${configuration.sha256.slice(1)}`;
  await assert.rejects(loadCodexStatusSource({ ...configuration, sha256: badSha }), { code: "invalid_config" });
  assert.equal(globalThis[marker], undefined);
});

for (const [name, source] of [
  ["missing-readHostStatus", "export function inspectThread() {}"],
  ["missing-inspectThread", "export function readHostStatus() {}"],
  ["nonfunction-readHostStatus", "export const readHostStatus = true; export function inspectThread() {}"],
  ["nonfunction-inspectThread", "export function readHostStatus() {} export const inspectThread = {};"],
]) {
  test(`status_source rejects ${name} even with a matching file SHA`, async context => {
    const state = await fixture(context, { routes: false });
    await assert.rejects(loadCodexStatusSource(statusModule(state.root, name, source)), { code: "invalid_config" });
  });
}

test("status_source preserves the absolute local .mjs path and exact-key boundaries", async context => {
  const state = await fixture(context, { routes: false });
  const configuration = statusModule(state.root, "path-boundaries", "export function readHostStatus() {} export function inspectThread() {}");
  for (const modulePath of ["synthetic-relative.mjs", `${configuration.module_path}?untrusted=1`, `${configuration.module_path}#untrusted`, "https://synthetic.invalid/status.mjs"]) {
    await assert.rejects(loadCodexStatusSource({ ...configuration, module_path: modulePath }), { code: "invalid_config" });
  }
  await assert.rejects(loadCodexStatusSource({ ...configuration, untrusted_option: true }), { code: "invalid_config" });
});

for (const routes of [true, false]) {
  test(`QQ host+CID without surface resolves/sends/queries the unique group and rejects ambiguous window types (${routes ? "directory" : "no-directory"})`, async context => {
    const state = await fixture(context, { routes });
    const reference = { host: "qq", conversation_id: owner.conversation_id };
    const resolved = await state.call(callerA, "resolve_target", reference);
    assert.equal(resolved.target.binding_id, owner.binding_id);
    assert.equal(resolved.target.surface, "group");
    assert.equal(identityKey(resolved.target), identityKey(owner));
    const request = sendInput(callerA, owner, "synthetic-qq-inferred-group", { target: reference });
    const original = await state.call(callerA, "send_message", request);
    await state.core.drain();
    assert.equal(original.message.source_key, identityKey(callerA));
    assert.equal(original.message.target_key, identityKey(owner));
    assert.equal(original.message.envelope.target.surface, "group");
    assert.equal(state.core.result(original.message.message_id).delivery.status, "accepted");
    for (const target of [reference, { ...reference, surface: "group" }]) {
      const repeated = await state.call(callerA, "send_message", { ...request, target });
      assert.equal(repeated.duplicate, true);
      assert.equal(repeated.message.message_id, original.message.message_id);
      assert.equal(repeated.delivery.delivery_id, original.delivery.delivery_id);
    }
    const status = await state.call(callerA, "get_status", reference);
    assert.equal(status.target.binding_id, owner.binding_id);
    assert.equal(status.target.surface, "group");
    assert.equal(identityKey(status.target), identityKey(owner));
    const wrong = { ...reference, surface: "desktop" };
    expectFailure(await state.raw(callerA, "resolve_target", wrong), "host_not_enabled");
    expectFailure(await state.raw(callerA, "send_message", { ...request, target: wrong }), "dedupe_conflict");
    expectFailure(await state.raw(callerA, "send_message", { ...request, dedupe_key: "synthetic-qq-wrong-surface", target: wrong }), "host_not_enabled");
    expectFailure(await state.raw(callerA, "get_status", wrong), "forbidden");
    assert.equal(state.calls.qq.length, 1);
    assert.equal(state.snapshots().length, 1);
    assert.equal(state.store.findBindingByIdentity(identityKey({ ...owner, surface: "desktop" })), null);

    const privateTarget = { ...owner, surface: "private", binding_id: "synthetic-owner-private-binding" };
    state.targets.push(privateTarget);
    state.scopedPrincipals[0].allowed_targets.push(privateTarget.binding_id);
    await state.reopen();
    const ambiguousCode = routes ? "target_not_found" : "host_not_enabled";
    expectFailure(await state.raw(callerA, "resolve_target", reference), ambiguousCode);
    expectFailure(await state.raw(callerA, "send_message", { ...request, dedupe_key: "synthetic-qq-ambiguous" }), ambiguousCode);
    expectFailure(await state.raw(callerA, "get_status", reference), "target_not_found");
    assert.equal(state.calls.qq.length, 1);
    assert.equal(state.snapshots().length, 1);

    for (const target of [owner, privateTarget]) {
      const explicit = { ...reference, surface: target.surface };
      const selected = await state.call(callerA, "resolve_target", explicit);
      assert.equal(selected.target.binding_id, target.binding_id);
      assert.equal(identityKey(selected.target), identityKey(target));
      const observed = await state.call(callerA, "get_status", explicit);
      assert.equal(observed.target.binding_id, target.binding_id);
      assert.equal(identityKey(observed.target), identityKey(target));
      const sent = await state.call(callerA, "send_message", { ...request, target: explicit, dedupe_key: `synthetic-qq-explicit-${target.surface}` });
      await state.core.drain();
      assert.equal(sent.message.target_key, identityKey(target));
      assert.equal(sent.message.envelope.target.binding_id, target.binding_id);
      assert.equal(state.core.result(sent.message.message_id).delivery.status, "accepted");
    }
    expectFailure(await state.raw(callerA, "resolve_target", wrong), "host_not_enabled");
    expectFailure(await state.raw(callerA, "get_status", wrong), "forbidden");
    assert.equal(state.calls.qq.length, 3);
    assert.equal(state.snapshots().length, 3);
  });
}
