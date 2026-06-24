import { exec, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { callGetModelResponseDetailed as callLsModelDetailed, isLsAvailable } from "./ls-client.js";
import { normalizeChain, type Chain } from "./chain.js";

const execAsync = promisify(exec);
const CODEX_STATUS_TTL = 60_000;
const CODEX_DEFAULT_MODEL = process.env.MEMORY_STORE_CODEX_MODEL || "gpt-5.5";
const CODEX_DEFAULT_REASONING_EFFORT = process.env.MEMORY_STORE_CODEX_REASONING || "medium";
const CODEX_DEFAULT_SPEED_TIER = process.env.MEMORY_STORE_CODEX_SPEED || "fast";
const CODEX_DEFAULT_TIMEOUT_MS = Number(process.env.MEMORY_STORE_CODEX_TIMEOUT || 5 * 60_000);
const CODEX_MAX_TIMEOUT_MS = Number(process.env.MEMORY_STORE_CODEX_MAX_TIMEOUT || Math.max(CODEX_DEFAULT_TIMEOUT_MS, 10 * 60_000));
const CODEX_KILL_TREE_TIMEOUT_MS = Number(process.env.MEMORY_STORE_CODEX_KILL_TIMEOUT || 8_000);
const CODEX_OUTPUT_PATH_KILL_TIMEOUT_MS = Number(process.env.MEMORY_STORE_CODEX_OUTPUT_KILL_TIMEOUT || 8_000);
const CC_STATUS_TTL = 60_000;
const CC_DEFAULT_MODEL = process.env.MEMORY_STORE_CC_MODEL || "sonnet";
const CC_DEFAULT_EFFORT = process.env.MEMORY_STORE_CC_EFFORT || "medium";
const CC_DEFAULT_TIMEOUT_MS = Number(process.env.MEMORY_STORE_CC_MODEL_TIMEOUT_MS || 3 * 60_000);
const CC_MAX_TIMEOUT_MS = Number(process.env.MEMORY_STORE_CC_MAX_TIMEOUT_MS || Math.max(CC_DEFAULT_TIMEOUT_MS, 8 * 60_000));
const CC_OUTPUT_MAX_BYTES = Number(process.env.MEMORY_STORE_CC_OUTPUT_MAX_BYTES || 2 * 1024 * 1024);

let codexAvailableCache: boolean | null = null;
let codexAvailableAt = 0;
let ccAvailableCache: boolean | null = null;
let ccAvailableAt = 0;
let antigravityHostCache: boolean | null = null;

type ResolvedChain = Exclude<Chain, "auto">;

export interface ModelBridgeResult {
    text: string | null;
    chainUsed: ResolvedChain | null;
    error?: string;
    timedOut?: boolean;
}

export interface CodexExecResult {
    text: string | null;
    error?: string;
    timedOut?: boolean;
}

export interface ClaudeCodeExecResult {
    text: string | null;
    error?: string;
    timedOut?: boolean;
}

export interface ModelBridgeOptions {
    allowClaudeCodeFallback?: boolean;
}

function getCodexCommand(): string {
    return process.env.MEMORY_STORE_CODEX_COMMAND || "codex";
}

function getClaudeCodeCommand(): string {
    return process.env.MEMORY_STORE_CC_COMMAND || "claude";
}

function quoteForCmd(arg: string): string {
    if (arg === "") return "\"\"";
    if (!/[\s"]/u.test(arg)) return arg;
    return `"${arg.replace(/"/g, "\"\"")}"`;
}

async function isLikelyAntigravityHost(): Promise<boolean> {
    if (antigravityHostCache !== null) return antigravityHostCache;
    if (process.platform !== "win32") {
        antigravityHostCache = false;
        return false;
    }

    try {
        const result = await execAsync(`wmic process where ProcessId=${process.ppid} get Name /value`, {
            timeout: 5000,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });
        antigravityHostCache = result.stdout.toLowerCase().includes("language_server");
        return antigravityHostCache;
    } catch {
        antigravityHostCache = false;
        return false;
    }
}

function extractLastAgentText(stdout: string): string | null {
    const lines = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);

    let lastText: string | null = null;

    for (const line of lines) {
        if (!line.startsWith("{")) continue;
        try {
            const event = JSON.parse(line);
            if (event?.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
                lastText = event.item.text;
            } else if (event?.type === "thread.item.completed" && event.item?.type === "assistant_message" && typeof event.item?.text === "string") {
                lastText = event.item.text;
            }
        } catch {
            // ignore malformed json lines
        }
    }

    return lastText?.trim() || null;
}

export async function isCodexBridgeAvailable(): Promise<boolean> {
    const now = Date.now();
    if (codexAvailableCache !== null && now - codexAvailableAt < CODEX_STATUS_TTL) {
        return codexAvailableCache;
    }

    try {
        await execAsync(`${quoteForCmd(getCodexCommand())} --version`, {
            timeout: 8000,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });
        codexAvailableCache = true;
    } catch {
        codexAvailableCache = false;
    }

    codexAvailableAt = now;
    return codexAvailableCache;
}

export async function isClaudeCodeBridgeAvailable(): Promise<boolean> {
    const now = Date.now();
    if (ccAvailableCache !== null && now - ccAvailableAt < CC_STATUS_TTL) {
        return ccAvailableCache;
    }

    try {
        await execAsync(`${quoteForCmd(getClaudeCodeCommand())} --version`, {
            timeout: 8000,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
        });
        ccAvailableCache = true;
    } catch {
        ccAvailableCache = false;
    }

    ccAvailableAt = now;
    return ccAvailableCache;
}

function previewStderr(stderr: string): string {
    return stderr
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" | ");
}

function cleanupOutputFile(outputPath: string): void {
    try {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {
        // ignore cleanup failure
    }
}

function killProcessTree(pid: number): Promise<string> {
    return new Promise((resolve) => {
        if (process.platform === "win32") {
            const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });

            let stdout = "";
            let stderr = "";
            let settled = false;
            const settle = (message: string) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(message);
            };

            const timer = setTimeout(() => {
                try {
                    killer.kill();
                } catch {
                    // ignore kill failure
                }
                settle("taskkill timed out");
            }, CODEX_KILL_TREE_TIMEOUT_MS);

            killer.stdout.on("data", (chunk) => {
                stdout += chunk.toString("utf-8");
            });
            killer.stderr.on("data", (chunk) => {
                stderr += chunk.toString("utf-8");
            });
            killer.on("error", (err) => settle(`taskkill error: ${err.message}`));
            killer.on("close", (code) => {
                const detail = previewStderr(stderr) || stdout.trim().split(/\r?\n/u).slice(-1)[0] || "";
                settle(`taskkill exit=${code}${detail ? ` detail=${detail}` : ""}`);
            });
            return;
        }

        try {
            process.kill(-pid, "SIGTERM");
            resolve("sent SIGTERM to process group");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            resolve(`kill error: ${message}`);
        }
    });
}

