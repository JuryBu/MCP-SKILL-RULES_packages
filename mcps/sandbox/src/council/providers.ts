import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { callGetModelResponseDetailed } from "../ls-client.js";
import { callCodexText } from "../model-bridge.js";
import { callClaudeCodeText, claudeCodeOptionsFromParams } from "../claude-code-bridge.js";
import { TEMP_DIR, ensureTempDir } from "../temp-store.js";
import type { CouncilModelConfig } from "./types.js";

const DEFAULT_OPENAI_MODEL = "gpt-5.4";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_GEMINI_CLI_MODEL = process.env.SANDBOX_COUNCIL_GEMINI_CLI_MODEL || "auto-gemini-3";
const DEFAULT_CLAUDE_CODE_MODEL = process.env.SANDBOX_COUNCIL_CLAUDE_CODE_MODEL || process.env.SANDBOX_CLAUDE_CODE_MODEL || "sonnet";
const DEFAULT_GEMINI_CLI_APPROVAL_MODE = process.env.SANDBOX_COUNCIL_GEMINI_CLI_APPROVAL_MODE || "yolo";
const DEFAULT_ANTIGRAVITY_MODEL = process.env.SANDBOX_COUNCIL_ANTIGRAVITY_MODEL || process.env.SANDBOX_LS_MODEL || "MODEL_PLACEHOLDER_M132";
const DEFAULT_CODEX_MODEL = "gpt-5.4";
const DEFAULT_CODEX_MINI_MODEL = "gpt-5.4-mini";
const DEFAULT_CODEX_REASONING = process.env.SANDBOX_CODEX_REASONING || "medium";
export const DEFAULT_COUNCIL_MODEL_TIMEOUT_MS = Number(process.env.SANDBOX_COUNCIL_MODEL_TIMEOUT_MS || 120000);
const DEFAULT_RETRIES = Math.max(0, Math.min(Number(process.env.SANDBOX_COUNCIL_MODEL_RETRIES ?? 1), 3));
const DEFAULT_RETRY_BACKOFF_MS = Math.max(0, Number(process.env.SANDBOX_COUNCIL_MODEL_RETRY_BACKOFF_MS || 600));
const DEFAULT_CODEX_FALLBACKS_ENABLED = !/^(0|false|off)$/iu.test(process.env.SANDBOX_COUNCIL_CODEX_DEFAULT_FALLBACKS || "");
const DEFAULT_GEMINI_CLI_FALLBACKS_ENABLED = !/^(0|false|off)$/iu.test(process.env.SANDBOX_COUNCIL_GEMINI_CLI_DEFAULT_FALLBACKS || "");
const GEMINI_CLI_RESPONSE_START = "<<<COUNCIL_GEMINI_CLI_RESPONSE>>>";
const GEMINI_CLI_RESPONSE_END = "<<<END_COUNCIL_GEMINI_CLI_RESPONSE>>>";
const GEMINI_CLI_MAX_OUTPUT_BYTES = Number(process.env.SANDBOX_COUNCIL_GEMINI_CLI_MAX_BYTES || 768 * 1024);
const DEFAULT_SOURCE_LIMITS: Record<string, number> = {
    antigravity: Math.max(1, Number(process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CONCURRENCY || 2)),
    codex: Math.max(1, Number(process.env.SANDBOX_COUNCIL_CODEX_CONCURRENCY || 2)),
    openai: Math.max(1, Number(process.env.SANDBOX_COUNCIL_OPENAI_CONCURRENCY || 4)),
    anthropic: Math.max(1, Number(process.env.SANDBOX_COUNCIL_ANTHROPIC_CONCURRENCY || 4)),
    gemini: Math.max(1, Number(process.env.SANDBOX_COUNCIL_GEMINI_CONCURRENCY || 4)),
    geminiCli: Math.max(1, Number(process.env.SANDBOX_COUNCIL_GEMINI_CLI_CONCURRENCY || 2)),
    claudeCode: Math.max(1, Number(process.env.SANDBOX_COUNCIL_CLAUDE_CODE_CONCURRENCY || 1)),
    customOpenAICompatible: Math.max(1, Number(process.env.SANDBOX_COUNCIL_CUSTOM_OPENAI_CONCURRENCY || 2)),
};

class Semaphore {
    private active = 0;
    private readonly queue: Array<() => void> = [];

    constructor(private readonly limit: number) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    private acquire(): Promise<void> {
        if (this.active < this.limit) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.queue.push(() => {
                this.active++;
                resolve();
            });
        });
    }

    private release(): void {
        this.active = Math.max(0, this.active - 1);
        const next = this.queue.shift();
        if (next) next();
    }
}

const sourceLimiters = new Map<string, Semaphore>();

interface ImageInput {
    path: string;
    mimeType: string;
    data: string;
    dataUrl: string;
}

export interface ProviderCallResult {
    text: string;
    provider: string;
    model: string;
    metadata?: Record<string, unknown>;
}

interface FallbackModelObject {
    provider?: unknown;
    model?: unknown;
    params?: unknown;
    supportsVision?: unknown;
}

