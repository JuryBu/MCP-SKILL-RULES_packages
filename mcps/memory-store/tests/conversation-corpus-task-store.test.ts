import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { corpusTaskDirectory, loadCorpusTask, readCorpusTaskCommitRange, writeCorpusJson, writeCorpusTaskCommits,
    type CorpusTaskCommit, type CorpusTaskStoredState } from "../src/conversation-corpus-task-store.js";

test("bounded commit batches retain exact order, newest records and integrity rejection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-store-batches-"));
    const identity = { root, ownerId: "fixture-owner", taskId: "corpus-10000000-0000-4000-8000-000000000001" };
    const directory = corpusTaskDirectory(identity);
    const request = { query: "fixture" };
    const state = { version: 1, ...identity, requestHash: createHash("sha256").update(JSON.stringify(request)).digest("hex"), secret: "fixture-secret", status: "partial", phase: "idle", revision: 37, discoveryComplete: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", checkpointEveryMessages: 256, checkpointIntervalMs: 250, computeMs: 0 };
    const commit = (revision: number) => ({ revision, conversationId: revision % 2 ? "first" : "second", complete: true, result: null, scannedMessages: revision, mirrorMessagesSkipped: 0, sourceBytes: revision, warnings: [], changed: false, queryComputeMs: revision });
    const commitPath = (revision: number) => path.join(directory, "commits", `${String(revision).padStart(12, "0")}.json`);
    try {
        await writeCorpusJson(path.join(directory, "state.json"), state);
        await writeCorpusJson(path.join(directory, "request.json"), request);
        await writeCorpusJson(path.join(directory, "candidates.json"), ["first", "second"].map(id => ({ id, title: id, source: "codex", workspace: root })));
        for (let revision = 1; revision <= 37; revision++) await writeCorpusJson(commitPath(revision), commit(revision));
        const loaded = await loadCorpusTask(identity);
        assert.deepEqual(loaded.commits.map(entry => entry.revision), Array.from({ length: 37 }, (_, index) => index + 1));
        assert.equal(loaded.records.get("first")?.revision, 37);
        assert.equal(loaded.records.get("second")?.revision, 36);
        assert.equal(loaded.state.computeMs, 37);
        await writeCorpusJson(commitPath(17), { ...commit(17), revision: 18 });
        await assert.rejects(loadCorpusTask(identity), { code: "CORPUS_TASK_CORRUPT" });
        await writeCorpusJson(commitPath(17), { ...commit(17), conversationId: "unknown" });
        await assert.rejects(loadCorpusTask(identity), { code: "CORPUS_TASK_CORRUPT" });
        await writeCorpusJson(commitPath(17), commit(17));
        await fs.unlink(commitPath(16));
        await assert.rejects(loadCorpusTask(identity), { code: "CORPUS_TASK_CORRUPT" });
        await assert.rejects(loadCorpusTask({ ...identity, ownerId: "another-owner" }), { code: "CORPUS_TASK_NOT_FOUND" });
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test("mixed legacy commits and immutable batches recover stale state and reject gaps, overlaps and foreign identities", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-store-segments-"));
    const identity = { root, ownerId: "fixture-owner", taskId: "corpus-10000000-0000-4000-8000-000000000002" };
    const directory = corpusTaskDirectory(identity);
    const request = { query: "fixture" };
    const state: CorpusTaskStoredState = { version: 1, ownerId: identity.ownerId, taskId: identity.taskId,
        requestHash: createHash("sha256").update(JSON.stringify(request)).digest("hex"), secret: "fixture-secret", status: "partial", phase: "idle",
        revision: 0, discoveryComplete: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        checkpointEveryMessages: 256, checkpointIntervalMs: 250, computeMs: 0, commitBatchSize: 16,
        semanticVersion: { query: "fixture-query-v1", provider: "fixture-provider-v1" } };
    const commit = (revision: number): CorpusTaskCommit => ({ revision, conversationId: revision % 2 ? "first" : "second", complete: true,
        result: null, scannedMessages: revision, mirrorMessagesSkipped: 0, sourceBytes: revision, warnings: [], changed: false,
        queryComputeMs: revision, semanticVersion: state.semanticVersion });
    try {
        await writeCorpusJson(path.join(directory, "state.json"), state);
        await writeCorpusJson(path.join(directory, "request.json"), request);
        await writeCorpusJson(path.join(directory, "candidates.json"), ["first", "second"].map(id => ({ id, title: id, source: "codex", workspace: "fixture" })));
        await fs.mkdir(path.join(directory, "commits"));
        const task = await loadCorpusTask(identity);
        for (const [first, last] of [[1, 1], [2, 17], [18, 33], [34, 34]]) {
            await writeCorpusTaskCommits(task, Array.from({ length: last! - first! + 1 }, (_, index) => commit(first! + index)));
            task.state.revision = last!;
        }
        await fs.writeFile(path.join(directory, "commits", "000000000035-000000000040.batch.json.fixture.tmp"), "{", "utf8");
        const recovered = await loadCorpusTask(identity);
        assert.equal(recovered.state.revision, 34);
        assert.equal(recovered.state.computeMs, 34);
        assert.equal(recovered.records.get("first")!.revision, 33);
        assert.deepEqual((await readCorpusTaskCommitRange(task, 16, 20)).map(entry => entry.revision), [16, 17, 18, 19, 20]);
        const filename = path.join(directory, "commits", "000000000002-000000000017.batch.json");
        const original = await fs.readFile(filename, "utf8");
        const batch = JSON.parse(original);
        for (const damaged of [{ ...batch, ownerId: "foreign-owner" }, { ...batch, taskId: "foreign-task" },
            { ...batch, requestHash: "foreign-request" }, { ...batch, firstRevision: 3 },
            { ...batch, commits: batch.commits.map((entry: CorpusTaskCommit, index: number) => index === 4 ? { ...entry, revision: 40 } : entry) },
            { ...batch, commits: batch.commits.map((entry: CorpusTaskCommit, index: number) => index === 4 ? { ...entry, semanticVersion: { query: "", provider: null } } : entry) }]) {
            await writeCorpusJson(filename, damaged);
            await assert.rejects(loadCorpusTask(identity), { code: "CORPUS_TASK_CORRUPT" });
            await assert.rejects(readCorpusTaskCommitRange(task, 2, 17), { code: "CORPUS_TASK_CORRUPT" });
        }
        await fs.writeFile(filename, original, "utf8");
        const overlap = path.join(directory, "commits", "000000000009.json");
        await writeCorpusJson(overlap, commit(9));
        await assert.rejects(loadCorpusTask(identity), { code: "CORPUS_TASK_CORRUPT" });
        await fs.unlink(overlap);
        await fs.unlink(filename);
        await assert.rejects(loadCorpusTask(identity), { code: "CORPUS_TASK_CORRUPT" });
        await assert.rejects(readCorpusTaskCommitRange(task, 1, 20), { code: "CORPUS_TASK_CORRUPT" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
