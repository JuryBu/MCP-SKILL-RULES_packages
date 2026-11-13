import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createWindowsJobLaunch, readWindowsJobMetadata, removeWindowsJobMetadata } from "./windows-job-runner.js";
import { AntigravityCallError, antigravityOutcomeFromError } from "./antigravity-model-catalog.js";
import type { PowerShellSpawnResult } from "./council/agy-runtime.js";

interface AgentCliOptions {
    timeoutMs: number;
    signal?: AbortSignal;
    earlyFailure?: (stderr: string) => string | undefined;
    env?: NodeJS.ProcessEnv;
    diagnostics?: string[];
}

type AgentCliRunner = (script: string, cwd: string, logBase: string, options: AgentCliOptions) => Promise<PowerShellSpawnResult>;
let testRunner: AgentCliRunner | undefined;

export function __setAntigravityAgentCliRunnerForTest(runner?: AgentCliRunner): void { testRunner = runner; }

function clipFile(filePath: string): string {
    if (!fs.existsSync(filePath)) return "";
    const handle = fs.openSync(filePath, "r");
    try { const buffer = Buffer.alloc(4096); return buffer.subarray(0, fs.readSync(handle, buffer, 0, buffer.length, 0)).toString("utf8"); }
    finally { fs.closeSync(handle); }
}

