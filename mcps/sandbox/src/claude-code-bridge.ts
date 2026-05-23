import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { TEMP_DIR, ensureTempDir } from "./temp-store.js";

export interface ClaudeCodeOptions {
    model?: string;
    effort?: string;
    permissionMode?: string;
    maxBudgetUsd?: number;
    sessionId?: string;
    timeoutMs?: number;
    allowedTools?: string[];
    disallowedTools?: string[];
    mcpConfig?: string;
    strictMcpConfig?: boolean;
    settings?: string;
    settingSources?: string;
    addDir?: string[];
    noSessionPersistence?: boolean;
    cwd?: string;
    command?: string;
}

export interface ClaudeCodeResult {
    text: string;
    model: string;
    sessionId: string;
    totalCostUsd?: number;
    durationMs?: number;
    stdoutPath: string;
    stderrPath: string;
    artifactPath?: string;
    jsonlHint?: string;
}

const DEFAULT_CLAUDE_CODE_MODEL = process.env.SANDBOX_CLAUDE_CODE_MODEL || "sonnet";
const DEFAULT_CLAUDE_CODE_TIMEOUT_MS = Number(process.env.SANDBOX_CLAUDE_CODE_TIMEOUT_MS || 120000);
const DEFAULT_CLAUDE_CODE_MAX_BUDGET_USD = Number(process.env.SANDBOX_CLAUDE_CODE_MAX_BUDGET_USD || 0.05);
const MAX_STDIO_CHARS = Number(process.env.SANDBOX_CLAUDE_CODE_STDIO_MAX_CHARS || 4000);
const MAX_DIRECT_PROMPT_CHARS = Number(process.env.SANDBOX_CLAUDE_CODE_DIRECT_PROMPT_CHARS || 24000);
const ARTIFACT_START = "<<<SANDBOX_CLAUDE_CODE_RESPONSE>>>";
const ARTIFACT_END = "<<<END_SANDBOX_CLAUDE_CODE_RESPONSE>>>";

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

function safeName(input: string): string {
    return input.replace(/[^\w.-]+/gu, "_").slice(0, 80) || "claude-code";
}

function nowStamp(): string {
    const now = new Date();
    const random = Math.random().toString(36).slice(2, 8);
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}-${process.pid}-${random}`;
}

function claudeCallDir(): string {
    ensureTempDir();
    const dir = path.join(TEMP_DIR, "claude-code-calls");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function readClip(filePath: string, maxChars = MAX_STDIO_CHARS): string {
    try {
        if (!fs.existsSync(filePath)) return "";
        const stat = fs.statSync(filePath);
        const byteBudget = Math.min(stat.size, Math.max(maxChars * 4, 4096));
        const fd = fs.openSync(filePath, "r");
        try {
            const buffer = Buffer.alloc(byteBudget);
            const bytesRead = fs.readSync(fd, buffer, 0, byteBudget, 0);
            const text = buffer.subarray(0, bytesRead).toString("utf-8");
            return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n... (truncated ${text.length - maxChars} chars)`;
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return "";
    }
}

function killProcessTree(pid?: number): void {
    if (!pid) return;
    if (process.platform === "win32") {
        try {
            const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
                windowsHide: true,
                stdio: "ignore",
            });
            killer.unref();
        } catch {
            // Best-effort cleanup.
        }
        return;
    }
    try {
        process.kill(-pid, "SIGTERM");
    } catch {
        try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
    }
}

function findClaudeCommand(command?: string): string {
    if (command?.trim()) return command.trim();
    const candidates = [
        path.join(process.env.APPDATA || "", "npm", "claude.cmd"),
        path.join(process.env.APPDATA || "", "npm", "claude"),
    ];
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    return "claude";
}

export function isClaudeCodeCliAvailable(command?: string): boolean {
    const resolved = findClaudeCommand(command);
    if (path.isAbsolute(resolved) && fs.existsSync(resolved)) return true;
    try {
        const probe = spawnSync(process.platform === "win32" ? "where" : "which", [resolved], {
            windowsHide: true,
            stdio: "ignore",
            shell: process.platform === "win32",
            timeout: 3000,
        });
        return probe.status === 0;
    } catch {
        return false;
    }
}

function getStringArray(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
    }
    if (typeof value === "string" && value.trim()) {
        return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
    return undefined;
}

function readArtifact(artifactPath: string): string {
    if (!fs.existsSync(artifactPath)) throw new Error(`Claude Code 未写入响应文件: ${artifactPath}`);
    const raw = fs.readFileSync(artifactPath, "utf-8");
    const start = raw.lastIndexOf(ARTIFACT_START);
    const end = raw.lastIndexOf(ARTIFACT_END);
    if (start < 0 || end <= start) throw new Error(`Claude Code 响应文件缺少 ${ARTIFACT_START}/${ARTIFACT_END} 标记`);
    const text = raw.slice(start + ARTIFACT_START.length, end).trim();
    if (!text) throw new Error("Claude Code artifact 未返回文本");
    return text;
}

