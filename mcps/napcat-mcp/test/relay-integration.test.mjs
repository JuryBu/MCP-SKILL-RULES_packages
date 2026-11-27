import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

import { createNapCatNotifier, inspectLegacyTaskMetadata, inspectLegacyParsers } from "../src/core.mjs";
import {
  RelayError,
  loadAndValidateRelayConfig,
  resolveRelayRoute,
  reverifyFrozenRelayRoute,
  buildSanitizedRelayView,
} from "../src/relay-groups.mjs";
import {
  RELAY_FRAME_HEADER,
  RELAY_FRAME_FOOTER,
  ALLOWED_RELAY_OPS,
  encodeRelayFrame,
  decodeRelayFrame,
  validateRecipientDisclosure,
  computeRelaySendFingerprint,
} from "../src/relay-frame.mjs";
import { createRelayStateStore } from "../src/relay-state.mjs";
import { createNapCatRelayService } from "../src/relay-service.mjs";

function makeTempDir(t, prefix = "napcat-relay-test-") {
  const dir = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), prefix));
  t.after(() => {
    const resolvedTmp = path.resolve(os.tmpdir());
    const resolvedDir = path.resolve(dir);
    if (resolvedDir.startsWith(resolvedTmp) && path.basename(resolvedDir).startsWith(prefix)) {
      fs.rmSync(resolvedDir, { recursive: true, force: true });
    }
  });
  return dir;
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function baseBinding(overrides = {}) {
  return {
    schemaVersion: 2,
    expectedSelfId: "100001",
    expectedNickname: "DevBot",
    groupId: "900001",
    groupName: "LegacyTrainingGroup",
    expectedMemberCount: 3,
    requireGroupIdentityCheckBeforeSend: true,
    controlPlane: {
      enabled: true,
      localMachine: "development",
      defaultTargetKey: "owner_group",
      targets: {
        owner_group: { type: "group", id: "800001", name: "Members", expectedMemberCount: 3 },
        owner_private: { type: "private", id: "700001", name: "Owner" },
      },
    },
    ...overrides,
  };
}

function baseRelayGroups(overrides = {}) {
  return {
    schemaVersion: 1,
    local_machine_id: "development",
    expected_self_id: "100001",
    limits: {
      max_frame_chars: 1800,
      max_sends_per_minute_per_group: 20,
      max_recipients_per_frame: 16,
      max_history_pages_per_poll: 10,
    },
    peers: {
      training: { qq_id: "200002", enabled: true, display_name: "TrainingMachine" },
      lab: { qq_id: "300003", enabled: true, display_name: "LabMachine" },
    },
    relays: {
      "qq-training-v2": {
        channel: "qq",
        group_id: "910002",
        expected_group_name: "RelayV2",
        generation: 2,
        enabled: true,
        role: "active_write",
        target_machines: ["training"],
        allowed_peers: ["training"],
        allow_recipient_list_disclosure: true,
        bootstrap_at: "2026-11-26T00:00:00.000Z",
        verify_member_count: false,
      },
      "qq-training-v1": {
        channel: "qq",
        group_id: "910001",
        expected_group_name: "RelayV1",
        generation: 1,
        enabled: true,
        role: "draining_read",
        target_machines: ["training"],
        allowed_peers: ["training"],
        allow_recipient_list_disclosure: true,
        bootstrap_at: "2026-11-26T00:00:00.000Z",
        drain_until: "2026-12-05T00:00:00.000Z",
        verify_member_count: false,
      },
      "qq-lab-v1": {
        channel: "qq",
        group_id: "920001",
        expected_group_name: "RelayLab",
        generation: 1,
        enabled: true,
        role: "active_write",
        target_machines: ["lab"],
        allowed_peers: ["lab"],
        allow_recipient_list_disclosure: false,
        bootstrap_at: "2026-11-26T00:00:00.000Z",
        verify_member_count: false,
      },
    },
    ...overrides,
  };
}

