import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { after, test } from "node:test";
import type { CorpusProjection, CorpusProvider, CorpusSearchRequest } from "../src/conversation-corpus-types.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-preparation-test-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const { startCorpusPreparation } = await import("../src/conversation-corpus-preparation.js");
const { getCorpusSearchStatus, cancelCorpusSearch, resumeCorpusSearch, startCorpusSearch } = await import("../src/conversation-corpus-task.js");
const { compileCorpusSearch, searchCorpusProjection } = await import("../src/conversation-corpus-search.js");
const { corpusOwnerDirectory, corpusTaskDirectory } = await import("../src/conversation-corpus-task-store.js");
type Status = Awaited<ReturnType<typeof getCorpusSearchStatus>>;
type Identity = Parameters<typeof getCorpusSearchStatus>[0];
after(async () => { await sleep(30); fs.rmSync(temporary, { recursive: true, force: true }); });

function projection(id = "target", revision = "v1"): CorpusProjection {
    return {
        conversation: { id, title: id, workspace: "C:/fixture/private", source: "codex" },
        revision, complete: true, warnings: [], sourceBytes: 1234,
        messages: ["user", "assistant", "subagent"].map((role, index) => ({
            id: `${id}-${index}`, role: role as "user" | "assistant" | "subagent", round: index + 1,
            text: "fixture hit hit", position: { ordinal: index },
        })),
    };
}

function providerFor(input = projection()): CorpusProvider {
    return { async list() { return [input.conversation]; }, async read() { return input; } };
}

function identity(status: Status, root: string): Identity { return { ownerId: status.ownerId, taskId: status.taskId, root }; }

function indexDirectory(ownerId: string, conversationId: string, root: string): string {
    return path.join(corpusOwnerDirectory({ ownerId, root }), "preparations", crypto.createHash("sha256").update(conversationId).digest("hex"));
}

async function waitFor(options: Identity, predicate: (status: Status) => boolean = status => !["running", "cancelling"].includes(status.status)): Promise<Status> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const status = await getCorpusSearchStatus({ ...options, waitMs: 20 });
        if (predicate(status)) return status;
        await sleep(2);
    }
    throw new Error("Preparation fixture did not reach the expected state");
}

test("only a single-target preparation accepts no query and produces no synthetic matches", async () => {
    const request = compileCorpusSearch({ purpose: "prepare", conversationIds: ["target"], messageRoles: ["user"] });
    assert.equal(request.terms.length, 0);
    assert.deepEqual(request.request.messageRoles, ["user", "assistant", "subagent"]);
    assert.equal(searchCorpusProjection(projection(), request.request), null);
    for (const invalid of [{}, { conversationIds: ["target"] }, { purpose: "prepare" },
        { purpose: "prepare", conversationIds: [] }, { purpose: "prepare", conversationIds: ["a", "b"] },
        { purpose: "prepare", conversationIds: ["target"], query: "hit" }]) {
        assert.throws(() => compileCorpusSearch(invalid as CorpusSearchRequest));
    }
    await assert.rejects(startCorpusSearch({ ownerId: "caller", root: path.join(temporary, "empty-query"), request: {}, provider: providerFor() }));
});

test("full-body preparation retains progress, coverage and bytes without query compute or hits", async () => {
    const root = path.join(temporary, "coverage");
    let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    const input = projection();
    const provider: CorpusProvider = {
        async list(request) { assert.equal(request.query, undefined); assert.equal(request.purpose, "prepare"); return [input.conversation]; },
        async read(candidate, control) {
            assert.equal(candidate.id, "target");
            assert.deepEqual(control.messageRoles, ["user", "assistant", "subagent"]);
            control.onProgress?.({ phase: "projecting", bytes: 500, totalBytes: 1234 });
            await gate;
            return input;
        },
    };
    const started = await startCorpusPreparation({ ownerId: "caller", conversationId: "target", provider, root });
    const options = identity(started, root);
    try {
        const progress = await waitFor(options, status => status.progress?.bytes === 500);
        assert.equal(progress.progress?.totalBytes, 1234);
        assert.equal(progress.coverage.candidateConversations, 1);
        assert.deepEqual(progress.results, []);
    } finally { release(); }
    const complete = await waitFor(options);
    assert.equal(complete.status, "completed");
    assert.equal(complete.coverage.complete, true);
    assert.equal(complete.coverage.scannedMessages, 3);
    assert.equal(complete.coverage.sourceBytes, 1234);
    assert.equal(complete.timings.queryComputeMs, 0);
    assert.equal(complete.totalMatches, 0);
    assert.equal(complete.hasMore, false);
    assert.equal(complete.prepared?.kind, "conversation_body_projection");
    assert.equal(complete.prepared?.sourceRevision, "v1");
    assert.ok(complete.prepared?.commitPath && fs.existsSync(complete.prepared.commitPath));
    const changes = await getCorpusSearchStatus({ ...options, afterRevision: 0 });
    assert.deepEqual(changes.changes?.upserts, []);
    assert.deepEqual(changes.changes?.removedConversationIds, []);
    assert.equal(changes.changes?.throughRevision, complete.revision);
});

