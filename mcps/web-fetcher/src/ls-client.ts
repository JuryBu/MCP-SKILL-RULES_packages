import { execSync } from "child_process";
import http from "http";

/**
 * Language Server connect-rpc 客户端（精简版）
 *
 * 从 memory-store 移植，只保留 GetModelResponse 直接模型调用能力。
 * 用于 web-fetcher 的 AI Summary 功能。
 *
 * 协议：
 *   - connect-rpc (HTTP POST + JSON)
 *   - 认证: x-codeium-csrf-token header
 *   - 端口/token: 每次 IDE 启动都变化，需动态检测
 */

// ===== 类型 =====

interface LsProcessInfo {
    pid: number;
    csrfToken: string;
    ports: number[];
}

interface RpcResult {
    status: number;
    data: any;
}

interface GetModelResponsePayload {
    model: string;
    prompt: string;
}

// 缓存：避免每次调用都重新发现进程
let cachedLsInfo: LsProcessInfo | null = null;
let cachedHttpPort: number | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存

// ===== LS 进程发现 =====

/**
 * 发现当前运行的 Language Server 进程
 * 通过 PowerShell 获取 PID、命令行参数（csrf_token）和监听端口
 */
function discoverLsProcesses(): LsProcessInfo[] {
    try {
        const psScript = [
            "$ProgressPreference = 'SilentlyContinue'",
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

        if (!stdout) return [];

        const results: LsProcessInfo[] = [];
        for (const line of stdout.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            const parts = trimmed.split("|");
            if (parts.length < 3) continue;

            const pid = parseInt(parts[0], 10);
            const cmd = parts[1];
            const portsStr = parts[2];

            if (isNaN(pid) || !cmd) continue;

            // 解析 csrf_token
            const csrfMatch = cmd.match(/--csrf_token\s+(\S+)/);
            if (!csrfMatch) continue;

            // 解析端口
            const ports = portsStr
                .split(",")
                .map((p) => parseInt(p.trim(), 10))
                .filter((p) => !isNaN(p))
                .sort((a, b) => a - b);

            if (ports.length === 0) continue;

            results.push({
                pid,
                csrfToken: csrfMatch[1],
                ports,
            });
        }

        return results;
    } catch {
        return [];
    }
}

/**
 * 获取可用的 LS 进程（带缓存 + 自动重试）
 * 首次发现失败时等 2 秒自动重试一次
 */
function getLsProcess(): LsProcessInfo | null {
    const now = Date.now();
    if (cachedLsInfo && now - cacheTimestamp < CACHE_TTL) {
        return cachedLsInfo;
    }

    let processes = discoverLsProcesses();
    // 首次失败时自动重试一次（PowerShell 冷启动容易首次超时）
    if (processes.length === 0) {
        const sleepMs = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* sync sleep */ } };
        sleepMs(2000);
        processes = discoverLsProcesses();
    }
    if (processes.length === 0) return null;

    cachedLsInfo = processes[0];
    cachedHttpPort = null;
    cacheTimestamp = now;
    return cachedLsInfo;
}

function getLsCandidates(): LsProcessInfo[] {
    const now = Date.now();
    const candidates: LsProcessInfo[] = [];

    if (cachedLsInfo && now - cacheTimestamp < CACHE_TTL) {
        candidates.push(cachedLsInfo);
    }

    let discovered = discoverLsProcesses();
    if (discovered.length === 0) {
        const sleepMs = (ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { /* sync sleep */ } };
        sleepMs(2000);
        discovered = discoverLsProcesses();
    }

    for (const info of discovered) {
        if (!candidates.some((item) => item.pid === info.pid)) {
            candidates.push(info);
        }
    }

    return candidates;
}

/**
 * 清除缓存（LS 可能已重启）
 */
export function clearLsCache(): void {
    cachedLsInfo = null;
    cachedHttpPort = null;
    cacheTimestamp = 0;
}

// ===== connect-rpc 调用 =====

/**
 * 底层 HTTP POST 请求
 */
function httpPost(
    host: string,
    port: number,
    urlPath: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs = 15000
): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
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
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () => {
                    const responseBody = Buffer.concat(chunks).toString("utf-8");
                    resolve({ status: res.statusCode || 0, body: responseBody });
                });
            }
        );
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
async function rpcCall(
    lsInfo: LsProcessInfo,
    port: number,
    method: string,
    payload: Record<string, unknown> = {}
): Promise<RpcResult> {
    const rpcPath = `/exa.language_server_pb.LanguageServerService/${method}`;
    const body = JSON.stringify(payload);
    const headers = {
        "x-codeium-csrf-token": lsInfo.csrfToken,
        "Connect-Protocol-Version": "1",
    };

    const resp = await httpPost("127.0.0.1", port, rpcPath, body, headers);

    let data: any;
    try {
        data = resp.body ? JSON.parse(resp.body) : {};
    } catch {
        data = resp.body;
    }

    return { status: resp.status, data };
}

/**
 * 找到 LS 的有效 HTTP 端口（通过 Heartbeat 验证）
 */