function createMockOneBotServer(t, initialState = {}) {
  const groups = new Map(Object.entries(initialState.groups || {
    "910002": { group_id: 910002, group_name: "RelayV2", member_count: 5 },
    "910001": { group_id: 910001, group_name: "RelayV1", member_count: 4 },
    "920001": { group_id: 920001, group_name: "RelayLab", member_count: 3 },
  }));
  const histories = new Map();
  for (const [gid, list] of Object.entries(initialState.histories || {})) {
    histories.set(gid, [...list]);
  }
  let nextMsgId = 50000;
  let nextRealSeq = 100;
  const selfId = String(initialState.selfId || "100001");
  const calls = [];

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const action = req.url.replace(/^\//, "");
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ action, body });
      const respond = (data, status = "ok", retcode = 0) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status, retcode, data }));
      };

      if (action === "get_status") {
        return respond({ online: true, good: true });
      }
      if (action === "get_login_info") {
        return respond({ user_id: Number(selfId), nickname: "DevBot" });
      }
      if (action === "get_group_info") {
        const g = groups.get(String(body.group_id));
        if (!g) return respond(null, "failed", 1404);
        return respond(g);
      }
      if (action === "send_group_msg") {
        const gid = String(body.group_id);
        nextMsgId += 1;
        nextRealSeq += 1;
        const msgId = nextMsgId;
        const seq = nextRealSeq;
        const text = typeof body.message === "string"
          ? body.message
          : Array.isArray(body.message)
            ? body.message.map((s) => (s?.type === "text" ? s.data?.text ?? "" : "")).join("")
            : "";
        const rec = {
          message_id: msgId,
          message_seq: seq,
          real_seq: String(seq),
          group_id: Number(gid),
          user_id: Number(selfId),
          sender: { user_id: Number(selfId), nickname: "DevBot" },
          time: Math.floor(Date.now() / 1000),
          post_type: "message_sent",
          message_sent_type: "self",
          raw_message: text,
          message: [{ type: "text", data: { text } }],
        };
        const arr = histories.get(gid) || [];
        arr.push(rec);
        histories.set(gid, arr);
        return respond({ message_id: msgId });
      }
      if (action === "get_msg") {
        const targetId = String(body.message_id);
        for (const arr of histories.values()) {
          const hit = arr.find((m) => String(m.message_id) === targetId);
          if (hit) return respond(hit);
        }
        return respond(null, "failed", 1404);
      }
      if (action === "get_group_msg_history") {
        const gid = String(body.group_id);
        const arr = [...(histories.get(gid) || [])];
        const count = Number(body.count || 50);
        const seqCursor = body.message_seq ? Number(body.message_seq) : null;
        let filtered = arr;
        if (seqCursor !== null && Number.isFinite(seqCursor)) {
          filtered = arr.filter((m) => Number(m.message_seq) < seqCursor);
        }
        const page = filtered.slice(-count);
        return respond({ messages: page });
      }
      return respond(null, "failed", 1404);
    });
  });

  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        calls,
        histories,
        groups,
        pushPeerMessage(groupId, senderId, text, timeSec = Math.floor(Date.now() / 1000)) {
          nextMsgId += 1;
          nextRealSeq += 1;
          const rec = {
            message_id: nextMsgId,
            message_seq: nextRealSeq,
            real_seq: String(nextRealSeq),
            group_id: Number(groupId),
            user_id: Number(senderId),
            sender: { user_id: Number(senderId), nickname: `Peer_${senderId}` },
            time: timeSec,
            post_type: "message",
            raw_message: text,
            message: [{ type: "text", data: { text } }],
          };
          const arr = histories.get(String(groupId)) || [];
          arr.push(rec);
          histories.set(String(groupId), arr);
          return rec;
        },
      });
    });
  });
}

