import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { startLiveFromConfig } from "../src/live-runtime.mjs";
import { MockAdapter } from "../src/adapters/mock.mjs";
import { CoreError, digest } from "../src/contracts.mjs";

const CALLER = { machine_id: "synthetic-runtime-machine", host: "antigravity", surface: "desktop", conversation_id: "synthetic-runtime-model" };
const PRINCIPAL_ID = "synthetic-channel-principal";
const MODEL_BINDING = "synthetic-runtime-model-binding";
const QQ_BINDING = "synthetic-runtime-qq-binding";
const QQ_TARGET = "synthetic-runtime-qq-target";
const QQ_COMPONENT = "synthetic-runtime-napcat";
const QQ_CID = "synthetic-runtime-qq-component-cid";
const QQ_ID = "77000001";
const HASH = "a".repeat(64);
const WINDOW_KEY = `window:${digest(["qq", QQ_COMPONENT, "private", QQ_ID])}`;
const originalFetch = globalThis.fetch;
let networkAttempts = 0;

test.before(() => {
  globalThis.fetch = async () => { networkAttempts += 1; throw new Error("channel runtime fixtures forbid outbound network"); };
});
test.after(() => { globalThis.fetch = originalFetch; assert.equal(networkAttempts, 0); });

function configuration(permissions = {}, scoped = false) {
  return {
    adapter_mode: "live_test", host: "127.0.0.1", port: 0, window_ingress_enabled: false,
    allowed_conversation_ids: [CALLER.conversation_id, QQ_TARGET],
    adapters: [{ id: "synthetic-runtime-model-adapter", kind: "antigravity" },
      { id: "synthetic-runtime-qq-adapter", kind: "napcat_owner", base_url: "http://127.0.0.1:9/napcat/mcp",
        route_key: "synthetic-runtime-legacy-route", conversation_id: QQ_CID,
        reply_events: { enabled: true, target_key: QQ_TARGET, route_generation: 1, owner_sender_allowlist: [QQ_ID] } }],
    targets: [{ ...CALLER, binding_id: MODEL_BINDING, binding_generation: 1, adapter_id: "synthetic-runtime-model-adapter",
      capabilities: { next_model_boundary: true, when_idle: true }, evidence: "synthetic runtime fixture" },
    { machine_id: "synthetic-runtime-qq-machine", host: "qq", surface: "private", conversation_id: QQ_TARGET,
      binding_id: QQ_BINDING, binding_generation: 1, adapter_id: "synthetic-runtime-qq-adapter",
      capabilities: { next_model_boundary: true, when_idle: false }, evidence: "synthetic runtime fixture" }],
    principals: [{ id: PRINCIPAL_ID, token: "synthetic-runtime-channel-token",
      identity: { ...CALLER, ...(scoped ? { conversation_id: "*" } : {}) }, allowed_targets: [MODEL_BINDING, QQ_BINDING],
      ...(scoped ? { caller_scope: { machine_id: CALLER.machine_id, host: CALLER.host, surface: CALLER.surface } } : {}), ...permissions }],
    conversation_routes: [{ machine_id: CALLER.machine_id, host: CALLER.host, surface: CALLER.surface,
      adapter_id: "synthetic-runtime-model-adapter", capabilities: { next_model_boundary: true, when_idle: true } }],
    channel_windows: [{ channel: "qq", component: QQ_COMPONENT, window_type: "private", window_id: QQ_ID, binding_id: QQ_BINDING }],
  };
}

function provider(calls) {
  const transport = {
    async readConfiguredRecent(request, { signal }) {
      assert.ok(signal instanceof AbortSignal);
      assert.equal(request.target_key, QQ_TARGET);
      assert.equal(request.include_owner_event_content, true);
      calls.reads.push(structuredClone(request));
      return { ok: true, target: { type: "private", id: QQ_ID }, identity: { selfId: "77000009" },
        requestedCount: request.count, returnedCount: 1, messages: [{ messageId: "-88000002", messageSeq: "7",
          time: "2026-11-16T08:00:00.000Z", senderId: QQ_ID, isSelf: false,
          text: "  synthetic ordinary message without mention or quote\n  ", ownerEventContent: { text: "synthetic complete native body" },
          mentionedUserIds: [], replyMessageId: null, attachments: [{ type: "file", fileId: "synthetic-runtime-file",
            fileName: "synthetic-runtime.txt", fileBytes: 3, busId: 7, downloadable: true, attachment_ref: "synthetic-runtime-provider-ref" }] }] };
    },
    async downloadConfiguredFile(request, { signal }) {
      assert.ok(signal instanceof AbortSignal);
      assert.equal(request.target_key, QQ_TARGET);
      assert.equal(request.message_id, "-88000002");
      assert.equal(request.attachment_ref, "synthetic-runtime-provider-ref");
      calls.downloads.push(structuredClone(request));
      const fileName = request.name ?? "synthetic-runtime.txt";
      return { downloaded: true, fileId: "synthetic-runtime-file", resolvedFileId: "synthetic-runtime-resolved-file", resolvedBusId: 7,
        fileName, filePath: join(request.destination_dir, fileName), fileBytes: 3, sha256: HASH,
        target: { type: "private", id: QQ_ID }, identity: { selfId: "77000009" }, sourceMessageId: request.message_id,
        attachment_ref: request.attachment_ref };
    },
    async getOwnerWindowRoute() {
      calls.windowLookups += 1;
      throw new CoreError("OWNER_WINDOW_SCOPE_MISMATCH", "synthetic fixture has no native capture route");
    },
  };
  for (const method of ["registerOwnerWindowRoute", "closeOwnerWindowRoute", "readOwnerWindowEvents", "readOwnerEvents",
    "ackOwnerWindowEvents", "ackOwnerEvents", "ackProcessing", "ackTask"]) {
    transport[method] = async () => { calls.forbidden.push(method); throw new Error("ordinary history cannot collect or acknowledge events"); };
  }
  return transport;
}

