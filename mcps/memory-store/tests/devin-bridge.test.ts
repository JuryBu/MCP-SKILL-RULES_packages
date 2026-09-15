import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-devin-bridge-"));
const originalEnvironment = { ...process.env };
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_WSF_SUBAGENT_JOBS_PATH = path.join(root, "absent-jobs.json");
process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(root, "sessions.db");
process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(root, "desktop");
fs.mkdirSync(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT);
const identifier = "sample-falcon";
const alias = "11111111-2222-3333-4444-555555555555";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const database = new DatabaseSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH);
database.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE sessions(id TEXT PRIMARY KEY, working_directory TEXT, title TEXT, created_at INTEGER, last_activity_at INTEGER, main_chain_id INTEGER, workspace_dirs TEXT, hidden INTEGER, metadata TEXT);
    CREATE TABLE message_nodes(row_id INTEGER PRIMARY KEY, session_id TEXT, node_id INTEGER, parent_node_id INTEGER, chat_message TEXT, created_at INTEGER, metadata TEXT);
    CREATE TABLE tool_call_state(session_id TEXT, tool_call_id TEXT, tool_call_json TEXT, tool_call_update_json TEXT);
    CREATE TABLE subagent_heads(session_id TEXT, agent_id TEXT, chain_node_id INTEGER, updated_at INTEGER);`);
database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(identifier, root, "Synthetic source", 1700000000, 1700000010, 4, "[]", 0, "{}");
const messages = [
    { role: "user", content: "First real user input", metadata: { created_at: "2026-01-01T01:02:03Z", is_user_input: true, extensions: { "chisel/client-message-id": "shared-1" } }, images: [{ width: 1, height: 1, mime_type: "image/png", base64_data: png, source_path: path.join(root, "expired-original.png") }] },
    { role: "assistant", content: "First visible reply" },
    { role: "user", content: "Inspect with a subagent", metadata: { is_user_input: true, extensions: { "chisel/client-message-id": "shared-2" } } },
    { role: "assistant", content: "Requested child", tool_calls: [{ id: "child-call", name: "run_subagent", arguments: { task: "inspect fixture" } }] },
];
for (const [index, message] of messages.entries()) database.prepare("INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?, ?, ?)").run(index + 1, identifier, index + 1, index || null, JSON.stringify(message), 1700000000 + index, null);
database.prepare("INSERT INTO tool_call_state VALUES (?, ?, ?, ?)").run(identifier, "child-call", JSON.stringify({ toolCallId: "child-call", title: "Inspect fixture" }), JSON.stringify({ status: "completed", content: [{ type: "text", text: "Child finished" }] }));
const desktop = new DatabaseSync(path.join(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT, `${alias}.db`));
desktop.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE messages(position INTEGER PRIMARY KEY,kind TEXT,payload TEXT);");
desktop.prepare("INSERT INTO meta VALUES ('info',?)").run(JSON.stringify({ title: "Synthetic source" }));
const desktopMessages = [
    { kind: "user_message", content: [{ content: { type: "text", text: "First real user input" }, _meta: { "cognition.ai/clientMessageId": "shared-1" } }] },
    { kind: "subagent", agentId: "child-one", title: "Inspector", task: "inspect fixture", status: "completed", updatedAt: "2026-01-01T00:00:00Z", summary: "short child result", childMessages: [{ kind: "agent_message", content: [{ content: { type: "text", text: "Full child transcript marker" } }] }] },
];
for (const [position, payload] of desktopMessages.entries()) desktop.prepare("INSERT INTO messages VALUES (?, ?, ?)").run(position, payload.kind, JSON.stringify(payload));
desktop.close();

try {
    const { loadConversationData } = await import("../src/conversation-bridge.ts");
    const { listRecentWindsurfThreads, __setWindsurfEndpointResolverForTest } = await import("../src/windsurf-client.ts");
    const { readDevinConversation, DEVIN_NORMALIZATION_VERSION } = await import("../src/devin-conversation.ts");
    __setWindsurfEndpointResolverForTest(async () => []);
    const list = await listRecentWindsurfThreads(20);
    assert.equal(list.length, 1, JSON.stringify(list.map(item => ({ id: item.id, sourceKind: item.sourceKind, partial: item.partial }))));
    assert.equal(list[0].id, identifier);
    assert.equal(list[0].uuid, alias);
    assert.equal(list[0].sourceKind, "devin-cli");
    const pure = await readDevinConversation(identifier, { materializeAttachments: false });
    const pureImage = pure?.rounds[0].attachments?.[0];
    assert.ok(pureImage?.dataUrl?.includes(png));
    assert.equal(pureImage.tempPath, undefined);
    assert.equal(pureImage.exists, false);
    assert.equal(fs.existsSync(pureImage.originalPath!), false);
    const fetched = await loadConversationData("windsurf", alias, { source: "local" });
    assert.ok(fetched);
    assert.equal(fetched.conversationId, identifier);
    assert.equal(fetched.rounds.length, 2);
    assert.equal(fetched.windsurfData?.partial, false);
    const image = fetched.rounds[0].attachments?.[0];
    assert.ok(image?.tempPath && fs.existsSync(image.tempPath));
    assert.equal(image.dataUrl, undefined);
    assert.equal(fs.existsSync(image.originalPath!), false);
    assert.equal(image.exists, true);
    assert.doesNotMatch(JSON.stringify(fetched), new RegExp(png, "u"));
    const same = await loadConversationData("windsurf", identifier, { source: "auto" });
    assert.equal(same?.cacheGeneration, fetched.cacheGeneration);
    assert.deepEqual(same?.rounds, fetched.rounds);
    const expanded = await loadConversationData("windsurf", alias, { source: "local", link: "expand_children" });
    assert.notEqual(expanded?.cacheKey?.source, fetched.cacheKey?.source);
    assert.match(expanded?.rounds[1].subagentSummaries[0].summary || "", /Full child transcript marker/u);
    assert.equal(fetched.rounds[1].subagentSummaries[0].summary, "short child result");
    const child = await readDevinConversation(`${alias}--subagent-child-one`);
    assert.equal(child?.raw.summary.canonicalId, `${identifier}--subagent-child-one`);
    const childAliases = [`${identifier}--subagent-child-one`, `${alias}--subagent-child-one`];
    assert.deepEqual(child?.raw.summary.aliases, childAliases);
    const canonicalChild = await readDevinConversation(childAliases[0]);
    assert.deepEqual(canonicalChild?.raw.summary.aliases, childAliases);
    const { discoverDevinChildCandidates } = await import("../src/devin-child-discovery.ts");
    const listedChildren = await discoverDevinChildCandidates([{ id: identifier, aliases: [identifier, alias], dataChain: "windsurf", sourceKind: "devin-cli", title: "Synthetic source", workspace: root, updatedAt: "" }], {});
    assert.deepEqual(listedChildren.candidates[0]?.aliases, childAliases);
    const childFetched = await loadConversationData("windsurf", childAliases[0], { source: "local" });
    assert.ok(childFetched?.windsurfData && childFetched.cacheKey && childFetched.cacheGeneration);
    assert.equal(childFetched.windsurfData.normalizationVersion, DEVIN_NORMALIZATION_VERSION);
    assert.equal(DEVIN_NORMALIZATION_VERSION, 2);
    const cache = await import("../src/conversation-source-cache.ts");
    const previousChildCache = cache.readCachedConversationSourceCache<any>({ key: childFetched.cacheKey });
    assert.ok(previousChildCache);
    const oldChildSnapshot = structuredClone(previousChildCache.snapshot);
    oldChildSnapshot.windsurfData.normalizationVersion = 1;
    oldChildSnapshot.windsurfData.thread.aliases = [childAliases[0], childAliases[0]];
    const legacyChildCache = await cache.readOrBuildConversationSourceCache({
        key: childFetched.cacheKey, fingerprint: previousChildCache.fingerprint, refresh: true,
        build: () => ({ snapshot: oldChildSnapshot, rounds: childFetched.rounds }),
    });
    const offlineOldChild = await loadConversationData("windsurf", childAliases[0], { source: "cache" });
    assert.equal(offlineOldChild?.cacheGeneration, legacyChildCache.generation);
    assert.equal(offlineOldChild?.windsurfData?.normalizationVersion, 1);
    assert.deepEqual(offlineOldChild?.windsurfData?.thread.aliases, [childAliases[0], childAliases[0]]);
    const refreshedChild = await loadConversationData("windsurf", childAliases[0], { source: "local" });
    assert.notEqual(refreshedChild?.cacheGeneration, legacyChildCache.generation);
    assert.equal(refreshedChild?.windsurfData?.normalizationVersion, DEVIN_NORMALIZATION_VERSION);
    assert.deepEqual(refreshedChild?.windsurfData?.thread.aliases, childAliases);
    assert.match(child?.rounds[0].aiResponses[0].response || "", /Full child transcript marker/u);
    await assert.rejects(() => loadConversationData("windsurf", alias, { source: "ls" }), /没有 Cascade LS|不支持 source=ls/u);
    database.prepare("UPDATE tool_call_state SET tool_call_update_json=?").run(JSON.stringify({ status: "completed", content: [{ type: "text", text: "Updated in place" }] }));
    const changed = await loadConversationData("windsurf", alias, { source: "local" });
    assert.notEqual(changed?.cacheGeneration, fetched.cacheGeneration);
    assert.match(changed?.rounds[1].toolCalls[0].resultFull || "", /Updated in place/u);
    const secondAlias = "11111111-2222-3333-4444-666666666666";
    const secondPath = path.join(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT!, `${secondAlias}.db`);
    fs.copyFileSync(path.join(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT!, `${alias}.db`), secondPath);
    const newerDesktop = new DatabaseSync(secondPath);
    const newerChild = { ...desktopMessages[1], updatedAt: "2026-01-02T00:00:00Z", childMessages: [{ kind: "agent_message", content: [{ content: { type: "text", text: "NEW_CHILD_BODY" } }] }] };
    newerDesktop.prepare("UPDATE messages SET payload=? WHERE position=1").run(JSON.stringify(newerChild));
    newerDesktop.close();
    const parentNew = await loadConversationData("windsurf", identifier, { source: "local", link: "expand_children" });
    const childNew = await readDevinConversation(`${secondAlias}--subagent-child-one`);
    assert.deepEqual(childNew?.raw.summary.aliases, [...childAliases, `${secondAlias}--subagent-child-one`]);
    assert.match(parentNew?.rounds[1].subagentSummaries[0].summary || "", /NEW_CHILD_BODY/u);
    assert.match(childNew?.rounds[0].aiResponses[0].response || "", /NEW_CHILD_BODY/u);
    assert.equal(parentNew?.rounds.flatMap(round => round.subagentSummaries).length, 1);
    database.prepare("INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?, ?, ?)").run(10, identifier, 10, null, JSON.stringify({ role: "user", content: "inspect fixture" }), 1700000020, "{}");
    database.prepare("INSERT INTO message_nodes VALUES (?, ?, ?, ?, ?, ?, ?)").run(11, identifier, 11, 10, JSON.stringify({ role: "assistant", content: "AUTHORITATIVE_CLI_CHILD" }), 1700000021, "{}");
    database.prepare("INSERT INTO subagent_heads VALUES (?, ?, ?, ?)").run(identifier, "child-one", 11, 1700000021);
    const authoritative = await readDevinConversation(`${alias}--subagent-child-one`);
    assert.match(authoritative?.rounds[0].aiResponses[0].response || "", /AUTHORITATIVE_CLI_CHILD/u);
    assert.equal(authoritative?.raw.partial, false);
    const aheadDesktop = new DatabaseSync(secondPath);
    aheadDesktop.prepare("INSERT INTO messages VALUES (2,'user_message',?)").run(JSON.stringify({ kind: "user_message", content: [{ content: { type: "text", text: "NOT_YET_IN_CLI" }, _meta: { "cognition.ai/clientMessageId": "missing-in-cli" } }] }));
    aheadDesktop.close();
    const { readDevinRawConversation } = await import("../src/devin-sqlite.ts");
    const ahead = await readDevinRawConversation(identifier);
    assert.equal(ahead?.partial, true);
    assert.ok(ahead?.warnings.includes("DEVIN_DESKTOP_USER_HISTORY_NOT_IN_CLI"));
    process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(root, "absent.db");
    process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(root, "absent-desktop");
    const offlineAlias = await loadConversationData("windsurf", alias, { source: "cache" });
    assert.equal(offlineAlias?.conversationId, identifier);
    assert.equal(offlineAlias?.cacheGeneration, changed?.cacheGeneration);
    console.log("PASS Devin bridge: aliases/generation, pure read skips attachment materialization while default fetch preserves images, revision, child expansion/IDs/version selection, child list/read aliases and v1 cache refresh, CLI child authority, Desktop-ahead partial, LS rejection and offline cache aliases");
} finally {
    database.close();
    for (const key of ["MEMORY_STORE_DATA_ROOT", "MEMORY_STORE_AUTO_RECORD", "MEMORY_STORE_DEVIN_CLI_DB_PATH", "MEMORY_STORE_DEVIN_DESKTOP_ROOT", "MEMORY_STORE_WSF_SUBAGENT_JOBS_PATH"]) {
        if (originalEnvironment[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnvironment[key];
    }
    fs.rmSync(root, { recursive: true, force: true });
}
