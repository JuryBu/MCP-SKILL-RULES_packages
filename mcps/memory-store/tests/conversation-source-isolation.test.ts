import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runIsolatedSource, applySourcePatch } from "../src/conversation-isolated-source.js";
import { AsyncSemaphore, classifyToolRequest, installToolConcurrency, resetToolConcurrencyForTest, withToolConcurrency } from "../src/tool-concurrency.js";

const target = { file: fileURLToPath(new URL("./fixtures/source-isolation-worker.mjs", import.meta.url)) };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("isolated source: native SQLite cannot block control work, cancellation joins the owned process tree", async () => {
    const abort = new AbortController();
    let pid = 0;
    let descendant = 0;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = runIsolatedSource("host-read", { mode: "native", descendant: true }, {
        signal: abort.signal, deadlineAt: Date.now() + 10000,
        onProgress: progress => { pid = progress.bytes!; descendant = progress.totalBytes!; started(); },
    }, { target });
    const rejection = assert.rejects(pending, (error: any) => error.code === "SOURCE_WORKER_CANCELLED");
    await ready;
    const before = performance.now();
    await delay(30);
    const timerMs = performance.now() - before;
    assert.ok(timerMs < 500, `main event loop delayed ${timerMs}ms`);
    const cancelAt = performance.now();
    abort.abort();
    await rejection;
    assert.equal(alive(pid), false, "native worker must be gone before cancellation resolves");
    assert.equal(alive(descendant), false, "owned descendant must be gone before cancellation resolves");
    console.log(JSON.stringify({ nativePid: pid, descendant, timerMs, cleanupMs: performance.now() - cancelAt }));
    assert.deepEqual(await runIsolatedSource("host-read", { mode: "result" }, {}, { target, timeoutMs: 5000 }), { ok: true });
});

test("isolated source: deadline terminates a non-cooperating job and releases its permit", async () => {
    let pid = 0;
    await assert.rejects(runIsolatedSource("host-read", { mode: "busy" }, {
        deadlineAt: Date.now() + 1000, onProgress: progress => { pid = progress.bytes!; },
    }, { target }), (error: any) => error.code === "SOURCE_WORKER_DEADLINE");
    assert.ok(pid > 0);
    assert.equal(alive(pid), false);
    assert.deepEqual(await runIsolatedSource("host-read", { mode: "result" }, {}, { target, timeoutMs: 5000 }), { ok: true });
});

test("isolated source: chunk reconstruction preserves arrays, text and source keys", () => {
    let value = applySourcePatch(undefined, { type: "set", path: [], value: {} });
    value = applySourcePatch(value, { type: "set", path: ["rounds"], value: [] });
    applySourcePatch(value, { type: "append", path: ["rounds"], value: [{ id: 1 }, { id: 2 }] });
    applySourcePatch(value, { type: "set", path: ["rounds", 2], value: {} });
    applySourcePatch(value, { type: "set", path: ["rounds", 2, "text"], value: "" });
    applySourcePatch(value, { type: "text", path: ["rounds", 2, "text"], value: "中文😀" });
    applySourcePatch(value, { type: "set", path: ["__proto__"], value: { sourceKey: true } });
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.equal(Object.hasOwn(value, "__proto__"), true);
    assert.deepEqual(value.rounds, [{ id: 1 }, { id: 2 }, { text: "中文😀" }]);
    assert.deepEqual(applySourcePatch([], { type: "append", path: [], value: [1, 2] }), [1, 2]);
});

test("control actions bypass saturated polling and mixed queues", async () => {
    resetToolConcurrencyForTest();
    const handlers = new Map<string, (args: any, extra?: any) => Promise<any>>();
    const server = { tool: (name: string, _description: string, _schema: unknown, handler: any) => { handlers.set(name, handler); } };
    installToolConcurrency(server);
    server.tool("conversation_read_original", "", {}, async args => args.action);
    server.tool("background_task_cancel", "", {}, async () => "cancelled");
    const releaseMixed: (() => void)[] = [];
    const releaseLight: (() => void)[] = [];
    const held = (queue: "light" | "mixed", releases: (() => void)[]) => withToolConcurrency(queue, "held", () => new Promise<void>(resolve => releases.push(resolve)));
    const pending = [...Array.from({ length: 6 }, () => held("mixed", releaseMixed)), ...Array.from({ length: 8 }, () => held("light", releaseLight))];
    await delay(10);
    try {
        for (const action of ["prepare_status", "prepare_cancel", "search_all_status", "search_all_cancel", "deep_locate_status", "deep_locate_cancel"]) {
            assert.equal(classifyToolRequest("conversation_read_original", { action }), "control");
            const result = await Promise.race([handlers.get("conversation_read_original")!({ action }), delay(100).then(() => "blocked")]);
            assert.equal(result, action);
        }
        assert.equal(await Promise.race([handlers.get("background_task_cancel")!({}), delay(100).then(() => "blocked")]), "cancelled");
    } finally {
        for (const release of [...releaseMixed, ...releaseLight]) release();
        await Promise.all(pending);
        resetToolConcurrencyForTest();
    }
});
