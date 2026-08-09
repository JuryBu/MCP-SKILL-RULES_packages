import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNapCatNotifier } from "../src/core.mjs";

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function createFixture(options = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-mcp-test-"));
  const bindingPath = path.join(temporaryRoot, "binding.json");
  const statePath = path.join(temporaryRoot, "state", "dedupe.json");
  const token = "test-token";
  const calls = [];
  const messages = new Map();
  const groupFiles = [];
  const primedFileIds = new Set();
  const downloadContent = Buffer.from("NapCat fixed-group download test\n", "utf8");
  let downloadBaseUrl = "";
  let messageSequence = 1000;
  let taskFileIndexFailureCount = 0;
  const runtime = {
    selfId: options.selfId ?? "1000000001",
    nickname: options.nickname ?? "ExampleBot",
    groupId: options.groupId ?? "123456789",
    groupName: options.groupName ?? "ExampleGroup",
    memberCount: options.memberCount ?? 4,
  };
  messages.set("900", {
    message_id: "900",
    message_seq: "900",
    group_id: runtime.groupId,
    time: 1784869200,
    user_id: "1000000004",
    sender: { user_id: "1000000004", nickname: "群成员", card: "成员备注" },
    message: [{ type: "text", data: { text: "历史消息" } }],
    raw_message: "历史消息",
  });
  if (options.includeHistoryFile) {
    messages.set("901", {
      message_id: "901",
      message_seq: "901",
      group_id: runtime.groupId,
      time: 1784869260,
      user_id: "1000000003",
      sender: { user_id: "1000000003", nickname: "ExampleUser", card: "开发机" },
      message: "[CQ:file,file=训练回包&#44;v1.zip,file_id=/history-file-1,file_size=33,busid=102]",
      raw_message: "[CQ:file,file=训练回包&#44;v1.zip,file_id=/history-file-1,file_size=33,busid=102]",
    });
  }
  if (options.includeLegacyTaskFileIndex) {
    messages.set("904", {
      message_id: "904",
      message_seq: "904",
      group_id: runtime.groupId,
      time: 1784869440,
      user_id: "1000000003",
      sender: { user_id: "1000000003", nickname: "ExampleUser", card: "训练机" },
      message: "[CQ:file,file=旧索引回包.zip,file_id=/legacy-real-file-uuid,file_size=33,busid=103]",
      raw_message: "[CQ:file,file=旧索引回包.zip,file_id=/legacy-real-file-uuid,file_size=33,busid=103]",
    });
    messages.set("905", {
      message_id: "905",
      message_seq: "905",
      group_id: runtime.groupId,
      time: 1784869440,
      user_id: "1000000003",
      sender: { user_id: "1000000003", nickname: "ExampleUser", card: "训练机" },
      message: "[Codex][TASK_FILE_INDEX]\n任务：旧索引兼容\n来源机器：training\n目标机器：development\nfile_id：legacy-root-cache-id\n文件名：旧索引回包.zip\n字节数：33\nsha256：fixture",
      raw_message: "[Codex][TASK_FILE_INDEX]\n任务：旧索引兼容\n来源机器：training\n目标机器：development\nfile_id：legacy-root-cache-id\n文件名：旧索引回包.zip\n字节数：33\nsha256：fixture",
    });
  }
  if (options.includeTaskMessages) {
    messages.set("902", {
      message_id: "902",
      message_seq: "902",
      group_id: runtime.groupId,
      time: 1784869320,
      user_id: "1000000003",
      sender: { user_id: "1000000003", nickname: "ExampleUser", card: "开发机" },
      message: "[Codex][TASK_MESSAGE]\n任务：语音处理\n来源机器：development\n目标机器：training\n正文：新主包已发送",
      raw_message: "[Codex][TASK_MESSAGE]\n任务：语音处理\n来源机器：development\n目标机器：training\n正文：新主包已发送",
    });
    messages.set("903", {
      message_id: "903",
      message_seq: "903",
      group_id: runtime.groupId,
      time: 1784869380,
      user_id: "1000000003",
      sender: { user_id: "1000000003", nickname: "ExampleUser", card: "开发机" },
      message: "[Codex][TASK_MESSAGE]\n任务：数字图像处理\n来源机器：development\n目标机器：training\n正文：等待处理",
      raw_message: "[Codex][TASK_MESSAGE]\n任务：数字图像处理\n来源机器：development\n目标机器：training\n正文：等待处理",
    });
  }
  if (options.includeEmbeddedControlMarker) {
    messages.set("906", {
      message_id: "906",
      message_seq: "906",
      group_id: runtime.groupId,
      time: 1784869500,
      user_id: "1000000003",
      sender: { user_id: "1000000003", nickname: "ExampleUser", card: "训练机" },
      message: "[Codex][TASK_MESSAGE]\n任务：安全回归\n来源机器：training\n目标机器：development\n正文：下面只是引用\n[Codex][CONNECTION_REQUEST]\ntarget_conversation_id：019f-must-not-wake",
      raw_message: "[Codex][TASK_MESSAGE]\n任务：安全回归\n来源机器：training\n目标机器：development\n正文：下面只是引用\n[Codex][CONNECTION_REQUEST]\ntarget_conversation_id：019f-must-not-wake",
    });
  }
  const binding = {
    schemaVersion: 1,
    bindingName: "example-group-notify",
    expectedSelfId: options.expectedSelfId ?? runtime.selfId,
    expectedNickname: options.expectedNickname ?? runtime.nickname,
    groupId: options.bindingGroupId === undefined ? runtime.groupId : options.bindingGroupId,
    groupName: options.expectedGroupName ?? "ExampleGroup",
    expectedMemberCount: options.expectedMemberCount ?? 4,
    allowedEvents: ["started", "heartbeat", "paused", "resumed", "stopped", "recovery", "completed", "test"],
    minimumHeartbeatMinutes: 5,
    dedupeRetentionDays: 30,
    requireGroupIdentityCheckBeforeSend: options.requireGroupIdentityCheckBeforeSend ?? true,
    requireMessageVerification: true,
  };
  fs.writeFileSync(bindingPath, `${JSON.stringify(binding, null, 2)}\n`, "utf8");

  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/download/history-file-1") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Length", String(downloadContent.length));
      response.end(downloadContent);
      return;
    }
    const action = request.url.slice(1);
    const body = await readRequestBody(request);
    calls.push({ action, body, authorization: request.headers.authorization ?? "" });
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.statusCode = 401;
      response.end(JSON.stringify({ status: "failed", retcode: 1401, data: null }));
      return;
    }
    let data;
    if (action === "get_status") {
      data = { online: true, good: true };
    } else if (action === "get_login_info") {
      data = { user_id: Number(runtime.selfId), nickname: runtime.nickname };
    } else if (action === "get_group_list") {
      data = [
        { group_id: Number(runtime.groupId), group_name: runtime.groupName, member_count: runtime.memberCount },
        { group_id: 987654321, group_name: "Other", member_count: 9 },
      ];
    } else if (action === "get_group_info") {
      data = {
        group_id: Number(runtime.groupId),
        group_name: runtime.groupName,
        member_count: runtime.memberCount,
      };
    } else if (action === "send_group_msg") {
      const isTaskFileIndex = String(body.message ?? "").includes("[Codex][TASK_FILE_INDEX]");
      if (options.failTaskFileIndexOnce && isTaskFileIndex && taskFileIndexFailureCount === 0) {
        taskFileIndexFailureCount += 1;
        response.statusCode = 400;
        response.end(JSON.stringify({ status: "failed", retcode: 1400, data: null }));
        return;
      }
      messageSequence += 1;
      const messageId = String(messageSequence);
      messages.set(messageId, {
        message_id: messageId,
        message_seq: messageId,
        message: body.message,
        raw_message: body.message,
        group_id: body.group_id,
        time: 1784869200,
        user_id: runtime.selfId,
        sender: { user_id: runtime.selfId, nickname: runtime.nickname },
      });
      if (options.httpErrorAfterSend) {
        response.statusCode = 500;
        response.end(JSON.stringify({ status: "failed", retcode: 1500, data: null }));
        return;
      }
      data = { message_id: messageId };
    } else if (action === "get_group_msg_history") {
      const cursor = Number(body.message_seq || Number.POSITIVE_INFINITY);
      const count = Math.max(1, Math.min(50, Number(body.count || 20)));
      const history = [...messages.values()]
        .filter((message) => String(message.group_id) === String(body.group_id))
        .filter((message) => Number(message.message_seq) <= cursor)
        .sort((left, right) => Number(left.message_seq) - Number(right.message_seq));
      const returnedMessages = body.reverse_order === true
          ? history.slice(-count).reverse()
          : history.slice(-count);
      for (const message of returnedMessages) {
        if (Array.isArray(message.message)) {
          for (const segment of message.message) {
            if (segment?.type === "file" && segment?.data?.file_id) {
              primedFileIds.add(String(segment.data.file_id));
            }
          }
        }
        const rawMessage = String(message.raw_message ?? "");
        for (const match of rawMessage.matchAll(/\[CQ:file,([^\]]+)\]/g)) {
          for (const part of match[1].split(",")) {
            const [name, ...valueParts] = part.split("=");
            if (name === "file_id") primedFileIds.add(valueParts.join("="));
          }
        }
      }
      data = { messages: returnedMessages };
    } else if (action === "get_msg") {
      const stored = messages.get(String(body.message_id)) ?? null;
      if (options.getMsgMode === "null") {
        data = null;
      } else if (options.getMsgMode === "wrong_target") {
        data = stored ? { ...stored, group_id: "999999", message: "tampered body" } : null;
      } else if (options.escapeMessageText && stored) {
        const escaped = String(stored.raw_message)
          .replace(/&/g, "&amp;")
          .replace(/\[/g, "&#91;")
          .replace(/\]/g, "&#93;");
        data = { ...stored, raw_message: escaped, message: escaped };
      } else {
        data = stored;
      }
    } else if (action === "upload_group_file") {
      const ordinal = groupFiles.length + 1;
      const fileId = `raw-file-uuid-${ordinal}`;
      const rootFileId = `root-cache-file-${ordinal}`;
      const fileSize = fs.statSync(body.file).size;
      messageSequence += 1;
      const messageId = String(messageSequence);
      messages.set(messageId, {
        message_id: messageId,
        message_seq: messageId,
        group_id: Number(runtime.groupId),
        time: 1784869200,
        user_id: runtime.selfId,
        sender: { user_id: runtime.selfId, nickname: runtime.nickname },
        message: [{
          type: "file",
          data: {
            file: body.name,
            file_id: fileId,
            file_size: fileSize,
            busid: 102,
          },
        }],
        raw_message: `[CQ:file,file=${body.name},file_id=${fileId},file_size=${fileSize},busid=102]`,
      });
      groupFiles.unshift({
        group_id: Number(runtime.groupId),
        file_id: rootFileId,
        file_name: body.name,
        file_size: fileSize,
        size: fileSize,
        busid: 102,
        uploader: Number(runtime.selfId),
        uploader_name: runtime.nickname,
      });
      data = { file_id: fileId };
    } else if (action === "get_group_root_files") {
      data = { files: groupFiles, folders: [] };
    } else if (action === "get_group_file_url") {
      if (!primedFileIds.has(String(body.file_id))) {
        response.statusCode = 400;
        response.end(JSON.stringify({
          status: "failed",
          retcode: 1400,
          data: null,
          message: "real fileUUID not found!",
        }));
        return;
      }
      data = { url: `${downloadBaseUrl}/download/history-file-1` };
    } else {
      response.end(JSON.stringify({ status: "failed", retcode: 1404, data: null }));
      return;
    }
    response.end(JSON.stringify({ status: "ok", retcode: 0, data }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  downloadBaseUrl = `http://127.0.0.1:${address.port}`;
  const env = {
    USERPROFILE: temporaryRoot,
    NAPCAT_HTTP_URL: `http://127.0.0.1:${address.port}`,
    NAPCAT_ACCESS_TOKEN: token,
    NAPCAT_MCP_BINDING_PATH: bindingPath,
    NAPCAT_MCP_STATE_PATH: statePath,
    NAPCAT_HTTP_TIMEOUT_MS: "2000",
  };
  const fetchImpl = options.failSendUnknown
    ? async (url, requestOptions) => {
      if (String(url).endsWith("/send_group_msg")) {
        throw new TypeError("simulated connection reset after request dispatch");
      }
      return fetch(url, requestOptions);
    }
    : fetch;
  const createNotifier = () => createNapCatNotifier({
      cwd: temporaryRoot,
      env,
      fetchImpl,
      now: () => new Date("2026-07-24T05:30:00.000Z"),
    });
  const notifier = createNotifier();

  return {
    notifier,
    calls,
    statePath,
    temporaryRoot,
    createNotifier,
    clearFileUrlCache: () => primedFileIds.clear(),
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };
}

function trainingEvent(overrides = {}) {
  return {
    task_id: "tgt-20260724-01",
    run_id: "run-001",
    event: "started",
    dedupe_key: "tgt-20260724-01:started:run-001",
    progress: "epoch 0/10",
    checkpoint_at: "尚未保存",
    summary: "训练进程已启动",
    ...overrides,
  };
}

test("status verifies OneBot identity and fixed group", async () => {
  const fixture = await createFixture();
  try {
    const result = await fixture.notifier.status({ include_group: true });
    assert.equal(result.ready, true);
    assert.equal(result.identity.actualSelfId, "1000000001");
    assert.equal(result.group.actualGroupName, "ExampleGroup");
    assert.equal(result.group.actualMemberCount, 4);
    assert.ok(fixture.calls.every((call) => call.authorization === "Bearer test-token"));
  } finally {
    await fixture.close();
  }
});

test("discoverTarget returns only exact ExampleGroup candidate", async () => {
  const fixture = await createFixture({ bindingGroupId: "" });
  try {
    const result = await fixture.notifier.discoverTarget();
    assert.equal(result.candidates.length, 1);
    assert.equal(result.uniqueMatch.groupId, "123456789");
    assert.equal(result.uniqueMatch.memberCount, 4);
  } finally {
    await fixture.close();
  }
});

test("preview does not call OneBot", async () => {
  const fixture = await createFixture();
  try {
    const result = fixture.notifier.previewTrainingEvent(trainingEvent());
    assert.match(result.message, /\[训练机\]\[STARTED\]/);
    assert.match(result.message, /任务：tgt-20260724-01/);
    assert.equal(fixture.calls.length, 0);
  } finally {
    await fixture.close();
  }
});

test("read recent messages validates identity and uses only the bound group", async () => {
  const fixture = await createFixture();
  try {
    const result = await fixture.notifier.readRecentMessages({ count: 10 });
    assert.equal(result.returnedCount, 1);
    assert.equal(result.messages[0].text, "历史消息");
    assert.equal(result.messages[0].senderName, "成员备注");
    assert.equal(result.messages[0].isSelf, false);
    const historyCall = fixture.calls.find((call) => call.action === "get_group_msg_history");
    assert.equal(String(historyCall.body.group_id), "123456789");
    assert.equal(historyCall.body.count, 10);
  } finally {
    await fixture.close();
  }
});

test("wrong account blocks reading before history access", async () => {
  const fixture = await createFixture({ expectedSelfId: "999999999" });
  try {
    await assert.rejects(
      () => fixture.notifier.readRecentMessages({ count: 10 }),
      (error) => error.code === "SELF_ID_MISMATCH",
    );
    assert.equal(fixture.calls.some((call) => call.action === "get_group_msg_history"), false);
  } finally {
    await fixture.close();
  }
});

test("read recent messages extracts CQ file metadata", async () => {
  const fixture = await createFixture({ includeHistoryFile: true });
  try {
    const result = await fixture.notifier.readRecentMessages({ count: 10 });
    const fileMessage = result.messages.find((message) => message.messageId === "901");
    assert.ok(fileMessage);
    assert.deepEqual(fileMessage.attachments, [{
      type: "file",
      fileId: "/history-file-1",
      fileName: "训练回包,v1.zip",
      fileBytes: 33,
      busId: 102,
      downloadable: true,
    }]);
  } finally {
    await fixture.close();
  }
});

test("read recent messages filters exact structured task id", async () => {
  const fixture = await createFixture({ includeTaskMessages: true });
  try {
    const result = await fixture.notifier.readRecentMessages({ count: 10, task_id: "语音处理" });
    assert.equal(result.requestedTaskId, "语音处理");
    assert.equal(result.scannedCount, 3);
    assert.equal(result.returnedCount, 1);
    assert.equal(result.messages[0].messageId, "902");
    assert.equal(result.messages[0].taskId, "语音处理");
    assert.equal(result.messages[0].sourceMachine, "development");
    assert.equal(result.messages[0].targetMachine, "training");
  } finally {
    await fixture.close();
  }
});

test("a connection marker quoted inside a business message does not become a control request", async () => {
  const fixture = await createFixture({ includeEmbeddedControlMarker: true });
  try {
    const result = await fixture.notifier.readRecentMessages({ count: 10, task_id: "安全回归" });
    assert.equal(result.returnedCount, 1);
    assert.equal(result.messages[0].messageType, "business");
  } finally {
    await fixture.close();
  }
});

test("download file refreshes group history after a NapCat fileUuid cache miss", async () => {
  const fixture = await createFixture({ includeHistoryFile: true });
  try {
    const destinationDirectory = path.join(fixture.temporaryRoot, "downloads");
    const result = await fixture.notifier.downloadFile({
      file_id: "/history-file-1",
      message_seq: "901",
      busid: 102,
      destination_dir: destinationDirectory,
      name: "received.zip",
    });
    assert.equal(result.downloaded, true);
    assert.equal(result.fileName, "received.zip");
    assert.equal(result.fileBytes, Buffer.byteLength("NapCat fixed-group download test\n"));
    assert.equal(fs.readFileSync(result.filePath, "utf8"), "NapCat fixed-group download test\n");
    assert.equal(result.sha256, createHash("sha256").update("NapCat fixed-group download test\n").digest("hex"));
    assert.equal(result.cacheRefresh.matched, true);
    const urlCalls = fixture.calls.filter((call) => call.action === "get_group_file_url");
    assert.equal(urlCalls.length, 2);
    const urlCall = urlCalls.at(-1);
    assert.equal(String(urlCall.body.group_id), "123456789");
    assert.equal(urlCall.body.file_id, "/history-file-1");
    assert.equal(urlCall.body.busid, 102);
    await assert.rejects(
      () => fixture.notifier.downloadFile({
        file_id: "/history-file-1",
        destination_dir: destinationDirectory,
        name: "received.zip",
      }),
      (error) => error.code === "DOWNLOAD_TARGET_EXISTS",
    );
  } finally {
    await fixture.close();
  }
});

test("download file resolves a legacy task index internal id to the adjacent real fileUuid", async () => {
  const fixture = await createFixture({ includeLegacyTaskFileIndex: true });
  try {
    const destinationDirectory = path.join(fixture.temporaryRoot, "legacy-downloads");
    const result = await fixture.notifier.downloadFile({
      file_id: "legacy-root-cache-id",
      message_seq: "905",
      destination_dir: destinationDirectory,
      name: "旧索引回包.zip",
    });
    assert.equal(result.downloaded, true);
    assert.equal(result.fileId, "legacy-root-cache-id");
    assert.equal(result.resolvedFileId, "/legacy-real-file-uuid");
    assert.equal(result.resolvedBusId, 103);
    assert.equal(result.cacheRefresh.matched, true);
    assert.equal(result.cacheRefresh.resolution, "legacy_task_index");
    assert.equal(result.cacheRefresh.messageSeq, "904");
    const urlCalls = fixture.calls.filter((call) => call.action === "get_group_file_url");
    assert.equal(urlCalls.length, 2);
    assert.equal(urlCalls[0].body.file_id, "legacy-root-cache-id");
    assert.equal(urlCalls[1].body.file_id, "/legacy-real-file-uuid");
    assert.equal(urlCalls[1].body.busid, 103);
    const historyCall = fixture.calls.find((call) => call.action === "get_group_msg_history");
    assert.equal(historyCall.body.message_seq, "905");
    assert.equal(historyCall.body.reverse_order, true);
  } finally {
    await fixture.close();
  }
});

test("wrong account blocks download before file URL lookup", async () => {
  const fixture = await createFixture({ expectedSelfId: "999999999" });
  try {
    await assert.rejects(
      () => fixture.notifier.downloadFile({
        file_id: "/history-file-1",
        destination_dir: path.join(fixture.temporaryRoot, "downloads"),
      }),
      (error) => error.code === "SELF_ID_MISMATCH",
    );
    assert.equal(fixture.calls.some((call) => call.action === "get_group_file_url"), false);
  } finally {
    await fixture.close();
  }
});

test("wrong fixed-group identity blocks download before file URL lookup", async () => {
  const fixture = await createFixture({ expectedMemberCount: 5 });
  try {
    await assert.rejects(
      () => fixture.notifier.downloadFile({
        file_id: "/history-file-1",
        destination_dir: path.join(fixture.temporaryRoot, "downloads"),
      }),
      (error) => error.code === "GROUP_MEMBER_COUNT_MISMATCH",
    );
    assert.equal(fixture.calls.some((call) => call.action === "get_group_file_url"), false);
  } finally {
    await fixture.close();
  }
});

test("text preview is offline and fixed to the bound group", async () => {
  const fixture = await createFixture();
  try {
    const result = fixture.notifier.previewTextMessage({
      text: "联调测试",
      dedupe_key: "manual:test:preview",
    });
    assert.equal(result.target.groupId, "123456789");
    assert.match(result.message, /\[Codex\]\[MESSAGE\]/);
    assert.match(result.message, /联调测试/);
    assert.equal(fixture.calls.length, 0);
  } finally {
    await fixture.close();
  }
});

test("task text preview writes exact task and machine routing markers", async () => {
  const fixture = await createFixture();
  try {
    const result = fixture.notifier.previewTextMessage({
      text: "回包已经完成",
      task_id: "语音处理",
      source_machine: "training",
      target_machine: "development",
      dedupe_key: "speech:return-ready",
    });
    assert.match(result.message, /\[Codex\]\[TASK_MESSAGE\]/);
    assert.match(result.message, /任务：语音处理/);
    assert.match(result.message, /来源机器：training/);
    assert.match(result.message, /目标机器：development/);
    assert.match(result.message, /正文：回包已经完成/);
    assert.doesNotMatch(result.message, /source_conversation_id|target_conversation_id/);
  } finally {
    await fixture.close();
  }
});

test("text send validates, verifies and deduplicates in the bound group", async () => {
  const fixture = await createFixture();
  try {
    const input = { text: "固定群文本测试", dedupe_key: "manual:test:send" };
    const first = await fixture.notifier.sendTextMessage(input);
    assert.equal(first.sent, true);
    assert.equal(first.verified, true);
    const sendCall = fixture.calls.find((call) => call.action === "send_group_msg");
    assert.equal(String(sendCall.body.group_id), "123456789");
    assert.match(sendCall.body.message, /固定群文本测试/);

    const second = await fixture.notifier.sendTextMessage(input);
    assert.equal(second.sent, false);
    assert.equal(second.duplicateSuppressed, true);
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 1);
  } finally {
    await fixture.close();
  }
});

