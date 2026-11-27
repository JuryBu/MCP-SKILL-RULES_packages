import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  RelayError,
  loadAndValidateRelayConfig,
  resolveRelayRoute,
  reverifyFrozenRelayRoute,
  buildSanitizedRelayView,
} from "../src/relay-groups.mjs";
import { createFileBundleRelayHost } from "../src/relay-file-bundle-bridge.mjs";
import { createNapCatNotifier, inspectLegacyParsers } from "../src/core.mjs";

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-coexist-folder-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bindingPath = path.join(root, "binding.json");
  const relayPath = path.join(root, "relay-groups.json");
  writeJson(bindingPath, {
    bindingName: "legacy-training-group",
    groupId: "900001",
    groupName: "ExampleTrainingGroup",
    expectedSelfId: "100001",
    expectedMemberCount: 4,
    controlPlane: {
      targets: {
        "owner-private": { type: "private", id: "200001" },
        "owner-members": { type: "group", id: "900099" },
      },
    },
  });
  const baseConfig = () => ({
    schema_version: 1,
    local_machine_id: "development",
    expected_self_id: "100001",
    peers: {
      training: { qq_id: "100002", enabled: true, display_name: "TrainingPeer", channels: ["qq"] },
    },
    relays: {
      "qq-coexist": {
        channel: "qq",
        group_id: "900001",
        expected_group_name: "ExampleTrainingGroup",
        generation: 1,
        enabled: true,
        role: "active_write",
        target_machines: ["training"],
        allowed_peers: ["training"],
        legacy_training_coexistence: true,
        allow_recipient_list_disclosure: true,
        bootstrap_at: "2026-11-28T00:00:00.000Z",
      },
    },
  });
  return { root, bindingPath, relayPath, baseConfig };
}

test("coexistence route defaults to forbidding file bundle writes and requires pinned folder pair when enabled", (t) => {
  const { bindingPath, relayPath, baseConfig } = makeFixture(t);

  // 1. Coexistence without explicit allow_file_bundle_write stays text-only
  const textOnly = baseConfig();
  writeJson(relayPath, textOnly);
  const cfgTextOnly = loadAndValidateRelayConfig({ bindingPath, relayGroupsPath: relayPath });
  assert.equal(cfgTextOnly.conflicts.length, 0);
  const frozenTextOnly = resolveRelayRoute(cfgTextOnly, { target_machine: "training", channel: "qq", mode: "write" });
  assert.equal(frozenTextOnly.legacy_training_coexistence, true);
  assert.equal(frozenTextOnly.allow_file_bundle_write, false);
  assert.equal(frozenTextOnly.file_bundle_folder_id, null);
  assert.equal(frozenTextOnly.file_bundle_folder_name, null);
  assert.throws(
    () => reverifyFrozenRelayRoute(cfgTextOnly, frozenTextOnly, { requireFileBundleWrite: true }),
    (err) => err instanceof RelayError && err.code === "RELAY_FILE_BUNDLE_WRITE_FORBIDDEN",
  );

  // 2. Enabling allow_file_bundle_write without folder id+name records conflict and fails closed
  const missingFolder = baseConfig();
  missingFolder.relays["qq-coexist"].allow_file_bundle_write = true;
  writeJson(relayPath, missingFolder);
  const cfgMissing = loadAndValidateRelayConfig({ bindingPath, relayGroupsPath: relayPath });
  assert.equal(cfgMissing.relays["qq-coexist"].valid, false);
  assert.equal(cfgMissing.relays["qq-coexist"].allow_file_bundle_write, false);
  assert.equal(cfgMissing.relays["qq-coexist"].conflicts[0].code, "RELAY_COEXISTENCE_FILE_BUNDLE_FOLDER_REQUIRED");
  assert.throws(
    () => resolveRelayRoute(cfgMissing, { target_machine: "training", channel: "qq", mode: "write" }),
    (err) => err instanceof RelayError && err.code === "RELAY_COEXISTENCE_FILE_BUNDLE_FOLDER_REQUIRED",
  );

  // 3. Partial pair or invalid folder id/name is rejected at config validation
  for (const bad of [
    { file_bundle_folder_id: "/folder-1" },
    { file_bundle_folder_name: "comm-relay-bundles" },
    { file_bundle_folder_id: "/", file_bundle_folder_name: "comm-relay-bundles" },
    { file_bundle_folder_id: "..", file_bundle_folder_name: "comm-relay-bundles" },
    { file_bundle_folder_id: "/bad\\slash", file_bundle_folder_name: "comm-relay-bundles" },
    { file_bundle_folder_id: "/folder-1", file_bundle_folder_name: "../escape" },
  ]) {
    const invalid = baseConfig();
    Object.assign(invalid.relays["qq-coexist"], { allow_file_bundle_write: true, ...bad });
    writeJson(relayPath, invalid);
    assert.throws(
      () => loadAndValidateRelayConfig({ bindingPath, relayGroupsPath: relayPath }),
      (err) => err instanceof RelayError && err.code === "RELAY_CONFIG_INVALID",
      JSON.stringify(bad),
    );
  }
});

