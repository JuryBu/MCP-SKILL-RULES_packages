import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeConversationCacheReadFailure, loadConversationData, type ConversationLoadResult } from "../src/conversation-bridge.ts";
import * as cache from "../src/conversation-source-cache.ts";
import type { ConversationRound } from "../src/trajectory.ts";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-published-cache-"));
const conversationId = "published-cache-fixture";
const key = { source: "codex:link=summary", conversationId };
const round: ConversationRound = {
    roundIndex: 1, startStep: 1, endStep: 2, userMessage: "fixture user",
    aiResponses: [{ stepIndex: 2, response: "fixture answer", thinking: "", toolCalls: [] }],
    toolCalls: [], codeActions: [], taskBoundaries: [], subagentSummaries: [],
};
const snapshot: ConversationLoadResult = {
    chainUsed: "codex", conversationId, rounds: [], totalSteps: 2,
    codexData: {
        thread: { id: conversationId, rolloutPath: path.join(temporaryRoot, "absent.jsonl"), cwd: temporaryRoot, title: "fixture", source: "test" },
        rounds: [], totalSteps: 2, childThreads: [],
    },
};

async function publish(revision: string) {
    return cache.readOrBuildConversationSourceCache<ConversationLoadResult, ConversationRound>({
        key, fingerprint: { revision }, build: () => ({ snapshot, rounds: [round] }),
        getRoundNumber: current => current.roundIndex,
    });
}

try {
    cache.resetConversationSourceCacheForTests();
    cache.setConversationSourceCacheDataRootForTests(temporaryRoot);
    const first = await publish("first");
    const loaded = await loadConversationData("codex", conversationId, { publishedCacheOnly: true });
    assert.equal(loaded?.cacheGeneration, first.generation);
    assert.equal(loaded?.cacheReadPolicy, "published");
    assert.equal(loaded?.sourceMode, "cache");
    assert.equal(loaded?.rounds[0]?.userMessage, "fixture user");
    assert.equal(fs.existsSync(snapshot.codexData!.thread.rolloutPath!), false);
    assert.ok(loaded?.cacheCreatedAt);
    const autoLoaded = await loadConversationData("auto", conversationId, { publishedCacheOnly: true, includeRounds: false });
    assert.equal(autoLoaded?.chainUsed, "codex");

    const referenceFailure = describeConversationCacheReadFailure("codex", conversationId, { link: "reference" });
    assert.match(referenceFailure, /不存在/);
    assert.match(referenceFailure, /link=reference/);
    assert.match(referenceFailure, /codex\/link=summary/);
    assert.match(referenceFailure, /source="auto", background=true/);
    assert.match(referenceFailure, /action="fetch"/);
    assert.equal(await loadConversationData("codex", conversationId, { source: "cache", link: "reference" }), null);

    const second = await publish("second");
    assert.notEqual(second.generation, first.generation);
    const fixed = await loadConversationData("codex", conversationId, { source: "cache", cacheGeneration: first.generation });
    assert.equal(fixed?.cacheGeneration, first.generation);
    await assert.rejects(() => loadConversationData("codex", conversationId, { source: "cache", cacheGeneration: "../unsafe" }), /invalid conversation cache generation/);
    await publish("third");
    assert.equal(await loadConversationData("codex", conversationId, { source: "cache", cacheGeneration: first.generation }), null);
    assert.match(describeConversationCacheReadFailure("codex", conversationId, { cacheGeneration: first.generation }), /generation 已清理/);

    const directory = cache.getConversationSourceCacheEntryDirectory(key);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
    fs.writeFileSync(path.join(directory, manifest.files.snapshot.file), "corrupted snapshot");
    assert.equal(cache.getConversationSourceCacheReadStatus({ key }), "corrupt");
    assert.match(describeConversationCacheReadFailure("codex", conversationId), /缓存损坏/);
    assert.equal(await loadConversationData("codex", conversationId, { publishedCacheOnly: true, includeRounds: false }), null);
    console.log("PASS conversation-published-cache: source-free reads, exact views, fixed generations, cleanup and corruption");
} finally {
    cache.resetConversationSourceCacheForTests();
    assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
