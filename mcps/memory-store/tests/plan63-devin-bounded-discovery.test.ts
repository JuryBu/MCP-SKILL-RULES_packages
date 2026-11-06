import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "plan63-devin-"));
const savedEnvironment = { ...process.env };
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(root, "sessions.db");
process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(root, "desktop");
fs.mkdirSync(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT);

const { ReadBudget, DevinReadError } = await import("../src/devin-sqlite-store.js");
const { findCliIdentityCandidates } = await import("../src/devin-sqlite-cli.js");
const { DevinIdentityCache, discoverDevinConversations, readDevinRawConversation, resolveDevinConversation } = await import("../src/devin-sqlite.js");
const { readDevinConversation } = await import("../src/devin-conversation.js");
const { createContextLocateAdapters } = await import("../src/conversation-context-locate-adapters.js");
const { locateConversationContext } = await import("../src/conversation-context-locate.js");
const { discoverDevinChildCandidates } = await import("../src/devin-child-discovery.js");
const caches: InstanceType<typeof DevinIdentityCache>[] = [];
const writer = new DatabaseSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH);
writer.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, main_chain_id INTEGER, working_directory TEXT, workspace_dirs TEXT, title TEXT,
    created_at INTEGER, last_activity_at INTEGER, hidden INTEGER, metadata TEXT);
    CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,metadata TEXT,created_at INTEGER,PRIMARY KEY(session_id,node_id));
    CREATE TABLE subagent_heads(session_id TEXT,agent_id TEXT,chain_node_id INTEGER,updated_at INTEGER);`);
const insertSession = writer.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)");
const insertNode = writer.prepare("INSERT INTO message_nodes VALUES(?,?,?,?,?,?)");
const sessionId = "fixture-recent-source";
const uuid = "10000000-0000-0000-0000-000000000063";
const marker = "Synthetic recent body marker without an identifier hint";
insertSession.run(sessionId, 32, "/synthetic/target", "[]", "Synthetic recent source", 1, 100, 0, "{}");
for (let round = 1; round <= 16; round++) {
    const userNode = round * 2 - 1;
    insertNode.run(sessionId, userNode, userNode === 1 ? null : userNode - 1,
        JSON.stringify({ role: "user", content: round === 16 ? marker : `Synthetic question ${round}`,
            metadata: { extensions: { "chisel/client-message-id": `synthetic-shared-${round}` } } }), "{}", round);
    insertNode.run(sessionId, userNode + 1, userNode, JSON.stringify({ role: "assistant", content: `Synthetic answer ${round}` }), "{}", round);
}
insertSession.run("unrelated-long-source", 1, "/synthetic/other", "[]", "Unrelated source", 1, 1, 0, "{}");
insertNode.run("unrelated-long-source", 1, null, JSON.stringify({ role: "assistant", content: "x".repeat(2 * 1024 * 1024) }), "{}", 1);
writer.prepare("INSERT INTO subagent_heads VALUES(?,?,?,?)").run(sessionId, "indexed-worker", 900, 101);
insertNode.run(sessionId, 899, null, JSON.stringify({ role: "user", content: "Synthetic child question" }), "{}", 101);
insertNode.run(sessionId, 900, 899, JSON.stringify({ role: "assistant", content: "Synthetic child answer" }), "{}", 101);
const desktop = new DatabaseSync(path.join(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT, `${uuid}.db`));
desktop.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE messages(position INTEGER PRIMARY KEY,kind TEXT,payload TEXT);");
desktop.prepare("INSERT INTO meta VALUES('info',?)").run(JSON.stringify({ cwd: "/synthetic/target", title: "Synthetic desktop alias" }));
desktop.prepare("INSERT INTO messages VALUES(0,'user_message',?)").run(JSON.stringify({ content: [{ content: { type: "text", text: "x".repeat(1024 * 1024) },
    _meta: { "cognition.ai/clientMessageId": "synthetic-shared-1" } }] }));
desktop.prepare("INSERT INTO messages VALUES(1,'subagent',?)").run(JSON.stringify({ agentId: "desktop-worker", title: "Synthetic desktop child", childMessages: [
    { kind: "agent_message", content: [{ content: { type: "text", text: "Synthetic desktop child body" } }] },
] }));
desktop.close();

function identityCache() {
    const cache = new DevinIdentityCache();
    caches.push(cache);
    return cache;
}

after(() => {
    for (const cache of caches) cache.close();
    writer.close();
    for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
    Object.assign(process.env, savedEnvironment);
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
});

test("CLI probe reads the physical recent body before unrelated identity history", async () => {
    const reads: Array<{ id: string; options: any; metrics: any }> = [];
    const adapters = createContextLocateAdapters(async (id, options) => {
        const loaded = await readDevinConversation(id, { ...options, identityCache: identityCache() });
        reads.push({ id, options, metrics: loaded?.raw.readMetrics });
        return loaded;
    });
    const result = await locateConversationContext([{ id: sessionId, sessionId, dataChain: "windsurf", sourceKind: "devin-cli",
        title: "Synthetic candidate", workspace: "/synthetic/target", updatedAt: "" }], marker,
        { adapters, probe: true, source: "local", maxBytes: 64 * 1024, maxRounds: 2, deadlineMs: 5000 });
    assert.equal(result.hits[0]?.snippet, marker);
    assert.equal(reads[0]?.options.identityMode, "physical");
    assert.equal(reads[0]?.options.physicalSourceKind, "devin-cli");
    assert.deepEqual(reads[0]?.options.roundRange, { tailRounds: 2 });
    assert.ok(reads[0]?.metrics.bytesRead < 64 * 1024);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.hits[0]?.aliases, [sessionId]);
    assert.equal(result.hits[0]?.uuid, undefined);
    assert.equal(result.hits[0]?.roundIndex, 16);
    assert.equal(result.hits[0]?.filePath, process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH);
    assert.ok(result.warnings.some(warning => warning.includes("ALIAS_VERIFICATION_PENDING")));
    console.log(`PROBE_METRICS ${JSON.stringify(reads.map(read => ({ id: read.id, metrics: read.metrics })))}`);
});

test("a known CLI session behind a Desktop alias uses the physical CLI key", async () => {
    const readIds: string[] = [];
    const adapters = createContextLocateAdapters(async (id, options) => {
        readIds.push(id);
        return readDevinConversation(id, { ...options, identityCache: identityCache() });
    });
    const result = await locateConversationContext([{ id: uuid, sessionId, uuid, aliases: [sessionId, uuid], dataChain: "windsurf", sourceKind: "devin-cli",
        title: "Synthetic alias candidate", workspace: "/synthetic/target", updatedAt: "" }], marker,
        { adapters, probe: true, source: "local", maxBytes: 64 * 1024, maxRounds: 2, deadlineMs: 5000 });
    assert.equal(result.hits.length, 1);
    assert.equal(readIds[0], sessionId);
    assert.ok(readIds.every(id => id === sessionId));
    assert.equal(result.hits[0]?.uuid, undefined);
    const verified = await resolveDevinConversation(uuid, { identityCache: identityCache() });
    assert.equal(verified?.canonicalId, sessionId);
    assert.deepEqual(verified?.aliases, [sessionId, uuid]);
});

test("identity budgets include ordinary non-matching rows and their original UTF-8 bytes", async () => {
    const filename = path.join(root, "budget.db");
    const database = new DatabaseSync(filename);
    database.exec("CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,chat_message TEXT,metadata TEXT)");
    const insert = database.prepare("INSERT INTO message_nodes VALUES(?,?,?,?)");
    for (let index = 0; index < 160; index++) insert.run("ordinary-no-match", index,
        JSON.stringify({ role: "assistant", content: "雪".repeat(2048) }), "{}");
    insert.run("late-match", 1, JSON.stringify({ role: "user", metadata: { extensions: { "chisel/client-message-id": "synthetic-needle" } } }), "{}");
    insert.run("malformed", 1, "{broken", "{}");
    database.close();
    for (const [options, code] of [[{ maxNodes: 8 }, "DEVIN_NODE_BUDGET"], [{ maxBytes: 8192 }, "DEVIN_BYTE_BUDGET"]] as const) {
        const budget = new ReadBudget(options);
        await assert.rejects(findCliIdentityCandidates(filename, budget, ["synthetic-needle"], []),
            error => error instanceof DevinReadError && error.code === code);
        console.log(`IDENTITY_BUDGET ${JSON.stringify({ code, nodes: budget.nodes, bytes: budget.bytes })}`);
    }
    const fullBudget = new ReadBudget();
    const full = await findCliIdentityCandidates(filename, fullBudget, ["synthetic-needle"], []);
    assert.deepEqual(full.sessionIds, ["late-match", "malformed"]);
    assert.equal(full.uncertain, true);
    assert.equal(fullBudget.nodes, 163);
    assert.ok(fullBudget.bytes > 160 * 6144);
});

test("metadata prefilters exclude hidden and other primary workspaces before parse budgets", async () => {
    const filename = path.join(root, "metadata.db");
    const database = new DatabaseSync(filename);
    database.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,main_chain_id INTEGER,working_directory TEXT,workspace_dirs TEXT,title TEXT,last_activity_at INTEGER,hidden INTEGER);
        CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,metadata TEXT,created_at INTEGER,PRIMARY KEY(session_id,node_id));`);
    const insert = database.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?)");
    const node = database.prepare("INSERT INTO message_nodes VALUES(?,1,NULL,'{}','{}',1)");
    for (let index = 0; index < 40; index++) {
        insert.run(`hidden-${index}`, 1, "/synthetic/target", JSON.stringify(["x".repeat(8192)]), "Hidden synthetic", 1000 + index, 1);
        node.run(`hidden-${index}`);
        insert.run(`outside-${index}`, 1, "/synthetic/elsewhere", "[]", "Other synthetic workspace", 2000 + index, 0);
        node.run(`outside-${index}`);
    }
    insert.run("metadata-target", 1, "/synthetic/target", "[]", "Target synthetic workspace", 100, 0);
    node.run("metadata-target");
    database.close();
    const previous = process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH;
    const previousDesktop = process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT;
    process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = filename;
    process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(root, "absent-desktop");
    try {
        const result = await discoverDevinConversations({ identityCache: identityCache(), conversationIds: undefined,
            workspaces: ["/synthetic/target"], workspaceMode: "exact", workspaceScope: "primary", verifyAliases: false,
            maxDesktopFiles: 0, maxBytes: 4096, maxNodes: 4, limit: 1 });
        assert.deepEqual(result.conversations.map(summary => summary.id), ["metadata-target"]);
        assert.equal(result.scannedSessions, 1);
        assert.equal(result.partial, false);
        console.log(`METADATA_PREFILTER ${JSON.stringify({ scannedSessions: result.scannedSessions, partial: result.partial })}`);
    } finally {
        process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = previous;
        process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = previousDesktop;
    }
});

