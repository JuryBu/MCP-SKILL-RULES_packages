import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { CoreError, digest } from "../src/contracts.mjs";
import { ChannelContentReader } from "../src/channel-content.mjs";

const CALLER = { machine_id: "synthetic-core-machine", host: "codex", surface: "desktop", conversation_id: "synthetic-reader-chat" };
const OTHER_CALLER = { ...CALLER, conversation_id: "synthetic-other-chat" };
const SECRET = "synthetic-private-error";
const HASH = "a".repeat(64);

function source(type = "private", overrides = {}) {
  const windowId = type === "private" ? "77000001" : "88000001";
  const component = "synthetic-napcat";
  return { window_key: `window:${digest(["qq", component, type, windowId])}`, channel: "qq", component,
    window_type: type, window_id: windowId, channel_binding_id: `synthetic-${type}-binding`,
    target_key: `synthetic-${type}-target`, conversation_id: "synthetic-core-component", owner_sender_allowlist: ["77000001"],
    source_target: { machine_id: "synthetic-qq-machine", host: "qq", surface: type, conversation_id: `synthetic-${type}-target`,
      binding_id: `synthetic-${type}-binding`, binding_generation: 3, adapter_id: "synthetic-adapter" }, ...overrides };
}

function attachment(overrides = {}) {
  return { type: "file", fileId: "synthetic-original-file", fileName: "原始附件.txt", fileBytes: 3, busId: 7,
    downloadable: true, attachment_ref: "synthetic-provider-reference", ...overrides };
}

function message(overrides = {}) {
  return { messageId: "-88000002", messageSeq: "7", time: "2026-11-16T07:00:00.000Z", senderId: "77000002",
    senderName: "synthetic sender", isSelf: false, text: "  普通消息，没有提及，也没有引用\n  ",
    ownerEventContent: { text: `  ${"完整正文".repeat(600)}\n  ` }, mentionedUserIds: [], replyMessageId: null,
    attachments: [attachment()], ...overrides };
}

function deferred() {
  let finish;
  const promise = new Promise(resolveResult => { finish = resolveResult; });
  return { promise, finish };
}

function fixture(context, options = {}) {
  const sources = options.sources ?? [source(), source("group")];
  const calls = { reads: [], downloads: [], closed: 0 };
  const scopeFor = request => sources.find(candidate => candidate.target_key === request.target_key);
  const pageFor = request => {
    const selected = scopeFor(request);
    return { ok: true, target: { type: selected.window_type, id: selected.window_id }, identity: { selfId: "77000009" },
      requestedCount: request.count, returnedCount: 1, messages: [message()] };
  };
  const downloadedFor = request => {
    const selected = scopeFor(request);
    const name = request.name ?? "原始附件.txt";
    return { downloaded: true, fileId: "synthetic-original-file", resolvedFileId: "synthetic-resolved-file", resolvedBusId: 7,
      fileName: name, filePath: join(request.destination_dir, name), fileBytes: 3, sha256: HASH,
      target: { type: selected.window_type, id: selected.window_id }, identity: { selfId: "77000009" },
      sourceMessageId: request.message_id, attachment_ref: request.attachment_ref };
  };
  const transport = {
    async readConfiguredRecent(request, invocation) {
      calls.reads.push({ request, invocation });
      return options.read ? options.read(request, invocation, pageFor) : pageFor(request);
    },
    async downloadConfiguredFile(request, invocation) {
      calls.downloads.push({ request, invocation });
      return options.download ? options.download(request, invocation, downloadedFor) : downloadedFor(request);
    },
    async close() { calls.closed += 1; },
    async ack() { throw new Error("ordinary history must never ACK events"); },
    async registerOwnerWindowRoute() { throw new Error("ordinary history must not enable capture"); },
  };
  const adapter = { transport, conversationId: "synthetic-core-component", closed: false };
  const adapters = new Map([["synthetic-adapter", adapter]]);
  const principal = { id: "synthetic-principal", identity: { ...CALLER }, allowed_channel_reads: sources.map(entry => entry.channel_binding_id),
    allowed_channel_downloads: sources.map(entry => entry.channel_binding_id), allowed_targets: ["*"] };
  const reader = new ChannelContentReader({ sources, adapters, ...(options.now ? { now: options.now } : {}) });
  context.after(() => { reader.close(); assert.equal(calls.closed, 0); });
  const readInput = (type = "private", overrides = {}) => {
    const selected = sources.find(entry => entry.window_type === type);
    return { caller: { ...CALLER }, channel: "qq", window_type: type, window_id: selected.window_id, ...overrides };
  };
  const read = (overrides = {}) => reader.read(principal, readInput("private", overrides));
  const downloadInput = (reference, overrides = {}) => ({ ...readInput(), attachment_ref: reference, ...overrides });
  const firstReference = async () => (await read()).messages[0].attachments[0].attachment_ref;
  return { reader, principal, adapter, adapters, transport, sources, calls, readInput, read, downloadInput, firstReference, pageFor, downloadedFor };
}

