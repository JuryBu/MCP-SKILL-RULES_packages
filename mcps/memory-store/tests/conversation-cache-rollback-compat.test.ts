import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const releaseRoot = process.env.MEMORY_STORE_ROLLBACK_RELEASE_DIST;
if (!releaseRoot) {
    console.log("conversation-cache-rollback-compat: SKIP set MEMORY_STORE_ROLLBACK_RELEASE_DIST to the read-only rollback release dist");
} else {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-rollback-compat-"));
    const originalHome = os.homedir;
    os.homedir = () => temporary;
    process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
    process.env.MEMORY_STORE_AUTO_RECORD = "0";
    process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
    const sessions = path.join(temporary, ".codex", "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    const thirdId = "33333333-3333-4333-8333-333333333333";
    const rolloutPaths = new Map<string, string>();
    const ordinals = new Map<string, number>();
    const append = (id: string, type: string, payload: object): void => {
        const ordinal = ordinals.get(id) || 0;
        fs.appendFileSync(rolloutPaths.get(id)!, `${JSON.stringify({ ordinal, type, payload })}\n`);
        ordinals.set(id, ordinal + 1);
    };
    const message = (id: string, role: string, text: string): void => append(id, "response_item", {
        type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    });
    const pair = (id: string, text: string): void => {
        message(id, "user", text);
        message(id, "assistant", `${text} reply`);
    };
    const cacheDirectory = (id: string): string => path.join(process.env.MEMORY_STORE_DATA_ROOT!, "conversation-cache", "v1",
        createHash("sha256").update(`codex:link=reference\0${id}`, "utf8").digest("hex"));
    try {
        const database = new DatabaseSync(path.join(temporary, ".codex", "state_5.sqlite"));
        database.exec("create table threads(id text primary key,rollout_path text,cwd text,title text,source text,model text,reasoning_effort text,agent_nickname text,agent_role text,updated_at_ms integer,updated_at integer,archived integer); create table thread_spawn_edges(parent_thread_id text,child_thread_id text,status text)");
        for (const id of [firstId, secondId, thirdId]) {
            const rollout = path.join(sessions, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
            rolloutPaths.set(id, rollout);
            append(id, "session_meta", { id, cwd: temporary });
            pair(id, "stable first");
            message(id, "user", "merged first"); append(id, "event_msg", { type: "turn_aborted" });
            message(id, "user", "merged second"); append(id, "event_msg", { type: "turn_aborted" });
            pair(id, "merged third");
            pair(id, "last original");
            database.prepare("insert into threads values(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, rollout, temporary, "synthetic rollback", "vscode", null, null, null, null, 1, 1, 0);
        }
        database.close();
        const currentCache = await import("../src/conversation-source-cache.ts");
        const currentBridge = await import("../src/conversation-bridge.ts");
        const currentClient = await import("../src/codex-client.ts");
        const oldCache = await import(pathToFileURL(path.join(releaseRoot, "conversation-source-cache.js")).href);
        const oldBridge = await import(pathToFileURL(path.join(releaseRoot, "conversation-bridge.js")).href);
        const oldClient = await import(pathToFileURL(path.join(releaseRoot, "codex-client.js")).href);
        const options = { source: "local", link: "reference" } as const;
        await oldBridge.loadConversationData("codex", thirdId, options);
        const untouchedManifest = fs.readFileSync(path.join(cacheDirectory(thirdId), "manifest.json"));
        const firstKey = { source: "codex:link=reference", conversationId: firstId };
        const oldBaseline = await oldBridge.loadConversationData("codex", firstId, options);
        assert.equal(oldBaseline.cacheState, "built");
        const beforeManifest = fs.readFileSync(path.join(cacheDirectory(firstId), "manifest.json"));
        const beforeState = oldCache.readCachedConversationSourceCache({ key: firstKey });
        assert.ok(beforeState);
        await oldCache.pinConversationSourceCacheGeneration({ ...beforeState, ownerId: "rollback-before-fixture" });
        const candidate = await currentBridge.loadConversationData("codex", firstId, { ...options, forceRawCacheRebuild: true });
        assert.ok(candidate?.codexData?.sourceCheckpoint);
        const candidateState = currentCache.readCachedConversationSourceCache({ key: firstKey });
        assert.ok(candidateState);
        await currentCache.pinConversationSourceCacheGeneration({ ...candidateState, ownerId: "rollback-candidate-fixture" });
        assert.equal(candidate.codexData.sourceCheckpoint.replaceFromRound, 3);
        assert.equal(candidate.codexData.sourceCheckpoint.sourceRoundIndex, 5);
        pair(firstId, "appended after candidate");
        const badTail = await oldClient.readCodexRoundTail(rolloutPaths.get(firstId), "reference", { checkpoint: candidate.codexData.sourceCheckpoint });
        const correctTail = await currentClient.readCodexRoundTail(rolloutPaths.get(firstId)!, "reference", { checkpoint: candidate.codexData.sourceCheckpoint });
        assert.equal(badTail.status, "ok");
        assert.deepEqual(badTail.rounds.map((round: { roundIndex: number }) => round.roundIndex), [3, 4]);
        assert.deepEqual(correctTail.rounds.map(round => round.roundIndex), [5, 6]);
        fs.writeFileSync(path.join(cacheDirectory(firstId), "manifest.restore.tmp"), beforeManifest);
        fs.renameSync(path.join(cacheDirectory(firstId), "manifest.restore.tmp"), path.join(cacheDirectory(firstId), "manifest.json"));
        assert.equal(oldCache.readCachedConversationSourceCache({ key: firstKey }).generation, beforeState.generation);
        const restored = await oldBridge.loadConversationData("codex", firstId, options);
        assert.equal(restored.cacheState, "built");
        assert.ok(restored.sourceDiagnostics.some((item: string) => item.includes("仅重放")));
        assert.ok(oldCache.readCachedConversationSourceCache({ key: firstKey, generation: candidateState.generation }));
        const oldFull = await oldBridge.loadConversationData("codex", firstId, { ...options, forceRawCacheRebuild: true });
        const comparable = (rounds: Array<{ roundIndex: number; legacyRoundIndices?: number[] }>) => rounds.map(round => {
            const result = { ...round };
            if (result.legacyRoundIndices?.length === 1 && result.legacyRoundIndices[0] === result.roundIndex) delete result.legacyRoundIndices;
            return result;
        });
        assert.deepEqual(comparable(restored.rounds), comparable(oldFull.rounds));
        assert.equal(restored.codexData.sourceCheckpoint.replaceFromRound, oldFull.codexData.sourceCheckpoint.replaceFromRound);
        assert.ok(oldCache.readCachedConversationSourceCache({ key: firstKey, generation: beforeState.generation }));
        assert.ok(oldCache.readCachedConversationSourceCache({ key: firstKey, generation: candidateState.generation }));

        const secondKey = { source: "codex:link=reference", conversationId: secondId };
        const newOnly = await currentBridge.loadConversationData("codex", secondId, options);
        assert.ok(newOnly?.cacheGeneration);
        const newState = currentCache.readCachedConversationSourceCache({ key: secondKey });
        assert.ok(newState);
        await currentCache.pinConversationSourceCacheGeneration({ ...newState, ownerId: "rollback-new-key-fixture" });
        const manifest = JSON.parse(fs.readFileSync(path.join(cacheDirectory(secondId), "manifest.json"), "utf8"));
        assert.equal("tailCheckpoint" in manifest, false);
        delete manifest.tailCheckpoint;
        fs.writeFileSync(path.join(cacheDirectory(secondId), "manifest.json"), JSON.stringify(manifest));
        assert.equal(oldCache.readCachedConversationSourceCache({ key: secondKey }).snapshot.codexData.sourceCheckpoint.sourceRoundIndex, 5);
        fs.renameSync(path.join(cacheDirectory(secondId), "manifest.json"), path.join(temporary, "second-current.backup.json"));
        assert.equal(oldCache.readCachedConversationSourceCache({ key: secondKey }), null);
        assert.ok(oldCache.readCachedConversationSourceCache({ key: secondKey, generation: newState.generation }));
        pair(secondId, "new key rebuild");
        const rebuilt = await oldBridge.loadConversationData("codex", secondId, options);
        assert.equal(rebuilt.cacheState, "built");
        assert.ok(rebuilt.sourceDiagnostics.some((item: string) => item.includes("已流式规范化")));
        assert.equal(rebuilt.codexData.sourceCheckpoint.sourceRoundIndex, undefined);
        assert.equal(rebuilt.codexData.sourceCheckpoint.replaceFromRound, 6);
        assert.ok(oldCache.readCachedConversationSourceCache({ key: secondKey, generation: newState.generation }));
        assert.ok(fs.existsSync(path.join(cacheDirectory(secondId), "pins")));
        assert.deepEqual(fs.readFileSync(path.join(cacheDirectory(thirdId), "manifest.json")), untouchedManifest);
        console.log("conversation-cache-rollback-compat: PASS actual old release mislabels source5 as cache3; scoped old-current restore appends/full equality; absent-current new-key rebuild; manifest.tailCheckpoint no-op; old/new pinned generations survive old GC; untouched key unchanged");
    } finally {
        os.homedir = originalHome;
        assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}
