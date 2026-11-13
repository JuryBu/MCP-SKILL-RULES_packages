import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AntigravityTransport } from "./antigravity-model-catalog.js";

export interface AntigravityProcessIdentity {
    pid: number;
    name: string;
    executablePath: string;
    commandLine: string;
    startedAt: string;
    ports: number[];
    parentPid?: number;
}

export interface AntigravityLsProcess {
    pid: number;
    csrfToken: string;
    workspaceId: string;
    ports: number[];
    transport?: AntigravityTransport;
    startedAt?: string;
    executablePath?: string;
    hubPath?: string;
}

export interface AntigravityDiscoveryRuntime {
    processes(signal?: AbortSignal, pid?: number): Promise<AntigravityProcessIdentity[]>;
    hubDirectory: string;
}

function validPort(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535;
}

function commandArgument(commandLine: string, name: string): string | undefined {
    const match = commandLine.match(new RegExp(`--${name}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s]+))`, "u"));
    return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function isAntigravityLsIdentity(processInfo: AntigravityProcessIdentity): boolean {
    if (!/^language_server(?:_windows_x64)?(?:\.exe)?$/iu.test(processInfo.name)) return false;
    if (!processInfo.startedAt || !processInfo.executablePath || !processInfo.commandLine) return false;
    const antigravityPath = /(?:^|[\\/])(?:google\.)?antigravity(?:[\\/._ -]|$)/iu;
    return antigravityPath.test(processInfo.executablePath) || antigravityPath.test(processInfo.commandLine)
        || /--(?:app_name|application_name)(?:=|\s+)["']?antigravity(?:["'\s]|$)/iu.test(processInfo.commandLine);
}

export function validateAntigravityHub(value: unknown, processInfo: AntigravityProcessIdentity, hubPath?: string): AntigravityLsProcess | null {
    if (!value || typeof value !== "object" || !isAntigravityLsIdentity(processInfo)) return null;
    const hub = value as Record<string, unknown>;
    if (hub.pid !== processInfo.pid || !validPort(hub.httpPort) || !processInfo.ports.includes(hub.httpPort)
        || typeof hub.csrfToken !== "string" || !hub.csrfToken.trim()) return null;
    const commandToken = commandArgument(processInfo.commandLine, "csrf_token");
    if (commandToken && commandToken !== hub.csrfToken) return null;
    return { pid: processInfo.pid, csrfToken: hub.csrfToken, workspaceId: commandArgument(processInfo.commandLine, "workspace_id") || "",
        ports: [hub.httpPort], transport: "app-ls", startedAt: processInfo.startedAt,
        executablePath: processInfo.executablePath, hubPath };
}

export function legacyAntigravityCandidate(processInfo: AntigravityProcessIdentity): AntigravityLsProcess | null {
    if (!isAntigravityLsIdentity(processInfo)) return null;
    const csrfToken = commandArgument(processInfo.commandLine, "csrf_token");
    const ports = [...new Set(processInfo.ports.filter(validPort))].sort((left, right) => left - right);
    if (!csrfToken || !ports.length) return null;
    return { pid: processInfo.pid, csrfToken, workspaceId: commandArgument(processInfo.commandLine, "workspace_id") || "",
        ports, transport: /^language_server_windows_x64/iu.test(processInfo.name) ? "legacy-ls" : "app-ls",
        startedAt: processInfo.startedAt, executablePath: processInfo.executablePath };
}

export async function readAntigravityWindowsProcesses(signal?: AbortSignal, pid?: number): Promise<AntigravityProcessIdentity[]> {
    signal?.throwIfAborted();
    if (process.platform !== "win32") return [];
    const filter = pid === undefined ? "Name LIKE 'language_server%'" : `ProcessId=${Math.trunc(pid)}`;
    const script = [
        "$ProgressPreference='SilentlyContinue'",
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
        `$items=@(Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction SilentlyContinue | ForEach-Object {`,
        "  $processInfo=$_",
        "  $ports=@(Get-NetTCPConnection -OwningProcess $processInfo.ProcessId -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort)",
        "  [pscustomobject]@{pid=[int]$processInfo.ProcessId;parentPid=[int]$processInfo.ParentProcessId;name=$processInfo.Name;executablePath=$processInfo.ExecutablePath;commandLine=$processInfo.CommandLine;startedAt=$processInfo.CreationDate.ToUniversalTime().ToString('o');ports=$ports}",
        "})",
        "ConvertTo-Json -InputObject $items -Depth 4 -Compress",
    ].join("\n");
    const stdout = await new Promise<string>((resolve, reject) => {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
            { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024, signal },
            (error, output) => error ? reject(error) : resolve(output));
    });
    const parsed: unknown = JSON.parse(stdout.replace(/^\uFEFF/u, "").trim() || "[]");
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries.filter((entry): entry is AntigravityProcessIdentity => entry && Number.isInteger(entry.pid)
        && typeof entry.name === "string" && typeof entry.commandLine === "string" && typeof entry.executablePath === "string"
        && typeof entry.startedAt === "string" && Array.isArray(entry.ports));
}

export function antigravityDiscoveryRuntime(): AntigravityDiscoveryRuntime {
    return { processes: readAntigravityWindowsProcesses,
        hubDirectory: process.env.SANDBOX_AGY_HUB_DIR || path.join(os.homedir(), ".gemini", "antigravity", "daemon") };
}

export async function discoverAntigravityLsCandidates(signal?: AbortSignal, runtime = antigravityDiscoveryRuntime()): Promise<AntigravityLsProcess[]> {
    const processInfos = await runtime.processes(signal);
    signal?.throwIfAborted();
    const live = new Map(processInfos.map(entry => [entry.pid, entry]));
    const candidates: AntigravityLsProcess[] = [];
    let names: string[] = [];
    try { names = (await fs.readdir(runtime.hubDirectory)).filter(name => /^hub_\d+\.json$/u.test(name)).slice(0, 1024).sort(); } catch {}
    for (const name of names) {
        signal?.throwIfAborted();
        try {
            const hubPath = path.join(runtime.hubDirectory, name);
            const metadata = await fs.stat(hubPath);
            if (!metadata.isFile() || metadata.size > 64 * 1024) continue;
            const hub = JSON.parse(await fs.readFile(hubPath, "utf8"));
            const processInfo = live.get(hub.pid);
            if (!processInfo) continue;
            const candidate = validateAntigravityHub(hub, processInfo, hubPath);
            if (candidate && !candidates.some(entry => entry.pid === candidate.pid)) candidates.push(candidate);
        } catch {}
    }
    const ordered = [...processInfos].sort((left, right) => Number(right.pid === process.ppid) - Number(left.pid === process.ppid));
    for (const processInfo of ordered) {
        if (candidates.some(entry => entry.pid === processInfo.pid)) continue;
        const candidate = legacyAntigravityCandidate(processInfo);
        if (candidate) candidates.push(candidate);
    }
    return candidates;
}

export async function verifyAntigravityLsProcess(info: AntigravityLsProcess, port: number, signal?: AbortSignal): Promise<boolean> {
    const processInfo = (await readAntigravityWindowsProcesses(signal, info.pid))[0];
    if (!processInfo || !isAntigravityLsIdentity(processInfo) || !processInfo.ports.includes(port)) return false;
    if (info.startedAt && info.startedAt !== processInfo.startedAt) return false;
    if (info.executablePath && info.executablePath !== processInfo.executablePath) return false;
    if (info.hubPath) {
        try {
            const hub = JSON.parse(await fs.readFile(info.hubPath, "utf8"));
            const candidate = validateAntigravityHub(hub, processInfo, info.hubPath);
            return candidate?.csrfToken === info.csrfToken && candidate.ports.includes(port);
        } catch { return false; }
    }
    return commandArgument(processInfo.commandLine, "csrf_token") === info.csrfToken;
}
