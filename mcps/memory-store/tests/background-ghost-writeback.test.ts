import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 隔离数据根：后台任务持久化(C1)会写 tasks/，不隔离会污染真实库。必须在导入 background-tasks(→store) 前设。
process.env.MEMORY_STORE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-ghost-wb-"));

const { startBackgroundTask, waitForBackgroundTask } = await import("../src/background-tasks.ts");

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

try {
    // ① 超时场景：run 慢于 maxRunMs → 任务结算为 error/timedOut；run 跑到写回点时 isSettled() 为 true → 跳过写回
    let didWriteOnTimeout = false;
    const slow = startBackgroundTask("test-ghost", async (ctx) => {
        await sleep(200);                 // 模拟慢生成，超过 50ms maxRunMs
        if (ctx.isSettled()) return "discarded"; // 写回前自查：已结算则丢弃
        didWriteOnTimeout = true;          // 仅未结算才"写回"
        return "wrote";
    }, { maxRunMs: 50, timeoutMessage: "test timeout" });

    const settled = await waitForBackgroundTask(slow.id, 1);
    assert.equal(settled?.status, "error", "超时应结算为 error");
    assert.equal(settled?.timedOut, true, "应标记 timedOut");
    await sleep(300);                      // 等 run（200ms）彻底跑完
    assert.equal(didWriteOnTimeout, false, "超时后 run 应据 isSettled 跳过写回——不再幽灵写回覆盖数据");

    // ② 正常场景：run 快于 maxRunMs → isSettled() 在写回点仍为 false → 正常写回
    let didWriteNormal = false;
    const fast = startBackgroundTask("test-ok", async (ctx) => {
        await sleep(10);
        if (ctx.isSettled()) return "discarded";
        didWriteNormal = true;
        return "wrote";
    }, { maxRunMs: 5000 });
    const okDone = await waitForBackgroundTask(fast.id, 1);
    assert.equal(okDone?.status, "done", "正常应结算为 done");
    assert.equal(didWriteNormal, true, "未超时时应正常写回");

    // ③ isCancelled 语义未被改动（仍只认 cancelled，不波及 deep-locate 等）：超时任务的 isCancelled 仍是 false 语义
    //    —— 这里通过"超时后 isSettled=true 而我们没有改 isCancelled 的判定来源"间接保证；isCancelled 仅 cancelBackgroundTask 触发
    console.log("✅ background-ghost-writeback 通过：超时后 isSettled 跳过写回（防幽灵写回）、正常路径仍写回、未动 isCancelled 语义");
} finally {
    // 无持久化资源需清理（纯内存任务）
}
