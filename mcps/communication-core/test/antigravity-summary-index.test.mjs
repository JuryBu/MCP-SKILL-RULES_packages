import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createAntigravitySummaryIndex } from "../src/antigravity-summary-index.mjs";

async function fixture(context, { withoutKey = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "communication-summary-index-fixture-"));
  const filePath = join(directory, "conversation_summaries.db");
  const db = new DatabaseSync(filePath);
  let writerOpen = true;
  function closeWriter() {
    if (writerOpen) db.close();
    writerOpen = false;
  }
  const index = createAntigravitySummaryIndex({ filePath, timeoutMs: 2500 });
  context.after(async () => {
    await index.close();
    closeWriter();
    for (const name of await readdir(directory)) {
      assert.ok(["conversation_summaries.db", "conversation_summaries.db-wal", "conversation_summaries.db-shm"].includes(name));
      await unlink(join(directory, name));
    }
    await rmdir(directory);
  });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE conversation_summaries (conversation_id TEXT ${withoutKey ? "" : "PRIMARY KEY"}, title TEXT, workspace_uris TEXT,
      last_modified_time TEXT, parent_conversation_id TEXT, nesting_depth INTEGER, status TEXT, preview TEXT, source TEXT, agent_name TEXT)`);
  const insert = db.prepare("INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?)");
  const paths = JSON.stringify(["file:///C:/SYNTHETIC_PRIVATE_DIRECTORY/%E6%B5%8B%E8%AF%95", "https://unused.example/other"]);
  for (const id of ["first", "middle", "older"]) {
    insert.run(id, "合成标题", paths, "2026-11-18T05:03:15Z", null, 0, "historical-running", "PRIVATE-RAW-PREVIEW", "", "");
  }
  insert.run("child", "子条目", paths, "2026-11-18T05:03:15Z", "first", 1, "historical-running", "PRIVATE-RAW-PREVIEW", null, "child agent");
  insert.run("cli-root", "无头 CLI", paths, "2026-11-18T05:03:15Z", null, 0, null, null, "CORTEX_TRAJECTORY_SOURCE_CLI", "");
  insert.run("named-agent-root", "后台代理", paths, "2026-11-18T05:03:15Z", null, 0, null, null, "", "isolated agent");
  return { filePath, index, directory, closeWriter };
}

test("bounded SQLite index uses current WAL and returns only root directory metadata in stable pages", async context => {
  const { filePath, index } = await fixture(context);
  const before = await Promise.all(["", "-wal"].map(suffix => readFile(filePath + suffix)));
  const first = await index.page({ limit: 2 });
  assert.equal(first.has_more, true);
  assert.deepEqual(first.conversations.map(row => row.cascade_id), ["first", "middle"]);
  assert.deepEqual(first.conversations[0], { cascade_id: "first", title: "合成标题", workspace: "测试", updated_at: "2026-11-18T05:03:15Z" });
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE|preview|historical|child/u);
  const second = await index.page({ limit: 2, after: "middle" });
  assert.equal(second.has_more, false);
  assert.equal(second.generation, first.generation);
  assert.deepEqual(second.conversations.map(row => row.cascade_id), ["older"]);
  assert.deepEqual(await Promise.all(["", "-wal"].map(suffix => readFile(filePath + suffix))), before);
});

test("point lookups verify cold desktop roots without admitting CLI or child rows", async context => {
  const { index } = await fixture(context);
  assert.equal((await index.find({ conversationId: "older" })).cascade_id, "older");
  for (const identity of ["ol", "child", "cli-root", "named-agent-root"]) {
    assert.equal(await index.find({ conversationId: identity }), null);
  }
  assert.throws(() => index.find({ conversationId: "../older" }), { code: "invalid_input" });
});

test("a checkpointed source with no WAL or SHM files remains readable without recreating sidecars in that profile", async context => {
  const { filePath, index, directory, closeWriter } = await fixture(context);
  closeWriter();
  const before = await readFile(filePath);
  assert.deepEqual(await readdir(directory), ["conversation_summaries.db"]);
  assert.equal((await index.page({ limit: 2 })).conversations.length, 2);
  assert.deepEqual(await readdir(directory), ["conversation_summaries.db"]);
  assert.deepEqual(await readFile(filePath), before);
});

test("index rejects unverified schema and never opens a missing root or uses user input as a path", async context => {
  const { directory, index } = await fixture(context, { withoutKey: true });
  assert.throws(() => index.page({ after: "../test", limit: 1 }), { code: "invalid_cursor" });
  assert.throws(() => createAntigravitySummaryIndex({ filePath: join(directory, "other.db") }), { code: "invalid_config" });
  await assert.rejects(index.page({ limit: 1 }), { code: "host_content_unverified" });
  const missing = createAntigravitySummaryIndex({ filePath: join(directory, "missing", "conversation_summaries.db") });
  await assert.rejects(missing.page({ limit: 1 }), { code: "host_content_unavailable" });
  await missing.close();
  assert.ok(!(await readdir(directory)).includes("missing"));
});

test("busy and cancellation retain a single worker lease until exit, then an ordinary page still works", async context => {
  const { index } = await fixture(context);
  const controller = new AbortController();
  const pending = index.page({ limit: 2, signal: controller.signal });
  assert.throws(() => index.page({ limit: 2 }), { code: "host_content_busy" });
  controller.abort();
  await assert.rejects(pending, { code: "request_cancelled" });
  assert.equal((await index.page({ limit: 1 })).conversations.length, 1);
  await index.close();
  assert.throws(() => index.page({ limit: 1 }), { code: "request_cancelled" });
});
