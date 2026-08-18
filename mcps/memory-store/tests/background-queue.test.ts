import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mstore-bgqueue-"));
process.env.MEMORY_STORE_DATA_ROOT = TMP_ROOT;
process.env.MEMORY_STORE_BACKGROUND_MAX_CONCURRENCY = "2";

const {
    cancelBackgroundTask,
    formatBackgroundTask,
    getBackgroundTask,
    getBackgroundTaskQueueLaneStatsForTest,
    getBackgroundTaskQueueStatsForTest,
    resetBackgroundTaskQueueForTest,
    startBackgroundTask,
    waitForBackgroundTask,
} = await import("../src/background-tasks.ts");
const { installToolConcurrency, resetToolConcurrencyForTest } = await import("../src/tool-concurrency.ts");

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void; isResolved: () => boolean } {
    let resolve: () => void = () => {};
    let resolved = false;
    const promise = new Promise<void>(r => {
        resolve = () => {
            resolved = true;
            r();
        };
    });
    return { promise, resolve, isResolved: () => resolved };
}

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(10);
    }
    assert.fail(`等待超时: ${label}`);
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs = 100): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

try {
    resetBackgroundTaskQueueForTest();
    resetToolConcurrencyForTest();

    const gates = Array.from({ length: 5 }, () => deferred());
    const started: number[] = [];
    const finished: number[] = [];
    let active = 0;
    let maxActive = 0;

    const tasks = gates.map((gate, index) => startBackgroundTask("test-default-background", async ({ updateProgress }) => {
        started.push(index);
        active++;
        maxActive = Math.max(maxActive, active);
        updateProgress({
            stage: "test-running",
            detail: `任务 ${index} 正在等待 gate`,
            current: index + 1,
            total: gates.length,
            unit: "个任务",
        });
        await gate.promise;
        active--;
        finished.push(index);
        return `done-${index}`;
    }, { maxRunMs: 5000 }));

    assert.equal(new Set(tasks.map(task => task.id)).size, 5, "5 个后台任务都应立即拿到唯一 taskId");
    await waitUntil("前两个任务启动", () => started.length === 2);
    assert.deepEqual(started, [0, 1], "队列应按 FIFO 启动前两个任务");
    assert.equal(maxActive, 2, "后台队列并发上限应为 2");
    assert.deepEqual(getBackgroundTaskQueueStatsForTest(), { active: 2, pending: 3 }, "应有 2 个 running + 3 个 queued");

    const queuedTask = getBackgroundTask(tasks[2].id);
    assert.equal(queuedTask?.status, "running", "排队任务仍应可被 task_status 查询到");
    assert.equal(queuedTask?.progress?.stage, "queued", "排队任务应保留 queued 进度阶段");
    assert.match(formatBackgroundTask(queuedTask), /queued|等待后台任务队列调度/u, "formatBackgroundTask 应能展示排队状态");

    const handlers = new Map<string, (args?: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>>();
    const fakeServer = {
        tool(name: string, _description: string, _schema: unknown, handler: (args?: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>) {
            handlers.set(name, handler);
        },
    };
    installToolConcurrency(fakeServer);
    fakeServer.tool("record_manage", "", {}, async args => ({ content: [{ type: "text" as const, text: `record ${String(args?.action || "")} ok` }] }));
    fakeServer.tool("memory_query", "", {}, async () => ({ content: [{ type: "text" as const, text: "memory query ok" }] }));
    fakeServer.tool("conversation_read_original", "", {}, async args => ({ content: [{ type: "text" as const, text: `conversation ${String(args?.action || "")} ok` }] }));

    const quickResults = await Promise.all([
        withTimeout("record task_status", handlers.get("record_manage")!({ action: "task_status", taskId: tasks[0].id })),
        withTimeout("record list", handlers.get("record_manage")!({ action: "list" })),
        withTimeout("memory query", handlers.get("memory_query")!({ query: "hello", mode: "exact" })),
        withTimeout("conversation search", handlers.get("conversation_read_original")!({ action: "search", conversationId: "abc", query: "hello" })),
    ]);
    assert.deepEqual(
        quickResults.map(result => result.content[0].text),
        ["record task_status ok", "record list ok", "memory query ok", "conversation search ok"],
        "前台读类和 task_status 不应被后台队列阻塞",
    );

    gates[0].resolve();
    await waitUntil("第三个任务启动", () => started.length === 3);
    assert.deepEqual(started, [0, 1, 2], "释放第一个任务后应按 FIFO 启动第 3 个任务");
    assert.equal(maxActive, 2, "释放后最大并发仍不能超过 2");

    for (const gate of gates.slice(1)) gate.resolve();
    const settled = await Promise.all(tasks.map(task => waitForBackgroundTask(task.id, 3)));
    assert.deepEqual(settled.map(task => task?.status), ["done", "done", "done", "done", "done"], "所有后台任务都应完成");
    assert.deepEqual(finished.sort((a, b) => a - b), [0, 1, 2, 3, 4], "所有任务都应实际执行");

    resetBackgroundTaskQueueForTest();

    const batchGates = Array.from({ length: 9 }, () => deferred());
    const batchStarted: number[] = [];
    const batchFinished: number[] = [];
    const batchTasks = batchGates.map((gate, index) => startBackgroundTask("record-batch-update", async ({ isCancelled, updateProgress }) => {
        batchStarted.push(index);
        updateProgress({ stage: "batch-running", detail: `batch ${index} 已进入专用 lane` });
        while (!isCancelled() && !gate.isResolved()) await sleep(10);
        if (isCancelled()) return `cancelled-${index}`;
        if (index === 1) throw new Error("batch boom");
        batchFinished.push(index);
        return `batch-${index}`;
    }, { maxRunMs: 5000 }));

    await waitUntil("前 8 个 batch orchestrator 启动", () => batchStarted.length === 8);
    assert.deepEqual(batchStarted, [0, 1, 2, 3, 4, 5, 6, 7], "batch orchestrator 应按 FIFO 进入 8 槽专用 lane");
    assert.deepEqual(
        getBackgroundTaskQueueLaneStatsForTest(),
        {
            default: { active: 0, pending: 0 },
            recordUpdate: { active: 0, pending: 0 },
            recordBatchUpdate: { active: 8, pending: 1 },
        },
        "record-batch-update 应使用独立 lane，并暴露 active/pending",
    );

    const normalGates = Array.from({ length: 3 }, () => deferred());
    const normalStarted: number[] = [];
    const normalTasks = normalGates.map((gate, index) => startBackgroundTask("test-default-background", async () => {
        normalStarted.push(index);
        await gate.promise;
        return `normal-${index}`;
    }, { maxRunMs: 5000 }));

    await waitUntil("普通任务仍只启动 2 个", () => normalStarted.length === 2);
    assert.deepEqual(normalStarted, [0, 1], "普通后台任务仍应按默认 lane 的 FIFO 启动");
    assert.deepEqual(
        getBackgroundTaskQueueLaneStatsForTest(),
        {
            default: { active: 2, pending: 1 },
            recordUpdate: { active: 0, pending: 0 },
            recordBatchUpdate: { active: 8, pending: 1 },
        },
        "其他任务不应被专用 lane 提升并发",
    );

    cancelBackgroundTask(batchTasks[0].id, "test cancel");
    await waitUntil("取消后第 9 个 batch 获得 lane 槽位", () => batchStarted.length === 9);
    assert.equal(getBackgroundTask(batchTasks[0].id)?.status, "cancelled", "已取消的 batch 任务应落为 cancelled");

    batchGates[1].resolve();
    await waitUntil("异常 batch 释放 lane", () => getBackgroundTask(batchTasks[1].id)?.status === "error");
    assert.equal(getBackgroundTask(batchTasks[1].id)?.error, "batch boom", "异常 batch 应记录错误");

    for (const gate of batchGates.slice(2)) gate.resolve();
    normalGates[0].resolve();
    await waitUntil("第三个普通任务启动", () => normalStarted.length === 3);
    normalGates[1].resolve();
    normalGates[2].resolve();

    const batchSettled = await Promise.all(batchTasks.map(task => waitForBackgroundTask(task.id, 3)));
    assert.deepEqual(
        batchSettled.map(task => task?.status),
        ["cancelled", "error", "done", "done", "done", "done", "done", "done", "done"],
        "batch lane 的取消/异常/成功都应正确结算",
    );
    assert.deepEqual(batchFinished.sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8], "未取消且未异常的 batch 任务应实际完成");

    const normalSettled = await Promise.all(normalTasks.map(task => waitForBackgroundTask(task.id, 3)));
    assert.deepEqual(normalSettled.map(task => task?.status), ["done", "done", "done"], "普通任务仍应全部完成");
    assert.deepEqual(getBackgroundTaskQueueStatsForTest(), { active: 0, pending: 0 }, "所有 lane 释放后，全局队列统计应归零");
    assert.deepEqual(
        getBackgroundTaskQueueLaneStatsForTest(),
        {
            default: { active: 0, pending: 0 },
            recordUpdate: { active: 0, pending: 0 },
            recordBatchUpdate: { active: 0, pending: 0 },
        },
        "lane 级 active/pending 应在 finally 后释放",
    );

    console.log("✅ background-queue tests passed");
} finally {
    try {
        fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
        // ignore cleanup error
    }
    delete process.env.MEMORY_STORE_BACKGROUND_MAX_CONCURRENCY;
}
