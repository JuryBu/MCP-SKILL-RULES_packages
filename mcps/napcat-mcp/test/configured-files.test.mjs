import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { createNapCatNotifier } from "../src/core.mjs";
import { createConfiguredFileAccess } from "../src/configured-files.mjs";

const payload = Buffer.from("configured attachment\n", "utf8");
const selfId = "1000000001";
const peerId = "1000000002";
const groupId = "2000000001";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function waitFor(predicate) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Owned MCP cancellation state did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForGate(gate) {
  let timer;
  try {
    await Promise.race([gate.promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Owned MCP cancellation gate timed out")), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

function message(overrides = {}) {
  return {
    message_id: "501",
    message_seq: "601",
    message_type: "group",
    group_id: groupId,
    user_id: peerId,
    time: 1794816000,
    sender: { user_id: peerId, nickname: "ExamplePeer" },
    raw_message: "普通消息，没有引用或艾特\n" + "正文".repeat(1500),
    message: [
      { type: "text", data: { text: "普通消息" } },
      { type: "file", data: { file_id: "original-file-501", file: "原附件.txt", file_size: payload.length, busid: 102 } },
      { type: "image", data: { file: "image-501", url: "https://media.example.invalid/image" } },
    ],
    ...overrides,
  };
}

function fixture(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-configured-files-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bindingPath = path.join(root, "binding.json");
  const binding = {
    schemaVersion: 2,
    expectedSelfId: selfId,
    groupId: "2000000099",
    groupName: "ExampleTraining",
    expectedMemberCount: 4,
    controlPlane: {
      enabled: true,
      defaultTargetKey: "room",
      targets: {
        room: { type: "group", id: groupId, name: "ExampleRoom", expectedMemberCount: 3 },
        other: { type: "group", id: "2000000003", name: "ExampleOther" },
        owner: { type: "private", id: peerId, name: "ExamplePeer" },
      },
    },
  };
  fs.writeFileSync(bindingPath, JSON.stringify(binding), "utf8");
  const calls = [];
  const original = options.message ?? message();
  const messages = options.messages ?? [original];
  async function action(actionName, params) {
    calls.push({ action: actionName, params });
    switch (actionName) {
      case "get_status": return { online: true, good: true };
      case "get_login_info": return { user_id: selfId, nickname: "ExampleBot" };
      case "get_friend_list": return [{ user_id: peerId, nickname: "ExamplePeer" }];
      case "get_group_info": return { group_id: params.group_id, group_name: params.group_id === groupId ? "ExampleRoom" : "ExampleOther", member_count: 3 };
      case "get_group_msg_history":
      case "get_friend_msg_history": return options.invalidHistory ? {} : { messages };
      case "get_msg": return options.reloadedMessage ?? original;
      case "get_group_file_url":
      case "get_private_file_url":
        if (options.urlFailure) throw new Error("private-internal-error-token");
        return { url: options.downloadUrl ?? "https://files.example.invalid/original" };
      default: throw new Error(`Unexpected fixture action: ${actionName}`);
    }
  }
  const fetchImpl = async (url, request = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "127.0.0.1") {
      const data = await action(parsed.pathname.slice(1), JSON.parse(request.body));
      return new Response(JSON.stringify({ status: "ok", retcode: 0, data }));
    }
    calls.push({ action: "download", url });
    if (options.download) return options.download(url, request);
    return new Response(options.bytes ?? payload, { headers: options.headers });
  };
  const env = {
    NAPCAT_MCP_BINDING_PATH: bindingPath,
    NAPCAT_MCP_STATE_PATH: path.join(root, "state.json"),
    NAPCAT_HTTP_URL: "http://127.0.0.1:39123",
    NAPCAT_ALLOW_EMPTY_TOKEN: "1",
    ...(options.maximumBytes ? { NAPCAT_MAX_FILE_BYTES: String(options.maximumBytes) } : {}),
  };
  const createNotifier = () => createNapCatNotifier({ env, fetchImpl });
  const notifier = createNotifier();
  const downloadInput = async (targetKey = "room") => {
    const recent = await notifier.readConfiguredRecent({ target_key: targetKey });
    return {
      target_key: targetKey,
      message_id: recent.messages[0].messageId,
      attachment_ref: recent.messages[0].attachments.find((item) => item.downloadable).attachment_ref,
      destination_dir: path.join(root, "中文 空格"),
    };
  };
  return { root, bindingPath, binding, calls, notifier, downloadInput, original, messages, action, env, createNotifier };
}

test("configured recent keeps ordinary messages, original identity, full text, owner content and bound files", async (context) => {
  const setup = fixture(context);
  const recent = await setup.notifier.readConfiguredRecent({ target_key: "room" });
  assert.equal(recent.requestedCount, 20);
  assert.equal(recent.returnedCount, 1);
  const actual = recent.messages[0];
  assert.equal(actual.messageId, "501");
  assert.equal(actual.messageSeq, "601");
  assert.equal(actual.text, setup.original.raw_message);
  assert.equal(actual.ownerEventContent.text, setup.original.raw_message);
  assert.equal(actual.sender.user_id, peerId);
  assert.equal(actual.senderId, peerId);
  assert.deepEqual(actual.mentionedUserIds, []);
  assert.equal(actual.replyMessageId, "");
  assert.match(actual.attachments[0].attachment_ref, /^ncf1:[a-f0-9]{64}$/);
  assert.equal(actual.attachments[1].type, "image");
  assert.equal(actual.attachments[1].downloadable, false);
  assert.equal(recent.pagination.status, "unknown");
  assert.equal(recent.pagination.nextBeforeMessageId, null);
  assert.equal(recent.pagination.hasMore, null);
  const repeated = await setup.notifier.readConfiguredRecent({ target_key: "room", count: 50, include_owner_event_content: false });
  assert.equal(repeated.messages[0].attachments[0].attachment_ref, actual.attachments[0].attachment_ref);
  assert.equal("ownerEventContent" in repeated.messages[0], false);
  const legacy = await setup.notifier.readConfiguredTargetMessages({ target_key: "room" });
  assert.equal(legacy.messages[0].text.length, 2000);
  assert.equal("ownerEventContent" in legacy.messages[0], false);
  assert.equal("attachment_ref" in legacy.messages[0].attachments[0], false);
  assert.equal(fs.existsSync(path.join(setup.root, "state.json")), false);
});

test("configured recent validates exact inputs and refuses unverified pagination before network", async (context) => {
  const setup = fixture(context);
  for (const count of [0, 51, 1.5, "20", null]) {
    await assert.rejects(setup.notifier.readConfiguredRecent({ target_key: "room", count }), { code: "INVALID_ARGUMENT" });
  }
  for (const input of [{}, { target_key: "room", group_id: groupId }, { target_key: "room", include_owner_event_content: "true" }]) {
    await assert.rejects(setup.notifier.readConfiguredRecent(input), { code: "INVALID_ARGUMENT" });
  }
  await assert.rejects(setup.notifier.readConfiguredRecent({ target_key: "room", before_message_id: "501" }), { code: "HISTORY_CURSOR_UNVERIFIED" });
  assert.equal(setup.calls.length, 0);
  for (const target_key of ["missing", "__proto__", "constructor"]) {
    await assert.rejects(setup.notifier.readConfiguredRecent({ target_key }), { code: "CONTROL_TARGET_NOT_FOUND" });
  }
  assert.equal(setup.calls.length, 0);
});

test("configured group download rechecks original message, uses configured group, hashes and cleans part", async (context) => {
  const setup = fixture(context);
  const input = await setup.downloadInput();
  const result = await setup.notifier.downloadConfiguredFile(input);
  assert.equal(result.downloaded, true);
  assert.equal(result.published, true);
  assert.equal(result.outcomeUnknown, false);
  assert.equal(result.sourceMessageId, input.message_id);
  assert.equal(result.attachment_ref, input.attachment_ref);
  assert.equal(result.resolvedBusId, 102);
  assert.equal(result.fileBytes, payload.length);
  assert.equal(result.sha256, createHash("sha256").update(payload).digest("hex"));
  assert.deepEqual(fs.readFileSync(result.filePath), payload);
  assert.equal(result.cleanupPending, false);
  assert.equal(result.retryRecommended, false);
  assert.equal(setup.calls.some((item) => item.action === "get_msg" && item.params.message_id === "501"), true);
  const lookup = setup.calls.find((item) => item.action === "get_group_file_url");
  assert.deepEqual(lookup.params, { group_id: groupId, file_id: "original-file-501", busid: 102 });
  assert.equal(fs.readdirSync(input.destination_dir).some((name) => name.includes(".part-")), false);
});

test("configured private download uses native private API for verified inbound and outbound messages", async (context) => {
  for (const senderId of [peerId, selfId]) {
    const setup = fixture(context, { message: message({ message_type: "private", group_id: undefined, user_id: senderId, sender: { user_id: senderId } }) });
    const input = await setup.downloadInput("owner");
    const result = await setup.notifier.downloadConfiguredFile(input);
    assert.equal(result.downloaded, true);
    assert.equal(result.sourceMessageId, input.message_id);
    assert.equal(result.attachment_ref, input.attachment_ref);
    assert.equal(result.resolvedBusId, null);
    assert.deepEqual(setup.calls.find((item) => item.action === "get_private_file_url").params, { file_id: "original-file-501" });
    assert.equal(setup.calls.some((item) => item.action === "get_group_file_url"), false);
  }
});

test("cross target, cross message, changed file and unverified private outbound references fail closed", async (context) => {
  const setup = fixture(context);
  const input = await setup.downloadInput();
  await assert.rejects(setup.notifier.downloadConfiguredFile({ ...input, target_key: "other" }), { code: "MESSAGE_TARGET_MISMATCH" });
  await assert.rejects(setup.notifier.downloadConfiguredFile({ ...input, message_id: "999" }), { code: "MESSAGE_ID_MISMATCH" });
  await assert.rejects(setup.notifier.downloadConfiguredFile({ ...input, attachment_ref: "ncf1:" + "0".repeat(64) }), { code: "ATTACHMENT_REF_MISMATCH" });
  setup.original.message[1].data.file_id = "changed-file";
  await assert.rejects(setup.notifier.downloadConfiguredFile(input), { code: "ATTACHMENT_REF_MISMATCH" });
  assert.equal(setup.calls.some((item) => item.action.endsWith("file_url") || item.action === "download"), false);
  const privateSetup = fixture(context, { message: message({ message_type: "private", group_id: undefined, sender: { user_id: selfId }, user_id: selfId }) });
  const privateInput = await privateSetup.downloadInput("owner");
  privateSetup.messages.splice(0);
  await assert.rejects(privateSetup.notifier.downloadConfiguredFile(privateInput), { code: "MESSAGE_TARGET_UNVERIFIED" });
});

test("missing and null native file names normalize to strings and use the generated fallback", async (context) => {
  for (const absentName of [undefined, null]) {
    const original = message();
    original.message[1].data.file = absentName;
    original.message[1].data.file_name = absentName;
    original.message[1].data.name = absentName;
    const setup = fixture(context, { message: original });
    const recent = await setup.notifier.readConfiguredRecent({ target_key: "room" });
    assert.equal(recent.messages[0].attachments[0].fileName, "");
    assert.equal(typeof recent.messages[0].attachments[0].fileName, "string");
    const input = await setup.downloadInput();
    const result = await setup.notifier.downloadConfiguredFile(input);
    assert.equal(result.fileName, `napcat-file-${input.attachment_ref.slice(5, 17)}`);
    assert.deepEqual(fs.readFileSync(result.filePath), payload);
  }
});

test("download rejects raw identities, unsafe names, and nonabsolute directory without side effects", async (context) => {
  const setup = fixture(context);
  const input = await setup.downloadInput();
  const before = setup.calls.length;
  for (const extra of [{ url: "https://example.invalid" }, { file_id: "raw" }, { group_id: groupId }]) {
    await assert.rejects(setup.notifier.downloadConfiguredFile({ ...input, ...extra }), { code: "INVALID_ARGUMENT" });
  }
  for (const name of ["..", "../x", "a\\b", "x:stream", "NUL.txt", "x.", "x ", "a\u0000b"]) {
    await assert.rejects(setup.notifier.downloadConfiguredFile({ ...input, name }), { code: "INVALID_FILE_NAME" });
  }
  await assert.rejects(setup.notifier.downloadConfiguredFile({ ...input, destination_dir: "relative" }), { code: "DOWNLOAD_DIRECTORY_NOT_ABSOLUTE" });
  assert.equal(setup.calls.length, before);
});

test("Windows exclusive hardlink publication gives exactly one concurrent winner and preserves existing bytes", async (context) => {
  const setup = fixture(context);
  const input = { ...(await setup.downloadInput()), name: "并发结果.txt" };
  const outcomes = await Promise.allSettled([setup.notifier.downloadConfiguredFile(input), setup.createNotifier().downloadConfiguredFile(input)]);
  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((item) => item.status === "rejected").reason.code, "DOWNLOAD_TARGET_EXISTS");
  const destination = path.join(input.destination_dir, input.name);
  assert.deepEqual(fs.readFileSync(destination), payload);
  fs.writeFileSync(destination, "existing-content", "utf8");
  await assert.rejects(setup.notifier.downloadConfiguredFile(input), { code: "DOWNLOAD_TARGET_EXISTS" });
  assert.equal(fs.readFileSync(destination, "utf8"), "existing-content");
  assert.deepEqual(fs.readdirSync(input.destination_dir), [input.name]);
  console.log(`exclusive publication platform=${process.platform}; winners=1; losers=1; existing bytes preserved; parts=0`);
});

test("download enforces declared and streaming size, empty and truncated data, and removes partial files", async (context) => {
  for (const options of [
    { maximumBytes: 1, expected: "FILE_TOO_LARGE" },
    { maximumBytes: 50, headers: { "content-length": "100" }, expected: "FILE_TOO_LARGE" },
    { maximumBytes: 50, bytes: Buffer.alloc(80), expected: "FILE_TOO_LARGE" },
    { bytes: Buffer.alloc(0), expected: "FILE_EMPTY" },
    { bytes: Buffer.from("short"), expected: "FILE_SIZE_MISMATCH" },
    { downloadUrl: "file:///never-read", expected: "FILE_URL_INVALID" },
  ]) {
    const setup = fixture(context, options);
    const input = await setup.downloadInput();
    await assert.rejects(setup.notifier.downloadConfiguredFile(input), { code: options.expected });
    if (fs.existsSync(input.destination_dir)) assert.deepEqual(fs.readdirSync(input.destination_dir), []);
  }
});

test("unknown URL lookup failure makes a single attempt with no fallback or download", async (context) => {
  const setup = fixture(context, { urlFailure: true });
  const input = await setup.downloadInput();
  await assert.rejects(setup.notifier.downloadConfiguredFile(input), { code: "ONEBOT_NETWORK_ERROR", outcomeUnknown: true });
  assert.equal(setup.calls.filter((item) => item.action === "get_group_file_url").length, 1);
  assert.equal(setup.calls.some((item) => item.action === "download"), false);
});

test("malformed or wrong-target history fails explicitly without claiming empty completion", async (context) => {
  const invalid = fixture(context, { invalidHistory: true });
  await assert.rejects(invalid.notifier.readConfiguredRecent({ target_key: "room" }), { code: "HISTORY_RESPONSE_INVALID" });
  const mismatch = fixture(context, { message: message({ group_id: "2000000003" }) });
  await assert.rejects(mismatch.notifier.readConfiguredRecent({ target_key: "room" }), { code: "MESSAGE_TARGET_MISMATCH" });
});

test("CQ file metadata and ordinary self, mention and quote messages remain readable across notifier recreation", async (context) => {
  const original = message({
    raw_message: "[CQ:reply,id=499][CQ:at,qq=1000000001] [CQ:file,file=正文&#44;v1.txt,file_id=encoded-original,file_size=22,busid=102]",
    message: "[CQ:reply,id=499][CQ:at,qq=1000000001] [CQ:file,file=正文&#44;v1.txt,file_id=encoded-original,file_size=22,busid=102]",
    sender: { user_id: selfId }, user_id: selfId,
  });
  const setup = fixture(context, { message: original });
  const recent = await setup.notifier.readConfiguredRecent({ target_key: "room", count: 1 });
  assert.equal(recent.returnedCount, 1);
  assert.equal(recent.messages[0].isSelf, true);
  assert.equal(recent.messages[0].replyMessageId, "499");
  assert.equal(recent.messages[0].attachments[0].fileName, "正文,v1.txt");
  const reopened = await setup.createNotifier().readConfiguredRecent({ target_key: "room", count: 1 });
  assert.equal(reopened.messages[0].attachments[0].attachment_ref, recent.messages[0].attachments[0].attachment_ref);
});

test("exclusive publication refuses unavailable hardlinks without unsafe rename fallback", async (context) => {
  const setup = fixture(context);
  const input = await setup.downloadInput();
  const originalLink = fs.promises.link;
  fs.promises.link = async () => { const error = new Error("links unavailable"); error.code = "ENOTSUP"; throw error; };
  try {
    await assert.rejects(setup.notifier.downloadConfiguredFile(input), { code: "FILE_DOWNLOAD_FAILED" });
  } finally {
    fs.promises.link = originalLink;
  }
  assert.deepEqual(fs.readdirSync(input.destination_dir), []);
});

test("body timeout aborts stream, preserves failure, and removes the partial file", async (context) => {
  const setup = fixture(context);
  class TestError extends Error {
    constructor(code, text, extra = {}) { super(text); this.code = code; this.details = extra.details; }
  }
  let cancelled = false;
  const access = createConfiguredFileAccess({
    loadBinding: () => setup.binding,
    checkConfiguredTarget: async () => ({ target: { targetKey: "room", type: "group", id: groupId }, login: {} }),
    callOneBot: setup.action,
    summarizeMessage: (raw) => ({ messageId: raw.message_id, messageSeq: raw.message_seq, attachments: [
      { type: "file", fileId: "original-file-501", fileName: "timeout.txt", fileBytes: null, busId: 102 },
    ] }),
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
      cancel() { cancelled = true; },
    })),
    maximumFileBytes: 50,
    fileDownloadTimeoutMs: 30,
    ErrorClass: TestError,
  });
  const recent = await access.readConfiguredRecent({ target_key: "room" });
  const destinationDirectory = path.join(setup.root, "timeout");
  await assert.rejects(access.downloadConfiguredFile({
    target_key: "room", message_id: "501", attachment_ref: recent.messages[0].attachments[0].attachment_ref,
    destination_dir: destinationDirectory,
  }), { code: "CONFIGURED_OPERATION_TIMEOUT" });
  assert.equal(cancelled, true);
  assert.deepEqual(fs.readdirSync(destinationDirectory), []);
});