function code(expected) {
  return error => { assert.ok(error instanceof CoreError); assert.equal(error.code, expected); return true; };
}

test("ordinary private and group messages retain native full text and never require window binding or collection", async context => {
  const current = fixture(context, { now: () => Date.parse("2026-11-16T07:00:00.000Z"), read(request, invocation, pageFor) {
    const output = pageFor(request);
    output.messages.push(message({ messageId: "88000003", isSelf: true, attachments: [] }));
    output.returnedCount = 2;
    return output;
  } });
  for (const type of ["private", "group"]) {
    const result = await current.reader.read(current.principal, current.readInput(type));
    assert.equal(result.returnedCount, 2);
    assert.equal(result.messages[0].text, message().text);
    assert.deepEqual(result.messages[0].ownerEventContent, message().ownerEventContent);
    assert.equal(result.messages[1].isSelf, true);
    assert.equal(result.window.window_type, type);
    assert.equal(result.observed_at, "2026-11-16T07:00:00.000Z");
    assert.equal(result.source.kind, "external_channel_history");
    assert.equal(result.source.consumes_events, false);
    assert.equal(Object.hasOwn(result, "has_more"), false);
    assert.equal(Object.hasOwn(result, "next_cursor"), false);
    assert.match(result.messages[0].attachments[0].attachment_ref, /^cc_attachment_/);
    assert.notEqual(result.messages[0].attachments[0].attachment_ref, attachment().attachment_ref);
    assert.equal(JSON.stringify(result).includes(attachment().attachment_ref), false);
  }
  assert.deepEqual(current.calls.reads.map(entry => entry.request), [
    { target_key: "synthetic-private-target", count: 20, include_owner_event_content: true },
    { target_key: "synthetic-group-target", count: 20, include_owner_event_content: true },
  ]);
});

test("read and download grants are independent and allowed_targets never expands them", async context => {
  const current = fixture(context);
  current.principal.allowed_channel_downloads = [];
  const reference = await current.firstReference();
  await assert.rejects(current.reader.download(current.principal, current.downloadInput(reference)), code("forbidden"));
  delete current.principal.allowed_channel_reads;
  await assert.rejects(current.read(), code("forbidden"));
  current.principal.allowed_channel_downloads = ["synthetic-private-binding"];
  assert.equal((await current.reader.download(current.principal, current.downloadInput(reference))).downloaded, true);
  assert.equal(current.calls.reads.length, 1);
  assert.equal(current.calls.downloads.length, 1);
});

test("caller, input field allowlists, plain objects and count bounds fail before provider calls", async context => {
  const current = fixture(context);
  const inherited = Object.create(current.readInput());
  const accessor = Object.defineProperty(current.readInput(), "cursor", { enumerable: true, get() { throw new Error(SECRET); } });
  const symbol = Object.assign(current.readInput(), { [Symbol("secret")]: SECRET });
  const proxy = new Proxy(current.readInput(), { ownKeys() { throw new Error(SECRET); } });
  const inputs = [inherited, accessor, symbol, proxy, [], null,
    current.readInput("private", { count: null }), current.readInput("private", { count: 0 }),
    current.readInput("private", { count: 51 }), current.readInput("private", { count: 1.5 }),
    current.readInput("private", { target_key: "unconfigured" }), current.readInput("private", { caller: { ...CALLER, conversation_id: "*" } }),
    current.readInput("private", { caller: { ...CALLER, surface: undefined } })];
  for (const input of inputs) await assert.rejects(current.reader.read(current.principal, input), code("invalid_input"));
  await assert.rejects(current.read({ caller: OTHER_CALLER }), code("caller_mismatch"));
  await assert.rejects(current.read({ channel: "wechat" }), code("channel_not_enabled"));
  await assert.rejects(current.read({ window_id: "99000001" }), code("channel_not_enabled"));
  await assert.rejects(current.reader.read(current.principal, current.readInput(), { signal: {} }), code("invalid_input"));
  assert.equal(current.calls.reads.length, 0);
  const nullPrototype = Object.assign(Object.create(null), current.readInput("private", { count: 1 }));
  assert.equal((await current.reader.read(current.principal, nullPrototype)).returnedCount, 1);
});

