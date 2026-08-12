import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export interface WindowsJobMetadata {
    peakMemoryBytes: number;
    memoryLimitHit: boolean;
    childExitCode: number | null;
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
}

export function getWindowsJobRunnerPath(): string {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "native", "windows-job-runner.exe");
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
    if (!hasWindowsJobRunner()) return null;
    const metadataPath = path.join(tmpdir(), `sandbox-job-${process.pid}-${randomUUID()}.json`);
    return {
        command: getWindowsJobRunnerPath(),
        args: [
            "--memory-mb", String(Math.ceil(maxMemoryMB)),
            "--metadata", metadataPath,
            "--cwd", cwd,
            "--", command,
            ...args,
        ],
        metadataPath,
    };
}

export function readWindowsJobMetadata(metadataPath: string): WindowsJobMetadata | null {
    try {
        const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as Partial<WindowsJobMetadata>;
        if (!Number.isFinite(parsed.peakMemoryBytes) || typeof parsed.memoryLimitHit !== "boolean") return null;
        return {
            peakMemoryBytes: Math.max(0, Number(parsed.peakMemoryBytes)),
            memoryLimitHit: parsed.memoryLimitHit,
            childExitCode: Number.isFinite(parsed.childExitCode) ? Number(parsed.childExitCode) : null,
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
