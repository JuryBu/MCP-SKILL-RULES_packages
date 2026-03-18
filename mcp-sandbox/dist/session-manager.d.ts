import { ChildProcess } from "child_process";
export interface Session {
    id: string;
    language: string;
    process: ChildProcess;
    pid: number;
    cwd: string;
    maxMemoryMB: number;
    createdAt: number;
    lastActivity: number;
    execCount: number;
    alive: boolean;
    currentMemoryMB: number;
    stdoutBuffer: string;
    stderrBuffer: string;
}
export interface SessionExecResult {
    stdout: string;
    stderr: string;
    elapsed: string;
    killed: boolean;
    killReason: string | null;
}
export interface SessionStatus {
    id: string;
    language: string;
    alive: boolean;
    memoryMB: number;
    uptime: string;
    execCount: number;
}
/**
 * 创建新会话
 */
export declare function createSession(language?: string, cwd?: string, maxMemoryMB?: number, envParam?: string): {
    session: Session;
} | {
    error: string;
};
/**
 * 在会话中执行代码（Sentinel 标记法）
 */
export declare function execInSession(sessionId: string, code: string, timeout?: number): Promise<SessionExecResult>;
/**
 * 获取会话状态
 */
export declare function getSessionStatus(sessionId: string): Promise<SessionStatus | null>;
/**
 * 关闭会话
 */
export declare function closeSession(sessionId: string): boolean;
/**
 * 列出所有活跃会话
 */
export declare function listSessions(): Promise<SessionStatus[]>;
/**
 * 关闭所有会话（MCP 退出时调用）
 */
export declare function closeAllSessions(): void;
/**
 * 获取活跃会话数量
 */
export declare function getActiveSessionCount(): number;
//# sourceMappingURL=session-manager.d.ts.map