import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { ProgressiveTaskPayload, ProgressiveReadyState } from "../src/conversation-progressive-task-types.js";
import type { ConversationRound } from "../src/trajectory.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "progressive-task-fixture-"));
process.env.MEMORY_STORE_DATA_ROOT = directory;
const tasks = await import("../src/conversation-progressive-task.js");
const background = await import("../src/background-tasks.js");
const { openProgressiveCache } = await import("../src/conversation-progressive-cache.js");
const { runProgressiveWorker } = await import("../src/conversation-progressive-worker-client.js");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const fork = childProcess.fork;

class FixtureChild extends EventEmitter {
    pid: number | undefined = 123456;
    connected = true;
    stderr = new PassThrough();
    messages: any[] = [];
    payload?: ProgressiveTaskPayload;
    closed = false;
    kills = 0;
    send(message: any, callback?: (error: Error | null) => void) {
        this.messages.push(message);
        if (message.type === "run") this.payload = message.payload;
        callback?.(null);
        return true;
    }
    kill() { this.kills++; return true; }
    exit() { this.emit("exit", 0, null); }
    close() { if (!this.closed) { this.closed = true; this.connected = false; this.emit("close", 0, null); } }
    complete() { this.emit("message", { type: "result", result: "synthetic worker finished" }); this.exit(); this.close(); }
}

async function until(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 4000;
    while (!await check()) {
        if (Date.now() >= deadline) throw new Error("Synthetic worker condition timed out");
        await sleep(10);
    }
}

async function withChildren(run: (children: FixtureChild[]) => Promise<void>) {
    const children: FixtureChild[] = [];
    childProcess.fork = (() => { const child = new FixtureChild(); children.push(child); return child; }) as any;
    syncBuiltinESMExports();
    try { await run(children); }
    finally {
        for (const child of children) child.complete();
        await sleep(30);
        childProcess.fork = fork;
        syncBuiltinESMExports();
    }
}

async function recorded(status: "running" | "cancelled" | "done" = "cancelled", link: "reference" | "summary" | "expand_children" = "summary") {
    const ownerId = "fictional-owner-" + randomUUID();
    const taskId = "progressive-" + randomUUID();
    const root = path.join(directory, "progressive-tasks", hash(ownerId), taskId);
    const payload: ProgressiveTaskPayload = { version: 1, taskId, directory: root, request: { ownerId, conversationId: "fictional-source", direction: "latest", initialRounds: 2, buildFull: true, dataChain: "codex", link } };
    const record = { version: 1, payload, attempt: 1, backgroundTaskId: taskId + "-1" };
    await tasks.writeProgressiveState(path.join(root, "request.json"), record);
    const now = new Date().toISOString();
    background.__testWritePersistedTask({ id: record.backgroundTaskId, kind: "conversation-progressive", status,
        startedAt: now, updatedAt: now, ownerPid: 2147483647, resumePayload: payload as any,
        resumeVersion: background.BACKGROUND_TASK_RESUME_VERSION, resumeHash: background.stableJsonHash(payload) });
    return { root, payload, record, identity: { ownerId, taskId } };
}

function input(roundIndex: number) {
    const round: ConversationRound = { roundIndex, startStep: roundIndex, endStep: roundIndex,
        userMessage: "fictional-body-" + roundIndex, aiResponses: [], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [] };
    return { coverage: { kind: "absolute" as const, startRound: roundIndex, endRound: roundIndex }, anchor: { fixture: roundIndex }, rounds: [round],
        messages: [{ id: "fictional-message-" + roundIndex, round: roundIndex, role: "user" as const, text: round.userMessage, position: { ordinal: roundIndex } }] };
}

async function published(sample: Awaited<ReturnType<typeof recorded>>, revision = "fictional-revision-1") {
    const source = { conversationId: sample.payload.request.conversationId, host: "codex", revision, snapshot: { fixture: true }, totalRounds: 2 };
    const root = path.join(sample.root, "ranges", revision);
    const cache = await openProgressiveCache({ root, source });
    const writer = await cache.beginWrite();
    const block = await cache.publish(writer, input(1));
    const ref = (await cache.read()).rows[0]!.ref;
    const ready: ProgressiveReadyState = { version: 1, phase: "ready", current: { directory: root, source }, previous: [], requestedRangeComplete: false, updatedAt: new Date().toISOString(), warnings: [] };
    await tasks.writeProgressiveState(path.join(sample.root, "ready.json"), ready);
    return { cache, writer, block, ref, ready, root };
}

