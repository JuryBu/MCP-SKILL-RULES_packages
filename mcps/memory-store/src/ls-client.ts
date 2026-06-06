import { execSync, execFileSync } from "child_process";
import http from "http";
import path from "path";
import os from "os";
import fs from "fs";
import {
    readRegistry, registerLsEntry, removeFromRegistry,
    markHeartbeatSuccess, markHeartbeatFailure,
    cleanDeadEntries,
    type RegistryEntry,
} from "./ls-registry.js";
import { DEFAULT_ANTIGRAVITY_LS_MODEL_FALLBACKS } from "./ls-model-defaults.js";

/**
 * Language Server connect-rpc 客户端
 *
 * v1.6 重构：ppid 直连 + 注册表加速 + 三步查找
 *
 * 路由层（本次重构）：
 *   parentLs 体系取代旧 cachedLsInfo 体系
 *   fetchTrajectory 三步查找：父 LS → 注册表 → PowerShell 兜底
 *
 * 数据层（不变）：
 *   fetchAllStepsPaged / fetchStepsIncremental / verifyTail / rpcCall
 */

// ===== 类型 =====

export interface LsProcessInfo {
    pid: number;
    csrfToken: string;
    workspaceId: string;
    ports: number[];
}

interface RpcResult {
    status: number;
    data: any;
    rawSize: number;
}

/** 父 LS 已确认的连接信息（含验证后的 HTTP 端口） */
interface ParentLsConnection {
    info: LsProcessInfo;
    port: number;
}

// ===== 父 LS 体系 =====

/** 模块变量：进程启动时通过 ppid 初始化，生命期内不变 */
let parentLs: ParentLsConnection | null = null;
let parentLsInitPromise: Promise<void> | null = null;
let parentLsInitDone = false;

/**
 * 获取已缓存的父 LS 连接（未就绪返回 null）
 */
export function getParentLs(): ParentLsConnection | null {
    return parentLs;
}

/**
 * 发现父 LS 进程（单 PID 精确查询，比全量扫描快得多）
 * 只查 process.ppid 一个进程
 */
