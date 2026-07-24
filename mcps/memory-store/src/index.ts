#!/usr/bin/env node
/**
 * MCP Memory Store Server v1.21.1
 *
 * AI 主动记忆管理系统，支持多工作区、冷热分层、置顶记忆、批量操作、对话原文阅读、
 * Auto Summary 双轨制、黄金片段提取、对话记录 Record。
 *
 * v1.8: 对话记录 Record 系统 — 对话过程日志 + Flash 自动生成 + 分批处理
 *
 * 13 个 MCP 工具：
 *   - memory_write: 写入新记忆（含去重检测 + autoSummary 异步生成）
 *   - memory_query: 查询记忆（fuse.js + grep + 三档 depth + autoSummary 搜索）
 *   - memory_read: 读取单条记忆（支持行范围）
 *   - memory_update: 更新/追加记忆（内容变化自动重生成 autoSummary）
 *   - memory_delete: 删除记忆
 *   - memory_batch: 批量操作
 *   - memory_stats: 统计/归档/导出/导入/enhance 批量增强
 *   - conversation_read_original: 读取对话原文（绕过上下文压缩）
 *   - conversation_golden_extract: 黄金片段提取（对话关键信息 + 记忆去重）
 *   - record_manage: 对话记录管理（update/list/read/search/guide/edit/delete/batch_update/bulk_update/batch_delete/task_status/audit_ownership/repair_ownership/stale_check）
 *   - stage_guard: 任务完整性验证（start/check/status/cancel，支持外部文件证据索引）
 *   - background_task_status: 统一查询后台任务状态
 *   - background_task_cancel: 统一取消后台任务
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    touchActivity, isParentAlive, checkParentAliveWithTolerance,
    isAntigravityLS, getIdleTime, logStdinEvent, appendTiming,
    waitForPendingRecords, hasNewerSiblingInstance,
} from "./lifecycle.js";
import { ensureDataDirs } from "./store.js";
import { cleanOldTempFiles, ensureTempDir } from "./temp-store.js";
import { initParentLs } from "./ls-client.js";
import { cleanupRegistryOnExit } from "./ls-registry.js";
import { VERSION } from "./version.js";
import { GUIDE_TEXT } from "./guide-text.js";
import { installToolConcurrency } from "./tool-concurrency.js";
import { cleanOldTasks, runBackgroundTaskStartupRecovery } from "./background-tasks.js";
import {
    assertRecordMutationStartupRecoverySafe,
    recordMutationReadinessBarrier,
} from "./record-startup-barrier.js";
import { initializeProviderControlStore, readProviderControlStore } from "./provider-control-store.js";
import { getProviderTransportAdapter } from "./provider-transport-adapter.js";
import {
    closeRecordSchedulerProductionSessions,
    type RecordSchedulerProductionSessionsHandoff,
} from "./record-scheduler-production-pump.js";

// 工具注册
import { registerWrite } from "./tools/write.js";
import { registerQuery } from "./tools/query.js";
import { registerRead } from "./tools/read.js";
import { registerUpdate } from "./tools/update.js";
import { registerDelete } from "./tools/delete.js";
import { registerBatch } from "./tools/batch.js";
import { registerStats } from "./tools/stats.js";
import { registerConversation } from "./tools/conversation.js";
import { registerGoldenExtract } from "./tools/golden-extract.js";
import { registerRecord } from "./tools/record.js";
import { registerStageGuard } from "./tools/stage-guard.js";
import { registerBackgroundTask } from "./tools/background-task.js";

// === 进程生命周期 ===
let isClosing = false; // 防止重复清理

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 12_000;
const DEFAULT_SCHEDULER_SHUTDOWN_TIMEOUT_MS = 4_000;
const DEFAULT_PROVIDER_SHUTDOWN_TIMEOUT_MS = 6_000;
const DEFAULT_LEGACY_CLEANUP_TIMEOUT_MS = 1_000;

type ShutdownStepResult<Value> =
    | { kind: "completed"; value: Value }
    | { kind: "timed-out"; timeoutMs: number }
    | { kind: "failed"; error: unknown };

function shutdownTimeoutFromEnv(name: string, fallback: number, minimum = 0): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed >= minimum) return parsed;
    console.error(`[memory-store] 忽略无效的 ${name}=${JSON.stringify(raw)}，使用 ${fallback}ms`);
    return fallback;
}

function remainingShutdownMs(deadlineAt: number, capMs: number): number {
    return Math.max(0, Math.min(capMs, deadlineAt - Date.now()));
}

async function waitForShutdownStep<Value>(
    operation: Promise<Value>,
    deadlineAt: number,
    capMs: number,
): Promise<ShutdownStepResult<Value>> {
    const timeoutMs = remainingShutdownMs(deadlineAt, capMs);
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race<ShutdownStepResult<Value>>([
            operation.then(
                value => ({ kind: "completed", value }) as const,
                error => ({ kind: "failed", error }) as const,
            ),
            new Promise<ShutdownStepResult<Value>>(resolve => {
                timer = setTimeout(() => resolve({ kind: "timed-out", timeoutMs }), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function logSchedulerHandoff(handoff: RecordSchedulerProductionSessionsHandoff): void {
    console.error(`[memory-store] shutdown scheduler handoff ${JSON.stringify({
        acceptingDispatches: handoff.acceptingDispatches,
        closed: handoff.closed,
        timedOut: handoff.timedOut,
        active: handoff.activePendingAttemptIds,
        invoking: handoff.invokingAttemptIds,
        persisted: handoff.persisted,
    })}`);
}

function logShutdownStepFailure(name: string, result: Extract<ShutdownStepResult<unknown>, { kind: "failed" }>): void {
    const message = result.error instanceof Error ? result.error.stack || result.error.message : String(result.error);
    console.error(`[memory-store] shutdown ${name} failed: ${message}`);
}

/**
 * 统一的优雅退出路径：合并 SIGINT/SIGTERM/beforeExit 类信号、stdin end/close/error、
 * 心跳确认父进程死亡、重复实例让位、非 LS 空闲兜底等多条退出分支里逐字重复的
 * 「isClosing 守卫 + scheduler/provider handoff + legacy cleanup + process.exit()」尾部。
 *
 * - logBeforeCleanup：各分支专属日志（在 isClosing 守卫通过后、清理前执行，与原行为时序一致；
 *   重复触发时守卫先拦截，不会再打印日志，保持原「早 return 不打日志」语义）。
 * - diagnose：可选诊断钩子，仅 stdin end 用它保留二次探测父 LS；它也受统一退出 deadline 限制。
 */
