import fs from "fs";
import os from "os";
import path from "path";
import { exec } from "child_process";
import { shouldAutoUpdateRecordAsync, generateRecord, countPhasesInRecord, validateRecordCandidateForWrite } from "./record-generator.js";
import { findRecordHashAsync, resolveWorkspaceHashForRecord, readRecordAsync, writeRecord } from "./record-store.js";
import { loadConversationData } from "./conversation-bridge.js";
import { detectWorkspaceFromSteps } from "./ls-client.js";
import { acquireRecordSingleFlightPermit, buildAndPersistRecordReaderIndex, withRecordPersistenceWrite } from "./record-update-coordination.js";

/**
 * MCP Memory Store 进程生命周期管理 v1.7
 * 
 * - isParentAlive: 检测父 LS 进程存活（ppid 绑定）
 * - checkParentAliveWithTolerance: 带连续失败容错的 ppid 检测
 * - isAntigravityLS: 检测父进程是否为 Antigravity LS
 * - touchActivity: 每个工具调用入口更新时间戳
 * - getIdleTime: 空闲时间（非 LS 环境兜底用）
 * - logStdinEvent: stdin 事件日志（调试用）
 * - appendTiming: 返回结果追加耗时信息
 */

// 最后一次 MCP 工具调用的时间戳
let lastMcpActivity = Date.now();
let lastRecordCheckMs = 0;
const RECORD_CHECK_INTERVAL_MS = 60_000;

// 正在进行的 Record 生成 Promise（退出时等待完成）
const pendingRecordPromises: Set<Promise<void>> = new Set();
const pendingRecordKeys: Set<string> = new Set();

// stdin 日志路径
const STDIN_LOG_FILE = path.join(os.tmpdir(), "mcp-memory-stdin-log.txt");

/**
 * 更新活动时间戳 — 每个工具处理函数入口调用
 */
export function touchActivity(options: { skipRecordAutoCheck?: boolean } = {}): void {
    lastMcpActivity = Date.now();
    if (options.skipRecordAutoCheck) return;
    if (shouldSkipRecordAutoCheckForHost()) return;
    if (Date.now() - lastRecordCheckMs >= RECORD_CHECK_INTERVAL_MS) {
        lastRecordCheckMs = Date.now();
        triggerRecordAutoCheck().catch(() => { });
    }
}

function shouldSkipRecordAutoCheckForHost(): boolean {
    if (process.env.MEMORY_STORE_AUTO_RECORD === "0") return true;
    if (process.env.CODEX_MCP_WRAPPER === "1" && process.env.MEMORY_STORE_CODEX_AUTO_RECORD !== "1") {
        return true;
    }
    return false;
}

/**
 * 获取自最后活动以来的空闲时间（毫秒）
 */
export function getIdleTime(): number {
    return Date.now() - lastMcpActivity;
}

/**
 * 检测同一父进程下是否已有更新的同类 MCP 实例。
 *
 * Codex app-server 在重连 / 切线程 / 刷新时，可能重复拉起同一 MCP，
 * 但旧实例的 stdin 不一定立刻断开。这里用于让旧实例在空闲时主动让位。
 */
export async function hasNewerSiblingInstance(): Promise<boolean> {
    if (process.platform !== "win32") return false;

    const currentScript = (process.argv[1] || "").replace(/\\/g, "\\\\");
    if (!currentScript) return false;

    const escapedScript = currentScript.replace(/'/g, "''");

    try {
        const result = await new Promise<string | null>((resolve) => {
            exec(
                `wmic process where "ParentProcessId=${process.ppid} and name='node.exe'" get ProcessId,CommandLine /format:csv`,
                { encoding: "utf-8", timeout: 5000, windowsHide: true },
                (error, stdout) => {
                    if (error) resolve(null);
                    else resolve(stdout || null);
                }
            );
        });

        if (!result) return false;

        const lines = result
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean);

        for (const line of lines) {
            if (!line.includes(escapedScript)) continue;
            const parts = line.split(",");
            const pid = Number(parts[parts.length - 1]);
            if (Number.isFinite(pid) && pid > process.pid) {
                return true;
            }
        }
    } catch {
        return false;
    }

    return false;
}

