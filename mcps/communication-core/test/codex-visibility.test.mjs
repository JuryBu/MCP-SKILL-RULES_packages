import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommunicationCore } from "../src/core.mjs";
import { MessageStore } from "../src/store.mjs";
import { digest, identityKey, normalizeSendInput } from "../src/contracts.mjs";
import { communicationTools } from "../src/mcp-server.mjs";

const caller = { machine_id: "synthetic-machine", host: "antigravity", surface: "desktop", conversation_id: "synthetic-source" };
const target = { machine_id: "synthetic-machine", host: "codex", surface: "desktop", conversation_id: "synthetic-target", binding_id: "synthetic-codex", binding_generation: 1, adapter_id: "synthetic", capabilities: { next_model_boundary: true, when_idle: true }, evidence: "simulated" };
const principal = { id: "synthetic-source", identity: caller, allowed_targets: [target.binding_id], origin_kinds: ["agent_message"] };
const context = { principal_id: principal.id };
const targetIdentity = Object.fromEntries(["machine_id", "host", "surface", "conversation_id", "binding_id", "binding_generation"].map(field => [field, target[field]]));

function input(overrides = {}) {
  return { caller, origin: { kind: "agent_message", channel: "synthetic", source_ref: "synthetic-event" }, target: targetIdentity, dedupe_key: "synthetic-send", text: "synthetic visibility", expires_at: "2099-01-01T00:00:00Z", ...overrides };
}

function fixture(testContext, outcome = "accepted") {
  const directory = mkdtempSync(join(tmpdir(), "communication-visibility-"));
  const filePath = join(directory, "core.sqlite");
  const cores = [];
  const stores = [];
  const calls = [];
  const adapter = {
    submissionTracking: true,
    async deliver(request) {
      request.onRequestStarted?.();
      calls.push({ method: "deliver", envelope: structuredClone(request.message.envelope) });
      return { delivery_id: request.delivery.delivery_id, target_key: identityKey(target), outcome, evidence: { kind: "simulated" } };
    },
    async query(request) {
      calls.push({ method: "query", envelope: structuredClone(request.message.envelope) });
      return { delivery_id: request.delivery.delivery_id, target_key: identityKey(target), outcome: "unknown" };
    },
  };
  function open() {
    const store = new MessageStore({ filePath });
    stores.push(store);
    const core = new CommunicationCore({ store, targets: [target], principals: [principal], adapters: { synthetic: adapter } });
    cores.push(core);
    return { core, store };
  }
  testContext.after(async () => {
    for (const core of cores) await core.close();
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { open, calls, adapter };
}

test("new Codex visibility survives persistence and a same-key duplicate", async testContext => {
  const files = fixture(testContext);
  const { core } = files.open();
  await core.start();
  for (const visibility of [undefined, "visible"]) {
    const request = input({ dedupe_key: `synthetic-${visibility ?? "default"}`, ...(visibility === undefined ? {} : { message_visibility: visibility }) });
    const sent = await core.sendMessage(context, request);
    await core.drain();
    assert.equal(core.getMessage(context, { caller, message_id: sent.message.message_id }).message.envelope.message_visibility, visibility ?? "hidden");
    const duplicate = await core.sendMessage(context, request);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.message.message_id, sent.message.message_id);
    await assert.rejects(core.sendMessage(context, { ...request, message_visibility: visibility === "visible" ? "hidden" : "visible" }), { code: "dedupe_conflict" });
  }
  assert.deepEqual(files.calls.map(call => call.envelope.message_visibility), ["hidden", "visible"]);
});

test("a stored legacy Codex request retains its original hash and duplicate identity", async testContext => {
  const files = fixture(testContext);
  const { core, store } = files.open();
  const envelope = normalizeSendInput(input(), principal, target, { preserveLegacyVisibility: true });
  const created = "2026-01-01T00:00:00.000Z";
  store.transaction(() => {
    store.insertMessage({ message_id: "synthetic-legacy-message", source_key: identityKey(caller), target_key: identityKey(target), dedupe_key: envelope.dedupe_key, payload_hash: digest(envelope), principal_id: principal.id, envelope, created_at: created, delivery_status: "accepted", processing: "pending" });
    store.insertDelivery({ delivery_id: "synthetic-legacy-delivery", message_id: "synthetic-legacy-message", target_key: identityKey(target), target_snapshot: target, status: "accepted", attempt_count: 1, created_at: created, updated_at: created });
  });
  await core.start();
  const duplicate = await core.sendMessage(context, input());
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message.message_id, "synthetic-legacy-message");
  assert.equal(duplicate.delivery.delivery_id, "synthetic-legacy-delivery");
  assert.equal(duplicate.message.payload_hash, digest(envelope));
  assert.equal(Object.hasOwn(duplicate.message.envelope, "message_visibility"), false);
  assert.equal(files.calls.length, 0);
});

