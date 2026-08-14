import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export interface WindowsJobMetadata {
    peakMemoryBytes: number;
    memoryLimitHit: boolean;
    childExitCode: number | null;
    commandStarted: boolean;
    startErrorType: string | null;
    startErrorCode: number | null;
}

export interface WindowsSystemMemorySample {
    physicalAvailableMB: number;
    commitAvailableMB: number;
    highMemory: boolean;
    lowMemory: boolean;
}

export interface WindowsJobLaunch {
    command: string;
    args: string[];
    metadataPath: string;
    spawnCwd: string;
}

export type WindowsStartErrorType =
    | "working_directory_missing"
    | "working_directory_invalid"
    | "windows_job_runner_missing"
    | "windows_job_runner_spawn_failed"
    | "payload_start_failed";

export class WindowsJobLaunchError extends Error {
    constructor(public readonly errorType: WindowsStartErrorType, message: string) {
        super(`${errorType}: ${message}`);
        this.name = "WindowsJobLaunchError";
    }
}

export function getWindowsJobRunnerPath(): string {
    return process.env.SANDBOX_WINDOWS_JOB_RUNNER_PATH
        ? path.resolve(process.env.SANDBOX_WINDOWS_JOB_RUNNER_PATH)
        : path.join(path.dirname(fileURLToPath(import.meta.url)), "native", "windows-job-runner.exe");
}

export function hasWindowsJobRunner(): boolean {
    return process.platform === "win32" && existsSync(getWindowsJobRunnerPath());
}

export function createWindowsJobLaunch(
    command: string,
    args: string[],
    cwd: string,
    maxMemoryMB: number,
): WindowsJobLaunch | null {
    if (process.platform !== "win32") return null;
    const runnerPath = getWindowsJobRunnerPath();
    if (!existsSync(runnerPath)) {
        throw new WindowsJobLaunchError("windows_job_runner_missing", `Windows Job Object helper 不存在: ${runnerPath}`);
    }
    let cwdStat;
    try { cwdStat = statSync(cwd); } catch {
        throw new WindowsJobLaunchError("working_directory_missing", `工作目录不存在或不可访问: ${cwd}`);
    }
    if (!cwdStat.isDirectory()) {
        throw new WindowsJobLaunchError("working_directory_invalid", `工作目录不是目录: ${cwd}`);
    }
    const metadataPath = path.join(tmpdir(), `sandbox-job-${process.pid}-${randomUUID()}.json`);
    return {
        command: runnerPath,
        args: [
            "--memory-mb", String(Math.ceil(maxMemoryMB)),
            "--metadata", metadataPath,
            "--cwd", cwd,
            "--", command,
            ...args,
        ],
        metadataPath,
        spawnCwd: path.dirname(runnerPath),
    };
}

export function classifyWindowsRunnerSpawnFailure(cwd: string): WindowsStartErrorType {
    if (!existsSync(getWindowsJobRunnerPath())) return "windows_job_runner_missing";
    try {
        if (!statSync(cwd).isDirectory()) return "working_directory_invalid";
    } catch {
        return "working_directory_missing";
    }
    return "windows_job_runner_spawn_failed";
}

export function readWindowsJobMetadata(metadataPath: string): WindowsJobMetadata | null {
    try {
        const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as Partial<WindowsJobMetadata>;
        if (!Number.isFinite(parsed.peakMemoryBytes) || typeof parsed.memoryLimitHit !== "boolean") return null;
        return {
            peakMemoryBytes: Math.max(0, Number(parsed.peakMemoryBytes)),
            memoryLimitHit: parsed.memoryLimitHit,
            childExitCode: Number.isFinite(parsed.childExitCode) ? Number(parsed.childExitCode) : null,
            commandStarted: typeof parsed.commandStarted === "boolean" ? parsed.commandStarted : true,
            startErrorType: typeof parsed.startErrorType === "string" ? parsed.startErrorType : null,
            startErrorCode: Number.isFinite(parsed.startErrorCode) ? Number(parsed.startErrorCode) : null,
        };
    } catch {
        return null;
    }
}

export function removeWindowsJobMetadata(metadataPath: string | null): void {
    if (!metadataPath) return;
    try {
        rmSync(metadataPath, { force: true });
    } catch {
    }
}

export function startWindowsSystemMemoryMonitor(
    onSample: (sample: WindowsSystemMemorySample) => void,
    onStop?: () => void,
): ChildProcess | null {
    if (!hasWindowsJobRunner()) return null;
    const monitor = spawn(getWindowsJobRunnerPath(), ["--monitor-system", "--interval-ms", "500"], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
    });
    let pending = "";
    let stopped = false;
    const notifyStopped = () => {
        if (stopped) return;
        stopped = true;
        onStop?.();
    };
    monitor.stdout?.setEncoding("utf8");
    monitor.stdout?.on("data", (chunk: string) => {
        pending += chunk;
        while (true) {
            const newline = pending.indexOf("\n");
            if (newline < 0) break;
            const line = pending.slice(0, newline).trim();
            pending = pending.slice(newline + 1);
            if (!line) continue;
            try {
                const sample = JSON.parse(line) as WindowsSystemMemorySample;
                if (Number.isFinite(sample.physicalAvailableMB)
                    && Number.isFinite(sample.commitAvailableMB)
                    && typeof sample.highMemory === "boolean"
                    && typeof sample.lowMemory === "boolean") {
                    onSample(sample);
                }
            } catch {
            }
        }
    });
    monitor.once("error", notifyStopped);
    monitor.once("exit", notifyStopped);
    monitor.unref();
    (monitor.stdout as (NodeJS.ReadableStream & { unref?: () => void }) | null)?.unref?.();
    return monitor;
}
