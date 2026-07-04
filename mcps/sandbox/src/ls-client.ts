/**
 * LS Client — Antigravity LS 发现与模型调用
 *
 * 从 memory-store 的 ls-client.ts 精简移植，并保留最小跨宿主能力：
 * - 父 LS 优先发现（ppid 单进程查询）
 * - 非父进程时回退到任意可连接的 Antigravity LS
 * - HTTP RPC 调用
 * - GetModelResponse（Flash API）
 *
 * 不包含：对话数据获取、注册表、缓存等 memory-store 专用功能
 */

import { execSync } from "child_process";
import http from "http";

// ===== 类型 =====

export interface LsProcessInfo {
    pid: number;
    csrfToken: string;
    workspaceId: string;
    ports: number[];
}

interface RpcResult {
    status: number;
    data: any;
    rawSize: number;
}

/** 父 LS 已确认的连接信息（含验证后的 HTTP 端口） */
export interface ParentLsConnection {
    info: LsProcessInfo;
    port: number;
}

export interface LsModelResult {
    text: string | null;
    error?: string;
    timedOut?: boolean;
}

// ===== 模块状态 =====

let parentLs: ParentLsConnection | null = null;
let parentLsInitPromise: Promise<void> | null = null;
let parentLsInjectedForTest = false;

/** 获取已缓存的父 LS 连接（未就绪返回 null） */
export function getParentLs(): ParentLsConnection | null {
    return parentLs;
}

/** 检查 LS 是否可用 */
export function isLsReady(): boolean {
    return parentLs !== null;
}

export function __setParentLsForTest(connection: ParentLsConnection | null): void {
    parentLs = connection;
    parentLsInitPromise = null;
    parentLsInjectedForTest = connection !== null;
}

// ===== 父 LS 发现 =====

/**
 * 发现父 LS 进程（单 PID 精确查询）
 * 只查 process.ppid 一个进程
 */
function discoverParentLs(): LsProcessInfo | null {
    const ppid = process.ppid;
    try {
        const psScript = [
            `$ProgressPreference = 'SilentlyContinue'`,
            `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${ppid}" -ErrorAction SilentlyContinue`,
            `$ports = (Get-NetTCPConnection -OwningProcess ${ppid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort) -join ","`,
            `"${ppid}|$($p.CommandLine)|$ports"`,
        ].join('\n');
        const encodedCmd = Buffer.from(psScript, 'utf16le').toString('base64');
        const stdout = execSync(`powershell -NoProfile -EncodedCommand ${encodedCmd}`, {
            encoding: "utf-8",
            timeout: 10000,
            windowsHide: true,
        }).trim();

        if (!stdout) return null;
        const parts = stdout.split("|");
        if (parts.length < 3) return null;

        const cmd = parts[1];
        if (!cmd) return null;

        const csrfMatch = cmd.match(/--csrf_token\s+(\S+)/);
        if (!csrfMatch) return null;

        const wsMatch = cmd.match(/--workspace_id\s+(\S+)/);
        const workspaceId = wsMatch ? wsMatch[1] : "";

        const ports = parts[2]
            .split(",")
            .map(p => parseInt(p.trim(), 10))
            .filter(p => !isNaN(p))
            .sort((a, b) => a - b);

        if (ports.length === 0) return null;

        return { pid: ppid, csrfToken: csrfMatch[1], workspaceId, ports };
    } catch {
        return null;
    }
}

/**
 * 发现所有可疑的 Antigravity LS 进程
 * 优先级不在这里决定，只返回候选列表。
 */
function discoverAllLsCandidates(): LsProcessInfo[] {
    try {
        const psScript = [
            `$ProgressPreference = 'SilentlyContinue'`,
            `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'language_server*' } | ForEach-Object {`,
            `  $id = $_.Id`,
            `  $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue).CommandLine`,
            `  $ports = (Get-NetTCPConnection -OwningProcess $id -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort) -join ","`,
            `  "$id|$cmd|$ports"`,
            `}`,
        ].join("\n");
        const encodedCmd = Buffer.from(psScript, "utf16le").toString("base64");
        const stdout = execSync(`powershell -NoProfile -EncodedCommand ${encodedCmd}`, {
            encoding: "utf-8",
            timeout: 10000,
            windowsHide: true,
        }).trim();

        if (!stdout) return [];

        return stdout
            .split(/\r?\n/)
            .map((line) => {
                const parts = line.split("|");
                if (parts.length < 3) return null;
                const pid = parseInt(parts[0], 10);
                const cmd = parts[1];
                const csrfMatch = cmd?.match(/--csrf_token\s+(\S+)/);
                if (!cmd || !csrfMatch) return null;
                const wsMatch = cmd.match(/--workspace_id\s+(\S+)/);
                const workspaceId = wsMatch ? wsMatch[1] : "";
                const ports = parts[2]
                    .split(",")
                    .map(p => parseInt(p.trim(), 10))
                    .filter(p => !isNaN(p))
                    .sort((a, b) => a - b);
                if (ports.length === 0) return null;
                return { pid, csrfToken: csrfMatch[1], workspaceId, ports } as LsProcessInfo;
            })
            .filter((item): item is LsProcessInfo => item !== null);
    } catch {
        return [];
    }
}

