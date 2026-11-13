import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { acquireAntigravityCliLease, buildAntigravityCliEnvironment } from "./council/agy-runtime.js";
import { createWindowsJobLaunch, readWindowsJobMetadata, removeWindowsJobMetadata } from "./windows-job-runner.js";
import { readAntigravityWindowsProcesses, type AntigravityLsProcess } from "./antigravity-discovery.js";
import { AntigravityCallError, antigravityOutcomeFromError } from "./antigravity-model-catalog.js";
import type { ManagedResourceLease } from "./resource-admission-runtime.js";

export interface OwnedAntigravityLs {
    info: AntigravityLsProcess;
    port: number;
    close(): Promise<void>;
}

function remaining(deadline: number): number {
    const value = deadline - Date.now();
    if (value <= 0) throw new AntigravityCallError("Antigravity CLI LS 启动期限已用完",
        { transport: "cli-ls", submitted: false, outcomeUnknown: false, safeToFallback: true, kind: "not-started" });
    return value;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal?.reason || new Error("cancelled")); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function configuredMemory(name: string, fallback: number): number {
    const value = Number(process.env[name] || fallback);
    if (!Number.isInteger(value) || value < 256 || value > 4096) throw new Error(`${name} must be an integer from 256 to 4096 MB`);
    return value;
}

export function resolveAntigravityLsCliCommand(preferredCommand?: string): string {
    const configured = preferredCommand?.trim() || process.env.SANDBOX_AGY_CLI_COMMAND?.trim() || process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_COMMAND?.trim();
    if (configured) return configured;
    const installed = path.join(os.homedir(), "AppData", "Local", "agy", "bin", "agy.exe");
    return process.platform === "win32" && fs.existsSync(installed) ? installed : process.platform === "win32" ? "agy.exe" : "agy";
}