after(async () => {
    childProcess.fork = fork;
    syncBuiltinESMExports();
    background.__testResetBackgroundTasksForTest();
    await promises.rm(directory, { recursive: true, force: true });
});

test("spawn errors without exit reject and clear worker polling", async () => withChildren(async children => {
    const sample = await recorded();
    const work = runProgressiveWorker(sample.payload, { taskId: sample.record.backgroundTaskId, isCancelled: () => false, isSettled: () => false, updateProgress: () => {} });
    assert.equal(children.length, 1);
    children[0]!.pid = undefined;
    const checked = assert.rejects(work, /synthetic spawn ENOENT/u);
    children[0]!.emit("error", new Error("synthetic spawn ENOENT"));
    await checked;
    assert.equal(children[0]!.kills, 0);
}));

test("post-spawn IPC errors wait for close and retain the original failure", async () => withChildren(async children => {
    const sample = await recorded();
    let settled = false;
    const work = runProgressiveWorker(sample.payload, { taskId: sample.record.backgroundTaskId, isCancelled: () => false, isSettled: () => false, updateProgress: () => {} });
    const checked = assert.rejects(work, /synthetic IPC failure/u).then(() => { settled = true; });
    children[0]!.emit("error", new Error("synthetic IPC failure"));
    assert.equal(children[0]!.kills, 1);
    children[0]!.exit();
    await sleep(20);
    assert.equal(settled, false);
    children[0]!.close();
    await checked;
}));

test("a synchronous cancellation IPC failure still waits for worker close", async () => withChildren(async children => {
    const sample = await recorded();
    let cancelled = false;
    let settled = false;
    const work = runProgressiveWorker(sample.payload, { taskId: sample.record.backgroundTaskId, isCancelled: () => cancelled, isSettled: () => false, updateProgress: () => {} });
    const checked = assert.rejects(work, /cancelled/u).then(() => { settled = true; });
    children[0]!.send = () => { throw new Error("synthetic cancellation IPC failure"); };
    cancelled = true;
    await until(() => children[0]!.kills > 0);
    assert.equal(settled, false);
    children[0]!.exit();
    await sleep(20);
    assert.equal(settled, false);
    children[0]!.close();
    await checked;
}));

test("recovered workers register cleanup, block overlapping resume, and retain ready refs and link", async () => withChildren(async children => {
    const sample = await recorded("running", "expand_children");
    const range = await published(sample);
    const recovered = await background.recoverBackgroundTask(sample.record.backgroundTaskId);
    assert.notEqual(recovered.outcome, "error", JSON.stringify(recovered));
    await until(() => children.length === 1);
    assert.equal(children[0]!.payload?.request.link, "expand_children");
    const cancelled = await tasks.cancelProgressivePreparation(sample.identity) as any;
    assert.equal(cancelled.cancellationPending, true);
    await assert.rejects(tasks.resumeProgressivePreparation(sample.identity), /cleanup is still running/u);
    await until(() => children[0]!.messages.some(message => message.type === "cancel"));
    children[0]!.exit();
    await assert.rejects(tasks.resumeProgressivePreparation(sample.identity), /cleanup is still running/u);
    assert.equal(children.length, 1);
    children[0]!.close();
    await until(async () => !(await tasks.getProgressiveTaskStatus(sample.identity) as any).cancellationPending);
    const resumed = await tasks.resumeProgressivePreparation(sample.identity) as any;
    await until(() => children.length === 2);
    assert.equal(resumed.taskId, sample.identity.taskId);
    assert.equal(resumed.backgroundTaskId, sample.identity.taskId + "-2");
    assert.equal(children[1]!.payload?.request.link, "expand_children");
    assert.equal(children.filter(child => !child.closed).length, 1);
    assert.equal((await tasks.openProgressiveTaskCache(sample.identity, range.ref)).row?.round.userMessage, "fictional-body-1");
    children[1]!.complete();
    await until(() => background.getBackgroundTask(resumed.backgroundTaskId)?.status === "done");
}));

