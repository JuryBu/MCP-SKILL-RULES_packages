import { exec, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { callGetModelResponseDetailed as callLsModelDetailed, isLsAvailable } from "./ls-client.js";
import { normalizeChain, type Chain } from "./chain.js";
import { callAgyWithFallback, type AgyAttempt } from "./agy-client.js";
import { callGrokExec, isGrokBridgeAvailable, mapGrokMaxTokens, mapGrokModel, type GrokContext, type GrokExecDiagnostics, type GrokTrafficClass } from "./grok-client.js";
import { getProviderTransportAdapter, mapProviderTrafficClass, type ProviderTransportLease, type ProviderTransportSettlementKind } from "./provider-transport-adapter.js";
import type { ProviderTrafficClass } from "./provider-control-contracts.js";
import type { FailureClass } from "./record-scheduler-contracts.js";
import { spawnWindowsJobProcess, type WindowsJobProcess } from "./windows-job-process.js";

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
const AGY_STATUS_TTL = 60_000;

function resolveCcOutputMaxBytes(): number {
    const raw = process.env.MEMORY_STORE_CC_OUTPUT_MAX_BYTES;
    const trimmed = raw?.trim() || "";
    if (!/^[1-9]\d*$/u.test(trimmed)) return 2 * 1024 * 1024;
    const configured = Number(trimmed);
    return Number.isSafeInteger(configured) ? configured : 2 * 1024 * 1024;
}

let codexAvailableCache: boolean | null = null;
let codexAvailableAt = 0;
let ccAvailableCache: boolean | null = null;
let ccAvailableAt = 0;
let agyAvailableCache: boolean | null = null;
let agyAvailableAt = 0;

type ResolvedChain = Exclude<Chain, "auto">;

export type ModelBridgeRetryStrategy = "provider-fallback-exhausted";

export interface ModelBridgeResult {
    text: string | null;
    chainUsed: ResolvedChain | null;
    modelUsed?: string | null;
    error?: string;
    timedOut?: boolean;
    cancelled?: boolean;
    grokDiagnostics?: GrokExecDiagnostics;
    failureClass?: FailureClass;
    retryStrategy?: ModelBridgeRetryStrategy;
    agyAttempts?: readonly AgyAttempt[];
}

export interface CodexExecResult {
    text: string | null;
    error?: string;
    timedOut?: boolean;
    failureClass?: FailureClass;
}

export interface ClaudeCodeExecResult {
    text: string | null;
    error?: string;
    timedOut?: boolean;
    cancelled?: boolean;
    failureClass?: FailureClass;
}

export interface ModelBridgeOptions {
    allowClaudeCodeFallback?: boolean;
    agyCommand?: string;
    agyCommandArgs?: readonly string[];
    grokContext?: GrokContext;
    trafficClass?: GrokTrafficClass;
    providerTrafficClass?: ProviderTrafficClass;
    providerLease?: ProviderTransportLease;
    attemptId?: string;
    idempotencyKey?: string;
    antigravityModelOverride?: string;
    shouldCancel?: () => boolean;
    signal?: AbortSignal;
    preResolvedCandidate?: ResolvedChain;
}

function isModelBridgeCancelled(options: ModelBridgeOptions): boolean {
    if (options.signal?.aborted) return true;
    try {
        return options.shouldCancel?.() === true;
    } catch {
        return true;
    }
}

async function cancelUnusedProviderLease(lease: ProviderTransportLease | undefined): Promise<string | null> {
    if (!lease) return null;
    try {
        await getProviderTransportAdapter().cancel(lease);
        return null;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

interface CodexCommandResolutionOptions {
    configuredCommand?: string;
    platform?: NodeJS.Platform;
    localAppData?: string;
}

function resolveCodexCommand(options: CodexCommandResolutionOptions = {}): string {
    const configuredCommand = options.configuredCommand ?? process.env.MEMORY_STORE_CODEX_COMMAND;
    if (configuredCommand) {
        const looksLikePath = path.isAbsolute(configuredCommand) || /[\\/]/u.test(configuredCommand);
        if (!looksLikePath || fs.existsSync(configuredCommand)) return configuredCommand;
    }

    if ((options.platform ?? process.platform) === "win32") {
        const localAppData = options.localAppData ?? process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
        const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
        try {
            const candidates = fs.readdirSync(binRoot, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => path.join(binRoot, entry.name, "codex.exe"))
                .filter((candidate) => fs.existsSync(candidate))
                .map((candidate) => ({ candidate, modifiedAt: fs.statSync(candidate).mtimeMs }))
                .sort((left, right) => right.modifiedAt - left.modifiedAt);
            if (candidates[0]) return candidates[0].candidate;
        } catch {
            return "codex";
        }
    }

    return "codex";
}

function getCodexCommand(): string {
    return resolveCodexCommand();
}

export function resolveCodexCommandForTest(options: CodexCommandResolutionOptions = {}): string {
    return resolveCodexCommand(options);
}

function getClaudeCodeCommand(): string {
    return process.env.MEMORY_STORE_CC_COMMAND || "claude";
}

function getAgyCommand(options: Pick<ModelBridgeOptions, "agyCommand"> = {}): string {
    return options.agyCommand || process.env.MEMORY_STORE_AGY_COMMAND || "agy";
}

function quoteForCmd(arg: string): string {
    if (arg === "") return "\"\"";
    if (!/[\s"]/u.test(arg)) return arg;
    return `"${arg.replace(/"/g, "\"\"")}"`;
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

function probeAgyCommand(command: string, commandArgs: readonly string[] = [], signal?: AbortSignal): Promise<void> {
    const timeoutSignal = AbortSignal.timeout(8_000);
    const probeSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    return getProviderTransportAdapter().execute(
        "agy",
        { trafficClass: "foreground", signal: probeSignal, probe: true },
        async () => {
            if (process.platform === "win32") {
                const job = await spawnWindowsJobProcess(command, [...commandArgs, "--help"], { signal: probeSignal, deadlineAt: Date.now() + 8000 });
                job.stdin.end();
                job.stdout.resume();
                job.stderr.resume();
                const result = await job.completion;
                if (probeSignal.aborted || result.cancelled) throw new Error(signal?.aborted ? "agy --help probe cancelled" : "agy --help probe timed out");
                if (result.exitCode !== 0) throw new Error(`agy --help exited with code ${result.exitCode ?? "unknown"}`);
                return;
            }
            return await new Promise<void>((resolve, reject) => {
            if (probeSignal.aborted) {
                reject(new Error(signal?.aborted ? "agy --help probe cancelled" : "agy --help probe timed out"));
                return;
            }
            let child;
            try {
                child = spawn(command, [...commandArgs, "--help"], {
                    stdio: "ignore",
                    shell: false,
                    windowsHide: true,
                });
            } catch (error) {
                reject(error);
                return;
            }

            let settled = false;
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                probeSignal.removeEventListener("abort", onAbort);
                if (error) reject(error);
                else resolve();
            };
            const onAbort = () => {
                try {
                    child.kill();
                } catch {
                }
                finish(new Error(signal?.aborted ? "agy --help probe cancelled" : "agy --help probe timed out"));
            };
            probeSignal.addEventListener("abort", onAbort, { once: true });
            if (probeSignal.aborted) onAbort();
            child.once("error", error => finish(error));
            child.once("close", code => {
                if (code === 0) finish();
                else finish(new Error(`agy --help exited with code ${code ?? "unknown"}`));
            });
            });
        },
        () => "success",
        error => classifyAgyProbeError(error),
    );
}

function classifyAgyProbeError(error: unknown): ProviderTransportSettlementKind {
    if (error instanceof Error && /cancelled/u.test(error.message)) return "cancelled";
    return error instanceof Error && /timed out/u.test(error.message) ? "unknown" : "availability";
}

export async function isAgyBridgeAvailable(options: Pick<ModelBridgeOptions, "agyCommand" | "agyCommandArgs" | "signal"> = {}): Promise<boolean> {
    if (options.signal?.aborted) return false;
    const now = Date.now();
    const canUseCache = !options.agyCommand;
    if (canUseCache && agyAvailableCache !== null && now - agyAvailableAt < AGY_STATUS_TTL) {
        return agyAvailableCache;
    }

    let available = false;
    try {
        await probeAgyCommand(getAgyCommand(options), options.agyCommandArgs, options.signal);
        available = true;
    } catch {
        available = false;
    }

    if (canUseCache && !options.signal?.aborted) {
        agyAvailableCache = available;
        agyAvailableAt = now;
    }
    return available;
}

function isAgyAutoEnabled(): boolean {
    return process.env.MEMORY_STORE_AGY_AUTO_ENABLED === "1";
}

function createAgyCancellationBridge(options: ModelBridgeOptions): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const abort = () => {
        if (!controller.signal.aborted) controller.abort();
    };
    const onAbort = () => abort();
    if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
    if (isModelBridgeCancelled(options)) abort();

    const cancelPoller = options.shouldCancel && !controller.signal.aborted
        ? setInterval(() => {
            if (isModelBridgeCancelled(options)) abort();
        }, 50)
        : undefined;
    cancelPoller?.unref?.();

    return {
        signal: controller.signal,
        dispose: () => {
            if (cancelPoller) clearInterval(cancelPoller);
            options.signal?.removeEventListener("abort", onAbort);
        },
    };
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

interface ModelBridgeDeadline {
    signal: AbortSignal;
    reason: "cancelled" | "timeout" | null;
    remainingMs(): number;
    elapsedMs(): number;
    cancelled(): boolean;
    dispose(): void;
}

function createModelBridgeDeadline(timeoutMs: number, options: ModelBridgeOptions): ModelBridgeDeadline {
    const startedAt = performance.now();
    const expiresAt = startedAt + Math.max(1, Math.floor(timeoutMs));
    const cancellation = createAgyCancellationBridge(options);
    const controller = new AbortController();
    let reason: ModelBridgeDeadline["reason"] = null;
    const stop = (cause: "cancelled" | "timeout") => {
        if (reason) return;
        reason = cause;
        controller.abort();
    };
    const onCancel = () => stop("cancelled");
    cancellation.signal.addEventListener("abort", onCancel, { once: true });
    if (cancellation.signal.aborted) onCancel();
    const timer = reason ? undefined : setTimeout(() => stop("timeout"), Math.max(1, expiresAt - performance.now()));
    return {
        signal: controller.signal,
        get reason() { return reason; },
        remainingMs() {
            if (!reason && performance.now() >= expiresAt) stop("timeout");
            return reason ? 0 : Math.max(0, Math.floor(expiresAt - performance.now()));
        },
        elapsedMs() { return Math.max(0, Math.round(performance.now() - startedAt)); },
        cancelled() { return reason === "cancelled"; },
        dispose() {
            if (timer) clearTimeout(timer);
            cancellation.signal.removeEventListener("abort", onCancel);
            cancellation.dispose();
        },
    };
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
    const cancellation = createAgyCancellationBridge(options);
    const scopedOptions = { ...options, signal: cancellation.signal };
    const available = (check: () => Promise<boolean>): Promise<boolean> => {
        if (cancellation.signal.aborted) return Promise.resolve(false);
        return new Promise(resolve => {
            let settled = false;
            const finish = (result: boolean) => {
                if (settled) return;
                settled = true;
                cancellation.signal.removeEventListener("abort", onAbort);
                resolve(result && !cancellation.signal.aborted);
            };
            const onAbort = () => finish(false);
            cancellation.signal.addEventListener("abort", onAbort, { once: true });
            if (cancellation.signal.aborted) onAbort();
            else Promise.resolve().then(check).then(finish, () => finish(false));
        });
    };
    try {
        if (chain === "antigravity") return (await available(isLsAvailable)) ? ["antigravity"] : [];
        if (chain === "codex") return (await available(isCodexBridgeAvailable)) ? ["codex"] : [];
        if (chain === "claude-code") return (await available(isClaudeCodeBridgeAvailable)) ? ["claude-code"] : [];
        if (chain === "grok") return (await available(isGrokBridgeAvailable)) ? ["grok"] : [];
        if (chain === "agy") return (await available(() => isAgyBridgeAvailable(scopedOptions))) ? ["agy"] : [];

        const candidates: ResolvedChain[] = [];
        if (await available(isGrokBridgeAvailable)) candidates.push("grok");
        if (isAgyAutoEnabled() && await available(() => isAgyBridgeAvailable(scopedOptions))) candidates.push("agy");
        if (await available(isLsAvailable)) candidates.push("antigravity");
        if (await available(isCodexBridgeAvailable)) candidates.push("codex");
        if (options.allowClaudeCodeFallback && await available(isClaudeCodeBridgeAvailable)) candidates.push("claude-code");
        return cancellation.signal.aborted ? [] : candidates;
    } finally {
        cancellation.dispose();
    }
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
            const finalResult = timedOut
                ? { ...result, timedOut: true, error: result.error || "Codex 模型桥超时", failureClass: "Availability" as const }
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
                finish({ text: null, error: "Codex 模型桥超时", timedOut: true, failureClass: "Availability" });
                return;
            }
            killTreePending = true;
            void killProcessTree(child.pid).then(async (message) => {
                killTreePending = false;
                const byOutputPath = await killProcessesByOutputPath(outputPath);
                killTreeResult = [message, byOutputPath].filter(Boolean).join("; ");
                finish({ text: null, error: "Codex 模型桥超时", timedOut: true, failureClass: "Availability" });
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
            finish({ text: null, error: `Codex 模型桥启动失败: ${err.message}`, failureClass: "Availability" });
        });

        child.on("close", (code) => {
            void (async () => {
            closeCode = code;
            if (timedOut) {
                if (killTreePending) return;
                finish({ text: null, error: "Codex 模型桥超时", timedOut: true, failureClass: "Availability" });
                return;
            }

            let fileText: string | null = null;
            let outputReadError: unknown;
            try {
                if (fs.existsSync(outputPath)) {
                    fileText = fs.readFileSync(outputPath, "utf-8").trim();
                }
            } catch (error) {
                outputReadError = error;
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
                if (outputReadError) {
                    const detail = outputReadError instanceof Error ? `: ${outputReadError.message}` : "";
                    finish({ text: null, error: `Codex 模型桥输出文件读取失败${detail}`, failureClass: "Availability" });
                    return;
                }
                finish({ text: null, error: "Codex 模型桥输出为空", failureClass: "Quality" });
                return;
            }

            const stderrSummary = previewStderr(stderr);
            finish({
                text: null,
                error: stderrSummary ? `Codex 模型桥调用失败: ${stderrSummary}` : `Codex 模型桥调用失败，退出码 ${code}`,
                failureClass: "Availability",
            });
            })();
        });

        child.stdin.write(prompt, "utf-8");
        child.stdin.end();
    });
}

export async function callClaudeCodeExec(
    prompt: string,
    model: string,
    timeoutMs: number = CC_DEFAULT_TIMEOUT_MS,
    options: Pick<ModelBridgeOptions, "shouldCancel" | "signal"> = {},
): Promise<ClaudeCodeExecResult> {
    const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs || CC_DEFAULT_TIMEOUT_MS, CC_MAX_TIMEOUT_MS));
    const outputMaxBytes = resolveCcOutputMaxBytes();
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
    const deadline = createModelBridgeDeadline(effectiveTimeoutMs, options);
    const stoppedResult = (): ClaudeCodeExecResult => deadline.cancelled()
        ? { text: null, error: "Claude Code CLI 模型桥调用已取消", cancelled: true }
        : { text: null, error: "Claude Code CLI 模型桥超时", timedOut: true, failureClass: "Availability" };
    try {
        if (deadline.remainingMs() === 0) return stoppedResult();
        let windowsJob: WindowsJobProcess | undefined;
        let child: ReturnType<typeof spawn> | undefined;
        try {
            if (process.platform === "win32") {
                windowsJob = await spawnWindowsJobProcess("cmd.exe", ["/d", "/s", "/c", commandString], { cwd: process.cwd(), env: process.env, signal: deadline.signal, deadlineAt: Date.now() + deadline.remainingMs() });
            } else {
                child = spawn("sh", ["-lc", commandString], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, cwd: process.cwd(), env: process.env, detached: true });
            }
        } catch (error) {
            if (deadline.remainingMs() === 0) return stoppedResult();
            return { text: null, error: `Claude Code CLI 模型桥启动失败: ${error instanceof Error ? error.message : String(error)}`, failureClass: (error as { launchMayHaveStarted?: boolean })?.launchMayHaveStarted ? "UnknownOutcome" : "Availability" };
        }
        const stdin = windowsJob?.stdin ?? child!.stdin!;
        const stdout = windowsJob?.stdout ?? child!.stdout!;
        const stderr = windowsJob?.stderr ?? child!.stderr!;
        return await new Promise<ClaudeCodeExecResult>(resolve => {
            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];
            let outputBytes = 0;
            let settled = false;
            let stopping = false;
            const finish = (result: ClaudeCodeExecResult) => {
                if (settled) return;
                settled = true;
                deadline.signal.removeEventListener("abort", onAbort);
                resolve(result);
            };
            const cleanupFailed = (error: unknown) => finish({ text: null, error: `Claude Code CLI 进程结束状态异常: ${error instanceof Error ? error.message : String(error)}`, failureClass: "UnknownOutcome", ...(deadline.reason === "timeout" ? { timedOut: true } : deadline.cancelled() ? { cancelled: true } : {}) });
            const stop = (failure: ClaudeCodeExecResult) => {
                if (stopping || settled) return;
                stopping = true;
                stdin.destroy();
                const cleanup = windowsJob ? windowsJob.terminate() : child?.pid ? killProcessTree(child.pid) : Promise.resolve();
                void cleanup.then(() => finish(failure), cleanupFailed);
            };
            const onAbort = () => stop(stoppedResult());
            const collect = (chunk: Buffer, chunks: Buffer[]) => {
                if (settled || stopping) return;
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                if (bytes.length > outputMaxBytes - outputBytes) {
                    stop({ text: null, error: `Claude Code CLI 模型桥输出超过 ${outputMaxBytes} UTF-8 bytes 上限（stdout+stderr），已拒绝不完整答案`, failureClass: "Quality" });
                    return;
                }
                chunks.push(bytes);
                outputBytes += bytes.length;
            };
            stdout.on("data", chunk => collect(chunk, stdoutChunks));
            stderr.on("data", chunk => collect(chunk, stderrChunks));
            stdin.on("error", () => {});
            const closed = (code: number | null) => {
                if (stopping || settled) return;
                if (deadline.remainingMs() === 0) { stop(stoppedResult()); return; }
                const text = Buffer.concat(stdoutChunks).toString("utf8").trim();
                if (code === 0 && text) { finish({ text }); return; }
                if (code === 0) { finish({ text: null, error: "Claude Code CLI 模型桥输出为空", failureClass: "Quality" }); return; }
                const detail = previewStderr(Buffer.concat(stderrChunks).toString("utf8"));
                finish({ text: null, error: detail ? `Claude Code CLI 模型桥调用失败: ${detail}` : `Claude Code CLI 模型桥调用失败，退出码 ${code}`, failureClass: "Availability" });
            };
            if (windowsJob) void windowsJob.completion.then(result => closed(result.exitCode), cleanupFailed);
            else {
                child!.once("error", error => finish({ text: null, error: `Claude Code CLI 模型桥启动失败: ${error.message}`, failureClass: "Availability" }));
                child!.once("close", closed);
            }
            deadline.signal.addEventListener("abort", onAbort, { once: true });
            if (deadline.signal.aborted) onAbort();
            if (!stopping) stdin.end(prompt, "utf8");
        });
    } finally {
        deadline.dispose();
    }
}