/**
 * 等待所有 pending Record 生成完成（退出钩子用）
 * @param timeoutMs 最大等待时间，默认 90s
 */
export async function waitForPendingRecords(timeoutMs = 90_000): Promise<void> {
    if (pendingRecordPromises.size === 0) return;
    console.error(`[lifecycle] ⏳ 等待 ${pendingRecordPromises.size} 个 Record 生成完成...`);
    const deadline = Date.now() + timeoutMs;
    while (pendingRecordPromises.size > 0 && Date.now() < deadline) {
        await Promise.race([
            Promise.allSettled([...pendingRecordPromises]),
            new Promise(r => setTimeout(r, 5000)), // 每 5s 检查一次
        ]);
    }
    if (pendingRecordPromises.size > 0) {
        console.error(`[lifecycle] ⚠️ 超时，仍有 ${pendingRecordPromises.size} 个 Record 未完成`);
    } else {
        console.error(`[lifecycle] ✅ 所有 Record 生成已完成`);
    }
}

/** 异步检查当前对话是否需要更新 Record，静默后台执行 */
async function triggerRecordAutoCheck(): Promise<void> {
    try {
        const loaded = await loadConversationData("auto", undefined, { link: "summary" });
        if (!loaded) return;
        const cascadeId = loaded.conversationId;
        const detectedWs = loaded.chainUsed === "antigravity"
            ? detectWorkspaceFromSteps(loaded.trajectory?.steps || [])
            : (loaded.codexData?.thread.cwd || loaded.claudeCodeData?.thread.cwd);
        const detectedHash = detectedWs ? resolveWorkspaceHashForRecord(detectedWs) : null;
        const existingHash = await findRecordHashAsync(cascadeId);
        // 自动更新时当前宿主/线程检测到的工作区优先，避免历史异常 hash 持续污染新写入。
        const recordHash = detectedHash || existingHash || resolveWorkspaceHashForRecord();
        const recordWorkspace = detectedWs || (recordHash === "general" ? "general" : recordHash);

        if (existingHash && detectedHash && existingHash !== detectedHash) {
            console.error(
                `[record-auto] workspace hash changed for ${cascadeId.slice(0, 8)}: existing=${existingHash}, detected=${detectedHash}`
            );
        }
        const rounds = loaded.rounds;
        if (!await shouldAutoUpdateRecordAsync(recordHash, cascadeId, rounds.length)) return;
        const totalSteps = loaded.totalSteps;
        const pendingKey = `${recordHash}:${cascadeId}`;
        if (pendingRecordKeys.has(pendingKey)) {
            console.error(`[record-auto] skip duplicate pending update: ${cascadeId.slice(0, 8)}...`);
            return;
        }

        pendingRecordKeys.add(pendingKey);
        const recordModelChain = (loaded.chainUsed === "claude-code" || loaded.chainUsed === "windsurf") ? "auto" : loaded.chainUsed;
        const p = (async () => {
            const singleFlightPermit = await acquireRecordSingleFlightPermit(cascadeId);
            try {
                if (!await shouldAutoUpdateRecordAsync(recordHash, cascadeId, rounds.length)) return;
                const res = await generateRecord(recordHash, cascadeId, recordWorkspace, rounds, totalSteps, recordModelChain);
                if (res.success && res.content) {
                    const content = res.content;
                    const oldRecord = await readRecordAsync(recordHash, cascadeId) || "";
                    const gate = validateRecordCandidateForWrite(content, cascadeId, rounds.length, res.coveredRounds || rounds.length, {
                        oldRecord,
                    });
                    if (!gate.ok) {
                        console.error(`[record-auto] ❌ ${cascadeId.slice(0, 8)}... 候选被拒绝: ${gate.error}`);
                        return;
                    }
                    const phases = countPhasesInRecord(content);
                    await withRecordPersistenceWrite(async () => {
                        await writeRecord(recordHash, cascadeId, content, {
                            totalRounds: rounds.length, totalSteps,
                            lastUpdatedRound: res.coveredRounds || rounds.length,
                            phases, tags: res.tags,
                        });
                        const readerIndex = await buildAndPersistRecordReaderIndex(recordHash, cascadeId, content);
                        if (readerIndex.error) {
                            console.error(`[record-auto] reader index rebuild degraded: ${readerIndex.error instanceof Error ? readerIndex.error.message : String(readerIndex.error)}`);
                        }
                    });
                    console.error(`[record-auto] ✅ ${cascadeId.slice(0, 8)}... (${phases} Phase)`);
                } else if (res.error) {
                    console.error(`[record-auto] ❌ ${cascadeId.slice(0, 8)}... ${res.error}`);
                }
            } finally {
                singleFlightPermit.release();
            }
        })()
            .catch(error => console.error(`[record-auto] ❌ ${cascadeId.slice(0, 8)}... ${error instanceof Error ? error.message : String(error)}`))
            .finally(() => {
                pendingRecordPromises.delete(p);
                pendingRecordKeys.delete(pendingKey);
            });
        pendingRecordPromises.add(p);
    } catch { /* 静默 */ }
}

