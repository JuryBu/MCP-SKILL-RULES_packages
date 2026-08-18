import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationRound } from "../src/trajectory.ts";

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "mstore-recover-nonrecord-"));
process.env.MEMORY_STORE_DATA_ROOT = TMP_ROOT;
process.env.MEMORY_STORE_BACKGROUND_TASK_CONCURRENCY = "1";

const {
    __testResetBackgroundTasksForTest,
    __testWritePersistedTask,
    getBackgroundTask,
    getBackgroundTaskRecoveryHandler,
    recoverBackgroundTask,
    stableJsonHash,
    waitForBackgroundTask,
} = await import("../src/background-tasks.ts");
const { writeGuardState, readGuardState, clearGuardState, insertLockMark, getGuardLocks } = await import("../src/guard-store.ts");
const {
    createConversationBatchExportResumePayload,
    resumeConversationBatchExport,
} = await import("../src/conversation-batch-export.ts");

await import("../src/tools/golden-extract.ts");
await import("../src/tools/conversation.ts");
await import("../src/tools/stage-guard.ts");

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

function isoMsAgo(ms: number): string {
    return new Date(Date.now() - ms).toISOString();
}

function runningTask(taskId: string, kind: string, payload: Record<string, unknown>, startedAt: string) {
    return {
        id: taskId,
        kind,
        status: "running" as const,
        startedAt,
        updatedAt: startedAt,
        maxRunMs: 60_000,
        ownerPid: 2_147_483_647,
        resumePayload: payload,
        resumeVersion: 1,
        resumeHash: stableJsonHash(payload),
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
    await step("golden-extract 注册最小 payload restart handler", async () => {
        const handler = getBackgroundTaskRecoveryHandler("golden-extract");
        assert.ok(handler, "golden-extract 应注册恢复 handler");

        const action = await handler!({
            id: "golden-task",
            kind: "golden-extract",
            status: "running",
            startedAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z",
            resumePayload: {
                version: 1,
                conversationId: "conv-golden",
                stepStart: 1,
                stepEnd: 3,
                autoCompare: true,
                dataChain: "codex",
                modelChain: "codex",
            },
        } as any);

        assert.equal(action?.mode, "restart");
    });

    await step("conversation-batch-export 恢复同目录并清理 pending/tmp/不完整 child", async () => {
        const parentDir = path.join(TMP_ROOT, "exports");
        const payload = createConversationBatchExportResumePayload({
            candidates: [{
                id: "12345678-aaa",
                dataChain: "codex",
                title: "Batch A",
                workspace: "C:\\repo-a",
                updatedAt: "2026-07-10T00:00:00.000Z",
                detail: "fixture",
            }, {
                id: "12345678-bbb",
                dataChain: "codex",
                title: "Batch B",
                workspace: "C:\\repo-b",
                updatedAt: "2026-07-10T00:00:00.000Z",
                detail: "fixture",
            }],
            batchLimit: 2,
            batchConcurrency: 2,
            sourceStatuses: [
                { dataChain: "codex", status: "ok", count: 1 },
                { dataChain: "claude-code", status: "ok", count: 1 },
            ],
            scope: "full",
            depth: "normal",
            outputDir: parentDir,
            format: "markdown",
            includeAssets: false,
        });

        const batchHandler = getBackgroundTaskRecoveryHandler("conversation-batch-export");
        const batchAction = await batchHandler!({
            id: "batch-task",
            kind: "conversation-batch-export",
            status: "running",
            startedAt: "2026-07-10T00:00:00.000Z",
            updatedAt: "2026-07-10T00:00:00.000Z",
            resumePayload: payload,
        } as any);
        assert.equal(batchAction?.mode, "restart");

        const pendingManifest = path.join(payload.batchDir, "batch_manifest.pending.json");
        const staleManifest = path.join(payload.batchDir, "batch_manifest.json");
        const incompleteChildDir = path.join(payload.batchDir, "codex_12345678-aaa");
        fs.mkdirSync(incompleteChildDir, { recursive: true });
        fs.writeFileSync(pendingManifest, JSON.stringify({ status: "running" }), "utf-8");
        fs.writeFileSync(staleManifest, JSON.stringify({ status: "stale" }), "utf-8");
        fs.writeFileSync(path.join(incompleteChildDir, "stale.tmp"), "tmp", "utf-8");
        fs.writeFileSync(path.join(payload.batchDir, "root.tmp"), "tmp", "utf-8");

        const loadedIds: string[] = [];
        const result = await resumeConversationBatchExport(payload, {
            loadConversationData: async (dataChain: any, conversationId: string) => {
                loadedIds.push(`${dataChain}:${conversationId}`);
                return {
                    conversationId,
                    chainUsed: dataChain,
                    rounds: [makeRound(1, `用户 ${conversationId}`, `模型 ${conversationId}`)],
                    totalSteps: 11,
                } as any;
            },
            exportConversation: async (options) => {
                const exportDir = options.outputDir || path.join(payload.batchDir, options.conversationId);
                fs.mkdirSync(exportDir, { recursive: true });
                const markdownPath = path.join(exportDir, "conversation.md");
                const manifestPath = path.join(exportDir, "manifest.json");
                fs.writeFileSync(markdownPath, `# ${options.conversationId}\n`, "utf-8");
                fs.writeFileSync(manifestPath, JSON.stringify({
                    conversationId: options.conversationId,
                    files: {
                        markdown: markdownPath,
                        pdf: null,
                        html: null,
                    },
                }, null, 2), "utf-8");
                return {
                    success: true,
                    conversationId: options.conversationId,
                    chainUsed: options.chainUsed,
                    exportDir,
                    markdownPath,
                    manifestPath,
                    warnings: [],
                    stats: {
                        roundsExported: options.rounds.length,
                        totalRounds: options.rounds.length,
                        totalSteps: options.totalSteps,
                        markdownChars: 8,
                        assetsCopied: 0,
                        assetsSkipped: 0,
                        embeddedPdfAttachments: 0,
                    },
                };
            },
        });

        assert.equal(result.exportDir, payload.batchDir);
        assert.deepEqual(loadedIds.sort(), ["codex:12345678-aaa", "codex:12345678-bbb"]);
        assert.equal(fs.existsSync(pendingManifest), false, "pending manifest 应被清理");
        assert.equal(fs.existsSync(staleManifest), true, "最终 manifest 应被重写");
        assert.equal(fs.existsSync(path.join(payload.batchDir, "root.tmp")), false, "根目录 tmp 应被清理");
        assert.equal(fs.existsSync(path.join(incompleteChildDir, "stale.tmp")), false, "不完整 child 的 tmp 应被清理");
        assert.ok(result.items.every(item => item.exportDir?.startsWith(payload.batchDir)));
        assert.equal(new Set(result.items.map(item => item.exportDir)).size, 2, "相同前 8 位的 conversationId 不得共享子目录");
    });

    await step("stage-guard-check 发现同次历史结果时复用，不重复模型与历史", async () => {
        __testResetBackgroundTasksForTest();
        const taskFile = path.join(TMP_ROOT, "Task.md");
        fs.writeFileSync(taskFile, "## Stage 2\n- [ ] something\n", "utf-8");

        const guardStartedAt = isoMsAgo(10 * 60_000);
        const taskStartedAt = isoMsAgo(5 * 60_000);
        const checkedAt = isoMsAgo(4 * 60_000);
        writeGuardState({
            active: true,
            conversationId: "conv-guard",
            chain: "codex",
            modelChain: "codex",
            stageId: "Stage 2",
            taskFiles: [taskFile],
            planFiles: [],
            startRound: 1,
            startedAt: guardStartedAt,
            checkHistory: [{
                checkNumber: 1,
                result: "fail",
                missingItems: ["补测试输出"],
                summary: "缺少测试输出",
                checkedAt,
                taskId: "guard-task",
            }],
        });

        const payload = {
            version: 1,
            conversationId: "conv-guard",
            stageId: "Stage 2",
            guardStartedAt,
            chain: "auto",
            modelChain: "codex",
            evidenceIndexMode: "auto",
        };
        __testWritePersistedTask(runningTask("guard-task", "stage-guard-check", payload, taskStartedAt));

        const recovery = await recoverBackgroundTask("guard-task");
        assert.equal(recovery.outcome, "resumed");
        assert.ok(recovery.recoveredTaskId);

        const done = await waitForBackgroundTask(recovery.recoveredTaskId!, 2);
        assert.equal(done?.status, "done");
        assert.match(done?.result || "", /未重复调用模型/u);
        assert.match(done?.result || "", /缺少测试输出/u);

        const state = readGuardState("conv-guard");
        assert.equal(state?.checkHistory.length, 1, "恢复后不应重复追加 Guard 历史");
    });

    await step("stage-guard-check Guard 状态缺失时直接 error，不盲目重跑", async () => {
        __testResetBackgroundTasksForTest();
        const payload = {
            version: 1,
            conversationId: "missing-guard",
            stageId: "Stage X",
            guardStartedAt: isoMsAgo(10 * 60_000),
            chain: "auto",
            modelChain: "codex",
        };
        __testWritePersistedTask(runningTask("guard-missing", "stage-guard-check", payload, isoMsAgo(5 * 60_000)));

        const recovery = await recoverBackgroundTask("guard-missing");
        assert.equal(recovery.outcome, "resumed");
        assert.ok(recovery.recoveredTaskId);
        const errored = await waitForBackgroundTask(recovery.recoveredTaskId!, 2);
        assert.equal(errored?.status, "error");
        assert.match(errored?.error || "", /Guard 状态缺失/u);
    });

    await step("stage-guard-check 用 PASS receipt 幂等完成清锁，不重复模型", async () => {
        __testResetBackgroundTasksForTest();
        const taskId = "guard-pass-receipt";
        const taskFile = path.join(TMP_ROOT, "Task-pass.md");
        fs.writeFileSync(taskFile, "## Stage pass\n- [x] done\n", "utf8");
        const guardStartedAt = isoMsAgo(10 * 60_000);
        const state = {
            active: true as const,
            conversationId: "conv-guard-pass",
            chain: "codex" as const,
            modelChain: "codex" as const,
            stageId: "Stage pass",
            taskFiles: [taskFile],
            planFiles: [],
            startRound: 1,
            startedAt: guardStartedAt,
            checkHistory: [],
        };
        writeGuardState(state);
        insertLockMark(taskFile, state);
        const payload = {
            version: 1,
            conversationId: state.conversationId,
            stageId: state.stageId,
            guardStartedAt,
            chain: "auto",
            modelChain: "codex",
        };
        __testWritePersistedTask(runningTask(taskId, "stage-guard-check", payload, isoMsAgo(5 * 60_000)));
        fs.writeFileSync(path.join(TMP_ROOT, "tasks", `${taskId}.guard-pass`), JSON.stringify({
            version: 1,
            taskId,
            conversationId: state.conversationId,
            stageId: state.stageId,
            guardStartedAt,
            checkedAt: new Date().toISOString(),
            taskFiles: [taskFile],
            summary: "阶段证据充分",
            selfReferenceResolved: false,
        }), "utf8");

        const recovery = await recoverBackgroundTask(taskId);
        assert.equal(recovery.outcome, "resumed");
        assert.ok(recovery.recoveredTaskId);
        const done = await waitForBackgroundTask(recovery.recoveredTaskId!, 2);
        assert.equal(done?.status, "done");
        assert.match(done?.result || "", /PASS receipt/u);
        assert.equal(readGuardState(state.conversationId), null);
        assert.equal(getGuardLocks(taskFile).some(lock => lock.conversationId === state.conversationId), false);
    });

    await step("stage-guard-check 状态已清后仍按 v2 PASS receipt 幂等完成", async () => {
        __testResetBackgroundTasksForTest();
        const taskId = "guard-pass-receipt-after-clear";
        const taskFile = path.join(TMP_ROOT, "Task-pass-after-clear.md");
        fs.writeFileSync(taskFile, "## Stage pass after clear\n- [x] done\n", "utf8");
        const guardStartedAt = isoMsAgo(10 * 60_000);
        const state = {
            active: true as const,
            guardId: "guard-pass-after-clear-id",
            conversationId: "conv-guard-pass-after-clear",
            chain: "codex" as const,
            modelChain: "codex" as const,
            stageId: "Stage pass after clear",
            childScopeId: "main",
            scopeSelectors: [] as string[],
            taskFiles: [taskFile],
            planFiles: [],
            startRound: 1,
            startedAt: guardStartedAt,
            checkHistory: [],
        };
        writeGuardState(state);
        insertLockMark(taskFile, state);
        assert.equal(clearGuardState(state), true, "模拟 PASS 收口已清状态但后台 done 尚未落盘的崩溃窗口");
        const payload = {
            version: 2,
            conversationId: state.conversationId,
            stageId: state.stageId,
            guardStartedAt,
            guardId: state.guardId,
            childScopeId: state.childScopeId,
            scopeSelectors: state.scopeSelectors,
            chain: "auto",
            modelChain: "codex",
        };
        __testWritePersistedTask(runningTask(taskId, "stage-guard-check", payload, isoMsAgo(5 * 60_000)));
        fs.writeFileSync(path.join(TMP_ROOT, "tasks", `${taskId}.guard-pass`), JSON.stringify({
            version: 2,
            taskId,
            conversationId: state.conversationId,
            stageId: state.stageId,
            guardStartedAt,
            guardId: state.guardId,
            childScopeId: state.childScopeId,
            scopeSelectors: state.scopeSelectors,
            checkedAt: new Date().toISOString(),
            taskFiles: [taskFile],
            summary: "阶段证据充分",
            selfReferenceResolved: false,
        }), "utf8");

        const recovery = await recoverBackgroundTask(taskId);
        assert.equal(recovery.outcome, "resumed");
        const done = await waitForBackgroundTask(recovery.recoveredTaskId!, 2);
        assert.equal(done?.status, "done");
        assert.match(done?.result || "", /PASS receipt/u);
        assert.equal(getGuardLocks(taskFile).some(lock => lock.guardId === state.guardId), false);
    });

    await step("stage-guard-check v2 payload 按 guardId 与 child scope 精确恢复", async () => {
        __testResetBackgroundTasksForTest();
        const taskId = "guard-v2-recovery";
        const taskFile = path.join(TMP_ROOT, "Task-v2.md");
        fs.writeFileSync(taskFile, "## Stage v2\n- [ ] child task\n", "utf8");
        const guardStartedAt = isoMsAgo(10 * 60_000);
        const taskStartedAt = isoMsAgo(5 * 60_000);
        const checkedAt = isoMsAgo(4 * 60_000);
        const state = {
            active: true as const,
            guardId: "guard-v2-recovery-id",
            conversationId: "conv-guard-v2",
            chain: "codex" as const,
            modelChain: "codex" as const,
            stageId: "Stage v2",
            childScopeId: "child-v2",
            scopeSelectors: ["child task"],
            taskFiles: [taskFile],
            planFiles: [],
            startRound: 1,
            startedAt: guardStartedAt,
            checkHistory: [{
                checkNumber: 1,
                result: "fail" as const,
                missingItems: ["child task"],
                summary: "子范围仍缺证据",
                checkedAt,
                taskId,
            }],
        };
        writeGuardState(state);
        const payload = {
            version: 2,
            conversationId: state.conversationId,
            stageId: state.stageId,
            guardStartedAt,
            guardId: state.guardId,
            childScopeId: state.childScopeId,
            scopeSelectors: state.scopeSelectors,
            chain: "auto",
            modelChain: "codex",
        };
        __testWritePersistedTask(runningTask(taskId, "stage-guard-check", payload, taskStartedAt));

        const recovery = await recoverBackgroundTask(taskId);
        assert.equal(recovery.outcome, "resumed");
        const done = await waitForBackgroundTask(recovery.recoveredTaskId!, 2);
        assert.equal(done?.status, "done");
        assert.match(done?.result || "", /未重复调用模型/u);
        assert.equal(readGuardState(state.conversationId, state.stageId, state.childScopeId)?.guardId, state.guardId);
    });

    await step("deep_locate 持久 payload 但无 handler，恢复时由核心标 error", async () => {
        __testResetBackgroundTasksForTest();
        const payload = {
            version: 1,
            query: "needle",
            dataChain: "codex",
            mode: "exact",
            conversationIds: ["conv-a"],
            maxFiles: 8,
            maxBytes: 1024,
            maxHits: 3,
        };
        const deepLocateTaskPathStartedAt = isoMsAgo(5 * 60_000);
        __testWritePersistedTask(runningTask("deep-locate-task", "conversation-deep-locate", payload, deepLocateTaskPathStartedAt));

        const recovery = await recoverBackgroundTask("deep-locate-task");
        assert.equal(recovery.outcome, "error");
        const errored = getBackgroundTask("deep-locate-task");
        assert.equal(errored?.status, "error");
        assert.match(errored?.error || "", /deep-locate/u);
    });

    if (failed) {
        console.error("❌ recover-nonrecord 存在失败用例");
        process.exit(1);
    }
    console.log("✅ recover-nonrecord 全部通过");
} finally {
    __testResetBackgroundTasksForTest();
    try {
        fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
        // ignore cleanup error
    }
    delete process.env.MEMORY_STORE_BACKGROUND_TASK_CONCURRENCY;
}
