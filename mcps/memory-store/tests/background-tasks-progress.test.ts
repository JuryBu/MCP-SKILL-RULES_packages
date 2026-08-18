import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 隔离数据根：后台任务持久化(C1)会写 tasks/，不隔离会污染真实库。改用动态 import 确保 env 在导入 store 前生效。
process.env.MEMORY_STORE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-bg-progress-"));
const { cancelBackgroundTask, formatBackgroundTask, startBackgroundTask, waitForBackgroundTask } = await import("../src/background-tasks.ts");

const task = startBackgroundTask("progress-test", async ({ updateProgress }) => {
    updateProgress({
        stage: "模型分批生成",
        current: 3,
        total: 10,
        unit: "轮",
        detail: "第 2 批处理中，本批 2 轮",
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    return "done";
});

const running = formatBackgroundTask(task);
assert.match(running, /阶段: 模型分批生成/u);
assert.match(running, /进度: 3\/10 轮/u);
assert.match(running, /预计剩余:/u);
assert.match(running, /第 2 批处理中/u);

const completed = await waitForBackgroundTask(task.id, 2);
assert.equal(completed?.status, "done");

const stageEtaTask = startBackgroundTask("stage-eta-test", async ({ updateProgress }) => {
    updateProgress({
        stage: "前置阶段",
        current: 9,
        total: 10,
        unit: "批",
        detail: "前置阶段即将完成",
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    updateProgress({
        stage: "后续阶段",
        current: 1,
        total: 4,
        unit: "组",
        detail: "后续阶段刚开始",
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    return "done";
});

await new Promise(resolve => setTimeout(resolve, 100));
stageEtaTask.startedAt = new Date(Date.now() - 180_000).toISOString();
const stageEtaRunning = formatBackgroundTask(stageEtaTask);
assert.match(stageEtaRunning, /阶段: 后续阶段/u);
assert.match(stageEtaRunning, /进度: 1\/4 组/u);
assert.doesNotMatch(stageEtaRunning, /预计剩余: [1-9]\d*m/u, "ETA should use the current stage start time, not total task elapsed time");
await waitForBackgroundTask(stageEtaTask.id, 2);

let observedCancelled = false;
const cancellable = startBackgroundTask("cancel-test", async ({ isCancelled }) => {
    for (let i = 0; i < 20; i++) {
        if (isCancelled()) {
            observedCancelled = true;
            return "cancel observed";
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return "not cancelled";
});

const cancelled = cancelBackgroundTask(cancellable.id, "test cancel");
assert.equal(cancelled?.status, "cancelled");
assert.match(formatBackgroundTask(cancelled), /后台任务已取消/u);
await new Promise(resolve => setTimeout(resolve, 50));
assert.equal(observedCancelled, true);