interface SpawnResult {
    exitCode: number | null;
    timedOut: boolean;
    stdoutPath: string;
    stderrPath: string;
    earlyFailureReason?: string;
}

interface ProviderError extends Error {
    retryable?: boolean;
    timedOut?: boolean;
}

function makeProviderAbortError(): ProviderError {
    const err = new Error("council model call cancelled by background abort") as ProviderError;
    err.retryable = false;
    return err;
}

function assertProviderNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw makeProviderAbortError();
}

function getStringParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
    const value = params?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getNumberParam(params: Record<string, unknown> | undefined, key: string): number | undefined {
    const value = params?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clip(text: string, maxChars: number): string {
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... (truncated ${text.length - maxChars} chars)`;
}

function safeName(input: string): string {
    return input.replace(/[^\w.-]+/gu, "_").slice(0, 80) || "model";
}

function safeGeminiTempProjectName(cwd: string): string {
    const basename = path.basename(path.resolve(cwd)) || "mcp-sandbox";
    return basename
        .normalize("NFKD")
        .replace(/[^\w.-]+/gu, "")
        .toLowerCase()
        .slice(0, 48) || "mcp-sandbox";
}

function nowStamp(): string {
    const now = new Date();
    const random = Math.random().toString(36).slice(2, 8);
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}-${process.pid}-${random}`;
}

function geminiCliAccessibleTempDir(cwd: string, childDir: string): string {
    const configured = process.env.SANDBOX_COUNCIL_GEMINI_CLI_TEMP_DIR;
    const base = configured && configured.trim()
        ? configured.trim()
        : path.join(os.homedir(), ".gemini", "tmp", safeGeminiTempProjectName(cwd));
    const dir = path.join(base, childDir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function killProcessTree(pid?: number): void {
    if (!pid) return;
    try {
        const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
        });
        killer.unref();
    } catch {
        // Best-effort cleanup; the direct child kill below is still attempted.
    }
}

function councilModelCallDir(): string {
    ensureTempDir();
    const dir = path.join(TEMP_DIR, "council-model-calls");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function psSingleQuoted(text: string): string {
    return `'${text.replace(/'/gu, "''")}'`;
}

function getPowerShellCommand(): string {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    if (systemRoot) {
        const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        if (fs.existsSync(candidate)) return candidate;
    }
    return "powershell.exe";
}

function killProcessesByCommandNeedle(needle: string): void {
    if (!needle || needle.length < 12) return;
    const escaped = needle.replace(/'/gu, "''");
    const script = [
        `$needle = '${escaped}'`,
        "$self = $PID",
        "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -like \"*$needle*\" } | ForEach-Object {",
        "  try { taskkill.exe /PID $_.ProcessId /T /F | Out-Null } catch {}",
        "}",
    ].join("\n");
    try {
        spawnSync(getPowerShellCommand(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
            windowsHide: true,
            stdio: "ignore",
            timeout: 5000,
        });
    } catch {
        // Best-effort cleanup only.
    }
}

function readClip(filePath: string, maxChars: number): string {
    try {
        if (!fs.existsSync(filePath)) return "";
        const stat = fs.statSync(filePath);
        const byteBudget = Math.min(stat.size, Math.max(maxChars * 4, 4096));
        const fd = fs.openSync(filePath, "r");
        try {
            const buffer = Buffer.alloc(byteBudget);
            const bytesRead = fs.readSync(fd, buffer, 0, byteBudget, 0);
            return clip(buffer.subarray(0, bytesRead).toString("utf-8"), maxChars);
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return "";
    }
}

function getEarlyCliFailureReason(text: string): string | undefined {
    if (/MODEL_CAPACITY_EXHAUSTED|RESOURCE_EXHAUSTED|No capacity available/iu.test(text)) {
        return "Gemini CLI model capacity exhausted";
    }
    if (/Path not in workspace|resolves outside the allowed workspace directories/iu.test(text)) {
        return "Gemini CLI workspace path rejected";
    }
    if (/AttachConsole failed/iu.test(text)) {
        return "Gemini CLI terminal attachment failed";
    }
    return undefined;
}

async function spawnPowerShellScript(
    script: string,
    cwd: string,
    logBasePath: string,
    timeoutMs: number,
    earlyFailure?: (stderr: string) => string | undefined,
    signal?: AbortSignal,
): Promise<SpawnResult> {
    const scriptPath = `${logBasePath}.ps1`;
    const stdoutPath = `${logBasePath}.stdout.txt`;
    const stderrPath = `${logBasePath}.stderr.txt`;
    const artifactNeedle = path.basename(logBasePath).replace(/\.run$/u, "");
    fs.writeFileSync(scriptPath, script, "utf-8");
    fs.writeFileSync(stdoutPath, "", "utf-8");
    fs.writeFileSync(stderrPath, "", "utf-8");
    return await new Promise<SpawnResult>((resolve, reject) => {
        const stdoutFd = fs.openSync(stdoutPath, "a");
        const stderrFd = fs.openSync(stderrPath, "a");
        let settled = false;
        let timedOut = false;
        let aborted = false;
        let earlyFailureReason: string | undefined;
        const child = spawn(getPowerShellCommand(), [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
        ], {
            cwd,
            windowsHide: true,
            stdio: ["ignore", stdoutFd, stderrFd],
        });
        const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child.pid);
            child.kill();
        }, timeoutMs);
        const earlyFailureTimer = earlyFailure ? setInterval(() => {
            const stderr = readClip(stderrPath, 4096);
            const reason = earlyFailure(stderr);
            if (!reason) return;
            earlyFailureReason = reason;
            killProcessTree(child.pid);
            killProcessesByCommandNeedle(artifactNeedle);
            child.kill();
        }, 1500) : null;
        earlyFailureTimer?.unref?.();
        const onAbort = () => {
            if (settled) return;
            aborted = true;
            killProcessTree(child.pid);
            killProcessesByCommandNeedle(artifactNeedle);
            child.kill();
        };
        const clearTimers = () => {
            clearTimeout(timer);
            if (earlyFailureTimer) clearInterval(earlyFailureTimer);
            signal?.removeEventListener("abort", onAbort);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        child.on("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimers();
            fs.closeSync(stdoutFd);
            fs.closeSync(stderrFd);
            reject(err);
        });
        child.on("close", (exitCode) => {
            if (settled) return;
            settled = true;
            clearTimers();
            fs.closeSync(stdoutFd);
            fs.closeSync(stderrFd);
            if (timedOut || earlyFailureReason) {
                killProcessesByCommandNeedle(artifactNeedle);
            }
            if (aborted) {
                reject(makeProviderAbortError());
                return;
            }
            resolve({ exitCode, timedOut, stdoutPath, stderrPath, earlyFailureReason });
        });
    });
}

function getRetryCount(params: Record<string, unknown> | undefined): number {
    const explicit = getNumberParam(params, "retries") ?? getNumberParam(params, "retry") ?? getNumberParam(params, "maxRetries");
    return Math.max(0, Math.min(explicit ?? DEFAULT_RETRIES, 3));
}

function getRetryBackoffMs(params: Record<string, unknown> | undefined): number {
    const explicit = getNumberParam(params, "retryBackoffMs") ?? getNumberParam(params, "backoffMs");
    return Math.max(0, explicit ?? DEFAULT_RETRY_BACKOFF_MS);
}

function getDefaultModel(config: CouncilModelConfig): string {
    return config.model || (
        config.provider === "openai" ? DEFAULT_OPENAI_MODEL :
        config.provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL :
        config.provider === "gemini" ? DEFAULT_GEMINI_MODEL :
        config.provider === "geminiCli" ? DEFAULT_GEMINI_CLI_MODEL :
        config.provider === "claudeCode" ? DEFAULT_CLAUDE_CODE_MODEL :
        config.provider === "codex" ? DEFAULT_CODEX_MODEL :
        DEFAULT_ANTIGRAVITY_MODEL
    );
}

function getCodexReasoningParam(params: Record<string, unknown> | undefined): string | undefined {
    return getStringParam(params, "reasoning")
        || getStringParam(params, "reasoningEffort")
        || getStringParam(params, "model_reasoning_effort");
}

function getCodexReasoning(config: CouncilModelConfig): string {
    return (getCodexReasoningParam(config.params) || DEFAULT_CODEX_REASONING).toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutFallbackParams(params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!params) return undefined;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
        if (["fallbackModel", "fallbackModels", "fallbacks"].includes(key)) continue;
        next[key] = value;
    }
    return next;
}

