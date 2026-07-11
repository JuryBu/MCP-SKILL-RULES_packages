import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { councilRuntimeDirectory } from "./paths.js";

export interface AntigravityCliEnvironment {
    env: NodeJS.ProcessEnv;
    diagnostics: string[];
}

export interface AntigravityCliEnvironmentRuntime {
    platform?: NodeJS.Platform;
    windowsProxySettings?: { enabled: boolean; server?: string; override?: string; pacConfigured: boolean };
}

export interface PowerShellSpawnResult {
    exitCode: number | null;
    timedOut: boolean;
    aborted: boolean;
    stdoutPath: string;
    stderrPath: string;
    earlyFailureReason?: string;
    diagnostics: string[];
}

interface LeaseMetadata {
    pid: number;
    processStartId?: string;
    startedAt: string;
    heartbeatAt: string;
    token: string;
}

export interface AntigravityCliLease {
    slot: number;
    release(): void;
}

const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;
const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1"];
const reportedRuntimeDiagnostics = new Set<string>();

function reportRuntimeDiagnostic(diagnostic: string): void {
    if (reportedRuntimeDiagnostics.has(diagnostic)) return;
    reportedRuntimeDiagnostics.add(diagnostic);
    console.warn(`[sandbox] ${diagnostic}`);
}

function getPowerShellCommand(): string {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    if (systemRoot) {
        const candidate = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        if (fs.existsSync(candidate)) return candidate;
    }
    return "powershell.exe";
}

function redactSensitiveText(text: string): string {
    const home = os.homedir().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return text
        .replace(new RegExp(home, "giu"), "<user-home>")
        .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gu, "<user-dir>")
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, "$1<redacted>@")
        .replace(/(authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password)\s*[:=]\s*([^\s,;]+)/giu, "$1=<redacted>");
}

function redactRunLogs(stdoutPath: string, stderrPath: string): void {
    for (const logPath of [stdoutPath, stderrPath]) {
        try {
            fs.writeFileSync(logPath, redactSensitiveText(fs.readFileSync(logPath, "utf-8")), "utf-8");
        } catch {}
    }
}

