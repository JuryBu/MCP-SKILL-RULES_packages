/**
 * 更新活动时间戳 — 每个工具处理函数入口调用
 */
export declare function touchActivity(): void;
/**
 * 获取自最后活动以来的空闲时间（毫秒）
 */
export declare function getIdleTime(): number;
/**
 * 检测父 LS 进程是否还活着
 * process.ppid 在 MCP 进程中直接指向 LS 的 PID（已验证）
 * process.kill(pid, 0) 是跨平台的存活探针，微秒级，不发真信号
 */
export declare function isParentAlive(): boolean;
/**
 * 记录 stdin 事件到日志（实验用，后续可移除）
 */
export declare function logStdinEvent(event: string): void;
//# sourceMappingURL=lifecycle.d.ts.map