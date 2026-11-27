import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  BOARD_LIMITS,
  BoardStore,
  normalizeBoardSettings,
  normalizeMemberIdentity,
  sanitizeSafeFileName,
  validateBoardId,
} from "../src/board-store.mjs";
import { identityKey } from "../src/contracts.mjs";
import { MessageStore } from "../src/store.mjs";

function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

function makeIdentity(machineId, convId, host = "codex", surface = "desktop") {
  return {
    machine_id: machineId,
    host,
    surface,
    conversation_id: convId,
  };
}

function createHarness(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "board-store-test-"));
  const dbPath = join(root, "core.sqlite");
  const privateRoot = join(root, "private");
  const uploadRoot = join(root, "uploads");
  mkdirSync(privateRoot, { recursive: true });
  mkdirSync(uploadRoot, { recursive: true });

  let currentMs = options.initialNowMs ?? Date.parse("2026-11-27T08:00:00.000Z");
  const now = () => currentMs;
  const setNowMs = ms => { currentMs = ms; };

  const messageStore = options.useStandaloneDb ? null : new MessageStore({ filePath: dbPath });
  const standaloneDb = options.useStandaloneDb
    ? new DatabaseSync(dbPath, { enableForeignKeyConstraints: true, defensive: true })
    : null;
  if (standaloneDb) {
    standaloneDb.exec("PRAGMA foreign_keys = ON;");
  }

  const allowedUploadRoots = options.allowedUploadRoots !== undefined
    ? options.allowedUploadRoots
    : [uploadRoot];

  const boardStore = messageStore
    ? messageStore.openBoardStore(
      deps => new BoardStore({
        ...deps,
        privateRoot,
        allowedUploadRoots,
        limits: options.limits ?? {},
        now,
      }),
    )
    : new BoardStore({
      database: standaloneDb,
      privateRoot,
      allowedUploadRoots,
      limits: options.limits ?? {},
      now,
    });

  // 持有直连只读/核查句柄以便执行 EXPLAIN QUERY PLAN 与 PRAGMA 检查
  const inspectDb = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });

  t.after(() => {
    try { inspectDb.close(); } catch { /* ignore */ }
    try { messageStore?.close(); } catch { /* ignore */ }
    try { standaloneDb?.close(); } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  });

  return {
    root,
    dbPath,
    privateRoot,
    uploadRoot,
    messageStore,
    boardStore,
    inspectDb,
    now,
    setNowMs,
  };
}

// ==================== 1. 10 张 STRICT 表、约束与外键隔离 ====================

test("10 张 STRICT 表结构、约束、旧表零修改与 5 表零 ON DELETE CASCADE 验证", t => {
  const { inspectDb, boardStore } = createHarness(t);

  const expectedTables = [
    "boards",
    "board_members",
    "board_posts",
    "board_sync_state",
    "board_file_sync_queue",
    "board_remote_outbox",
    "board_tombstones",
    "board_tombstone_sync",
    "board_file_ops",
    "board_notifications",
  ];

  const masterRows = inspectDb.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table'",
  ).all();
  const sqlByName = new Map(masterRows.map(r => [r.name, r.sql]));

  for (const table of expectedTables) {
    assert.ok(sqlByName.has(table), `缺少表 ${table}`);
    assert.match(sqlByName.get(table), /\bSTRICT\s*$/i, `表 ${table} 必须为 STRICT`);
  }

  // 旧 6 表全部健在
  for (const legacy of [
    "messages",
    "deliveries",
    "message_events",
    "conversation_bindings",
    "channel_bindings",
    "channel_ingress_state",
  ]) {
    assert.ok(sqlByName.has(legacy), `旧表 ${legacy} 不应被改动或删除`);
  }

  // 严禁 ON DELETE CASCADE 的 5 张表
  const noCascadeTables = [
    "board_remote_outbox",
    "board_tombstones",
    "board_tombstone_sync",
    "board_file_ops",
    "board_notifications",
  ];
  for (const table of noCascadeTables) {
    const fks = inspectDb.prepare(`PRAGMA foreign_key_list(${table})`).all();
    assert.equal(fks.length, 0, `表 ${table} 不得包含外键级联删除`);
    assert.doesNotMatch(sqlByName.get(table), /ON\s+DELETE\s+CASCADE/i, `表 ${table} DDL 严禁出现 ON DELETE CASCADE`);
  }

  // 4 张子表应有 ON DELETE CASCADE
  for (const childTable of [
    "board_members",
    "board_posts",
    "board_sync_state",
    "board_file_sync_queue",
  ]) {
    const fks = inspectDb.prepare(`PRAGMA foreign_key_list(${childTable})`).all();
    assert.ok(fks.some(fk => fk.table === "boards" && fk.on_delete === "CASCADE"), `${childTable} 应级联绑定 boards`);
  }

  // 验证 boards.meta_version CHECK (meta_version >= 1) 与 STRICT 类型约束
  assert.throws(() => {
    inspectDb.prepare(`
      INSERT INTO boards (
        board_id, host_machine_id, title, status, state_version, meta_version,
        archive_version, settings_json, board_seq, creator_key, created_at, last_active_at
      ) VALUES ('b-bad-meta', 'dev', 'T', 'active', 0, 0, 0, '{}', 0, 'k', '2026-11-27T00:00:00Z', '2026-11-27T00:00:00Z')
    `).run();
  }, /CHECK constraint failed/i);

  assert.throws(() => {
    inspectDb.prepare(`
      INSERT INTO boards (
        board_id, host_machine_id, title, status, state_version, meta_version,
        archive_version, settings_json, board_seq, creator_key, created_at, last_active_at
      ) VALUES ('b-bad-type', 'dev', 'T', 'active', 'not-int', 1, 0, '{}', 0, 'k', '2026-11-27T00:00:00Z', '2026-11-27T00:00:00Z')
    `).run();
  }, /cannot store TEXT value in INTEGER column/i);

  // 验证 board_sync_state.last_acked_meta_version 默认值 0
  const creator = makeIdentity("dev", "conv-strict");
  boardStore.createBoard({ board_id: "strict-check", host_machine_id: "dev", title: "Strict", creator });
  inspectDb.prepare("INSERT INTO board_sync_state (board_id, peer_machine_id) VALUES ('strict-check', 'train')").run();
  const syncRow = boardStore.getSyncState("strict-check", "train");
  assert.equal(syncRow.last_acked_meta_version, 0);

  // 验证 board_notifications.status CHECK 支持 cancelled 且拒绝未知状态
  inspectDb.prepare(`
    INSERT INTO board_notifications (
      dedupe_key, board_id, member_key, member_json, kind, state_version, payload_json, status, created_at, updated_at
    ) VALUES ('k-ok', 'strict-check', 'm', '{}', 'dissolved', 1, '{}', 'cancelled', '2026-11-27T00:00:00Z', '2026-11-27T00:00:00Z')
  `).run();
  assert.throws(() => {
    inspectDb.prepare(`
      INSERT INTO board_notifications (
        dedupe_key, board_id, member_key, member_json, kind, state_version, payload_json, status, created_at, updated_at
      ) VALUES ('k-bad', 'strict-check', 'm', '{}', 'dissolved', 1, '{}', 'unknown_status', '2026-11-27T00:00:00Z', '2026-11-27T00:00:00Z')
    `).run();
  }, /CHECK constraint failed/i);

  // 事务严格同步：拒 async 函数与返回 Promise 的函数
  assert.throws(() => boardStore.runInTransaction(async () => 1), { code: "invalid_input" });
  assert.throws(() => boardStore.runInTransaction(() => Promise.resolve(1)), { code: "invalid_input" });
});

// ==================== 2. 7 项热路径索引 + 真实 EXPLAIN QUERY PLAN ====================

test("7 项热路径索引存在且真实 EXPLAIN QUERY PLAN 零全表 SCAN", t => {
  const { inspectDb, boardStore, now } = createHarness(t);

  // 插入多批数据，让 SQLite 优化器有真实统计信息
  const actorA = makeIdentity("dev", "conv-eqp-a");
  const actorB = makeIdentity("train", "conv-eqp-b");
  const actorAKey = identityKey(actorA);
  for (let i = 0; i < 15; i += 1) {
    const bid = `eqp-board-${i}`;
    boardStore.createBoard({
      board_id: bid,
      host_machine_id: "dev",
      title: `Board ${i}`,
      creator: actorA,
      nowIso: new Date(now() - i * 86400000).toISOString(),
    });
    boardStore.upsertMember(bid, actorB, { bumpMetaVersion: false });
    const fileSha = sha256Hex(`file-${i}`);
    boardStore.appendPost({
      boardId: bid,
      author: actorA,
      body: `post ${i}`,
      files: [{
        file_id: `f-${i}`,
        safe_name: `doc_${i}.txt`,
        bytes: 10,
        sha256: fileSha,
        rel_path: `boards/${bid}/files/f-${i}_doc_${i}.txt`,
        local_status: "ready",
        sync_machines: ["train"],
      }],
      originClientPostId: `origin-${i}`,
      stagedFileOps: [{
        op_id: `op-${i}`,
        staging_name: `op-${i}.tmp`,
        file_id: `f-${i}`,
        safe_name: `doc_${i}.txt`,
        sha256: fileSha,
        bytes: 10,
      }],
      fileSyncTargets: ["train"],
    });
    boardStore.enqueueRemoteOutbox({
      local_post_id: `lp-${i}`,
      dedupe_key: `dk-${i}`,
      board_id: bid,
      host_machine_id: "dev",
      author_key: actorAKey,
      op_kind: "client_post_submit",
      payload_json: { seq: i },
    });
    boardStore.enqueueNotification({
      dedupe_key: `notif-${i}`,
      board_id: bid,
      member_key: actorAKey,
      member_json: actorA,
      kind: "poll_digest",
      state_version: 0,
      payload_json: { count: 1 },
    });
  }
  // 混入历史已完成记录以贴近真实生产数据分布，便于优化器准确选择部分索引
  for (let i = 0; i < 60; i += 1) {
    inspectDb.prepare(`
      INSERT INTO board_file_ops (
        op_id, board_id, op_kind, state_version, status, created_at, updated_at
      ) VALUES (?, ?, 'move_to_archive', 1, 'done', ?, ?)
    `).run(`done-op-${i}`, `eqp-board-${i % 15}`, new Date(now()).toISOString(), new Date(now()).toISOString());
  }
  inspectDb.exec("ANALYZE;");

  // 检查 7 个索引都在 sqlite_master 中
  const indexNames = new Set(
    inspectDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(r => r.name),
  );
  const expectedIndexes = [
    "idx_boards_status_active",
    "idx_board_members_member",
    "idx_board_members_machine",
    "idx_board_file_sync_due",
    "idx_board_outbox_due",
    "idx_board_file_ops_pending",
    "idx_board_notifications_due",
  ];
  for (const idx of expectedIndexes) {
    assert.ok(indexNames.has(idx), `缺少必建索引 ${idx}`);
  }

  const hotQueries = [
    {
      index: "idx_boards_status_active",
      sql: "SELECT * FROM boards WHERE status = 'active' AND last_active_at <= ? ORDER BY last_active_at ASC",
      params: [new Date(now()).toISOString()],
    },
    {
      index: "idx_board_members_member",
      sql: "SELECT board_id FROM board_members WHERE member_key = ? AND subscription_state = 'active'",
      params: [actorAKey],
    },
    {
      index: "idx_board_members_machine",
      sql: "SELECT board_id, subscription_state FROM board_members WHERE machine_id = ? AND subscription_state = 'active'",
      params: ["train"],
    },
    {
      index: "idx_board_file_sync_due",
      sql: "SELECT * FROM board_file_sync_queue WHERE status = 'pending' AND peer_machine_id = ? AND next_retry_at <= ? ORDER BY next_retry_at ASC LIMIT 63",
      params: ["train", now()],
    },
    {
      index: "idx_board_outbox_due",
      sql: "SELECT * FROM board_remote_outbox WHERE status = 'pending' AND host_machine_id = ? AND next_retry_at <= ? ORDER BY next_retry_at ASC LIMIT 32",
      params: ["dev", now()],
    },
    {
      index: "idx_board_file_ops_pending",
      sql: "SELECT * FROM board_file_ops WHERE status = 'pending' AND board_id = ? ORDER BY state_version ASC, op_seq ASC",
      params: ["eqp-board-0"],
    },
    {
      index: "idx_board_notifications_due",
      sql: "SELECT * FROM board_notifications WHERE status = 'pending' AND next_retry_at <= ? ORDER BY next_retry_at ASC LIMIT 64",
      params: [now()],
    },
  ];

  for (const q of hotQueries) {
    const plan = inspectDb.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params);
    const details = plan.map(row => row.detail);
    for (const detail of details) {
      // 严禁出现无索引的裸全表 SCAN（如 "SCAN boards"）
      assert.doesNotMatch(
        detail,
        /^SCAN\s+\w+(?:\s+AS\s+\w+)?$/i,
        `查询出现全表 SCAN (${q.index}): ${detail}`,
      );
    }
    assert.ok(
      details.some(d => d.includes(q.index)),
      `查询未命中预期索引 ${q.index}，实际计划: ${JSON.stringify(details)}`,
    );
  }

  // 额外检查全表 pending file_ops 顺序扫描（含无 hint 与 INDEXED BY）均走部分索引而非全表 SCAN
  const allPendingPlan = inspectDb.prepare(
    "EXPLAIN QUERY PLAN SELECT * FROM board_file_ops WHERE status = 'pending' ORDER BY board_id ASC, state_version ASC, op_seq ASC",
  ).all().map(r => r.detail);
  assert.ok(
    allPendingPlan.some(d => d.includes("USING INDEX idx_board_file_ops_pending")),
    `pending file_ops 收敛应走部分索引，实际计划: ${JSON.stringify(allPendingPlan)}`,
  );
  const indexedPendingPlan = inspectDb.prepare(
    "EXPLAIN QUERY PLAN SELECT * FROM board_file_ops INDEXED BY idx_board_file_ops_pending WHERE status = 'pending' ORDER BY board_id ASC, state_version ASC, op_seq ASC",
  ).all().map(r => r.detail);
  assert.ok(
    indexedPendingPlan.some(d => d.includes("USING INDEX idx_board_file_ops_pending")),
    `INDEXED BY pending file_ops 应走部分索引，实际计划: ${JSON.stringify(indexedPendingPlan)}`,
  );
  assert.equal(indexedPendingPlan.some(d => d.includes("TEMP B-TREE")), false);
});

