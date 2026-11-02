import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import type { CorpusConversation, CorpusProjection, CorpusProjectionChunk, CorpusRangeProvider } from "../src/conversation-corpus-types.js";
import type { ProgressiveReadyState, ProgressiveTaskPayload } from "../src/conversation-progressive-task-types.js";
import type { ProgressiveCache, ProgressiveWriter } from "../src/conversation-progressive-types.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "progressive-hosts-adversarial-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const { executeHostProgressivePreparation } = await import("../src/conversation-progressive-worker-hosts.js");
const { createMultiCorpusProvider } = await import("../src/conversation-corpus-reader-multi.js");
const { openProgressiveCache } = await import("../src/conversation-progressive-cache.js");
const { writeProgressiveState, getProgressiveTaskStatus, openProgressiveTaskCache } = await import("../src/conversation-progressive-task.js");
const { runProgressiveAction } = await import("../src/tools/conversation-progressive-tool.js");
after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith("progressive-hosts-adversarial-"));
    await fs.rm(root, { recursive: true, force: true });
});

const conversation: CorpusConversation = { id: "dsh-target", title: "isolated fixture", source: "dsh", workspace: root };
const hash = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(complete => { resolve = complete; });
    return { promise, resolve };
};

function projection(indices: number[], options: Partial<CorpusProjection> = {}): CorpusProjection {
    return { conversation, revision: "verified-r1", complete: false, requestedRangeComplete: true, roundNumbering: "absolute", totalRounds: 100,
        warnings: [], messages: indices.flatMap(round => [
            { id: `user-${round}`, round, role: "user" as const, text: `question ${round}`, position: { ordinal: round * 2 } },
            { id: `assistant-${round}`, round, role: "assistant" as const, text: `answer ${round}`, position: { ordinal: round * 2 + 1 } },
        ]), ...options };
}

async function payload(name: string, options: Partial<ProgressiveTaskPayload["request"]> = {}): Promise<ProgressiveTaskPayload> {
    const taskId = `progressive-${crypto.randomUUID()}`;
    const ownerId = `owner-${name}`;
    const directory = path.join(root, "data", "progressive-tasks", hash(ownerId), taskId);
    const job: ProgressiveTaskPayload = { version: 1, taskId, directory,
        request: { ownerId, conversationId: conversation.id, dataChain: "dsh", initialRounds: 2, buildFull: true, direction: "latest",
            messageRoles: ["user", "assistant"], depth: "normal", ...options } };
    await writeProgressiveState(path.join(directory, "request.json"), { version: 1, payload: job, attempt: 1, backgroundTaskId: `${taskId}-1` });
    return job;
}

const identity = (job: ProgressiveTaskPayload) => ({ ownerId: job.request.ownerId, taskId: job.taskId });
const stateFor = async (job: ProgressiveTaskPayload): Promise<ProgressiveReadyState> => JSON.parse(await fs.readFile(path.join(job.directory, "ready.json"), "utf8"));
const control = (provider: CorpusRangeProvider) => ({ provider, isCancelled: () => false, onActive: () => {}, onProgress: async () => {} });
const providerFor = (fast: CorpusProjection, full: CorpusProjection): CorpusRangeProvider => ({ list: async () => [conversation],
    readFast: async () => fast, readRounds: async () => full, read: async () => full });

test("a complete source cache cut to a two-round window does not finish the progressive source", async () => {
    const job = await payload("complete-cut", { buildFull: false });
    await executeHostProgressivePreparation(job, control(providerFor(projection([99, 100], { complete: true }), projection([]))));
    const status = await getProgressiveTaskStatus(identity(job)) as { fullSourceComplete: boolean };
    assert.equal(status.fullSourceComplete, false);
    const { cache } = await openProgressiveTaskCache(identity(job));
    assert.deepEqual((await cache.read({ direction: "oldest" })).rows.map(row => row.round.roundIndex), [99, 100]);
});

