#!/usr/bin/env node
/**
 * MCP Memory Store Server v1.15.14
 *
 * AI 主动记忆管理系统，支持多工作区、冷热分层、置顶记忆、批量操作、对话原文阅读、
 * Auto Summary 双轨制、黄金片段提取、对话记录 Record。
 *
 * v1.8: 对话记录 Record 系统 — 对话过程日志 + Flash 自动生成 + 分批处理
 *
 * 11 个 MCP 工具：
 *   - memory_write: 写入新记忆（含去重检测 + autoSummary 异步生成）
 *   - memory_query: 查询记忆（fuse.js + grep + 三档 depth + autoSummary 搜索）
 *   - memory_read: 读取单条记忆（支持行范围）
 *   - memory_update: 更新/追加记忆（内容变化自动重生成 autoSummary）
 *   - memory_delete: 删除记忆
 *   - memory_batch: 批量操作
 *   - memory_stats: 统计/归档/导出/导入/enhance 批量增强
 *   - conversation_read_original: 读取对话原文（绕过上下文压缩）
 *   - conversation_golden_extract: 黄金片段提取（对话关键信息 + 记忆去重）
 *   - record_manage: 对话记录管理（update/list/read/search/guide/edit/delete/batch_update/batch_delete/task_status/audit_ownership/repair_ownership）
 *   - stage_guard: 任务完整性验证（start/check/status/cancel，支持外部文件证据索引）
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

// === 进程生命周期 ===
let isClosing = false; // 防止重复清理

/**
 * 统一的优雅退出路径：合并 SIGINT/SIGTERM/beforeExit 类信号、stdin end/close/error、
 * 心跳确认父进程死亡、重复实例让位、非 LS 空闲兜底等多条退出分支里逐字重复的
 * 「isClosing 守卫 + cleanupRegistryOnExit() + await cleanup() + process.exit(0)」尾部。
 *
 * - logBeforeCleanup：各分支专属日志（在 isClosing 守卫通过后、清理前执行，与原行为时序一致；
 *   重复触发时守卫先拦截，不会再打印日志，保持原「早 return 不打日志」语义）。
 * - diagnose：可选诊断钩子，仅 stdin end 用它保留「cleanupRegistryOnExit 后等 3s 再二次探测父 LS」特例。
 */
async function gracefulExit(
    logBeforeCleanup?: () => void,
    diagnose?: () => Promise<void>,
): Promise<void> {
    if (isClosing) return;
    isClosing = true;
    logBeforeCleanup?.();
    cleanupRegistryOnExit();
    if (diagnose) await diagnose();
    await cleanup();
    process.exit(0);
}

// 创建 MCP Server 实例
const server = new McpServer({
    name: "memory-store-mcp-server",
    version: VERSION,
});

// 注册所有 11 个工具
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
