import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadCodexSourceRecovery, CodexSourceRecovery } from "../src/codex-source-recovery.mjs";
import { CodexProxyTransport } from "../src/transports/codex-proxy.mjs";
import { CodexDeliveryAdapter } from "../src/adapters/codex.mjs";
import { CommunicationCore } from "../src/core.mjs";
import { MessageStore } from "../src/store.mjs";
import { identityKey } from "../src/contracts.mjs";

const endpoint = "http://127.0.0.1:12345";
const source = { machine_id: "test", host: "antigravity", surface: "desktop", conversation_id: "recovery-source" };
const target = { machine_id: "test", host: "codex", surface: "desktop", conversation_id: "recovery-target", binding_id: "recovery-binding", binding_generation: 1, adapter_id: "codex", capabilities: { next_model_boundary: true, when_idle: true }, evidence: "isolated-test" };
const request = { delivery_id: "original-delivery", message_id: "original-message", source: { caller: source, origin: { kind: "agent_message", channel: "test", source_ref: "original-event" } }, target, body: { text: "isolated recovery test", attachment_refs: [] }, delivery_policy: "next_model_boundary" };
const binding = { instance_id: "fixture-instance", manifest_sha256: "a".repeat(64), configuration_sha256: "b".repeat(64) };
const ready = () => ({ ok: true, status: "ready", endpoint, binding: { ...binding } });
const receipt = () => ({ delivery_id: request.delivery_id, message_id: request.message_id, binding_generation: 1, origin: { kind: "agent", host: source.host, conversation_id: source.conversation_id }, target: { host: "codex", conversation_id: target.conversation_id }, thread_id: target.conversation_id, turn_id: "fixture-turn", outcome: "accepted", request_sent: true, injection_method: "turn/start" });
const response = () => Response.json({ ok: true, delivery: receipt() });
const client = (sourceRecovery, fetchImpl = async () => response()) => new CodexProxyTransport({ baseUrl: endpoint, token: "fixture-token", sourceRecovery, fetchImpl });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const refused = () => new TypeError("fetch failed", { cause: Object.assign(new Error("fixture refusal"), { code: "ECONNREFUSED", syscall: "connect" }) });

function adapterInput(overrides = {}) {
  return { message: { message_id: request.message_id, envelope: { caller: source, origin: request.source.origin, text: request.body.text, attachment_refs: [], delivery_policy: request.delivery_policy } }, delivery: { delivery_id: request.delivery_id, message_id: request.message_id, target_key: identityKey(target), target_snapshot: target, attempt_count: 1, status: "dispatching" }, target, ...overrides };
}