async function gracefulExit(
    logBeforeCleanup?: () => void,
    diagnose?: () => Promise<void>,
): Promise<void> {
    if (isClosing) return;
    isClosing = true;
    logBeforeCleanup?.();

    const shutdownTimeoutMs = shutdownTimeoutFromEnv("MEMORY_STORE_SHUTDOWN_TIMEOUT_MS", DEFAULT_SHUTDOWN_TIMEOUT_MS, 1);
    const schedulerTimeoutMs = shutdownTimeoutFromEnv(
        "MEMORY_STORE_SCHEDULER_SHUTDOWN_TIMEOUT_MS",
        DEFAULT_SCHEDULER_SHUTDOWN_TIMEOUT_MS,
    );
    const providerTimeoutMs = shutdownTimeoutFromEnv(
        "MEMORY_STORE_PROVIDER_SHUTDOWN_TIMEOUT_MS",
        DEFAULT_PROVIDER_SHUTDOWN_TIMEOUT_MS,
    );
    const legacyCleanupTimeoutMs = shutdownTimeoutFromEnv(
        "MEMORY_STORE_LEGACY_CLEANUP_TIMEOUT_MS",
        DEFAULT_LEGACY_CLEANUP_TIMEOUT_MS,
    );
    const deadlineAt = Date.now() + shutdownTimeoutMs;
    let exitCode = 0;

    console.error(`[memory-store] shutdown scheduler close begin; totalTimeoutMs=${shutdownTimeoutMs}, schedulerTimeoutMs=${schedulerTimeoutMs}`);
    const schedulerClose = closeRecordSchedulerProductionSessions({
        timeoutMs: Math.min(schedulerTimeoutMs, shutdownTimeoutMs),
    });

    // Scheduler 先同步关闭新派发，再立即关闭 provider 入口，避免 legacy 调用在 handoff 等待期继续取得许可。
    console.error(`[memory-store] shutdown provider close begin; providerTimeoutMs=${providerTimeoutMs}`);
    const providerClose = getProviderTransportAdapter().close();

    const schedulerResult = await waitForShutdownStep(schedulerClose, deadlineAt, schedulerTimeoutMs);
    if (schedulerResult.kind === "completed") {
        logSchedulerHandoff(schedulerResult.value);
    } else if (schedulerResult.kind === "timed-out") {
        console.error(`[memory-store] shutdown scheduler close timed out after ${schedulerResult.timeoutMs}ms; handoff unavailable before process exit`);
    } else {
        exitCode = 1;
        logShutdownStepFailure("scheduler close", schedulerResult);
    }

    const providerResult = await waitForShutdownStep(providerClose, deadlineAt, providerTimeoutMs);
    if (providerResult.kind === "completed") {
        console.error("[memory-store] shutdown provider close completed");
    } else if (providerResult.kind === "timed-out") {
        console.error(`[memory-store] shutdown provider close timed out after ${providerResult.timeoutMs}ms; invoking RPC is left un-aborted and process exit continues`);
    } else {
        exitCode = 1;
        logShutdownStepFailure("provider close", providerResult);
    }

    if (diagnose) {
        const diagnoseResult = await waitForShutdownStep(diagnose(), deadlineAt, remainingShutdownMs(deadlineAt, shutdownTimeoutMs));
        if (diagnoseResult.kind === "timed-out") {
            console.error(`[memory-store] shutdown stdin diagnostic timed out after ${diagnoseResult.timeoutMs}ms`);
        } else if (diagnoseResult.kind === "failed") {
            exitCode = 1;
            logShutdownStepFailure("stdin diagnostic", diagnoseResult);
        }
    }

    console.error("[memory-store] shutdown legacy cleanup begin");
    cleanupRegistryOnExit();
    const cleanupResult = await waitForShutdownStep(cleanup(), deadlineAt, legacyCleanupTimeoutMs);
    if (cleanupResult.kind === "timed-out") {
        console.error(`[memory-store] shutdown legacy cleanup timed out after ${cleanupResult.timeoutMs}ms; process exit continues`);
    } else if (cleanupResult.kind === "failed") {
        exitCode = 1;
        logShutdownStepFailure("legacy cleanup", cleanupResult);
    }
    console.error(`[memory-store] shutdown process exit; code=${exitCode}`);
    process.exit(exitCode);
}