test("implicit child discovery reads the subagent index without the complete parent body", async () => {
    const oversized = JSON.stringify({ role: "assistant", content: "parent-history".repeat(200000) });
    writer.prepare("UPDATE message_nodes SET chat_message=? WHERE session_id=? AND node_id=2").run(oversized, sessionId);
    const reads: Array<{ options: any; raw: any }> = [];
    const result = await discoverDevinChildCandidates([{ id: sessionId, sessionId, dataChain: "windsurf", sourceKind: "devin-cli",
        title: "Synthetic indexed parent", workspace: "/synthetic/target", updatedAt: "" }], {
        maxBytes: 8192,
        readRaw: async (id, options) => {
            const raw = await readDevinRawConversation(id, { ...options, identityCache: identityCache() });
            reads.push({ options, raw });
            return raw;
        },
    });
    assert.deepEqual(result.candidates.map(candidate => candidate.id), [`${sessionId}--subagent-indexed-worker`]);
    assert.equal(reads[0]?.options.childDiscoveryOnly, true);
    assert.equal(reads[0]?.options.identityMode, "physical");
    assert.equal(reads[0]?.raw.nodes.length, 0);
    assert.ok(reads[0]?.raw.readMetrics.bytesRead < 8192);
    assert.equal(result.candidates[0]?.sourcePartial, true);
    assert.ok(result.warnings.some(warning => warning.includes("INDEX_ONLY")));
    console.log(`CHILD_INDEX_METRICS ${JSON.stringify(reads[0]?.raw.readMetrics)}`);
});

