import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { callGetModelResponse, initParentLs, isLsReady } from "./ls-client.js";
import { isAntigravityLS } from "./lifecycle.js";
import { callClaudeCodeText, claudeCodeOptionsFromParams, isClaudeCodeCliAvailable } from "./claude-code-bridge.js";

export type ModelChain = "auto" | "antigravity" | "codex" | "claude-code" | "cc";
export type ResolvedModelChain = "antigravity" | "codex" | "claude-code";

interface BridgeResult {
    chainUsed: ResolvedModelChain;
    text: string;
}

interface CodexExecResult {
    text: string | null;
    error?: string;
}

interface CodexBridgeCandidate {
    model: string;
    reasoning: string;
    speed?: string;
}

const LS_AUTO_MODEL = process.env.SANDBOX_LS_MODEL || "MODEL_PLACEHOLDER_M132";
const CODEX_MODEL = process.env.SANDBOX_CODEX_MODEL || "gpt-5.5";
const CODEX_REASONING = process.env.SANDBOX_CODEX_REASONING || "medium";
const CODEX_SPEED_TIER = process.env.SANDBOX_CODEX_SPEED || "fast";
const CODEX_BRIDGE_REASONING = process.env.SANDBOX_CODEX_BRIDGE_REASONING || "low";
const CODEX_BRIDGE_FALLBACKS_ENABLED = !/^(0|false|off)$/iu.test(process.env.SANDBOX_CODEX_BRIDGE_FALLBACKS_ENABLED || "");
const CODEX_BRIDGE_FALLBACKS = process.env.SANDBOX_CODEX_BRIDGE_FALLBACKS || "gpt-5.5:low,gpt-5.4:low,gpt-5.4-mini:low";
const CODEX_BRIDGE_RETRIES = Math.max(0, Math.min(Number(process.env.SANDBOX_CODEX_BRIDGE_RETRIES ?? 0), 2));
const CODEX_BRIDGE_RETRY_BACKOFF_MS = Math.max(0, Number(process.env.SANDBOX_CODEX_BRIDGE_RETRY_BACKOFF_MS || 500));
const CODEX_DEFAULT_TIMEOUT_MS = Number(process.env.SANDBOX_CODEX_TIMEOUT || 5 * 60_000);
const CODEX_KILL_TREE_TIMEOUT_MS = Number(process.env.SANDBOX_CODEX_KILL_TREE_TIMEOUT || 5_000);
const CODEX_OUTPUT_PATH_KILL_TIMEOUT_MS = Number(process.env.SANDBOX_CODEX_OUTPUT_PATH_KILL_TIMEOUT || 5_000);
let cachedCodexAvailability: boolean | null = null;

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
            // Ignore non-event lines.
        }
    }

    return lastText?.trim() || null;
}

function extractJsonError(stdout: string): string | null {
    const lines = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);

    let lastError: string | null = null;

    for (const line of lines) {
        if (!line.startsWith("{")) continue;
        try {
            const event = JSON.parse(line);
            const message = event?.message || event?.error?.message || event?.error?.error?.message;
            if ((event?.type === "error" || event?.type === "turn.failed") && typeof message === "string") {
                lastError = message;
            }
        } catch {
            // Ignore non-event lines.
        }
    }

    return lastError;
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
        // Ignore cleanup failure.
    }
}

function parseCodexBinArgs(raw: string | undefined): string[] {
    if (!raw?.trim()) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
            return parsed;
        }
    } catch {
        // Fall through to whitespace split for simple local overrides.
    }
    return raw.split(/\s+/u).filter(Boolean);
}

function validateCodexSimpleArg(name: string, value: string): string {
    if (!/^[a-zA-Z0-9._-]+$/u.test(value)) {
        throw new Error(`Codex ${name} 参数格式非法: ${value}`);
    }
    return value;
}

function resolveCodexSpawnTarget(): { command: string; argsPrefix: string[] } {
    const override = process.env.SANDBOX_CODEX_BIN?.trim();
    if (override) {
        return { command: override, argsPrefix: parseCodexBinArgs(process.env.SANDBOX_CODEX_BIN_ARGS) };
    }
    if (process.platform !== "win32") {
        return { command: "codex", argsPrefix: [] };
    }
    const probe = spawnSync("where.exe", ["codex"], {
        windowsHide: true,
        encoding: "utf-8",
    });
    const candidates = (probe.stdout || "")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean);
    const executable = candidates.find((candidate) => /\.(exe|com)$/iu.test(candidate));
    if (executable) return { command: executable, argsPrefix: [] };
    const cmdShim = candidates.find((candidate) => /\.cmd$/iu.test(candidate))
        || path.join(process.env.APPDATA || "", "npm", "codex.cmd");
    const shimDir = path.dirname(cmdShim);
    const npmCodexJs = path.join(shimDir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(npmCodexJs)) {
        const localNode = path.join(shimDir, "node.exe");
        return { command: fs.existsSync(localNode) ? localNode : process.execPath, argsPrefix: [npmCodexJs] };
    }
    return { command: "codex.exe", argsPrefix: [] };
}

