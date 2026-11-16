import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CoreError, digest, identityKey } from "../src/contracts.mjs";
import { createChannelDownloadLedger } from "../src/channel-download-ledger.mjs";
import { ChannelContentReader } from "../src/channel-content.mjs";

const CALLER = { machine_id: "synthetic-machine", host: "codex", surface: "desktop", conversation_id: "synthetic-chat" };
const HASH = "a".repeat(64);

function deferred() {
  let finish;
  const promise = new Promise(resolvePromise => { finish = resolvePromise; });
  return { promise, finish };
}

async function temporary(context) {
  const root = await fs.mkdtemp(join(tmpdir(), "cc-download-ledger-test-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, stateDir: join(root, "state"), destination: join(root, "files") };
}

function input(destination, fileIdentity = "synthetic-file") {
  const source = { caller_key: identityKey(CALLER), channel: "qq", window_type: "private", window_id: "77000001",
    window_key: "synthetic-window", source_message_id: "12345", file_type: "file", file_identity: fileIdentity,
    scope_fingerprint: "f".repeat(64), target_key: "synthetic-private-target" };
  return { contentKey: digest([source.caller_key, source.channel, source.window_type, source.window_id, source.source_message_id, source.file_type, source.file_identity]),
    source, parameters: { destination_dir: resolve(destination), name: "original.txt" } };
}

function outcome(operation, status, fields = {}) {
  return { operation_id: operation.operation_id, status, downloaded: status === "downloaded", ...fields };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await delay(5);
  }
  assert.fail("bounded condition did not become ready");
}

function harness(ledger, options = {}) {
  const source = { window_key: "synthetic-window", channel: "qq", component: "synthetic-provider", window_type: "private", window_id: "77000001",
    channel_binding_id: "synthetic-binding", target_key: "synthetic-private-target", conversation_id: "synthetic-component",
    source_target: { machine_id: "synthetic-qq", host: "qq", surface: "private", conversation_id: "synthetic-private-target",
      binding_id: "synthetic-binding", binding_generation: 1, adapter_id: "synthetic-adapter" } };
  const calls = [];
  const success = request => ({ downloaded: true, sourceMessageId: "12345", attachment_ref: request.attachment_ref,
    target: { type: "private", id: "77000001" }, filePath: join(request.destination_dir, request.name ?? "original.txt"),
    fileName: request.name ?? "original.txt", fileBytes: 3, sha256: HASH, resolvedBusId: null, cleanupPending: false });
  const transport = {
    async readConfiguredRecent(request) {
      return { target: { type: "private", id: "77000001" }, requestedCount: request.count, returnedCount: 1,
        messages: [{ messageId: "12345", text: "ordinary synthetic message", attachments: [{ type: "file", fileId: "synthetic-file", fileBytes: 3,
          attachment_ref: options.providerRef ?? "synthetic-provider-ref", downloadable: true }] }],
        pagination: { status: "unknown", beforeMessageIdSupported: false } };
    },
    async downloadConfiguredFile(request, invocation) {
      calls.push({ request, invocation });
      return options.download ? options.download(request, invocation, success, calls.length) : success(request);
    },
  };
  const reader = new ChannelContentReader({ sources: [source], adapters: new Map([["synthetic-adapter", { transport, conversationId: "synthetic-component" }]]),
    ...(ledger ? { downloadLedger: ledger } : {}), ...(options.now ? { now: options.now } : {}) });
  const principal = { id: "synthetic-principal", identity: CALLER, allowed_channel_reads: ["synthetic-binding"], allowed_channel_downloads: ["synthetic-binding"] };
  const base = { caller: CALLER, channel: "qq", window_type: "private", window_id: "77000001" };
  const read = () => reader.read(principal, base);
  const reference = async () => (await read()).messages[0].attachments[0].attachment_ref;
  const download = (reference, extra = {}, invocation = {}) => reader.download(principal, { ...base, attachment_ref: reference, ...extra }, invocation);
  return { reader, calls, success, read, reference, download };
}

test("begin fsyncs a bounded independent record before returning and cold pending is unknown", async context => {
  const paths = await temporary(context);
  let syncs = 0;
  const fileSystem = { ...fs, async open(path, ...argumentsList) {
    const handle = await fs.open(path, ...argumentsList);
    if (String(path).includes(".pending-")) { const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); syncs += 1; }; }
    return handle;
  } };
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir, fileSystem });
  const request = input(paths.destination);
  const first = await ledger.begin(request);
  assert.equal(first.created, true);
  assert.equal(syncs, 1);
  const saved = JSON.parse(await fs.readFile(join(paths.stateDir, `${first.operation.operation_id}.json`), "utf8"));
  assert.equal(saved.record.status, "pending");
  assert.equal(saved.checksum, digest(saved.record));
  const restarted = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  assert.equal((await restarted.read(request.contentKey)).status, "unknown");
  const recovered = await restarted.begin({ ...request, parameters: { destination_dir: join(paths.root, "unused-new-directory") } });
  assert.equal(recovered.created, false);
  assert.equal(recovered.operation.operation_id, first.operation.operation_id);
  assert.deepEqual(recovered.operation.parameters, request.parameters);
  await restarted.close();
});

