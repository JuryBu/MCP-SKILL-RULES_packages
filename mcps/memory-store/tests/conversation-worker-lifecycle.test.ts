import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { after, test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { CodexFetchWorkerPayload } from "../src/conversation-fetch-worker-types.js";
import type { ProgressiveTaskPayload } from "../src/conversation-progressive-task-types.js";
import type { ConversationRound } from "../src/trajectory.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-worker-lifecycle-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.CODEX_HOME = path.join(root, "synthetic-codex-home");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const fixture = path.join(root, "owned-worker.cjs");
fs.writeFileSync(fixture, `
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const role = process.argv[2] || "worker";
process.on("SIGTERM", () => {});
if (role === "grandchild") {
    setInterval(() => fs.writeFileSync(path.join(process.env.LIFECYCLE_DIRECTORY, "grandchild-heartbeat"), String(Date.now())), 10);
} else if (role === "descendant") {
    const grandchild = spawn(process.execPath, [__filename, "grandchild"], { stdio: "ignore", windowsHide: true });
    process.send({ descendant: process.pid, grandchild: grandchild.pid });
    process.on("message", message => {
        if (message.type === "stop") {
            grandchild.once("close", () => process.exit(0));
            grandchild.kill("SIGKILL");
        }
    });
    setInterval(() => {}, 10);
} else {
    let running = false;
    let exitOnCancel = false;
    process.on("message", message => {
        if (message.type === "cancel" && exitOnCancel) process.exit(0);
        if (message.type !== "run" || running) return;
        running = true;
        const payload = message.payload;
        const fetch = payload.version === 2;
        const directory = fetch ? path.dirname(payload.sourcePath) : payload.directory;
        const mode = fs.readFileSync(path.join(directory, "mode"), "utf8");
        exitOnCancel = mode === "cooperative-cancel";
        process.env.LIFECYCLE_DIRECTORY = directory;
        const artifact = path.join(directory, "synthetic-artifact.md");
        if (fetch) {
            fs.writeFileSync(artifact, "synthetic worker artifact");
            process.send({ type: "artifact_path", path: artifact });
        }
        if (mode === "cooperative-cancel") {
            fs.writeFileSync(path.join(directory, "pids.json"), JSON.stringify({ worker: process.pid }));
            process.send({ type: "progress", stage: "fixture-terminal", detail: "synthetic cooperative worker ready" });
            return;
        }
        const descendant = spawn(process.execPath, [__filename, "descendant"], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
        descendant.once("message", pids => {
            fs.writeFileSync(path.join(directory, "pids.json"), JSON.stringify({ worker: process.pid, ...pids }));
            if (mode.startsWith("result")) {
                const result = fetch ? {
                    artifact: { tempPath: artifact, roundCount: 1, aiResponseCount: 0, toolCallCount: 0, attachmentCount: 0 },
                    chainUsed: "codex", conversationId: "synthetic-source", totalSteps: 1, roundCount: 1,
                    requestedLink: "summary", effectiveLink: "summary", linkDiagnostics: [],
                    thread: { id: "synthetic-source", title: "synthetic title", cwd: directory },
                    timings: { cacheMs: 0, artifactMs: 0, totalMs: 0 }
                } : "synthetic progressive result";
                process.send({ type: "result", result });
            }
            if (mode.startsWith("error")) {
                process.stderr.write("synthetic stderr tail");
                process.send(fetch ? { type: "error", name: "FixtureError", message: "synthetic worker error", stack: "FixtureError: synthetic worker error\\nfixture:1:1" }
                    : { type: "error", error: "synthetic worker error" });
            }
            process.send({ type: "progress", stage: "fixture-terminal", detail: "synthetic tree ready" });
            if (mode.endsWith("close") || mode === "result-nonzero") {
                setTimeout(() => {
                    descendant.once("close", () => process.exit(mode.startsWith("error") || mode === "result-nonzero" ? 1 : 0));
                    descendant.send({ type: "stop" });
                }, 250);
            }
        });
        setInterval(() => {}, 10);
    });
}
`, "utf8");

const fork = childProcess.fork;
const execFile = childProcess.execFile;
const children: ChildProcess[] = [];
const closed = new Set<ChildProcess>();
childProcess.fork = ((...args: Parameters<typeof childProcess.fork>) => {
    const child = fork(...args);
    children.push(child);
    child.once("close", () => closed.add(child));
    return child;
}) as typeof childProcess.fork;
syncBuiltinESMExports();
const { runCodexFetchWorker } = await import("../src/conversation-fetch-worker-client.js");
const { runProgressiveWorker } = await import("../src/conversation-progressive-worker-client.js");
const { openProgressiveCache } = await import("../src/conversation-progressive-cache.js");

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 6_000;
    while (!await check()) {
        if (Date.now() >= deadline) throw new Error("synthetic lifecycle condition timed out");
        await sleep(10);
    }
}