function killCodexProcessTree(pid: number): Promise<string> {
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
                try { killer.kill(); } catch { /* ignore */ }
                settle("taskkill timed out");
            }, CODEX_KILL_TREE_TIMEOUT_MS);

            killer.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
            killer.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
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
            try { killer.kill(); } catch { /* ignore */ }
            settle("output-path kill timed out");
        }, CODEX_OUTPUT_PATH_KILL_TIMEOUT_MS);

        killer.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
        killer.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
        killer.on("error", (err) => settle(`output-path kill error: ${err.message}`));
        killer.on("close", (code) => {
            const detail = previewStderr(stderr) || stdout.trim();
            settle(detail ? `output-path kill exit=${code} detail=${detail}` : "");
        });
    });
}

async function isCodexCliAvailable(): Promise<boolean> {
    if (cachedCodexAvailability !== null) return cachedCodexAvailability;
    if (process.env.SANDBOX_CODEX_BIN?.trim()) {
        cachedCodexAvailability = true;
        return true;
    }

    const candidates = [
        path.join(process.env.APPDATA || "", "npm", "codex.cmd"),
        path.join(process.env.APPDATA || "", "npm", "codex"),
    ];
    if (candidates.some(p => p && fs.existsSync(p))) {
        cachedCodexAvailability = true;
        return true;
    }

    cachedCodexAvailability = await new Promise<boolean>((resolve) => {
        const probe = spawn(process.platform === "win32" ? "where.exe" : "which", ["codex"], {
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
        });
        let stdout = "";
        probe.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
        probe.on("error", () => resolve(false));
        probe.on("close", (code) => resolve(code === 0 && stdout.trim().length > 0));
    });
    return cachedCodexAvailability;
}

async function resolveModelChain(requested: ModelChain): Promise<ResolvedModelChain> {
    const hostIsAntigravity = await isAntigravityLS();
    const normalized = requested === "cc" ? "claude-code" : requested;

    if (normalized === "antigravity") {
        await initParentLs();
        if (!isLsReady()) {
            throw new Error("Antigravity 链路不可用：未发现可连接的 LS 进程");
        }
        return "antigravity";
    }

    if (normalized === "codex") {
        if (!(await isCodexCliAvailable())) {
            throw new Error("Codex 链路不可用：未发现 codex CLI");
        }
        return "codex";
    }

    if (normalized === "claude-code") {
        if (!isClaudeCodeCliAvailable()) {
            throw new Error("Claude Code 链路不可用：未发现 claude CLI");
        }
        return "claude-code";
    }

    if (hostIsAntigravity) {
        await initParentLs();
        if (isLsReady()) return "antigravity";
    }

    if (await isCodexCliAvailable()) {
        return "codex";
    }

    await initParentLs();
    if (isLsReady()) return "antigravity";

    throw new Error("auto 链路解析失败：LS 不可用，codex CLI 也不可用");
}

interface CodexTextOptions {
    model?: string;
    reasoning?: string;
    speed?: string;
    signal?: AbortSignal;
}