test("verified full-prefix publication must retain the original latest ready window until its coverage is available", async context => {
    const job = await payload("prefix-switch");
    const gate = deferred();
    const prefixReady = deferred();
    const provider = providerFor(projection([99, 100]), projection([]));
    provider.read = async (_candidate, readControl) => {
        await readControl.onChunk?.({ ...projection([1, 2], { totalRounds: undefined, requestedRangeComplete: undefined }), verified: true });
        prefixReady.resolve();
        await gate.promise;
        return projection(Array.from({ length: 100 }, (_, index) => index + 1), { complete: true });
    };
    const running = executeHostProgressivePreparation(job, control(provider));
    try {
        await prefixReady.promise;
        const response = await runProgressiveAction({ action: "read_ready", conversationId: job.request.ownerId, taskId: job.taskId, dataChain: "dsh", lastRounds: 2 }) as {
            rounds: Array<{ round: number }>; requestedRangeComplete: boolean; sourceRangeVerified?: boolean; publishedRangeComplete?: boolean;
        };
        context.diagnostic(JSON.stringify({ observedRounds: response.rounds.map(row => row.round), requestedRangeComplete: response.requestedRangeComplete,
            sourceRangeVerified: response.sourceRangeVerified, publishedRangeComplete: response.publishedRangeComplete }));
        assert.deepEqual(response.rounds.map(row => row.round), [99, 100]);
    } finally { gate.resolve(); await running; }
});

test("multi-provider verified chunks from a different source and ID must never enter this task's ready generations", async context => {
    const job = await payload("wrong-chunk");
    const gate = deferred();
    const foreignReady = deferred();
    const backend = providerFor(projection([3, 4], { totalRounds: 4 }), projection([1, 2, 3, 4], { complete: true, totalRounds: 4 }));
    backend.read = async (_candidate, readControl) => {
        try {
            await readControl.onChunk?.({ ...projection([1, 2], { conversation: { ...conversation, id: "foreign-target", source: "claude-code" },
                revision: "foreign-verified-r1", totalRounds: undefined, requestedRangeComplete: undefined,
                messages: [1, 2].map(round => ({ id: `foreign-${round}`, round, role: "user" as const, text: "FOREIGN PRIVATE BODY", position: { ordinal: round } })) }), verified: true });
        } finally { foreignReady.resolve(); }
        await gate.promise;
        return projection([1, 2, 3, 4], { complete: true, totalRounds: 4 });
    };
    const provider = createMultiCorpusProvider({ providers: { dsh: backend } });
    const running = executeHostProgressivePreparation(job, control(provider));
    const completion = running.then(() => undefined, error => error);
    let foreignRef: string | undefined;
    try {
        await foreignReady.promise;
        const state = await stateFor(job);
        const { cache } = await openProgressiveTaskCache(identity(job));
        const rows = await cache.read();
        foreignRef = rows.rows.find(row => row.messages.some(message => message.text.includes("FOREIGN PRIVATE BODY")))?.ref;
        context.diagnostic(JSON.stringify({ boundHost: state.current!.source.host, boundId: state.current!.source.conversationId,
            actualForeignBody: rows.messages.some(message => message.text.includes("FOREIGN PRIVATE BODY")) }));
        assert.equal(rows.messages.some(message => message.text.includes("FOREIGN PRIVATE BODY")), false);
    } finally {
        gate.resolve();
        await completion;
        if (foreignRef) {
            const retained = await openProgressiveTaskCache(identity(job), foreignRef);
            context.diagnostic(JSON.stringify({ foreignRefRemainsAfterValidFinal: retained.row!.messages.some(message => message.text.includes("FOREIGN PRIVATE BODY")) }));
        }
    }
});

test("a requested canonicalId distinct from the candidate ID is a valid explicitly selected target", async () => {
    const target = { ...conversation, id: "local-word-id", canonicalId: "canonical-session-id", aliases: [] };
    const job = await payload("canonical-lookup", { conversationId: target.canonicalId, buildFull: false });
    const input = projection([1, 2], { conversation: target, complete: true, totalRounds: 2 });
    const provider: CorpusRangeProvider = { list: async () => [target], readFast: async () => input, readRounds: async () => input, read: async () => input };
    await executeHostProgressivePreparation(job, control(provider));
    const state = await stateFor(job);
    assert.equal(state.current!.source.conversationId, target.canonicalId);
});

