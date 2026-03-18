import fs from "fs";
import os from "os";
import path from "path";

/**
 * MCP Memory Store 进程生命周期管理
 * 追踪最后活动时间，用于空闲超时判断
 * 
 * 复用 web-fetcher 已验证的模式：
 * - touchActivity: 每个工具调用入口更新时间戳
 * - getIdleTime: 心跳检查用
 * - logStdinEvent: stdin 事件日志（调试用）
 */

// 最后一次 MCP 工具调用的时间戳
let lastMcpActivity = Date.now();

// stdin 日志路径
const STDIN_LOG_FILE = path.join(os.tmpdir(), "mcp-memory-stdin-log.txt");

/**
 * 更新活动时间戳 — 每个工具处理函数入口调用
 */
export function touchActivity(): void {
    lastMcpActivity = Date.now();
}

/**
 * 获取自最后活动以来的空闲时间（毫秒）
 */
export function getIdleTime(): number {
    return Date.now() - lastMcpActivity;
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
