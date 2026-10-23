import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";
import type { CorpusMessage, CorpusProvider } from "../src/conversation-corpus-types.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-performance-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const { startCorpusSearch, getCorpusSearchStatus, cancelCorpusSearch, resumeCorpusSearch } = await import("../src/conversation-corpus-task.js");
const { searchCorpusProjection } = await import("../src/conversation-corpus-search.js");
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
}

test("a slow cached check cannot hold back later ready cached results", async () => {
    const slow = gate();
    const entered = gate();
    const candidates = ["a-slow", "b-ready", "c-ready"].map(id => ({ id, title: id, source: "codex" as const, workspace: "/fixture" }));
    const provider: CorpusProvider = {
        async list() { return candidates; },
        async readCached(conversation) {
            if (conversation.id === "a-slow") { entered.release(); await slow.promise; }
            return { conversation, revision: "same", complete: true, warnings: [], messages: [{ id: conversation.id, round: 1, role: "user", text: "cache", position: { ordinal: 1 } }] };
        },
        async read() { throw new Error("Every source is cached"); },
    };
    const root = path.join(temporary, "slow-cache-check");
    let status = await startCorpusSearch({ ownerId: "slow-cache-owner", request: { query: "cache" }, provider, root });
    const identity = { ownerId: status.ownerId, taskId: status.taskId, root };
    try {
        await entered.promise;
        const deadline = performance.now() + 500;
        do { status = await getCorpusSearchStatus({ ...identity, waitMs: 50, limit: 10 }); } while (!status.totalMatches && performance.now() < deadline);
        assert.ok(status.totalMatches > 0, "Ready results were held behind a blocked earlier cache check");
        assert.ok(status.results.some(result => result.conversation.id === "b-ready"));
    } finally {
        slow.release();
        while (status.status === "running" || status.status === "cancelling") status = await getCorpusSearchStatus({ ...identity, waitMs: 100, limit: 10 });
    }
    assert.equal(status.status, "completed");
    assert.equal(status.totalMatches, 3);
});

test("mixed deferred rebuilding cancels and resumes the same task without recounting cached results", async () => {
    const reading = gate();
    const releaseRead = gate();
    const candidates = ["a-cold", "b-cached", "c-cold"].map(id => ({ id, title: id, source: "codex" as const, workspace: "/fixture" }));
    const reads: string[] = [];
    const projection = (conversation: typeof candidates[number]) => ({ conversation, revision: "same", complete: true, warnings: [], messages: [{ id: conversation.id, round: 1, role: "user" as const, text: "cache", position: { ordinal: 1 } }] });
    const provider: CorpusProvider = {
        async list() { return candidates; },
        async readCached(conversation) { return conversation.id === "b-cached" ? projection(conversation) : null; },
        async read(conversation) {
            reads.push(conversation.id);
            if (reads.length === 1) { reading.release(); await releaseRead.promise; }
            return projection(conversation);
        },
    };
    const root = path.join(temporary, "mixed-deferred-cancel");
    let status = await startCorpusSearch({ ownerId: "mixed-cache-owner", request: { query: "cache" }, provider, root });
    const identity = { ownerId: status.ownerId, taskId: status.taskId, root };
    try {
        await reading.promise;
        status = await getCorpusSearchStatus({ ...identity, limit: 10 });
        assert.equal(status.coverage.committedConversations, 1);
        assert.equal(status.totalMatches, 1);
        await cancelCorpusSearch(identity);
    } finally { releaseRead.release(); }
    do { status = await getCorpusSearchStatus({ ...identity, waitMs: 100, limit: 10 }); } while (status.status === "running" || status.status === "cancelling");
    assert.equal(status.status, "cancelled");
    status = await resumeCorpusSearch({ ...identity, provider });
    while (status.status === "running") status = await getCorpusSearchStatus({ ...identity, waitMs: 100, limit: 10 });
    assert.equal(status.taskId, identity.taskId);
    assert.equal(status.status, "completed");
    assert.equal(status.totalMatches, 3);
    assert.equal(status.coverage.scannedMessages, 3);
    assert.deepEqual(reads, ["a-cold", "a-cold", "c-cold"]);
});

test("synthetic query scan retains all 50000 message identities and rounds", () => {
    const messages: CorpusMessage[] = Array.from({ length: 50000 }, (_, index) => ({
        id: `message-${index}`, round: index + 1, role: "user", text: "缓存 Cache cache hello world".repeat(4),
        position: { ordinal: index }, timestamp: "2026-01-01T00:00:00Z",
    }));
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const result = searchCorpusProjection({
        conversation: { id: "synthetic", title: "synthetic", source: "codex", workspace: "/fixture" },
        revision: "source-one", messages, complete: true, warnings: [],
    }, { allTerms: ["缓存", "cache"] })!;
    const elapsedMs = performance.now() - started;
    assert.equal(result.matchedMessages, 50000);
    assert.equal(result.rounds.length, 50000);
    assert.deepEqual(result.termCounts, { "缓存": 200000, cache: 400000 });
    console.log(JSON.stringify({ benchmark: "synthetic-query-50000", startedAt, finishedAt: new Date().toISOString(), queryWallMs: elapsedMs, rssBytes: process.memoryUsage().rss }));
});

