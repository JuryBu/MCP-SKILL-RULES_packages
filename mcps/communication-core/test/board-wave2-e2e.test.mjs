import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CoreError, identityKey } from "../src/contracts.mjs";
import { MessageStore } from "../src/store.mjs";
import { ConversationAddressBook } from "../src/conversation-address-book.mjs";
import { RemoteCoreDispatcher } from "../src/remote-core-dispatcher.mjs";
import { BoardStore } from "../src/board-store.mjs";
import { BoardEngine } from "../src/board-engine.mjs";
import { BoardSyncCoordinator, openBoardRuntime } from "../src/board-sync.mjs";

const DEV_MACHINE = "development";
const TRAIN_MACHINE = "training";
const OTHER_MACHINE = "lab-offline";

const DEV_CORE_A = Object.freeze({ machine_id: DEV_MACHINE, host: "antigravity", surface: "desktop", conversation_id: "conv-dev-core-a" });
const DEV_CORE_B = Object.freeze({ machine_id: DEV_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-dev-core-b" });
const DEV_NAP_A = Object.freeze({ machine_id: DEV_MACHINE, host: "antigravity", surface: "desktop", conversation_id: "conv-dev-nap-a" });
const DEV_NAP_B = Object.freeze({ machine_id: DEV_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-dev-nap-b" });
const TRAIN_MAINT = Object.freeze({ machine_id: TRAIN_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-train-maint" });
const OUTSIDER = Object.freeze({ machine_id: DEV_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-outsider-99" });

function createSyncTransaction(db) {
  let depth = 0;
  return function transaction(fn) {
    const sp = `sp_board_${++depth}`;
    db.exec(`SAVEPOINT ${sp}`);
    try {
      const res = fn();
      if (res && typeof res.then === "function") {
        throw new CoreError("invalid_state", "transaction callback must be synchronous");
      }
      db.exec(`RELEASE SAVEPOINT ${sp}`);
      return res;
    } catch (err) {
      try { db.exec(`ROLLBACK TO SAVEPOINT ${sp}`); } catch {}
      try { db.exec(`RELEASE SAVEPOINT ${sp}`); } catch {}
      throw err;
    } finally {
      depth -= 1;
    }
  };
}

function createInMemoryRelayBridge({ devSpoolDir, trainSpoolDir }) {
  const textQueues = { [DEV_MACHINE]: [], [TRAIN_MACHINE]: [] };
  const bundleQueues = { [DEV_MACHINE]: [], [TRAIN_MACHINE]: [] };
  const ackedBundleIds = { [DEV_MACHINE]: [], [TRAIN_MACHINE]: [] };
  let seq = 0;
  let forcePendingCapacityOnBundle = false;
  const sentLog = [];

  function makeTransport(localMachine) {
    const spoolDir = localMachine === DEV_MACHINE ? devSpoolDir : trainSpoolDir;
    const senderAccount = localMachine === DEV_MACHINE ? "100001" : "200002";
    return {
      async sendFrame(req) {
        seq += 1;
        const relayId = `rly_e2e_${seq}`;
        sentLog.push({ kind: "frame", from: localMachine, to: req.target_machine, op: req.op, relay_id: relayId, dedupe_key: req.dedupe_key });
        const targetQueue = textQueues[req.target_machine];
        if (targetQueue) {
          targetQueue.push({
            event_id: `ev_txt_${seq}`,
            relay_id: relayId,
            source_machine: localMachine,
            sender_id: senderAccount,
            sender_verified: true,
            relay_key: req.relay_key ?? "relay-main",
            group_id: req.group_id ?? "90001",
            route_generation: req.route_generation ?? 1,
            frame: {
              relay_id: relayId,
              op: req.op,
              from_machine: localMachine,
              to_machine: req.target_machine,
              source: req.source,
              recipients: req.recipients,
              ...(req.in_reply_to ? { in_reply_to: req.in_reply_to } : {}),
              body: req.body ?? "",
              meta: req.meta ?? { hop_count: 1 },
            },
          });
        }
        return {
          ok: true,
          status: "sent_verified",
          relay_id: relayId,
          relay_key: req.relay_key ?? "relay-main",
          group_id: req.group_id ?? "90001",
          route_generation: req.route_generation ?? 1,
        };
      },
      async sendBundle(req) {
        seq += 1;
        sentLog.push({
          kind: "bundle",
          from: localMachine,
          to: req.target_machine,
          op: req.op,
          attachments: (req.attachments ?? []).length,
          dedupe_key: req.dedupe_key,
          forced_pending: forcePendingCapacityOnBundle,
        });
        if (forcePendingCapacityOnBundle) {
          return {
            ok: false,
            status: "pending_capacity",
            reason: "group_file_capacity_full",
            relay_key: req.relay_key ?? "relay-main",
            group_id: req.group_id ?? "90001",
            route_generation: req.route_generation ?? 1,
          };
        }
        const bundleId = `bnd_e2e_${seq}`;
        const eventId = `ev_bnd_${seq}`;
        const peerSpoolDir = req.target_machine === DEV_MACHINE ? devSpoolDir : trainSpoolDir;
        const stagedFiles = [];
        for (const att of (req.attachments ?? [])) {
          const srcPath = att.filePath ?? att.path ?? att.local_path;
          const raw = fs.readFileSync(srcPath);
          const dstDir = path.join(peerSpoolDir, eventId);
          fs.mkdirSync(dstDir, { recursive: true });
          const dstPath = path.join(dstDir, att.name);
          fs.writeFileSync(dstPath, raw);
          stagedFiles.push({
            name: att.name,
            filePath: dstPath,
            path: dstPath,
            staged_path: dstPath,
            bytes: raw.length,
            sha256: crypto.createHash("sha256").update(raw).digest("hex"),
          });
        }
        const targetQueue = bundleQueues[req.target_machine];
        if (targetQueue) {
          targetQueue.push({
            event_id: eventId,
            bundle_id: bundleId,
            source_machine: localMachine,
            sender_id: senderAccount,
            sender_verified: true,
            relay_key: req.relay_key ?? "relay-main",
            group_id: req.group_id ?? "90001",
            route_generation: req.route_generation ?? 1,
            payload_json: {
              ...req.payload_json,
              bundle_id: bundleId,
              relay_id: bundleId,
            },
            staged_files: stagedFiles,
          });
        }
        return {
          ok: true,
          status: "announced",
          bundle_id: bundleId,
          relay_key: req.relay_key ?? "relay-main",
          group_id: req.group_id ?? "90001",
          route_generation: req.route_generation ?? 1,
        };
      },
      async readEvents() {
        const items = textQueues[localMachine].splice(0);
        return { events: items, next_cursor: items.length ? `c_${seq}` : null };
      },
      async readBundleEvents() {
        const items = [...bundleQueues[localMachine]];
        return { events: items, errors: [], next_cursor: null };
      },
      async ackBundleEvents({ event_ids }) {
        const idSet = new Set(event_ids);
        ackedBundleIds[localMachine].push(...event_ids);
        bundleQueues[localMachine] = bundleQueues[localMachine].filter(item => !idSet.has(item.event_id));
        return { ok: true, acked: event_ids.length };
      },
      _spoolDir: spoolDir,
    };
  }

  return {
    makeTransport,
    sentLog,
    ackedBundleIds,
    setForcePendingCapacity(val) {
      forcePendingCapacityOnBundle = Boolean(val);
    },
  };
}

function createNodeStack({
  machineId,
  peerMachineId,
  rootDir,
  allowedUploadRoots,
  transport,
  trustPeerSourceIdentity = true,
  superAdminIdentities = [],
  nowRef,
  notifyLocalMember,
}) {
  const dbPath = path.join(rootDir, `${machineId}.sqlite`);
  const privateRoot = path.join(rootDir, `${machineId}-private`);
  fs.mkdirSync(privateRoot, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  const transaction = createSyncTransaction(db);

  const addressBook = new ConversationAddressBook({
    database: db,
    machineId,
    now: () => new Date(nowRef.ms).toISOString(),
  });
  const store = new BoardStore({
    database: db,
    transaction,
    privateRoot,
    allowedUploadRoots,
    now: () => nowRef.ms,
  });
  const dispatcher = new RemoteCoreDispatcher({
    localMachineId: machineId,
    transport,
    policy: {
      peers: {
        [peerMachineId]: {
          allow_message: true,
          allow_file_bundle: true,
          trust_source_identity: trustPeerSourceIdentity,
        },
      },
    },
    localHandlers: {},
    now: () => nowRef.ms,
  });
  const engine = new BoardEngine({
    store,
    localMachineId: machineId,
    addressBookAdapter: addressBook,
    superAdminIdentities,
    peerCapabilitiesProvider: peer => {
      if (peer === peerMachineId) return { known: true, allow_file_bundle: true, reachable: true };
      if (peer === OTHER_MACHINE) return { known: true, allow_file_bundle: false, reachable: false, reason: "file_bundle_disabled" };
      return { known: false, allow_file_bundle: false, reachable: false, reason: "unknown_peer_machine" };
    },
    notifyLocalMember,
    now: () => nowRef.ms,
  });
  const sync = new BoardSyncCoordinator({
    store,
    engine,
    localMachineId: machineId,
    dispatcher,
    peerMachines: [peerMachineId],
    addressBookAdapter: addressBook,
    now: () => nowRef.ms,
  });

  return { db, privateRoot, addressBook, store, dispatcher, engine, sync };
}

describe("Wave 2 E2E: 5-member board lifecycle, alias isolation, cross-machine sync, file decoupling, tombstone & handle cleanup", () => {
  it("passes the full 5-member acceptance matrix end-to-end with zero active handle leaks", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "board-wave2-e2e-"));
    const uploadDir = path.join(tmpRoot, "allowed-uploads");
    const forbiddenDir = path.join(tmpRoot, "forbidden-uploads");
    const devSpoolDir = path.join(tmpRoot, "spool-dev");
    const trainSpoolDir = path.join(tmpRoot, "spool-train");
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.mkdirSync(forbiddenDir, { recursive: true });
    fs.mkdirSync(devSpoolDir, { recursive: true });
    fs.mkdirSync(trainSpoolDir, { recursive: true });

    const beforeResources = process.getActiveResourcesInfo();
    const nowRef = { ms: Date.UTC(2026, 10, 27, 9, 0, 0) };
    const bridge = createInMemoryRelayBridge({ devSpoolDir, trainSpoolDir });

    const devNotifications = [];
    const trainNotifications = [];
    let devCoreBOline = true;

    const dev = createNodeStack({
      machineId: DEV_MACHINE,
      peerMachineId: TRAIN_MACHINE,
      rootDir: tmpRoot,
      allowedUploadRoots: [uploadDir],
      transport: bridge.makeTransport(DEV_MACHINE),
      trustPeerSourceIdentity: true,
      superAdminIdentities: [DEV_CORE_A, DEV_CORE_B],
      nowRef,
      notifyLocalMember: async note => {
        if (note.member_key === identityKey(DEV_CORE_B) && !devCoreBOline) {
          throw new Error("member_temporarily_unreachable");
        }
        devNotifications.push(note);
        return { ok: true };
      },
    });
    const train = createNodeStack({
      machineId: TRAIN_MACHINE,
      peerMachineId: DEV_MACHINE,
      rootDir: tmpRoot,
      allowedUploadRoots: [uploadDir],
      transport: bridge.makeTransport(TRAIN_MACHINE),
      trustPeerSourceIdentity: true,
      superAdminIdentities: [DEV_CORE_A, DEV_CORE_B],
      nowRef,
      notifyLocalMember: async note => {
        trainNotifications.push(note);
        return { ok: true };
      },
    });

    async function pumpCrossMachine(rounds = 3) {
      for (let i = 0; i < rounds; i += 1) {
        await dev.sync.syncTick();
        await train.dispatcher.pollOnce();
        await train.sync.syncTick();
        await dev.dispatcher.pollOnce();
      }
    }

    try {
      // 1. Pre-occupy alias "核心协作板" in DEV_NAP_A's personal address book to verify #2 dedupe + privacy isolation
      dev.addressBook.saveBoardForIdentity(DEV_NAP_A, {
        machine_id: DEV_MACHINE,
        board_id: "pre-existing-other-board",
        baseTitle: "核心协作板",
      });

      const created = await dev.engine.invoke({
        action: "create",
        actorIdentity: DEV_CORE_A,
        params: {
          board_id: "board-five-party",
          title: "核心协作板",
          settings: {
            default_file_sync_machines: ["*"],
            auto_archive_days: 31,
            default_poll_interval_sec: 90,
          },
        },
      });
      assert.equal(created.board_id, "board-five-party");
      assert.equal(created.meta_version, 1);

      // Invite remaining 4 members (total 5: 4 dev + 1 training)
      const inviteRes = await dev.engine.invoke({
        action: "invite",
        actorIdentity: DEV_CORE_A,
        board: { machine_id: DEV_MACHINE, board_id: "board-five-party" },
        params: {
          members: [DEV_CORE_B, DEV_NAP_A, DEV_NAP_B, TRAIN_MAINT],
        },
      });
      // Privacy check: invite response MUST NOT expose DEV_NAP_A's personal "#2" alias suffix
      const serializedInvite = JSON.stringify(inviteRes);
      assert.equal(serializedInvite.includes("#2"), false, "invite response leaked invitee personal alias suffix #2");

      // Verify DEV_NAP_A did get "核心协作板#2" in their own address book
      const napAList = await dev.engine.invoke({
        action: "list",
        actorIdentity: DEV_NAP_A,
        params: {},
      });
      const napABoard = napAList.boards.find(item => item.board_id === "board-five-party");
      assert.ok(napABoard);
      assert.equal(napABoard.alias, "核心协作板#2");

      // R2-P1-1: Empty board (board_seq=0, meta_version=2) MUST sync to training immediately, then zero empty polls!
      await pumpCrossMachine(2);
      const trainListAfterCreate = await train.engine.invoke({
        action: "list",
        actorIdentity: TRAIN_MAINT,
        params: {},
      });
      const trainBoard = trainListAfterCreate.boards.find(item => item.board_id === "board-five-party");
      assert.ok(trainBoard, "empty board with remote invitee must sync via meta_version");
      assert.equal(trainBoard.alias, "核心协作板");

      const sentBeforeIdle = bridge.sentLog.length;
      const idleTickDev = await dev.sync.syncTick();
      const idleTickTrain = await train.sync.syncTick();
      assert.equal(idleTickDev.sent_frames, 0, "dev must emit 0 frames when no changes exist");
      assert.equal(idleTickTrain.sent_frames, 0, "train must emit 0 frames when no changes exist");
      assert.equal(bridge.sentLog.length, sentBeforeIdle);

      // 2. Non-member & unsubscribed permission guards + re-subscribe
      await assert.rejects(
        () => dev.engine.invoke({ action: "read", actorIdentity: OUTSIDER, board: { machine_id: DEV_MACHINE, board_id: "board-five-party" }, params: {} }),
        err => err instanceof CoreError && err.code === "forbidden",
      );
      await dev.engine.invoke({ action: "unsubscribe", actorIdentity: DEV_NAP_B, board: { machine_id: DEV_MACHINE, board_id: "board-five-party" }, params: {} });
      await assert.rejects(
        () => dev.engine.invoke({ action: "read", actorIdentity: DEV_NAP_B, board: { machine_id: DEV_MACHINE, board_id: "board-five-party" }, params: {} }),
        err => err instanceof CoreError && err.code === "forbidden",
      );
      await dev.engine.invoke({ action: "subscribe", actorIdentity: DEV_NAP_B, board: { machine_id: DEV_MACHINE, board_id: "board-five-party" }, params: {} });

      // 3. Multi-target @ mention penetrates mute & only without changing poll cadence, and read returns full board + author_keys filter
      await dev.engine.invoke({
        action: "set_subscription",
        actorIdentity: DEV_CORE_B,
        board: { machine_id: DEV_MACHINE, board_id: "board-five-party" },
        params: { delivery_mode: "poll", filter_mode: "mute", filter_targets: [identityKey(DEV_CORE_A)] },
      });
      await dev.engine.invoke({
        action: "set_subscription",
        actorIdentity: DEV_NAP_A,
        board: { machine_id: DEV_MACHINE, board_id: "board-five-party" },
        params: { delivery_mode: "poll", filter_mode: "only", filter_targets: [identityKey(TRAIN_MAINT)] },
      });

      await dev.engine.invoke({
        action: "post",
        actorIdentity: DEV_CORE_A,
        board: { machine_id: DEV_MACHINE, board_id: "board-five-party" },
        params: {
          body: "请两位查收第一条协同通报",
          mentions: [identityKey(DEV_CORE_B), identityKey(DEV_NAP_A)],
          origin_client_post_id: "post-mention-1",
        },
      });
      await dev.engine.invoke({
        action: "post",
        actorIdentity: DEV_CORE_A,
        board: { machine_id: DEV_MACHINE, board_id: "board-five-party" },
        params: {
          body: "第二条普通进展（无@）",
          origin_client_post_id: "post-plain-2",
        },
      });
      await dev.engine.localNotifyTick();
      const coreBMentionNote = devNotifications.find(n => n.member_key === identityKey(DEV_CORE_B) && n.kind === "poll_digest");
      const napAMentionNote = devNotifications.find(n => n.member_key === identityKey(DEV_NAP_A) && n.kind === "poll_digest");
      assert.ok(coreBMentionNote, "@ must penetrate mute filter");
      assert.ok(napAMentionNote, "@ must penetrate only filter");
      // Poll cadence unchanged
      assert.equal(dev.store.getMember("board-five-party", identityKey(DEV_CORE_B)).delivery_mode, "poll");

      // Read returns all posts regardless of mute/only, and author_keys filters cleanly
      const readAll = await dev.engine.invoke({
        action: "read",
        actorIdentity: DEV_CORE_B,
        board: { machine_id: DEV_MACHINE, board_id: "board-five-party" },
        params: {},
      });
      assert.equal(readAll.posts.length, 2);
      assert.ok(Buffer.byteLength(JSON.stringify(readAll), "utf8") < 9216);

      // 4. Real temp file upload (Fail-Closed outside allowedUploadRoots + sync_machines override + pending_capacity text/file decoupling)
      const badFile = path.join(forbiddenDir, "secret.txt");
      fs.writeFileSync(badFile, "nope", "utf8");
      await assert.rejects(
        () => dev.engine.invoke({
          action: "post",
          actorIdentity: DEV_CORE_A,
          board: { machine_id: DEV_MACHINE, board_id: "board-five-party" },
          params: {
            body: "try forbidden path",
            files: [{ path: badFile, name: "secret.txt" }],
            origin_client_post_id: "post-bad-file",
          },
        }),
        err => err instanceof CoreError && err.code === "upload_path_denied",
      );

      const goodFile = path.join(uploadDir, "metrics-report.txt");
      const goodPayload = "wave2-file-sync-payload-" + "A".repeat(2048);
      fs.writeFileSync(goodFile, goodPayload, "utf8");
      const expectedSha = crypto.createHash("sha256").update(Buffer.from(goodPayload, "utf8")).digest("hex");

      const postWithFile = await dev.engine.invoke({
        action: "post",
        actorIdentity: DEV_CORE_A,
        board: { machine_id: DEV_MACHINE, board_id: "board-five-party" },
        params: {
          body: "附带同步文件包",
          files: [{ path: goodFile, name: "metrics-report.txt", bundle_id: "pkg-1", bundle_label: "指标包" }],
          sync_machines: [TRAIN_MACHINE, OTHER_MACHINE],
          origin_client_post_id: "post-file-3",
        },
      });
      assert.equal(postWithFile.uploaded_files.length, 1);
      assert.equal(postWithFile.uploaded_files[0].sha256, expectedSha);
      assert.ok(fs.existsSync(postWithFile.uploaded_files[0].local_path));
      assert.deepEqual(postWithFile.target_sync_machines, [TRAIN_MACHINE]);
      assert.equal(postWithFile.unreachable_machines.some(m => m.machine_id === OTHER_MACHINE), true);

      // Simulate pending_capacity on file bundles -> text MUST still sync immediately via small frame!
      bridge.setForcePendingCapacity(true);
      await pumpCrossMachine(2);
      const trainReadBeforeFile = await train.engine.invoke({
        action: "read",
        actorIdentity: TRAIN_MAINT,
        board: { machine_id: DEV_MACHINE, board_id: "board-five-party" },
        params: {},
      });
      assert.equal(trainReadBeforeFile.posts.length, 3, "text posts must sync even when file bundle hits pending_capacity");

      // Release bundle capacity and advance clock past retry backoff -> file lands with verified SHA-256!
      bridge.setForcePendingCapacity(false);
      nowRef.ms += 120_000;
      await pumpCrossMachine(3);
      const trainReadAfterFile = await train.engine.invoke({
        action: "read",
        actorIdentity: TRAIN_MAINT,
        board: { machine_id: DEV_MACHINE, board_id: "board-five-party" },
        params: {},
      });
      const syncedFile = trainReadAfterFile.posts[2].files[0];
      assert.equal(syncedFile.local_status, "ready");
      assert.ok(syncedFile.local_path && fs.existsSync(syncedFile.local_path));
      assert.equal(
        crypto.createHash("sha256").update(fs.readFileSync(syncedFile.local_path)).digest("hex"),
        expectedSha,
      );

      // 5. Remote client post from training machine -> authoritative host seq assignment
      const remotePostRes = await train.engine.invoke({
        action: "post",
        actorIdentity: TRAIN_MAINT,
        board: { machine_id: DEV_MACHINE, board_id: "board-five-party" },
        params: {
          body: "训练机客机远程发帖验收",
          origin_client_post_id: "train-post-1",
        },
      });
      assert.equal(remotePostRes.seq, null);
      assert.equal(remotePostRes.pending_host_ack, true);
      await pumpCrossMachine(3);
      const devReadAfterRemote = await dev.engine.invoke({
        action: "read",
        actorIdentity: DEV_CORE_A,
        board: { machine_id: DEV_MACHINE, board_id: "board-five-party" },
        params: { author_keys: [identityKey(TRAIN_MAINT)] },
      });
      assert.equal(devReadAfterRemote.posts.length, 1);
      assert.equal(devReadAfterRemote.posts[0].body, "训练机客机远程发帖验收");

      // 6. Manual dissolve high-priority notification (with offline backlog delivery) + restore
      devCoreBOline = false;
      const dissolved = await dev.engine.invoke({
        action: "dissolve",
        actorIdentity: DEV_CORE_A,
        board: { machine_id: DEV_MACHINE, board_id: "board-five-party" },
        params: {},
      });
      assert.equal(dissolved.status, "archived");
      assert.equal(dissolved.archive_version, 1);
      await dev.engine.localNotifyTick();
      assert.equal(devNotifications.some(n => n.member_key === identityKey(DEV_CORE_B) && n.kind === "dissolved"), false);
      // DEV_CORE_B comes back online -> backlog delivered!
      devCoreBOline = true;
      nowRef.ms += 120_000;
      await dev.engine.localNotifyTick();
      assert.equal(devNotifications.some(n => n.member_key === identityKey(DEV_CORE_B) && n.kind === "dissolved"), true);
      await pumpCrossMachine(2);
      assert.equal(train.store.getBoard("board-five-party").status, "archived");

      const restored = await dev.engine.invoke({
        action: "restore",
        actorIdentity: DEV_CORE_B,
        board: { machine_id: DEV_MACHINE, board_id: "board-five-party" },
        params: {},
      });
      assert.equal(restored.status, "active");
      assert.ok(restored.state_version > dissolved.state_version);
      await pumpCrossMachine(2);
      assert.equal(train.store.getBoard("board-five-party").status, "active");

      // 7. 31-day simulated clock silent auto-archive (ZERO notifications!)
      const notifyCountBeforeAuto = devNotifications.length;
      nowRef.ms += 32 * 24 * 3600 * 1000;
      const autoArchived = dev.engine.runAutoArchiveSweep();
      assert.equal(autoArchived.archived_boards.some(b => b.board_id === "board-five-party"), true);
      await dev.engine.localNotifyTick();
      assert.equal(devNotifications.length, notifyCountBeforeAuto, "31d auto archive must NOT send any notifications");

      // 8. Any authenticated concrete conversation deletes archived board (no notification, tombstone prevents resurrection)
      const boardBeforeDelete = dev.store.getBoard("board-five-party");
      const deleted = await dev.engine.invoke({
        action: "delete_archived",
        actorIdentity: OUTSIDER,
        board: { machine_id: DEV_MACHINE, board_id: "board-five-party" },
        params: { expected_archive_version: boardBeforeDelete.archive_version },
      });
      assert.equal(deleted.deleted, true);
      await dev.engine.localNotifyTick();
      assert.equal(devNotifications.length, notifyCountBeforeAuto, "delete_archived must NOT notify members");
      await pumpCrossMachine(2);
      assert.equal(train.store.getBoard("board-five-party"), null);
      assert.ok(train.store.getTombstone("board-five-party"));

      // Late packet attempting to resurrect deleted board MUST be dropped by tombstone
      const lateRes = train.store.upsertBoardFromRemote({
        board_id: "board-five-party",
        host_machine_id: DEV_MACHINE,
        title: "幽灵复活板",
        status: "active",
        state_version: 999,
        meta_version: 999,
        archive_version: 0,
        settings: {},
        creator_key: identityKey(DEV_CORE_A),
        created_at: new Date(nowRef.ms).toISOString(),
        last_active_at: new Date(nowRef.ms).toISOString(),
        members: [],
      });
      assert.equal(lateRes.applied, false);
      assert.equal(train.store.getBoard("board-five-party"), null);

      // Reconcile pending file ops cleanly removes both active & archive board directories
      dev.store.reconcilePendingFileOps();
      assert.equal(fs.existsSync(path.join(dev.privateRoot, "boards", "board-five-party")), false);
      assert.equal(fs.existsSync(path.join(dev.privateRoot, "boards-archive", "board-five-party")), false);
    } finally {
      await dev.sync.close();
      await train.sync.close();
      await dev.dispatcher.close();
      await train.dispatcher.close();
      dev.db.close();
      train.db.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    await new Promise(resolve => setImmediate(resolve));
    const afterResources = process.getActiveResourcesInfo();
    assert.equal(afterResources.length - beforeResources.length, 0, `Active handles leaked: before=${JSON.stringify(beforeResources)}, after=${JSON.stringify(afterResources)}`);
  });

  it("enforces multi-board batching in 1 frame, trust_source_identity fail-closed, meta_version out-of-order protection, notification cancellation on delete_archived, and superAdmin injection", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "board-wave2-sec-"));
    const devSpoolDir = path.join(tmpRoot, "spool-dev");
    const trainSpoolDir = path.join(tmpRoot, "spool-train");
    fs.mkdirSync(devSpoolDir, { recursive: true });
    fs.mkdirSync(trainSpoolDir, { recursive: true });

    const nowRef = { ms: Date.UTC(2026, 10, 27, 10, 0, 0) };
    const bridge = createInMemoryRelayBridge({ devSpoolDir, trainSpoolDir });
    const devNotifies = [];
    let devNotifyOnline = true;

    // Dev intentionally sets trustPeerSourceIdentity = false first!
    const dev = createNodeStack({
      machineId: DEV_MACHINE,
      peerMachineId: TRAIN_MACHINE,
      rootDir: tmpRoot,
      allowedUploadRoots: [],
      transport: bridge.makeTransport(DEV_MACHINE),
      trustPeerSourceIdentity: false,
      superAdminIdentities: [DEV_CORE_B],
      nowRef,
      notifyLocalMember: async note => {
        if (!devNotifyOnline) throw new Error("offline_pending_backlog");
        devNotifies.push(note);
        return { ok: true };
      },
    });
    const train = createNodeStack({
      machineId: TRAIN_MACHINE,
      peerMachineId: DEV_MACHINE,
      rootDir: tmpRoot,
      allowedUploadRoots: [],
      transport: bridge.makeTransport(TRAIN_MACHINE),
      trustPeerSourceIdentity: false,
      superAdminIdentities: [DEV_CORE_B],
      nowRef,
      notifyLocalMember: async () => ({ ok: true }),
    });

    try {
      // Create 2 boards on dev and invite TRAIN_MAINT to both
      for (const bid of ["board-alpha", "board-beta"]) {
        await dev.engine.invoke({
          action: "create",
          actorIdentity: DEV_CORE_A,
          params: { board_id: bid, title: `板-${bid}` },
        });
        await dev.engine.invoke({
          action: "invite",
          actorIdentity: DEV_CORE_A,
          board: { machine_id: DEV_MACHINE, board_id: bid },
          params: { members: [TRAIN_MAINT] },
        });
        await dev.engine.invoke({
          action: "post",
          actorIdentity: DEV_CORE_A,
          board: { machine_id: DEV_MACHINE, board_id: bid },
          params: { body: `hello-${bid}`, origin_client_post_id: `p-${bid}-1` },
        });
      }

      // Single syncTick must batch both boards into 1 frame!
      const beforeFrames = bridge.sentLog.length;
      const tickRes = await dev.sync.syncTick();
      assert.equal(tickRes.sent_frames, 1, "two active boards for same peer must batch into 1 frame");
      assert.equal(bridge.sentLog.length - beforeFrames, 1);

      await train.dispatcher.pollOnce();
      await dev.dispatcher.pollOnce();
      assert.ok(train.store.getBoard("board-alpha"));
      assert.ok(train.store.getBoard("board-beta"));

      // Verify superAdmin DEV_CORE_B (not invited to board-alpha) can still list & read board-alpha
      const adminList = await dev.engine.invoke({ action: "list", actorIdentity: DEV_CORE_B, params: {} });
      assert.equal(adminList.boards.some(i => i.board_id === "board-alpha"), true);
      const adminRead = await dev.engine.invoke({
        action: "read",
        actorIdentity: DEV_CORE_B,
        board: { machine_id: DEV_MACHINE, board_id: "board-alpha" },
        params: {},
      });
      assert.equal(adminRead.posts.length, 1);

      // Update settings on dev (meta_version advances) -> sync -> then inject stale meta_version frame on train (must NOT roll back!)
      await dev.engine.invoke({
        action: "update_settings",
        actorIdentity: DEV_CORE_A,
        board: { machine_id: DEV_MACHINE, board_id: "board-alpha" },
        params: { settings: { auto_archive_days: 45 } },
      });
      await dev.sync.syncTick();
      await train.dispatcher.pollOnce();
      assert.equal(train.store.getBoard("board-alpha").settings.auto_archive_days, 45);
      const currentMetaVersion = train.store.getBoard("board-alpha").meta_version;

      train.store.upsertBoardFromRemote({
        board_id: "board-alpha",
        host_machine_id: DEV_MACHINE,
        title: "旧乱序标题",
        status: "active",
        state_version: 0,
        meta_version: currentMetaVersion - 1,
        archive_version: 0,
        settings: { auto_archive_days: 7, default_poll_interval_sec: 90, default_file_sync_machines: ["*"] },
        creator_key: identityKey(DEV_CORE_A),
        created_at: new Date(nowRef.ms).toISOString(),
        last_active_at: new Date(nowRef.ms).toISOString(),
        members: [],
      });
      assert.equal(train.store.getBoard("board-alpha").settings.auto_archive_days, 45, "stale meta_version must NOT overwrite newer settings");

      // trust_source_identity = false on dev MUST reject remote client_post_submit from train
      await train.engine.invoke({
        action: "post",
        actorIdentity: TRAIN_MAINT,
        board: { machine_id: DEV_MACHINE, board_id: "board-alpha" },
        params: { body: "untrusted-remote-post", origin_client_post_id: "untrusted-1" },
      });
      await train.sync.syncTick();
      await dev.dispatcher.pollOnce();
      const devAlphaPosts = dev.store.readPosts({ boardId: "board-alpha" });
      assert.equal(devAlphaPosts.some(p => p.body === "untrusted-remote-post"), false, "remote post must be rejected when trust_source_identity is false");

      // Dissolve board-beta while member is offline (leaves pending dissolved notification), then delete_archived -> pending notifications MUST become 'cancelled'
      devNotifyOnline = false;
      await dev.engine.invoke({
        action: "dissolve",
        actorIdentity: DEV_CORE_A,
        board: { machine_id: DEV_MACHINE, board_id: "board-beta" },
        params: {},
      });
      const betaArchived = dev.store.getBoard("board-beta");
      const delRes = await dev.engine.invoke({
        action: "delete_archived",
        actorIdentity: OUTSIDER,
        board: { machine_id: DEV_MACHINE, board_id: "board-beta" },
        params: { expected_archive_version: betaArchived.archive_version },
      });
      assert.equal(delRes.deleted, true);
      assert.ok(delRes.cancelled_notifications >= 1);
      devNotifyOnline = true;
      nowRef.ms += 120_000;
      await dev.engine.localNotifyTick();
      assert.equal(devNotifies.some(n => n.board_id === "board-beta" && n.kind === "dissolved"), false, "pending dissolved notification must be cancelled upon delete_archived");
    } finally {
      await dev.sync.close();
      await train.sync.close();
      await dev.dispatcher.close();
      await train.dispatcher.close();
      dev.db.close();
      train.db.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("wires openBoardRuntime cleanly into MessageStore.openBoardStore and persists boards/posts/aliases across restart", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "board-wave2-restart-"));
    const dbPath = path.join(tmpRoot, "core.sqlite");
    const privRoot = path.join(tmpRoot, "private");
    fs.mkdirSync(privRoot, { recursive: true });
    let store1 = null;
    let store2 = null;
    let rt1 = null;
    let rt2 = null;

    try {
      // Session 1: create board, invite DEV_CORE_B, post message, close cleanly
      store1 = new MessageStore({ filePath: dbPath });
      const book1 = store1.openAddressBook({ machineId: DEV_MACHINE });
      rt1 = openBoardRuntime({
        localMachineId: DEV_MACHINE,
        privateRoot: privRoot,
        allowedUploadRoots: [],
        openStore: create => store1.openBoardStore(create, { privateRoot: privRoot, allowedUploadRoots: [] }),
        addressBookAdapter: {
          saveBoardForIdentity: (m, b) => book1.saveBoardForIdentity(m, b),
          resolveDisplayName: (r, p) => book1.resolveDisplayName(r, p),
          list: p => book1.list(p),
        },
        relayDispatcher: null,
      });
      await rt1.start();
      await rt1.invoke({ action: "create", actorIdentity: DEV_CORE_A, params: { board_id: "persist-board", title: "重启验证板" } });
      await rt1.invoke({ action: "invite", actorIdentity: DEV_CORE_A, board: { machine_id: DEV_MACHINE, board_id: "persist-board" }, params: { members: [DEV_CORE_B] } });
      await rt1.invoke({ action: "post", actorIdentity: DEV_CORE_A, board: { machine_id: DEV_MACHINE, board_id: "persist-board" }, params: { body: "重启前留下的第一帖", origin_client_post_id: "restart-p1" } });
      await rt1.close();
      rt1 = null;
      store1.close();
      store1 = null;

      // Session 2: reopen same SQLite file and read everything back
      store2 = new MessageStore({ filePath: dbPath });
      const book2 = store2.openAddressBook({ machineId: DEV_MACHINE });
      rt2 = openBoardRuntime({
        localMachineId: DEV_MACHINE,
        privateRoot: privRoot,
        allowedUploadRoots: [],
        openStore: create => store2.openBoardStore(create, { privateRoot: privRoot, allowedUploadRoots: [] }),
        addressBookAdapter: {
          saveBoardForIdentity: (m, b) => book2.saveBoardForIdentity(m, b),
          resolveDisplayName: (r, p) => book2.resolveDisplayName(r, p),
          list: p => book2.list(p),
        },
        relayDispatcher: null,
      });
      await rt2.start();
      const bList = await rt2.invoke({ action: "list", actorIdentity: DEV_CORE_B, params: {} });
      assert.equal(bList.boards.length, 1);
      assert.equal(bList.boards[0].alias, "重启验证板");
      const bRead = await rt2.invoke({ action: "read", actorIdentity: DEV_CORE_B, board: { machine_id: DEV_MACHINE, board_id: "persist-board" }, params: {} });
      assert.equal(bRead.posts.length, 1);
      assert.equal(bRead.posts[0].body, "重启前留下的第一帖");
    } finally {
      try { await rt1?.close(); } catch {}
      try { await rt2?.close(); } catch {}
      try { store1?.close(); } catch {}
      try { store2?.close(); } catch {}
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    }
  });

  it("verifies W2-3 hardening: guest attachment post vs non-member zero-write, guest control params, pure-local 31d silent auto-archive, peerMachineIds/fileBundlePeers, no seq-skip on >1800 CQ, and notification receipt gating", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "board-wave2-w23-"));
    const uploadDir = path.join(tmpRoot, "uploads");
    const devSpoolDir = path.join(tmpRoot, "spool-dev");
    const trainSpoolDir = path.join(tmpRoot, "spool-train");
    fs.mkdirSync(uploadDir, { recursive: true });
    fs.mkdirSync(devSpoolDir, { recursive: true });
    fs.mkdirSync(trainSpoolDir, { recursive: true });

    const beforeResources = process.getActiveResourcesInfo();
    const nowRef = { ms: Date.UTC(2026, 10, 27, 11, 0, 0) };
    const bridge = createInMemoryRelayBridge({ devSpoolDir, trainSpoolDir });

    const TRAIN_OUTSIDER = Object.freeze({ machine_id: TRAIN_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-train-outsider" });
    const TRAIN_MEMBER_2 = Object.freeze({ machine_id: TRAIN_MACHINE, host: "codex", surface: "desktop", conversation_id: "conv-train-member-2" });

    let acceptNotify = false;
    const deliveredNotifies = [];
    const dev = createNodeStack({
      machineId: DEV_MACHINE,
      peerMachineId: TRAIN_MACHINE,
      rootDir: tmpRoot,
      allowedUploadRoots: [uploadDir],
      transport: bridge.makeTransport(DEV_MACHINE),
      trustPeerSourceIdentity: true,
      superAdminIdentities: [DEV_CORE_A],
      nowRef,
      notifyLocalMember: async note => {
        if (!acceptNotify) return { ok: false };
        deliveredNotifies.push(note);
        return { ok: true, message_id: `msg_${deliveredNotifies.length}` };
      },
    });
    const train = createNodeStack({
      machineId: TRAIN_MACHINE,
      peerMachineId: DEV_MACHINE,
      rootDir: tmpRoot,
      allowedUploadRoots: [uploadDir],
      transport: bridge.makeTransport(TRAIN_MACHINE),
      trustPeerSourceIdentity: true,
      superAdminIdentities: [DEV_CORE_A],
      nowRef,
      notifyLocalMember: async () => ({ ok: true }),
    });

    async function pump(rounds = 3) {
      for (let i = 0; i < rounds; i += 1) {
        await dev.sync.syncTick();
        await train.dispatcher.pollOnce();
        await train.sync.syncTick();
        await dev.dispatcher.pollOnce();
      }
    }

    let localStore = null;
    let localRt = null;
    try {
      // A. Pure-local openBoardRuntime (NO relayDispatcher AND NO notifyLocalMember) auto-archives after 31+ days with virtual clock!
      const localDbPath = path.join(tmpRoot, "pure-local.sqlite");
      const localPriv = path.join(tmpRoot, "pure-local-priv");
      fs.mkdirSync(localPriv, { recursive: true });
      localStore = new MessageStore({ filePath: localDbPath });
      const localBook = localStore.openAddressBook({ machineId: DEV_MACHINE });
      localRt = openBoardRuntime({
        localMachineId: DEV_MACHINE,
        privateRoot: localPriv,
        allowedUploadRoots: [],
        openStore: create => localStore.openBoardStore(create, { privateRoot: localPriv, allowedUploadRoots: [], now: () => nowRef.ms }),
        addressBookAdapter: {
          saveBoardForIdentity: (m, b) => localBook.saveBoardForIdentity(m, b),
          resolveDisplayName: (r, p) => localBook.resolveDisplayName(r, p),
          list: p => localBook.list(p),
        },
        relayDispatcher: null,
        notifyLocalMember: null,
        notifyIntervalMs: 30,
      });
      await localRt.start();
      await localRt.invoke({ action: "create", actorIdentity: DEV_CORE_A, params: { board_id: "pure-local-31d", title: "纯本机归档板" } });
      assert.equal(localRt.store.getBoard("pure-local-31d").status, "active");
      nowRef.ms += 32 * 24 * 3600 * 1000;
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(localRt.store.getBoard("pure-local-31d").status, "archived", "pure-local board must silently auto-archive without relayDispatcher or notifyLocalMember");
      assert.equal(localRt.store.getBoard("pure-local-31d").archive_reason, "auto_inactive_31d");
      await localRt.close();
      localRt = null;
      localStore.close();
      localStore = null;

      // B. Valid filename containing '..' (v1..v2.diff) + guest attachment upload success vs non-member zero-write!
      await dev.engine.invoke({ action: "create", actorIdentity: DEV_CORE_A, params: { board_id: "w23-hardening", title: "加固验证板" } });
      await dev.engine.invoke({ action: "invite", actorIdentity: DEV_CORE_A, board: { machine_id: DEV_MACHINE, board_id: "w23-hardening" }, params: { members: [DEV_CORE_B, TRAIN_MAINT] } });
      await pump(2);

      const dotFile = path.join(uploadDir, "v1..v2.diff");
      const dotBytes = Buffer.from("diff --git a/v1 b/v2\n+ok\n", "utf8");
      const dotSha = crypto.createHash("sha256").update(dotBytes).digest("hex");
      fs.writeFileSync(dotFile, dotBytes);

      // Guest authorized member posts with attachment -> lands on host with matching SHA-256 and cleans guest .outbox/!
      const guestPost = await train.engine.invoke({
        action: "post",
        actorIdentity: TRAIN_MAINT,
        board: { machine_id: DEV_MACHINE, board_id: "w23-hardening" },
        params: { body: "客机带附件成功对照", files: [{ path: dotFile, name: "v1..v2.diff" }], origin_client_post_id: "guest-att-ok-1" },
      });
      assert.equal(guestPost.pending_host_ack, true);
      await pump(3);
      const devPostsAfterGuest = await dev.engine.invoke({ action: "read", actorIdentity: DEV_CORE_A, board: { machine_id: DEV_MACHINE, board_id: "w23-hardening" }, params: {} });
      assert.equal(devPostsAfterGuest.posts.length, 1);
      assert.equal(devPostsAfterGuest.posts[0].files[0].safe_name, "v1..v2.diff");
      assert.equal(devPostsAfterGuest.posts[0].files[0].sha256, dotSha);
      assert.equal(fs.existsSync(train.store.getOutboxDir(guestPost.local_post_id)), false, "guest .outbox dir must be cleaned once acked");

      // Non-member guest attempts client_post_submit with attachment -> ZERO files written to host disk!
      const hostFilesDir = dev.store.getBoardFilesDir("w23-hardening");
      const filesBeforeAttack = fs.existsSync(hostFilesDir) ? fs.readdirSync(hostFilesDir) : [];
      const attackFile = path.join(uploadDir, "unauth.bin");
      fs.writeFileSync(attackFile, Buffer.from("forbidden-bytes", "utf8"));
      const attackSha = crypto.createHash("sha256").update(Buffer.from("forbidden-bytes", "utf8")).digest("hex");
      await dev.sync.handleInboundBoardDelta({
        frame: {
          relay_id: "rly-attack-1",
          op: "board_delta",
          from_machine: TRAIN_MACHINE,
          to_machine: DEV_MACHINE,
          source: "codex/desktop/conv-train-outsider",
          recipients: ["core/system/board_sync"],
          body: "",
          meta: { hop_count: 1, source_identity_verified: true, kind: "client_post_submit" },
          payload_json: {
            data: {
              kind: "client_post_submit",
              local_post_id: "attack-post-1",
              board_id: "w23-hardening",
              host_machine_id: DEV_MACHINE,
              actor: TRAIN_OUTSIDER,
              body: "unauth-attack",
              files: [{ file_id: "f-attack-1", safe_name: "unauth.bin", bytes: 15, sha256: attackSha }],
              origin_client_post_id: "attack-post-1",
            },
          },
        },
        staged_files: [{ name: "w23-hardening__f-attack-1", filePath: attackFile, bytes: 15, sha256: attackSha }],
        source_endpoint: "codex/desktop/conv-train-outsider",
        source_identity_verified: true,
        remotePrincipal: {
          from_machine: TRAIN_MACHINE,
          source_endpoint: "codex/desktop/conv-train-outsider",
          source_identity_verified: true,
          trust_source_identity: true,
        },
        reply: async () => ({ ok: true }),
      });
      const filesAfterAttack = fs.existsSync(hostFilesDir) ? fs.readdirSync(hostFilesDir) : [];
      assert.deepEqual(filesAfterAttack, filesBeforeAttack, "non-member guest attachment MUST NOT write any file onto host disk");

      // C. Guest control requests with params (update_settings & invite) take effect on host!
      await train.engine.invoke({
        action: "update_settings",
        actorIdentity: TRAIN_MAINT,
        board: { machine_id: DEV_MACHINE, board_id: "w23-hardening" },
        params: { settings: { auto_archive_days: 60 } },
      });
      await train.engine.invoke({
        action: "invite",
        actorIdentity: TRAIN_MAINT,
        board: { machine_id: DEV_MACHINE, board_id: "w23-hardening" },
        params: { members: [TRAIN_MEMBER_2] },
      });
      await pump(3);
      assert.equal(dev.store.getBoard("w23-hardening").settings.auto_archive_days, 60);
      assert.ok(dev.store.getMember("w23-hardening", identityKey(TRAIN_MEMBER_2)));

      // D. Notification watermark only advances when notifyLocalMember returns explicit acceptance receipt!
      await dev.engine.invoke({ action: "post", actorIdentity: DEV_CORE_A, board: { machine_id: DEV_MACHINE, board_id: "w23-hardening" }, params: { body: "测试提醒凭据", origin_client_post_id: "notify-gate-1" } });
      acceptNotify = false;
      await dev.engine.localNotifyTick();
      assert.equal(deliveredNotifies.length, 0);
      acceptNotify = true;
      nowRef.ms += 120_000;
      await dev.engine.localNotifyTick();
      assert.equal(deliveredNotifies.some(n => n.member_key === identityKey(DEV_CORE_B)), true, "notification must retry and deliver once explicit receipt is returned");

      // E. Dissolve immediately BEFORE first board_delta sync on a brand-new board -> guest receives cleanly without invalid_input!
      await dev.engine.invoke({ action: "create", actorIdentity: DEV_CORE_A, params: { board_id: "instant-dissolve", title: "秒解散板" } });
      await dev.engine.invoke({ action: "invite", actorIdentity: DEV_CORE_A, board: { machine_id: DEV_MACHINE, board_id: "instant-dissolve" }, params: { members: [DEV_CORE_B, TRAIN_MAINT] } });
      await dev.engine.invoke({ action: "dissolve", actorIdentity: DEV_CORE_B, board: { machine_id: DEV_MACHINE, board_id: "instant-dissolve" }, params: {} });
      await pump(2);
      const trnInstant = train.store.getBoard("instant-dissolve");
      assert.ok(trnInstant, "guest must materialize board even when dissolved before first delta");
      assert.equal(trnInstant.status, "archived");
      assert.equal(dev.store.getBoard("instant-dissolve").dissolved_by_key, identityKey(DEV_CORE_B));

      // F. pending_capacity + >1800 CQ large post MUST NOT skip seq 1 to deliver seq 2; once capacity returns, BOTH arrive!
      await dev.engine.invoke({ action: "create", actorIdentity: DEV_CORE_A, params: { board_id: "no-skip-big", title: "防跳号大帖板" } });
      await dev.engine.invoke({ action: "invite", actorIdentity: DEV_CORE_A, board: { machine_id: DEV_MACHINE, board_id: "no-skip-big" }, params: { members: [TRAIN_MAINT] } });
      await pump(2);
      await dev.engine.invoke({ action: "post", actorIdentity: DEV_CORE_A, board: { machine_id: DEV_MACHINE, board_id: "no-skip-big" }, params: { body: "超长正文-" + "长".repeat(2600), origin_client_post_id: "big-1" } });
      await dev.engine.invoke({ action: "post", actorIdentity: DEV_CORE_A, board: { machine_id: DEV_MACHINE, board_id: "no-skip-big" }, params: { body: "短帖二号", origin_client_post_id: "short-2" } });
      bridge.setForcePendingCapacity(true);
      await pump(2);
      const trnMid = train.store.readPosts({ boardId: "no-skip-big" });
      assert.equal(trnMid.length, 0, "short seq 2 must NOT jump ahead of blocked >1800 CQ seq 1");
      bridge.setForcePendingCapacity(false);
      nowRef.ms += 120_000;
      await pump(3);
      const trnRecovered = train.store.readPosts({ boardId: "no-skip-big" });
      assert.equal(trnRecovered.length, 2, "both seq 1 and seq 2 must arrive once file bundle capacity recovers");
    } finally {
      try { await localRt?.close(); } catch {}
      try { localStore?.close(); } catch {}
      await dev.sync.close();
      await train.sync.close();
      await dev.dispatcher.close();
      await train.dispatcher.close();
      dev.db.close();
      train.db.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    }

    await new Promise(resolve => setImmediate(resolve));
    const afterResources = process.getActiveResourcesInfo();
    assert.equal(afterResources.length - beforeResources.length, 0, `W2-3 hardening test leaked handles: before=${JSON.stringify(beforeResources)}, after=${JSON.stringify(afterResources)}`);
  });
});