export async function openOwnedAntigravityLs(signal: AbortSignal, deadline: number): Promise<OwnedAntigravityLs> {
    signal.throwIfAborted();
    const cliLease = await acquireAntigravityCliLease(signal);
    let resourceLease: ManagedResourceLease | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let workDirectory: string | undefined;
    let launch: ReturnType<typeof createWindowsJobLaunch>;
    let closePromise: Promise<void> | undefined;
    let childClosed = false;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
    let requestId = 0;
    const close = (): Promise<void> => closePromise ??= (async () => {
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Antigravity CLI LS 已关闭")); }
        pending.clear();
        if (child && !childClosed) {
            child.stdin.end();
            const gracefulMs = Math.max(0, Math.min(1000, deadline - Date.now() - 1000));
            await Promise.race([once(child, "close").catch(() => {}), wait(gracefulMs)]);
            if (!childClosed) {
                if (launch) fs.writeFileSync(launch.controlFilePath, "cancel", "utf8");
                else child.kill();
                await Promise.race([once(child, "close").catch(() => {}), wait(Math.max(0, Math.min(1500, deadline - Date.now())))]);
            }
            if (!childClosed) child.kill();
        }
        const metadata = launch ? readWindowsJobMetadata(launch.metadataPath) : null;
        if (metadata) resourceLease?.updateObservedMemoryMB(metadata.peakMemoryBytes / 1024 / 1024);
        const cleanupConfirmed = !child || (childClosed && (!launch || metadata?.terminalConfirmed === true));
        if (cleanupConfirmed) {
            resourceLease?.release();
            cliLease.release();
            removeWindowsJobMetadata(launch?.metadataPath ?? null);
            if (workDirectory) fs.rmSync(workDirectory, { recursive: true, force: true });
        } else {
            throw new AntigravityCallError("Antigravity 自有 CLI 进程树退出尚未确认，保留原运行材料",
                { transport: "cli-ls", submitted: false, outcomeUnknown: false, safeToFallback: false, kind: "not-started" });
        }
    })();
    try {
        const maxMemoryMB = configuredMemory("SANDBOX_AGY_CLI_MAX_MEMORY_MB", 1024);
        const memoryRequestMB = configuredMemory("SANDBOX_AGY_CLI_MEMORY_REQUEST_MB", maxMemoryMB);
        if (memoryRequestMB > maxMemoryMB) throw new Error("Antigravity CLI memoryRequestMB exceeds maxMemoryMB");
        const { acquireResourceLease } = await import("./resource-admission-runtime.js");
        resourceLease = await acquireResourceLease({ ownerId: `antigravity-cli-ls:${process.pid}`, reservationMB: memoryRequestMB,
            admissionBudgetMs: Math.min(10_000, remaining(deadline)), signal });
        signal.throwIfAborted();
        remaining(deadline);
        workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-agy-ls-"));
        const logPath = path.join(workDirectory, "cli-backend.log");
        const command = resolveAntigravityLsCliCommand();
        const args = ["acp", "--stdio", "--cli_log_file", logPath, "--include-default-customizations=false"];
        launch = createWindowsJobLaunch(command, args, workDirectory, maxMemoryMB);
        const startedAt = Date.now();
        child = spawn(launch?.command || command, launch?.args || args, { cwd: launch?.spawnCwd || workDirectory,
            env: buildAntigravityCliEnvironment().env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        resourceLease.markStarted();
        let stdout = "";
        let receivedBytes = 0;
        let startupError: Error | undefined;
        child.on("error", error => { startupError = error; });
        child.on("close", () => {
            childClosed = true;
            for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(startupError || new Error("Antigravity CLI ACP 提前退出")); }
            pending.clear();
        });
        const consume = (chunk: Buffer, parse: boolean) => {
            receivedBytes += chunk.length;
            if (receivedBytes > 4 * 1024 * 1024) { startupError = new Error("Antigravity CLI ACP 输出超过限制"); child?.kill(); return; }
            if (!parse) return;
            stdout += chunk.toString("utf8");
            let newline: number;
            while ((newline = stdout.indexOf("\n")) >= 0) {
                const line = stdout.slice(0, newline);
                stdout = stdout.slice(newline + 1);
                try {
                    const message = JSON.parse(line);
                    const entry = pending.get(message.id);
                    if (!entry || message.method) continue;
                    pending.delete(message.id);
                    clearTimeout(entry.timer);
                    if (message.error) entry.reject(new Error(`Antigravity ACP ${String(message.error.code || "error")}: ${String(message.error.message || "request failed").slice(0, 240)}`));
                    else entry.resolve(message.result);
                } catch {}
            }
        };
        child.stdout.on("data", chunk => consume(Buffer.from(chunk), true));
        child.stderr.on("data", chunk => consume(Buffer.from(chunk), false));
        child.stdin.on("error", error => { startupError = error; });
        const acpRequest = (method: string, params: Record<string, unknown>, maxMs: number): Promise<any> => {
            signal.throwIfAborted();
            const id = ++requestId;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Antigravity ACP ${method} timeout`)); }, Math.min(maxMs, remaining(deadline)));
                pending.set(id, { resolve, reject, timer });
                child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, error => {
                    if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
                });
            });
        };
        const onAbort = () => {
            for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(signal.reason || new Error("cancelled")); }
            pending.clear();
            child?.stdin.end();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        try {
            await acpRequest("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "sandbox-ls-client", version: "1" } }, 12_000);
            await acpRequest("session/new", { cwd: workDirectory, mcpServers: [] }, 15_000);
            while (remaining(deadline) > 0) {
                signal.throwIfAborted();
                if (startupError) throw startupError;
                if (childClosed) throw new Error("Antigravity CLI 在 LS 就绪前退出");
                if (fs.existsSync(logPath) && fs.statSync(logPath).size > 4 * 1024 * 1024) throw new Error("Antigravity CLI 日志超过限制");
                const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
                const port = Number(log.match(/Language server listening on random port at (\d+) for HTTP\b/u)?.[1]);
                const pid = Number(log.match(/Starting language server process with pid[ :]+(\d+)/u)?.[1]);
                if (port > 0 && port <= 65535 && pid > 0) {
                    const identity = (await readAntigravityWindowsProcesses(signal, pid))[0];
                    const expectedExecutable = path.basename(command).toLowerCase();
                    if (!identity || !identity.ports.includes(port) || (identity.pid !== child.pid && identity.parentPid !== child.pid)
                        || identity.name.toLowerCase() !== expectedExecutable || Date.parse(identity.startedAt) < startedAt - 2000) {
                        throw new Error("Antigravity CLI LS 的 PID、端口或启动身份核对失败");
                    }
                    return { info: { pid, csrfToken: "", workspaceId: "", ports: [port], transport: "cli-ls",
                        startedAt: identity.startedAt, executablePath: identity.executablePath }, port, close };
                }
                await wait(Math.min(100, remaining(deadline)), signal);
            }
            throw new Error("Antigravity CLI LS endpoint unavailable");
        } finally {
            signal.removeEventListener("abort", onAbort);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const auth = /unauthenticated|authentication required|not logged|未登录|认证/iu.test(message);
        const quota = /quota|resource_exhausted|capacity exhausted/iu.test(message);
        let failure = antigravityOutcomeFromError(error, { transport: "cli-ls", kind: signal.aborted ? "cancelled" : auth ? "auth-required" : quota ? "quota-exhausted" : "not-started",
            safeToFallback: !signal.aborted && !auth && !quota });
        try { await close(); } catch (cleanupError) { failure = antigravityOutcomeFromError(cleanupError); }
        throw failure;
    }
}