test("synthetic 1000 conversations persist completely and page from final snapshot", async () => {
    const candidates = Array.from({ length: 1000 }, (_, index) => ({ id: `conversation-${String(index).padStart(4, "0")}`, title: "synthetic", source: "codex" as const, workspace: "/fixture" }));
    let reads = 0;
    const provider: CorpusProvider = {
        async list() { return candidates; },
        async read(conversation) {
            reads++;
            return {
                conversation, revision: "source-one", complete: true, warnings: [],
                messages: [{ id: `${conversation.id}-message`, round: 1, role: "user", text: "缓存 cache", position: { ordinal: 1 } }],
            };
        },
    };
    const root = path.join(temporary, "tasks");
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const task = await startCorpusSearch({ ownerId: "benchmark-owner", request: { query: "缓存" }, provider, root });
    const identity = { ownerId: task.ownerId, taskId: task.taskId, root };
    let final = task;
    for (let attempt = 0; attempt < 3000; attempt++) {
        final = await getCorpusSearchStatus({ ...identity, waitMs: 100, limit: 1 });
        if (final.status === "completed") break;
        assert.equal(final.status, "running");
    }
    const finishedAt = new Date().toISOString();
    const taskWallMs = performance.now() - started;
    assert.equal(final.status, "completed");
    assert.equal(reads, 1000);
    assert.equal(final.coverage.committedConversations, 1000);
    assert.equal(final.totalMatches, 1000);
    const pageStart = performance.now();
    const page = await getCorpusSearchStatus({ ...identity, cursor: final.nextCursor, limit: 100 });
    const finalPageMs = performance.now() - pageStart;
    assert.equal(page.results.length, 100);
    console.log(JSON.stringify({ benchmark: "synthetic-persist-1000", startedAt, finishedAt, taskWallMs, queryComputeMs: final.timings.queryComputeMs, finalPageMs, rssBytes: process.memoryUsage().rss }));
});

test("ready cached results commit before an earlier uncached conversation starts rebuilding", async () => {
    const candidates = ["a-cold", "b-cached", "c-cold"].map(id => ({ id, title: id, source: "codex" as const, workspace: "/fixture" }));
    let cachedMessagesRead = false;
    const cachedMessages: CorpusMessage[] = [{ id: "cached-message", round: 9, role: "user", text: "缓存 cache", position: { ordinal: 4 } }];
    const coldReads: string[] = [];
    const provider: CorpusProvider = {
        async list() { return candidates; },
        async readCached(conversation) {
            return conversation.id === "b-cached" ? {
                conversation, revision: "source-one", complete: true, warnings: [],
                get messages() { cachedMessagesRead = true; return cachedMessages; },
            } : null;
        },
        async read(conversation) {
            assert.equal(cachedMessagesRead, true, "A cache miss must not block already reusable results");
            coldReads.push(conversation.id);
            return { conversation, revision: "source-one", complete: true, warnings: [], messages: [{ id: `${conversation.id}-message`, round: 1, role: "user", text: "缓存 cache", position: { ordinal: 1 } }] };
        },
    };
    const root = path.join(temporary, "ready-cache-tasks");
    let status = await startCorpusSearch({ ownerId: "ready-cache-owner", request: { query: "缓存" }, provider, root });
    while (status.status === "running") status = await getCorpusSearchStatus({ ownerId: status.ownerId, taskId: status.taskId, root, waitMs: 100, limit: 10 });
    assert.equal(status.status, "completed");
    assert.equal(status.totalMatches, 3);
    assert.equal(status.coverage.committedConversations, 3);
    assert.deepEqual(coldReads, ["a-cold", "c-cold"]);
});

test("all cache misses keep cold reads serial and expose the cache-check cost", async () => {
    const candidates = Array.from({ length: 64 }, (_, index) => ({ id: `miss-${String(index).padStart(2, "0")}`, title: "miss", source: "codex" as const, workspace: "/fixture" }));
    let checks = 0;
    let firstColdChecks = 0;
    let activeReads = 0;
    let maxReads = 0;
    const started = performance.now();
    let firstColdMs = 0;
    const provider: CorpusProvider = {
        async list() { return candidates; },
        async readCached() { checks++; return null; },
        async read(conversation) {
            if (!firstColdChecks) { firstColdChecks = checks; firstColdMs = performance.now() - started; }
            activeReads++;
            maxReads = Math.max(maxReads, activeReads);
            await new Promise<void>(resolve => setImmediate(resolve));
            activeReads--;
            return { conversation, revision: "same", complete: true, warnings: [], messages: [{ id: conversation.id, round: 1, role: "user", text: "cache", position: { ordinal: 1 } }] };
        },
    };
    const root = path.join(temporary, "all-cache-misses");
    let status = await startCorpusSearch({ ownerId: "all-misses-owner", request: { query: "cache" }, provider, root });
    while (status.status === "running") status = await getCorpusSearchStatus({ ownerId: status.ownerId, taskId: status.taskId, root, waitMs: 100, limit: 1 });
    assert.equal(status.status, "completed");
    assert.equal(status.totalMatches, 64);
    assert.equal(checks, 64);
    assert.equal(firstColdChecks, 64);
    assert.equal(maxReads, 1);
    console.log(JSON.stringify({ benchmark: "all-cache-misses-64", firstColdChecks, firstColdMs }));
});
