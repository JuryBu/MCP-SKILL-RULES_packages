import { execFile, spawn, type ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { randomUUID } from "crypto";
import {
    AI_SUMMARY_ANTIGRAVITY_LABEL,
    AI_SUMMARY_CLAUDE_CODE_LABEL,
    AI_SUMMARY_CODEX_LABEL,
    AI_SUMMARY_MAX_INPUT,
    AI_SUMMARY_PROMPT_TEMPLATE,
    CLAUDE_CODE_AI_SUMMARY_EFFORT,
    CLAUDE_CODE_AI_SUMMARY_BACKGROUND_TIMEOUT,
    CLAUDE_CODE_AI_SUMMARY_MODEL,
    CLAUDE_CODE_AI_SUMMARY_TIMEOUT,
    CODEX_AI_SUMMARY_MODEL,
    CODEX_AI_SUMMARY_REASONING_EFFORT,
    CODEX_AI_SUMMARY_SPEED_TIER,
    CODEX_AI_SUMMARY_TIMEOUT,
    type SummaryChain,
} from "./constants.js";
import { callAntigravity, isAntigravityAvailable } from "./ls-client.js";
import type { AntigravityOutcome, AntigravityTransport } from "./antigravity-types.js";
import { getRequestContext } from "./request-context.js";

const execFileAsync = promisify(execFile);
const CODEX_STATUS_TTL = 60 * 1000;
const CLAUDE_CODE_STATUS_TTL = 60 * 1000;
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;

let codexAvailableCache: boolean | null = null;
let codexAvailableAt = 0;
let cachedCodexCommand: string | null = null;
let claudeCodeAvailableCache: boolean | null = null;
let claudeCodeAvailableAt = 0;
let cachedClaudeCodeCommand: string | null = null;
let activeClaudeCodeCalls = 0;
let claudeCodeCircuitOpenUntil = 0;

type ResolvedSummaryChain = Exclude<SummaryChain, "auto">;

export interface SummaryBridgeResult {
    text: string | null;
    chainUsed: ResolvedSummaryChain | null;
    providerLabel: string | null;
    error?: string;
    transport?: AntigravityTransport | "codex-cli" | "claude-code-cli" | null;
    modelUsed?: string | null;
    modelSource?: "request" | "environment" | "catalog" | "cli-default";
    outcome?: AntigravityOutcome;
    submitted?: boolean;
    outcomeUnknown?: boolean;
    fallbackAllowed?: boolean;
    cleanup?: import("./antigravity-types.js").AntigravityCleanup;
}

export interface SummaryPromptInfo {
    pageTitle: string;
    truncatedContent: string;
    prompt: string;
}

export interface ModelBridgeRequest {
    prompt: string;
    purpose?: "material" | "visual-review";
    chain?: SummaryChain;
    timeoutMs?: number;
    generationTimeoutMs?: number;
    schema?: Record<string, unknown>;
    imagePaths?: string[];
    schemaName?: string;
    model?: string;
    signal?: AbortSignal;
    deadline?: number;
}

interface ProviderCallResult {
    text: string | null;
    error?: string;
    outcome: AntigravityOutcome;
    submitted: boolean;
    safeToFallback: boolean;
    modelUsed?: string | null;
    modelSource?: "request" | "environment" | "catalog" | "cli-default";
}

interface ProviderParsedResult {
    text: string | null;
    error?: string;
    terminalMissing?: string;
    errorCode?: string;
    errorStatus?: number;
    errorType?: string;
}

function structuredErrorDetails(value: unknown, depth = 0): Pick<ProviderParsedResult, "errorCode" | "errorStatus" | "errorType"> | undefined {
    if (depth > 3 || !value) return undefined;
    if (typeof value === "string") {
        const text = stripAnsi(value).trim();
        const start = text.indexOf("{");
        if (start < 0 || !text.endsWith("}")) return undefined;
        try { return structuredErrorDetails(JSON.parse(text.slice(start)), depth + 1); } catch { return undefined; }
    }
    if (typeof value !== "object" || Array.isArray(value)) return undefined;
    const event = value as Record<string, any>;
    const error = event.error && typeof event.error === "object" ? event.error : event;
    const details = {
        errorCode: typeof error.code === "string" ? error.code : undefined,
        errorStatus: typeof event.status === "number" ? event.status : typeof error.status === "number" ? error.status : undefined,
        errorType: typeof error.type === "string" ? error.type : undefined,
    };
    const nested = structuredErrorDetails(error.message, depth + 1);
    if (!details.errorCode && !details.errorStatus && !details.errorType && !nested) return undefined;
    return {
        errorCode: details.errorCode ?? nested?.errorCode,
        errorStatus: details.errorStatus ?? nested?.errorStatus,
        errorType: nested?.errorType ?? details.errorType,
    };
}

function findLocalCommand(name: string): string {
    const extensions = process.platform === "win32" ? [".cmd", ".exe", ".ps1", ""] : [""];
    for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
        for (const extension of extensions) {
            const candidate = path.join(directory.replace(/^"|"$/gu, ""), `${name}${extension}`);
            if (fs.existsSync(candidate)) return candidate;
        }
    }
    return name;
}

