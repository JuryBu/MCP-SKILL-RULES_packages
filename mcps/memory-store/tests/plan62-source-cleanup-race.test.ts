import assert from "node:assert/strict";
import childProcess, { ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate as nextImmediate } from "node:timers/promises";
import test, { mock } from "node:test";
import { runIsolatedSource, waitForIsolatedSourceExit } from "../src/conversation-isolated-source.js";

test("cleanup accepts an already observed worker exit", async () => {
    const child = new ChildProcess();
    child.exitCode = 0;
    assert.equal(await waitForIsolatedSourceExit(child), true);
    assert.equal(child.listenerCount("exit"), 0);
});

test("cleanup joins an exit delivered after the termination callback", async () => {
    const child = new ChildProcess();
    const waiting = waitForIsolatedSourceExit(child);
    assert.equal(child.listenerCount("exit"), 1);
    child.exitCode = 1;
    child.emit("exit", 1, null);
    assert.equal(await waiting, true);
    assert.equal(child.listenerCount("exit"), 0);
});

test("cleanup joins signal termination before close", async () => {
    const child = new ChildProcess();
    const waiting = waitForIsolatedSourceExit(child);
    child.signalCode = "SIGTERM";
    child.emit("exit", null, "SIGTERM");
    assert.equal(await waiting, true);
    assert.equal(child.listenerCount("exit"), 0);
    assert.equal(child.listenerCount("close"), 0);
});

test("cleanup does not confirm a worker that remains alive", async () => {
    const child = new ChildProcess();
    assert.equal(await waitForIsolatedSourceExit(child, 5), false);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(child.listenerCount("exit"), 0);
});

async function cancellationWithFailedTreeCleanup(exitAfterFailure: boolean): Promise<void> {
    const child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 123456 });
    Object.assign(child, { send: () => true });
    let fallback = false;
    Object.assign(child, { kill: () => {
        fallback = true;
        queueMicrotask(() => { child.signalCode = "SIGKILL"; child.emit("exit", null, "SIGKILL"); child.emit("close", null, "SIGKILL"); });
        return true;
    } });
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let cleanupStarted!: () => void;
    const cleaning = new Promise<void>(resolve => { cleanupStarted = resolve; });
    const stub = mock.method(childProcess, "fork", () => { started(); return child; });
    syncBuiltinESMExports();
    const controller = new AbortController();
    const cleanupError = new Error("fixture taskkill target already absent");
    try {
        const pending = runIsolatedSource("host-read", {}, { signal: controller.signal }, {
            target: { file: import.meta.filename }, timeoutMs: 5000,
            terminateProcessTree: async owned => { assert.equal(owned, child); cleanupStarted(); throw cleanupError; },
        });
        const rejected = assert.rejects(pending, (error: any) => {
            if (exitAfterFailure) return error.code === "SOURCE_WORKER_CANCELLED";
            assert.equal(error.code, "SOURCE_WORKER_CLEANUP");
            assert.equal(error.cause.code, "SOURCE_WORKER_CANCELLED");
            assert.equal(error.cleanupCause, cleanupError);
            assert.match(error.message, /original failure: SOURCE_WORKER_CANCELLED/);
            return true;
        });
        await ready;
        controller.abort();
        await cleaning;
        await nextImmediate();
        assert.equal(child.listenerCount("exit"), 1);
        if (exitAfterFailure) { child.exitCode = 0; child.emit("exit", 0, null); child.emit("close", 0, null); }
        await rejected;
        assert.equal(fallback, !exitAfterFailure);
        assert.equal(child.listenerCount("exit"), 0);
    } finally { stub.mock.restore(); syncBuiltinESMExports(); }
}

test("stop catch preserves cancellation when taskkill failure precedes exit", async () => {
    await cancellationWithFailedTreeCleanup(true);
});

test("stop catch retains cleanup failure, original cause and fallback for a live worker", async () => {
    await cancellationWithFailedTreeCleanup(false);
});
