import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mstore-bg-cancel-"));
process.env.MEMORY_STORE_DATA_ROOT = TMP_ROOT;
process.env.MEMORY_STORE_BACKGROUND_TASK_CONCURRENCY = "1";

const TASKS_DIR = path.join(TMP_ROOT, "tasks");

const {
    __testWritePersistedTask,
    startBackgroundTask,
    waitForBackgroundTask,
} = await import("../src/background-tasks.ts");
const { registerBackgroundTask } = await import("../src/tools/background-task.ts");

const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>>();
const fakeServer = {
    tool(
        name: string,
        _description: string,
        _schema: unknown,
        handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
    ) {
        handlers.set(name, handler);
    },
};

registerBackgroundTask(fakeServer as never);

const statusHandler = handlers.get("background_task_status");
const cancelHandler = handlers.get("background_task_cancel");

assert.ok(statusHandler, "应注册 canonical background_task_status");
assert.ok(cancelHandler, "应注册 canonical background_task_cancel");

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 1500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(20);
    }
    assert.fail(`等待超时: ${label}`);
}

function taskFile(taskId: string): string {
    return path.join(TASKS_DIR, `${taskId}.json`);
}

try {
    const missingStatus = await statusHandler!({ taskId: "missing-task", waitSeconds: 0 });
    assert.equal(missingStatus.content[0].text, "❌ 未找到后台任务", "未知 task 的 status 应返回统一未找到格式");

    const missingCancel = await cancelHandler!({ taskId: "missing-task" });
    assert.equal(missingCancel.content[0].text, "❌ 未找到后台任务", "未知 task 的 cancel 应返回统一未找到格式");

    const persistedTaskId = "record-update-persisted-cancel";
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    __testWritePersistedTask({
        id: persistedTaskId,
        kind: "record-update",
        status: "running",
        startedAt,
        updatedAt: startedAt,
        maxRunMs: 60_000,
    });

    const cancelledPersisted = await cancelHandler!({ taskId: persistedTaskId, reason: "persisted cancel" });
    assert.match(cancelledPersisted.content[0].text, /后台任务已取消/u, "持久化 task 应可被 canonical cancel 取消");
    assert.match(cancelledPersisted.content[0].text, /persisted cancel/u, "取消结果应带回原因");

    const persistedOnDisk = JSON.parse(fs.readFileSync(taskFile(persistedTaskId), "utf-8"));
    assert.equal(persistedOnDisk.status, "cancelled", "取消后应回写持久化文件");
    assert.equal(persistedOnDisk.error, "persisted cancel", "持久化文件应记录取消原因");

    const duplicateCancel = await cancelHandler!({ taskId: persistedTaskId, reason: "second cancel" });
    assert.match(duplicateCancel.content[0].text, /后台任务已取消/u, "重复取消应保持 cancelled 而非报错");
    assert.doesNotMatch(duplicateCancel.content[0].text, /second cancel/u, "重复取消不应覆盖第一次持久化的原因");

    const persistedStatus = await statusHandler!({ taskId: persistedTaskId, waitSeconds: 0 });
    assert.match(persistedStatus.content[0].text, /后台任务已取消/u, "status 应与 cancel 返回一致格式");
    assert.match(persistedStatus.content[0].text, /persisted cancel/u, "status 应读到持久化取消原因");

    let releaseBlocker: () => void = () => {};
    let blockerStarted = false;
    const blockerGate = new Promise<void>(resolve => { releaseBlocker = resolve; });
    const blocker = startBackgroundTask("cancel-queue-blocker", async () => {
        blockerStarted = true;
        await blockerGate;
        return "blocker done";
    }, { maxRunMs: 5_000 });
    await waitUntil("blocker 占用唯一后台槽位", () => blockerStarted);

    let queuedRunStarted = false;
    const queued = startBackgroundTask("remote-cancel-before-start", async () => {
        queuedRunStarted = true;
        return "should not run";
    }, { maxRunMs: 5_000 });
    const queuedCancelAt = new Date().toISOString();
    __testWritePersistedTask({
        ...queued,
        status: "cancelled",
        updatedAt: queuedCancelAt,
        finishedAt: queuedCancelAt,
        error: "remote cancel before start",
    });
    releaseBlocker();
    await waitForBackgroundTask(blocker.id, 2);
    const queuedResult = await waitForBackgroundTask(queued.id, 2);
    assert.equal(queuedResult?.status, "cancelled", "排队任务应保持远程取消态");
    assert.equal(queuedRunStarted, false, "排队期间被跨进程取消的任务不得启动 run 回调");

    let releaseNonPolling: () => void = () => {};
    let nonPollingStarted = false;
    const nonPollingGate = new Promise<void>(resolve => { releaseNonPolling = resolve; });
    const nonPolling = startBackgroundTask("remote-cancel-non-polling", async () => {
        nonPollingStarted = true;
        await nonPollingGate;
        return "NON_POLLING_DONE";
    }, { maxRunMs: 5_000 });
    await waitUntil("non-polling task started", () => nonPollingStarted);
    const nonPollingCancelAt = new Date().toISOString();
    __testWritePersistedTask({
        ...nonPolling,
        status: "cancelled",
        updatedAt: nonPollingCancelAt,
        finishedAt: nonPollingCancelAt,
        error: "remote cancel non-polling",
    });
    releaseNonPolling();
    const nonPollingResult = await waitForBackgroundTask(nonPolling.id, 2);
    assert.equal(nonPollingResult?.status, "cancelled", "非轮询任务结束时不得把远程取消覆盖成 done");
    assert.notEqual(nonPollingResult?.result, "NON_POLLING_DONE", "远程取消后不得持久化非轮询任务结果");

    let observedCancelled = false;
    const remoteCancelledTask = startBackgroundTask("remote-cancel-visible", async ({ isCancelled }) => {
        for (let i = 0; i < 100; i++) {
            if (isCancelled()) {
                observedCancelled = true;
                return "local cancel observer";
            }
            await sleep(10);
        }
        return "cancel not observed";
    }, { maxRunMs: 5_000 });

    await sleep(40);
    const remoteCancelAt = new Date().toISOString();
    __testWritePersistedTask({
        ...remoteCancelledTask,
        status: "cancelled",
        updatedAt: remoteCancelAt,
        finishedAt: remoteCancelAt,
        error: "remote cancel",
    });

    await waitUntil("isCancelled 感知到跨进程取消", () => observedCancelled);
    const remoteCancelledResult = await waitForBackgroundTask(remoteCancelledTask.id, 2);
    assert.equal(remoteCancelledResult?.status, "cancelled", "跨进程写入 cancelled 后，本进程应读到取消态");
    assert.equal(remoteCancelledResult?.error, "remote cancel", "跨进程取消原因应同步到内存态");

    let observedSettled = false;
    const remoteSettledTask = startBackgroundTask("remote-settled-visible", async ({ isSettled }) => {
        for (let i = 0; i < 100; i++) {
            if (isSettled()) {
                observedSettled = true;
                return "local settled observer";
            }
            await sleep(10);
        }
        return "settled not observed";
    }, { maxRunMs: 5_000 });

    await sleep(40);
    const remoteDoneAt = new Date().toISOString();
    __testWritePersistedTask({
        ...remoteSettledTask,
        status: "done",
        updatedAt: remoteDoneAt,
        finishedAt: remoteDoneAt,
        result: "REMOTE_DONE",
    });

    await waitUntil("isSettled 感知到跨进程终态", () => observedSettled);
    const remoteSettledResult = await waitForBackgroundTask(remoteSettledTask.id, 2);
    assert.equal(remoteSettledResult?.status, "done", "跨进程写入 done 后，本进程应停止视其为 running");
    assert.equal(remoteSettledResult?.result, "REMOTE_DONE", "跨进程终态结果应同步到内存态");

    console.log("✅ background-task-cancel tests passed");
} finally {
    try {
        fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
        // ignore cleanup error
    }
    delete process.env.MEMORY_STORE_BACKGROUND_TASK_CONCURRENCY;
}