test("ambiguous sources and source target mismatches fail without provider activity", async context => {
  const ambiguous = fixture(context, { sources: [source(), source("private", { component: "another-provider" })] });
  await assert.rejects(ambiguous.read(), code("channel_window_ambiguous"));
  const mismatched = fixture(context);
  mismatched.sources[0].source_target.conversation_id = "wrong-target";
  await assert.rejects(mismatched.read(), code("channel_content_scope_mismatch"));
  assert.equal(ambiguous.calls.reads.length + mismatched.calls.reads.length, 0);
});

test("provider target, counts and original message IDs are verified", async context => {
  const mutations = [
    output => { output.target.id = "99000001"; },
    output => { output.target.type = "group"; },
    output => { output.target.target_key = "other-target"; },
    output => { output.returnedCount = 0; },
    output => { output.requestedCount = 19; },
    output => { output.ok = false; },
    output => { output.messages[0].messageId = "not-a-message-id"; },
    output => { output.messages[0].messageId = Number.MAX_SAFE_INTEGER + 1; },
  ];
  for (const mutate of mutations) {
    const current = fixture(context, { read(request, invocation, pageFor) { const output = pageFor(request); mutate(output); return output; } });
    await assert.rejects(current.read(), error => error instanceof CoreError && ["channel_content_scope_mismatch", "channel_content_invalid"].includes(error.code));
  }
});

test("provider-only cursors cannot be forged, changed across callers or windows, or reused after expiration", async context => {
  let now = Date.parse("2026-11-16T07:00:00.000Z");
  const current = fixture(context, { now: () => now, read(request, invocation, pageFor) { return { ...pageFor(request), next_cursor: "-88000009" }; } });
  const first = await current.read();
  assert.match(first.next_cursor, /^cc_cursor_/);
  await current.read({ cursor: first.next_cursor });
  assert.equal(current.calls.reads[1].request.before_message_id, "-88000009");
  const reads = current.calls.reads.length;
  const otherPrincipal = { ...current.principal, identity: OTHER_CALLER };
  await assert.rejects(current.reader.read(otherPrincipal, current.readInput("private", { caller: OTHER_CALLER, cursor: first.next_cursor })), code("invalid_cursor"));
  await assert.rejects(current.reader.read(current.principal, current.readInput("group", { cursor: first.next_cursor })), code("invalid_cursor"));
  await assert.rejects(current.read({ cursor: `${first.next_cursor}x` }), code("invalid_cursor"));
  await assert.rejects(current.read({ cursor: Buffer.from(JSON.stringify({ before_message_id: "-88000009" })).toString("base64url") }), code("invalid_cursor"));
  now += 30 * 60 * 1000 + 1;
  await assert.rejects(current.read({ cursor: first.next_cursor }), code("invalid_cursor"));
  assert.equal(current.calls.reads.length, reads);
});

test("only actual read attachments yield scoped references; raw URLs, file IDs and foreign references are rejected", async context => {
  const current = fixture(context, { read(request, invocation, pageFor) {
    const output = pageFor(request);
    output.messages[0].attachments.push(attachment({ type: "image", attachment_ref: undefined, url: "https://example.invalid/image", downloadable: true }));
    return output;
  } });
  const output = await current.read();
  const reference = output.messages[0].attachments[0].attachment_ref;
  assert.equal(output.messages[0].attachments[1].downloadable, false);
  assert.equal(Object.hasOwn(output.messages[0].attachments[1], "attachment_ref"), false);
  for (const invalid of [attachment().attachment_ref, attachment().fileId, "https://example.invalid/file", `${reference}x`]) {
    await assert.rejects(current.reader.download(current.principal, current.downloadInput(invalid)), code("invalid_attachment_ref"));
  }
  const otherPrincipal = { ...current.principal, identity: OTHER_CALLER };
  await assert.rejects(current.reader.download(otherPrincipal, current.downloadInput(reference, { caller: OTHER_CALLER })), code("invalid_attachment_ref"));
  await assert.rejects(current.reader.download(current.principal, { ...current.readInput("group"), attachment_ref: reference }), code("invalid_attachment_ref"));
  assert.equal(current.calls.downloads.length, 0);
});