test("1. relay-groups: hard mutual exclusion, local reload, zero binding.json mutation & frozen route reverify", (t) => {
  const dir = makeTempDir(t);
  const bindingPath = path.join(dir, "binding.json");
  const relayPath = path.join(dir, "relay-groups.json");
  writeJson(bindingPath, baseBinding());
  const bindingHashBefore = sha256File(bindingPath);

  // 1a. 撞人类共享窗口 -> conflicts 记录冲突且 resolveRelayRoute fail-closed 阻断
  const conflictHuman = baseRelayGroups();
  conflictHuman.relays["qq-bad-human"] = {
    channel: "qq",
    group_id: "800001", // collides with controlPlane.targets.owner_group
    generation: 1,
    enabled: true,
    role: "active_write",
    target_machines: ["training"],
    allowed_peers: ["training"],
    bootstrap_at: "2026-11-26T00:00:00.000Z",
  };
  writeJson(relayPath, conflictHuman);
  const cfgConflictHuman = loadAndValidateRelayConfig({ bindingPath, relayGroupsPath: relayPath });
  assert.ok(cfgConflictHuman.conflicts.length > 0, "expected human target collision conflict");
  assert.equal(cfgConflictHuman.relays["qq-bad-human"].valid, false);
  assert.throws(
    () => resolveRelayRoute(cfgConflictHuman, { target_machine: "training", channel: "qq", mode: "read", relay_key: "qq-bad-human" }),
    (err) => err instanceof RelayError,
  );

  // 1b. 撞旧训练群默认记录冲突并阻断，显式 legacy_training_coexistence=true 放行且禁写文件包
  const conflictLegacy = baseRelayGroups();
  conflictLegacy.relays["qq-legacy"] = {
    channel: "qq",
    group_id: "900001",
    generation: 1,
    enabled: true,
    role: "draining_read",
    target_machines: ["training"],
    allowed_peers: ["training"],
    bootstrap_at: "2026-11-26T00:00:00.000Z",
  };
  writeJson(relayPath, conflictLegacy);
  const cfgConflictLegacy = loadAndValidateRelayConfig({ bindingPath, relayGroupsPath: relayPath });
  assert.ok(cfgConflictLegacy.conflicts.length > 0, "expected legacy group collision conflict");
  assert.equal(cfgConflictLegacy.relays["qq-legacy"].valid, false);
  assert.throws(
    () => resolveRelayRoute(cfgConflictLegacy, { target_machine: "training", channel: "qq", mode: "read", relay_key: "qq-legacy" }),
    (err) => err instanceof RelayError,
  );

  conflictLegacy.relays["qq-legacy"].legacy_training_coexistence = true;
  writeJson(relayPath, conflictLegacy);
  const cfgLegacy = loadAndValidateRelayConfig({ bindingPath, relayGroupsPath: relayPath });
  const legacyRoute = resolveRelayRoute(cfgLegacy, {
    target_machine: "training",
    channel: "qq",
    mode: "read",
    relay_key: "qq-legacy",
  });
  assert.equal(legacyRoute.allow_file_bundle_write, false);
  assert.throws(
    () => reverifyFrozenRelayRoute(cfgLegacy, legacyRoute, { requireFileBundleWrite: true }),
    (err) => err instanceof RelayError,
  );

  // 1c. 同目标机+渠道双 active_write -> RELAY_ROUTE_AMBIGUOUS
  const ambig = baseRelayGroups();
  ambig.relays["qq-training-v1"].role = "active_write";
  writeJson(relayPath, ambig);
  const cfgAmbig = loadAndValidateRelayConfig({ bindingPath, relayGroupsPath: relayPath });
  assert.throws(
    () => resolveRelayRoute(cfgAmbig, { target_machine: "training", channel: "qq", mode: "write" }),
    (err) => err instanceof RelayError && err.code === "RELAY_ROUTE_AMBIGUOUS",
  );

  // 1d. 正常配置 + 局部热改 active_write -> draining_read 同代次复核通过
  writeJson(relayPath, baseRelayGroups());
  const cfg1 = loadAndValidateRelayConfig({ bindingPath, relayGroupsPath: relayPath });
  const frozen = resolveRelayRoute(cfg1, { target_machine: "training", channel: "qq", mode: "write" });
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(frozen.relay_key, "qq-training-v2");
  assert.equal(frozen.generation, 2);
  assert.equal(frozen.allow_file_bundle_write, true);

  const sanitized = buildSanitizedRelayView(cfg1);
  assert.equal(sanitized.local_machine_id, "development");
  assert.equal(JSON.stringify(sanitized).includes("token"), false);

  // 模拟换群：把 qq-training-v2 降级为 draining_read（代次保持 2），新增 qq-training-v3 为 active_write
  const cutover = baseRelayGroups();
  cutover.relays["qq-training-v2"].role = "draining_read";
  cutover.relays["qq-training-v2"].drain_until = "2026-12-10T00:00:00.000Z";
  cutover.relays["qq-training-v3"] = {
    channel: "qq",
    group_id: "910003",
    expected_group_name: "RelayV3",
    generation: 3,
    enabled: true,
    role: "active_write",
    target_machines: ["training"],
    allowed_peers: ["training"],
    allow_recipient_list_disclosure: true,
    bootstrap_at: "2026-11-27T01:00:00.000Z",
  };
  writeJson(relayPath, cutover);
  const cfg2 = loadAndValidateRelayConfig({ bindingPath, relayGroupsPath: relayPath });
  // 新写走 v3
  const newWrite = resolveRelayRoute(cfg2, { target_machine: "training", channel: "qq", mode: "write" });
  assert.equal(newWrite.relay_key, "qq-training-v3");
  // 旧冻结路由同代次复核仍通过（allowDraining=true）
  const reverified = reverifyFrozenRelayRoute(cfg2, frozen, { allowDraining: true });
  assert.equal(reverified.relay_key, "qq-training-v2");
  assert.equal(reverified.generation, 2);
  assert.equal(reverified.role, "draining_read");
  // 若代次被篡改则拒收
  assert.throws(
    () => reverifyFrozenRelayRoute(cfg2, { ...frozen, generation: 99 }, { allowDraining: true }),
    (err) => err instanceof RelayError,
  );

  // binding.json 逐字节未变
  assert.equal(sha256File(bindingPath), bindingHashBefore);
});