async function stopOwnedTree(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const closing = once(child, "close");
    if (process.platform === "win32") {
        await new Promise<void>((resolve, reject) => execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }, error => error ? reject(error) : resolve()));
    } else process.kill(-child.pid, "SIGKILL");
    await closing;
}

after(async () => {
    childProcess.fork = fork;
    childProcess.execFile = execFile;
    syncBuiltinESMExports();
    for (const child of children) await stopOwnedTree(child);
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
});

async function start(context: TestContext, kind: "fetch" | "progressive", mode: string) {
    const directory = fs.mkdtempSync(path.join(root, `${kind}-`));
    fs.writeFileSync(path.join(directory, "mode"), mode, "utf8");
    const state = { cancelled: false, settled: false };
    const progress: string[] = [];
    const taskContext = { taskId: "synthetic-task", isCancelled: () => state.cancelled, isSettled: () => state.settled,
        updateProgress: (value: { stage?: string }) => { progress.push(value.stage || ""); } };
    const sourcePath = path.join(directory, "synthetic.jsonl");
    fs.writeFileSync(sourcePath, "synthetic source", "utf8");
    const fetchPayload: CodexFetchWorkerPayload = {
        version: 2, verificationDeferred: true, conversationId: "synthetic-source", link: "summary", source: "local",
        sourcePath, sourceSize: 0, sourceMtimeMs: 0, anchorStartByte: 0, anchorSha256: "synthetic-anchor",
        artifactBucket: 0, modelChain: "codex",
    };
    const progressivePayload: ProgressiveTaskPayload = { version: 1, taskId: "synthetic-task", directory,
        request: { ownerId: "synthetic-owner", conversationId: "synthetic-source", direction: "latest", initialRounds: 1, buildFull: true, dataChain: "codex" } };
    const cache = await openProgressiveCache({ root: path.join(directory, "published"), source: {
        conversationId: "synthetic-source", host: "codex", revision: "synthetic-revision", snapshot: { synthetic: true }, totalRounds: 1,
    } });
    const writer = await cache.beginWrite();
    const round: ConversationRound = { roundIndex: 1, startStep: 1, endStep: 1, userMessage: "synthetic published body",
        mediaAttachments: [], aiResponses: [], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [] };
    await cache.publish(writer, { coverage: { kind: "absolute", startRound: 1, endRound: 1 }, anchor: { synthetic: true }, rounds: [round],
        messages: [{ id: "synthetic-message", round: 1, role: "user", text: round.userMessage, position: { ordinal: 1 } }] });
    const options = { target: { file: fixture }, cancelGraceMs: mode === "cooperative-cancel" ? 1_000 : 30 };
    const work = kind === "fetch" ? runCodexFetchWorker(fetchPayload, taskContext, options) : runProgressiveWorker(progressivePayload, taskContext, options);
    const child = children.at(-1)!;
    let finished = false;
    void work.then(() => { finished = true; }, () => { finished = true; });
    context.after(() => stopOwnedTree(child));
    await until(() => progress.includes("fixture-terminal"));
    if (mode !== "cooperative-cancel") await until(() => fs.existsSync(path.join(directory, "grandchild-heartbeat")));
    const pids = JSON.parse(fs.readFileSync(path.join(directory, "pids.json"), "utf8")) as Record<string, number>;
    assert.equal(pids.worker, child.pid);
    return {
        directory, state, work, child, pids, progress, finished: () => finished,
        artifact: path.join(directory, "synthetic-artifact.md"),
        assertTreeClosed: () => {
            assert.ok(closed.has(child), "client must wait for the direct child's close event");
            for (const pid of Object.values(pids)) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
            context.diagnostic(JSON.stringify({ kind, mode, pids, directCloseObserved: true, unreachableProcesses: Object.keys(pids).length }));
        },
        assertPublishedReadable: async () => assert.equal((await cache.read()).rows[0]?.round.userMessage, "synthetic published body"),
    };
}