function getFallbackConfig(config: CouncilModelConfig, spec: unknown): CouncilModelConfig {
    const baseParams = withoutFallbackParams(config.params);
    if (typeof spec === "string" && spec.trim()) {
        return { ...config, model: spec.trim(), params: baseParams };
    }
    if (!isRecord(spec)) {
        throw new Error("fallbackModels 只支持字符串模型名，或 {model, params, supportsVision} 对象");
    }
    const fallback = spec as FallbackModelObject;
    const provider = typeof fallback.provider === "string" && fallback.provider.trim()
        ? fallback.provider.trim()
        : config.provider;
    if (provider !== config.provider) {
        throw new Error(`fallbackModels 只支持同 provider 降级：${config.provider} 不能 fallback 到 ${provider}`);
    }
    const fallbackParams = isRecord(fallback.params) ? fallback.params : undefined;
    return {
        ...config,
        model: typeof fallback.model === "string" && fallback.model.trim() ? fallback.model.trim() : config.model,
        params: { ...(baseParams || {}), ...(fallbackParams || {}) },
        supportsVision: typeof fallback.supportsVision === "boolean" ? fallback.supportsVision : config.supportsVision,
    };
}

function getDefaultFallbackConfigs(config: CouncilModelConfig): CouncilModelConfig[] {
    if (config.provider === "geminiCli") {
        if (!DEFAULT_GEMINI_CLI_FALLBACKS_ENABLED) return [];
        const model = getDefaultModel(config);
        const baseParams = withoutFallbackParams(config.params) || {};
        const chain = (process.env.SANDBOX_COUNCIL_GEMINI_CLI_MODEL_CHAIN || [
            "auto-gemini-3",
            "gemini-3.1-pro-preview",
            "gemini-2.5-pro",
            "gemini-3.1-flash-lite-preview",
            "gemini-2.5-flash-lite",
        ].join(",")).split(",").map((item) => item.trim()).filter(Boolean);
        const currentIndex = chain.findIndex((item) => item === model);
        const candidates = currentIndex >= 0 ? chain.slice(currentIndex + 1) : chain.filter((item) => item !== model);
        const seen = new Set([model]);
        return candidates
            .filter((item) => {
                if (seen.has(item)) return false;
                seen.add(item);
                return true;
            })
            .map((item) => ({
                ...config,
                model: item,
                params: baseParams,
            }));
    }

    if (!DEFAULT_CODEX_FALLBACKS_ENABLED || config.provider !== "codex") return [];

    const model = getDefaultModel(config);
    const currentReasoning = getCodexReasoning(config);
    const baseParams = withoutFallbackParams(config.params) || {};
    const chain = model === DEFAULT_CODEX_MODEL
        ? [
            { model: DEFAULT_CODEX_MODEL, reasoning: "high" },
            { model: DEFAULT_CODEX_MODEL, reasoning: "medium" },
            { model: DEFAULT_CODEX_MODEL, reasoning: "low" },
            { model: DEFAULT_CODEX_MINI_MODEL, reasoning: "medium" },
            { model: DEFAULT_CODEX_MINI_MODEL, reasoning: "low" },
        ]
        : model === DEFAULT_CODEX_MINI_MODEL
            ? [
                { model: DEFAULT_CODEX_MINI_MODEL, reasoning: "medium" },
                { model: DEFAULT_CODEX_MINI_MODEL, reasoning: "low" },
            ]
            : [];
    if (chain.length === 0) return [];

    const currentIndex = chain.findIndex((item) => item.model === model && item.reasoning === currentReasoning);
    const candidates = currentIndex >= 0 ? chain.slice(currentIndex + 1) : chain;
    const seen = new Set([`${model}:${currentReasoning}`]);

    return candidates
        .filter((item) => {
            const key = `${item.model}:${item.reasoning}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .map((item) => ({
            ...config,
            model: item.model,
            params: { ...baseParams, reasoning: item.reasoning },
        }));
}

function getFallbackConfigs(config: CouncilModelConfig): CouncilModelConfig[] {
    const raw = config.params?.fallbackModels ?? config.params?.fallbacks ?? config.params?.fallbackModel;
    if (raw === undefined) return getDefaultFallbackConfigs(config);
    const specs = Array.isArray(raw) ? raw : [raw];
    return specs
        .filter((spec) => spec !== undefined && spec !== null && spec !== "")
        .map((spec) => getFallbackConfig(config, spec));
}

function describeModelConfig(config: CouncilModelConfig): string {
    if (config.provider === "codex") {
        return `${config.provider}:${getDefaultModel(config)}(reasoning=${getCodexReasoning(config)})`;
    }
    return `${config.provider}:${getDefaultModel(config)}`;
}

function getConcurrencyLimit(config: CouncilModelConfig): number {
    const explicit = getNumberParam(config.params, "maxConcurrency") ?? getNumberParam(config.params, "concurrency");
    if (explicit) return Math.max(1, Math.min(explicit, 8));
    return DEFAULT_SOURCE_LIMITS[config.provider] || 2;
}

function normalizeSource(value: string | undefined): string {
    if (!value) return "default";
    try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}${url.pathname.replace(/\/chat\/completions$/u, "").replace(/\/responses$/u, "").replace(/\/$/u, "")}`;
    } catch {
        return value.replace(/\/chat\/completions$/u, "").replace(/\/responses$/u, "").replace(/\/$/u, "");
    }
}

function getSourceKey(config: CouncilModelConfig): string {
    const explicitSource = getStringParam(config.params, "sourceKey") || getStringParam(config.params, "source");
    if (explicitSource) return `${config.provider}:${explicitSource}`;
    if (config.provider === "customOpenAICompatible") {
        const baseUrl = getStringParam(config.params, "baseUrl") || getStringParam(config.params, "endpoint");
        return `${config.provider}:${normalizeSource(baseUrl)}`;
    }
    if (config.provider === "openai" || config.provider === "anthropic" || config.provider === "gemini") {
        const endpoint = getStringParam(config.params, "endpoint");
        return `${config.provider}:${normalizeSource(endpoint)}`;
    }
    return config.provider;
}

async function withSourceLimit<T>(config: CouncilModelConfig, fn: () => Promise<T>): Promise<T> {
    const key = getSourceKey(config);
    const limit = getConcurrencyLimit(config);
    const mapKey = `${key}:limit=${limit}`;
    let limiter = sourceLimiters.get(mapKey);
    if (!limiter) {
        limiter = new Semaphore(limit);
        sourceLimiters.set(mapKey, limiter);
    }
    return limiter.run(fn);
}

function isRetryableError(err: unknown): boolean {
    if (err && typeof err === "object") {
        const providerErr = err as ProviderError;
        if (typeof providerErr.retryable === "boolean") return providerErr.retryable;
        if (providerErr.timedOut === true) return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/缺少 API key|需要 params\.baseUrl|不支持图片 MIME|图片过大|图片总大小过大|输出疑似被截断|内容被安全策略拦截|未登录|认证失败|max-budget|budget|额度耗尽|permission|权限|Unknown option|invalid/i.test(message)) {
        return false;
    }
    if (/cancelled by background abort|background abort|已取消/iu.test(message)) {
        return false;
    }
    if (/HTTP 4\d\d/iu.test(message) && !/HTTP (408|409|429)/iu.test(message)) {
        return false;
    }
    if (/Antigravity LS 模型返回为空/iu.test(message)) {
        return false;
    }
    return /HTTP (408|409|429|500|502|503|504)|timeout|timed out|abort|aborted|中止|超时|未返回文本|CLI 未写入|Gemini CLI|Claude Code CLI|RESOURCE_EXHAUSTED|MODEL_CAPACITY_EXHAUSTED|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Antigravity LS 模型调用超时/iu.test(message);
}

async function withRetry<T>(config: CouncilModelConfig, fn: () => Promise<T>): Promise<T> {
    const retries = getRetryCount(config.params);
    const backoffMs = getRetryBackoffMs(config.params);
    let lastErr: unknown;
    let attempts = 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
        attempts = attempt + 1;
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (attempt >= retries || !isRetryableError(err)) break;
            if (backoffMs > 0) {
                await sleep(backoffMs * Math.max(1, attempt + 1));
            }
        }
    }
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(retries > 0 ? `${message} (attempts=${attempts}/${retries + 1})` : message);
}