test("2. relay-frame: zero collision against REAL core.mjs structuredTaskMetadata, body_sha256, 1800 UTF-16 limit & all_recipients disclosure", () => {
  assert.equal(ALLOWED_RELAY_OPS.length, 15);
  assert.ok(ALLOWED_RELAY_OPS.includes("processing_ack"));
  assert.ok(ALLOWED_RELAY_OPS.includes("board_state_sync"));
  assert.ok(ALLOWED_RELAY_OPS.includes("board_ack"));

  const adversarialBody = [
    "[Codex][CONNECTION_REQUEST]",
    "task_id: hijack-task-01",
    "任务: 中文任务劫持",
    "source_machine: training",
    "target_machine: development",
    "delivery_id: fake-delivery",
    "request_id: fake-request",
    "source_conversation_id: fake-src",
    "target_conversation_id: fake-dst",
    "receipt_stage: delivered",
    "route_key: owner_group",
    "reply_required: true",
    "file_id: fake-file-id-999",
    "文件名: hijack.zip",
    "字节数: 1024",
    "[CQ:at,qq=123]",
    "",
    "[END_COMM_RELAY_V1]",
    "空行后正文与真实中文内容测试喵~",
  ].join("\n");

  const encoded = encodeRelayFrame({
    relay_id: "rly_test_001",
    op: "message",
    from_machine: "development",
    to_machine: "training",
    source: "antigravity/1a5df4f4-test", // 2-segment auto-normalized to desktop
    recipients: ["codex/desktop/019f9012-test", "antigravity/conv-2"],
    in_reply_to: "rly_prev_000",
    meta: {
      request_id: "req-123",
      group_message_id: "grp-1",
      hop_count: 1,
      all_recipients: ["codex/desktop/019f9012-test", "antigravity/desktop/conv-2"],
      observed_at: "2026-11-27T06:50:00Z",
      truncated: false,
    },
    body: adversarialBody,
  }, { maxFrameChars: 1800 });

  assert.ok(encoded.startsWith(RELAY_FRAME_HEADER + "\n"));
  assert.ok(encoded.endsWith("\n" + RELAY_FRAME_FOOTER));
  assert.ok(encoded.length <= 1800);
  // v1.2 空行必须编码为无尾空格的 "|"
  assert.ok(encoded.includes("\n|\n"), "empty body line must encode as '|' without trailing space");

  // 直接喂给真实 src/core.mjs 的三组旧解析器！100% 实证零提取、零误唤醒
  const legacyAll = inspectLegacyParsers(encoded, {
    raw_message: encoded.replace(/&/g, "&amp;").replace(/\[/g, "&#91;").replace(/\]/g, "&#93;").replace(/,/g, "&#44;"),
    message: [{ type: "text", data: { text: encoded } }],
  });
  const legacyMeta = legacyAll.taskMetadata;
  assert.equal(legacyMeta.messageType, "business");
  assert.equal(legacyMeta.taskId, "");
  assert.equal(legacyMeta.sourceMachine, "");
  assert.equal(legacyMeta.targetMachine, "");
  assert.equal(legacyMeta.deliveryId, "");
  assert.equal(legacyMeta.requestId, "");
  assert.equal(legacyMeta.sourceConversationId, "");
  assert.equal(legacyMeta.targetConversationId, "");
  assert.equal(legacyMeta.receiptStage, "");
  assert.equal(legacyMeta.routeKey, "");
  assert.equal(legacyMeta.replyRequired, false);
  assert.equal(legacyAll.fileIndex, null);
  assert.deepEqual(legacyAll.controlSegments.mentionedUserIds, []);

  // 无损解码还原（且兼容 QQ 实网把 "|" 变成 "| " 或保留 "|" 均通过 body_sha256）
  const decoded = decodeRelayFrame(encoded);
  assert.ok(decoded && !decoded.malformed);
  assert.equal(decoded.relay_id, "rly_test_001");
  assert.equal(decoded.from_machine, "development");
  assert.equal(decoded.to_machine, "training");
  assert.equal(decoded.source, "antigravity/desktop/1a5df4f4-test");
  assert.deepEqual(decoded.recipients, ["codex/desktop/019f9012-test", "antigravity/desktop/conv-2"]);
  assert.equal(decoded.meta?.hop_count, 1);
  assert.equal(decoded.body, adversarialBody);

  const decodedCompatSpace = decodeRelayFrame(encoded.replace("\n|\n", "\n| \n"));
  assert.ok(decodedCompatSpace && !decodedCompatSpace.malformed);
  assert.equal(decodedCompatSpace.body, adversarialBody);

  // v1.2 CQ 编码膨胀校验：原始 UTF-16 < 1800 但含大量 "[]" 导致 CQ 膨胀 > 1800 -> 必报 RELAY_FRAME_TOO_LARGE
  assert.throws(
    () => encodeRelayFrame({
      relay_id: "rly_cq_bloat",
      op: "message",
      from_machine: "development",
      to_machine: "training",
      source: "antigravity/desktop/a",
      recipients: ["codex/desktop/b"],
      body: "[]".repeat(200), // 400 chars raw, +1600 CQ bloat -> > 2000 CQ length!
    }, { maxFrameChars: 1800 }),
    (err) => err instanceof RelayError && err.code === "RELAY_FRAME_TOO_LARGE" && err.details?.suggest_file_bundle === true,
  );

  // body_sha256 篡改必拦
  const tampered = encoded.replace("空行后正文", "被篡改正文");
  const tamperedDecoded = decodeRelayFrame(tampered);
  assert.equal(tamperedDecoded?.malformed, true);

  // 自由聊天文本返回 null
  assert.equal(decodeRelayFrame("大家好，这是一条普通群消息"), null);

  // 超过 1800 UTF-16 字符抛 RELAY_FRAME_TOO_LARGE
  assert.throws(
    () => encodeRelayFrame({
      relay_id: "rly_big",
      op: "message",
      from_machine: "development",
      to_machine: "training",
      source: "antigravity/desktop/a",
      recipients: ["codex/desktop/b"],
      body: "A".repeat(1850),
    }, { maxFrameChars: 1800 }),
    (err) => err instanceof RelayError && err.code === "RELAY_FRAME_TOO_LARGE" && err.details?.suggest_file_bundle === true,
  );

  // all_recipients 全名单公开校验：哪怕本机只发 1 人，但 all_recipients 有 2 人且路线禁止公开则拒发
  assert.throws(
    () => validateRecipientDisclosure(
      { relay_key: "qq-lab-v1", allow_recipient_list_disclosure: false },
      {
        recipients: ["codex/desktop/only-one-on-lab"],
        all_recipients: ["codex/desktop/only-one-on-lab", "antigravity/desktop/other-machine"],
      },
    ),
    (err) => err instanceof RelayError && err.code === "RELAY_RECIPIENT_DISCLOSURE_BLOCKED",
  );

  // 2段地址仅限三宿主（antigravity/codex/windsurf），其它宿主如 claude-code/system 必须 3 段
  assert.throws(
    () => encodeRelayFrame({
      relay_id: "rly_bad_2seg",
      op: "message",
      from_machine: "development",
      to_machine: "training",
      source: "claude-code/conv-only-2",
      recipients: ["codex/desktop/b"],
      body: "should reject",
    }),
    (err) => err instanceof RelayError && err.code === "RELAY_INVALID_ARGUMENT",
  );
  const encoded3Seg = encodeRelayFrame({
    relay_id: "rly_ok_3seg",
    op: "file_notice",
    from_machine: "development",
    to_machine: "training",
    source: "system/napcat-file-bundle/development",
    recipients: ["claude-code/cli/conv-3seg"],
    body: "{\"v\":1}",
  });
  const decoded3Seg = decodeRelayFrame(encoded3Seg);
  assert.ok(decoded3Seg && !decoded3Seg.malformed);
  assert.equal(decoded3Seg.source, "system/napcat-file-bundle/development");
  assert.deepEqual(decoded3Seg.recipients, ["claude-code/cli/conv-3seg"]);

  // fingerprint 稳定性
  const fp1 = computeRelaySendFingerprint({ a: 1, b: { y: 2, x: 3 } });
  const fp2 = computeRelaySendFingerprint({ b: { x: 3, y: 2 }, a: 1 });
  assert.equal(fp1, fp2);
});