function getCodexCommand(): string {
    if (cachedCodexCommand) return cachedCodexCommand;

    cachedCodexCommand = findLocalCommand("codex");
    return cachedCodexCommand;
}

function getClaudeCodeCommand(): string {
    if (process.env.WEB_FETCHER_CLAUDE_CODE_COMMAND) {
        return process.env.WEB_FETCHER_CLAUDE_CODE_COMMAND;
    }
    if (cachedClaudeCodeCommand) return cachedClaudeCodeCommand;

    cachedClaudeCodeCommand = findLocalCommand("claude");
    return cachedClaudeCodeCommand;
}

function quoteForCmd(arg: string): string {
    if (arg === "") return "\"\"";
    if (!/[\s"]/u.test(arg)) return arg;
    return `"${arg.replace(/"/g, "\"\"")}"`;
}

function spawnCommand(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): ChildProcessWithoutNullStreams {
    if (process.platform === "win32" && /\.(cmd|ps1)$/iu.test(command)) {
        const commandString = `${quoteForCmd(command)} ${args.map(quoteForCmd).join(" ")}`;
        return spawn("cmd.exe", ["/d", "/s", "/c", commandString], {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            cwd: process.cwd(),
            env,
        });
    }

    return spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        cwd: process.cwd(),
        env,
    });
}

async function execCodexVersion(command: string): Promise<void> {
    if (process.platform === "win32" && /\.(cmd|ps1)$/iu.test(command)) {
        const versionCmd = `${quoteForCmd(command)} --version`;
        await execFileAsync("cmd.exe", ["/d", "/s", "/c", versionCmd], {
            timeout: 8000,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });
        return;
    }

    await execFileAsync(command, ["--version"], {
        timeout: 8000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
    });
}

async function execClaudeCodeVersion(command: string): Promise<void> {
    if (process.platform === "win32" && /\.(cmd|ps1)$/iu.test(command)) {
        const versionCmd = `${quoteForCmd(command)} --version`;
        await execFileAsync("cmd.exe", ["/d", "/s", "/c", versionCmd], {
            timeout: 8000,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });
        return;
    }

    await execFileAsync(command, ["--version"], {
        timeout: 8000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
    });
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
    if (process.platform === "win32" && child.pid) {
        try {
            const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
            });
            killer.once("error", () => child.kill());
            killer.unref();
            return;
        } catch {
            // ignore
        }
    }
    try { child.kill("SIGKILL"); } catch { }
}

export function extractCodexJsonResult(stdout: string): ProviderParsedResult {
    const lines = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);

    let lastAgentText: string | null = null;
    let completed = false;
    let failure: string | undefined;
    let errorCode: string | undefined;
    let errorStatus: number | undefined;
    let errorType: string | undefined;

    for (const line of lines) {
        if (!line.startsWith("{")) continue;
        try {
            const event = JSON.parse(line);
            if (event?.type === "turn.completed") completed = true;
            if (event?.type === "turn.failed" || event?.type === "error") {
                failure = typeof event.error?.message === "string" ? event.error.message
                    : typeof event.message === "string" ? event.message : "Codex 返回失败终态";
                const details = structuredErrorDetails(event);
                if (details?.errorCode) errorCode = details.errorCode;
                if (details?.errorStatus) errorStatus = details.errorStatus;
                if (details?.errorType) errorType = details.errorType;
            }
            if (event?.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
                lastAgentText = event.item.text;
            }
        } catch {
            // ignore
        }
    }

    if (failure !== undefined) return { text: null, error: failure || "Codex 返回失败终态", errorCode, errorStatus, errorType };
    if (!completed) return { text: null, terminalMissing: "Codex CLI 未取得成功终态，生成结果待核" };
    return { text: lastAgentText?.trim() || null };
}