function readApiKey(config: CouncilModelConfig, defaultEnv: string): string {
    const envName = getStringParam(config.params, "apiKeyEnv") || defaultEnv;
    const key = process.env[envName];
    if (!key) {
        throw new Error(`${config.provider} 缺少 API key：请设置 ${envName}`);
    }
    return key;
}

function mimeFromPath(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".png") return "image/png";
    if (ext === ".webp") return "image/webp";
    if (ext === ".gif") return "image/gif";
    if (ext === ".heic") return "image/heic";
    if (ext === ".heif") return "image/heif";
    return "image/jpeg";
}

function getRecordParam(params: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
    const value = params?.[key];
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getHeadersParam(params: Record<string, unknown> | undefined): Record<string, string> {
    const raw = getRecordParam(params, "headers");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
        const lower = key.toLowerCase();
        if (["authorization", "x-api-key", "x-goog-api-key", "anthropic-version", "content-type"].includes(lower)) {
            continue;
        }
        if (typeof value === "string") headers[key] = value;
    }
    return headers;
}

function getSafeBodyOverrides(params: Record<string, unknown> | undefined, deniedKeys: string[]): Record<string, unknown> {
    const raw = getRecordParam(params, "body");
    const denied = new Set(deniedKeys.map((key) => key.toLowerCase()));
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (denied.has(key.toLowerCase())) continue;
        safe[key] = value;
    }
    return safe;
}