// ==================== 3. sanitizeSafeFileName 与基础校验器 ====================

test("sanitizeSafeFileName 拦截全部危险文件名并放行合法文件名", () => {
  const validCases = [
    "report.txt",
    "archive_2026-11.tar.gz",
    "中文说明 v1.pdf",
    "console.txt",
    "nullify.log",
    ".env",
    "a".repeat(120),
  ];
  for (const name of validCases) {
    assert.equal(sanitizeSafeFileName(name), name);
  }

  const invalidCases = [
    // 空串 / 空白 / 点
    "",
    "   ",
    ".",
    "..",
    // 非法路径/通配字符
    "a/b.txt",
    "a\\b.txt",
    "../secret.txt",
    "foo:bar.txt",
    "wild*.txt",
    "ask?.txt",
    'quote".txt',
    "lt<.txt",
    "gt>.txt",
    "pipe|.txt",
    // 控制字符
    "bad\u0000name.txt",
    "bad\u001fname.txt",
    "bad\u007fname.txt",
    "bad\u0085name.txt",
    // Unicode Bidi
    "pic\u202Egpj.exe",
    "ltr\u202Aname.txt",
    "iso\u2066name.txt",
    "rlm\u200Fname.txt",
    "alm\u061Cname.txt",
    // 尾随空格与尾随句点
    "trailing.txt ",
    "trailing.txt\t",
    "trailing.",
    "trailing.txt.",
    "foo..",
    // Windows 保留设备名（无扩展名、单扩展名、多扩展名、上标、尾随空格）
    "CON",
    "con",
    "CON.txt",
    "nul.log",
    "prn.tar.gz",
    "AUX.bin",
    "com0.txt",
    "com1.txt",
    "com9.log",
    "com\u00b9.bin",
    "COM\u00b2.txt",
    "lpt\u00b3.doc",
    "LPT1.tar.gz",
    "con .txt",
    // UTF-8 超过 120 字节
    "a".repeat(121),
    "中".repeat(41), // 123 UTF-8 bytes
  ];

  for (const bad of invalidCases) {
    assert.throws(
      () => sanitizeSafeFileName(bad),
      err => err?.code === "invalid_input",
      `应当拦截非法文件名: ${JSON.stringify(bad)}`,
    );
  }

  // validateBoardId / normalizeMemberIdentity / normalizeBoardSettings
  assert.equal(validateBoardId("board_01-alpha"), "board_01-alpha");
  assert.throws(() => validateBoardId("UPPER"), { code: "invalid_input" });
  assert.throws(() => validateBoardId("../escape"), { code: "invalid_input" });
  assert.throws(() => validateBoardId("a".repeat(129)), { code: "invalid_input" });

  const id = normalizeMemberIdentity(makeIdentity("dev", "c1"));
  assert.ok(Object.isFrozen(id));
  assert.throws(() => normalizeMemberIdentity({ machine_id: "dev", host: "codex", surface: "desktop", conversation_id: "*" }), { code: "invalid_input" });
  assert.throws(() => normalizeMemberIdentity({ machine_id: "dev", host: "codex", conversation_id: "c1" }), { code: "invalid_input" });

  const defSettings = normalizeBoardSettings();
  assert.deepEqual(defSettings, {
    default_file_sync_machines: ["*"],
    auto_archive_days: 31,
    default_poll_interval_sec: 90,
  });
  assert.throws(() => normalizeBoardSettings({ auto_archive_days: 0 }), { code: "invalid_input" });
  assert.throws(() => normalizeBoardSettings({ auto_archive_days: 3651 }), { code: "invalid_input" });
  assert.throws(() => normalizeBoardSettings({ default_poll_interval_sec: 59 }), { code: "invalid_input" });
  assert.throws(() => normalizeBoardSettings({ default_poll_interval_sec: 3601 }), { code: "invalid_input" });
  assert.throws(() => normalizeBoardSettings({ default_file_sync_machines: [] }), { code: "invalid_input" });
  assert.throws(() => normalizeBoardSettings({ default_file_sync_machines: ["*", "train"] }), { code: "invalid_input" });
});

// ==================== 4. stageLocalUploadFile TOCTOU、Fail-Closed 与配额 ====================

test("stageLocalUploadFile 默认 Fail-Closed、防软链/目录穿越、Windows 大小写归一与三重配额", t => {
  // 4.1 默认 allowedUploadRoots = [] 必须 Fail-Closed
  const deniedHarness = createHarness(t, { allowedUploadRoots: [] });
  const sampleFile = join(deniedHarness.root, "outside.txt");
  writeFileSync(sampleFile, "hello");
  assert.throws(
    () => deniedHarness.boardStore.stageLocalUploadFile({
      sourcePath: sampleFile,
      originalName: "outside.txt",
      boardId: "upload-board",
      fileId: "f1",
      opId: "op1",
    }),
    { code: "upload_path_denied" },
  );

  // 4.2 正常授权目录、前缀混淆拦截、目录 junction 逃逸拦截、文件软链拦截与三重配额
  const h = createHarness(t, {
    limits: {
      maxFileBytes: 100,
      maxBoardFilesBytes: 160,
      maxTotalFilesBytes: 220,
    },
  });
  const creator = makeIdentity("dev", "conv-u1");
  h.boardStore.createBoard({ board_id: "board-a", host_machine_id: "dev", title: "A", creator });
  h.boardStore.createBoard({ board_id: "board-b", host_machine_id: "dev", title: "B", creator });

  // 前缀混淆目录（uploads2 不属于 uploads）
  const siblingDir = join(h.root, "uploads2");
  mkdirSync(siblingDir, { recursive: true });
  const siblingFile = join(siblingDir, "secret.txt");
  writeFileSync(siblingFile, "secret");
  assert.throws(
    () => h.boardStore.stageLocalUploadFile({ sourcePath: siblingFile, boardId: "board-a", fileId: "f-sib", opId: "op-sib" }),
    { code: "upload_path_denied" },
  );

  // 目录 junction 逃逸（在 Windows 非管理员下稳定可用）
  const escapeDir = join(h.root, "outside-secret");
  mkdirSync(escapeDir, { recursive: true });
  writeFileSync(join(escapeDir, "leak.txt"), "top-secret");
  const junctionPath = join(h.uploadRoot, "link-escape");
  symlinkSync(escapeDir, junctionPath, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => h.boardStore.stageLocalUploadFile({
      sourcePath: join(junctionPath, "leak.txt"),
      boardId: "board-a",
      fileId: "f-junc",
      opId: "op-junc",
    }),
    { code: "upload_path_denied" },
  );

  // 文件软链拦截（若当前 OS 权限允许建文件软链则实测拦截）
  const legitInside = join(h.uploadRoot, "inside.txt");
  writeFileSync(legitInside, "1234567890");
  const fileLink = join(h.uploadRoot, "file-symlink.txt");
  let createdFileSymlink = false;
  try {
    symlinkSync(legitInside, fileLink, "file");
    createdFileSymlink = true;
  } catch (err) {
    if (err?.code !== "EPERM") throw err;
  }
  if (createdFileSymlink) {
    assert.throws(
      () => h.boardStore.stageLocalUploadFile({
        sourcePath: fileLink,
        boardId: "board-a",
        fileId: "f-sym",
        opId: "op-sym",
      }),
      { code: "upload_path_denied" },
    );
  }

  // Windows 大小写归一合法路径校验
  const validPathVariant = process.platform === "win32" ? legitInside.toUpperCase() : legitInside;
  const staged1 = h.boardStore.stageLocalUploadFile({
    sourcePath: validPathVariant,
    originalName: "report_1.txt",
    boardId: "board-a",
    fileId: "f1",
    opId: "op1",
  });
  assert.equal(staged1.bytes, 10);
  assert.equal(staged1.sha256, sha256Hex("1234567890"));
  assert.equal(staged1.rel_path, "boards/board-a/files/f1_report_1.txt");
  assert.ok(existsSync(join(h.boardStore.getStagingDir(), staged1.staging_name)));

  // 单文件超限（>100B）
  const tooBigFile = join(h.uploadRoot, "big.bin");
  writeFileSync(tooBigFile, Buffer.alloc(101, 0x41));
  assert.throws(
    () => h.boardStore.stageLocalUploadFile({ sourcePath: tooBigFile, boardId: "board-a", fileId: "fbig", opId: "opbig" }),
    { code: "board_file_too_large" },
  );
  assert.equal(existsSync(join(h.boardStore.getStagingDir(), "opbig.tmp")), false);

  // 先落盘 90B 到 board-a，再尝试落盘 80B 触单板 160B 限额
  const f90 = join(h.uploadRoot, "f90.bin");
  const f80 = join(h.uploadRoot, "f80.bin");
  writeFileSync(f90, Buffer.alloc(90, 0x42));
  writeFileSync(f80, Buffer.alloc(80, 0x43));

  const s90 = h.boardStore.stageLocalUploadFile({ sourcePath: f90, boardId: "board-a", fileId: "f90", opId: "op90" });
  const { file_op_ids } = h.boardStore.appendPost({
    boardId: "board-a",
    author: creator,
    body: "file 90",
    files: [{
      file_id: s90.file_id,
      safe_name: s90.safe_name,
      bytes: s90.bytes,
      sha256: s90.sha256,
      rel_path: s90.rel_path,
    }],
    originClientPostId: "p90",
    stagedFileOps: [s90],
  });
  const committed = h.boardStore.commitStagedFileOps(file_op_ids);
  assert.deepEqual(committed.committed, ["op90"]);
  assert.equal(h.boardStore.getBoardFilesTotalBytes("board-a"), 90);

  // 90 + 80 = 170 > 160 (maxBoardFilesBytes)
  assert.throws(
    () => h.boardStore.stageLocalUploadFile({ sourcePath: f80, boardId: "board-a", fileId: "f80", opId: "op80" }),
    { code: "board_quota_exceeded" },
  );

  // 换到 board-b 放 80B 成功（全局此时: staged1=10 + board-a=90 + new=80 = 180 <= 220）
  const s80b = h.boardStore.stageLocalUploadFile({ sourcePath: f80, boardId: "board-b", fileId: "f80b", opId: "op80b" });
  assert.equal(s80b.bytes, 80);

  // 再往 board-b 放 80B：全局 10 + 90 + 80 + 80 = 260 > 220 (maxTotalFilesBytes)
  assert.throws(
    () => h.boardStore.stageLocalUploadFile({ sourcePath: f80, boardId: "board-b", fileId: "f80b2", opId: "op80b2" }),
    { code: "board_quota_exceeded" },
  );

  // stageOutboxAttachment 走同等安全校验（先删掉 staging 中未用的 op80b.tmp 腾空间）
  rmSync(join(h.boardStore.getStagingDir(), "op80b.tmp"), { force: true });
  const ob = h.boardStore.stageOutboxAttachment({
    sourcePath: legitInside,
    originalName: "offline_attach.txt",
    localPostId: "lp-1",
    fileId: "of1",
  });
  assert.equal(ob.bytes, 10);
  assert.equal(ob.sha256, sha256Hex("1234567890"));
  assert.ok(existsSync(ob.outbox_path));
});

// ==================== 5. stageRemoteFileBufferOrPath 独占写盘与哈希验签 ====================

test("stageRemoteFileBufferOrPath 独占写盘、重算验签、同哈希幂等与异哈希冲突", t => {
  const { boardStore, root } = createHarness(t);
  const payload = Buffer.from("remote-file-payload-content", "utf8");
  const goodSha = sha256Hex(payload);

  // 1) Buffer 模式正常写入
  const res1 = boardStore.stageRemoteFileBufferOrPath({
    buffer: payload,
    boardId: "rx-board",
    fileId: "rf1",
    safeName: "notes.md",
    expectedSha256: goodSha,
    expectedBytes: payload.byteLength,
  });
  assert.equal(res1.sha256, goodSha);
  assert.equal(res1.bytes, payload.byteLength);
  assert.equal(readFileSync(res1.local_path, "utf8"), "remote-file-payload-content");

  // 2) 同哈希幂等重试成功
  const res2 = boardStore.stageRemoteFileBufferOrPath({
    buffer: payload,
    boardId: "rx-board",
    fileId: "rf1",
    safeName: "notes.md",
    expectedSha256: goodSha,
    expectedBytes: payload.byteLength,
  });
  assert.deepEqual(res2, res1);

  // 3) 源内容与 expectedSha256 不匹配 → 抛 board_file_hash_conflict
  assert.throws(
    () => boardStore.stageRemoteFileBufferOrPath({
      buffer: Buffer.from("corrupted-content", "utf8"),
      boardId: "rx-board",
      fileId: "rf2",
      safeName: "bad.md",
      expectedSha256: goodSha,
    }),
    { code: "board_file_hash_conflict" },
  );

  // 4) 本地已存在不同内容的文件（复用同 fileId+safeName 但换预期哈希与内容）→ 抛 board_file_hash_conflict 且原文件不被覆写
  const otherPayload = Buffer.from("different-payload", "utf8");
  assert.throws(
    () => boardStore.stageRemoteFileBufferOrPath({
      buffer: otherPayload,
      boardId: "rx-board",
      fileId: "rf1",
      safeName: "notes.md",
      expectedSha256: sha256Hex(otherPayload),
      expectedBytes: otherPayload.byteLength,
    }),
    { code: "board_file_hash_conflict" },
  );
  assert.equal(readFileSync(res1.local_path, "utf8"), "remote-file-payload-content");

  // 5) sourcePath 模式正常写入且校验 expectedBytes 不匹配失败
  const spoolFile = join(root, "spool-piece.bin");
  writeFileSync(spoolFile, payload);
  const res3 = boardStore.stageRemoteFileBufferOrPath({
    sourcePath: spoolFile,
    boardId: "rx-board",
    fileId: "rf3",
    safeName: "from_spool.bin",
    expectedSha256: goodSha,
    expectedBytes: payload.byteLength,
  });
  assert.equal(readFileSync(res3.local_path, "utf8"), "remote-file-payload-content");

  assert.throws(
    () => boardStore.stageRemoteFileBufferOrPath({
      sourcePath: spoolFile,
      boardId: "rx-board",
      fileId: "rf4",
      safeName: "bad_len.bin",
      expectedSha256: goodSha,
      expectedBytes: payload.byteLength + 1,
    }),
    { code: "board_file_hash_conflict" },
  );
});