test("3. relay-service & state: send idempotency, dedupe conflict, drain reply routing, rate limit retry_after_ms, poll auth & isolated route gaps", async (t) => {
  const dir = makeTempDir(t);
  const bindingPath = path.join(dir, "binding.json");
  const relayPath = path.join(dir, "relay-groups.json");
  const statePath = path.join(dir, "state", "comm-relay-state.json");
  const dedupeStatePath = path.join(dir, "state", "dedupe.json");
  writeJson(bindingPath, baseBinding());
  const relayCfg = baseRelayGroups();
  relayCfg.limits.max_sends_per_minute_per_group = 3;
  writeJson(relayPath, relayCfg);

  const mock = await createMockOneBotServer(t);
  const isolatedEnv = {
    NAPCAT_HTTP_URL: mock.baseUrl,
    NAPCAT_ACCESS_TOKEN: "",
    NAPCAT_ALLOW_EMPTY_TOKEN: "1",
    NAPCAT_MCP_BINDING_PATH: bindingPath,
    NAPCAT_MCP_STATE_PATH: dedupeStatePath,
  };
  const notifier = createNapCatNotifier({
    cwd: dir,
    env: isolatedEnv,
  });
  const service = createNapCatRelayService({
    notifier,
    statePath,
    relayGroupsPath: relayPath,
    env: isolatedEnv,
  });

  // 3a. status
  const st = await service.relayStatus({ include_live_check: true });
  assert.equal(st.local_machine_id, "development");
  assert.ok(Array.isArray(st.routes) && st.routes.length === 3);

  // 3b. send -> sent_verified & body_sha256 + inspectSendRecord
  const expectedBodySha = createHash("sha256").update("Hello from dev!", "utf8").digest("hex");
  const send1 = await service.relaySend({
    dedupe_key: "dk-001",
    target_machine: "training",
    op: "message",
    source: "antigravity/desktop/1a5df4f4",
    recipients: ["codex/desktop/019f9012"],
    body: "Hello from dev!",
  });
  assert.equal(send1.status, "sent_verified");
  assert.equal(send1.transport_stage, "group_received");
  assert.equal(send1.relay_key, "qq-training-v2");
  assert.equal(send1.group_id, "910002");
  assert.equal(send1.route_generation, 2);
  assert.equal(send1.body_sha256, expectedBodySha);
  const inspected1 = service.inspectSendRecord("dk-001");
  assert.equal(inspected1?.body_sha256, expectedBodySha);
  assert.equal(inspected1?.status, "sent_verified");

  // 3c. 同 dedupe_key 同载荷 -> duplicate 绝不重发且保留 body_sha256
  const sendCountBefore = mock.calls.filter((c) => c.action === "send_group_msg").length;
  const send1Dup = await service.relaySend({
    dedupe_key: "dk-001",
    target_machine: "training",
    op: "message",
    source: "antigravity/desktop/1a5df4f4",
    recipients: ["codex/desktop/019f9012"],
    body: "Hello from dev!",
  });
  assert.equal(send1Dup.status, "duplicate");
  assert.equal(send1Dup.relay_id, send1.relay_id);
  assert.equal(send1Dup.body_sha256, expectedBodySha);
  assert.equal(mock.calls.filter((c) => c.action === "send_group_msg").length, sendCountBefore);

  // 3d. 同 dedupe_key 不同正文 -> RELAY_DEDUPE_CONFLICT
  await assert.rejects(
    () => service.relaySend({
      dedupe_key: "dk-001",
      target_machine: "training",
      op: "message",
      source: "antigravity/desktop/1a5df4f4",
      recipients: ["codex/desktop/019f9012"],
      body: "Tampered body!",
    }),
    (err) => err instanceof RelayError && err.code === "RELAY_DEDUPE_CONFLICT",
  );

  // 3e. 原路回执发到 draining_read 旧群（显式绑定 relay_key + group_id + generation）
  const replyDrain = await service.relaySend({
    dedupe_key: "dk-drain-reply-1",
    target_machine: "training",
    reply_relay_key: "qq-training-v1",
    reply_group_id: "910001",
    reply_route_generation: 1,
    in_reply_to: "rly_old_in_v1",
    op: "delivery_ack",
    source: "antigravity/desktop/1a5df4f4",
    recipients: ["codex/desktop/019f9012"],
    body: "ack on draining route",
  });
  assert.equal(replyDrain.relay_key, "qq-training-v1");
  assert.equal(replyDrain.group_id, "910001");
  assert.equal(replyDrain.route_generation, 1);

  // 原路回执代次错配 -> 拒发
  await assert.rejects(
    () => service.relaySend({
      dedupe_key: "dk-drain-reply-bad",
      target_machine: "training",
      reply_relay_key: "qq-training-v1",
      reply_group_id: "910001",
      reply_route_generation: 99,
      in_reply_to: "rly_old_in_v1",
      op: "delivery_ack",
      source: "antigravity/desktop/1a5df4f4",
      recipients: ["codex/desktop/019f9012"],
      body: "bad gen",
    }),
    (err) => err instanceof RelayError,
  );

  // 3f. 滑窗频控 -> 第 4 次抛 RELAY_RATE_LIMITED 且含 retry_after_ms >= 1
  await service.relaySend({
    dedupe_key: "dk-002", target_machine: "training", op: "status_query",
    source: "antigravity/desktop/a", recipients: ["codex/desktop/b"], body: "q2",
  });
  await service.relaySend({
    dedupe_key: "dk-003", target_machine: "training", op: "status_query",
    source: "antigravity/desktop/a", recipients: ["codex/desktop/b"], body: "q3",
  });
  await assert.rejects(
    () => service.relaySend({
      dedupe_key: "dk-004", target_machine: "training", op: "status_query",
      source: "antigravity/desktop/a", recipients: ["codex/desktop/b"], body: "q4",
    }),
    (err) => err instanceof RelayError && err.code === "RELAY_RATE_LIMITED" && Number(err.details?.retry_after_ms) >= 1,
  );

  // 3g. 入站轮询鉴权：合法 peer、伪造小号、自由文本混入
  const validPeerFrame = encodeRelayFrame({
    relay_id: "rly_peer_001",
    op: "status_reply",
    from_machine: "training",
    to_machine: "development",
    source: "codex/desktop/019f9012",
    recipients: ["antigravity/desktop/1a5df4f4"],
    body: "training online!",
  });
  const spoofedPeerFrame = encodeRelayFrame({
    relay_id: "rly_spoof_001",
    op: "message",
    from_machine: "training",
    to_machine: "development",
    source: "codex/desktop/evil",
    recipients: ["antigravity/desktop/1a5df4f4"],
    body: "spoofed sender",
  });
  const labFrame = encodeRelayFrame({
    relay_id: "rly_lab_001",
    op: "message",
    from_machine: "lab",
    to_machine: "development",
    source: "codex/desktop/lab1",
    recipients: ["antigravity/desktop/1a5df4f4"],
    body: "hello from lab",
  });

  mock.pushPeerMessage("910002", "200002", validPeerFrame);
  mock.pushPeerMessage("910002", "999999", spoofedPeerFrame); // unauthorized QQ
  mock.pushPeerMessage("910002", "200002", "普通自由群聊天文本，应该被忽略");
  mock.pushPeerMessage("920001", "300003", labFrame);

  const poll = await service.relayPoll({});
  assert.equal(poll.ingested_count, 2);

  // 3h. 游标读取与作用域隔离校验
  const readV2 = await service.relayEventsRead({ relay_key: "qq-training-v2", limit: 10 });
  assert.equal(readV2.events.length, 1);
  assert.equal(readV2.events[0].sender_id, "200002");
  assert.equal(readV2.events[0].source_machine, "training");
  assert.equal(readV2.events[0].relay_key, "qq-training-v2");
  assert.equal(readV2.events[0].route_generation, 2);
  assert.equal(readV2.events[0].frame.body, "training online!");
  assert.ok(readV2.next_cursor);

  // 拿 qq-training-v2 游标去查 qq-lab-v1 -> RELAY_CURSOR_SCOPE_MISMATCH
  await assert.rejects(
    () => service.relayEventsRead({ relay_key: "qq-lab-v1", cursor: readV2.next_cursor }),
    (err) => err instanceof RelayError && err.code === "RELAY_CURSOR_SCOPE_MISMATCH",
  );

  // 3i. 分群隔离断档：只淘汰 route A，绝不影响 route B 独立读取
  const tinyStatePath = path.join(dir, "state", "tiny-relay-state.json");
  const tinyStore = createRelayStateStore({
    statePath: tinyStatePath,
    maxCacheBytes: 1024 * 1024,
    maxEventsPerRoute: 2,
    maxGlobalEvents: 10,
  });
  const mkEvt = (rk, gid, gen, idx) => ({
    event_id: createHash("sha256").update(`${rk}:${idx}`).digest("hex"),
    relay_key: rk,
    group_id: gid,
    route_generation: gen,
    sender_id: "200002",
    source_machine: "training",
    received_at: "2026-11-27T06:50:00.000Z",
    frame: { relay_id: `r_${rk}_${idx}`, op: "message", body: `msg-${idx}` },
  });
  tinyStore.ingestRouteEvents({
    relay_key: "route-a",
    group_id: "910002",
    route_generation: 2,
    bootstrap_at: "2026-11-26T00:00:00Z",
    events: [mkEvt("route-a", "910002", 2, 1), mkEvt("route-a", "910002", 2, 2), mkEvt("route-a", "910002", 2, 3)],
  });
  tinyStore.ingestRouteEvents({
    relay_key: "route-b",
    group_id: "920001",
    route_generation: 1,
    bootstrap_at: "2026-11-26T00:00:00Z",
    events: [mkEvt("route-b", "920001", 1, 1)],
  });
  // route-a 已有淘汰 -> 首次读报 RELAY_HISTORY_EXPIRED 且附 route-a 精确明细
  assert.throws(
    () => tinyStore.readEvents({ local_machine_id: "development", expected_self_id: "100001", relay_key: "route-a" }),
    (err) => err instanceof RelayError
      && err.code === "RELAY_HISTORY_EXPIRED"
      && err.details?.relay_key === "route-a"
      && err.details?.evicted_through === 1
      && err.details?.affected_only_route === true,
  );
  // route-b 毫发无损照常读取！
  const readB = tinyStore.readEvents({ local_machine_id: "development", expected_self_id: "100001", relay_key: "route-b" });
  assert.equal(readB.events.length, 1);
  assert.equal(readB.events[0].frame.body, "msg-1");
});