function assertProviderImageMime(provider: string, mimeType: string): void {
    const common = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    const gemini = [...common, "image/heic", "image/heif"];
    const allowed = provider === "gemini" || provider === "geminiCli" ? gemini : common;
    if (!allowed.includes(mimeType)) {
        throw new Error(`${provider} 不支持图片 MIME: ${mimeType}`);
    }
}

function loadImages(imagePaths: string[], allowImages: boolean, provider: string): ImageInput[] {
    if (!allowImages) return [];
    const maxBytes = Number(process.env.SANDBOX_COUNCIL_IMAGE_MAX_BYTES || 8 * 1024 * 1024);
    let totalBytes = 0;
    return imagePaths.map((imagePath) => {
        const resolved = path.resolve(imagePath);
        const stat = fs.statSync(resolved);
        if (stat.size > maxBytes) {
            throw new Error(`图片过大: ${resolved} (${stat.size} bytes > ${maxBytes})`);
        }
        totalBytes += stat.size;
        if (totalBytes > maxBytes * 2) {
            throw new Error(`图片总大小过大: ${totalBytes} bytes > ${maxBytes * 2}`);
        }
        const mimeType = mimeFromPath(resolved);
        assertProviderImageMime(provider, mimeType);
        const data = fs.readFileSync(resolved).toString("base64");
        return {
            path: resolved,
            mimeType,
            data,
            dataUrl: `data:${mimeType};base64,${data}`,
        };
    });
}

function extractOpenAIText(data: any): string {
    if (typeof data?.output_text === "string") return data.output_text.trim();
    const parts: string[] = [];
    for (const item of data?.output || []) {
        for (const content of item?.content || []) {
            if (typeof content?.text === "string") parts.push(content.text);
        }
    }
    return parts.join("\n").trim();
}

