import fs from "fs";
import path from "path";
import os from "os";
/**
 * MCP 进程生命周期管理
 * 追踪最后活动时间，用于空闲超时判断
 */
// 最后一次 MCP 工具调用的时间戳
let lastMcpActivity = Date.now();
// stdin 实验日志路径（使用系统临时目录，避免硬编码路径）
const STDIN_LOG_FILE = path.join(os.tmpdir(), "mcp-stdin-log.txt");
/**
 * 更新活动时间戳 — 每个工具处理函数入口调用
 */
export function touchActivity() {
    lastMcpActivity = Date.now();
}
/**
 * 获取自最后活动以来的空闲时间（毫秒）
 */
export function getIdleTime() {
    return Date.now() - lastMcpActivity;
}
/**
 * 检测父 LS 进程是否还活着
 * process.ppid 在 MCP 进程中直接指向 LS 的 PID（已验证）
 * process.kill(pid, 0) 是跨平台的存活探针，微秒级，不发真信号
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
 * 记录 stdin 事件到日志（实验用，后续可移除）
 */
export function logStdinEvent(event) {
    try {
        const msg = `[${new Date().toISOString()}] PID ${process.pid} ${event}\n`;
        fs.appendFileSync(STDIN_LOG_FILE, msg);
    }
    catch { /* 写入失败不影响运行 */ }
}
//# sourceMappingURL=lifecycle.js.map