test("relative alias refs remain bound to their old verified generation after a full revision change and warm rerun", async () => {
    const alias = "requested-alias";
    const job = await payload("relative-revision", { conversationId: alias });
    const gate = deferred();
    const windowReady = deferred();
    const provider = providerFor(projection([1, 2], { roundNumbering: "relative", totalRounds: undefined }),
        projection([1, 2, 3, 4], { revision: "verified-r2", totalRounds: 4, complete: true }));
    provider.list = async () => [{ ...conversation, aliases: [alias] }];
    const readFull = provider.read;
    provider.read = async (candidate, readControl) => { windowReady.resolve(); await gate.promise; return readFull(candidate, readControl); };
    const running = executeHostProgressivePreparation(job, control(provider));
    await windowReady.promise;
    const initial = await openProgressiveTaskCache(identity(job));
    const oldRows = await initial.cache.read();
    const oldRef = oldRows.rows[0]!.ref;
    assert.equal(oldRows.rows[0]!.kind, "relative");
    gate.resolve();
    await running;
    const current = await openProgressiveTaskCache(identity(job));
    assert.equal((await current.cache.status()).complete, true);
    const old = await openProgressiveTaskCache(identity(job), oldRef);
    assert.equal(old.row!.ref, oldRef);
    assert.equal(old.cache.sourceKey, initial.cache.sourceKey);
    assert.notEqual(current.cache.sourceKey, old.cache.sourceKey);
    assert.equal((await current.cache.status()).source.conversationId, alias);
    await executeHostProgressivePreparation(job, control(provider));
    assert.equal((await (await openProgressiveTaskCache(identity(job))).cache.status()).complete, true);
    assert.equal((await openProgressiveTaskCache(identity(job), oldRef)).row!.ref, oldRef);
});

test("empty canonical rounds and assistant-only projection preserve exact full coverage without user bodies", async () => {
    const job = await payload("empty-rounds", { initialRounds: 3, messageRoles: ["assistant"] });
    const input = projection([2, 3], { complete: true, totalRounds: 3 });
    input.rounds = [1, 2, 3].map(roundIndex => ({ roundIndex, startStep: roundIndex, endStep: roundIndex, userMessage: roundIndex === 2 ? "PRIVATE USER" : "",
        userMessages: roundIndex === 2 ? [{ text: "PRIVATE USER", stepIndex: 2 }] : [],
        aiResponses: roundIndex === 3 ? [{ stepIndex: 3, response: "answer", thinking: "", toolCalls: [] }] : [],
        toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [] }));
    input.messages = [{ id: "u2", round: 2, role: "user", text: "PRIVATE USER", position: { ordinal: 2 } },
        { id: "a3", round: 3, role: "assistant", text: "answer", position: { ordinal: 3 } }];
    await executeHostProgressivePreparation(job, control(providerFor(input, input)));
    const { cache } = await openProgressiveTaskCache(identity(job));
    const rows = await cache.read({ direction: "oldest" });
    assert.equal(rows.status.complete, true);
    assert.deepEqual(rows.rows.map(row => row.round.roundIndex), [1, 2, 3]);
    assert.deepEqual(rows.messages.map(message => message.role), ["assistant"]);
    assert.equal(JSON.stringify(rows.rows).includes("PRIVATE USER"), false);
});

test("a pending final revision is rejected while earlier verified refs stay readable", async () => {
    const job = await payload("pending-final");
    const provider = providerFor(projection([3, 4], { totalRounds: 4 }), projection([1, 2, 3, 4], { revision: "pending:source-r2", complete: true, totalRounds: 4 }));
    await assert.rejects(executeHostProgressivePreparation(job, control(provider)), /Unverified source revisions/u);
    const { cache } = await openProgressiveTaskCache(identity(job));
    const rows = await cache.read({ direction: "oldest" });
    assert.deepEqual(rows.rows.map(row => row.round.roundIndex), [3, 4]);
    assert.equal(rows.status.complete, false);
    assert.equal((await cache.locate(rows.rows[0]!.ref)).ref, rows.rows[0]!.ref);
});

