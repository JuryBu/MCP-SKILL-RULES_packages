import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  communicationWriterFingerprint,
  createCodexCommunicationAttachment,
} from "../src/codex-communication-attachment.mjs";
import { createCodexCommunicationControl } from "../src/codex-communication-control.mjs";
import { sourceNativeReadObservationApproval } from "../src/codex-communication-read-approval.mjs";
import {
  THREAD_READ_BODY_BYTES,
  ThreadReadError,
  createCodexThreadReader,
  createLiveCodexThreadReader,
} from "../src/codex-thread-read.mjs";
import {
  createCodexThreadReadHandler,
  isCodexThreadReadPath,
} from "../src/codex-thread-read-control.mjs";
import { createNativeReadObservation } from "../src/native-read-observation.mjs";

const THREAD_A = "11111111-2222-3333-4444-555555555555";
const THREAD_B = "22222222-3333-4444-5555-666666666666";
const THREAD_C = "33333333-4444-5555-6666-777777777777";
const CLIENT_MSG_UUID_UPPER = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
const CLIENT_MSG_UUID_LOWER = CLIENT_MSG_UUID_UPPER.toLowerCase();
const INSTANCE_ID = "fixture-parent-instance-01";
const WRITER_EPOCH = "fixture-writer-epoch-01";
const MANIFEST_SHA = "11".repeat(32);
const ALT_MANIFEST_SHA = "22".repeat(32);
const RECEIVE_TOKEN = "fixture-receive-token-0123456789abcdef";
const READ_TOKEN = "fixture-readonly-token-0123456789abcdef";
const WRONG_READ_TOKEN = "fixture-wrongkey-token-0123456789abcdef";
const PROXY_NOTICE_ID = `msg_proxy_${"a1".repeat(16)}`;
const PROXY_ROOT_NOTICE_ID = `msg_proxy_root_${"b2".repeat(16)}`;

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");

function makeTempDir(context, prefix = "codex-thread-read-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  context.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createFakeParentProxy({ manifestSha256 = MANIFEST_SHA, writerEpoch = WRITER_EPOCH } = {}) {
  const runtimeState = {
    instanceId: INSTANCE_ID,
    busy: false,
    failed: false,
    selected: { manifestSha256 },
  };
  const proxy = {
    closed: false,
    writerEpoch,
    liveCodeRuntime: { status: () => runtimeState },
    journal: { readVisibilityRevision: () => "journal-rev-1" },
    subscribeThread() {},
    _liveReadyClients() { return []; },
    _liveMaintenanceStatus() { return { active: false }; },
    _liveInjectRequest() {},
  };
  return { proxy, runtimeState };
}

function writeAttachmentFiles(context, {
  receiveToken = RECEIVE_TOKEN,
  readToken = READ_TOKEN,
  threadRead,
  principalId = "fixture-core-principal",
} = {}) {
  const dir = makeTempDir(context, "codex-approval-fixture-");
  const receiveTokenFile = path.join(dir, "receive-token.txt");
  const readTokenFile = path.join(dir, "read-token.txt");
  const ledgerPath = path.join(dir, "ledger.json");
  const configPath = path.join(dir, "control.json");
  const receiveBytes = Buffer.from(receiveToken, "utf8");
  const readBytes = Buffer.from(readToken, "utf8");
  fs.writeFileSync(receiveTokenFile, receiveBytes, { mode: 0o600 });
  fs.writeFileSync(readTokenFile, readBytes, { mode: 0o600 });
  const payload = {
    host: "127.0.0.1",
    port: 0,
    token_file: receiveTokenFile,
    ledger_path: ledgerPath,
    principal_id: principalId,
    allowed_origins: [{ host: "codex", conversation_id: "fixture-origin-01" }],
    allowed_targets: [{ conversation_id: THREAD_A, binding_generation: 1 }],
    ...(threadRead === undefined ? {} : {
      thread_read: {
        token_file: readTokenFile,
        list: true,
        list_scope: "allowed_threads",
        thread_ids: [THREAD_A, THREAD_B],
        ...threadRead,
      },
    }),
  };
  const configBytes = Buffer.from(JSON.stringify(payload), "utf8");
  fs.writeFileSync(configPath, configBytes);
  const configurationSha256 = sha256(configBytes);
  return {
    dir,
    receiveTokenFile,
    readTokenFile,
    ledgerPath,
    configPath,
    configBytes,
    configurationSha256,
    receiveTokenSha256: sha256(receiveBytes),
    readTokenSha256: sha256(readBytes),
    attachInput: {
      config_path: configPath,
      expected_instance_id: INSTANCE_ID,
      expected_manifest_sha256: MANIFEST_SHA,
      expected_configuration_sha256: configurationSha256,
    },
  };
}

async function startHttpServer(context, handler) {
  const server = http.createServer(async (request, response) => {
    const handled = await handler(request, response);
    if (!handled && !response.writableEnded && !response.destroyed) {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: { code: "not_handled" } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  context.after(async () => {
    if (!server.listening) return;
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections?.();
    await closed;
  });
  const address = server.address();
  return { server, port: address.port, endpoint: `http://127.0.0.1:${address.port}` };
}

function decodeChunkedBody(rawBody) {
  let cursor = 0;
  const parts = [];
  while (cursor < rawBody.length) {
    const lineEnd = rawBody.indexOf("\r\n", cursor);
    if (lineEnd < 0) break;
    const size = Number.parseInt(rawBody.slice(cursor, lineEnd).split(";")[0].trim(), 16);
    if (!Number.isFinite(size) || size < 0) break;
    cursor = lineEnd + 2;
    if (size === 0) break;
    parts.push(rawBody.slice(cursor, cursor + size));
    cursor += size + 2;
  }
  return parts.join("");
}

function sendRawHttp(port, rawPayload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const chunks = [];
    socket.on("error", reject);
    socket.on("data", chunk => chunks.push(chunk));
    socket.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const splitIndex = raw.indexOf("\r\n\r\n");
      const head = splitIndex >= 0 ? raw.slice(0, splitIndex) : raw;
      const rawBody = splitIndex >= 0 ? raw.slice(splitIndex + 4) : "";
      const isChunked = /^transfer-encoding:\s*chunked\b/imu.test(head);
      const bodyText = isChunked ? decodeChunkedBody(rawBody) : rawBody;
      const statusMatch = /^HTTP\/1\.\d (\d{3})/u.exec(head);
      let body = null;
      try { body = JSON.parse(bodyText); } catch {}
      resolve({ status: statusMatch ? Number(statusMatch[1]) : 0, head, bodyText, body });
    });
    socket.end(rawPayload);
  });
}

function makeFakeDesktopClient(generation = 1) {
  return {
    upstream: { kind: "fake-upstream" },
    metadataDownstreamGeneration: generation,
    metadataUpstreamGeneration: generation,
  };
}

