import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devin-wsf-cache-validation-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(root, "sessions.db");
process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(root, "desktop");
process.env.MEMORY_STORE_WSF_SUBAGENT_JOBS_PATH = path.join(root, "missing-jobs.json");
fs.mkdirSync(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT);
const identifier = "fixture-source-validation";
const alias = "11111111-2222-4333-8444-555555555555";
const database = new DatabaseSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH);
database.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE sessions(id TEXT PRIMARY KEY, working_directory TEXT, title TEXT, created_at INTEGER, last_activity_at INTEGER, main_chain_id INTEGER, workspace_dirs TEXT, hidden INTEGER, metadata TEXT);
CREATE TABLE message_nodes(row_id INTEGER PRIMARY KEY, session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT, created_at INTEGER, metadata TEXT);
CREATE TABLE tool_call_state(session_id TEXT, tool_call_id TEXT, tool_call_json TEXT, tool_call_update_json TEXT);
CREATE TABLE subagent_heads(session_id TEXT, agent_id TEXT, chain_node_id INTEGER, updated_at INTEGER);
CREATE INDEX idx_message_nodes_session ON message_nodes(session_id);`);
database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(identifier, root, "Fixture source", 1, 2, 4, "[]", 0, "{}");
const messages = [
    { role: "user", content: "first fixture needle", metadata: { is_user_input: true, extensions: { "chisel/client-message-id": "shared-fixture-first" } } },
    { role: "assistant", content: "first fixture response" },
    { role: "user", content: "last fixture needle", metadata: { is_user_input: true } },
    { role: "assistant", content: "last fixture response" },
];
for (const [index, message] of messages.entries()) database.prepare("INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?, ?, ?)").run(index + 1, identifier, index + 1, index || null, JSON.stringify(message), index + 1, null);
const desktop = new DatabaseSync(path.join(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT, `${alias}.db`));
desktop.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE messages(position INTEGER PRIMARY KEY,kind TEXT,payload TEXT);");
desktop.prepare("INSERT INTO meta VALUES ('info',?)").run(JSON.stringify({ title: "Fixture source", cwd: root }));
desktop.prepare("INSERT INTO messages VALUES (0,'user_message',?)").run(JSON.stringify({ content: [{ content: { type: "text", text: "first fixture needle" }, _meta: { "cognition.ai/clientMessageId": "shared-fixture-first" } }] }));
desktop.close();
const { loadConversationData } = await import("../src/conversation-bridge.js");
const { devinSourceValidationRevision } = await import("../src/devin-source-validation.js");
const { discoverDevinConversations, DevinIdentityCache } = await import("../src/devin-sqlite.js");
const { registerConversation } = await import("../src/tools/conversation.js");
const { __setWindsurfEndpointResolverForTest } = await import("../src/windsurf-client.js");
__setWindsurfEndpointResolverForTest(async () => []);
let handler: (params: any) => Promise<any> = async () => { throw new Error("tool not registered"); };
let schema: Record<string, z.ZodTypeAny> = {};
registerConversation({ tool: (_name: string, _description: string, rawSchema: typeof schema, callback: typeof handler) => { schema = rawSchema; handler = callback; } } as any);
const results: Array<{ action: unknown; elapsedMs: number }> = [];
async function call(params: Record<string, unknown>): Promise<string> {
    const started = performance.now();
    const response = await handler(z.object(schema).parse({ conversationId: identifier, dataChain: "windsurf", ...params }));
    const text = response.content.map((item: { text?: string }) => item.text || "").join("\n");
    assert.notEqual(response.isError, true, text);
    assert.doesNotMatch(text, /失败|无法通过|Devin.*deadline/u);
    results.push({ action: params.action, elapsedMs: Math.round(performance.now() - started) });
    return text;
}

try {
    const fetchedText = await call({ action: "fetch", progressive: false });
    assert.match(fetchedText, /2 轮对话/u);
    const fetched = await loadConversationData("windsurf", identifier, { source: "cache" });
    assert.ok(fetched?.cacheGeneration);
    assert.match(fetched.cacheFingerprint?.revision || "", /^devin-sqlite\/source-v2:/u);
    for (const source of ["auto", "local"] as const) {
        const strict = await loadConversationData("windsurf", alias, { source });
        assert.equal(strict?.cacheGeneration, fetched.cacheGeneration);
        assert.equal(strict?.cacheReadPolicy, "verified");
    }
    assert.match(await call({ action: "read", startRound: 1, endRound: 1 }), /first fixture needle/u);
    assert.match(await call({ action: "search", query: "needle", mode: "exact", limit: 12 }), /命中/u);
    assert.match(await call({ action: "read", startRound: 2, endRound: 2 }), /last fixture needle/u);
    const concurrent = await Promise.all([
        call({ action: "read", startRound: 1, endRound: 1 }),
        call({ action: "search", query: "needle", mode: "exact", limit: 12 }),
        call({ action: "read", startRound: 2, endRound: 2 }),
    ]);
    for (const text of concurrent) assert.match(text, new RegExp(fetched.cacheGeneration));
    const identityCache = new DevinIdentityCache();
    try {
        const discovered = await discoverDevinConversations({ identityCache, workspaces: [root], maxNodes: 20, verifyAliases: false });
        assert.ok(discovered.conversations.some(item => item.id === identifier));
        assert.ok(!discovered.diagnostics.some(item => /DEADLINE|BUDGET/u.test(item.code)), JSON.stringify(discovered.diagnostics));
    } finally { identityCache.close(); }
    const before = devinSourceValidationRevision();
    const walPath = `${process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH}-wal`;
    const originalTimes = fs.statSync(walPath);
    database.prepare("UPDATE message_nodes SET chat_message=? WHERE session_id=? AND node_id=4").run(JSON.stringify({ role: "assistant", content: "edited same head fixture response" }), identifier);
    fs.utimesSync(walPath, originalTimes.atime, originalTimes.mtime);
    assert.notEqual(devinSourceValidationRevision(), before);
    const changed = await loadConversationData("windsurf", alias, { source: "local" });
    assert.notEqual(changed?.cacheGeneration, fetched.cacheGeneration);
    assert.match(JSON.stringify(changed?.rounds), /edited same head fixture response/u);
    const original = await loadConversationData("windsurf", alias, { source: "cache", cacheGeneration: fetched.cacheGeneration });
    assert.equal(original?.cacheGeneration, fetched.cacheGeneration);
    assert.doesNotMatch(JSON.stringify(original?.rounds), /edited same head fixture response/u);
    database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("conflicting-fixture", root, "Conflict", 1, 2, 1, "[]", 0, "{}");
    database.prepare("INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?, ?, ?)").run(50, "conflicting-fixture", 1, null, JSON.stringify(messages[0]), 1, null);
    const conflict = await loadConversationData("windsurf", identifier, { source: "local" });
    assert.ok(conflict?.windsurfData?.thread.aliases?.length === 1);
    await assert.rejects(() => loadConversationData("windsurf", alias, { source: "local" }), /identity changed|migration|ambiguous/u);
    console.log(JSON.stringify({ status: "PASS", results }));
} finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
}