// ==================== 6. deleteArchivedBoard 单事务原子语义 ====================

test("deleteArchivedBoard 单事务写墓碑/同步/清理任务、取消残留通知并删 boards 且不误删 5 表", t => {
  const { boardStore, inspectDb } = createHarness(t);
  const creator = makeIdentity("dev", "conv-del-1");
  const remoteMember = makeIdentity("train", "conv-del-2");
  const creatorKey = identityKey(creator);

  boardStore.createBoard({ board_id: "del-board", host_machine_id: "dev", title: "Secret Board", creator });
  boardStore.upsertMember("del-board", remoteMember);
  boardStore.appendPost({
    boardId: "del-board",
    author: creator,
    body: "hello before dissolve",
    originClientPostId: "post-del-1",
  });

  // 塞一条 pending 通知、一条 sent 通知与一条 remote_outbox
  boardStore.enqueueNotification({
    dedupe_key: "ev:del-board:1",
    board_id: "del-board",
    member_key: creatorKey,
    member_json: creator,
    kind: "event_post",
    state_version: 0,
    payload_json: { seq: 1 },
  });
  boardStore.enqueueNotification({
    dedupe_key: "ev:del-board:sent",
    board_id: "del-board",
    member_key: creatorKey,
    member_json: creator,
    kind: "event_post",
    state_version: 0,
    payload_json: { seq: 1 },
  });
  boardStore.markNotificationStatus("ev:del-board:sent", { status: "sent" });
  boardStore.enqueueRemoteOutbox({
    local_post_id: "lp-del-1",
    dedupe_key: "dk-del-1",
    board_id: "del-board",
    host_machine_id: "dev",
    author_key: creatorKey,
    op_kind: "client_post_submit",
    payload_json: { body: "queued" },
  });

  // 活跃板不允许直接永久删除
  assert.throws(
    () => boardStore.deleteArchivedBoard({ boardId: "del-board", expectedArchiveVersion: 1, actorKey: creatorKey }),
    { code: "board_not_archived" },
  );

  // 归档（仅给本机成员写入 1 条 dissolved pending 通知，绝不给远端 train 成员入队）
  const archived = boardStore.archiveBoard({
    boardId: "del-board",
    reason: "manual_dissolve",
    actorKey: creatorKey,
  });
  assert.equal(archived.board.status, "archived");
  assert.equal(archived.board.state_version, 1);
  assert.equal(archived.board.archive_version, 1);
  assert.equal(archived.board.dissolved_by_key, creatorKey);
  const dissolvedNotifs = inspectDb.prepare(
    "SELECT * FROM board_notifications WHERE board_id = 'del-board' AND kind = 'dissolved'",
  ).all();
  assert.equal(dissolvedNotifs.length, 1);
  assert.equal(dissolvedNotifs[0].member_key, creatorKey);
  assert.equal(dissolvedNotifs[0].dedupe_key, `dissolved:del-board:1:${creatorKey}`);

  // 版本不匹配失败，且不泄露敏感信息
  assert.throws(
    () => boardStore.deleteArchivedBoard({ boardId: "del-board", expectedArchiveVersion: 2, actorKey: creatorKey }),
    err => err?.code === "board_version_mismatch" && !err.message.includes("Secret Board") && Object.keys(err.details).length === 0,
  );
  assert.throws(
    () => boardStore.deleteArchivedBoard({
      boardId: "del-board",
      expectedArchiveVersion: 1,
      expectedStateVersion: 99,
      actorKey: creatorKey,
    }),
    { code: "board_version_mismatch" },
  );

  // 正确永久删除
  const delRes = boardStore.deleteArchivedBoard({
    boardId: "del-board",
    expectedArchiveVersion: 1,
    expectedStateVersion: 1,
    actorKey: creatorKey,
    peerMachines: ["gpu-node"],
  });
  assert.equal(delRes.tombstone.board_id, "del-board");
  assert.equal(delRes.tombstone.final_state_version, 2);
  // 1 条原 pending event_post + 1 条本机 dissolved pending = 2 条全部 cancelled
  assert.equal(delRes.cancelled_notifications, 2);

  // boards 及其 4 张级联子表已被清理
  assert.equal(boardStore.getBoard("del-board"), null);
  assert.equal(inspectDb.prepare("SELECT count(*) AS c FROM board_members WHERE board_id = 'del-board'").get().c, 0);
  assert.equal(inspectDb.prepare("SELECT count(*) AS c FROM board_posts WHERE board_id = 'del-board'").get().c, 0);

  // 5 张独立持久化表完好无损
  assert.ok(boardStore.getTombstone("del-board"));
  const trainTombstones = boardStore.listPendingTombstoneSyncs("train");
  const gpuTombstones = boardStore.listPendingTombstoneSyncs("gpu-node");
  assert.equal(trainTombstones.length, 1);
  assert.equal(gpuTombstones.length, 1);
  assert.equal(trainTombstones[0].final_state_version, 2);
  assert.equal(boardStore.ackTombstoneSync("del-board", "train", 2), true);
  assert.equal(boardStore.listPendingTombstoneSyncs("train").length, 0);

  const purgeOp = inspectDb.prepare("SELECT * FROM board_file_ops WHERE op_id = ?").get(delRes.file_op_id);
  assert.equal(purgeOp.op_kind, "purge_archived_dir");
  assert.equal(purgeOp.status, "pending");
  assert.equal(purgeOp.state_version, 2);

  // sent 通知保持 sent，所有原 pending 变为 cancelled
  assert.equal(boardStore.listDueNotifications().length, 0);
  const notifStatuses = inspectDb.prepare(
    "SELECT status, count(*) AS c FROM board_notifications WHERE board_id = 'del-board' GROUP BY status",
  ).all();
  const statusMap = Object.fromEntries(notifStatuses.map(r => [r.status, r.c]));
  assert.equal(statusMap.cancelled, 2);
  assert.equal(statusMap.sent, 1);

  // outbox 记录保留且标记 rejected_deleted
  const outboxRow = inspectDb.prepare("SELECT status FROM board_remote_outbox WHERE local_post_id = 'lp-del-1'").get();
  assert.equal(outboxRow.status, "rejected_deleted");
});

// ==================== 7. reconcilePendingFileOps 崩溃续接全场景 ====================

test("reconcilePendingFileOps 崩溃续接（staging 未 rename、半归档合并、墓碑清双目录、防自由路径删除与孤儿清理）", t => {
  const { boardStore, inspectDb, uploadRoot, root, now, setNowMs } = createHarness(t);
  const creator = makeIdentity("dev", "conv-rec-1");
  const creatorKey = identityKey(creator);

  // 场景 A：staging 已写未 rename 崩溃续接
  boardStore.createBoard({ board_id: "crash-stage", host_machine_id: "dev", title: "Crash Stage", creator });
  const srcA = join(uploadRoot, "a.txt");
  writeFileSync(srcA, "staging-recovery-payload");
  const stagedA = boardStore.stageLocalUploadFile({
    sourcePath: srcA,
    originalName: "a.txt",
    boardId: "crash-stage",
    fileId: "fa1",
    opId: "op-stage-a",
  });
  boardStore.appendPost({
    boardId: "crash-stage",
    author: creator,
    body: "staged but crashed before rename",
    files: [{
      file_id: stagedA.file_id,
      safe_name: stagedA.safe_name,
      bytes: stagedA.bytes,
      sha256: stagedA.sha256,
      rel_path: stagedA.rel_path,
    }],
    originClientPostId: "crash-p1",
    stagedFileOps: [stagedA],
  });
  // 不调 commitStagedFileOps，模拟进程崩溃后重启调用 reconcilePendingFileOps
  const recA = boardStore.reconcilePendingFileOps();
  assert.equal(recA.processed, 1);
  assert.equal(recA.errors.length, 0);
  assert.equal(existsSync(join(boardStore.getStagingDir(), stagedA.staging_name)), false);
  assert.equal(readFileSync(stagedA.local_path, "utf8"), "staging-recovery-payload");

  // 场景 B：move_to_archive 未完成崩溃（并制造双目录半迁移状态）
  boardStore.archiveBoard({ boardId: "crash-stage", reason: "manual_dissolve", actorKey: creatorKey });
  // 模拟 archiveDir 已建了一半含同文件，但 activeDir 还有另一份文件未迁完
  const archiveFilesDir = join(boardStore.getBoardArchiveDir("crash-stage"), "files");
  mkdirSync(archiveFilesDir, { recursive: true });
  writeFileSync(join(archiveFilesDir, "fa1_a.txt"), "staging-recovery-payload");
  writeFileSync(join(boardStore.getBoardFilesDir("crash-stage"), "fa2_extra.txt"), "extra-active-file");

  const recB = boardStore.reconcilePendingFileOps();
  assert.equal(recB.processed, 1);
  assert.equal(recB.errors.length, 0);
  assert.equal(existsSync(join(boardStore.getBoardFilesDir("crash-stage"), "..")), false);
  assert.equal(readFileSync(join(archiveFilesDir, "fa1_a.txt"), "utf8"), "staging-recovery-payload");
  assert.equal(readFileSync(join(archiveFilesDir, "fa2_extra.txt"), "utf8"), "extra-active-file");

  // 场景 C：归档后又恢复再崩溃，旧 move_to_archive 未执行即应标 superseded，最终对齐为 active
  boardStore.createBoard({ board_id: "crash-flip", host_machine_id: "dev", title: "Flip", creator });
  mkdirSync(boardStore.getBoardFilesDir("crash-flip"), { recursive: true });
  writeFileSync(join(boardStore.getBoardFilesDir("crash-flip"), "f1_keep.txt"), "keep-me");
  boardStore.archiveBoard({ boardId: "crash-flip", reason: "manual_dissolve", actorKey: creatorKey });
  // 未 reconcile 就立刻 restore（产生两条 pending op：v1 move_to_archive + v2 restore_from_archive）
  boardStore.restoreBoard({ boardId: "crash-flip", actorKey: creatorKey });
  const recC = boardStore.reconcilePendingFileOps();
  assert.equal(recC.superseded, 1);
  assert.equal(recC.processed, 1);
  assert.equal(readFileSync(join(boardStore.getBoardFilesDir("crash-flip"), "f1_keep.txt"), "utf8"), "keep-me");

  // 场景 D：永久删除命中墓碑，同时残留 active 与 archive 双目录及旧 pending staging 文件
  mkdirSync(boardStore.getBoardFilesDir("crash-stage"), { recursive: true });
  writeFileSync(join(boardStore.getBoardFilesDir("crash-stage"), "stale_active.txt"), "stale");
  const stagedDoomed = boardStore.stageLocalUploadFile({
    sourcePath: srcA,
    originalName: "doomed.txt",
    boardId: "crash-stage",
    fileId: "fdoom",
    opId: "op-doomed",
  });
  // 手工塞一条残留的 pending stage_file op 模拟崩溃并发
  inspectDb.prepare(`
    INSERT INTO board_file_ops (
      op_id, board_id, op_kind, staging_name, file_id, safe_name, expected_sha256, expected_bytes,
      state_version, status, created_at, updated_at
    ) VALUES (?, 'crash-stage', 'stage_file', ?, 'fdoom', 'doomed.txt', ?, ?, 1, 'pending', ?, ?)
  `).run(stagedDoomed.op_id, stagedDoomed.staging_name, stagedDoomed.sha256, stagedDoomed.bytes, new Date(now()).toISOString(), new Date(now()).toISOString());

  boardStore.deleteArchivedBoard({
    boardId: "crash-stage",
    expectedArchiveVersion: 1,
    actorKey: creatorKey,
  });
  const recD = boardStore.reconcilePendingFileOps();
  assert.equal(recD.superseded, 1);
  assert.equal(recD.processed, 1);
  assert.equal(recD.errors.length, 0);
  assert.equal(existsSync(join(boardStore.getBoardFilesDir("crash-stage"), "..")), false);
  assert.equal(existsSync(boardStore.getBoardArchiveDir("crash-stage")), false);
  assert.equal(existsSync(join(boardStore.getStagingDir(), stagedDoomed.staging_name)), false);

  // 场景 E：数据库被篡改写入恶意 board_id，绝不信任自由路径执行 fs.rm
  const decoyDir = join(root, "precious-outside");
  mkdirSync(decoyDir, { recursive: true });
  writeFileSync(join(decoyDir, "keep.txt"), "must-survive");
  inspectDb.prepare(`
    INSERT INTO board_file_ops (
      op_id, board_id, op_kind, state_version, status, created_at, updated_at
    ) VALUES ('evil-op', '../../precious-outside', 'purge_archived_dir', 9, 'pending', ?, ?)
  `).run(new Date(now()).toISOString(), new Date(now()).toISOString());
  const recE = boardStore.reconcilePendingFileOps();
  assert.equal(recE.errors.length, 1);
  assert.equal(readFileSync(join(decoyDir, "keep.txt"), "utf8"), "must-survive");

  // 场景 F：超 7 天 done/superseded 记录清理与孤儿 .staging/*.tmp 清理（保留 pending 引用的 staging）
  const orphanTmp = join(boardStore.getStagingDir(), "orphan-old.tmp");
  const activeTmp = join(boardStore.getStagingDir(), "active-ref.tmp");
  mkdirSync(boardStore.getStagingDir(), { recursive: true });
  writeFileSync(orphanTmp, "orphan");
  writeFileSync(activeTmp, "still-referenced");
  // 将 orphanTmp 的 mtime 改到 1 小时前，activeTmp 挂到 pending op
  const oldDate = new Date(now() - 3600 * 1000);
  utimesSync(orphanTmp, oldDate, oldDate);
  inspectDb.prepare(`
    INSERT INTO board_file_ops (
      op_id, board_id, op_kind, staging_name, file_id, safe_name, expected_sha256, expected_bytes,
      state_version, status, created_at, updated_at
    ) VALUES ('pending-ref', 'crash-flip', 'stage_file', 'active-ref.tmp', 'fref', 'ref.txt', ?, 16, 2, 'pending', ?, ?)
  `).run(sha256Hex("still-referenced"), new Date(now()).toISOString(), new Date(now()).toISOString());

  // 推进时钟 8 天，再触发 reconcile（注意 active-ref.tmp 会被正常收敛落盘，再放一个未来的 pending 检查）
  setNowMs(now() + 8 * 86400000);
  const recF = boardStore.reconcilePendingFileOps();
  assert.ok(recF.cleaned_done >= 4, `应清理超 7 天 done/superseded 记录，实际 ${recF.cleaned_done}`);
  assert.equal(recF.cleaned_staging, 1);
  assert.equal(existsSync(orphanTmp), false);
  assert.equal(existsSync(join(boardStore.getBoardFilesDir("crash-flip"), "fref_ref.txt")), true);
});