function makeBenignStartParams(overrides = {}) {
  return {
    threadId: THREAD_A,
    clientUserMessageId: CLIENT_MSG_UUID_UPPER,
    turnTrigger: "composer",
    input: [{ type: "text", text: "Hello from ordinary desktop composer." }],
    additionalContext: {
      codex_apps_client_time_context: { kind: "application", value: "2026-11-27T04:00:00Z" },
      worktree_preference: { kind: "application", value: "current" },
      worktree_preference_guidance: { kind: "application", value: "use current worktree" },
      codex_git_state: { kind: "untrusted", value: "branch=main clean", name: "git_state" },
      codex_apps_open_page: { kind: "untrusted", value: "{\"page_id\":null}" },
      codex_apps_selected_page_part_1_of_1: {
        kind: "untrusted",
        value: "Companion Page snapshot part 1 of 1: {\"page_id\":null,\"document_view\":null}",
      },
    },
    responsesapiClientMetadata: {
      source: "codex",
      client_surface: "desktop",
      optional_flag: null,
    },
    ...overrides,
  };
}

function sealObservedTurn(observation, {
  client,
  epoch = WRITER_EPOCH,
  threadId = THREAD_A,
  turnId = "turn-001",
  startedAt = 1000,
  completedAt = 2000,
  startParams = makeBenignStartParams({ threadId }),
  userItemId = "item-user-01",
  userItemClientId = CLIENT_MSG_UUID_LOWER,
  extraItems = [],
  finalAnswerId = "item-assistant-final-01",
  finalAnswerText = "Verified final answer text.",
  completionItemsView = "full",
} = {}) {
  const readInput = observation.capture(startParams);
  assert.ok(readInput, "expected benign capture to succeed");
  const tracking = { threadId, readInput };
  observation.forwarded(client, epoch, "turn/start", threadId, tracking);
  observation.reply(client, epoch, tracking, {
    result: { threadId, turn: { id: turnId, threadId, status: "inProgress" } },
  });
  observation.notify(client, epoch, {
    method: "turn/started",
    params: { threadId, turn: { id: turnId, status: "inProgress" } },
  });

  const userItem = {
    id: userItemId,
    type: "userMessage",
    clientId: userItemClientId,
    content: startParams.input.map(part => ({ ...part })),
  };
  const finalAnswerItem = {
    id: finalAnswerId,
    type: "agentMessage",
    phase: "final_answer",
    text: finalAnswerText,
  };
  const items = [userItem, ...extraItems, finalAnswerItem];
  for (const item of items) {
    observation.notify(client, epoch, {
      method: "item/started",
      params: { threadId, turnId, item },
    });
    observation.notify(client, epoch, {
      method: "item/completed",
      params: { threadId, turnId, item },
    });
  }

  const completionTurn = {
    id: turnId,
    status: "completed",
    startedAt,
    completedAt,
    itemsView: completionItemsView,
    items: completionItemsView === "notLoaded" ? [] : items,
  };
  observation.notify(client, epoch, {
    method: "turn/completed",
    params: { threadId, turn: completionTurn },
  });

  return {
    turn: {
      id: turnId,
      threadId,
      status: "completed",
      startedAt,
      completedAt,
      itemsView: "notLoaded",
      items: [],
    },
    items,
    userItem,
    finalAnswerItem,
  };
}

// ============================================================================
// 1. Public Default Approval Contract & Writer Fingerprint
// ============================================================================

test("public default approval is null and rejects native_observation_thread_id", async context => {
  assert.equal(sourceNativeReadObservationApproval, null);
  const files = writeAttachmentFiles(context, {
    threadRead: { native_observation_thread_id: THREAD_A },
  });
  const { proxy } = createFakeParentProxy();
  const attachment = createCodexCommunicationAttachment(proxy);
  context.after(() => attachment.close());

  await assert.rejects(
    attachment.attach(files.attachInput),
    error => error?.code === "COMMUNICATION_THREAD_READ_OBSERVATION_NOT_APPROVED",
  );
  assert.equal(attachment.status().enabled, false);
  assert.equal(attachment.threadReadObservation(), null);
  assert.equal(fs.existsSync(`${files.ledgerPath}.lock`), false);
});

test("singleUse injected nativeReadObservationApproval allows one attach and rejects re-attach after detach", async context => {
  const files = writeAttachmentFiles(context, {
    threadRead: { native_observation_thread_id: THREAD_A },
  });
  const { proxy } = createFakeParentProxy();
  const approval = {
    threadId: THREAD_A,
    configurationSha256: files.configurationSha256,
    readTokenSha256: files.readTokenSha256,
    receiveTokenSha256: files.receiveTokenSha256,
    manifestSha256: MANIFEST_SHA,
    singleUse: true,
  };
  const attachment = createCodexCommunicationAttachment(proxy, {
    nativeReadObservationApproval: approval,
  });
  context.after(() => attachment.close());

  const first = await attachment.attach(files.attachInput);
  assert.equal(first.enabled, true);
  assert.match(first.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/u);
  const observation = attachment.threadReadObservation();
  assert.ok(observation);
  assert.equal(typeof observation.capture, "function");
  assert.equal(typeof observation.coverage, "function");

  const detached = await attachment.close();
  assert.equal(detached.enabled, false);
  assert.equal(attachment.threadReadObservation(), null);
  assert.equal(fs.existsSync(`${files.ledgerPath}.lock`), false);

  await assert.rejects(
    attachment.attach(files.attachInput),
    error => error?.code === "COMMUNICATION_THREAD_READ_OBSERVATION_ALREADY_USED",
  );
  assert.equal(attachment.status().enabled, false);
  assert.equal(attachment.threadReadObservation(), null);
  assert.equal(fs.existsSync(`${files.ledgerPath}.lock`), false);

  // Detach followed by ordinary read-only config (without native_observation_thread_id) remains allowed.
  const plainFiles = writeAttachmentFiles(context, { threadRead: {} });
  const second = await attachment.attach(plainFiles.attachInput);
  assert.equal(second.enabled, true);
  assert.equal(attachment.threadReadObservation(), null);
});