test("default download is task-owned Temp, forwards only original provenance, and successful repeats return the same result", async context => {
  const current = fixture(context);
  const reference = await current.firstReference();
  const first = await current.reader.download(current.principal, current.downloadInput(reference));
  const repeated = await current.reader.download(current.principal, current.downloadInput(reference));
  assert.deepEqual(repeated, first);
  assert.equal(first.downloaded, true);
  assert.equal(first.attachment_ref, reference);
  assert.equal(first.sourceMessageId, "-88000002");
  assert.equal(first.sha256, HASH);
  assert.ok(first.destination_dir.startsWith(join(tmpdir(), "communication-core-channel-content")));
  assert.equal(current.calls.downloads.length, 1);
  assert.deepEqual(current.calls.downloads[0].request, { target_key: "synthetic-private-target", message_id: "-88000002",
    attachment_ref: attachment().attachment_ref, destination_dir: first.destination_dir });
  first.identity.selfId = "tampered";
  assert.equal((await current.reader.download(current.principal, current.downloadInput(reference))).identity.selfId, "77000009");
});

test("explicit directories are absolute, names are single safe filenames and changing parameters is rejected", async context => {
  const current = fixture(context);
  const reference = await current.firstReference();
  for (const parameters of [
    { destination_dir: "relative-directory" }, { destination_dir: "https://example.invalid/path" },
    ...["../bad.txt", "..\\bad.txt", "name:stream", "NUL.txt", "bad.", "bad ", "nested/name.txt", "nested\\name.txt"].map(name => ({ name })),
    { fileId: attachment().fileId }, { url: "https://example.invalid/file" },
  ]) await assert.rejects(current.reader.download(current.principal, current.downloadInput(reference, parameters)), code("invalid_input"));
  await assert.rejects(current.reader.download(current.principal, current.downloadInput(reference), { signal: {} }), code("invalid_input"));
  const destination = join(tmpdir(), "synthetic-explicit-destination-中文 空格");
  const result = await current.reader.download(current.principal, current.downloadInput(reference, { destination_dir: destination, name: "显式附件.txt" }));
  assert.equal(result.destination_dir, resolve(destination));
  assert.equal(result.fileName, "显式附件.txt");
  await assert.rejects(current.reader.download(current.principal, current.downloadInput(reference, { destination_dir: destination, name: "changed.txt" })), code("download_parameters_changed"));
  await assert.rejects(current.reader.download(current.principal, current.downloadInput(reference)), code("download_parameters_changed"));
  assert.equal(current.calls.downloads.length, 1);
});

test("concurrent identical downloads share exactly one provider operation", async context => {
  const pending = deferred();
  let complete;
  const current = fixture(context, { download(request, invocation, downloadedFor) { complete = () => pending.finish(downloadedFor(request)); return pending.promise; } });
  const reference = await current.firstReference();
  const first = current.reader.download(current.principal, current.downloadInput(reference));
  const second = current.reader.download(current.principal, current.downloadInput(reference));
  assert.equal(current.calls.downloads.length, 1);
  await assert.rejects(current.reader.download(current.principal, current.downloadInput(reference, { name: "changed.txt" })), code("download_parameters_changed"));
  complete();
  assert.deepEqual(await first, await second);
});

test("an unconfirmed provider failure stays unknown and rereading cannot submit a replacement request", async context => {
  let providerReference = "synthetic-provider-first";
  const current = fixture(context, { read(request, invocation, pageFor) {
    const output = pageFor(request);
    output.messages[0].attachments[0].attachment_ref = providerReference;
    return output;
  }, download() { throw new Error(SECRET); } });
  const reference = await current.firstReference();
  const first = await current.reader.download(current.principal, current.downloadInput(reference));
  assert.equal(first.status, "unknown");
  assert.equal(first.requires_original_result_check, true);
  assert.equal(first.retry_allowed, false);
  assert.equal(first.status_query_supported, false);
  assert.equal(JSON.stringify(first).includes(SECRET), false);
  providerReference = "synthetic-provider-reread";
  const reread = await current.firstReference();
  assert.equal(reread, reference);
  assert.deepEqual(await current.reader.download(current.principal, current.downloadInput(reread)), first);
  assert.equal(current.calls.downloads.length, 1);
});

test("rotating provider refs without fileId cannot escape an unknown download", async context => {
  let generation = 0;
  const current = fixture(context, { read(request, invocation, pageFor) {
    const output = pageFor(request);
    output.messages[0].attachments = [attachment({ fileId: undefined, attachment_ref: `synthetic-provider-${generation++}` })];
    return output;
  }, download() { throw new Error(SECRET); } });
  const reference = await current.firstReference();
  await current.reader.download(current.principal, current.downloadInput(reference));
  assert.equal(await current.firstReference(), reference);
  assert.equal(current.calls.downloads.length, 1);
});