function readClip(filePath: string, maxChars: number): string {
    try {
        if (!fs.existsSync(filePath)) return "";
        const stat = fs.statSync(filePath);
        const byteBudget = Math.min(stat.size, Math.max(maxChars * 4, 4096));
        const fd = fs.openSync(filePath, "r");
        try {
            const buffer = Buffer.alloc(byteBudget);
            const bytesRead = fs.readSync(fd, buffer, 0, byteBudget, 0);
            const text = buffer.subarray(0, bytesRead).toString("utf-8");
            return text.length <= maxChars ? text : text.slice(0, maxChars);
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return "";
    }
}

function removeProxyEnvironment(env: NodeJS.ProcessEnv): void {
    for (const key of PROXY_KEYS) delete env[key];
}

function readWindowsProxySettings(platform: NodeJS.Platform): { enabled: boolean; server?: string; override?: string; pacConfigured: boolean } {
    if (platform !== "win32") return { enabled: false, pacConfigured: false };
    const base = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const readValue = (name: string): string | undefined => {
        try {
            const result = spawnSync("reg.exe", ["query", base, "/v", name], { encoding: "utf-8", windowsHide: true, timeout: 3000 });
            if (result.status !== 0) return undefined;
            const line = String(result.stdout || "").split(/\r?\n/u).find((value) => new RegExp(`\\s${name}\\s`, "iu").test(value));
            if (!line) return undefined;
            const match = line.match(/REG_\w+\s+(.+)$/iu);
            return match?.[1]?.trim();
        } catch {
            return undefined;
        }
    };
    const enabled = readValue("ProxyEnable") === "0x1" || readValue("ProxyEnable") === "1";
    return { enabled, server: readValue("ProxyServer"), override: readValue("ProxyOverride"), pacConfigured: Boolean(readValue("AutoConfigURL")) };
}

export function parseWindowsProxyServer(value: string | undefined): { http?: string; https?: string; all?: string } {
    if (!value?.trim()) return {};
    const parts = value.split(";").map((part) => part.trim()).filter(Boolean);
    if (parts.length === 1 && !parts[0].includes("=")) return { all: parts[0] };
    const result: { http?: string; https?: string; all?: string } = {};
    for (const part of parts) {
        const [rawProtocol, ...rawAddress] = part.split("=");
        const protocol = rawProtocol?.trim().toLowerCase();
        const address = rawAddress.join("=").trim();
        if (!address) continue;
        if (protocol === "http") result.http = address;
        else if (protocol === "https") result.https = address;
        else if (protocol === "socks" || protocol === "ftp") result.all ||= address;
    }
    return result;
}

function firstEnvironmentValue(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
    for (const name of names) {
        const value = env[name]?.trim();
        if (value) return value;
    }
    return undefined;
}

function mergeNoProxy(values: Array<string | undefined>, diagnostics: string[]): string | undefined {
    const entries = new Set<string>();
    for (const value of values) {
        for (const entry of value?.split(/[,;]/u) || []) {
            const normalized = entry.trim();
            if (!normalized) continue;
            if (normalized.toLowerCase() === "<local>") {
                LOOPBACK_NO_PROXY.forEach((item) => entries.add(item));
                diagnostics.push("系统 ProxyOverride 的 <local> 已映射为 loopback；其它本地域名语义无法等价表达。");
            } else {
                entries.add(normalized);
            }
        }
    }
    return entries.size > 0 ? [...entries].join(",") : undefined;
}

export function buildAntigravityCliEnvironment(
    baseEnv: NodeJS.ProcessEnv = process.env,
    runtime: AntigravityCliEnvironmentRuntime = {},
): AntigravityCliEnvironment {
    const env = { ...baseEnv };
    const diagnostics: string[] = [];
    const rawMode = (baseEnv.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_PROXY_MODE || "auto").trim().toLowerCase();
    const mode = ["off", "inherit", "system", "auto"].includes(rawMode) ? rawMode : "auto";
    if (mode !== rawMode) diagnostics.push("未知 Antigravity CLI 代理模式，已按 auto 处理。");
    if (mode === "off") {
        removeProxyEnvironment(env);
        diagnostics.push("Antigravity CLI 代理模式：off（已移除子进程代理变量）。");
        return { env, diagnostics };
    }
    if (mode === "inherit") {
        diagnostics.push("Antigravity CLI 代理模式：inherit（仅继承宿主代理环境）。");
        return { env, diagnostics };
    }

    const system = runtime.windowsProxySettings || readWindowsProxySettings(runtime.platform || process.platform);
    removeProxyEnvironment(env);
    if (system.pacConfigured) diagnostics.push("检测到系统 PAC 配置，未将 PAC URL 转换为 HTTP_PROXY。");
    const systemProxy = !system.pacConfigured && system.enabled ? parseWindowsProxyServer(system.server) : {};
    const dedicatedHttp = baseEnv.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_HTTP_PROXY?.trim();
    const dedicatedHttps = baseEnv.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_HTTPS_PROXY?.trim();
    const inheritedHttp = firstEnvironmentValue(baseEnv, ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]);
    const inheritedHttps = firstEnvironmentValue(baseEnv, ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]);
    const http = mode === "system" ? (systemProxy.http || systemProxy.all) : (dedicatedHttp || inheritedHttp || systemProxy.http || systemProxy.all);
    const https = mode === "system" ? (systemProxy.https || systemProxy.all) : (dedicatedHttps || inheritedHttps || systemProxy.https || systemProxy.all);
    if (http) {
        env.HTTP_PROXY = http;
        env.http_proxy = http;
    }
    if (https) {
        env.HTTPS_PROXY = https;
        env.https_proxy = https;
    }
    const noProxy = mergeNoProxy([
        mode === "system" ? undefined : baseEnv.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_NO_PROXY,
        mode === "system" ? undefined : firstEnvironmentValue(baseEnv, ["NO_PROXY", "no_proxy"]),
        system.override,
    ], diagnostics);
    if (noProxy) {
        env.NO_PROXY = noProxy;
        env.no_proxy = noProxy;
    }
    diagnostics.push(`Antigravity CLI 代理模式：${mode}（HTTP=${http ? "已配置" : "直连"}，HTTPS=${https ? "已配置" : "直连"}，NO_PROXY=${noProxy ? "已配置" : "未配置"}）。`);
    return { env, diagnostics };
}

export function killProcessTree(pid?: number): void {
    if (!pid) return;
    try {
        spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
    } catch {}
}