// 创建 MCP Server 实例
const server = new McpServer({
    name: "memory-store-mcp-server",
    version: VERSION,
});

installToolConcurrency(server);

// 注册所有 13 个工具
registerWrite(server);
registerQuery(server);
registerRead(server);
registerUpdate(server);
registerDelete(server);
registerBatch(server);
registerStats(server);
registerConversation(server);
registerGoldenExtract(server);
registerRecord(server);
registerStageGuard(server);
registerBackgroundTask(server);

// === 使用指南 Resource ===
server.registerResource(
    "guide",
    "memory-store://guide",
    {
        description: "Memory Store MCP 完整使用指南",
        mimeType: "text/plain",
    },
    async () => ({
        contents: [
            {
                uri: "memory-store://guide",
                text: GUIDE_TEXT,
                mimeType: "text/plain",
            },
        ],
    })
);

// === stdin 断开检测（含诊断增强）===
process.stdin.on("end", async () => {
    await gracefulExit(
        () => {
            const parentAlive = isParentAlive();
            logStdinEvent(`stdin END — 父 LS ${parentAlive ? "仍存活（LS 内部重置?）" : "已死亡"}`);
        },
        async () => {
            // 等 3 秒做诊断：区分 LS 真死 vs LS 抖动
            await new Promise(r => setTimeout(r, 3000));
            const parentStillAlive = isParentAlive();
            logStdinEvent(`stdin END 等待3s后 — 父 LS ${parentStillAlive ? "仍存活" : "已死亡"}，退出`);
        },
    );
});

process.stdin.on("close", async () => {
    await gracefulExit(() => {
        const parentAlive = isParentAlive();
        logStdinEvent(`stdin CLOSE — 父 LS ${parentAlive ? "仍存活" : "已死亡"}`);
    });
});

process.stdin.on("error", async (err) => {
    await gracefulExit(() => {
        logStdinEvent(`stdin ERROR: ${err.message} — 父 LS ${isParentAlive() ? "仍存活" : "已死亡"}`);
    });
});

// === 心跳检测：父 LS 进程存活检测（连续 3 次失败容错）===
let heartbeatIntervalMs = 30000;
let heartbeatTimer = setInterval(heartbeatCheck, heartbeatIntervalMs);
heartbeatTimer.unref();
let enableDuplicateRetirement = false;
const DUPLICATE_RETIRE_IDLE_MS = 2 * 60 * 1000;