// ===== HTTP / RPC =====

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
    payload: Record<string, unknown> = {},
    timeoutMs = 15000
): Promise<RpcResult> {
    const rpcPath = `/exa.language_server_pb.LanguageServerService/${method}`;
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
        data = resp.body;
    }

    return { status: resp.status, data, rawSize: resp.body?.length ?? 0 };
}

/**
 * 找到 LS 的有效 HTTP 端口（通过 Heartbeat 验证）
 */
async function findHttpPort(lsInfo: LsProcessInfo): Promise<number | null> {
    for (const port of lsInfo.ports) {
        try {
            const result = await rpcCall(lsInfo, port, "Heartbeat", {}, 5000);
            if (result.status === 200) return port;
        } catch { /* try next */ }
    }
    return null;
}

async function discoverBestLs(): Promise<ParentLsConnection | null> {
    const parentInfo = discoverParentLs();
    const candidates = parentInfo
        ? [parentInfo, ...discoverAllLsCandidates().filter(c => c.pid !== parentInfo.pid)]
        : discoverAllLsCandidates();

    for (const info of candidates) {
        const port = await findHttpPort(info);
        if (port) {
            return { info, port };
        }
    }
    return null;
}

// ===== 初始化 =====

/**
 * 异步初始化父 LS 连接（不阻塞工具注册，带重试）
 * 在 index.ts 的 main() 中调用
 */
export async function initParentLs(): Promise<void> {
    if (parentLs) return;
    if (parentLsInitPromise) return parentLsInitPromise;

    parentLsInitPromise = (async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
            const best = await discoverBestLs();
            if (!best) {
                console.error(`[ls-client] Antigravity LS 发现失败 (${attempt + 1}/3)，等待 2s 重试`);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            parentLs = best;
            console.error(`[ls-client] Antigravity LS 初始化成功: PID=${best.info.pid} port=${best.port}`);
            return;
        }
        console.error("[ls-client] Antigravity LS 初始化全部失败，LS 链路语义搜索将不可用");
        parentLs = null;
        parentLsInitPromise = null;
    })();

    return parentLsInitPromise;
}

// ===== GetModelResponse API =====