test("concurrent calls and later retries share the active same-owner same-target task", async () => {
    const root = path.join(temporary, "coalesce");
    let reads = 0;
    let lists = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    const input = projection();
    const provider: CorpusProvider = {
        async list() { lists++; return [input.conversation]; },
        async read() { reads++; await gate; return input; },
    };
    const options = { ownerId: "caller", conversationId: "target", root, provider };
    const statuses = await Promise.all(Array.from({ length: 16 }, () => startCorpusPreparation(options)));
    try {
        assert.equal(new Set(statuses.map(status => status.taskId)).size, 1);
        const retry = await startCorpusPreparation(options);
        assert.equal(retry.taskId, statuses[0].taskId);
        assert.equal(lists, 1);
        assert.equal(reads, 1);
    } finally { release(); }
    assert.equal((await waitFor(identity(statuses[0], root))).status, "completed");
});

test("owners and targets remain isolated and cancellation resumes with the same task ID", async () => {
    const root = path.join(temporary, "isolation");
    let hold = true;
    const provider: CorpusProvider = {
        async list(request) { return [projection(request.conversationIds![0]).conversation]; },
        async read(candidate, control) {
            while (hold && !control.isCancelled?.()) await sleep(2);
            return projection(candidate.id);
        },
    };
    const started = await Promise.all([
        startCorpusPreparation({ ownerId: "caller", conversationId: "target", root, provider }),
        startCorpusPreparation({ ownerId: "other", conversationId: "target", root, provider }),
        startCorpusPreparation({ ownerId: "caller", conversationId: "other-target", root, provider }),
    ]);
    assert.equal(new Set(started.map(status => status.taskId)).size, 3);
    const options = identity(started[0], root);
    await waitFor(options, status => status.progress?.phase === "reading");
    await assert.rejects(getCorpusSearchStatus({ ...options, ownerId: "other" }), { code: "CORPUS_TASK_NOT_FOUND" });
    await cancelCorpusSearch(options);
    const cancelled = await waitFor(options);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.coverage.committedConversations, 0);
    hold = false;
    const resumed = await resumeCorpusSearch({ ...options, provider });
    assert.equal(resumed.taskId, started[0].taskId);
    assert.equal((await waitFor(options)).coverage.scannedMessages, 3);
    await Promise.all(started.slice(1).map(status => waitFor(identity(status, root))));
});

test("completed preparation gets a new freshness-verifying task instead of a stale success", async () => {
    const root = path.join(temporary, "freshness");
    let reads = 0;
    const provider: CorpusProvider = {
        async list() { return [projection().conversation]; },
        async read() { reads++; const input = projection("target", `v${reads}`); input.sourceBytes += reads; return input; },
    };
    const options = { ownerId: "caller", conversationId: "target", provider, root };
    const first = await startCorpusPreparation(options);
    await waitFor(identity(first, root));
    const second = await startCorpusPreparation(options);
    const complete = await waitFor(identity(second, root));
    assert.notEqual(second.taskId, first.taskId);
    assert.equal(reads, 2);
    assert.equal(complete.coverage.sourceBytes, 1236);
});

test("resuming an older cancelled preparation cannot compete with a new task for the same target", async () => {
    const root = path.join(temporary, "old-resume");
    let hold = true;
    let reads = 0;
    const provider: CorpusProvider = {
        async list() { return [projection().conversation]; },
        async read(candidate, control) {
            reads++;
            while (hold && !control.isCancelled?.()) await sleep(2);
            return projection(candidate.id);
        },
    };
    const options = { ownerId: "caller", conversationId: "target", root, provider };
    const old = await startCorpusPreparation(options);
    await waitFor(identity(old, root), status => status.progress?.phase === "reading");
    await cancelCorpusSearch(identity(old, root));
    await waitFor(identity(old, root));
    const current = await startCorpusPreparation(options);
    try {
        assert.notEqual(current.taskId, old.taskId);
        await waitFor(identity(current, root), status => status.progress?.phase === "reading");
        await assert.rejects(resumeCorpusSearch({ ...identity(old, root), provider }), { code: "CORPUS_TASK_RUNNING" });
        assert.equal(reads, 2);
    } finally { hold = false; }
    assert.equal((await waitFor(identity(current, root))).status, "completed");
});