test("cancellation after submission preserves unknown, detaches the caller listener, and accepts the eventual original result", async context => {
  const pending = deferred();
  let complete;
  const current = fixture(context, { download(request, invocation, downloadedFor) { complete = () => pending.finish(downloadedFor(request)); return pending.promise; } });
  const reference = await current.firstReference();
  const cancellation = new AbortController();
  const waiting = current.reader.download(current.principal, current.downloadInput(reference), { signal: cancellation.signal });
  cancellation.abort(new Error(SECRET));
  const first = await waiting;
  assert.equal(first.status, "unknown");
  assert.equal((await current.reader.download(current.principal, current.downloadInput(reference))).status, "unknown");
  assert.equal(current.calls.downloads.length, 1);
  complete();
  await nextTurn();
  const confirmed = await current.reader.download(current.principal, current.downloadInput(reference));
  assert.equal(confirmed.status, "downloaded");
  assert.equal(confirmed.operation_id, first.operation_id);
  assert.equal(getEventListeners(current.calls.downloads[0].invocation.signal, "abort").length, 0);
});

test("pre-cancelled requests perform no download and leave the unsubmitted reference usable", async context => {
  const current = fixture(context);
  const reference = await current.firstReference();
  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(current.reader.download(current.principal, current.downloadInput(reference), { signal: cancellation.signal }), code("request_aborted"));
  assert.equal(current.calls.downloads.length, 0);
  assert.equal((await current.reader.download(current.principal, current.downloadInput(reference))).downloaded, true);
});

test("positive request_sent=false is retained as a before-send failure without auto retry", async context => {
  const current = fixture(context, { download() { throw new CoreError("napcat_mcp_unconfirmed", SECRET, { request_sent: false }); } });
  const reference = await current.firstReference();
  const first = await current.reader.download(current.principal, current.downloadInput(reference));
  assert.equal(first.status, "failed_before_send");
  assert.equal(first.request_sent, false);
  assert.equal(first.outcome_unknown, false);
  assert.equal(first.requires_original_result_check, false);
  assert.deepEqual(await current.reader.download(current.principal, current.downloadInput(reference)), first);
  assert.equal(current.calls.downloads.length, 1);
});

test("an explicitly confirmed provider failure stays failed and never exposes raw provider fields", async context => {
  const current = fixture(context, { download() {
    throw new CoreError("channel_operation_failed", SECRET, { outcome_unknown: false, request_sent: true,
      provider_code: "DOWNLOAD_TARGET_EXISTS", message: SECRET, private_path: SECRET });
  } });
  const reference = await current.firstReference();
  const first = await current.reader.download(current.principal, current.downloadInput(reference));
  assert.equal(first.status, "failed");
  assert.equal(first.request_sent, true);
  assert.equal(first.outcome_unknown, false);
  assert.equal(first.requires_original_result_check, false);
  assert.equal(first.provider_code, "DOWNLOAD_TARGET_EXISTS");
  assert.equal(JSON.stringify(first).includes(SECRET), false);
  assert.deepEqual(await current.reader.download(current.principal, current.downloadInput(reference)), first);
  assert.equal(current.calls.downloads.length, 1);
});

test("provider outcomeUnknown=true is never relabelled as a confirmed failure", async context => {
  const current = fixture(context, { download() {
    throw new CoreError("napcat_mcp_unconfirmed", SECRET, { outcome_unknown: true, request_sent: true, provider_code: "DOWNLOAD_FAILED" });
  } });
  const reference = await current.firstReference();
  const output = await current.reader.download(current.principal, current.downloadInput(reference));
  assert.equal(output.status, "unknown");
  assert.equal(output.outcome_unknown, true);
  assert.equal(Object.hasOwn(output, "provider_code"), false);
});

test("a cancellation racing after a confirmed failure cannot overwrite that failure with unknown", async context => {
  const current = fixture(context, { download() {
    throw new CoreError("channel_operation_failed", SECRET, { outcome_unknown: false, request_sent: true, provider_code: "FILE_TOO_LARGE" });
  } });
  const reference = await current.firstReference();
  const cancellation = new AbortController();
  const waiting = current.reader.download(current.principal, current.downloadInput(reference), { signal: cancellation.signal });
  queueMicrotask(() => cancellation.abort());
  assert.equal((await waiting).status, "failed");
  assert.equal((await current.reader.download(current.principal, current.downloadInput(reference))).status, "failed");
  assert.equal(current.calls.downloads.length, 1);
});

