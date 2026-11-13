import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createCipheriv } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConversationSourceAdapters, UnifiedConversationCandidate } from "../src/conversation-filter.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-agy-auto-1281-"));
const environment = { ...process.env };
const originalHome = os.homedir;
os.homedir = () => root;
const gui = path.join(root, "gui");
const cli = path.join(root, "cli");
const active = path.join(gui, "conversations");
const implicit = path.join(gui, "implicit");
for (const directory of [gui, cli, active, implicit]) fs.mkdirSync(directory, { recursive: true });
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "store");
process.env.MEMORY_STORE_ANTIGRAVITY_ROOT = gui;
process.env.MEMORY_STORE_ANTIGRAVITY_CLI_ROOT = cli;
process.env.MEMORY_STORE_ANTIGRAVITY_PB_ACTIVE_ROOT = active;
process.env.MEMORY_STORE_ANTIGRAVITY_PB_IMPLICIT_ROOT = implicit;
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
process.env.APPDATA = path.join(root, "appdata");
const key = Buffer.from("0123456789abcdef0123456789abcdef");
process.env.MEMORY_STORE_LOCAL_PB_KEY = key.toString("hex");
const bridge = await import("../src/conversation-bridge.js");
const filter = await import("../src/conversation-filter.js");
const discovery = await import("../src/record-discovery.js");
const ls = await import("../src/ls-client.js");
const registry = await import("../src/ls-registry.js");
registry.__setRegistryPathForTest(path.join(root, "registry.json"));
ls.__disableLsForTest();
ls.__setConvCacheDirForTest(path.join(root, "ls-cache"));

