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
  const groupFiles = Array.isArray(options.groupFiles)
    ? options.groupFiles.map((file) => ({ ...file }))
    : [];
  const privateFiles = [];
  const primedFileIds = new Set();
  const downloadContent = Buffer.from("NapCat fixed-group download test\n", "utf8");
  let downloadBaseUrl = "";
  let messageSequence = 1000;
  let groupRealSequence = 1000;
  let taskFileIndexFailureCount = 0;
  const runtime = {
    selfId: options.selfId ?? "1000000001",
    nickname: options.nickname ?? "ExampleBot",
    groupId: options.groupId ?? "123456789",
    groupName: options.groupName ?? "ExampleGroup",
    memberCount: options.memberCount ?? 4,
  };
  const configuredGroups = new Map(Object.entries(options.configuredGroups ?? {}));
  const friends = options.friends ?? [];
  if (!options.emptyHistory) {
    messages.set("900", {
      message_id: "900",
      message_seq: "900",
      real_seq: "1000",
      post_type: "message",
      message_type: "group",
      self_id: Number(runtime.selfId),
      group_id: runtime.groupId,
      time: 1784869200,
      user_id: "1000000004",
      sender: { user_id: "1000000004", nickname: "群成员", card: "成员备注" },
      message: [{ type: "text", data: { text: "历史消息" } }],
      raw_message: "历史消息",
    });
  }
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
  if (options.includeStringControlSegments) {
    messages.set("907", {
      message_id: "907",
      message_seq: "907",
      group_id: runtime.groupId,
      time: 1784869560,
      user_id: "1000000004",
      sender: { user_id: "1000000004", nickname: "群成员", card: "主人" },
      message: "[CQ:reply,id=1228686193][CQ:at,qq=1000000001] 补充一个引用艾特的",
      raw_message: "[CQ:reply,id=1228686193][CQ:at,qq=1000000001] 补充一个引用艾特的",
    });
  }
  const binding = {
    schemaVersion: options.controlPlane ? 2 : 1,
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
    ...(options.controlPlane ? { controlPlane: options.controlPlane } : {}),
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
      data = {};
      if (!options.omitRuntimeOnline) data.online = options.runtimeOnline ?? true;
      if (!options.omitRuntimeGood) data.good = options.runtimeGood ?? true;
    } else if (action === "get_login_info") {
      data = { user_id: Number(runtime.selfId), nickname: runtime.nickname };
    } else if (action === "get_group_list") {
      data = [
        { group_id: Number(runtime.groupId), group_name: runtime.groupName, member_count: runtime.memberCount },
        { group_id: 987654321, group_name: "Other", member_count: 9 },
      ];
    } else if (action === "get_group_info") {
      const configuredGroup = configuredGroups.get(String(body.group_id));
      data = {
        group_id: Number(configuredGroup?.groupId ?? runtime.groupId),
        group_name: configuredGroup?.groupName ?? runtime.groupName,
        member_count: configuredGroup?.memberCount ?? runtime.memberCount,
      };
    } else if (action === "get_friend_list") {
      data = friends.map((friend) => ({
        user_id: Number(friend.userId),
        nickname: friend.nickname ?? "",
        remark: friend.remark ?? "",
      }));
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
      const uncertainSendRecord = Boolean(
        options.ghostEchoOnSend
        || options.ghostEchoAdvancesRealSeq
        || options.ghostEchoWithoutRealSeq
      );
      const realSeq = options.ghostEchoAdvancesRealSeq || !uncertainSendRecord
        ? (groupRealSequence += 1)
        : groupRealSequence;
      const sentMessage = {
        message_id: messageId,
        message_seq: messageId,
        ...(options.ghostEchoWithoutRealSeq ? {} : { real_seq: String(realSeq) }),
        ...(options.omitSelfPostType ? {} : { post_type: "message_sent" }),
        message_type: "group",
        ...(options.omitSelfMessageSentType ? {} : { message_sent_type: "self" }),
        self_id: Number(runtime.selfId),
        message: body.message,
        raw_message: body.message,
        group_id: body.group_id,
        time: 1784869200,
        user_id: runtime.selfId,
        sender: { user_id: runtime.selfId, nickname: runtime.nickname },
      };
      if (options.omitSelfSenderIdentity) {
        delete sentMessage.user_id;
        delete sentMessage.sender;
      }
      messages.set(messageId, sentMessage);
      if (options.duplicateAuthoritativeAfterSend && !uncertainSendRecord) {
        messageSequence += 1;
        groupRealSequence += 1;
        const duplicateMessageId = String(messageSequence);
        messages.set(duplicateMessageId, {
          message_id: duplicateMessageId,
          message_seq: duplicateMessageId,
          real_seq: String(groupRealSequence),
          post_type: "message_sent",
          message_type: "group",
          message_sent_type: "self",
          self_id: Number(runtime.selfId),
          message: body.message,
          raw_message: body.message,
          group_id: body.group_id,
          time: 1784869201,
          user_id: runtime.selfId,
          sender: { user_id: runtime.selfId, nickname: runtime.nickname },
        });
      }
      for (let index = 0; index < Number(options.appendHistoryAfterSendCount ?? 0); index += 1) {
        messageSequence += 1;
        groupRealSequence += 1;
        const noiseMessageId = String(messageSequence);
        messages.set(noiseMessageId, {
          message_id: noiseMessageId,
          message_seq: noiseMessageId,
          real_seq: String(groupRealSequence),
          post_type: "message",
          message_type: "group",
          self_id: Number(runtime.selfId),
          message: `后续群消息-${index}`,
          raw_message: `后续群消息-${index}`,
          group_id: body.group_id,
          time: 1784869202 + index,
          user_id: "1000000004",
          sender: { user_id: "1000000004", nickname: "群成员" },
        });
      }
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
      let returnedMessages = body.reverse_order === true
          ? history.slice(-count).reverse()
          : history.slice(-count);
      if (options.historySelfSenderId) {
        returnedMessages = returnedMessages.map((message) => (
          message.post_type === "message_sent" || message.message_sent_type === "self"
            ? {
                ...message,
                user_id: options.historySelfSenderId,
                sender: { user_id: options.historySelfSenderId, nickname: "冲突账号" },
              }
            : message
        ));
      }
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
    } else if (action === "get_friend_msg_history") {
      const count = Math.max(1, Math.min(50, Number(body.count || 20)));
      const history = [...messages.values()]
        .filter((message) => String(message.private_user_id ?? "") === String(body.user_id))
        .sort((left, right) => Number(left.message_seq) - Number(right.message_seq));
      data = {
        messages: body.reverse_order === true
          ? history.slice(-count).reverse()
          : history.slice(-count),
      };
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
      const uploadGroupId = Number(body.group_id);
      messageSequence += 1;
      const messageId = String(messageSequence);
      messages.set(messageId, {
        message_id: messageId,
        message_seq: messageId,
        group_id: uploadGroupId,
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
        group_id: uploadGroupId,
        file_id: rootFileId,
        file_name: body.name,
        file_size: fileSize,
        size: fileSize,
        busid: 102,
        uploader: Number(runtime.selfId),
        uploader_name: runtime.nickname,
        modify_time: 1784869200 + ordinal,
      });
      data = { file_id: fileId };
      if (options.failUploadGroupFileAfterPersist) {
        response.end(JSON.stringify({
          status: "failed",
          retcode: 200,
          data: null,
          wording: "Error: EventChecker Failed: rich media transfer failed",
        }));
        return;
      }
    } else if (action === "upload_private_file") {
      const ordinal = privateFiles.length + 1;
      const fileId = `private-file-uuid-${ordinal}`;
      const fileSize = fs.statSync(body.file).size;
      messageSequence += 1;
      const messageId = String(messageSequence);
      messages.set(messageId, {
        message_id: messageId,
        message_seq: messageId,
        private_user_id: String(body.user_id),
        time: 1784869200,
        user_id: runtime.selfId,
        sender: { user_id: runtime.selfId, nickname: runtime.nickname },
        message: [{
          type: "file",
          data: {
            file: body.name,
            file_id: fileId,
            file_size: fileSize,
          },
        }],
        raw_message: `[CQ:file,file=${body.name},file_id=${fileId},file_size=${fileSize}]`,
      });
      privateFiles.unshift({
        user_id: String(body.user_id),
        file_id: fileId,
        file_name: body.name,
        file_size: fileSize,
      });
      data = { file_id: fileId };
    } else if (action === "get_group_file_system_info") {
      const files = groupFiles.filter((file) => String(file.group_id) === String(body.group_id));
      data = {
        file_count: options.groupFileSystemCount ?? files.length,
        limit_count: options.groupFileSystemLimit ?? 10000,
        used_space: options.groupFileSystemUsedSpace ?? 0,
        total_space: options.groupFileSystemTotalSpace ?? 10737418240,
      };
    } else if (action === "get_group_root_files") {
      const count = Math.max(1, Math.min(5000, Number(body.file_count || groupFiles.length || 100)));
      data = {
        files: groupFiles.filter((file) => String(file.group_id) === String(body.group_id)).slice(0, count),
        folders: [],
      };
    } else if (action === "delete_group_file") {
      const index = groupFiles.findIndex((file) =>
        String(file.group_id) === String(body.group_id)
        && String(file.file_id) === String(body.file_id)
      );
      if (index >= 0) {
        groupFiles.splice(index, 1);
      }
      data = { result: 0, errMsg: "ok" };
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
  const fetchImpl = options.failSendUnknownWithLocalEcho
    ? async (url, requestOptions) => {
        if (String(url).endsWith("/send_group_msg")) {
          await fetch(url, requestOptions);
          throw new TypeError("simulated connection reset after local self echo");
        }
        return fetch(url, requestOptions);
      }
    : options.failSendUnknown
    ? async (url, requestOptions) => {
      if (String(url).endsWith("/send_group_msg")) {
        throw new TypeError("simulated connection reset after request dispatch");
      }
      return fetch(url, requestOptions);
    }
    : fetch;
  const createNotifier = (notifierOptions = {}) => createNapCatNotifier({
      cwd: temporaryRoot,
      env,
      fetchImpl,
      now: () => new Date("2026-07-24T05:30:00.000Z"),
      ...notifierOptions,
    });
  const notifier = createNotifier();

  return {
    notifier,
    calls,
    statePath,
    temporaryRoot,
    createNotifier,
    clearFileUrlCache: () => primedFileIds.clear(),
    groupFiles,
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
    assert.deepEqual(result.controlPlane, {
      enabled: false,
      machineIngressEnabled: false,
      machineIngressReady: false,
      localMachine: "",
      trustedPeerConfigured: false,
      targetCount: 0,
      defaultTargetKey: "",
    });
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
    assert.match(result.message, /delivery_id：[0-9a-f]{64}/);
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

test("read recent messages extracts reply and mention controls from CQ strings", async () => {
  const fixture = await createFixture({ includeStringControlSegments: true });
  try {
    const result = await fixture.notifier.readRecentMessages({ count: 10 });
    const reply = result.messages.find((message) => message.messageId === "907");
    assert.ok(reply);
    assert.equal(reply.replyMessageId, "1228686193");
    assert.deepEqual(reply.mentionedUserIds, ["1000000001"]);
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

test("task sends reject aliases and unknown roles before touching OneBot", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      () => fixture.notifier.sendTextMessage({
        text: "错误角色不会发出",
        task_id: "role-preflight",
        source_machine: "training",
        target_machine: "developer",
        dedupe_key: "role-preflight:text-alias",
      }),
      (error) => error.code === "MACHINE_ROLE_ALIAS_NOT_CANONICAL"
        && /标准值 development/.test(error.message)
        && /再发送/.test(error.message),
    );
    await assert.rejects(
      () => fixture.notifier.sendTextMessage({
        text: "未知角色不会发出",
        task_id: "role-preflight",
        source_machine: "trainer",
        target_machine: "development",
        dedupe_key: "role-preflight:text-unknown",
      }),
      (error) => error.code === "INVALID_MACHINE_ROLE" && /development 或 training/.test(error.message),
    );
    const filePath = path.join(fixture.temporaryRoot, "role-preflight.zip");
    fs.writeFileSync(filePath, "role-preflight", "utf8");
    await assert.rejects(
      () => fixture.notifier.sendFile({
        file_path: filePath,
        task_id: "role-preflight",
        source_machine: "developer",
        target_machine: "training",
        dedupe_key: "role-preflight:file-alias",
      }),
      (error) => error.code === "MACHINE_ROLE_ALIAS_NOT_CANONICAL" && /标准值 development/.test(error.message),
    );
    assert.equal(fixture.calls.length, 0);
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

test("text send keeps its verified result when post-send state persistence fails", async () => {
  const fixture = await createFixture();
  try {
    let writes = 0;
    const notifier = fixture.createNotifier({
      writeState: (statePath, state) => {
        writes += 1;
        if (writes > 1) {
          const error = new Error("simulated state rename failure");
          error.code = "EPERM";
          throw error;
        }
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      },
    });
    const input = { text: "状态写盘失败契约", dedupe_key: "manual:test:state-write-failure" };
    const result = await notifier.sendTextMessage(input);
    assert.equal(result.sent, true);
    assert.equal(result.verified, true);
    assert.equal(result.statePersisted, false);
    assert.equal(result.statePersistenceError.code, "EPERM");
    assert.equal(result.retryRecommended, false);

    const duplicate = await fixture.createNotifier().sendTextMessage(input);
    assert.equal(duplicate.sent, false);
    assert.equal(duplicate.duplicateSuppressed, true);
    assert.equal(duplicate.reason, "previous_outcome_unknown");
    assert.equal(duplicate.existing.status, "pending_send");
    assert.equal(duplicate.existing.reconciliation.reason, "self_history_unconfirmed");
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

test("a successful OneBot response verifies locally without treating real_seq as unique", async () => {
  const fixture = await createFixture({ ghostEchoOnSend: true });
  try {
    const input = {
      text: "本地回显不能冒充用户端可见",
      task_id: "visibility-contract",
      source_machine: "development",
      target_machine: "training",
      dedupe_key: "visibility-contract:local-echo",
    };
    const result = await fixture.notifier.sendTextMessage(input);
    assert.equal(result.sent, true);
    assert.equal(result.verified, true);
    assert.equal(result.userVisibilityVerified, false);
    assert.equal(result.verificationEvidence.evidence, "onebot_action_and_matching_self_history_record");
    assert.equal(result.verificationEvidence.realSeqAdvanced, false);
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    assert.equal(state.entries[input.dedupe_key].status, "sent_verified");
  } finally {
    await fixture.close();
  }
});

test("a successful OneBot response verifies locally when group history omits real_seq", async () => {
  const fixture = await createFixture({ ghostEchoWithoutRealSeq: true });
  try {
    const result = await fixture.notifier.sendTextMessage({
      text: "缺失 real_seq 仍只做本机一致性核验",
      task_id: "missing-real-seq-success",
      source_machine: "development",
      target_machine: "training",
      dedupe_key: "missing-real-seq:success",
    });
    assert.equal(result.sent, true);
    assert.equal(result.verified, true);
    assert.equal(result.userVisibilityVerified, false);
    assert.equal(result.verificationEvidence.evidence, "onebot_action_and_matching_self_history_record");
    assert.equal(result.verificationEvidence.realSeqAdvanced, false);
    assert.equal(result.verificationEvidence.deliveredRealSeq, null);
  } finally {
    await fixture.close();
  }
});

test("a conflicting sender id in self history cannot verify a successful send", async () => {
  const fixture = await createFixture({ historySelfSenderId: "999000111" });
  try {
    const input = {
      text: "冲突账号不能通过成功核验",
      task_id: "history-sender-conflict",
      source_machine: "development",
      target_machine: "training",
      dedupe_key: "history-sender-conflict:success",
    };
    const result = await fixture.notifier.sendTextMessage(input);
    assert.equal(result.sent, true);
    assert.equal(result.verified, false);
    assert.equal(result.userVisibilityVerified, false);
    assert.equal(result.verificationError.code, "MESSAGE_VERIFY_HISTORY_SENDER_MISMATCH");
    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    assert.equal(state.entries[input.dedupe_key].status, "sent_unverified");
  } finally {
    await fixture.close();
  }
});

test("the first message in an empty group verifies from the first observed real_seq", async () => {
  const fixture = await createFixture({ emptyHistory: true });
  try {
    const result = await fixture.notifier.sendTextMessage({
      text: "空群第一条消息",
      task_id: "empty-group-first-message",
      source_machine: "development",
      target_machine: "training",
      dedupe_key: "empty-group:first-message",
    });
    assert.equal(result.sent, true);
    assert.equal(result.verified, true);
    assert.equal(result.verificationEvidence.evidence, "onebot_action_and_first_self_history_record");
    assert.equal(result.userVisibilityVerified, false);
  } finally {
    await fixture.close();
  }
});

test("offline runtime is reachable but never ready and blocks sending before dispatch", async () => {
  const fixture = await createFixture({ runtimeOnline: false });
  try {
    const status = await fixture.notifier.status({ include_group: true });
    assert.equal(status.reachable, true);
    assert.equal(status.runtimeStatus.online, false);
    assert.equal(status.ready, false);
    assert.equal(status.controlPlane.machineIngressReady, false);
    await assert.rejects(
      () => fixture.notifier.sendTrainingEvent(trainingEvent({ dedupe_key: "offline:must-not-send" })),
      (error) => error.code === "NAPCAT_NOT_READY" && error.outcomeUnknown === false,
    );
    assert.equal(fixture.calls.some((call) => call.action === "send_group_msg"), false);
    assert.equal(fs.existsSync(fixture.statePath), false);
  } finally {
    await fixture.close();
  }
});

test("missing runtime online state fails closed before any send", async () => {
  const fixture = await createFixture({ omitRuntimeOnline: true });
  try {
    const status = await fixture.notifier.status({ include_group: false });
    assert.equal(status.reachable, true);
    assert.equal(status.ready, false);
    await assert.rejects(
      () => fixture.notifier.sendTextMessage({
        text: "状态字段缺失时不发送",
        dedupe_key: "runtime-status:missing-online",
      }),
      (error) => error.code === "NAPCAT_NOT_READY" && error.outcomeUnknown === false,
    );
    assert.equal(fixture.calls.some((call) => call.action === "send_group_msg"), false);
  } finally {
    await fixture.close();
  }
});

test("missing runtime good state fails closed before any send", async () => {
  const fixture = await createFixture({ omitRuntimeGood: true });
  try {
    const status = await fixture.notifier.status({ include_group: false });
    assert.equal(status.reachable, true);
    assert.equal(status.ready, false);
    await assert.rejects(
      () => fixture.notifier.sendTextMessage({
        text: "健康字段缺失时不发送",
        dedupe_key: "runtime-status:missing-good",
      }),
      (error) => error.code === "NAPCAT_NOT_READY" && error.outcomeUnknown === false,
    );
    assert.equal(fixture.calls.some((call) => call.action === "send_group_msg"), false);
  } finally {
    await fixture.close();
  }
});

test("status without group inspection still reports an online verified account ready", async () => {
  const fixture = await createFixture();
  try {
    const status = await fixture.notifier.status({ include_group: false });
    assert.equal(status.ready, true);
    assert.equal(status.reachable, true);
    assert.equal(status.controlPlane.machineIngressReady, false);
    assert.equal(status.identity.actualSelfId, "1000000001");
    assert.equal(status.group, null);
    assert.equal(fixture.calls.some((call) => call.action === "get_group_info"), false);
  } finally {
    await fixture.close();
  }
});

test("group file upload skips cleanup below effective file count cap", async () => {
  const existingFiles = Array.from({ length: 1499 }, (_, index) => ({
    group_id: 123456789,
    file_id: `existing-file-${index}`,
    file_name: `existing-${index}.zip`,
    file_size: 100 + index,
    size: 100 + index,
    busid: 102,
    uploader: 1000000001,
    uploader_name: "ExampleBot",
    modify_time: 1784000000 + index,
  })).reverse();
  const fixture = await createFixture({ groupFiles: existingFiles });
  try {
    const filePath = path.join(fixture.temporaryRoot, "below-cap.zip");
    fs.writeFileSync(filePath, "below-count-cap", "utf8");

    const result = await fixture.notifier.sendFile({
      file_path: filePath,
      name: "未达上限.zip",
      dedupe_key: "manual:file:below-count-cap",
    });

    assert.equal(result.sent, true);
    assert.equal(result.verified, true);
    assert.equal(result.groupFileCleanup.checked, true);
    assert.equal(result.groupFileCleanup.cleanupNeeded, false);
    assert.equal(result.groupFileCleanup.reportedFileCount, 1499);
    assert.equal(result.groupFileCleanup.effectiveLimit, 1500);
    assert.equal(fixture.calls.filter((call) => call.action === "delete_group_file").length, 0);
    assert.equal(fixture.calls.filter((call) => call.action === "upload_group_file").length, 1);
  } finally {
    await fixture.close();
  }
});

test("group file upload deletes oldest files before upload at effective file count cap", async () => {
  const existingFiles = Array.from({ length: 1500 }, (_, index) => ({
    group_id: 123456789,
    file_id: `old-file-${String(index).padStart(4, "0")}`,
    file_name: `old-${String(index).padStart(4, "0")}.zip`,
    file_size: 100 + index,
    size: 100 + index,
    busid: 102,
    uploader: index % 2 === 0 ? 1000000001 : 1000000003,
    uploader_name: index % 2 === 0 ? "ExampleBot" : "ExampleUser",
    modify_time: 1783000000 + index,
  })).reverse();
  const fixture = await createFixture({ groupFiles: existingFiles });
  try {
    const filePath = path.join(fixture.temporaryRoot, "at-cap.zip");
    fs.writeFileSync(filePath, "at-count-cap", "utf8");

    const result = await fixture.notifier.sendFile({
      file_path: filePath,
      name: "达到上限后上传.zip",
      dedupe_key: "manual:file:at-count-cap",
    });

    assert.equal(result.sent, true);
    assert.equal(result.verified, true);
    assert.equal(result.groupFileCleanup.cleanupNeeded, true);
    assert.equal(result.groupFileCleanup.reportedFileCount, 1500);
    assert.equal(result.groupFileCleanup.listedRootFiles, 1500);
    assert.equal(result.groupFileCleanup.deletedCount, 100);
    assert.equal(result.groupFileCleanup.failedCount, 0);
    assert.equal(result.groupFileCleanup.deletedSample[0].fileName, "old-0000.zip");

    const deleteCalls = fixture.calls.filter((call) => call.action === "delete_group_file");
    assert.equal(deleteCalls.length, 100);
    assert.deepEqual(
      deleteCalls.slice(0, 3).map((call) => call.body.file_id),
      ["old-file-0000", "old-file-0001", "old-file-0002"],
    );
    assert.equal(deleteCalls.at(-1).body.file_id, "old-file-0099");
    assert.equal(fixture.groupFiles.some((file) => file.file_id === "old-file-0000"), false);
    assert.equal(fixture.groupFiles.some((file) => file.file_id === "old-file-0100"), true);
    assert.equal(fixture.groupFiles.length, 1401);

    const firstDeleteIndex = fixture.calls.findIndex((call) => call.action === "delete_group_file");
    const uploadIndex = fixture.calls.findIndex((call) => call.action === "upload_group_file");
    assert.equal(firstDeleteIndex > -1, true);
    assert.equal(uploadIndex > firstDeleteIndex, true);
    assert.equal(uploadIndex > fixture.calls.findLastIndex((call) => call.action === "delete_group_file"), true);
  } finally {
    await fixture.close();
  }
});

test("group file upload unknown outcome recovers by read-only file lookup", async () => {
  const fixture = await createFixture({ failUploadGroupFileAfterPersist: true });
  try {
    const filePath = path.join(fixture.temporaryRoot, "unknown-but-present.zip");
    const content = "unknown-outcome-file-present";
    fs.writeFileSync(filePath, content, "utf8");
    const input = {
      file_path: filePath,
      name: "结果未知但已上传.zip",
      task_id: "stage89-upload-unknown-recovery",
      source_machine: "training",
      target_machine: "development",
      dedupe_key: "stage89-upload-unknown-recovery:file",
    };

    const result = await fixture.notifier.sendFile(input);
    assert.equal(result.sent, true);
    assert.equal(result.verified, true);
    assert.equal(result.recoveredFromUnknownUpload, true);
    assert.equal(result.uploadError.code, "ONEBOT_ACTION_FAILED");
    assert.equal(result.uploadError.details.retcode, 200);
    assert.match(result.uploadError.details.wording, /rich media transfer failed/);
    assert.equal(result.taskIndex.status, "sent_verified");
    assert.equal(result.taskIndex.sent, true);
    assert.equal(fixture.calls.filter((call) => call.action === "upload_group_file").length, 1);
    assert.equal(fixture.calls.some((call) => call.action === "get_group_root_files"), true);
    assert.equal(fixture.calls.some((call) => call.action === "get_group_msg_history"), true);

    const state = JSON.parse(fs.readFileSync(fixture.statePath, "utf8"));
    assert.equal(state.entries[input.dedupe_key].status, "sent_verified");
    assert.equal(state.entries[input.dedupe_key].recoveredFromUnknownUpload, true);
    assert.equal(state.entries[input.dedupe_key].uploadError.details.retcode, 200);

    const second = await fixture.notifier.sendFile(input);
    assert.equal(second.sent, false);
    assert.equal(second.reason, "file_already_uploaded");
    assert.equal(fixture.calls.filter((call) => call.action === "upload_group_file").length, 1);
  } finally {
    await fixture.close();
  }
});

test("configured group file upload uses selected control-plane group only", async () => {
  const fixture = await createFixture({
    controlPlane: {
      enabled: true,
      defaultTargetKey: "owner-members",
      targets: {
        "owner-members": {
          type: "group",
          id: "950683114",
          name: "Members",
          expectedMemberCount: 3,
        },
      },
    },
    configuredGroups: {
      "950683114": { groupId: "950683114", groupName: "Members", memberCount: 3 },
    },
  });
  try {
    const filePath = path.join(fixture.temporaryRoot, "owner-report.pdf");
    fs.writeFileSync(filePath, "owner-report-content", "utf8");
    const input = {
      target_key: "owner-members",
      file_path: filePath,
      name: "owner-report.pdf",
      dedupe_key: "owner-members:file:report",
    };

    const preview = await fixture.notifier.previewConfiguredFile(input);
    assert.equal(preview.target.targetKey, "owner-members");
    assert.equal(preview.target.id, "950683114");
    assert.equal(preview.fileBytes, 20);

    const result = await fixture.notifier.sendConfiguredFile(input);
    assert.equal(result.sent, true);
    assert.equal(result.verified, true);
    assert.equal(result.target.targetKey, "owner-members");
    assert.equal(result.target.id, "950683114");
    const uploadCall = fixture.calls.find((call) => call.action === "upload_group_file");
    assert.equal(String(uploadCall.body.group_id), "950683114");
    assert.equal(fixture.calls.some((call) =>
      call.action === "send_group_msg"
      && String(call.body.message ?? "").includes("[Codex][TASK_FILE_INDEX]")
    ), false);
  } finally {
    await fixture.close();
  }
});

test("configured private file target uploads to selected friend and verifies by private history", async () => {
  const fixture = await createFixture({
    controlPlane: {
      enabled: true,
      defaultTargetKey: "owner-private",
      targets: {
        "owner-private": {
          type: "private",
          id: "1064964702",
          name: "Owner",
        },
      },
    },
    friends: [{ userId: "1064964702", nickname: "Owner" }],
  });
  try {
    const filePath = path.join(fixture.temporaryRoot, "private-report.pdf");
    fs.writeFileSync(filePath, "private-report-content", "utf8");
    const preview = await fixture.notifier.previewConfiguredFile({
      target_key: "owner-private",
      file_path: filePath,
      name: "private-report.pdf",
      dedupe_key: "owner-private:file:report",
    });
    assert.equal(preview.target.type, "private");
    assert.equal(preview.target.id, "1064964702");

    const result = await fixture.notifier.sendConfiguredFile({
      target_key: "owner-private",
      file_path: filePath,
      name: "private-report.pdf",
      dedupe_key: "owner-private:file:report",
    });
    assert.equal(result.sent, true);
    assert.equal(result.verified, true);
    assert.equal(result.target.type, "private");
    assert.equal(result.target.id, "1064964702");
    const uploadCall = fixture.calls.find((call) => call.action === "upload_private_file");
    assert.equal(String(uploadCall.body.user_id), "1064964702");
    assert.equal(uploadCall.body.file, fs.realpathSync(filePath));
    assert.equal(fixture.calls.some((call) => call.action === "upload_group_file"), false);
    assert.equal(fixture.calls.some((call) => call.action === "send_group_msg"), false);
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

    const recent = await fixture.notifier.readRecentMessages({
      count: 10,
      task_id: input.task_id,
      include_self_history: true,
    });
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

test("HTTP error after an accepted send keeps self history unresolved without resending", async () => {
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
    assert.equal(second.existing.status, "pending_send");
    assert.equal(second.existing.reconciliation.reason, "self_history_unconfirmed");
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

test("unknown reconciliation paginates beyond the latest fifty messages without treating self history as success", async () => {
  const fixture = await createFixture({ httpErrorAfterSend: true, appendHistoryAfterSendCount: 60 });
  try {
    const input = trainingEvent({ dedupe_key: "tgt-20260724-01:http-unknown-paged" });
    await assert.rejects(
      () => fixture.notifier.sendTrainingEvent(input),
      (error) => error.code === "ONEBOT_HTTP_ERROR" && error.outcomeUnknown === true,
    );
    const duplicate = await fixture.notifier.sendTrainingEvent(input);
    assert.equal(duplicate.reason, "previous_outcome_unknown");
    assert.equal(duplicate.existing.status, "pending_send");
    assert.equal(duplicate.existing.reconciliation.reason, "self_history_unconfirmed");
    assert.equal(duplicate.existing.reconciliation.historyPagesScanned >= 2, true);
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 1);
  } finally {
    await fixture.close();
  }
});

test("multiple self history matches keep an unknown send unresolved", async () => {
  const fixture = await createFixture({ httpErrorAfterSend: true, duplicateAuthoritativeAfterSend: true });
  try {
    const input = trainingEvent({ dedupe_key: "tgt-20260724-01:http-unknown-ambiguous" });
    await assert.rejects(
      () => fixture.notifier.sendTrainingEvent(input),
      (error) => error.code === "ONEBOT_HTTP_ERROR" && error.outcomeUnknown === true,
    );
    const duplicate = await fixture.notifier.sendTrainingEvent(input);
    assert.equal(duplicate.reason, "previous_outcome_unknown");
    assert.equal(duplicate.existing.status, "pending_send");
    assert.equal(duplicate.existing.reconciliation.reason, "multiple_self_history_candidates");
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 1);
  } finally {
    await fixture.close();
  }
});

test("timeout local self echo with reused real_seq stays unknown and is hidden from task reads", async () => {
  const fixture = await createFixture({ failSendUnknownWithLocalEcho: true, ghostEchoOnSend: true });
  try {
    const input = trainingEvent({
      task_id: "ghost-timeout-task",
      dedupe_key: "ghost-timeout:unknown",
    });
    await assert.rejects(
      () => fixture.notifier.sendTrainingEvent(input),
      (error) => error.code === "ONEBOT_NETWORK_ERROR" && error.outcomeUnknown === true,
    );

    const recent = await fixture.notifier.readRecentMessages({ count: 20, task_id: input.task_id });
    assert.equal(recent.returnedCount, 0);
    assert.equal(recent.suppressedUnverifiedLocalEchoCount, 1);
    assert.deepEqual(recent.suppressedUnverifiedLocalEchoMessageIds, ["1001"]);

    const duplicate = await fixture.notifier.sendTrainingEvent(input);
    assert.equal(duplicate.sent, false);
    assert.equal(duplicate.reason, "previous_outcome_unknown");
    assert.equal(duplicate.existing.status, "pending_send");
    assert.equal(duplicate.existing.reconciliation.reason, "self_history_reused_sequence");
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 1);
  } finally {
    await fixture.close();
  }
});

test("timeout local self echo with a new real_seq is still hidden and never reconciled", async () => {
  const fixture = await createFixture({ failSendUnknownWithLocalEcho: true, ghostEchoAdvancesRealSeq: true });
  try {
    const input = trainingEvent({
      task_id: "ghost-new-seq-task",
      dedupe_key: "ghost-new-seq:unknown",
    });
    await assert.rejects(
      () => fixture.notifier.sendTrainingEvent(input),
      (error) => error.code === "ONEBOT_NETWORK_ERROR" && error.outcomeUnknown === true,
    );
    const recent = await fixture.notifier.readRecentMessages({ count: 20, task_id: input.task_id });
    assert.equal(recent.returnedCount, 0);
    assert.equal(recent.suppressedUnverifiedLocalEchoCount, 1);
    const duplicate = await fixture.notifier.sendTrainingEvent(input);
    assert.equal(duplicate.reason, "previous_outcome_unknown");
    assert.equal(duplicate.existing.reconciliation.reason, "self_history_unconfirmed");
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 1);
  } finally {
    await fixture.close();
  }
});

test("timeout local self echo without real_seq is hidden and never reconciled", async () => {
  const fixture = await createFixture({ failSendUnknownWithLocalEcho: true, ghostEchoWithoutRealSeq: true });
  try {
    const input = trainingEvent({
      task_id: "ghost-missing-seq-task",
      dedupe_key: "ghost-missing-seq:unknown",
    });
    await assert.rejects(
      () => fixture.notifier.sendTrainingEvent(input),
      (error) => error.code === "ONEBOT_NETWORK_ERROR" && error.outcomeUnknown === true,
    );
    const recent = await fixture.notifier.readRecentMessages({ count: 20, task_id: input.task_id });
    assert.equal(recent.returnedCount, 0);
    assert.equal(recent.suppressedUnverifiedLocalEchoCount, 1);
    const duplicate = await fixture.notifier.sendTrainingEvent(input);
    assert.equal(duplicate.reason, "previous_outcome_unknown");
    assert.equal(duplicate.existing.reconciliation.reason, "self_history_unconfirmed");
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 1);
  } finally {
    await fixture.close();
  }
});

test("explicit message_sent self history stays hidden when sender identity is absent", async () => {
  const fixture = await createFixture({
    failSendUnknownWithLocalEcho: true,
    ghostEchoOnSend: true,
    omitSelfSenderIdentity: true,
    omitSelfMessageSentType: true,
  });
  try {
    const input = trainingEvent({
      task_id: "ghost-missing-sender-task",
      dedupe_key: "ghost-missing-sender:unknown",
    });
    await assert.rejects(
      () => fixture.notifier.sendTrainingEvent(input),
      (error) => error.code === "ONEBOT_NETWORK_ERROR" && error.outcomeUnknown === true,
    );
    const recent = await fixture.notifier.readRecentMessages({ count: 20, task_id: input.task_id });
    assert.equal(recent.returnedCount, 0);
    assert.equal(recent.suppressedSelfHistoryCount, 1);
    const duplicate = await fixture.notifier.sendTrainingEvent(input);
    assert.equal(duplicate.reason, "previous_outcome_unknown");
    assert.equal(duplicate.existing.status, "pending_send");
    assert.equal(fixture.calls.filter((call) => call.action === "send_group_msg").length, 1);
  } finally {
    await fixture.close();
  }
});

test("post_type message_sent alone hides senderless self history", async () => {
  const fixture = await createFixture({
    failSendUnknownWithLocalEcho: true,
    ghostEchoOnSend: true,
    omitSelfSenderIdentity: true,
  });
  try {
    const input = trainingEvent({ task_id: "post-type-self-only", dedupe_key: "post-type-self-only:unknown" });
    await assert.rejects(() => fixture.notifier.sendTrainingEvent(input));
    const recent = await fixture.notifier.readRecentMessages({ count: 20, task_id: input.task_id });
    assert.equal(recent.returnedCount, 0);
    assert.equal(recent.suppressedSelfHistoryCount, 1);
  } finally {
    await fixture.close();
  }
});

test("message_sent_type self alone hides senderless self history", async () => {
  const fixture = await createFixture({
    failSendUnknownWithLocalEcho: true,
    ghostEchoOnSend: true,
    omitSelfSenderIdentity: true,
    omitSelfPostType: true,
  });
  try {
    const input = trainingEvent({ task_id: "message-sent-type-self-only", dedupe_key: "message-sent-type-self-only:unknown" });
    await assert.rejects(() => fixture.notifier.sendTrainingEvent(input));
    const recent = await fixture.notifier.readRecentMessages({ count: 20, task_id: input.task_id });
    assert.equal(recent.returnedCount, 0);
    assert.equal(recent.suppressedSelfHistoryCount, 1);
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