function parseClaudeJson(stdout: string): { text?: string; sessionId?: string; totalCostUsd?: number; durationMs?: number; model?: string } {
    const trimmed = stdout.trim();
    if (!trimmed) return {};
    let data: any;
    try {
        data = JSON.parse(trimmed);
    } catch {
        const lines = trimmed.split(/\r?\n/u).filter((line) => line.trim().startsWith("{"));
        for (let index = lines.length - 1; index >= 0; index--) {
            try {
                data = JSON.parse(lines[index]);
                break;
            } catch {
                // Keep scanning.
            }
        }
    }
    if (!data) return {};
    const modelUsage = data.modelUsage && typeof data.modelUsage === "object"
        ? Object.entries(data.modelUsage as Record<string, any>)
            .sort((a, b) => (Number(b[1]?.costUSD) || 0) - (Number(a[1]?.costUSD) || 0))
            .map(([model]) => model)
        : [];
    return {
        text: typeof data.result === "string" ? data.result.trim() : undefined,
        sessionId: typeof data.session_id === "string" ? data.session_id : undefined,
        totalCostUsd: typeof data.total_cost_usd === "number" ? data.total_cost_usd : undefined,
        durationMs: typeof data.duration_ms === "number" ? data.duration_ms : undefined,
        model: modelUsage[0],
    };
}

function makeArtifactPrompt(prompt: string, promptPath: string, artifactPath: string): string {
    fs.writeFileSync(promptPath, prompt, "utf-8");
    return [
        `Read the full UTF-8 task from: ${promptPath}`,
        `Write your final answer to: ${artifactPath}`,
        "Do not print the full answer to stdout.",
        "The file must contain exactly these markers around the answer:",
        ARTIFACT_START,
        "...answer...",
        ARTIFACT_END,
    ].join("\n");
}

function maybeFindJsonl(sessionId: string): string | undefined {
    const root = path.join(os.homedir(), ".claude", "projects");
    if (!sessionId || !fs.existsSync(root)) return undefined;
    const stack = [root];
    while (stack.length > 0) {
        const current = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
            } else if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
                return full;
            }
        }
    }
    return undefined;
}

export function claudeCodeOptionsFromParams(params: Record<string, unknown> | undefined): ClaudeCodeOptions {
    const numberParam = (key: string): number | undefined => {
        const value = params?.[key];
        return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    };
    const stringParam = (key: string): string | undefined => {
        const value = params?.[key];
        return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };
    return {
        model: stringParam("model"),
        effort: stringParam("effort") || stringParam("reasoning") || stringParam("reasoningEffort"),
        permissionMode: stringParam("permissionMode"),
        maxBudgetUsd: numberParam("maxBudgetUsd") ?? numberParam("max_budget_usd") ?? numberParam("budgetUsd"),
        sessionId: stringParam("sessionId"),
        timeoutMs: numberParam("timeoutMs") ?? numberParam("modelTimeoutMs"),
        allowedTools: getStringArray(params?.allowedTools),
        disallowedTools: getStringArray(params?.disallowedTools),
        mcpConfig: stringParam("mcpConfig"),
        strictMcpConfig: typeof params?.strictMcpConfig === "boolean" ? params.strictMcpConfig : undefined,
        settings: stringParam("settings"),
        settingSources: stringParam("settingSources"),
        addDir: getStringArray(params?.addDir),
        noSessionPersistence: typeof params?.noSessionPersistence === "boolean" ? params.noSessionPersistence : undefined,
        cwd: stringParam("cwd"),
        command: stringParam("command") || stringParam("cli"),
    };
}