/** 默认超时 */
const DEFAULT_TIMEOUT = 30000;
const LS_WALL_CLOCK_TIMEOUT = Symbol("LS_WALL_CLOCK_TIMEOUT");
const DEFAULT_LS_MODEL = "MODEL_PLACEHOLDER_M132";
const DEFAULT_LS_MODEL_FALLBACKS = [
    "MODEL_PLACEHOLDER_M132",
    "MODEL_PLACEHOLDER_M20",
    "MODEL_PLACEHOLDER_M18",
    "MODEL_PLACEHOLDER_M16",
    "MODEL_PLACEHOLDER_M36",
];
const DEPRECATED_LS_RAW_MODELS: Record<string, string> = {
    "MODEL_PLACEHOLDER_M37": "MODEL_PLACEHOLDER_M16",
    "MODEL_PLACEHOLDER_M47": "MODEL_PLACEHOLDER_M18",
    "MODEL_GOOGLE_GEMINI_2_5_FLASH": "MODEL_PLACEHOLDER_M132",
    "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE": "MODEL_PLACEHOLDER_M20",
};
const LS_MODEL_ALIASES: Record<string, string> = {
    "m132": "MODEL_PLACEHOLDER_M132",
    "fast": "MODEL_PLACEHOLDER_M132",
    "default": "MODEL_PLACEHOLDER_M132",
    "ag-fast": "MODEL_PLACEHOLDER_M132",
    "flash": "MODEL_PLACEHOLDER_M132",
    "gemini-flash": "MODEL_PLACEHOLDER_M132",
    "gemini-3.5-flash-high": "MODEL_PLACEHOLDER_M132",
    "gemini-35-flash-high": "MODEL_PLACEHOLDER_M132",
    "gemini-3-flash-agent": "MODEL_PLACEHOLDER_M132",
    "m20": "MODEL_PLACEHOLDER_M20",
    "flash-medium": "MODEL_PLACEHOLDER_M20",
    "gemini-3.5-flash-medium": "MODEL_PLACEHOLDER_M20",
    "gemini-35-flash-medium": "MODEL_PLACEHOLDER_M20",
    "gemini-3.5-flash-low": "MODEL_PLACEHOLDER_M20",
    "gemini-35-flash-low": "MODEL_PLACEHOLDER_M20",
    "m18": "MODEL_PLACEHOLDER_M18",
    "gemini-3-flash": "MODEL_PLACEHOLDER_M18",
    "m16": "MODEL_PLACEHOLDER_M16",
    "m37": "MODEL_PLACEHOLDER_M16",
    "pro": "MODEL_PLACEHOLDER_M16",
    "pro-high": "MODEL_PLACEHOLDER_M16",
    "gemini-pro": "MODEL_PLACEHOLDER_M16",
    "gemini-3.1-pro": "MODEL_PLACEHOLDER_M16",
    "gemini-31-pro": "MODEL_PLACEHOLDER_M16",
    "gemini-3.1-pro-high": "MODEL_PLACEHOLDER_M16",
    "gemini-31-pro-high": "MODEL_PLACEHOLDER_M16",
    "m36": "MODEL_PLACEHOLDER_M36",
    "pro-low": "MODEL_PLACEHOLDER_M36",
    "gemini-3.1-pro-low": "MODEL_PLACEHOLDER_M36",
    "gemini-31-pro-low": "MODEL_PLACEHOLDER_M36",
    "m35": "MODEL_PLACEHOLDER_M35",
    "claude-sonnet": "MODEL_PLACEHOLDER_M35",
    "claude-4.6-sonnet": "MODEL_PLACEHOLDER_M35",
    "claude-46-sonnet": "MODEL_PLACEHOLDER_M35",
    "sonnet": "MODEL_PLACEHOLDER_M35",
    "m26": "MODEL_PLACEHOLDER_M26",
    "claude-opus": "MODEL_PLACEHOLDER_M26",
    "claude-4.6-opus": "MODEL_PLACEHOLDER_M26",
    "claude-46-opus": "MODEL_PLACEHOLDER_M26",
    "opus": "MODEL_PLACEHOLDER_M26",
    "gemini-2.5-flash": "MODEL_PLACEHOLDER_M132",
    "gemini-25-flash": "MODEL_PLACEHOLDER_M132",
    "2.5-flash": "MODEL_PLACEHOLDER_M132",
    "gemini-2.5-flash-lite": "MODEL_PLACEHOLDER_M20",
    "gemini-25-flash-lite": "MODEL_PLACEHOLDER_M20",
    "2.5-flash-lite": "MODEL_PLACEHOLDER_M20",
    "flash-lite": "MODEL_PLACEHOLDER_M20",
    "lite": "MODEL_PLACEHOLDER_M20",
    "m47": "MODEL_PLACEHOLDER_M18",
};

export function resolveLsModelName(model: string): string {
    const raw = (model || "").trim();
    if (!raw) return DEFAULT_LS_MODEL;
    if (/^MODEL_/u.test(raw)) return DEPRECATED_LS_RAW_MODELS[raw] || raw;
    const key = raw.toLowerCase().replace(/_/gu, "-");
    return LS_MODEL_ALIASES[key] || raw;
}

function getConfiguredLsFallbacks(): string[] {
    const rawFallbacks = process.env.SANDBOX_LS_MODEL_FALLBACKS;
    const items = rawFallbacks
        ? rawFallbacks.split(",").map((item) => item.trim()).filter(Boolean)
        : DEFAULT_LS_MODEL_FALLBACKS;
    const resolvedItems = items.map(resolveLsModelName).filter(Boolean);
    return [...new Set(resolvedItems)];
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err ?? "");
}

function isTimeoutError(err: unknown): boolean {
    if (err === LS_WALL_CLOCK_TIMEOUT) return true;
    return /(?:^|: )Request timeout(?:$|[ |])/u.test(errorMessage(err));
}

function withWallClockTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(LS_WALL_CLOCK_TIMEOUT);
        }, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            (err) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            },
        );
    });
}

/**
 * 调用 LS GetModelResponse 生成 AI 回复
 * @param model 模型名（如 "M132" / "flash" / "gemini-3.1-pro-high"）
 * @param prompt 提示词
 * @param timeoutMs 超时（默认 30s）
 */
function getLsModelCandidates(model: string): string[] {
    const raw = (model || "").trim();
    const key = raw.toLowerCase().replace(/_/gu, "-");
    const resolved = resolveLsModelName(model);
    const candidates = [resolved];
    if (raw && raw !== resolved && !LS_MODEL_ALIASES[key] && !DEPRECATED_LS_RAW_MODELS[raw]) {
        candidates.push(raw);
    }
    const fallbacks = getConfiguredLsFallbacks();
    const fallbackStart = fallbacks.indexOf(resolved);
    const fallbackCandidates = fallbackStart >= 0 ? fallbacks.slice(fallbackStart) : [];
    for (const fallback of fallbackCandidates) {
        if (!candidates.includes(fallback)) candidates.push(fallback);
    }
    return candidates;
}