test("text verification accepts OneBot HTML entity escaping", async () => {
  const fixture = await createFixture({ escapeMessageText: true });
  try {
    const result = await fixture.notifier.sendTextMessage({
      text: "方括号 [测试] & 符号",
      dedupe_key: "manual:test:escaped-text",
    });
    assert.equal(result.sent, true);
    assert.equal(result.verified, true);
  } finally {
    await fixture.close();
  }
});

test("file preview hashes locally and fixed-group upload verifies by file list", async () => {
  const fixture = await createFixture();
  try {
    const filePath = path.join(fixture.temporaryRoot, "return-package.zip");
    fs.writeFileSync(filePath, "test-return-package", "utf8");
    const input = {
      file_path: filePath,
      name: "回包测试.zip",
      dedupe_key: "manual:file:send",
    };
    const preview = await fixture.notifier.previewFile(input);
    assert.equal(preview.fileBytes, 19);
    assert.equal(preview.sha256.length, 64);
    assert.equal(fixture.calls.length, 0);

    const first = await fixture.notifier.sendFile(input);
    assert.equal(first.sent, true);
    assert.equal(first.verified, true);
    assert.equal(first.fileName, "回包测试.zip");
    const uploadCall = fixture.calls.find((call) => call.action === "upload_group_file");
    assert.equal(String(uploadCall.body.group_id), "123456789");
    assert.equal(uploadCall.body.file, fs.realpathSync(filePath));
    assert.equal(uploadCall.body.upload_file, true);

    const second = await fixture.notifier.sendFile(input);
    assert.equal(second.sent, false);
    assert.equal(second.duplicateSuppressed, true);
    assert.equal(fixture.calls.filter((call) => call.action === "upload_group_file").length, 1);
  } finally {
    await fixture.close();
  }
});