// ==================== 8. upsertBoardFromRemote 单调状态机与墓碑防复活 ====================

test("upsertBoardFromRemote 墓碑防复活、state_version 单调与 meta_version 防乱序回退", t => {
  const { boardStore } = createHarness(t);
  const hostActor = makeIdentity("train", "conv-remote-host");
  const localMember = makeIdentity("dev", "conv-local-sub");
  const extraMember = makeIdentity("dev", "conv-local-extra");
  const hostKey = identityKey(hostActor);
  const localKey = identityKey(localMember);

  // 1) 首次同步创建
  const r1 = boardStore.upsertBoardFromRemote({
    board_id: "remote-sync-1",
    host_machine_id: "train",
    title: "Initial Title",
    status: "active",
    state_version: 0,
    meta_version: 1,
    archive_version: 0,
    settings: { auto_archive_days: 31 },
    creator_key: hostKey,
    created_at: "2026-11-27T01:00:00.000Z",
    last_active_at: "2026-11-27T01:00:00.000Z",
    members: [hostActor, localMember],
  });
  assert.equal(r1.applied, true);
  assert.equal(r1.created, true);
  assert.equal(r1.newly_added_members.length, 2);

  // 本地读者推进已读水位
  boardStore.updateMemberReadCursor("remote-sync-1", localKey, 5);

  // 2) meta_version 升至 2：更新标题、设置并新增成员，且保留本地成员 last_read_seq
  const r2 = boardStore.upsertBoardFromRemote({
    board_id: "remote-sync-1",
    host_machine_id: "train",
    title: "Updated Title v2",
    status: "active",
    state_version: 0,
    meta_version: 2,
    archive_version: 0,
    settings: { auto_archive_days: 60 },
    creator_key: hostKey,
    created_at: "2026-11-27T01:00:00.000Z",
    last_active_at: "2026-11-27T02:00:00.000Z",
    members: [hostActor, localMember, extraMember],
  });
  assert.equal(r2.applied, true);
  assert.equal(r2.meta_changed, true);
  assert.equal(r2.newly_added_members.length, 1);
  assert.equal(boardStore.getBoard("remote-sync-1").title, "Updated Title v2");
  assert.equal(boardStore.getBoard("remote-sync-1").settings.auto_archive_days, 60);
  assert.equal(boardStore.getMember("remote-sync-1", localKey).last_read_seq, 5);

  // 3) 乱序旧 meta_version=1 与高 state_version=1 到达：只更新状态，绝不回退元数据！
  const r3 = boardStore.upsertBoardFromRemote({
    board_id: "remote-sync-1",
    host_machine_id: "train",
    title: "Stale Title v1",
    status: "archived",
    state_version: 1,
    meta_version: 1,
    archive_version: 1,
    archive_reason: "manual_dissolve",
    settings: { auto_archive_days: 7 },
    creator_key: hostKey,
    created_at: "2026-11-27T01:00:00.000Z",
    last_active_at: "2026-11-27T02:00:00.000Z",
    archived_at: "2026-11-27T03:00:00.000Z",
    members: [hostActor],
  });
  assert.equal(r3.applied, true);
  assert.equal(r3.state_changed, true);
  assert.equal(r3.meta_changed, false);
  const afterR3 = boardStore.getBoard("remote-sync-1");
  assert.equal(afterR3.status, "archived");
  assert.equal(afterR3.state_version, 1);
  assert.equal(afterR3.meta_version, 2);
  assert.equal(afterR3.title, "Updated Title v2");
  assert.equal(afterR3.settings.auto_archive_days, 60);

  // 4) 乱序低 state_version=0 即使带高 meta_version=9 也被拒绝
  const r4 = boardStore.upsertBoardFromRemote({
    board_id: "remote-sync-1",
    host_machine_id: "train",
    title: "Out of order state",
    status: "active",
    state_version: 0,
    meta_version: 9,
    archive_version: 0,
    settings: { auto_archive_days: 10 },
    creator_key: hostKey,
    created_at: "2026-11-27T01:00:00.000Z",
    last_active_at: "2026-11-27T02:00:00.000Z",
  });
  assert.equal(r4.applied, false);
  assert.equal(r4.code, "stale_state_version");

  // 5) 收到远端墓碑后彻底删除，再收到任意高版本 upsert/post 永不复活
  const tomb = boardStore.applyRemoteTombstone({
    board_id: "remote-sync-1",
    host_machine_id: "train",
    final_state_version: 2,
    deleted_by_key: hostKey,
    deleted_at: "2026-11-27T04:00:00.000Z",
  });
  assert.equal(tomb.applied, true);
  assert.equal(boardStore.getBoard("remote-sync-1"), null);

  // 幂等重放远端墓碑
  const tombDup = boardStore.applyRemoteTombstone({
    board_id: "remote-sync-1",
    host_machine_id: "train",
    final_state_version: 2,
    deleted_by_key: hostKey,
    deleted_at: "2026-11-27T04:00:00.000Z",
  });
  assert.equal(tombDup.applied, false);

  const resurrect = boardStore.upsertBoardFromRemote({
    board_id: "remote-sync-1",
    host_machine_id: "train",
    title: "Zombie",
    status: "active",
    state_version: 99,
    meta_version: 99,
    archive_version: 0,
    settings: {},
    creator_key: hostKey,
    created_at: "2026-11-27T01:00:00.000Z",
    last_active_at: "2026-11-27T05:00:00.000Z",
  });
  assert.equal(resurrect.applied, false);
  assert.equal(resurrect.code, "board_deleted_tombstone");

  const latePost = boardStore.applyRemotePost({
    boardId: "remote-sync-1",
    seq: 1,
    author: hostActor,
    body: "late post",
    created_at: "2026-11-27T05:00:00.000Z",
    origin_client_post_id: "late-1",
    incomingStateVersion: 99,
  });
  assert.equal(latePost.applied, false);
  assert.equal(latePost.code, "board_deleted_tombstone");
});

// ==================== 9. appendPost / applyRemotePost 幂等与冲突 ====================

test("appendPost 严格执行 UNIQUE(board_id, author_key, origin_client_post_id) 与冲突检测", t => {
  const { boardStore } = createHarness(t);
  const author = makeIdentity("dev", "conv-post-1");
  const author2 = makeIdentity("dev", "conv-post-2");
  boardStore.createBoard({ board_id: "post-board", host_machine_id: "dev", title: "Posts", creator: author });
  boardStore.upsertMember("post-board", author2);

  const fSha = sha256Hex("sample");
  const first = boardStore.appendPost({
    boardId: "post-board",
    author,
    body: "Hello world",
    mentions: [identityKey(author2)],
    files: [{
      file_id: "pf1",
      safe_name: "a.txt",
      bytes: 6,
      sha256: fSha,
      rel_path: "boards/post-board/files/pf1_a.txt",
      local_status: "ready",
      sync_machines: ["train"],
      bundle_id: "b1",
      bundle_label: "Batch 1",
    }],
    originClientPostId: "client-key-1",
    fileSyncTargets: ["train"],
  });
  assert.equal(first.deduplicated, false);
  assert.equal(first.post.seq, 1);

  // 同内容重放 → 幂等返回原帖，seq 不变
  const dup = boardStore.appendPost({
    boardId: "post-board",
    author,
    body: "Hello world",
    mentions: [identityKey(author2)],
    files: [{
      file_id: "pf1",
      safe_name: "a.txt",
      bytes: 6,
      sha256: fSha,
      rel_path: "boards/post-board/files/pf1_a.txt",
      local_status: "ready",
      sync_machines: ["train"],
      bundle_id: "b1",
      bundle_label: "Batch 1",
    }],
    originClientPostId: "client-key-1",
  });
  assert.equal(dup.deduplicated, true);
  assert.equal(dup.post.seq, 1);
  assert.equal(boardStore.getBoard("post-board").board_seq, 1);

  // 同去重键不同正文 → 抛 board_post_conflict
  assert.throws(
    () => boardStore.appendPost({
      boardId: "post-board",
      author,
      body: "Tampered body",
      originClientPostId: "client-key-1",
    }),
    { code: "board_post_conflict" },
  );

  // 不同作者用相同 originClientPostId 不冲突
  const otherAuthor = boardStore.appendPost({
    boardId: "post-board",
    author: author2,
    body: "Author 2 message",
    originClientPostId: "client-key-1",
  });
  assert.equal(otherAuthor.deduplicated, false);
  assert.equal(otherAuthor.post.seq, 2);

  // 超 64 KiB 正文与超 16 文件拦截
  assert.throws(
    () => boardStore.appendPost({
      boardId: "post-board",
      author,
      body: "x".repeat(BOARD_LIMITS.maxBodyBytes + 1),
      originClientPostId: "too-large",
    }),
    { code: "board_body_too_large" },
  );
  const tooManyFiles = Array.from({ length: 17 }, (_, idx) => ({
    file_id: `tm-${idx}`,
    safe_name: `f${idx}.txt`,
    bytes: 1,
    sha256: fSha,
    rel_path: `boards/post-board/files/tm-${idx}_f${idx}.txt`,
  }));
  assert.throws(
    () => boardStore.appendPost({
      boardId: "post-board",
      author,
      body: "many files",
      files: tooManyFiles,
      originClientPostId: "too-many-files",
    }),
    { code: "board_too_many_files" },
  );

  // updatePostFileLocalStatus / getPostByFileId / readPosts
  const updatedPost = boardStore.updatePostFileLocalStatus("post-board", 1, "pf1", {
    local_status: "pending_sync",
    local_path: "/should-not-be-persisted",
  });
  assert.equal(updatedPost.files[0].local_status, "pending_sync");
  assert.equal(Object.hasOwn(updatedPost.files[0], "local_path"), false);
  assert.equal(boardStore.getPostByFileId("post-board", "pf1").seq, 1);
  assert.equal(boardStore.readPosts({ boardId: "post-board", authorKeys: [identityKey(author2)] }).length, 1);
  assert.equal(boardStore.readPosts({ boardId: "post-board", seq: 2 })[0].body, "Author 2 message");
});

// ==================== 10. 零空轮询、单调 ACK、自动归档查询与 Outbox 上限 ====================

test("建空板邀远端成员首同步、确认后零空轮询、单调 ACK、自动归档检索与 Outbox 生命周期", t => {
  const { boardStore, now, setNowMs } = createHarness(t, {
    limits: { maxOutboxEntries: 3 },
  });
  const devActor = makeIdentity("dev", "conv-sync-dev");
  const trainActor = makeIdentity("train", "conv-sync-train");

  // 1) 建空板并邀远端成员 → meta_version=2 > last_acked_meta_version(0) 立即触发首同步
  boardStore.createBoard({
    board_id: "sync-board",
    host_machine_id: "dev",
    title: "Empty Sync Board",
    settings: { auto_archive_days: 10 },
    creator: devActor,
  });
  boardStore.upsertMember("sync-board", trainActor);
  assert.deepEqual(boardStore.listActiveRemotePeerMachines("sync-board", "dev"), ["train"]);

  const need1 = boardStore.listBoardsNeedingSyncForPeer("dev", "train");
  assert.equal(need1.length, 1);
  assert.equal(need1[0].meta_version, 2);
  assert.equal(need1[0].sync_state.last_acked_meta_version, 0);

  // 2) ACK 确认后 → 零空轮询（返回空数组）
  const synced = boardStore.advanceSyncState("sync-board", "train", {
    acked_seq: 0,
    acked_state_version: 0,
    acked_meta_version: 2,
    synced_at: new Date(now()).toISOString(),
  });
  assert.equal(synced.last_acked_meta_version, 2);
  assert.equal(boardStore.listBoardsNeedingSyncForPeer("dev", "train").length, 0);

  // 乱序旧 ACK 绝不回退
  const noRegress = boardStore.advanceSyncState("sync-board", "train", {
    acked_seq: 0,
    acked_state_version: 0,
    acked_meta_version: 1,
  });
  assert.equal(noRegress.last_acked_meta_version, 2);

  // 改群设置推高 meta_version=3 → 再次触发同步
  const updated = boardStore.updateBoardSettings("sync-board", { default_poll_interval_sec: 120 });
  assert.equal(updated.meta_version, 3);
  assert.equal(boardStore.listBoardsNeedingSyncForPeer("dev", "train").length, 1);

  // 3) listBoardsForActor 与 findInactiveBoardsForAutoArchive
  const listRes = boardStore.listBoardsForActor({ actorKey: identityKey(devActor) });
  assert.equal(listRes.total, 1);
  assert.equal(listRes.items[0].board_id, "sync-board");

  assert.equal(boardStore.findInactiveBoardsForAutoArchive("dev", now()).length, 0);
  setNowMs(now() + 11 * 86400000);
  const inactive = boardStore.findInactiveBoardsForAutoArchive("dev", now());
  assert.equal(inactive.length, 1);
  assert.equal(inactive[0].board_id, "sync-board");
  assert.equal(boardStore.findInactiveBoardsForAutoArchive("train", now()).length, 0);

  // 4) Outbox 抢占、状态流转与上限限制
  const ob1 = boardStore.enqueueRemoteOutbox({
    local_post_id: "ob-1",
    dedupe_key: "ob-dk-1",
    board_id: "sync-board",
    host_machine_id: "train",
    author_key: identityKey(devActor),
    op_kind: "client_post_submit",
    payload_json: { text: "1" },
  });
  assert.equal(ob1.status, "pending");
  assert.equal(boardStore.listDueRemoteOutbox("train", now()).length, 1);
  const claimed = boardStore.claimRemoteOutbox("ob-1");
  assert.equal(claimed.status, "dispatching");
  assert.equal(boardStore.claimRemoteOutbox("ob-1"), null);
  boardStore.updateRemoteOutboxStatus("ob-1", { status: "acked" });

  boardStore.enqueueRemoteOutbox({
    local_post_id: "ob-2",
    dedupe_key: "ob-dk-2",
    board_id: "sync-board",
    host_machine_id: "train",
    author_key: identityKey(devActor),
    op_kind: "client_post_submit",
    payload_json: { text: "2" },
  });
  boardStore.enqueueRemoteOutbox({
    local_post_id: "ob-3",
    dedupe_key: "ob-dk-3",
    board_id: "sync-board",
    host_machine_id: "train",
    author_key: identityKey(devActor),
    op_kind: "client_post_submit",
    payload_json: { text: "3" },
  });
  // 第 4 条触发 maxOutboxEntries = 3 上限
  assert.throws(
    () => boardStore.enqueueRemoteOutbox({
      local_post_id: "ob-4",
      dedupe_key: "ob-dk-4",
      board_id: "sync-board",
      host_machine_id: "train",
      author_key: identityKey(devActor),
      op_kind: "client_post_submit",
      payload_json: { text: "4" },
    }),
    { code: "board_outbox_full" },
  );
});

