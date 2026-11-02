import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { CorpusConversation, CorpusProjection, CorpusRangeProvider } from "../src/conversation-corpus-types.js";
import type { ProgressiveTaskPayload } from "../src/conversation-progressive-task-types.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-store-host-progressive-test-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
const { executeHostProgressivePreparation, hostProjectionRounds } = await import("../src/conversation-progressive-worker-hosts.js");
const { openProgressiveCache } = await import("../src/conversation-progressive-cache.js");
after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith("memory-store-host-progressive-test-"));
    await fs.rm(root, { recursive: true, force: true });
});

const conversation: CorpusConversation = { id: "host-session", title: "fixture", source: "dsh", workspace: "/fixture" };
function projection(indices: number[], complete = false, relative = false): CorpusProjection {
    return { conversation, revision: "verified-source-1", complete, requestedRangeComplete: true,
        roundNumbering: relative ? "relative" : "absolute", totalRounds: relative ? undefined : 4, warnings: [],
        messages: indices.flatMap(round => [
            { id: "u" + round, round, role: "user" as const, text: "question " + round, position: { ordinal: round * 2 } },
            { id: "a" + round, round, role: "assistant" as const, text: "answer " + round, position: { ordinal: round * 2 + 1 } },
        ]) };
}

function payload(name: string, buildFull: boolean): ProgressiveTaskPayload {
    return { version: 1, taskId: "progressive-11111111-1111-4111-8111-111111111111", directory: path.join(root, name),
        request: { ownerId: "caller", conversationId: conversation.id, dataChain: "dsh", initialRounds: 2,
            buildFull, direction: "latest", messageRoles: ["user", "assistant"], depth: "normal" } };
}

test("a verified tail is usable while full history waits, even when its source cache is complete", async () => {
    let releaseFull!: () => void;
    let rangeReady!: () => void;
    const gate = new Promise<void>(resolve => { releaseFull = resolve; });
    const ready = new Promise<void>(resolve => { rangeReady = resolve; });
    let fullReads = 0;
    const provider: CorpusRangeProvider = { list: async () => [conversation], readFast: async () => projection([3, 4], true),
        readRounds: async () => projection([3, 4], true), read: async (_conversation, control) => {
            fullReads++;
            await control.onChunk?.({ ...projection([1]), verified: false });
            await gate;
            return projection([1, 2, 3, 4], true);
        } };
    const job = payload("window-before-full", true);
    const running = executeHostProgressivePreparation(job, { provider, isCancelled: () => false, onActive: () => {},
        onProgress: async message => { if ((message as { stage?: string }).stage === "full-cache") rangeReady(); } });
    try {
        await ready;
        const state = JSON.parse(await fs.readFile(path.join(job.directory, "ready.json"), "utf8"));
        const cache = await openProgressiveCache({ root: state.current.directory, source: state.current.source });
        assert.equal((await cache.status()).complete, false);
        assert.deepEqual((await cache.read({ direction: "oldest" })).rows.map(row => row.round.roundIndex), [3, 4]);
        assert.equal(fullReads, 1);
        releaseFull();
        await running;
        const final = JSON.parse(await fs.readFile(path.join(job.directory, "ready.json"), "utf8"));
        const full = await openProgressiveCache({ root: final.current.directory, source: final.current.source });
        assert.equal((await full.status()).complete, true);
        assert.deepEqual((await full.read({ direction: "oldest" })).rows.map(row => row.round.roundIndex), [1, 2, 3, 4]);
        assert.ok(final.previous.some((item: { directory: string }) => item.directory === cache.root));
    } finally { releaseFull(); await running.catch(() => undefined); }
});

test("relative partial windows preserve incomplete request status and the requested alias", async () => {
    const provider: CorpusRangeProvider = { list: async () => [{ ...conversation, aliases: ["host-alias"] }],
        readFast: async () => ({ ...projection([1, 2], false, true), requestedRangeComplete: false }),
        readRounds: async () => projection([1, 2], false, true), read: async () => { throw new Error("full read was not requested"); } };
    const job = payload("relative-window", false);
    job.request.conversationId = "host-alias";
    await executeHostProgressivePreparation(job, { provider, isCancelled: () => false, onActive: () => {}, onProgress: async () => {} });
    const state = JSON.parse(await fs.readFile(path.join(job.directory, "ready.json"), "utf8"));
    const cache = await openProgressiveCache({ root: state.current.directory, source: state.current.source });
    const status = await cache.status();
    assert.equal(status.complete, false);
    assert.equal(status.relativeReadyRounds, 2);
    assert.equal(state.phase, "requested-range-ready");
    assert.equal(state.requestedRangeComplete, false);
    assert.equal(state.current.source.conversationId, "host-alias");
});

test("round projection preserves selected annotations and semantic tool roles", () => {
    const input = projection([1]);
    input.messages[0]!.annotations = [{ selectedText: "selected", comment: "note" }];
    input.messages.push({ id: "tool", round: 1, role: "tool", text: "tool result", position: { ordinal: 9 } });
    const [round] = hostProjectionRounds(input);
    assert.deepEqual(round!.userMessages![0]!.annotations, input.messages[0]!.annotations);
    assert.equal(round!.semanticEvents!.at(-1)!.semanticRole, "tool");
});