test("coexistence route with pinned folder id+name passes write/draining checks and blocks recreated same-name folder takeover", async (t) => {
  const { bindingPath, relayPath, baseConfig } = makeFixture(t);

  const pinned = baseConfig();
  Object.assign(pinned.relays["qq-coexist"], {
    allow_file_bundle_write: true,
    file_bundle_folder_id: "/comm-folder-id-001",
    file_bundle_folder_name: "comm-relay-bundles",
  });
  writeJson(relayPath, pinned);
  const cfg1 = loadAndValidateRelayConfig({ bindingPath, relayGroupsPath: relayPath });
  assert.equal(cfg1.conflicts.length, 0);
  const frozen1 = resolveRelayRoute(cfg1, { target_machine: "training", channel: "qq", mode: "write" });
  assert.equal(frozen1.allow_file_bundle_write, true);
  assert.equal(frozen1.file_bundle_folder_id, "/comm-folder-id-001");
  assert.equal(frozen1.file_bundle_folder_name, "comm-relay-bundles");

  const view = buildSanitizedRelayView(cfg1);
  assert.equal(view.routes[0].file_bundle_folder_id, "/comm-folder-id-001");
  assert.equal(view.routes[0].file_bundle_folder_name, "comm-relay-bundles");

  const reverified = reverifyFrozenRelayRoute(cfg1, frozen1, { allowDraining: false, requireFileBundleWrite: true });
  assert.equal(reverified.file_bundle_folder_id, "/comm-folder-id-001");

  // Same folder name recreated with new OneBot folder_id -> config_hash changes and old frozen route MUST fail closed
  const recreated = baseConfig();
  Object.assign(recreated.relays["qq-coexist"], {
    allow_file_bundle_write: true,
    file_bundle_folder_id: "/comm-folder-id-002",
    file_bundle_folder_name: "comm-relay-bundles",
  });
  writeJson(relayPath, recreated);
  const cfgRecreated = loadAndValidateRelayConfig({ bindingPath, relayGroupsPath: relayPath });
  assert.notEqual(cfgRecreated.config_hash, cfg1.config_hash);
  assert.throws(
    () => reverifyFrozenRelayRoute(cfgRecreated, frozen1, { allowDraining: true, requireFileBundleWrite: false }),
    (err) => err instanceof RelayError && err.code === "RELAY_ROUTE_CHANGED" && err.details?.change_reason === "file_bundle_folder_mismatch",
  );

  // Draining with same pinned folder allows continuation reads but blocks new writes
  const draining = baseConfig();
  Object.assign(draining.relays["qq-coexist"], {
    role: "draining_read",
    drain_until: "2026-12-31T00:00:00.000Z",
    allow_file_bundle_write: false,
    file_bundle_folder_id: "/comm-folder-id-001",
    file_bundle_folder_name: "comm-relay-bundles",
  });
  writeJson(relayPath, draining);
  const cfgDraining = loadAndValidateRelayConfig({ bindingPath, relayGroupsPath: relayPath });
  const drainedRoute = reverifyFrozenRelayRoute(cfgDraining, frozen1, { allowDraining: true, requireFileBundleWrite: false });
  assert.equal(drainedRoute.role, "draining_read");
  assert.equal(drainedRoute.file_bundle_folder_id, "/comm-folder-id-001");
  assert.throws(
    () => reverifyFrozenRelayRoute(cfgDraining, frozen1, { allowDraining: false, requireFileBundleWrite: true }),
    (err) => err instanceof RelayError && err.code === "RELAY_ROUTE_DRAINING",
  );

  // Control plane group remains strictly mutually exclusive even with coexistence + folder fields
  const badHuman = baseConfig();
  badHuman.relays["qq-human"] = {
    channel: "qq",
    group_id: "900099",
    generation: 1,
    enabled: true,
    role: "active_write",
    target_machines: ["training"],
    allowed_peers: ["training"],
    legacy_training_coexistence: true,
    allow_file_bundle_write: true,
    file_bundle_folder_id: "/comm-folder-id-999",
    file_bundle_folder_name: "comm-relay-bundles",
  };
  writeJson(relayPath, badHuman);
  const cfgHuman = loadAndValidateRelayConfig({ bindingPath, relayGroupsPath: relayPath });
  assert.equal(cfgHuman.relays["qq-human"].valid, false);
  assert.ok(cfgHuman.relays["qq-human"].conflicts.some((c) => c.code === "RELAY_GROUP_CONFLICTS_WITH_CONTROL_PLANE"));

  // Bridge scopes & readVerifiedPage allow pinned coexistence folder (active or draining), reject text-only coexistence
  writeJson(relayPath, pinned);
  const relayCalls = [];
  const host = createFileBundleRelayHost({
    notifier: { bindingPath, _relayTransport: { verifyAccountOnline: async () => {}, verifyGroupIdentity: async () => {}, callOneBot: async () => ({}) } },
    relayService: {
      relaySend: async (req) => {
        relayCalls.push(req);
        return {
          status: "sent_verified", transport_stage: "group_received",
          relay_key: req.reply_relay_key, route_generation: req.reply_route_generation, group_id: req.reply_group_id,
          body_sha256: "a".repeat(64), onebot_message_id: "101", real_seq: "202", outcome_unknown: false,
        };
      },
      relayEventsRead: async () => ({ events: [], next_cursor: null, has_more: false, route_gaps: [] }),
    },
    relayGroupsPath: relayPath,
  });
  const scopesActive = await host.listScopes();
  assert.deepEqual(scopesActive, [{ relay_key: "qq-coexist", group_id: "900001", route_generation: 1 }]);
  const sent = await host.sendPinnedControl(frozen1, {
    dedupe_key: "dk-coexist-1",
    target_machine: "training",
    channel: "qq",
    op: "file_notice",
    source: "system/napcat-file-bundle/development",
    recipients: ["system/napcat-file-bundle/training"],
    body: JSON.stringify({ v: 1 }),
  }, { requireFileBundleWrite: true });
  assert.equal(sent.status, "sent_verified");
  assert.equal(relayCalls.length, 1);

  // Switch to draining -> scopes & readVerifiedPage still allow continuation, new write denied
  writeJson(relayPath, draining);
  assert.deepEqual(await host.listScopes(), [{ relay_key: "qq-coexist", group_id: "900001", route_generation: 1 }]);
  const page = await host.readVerifiedPage({ relay_key: "qq-coexist", group_id: "900001", route_generation: 1 });
  assert.deepEqual(page.events, []);
  const deniedWrite = await host.sendPinnedControl(frozen1, {
    dedupe_key: "dk-coexist-2",
    target_machine: "training",
    channel: "qq",
    op: "file_notice",
    source: "system/napcat-file-bundle/development",
    recipients: ["system/napcat-file-bundle/training"],
    body: JSON.stringify({ v: 1 }),
  }, { requireFileBundleWrite: true });
  assert.equal(deniedWrite.status, "not_sent");

  // Switch to text-only coexistence (no folder) -> excluded from scopes & readVerifiedPage
  writeJson(relayPath, baseConfig());
  assert.deepEqual(await host.listScopes(), []);
  await assert.rejects(
    () => host.readVerifiedPage({ relay_key: "qq-coexist", group_id: "900001", route_generation: 1 }),
    (err) => err instanceof RelayError && err.code === "RELAY_CURSOR_SCOPE_MISMATCH",
  );
});

