import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

const originalHome = os.homedir;
const originalDataRoot = process.env.MEMORY_STORE_DATA_ROOT;
const originalLimit = process.env.MEMORY_STORE_CODEX_HISTORY_MAX_DECOMPRESSED_BYTES;
const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-compressed-path-client-")));
os.homedir = () => temporary;
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
const sessions = path.join(temporary, ".codex", "sessions");
fs.mkdirSync(sessions, { recursive: true });
const mainId = "11111111-1111-4111-8111-111111111111";
const childId = "22222222-2222-4222-8222-222222222222";
const directoryId = "33333333-3333-4333-8333-333333333333";
const plainId = "44444444-4444-4444-8444-444444444444";
const rolloutPath = (identifier: string): string => path.join(sessions, `rollout-2026-01-01T00-00-00-${identifier}.jsonl`);
const mainPath = rolloutPath(mainId);
const childPath = rolloutPath(childId);
const directoryPath = rolloutPath(directoryId);
const plainPath = rolloutPath(plainId);
const serialize = (events: unknown[]): string => events.map(event => JSON.stringify(event)).join("\n") + "\n";
const message = (ordinal: number, role: string, text: string) => ({ ordinal, type: "response_item", payload: {
    type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }],
} });
const textFor = (identifier: string, text: string): string => serialize([
    { ordinal: 0, type: "session_meta", payload: { id: identifier, cwd: temporary, title: "synthetic metadata", source: "synthetic" } },
    message(1, "user", text), message(2, "assistant", "synthetic reply ".repeat(1000)),
]);
const writeArchive = (filePath: string, text: string): void => fs.writeFileSync(`${filePath}.zst`, zstdCompressSync(Buffer.from(text)));
const mainText = textFor(mainId, "synthetic stale path request");
const childText = textFor(childId, "synthetic compressed child");
const directoryText = textFor(directoryId, "synthetic directory request");
fs.writeFileSync(mainPath, mainText);
writeArchive(childPath, childText);
writeArchive(directoryPath, directoryText);
fs.writeFileSync(plainPath, textFor(plainId, "synthetic plaintext request"));
const databasePath = path.join(temporary, ".codex", "state_5.sqlite");
const database = new DatabaseSync(databasePath);
database.exec("create table threads(id text primary key,rollout_path text,cwd text,title text,source text,model text,reasoning_effort text,agent_nickname text,agent_role text,updated_at_ms integer,updated_at integer,archived integer); create table thread_spawn_edges(parent_thread_id text,child_thread_id text,status text)");
for (const identifier of [mainId, childId]) {
    database.prepare("insert into threads values(?,?,?,?,?,?,?,?,?,?,?,?)").run(identifier, rolloutPath(identifier), temporary,
        "synthetic sqlite", "synthetic", null, null, null, null, 1, 1, 0);
}
database.prepare("insert into thread_spawn_edges values(?,?,?)").run(mainId, childId, "completed");
database.close();