test("concurrent begin and repeated retry CAS create one root and one successor", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const request = input(paths.destination);
  const roots = await Promise.all([ledger.begin(request), ledger.begin(request)]);
  assert.equal(roots.filter(result => result.created).length, 1);
  const original = roots[0].operation;
  await ledger.update(original.operation_id, { status: "failed", result: outcome(original, "failed", { cleanup_pending: false }) });
  const retry = { ...request, parameters: { ...request.parameters, name: "retry.txt" }, retryFailed: true, expectedOperationId: original.operation_id };
  const successors = await Promise.all([ledger.begin(retry), ledger.begin(retry), ledger.begin(retry)]);
  assert.equal(successors.filter(result => result.created).length, 1);
  assert.equal(new Set(successors.map(result => result.operation.operation_id)).size, 1);
  await assert.rejects(ledger.begin({ ...retry, parameters: { ...retry.parameters, name: "forged-third.txt" } }), /后继操作/);
  assert.equal((await ledger.read(request.contentKey, original.operation_id)).status, "failed");
  assert.equal((await fs.readdir(paths.stateDir)).length, 2);
  await ledger.close();
  const restarted = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  assert.equal((await restarted.begin(retry)).created, false);
  assert.equal((await fs.readdir(paths.stateDir)).length, 2);
  await restarted.close();
});

test("unknown, cleanup pending and forged expected operations cannot retry", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const request = input(paths.destination);
  const { operation } = await ledger.begin(request);
  await assert.rejects(ledger.begin({ ...request, retryFailed: true, expectedOperationId: operation.operation_id }), /禁止重新下载/);
  await ledger.update(operation.operation_id, { status: "failed", result: outcome(operation, "failed", { cleanup_pending: true }) });
  await assert.rejects(ledger.begin({ ...request, retryFailed: true, expectedOperationId: operation.operation_id }), /禁止重新下载/);
  await assert.rejects(ledger.begin({ ...request, retryFailed: true, expectedOperationId: "not-an-operation" }));
  await ledger.close();
});

test("confirmed success survives later cancellation updates", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const request = input(paths.destination);
  const { operation } = await ledger.begin(request);
  await ledger.update(operation.operation_id, { status: "unknown", result: outcome(operation, "unknown") });
  await ledger.update(operation.operation_id, { status: "downloaded", result: outcome(operation, "downloaded", { sha256: HASH }) });
  await ledger.update(operation.operation_id, { status: "unknown", result: outcome(operation, "unknown") });
  assert.equal((await ledger.read(request.contentKey)).status, "downloaded");
  await ledger.close();
});

test("reserved operation capacity fails without evicting unresolved records", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir, maxOperations: 1 });
  const request = input(paths.destination);
  await ledger.begin(request);
  await assert.rejects(ledger.begin(input(paths.destination, "other-file")), /容量/);
  assert.equal((await ledger.read(request.contentKey)).status, "unknown");
  await ledger.close();
});

test("changed content, unexpected files and linked paths fail closed", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const request = input(paths.destination);
  const { operation } = await ledger.begin(request);
  const recordPath = join(paths.stateDir, `${operation.operation_id}.json`);
  await fs.appendFile(recordPath, " ");
  await assert.rejects(ledger.read(request.contentKey), /变化/);
  const document = JSON.parse(await fs.readFile(recordPath, "utf8"));
  document.record.parameters.name = "tampered.txt";
  await fs.writeFile(recordPath, JSON.stringify(document));
  await assert.rejects(createChannelDownloadLedger({ stateDir: paths.stateDir }), /校验失败/);
  const outside = join(paths.root, "outside");
  await fs.mkdir(outside);
  const linked = join(paths.root, "junction");
  try { await fs.symlink(outside, linked, process.platform === "win32" ? "junction" : "dir"); } catch (error) {
    if (["EPERM", "ENOTSUP"].includes(error.code)) return;
    throw error;
  }
  await assert.rejects(createChannelDownloadLedger({ stateDir: linked }), /链接/);
});

