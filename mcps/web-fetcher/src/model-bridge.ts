import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
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
import { callGetModelResponse, isLsAvailable } from "./ls-client.js";

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
}

export interface SummaryPromptInfo {
    pageTitle: string;
    truncatedContent: string;
    prompt: string;
}

export interface ModelBridgeRequest {
    prompt: string;
    chain?: SummaryChain;
    timeoutMs?: number;
    schema?: Record<string, unknown>;
    imagePaths?: string[];
    schemaName?: string;
}

interface ProviderCallResult {
    text: string | null;
    error?: string;
}

function getCodexCommand(): string {
    if (cachedCodexCommand) return cachedCodexCommand;

    if (process.platform === "win32") {
        try {
            const stdout = execSyncSafe("where.exe", ["codex"]);
            const candidates = stdout
                .split(/\r?\n/u)
                .map((line) => line.trim())
                .filter(Boolean);
            const preferred = candidates.find((line) => /codex\.cmd$/iu.test(line))
                ?? candidates.find((line) => /codex\.ps1$/iu.test(line))
                ?? candidates.find((line) => /\\codex$/iu.test(line))
                ?? candidates.find((line) => /codex\.exe$/iu.test(line))
                ?? "codex";
            cachedCodexCommand = preferred;
            return preferred;
        } catch {
            // fall through
        }
    }

    cachedCodexCommand = "codex";
    return cachedCodexCommand;
}

function getClaudeCodeCommand(): string {
    if (process.env.WEB_FETCHER_CLAUDE_CODE_COMMAND) {
        return process.env.WEB_FETCHER_CLAUDE_CODE_COMMAND;
    }
    if (cachedClaudeCodeCommand) return cachedClaudeCodeCommand;

    if (process.platform === "win32") {
        try {
            const stdout = execSyncSafe("where.exe", ["claude"]);
            const candidates = stdout
                .split(/\r?\n/u)
                .map((line) => line.trim())
                .filter(Boolean);
            const preferred = candidates.find((line) => /claude\.cmd$/iu.test(line))
                ?? candidates.find((line) => /claude\.exe$/iu.test(line))
                ?? candidates.find((line) => /claude\.ps1$/iu.test(line))
                ?? candidates.find((line) => /\\claude$/iu.test(line))
                ?? "claude";
            cachedClaudeCodeCommand = preferred;
            return preferred;
        } catch {
            // fall through
        }
    }

    cachedClaudeCodeCommand = "claude";
    return cachedClaudeCodeCommand;
}

function execSyncSafe(command: string, args: string[]): string {
    return execFileSync(command, args, {
        encoding: "utf-8",
        timeout: 8000,
        windowsHide: true,
    });
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

function spawnCodex(command: string, args: string[]): ChildProcessWithoutNullStreams {
    return spawnCommand(command, args);
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
    try {
        child.kill("SIGKILL");
    } catch {
        // ignore
    }

    if (process.platform === "win32" && child.pid) {
        try {
            spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
            }).unref();
        } catch {
            // ignore
        }
    }
}

function extractJsonLineAgentText(stdout: string): string | null {
    const lines = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);

    let lastAgentText: string | null = null;

    for (const line of lines) {
        if (!line.startsWith("{")) continue;
        try {
            const event = JSON.parse(line);
            if (event?.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
                lastAgentText = event.item.text;
            }
        } catch {
            // ignore
        }
    }

    return lastAgentText?.trim() || null;
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