async function callCodexExec(prompt: string, timeoutMs: number, options: CodexTextOptions = {}): Promise<CodexExecResult> {
    const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, CODEX_DEFAULT_TIMEOUT_MS));
    const tempFile = path.join(
        os.tmpdir(),
        `sandbox-smart-search-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
    );
    const model = options.model || CODEX_MODEL;
    const reasoning = options.reasoning || CODEX_REASONING;
    const speed = options.speed || CODEX_SPEED_TIER;
    const signal = options.signal;
    const codexTarget = resolveCodexSpawnTarget();
    if (signal?.aborted) {
        return { text: null, error: "Codex exec cancelled by background abort" };
    }

    const cmdArgs = [
        ...codexTarget.argsPrefix,
        "exec",
        "--skip-git-repo-check",
        "--json",
        "--ephemeral",
        "--ignore-rules",
        "--ignore-user-config",
        "--sandbox", "read-only",
        "-m", validateCodexSimpleArg("model", model),
        "-c", `model_reasoning_effort=${validateCodexSimpleArg("reasoning", reasoning)}`,
        "-c", `model_speed_tier=${validateCodexSimpleArg("speed", speed)}`,
        "-C", process.cwd(),
        "-o", tempFile,
        "-",
    ];

    return new Promise((resolve) => {
        const proc = spawn(
            codexTarget.command,
            cmdArgs,
            {
                cwd: process.cwd(),
                env: { ...process.env },
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
                shell: false,
            }
        );

        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        let killTreePending = false;
        let closeCode: number | null = null;
        let killTreeResult = "";
        let abortCleanupStarted = false;

        const finish = (result: CodexExecResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            try {
                cleanupOutputFile(tempFile);
            } finally {
                if (result.error) {
                    const stderrSummary = previewStderr(stderr);
                    console.error(
                        `[sandbox-model-bridge] Codex bridge finish pid=${proc.pid ?? "?"} code=${closeCode ?? "?"}` +
                        ` timedOut=${timedOut} error=${result.error}` +
                        `${stderrSummary ? ` stderr=${stderrSummary}` : ""}` +
                        `${killTreeResult ? ` killTree=${killTreeResult}` : ""}`
                    );
                }
                resolve(result);
            }
        };

        const cleanupAfterAbort = (error: string) => {
            if (settled || abortCleanupStarted) return;
            abortCleanupStarted = true;
            timedOut = false;
            console.error(`[sandbox-model-bridge] Codex bridge aborted pid=${proc.pid ?? "?"} outputPath=${tempFile}`);
            if (!proc.pid) {
                finish({ text: null, error });
                return;
            }
            killTreePending = true;
            void killCodexProcessTree(proc.pid).then(async (message) => {
                killTreePending = false;
                const byOutputPath = await killProcessesByOutputPath(tempFile);
                killTreeResult = [message, byOutputPath].filter(Boolean).join("; ");
                finish({ text: null, error });
            });
        };

        const onAbort = () => cleanupAfterAbort("Codex exec cancelled by background abort");
        signal?.addEventListener("abort", onAbort, { once: true });

        const timer = setTimeout(() => {
            timedOut = true;
            console.error(`[sandbox-model-bridge] Codex bridge timeout pid=${proc.pid ?? "?"} timeoutMs=${effectiveTimeoutMs} outputPath=${tempFile}`);
            if (!proc.pid) {
                finish({ text: null, error: `Codex exec timed out after ${effectiveTimeoutMs}ms` });
                return;
            }
            killTreePending = true;
            void killCodexProcessTree(proc.pid).then(async (message) => {
                killTreePending = false;
                const byOutputPath = await killProcessesByOutputPath(tempFile);
                killTreeResult = [message, byOutputPath].filter(Boolean).join("; ");
                finish({ text: null, error: `Codex exec timed out after ${effectiveTimeoutMs}ms` });
            });
        }, effectiveTimeoutMs);
        timer.unref?.();

        proc.stdin?.write(prompt, "utf-8");
        proc.stdin?.end();
        proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
        proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
        proc.stdin?.on("error", () => {
            // The bridge can close stdin during timeout cleanup.
        });
        proc.on("error", () => {
            finish({ text: null, error: "Failed to start codex exec process" });
        });
        proc.on("close", (code) => {
            void (async () => {
            closeCode = code;
            if (abortCleanupStarted) {
                if (killTreePending) return;
                finish({ text: null, error: "Codex exec cancelled by background abort" });
                return;
            }
            if (timedOut) {
                if (killTreePending) return;
                finish({ text: null, error: `Codex exec timed out after ${effectiveTimeoutMs}ms` });
                return;
            }

            let fileText: string | null = null;
            try {
                if (fs.existsSync(tempFile)) {
                    fileText = fs.readFileSync(tempFile, "utf-8").trim();
                }
            } catch { /* ignore read failure */ }

            const text = fileText || extractLastAgentText(stdout);
            if (code === 0 && text) {
                finish({ text });
                return;
            }

            const fallback = stdout.trim() || stderr.trim();
            if (code === 0 && fallback) {
                finish({ text: fallback });
                return;
            }

            const byOutputPath = await killProcessesByOutputPath(tempFile);
            if (byOutputPath) {
                killTreeResult = [killTreeResult, byOutputPath].filter(Boolean).join("; ");
            }

            const jsonError = extractJsonError(stdout);
            const preview = (jsonError || previewStderr(stderr) || stdout.trim())
                .split(/\r?\n/u)
                .filter(Boolean)
                .slice(0, 5)
                .join(" | ");
            finish({
                text: null,
                error: preview ? `codex exec exited with code ${code}: ${preview}` : `codex exec exited with code ${code}`,
            });
            })();
        });
    });
}

export async function callCodexText(prompt: string, timeoutMs: number, options: CodexTextOptions = {}): Promise<string> {
    if (!(await isCodexCliAvailable())) {
        throw new Error("Codex 链路不可用：未发现 codex CLI");
    }
    const result = await callCodexExec(prompt, timeoutMs, options);
    if (!result.text) {
        const model = options.model || CODEX_MODEL;
        const reasoning = options.reasoning || CODEX_REASONING;
        const suffix = result.error ? `：${result.error}` : "";
        throw new Error(`Codex 链路模型调用失败（model=${model}, reasoning=${reasoning}）${suffix}`);
    }
    return result.text;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCodexBridgeCandidate(raw: string): CodexBridgeCandidate | null {
    const value = raw.trim();
    if (!value) return null;
    const [modelPart, reasoningPart, speedPart] = value.split(":").map((part) => part.trim()).filter(Boolean);
    if (!modelPart) return null;
    return {
        model: modelPart,
        reasoning: reasoningPart || CODEX_BRIDGE_REASONING,
        speed: speedPart || CODEX_SPEED_TIER,
    };
}

function codexCandidateKey(candidate: CodexBridgeCandidate): string {
    return `${candidate.model}\u0000${candidate.reasoning}\u0000${candidate.speed || ""}`;
}

function getCodexBridgeCandidates(): CodexBridgeCandidate[] {
    const candidates: CodexBridgeCandidate[] = [{
        model: CODEX_MODEL,
        reasoning: CODEX_BRIDGE_REASONING,
        speed: CODEX_SPEED_TIER,
    }];

    if (CODEX_BRIDGE_FALLBACKS_ENABLED) {
        for (const item of CODEX_BRIDGE_FALLBACKS.split(",")) {
            const candidate = parseCodexBridgeCandidate(item);
            if (candidate) candidates.push(candidate);
        }
    }

    const seen = new Set<string>();
    return candidates.filter((candidate) => {
        const key = codexCandidateKey(candidate);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function isCodexBridgeRetryableError(message: string): boolean {
    if (/Unknown option|invalid|认证失败|未登录|Missing or invalid access token|permission denied|拒绝访问|not found|ENOENT/iu.test(message)) {
        return false;
    }
    if (/cancelled by background abort|background abort|已取消/iu.test(message)) {
        return false;
    }
    return /timeout|timed out|HTTP (408|409|429|500|502|503|504)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|transport|channel closed|空输出|未返回|exited with code/iu.test(message);
}

async function callCodexTextForModelBridge(prompt: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    if (!(await isCodexCliAvailable())) {
        throw new Error("Codex 链路不可用：未发现 codex CLI");
    }

    const candidates = getCodexBridgeCandidates();
    const errors: string[] = [];
    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        for (let attempt = 0; attempt <= CODEX_BRIDGE_RETRIES; attempt++) {
            if (signal?.aborted) {
                throw new Error("Codex 链路模型调用已取消：background abort");
            }
            const result = await callCodexExec(prompt, timeoutMs, { ...candidate, signal });
            if (result.text) return result.text;

            const error = result.error || "Codex exec 未返回文本";
            const label = `${candidate.model}(reasoning=${candidate.reasoning}${candidate.speed ? `, speed=${candidate.speed}` : ""})`;
            errors.push(`${label} attempt ${attempt + 1}/${CODEX_BRIDGE_RETRIES + 1}: ${error}`);
            const canRetry = attempt < CODEX_BRIDGE_RETRIES && isCodexBridgeRetryableError(error);
            if (!canRetry) break;
            if (CODEX_BRIDGE_RETRY_BACKOFF_MS > 0) {
                await sleep(CODEX_BRIDGE_RETRY_BACKOFF_MS * (attempt + 1));
            }
        }

        const lastError = errors[errors.length - 1] || "";
        const canFallback = index < candidates.length - 1 && isCodexBridgeRetryableError(lastError);
        if (!canFallback) break;
    }

    throw new Error(`Codex 链路模型调用失败，fallback 链已结束：${errors.join(" | ")}`);
}

export async function callModelBridge(
    chain: ModelChain,
    prompt: string,
    timeoutMs: number,
    params?: Record<string, unknown>
): Promise<BridgeResult> {
    const signal = params?.signal instanceof AbortSignal ? params.signal : undefined;
    if (signal?.aborted) {
        throw new Error("模型调用已取消：background abort");
    }
    const chainUsed = await resolveModelChain(chain);

    if (chainUsed === "antigravity") {
        const text = await callGetModelResponse(LS_AUTO_MODEL, prompt, timeoutMs);
        if (!text) {
            throw new Error("Antigravity 链路模型调用失败");
        }
        return { chainUsed, text };
    }

    if (chainUsed === "claude-code") {
        const result = await callClaudeCodeText(prompt, {
            ...claudeCodeOptionsFromParams(params),
            timeoutMs: typeof params?.timeoutMs === "number" ? params.timeoutMs : timeoutMs,
        });
        return { chainUsed, text: result.text };
    }

    const text = await callCodexTextForModelBridge(prompt, timeoutMs, signal);
    return { chainUsed, text };
}
