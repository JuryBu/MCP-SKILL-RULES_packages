import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GuardState } from "../src/guard-store.ts";

// ⚠️ 必须在 import 数据层之前设置临时 DATA_ROOT：startBackgroundTask 会把任务态落盘到
//    DATA_ROOT/tasks；隔离到临时目录避免污染真实库。
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mstore-autobg-"));
process.env.MEMORY_STORE_DATA_ROOT = TMP_ROOT;
process.env.MEMORY_STORE_AUTO_RECORD = "0";

const { decideBackground, isHeavyChain } = await import("../src/chain.ts");
const { clearGuardState, writeGuardState } = await import("../src/guard-store.ts");
const { getBackgroundTask, waitForBackgroundTask } = await import("../src/background-tasks.ts");
const { __testSetStageGuardCheckRunner, runStageGuard } = await import("../src/tools/stage-guard.ts");

let failed = false;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`  ✅ ${name}`))
        .catch(err => {
            failed = true;
            console.error(`  ❌ ${name}: ${err instanceof Error ? err.message : String(err)}`);
        });
}

console.log("auto-background 测试：");

// ── isHeavyChain：只有 codex 为 heavy ──
await check("isHeavyChain 仅 codex 为 true", () => {
    assert.equal(isHeavyChain("codex"), true);
    assert.equal(isHeavyChain("auto"), false);
    assert.equal(isHeavyChain("antigravity"), false);
    assert.equal(isHeavyChain("claude-code"), false);
});

// ── decideBackground 三态（核心：严格区分 === false 与 === undefined）──
await check("background === true → 强制后台（任何链路）", () => {
    assert.deepEqual(decideBackground(true, "auto"), { useBackground: true, auto: false });
    assert.deepEqual(decideBackground(true, "codex"), { useBackground: true, auto: false });
});

await check("background === false → 强制同步（即便 codex 也同步）", () => {
    assert.deepEqual(decideBackground(false, "codex"), { useBackground: false, auto: false });
    assert.deepEqual(decideBackground(false, "auto"), { useBackground: false, auto: false });
});

await check("background === undefined + codex → 自动后台（auto=true）", () => {
    assert.deepEqual(decideBackground(undefined, "codex"), { useBackground: true, auto: true });
});

await check("background === undefined + 非 codex → 同步（行为不变）", () => {
    assert.deepEqual(decideBackground(undefined, "auto"), { useBackground: false, auto: false });
    assert.deepEqual(decideBackground(undefined, "antigravity"), { useBackground: false, auto: false });
    assert.deepEqual(decideBackground(undefined, "claude-code"), { useBackground: false, auto: false });
});

await check("autoMode=always → 未传 background 时自动后台（任意链路）", () => {
    assert.deepEqual(decideBackground(undefined, "auto", "always"), { useBackground: true, auto: true });
    assert.deepEqual(decideBackground(undefined, "antigravity", "always"), { useBackground: true, auto: true });
    assert.deepEqual(decideBackground(undefined, "claude-code", "always"), { useBackground: true, auto: true });
});

await check("autoMode=never → 未传 background 时保持同步（即便 codex）", () => {
    assert.deepEqual(decideBackground(undefined, "codex", "never"), { useBackground: false, auto: false });
    assert.deepEqual(decideBackground(undefined, "auto", "never"), { useBackground: false, auto: false });
});

await check("false 与 undefined 在 codex 下结果必须不同（三态陷阱回归）", () => {
    const f = decideBackground(false, "codex");
    const u = decideBackground(undefined, "codex");
    assert.notDeepEqual(f, u, "=== false 与 === undefined 在 codex 下必须不同");
    assert.equal(f.useBackground, false);
    assert.equal(u.useBackground, true);
});

// ── stage_guard check 三态：端到端走 runStageGuard；没有活跃 Guard 时不会创建空后台任务 ──
await check("stage_guard check + codex + 未传 background → 同步（无 taskId）", async () => {
    const res = await runStageGuard({ action: "check", modelChain: "codex" } as any);
    const out = res.content.map(c => c.text).join("\n");
    assert.ok(!out.includes("taskId"), "未传 background 不应返回 taskId");
    assert.ok(!out.includes("自动转后台") && !out.includes("转入后台"), "未传 background 不应提示转后台");
});

await check("stage_guard check + background=true + 无活跃 Guard → 不创建空 task", async () => {
    const res = await runStageGuard({
        action: "check",
        conversationId: "auto-background-empty-guard-conversation",
        modelChain: "codex",
        background: true,
    } as any);
    const out = res.content.map(c => c.text).join("\n");
    assert.ok(!out.includes("taskId"), "没有活跃 Guard 时不得创建不可恢复的空 task");
    assert.ok(out.includes("没有活跃的 Stage Guard"), "应先提示调用 stage_guard(start)");
});

