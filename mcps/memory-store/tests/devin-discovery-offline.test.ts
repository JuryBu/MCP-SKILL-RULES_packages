import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-devin-discovery-offline-"));
const dataRoot = path.join(root, "data");
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(root, "sessions.db");
process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(root, "desktop");
process.env.MEMORY_STORE_WSF_SUBAGENT_JOBS_PATH = path.join(root, "absent-jobs.json");
process.env.MEMORY_STORE_WINDSURF_PB_ACTIVE_ROOT = path.join(root, "absent-pb");
process.env.MEMORY_STORE_WINDSURF_PB_IMPLICIT_ROOT = path.join(root, "absent-implicit");
fs.mkdirSync(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT);
const word = "synthetic-falcon";
const uuid = "11111111-2222-3333-4444-555555555555";
const childId = `${word}--subagent-worker`;
const marker = "Unique child transcript marker 123456";
const database = new DatabaseSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH);
database.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,working_directory TEXT,title TEXT,created_at INTEGER,last_activity_at INTEGER,main_chain_id INTEGER,workspace_dirs TEXT,hidden INTEGER,metadata TEXT);
    CREATE TABLE message_nodes(row_id INTEGER PRIMARY KEY,session_id TEXT,node_id INTEGER,parent_node_id INTEGER,chat_message TEXT,created_at INTEGER,metadata TEXT);
    CREATE TABLE tool_call_state(session_id TEXT,tool_call_id TEXT,tool_call_json TEXT,tool_call_update_json TEXT);
    CREATE TABLE subagent_heads(session_id TEXT,agent_id TEXT,chain_node_id INTEGER,updated_at INTEGER);`);
database.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)").run(word, root, "Synthetic", 1700000000, 1700000000, 2, "[]", 0, "{}");
const nodes = [
    { role: "user", content: "Find unique parent marker 123456", metadata: { is_user_input: true, extensions: { "chisel/client-message-id": "shared-1" } } },
    { role: "assistant", content: "Child requested", tool_calls: [{ id: "child-call", name: "run_subagent", arguments: { task: "Inspect synthetic" } }] },
];
for (const [index, message] of nodes.entries()) database.prepare("INSERT INTO message_nodes VALUES(?,?,?,?,?,?,?)").run(index + 1, word, index + 1, index || null, JSON.stringify(message), 1700000000 + index, "{}");
database.close();
const desktop = new DatabaseSync(path.join(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT, `${uuid}.db`));
desktop.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE messages(position INTEGER PRIMARY KEY,kind TEXT,payload TEXT);");
desktop.prepare("INSERT INTO meta VALUES('info',?)").run("{}");
const messages = [
    { kind: "user_message", content: [{ content: { type: "text", text: "Find unique parent marker 123456" }, _meta: { "cognition.ai/clientMessageId": "shared-1" } }] },
    { kind: "subagent", agentId: "worker", task: "Inspect synthetic", status: "completed", summary: "short summary", childMessages: [{ kind: "agent_message", content: [{ content: { type: "text", text: marker } }] }] },
];
for (const [position, payload] of messages.entries()) desktop.prepare("INSERT INTO messages VALUES(?,?,?)").run(position, payload.kind, JSON.stringify(payload));
desktop.close();

const { loadConversationData } = await import("../src/conversation-bridge.js");
const windsurf = await import("../src/windsurf-client.js");
const { listConversationCandidates } = await import("../src/conversation-filter.js");
const { buildDeepLocateResumePayload, runConversationDeepLocate } = await import("../src/conversation-context-locate-task.js");
const { discoverDevinChildCandidates } = await import("../src/devin-child-discovery.js");
const cache = await import("../src/conversation-source-cache.js");
const guard = await import("../src/tools/stage-guard.js");
let liveCalls = 0;
windsurf.__setWindsurfEndpointResolverForTest(async () => { liveCalls++; return []; });
try {
    const sourceBytes = fs.readFileSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH);
    for (const parentId of [word, uuid]) {
        const listed = await listConversationCandidates({ dataChains: ["windsurf"], source: "local", threadMode: "children", parentConversationId: parentId });
        assert.deepEqual(listed.candidates.map(item => item.id), [childId]);
        assert.equal(listed.partial, false);
        assert.equal(listed.candidates[0].parentConversationId, word);
        assert.ok(listed.candidates[0].aliases?.includes(`${uuid}--subagent-worker`));
    }
    assert.equal(fs.existsSync(path.join(dataRoot, "conversation-cache")), false, "metadata discovery must not materialize cache or attachments");
    const native = await listConversationCandidates({ dataChains: ["windsurf"], threadMode: "children", parentConversationId: uuid });
    assert.deepEqual(native.candidates.map(item => item.id), [childId]);
    const located = await runConversationDeepLocate(buildDeepLocateResumePayload({ query: marker, dataChains: ["windsurf"], source: "local", threadMode: "children", parentConversationId: uuid, mode: "exact" }));
    assert.equal(located.status, "found");
    assert.ok(located.hits.some(hit => hit.conversationId === childId && hit.role === "assistant"));
    const explicitChild = await runConversationDeepLocate(buildDeepLocateResumePayload({ query: marker, dataChains: ["windsurf"], source: "local", conversationIds: [`${uuid}--subagent-worker`], mode: "exact" }));
    assert.ok(explicitChild.hits.some(hit => hit.conversationId === childId));
    assert.deepEqual(fs.readFileSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH), sourceBytes);
    console.log("PASS native child discovery: parent UUID/word, local/auto, deep locate, explicit alias, no materialization or source mutation");
    const hiddenWriter = new DatabaseSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH);
    hiddenWriter.exec("UPDATE sessions SET hidden=1");
    const hiddenChild = await listConversationCandidates({ dataChains: ["windsurf"], source: "local", threadMode: "all", conversationIds: [`${uuid}--subagent-worker`] });
    assert.deepEqual(hiddenChild.candidates.map(item => item.id), [childId]);
    hiddenWriter.exec("UPDATE sessions SET hidden=0");
    hiddenWriter.close();

    const parent = native.candidates[0];
    let parentReads = 0;
    const bounded = await discoverDevinChildCandidates(Array.from({ length: 10 }, (_, index) => ({ ...parent, id: `parent-${index}`, isChildThread: false })), {
        readRaw: async (_id, budget) => { parentReads++; assert.equal(budget.maxBytes, 128 * 1024 * 1024 / 8); return null; },
    });
    assert.equal(parentReads, 8);
    assert.ok(bounded.warnings.some(warning => warning.startsWith("devin_child_parent_budget")));
    const cancelled = await discoverDevinChildCandidates([{ ...parent, id: word, isChildThread: false }], { isCancelled: () => true, readRaw: async () => { throw new Error("must not read"); } });
    assert.deepEqual(cancelled.candidates, []);
    assert.ok(cancelled.warnings.includes("devin_child_read_budget"));
    const failedOld = await listConversationCandidates({ dataChains: ["windsurf"], contextProbe: "old marker", adapters: {
        windsurf: { list: () => [{ id: "old", cascadeId: "old", summary: "old", stepCount: 1, discoveryWarnings: ["DEVIN_DISCOVERY_UNAVAILABLE: legacy candidates only"] }], resolve: () => "old" },
    } as any, contextAdapters: { readRounds: async () => ({ rounds: [{ roundIndex: 1, startStep: 1, endStep: 1, userMessage: "old marker", mediaAttachments: [], aiResponses: [], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [] }] }) } });
    assert.equal(failedOld.partial, true);
    assert.equal(failedOld.contextLocate?.resolution, "unverified");
    assert.ok(failedOld.statuses[0].warnings?.some(warning => warning.startsWith("DEVIN_DISCOVERY_UNAVAILABLE")));
    console.log("PASS discovery failure/cancellation/parent budget remains partial and preserves legacy hits");

    const loaded = await loadConversationData("windsurf", uuid, { source: "local" });
    assert.ok(loaded?.cacheGeneration);
    const taskFile = path.join(root, "Task.md");
    fs.writeFileSync(taskFile, "# Offline guard\n- [ ] Synthetic check\n", "utf8");
    const guardOptions = { dataChain: "windsurf" as const, modelChain: "codex" as const, stageId: "offline guard" };
    assert.match(JSON.stringify(await guard.runStageGuard({ ...guardOptions, action: "start", conversationId: uuid, startRound: 1, taskFiles: [taskFile] })), /已激活/u);
    process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(root, "absent.db");
    process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(root, "absent-desktop");
    liveCalls = 0;
    windsurf.__resetWindsurfEndpointCacheForTest();
    windsurf.__setWindsurfEndpointResolverForTest(async () => { liveCalls++; throw new Error("offline query must not access LS"); });
    const cachePayload = buildDeepLocateResumePayload({ query: "Find unique parent marker 123456", dataChains: ["windsurf"], source: "cache", conversationIds: [uuid], mode: "exact" });
    const offline = await runConversationDeepLocate(cachePayload);
    assert.ok(offline.hits.some(hit => hit.conversationId === word));
    const cacheList = await listConversationCandidates({ dataChains: ["windsurf"], source: "cache", threadMode: "all" });
    assert.ok(cacheList.candidates.some(item => item.id === word));
    assert.ok(cacheList.candidates.some(item => item.id === childId));
    const aliasList = await listConversationCandidates({ dataChains: ["windsurf"], source: "cache", conversationIds: [uuid] });
    assert.equal(aliasList.candidates[0].cacheGeneration, loaded.cacheGeneration);
    assert.equal(liveCalls, 0);
    const tiny = await listConversationCandidates({ dataChains: ["windsurf"], source: "cache", maxBytes: 1 });
    assert.equal(tiny.partial, true);
    guard.__testSetStageGuardConversationIdResolver(async () => { throw new Error("offline state lookup must not resolve online"); });
    assert.match(JSON.stringify(await guard.runStageGuard({ ...guardOptions, action: "status", conversationId: uuid })), /活跃/u);
    assert.match(JSON.stringify(await guard.runStageGuard({ ...guardOptions, action: "status", conversationId: word })), /活跃/u);
    assert.match(JSON.stringify(await guard.runStageGuard({ ...guardOptions, action: "cancel", conversationId: uuid })), /已取消/u);
    assert.equal(liveCalls, 0);
    console.log("PASS cache-only explicit alias/enumeration/generation and offline Guard status/cancel: zero LS probes");

    for (const [source, host] of [["codex:link=summary", "codex"], ["claude-code:logical=off", "claude-code"], ["antigravity", "antigravity"], ["dsh", "dsh"]] as const) {
        const id = `${host}-cached`;
        await cache.readOrBuild({ key: { source, conversationId: id }, fingerprint: { revision: "synthetic" }, build: () => ({ snapshot: { conversationId: id, chainUsed: host }, rounds: loaded.rounds }) });
        const result = await runConversationDeepLocate(buildDeepLocateResumePayload({ query: "Find unique parent marker 123456", dataChains: [host], source: "cache", conversationIds: [id], mode: "exact" }));
        assert.ok(result.hits.some(hit => hit.conversationId === id && hit.dataChain === host));
    }
    assert.equal(liveCalls, 0);
    console.log("PASS all five source cache-only discovery/read does not depend on raw directories");
} finally {
    guard.__testSetStageGuardConversationIdResolver();
    windsurf.__setWindsurfEndpointResolverForTest(null);
    windsurf.__resetWindsurfEndpointCacheForTest();
    fs.rmSync(root, { recursive: true, force: true });
}