test("task file upload publishes a verified index readable by task id", async () => {
  const fixture = await createFixture();
  try {
    const filePath = path.join(fixture.temporaryRoot, "task-return.zip");
    const content = "task-file-index-content";
    fs.writeFileSync(filePath, content, "utf8");
    const input = {
      file_path: filePath,
      name: "任务回包.zip",
      task_id: "tgt-20260724-task-file",
      source_machine: "development",
      target_machine: "training",
      dedupe_key: "tgt-20260724-task-file:return-package",
    };

    const result = await fixture.notifier.sendFile(input);
    assert.equal(result.sent, true);
    assert.equal(result.verified, true);
    assert.equal(result.taskIndex.status, "sent_verified");
    assert.equal(result.taskIndex.sent, true);
    assert.equal(result.taskIndex.verified, true);
    assert.notEqual(result.taskIndex.dedupeKey, input.dedupe_key);
    assert.equal(fixture.calls.filter((call) => call.action === "upload_group_file").length, 1);
    const indexCall = fixture.calls.find((call) => call.action === "send_group_msg");
    assert.match(indexCall.body.message, /\[Codex\]\[TASK_FILE_INDEX\]/);
    assert.match(indexCall.body.message, /任务：tgt-20260724-task-file/);
    assert.match(indexCall.body.message, /来源机器：development/);
    assert.match(indexCall.body.message, /目标机器：training/);
    assert.match(indexCall.body.message, /file_id：raw-file-uuid-1/);
    assert.match(indexCall.body.message, /file_message_seq：1001/);
    assert.match(indexCall.body.message, /busid：102/);
    assert.match(indexCall.body.message, /文件名：任务回包\.zip/);
    assert.match(indexCall.body.message, new RegExp(`字节数：${Buffer.byteLength(content)}`));
    assert.match(indexCall.body.message, new RegExp(`sha256：${createHash("sha256").update(content).digest("hex")}`));

    const recent = await fixture.notifier.readRecentMessages({ count: 10, task_id: input.task_id });
    assert.equal(recent.returnedCount, 1);
    assert.equal(recent.messages[0].taskId, input.task_id);
    assert.equal(recent.messages[0].sourceMachine, input.source_machine);
    assert.equal(recent.messages[0].targetMachine, input.target_machine);
    assert.match(recent.messages[0].text, /file_id：raw-file-uuid-1/);

    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    assert.equal(state.entries[input.dedupe_key].status, "sent_verified");
    assert.equal(state.entries[input.dedupe_key].fileId, "raw-file-uuid-1");
    assert.equal(state.entries[input.dedupe_key].verifiedFileId, "root-cache-file-1");
    assert.equal(state.entries[input.dedupe_key].fileMessageSeq, "1001");
    assert.equal(state.entries[result.taskIndex.dedupeKey].status, "sent_verified");
  } finally {
    await fixture.close();
  }
});