for (const visibility of ["hidden", "visible"]) {
  test(`unknown ${visibility} Codex requests only query their original persisted mode after reopen`, async testContext => {
    const files = fixture(testContext, "unknown");
    const initial = files.open();
    await initial.core.start();
    const sent = await initial.core.sendMessage(context, input({ message_visibility: visibility }));
    await initial.core.drain();
    assert.equal(initial.core.getMessage(context, { caller, message_id: sent.message.message_id }).delivery.status, "unknown");
    await initial.core.close();
    initial.store.close();
    const reopened = files.open();
    await reopened.core.start();
    await reopened.core.drain();
    const state = reopened.core.getMessage(context, { caller, message_id: sent.message.message_id });
    assert.equal(state.delivery.delivery_id, sent.delivery.delivery_id);
    assert.equal(state.delivery.attempt_count, 1);
    assert.equal(files.calls.filter(call => call.method === "deliver").length, 1);
    assert.ok(files.calls.some(call => call.method === "query"));
    assert.ok(files.calls.every(call => call.envelope.message_visibility === visibility));
  });
}

test("MCP advertises optional Codex hidden or visible while rejecting malformed modes", () => {
  const tool = communicationTools.find(entry => entry.definition.name === "communication_send_message");
  assert.deepEqual(tool.definition.inputSchema.properties.message_visibility.enum, ["hidden", "visible"]);
  assert.equal(tool.definition.inputSchema.required.includes("message_visibility"), false);
  assert.equal(tool.validator.safeParse(input()).success, true);
  assert.equal(tool.validator.safeParse(input({ message_visibility: "visible" })).success, true);
  assert.equal(tool.validator.safeParse(input({ message_visibility: null })).success, false);
});

test("only an explicit Codex busy receipt preserves the unsent recovery proof in SQLite", async testContext => {
  const files = fixture(testContext);
  const { core, store } = files.open();
  let evidence = { kind: "receipt", request_sent: false };
  files.adapter.deliver = async request => {
    request.onRequestStarted?.();
    return { delivery_id: request.delivery.delivery_id, target_key: identityKey(target), outcome: "busy", evidence };
  };
  await core.start();
  const first = await core.sendMessage(context, input());
  await core.drain();
  const persisted = store.getDelivery(first.delivery.delivery_id);
  assert.equal(persisted.evidence.evidence.request_sent, false);
  assert.equal(persisted.evidence.evidence.operation, "deliver");
  assert.equal(persisted.evidence.outcome, "busy");
  evidence = { kind: "query", request_sent: false };
  const disconnected = await core.sendMessage(context, input({ dedupe_key: "synthetic-connect-refused" }));
  await core.drain();
  assert.equal(Object.hasOwn(store.getDelivery(disconnected.delivery.delivery_id).evidence.evidence, "request_sent"), false);
});

for (const evidence of [{ kind: "receipt" }, { kind: "receipt", request_sent: true }, { kind: "query", request_sent: false }, { kind: "receipt", request_sent: false }]) {
  test(`an unknown Codex query only becomes prepared with an exact unsent receipt ${JSON.stringify(evidence)}`, async testContext => {
    const files = fixture(testContext, "unknown");
    const { core } = files.open();
    files.adapter.query = async request => ({ delivery_id: request.delivery.delivery_id, target_key: identityKey(target), outcome: "busy", evidence });
    await core.start();
    const sent = await core.sendMessage(context, input());
    await core.drain();
    await core.dispatchPending();
    await core.drain();
    const state = core.getMessage(context, { caller, message_id: sent.message.message_id });
    assert.equal(state.delivery.status, evidence.kind === "receipt" && evidence.request_sent === false ? "prepared" : "unknown");
    assert.equal(state.delivery.delivery_id, sent.delivery.delivery_id);
    assert.equal(state.delivery.attempt_count, 1);
    assert.equal(files.calls.filter(call => call.method === "deliver").length, 1);
  });
}