function writeTranscript(id: string, rows: unknown[], options: { host?: string; compact?: boolean } = {}): string {
    const logs = path.join(options.host || gui, "brain", id, ".system_generated", "logs");
    fs.mkdirSync(logs, { recursive: true });
    const filename = path.join(logs, options.compact ? "transcript.jsonl" : "transcript_full.jsonl");
    fs.writeFileSync(filename, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    return filename;
}

function basicRows(question = "same question", answer = "same answer"): unknown[] {
    return [{ step_index: 0, type: "USER_INPUT", content: question }, { step_index: 1, type: "PLANNER_RESPONSE", content: answer }];
}

function varint(value: number): Buffer {
    const bytes: number[] = [];
    let remaining = value;
    do {
        const octet = remaining % 128;
        remaining = Math.floor(remaining / 128);
        bytes.push(remaining ? octet | 128 : octet);
    } while (remaining);
    return Buffer.from(bytes);
}

function field(number: number, content: string | Buffer): Buffer {
    const bytes = Buffer.from(content);
    return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

function writePb(id: string): void {
    const plaintext = Buffer.concat([field(1, id), field(2, Buffer.concat([
        field(19, field(1, "same question")), field(20, field(1, "same answer")),
    ]))]);
    const nonce = Buffer.alloc(12, 7);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    fs.writeFileSync(path.join(active, `${id}.pb`), Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
}

async function withLs(id: string, answer: string, run: (calls: string[]) => Promise<void>, question = "same question"): Promise<void> {
    const calls: string[] = [];
    const server = http.createServer(async (request, response) => {
        for await (const _chunk of request) {}
        const method = request.url!.split("/").at(-1)!;
        calls.push(method);
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(method === "GetAllCascadeTrajectories"
            ? { trajectorySummaries: { [id]: { stepCount: 2, lastModifiedTime: "stable-version" } } }
            : { steps: [
                { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: question } },
                { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: answer } },
            ] }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    ls.__setParentLsForTest({ info: { pid: 1281, csrfToken: "fixture-csrf", workspaceId: "fixture-workspace", ports: [port] }, port });
    try { await run(calls); }
    finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        ls.__disableLsForTest();
    }
}

test("normal auto keeps complete JSONL tools and images without parsing legacy LS", async () => {
    const id = "auto-complete";
    const image = path.join(root, "screenshot.png");
    fs.writeFileSync(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    writeTranscript(id, [
        { step_index: 0, type: "USER_INPUT", content: "same question" },
        { step_index: 1, type: "PLANNER_RESPONSE", content: "same answer", tool_calls: [{ name: "take_screenshot", args: "{}" }] },
        { step_index: 2, type: "GENERIC", tool_name: "take_screenshot", content: `screenshot: ${image}` },
    ]);
    await withLs(id, "same answer", async calls => {
        const loaded = await bridge.loadConversationData("antigravity", id);
        assert.ok(loaded?.cacheGeneration);
        assert.equal(loaded.sourcePartial, false);
        assert.equal(loaded.sourceCoverage?.source, "local");
        assert.equal(loaded.sourceCoverage?.comparison, "not_requested");
        assert.equal(loaded.rounds[0].toolCalls.length, 1);
        assert.match(JSON.stringify(loaded.rounds), /screenshot\.png/u);
        assert.ok(loaded.rounds[0].semanticEvents?.some(event => event.semanticRole === "tool" && event.attachments?.length));
        assert.ok(calls.every(method => method === "GetAllCascadeTrajectories"));
        const cached = await bridge.loadConversationData("antigravity", id, { source: "cache", cacheGeneration: loaded.cacheGeneration });
        assert.deepEqual(cached?.rounds, loaded.rounds);
    });
});

test("active same-round local revision changes rebuild auto without accepting conflicting LS text", async () => {
    const id = "active-full";
    writeTranscript(id, basicRows("same question", "first local answer"));
    await withLs(id, "different active LS answer", async calls => {
        const first = await bridge.loadConversationData("antigravity", id);
        writeTranscript(id, basicRows("same question", "newer local answer"));
        const second = await bridge.loadConversationData("antigravity", id);
        assert.equal(first?.rounds.length, second?.rounds.length);
        assert.notEqual(first?.cacheGeneration, second?.cacheGeneration);
        assert.match(JSON.stringify(second?.rounds), /newer local answer/u);
        assert.doesNotMatch(JSON.stringify(second?.rounds), /different active LS answer/u);
        assert.ok(calls.every(method => method === "GetAllCascadeTrajectories"));
    });
});

test("old auto LS caches rebuild once and then reuse the complete local generation", async () => {
    const id = "old-auto-cache";
    writeTranscript(id, [
        { step_index: 0, type: "USER_INPUT", content: "same question" },
        { step_index: 1, type: "PLANNER_RESPONSE", content: "same answer", tool_calls: [{ name: "preserve_tool", args: "{}" }] },
        { step_index: 2, type: "GENERIC", tool_name: "preserve_tool", content: "source tool result" },
    ]);
    await withLs(id, "same answer", async calls => {
        const loaded = await bridge.loadConversationData("antigravity", id);
        assert.ok(loaded?.cacheKey && loaded.cacheFingerprint);
        const cache = await import("../src/conversation-source-cache.js");
        const incompleteRounds = loaded.rounds.map(round => ({ ...round, toolCalls: [], semanticEvents: [],
            aiResponses: round.aiResponses.map(response => ({ ...response, toolCalls: [] })) }));
        const old = await cache.readOrBuild({ key: loaded.cacheKey, fingerprint: loaded.cacheFingerprint, refresh: true,
            build: () => ({ snapshot: { ...loaded, rounds: [], antigravitySourceSelectionVersion: undefined,
                antigravityFullLocalTranscript: false, cacheAuthority: "ls", toolCallCount: 0 }, rounds: incompleteRounds }),
            getRoundNumber: round => round.roundIndex });
        const rebuilt = await bridge.loadConversationData("antigravity", id);
        assert.notEqual(rebuilt?.cacheGeneration, old.generation);
        assert.equal(rebuilt?.antigravitySourceSelectionVersion, 1);
        assert.match(JSON.stringify(rebuilt?.rounds), /source tool result/u);
        const reused = await bridge.loadConversationData("antigravity", id);
        assert.equal(reused?.cacheGeneration, rebuilt?.cacheGeneration);
        assert.equal(reused?.cacheState, "hit");
        assert.ok(calls.every(method => method === "GetAllCascadeTrajectories"));
    });
});

test("explicit ls remains an LS read when a full local transcript exists", async () => {
    const id = "explicit-ls";
    writeTranscript(id, basicRows());
    await withLs(id, "explicit LS response", async calls => {
        const loaded = await bridge.loadConversationData("antigravity", id, { source: "ls", sourceReadBudget: { maxBytes: 8192 } });
        assert.match(JSON.stringify(loaded?.rounds), /explicit LS response/u);
        assert.equal(loaded?.sourceCoverage?.source, "ls");
        assert.ok(calls.some(method => method !== "GetAllCascadeTrajectories"));
    });
});

test("PB-only equal chooses the complete local projection and real conflicts still fail", async () => {
    const id = "legacy-pb";
    writePb(id);
    await withLs(id, "same answer", async calls => {
        const loaded = await bridge.loadConversationData("antigravity", id, { sourceReadBudget: { maxBytes: 8192 } });
        assert.equal(loaded?.sourceCoverage?.source, "local");
        assert.equal(loaded?.sourceCoverage?.comparison, "complete");
        assert.ok(loaded?.sourceDiagnostics?.some(message => message.includes("来源比较: equal") && message.includes("本地 PB")));
        assert.ok(calls.some(method => method !== "GetAllCascadeTrajectories"));
    });
    await withLs(id, "unrelated response", async () => {
        await assert.rejects(bridge.loadConversationData("antigravity", id, { refresh: true, sourceReadBudget: { maxBytes: 8192 } }), /内容冲突/u);
    });
});

test("compact or partial JSONL does not gain full authority from an equal round count", async () => {
    const id = "compact-partial";
    writeTranscript(id, [
        { step_index: 0, type: "USER_INPUT", content: "same question" },
        { step_index: 1, type: "PLANNER_RESPONSE", content: "truncated local", truncated_fields: ["content"] },
    ], { compact: true });
    await withLs(id, "different response", async calls => {
        await assert.rejects(bridge.loadConversationData("antigravity", id, { sourceReadBudget: { maxBytes: 8192 } }), /内容冲突/u);
        assert.ok(calls.some(method => method !== "GetAllCascadeTrajectories"));
    });
});

test("modern local byte-budget errors remain errors instead of silently falling back to LS", async () => {
    const id = "byte-budget";
    writeTranscript(id, basicRows());
    await withLs(id, "same answer", async calls => {
        await assert.rejects(bridge.loadConversationData("antigravity", id, { sourceReadBudget: { maxBytes: 1 } }), /ANTIGRAVITY_LOCAL_BYTE_BUDGET/u);
        assert.deepEqual(calls, []);
    });
});

test("auto still reads an LS-only source when no readable local source exists", async () => {
    const id = "ls-only-source";
    await withLs(id, "LS-only answer", async calls => {
        const loaded = await bridge.loadConversationData("antigravity", id, { sourceReadBudget: { maxBytes: 8192 } });
        assert.match(JSON.stringify(loaded?.rounds), /LS-only answer/u);
        assert.equal(loaded?.sourceCoverage?.source, "ls");
        assert.ok(calls.some(method => method !== "GetAllCascadeTrajectories"));
    });
});

test("CLI-qualified auto keeps the CLI identity without probing GUI LS", async () => {
    const id = "same-id-cli";
    writeTranscript(id, basicRows("CLI request", "CLI answer"), { host: cli });
    writeTranscript(id, basicRows("GUI request", "GUI answer"));
    await withLs(id, "GUI LS answer", async calls => {
        const loaded = await bridge.loadConversationData("antigravity", `antigravity-cli:${id}`, { sourceReadBudget: { maxBytes: 8192 } });
        assert.equal(loaded?.conversationId, `antigravity-cli:${id}`);
        assert.match(JSON.stringify(loaded?.rounds), /CLI request/u);
        assert.doesNotMatch(JSON.stringify(loaded?.rounds), /GUI request/u);
        assert.deepEqual(calls, []);
    });
});

function writeCatalog(): void {
    const database = new DatabaseSync(path.join(gui, "conversation_summaries.db"));
    try {
        database.exec("CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY,title TEXT,workspace_uris TEXT,step_count INTEGER,last_modified_time TEXT,parent_conversation_id TEXT,agent_name TEXT,nesting_depth INTEGER)");
        const insert = database.prepare("INSERT INTO conversation_summaries VALUES(?,?,?,?,?,?,?,?)");
        insert.run("catalog-parent", "Modern parent title", '["file:///C:/fixture/project"]', 2, "2026-11-13T00:00:00Z", "", "", 0);
        insert.run("catalog-child", "Modern child title", '["file:///C:/fixture/project"]', 2, "2026-11-13T00:00:01Z", "catalog-parent", "reader", 1);
        insert.run("catalog-old", "Older date target", "[]", 2, "2020-01-01T00:00:00Z", "", "", 0);
    } finally { database.close(); }
    for (const id of ["catalog-parent", "catalog-child", "catalog-old"]) writeTranscript(id, basicRows());
    const oldLogs = path.dirname(path.dirname(path.dirname(path.join(gui, "brain", "catalog-old", ".system_generated", "logs", "transcript_full.jsonl"))));
    const oldFile = path.join(oldLogs, ".system_generated", "logs", "transcript_full.jsonl");
    fs.utimesSync(oldFile, new Date("2020-01-01"), new Date("2020-01-01"));
}

test("default title and children discovery joins the modern catalog and keeps qualified CLI identities", async () => {
    writeCatalog();
    const titled = await filter.listConversationCandidates({ dataChains: ["antigravity"], query: "Modern parent title", limit: 5 });
    assert.deepEqual(titled.candidates.map(candidate => candidate.id), ["catalog-parent"]);
    assert.ok(titled.candidates[0].workspace.toLowerCase().includes("fixture"));
    const children = await filter.listConversationCandidates({ dataChains: ["antigravity"], threadMode: "children", parentQuery: "Modern parent title", limit: 5 });
    assert.deepEqual(children.candidates.map(candidate => candidate.id), ["catalog-child"]);
    const explicitChildren = await filter.listConversationCandidates({ dataChains: ["antigravity"], threadMode: "children", parentConversationId: "catalog-parent", limit: 5 });
    assert.deepEqual(explicitChildren.candidates.map(candidate => candidate.id), ["catalog-child"]);
    const identities = await filter.listConversationCandidates({ dataChains: ["antigravity"], query: "same-id-cli", threadMode: "all", limit: 5 });
    assert.deepEqual(identities.candidates.map(candidate => candidate.id).sort(), ["antigravity-cli:same-id-cli", "same-id-cli"]);
});

function listingAdapters(local: UnifiedConversationCandidate[], failLegacy = false): ConversationSourceAdapters {
    return {
        codex: { list: () => [], get: () => null },
        "claude-code": { list: () => [], get: () => null },
        windsurf: { list: () => [], resolve: () => null },
        antigravity: { list: () => {
            if (failLegacy) throw new Error("legacy metadata unavailable");
            return [{ id: "same-catalog-id", title: "Legacy title", mtime: new Date(1000), workspace: "C:/legacy" }];
        } },
        localList: async () => local,
    };
}

test("default catalog merging deduplicates exact IDs, preserves modern metadata and surfaces legacy errors", async () => {
    const local: UnifiedConversationCandidate[] = [{ id: "same-catalog-id", dataChain: "antigravity", title: "Modern title", workspace: "C:/modern",
        updatedAt: new Date(2000).toISOString(), detail: "modern", sourceKind: "antigravity-gui-jsonl" }];
    const merged = await filter.listConversationCandidates({ dataChains: ["antigravity"], adapters: listingAdapters(local) });
    assert.equal(merged.candidates.length, 1);
    assert.equal(merged.candidates[0].title, "Modern title");
    assert.equal(merged.candidates[0].workspace, "C:/modern");
    assert.deepEqual(merged.candidates[0].workspaces, ["C:/modern", "C:/legacy"]);
    const warned = await filter.listConversationCandidates({ dataChains: ["antigravity"], adapters: listingAdapters(local, true) });
    assert.equal(warned.candidates.length, 1);
    assert.equal(warned.partial, true);
    assert.ok(warned.statuses[0].diagnostics?.some(diagnostic => diagnostic.code === "AGY_LEGACY_METADATA_UNAVAILABLE"));
    const strict = await filter.listConversationCandidates({ dataChains: ["antigravity"], adapters: listingAdapters(local, true), sourceFailureMode: "fail" });
    assert.equal(strict.statuses[0].status, "failed");
});

test("explicit ls catalog does not read the modern local adapter", async () => {
    const adapters = listingAdapters([]);
    adapters.localList = async () => { throw new Error("explicit ls must not enumerate local JSONL"); };
    const listed = await filter.listConversationCandidates({ dataChains: ["antigravity"], source: "ls", adapters });
    assert.deepEqual(listed.candidates.map(candidate => candidate.id), ["same-catalog-id"]);
    assert.equal(listed.partial, false);
});

test("Record catalog helper enumerates modern and legacy sources with dates and no child promotion", async () => {
    const listed = await discovery.listAntigravityRecordConversations({ limit: 100 });
    assert.ok(listed.conversations.some(candidate => candidate.id === "catalog-parent" && candidate.workspace.toLowerCase().includes("fixture")));
    assert.ok(listed.conversations.some(candidate => candidate.id === "legacy-pb"));
    assert.ok(listed.conversations.some(candidate => candidate.id === "antigravity-cli:same-id-cli"));
    assert.ok(listed.conversations.every(candidate => candidate.id !== "catalog-child"));
    const dated = await discovery.listAntigravityRecordConversations({ before: "2021-01-01", limit: 1 });
    assert.deepEqual(dated.conversations.map(candidate => candidate.id), ["catalog-old"]);
    await assert.rejects(discovery.listAntigravityRecordConversations({ after: "invalid-date" }), /valid after\/before/u);
});

after(async () => {
    ls.__disableLsForTest();
    const { closeIsolatedSourceWorkers } = await import("../src/conversation-isolated-source.js");
    await closeIsolatedSourceWorkers();
    os.homedir = originalHome;
    for (const name of Object.keys(process.env)) if (!(name in environment)) delete process.env[name];
    Object.assign(process.env, environment);
    fs.rmSync(root, { recursive: true, force: true });
});