function assertNotTruncated(provider: string, data: any): void {
    if (provider === "openai") {
        if (data?.status === "incomplete") {
            const reason = data?.incomplete_details?.reason || "unknown";
            throw new Error(`OpenAI Responses API 输出疑似被截断: ${reason}`);
        }
        const outputReasons = (data?.output || []).map((item: any) => item?.finish_reason || item?.status).filter(Boolean);
        if (outputReasons.some((reason: string) => /length|max_tokens|incomplete/iu.test(reason))) {
            throw new Error(`OpenAI Responses API 输出疑似被截断: ${outputReasons.join(", ")}`);
        }
        return;
    }
    if (provider === "anthropic") {
        if (data?.stop_reason === "max_tokens") {
            throw new Error("Anthropic Messages API 输出疑似被截断: max_tokens");
        }
        return;
    }
    if (provider === "gemini") {
        const reasons = (data?.candidates || []).map((candidate: any) => candidate?.finishReason).filter(Boolean);
        const blocked = (data?.promptFeedback?.blockReason || reasons.find((reason: string) => /SAFETY|BLOCK/iu.test(reason)));
        if (blocked) throw new Error(`Gemini generateContent 内容被安全策略拦截: ${blocked}`);
        if (reasons.some((reason: string) => /MAX_TOKENS|RECITATION|OTHER/iu.test(reason))) {
            throw new Error(`Gemini generateContent 输出疑似被截断: ${reasons.join(", ")}`);
        }
        return;
    }
    if (provider === "customOpenAICompatible") {
        const reasons = (data?.choices || []).map((choice: any) => choice?.finish_reason).filter(Boolean);
        if (reasons.some((reason: string) => /length|max_tokens/iu.test(reason))) {
            throw new Error(`OpenAI-compatible endpoint 输出疑似被截断: ${reasons.join(", ")}`);
        }
    }
}

function extractAnthropicText(data: any): string {
    return (data?.content || [])
        .map((part: any) => typeof part?.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n")
        .trim();
}

function extractGeminiText(data: any): string {
    return (data?.candidates || [])
        .flatMap((candidate: any) => candidate?.content?.parts || [])
        .map((part: any) => typeof part?.text === "string" ? part.text : "")
        .filter(Boolean)
        .join("\n")
        .trim();
}

function extractChatText(data: any): string {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
        return content.map((item) => item?.text || "").filter(Boolean).join("\n").trim();
    }
    return "";
}

function extractMarkedSection(text: string, startMarker: string, endMarker: string, artifactPath: string): string {
    const end = text.lastIndexOf(endMarker);
    const start = end >= 0 ? text.lastIndexOf(startMarker, end) : -1;
    if (start >= 0 && end > start) {
        return text.slice(start + startMarker.length, end).trim();
    }
    throw new Error(`${artifactPath} 未找到 ${startMarker}/${endMarker} 标记`);
}

function readGeminiCliArtifact(artifactPath: string): string {
    if (!fs.existsSync(artifactPath)) {
        throw new Error(`Gemini CLI 未写入响应文件: ${artifactPath}`);
    }
    const stat = fs.statSync(artifactPath);
    if (stat.size > GEMINI_CLI_MAX_OUTPUT_BYTES) {
        throw new Error(`Gemini CLI 响应文件过大 (${stat.size} bytes > ${GEMINI_CLI_MAX_OUTPUT_BYTES} bytes)，拒绝读入内存`);
    }
    const raw = fs.readFileSync(artifactPath, "utf-8");
    const text = extractMarkedSection(raw, GEMINI_CLI_RESPONSE_START, GEMINI_CLI_RESPONSE_END, artifactPath);
    if (!text) throw new Error("Gemini CLI 未返回文本");
    return text;
}

function buildGeminiCliPromptFile(input: {
    prompt: string;
    imagePaths: string[];
    artifactPath: string;
    model: string;
}): string {
    const images = input.imagePaths.length > 0
        ? input.imagePaths.map((imagePath, index) => `- image ${index + 1}: ${path.resolve(imagePath)}`).join("\n")
        : "- 无";
    return [
        "你是 sandbox_council 的 Gemini CLI 参与模型。",
        "你需要阅读下面的讨论提示，并把最终回答写入指定临时文件。",
        "不要把完整回答打印到 stdout；stdout/stderr 只允许短状态或错误诊断。",
        "输出文件必须包含下面两个标记，宿主只读取标记之间的内容：",
        GEMINI_CLI_RESPONSE_START,
        "...你的中文回答...",
        GEMINI_CLI_RESPONSE_END,
        "",
        `模型：${input.model}`,
        `临时输出文件：${input.artifactPath}`,
        "",
        "# 图片输入",
        "如果列出了图片路径，请使用 Gemini CLI 可用的多模态/文件读取能力直接观察这些图片；不要只复述路径。",
        images,
        "",
        "# 讨论提示",
        input.prompt,
    ].join("\n");
}

function buildGeminiCliScript(promptPath: string, artifactPath: string, model: string, approvalMode: string, command: string): string {
    const prompt = `Read and follow the full UTF-8 instructions in ${promptPath}. Write the final sandbox_council response to ${artifactPath}. Do not print the full response to stdout.`;
    return [
        "$ErrorActionPreference = 'Continue'",
        `$prompt = ${psSingleQuoted(prompt)}`,
        `& ${psSingleQuoted(command)} --skip-trust --approval-mode ${psSingleQuoted(approvalMode)} -m ${psSingleQuoted(model)} -p $prompt --output-format text`,
        "exit $LASTEXITCODE",
    ].join("\n");
}

