import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startCorpusSearch, getCorpusSearchStatus, cancelCorpusSearch, resumeCorpusSearch } from "../src/conversation-corpus-task.ts";
import type { CorpusProjection, CorpusProvider } from "../src/conversation-corpus-types.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-prefetch-"));
after(() => fs.rmSync(directory, { recursive: true, force: true }));
function projection(index: number): CorpusProjection {
    const id = `conversation-${index}`;
    return { conversation: { id, title: id, workspace: "fixture", source: "codex" }, revision: "fixture-v1", complete: true, warnings: [],
        messages: [{ id, round: 1, role: "user", text: "缓存", position: { ordinal: 1 } }] };
}
async function waitFor(identity: Parameters<typeof getCorpusSearchStatus>[0], predicate: (state: Awaited<ReturnType<typeof getCorpusSearchStatus>>) => boolean) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const state = await getCorpusSearchStatus({ ...identity, waitMs: 20 });
        if (predicate(state)) return state;
    }
    throw new Error("Prefetch task did not reach expected state");
}

test("cache prefetch is bounded, preserves exact counts and serial durable commits", async () => {
    const items = Array.from({ length: 12 }, (_, index) => projection(index));
    let active = 0;
    let peak = 0;
    let sourceReads = 0;
    const provider: CorpusProvider = {
        async list() { return items.map(item => item.conversation); },
        async readCached(candidate) {
            peak = Math.max(peak, ++active);
            await delay(15);
            active--;
            return items.find(item => item.conversation.id === candidate.id)!;
        },
        async read() { sourceReads++; throw new Error("Hot cache must avoid source parsing"); },
    };
    const root = path.join(directory, "bounded");
    const started = await startCorpusSearch({ ownerId: "fixture-owner", root, request: { query: "缓存" }, provider });
    const identity = { ownerId: started.ownerId, taskId: started.taskId, root };
    const finished = await waitFor(identity, state => state.status === "completed");
    assert.equal(peak, 4);
    assert.equal(active, 0);
    assert.equal(sourceReads, 0);
    assert.equal(finished.coverage.scannedConversations, 12);
    assert.equal(finished.coverage.scannedMessages, 12);
    assert.equal(finished.totalMatches, 12);
    assert.equal(finished.revision, 12);
});

test("cancel drains every cache-only flight before terminal status and resumes without lost candidates", async () => {
    const items = Array.from({ length: 8 }, (_, index) => projection(index));
    let active = 0;
    let release: () => void = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const provider: CorpusProvider = {
        async list() { return items.map(item => item.conversation); },
        async readCached(candidate) { active++; await blocked; active--; return items.find(item => item.conversation.id === candidate.id)!; },
        async read() { throw new Error("Cache-only fixture must not parse a source"); },
    };
    const root = path.join(directory, "cancel");
    const started = await startCorpusSearch({ ownerId: "fixture-owner", root, request: { query: "缓存" }, provider });
    const identity = { ownerId: started.ownerId, taskId: started.taskId, root };
    for (let attempt = 0; active < 4 && attempt < 100; attempt++) await delay(5);
    assert.equal(active, 4);
    const cancelling = await cancelCorpusSearch(identity);
    assert.notEqual(cancelling.status, "cancelled");
    release();
    const cancelled = await waitFor(identity, state => state.status === "cancelled");
    assert.equal(active, 0);
    assert.equal(cancelled.totalMatches, 0);
    await resumeCorpusSearch({ ...identity, provider });
    const finished = await waitFor(identity, state => state.status === "completed");
    assert.equal(finished.totalMatches, 8);
    assert.equal(finished.coverage.scannedConversations, 8);
});

