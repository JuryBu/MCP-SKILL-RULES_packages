import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-target-binding-"));
const previousDirectory = process.cwd();
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
const { runStageGuard, __testSetStageGuardCheckRunner, __testSetStageGuardConversationLoader } = await import("../src/tools/stage-guard.ts");
const { readGuardState, writeGuardState, createGuardId, getGuardLocks, insertLockMark } = await import("../src/guard-store.ts");
const taskPath = path.join(root, "Task 中文.md");
const planPath = path.join(root, "Plan 中文.md");
fs.writeFileSync(taskPath, "# Task\n\n## Stage 1\n- [x] A 已提供原件\n\n## Stage 2\n- [ ] B 后续实施\n", "utf8");
fs.writeFileSync(planPath, "# Plan\n\n## 适用全局要求\n保护原始材料\n\n| 阶段 | 要求 |\n|---|---|\n| Stage 1 | A 核验 |\n| Stage 2 | B 后续 |\n", "utf8");
let runnerCalls = 0;
let loaderCalls = 0;
__testSetStageGuardConversationLoader(async () => { loaderCalls += 1; return null; });
__testSetStageGuardCheckRunner(async () => {
    runnerCalls += 1;
    return { passed: false, summary: "fixture evidence incomplete", missingItems: ["fixture original missing"], rawResponse: "EVIDENCE_INSUFFICIENT\nfixture original missing", evidenceInsufficient: true } as any;
});
const invoke = async (params: Record<string, unknown>) => JSON.stringify(await runStageGuard({ chain: "codex", dataChain: "codex", modelChain: "codex", ...params } as any));
const start = (conversationId: string, overrides: Record<string, unknown> = {}) => invoke({ action: "start", conversationId, startRound: 1, stageId: "Stage 1", taskFiles: [taskPath], planFiles: [planPath], ...overrides });

try {
    process.chdir(root);
    assert.match(await start("relative", { taskFiles: [path.basename(taskPath)] }), /完整绝对路径/u);
    assert.match(await start("directory", { planFiles: [root] }), /普通文件/u);
    assert.match(await start("missing", { planFiles: [path.join(root, "missing.md")] }), /不存在或不可读/u);
    assert.match(await start("no-stage", { stageId: "" }), /stageId/u);
    assert.match(await start("wrong-stage", { stageId: "Stage 6" }), /目标|阶段|范围|scope/u);
    for (const conversationId of ["relative", "directory", "missing", "no-stage", "wrong-stage"]) {
        assert.equal(readGuardState(conversationId, "Stage 1", "main"), null);
        assert.equal(readGuardState(conversationId, "Stage 6", "main"), null);
    }
    assert.equal(loaderCalls, 0, "invalid targets stop before any conversation capture");
    assert.equal(runnerCalls, 0);
    assert.deepEqual(getGuardLocks(taskPath), []);

    const declaredTask = path.join(root, "declared-task.md");
    fs.writeFileSync(declaredTask, `# Task\n计划：${planPath}\n\n## Stage 1\n- [x] 明确计划\n`, "utf8");
    assert.match(await start("declared-missing", { taskFiles: [declaredTask], planFiles: [] }), /planFiles/u);
    const wrongPlan = path.join(root, "wrong-plan.md");
    fs.copyFileSync(planPath, wrongPlan);
    assert.match(await start("declared-wrong", { taskFiles: [declaredTask], planFiles: [wrongPlan] }), /planFiles/u);
    assert.match(await start("declared-correct", { taskFiles: [declaredTask] }), /已激活/u);
    await invoke({ action: "cancel", conversationId: "declared-correct", stageId: "Stage 1" });

    const started = await start("bound");
    assert.ok(started.includes(taskPath.replaceAll("\\", "\\\\")) || started.includes(taskPath));
    assert.ok(started.includes(planPath.replaceAll("\\", "\\\\")) || started.includes(planPath));
    const state = readGuardState("bound", "Stage 1", "main")!;
    assert.ok(state?.guardId);
    const lockedText = fs.readFileSync(taskPath, "utf8");
    const invalidForced = await start("bound", { force: true, planFiles: [root] });
    assert.match(invalidForced, /普通文件/u);
    assert.equal(readGuardState("bound", "Stage 1", "main")?.guardId, state.guardId);
    assert.equal(fs.readFileSync(taskPath, "utf8"), lockedText, "invalid force never removes an old lock");

    const conflictingPlan = path.join(root, "other-plan.md");
    fs.copyFileSync(planPath, conflictingPlan);
    assert.match(await invoke({ action: "check", conversationId: "bound", stageId: "Stage 1", planFiles: [conflictingPlan] }), /原注册冲突/u);
    assert.match(await invoke({ action: "check", conversationId: "bound", stageId: "Stage 1", scopeSelectors: ["other"] }), /原注册冲突/u);
    assert.equal(runnerCalls, 0, "conflicting check targets never dispatch");
    assert.equal(readGuardState("bound", "Stage 1", "main")?.guardId, state.guardId);

    fs.renameSync(planPath, `${planPath}.saved`);
    assert.match(await invoke({ action: "check", conversationId: "bound", stageId: "Stage 1" }), /目标不可用/u);
    assert.equal(runnerCalls, 0, "removed registered files never dispatch");
    fs.renameSync(`${planPath}.saved`, planPath);
    await invoke({ action: "cancel", conversationId: "bound", stageId: "Stage 1" });

    const simplePath = path.join(root, "simple-task.md");
    fs.writeFileSync(simplePath, "# 单文件任务\n- [x] 一份明确原件\n", "utf8");
    assert.match(await start("simple", { taskFiles: [simplePath], planFiles: [], stageId: "" }), /已激活/u);
    await invoke({ action: "cancel", conversationId: "simple", stageId: "" });

    const legacy = {
        active: true, guardId: createGuardId(), conversationId: "legacy-relative", chain: "codex" as const,
        modelChain: "codex" as const, stageId: "", childScopeId: "main", scopeSelectors: [],
        taskFiles: [path.basename(simplePath)], planFiles: [], startRound: 1,
        startedAt: "2026-01-01T00:00:00.000Z", checkHistory: [],
    };
    writeGuardState(legacy);
    insertLockMark(simplePath, legacy);
    await invoke({ action: "check", conversationId: legacy.conversationId, stageId: "" });
    assert.equal(runnerCalls, 1, "readable legacy relative registration remains usable");
    const preserved = readGuardState(legacy.conversationId, "", "main")!;
    assert.equal(preserved.guardId, legacy.guardId);
    assert.equal(preserved.startedAt, legacy.startedAt);
    assert.deepEqual(preserved.taskFiles, legacy.taskFiles, "legacy target storage is not silently rewritten");
    await invoke({ action: "cancel", conversationId: legacy.conversationId, stageId: "" });
    console.log("stage guard target binding: PASS absolute/readable/stage/force/conflicts/recheck/single-task/legacy identity");
} finally {
    __testSetStageGuardCheckRunner();
    __testSetStageGuardConversationLoader();
    process.chdir(previousDirectory);
    fs.rmSync(root, { recursive: true });
}