test("an oversized single canonical round fails explicitly and clears its active writer and temporary block", async () => {
    const job = await payload("large-round", { buildFull: false, initialRounds: 1 });
    const input = projection([1], { totalRounds: 1, complete: true });
    input.messages[0]!.text = "x".repeat(5 * 1024 * 1024);
    let active: { cache: ProgressiveCache; writer: ProgressiveWriter } | undefined;
    await assert.rejects(executeHostProgressivePreparation(job, { ...control(providerFor(input, input)), onActive: value => { active = value; } }), /Single canonical round 1 exceeds/u);
    assert.equal(active, undefined);
    const ranges = path.join(job.directory, "ranges");
    for (const directory of await fs.readdir(ranges)) {
        const entries = await fs.readdir(path.join(ranges, directory));
        assert.equal(entries.some(entry => entry.startsWith("pending-") || entry.endsWith(".tmp")), false);
        const manifest = JSON.parse(await fs.readFile(path.join(ranges, directory, "manifest.json"), "utf8"));
        assert.equal(manifest.state, "cancelled");
        assert.equal(manifest.writer, undefined);
    }
});

test("reader failure must settle already admitted concurrent onChunk publication before returning control", async context => {
    const job = await payload("publication-drain");
    const gate = deferred();
    const publishing = deferred();
    let flight: Promise<unknown> = Promise.resolve();
    let active: { cache: ProgressiveCache; writer: ProgressiveWriter } | undefined;
    let settled = false;
    let executionSettled = false;
    const provider = providerFor(projection([3, 4], { totalRounds: 4 }), projection([]));
    provider.read = async (_candidate, readControl) => {
        flight = Promise.resolve(readControl.onChunk?.({ ...projection([1, 2], { totalRounds: undefined }), verified: true }));
        void flight.then(() => { settled = true; }, () => { settled = true; });
        await publishing.promise;
        throw new Error("Reader failed after admitting a chunk");
    };
    const running = executeHostProgressivePreparation(job, { ...control(provider), onActive: value => { active = value; },
        onProgress: async value => {
            if ((value as { stage?: string }).stage === "publishing-full-ranges") { publishing.resolve(); await gate.promise; }
        } }).then(() => { executionSettled = true; return undefined; }, error => { executionSettled = true; return error; });
    try {
        await publishing.promise;
        await sleep(10);
        context.diagnostic(JSON.stringify({ executionSettledBeforePublication: executionSettled, publicationSettled: settled, activeWriter: Boolean(active) }));
        assert.equal(executionSettled, false);
    } finally {
        const cancelledByOuterCleanup = executionSettled && Boolean(active);
        if (cancelledByOuterCleanup && active) await active.cache.cancel(active.writer);
        gate.resolve();
        const publicationOutcome = await flight.then(() => "settled", error => `${(error as { code?: string }).code}: ${String(error)}`);
        context.diagnostic(JSON.stringify({ cancelledByOuterCleanup, publicationOutcome }));
        const error = await running;
        assert.match(String(error), /Reader failed/u);
        if (active) await active.cache.cancel(active.writer).catch(() => undefined);
        await sleep(5);
    }
});

test("cancellation preserves the original relative ref and a late verified chunk cannot publish new ready data", async () => {
    const job = await payload("cancel-ref");
    let cancelled = false;
    let active: { cache: ProgressiveCache; writer: ProgressiveWriter } | undefined;
    let oldRef = "";
    let lateChunk: ((chunk: CorpusProjectionChunk) => void | Promise<void>) | undefined;
    const provider = providerFor(projection([1, 2], { roundNumbering: "relative", totalRounds: undefined }), projection([]));
    provider.read = async (_candidate, readControl) => {
        const { cache } = await openProgressiveTaskCache(identity(job));
        oldRef = (await cache.read({ direction: "oldest" })).rows[0]!.ref;
        lateChunk = readControl.onChunk;
        await readControl.onChunk?.({ ...projection([1, 2], { totalRounds: undefined }), verified: true });
        throw new Error("Source cancelled");
    };
    await assert.rejects(executeHostProgressivePreparation(job, { ...control(provider), isCancelled: () => cancelled,
        onActive: value => { active = value; }, onProgress: async value => {
            if ((value as { stage?: string }).stage === "publishing-full-ranges") cancelled = true;
        } }), /cancelled/u);
    assert.equal(active, undefined);
    assert.equal((await openProgressiveTaskCache(identity(job), oldRef)).row!.kind, "relative");
    const before = await fs.readFile(path.join(job.directory, "ready.json"), "utf8");
    await Promise.resolve(lateChunk!({ ...projection([3, 4]), verified: true })).catch(error => { assert.match(String(error), /cancelled|closed/u); });
    assert.equal(await fs.readFile(path.join(job.directory, "ready.json"), "utf8"), before);
});