test("4. MCP Stdio end-to-end: 37 legacy + 4 relay tools intact, full roundtrip & zero residual lock/tmp", async (t) => {
  const dir = makeTempDir(t);
  const bindingPath = path.join(dir, "binding.json");
  const relayPath = path.join(dir, "relay-groups.json");
  const relayStatePath = path.join(dir, "state", "comm-relay-state.json");
  const controlStatePath = path.join(dir, "state", "control-state.json");
  const taskRegPath = path.join(dir, "state", "task-registry.json");
  const dedupePath = path.join(dir, "state", "dedupe.json");
  writeJson(bindingPath, baseBinding());
  writeJson(relayPath, baseRelayGroups());
  const bindingHashBefore = sha256File(bindingPath);

  const mock = await createMockOneBotServer(t);
  const peerMsg = encodeRelayFrame({
    relay_id: "rly_stdio_in_1",
    op: "message",
    from_machine: "training",
    to_machine: "development",
    source: "codex/desktop/019f9012",
    recipients: ["antigravity/desktop/1a5df4f4"],
    body: "stdio end-to-end ping",
  });
  mock.pushPeerMessage("910002", "200002", peerMsg);

  const child = spawn(process.execPath, [path.resolve("src/index.mjs")], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      NAPCAT_HTTP_URL: mock.baseUrl,
      NAPCAT_ACCESS_TOKEN: "",
      NAPCAT_ALLOW_EMPTY_TOKEN: "1",
      NAPCAT_MCP_BINDING_PATH: bindingPath,
      NAPCAT_MCP_STATE_PATH: dedupePath,
      NAPCAT_TASK_REGISTRY_PATH: taskRegPath,
      NAPCAT_CONTROL_STATE_PATH: controlStatePath,
      NAPCAT_RELAY_GROUPS_PATH: relayPath,
      NAPCAT_RELAY_STATE_PATH: relayStatePath,
      NAPCAT_TASK_ROUTER_AUTOSTART: "0",
      NAPCAT_RELAY_TRUSTED_CORE_ENTRYPOINT: "1",
    },
  });

  let stdoutBuf = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  t.after(() => {
    try { child.stdin.end(); } catch {}
    try { child.kill(); } catch {}
  });

  let rpcId = 0;
  function rpc(method, params) {
    rpcId += 1;
    const id = rpcId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 10000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "relay-test", version: "1.0.0" },
  });
  assert.ok(init.result?.serverInfo);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const listResp = await rpc("tools/list", {});
  const names = listResp.result.tools.map((x) => x.name);
  assert.equal(names.length, 41); // 37 legacy + 4 relay
  for (const required of ["napcat_relay_status", "napcat_relay_send", "napcat_relay_poll", "napcat_relay_events_read"]) {
    assert.ok(names.includes(required), `missing ${required}`);
  }

  const callTool = async (name, args) => {
    const resp = await rpc("tools/call", { name, arguments: args });
    return JSON.parse(resp.result.content[0].text);
  };

  const st = await callTool("napcat_relay_status", { include_live_check: true });
  assert.equal(st.ok, true);
  assert.equal(st.local_machine_id, "development");

  const sent = await callTool("napcat_relay_send", {
    dedupe_key: "stdio-dk-1",
    target_machine: "training",
    op: "message",
    source: "antigravity/desktop/1a5df4f4",
    recipients: ["codex/desktop/019f9012"],
    body: "stdio outbound ok",
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.status, "sent_verified");
  assert.equal(sent.body_sha256, createHash("sha256").update("stdio outbound ok", "utf8").digest("hex"));

  const polled = await callTool("napcat_relay_poll", {});
  assert.equal(polled.ok, true);
  assert.equal(polled.ingested_count, 1);

  const evts = await callTool("napcat_relay_events_read", { relay_key: "qq-training-v2" });
  assert.equal(evts.ok, true);
  assert.equal(evts.events.length, 1);
  assert.equal(evts.events[0].frame.body, "stdio end-to-end ping");
  assert.ok(evts.events[0].onebot_message_id);

  // 未知参数键必须被严格白名单拒绝并走 knownError
  const badArg = await callTool("napcat_relay_status", { unknown_key: 1 });
  assert.equal(badArg.ok, false);
  assert.notEqual(badArg.code, "UNEXPECTED_ERROR");

  // 严守零触碰旧账本与 binding.json，零 .tmp / .lock 残留
  assert.equal(sha256File(bindingPath), bindingHashBefore);
  assert.equal(fs.existsSync(controlStatePath), false);
  assert.equal(fs.existsSync(taskRegPath), false);
  const stateFiles = fs.readdirSync(path.join(dir, "state"));
  assert.equal(stateFiles.some((f) => f.endsWith(".tmp") || f.endsWith(".lock")), false);
});