async function heartbeatCheck(): Promise<void> {
    const status = checkParentAliveWithTolerance();
    if (status === "dead") {
        await gracefulExit(() => {
            logStdinEvent(`父 LS (PID=${process.ppid}) 连续3次检测失败，确认死亡，MCP 退出`);
            console.error(`[memory-store] 父 LS (PID=${process.ppid}) 连续3次检测失败，自动退出`);
        });
        return;
    } else if (status === "degraded") {
        // 单次失败，切换快速检测模式（5s 间隔，加速确认）
        if (heartbeatIntervalMs !== 5000) {
            heartbeatIntervalMs = 5000;
            clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(heartbeatCheck, 5000);
            heartbeatTimer.unref();
            logStdinEvent(`ppid 检测失败，切换快速检测模式 (5s)`);
            console.error(`[memory-store] ppid 检测失败，切换快速检测模式 (5s)`);
        }
    } else if (heartbeatIntervalMs !== 30000) {
        // 恢复正常间隔
        heartbeatIntervalMs = 30000;
        clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(heartbeatCheck, 30000);
        heartbeatTimer.unref();
        logStdinEvent(`ppid 检测恢复正常，切回 30s 间隔`);
        console.error(`[memory-store] ppid 检测恢复正常，切回 30s 间隔`);
    }

    if (enableDuplicateRetirement && getIdleTime() > DUPLICATE_RETIRE_IDLE_MS) {
        const hasNewer = await hasNewerSiblingInstance();
        if (hasNewer) {
            await gracefulExit(() => {
                logStdinEvent("检测到同父进程下更新的 memory-store 实例，当前实例空闲超时，主动让位退出");
                console.error("[memory-store] 检测到更新实例，当前实例空闲超时，主动让位退出");
            });
        }
    }
}

// === 启动 ===
async function main(): Promise<void> {
console.error(`[memory-store] MCP Server v${VERSION} 启动中... (ppid=${process.ppid})`);
    logStdinEvent("STARTED");

    // 初始化数据目录
    ensureDataDirs();

    // 初始化临时文件目录 + 清理过期文件
    ensureTempDir();
    cleanOldTempFiles();

    const providerControl = await readProviderControlStore();
    if (providerControl.kind === "repair-required" && providerControl.repair.reason === "first_install_required") {
        await initializeProviderControlStore({ initialization: "exclusive-install" });
        console.error("[memory-store] provider control 首次独占初始化完成");
    } else if (providerControl.kind === "repair-required") {
        console.error(`[memory-store] provider control 需要修复，模型派发保持阻塞: ${providerControl.repair.reason}`);
    }

    const startupRecovery = recordMutationReadinessBarrier.start(async () => {
        const cleanupSummary = cleanOldTasks();
        const recoverySummary = await runBackgroundTaskStartupRecovery();
        console.error(
            `[memory-store] 后台任务恢复扫描完成：generic.scanned=${recoverySummary.generic.scanned}, generic.resumed=${recoverySummary.generic.resumed}, generic.restarted=${recoverySummary.generic.restarted}, generic.error=${recoverySummary.generic.errored}, scheduler.scanned=${recoverySummary.recordScheduler.scanned}, scheduler.rebuilt=${recoverySummary.recordScheduler.rebuilt}, scheduler.repair=${recoverySummary.recordScheduler.repairRequired}, scheduler.unknown=${recoverySummary.recordScheduler.unknownOutcome}; cleanup=${cleanupSummary.deletedTaskIds.length}`,
        );
        assertRecordMutationStartupRecoverySafe(recoverySummary);
    });
    void startupRecovery.catch(error => {
        console.error("[memory-store] 后台任务恢复扫描异常，Record 写入保持阻塞:", error);
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error(`[memory-store] MCP Server v${VERSION} 已启动，绑定父 LS PID=${process.ppid}`);
    logStdinEvent(`BOUND to parent LS PID=${process.ppid}`);

    // === 非 LS 环境兜底超时 ===
    const isLS = await isAntigravityLS();
    if (isLS) {
        console.error(`[memory-store] 检测到 Antigravity LS 环境，纯 ppid 管理`);
        // 连接 MCP stdio 后再初始化父 LS，避免 initialize 握手被阻塞。
        setTimeout(() => {
            initParentLs().catch(err => {
                console.error("[memory-store] 父 LS 初始化异常:", err);
            });
        }, 1500).unref();
    } else {
        console.error(`[memory-store] 非 Antigravity LS 环境，启用 1 小时空闲兜底`);
        logStdinEvent(`非 LS 环境，启用 1 小时空闲超时兜底`);
        enableDuplicateRetirement = process.env.MEMORY_STORE_ENABLE_DUPLICATE_RETIREMENT === "1";
        const idleGuard = setInterval(async () => {
            if (getIdleTime() > 3600000) { // 1 小时
                await gracefulExit(() => {
                    logStdinEvent("非 LS 环境空闲超过 1 小时，兜底退出");
                    console.error("[memory-store] 非 LS 环境空闲超过 1 小时，兜底退出");
                });
            }
        }, 60000); // 每分钟检查一次
        idleGuard.unref();
    }
}

main().catch((error) => {
    console.error("[memory-store] 启动失败:", error);
    process.exit(1);
});

// === 优雅关闭 ===
const cleanup = async () => {
    console.error("[memory-store] 正在关闭...");
    clearInterval(heartbeatTimer);
    await waitForPendingRecords(90_000);
};

process.on("SIGINT", async () => {
    await gracefulExit();
});

process.on("SIGTERM", async () => {
    await gracefulExit();
});
