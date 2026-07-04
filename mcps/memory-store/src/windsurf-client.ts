import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { ConversationRound } from "./trajectory.js";
import type { ConversationAttachment } from "./conversation-attachments.js";
import {
    resolveEndpointForConversation,
    invalidateMapping,
    type RouterEndpoint,
} from "./conversation-router.js";
import { windsurfCascadeExistsLocally } from "./windsurf-local-store.js";

const execFileAsync = promisify(execFile);

const WINDSURF_SERVICE_PREFIX = "exa.language_server_pb.LanguageServerService";
const WINDSURF_CSRF_ENV = "WINDSURF_CSRF_TOKEN";
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_MAX_OVERSIZED_STEP_SKIPS = 50;
const POWERSHELL_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;
const READ_ONLY_METHODS = new Set([
    "Heartbeat",
    "GetAllCascadeTrajectories",
    "GetCascadeTrajectorySteps",
]);

export interface WindsurfLsProcessCandidate {
    pid: number;
    executablePath?: string;
    commandLine?: string;
    extensionServerPort?: number;
}

export interface WindsurfLsEndpoint extends WindsurfLsProcessCandidate {
    port: number;
    csrfToken: string;
}

export interface WindsurfConversationSummary {
    id: string;
    cascadeId: string;
    trajectoryId?: string;
    title: string;
    renamedTitle?: string;
    titleBestEffort?: string;
    titleSource?: "renamedTitle" | "titleBestEffort" | "summary" | "title" | "fallback";
    isChildThread?: boolean;
    parentConversationId?: string | null;
    agentRole?: string | null;
    agentNickname?: string | null;
    summary: string;
    stepCount: number;
    createdTime?: string;
    lastModifiedTime?: string;
    status?: string;
    trajectoryType?: string;
    lastGeneratorModelUid?: string;
    cwd?: string;
    workspaceUris?: string[];
    referencedFiles?: string[];
}

export interface WindsurfConversationReadResult {
    cascadeId: string;
    thread: WindsurfConversationSummary;
    steps: unknown[];
    rounds: ConversationRound[];
    pagesRead: number;
    totalSteps: number;
    partial?: boolean;
    skippedSteps?: WindsurfSkippedStep[];
}

export type WindsurfLsTransport = (method: string, payload?: Record<string, unknown>) => Promise<unknown>;

interface ReadStepsOptions {
    maxPages?: number;
    startOffset?: number;
    maxSkippedOversizedSteps?: number;
}

export interface WindsurfSkippedStep {
    offset: number;
    reason: "oversized";
    byteLimit?: number;
    message: string;
}

interface RunCommandOptions {
    timeoutMs?: number;
}

type RunCommand = (file: string, args: string[], options?: RunCommandOptions) => Promise<{ stdout: string; stderr: string }>;

interface WindsurfSubagentJobsCache {
    path: string;
    mtimeMs: number;
    jobs: Map<string, WindsurfSubagentJobInfo>;
}

let windsurfSubagentJobsCache: WindsurfSubagentJobsCache | null = null;

export interface WindsurfSubagentJobInfo {
    jobId: string;
    subCid: string;
    mainId: string;
    label?: string;
    titleBestEffort?: string;
    state?: string;
    mode?: string;
    model?: string;
    createdAt?: string;
    updatedAt?: string;
    completedAt?: string;
    resultStepCount?: number;
    resultPreview?: string;
    archivePath?: string;
}

function truncate(input: string, maxChars: number): string {
    if (input.length <= maxChars) return input;
    return `${input.slice(0, maxChars)}...`;
}

function toStringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function decodePathLikeUri(value: unknown): string | undefined {
    const raw = toStringValue(value).trim();
    if (!raw) return undefined;
    if (/^file:\/\//iu.test(raw)) {
        try {
            return fileURLToPath(raw);
        } catch {
            try {
                return decodeURIComponent(raw.replace(/^file:\/\/\/?/iu, ""));
            } catch {
                return raw;
            }
        }
    }
    return raw;
}

function pushUniquePath(target: string[], value: unknown): void {
    const decoded = decodePathLikeUri(value);
    if (!decoded) return;
    if (!target.some(item => item.toLowerCase() === decoded.toLowerCase())) {
        target.push(decoded);
    }
}

function extractWorkspaceUrisFromRecord(record: Record<string, any>): string[] {
    const result: string[] = [];
    for (const workspace of asArray(record.workspaces)) {
        const workspaceRecord = asRecord(workspace);
        pushUniquePath(
            result,
            workspaceRecord.workspaceFolderAbsoluteUri
                ?? workspaceRecord.workspaceUri
                ?? workspaceRecord.uri
                ?? workspaceRecord.path
                ?? workspaceRecord.workspace,
        );
    }
    const candidates = [
        record.workspaceUri,
        record.workspace,
        record.cwd,
        record.projectRoot,
        asRecord(record.activeWorkspace).uri,
        asRecord(record.activeWorkspace).path,
        asRecord(record.localNodeState).workspaceUri,
    ];
    for (const candidate of candidates) {
        pushUniquePath(result, candidate);
    }
    return result;
}

function extractWorkspaceFromRecord(record: Record<string, any>): string | undefined {
    return extractWorkspaceUrisFromRecord(record)[0];
}

function extractReferencedFilesFromRecord(record: Record<string, any>): string[] {
    const result: string[] = [];
    for (const item of asArray(record.referencedFiles)) {
        const itemRecord = asRecord(item);
        if (Object.keys(itemRecord).length > 0) {
            pushUniquePath(result, itemRecord.absolutePathUri ?? itemRecord.uri ?? itemRecord.path ?? itemRecord.filePath ?? itemRecord.name);
        } else {
            pushUniquePath(result, item);
        }
    }
    return result;
}

function toNumberValue(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return 0;
}

function asRecord(value: unknown): Record<string, any> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function asArray(value: unknown): any[] {
    return Array.isArray(value) ? value : [];
}

function defaultWindsurfSubagentJobsPath(): string {
    return process.env.MEMORY_STORE_WSF_SUBAGENT_JOBS_PATH
        || path.join(os.homedir(), ".codeium", "windsurf", "mcp-subagent", "subagent-data", "jobs.json");
}

function firstStringField(record: Record<string, any>, fields: string[]): string {
    for (const field of fields) {
        const value = toStringValue(record[field]).trim();
        if (value) return value;
    }
    return "";
}

