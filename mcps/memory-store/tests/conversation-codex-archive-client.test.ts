import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

const originalHome = os.homedir;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-archive-client-"));
os.homedir = () => temporary;
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const sessions = path.join(temporary, ".codex", "sessions");
fs.mkdirSync(sessions, { recursive: true });
const threadId = "11111111-1111-4111-8111-111111111111";
const leafId = "22222222-2222-4222-8222-222222222222";
const parentPath = path.join(sessions, `rollout-2026-01-01T00-00-00-${threadId}.jsonl.zst`);
const leafPath = path.join(sessions, `rollout-2026-01-02T00-00-00-${threadId}_${leafId}.jsonl.zst`);
const serialize = (events: unknown[]): string => events.map(event => JSON.stringify(event)).join("\n") + "\n";
const metadata = (ordinal: number, historyBase?: object) => ({ ordinal, type: "session_meta", payload: { id: threadId, cwd: temporary, ...(historyBase ? { history_base: historyBase } : {}) } });
const message = (ordinal: number, role: string, text: string) => ({ ordinal, type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
const abort = (ordinal: number) => ({ ordinal, type: "event_msg", payload: { type: "turn_aborted" } });
const writeArchive = (filePath: string, text: string): void => fs.writeFileSync(filePath, zstdCompressSync(Buffer.from(text)));

try {
    const parentText = serialize([metadata(0), message(1, "user", "synthetic base"), message(2, "assistant", "base reply ".repeat(3000))]);
    writeArchive(parentPath, parentText);
    const base = { thread_id: threadId, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(parentText) };
    let leafText = serialize([metadata(3, base), message(4, "user", "merged first"), abort(5), message(6, "user", "merged second"), message(7, "assistant", "leaf reply ".repeat(3000))]);
    writeArchive(leafPath, leafText);
    const database = new DatabaseSync(path.join(temporary, ".codex", "state_5.sqlite"));
    database.exec("create table threads(id text primary key,rollout_path text,cwd text,title text,source text,model text,reasoning_effort text,agent_nickname text,agent_role text,updated_at_ms integer,updated_at integer,archived integer); create table thread_spawn_edges(parent_thread_id text,child_thread_id text,status text)");
    database.prepare("insert into threads values(?,?,?,?,?,?,?,?,?,?,?,?)").run(threadId, leafPath, temporary, "synthetic", "vscode", null, null, null, null, 1, 1, 0);
    database.close();
    const client = await import("../src/codex-client.ts");
    const cache = await import("../src/conversation-source-cache.ts");
    const bridge = await import("../src/conversation-bridge.ts");
    const { mergeConsecutiveHumanRounds } = await import("../src/trajectory.ts");
    cache.setConversationSourceCacheDataRootForTests(path.join(temporary, "data"));
    const expected = await client.captureCodexSourceVersionAsync(leafPath);
    assert.equal(expected.sourceSize, Buffer.byteLength(leafText));
    assert.ok(expected.sourceSize > fs.statSync(leafPath).size);
    assert.equal(client.captureCodexSourceVersion(leafPath).sourceSize, expected.sourceSize);
    assert.equal((await client.inspectCodexSourceVersionAsync(leafPath)).sourceSize, expected.sourceSize);
    await client.assertCodexSourceVersion(leafPath, expected, "fixture");
    client.assertCodexSourceVersionSync(leafPath, expected, "fixture");
    assert.deepEqual(client.loadCodexConversation(threadId, "reference")?.rounds, (await client.loadCodexConversationAsync(threadId, "reference"))?.rounds);
    const options = { source: "local", link: "reference" } as const;
    let loaded = await bridge.loadConversationData("codex", threadId, options);
    assert.equal(loaded?.cacheState, "built");
    assert.deepEqual(loaded.rounds.map(round => round.roundIndex), [1, 2]);
    assert.deepEqual(loaded.rounds[1].legacyRoundIndices, [2, 3]);
    assert.equal(loaded.codexData?.sourceCheckpoint?.sourceRoundIndex, 2);
    assert.equal((await bridge.loadConversationData("codex", threadId, options))?.cacheGeneration, loaded.cacheGeneration);
    const appends = [
        [message(8, "user", "append first"), abort(9), message(10, "user", "append merged"), message(11, "assistant", "append reply")],
        [message(12, "user", "append second"), message(13, "assistant", "second reply")],
    ];
    for (const events of appends) {
        const previous = loaded;
        leafText += serialize(events);
        writeArchive(leafPath, leafText);
        loaded = await bridge.loadConversationData("codex", threadId, options);
        assert.equal(loaded?.cacheState, "built");
        assert.notEqual(loaded.cacheGeneration, previous.cacheGeneration);
        assert.ok(loaded.sourceDiagnostics?.some(item => item.includes("仅重放")), "archive logical append must retain incremental parsing");
        const full = await client.loadCodexConversationAsync(threadId, "reference");
        assert.ok(full);
        const fullRounds = mergeConsecutiveHumanRounds(full.rounds);
        assert.deepEqual(loaded.rounds, fullRounds);
        const mapped = bridge.normalizeCodexCacheCheckpoints(full, fullRounds.map(round => ({ roundIndex: round.roundIndex, sourceRoundIndices: round.legacyRoundIndices || [round.roundIndex], startStep: round.startStep })));
        assert.deepEqual(loaded.codexData?.sourceCheckpoint, mapped.sourceCheckpoint);
        assert.deepEqual(loaded.codexData?.sourceCheckpoints, mapped.sourceCheckpoints);
    }
    assert.ok(loaded.cacheKey);
    const cached = cache.readCachedConversationSourceCache<NonNullable<typeof loaded>>({ key: loaded.cacheKey });
    assert.ok(cached?.snapshot.codexData?.sourceCheckpoint);
    const broken = await cache.readOrBuild<NonNullable<typeof loaded>, typeof loaded.rounds[number]>({
        key: loaded.cacheKey,
        fingerprint: { ...cached.fingerprint, revision: "synthetic-legacy-bad-checkpoint" },
        build: () => ({
            snapshot: { ...cached.snapshot, codexData: { ...cached.snapshot.codexData!, sourceCheckpoint: { ...cached.snapshot.codexData!.sourceCheckpoint!, replaceFromRound: 676 } } },
            rounds: loaded.rounds,
        }),
        getRoundNumber: round => round.roundIndex,
    });
    leafText += serialize([message(14, "user", "explicit rebuild only"), message(15, "assistant", "rebuilt reply")]);
    writeArchive(leafPath, leafText);
    const refused = await bridge.loadConversationData("codex", threadId, options);
    assert.equal(refused?.cacheState, "stale");
    assert.equal(refused.cacheGeneration, broken.generation);
    assert.match(refused.cacheBuildFailure?.message || "", /forceRawCacheRebuild=true/);
    const readOnly = await bridge.loadConversationData("codex", threadId, { ...options, source: "cache" });
    assert.equal(readOnly?.cacheGeneration, broken.generation);
    assert.deepEqual(readOnly.rounds, loaded.rounds);
    const rebuilt = await bridge.loadConversationData("codex", threadId, { ...options, forceRawCacheRebuild: true });
    assert.equal(rebuilt?.cacheState, "built");
    assert.notEqual(rebuilt.cacheGeneration, broken.generation);
    assert.equal(rebuilt.rounds.at(-1)?.userMessage, "explicit rebuild only");
    assert.ok(cache.readCachedConversationSourceCache({ key: loaded.cacheKey, generation: broken.generation }));
    const interruptedId = "33333333-3333-4333-8333-333333333333";
    const interruptedLeafId = "44444444-4444-4444-8444-444444444444";
    const interruptedBasePath = path.join(sessions, `rollout-2026-01-03T00-00-00-${interruptedId}.jsonl.zst`);
    const interruptedLeafPath = path.join(sessions, `rollout-2026-01-04T00-00-00-${interruptedId}_${interruptedLeafId}.jsonl.zst`);
    const interruptedBase = serialize([
        { ordinal: 0, type: "session_meta", payload: { id: interruptedId, cwd: temporary } },
        message(1, "user", "base interrupted user A"), abort(2),
    ]);
    writeArchive(interruptedBasePath, interruptedBase);
    let interruptedLeaf = serialize([
        { ordinal: 3, type: "session_meta", payload: { id: interruptedId, cwd: temporary,
            history_base: { thread_id: interruptedId, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(interruptedBase) } } },
        message(4, "user", "leaf user B"), message(5, "assistant", "cross-segment reply"),
    ]);
    writeArchive(interruptedLeafPath, interruptedLeaf);
    const interruptedDatabase = new DatabaseSync(path.join(temporary, ".codex", "state_5.sqlite"));
    interruptedDatabase.prepare("insert into threads values(?,?,?,?,?,?,?,?,?,?,?,?)").run(interruptedId, interruptedLeafPath, temporary, "synthetic interrupted", "vscode", null, null, null, null, 1, 1, 0);
    interruptedDatabase.close();
    let interrupted = await bridge.loadConversationData("codex", interruptedId, options);
    assert.equal(interrupted?.cacheState, "built", "legal cross-base/leaf merged round must publish");
    assert.deepEqual(interrupted.rounds.map(round => round.legacyRoundIndices), [[1, 2]]);
    assert.equal(interrupted.codexData?.sourceCheckpoint, undefined);
    assert.equal(interrupted.codexData?.sourceCheckpointUnavailableReason, "last_merged_round_starts_before_leaf");
    assert.ok(interrupted.sourceDiagnostics?.some(item => item.includes("下次来源变化时全量解析")));
    interrupted = await bridge.loadConversationData("codex", interruptedId, { ...options, forceRawCacheRebuild: true });
    assert.equal(interrupted?.cacheState, "built", "explicit full refresh of legal cross-segment history must succeed");
    const interruptedAppends = [
        [message(6, "assistant", "same cross-segment round continues")],
        [message(7, "user", "new complete leaf round"), message(8, "assistant", "complete leaf reply")],
        [message(9, "user", "second complete leaf round"), message(10, "assistant", "second leaf reply")],
    ];
    for (const [index, events] of interruptedAppends.entries()) {
        interruptedLeaf += serialize(events);
        writeArchive(interruptedLeafPath, interruptedLeaf);
        interrupted = await bridge.loadConversationData("codex", interruptedId, options);
        assert.equal(interrupted?.cacheState, "built");
        assert.equal(interrupted.sourceDiagnostics?.some(item => item.includes("仅重放")), index === 2);
        const independentFull = await client.loadCodexConversationAsync(interruptedId, "reference");
        assert.ok(independentFull);
        const fullRounds = mergeConsecutiveHumanRounds(independentFull.rounds);
        assert.deepEqual(interrupted.rounds, fullRounds);
        const expectedMapping = bridge.normalizeCodexCacheCheckpoints(independentFull,
            fullRounds.map(round => ({ roundIndex: round.roundIndex, sourceRoundIndices: round.legacyRoundIndices || [round.roundIndex], startStep: round.startStep })));
        assert.deepEqual(interrupted.codexData?.sourceCheckpoint, expectedMapping.sourceCheckpoint);
        assert.deepEqual(interrupted.codexData?.sourceCheckpoints, expectedMapping.sourceCheckpoints);
        if (index === 0) {
            assert.equal(interrupted.codexData?.sourceCheckpoint, undefined);
            assert.equal(interrupted.codexData?.sourceCheckpointUnavailableReason, "last_merged_round_starts_before_leaf");
        } else {
            assert.equal(interrupted.codexData?.sourceCheckpoint?.sourceRoundIndex, index + 2);
            assert.equal(interrupted.codexData?.sourceCheckpointUnavailableReason, undefined);
        }
    }
    const current = await client.captureCodexSourceVersionAsync(leafPath);
    const archiveStat = fs.statSync(leafPath);
    const bytes = fs.readFileSync(leafPath);
    bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(leafPath, bytes);
    fs.utimesSync(leafPath, archiveStat.atime, archiveStat.mtime);
    await assert.rejects(() => client.assertCodexSourceVersion(leafPath, current, "archive replaced"));
    assert.throws(() => client.assertCodexSourceVersionSync(leafPath, current, "archive replaced"));
    cache.resetConversationSourceCacheForTests();
    console.log("conversation-codex-archive-client: PASS sync/async/version/logical anchors/full bridge/two incremental appends/legacy read-only rejection/explicit rebuild/archive replacement/cross-base-leaf interrupted publication and controlled full rebuild to incremental equality");
} finally {
    os.homedir = originalHome;
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true });
}
