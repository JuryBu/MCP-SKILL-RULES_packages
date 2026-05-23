import { exec } from "child_process";
import fs from "fs";

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
 * 
 * v1.5.1: 全面异步化 — 所有探测使用 exec（非 execSync），
 * 不阻塞 Node 事件循环，消除 MCP 首次调用延迟。
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

// 缓存的环境信息
let cachedEnvInfo: EnvironmentInfo | null = null;

/**
 * 安全执行命令（异步），返回 stdout 或 null
 * 不阻塞事件循环
 */
function safeExec(cmd: string, timeoutMs: number = 5000): Promise<string | null> {
    return new Promise((resolve) => {
        const child = exec(cmd, {
            encoding: "utf-8",
            timeout: timeoutMs,
            windowsHide: true,
        }, (error, stdout) => {
            if (error) {
                resolve(null);
            } else {
                resolve(stdout?.trim() || null);
            }
        });
        // 确保子进程 stdio 不阻止 GC
        child.stdin?.end();
    });
}

/**
 * 探测 conda 环境
 */
async function detectConda(): Promise<EnvironmentInfo["conda"]> {
    const result: EnvironmentInfo["conda"] = { available: false, envs: [] };

    const jsonStr = await safeExec("conda env list --json", 10000);
    if (!jsonStr) return result;

    try {
        const data = JSON.parse(jsonStr);
        result.available = true;

        if (Array.isArray(data.envs)) {
            // 并行获取所有 env 的 Python 版本
            const envPromises = data.envs.map(async (envPath: string) => {
                const name = envPath.includes("envs")
                    ? envPath.split(/[/\\]envs[/\\]/)[1] || "base"
                    : "base";

                const pythonPath = process.platform === "win32"
                    ? `${envPath}\\python.exe`
                    : `${envPath}/bin/python`;
                const pyVer = await safeExec(`"${pythonPath}" --version`, 3000);
                const version = pyVer?.replace("Python ", "") || "unknown";

                return { name, path: envPath, pythonVersion: version } as CondaEnv;
            });

            result.envs = await Promise.all(envPromises);
        }
    } catch { /* JSON 解析失败 */ }

    return result;
}

/**
 * 探测系统 Python
 */
async function detectPython(): Promise<EnvironmentInfo["python"]> {
    const result: EnvironmentInfo["python"] = { available: false, version: "", path: "" };

    const version = await safeExec("python --version");
    if (version) {
        result.available = true;
        result.version = version.replace("Python ", "");
        const pyPath = await safeExec('python -c "import sys; print(sys.executable)"');
        result.path = pyPath || "python";
    }

    return result;
}

/**
 * 探测 Node.js
 */
async function detectNode(): Promise<EnvironmentInfo["node"]> {
    const result: EnvironmentInfo["node"] = { available: false, version: "", path: "" };

    const version = await safeExec("node --version");
    if (version) {
        result.available = true;
        result.version = version.replace("v", "");
        const nodePath = await safeExec('node -e "console.log(process.execPath)"');
        result.path = nodePath || "node";
    }

    return result;
}

/**
 * 探测 Git Bash（bash language 条件可用）
 */
async function detectBash(): Promise<EnvironmentInfo["bash"]> {
    const result: EnvironmentInfo["bash"] = { available: false, path: "" };

    if (process.platform !== "win32") {
        const bashPath = await safeExec("which bash");
        if (bashPath) {
            result.available = true;
            result.path = bashPath;
        }
        return result;
    }

    // Windows: 检测 Git Bash
    const commonPaths = [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ];

    for (const p of commonPaths) {
        if (fs.existsSync(p)) {
            result.available = true;
            result.path = p;
            return result;
        }
    }

    // 尝试 where bash
    const bashPath = await safeExec("where bash");
    if (bashPath) {
        result.available = true;
        result.path = bashPath.split("\n")[0].trim();
    }

    return result;
}

/**
 * 探测 CUDA/GPU
 */
async function detectCuda(): Promise<EnvironmentInfo["cuda"]> {
    const result: EnvironmentInfo["cuda"] = {
        available: false,
        version: "",
        vramTotalMB: 0,
        vramUsedMB: 0,
        driverVersion: "",
    };

    // nvidia-smi 查询（一次拿所有数据）
    const smiOutput = await safeExec(
        "nvidia-smi --query-gpu=driver_version,memory.total,memory.used --format=csv,noheader,nounits",
        5000
    );

    if (smiOutput) {
        result.available = true;
        const parts = smiOutput.split(",").map(s => s.trim());
        if (parts.length >= 3) {
            result.driverVersion = parts[0];
            result.vramTotalMB = parseInt(parts[1]) || 0;
            result.vramUsedMB = parseInt(parts[2]) || 0;
        }

        // CUDA 版本 — 从完整输出中提取
        const fullOutput = await safeExec("nvidia-smi");
        if (fullOutput) {
            const cudaMatch = fullOutput.match(/CUDA Version:\s*([\d.]+)/);
            if (cudaMatch) {
                result.version = cudaMatch[1];
            }
        }
    }

    return result;
}

/**
 * 探测 DirectML
 */
async function detectDirectML(): Promise<boolean> {
    const result = await safeExec(
        'python -c "import onnxruntime; print(\'DmlExecutionProvider\' in onnxruntime.get_available_providers())"',
        5000
    );
    return result === "True";
}

/**
 * 执行环境探测（启动时调用一次）
 * 所有探测并行执行，不阻塞事件循环
 */
export async function detectEnvironment(): Promise<EnvironmentInfo> {
    if (cachedEnvInfo) return cachedEnvInfo;

    console.error("[sandbox] 开始环境探测（异步，不阻塞工具调用）...");
    const startTime = Date.now();

    // 所有探测并行执行
    const [conda, python, node, bash, cuda, directML] = await Promise.all([
        detectConda(),
        detectPython(),
        detectNode(),
        detectBash(),
        detectCuda(),
        detectDirectML(),
    ]);

    const info: EnvironmentInfo = { conda, python, node, bash, cuda, directML };

    cachedEnvInfo = info;

    const elapsed = Date.now() - startTime;
    console.error(`[sandbox] 环境探测完成 (${elapsed}ms): python=${info.python.available} node=${info.node.available} conda=${info.conda.available} cuda=${info.cuda.available} bash=${info.bash.available}`);

    return info;
}

/**
 * 获取缓存的环境信息
 */
export function getCachedEnvInfo(): EnvironmentInfo | null {
    return cachedEnvInfo;
}

/**
 * 根据 env 参数获取正确的解释器路径
 * @param env 格式: "conda:名称" / "venv:路径"
 * @param language 语言
 * @returns 解释器绝对路径，或 null 使用默认
 */
export function resolveInterpreter(env: string | undefined, language: string): string | null {
    if (!env) return null;

    if (env.startsWith("conda:")) {
        const envName = env.slice(6);
        const condaInfo = cachedEnvInfo?.conda;
        if (condaInfo?.available) {
            const found = condaInfo.envs.find(e => e.name === envName);
            if (found) {
                return process.platform === "win32"
                    ? `${found.path}\\python.exe`
                    : `${found.path}/bin/python`;
            }
        }
        return null;
    }

    if (env.startsWith("venv:")) {
        const venvPath = env.slice(5);
        return process.platform === "win32"
            ? `${venvPath}\\Scripts\\python.exe`
            : `${venvPath}/bin/python`;
    }

    return null;
}
