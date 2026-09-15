import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationRound } from "../src/trajectory.js";
import type { ConversationSource, ConversationSourceAdapters, UnifiedConversationCandidate } from "../src/conversation-filter.js";
import type { ConversationContextLocateAdapters } from "../src/conversation-context-locate.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-context-locate-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_RECORD_AUTO_UPDATE = "false";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(temporary, "sessions.db");
process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(temporary, "desktop");
process.env.MEMORY_STORE_WINDSURF_PB_ACTIVE_ROOT = path.join(temporary, "pb");
process.env.MEMORY_STORE_WINDSURF_PB_IMPLICIT_ROOT = path.join(temporary, "implicit");
const { locateConversationContext } = await import("../src/conversation-context-locate.js");
const { defaultContextLocateAdapters } = await import("../src/conversation-context-locate-adapters.js");
const { listConversationCandidates, candidateFromDevinConversation } = await import("../src/conversation-filter.js");
const { buildDeepLocateResumePayload, parseDeepLocateResumePayload, runConversationDeepLocate } = await import("../src/conversation-context-locate-task.js");
const { registerConversation, formatDeepLocateResult } = await import("../src/tools/conversation.js");
const { getBackgroundTaskRecoveryHandler, getBackgroundTask, waitForBackgroundTask } = await import("../src/background-tasks.js");

const marker = "Unique Context Needle with MixedCASE";
const workspace = path.join(temporary, "workspace");
const sources: ConversationSource[] = ["codex", "claude-code", "antigravity", "windsurf", "dsh"];
function candidate(source: ConversationSource, id = `${source}-main`): UnifiedConversationCandidate {
    return { id, dataChain: source, title: "Context fixture", workspace, updatedAt: "2026-01-01T00:00:00Z", detail: "" };
}
function round(text: string, roundIndex = 1): ConversationRound {
    return { roundIndex, startStep: 1, endStep: 3, userMessage: text,
        userMessages: [{ text, rawRole: "user", stepIndex: 1 }], mediaAttachments: [],
        aiResponses: [], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [] };
}
const fixtureCandidates = sources.map(source => candidate(source));
fixtureCandidates[3] = { ...candidate("windsurf"), aliases: ["gentle-falcon", "00000000-0000-0000-0000-000000000001"], uuid: "00000000-0000-0000-0000-000000000001", sessionId: "gentle-falcon", sourceKind: "devin-cli" };
const readIds: string[] = [];
const syntheticReaders: ConversationContextLocateAdapters = {
    readRounds: async (item, budget) => {
        assert.ok(budget.maxBytes > 0);
        readIds.push(item.id);
        return { rounds: [round(marker)], filePath: "synthetic.db", freshness: "fresh" };
    },
};
const adapters: ConversationSourceAdapters = {
    codex: { list: () => [{ id: "codex-main", title: "C", cwd: workspace }] as any, get: id => ({ id, cwd: workspace, title: "C" }) as any },
    "claude-code": { list: () => [{ id: "claude-code-main", title: "CC", cwd: workspace }] as any, get: id => ({ id, cwd: workspace, title: "CC" }) as any },
    antigravity: { list: () => [{ id: "antigravity-main", workspace, mtime: new Date(), title: "AG" }] },
    windsurf: { list: () => [{ ...fixtureCandidates[3], cwd: workspace, workspaceUris: [workspace], summary: "D", cascadeId: "windsurf-main", stepCount: 1 }] as any, resolve: () => "windsurf-main" },
    dsh: { list: () => [{ id: "dsh-main", titleBestEffort: "DSH", header: { cwd: workspace }, provenance: { sourceMtimeMs: Date.now(), sourceSizeBytes: 123, format: "jsonl" } }] as any, get: () => null },
    localList: async source => [fixtureCandidates.find(item => item.dataChain === source)!],
};