export async function spawnPowerShellScript(
    script: string,
    cwd: string,
    logBasePath: string,
    options: { timeoutMs: number; signal?: AbortSignal; earlyFailure?: (stderr: string) => string | undefined; env?: NodeJS.ProcessEnv; diagnostics?: string[] },
): Promise<PowerShellSpawnResult> {
    const scriptPath = `${logBasePath}.ps1`;
    const stdoutPath = `${logBasePath}.stdout.txt`;
    const stderrPath = `${logBasePath}.stderr.txt`;
    const utf8Preamble = [
        "$ErrorActionPreference = 'Continue'",
        "$utf8 = [System.Text.UTF8Encoding]::new($false)",
        "[Console]::InputEncoding = $utf8",
        "[Console]::OutputEncoding = $utf8",
        "chcp.com 65001 | Out-Null",
    ].join("\n");
    fs.writeFileSync(scriptPath, `\uFEFF${utf8Preamble}\n${script}`, "utf-8");
    fs.writeFileSync(stdoutPath, "", "utf-8");
    fs.writeFileSync(stderrPath, "", "utf-8");
    if (options.signal?.aborted) throw Object.assign(new Error("CLI 调用已中止"), { name: "AbortError" });
    return await new Promise<PowerShellSpawnResult>((resolve, reject) => {
        const stdoutFd = fs.openSync(stdoutPath, "a");
        const stderrFd = fs.openSync(stderrPath, "a");
        let settled = false;
        let timedOut = false;
        let aborted = false;
        let earlyFailureReason: string | undefined;
        const child = spawn(getPowerShellCommand(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
            cwd,
            env: options.env,
            windowsHide: true,
            stdio: ["ignore", stdoutFd, stderrFd],
        });
        const terminate = () => {
            killProcessTree(child.pid);
            child.kill();
        };
        const timer = setTimeout(() => {
            timedOut = true;
            terminate();
        }, options.timeoutMs);
        const onAbort = () => {
            aborted = true;
            terminate();
        };
        const earlyFailureTimer = options.earlyFailure ? setInterval(() => {
            const reason = options.earlyFailure?.(readClip(stderrPath, 4096));
            if (!reason) return;
            earlyFailureReason = reason;
            terminate();
        }, 300) : undefined;
        earlyFailureTimer?.unref();
        const closeFiles = () => {
            try { fs.closeSync(stdoutFd); } catch {}
            try { fs.closeSync(stderrFd); } catch {}
        };
        const clearResources = () => {
            clearTimeout(timer);
            if (earlyFailureTimer) clearInterval(earlyFailureTimer);
            options.signal?.removeEventListener("abort", onAbort);
        };
        options.signal?.addEventListener("abort", onAbort, { once: true });
        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearResources();
            closeFiles();
            redactRunLogs(stdoutPath, stderrPath);
            reject(error);
        });
        child.on("close", (exitCode) => {
            if (settled) return;
            settled = true;
            clearResources();
            closeFiles();
            redactRunLogs(stdoutPath, stderrPath);
            resolve({ exitCode, timedOut, aborted, stdoutPath, stderrPath, earlyFailureReason, diagnostics: options.diagnostics || [] });
        });
    });
}

function leaseRoot(): string {
    return councilRuntimeDirectory("council-agy-slots");
}

function configuredLeaseLimit(): number {
    const configured = Number(process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_GLOBAL_CONCURRENCY || 2);
    return Math.max(1, Math.min(Number.isFinite(configured) ? Math.floor(configured) : 2, 2));
}

function staleAfterMs(): number {
    const configured = Number(process.env.SANDBOX_COUNCIL_ANTIGRAVITY_CLI_LEASE_STALE_MS || 60_000);
    return Math.max(1_000, Number.isFinite(configured) ? configured : 60_000);
}

function heartbeatEveryMs(): number {
    return Math.max(250, Math.min(Math.floor(staleAfterMs() / 3), 10_000));
}

function processStartId(pid: number): string | undefined {
    if (process.platform !== "win32") return undefined;
    try {
        const result = spawnSync(getPowerShellCommand(), ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { encoding: "utf-8", windowsHide: true, timeout: 3000 });
        return result.status === 0 ? String(result.stdout || "").trim() || undefined : undefined;
    } catch {
        return undefined;
    }
}

function processExists(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: any) {
        return error?.code === "EPERM";
    }
}