try {
    const client = await import("../src/codex-client.ts");
    process.env.MEMORY_STORE_CODEX_HISTORY_MAX_DECOMPRESSED_BYTES = "1";
    assert.equal(client.listCodexThreadsForMetadata().find(thread => thread.id === childId)?.rolloutPath, `${childPath}.zst`);
    assert.equal((await client.listCodexThreadsForMetadataAsync()).find(thread => thread.id === childId)?.rolloutPath, `${childPath}.zst`);
    for (const thread of [client.getCodexThread(directoryId), await client.getCodexThreadAsync(directoryId)]) {
        assert.equal(thread?.rolloutPath, `${directoryPath}.zst`);
        assert.equal(thread?.id, directoryId);
        assert.equal(thread?.cwd, "");
        assert.equal(thread?.titleSource, "rollout");
    }
    assert.equal(client.getCodexThread(plainId)?.title, "synthetic metadata");
    assert.equal((await client.getCodexThreadAsync(plainId))?.cwd, temporary);
    assert.equal(fs.existsSync(path.join(temporary, "data", "codex-history-views")), false, "metadata/list must not materialize archives");
    if (originalLimit === undefined) delete process.env.MEMORY_STORE_CODEX_HISTORY_MAX_DECOMPRESSED_BYTES;
    else process.env.MEMORY_STORE_CODEX_HISTORY_MAX_DECOMPRESSED_BYTES = originalLimit;
    console.log("PASS metadata/list: stale SQLite, compressed directory sync/async, bounded plaintext header, no archive view");

    const initialTail = await client.readCodexRoundTail(mainPath, "reference");
    assert.equal(initialTail.status, "ok");
    assert.ok(initialTail.checkpoint);
    writeArchive(mainPath, mainText);
    fs.unlinkSync(mainPath);
    const expected = await client.captureCodexSourceVersionAsync(mainPath);
    assert.equal(expected.sourcePath, `${mainPath}.zst`);
    assert.equal(expected.sourceSize, Buffer.byteLength(mainText));
    assert.equal(expected.historySource?.leafPath, `${mainPath}.zst`);
    assert.notEqual(expected.historySource?.segments.at(-1)?.readPath, expected.sourcePath);
    assert.equal(client.captureCodexSourceVersion(mainPath).sourcePath, expected.sourcePath);
    assert.equal((await client.inspectCodexSourceVersionAsync(mainPath)).sourceSize, expected.sourceSize);
    await client.assertCodexSourceVersion(mainPath, expected, "stale index");
    client.assertCodexSourceVersionSync(mainPath, expected, "stale index");
    assert.equal(client.readRolloutEvents(mainPath)[1].payload.content[0].text, "synthetic stale path request");
    assert.equal((await client.readRolloutEventsAsync(mainPath))[1].payload.content[0].text, "synthetic stale path request");
    const unchanged = await client.readCodexRoundTail(mainPath, "reference", { checkpoint: initialTail.checkpoint });
    assert.equal(unchanged.status, "unchanged", "old plaintext cache path must recognize its compressed replacement");
    const directTail = await client.readCodexRoundTail(mainPath, "reference", { historySegment: expected.historySource!.segments.at(-1) });
    assert.equal(directTail.status, "ok");
    assert.equal(directTail.rounds[0].userMessage, "synthetic stale path request");
    const appendedText = mainText + serialize([message(3, "user", "synthetic appended request"), message(4, "assistant", "synthetic appended reply")]);
    writeArchive(mainPath, appendedText);
    const appended = await client.readCodexRoundTail(mainPath, "reference", { checkpoint: initialTail.checkpoint });
    assert.equal(appended.status, "ok");
    assert.equal(appended.rounds.at(-1)?.userMessage, "synthetic appended request");
    console.log("PASS direct paths: capture/inspect/assert sync/async, raw readers, old-cache tail unchanged and append");

    for (const conversation of [client.loadCodexConversation(mainId, "expand_children"), await client.loadCodexConversationAsync(mainId, "expand_children")]) {
        assert.equal(conversation?.rounds.at(-1)?.userMessage, "synthetic appended request");
        assert.equal(conversation?.expandedChildren?.length, 1);
        assert.equal(conversation?.expandedChildren?.[0].rounds[0].userMessage, "synthetic compressed child");
        assert.deepEqual(conversation?.childDiagnostics, []);
    }
    const sinkRounds: string[] = [];
    const budgetSource = await client.captureCodexSourceVersionAsync(mainPath);
    const boundedExpansion = await client.loadCodexConversationAsync(mainId, "expand_children", 0, { expectedSource: budgetSource, expansionBudgetBytes: budgetSource.historySource!.totalBytes + 1 });
    assert.equal(boundedExpansion?.expandedChildren?.length, 0);
    assert.equal(boundedExpansion?.childDiagnostics?.[0].reason, "expansion_budget_exceeded");
    await assert.rejects(() => client.loadCodexConversationAsync(mainId, "expand_children", 0, { isCancelled: () => true }), /cancelled/);
    const sinkVersion = await client.captureCodexSourceVersionAsync(mainPath);
    const sink = await client.loadCodexConversationToRoundSinkAsync(mainId, round => sinkRounds.push(round.userMessage), "reference", { expectedSource: sinkVersion });
    assert.deepEqual(sinkRounds, ["synthetic stale path request", "synthetic appended request"]);
    assert.ok(sink?.sourceCheckpoint);
    const staleThread = { ...client.getCodexThread(mainId)!, rolloutPath: mainPath };
    assert.equal(client.findCodexContextProbeMatches([staleThread], "synthetic stale path request").length, 1);
    const located = client.deepLocateCodexConversations("synthetic stale path request", [staleThread]);
    assert.equal(located.status, "found");
    assert.equal(located.hits[0].filePath, `${mainPath}.zst`);
    assert.ok(located.hits[0].readPath);
    assert.equal(located.totalBytes, Buffer.byteLength(appendedText));
    const evidence = await client.collectCodexSourceEvidence({ conversationId: mainId,
        workspace: { workspaceId: "synthetic-compressed-path", canonicalPath: temporary }, scanId: "synthetic-scan", sequence: 1,
        paths: { stateDbPath: databasePath, rolloutRoots: [sessions] },
    });
    assert.equal(evidence.enumeration.exactFetchResult, "present");
    assert.equal(evidence.enumeration.enumerationComplete, true);
    assert.deepEqual(evidence.fullSourceRead?.errors, []);
    assert.equal(evidence.thread?.rolloutPath, `${mainPath}.zst`);
    assert.equal(evidence.sourceMessages?.at(-2)?.text, "synthetic appended request");
    assert.deepEqual((await client.readCodexEvidenceRolloutForTest(mainPath)).errors, []);
    fs.writeFileSync(mainPath, appendedText);
    const replicaDatabase = new DatabaseSync(databasePath);
    replicaDatabase.prepare("update threads set rollout_path=? where id=?").run(`${mainPath}.zst`, mainId);
    replicaDatabase.close();
    const deduplicatedEvidence = await client.enumerateCodexSourceEvidence({ conversationId: mainId,
        workspace: { workspaceId: "synthetic-compressed-path", canonicalPath: temporary }, scanId: "synthetic-replicas", sequence: 2,
        enumerationLimit: 4, paths: { stateDbPath: databasePath, rolloutRoots: [sessions] },
    });
    assert.equal(deduplicatedEvidence.evidence.enumerationComplete, true, "SQLite/archive and directory/plaintext aliases must count as one rollout");
    fs.unlinkSync(mainPath);
    console.log("PASS consumers: sync/async child expansion, round sink, context probe, deep locate, full source evidence");

    const pinnedPlainSource = await client.captureCodexSourceVersionAsync(plainPath);
    fs.appendFileSync(plainPath, serialize([message(3, "user", "synthetic after captured boundary"), message(4, "assistant", "late reply")]));
    const pinnedPlain = await client.loadCodexConversationAsync(plainId, "expand_children", 0, { expectedSource: pinnedPlainSource });
    assert.equal(pinnedPlain?.rounds.length, 1);
    assert.equal((await client.loadCodexConversationAsync(plainId))?.rounds.length, 2);
    const bridge = await import("../src/conversation-bridge.ts");
    const pinnedCache = await bridge.loadConversationData("codex", plainId, { source: "local", link: "expand_children", refresh: true, expectedCodexSource: pinnedPlainSource });
    assert.equal(pinnedCache?.roundCount, 1);
    assert.equal(pinnedCache?.cacheFingerprint?.size, pinnedPlainSource.sourceSize);
    console.log("PASS expansion controls: cumulative child budget, cooperative cancellation, appended plaintext source pinned through cache publication");

    fs.writeFileSync(directoryPath, directoryText);
    assert.equal(client.getCodexThread(directoryId)?.id, directoryId, "equal plaintext/compressed replicas must not become an ambiguous thread");
    assert.equal((await client.getCodexThreadAsync(directoryId))?.id, directoryId);
    const equalReplica = await client.captureCodexSourceVersionAsync(directoryPath);
    assert.equal(equalReplica.historySource?.segments.at(-1)?.replicas?.length, 1);
    writeArchive(directoryPath, textFor(directoryId, "synthetic conflicting replica"));
    assert.throws(() => client.captureCodexSourceVersion(directoryPath), /Conflicting/);
    await assert.rejects(() => client.captureCodexSourceVersionAsync(directoryPath), /Conflicting/);
    await assert.rejects(() => client.readCodexRoundTail(directoryPath, "reference"), /Conflicting/);
    await assert.rejects(() => client.readCodexRoundTail(directoryPath, "reference", { historySegment: equalReplica.historySource!.segments.at(-1) }), /Conflicting/);
    assert.throws(() => client.readRolloutEvents(directoryPath), /Conflicting/);
    assert.ok((await client.readCodexEvidenceRolloutForTest(directoryPath)).errors.length > 0);
    console.log("PASS replicas: directory deduplication, equal source replicas, strict conflict refusal");

    const denied = Object.assign(new Error("synthetic permission denied"), { code: "EACCES" });
    const originalStatSync = fs.statSync;
    const originalStat = fs.promises.stat;
    try {
        fs.statSync = ((target: fs.PathLike, ...arguments_: unknown[]) => {
            if (String(target) === mainPath) throw denied;
            return (originalStatSync as Function)(target, ...arguments_);
        }) as typeof fs.statSync;
        assert.throws(() => client.readRolloutEvents(mainPath), error => error === denied);
        assert.throws(() => client.captureCodexSourceVersion(mainPath), error => error === denied);
        fs.promises.stat = (async (target: fs.PathLike, ...arguments_: unknown[]) => {
            if (String(target) === mainPath) throw denied;
            return (originalStat as Function)(target, ...arguments_);
        }) as typeof fs.promises.stat;
        await assert.rejects(() => client.readCodexRoundTail(mainPath, "reference"), error => error === denied);
        await assert.rejects(() => client.inspectCodexSourceVersionAsync(mainPath), error => error === denied);
    } finally {
        fs.statSync = originalStatSync;
        fs.promises.stat = originalStat;
    }
    console.log("PASS error classification: EACCES preserved by sync/async readers, capture, inspection and tail");
    console.log("codex-compressed-path-client: PASS");
} finally {
    os.homedir = originalHome;
    if (originalDataRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
    else process.env.MEMORY_STORE_DATA_ROOT = originalDataRoot;
    if (originalLimit === undefined) delete process.env.MEMORY_STORE_CODEX_HISTORY_MAX_DECOMPRESSED_BYTES;
    else process.env.MEMORY_STORE_CODEX_HISTORY_MAX_DECOMPRESSED_BYTES = originalLimit;
    assert.equal(path.dirname(path.resolve(temporary)), fs.realpathSync.native(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true });
}