export async function callClaudeCodeText(prompt: string, options: ClaudeCodeOptions = {}): Promise<ClaudeCodeResult> {
    const command = findClaudeCommand(options.command);
    if (!isClaudeCodeCliAvailable(command)) {
        throw new Error("Claude Code 链路不可用：未发现 claude CLI");
    }
    const cwd = path.resolve(options.cwd || process.cwd());
    const model = options.model || DEFAULT_CLAUDE_CODE_MODEL;
    const timeoutMs = Math.max(10000, options.timeoutMs ?? DEFAULT_CLAUDE_CODE_TIMEOUT_MS);
    const maxBudgetUsd = options.maxBudgetUsd ?? DEFAULT_CLAUDE_CODE_MAX_BUDGET_USD;
    const sessionId = options.sessionId || crypto.randomUUID();
    const base = path.join(claudeCallDir(), `${safeName(model)}_${safeName(sessionId)}_${nowStamp()}`);
    const stdoutPath = `${base}.stdout.json`;
    const stderrPath = `${base}.stderr.txt`;
    const promptPath = `${base}.prompt.txt`;
    const scriptPath = `${base}.ps1`;
    const artifactPath = `${base}.artifact.md`;
    const useArtifact = prompt.length > MAX_DIRECT_PROMPT_CHARS;
    const effectivePrompt = useArtifact ? makeArtifactPrompt(prompt, promptPath, artifactPath) : prompt;

    fs.writeFileSync(promptPath, effectivePrompt, "utf-8");
    fs.writeFileSync(stdoutPath, "", "utf-8");
    fs.writeFileSync(stderrPath, "", "utf-8");
    const cliArgs = [
        "-p", "$prompt",
        "--output-format", "json",
        "--model", psSingleQuoted(model),
        "--session-id", psSingleQuoted(sessionId),
        "--permission-mode", psSingleQuoted(options.permissionMode || "default"),
        "--max-budget-usd", psSingleQuoted(String(maxBudgetUsd)),
    ];
    if (options.effort) cliArgs.push("--effort", psSingleQuoted(options.effort));
    if (options.allowedTools?.length) cliArgs.push("--allowedTools", psSingleQuoted(options.allowedTools.join(",")));
    if (options.disallowedTools?.length) cliArgs.push("--disallowedTools", psSingleQuoted(options.disallowedTools.join(",")));
    if (options.mcpConfig) cliArgs.push("--mcp-config", psSingleQuoted(options.mcpConfig));
    if (options.strictMcpConfig) cliArgs.push("--strict-mcp-config");
    if (options.settings) cliArgs.push("--settings", psSingleQuoted(options.settings));
    if (options.settingSources) cliArgs.push("--setting-sources", psSingleQuoted(options.settingSources));
    for (const dir of options.addDir || []) cliArgs.push("--add-dir", psSingleQuoted(dir));
    if (options.noSessionPersistence) cliArgs.push("--no-session-persistence");
    fs.writeFileSync(scriptPath, [
        "$ErrorActionPreference = 'Continue'",
        `$prompt = Get-Content -LiteralPath ${psSingleQuoted(promptPath)} -Encoding UTF8 -Raw`,
        `& ${psSingleQuoted(command)} ${cliArgs.join(" ")}`,
        "exit $LASTEXITCODE",
    ].join("\n"), "utf-8");

    const output = await new Promise<{ exitCode: number | null; timedOut: boolean }>((resolve, reject) => {
        const stdoutFd = fs.openSync(stdoutPath, "a");
        const stderrFd = fs.openSync(stderrPath, "a");
        let settled = false;
        let timedOut = false;
        const child = spawn(getPowerShellCommand(), [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
        ], {
            cwd,
            env: { ...process.env },
            windowsHide: true,
            stdio: ["ignore", stdoutFd, stderrFd],
        });
        const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child.pid);
            child.kill();
        }, timeoutMs);
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fs.closeSync(stdoutFd);
            fs.closeSync(stderrFd);
            fn();
        };
        child.on("error", (err) => finish(() => reject(err)));
        child.on("close", (exitCode) => finish(() => resolve({ exitCode, timedOut })));
    });

    const stdout = readClip(stdoutPath, Math.max(MAX_STDIO_CHARS, 20000));
    const stderr = readClip(stderrPath, MAX_STDIO_CHARS).trim();
    if (output.timedOut) {
        throw new Error(`Claude Code CLI 调用超时 (${timeoutMs}ms) stdout=${stdoutPath} stderr=${stderrPath}`);
    }
    if (output.exitCode !== 0) {
        throw new Error(`Claude Code CLI 调用失败 exit=${output.exitCode}${stderr ? `: ${stderr}` : ""}`);
    }
    const parsed = parseClaudeJson(stdout);
    const text = useArtifact ? readArtifact(artifactPath) : parsed.text;
    if (!text) {
        throw new Error(`Claude Code CLI 未返回文本 stdout=${stdoutPath}${stderr ? ` stderr=${stderr}` : ""}`);
    }
    const effectiveSessionId = parsed.sessionId || sessionId;
    return {
        text,
        model: parsed.model || model,
        sessionId: effectiveSessionId,
        totalCostUsd: parsed.totalCostUsd,
        durationMs: parsed.durationMs,
        stdoutPath,
        stderrPath,
        artifactPath: useArtifact ? artifactPath : undefined,
        jsonlHint: options.noSessionPersistence ? undefined : maybeFindJsonl(effectiveSessionId),
    };
}