function killProcessesByOutputPath(outputPath: string): Promise<string> {
    return new Promise((resolve) => {
        if (process.platform !== "win32") {
            resolve("");
            return;
        }

        const escapedNeedle = outputPath.replace(/'/g, "''");
        const script = `
$ProgressPreference = 'SilentlyContinue'
$needle = '${escapedNeedle}'
$matches = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and $_.CommandLine.Contains($needle) -and $_.ProcessId -ne $PID
}
$stopped = @()
foreach ($p in $matches) {
  try {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
    $stopped += "$($p.ProcessId):$($p.Name)"
  } catch {
    $stopped += "$($p.ProcessId):$($p.Name):$($_.Exception.Message)"
  }
}
if ($stopped.Count -gt 0) { [Console]::Out.Write(($stopped -join ",")) }
`;
        const encoded = Buffer.from(script, "utf16le").toString("base64");
        const killer = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });

        let stdout = "";
        let stderr = "";
        let settled = false;
        const settle = (message: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(message);
        };

        const timer = setTimeout(() => {
            try {
                killer.kill();
            } catch {
                // ignore kill failure
            }
            settle("output-path kill timed out");
        }, CODEX_OUTPUT_PATH_KILL_TIMEOUT_MS);

        killer.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf-8");
        });
        killer.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf-8");
        });
        killer.on("error", (err) => settle(`output-path kill error: ${err.message}`));
        killer.on("close", (code) => {
            const detail = previewStderr(stderr) || stdout.trim();
            settle(detail ? `output-path kill exit=${code} detail=${detail}` : "");
        });
    });
}

function mapClaudeCodeModel(model: string): string {
    const lower = model.toLowerCase();
    if (lower.includes("opus")) return "opus";
    if (lower.includes("haiku")) return "haiku";
    return CC_DEFAULT_MODEL;
}