test("4b. MCP Stdio public broker default-off gate: strictly 37 legacy tools, relay tools invisible & rejected as UNKNOWN_TOOL", async (t) => {
  const dir = makeTempDir(t);
  const bindingPath = path.join(dir, "binding.json");
  const relayPath = path.join(dir, "relay-groups.json");
  const relayStatePath = path.join(dir, "state", "comm-relay-state.json");
  writeJson(bindingPath, baseBinding());
  writeJson(relayPath, baseRelayGroups());
  const mock = await createMockOneBotServer(t);

  const envWithoutTrusted = { ...process.env };
  delete envWithoutTrusted.NAPCAT_RELAY_TRUSTED_CORE_ENTRYPOINT;
  const child = spawn(process.execPath, [path.resolve("src/index.mjs")], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...envWithoutTrusted,
      NAPCAT_HTTP_URL: mock.baseUrl,
      NAPCAT_ACCESS_TOKEN: "",
      NAPCAT_ALLOW_EMPTY_TOKEN: "1",
      NAPCAT_MCP_BINDING_PATH: bindingPath,
      NAPCAT_MCP_STATE_PATH: path.join(dir, "state", "dedupe.json"),
      NAPCAT_TASK_REGISTRY_PATH: path.join(dir, "state", "task-registry.json"),
      NAPCAT_CONTROL_STATE_PATH: path.join(dir, "state", "control-state.json"),
      NAPCAT_RELAY_GROUPS_PATH: relayPath,
      NAPCAT_RELAY_STATE_PATH: relayStatePath,
      NAPCAT_TASK_ROUTER_AUTOSTART: "0",
    },
  });

  let stdoutBuf = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  t.after(() => {
    try { child.stdin.end(); } catch {}
    try { child.kill(); } catch {}
  });

  let rpcId = 0;
  function rpc(method, params) {
    rpcId += 1;
    const id = rpcId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 10000);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pub-test", version: "1.0.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const listResp = await rpc("tools/list", {});
  const names = listResp.result.tools.map((x) => x.name);
  assert.equal(names.length, 37);
  for (const hidden of ["napcat_relay_status", "napcat_relay_send", "napcat_relay_poll", "napcat_relay_events_read"]) {
    assert.equal(names.includes(hidden), false, `${hidden} must not be visible on public broker`);
  }

  const callResp = await rpc("tools/call", { name: "napcat_relay_status", arguments: {} });
  const payload = JSON.parse(callResp.result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "UNKNOWN_TOOL");
  assert.equal(fs.existsSync(relayStatePath), false);
});