test("download target, original message, provider ref, file path, size and SHA256 mismatches retain unknown", async context => {
  const mutations = [
    output => { output.target.id = "99000001"; }, output => { output.sourceMessageId = "-88000003"; },
    output => { output.attachment_ref = "foreign-reference"; }, output => { output.filePath = join(tmpdir(), "outside-destination.txt"); },
    output => { output.fileId = "foreign-file"; }, output => { output.fileBytes = 4; }, output => { output.sha256 = "bad"; },
    output => { output.fileName = "../bad.txt"; }, output => { output.downloaded = false; },
  ];
  for (const mutate of mutations) {
    const current = fixture(context, { download(request, invocation, downloadedFor) { const output = downloadedFor(request); mutate(output); return output; } });
    const reference = await current.firstReference();
    const output = await current.reader.download(current.principal, current.downloadInput(reference));
    assert.equal(output.status, "unknown");
    assert.equal(Object.hasOwn(output, "filePath"), false);
    await current.reader.download(current.principal, current.downloadInput(reference));
    assert.equal(current.calls.downloads.length, 1);
  }
});

test("expired unused references require rereading while unknown attempts remain pinned across the expiry", async context => {
  let now = Date.parse("2026-11-16T07:00:00.000Z");
  const current = fixture(context, { now: () => now, download() { throw new Error(SECRET); } });
  const expired = await current.firstReference();
  now += 30 * 60 * 1000 + 1;
  await assert.rejects(current.reader.download(current.principal, current.downloadInput(expired)), code("invalid_attachment_ref"));
  const reference = await current.firstReference();
  await current.reader.download(current.principal, current.downloadInput(reference));
  now += 30 * 60 * 1000 + 1;
  assert.equal(await current.firstReference(), reference);
  assert.equal((await current.reader.download(current.principal, current.downloadInput(reference))).status, "unknown");
  assert.equal(current.calls.downloads.length, 1);
});

test("the in-memory attachment cache refuses capacity growth and frees only expired unused references", async context => {
  let now = Date.parse("2026-11-16T07:00:00.000Z");
  let page = 0;
  const current = fixture(context, { now: () => now, read(request, invocation, pageFor) {
    const output = pageFor(request);
    output.messages[0].attachments = Array.from({ length: 64 }, (unused, index) => attachment({
      fileId: `synthetic-file-${page}-${index}`, attachment_ref: `synthetic-provider-${page}-${index}`,
    }));
    page += 1;
    return output;
  } });
  for (let index = 0; index < 16; index += 1) await current.read();
  await assert.rejects(current.read(), code("channel_content_capacity"));
  assert.equal(current.calls.downloads.length, 0);
  now += 30 * 60 * 1000 + 1;
  assert.equal((await current.read()).messages[0].attachments.length, 64);
});

test("the cursor cache is bounded and evicting an old cursor never submits an inferred page", async context => {
  const current = fixture(context, { read(request, invocation, pageFor) { return { ...pageFor(request), next_cursor: "-88000009" }; } });
  const first = await current.read();
  let latest;
  for (let index = 0; index < 256; index += 1) latest = await current.read();
  const before = current.calls.reads.length;
  await assert.rejects(current.read({ cursor: first.next_cursor }), code("invalid_cursor"));
  assert.equal(current.calls.reads.length, before);
  await current.read({ cursor: latest.next_cursor });
  assert.equal(current.calls.reads.at(-1).request.before_message_id, "-88000009");
});

test("attachment metadata rejects oversized strings and non-scalar or unsafe numeric fields", async context => {
  const invalidMetadata = [
    { type: "t".repeat(33) }, { type: {} }, { fileId: "f".repeat(4097) }, { fileId: null },
    { fileName: "名".repeat(342) }, { fileName: "n".repeat(2 * 1024 * 1024) }, { fileName: {} },
    { mime: "m".repeat(129) }, { mimeType: "m".repeat(129) }, { mime: [] },
    { fileBytes: "3" }, { fileBytes: 1.5 }, { fileBytes: -1 }, { fileBytes: Number.MAX_SAFE_INTEGER + 1 },
    { busId: Infinity }, { busId: -1 }, { width: NaN }, { width: [1] }, { height: -1 },
    { sha256: "bad" }, { sha256: {} }, { downloadable: "true" },
    Object.fromEntries(Array.from({ length: 33 }, (unused, index) => [`extra-${index}`, 0])),
  ];
  for (const metadata of invalidMetadata) {
    const current = fixture(context, { read(request, invocation, pageFor) {
      const output = pageFor(request);
      output.messages[0].attachments = [attachment(metadata)];
      return output;
    } });
    await assert.rejects(current.read(), code("channel_content_invalid"));
    assert.equal(current.calls.downloads.length, 0);
  }
});

