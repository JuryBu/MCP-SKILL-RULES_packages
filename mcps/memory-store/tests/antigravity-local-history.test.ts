import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { listAntigravityLocalConversations, loadAntigravityLocalConversation, fingerprintAntigravityLocalConversation } from "../src/antigravity-local-history.ts";
import { createBinaryHostReader, listBinaryHostConversations } from "../src/conversation-host-binary.ts";
import { projectHostCorpus } from "../src/conversation-host-projection.ts";

function varint(value: number): Buffer {
    const bytes: number[] = [];
    let remaining = value;
    do { const byte = remaining & 127; remaining = Math.floor(remaining / 128); bytes.push(remaining ? byte | 128 : byte); } while (remaining);
    return Buffer.from(bytes);
}

function field(number: number, value: string | Buffer): Buffer {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "memory-store-agy-history-"));
const gui = path.join(temporary, "gui");
const cli = path.join(temporary, "cli");
const roots = [{ kind: "gui" as const, root: gui }, { kind: "cli" as const, root: cli }];
const key = randomBytes(32);
const options = { roots, pbReaderOptions: { key } };
const oldEnvironment = [process.env.MEMORY_STORE_ANTIGRAVITY_ROOT, process.env.MEMORY_STORE_ANTIGRAVITY_CLI_ROOT];

