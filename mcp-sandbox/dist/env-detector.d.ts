/**
 * MCP Sandbox 环境探测器
 *
 * 启动时探测一次，缓存到内存：
 * - conda 环境列表
 * - Python 系统版本和路径
 * - Node.js 版本和路径
 * - Git Bash（bash language 条件可用）
 * - CUDA 信息（nvidia-smi）
 * - DirectML 检测
 */
export interface CondaEnv {
    name: string;
    path: string;
    pythonVersion: string;
}
export interface EnvironmentInfo {
    conda: {
        available: boolean;
        envs: CondaEnv[];
    };
    python: {
        available: boolean;
        version: string;
        path: string;
    };
    node: {
        available: boolean;
        version: string;
        path: string;
    };
    bash: {
        available: boolean;
        path: string;
    };
    cuda: {
        available: boolean;
        version: string;
        vramTotalMB: number;
        vramUsedMB: number;
        driverVersion: string;
    };
    directML: boolean;
}
/**
 * 执行环境探测（启动时调用一次）
 */
export declare function detectEnvironment(): Promise<EnvironmentInfo>;
/**
 * 获取缓存的环境信息
 */
export declare function getCachedEnvInfo(): EnvironmentInfo | null;
/**
 * 根据 env 参数获取正确的解释器路径
 * @param env 格式: "conda:名称" / "venv:路径"
 * @param language 语言
 * @returns 解释器绝对路径，或 null 使用默认
 */
export declare function resolveInterpreter(env: string | undefined, language: string): string | null;
//# sourceMappingURL=env-detector.d.ts.map