test("child-only reads preserve verified CLI/Desktop aliases and bound Desktop parent bodies", async () => {
    const verified = await readDevinRawConversation(uuid, { childDiscoveryOnly: true, identityCache: identityCache() });
    assert.equal(verified?.summary.canonicalId, sessionId);
    assert.deepEqual(verified?.summary.aliases, [sessionId, uuid]);
    assert.equal(verified?.nodes.length, 0);
    const physical = await readDevinRawConversation(uuid, { childDiscoveryOnly: true, identityMode: "physical", physicalSourceKind: "devin-desktop",
        identityCache: identityCache(), maxBytes: 8192 });
    assert.equal(physical?.summary.canonicalId, uuid);
    assert.equal(physical?.nodes.length, 0);
    assert.deepEqual(physical?.desktopMessages.map(message => message.payload.agentId), ["desktop-worker"]);
    assert.equal(physical?.summary.identityStatus, "pending");
    assert.ok(physical!.readMetrics!.bytesRead < 8192);
});

test("known implicit parent aliases retain Desktop-only children through a fresh bounded read", async () => {
    const result = await discoverDevinChildCandidates([{ id: sessionId, aliases: [sessionId, uuid], dataChain: "windsurf", sourceKind: "devin-cli",
        title: "Synthetic known parent", workspace: "/synthetic/target", updatedAt: "" }], {
        readRaw: async (id, options) => readDevinRawConversation(id, { ...options, identityCache: identityCache() }),
    });
    const child = result.candidates.find(candidate => candidate.id.endsWith("--subagent-desktop-worker"));
    assert.deepEqual(child?.aliases, [`${sessionId}--subagent-desktop-worker`, `${uuid}--subagent-desktop-worker`]);
    assert.equal(child?.sourcePartial, true);
    assert.ok(result.warnings.some(warning => warning.includes("INDEX_ONLY")));
});