async function writeLog(root: string, id: string, rows: unknown[], name = "transcript_full.jsonl"): Promise<string> {
    const directory = path.join(root, "brain", id, ".system_generated", "logs");
    await fs.mkdir(directory, { recursive: true });
    const filename = path.join(directory, name);
    await fs.writeFile(filename, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    return filename;
}

try {
    await fs.mkdir(path.join(gui, "conversations"), { recursive: true });
    await fs.mkdir(cli, { recursive: true });
    const database = new DatabaseSync(path.join(gui, "conversation_summaries.db"));
    database.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY,title TEXT,workspace_uris TEXT,step_count INTEGER,last_modified_time TEXT,parent_conversation_id TEXT,agent_name TEXT,nesting_depth INTEGER)");
    const insert = database.prepare("INSERT INTO conversation_summaries VALUES(?,?,?,?,?,?,?,?)");
    insert.run("new", "新母对话", JSON.stringify(["C:/workspace"]), 5, "2026-11-13T00:00:00Z", "", "", 0);
    insert.run("child", "子代理", "[]", 1, "2026-11-13T00:00:00Z", "new", "reader", 1);
    database.close();
    const rows = [
        { step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>主人完整尾文</USER_REQUEST>", annotations: [{ selected_text: "原句", comment: "批注" }], media: [{ uri: "C:/image.png", mime_type: "image/png" }] },
        { step_index: 1, type: "PLANNER_RESPONSE", content: "助手完整尾文", thinking: "独立思考", tool_calls: [{ name: "read_file", args: { Path: "file" } }] },
        { step_index: 2, type: "GENERIC", content: "完整工具结果", subagent: { conversation_id: "child", agent_name: "reader", summary: "完成" } },
        { step_index: 3, type: "ERROR_MESSAGE", error: "保留错误字段" },
        { step_index: 3, type: "USER_INPUT", content: "重复步号中的新输入" },
        { step_index: 4, type: "PLANNER_RESPONSE", content: "最后一条回复" },
    ];
    await writeLog(gui, "new", rows);
    await writeLog(gui, "new", rows.map(row => row.step_index === 1 ? { ...row, content: "助手完整", truncated_fields: ["content"] } : row), "transcript.jsonl");
    await writeLog(gui, "child", [{ step_index: 0, type: "USER_INPUT", content: "子任务正文" }]);
    await writeLog(cli, "new", [{ step_index: 0, type: "USER_INPUT", content: "独立CLI历史" }]);
    const listed = await listAntigravityLocalConversations(options);
    assert.equal(listed.find(item => item.id === "child")?.parentConversationId, "new");
    assert.equal(listed.find(item => item.id === "child")?.agentName, "reader");
    assert.ok(listed.some(item => item.id === "antigravity-cli:new"));
    const result = await loadAntigravityLocalConversation("new", options);
    assert.ok(result);
    assert.equal(result.timings.jsonlRecords, rows.length);
    assert.equal(result.rounds.length, 2);
    assert.equal(result.rounds[0].userMessage, "主人完整尾文");
    assert.equal(result.rounds[0].userMessages?.[0].annotations?.[0].comment, "批注");
    assert.equal(result.rounds[0].attachments?.[0].reference, "C:/image.png");
    assert.equal(result.rounds[0].aiResponses[0].response, "助手完整尾文");
    assert.equal(result.rounds[0].aiResponses[0].thinking, "独立思考");
    assert.equal(result.rounds[0].toolCalls[0].name, "read_file");
    assert.equal(result.rounds[0].toolCalls[0].resultFull, "完整工具结果");
    assert.equal(result.rounds[0].subagentSummaries[0].threadId, "child");
    assert.ok(result.rounds[0].semanticEvents?.some(event => event.kind === "error" && event.text === "保留错误字段"));
    assert.equal(result.partial, false);
    assert.equal((await loadAntigravityLocalConversation("antigravity-cli:new", options))?.rounds[0].userMessage, "独立CLI历史");
    assert.equal((await fingerprintAntigravityLocalConversation("new", options))?.revision, result.fingerprint.revision);
    const sqlite = new DatabaseSync(path.join(gui, "conversations", "db-only.db"));
    sqlite.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,step_format INTEGER,step_payload BLOB);CREATE TABLE trajectory_meta(trajectory_id TEXT,cascade_id TEXT)");
    sqlite.prepare("INSERT INTO trajectory_meta VALUES(?,?)").run("db-internal", "db-only");
    const stepInsert = sqlite.prepare("INSERT INTO steps VALUES(?,?,?,?)");
    stepInsert.run(0, 14, 0, field(19, field(1, "DB独有主人正文")));
    stepInsert.run(1, 1, 0, field(20, field(1, "DB独有助手正文")));
    sqlite.close();
    const dbOnly = await loadAntigravityLocalConversation("db-only", options);
    assert.equal(dbOnly?.rounds[0].userMessage, "DB独有主人正文");
    assert.equal(dbOnly?.rounds[0].aiResponses[0].response, "DB独有助手正文");
    assert.deepEqual(dbOnly?.internalTrajectoryIds, ["db-internal"]);
    assert.match(dbOnly!.sourceKind, /sqlite$/u);
    const supplement = new DatabaseSync(path.join(gui, "conversations", "supplement.db"));
    supplement.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,step_format INTEGER,step_payload BLOB);CREATE TABLE trajectory_meta(trajectory_id TEXT,cascade_id TEXT)");
    supplement.prepare("INSERT INTO trajectory_meta VALUES(?,?)").run("supplement-internal", "supplement");
    const supplementInsert = supplement.prepare("INSERT INTO steps VALUES(?,?,?,?)");
    supplementInsert.run(0, 14, 0, field(19, field(1, "保留原始输入")));
    supplementInsert.run(1, 17, 0, field(24, field(3, Buffer.concat([field(1, "错误概述"), field(2, "DB缺步完整错误")]))));
    supplementInsert.run(3, 1, 0, field(20, field(1, "存在合法索引间隙")));
    supplement.close();
    await writeLog(gui, "supplement", [{ step_index: 0, type: "USER_INPUT", content: "保留原始输入" }, { step_index: 3, type: "PLANNER_RESPONSE", content: "存在合法索引间隙" }]);
    const supplemented = await loadAntigravityLocalConversation("supplement", options);
    assert.equal(supplemented?.partial, false);
    assert.equal(supplemented?.coverage.complete, true);
    assert.ok(supplemented?.rounds[0].semanticEvents?.some(event => event.kind === "error" && event.text?.includes("DB缺步完整错误")));
    const plaintext = Buffer.concat([field(1, "different-internal-id"), field(2, field(19, field(1, "PB早期输入"))), field(2, Buffer.concat([field(20, field(1, "PB早期回复")), field(25, field(1, "unmapped-wire"))])),
        field(2, field(19, field(1, "跨代输入"))), field(2, field(20, field(1, "跨代回复")))]);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    await fs.writeFile(path.join(gui, "conversations", "mixed.pb"), encrypted);
    await writeLog(gui, "mixed", [{ step_index: 2, type: "USER_INPUT", content: "<USER_REQUEST>跨代输入</USER_REQUEST>" },
        { step_index: 3, type: "PLANNER_RESPONSE", content: "跨代回复", thinking: "新日志思考" },
        { step_index: 4, type: "USER_INPUT", content: "PB之后的新输入" }, { step_index: 5, type: "PLANNER_RESPONSE", content: "新日志尾文" }]);
    const mixed = await loadAntigravityLocalConversation("mixed", options);
    assert.ok(mixed);
    assert.equal(mixed.rounds.length, 3);
    assert.equal(mixed.rounds[0].userMessage, "PB早期输入");
    assert.equal(mixed.rounds[1].aiResponses[0].response, "跨代回复");
    assert.equal(mixed.rounds[2].aiResponses[0].response, "新日志尾文");
    assert.deepEqual(mixed.internalTrajectoryIds, ["different-internal-id"]);
    assert.match(mixed.sourceKind, /pb\+jsonl/u);
    assert.equal(mixed.partial, true);
    assert.ok(mixed.rounds.some(round => round.semanticEvents?.some(event => event.kind === "pb_wire_variant")));
    const originalRevision = mixed.fingerprint.revision;
    await fs.appendFile(path.join(gui, "brain", "mixed", ".system_generated", "logs", "transcript_full.jsonl"), '{"step_index":6');
    const partial = await loadAntigravityLocalConversation("mixed", options);
    assert.equal(partial?.partial, true);
    assert.notEqual(partial?.fingerprint.revision, originalRevision);
    assert.ok(partial?.sourceDiagnostics.some(item => item.code === "ANTIGRAVITY_INCOMPLETE_FINAL_RECORD"));
    await assert.rejects(loadAntigravityLocalConversation("new", { ...options, maxBytes: 10 }), /BYTE_BUDGET/u);
    await assert.rejects(loadAntigravityLocalConversation("new", { ...options, maxLineBytes: 10 }), /LINE_BUDGET/u);
    await assert.rejects(loadAntigravityLocalConversation("new", { ...options, isCancelled: () => true }), /cancelled/u);
    await assert.rejects(loadAntigravityLocalConversation("../new", options), /Invalid Antigravity/u);
    await writeLog(gui, "suffix", [{ step_index: 100, type: "USER_INPUT", content: "只有尾部" }]);
    assert.equal((await loadAntigravityLocalConversation("suffix", options))?.partial, true);
    process.env.MEMORY_STORE_ANTIGRAVITY_ROOT = gui;
    process.env.MEMORY_STORE_ANTIGRAVITY_CLI_ROOT = cli;
    const legacySteps = Array.from({ length: 200 }, (_, index) => [field(2, field(19, field(1, `legacy-user-${index}`))), field(2, field(20, field(1, `legacy-model-${index}`)))]).flat();
    const legacyPlaintext = Buffer.concat([field(1, "legacy-window"), ...legacySteps]);
    const legacyNonce = randomBytes(12);
    const legacyCipher = createCipheriv("aes-256-gcm", key, legacyNonce);
    await fs.writeFile(path.join(gui, "conversations", "legacy-window.pb"), Buffer.concat([legacyNonce, legacyCipher.update(legacyPlaintext), legacyCipher.final(), legacyCipher.getAuthTag()]));
    const legacyReader = createBinaryHostReader("antigravity", { pbReaderOptions: { key } });
    const legacyConversation = { source: "antigravity" as const, id: "legacy-window", title: "legacy", workspace: "" };
    const legacyTail = await legacyReader.read(legacyConversation, { lastRounds: 2 }, {});
    assert.equal(legacyTail.timings?.decodedSteps, 64);
    assert.equal(legacyTail.roundNumbering, "relative");
    const legacyAgain = await legacyReader.read(legacyConversation, { lastRounds: 2 }, {});
    assert.equal(legacyAgain.timings?.preparedReused, 1);
    const corpus = await listBinaryHostConversations("antigravity", { conversationIds: ["new", "child"] }, {}, {});
    assert.equal(corpus.conversations.length, 2);
    const conversation = corpus.conversations.find(item => item.id === "new")!;
    const snapshot = await createBinaryHostReader("antigravity", {}).read(conversation, { lastRounds: 1 }, {});
    const projection = projectHostCorpus(conversation, snapshot, { lastRounds: 1 }, {});
    assert.ok(projection.messages.some(message => message.text.includes("重复步号中的新输入")));
    assert.equal(projection.totalRounds, 2);
    console.log("PASS antigravity local history: full/compact, repeated indices, PB+JSONL, IDs, SQLite parent/child, CLI isolation, fingerprints, errors, attachments, annotations, budgets, cancellation, corpus range");
} finally {
    if (oldEnvironment[0] === undefined) delete process.env.MEMORY_STORE_ANTIGRAVITY_ROOT; else process.env.MEMORY_STORE_ANTIGRAVITY_ROOT = oldEnvironment[0];
    if (oldEnvironment[1] === undefined) delete process.env.MEMORY_STORE_ANTIGRAVITY_CLI_ROOT; else process.env.MEMORY_STORE_ANTIGRAVITY_CLI_ROOT = oldEnvironment[1];
    await fs.rm(temporary, { recursive: true, force: true });
}