function leasePath(slot: number): string {
    const slotPath = path.join(leaseRoot(), `slot-${slot}`);
    fs.mkdirSync(slotPath, { recursive: true });
    return path.join(slotPath, "lease");
}

function readLease(filePath: string): LeaseMetadata | undefined {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(filePath, "lease.json"), "utf-8"));
        if (typeof parsed?.pid !== "number" || typeof parsed?.token !== "string" || typeof parsed?.heartbeatAt !== "string") return undefined;
        return parsed as LeaseMetadata;
    } catch {
        return undefined;
    }
}

function readLeaseWithRetry(filePath: string): LeaseMetadata | undefined {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const metadata = readLease(filePath);
        if (metadata) return metadata;
        if (!fs.existsSync(filePath)) return undefined;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    return undefined;
}

function writeLease(filePath: string, metadata: LeaseMetadata): void {
    const target = path.join(filePath, "lease.json");
    const pending = `${target}.${metadata.token}.tmp`;
    fs.writeFileSync(pending, JSON.stringify(metadata), "utf-8");
    fs.renameSync(pending, target);
}

function isStaleLease(metadata: LeaseMetadata, now: number, diagnostics: string[]): boolean {
    const heartbeat = Date.parse(metadata.heartbeatAt);
    if (!Number.isFinite(heartbeat) || now - heartbeat <= staleAfterMs()) return false;
    if (!processExists(metadata.pid)) return true;
    const observedStartId = processStartId(metadata.pid);
    if (metadata.processStartId && observedStartId && metadata.processStartId !== observedStartId) return true;
    const diagnostic = `保守保留过期 agy 租约：PID ${metadata.pid} 仍存活且启动身份无法确认。`;
    diagnostics.push(diagnostic);
    reportRuntimeDiagnostic(diagnostic);
    return false;
}

function tryReclaimLease(currentPath: string, metadata: LeaseMetadata, diagnostics: string[]): boolean {
    if (!isStaleLease(metadata, Date.now(), diagnostics)) return false;
    const claimedPath = `${currentPath}.reclaim-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
        fs.renameSync(currentPath, claimedPath);
        fs.rmSync(claimedPath, { recursive: true, force: true });
        const diagnostic = "已回收确认失效的 agy 全局租约。";
        diagnostics.push(diagnostic);
        reportRuntimeDiagnostic(diagnostic);
        return true;
    } catch {
        return false;
    }
}

function abortError(): Error {
    return Object.assign(new Error("等待 Antigravity CLI 全局租约时已中止"), { name: "AbortError" });
}

export async function acquireAntigravityCliLease(signal?: AbortSignal): Promise<AntigravityCliLease> {
    const limit = configuredLeaseLimit();
    const diagnostics: string[] = [];
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    const metadata: LeaseMetadata = { pid: process.pid, processStartId: processStartId(process.pid), startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), token };
    while (true) {
        if (signal?.aborted) throw abortError();
        for (let slot = 1; slot <= limit; slot += 1) {
            const currentPath = leasePath(slot);
            try {
                fs.mkdirSync(currentPath);
                writeLease(currentPath, metadata);
                const heartbeat = setInterval(() => {
                    try {
                        const current = readLease(currentPath);
                        if (!current || current.token !== token) return;
                        current.heartbeatAt = new Date().toISOString();
                        writeLease(currentPath, current);
                    } catch {}
                }, heartbeatEveryMs());
                heartbeat.unref();
                let released = false;
                return {
                    slot,
                    release: () => {
                        if (released) return;
                        released = true;
                        clearInterval(heartbeat);
                        try {
                            if (readLeaseWithRetry(currentPath)?.token === token) {
                                fs.unlinkSync(path.join(currentPath, "lease.json"));
                                fs.rmdirSync(currentPath);
                            }
                        } catch {}
                    },
                };
            } catch (error: any) {
                if (error?.code !== "EEXIST") continue;
                const existing = readLease(currentPath);
                if (existing) tryReclaimLease(currentPath, existing, diagnostics);
            }
        }
        await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
                clearTimeout(timer);
                reject(abortError());
            };
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, 75);
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }
}

export async function withAntigravityCliLease<T>(signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    const lease = await acquireAntigravityCliLease(signal);
    try {
        if (signal?.aborted) throw abortError();
        return await action();
    } finally {
        lease.release();
    }
}