test("identity cancellation releases its snapshot and an expired deadline remains a deadline", async () => {
    const filename = path.join(root, "budget.db");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 0);
    try {
        await assert.rejects(findCliIdentityCandidates(filename, new ReadBudget({ signal: controller.signal }), ["synthetic-needle"], []),
            error => error instanceof DevinReadError && error.code === "DEVIN_ABORTED");
    } finally { clearTimeout(timer); }
    const database = new DatabaseSync(filename);
    database.prepare("INSERT INTO message_nodes VALUES('after-cancel',1,'{}','{}')").run();
    database.close();
    await assert.rejects(async () => findCliIdentityCandidates(filename, new ReadBudget({ deadlineMs: Date.now() - 1 }), [], []),
        error => error instanceof DevinReadError && error.code === "DEVIN_DEADLINE");
});

test("identity pagination retains full int64 cursors, quoted IDs, malformed uncertainty and exact source-byte accounting", async () => {
    const filename = path.join(root, "identity-equivalence.db");
    const database = new DatabaseSync(filename);
    database.exec("CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,chat_message TEXT,metadata TEXT)");
    const messageId = "synthetic-'quoted'-\"\\雪\nline";
    const toolId = "synthetic-tool-'quoted'-\"\\月\nline";
    const rows: Array<[bigint | number, string | null, string, string | null]> = [
        [-9223372036854775808n, "edge-first", JSON.stringify({ role: "user", metadata: { extensions: { "chisel/client-message-id": messageId } } }), "{}"],
        [1, "body-only", JSON.stringify({ role: "assistant", content: `${messageId} ${toolId}` }), "{}"],
        [63, "mixed-tools", JSON.stringify({ tool_calls: [null, 7, toolId, [], {}, { id: toolId }] }), "null"],
        [64, "tool-result", JSON.stringify({ tool_call_id: toolId }), null],
        [65, "invalid-metadata", "{}", "[]"],
        [128, "object-tools", JSON.stringify({ tool_calls: { candidate: { id: toolId } } }), "{}"],
        [129, "numeric-tool", JSON.stringify({ tool_call_id: 7 }), "{}"],
        [130, "optional-null", "{}", "null"],
        [131, null, "{broken", "{}"],
        [9223372036854775807n, "edge-last", "7", "{}"],
    ];
    const insert = database.prepare("INSERT INTO message_nodes(rowid,session_id,node_id,chat_message,metadata) VALUES(?,?,1,?,?)");
    for (const [rowId, id, message, metadata] of rows) insert.run(rowId, id, message, metadata);
    const schemaBytes = Buffer.byteLength(JSON.stringify(database.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all()));
    database.close();
    const maxBytes = schemaBytes + rows.reduce((total, row) => total + Buffer.byteLength(row[2]) + Buffer.byteLength(row[3] || ""), 0);
    const budget = new ReadBudget({ maxNodes: rows.length + 1, maxBytes });
    const result = await findCliIdentityCandidates(filename, budget, [messageId], [toolId], ["already-validated-not-present"]);
    assert.deepEqual(result.sessionIds, ["edge-first", "mixed-tools", "tool-result", "invalid-metadata", "object-tools", "null", "edge-last"]);
    assert.equal(result.uncertain, true);
    assert.equal(budget.nodes, rows.length + 1);
    assert.equal(budget.bytes, maxBytes);
    await assert.rejects(findCliIdentityCandidates(filename, new ReadBudget({ maxBytes: maxBytes - 1 }), [messageId], [toolId]),
        error => error instanceof DevinReadError && error.code === "DEVIN_BYTE_BUDGET");
});