function jobInfoFromRecord(record: Record<string, any>): WindsurfSubagentJobInfo | null {
    const subCid = firstStringField(record, [
        "sub_cid",
        "subCid",
        "subCascadeId",
        "subConversationId",
        "childConversationId",
        "child_cid",
    ]);
    const mainId = firstStringField(record, [
        "main_id",
        "mainCid",
        "mainCascadeId",
        "mainConversationId",
        "parentConversationId",
        "parent_cid",
        "owner_conversation_id",
    ]);
    if (!subCid || !mainId || subCid === mainId) return null;
    return {
        jobId: firstStringField(record, ["job_id", "jobId", "id"]) || subCid,
        subCid,
        mainId,
        label: firstStringField(record, ["label", "name"]) || undefined,
        titleBestEffort: firstStringField(record, ["title_best_effort", "titleBestEffort", "title"]) || undefined,
        state: firstStringField(record, ["state", "status"]) || undefined,
        mode: firstStringField(record, ["mode"]) || undefined,
        model: firstStringField(record, ["model", "model_id", "modelId"]) || undefined,
        createdAt: firstStringField(record, ["created_at", "createdAt"]) || undefined,
        updatedAt: firstStringField(record, ["updated_at", "updatedAt"]) || undefined,
        completedAt: firstStringField(record, ["completed_at", "completedAt"]) || undefined,
        resultStepCount: toNumberValue(record.result_step_count ?? record.resultStepCount) || undefined,
        resultPreview: firstStringField(record, ["result_preview", "resultPreview"]) || undefined,
        archivePath: firstStringField(record, ["archive_path", "archivePath"]) || undefined,
    };
}

function collectWindsurfSubagentJobs(value: unknown, target: Map<string, WindsurfSubagentJobInfo>, depth = 0): void {
    if (depth > 5 || !value) return;
    if (Array.isArray(value)) {
        for (const item of value) collectWindsurfSubagentJobs(item, target, depth + 1);
        return;
    }
    const record = asRecord(value);
    if (Object.keys(record).length === 0) return;

    const info = jobInfoFromRecord(record);
    if (info) target.set(info.subCid, info);

    const nested = record.jobs ?? record.items ?? record.data ?? record.records;
    if (nested) {
        collectWindsurfSubagentJobs(nested, target, depth + 1);
        return;
    }
    for (const value of Object.values(record)) {
        collectWindsurfSubagentJobs(value, target, depth + 1);
    }
}

export function readWindsurfSubagentJobs(): Map<string, WindsurfSubagentJobInfo> {
    const jobsPath = defaultWindsurfSubagentJobsPath();
    try {
        const stat = fs.statSync(jobsPath);
        if (!stat.isFile()) return new Map();
        if (
            windsurfSubagentJobsCache
            && windsurfSubagentJobsCache.path === jobsPath
            && windsurfSubagentJobsCache.mtimeMs === stat.mtimeMs
        ) {
            return new Map(windsurfSubagentJobsCache.jobs);
        }
        const parsed = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
        const jobs = new Map<string, WindsurfSubagentJobInfo>();
        collectWindsurfSubagentJobs(parsed, jobs);
        windsurfSubagentJobsCache = { path: jobsPath, mtimeMs: stat.mtimeMs, jobs };
        return new Map(jobs);
    } catch {
        return new Map();
    }
}

export function readWindsurfSubagentParentMap(): Map<string, string> {
    return new Map([...readWindsurfSubagentJobs().values()].map(job => [job.subCid, job.mainId]));
}

function isWindsurfSubagentTitle(input: string): boolean {
    return /^\s*\[subagent\]/iu.test(input);
}

function windsurfSubagentRoleFromTitle(input: string): string | null {
    const match = input.match(/^\s*\[subagent\]\s*([^：:\-|]+)?/iu);
    const role = match?.[1]?.trim();
    return role || null;
}

function parseJsonOutput(stdout: string): unknown {
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    return JSON.parse(trimmed);
}

function normalizeJsonArray(value: unknown): any[] {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return [value];
    return [];
}

function parseExtensionServerPort(commandLine?: string): number | undefined {
    const match = commandLine?.match(/--extension_server_port\s+(\d+)/u);
    if (!match) return undefined;
    const port = Number(match[1]);
    return Number.isInteger(port) && port > 0 ? port : undefined;
}

function isWindsurfLsCandidate(candidate: WindsurfLsProcessCandidate): boolean {
    const combined = `${candidate.executablePath || ""}\n${candidate.commandLine || ""}`.toLowerCase();
    const executable = (candidate.executablePath || "").toLowerCase();
    return executable.includes("language_server_windows_x64")
        && executable.includes("windsurf")
        && !executable.includes("powershell.exe")
        && !executable.includes("pwsh.exe")
        && combined.includes("windsurf");
}

async function defaultRunCommand(file: string, args: string[], options: RunCommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync(file, args, {
        timeout: options.timeoutMs ?? POWERSHELL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
    });
    return {
        stdout: result.stdout || "",
        stderr: result.stderr || "",
    };
}

async function runPowerShellJson<T>(script: string, runCommand: RunCommand): Promise<T> {
    const { stdout } = await runCommand("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ], { timeoutMs: POWERSHELL_TIMEOUT_MS });
    return parseJsonOutput(stdout) as T;
}

function redactSensitive(input: string): string {
    return input
        .replace(new RegExp(`${WINDSURF_CSRF_ENV}=([^\\s;]+)`, "giu"), `${WINDSURF_CSRF_ENV}=<redacted>`)
        .replace(/x-codeium-csrf-token["']?\s*[:=]\s*["']?[^"',\s}]+/giu, "x-codeium-csrf-token=<redacted>");
}

export async function findWindsurfLsProcessCandidates(runCommand: RunCommand = defaultRunCommand): Promise<WindsurfLsProcessCandidate[]> {
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        "$items = Get-CimInstance Win32_Process | Where-Object {",
        "  ($_.CommandLine -like '*language_server_windows_x64*' -or $_.ExecutablePath -like '*language_server_windows_x64*') -and",
        "  ($_.CommandLine -like '*windsurf*' -or $_.ExecutablePath -like '*Windsurf*')",
        "} | ForEach-Object {",
        "  $cmd = [string]$_.CommandLine",
        "  $ext = $null",
        "  if ($cmd -match '--extension_server_port\\s+(\\d+)') { $ext = [int]$Matches[1] }",
        "  [pscustomobject]@{ pid = [int]$_.ProcessId; executablePath = [string]$_.ExecutablePath; commandLine = $cmd; extensionServerPort = $ext }",
        "}",
        "$items | ConvertTo-Json -Depth 4",
    ].join("\n");
    const raw = await runPowerShellJson<unknown>(script, runCommand);
    return normalizeJsonArray(raw)
        .map(item => {
            const record = asRecord(item);
            const commandLine = toStringValue(record.commandLine);
            return {
                pid: toNumberValue(record.pid),
                executablePath: toStringValue(record.executablePath) || undefined,
                commandLine: commandLine || undefined,
                extensionServerPort: toNumberValue(record.extensionServerPort) || parseExtensionServerPort(commandLine),
            };
        })
        .filter(candidate => candidate.pid > 0 && isWindsurfLsCandidate(candidate));
}

export async function findWindsurfListenPorts(
    candidate: WindsurfLsProcessCandidate,
    runCommand: RunCommand = defaultRunCommand,
): Promise<number[]> {
    const script = [
        "$ErrorActionPreference = 'Stop'",
        `[int]$pidValue = ${candidate.pid}`,
        "$ports = Get-NetTCPConnection -OwningProcess $pidValue -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort",
        "$ports | ConvertTo-Json",
    ].join("\n");
    const raw = await runPowerShellJson<unknown>(script, runCommand);
    const ports = normalizeJsonArray(raw)
        .map(toNumberValue)
        .filter(port => Number.isInteger(port) && port > 0 && port <= 65_535);
    return ports.filter(port => port !== candidate.extensionServerPort);
}