async function temporary(context) {
  const directory = await mkdtemp(join(tmpdir(), "core-source-recovery-中文 "));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("strict opt-in loader verifies a local mjs hash and fixed function export", async context => {
  const directory = await temporary(context);
  const modulePath = join(directory, "trusted helper.mjs");
  const bytes = "export async function ensureCodexCommunication({mode}) { return {mode}; }";
  await writeFile(modulePath, bytes, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ensure = await loadCodexSourceRecovery({ module_path: modulePath, sha256 });
  assert.deepEqual(await ensure({ mode: "inspect" }), { mode: "inspect" });
  for (const value of [undefined, null, [], {}, { module_path: modulePath }, { sha256 },
    { module_path: modulePath, sha256, enabled: true }, { module_path: modulePath, sha256: `${sha256}\n` },
    { module_path: modulePath, sha256: "g".repeat(64) }, { module_path: modulePath, sha256: "0".repeat(64) },
    ...["relative.mjs", "file:///local.mjs", "https://example.invalid/helper.mjs", "\\\\server\\share\\helper.mjs", "//server/share/helper.mjs", `${modulePath}?run=1`, `${modulePath}#hash`, `${modulePath}\u0000`, join(directory, "helper.js"), directory].map(module_path => ({ module_path, sha256 })),
  ]) await assert.rejects(loadCodexSourceRecovery(value), error => error.code === "invalid_config" && !error.message.includes(directory));
  for (const invalid of ["export const ensureCodexCommunication = 1;", "export function other() {}", "export !!!"] ) {
    const filename = join(directory, `${createHash("sha256").update(invalid).digest("hex")}.mjs`);
    await writeFile(filename, invalid, "utf8");
    await assert.rejects(loadCodexSourceRecovery({ module_path: filename, sha256: createHash("sha256").update(invalid).digest("hex") }), { code: "invalid_config" });
  }
  const sentinel = join(directory, "must-not-import.mjs");
  await writeFile(sentinel, "globalThis.__coreRecoveryUnexpectedImport = true; export function ensureCodexCommunication() {}", "utf8");
  await assert.rejects(loadCodexSourceRecovery({ module_path: sentinel, sha256: "0".repeat(64) }), { code: "invalid_config" });
  assert.equal(globalThis.__coreRecoveryUnexpectedImport, undefined);
});

test("without opt-in existing submit and GET behavior have no recovery callback", async () => {
  const methods = [];
  const transport = client(undefined, async (url, options) => { methods.push(options.method); return response(); });
  await transport.submit(request);
  await transport.query({ delivery_id: request.delivery_id }, { request });
  assert.deepEqual(methods, ["POST", "GET"]);
  await transport.close();
  assert.throws(() => client(null), { code: "invalid_config" });
});

test("invalid business input is rejected before any recovery or business boundary", async () => {
  let calls = 0;
  const transport = client(async () => { calls += 1; return ready(); }, async () => { calls += 1; return response(); });
  for (const value of [
    { ...request, body: { ...request.body, attachment_refs: ["unsupported"] } },
    { ...request, delivery_policy: "unsupported" }, { ...request, message_visibility: "unsupported" },
    { ...request, body: { text: "" } }, { ...request, target: { ...target, host: "other" } },
  ]) await assert.rejects(transport.submit(value, { onRequestStarted() { calls += 1; } }));
  assert.equal(calls, 0);
  await transport.close();
});

test("ready precedes the business boundary and disabled skips only automatic recovery", async () => {
  for (const result of [ready(), { ok: true, status: "disabled" }]) {
    const events = [];
    const transport = client(async options => { events.push(options.mode); return result; }, async (url, options) => { events.push(options.method); return response(); });
    await transport.submit(request, { onRequestStarted() { events.push("started"); } });
    assert.deepEqual(events, ["ensure", "started", "POST"]);
    await transport.close();
  }
  const recovery = new CodexSourceRecovery({ endpoint, ensure: async () => ({ ok: true, status: "disabled" }) });
  assert.deepEqual(await recovery.prepare(), { status: "disabled" });
  await recovery.close();
});

test("ready mismatch and malformed binding never start business or fabricate a receipt", async () => {
  const invalid = [
    { ...ready(), ok: false }, { ...ready(), endpoint: "http://127.0.0.1:12346" },
    { ...ready(), binding: undefined }, { ...ready(), binding: { ...binding, extra: "untrusted" } },
    { ...ready(), binding: { ...binding, instance_id: "bad instance" } },
    { ...ready(), binding: { ...binding, instance_id: "fixture-instance\n" } },
    { ...ready(), binding: { ...binding, manifest_sha256: "bad" } },
    { ...ready(), binding: { ...binding, configuration_sha256: `${binding.configuration_sha256}\n` } },
    { ...ready(), instanceId: "different-instance" },
  ];
  for (const result of invalid) {
    let calls = 0;
    const transport = client(async () => result, async () => { calls += 1; return response(); });
    await assert.rejects(transport.submit(request, { onRequestStarted() { calls += 1; } }), error => error.code === "codex_control_not_connected" && error.details.request_sent === false && error.details.source_recovery.status === "ready_mismatch" && !error.details.local_rejection);
    assert.equal(calls, 0);
    await transport.close();
  }
});

test("unavailable and thrown ensure preserve the adapter unsent busy/query contract", async () => {
  for (const ensure of [async () => ({ ok: false, status: "unavailable", changed: false }), async () => { throw new Error("private-sentinel"); }]) {
    let business = 0;
    const transport = client(ensure, async () => { business += 1; return response(); });
    const adapter = new CodexDeliveryAdapter({ transport });
    const result = await adapter.deliver(adapterInput({ onRequestStarted() { business += 1; } }));
    assert.equal(result.outcome, "busy");
    assert.equal(result.evidence.kind, "query");
    assert.equal(result.evidence.retry_after_ms, 1000);
    assert.equal(Object.hasOwn(result.evidence, "request_sent"), false);
    assert.equal(business, 0);
    assert.equal(JSON.stringify(result).includes("private-sentinel"), false);
    await transport.close();
  }
});

test("uncertain attachment retains original references and permanently uses inspect", async () => {
  for (const status of ["attach_in_progress", "previous_attempt_requires_review", "attach_unknown", "disabled_after_attempt", "policy_changed_after_attempt", "unexpected_state"]) {
    const modes = [];
    const original = { receiptPath: "fixture-original-receipt.json", attemptId: "fixture-original-attempt" };
    const transport = client(async ({ mode }) => { modes.push(mode); return modes.length === 1 ? { ok: false, status, ...original } : { ok: true, status: "not_attached" }; });
    for (let index = 0; index < 3; index += 1) await assert.rejects(transport.submit(request), error => error.details.source_recovery.receiptPath === original.receiptPath && error.details.source_recovery.attemptId === original.attemptId);
    assert.deepEqual(modes, ["ensure", "inspect", "inspect"]);
    await transport.close();
  }
  const modes = [];
  const transport = client(async ({ mode }) => { modes.push(mode); if (modes.length === 1) throw new Error("deadline"); return modes.length === 2 ? ready() : undefined; });
  await assert.rejects(transport.submit(request));
  await transport.submit(request);
  await assert.rejects(transport.submit(request));
  assert.deepEqual(modes, ["ensure", "inspect", "inspect"]);
  await transport.close();
});

test("a previous confirmed attachment cannot replace a later unknown attempt reference", async () => {
  let calls = 0;
  const transport = client(async () => {
    calls += 1;
    return calls === 1 ? { ...ready(), receiptPath: "old-confirmed-receipt.json" }
      : { ok: false, status: "attach_unknown", receiptPath: "current-unknown-receipt.json", attemptId: "current-attempt" };
  });
  await transport.submit(request);
  await assert.rejects(transport.submit(request), error => error.details.source_recovery.receiptPath === "current-unknown-receipt.json" && error.details.source_recovery.attemptId === "current-attempt");
  await transport.close();
});

test("concurrent submits share exactly one pending ensure", async () => {
  const entered = deferred();
  const gate = deferred();
  let ensures = 0;
  let posts = 0;
  const transport = client(async () => { ensures += 1; entered.resolve(); await gate.promise; return ready(); }, async () => { posts += 1; return response(); });
  const submissions = Array.from({ length: 20 }, () => transport.submit(request));
  await entered.promise;
  assert.equal(ensures, 1);
  assert.equal(posts, 0);
  gate.resolve();
  await Promise.all(submissions);
  assert.equal(ensures, 1);
  assert.equal(posts, 20);
  await transport.close();
});

test("refused query, reply observation, and submit share the same recovery promise", async () => {
  const entered = deferred();
  const gate = deferred();
  let ensures = 0;
  const methods = [];
  const transport = client(async () => { ensures += 1; entered.resolve(); await gate.promise; return ready(); }, async (url, options) => { methods.push(options.method); if (options.method === "GET") throw refused(); return response(); });
  const querying = assert.rejects(transport.query({ delivery_id: request.delivery_id }, { request }), { code: "codex_control_not_connected" });
  const observing = assert.rejects(transport.observeReply(request), { code: "codex_control_not_connected" });
  await entered.promise;
  const submitting = transport.submit(request);
  await delay(5);
  assert.equal(ensures, 1);
  assert.deepEqual(methods, ["GET", "GET"]);
  gate.resolve();
  await Promise.all([querying, observing, submitting]);
  assert.deepEqual(methods, ["GET", "GET", "POST"]);
  assert.equal(ensures, 1);
  await transport.close();
});

test("closing a rejected in-flight recovery still waits and retains the original receipt", async () => {
  const entered = deferred();
  const gate = deferred();
  let finished = false;
  const transport = client(async () => { entered.resolve(); await gate.promise; finished = true; throw Object.assign(new Error("fixture failure"), { receiptPath: "fixture-receipt.json", attemptId: "fixture-attempt" }); });
  const submitting = assert.rejects(transport.submit(request), error => error.details.request_sent === false && error.details.source_recovery.attemptId === "fixture-attempt");
  await entered.promise;
  let closed = false;
  const closing = transport.close().then(() => { closed = true; });
  await delay(5);
  assert.equal(closed, false);
  gate.resolve();
  await Promise.all([submitting, closing]);
  assert.equal(finished, true);
});

test("abort and close wait for the original ensure and prohibit late business fetch", async () => {
  const entered = deferred();
  const gate = deferred();
  const controller = new AbortController();
  let ensures = 0;
  let business = 0;
  let settled = false;
  let closed = false;
  const transport = client(async () => { ensures += 1; entered.resolve(); await gate.promise; return ready(); }, async () => { business += 1; return response(); });
  const first = transport.submit(request, { signal: controller.signal, onRequestStarted() { business += 1; } });
  const checked = assert.rejects(first, error => error.details.request_sent === false).then(() => { settled = true; });
  await entered.promise;
  controller.abort();
  const second = assert.rejects(transport.submit(request));
  const closing = transport.close().then(() => { closed = true; });
  await delay(15);
  assert.equal(settled, false);
  assert.equal(closed, false);
  assert.equal(ensures, 1);
  gate.resolve();
  await Promise.all([checked, second, closing]);
  assert.equal(business, 0);
  assert.equal(closed, true);
  assert.equal(transport.token, "");
});

test("already aborted or immediately closed transport cannot invoke ensure", async () => {
  let ensures = 0;
  const transport = client(async () => { ensures += 1; return ready(); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(transport.submit(request, { signal: controller.signal }));
  const pending = assert.rejects(transport.submit(request));
  await transport.close();
  await pending;
  assert.equal(ensures, 0);
});

test("only explicit refused GET prepares recovery without replaying or changing original ID", async () => {
  for (const observe of [false, true]) {
    const calls = [];
    const modes = [];
    const transport = client(async ({ mode }) => { modes.push(mode); return ready(); }, async (url, options) => { calls.push({ url, options }); throw refused(); });
    const operation = observe ? transport.observeReply(request) : transport.query({ delivery_id: request.delivery_id }, { request });
    await assert.rejects(operation, { code: "codex_control_not_connected" });
    assert.deepEqual(modes, ["ensure"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.body, undefined);
    assert.equal(new URL(calls[0].url).pathname, `/v1/communication/deliveries/${request.delivery_id}${observe ? "/replies" : ""}`);
    await transport.close();
  }
  let ensures = 0;
  const transport = client(async () => { ensures += 1; return ready(); }, async () => { throw Object.assign(new Error("read failure"), { code: "ECONNREFUSED", syscall: "read" }); });
  await assert.rejects(transport.query({ delivery_id: request.delivery_id }, { request }));
  assert.equal(ensures, 0);
  await transport.close();
});

test("unknown business path stays GET-only and POST refusal adds no second recovery", async () => {
  for (const error of [new Error("unknown business result"), refused()]) {
    const methods = [];
    let ensures = 0;
    const transport = client(async () => { ensures += 1; return ready(); }, async (url, options) => { methods.push(options.method); if (options.method === "POST") throw error; return response(); });
    const adapter = new CodexDeliveryAdapter({ transport });
    const first = await adapter.deliver(adapterInput());
    assert.equal(first.outcome, error.code ? "busy" : error.cause ? "busy" : "unknown");
    await adapter.deliver(adapterInput({ delivery: { ...adapterInput().delivery, status: "unknown" } }));
    assert.deepEqual(methods, ["POST", "GET"]);
    assert.equal(ensures, 1);
    await transport.close();
  }
});

test("core deadline preserves prepared, shares the still-running helper, and close drains it", async context => {
  const directory = await mkdtemp(join(tmpdir(), "core-source-recovery-deadline-"));
  const gate = deferred();
  let ensures = 0;
  let business = 0;
  let now = Date.parse("2030-01-01T00:00:00Z");
  const transport = client(async () => { ensures += 1; await gate.promise; return ready(); }, async () => { business += 1; return response(); });
  const store = new MessageStore({ filePath: join(directory, "core.sqlite") });
  const core = new CommunicationCore({ store, targets: [target], principals: [{ id: "source", identity: source, allowed_targets: [target.binding_id] }], adapters: { codex: new CodexDeliveryAdapter({ transport }) }, deliveryTimeoutMs: 20, now: () => now });
  context.after(async () => { gate.resolve(); await core.close(); await transport.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  await core.start();
  const original = await core.sendMessage({ principal_id: "source" }, { caller: source, origin: request.source.origin, target: Object.fromEntries(Object.entries(target).filter(([key]) => !["adapter_id", "capabilities", "evidence"].includes(key))), dedupe_key: "deadline-original", text: "fixture", expires_at: "2030-01-01T01:00:00Z" });
  await core.drain();
  let delivery = store.getDelivery(original.delivery.delivery_id);
  assert.equal(delivery.status, "prepared");
  assert.equal(delivery.evidence.evidence.kind, "query");
  assert.equal(delivery.evidence.evidence.request_sent, undefined);
  now += 1001;
  await core.dispatchPending();
  await core.drain();
  delivery = store.getDelivery(original.delivery.delivery_id);
  assert.equal(delivery.status, "prepared");
  assert.equal(delivery.attempt_count, 2);
  assert.equal(ensures, 1);
  await core.close();
  let closed = false;
  const closing = transport.close().then(() => { closed = true; });
  await delay(10);
  assert.equal(closed, false);
  gate.resolve();
  await closing;
  assert.equal(business, 0);
});

test("source-unavailable core retries the same original ID without claiming upstream busy proof", async context => {
  const directory = await mkdtemp(join(tmpdir(), "core-source-recovery-retry-"));
  let available = false;
  const modes = [];
  const bodies = [];
  let now = Date.parse("2030-01-01T00:00:00Z");
  const transport = client(async ({ mode }) => { modes.push(mode); return available ? ready() : { ok: false, status: "unavailable", changed: false }; }, async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    return Response.json({ ok: true, delivery: { ...body, thread_id: target.conversation_id, turn_id: "fixture-turn", outcome: "accepted", request_sent: true, injection_method: "turn/start" } });
  });
  const store = new MessageStore({ filePath: join(directory, "core.sqlite") });
  const core = new CommunicationCore({ store, targets: [target], principals: [{ id: "source", identity: source, allowed_targets: [target.binding_id] }], adapters: { codex: new CodexDeliveryAdapter({ transport }) }, now: () => now });
  context.after(async () => { await core.close(); await transport.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  await core.start();
  const original = await core.sendMessage({ principal_id: "source" }, { caller: source, origin: request.source.origin, target: Object.fromEntries(Object.entries(target).filter(([key]) => !["adapter_id", "capabilities", "evidence"].includes(key))), dedupe_key: "unavailable-original", text: "fixture", expires_at: "2030-01-01T01:00:00Z" });
  await core.drain();
  assert.equal(store.getDelivery(original.delivery.delivery_id).status, "prepared");
  assert.equal(bodies.length, 0);
  available = true;
  now += 1001;
  await core.dispatchPending();
  await core.drain();
  assert.equal(store.getDelivery(original.delivery.delivery_id).status, "accepted");
  assert.deepEqual(modes, ["ensure", "ensure"]);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].delivery_id, original.delivery.delivery_id);
  assert.equal(bodies[0].message_id, original.message.message_id);
  assert.equal(Object.hasOwn(bodies[0], "retry_failed_before_send"), false);
});
