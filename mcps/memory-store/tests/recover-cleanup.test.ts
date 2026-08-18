import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mstore-recover-clean-"));
process.env.MEMORY_STORE_DATA_ROOT = TMP_ROOT;
process.env.MEMORY_STORE_BACKGROUND_TASK_TTL = "1";

const TASKS_DIR = path.join(TMP_ROOT, "tasks");

const {
    __testResetBackgroundTasksForTest,
    __testTaskPreservePath,
    __testWritePersistedTask,
    cleanOldTasks,
    getBackgroundTask,
} = await import("../src/background-tasks.ts");

function daysAgo(days: number): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
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
    await step("cleanOldTasks 删除 15 天前非 running 历史并保留 .preserve / running", () => {
        __testResetBackgroundTasksForTest();

        __testWritePersistedTask({
            id: "old-done",
            kind: "record-update",
            status: "done",
            startedAt: daysAgo(20),
            updatedAt: daysAgo(20),
            finishedAt: daysAgo(20),
            result: "old",
        });
        __testWritePersistedTask({
            id: "old-preserved",
            kind: "record-update",
            status: "done",
            startedAt: daysAgo(20),
            updatedAt: daysAgo(20),
            finishedAt: daysAgo(20),
            result: "keep",
        });
        __testWritePersistedTask({
            id: "old-running",
            kind: "record-update",
            status: "running",
            startedAt: daysAgo(20),
            updatedAt: daysAgo(20),
            maxRunMs: 60_000,
        });
        __testWritePersistedTask({
            id: "recent-error",
            kind: "golden-extract",
            status: "error",
            startedAt: daysAgo(2),
            updatedAt: daysAgo(2),
            finishedAt: daysAgo(2),
            error: "recent",
        });
        __testWritePersistedTask({
            id: "ttl-history",
            kind: "golden-extract",
            status: "done",
            startedAt: daysAgo(2),
            updatedAt: daysAgo(2),
            finishedAt: daysAgo(2),
            result: "history",
        });

        fs.mkdirSync(TASKS_DIR, { recursive: true });
        fs.writeFileSync(__testTaskPreservePath("old-preserved"), "", "utf8");
        fs.writeFileSync(path.join(TASKS_DIR, "dangling.preserve"), "", "utf8");
        fs.writeFileSync(path.join(TASKS_DIR, "dangling.claim"), "", "utf8");
        fs.writeFileSync(path.join(TASKS_DIR, "dangling.guard-pass"), "", "utf8");
        fs.writeFileSync(path.join(TASKS_DIR, "broken.json"), "{not-valid-json", "utf8");

        const summary = cleanOldTasks();
        assert.deepEqual(summary.deletedTaskIds, ["old-done"]);
        assert.deepEqual(summary.preservedTaskIds, ["old-preserved"]);
        assert.deepEqual(summary.keptRunningTaskIds, ["old-running"]);
        assert.deepEqual(summary.invalidTaskFiles, ["broken.json"]);
        assert.deepEqual(summary.deletedDanglingPreserveFiles, ["dangling.preserve"]);
        assert.deepEqual(summary.deletedDanglingClaimFiles, ["dangling.claim"]);
        assert.deepEqual(summary.deletedDanglingRecoveryFiles, ["dangling.guard-pass"]);

        assert.equal(fs.existsSync(path.join(TASKS_DIR, "old-done.json")), false);
        assert.equal(fs.existsSync(path.join(TASKS_DIR, "old-preserved.json")), true);
        assert.equal(fs.existsSync(path.join(TASKS_DIR, "old-running.json")), true);
        assert.equal(fs.existsSync(path.join(TASKS_DIR, "recent-error.json")), true);
        assert.equal(getBackgroundTask("ttl-history")?.result, "history");
        assert.equal(fs.existsSync(path.join(TASKS_DIR, "ttl-history.json")), true, "内存 TTL 不得绕过 15 天清理策略删除历史文件");
        assert.equal(getBackgroundTask("old-done"), null);
    });

    if (failed) {
        console.error("❌ recover-cleanup 存在失败用例");
        process.exit(1);
    }
    console.log("✅ recover-cleanup 全部通过");
} finally {
    __testResetBackgroundTasksForTest();
    try {
        fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
        // ignore cleanup error
    }
    delete process.env.MEMORY_STORE_BACKGROUND_TASK_TTL;
}
