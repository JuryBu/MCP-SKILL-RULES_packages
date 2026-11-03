import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mock, test } from "node:test";
import { readCliConversations } from "../src/devin-sqlite-cli.js";
import { DevinReadError, ReadBudget } from "../src/devin-sqlite-store.js";

test("Devin recursive reads retain indexed traversal and chain semantics", { timeout: 30_000 }, async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "devin-recursive-plan-"));
    const filename = path.join(directory, "sessions.db");
    const database = new DatabaseSync(filename);
    const queries: string[] = [];
    const originals = new Map<boolean, string>();
    const prepare = DatabaseSync.prototype.prepare;
    let capture: ReturnType<typeof mock.method> | undefined;
    const maxBytes = 4 * 1024 * 1024;
    const chainLength = 1500;
    try {
        database.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,main_chain_id INTEGER,title TEXT);
            CREATE TABLE message_nodes(row_id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,
                node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER,metadata TEXT,
                UNIQUE(session_id,node_id));
            CREATE INDEX idx_message_nodes_session ON message_nodes(session_id);
            BEGIN`);
        const insertSession = database.prepare("INSERT INTO sessions VALUES(?,?,?)");
        const insertNode = database.prepare("INSERT INTO message_nodes(session_id,node_id,parent_node_id,chat_message,created_at,metadata) VALUES(?,?,?,?,?,?)");
        const session = (id: string, head: number | null) => insertSession.run(id, head, id);
        const node = (sessionId: string, id: number, parent: number | string | null,
            message: Record<string, unknown> = { role: "assistant", content: `Message ${id}` }, metadata: unknown = {}) => {
            insertNode.run(sessionId, id, parent, JSON.stringify(message), 1_700_000_000 + id,
                metadata === null ? null : JSON.stringify(metadata));
        };
        session("linear", chainLength);
        session("other-session", chainLength);
        for (let index = 1; index <= chainLength; index++) {
            node("linear", index, index === 1 ? null : index - 1);
            insertNode.run("other-session", index, null, "{invalid", 0, "{invalid");
        }
        for (let index = chainLength + 1; index <= chainLength + 32; index++) node("linear", index, null);

        session("summary", 10);
        node("summary", 0, null, { role: "user", content: "Original question",
            metadata: { created_at: "2026-11-03T00:00:00Z", extensions: { "chisel/client-message-id": "client-zero" } } }, null);
        node("summary", 1, 0, { role: "assistant", tool_calls: [{ id: "tool-zero", function: { name: "original" } }] }, { summarized_from: null });
        node("summary", 2, 1, { role: "tool", tool_call_id: "tool-zero", content: "Original result" }, { summarized_from: 0 });
        node("summary", 3, 0, { role: "assistant", content: "Retained parent" }, null);
        node("summary", 4, 3, { role: "system", content: "First summary" }, { summarized_from: 2 });
        node("summary", 5, null, { role: "system", content: "Second summary" }, { summarized_from: 4 });
        node("summary", 6, 4, { role: "user", content: "New question",
            metadata: { extensions: { "chisel/client-message-id": "client-new" } } });
        node("summary", 7, 6, { role: "assistant", tool_calls: [{ id: "tool-new" }] });
        node("summary", 8, 7, { role: "tool", tool_call_id: "tool-new", content: "New result" });
        node("summary", 9, 8);
        node("summary", 10, 9, { role: "system", content: "Final summary" }, { summarized_from: 5 });
        database.prepare("UPDATE message_nodes SET metadata='null' WHERE session_id='summary' AND node_id=3").run();
        node("summary", 999, null, { role: "user", metadata: { extensions: { "chisel/client-message-id": "detached" } } });

        const warnings = new Map<string, string>();
        for (const [id, head, parent, metadata, warning] of [
            ["null-head", null, null, {}, "DEVIN_MAIN_CHAIN_MISSING"],
            ["missing-head", 99, null, {}, "DEVIN_CHAIN_NODE_MISSING"],
            ["missing-parent", 1, 99, {}, "DEVIN_CHAIN_NODE_MISSING"],
            ["missing-summary", 1, null, { summarized_from: 99 }, "DEVIN_CHAIN_NODE_MISSING"],
            ["parent-cycle", 1, 1, {}, "DEVIN_CHAIN_CYCLE"],
            ["summary-cycle", 1, null, { summarized_from: 1 }, "DEVIN_CHAIN_CYCLE"],
            ["string-summary", 1, null, { summarized_from: "1" }, "DEVIN_SUMMARY_REFERENCE_INVALID"],
            ["fraction-summary", 1, null, { summarized_from: 1.5 }, "DEVIN_SUMMARY_REFERENCE_INVALID"],
            ["negative-summary", 1, null, { summarized_from: -1 }, "DEVIN_SUMMARY_REFERENCE_INVALID"],
            ["unsafe-summary", 1, null, { summarized_from: Number.MAX_SAFE_INTEGER + 1 }, "DEVIN_SUMMARY_REFERENCE_INVALID"],
            ["invalid-parent", 1, "invalid", {}, "DEVIN_CHAIN_NODE_INVALID"],
        ] as const) {
            session(id, head);
            node(id, 1, parent, undefined, metadata);
            warnings.set(id, warning);
        }
        session("mixed-cycle", 2);
        node("mixed-cycle", 1, null, undefined, { summarized_from: 2 });
        node("mixed-cycle", 2, 1);
        warnings.set("mixed-cycle", "DEVIN_CHAIN_CYCLE");
        session("invalid-metadata", 1);
        insertNode.run("invalid-metadata", 1, null, "{}", 0, "{invalid");
        warnings.set("invalid-metadata", "DEVIN_INVALID_JSON");
        session("invalid-message", 1);
        insertNode.run("invalid-message", 1, null, "{invalid", 0, "{}");
        warnings.set("invalid-message", "DEVIN_INVALID_JSON");
        session("empty", null);
        warnings.set("empty", "DEVIN_EMPTY_CONVERSATION");
        database.exec("COMMIT");

        capture = mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
            if (sql.startsWith("WITH RECURSIVE reachable(node_id)")) queries.push(sql);
            return prepare.call(this, sql);
        });
        const read = async (sessionId: string, identityOnly: boolean, maxNodes = 4096) => {
            const results = await readCliConversations(filename, new ReadBudget({ maxNodes, maxBytes }), { sessionId, identityOnly });
            assert.equal(results.length, 1);
            return results[0];
        };
        const parameters = (sessionId: string, head: number, limit: number) =>
            [head, sessionId, sessionId, limit, sessionId, maxBytes, maxBytes];

        for (const identityOnly of [false, true]) {
            const mode = identityOnly ? "identity" : "full";
            await context.test(`${mode}: both recursive branches use composite point lookups`, async () => {
                queries.length = 0;
                const conversation = await read("linear", identityOnly);
                assert.deepEqual(conversation.nodes.map(item => item.nodeId), Array.from({ length: chainLength }, (_, index) => index + 1));
                assert.deepEqual(conversation.summary.warnings, []);
                assert.equal(conversation.summary.partial, false);
                assert.equal(queries.length, 1);
                originals.set(identityOnly, queries[0]);
                const plan = database.prepare(`EXPLAIN QUERY PLAN ${queries[0]}`).all(...parameters("linear", chainLength, 4097));
                const recursiveLookups = plan.map(row => String(row.detail)).filter(detail => /\b(?:SEARCH|SCAN) nodes\b/u.test(detail));
                console.log(`QUERY_PLAN ${mode} ${JSON.stringify(recursiveLookups)}`);
                assert.equal(recursiveLookups.length, 2);
                for (const lookup of recursiveLookups) assert.match(lookup, /SEARCH nodes USING INDEX \S+ \(session_id=\? AND node_id=\?\)/u);
            });

            await context.test(`${mode}: summaries, shared ancestors, zero and null retain exact results`, async () => {
                const conversation = await read("summary", identityOnly);
                assert.deepEqual(conversation.nodes.map(item => item.nodeId), [0, 3, 1, 2, 4, 6, 7, 8, 9, 5, 10]);
                assert.deepEqual([...conversation.messageIds].sort(), ["client-new", "client-zero"]);
                assert.deepEqual([...conversation.toolCallIds].sort(), ["tool-new", "tool-zero"]);
                assert.deepEqual(conversation.compactions.map(item => [item.nodeId, item.summarizedFrom, item.restored]),
                    [[2, 0, true], [4, 2, true], [5, 4, true], [10, 5, true]]);
                assert.equal(conversation.nodes[0].createdAt, "2026-11-03T00:00:00Z");
                assert.deepEqual(conversation.nodes[0].metadata, {});
                assert.deepEqual(conversation.nodes[1].metadata, {});
                assert.deepEqual(conversation.summary.warnings, []);
                if (identityOnly) assert.ok(conversation.nodes.every(item => !("content" in item.message)));
                else assert.deepEqual(conversation.compactions.map(item => item.summary),
                    ["Original result", "First summary", "Second summary", "Final summary"]);
            });

            await context.test(`${mode}: recursive UNION limits preserve legacy fixture rows`, () => {
                const sql = originals.get(identityOnly)!;
                const legacy = sql.replaceAll("FROM reachable CROSS JOIN message_nodes AS nodes ON nodes.node_id=reachable.node_id",
                    "FROM message_nodes AS nodes JOIN reachable ON nodes.node_id=reachable.node_id");
                const ordered = (rows: ReturnType<ReturnType<DatabaseSync["prepare"]>["all"]>) =>
                    rows.sort((left, right) => Number(left.node_id) - Number(right.node_id));
                for (const sessionId of ["summary", "parent-cycle", "summary-cycle", "mixed-cycle", "missing-summary", "null-head"]) {
                    const head = Number(database.prepare("SELECT main_chain_id FROM sessions WHERE id=?").get(sessionId)!.main_chain_id ?? 1);
                    for (const limit of [0, 1, 2, 3, 5, 32]) {
                        const values = parameters(sessionId, head, limit);
                        const currentRows = database.prepare(sql).all(...values);
                        assert.deepEqual(ordered(currentRows), ordered(database.prepare(legacy).all(...values)), `${sessionId}, limit=${limit}`);
                        assert.ok(currentRows.length <= limit);
                    }
                }
            });

            await context.test(`${mode}: invalid, missing and cyclic references remain partial`, async () => {
                for (const [sessionId, warning] of warnings) {
                    const conversation = await read(sessionId, identityOnly);
                    assert.deepEqual(conversation.nodes, [], sessionId);
                    assert.deepEqual(conversation.summary.warnings, [warning], sessionId);
                    assert.equal(conversation.summary.partial, true, sessionId);
                    assert.ok(conversation.compactions.every(item => !item.restored), sessionId);
                }
            });

            await context.test(`${mode}: the exact node budget rejects incomplete traversal`, async () => {
                const complete = await read("summary", identityOnly, 13);
                assert.equal(complete.nodes.length, 11);
                await assert.rejects(read("summary", identityOnly, 12),
                    error => error instanceof DevinReadError && error.code === "DEVIN_NODE_BUDGET");
            });
        }
    } finally {
        capture?.mock.restore();
        database.close();
        assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