await check("stage_guard check + codex + background=false → 不走自动后台（无 taskId 提示）", async () => {
    // background=false 强制同步：会落到正常 check 流程（无活跃 guard → 返回提示），
    // 不应出现「已转入后台任务 + taskId」。
    const res = await runStageGuard({ action: "check", modelChain: "codex", background: false } as any);
    const out = res.content.map(c => c.text).join("\n");
    assert.ok(!out.includes("已转入后台任务"), "background=false 不应转后台");
});

await check("stage_guard check + 非 codex + 未传 background → 同步（无后台）", async () => {
    const res = await runStageGuard({ action: "check", modelChain: "auto" } as any);
    const out = res.content.map(c => c.text).join("\n");
    assert.ok(!out.includes("已转入后台任务"), "非 codex 未传 background 不应转后台（行为不变）");
});

// ── stage_guard 回调内部抛异常 → 返回结构化错误文本，不抛到协议层 ──
await check("stage_guard handler 内部抛异常 → 结构化错误文本，不冒泡", async () => {
    // modelChain="windsurf" 会让 handleCheck 内 resolveModelChain 同步抛
    // （assertValidModelChainInput）。绕过 zod 直接调 runStageGuard 验证兜底 catch。
    let threw = false;
    let res: Awaited<ReturnType<typeof runStageGuard>> | undefined;
    try {
        res = await runStageGuard({ action: "check", modelChain: "windsurf" } as any);
    } catch {
        threw = true;
    }
    assert.equal(threw, false, "异常绝不能冒泡到调用方（协议层）");
    const out = res!.content.map(c => c.text).join("\n");
    assert.ok(out.includes("stage_guard"), "应是结构化错误文本（含工具名）");
    assert.ok(out.includes("分类"), "应是结构化错误文本（含分类行）");
    assert.ok(out.includes("失败"), "应标记为失败");
});

await check("stage_guard 并发后台 check 复用稳定 taskId，实质参数变化另建任务", async () => {
    const state: GuardState = {
        active: true,
        guardId: "auto-background-idempotency-guard",
        conversationId: "auto-background-idempotency-conversation",
        chain: "codex",
        modelChain: "codex",
        stageId: "Stage idempotency",
        childScopeId: "main",
        scopeSelectors: [],
        taskFiles: [],
        planFiles: [],
        startRound: 1,
        startedAt: new Date().toISOString(),
        checkHistory: [],
    };
    let releaseCheck = () => {};
    const checkGate = new Promise<void>(resolve => {
        releaseCheck = resolve;
    });
    __testSetStageGuardCheckRunner(async () => {
        await checkGate;
        return {
            passed: false,
            summary: "idempotency fixture",
            missingItems: [],
        } as any;
    });
    writeGuardState(state);
    const checkParams = {
        action: "check" as const,
        background: true,
        conversationId: state.conversationId,
        stageId: state.stageId,
        childScopeId: state.childScopeId,
        modelChain: "codex" as const,
    };
    const taskIdFrom = (response: Awaited<ReturnType<typeof runStageGuard>>): string => {
        const match = response.content.map(item => item.text).join("\n").match(/taskId:\s*([A-Za-z0-9._-]+)/u);
        if (!match) throw new Error("后台 check 未返回 taskId");
        return match[1];
    };
    try {
        const concurrent = await Promise.all(Array.from({ length: 12 }, () => runStageGuard(checkParams)));
        const taskIds = concurrent.map(taskIdFrom);
        assert.equal(new Set(taskIds).size, 1, "相同 Guard 与规范化输入的并发 check 必须复用同一 taskId");
        const taskId = taskIds[0];
        assert.equal(getBackgroundTask(taskId)?.status, "running");

        const changedTaskId = taskIdFrom(await runStageGuard({ ...checkParams, appealNote: "补充一条不同申诉" }));
        assert.notEqual(changedTaskId, taskId, "实质参数变化必须生成新的 taskId");

        releaseCheck();
        await Promise.all([waitForBackgroundTask(taskId, 2), waitForBackgroundTask(changedTaskId, 2)]);
        assert.equal(getBackgroundTask(taskId)?.status, "done");
        assert.equal(taskIdFrom(await runStageGuard(checkParams)), taskId, "已完成的同一逻辑 check 必须继续返回稳定 taskId");

        const status = await runStageGuard({ action: "check", taskId });
        assert.match(status.content.map(item => item.text).join("\n"), /idempotency fixture/u, "status 查询必须读取同一已完成任务的结果");
        await runStageGuard({ action: "cancel", taskId });
        assert.equal(getBackgroundTask(taskId)?.status, "done", "status/cancel 必须继续指向同一终态 taskId");
    } finally {
        releaseCheck();
        clearGuardState(state);
        __testSetStageGuardCheckRunner();
    }
});

if (failed) {
    console.error("❌ auto-background 测试存在失败项");
    process.exit(1);
}
console.log("✅ auto-background 全部通过");
