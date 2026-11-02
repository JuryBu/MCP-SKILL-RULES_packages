import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-host-devin-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(root, "sessions.db");
process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(root, "desktop");
fs.mkdirSync(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT);
const { createHostCorpusProvider } = await import("../src/conversation-corpus-reader-hosts.ts");
const writer = new DatabaseSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH);
writer.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
CREATE TABLE sessions(id TEXT PRIMARY KEY,main_chain_id INTEGER,title TEXT,last_activity_at INTEGER,metadata TEXT);
CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,metadata TEXT,created_at INTEGER,PRIMARY KEY(session_id,node_id));`);
const id = "fixture-heron";
writer.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(id, 128, "fixture", 1, "{}");
const insert = writer.prepare("INSERT INTO message_nodes VALUES(?,?,?,?,?,?)");
for (let index = 0; index < 64; index++) {
    const nodeId = index * 2 + 1;
    insert.run(id, nodeId, nodeId === 1 ? null : nodeId - 1, JSON.stringify({ role: "user", content: `question-${index + 1}` }), "{}", index);
    insert.run(id, nodeId + 1, nodeId, JSON.stringify({ role: "assistant", content: index ? `answer-${index + 1}` : "X".repeat(2 * 1024 * 1024) }), "{}", index);
}
try {
    const conversation = { source: "windsurf" as const, id, canonicalId: id, title: "fixture", workspace: root, sourceKind: "devin-cli", rolloutPath: process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH };
    const provider = createHostCorpusProvider("windsurf");
    const tail = await provider.readFast(conversation, { lastRounds: 2 });
    assert.equal(tail.roundNumbering, "absolute");
    assert.equal(tail.totalRounds, 64);
    assert.deepEqual(tail.rounds?.map(round => round.roundIndex), [63, 64]);
    assert.equal(tail.requestedRangeComplete, true);
    assert.equal(tail.complete, false);
    assert.ok(tail.timings!.bytesRead < 64 * 1024);
    const full = await provider.read(conversation, {});
    assert.equal(full.complete, true);
    assert.equal(full.revision, tail.revision);
    assert.equal(full.totalRounds, 64);
    const reopened = await createHostCorpusProvider("windsurf").readFast(conversation, { lastRounds: 2 });
    assert.equal(reopened.revision, tail.revision);
    const originalMtime = fs.statSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH).mtimeMs;
    writer.prepare("UPDATE message_nodes SET chat_message=? WHERE session_id=? AND node_id=2").run(JSON.stringify({ role: "assistant", content: "Y".repeat(2 * 1024 * 1024) }), id);
    assert.equal(fs.statSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH).mtimeMs, originalMtime);
    const changed = await provider.readFast(conversation, { lastRounds: 2 });
    assert.notEqual(changed.revision, tail.revision);
    await assert.rejects(provider.readRounds(conversation, { revision: tail.revision, startRound: 63, endRound: 64 }), /revision changed/u);
    console.log(JSON.stringify({ test: "conversation-host-devin", tail: tail.timings, full: full.timings, totalRounds: full.totalRounds, walRewriteChangedRevision: true, reopenRevisionStable: true }));
} finally {
    writer.close();
    fs.rmSync(root, { recursive: true, force: true });
}