test("task file index stays downloadable after the receiving NapCat cache is cleared", async () => {
  const fixture = await createFixture();
  try {
    const filePath = path.join(fixture.temporaryRoot, "cross-machine-return.zip");
    fs.writeFileSync(filePath, "cross-machine-download", "utf8");
    const sent = await fixture.notifier.sendFile({
      file_path: filePath,
      name: "跨机回包.zip",
      task_id: "tgt-20260724-cross-machine",
      source_machine: "training",
      target_machine: "development",
      dedupe_key: "tgt-20260724-cross-machine:return-package",
    });
    assert.equal(sent.fileId, "raw-file-uuid-1");
    assert.equal(sent.verifiedFileId, "root-cache-file-1");
    assert.equal(sent.fileMessageSeq, "1001");

    fixture.clearFileUrlCache();
    const destinationDirectory = path.join(fixture.temporaryRoot, "received");
    const downloaded = await fixture.notifier.downloadFile({
      file_id: sent.fileId,
      message_seq: sent.fileMessageSeq,
      busid: sent.fileBusId,
      destination_dir: destinationDirectory,
      name: "received-cross-machine.zip",
    });
    assert.equal(downloaded.downloaded, true);
    assert.equal(downloaded.cacheRefresh.matched, true);
    assert.equal(fs.readFileSync(downloaded.filePath, "utf8"), "NapCat fixed-group download test\n");
    const finalUrlCall = fixture.calls.filter((call) => call.action === "get_group_file_url").at(-1);
    assert.equal(finalUrlCall.body.file_id, "raw-file-uuid-1");
    assert.equal(finalUrlCall.body.file_id.includes("root-cache-file"), false);
  } finally {
    await fixture.close();
  }
});