test("hardlinked records and uncoordinated extra writers are detected", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const request = input(paths.destination);
  const { operation } = await ledger.begin(request);
  await fs.link(join(paths.stateDir, `${operation.operation_id}.json`), join(paths.root, "linked-record"));
  await assert.rejects(ledger.read(request.contentKey), /链接/);
  const otherDir = join(paths.root, "other-state");
  const other = await createChannelDownloadLedger({ stateDir: otherDir });
  await other.begin(request);
  await fs.writeFile(join(otherDir, "unowned-file"), "x");
  await assert.rejects(other.read(request.contentKey), /未知文件/);
});

test("fsync failure prevents durable admission and closes later admission", async context => {
  const paths = await temporary(context);
  const fileSystem = { ...fs, async open(path, ...argumentsList) {
    const handle = await fs.open(path, ...argumentsList);
    if (String(path).includes(".pending-")) handle.sync = async () => { throw new Error("synthetic fsync failure"); };
    return handle;
  } };
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir, fileSystem });
  await assert.rejects(ledger.begin(input(paths.destination)), /持久写失败/);
  await assert.rejects(ledger.begin(input(paths.destination)), /持久写失败/);
  assert.deepEqual(await fs.readdir(paths.stateDir), []);
});

test("close waits for owned writes and preserves pending as unknown", async context => {
  const paths = await temporary(context);
  const blocked = deferred();
  let hold = false;
  let entered = false;
  const fileSystem = { ...fs, async open(path, ...argumentsList) {
    const handle = await fs.open(path, ...argumentsList);
    if (String(path).includes(".pending-")) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { if (hold) { entered = true; await blocked.promise; } await sync(); };
    }
    return handle;
  } };
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir, fileSystem });
  const request = input(paths.destination);
  await ledger.begin(request);
  hold = true;
  let completed = false;
  const closing = ledger.close().then(result => { completed = true; return result; });
  await until(() => entered);
  assert.equal(completed, false);
  blocked.finish();
  assert.equal((await closing).pending_downloads.length, 1);
  const restarted = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  assert.equal((await restarted.read(request.contentKey)).status, "unknown");
  await restarted.close();
});

test("module accepts minimal Provider success and exposes unverified pagination", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const current = harness(ledger);
  assert.equal((await current.read()).pagination.verified, false);
  const result = await current.download(await current.reference());
  assert.equal(result.downloaded, true);
  assert.equal(Object.hasOwn(result, "fileId"), false);
  assert.equal(Object.hasOwn(result, "resolvedFileId"), false);
  assert.equal(result.resolvedBusId, null);
  assert.equal(result.cleanup_pending, false);
  await current.reader.close();
});

test("module restart and rotated reference preserve unknown operation and original directory", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const first = harness(ledger, { download() { throw new CoreError("unconfirmed", "synthetic", { request_sent: true }); } });
  const previousRef = await first.reference();
  const original = await first.download(previousRef);
  assert.equal(original.status, "unknown");
  await first.reader.close();
  const reopened = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const second = harness(reopened, { providerRef: "rotated-provider-ref" });
  const nextRef = await second.reference();
  assert.notEqual(previousRef, nextRef);
  const recovered = await second.download(nextRef);
  assert.equal(recovered.operation_id, original.operation_id);
  assert.equal(recovered.destination_dir, original.destination_dir);
  assert.equal(second.calls.length, 0);
  const readBack = (await second.read()).messages[0].attachments[0].download_operation;
  assert.equal(readBack.operation_id, original.operation_id);
  assert.equal(readBack.destination_dir, original.destination_dir);
  await assert.rejects(second.download(nextRef, { retry_failed: true, expected_operation_id: original.operation_id }));
  await second.reader.close();
});

