import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import {
    fingerprintDevinConversation, isDevinStoreAvailable, listDevinConversations,
    readDevinRawConversation, resolveDevinConversation,
} from "../src/devin-sqlite.js";
import { DevinReadError, ReadBudget, inSnapshot } from "../src/devin-sqlite-store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devin-sqlite-test-"));
const oldEnvironment = {
    cli: process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH,
    desktop: process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT,
    data: process.env.MEMORY_STORE_DATA_ROOT,
};
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
let passed = 0;

function configure(name: string): { cli: string; desktop: string } {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true });
    const cli = path.join(directory, "sessions.db");
    const desktop = path.join(directory, "acp-messages");
    fs.mkdirSync(desktop);
    process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = cli;
    process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = desktop;
    return { cli, desktop };
}

function cliDatabase(filename: string): DatabaseSync {
    const database = new DatabaseSync(filename);
    database.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT, title TEXT, created_at INTEGER,
            last_activity_at INTEGER, main_chain_id INTEGER, workspace_dirs TEXT, hidden INTEGER DEFAULT 0, metadata TEXT);
        CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER,
            parent_node_id INTEGER, chat_message TEXT, created_at INTEGER, metadata TEXT, UNIQUE(session_id,node_id));
        CREATE TABLE tool_call_state (session_id TEXT, tool_call_id TEXT, tool_call_json TEXT, tool_call_update_json TEXT,
            PRIMARY KEY(session_id,tool_call_id));
        CREATE TABLE subagent_heads (session_id TEXT, agent_id TEXT, chain_node_id INTEGER, updated_at INTEGER,
            PRIMARY KEY(session_id,agent_id));`);
    return database;
}

function session(database: DatabaseSync, id: string, head: number | null, hidden = 0): void {
    database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        id, "synthetic-workspace", "Same title", 1_700_000_000, 1_700_000_100, head, '["synthetic-extra"]', hidden, "{}");
}

function node(database: DatabaseSync, sessionId: string, id: number, parent: number | null,
    message: Record<string, any>, metadata: Record<string, any> = {}): void {
    database.prepare("INSERT INTO message_nodes (session_id,node_id,parent_node_id,chat_message,created_at,metadata) VALUES(?,?,?,?,?,?)").run(
        sessionId, id, parent, JSON.stringify(message), 1_800_000_000, JSON.stringify(metadata));
}

const user = (id: string, text = "Synthetic question") => ({
    role: "user", content: text,
    metadata: { created_at: "2026-08-19T07:39:35.135365900Z", extensions: { "chisel/client-message-id": id }, is_user_input: true },
});
const uuid = (suffix: number) => `11111111-2222-3333-4444-${suffix.toString().padStart(12, "0")}`;
const desktopUser = (id: string) => ({
    kind: "user_message", id: `user:${id}`,
    content: [{ content: { type: "text", text: "Synthetic question" }, _meta: { "cognition.ai/clientMessageId": id, "cognition.ai/timestamp": "2026-08-19T07:39:35.135365900Z" } }],
});

function desktopDatabase(directory: string, id: string, messages: Record<string, any>[], extra: Record<string, any> = {}): string {
    const filename = path.join(directory, `${id}.db`);
    const database = new DatabaseSync(filename);
    try {
        database.exec("PRAGMA journal_mode=WAL; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE messages(position INTEGER PRIMARY KEY, kind TEXT, payload TEXT);");
        database.prepare("INSERT INTO meta VALUES ('info',?)").run(JSON.stringify({ title: "Same title", ...extra }));
        database.prepare("INSERT INTO meta VALUES ('message_count',?)").run(String(messages.length));
        database.prepare("INSERT INTO meta VALUES ('truncated','0')").run();
        for (const [position, message] of messages.entries()) database.prepare("INSERT INTO messages VALUES (?,?,?)").run(position, message.kind, JSON.stringify(message));
    } finally { database.close(); }
    return filename;
}

async function test(name: string, execute: () => Promise<void>): Promise<void> {
    await execute();
    passed++;
    console.log(`PASS ${name}`);
}

try {
    await test("missing stores are inert and node:sqlite is lazy", async () => {
        const paths = configure("missing");
        assert.equal(isDevinStoreAvailable(), false);
        assert.deepEqual(await listDevinConversations(), []);
        assert.equal(await readDevinRawConversation("absent"), null);
        const modulePath = new URL("../src/devin-sqlite.ts", import.meta.url).href;
        const probe = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
            import { registerHooks } from 'node:module';
            registerHooks({ resolve(specifier, context, next) {
                if (specifier === 'node:sqlite') throw new Error('blocked sqlite module');
                return next(specifier, context);
            }});
            const reader = await import(${JSON.stringify(modulePath)});
            if ((await reader.listDevinConversations()).length) throw new Error('unexpected data');
        `], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, MEMORY_STORE_DEVIN_CLI_DB_PATH: paths.cli }, encoding: "utf8" });
        assert.equal(probe.status, 0, probe.stderr);
    });

    await test("strong message aliases, duplicate titles, CLI-only, hidden and empty exclusion", async () => {
        const paths = configure("identity");
        const database = cliDatabase(paths.cli);
        try {
            session(database, "alpha-falcon", 2);
            node(database, "alpha-falcon", 1, null, user("message-alpha"));
            node(database, "alpha-falcon", 2, 1, { role: "assistant", content: "Answer" });
            node(database, "alpha-falcon", 99, null, user("abandoned-message", "Abandoned branch"));
            session(database, "beta_falcon_v2", 1);
            node(database, "beta_falcon_v2", 1, null, user("message-beta"));
            session(database, "cli-only", 1);
            node(database, "cli-only", 1, null, user("message-only"));
            session(database, "hidden-falcon", 1, 1);
            node(database, "hidden-falcon", 1, null, user("message-hidden"));
            session(database, "empty-falcon", null);
            desktopDatabase(paths.desktop, uuid(1), [desktopUser("message-alpha")]);
            desktopDatabase(paths.desktop, uuid(2), [desktopUser("message-beta")]);
            desktopDatabase(paths.desktop, uuid(3), [desktopUser("message-alpha")]);
            desktopDatabase(paths.desktop, uuid(4), []);
            desktopDatabase(paths.desktop, uuid(5), [desktopUser("message-hidden")]);
            desktopDatabase(paths.desktop, uuid(6), [desktopUser("unrelated")], { hidden: true });
            desktopDatabase(paths.desktop, uuid(7), [desktopUser("message-alpha")], { hidden: true });
            const list = await listDevinConversations();
            assert.deepEqual(list.map(item => item.canonicalId).sort(), ["alpha-falcon", "beta_falcon_v2", "cli-only"]);
            assert.equal((await resolveDevinConversation(uuid(2)))?.canonicalId, "beta_falcon_v2");
            const viaUuid = await readDevinRawConversation(uuid(1));
            const viaWords = await readDevinRawConversation("alpha-falcon");
            assert.deepEqual(viaUuid?.fingerprint, viaWords?.fingerprint);
            assert.deepEqual(viaUuid?.summary.aliases, ["alpha-falcon", uuid(1), uuid(3)]);
            assert.equal(viaUuid?.summary.matchedMessageIds, 1);
            assert.deepEqual(viaUuid?.nodes.map(item => item.nodeId), [1, 2]);
            assert.equal(viaUuid?.nodes[0].createdAt, "2026-08-19T07:39:35.135365900Z");
            assert.equal((await readDevinRawConversation("cli-only"))?.partial, false);
            assert.equal((await resolveDevinConversation("hidden-falcon"))?.canonicalId, "hidden-falcon");
            assert.ok((await readDevinRawConversation("empty-falcon"))?.warnings.includes("DEVIN_EMPTY_CONVERSATION"));
            assert.ok((await readDevinRawConversation(uuid(4)))?.warnings.includes("DEVIN_EMPTY_CONVERSATION"));
            assert.equal(await resolveDevinConversation("../../sessions"), null);
        } finally { database.close(); }
    });

    await test("fork/shared-message ambiguity never chooses largest match count", async () => {
        const paths = configure("fork");
        const database = cliDatabase(paths.cli);
        try {
            for (const id of ["original", "forked"]) {
                session(database, id, 1);
                node(database, id, 1, null, user("shared-prefix"));
            }
            node(database, "original", 2, 1, user("original-extra"));
            database.prepare("UPDATE sessions SET main_chain_id=2 WHERE id='original'").run();
            desktopDatabase(paths.desktop, uuid(10), [desktopUser("shared-prefix"), desktopUser("original-extra")]);
            const result = await readDevinRawConversation(uuid(10));
            assert.equal(result?.summary.canonicalId, uuid(10));
            assert.equal(result?.summary.sessionId, undefined);
            assert.equal(result?.partial, true);
            assert.ok(result?.warnings.includes("DEVIN_ALIAS_AMBIGUOUS"));
            assert.deepEqual((await resolveDevinConversation("original"))?.aliases, ["original"]);
        } finally { database.close(); }
    });

    await test("broken candidate chains prevent false UUID uniqueness and empty IDs reject", async () => {
        const paths = configure("incomplete-identity");
        const database = cliDatabase(paths.cli);
        try {
            session(database, "unreadable", 999);
            node(database, "unreadable", 1, null, user("shared-identity"));
            session(database, "readable", 1);
            node(database, "readable", 1, null, user("shared-identity"));
            desktopDatabase(paths.desktop, uuid(11), [desktopUser("shared-identity")]);
            const result = await readDevinRawConversation(uuid(11));
            assert.equal(result?.summary.canonicalId, uuid(11));
            assert.ok(result?.warnings.includes("DEVIN_ALIAS_SCAN_INCOMPLETE"));
            await assert.rejects(resolveDevinConversation(" "), (error: any) => error.code === "DEVIN_INVALID_ID");
            await assert.rejects(readDevinRawConversation(""), (error: any) => error.code === "DEVIN_INVALID_ID");
        } finally { database.close(); }
    });

    await test("present source with unavailable SQLite raises an explicit capability error", async () => {
        const paths = configure("no-sqlite");
        const database = cliDatabase(paths.cli);
        database.close();
        const modulePath = new URL("../src/devin-sqlite.ts", import.meta.url).href;
        const probe = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
            import { registerHooks } from 'node:module';
            registerHooks({ resolve(specifier, context, next) {
                if (specifier === 'node:sqlite') throw new Error('unavailable on this runtime');
                return next(specifier, context);
            }});
            const reader = await import(${JSON.stringify(modulePath)});
            try { await reader.listDevinConversations(); process.exit(2); }
            catch(error) { if(error.code !== 'DEVIN_SQLITE_UNAVAILABLE') throw error; }
        `], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: process.env, encoding: "utf8" });
        assert.equal(probe.status, 0, probe.stderr);
    });

    await test("unknown schema and malformed Desktop JSON are errors, not absence", async () => {
        const paths = configure("invalid-schema");
        const database = new DatabaseSync(paths.cli);
        database.exec("CREATE TABLE unsupported(value TEXT)");
        database.close();
        await assert.rejects(resolveDevinConversation("missing"), (error: any) => error.code === "DEVIN_SCHEMA_UNSUPPORTED");
        fs.renameSync(paths.cli, `${paths.cli}.unsupported`);
        const filename = desktopDatabase(paths.desktop, uuid(12), [desktopUser("invalid")]);
        const writer = new DatabaseSync(filename);
        try { writer.prepare("UPDATE messages SET payload='invalid-json'").run(); } finally { writer.close(); }
        await assert.rejects(readDevinRawConversation(uuid(12)), (error: any) => error.code === "DEVIN_INVALID_JSON");
    });

    await test("desktop-only is partial and nested child updates alter fingerprints", async () => {
        const paths = configure("desktop-only");
        const child = { kind: "subagent", agentId: "child-1", status: "running", childMessages: [{ kind: "agent_message", content: [{ content: { text: "Synthetic child" } }] }] };
        const filename = desktopDatabase(paths.desktop, uuid(20), [desktopUser("standalone"), child]);
        assert.equal(isDevinStoreAvailable(), true);
        const before = await readDevinRawConversation(uuid(20));
        assert.equal(before?.partial, true);
        assert.equal(before?.nodes.length, 0);
        assert.equal(before?.desktopMessages[1].payload.childMessages.length, 1);
        const writer = new DatabaseSync(filename);
        try { writer.prepare("UPDATE messages SET payload=? WHERE position=1").run(JSON.stringify({ ...child, status: "completed" })); } finally { writer.close(); }
        assert.notEqual((await fingerprintDevinConversation(uuid(20)))?.revision, before?.fingerprint.revision);
    });

    await test("SQL NULL and JSON null metadata are optional; required messages stay strict", async () => {
        const paths = configure("nullable-metadata");
        const database = cliDatabase(paths.cli);
        try {
            session(database, "nullable", 2);
            node(database, "nullable", 1, null, user("nullable-message"));
            node(database, "nullable", 2, 1, { role: "assistant", content: "Synthetic answer" });
            database.prepare("UPDATE message_nodes SET metadata='null' WHERE node_id=1").run();
            database.prepare("UPDATE message_nodes SET metadata=NULL WHERE node_id=2").run();
            const result = await readDevinRawConversation("nullable");
            assert.equal(result?.partial, false);
            assert.equal(result?.nodes.length, 2);
            assert.deepEqual(result?.nodes.map(item => item.metadata), [{}, {}]);
            database.prepare("UPDATE message_nodes SET chat_message='null' WHERE node_id=2").run();
            assert.ok((await readDevinRawConversation("nullable"))?.warnings.includes("DEVIN_INVALID_JSON"));
        } finally { database.close(); }
    });

    await test("explicit subagent call without trusted transcript is partial without mixing roots", async () => {
        const paths = configure("unresolved-subagent");
        const database = cliDatabase(paths.cli);
        try {
            session(database, "parent", 2);
            node(database, "parent", 1, null, user("parent-message"));
            node(database, "parent", 2, 1, { role: "assistant", content: "Delegating", tool_calls: [{ id: "subagent-call", function: { name: "run_subagent", arguments: '{"task":"Exact synthetic task"}' } }] });
            node(database, "parent", 50, null, { role: "system", content: "You are a subagent of Devin" });
            node(database, "parent", 51, 50, { role: "assistant", content: "Unlinked root answer" });
            const unresolved = await readDevinRawConversation("parent");
            assert.equal(unresolved?.partial, true);
            assert.ok(unresolved?.warnings.includes("DEVIN_SUBAGENT_TRANSCRIPT_UNRESOLVED"));
            assert.deepEqual(unresolved?.nodes.map(item => item.nodeId), [1, 2]);
            desktopDatabase(paths.desktop, uuid(21), [desktopUser("parent-message"), {
                kind: "subagent", agentId: "trusted-child", task: "Exact synthetic task", childMessages: [{ kind: "agent_message", content: [{ content: { text: "Trusted child" } }] }],
            }]);
            const resolved = await readDevinRawConversation("parent");
            assert.equal(resolved?.partial, false);
            assert.deepEqual(resolved?.nodes.map(item => item.nodeId), [1, 2]);
        } finally { database.close(); }
    });

    await test("genuine summarized_from restores prior history; compact hints do not", async () => {
        const paths = configure("compaction");
        const database = cliDatabase(paths.cli);
        try {
            session(database, "summary", 11);
            node(database, "summary", 1, null, user("old-message", "Old original"));
            node(database, "summary", 2, 1, { role: "assistant", content: "Old answer" });
            node(database, "summary", 10, null, { role: "assistant", content: "Verified summary" }, { summarized_from: 2 });
            node(database, "summary", 11, 10, user("new-message", "New question"));
            const restored = await readDevinRawConversation("summary");
            assert.deepEqual(restored?.nodes.map(item => item.nodeId), [1, 2, 10, 11]);
            assert.equal(restored?.compactions.length, 1);
            assert.equal(restored?.compactions[0].restored, true);
            database.prepare("UPDATE message_nodes SET metadata=? WHERE session_id='summary' AND node_id=10").run(JSON.stringify({ summarized_from: null, extensions: { "compact/prior_node_ids": [1, 2] } }));
            const ordinary = await readDevinRawConversation("summary");
            assert.deepEqual(ordinary?.nodes.map(item => item.nodeId), [10, 11]);
            assert.equal(ordinary?.compactions.length, 0);
        } finally { database.close(); }
    });

    await test("CLI child compactions retain restored boundaries separately from the parent", async () => {
        const paths = configure("child-compaction");
        const database = cliDatabase(paths.cli);
        try {
            session(database, "parent", 2);
            node(database, "parent", 1, null, user("child-compaction-parent"));
            node(database, "parent", 2, 1, { role: "assistant", content: "Delegate", tool_calls: [{ id: "child-call", function: { name: "run_subagent", arguments: { task: "Child task" } } }] });
            node(database, "parent", 50, null, { role: "user", content: "Child task" });
            node(database, "parent", 51, 50, { role: "assistant", content: "Original child answer" });
            node(database, "parent", 60, null, { role: "assistant", content: "Child summary" }, { summarized_from: 51 });
            node(database, "parent", 61, 60, { role: "assistant", content: "Final child answer" });
            database.prepare("INSERT INTO subagent_heads VALUES ('parent','compacted-child',61,1)").run();
            const raw = await readDevinRawConversation("parent");
            const child = raw?.desktopMessages.find(message => message.kind === "subagent")?.payload;
            assert.equal(raw?.partial, false);
            assert.deepEqual(raw?.nodes.map(item => item.nodeId), [1, 2]);
            assert.deepEqual(raw?.compactions, []);
            assert.deepEqual(child?.rawNodes.map((item: any) => item.nodeId), [50, 51, 60, 61]);
            assert.equal(child?.compactions.length, 1);
            assert.equal(child?.compactions[0].nodeId, 60);
            assert.equal(child?.compactions[0].summarizedFrom, 51);
            assert.equal(child?.compactions[0].restored, true);
        } finally { database.close(); }
    });

    await test("each subagent call needs a unique transcript; repeated tasks require explicit IDs", async () => {
        const paths = configure("subagent-coverage");
        const database = cliDatabase(paths.cli);
        try {
            session(database, "parent", 2);
            node(database, "parent", 1, null, user("coverage-parent"));
            const calls = [
                { id: "call-a", function: { name: "run_subagent", arguments: { task: "Task A" } } },
                { id: "call-b", function: { name: "run_subagent", arguments: { task: "Task B" } } },
            ];
            node(database, "parent", 2, 1, { role: "assistant", content: "Two tasks", tool_calls: calls });
            const child = (agentId: string, task: string, toolCallId?: string) => ({ kind: "subagent", agentId, task, toolCallId, childMessages: [{ kind: "agent_message", content: [] }] });
            const filename = desktopDatabase(paths.desktop, uuid(22), [desktopUser("coverage-parent"), child("child-a", "Task A")]);
            assert.equal((await readDevinRawConversation("parent"))?.partial, true);
            const writer = new DatabaseSync(filename);
            try {
                writer.prepare("INSERT INTO messages VALUES(2,'subagent',?)").run(JSON.stringify(child("child-b", "Task B")));
                writer.prepare("UPDATE meta SET value='3' WHERE key='message_count'").run();
                assert.equal((await readDevinRawConversation("parent"))?.partial, false);
                calls[1].function.arguments.task = "Task A";
                database.prepare("UPDATE message_nodes SET chat_message=? WHERE node_id=2").run(JSON.stringify({ role: "assistant", tool_calls: calls }));
                writer.prepare("UPDATE messages SET payload=? WHERE position=2").run(JSON.stringify(child("child-b", "Task A")));
                assert.ok((await readDevinRawConversation("parent"))?.warnings.includes("DEVIN_SUBAGENT_TRANSCRIPT_AMBIGUOUS"));
                writer.prepare("UPDATE messages SET payload=? WHERE position=1").run(JSON.stringify(child("child-a", "Task A", "call-a")));
                writer.prepare("UPDATE messages SET payload=? WHERE position=2").run(JSON.stringify(child("child-b", "Task A", "call-b")));
                assert.equal((await readDevinRawConversation("parent"))?.partial, false);
            } finally { writer.close(); }
        } finally { database.close(); }
    });

    await test("cycle, missing head, missing parent and missing summary refuse full-table fallback", async () => {
        const paths = configure("broken");
        const database = cliDatabase(paths.cli);
        try {
            session(database, "cycle", 2);
            node(database, "cycle", 1, 2, user("cycle-1"));
            node(database, "cycle", 2, 1, { role: "assistant", content: "cycle-2" });
            session(database, "no-head", null);
            node(database, "no-head", 100, null, user("not-a-head"));
            session(database, "missing-parent", 2);
            node(database, "missing-parent", 2, 1, user("missing"));
            session(database, "missing-summary", 1);
            node(database, "missing-summary", 1, null, { role: "assistant", content: "Missing old source" }, { summarized_from: 999 });
            for (const id of ["cycle", "no-head", "missing-parent", "missing-summary"]) {
                const result = await readDevinRawConversation(id);
                assert.equal(result?.partial, true, id);
                assert.equal(result?.nodes.length, 0, id);
                assert.ok(result?.warnings.length, id);
            }
            assert.equal((await readDevinRawConversation("missing-summary"))?.compactions[0].restored, false);
        } finally { database.close(); }
    });

    await test("images stay raw only; node/tool-state/subagent-head/source replacement invalidation", async () => {
        const paths = configure("fingerprints");
        let database = cliDatabase(paths.cli);
        try {
            session(database, "state", 2);
            node(database, "state", 1, null, { ...user("state-message"), images: [{ mime_type: "image/png", base64_data: "PRIVATE_SYNTHETIC_IMAGE_ONLY", width: 2, height: 2 }] });
            node(database, "state", 2, 1, { role: "assistant", content: "Call", tool_calls: [{ id: "call-1", function: { name: "exec" } }] });
            database.prepare("INSERT INTO tool_call_state VALUES ('state','call-1',?,?)").run('{"toolCallId":"call-1"}', '{"status":"running"}');
            node(database, "state", 50, null, { role: "system", content: "You are a subagent of Devin" });
            node(database, "state", 51, 50, { role: "assistant", content: "Child answer" });
            database.prepare("INSERT INTO subagent_heads VALUES ('state','agent-1',51,1)").run();
            const first = await readDevinRawConversation("state");
            await new Promise(resolve => setTimeout(resolve, 10));
            assert.deepEqual(await fingerprintDevinConversation("state"), first?.fingerprint);
            assert.equal(first?.nodes[0].message.images[0].base64_data, "PRIVATE_SYNTHETIC_IMAGE_ONLY");
            assert.ok(!JSON.stringify(await listDevinConversations()).includes("PRIVATE_SYNTHETIC_IMAGE_ONLY"));
            assert.ok(!JSON.stringify(first?.fingerprint).includes("PRIVATE_SYNTHETIC_IMAGE_ONLY"));
            assert.equal(first?.desktopMessages.find(item => item.kind === "subagent")?.payload.rawNodes.length, 2);
            assert.deepEqual(first?.nodes.map(item => item.nodeId), [1, 2]);
            database.prepare("UPDATE tool_call_state SET tool_call_update_json=?").run('{"status":"completed"}');
            const second = await fingerprintDevinConversation("state");
            assert.notEqual(second?.revision, first?.fingerprint.revision);
            database.prepare("UPDATE message_nodes SET chat_message=? WHERE node_id=51").run('{"role":"assistant","content":"Child final update"}');
            const third = await fingerprintDevinConversation("state");
            assert.notEqual(third?.revision, second?.revision);
            database.prepare("UPDATE subagent_heads SET updated_at=2").run();
            const fourth = await fingerprintDevinConversation("state");
            assert.notEqual(fourth?.revision, third?.revision);
            database.close();
            fs.renameSync(paths.cli, `${paths.cli}.old`);
            fs.copyFileSync(`${paths.cli}.old`, paths.cli);
            database = new DatabaseSync(paths.cli);
            assert.notEqual((await fingerprintDevinConversation("state"))?.revision, fourth?.revision);
        } finally { database.close(); }
    });

    await test("budgets, deadline, cancellation and read-only transaction cleanup", async () => {
        const paths = configure("limits");
        const database = cliDatabase(paths.cli);
        try {
            session(database, "limits", 200);
            for (let index = 1; index <= 200; index++) node(database, "limits", index, index === 1 ? null : index - 1, user(`limit-${index}`));
            desktopDatabase(paths.desktop, uuid(30), [desktopUser("limit-1")]);
            await assert.rejects(readDevinRawConversation("limits", { maxNodes: 3 }), (error: any) => error.code === "DEVIN_NODE_BUDGET");
            await assert.rejects(readDevinRawConversation("limits", { maxBytes: 1 }), (error: any) => error.code === "DEVIN_BYTE_BUDGET");
            await assert.rejects(listDevinConversations({ maxDesktopFiles: 0 }), (error: any) => error.code === "DEVIN_DESKTOP_BUDGET");
            await assert.rejects(readDevinRawConversation("limits", { deadlineMs: Date.now() - 1 }), (error: any) => error.code === "DEVIN_DEADLINE");
            const controller = new AbortController();
            const reading = readDevinRawConversation("limits", { signal: controller.signal });
            setImmediate(() => controller.abort());
            await assert.rejects(reading, (error: any) => error.code === "DEVIN_ABORTED");
            await assert.rejects(inSnapshot(paths.cli, new ReadBudget(), async reader => { reader.exec("DELETE FROM sessions"); }), DevinReadError);
            assert.equal(database.prepare("SELECT count(*) AS count FROM sessions").get()?.count, 1);
            assert.equal((await readDevinRawConversation("limits"))?.nodes.length, 200);
            assert.equal(database.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
        } finally { database.close(); }
    });

    await test("WAL writer and reader snapshots remain internally consistent", async () => {
        const paths = configure("wal");
        const database = cliDatabase(paths.cli);
        session(database, "wal", 130);
        for (let index = 1; index <= 130; index++) node(database, "wal", index, index === 1 ? null : index - 1,
            index === 130 ? { role: "assistant", content: "0", tool_calls: [{ id: "wal-call" }] } : user(`wal-${index}`));
        database.prepare("INSERT INTO tool_call_state VALUES ('wal','wal-call','{}',?)").run('{"status":"0"}');
        const writer = new Worker(`
            const { parentPort, workerData } = require('node:worker_threads');
            const { DatabaseSync } = require('node:sqlite');
            const database = new DatabaseSync(workerData);
            database.exec('PRAGMA busy_timeout=1000');
            let writes = 0;
            const timer = setInterval(() => {
                writes++;
                database.exec('BEGIN IMMEDIATE');
                database.prepare("UPDATE message_nodes SET chat_message=? WHERE session_id='wal' AND node_id=130").run(JSON.stringify({role:'assistant',content:String(writes),tool_calls:[{id:'wal-call'}]}));
                database.prepare("UPDATE tool_call_state SET tool_call_update_json=? WHERE session_id='wal'").run(JSON.stringify({status:String(writes)}));
                database.exec('COMMIT');
            }, 2);
            parentPort.postMessage('ready');
            parentPort.once('message', () => { clearInterval(timer); database.close(); parentPort.postMessage(writes); parentPort.close(); });
        `, { eval: true, workerData: paths.cli });
        try {
            await once(writer, "message");
            for (let iteration = 0; iteration < 8; iteration++) {
                const result = await readDevinRawConversation("wal");
                const status = result?.desktopMessages.find(message => message.kind === "tool_call")?.payload.content.status;
                assert.equal(result?.nodes.at(-1)?.message.content, status);
                assert.equal(result?.nodes.length, 130);
            }
            const stopped = once(writer, "message");
            writer.postMessage("stop");
            const [writes] = await stopped;
            assert.ok(writes > 0);
            console.log(`WAL concurrent commits=${writes}, consistent snapshots=8`);
        } finally {
            await writer.terminate();
            database.close();
        }
    });
    await test("target reads charge lightweight identity plus selected bodies, not unrelated payloads", async () => {
        const paths = configure("target-budget");
        const database = cliDatabase(paths.cli);
        try {
            session(database, "target", 1);
            node(database, "target", 1, null, user("target-message"));
            session(database, "unrelated", 2);
            node(database, "unrelated", 1, null, user("unrelated-message"));
            node(database, "unrelated", 2, 1, { role: "assistant", content: "Z".repeat(2 * 1024 * 1024) });
            desktopDatabase(paths.desktop, uuid(90), [desktopUser("target-message")]);
            desktopDatabase(paths.desktop, uuid(91), [desktopUser("unrelated-message"), { kind: "agent_message", content: [{ content: { type: "text", text: "Y".repeat(2 * 1024 * 1024) } }] }], { unusedLargeMetadata: "X".repeat(1024 * 1024) });
            const options = { maxBytes: 16 * 1024 };
            assert.equal((await resolveDevinConversation(uuid(90), options))?.canonicalId, "target");
            const result = await readDevinRawConversation(uuid(90), options);
            assert.equal(result?.summary.canonicalId, "target");
            assert.equal(result?.nodes.length, 1);
            assert.equal(result?.partial, false);
            await assert.rejects(readDevinRawConversation("unrelated", options), error => error instanceof DevinReadError && error.code === "DEVIN_BYTE_BUDGET");
        } finally { database.close(); }
    });
    console.log(`Devin SQLite tests: ${passed} groups passed; synthetic databases only.`);
} finally {
    for (const [key, value] of Object.entries({ MEMORY_STORE_DEVIN_CLI_DB_PATH: oldEnvironment.cli, MEMORY_STORE_DEVIN_DESKTOP_ROOT: oldEnvironment.desktop, MEMORY_STORE_DATA_ROOT: oldEnvironment.data })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
}
