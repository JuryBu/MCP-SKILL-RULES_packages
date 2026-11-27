import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { createNapCatNotifier } from "../src/core.mjs";
import {
  RelayError,
  loadAndValidateRelayConfig,
  resolveRelayRoute,
  reverifyFrozenRelayRoute,
  buildSanitizedRelayView,
} from "../src/relay-groups.mjs";
import {
  encodeRelayFrame,
  decodeRelayFrame,
  validateRecipientDisclosure,
  computeRelayBodySha256,
} from "../src/relay-frame.mjs";
import { createRelayStateStore } from "../src/relay-state.mjs";
import { createNapCatRelayService } from "../src/relay-service.mjs";
import { createFileBundleRelayHost } from "../src/relay-file-bundle-bridge.mjs";

function makeTempDir(t, prefix = "napcat-audit-reg-") {
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

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function baseBinding() {
  return {
    schemaVersion: 2,
    expectedSelfId: "100001",
    expectedNickname: "DevBot",
    groupId: "900001",
    groupName: "LegacyTrainingGroup",
    expectedMemberCount: 3,
    controlPlane: {
      enabled: true,
      localMachine: "development",
      defaultTargetKey: "owner_group",
      targets: { owner_group: { type: "group", id: "800001", name: "Members", expectedMemberCount: 3 } },
    },
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
        expected_member_count: 5,
        generation: 2,
        enabled: true,
        role: "active_write",
        target_machines: ["training"],
        allowed_peers: ["training"],
        allow_recipient_list_disclosure: true,
        bootstrap_at: "2026-11-26T00:00:00.000Z",
        verify_member_count: true,
      },
      "qq-training-expired": {
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
        drain_until: "2020-01-01T00:00:00.000Z",
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

function createMockOneBot(t, hooks = {}) {
  const groups = new Map(Object.entries(hooks.groups || {
    "910002": { group_id: 910002, group_name: "RelayV2", member_count: 5 },
    "910001": { group_id: 910001, group_name: "RelayV1", member_count: 4 },
    "920001": { group_id: 920001, group_name: "RelayLab", member_count: 3 },
  }));
  const histories = new Map();
  let nextMsgId = 60000;
  let nextSeq = 200;
  const calls = [];

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const action = req.url.replace(/^\//, "");
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ action, body });
      const respond = (data, status = "ok", retcode = 0) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status, retcode, data }));
      };
      if (hooks.onAction) {
        const custom = hooks.onAction({ action, body, respond, groups, histories });
        if (custom === true) return;
      }
      if (action === "get_status") return respond({ online: true, good: true });
      if (action === "get_login_info") return respond({ user_id: 100001, nickname: "DevBot" });
      if (action === "get_group_info") {
        const g = groups.get(String(body.group_id));
        return g ? respond(g) : respond(null, "failed", 1404);
      }
      if (action === "send_group_msg") {
        const gid = String(body.group_id);
        nextMsgId += 1;
        nextSeq += 1;
        const text = Array.isArray(body.message)
          ? body.message.map((s) => (s?.type === "text" ? String(s.data?.text ?? "") : "")).join("")
          : String(body.message ?? "");
        const rec = {
          message_id: nextMsgId,
          message_seq: nextSeq,
          real_seq: String(nextSeq),
          group_id: Number(gid),
          user_id: 100001,
          sender: { user_id: 100001, nickname: "DevBot" },
          time: Math.floor(Date.now() / 1000),
          post_type: "message_sent",
          raw_message: text,
          message: Array.isArray(body.message) ? body.message : [{ type: "text", data: { text } }],
        };
        const arr = histories.get(gid) || [];
        arr.push(rec);
        histories.set(gid, arr);
        return respond({ message_id: nextMsgId });
      }
      if (action === "get_msg") {
        for (const arr of histories.values()) {
          const hit = arr.find((m) => String(m.message_id) === String(body.message_id));
          if (hit) return respond(hit);
        }
        return respond(null, "failed", 1404);
      }
      if (action === "get_group_msg_history") {
        const gid = String(body.group_id);
        const arr = histories.get(gid) || [];
        const count = Number(body.count || 50);
        const seqCursor = body.message_seq ? Number(body.message_seq) : null;
        const filtered = seqCursor !== null && Number.isFinite(seqCursor)
          ? arr.filter((m) => Number(m.message_seq) < seqCursor)
          : arr;
        return respond({ messages: filtered.slice(-count) });
      }
      return respond(null, "failed", 1404);
    });
  });

  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(() => r()));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        calls,
        groups,
        histories,
        pushPeerMessage(groupId, senderId, text, { timeSec = Math.floor(Date.now() / 1000), realSeq = null, messageSeq = null } = {}) {
          nextMsgId += 1;
          nextSeq += 1;
          const seq = messageSeq ?? nextSeq;
          const rseq = realSeq ?? seq;
          const rec = {
            message_id: nextMsgId,
            message_seq: seq,
            real_seq: String(rseq),
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

test("Audit-1 (P0-1 & P0-2): status routes satisfy core projectRelayRoutesForAddressBook; frame bidirectional compat with core relay-envelope (empty body, meta:{}, 4-seg all_recipients)", async (t) => {
  const dir = makeTempDir(t);
  const bindingPath = path.join(dir, "binding.json");
  const relayPath = path.join(dir, "relay-groups.json");
  writeJson(bindingPath, baseBinding());
  writeJson(relayPath, baseRelayGroups());

  const cfg = loadAndValidateRelayConfig({ bindingPath, relayGroupsPath: relayPath });
  const sanitized = buildSanitizedRelayView(cfg);
  for (const r of sanitized.routes) {
    assert.equal(r.local_machine_id, "development");
    assert.equal(r.expected_self_id, "100001");
    assert.ok(r.peer_machine_id, `route ${r.relay_key} missing peer_machine_id`);
    assert.ok(r.peer_qq_id, `route ${r.relay_key} missing peer_qq_id`);
  }

  // 若同级或环境变量提供 communication-core/src，直接用其真实导出做跨模块字节级实测
  const coreRoot = process.env.COMM_CORE_SRC_DIR || path.resolve("..", "communication-core", "src");
  if (fs.existsSync(path.join(coreRoot, "relay-envelope.mjs")) && fs.existsSync(path.join(coreRoot, "transports", "napcat-relay.mjs"))) {
    const [{ encodeRelayFrame: coreEncode, decodeRelayFrame: coreDecode }, { projectRelayRoutesForAddressBook }] = await Promise.all([
      import(pathToFileURL(path.join(coreRoot, "relay-envelope.mjs")).href),
      import(pathToFileURL(path.join(coreRoot, "transports", "napcat-relay.mjs")).href),
    ]);

    const projected = projectRelayRoutesForAddressBook(sanitized);
    assert.equal(projected.length, 3);
    assert.equal(projected.find((x) => x.group_id === "910002")?.account_id, "200002");

    // 1) 空正文 + 缺省 meta：A 编 -> Core 解 & Core 编 -> A 解
    const aEmpty = encodeRelayFrame({
      relay_id: "rly_empty_1",
      op: "status_query",
      from_machine: "development",
      to_machine: "training",
      source: "antigravity/desktop/a1",
      recipients: ["codex/desktop/b1"],
      body: "",
    });
    assert.ok(aEmpty.includes("\nmeta: {}\n---\n[END_COMM_RELAY_V1]"));
    const coreDecodedA = coreDecode(aEmpty);
    assert.equal(coreDecodedA.ok, true, `core decode failed: ${JSON.stringify(coreDecodedA)}`);
    assert.equal(coreDecodedA.frame.body, "");

    const coreEmpty = coreEncode({
      relay_id: "rly_empty_2",
      op: "status_query",
      from_machine: "training",
      to_machine: "development",
      source: "codex/desktop/b1",
      recipients: ["antigravity/desktop/a1"],
      body: "",
    });
    const aDecodedCore = decodeRelayFrame(coreEmpty.frameText);
    assert.ok(aDecodedCore && !aDecodedCore.malformed, `A decode failed: ${JSON.stringify(aDecodedCore)}`);
    assert.equal(aDecodedCore.body, "");
  }

  // 4 段式 meta.all_recipients 校验通过且触发公开名单策略
  const okDisclosure = validateRecipientDisclosure(
    { relay_key: "qq-training-v2", allow_recipient_list_disclosure: true },
    {
      recipients: ["codex/desktop/019f9012"],
      all_recipients: ["training/codex/desktop/019f9012", "development/antigravity/desktop/1a5df4f4"],
    },
  );
  assert.equal(okDisclosure.disclosed, true);
  assert.throws(
    () => validateRecipientDisclosure(
      { relay_key: "qq-lab-v1", allow_recipient_list_disclosure: false },
      {
        recipients: ["codex/desktop/lab1"],
        all_recipients: ["lab/codex/desktop/lab1", "training/codex/desktop/019f9012"],
      },
    ),
    (err) => err instanceof RelayError && err.code === "RELAY_RECIPIENT_DISCLOSURE_BLOCKED",
  );
});

test("Audit-2 (P0-6 / B P0-1, B P0-2, A P0-4 / B P0-3): text-segment send_group_msg, oversized single event keeps state valid, drain_until expired & ROUTE_CHANGED", async (t) => {
  const dir = makeTempDir(t);
  const bindingPath = path.join(dir, "binding.json");
  const relayPath = path.join(dir, "relay-groups.json");
  const statePath = path.join(dir, "state", "comm-relay-state.json");
  writeJson(bindingPath, baseBinding());
  writeJson(relayPath, baseRelayGroups());

  const mock = await createMockOneBot(t);
  const env = {
    NAPCAT_HTTP_URL: mock.baseUrl,
    NAPCAT_ACCESS_TOKEN: "",
    NAPCAT_ALLOW_EMPTY_TOKEN: "1",
    NAPCAT_MCP_BINDING_PATH: bindingPath,
    NAPCAT_MCP_STATE_PATH: path.join(dir, "state", "dedupe.json"),
  };
  const notifier = createNapCatNotifier({ cwd: dir, env });
  const service = createNapCatRelayService({ notifier, statePath, relayGroupsPath: relayPath, env });

  // 1) send_group_msg 必须发送 text segment 数组，正文含 [CQ:at,qq=123] &amp; + 4 段 all_recipients 全通过
  const sent = await service.relaySend({
    dedupe_key: "dk-cq-safe",
    target_machine: "training",
    op: "message",
    source: "antigravity/desktop/1a5df4f4",
    recipients: ["codex/desktop/019f9012"],
    meta: { all_recipients: ["training/codex/desktop/019f9012", "development/antigravity/desktop/1a5df4f4"] },
    body: "hello [CQ:at,qq=123] &amp; world",
  });
  assert.equal(sent.status, "sent_verified");
  const sendCall = mock.calls.find((c) => c.action === "send_group_msg");
  assert.ok(Array.isArray(sendCall.body.message), "send_group_msg must pass segment array, never raw string");
  assert.equal(sendCall.body.message[0].type, "text");

  // 2) drain_until 过期必抛 RELAY_ROUTE_DRAIN_EXPIRED
  await assert.rejects(
    () => service.relaySend({
      dedupe_key: "dk-expired-drain",
      target_machine: "training",
      reply_relay_key: "qq-training-expired",
      reply_group_id: "910001",
      reply_route_generation: 1,
      op: "delivery_ack",
      source: "antigravity/desktop/1a5df4f4",
      recipients: ["codex/desktop/019f9012"],
      body: "too late",
    }),
    (err) => err instanceof RelayError && err.code === "RELAY_ROUTE_DRAIN_EXPIRED",
  );

  // 3) 原路代次不匹配统一抛 RELAY_ROUTE_CHANGED（命中核心死信码）
  await assert.rejects(
    () => service.relaySend({
      dedupe_key: "dk-gen-changed",
      target_machine: "training",
      reply_relay_key: "qq-training-v2",
      reply_group_id: "910002",
      reply_route_generation: 99,
      op: "delivery_ack",
      source: "antigravity/desktop/1a5df4f4",
      recipients: ["codex/desktop/019f9012"],
      body: "wrong gen",
    }),
    (err) => err instanceof RelayError && err.code === "RELAY_ROUTE_CHANGED",
  );

  // 4) 单条超大事件推进 evicted_through 时清空旧事件，账本绝不损坏，且支持显式 resume_from_retained
  const tinyPath = path.join(dir, "state", "tiny-oversize.json");
  const tiny = createRelayStateStore({ statePath: tinyPath, maxCacheBytes: 600, maxEventsPerRoute: 10, maxGlobalEvents: 10 });
  const mk = (idx, body) => ({
    event_id: createHash("sha256").update(`ov:${idx}`).digest("hex"),
    relay_key: "route-ov",
    group_id: "910002",
    route_generation: 2,
    sender_id: "200002",
    source_machine: "training",
    received_at: "2026-11-26T10:00:00.000Z",
    frame: { relay_id: `r_${idx}`, op: "message", body },
  });
  tiny.ingestRouteEvents({ relay_key: "route-ov", group_id: "910002", route_generation: 2, bootstrap_at: "2026-11-26T00:00:00Z", events: [mk(1, "small")] });
  tiny.ingestRouteEvents({ relay_key: "route-ov", group_id: "910002", route_generation: 2, bootstrap_at: "2026-11-26T00:00:00Z", events: [mk(2, "X".repeat(700))] });
  const summary = tiny.getRetentionSummary();
  assert.equal(summary.routes["route-ov"].evicted_through, 2);
  assert.equal(summary.routes["route-ov"].retained_count, 0);
  tiny.ingestRouteEvents({ relay_key: "route-ov", group_id: "910002", route_generation: 2, bootstrap_at: "2026-11-26T00:00:00Z", events: [mk(3, "fresh")] });
  // 默认 fail-closed 报 RELAY_HISTORY_EXPIRED，显式 resume_from_retained=true 恢复读到 seq=3
  assert.throws(
    () => tiny.readEvents({ local_machine_id: "development", expected_self_id: "100001", relay_key: "route-ov" }),
    (err) => err instanceof RelayError && err.code === "RELAY_HISTORY_EXPIRED",
  );
  const resumed = tiny.readEvents({ local_machine_id: "development", expected_self_id: "100001", relay_key: "route-ov", resume_from_retained: true });
  assert.equal(resumed.events.length, 1);
  assert.equal(resumed.events[0].frame.body, "fresh");
});

test("Audit-3 (P0-3, P1-1..P1-8): verify_member_count strict, inspectPinnedControl reconciles sent_unverified, no fake hash, hot config reverify, poll isolation & early stop, gap clear, route gen bucket isolation & {} lock heal", async (t) => {
  const dir = makeTempDir(t);
  const bindingPath = path.join(dir, "binding.json");
  const relayPath = path.join(dir, "relay-groups.json");
  const statePath = path.join(dir, "state", "comm-relay-state.json");
  writeJson(bindingPath, baseBinding());
  writeJson(relayPath, baseRelayGroups());

  let failGetMsgOnce = false;
  const mock = await createMockOneBot(t, {
    onAction: ({ action, respond }) => {
      if (action === "get_msg" && failGetMsgOnce) {
        failGetMsgOnce = false;
        respond(null, "failed", 1500);
        return true;
      }
      return false;
    },
  });
  const env = {
    NAPCAT_HTTP_URL: mock.baseUrl,
    NAPCAT_ACCESS_TOKEN: "",
    NAPCAT_ALLOW_EMPTY_TOKEN: "1",
    NAPCAT_MCP_BINDING_PATH: bindingPath,
    NAPCAT_MCP_STATE_PATH: path.join(dir, "state", "dedupe.json"),
  };
  const notifier = createNapCatNotifier({ cwd: dir, env });
  const service = createNapCatRelayService({ notifier, statePath, relayGroupsPath: relayPath, env });
  const host = createFileBundleRelayHost({ notifier, relayService: service, relayGroupsPath: relayPath, env });

  // 1) verify_member_count: true 真实生效（不再 fail-open）
  const cfg = loadAndValidateRelayConfig({ bindingPath, relayGroupsPath: relayPath });
  const frozen = resolveRelayRoute(cfg, { target_machine: "training", channel: "qq", mode: "write" });
  assert.equal(frozen.expected_member_count, 5);
  assert.equal(await host.verifyLiveRoute(frozen, "prepare"), true);
  mock.groups.set("910002", { group_id: 910002, group_name: "RelayV2", member_count: 999 });
  assert.equal(await host.verifyLiveRoute(frozen, "prepare"), false);
  mock.groups.set("910002", { group_id: 910002, group_name: "RelayV2", member_count: 5 });

  // 2) sent_unverified -> inspectPinnedControl 通过只读群历史自愈升级为 sent_verified，且不重发
  failGetMsgOnce = true;
  const sendCountBefore = mock.calls.filter((c) => c.action === "send_group_msg").length;
  const firstSend = await host.sendPinnedControl(frozen, {
    dedupe_key: "dk-reconcile-1",
    target_machine: "training",
    channel: "qq",
    op: "file_notice",
    source: "system/napcat-file-bundle/development",
    recipients: ["system/napcat-file-bundle/training"],
    body: "{\"v\":1,\"id\":\"reconcile\"}",
  }, { requireFileBundleWrite: true });
  assert.equal(firstSend.status, "sent_unverified");
  assert.equal(firstSend.outcome_unknown, true);
  const inspected = await host.inspectPinnedControl(frozen, {
    dedupe_key: "dk-reconcile-1",
    body: "{\"v\":1,\"id\":\"reconcile\"}",
  });
  assert.equal(inspected.status, "sent_verified");
  assert.equal(inspected.outcome_unknown, false);
  assert.equal(inspected.body_sha256, computeRelayBodySha256("{\"v\":1,\"id\":\"reconcile\"}"));
  assert.equal(mock.calls.filter((c) => c.action === "send_group_msg").length, sendCountBefore + 1);

  // 3) 热改关闭 allow_recipient_list_disclosure 后，持旧 frozen 调 sendPinnedControl 立即拒发
  const cfgNoDisclose = baseRelayGroups();
  cfgNoDisclose.relays["qq-training-v2"].allow_recipient_list_disclosure = false;
  writeJson(relayPath, cfgNoDisclose);
  const blockedSend = await host.sendPinnedControl(frozen, {
    dedupe_key: "dk-hot-blocked",
    target_machine: "training",
    channel: "qq",
    op: "file_notice",
    source: "system/napcat-file-bundle/development",
    recipients: ["system/napcat-file-bundle/training"],
    body: "{\"v\":1}",
  }, { requireFileBundleWrite: true, requireRecipientListDisclosure: true });
  assert.equal(blockedSend.status, "not_sent");
  assert.equal(blockedSend.reason, "RELAY_RECIPIENT_DISCLOSURE_BLOCKED");

  // 4) listScopes 过滤冲突路由与过期排空路由
  const cfgWithBad = baseRelayGroups();
  cfgWithBad.relays["qq-bad-human"] = {
    channel: "qq",
    group_id: "800001",
    generation: 1,
    enabled: true,
    role: "active_write",
    target_machines: ["training"],
    allowed_peers: ["training"],
    bootstrap_at: "2026-11-26T00:00:00.000Z",
  };
  writeJson(relayPath, cfgWithBad);
  const scopes = await host.listScopes();
  assert.equal(scopes.some((s) => s.relay_key === "qq-bad-human"), false);
  assert.equal(scopes.some((s) => s.relay_key === "qq-training-expired"), false);
  writeJson(relayPath, baseRelayGroups());

  // 5) max_pages=1 仅 1 条消息不误报 RELAY_HISTORY_GAP；且多群轮询中单群失败不连坐其余健康群
  const peerMsg = encodeRelayFrame({
    relay_id: "rly_poll_ok_1",
    op: "message",
    from_machine: "training",
    to_machine: "development",
    source: "codex/desktop/019f9012",
    recipients: ["antigravity/desktop/1a5df4f4"],
    body: "poll isolate test",
  });
  mock.pushPeerMessage("910002", "200002", peerMsg);
  // 破坏 qq-lab-v1 群信息使其核验失败
  mock.groups.delete("920001");
  const pollRes = await service.relayPoll({ max_pages: 1 });
  assert.equal(pollRes.ingested_count, 1);
  assert.equal(pollRes.history_gaps.length, 0, "1 message with max_pages=1 must not report false history_gap");
  const labScan = pollRes.scanned_routes.find((r) => r.relay_key === "qq-lab-v1");
  assert.equal(labScan?.ok, false);
  const v2Scan = pollRes.scanned_routes.find((r) => r.relay_key === "qq-training-v2");
  assert.equal(v2Scan?.ok, true);
  assert.equal(v2Scan?.history_gap, false);

  // 6) 同 relay_key 换群换代次，状态桶自动切离旧事件，不混存跨代事件
  const cfgGen3 = baseRelayGroups();
  cfgGen3.relays["qq-training-v2"].generation = 3;
  cfgGen3.relays["qq-training-v2"].group_id = "910009";
  writeJson(relayPath, cfgGen3);
  mock.groups.set("910009", { group_id: 910009, group_name: "RelayV2", member_count: 5 });
  const peerGen3 = encodeRelayFrame({
    relay_id: "rly_gen3_1",
    op: "message",
    from_machine: "training",
    to_machine: "development",
    source: "codex/desktop/019f9012",
    recipients: ["antigravity/desktop/1a5df4f4"],
    body: "hello gen3",
  });
  mock.pushPeerMessage("910009", "200002", peerGen3);
  await service.relayPoll({ relay_keys: ["qq-training-v2"] });
  const pageGen3 = await host.readVerifiedPage({ relay_key: "qq-training-v2", group_id: "910009", route_generation: 3, cursor: null, limit: 12 });
  assert.equal(pageGen3.events.length, 1);
  assert.equal(pageGen3.events[0].route_generation, 3);
  assert.equal(pageGen3.events[0].group_id, "910009");

  // 7) 无 pid 空 JSON `{}` 旧锁自愈
  const emptyLockStatePath = path.join(dir, "state", "empty-lock.json");
  const emptyLockFile = `${emptyLockStatePath}.lock`;
  fs.writeFileSync(emptyLockFile, "{}\n", "utf8");
  const past = new Date(Date.now() - 10_000);
  fs.utimesSync(emptyLockFile, past, past);
  const healedStore = createRelayStateStore({ statePath: emptyLockStatePath });
  assert.ok(healedStore.getRetentionSummary());
  assert.equal(fs.existsSync(emptyLockFile), false);
});

test("Audit-4 (A P0-5, B P2-6 & Handle Hygiene): index.mjs default relay state falls in dataRoot/state (not CodeRoot), public broker hides all 4 tools & zero leaked handles", async (t) => {
  const resourcesBefore = new Set(process.getActiveResourcesInfo ? process.getActiveResourcesInfo() : []);
  const dir = makeTempDir(t);
  const bindingPath = path.join(dir, "binding.json");
  const relayPath = path.join(dir, "relay-groups.json");
  writeJson(bindingPath, baseBinding());
  writeJson(relayPath, baseRelayGroups());
  const mock = await createMockOneBot(t);

  // 不传 NAPCAT_RELAY_STATE_PATH，验证默认落盘在 path.dirname(bindingPath)/state/comm-relay-state.json
  const envClean = { ...process.env };
  delete envClean.NAPCAT_RELAY_STATE_PATH;
  delete envClean.NAPCAT_TASK_REGISTRY_PATH;
  delete envClean.NAPCAT_RELAY_FILE_BUNDLE_TRUSTED_CORE_ENABLED;

  const child = spawn(process.execPath, [path.resolve("src/index.mjs")], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...envClean,
      NAPCAT_HTTP_URL: mock.baseUrl,
      NAPCAT_ACCESS_TOKEN: "",
      NAPCAT_ALLOW_EMPTY_TOKEN: "1",
      NAPCAT_MCP_BINDING_PATH: bindingPath,
      NAPCAT_MCP_STATE_PATH: path.join(dir, "state", "dedupe.json"),
      NAPCAT_RELAY_GROUPS_PATH: relayPath,
      NAPCAT_TASK_ROUTER_AUTOSTART: "0",
      NAPCAT_RELAY_TRUSTED_CORE_ENTRYPOINT: "1",
    },
  });
  let buf = "";
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  t.after(() => { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} });
  let seq = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout ${method}`)); }, 10000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "audit4", version: "1.0.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const resp = await rpc("tools/call", {
    name: "napcat_relay_send",
    arguments: {
      dedupe_key: "audit4-dk-1",
      target_machine: "training",
      op: "message",
      source: "antigravity/desktop/a1",
      recipients: ["codex/desktop/b1"],
      body: "default state path check",
    },
  });
  const payload = JSON.parse(resp.result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.status, "sent_verified");
  assert.equal(fs.existsSync(path.join(dir, "state", "comm-relay-state.json")), true, "default relay state must live under dataRoot/state");
  assert.equal(fs.existsSync(path.resolve("state", "comm-relay-state.json")), false, "relay state must never leak into CodeRoot/state");

  // Node 24 资源句柄卫生检查：不遗留额外定时器
  const afterTimers = (process.getActiveResourcesInfo ? process.getActiveResourcesInfo() : []).filter((r) => r === "Timeout");
  const beforeTimers = [...resourcesBefore].filter((r) => r === "Timeout");
  assert.ok(afterTimers.length <= beforeTimers.length + 2);
});

test("Audit-5 (B P2-6 coverage): abortPendingSend rollback, send_group_msg network error outcomeUnknown without resend, >50 multi-page poll, fair multi-route eviction, public broker rejects all 4 relay tools & concurrent lock writes", async (t) => {
  const dir = makeTempDir(t);
  const bindingPath = path.join(dir, "binding.json");
  const relayPath = path.join(dir, "relay-groups.json");
  const statePath = path.join(dir, "state", "comm-relay-state.json");
  writeJson(bindingPath, baseBinding());
  writeJson(relayPath, baseRelayGroups());

  let failSendOnce = false;
  const mock = await createMockOneBot(t, {
    onAction: ({ action, respond }) => {
      if (action === "send_group_msg" && failSendOnce) {
        failSendOnce = false;
        respond(null, "failed", 1500);
        return true;
      }
      return false;
    },
  });
  const env = {
    NAPCAT_HTTP_URL: mock.baseUrl,
    NAPCAT_ACCESS_TOKEN: "",
    NAPCAT_ALLOW_EMPTY_TOKEN: "1",
    NAPCAT_MCP_BINDING_PATH: bindingPath,
    NAPCAT_MCP_STATE_PATH: path.join(dir, "state", "dedupe.json"),
  };
  const notifier = createNapCatNotifier({ cwd: dir, env });
  const service = createNapCatRelayService({ notifier, statePath, relayGroupsPath: relayPath, env });

  // 1) 前置群身份核验失败 -> 回滚 abortPendingSend，不留 pending_send，修复后同 dedupe_key 可成功发送
  mock.groups.set("910002", { group_id: 910002, group_name: "WrongName", member_count: 5 });
  await assert.rejects(
    () => service.relaySend({
      dedupe_key: "dk-abort-rollback",
      target_machine: "training",
      op: "message",
      source: "antigravity/desktop/a1",
      recipients: ["codex/desktop/b1"],
      body: "before fix",
    }),
    (err) => err instanceof RelayError && err.outcomeUnknown === false,
  );
  mock.groups.set("910002", { group_id: 910002, group_name: "RelayV2", member_count: 5 });
  const afterFix = await service.relaySend({
    dedupe_key: "dk-abort-rollback",
    target_machine: "training",
    op: "message",
    source: "antigravity/desktop/a1",
    recipients: ["codex/desktop/b1"],
    body: "before fix",
  });
  assert.equal(afterFix.status, "sent_verified");

  // 2) send_group_msg 抛网络/接口错误 -> outcomeUnknown: true 且同 dedupe_key 绝不自动重发
  failSendOnce = true;
  const sendCallsBefore = mock.calls.filter((c) => c.action === "send_group_msg").length;
  await assert.rejects(
    () => service.relaySend({
      dedupe_key: "dk-net-unknown",
      target_machine: "training",
      op: "message",
      source: "antigravity/desktop/a1",
      recipients: ["codex/desktop/b1"],
      body: "network blip",
    }),
    (err) => err instanceof RelayError && err.outcomeUnknown === true,
  );
  const retryUnknown = await service.relaySend({
    dedupe_key: "dk-net-unknown",
    target_machine: "training",
    op: "message",
    source: "antigravity/desktop/a1",
    recipients: ["codex/desktop/b1"],
    body: "network blip",
  });
  assert.equal(retryUnknown.outcome_unknown, true);
  assert.equal(mock.calls.filter((c) => c.action === "send_group_msg").length, sendCallsBefore + 1);

  // 3) 多页翻页（65 条 > 单页 50 条）两页完整拉取且严格升序
  const baseTime = Math.floor(Date.now() / 1000) + 10;
  for (let i = 1; i <= 65; i += 1) {
    const f = encodeRelayFrame({
      relay_id: `rly_mp_${i}`,
      op: "message",
      from_machine: "training",
      to_machine: "development",
      source: "codex/desktop/019f9012",
      recipients: ["antigravity/desktop/1a5df4f4"],
      body: `msg-${i}`,
    });
    mock.pushPeerMessage("910002", "200002", f, { timeSec: baseTime + i });
  }
  const mpPoll = await service.relayPoll({ relay_keys: ["qq-training-v2"], max_pages: 5 });
  assert.equal(mpPoll.ingested_count, 65);
  assert.equal(mpPoll.history_gaps.length, 0);
  const page1 = await service.relayEventsRead({ relay_key: "qq-training-v2", limit: 50 });
  const page2 = await service.relayEventsRead({ relay_key: "qq-training-v2", cursor: page1.next_cursor, limit: 50 });
  const allBodies = [...page1.events, ...page2.events].map((e) => e.frame.body);
  assert.equal(allBodies.length, 65);
  assert.equal(allBodies[0], "msg-1");
  assert.equal(allBodies[64], "msg-65");

  // 4) 多群字节公平淘汰：洪泛群被优先淘汰，健康小群事件完整保留
  const fairPath = path.join(dir, "state", "fair-evict.json");
  const fairStore = createRelayStateStore({ statePath: fairPath, maxCacheBytes: 3500, maxEventsPerRoute: 100, maxGlobalEvents: 200 });
  const mkEvt = (rk, gid, idx, body) => ({
    event_id: createHash("sha256").update(`${rk}:${idx}`).digest("hex"),
    relay_key: rk,
    group_id: gid,
    route_generation: 1,
    sender_id: "200002",
    source_machine: "training",
    received_at: "2026-11-26T10:00:00.000Z",
    frame: { relay_id: `${rk}_${idx}`, op: "message", body },
  });
  fairStore.ingestRouteEvents({
    relay_key: "quiet-route",
    group_id: "930001",
    route_generation: 1,
    events: [mkEvt("quiet-route", "930001", 1, "keep-me-1"), mkEvt("quiet-route", "930001", 2, "keep-me-2")],
  });
  const floodEvents = [];
  for (let i = 1; i <= 15; i += 1) {
    floodEvents.push(mkEvt("flood-route", "930002", i, "F".repeat(300)));
  }
  fairStore.ingestRouteEvents({
    relay_key: "flood-route",
    group_id: "930002",
    route_generation: 1,
    events: floodEvents,
  });
  const fairSum = fairStore.getRetentionSummary();
  assert.equal(fairSum.routes["quiet-route"].retained_count, 2, "quiet route must survive flood route eviction");
  assert.ok(fairSum.routes["flood-route"].evicted_through > 0, "flood route must be evicted first");

  // 5) 并发锁竞争写入：两个独立 store 实例并发落盘无损且零残留 .lock/.tmp
  const concPath = path.join(dir, "state", "concurrent-lock.json");
  const storeA = createRelayStateStore({ statePath: concPath });
  const storeB = createRelayStateStore({ statePath: concPath });
  await Promise.all([
    Promise.resolve().then(() => {
      for (let i = 0; i < 6; i += 1) {
        storeA.ingestRouteEvents({ relay_key: "r-a", group_id: "940001", route_generation: 1, events: [mkEvt("r-a", "940001", i, `a-${i}`)] });
      }
    }),
    Promise.resolve().then(() => {
      for (let i = 0; i < 6; i += 1) {
        storeB.ingestRouteEvents({ relay_key: "r-b", group_id: "940002", route_generation: 1, events: [mkEvt("r-b", "940002", i, `b-${i}`)] });
      }
    }),
  ]);
  const concSum = storeA.getRetentionSummary();
  assert.equal(concSum.routes["r-a"].retained_count, 6);
  assert.equal(concSum.routes["r-b"].retained_count, 6);
  const leftovers = fs.readdirSync(path.dirname(concPath)).filter((f) => f.endsWith(".lock") || f.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);

  // 6) 公开 broker 默认关闭时，4 个 napcat_relay_* 工具全部不可见且逐一拒答 UNKNOWN_TOOL
  const envPublic = { ...process.env };
  delete envPublic.NAPCAT_RELAY_TRUSTED_CORE_ENTRYPOINT;
  delete envPublic.NAPCAT_RELAY_FILE_BUNDLE_TRUSTED_CORE_ENABLED;
  const pubChild = spawn(process.execPath, [path.resolve("src/index.mjs")], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...envPublic,
      NAPCAT_HTTP_URL: mock.baseUrl,
      NAPCAT_ACCESS_TOKEN: "",
      NAPCAT_ALLOW_EMPTY_TOKEN: "1",
      NAPCAT_MCP_BINDING_PATH: bindingPath,
      NAPCAT_MCP_STATE_PATH: path.join(dir, "state", "dedupe-pub.json"),
      NAPCAT_RELAY_GROUPS_PATH: relayPath,
      NAPCAT_TASK_ROUTER_AUTOSTART: "0",
    },
  });
  let pBuf = "";
  const pMap = new Map();
  pubChild.stdout.setEncoding("utf8");
  pubChild.stdout.on("data", (chunk) => {
    pBuf += chunk;
    let idx;
    while ((idx = pBuf.indexOf("\n")) >= 0) {
      const line = pBuf.slice(0, idx).trim();
      pBuf = pBuf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pMap.has(msg.id)) {
        const { resolve } = pMap.get(msg.id);
        pMap.delete(msg.id);
        resolve(msg);
      }
    }
  });
  t.after(() => { try { pubChild.stdin.end(); } catch {} try { pubChild.kill(); } catch {} });
  let pSeq = 0;
  const pubRpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++pSeq;
    const timer = setTimeout(() => { pMap.delete(id); reject(new Error(`pub RPC timeout ${method}`)); }, 10000);
    pMap.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); } });
    pubChild.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await pubRpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "audit5-pub", version: "1.0.0" } });
  pubChild.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  for (const toolName of ["napcat_relay_status", "napcat_relay_send", "napcat_relay_poll", "napcat_relay_events_read"]) {
    const res = await pubRpc("tools/call", { name: toolName, arguments: {} });
    assert.equal(res.result?.isError, true, `${toolName} must fail on public broker`);
    const body = JSON.parse(res.result.content[0].text);
    assert.equal(body.code, "UNKNOWN_TOOL", `${toolName} must return UNKNOWN_TOOL on public broker`);
  }
});

test("Audit-6 (Round 2 dual-audit fixes): 3/4-seg single recipient dedupe, gap preserved across next anchor poll, read-before-poll gen switch isolation, reconcileSendRecord strict realSeq/get_msg & pre-check, signal 302 rejectRedirect & RELAY_ error passthrough", async (t) => {
  const dir = makeTempDir(t);
  const bindingPath = path.join(dir, "binding.json");
  const relayPath = path.join(dir, "relay-groups.json");
  const statePath = path.join(dir, "state", "comm-relay-state.json");
  writeJson(bindingPath, baseBinding());
  writeJson(relayPath, baseRelayGroups());

  // 1) A R2-P0-1 / B R2-P1-1: 默认禁止公开名单的路由上，单收件人 3 段 + 4 段并存必须放行；不同人/不同机必拒
  const soloRes = validateRecipientDisclosure(
    { relay_key: "qq-lab-v1", group_id: "920001", peer_machine_id: "lab", allow_recipient_list_disclosure: false },
    { recipients: ["codex/desktop/lab1"], all_recipients: ["lab/codex/desktop/lab1"] },
  );
  assert.equal(soloRes.disclosed, false);
  assert.equal(soloRes.effective_all_recipients.length, 1);

  assert.throws(
    () => validateRecipientDisclosure(
      { relay_key: "qq-lab-v1", group_id: "920001", peer_machine_id: "lab", allow_recipient_list_disclosure: false },
      { recipients: ["codex/desktop/lab1"], all_recipients: ["training/codex/desktop/lab1"] },
    ),
    (err) => err instanceof RelayError && err.code === "RELAY_RECIPIENT_DISCLOSURE_BLOCKED",
  );

  // 2) A R2-P1-2 / B R2-P1-4: 带 AbortController.signal 调用 _relayTransport.callOneBot 遇 302 必拒重定向
  const redirServer = http.createServer((_req, res) => {
    res.writeHead(302, { location: "http://127.0.0.1:1/never" });
    res.end();
  });
  t.after(async () => {
    redirServer.closeAllConnections?.();
    await new Promise((r) => redirServer.close(() => r()));
  });
  await new Promise((r) => redirServer.listen(0, "127.0.0.1", r));
  const redirUrl = `http://127.0.0.1:${redirServer.address().port}`;
  const redirNotifier = createNapCatNotifier({
    cwd: dir,
    env: {
      NAPCAT_HTTP_URL: redirUrl,
      NAPCAT_ACCESS_TOKEN: "",
      NAPCAT_ALLOW_EMPTY_TOKEN: "1",
      NAPCAT_MCP_BINDING_PATH: bindingPath,
      NAPCAT_MCP_STATE_PATH: path.join(dir, "state", "dedupe-redir.json"),
    },
  });
  const ac = new AbortController();
  await assert.rejects(
    () => redirNotifier._relayTransport.callOneBot("get_status", {}, { signal: ac.signal }),
  );

  // 3) B R2-P0-1 / A R2-P2-3: 突发 120 条消息 poll1(max_pages=1) 产生真断档后，poll2 撞新锚点绝不能抹除 last_history_gap
  let forceZeroRealSeqOnce = false;
  const mock = await createMockOneBot(t, {
    onAction: ({ action, body, respond, histories }) => {
      if (action === "send_group_msg" && forceZeroRealSeqOnce) {
        forceZeroRealSeqOnce = false;
        const gid = String(body.group_id);
        const text = Array.isArray(body.message) ? body.message.map((s) => s?.data?.text ?? "").join("") : String(body.message ?? "");
        const rec = {
          message_id: 99001,
          message_seq: 99001,
          real_seq: "0",
          group_id: Number(gid),
          user_id: 100001,
          sender: { user_id: 100001, nickname: "DevBot" },
          time: Math.floor(Date.now() / 1000),
          post_type: "message_sent",
          raw_message: text,
          message: [{ type: "text", data: { text } }],
        };
        const arr = histories.get(gid) || [];
        arr.push(rec);
        histories.set(gid, arr);
        respond({ message_id: 99001 });
        return true;
      }
      return false;
    },
  });
  const env = {
    NAPCAT_HTTP_URL: mock.baseUrl,
    NAPCAT_ACCESS_TOKEN: "",
    NAPCAT_ALLOW_EMPTY_TOKEN: "1",
    NAPCAT_MCP_BINDING_PATH: bindingPath,
    NAPCAT_MCP_STATE_PATH: path.join(dir, "state", "dedupe.json"),
  };
  const notifier = createNapCatNotifier({ cwd: dir, env });
  const service = createNapCatRelayService({ notifier, statePath, relayGroupsPath: relayPath, env });
  const host = createFileBundleRelayHost({ notifier, relayService: service, relayGroupsPath: relayPath, env });

  // 4) B R2-P1-3 / A R2-P2-1: 本地假回显 real_seq="0" 落 sent_unverified 后，reconcileSendRecord 绝不能误升 sent_verified；错路由/错正文 inspectPinnedControl 零网络调用
  const cfgInit = loadAndValidateRelayConfig({ bindingPath, relayGroupsPath: relayPath });
  const frozenInit = resolveRelayRoute(cfgInit, { target_machine: "training", channel: "qq", mode: "write" });
  forceZeroRealSeqOnce = true;
  const zeroSend = await service.relaySend({
    dedupe_key: "dk-local-echo-zero",
    target_machine: "training",
    op: "message",
    source: "antigravity/desktop/a1",
    recipients: ["codex/desktop/b1"],
    body: "fake zero echo",
  });
  assert.equal(zeroSend.status, "sent_unverified");
  assert.equal(zeroSend.outcome_unknown, true);
  const reconciledZero = await service.reconcileSendRecord("dk-local-echo-zero", frozenInit);
  assert.equal(reconciledZero.status, "sent_unverified", "real_seq=0 echo must never be promoted to sent_verified");
  assert.equal(reconciledZero.outcome_unknown, true);

  const callsBeforeWrongInspect = mock.calls.length;
  const wrongBodyInspect = await host.inspectPinnedControl(frozenInit, {
    dedupe_key: "dk-local-echo-zero",
    body: "tampered body",
  });
  assert.equal(wrongBodyInspect.status, "unknown");
  assert.equal(mock.calls.length, callsBeforeWrongInspect, "inspectPinnedControl must check ownership/body hash before any network reconcile");

  // 推送 120 条消息触发真断档，再跑 poll2 撞新锚点，确认 route_gaps 不被静默抹除
  const tBase = Math.floor(Date.now() / 1000) + 100;
  for (let i = 1; i <= 120; i += 1) {
    const f = encodeRelayFrame({
      relay_id: `rly_gap120_${i}`,
      op: "message",
      from_machine: "training",
      to_machine: "development",
      source: "codex/desktop/019f9012",
      recipients: ["antigravity/desktop/1a5df4f4"],
      body: `burst-${i}`,
    });
    mock.pushPeerMessage("910002", "200002", f, { timeSec: tBase + i });
  }
  const poll1 = await service.relayPoll({ relay_keys: ["qq-training-v2"], max_pages: 1 });
  assert.equal(poll1.history_gaps.length, 1);
  const poll2 = await service.relayPoll({ relay_keys: ["qq-training-v2"], max_pages: 1 });
  assert.equal(poll2.history_gaps.length, 0);
  const readAfterPoll2 = await service.relayEventsRead({ relay_key: "qq-training-v2", limit: 10 });
  assert.equal(readAfterPoll2.route_gaps.length, 1, "true history gap must NOT be erased by next anchor-hit poll before consumer reads");
  const readResumed = await service.relayEventsRead({ relay_key: "qq-training-v2", limit: 10, resume_from_retained: true });
  assert.equal(readResumed.route_gaps.length, 0, "resume_from_retained=true explicitly acknowledges gap");

  // 5) B R2-P1-2: 换群升代后在 relayPoll 之前直接调用 readVerifiedPage / relayEventsRead，不得泄漏旧代次事件且旧游标必抛 MISMATCH
  const oldCursor = readAfterPoll2.next_cursor;
  const cfgGen3 = baseRelayGroups();
  cfgGen3.relays["qq-training-v2"].generation = 3;
  cfgGen3.relays["qq-training-v2"].group_id = "910009";
  writeJson(relayPath, cfgGen3);
  const prePollRead = await host.readVerifiedPage({
    relay_key: "qq-training-v2",
    group_id: "910009",
    route_generation: 3,
    cursor: null,
    limit: 12,
  });
  assert.deepEqual(prePollRead.events, [], "readVerifiedPage before relayPoll must never leak old generation events");
  await assert.rejects(
    () => service.relayEventsRead({ relay_key: "qq-training-v2", cursor: oldCursor, limit: 10 }),
    (err) => err instanceof RelayError && err.code === "RELAY_CURSOR_SCOPE_MISMATCH",
  );
});