function extractClaudeCodeJsonResult(stdout: string): { text: string | null; error?: string; circuitBreak?: boolean } {
    const cleaned = stripAnsi(stdout).trim();
    if (!cleaned) {
        return { text: null, error: "Claude Code CLI 未输出 JSON" };
    }

    let parsed: any;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        return { text: null, error: "Claude Code CLI stdout 不是合法 JSON" };
    }

    if (parsed?.is_error === true) {
        const message = typeof parsed.result === "string" ? parsed.result : "Claude Code CLI 返回 is_error=true";
        return {
            text: null,
            error: message,
            circuitBreak: shouldCircuitBreakClaudeCode(message),
        };
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

    return { text: null, error: "Claude Code CLI JSON 缺少 result / structured_output" };
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

async function isChainAvailable(chain: ResolvedSummaryChain): Promise<boolean> {
    if (chain === "antigravity") return isLsAvailable();
    if (chain === "codex") return isCodexBridgeAvailable();
    if (chain === "claude-code") return isClaudeCodeBridgeAvailable();
    return false;
}

async function resolveSummaryCandidates(requested: SummaryChain): Promise<ResolvedSummaryChain[]> {
    if (requested !== "auto") {
        return (await isChainAvailable(requested)) ? [requested] : [];
    }

    const candidates: ResolvedSummaryChain[] = [];
    if (await isLsAvailable()) candidates.push("antigravity");
    if (await isCodexBridgeAvailable()) candidates.push("codex");
    if (shouldEnableClaudeCodeAutoFallback() && await isClaudeCodeBridgeAvailable()) {
        candidates.push("claude-code");
    }
    return candidates;
}

async function generateViaCodex(prompt: string, timeoutMs: number, schema?: Record<string, unknown>, imagePaths: string[] = [], schemaName = "model"): Promise<string | null> {
    const schemaPath = schema
        ? path.join(os.tmpdir(), `mcp-web-fetcher-${schemaName}-schema-${process.pid}-${Date.now()}.json`)
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
        "-m", CODEX_AI_SUMMARY_MODEL,
        "-c", `model_reasoning_effort=${CODEX_AI_SUMMARY_REASONING_EFFORT}`,
        "-c", `model_speed_tier=${CODEX_AI_SUMMARY_SPEED_TIER}`,
        "-C", process.cwd(),
    ];

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
        return await new Promise<string | null>((resolve) => {
            const child = spawnCodex(getCodexCommand(), args);

            let stdout = "";
            let stderr = "";
            let settled = false;

            const finish = (value: string | null) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };

            const timer = setTimeout(() => {
                terminateChild(child);
                finish(null);
            }, timeoutMs);

            child.stdout.on("data", (chunk) => {
                stdout += chunk.toString("utf-8");
            });

            child.stderr.on("data", (chunk) => {
                stderr += chunk.toString("utf-8");
            });

            child.on("error", () => {
                clearTimeout(timer);
                finish(null);
            });

            child.on("close", (code) => {
                clearTimeout(timer);
                const text = extractJsonLineAgentText(stdout);
                if (code === 0 && text) {
                    finish(text);
                    return;
                }
                if (stderr) {
                    console.error(`[model-bridge] Codex bridge failed: ${stderr.split(/\r?\n/u).filter(Boolean).slice(0, 3).join(" | ")}`);
                }
                finish(null);
            });

            child.stdin.write(prompt, "utf-8");
            child.stdin.end();
        });
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

async function generateViaClaudeCode(prompt: string, timeoutMs: number): Promise<ProviderCallResult> {
    const now = Date.now();
    if (now < claudeCodeCircuitOpenUntil) {
        console.error("[model-bridge] Claude Code CLI skipped: circuit breaker is open");
        return { text: null, error: "Claude Code CLI 短期熔断中" };
    }

    const maxConcurrency = getClaudeCodeMaxConcurrency();
    if (activeClaudeCodeCalls >= maxConcurrency) {
        console.error("[model-bridge] Claude Code CLI skipped: concurrency limit reached");
        return { text: null, error: "Claude Code CLI 并发上限已满" };
    }

    const budget = parsePositiveNumber(process.env.WEB_FETCHER_CLAUDE_CODE_MAX_BUDGET_USD);
    if (process.env.WEB_FETCHER_CLAUDE_CODE_MAX_BUDGET_USD && budget === null) {
        console.error("[model-bridge] Claude Code CLI skipped: WEB_FETCHER_CLAUDE_CODE_MAX_BUDGET_USD must be a positive number");
        return { text: null, error: "WEB_FETCHER_CLAUDE_CODE_MAX_BUDGET_USD 必须是正数" };
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
        "--model", CLAUDE_CODE_AI_SUMMARY_MODEL,
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
        return await new Promise<ProviderCallResult>((resolve) => {
            const child = spawnCommand(getClaudeCodeCommand(), args, childEnv);
            let stdout = "";
            let stderr = "";
            let settled = false;

            const finish = (value: ProviderCallResult) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };

            const timer = setTimeout(() => {
                terminateChild(child);
                console.error("[model-bridge] Claude Code CLI timed out");
                finish({ text: null, error: "Claude Code CLI 调用超时" });
            }, effectiveTimeout);

            const appendWithLimit = (current: string, chunk: Buffer): string => {
                const next = current + chunk.toString("utf-8");
                if (next.length > DEFAULT_OUTPUT_LIMIT) {
                    terminateChild(child);
                    return next.slice(0, DEFAULT_OUTPUT_LIMIT);
                }
                return next;
            };

            child.stdout.on("data", (chunk: Buffer) => {
                stdout = appendWithLimit(stdout, chunk);
            });

            child.stderr.on("data", (chunk: Buffer) => {
                stderr = appendWithLimit(stderr, chunk);
            });

            child.on("error", () => {
                clearTimeout(timer);
                finish({ text: null, error: "Claude Code CLI 子进程启动失败" });
            });

            child.on("close", (code) => {
                if (settled) return;
                clearTimeout(timer);
                const parsed = extractClaudeCodeJsonResult(stdout);
                if (code === 0 && parsed.text) {
                    finish({ text: parsed.text });
                    return;
                }

                const diagnostic = parsed.error || diagnosticSnippet(stderr) || `exit code ${code}`;
                if (parsed.circuitBreak || shouldCircuitBreakClaudeCode(diagnostic)) {
                    claudeCodeCircuitOpenUntil = Date.now() + getClaudeCodeCircuitMs();
                }
                console.error(`[model-bridge] Claude Code CLI failed: ${diagnostic}`);
                finish({ text: null, error: diagnostic });
            });

            child.stdin.write(prompt, "utf-8");
            child.stdin.end();
        });
    } finally {
        activeClaudeCodeCalls = Math.max(0, activeClaudeCodeCalls - 1);
    }
}