function isolatedMockFetch(port) {
  const expectedOrigin = `http://127.0.0.1:${port}`;
  return async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.origin !== expectedOrigin) {
      throw new Error(`TEST_BLOCKED_NON_MOCK_ORIGIN:${parsed.origin}`);
    }
    return globalThis.fetch(url, init);
  };
}

test("core.mjs legacy task parsers ignore [COMM_RELAY_V1] frames containing task-like text while preserving legacy messages", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-core-relay-isolation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bindingPath = path.join(root, "binding.json");
  const ledgerPath = path.join(root, "ledger.json");

  const relayMimicText = [
    "[COMM_RELAY_V1]",
    '{"relay_id":"r1","op":"message","from_machine":"training","to_machine":"development","source":"training/codex/c1","recipients":["development/antigravity/c2"],"body_sha256":"' + "a".repeat(64) + '"}',
    "[Codex][TASK_MESSAGE]",
    "任务：spoofed-task-id",
    "来源机器：training",
    "目标机器：development",
    "[Codex][TASK_FILE_INDEX]",
    "file_id：spoofed-file-id",
    "[END_COMM_RELAY_V1]",
  ].join("\n");

  const genuineTaskText = [
    "[Codex][TASK_MESSAGE]",
    "任务：real-legacy-task-42",
    "来源机器：training",
    "目标机器：development",
  ].join("\n");

  let mockHits = 0;
  let historyCalls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      mockHits += 1;
      const action = req.url.replace(/^\/+/u, "");
      let data = {};
      if (action === "get_status") data = { online: true, good: true };
      else if (action === "get_login_info") data = { user_id: 100001, nickname: "DevBot" };
      else if (action === "get_group_info") data = { group_id: 900001, group_name: "ExampleTrainingGroup", member_count: 4 };
      else if (action === "get_group_msg_history") {
        historyCalls += 1;
        data = {
          messages: historyCalls === 1 ? [
            { message_id: 1001, message_seq: 1001, time: 1732750000, user_id: 100002, raw_message: relayMimicText, message: [{ type: "text", data: { text: relayMimicText } }] },
            { message_id: 1002, message_seq: 1002, time: 1732750010, user_id: 100002, raw_message: genuineTaskText, message: [{ type: "text", data: { text: genuineTaskText } }] },
          ] : [],
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", retcode: 0, data }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;

  writeJson(bindingPath, {
    bindingName: "legacy-training-group",
    groupId: "900001",
    groupName: "ExampleTrainingGroup",
    expectedSelfId: "100001",
    expectedMemberCount: 4,
  });

  const mockFetch = isolatedMockFetch(port);
  await assert.rejects(
    () => mockFetch("http://127.0.0.1:3010/get_status"),
    /TEST_BLOCKED_NON_MOCK_ORIGIN/u,
  );

  const notifier = createNapCatNotifier({
    cwd: root,
    fetchImpl: mockFetch,
    env: {
      NAPCAT_MCP_BINDING_PATH: bindingPath,
      NAPCAT_MCP_STATE_PATH: ledgerPath,
      NAPCAT_HTTP_URL: `http://127.0.0.1:${port}`,
      NAPCAT_ALLOW_EMPTY_TOKEN: "1",
    },
  });
  const recent = await notifier.readRecentMessages({ count: 10 });
  assert.ok(mockHits >= 3, "must hit isolated mock OneBot server only");
  assert.equal(recent.messages.length, 2);

  const relayMsg = recent.messages.find((m) => String(m.messageId) === "1001");
  const legacyMsg = recent.messages.find((m) => String(m.messageId) === "1002");
  assert.ok(relayMsg && legacyMsg);
  assert.equal(relayMsg.taskId, "");
  assert.equal(relayMsg.sourceMachine, "");
  assert.equal(relayMsg.targetMachine, "");
  assert.equal(relayMsg.fileIndex ?? null, null);
  const directParsed = inspectLegacyParsers(relayMimicText);
  assert.equal(directParsed.taskMetadata.taskId, "");
  assert.equal(directParsed.fileIndex, null);
  assert.equal(legacyMsg.taskId, "real-legacy-task-42");
  assert.equal(legacyMsg.sourceMachine, "training");
  assert.equal(legacyMsg.targetMachine, "development");
});

test("core.mjs legacy root cleanup skips reserved ncr-<UUID>-<16hex>.ncp files even when oldest", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-core-root-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bindingPath = path.join(root, "binding.json");
  const ledgerPath = path.join(root, "ledger.json");
  const sampleFile = path.join(root, "legacy-report.txt");
  fs.writeFileSync(sampleFile, "legacy upload content\n", "utf8");

  const reservedName = "ncr-11111111-2222-4333-8444-555555555555-0123456789abcdef.ncp";
  const deletedIds = [];
  let uploaded = false;
  let mockHits = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      mockHits += 1;
      const action = req.url.replace(/^\/+/u, "");
      const payload = body ? JSON.parse(body) : {};
      let data = {};
      if (action === "get_status") data = { online: true, good: true };
      else if (action === "get_login_info") data = { user_id: 100001, nickname: "DevBot" };
      else if (action === "get_group_info") data = { group_id: 900001, group_name: "ExampleTrainingGroup", member_count: 4 };
      else if (action === "get_group_file_system_info") data = { file_count: 105, limit_count: 200, used_space: 1024, total_space: 1048576 };
      else if (action === "get_group_root_files") {
        data = {
          files: [
            { file_id: "/reserved-oldest", file_name: reservedName, file_size: 128, upload_time: 1000 },
            { file_id: "/legacy-old-1", file_name: "old-task-1.txt", file_size: 128, upload_time: 2000 },
            { file_id: "/legacy-old-2", file_name: "old-task-2.txt", file_size: 128, upload_time: 3000 },
            { file_id: "/legacy-new-3", file_name: "new-task-3.txt", file_size: 128, upload_time: 4000 },
            ...(uploaded ? [{ file_id: "/uploaded-new", file_name: "legacy-report.txt", file_size: 22, upload_time: 5000, busid: 102 }] : []),
          ],
          folders: [],
        };
      } else if (action === "delete_group_file") {
        deletedIds.push(payload.file_id);
        data = {};
      } else if (action === "upload_group_file") {
        uploaded = true;
        data = { file_id: "/uploaded-new" };
      } else if (action === "send_group_msg") {
        data = { message_id: 5001 };
      } else if (action === "get_group_msg_history") {
        data = {
          messages: uploaded ? [{
            message_id: 5001,
            message_seq: 5001,
            real_seq: "5001",
            time: 1732750100,
            user_id: 100001,
            post_type: "message_sent",
            message_sent_type: "self",
            raw_message: "[Codex][TASK_FILE_INDEX]",
            message: [{ type: "text", data: { text: "[Codex][TASK_FILE_INDEX]" } }],
          }] : [],
        };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", retcode: 0, data }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;

  writeJson(bindingPath, {
    bindingName: "legacy-training-group",
    groupId: "900001",
    groupName: "ExampleTrainingGroup",
    expectedSelfId: "100001",
    expectedMemberCount: 4,
  });

  const notifier = createNapCatNotifier({
    cwd: root,
    fetchImpl: isolatedMockFetch(port),
    env: {
      NAPCAT_MCP_BINDING_PATH: bindingPath,
      NAPCAT_MCP_STATE_PATH: ledgerPath,
      NAPCAT_HTTP_URL: `http://127.0.0.1:${port}`,
      NAPCAT_ALLOW_EMPTY_TOKEN: "1",
      NAPCAT_GROUP_FILE_COUNT_LIMIT: "100",
      NAPCAT_GROUP_FILE_CLEANUP_BATCH: "2",
    },
  });
  try {
    await notifier.sendFile({
      dedupe_key: "legacy-root-cleanup-dk-1",
      file_path: sampleFile,
      task_id: "legacy-cleanup-test-1",
      source_machine: "development",
      target_machine: "training",
      note: "test root cleanup skips reserved bundle name",
    });
  } catch (err) {
    // sendFile's post-upload index history check is unrelated to pre-upload cleanup; ensure cleanup already ran cleanly
    assert.ok(uploaded, `expected upload step to be reached on isolated mock, got: ${err?.message}`);
  }

  assert.ok(mockHits >= 5, "must hit isolated mock OneBot server only");
  assert.deepEqual(deletedIds, ["/legacy-old-1", "/legacy-old-2"]);
  assert.equal(deletedIds.includes("/reserved-oldest"), false);
});
