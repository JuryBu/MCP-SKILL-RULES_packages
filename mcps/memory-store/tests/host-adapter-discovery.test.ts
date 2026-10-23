import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-adapter-discovery-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
process.env.MEMORY_STORE_WSF_SUBAGENT_JOBS_PATH = path.join(root, "absent-jobs.json");
process.env.MEMORY_STORE_WINDSURF_PB_ACTIVE_ROOT = path.join(root, "absent-wsf-active");
process.env.MEMORY_STORE_WINDSURF_PB_IMPLICIT_ROOT = path.join(root, "absent-wsf-implicit");
const uuid = "11111111-2222-3333-4444-555555555555";
const secondUuid = "11111111-2222-3333-4444-666666666666";
const word = "fixture-falcon";
let sequence = 0;

function configure() {
    const directory = path.join(root, String(++sequence));
    const cli = path.join(directory, "sessions.db");
    const desktop = path.join(directory, "desktop");
    fs.mkdirSync(desktop, { recursive: true });
    process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = cli;
    process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = desktop;
    return { directory, cli, desktop };
}

function createCli(filename: string) {
    const database = new DatabaseSync(filename);
    database.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,working_directory TEXT,title TEXT,created_at INTEGER,last_activity_at INTEGER,main_chain_id INTEGER,workspace_dirs TEXT,hidden INTEGER,metadata TEXT);
        CREATE TABLE message_nodes(row_id INTEGER PRIMARY KEY,session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER,metadata TEXT);
        CREATE UNIQUE INDEX node_identity ON message_nodes(session_id,node_id);`);
    return database;
}

function addSession(database: DatabaseSync, id: string, messages: unknown[], workspace = "C:/fixture/project") {
    database.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)").run(id, workspace, `Title ${id}`, 1700000000, 1700000000 + messages.length, messages.length, "[]", 0, "{}");
    for (const [position, message] of messages.entries()) database.prepare("INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at,metadata) VALUES(?,?,?,?,?,?)")
        .run(id, position + 1, position || null, typeof message === "string" ? message : JSON.stringify(message), 1700000000 + position, "{}");
}

function createDesktop(directory: string, id: string, messages: unknown[], info = "{}") {
    const database = new DatabaseSync(path.join(directory, `${id}.db`));
    database.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE messages(position INTEGER PRIMARY KEY,kind TEXT,payload TEXT);");
    database.prepare("INSERT INTO meta VALUES('info',?)").run(info);
    for (const [position, payload] of messages.entries()) database.prepare("INSERT INTO messages VALUES(?,?,?)")
        .run(position, typeof payload === "object" && payload ? (payload as { kind: string }).kind : "agent_message", typeof payload === "string" ? payload : JSON.stringify(payload));
    database.close();
}

function linkedMessages() {
    return [1, 2, 3].flatMap(round => [
        { role: "user", content: `Question ${round}`, metadata: { is_user_input: true, extensions: { "chisel/client-message-id": `fixture-message-${round}` } } },
        { role: "assistant", content: `Answer ${round}`, ...(round < 3 ? { tool_calls: [{ id: `fixture-tool-${round}`, name: "read_file", arguments: {} }] } : {}) },
    ]);
}

const desktopTools = () => [1, 2].map(number => ({ kind: "tool_call", id: `tool:fixture-tool-${number}`, content: { toolCallId: `fixture-tool-${number}`, status: "completed", content: [] } }));
configure();
const { discoverDevinConversations, resolveDevinConversation } = await import("../src/devin-sqlite.js");
const { readDevinConversation } = await import("../src/devin-conversation.js");
const { discoverAntigravityConversations, listConversationsByMtime } = await import("../src/ls-client.js");
const { listLocalPbConversationCandidates } = await import("../src/conversation-local-list.js");
const { listConversationCandidates } = await import("../src/conversation-filter.js");
const windsurf = await import("../src/windsurf-client.js");
let lsCalls = 0;
windsurf.__setWindsurfEndpointResolverForTest(async () => { lsCalls++; return []; });

try {
    {
        const paths = configure();
        const database = createCli(paths.cli);
        addSession(database, word, [{ role: "user", content: "Question" }, { role: "assistant", content: "x".repeat(3 * 1024 * 1024) }]);
        addSession(database, "broken-body", ["{malformed"]);
        addSession(database, "other-workspace", [{ role: "user", content: "Other" }], "C:/elsewhere");
        database.close();
        const before = fs.readFileSync(paths.cli);
        const discovered = await discoverDevinConversations({ maxBytes: 4096, conversationIds: [word], query: "falcon", workspaces: ["C:/fixture"], workspaceMode: "under", verifyAliases: false });
        assert.deepEqual(discovered.conversations.map(item => item.id), [word]);
        assert.equal(discovered.scannedSessions, 1);
        assert.equal(discovered.scannedDesktopFiles, 0);
        assert.equal(discovered.partial, false);
        const budget = await discoverDevinConversations({ maxNodes: 2, verifyAliases: false });
        assert.deepEqual(budget.conversations.map(item => item.id), [word]);
        assert.ok(budget.diagnostics.some(item => item.code === "DEVIN_NODE_BUDGET"));
        createDesktop(paths.desktop, uuid, ["{malformed payload"]);
        createDesktop(paths.desktop, secondUuid, [{ kind: "agent_message", content: [] }], "{malformed metadata");
        const partial = await discoverDevinConversations({ maxBytes: 8192, verifyAliases: false });
        assert.ok(partial.conversations.some(item => item.id === word));
        assert.ok(partial.conversations.some(item => item.id === uuid));
        assert.ok(partial.diagnostics.some(item => item.code === "DEVIN_INVALID_JSON" && item.conversationId === secondUuid));
        assert.deepEqual(fs.readFileSync(paths.cli), before);
        await assert.rejects(() => discoverDevinConversations({ isCancelled: () => true }), /cancelled/);
        await assert.rejects(() => discoverDevinConversations({ deadlineMs: Date.now() - 1 }), /deadline/);
        console.log("PASS metadata-only discovery: SQL ID scope, workspace/query, oversized and malformed bodies, successful-prefix budget, per-file diagnostics, cancellation and readonly source");
    }
    {
        const paths = configure();
        const database = createCli(paths.cli);
        addSession(database, word, linkedMessages());
        database.close();
        createDesktop(paths.desktop, uuid, desktopTools());
        const identity = await resolveDevinConversation(uuid);
        assert.equal(identity?.canonicalId, word);
        assert.equal(identity?.identityEvidence, "tool-call-id");
        assert.equal(identity?.matchedToolCallIds, 2);
        const byWord = await readDevinConversation(word, { materializeAttachments: false });
        const byUuid = await readDevinConversation(uuid, { materializeAttachments: false });
        assert.equal(byUuid?.rounds.length, 3);
        assert.deepEqual(byUuid?.rounds, byWord?.rounds);
        const discovery = await discoverDevinConversations({ conversationIds: [uuid], maxBytes: 65536 });
        assert.deepEqual(discovery.conversations.map(item => item.id), [word]);
        assert.equal(fs.existsSync(path.join(root, "data", "conversation-cache")), false);
        const ambiguous = new DatabaseSync(paths.cli);
        addSession(ambiguous, "fixture-fork", [{ role: "assistant", tool_calls: [{ id: "fixture-tool-1", name: "read_file", arguments: {} }] }]);
        ambiguous.close();
        const unresolved = await resolveDevinConversation(uuid);
        assert.equal(unresolved?.canonicalId, uuid);
        assert.ok(unresolved?.warnings.includes("DEVIN_ALIAS_AMBIGUOUS"));
        console.log("PASS tool-only Desktop: complete unique ID set, UUID/word same three rounds, readonly/no identity cache, shared tool-ID fork stays ambiguous");
    }
    for (const variant of ["incomplete-chain", "unknown-tool", "one-tool", "conflicting-user", "missing-user-id"] as const) {
        const paths = configure();
        const database = createCli(paths.cli);
        addSession(database, word, linkedMessages());
        if (variant === "incomplete-chain") {
            addSession(database, "fixture-broken", [{ role: "assistant", content: "Unrelated" }]);
            database.prepare("UPDATE sessions SET main_chain_id=99 WHERE id='fixture-broken'").run();
        }
        database.close();
        const messages: unknown[] = desktopTools();
        if (variant === "unknown-tool") messages.push({ kind: "tool_call", content: { toolCallId: "fixture-unknown-tool" } });
        if (variant === "one-tool") messages.pop();
        if (variant === "conflicting-user") messages.push({ kind: "user_message", content: [{ content: { type: "text", text: "Unrelated" }, _meta: { "cognition.ai/clientMessageId": "fixture-unmatched-message" } }] });
        if (variant === "missing-user-id") messages.push({ kind: "user_message", content: [{ content: { type: "text", text: "Unidentified user history" } }] });
        createDesktop(paths.desktop, uuid, messages);
        const identity = await resolveDevinConversation(uuid);
        assert.equal(identity?.canonicalId, uuid, variant);
    }
    console.log("PASS identity refusal: incomplete main-chain inventory, incomplete tool coverage, one tool and mismatching user-message IDs remain separate");
    {
        const paths = configure();
        fs.writeFileSync(paths.cli, "not SQLite");
        const empty = await listConversationCandidates({ source: "local", dataChains: ["windsurf"], conversationIds: [word] });
        assert.equal(empty.candidates.length, 0);
        assert.equal(empty.partial, true);
        assert.ok(empty.statuses[0].diagnostics?.some(item => item.code === "DEVIN_SQLITE_READ"));
        assert.equal(empty.statuses[0].partial, true);
        console.log("PASS source-level partial diagnostics survive zero candidates");
    }
    {
        const paths = configure();
        const active = path.join(paths.directory, "active");
        const implicit = path.join(paths.directory, "implicit");
        fs.mkdirSync(active); fs.mkdirSync(implicit);
        fs.writeFileSync(path.join(active, "small-active.pb"), "tiny");
        fs.writeFileSync(path.join(implicit, "small-implicit.pb"), "tiny");
        process.env.MEMORY_STORE_ANTIGRAVITY_PB_ACTIVE_ROOT = active;
        process.env.MEMORY_STORE_ANTIGRAVITY_PB_IMPLICIT_ROOT = implicit;
        const discovered = discoverAntigravityConversations({ readTitles: () => new Map([["small-active", { summary: "Synthetic title", steps: 1 }]]) });
        assert.deepEqual(discovered.conversations.map(item => item.id).sort(), ["small-active", "small-implicit"]);
        assert.deepEqual(discovered.conversations.find(item => item.id === "small-implicit")?.kinds, ["implicit"]);
        assert.equal(discovered.conversations.find(item => item.id === "small-active")?.title, "Synthetic title");
        const missingTitles = discoverAntigravityConversations({ readTitles: () => { throw new Error("fixture vscdb missing"); } });
        assert.equal(missingTitles.conversations.length, 2);
        assert.equal(missingTitles.partial, true);
        assert.equal(missingTitles.diagnostics[0].code, "AGY_TITLE_METADATA_UNAVAILABLE");
        const limited = discoverAntigravityConversations({ limit: 1, readTitles: () => new Map() });
        assert.ok(limited.diagnostics.some(item => item.code === "PB_CANDIDATE_LIMIT"));
        const expired = discoverAntigravityConversations({ deadlineAt: Date.now() - 1, readTitles: () => new Map() });
        assert.ok(expired.diagnostics.some(item => item.code === "PB_DISCOVERY_DEADLINE"));
        assert.throws(() => listLocalPbConversationCandidates("antigravity", { isCancelled: () => true }), /cancelled/);
        assert.throws(() => discoverAntigravityConversations({ isCancelled: () => true, readTitles: () => new Map() }), /cancelled/);
        assert.ok(listConversationsByMtime.toString().includes("vscdbTitles.has(e.id)"));
        console.log("PASS AGY discovery supplements active/implicit small PB and missing titles; budget/cancel reported, Record validity filter retained");
    }
    assert.equal(lsCalls, 0, "local-only tests must not discover or query a live LS");
    {
        const paths = configure();
        const database = createCli(paths.cli);
        addSession(database, word, linkedMessages());
        database.close();
        const deadlineAt = Date.now() + 4000;
        windsurf.__setWindsurfEndpointResolverForTest(async () => [{ pid: 1, port: 1, csrfToken: "fixture-token" }]);
        windsurf.__setWindsurfTransportFactoryForTest(() => async (method, _payload, options) => {
            assert.equal(method, "GetAllCascadeTrajectories");
            assert.equal(options?.deadlineAt, deadlineAt);
            assert.equal(options?.shouldCancel?.(), false);
            assert.equal(options?.maxResponseBytes, 4096);
            return { trajectorySummaries: { [word]: { summary: "Conflicting identity", stepCount: 1 }, "legacy-safe": { summary: "Safe legacy", stepCount: 1 } } };
        });
        const collision = await windsurf.discoverWindsurfThreads(10, { deadlineAt, maxBytes: 4096, shouldCancel: () => false, verifyAliases: false });
        assert.deepEqual(collision.conversations.map(item => item.id), ["legacy-safe"]);
        assert.ok(collision.diagnostics.some(item => item.code === "WSF_IDENTITY_COLLISION"));
        windsurf.__setWindsurfTransportFactoryForTest(() => async () => { throw new Error("fixture LS failure"); });
        const failedLs = await windsurf.discoverWindsurfThreads(10, { verifyAliases: false });
        assert.deepEqual(failedLs.conversations.map(item => item.id), [word]);
        assert.ok(failedLs.diagnostics.some(item => item.code === "WSF_LS_DISCOVERY_FAILED" && item.message.includes("fixture LS failure")));
        await assert.rejects(() => windsurf.discoverWindsurfThreads(10, { shouldCancel: () => true }), /cancelled/);
        windsurf.__setWindsurfTransportFactoryForTest(null);
        const originalFetch = globalThis.fetch;
        try {
            globalThis.fetch = async () => new Response(JSON.stringify({ text: "x".repeat(4096) }));
            const transport = windsurf.makeWindsurfTransport({ pid: 1, port: 1, csrfToken: "fixture-token" });
            await assert.rejects(() => transport("GetAllCascadeTrajectories", {}, { maxResponseBytes: 64 }), (error: unknown) => (error as { code?: string }).code === "WSF_RESPONSE_BYTE_BUDGET");
            globalThis.fetch = async () => new Response(JSON.stringify({ title: "猫咪" }));
            assert.deepEqual(await transport("GetAllCascadeTrajectories", {}, { maxResponseBytes: 64 }), { title: "猫咪" });
        } finally { globalThis.fetch = originalFetch; }
        console.log("PASS WSF discovery: deadline/cancel propagation, colliding identities withheld, healthy candidates survive endpoint failure; injected transport only");
    }
    console.log("Host adapter discovery tests passed; synthetic databases and PB metadata only.");
} finally {
    windsurf.__setWindsurfEndpointResolverForTest(null);
    windsurf.__setWindsurfTransportFactoryForTest(null);
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
}