test("probe expiry never becomes callback cancellation", async () => {
    const adapters = createContextLocateAdapters(async (_id, options) => {
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(options?.isCancelled?.(), false);
        throw new DevinReadError("DEVIN_DEADLINE", "Synthetic deadline");
    });
    const result = await adapters.scanStream!({ id: sessionId, dataChain: "windsurf", sourceKind: "devin-cli",
        title: "Synthetic deadline source", workspace: "", updatedAt: "" }, marker,
        { maxBytes: 8192, maxHits: 1, maxRounds: 1, deadlineAt: Date.now() + 20, isCancelled: () => false, source: "local", probe: true, mode: "exact" });
    assert.equal(result?.partial, true);
    assert.equal(result?.cancelled, false);
    assert.ok(result?.warnings?.some(warning => warning.endsWith(":DEVIN_DEADLINE")));
});

test("metadata limits preserve normalized ordering for mixed activity representations", async () => {
    const filename = path.join(root, "mixed-activity.db");
    const database = new DatabaseSync(filename);
    database.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,main_chain_id INTEGER,last_activity_at,hidden INTEGER);
        CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,metadata TEXT,created_at INTEGER,PRIMARY KEY(session_id,node_id));`);
    const insert = database.prepare("INSERT INTO sessions VALUES(?,1,?,0)");
    const node = database.prepare("INSERT INTO message_nodes VALUES(?,1,NULL,'{}','{}',1)");
    for (const [id, activity] of [["old-iso", "2000-01-01T00:00:00.000Z"], ["middle-millis", 1700000000000], ["new-seconds", 1900000000]] as const) {
        insert.run(id, activity);
        node.run(id);
    }
    database.close();
    const previousCli = process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH;
    const previousDesktop = process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT;
    process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = filename;
    process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(root, "absent-desktop");
    try {
        const result = await discoverDevinConversations({ identityCache: identityCache(), verifyAliases: false, limit: 1 });
        assert.deepEqual(result.conversations.map(summary => summary.id), ["new-seconds"]);
        assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "DEVIN_CANDIDATE_LIMIT"));
    } finally {
        process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = previousCli;
        process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = previousDesktop;
    }
});
