import { execSync, execFileSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";
import {
    registerLsEntry,
    cleanDeadEntries,
} from "./ls-registry.js";
import { DEFAULT_ANTIGRAVITY_LS_MODEL_FALLBACKS } from "./ls-model-defaults.js";
import {
    type LsProcessInfo,
    rpcCall,
    findHttpPort,
    getStepCountLight,
    HEAVY_TIMEOUT,
    LIGHT_TIMEOUT,
} from "./ls-rpc.js";
import {
    resolveEndpointForConversation,
    enumerateActiveLs,
    rememberMapping,
    invalidateMapping,
    getCurrentContext,
    type RouterEndpoint,
} from "./conversation-router.js";

export type { LsProcessInfo } from "./ls-rpc.js";

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
// LsProcessInfo / RpcResult / rpcCall / findHttpPort / getStepCountLight /
// HEAVY_TIMEOUT / LIGHT_TIMEOUT 已抽到 ls-rpc.ts（见蓝图步骤 1），此处 import 复用。

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
let lsDisabledForTest = false;

/**
 * 测试专用：完全禁用 LS 发现路径，使 isLsAvailable() 返回 false。
 * 与 __setParentLsForTest(null) 不同，此函数阻止 discoverParentLs 重新发现真实 LS。
 */
export function __disableLsForTest(): void {
    lsDisabledForTest = true;
    parentLs = null;
    parentLsInitDone = true;
}

/**
 * 获取已缓存的父 LS 连接（未就绪返回 null）
 */
export function getParentLs(): ParentLsConnection | null {
    return parentLs;
}

/**
 * 测试专用：直接注入/清空父 LS 连接，使模型调用走指定连接而不触发注册表/PowerShell 发现。
 * 仅供单测构造确定性场景（如 fake LS server）使用，生产代码不调用。
 */
export function __setParentLsForTest(conn: ParentLsConnection | null): void {
    parentLs = conn;
    parentLsInitDone = conn !== null;
    if (conn === null) lsDisabledForTest = false;
}

/**
 * 测试专用：复位全部 LS 测试覆盖状态（lsDisabledForTest、parentLs、init 标志）。
 * 在 finally 块中调用此函数可确保后续同进程用例不受残留影响。
 */
export function __resetLsTestOverridesForTest(): void {
    lsDisabledForTest = false;
    parentLs = null;
    parentLsInitDone = false;
    parentLsInitPromise = null;
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
/** 测试注入的 LS 进程发现替身（null=用真实 PowerShell 扫描）。生产代码不调用。 */
let lsDiscoveryOverride: (() => LsProcessInfo[]) | null = null;

/**
 * 测试专用：注入 discoverLsProcesses 替身，让 conversation-router 的 PowerShell 兜底分支
 * 可离线触发（不真跑 PowerShell）。传 null 还原真实扫描。生产代码不调用。
 */
export function __setLsDiscoveryForTest(fn: (() => LsProcessInfo[]) | null): void {
    lsDiscoveryOverride = fn;
}

export function discoverLsProcesses(): LsProcessInfo[] {
    if (lsDiscoveryOverride) return lsDiscoveryOverride();
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

// ===== 对话数据获取 =====
// rpcCall / findHttpPort / getStepCountLight / HEAVY_TIMEOUT / LIGHT_TIMEOUT
// 已抽到 ls-rpc.ts（见蓝图步骤 1）。

/** 尾部校验步数（用于检测回溯） */
const TAIL_VERIFY_STEPS = 30;

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
 * 获取指定对话的完整 trajectory 数据（薄壳化，见蓝图步骤 5）
 *
 * Phase 0（保留，单反重力 / 非 broker 回归快路径）：父 LS（ppid 直连）先试，
 *   命中持有则直接拉数据（开销≈直连），命中后顺手 rememberMapping（纯内存写）。
 * Phase 1（broker / 多 LS）：交给路由大脑 resolveEndpointForConversation：
 *   映射命中再确认（快路径）/ 枚举活跃 LS 并发广播 holds 取真持有者（慢路径，永不连错）。
 *   拿到 endpoint + 权威 stepCount → fetchFromLs（endpoint 指纹 + 权威 stepCount 缓存复核，方案 C）。
 */
export async function fetchTrajectory(
    cascadeId: string,
    forceRefresh = false
): Promise<{ trajectory: any; fromCache: boolean } | null> {
    const cachePath = getConvCachePath(cascadeId);
    const errors: string[] = [];

    // ===== Phase 0: 父 LS（ppid 直连，单反重力 / 非 broker 回归快路径）=====
    if (parentLs) {
        const pls = parentLs;
        try {
            // 持有性校验：父 LS 确实持有此对话才走直连（避免对错对话误命中父 LS）
            const { stepCount } = await getStepCountLight(pls.info, pls.port, cascadeId);
            if (stepCount >= 0) {
                const result = await fetchFromLs(pls.info, pls.port, cascadeId, cachePath, forceRefresh, stepCount);
                if (result) {
                    // L1 修复：命中后写映射用真 transport（rpcCall），后续重读走快路径能真加速；
                    // 旧 placeholder reject 会让快路径每次 holds 必失败→失效落慢路径，等于死映射。
                    rememberMapping(cascadeId, "antigravity", {
                        kind: "antigravity",
                        pid: pls.info.pid,
                        port: pls.port,
                        csrfToken: pls.info.csrfToken,
                        workspaceId: pls.info.workspaceId,
                        key: `antigravity:${pls.info.pid}:${pls.port}`,
                        transport: (method, payload = {}, options = LIGHT_TIMEOUT) => {
                            const timeoutMs = typeof options === "number" ? options : options.timeoutMs ?? LIGHT_TIMEOUT;
                            return rpcCall(pls.info, pls.port, method, payload, timeoutMs).then(r => {
                                if (r.status < 200 || r.status >= 300) throw new Error(`antigravity rpc ${method} status ${r.status}`);
                                return r.data;
                            });
                        },
                    }, stepCount);
                    return result;
                }
            }
        } catch (err: any) {
            errors.push(`父LS PID=${pls.info.pid}: ${err.message}`);
        }
    }

    // ===== Phase 1: 路由大脑（broker / 多 LS，持有性广播，永不连错）=====
    let probedCount = 0;
    try {
        const resolved = await resolveEndpointForConversation(cascadeId, "antigravity");
        probedCount = resolved.probedCount;
        if (resolved.endpoint) {
            const ep = resolved.endpoint;
            // RouterEndpoint 平铺为 fetchFromLs 需要的 lsInfo,port（见蓝图 §7-D 裁决）。
            const lsInfo: LsProcessInfo = {
                pid: ep.pid,
                csrfToken: ep.csrfToken,
                workspaceId: ep.workspaceId ?? "",
                ports: [ep.port],
            };
            try {
                const result = await fetchFromLs(lsInfo, ep.port, cascadeId, cachePath, forceRefresh, resolved.stepCount);
                if (result) return result;
                // 持有者读不出数据（极罕见）→ 剔除映射避免下次再粘
                invalidateMapping(cascadeId, "antigravity");
            } catch (err: any) {
                invalidateMapping(cascadeId, "antigravity");
                errors.push(`持有者 PID=${ep.pid}: ${err.message}`);
            }
        } else if (resolved.reason === "no_ls") {
            errors.push("无活跃反重力 LS");
        } else {
            errors.push("活跃反重力 LS 均不持有热列表");
        }
    } catch (err: any) {
        errors.push(`路由解析失败: ${err.message}`);
    }

    // ===== Phase 2: .pb 历史兜底（恢复 EP-X 前的历史对话读取能力）=====
    // 活跃 LS 的热列表都不持有此 cascadeId（典型场景：窗口已关闭的历史对话），但磁盘 .pb 文件可能仍在。
    // 任意活跃 LS 都能按需加载 .pb（fetchFromLs 内 stepCount<0 → fetchAllStepsPaged 触发 LS 加载 .pb）。
    // 遍历活跃 LS 逐个尝试，任一拉到即返回。多窗口正常路径不受影响（真持有者已在 Phase 1 命中返回，不会走到这里）。
    try {
        const activeLs = await enumerateActiveLs("antigravity");
        for (const ep of activeLs) {
            const lsInfo: LsProcessInfo = { pid: ep.pid, csrfToken: ep.csrfToken, workspaceId: ep.workspaceId ?? "", ports: [ep.port] };
            try {
                const result = await fetchFromLs(lsInfo, ep.port, cascadeId, cachePath, forceRefresh);
                if (result) return result;
            } catch (err: any) {
                errors.push(`.pb 兜底 PID=${ep.pid}: ${err.message}`);
            }
        }
    } catch (err: any) {
        errors.push(`.pb 兜底枚举失败: ${err.message}`);
    }

    // 所有步骤都失败（活跃 LS 都不持有热列表，且 .pb 也拉不到 → 对话确实不可达）
    throw new Error(`无法从任何 LS 获取对话 ${cascadeId}（路由广播探测 ${probedCount} 个 LS + .pb 兜底）：\n${errors.join("\n")}`);
}

/**
 * 从指定 LS 获取对话数据（内部方法）
 * 封装了热列表检查 → 缓存 → 增量/全量 的完整逻辑
 *
 * 方案 C（见蓝图 §3.3）：缓存复核加 endpoint 指纹。
 *   complete三连（全满足才直接信缓存）：
 *     ① cachedStepCount === currentStepCount  ② cachedSteps.length > 0  ③ cachedEndpoint === thisEndpoint
 *   若 ②满足但 endpoint 不一致 → 强制 verifyTail 二次确认后才返并刷指纹。
 *   新增显式分支 currentStepCount < cachedStepCount → 强制全量（旧代码无此分支）。
 *   currentStepCount 此刻保证来自路由大脑确认的真持有者，②号失败路径根因消除。
 *
 * @param knownStepCount 路由大脑广播已拿到时复用，省一次 getStepCountLight。
 * @returns trajectory 或 null（该 LS 不持有此对话）
 */
async function fetchFromLs(
    lsInfo: LsProcessInfo,
    port: number,
    cascadeId: string,
    cachePath: string,
    forceRefresh: boolean,
    knownStepCount?: number,
): Promise<{ trajectory: any; fromCache: boolean } | null> {
    // 本次 endpoint 指纹（写入者身份）
    const thisEndpoint = `${lsInfo.pid}:${port}`;

    // 检查热列表（复用路由大脑已拿到的权威 stepCount，省一次 RPC）
    let currentStepCount: number;
    if (typeof knownStepCount === "number") {
        currentStepCount = knownStepCount;
    } else {
        ({ stepCount: currentStepCount } = await getStepCountLight(lsInfo, port, cascadeId));
    }

    if (currentStepCount < 0) {
        // 不在热列表，尝试直接拉取（LS 会自动加载 .pb）
        try {
            const allSteps = await fetchAllStepsPaged(lsInfo, port, cascadeId);
            if (allSteps.length > 0) {
                const trajectory = { steps: allSteps };
                saveConvCache(cascadeId, { stepCount: allSteps.length, trajectory, endpoint: thisEndpoint });
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
            const cachedEndpoint = typeof cached?.endpoint === "string" ? cached.endpoint : "";
            const sameEndpoint = cachedEndpoint === thisEndpoint;

            if (cachedStepCount === currentStepCount && cachedSteps.length > 0) {
                if (sameEndpoint) {
                    // ①②③ 全满足，同源直接返缓存
                    return { trajectory: cached.trajectory, fromCache: true };
                }
                // ②满足但 endpoint 不一致（跨端点 / 老缓存无指纹）→ 强制 verifyTail 二次确认。
                const tailOk = await verifyTail(lsInfo, port, cascadeId, cachedSteps, TAIL_VERIFY_STEPS);
                if (tailOk) {
                    // 确认一致 → 返缓存并刷指纹（补写 endpoint）
                    saveConvCache(cascadeId, { stepCount: currentStepCount, trajectory: cached.trajectory, endpoint: thisEndpoint });
                    return { trajectory: cached.trajectory, fromCache: true };
                }
                // 尾部不一致 → fallthrough 到全量
            } else if (cachedSteps.length > 0 && currentStepCount < cachedStepCount) {
                // 新增显式分支：真持有者步数比缓存还少（回溯 / 缓存来自别的更长对话）→ 强制全量，不信缓存。
                // fallthrough 到全量
            } else if (cachedSteps.length > 0 && currentStepCount > cachedStepCount) {
                // stepCount 增长 → 智能增量更新
                const [tailOk, newSteps] = await Promise.all([
                    verifyTail(lsInfo, port, cascadeId, cachedSteps, TAIL_VERIFY_STEPS),
                    fetchStepsIncremental(lsInfo, port, cascadeId, cachedSteps.length),
                ]);

                if (tailOk && newSteps.length > 0) {
                    const mergedSteps = [...cachedSteps, ...newSteps];
                    const trajectory = cached.trajectory;
                    trajectory.steps = mergedSteps;
                    saveConvCache(cascadeId, { stepCount: currentStepCount, trajectory, endpoint: thisEndpoint });
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
    saveConvCache(cascadeId, { stepCount: currentStepCount, trajectory, endpoint: thisEndpoint });
    return { trajectory, fromCache: false };
}

/**
 * 轻量级：只拉第一页 steps（用于快速检测工作区，不拉全量数据）
 * 比 fetchTrajectory 快很多（1-3s vs 10-30s）
 */
export async function fetchFirstPageSteps(cascadeId: string): Promise<any[] | null> {
    // 尝试从单个 LS 拉第一页
    const tryLs = async (info: LsProcessInfo, port: number): Promise<any[] | null> => {
        try {
            const result = await rpcCall(info, port, "GetCascadeTrajectorySteps",
                { cascadeId, stepOffset: 0 }, 10000);
            const steps = result.data?.steps ?? [];
            return steps.length > 0 ? steps : null;
        } catch { return null; }
    };

    // Phase 0: 父 LS（直连快路径）
    if (parentLs) {
        const steps = await tryLs(parentLs.info, parentLs.port);
        if (steps) return steps;
    }

    // Phase 1: 路由大脑解析真持有者（只拉第一页，命中即返）
    try {
        const resolved = await resolveEndpointForConversation(cascadeId, "antigravity");
        if (resolved.endpoint) {
            const ep = resolved.endpoint;
            const steps = await tryLs(
                { pid: ep.pid, csrfToken: ep.csrfToken, workspaceId: ep.workspaceId ?? "", ports: [ep.port] },
                ep.port,
            );
            if (steps) return steps;
        }
    } catch { /* swallow，预扫描要求快，失败返 null */ }

    return null; // 不走 PowerShell 兜底（太慢，预扫描要求快）
}

// ===== 辅助 =====

const CONV_CACHE_DIR = path.join(
    process.env.MEMORY_STORE_DATA_ROOT
        || path.join(process.env.CODEX_TOOLKIT_DATA_ROOT || path.join(os.homedir(), ".codex-toolkit"), "memory-store"),
    "temp",
);

/** 测试注入的缓存目录覆盖（null=用真实目录） */
let convCacheDirOverride: string | null = null;

/**
 * 测试专用：覆盖对话缓存目录（避免污染真实 temp 目录、可控构造 stale 缓存）。
 * 传 null 还原真实目录。生产代码不调用。
 */
export function __setConvCacheDirForTest(dir: string | null): void {
    convCacheDirOverride = dir;
}

function convCacheDir(): string {
    return convCacheDirOverride ?? CONV_CACHE_DIR;
}

function getConvCachePath(cascadeId: string): string {
    const safeId = cascadeId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
    return path.join(convCacheDir(), `conv_${safeId}.json`);
}

function saveConvCache(cascadeId: string, data: any): void {
    try {
        const dir = convCacheDir();
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(getConvCachePath(cascadeId), JSON.stringify(data), "utf-8");
    } catch { /* non-critical */ }
}

/**
 * 从一个 LS 的热列表中取「最新」对话 id（合并旧 751-767/770-785 两段重复逻辑）。
 * @returns 该 LS 上 lastModifiedTime 最大的 cascadeId，无则 null
 */
async function latestCascadeOn(info: LsProcessInfo, port: number): Promise<string | null> {
    try {
        const result = await rpcCall(info, port, "GetAllCascadeTrajectories", {}, LIGHT_TIMEOUT);
        const summaries = result.data?.trajectorySummaries;
        if (summaries && typeof summaries === "object") {
            // M2 修复：lastModifiedTime 是 protobuf Timestamp JSON（整秒 ...09Z / 小数秒 ...09.300Z 宽度不一），
            // 字典序里 '.'(0x2E) < 'Z'(0x5A) 会把带小数秒的「真更新」误判为更旧。统一用 Date.parse 数值比。
            let latest: { id: string; ms: number } | null = null;
            for (const [id, sInfo] of Object.entries(summaries)) {
                const ms = Date.parse((sInfo as any).lastModifiedTime || "") || 0;
                if (!latest || ms > latest.ms) {
                    latest = { id, ms };
                }
            }
            if (latest) return latest.id;
        }
    } catch { /* swallow */ }
    return null;
}

/**
 * 方案 D 增强（最后兜底分支）：当 conversationId / workspaceId 指纹都缺时，
 * 用 workspaceRoot 反查——多拉一页 step 比对 detectWorkspaceFromSteps。
 * 接口 + 实现一并落地（见蓝图 §4 注），仅在指纹都缺时被调用。
 * @returns 工作区根匹配的 cascadeId，无则 null
 */
async function matchByWorkspaceRoot(
    endpoints: RouterEndpoint[],
    workspaceRoot: string,
): Promise<string | null> {
    const target = workspaceRoot.replace(/[\\/]+$/u, "").toLowerCase();
    if (!target) return null;

    for (const ep of endpoints) {
        const info: LsProcessInfo = {
            pid: ep.pid,
            csrfToken: ep.csrfToken,
            workspaceId: ep.workspaceId ?? "",
            ports: [ep.port],
        };
        // 取该 LS 上按时间排序的候选，逐个拉第一页 step 比对工作区
        let summaries: Record<string, any> | null = null;
        try {
            const result = await rpcCall(info, ep.port, "GetAllCascadeTrajectories", {}, LIGHT_TIMEOUT);
            const s = result.data?.trajectorySummaries;
            if (s && typeof s === "object") summaries = s as Record<string, any>;
        } catch { continue; }
        if (!summaries) continue;

        const ids = Object.entries(summaries)
            // M2 修复：同 latestCascadeOn，用 Date.parse 数值比，避免小数秒宽度不一致的字典序错排。
            .sort(([, a], [, b]) => (Date.parse(String((b as any).lastModifiedTime || "")) || 0) - (Date.parse(String((a as any).lastModifiedTime || "")) || 0))
            .map(([id]) => id);

        for (const id of ids) {
            try {
                const stepResult = await rpcCall(info, ep.port, "GetCascadeTrajectorySteps",
                    { cascadeId: id, stepOffset: 0 }, LIGHT_TIMEOUT);
                const steps = stepResult.data?.steps ?? [];
                const ws = detectWorkspaceFromSteps(steps);
                if (ws && ws.replace(/[\\/]+$/u, "").toLowerCase() === target) {
                    return id;
                }
            } catch { /* try next id */ }
        }
    }
    return null;
}

/**
 * 获取当前对话的 cascadeId（方案 D：先用 ctx 指纹，杜绝「连第一个 LS 取全局最新」）。
 *
 * 顺序：
 *   1. ctx.conversationId 锚点（最准）→ 直接返回。
 *   2. ctx.workspaceId 指纹 → 在 enumerateActiveLs 里挑对应 workspaceId 的 LS，只在它内部取最新。
 *   3. parentLs 直连（非 broker 单窗口仍精确）。
 *   4. ctx.workspaceRoot 反查（matchByWorkspaceRoot，最后增强分支）。
 *   5. 指纹全缺 → 显式 ambiguous 告警后退化（取活跃 LS 全局最新），不静默猜。
 *   6. 无 LS → .pb 修改时间猜测兜底。
 */
export async function getCurrentCascadeId(): Promise<string | null> {
    const ctx = getCurrentContext();

    // 1. conversationId 锚点（最准）
    if (ctx.conversationId) return ctx.conversationId;

    // 2. workspaceId 指纹：挑对应 LS 内取最新
    let endpoints: RouterEndpoint[] = [];
    try {
        endpoints = await enumerateActiveLs("antigravity");
    } catch { endpoints = []; }

    if (ctx.workspaceId) {
        const match = endpoints.find(ep => ep.workspaceId && ep.workspaceId === ctx.workspaceId);
        if (match) {
            const id = await latestCascadeOn(
                { pid: match.pid, csrfToken: match.csrfToken, workspaceId: match.workspaceId ?? "", ports: [match.port] },
                match.port,
            );
            if (id) return id;
        }
    }

    // 3. parentLs 直连（非 broker 单窗口精确）
    if (parentLs) {
        const id = await latestCascadeOn(parentLs.info, parentLs.port);
        if (id) return id;
    }

    // 4. workspaceRoot 反查（最后增强分支）
    if (ctx.workspaceRoot && endpoints.length > 0) {
        const id = await matchByWorkspaceRoot(endpoints, ctx.workspaceRoot);
        if (id) return id;
    }

    // 5. 指纹全缺 → 显式告警后退化取全局最新（不静默猜）
    if (endpoints.length > 0) {
        if (!ctx.conversationId && !ctx.workspaceId && !ctx.workspaceRoot) {
            console.error("[ls-client] getCurrentCascadeId: 当前上下文无 conversationId/workspaceId/workspaceRoot 指纹，"
                + "多窗口下无法精确绑定当前对话，退化为取活跃 LS 的全局最新（可能不是你正在看的窗口）。");
        }
        let best: { id: string; ms: number } | null = null;
        for (const ep of endpoints) {
            const info: LsProcessInfo = { pid: ep.pid, csrfToken: ep.csrfToken, workspaceId: ep.workspaceId ?? "", ports: [ep.port] };
            try {
                const result = await rpcCall(info, ep.port, "GetAllCascadeTrajectories", {}, LIGHT_TIMEOUT);
                const summaries = result.data?.trajectorySummaries;
                if (summaries && typeof summaries === "object") {
                    for (const [id, sInfo] of Object.entries(summaries)) {
                        // M2 修复：Date.parse 数值比，避免小数秒字典序错排。
                        const ms = Date.parse(String((sInfo as any).lastModifiedTime || "")) || 0;
                        if (!best || ms > best.ms) best = { id, ms };
                    }
                }
            } catch { /* try next */ }
        }
        if (best) return best.id;
    }

    // 6. 兜底：.pb 修改时间猜测
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

/**
 * 找一个可用的反重力 LS 连接（不要求持有特定对话，用于可用性探测 / 模型调用降级）。
 * 改用路由大脑 enumerateActiveLs（指纹优先，含注册表 + PowerShell 兜底 + Heartbeat 校验）。
 */
async function findFallbackLsConnection(): Promise<ParentLsConnection | null> {
    let endpoints: RouterEndpoint[] = [];
    try {
        endpoints = await enumerateActiveLs("antigravity");
    } catch { return null; }
    if (endpoints.length === 0) return null;
    const ep = endpoints[0];
    return {
        info: { pid: ep.pid, csrfToken: ep.csrfToken, workspaceId: ep.workspaceId ?? "", ports: [ep.port] },
        port: ep.port,
    };
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
 * 返回去 URI 化后的本地路径，如 "c:/workspace/project"
 */
export function detectWorkspaceFromSteps(steps: any[]): string | null {
    for (const step of steps) {
        const docs = step?.userInput?.activeUserState?.openDocuments;
        if (!Array.isArray(docs)) continue;
        for (const doc of docs) {
            const ws = doc?.workspaceUri;
            if (typeof ws === "string" && ws.startsWith("file:///")) {
                // file:///c:/workspace/... → c:/workspace/...
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
    if (lsDisabledForTest) return false;
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

/** 结构化模型调用结果，透传真超时信号（区别于普通失败）。 */
export interface LsModelResult {
    text: string | null;
    error?: string;
    /** true 仅表示「真超时」（wall-clock 兜底或 socket inactivity 超时）；
     *  连接被拒 / 进程死 / 空响应等普通失败一律 false，仍可由上层重试或换候选。 */
    timedOut?: boolean;
}

/** 哨兵错误：wall-clock 兜底超时（区别于 socket "Request timeout"）。 */
const LS_WALL_CLOCK_TIMEOUT = Symbol("ls-wall-clock-timeout");

/** 判定一个错误是否属于「真超时」。
 *  真超时来源有二：① 本层 wall-clock 兜底（LS_WALL_CLOCK_TIMEOUT 哨兵）；
 *  ② httpPost 的 socket inactivity 超时（reject Error("Request timeout")）。
 *  连接被拒（ECONNREFUSED）、进程死、解析失败等都不算超时。 */
function isTimeoutError(err: unknown): boolean {
    if (err === LS_WALL_CLOCK_TIMEOUT) return true;
    const message = err instanceof Error ? err.message : String(err ?? "");
    // 仅匹配 httpPost 显式抛出的超时文案，避免把含 "timeout" 的其它错误误判成真超时。
    return /^Request timeout$/u.test(message);
}

/**
 * 给一个 Promise 套上 wall-clock 超时兜底。
 * socket inactivity 超时（httpPost 内的 req.timeout）在「连接活着但 LS 长时间不返回」时
 * 不一定可靠触发（TCP keep-alive / 偶发数据会重置计时器），故在此再叠一层确定性 wall-clock 超时，
 * 保证 timeoutMs 到点后必定以「真超时」收口，不会无限挂起、也不会把超时误压成普通失败。
 */
function withWallClockTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(LS_WALL_CLOCK_TIMEOUT);
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

/**
 * 结构化版：返回 {text, error, timedOut}，把「真超时」与「普通失败」区分开。
 * v1.16 (C2)：新增此 detailed 版，旧版 callGetModelResponse 委托本函数（只取 text），
 * 避免破坏现有 caller。上层（model-bridge）应优先用本函数以拿到 timedOut 信号。
 */
export async function callGetModelResponseDetailed(
    model: string,
    prompt: string,
    timeoutMs?: number,
): Promise<LsModelResult> {
    const timeout = timeoutMs || LIGHT_TIMEOUT;
    try {
        const text = await withWallClockTimeout((async () => {
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
        })(), timeout);

        if (text) return { text };
        // 模型返回空：普通失败（非超时），上层可重试 / 换候选。
        return { text: null, error: "Antigravity LS 模型返回为空", timedOut: false };
    } catch (err: any) {
        const timedOut = isTimeoutError(err);
        const message = err === LS_WALL_CLOCK_TIMEOUT
            ? `Antigravity LS 模型调用超时（${timeout}ms）`
            : (err?.message ? `Antigravity LS 模型调用失败: ${err.message}` : "Antigravity LS 模型调用失败");
        return { text: null, error: message, timedOut };
    }
}

export async function callGetModelResponse(model: string, prompt: string, timeoutMs?: number): Promise<string | null> {
    const result = await callGetModelResponseDetailed(model, prompt, timeoutMs);
    return result.text;
}
