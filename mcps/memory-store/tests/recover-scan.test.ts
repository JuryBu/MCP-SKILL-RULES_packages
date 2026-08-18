import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mstore-recover-scan-"));
process.env.MEMORY_STORE_DATA_ROOT = TMP_ROOT;
process.env.MEMORY_STORE_BACKGROUND_TASK_CONCURRENCY = "1";

const {
    __testHasTaskInMemory,
    __testResetBackgroundTasksForTest,
    __testWritePersistedTask,
    clearBackgroundTaskRecoveryHandlersForTest,
    getBackgroundTask,
    normalizeResumePayload,
    recoverBackgroundTask,
    registerBackgroundTaskRecoveryHandler,
    scanOrphanedTasks,
    stableJsonHash,
    waitForBackgroundTask,
} = await import("../src/background-tasks.ts");

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await sleep(20);
    }
    assert.fail(`等待超时: ${label}`);
}

function runningTask(taskId: string, kind: string, payload: Record<string, unknown>, overrideHash?: string) {
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    return {
        id: taskId,
        kind,
        status: "running" as const,
        startedAt,
        updatedAt: startedAt,
        maxRunMs: 60_000,
        resumePayload: payload,
        resumeVersion: 1,
        resumeHash: overrideHash ?? stableJsonHash(payload),
        ownerPid: 2_147_483_647,
    };
}

let failed = false;
async function step(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`✅ ${name}`);
    } catch (error) {
        failed = true;
        console.error(`❌ ${name}:`, error instanceof Error ? error.message : String(error));
    }
}

