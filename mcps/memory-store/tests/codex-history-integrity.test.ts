import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexOrdinalValidator, hashCodexPrefix } from "../src/codex-history-integrity.ts";

const originalHome = os.homedir;
const originalRoot = process.env.MEMORY_STORE_DATA_ROOT;
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-history-integrity-"));
const sessions = path.join(temporaryRoot, ".codex", "sessions");
fs.mkdirSync(sessions, { recursive: true });
os.homedir = () => temporaryRoot;
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporaryRoot, "data");
const threadId = "11111111-1111-4111-8111-111111111111";
const leafId = "22222222-2222-4222-8222-222222222222";
const parentPath = path.join(sessions, `rollout-2026-01-01T00-00-00-${threadId}.jsonl`);
const leafPath = path.join(sessions, `rollout-2026-01-02T00-00-00-${threadId}_${leafId}.jsonl`);
const metadata = (ordinal: number, historyBase?: unknown) => ({ ordinal, type: "session_meta", payload: { id: threadId, cwd: temporaryRoot, ...(historyBase ? { history_base: historyBase } : {}) } });
const message = (ordinal: number, role: string, text: string) => ({ ordinal, type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
const serialize = (events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n") + "\n";
const options = { source: "local", link: "reference" } as const;

try {
    const client = await import("../src/codex-client.ts");
    const history = await import("../src/codex-history-source.ts");
    const cache = await import("../src/conversation-source-cache.ts");
    const bridge = await import("../src/conversation-bridge.ts");
    cache.setConversationSourceCacheDataRootForTests(path.join(temporaryRoot, "data"));
    const parentText = serialize([metadata(0), message(1, "user", "OLD_MIDDLE"), message(2, "assistant", "a".repeat(20000)), message(50, "user", "PARENT_LAST"), message(51, "assistant", "b".repeat(20000))]);
    fs.writeFileSync(parentPath, parentText);
    const base = { thread_id: threadId, end_ordinal_exclusive: 52, end_byte_offset: Buffer.byteLength(parentText) };
    const leafText = serialize([metadata(52, base), message(60, "user", "LEAF_FIRST"), message(61, "assistant", "LEAF_ANSWER")]);
    fs.writeFileSync(leafPath, leafText);
    execFileSync("python", ["-c", "import sqlite3,sys\nconn=sqlite3.connect(sys.argv[1])\nconn.execute('create table threads(id text primary key,rollout_path text,cwd text,title text,source text,model text,reasoning_effort text,agent_nickname text,agent_role text,updated_at_ms integer,updated_at integer,archived integer)')\nconn.execute('create table thread_spawn_edges(parent_thread_id text,child_thread_id text,status text)')\nconn.execute('insert into threads values(?,?,?,?,?,?,?,?,?,?,?,?)',(sys.argv[2],sys.argv[3],sys.argv[4],'test','vscode',None,None,None,None,1,1,0))\nconn.commit()\nconn.close()", path.join(temporaryRoot, ".codex", "state_5.sqlite"), threadId, leafPath, temporaryRoot]);

    const initial = await bridge.loadConversationData("codex", threadId, options);
    assert.equal(initial?.cacheState, "built");
    assert.deepEqual(initial.rounds.map(round => round.userMessage), ["OLD_MIDDLE", "PARENT_LAST", "LEAF_FIRST"]);
    assert.equal(initial.totalSteps, 8, "physical steps are not logical ordinals");
    assert.deepEqual(client.loadCodexConversation(threadId, "reference")?.rounds, (await client.loadCodexConversationAsync(threadId, "reference"))?.rounds);
    assert.equal((await bridge.loadConversationData("codex", threadId, options))?.cacheState, "hit");
    fs.appendFileSync(parentPath, serialize([message(100, "user", "OUTSIDE_SELECTED_PREFIX")]));
    assert.equal((await bridge.loadConversationData("codex", threadId, options))?.cacheGeneration, initial.cacheGeneration);

    fs.appendFileSync(leafPath, serialize([message(80, "user", "APPENDED"), message(90, "assistant", "APPENDED_ANSWER")]));
    const appended = await bridge.loadConversationData("codex", threadId, options);
    assert.equal(appended?.cacheState, "built");
    assert.ok(appended.sourceDiagnostics?.some(item => item.includes("仅重放")));
    assert.equal(appended.totalSteps, 10);
    assert.equal(appended.codexData?.sourceCheckpoint?.replayStartOrdinal, 80);

    const beforeStat = fs.statSync(parentPath);
    const beforeSource = appended.codexData!.historySource!;
    fs.writeFileSync(parentPath, fs.readFileSync(parentPath, "utf8").replace("OLD_MIDDLE", "NEW_MIDDLE"));
    fs.utimesSync(parentPath, beforeStat.atime, beforeStat.mtime);
    assert.throws(() => history.assertCodexHistorySource(beforeSource), /content changed/);
    await assert.rejects(() => history.assertCodexHistorySourceAsync(beforeSource), /content changed/);
    const rewritten = await bridge.loadConversationData("codex", threadId, options);
    assert.equal(rewritten?.cacheState, "built");
    assert.equal(rewritten.rounds[0].userMessage, "NEW_MIDDLE");
    assert.ok(!rewritten.sourceDiagnostics?.some(item => item.includes("仅重放")));
    assert.equal((await bridge.loadConversationData("codex", threadId, options))?.cacheState, "hit");

    const currentLeaf = fs.readFileSync(leafPath, "utf8");
    for (const invalidTail of [serialize([message(90, "user", "DUPLICATE")]), serialize([message(70, "user", "DESCENDING")]), "{bad-json}\n", serialize([{ type: "event_msg", payload: { type: "user_message", text: "MIXED" } }])]) {
        fs.writeFileSync(leafPath, currentLeaf + invalidTail);
        const rejected = await bridge.loadConversationData("codex", threadId, options);
        assert.equal(rejected?.cacheState, "stale");
        assert.equal(rejected.cacheGeneration, rewritten.cacheGeneration);
        assert.match(rejected.cacheBuildFailure?.message || "", /ordinal|JSON/);
    }
    fs.writeFileSync(leafPath, currentLeaf);
    const frozen = await history.resolveCodexHistorySourceAsync(leafPath, { roots: [sessions] });
    fs.writeFileSync(parentPath, fs.readFileSync(parentPath, "utf8").replace("NEW_MIDDLE", "BAD_MIDDLE"));
    await assert.rejects(() => client.buildCodexRoundsFromHistoryAsync(frozen, "reference"), /content changed during parsing/);
    fs.writeFileSync(parentPath, fs.readFileSync(parentPath, "utf8").replace("BAD_MIDDLE", "NEW_MIDDLE"));

    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, "0", null]) {
        assert.throws(() => new CodexOrdinalValidator(0).add({ ordinal: value }), /ordinal/);
    }
    const legacy = new CodexOrdinalValidator(0);
    legacy.add({ type: "session_meta" });
    legacy.finish(1);
    const upgraded = new CodexOrdinalValidator(1, "explicit", legacy.mode);
    upgraded.add({ ordinal: 1 });
    upgraded.add({ ordinal: 5 });
    upgraded.finish(6);
    assert.throws(() => new CodexOrdinalValidator(6, "legacy", upgraded.mode).add({}), /mode mismatch/);
    const mixed = new CodexOrdinalValidator(0);
    mixed.add({ ordinal: 0 });
    assert.throws(() => mixed.add({}), /mixes/);
    assert.throws(() => new CodexOrdinalValidator(0).add({ ordinal: 2 }), /invalid start/);
    await assert.rejects(() => hashCodexPrefix(parentPath, fs.statSync(parentPath).size, () => true), { name: "AbortError" });
    const cacheKey = { source: "codex:link=reference", conversationId: threadId };
    const cached = cache.readCachedConversationSourceCache<any>({ key: cacheKey })!;
    const oldSnapshot = structuredClone(cached.snapshot);
    for (const segment of oldSnapshot.codexData.historySource.segments) {
        delete segment.prefixSha256;
        delete segment.ordinalMode;
    }
    delete oldSnapshot.codexData.sourceCheckpoint.prefixSha256;
    const version = await client.captureCodexSourceVersionAsync(leafPath);
    const oldGeneration = await cache.readOrBuildConversationSourceCache({ key: cacheKey, refresh: true, fingerprint: { path: version.sourcePath, size: version.sourceSize, mtime: version.sourceMtimeMs, revision: version.historySource?.revision }, build: () => ({ snapshot: oldSnapshot, rounds: rewritten.rounds }) });
    const upgradedCache = await bridge.loadConversationData("codex", threadId, options);
    assert.equal(upgradedCache?.cacheState, "built", "old persistent manifests must rebuild even when their fingerprint matches");
    assert.notEqual(upgradedCache.cacheGeneration, oldGeneration.generation);
    assert.ok(!upgradedCache.sourceDiagnostics?.some(item => item.includes("仅重放")));
    assert.equal((await bridge.loadConversationData("codex", threadId, options))?.cacheState, "hit");
    const otherParentId = "33333333-3333-4333-8333-333333333333";
    const otherParentPath = path.join(sessions, `rollout-2026-01-03T00-00-00-${otherParentId}.jsonl`);
    fs.writeFileSync(otherParentPath, parentText.replaceAll(threadId, otherParentId).replace("OLD_MIDDLE", "ALT_MIDDLE"));
    const originalLeaf = fs.readFileSync(leafPath, "utf8");
    const changedLeaf = originalLeaf.replace(`"thread_id":"${threadId}"`, `"thread_id":"${otherParentId}"`);
    assert.notEqual(originalLeaf, changedLeaf);
    assert.equal(Buffer.byteLength(originalLeaf), Buffer.byteLength(changedLeaf));
    fs.utimesSync(leafPath, 1700000000, 1700000000);
    const beforeRace = await bridge.loadConversationData("codex", threadId, options);
    const beforeRaceVersion = await client.captureCodexSourceVersionAsync(leafPath);
    const originalOpen = fs.promises.open;
    let mutated = false;
    const mutateLeaf = () => {
        mutated = true;
        fs.writeFileSync(leafPath, changedLeaf);
        fs.utimesSync(leafPath, 1700000000, 1700000000);
    };
    fs.promises.open = (async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await originalOpen(...args);
        if (path.resolve(String(args[0])) === path.resolve(leafPath)) {
            const originalRead = handle.read.bind(handle);
            handle.read = (async (...readArgs: any[]) => {
                if (!mutated && Buffer.isBuffer(readArgs[0]) && readArgs[0].length === 1024 * 1024 && readArgs[3] === 0) mutateLeaf();
                return (originalRead as any)(...readArgs);
            }) as typeof handle.read;
        }
        return handle;
    }) as typeof fs.promises.open;
    try {
        await assert.rejects(() => bridge.loadConversationData("codex", threadId, options), /header changed/);
        assert.equal(mutated, true);
        assert.equal(cache.readCachedConversationSourceCache<any>({ key: cacheKey })?.generation, beforeRace?.cacheGeneration, "mixed capture must not publish a new generation");
    } finally {
        fs.promises.open = originalOpen;
    }
    await assert.rejects(() => history.assertCodexHistorySourceAsync(beforeRaceVersion.historySource!), /header changed/);
    assert.throws(() => history.assertCodexHistorySource(beforeRaceVersion.historySource!), /header changed/);
    const repairedRace = await bridge.loadConversationData("codex", threadId, options);
    assert.equal(repairedRace?.rounds[0].userMessage, "ALT_MIDDLE");
    assert.notEqual(repairedRace?.cacheGeneration, beforeRace?.cacheGeneration);
    fs.writeFileSync(leafPath, originalLeaf);
    fs.utimesSync(leafPath, 1700000000, 1700000000);
    const originalReadSync = fs.readSync;
    mutated = false;
    fs.readSync = ((...args: any[]) => {
        if (!mutated && Buffer.isBuffer(args[1]) && args[1].length === 1024 * 1024 && args[4] === 0) mutateLeaf();
        return (originalReadSync as any)(...args);
    }) as typeof fs.readSync;
    try {
        assert.throws(() => history.resolveCodexHistorySource(leafPath, { roots: [sessions] }), /header changed/);
        assert.equal(mutated, true);
    } finally {
        fs.readSync = originalReadSync;
    }
    console.log("Codex integrity: ordinal gaps/sync/async/physical steps/tail/cache hit/ancestor append/equal middle rewrite/bad tail/parser-byte binding/legacy transition/cancellation/mixed-header rejection and unchanged generation passed");
} finally {
    os.homedir = originalHome;
    if (originalRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
    else process.env.MEMORY_STORE_DATA_ROOT = originalRoot;
    assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
