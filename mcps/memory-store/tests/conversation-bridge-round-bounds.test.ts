import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationLoadResult } from "../src/conversation-bridge.ts";
import type { ConversationRound } from "../src/trajectory.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-bridge-round-bounds-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const cache = await import("../src/conversation-source-cache.ts");
const { loadConversationData } = await import("../src/conversation-bridge.ts");
const conversationId = "synthetic-sparse-bridge";
const key = { source: "codex:link=summary", conversationId };
const round: ConversationRound = {
    roundIndex: 670, startStep: 1, endStep: 2,
    userMessage: "synthetic user", mediaAttachments: [],
    aiResponses: [{ stepIndex: 2, response: "synthetic reply", thinking: "", toolCalls: [] }],
    toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [],
    userMessages: [{ stepIndex: 1, text: "synthetic user", rawRole: "user", semanticRole: "user", mediaAttachments: [] }],
    legacyRoundIndices: [670], semanticEvents: [],
};

try {
    cache.resetConversationSourceCacheForTests();
    cache.setConversationSourceCacheDataRootForTests(temporary);
    const snapshot: ConversationLoadResult = {
        chainUsed: "codex", conversationId, rounds: [], totalSteps: 2,
        codexData: {
            thread: { id: conversationId, rolloutPath: "C:/not-accessed/synthetic.jsonl", cwd: "C:/synthetic", title: "synthetic", source: "fixture" },
            rounds: [], totalSteps: 2, childThreads: [],
        },
    };
    const published = await cache.readOrBuild<ConversationLoadResult, ConversationRound>({
        key, fingerprint: { revision: "fixture" },
        build: () => ({ snapshot, rounds: [round] }),
        getRoundNumber: item => item.roundIndex,
    });
    for (const includeRounds of [true, false]) {
        const loaded = await loadConversationData("codex", conversationId, { source: "cache", link: "summary", includeRounds });
        assert.equal(loaded?.cacheGeneration, published.generation);
        assert.equal(loaded?.roundCount, 1);
        assert.deepEqual(loaded?.roundIndexBounds, { first: 670, last: 670 });
        assert.deepEqual(loaded?.rounds.map(item => item.roundIndex), includeRounds ? [670] : []);
    }
    const ranged = await loadConversationData("codex", conversationId, { source: "cache", link: "summary", roundRange: { startRound: 664, endRound: 676 } });
    assert.deepEqual(ranged?.rounds.map(item => item.roundIndex), [670]);
    console.log("conversation-bridge-round-bounds: PASS sparse generation metadata and cache-only hydration");
} finally {
    cache.resetConversationSourceCacheForTests();
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true });
}