/**
 * 记录 stdin 事件到日志（调试用）
 */
export function logStdinEvent(event: string): void {
    try {
        const msg = `[${new Date().toISOString()}] PID ${process.pid} ${event}\n`;
        fs.appendFileSync(STDIN_LOG_FILE, msg);
    } catch { /* 写入失败不影响运行 */ }
}

/**
 * 检测父 LS 进程是否还活着
 * process.ppid 在 MCP 进程中直接指向 LS 的 PID（已验证）
 * process.kill(pid, 0) 是 Node 原生 API，跨平台，微秒级
 */
export function isParentAlive(): boolean {
    try {
        process.kill(process.ppid, 0);
        return true;
    } catch {
        return false;
    }
}

// ppid 连续失败计数
let consecutivePpidFailures = 0;
const PPID_FAILURE_THRESHOLD = 3;

/**
 * 带容错的 ppid 检测
 * 
 * 单次失败不判死，连续 N 次失败才确认死亡。
 * 应对 LS 短暂抖动（进程瞬间不可达但随后恢复）。
 * 
 * @returns "alive" | "degraded" | "dead"
 */
export function checkParentAliveWithTolerance(): "alive" | "degraded" | "dead" {
    if (isParentAlive()) {
        if (consecutivePpidFailures > 0) {
            logStdinEvent(`ppid 检测恢复正常（之前连续失败 ${consecutivePpidFailures} 次）`);
        }
        consecutivePpidFailures = 0;
        return "alive";
    }

    consecutivePpidFailures++;

    if (consecutivePpidFailures >= PPID_FAILURE_THRESHOLD) {
        return "dead";
    }

    return "degraded";
}

/**
 * 检测父进程是否为 Antigravity LS
 * 
 * 通过 wmic 查询父进程名称，匹配 language_server 前缀。
 * 仅启动时调用一次，结果缓存。
 * 
 * 非 LS 环境（其他 IDE、手动启动等）会启用空闲超时兜底。
 */
let cachedIsLS: boolean | null = null;

export async function isAntigravityLS(): Promise<boolean> {
    if (cachedIsLS !== null) return cachedIsLS;

    if (process.platform !== "win32") {
        // 非 Windows 暂时默认非 LS（未来可扩展）
        cachedIsLS = false;
        return false;
    }

    try {
        const result = await new Promise<string | null>((resolve) => {
            exec(
                `wmic process where ProcessId=${process.ppid} get Name /value`,
                { encoding: "utf-8", timeout: 5000, windowsHide: true },
                (error, stdout) => {
                    if (error) resolve(null);
                    else resolve(stdout?.trim() || null);
                }
            );
        });

        if (result) {
            // LS 进程名通常为 language_server_amd64.exe 或类似
            cachedIsLS = result.toLowerCase().includes("language_server");
            return cachedIsLS;
        }
    } catch { /* 查询失败，保守认定为非 LS */ }

    cachedIsLS = false;
    return false;
}

/**
 * 在 MCP 工具返回结果的最后一个 text content 追加耗时信息
 * 参考 web-fetcher appendTiming 模式
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function appendTiming(result: any, startTime: number): any {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const timingStr = `\n⏱ 耗时 ${elapsed}s`;

    for (let i = result.content.length - 1; i >= 0; i--) {
        if (result.content[i].type === "text" && result.content[i].text) {
            result.content[i].text += timingStr;
            break;
        }
    }
    return result;
}
