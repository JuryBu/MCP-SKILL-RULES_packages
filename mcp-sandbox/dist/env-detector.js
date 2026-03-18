import { execSync } from "child_process";
import fs from "fs";
// 缓存的环境信息
let cachedEnvInfo = null;
/**
 * 安全执行命令，返回 stdout 或 null
 */
function safeExec(cmd, timeoutMs = 5000) {
    try {
        return execSync(cmd, {
            encoding: "utf-8",
            timeout: timeoutMs,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
        }).trim();
    }
    catch {
        return null;
    }
}
/**
 * 探测 conda 环境
 */
function detectConda() {
    const result = { available: false, envs: [] };
    const jsonStr = safeExec("conda env list --json", 10000);
    if (!jsonStr)
        return result;
    try {
        const data = JSON.parse(jsonStr);
        result.available = true;
        if (Array.isArray(data.envs)) {
            for (const envPath of data.envs) {
                const name = envPath.includes("envs")
                    ? envPath.split(/[/\\]envs[/\\]/)[1] || "base"
                    : "base";
                // 尝试获取 Python 版本
                const pythonPath = process.platform === "win32"
                    ? `${envPath}\\python.exe`
                    : `${envPath}/bin/python`;
                const pyVer = safeExec(`"${pythonPath}" --version`, 3000);
                const version = pyVer?.replace("Python ", "") || "unknown";
                result.envs.push({ name, path: envPath, pythonVersion: version });
            }
        }
    }
    catch { /* JSON 解析失败 */ }
    return result;
}
/**
 * 探测系统 Python
 */
function detectPython() {
    const result = { available: false, version: "", path: "" };
    const version = safeExec("python --version");
    if (version) {
        result.available = true;
        result.version = version.replace("Python ", "");
        const pyPath = safeExec("python -c \"import sys; print(sys.executable)\"");
        result.path = pyPath || "python";
    }
    return result;
}
/**
 * 探测 Node.js
 */
function detectNode() {
    const result = { available: false, version: "", path: "" };
    const version = safeExec("node --version");
    if (version) {
        result.available = true;
        result.version = version.replace("v", "");
        const nodePath = safeExec("node -e \"console.log(process.execPath)\"");
        result.path = nodePath || "node";
    }
    return result;
}
/**
 * 探测 Git Bash（bash language 条件可用）
 */
async function detectBash() {
    const result = { available: false, path: "" };
    if (process.platform !== "win32") {
        // Linux/macOS 原生支持 bash
        const bashPath = safeExec("which bash");
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
    const bashPath = safeExec("where bash");
    if (bashPath) {
        result.available = true;
        result.path = bashPath.split("\n")[0].trim();
    }
    return result;
}
/**
 * 探测 CUDA/GPU
 */
function detectCuda() {
    const result = {
        available: false,
        version: "",
        vramTotalMB: 0,
        vramUsedMB: 0,
        driverVersion: "",
    };
    // nvidia-smi 方式
    const smiOutput = safeExec("nvidia-smi --query-gpu=driver_version,memory.total,memory.used --format=csv,noheader,nounits", 5000);
    if (smiOutput) {
        result.available = true;
        const parts = smiOutput.split(",").map(s => s.trim());
        if (parts.length >= 3) {
            result.driverVersion = parts[0];
            result.vramTotalMB = parseInt(parts[1]) || 0;
            result.vramUsedMB = parseInt(parts[2]) || 0;
        }
        // 获取 CUDA 版本
        const cudaVer = safeExec("nvidia-smi --query-gpu=driver_version --format=csv,noheader");
        // 从完整输出中尝试提取 CUDA 版本
        const fullOutput = safeExec("nvidia-smi");
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
function detectDirectML() {
    // 检查是否有 AMD/Intel GPU 且支持 DirectML
    const dxdiag = safeExec("dxdiag /t C:/tmp/dxdiag.txt", 10000);
    // 简化：检查 Python ort 是否有 DirectML
    const result = safeExec('python -c "import onnxruntime; print(\'DmlExecutionProvider\' in onnxruntime.get_available_providers())"', 5000);
    return result === "True";
}
/**
 * 执行环境探测（启动时调用一次）
 */
export async function detectEnvironment() {
    if (cachedEnvInfo)
        return cachedEnvInfo;
    console.error("[sandbox] 开始环境探测...");
    const startTime = Date.now();
    const info = {
        conda: detectConda(),
        python: detectPython(),
        node: detectNode(),
        bash: await detectBash(),
        cuda: detectCuda(),
        directML: detectDirectML(),
    };
    cachedEnvInfo = info;
    const elapsed = Date.now() - startTime;
    console.error(`[sandbox] 环境探测完成 (${elapsed}ms): python=${info.python.available} node=${info.node.available} conda=${info.conda.available} cuda=${info.cuda.available} bash=${info.bash.available}`);
    return info;
}
/**
 * 获取缓存的环境信息
 */
export function getCachedEnvInfo() {
    return cachedEnvInfo;
}
/**
 * 根据 env 参数获取正确的解释器路径
 * @param env 格式: "conda:名称" / "venv:路径"
 * @param language 语言
 * @returns 解释器绝对路径，或 null 使用默认
 */
export function resolveInterpreter(env, language) {
    if (!env)
        return null;
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
//# sourceMappingURL=env-detector.js.map