test("cleanup failure is reported with its exact owned partial path after successful publication", async (context) => {
  const setup = fixture(context);
  const input = await setup.downloadInput();
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = (filePath) => {
    if (String(filePath).includes(".part-")) { const error = new Error("temporary file locked"); error.code = "EACCES"; throw error; }
    return originalUnlink(filePath);
  };
  let result;
  try {
    result = await setup.notifier.downloadConfiguredFile(input);
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(result.downloaded, true);
  assert.equal(result.cleanupPending, true);
  assert.equal(path.dirname(result.temporaryPath), input.destination_dir);
  assert.deepEqual(fs.readFileSync(result.filePath), payload);
  await fs.promises.unlink(result.temporaryPath);
  assert.deepEqual(fs.readdirSync(input.destination_dir), [result.fileName]);
});

test("real isolated stdio MCP advertises exact tools, reads, downloads and hides internal exceptions", async (context) => {
  const setup = fixture(context);
  let explicitFileFailure = false;
  let holdPreparation = false;
  let holdFileBody = false;
  const preparationEntered = deferred();
  const preparationRelease = deferred();
  const preparationResponded = deferred();
  const fileEntered = deferred();
  const fileClosed = deferred();
  context.after(() => preparationRelease.resolve());
  const httpServer = http.createServer(async (request, response) => {
    if (request.url === "/file") {
      if (holdFileBody) {
        response.setHeader("content-length", String(payload.length));
        response.once("close", () => fileClosed.resolve());
        response.write(payload.subarray(0, 3));
        fileEntered.resolve();
      } else response.end(payload);
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const params = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (params.group_id === "force-internal") { response.end("internal-token"); return; }
    if (explicitFileFailure && request.url.endsWith("file_url")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "failed", retcode: 1404, wording: "private-internal-lookup-detail" }));
      return;
    }
    if (holdPreparation && request.url === "/get_msg") {
      preparationEntered.resolve();
      await preparationRelease.promise;
    }
    const data = await setup.action(request.url.slice(1), params);
    const actualData = request.url.endsWith("file_url") ? { url: `http://127.0.0.1:${httpServer.address().port}/file` } : data;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok", retcode: 0, data: actualData }));
    if (holdPreparation && request.url === "/get_msg") preparationResponded.resolve();
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  context.after(() => new Promise((resolve) => { httpServer.closeAllConnections(); httpServer.close(resolve); }));
  const child = spawn(process.execPath, ["--max-old-space-size=128", path.resolve("src/index.mjs")], {
    env: {
      ...process.env,
      ...setup.env,
      NAPCAT_HTTP_URL: `http://127.0.0.1:${httpServer.address().port}`,
      NAPCAT_TASK_REGISTRY_PATH: path.join(setup.root, "tasks.json"),
      NAPCAT_CONTROL_STATE_PATH: path.join(setup.root, "control.json"),
      NAPCAT_TASK_ROUTER_AUTOSTART: "0",
    },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    if (pending.has(response.id)) { pending.get(response.id)(response); pending.delete(response.id); }
  });
  let requestId = 0;
  async function request(method, params = {}) {
    requestId += 1;
    const id = requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout ${stderr}`)); }, 8000);
      pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  function startCancellableCall(argumentsInput) {
    requestId += 1;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: {
      name: "napcat_download_configured_file", arguments: argumentsInput,
    } }) + "\n");
    return requestId;
  }
  function cancelCall(id) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: {
      requestId: id, reason: "Core test cancellation",
    } }) + "\n");
  }
  context.after(async () => {
    lines.close();
    const exited = once(child, "exit");
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 1500);
    await exited;
    clearTimeout(timer);
  });
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "configured-file-test", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const listed = await request("tools/list");
  const definitions = listed.result.tools;
  assert.equal(definitions.some((item) => item.name === "napcat_read_recent"), true);
  const readDefinition = definitions.find((item) => item.name === "napcat_read_configured_recent");
  assert.deepEqual(readDefinition.inputSchema.required, ["target_key"]);
  assert.equal(readDefinition.inputSchema.properties.count.maximum, 50);
  const downloadDefinition = definitions.find((item) => item.name === "napcat_download_configured_file");
  assert.equal(downloadDefinition.inputSchema.additionalProperties, false);
  const read = await request("tools/call", { name: readDefinition.name, arguments: { target_key: "room" } });
  const recent = JSON.parse(read.result.content[0].text);
  assert.equal(recent.ok, true);
  const download = await request("tools/call", { name: downloadDefinition.name, arguments: {
    target_key: "room", message_id: "501", attachment_ref: recent.messages[0].attachments[0].attachment_ref,
    destination_dir: path.join(setup.root, "mcp-download"),
  } });
  const result = JSON.parse(download.result.content[0].text);
  assert.equal(result.downloaded, true);
  assert.equal(result.sourceMessageId, "501");
  assert.equal(result.attachment_ref, recent.messages[0].attachments[0].attachment_ref);
  assert.equal(result.resolvedBusId, 102);
  assert.deepEqual(fs.readFileSync(result.filePath), payload);
  const malformed = await request("tools/call", { name: downloadDefinition.name, arguments: {
    target_key: "room", message_id: "501", attachment_ref: "ncf1:" + "0".repeat(64),
    destination_dir: path.join(setup.root, "mcp-rejected"),
  } });
  const rejected = JSON.parse(malformed.result.content[0].text);
  assert.equal(malformed.result.isError, true);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.outcomeUnknown, false);
  assert.equal(rejected.code, "ATTACHMENT_REF_MISMATCH");
  assert.equal(fs.existsSync(path.join(setup.root, "mcp-rejected")), false);
  setup.original.message_type = "private";
  delete setup.original.group_id;
  const privateRead = await request("tools/call", { name: readDefinition.name, arguments: { target_key: "owner" } });
  const privateRecent = JSON.parse(privateRead.result.content[0].text);
  assert.equal(privateRecent.messages[0].attachments[1].downloadable, false);
  const privateInput = {
    target_key: "owner", message_id: "501", attachment_ref: privateRecent.messages[0].attachments[0].attachment_ref,
    destination_dir: path.join(setup.root, "mcp-private-download"),
  };
  const privateDownload = await request("tools/call", { name: downloadDefinition.name, arguments: privateInput });
  const privateResult = JSON.parse(privateDownload.result.content[0].text);
  assert.equal(privateResult.downloaded, true);
  assert.equal(privateResult.sourceMessageId, "501");
  assert.equal(privateResult.attachment_ref, privateInput.attachment_ref);
  assert.equal(privateResult.resolvedBusId, null);
  explicitFileFailure = true;
  const explicitFailure = await request("tools/call", { name: downloadDefinition.name, arguments: { ...privateInput, name: "rejected.txt" } });
  const failurePayload = JSON.parse(explicitFailure.result.content[0].text);
  assert.equal(explicitFailure.result.isError, true);
  assert.equal(failurePayload.ok, false);
  assert.equal(failurePayload.outcomeUnknown, false);
  assert.equal(failurePayload.code, "ONEBOT_ACTION_FAILED");
  assert.equal(JSON.stringify(explicitFailure).includes("private-internal-lookup-detail"), false);
  assert.equal(fs.existsSync(path.join(privateInput.destination_dir, "rejected.txt")), false);
  console.log("MCP contract fields: group resolvedBusId=102; private resolvedBusId=null; sourceMessageId/attachment_ref preserved; explicit failures ok=false/outcomeUnknown=false; unsupported downloadable=false");
  explicitFileFailure = false;
  holdPreparation = true;
  const cancelledPreparationDirectory = path.join(setup.root, "mcp-cancelled-preparation");
  const lookupsBeforeCancellation = setup.calls.filter((item) => item.action.endsWith("file_url")).length;
  const preparationRequestId = startCancellableCall({ ...privateInput, destination_dir: cancelledPreparationDirectory });
  await waitForGate(preparationEntered);
  cancelCall(preparationRequestId);
  await request("tools/list");
  preparationRelease.resolve();
  await waitForGate(preparationResponded);
  holdPreparation = false;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(setup.calls.filter((item) => item.action.endsWith("file_url")).length, lookupsBeforeCancellation);
  assert.equal(fs.existsSync(cancelledPreparationDirectory), false);
  holdFileBody = true;
  const cancelledDownloadDirectory = path.join(setup.root, "mcp-cancelled-download");
  const bodyRequestId = startCancellableCall({ ...privateInput, destination_dir: cancelledDownloadDirectory });
  await waitForGate(fileEntered);
  await waitFor(() => fs.existsSync(cancelledDownloadDirectory)
    && fs.readdirSync(cancelledDownloadDirectory).some((name) => fs.statSync(path.join(cancelledDownloadDirectory, name)).size > 0));
  cancelCall(bodyRequestId);
  await waitForGate(fileClosed);
  await waitFor(() => fs.readdirSync(cancelledDownloadDirectory).length === 0);
  await request("tools/list");
  assert.deepEqual(fs.readdirSync(cancelledDownloadDirectory), []);
  console.log("real MCP notifications/cancelled: delayed get_msg never reaches file URL/write; active body connection closed; parts=0; server remains responsive");
  setup.binding.controlPlane.targets.room.id = "force-internal";
  fs.writeFileSync(setup.bindingPath, JSON.stringify(setup.binding), "utf8");
  const failed = await request("tools/call", { name: readDefinition.name, arguments: { target_key: "room" } });
  assert.equal(failed.result.isError, true);
  assert.equal(JSON.parse(failed.result.content[0].text).retryRecommended, false);
  assert.equal(JSON.stringify(failed).includes("internal-token"), false);
  assert.equal(stderr.includes("internal-token"), false);
  assert.equal(stderr.includes("ONEBOT_INVALID_JSON"), false);
  console.log("isolated MCP initialize/tools-list/read/download/sanitized-failure passed; production calls=0");
});