async function findHttpPort(lsInfo: LsProcessInfo): Promise<number | null> {
    if (cachedHttpPort) {
        try {
            const result = await rpcCall(lsInfo, cachedHttpPort, "Heartbeat", {});
            if (result.status === 200) return cachedHttpPort;
        } catch { /* fallthrough */ }
        cachedHttpPort = null;
    }

    for (const port of lsInfo.ports) {
        try {
            const result = await rpcCall(lsInfo, port, "Heartbeat", {});
            if (result.status === 200) {
                cachedHttpPort = port;
                return port;
            }
        } catch { /* try next */ }
    }

    return null;
}

// ===== GetModelResponse — 直接模型调用 =====

/** Antigravity GetModelResponse 默认模型：当前实测 Gemini 3.5 Flash (High)。 */
const AI_SUMMARY_MODEL = process.env.WEB_FETCHER_LS_MODEL || "MODEL_PLACEHOLDER_M132";

/** Antigravity GetModelResponse 默认 fallback：新 Flash 优先，复杂推理兜底到 Pro。 */
const DEFAULT_LS_MODEL_FALLBACKS = [
    "MODEL_PLACEHOLDER_M132", // Gemini 3.5 Flash (High)
    "MODEL_PLACEHOLDER_M20",  // Gemini 3.5 Flash (Medium)
    "MODEL_PLACEHOLDER_M18",  // Gemini 3 Flash
    "MODEL_PLACEHOLDER_M16",  // Gemini 3.1 Pro (High)
    "MODEL_PLACEHOLDER_M36",  // Gemini 3.1 Pro (Low)
].join(",");

async function postGetModelResponse(
    lsInfo: LsProcessInfo,
    port: number,
    payload: GetModelResponsePayload,
    timeoutMs: number
): Promise<string | null> {
    const rpcPath = `/exa.language_server_pb.LanguageServerService/GetModelResponse`;
    const body = JSON.stringify(payload);
    const headers = {
        "x-codeium-csrf-token": lsInfo.csrfToken,
        "Connect-Protocol-Version": "1",
    };

    const resp = await httpPost("127.0.0.1", port, rpcPath, body, headers, timeoutMs);

    let data: any;
    try {
        data = resp.body ? JSON.parse(resp.body) : {};
    } catch {
        return null;
    }

    if (resp.status === 200 && data?.response) {
        return data.response;
    }
    return null;
}

export function getLsModelCandidates(model: string): string[] {
    const candidates = [model];
    const fallbacks = (process.env.WEB_FETCHER_LS_MODEL_FALLBACKS || DEFAULT_LS_MODEL_FALLBACKS)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    for (const fallback of fallbacks) {
        if (!candidates.includes(fallback)) candidates.push(fallback);
    }
    return candidates;
}

/**
 * 调用 LS 的 GetModelResponse API 直接调用模型
 *
 * @param prompt 用户 prompt
 * @param model 模型编码，默认 Gemini 3.5 Flash (High)
 * @param timeoutMs 超时时间，默认 30s（摘要可能较长）
 * @returns 模型响应文本，或 null（LS 不可用时）
 */
export async function callGetModelResponse(
    prompt: string,
    model: string = AI_SUMMARY_MODEL,
    timeoutMs = 30000,
    imagePaths: string[] = []
): Promise<string | null> {
    try {
        if (imagePaths.length > 0) {
            console.error("[ls-client] Antigravity GetModelResponse only supports text prompt + model; imagePaths ignored");
        }
        const candidates = getLsCandidates();
        if (candidates.length === 0) return null;

        for (const lsInfo of candidates) {
            const port = await findHttpPort(lsInfo);
            if (!port) continue;

            for (const candidateModel of getLsModelCandidates(model)) {
                const text = await postGetModelResponse(lsInfo, port, { model: candidateModel, prompt }, timeoutMs);
                if (text) {
                    if (candidateModel !== model) {
                        console.error(`[ls-client] GetModelResponse model fallback: ${model} -> ${candidateModel}`);
                    }
                    cachedLsInfo = lsInfo;
                    cachedHttpPort = port;
                    cacheTimestamp = Date.now();
                    return text;
                }
            }
        }

        clearLsCache();
        return null;
    } catch (err) {
        console.error(`[ls-client] GetModelResponse 调用失败: ${err instanceof Error ? err.message : err}`);
        return null;
    }
}

/**
 * 检查 LS 是否可用（用于判断是否能使用 AI Summary）
 */
export async function isLsAvailable(): Promise<boolean> {
    try {
        for (const lsInfo of getLsCandidates()) {
            const port = await findHttpPort(lsInfo);
            if (port !== null) {
                cachedLsInfo = lsInfo;
                cachedHttpPort = port;
                cacheTimestamp = Date.now();
                return true;
            }
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * 获取 LS 状态信息（用于调试/日志）
 */
export function getLsStatus(): { available: boolean; pid?: number; port?: number } {
    if (!cachedLsInfo) {
        return { available: false };
    }
    return {
        available: cachedHttpPort !== null,
        pid: cachedLsInfo.pid,
        port: cachedHttpPort ?? undefined,
    };
}
