import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { findCliIdentityCandidates } from "../src/devin-sqlite-cli.js";
import { ReadBudget } from "../src/devin-sqlite-store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devin-wsf-identity-normalization-"));
const filename = path.join(root, "source.db");
const writer = new DatabaseSync(filename);
writer.exec("CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,chat_message TEXT,metadata TEXT)");
const insert = writer.prepare("INSERT INTO message_nodes VALUES(?,?,?,?)");
const messageId = "message-quoted-\"\\月";
const toolId = "tool-quoted-\"\\雪";
const rows: Array<[string, unknown, string]> = [
    ["user-match", { role: "user", metadata: { extensions: { "chisel/client-message-id": messageId } } }, "{}"],
    ["tool-match", { role: "tool", tool_call_id: toolId }, "{}"],
    ["assistant-match", { role: "assistant", tool_calls: [{ id: toolId }] }, "{}"],
    ["roleless-not-identity", { tool_call_id: toolId, tool_calls: [{ id: toolId }] }, "{}"],
    ["content-not-identity", { role: "assistant", content: `${messageId} ${toolId}` }, "{}"],
    ["invalid-metadata", { role: "assistant", content: "none" }, "[broken"],
    ["scalar-uncertain", 7, "{}"],
];
for (const [index, row] of rows.entries()) insert.run(row[0], index + 1, JSON.stringify(row[1]), row[2]);
insert.run("malformed-uncertain", 20, "{broken", "{}");
for (let index = 0; index < 130; index++) insert.run(`noise-${index}`, index + 100, JSON.stringify({ role: "assistant", content: "noise".repeat(1024) }), "{}");
const originalPrepare = DatabaseSync.prototype.prepare;
try {
    const optimizedBudget = new ReadBudget();
    const optimized = await findCliIdentityCandidates(filename, optimizedBudget, [messageId], [toolId]);
    DatabaseSync.prototype.prepare = function (sql: string) {
        if (sql === "SELECT jsonb('{}') AS value") throw new Error("fixture: jsonb unavailable");
        return originalPrepare.call(this, sql);
    };
    const fallbackBudget = new ReadBudget();
    const fallback = await findCliIdentityCandidates(filename, fallbackBudget, [messageId], [toolId]);
    assert.deepEqual(optimized, fallback);
    assert.deepEqual(optimized.sessionIds, ["user-match", "tool-match", "assistant-match", "invalid-metadata", "scalar-uncertain", "malformed-uncertain"]);
    assert.equal(optimized.uncertain, true);
    assert.equal(optimizedBudget.nodes, fallbackBudget.nodes);
    assert.equal(optimizedBudget.bytes, fallbackBudget.bytes);
    console.log("PASS JSONB/text capability fallback equivalence, escaped IDs, role isolation, malformed/uncertain sources, pagination and accounting");
} finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    writer.close();
    fs.rmSync(root, { recursive: true, force: true });
}
