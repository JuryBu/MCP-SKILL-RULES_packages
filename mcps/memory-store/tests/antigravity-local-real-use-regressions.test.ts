import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ANTIGRAVITY_LOCAL_NORMALIZATION_VERSION, loadAntigravityLocalConversation } from "../src/antigravity-local-history.ts";
import { listAntigravityLocalConversations } from "../src/antigravity-local-sources.ts";
import { formatCorpusReadableResult } from "../src/conversation-readable-output.ts";

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

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "memory-store-agy-real-use-regressions-"));
const gui = path.join(temporary, "gui");
const cli = path.join(temporary, "cli");
const key = randomBytes(32);
const roots = [{ kind: "gui" as const, root: gui }, { kind: "cli" as const, root: cli }];
const options = { roots, pbReaderOptions: { key } };

async function writeLog(root: string, id: string, rows: unknown[]): Promise<void> {
    const directory = path.join(root, "brain", id, ".system_generated", "logs");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "transcript_full.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
}

async function writePb(id: string, steps: Buffer[]): Promise<void> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const plaintext = Buffer.concat([field(1, "fixture-internal-id"), ...steps.map(step => field(2, step))]);
    await fs.writeFile(path.join(gui, "conversations", `${id}.pb`), Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
}

function writeDatabase(id: string, extraFormat = 0, extraCount = 1): void {
    const database = new DatabaseSync(path.join(gui, "conversations", `${id}.db`));
    try {
        database.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,step_format INTEGER,step_payload BLOB);CREATE TABLE trajectory_meta(trajectory_id TEXT,cascade_id TEXT)");
        database.prepare("INSERT INTO trajectory_meta VALUES(?,?)").run("fixture-internal-id", id);
        const insert = database.prepare("INSERT INTO steps VALUES(?,?,?,?)");
        insert.run(0, 14, 0, field(19, field(1, "user0")));
        insert.run(1, 1, 0, field(20, field(1, "assistant1")));
        for (let index = 0; index < extraCount; index += 1) insert.run(index + 2, 14, extraFormat, field(19, field(1, `DB-only missing user ${index}`)));
    } finally { database.close(); }
}