function extractJsonLineAgentText(stdout: string): string | null {
    return extractCodexJsonResult(stdout).text;
}

function extractJsonLineSummary(stdout: string): string | null {
    const lastAgentText = extractJsonLineAgentText(stdout);
    if (!lastAgentText) return null;

    try {
        const parsed = JSON.parse(lastAgentText);
        if (parsed && typeof parsed.summary === "string") {
            return parsed.summary.trim();
        }
    } catch {
        // fallback to plain text
    }

    return lastAgentText.trim() || null;
}

function stripAnsi(text: string): string {
    return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "");
}

function diagnosticSnippet(text: string): string {
    return stripAnsi(text)
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" | ")
        .slice(0, 600);
}

function providerFailure(error: string, submitted = false, safeToFallback = false, outcome: AntigravityOutcome = "not-started"): ProviderCallResult {
    return { text: null, error, outcome, submitted, safeToFallback };
}

async function runProviderCommand(
    command: string,
    args: string[],
    prompt: string,
    timeoutMs: number,
    parse: (stdout: string) => ProviderParsedResult,
    signal?: AbortSignal,
    env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderCallResult> {
    if (signal?.aborted) return providerFailure("模型请求已取消", false, false, "cancelled");
    if (timeoutMs <= 0) return providerFailure("模型请求总期限已到，尚未提交");
    return new Promise<ProviderCallResult>((resolve) => {
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawnCommand(command, args, env);
        } catch {
            resolve(providerFailure("模型CLI启动失败", false, true));
            return;
        }
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let outputBytes = 0;
        let submitted = false;
        let settled = false;
        let stopping: ProviderCallResult | undefined;
        let cleanupTimer: NodeJS.Timeout | undefined;
        const finish = (result: ProviderCallResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (cleanupTimer) clearTimeout(cleanupTimer);
            signal?.removeEventListener("abort", onAbort);
            resolve(result);
        };
        const stop = (result: ProviderCallResult) => {
            if (settled || stopping) return;
            stopping = result;
            terminateChild(child);
            cleanupTimer = setTimeout(() => finish({ ...result, error: `${result.error}；自有进程退出确认仍待完成` }), 2000);
            cleanupTimer.unref();
        };
        const onAbort = () => stop(providerFailure("模型请求已取消", submitted, false, "cancelled"));
        const timer = setTimeout(() => stop(providerFailure(
            submitted ? "模型请求总期限已到，生成结果未知" : "模型请求总期限已到，尚未提交",
            submitted,
            false,
            submitted ? "timeout-unknown" : "not-started",
        )), timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        const collect = (chunk: Buffer, destination: "stdout" | "stderr") => {
            if (settled || stopping) return;
            outputBytes += chunk.length;
            if (outputBytes > DEFAULT_OUTPUT_LIMIT) {
                stop(providerFailure("模型CLI输出超过保护上限，终态未完整取得", submitted, false, "invalid-response"));
                return;
            }
            if (destination === "stdout") stdoutChunks.push(chunk);
            else stderrChunks.push(chunk);
        };
        child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
        child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
        child.stdin.on("error", () => {
            if (!stopping) stop(providerFailure("模型CLI输入连接中断，结果未知", submitted, false, "transport-unknown"));
        });
        child.once("error", (error: NodeJS.ErrnoException) => {
            if (stopping) { finish(stopping); return; }
            if (!submitted && error.code === "ENOENT") finish(providerFailure("模型CLI未安装或入口不存在", false, true));
            else finish(providerFailure("模型CLI进程异常，结果未知", submitted, false, "transport-unknown"));
        });
        child.once("spawn", () => {
            if (settled || stopping) return;
            submitted = true;
            child.stdin.end(prompt, "utf-8");
        });
        child.once("close", (code) => {
            if (stopping) {
                finish(stopping);
                return;
            }
            const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
            const stderr = Buffer.concat(stderrChunks).toString("utf-8");
            const parsed = parse(stdout);
            if (code === 0 && parsed.text) {
                finish({ text: parsed.text, outcome: "success", submitted, safeToFallback: false });
                return;
            }
            const message = parsed.error || diagnosticSnippet(stderr)
                || parsed.terminalMissing || `模型CLI退出码 ${code}`;
            const details = parsed.errorCode || parsed.errorStatus ? parsed : structuredErrorDetails(parsed.error)
                || stderr.split(/\r?\n/u).map(line => structuredErrorDetails(line)).find(value => value !== undefined);
            const outcome: AntigravityOutcome = /quota|credit|billing|budget|rate limit|429|额度|余额/iu.test(message)
                ? "quota-exhausted"
                : /not logged in|authentication|unauthorized|invalid api key|login required|登录|认证/iu.test(message)
                    ? "auth-required"
                    : details?.errorCode === "model_not_found"
                        || (details?.errorStatus === 400 && details?.errorType === "invalid_request_error")
                        ? "rejected"
                        : code === 0 ? "invalid-response" : "transport-unknown";
            finish(providerFailure(message, submitted, false, outcome));
        });
    });
}

function parsePositiveNumber(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function shouldEnableClaudeCodeAutoFallback(): boolean {
    return process.env.WEB_FETCHER_CLAUDE_CODE_AUTO_FALLBACK === "1";
}

function getClaudeCodeMaxConcurrency(): number {
    const parsed = Number(process.env.WEB_FETCHER_CLAUDE_CODE_MAX_CONCURRENCY || "1");
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

function getClaudeCodeCircuitMs(): number {
    const parsed = Number(process.env.WEB_FETCHER_CLAUDE_CODE_CIRCUIT_MS || "300000");
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 300000;
}

function shouldCircuitBreakClaudeCode(message: string): boolean {
    return /invalid api key|not logged in|authentication|unauthorized|quota|credit|billing|budget|rate limit|too many requests|429/iu.test(message);
}

function extractClaudeCodeJsonResult(stdout: string): { text: string | null; error?: string; circuitBreak?: boolean; terminalMissing?: string } {
    const cleaned = stripAnsi(stdout).trim();
    if (!cleaned) {
        return { text: null, terminalMissing: "Claude Code CLI 未输出 JSON" };
    }

    let parsed: any;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        return { text: null, terminalMissing: "Claude Code CLI stdout 不是合法 JSON" };
    }

    if (parsed?.is_error === true) {
        const message = typeof parsed.result === "string" ? parsed.result : "Claude Code CLI 返回 is_error=true";
        return {
            text: null,
            error: message,
            circuitBreak: shouldCircuitBreakClaudeCode(message),
        };
    }

    if (parsed?.type !== "result" || parsed?.subtype !== "success") {
        return { text: null, terminalMissing: "Claude Code CLI 未返回成功终态" };
    }

    if (parsed?.structured_output !== undefined) {
        const value = typeof parsed.structured_output === "string"
            ? parsed.structured_output
            : JSON.stringify(parsed.structured_output);
        return { text: value.trim() || null };
    }

    if (typeof parsed?.result === "string" && parsed.result.trim()) {
        return { text: parsed.result.trim() };
    }

    return { text: null, terminalMissing: "Claude Code CLI JSON 缺少 result / structured_output" };
}

async function isCodexBridgeAvailable(): Promise<boolean> {
    const now = Date.now();
    if (codexAvailableCache !== null && now - codexAvailableAt < CODEX_STATUS_TTL) {
        return codexAvailableCache;
    }

    try {
        await execCodexVersion(getCodexCommand());
        codexAvailableCache = true;
    } catch {
        codexAvailableCache = false;
    }
    codexAvailableAt = now;
    return codexAvailableCache;
}

async function isClaudeCodeBridgeAvailable(): Promise<boolean> {
    const now = Date.now();
    if (claudeCodeAvailableCache !== null && now - claudeCodeAvailableAt < CLAUDE_CODE_STATUS_TTL) {
        return claudeCodeAvailableCache;
    }

    try {
        await execClaudeCodeVersion(getClaudeCodeCommand());
        claudeCodeAvailableCache = true;
    } catch {
        claudeCodeAvailableCache = false;
    }
    claudeCodeAvailableAt = now;
    return claudeCodeAvailableCache;
}

function resolveSummaryCandidates(requested: SummaryChain): ResolvedSummaryChain[] {
    if (requested !== "auto") return [requested];
    const candidates: ResolvedSummaryChain[] = ["antigravity", "codex"];
    if (shouldEnableClaudeCodeAutoFallback()) candidates.push("claude-code");
    return candidates;
}

export function resolveCodexModelSelection(model?: string): { model: string | null; source: "request" | "environment" | "catalog" | "cli-default"; efforts?: string[] } {
    if (model?.trim()) return { model: model.trim(), source: "request" };
    const configured = process.env.WEB_FETCHER_CODEX_MODEL?.trim() || CODEX_AI_SUMMARY_MODEL;
    if (configured) return { model: configured, source: "environment" };
    try {
        const filename = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "models_cache.json");
        const stat = fs.statSync(filename);
        if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("invalid catalog");
        const catalog = JSON.parse(fs.readFileSync(filename, "utf-8"));
        const age = Date.now() - Date.parse(catalog.fetched_at);
        if (!Number.isFinite(age) || age < -60_000 || age > 24 * 60 * 60_000) throw new Error("stale catalog");
        const candidates = Array.isArray(catalog.models) ? catalog.models.filter((candidate: any) =>
            typeof candidate?.slug === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(candidate.slug)
            && candidate.visibility === "list" && candidate.supported_in_api !== false
            && Number.isFinite(candidate.priority),
        ).sort((left: any, right: any) => left.priority - right.priority) : [];
        const selected = candidates[0];
        if (selected) return {
            model: selected.slug,
            source: "catalog",
            efforts: Array.isArray(selected.supported_reasoning_levels)
                ? selected.supported_reasoning_levels.map((entry: any) => entry?.effort).filter((entry: any) => typeof entry === "string")
                : undefined,
        };
    } catch {
    }
    return { model: null, source: "cli-default" };
}

async function generateViaCodex(prompt: string, timeoutMs: number, schema?: Record<string, unknown>, imagePaths: string[] = [], schemaName = "model", signal?: AbortSignal, model?: string): Promise<ProviderCallResult> {
    const selection = resolveCodexModelSelection(model);
    const schemaPath = schema
        ? path.join(os.tmpdir(), `mcp-web-fetcher-${schemaName.replace(/[^a-z0-9_-]/giu, "-")}-schema-${randomUUID()}.json`)
        : null;

    if (schemaPath && schema) {
        fs.writeFileSync(schemaPath, JSON.stringify(schema), "utf-8");
    }

    const args = [
        "exec",
        "--skip-git-repo-check",
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox", "read-only",
        "-C", process.cwd(),
    ];

    if (selection.model) args.push("-m", selection.model);
    const reasoning = CODEX_AI_SUMMARY_REASONING_EFFORT;
    if (reasoning && (!selection.efforts?.length || selection.efforts.includes(reasoning))) {
        args.push("-c", `model_reasoning_effort=${reasoning}`);
    }
    if (CODEX_AI_SUMMARY_SPEED_TIER === "standard") {
        args.push("-c", "service_tier=\"default\"", "-c", "fast_mode=false");
    } else if (CODEX_AI_SUMMARY_SPEED_TIER) {
        args.push("-c", `model_speed_tier=${CODEX_AI_SUMMARY_SPEED_TIER}`);
    }

    if (schemaPath) {
        args.push("--output-schema", schemaPath);
    }
    for (const imagePath of imagePaths) {
        if (imagePath && fs.existsSync(imagePath)) {
            args.push("-i", imagePath);
        }
    }
    args.push("-");

    try {
        const result = await runProviderCommand(getCodexCommand(), args, prompt, timeoutMs, extractCodexJsonResult, signal);
        return { ...result, modelUsed: selection.model, modelSource: selection.source };
    } finally {
        if (schemaPath) {
            try {
                fs.unlinkSync(schemaPath);
            } catch {
                // ignore
            }
        }
    }
}

async function generateViaClaudeCode(prompt: string, timeoutMs: number, signal?: AbortSignal, model?: string): Promise<ProviderCallResult> {
    const now = Date.now();
    if (now < claudeCodeCircuitOpenUntil) {
        console.error("[model-bridge] Claude Code CLI skipped: circuit breaker is open");
        return providerFailure("Claude Code CLI 短期熔断中", false, false, "rejected");
    }

    const maxConcurrency = getClaudeCodeMaxConcurrency();
    if (activeClaudeCodeCalls >= maxConcurrency) {
        console.error("[model-bridge] Claude Code CLI skipped: concurrency limit reached");
        return providerFailure("Claude Code CLI 并发上限已满", false, true);
    }

    const budget = parsePositiveNumber(process.env.WEB_FETCHER_CLAUDE_CODE_MAX_BUDGET_USD);
    if (process.env.WEB_FETCHER_CLAUDE_CODE_MAX_BUDGET_USD && budget === null) {
        console.error("[model-bridge] Claude Code CLI skipped: WEB_FETCHER_CLAUDE_CODE_MAX_BUDGET_USD must be a positive number");
        return providerFailure("WEB_FETCHER_CLAUDE_CODE_MAX_BUDGET_USD 必须是正数", false, false, "rejected");
    }

    const configuredTimeout = timeoutMs > CODEX_AI_SUMMARY_TIMEOUT
        ? CLAUDE_CODE_AI_SUMMARY_BACKGROUND_TIMEOUT
        : CLAUDE_CODE_AI_SUMMARY_TIMEOUT;
    const effectiveTimeout = Math.min(
        timeoutMs,
        configuredTimeout > 0 ? configuredTimeout : timeoutMs,
    );
    const args = [
        "-p",
        "--output-format", "json",
        "--no-session-persistence",
        "--model", model || CLAUDE_CODE_AI_SUMMARY_MODEL,
        "--effort", CLAUDE_CODE_AI_SUMMARY_EFFORT,
    ];

    if (budget !== null) {
        args.push("--max-budget-usd", String(budget));
    }

    const childEnv = {
        ...process.env,
        CLAUDE_CODE_MAX_RETRIES: process.env.WEB_FETCHER_CLAUDE_CODE_MAX_RETRIES ?? "0",
        API_TIMEOUT_MS: process.env.WEB_FETCHER_CLAUDE_CODE_API_TIMEOUT_MS ?? String(Math.max(1000, Math.min(30000, effectiveTimeout - 5000))),
    };

    activeClaudeCodeCalls++;
    try {
        const result = await runProviderCommand(getClaudeCodeCommand(), args, prompt, effectiveTimeout, extractClaudeCodeJsonResult, signal, childEnv);
        if (result.error && shouldCircuitBreakClaudeCode(result.error)) {
            claudeCodeCircuitOpenUntil = Date.now() + getClaudeCodeCircuitMs();
        }
        return result;
    } finally {
        activeClaudeCodeCalls = Math.max(0, activeClaudeCodeCalls - 1);
    }
}

export function buildSummaryPrompt(content: string, url: string): SummaryPromptInfo {
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const pageTitle = titleMatch ? titleMatch[1].trim() : url.split("/").pop() || "未知页面";
    const truncatedContent = content.slice(0, AI_SUMMARY_MAX_INPUT);
    const summaryLength = truncatedContent.length < 2000
        ? "通常100-300字，短材料可更短，摘要不应长于正文"
        : "500-1000字，按正文实际信息量缩短";
    const prompt = AI_SUMMARY_PROMPT_TEMPLATE
        .replace("{summaryLength}", summaryLength)
        .replace("{pageTitle}", JSON.stringify(pageTitle))
        .replace("{url}", JSON.stringify(url))
        .replace("{content}", JSON.stringify(truncatedContent));

    return {
        pageTitle,
        truncatedContent,
        prompt,
    };
}

export async function generateSummaryText(
    prompt: string,
    chain: SummaryChain = "auto",
    timeoutMs: number = CODEX_AI_SUMMARY_TIMEOUT,
    signal?: AbortSignal,
    model?: string,
): Promise<SummaryBridgeResult> {
    const schema = {
        type: "object",
        additionalProperties: false,
        required: ["summary"],
        properties: {
            summary: {
                type: "string",
                description: "Chinese summary only. No markdown fences.",
            },
        },
    };
    const result = await generateModelText({
        prompt,
        chain,
        timeoutMs,
        schema,
        schemaName: "ai-summary",
        signal,
        model,
        purpose: "material",
    });
    if (!result.text) return result;
    try {
        const parsed = JSON.parse(result.text);
        if (parsed && typeof parsed.summary === "string") {
            return { ...result, text: parsed.summary.trim() };
        }
    } catch {
        // plain text fallback
    }
    return result;
}

function providerLabelForChain(chain: ResolvedSummaryChain): string {
    if (chain === "antigravity") return AI_SUMMARY_ANTIGRAVITY_LABEL;
    if (chain === "claude-code") return AI_SUMMARY_CLAUDE_CODE_LABEL;
    return AI_SUMMARY_CODEX_LABEL;
}

export async function generateModelText(request: ModelBridgeRequest): Promise<SummaryBridgeResult> {
    const startedAt = performance.now();
    const timeoutMs = request.timeoutMs ?? CODEX_AI_SUMMARY_TIMEOUT;
    const context = getRequestContext();
    const signal = request.signal ?? context?.signal;
    const deadline = Math.min(startedAt + Math.max(0, timeoutMs), request.deadline ?? Infinity, context?.deadline ?? Infinity);
    const stopped = (): SummaryBridgeResult | null => {
        if (signal?.aborted) return { text: null, chainUsed: null, providerLabel: null, outcome: "cancelled", submitted: false, fallbackAllowed: false, error: "模型请求已取消" };
        if (!Number.isFinite(deadline) || performance.now() >= deadline) return { text: null, chainUsed: null, providerLabel: null, outcome: "not-started", submitted: false, fallbackAllowed: false, error: "模型请求总期限已到，尚未提交" };
        return null;
    };
    const initialStop = stopped();
    if (initialStop) return initialStop;
    const mock = process.env.WEB_FETCHER_MOCK_MODEL_RESPONSE;
    if (mock !== undefined) {
        const requested = request.chain ?? "auto";
        const chainUsed: ResolvedSummaryChain =
            requested === "antigravity" || requested === "codex" || requested === "claude-code"
                ? requested
                : "antigravity";
        return {
            text: mock,
            chainUsed,
            providerLabel: providerLabelForChain(chainUsed),
        };
    }

    let chain = request.chain ?? "auto";
    const explicitModel = request.model?.trim();
    if (explicitModel && chain === "auto") {
        if (/^(?:M\d+$|MODEL_|gemini|carbon|hydrogen|argon|flash|gpt-oss)/iu.test(explicitModel)) chain = "antigravity";
        else if (/^(?:gpt-|o\d|codex)/iu.test(explicitModel)) chain = "codex";
        else if (/^(?:claude-|sonnet|opus|haiku)/iu.test(explicitModel)) chain = "claude-code";
        else return { text: null, chainUsed: null, providerLabel: null, outcome: "rejected", submitted: false, outcomeUnknown: false, fallbackAllowed: false, error: "显式model无法确定所属链路，请同时指定modelChain" };
    }
    const imagePaths = request.imagePaths ?? [];
    for (const imagePath of imagePaths) {
        try {
            if (!fs.statSync(imagePath).isFile()) throw new Error("not a file");
        } catch {
            return { text: null, chainUsed: null, providerLabel: null, outcome: "rejected", submitted: false, fallbackAllowed: false, error: "图片附件不存在或无法读取，模型请求尚未提交" };
        }
    }
    const candidates = resolveSummaryCandidates(chain);

    const callResolved = async (target: ResolvedSummaryChain): Promise<SummaryBridgeResult> => {
        if (target === "antigravity") {
            const selectedModel = explicitModel || process.env.WEB_FETCHER_LS_MODEL?.trim() || undefined;
            const result = await callAntigravity({ prompt: request.prompt, model: selectedModel, imagePaths, schema: request.schema, deadline, signal, generationTimeoutMs: request.generationTimeoutMs, ...(request.purpose ? { purpose: request.purpose } : {}) });
            return {
                text: result.text,
                chainUsed: result.text ? "antigravity" : null,
                providerLabel: result.text ? AI_SUMMARY_ANTIGRAVITY_LABEL : null,
                error: result.error,
                transport: result.transport,
                modelUsed: result.model,
                outcome: result.outcome,
                submitted: result.submitted,
                outcomeUnknown: result.submitted && ["transport-unknown", "timeout-unknown", "invalid-response", "cancelled"].includes(result.outcome),
                fallbackAllowed: !selectedModel && result.safeToFallback,
                ...(result.cleanup ? { cleanup: result.cleanup } : {}),
            };
        }

        if (target === "claude-code") {
            if (imagePaths.length > 0) return { text: null, chainUsed: null, providerLabel: null, outcome: "unsupported", submitted: false, fallbackAllowed: false, error: "当前Claude Code模型桥未提供图片传输，本次图片请求尚未提交" };
            const result = await generateViaClaudeCode(request.prompt, Math.max(0, Math.min(deadline - performance.now(), request.generationTimeoutMs ?? Infinity)), signal, explicitModel);
            return {
                text: result.text,
                chainUsed: result.text ? "claude-code" : null,
                providerLabel: result.text ? AI_SUMMARY_CLAUDE_CODE_LABEL : null,
                error: result.text ? undefined : `Claude Code CLI 模型调用失败${result.error ? `: ${result.error}` : ""}`,
                transport: "claude-code-cli",
                modelUsed: explicitModel || CLAUDE_CODE_AI_SUMMARY_MODEL,
                outcome: result.outcome,
                submitted: result.submitted,
                outcomeUnknown: result.submitted && ["transport-unknown", "timeout-unknown", "invalid-response", "cancelled"].includes(result.outcome),
                fallbackAllowed: !explicitModel && result.safeToFallback,
            };
        }

        const result = await generateViaCodex(
            request.prompt,
            Math.max(0, Math.min(deadline - performance.now(), request.generationTimeoutMs ?? Infinity)),
            request.schema,
            imagePaths,
            request.schemaName,
            signal,
            explicitModel,
        );
        return {
            text: result.text,
            chainUsed: result.text ? "codex" : null,
            providerLabel: result.text ? AI_SUMMARY_CODEX_LABEL : null,
            error: result.error,
            transport: "codex-cli",
            modelUsed: result.modelUsed,
            modelSource: result.modelSource,
            outcome: result.outcome,
            submitted: result.submitted,
            outcomeUnknown: result.submitted && ["transport-unknown", "timeout-unknown", "invalid-response", "cancelled"].includes(result.outcome),
            fallbackAllowed: !explicitModel && !process.env.WEB_FETCHER_CODEX_MODEL?.trim() && result.safeToFallback,
        };
    };

    const errors: string[] = [];
    let lastResult: SummaryBridgeResult | undefined;
    for (const candidate of candidates) {
        const stop = stopped();
        if (stop) return { ...stop, error: [errors.join("; "), stop.error].filter(Boolean).join("; ") };
        let result: SummaryBridgeResult;
        try {
            result = await callResolved(candidate);
        } catch {
            result = { text: null, chainUsed: null, providerLabel: null, outcome: "transport-unknown", submitted: true, outcomeUnknown: true, fallbackAllowed: false, error: `${candidate}模型调用异常，结果待核` };
        }
        lastResult = result;
        if (result.text) {
            return result;
        }
        if (result.error) {
            errors.push(`${candidate}: ${result.error}`);
        }
        if (chain !== "auto" || result.fallbackAllowed !== true) {
            return result;
        }
    }

    return {
        ...lastResult,
        text: null,
        chainUsed: null,
        providerLabel: null,
        error: errors.join("; ") || "所有模型链路调用失败",
    };
}

export async function getModelBridgeStatus(): Promise<{
    antigravityAvailable: boolean;
    codexAvailable: boolean;
    claudeCodeAvailable: boolean;
    claudeCodeAutoFallbackEnabled: boolean;
}> {
    const [antigravityAvailable, codexAvailable, claudeCodeAvailable] = await Promise.all([
        isAntigravityAvailable(),
        isCodexBridgeAvailable(),
        isClaudeCodeBridgeAvailable(),
    ]);
    return {
        antigravityAvailable,
        codexAvailable,
        claudeCodeAvailable,
        claudeCodeAutoFallbackEnabled: shouldEnableClaudeCodeAutoFallback(),
    };
}
