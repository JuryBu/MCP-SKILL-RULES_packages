import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";

const WORK_SRC = path.resolve("src");
const BUNDLE_SRC_CANDIDATES = [
  WORK_SRC,
  process.env.NAPCAT_FILE_BUNDLE_SRC_DIR,
  path.resolve("..", "mcps", "napcat-mcp", "src"),
].filter(Boolean);

function resolveBundleSrcDir() {
  for (const dir of BUNDLE_SRC_CANDIDATES) {
    if (fs.existsSync(path.join(dir, "file-bundle-integration.mjs"))) {
      return dir;
    }
  }
  return null;
}

function makeTempDir(t, prefix = "napcat-ab-joint-") {
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

function createDualMachineMockOneBot(t) {
  const groupId = "910002";
  const groupMeta = { group_id: 910002, group_name: "RelayV2", member_count: 3 };
  const histories = new Map([[groupId, []]]);
  const groupFiles = new Map(); // file_id -> { meta, contentBuffer }
  let nextMsgId = 70000;
  let nextSeq = 500;
  let nextFileNum = 1;

  function makeServer(selfId, nickname) {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url.startsWith("/download/")) {
        const fid = decodeURIComponent(req.url.slice("/download/".length));
        const item = groupFiles.get(fid);
        if (!item) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(item.bytes);
        return;
      }

      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const action = req.url.replace(/^\//, "");
        const body = raw ? JSON.parse(raw) : {};
        const ok = (data) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ok", retcode: 0, data }));
        };
        const fail = (retcode = 1404) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "failed", retcode, data: null }));
        };

        if (action === "get_status") return ok({ online: true, good: true });
        if (action === "get_login_info") return ok({ user_id: Number(selfId), nickname });
        if (action === "get_group_info") {
          return String(body.group_id) === groupId ? ok(groupMeta) : fail();
        }
        if (action === "send_group_msg") {
          if (String(body.group_id) !== groupId) return fail();
          nextMsgId += 1;
          nextSeq += 1;
          // 必须发送纯文本段数组（杜绝裸字符串 CQ 解析注入）
          assert.ok(Array.isArray(body.message), "send_group_msg must send text segment array");
          const text = body.message.map((s) => (s?.type === "text" ? String(s.data?.text ?? "") : "")).join("");
          const rec = {
            message_id: nextMsgId,
            message_seq: nextSeq,
            real_seq: String(nextSeq),
            group_id: Number(groupId),
            user_id: Number(selfId),
            sender: { user_id: Number(selfId), nickname },
            time: Math.floor(Date.now() / 1000),
            post_type: "message_sent",
            raw_message: text,
            message: [{ type: "text", data: { text } }],
          };
          histories.get(groupId).push(rec);
          return ok({ message_id: nextMsgId });
        }
        if (action === "get_msg") {
          const hit = histories.get(groupId).find((m) => String(m.message_id) === String(body.message_id));
          return hit ? ok(hit) : fail();
        }
        if (action === "get_group_msg_history") {
          const arr = histories.get(groupId) || [];
          const count = Number(body.count || 50);
          const seqCursor = body.message_seq ? Number(body.message_seq) : null;
          const filtered = seqCursor !== null && Number.isFinite(seqCursor)
            ? arr.filter((m) => Number(m.message_seq) < seqCursor)
            : arr;
          const perspective = filtered.slice(-count).map((m) => ({
            ...m,
            post_type: String(m.user_id) === String(selfId) ? "message_sent" : "message",
          }));
          return ok({ messages: perspective });
        }
        if (action === "get_group_file_system_info") {
          const all = [...groupFiles.values()];
          const used = all.reduce((s, f) => s + f.bytes.length, 0);
          return ok({ file_count: all.length, limit_count: 100, used_space: used, total_space: 1024 ** 3 });
        }
        if (action === "get_group_root_files") {
          return ok({
            files: [...groupFiles.values()].map((f) => f.meta),
            folders: [],
          });
        }
        if (action === "upload_group_file") {
          const buf = fs.readFileSync(body.file);
          const fid = `/fid_${nextFileNum++}`;
          const meta = {
            file_id: fid,
            file_name: body.name,
            busid: 102,
            file_size: buf.length,
            uploader: Number(selfId),
            upload_time: Math.floor(Date.now() / 1000),
          };
          groupFiles.set(fid, { meta, bytes: buf });
          return ok({ file_id: fid });
        }
        if (action === "get_group_file_url") {
          const item = groupFiles.get(String(body.file_id));
          if (!item) return fail();
          const addr = server.address();
          return ok({ url: `http://127.0.0.1:${addr.port}/download/${encodeURIComponent(item.meta.file_id)}` });
        }
        if (action === "delete_group_file") {
          const existed = groupFiles.delete(String(body.file_id));
          return existed ? ok({}) : fail();
        }
        return fail();
      });
    });
    t.after(async () => {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, origin: `http://127.0.0.1:${addr.port}` });
      });
    });
  }

  return { makeServer, groupFiles, histories };
}

