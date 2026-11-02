import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findCliIdentityCandidates } from "../src/devin-sqlite-cli.js";
import { ReadBudget, DevinReadError, inSnapshot } from "../src/devin-sqlite-store.js";

async function findLegacyIdentityCandidates(filename: string, budget: ReadBudget, messageIds: string[], toolCallIds: string[]): Promise<{ sessionIds: string[]; uncertain: boolean }> {
    return inSnapshot(filename, budget, async database => {
        const userMatch = messageIds.length ? `json_extract(message_blob,'$.metadata.extensions."chisel/client-message-id"') IN (SELECT value FROM json_each(?))` : "0";
        const toolMatch = toolCallIds.length ? `json_extract(message_blob,'$.tool_call_id') IN (SELECT value FROM json_each(?))
                    OR EXISTS (SELECT 1 FROM json_each(message_blob,'$.tool_calls') AS call WHERE call.type='object'
                        AND json_extract(call.value,'$.id') IN (SELECT value FROM json_each(?)))` : "0";
        const rows = database.prepare(`WITH projected AS (
            SELECT session_id, metadata, CASE WHEN json_valid(chat_message) THEN jsonb(chat_message) END AS message_blob FROM message_nodes),
            matches AS MATERIALIZED (SELECT session_id, CASE WHEN message_blob IS NULL OR json_type(message_blob)!='object'
                OR (metadata IS NOT NULL AND metadata!='' AND (NOT json_valid(metadata) OR json_type(metadata) NOT IN ('object','null')))
                THEN 1 ELSE 0 END AS uncertain,
                CASE WHEN message_blob IS NOT NULL AND json_type(message_blob)='object' THEN
                    ${userMatch} OR ${toolMatch} ELSE 0 END AS matched FROM projected)
            SELECT DISTINCT session_id, uncertain FROM matches WHERE uncertain=1 OR matched=1`);
        const sessionIds = new Set<string>();
        let uncertain = false;
        const parameters = [...(messageIds.length ? [JSON.stringify(messageIds)] : []), ...(toolCallIds.length ? [JSON.stringify(toolCallIds), JSON.stringify(toolCallIds)] : [])];
        for (const row of rows.iterate(...parameters)) {
            await budget.take(Buffer.byteLength(JSON.stringify(row)));
            uncertain ||= Number(row.uncertain) === 1;
            sessionIds.add(String(row.session_id));
        }
        return { sessionIds: [...sessionIds], uncertain };
    });
}

async function assertCandidateEquivalence(filename: string, messageIds: string[], toolCallIds: string[],
    expectedRows: Array<{ session_id: string; uncertain: number }>, checkLimits = false): Promise<void> {
    const schemaDatabase = new DatabaseSync(filename, { readOnly: true });
    let schemaBytes: number;
    try {
        const schemaRows = schemaDatabase.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
        schemaBytes = Buffer.byteLength(JSON.stringify(schemaRows));
    } finally {
        schemaDatabase.close();
    }
    const expectedNodes = expectedRows.length + 1;
    const expectedBytes = schemaBytes + expectedRows.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row)), 0);
    const expected = {
        sessionIds: [...new Set(expectedRows.map(row => row.session_id))].sort(),
        uncertain: expectedRows.some(row => row.uncertain === 1),
    };
    for (const findCandidates of [findLegacyIdentityCandidates, findCliIdentityCandidates]) {
        const budget = new ReadBudget({ maxNodes: expectedNodes, maxBytes: expectedBytes });
        const actual = await findCandidates(filename, budget, messageIds, toolCallIds);
        assert.deepEqual({ ...actual, sessionIds: actual.sessionIds.sort() }, expected, findCandidates.name);
        assert.equal(budget.nodes, expectedNodes, `${findCandidates.name}: schema plus distinct session/uncertain node budget`);
        assert.equal(budget.bytes, expectedBytes, `${findCandidates.name}: UTF-8 distinct row byte budget`);
        if (!checkLimits) continue;
        for (const limit of [
            { options: { maxNodes: expectedNodes - 1 }, code: "DEVIN_NODE_BUDGET" },
            { options: { maxBytes: expectedBytes - 1 }, code: "DEVIN_BYTE_BUDGET" },
        ]) {
            await assert.rejects(findCandidates(filename, new ReadBudget(limit.options), messageIds, toolCallIds),
                error => error instanceof DevinReadError && error.code === limit.code,
                `${findCandidates.name}: ${limit.code}`);
        }
    }
}