// ==================== 11. 独立事务 Savepoint、静默自动归档与恢复版本语义 ====================

test("独立数据库连接内置同步 savepoint 事务、静默自动归档不写通知与 restore 保持 archive_version", t => {
  const { boardStore } = createHarness(t, { useStandaloneDb: true });
  const creator = makeIdentity("dev", "conv-tx-1");
  const creatorKey = identityKey(creator);

  boardStore.createBoard({ board_id: "tx-board", host_machine_id: "dev", title: "TX", creator });

  // 嵌套事务部分回滚不影响外层事务提交
  boardStore.runInTransaction(() => {
    boardStore.updateBoardSettings("tx-board", { auto_archive_days: 20 });
    assert.throws(() => {
      boardStore.runInTransaction(() => {
        boardStore.updateBoardSettings("tx-board", { auto_archive_days: 99 });
        throw new Error("inner_abort");
      });
    }, /inner_abort/);
  });
  const afterTx = boardStore.getBoard("tx-board");
  assert.equal(afterTx.settings.auto_archive_days, 20);
  assert.equal(afterTx.meta_version, 2);

  // auto_inactive_31d 静默归档绝不产生解散通知
  const autoArch = boardStore.archiveBoard({
    boardId: "tx-board",
    reason: "auto_inactive_31d",
    actorKey: creatorKey,
  });
  assert.equal(autoArch.board.status, "archived");
  assert.equal(autoArch.board.state_version, 1);
  assert.equal(autoArch.board.archive_version, 1);
  assert.equal(boardStore.listDueNotifications().length, 0);

  // restore 仅递增 state_version，archive_version 保持 1
  const restored = boardStore.restoreBoard({ boardId: "tx-board", actorKey: creatorKey });
  assert.equal(restored.board.status, "active");
  assert.equal(restored.board.state_version, 2);
  assert.equal(restored.board.archive_version, 1);
  assert.equal(restored.board.archive_reason, null);
});

// ==================== 12. applyRemotePost、成员订阅偏好与文件同步队列 ====================

test("applyRemotePost 冲突/乱序防护、成员偏好游标推进与 file_sync_queue 状态机", t => {
  const { boardStore, now } = createHarness(t);
  const hostActor = makeIdentity("train", "conv-rp-host");
  const localActor = makeIdentity("dev", "conv-rp-local");
  const hostKey = identityKey(hostActor);
  const localKey = identityKey(localActor);

  boardStore.upsertBoardFromRemote({
    board_id: "rp-board",
    host_machine_id: "train",
    title: "Remote Posts",
    status: "active",
    state_version: 2,
    meta_version: 1,
    archive_version: 1,
    settings: {},
    creator_key: hostKey,
    created_at: "2026-11-27T00:00:00.000Z",
    last_active_at: "2026-11-27T00:00:00.000Z",
    members: [hostActor, localActor],
  });

  // 低于当前 state_version=2 的帖子被忽略
  const stale = boardStore.applyRemotePost({
    boardId: "rp-board",
    seq: 1,
    author: hostActor,
    body: "old state post",
    created_at: "2026-11-27T00:01:00.000Z",
    origin_client_post_id: "rp-1",
    incomingStateVersion: 1,
  });
  assert.equal(stale.applied, false);
  assert.equal(stale.code, "stale_state_version");

  // 正常写入 seq=1 与幂等重放
  const ok1 = boardStore.applyRemotePost({
    boardId: "rp-board",
    seq: 1,
    author: hostActor,
    body: "valid remote post",
    created_at: "2026-11-27T00:02:00.000Z",
    origin_client_post_id: "rp-1",
    incomingStateVersion: 2,
  });
  assert.equal(ok1.applied, true);
  assert.equal(boardStore.getBoard("rp-board").board_seq, 1);

  const dup1 = boardStore.applyRemotePost({
    boardId: "rp-board",
    seq: 1,
    author: hostActor,
    body: "valid remote post",
    created_at: "2026-11-27T00:02:00.000Z",
    origin_client_post_id: "rp-1",
    incomingStateVersion: 2,
  });
  assert.equal(dup1.applied, false);
  assert.equal(dup1.deduplicated, true);

  // 同 seq 不同内容抛 board_post_conflict
  assert.throws(
    () => boardStore.applyRemotePost({
      boardId: "rp-board",
      seq: 1,
      author: hostActor,
      body: "tampered remote post",
      created_at: "2026-11-27T00:02:00.000Z",
      origin_client_post_id: "rp-1",
      incomingStateVersion: 2,
    }),
    { code: "board_post_conflict" },
  );

  // getPostsRange
  assert.equal(boardStore.getPostsRange("rp-board", 0, 10).length, 1);

  // 成员订阅状态、偏好与游标单调推进
  const subChange = boardStore.setMemberSubscriptionState("rp-board", localKey, "unsubscribed");
  assert.equal(subChange.changed, true);
  assert.equal(boardStore.getBoard("rp-board").meta_version, 2);
  const subNoop = boardStore.setMemberSubscriptionState("rp-board", localKey, "unsubscribed");
  assert.equal(subNoop.changed, false);
  assert.equal(boardStore.getBoard("rp-board").meta_version, 2);

  const pref = boardStore.updateMemberPreferences("rp-board", localKey, {
    delivery_mode: "event",
    filter_mode: "only",
    filter_targets: [hostKey],
  });
  assert.equal(pref.delivery_mode, "event");
  assert.equal(pref.filter_mode, "only");
  assert.deepEqual(pref.filter_targets, [hostKey]);

  boardStore.updateMemberNotifiedCursor("rp-board", localKey, 5);
  const afterBack = boardStore.updateMemberNotifiedCursor("rp-board", localKey, 2);
  assert.equal(afterBack.last_notified_seq, 5);

  // file_sync_queue 状态流转
  const devCreator = makeIdentity("dev", "conv-fsq-1");
  boardStore.createBoard({ board_id: "fsq-board", host_machine_id: "dev", title: "FSQ", creator: devCreator });
  const sha = sha256Hex("file-sync-bytes");
  boardStore.appendPost({
    boardId: "fsq-board",
    author: devCreator,
    body: "with file",
    files: [{
      file_id: "fsq-f1",
      safe_name: "sync.bin",
      bytes: 15,
      sha256: sha,
      rel_path: "boards/fsq-board/files/fsq-f1_sync.bin",
    }],
    originClientPostId: "fsq-p1",
    fileSyncTargets: ["train"],
  });
  const due = boardStore.listDueFileSyncItems("train", now());
  assert.equal(due.length, 1);
  assert.equal(due[0].file_id, "fsq-f1");
  const updated = boardStore.updateFileSyncItemStatus("fsq-board", "fsq-f1", "train", {
    status: "pending",
    retry_count: 1,
    next_retry_at: now() + 60000,
    last_error: "pending_capacity",
  });
  assert.equal(updated.retry_count, 1);
  assert.equal(boardStore.listDueFileSyncItems("train", now()).length, 0);
  assert.equal(boardStore.listDueFileSyncItems("train", now() + 60000).length, 1);
  boardStore.updateFileSyncItemStatus("fsq-board", "fsq-f1", "train", { status: "acked", last_error: null });
  assert.equal(boardStore.listDueFileSyncItems("train", now() + 60000).length, 0);
});

// ==================== 13. W2-3 审查整改：补齐 3 项查询方法 ====================

test("W2-3: listKnownPeerMachines 五表去重排序、getRemoteOutbox 与 getFileSyncItem 精确查询", t => {
  const { boardStore, inspectDb } = createHarness(t);
  const devActor = makeIdentity("dev", "conv-peers-dev");
  const peerA = makeIdentity("alpha-node", "conv-peers-a");
  const devKey = identityKey(devActor);

  boardStore.createBoard({ board_id: "peers-b1", host_machine_id: "dev", title: "Peers 1", creator: devActor });
  boardStore.createBoard({ board_id: "peers-b2", host_machine_id: "dev", title: "Peers 2", creator: devActor });

  // 1) board_members -> alpha-node
  boardStore.upsertMember("peers-b1", peerA);
  // 2) board_sync_state -> zeta-node (+ 重复 alpha-node 验证去重)
  boardStore.advanceSyncState("peers-b1", "zeta-node", { acked_meta_version: 1 });
  boardStore.advanceSyncState("peers-b1", "alpha-node", { acked_meta_version: 1 });
  // 3) board_file_sync_queue -> gamma-node
  const fSha = sha256Hex("peer-file");
  boardStore.appendPost({
    boardId: "peers-b1",
    author: devActor,
    body: "file for gamma",
    files: [{
      file_id: "pf-gamma",
      safe_name: "gamma.bin",
      bytes: 9,
      sha256: fSha,
      rel_path: "boards/peers-b1/files/pf-gamma_gamma.bin",
    }],
    originClientPostId: "p-gamma",
    fileSyncTargets: ["gamma-node"],
  });
  // 4) board_tombstone_sync -> delta-node
  boardStore.archiveBoard({ boardId: "peers-b2", reason: "auto_inactive_31d", actorKey: devKey });
  boardStore.deleteArchivedBoard({
    boardId: "peers-b2",
    expectedArchiveVersion: 1,
    actorKey: devKey,
    peerMachines: ["delta-node", "dev"],
  });
  // 5) board_remote_outbox -> beta-node (+ 重复 dev 验证排除本机)
  boardStore.enqueueRemoteOutbox({
    local_post_id: "lp-beta-1",
    dedupe_key: "dk-beta-1",
    board_id: "peers-b1",
    host_machine_id: "beta-node",
    author_key: devKey,
    op_kind: "client_post_submit",
    payload_json: { text: "hello beta" },
  });
  boardStore.enqueueRemoteOutbox({
    local_post_id: "lp-self-1",
    dedupe_key: "dk-self-1",
    board_id: "peers-b1",
    host_machine_id: "dev",
    author_key: devKey,
    op_kind: "client_post_submit",
    payload_json: { text: "self" },
  });

  // 也写入一条 dev 的 tombstone sync 确保排除 localMachineId 生效
  inspectDb.prepare(`
    INSERT OR IGNORE INTO board_tombstone_sync (board_id, peer_machine_id, final_state_version, acked, next_retry_at)
    VALUES ('peers-b2', 'dev', 2, 0, 0)
  `).run();

  assert.deepEqual(
    boardStore.listKnownPeerMachines("dev"),
    ["alpha-node", "beta-node", "delta-node", "gamma-node", "zeta-node"],
  );

  // getRemoteOutbox 精确主键查询
  const ob = boardStore.getRemoteOutbox("lp-beta-1");
  assert.ok(ob);
  assert.equal(ob.local_post_id, "lp-beta-1");
  assert.equal(ob.host_machine_id, "beta-node");
  assert.equal(ob.dedupe_key, "dk-beta-1");
  assert.deepEqual(ob.payload, { text: "hello beta" });
  assert.equal(boardStore.getRemoteOutbox("not-exist-id"), null);

  // getFileSyncItem 复合主键查询
  const fsq = boardStore.getFileSyncItem("peers-b1", "pf-gamma", "gamma-node");
  assert.ok(fsq);
  assert.equal(fsq.board_id, "peers-b1");
  assert.equal(fsq.file_id, "pf-gamma");
  assert.equal(fsq.peer_machine_id, "gamma-node");
  assert.equal(fsq.status, "pending");
  assert.equal(boardStore.getFileSyncItem("peers-b1", "pf-gamma", "other-node"), null);
  assert.equal(boardStore.getFileSyncItem("peers-b1", "no-file", "gamma-node"), null);
});

// ==================== 14. W2-3 审查整改：dissolved_by_key 迁移、读写与远端空值兜底 ====================