try {
    const all = await locateConversationContext(fixtureCandidates, marker, { adapters: syntheticReaders, maxFiles: 10, maxHits: 30 });
    assert.deepEqual(new Set(all.hits.map(hit => hit.dataChain)), new Set(sources));
    assert.equal(all.resolution, "ambiguous");
    assert.equal(all.hits[3].sessionId, "gentle-falcon");
    assert.ok(all.hits.every(hit => hit.role === "user" && hit.byteOffset === undefined && hit.sourcePosition.kind === "round"));
    assert.ok(all.hits.every(hit => hit.snippet.includes("MixedCASE")));
    assert.doesNotMatch(formatDeepLocateResult(all, marker), /offset: undefined/u);

    const bounded = await locateConversationContext(fixtureCandidates, marker, { adapters: syntheticReaders, maxFiles: 1 });
    assert.equal(bounded.hits.length, 1);
    assert.equal(bounded.resolution, "unverified");
    assert.equal(bounded.status, "partial_found_scanning");
    const byteBounded = await locateConversationContext([candidate("windsurf")], marker, { adapters: syntheticReaders, maxBytes: 2 });
    assert.equal(byteBounded.hits.length, 0);
    assert.equal(byteBounded.scannedBytes, 0);
    assert.equal(byteBounded.truncated, true);
    const hitBounded = await locateConversationContext(fixtureCandidates, marker, { adapters: syntheticReaders, maxHits: 1 });
    assert.equal(hitBounded.resolution, "unverified");
    const stopped = await locateConversationContext(fixtureCandidates, marker, { adapters: syntheticReaders, isCancelled: () => true });
    assert.equal(stopped.status, "cancelled");
    assert.equal(stopped.scannedFiles, 0);
    let shouldCancel = false;
    const during = await locateConversationContext(fixtureCandidates, marker, {
        adapters: { readRounds: async () => { shouldCancel = true; return { rounds: [round(marker)] }; } },
        isCancelled: () => shouldCancel,
    });
    assert.equal(during.status, "cancelled");
    assert.equal(during.hits.length, 0);
    const slow = await locateConversationContext([candidate("dsh")], marker, {
        deadlineMs: 1, adapters: { readRounds: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return { rounds: [round(marker)] }; } },
    });
    assert.equal(slow.truncated, true);
    assert.equal(slow.hits.length, 0);
    const roundBounded = await locateConversationContext([candidate("antigravity")], marker, {
        maxRounds: 1, adapters: { readRounds: async () => ({ rounds: [round("unrelated"), round(marker, 2)] }) },
    });
    assert.equal(roundBounded.hits.length, 0);
    assert.equal(roundBounded.truncated, true);

    const roles = round("visible question");
    roles.semanticEvents = [{ semanticRole: "system", rawRole: "system", text: "hidden rules marker" }];
    roles.aiResponses = [{ stepIndex: 2, response: marker, thinking: "", toolCalls: [] }];
    roles.subagentSummaries = [{ threadId: "child-one", nickname: "worker", rawRole: "subagent", summary: marker }];
    const roleResult = await locateConversationContext([candidate("windsurf")], marker, { adapters: { readRounds: async () => ({ rounds: [roles] }) } });
    assert.deepEqual(roleResult.hits.map(hit => hit.role), ["assistant", "subagent"]);
    assert.equal(roleResult.hits[1].sourcePosition.childConversationId, "child-one");
    const hidden = await locateConversationContext([candidate("windsurf")], "hidden rules marker", { adapters: { readRounds: async () => ({ rounds: [roles] }) } });
    assert.equal(hidden.hits.length, 0);
    const image = round('safe image {"base64_data":"PRIVATEBASE64PAYLOAD"} data:image/png;base64,QUJDREVGRw==');
    const imageResult = await locateConversationContext([candidate("windsurf")], "safe image", { adapters: { readRounds: async () => ({ rounds: [image] }) } });
    assert.doesNotMatch(imageResult.hits[0].snippet, /PRIVATEBASE64PAYLOAD|QUJDREVGRw/u);

    for (const source of sources) {
        readIds.length = 0;
        const result = await listConversationCandidates({ dataChains: [source === "windsurf" ? "wsf" : source], contextProbe: marker, workspaces: [workspace], workspaceMode: "exact", adapters, contextAdapters: syntheticReaders });
        assert.equal(result.candidates.length, 1, `${source} should support contextProbe in workspace list`);
        assert.deepEqual(result.candidates.map(item => item.dataChain), [source]);
        assert.equal(readIds.length, 1);
    }
    const local = await listConversationCandidates({ dataChains: ["wsf"], source: "local", contextProbe: marker, workspaces: [workspace], adapters, contextAdapters: syntheticReaders });
    assert.equal(local.candidates[0].sessionId, "gentle-falcon");
    const multi = await listConversationCandidates({ dataChains: ["codex", "wsf", "dsh"], contextProbe: marker, query: "title not found", adapters, contextAdapters: syntheticReaders });
    assert.equal(multi.candidates.length, 3, "contextProbe is independent of an unmatched title query");
    const excluded = await listConversationCandidates({ dataChains: ["wsf"], contextProbe: marker, workspaces: [path.join(temporary, "elsewhere")], workspaceMode: "exact", adapters, contextAdapters: syntheticReaders });
    assert.equal(excluded.candidates.length, 0);
    const aliasQuery = await listConversationCandidates({ dataChains: ["wsf"], query: "gentle-falcon", adapters });
    assert.equal(aliasQuery.candidates[0].uuid, fixtureCandidates[3].uuid);
    const failed = await listConversationCandidates({ dataChains: ["wsf", "dsh"], contextProbe: marker, adapters: { ...adapters, dsh: { list: () => { throw new Error("offline"); }, get: () => null } }, contextAdapters: syntheticReaders });
    assert.equal(failed.contextLocate?.resolution, "unverified");

    const parent = { ...fixtureCandidates[3], id: "parent", aliases: ["parent-alias"] };
    const child = { ...fixtureCandidates[3], id: "child", aliases: [], isChildThread: true, parentConversationId: "parent" };
    const siblings = { ...child, id: "sibling" };
    const childAdapters = { ...adapters, localList: async () => [parent, child, siblings] };
    const childReader: ConversationContextLocateAdapters = { readRounds: async item => ({ rounds: [round(item.id === "child" ? marker : "unrelated")] }) };
    const childOnly = await listConversationCandidates({ dataChains: ["wsf"], source: "local", contextProbe: marker, threadMode: "children", parentConversationId: "parent-alias", adapters: childAdapters, contextAdapters: childReader });
    assert.deepEqual(childOnly.candidates.map(item => item.id), ["child"]);
    const promoted = await listConversationCandidates({ dataChains: ["wsf"], source: "local", contextProbe: marker, adapters: childAdapters, contextAdapters: childReader });
    assert.equal(promoted.candidates[0].id, "parent");
    assert.match(promoted.candidates[0].contextProbe![0], /child-hit:child/u);

    const codexPath = path.join(temporary, "codex.jsonl");
    const claudePath = path.join(temporary, "claude.jsonl");
    fs.writeFileSync(codexPath, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ text: marker }] } }) + "\n", "utf8");
    fs.writeFileSync(claudePath, JSON.stringify({ type: "user", message: { role: "user", content: marker } }) + "\n", "utf8");
    const streams = [{ ...candidate("codex"), sourcePath: codexPath }, { ...candidate("claude-code"), sourcePath: claudePath }];
    const onlyStreams: ConversationContextLocateAdapters = { ...defaultContextLocateAdapters, readRounds: async () => { throw new Error("JSONL must never fall back to full cache scan"); } };
    const streamResult = await locateConversationContext(streams, marker, { adapters: onlyStreams, maxHits: 10 });
    assert.equal(streamResult.hits.length, 2);
    assert.ok(streamResult.hits.every(hit => typeof hit.byteOffset === "number" && hit.sourcePosition.kind === "jsonl"));
    const streamProbe = await locateConversationContext(streams, marker, { adapters: onlyStreams, probe: true });
    assert.equal(streamProbe.hits.length, 2);
    const lowStream = await locateConversationContext(streams, marker, { adapters: onlyStreams, maxBytes: 1 });
    assert.equal(lowStream.scannedBytes, 0);
    assert.equal(lowStream.truncated, true);

    const payload = buildDeepLocateResumePayload({ query: marker, dataChains: ["wsf", "dsh"], source: "local", workspaces: [workspace], workspaceMode: "exact", mode: "exact", conversationIds: ["gentle-falcon", "dsh-main"], maxFiles: 8 });
    assert.deepEqual(parseDeepLocateResumePayload(JSON.parse(JSON.stringify(payload))), payload);
    assert.deepEqual(parseDeepLocateResumePayload({ version: 1, query: marker, dataChain: "codex", mode: "exact", maxFiles: 2, maxBytes: 100_000, maxHits: 4 }).dataChains, ["codex"]);
    assert.throws(() => parseDeepLocateResumePayload({ ...payload, dataChains: ["devin"] }), /dataChains/u);
    assert.throws(() => parseDeepLocateResumePayload({ ...payload, maxBytes: -1 }), /maxBytes/u);
    let listedOptions: any;
    const deep = await runConversationDeepLocate(payload, {
        adapters: syntheticReaders,
        listCandidates: async options => { listedOptions = options; return listConversationCandidates({ ...options, adapters }); },
    });
    assert.deepEqual(listedOptions.workspaces, [workspace]);
    assert.equal(listedOptions.source, "local");
    assert.equal(deep.hits.length, 1, "DSH explicit missing ID should not expand to unrelated sessions");
    assert.equal(deep.resolution, "unverified");
    assert.ok(deep.warnings.some(warning => warning.includes("dsh-main")));
    assert.ok(getBackgroundTaskRecoveryHandler("conversation-deep-locate"));

    let handler: (params: any) => Promise<any> = async () => { throw new Error("handler not registered"); };
    const toolLists: any[] = [];
    const fakeServer = { tool: (_name: string, _description: string, _schema: any, callback: typeof handler) => { handler = callback; } };
    registerConversation(fakeServer as any, {
        listCandidates: async options => { toolLists.push(options); return listConversationCandidates({ ...options, adapters, contextAdapters: syntheticReaders }); },
        runDeepLocate: async (_payload, options) => locateConversationContext([fixtureCandidates[3]], marker, { ...options, adapters: syntheticReaders }),
    });
    for (const params of [
        { dataChain: "wsf", source: "local" },
        { dataChains: ["codex", "wsf"], workspaces: [workspace] },
        { dataChain: "dsh" },
    ]) {
        const response = await handler({ action: "list", contextProbe: marker, ...params });
        assert.match(response.content[0].text, /contextProbe/u);
        assert.equal(toolLists.at(-1).contextProbe, marker);
    }
    assert.equal(toolLists[0].source, "local");
    const background = await handler({ action: "deep_locate", dataChains: ["wsf", "dsh"], workspaces: [workspace], query: marker });
    const taskId = background.content[0].text.match(/taskId: ([^\s]+)/u)?.[1];
    assert.ok(taskId);
    await waitForBackgroundTask(taskId, 2);
    assert.equal(getBackgroundTask(taskId)?.status, "done");
    assert.deepEqual((getBackgroundTask(taskId)?.resumePayload as any).dataChains, ["windsurf", "dsh"]);
    assert.deepEqual((getBackgroundTask(taskId)?.resumePayload as any).workspaces, [workspace]);

    const { DatabaseSync } = await import("node:sqlite");
    const cli = new DatabaseSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH);
    cli.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, main_chain_id INTEGER, working_directory TEXT, title TEXT); CREATE TABLE message_nodes(node_id INTEGER PRIMARY KEY, parent_node_id INTEGER, session_id TEXT, chat_message TEXT, metadata TEXT, created_at INTEGER)");
    cli.prepare("INSERT INTO sessions VALUES (?,?,?,?)").run("gentle-falcon", 2, workspace, "SQLite locate fixture");
    const insert = cli.prepare("INSERT INTO message_nodes VALUES (?,?,?,?,?,?)");
    insert.run(1, null, "gentle-falcon", JSON.stringify({ role: "user", content: "fixture question", metadata: { extensions: { "chisel/client-message-id": "client-message-1" } } }), "{}", 1_700_000_000);
    insert.run(2, 1, "gentle-falcon", JSON.stringify({ role: "assistant", content: marker }), "{}", 1_700_000_001);
    cli.exec("CREATE TABLE subagent_heads(session_id TEXT, agent_id TEXT, chain_node_id INTEGER, updated_at INTEGER)");
    insert.run(3, null, "gentle-falcon", JSON.stringify({ role: "assistant", content: "Child Context Marker 123456" }), "{}", 1_700_000_002);
    cli.prepare("INSERT INTO subagent_heads VALUES (?,?,?,?)").run("gentle-falcon", "worker", 3, 1_700_000_002);
    cli.close();
    fs.mkdirSync(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT);
    const uuid = "00000000-0000-0000-0000-000000000001";
    const desktop = new DatabaseSync(path.join(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT, `${uuid}.db`));
    desktop.exec("CREATE TABLE meta(key TEXT, value TEXT); CREATE TABLE messages(position INTEGER, kind TEXT, payload TEXT)");
    desktop.prepare("INSERT INTO messages VALUES (?,?,?)").run(1, "user_message", JSON.stringify({ content: [{ content: { type: "text", text: "fixture question" }, _meta: { "cognition.ai/clientMessageId": "client-message-1" } }] }));
    desktop.close();
    const before = fs.readFileSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH);
    const actual = await listConversationCandidates({ dataChains: ["wsf"], source: "local", contextProbe: marker, workspaces: [workspace], workspaceMode: "exact", maxBytes: 4 * 1024 * 1024 });
    assert.equal(actual.candidates.length, 1, JSON.stringify(actual));
    assert.equal(actual.candidates[0].sessionId, "gentle-falcon");
    assert.equal(actual.candidates[0].uuid, uuid);
    assert.ok(actual.candidates[0].contextProbe?.some(note => note.includes("assistant")));
    assert.deepEqual(fs.readFileSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH), before, "locate must not mutate the SQLite input");
    fs.mkdirSync(process.env.MEMORY_STORE_WINDSURF_PB_ACTIVE_ROOT);
    fs.writeFileSync(path.join(process.env.MEMORY_STORE_WINDSURF_PB_ACTIVE_ROOT, "legacy-cascade.pb"), "synthetic metadata-only PB", "utf8");
    const mixedLocal = await listConversationCandidates({ dataChains: ["wsf"], source: "local" });
    assert.deepEqual(new Set(mixedLocal.candidates.map(item => item.sourceKind)), new Set(["cascade-pb", "devin-cli"]));
    const actualDeep = await runConversationDeepLocate(buildDeepLocateResumePayload({ query: marker, dataChains: ["wsf"], source: "local", mode: "exact", conversationIds: [uuid] }));
    assert.equal(actualDeep.hits.length, 1);
    assert.equal(actualDeep.hits[0].sessionId, "gentle-falcon");
    assert.equal(actualDeep.hits[0].byteOffset, undefined);
    const childDeep = await runConversationDeepLocate(buildDeepLocateResumePayload({ query: "Child Context Marker 123456", dataChains: ["wsf"], source: "local", mode: "exact", conversationIds: [`${uuid}--subagent-worker`] }));
    assert.equal(childDeep.hits.length, 1, JSON.stringify(childDeep));
    assert.equal(childDeep.hits[0].conversationId, "gentle-falcon--subagent-worker");
    assert.equal(childDeep.hits[0].isChildThread, true);
    console.log("PASS context-locate: five sources, scoped/local/DSH list, aliases, roles, streaming, budgets, cancellation, ambiguity, background/resume");
    console.log("PASS real temporary SQLite -> local list -> bridge cache -> context/deep locate; UUID/session alias and old PB coexist; input unchanged");
} finally {
    const resolved = path.resolve(temporary);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
}