test("module explicit retry CAS is single-flight and cannot forge changed parameters", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const current = harness(ledger, { download(request, invocation, success, count) {
    if (count === 1) throw new CoreError("channel_operation_failed", "synthetic", { request_sent: true, outcome_unknown: false });
    return success(request);
  } });
  const reference = await current.reference();
  const failed = await current.download(reference);
  await assert.rejects(current.download(reference, { retry_failed: true, name: "retry.txt" }), /operation_id/);
  await assert.rejects(current.download(reference, { name: "retry.txt" }), /原目录/);
  const retry = { retry_failed: true, expected_operation_id: failed.operation_id, name: "retry.txt" };
  const results = await Promise.all([current.download(reference, retry), current.download(reference, retry)]);
  assert.equal(results[0].downloaded, true);
  assert.equal(results[0].operation_id, results[1].operation_id);
  assert.equal(current.calls.length, 2);
  assert.equal((await current.download(reference, retry)).operation_id, results[0].operation_id);
  await assert.rejects(current.download(reference, { ...retry, name: "third.txt" }), /后继操作/);
  assert.equal(current.calls.length, 2);
  await current.reader.close();
});

test("module cancellation persists unknown then retains authoritative late success", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const completion = deferred();
  const current = harness(ledger, { download(request, invocation, success) { return completion.promise.then(() => success(request)); } });
  const reference = await current.reference();
  const cancellation = new AbortController();
  const waiting = current.download(reference, {}, { signal: cancellation.signal });
  await until(() => current.calls.length === 1);
  cancellation.abort();
  const unknown = await waiting;
  assert.equal(unknown.status, "unknown");
  completion.finish();
  await until(async () => (await current.download(reference)).status === "downloaded");
  const success = await current.download(reference);
  assert.equal(success.operation_id, unknown.operation_id);
  assert.equal(current.calls.length, 1);
  await current.reader.close();
});

test("module cleanup errors preserve safe paths and block retries", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const current = harness(ledger, { download(request) { throw new CoreError("channel_operation_failed", "synthetic", { request_sent: true,
    outcome_unknown: false, cleanup_pending: true, temporary_path: join(request.destination_dir, "original.txt.part-00000000-0000-4000-8000-000000000000") }); } });
  const reference = await current.reference();
  const result = await current.download(reference);
  assert.equal(result.status, "failed");
  assert.equal(result.cleanup_pending, true);
  assert.match(result.temporary_path, /\.part-/);
  await assert.rejects(current.download(reference, { retry_failed: true, expected_operation_id: result.operation_id, name: "retry.txt" }));
  assert.equal(current.calls.length, 1);
  await current.reader.close();
});

test("module durable admission failure makes no Provider request", async context => {
  const paths = await temporary(context);
  const fileSystem = { ...fs, async open(path, ...argumentsList) {
    const handle = await fs.open(path, ...argumentsList);
    if (String(path).includes(".pending-")) handle.sync = async () => { throw new Error("synthetic fsync failure"); };
    return handle;
  } };
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir, fileSystem });
  const current = harness(ledger);
  await assert.rejects(current.download(await current.reference()));
  assert.equal(current.calls.length, 0);
  await current.reader.close().catch(() => {});
});

test("module completion write failure preserves observed success and durable unknown without resubmission", async context => {
  const paths = await temporary(context);
  let writes = 0;
  const fileSystem = { ...fs, async open(path, ...argumentsList) {
    const handle = await fs.open(path, ...argumentsList);
    if (String(path).includes(".pending-")) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { writes += 1; if (writes > 1) throw new Error("synthetic result write failure"); await sync(); };
    }
    return handle;
  } };
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir, fileSystem });
  const first = harness(ledger);
  const result = await first.download(await first.reference());
  assert.equal(result.downloaded, true);
  assert.equal(result.ledger_persisted, false);
  assert.equal(result.retry_allowed, false);
  assert.equal(first.calls.length, 1);
  await assert.rejects(first.reader.close());
  const restarted = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const second = harness(restarted);
  const recovered = await second.download(await second.reference());
  assert.equal(recovered.status, "unknown");
  assert.equal(recovered.operation_id, result.operation_id);
  assert.equal(second.calls.length, 0);
  await second.reader.close();
});

test("module close waits for an admitted write and never submits a cancelled preparation", async context => {
  const paths = await temporary(context);
  const gate = deferred();
  let entered = false;
  let hold = true;
  const fileSystem = { ...fs, async open(path, ...argumentsList) {
    const handle = await fs.open(path, ...argumentsList);
    if (String(path).includes(".pending-")) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { if (hold) { entered = true; await gate.promise; } await sync(); };
    }
    return handle;
  } };
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir, fileSystem });
  const current = harness(ledger);
  const download = current.download(await current.reference());
  const rejected = assert.rejects(download);
  await until(() => entered);
  let finished = false;
  const closing = current.reader.close().then(result => { finished = true; return result; });
  await delay(5);
  assert.equal(finished, false);
  hold = false;
  gate.finish();
  await rejected;
  await closing;
  assert.equal(current.calls.length, 0);
  const saved = JSON.parse(await fs.readFile(join(paths.stateDir, (await fs.readdir(paths.stateDir))[0]), "utf8"));
  assert.equal(saved.record.status, "failed_before_send");
});