test("5. relay-state: dead-PID stale lock self-heal & zero residual tmp/lock files", (t) => {
  const dir = makeTempDir(t);
  const statePath = path.join(dir, "state", "comm-relay-state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  // 写入一个已退出 PID 的死锁文件（模拟进程异常崩溃遗留）
  const lockPath = `${statePath}.lock`;
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: "dead-owner", createdAt: "2026-11-26T00:00:00.000Z" }) + "\n", "utf8");

  const store = createRelayStateStore({ statePath });
  const fp = createHash("sha256").update("dead-lock-test", "utf8").digest("hex");
  const reserved = store.reserveOrCheckSend({
    dedupe_key: "dk-stale-lock",
    fingerprint_sha256: fp,
    body_sha256: fp,
    relay_id: "rly_stale_lock",
    relay_key: "qq-training-v2",
    group_id: "910002",
    route_generation: 2,
    frame_length: 120,
  });
  assert.equal(reserved.duplicate, false);
  assert.equal(reserved.record.body_sha256, fp);
  assert.equal(fs.existsSync(lockPath), false, "stale lock must be healed and cleaned");
  const files = fs.readdirSync(path.dirname(statePath));
  assert.equal(files.some((f) => f.endsWith(".tmp") || f.endsWith(".lock")), false);
});