test("task file retry only resends the failed index", async () => {
  const fixture = await createFixture({ failTaskFileIndexOnce: true });
  try {
    const filePath = path.join(fixture.temporaryRoot, "task-retry.zip");
    fs.writeFileSync(filePath, "task-file-index-retry", "utf8");
    const input = {
      file_path: filePath,
      name: "索引重试.zip",
      task_id: "tgt-20260724-index-retry",
      source_machine: "development",
      target_machine: "training",
      dedupe_key: "tgt-20260724-index-retry:return-package",
    };

    const first = await fixture.notifier.sendFile(input);
    assert.equal(first.sent, true);
    assert.equal(first.verified, true);
    assert.equal(first.taskIndex.status, "failed_before_ack");
    assert.equal(first.taskIndex.sent, false);
    assert.equal(first.taskIndex.error.code, "ONEBOT_HTTP_ERROR");
    assert.equal(first.taskIndex.error.outcomeUnknown, false);
    assert.equal(fixture.calls.filter((call) => call.action === "upload_group_file").length, 1);
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 1);

    const second = await fixture.notifier.sendFile(input);
    assert.equal(second.sent, false);
    assert.equal(second.reason, "file_already_uploaded");
    assert.equal(second.taskIndex.status, "sent_verified");
    assert.equal(second.taskIndex.sent, true);
    assert.equal(fixture.calls.filter((call) => call.action === "upload_group_file").length, 1);
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 2);

    const third = await fixture.notifier.sendFile(input);
    assert.equal(third.taskIndex.status, "sent_verified");
    assert.equal(third.taskIndex.sent, false);
    assert.equal(third.taskIndex.duplicateSuppressed, true);
    assert.equal(fixture.calls.filter((call) => call.action === "upload_group_file").length, 1);
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 2);
  } finally {
    await fixture.close();
  }
});

