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
/**
 * 安全读取注册表（文件不存在或损坏时返回空）
 */
export declare function readRegistry(): Registry;
/**
 * 注册一个 LS 到注册表（3 次重试 + 读回验证）
 */
export declare function registerLsEntry(entry: RegistryEntry): boolean;
/**
 * 退出时注销父 LS 的注册表条目（3 次重试）
 * 在 cleanup 路径调用，容忍失败
 */
export declare function cleanupRegistryOnExit(): void;
/**
 * 从注册表移除指定 PID
 */
export declare function removeFromRegistry(pidStr: string): void;
/**
 * 记录 Heartbeat 成功（重置失败计数）
 */
export declare function markHeartbeatSuccess(pidStr: string): void;
/**
 * 记录 Heartbeat 失败，返回是否应该移除该条目
 * 连续失败 MAX_HEARTBEAT_FAILURES 次后返回 true 并自动移除
 */
export declare function markHeartbeatFailure(pidStr: string): boolean;
/**
 * 启动时惰性清理：用 process.kill(pid, 0) 快速检测注册表中的死条目
 * 比 Heartbeat 更快（微秒级，不需要网络连接）
 */
export declare function cleanDeadEntries(): void;
export {};
//# sourceMappingURL=ls-registry.d.ts.map