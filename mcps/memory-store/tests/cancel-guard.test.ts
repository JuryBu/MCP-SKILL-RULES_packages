import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GuardState } from "../src/guard-store.ts";
import type { ConversationRound } from "../src/trajectory.ts";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-cancel-guard-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;

const { runGuardCheck } = await import("../src/guard-engine.ts");
const { clearGuardState, createGuardId, getGuardLocks, insertLockMark, readGuardState, removeLockMark, writeGuardState } = await import("../src/guard-store.ts");
const { exportConversation } = await import("../src/conversation-exporter.ts");
const { TEMP_DIR } = await import("../src/temp-store.ts");
const { __testSetStageGuardConversationLoader, runStageGuard } = await import("../src/tools/stage-guard.ts");
const { BACKGROUND_TASK_RESUME_VERSION, __testWritePersistedTask, getBackgroundTask, stableJsonHash } = await import("../src/background-tasks.ts");

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-cancel-guard-fixture-"));
const taskFile = path.join(fixtureDir, "Task_32_stage1_fixture.md");
fs.writeFileSync(taskFile, [
    "# Task fixture",
    "",
    "## Stage 1：Cancel 能力补全",
    "",
    "- [ ] 在模型调用前检查取消状态",
    "- [ ] 取消后不写 Guard 报告",
].join("\n"), "utf-8");

const guardState: GuardState = {
    active: true,
    guardId: "cancelled-before-model",
    conversationId: "",
    chain: "auto",
    modelChain: "auto",
    stageId: "",
    childScopeId: "main",
    scopeSelectors: [],
    taskFiles: [taskFile],
    planFiles: [],
    startRound: 1,
    startedAt: new Date().toISOString(),
    checkHistory: [],
};

const cancelledGuard = await runGuardCheck(guardState, undefined, undefined, {
    isCancelled: () => true,
    isSettled: () => true,
});

assert.equal(cancelledGuard.cancelled, true);
assert.equal(cancelledGuard.reportPath, undefined);
const tempEntries = fs.existsSync(TEMP_DIR) ? fs.readdirSync(TEMP_DIR) : [];
assert.equal(tempEntries.some(name => name.includes("stage_guard_report_")), false, "取消后不应写 Guard 报告");

const sharedTaskFile = path.join(fixtureDir, "Task_multi_scope_fixture.md");
fs.writeFileSync(sharedTaskFile, "# shared task\n", "utf-8");
const guardA: GuardState = {
    active: true,
    guardId: createGuardId(),
    conversationId: "cancel-multi-scope",
    chain: "codex",
    modelChain: "codex",
    stageId: "Stage 1",
    childScopeId: "child-a",
    scopeSelectors: ["task-a"],
    taskFiles: [sharedTaskFile],
    planFiles: [],
    startRound: 1,
    startedAt: new Date().toISOString(),
    checkHistory: [],
};
const guardB: GuardState = { ...guardA, guardId: createGuardId(), childScopeId: "child-b", scopeSelectors: ["task-b"] };
writeGuardState(guardA);
writeGuardState(guardB);
insertLockMark(sharedTaskFile, guardA);
insertLockMark(sharedTaskFile, guardB);
assert.equal(removeLockMark(sharedTaskFile, guardA).removed, true);
assert.equal(clearGuardState(guardA), true);
assert.equal(readGuardState(guardB.conversationId, guardB.stageId, guardB.childScopeId)?.guardId, guardB.guardId, "取消 A 不得清除 B 的状态");
assert.deepEqual(getGuardLocks(sharedTaskFile).map(lock => lock.guardId), [guardB.guardId], "取消 A 不得移除 B 的文件锁");

function makeRound(index: number, userMessage: string, aiResponse: string): ConversationRound {
    return {
        roundIndex: index,
        startStep: index * 10,
        endStep: index * 10 + 1,
        userMessage,
        mediaAttachments: [],
        aiResponses: [{
            stepIndex: index * 10 + 1,
            response: aiResponse,
            thinking: "",
            toolCalls: [],
        }],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    };
}

const exportDir = path.join(os.tmpdir(), "memory-store-cancel-export-dir", String(Date.now()));
let exportThrew = false;
try {
    await exportConversation({
        conversationId: "cancel-export-conversation",
        chainUsed: "codex",
        rounds: [makeRound(1, "第一轮", "模型回复")],
        totalSteps: 2,
        format: "markdown",
        scope: "full",
        outputDir: exportDir,
        overwrite: true,
        depth: "normal",
        extraTypes: [],
        compactionMode: "folded",
        isCancelled: () => true,
        isSettled: () => true,
    });
} catch (error) {
    exportThrew = true;
    assert.match(String(error), /conversation export cancelled|conversation export settled/u);
}

assert.equal(exportThrew, true, "导出被取消时应中断当前文件导出");
assert.equal(fs.existsSync(path.join(exportDir, "conversation.md")), false, "取消后不应写 markdown");
assert.equal(fs.existsSync(path.join(exportDir, "manifest.json")), false, "取消后不应写 manifest");

