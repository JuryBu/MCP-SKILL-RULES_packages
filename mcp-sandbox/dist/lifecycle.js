import fs from "fs";
import os from "os";
import path from "path";
/**
 * MCP Sandbox 进程生命周期管理
 *
 * - isParentAlive: 检测父 LS 进程存活（ppid 绑定，与窗口同生共死）
 * - touchActivity: 每个工具调用入口更新时间戳
 * - logStdinEvent: stdin 事件日志（调试用）
 * - appendTiming: 返回结果追加耗时信息
 */
// 最后一次 MCP 工具调用的时间戳
let lastMcpActivity = Date.now();
// stdin 日志路径（使用系统临时目录，避免硬编码）
const STDIN_LOG_FILE = path.join(os.tmpdir(), "mcp-sandbox-stdin-log.txt");
/**
 * 更新活动时间戳 — 每个工具处理函数入口调用
 */
export function touchActivity() {
    lastMcpActivity = Date.now();
}
/**
 * 检测父 LS 进程是否还活着
 *
 * process.ppid 在 MCP 进程中直接指向 LS 的 PID（已验证）。
 * signal 0 不发真信号，只检查进程存活，微秒级开销。
 */
export function isParentAlive() {
    try {
        process.kill(process.ppid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * 获取自最后活动以来的空闲时间（毫秒）
 */
export function getIdleTime() {
    return Date.now() - lastMcpActivity;
}
/**
 * 记录 stdin 事件到日志（调试用）
 */
export function logStdinEvent(event) {
    try {
        const msg = `[${new Date().toISOString()}] PID ${process.pid} ${event}\n`;
        fs.appendFileSync(STDIN_LOG_FILE, msg);
    }
    catch { /* 写入失败不影响运行 */ }
}
/**
 * 在 MCP 工具返回结果的最后一个 text content 追加耗时信息
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function appendTiming(result, startTime) {
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
/**
 * 格式化毫秒为人类可读的时间字符串
 */
export function formatElapsed(ms) {
    if (ms < 1000)
        return `${ms}ms`;
    if (ms < 60000)
        return `${(ms / 1000).toFixed(1)}s`;
    const min = Math.floor(ms / 60000);
    const sec = ((ms % 60000) / 1000).toFixed(0);
    return `${min}m${sec}s`;
}
//# sourceMappingURL=lifecycle.js.map