export async function readWindsurfCsrfToken(pid: number, runCommand: RunCommand = defaultRunCommand): Promise<string | undefined> {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WindsurfProcessEnvironmentReader {
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr Reserved3;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int processAccess, bool bInheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, int dwSize, out IntPtr lpNumberOfBytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr processHandle, int processInformationClass, ref PROCESS_BASIC_INFORMATION processInformation, int processInformationLength, out int returnLength);

    private const int PROCESS_QUERY_INFORMATION = 0x0400;
    private const int PROCESS_VM_READ = 0x0010;

    private static byte[] ReadBytes(IntPtr handle, IntPtr address, int size) {
        byte[] buffer = new byte[size];
        IntPtr bytesRead;
        if (!ReadProcessMemory(handle, address, buffer, size, out bytesRead)) {
            return null;
        }
        int actual = bytesRead.ToInt32();
        if (actual == size) return buffer;
        byte[] trimmed = new byte[Math.Max(0, actual)];
        Array.Copy(buffer, trimmed, trimmed.Length);
        return trimmed;
    }

    private static long ReadPointer(byte[] bytes, int offset) {
        if (IntPtr.Size == 8) return BitConverter.ToInt64(bytes, offset);
        return BitConverter.ToInt32(bytes, offset);
    }

    public static string ReadVariable(int pid, string variableName) {
        IntPtr handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (handle == IntPtr.Zero) return null;
        try {
            PROCESS_BASIC_INFORMATION info = new PROCESS_BASIC_INFORMATION();
            int returnLength;
            int status = NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out returnLength);
            if (status != 0 || info.PebBaseAddress == IntPtr.Zero) return null;

            byte[] peb = ReadBytes(handle, info.PebBaseAddress, 0x80);
            if (peb == null) return null;
            int processParametersOffset = IntPtr.Size == 8 ? 0x20 : 0x10;
            long processParametersAddress = ReadPointer(peb, processParametersOffset);
            if (processParametersAddress == 0) return null;

            byte[] parameters = ReadBytes(handle, new IntPtr(processParametersAddress), IntPtr.Size == 8 ? 0x88 : 0x50);
            if (parameters == null) return null;
            int environmentOffset = IntPtr.Size == 8 ? 0x80 : 0x48;
            long environmentAddress = ReadPointer(parameters, environmentOffset);
            if (environmentAddress == 0) return null;

            byte[] environment = ReadBytes(handle, new IntPtr(environmentAddress), 65536);
            if (environment == null) return null;
            string text = Encoding.Unicode.GetString(environment);
            string prefix = variableName + "=";
            foreach (string entry in text.Split('\0')) {
                if (entry.StartsWith(prefix, StringComparison.Ordinal)) {
                    return entry.Substring(prefix.Length);
                }
            }
            return null;
        } finally {
            CloseHandle(handle);
        }
    }
}
'@
[WindsurfProcessEnvironmentReader]::ReadVariable(${pid}, '${WINDSURF_CSRF_ENV}')
`;
    try {
        const { stdout } = await runCommand("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ], { timeoutMs: POWERSHELL_TIMEOUT_MS });
        const token = stdout.trim();
        return token || undefined;
    } catch (error) {
        const message = error instanceof Error ? redactSensitive(error.message) : "unknown error";
        throw new Error(`Failed to read WSF CSRF token from process ${pid}: ${message}`);
    }
}

/**
 * 发现「全部」活跃 WSF LS 端点（Heartbeat 通），不再只取第一个（核心修复 ④）。
 * discoverWindsurfLsEndpoint 内部改为「全量枚举取 [0]」（语义不变，供 list/可用性探测）。
 */
export async function discoverAllWindsurfLsEndpoints(runCommand: RunCommand = defaultRunCommand): Promise<WindsurfLsEndpoint[]> {
    if (endpointResolverOverride) return endpointResolverOverride();

    const candidates = await findWindsurfLsProcessCandidates(runCommand);
    const endpoints: WindsurfLsEndpoint[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        const csrfToken = await readWindsurfCsrfToken(candidate.pid, runCommand);
        if (!csrfToken) continue;
        const ports = await findWindsurfListenPorts(candidate, runCommand);
        for (const port of ports) {
            const endpoint: WindsurfLsEndpoint = { ...candidate, port, csrfToken };
            const transport = makeTransport(endpoint);
            try {
                await transport("Heartbeat");
            } catch {
                continue;
            }
            const key = `${endpoint.pid}:${endpoint.port}`;
            if (seen.has(key)) continue;
            seen.add(key);
            endpoints.push(endpoint);
            // 同一进程多端口只保留第一个 Heartbeat 通的（与原 discoverWindsurfLsEndpoint 语义一致）
            break;
        }
    }
    return endpoints;
}

/** 端点池短缓存（替换旧的全局单一 cachedEndpoint，见失败路径 ⑤） */
let cachedEndpointPool: { endpoints: WindsurfLsEndpoint[]; cachedAt: number } | null = null;
const ENDPOINT_CACHE_TTL_MS = 30_000;

/** 测试注入：替换端点发现（返回固定端点池，离线 mock 不依赖真实 WSF） */
let endpointResolverOverride: (() => Promise<WindsurfLsEndpoint[]>) | null = null;
/** 测试注入：替换 transport 工厂（按 endpoint 返回桩 transport） */
let transportFactoryOverride: ((endpoint: WindsurfLsEndpoint) => WindsurfLsTransport) | null = null;

/** 内部统一 transport 构造入口（受测试工厂覆盖）。导出供路由大脑构造 WSF endpoint 复用，
 *  使 __setWindsurfTransportFactoryForTest 注入对路由广播同样生效。 */
export function makeWindsurfTransport(endpoint: WindsurfLsEndpoint): WindsurfLsTransport {
    return transportFactoryOverride ? transportFactoryOverride(endpoint) : createWindsurfLsTransport(endpoint);
}

/** 内部别名（保持原有调用点不变） */
function makeTransport(endpoint: WindsurfLsEndpoint): WindsurfLsTransport {
    return makeWindsurfTransport(endpoint);
}

/**
 * 测试专用：注入端点解析器（返回固定端点池）。传 null 还原真实发现。生产代码不调用。
 */
export function __setWindsurfEndpointResolverForTest(fn: (() => Promise<WindsurfLsEndpoint[]>) | null): void {
    endpointResolverOverride = fn;
    cachedEndpointPool = null;
}

/**
 * 测试专用：注入 transport 工厂（按 endpoint 返回桩 transport）。传 null 还原真实工厂。
 */
export function __setWindsurfTransportFactoryForTest(fn: ((endpoint: WindsurfLsEndpoint) => WindsurfLsTransport) | null): void {
    transportFactoryOverride = fn;
}

/**
 * 测试专用：重置端点池短缓存（避免跨用例污染）。
 */
export function __resetWindsurfEndpointCacheForTest(): void {
    cachedEndpointPool = null;
}

/** 获取端点池（带短缓存） */
async function getWindsurfEndpointPool(): Promise<WindsurfLsEndpoint[]> {
    const now = Date.now();
    if (cachedEndpointPool && now - cachedEndpointPool.cachedAt < ENDPOINT_CACHE_TTL_MS) {
        return cachedEndpointPool.endpoints;
    }
    const endpoints = await discoverAllWindsurfLsEndpoints();
    cachedEndpointPool = endpoints.length ? { endpoints, cachedAt: now } : null;
    return endpoints;
}

export async function isWindsurfStoreAvailable(): Promise<boolean> {
    return (await getWindsurfEndpointPool()).length > 0 || readWindsurfSubagentJobs().size > 0;
}


export function createWindsurfLsTransport(endpoint: WindsurfLsEndpoint): WindsurfLsTransport {
    return async (method: string, payload: Record<string, unknown> = {}) => {
        if (!READ_ONLY_METHODS.has(method)) {
            throw new Error(`WSF client is read-only; method ${method} is not allowed`);
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const response = await fetch(`http://127.0.0.1:${endpoint.port}/${WINDSURF_SERVICE_PREFIX}/${method}`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-codeium-csrf-token": endpoint.csrfToken,
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            const text = await response.text();
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${truncate(redactSensitive(text), 500)}`);
            }
            return text.trim() ? JSON.parse(text) : {};
        } catch (error) {
            const message = error instanceof Error ? redactSensitive(error.message) : String(error);
            throw new Error(`WSF LS ${method} failed: ${message}`);
        } finally {
            clearTimeout(timer);
        }
    };
}

export function normalizeWindsurfTrajectoryList(response: unknown): WindsurfConversationSummary[] {
    const root = asRecord(response);
    const summaries = root.trajectorySummaries;
    const subagentJobs = readWindsurfSubagentJobs();
    const entries = Array.isArray(summaries)
        ? summaries.map((info, index) => [asRecord(info).cascadeId || asRecord(info).trajectoryId || String(index), info] as const)
        : Object.entries(asRecord(summaries));

    return entries.map(([cascadeId, info]) => {
        const record = asRecord(info);
        const id = toStringValue(record.cascadeId) || toStringValue(record.id) || cascadeId;
        const rawSummary = toStringValue(record.summary).trim();
        const rawTitle = toStringValue(record.title).trim();
        const renamedTitle = toStringValue(record.renamedTitle).trim();
        const job = subagentJobs.get(id);
        const titleBestEffort = (toStringValue(record.title_best_effort) || toStringValue(record.titleBestEffort) || job?.titleBestEffort || "").trim();
        const summary = rawSummary || rawTitle || "Untitled WSF Cascade";
        const title = renamedTitle || summary;
        const titleSource: WindsurfConversationSummary["titleSource"] = renamedTitle
            ? "renamedTitle"
            : rawSummary
                ? "summary"
                : rawTitle
                    ? "title"
                    : "fallback";
        const workspaceUris = extractWorkspaceUrisFromRecord(record);
        const referencedFiles = extractReferencedFilesFromRecord(record);
        const parentConversationId = job?.mainId || null;
        const subagentMarkerTitle = [titleBestEffort, renamedTitle, rawTitle, rawSummary].find(isWindsurfSubagentTitle) || "";
        const isChildThread = Boolean(parentConversationId) || Boolean(subagentMarkerTitle);
        const subagentRole = job?.label || windsurfSubagentRoleFromTitle(subagentMarkerTitle) || (isChildThread ? "windsurf-subagent" : null);
        return {
            id,
            cascadeId: id,
            trajectoryId: toStringValue(record.trajectoryId) || undefined,
            title,
            renamedTitle: renamedTitle || undefined,
            titleBestEffort: titleBestEffort || undefined,
            titleSource,
            isChildThread,
            parentConversationId,
            agentRole: subagentRole,
            agentNickname: subagentMarkerTitle || undefined,
            summary,
            stepCount: toNumberValue(record.stepCount),
            createdTime: toStringValue(record.createdTime) || undefined,
            lastModifiedTime: toStringValue(record.lastModifiedTime) || undefined,
            status: toStringValue(record.status) || job?.state || undefined,
            trajectoryType: toStringValue(record.trajectoryType) || undefined,
            lastGeneratorModelUid: toStringValue(record.lastGeneratorModelUid) || job?.model || undefined,
            cwd: workspaceUris[0] || extractWorkspaceFromRecord(record),
            workspaceUris: workspaceUris.length ? workspaceUris : undefined,
            referencedFiles: referencedFiles.length ? referencedFiles : undefined,
        };
    }).sort((left, right) => {
        const leftTime = Date.parse(left.lastModifiedTime || left.createdTime || "");
        const rightTime = Date.parse(right.lastModifiedTime || right.createdTime || "");
        return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    });
}

export async function listWindsurfConversations(transport: WindsurfLsTransport): Promise<WindsurfConversationSummary[]> {
    return normalizeWindsurfTrajectoryList(await transport("GetAllCascadeTrajectories"));
}

function windsurfSummaryFromSubagentJob(
    job: WindsurfSubagentJobInfo,
    parent?: WindsurfConversationSummary,
): WindsurfConversationSummary {
    const titleBestEffort = job.titleBestEffort || (job.label ? `[subagent] ${job.label}` : "[subagent] Windsurf subagent");
    const label = job.label || windsurfSubagentRoleFromTitle(titleBestEffort) || "windsurf-subagent";
    return {
        id: job.subCid,
        cascadeId: job.subCid,
        title: titleBestEffort,
        titleBestEffort,
        titleSource: "titleBestEffort",
        isChildThread: true,
        parentConversationId: job.mainId,
        agentRole: label,
        agentNickname: titleBestEffort,
        summary: titleBestEffort,
        stepCount: job.resultStepCount || 0,
        createdTime: job.createdAt,
        lastModifiedTime: job.updatedAt || job.completedAt || job.createdAt,
        status: job.state,
        lastGeneratorModelUid: job.model,
        cwd: parent?.cwd,
        workspaceUris: parent?.workspaceUris,
        referencedFiles: parent?.referencedFiles,
    };
}

/**
 * 判定某 GetAllCascadeTrajectories 响应是否包含指定 cascadeId（供路由大脑 holds 判定）。
 * 复用 normalizeWindsurfTrajectoryList，summaries 数组/对象两形态均判对。
 */
export function windsurfListContainsId(data: unknown, cascadeId: string): boolean {
    if (!cascadeId) return false;
    const summaries = normalizeWindsurfTrajectoryList(data);
    return summaries.some(item => item.id === cascadeId || item.cascadeId === cascadeId);
}

/**
 * 列出近期 WSF 对话：跨「全部」活跃 WSF LS 端点聚合去重（同 cascadeId 取 stepCount 最大），
 * 修「list 只看一个窗口」（失败路径 ④ 连带）。
 */
export async function listRecentWindsurfThreads(limit = 50): Promise<WindsurfConversationSummary[]> {
    const endpoints = await getWindsurfEndpointPool();

    const merged = new Map<string, WindsurfConversationSummary>();
    const lists = endpoints.length
        ? await Promise.all(endpoints.map(async ep => {
            try {
                return await listWindsurfConversations(makeTransport(ep));
            } catch {
                return [] as WindsurfConversationSummary[];
            }
        }))
        : [];

    for (const list of lists) {
        for (const item of list) {
            const existing = merged.get(item.id);
            if (!existing || (item.stepCount || 0) > (existing.stepCount || 0)) {
                merged.set(item.id, item);
            }
        }
    }

    for (const job of readWindsurfSubagentJobs().values()) {
        const parent = merged.get(job.mainId);
        const existing = merged.get(job.subCid);
        const synthesized = windsurfSummaryFromSubagentJob(job, parent);
        if (existing) {
            merged.set(job.subCid, {
                ...existing,
                titleBestEffort: existing.titleBestEffort || synthesized.titleBestEffort,
                isChildThread: true,
                parentConversationId: existing.parentConversationId || job.mainId,
                agentRole: existing.agentRole || synthesized.agentRole,
                agentNickname: existing.agentNickname || synthesized.agentNickname,
                status: existing.status || synthesized.status,
                lastGeneratorModelUid: existing.lastGeneratorModelUid || synthesized.lastGeneratorModelUid,
            });
        } else {
            merged.set(job.subCid, synthesized);
        }
    }

    return Array.from(merged.values())
        .sort((left, right) => {
            const leftTime = Date.parse(left.lastModifiedTime || left.createdTime || "");
            const rightTime = Date.parse(right.lastModifiedTime || right.createdTime || "");
            return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
        })
        .slice(0, Math.max(0, limit));
}

export async function resolveWindsurfThreadId(input: string): Promise<string | null> {
    const query = input.trim().toLowerCase();
    if (!query) return null;
    const threads = await listRecentWindsurfThreads(500);
    const exact = threads.find(item => item.id.toLowerCase() === query || item.cascadeId.toLowerCase() === query);
    if (exact) return exact.id;
    const prefix = threads.filter(item => item.id.toLowerCase().startsWith(query) || item.cascadeId.toLowerCase().startsWith(query));
    return prefix.length === 1 ? prefix[0].id : null;
}

function extractSteps(response: unknown): unknown[] {
    const record = asRecord(response);
    if (Array.isArray(record.steps)) return record.steps;
    if (Array.isArray(record.trajectorySteps)) return record.trajectorySteps;
    if (Array.isArray(record.cascadeTrajectorySteps)) return record.cascadeTrajectorySteps;
    return [];
}

function extractStepsFromNestedPreview(value: unknown, depth = 0): unknown[] {
    if (depth > 5 || value == null) return [];
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return [];
        try {
            return extractStepsFromNestedPreview(JSON.parse(trimmed), depth + 1);
        } catch {
            return [];
        }
    }
    const direct = extractSteps(value);
    if (direct.length > 0) return direct;
    const record = asRecord(value);
    for (const key of ["result_preview", "resultPreview", "result", "payload", "data", "response"]) {
        const nested = record[key];
        const steps = extractStepsFromNestedPreview(nested, depth + 1);
        if (steps.length > 0) return steps;
    }
    return [];
}

function readWindsurfSubagentArchive(job: WindsurfSubagentJobInfo): unknown | null {
    if (!job.archivePath) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(job.archivePath, "utf8"));
        return parsed;
    } catch {
        return null;
    }
}

function windsurfSubagentJobSteps(job: WindsurfSubagentJobInfo): unknown[] {
    const archived = readWindsurfSubagentArchive(job);
    const archiveSteps = extractStepsFromNestedPreview(archived);
    if (archiveSteps.length > 0) return archiveSteps;
    return extractStepsFromNestedPreview(job.resultPreview);
}

function loadWindsurfSubagentJobConversation(cascadeId: string): WindsurfConversationReadResult | null {
    const job = readWindsurfSubagentJobs().get(cascadeId);
    if (!job) return null;
    const steps = windsurfSubagentJobSteps(job);
    const thread = windsurfSummaryFromSubagentJob(job);
    return {
        cascadeId: job.subCid,
        thread,
        steps,
        rounds: windsurfStepsToConversationRounds(steps),
        pagesRead: steps.length > 0 ? 1 : 0,
        totalSteps: Math.max(steps.length, job.resultStepCount || 0),
        skippedSteps: [],
        partial: steps.length === 0 && Boolean(job.resultStepCount),
    };
}

function nextOffsetFromResponse(response: unknown, currentOffset: number, pageLength: number): number {
    const record = asRecord(response);
    const explicit = toNumberValue(record.nextStepOffset ?? record.nextOffset);
    if (explicit > currentOffset) return explicit;
    return currentOffset + pageLength;
}

const OVERSIZED_STEP_TYPE = "MEMORY_STORE_WSF_OVERSIZED_STEP";

function parseOversizedStepError(error: unknown, currentOffset: number): WindsurfSkippedStep | null {
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/step at offset\s+(\d+)\s+larger than\s+(\d+)\s+byte limit/iu);
    if (!match) return null;
    const offset = Number(match[1]);
    const byteLimit = Number(match[2]);
    if (!Number.isInteger(offset) || offset < currentOffset) return null;
    return {
        offset,
        reason: "oversized",
        byteLimit: Number.isFinite(byteLimit) && byteLimit > 0 ? byteLimit : undefined,
        message,
    };
}

function buildOversizedStepPlaceholder(skipped: WindsurfSkippedStep): Record<string, unknown> {
    return {
        type: OVERSIZED_STEP_TYPE,
        memoryStoreWarning: skipped,
    };
}

function isOversizedStepPlaceholder(step: Record<string, any>): boolean {
    return toStringValue(step.type) === OVERSIZED_STEP_TYPE;
}

function createOversizedStepRound(roundIndex: number, step: Record<string, any>, fallbackStepIndex: number): ConversationRound {
    const warning = asRecord(step.memoryStoreWarning);
    const offset = toNumberValue(warning.offset) || fallbackStepIndex;
    const byteLimit = toNumberValue(warning.byteLimit);
    const message = toStringValue(warning.message);
    return {
        roundIndex,
        startStep: offset,
        endStep: offset,
        userMessage: [
            `⚠️ WSF 原始 step ${offset} 超过${byteLimit ? ` ${byteLimit} 字节` : ""}读取限制，memory-store 已跳过该单步并继续读取后续内容。`,
            "这通常是单条 Cascade step 内含超大图片、文件快照或宿主内部状态，当前 read/fetch 只能提供降级占位；需要完整原始内容时，请回到 Windsurf UI 或官方导出查看该位置。",
            message ? `原始错误：${truncate(message, 500)}` : "",
        ].filter(Boolean).join("\n"),
        mediaAttachments: [],
        attachments: [],
        aiResponses: [],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    };
}

export async function readWindsurfCascadeSteps(
    transport: WindsurfLsTransport,
    cascadeId: string,
    options: ReadStepsOptions = {},
): Promise<{ steps: unknown[]; pagesRead: number; skippedSteps: WindsurfSkippedStep[]; partial: boolean }> {
    const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
    const maxSkippedOversizedSteps = Math.max(0, options.maxSkippedOversizedSteps ?? DEFAULT_MAX_OVERSIZED_STEP_SKIPS);
    let offset = Math.max(0, options.startOffset ?? 0);
    const steps: unknown[] = [];
    const skippedSteps: WindsurfSkippedStep[] = [];
    const seenOffsets = new Set<number>();

    for (let page = 0; page < maxPages; page++) {
        if (seenOffsets.has(offset)) break;
        seenOffsets.add(offset);

        let response: unknown;
        try {
            response = await transport("GetCascadeTrajectorySteps", { cascadeId, stepOffset: offset });
        } catch (error) {
            const oversized = parseOversizedStepError(error, offset);
            if (!oversized) throw error;
            if (skippedSteps.length >= maxSkippedOversizedSteps) {
                steps.push(buildOversizedStepPlaceholder({
                    ...oversized,
                    message: `${oversized.message}\nmemory-store 已达到 WSF 超大 step 跳过上限 ${maxSkippedOversizedSteps}，后续内容未继续读取。`,
                }));
                return { steps, pagesRead: seenOffsets.size, skippedSteps: [...skippedSteps, oversized], partial: true };
            }
            skippedSteps.push(oversized);
            steps.push(buildOversizedStepPlaceholder(oversized));
            offset = oversized.offset + 1;
            continue;
        }
        const pageSteps = extractSteps(response);
        if (pageSteps.length === 0) {
            return { steps, pagesRead: seenOffsets.size, skippedSteps, partial: skippedSteps.length > 0 };
        }

        steps.push(...pageSteps);
        offset = nextOffsetFromResponse(response, offset, pageSteps.length);
    }

    return { steps, pagesRead: seenOffsets.size, skippedSteps, partial: skippedSteps.length > 0 };
}

export async function readWindsurfConversation(
    transport: WindsurfLsTransport,
    cascadeId: string,
    options: ReadStepsOptions = {},
): Promise<WindsurfConversationReadResult> {
    const { steps, pagesRead, skippedSteps, partial } = await readWindsurfCascadeSteps(transport, cascadeId, options);
    return {
        cascadeId,
        thread: {
            id: cascadeId,
            cascadeId,
            title: cascadeId,
            summary: cascadeId,
            stepCount: steps.length,
        },
        steps,
        rounds: windsurfStepsToConversationRounds(steps),
        pagesRead,
        totalSteps: steps.length,
        skippedSteps,
        partial,
    };
}

/**
 * 用持有者 endpoint 的 list 给 read 结果补 thread 摘要（标题/stepCount/workspace 等）。
 */
async function enrichThreadSummary(
    result: WindsurfConversationReadResult,
    transport: WindsurfLsTransport,
    resolvedId: string,
): Promise<void> {
    try {
        const summaries = await listWindsurfConversations(transport);
        const summary = summaries.find(item => item.id === resolvedId || item.cascadeId === resolvedId);
        if (summary) {
            result.thread = summary;
            result.totalSteps = Math.max(result.totalSteps, summary.stepCount || 0);
        } else {
            const job = readWindsurfSubagentJobs().get(resolvedId);
            if (job) {
                result.thread = windsurfSummaryFromSubagentJob(job);
                result.totalSteps = Math.max(result.totalSteps, job.resultStepCount || 0);
            }
        }
    } catch { /* 摘要补全失败不影响正文 */ }
}

/**
 * 本地兜底空壳：活跃 LS 都不持有但本地 .pb 存在 → partial:true 明确提示（失败路径 ⑥-a）。
 * 本地无 .pb → 返回 null（对话确实不存在）。
 */
function localFallbackResult(cascadeId: string): WindsurfConversationReadResult | null {
    if (!windsurfCascadeExistsLocally(cascadeId)) return null;
    return {
        cascadeId,
        thread: {
            id: cascadeId,
            cascadeId,
            title: cascadeId,
            summary: "当前没有持有此 WSF 对话的活跃 Windsurf 窗口（对话曾存在于本地，可能窗口已关闭）。请重新打开对应 Windsurf 窗口后重试。",
            stepCount: 0,
        },
        steps: [],
        rounds: [],
        pagesRead: 0,
        totalSteps: 0,
        partial: true,
    };
}

/**
 * 薄壳化：先问路由大脑要「已验证持有该对话」的 endpoint，再用它的 transport 读正文。
 *   - 读空且 stepCount>0 → 映射可能粘错，invalidate + 换持有者重试一次。
 *   - 全不持有 + 本地有 .pb → localFallbackResult(partial:true) 明确提示。
 *   - 全不持有 + 本地无 .pb → null。
 */
export async function loadWindsurfConversation(cascadeId: string): Promise<WindsurfConversationReadResult | null> {
    const resolvedId = await resolveWindsurfThreadId(cascadeId) || cascadeId;

    const attempt = async (): Promise<{ result: WindsurfConversationReadResult | null; endpoint: RouterEndpoint | null; stepCount: number }> => {
        const resolved = await resolveEndpointForConversation(resolvedId, "windsurf");
        if (!resolved.endpoint) {
            return { result: null, endpoint: null, stepCount: resolved.stepCount };
        }
        const transport: WindsurfLsTransport = (method, payload = {}) => resolved.endpoint!.transport(method, payload);
        const result = await readWindsurfConversation(transport, resolvedId);
        await enrichThreadSummary(result, transport, resolvedId);
        return { result, endpoint: resolved.endpoint, stepCount: resolved.stepCount };
    };

    let { result, endpoint, stepCount } = await attempt();

    // 读空且权威 stepCount>0 → 映射可能粘到滞后/错误 LS，剔除后换持有者重试一次。
    // S1 修复：守卫看真实正文量 result.steps.length，而非被 enrichThreadSummary 用 summary.stepCount
    // 抬高过的 result.totalSteps（否则守卫永不成立 → 重试失效 + 空壳冒充成功）。
    // `&& stepCount > 0` 保留：区分「合法空对话 stepCount=0」与「desync 读空 stepCount>0」。
    if (endpoint && result && result.steps.length === 0 && stepCount > 0) {
        invalidateMapping(resolvedId, "windsurf");
        ({ result, endpoint, stepCount } = await attempt());
    }

    if (endpoint && result) {
        return result;
    }

    const subagentJobResult = loadWindsurfSubagentJobConversation(resolvedId);
    if (subagentJobResult) return subagentJobResult;

    // 无持有者：本地兜底（partial 空壳）或 null。
    return localFallbackResult(resolvedId);
}

function extractUserText(userInput: Record<string, any>): string {
    const direct = toStringValue(userInput.userResponse).trim();
    if (direct) return direct;

    const chunks: string[] = [];
    for (const item of asArray(userInput.items)) {
        const text = toStringValue(asRecord(item).text).trim();
        if (text && !chunks.includes(text)) chunks.push(text);
    }

    return chunks.join("\n\n");
}

function estimateBase64Bytes(base64: string): number {
    const clean = base64.replace(/\s+/gu, "");
    if (!clean) return 0;
    const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function extensionFromMime(mimeType: string): string {
    switch (mimeType.toLowerCase()) {
        case "image/jpeg":
        case "image/jpg":
            return ".jpg";
        case "image/webp":
            return ".webp";
        case "image/gif":
            return ".gif";
        case "image/bmp":
            return ".bmp";
        case "image/png":
        default:
            return ".png";
    }
}

function buildImageAttachment(image: unknown, stepIndex: number, imageIndex: number): ConversationAttachment {
    const record = asRecord(image);
    const mimeType = toStringValue(record.mimeType) || "image/png";
    const base64 = toStringValue(record.base64Data).replace(/\s+/gu, "");
    const name = `wsf-step-${stepIndex}-image-${imageIndex + 1}${extensionFromMime(mimeType)}`;
    const descriptor: Record<string, unknown> = {
        kind: "image",
        source: "windsurf-data-url",
        name,
        mimeType,
        sizeBytes: estimateBase64Bytes(base64),
        stepIndex,
    };

    if (base64) {
        descriptor.dataUrl = `data:${mimeType};base64,${base64}`;
        try {
            descriptor.sha256 = crypto.createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
        } catch {
            descriptor.warning = "WSF image base64 could not be hashed";
        }
    } else {
        descriptor.warning = "WSF image descriptor has no base64Data";
    }

    return descriptor as unknown as ConversationAttachment;
}

function extractImageAttachments(step: Record<string, any>, stepIndex: number): ConversationAttachment[] {
    return asArray(asRecord(step.userInput).images).map((image, imageIndex) => buildImageAttachment(image, stepIndex, imageIndex));
}

function extractPlannerText(plannerResponse: Record<string, any>): string {
    return toStringValue(plannerResponse.modifiedResponse).trim() || toStringValue(plannerResponse.response).trim();
}

function extractMetadataToolCall(step: Record<string, any>): Record<string, any> {
    return asRecord(asRecord(step.metadata).toolCall);
}

function pushMetadataToolCall(
    round: ConversationRound,
    step: Record<string, any>,
    stepIndex: number,
    resultSummary: string,
    fallbackName: string,
): void {
    const toolCall = extractMetadataToolCall(step);
    const name = toStringValue(toolCall.name) || fallbackName;
    const argsSummary = toStringValue(toolCall.argumentsJson);
    round.toolCalls.push({
        stepIndex,
        name,
        argsSummary: truncate(argsSummary, 240),
        resultSummary: truncate(resultSummary, 2000),
    });
}

function extractThinkingMetadata(plannerResponse: Record<string, any>): Record<string, string | boolean> | undefined {
    const metadata: Record<string, string | boolean> = {};
    const thinkingDuration = toStringValue(plannerResponse.thinkingDuration);
    const signatureType = toStringValue(plannerResponse.signatureType);
    const messageId = toStringValue(plannerResponse.messageId);
    if (thinkingDuration) metadata.thinkingDuration = thinkingDuration;
    if (signatureType) metadata.signatureType = signatureType;
    if (messageId) metadata.messageId = messageId;
    if (toStringValue(plannerResponse.thinking)) metadata.hasThinking = true;
    return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function summarizeRunCommand(runCommand: Record<string, any>): string {
    const command = toStringValue(runCommand.commandLine || runCommand.proposedCommandLine);
    const cwd = toStringValue(runCommand.cwd);
    const exitCode = runCommand.exitCode !== undefined ? `exit=${runCommand.exitCode}` : "";
    const output = toStringValue(asRecord(runCommand.combinedOutput).full)
        || toStringValue(asRecord(runCommand.combinedOutput).ansiOutput)
        || toStringValue(runCommand.rawDebugOutput);
    return [
        command ? `command: ${command}` : "",
        cwd ? `cwd: ${cwd}` : "",
        exitCode,
        output ? `output:\n${output}` : "",
    ].filter(Boolean).join("\n");
}

function summarizeCommandStatus(commandStatus: Record<string, any>): string {
    const commandId = toStringValue(commandStatus.commandId);
    const status = toStringValue(commandStatus.status);
    const combined = toStringValue(commandStatus.combined);
    return [
        commandId ? `commandId: ${commandId}` : "",
        status ? `status: ${status}` : "",
        combined,
    ].filter(Boolean).join("\n");
}

function summarizeListDirectory(listDirectory: Record<string, any>): string {
    const uri = toStringValue(listDirectory.directoryPathUri);
    const results = asArray(listDirectory.results).map(item => {
        const record = asRecord(item);
        const name = toStringValue(record.name);
        const suffix = record.isDir ? "/" : "";
        const size = record.sizeBytes ? ` (${record.sizeBytes} bytes)` : "";
        return name ? `${name}${suffix}${size}` : "";
    }).filter(Boolean).join("\n");
    return [uri ? `directory: ${uri}` : "", results].filter(Boolean).join("\n");
}

function summarizeFind(find: Record<string, any>): string {
    const directory = toStringValue(find.searchDirectory);
    const pattern = toStringValue(find.pattern);
    const total = find.totalResults !== undefined ? `total=${find.totalResults}` : "";
    const output = toStringValue(find.rawOutput) || toStringValue(find.truncatedOutput);
    return [
        directory ? `directory: ${directory}` : "",
        pattern ? `pattern: ${pattern}` : "",
        total,
        output,
    ].filter(Boolean).join("\n");
}

function summarizeViewFile(viewFile: Record<string, any>): string {
    const uri = toStringValue(viewFile.absolutePathUri);
    const endLine = viewFile.endLine !== undefined ? `endLine=${viewFile.endLine}` : "";
    const content = toStringValue(viewFile.content);
    return [uri ? `file: ${uri}` : "", endLine, content].filter(Boolean).join("\n");
}

function summarizeMcpTool(mcpTool: Record<string, any>): string {
    const serverName = toStringValue(mcpTool.serverName);
    const result = toStringValue(mcpTool.resultString);
    return [serverName ? `server: ${serverName}` : "", result].filter(Boolean).join("\n");
}

function summarizeProxyWebServer(proxyWebServer: Record<string, any>): string {
    const name = toStringValue(proxyWebServer.name);
    const targetUrl = toStringValue(proxyWebServer.targetUrl);
    const proxyUrl = toStringValue(proxyWebServer.proxyUrl);
    return [
        name ? `name: ${name}` : "",
        targetUrl ? `target: ${targetUrl}` : "",
        proxyUrl ? `proxy: ${proxyUrl}` : "",
    ].filter(Boolean).join("\n");
}

function uriToPathLike(uri: string): string {
    if (!uri) return "";
    try {
        if (uri.startsWith("file://")) return decodeURIComponent(new URL(uri).pathname).replace(/^\/([A-Za-z]:)/u, "$1").replace(/\//gu, "\\");
    } catch {
        return uri;
    }
    return uri;
}

function diffLinesToUnified(diff: Record<string, any>): string {
    const lines = asArray(asRecord(diff.unifiedDiff).lines);
    return lines.map(line => {
        const record = asRecord(line);
        const text = toStringValue(record.text);
        const type = toStringValue(record.type);
        if (type.includes("INSERT")) return `+${text}`;
        if (type.includes("DELETE")) return `-${text}`;
        return ` ${text}`;
    }).join("\n");
}

function summarizeCodeAction(codeAction: Record<string, any>): string {
    const actionSpec = asRecord(codeAction.actionSpec);
    const targetUri = toStringValue(asRecord(asRecord(actionSpec.createFile).path).absoluteUri)
        || toStringValue(asRecord(asRecord(actionSpec.updateFile).path).absoluteUri)
        || toStringValue(asRecord(actionSpec.path).absoluteUri)
        || toStringValue(actionSpec.targetFile);
    const result = asRecord(codeAction.actionResult);
    const edit = asRecord(result.edit);
    const uri = toStringValue(edit.absoluteUri) || targetUri;
    const createFile = edit.createFile === true ? "createFile=true" : "";
    const instruction = toStringValue(asRecord(actionSpec.createFile).instruction)
        || toStringValue(asRecord(actionSpec.updateFile).instruction)
        || toStringValue(actionSpec.instruction);
    return [
        uri ? `file: ${uriToPathLike(uri)}` : "",
        createFile,
        instruction ? `instruction:\n${instruction}` : "",
    ].filter(Boolean).join("\n");
}

function extractCodeActionFile(codeAction: Record<string, any>): string {
    const actionSpec = asRecord(codeAction.actionSpec);
    const edit = asRecord(asRecord(codeAction.actionResult).edit);
    const uri = toStringValue(edit.absoluteUri)
        || toStringValue(asRecord(asRecord(actionSpec.createFile).path).absoluteUri)
        || toStringValue(asRecord(asRecord(actionSpec.updateFile).path).absoluteUri)
        || toStringValue(asRecord(actionSpec.path).absoluteUri)
        || toStringValue(actionSpec.targetFile);
    return uriToPathLike(uri);
}

function extractCodeActionDiff(codeAction: Record<string, any>): string {
    const diff = asRecord(asRecord(asRecord(codeAction.actionResult).edit).diff);
    return diffLinesToUnified(diff);
}

function attachWindsurfToolStep(round: ConversationRound, step: Record<string, any>, stepIndex: number): void {
    const type = toStringValue(step.type);
    if (type === "CORTEX_STEP_TYPE_MCP_TOOL") {
        const mcpTool = asRecord(step.mcpTool);
        const toolCall = asRecord(mcpTool.toolCall);
        round.toolCalls.push({
            stepIndex,
            name: toStringValue(toolCall.name) || toStringValue(extractMetadataToolCall(step).name) || "mcp_tool",
            argsSummary: truncate(toStringValue(toolCall.argumentsJson || extractMetadataToolCall(step).argumentsJson), 240),
            resultSummary: truncate(summarizeMcpTool(mcpTool), 2000),
        });
        return;
    }
    if (type === "CORTEX_STEP_TYPE_RUN_COMMAND") {
        pushMetadataToolCall(round, step, stepIndex, summarizeRunCommand(asRecord(step.runCommand)), "run_command");
        return;
    }
    if (type === "CORTEX_STEP_TYPE_COMMAND_STATUS") {
        pushMetadataToolCall(round, step, stepIndex, summarizeCommandStatus(asRecord(step.commandStatus)), "command_status");
        return;
    }
    if (type === "CORTEX_STEP_TYPE_LIST_DIRECTORY") {
        pushMetadataToolCall(round, step, stepIndex, summarizeListDirectory(asRecord(step.listDirectory)), "list_dir");
        return;
    }
    if (type === "CORTEX_STEP_TYPE_FIND") {
        pushMetadataToolCall(round, step, stepIndex, summarizeFind(asRecord(step.find)), "find_by_name");
        return;
    }
    if (type === "CORTEX_STEP_TYPE_VIEW_FILE") {
        const viewFile = asRecord(step.viewFile);
        const textSummary = summarizeViewFile(viewFile);
        pushMetadataToolCall(round, step, stepIndex, textSummary, "read_file");
        round.fileViews = round.fileViews || [];
        round.fileViews.push({
            stepIndex,
            kind: "windsurf_view_file",
            title: uriToPathLike(toStringValue(viewFile.absolutePathUri)),
            textSummary: truncate(textSummary, 2000),
        } as NonNullable<ConversationRound["fileViews"]>[number]);
        return;
    }
    if (type === "CORTEX_STEP_TYPE_CODE_ACTION") {
        const codeAction = asRecord(step.codeAction);
        pushMetadataToolCall(round, step, stepIndex, summarizeCodeAction(codeAction), "code_action");
        const unifiedDiff = extractCodeActionDiff(codeAction);
        round.codeActions.push({
            stepIndex,
            description: toStringValue(extractMetadataToolCall(step).name) || "Windsurf code action",
            targetFile: extractCodeActionFile(codeAction),
            instruction: truncate(summarizeCodeAction(codeAction), 500),
            diffs: unifiedDiff ? [{ targetContent: "", replacementContent: "", unifiedDiff }] : [],
        });
        return;
    }
    if (type === "CORTEX_STEP_TYPE_PROXY_WEB_SERVER") {
        pushMetadataToolCall(round, step, stepIndex, summarizeProxyWebServer(asRecord(step.proxyWebServer)), "proxy_web_server");
    }
}

function createRound(roundIndex: number, step: Record<string, any>, stepIndex: number): ConversationRound {
    const userInput = asRecord(step.userInput);
    return {
        roundIndex,
        startStep: stepIndex,
        endStep: stepIndex,
        userMessage: extractUserText(userInput),
        mediaAttachments: [],
        attachments: extractImageAttachments(step, stepIndex),
        aiResponses: [],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    };
}

export function windsurfStepsToConversationRounds(steps: unknown[]): ConversationRound[] {
    const rounds: ConversationRound[] = [];
    let currentRound: ConversationRound | undefined;

    for (let index = 0; index < steps.length; index++) {
        const step = asRecord(steps[index]);
        const type = toStringValue(step.type);

        if (isOversizedStepPlaceholder(step)) {
            if (currentRound) {
                rounds.push(currentRound);
            }
            currentRound = createOversizedStepRound(rounds.length + 1, step, index);
            continue;
        }

        if (type === "CORTEX_STEP_TYPE_USER_INPUT") {
            if (currentRound) rounds.push(currentRound);
            currentRound = createRound(rounds.length + 1, step, index);
            continue;
        }

        if (!currentRound) continue;
        currentRound.endStep = index;

        if (type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
            const plannerResponse = asRecord(step.plannerResponse);
            const aiResponse: Record<string, unknown> = {
                stepIndex: index,
                response: extractPlannerText(plannerResponse),
                thinking: toStringValue(plannerResponse.thinking),
                toolCalls: asArray(plannerResponse.toolCalls).map(toolCall => {
                    const record = asRecord(toolCall);
                    return {
                        name: toStringValue(record.name),
                        args: truncate(toStringValue(record.argumentsJson), 120),
                    };
                }),
            };
            const thinkingMetadata = extractThinkingMetadata(plannerResponse);
            if (thinkingMetadata) aiResponse.thinkingMetadata = thinkingMetadata;
            currentRound.aiResponses.push(aiResponse as unknown as ConversationRound["aiResponses"][number]);
            continue;
        }

        attachWindsurfToolStep(currentRound, step, index);
    }

    if (currentRound) rounds.push(currentRound);
    return rounds;
}