const metadataOnlyTaskFile = path.join(fixtureDir, "Task_metadata_only_fixture.md");
fs.writeFileSync(metadataOnlyTaskFile, "# metadata only\n", "utf-8");
const cachedMetadataTaskFile = path.join(fixtureDir, "Task_cached_metadata_fixture.md");
fs.writeFileSync(cachedMetadataTaskFile, "# cached metadata only\n", "utf-8");
let cachedMetadataLoaderCalls = 0;
let cachedMetadataLoaderInput: { chain: string; conversationId: string | undefined; options: Record<string, unknown> } | undefined;
__testSetStageGuardConversationLoader(async (chain, conversationId, options) => {
    cachedMetadataLoaderCalls++;
    cachedMetadataLoaderInput = { chain, conversationId, options };
    return {
        chainUsed: "windsurf",
        conversationId: "canonical-cached-metadata",
        rounds: [],
        roundCount: 12,
        totalSteps: 24,
    };
});
try {
    const start = await runStageGuard({
        action: "start",
        taskFiles: [cachedMetadataTaskFile],
        conversationId: "provided-cached-metadata",
        stageId: "Stage cached metadata-only",
        chain: "windsurf",
    });
    assert.match(start.content[0].text, /Stage Guard 已激活/u);
    assert.equal(cachedMetadataLoaderCalls, 1, "未显式 startRound 时必须只读取一次缓存元数据");
    assert.equal(cachedMetadataLoaderInput?.conversationId, "provided-cached-metadata");
    assert.deepEqual(
        cachedMetadataLoaderInput?.options,
        { link: "summary", source: "cache", includeRounds: false },
        "有 conversationId 但无 startRound 时不得改为正文读取",
    );
    const cachedMetadataState = readGuardState("canonical-cached-metadata", "Stage cached metadata-only");
    assert.equal(cachedMetadataState?.startRound, 12, "默认起始轮次必须使用缓存元数据 roundCount");
    assert.equal(clearGuardState(cachedMetadataState!), true);
    assert.equal(removeLockMark(cachedMetadataTaskFile, cachedMetadataState!).removed, true);
} finally {
    __testSetStageGuardConversationLoader();
}
let conversationLoaderCalls = 0;
__testSetStageGuardConversationLoader(async () => {
    conversationLoaderCalls++;
    throw new Error("显式 conversationId + startRound 不应读取对话正文");
});
try {
    const start = await runStageGuard({
        action: "start",
        taskFiles: [metadataOnlyTaskFile],
        conversationId: "explicit-metadata-only",
        stageId: "Stage metadata-only",
        startRound: 7,
        chain: "codex",
    });
    assert.match(start.content[0].text, /Stage Guard 已激活/u);
    assert.equal(conversationLoaderCalls, 0, "显式起始边界只能登记元数据，不得加载正文");
    const metadataState = readGuardState("explicit-metadata-only", "Stage metadata-only");
    assert.equal(metadataState?.startRound, 7);
    assert.equal(clearGuardState(metadataState!), true);
    assert.equal(removeLockMark(metadataOnlyTaskFile, metadataState!).removed, true);
} finally {
    __testSetStageGuardConversationLoader();
}

const backgroundCancelTaskFile = path.join(fixtureDir, "Task_background_cancel_fixture.md");
fs.writeFileSync(backgroundCancelTaskFile, "# background cancel\n", "utf-8");
const backgroundCancelState: GuardState = {
    active: true,
    guardId: "background-cancel-guard",
    conversationId: "background-cancel-conversation",
    chain: "codex",
    modelChain: "codex",
    stageId: "Stage background cancel",
    childScopeId: "main",
    scopeSelectors: [],
    taskFiles: [backgroundCancelTaskFile],
    planFiles: [],
    startRound: 9,
    startedAt: new Date(Date.now() - 30_000).toISOString(),
    checkHistory: [],
};
writeGuardState(backgroundCancelState);
insertLockMark(backgroundCancelTaskFile, backgroundCancelState);
const backgroundCancelTaskId = "stage-guard-cancel-same-id";
const backgroundCancelPayload = {
    version: 2,
    conversationId: backgroundCancelState.conversationId,
    stageId: backgroundCancelState.stageId,
    guardStartedAt: backgroundCancelState.startedAt,
    guardId: backgroundCancelState.guardId,
    childScopeId: backgroundCancelState.childScopeId,
    scopeSelectors: backgroundCancelState.scopeSelectors,
    chain: "codex",
    modelChain: "codex",
};
const backgroundCancelTimestamp = new Date().toISOString();
__testWritePersistedTask({
    id: backgroundCancelTaskId,
    kind: "stage-guard-check",
    status: "running",
    startedAt: backgroundCancelTimestamp,
    updatedAt: backgroundCancelTimestamp,
    maxRunMs: 60_000,
    resumePayload: backgroundCancelPayload,
    resumeVersion: BACKGROUND_TASK_RESUME_VERSION,
    resumeHash: stableJsonHash(backgroundCancelPayload),
});
const cancelledByGuard = await runStageGuard({ action: "cancel", taskId: backgroundCancelTaskId, chain: "codex" });
assert.match(cancelledByGuard.content[0].text, new RegExp(backgroundCancelTaskId));
assert.equal(getBackgroundTask(backgroundCancelTaskId)?.status, "cancelled", "stage_guard cancel 必须取消传入的同一 taskId");
assert.equal(readGuardState(backgroundCancelState.conversationId, backgroundCancelState.stageId), null, "同 ID 取消后必须清理对应 Guard 状态");
const cancelledAt = getBackgroundTask(backgroundCancelTaskId)?.finishedAt;
const repeatedCancel = await runStageGuard({ action: "cancel", taskId: backgroundCancelTaskId, chain: "codex" });
assert.match(repeatedCancel.content[0].text, /未激活/u);
assert.equal(getBackgroundTask(backgroundCancelTaskId)?.finishedAt, cancelledAt, "重复 cancel 不得二次结算同一 taskId");

console.log("✅ cancel-guard 通过：取消后不写报告，精确取消不影响同文件其它 Guard，缓存元数据与显式起始边界均不读正文，同 ID 后台取消不二次结算，conversation export 取消后不写导出产物");