async function fixture(context, value = configuration()) {
  const directory = await mkdtemp(join(tmpdir(), "communication-core-channel-runtime-"));
  const configPath = join(directory, "synthetic-config.json");
  const stateDir = join(directory, "synthetic-state");
  const calls = { reads: [], downloads: [], forbidden: [], windowLookups: 0, factories: 0 };
  const transport = provider(calls);
  const adapters = [];
  const errors = [];
  let service;
  const factories = {
    antigravity() { calls.factories += 1; const adapter = new MockAdapter(); adapters.push(adapter); return adapter; },
    napcat_owner(entry) {
      calls.factories += 1;
      assert.equal(entry.conversation_id, QQ_CID);
      assert.equal(entry.reply_events.targetKey, QQ_TARGET);
      const adapter = new MockAdapter();
      adapter.transport = transport;
      adapter.conversationId = entry.conversation_id;
      adapters.push(adapter);
      return adapter;
    },
  };
  context.after(async () => {
    await service?.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(calls.forbidden, []);
  });
  await writeFile(configPath, JSON.stringify(value), "utf8");
  return { directory, configPath, stateDir, value, calls, errors, adapters,
    async start() {
      service = await startLiveFromConfig({ configPath, stateDir, factories, onError: message => errors.push(message) });
      return service;
    } };
}

function request(caller = CALLER) {
  return { caller: { ...caller }, channel: "qq", window_type: "private", window_id: QQ_ID };
}

function contextForCaller() { return { principal_id: PRINCIPAL_ID, signal: new AbortController().signal }; }
function downloadRequest(reference, caller = CALLER) { return { ...request(caller), attachment_ref: reference }; }
function rejectsCode(expected) { return error => error instanceof CoreError && error.code === expected; }

test("config channel read and download grants accept QQ bindings and reject non-QQ or unknown bindings before startup", async context => {
  for (const field of ["allowed_channel_reads", "allowed_channel_downloads"]) {
    for (const binding of [MODEL_BINDING, "synthetic-missing-binding"]) {
      const files = await fixture(context, configuration({ [field]: [binding] }));
      await assert.rejects(files.start(), rejectsCode("invalid_config"));
      assert.equal(files.calls.factories, 0);
      await assert.rejects(stat(files.stateDir), { code: "ENOENT" });
    }
  }
});

test("config-loaded read and download permissions are independent and old omissions add no channel privileges", async context => {
  const cases = [
    { permissions: { allowed_channel_reads: [QQ_BINDING], allowed_channel_downloads: [QQ_BINDING] }, read: true, download: true },
    { permissions: { allowed_channel_reads: [QQ_BINDING] }, read: true, download: false },
    { permissions: { allowed_channel_downloads: [QQ_BINDING] }, read: false, download: true },
    { permissions: {}, read: false, download: false },
    { permissions: { allowed_channel_reads: [], allowed_channel_downloads: [] }, read: false, download: false },
  ];
  for (const current of cases) {
    const files = await fixture(context, configuration(current.permissions));
    const service = await files.start();
    const invocation = contextForCaller();
    const principal = service.core.principal(invocation, CALLER);
    assert.ok(principal.allowed_targets.includes(QQ_BINDING));
    for (const field of ["allowed_channel_reads", "allowed_channel_downloads"]) {
      assert.deepEqual(principal[field] ?? [], current.permissions[field] ?? []);
      assert.equal(Object.hasOwn(principal, field), Object.hasOwn(current.permissions, field));
    }
    let reference = "cc_attachment_not_issued_by_a_read";
    if (current.read) {
      const result = await service.core.readChannelMessages(invocation, request());
      reference = result.messages[0].attachments[0].attachment_ref;
    } else await assert.rejects(service.core.readChannelMessages(invocation, request()), rejectsCode("forbidden"));
    if (!current.download) await assert.rejects(service.core.downloadAttachment(invocation, downloadRequest(reference)), rejectsCode("forbidden"));
    else if (!current.read) await assert.rejects(service.core.downloadAttachment(invocation, downloadRequest(reference)), rejectsCode("invalid_attachment_ref"));
    else {
      principal.allowed_channel_reads = [];
      await assert.rejects(service.core.readChannelMessages(invocation, request()), rejectsCode("forbidden"));
      assert.equal((await service.core.downloadAttachment(invocation, downloadRequest(reference))).status, "downloaded");
    }
    assert.equal(files.calls.reads.length, current.read ? 1 : 0);
    assert.equal(files.calls.downloads.length, current.read && current.download ? 1 : 0);
    assert.deepEqual(files.errors, []);
    await service.close();
  }
});

