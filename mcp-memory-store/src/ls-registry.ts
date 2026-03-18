import fs from "fs";
import path from "path";
import os from "os";

/**
 * LS 注册表 — 跨窗口 LS 发现加速
 *
 * memory-store 是三个 MCP 中唯一需要 LS 数据交互的，
 * 注册表将所有存活 LS 的连接信息持久化到磁盘，
 * 使跨 LS 查询从 PowerShell 全量扫描 2-5s 降至 ~5ms。
 *
 * 生命周期：启动注册 → 读时惰性清理 → 退出注销
 * 并发安全：tmp + rename 原子写入
 */

// ===== 类型 =====

export interface RegistryEntry {
    pid: number;
    port: number;
    csrfToken: string;
    workspaceId: string;
    registeredAt: string;
}

interface Registry {
    processes: Record<string, RegistryEntry>;
}

// ===== 路径 =====

const REGISTRY_DIR = path.join(os.homedir(), ".gemini", "antigravity", "memory-store");
const REGISTRY_PATH = path.join(REGISTRY_DIR, "ls-registry.json");

// ===== Heartbeat 容忍 =====

/** 模块级变量：记录各条目连续 Heartbeat 失败次数 */
const heartbeatFailCounts = new Map<string, number>();
/** 连续失败 3 次才从注册表删除，避免瞬时繁忙误删 */
const MAX_HEARTBEAT_FAILURES = 3;

// ===== 基础读写 =====

/**
 * 安全读取注册表（文件不存在或损坏时返回空）
 */
export function readRegistry(): Registry {
    try {
        if (fs.existsSync(REGISTRY_PATH)) {
            const content = fs.readFileSync(REGISTRY_PATH, "utf-8");
            const parsed = JSON.parse(content);
            if (parsed && typeof parsed.processes === "object") {
                return parsed;
            }
        }
    } catch { /* 文件损坏或并发写入冲突 */ }
    return { processes: {} };
}

/**
 * 原子更新注册表（读 → 修改 → tmp+rename 写回）
 */
function updateRegistry(fn: (data: Registry) => void): void {
    const data = readRegistry();
    fn(data);

    // 确保目录存在
    if (!fs.existsSync(REGISTRY_DIR)) {
        fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    }

    // 原子写入：写临时文件 → rename
    const tmpPath = REGISTRY_PATH + ".tmp." + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, REGISTRY_PATH);
}

// ===== 注册 / 注销 =====

/**
 * 注册一个 LS 到注册表（3 次重试 + 读回验证）
 */
export function registerLsEntry(entry: RegistryEntry): boolean {
    const pidStr = String(entry.pid);
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            updateRegistry(data => {
                data.processes[pidStr] = { ...entry };
            });
            // 读回验证
            const readBack = readRegistry();
            if (readBack.processes[pidStr]) {
                return true;
            }
            console.error(`[registry] 注册写入后读回验证失败，重试 (${attempt + 1}/3)`);
        } catch (err) {
            console.error(`[registry] 注册失败 (${attempt + 1}/3): ${err}`);
        }
    }
    console.error("[registry] 经过 3 次重试仍无法注册 LS，将降级使用实时发现");
    return false;
}

/**
 * 退出时注销父 LS 的注册表条目（3 次重试）
 * 在 cleanup 路径调用，容忍失败
 */
export function cleanupRegistryOnExit(): void {
    const myPid = String(process.ppid);

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const data = readRegistry();
            if (!data.processes[myPid]) break; // 已不在表中

            delete data.processes[myPid];

            // 如果是最后一条 → 删除整个文件
            if (Object.keys(data.processes).length === 0) {
                try { fs.unlinkSync(REGISTRY_PATH); } catch { /* 文件可能已被删 */ }
                break;
            }

            // 否则写回
            if (!fs.existsSync(REGISTRY_DIR)) {
                fs.mkdirSync(REGISTRY_DIR, { recursive: true });
            }
            const tmp = REGISTRY_PATH + ".tmp." + process.pid;
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
            fs.renameSync(tmp, REGISTRY_PATH);

            // 读回验证
            const readBack = readRegistry();
            if (!readBack.processes[myPid]) break; // 确认删除成功
            console.error(`[registry] 注销后读回验证失败，重试 (${attempt + 1}/3)`);
        } catch (err) {
            console.error(`[registry] 注销失败 (${attempt + 1}/3): ${err}`);
        }
    }
}

/**
 * 从注册表移除指定 PID
 */
export function removeFromRegistry(pidStr: string): void {
    try {
        updateRegistry(data => {
            delete data.processes[pidStr];
        });
    } catch { /* 容忍失败 */ }
}

// ===== Heartbeat 验证 =====

/**
 * 记录 Heartbeat 成功（重置失败计数）
 */
export function markHeartbeatSuccess(pidStr: string): void {
    heartbeatFailCounts.delete(pidStr);
}

/**
 * 记录 Heartbeat 失败，返回是否应该移除该条目
 * 连续失败 MAX_HEARTBEAT_FAILURES 次后返回 true 并自动移除
 */
export function markHeartbeatFailure(pidStr: string): boolean {
    const failures = (heartbeatFailCounts.get(pidStr) || 0) + 1;
    heartbeatFailCounts.set(pidStr, failures);

    if (failures >= MAX_HEARTBEAT_FAILURES) {
        console.error(`[registry] PID=${pidStr} 连续 ${failures} 次 Heartbeat 失败，从注册表移除`);
        heartbeatFailCounts.delete(pidStr);
        removeFromRegistry(pidStr);
        return true; // 应移除
    }

    console.error(`[registry] PID=${pidStr} Heartbeat 失败 (${failures}/${MAX_HEARTBEAT_FAILURES})，暂不移除`);
    return false; // 暂不移除
}

/**
 * 启动时惰性清理：用 process.kill(pid, 0) 快速检测注册表中的死条目
 * 比 Heartbeat 更快（微秒级，不需要网络连接）
 */
export function cleanDeadEntries(): void {
    try {
        const data = readRegistry();
        let changed = false;
        for (const [pidStr, _entry] of Object.entries(data.processes)) {
            try {
                process.kill(parseInt(pidStr, 10), 0);
                // 进程存在，保留
            } catch {
                // 进程不存在，删除
                console.error(`[registry] 清理死条目: PID=${pidStr}`);
                delete data.processes[pidStr];
                changed = true;
            }
        }
        if (changed) {
            if (Object.keys(data.processes).length === 0) {
                try { fs.unlinkSync(REGISTRY_PATH); } catch { /* */ }
            } else {
                if (!fs.existsSync(REGISTRY_DIR)) {
                    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
                }
                const tmp = REGISTRY_PATH + ".tmp." + process.pid;
                fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
                fs.renameSync(tmp, REGISTRY_PATH);
            }
        }
    } catch { /* 启动时清理容忍失败 */ }
}
