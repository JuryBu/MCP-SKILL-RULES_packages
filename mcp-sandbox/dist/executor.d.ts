/**
 * MCP Sandbox 子进程执行引擎
 *
 * 核心职责：
 * - spawn 子进程执行代码/命令
 * - 硬超时管理（自动杀进程树）
 * - 内存监控（pidusage 2秒采样）
 * - 输出收集和截断（outputMode）
 * - 大输出写临时文件
 * - Windows 进程树杀（taskkill /T /F）
 */
export type KillReason = "timeout" | "memory" | "vram" | "manual" | "crash";
export type OutputMode = "full" | "tail" | "head" | "silent";
export interface ExecOptions {
    code?: string;
    command?: string;
    language?: string;
    cwd?: string;
    env?: string;
    timeout?: number;
    maxMemoryMB?: number;
    maxOutput?: number;
    outputMode?: OutputMode;
    tailLines?: number;
    maxLines?: number;
    gpu?: boolean;
    maxVRAM_MB?: number;
}
export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    elapsed: string;
    killed: boolean;
    killReason: KillReason | null;
    peakMemoryMB: number;
    truncated: boolean;
    originalBytes: number;
    returnedBytes: number;
    tempFile: string | null;
}
/**
 * Windows 下杀进程树（taskkill /T /F），Linux 下用 kill
 */
export declare function killProcessTree(pid: number): void;
/**
 * 折叠连续重复的输出块
 *
 * 检测连续相同的行或多行块（如 PowerShell 管道中每个元素重复报错），
 * 将 N 次重复折叠为 1 次 + 折叠提示行。
 */
export declare function foldRepeatedBlocks(text: string): string;
/**
 * 按 outputMode 处理输出
 */
export declare function processOutput(raw: string, mode: OutputMode, maxOutput: number, tailLines: number, maxLines?: number): {
    text: string;
    truncated: boolean;
    originalBytes: number;
};
/**
 * 核心执行函数
 */
export declare function execute(options: ExecOptions): Promise<ExecResult>;
//# sourceMappingURL=executor.d.ts.map