test("prefetched projection errors stay isolated to the exact candidate", async () => {
    const items = [projection(1), projection(2)];
    const provider: CorpusProvider = {
        async list() { return items.map(item => item.conversation); },
        async readCached(candidate) { if (candidate.id === items[0]!.conversation.id) throw new Error("fixture cache failure"); return items[1]!; },
        async read() { throw new Error("Unexpected source read"); },
    };
    const root = path.join(directory, "error");
    const started = await startCorpusSearch({ ownerId: "fixture-owner", root, request: { query: "缓存" }, provider });
    const finished = await waitFor({ ownerId: started.ownerId, taskId: started.taskId, root }, state => state.status === "partial");
    assert.equal(finished.totalMatches, 1);
    assert.equal(finished.coverage.errorConversations, 1);
    assert.equal(finished.coverage.errors[0]!.conversationId, items[0]!.conversation.id);
});

test("completed cache reads publish out of order without waiting for an earlier flight", async () => {
    const items = Array.from({ length: 4 }, (_, index) => projection(index));
    let release: () => void = () => {};
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const provider: CorpusProvider = {
        async list() { return items.map(item => item.conversation); },
        async readCached(candidate) {
            if (candidate.id === items[0]!.conversation.id) await blocked;
            return items.find(item => item.conversation.id === candidate.id)!;
        },
        async read() { throw new Error("Cache hit must avoid source parsing"); },
    };
    const root = path.join(directory, "out-of-order");
    const started = await startCorpusSearch({ ownerId: "fixture-owner", root, request: { query: "缓存" }, provider });
    const identity = { ownerId: started.ownerId, taskId: started.taskId, root };
    try {
        const progress = await waitFor(identity, state => state.revision === 3);
        assert.equal(progress.status, "running");
        assert.equal(progress.totalMatches, 3);
        assert.ok(progress.results.every(result => result.conversation.id !== items[0]!.conversation.id));
        const changes = await getCorpusSearchStatus({ ...identity, afterRevision: 0, limit: 2 });
        assert.equal(changes.changes!.throughRevision, 2);
        assert.equal(changes.changes!.upserts.length, 2);
        assert.equal(changes.changes!.hasMore, true);
    } finally { release(); }
    const finished = await waitFor(identity, state => state.status === "completed");
    const remaining = await getCorpusSearchStatus({ ...identity, afterRevision: 2 });
    assert.equal(finished.revision, 4);
    assert.equal(finished.totalMatches, 4);
    assert.equal(remaining.changes!.throughRevision, 4);
    assert.equal(new Set(remaining.changes!.upserts.map(result => result.conversation.id)).size, 2);
});

test("cache misses and failures resume only their uncommitted candidates", async () => {
    const items = Array.from({ length: 6 }, (_, index) => projection(index));
    const cachedReads: string[] = [];
    const sourceReads: string[] = [];
    let fail = true;
    const provider: CorpusProvider = {
        async list() { return items.map(item => item.conversation); },
        async readCached(candidate) {
            cachedReads.push(candidate.id);
            if (candidate.id === items[0]!.conversation.id && fail) throw new Error("fixture cache failure");
            return candidate.id === items[1]!.conversation.id ? null : items.find(item => item.conversation.id === candidate.id)!;
        },
        async read(candidate) {
            sourceReads.push(candidate.id);
            return items.find(item => item.conversation.id === candidate.id)!;
        },
    };
    const root = path.join(directory, "miss-retry");
    const started = await startCorpusSearch({ ownerId: "fixture-owner", root, request: { query: "缓存" }, provider });
    const identity = { ownerId: started.ownerId, taskId: started.taskId, root };
    const partial = await waitFor(identity, state => state.status === "partial");
    assert.equal(partial.coverage.errorConversations, 1);
    assert.equal(partial.totalMatches, 5);
    assert.deepEqual(sourceReads, [items[1]!.conversation.id]);
    cachedReads.length = 0;
    fail = false;
    await resumeCorpusSearch({ ...identity, provider });
    const finished = await waitFor(identity, state => state.status === "completed");
    assert.deepEqual(cachedReads, [items[0]!.conversation.id]);
    assert.equal(finished.revision, 7);
    assert.equal(finished.totalMatches, 6);
    const delta = await getCorpusSearchStatus({ ...identity, afterRevision: partial.revision });
    assert.deepEqual(delta.changes!.upserts.map(result => result.conversation.id), [items[0]!.conversation.id]);
});