test("caller option mutation cannot redirect an admitted preparation", async () => {
    const root = path.join(temporary, "mutation");
    const options = { ownerId: "caller", conversationId: "target", root, provider: providerFor() };
    const promise = startCorpusPreparation(options);
    options.ownerId = "changed-owner";
    options.conversationId = "changed-target";
    options.root = path.join(temporary, "wrong-root");
    const started = await promise;
    assert.equal(started.ownerId, "caller");
    assert.deepEqual(started.request.conversationIds, ["target"]);
    assert.equal((await waitFor(identity(started, root))).status, "completed");
});

test("missing targets and invalid projection provenance never claim complete coverage", async () => {
    const root = path.join(temporary, "source-validation");
    const missing = await startCorpusPreparation({ ownerId: "caller", conversationId: "missing", root, provider: {
        async list() { return []; }, async read() { throw new Error("Unexpected read"); },
    } });
    const missingFinal = await waitFor(identity(missing, root));
    assert.equal(missingFinal.status, "failed");
    assert.equal(missingFinal.coverage.complete, false);
    const bad = await startCorpusPreparation({ ownerId: "caller", conversationId: "target", root, provider: {
        async list() { return [projection().conversation]; }, async read() { return projection("wrong-target"); },
    } });
    const badFinal = await waitFor(identity(bad, root));
    assert.equal(badFinal.status, "partial");
    assert.equal(badFinal.coverage.complete, false);
    assert.equal(badFinal.coverage.errorConversations, 1);
    assert.equal(badFinal.totalMatches, 0);
    await resumeCorpusSearch({ ...identity(bad, root), provider: providerFor() });
    assert.equal((await waitFor(identity(bad, root))).status, "completed");
});