test("caller_scope admits fresh concrete CIDs absent from config and retains caller-scoped attachment ownership", async context => {
  const value = configuration({ allowed_channel_reads: [QQ_BINDING], allowed_channel_downloads: [QQ_BINDING] }, true);
  const files = await fixture(context, value);
  const service = await files.start();
  const invocation = contextForCaller();
  const callers = Array.from({ length: 2 }, () => ({ ...CALLER, conversation_id: randomUUID() }));
  const references = [];
  for (const caller of callers) {
    assert.equal(value.allowed_conversation_ids.includes(caller.conversation_id), false);
    assert.equal(value.targets.some(target => target.conversation_id === caller.conversation_id), false);
    const result = await service.core.readChannelMessages(invocation, request(caller));
    references.push(result.messages[0].attachments[0].attachment_ref);
    assert.equal((await service.core.downloadAttachment(invocation, downloadRequest(references.at(-1), caller))).status, "downloaded");
  }
  assert.notEqual(references[0], references[1]);
  await assert.rejects(service.core.downloadAttachment(invocation, downloadRequest(references[0], callers[1])), rejectsCode("invalid_attachment_ref"));
  await assert.rejects(service.core.readChannelMessages(invocation, request({ ...callers[0], host: "codex" })), rejectsCode("caller_mismatch"));
  await assert.rejects(service.core.readChannelMessages(invocation, request({ ...callers[0], conversation_id: "*" })), rejectsCode("invalid_input"));
  assert.equal(service.core.principals.length, 1);
  assert.equal(service.core.principals[0].identity.conversation_id, "*");
  assert.deepEqual(JSON.parse(await readFile(files.configPath, "utf8")), value);
  assert.equal(files.calls.reads.length, 2);
  assert.equal(files.calls.downloads.length, 2);
});

test("configured ordinary history needs no active binding and neither activates capture nor acknowledges source events", async context => {
  const files = await fixture(context, configuration({ allowed_channel_reads: [QQ_BINDING] }));
  const service = await files.start();
  assert.ok(service.windowIngress);
  assert.equal(service.core.store.getChannelBinding(WINDOW_KEY) ?? null, null);
  await service.windowIngress.synchronize(WINDOW_KEY);
  assert.equal(service.windowIngress.getStatus(WINDOW_KEY).status, "idle");
  for (const method of ["manageChannelBinding", "ackProcessing"]) {
    service.core[method] = () => { files.calls.forbidden.push(`core.${method}`); throw new Error("ordinary history cannot bind a window or acknowledge processing"); };
  }
  const result = await service.core.readChannelMessages(contextForCaller(), request());
  assert.equal(result.messages[0].messageId, "-88000002");
  assert.equal(result.messages[0].text, "  synthetic ordinary message without mention or quote\n  ");
  assert.deepEqual(result.messages[0].ownerEventContent, { text: "synthetic complete native body" });
  assert.equal(result.source.consumes_events, false);
  assert.equal(result.source.kind, "external_channel_history");
  await service.windowIngress.poll(WINDOW_KEY);
  assert.equal(service.core.store.getChannelBinding(WINDOW_KEY) ?? null, null);
  assert.notEqual(service.windowIngress.getStatus(WINDOW_KEY).status, "ready");
  assert.deepEqual(files.calls.forbidden, []);
  assert.equal(files.calls.reads.length, 1);
  assert.equal(files.calls.downloads.length, 0);
  assert.ok(files.adapters.every(adapter => adapter.calls.length === 0 && adapter.queries.length === 0));
  assert.deepEqual(files.errors, []);
});

test("an unreadable download journal disables only downloads and preserves ordinary history and the original state", async context => {
  const files = await fixture(context, configuration({ allowed_channel_reads: [QQ_BINDING], allowed_channel_downloads: [QQ_BINDING] }));
  const ledgerDirectory = join(files.stateDir, "channel-downloads");
  await mkdir(ledgerDirectory, { recursive: true });
  const unexpected = join(ledgerDirectory, "synthetic-unknown-file.txt");
  await writeFile(unexpected, "preserve synthetic original", "utf8");
  const service = await files.start();
  const result = await service.core.readChannelMessages(contextForCaller(), request());
  assert.equal(result.messages[0].messageId, "-88000002");
  assert.equal(result.messages[0].attachments[0].downloadable, false);
  assert.equal(result.messages[0].attachments[0].attachment_ref, undefined);
  assert.equal(result.download_service.available, false);
  await assert.rejects(service.core.downloadAttachment(contextForCaller(), downloadRequest("synthetic-stale-ref")), rejectsCode("channel_download_state_unavailable"));
  assert.equal(await readFile(unexpected, "utf8"), "preserve synthetic original");
  assert.equal(files.calls.downloads.length, 0);
  assert.equal(files.calls.reads.length, 1);
  assert.equal(files.errors.length, 1);
});