test("nativeReadObservationApproval fails closed on token hash, config hash, manifest hash, or binding mismatches", async context => {
  const baseFiles = writeAttachmentFiles(context, {
    threadRead: { native_observation_thread_id: THREAD_A },
  });
  const validApproval = {
    threadId: THREAD_A,
    configurationSha256: baseFiles.configurationSha256,
    readTokenSha256: baseFiles.readTokenSha256,
    receiveTokenSha256: baseFiles.receiveTokenSha256,
    manifestSha256: MANIFEST_SHA,
    singleUse: true,
  };

  const cases = [
    {
      name: "readTokenSha256 mismatch",
      approval: { ...validApproval, readTokenSha256: "33".repeat(32) },
      input: baseFiles.attachInput,
    },
    {
      name: "receiveTokenSha256 mismatch",
      approval: { ...validApproval, receiveTokenSha256: "44".repeat(32) },
      input: baseFiles.attachInput,
    },
    {
      name: "configurationSha256 mismatch",
      approval: { ...validApproval, configurationSha256: "55".repeat(32) },
      input: baseFiles.attachInput,
    },
    {
      name: "manifestSha256 mismatch",
      approval: { ...validApproval, manifestSha256: ALT_MANIFEST_SHA },
      input: baseFiles.attachInput,
    },
    {
      name: "missing conditional binding",
      approval: validApproval,
      input: { config_path: baseFiles.configPath },
    },
    {
      name: "threadId mismatch",
      approval: { ...validApproval, threadId: THREAD_B },
      input: baseFiles.attachInput,
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async child => {
      const { proxy } = createFakeParentProxy();
      const attachment = createCodexCommunicationAttachment(proxy, {
        nativeReadObservationApproval: item.approval,
      });
      child.after(() => attachment.close());
      await assert.rejects(
        attachment.attach(item.input),
        error => error?.code === "COMMUNICATION_THREAD_READ_OBSERVATION_NOT_APPROVED",
      );
      assert.equal(attachment.status().enabled, false);
      assert.equal(attachment.threadReadObservation(), null);
      assert.equal(fs.existsSync(`${baseFiles.ledgerPath}.lock`), false);
    });
  }

  await context.test("mutated read token file bytes on disk fails closed", async child => {
    const mutated = writeAttachmentFiles(child, {
      threadRead: { native_observation_thread_id: THREAD_A },
    });
    const approval = {
      threadId: THREAD_A,
      configurationSha256: mutated.configurationSha256,
      readTokenSha256: mutated.readTokenSha256,
      receiveTokenSha256: mutated.receiveTokenSha256,
    };
    fs.writeFileSync(mutated.readTokenFile, `${READ_TOKEN}\n`, { mode: 0o600 });
    const { proxy } = createFakeParentProxy();
    const attachment = createCodexCommunicationAttachment(proxy, {
      nativeReadObservationApproval: approval,
    });
    child.after(() => attachment.close());
    await assert.rejects(
      attachment.attach(mutated.attachInput),
      error => error?.code === "COMMUNICATION_THREAD_READ_OBSERVATION_NOT_APPROVED",
    );
  });
});

test("communicationWriterFingerprint ignores thread_read differences and rejects hash drift", context => {
  const dir = makeTempDir(context, "codex-writer-fingerprint-");
  const baseConfig = {
    host: "127.0.0.1",
    port: 0,
    token_file: path.join(dir, "receive.txt"),
    ledger_path: path.join(dir, "ledger.json"),
    principal_id: "fixture-core",
    allowed_origins: [{ host: "codex", conversation_id: "fixture-origin" }],
    allowed_targets: [{ conversation_id: THREAD_A, binding_generation: 1 }],
  };
  const withoutReadPath = path.join(dir, "without-thread-read.json");
  const withReadPath = path.join(dir, "with-thread-read.json");
  const changedPrincipalPath = path.join(dir, "changed-principal.json");

  const withoutReadBytes = Buffer.from(JSON.stringify(baseConfig), "utf8");
  const withReadBytes = Buffer.from(JSON.stringify({
    ...baseConfig,
    thread_read: {
      token_file: path.join(dir, "read.txt"),
      list: true,
      list_scope: "current_account",
      thread_ids: [THREAD_A, THREAD_B],
      native_observation_thread_id: THREAD_A,
    },
  }), "utf8");
  const changedPrincipalBytes = Buffer.from(JSON.stringify({
    ...baseConfig,
    principal_id: "fixture-core-v2",
  }), "utf8");

  fs.writeFileSync(withoutReadPath, withoutReadBytes);
  fs.writeFileSync(withReadPath, withReadBytes);
  fs.writeFileSync(changedPrincipalPath, changedPrincipalBytes);

  const fpWithout = communicationWriterFingerprint(withoutReadPath, sha256(withoutReadBytes));
  const fpWith = communicationWriterFingerprint(withReadPath, sha256(withReadBytes));
  const fpChanged = communicationWriterFingerprint(changedPrincipalPath, sha256(changedPrincipalBytes));

  assert.match(fpWithout, /^[a-f0-9]{64}$/u);
  assert.equal(fpWithout, fpWith);
  assert.notEqual(fpWithout, fpChanged);

  // Mutated bytes after pinning must throw COMMUNICATION_HANDOFF_CONFIGURATION_CHANGED.
  fs.appendFileSync(withReadPath, "\n");
  assert.throws(
    () => communicationWriterFingerprint(withReadPath, sha256(withReadBytes)),
    error => error?.code === "COMMUNICATION_HANDOFF_CONFIGURATION_CHANGED",
  );
  assert.throws(
    () => communicationWriterFingerprint("relative-config.json", sha256(withoutReadBytes)),
    error => error?.code === "COMMUNICATION_HANDOFF_CONFIGURATION_CHANGED",
  );
  assert.throws(
    () => communicationWriterFingerprint(withoutReadPath, "not-a-sha256"),
    error => error?.code === "COMMUNICATION_HANDOFF_CONFIGURATION_CHANGED",
  );
});

// ============================================================================
// 2. Read-only HTTP Control Surface Security Boundaries
// ============================================================================