test("6. Real A+B joint end-to-end: Block A bridge + Block B openFileBundleIntegration dual-machine bundle roundtrip", async (t) => {
  const bundleSrc = resolveBundleSrcDir();
  if (!bundleSrc) {
    t.skip("file-bundle-integration.mjs not present in this candidate tree");
    return;
  }
  const bundleFiles = fs.readdirSync(bundleSrc).filter((f) => f.startsWith("file-bundle-") && f.endsWith(".mjs"));
  assert.ok(bundleFiles.includes("file-bundle-integration.mjs"), "bundleSrc must contain Block B file-bundle-integration.mjs");

  // 在隔离临时目录把 A 源码与 B 源码合体，绝不污染唯一主仓或纯 A 目录
  const jointDir = makeTempDir(t);
  const jointSrc = path.join(jointDir, "src");
  fs.mkdirSync(jointSrc, { recursive: true });
  for (const f of fs.readdirSync(WORK_SRC)) {
    if (f.endsWith(".mjs")) {
      fs.copyFileSync(path.join(WORK_SRC, f), path.join(jointSrc, f));
    }
  }
  for (const f of bundleFiles) {
    fs.copyFileSync(path.join(bundleSrc, f), path.join(jointSrc, f));
  }

  const [{ createNapCatNotifier }, { createNapCatRelayService }, { createFileBundleRelayHost }, { openFileBundleIntegration }] =
    await Promise.all([
      import(pathToFileURL(path.join(jointSrc, "core.mjs")).href),
      import(pathToFileURL(path.join(jointSrc, "relay-service.mjs")).href),
      import(pathToFileURL(path.join(jointSrc, "relay-file-bundle-bridge.mjs")).href),
      import(pathToFileURL(path.join(jointSrc, "file-bundle-integration.mjs")).href),
    ]);

  const dual = createDualMachineMockOneBot(t);
  const devServer = await dual.makeServer("100001", "DevBot");
  const trnServer = await dual.makeServer("200002", "TrnBot");

  async function setupMachine(name, selfId, peerName, peerQq, serverInfo) {
    const mDir = path.join(jointDir, name);
    const bindingPath = path.join(mDir, "binding.json");
    const relayPath = path.join(mDir, "relay-groups.json");
    const relayStatePath = path.join(mDir, "state", "comm-relay-state.json");
    const bundleRoot = path.join(mDir, "state", "comm-file-bundle");
    fs.mkdirSync(bundleRoot, { recursive: true });

    writeJson(bindingPath, {
      schemaVersion: 2,
      expectedSelfId: selfId,
      expectedNickname: name,
      groupId: "900001",
      groupName: "LegacyTrainingGroup",
      expectedMemberCount: 3,
      controlPlane: {
        enabled: true,
        localMachine: name,
        defaultTargetKey: "owner_group",
        targets: { owner_group: { type: "group", id: "800001", name: "Members", expectedMemberCount: 3 } },
      },
    });
    writeJson(relayPath, {
      schemaVersion: 1,
      local_machine_id: name,
      expected_self_id: selfId,
      limits: { max_frame_chars: 1800, max_sends_per_minute_per_group: 20, max_recipients_per_frame: 16, max_history_pages_per_poll: 10 },
      peers: { [peerName]: { qq_id: peerQq, enabled: true, display_name: peerName } },
      relays: {
        "qq-relay-v2": {
          channel: "qq",
          group_id: "910002",
          expected_group_name: "RelayV2",
          generation: 2,
          enabled: true,
          role: "active_write",
          target_machines: [peerName],
          allowed_peers: [peerName],
          allow_recipient_list_disclosure: true,
          bootstrap_at: "2026-11-26T00:00:00.000Z",
          verify_member_count: false,
        },
      },
    });

    const env = {
      NAPCAT_HTTP_URL: serverInfo.baseUrl,
      NAPCAT_ACCESS_TOKEN: "",
      NAPCAT_ALLOW_EMPTY_TOKEN: "1",
      NAPCAT_MCP_BINDING_PATH: bindingPath,
      NAPCAT_MCP_STATE_PATH: path.join(mDir, "state", "dedupe.json"),
    };
    const notifier = createNapCatNotifier({ cwd: mDir, env });
    const relayService = createNapCatRelayService({ notifier, statePath: relayStatePath, relayGroupsPath: relayPath, env });
    const relayHost = createFileBundleRelayHost({ notifier, relayService, relayGroupsPath: relayPath, env });

    const trustedToken = Symbol("trusted");
    const integration = await openFileBundleIntegration({
      enabled: true,
      authorizeInvocation: async (_tool, ctx) => ctx?.trusted === trustedToken,
      resolveAttachments: async (items) => items,
      relay: relayHost,
      runtimeOptions: {
        localMachine: name,
        privateRoot: bundleRoot,
        oneBot: {
          callOneBot: (action, params, opts) => relayHost.callOneBot(action, params, opts),
          downloadOrigins: [devServer.origin, trnServer.origin],
        },
      },
    });
    t.after(() => integration?.close());
    return { mDir, notifier, relayService, integration, ctx: { trusted: trustedToken } };
  }

  const dev = await setupMachine("development", "100001", "training", "200002", devServer);
  const trn = await setupMachine("training", "200002", "development", "100001", trnServer);

  // 未授权连接严禁看见或调用文件包工具
  assert.deepEqual(await dev.integration.listTools({ trusted: false }), []);
  await assert.rejects(
    () => dev.integration.invoke("napcat_file_bundle_poll", {}, { trusted: false }),
    (err) => err?.code === "RELAY_FILE_CALLER_DENIED",
  );
  assert.equal((await dev.integration.listTools(dev.ctx)).length, 4);

  // 准备真实测试附件，由开发机发给训练机（含长正文 + 真实附件 + 多收件人名单）
  const attPath = path.join(dev.mDir, "report.txt");
  fs.writeFileSync(attPath, "Plan 4 A+B joint real attachment payload!\n你好训练机喵~", "utf8");

  const sendResp = await dev.integration.invoke("napcat_file_bundle_send", {
    dedupe_key: "joint-bundle-001",
    target_machine: "training",
    op: "message",
    source: "antigravity/desktop/1a5df4f4",
    recipients: ["codex/desktop/019f9012", "antigravity/desktop/trn-2"],
    meta: { request_id: "req-joint-1", all_recipients: ["codex/desktop/019f9012", "antigravity/desktop/trn-2"] },
    payload_json: { text: "A+B 联合实测长正文 ".repeat(200) },
    attachments: [{ name: "report.txt", filePath: attPath }],
  }, dev.ctx);
  assert.equal(sendResp.ok, true);
  assert.equal(sendResp.relay_key, "qq-relay-v2");
  assert.equal(sendResp.group_id, "910002");
  assert.equal(sendResp.route_generation, 2);
  assert.ok(["announced", "sent_verified"].includes(sendResp.status), `unexpected send status: ${JSON.stringify(sendResp)}`);

  // 开发机 B 层 poll 推进第 2 阶段上传文件包到群文件区（announced -> uploaded）
  const devUploadPoll = await dev.integration.invoke("napcat_file_bundle_poll", {}, dev.ctx);
  assert.equal(devUploadPoll.ok, true);

  // 训练机 A 层拉取中继群消息（收到 file_notice）-> B 层 poll 消费预告、下载验包并回发 file_ack
  const trnRelayPoll = await trn.relayService.relayPoll({});
  assert.equal(trnRelayPoll.ingested_count, 1);

  for (let i = 0; i < 4; i += 1) {
    const step = await trn.integration.invoke("napcat_file_bundle_poll", {}, trn.ctx);
    assert.equal(step.ok, true);
  }

  // 训练机读取已验本地文件包事件并核对正文与附件内容
  const trnEvents = await trn.integration.invoke("napcat_file_bundle_events_read", {}, trn.ctx);
  assert.equal(trnEvents.ok, true);
  assert.equal(trnEvents.events.length, 1);
  assert.equal(trnEvents.events[0].group_id, "910002");
  assert.equal(trnEvents.events[0].route_generation, 2);
  assert.equal(trnEvents.events[0].payload_json.text, "A+B 联合实测长正文 ".repeat(200));
  assert.equal(trnEvents.events[0].staged_files.length, 1);
  assert.equal(
    fs.readFileSync(trnEvents.events[0].staged_files[0].filePath, "utf8"),
    "Plan 4 A+B joint real attachment payload!\n你好训练机喵~",
  );

  // 开发机 A 层拉取训练机发回的 file_ack -> B 层 poll 确认运输收妥并清理群文件
  const devRelayPoll = await dev.relayService.relayPoll({});
  assert.equal(devRelayPoll.ingested_count, 1);

  const devBundlePoll = await dev.integration.invoke("napcat_file_bundle_poll", {}, dev.ctx);
  assert.equal(devBundlePoll.ok, true);

  // 开发机再查同 dedupe_key 应显示 received（运输收妥）
  const devCheck = await dev.integration.invoke("napcat_file_bundle_send", {
    dedupe_key: "joint-bundle-001",
    target_machine: "training",
    op: "message",
    source: "antigravity/desktop/1a5df4f4",
    recipients: ["codex/desktop/019f9012", "antigravity/desktop/trn-2"],
    meta: { request_id: "req-joint-1", all_recipients: ["codex/desktop/019f9012", "antigravity/desktop/trn-2"] },
    payload_json: { text: "A+B 联合实测长正文 ".repeat(200) },
    attachments: [{ name: "report.txt", filePath: attPath }],
  }, dev.ctx);
  assert.equal(devCheck.stage, "received");

  // 训练机交流核心接管确认 ack -> 释放本地临时副本
  const ackResp = await trn.integration.invoke("napcat_file_bundle_events_ack", {
    event_ids: [trnEvents.events[0].event_id],
  }, trn.ctx);
  assert.equal(ackResp.ok, true);
  assert.equal(ackResp.results[0].release, "released");
});
