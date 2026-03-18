/**
 * 更新活动时间戳 — 每个工具处理函数入口调用
 */
export declare function touchActivity(): void;
/**
 * 检测父 LS 进程是否还活着
 *
 * process.ppid 在 MCP 进程中直接指向 LS 的 PID（已验证）。
 * signal 0 不发真信号，只检查进程存活，微秒级开销。
 */
export declare function isParentAlive(): boolean;
/**
 * 获取自最后活动以来的空闲时间（毫秒）
 */
export declare function getIdleTime(): number;
/**
 * 记录 stdin 事件到日志（调试用）
 */
export declare function logStdinEvent(event: string): void;
/**
 * 在 MCP 工具返回结果的最后一个 text content 追加耗时信息
 */
export declare function appendTiming(result: any, startTime: number): any;
/**
 * 格式化毫秒为人类可读的时间字符串
 */
export declare function formatElapsed(ms: number): string;
//# sourceMappingURL=lifecycle.d.ts.map