test("start preserves distinct reference/summary/expand_children requests and normal cancellation also drains", async () => withChildren(async children => {
    for (const link of ["reference", "summary", "expand_children"] as const) {
        const started = await tasks.startProgressivePreparation({ ownerId: "fictional-start-owner", conversationId: "fictional-source", direction: "latest", initialRounds: 2, buildFull: true, dataChain: "codex", link }) as any;
        await until(() => children.some(child => child.payload?.taskId === started.taskId));
        const child = children.find(child => child.payload?.taskId === started.taskId)!;
        assert.equal(child.payload!.request.link, link);
        assert.equal((await tasks.startProgressivePreparation(child.payload!.request) as any).taskId, started.taskId);
        const identity = { ownerId: "fictional-start-owner", taskId: started.taskId };
        await tasks.cancelProgressivePreparation(identity);
        await assert.rejects(tasks.resumeProgressivePreparation(identity), /cleanup is still running/u);
        child.close();
        await until(async () => !(await tasks.getProgressiveTaskStatus(identity) as any).cancellationPending);
    }
    assert.equal(new Set(children.map(child => child.payload!.taskId)).size, 3);
}));

test("invalid requests are rejected before persistence or worker dispatch", async () => withChildren(async children => {
    const before = (await promises.readdir(directory)).sort();
    const request = { ownerId: "fictional-invalid-owner", conversationId: "fictional-source", direction: "latest", initialRounds: 2, buildFull: true, dataChain: "codex" };
    for (const invalid of [{ ...request, link: "full" }, { ...request, ownerId: " " }, { ...request, buildFull: null }, { ...request, conversationId: " " }]) {
        await assert.rejects(tasks.startProgressivePreparation(invalid as any), /Invalid progressive preparation request/u);
    }
    assert.equal(children.length, 0);
    assert.deepEqual((await promises.readdir(directory)).sort(), before);
}));

test("status waits for fresh revisions despite existing ready, cache updates, progress and completion", async () => withChildren(async children => {
    const sample = await recorded("running");
    const range = await published(sample);
    await background.recoverBackgroundTask(sample.record.backgroundTaskId);
    await until(() => children.length === 1);
    const first = await tasks.getProgressiveTaskStatus(sample.identity) as any;
    const started = performance.now();
    const timeout = await tasks.getProgressiveTaskStatus({ ...sample.identity, waitMs: 140, afterRevision: first.revision }) as any;
    assert.ok(performance.now() - started >= 100, "An existing ready range ended the long poll");
    assert.equal(timeout.revision, first.revision);
    const implicitStart = performance.now();
    await tasks.getProgressiveTaskStatus({ ...sample.identity, waitMs: 120 });
    assert.ok(performance.now() - implicitStart >= 90);
    const progressTimer = setTimeout(() => children[0]!.emit("message", { type: "progress", stage: "synthetic-new-progress", current: 2 }), 40);
    const progressed = await tasks.getProgressiveTaskStatus({ ...sample.identity, waitMs: 1000, afterRevision: first.revision }) as any;
    clearTimeout(progressTimer);
    assert.notEqual(progressed.revision, first.revision);
    assert.equal(progressed.progress.stage, "synthetic-new-progress");
    const publishing = sleep(40).then(() => range.cache.publish(range.writer, input(2)));
    const updated = await tasks.getProgressiveTaskStatus({ ...sample.identity, waitMs: 1000, afterRevision: progressed.revision }) as any;
    await publishing;
    assert.notEqual(updated.revision, progressed.revision);
    assert.equal(updated.ready.coveredAbsoluteRounds, 2);
    const finishing = setTimeout(() => children[0]!.complete(), 40);
    const completed = await tasks.getProgressiveTaskStatus({ ...sample.identity, waitMs: 1000, afterRevision: updated.revision }) as any;
    clearTimeout(finishing);
    assert.equal(completed.status, "done");
}));

test("persisted ready rejects cross-owner paths, wrong sources, missing caches and directory junctions", async () => {
    const sample = await recorded();
    const other = await recorded();
    const own = await published(sample);
    const foreign = await published(other);
    await tasks.writeProgressiveState(path.join(sample.root, "ready.json"), foreign.ready);
    await assert.rejects(tasks.getProgressiveTaskStatus(sample.identity), { code: "unsafe_path" });
    await assert.rejects(tasks.openProgressiveTaskCache(sample.identity), { code: "unsafe_path" });
    await assert.rejects(tasks.getProgressiveTaskStatus({ ...sample.identity, ownerId: other.identity.ownerId }));
    await tasks.writeProgressiveState(path.join(sample.root, "ready.json"), { ...own.ready, current: { ...own.ready.current, source: { ...own.ready.current!.source, conversationId: "another-fictional-source" } } });
    await assert.rejects(tasks.getProgressiveTaskStatus(sample.identity), { code: "owner_mismatch" });
    await tasks.writeProgressiveState(path.join(sample.root, "ready.json"), { ...own.ready, current: { ...own.ready.current, directory: path.join(sample.root, "ranges", "missing") } });
    await assert.rejects(tasks.getProgressiveTaskStatus(sample.identity), { code: "corrupt_cache" });
    assert.equal(fs.existsSync(path.join(sample.root, "ranges", "missing")), false);
    const linked = path.join(sample.root, "ranges", "linked");
    await promises.symlink(foreign.root, linked, process.platform === "win32" ? "junction" : "dir");
    await tasks.writeProgressiveState(path.join(sample.root, "ready.json"), { ...own.ready, current: { ...own.ready.current, directory: linked } });
    await assert.rejects(tasks.getProgressiveTaskStatus(sample.identity), { code: "unsafe_path" });
    await assert.rejects(tasks.openProgressiveTaskCache(sample.identity), { code: "unsafe_path" });
});