for (const kind of ["fetch", "progressive"] as const) {
    test(`${kind}: early result stays pending until settled-task tree cleanup completes`, async context => {
        const sample = await start(context, kind, "result-hang");
        const heartbeat = fs.readFileSync(path.join(sample.directory, "grandchild-heartbeat"), "utf8");
        await sleep(60);
        assert.equal(sample.finished(), false);
        assert.notEqual(fs.readFileSync(path.join(sample.directory, "grandchild-heartbeat"), "utf8"), heartbeat);
        const checked = assert.rejects(sample.work, /cancelled|settlement/u);
        sample.state.settled = true;
        await checked;
        sample.assertTreeClosed();
        if (kind === "fetch") assert.equal(fs.existsSync(sample.artifact), false);
        await sample.assertPublishedReadable();
    });

    test(`${kind}: non-cooperative cancellation kills descendants and leaves next work usable`, async context => {
        const sample = await start(context, kind, "cancel-hang");
        const checked = assert.rejects(sample.work, /cancelled/u);
        sample.state.cancelled = true;
        await checked;
        sample.assertTreeClosed();
        if (kind === "fetch") assert.equal(fs.existsSync(sample.artifact), false);
        await sample.assertPublishedReadable();
        const next = await start(context, kind, "result-close");
        await next.work;
        next.assertTreeClosed();
        if (kind === "fetch") assert.equal(fs.existsSync(next.artifact), true);
        await next.assertPublishedReadable();
    });

    test(`${kind}: IPC error is retained but only rejects after close`, async context => {
        const sample = await start(context, kind, "error-close");
        const checked = assert.rejects(sample.work, /synthetic worker error/u);
        await sleep(40);
        assert.equal(sample.finished(), false);
        await checked;
        sample.assertTreeClosed();
        await sample.assertPublishedReadable();
    });

    test(`${kind}: error followed by a hang retains ownership until cancelled tree close`, async context => {
        const sample = await start(context, kind, "error-hang");
        await sleep(40);
        assert.equal(sample.finished(), false);
        const checked = assert.rejects(sample.work, /cancelled/u);
        sample.state.cancelled = true;
        await checked;
        sample.assertTreeClosed();
        if (kind === "fetch") assert.equal(fs.existsSync(sample.artifact), false);
        await sample.assertPublishedReadable();
    });

    test(`${kind}: result followed by nonzero exit is rejected after close`, async context => {
        const sample = await start(context, kind, "result-nonzero");
        await assert.rejects(sample.work, /worker exit/u);
        sample.assertTreeClosed();
        await sample.assertPublishedReadable();
    });
}

for (const kind of ["fetch", "progressive"] as const) test(`${kind}: tree cleanup command completion is awaited after the worker already closed`, { skip: process.platform !== "win32" }, async context => {
    let release: (() => void) | undefined;
    childProcess.execFile = ((file: string, args: string[], options: object, callback: (error: Error | null) => void) =>
        execFile(file, args, options, error => { release = () => callback(error); })) as typeof childProcess.execFile;
    syncBuiltinESMExports();
    context.after(() => { release?.(); childProcess.execFile = execFile; syncBuiltinESMExports(); });
    const sample = await start(context, kind, "result-hang");
    const checked = assert.rejects(sample.work, /cancelled/u);
    sample.state.cancelled = true;
    await until(() => closed.has(sample.child) && release !== undefined);
    assert.equal(sample.finished(), false);
    sample.assertTreeClosed();
    release!();
    await checked;
    if (kind === "fetch") assert.equal(fs.existsSync(sample.artifact), false);
    await sample.assertPublishedReadable();
});

for (const kind of ["fetch", "progressive"] as const) for (const stoppedBy of ["cancelled", "settled"] as const) {
    test(`${kind}: cooperative ${stoppedBy} close avoids late taskkill and cleans finished artifacts`, async context => {
        let terminationCommands = 0;
        childProcess.execFile = ((file: string, args: string[], options: object, callback: (error: Error | null) => void) => {
            terminationCommands++;
            return execFile(file, args, options, callback);
        }) as typeof childProcess.execFile;
        syncBuiltinESMExports();
        context.after(() => { childProcess.execFile = execFile; syncBuiltinESMExports(); });
        const sample = await start(context, kind, "cooperative-cancel");
        const checked = assert.rejects(sample.work, error => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /cancelled|settlement/u);
            assert.doesNotMatch(error.message, /cleanup unconfirmed/u);
            return true;
        });
        sample.state[stoppedBy] = true;
        await checked;
        sample.assertTreeClosed();
        assert.equal(terminationCommands, 0);
        assert.equal(sample.progress.includes("cleanup_failed"), false);
        if (kind === "fetch") assert.equal(fs.existsSync(sample.artifact), false);
        await sample.assertPublishedReadable();
    });
}

for (const kind of ["fetch", "progressive"] as const) test(`${kind}: failed live-tree termination reports cleanup_failed and preserves recovery data`, { skip: process.platform !== "win32" }, async context => {
    let terminationCommands = 0;
    childProcess.execFile = ((_file: string, _args: string[], _options: object, callback: (error: Error | null) => void) => {
        terminationCommands++;
        queueMicrotask(() => callback(new Error("synthetic taskkill failure")));
        return new EventEmitter();
    }) as typeof childProcess.execFile;
    syncBuiltinESMExports();
    context.after(() => { childProcess.execFile = execFile; syncBuiltinESMExports(); });
    const sample = await start(context, kind, "cancel-hang");
    const checked = assert.rejects(sample.work, /process-tree cleanup unconfirmed.*synthetic taskkill failure/u);
    sample.state.cancelled = true;
    await until(() => sample.progress.includes("cleanup_failed"));
    assert.equal(terminationCommands, 1);
    assert.equal(sample.finished(), false);
    assert.equal(closed.has(sample.child), false);
    if (kind === "fetch") assert.equal(fs.existsSync(sample.artifact), true);
    await stopOwnedTree(sample.child);
    await checked;
    sample.assertTreeClosed();
    if (kind === "fetch") assert.equal(fs.existsSync(sample.artifact), true);
    await sample.assertPublishedReadable();
});
