import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalHome = os.homedir;
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-history-bridge-"));
const codexHome = path.join(temporaryRoot, ".codex");
const sessions = path.join(codexHome, "sessions");
fs.mkdirSync(sessions, { recursive: true });
os.homedir = () => temporaryRoot;

const conversationId = "11111111-1111-4111-8111-111111111111";
const rolloutId = "22222222-2222-4222-8222-222222222222";
const originalPath = path.join(sessions, `rollout-2026-01-01T00-00-00-${conversationId}.jsonl`);
const revisedPath = path.join(sessions, `rollout-2026-01-02T00-00-00-${conversationId}_${rolloutId}.jsonl`);
const databasePath = path.join(codexHome, "state_5.sqlite");
const message = (role: string, text: string) => ({ type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
const serialize = (events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n") + "\n";
const metadata = (historyBase?: unknown) => ({ type: "session_meta", payload: { id: conversationId, session_id: conversationId, cwd: temporaryRoot, history_mode: "paginated", ...(historyBase ? { history_base: historyBase } : {}) } });
const database = (script: string, ...args: string[]) => execFileSync("python", ["-c", `import sqlite3,sys\nconn=sqlite3.connect(sys.argv[1])\n${script}\nconn.commit()\nconn.close()`, databasePath, ...args], { encoding: "utf8" });

try {
    const codex = await import("../src/codex-client.ts");
    const cache = await import("../src/conversation-source-cache.ts");
    const bridge = await import("../src/conversation-bridge.ts");
    const worker = await import("../src/conversation-fetch-worker-client.ts");
    cache.setConversationSourceCacheDataRootForTests(path.join(temporaryRoot, "cache"));
    const prefix = [metadata(), message("user", "KEEP_FIRST"), message("assistant", "FIRST_ANSWER")];
    const excluded = [message("user", "DROPPED_AFTER_REVERT"), message("assistant", "EXCLUDED_ANSWER")];
    fs.writeFileSync(originalPath, serialize([...prefix, ...excluded]), "utf8");
    database("conn.execute('create table threads(id text primary key,rollout_path text,cwd text,title text,source text,model text,reasoning_effort text,agent_nickname text,agent_role text,updated_at_ms integer,updated_at integer,archived integer)')\nconn.execute('create table thread_spawn_edges(parent_thread_id text,child_thread_id text,status text)')\nconn.execute('insert into threads values(?,?,?,?,?,?,?,?,?,?,?,?)',(sys.argv[2],sys.argv[3],sys.argv[4],'test','vscode',None,None,None,None,1,1,0))", conversationId, originalPath, temporaryRoot);

    const initial = await bridge.loadConversationData("codex", conversationId, { source: "local", link: "reference" });
    assert.ok(initial);
    assert.deepEqual(initial.rounds.map(round => round.userMessage), ["KEEP_FIRST", "DROPPED_AFTER_REVERT"]);
    const originalGeneration = initial.cacheGeneration;
    const base = { thread_id: conversationId, end_ordinal_exclusive: prefix.length, end_byte_offset: Buffer.byteLength(serialize(prefix)) };
    fs.writeFileSync(revisedPath, serialize([metadata(base), message("user", "CURRENT_LEAF"), message("assistant", "CURRENT_ANSWER")]), "utf8");
    database("conn.execute('update threads set rollout_path=?,updated_at_ms=2 where id=?',(sys.argv[2],sys.argv[3]))", revisedPath, conversationId);

    const revised = await bridge.loadConversationData("codex", conversationId, { source: "local", link: "reference" });
    assert.ok(revised);
    assert.deepEqual(revised.rounds.map(round => round.userMessage), ["KEEP_FIRST", "CURRENT_LEAF"]);
    assert.notEqual(revised.cacheGeneration, originalGeneration);
    assert.equal(revised.codexData?.thread.rolloutPath, revisedPath);
    assert.equal(revised.codexData?.historySource?.segments.length, 2);
    assert.equal(revised.totalSteps, 6);
    assert.equal(revised.codexData?.sourceCheckpoint?.replaceFromRound, 2);
    assert.equal(revised.codexData?.sourceCheckpoint?.replayStartStep, 5);

    const repeated = await bridge.loadConversationData("codex", conversationId, { source: "local", link: "reference" });
    assert.equal(repeated?.cacheGeneration, revised.cacheGeneration);
    assert.equal(repeated?.cacheState, "hit");
    const frozen = codex.captureCodexSourceVersion(revisedPath);
    if (process.platform === "win32") {
        codex.assertCodexSourceVersionSync(path.toNamespacedPath(revisedPath), frozen, "namespaced regression");
    }
    fs.appendFileSync(revisedPath, serialize([message("user", "APPENDED_LEAF"), message("assistant", "APPENDED_ANSWER")]), "utf8");
    const appended = await bridge.loadConversationData("codex", conversationId, { source: "local", link: "reference" });
    assert.ok(appended);
    assert.deepEqual(appended.rounds.map(round => round.userMessage), ["KEEP_FIRST", "CURRENT_LEAF", "APPENDED_LEAF"]);
    assert.ok(appended.sourceDiagnostics?.some(item => item.includes("仅重放")));
    assert.equal(appended.totalSteps, 8);
    assert.equal(appended.codexData?.sourceCheckpoint?.replaceFromRound, 3);

    const fixedSnapshot = await bridge.loadConversationData("codex", conversationId, { source: "local", link: "reference", expectedCodexSource: frozen });
    assert.deepEqual(fixedSnapshot?.rounds.map(round => round.userMessage), ["KEEP_FIRST", "CURRENT_LEAF"]);
    const latest = await bridge.loadConversationData("codex", conversationId, { source: "local", link: "reference" });
    assert.equal(latest?.rounds.length, 3);

    const synchronous = codex.loadCodexConversation(conversationId, "reference");
    const asynchronous = await codex.loadCodexConversationAsync(conversationId, "reference");
    assert.deepEqual(synchronous?.rounds.map(round => round.userMessage), latest?.rounds.map(round => round.userMessage));
    assert.deepEqual(asynchronous?.rounds.map(round => round.userMessage), latest?.rounds.map(round => round.userMessage));
    const evidence = await codex.readCodexEvidenceRolloutForTest(revisedPath);
    assert.equal(evidence.errors.length, 0);
    assert.ok(JSON.stringify(evidence.messages).includes("KEEP_FIRST"));
    assert.ok(!JSON.stringify(evidence.messages).includes("DROPPED_AFTER_REVERT"));

    const priorThreshold = process.env.MEMORY_STORE_CODEX_FETCH_BACKGROUND_THRESHOLD_BYTES;
    process.env.MEMORY_STORE_CODEX_FETCH_BACKGROUND_THRESHOLD_BYTES = String(fs.statSync(revisedPath).size + 1);
    assert.equal(worker.estimateCodexFetchWork(conversationId)?.shouldBackground, true);
    if (priorThreshold === undefined) delete process.env.MEMORY_STORE_CODEX_FETCH_BACKGROUND_THRESHOLD_BYTES;
    else process.env.MEMORY_STORE_CODEX_FETCH_BACKGROUND_THRESHOLD_BYTES = priorThreshold;

    const validLeaf = fs.readFileSync(revisedPath, "utf8");
    fs.writeFileSync(revisedPath, serialize([metadata({ ...base, end_ordinal_exclusive: base.end_ordinal_exclusive + 1 }), message("user", "INVALID_ORDINAL_MUST_NOT_PUBLISH")]), "utf8");
    const rejected = await bridge.loadConversationData("codex", conversationId, { source: "local", link: "reference" });
    assert.equal(rejected?.cacheState, "stale");
    assert.ok(rejected?.cacheBuildFailure?.message.includes("ordinal"));
    const retained = await bridge.loadConversationData("codex", conversationId, { source: "cache", link: "reference" });
    assert.equal(retained?.cacheGeneration, latest?.cacheGeneration);
    assert.deepEqual(retained?.rounds.map(round => round.userMessage), ["KEEP_FIRST", "CURRENT_LEAF", "APPENDED_LEAF"]);
    fs.writeFileSync(revisedPath, validLeaf, "utf8");

    fs.renameSync(originalPath, originalPath + ".held");
    await assert.rejects(() => bridge.loadConversationData("codex", conversationId, { source: "local", link: "reference" }), /history|rollout|source|missing|found/i);
    console.log("Codex history bridge: cold/revert/warm/append/frozen/sync/async/evidence/background/rejected-publication/missing-source passed");
    cache.setConversationSourceCacheDataRootForTests(undefined);
} finally {
    os.homedir = originalHome;
    assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
