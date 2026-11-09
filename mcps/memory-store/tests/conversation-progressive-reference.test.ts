import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openProgressiveCache } from "../src/conversation-progressive-cache.js";
import { compactProgressiveRef, parseCompactProgressiveRef } from "../src/conversation-progressive-reference.js";
import type { ConversationRound } from "../src/trajectory.js";

test("compact immutable refs keep complete block identity, old refs and reopen behavior", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "progressive-compact-ref-"));
    const source = { conversationId: "fictional-reference", host: "codex" as const, revision: "one", snapshot: { file: "fictional" } };
    try {
        const cache = await openProgressiveCache({ root, source });
        const writer = await cache.beginWrite();
        const round = { roundIndex: 158, startStep: 1, endStep: 2, userMessage: "kept", mediaAttachments: [],
            aiResponses: [], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [] } as ConversationRound;
        await cache.publish(writer, { coverage: { kind: "absolute", startRound: 158, endRound: 158 }, anchor: { file: "fictional", offset: 5 },
            rounds: [round], messages: [{ id: "one", round: 158, role: "user", text: "kept", position: { ordinal: 1 } }] });
        const original = (await cache.read({ startRound: 158, endRound: 158 })).rows[0]!;
        const compact = compactProgressiveRef(original.ref)!;
        assert(compact.length < 65);
        assert.equal(parseCompactProgressiveRef(compact)?.blockId, original.blockId);
        assert.deepEqual(await cache.locate(compact), await cache.locate(original.ref));
        await cache.release(writer);
        const reopened = await openProgressiveCache({ root, source });
        assert.deepEqual(await reopened.locate(compact), original);
        const foreign = await openProgressiveCache({ root: path.join(root, "other"), source: { ...source, revision: "two" } });
        await assert.rejects(foreign.locate(compact), { code: "unpublished_ref" });
        assert.equal(parseCompactProgressiveRef(compact.replace(/:158$/u, ":0")), undefined);
        assert.equal(parseCompactProgressiveRef("p2:" + "A".repeat(42) + ":a:158"), undefined);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