async function callGeminiCliText(
    config: CouncilModelConfig,
    prompt: string,
    imagePaths: string[],
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<ProviderCallResult> {
    assertProviderNotAborted(signal);
    const model = getDefaultModel(config);
    const command = getStringParam(config.params, "command") || getStringParam(config.params, "cli") || "gemini";
    const approvalMode = getStringParam(config.params, "approvalMode") || getStringParam(config.params, "geminiApprovalMode") || DEFAULT_GEMINI_CLI_APPROVAL_MODE;
    const cwd = path.resolve(getStringParam(config.params, "cwd") || process.cwd());
    const dir = config.provider === "geminiCli"
        ? geminiCliAccessibleTempDir(cwd, "council-model-calls")
        : councilModelCallDir();
    const base = path.join(dir, `${safeName(config.id)}_${safeName(model)}_${nowStamp()}`);
    const artifactPath = `${base}.md`;
    const promptPath = `${base}.prompt.txt`;
    const promptFile = buildGeminiCliPromptFile({
        prompt,
        imagePaths: config.supportsVision ? imagePaths : [],
        artifactPath,
        model,
    });
    fs.writeFileSync(promptPath, promptFile, "utf-8");
    const result = await spawnPowerShellScript(
        buildGeminiCliScript(promptPath, artifactPath, model, approvalMode, command),
        cwd,
        `${base}.run`,
        timeoutMs,
        getEarlyCliFailureReason,
        signal,
    );
    if (result.earlyFailureReason) {
        const stderr = readClip(result.stderrPath, 1200).trim();
        throw new Error(`${result.earlyFailureReason}${stderr ? `: ${stderr}` : ""}`);
    }
    if (result.timedOut) {
        try {
            const text = readGeminiCliArtifact(artifactPath);
            return { provider: config.provider, model, text };
        } catch {
            // Fall through to the timeout error with stdout/stderr paths.
        }
        throw new Error(`Gemini CLI 调用超时 (${timeoutMs}ms) stdout=${result.stdoutPath} stderr=${result.stderrPath}`);
    }
    if (result.exitCode !== 0 && !fs.existsSync(artifactPath)) {
        const stderr = readClip(result.stderrPath, 1200).trim();
        throw new Error(`Gemini CLI 调用失败 exit=${result.exitCode}${stderr ? `: ${stderr}` : ""}`);
    }
    const text = readGeminiCliArtifact(artifactPath);
    return { provider: config.provider, model, text };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    assertProviderNotAborted(signal);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const text = await response.text();
        let data: any = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = { raw: text };
        }
        if (!response.ok) {
            const message = data?.error?.message || data?.message || text.slice(0, 500);
            throw new Error(`HTTP ${response.status}: ${message}`);
        }
        return data;
    } catch (err) {
        if (signal?.aborted) {
            throw makeProviderAbortError();
        }
        if (err instanceof Error && err.name === "AbortError") {
            throw new Error(`HTTP 请求超时或被中止 (${timeoutMs}ms)`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
}

export async function callCouncilModel(
    config: CouncilModelConfig,
    prompt: string,
    imagePaths: string[] = [],
    timeoutMs = DEFAULT_COUNCIL_MODEL_TIMEOUT_MS,
    signal?: AbortSignal,
): Promise<ProviderCallResult> {
    assertProviderNotAborted(signal);
    const candidates = [config, ...getFallbackConfigs(config)];
    const errors: string[] = [];
    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        const candidateTimeoutMs = getNumberParam(candidate.params, "timeoutMs")
            ?? getNumberParam(candidate.params, "modelTimeoutMs")
            ?? timeoutMs;
        try {
            return await withSourceLimit(candidate, () => withRetry(candidate, () => {
                assertProviderNotAborted(signal);
                return callCouncilModelOnce(candidate, prompt, imagePaths, candidateTimeoutMs, signal);
            }));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            errors.push(`${describeModelConfig(candidate)} => ${message}`);
            const canFallback = isRetryableError(err) && index < candidates.length - 1;
            if (!canFallback) {
                if (index === 0 || candidates.length === 1) throw err;
                throw new Error(`provider fallback 链失败: ${errors.join(" | ")}`);
            }
        }
    }
    throw new Error(`provider fallback 链失败: ${errors.join(" | ")}`);
}

async function callCouncilModelOnce(
    config: CouncilModelConfig,
    prompt: string,
    imagePaths: string[] = [],
    timeoutMs = DEFAULT_COUNCIL_MODEL_TIMEOUT_MS,
    signal?: AbortSignal,
): Promise<ProviderCallResult> {
    assertProviderNotAborted(signal);
    const model = getDefaultModel(config);
    if (config.provider === "geminiCli") {
        return await callGeminiCliText(config, prompt, imagePaths, timeoutMs, signal);
    }
    const images = loadImages(imagePaths, Boolean(config.supportsVision), config.provider);

    if (config.provider === "antigravity") {
        const result = await callGetModelResponseDetailed(model, prompt, timeoutMs);
        if (result.text) return { provider: config.provider, model, text: result.text };
        const err = new Error(result.error || "Antigravity LS 模型调用失败") as ProviderError;
        err.timedOut = result.timedOut === true;
        err.retryable = err.timedOut;
        throw err;
    }

    if (config.provider === "codex") {
        const text = await callCodexText(prompt, timeoutMs, {
            model,
            reasoning: getCodexReasoningParam(config.params),
            speed: getStringParam(config.params, "speed"),
            signal,
        });
        return { provider: config.provider, model, text };
    }

    if (config.provider === "claudeCode") {
        const result = await callClaudeCodeText(prompt, {
            ...claudeCodeOptionsFromParams(config.params),
            model,
            timeoutMs,
        });
        return {
            provider: config.provider,
            model: result.model || model,
            text: result.text,
            metadata: {
                sessionId: result.sessionId,
                totalCostUsd: result.totalCostUsd,
                durationMs: result.durationMs,
                stdoutPath: result.stdoutPath,
                stderrPath: result.stderrPath,
                artifactPath: result.artifactPath,
                jsonlHint: result.jsonlHint,
            },
        };
    }

    if (config.provider === "openai") {
        const key = readApiKey(config, "OPENAI_API_KEY");
        const endpoint = getStringParam(config.params, "endpoint") || "https://api.openai.com/v1/responses";
        const content: any[] = [{ type: "input_text", text: prompt }];
        for (const image of images) {
            content.push({ type: "input_image", image_url: image.dataUrl, detail: "auto" });
        }
        const body = {
            ...getSafeBodyOverrides(config.params, ["model", "input", "tools"]),
            model,
            input: [{ role: "user", content }],
        };
        const data = await postJson(endpoint, { Authorization: `Bearer ${key}`, ...getHeadersParam(config.params) }, body, timeoutMs, signal);
        assertNotTruncated(config.provider, data);
        const text = extractOpenAIText(data);
        if (!text) throw new Error("OpenAI Responses API 未返回文本");
        return { provider: config.provider, model, text };
    }

    if (config.provider === "anthropic") {
        const key = readApiKey(config, "ANTHROPIC_API_KEY");
        const endpoint = getStringParam(config.params, "endpoint") || "https://api.anthropic.com/v1/messages";
        const content: any[] = [{ type: "text", text: prompt }];
        for (const image of images) {
            content.push({
                type: "image",
                source: { type: "base64", media_type: image.mimeType, data: image.data },
            });
        }
        const body = {
            ...getSafeBodyOverrides(config.params, ["model", "messages"]),
            model,
            max_tokens: getNumberParam(config.params, "max_tokens") || 2048,
            messages: [{ role: "user", content }],
        };
        const data = await postJson(endpoint, {
            "x-api-key": key,
            "anthropic-version": getStringParam(config.params, "anthropicVersion") || "2023-06-01",
            ...getHeadersParam(config.params),
        }, body, timeoutMs, signal);
        assertNotTruncated(config.provider, data);
        const text = extractAnthropicText(data);
        if (!text) throw new Error("Anthropic Messages API 未返回文本");
        return { provider: config.provider, model, text };
    }

    if (config.provider === "gemini") {
        const key = readApiKey(config, "GEMINI_API_KEY");
        const endpoint = getStringParam(config.params, "endpoint")
            || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        const parts: any[] = [];
        for (const image of images) {
            parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } });
        }
        parts.push({ text: prompt });
        const body = {
            ...getSafeBodyOverrides(config.params, ["contents"]),
            contents: [{ role: "user", parts }],
        };
        const data = await postJson(endpoint, { "x-goog-api-key": key, ...getHeadersParam(config.params) }, body, timeoutMs, signal);
        assertNotTruncated(config.provider, data);
        const text = extractGeminiText(data);
        if (!text) throw new Error("Gemini generateContent 未返回文本");
        return { provider: config.provider, model, text };
    }

    const key = readApiKey(config, "OPENAI_API_KEY");
    const baseUrl = getStringParam(config.params, "baseUrl") || getStringParam(config.params, "endpoint");
    if (!baseUrl) throw new Error("customOpenAICompatible 需要 params.baseUrl 或 params.endpoint");
    const endpoint = baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl.replace(/\/$/u, "")}/chat/completions`;
    const messageContent = images.length > 0
        ? [
            { type: "text", text: prompt },
            ...images.map((image) => ({ type: "image_url", image_url: { url: image.dataUrl } })),
        ]
        : prompt;
    const body = {
        ...getSafeBodyOverrides(config.params, ["model", "messages"]),
        model,
        messages: [{ role: "user", content: messageContent }],
    };
    const data = await postJson(endpoint, { Authorization: `Bearer ${key}`, ...getHeadersParam(config.params) }, body, timeoutMs, signal);
    assertNotTruncated(config.provider, data);
    const text = extractChatText(data);
    if (!text) throw new Error("OpenAI-compatible endpoint 未返回文本");
    return { provider: config.provider, model, text };
}