async function testIdentityCandidateEquivalence(directory: string): Promise<void> {
    const pagedFilename = path.join(directory, "equivalence-pages.db");
    const pagedDatabase = new DatabaseSync(pagedFilename);
    try {
        pagedDatabase.exec("CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,chat_message TEXT,metadata TEXT); BEGIN");
        const insertPage = pagedDatabase.prepare("INSERT INTO message_nodes(rowid,session_id,node_id,chat_message,metadata) VALUES(?,?,?,?,?)");
        const cases = new Map<number, [string, string, string]>([
            [1, ["match-then-uncertain", user("page-message"), "{}"]],
            [64, ["uncertain-then-match", "{broken", "{}"]],
            [65, ["duplicate-match", JSON.stringify({ tool_calls: [{ id: "page-tool" }] }), "{}"]],
            [128, ["duplicate-uncertain", user("elsewhere"), "[broken"]],
            [129, ["match-then-uncertain", user("elsewhere"), "[]"]],
            [192, ["uncertain-then-match", user("page-message"), "{}"]],
            [193, ["duplicate-match", JSON.stringify({ tool_call_id: "page-tool" }), "null"]],
            [256, ["duplicate-uncertain", "7", "{}"]],
        ]);
        for (let rowId = 1; rowId <= 256; rowId++) {
            const [sessionId, message, metadata] = cases.get(rowId) ?? ["noise", JSON.stringify({ role: "assistant", content: "page-message page-tool" }), "{}"];
            insertPage.run(rowId, sessionId, rowId, message, metadata);
        }
        pagedDatabase.exec("COMMIT");
        const expectedRows = [
            { session_id: "match-then-uncertain", uncertain: 0 },
            { session_id: "uncertain-then-match", uncertain: 1 },
            { session_id: "duplicate-match", uncertain: 0 },
            { session_id: "duplicate-uncertain", uncertain: 1 },
            { session_id: "match-then-uncertain", uncertain: 1 },
            { session_id: "uncertain-then-match", uncertain: 0 },
        ];
        await assertCandidateEquivalence(pagedFilename, ["page-message"], ["page-tool"], expectedRows, true);
        await assertCandidateEquivalence(pagedFilename, ["page-message", "page-message"], ["page-tool", "page-tool"], expectedRows);
        await assertCandidateEquivalence(pagedFilename, [], [], expectedRows.filter(row => row.uncertain === 1), true);
        assert.equal(pagedDatabase.prepare("SELECT count(*) AS count FROM message_nodes").get()!.count, 256);
    } finally {
        pagedDatabase.close();
    }

    const quotedFilename = path.join(directory, "equivalence-quoted.db");
    const quotedDatabase = new DatabaseSync(quotedFilename);
    try {
        quotedDatabase.exec("CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,chat_message TEXT,metadata TEXT); BEGIN");
        const insertQuoted = quotedDatabase.prepare("INSERT INTO message_nodes VALUES(?,?,?,?)");
        const messageId = "message-'quoted'-\"\\月🐾\nline";
        const toolId = "tool-'quoted'-\"\\雪🐈\nline";
        const toolSessionId = "tool-雪-\"\\🐾";
        const fixtures: Array<[string, string, string | null]> = [
            ["message-quoted", user(messageId), "{}"],
            [toolSessionId, JSON.stringify({ role: "tool", tool_call_id: toolId }), null],
            ["tool-mixed", JSON.stringify({ role: "assistant", tool_calls: [null, 7, false, toolId, [], {}, { id: "other" }, { id: toolId }, { id: toolId }] }), ""],
            ["tool-mixed-miss", JSON.stringify({ role: "assistant", tool_calls: [null, 7, true, toolId, [{ id: toolId }], { other: toolId }, { id: "other" }] }), "null"],
            ["tool-id-types-miss", JSON.stringify({ tool_calls: [{ id: null }, { id: 7 }, { id: false }, { id: [toolId] }, { id: { value: toolId } }] }), "{}"],
            ["tool-scalar-miss", JSON.stringify({ tool_calls: "plain non-JSON scalar" }), "{}"],
            ["content-only-miss", JSON.stringify({ role: "user", content: `${messageId} ${toolId}`, metadata: { extensions: { "chisel/client-message-id": "elsewhere" } } }), "{}"],
            ["nested-tool-miss", JSON.stringify({ nested: { tool_call_id: toolId, tool_calls: [{ id: toolId }] } }), "{}"],
        ];
        for (const [index, [sessionId, message, metadata]] of fixtures.entries()) {
            insertQuoted.run(sessionId, index + 1, message, metadata);
        }
        quotedDatabase.exec("COMMIT");
        const messageRows = [{ session_id: "message-quoted", uncertain: 0 }];
        const toolRows = [{ session_id: toolSessionId, uncertain: 0 }, { session_id: "tool-mixed", uncertain: 0 }];
        await assertCandidateEquivalence(quotedFilename, [messageId], [toolId], [...messageRows, ...toolRows], true);
        await assertCandidateEquivalence(quotedFilename, [messageId], [], messageRows);
        await assertCandidateEquivalence(quotedFilename, [], [toolId], toolRows);
        await assertCandidateEquivalence(quotedFilename, [messageId, messageId], [toolId, toolId], [...messageRows, ...toolRows]);
        await assertCandidateEquivalence(quotedFilename, [], [], []);
    } finally {
        quotedDatabase.close();
    }
    console.log("Devin identity equivalence: legacy/current SQLite candidates, cross-page match/uncertain states, quoted Unicode IDs, mixed tool arrays, and exact distinct budgets");
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "devin-identity-scan-"));
const filename = path.join(directory, "sessions.db");
const database = new DatabaseSync(filename);
database.exec("CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,chat_message TEXT,metadata TEXT);");
const insert = database.prepare("INSERT INTO message_nodes(rowid,session_id,node_id,chat_message,metadata) VALUES(?,?,?,?,?)");
const user = (id: string) => JSON.stringify({ role: "user", content: "verified", metadata: { extensions: { "chisel/client-message-id": id } } });
try {
    for (let index = 1; index <= 180; index++) insert.run(index, "noise", index, JSON.stringify({ role: "assistant", content: "x".repeat(8192) }), "{}");
    insert.run(-9223372036854775808n, "first", 1, user("needle"), "{}");
    insert.run(181, "first", 2, user("needle"), "{}");
    insert.run(182, "second", 1, user("needle"), "null");
    insert.run(183, "tool", 1, JSON.stringify({ role: "assistant", tool_calls: [{ id: "tool-needle" }] }), "{}");
    insert.run(184, "tool", 2, JSON.stringify({ role: "tool", tool_call_id: "tool-needle" }), "{}");
    insert.run(185, "invalid-message", 1, "{broken", "{}");
    insert.run(186, "invalid-metadata", 1, user("elsewhere"), "[broken");
    insert.run(187, "array-metadata", 1, user("elsewhere"), "[]");
    insert.run(188, "primitive", 1, "7", "{}");
    insert.run(9223372036854775807n, "last", 1, user("needle"), null);

    const result = await findCliIdentityCandidates(filename, new ReadBudget(), ["needle"], ["tool-needle"]);
    assert.deepEqual(result.sessionIds.sort(), ["first", "second", "tool", "invalid-message", "invalid-metadata", "array-metadata", "primitive", "last"].sort());
    assert.equal(result.uncertain, true);
    const withoutTerms = await findCliIdentityCandidates(filename, new ReadBudget(), [], []);
    assert.deepEqual(withoutTerms.sessionIds.sort(), ["invalid-message", "invalid-metadata", "array-metadata", "primitive"].sort());
    assert.equal(withoutTerms.uncertain, true);

    await testIdentityCandidateEquivalence(directory);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 0);
    try {
        await assert.rejects(findCliIdentityCandidates(filename, new ReadBudget({ signal: controller.signal }), ["needle"], []),
            error => error instanceof DevinReadError && error.code === "DEVIN_ABORTED");
    } finally { clearTimeout(timer); }
    database.prepare("INSERT INTO message_nodes VALUES('after-cancel',1,'{}','{}')").run();
    assert.equal(database.prepare("SELECT count(*) AS count FROM message_nodes WHERE session_id='after-cancel'").get()!.count, 1);

    console.log("Devin identity scan: bounded pages retain complete candidates, malformed-source uncertainty, full int64 cursors, cancellation, and released snapshots");
} finally {
    database.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
}