export function buildSummaryPrompt(content: string, url: string): SummaryPromptInfo {
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const pageTitle = titleMatch ? titleMatch[1].trim() : url.split("/").pop() || "未知页面";
    const truncatedContent = content.slice(0, AI_SUMMARY_MAX_INPUT);
    const prompt = AI_SUMMARY_PROMPT_TEMPLATE
        .replace("{pageTitle}", pageTitle)
        .replace("{url}", url)
        .replace("{content}", truncatedContent);

    return {
        pageTitle,
        truncatedContent,
        prompt,
    };
}

export async function generateSummaryText(
    prompt: string,
    chain: SummaryChain = "auto",
    timeoutMs: number = CODEX_AI_SUMMARY_TIMEOUT
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

    const chain = request.chain ?? "auto";
    const timeoutMs = request.timeoutMs ?? CODEX_AI_SUMMARY_TIMEOUT;
    const candidates = await resolveSummaryCandidates(chain);
    if (candidates.length === 0) {
        return {
            text: null,
            chainUsed: null,
            providerLabel: null,
            error: chain === "auto"
                ? "Antigravity LS、Codex 模型桥与 Claude Code CLI 当前都不可用"
                : `指定链路 ${chain} 当前不可用`,
        };
    }

    const callResolved = async (target: ResolvedSummaryChain): Promise<SummaryBridgeResult> => {
        if (target === "antigravity") {
            const text = await callGetModelResponse(request.prompt, undefined, timeoutMs, request.imagePaths ?? []);
            return {
                text,
                chainUsed: text ? "antigravity" : null,
                providerLabel: text ? AI_SUMMARY_ANTIGRAVITY_LABEL : null,
                error: text ? undefined : "Antigravity LS 模型调用失败",
            };
        }

        if (target === "claude-code") {
            const result = await generateViaClaudeCode(request.prompt, timeoutMs);
            return {
                text: result.text,
                chainUsed: result.text ? "claude-code" : null,
                providerLabel: result.text ? AI_SUMMARY_CLAUDE_CODE_LABEL : null,
                error: result.text ? undefined : `Claude Code CLI 模型调用失败${result.error ? `: ${result.error}` : ""}`,
            };
        }

        const text = await generateViaCodex(
            request.prompt,
            timeoutMs,
            request.schema,
            request.imagePaths ?? [],
            request.schemaName,
        );
        return {
            text,
            chainUsed: text ? "codex" : null,
            providerLabel: text ? AI_SUMMARY_CODEX_LABEL : null,
            error: text ? undefined : "Codex 模型桥调用失败",
        };
    };

    const errors: string[] = [];
    for (const candidate of candidates) {
        const result = await callResolved(candidate);
        if (result.text) {
            return result;
        }
        if (result.error) {
            errors.push(`${candidate}: ${result.error}`);
        }
        if (chain !== "auto") {
            return result;
        }
    }

    return {
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
        isLsAvailable(),
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
