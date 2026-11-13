import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = fs.mkdtempSync(path.join(process.env.DEVIN_TOOL_ROLE_TEST_ROOT || os.tmpdir(), "devin-tool-role-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(root, "sessions.db");
process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(root, "desktop");
fs.mkdirSync(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT);
const { DevinIdentityCache } = await import("../src/devin-sqlite.js");
const { readDevinConversation } = await import("../src/devin-conversation.js");
const { formatRoundForMessageRoles } = await import("../src/trajectory.js");
const database = new DatabaseSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH);
database.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,main_chain_id INTEGER,title TEXT,last_activity_at INTEGER,metadata TEXT); CREATE TABLE message_nodes(session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,metadata TEXT,created_at INTEGER,PRIMARY KEY(session_id,node_id));");
const messages = [
    { role: "user", content: "question" },
    { role: "assistant", content: "PRIVATE_ASSISTANT_BODY", thinking: "PRIVATE_THINKING", tool_calls: [
        { id: "flat-read", name: "read", arguments: { file_path: "example.md" } },
        { id: "nested-mcp", function: { name: "mcp_call_tool", arguments: JSON.stringify({ tool_name: "conversation_read_original", arguments: { action: "list" } }) } },
    ] },
    { role: "tool", tool_call_id: "flat-read", content: "read result" },
    { role: "tool", tool_call_id: "nested-mcp", content: "mcp result" },
    { role: "assistant", content: "done" },
];
database.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run("fixture-tool-role", messages.length, "Tool metadata", 1, "{}");
const insert = database.prepare("INSERT INTO message_nodes VALUES(?,?,?,?,?,?)");
for (const [index, message] of messages.entries()) insert.run("fixture-tool-role", index + 1, index === 0 ? null : index, JSON.stringify(message), "{}", index + 1);
database.close();

const options = { identityMode: "physical" as const, physicalSourceKind: "devin-cli" as const, roundRange: { startRound: 1, endRound: 1 }, materializeAttachments: false, maxDesktopFiles: 0 };
const tools = await readDevinConversation("fixture-tool-role", { ...options, identityCache: new DevinIdentityCache(), messageRoles: ["tool"] });
assert.ok(tools);
assert.deepEqual(tools.rounds[0].toolCalls.map(call => call.name), ["read", "mcp_call_tool"]);
assert.deepEqual(JSON.parse(tools.rounds[0].toolCalls[0].argsFull!), { file_path: "example.md" });
assert.equal(tools.rounds[0].toolCalls[0].resultFull, "read result");
assert.equal(tools.rounds[0].toolCalls[1].resultFull, "mcp result");
const output = formatRoundForMessageRoles(tools.rounds[0], "full", ["tool_results"], new Set(["tool"]), "omit");
assert.match(output, /mcp_call_tool|example\.md/u);
assert.doesNotMatch(output, /PRIVATE_ASSISTANT_BODY|PRIVATE_THINKING/u);
const users = await readDevinConversation("fixture-tool-role", { ...options, identityCache: new DevinIdentityCache(), messageRoles: ["user"] });
assert.equal(users?.raw.nodes.find(node => node.message.role === "assistant")?.message.content, undefined);
console.log("PASS tool-only source reads retain original flat/nested tool names, arguments and results without exposing assistant text; user-only reads stay lightweight");