export async function runAntigravityAgentCli(script: string, cwd: string, logBase: string, options: AgentCliOptions): Promise<PowerShellSpawnResult> {
    if (testRunner) return await testRunner(script, cwd, logBase, options);
    options.signal?.throwIfAborted();
    const startedAt = Date.now();
    const operationBudget = Math.max(1, options.timeoutMs - Math.min(2000, Math.floor(options.timeoutMs / 5)));
    const timeoutController = new AbortController();
    const timeoutSignal = timeoutController.signal;
    const deadlineTimer = setTimeout(() => timeoutController.abort(new DOMException("Antigravity CLI 总期限已用完", "TimeoutError")), operationBudget);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    if (signal.aborted) { clearTimeout(deadlineTimer); signal.throwIfAborted(); }
    const maxMemoryMB = Number(process.env.SANDBOX_AGY_CLI_MAX_MEMORY_MB || 1024);
    const reservationMB = Number(process.env.SANDBOX_AGY_CLI_MEMORY_REQUEST_MB || maxMemoryMB);
    if (!Number.isInteger(maxMemoryMB) || maxMemoryMB < 256 || maxMemoryMB > 4096 || !Number.isInteger(reservationMB)
        || reservationMB < 256 || reservationMB > maxMemoryMB) {
        clearTimeout(deadlineTimer);
        throw new AntigravityCallError("Antigravity CLI 内存参数无效",
            { transport: "cli-agent", submitted: false, outcomeUnknown: false, safeToFallback: false, kind: "not-started" });
    }
    const { acquireResourceLease } = await import("./resource-admission-runtime.js");
    let lease;
    try { lease = await acquireResourceLease({ ownerId: `antigravity-cli-agent:${process.pid}`, reservationMB,
        admissionBudgetMs: Math.min(10_000, options.timeoutMs), signal }); }
    catch (error) {
        clearTimeout(deadlineTimer);
        throw antigravityOutcomeFromError(error, { transport: "cli-agent", submitted: false, outcomeUnknown: false,
            safeToFallback: false, kind: signal.aborted ? "cancelled" : "not-started" });
    }
    const scriptPath = `${logBase}.ps1`;
    const stdoutPath = `${logBase}.stdout.txt`;
    const stderrPath = `${logBase}.stderr.txt`;
    let childStarted = false;
    let launch: ReturnType<typeof createWindowsJobLaunch> = null;
    try {
        signal.throwIfAborted();
        const systemRoot = process.env.SystemRoot || process.env.WINDIR;
        const command = systemRoot ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
        const preamble = "$ErrorActionPreference='Continue'\n$utf8=[System.Text.UTF8Encoding]::new($false)\n[Console]::InputEncoding=$utf8\n[Console]::OutputEncoding=$utf8\nchcp.com 65001 | Out-Null\n";
        fs.writeFileSync(scriptPath, `\uFEFF${preamble}${script}`, "utf8");
        launch = createWindowsJobLaunch(command, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], cwd, maxMemoryMB);
        const result = await new Promise<PowerShellSpawnResult>((resolve, reject) => {
            const stdout = fs.openSync(stdoutPath, "w");
            const stderr = fs.openSync(stderrPath, "w");
            const child = spawn(launch?.command || command, launch?.args || ["-NoProfile", "-NonInteractive", "-File", scriptPath], {
                cwd: launch?.spawnCwd || cwd, windowsHide: true, env: options.env, stdio: ["ignore", stdout, stderr],
            });
            child.once("spawn", () => { childStarted = true; lease.markStarted(); });
            let settled = false;
            let earlyFailureReason: string | undefined;
            let killTimer: NodeJS.Timeout | undefined;
            const terminate = () => {
                try {
                    if (launch) fs.writeFileSync(launch.controlFilePath, "cancel", "utf8");
                    else child.kill();
                } catch { child.kill(); }
                killTimer ??= setTimeout(() => child.kill(), Math.max(1, Math.min(1500, options.timeoutMs - (Date.now() - startedAt))));
                killTimer.unref();
            };
            const poll = setInterval(() => {
                const metadata = launch ? readWindowsJobMetadata(launch.metadataPath) : null;
                if (metadata) lease.updateObservedMemoryMB(metadata.peakMemoryBytes / 1024 / 1024);
                const reason = options.earlyFailure?.(clipFile(stderrPath));
                if (reason && !earlyFailureReason) { earlyFailureReason = reason; terminate(); }
                if ([stdoutPath, stderrPath].reduce((total, filePath) => total + (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0), 0) > 8 * 1024 * 1024 && !earlyFailureReason) {
                    earlyFailureReason = "Antigravity CLI 输出超过大小限制";
                    terminate();
                }
            }, 250);
            poll.unref();
            const timer = setTimeout(terminate, Math.max(1, operationBudget - (Date.now() - startedAt)));
            signal.addEventListener("abort", terminate, { once: true });
            if (signal.aborted) terminate();
            const finish = (error?: Error, exitCode: number | null = null) => {
                if (settled) return;
                settled = true;
                clearInterval(poll);
                clearTimeout(timer);
                if (killTimer) clearTimeout(killTimer);
                signal.removeEventListener("abort", terminate);
                fs.closeSync(stdout);
                fs.closeSync(stderr);
                const metadata = launch ? readWindowsJobMetadata(launch.metadataPath) : null;
                if (metadata) lease.updateObservedMemoryMB(metadata.peakMemoryBytes / 1024 / 1024);
                const submitted = metadata?.commandStarted ?? childStarted;
                if (launch && childStarted && metadata?.terminalConfirmed !== true) {
                    reject(new AntigravityCallError("Antigravity CLI 进程树收尾尚未确认，保留原运行材料和资源租约",
                        { transport: "cli-agent", submitted, outcomeUnknown: submitted, safeToFallback: false, kind: "transport-unknown" }));
                    return;
                }
                lease.release();
                removeWindowsJobMetadata(launch?.metadataPath ?? null);
                if (error) reject(antigravityOutcomeFromError(error, { transport: "cli-agent", submitted, outcomeUnknown: submitted,
                    safeToFallback: !submitted, kind: submitted ? "transport-unknown" : "not-started" }));
                else resolve({ exitCode, stdoutPath, stderrPath, diagnostics: options.diagnostics || [], earlyFailureReason,
                    aborted: signal.aborted, timedOut: timeoutSignal.aborted || signal.reason?.name === "TimeoutError" });
            };
            child.once("error", error => finish(error));
            child.once("close", exitCode => finish(undefined, exitCode));
        });
        return result;
    } catch (error) {
        if (!childStarted) { lease.release(); removeWindowsJobMetadata(launch?.metadataPath ?? null); }
        throw antigravityOutcomeFromError(error, { transport: "cli-agent", submitted: childStarted, outcomeUnknown: childStarted,
            safeToFallback: !childStarted && !signal.aborted, kind: childStarted ? "transport-unknown" : signal.aborted ? "cancelled" : "not-started" });
    } finally { clearTimeout(deadlineTimer); }
}