test("file without task id keeps ordinary upload and emits no index", async () => {
  const fixture = await createFixture();
  try {
    const filePath = path.join(fixture.temporaryRoot, "ordinary-upload.zip");
    fs.writeFileSync(filePath, "ordinary-file-upload", "utf8");
    const result = await fixture.notifier.sendFile({
      file_path: filePath,
      name: "普通文件.zip",
      dedupe_key: "ordinary-file-upload:no-task",
    });
    assert.equal(result.sent, true);
    assert.equal(result.verified, true);
    assert.equal(Object.hasOwn(result, "taskIndex"), false);
    assert.equal(fixture.calls.filter((call) => call.action === "upload_group_file").length, 1);
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 0);
  } finally {
    await fixture.close();
  }
});

test("task file requires explicit source and target machines", async () => {
  const fixture = await createFixture();
  try {
    const filePath = path.join(fixture.temporaryRoot, "missing-route.zip");
    fs.writeFileSync(filePath, "missing-route", "utf8");
    await assert.rejects(
      () => fixture.notifier.sendFile({
        file_path: filePath,
        task_id: "missing-route",
        dedupe_key: "missing-route:file",
      }),
      (error) => error.code === "INVALID_ARGUMENT" && /source_machine/.test(error.message),
    );
    assert.equal(fixture.calls.length, 0);
  } finally {
    await fixture.close();
  }
});

