import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cache = await import("../src/conversation-source-cache.ts");

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-conversation-round-index-"));
const key = { source: "codex:link=summary", conversationId: "duplicate-round-index" };

try {
    cache.resetConversationSourceCacheForTests();
    cache.setConversationSourceCacheDataRootForTests(dataRoot);

    const duplicateSpool = cache.createConversationSourceCacheRoundSpool<{ roundIndex: number }>({
        key,
        getRoundNumber: round => round.roundIndex,
    });
    duplicateSpool.append({ roundIndex: 1 });
    assert.throws(
        () => duplicateSpool.append({ roundIndex: 1 }),
        /round number 1 is duplicated/u,
        "新缓存不得发布重复轮号",
    );
    duplicateSpool.abort();

    await cache.readOrBuild({
        key,
        fingerprint: { revision: "valid" },
        getRoundNumber: (round: { roundIndex: number }) => round.roundIndex,
        build: () => ({
            snapshot: { title: "valid" },
            rounds: [{ roundIndex: 1 }, { roundIndex: 2 }],
        }),
    });

    const directory = cache.getConversationSourceCacheEntryDirectory(key);
    const manifestPath = path.join(directory, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const indexPath = path.join(directory, manifest.files.roundIndex.file);
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    index.entries[1].round = 1;
    const indexBytes = Buffer.from(JSON.stringify(index), "utf8");
    fs.writeFileSync(indexPath, indexBytes);
    manifest.files.roundIndex.bytes = indexBytes.byteLength;
    manifest.files.roundIndex.sha256 = createHash("sha256").update(indexBytes).digest("hex");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    assert.equal(
        cache.readCachedConversationSourceCache({ key }),
        null,
        "缓存命中入口必须拒绝重复轮号，让下一次 fetch 进入重建流程",
    );
    assert.equal(
        cache.readCachedConversationSourceCacheRounds({ key }),
        null,
        "旧缓存即使文件哈希正确，只要轮号重复也必须判为损坏并触发重建",
    );
    const sparseKey = { ...key, conversationId: "sparse-round-index" };
    const sparse = await cache.readOrBuild({
        key: sparseKey,
        fingerprint: { revision: "sparse" },
        getRoundNumber: (round: { roundIndex: number }) => round.roundIndex,
        build: () => ({ snapshot: {}, rounds: [{ roundIndex: 1 }, { roundIndex: 670 }, { roundIndex: 676 }] }),
    });
    assert.equal(sparse.roundCount, 3);
    assert.deepEqual(sparse.roundIndexBounds, { first: 1, last: 676 });
    assert.deepEqual(cache.getConversationSourceCacheRoundBounds({ key: sparseKey, generation: sparse.generation }), { first: 1, last: 676 });
    assert.deepEqual(cache.readCachedConversationSourceCacheRounds<{ roundIndex: number }>({
        key: sparseKey, generation: sparse.generation, startRound: 664, endRound: 676,
    })?.rounds.map(round => round.roundIndex), [670, 676]);
    const rejected = await cache.readOrBuild({
        key: sparseKey,
        fingerprint: { revision: "reject-checkpoint" },
        getRoundNumber: (round: { roundIndex: number }) => round.roundIndex,
        validateBuild: () => { throw new Error("fixture checkpoint mapping mismatch"); },
        build: () => ({ snapshot: {}, rounds: [{ roundIndex: 1 }] }),
    });
    assert.equal(rejected.generation, sparse.generation);
    assert.equal(rejected.cacheState, "stale");
    assert.match(rejected.buildFailure?.message || "", /checkpoint mapping mismatch/u);
    assert.equal(cache.readConversationSourceCacheOnly({ key: sparseKey })?.generation, sparse.generation);
} finally {
    cache.resetConversationSourceCacheForTests();
    fs.rmSync(dataRoot, { recursive: true, force: true });
}

console.log("✅ conversation-source-cache-round-index 通过：重复轮号会被拒绝并触发缓存重建");