function describeModelCandidate(original: string, candidate: string): string {
    const resolved = resolveLsModelName(original);
    if (candidate === resolved && candidate !== original) {
        return `alias: ${original} -> ${candidate}`;
    }
    return `fallback: ${original} -> ${candidate}`;
}

async function callGetModelResponseOn(
    info: LsProcessInfo,
    port: number,
    model: string,
    prompt: string,
    timeout: number
): Promise<string | null> {
    const errors: string[] = [];
    for (const candidate of getLsModelCandidates(model)) {
        try {
            const result = await rpcCall(info, port, "GetModelResponse", { model: candidate, prompt }, timeout);
            if (result.status < 200 || result.status >= 300) {
                errors.push(`${candidate}: LS GetModelResponse HTTP ${result.status}`);
                continue;
            }
            const text = result.data?.response ?? null;
            if (text) {
                if (candidate !== model) {
                    console.error(`[ls-client] GetModelResponse model ${describeModelCandidate(model, candidate)}`);
                }
                return text;
            }
            errors.push(`${candidate}: Antigravity LS 模型返回为空`);
        } catch (err) {
            errors.push(`${candidate}: ${errorMessage(err)}`);
        }
    }
    throw new Error(`LS GetModelResponse 候选全部失败: ${errors.join(" | ")}`);
}

async function callGetModelResponseWithDiscovery(
    model: string,
    prompt: string,
    timeout: number
): Promise<string | null> {
    const tried = new Set<number>();
    const errors: string[] = [];
    if (parentLs) {
        const currentParent = parentLs;
        try {
            const text = await callGetModelResponseOn(currentParent.info, currentParent.port, model, prompt, timeout);
            if (text) return text;
            tried.add(currentParent.info.pid);
        } catch (err) {
            tried.add(currentParent.info.pid);
            const message = `PID=${currentParent.info.pid} port=${currentParent.port}: ${errorMessage(err)}`;
            errors.push(message);
            console.error(`[ls-client] LS model call failed: ${message}`);
            if (parentLsInjectedForTest) {
                throw new Error(`Antigravity LS 候选全部失败: ${errors.join(" | ")}`);
            }
            parentLs = null;
            parentLsInitPromise = null;
        }
    }

    const candidates = discoverAllLsCandidates()
        .filter((info) => !tried.has(info.pid));
    for (const info of candidates) {
        const port = await findHttpPort(info);
        if (!port) {
            tried.add(info.pid);
            continue;
        }
        try {
            const text = await callGetModelResponseOn(info, port, model, prompt, timeout);
            if (text) {
                parentLs = { info, port };
                parentLsInitPromise = null;
                return text;
            }
        } catch (err) {
            tried.add(info.pid);
            const message = `PID=${info.pid} port=${port}: ${errorMessage(err)}`;
            errors.push(message);
            console.error(`[ls-client] LS model call failed: ${message}`);
        }
    }

    const best = await discoverBestLs();
    if (!best || tried.has(best.info.pid)) {
        if (errors.length > 0) {
            throw new Error(`Antigravity LS 候选全部失败: ${errors.join(" | ")}`);
        }
        return null;
    }
    parentLs = best;
    try {
        return await callGetModelResponseOn(best.info, best.port, model, prompt, timeout);
    } catch (err) {
        const message = `PID=${best.info.pid} port=${best.port}: ${errorMessage(err)}`;
        console.error(`[ls-client] LS model call failed: ${message}`);
        throw new Error(`Antigravity LS 候选全部失败: ${[...errors, message].join(" | ")}`);
    }
}

export async function callGetModelResponseDetailed(
    model: string,
    prompt: string,
    timeoutMs?: number
): Promise<LsModelResult> {
    const timeout = timeoutMs || DEFAULT_TIMEOUT;
    try {
        const text = await withWallClockTimeout(
            callGetModelResponseWithDiscovery(model, prompt, timeout),
            timeout,
        );
        if (text) return { text };
        return { text: null, error: "Antigravity LS 模型返回为空", timedOut: false };
    } catch (err) {
        const timedOut = isTimeoutError(err);
        const message = err === LS_WALL_CLOCK_TIMEOUT
            ? `Antigravity LS 模型调用超时（${timeout}ms）`
            : `Antigravity LS 模型调用失败: ${errorMessage(err)}`;
        return { text: null, error: message, timedOut };
    }
}

export async function callGetModelResponse(
    model: string,
    prompt: string,
    timeoutMs?: number
): Promise<string | null> {
    const result = await callGetModelResponseDetailed(model, prompt, timeoutMs);
    return result.text;
}
