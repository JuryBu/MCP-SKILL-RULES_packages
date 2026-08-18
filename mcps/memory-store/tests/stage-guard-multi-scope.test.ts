import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-guard-multi-scope-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
process.env.MEMORY_STORE_AUTO_RECORD = "0";

const {
    addCheckResult,
    clearGuardState,
    createGuardId,
    getGuardLocks,
    insertLockMark,
    isCurrentGuard,
    listGuardStates,
    readGuardState,
    removeLockMark,
    writeGuardState,
} = await import("../src/guard-store.ts");
const { buildGuardInputBundle } = await import("../src/guard-engine.ts");
const { runStageGuard } = await import("../src/tools/stage-guard.ts");

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-guard-multi-scope-fixture-"));
const taskFile = path.join(fixtureDir, "Task.md");
const planFile = path.join(fixtureDir, "Plan.md");
fs.writeFileSync(taskFile, [
    "# Task fixture",
    "",
    "## Stage 1",
    "- [ ] scope-a-anchor: 完成 A",
    "  - A 的验证证据",
    "- [ ] scope-b-anchor: 完成 B",
    "  - B 的验证证据",
].join("\n"), "utf-8");
fs.writeFileSync(planFile, [
    "# Plan fixture",
    "",
    "## Stage 1",
    "- scope-a-anchor: A 要求",
    "- scope-b-anchor: B 要求",
].join("\n"), "utf-8");

function makeState(childScopeId: string, scopeSelectors: string[]) {
    return {
        active: true as const,
        guardId: createGuardId(),
        conversationId: "conversation-multi-scope",
        chain: "codex" as const,
        modelChain: "codex" as const,
        stageId: "Stage 1",
        childScopeId,
        scopeSelectors,
        taskFiles: [taskFile],
        planFiles: [planFile],
        startRound: 1,
        startedAt: new Date().toISOString(),
        checkHistory: [],
    };
}

const scopeA = makeState("child-a", ["scope-a-anchor"]);
const scopeB = makeState("child-b", ["scope-b-anchor"]);
writeGuardState(scopeA);
writeGuardState(scopeB);
assert.equal(listGuardStates(scopeA.conversationId).length, 2, "同一对话的两个 child scope 应同时存在");
assert.equal(insertLockMark(taskFile, scopeA).inserted, true);
assert.equal(insertLockMark(taskFile, scopeB).inserted, true);
assert.deepEqual(getGuardLocks(taskFile).map(lock => lock.guardId).sort(), [scopeA.guardId, scopeB.guardId].sort());

const lockedScopedBundle = buildGuardInputBundle([planFile], [taskFile], "Stage 1", ["scope-a-anchor"]);
assert.match(lockedScopedBundle.taskContent, /scope-a-anchor/u, "scope selector 必须忽略文件头 Guard 锁 JSON 中的同名文本");
assert.doesNotMatch(lockedScopedBundle.taskContent, /scope-b-anchor/u, "带锁状态下仍不得把同 Stage 的 B 项带入审核文本");

const listAll = await runStageGuard({ action: "status", listAll: true, chain: "auto" } as any);
assert.match(JSON.stringify(listAll), /未读取对话/u, "listAll 必须直接扫描 Guard 状态而非读取对话");
assert.match(JSON.stringify(listAll), new RegExp(scopeA.guardId));
assert.match(JSON.stringify(listAll), new RegExp(scopeB.guardId));

assert.equal(removeLockMark(taskFile, scopeA).removed, true);
assert.equal(clearGuardState(scopeA), true);
assert.equal(readGuardState(scopeB.conversationId, scopeB.stageId, scopeB.childScopeId)?.guardId, scopeB.guardId, "取消 A 不得影响 B 状态");
assert.deepEqual(getGuardLocks(taskFile).map(lock => lock.guardId), [scopeB.guardId], "取消 A 不得移除 B 锁");

const scopedBundle = buildGuardInputBundle([planFile], [taskFile], "Stage 1", ["scope-a-anchor"]);
const scopedContent = `${scopedBundle.planContent}\n${scopedBundle.taskContent}`;
assert.match(scopedContent, /scope-a-anchor/u);
assert.doesNotMatch(scopedContent, /scope-b-anchor/u, "scope selector 不得把同 Stage 的 B 项带入审核文本");

const stale = makeState("main", []);
writeGuardState(stale);
insertLockMark(taskFile, stale);
const replacement = { ...stale, guardId: createGuardId() };
writeGuardState(replacement);
assert.equal(isCurrentGuard(stale), false, "force 替换后旧实例必须过期");
assert.equal(addCheckResult(stale, "pass", "旧结果"), null, "过期实例不得追加检查历史");
assert.equal(clearGuardState(stale), false, "过期实例不得清掉替换后的 Guard");
assert.equal(readGuardState(replacement.conversationId, replacement.stageId, replacement.childScopeId)?.guardId, replacement.guardId);

const legacyConversationId = "conversation-legacy";
const legacyPath = path.join(dataRoot, "guards", `${legacyConversationId}.json`);
fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
fs.writeFileSync(legacyPath, JSON.stringify({
    active: true,
    conversationId: legacyConversationId,
    chain: "codex",
    modelChain: "codex",
    stageId: "Stage legacy",
    taskFiles: [taskFile],
    planFiles: [],
    startRound: 1,
    startedAt: "2026-07-11T00:00:00.000Z",
    checkHistory: [],
}), "utf-8");
const migratedLegacy = readGuardState(legacyConversationId, "Stage legacy", "main");
assert.ok(migratedLegacy?.guardId.startsWith("legacy:"), "v1 state 应映射为稳定 main scope 身份");
assert.equal(fs.existsSync(legacyPath), false, "新路径原子写入成功后才删除 legacy 文件");
assert.equal(listGuardStates(legacyConversationId).length, 1, "新旧路径过渡期不得重复列出同一 Guard");

const blankTaskFile = path.join(fixtureDir, "Task-blank.md");
fs.writeFileSync(blankTaskFile, "# 正文\n\n保留正文空行\n", "utf-8");
const blankState = { ...makeState("blank", ["blank-anchor"]), taskFiles: [blankTaskFile] };
writeGuardState(blankState);
insertLockMark(blankTaskFile, blankState);
assert.equal(removeLockMark(blankTaskFile, blankState).removed, true);
assert.match(fs.readFileSync(blankTaskFile, "utf-8"), /^# 正文/u, "移除锁后不得残留文件头空白");
assert.match(fs.readFileSync(blankTaskFile, "utf-8"), /\n\n保留正文空行/u, "移除锁不得压缩正文原有空行");

console.log("✅ stage-guard-multi-scope 通过：多 scope、精确锁、陈旧写回、legacy 迁移、listAll 与空白清理均已覆盖");