export async function resolveModelChainCandidates(
    chain: Chain = "auto",
    options: ModelBridgeOptions = {},
): Promise<ResolvedChain[]> {
    chain = normalizeChain(chain as string);
    if (chain === "antigravity") {
        return (await isLsAvailable()) ? ["antigravity"] : [];
    }
    if (chain === "codex") {
        return (await isCodexBridgeAvailable()) ? ["codex"] : [];
    }
    if (chain === "claude-code") {
        return (await isClaudeCodeBridgeAvailable()) ? ["claude-code"] : [];
    }

    const preferLs = await isLikelyAntigravityHost();
    const candidates: ResolvedChain[] = [];
    if (preferLs) {
        if (await isLsAvailable()) candidates.push("antigravity");
        if (await isCodexBridgeAvailable()) candidates.push("codex");
    } else {
        if (await isCodexBridgeAvailable()) candidates.push("codex");
        if (await isLsAvailable()) candidates.push("antigravity");
    }
    if (options.allowClaudeCodeFallback && await isClaudeCodeBridgeAvailable()) candidates.push("claude-code");
    return candidates;
}

export async function resolveModelChain(chain: Chain = "auto", options: ModelBridgeOptions = {}): Promise<ResolvedChain | null> {
    return (await resolveModelChainCandidates(chain, options))[0] || null;
}

function mapModelName(model: string): string {
    const lower = model.toLowerCase();
    if (lower.includes("flash")) return CODEX_DEFAULT_MODEL;
    if (lower.includes("gpt-5.5")) return "gpt-5.5";
    if (lower.includes("gpt-5.4")) return "gpt-5.4";
    if (lower.includes("gpt-5.3")) return "gpt-5.3-codex";
    return CODEX_DEFAULT_MODEL;
}