export async function callModelResponse(
    model: string,
    prompt: string,
    chain: Chain | string = "auto",
    timeoutMs: number = 30_000,
    options: ModelBridgeOptions = {},
): Promise<ModelBridgeResult> {
    const deadline = createModelBridgeDeadline(timeoutMs, options);
    const deadlineFailure = (phase: "preflight" | "execution"): ModelBridgeResult => ({
        text: null,
        chainUsed: null,
        error: `模型桥${deadline.reason === "cancelled" ? "调用已取消" : "调用超时（总时限已到）"} [phase=${phase}; totalMs=${deadline.elapsedMs()}; admissionWaitMs=unknown; executionMs=${phase === "preflight" ? "0" : "unknown"}]`,
        failureClass: phase === "execution" ? "UnknownOutcome" : "Availability",
        ...(deadline.reason === "cancelled" ? { cancelled: true } : { timedOut: true }),
    });
    try {
    if (deadline.reason === "cancelled") {
        const releaseError = await cancelUnusedProviderLease(options.providerLease);
        return {
            text: null,
            chainUsed: null,
            error: releaseError ? `模型调用已取消；预授予 provider lease 回收失败: ${releaseError}` : "模型调用已取消",
            cancelled: true,
        };
    }
    const rawChain = String(chain || "auto").trim().toLowerCase();
    if (rawChain === "windsurf" || rawChain === "wsf" || rawChain === "dsh" || rawChain === "deepseek-harness") {
        return {
            text: null,
            chainUsed: null,
            error: (rawChain === "dsh" || rawChain === "deepseek-harness" ? "DSH" : "Windsurf")
                + " 只支持 dataChain，不支持 modelChain；请改用 modelChain=auto|antigravity|codex|claude-code|grok|agy",
        };
    }
    const resolvedChain = normalizeChain(chain as string);
    if (options.providerLease && resolvedChain !== "auto" && resolvedChain !== options.providerLease.provider) {
        const releaseError = await cancelUnusedProviderLease(options.providerLease);
        return {
            text: null,
            chainUsed: null,
            error: `预授予 provider=${options.providerLease.provider} lease 不能用于 modelChain=${resolvedChain}`
                + (releaseError ? `；lease 回收失败: ${releaseError}` : ""),
        };
    }
    const candidates = options.providerLease
        ? [options.providerLease.provider]
        : options.preResolvedCandidate && options.preResolvedCandidate === resolvedChain
            ? [options.preResolvedCandidate]
            : resolvedChain === "auto"
                ? (["grok", ...(isAgyAutoEnabled() ? ["agy"] : []), "antigravity", "codex", ...(options.allowClaudeCodeFallback ? ["claude-code"] : [])] as ResolvedChain[])
                : await resolveModelChainCandidates(resolvedChain, { ...options, signal: deadline.signal });
    if (deadline.remainingMs() === 0) return deadlineFailure("preflight");
    let preflightMs = deadline.elapsedMs();
    const autoChecked = new Set<ResolvedChain>();
    const autoAvailable = new Set<ResolvedChain>();
    if (resolvedChain === "auto" && !options.providerLease) {
        for (const candidate of candidates.slice(0, isAgyAutoEnabled() ? 2 : 1)) {
            const probeStartedAt = performance.now();
            const available = await resolveModelChainCandidates(candidate, { ...options, signal: deadline.signal });
            preflightMs += Math.max(0, Math.round(performance.now() - probeStartedAt));
            if (deadline.remainingMs() === 0) return deadlineFailure("preflight");
            autoChecked.add(candidate);
            if (available.length > 0) autoAvailable.add(candidate);
        }
    }
    if (candidates.length === 0) {
        return {
            text: null,
            chainUsed: null,
            error: resolvedChain === "auto"
                ? (options.allowClaudeCodeFallback ? "Grok、agy CLI、Antigravity LS、Codex 模型桥与 Claude Code CLI 当前都不可用" : "Grok、agy CLI、Antigravity LS 与 Codex 模型桥当前都不可用")
                : resolvedChain === "codex"
                    ? "Codex CLI 不可用或模型桥不可用"
                    : resolvedChain === "claude-code"
                        ? "Claude Code CLI 不可用或模型桥不可用"
                        : resolvedChain === "grok"
                            ? "Grok 模型桥不可用或 progrok proxy 不可用"
                            : resolvedChain === "agy"
                                ? "agy CLI 不可用或 --help 检查失败"
                            : `指定链路 ${resolvedChain} 当前不可用`,
            failureClass: "Availability",
        };
    }

    const errors: string[] = [];
    let grokDiagnostics: GrokExecDiagnostics | undefined;
    let singleCandidateFailureClass: FailureClass | undefined;
    const providerTrafficClass = mapProviderTrafficClass(options.providerTrafficClass || options.trafficClass);
    for (const resolved of candidates) {
        if (isModelBridgeCancelled(options)) {
            return { text: null, chainUsed: null, error: "模型调用已取消", cancelled: true };
        }
        if (resolvedChain === "auto" && !options.providerLease) {
            if (!autoChecked.has(resolved)) {
                const probeStartedAt = performance.now();
                const available = await resolveModelChainCandidates(resolved, { ...options, signal: deadline.signal });
                preflightMs += Math.max(0, Math.round(performance.now() - probeStartedAt));
                if (deadline.remainingMs() === 0) return deadlineFailure("preflight");
                autoChecked.add(resolved);
                if (available.length > 0) autoAvailable.add(resolved);
            }
            if (!autoAvailable.has(resolved)) continue;
        }
        const remainingMs = deadline.remainingMs();
        if (remainingMs === 0) return deadlineFailure("preflight");
        if (resolved === "grok") {
            const grokContext = options.grokContext || "default";
            const grokModel = mapGrokModel(model, grokContext);
            const result = await callGrokExec(prompt, grokModel, remainingMs, mapGrokMaxTokens(grokContext), {
                context: grokContext,
                trafficClass: options.trafficClass,
                providerTrafficClass,
                providerLease: options.providerLease,
                attemptId: options.attemptId,
                idempotencyKey: options.idempotencyKey,
                shouldCancel: options.shouldCancel,
                signal: deadline.signal,
            });
            if (deadline.remainingMs() === 0) return { ...deadlineFailure("execution"), failureClass: result.failureClass ?? "UnknownOutcome", grokDiagnostics: result.diagnostics, modelUsed: grokModel };
            grokDiagnostics = result.diagnostics;
            if (candidates.length === 1) singleCandidateFailureClass = result.failureClass;
            if (result.text) return { text: result.text, chainUsed: "grok", modelUsed: grokModel, grokDiagnostics: result.diagnostics };
            if (result.cancelled) {
                return {
                    text: null,
                    chainUsed: "grok",
                    modelUsed: grokModel,
                    error: result.error || "Grok 模型桥调用已取消",
                    cancelled: true,
                    failureClass: result.failureClass,
                    grokDiagnostics: result.diagnostics,
                };
            }
            errors.push(result.error || "Grok 模型桥调用失败");
            if (result.failureClass === "UnknownOutcome") return { text: null, chainUsed: "grok", modelUsed: grokModel, error: result.error, failureClass: result.failureClass, grokDiagnostics: result.diagnostics };
            if (result.timedOut && resolvedChain === "grok") {
                return {
                    text: null,
                    chainUsed: null,
                    modelUsed: grokModel,
                    error: result.error || "Grok 模型桥超时",
                    timedOut: true,
                    failureClass: result.failureClass,
                    grokDiagnostics: result.diagnostics,
                };
            }
            continue;
        }

        if (resolved === "agy") {
            const result = await callAgyWithFallback(prompt, {
                        command: options.agyCommand,
                        commandArgs: options.agyCommandArgs,
                        timeoutMs: remainingMs,
                        signal: deadline.signal,
                        trafficClass: providerTrafficClass,
                        providerLease: options.providerLease,
                        attemptId: options.attemptId,
                    });
            if (result.text && deadline.remainingMs() > 0) return { text: result.text, chainUsed: "agy", modelUsed: result.model };
            const diagnostics = result.timing
                ? ` [phase=${result.phase || "unknown"}; totalMs=${deadline.elapsedMs()}; preflightMs=${preflightMs}; admissionWaitMs=${Math.round(result.timing.admissionWaitMs)}; executionMs=${Math.round(result.timing.executionMs)}]`
                : "";
            const agyError = `${deadline.reason === "timeout" ? "agy CLI 调用超时" : result.error || "agy CLI 模型调用失败"}${diagnostics}`;
            if (deadline.remainingMs() === 0) {
                return {
                    text: null,
                    chainUsed: null,
                    modelUsed: result.model,
                    error: agyError,
                    ...(deadline.cancelled() ? { cancelled: true } : { timedOut: true }),
                    failureClass: result.failureClass,
                    agyAttempts: result.attempts,
                };
            }
            if (result.cancelled) {
                return {
                    text: null,
                    chainUsed: "agy",
                    modelUsed: result.model,
                    error: agyError,
                    cancelled: true,
                    failureClass: result.failureClass,
                    agyAttempts: result.attempts,
                };
            }
            errors.push(agyError);
            if (result.timedOut && resolvedChain === "agy") {
                return {
                    text: null,
                    chainUsed: null,
                    modelUsed: result.model,
                    error: agyError,
                    timedOut: true,
                    failureClass: result.failureClass,
                    retryStrategy: "provider-fallback-exhausted",
                    agyAttempts: result.attempts,
                };
            }
            if (resolvedChain === "agy" || result.failureClass === "UnknownOutcome" || result.truncated) {
                return {
                    text: null,
                    chainUsed: null,
                    modelUsed: result.model,
                    error: agyError,
                    failureClass: result.failureClass,
                    retryStrategy: "provider-fallback-exhausted",
                    agyAttempts: result.attempts,
                };
            }
            continue;
        }

        if (resolved === "antigravity") {
            const lsModel = options.antigravityModelOverride || model;
            const result = await callLsModelDetailed(lsModel, prompt, remainingMs);
            if (deadline.remainingMs() === 0) return { ...deadlineFailure("execution"), modelUsed: lsModel, error: [result.error, deadlineFailure("execution").error].filter(Boolean).join("；") };
            if (candidates.length === 1) singleCandidateFailureClass = result.failureClass;
            if (result.text) return { text: result.text, chainUsed: "antigravity", modelUsed: lsModel };
            errors.push(result.error || "Antigravity LS 模型调用失败");
            // 真超时：与 codex 分支对齐早返回，透传 timedOut 让上层区分「超时」vs「普通失败」，
            // 不再无条件落到下个候选 / 触发重试（避免一次真超时后又白等一整轮）。
            if (result.timedOut) {
                return {
                    text: null,
                    chainUsed: null,
                    modelUsed: lsModel,
                    error: result.error || "Antigravity LS 模型调用超时",
                    timedOut: true,
                    failureClass: result.failureClass,
                };
            }
            continue;
        }

        if (resolved === "codex") {
            const result = await callCodexExec(prompt, model, remainingMs);
            if (deadline.remainingMs() === 0) return deadlineFailure("execution");
            if (candidates.length === 1) singleCandidateFailureClass = result.failureClass;
            if (result.text) return { text: result.text, chainUsed: "codex", modelUsed: model };
            errors.push(result.error || "Codex 模型桥调用失败");
            if (result.timedOut || chain === "codex") {
                return {
                    text: null,
                    chainUsed: null,
                    modelUsed: model,
                    error: result.error || "Codex 模型桥调用失败",
                    timedOut: result.timedOut,
                    failureClass: result.failureClass,
                };
            }
            continue;
        }

        const result = await callClaudeCodeExec(prompt, model, remainingMs, { ...options, signal: deadline.signal });
        if (deadline.remainingMs() === 0) return deadlineFailure("execution");
        if (candidates.length === 1) singleCandidateFailureClass = result.failureClass;
        if (result.text) return { text: result.text, chainUsed: "claude-code", modelUsed: model };
        if (result.cancelled) {
            return { text: null, chainUsed: "claude-code", modelUsed: model, error: result.error, cancelled: true };
        }
        errors.push(result.error || "Claude Code CLI 模型桥调用失败");
        return {
            text: null,
            chainUsed: null,
            modelUsed: model,
            error: result.error || "Claude Code CLI 模型桥调用失败",
            timedOut: result.timedOut,
            failureClass: result.failureClass,
        };
    }

    return {
        text: null,
        chainUsed: null,
        error: errors.join("；") || "模型桥调用失败",
        ...(singleCandidateFailureClass ? { failureClass: singleCandidateFailureClass } : {}),
        ...(grokDiagnostics ? { grokDiagnostics } : {}),
    };
    } finally {
        deadline.dispose();
        await cancelUnusedProviderLease(options.providerLease);
    }
}