test("module rejects unsafe cleanup paths while retaining cleanup uncertainty", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const current = harness(ledger, { download(request, invocation, success) {
    return { ...success(request), cleanupPending: true, temporaryPath: join(paths.root, "outside.part-00000000-0000-4000-8000-000000000000") };
  } });
  const reference = await current.reference();
  const result = await current.download(reference);
  assert.equal(result.status, "unknown");
  assert.equal(result.cleanup_pending, true);
  assert.equal(Object.hasOwn(result, "temporary_path"), false);
  await assert.rejects(current.download(reference, { retry_failed: true, expected_operation_id: result.operation_id, name: "retry.txt" }));
  await current.reader.close();
});

test("module reference expiration retains operation identity but requires a new read", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  let time = Date.parse("2026-01-01T00:00:00.000Z");
  const current = harness(ledger, { now: () => time, download() { throw new CoreError("unconfirmed", "synthetic", { request_sent: true }); } });
  const reference = await current.reference();
  const first = await current.download(reference);
  time += 31 * 60 * 1000;
  await assert.rejects(current.download(reference), /引用无效/);
  const nextRef = await current.reference();
  const second = await current.download(nextRef);
  assert.notEqual(reference, nextRef);
  assert.equal(second.operation_id, first.operation_id);
  assert.equal(second.destination_dir, first.destination_dir);
  assert.equal(current.calls.length, 1);
  await current.reader.close();
});

test("module terminal result close preserves the durable record when a late callback is still running", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const completion = deferred();
  const current = harness(ledger, { download(request, invocation, success) { return completion.promise.then(() => success(request)); } });
  const reference = await current.reference();
  const pending = current.download(reference);
  const rejected = assert.rejects(pending);
  await until(() => current.calls.length === 1);
  const closed = await current.reader.close();
  await rejected;
  assert.equal(closed.pending_downloads.length, 1);
  completion.finish();
  await delay(10);
  const restarted = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const second = harness(restarted);
  const recovered = await second.download(await second.reference());
  assert.equal(recovered.status, "unknown");
  assert.equal(second.calls.length, 0);
  await second.reader.close();
});

test("a repeated parent retry returns its existing failed child and only the child CAS permits another attempt", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const request = input(paths.destination);
  const first = (await ledger.begin(request)).operation;
  await ledger.update(first.operation_id, { status: "failed_before_send", result: outcome(first, "failed_before_send") });
  const retry = { ...request, retryFailed: true, expectedOperationId: first.operation_id };
  const child = (await ledger.begin(retry)).operation;
  await ledger.update(child.operation_id, { status: "failed", result: outcome(child, "failed") });
  assert.equal((await ledger.begin(retry)).operation.operation_id, child.operation_id);
  const grandchild = await ledger.begin({ ...retry, expectedOperationId: child.operation_id });
  assert.equal(grandchild.created, true);
  assert.equal((await ledger.begin(retry)).operation.operation_id, child.operation_id);
  assert.equal((await fs.readdir(paths.stateDir)).length, 3);
  await ledger.close();
});

test("history preserves ordinary text and hides downloads after runtime ledger tampering", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const current = harness(ledger);
  const result = await current.download(await current.reference());
  await fs.appendFile(join(paths.stateDir, `${result.operation_id}.json`), " ");
  const page = await current.read();
  assert.equal(page.messages[0].text, "ordinary synthetic message");
  assert.equal(page.messages[0].attachments[0].downloadable, false);
  assert.equal(page.messages[0].attachments[0].download_status, "unavailable");
  assert.equal(Object.hasOwn(page.messages[0].attachments[0], "attachment_ref"), false);
  assert.equal(page.attachment_reference_policy.download_state_available, false);
  await current.reader.close().catch(() => {});
});

test("source fingerprints cannot reuse another binding's saved operation", async context => {
  const paths = await temporary(context);
  const ledger = await createChannelDownloadLedger({ stateDir: paths.stateDir });
  const request = input(paths.destination);
  await ledger.begin(request);
  await assert.rejects(ledger.begin({ ...request, source: { ...request.source, scope_fingerprint: "b".repeat(64) } }), /来源已变化/);
  assert.equal((await ledger.begin(request)).created, false);
  await ledger.close();
});