export async function callCodexExec(prompt: string, model: string, timeoutMs: number): Promise<CodexExecResult> {
    const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, CODEX_MAX_TIMEOUT_MS));
    const outputPath = path.join(
        os.tmpdir(),
        `memory-store-codex-bridge-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
    );
    const args = [
        "exec",
        "--skip-git-repo-check",
        "--json",
        "--ephemeral",
        "--ignore-rules",
        "--ignore-user-config",
        "--sandbox", "read-only",
        "-m", mapModelName(model),
        "-c", `model_reasoning_effort=${CODEX_DEFAULT_REASONING_EFFORT}`,
        "-c", `model_speed_tier=${CODEX_DEFAULT_SPEED_TIER}`,
        "-C", process.cwd(),
        "-o", outputPath,
        "-",
    ];

    const commandString = `${quoteForCmd(getCodexCommand())} ${args.map(quoteForCmd).join(" ")}`;

    return new Promise<CodexExecResult>((resolve) => {
        const child = spawn(
            process.platform === "win32" ? "cmd.exe" : "sh",
            process.platform === "win32" ? ["/d", "/s", "/c", commandString] : ["-lc", commandString],
            {
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
                cwd: process.cwd(),
                env: process.env,
                detached: process.platform !== "win32",
            }
        );

        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        let killTreePending = false;
        let closeCode: number | null = null;
        let killTreeResult = "";

        console.error(`[model-bridge] Codex bridge spawn pid=${child.pid ?? "?"} timeoutMs=${effectiveTimeoutMs} outputPath=${outputPath}`);

        const finish = (result: CodexExecResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const finalResult = timedOut && !result.timedOut
                ? { ...result, timedOut: true, error: result.error || "Codex 模型桥超时" }
                : result;
            try {
                cleanupOutputFile(outputPath);
            } finally {
                const stderrSummary = previewStderr(stderr);
                if (finalResult.error) {
                    console.error(
                        `[model-bridge] Codex bridge finish pid=${child.pid ?? "?"} code=${closeCode ?? "?"}` +
                        ` timedOut=${timedOut} error=${finalResult.error}` +
                        `${stderrSummary ? ` stderr=${stderrSummary}` : ""}` +
                        `${killTreeResult ? ` killTree=${killTreeResult}` : ""}`
                    );
                }
                resolve(finalResult);
            }
        };

        const timer = setTimeout(() => {
            timedOut = true;
            console.error(`[model-bridge] Codex bridge timeout pid=${child.pid ?? "?"} timeoutMs=${effectiveTimeoutMs} outputPath=${outputPath}`);
            if (!child.pid) {
                finish({ text: null, error: "Codex 模型桥超时", timedOut: true });
                return;
            }
            killTreePending = true;
            void killProcessTree(child.pid).then(async (message) => {
                killTreePending = false;
                const byOutputPath = await killProcessesByOutputPath(outputPath);
                killTreeResult = [message, byOutputPath].filter(Boolean).join("; ");
                finish({ text: null, error: "Codex 模型桥超时", timedOut: true });
            });
        }, effectiveTimeoutMs);

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf-8");
        });

        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf-8");
        });

        child.stdin.on("error", () => {
            // The bridge can close stdin during timeout cleanup.
        });

        child.on("error", (err) => {
            finish({ text: null, error: `Codex 模型桥启动失败: ${err.message}` });
        });

        child.on("close", (code) => {
            void (async () => {
            closeCode = code;
            if (timedOut) {
                if (killTreePending) return;
                finish({ text: null, error: "Codex 模型桥超时", timedOut: true });
                return;
            }

            let fileText: string | null = null;
            try {
                if (fs.existsSync(outputPath)) {
                    fileText = fs.readFileSync(outputPath, "utf-8").trim();
                }
            } catch {
                // ignore read failure
            }

            const text = fileText || extractLastAgentText(stdout);
            if (code === 0 && text) {
                finish({ text });
                return;
            }

            const byOutputPath = await killProcessesByOutputPath(outputPath);
            if (byOutputPath) {
                killTreeResult = [killTreeResult, byOutputPath].filter(Boolean).join("; ");
            }

            if (code === 0) {
                finish({ text: null, error: "Codex 模型桥输出为空" });
                return;
            }

            const stderrSummary = previewStderr(stderr);
            finish({
                text: text || null,
                error: stderrSummary ? `Codex 模型桥调用失败: ${stderrSummary}` : `Codex 模型桥调用失败，退出码 ${code}`,
            });
            })();
        });

        child.stdin.write(prompt, "utf-8");
        child.stdin.end();
    });
}

export async function callClaudeCodeExec(prompt: string, model: string, timeoutMs: number = CC_DEFAULT_TIMEOUT_MS): Promise<ClaudeCodeExecResult> {
    const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs || CC_DEFAULT_TIMEOUT_MS, CC_MAX_TIMEOUT_MS));
    const args = [
        "--print",
        "--input-format", "text",
        "--output-format", "text",
        "--no-session-persistence",
        "--model", mapClaudeCodeModel(model),
        "--effort", CC_DEFAULT_EFFORT,
    ];
    if (process.env.MEMORY_STORE_CC_MAX_BUDGET_USD) {
        args.push("--max-budget-usd", process.env.MEMORY_STORE_CC_MAX_BUDGET_USD);
    }
    const commandString = `${quoteForCmd(getClaudeCodeCommand())} ${args.map(quoteForCmd).join(" ")}`;

    return new Promise<ClaudeCodeExecResult>((resolve) => {
        let child;
        try {
            child = spawn(
                process.platform === "win32" ? "cmd.exe" : "sh",
                process.platform === "win32" ? ["/d", "/s", "/c", commandString] : ["-lc", commandString],
                {
                    stdio: ["pipe", "pipe", "pipe"],
                    windowsHide: true,
                    cwd: process.cwd(),
                    env: process.env,
                    detached: process.platform !== "win32",
                }
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            resolve({ text: null, error: `Claude Code CLI 模型桥启动失败: ${message}` });
            return;
        }

        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        let closeCode: number | null = null;
        let killTreeResult = "";
        let killTreePending = false;

        const finish = (result: ClaudeCodeExecResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const finalResult = timedOut && !result.timedOut
                ? { ...result, timedOut: true, error: result.error || "Claude Code CLI 模型桥超时" }
                : result;
            const stderrSummary = previewStderr(stderr);
            if (finalResult.error) {
                console.error(
                    `[model-bridge] Claude Code bridge finish pid=${child.pid ?? "?"} code=${closeCode ?? "?"}` +
                    ` timedOut=${timedOut} error=${finalResult.error}` +
                    `${stderrSummary ? ` stderr=${stderrSummary}` : ""}` +
                    `${killTreeResult ? ` killTree=${killTreeResult}` : ""}`
                );
            }
            resolve(finalResult);
        };

        const timer = setTimeout(() => {
            timedOut = true;
            if (!child.pid) {
                finish({ text: null, error: "Claude Code CLI 模型桥超时", timedOut: true });
                return;
            }
            killTreePending = true;
            void killProcessTree(child.pid).then((message) => {
                killTreePending = false;
                killTreeResult = message;
                finish({ text: null, error: "Claude Code CLI 模型桥超时", timedOut: true });
            });
        }, effectiveTimeoutMs);

        child.stdout.on("data", (chunk) => {
            if (stdout.length < CC_OUTPUT_MAX_BYTES) {
                stdout += chunk.toString("utf-8").slice(0, CC_OUTPUT_MAX_BYTES - stdout.length);
            }
        });

        child.stderr.on("data", (chunk) => {
            if (stderr.length < CC_OUTPUT_MAX_BYTES) {
                stderr += chunk.toString("utf-8").slice(0, CC_OUTPUT_MAX_BYTES - stderr.length);
            }
        });

        child.stdin.on("error", () => {
            // Ignore stdin close during timeout cleanup.
        });

        child.on("error", (err) => {
            finish({ text: null, error: `Claude Code CLI 模型桥启动失败: ${err.message}` });
        });

        child.on("close", (code) => {
            closeCode = code;
            if (timedOut) {
                if (killTreePending) return;
                finish({ text: null, error: "Claude Code CLI 模型桥超时", timedOut: true });
                return;
            }
            const text = stdout.trim();
            if (code === 0 && text) {
                finish({ text });
                return;
            }
            if (code === 0) {
                finish({ text: null, error: "Claude Code CLI 模型桥输出为空" });
                return;
            }
            const stderrSummary = previewStderr(stderr);
            finish({
                text: text || null,
                error: stderrSummary ? `Claude Code CLI 模型桥调用失败: ${stderrSummary}` : `Claude Code CLI 模型桥调用失败，退出码 ${code}`,
            });
        });

        child.stdin.write(prompt, "utf-8");
        child.stdin.end();
    });
}

export async function callModelResponse(
    model: string,
    prompt: string,
    chain: Chain | string = "auto",
    timeoutMs: number = 30_000,
    options: ModelBridgeOptions = {},
): Promise<ModelBridgeResult> {
    const rawChain = String(chain || "auto").trim().toLowerCase();
    if (rawChain === "windsurf" || rawChain === "wsf") {
        return {
            text: null,
            chainUsed: null,
            error: "Windsurf 只支持 dataChain，不支持 modelChain；请改用 modelChain=auto|antigravity|codex|claude-code",
        };
    }
    const resolvedChain = normalizeChain(chain as string);
    const candidates = await resolveModelChainCandidates(resolvedChain, options);
    if (candidates.length === 0) {
        return {
            text: null,
            chainUsed: null,
            error: resolvedChain === "auto"
                ? (options.allowClaudeCodeFallback ? "Antigravity LS、Codex 模型桥与 Claude Code CLI 当前都不可用" : "Antigravity LS 与 Codex 模型桥当前都不可用")
                : resolvedChain === "codex"
                    ? "Codex CLI 不可用或模型桥不可用"
                    : resolvedChain === "claude-code"
                        ? "Claude Code CLI 不可用或模型桥不可用"
                : `指定链路 ${resolvedChain} 当前不可用`,
        };
    }

    const errors: string[] = [];
    for (const resolved of candidates) {
        if (resolved === "antigravity") {
            const result = await callLsModelDetailed(model, prompt, timeoutMs);
            if (result.text) return { text: result.text, chainUsed: "antigravity" };
            errors.push(result.error || "Antigravity LS 模型调用失败");
            // 真超时：与 codex 分支对齐早返回，透传 timedOut 让上层区分「超时」vs「普通失败」，
            // 不再无条件落到下个候选 / 触发重试（避免一次真超时后又白等一整轮）。
            if (result.timedOut) {
                return {
                    text: null,
                    chainUsed: null,
                    error: result.error || "Antigravity LS 模型调用超时",
                    timedOut: true,
                };
            }
            continue;
        }

        if (resolved === "codex") {
            const result = await callCodexExec(prompt, model, timeoutMs);
            if (result.text) return { text: result.text, chainUsed: "codex" };
            errors.push(result.error || "Codex 模型桥调用失败");
            if (result.timedOut || chain === "codex") {
                return {
                    text: null,
                    chainUsed: null,
                    error: result.error || "Codex 模型桥调用失败",
                    timedOut: result.timedOut,
                };
            }
            continue;
        }

        const result = await callClaudeCodeExec(prompt, model, timeoutMs);
        if (result.text) return { text: result.text, chainUsed: "claude-code" };
        errors.push(result.error || "Claude Code CLI 模型桥调用失败");
        return {
            text: null,
            chainUsed: null,
            error: result.error || "Claude Code CLI 模型桥调用失败",
            timedOut: result.timedOut,
        };
    }

    return {
        text: null,
        chainUsed: null,
        error: errors.join("；") || "模型桥调用失败",
    };
}