test("W2-3: boards.dissolved_by_key 旧库自动安全迁移、解散/恢复清零与远端 creator/deleted_by 空串兜底", t => {
  // 1) 构造缺少 dissolved_by_key 列的旧库，打开 BoardStore 验证自动 ALTER 迁移且数据不损
  const root = mkdtempSync(join(tmpdir(), "board-store-migrate-"));
  const dbPath = join(root, "legacy.sqlite");
  const privateRoot = join(root, "private");
  mkdirSync(privateRoot, { recursive: true });
  const legacyDb = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true, defensive: true });
  t.after(() => {
    try { legacyDb.close(); } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  });

  legacyDb.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE boards (
      board_id TEXT PRIMARY KEY NOT NULL,
      host_machine_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
      meta_version INTEGER NOT NULL DEFAULT 1 CHECK (meta_version >= 1),
      archive_version INTEGER NOT NULL DEFAULT 0 CHECK (archive_version >= 0),
      archive_reason TEXT CHECK (archive_reason IS NULL OR archive_reason IN ('manual_dissolve', 'auto_inactive_31d')),
      archive_format TEXT NOT NULL DEFAULT 'dir' CHECK (archive_format IN ('dir', 'tar_gz')),
      settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
      board_seq INTEGER NOT NULL DEFAULT 0 CHECK (board_seq >= 0),
      creator_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      archived_at TEXT
    ) STRICT;
    INSERT INTO boards (
      board_id, host_machine_id, title, status, state_version, meta_version,
      archive_version, archive_reason, archive_format, settings_json,
      board_seq, creator_key, created_at, last_active_at, archived_at
    ) VALUES (
      'legacy-b1', 'dev', 'Legacy Board', 'active', 0, 1, 0, NULL, 'dir',
      '{"default_file_sync_machines":["*"],"auto_archive_days":31,"default_poll_interval_sec":90}',
      0, '["dev","codex","desktop","c0"]', '2026-11-27T00:00:00.000Z', '2026-11-27T00:00:00.000Z', NULL
    );
  `);

  const migratedStore = new BoardStore({
    database: legacyDb,
    privateRoot,
  });
  const cols = legacyDb.prepare("PRAGMA table_info(boards)").all().map(c => c.name);
  assert.ok(cols.includes("dissolved_by_key"), "旧库打开后应自动补齐 dissolved_by_key 列");
  const legacyBoard = migratedStore.getBoard("legacy-b1");
  assert.equal(legacyBoard.title, "Legacy Board");
  assert.equal(legacyBoard.dissolved_by_key, null);

  // 2) manual_dissolve 写入非创建者真实 actorKey，restoreBoard 清回 null；auto_inactive_31d 保持 null
  const creator = makeIdentity("dev", "conv-cr");
  const dissolver = makeIdentity("dev", "conv-ds");
  const dissolverKey = identityKey(dissolver);
  migratedStore.createBoard({ board_id: "diss-check", host_machine_id: "dev", title: "Diss", creator });
  migratedStore.upsertMember("diss-check", dissolver);

  const manual = migratedStore.archiveBoard({
    boardId: "diss-check",
    reason: "manual_dissolve",
    actorKey: dissolverKey,
  });
  assert.equal(manual.board.dissolved_by_key, dissolverKey);

  const restored = migratedStore.restoreBoard({ boardId: "diss-check", actorKey: dissolverKey });
  assert.equal(restored.board.dissolved_by_key, null);

  const autoArch = migratedStore.archiveBoard({
    boardId: "diss-check",
    reason: "auto_inactive_31d",
    actorKey: "system:auto_archive",
  });
  assert.equal(autoArch.board.dissolved_by_key, null);

  // 3) upsertBoardFromRemote 入站 creator_key 为空串/缺失不崩溃，兜底为 system:unknown
  const emptyCreatorRes = migratedStore.upsertBoardFromRemote({
    board_id: "remote-diss-first",
    host_machine_id: "train",
    title: "Dissolved Before Sync",
    status: "archived",
    state_version: 1,
    meta_version: 1,
    archive_version: 1,
    archive_reason: "manual_dissolve",
    creator_key: "",
    dissolved_by_key: dissolverKey,
    created_at: "2026-11-27T01:00:00.000Z",
    last_active_at: "2026-11-27T01:00:00.000Z",
    archived_at: "2026-11-27T01:05:00.000Z",
  });
  assert.equal(emptyCreatorRes.applied, true);
  const remoteDissBoard = migratedStore.getBoard("remote-diss-first");
  assert.equal(remoteDissBoard.creator_key, "system:unknown");
  assert.equal(remoteDissBoard.dissolved_by_key, dissolverKey);

  const missingCreatorRes = migratedStore.upsertBoardFromRemote({
    board_id: "remote-missing-creator",
    host_machine_id: "train",
    title: "No Creator Field",
    status: "active",
    state_version: 0,
    meta_version: 1,
    created_at: "2026-11-27T01:00:00.000Z",
    last_active_at: "2026-11-27T01:00:00.000Z",
  });
  assert.equal(missingCreatorRes.applied, true);
  assert.equal(migratedStore.getBoard("remote-missing-creator").creator_key, "system:unknown");

  // 4) applyRemoteTombstone 入站 deleted_by_key 为空串/缺失兜底为 system:unknown
  const tombEmpty = migratedStore.applyRemoteTombstone({
    board_id: "remote-diss-first",
    host_machine_id: "train",
    final_state_version: 2,
    deleted_by_key: "",
    deleted_at: "2026-11-27T02:00:00.000Z",
  });
  assert.equal(tombEmpty.applied, true);
  assert.equal(tombEmpty.tombstone.deleted_by_key, "system:unknown");

  const tombMissing = migratedStore.applyRemoteTombstone({
    board_id: "remote-missing-creator",
    host_machine_id: "train",
    final_state_version: 1,
    deleted_at: "2026-11-27T02:00:00.000Z",
  });
  assert.equal(tombMissing.applied, true);
  assert.equal(tombMissing.tombstone.deleted_by_key, "system:unknown");
});

// ==================== 15. W2-3 审查整改：退订后彻底停止跨机推新帖与解散 ====================

test("W2-3: listBoardsNeedingSyncForPeer 远端全员退订仅放行一次 unsubscribe_sync_only，绝不推新帖与解散", t => {
  const { boardStore } = createHarness(t);
  const devCreator = makeIdentity("dev", "conv-unsub-dev");
  const trainMember = makeIdentity("train", "conv-unsub-train");
  const devKey = identityKey(devCreator);
  const trainKey = identityKey(trainMember);

  boardStore.createBoard({ board_id: "unsub-board", host_machine_id: "dev", title: "Unsub Test", creator: devCreator });
  boardStore.upsertMember("unsub-board", trainMember);

  // 首轮同步并确认（meta_version=2）
  const firstNeed = boardStore.listBoardsNeedingSyncForPeer("dev", "train");
  assert.equal(firstNeed.length, 1);
  assert.equal(firstNeed[0].has_active_peer_member, true);
  assert.equal(firstNeed[0].unsubscribe_sync_only, false);
  boardStore.advanceSyncState("unsub-board", "train", { acked_seq: 0, acked_state_version: 0, acked_meta_version: 2 });
  assert.equal(boardStore.listBoardsNeedingSyncForPeer("dev", "train").length, 0);

  // train 成员退订（meta_version 升至 3），且同时主机继续发新帖
  boardStore.setMemberSubscriptionState("unsub-board", trainKey, "unsubscribed");
  boardStore.appendPost({
    boardId: "unsub-board",
    author: devCreator,
    body: "secret post after train unsubscribed",
    originClientPostId: "post-after-unsub-1",
  });

  // 退订未 ACK 前：仅放行一次 unsubscribe_sync_only: true
  const unsubNeed = boardStore.listBoardsNeedingSyncForPeer("dev", "train");
  assert.equal(unsubNeed.length, 1);
  assert.equal(unsubNeed[0].has_active_peer_member, false);
  assert.equal(unsubNeed[0].unsubscribe_sync_only, true);

  // 退订态 meta_version=3 ACK 后，继续发新帖 -> 绝对零推送
  boardStore.advanceSyncState("unsub-board", "train", { acked_meta_version: 3 });
  boardStore.appendPost({
    boardId: "unsub-board",
    author: devCreator,
    body: "another post after ack",
    originClientPostId: "post-after-unsub-2",
  });
  assert.equal(boardStore.listBoardsNeedingSyncForPeer("dev", "train").length, 0);

  // 随后主机手动解散（state_version=1, archive_version=1）与恢复（state_version=2） -> 对已全员退订的 train 绝对零推送！
  boardStore.archiveBoard({ boardId: "unsub-board", reason: "manual_dissolve", actorKey: devKey });
  assert.equal(boardStore.listBoardsNeedingSyncForPeer("dev", "train").length, 0);

  boardStore.restoreBoard({ boardId: "unsub-board", actorKey: devKey });
  assert.equal(boardStore.listBoardsNeedingSyncForPeer("dev", "train").length, 0);
});

// ==================== 16. W2-3 审查整改：重启/丢 ACK 恢复、.outbox 清理与多文件回滚清理 ====================

test("W2-3: recoverInterruptedSyncState、租约到期拉取、.outbox 终态与孤儿清理及多文件回滚清理", t => {
  const { boardStore, uploadRoot, now } = createHarness(t);
  const devCreator = makeIdentity("dev", "conv-recov-dev");
  const devKey = identityKey(devCreator);
  const t0 = now();

  boardStore.createBoard({ board_id: "recov-board", host_machine_id: "dev", title: "Recov", creator: devCreator });

  // 1) 准备 3 条文件同步任务：f1 pending 到期、f2 sending 租约已到期、f3 sending 租约未到期、f4 sending 无租约(0)
  const sha = sha256Hex("recov-file");
  boardStore.appendPost({
    boardId: "recov-board",
    author: devCreator,
    body: "files for recovery",
    files: [
      { file_id: "rf1", safe_name: "f1.bin", bytes: 10, sha256: sha, rel_path: "boards/recov-board/files/rf1_f1.bin" },
      { file_id: "rf2", safe_name: "f2.bin", bytes: 10, sha256: sha, rel_path: "boards/recov-board/files/rf2_f2.bin" },
      { file_id: "rf3", safe_name: "f3.bin", bytes: 10, sha256: sha, rel_path: "boards/recov-board/files/rf3_f3.bin" },
      { file_id: "rf4", safe_name: "f4.bin", bytes: 10, sha256: sha, rel_path: "boards/recov-board/files/rf4_f4.bin" },
    ],
    originClientPostId: "p-recov-1",
    fileSyncTargets: ["train"],
  });
  boardStore.updateFileSyncItemStatus("recov-board", "rf2", "train", { status: "sending", next_retry_at: t0 - 1000 });
  boardStore.updateFileSyncItemStatus("recov-board", "rf3", "train", { status: "sending", next_retry_at: t0 + 30000 });
  boardStore.updateFileSyncItemStatus("recov-board", "rf4", "train", { status: "sending", next_retry_at: 0 });

  // listDueFileSyncItems 同时拉出 pending(rf1) 与租约已到期的 sending(rf2)，不误拉未到期(rf3)与无租约(rf4)
  const dueBeforeRecover = boardStore.listDueFileSyncItems("train", t0).map(item => item.file_id).sort();
  assert.deepEqual(dueBeforeRecover, ["rf1", "rf2"]);

  // 运行期按租约恢复（sendingLeaseMs > 0）：仅恢复到期 rf2，不打断未到期的 rf3 和刚发出的 rf4
  const leasedRecover = boardStore.recoverInterruptedSyncState({ sendingLeaseMs: 30000, nowMs: t0 });
  assert.equal(leasedRecover.recovered_files, 1);
  assert.equal(boardStore.getFileSyncItem("recov-board", "rf2", "train").status, "pending");
  assert.equal(boardStore.getFileSyncItem("recov-board", "rf3", "train").status, "sending");
  assert.equal(boardStore.getFileSyncItem("recov-board", "rf4", "train").status, "sending");

  // 2) 准备 1 条卡在 dispatching 的 outbox，并做启动全量恢复（sendingLeaseMs = 0）
  boardStore.enqueueRemoteOutbox({
    local_post_id: "lp-stuck",
    dedupe_key: "dk-stuck-preserve",
    board_id: "recov-board",
    host_machine_id: "train",
    author_key: devKey,
    op_kind: "client_post_submit",
    payload_json: { text: "in flight" },
  });
  const claimed = boardStore.claimRemoteOutbox("lp-stuck");
  assert.equal(claimed.status, "dispatching");
  assert.equal(boardStore.listDueRemoteOutbox("train", t0).length, 0);

  const bootRecover = boardStore.recoverInterruptedSyncState({ sendingLeaseMs: 0, nowMs: t0 + 5000 });
  assert.equal(bootRecover.recovered_outbox, 1);
  assert.equal(bootRecover.recovered_files, 2); // rf3 + rf4 全部恢复
  const recoveredOb = boardStore.getRemoteOutbox("lp-stuck");
  assert.equal(recoveredOb.status, "unknown");
  assert.equal(recoveredOb.dedupe_key, "dk-stuck-preserve");
  assert.equal(recoveredOb.next_retry_at, t0 + 5000);

  // listDueRemoteOutbox 同时返回 unknown，且 claimRemoteOutbox 可重新抢占并保持原 dedupe_key
  const dueOutbox = boardStore.listDueRemoteOutbox("train", t0 + 5000);
  assert.equal(dueOutbox.length, 1);
  assert.equal(dueOutbox[0].local_post_id, "lp-stuck");
  assert.equal(dueOutbox[0].dedupe_key, "dk-stuck-preserve");
  const reclaimed = boardStore.claimRemoteOutbox("lp-stuck");
  assert.equal(reclaimed.status, "dispatching");
  assert.equal(reclaimed.dedupe_key, "dk-stuck-preserve");

  // 3) .outbox/ 终态清理与非终态保留
  const srcFile = join(uploadRoot, "outbox-src.txt");
  writeFileSync(srcFile, "outbox-attachment-data");

  for (const [idx, terminalStatus] of ["acked", "rejected_archived", "rejected_deleted", "dead_letter"].entries()) {
    const lpId = `lp-term-${idx}`;
    const stagedOb = boardStore.stageOutboxAttachment({
      sourcePath: srcFile,
      originalName: `att_${idx}.txt`,
      localPostId: lpId,
      fileId: `obf-${idx}`,
    });
    assert.ok(existsSync(stagedOb.outbox_path));
    boardStore.enqueueRemoteOutbox({
      local_post_id: lpId,
      dedupe_key: `dk-term-${idx}`,
      board_id: "recov-board",
      host_machine_id: "train",
      author_key: devKey,
      op_kind: "client_post_submit",
      payload_json: { idx },
    });
    // 非终态 sent 不删目录
    boardStore.updateRemoteOutboxStatus(lpId, { status: "sent" });
    assert.ok(existsSync(boardStore.getOutboxDir(lpId)));
    // 进入终态立即删除 boards/.outbox/<lpId>
    boardStore.updateRemoteOutboxStatus(lpId, { status: terminalStatus });
    assert.equal(existsSync(boardStore.getOutboxDir(lpId)), false);
  }

  // 4) reconcilePendingFileOps 清理孤儿与残留终态 .outbox/ 子目录，保留活跃 outbox 子目录
  const activeOb = boardStore.stageOutboxAttachment({
    sourcePath: srcFile,
    originalName: "keep_active.txt",
    localPostId: "lp-active-keep",
    fileId: "obf-active",
  });
  boardStore.enqueueRemoteOutbox({
    local_post_id: "lp-active-keep",
    dedupe_key: "dk-active-keep",
    board_id: "recov-board",
    host_machine_id: "train",
    author_key: devKey,
    op_kind: "client_post_submit",
    payload_json: { active: true },
  });
  // 孤儿目录（未入表）+ 残留终态目录（模拟终态删目录失败后重启补清）
  const orphanOb = boardStore.stageOutboxAttachment({
    sourcePath: srcFile,
    originalName: "orphan.txt",
    localPostId: "lp-orphan-dir",
    fileId: "obf-orphan",
  });
  const staleTermDir = boardStore.getOutboxDir("lp-term-0");
  mkdirSync(staleTermDir, { recursive: true });
  writeFileSync(join(staleTermDir, "leftover.bin"), "stale");

  const recOutbox = boardStore.reconcilePendingFileOps();
  assert.equal(recOutbox.cleaned_outbox, 2);
  assert.equal(existsSync(activeOb.outbox_path), true);
  assert.equal(existsSync(orphanOb.outbox_path), false);
  assert.equal(existsSync(staleTermDir), false);

  // 5) 多文件上传中途失败回滚工具方法：cleanupStagedTempFiles & cleanupOutboxDir
  const st1 = boardStore.stageLocalUploadFile({
    sourcePath: srcFile,
    originalName: "m1.txt",
    boardId: "recov-board",
    fileId: "mf1",
    opId: "mop-1",
  });
  const st2 = boardStore.stageLocalUploadFile({
    sourcePath: srcFile,
    originalName: "m2.txt",
    boardId: "recov-board",
    fileId: "mf2",
    opId: "mop-2",
  });
  assert.ok(existsSync(join(boardStore.getStagingDir(), st1.staging_name)));
  assert.ok(existsSync(join(boardStore.getStagingDir(), st2.staging_name)));

  const cleanupRes = boardStore.cleanupStagedTempFiles(["mop-1", st2, "mop-nonexistent", "../escape"]);
  assert.deepEqual(cleanupRes.cleaned, ["mop-1", "mop-2"]);
  assert.deepEqual(cleanupRes.skipped, ["mop-nonexistent"]);
  assert.equal(cleanupRes.failed.length, 1);
  assert.equal(cleanupRes.failed[0].code, "invalid_input");
  assert.equal(existsSync(join(boardStore.getStagingDir(), st1.staging_name)), false);
  assert.equal(existsSync(join(boardStore.getStagingDir(), st2.staging_name)), false);

  const rollbackOb = boardStore.stageOutboxAttachment({
    sourcePath: srcFile,
    originalName: "rb.txt",
    localPostId: "lp-rollback",
    fileId: "rbf1",
  });
  assert.ok(existsSync(rollbackOb.outbox_path));
  assert.equal(boardStore.cleanupOutboxDir("lp-rollback"), true);
  assert.equal(existsSync(boardStore.getOutboxDir("lp-rollback")), false);
  assert.equal(boardStore.cleanupOutboxDir("lp-rollback"), false);
  assert.throws(() => boardStore.cleanupOutboxDir("../escape"), { code: "invalid_input" });
});

// ==================== 17. W2-3 审查整改：dissolved 通知语义与 restoreBoard 取消 ====================

test("W2-3: archiveBoard 统一 dissolved dedupe_key/仅本机入队/完整 payload，restoreBoard 同事务取消 pending 解散通知", t => {
  const { boardStore, inspectDb } = createHarness(t);
  const localCreator = makeIdentity("dev", "conv-dn-1");
  const localPeer = makeIdentity("dev", "conv-dn-2");
  const remotePeer = makeIdentity("train", "conv-dn-3");
  const creatorKey = identityKey(localCreator);
  const localPeerKey = identityKey(localPeer);
  const remotePeerKey = identityKey(remotePeer);

  boardStore.createBoard({ board_id: "dn-board", host_machine_id: "dev", title: "Dissolve Notif", creator: localCreator });
  boardStore.upsertMember("dn-board", localPeer);
  boardStore.upsertMember("dn-board", remotePeer);

  // 先塞一条非 dissolved 的 pending event_post 通知，确认 restoreBoard 绝不误取消它
  boardStore.enqueueNotification({
    dedupe_key: "ev:dn-board:keep",
    board_id: "dn-board",
    member_key: localPeerKey,
    member_json: localPeer,
    kind: "event_post",
    state_version: 0,
    payload_json: { seq: 1 },
  });

  // 手动解散（archive_version=1, state_version=1）
  boardStore.archiveBoard({ boardId: "dn-board", reason: "manual_dissolve", actorKey: localPeerKey });

  const notifs = inspectDb.prepare(
    "SELECT * FROM board_notifications WHERE board_id = 'dn-board' AND kind = 'dissolved' ORDER BY member_key ASC",
  ).all();
  assert.equal(notifs.length, 2, "仅应给本机 2 名活跃成员入队，绝不给远端成员入队");
  assert.equal(notifs.some(n => n.member_key === remotePeerKey), false);

  for (const row of notifs) {
    assert.equal(row.dedupe_key, `dissolved:dn-board:1:${row.member_key}`);
    const payload = JSON.parse(row.payload_json);
    assert.equal(payload.host_machine_id, "dev");
    assert.equal(payload.dissolved_by_key, localPeerKey);
    assert.equal(payload.restorable, true);
    assert.equal(payload.archive_version, 1);
  }

  // 把其中 1 条标为 sent，再执行 restoreBoard：pending 变 cancelled，已 sent 保持 sent，非 dissolved 保持 pending
  boardStore.markNotificationStatus(`dissolved:dn-board:1:${creatorKey}`, { status: "sent" });
  const restored = boardStore.restoreBoard({ boardId: "dn-board", actorKey: creatorKey });
  assert.equal(restored.cancelled_notifications, 1);

  const afterCreator = inspectDb.prepare(
    "SELECT status FROM board_notifications WHERE dedupe_key = ?",
  ).get(`dissolved:dn-board:1:${creatorKey}`);
  const afterLocalPeer = inspectDb.prepare(
    "SELECT status FROM board_notifications WHERE dedupe_key = ?",
  ).get(`dissolved:dn-board:1:${localPeerKey}`);
  const afterEvent = inspectDb.prepare(
    "SELECT status FROM board_notifications WHERE dedupe_key = 'ev:dn-board:keep'",
  ).get();
  assert.equal(afterCreator.status, "sent");
  assert.equal(afterLocalPeer.status, "cancelled");
  assert.equal(afterEvent.status, "pending");

  // 二次手动解散（archive_version=2, state_version=3）时 dedupe_key 使用 archive_version=2，且可正常重新入队
  boardStore.archiveBoard({ boardId: "dn-board", reason: "manual_dissolve", actorKey: creatorKey });
  const secondNotif = inspectDb.prepare(
    "SELECT * FROM board_notifications WHERE dedupe_key = ?",
  ).get(`dissolved:dn-board:2:${localPeerKey}`);
  assert.ok(secondNotif);
  assert.equal(secondNotif.status, "pending");
  assert.equal(secondNotif.state_version, 3);
});

// ==================== 18. W2-3 审查整改：rel_path 合法双点文件名放行与真穿越拦截 ====================

test("W2-3: v1..v2.diff 放行 normalizePostFiles 与 updatePostFileLocalStatus，真路径穿越严格拦截", t => {
  const { boardStore } = createHarness(t);
  const author = makeIdentity("dev", "conv-diff-1");
  boardStore.createBoard({ board_id: "diff-board", host_machine_id: "dev", title: "Diff", creator: author });

  const sha = sha256Hex("diff-content");
  const safeDiffRelPath = "boards/diff-board/files/fdiff1_v1..v2.diff";
  const posted = boardStore.appendPost({
    boardId: "diff-board",
    author,
    body: "diff attachment",
    files: [{
      file_id: "fdiff1",
      safe_name: "v1..v2.diff",
      bytes: 12,
      sha256: sha,
      rel_path: safeDiffRelPath,
      local_status: "pending_sync",
    }],
    originClientPostId: "post-diff-1",
  });
  assert.equal(posted.post.files[0].safe_name, "v1..v2.diff");
  assert.equal(posted.post.files[0].rel_path, safeDiffRelPath);

  // updatePostFileLocalStatus 放行含双点文件名的归档路径
  const archivedDiffRelPath = "boards-archive/diff-board/files/fdiff1_v1..v2.diff";
  const updated = boardStore.updatePostFileLocalStatus("diff-board", 1, "fdiff1", {
    local_status: "ready",
    rel_path: archivedDiffRelPath,
  });
  assert.equal(updated.files[0].rel_path, archivedDiffRelPath);
  assert.equal(updated.files[0].local_status, "ready");

  // 各类真穿越与非法路径段全部拦截
  const badRelPaths = [
    "boards/../secret.txt",
    "../secret.txt",
    "boards/diff-board/./f1.txt",
    "boards//diff-board/f1.txt",
    "/boards/diff-board/f1.txt",
    "boards/diff-board/f1.txt/",
    "boards\\diff-board\\files\\f1.txt",
  ];
  for (const badPath of badRelPaths) {
    assert.throws(
      () => boardStore.appendPost({
        boardId: "diff-board",
        author,
        body: "bad path",
        files: [{
          file_id: "fbad",
          safe_name: "ok.txt",
          bytes: 1,
          sha256: sha,
          rel_path: badPath,
        }],
        originClientPostId: `bad-${badPath}`,
      }),
      { code: "invalid_input" },
      `appendPost 应拦截非法 rel_path: ${badPath}`,
    );
    assert.throws(
      () => boardStore.updatePostFileLocalStatus("diff-board", 1, "fdiff1", {
        local_status: "ready",
        rel_path: badPath,
      }),
      { code: "invalid_input" },
      `updatePostFileLocalStatus 应拦截非法 rel_path: ${badPath}`,
    );
  }
});

// ==================== 19. W2-3 审查整改：防跳号连续 board_seq 与归档板远端文件落盘 ====================

test("W2-3: getContiguousBoardSeq 连续水位防跳号推进与 stageRemoteFileBufferOrPath(archived=true) 归档落盘", t => {
  const { boardStore } = createHarness(t);
  const hostActor = makeIdentity("train", "conv-gap-host");
  const hostKey = identityKey(hostActor);

  boardStore.upsertBoardFromRemote({
    board_id: "gap-board",
    host_machine_id: "train",
    title: "Gap Test",
    status: "active",
    state_version: 0,
    meta_version: 1,
    creator_key: hostKey,
    created_at: "2026-11-27T00:00:00.000Z",
    last_active_at: "2026-11-27T00:00:00.000Z",
  });
  assert.equal(boardStore.getContiguousBoardSeq("gap-board"), 0);

  // 先收到 seq=2（seq=1 缺失）：必须保存记录但 boards.board_seq 不得越洞跳至 2
  const r2 = boardStore.applyRemotePost({
    boardId: "gap-board",
    seq: 2,
    author: hostActor,
    body: "second post arrived first",
    created_at: "2026-11-27T00:02:00.000Z",
    origin_client_post_id: "gap-p2",
    incomingStateVersion: 0,
  });
  assert.equal(r2.applied, true);
  assert.equal(boardStore.readPosts({ boardId: "gap-board", seq: 2 }).length, 1);
  assert.equal(boardStore.getContiguousBoardSeq("gap-board"), 0);
  assert.equal(boardStore.getBoard("gap-board").board_seq, 0);

  // 再收到 seq=4（seq=1, 3 缺失）：board_seq 仍保持 0
  boardStore.applyRemotePost({
    boardId: "gap-board",
    seq: 4,
    author: hostActor,
    body: "fourth post",
    created_at: "2026-11-27T00:04:00.000Z",
    origin_client_post_id: "gap-p4",
    incomingStateVersion: 0,
  });
  assert.equal(boardStore.getContiguousBoardSeq("gap-board"), 0);
  assert.equal(boardStore.getBoard("gap-board").board_seq, 0);

  // 补齐 seq=1：连续最大 seq 连贯推进到 2（仍止于缺失的 3 之前）
  boardStore.applyRemotePost({
    boardId: "gap-board",
    seq: 1,
    author: hostActor,
    body: "first post filled",
    created_at: "2026-11-27T00:01:00.000Z",
    origin_client_post_id: "gap-p1",
    incomingStateVersion: 0,
  });
  assert.equal(boardStore.getContiguousBoardSeq("gap-board"), 2);
  assert.equal(boardStore.getBoard("gap-board").board_seq, 2);

  // 补齐 seq=3：连续最大 seq 一次性跃升至 4
  boardStore.applyRemotePost({
    boardId: "gap-board",
    seq: 3,
    author: hostActor,
    body: "third post filled",
    created_at: "2026-11-27T00:03:00.000Z",
    origin_client_post_id: "gap-p3",
    incomingStateVersion: 0,
  });
  assert.equal(boardStore.getContiguousBoardSeq("gap-board"), 4);
  assert.equal(boardStore.getBoard("gap-board").board_seq, 4);

  // stageRemoteFileBufferOrPath archived = true 落盘至 boards-archive/<boardId>/files/
  const archPayload = Buffer.from("archived-remote-file-bytes", "utf8");
  const archSha = sha256Hex(archPayload);
  const stagedArch = boardStore.stageRemoteFileBufferOrPath({
    buffer: archPayload,
    boardId: "gap-board",
    fileId: "af1",
    safeName: "v1..v2.diff",
    expectedSha256: archSha,
    expectedBytes: archPayload.byteLength,
    archived: true,
  });
  assert.equal(stagedArch.rel_path, "boards-archive/gap-board/files/af1_v1..v2.diff");
  assert.equal(
    stagedArch.local_path,
    boardStore.resolveSafeBoardFilePath("gap-board", "af1", "v1..v2.diff", { archived: true }),
  );
  assert.equal(readFileSync(stagedArch.local_path, "utf8"), "archived-remote-file-bytes");
  assert.equal(existsSync(boardStore.resolveSafeBoardFilePath("gap-board", "af1", "v1..v2.diff", { archived: false })), false);
});

// ==================== 20. W2-3 审查整改：3 项新增热路径索引 EXPLAIN、墓碑退避与 listBoardsForActor 优化 ====================

test("W2-3: 3 项新增热路径索引 EXPLAIN 零 SCAN、updateTombstoneSyncBackoff 与 listBoardsForActor 零 N+1 及退订未读归零", t => {
  const { boardStore, inspectDb, now } = createHarness(t);
  const devCreator = makeIdentity("dev", "conv-opt-dev");
  const devMember = makeIdentity("dev", "conv-opt-m2");
  const devKey = identityKey(devCreator);
  const m2Key = identityKey(devMember);
  const t0 = now();

  // 造 15 个已删除墓碑、outbox、done file_ops，以便 ANALYZE 后检验索引命中
  for (let i = 0; i < 15; i += 1) {
    const bid = `tomb-idx-${i}`;
    boardStore.createBoard({ board_id: bid, host_machine_id: "dev", title: `Tomb ${i}`, creator: devCreator });
    boardStore.enqueueRemoteOutbox({
      local_post_id: `lp-idx-${i}`,
      dedupe_key: `dk-idx-${i}`,
      board_id: bid,
      host_machine_id: "train",
      author_key: devKey,
      op_kind: "client_post_submit",
      payload_json: { i },
    });
    boardStore.archiveBoard({ boardId: bid, reason: "auto_inactive_31d", actorKey: devKey });
    boardStore.deleteArchivedBoard({
      boardId: bid,
      expectedArchiveVersion: 1,
      actorKey: devKey,
      peerMachines: ["train"],
    });
  }
  for (let i = 0; i < 40; i += 1) {
    inspectDb.prepare(`
      INSERT INTO board_file_ops (
        op_id, board_id, op_kind, state_version, status, created_at, updated_at
      ) VALUES (?, 'tomb-idx-0', 'purge_archived_dir', 2, 'done', ?, ?)
    `).run(`done-idx-${i}`, new Date(t0 - 10000).toISOString(), new Date(t0 - 10000).toISOString());
  }
  inspectDb.exec("ANALYZE;");

  // 验证 3 项新增索引存在
  const indexNames = new Set(
    inspectDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(r => r.name),
  );
  for (const idx of [
    "idx_board_tombstone_sync_due",
    "idx_board_remote_outbox_board",
    "idx_board_file_ops_status_updated",
  ]) {
    assert.ok(indexNames.has(idx), `缺少新增索引 ${idx}`);
  }

  // 1) EXPLAIN QUERY PLAN 验证 listPendingTombstoneSyncs 命中 idx_board_tombstone_sync_due 零全表 SCAN
  const tombstonePlan = inspectDb.prepare(`
    EXPLAIN QUERY PLAN
    SELECT ts.board_id, ts.peer_machine_id, ts.final_state_version, ts.acked, ts.next_retry_at,
           t.host_machine_id, t.deleted_by_key, t.deleted_at
    FROM board_tombstone_sync ts
    JOIN board_tombstones t ON t.board_id = ts.board_id
    WHERE ts.peer_machine_id = ? AND ts.acked = 0 AND ts.next_retry_at <= ?
    ORDER BY ts.next_retry_at ASC, ts.board_id ASC
    LIMIT 64
  `).all("train", t0).map(r => r.detail);
  for (const detail of tombstonePlan) {
    assert.doesNotMatch(detail, /^SCAN\s+\w+(?:\s+AS\s+\w+)?$/i, `listPendingTombstoneSyncs 出现全表 SCAN: ${detail}`);
  }
  assert.ok(
    tombstonePlan.some(d => d.includes("idx_board_tombstone_sync_due")),
    `listPendingTombstoneSyncs 未命中 idx_board_tombstone_sync_due: ${JSON.stringify(tombstonePlan)}`,
  );

  // 2) EXPLAIN QUERY PLAN 验证其余 2 项新增索引零 SCAN
  const outboxBoardPlan = inspectDb.prepare(`
    EXPLAIN QUERY PLAN
    UPDATE board_remote_outbox
    SET status = 'rejected_deleted', last_error_code = 'board_deleted_tombstone', updated_at = ?
    WHERE board_id = ? AND status IN ('pending', 'dispatching', 'unknown')
  `).all(new Date(t0).toISOString(), "tomb-idx-0").map(r => r.detail);
  for (const detail of outboxBoardPlan) {
    assert.doesNotMatch(detail, /^SCAN\s+\w+(?:\s+AS\s+\w+)?$/i, `outbox by board 出现全表 SCAN: ${detail}`);
  }
  assert.ok(
    outboxBoardPlan.some(d => d.includes("idx_board_remote_outbox_board")),
    `outbox by board 未命中 idx_board_remote_outbox_board: ${JSON.stringify(outboxBoardPlan)}`,
  );

  const pruneFileOpsPlan = inspectDb.prepare(`
    EXPLAIN QUERY PLAN
    DELETE FROM board_file_ops
    WHERE status IN ('done', 'superseded') AND updated_at <= ?
  `).all(new Date(t0).toISOString()).map(r => r.detail);
  for (const detail of pruneFileOpsPlan) {
    assert.doesNotMatch(detail, /^SCAN\s+\w+(?:\s+AS\s+\w+)?$/i, `prune file_ops 出现全表 SCAN: ${detail}`);
  }
  assert.ok(
    pruneFileOpsPlan.some(d => d.includes("idx_board_file_ops_status_updated")),
    `prune file_ops 未命中 idx_board_file_ops_status_updated: ${JSON.stringify(pruneFileOpsPlan)}`,
  );

  // 2b) EXPLAIN QUERY PLAN 验证更新后的 listDueFileSyncItems 与 listDueRemoteOutbox 仍零全表 SCAN
  const dueFileSyncPlan = inspectDb.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM board_file_sync_queue
    WHERE status IN ('pending', 'sending')
      AND peer_machine_id = ?
      AND next_retry_at <= ?
      AND (status = 'pending' OR next_retry_at > 0)
    ORDER BY next_retry_at ASC, seq ASC
    LIMIT 63
  `).all("train", t0).map(r => r.detail);
  for (const detail of dueFileSyncPlan) {
    assert.doesNotMatch(detail, /^SCAN\s+\w+(?:\s+AS\s+\w+)?$/i, `listDueFileSyncItems 出现全表 SCAN: ${detail}`);
  }
  assert.ok(
    dueFileSyncPlan.some(d => d.includes("idx_board_file_sync_due")),
    `listDueFileSyncItems 未命中 idx_board_file_sync_due: ${JSON.stringify(dueFileSyncPlan)}`,
  );

  const dueOutboxPlan = inspectDb.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM board_remote_outbox
    WHERE status IN ('pending', 'unknown') AND host_machine_id = ? AND next_retry_at <= ?
    ORDER BY next_retry_at ASC, created_at ASC
    LIMIT 32
  `).all("train", t0).map(r => r.detail);
  for (const detail of dueOutboxPlan) {
    assert.doesNotMatch(detail, /^SCAN\s+\w+(?:\s+AS\s+\w+)?$/i, `listDueRemoteOutbox 出现全表 SCAN: ${detail}`);
  }
  assert.ok(
    dueOutboxPlan.some(d => d.includes("idx_board_outbox_due")),
    `listDueRemoteOutbox 未命中 idx_board_outbox_due: ${JSON.stringify(dueOutboxPlan)}`,
  );

  // 3) updateTombstoneSyncBackoff 精准控制墓碑重传退避
  assert.equal(boardStore.listPendingTombstoneSyncs("train", t0).length, 15);
  assert.equal(
    boardStore.updateTombstoneSyncBackoff("tomb-idx-0", "train", { next_retry_at: t0 + 60000 }),
    true,
  );
  const dueAtT0 = boardStore.listPendingTombstoneSyncs("train", t0);
  assert.equal(dueAtT0.length, 14);
  assert.equal(dueAtT0.some(row => row.board_id === "tomb-idx-0"), false);
  const dueLater = boardStore.listPendingTombstoneSyncs("train", t0 + 60000);
  assert.equal(dueLater.length, 15);
  assert.equal(dueLater.find(row => row.board_id === "tomb-idx-0").next_retry_at, t0 + 60000);

  // 已 ack 的墓碑不可再更新退避
  assert.equal(boardStore.ackTombstoneSync("tomb-idx-0", "train", 2), true);
  assert.equal(
    boardStore.updateTombstoneSyncBackoff("tomb-idx-0", "train", { next_retry_at: t0 + 120000 }),
    false,
  );

  // 4) listBoardsForActor：退订后 unread_count === 0（普通成员与超管均生效），且合并查询 last_synced_at 消除 N+1
  for (let i = 0; i < 4; i += 1) {
    const bid = `actor-list-${i}`;
    boardStore.createBoard({ board_id: bid, host_machine_id: "dev", title: `List ${i}`, creator: devCreator });
    boardStore.upsertMember(bid, devMember);
    boardStore.appendPost({ boardId: bid, author: devCreator, body: `p1-${i}`, originClientPostId: `lp1-${i}` });
    boardStore.appendPost({ boardId: bid, author: devCreator, body: `p2-${i}`, originClientPostId: `lp2-${i}` });
    boardStore.advanceSyncState(bid, "train", {
      acked_seq: 1,
      synced_at: `2026-11-27T08:0${i}:00.000Z`,
    });
    boardStore.advanceSyncState(bid, "gpu-node", {
      acked_seq: 2,
      synced_at: `2026-11-27T09:0${i}:00.000Z`,
    });
  }
  // m2 退订 actor-list-0，保持订阅 actor-list-1（已读到 1）
  boardStore.setMemberSubscriptionState("actor-list-0", m2Key, "unsubscribed");
  boardStore.updateMemberReadCursor("actor-list-1", m2Key, 1);

  const memberView = boardStore.listBoardsForActor({ actorKey: m2Key });
  const item0Member = memberView.items.find(b => b.board_id === "actor-list-0");
  const item1Member = memberView.items.find(b => b.board_id === "actor-list-1");
  assert.equal(item0Member.subscription_state, "unsubscribed");
  assert.equal(item0Member.unread_count, 0, "已退订成员 unread_count 必须置 0");
  assert.equal(item0Member.last_synced_at, "2026-11-27T09:00:00.000Z");
  assert.equal(item1Member.subscription_state, "active");
  assert.equal(item1Member.unread_count, 1);
  assert.equal(item1Member.last_synced_at, "2026-11-27T09:01:00.000Z");

  // 超管视角：已退订板 unread_count === 0，非成员板 unread_count === 0
  const adminView = boardStore.listBoardsForActor({ actorKey: m2Key, isSuperAdmin: true });
  const item0Admin = adminView.items.find(b => b.board_id === "actor-list-0");
  assert.equal(item0Admin.subscription_state, "unsubscribed");
  assert.equal(item0Admin.unread_count, 0, "超管视角已退订板 unread_count 也必须置 0");
  assert.equal(item0Admin.last_synced_at, "2026-11-27T09:00:00.000Z");

  // 使用 prepare 计数验证 listBoardsForActor 彻底消除 N+1（每次调用固定 2 次 prepare：COUNT + 主 SELECT）
  const spyDb = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true, defensive: true });
  const spyRoot = mkdtempSync(join(tmpdir(), "board-store-spy-"));
  t.after(() => {
    try { spyDb.close(); } catch { /* ignore */ }
    rmSync(spyRoot, { recursive: true, force: true });
  });
  let prepareCount = 0;
  const origPrepare = spyDb.prepare.bind(spyDb);
  spyDb.prepare = (...args) => {
    prepareCount += 1;
    return origPrepare(...args);
  };
  const spyStore = new BoardStore({ database: spyDb, privateRoot: spyRoot });
  for (let i = 0; i < 10; i += 1) {
    const bid = `n1-board-${i}`;
    spyStore.createBoard({ board_id: bid, host_machine_id: "dev", title: `N1 ${i}`, creator: devCreator });
    spyStore.advanceSyncState(bid, "train", { acked_seq: 0, synced_at: "2026-11-27T10:00:00.000Z" });
  }
  prepareCount = 0;
  const n1MemberRes = spyStore.listBoardsForActor({ actorKey: devKey, limit: 10 });
  assert.equal(n1MemberRes.items.length, 10);
  assert.equal(n1MemberRes.items[0].last_synced_at, "2026-11-27T10:00:00.000Z");
  assert.equal(prepareCount, 2, `成员 listBoardsForActor 应消除 N+1（固定 2 条 SQL），实际 ${prepareCount}`);

  prepareCount = 0;
  const n1AdminRes = spyStore.listBoardsForActor({ actorKey: devKey, isSuperAdmin: true, limit: 10 });
  assert.equal(n1AdminRes.items.length, 10);
  assert.equal(prepareCount, 2, `超管 listBoardsForActor 应消除 N+1（固定 2 条 SQL），实际 ${prepareCount}`);
});

test("W2-3 R2 纵深: validateSafeRelPath 拒绝 Windows 盘符前缀路径", t => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true, defensive: true });
  const root = mkdtempSync(join(tmpdir(), "board-store-drive-"));
  t.after(() => {
    try { db.close(); } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true });
  });
  const store = new BoardStore({ database: db, privateRoot: root });
  const creator = makeIdentity("dev", "conv-drive-creator");
  store.createBoard({ board_id: "drive-check", host_machine_id: "dev", title: "盘符防线", creator });
  assert.throws(
    () => store.appendPost({
      board_id: "drive-check",
      author: creator,
      origin_client_post_id: "drive-p1",
      body: "bad-rel",
      files: [{
        file_id: "f-drive-1",
        safe_name: "ok.txt",
        bytes: 4,
        sha256: "a".repeat(64),
        rel_path: "C:/win/path.diff",
        local_status: "ready",
      }],
    }),
    err => err?.code === "invalid_input",
  );
});