try {
    await fs.mkdir(path.join(gui, "conversations"), { recursive: true });
    await fs.mkdir(cli, { recursive: true });
    const standard = [field(19, field(1, "user0")), field(20, field(1, "assistant1"))];
    const log = [{ step_index: 0, type: "USER_INPUT", content: "user0" }, { step_index: 1, type: "PLANNER_RESPONSE", content: "assistant1" }];
    await writePb("mixed", standard);
    await writeLog(gui, "mixed", log);
    writeDatabase("mixed");
    const mixed = await loadAntigravityLocalConversation("mixed", options);
    assert.equal(ANTIGRAVITY_LOCAL_NORMALIZATION_VERSION, 3);
    assert.equal(mixed?.partial, false);
    assert.equal(mixed?.coverage.complete, true);
    assert.equal(mixed?.totalSteps, 3);
    assert.ok(mixed?.rounds.some(round => round.userMessage === "DB-only missing user 0"));
    assert.match(mixed!.sourceKind, /pb\+jsonl\+sqlite/u);
    await writePb("repeated-input", standard);
    await writeLog(gui, "repeated-input", [
        { step_index: 0, type: "USER_INPUT", content: "user0", created_at: "2026-11-01T03:06:14Z" },
        { step_index: 0, type: "USER_INPUT", content: "user0", created_at: "2026-11-01T03:11:24Z" },
        { step_index: 1, type: "PLANNER_RESPONSE", content: "assistant1" },
    ]);
    const repeatedInput = await loadAntigravityLocalConversation("repeated-input", options);
    const repeatedMessages = repeatedInput!.rounds.flatMap(round => round.userMessages || []);
    assert.equal(repeatedMessages.length, 2);
    assert.deepEqual(repeatedMessages.map(message => message.createdAt), ["2026-11-01T03:06:14Z", "2026-11-01T03:11:24Z"]);
    await writePb("unsupported", standard);
    await writeLog(gui, "unsupported", log);
    writeDatabase("unsupported", 99);
    const unsupported = await loadAntigravityLocalConversation("unsupported", options);
    assert.equal(unsupported?.partial, true);
    assert.equal(unsupported?.coverage.complete, false);
    assert.ok(unsupported?.sourceDiagnostics.some(item => item.code === "ANTIGRAVITY_SQLITE_STEP_UNSUPPORTED"));
    await writePb("budget", standard);
    await writeLog(gui, "budget", log);
    writeDatabase("budget", 0, 257);
    const budget = await loadAntigravityLocalConversation("budget", options);
    assert.equal(budget?.partial, true);
    assert.equal(budget?.coverage.complete, false);
    assert.ok(budget?.sourceDiagnostics.some(item => item.code === "ANTIGRAVITY_SQLITE_SUPPLEMENT_BUDGET"));
    await writePb("diagnostics", Array.from({ length: 5 }, () => Buffer.concat([field(19, field(1, "repeat source input")), field(25, field(1, "unknown-wire"))])));
    const diagnostics = await loadAntigravityLocalConversation("diagnostics", options);
    assert.equal(diagnostics?.partial, true);
    assert.ok(diagnostics!.rawSourceDiagnostics.length > diagnostics!.sourceDiagnostics.length);
    assert.ok(diagnostics?.sourceDiagnostics.some(item => (item.occurrences || 0) > 1));
    assert.ok(diagnostics!.pbResults[0].diagnostics.length >= 5);
    const database = new DatabaseSync(path.join(gui, "conversation_summaries.db"));
    database.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY,title TEXT,workspace_uris TEXT,step_count INTEGER,last_modified_time TEXT,parent_conversation_id TEXT,agent_name TEXT,nesting_depth INTEGER)");
    const insert = database.prepare("INSERT INTO conversation_summaries VALUES(?,?,?,?,?,?,?,?)");
    insert.run("parent", "same title", "[]", 1, "2026-11-13T00:10:00Z", "", "", 0);
    insert.run("child", "child", "[]", 1, "2026-11-13T00:01:00Z", "parent", "reader", 1);
    insert.run("other-child", "other", "[]", 1, "2026-11-13T00:09:00Z", "other-parent", "reader", 1);
    insert.run("metadata", "same title", "[]", 9, "2026-11-13T00:11:00Z", "", "", 0);
    insert.run("mixed", "stale summaries", "[]", 2, "2026-11-13T00:00:00Z", "", "", 0);
    database.close();
    await writeLog(gui, "parent", [{ step_index: 0, type: "USER_INPUT", content: "parent text" }]);
    await writeLog(gui, "child", [{ step_index: 0, type: "USER_INPUT", content: "child text" }]);
    await writeLog(cli, "metadata", [{ step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "You did not call any tools." }]);
    const children = await listAntigravityLocalConversations({ ...options, threadMode: "children", parentConversationId: "parent", limit: 1 });
    assert.deepEqual(children.map(item => item.id), ["child"]);
    assert.equal((await listAntigravityLocalConversations({ ...options, threadMode: "children", parentConversationId: "antigravity-cli:parent" })).length, 0);
    await assert.rejects(listAntigravityLocalConversations({ ...options, threadMode: "children" }), /exact parent/u);
    const discoveredDiagnostics: string[] = [];
    const candidates = await listAntigravityLocalConversations({ ...options, conversationIds: ["metadata", "antigravity-cli:metadata"], onDiagnostic: diagnostic => discoveredDiagnostics.push(diagnostic.code) });
    assert.equal(candidates.length, 2);
    assert.ok(discoveredDiagnostics.includes("ANTIGRAVITY_METADATA_ONLY"));
    await assert.rejects(loadAntigravityLocalConversation("metadata", options), /ANTIGRAVITY_BODY_UNAVAILABLE/u);
    const independentCli = await loadAntigravityLocalConversation("antigravity-cli:metadata", options);
    assert.match(independentCli!.rounds[0].userMessages![0].rawRole!, /antigravity-cli.*source=USER_EXPLICIT/u);
    const afterStaleMetadata = await loadAntigravityLocalConversation("mixed", options);
    assert.equal(afterStaleMetadata?.totalSteps, 3);
    assert.ok(afterStaleMetadata?.rounds.some(round => round.userMessage.includes("DB-only missing user")));
    const readable = formatCorpusReadableResult({ messages: [{ role: "user", rawRole: "antigravity-cli.jsonl.USER_INPUT.source=USER_EXPLICIT", round: 1, text: "You did not call any tools." }], rounds: [{ roundIndex: 1 }] }, { action: "read_fast", conversationId: "fixture-caller", dataChain: "antigravity" });
    assert.match(readable!, /CLI 输入.*USER_EXPLICIT.*作者未核/u);
    assert.doesNotMatch(readable!, /👤 用户/u);
    console.log("PASS: triple-source DB-only user with absent/stale summaries, unsupported/budget partial, complete raw diagnostics with deduplicated presentation, exact parent filtering before limit, metadata-only errors, independent GUI/CLI and source attribution");
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