try {
    await step("scanOrphanedTasks 保留普通任务恢复，并拒绝 legacy Record generic 重跑", async () => {
        __testResetBackgroundTasksForTest();
        clearBackgroundTaskRecoveryHandlersForTest();

        const doneTask = {
            id: "done-history",
            kind: "record-update",
            status: "done" as const,
            startedAt: new Date(Date.now() - 7_000).toISOString(),
            updatedAt: new Date(Date.now() - 6_000).toISOString(),
            finishedAt: new Date(Date.now() - 6_000).toISOString(),
            result: "DONE_HISTORY",
        };
        const errorTask = {
            id: "error-history",
            kind: "golden-extract",
            status: "error" as const,
            startedAt: new Date(Date.now() - 7_000).toISOString(),
            updatedAt: new Date(Date.now() - 6_000).toISOString(),
            finishedAt: new Date(Date.now() - 6_000).toISOString(),
            error: "OLD_ERROR",
        };
        const cancelledTask = {
            id: "cancelled-history",
            kind: "stage-guard-check",
            status: "cancelled" as const,
            startedAt: new Date(Date.now() - 7_000).toISOString(),
            updatedAt: new Date(Date.now() - 6_000).toISOString(),
            finishedAt: new Date(Date.now() - 6_000).toISOString(),
            error: "OLD_CANCEL",
        };

        __testWritePersistedTask(doneTask);
        __testWritePersistedTask(errorTask);
        __testWritePersistedTask(cancelledTask);
        const legacyRecordUpdatePayload = { b: 2, a: 1 };
        const legacyRecordBatchPayload = { records: ["first", "second"], force: false };
        __testWritePersistedTask(runningTask("resume-generic", "generic-resume", { b: 2, a: 1 }, stableJsonHash({ a: 1, b: 2 })));
        __testWritePersistedTask(runningTask("restart-guard", "stage-guard-check", { guard: "stage2" }));
        __testWritePersistedTask(runningTask("bad-hash", "generic-resume", { foo: "bar" }, "not-the-real-hash"));
        __testWritePersistedTask(runningTask("unknown-kind", "mystery-task", { foo: "bar" }));
        __testWritePersistedTask(runningTask("deep-locate-task", "conversation-deep-locate", { query: "needle" }));
        __testWritePersistedTask(runningTask("legacy-record-update", "record-update", legacyRecordUpdatePayload));
        __testWritePersistedTask(runningTask("legacy-record-batch", "record-batch-update", legacyRecordBatchPayload));
        __testWritePersistedTask({
            ...runningTask("live-owner", "generic-resume", { owner: "alive" }),
            ownerPid: process.pid,
        });

        registerBackgroundTaskRecoveryHandler("generic-resume", () => ({
            mode: "resume",
            run: async ({ updateProgress }) => {
                updateProgress({ current: 1, total: 1, detail: "resume ok" });
                return "RESUME_OK";
            },
        }));
        let legacyRecordHandlerCalls = 0;
        registerBackgroundTaskRecoveryHandler("record-update", () => {
            legacyRecordHandlerCalls++;
            return { mode: "resume", run: async () => "LEGACY_RECORD_SHOULD_NOT_RUN" };
        });
        registerBackgroundTaskRecoveryHandler("record-batch-update", () => {
            legacyRecordHandlerCalls++;
            return { mode: "resume", run: async () => "LEGACY_RECORD_SHOULD_NOT_RUN" };
        });
        registerBackgroundTaskRecoveryHandler("stage-guard-check", () => ({
            mode: "restart",
            run: async ({ updateProgress }) => {
                updateProgress({ current: 1, total: 1, detail: "restart ok" });
                return "RESTART_OK";
            },
        }));

        const summary = await scanOrphanedTasks();
        assert.equal(summary.scanned, 11);
        assert.equal(summary.loaded, 3);
        assert.equal(summary.resumed, 1);
        assert.equal(summary.restarted, 1);
        assert.equal(summary.errored, 5);
        assert.equal(summary.ignored, 1);

        const resumedResult = summary.results.find(item => item.taskId === "resume-generic");
        const restartedResult = summary.results.find(item => item.taskId === "restart-guard");
        const legacyRecordUpdateResult = summary.results.find(item => item.taskId === "legacy-record-update");
        const legacyRecordBatchResult = summary.results.find(item => item.taskId === "legacy-record-batch");
        assert.equal(resumedResult?.outcome, "resumed");
        assert.equal(restartedResult?.outcome, "restarted");
        assert.ok(restartedResult?.recoveredTaskId, "restart 应生成新 taskId");
        assert.equal(legacyRecordUpdateResult?.outcome, "error");
        assert.equal(legacyRecordBatchResult?.outcome, "error");
        assert.equal(legacyRecordUpdateResult?.recoveredTaskId, undefined);
        assert.equal(legacyRecordBatchResult?.recoveredTaskId, undefined);
        assert.match(legacyRecordUpdateResult?.reason || "", /缺少 schedulerAdmission/u);
        assert.match(legacyRecordBatchResult?.reason || "", /缺少 schedulerAdmission/u);
        assert.equal(legacyRecordHandlerCalls, 0, "legacy Record 不得进入 generic recovery handler");

        const resumedTask = await waitForBackgroundTask("resume-generic", 2);
        const restartedTask = await waitForBackgroundTask(restartedResult!.recoveredTaskId!, 2);
        assert.equal(resumedTask?.status, "done");
        assert.equal(resumedTask?.result, "RESUME_OK");
        assert.equal(resumedTask?.recovered, true);
        assert.equal(restartedTask?.status, "done");
        assert.equal(restartedTask?.result, "RESTART_OK");
        assert.equal(restartedTask?.recovered, true);
        assert.equal(restartedTask?.recoveredFrom, "restart-guard");

        const restartedOriginal = getBackgroundTask("restart-guard");
        assert.equal(restartedOriginal?.status, "error");
        assert.equal(restartedOriginal?.recovered, true);
        assert.equal(restartedOriginal?.recoveredBy, restartedResult!.recoveredTaskId);

        const badHash = getBackgroundTask("bad-hash");
        const unknownKind = getBackgroundTask("unknown-kind");
        const deepLocate = getBackgroundTask("deep-locate-task");
        assert.equal(badHash?.status, "error");
        assert.match(badHash?.error || "", /hash/iu);
        assert.equal(unknownKind?.status, "error");
        assert.match(unknownKind?.error || "", /handler/u);
        assert.equal(deepLocate?.status, "error");
        assert.match(deepLocate?.error || "", /deep-locate/u);
        assert.equal(getBackgroundTask("live-owner")?.status, "running");

        for (const [taskId, resumePayload] of [
            ["legacy-record-update", legacyRecordUpdatePayload],
            ["legacy-record-batch", legacyRecordBatchPayload],
        ] as const) {
            const legacyTask = getBackgroundTask(taskId);
            const persisted = JSON.parse(fs.readFileSync(path.join(TMP_ROOT, "tasks", `${taskId}.json`), "utf8")) as {
                id?: string;
                status?: string;
                error?: string;
                resumePayload?: unknown;
                resumeHash?: string;
            };
            assert.equal(legacyTask?.id, taskId);
            assert.equal(legacyTask?.status, "error");
            assert.match(legacyTask?.error || "", /缺少 schedulerAdmission/u);
            assert.equal(persisted.id, taskId);
            assert.equal(persisted.status, "error");
            assert.match(persisted.error || "", /原 resumePayload 已保留/u);
            assert.deepEqual(persisted.resumePayload, resumePayload);
            assert.equal(persisted.resumeHash, stableJsonHash(resumePayload));
        }

        assert.equal(__testHasTaskInMemory(doneTask.id), true);
        assert.equal(__testHasTaskInMemory(errorTask.id), true);
        assert.equal(__testHasTaskInMemory(cancelledTask.id), true);
    });

    await step("recoverBackgroundTask 用原子 claim 防止重复恢复", async () => {
        __testResetBackgroundTasksForTest();
        clearBackgroundTaskRecoveryHandlersForTest();

        let releaseGate: () => void = () => {};
        const gate = new Promise<void>(resolve => { releaseGate = resolve; });
        __testWritePersistedTask(runningTask("claim-task", "generic-resume", { shard: 1 }));
        registerBackgroundTaskRecoveryHandler("generic-resume", () => ({
            mode: "resume",
            run: async () => {
                await gate;
                return "CLAIMED_ONCE";
            },
        }));

        const [first, second] = await Promise.all([
            recoverBackgroundTask("claim-task"),
            recoverBackgroundTask("claim-task"),
        ]);

        const outcomes = [first.outcome, second.outcome].sort();
        assert.deepEqual(outcomes, ["claimed", "resumed"]);

        releaseGate();
        await waitUntil("claim-task 恢复任务完成", () => getBackgroundTask("claim-task")?.status === "done");
        const claimedTask = await waitForBackgroundTask("claim-task", 2);
        assert.equal(claimedTask?.result, "CLAIMED_ONCE");
    });

    await step("死进程遗留 claim 可被接管，存活进程 claim 不被抢占", async () => {
        __testResetBackgroundTasksForTest();
        clearBackgroundTaskRecoveryHandlersForTest();
        fs.mkdirSync(path.join(TMP_ROOT, "tasks"), { recursive: true });
        registerBackgroundTaskRecoveryHandler("generic-resume", () => ({
            mode: "resume",
            run: async () => "STALE_CLAIM_RECOVERED",
        }));

        __testWritePersistedTask(runningTask("stale-claim", "generic-resume", { shard: 2 }));
        fs.writeFileSync(
            path.join(TMP_ROOT, "tasks", "stale-claim.claim"),
            JSON.stringify({ taskId: "stale-claim", pid: 2_147_483_647, claimedAt: new Date().toISOString() }),
            "utf8",
        );
        const staleClaimResult = await recoverBackgroundTask("stale-claim");
        assert.equal(staleClaimResult.outcome, "resumed");
        assert.equal((await waitForBackgroundTask("stale-claim", 2))?.result, "STALE_CLAIM_RECOVERED");

        __testWritePersistedTask(runningTask("live-claim", "generic-resume", { shard: 3 }));
        fs.writeFileSync(
            path.join(TMP_ROOT, "tasks", "live-claim.claim"),
            JSON.stringify({ taskId: "live-claim", pid: process.pid, claimedAt: new Date().toISOString() }),
            "utf8",
        );
        const liveClaimResult = await recoverBackgroundTask("live-claim");
        assert.equal(liveClaimResult.outcome, "claimed");
    });

    await step("resumePayload 拒绝超深结构", () => {
        let payload: unknown = "leaf";
        for (let index = 0; index < 20; index++) payload = { nested: payload };
        assert.throws(() => normalizeResumePayload(payload), /深度/u);
    });

    await step("任务文件名与内部 id 不一致时拒绝读取", async () => {
        __testResetBackgroundTasksForTest();
        fs.mkdirSync(path.join(TMP_ROOT, "tasks"), { recursive: true });
        fs.writeFileSync(
            path.join(TMP_ROOT, "tasks", "expected-id.json"),
            JSON.stringify(runningTask("different-id", "generic-resume", { shard: 4 })),
            "utf8",
        );
        const result = await recoverBackgroundTask("expected-id");
        assert.equal(result.outcome, "ignored");
        assert.match(result.reason || "", /不存在或损坏/u);
    });

    await step("taskId 路径穿越被拒绝", async () => {
        fs.writeFileSync(
            path.join(TMP_ROOT, "escaped.json"),
            JSON.stringify({
                id: "../escaped",
                kind: "generic-resume",
                status: "done",
                startedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                result: "OUTSIDE_TASKS_DIR",
            }),
            "utf8",
        );
        const result = await recoverBackgroundTask("../escaped");
        assert.equal(result.outcome, "ignored");
        assert.match(result.reason || "", /taskId 格式非法/u);
        assert.equal(getBackgroundTask("../escaped"), null);
    });

    await step("缺少 ownerPid 的普通 legacy running 任务达到陈旧阈值前不恢复", async () => {
        __testResetBackgroundTasksForTest();
        clearBackgroundTaskRecoveryHandlersForTest();
        const legacyTask = runningTask("legacy-no-owner", "generic-resume", { shard: 5 });
        delete (legacyTask as { ownerPid?: number }).ownerPid;
        __testWritePersistedTask(legacyTask);
        registerBackgroundTaskRecoveryHandler("generic-resume", () => ({
            mode: "resume",
            run: async () => "SHOULD_NOT_RUN",
        }));
        const result = await recoverBackgroundTask("legacy-no-owner");
        assert.equal(result.outcome, "ignored");
        assert.match(result.reason || "", /缺少 ownerPid/u);
    });

    if (failed) {
        console.error("❌ recover-scan 存在失败用例");
        process.exit(1);
    }
    console.log("✅ recover-scan 全部通过");
} finally {
    clearBackgroundTaskRecoveryHandlersForTest();
    __testResetBackgroundTasksForTest();
    try {
        fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
        // ignore cleanup error
    }
    delete process.env.MEMORY_STORE_BACKGROUND_TASK_CONCURRENCY;
}