test("send validates, sends, verifies and deduplicates", async () => {
  const fixture = await createFixture();
  try {
    const input = trainingEvent();
    const first = await fixture.notifier.sendTrainingEvent(input);
    assert.equal(first.sent, true);
    assert.equal(first.verified, true);
    assert.ok(first.messageId);
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 1);

    const second = await fixture.notifier.sendTrainingEvent(input);
    assert.equal(second.sent, false);
    assert.equal(second.duplicateSuppressed, true);
    assert.equal(second.reason, "already_sent");
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 1);

    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    assert.equal(state.entries[input.dedupe_key].status, "sent_verified");
  } finally {
    await fixture.close();
  }
});

test("wrong account blocks sending", async () => {
  const fixture = await createFixture({ expectedSelfId: "999999999" });
  try {
    await assert.rejects(
      () => fixture.notifier.sendTrainingEvent(trainingEvent()),
      (error) => error.code === "SELF_ID_MISMATCH",
    );
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 0);
    assert.equal(fs.existsSync(fixture.statePath), false);
  } finally {
    await fixture.close();
  }
});

test("binding cannot disable fixed group identity checks", async () => {
  const fixture = await createFixture({ requireGroupIdentityCheckBeforeSend: false });
  try {
    await assert.rejects(
      () => fixture.notifier.sendTrainingEvent(trainingEvent()),
      (error) => error.code === "UNSAFE_BINDING",
    );
    assert.equal(fixture.calls.length, 0);
  } finally {
    await fixture.close();
  }
});