test("createCodexThreadReadHandler enforces token separation, HTTP method/media/body limits, concurrency, disconnect, and control_closing", async context => {
  assert.equal(isCodexThreadReadPath("/v1/threads/list"), true);
  assert.equal(isCodexThreadReadPath("/v1/threads/snapshot"), true);
  assert.equal(isCodexThreadReadPath("/v1/threads/list?limit=1"), false);
  assert.equal(isCodexThreadReadPath("/v1/communication/deliveries"), false);

  assert.throws(() => createCodexThreadReadHandler({
    readToken: "too-short-token",
    access: { list: true, threadIds: new Set([THREAD_A]) },
    readThread: async () => ({}),
  }), TypeError);

  let allowResponse = true;
  let readImpl = async (kind, input) => ({ ok: true, kind, input });
  const handler = createCodexThreadReadHandler({
    readToken: READ_TOKEN,
    access: { list: true, listScope: "allowed_threads", threadIds: new Set([THREAD_A]) },
    readThread: (kind, input, access, options) => readImpl(kind, input, access, options),
    canRespond: () => allowResponse,
  });
  const { port, endpoint } = await startHttpServer(context, handler);

  // Valid request succeeds.
  const okRes = await fetch(`${endpoint}/v1/threads/list`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${READ_TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ limit: 5 }),
  });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.headers.get("cache-control"), "no-store");
  assert.deepEqual(await okRes.json(), { ok: true, kind: "list", input: { limit: 5 } });

  // Wrong token, write token, short token, missing token -> 401 unauthorized.
  for (const authHeader of [
    undefined,
    `Bearer ${WRONG_READ_TOKEN}`,
    `Bearer ${RECEIVE_TOKEN}`,
    "Bearer short-token",
    `Basic ${READ_TOKEN}`,
  ]) {
    const res = await fetch(`${endpoint}/v1/threads/list`, {
      method: "POST",
      headers: {
        ...(authHeader ? { authorization: authHeader } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: { code: "unauthorized" } });
  }

  // Repeated Authorization header -> 401 unauthorized.
  const repeatedAuth = await sendRawHttp(
    port,
    [
      "POST /v1/threads/list HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${READ_TOKEN}`,
      `Authorization: Bearer ${READ_TOKEN}`,
      "Content-Type: application/json",
      "Content-Length: 2",
      "Connection: close",
      "",
      "{}",
    ].join("\r\n"),
  );
  assert.equal(repeatedAuth.status, 401);
  assert.deepEqual(repeatedAuth.body, { error: { code: "unauthorized" } });

  // Non-POST methods -> 405 method_not_allowed.
  for (const method of ["GET", "PUT", "DELETE"]) {
    const res = await fetch(`${endpoint}/v1/threads/list`, {
      method,
      headers: { authorization: `Bearer ${READ_TOKEN}` },
    });
    assert.equal(res.status, 405);
    assert.deepEqual(await res.json(), { error: { code: "method_not_allowed" } });
  }

  // Non-JSON Content-Type or disallowed Content-Encoding -> 415 json_required.
  for (const headers of [
    { authorization: `Bearer ${READ_TOKEN}`, "content-type": "text/plain" },
    { authorization: `Bearer ${READ_TOKEN}` },
    { authorization: `Bearer ${READ_TOKEN}`, "content-type": "application/json", "content-encoding": "gzip" },
  ]) {
    const res = await fetch(`${endpoint}/v1/threads/list`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(res.status, 415);
    assert.deepEqual(await res.json(), { error: { code: "json_required" } });
  }

  // Oversized body (> 8KiB) via Content-Length and via chunked streaming -> 413 body_too_large.
  const oversizedBody = JSON.stringify({ pad: "x".repeat(THREAD_READ_BODY_BYTES + 64) });
  const oversizedRes = await fetch(`${endpoint}/v1/threads/list`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${READ_TOKEN}`,
      "content-type": "application/json",
    },
    body: oversizedBody,
  });
  assert.equal(oversizedRes.status, 413);
  assert.deepEqual(await oversizedRes.json(), { error: { code: "body_too_large" } });

  const chunkedBody = Buffer.from(oversizedBody, "utf8");
  const chunkedOversized = await sendRawHttp(
    port,
    [
      "POST /v1/threads/list HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      `Authorization: Bearer ${READ_TOKEN}`,
      "Content-Type: application/json",
      "Transfer-Encoding: chunked",
      "Connection: close",
      "",
      `${chunkedBody.length.toString(16)}\r\n${chunkedBody.toString("utf8")}\r\n0\r\n\r\n`,
    ].join("\r\n"),
  );
  assert.equal(chunkedOversized.status, 413);
  assert.deepEqual(chunkedOversized.body, { error: { code: "body_too_large" } });

  // Concurrent lane occupied -> 429 thread_read_busy.
  let enteredFirst;
  let releaseFirst;
  const firstEntered = new Promise(resolve => { enteredFirst = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  readImpl = async () => {
    enteredFirst();
    await firstGate;
    return { threads: [], next_cursor: null, coverage: { partial: false, reasons: [] } };
  };

  const firstPromise = fetch(`${endpoint}/v1/threads/list`, {
    method: "POST",
    headers: { authorization: `Bearer ${READ_TOKEN}`, "content-type": "application/json" },
    body: "{}",
  });
  await firstEntered;

  const busyRes = await fetch(`${endpoint}/v1/threads/list`, {
    method: "POST",
    headers: { authorization: `Bearer ${READ_TOKEN}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(busyRes.status, 429);
  assert.deepEqual(await busyRes.json(), { error: { code: "thread_read_busy" } });

  releaseFirst();
  assert.equal((await firstPromise).status, 200);

  // Client disconnect aborts signal and releases the occupied lane.
  let abortedReason = null;
  let enteredDisconnect;
  const disconnectEntered = new Promise(resolve => { enteredDisconnect = resolve; });
  let disconnectFinished;
  const disconnectDone = new Promise(resolve => { disconnectFinished = resolve; });
  readImpl = async (_kind, _input, _access, { signal }) => {
    enteredDisconnect();
    await new Promise(resolve => {
      if (signal.aborted) { resolve(); return; }
      signal.addEventListener("abort", resolve, { once: true });
    });
    abortedReason = signal.reason;
    disconnectFinished();
    throw signal.reason;
  };

  const rawSocket = net.connect({ host: "127.0.0.1", port });
  context.after(() => { if (!rawSocket.destroyed) rawSocket.destroy(); });
  rawSocket.on("error", () => {});
  await once(rawSocket, "connect");
  rawSocket.write([
    "POST /v1/threads/list HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    `Authorization: Bearer ${READ_TOKEN}`,
    "Content-Type: application/json",
    "Content-Length: 2",
    "Connection: close",
    "",
    "{}",
  ].join("\r\n"));
  await disconnectEntered;
  rawSocket.destroy();
  await disconnectDone;
  assert.ok(abortedReason instanceof ThreadReadError);
  assert.equal(abortedReason.status, 499);
  assert.equal(abortedReason.code, "read_cancelled");

  // Closing control surface -> 503 control_closing and responseCheck is skipped.
  let responseCheckCalled = false;
  readImpl = async (_kind, _input, _access, { registerResponseCheck }) => {
    registerResponseCheck(() => { responseCheckCalled = true; });
    allowResponse = false;
    return { threads: [], next_cursor: null, coverage: { partial: false, reasons: [] } };
  };
  const closingRes = await fetch(`${endpoint}/v1/threads/list`, {
    method: "POST",
    headers: { authorization: `Bearer ${READ_TOKEN}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(closingRes.status, 503);
  assert.deepEqual(await closingRes.json(), { error: { code: "control_closing" } });
  assert.equal(responseCheckCalled, false);
});

test("createCodexCommunicationControl enforces read/write token separation across endpoints", async context => {
  const dir = makeTempDir(context, "codex-control-token-sep-");
  const ledgerPath = path.join(dir, "ledger.json");
  const baseOptions = {
    host: "127.0.0.1",
    port: 0,
    token: RECEIVE_TOKEN,
    principalId: "fixture-core",
    allowedOrigins: [{ host: "codex", conversation_id: "fixture-origin" }],
    allowedTargets: [{ conversation_id: THREAD_A, binding_generation: 1 }],
    ledgerPath,
    transport: { inspectAndDispatch: async () => ({ outcome: "busy", request_sent: false, thread_id: THREAD_A, turn_id: null, injection_method: null }) },
  };

  assert.throws(() => createCodexCommunicationControl({
    ...baseOptions,
    threadRead: {
      readToken: RECEIVE_TOKEN,
      access: { list: true, threadIds: new Set([THREAD_A]) },
      readThread: async () => ({ threads: [], next_cursor: null, coverage: { partial: false, reasons: [] } }),
    },
  }), error => error?.code === "thread_read_token_must_differ");

  const control = createCodexCommunicationControl({
    ...baseOptions,
    threadRead: {
      readToken: READ_TOKEN,
      access: { list: true, threadIds: new Set([THREAD_A]) },
      readThread: async () => ({ threads: [], next_cursor: null, coverage: { partial: false, reasons: [] } }),
    },
  });
  context.after(() => control.close());
  const { port } = await control.start();
  const endpoint = `http://127.0.0.1:${port}`;

  // Read endpoint accepts readToken and rejects write token.
  const listWithRead = await fetch(`${endpoint}/v1/threads/list`, {
    method: "POST",
    headers: { authorization: `Bearer ${READ_TOKEN}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(listWithRead.status, 200);

  const listWithWrite = await fetch(`${endpoint}/v1/threads/list`, {
    method: "POST",
    headers: { authorization: `Bearer ${RECEIVE_TOKEN}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(listWithWrite.status, 401);

  // Write endpoint rejects readToken.
  const writeWithRead = await fetch(`${endpoint}/v1/communication/deliveries`, {
    method: "POST",
    headers: { authorization: `Bearer ${READ_TOKEN}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(writeWithRead.status, 401);
});

// ============================================================================
// 3. Thread List & Snapshot Readers (createCodexThreadReader + createLiveCodexThreadReader)
// ============================================================================

test("createCodexThreadReader list enforces scope filtering, repeated cursor detection, and UTF-8 title clipping", async () => {
  const connection = { id: "conn-1" };
  const calls = [];
  const longMultibyteTitle = "测".repeat(200); // 600 UTF-8 bytes > 512 bytes
  let nextNativeReply = {
    data: [
      { id: THREAD_A, name: "Thread Alpha", projectId: "proj-1", updatedAt: 100, status: { type: "idle" } },
      { id: THREAD_B, name: longMultibyteTitle, projectId: "proj-2", updatedAt: 200, status: { type: "active" } },
      { id: THREAD_C, name: "Thread Outside Allowlist", projectId: "proj-3", updatedAt: 300, status: { type: "idle" } },
    ],
    nextCursor: "cursor-2",
  };
  const readThread = createCodexThreadReader({
    selectConnection: () => connection,
    isCurrent: current => current === connection,
    readNative: async (_conn, method, params) => {
      calls.push({ method, params });
      return nextNativeReply;
    },
    projectItem: (_conn, _threadId, _turnId, item) => item,
  });

  // allowed_threads scope: excludes THREAD_C, omits modelProviders, clips >512B title safely with text_limited.
  const allowedResult = await readThread("list", { limit: 10 }, {
    list: true,
    listScope: "allowed_threads",
    threadIds: new Set([THREAD_A, THREAD_B]),
  });
  assert.equal(calls[0].method, "thread/list");
  assert.equal(Object.hasOwn(calls[0].params, "modelProviders"), false);
  assert.deepEqual(allowedResult.threads.map(row => row.thread_id), [THREAD_A, THREAD_B]);
  assert.equal(allowedResult.next_cursor, "cursor-2");
  const clippedTitle = allowedResult.threads[1].title;
  assert.ok(Buffer.byteLength(clippedTitle, "utf8") <= 512);
  assert.equal(clippedTitle.includes("\uFFFD"), false);
  assert.equal(allowedResult.coverage.partial, true);
  assert.ok(allowedResult.coverage.reasons.includes("text_limited"));

  // current_account scope: includes modelProviders: [] and returns THREAD_C too.
  nextNativeReply = {
    data: [
      { id: THREAD_A, name: "Alpha", projectId: "proj-1", updatedAt: 100, status: { type: "idle" } },
      { id: THREAD_C, name: "Gamma", projectId: "proj-3", updatedAt: 300, status: { type: "idle" } },
    ],
    nextCursor: null,
  };
  const accountResult = await readThread("list", { limit: 10 }, {
    list: true,
    listScope: "current_account",
    threadIds: new Set([THREAD_A]),
  });
  assert.deepEqual(calls[1].params.modelProviders, []);
  assert.deepEqual(accountResult.threads.map(row => row.thread_id), [THREAD_A, THREAD_C]);
  assert.deepEqual(accountResult.coverage, { partial: false, reasons: [] });

  // Repeated cursor fails with native_cursor_repeated.
  nextNativeReply = { data: [], nextCursor: "cursor-stuck" };
  const repeatedResult = await readThread("list", { cursor: "cursor-stuck" }, {
    list: true,
    listScope: "allowed_threads",
    threadIds: new Set([THREAD_A]),
  });
  assert.deepEqual(repeatedResult.threads, []);
  assert.equal(repeatedResult.next_cursor, null);
  assert.deepEqual(repeatedResult.coverage, { partial: true, reasons: ["native_cursor_repeated"] });
});

test("createLiveCodexThreadReader snapshot keeps turn metadata with unavailable body when observation is null", async () => {
  const client = makeFakeDesktopClient(1);
  const methods = [];
  const proxy = {
    closed: false,
    writerEpoch: WRITER_EPOCH,
    _liveReadyClients: () => [client],
    _liveInjectRequest: async (_client, method) => {
      methods.push(method);
      if (method === "thread/turns/list") {
        return {
          threadId: THREAD_A,
          data: [
            {
              id: "turn-002",
              threadId: THREAD_A,
              status: "completed",
              startedAt: 3000,
              completedAt: 4000,
              itemsView: "notLoaded",
              items: [],
            },
            {
              id: "turn-001",
              threadId: THREAD_A,
              status: "completed",
              startedAt: 1000,
              completedAt: 2000,
              itemsView: "notLoaded",
              items: [],
            },
          ],
          nextCursor: null,
        };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };

  const reader = createLiveCodexThreadReader(proxy, ({ item }) => item, null);
  const snapshot = await reader("snapshot", { thread_id: THREAD_A, last_rounds: 3 }, {
    list: false,
    threadIds: new Set([THREAD_A]),
  });

  assert.deepEqual(methods, ["thread/turns/list"]);
  assert.equal(snapshot.thread_id, THREAD_A);
  assert.deepEqual(snapshot.turns, [
    {
      turn_id: "turn-001",
      started_at: 1000,
      completed_at: 2000,
      status: "completed",
      body_visibility: "unavailable",
      messages: [],
    },
    {
      turn_id: "turn-002",
      started_at: 3000,
      completed_at: 4000,
      status: "completed",
      body_visibility: "unavailable",
      messages: [],
    },
  ]);
  assert.equal(snapshot.coverage.partial, true);
  assert.ok(snapshot.coverage.reasons.includes("visibility_unavailable"));
});

test("createLiveCodexThreadReader + observation returns verified ordinary user and final_answer messages, filters proxy notices, commentary, moderated items, and revokes on connection/registryStamp change", async () => {
  const client = makeFakeDesktopClient(1);
  let registryStampValue = ["journal-rev-1", "comm-rev-1", MANIFEST_SHA];
  const observation = createNativeReadObservation({
    allowed: new Set([THREAD_A]),
    registryStamp: () => registryStampValue,
  });

  const commentaryItem = {
    id: "item-commentary-01",
    type: "agentMessage",
    phase: "commentary",
    text: "Internal commentary should be skipped.",
  };
  const proxyNoticeItem = {
    id: PROXY_NOTICE_ID,
    type: "agentMessage",
    phase: "final_answer",
    text: "Local proxy notice should be omitted.",
  };
  const proxyRootNoticeItem = {
    id: PROXY_ROOT_NOTICE_ID,
    type: "agentMessage",
    phase: "final_answer",
    text: "Local proxy root notice should also be omitted.",
  };

  const sealed = sealObservedTurn(observation, {
    client,
    threadId: THREAD_A,
    turnId: "turn-verified-01",
    startedAt: 1000,
    completedAt: 2500,
    extraItems: [commentaryItem, proxyNoticeItem, proxyRootNoticeItem],
    finalAnswerText: "Final verified assistant reply.",
  });

  const descItems = [
    { threadId: THREAD_A, turnId: sealed.turn.id, startedAtMs: 2400, completedAtMs: 2500, item: sealed.finalAnswerItem },
    { threadId: THREAD_A, turnId: sealed.turn.id, startedAtMs: 2300, completedAtMs: 2350, item: proxyRootNoticeItem },
    { threadId: THREAD_A, turnId: sealed.turn.id, startedAtMs: 2200, completedAtMs: 2250, item: proxyNoticeItem },
    { threadId: THREAD_A, turnId: sealed.turn.id, startedAtMs: 2000, completedAtMs: 2100, item: commentaryItem },
    { threadId: THREAD_A, turnId: sealed.turn.id, startedAtMs: 1000, completedAtMs: 1050, item: sealed.userItem },
  ];

  let onItemsList;
  const proxy = {
    closed: false,
    writerEpoch: WRITER_EPOCH,
    _liveReadyClients: () => [client],
    _liveInjectRequest: async (_client, method) => {
      if (method === "thread/turns/list") {
        return { threadId: THREAD_A, data: [sealed.turn], nextCursor: null };
      }
      if (method === "thread/items/list") {
        onItemsList?.();
        return { threadId: THREAD_A, data: descItems, nextCursor: null };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };

  const projectVisibleHistoryItem = ({ item, provenOrdinary }) => {
    if (item.type === "userMessage") return provenOrdinary ? item : undefined;
    if (item.type === "agentMessage") return item;
    return undefined;
  };

  const reader = createLiveCodexThreadReader(proxy, projectVisibleHistoryItem, observation);
  const access = { list: false, threadIds: new Set([THREAD_A]) };

  // Happy path: verified turn with filtered proxy notices and skipped commentary.
  let responseCheck = null;
  const verifiedSnapshot = await reader("snapshot", { thread_id: THREAD_A, last_rounds: 3 }, access, {
    registerResponseCheck: check => { responseCheck = check; },
  });
  assert.equal(verifiedSnapshot.turns.length, 1);
  assert.equal(verifiedSnapshot.turns[0].body_visibility, "verified");
  assert.deepEqual(verifiedSnapshot.turns[0].messages, [
    {
      role: "user",
      text: "Hello from ordinary desktop composer.",
      started_at_ms: 1000,
      completed_at_ms: 1050,
      visibility: "visible",
    },
    {
      role: "assistant",
      text: "Final verified assistant reply.",
      started_at_ms: 2400,
      completed_at_ms: 2500,
      visibility: "visible",
    },
  ]);
  assert.equal(verifiedSnapshot.coverage.partial, true);
  assert.deepEqual(verifiedSnapshot.coverage.reasons, ["local_notice_omitted"]);
  assert.equal(typeof responseCheck, "function");

  // Revocation via registryStamp change before response write clears bodies and downgrades visibility.
  registryStampValue = ["journal-rev-2", "comm-rev-1", MANIFEST_SHA];
  responseCheck();
  assert.equal(verifiedSnapshot.turns[0].body_visibility, "unavailable");
  assert.deepEqual(verifiedSnapshot.turns[0].messages, []);
  assert.ok(verifiedSnapshot.coverage.reasons.includes("visibility_unavailable"));

  // Restore stamp, then revoke mid-read during thread/items/list.
  registryStampValue = ["journal-rev-1", "comm-rev-1", MANIFEST_SHA];
  onItemsList = () => { registryStampValue = ["journal-rev-3", "comm-rev-1", MANIFEST_SHA]; };
  const midReadRevoked = await reader("snapshot", { thread_id: THREAD_A, last_rounds: 3 }, access);
  onItemsList = null;
  assert.equal(midReadRevoked.turns[0].body_visibility, "unavailable");
  assert.deepEqual(midReadRevoked.turns[0].messages, []);
  assert.ok(midReadRevoked.coverage.reasons.includes("visibility_unavailable"));

  // Connection switch before snapshot invalidates coverage and falls back to unavailable.
  registryStampValue = ["journal-rev-1", "comm-rev-1", MANIFEST_SHA];
  client.metadataUpstreamGeneration = 2;
  const switchedBeforeSnapshot = await reader("snapshot", { thread_id: THREAD_A, last_rounds: 3 }, access);
  assert.equal(switchedBeforeSnapshot.turns[0].body_visibility, "unavailable");
  assert.deepEqual(switchedBeforeSnapshot.turns[0].messages, []);
  assert.ok(switchedBeforeSnapshot.coverage.reasons.includes("visibility_unavailable"));

  // Connection switch during thread/items/list fails the read cleanly with native_connection_changed.
  client.metadataUpstreamGeneration = 1;
  onItemsList = () => { proxy.writerEpoch = "fixture-writer-epoch-02"; };
  const switchedMidRead = await reader("snapshot", { thread_id: THREAD_A, last_rounds: 3 }, access);
  onItemsList = null;
  proxy.writerEpoch = WRITER_EPOCH;
  assert.deepEqual(switchedMidRead.turns, []);
  assert.deepEqual(switchedMidRead.coverage, { partial: true, reasons: ["native_connection_changed"] });

  // Moderated assistant items are omitted with visibility_unavailable in createCodexThreadReader.
  const conn = { id: "conn-mod" };
  const proof = Object.freeze({ threadId: THREAD_A, turnId: "turn-mod-01" });
  const moderatedReader = createCodexThreadReader({
    selectConnection: () => conn,
    isCurrent: current => current === conn,
    proveTurnCoverage: () => proof,
    readNative: async (_conn, method) => {
      if (method === "thread/turns/list") {
        return {
          threadId: THREAD_A,
          data: [{
            id: "turn-mod-01",
            threadId: THREAD_A,
            status: "completed",
            startedAt: 10,
            completedAt: 20,
            itemsView: "notLoaded",
            items: [],
          }],
          nextCursor: null,
        };
      }
      return {
        threadId: THREAD_A,
        data: [
          {
            threadId: THREAD_A,
            turnId: "turn-mod-01",
            startedAtMs: 18,
            completedAtMs: 20,
            item: { id: "item-final", type: "agentMessage", phase: "final_answer", text: "Visible answer." },
          },
          {
            threadId: THREAD_A,
            turnId: "turn-mod-01",
            startedAtMs: 16,
            completedAtMs: 17,
            item: {
              id: "item-moderated",
              type: "agentMessage",
              phase: "final_answer",
              text: "Moderated content.",
              moderation: { moderated: true },
            },
          },
          {
            threadId: THREAD_A,
            turnId: "turn-mod-01",
            startedAtMs: 14,
            completedAtMs: 15,
            item: { id: "item-commentary", type: "agentMessage", phase: "commentary", text: "Skip commentary." },
          },
          {
            threadId: THREAD_A,
            turnId: "turn-mod-01",
            startedAtMs: 12,
            completedAtMs: 13,
            item: { id: PROXY_NOTICE_ID, type: "agentMessage", phase: "final_answer", text: "Proxy notice." },
          },
          {
            threadId: THREAD_A,
            turnId: "turn-mod-01",
            startedAtMs: 10,
            completedAtMs: 11,
            item: { id: "item-user", type: "userMessage", content: [{ type: "text", text: "Ordinary question." }] },
          },
        ],
        nextCursor: null,
      };
    },
    projectItem: (_conn, _threadId, _turnId, item) => item,
  });

  const moderatedResult = await moderatedReader("snapshot", { thread_id: THREAD_A }, access);
  assert.equal(moderatedResult.turns[0].body_visibility, "verified");
  assert.deepEqual(moderatedResult.turns[0].messages.map(m => [m.role, m.text]), [
    ["user", "Ordinary question."],
    ["assistant", "Visible answer."],
  ]);
  assert.ok(moderatedResult.coverage.reasons.includes("local_notice_omitted"));
  assert.ok(moderatedResult.coverage.reasons.includes("visibility_unavailable"));
});

// ============================================================================
// 4. createNativeReadObservation Desktop Allowlist & Negative Rejection Matrix
// ============================================================================

test("createNativeReadObservation positive desktop allowlist seals turns with normalized UUID, both ordinary triggers, all 6 benign additionalContext keys, and codex client metadata", () => {
  const client = makeFakeDesktopClient(1);
  const observation = createNativeReadObservation({
    allowed: new Set([THREAD_A]),
    registryStamp: () => ["journal-rev-1", "comm-rev-1", MANIFEST_SHA],
  });

  for (const [index, trigger] of ["composer", "edit_user_message"].entries()) {
    const startParams = makeBenignStartParams({
      threadId: THREAD_A,
      turnTrigger: trigger,
      clientUserMessageId: index === 0 ? CLIENT_MSG_UUID_UPPER : CLIENT_MSG_UUID_LOWER,
    });
    const captured = observation.capture(startParams);
    assert.ok(captured, `trigger ${trigger} should be accepted`);
    assert.equal(Object.isFrozen(captured), true);
    assert.equal(captured.clientId, CLIENT_MSG_UUID_LOWER);

    const turnId = `turn-allow-${index + 1}`;
    const sealed = sealObservedTurn(observation, {
      client,
      threadId: THREAD_A,
      turnId,
      startedAt: 1000 + index * 100,
      completedAt: 1050 + index * 100,
      startParams,
      userItemId: `user-item-${index + 1}`,
      userItemClientId: index === 0 ? CLIENT_MSG_UUID_LOWER : CLIENT_MSG_UUID_UPPER,
      finalAnswerId: `final-item-${index + 1}`,
    });

    const proof = observation.coverage(client, WRITER_EPOCH, THREAD_A, sealed.turn);
    assert.ok(proof);
    assert.equal(Object.isFrozen(proof), true);
    assert.equal(observation.ownsInput(proof, sealed.userItem), true);
    assert.equal(observation.ownsInput(proof, sealed.finalAnswerItem), false);
    assert.equal(
      observation.verifyItems(proof, sealed.items.map(item => ({ item }))),
      true,
    );
  }

  // Empty array / null additionalContext and null clientUserMessageId are also accepted.
  const minimal = observation.capture({
    threadId: THREAD_A,
    clientUserMessageId: null,
    additionalContext: [],
    responsesapiClientMetadata: { source: "codex" },
    input: [{ type: "text", text: "Minimal benign input." }],
  });
  assert.ok(minimal);
  assert.equal(minimal.clientId, null);
});

test("createNativeReadObservation negative rejection matrix blocks non-UUID, unknown triggers, non-benign context, metadata violations, propagation keys, patches, and tool/parent/root fields", () => {
  const observation = createNativeReadObservation({
    allowed: new Set([THREAD_A]),
    registryStamp: () => ["journal-rev-1", "comm-rev-1", MANIFEST_SHA],
  });

  const sensitivePropagationKeys = [
    "daybreak_propagation_source",
    "prediction_source_thread_id",
    "prediction_source_turn_id",
    "prediction_trigger",
    "misalignment_override",
  ];

  const negativeCases = [
    ["unallowed threadId", makeBenignStartParams({ threadId: THREAD_B })],
    ["non-UUID clientUserMessageId (plain string)", makeBenignStartParams({ clientUserMessageId: "not-a-uuid" })],
    ["non-UUID clientUserMessageId (communication prefix)", makeBenignStartParams({ clientUserMessageId: `communication-${"a".repeat(64)}` })],
    ["non-UUID clientUserMessageId (number)", makeBenignStartParams({ clientUserMessageId: 42 })],
    ["unknown turnTrigger", makeBenignStartParams({ turnTrigger: "automation" })],
    ["empty turnTrigger", makeBenignStartParams({ turnTrigger: "" })],
    [
      "unknown additionalContext key",
      makeBenignStartParams({
        additionalContext: {
          ...makeBenignStartParams().additionalContext,
          unknown_desktop_context: { kind: "application", value: "injected" },
        },
      }),
    ],
    [
      "benign additionalContext key with wrong kind",
      makeBenignStartParams({
        additionalContext: {
          codex_git_state: { kind: "application", value: "clean" },
        },
      }),
    ],
    [
      "application additionalContext key with unexpected name field",
      makeBenignStartParams({
        additionalContext: {
          worktree_preference: { kind: "application", value: "current", name: "extra" },
        },
      }),
    ],
    [
      "non-null codex_apps_open_page",
      makeBenignStartParams({
        additionalContext: {
          codex_apps_open_page: { kind: "untrusted", value: "{\"page_id\":\"page-123\"}" },
        },
      }),
    ],
    [
      "non-null Companion Page snapshot (page_id)",
      makeBenignStartParams({
        additionalContext: {
          codex_apps_selected_page_part_1_of_1: {
            kind: "untrusted",
            value: "Companion Page snapshot part 1 of 1: {\"page_id\":\"page-123\",\"document_view\":null}",
          },
        },
      }),
    ],
    [
      "non-null Companion Page snapshot (document_view)",
      makeBenignStartParams({
        additionalContext: {
          codex_apps_selected_page_part_1_of_1: {
            kind: "untrusted",
            value: "Companion Page snapshot part 1 of 1: {\"page_id\":null,\"document_view\":{\"title\":\"Doc\"}}",
          },
        },
      }),
    ],
    [
      "responsesapiClientMetadata.source !== codex",
      makeBenignStartParams({
        responsesapiClientMetadata: { source: "external-relay" },
      }),
    ],
    [
      "responsesapiClientMetadata non-string value",
      makeBenignStartParams({
        responsesapiClientMetadata: { source: "codex", nested: { bad: true } },
      }),
    ],
    ...sensitivePropagationKeys.map(key => [
      `sensitive propagation key: ${key}`,
      makeBenignStartParams({
        responsesapiClientMetadata: { source: "codex", [key]: "propagated-value" },
      }),
    ]),
    [
      "responsesapiClientMetadataPatch != null",
      makeBenignStartParams({ responsesapiClientMetadataPatch: { source: "codex" } }),
    ],
    [
      "toolOutput != null",
      makeBenignStartParams({ toolOutput: { stdout: "ok" } }),
    ],
    [
      "parentTurnId != null",
      makeBenignStartParams({ parentTurnId: "turn-parent-01" }),
    ],
    [
      "rootTurnId != null",
      makeBenignStartParams({ rootTurnId: "turn-root-01" }),
    ],
  ];

  for (const [label, params] of negativeCases) {
    assert.equal(observation.capture(params), null, `expected capture to reject: ${label}`);
  }
});

test("createNativeReadObservation invalidates active turns and prior sealed proofs on turn/steer, turn/interrupt, thread/rollback, and moderated completion", () => {
  const client = makeFakeDesktopClient(1);

  for (const disruptingMethod of ["turn/steer", "turn/interrupt", "thread/rollback"]) {
    const observation = createNativeReadObservation({
      allowed: new Set([THREAD_A]),
      registryStamp: () => ["journal-rev-1", "comm-rev-1", MANIFEST_SHA],
    });

    // Seal a prior turn first to confirm disruption also clears existing sealed proofs for the thread.
    const prior = sealObservedTurn(observation, {
      client,
      threadId: THREAD_A,
      turnId: "turn-prior-01",
      startedAt: 100,
      completedAt: 200,
    });
    assert.ok(observation.coverage(client, WRITER_EPOCH, THREAD_A, prior.turn));

    // Start an active turn, then receive the disrupting method mid-turn.
    const startParams = makeBenignStartParams({ threadId: THREAD_A });
    const readInput = observation.capture(startParams);
    assert.ok(readInput);
    const tracking = { threadId: THREAD_A, readInput };
    observation.forwarded(client, WRITER_EPOCH, "turn/start", THREAD_A, tracking);
    observation.reply(client, WRITER_EPOCH, tracking, {
      result: { threadId: THREAD_A, turn: { id: "turn-active-02", threadId: THREAD_A, status: "inProgress" } },
    });
    observation.notify(client, WRITER_EPOCH, {
      method: "turn/started",
      params: { threadId: THREAD_A, turn: { id: "turn-active-02", status: "inProgress" } },
    });

    observation.forwarded(client, WRITER_EPOCH, disruptingMethod, THREAD_A, { threadId: THREAD_A });

    // Even if item/turn completion notifications subsequently arrive, no proof can be sealed.
    const userItem = {
      id: "item-u2",
      type: "userMessage",
      clientId: CLIENT_MSG_UUID_LOWER,
      content: startParams.input,
    };
    const finalItem = {
      id: "item-a2",
      type: "agentMessage",
      phase: "final_answer",
      text: "Should never seal after disruption.",
    };
    for (const item of [userItem, finalItem]) {
      observation.notify(client, WRITER_EPOCH, {
        method: "item/started",
        params: { threadId: THREAD_A, turnId: "turn-active-02", item },
      });
      observation.notify(client, WRITER_EPOCH, {
        method: "item/completed",
        params: { threadId: THREAD_A, turnId: "turn-active-02", item },
      });
    }
    observation.notify(client, WRITER_EPOCH, {
      method: "turn/completed",
      params: {
        threadId: THREAD_A,
        turn: {
          id: "turn-active-02",
          status: "completed",
          startedAt: 300,
          completedAt: 400,
          itemsView: "full",
          items: [userItem, finalItem],
        },
      },
    });

    assert.equal(
      observation.coverage(client, WRITER_EPOCH, THREAD_A, prior.turn),
      null,
      `${disruptingMethod} must invalidate prior sealed proof`,
    );
    assert.equal(
      observation.coverage(client, WRITER_EPOCH, THREAD_A, {
        id: "turn-active-02",
        status: "completed",
        startedAt: 300,
        completedAt: 400,
      }),
      null,
      `${disruptingMethod} must invalidate active turn`,
    );
  }

  // Moderated agentMessage during item/completed also invalidates observation sealing.
  const modObs = createNativeReadObservation({
    allowed: new Set([THREAD_A]),
    registryStamp: () => ["journal-rev-1", "comm-rev-1", MANIFEST_SHA],
  });
  const startParams = makeBenignStartParams({ threadId: THREAD_A });
  const readInput = modObs.capture(startParams);
  const tracking = { threadId: THREAD_A, readInput };
  modObs.forwarded(client, WRITER_EPOCH, "turn/start", THREAD_A, tracking);
  modObs.reply(client, WRITER_EPOCH, tracking, {
    result: { threadId: THREAD_A, turn: { id: "turn-mod-obs", threadId: THREAD_A, status: "inProgress" } },
  });
  modObs.notify(client, WRITER_EPOCH, {
    method: "turn/started",
    params: { threadId: THREAD_A, turn: { id: "turn-mod-obs", status: "inProgress" } },
  });
  const userItem = {
    id: "item-mod-u",
    type: "userMessage",
    clientId: CLIENT_MSG_UUID_LOWER,
    content: startParams.input,
  };
  const moderatedAgent = {
    id: "item-mod-a",
    type: "agentMessage",
    phase: "final_answer",
    text: "Moderated reply.",
    moderation: { moderated: true },
  };
  modObs.notify(client, WRITER_EPOCH, {
    method: "item/started",
    params: { threadId: THREAD_A, turnId: "turn-mod-obs", item: userItem },
  });
  modObs.notify(client, WRITER_EPOCH, {
    method: "item/completed",
    params: { threadId: THREAD_A, turnId: "turn-mod-obs", item: userItem },
  });
  modObs.notify(client, WRITER_EPOCH, {
    method: "item/started",
    params: { threadId: THREAD_A, turnId: "turn-mod-obs", item: moderatedAgent },
  });
  modObs.notify(client, WRITER_EPOCH, {
    method: "item/completed",
    params: { threadId: THREAD_A, turnId: "turn-mod-obs", item: moderatedAgent },
  });
  modObs.notify(client, WRITER_EPOCH, {
    method: "turn/completed",
    params: {
      threadId: THREAD_A,
      turn: {
        id: "turn-mod-obs",
        status: "completed",
        startedAt: 500,
        completedAt: 600,
        itemsView: "notLoaded",
        items: [],
      },
    },
  });
  assert.equal(
    modObs.coverage(client, WRITER_EPOCH, THREAD_A, {
      id: "turn-mod-obs",
      status: "completed",
      startedAt: 500,
      completedAt: 600,
    }),
    null,
  );
});
