import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-devin-fast-range-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(root, "sessions.db");
process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(root, "desktop");
fs.mkdirSync(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT);
const { DevinIdentityCache, discoverDevinConversations, readDevinRawConversation, resolveDevinConversation } = await import("../src/devin-sqlite.js");
const { readDevinConversation } = await import("../src/devin-conversation.js");
const sessionId = "fixture-falcon";
const uuid = "00000000-0000-0000-0000-000000000001";
const writer = new DatabaseSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH);
writer.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,main_chain_id INTEGER,title TEXT,last_activity_at INTEGER,metadata TEXT);
    CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,metadata TEXT,created_at INTEGER,PRIMARY KEY(session_id,node_id));`);
writer.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(sessionId, 128, "Synthetic source", 1, "{}");
const insert = writer.prepare("INSERT INTO message_nodes VALUES(?,?,?,?,?,?)");
for (let index = 0; index < 64; index++) {
    const userId = index * 2 + 1;
    insert.run(sessionId, userId, userId === 1 ? null : userId - 1, JSON.stringify({ role: "user", content: `Synthetic question ${index + 1}`,
        metadata: { extensions: { "chisel/client-message-id": `client-message-${index + 1}` } } }), "{}", index + 1);
    insert.run(sessionId, userId + 1, userId, JSON.stringify({ role: "assistant", content: index === 0 ? "X".repeat(2 * 1024 * 1024) : `Synthetic answer ${index + 1}` }), "{}", index + 1);
}
const desktopPath = path.join(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT, `${uuid}.db`);
const desktop = new DatabaseSync(desktopPath);
desktop.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE messages(position INTEGER PRIMARY KEY,kind TEXT,payload TEXT);");
desktop.prepare("INSERT INTO meta VALUES('info','{}')").run();
desktop.prepare("INSERT INTO messages VALUES(0,'user_message',?)").run(JSON.stringify({ content: [{ content: { type: "text", text: "Synthetic question 1" },
    _meta: { "cognition.ai/clientMessageId": "client-message-1" } }] }));
desktop.close();
let cache = new DevinIdentityCache();
try {
    const targetedMetadata = await discoverDevinConversations({ conversationIds: [sessionId], maxNodes: 4, maxBytes: 4096, maxDesktopFiles: 0 });
    assert.deepEqual(targetedMetadata.conversations.map(item => item.id), [sessionId]);
    assert.equal(targetedMetadata.scannedDesktopFiles, 0);
    assert.equal(targetedMetadata.partial, false);
    const metadata = await discoverDevinConversations({ maxBytes: 4096, maxNodes: 16 });
    assert.equal(metadata.conversations.length, 2);
    assert.equal(metadata.conversations.find(item => item.id === sessionId)?.uuid, undefined);
    const probe = await readDevinConversation(sessionId, { materializeAttachments: false, identityCache: cache });
    assert.equal(probe?.raw.summary.uuid, uuid);
    assert.deepEqual(probe?.raw.summary.aliases, [sessionId, uuid]);
    assert.equal(probe?.raw.summary.identityEvidence, "client-message-id");
    assert.equal((await resolveDevinConversation(uuid, { identityCache: cache }))?.canonicalId, sessionId);
    const relisted = await discoverDevinConversations();
    assert.deepEqual(relisted.conversations.map(item => item.id), [sessionId]);
    assert.equal(relisted.conversations[0].uuid, uuid);
    console.log("PASS metadata-first discovery avoids identity scan; body probe returns verified UUID/canonical aliases");

    const physical = await readDevinConversation(sessionId, { identityMode: "physical", physicalSourceKind: "devin-cli",
        roundRange: { tailRounds: 2 }, materializeAttachments: false, maxDesktopFiles: 0, maxBytes: 64 * 1024 });
    assert.deepEqual(physical?.rounds.map(round => round.roundIndex), [63, 64]);
    assert.deepEqual(physical?.raw.summary.aliases, [sessionId]);
    assert.equal(physical?.raw.summary.uuid, undefined);
    assert.equal(physical?.raw.summary.identityStatus, "pending");
    assert.equal(physical?.raw.sourceEvidence?.sources?.length, 1);
    assert.equal(physical?.raw.partial, true);
    assert.ok(physical?.raw.warnings.includes("DEVIN_ALIAS_VERIFICATION_PENDING"));
    const physicalDesktop = await readDevinConversation(uuid, { identityMode: "physical", physicalSourceKind: "devin-desktop", materializeAttachments: false, maxDesktopFiles: 0 });
    assert.equal(physicalDesktop?.raw.summary.sourceKind, "devin-desktop");
    assert.deepEqual(physicalDesktop?.raw.summary.aliases, [uuid]);
    assert.equal(physicalDesktop?.raw.summary.sessionId, undefined);
    console.log("PASS physical CLI/Desktop reads bind only their own source and expose alias-pending partial without Desktop enumeration");

    const options = { identityCache: cache, materializeAttachments: false, roundRange: { tailRounds: 2 }, maxBytes: 64 * 1024 };
    const selected = await readDevinConversation(uuid, options);
    assert.deepEqual(selected?.rounds.map(round => round.roundIndex), [63, 64]);
    assert.deepEqual(selected?.rounds.map(round => [round.startStep, round.endStep]), [[124, 125], [126, 127]]);
    assert.equal(selected?.rounds[0].userMessage, "Synthetic question 63");
    assert.equal(selected?.raw.nodes.length, 4);
    assert.equal(selected?.raw.coverage?.totalRounds, 64);
    assert.equal(selected?.raw.coverage?.totalSteps, 128);
    assert.equal(selected?.raw.coverage?.sourceRevision, selected?.raw.fingerprint.revision);
    assert.equal(selected?.raw.partial, true);
    assert.equal(selected?.raw.sourceEvidence?.method, "sqlite-data-version");
    assert.equal(selected?.raw.sourceEvidence?.sources?.length, 2);
    assert.equal(selected?.raw.readMetrics?.identityCacheHit, true);
    assert.ok(selected!.raw.readMetrics!.bytesRead < 64 * 1024);
    await assert.rejects(readDevinRawConversation(uuid, { identityCache: cache, maxBytes: 64 * 1024 }), /maxBytes/u);
    const full = await readDevinRawConversation(uuid, { identityCache: cache });
    assert.deepEqual(selected?.rounds.map(round => round.userMessage), probe?.rounds.slice(-2).map(round => round.userMessage));
    console.log(`METRICS ${JSON.stringify({ full: full?.readMetrics, tail: selected?.raw.readMetrics })}`);
    console.log("PASS early round projection reads four selected bodies under a budget that rejects the full conversation");
    const rangePlan = writer.prepare("EXPLAIN QUERY PLAN SELECT node_id,chat_message FROM message_nodes WHERE session_id=? AND node_id IN (SELECT value FROM json_each(?))").all(sessionId, "[125,126,127,128]").map(row => String(row.detail));
    assert.ok(rangePlan.some(detail => /SEARCH message_nodes USING/u.test(detail)));
    assert.ok(!rangePlan.some(detail => /^SCAN message_nodes/u.test(detail)));
    console.log(`QUERY_PLAN ${JSON.stringify(rangePlan)}`);

    const databaseMtime = fs.statSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH).mtimeMs;
    const firstRevision = selected?.raw.fingerprint.revision;
    writer.prepare("UPDATE message_nodes SET chat_message=? WHERE session_id=? AND node_id=2").run(JSON.stringify({ role: "assistant", content: "Y".repeat(2 * 1024 * 1024) }), sessionId);
    assert.equal(fs.statSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH).mtimeMs, databaseMtime);
    const rewritten = await readDevinConversation(uuid, options);
    assert.notEqual(rewritten?.raw.fingerprint.revision, firstRevision);
    assert.equal(rewritten?.raw.readMetrics?.identityCacheHit, false);
    assert.notDeepEqual(rewritten?.raw.sourceEvidence?.sources, selected?.raw.sourceEvidence?.sources);
    console.log("PASS WAL-only rewrite outside the selected window invalidates identity proof and range revision without DB mtime change");

    writer.prepare("INSERT INTO sessions VALUES('second-session',1,'Synthetic source',1,'{}')").run();
    insert.run("second-session", 1, null, JSON.stringify({ role: "user", content: "Synthetic ambiguity", metadata: { extensions: { "chisel/client-message-id": "client-message-1" } } }), "{}", 1);
    const ambiguous = await resolveDevinConversation(uuid, { identityCache: cache });
    assert.equal(ambiguous?.canonicalId, uuid);
    assert.ok(ambiguous?.warnings.includes("DEVIN_ALIAS_AMBIGUOUS"));
    const physicalAmbiguous = await readDevinConversation(sessionId, { identityMode: "physical", physicalSourceKind: "devin-cli", roundRange: { tailRounds: 2 }, materializeAttachments: false, maxDesktopFiles: 0 });
    assert.deepEqual(physicalAmbiguous?.raw.summary.aliases, [sessionId]);
    assert.equal(physicalAmbiguous?.raw.summary.identityStatus, "pending");
    assert.equal((await discoverDevinConversations()).conversations.find(item => item.id === sessionId)?.uuid, undefined);
    await assert.rejects(readDevinConversation(uuid, options), /Desktop-only/u);
    writer.exec("DELETE FROM message_nodes WHERE session_id='second-session'; DELETE FROM sessions WHERE id='second-session';");
    assert.equal((await resolveDevinConversation(uuid, { identityCache: cache }))?.canonicalId, sessionId);
    console.log("PASS new shared-ID ambiguity prevents alias merge; removal is revalidated");

    const empty = await readDevinConversation(sessionId, { ...options, roundRange: { startRound: 100 } });
    assert.equal(empty?.rounds.length, 0);
    assert.equal(empty?.raw.coverage?.startRound, 65);
    await assert.rejects(readDevinConversation(sessionId, { ...options, roundRange: { tailRounds: 0 } }), /positive/u);
    const previousRevision = rewritten?.raw.fingerprint.revision;
    cache.close();
    cache = new DevinIdentityCache();
    const reopened = await readDevinConversation(uuid, { ...options, identityCache: cache });
    assert.notEqual(reopened?.raw.fingerprint.revision, previousRevision);
    writer.prepare("UPDATE sessions SET main_chain_id=126 WHERE id=?").run(sessionId);
    const reconnected = await readDevinConversation(uuid, { ...options, identityCache: cache });
    assert.equal(reconnected?.raw.coverage?.totalRounds, 63);
    writer.prepare("DELETE FROM message_nodes WHERE session_id=? AND node_id=125").run(sessionId);
    await assert.rejects(readDevinConversation(uuid, { ...options, identityCache: cache }), /round boundaries/u);
    console.log("PASS cache restart, head reconnection, deleted parent, empty range and invalid range remain explicit");
} finally {
    cache.close();
    writer.close();
    fs.rmSync(root, { recursive: true, force: true });
}
