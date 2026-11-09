import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readCliTailWindow } from "../src/devin-sqlite-cli-tail.js";
import { ReadBudget } from "../src/devin-sqlite-store.js";
import { devinRawToRounds } from "../src/devin-conversation.js";

const database = new DatabaseSync(":memory:");
try {
    database.exec("CREATE TABLE message_nodes (session_id TEXT,node_id INTEGER,parent_node_id INTEGER,created_at INTEGER,metadata TEXT,chat_message TEXT)");
    const messages = [
        { role: "user", content: "read this" },
        { role: "assistant", content: "", tool_calls: [{ id: "call-1", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call-1", content: "large result deliberately omitted" },
        { role: "assistant", content: "done" },
    ];
    for (const [index, message] of messages.entries()) database.prepare("INSERT INTO message_nodes VALUES (?,?,?,?,?,?)")
        .run("fixture", index + 1, index === 0 ? null : index, 1700000000 + index, "{}", JSON.stringify(message));
    const window = await readCliTailWindow(database, "fixture", 4, new ReadBudget(), 1, ["user", "assistant"]);
    const resultHeader = window.nodes.find(node => node.message.role === "tool")!;
    assert.equal(resultHeader.message.tool_call_id, "call-1");
    assert.equal(resultHeader.message.content, undefined);
    const rounds = devinRawToRounds({ nodes: window.nodes, desktopMessages: [], compactions: [], summary: { canonicalId: "fixture" } } as any);
    assert.deepEqual(rounds[0]!.toolCalls.map(call => call.name), ["read"]);
    console.log("PASS normal tail keeps lightweight tool identity without reading its result or double-counting the call");
} finally {
    database.close();
}