test("valid attachment field boundaries stay below 16KB and unneeded URLs are discarded", async context => {
  const current = fixture(context, { read(request, invocation, pageFor) {
    const output = pageFor(request);
    output.messages[0].attachments = [attachment({ fileId: "f".repeat(4096), fileName: "名".repeat(341),
      mime: "m".repeat(128), mimeType: "m".repeat(128), fileBytes: Number.MAX_SAFE_INTEGER,
      busId: Number.MAX_SAFE_INTEGER, width: 0, height: Number.MAX_SAFE_INTEGER, sha256: HASH,
      url: `https://example.invalid/not-retained/${"x".repeat(4 * 1024 * 1024)}` })];
    return output;
  } });
  const result = await current.read();
  const metadata = result.messages[0].attachments[0];
  assert.equal(metadata.fileId.length, 4096);
  assert.equal(Buffer.byteLength(metadata.fileName, "utf8"), 1023);
  assert.equal(metadata.mime.length, 128);
  assert.equal(Object.hasOwn(metadata, "url"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(metadata), "utf8") <= 16 * 1024);
  assert.equal(JSON.stringify(result).includes("https://example.invalid/not-retained"), false);
});

test("copyData counts numeric array nodes even when no string bytes are present", async context => {
  const current = fixture(context, { read(request, invocation, pageFor) {
    const output = pageFor(request);
    output.messages[0].ownerEventContent = { numeric: Array.from({ length: 130 }, () => Array.from({ length: 512 }, () => 0)) };
    return output;
  } });
  await assert.rejects(current.read(), error => {
    assert.ok(error instanceof CoreError);
    assert.equal(error.code, "channel_content_invalid");
    assert.equal(error.details.budget, "nodes");
    return true;
  });
});

test("copyData bounds total object keys before copying a numeric-only wide object", async context => {
  const current = fixture(context, { read(request, invocation, pageFor) {
    const output = pageFor(request);
    output.messages[0].ownerEventContent = Object.fromEntries(Array.from({ length: 32769 }, (unused, index) => [`field-${index}`, 0]));
    return output;
  } });
  await assert.rejects(current.read(), error => {
    assert.ok(error instanceof CoreError);
    assert.equal(error.code, "channel_content_invalid");
    assert.equal(error.details.budget, "keys");
    return true;
  });
});

test("repeated late message, byte, identity and cursor failures never consume invisible attachment slots", async context => {
  let mode = "message";
  let page = 0;
  const oversized = "x".repeat(4 * 1024 * 1024 + 1);
  const current = fixture(context, { read(request, invocation, pageFor) {
    const output = pageFor(request);
    output.messages[0].attachments = Array.from({ length: 64 }, (unused, index) => attachment({
      fileId: `synthetic-transaction-${page}-${index}`, attachment_ref: `synthetic-transaction-ref-${page}-${index}`,
    }));
    page += 1;
    if (mode === "message") output.messages.push(message({ messageId: "invalid", attachments: [] }));
    if (mode === "bytes") output.messages.push(message({ messageId: "88000004", text: oversized, attachments: [] }));
    if (mode === "identity") output.identity = { nickname: oversized };
    if (mode === "cursor") output.next_cursor = 1;
    output.returnedCount = output.messages.length;
    return output;
  } });
  for (let index = 0; index < 17; index += 1) await assert.rejects(current.read(), code("channel_content_invalid"));
  for (const failure of ["bytes", "identity", "cursor"]) {
    mode = failure;
    await assert.rejects(current.read(), code(failure === "cursor" ? "invalid_input" : "channel_content_invalid"));
  }
  mode = "valid";
  for (let index = 0; index < 16; index += 1) assert.equal((await current.read()).messages[0].attachments.length, 64);
  await assert.rejects(current.read(), code("channel_content_capacity"));
  assert.equal(current.calls.downloads.length, 0);
});

test("a failed page cannot replace an existing reference's provider ref or retained size", async context => {
  let mode = "valid";
  const current = fixture(context, { read(request, invocation, pageFor) {
    const output = pageFor(request);
    output.messages[0].attachments = [attachment({ attachment_ref: mode === "valid" ? "synthetic-initial-ref" : "synthetic-uncommitted-ref",
      fileBytes: mode === "valid" ? 3 : 4 })];
    if (mode === "invalid") {
      output.messages.push(message({ messageId: "invalid", attachments: [] }));
      output.returnedCount = 2;
    }
    return output;
  } });
  const reference = await current.firstReference();
  mode = "invalid";
  await assert.rejects(current.read(), code("channel_content_invalid"));
  assert.equal((await current.reader.download(current.principal, current.downloadInput(reference))).status, "downloaded");
  assert.equal(current.calls.downloads[0].request.attachment_ref, "synthetic-initial-ref");
});