test("recovery refuses forged persisted ready before spawning a writer", async () => withChildren(async children => {
    const sample = await recorded("running");
    const other = await recorded();
    const foreign = await published(other);
    await tasks.writeProgressiveState(path.join(sample.root, "ready.json"), foreign.ready);
    await background.recoverBackgroundTask(sample.record.backgroundTaskId);
    await until(() => background.getBackgroundTask(sample.record.backgroundTaskId)?.status === "error");
    assert.equal(children.length, 0);
    assert.match(background.getBackgroundTask(sample.record.backgroundTaskId)!.error!, /path mismatch/u);
    await assert.rejects(tasks.resumeProgressivePreparation(sample.identity), { code: "unsafe_path" });
    const persisted = JSON.parse(await promises.readFile(path.join(sample.root, "request.json"), "utf8"));
    assert.equal(persisted.attempt, 1);
}));

test("old refs survive generation switches, invalid refs stay distinct from corruption", async () => {
    const sample = await recorded();
    const old = await published(sample, "old-fixture");
    const current = await published(sample, "new-fixture");
    await tasks.writeProgressiveState(path.join(sample.root, "ready.json"), { ...current.ready, previous: [old.ready.current] });
    assert.equal((await tasks.openProgressiveTaskCache(sample.identity, old.ref)).row!.ref, old.ref);
    await assert.rejects(tasks.openProgressiveTaskCache(sample.identity, "invalid-fictional-ref"), { code: "invalid_ref" });
    await promises.writeFile(path.join(current.root, "manifest.json"), "{corrupt");
    await assert.rejects(tasks.openProgressiveTaskCache(sample.identity, old.ref), (error: any) => error.code === "corrupt_cache");
});

test("a new process recovers the same persisted task, retains ready refs, owner and summary link", async () => {
    const sample = await recorded("running", "summary");
    const range = await published(sample);
    const script = `
        import assert from 'node:assert/strict';
        import childProcess from 'node:child_process';
        import { EventEmitter } from 'node:events';
        import { syncBuiltinESMExports } from 'node:module';
        let workers = 0;
        childProcess.fork = () => {
            workers++;
            const child = new EventEmitter();
            child.pid = 123456; child.connected = true;
            child.send = (message, callback) => {
                assert.equal(message.payload.request.link, 'summary');
                callback?.(null);
                setImmediate(() => { child.emit('message', { type: 'result', result: 'synthetic restart done' }); child.emit('exit', 0, null); child.emit('close', 0, null); });
            };
            child.kill = () => true;
            return child;
        };
        syncBuiltinESMExports();
        const tasks = await import(${JSON.stringify(new URL("../src/conversation-progressive-task.ts", import.meta.url).href)});
        const background = await import(${JSON.stringify(new URL("../src/background-tasks.ts", import.meta.url).href)});
        await background.recoverBackgroundTask(${JSON.stringify(sample.record.backgroundTaskId)});
        const completed = await background.waitForBackgroundTask(${JSON.stringify(sample.record.backgroundTaskId)}, 3);
        assert.equal(completed.status, 'done', JSON.stringify(completed));
        assert.equal(workers, 1);
        assert.equal((await tasks.openProgressiveTaskCache(${JSON.stringify(sample.identity)}, ${JSON.stringify(range.ref)})).row.ref, ${JSON.stringify(range.ref)});
        await assert.rejects(tasks.getProgressiveTaskStatus({ ...${JSON.stringify(sample.identity)}, ownerId: 'foreign-owner' }));
        console.log('progressive restart: PASS owner/same-task/one-worker/ready-ref/summary-link');
    `;
    const child = childProcess.spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: process.env, encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.match(child.stdout, /progressive restart: PASS/u);
});