test("HTTP error after send remains unknown and suppresses retry", async () => {
  const fixture = await createFixture({ httpErrorAfterSend: true });
  try {
    const input = trainingEvent({ dedupe_key: "tgt-20260724-01:http-unknown" });
    await assert.rejects(
      () => fixture.notifier.sendTrainingEvent(input),
      (error) => error.code === "ONEBOT_HTTP_ERROR" && error.outcomeUnknown === true,
    );
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    assert.equal(state.entries[input.dedupe_key].status, "pending_send");

    const second = await fixture.notifier.sendTrainingEvent(input);
    assert.equal(second.sent, false);
    assert.equal(second.reason, "previous_outcome_unknown");
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 1);
  } finally {
    await fixture.close();
  }
});

test("wrong group member count blocks sending", async () => {
  const fixture = await createFixture({ memberCount: 5 });
  try {
    await assert.rejects(
      () => fixture.notifier.sendTrainingEvent(trainingEvent()),
      (error) => error.code === "GROUP_MEMBER_COUNT_MISMATCH",
    );
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 0);
    assert.equal(fs.existsSync(fixture.statePath), false);
  } finally {
    await fixture.close();
  }
});

test("unknown network outcome remains pending and suppresses automatic resend", async () => {
  const fixture = await createFixture({ failSendUnknown: true });
  try {
    const input = trainingEvent({ dedupe_key: "tgt-20260724-01:unknown:run-001" });
    await assert.rejects(
      () => fixture.notifier.sendTrainingEvent(input),
      (error) => error.code === "ONEBOT_NETWORK_ERROR" && error.outcomeUnknown === true,
    );
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    assert.equal(state.entries[input.dedupe_key].status, "pending_send");

    const second = await fixture.notifier.sendTrainingEvent(input);
    assert.equal(second.sent, false);
    assert.equal(second.duplicateSuppressed, true);
    assert.equal(second.reason, "previous_outcome_unknown");
  } finally {
    await fixture.close();
  }
});

test("heartbeat minimum interval suppresses rapid repeated heartbeat", async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.notifier.sendTrainingEvent(trainingEvent({
      event: "heartbeat",
      dedupe_key: "tgt-20260724-01:heartbeat:001",
    }));
    assert.equal(first.sent, true);

    const second = await fixture.notifier.sendTrainingEvent(trainingEvent({
      event: "heartbeat",
      dedupe_key: "tgt-20260724-01:heartbeat:002",
    }));
    assert.equal(second.sent, false);
    assert.equal(second.reason, "heartbeat_too_frequent");
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 1);
  } finally {
    await fixture.close();
  }
});

test("missing get_msg data never becomes verified", async () => {
  const fixture = await createFixture({ getMsgMode: "null" });
  try {
    const input = trainingEvent({ dedupe_key: "tgt-20260724-01:verify-null" });
    const result = await fixture.notifier.sendTrainingEvent(input);
    assert.equal(result.sent, true);
    assert.equal(result.verified, false);
    assert.equal(result.verificationError.code, "MESSAGE_VERIFY_ID_MISMATCH");
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    assert.equal(state.entries[input.dedupe_key].status, "sent_unverified");
  } finally {
    await fixture.close();
  }
});

test("wrong group or message body never becomes verified", async () => {
  const fixture = await createFixture({ getMsgMode: "wrong_target" });
  try {
    const input = trainingEvent({ dedupe_key: "tgt-20260724-01:verify-target" });
    const result = await fixture.notifier.sendTrainingEvent(input);
    assert.equal(result.sent, true);
    assert.equal(result.verified, false);
    assert.equal(result.verificationError.code, "MESSAGE_VERIFY_GROUP_MISMATCH");
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    assert.equal(state.entries[input.dedupe_key].status, "sent_unverified");
  } finally {
    await fixture.close();
  }
});

test("two notifier instances sharing state send one message", async () => {
  const fixture = await createFixture();
  try {
    const input = trainingEvent({ dedupe_key: "tgt-20260724-01:concurrent" });
    const secondNotifier = fixture.createNotifier();
    const results = await Promise.all([
      fixture.notifier.sendTrainingEvent(input),
      secondNotifier.sendTrainingEvent(input),
    ]);
    assert.equal(results.filter((result) => result.sent === true).length, 1);
    assert.equal(results.filter((result) => result.duplicateSuppressed === true).length, 1);
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 1);
  } finally {
    await fixture.close();
  }
});

test("stale cross-process lock requires manual review and never sends", async () => {
  const fixture = await createFixture();
  try {
    const input = trainingEvent({ dedupe_key: "tgt-20260724-01:stale-lock" });
    const digest = createHash("sha256").update(input.dedupe_key, "utf8").digest("hex");
    const lockPath = path.join(path.dirname(fixture.statePath), ".locks", `${digest}.lock`);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify({
      pid: 999999,
      dedupeKey: input.dedupe_key,
      createdAt: "2026-07-24T05:00:00.000Z",
    })}\n`, "utf8");

    await assert.rejects(
      () => fixture.notifier.sendTrainingEvent(input),
      (error) => error.code === "STALE_SEND_LOCK" && error.details.stale === true,
    );
    assert.equal(fixture.calls.some((call) => call.action === "send_group_msg"), false);
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    await fixture.close();
  }
});