async function startChild(script: string): Promise<{ taskId: string; output: () => string; stop: () => Promise<void> }> {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", chunk => stderr += chunk);
    const exited = new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Fixture exit ${code}: ${stderr}`)));
    });
    const taskId = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(new Error(`Fixture startup timeout: ${stderr}`)); }, 10000);
        child.stdout.on("data", chunk => {
            stdout += chunk;
            const match = stdout.match(/TASK=(corpus-[a-f0-9-]+)/);
            if (match) { clearTimeout(timer); resolve(match[1]); }
        });
        exited.then(() => { clearTimeout(timer); if (!stdout.includes("TASK=")) reject(new Error(`Missing fixture task: ${stderr}`)); }, error => { clearTimeout(timer); reject(error); });
    });
    return { taskId, output: () => stdout, stop: async () => { child.stdin.end("exit\n"); await exited; } };
}

function childScript(root: string, ownerId: string): string {
    return `
        const {startCorpusPreparation} = await import(${JSON.stringify(new URL("../src/conversation-corpus-preparation.ts", import.meta.url).href)});
        const provider = {
            async list(){return [{id:'target',title:'fixture',workspace:'C:/fixture',source:'codex'}]},
            async read(){console.log('READ');return new Promise(()=>{})}
        };
        process.stdin.resume();process.stdin.on('data',()=>process.exit(0));
        const status=await startCorpusPreparation({ownerId:${JSON.stringify(ownerId)},conversationId:'target',root:${JSON.stringify(root)},provider});
        console.log('TASK='+status.taskId);
    `;
}

test("separate processes coalesce while a live original task owns the lease", async () => {
    const root = path.join(temporary, "process-coalesce");
    const children = await Promise.all([startChild(childScript(root, "caller")), startChild(childScript(root, "caller"))]);
    try {
        assert.equal(children[0].taskId, children[1].taskId);
        assert.equal(children.reduce((count, child) => count + (child.output().match(/READ/g)?.length ?? 0), 0), 1);
    } finally { await Promise.all(children.map(child => child.stop())); }
    const options = { ownerId: "caller", root, taskId: children[0].taskId };
    assert.equal((await getCorpusSearchStatus(options)).status, "resumable");
    await cancelCorpusSearch(options);
    assert.equal((await getCorpusSearchStatus(options)).status, "cancelled");
});

test("process exit and lost index recover the original durable resumable task ID", async () => {
    const root = path.join(temporary, "restart");
    const child = await startChild(childScript(root, "caller"));
    await child.stop();
    const options = { ownerId: "caller", taskId: child.taskId, root };
    assert.equal((await getCorpusSearchStatus(options)).status, "resumable");
    const index = path.join(indexDirectory("caller", "target", root), "index.json");
    fs.writeFileSync(index, "incomplete-write", "utf8");
    let reads = 0;
    const resumed = await startCorpusPreparation({ ownerId: "caller", conversationId: "target", root, provider: {
        async list() { throw new Error("Durable frozen target must be reused"); },
        async read() { reads++; return projection(); },
    } });
    assert.equal(resumed.taskId, child.taskId);
    const complete = await waitFor(options);
    assert.equal(complete.status, "completed");
    assert.equal(reads, 1);
    assert.equal(JSON.parse(fs.readFileSync(index, "utf8")).taskId, child.taskId);
});

test("unknown previous task lease fails closed without another provider read", async () => {
    const root = path.join(temporary, "unknown-lease");
    const child = await startChild(childScript(root, "caller"));
    await child.stop();
    const options = { ownerId: "caller", taskId: child.taskId, root };
    const lease = path.join(corpusTaskDirectory(options), "lease.json");
    fs.writeFileSync(lease, JSON.stringify({ pid: "unknown", token: "fixture" }), "utf8");
    let reads = 0;
    await assert.rejects(startCorpusPreparation({ ownerId: "caller", conversationId: "target", root, provider: {
        async list() { throw new Error("Must not rediscover"); }, async read() { reads++; return projection(); },
    } }), { code: "CORPUS_LEASE_UNCERTAIN" });
    assert.equal(reads, 0);
    fs.writeFileSync(lease, JSON.stringify({ pid: process.pid, token: "unknown-same-process-owner" }), "utf8");
    const unknown = await startCorpusPreparation({ ownerId: "caller", conversationId: "target", root, provider: {
        async list() { throw new Error("Unknown lease must not rediscover"); }, async read() { reads++; return projection(); },
    } });
    assert.equal(unknown.taskId, child.taskId);
    assert.equal(unknown.status, "running");
    assert.equal(reads, 0);
    fs.rmSync(lease);
    await cancelCorpusSearch(options);
});

test("index write failure preserves the task ID and retry repairs the index without duplicate work", async () => {
    const root = path.join(temporary, "index-failure");
    const directory = indexDirectory("caller", "target", root);
    let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    let reads = 0;
    let failedTask = "";
    const provider: CorpusProvider = {
        async list() { fs.mkdirSync(path.join(directory, "index.json")); return [projection().conversation]; },
        async read() { reads++; await gate; return projection(); },
    };
    const options = { ownerId: "caller", conversationId: "target", root, provider };
    try {
        await assert.rejects(startCorpusPreparation(options), error => {
            failedTask = (error as Error & { taskId: string }).taskId;
            return /^corpus-/.test(failedTask);
        });
        fs.rmdirSync(path.join(directory, "index.json"));
        const recovered = await startCorpusPreparation(options);
        assert.equal(recovered.taskId, failedTask);
        assert.equal(reads, 1);
    } finally { release(); }
    assert.equal((await waitFor({ ownerId: "caller", taskId: failedTask, root })).status, "completed");
});

test("ordinary search still counts requested roles and terms", async () => {
    const root = path.join(temporary, "search-regression");
    const started = await startCorpusSearch({ ownerId: "caller", root, request: { query: "hit" }, provider: providerFor() });
    const complete = await waitFor(identity(started, root));
    assert.equal(complete.status, "completed");
    assert.equal(complete.totalMatches, 1);
    assert.equal(complete.results[0].occurrences, 4);
    assert.equal(complete.coverage.scannedMessages, 2);
});

test("preparation chunks update progress without publishing hits or an unverified prepared source", async () => {
    const root = path.join(temporary, "prepare-chunks");
    let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    const input = { ...projection(), cacheGeneration: "fixture-body-generation" };
    const started = await startCorpusPreparation({ ownerId: "caller", conversationId: "target", root, provider: {
        semanticVersion: "fixture-body/v2",
        async list() { return [input.conversation]; },
        async read(candidate, control) {
            await control.onChunk?.({ ...input, revision: "pending:projection", sourceBytes: 321 });
            await gate;
            return input;
        },
    } });
    const options = identity(started, root);
    const pending = await waitFor(options, status => status.progress?.bytes === 321);
    assert.equal(pending.totalMatches, 0);
    assert.equal(pending.prepared, undefined);
    assert.equal(pending.coverage.complete, false);
    release();
    const complete = await waitFor(options);
    assert.equal(complete.totalMatches, 0);
    assert.equal(complete.prepared?.sourceRevision, "v1");
    assert.equal(complete.prepared?.cacheGeneration, "fixture-body-generation");
    assert.equal(complete.viewSemanticVersion.provider, "fixture-body/v2");
});
