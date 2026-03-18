import { execSync } from "child_process";
import http from "http";
// 缓存：避免每次调用都重新发现进程
let cachedLsInfo = null;
let cachedHttpPort = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存
// ===== LS 进程发现 =====
/**
 * 发现当前运行的 Language Server 进程
 * 通过 PowerShell 获取 PID、命令行参数（csrf_token）和监听端口
 */
function discoverLsProcesses() {
    try {
        const psScript = [
            'Get-Process -Name language_server_windows_x64 -ErrorAction SilentlyContinue | ForEach-Object {',
            '  $id = $_.Id',
            '  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue).CommandLine',
            '  $ports = (Get-NetTCPConnection -OwningProcess $id -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort) -join ","',
            '  "$id|$cmd|$ports"',
            '}',
        ].join('\n');
        // PowerShell -EncodedCommand 需要 UTF-16LE 的 Base64
        const encodedCmd = Buffer.from(psScript, 'utf16le').toString('base64');
        const stdout = execSync(`powershell -NoProfile -EncodedCommand ${encodedCmd}`, {
            encoding: "utf-8",
            timeout: 20000,
            windowsHide: true,
        }).trim();
        if (!stdout)
            return [];
        const results = [];
        for (const line of stdout.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            const parts = trimmed.split("|");
            if (parts.length < 3)
                continue;
            const pid = parseInt(parts[0], 10);
            const cmd = parts[1];
            const portsStr = parts[2];
            if (isNaN(pid) || !cmd)
                continue;
            // 解析 csrf_token
            const csrfMatch = cmd.match(/--csrf_token\s+(\S+)/);
            if (!csrfMatch)
                continue;
            // 解析端口
            const ports = portsStr
                .split(",")
                .map((p) => parseInt(p.trim(), 10))
                .filter((p) => !isNaN(p))
                .sort((a, b) => a - b);
            if (ports.length === 0)
                continue;
            results.push({
                pid,
                csrfToken: csrfMatch[1],
                ports,
            });
        }
        return results;
    }
    catch {
        return [];
    }
}
/**
 * 获取可用的 LS 进程（带缓存 + 自动重试）
 * 首次发现失败时等 2 秒自动重试一次
 */
function getLsProcess() {
    const now = Date.now();
    if (cachedLsInfo && now - cacheTimestamp < CACHE_TTL) {
        return cachedLsInfo;
    }
    let processes = discoverLsProcesses();
    // 首次失败时自动重试一次（PowerShell 冷启动容易首次超时）
    if (processes.length === 0) {
        const sleepMs = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { /* sync sleep */ } };
        sleepMs(2000);
        processes = discoverLsProcesses();
    }
    if (processes.length === 0)
        return null;
    cachedLsInfo = processes[0];
    cachedHttpPort = null;
    cacheTimestamp = now;
    return cachedLsInfo;
}
/**
 * 清除缓存（LS 可能已重启）
 */
export function clearLsCache() {
    cachedLsInfo = null;
    cachedHttpPort = null;
    cacheTimestamp = 0;
}
// ===== connect-rpc 调用 =====
/**
 * 底层 HTTP POST 请求
 */
function httpPost(host, port, urlPath, body, headers, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: host,
            port,
            path: urlPath,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
                ...headers,
            },
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                const responseBody = Buffer.concat(chunks).toString("utf-8");
                resolve({ status: res.statusCode || 0, body: responseBody });
            });
        });
        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("Request timeout"));
        });
        req.write(body);
        req.end();
    });
}
/**
 * 调用 LS 的 connect-rpc 方法
 */
async function rpcCall(lsInfo, port, method, payload = {}) {
    const rpcPath = `/exa.language_server_pb.LanguageServerService/${method}`;
    const body = JSON.stringify(payload);
    const headers = {
        "x-codeium-csrf-token": lsInfo.csrfToken,
        "Connect-Protocol-Version": "1",
    };
    const resp = await httpPost("127.0.0.1", port, rpcPath, body, headers);
    let data;
    try {
        data = resp.body ? JSON.parse(resp.body) : {};
    }
    catch {
        data = resp.body;
    }
    return { status: resp.status, data };
}
/**
 * 找到 LS 的有效 HTTP 端口（通过 Heartbeat 验证）
 */
async function findHttpPort(lsInfo) {
    if (cachedHttpPort) {
        try {
            const result = await rpcCall(lsInfo, cachedHttpPort, "Heartbeat", {});
            if (result.status === 200)
                return cachedHttpPort;
        }
        catch { /* fallthrough */ }
        cachedHttpPort = null;
    }
    for (const port of lsInfo.ports) {
        try {
            const result = await rpcCall(lsInfo, port, "Heartbeat", {});
            if (result.status === 200) {
                cachedHttpPort = port;
                return port;
            }
        }
        catch { /* try next */ }
    }
    return null;
}
// ===== GetModelResponse — 直接模型调用 =====
/** Gemini 3 Flash 模型编码 */
const AI_SUMMARY_MODEL = "MODEL_PLACEHOLDER_M47";
/**
 * 调用 LS 的 GetModelResponse API 直接调用模型
 *
 * @param prompt 用户 prompt
 * @param model 模型编码，默认 Gemini 3 Flash
 * @param timeoutMs 超时时间，默认 30s（摘要可能较长）
 * @returns 模型响应文本，或 null（LS 不可用时）
 */
export async function callGetModelResponse(prompt, model = AI_SUMMARY_MODEL, timeoutMs = 30000) {
    try {
        const lsInfo = getLsProcess();
        if (!lsInfo)
            return null;
        const port = await findHttpPort(lsInfo);
        if (!port)
            return null;
        // 使用独立的超时 httpPost 而不是通用 rpcCall，以支持自定义超时
        const rpcPath = `/exa.language_server_pb.LanguageServerService/GetModelResponse`;
        const body = JSON.stringify({ model, prompt });
        const headers = {
            "x-codeium-csrf-token": lsInfo.csrfToken,
            "Connect-Protocol-Version": "1",
        };
        const resp = await httpPost("127.0.0.1", port, rpcPath, body, headers, timeoutMs);
        let data;
        try {
            data = resp.body ? JSON.parse(resp.body) : {};
        }
        catch {
            return null;
        }
        if (resp.status === 200 && data?.response) {
            return data.response;
        }
        return null;
    }
    catch (err) {
        console.error(`[ls-client] GetModelResponse 调用失败: ${err instanceof Error ? err.message : err}`);
        return null;
    }
}
/**
 * 检查 LS 是否可用（用于判断是否能使用 AI Summary）
 */
export async function isLsAvailable() {
    try {
        const lsInfo = getLsProcess();
        if (!lsInfo)
            return false;
        const port = await findHttpPort(lsInfo);
        return port !== null;
    }
    catch {
        return false;
    }
}
/**
 * 获取 LS 状态信息（用于调试/日志）
 */
export function getLsStatus() {
    if (!cachedLsInfo) {
        return { available: false };
    }
    return {
        available: cachedHttpPort !== null,
        pid: cachedLsInfo.pid,
        port: cachedHttpPort ?? undefined,
    };
}
//# sourceMappingURL=ls-client.js.map