test("capacity failure commits neither new references nor updates to an existing reference", async context => {
  let page = 0;
  let full = false;
  const current = fixture(context, { read(request, invocation, pageFor) {
    const output = pageFor(request);
    output.messages[0].attachments = full ? [
      attachment({ fileId: "synthetic-capacity-0-0", attachment_ref: "synthetic-uncommitted-capacity-ref", fileBytes: 4 }),
      attachment({ fileId: "synthetic-capacity-new", attachment_ref: "synthetic-capacity-new-ref" }),
    ] : Array.from({ length: 64 }, (unused, index) => attachment({ fileId: `synthetic-capacity-${page}-${index}`,
      attachment_ref: `synthetic-capacity-ref-${page}-${index}` }));
    page += 1;
    return output;
  }, download(request, invocation, downloadedFor) {
    return { ...downloadedFor(request), fileId: "synthetic-capacity-0-0" };
  } });
  const reference = await current.firstReference();
  for (let index = 1; index < 16; index += 1) await current.read();
  full = true;
  await assert.rejects(current.read(), code("channel_content_capacity"));
  assert.equal((await current.reader.download(current.principal, current.downloadInput(reference))).status, "downloaded");
  assert.equal(current.calls.downloads[0].request.attachment_ref, "synthetic-capacity-ref-0-0");
});

test("a giant successful-provider identity cannot become an unbounded retained download result", async context => {
  const current = fixture(context, { download(request, invocation, downloadedFor) {
    return { ...downloadedFor(request), identity: { selfId: "77000009", unexpected: "x".repeat(64 * 1024) } };
  } });
  const reference = await current.firstReference();
  const output = await current.reader.download(current.principal, current.downloadInput(reference));
  assert.equal(output.status, "unknown");
  assert.equal(Object.hasOwn(output, "identity"), false);
  assert.deepEqual(await current.reader.download(current.principal, current.downloadInput(reference)), output);
  assert.equal(current.calls.downloads.length, 1);
});

test("permission and source changes during reads prevent late content disclosure", async context => {
  const pending = deferred();
  const current = fixture(context, { read(request, invocation, pageFor) { pending.output = pageFor(request); return pending.promise; } });
  const waiting = current.read();
  current.principal.allowed_channel_reads = [];
  pending.finish(pending.output);
  await assert.rejects(waiting, code("forbidden"));
  current.principal.allowed_channel_reads = ["synthetic-private-binding"];
  const reference = await current.firstReference();
  current.sources[0].source_target.binding_generation += 1;
  await assert.rejects(current.reader.download(current.principal, current.downloadInput(reference)), code("channel_content_scope_changed"));
  assert.equal(current.calls.downloads.length, 0);
});

test("revoked download access withholds a late result and restores it without another provider request", async context => {
  const pending = deferred();
  let complete;
  const current = fixture(context, { download(request, invocation, downloadedFor) { complete = () => pending.finish(downloadedFor(request)); return pending.promise; } });
  const reference = await current.firstReference();
  const waiting = current.reader.download(current.principal, current.downloadInput(reference));
  current.principal.allowed_channel_downloads = [];
  complete();
  await assert.rejects(waiting, code("forbidden"));
  current.principal.allowed_channel_downloads = ["synthetic-private-binding"];
  assert.equal((await current.reader.download(current.principal, current.downloadInput(reference))).downloaded, true);
  assert.equal(current.calls.downloads.length, 1);
});

test("source generation changes cannot turn an existing unknown operation into a replacement attachment", async context => {
  const current = fixture(context, { download() { throw new Error(SECRET); } });
  const reference = await current.firstReference();
  await current.reader.download(current.principal, current.downloadInput(reference));
  current.sources[0].source_target.binding_generation += 1;
  assert.equal(await current.firstReference(), reference);
  await assert.rejects(current.reader.download(current.principal, current.downloadInput(reference)), code("channel_content_scope_changed"));
  assert.equal(current.calls.downloads.length, 1);
});

test("close clears only owned mappings, reports unresolved requests and never closes the shared adapter or deletes files", async context => {
  const pending = deferred();
  const current = fixture(context, { download() { return pending.promise; } });
  const reference = await current.firstReference();
  const waiting = current.reader.download(current.principal, current.downloadInput(reference));
  const rejection = assert.rejects(waiting, code("service_closing"));
  const closed = current.reader.close();
  await rejection;
  assert.equal(closed.closed, true);
  assert.equal(closed.pending_downloads.length, 1);
  assert.equal(closed.pending_downloads[0].status, "unknown");
  assert.equal(current.calls.closed, 0);
  await assert.rejects(current.read(), code("service_closing"));
  await assert.rejects(current.reader.download(current.principal, current.downloadInput(reference)), code("service_closing"));
  pending.finish({ downloaded: false });
  await nextTurn();
});