function discoverParentLs(): LsProcessInfo | null {
    const ppid = process.ppid;
    try {
        const psScript = [
            "$ProgressPreference = 'SilentlyContinue'",
            `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${ppid}" -ErrorAction SilentlyContinue`,
            `$ports = (Get-NetTCPConnection -OwningProcess ${ppid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort) -join ","`,
            `"${ppid}|$($p.CommandLine)|$ports"`,
        ].join('\n');
        const encodedCmd = Buffer.from(psScript, 'utf16le').toString('base64');
        const stdout = execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedCmd}`, {
            encoding: "utf-8",
            timeout: 10000,
            windowsHide: true,
        }).trim();

        if (!stdout) return null;
        const parts = stdout.split("|");
        if (parts.length < 3) return null;

        const cmd = parts[1];
        if (!cmd) return null;

        const csrfMatch = cmd.match(/--csrf_token\s+(\S+)/);
        if (!csrfMatch) return null;

        const wsMatch = cmd.match(/--workspace_id\s+(\S+)/);
        const workspaceId = wsMatch ? wsMatch[1] : "";

        const ports = parts[2]
            .split(",")
            .map(p => parseInt(p.trim(), 10))
            .filter(p => !isNaN(p))
            .sort((a, b) => a - b);

        if (ports.length === 0) return null;

        return { pid: ppid, csrfToken: csrfMatch[1], workspaceId, ports };
    } catch {
        return null;
    }
}

/**
 * 异步初始化父 LS 连接（不阻塞工具注册，带重试）
 * 在 index.ts 的 main() 中调用
 */
export async function initParentLs(): Promise<void> {
    if (parentLsInitDone) return;
    if (parentLsInitPromise) return parentLsInitPromise;

    if (process.env.CODEX_MCP_WRAPPER === "1") {
        parentLsInitDone = true;
        console.error("[ls-client] Codex MCP wrapper 环境，跳过父 LS 同步探测");
        return;
    }

    parentLsInitPromise = (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
            const info = discoverParentLs();
            if (!info) {
                console.error(`[ls-client] 父 LS 发现失败 (${attempt + 1}/3)，等待 2s 重试`);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            // 验证 HTTP 端口
            const port = await findHttpPort(info);
            if (!port) {
                console.error(`[ls-client] 父 LS 端口验证失败 (${attempt + 1}/3)，等待 2s 重试`);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            parentLs = { info, port };
            parentLsInitDone = true;
            console.error(`[ls-client] 父 LS 初始化成功: PID=${info.pid} port=${port}`);

            // 注册到共享注册表
            registerLsEntry({
                pid: info.pid,
                port,
                csrfToken: info.csrfToken,
                workspaceId: info.workspaceId,
                registeredAt: new Date().toISOString(),
            });

            // 惰性清理注册表中的死条目
            cleanDeadEntries();
            return;
        }
        console.error("[ls-client] 父 LS 初始化全部失败，将降级使用旧逻辑");
        parentLsInitDone = true; // 标记完成（即使失败），避免重复初始化
    })();

    return parentLsInitPromise;
}

// ===== 全量发现（降级为 Step 3 兜底） =====

/**
 * 发现所有 LS 进程（PowerShell 全量扫描）
 * v1.6: 降级为三步查找的 Step 3 兜底手段
 */
export function discoverLsProcesses(): LsProcessInfo[] {
    try {
        const psScript = [
            "$ProgressPreference = 'SilentlyContinue'",
            'Get-Process -Name language_server_windows_x64 -ErrorAction SilentlyContinue | ForEach-Object {',
            '  $id = $_.Id',
            '  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue).CommandLine',
            '  $ports = (Get-NetTCPConnection -OwningProcess $id -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort) -join ","',
            '  "$id|$cmd|$ports"',
            '}',
        ].join('\n');
        const encodedCmd = Buffer.from(psScript, 'utf16le').toString('base64');
        const stdout = execSync(`powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedCmd}`, {
            encoding: "utf-8",
            timeout: 20000,
            windowsHide: true,
        }).trim();

        if (!stdout) return [];

        const results: LsProcessInfo[] = [];
        for (const line of stdout.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const parts = trimmed.split("|");
            if (parts.length < 3) continue;
            const pid = parseInt(parts[0], 10);
            const cmd = parts[1];
            const portsStr = parts[2];
            if (isNaN(pid) || !cmd) continue;
            const csrfMatch = cmd.match(/--csrf_token\s+(\S+)/);
            if (!csrfMatch) continue;
            const wsMatch = cmd.match(/--workspace_id\s+(\S+)/);
            const workspaceId = wsMatch ? wsMatch[1] : "";
            const ports = portsStr.split(",").map(p => parseInt(p.trim(), 10))
                .filter(p => !isNaN(p)).sort((a, b) => a - b);
            if (ports.length === 0) continue;
            results.push({ pid, csrfToken: csrfMatch[1], workspaceId, ports });
        }
        return results;
    } catch {
        return [];
    }
}

/** 注册表条目转 LsProcessInfo */
function entryToLsInfo(entry: RegistryEntry): LsProcessInfo {
    return {
        pid: entry.pid,
        csrfToken: entry.csrfToken,
        workspaceId: entry.workspaceId,
        ports: [entry.port],
    };
}

// ===== connect-rpc 调用 =====

/**
 * 底层 HTTP POST 请求
 */
function httpPost(
    host: string,
    port: number,
    urlPath: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs = 15000
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: host,
                port,
                path: urlPath,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                    ...headers,
                },
                timeout: timeoutMs,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () => {
                    const responseBody = Buffer.concat(chunks).toString("utf-8");
                    resolve({ status: res.statusCode || 0, body: responseBody });
                });
            }
        );
        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("Request timeout"));
        });
        req.write(body);
        req.end();
    });
}

/**
 * 调用 LS 的 connect-rpc 方法
 * @param timeoutMs 自定义超时（默认 15s，大数据操作建议 60-120s）
 */
async function rpcCall(
    lsInfo: LsProcessInfo,
    port: number,
    method: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 15000
): Promise<RpcResult> {
    const rpcPath = `/exa.language_server_pb.LanguageServerService/${method}`;
    const body = JSON.stringify(payload);
    const headers = {
        "x-codeium-csrf-token": lsInfo.csrfToken,
        "Connect-Protocol-Version": "1",
    };

    const resp = await httpPost("127.0.0.1", port, rpcPath, body, headers, timeoutMs);

    let data: any;
    try {
        data = resp.body ? JSON.parse(resp.body) : {};
    } catch {
        data = resp.body;
    }

    return { status: resp.status, data, rawSize: resp.body?.length ?? 0 };
}

/**
 * 找到 LS 的有效 HTTP 端口（通过 Heartbeat 验证）
 */
async function findHttpPort(lsInfo: LsProcessInfo): Promise<number | null> {
    for (const port of lsInfo.ports) {
        try {
            const result = await rpcCall(lsInfo, port, "Heartbeat", {}, 5000);
            if (result.status === 200) return port;
        } catch { /* try next */ }
    }
    return null;
}

// ===== 对话数据获取 =====

/** 每页预估步数（用于并行分页计算） */
const STEPS_PER_PAGE = 750;
/** 尾部校验步数（用于检测回溯） */
const TAIL_VERIFY_STEPS = 30;
/** 重量级操作超时 */
const HEAVY_TIMEOUT = 120000;
/** 轻量级操作超时 */
const LIGHT_TIMEOUT = 30000;

/**
 * 轻量级获取指定对话的 stepCount
 * 用 GetAllCascadeTrajectories（~46KB/1s）替代 GetCascadeTrajectory（~7MB/14s）
 * @returns stepCount，若该 LS 没有此对话则返回 -1
 */
async function getStepCountLight(
    lsInfo: LsProcessInfo,
    port: number,
    cascadeId: string
): Promise<{ stepCount: number; lastModifiedTime?: string }> {
    const result = await rpcCall(lsInfo, port, "GetAllCascadeTrajectories", {}, LIGHT_TIMEOUT);
    if (result.status !== 200) return { stepCount: -1 };
    const summaries = result.data?.trajectorySummaries;
    if (!summaries || typeof summaries !== "object") return { stepCount: -1 };
    const info = summaries[cascadeId];
    if (!info) return { stepCount: -1 };
    return {
        stepCount: info.stepCount ?? 0,
        lastModifiedTime: info.lastModifiedTime,
    };
}

/** 安全间隔基准：2.5MB（LS 实际返回 ~5MB/页，但步骤大小递增导致后续页步数减少，需留足容错） */
const SAFE_PAGE_SIZE_KB = 2560;

/**
 * 安全并行分页获取所有步骤
 *
 * LS 按 ~5MB 数据量限制每页（不是按步数），导致每页步数不固定（613/414/342/196）。
 * 策略：
 * 1. 串行获取第一页 → 得到实际步数 N 和数据大小 S
 * 2. 用 4MB 安全基准估算步间隔：interval = floor(N × 4096 / S_KB)
 *    interval < N → 保证相邻页有重叠，绝无间隙
 * 3. 已知 totalSteps → 计算并行 offset 列表 → Promise.all
 * 4. 按 offset 排序，去重合并
 *
 * @param totalSteps 可选，已知总步数（热路径从 GetAllCascadeTrajectories 获得）。
 *                   不传则退化为串行循环（冷对话路径）。
 */
async function fetchAllStepsPaged(
    lsInfo: LsProcessInfo,
    port: number,
    cascadeId: string,
    totalSteps?: number
): Promise<any[]> {
    // ===== 第一页（串行，用于标定页大小）=====
    const firstResult = await rpcCall(lsInfo, port, "GetCascadeTrajectorySteps",
        { cascadeId, stepOffset: 0 }, HEAVY_TIMEOUT);
    const firstSteps = firstResult.data?.steps ?? [];
    if (firstSteps.length === 0) return [];

    // 估算第一页数据大小（KB）
    const firstPageSizeKB = firstResult.rawSize
        ? firstResult.rawSize / 1024
        : JSON.stringify(firstResult.data).length / 1024;

    // ===== 计算安全间隔 =====
    // interval = firstSteps × (4MB / 实际页大小)，保证 interval < firstSteps.length
    const safeInterval = Math.max(
        50,  // 最小间隔
        Math.floor(firstSteps.length * (SAFE_PAGE_SIZE_KB / Math.max(firstPageSizeKB, 1)))
    );

    // ===== 决定并行 or 串行 =====
    const knownTotal = totalSteps ?? 0;
    const needMore = knownTotal > firstSteps.length || (!totalSteps && firstSteps.length >= 50);

    if (!needMore) {
        // 小对话或第一页已全部获取
        return firstSteps;
    }

    if (totalSteps && totalSteps > 0) {
        // ===== 热路径：已知总步数 → 并行 =====
        const offsets: number[] = [];
        for (let off = safeInterval; off < totalSteps; off += safeInterval) {
            offsets.push(off);
        }

        if (offsets.length === 0) {
            // safeInterval >= totalSteps，第一页已包含全部
            return firstSteps;
        }

        // 并行请求
        const pagePromises = offsets.map(offset =>
            rpcCall(lsInfo, port, "GetCascadeTrajectorySteps",
                { cascadeId, stepOffset: offset }, HEAVY_TIMEOUT)
                .then(r => ({ offset, steps: r.data?.steps ?? [] }))
                .catch(() => ({ offset, steps: [] as any[] }))
        );

        const pages = await Promise.all(pagePromises);
        pages.sort((a, b) => a.offset - b.offset);

        // 合并：从第一页开始，逐页追加（跳过重叠部分）
        const allSteps = [...firstSteps];
        for (const page of pages) {
            for (let i = 0; i < page.steps.length; i++) {
                const globalIdx = page.offset + i;
                if (globalIdx >= allSteps.length) {
                    allSteps.push(page.steps[i]);
                }
                // globalIdx < allSteps.length → 重叠区域，跳过
            }
        }

        // ===== 串行补缺：保证 100% 完整 =====
        // 如果并行合并后仍不够（步骤特大导致间隔不足），串行拉剩余
        while (allSteps.length < totalSteps) {
            const result = await rpcCall(lsInfo, port, "GetCascadeTrajectorySteps",
                { cascadeId, stepOffset: allSteps.length }, HEAVY_TIMEOUT);
            const steps = result.data?.steps ?? [];
            if (steps.length === 0) break; // LS 没有更多数据了
            allSteps.push(...steps);
        }
        return allSteps;

    } else {
        // ===== 冷路径：不知总步数 → 串行循环 =====
        const allSteps = [...firstSteps];
        while (true) {
            const result = await rpcCall(lsInfo, port, "GetCascadeTrajectorySteps",
                { cascadeId, stepOffset: allSteps.length }, HEAVY_TIMEOUT);
            const steps = result.data?.steps ?? [];
            if (steps.length === 0) break;
            allSteps.push(...steps);
        }
        return allSteps;
    }
}

/**
 * 增量获取新增步骤（从指定 offset 开始）
 */
async function fetchStepsIncremental(
    lsInfo: LsProcessInfo,
    port: number,
    cascadeId: string,
    fromOffset: number
): Promise<any[]> {
    const newSteps: any[] = [];
    let offset = fromOffset;
    while (true) {
        const result = await rpcCall(lsInfo, port, "GetCascadeTrajectorySteps",
            { cascadeId, stepOffset: offset }, HEAVY_TIMEOUT);
        const steps = result.data?.steps ?? [];
        if (steps.length === 0) break; // 唯一的终止条件：返回 0 条
        newSteps.push(...steps);
        offset += steps.length;
        // 注意：不用 steps.length < STEPS_PER_PAGE 判断结束！
        // LS 每页返回量不固定（可能 486/564/85），只有 0 条才是真正结束
    }
    return newSteps;
}

/**
 * 尾部校验：获取缓存末尾区域的当前数据，对比是否一致
 * @returns true=一致（无回溯），false=不一致（发生了回溯）
 */
async function verifyTail(
    lsInfo: LsProcessInfo,
    port: number,
    cascadeId: string,
    cachedSteps: any[],
    verifyCount: number
): Promise<boolean> {
    if (cachedSteps.length === 0) return true;
    const startOffset = Math.max(0, cachedSteps.length - verifyCount);
    const actualCount = cachedSteps.length - startOffset;

    try {
        const result = await rpcCall(lsInfo, port, "GetCascadeTrajectorySteps",
            { cascadeId, stepOffset: startOffset }, LIGHT_TIMEOUT);
        const currentTailSteps = result.data?.steps ?? [];
        if (currentTailSteps.length < actualCount) return false; // 数据量不足，视为不一致

        // 对比每一步的 type 和关键内容
        for (let i = 0; i < actualCount; i++) {
            const cached = cachedSteps[startOffset + i];
            const current = currentTailSteps[i];
            if (!cached || !current) return false;
            if (cached.type !== current.type) return false;
            // 对比用户消息文本（最可靠的变化检测）
            const cachedText = cached.userInput?.items?.[0]?.text ?? cached.plannerResponse?.response ?? "";
            const currentText = current.userInput?.items?.[0]?.text ?? current.plannerResponse?.response ?? "";
            if (cachedText && currentText && cachedText !== currentText) return false;
        }
        return true;
    } catch {
        return false; // 网络错误时保守处理，全量刷新
    }
}

/**
 * 获取指定对话的完整 trajectory 数据
 *
 * v1.6 三步查找策略：
 * Step 1: 父 LS（ppid 直连，0 发现开销）→ 大多数场景直接命中
 * Step 2: 注册表中其他 LS（~5ms）→ 跨窗口对话
 * Step 3: PowerShell 全量发现（极罕见兜底）→ 刚开的窗口未注册时
 *
 * 数据获取策略（在找到 LS 后）：
 * 1. 轻量 check → stepCount 没变 → 用缓存
 * 2. stepCount 变了 → 增量 + 尾部校验
 * 3. 回溯或校验失败 → 并行分页全量重拉
 */
export async function fetchTrajectory(
    cascadeId: string,
    forceRefresh = false
): Promise<{ trajectory: any; fromCache: boolean } | null> {
    const cachePath = getConvCachePath(cascadeId);
    const errors: string[] = [];

    // ===== Step 1: 父 LS（ppid 直连）=====
    if (parentLs) {
        try {
            const result = await fetchFromLs(parentLs.info, parentLs.port, cascadeId, cachePath, forceRefresh);
            if (result) return result;
        } catch (err: any) {
            errors.push(`父LS PID=${parentLs.info.pid}: ${err.message}`);
        }
    }

    // ===== Step 2: 注册表中其他 LS =====
    const registry = readRegistry();
    const parentPidStr = String(process.ppid);
    for (const [pidStr, entry] of Object.entries(registry.processes)) {
        if (pidStr === parentPidStr) continue; // 跳过父 LS（已在 Step 1 查过）

        // 进程存活快速检测（微秒级）
        try { process.kill(parseInt(pidStr, 10), 0); } catch {
            markHeartbeatFailure(pidStr);
            continue;
        }

        // Heartbeat 验证（网络级）
        const lsInfo = entryToLsInfo(entry);
        try {
            const hb = await rpcCall(lsInfo, entry.port, "Heartbeat", {}, 5000);
            if (hb.status !== 200) {
                const shouldRemove = markHeartbeatFailure(pidStr);
                if (shouldRemove) continue;
                continue;
            }
            markHeartbeatSuccess(pidStr);
        } catch {
            markHeartbeatFailure(pidStr);
            continue;
        }

        try {
            const result = await fetchFromLs(lsInfo, entry.port, cascadeId, cachePath, forceRefresh);
            if (result) return result;
        } catch (err: any) {
            errors.push(`注册表 PID=${pidStr}: ${err.message}`);
        }
    }

    // ===== Step 3: PowerShell 全量发现（极罕见兜底）=====
    const freshProcesses = discoverLsProcesses()
        .filter(ls => ls.pid !== process.ppid); // 父 LS 已在 Step 1 查过

    for (const ls of freshProcesses) {
        const port = await findHttpPort(ls);
        if (!port) continue;

        // 顺便注册到注册表
        registerLsEntry({
            pid: ls.pid,
            port,
            csrfToken: ls.csrfToken,
            workspaceId: ls.workspaceId,
            registeredAt: new Date().toISOString(),
        });

        try {
            const result = await fetchFromLs(ls, port, cascadeId, cachePath, forceRefresh);
            if (result) return result;
        } catch (err: any) {
            errors.push(`全量扫描 PID=${ls.pid}: ${err.message}`);
        }
    }

    // 所有步骤都失败
    const totalSearched = (parentLs ? 1 : 0)
        + Object.keys(registry.processes).filter(p => p !== parentPidStr).length
        + freshProcesses.length;
    throw new Error(`无法从任何 LS 获取对话 ${cascadeId}（共尝试 ${totalSearched} 个 LS）：\n${errors.join("\n")}`);
}

/**
 * 从指定 LS 获取对话数据（内部方法）
 * 封装了热列表检查 → 缓存 → 增量/全量 的完整逻辑
 * @returns trajectory 或 null（该 LS 不持有此对话）
 */
async function fetchFromLs(
    lsInfo: LsProcessInfo,
    port: number,
    cascadeId: string,
    cachePath: string,
    forceRefresh: boolean
): Promise<{ trajectory: any; fromCache: boolean } | null> {
    // 检查热列表
    let { stepCount: currentStepCount } = await getStepCountLight(lsInfo, port, cascadeId);

    if (currentStepCount < 0) {
        // 不在热列表，尝试直接拉取（LS 会自动加载 .pb）
        try {
            const allSteps = await fetchAllStepsPaged(lsInfo, port, cascadeId);
            if (allSteps.length > 0) {
                const trajectory = { steps: allSteps };
                saveConvCache(cascadeId, { stepCount: allSteps.length, trajectory });
                return { trajectory, fromCache: false };
            }
        } catch { /* 500 = .pb 不存在 */ }
        return null; // 该 LS 不持有此对话
    }

    // 缓存检查
    if (!forceRefresh && fs.existsSync(cachePath)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
            const cachedStepCount = cached?.stepCount ?? cached?.numTotalSteps ?? 0;
            const cachedSteps = cached?.trajectory?.steps ?? [];

            if (cachedStepCount === currentStepCount && cachedSteps.length > 0) {
                return { trajectory: cached.trajectory, fromCache: true };
            }

            // stepCount 变了 → 智能更新
            if (cachedSteps.length > 0 && currentStepCount > cachedStepCount) {
                const [tailOk, newSteps] = await Promise.all([
                    verifyTail(lsInfo, port, cascadeId, cachedSteps, TAIL_VERIFY_STEPS),
                    fetchStepsIncremental(lsInfo, port, cascadeId, cachedSteps.length),
                ]);

                if (tailOk && newSteps.length > 0) {
                    const mergedSteps = [...cachedSteps, ...newSteps];
                    const trajectory = cached.trajectory;
                    trajectory.steps = mergedSteps;
                    saveConvCache(cascadeId, { stepCount: currentStepCount, trajectory });
                    return { trajectory, fromCache: false };
                }
                // 尾部不一致 → fallthrough 到全量
            }
        } catch { /* cache invalid */ }
    }

    // 全量获取
    const allSteps = await fetchAllStepsPaged(lsInfo, port, cascadeId, currentStepCount);
    if (allSteps.length === 0) return null;

    const trajectory = { steps: allSteps };
    saveConvCache(cascadeId, { stepCount: currentStepCount, trajectory });
    return { trajectory, fromCache: false };
}

/**
 * 轻量级：只拉第一页 steps（用于快速检测工作区，不拉全量数据）
 * 比 fetchTrajectory 快很多（1-3s vs 10-30s）
 */
export async function fetchFirstPageSteps(cascadeId: string): Promise<any[] | null> {
    // 复用 fetchTrajectory 的多 LS 查找策略，但只拉第一页

    // 尝试从单个 LS 拉第一页
    const tryLs = async (info: LsProcessInfo, port: number): Promise<any[] | null> => {
        try {
            const result = await rpcCall(info, port, "GetCascadeTrajectorySteps",
                { cascadeId, stepOffset: 0 }, 10000);
            const steps = result.data?.steps ?? [];
            return steps.length > 0 ? steps : null;
        } catch { return null; }
    };

    // Step 1: 父 LS
    if (parentLs) {
        const steps = await tryLs(parentLs.info, parentLs.port);
        if (steps) return steps;
    }

    // Step 2: 注册表中其他 LS
    const registry = readRegistry();
    for (const [pidStr, entry] of Object.entries(registry.processes)) {
        if (pidStr === String(process.ppid)) continue;
        try { process.kill(parseInt(pidStr, 10), 0); } catch { continue; }
        const lsInfo = entryToLsInfo(entry);
        const steps = await tryLs(lsInfo, entry.port);
        if (steps) return steps;
    }

    return null; // 不走 PowerShell 兜底（太慢，预扫描要求快）
}

// ===== 辅助 =====

const CONV_CACHE_DIR = path.join(os.homedir(), ".gemini", "antigravity", "memory-store", "temp");

function getConvCachePath(cascadeId: string): string {
    const safeId = cascadeId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
    return path.join(CONV_CACHE_DIR, `conv_${safeId}.json`);
}

function saveConvCache(cascadeId: string, data: any): void {
    try {
        if (!fs.existsSync(CONV_CACHE_DIR)) {
            fs.mkdirSync(CONV_CACHE_DIR, { recursive: true });
        }
        fs.writeFileSync(getConvCachePath(cascadeId), JSON.stringify(data), "utf-8");
    } catch { /* non-critical */ }
}

/**
 * 获取当前对话的 cascadeId
 * v1.6: 从父 LS 热列表获取（精确），兜底用 .pb 修改时间猜测
 */
export async function getCurrentCascadeId(): Promise<string | null> {
    // 优先从父 LS 热列表获取
    if (parentLs) {
        try {
            const result = await rpcCall(parentLs.info, parentLs.port, "GetAllCascadeTrajectories", {}, LIGHT_TIMEOUT);
            const summaries = result.data?.trajectorySummaries;
            if (summaries && typeof summaries === "object") {
                let latest: { id: string; time: string } | null = null;
                for (const [id, info] of Object.entries(summaries)) {
                    const t = (info as any).lastModifiedTime;
                    if (!latest || t > latest.time) {
                        latest = { id, time: t };
                    }
                }
                if (latest) return latest.id;
            }
        } catch { /* fallback to .pb guessing */ }
    }

    const fallbackLs = await findFallbackLsConnection();
    if (fallbackLs) {
        try {
            const result = await rpcCall(fallbackLs.info, fallbackLs.port, "GetAllCascadeTrajectories", {}, LIGHT_TIMEOUT);
            const summaries = result.data?.trajectorySummaries;
            if (summaries && typeof summaries === "object") {
                let latest: { id: string; time: string } | null = null;
                for (const [id, info] of Object.entries(summaries)) {
                    const t = (info as any).lastModifiedTime;
                    if (!latest || t > latest.time) {
                        latest = { id, time: t };
                    }
                }
                if (latest) return latest.id;
            }
        } catch { /* fallback to .pb guessing */ }
    }

    // 兜底：.pb 修改时间猜测
    return guessFromPb();
}

/** .pb 修改时间猜测（旧逻辑，作为兜底） */
function guessFromPb(): string | null {
    const convDir = path.join(os.homedir(), ".gemini", "antigravity", "conversations");
    if (!fs.existsSync(convDir)) return null;
    try {
        const files = fs.readdirSync(convDir)
            .filter(f => f.endsWith(".pb"))
            .map(f => ({
                id: f.replace(".pb", ""),
                mtime: fs.statSync(path.join(convDir, f)).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);
        return files.length > 0 ? files[0].id : null;
    } catch {
        return null;
    }
}

async function findFallbackLsConnection(): Promise<ParentLsConnection | null> {
    const registry = readRegistry();
    const parentPidStr = String(process.ppid);

    for (const [pidStr, entry] of Object.entries(registry.processes)) {
        if (pidStr === parentPidStr) continue;
        try {
            process.kill(parseInt(pidStr, 10), 0);
        } catch {
            markHeartbeatFailure(pidStr);
            continue;
        }

        const lsInfo = entryToLsInfo(entry);
        try {
            const hb = await rpcCall(lsInfo, entry.port, "Heartbeat", {}, 5000);
            if (hb.status === 200) {
                markHeartbeatSuccess(pidStr);
                return { info: lsInfo, port: entry.port };
            }
            markHeartbeatFailure(pidStr);
        } catch {
            markHeartbeatFailure(pidStr);
        }
    }

    const freshProcesses = discoverLsProcesses();
    for (const ls of freshProcesses) {
        const port = await findHttpPort(ls);
        if (!port) continue;
        registerLsEntry({
            pid: ls.pid,
            port,
            csrfToken: ls.csrfToken,
            workspaceId: ls.workspaceId,
            registeredAt: new Date().toISOString(),
        });
        return { info: ls, port };
    }

    return null;
}

/**
 * 列出所有可获取的对话 ID（从 conversations 目录）
 */
export function listConversationIds(): string[] {
    const convDir = path.join(os.homedir(), ".gemini", "antigravity", "conversations");
    if (!fs.existsSync(convDir)) return [];
    try {
        return fs.readdirSync(convDir)
            .filter(f => f.endsWith(".pb"))
            .map(f => f.replace(".pb", ""));
    } catch {
        return [];
    }
}

/**
 * 从 state.vscdb 读取有效对话标题（调用 Python 脚本）
 * 返回 Map<conversationId, { summary, steps }>
 */
let _vscdbCache: { data: Map<string, { summary: string; steps: number | null }>; ts: number } | null = null;
const VSCDB_CACHE_TTL = 120_000; // 2 分钟缓存

export function readVscdbTitles(): Map<string, { summary: string; steps: number | null }> {
    const now = Date.now();
    if (_vscdbCache && now - _vscdbCache.ts < VSCDB_CACHE_TTL) return _vscdbCache.data;

    const result = new Map<string, { summary: string; steps: number | null }>();
    try {
        const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..", "scripts", "read_vscdb_titles.py");
        if (!fs.existsSync(scriptPath)) return result;

        // execFileSync 已在文件头 import
        const stdout = execFileSync("python", [scriptPath], {
            encoding: "utf-8", timeout: 8000, windowsHide: true,
        });
        if (stdout.trim()) {
            const parsed = JSON.parse(stdout.trim());
            for (const [uuid, info] of Object.entries(parsed)) {
                const { s: summary, c: steps } = info as any;
                result.set(uuid, { summary, steps: steps ?? null });
            }
        }
    } catch { /* silent */ }
    _vscdbCache = { data: result, ts: now };
    return result;
}

/**
 * 列出对话，带 mtime 筛选 + vscdb 有效性验证（用于批量 Record 更新）
 */
export function listConversationsByMtime(opts: {
    after?: string;
    before?: string;
    minSizeKB?: number;
    limit?: number;
}): { id: string; mtime: Date; sizeKB: number; title?: string }[] {
    const convDir = path.join(os.homedir(), ".gemini", "antigravity", "conversations");
    if (!fs.existsSync(convDir)) return [];
    try {
        const afterMs = opts.after ? new Date(opts.after).getTime() : 0;
        const beforeMs = opts.before ? new Date(opts.before).getTime() : Infinity;
        const minSize = (opts.minSizeKB || 10) * 1024;

        // 读取 vscdb 有效对话集合
        const vscdbTitles = readVscdbTitles();

        const entries = fs.readdirSync(convDir)
            .filter(f => f.endsWith(".pb"))
            .map(f => {
                const id = f.replace(".pb", "");
                const stat = fs.statSync(path.join(convDir, f));
                const vscInfo = vscdbTitles.get(id);
                return { id, mtime: stat.mtime, sizeKB: stat.size / 1024, title: vscInfo?.summary };
            })
            .filter(e => e.mtime.getTime() >= afterMs && e.mtime.getTime() <= beforeMs)
            .filter(e => e.sizeKB * 1024 >= minSize)
            // vscdb 有效性过滤：只保留 vscdb 中有记录的对话
            .filter(e => vscdbTitles.has(e.id))
            .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

        return entries.slice(0, opts.limit || 10);
    } catch {
        return [];
    }
}

/**
 * 从已拉取的 steps 数据中提取 workspaceUri
 * 扫描所有 USER_INPUT step 的 activeUserState.openDocuments[].workspaceUri
 * 返回去 URI 化后的本地路径，如 "c:/Users/you/Desktop/project"
 */
export function detectWorkspaceFromSteps(steps: any[]): string | null {
    for (const step of steps) {
        const docs = step?.userInput?.activeUserState?.openDocuments;
        if (!Array.isArray(docs)) continue;
        for (const doc of docs) {
            const ws = doc?.workspaceUri;
            if (typeof ws === "string" && ws.startsWith("file:///")) {
                // file:///c:/Users/... → c:/Users/...
                const decoded = decodeURIComponent(ws.replace("file:///", ""));
                if (decoded && decoded.length > 3) return decoded;
            }
        }
    }
    return null;
}

// ===== v1.5+ Auto Summary / LS API =====

/**
 * 检查 LS 是否可用于 AI 摘要功能
 * v1.6: 直接检查 parentLs
 */
export async function isLsAvailable(): Promise<boolean> {
    if (parentLs) return true;

    try {
        const lsInfo = discoverParentLs();
        if (lsInfo) {
            const port = await findHttpPort(lsInfo);
            if (port !== null) return true;
        }
        const fallback = await findFallbackLsConnection();
        return fallback !== null;
    } catch {
        return false;
    }
}

/**
 * 调用 LS GetModelResponse 生成 AI 回复
 * v1.6: 直接用 parentLs，不走全量发现
 * v1.8: 支持自定义超时（Record 等大 prompt 场景需要 120s）
 */
export function getLsModelCandidates(model: string): string[] {
    const candidates = [model];
    const fallbacks = (process.env.MEMORY_STORE_LS_MODEL_FALLBACKS || DEFAULT_ANTIGRAVITY_LS_MODEL_FALLBACKS.join(","))
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    for (const fallback of fallbacks) {
        if (!candidates.includes(fallback)) candidates.push(fallback);
    }
    return candidates;
}

async function callGetModelResponseOn(
    info: LsProcessInfo,
    port: number,
    model: string,
    prompt: string,
    timeout: number
): Promise<string | null> {
    for (const candidate of getLsModelCandidates(model)) {
        const result = await rpcCall(info, port, "GetModelResponse", {
            model: candidate,
            prompt,
        }, timeout);
        const text = result.data?.response ?? null;
        if (text) {
            if (candidate !== model) {
                console.error(`[ls-client] GetModelResponse model fallback: ${model} -> ${candidate}`);
            }
            return text;
        }
    }
    return null;
}

export async function callGetModelResponse(model: string, prompt: string, timeoutMs?: number): Promise<string | null> {
    const timeout = timeoutMs || LIGHT_TIMEOUT;
    try {
        if (parentLs) {
            return await callGetModelResponseOn(parentLs.info, parentLs.port, model, prompt, timeout);
        }

        // parentLs 未初始化时降级
        const lsInfo = discoverParentLs();
        if (lsInfo) {
            const port = await findHttpPort(lsInfo);
            if (port) {
                return await callGetModelResponseOn(lsInfo, port, model, prompt, timeout);
            }
        }

        const fallback = await findFallbackLsConnection();
        if (!fallback) return null;
        return await callGetModelResponseOn(fallback.info, fallback.port, model, prompt, timeout);
    } catch {
        return null;
    }
}
