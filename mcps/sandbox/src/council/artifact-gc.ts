import { spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { councilRuntimeTempRoot } from "./paths.js";
import { listCouncilArtifactManifests, type CouncilArtifactManifest } from "./artifact-store.js";

export type CouncilGcMode = "dryRun" | "apply" | "restore" | "purge";

export interface CouncilArtifactGcOptions {
    mode?: CouncilGcMode;
    quarantineId?: string;
    stableRoot?: string;
    legacyUserRoot?: string;
    projectRoot?: string;
    taskRoots?: string[];
    ttlDays?: number;
    now?: Date;
    isPidAlive?: (pid: number) => boolean;
    isGitTracked?: (filePath: string, projectRoot: string) => boolean;
    sameVolume?: (first: string, second: string) => boolean;
    includeLegacy?: boolean;
}

export interface CouncilGcItem {
    kind: "managed" | "legacy" | "quarantine";
    path: string;
    action: "remove" | "quarantine" | "restore" | "purge" | "skip";
    reasons: string[];
}

export interface CouncilGcResult {
    mode: CouncilGcMode;
    ttlDays: number;
    scanned: number;
    eligible: number;
    changed: number;
    quarantineId?: string;
    items: CouncilGcItem[];
    diagnostics: string[];
}

interface LegacyCandidate {
    path: string;
    source: "user" | "stable" | "dist";
}

interface QuarantineEntry {
    sourcePath: string;
    quarantinedPath: string;
    source: LegacyCandidate["source"];
    restoredAt?: string;
}

interface QuarantineManifest {
    id: string;
    createdAt: string;
    entries: QuarantineEntry[];
    restoreConflicts?: Array<{ sourcePath: string; quarantinedPath: string; recordedAt: string; reasons?: string[] }>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEADLINE_GRACE_MS = 15_000;
const MAX_MANAGED_REMOVALS = 100;

function packageRoot(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function readJson(filePath: string): unknown | undefined {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
        return undefined;
    }
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
        fs.renameSync(temporary, filePath);
    } finally {
        if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
}

function parseTtlDays(value: number | undefined): { ttlDays: number; diagnostics: string[] } {
    if (value === undefined) return { ttlDays: 14, diagnostics: [] };
    if (!Number.isFinite(value)) return { ttlDays: 14, diagnostics: ["SANDBOX_COUNCIL_ARTIFACT_TTL_DAYS 无效，已使用 14 天"] };
    if (value < 7) return { ttlDays: 7, diagnostics: ["SANDBOX_COUNCIL_ARTIFACT_TTL_DAYS 小于 7，已钳制为 7 天"] };
    return { ttlDays: Math.floor(value), diagnostics: [] };
}

function defaultPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function sameVolume(first: string, second: string): boolean {
    return path.parse(path.resolve(first)).root.toLowerCase() === path.parse(path.resolve(second)).root.toLowerCase();
}

function normalizedPath(filePath: string): string {
    const normalized = path.resolve(filePath).replace(/\\/gu, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

interface CouncilTaskSnapshot {
    filePath: string;
    value: unknown;
    searchableValues: string[];
}

function collectSearchableValues(value: unknown, result: string[]): void {
    if (typeof value === "string") {
        result.push(value.replace(/\\/gu, "/").toLowerCase());
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectSearchableValues(item, result);
        return;
    }
    if (!value || typeof value !== "object") return;
    for (const item of Object.values(value)) collectSearchableValues(item, result);
}

function taskJsonSnapshots(taskRoots: string[]): CouncilTaskSnapshot[] {
    const snapshots: CouncilTaskSnapshot[] = [];
    for (const root of taskRoots) {
        try {
            for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const taskDir = path.join(root, entry.name);
                for (const name of ["spec.json", "progress.json", "done.json", "checkpoint.json"]) {
                    const filePath = path.join(taskDir, name);
                    const value = readJson(filePath);
                    if (!value) continue;
                    const searchableValues: string[] = [];
                    collectSearchableValues(value, searchableValues);
                    snapshots.push({ filePath, value, searchableValues });
                }
            }
        } catch {}
    }
    return snapshots;
}

function hasLivePid(value: unknown, isPidAlive: (pid: number) => boolean): boolean {
    if (!value || typeof value !== "object") return false;
    const record = value as { pid?: unknown };
    return typeof record.pid === "number" && isPidAlive(record.pid);
}

function hasActiveTaskPid(value: unknown, isPidAlive: (pid: number) => boolean, nowMs: number): boolean {
    if (!value || typeof value !== "object") return false;
    const record = value as { status?: unknown; pid?: unknown; deadlineAt?: unknown };
    if (record.status !== "running" || typeof record.pid !== "number") return false;
    if (typeof record.deadlineAt === "string") {
        const deadlineMs = Date.parse(record.deadlineAt);
        if (Number.isFinite(deadlineMs) && nowMs > deadlineMs + DEADLINE_GRACE_MS) return false;
    }
    return isPidAlive(record.pid);
}

function protectionForTask(taskId: string | null, taskRoots: string[], nowMs: number, isPidAlive: (pid: number) => boolean): string[] {
    if (!taskId) return [];
    const reasons = new Set<string>();
    for (const root of taskRoots) {
        for (const name of ["spec.json", "progress.json", "done.json"]) {
            const record = readJson(path.join(root, taskId, name)) as { status?: unknown; deadlineAt?: unknown; pid?: unknown } | undefined;
            if (!record) continue;
            if (record.status === "running") reasons.add("关联 task 仍在 running");
            if (typeof record.deadlineAt === "string") {
                const deadlineMs = Date.parse(record.deadlineAt);
                if (Number.isFinite(deadlineMs) && nowMs <= deadlineMs + DEADLINE_GRACE_MS) reasons.add("关联 task 仍处于 deadline 宽限期");
            }
            if (hasLivePid(record, isPidAlive)) reasons.add("关联 task PID 仍存活");
        }
    }
    return [...reasons];
}

function normalizedGitPath(filePath: string): string {
    const normalized = filePath.split(path.sep).join("/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function defaultGitTrackedChecker(projectRoot: string): (filePath: string, root: string) => boolean {
    const result = spawnSync("git", ["-C", projectRoot, "ls-files", "-z"], { encoding: "utf-8", windowsHide: true });
    const tracked = result.status === 0
        ? new Set(result.stdout.split("\0").filter(Boolean).map(normalizedGitPath))
        : new Set<string>();
    return (filePath: string, root: string): boolean => {
        if (path.resolve(root) !== path.resolve(projectRoot) || !isWithin(projectRoot, filePath)) return false;
        return tracked.has(normalizedGitPath(path.relative(projectRoot, filePath)));
    };
}

export function defaultCouncilTaskRoots(stableRoot: string, legacyUserRoot: string, projectRoot: string): string[] {
    const configuredTaskRoot = process.env.SANDBOX_COUNCIL_TASK_ROOT?.trim();
    const roots = [
        configuredTaskRoot,
        path.join(stableRoot, "council-tasks"),
        path.join(legacyUserRoot, "council-tasks"),
        path.join(projectRoot, "dist", "council", "sandbox-data", "temp", "council-tasks"),
        path.join(process.cwd(), "sandbox-data", "temp", "council-tasks"),
        path.join(os.homedir(), "AppData", "Local", "Programs", "Antigravity", "sandbox-data", "temp", "council-tasks"),
    ].filter((root): root is string => Boolean(root));
    return [...new Set(roots.map((root) => path.resolve(root)))];
}

interface ManagedCandidates {
    diagnostics: string[];
    externalReferenceManifests: Map<string, string[]>;
    items: CouncilGcItem[];
}

interface ManifestDependencies {
    runIds: Set<string>;
    taskIds: Set<string>;
}

function safeCouncilIdentifier(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function extractManifestDependencies(filePath: string): ManifestDependencies | undefined {
    const rawManifest = readJson(filePath);
    if (!rawManifest || typeof rawManifest !== "object" || Array.isArray(rawManifest)) return undefined;
    const rawDependencies = (rawManifest as { dependsOn?: unknown }).dependsOn;
    if (!Array.isArray(rawDependencies)) return undefined;
    const runIds = new Set<string>();
    const taskIds = new Set<string>();
    for (const rawDependency of rawDependencies) {
        if (!rawDependency || typeof rawDependency !== "object" || Array.isArray(rawDependency)) return undefined;
        const dependency = rawDependency as { runId?: unknown; taskId?: unknown };
        const hasRunId = dependency.runId !== undefined;
        const hasTaskId = dependency.taskId !== undefined;
        if ((!hasRunId && !hasTaskId) || (hasRunId && !safeCouncilIdentifier(dependency.runId)) || (hasTaskId && !safeCouncilIdentifier(dependency.taskId))) {
            return undefined;
        }
        if (hasRunId) runIds.add(dependency.runId as string);
        if (hasTaskId) taskIds.add(dependency.taskId as string);
    }
    return { runIds, taskIds };
}

function managedCandidates(stableRoot: string, ttlDays: number, nowMs: number, taskRoots: string[], isPidAlive: (pid: number) => boolean): ManagedCandidates {
    const records = listCouncilArtifactManifests();
    const dependentRunIds = new Set<string>();
    const dependentTaskIds = new Set<string>();
    const externalReferenceManifests = new Map<string, string[]>();
    const unverifiedDependencyManifests: string[] = [];
    for (const record of records) {
        if (record.state === "valid") {
            for (const dependency of record.manifest.dependsOn) {
                if (dependency.runId) dependentRunIds.add(dependency.runId);
                if (dependency.taskId) dependentTaskIds.add(dependency.taskId);
            }
            for (const reference of record.manifest.externalReferences) {
                if (typeof reference !== "string" || !reference.trim()) continue;
                const normalizedReference = normalizedPath(reference);
                const manifests = externalReferenceManifests.get(normalizedReference) || [];
                manifests.push(record.artifactManifestPath);
                externalReferenceManifests.set(normalizedReference, manifests);
            }
            continue;
        }
        const dependencies = extractManifestDependencies(record.artifactManifestPath);
        if (!dependencies) {
            unverifiedDependencyManifests.push(record.artifactManifestPath);
            continue;
        }
        for (const runId of dependencies.runIds) dependentRunIds.add(runId);
        for (const taskId of dependencies.taskIds) dependentTaskIds.add(taskId);
    }
    const freezeManagedRemoval = unverifiedDependencyManifests.length > 0;
    const candidates: Array<{ item: CouncilGcItem; terminalMs: number }> = [];
    for (const record of records) {
        if (record.state === "invalid") {
            candidates.push({ item: { kind: "managed", path: record.artifactManifestPath, action: "skip", reasons: ["manifest 损坏或未知"] }, terminalMs: Number.MAX_SAFE_INTEGER });
            continue;
        }
        const manifest = record.manifest;
        const runDirectory = path.dirname(record.artifactManifestPath);
        const reasons: string[] = [];
        const terminalMs = manifest.terminalAt ? Date.parse(manifest.terminalAt) : Number.NaN;
        const lastAccessedMs = manifest.lastAccessedAt ? Date.parse(manifest.lastAccessedAt) : Number.NaN;
        const retentionAnchorMs = Math.max(
            Number.isFinite(terminalMs) ? terminalMs : Number.NEGATIVE_INFINITY,
            Number.isFinite(lastAccessedMs) ? lastAccessedMs : Number.NEGATIVE_INFINITY,
        );
        if (manifest.status === "running") reasons.push("run 仍在 running");
        if (!manifest.terminalAt || !Number.isFinite(terminalMs)) reasons.push("不是完整终态 run");
        if (!isWithin(path.join(stableRoot, "council-artifacts"), runDirectory)) reasons.push("run 目录越出 artifact 根");
        if (fs.existsSync(path.join(runDirectory, ".preserve"))) reasons.push("存在 .preserve");
        if (dependentRunIds.has(manifest.runId) || (manifest.taskId && dependentTaskIds.has(manifest.taskId))) reasons.push("被 dependsOn 引用为来源");
        if (freezeManagedRemoval) reasons.push("存在无法验证 dependsOn 的 manifest，已冻结托管自动回收");
        reasons.push(...protectionForTask(manifest.taskId, taskRoots, nowMs, isPidAlive));
        if (Number.isFinite(retentionAnchorMs) && nowMs < retentionAnchorMs + ttlDays * DAY_MS) reasons.push(`未达到 ${ttlDays} 天 TTL`);
        candidates.push({ item: { kind: "managed", path: runDirectory, action: reasons.length === 0 ? "remove" : "skip", reasons }, terminalMs: Number.isFinite(terminalMs) ? terminalMs : Number.MAX_SAFE_INTEGER });
    }
    const eligible = candidates.filter((candidate) => candidate.item.action === "remove").sort((first, second) => first.terminalMs - second.terminalMs);
    const allowed = new Set(eligible.slice(0, MAX_MANAGED_REMOVALS).map((candidate) => candidate.item.path));
    const items: CouncilGcItem[] = candidates.map((candidate): CouncilGcItem => candidate.item.action === "remove" && !allowed.has(candidate.item.path)
        ? { ...candidate.item, action: "skip", reasons: ["达到单次 100 个可回收 run 上限"] }
        : candidate.item);
    const diagnostics = unverifiedDependencyManifests.map((manifestPath) => "无法安全验证 manifest dependsOn，已冻结托管自动回收: " + manifestPath);
    return { diagnostics, externalReferenceManifests, items };
}

function legacyInventory(stableRoot: string, legacyUserRoot: string, projectRoot: string): LegacyCandidate[] {
    const results: LegacyCandidate[] = [];
    const addDirectFiles = (root: string, source: LegacyCandidate["source"], names: string[]) => {
        for (const name of names) {
            const directory = path.join(root, name);
            try {
                for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                    if (entry.isFile()) results.push({ path: path.join(directory, entry.name), source });
                }
            } catch {}
        }
    };
    addDirectFiles(legacyUserRoot, "user", ["council-indexes", "council-model-calls"]);
    addDirectFiles(path.join(legacyUserRoot, "mcp-sandbox"), "user", ["council-model-calls"]);
    addDirectFiles(stableRoot, "stable", ["council-indexes", "council-model-calls", "council-large-input", "council-large-inputs"]);
    const distCouncil = path.join(projectRoot, "dist", "council");
    try {
        for (const entry of fs.readdirSync(distCouncil, { withFileTypes: true })) {
            if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") results.push({ path: path.join(distCouncil, entry.name), source: "dist" });
        }
    } catch {}
    return results;
}

function allowedLegacyDirectories(stableRoot: string, legacyUserRoot: string, projectRoot: string): Record<LegacyCandidate["source"], string[]> {
    return {
        user: [
            path.join(legacyUserRoot, "council-indexes"),
            path.join(legacyUserRoot, "council-model-calls"),
            path.join(legacyUserRoot, "mcp-sandbox", "council-model-calls"),
        ],
        stable: ["council-indexes", "council-model-calls", "council-large-input", "council-large-inputs"].map((name) => path.join(stableRoot, name)),
        dist: [path.join(projectRoot, "dist", "council")],
    };
}

function isAllowedLegacyFile(candidate: LegacyCandidate, stableRoot: string, legacyUserRoot: string, projectRoot: string): boolean {
    const allowedDirectories = allowedLegacyDirectories(stableRoot, legacyUserRoot, projectRoot)[candidate.source];
    if (!allowedDirectories.some((directory) => path.resolve(directory) === path.dirname(path.resolve(candidate.path)))) return false;
    return candidate.source !== "dist" || path.extname(candidate.path).toLowerCase() === ".md";
}

function legacySafetyReasons(candidate: LegacyCandidate, taskSnapshots: CouncilTaskSnapshot[], externalReferenceManifests: Map<string, string[]>, projectRoot: string, stableRoot: string, legacyUserRoot: string, nowMs: number, isPidAlive: (pid: number) => boolean, isGitTracked: (filePath: string, root: string) => boolean, isSameVolume: (first: string, second: string) => boolean): string[] {
    const reasons: string[] = [];
    if (!isAllowedLegacyFile(candidate, stableRoot, legacyUserRoot, projectRoot)) reasons.push("未命中 legacy 允许列表");
    if (!isSameVolume(candidate.path, stableRoot)) reasons.push("跨卷移动已拒绝");
    if (isGitTracked(candidate.path, projectRoot)) reasons.push("git tracked 文件不可迁移");
    const normalizedCandidate = normalizedPath(candidate.path);
    for (const manifestPath of externalReferenceManifests.get(normalizedCandidate) || []) {
        reasons.push("被有效 manifest externalReferences 精确引用: " + manifestPath);
    }
    for (const task of taskSnapshots) {
        if (hasActiveTaskPid(task.value, isPidAlive, nowMs)) reasons.push(`活跃 PID 引用: ${task.filePath}`);
        if (task.searchableValues.some((value) => value.includes(normalizedCandidate))) reasons.push(`task resume/路径引用: ${task.filePath}`);
    }
    return [...new Set(reasons)];
}

function createQuarantineId(): string {
    return `legacy-${new Date().toISOString().replace(/[:.]/gu, "-")}-${crypto.randomUUID().slice(0, 8)}`;
}

function quarantineRoot(stableRoot: string): string {
    return path.join(stableRoot, "council-quarantine");
}

function applyLegacy(items: CouncilGcItem[], candidates: LegacyCandidate[], stableRoot: string, now: Date): { changed: number; quarantineId?: string; diagnostics: string[] } {
    const approved = candidates.filter((candidate) => items.find((item) => item.path === candidate.path && item.action === "quarantine"));
    if (approved.length === 0) return { changed: 0, diagnostics: [] };
    const id = createQuarantineId();
    const groupDir = path.join(quarantineRoot(stableRoot), id);
    const filesDir = path.join(groupDir, "files");
    const manifest: QuarantineManifest = { id, createdAt: now.toISOString(), entries: [] };
    writeJson(path.join(groupDir, "manifest.json"), manifest);
    let changed = 0;
    for (const candidate of approved) {
        const target = path.join(filesDir, `${manifest.entries.length}-${path.basename(candidate.path)}`);
        try {
            fs.mkdirSync(filesDir, { recursive: true });
            fs.renameSync(candidate.path, target);
            manifest.entries.push({ sourcePath: candidate.path, quarantinedPath: target, source: candidate.source });
            changed += 1;
        } catch (error) {
            const item = items.find((entry) => entry.path === candidate.path);
            if (item) {
                item.action = "skip";
                item.reasons.push(`隔离失败: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    writeJson(path.join(groupDir, "manifest.json"), manifest);
    return { changed, quarantineId: id, diagnostics: [] };
}

function validQuarantineId(value: string | undefined): value is string {
    return Boolean(value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(value));
}

function restoreQuarantine(stableRoot: string, legacyUserRoot: string, projectRoot: string, quarantineId: string | undefined, now: Date): CouncilGcResult {
    const ttlDays = 14;
    if (!validQuarantineId(quarantineId)) return { mode: "restore", ttlDays, scanned: 0, eligible: 0, changed: 0, items: [], diagnostics: ["restore 必须提供安全的 quarantineId"] };
    const groupDir = path.join(quarantineRoot(stableRoot), quarantineId);
    const manifestPath = path.join(groupDir, "manifest.json");
    const manifest = readJson(manifestPath) as QuarantineManifest | undefined;
    if (!manifest || manifest.id !== quarantineId || !Array.isArray(manifest.entries)) {
        return { mode: "restore", ttlDays, scanned: 0, eligible: 0, changed: 0, items: [], diagnostics: ["quarantine manifest 无效"] };
    }
    const items: CouncilGcItem[] = [];
    const conflicts: NonNullable<QuarantineManifest["restoreConflicts"]> = [];
    const pendingEntries = manifest.entries.filter((entry) => !entry.restoredAt);
    for (const entry of pendingEntries) {
        const source = entry.source;
        const sourceCandidate = { path: entry.sourcePath, source } as LegacyCandidate;
        const quarantinedRoot = path.join(groupDir, "files");
        const reasons: string[] = [];
        if (!["user", "stable", "dist"].includes(source)) reasons.push("source 类型无效");
        if (!isAllowedLegacyFile(sourceCandidate, stableRoot, legacyUserRoot, projectRoot)) reasons.push("原路径不在允许列表");
        if (!isWithin(quarantinedRoot, entry.quarantinedPath)) reasons.push("隔离路径越界");
        if (fs.existsSync(entry.sourcePath)) reasons.push("原路径已被占用");
        if (!fs.existsSync(entry.quarantinedPath)) reasons.push("隔离文件缺失");
        if (!sameVolume(entry.sourcePath, stableRoot)) reasons.push("原路径与稳定根不在同卷");
        if (reasons.length > 0) {
            conflicts.push({ sourcePath: entry.sourcePath, quarantinedPath: entry.quarantinedPath, recordedAt: now.toISOString(), reasons });
        }
    }
    if (conflicts.length > 0) {
        for (const conflict of conflicts) {
            items.push({ kind: "quarantine", path: conflict.sourcePath, action: "skip", reasons: [...(conflict.reasons || ["恢复冲突"]), "检测到冲突，整组未恢复"] });
        }
        manifest.restoreConflicts = [...(manifest.restoreConflicts || []), ...conflicts];
        writeJson(path.join(groupDir, "restore-conflict.json"), conflicts);
        writeJson(manifestPath, manifest);
        return { mode: "restore", ttlDays, scanned: manifest.entries.length, eligible: 0, changed: 0, quarantineId, items, diagnostics: ["检测到恢复冲突，已停止整个隔离组"] };
    }
    let changed = 0;
    for (const entry of pendingEntries) {
        if (entry.restoredAt) continue;
        fs.mkdirSync(path.dirname(entry.sourcePath), { recursive: true });
        fs.renameSync(entry.quarantinedPath, entry.sourcePath);
        entry.restoredAt = now.toISOString();
        items.push({ kind: "quarantine", path: entry.sourcePath, action: "restore", reasons: [] });
        changed += 1;
    }
    writeJson(manifestPath, manifest);
    return { mode: "restore", ttlDays, scanned: manifest.entries.length, eligible: pendingEntries.length, changed, quarantineId, items, diagnostics: [] };
}

function purgeQuarantines(stableRoot: string, quarantineId: string | undefined, nowMs: number): CouncilGcResult {
    const ttlDays = 14;
    const items: CouncilGcItem[] = [];
    let scanned = 0;
    let changed = 0;
    try {
        for (const entry of fs.readdirSync(quarantineRoot(stableRoot), { withFileTypes: true })) {
            if (!entry.isDirectory() || (quarantineId && entry.name !== quarantineId)) continue;
            const groupDir = path.join(quarantineRoot(stableRoot), entry.name);
            const manifest = readJson(path.join(groupDir, "manifest.json")) as QuarantineManifest | undefined;
            scanned += 1;
            const createdMs = manifest ? Date.parse(manifest.createdAt) : Number.NaN;
            const unRestored = manifest?.entries?.some((item) => !item.restoredAt) === true;
            if (!manifest || !unRestored || !Number.isFinite(createdMs) || nowMs < createdMs + 7 * DAY_MS) {
                items.push({ kind: "quarantine", path: groupDir, action: "skip", reasons: ["仅清除超过 7 天且未恢复的有效隔离组"] });
                continue;
            }
            fs.rmSync(groupDir, { recursive: true, force: true });
            items.push({ kind: "quarantine", path: groupDir, action: "purge", reasons: [] });
            changed += 1;
        }
    } catch {}
    return { mode: "purge", ttlDays, scanned, eligible: changed, changed, quarantineId, items, diagnostics: [] };
}

export function runCouncilArtifactGc(options: CouncilArtifactGcOptions = {}): CouncilGcResult {
    const mode = options.mode || "dryRun";
    const now = options.now || new Date();
    const nowMs = now.getTime();
    const configuredTtl = options.ttlDays ?? (process.env.SANDBOX_COUNCIL_ARTIFACT_TTL_DAYS === undefined
        ? undefined
        : Number(process.env.SANDBOX_COUNCIL_ARTIFACT_TTL_DAYS));
    const retention = parseTtlDays(configuredTtl);
    const { ttlDays } = retention;
    const stableRoot = path.resolve(options.stableRoot || councilRuntimeTempRoot());
    const projectRoot = path.resolve(options.projectRoot || packageRoot());
    const legacyUserRoot = path.resolve(options.legacyUserRoot || path.join(os.homedir(), ".gemini", "antigravity-cli"));
    const taskRoots = options.taskRoots || defaultCouncilTaskRoots(stableRoot, legacyUserRoot, projectRoot);
    const isPidAlive = options.isPidAlive || defaultPidAlive;
    const isGitTracked = options.isGitTracked || defaultGitTrackedChecker(projectRoot);
    const isSameVolume = options.sameVolume || sameVolume;
    if (mode === "restore") return restoreQuarantine(stableRoot, legacyUserRoot, projectRoot, options.quarantineId, now);
    if (mode === "purge") return purgeQuarantines(stableRoot, options.quarantineId, nowMs);
    const managed = managedCandidates(stableRoot, ttlDays, nowMs, taskRoots, isPidAlive);
    const items = managed.items;
    const legacyCandidates = options.includeLegacy === false ? [] : legacyInventory(stableRoot, legacyUserRoot, projectRoot);
    const taskSnapshots = taskJsonSnapshots(taskRoots);
    for (const candidate of legacyCandidates) {
        const reasons = legacySafetyReasons(candidate, taskSnapshots, managed.externalReferenceManifests, projectRoot, stableRoot, legacyUserRoot, nowMs, isPidAlive, isGitTracked, isSameVolume);
        items.push({ kind: "legacy", path: candidate.path, action: reasons.length === 0 ? "quarantine" : "skip", reasons });
    }
    const eligible = items.filter((item) => item.action === "remove" || item.action === "quarantine").length;
    if (mode === "dryRun") return { mode, ttlDays, scanned: items.length, eligible, changed: 0, items, diagnostics: [...retention.diagnostics, ...managed.diagnostics] };
    let changed = 0;
    for (const item of items.filter((entry) => entry.kind === "managed" && entry.action === "remove")) {
        try {
            fs.rmSync(item.path, { recursive: true, force: true });
            changed += 1;
        } catch (error) {
            item.action = "skip";
            item.reasons.push(`托管 run 清理失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const legacy = applyLegacy(items, legacyCandidates, stableRoot, now);
    return { mode, ttlDays, scanned: items.length, eligible, changed: changed + legacy.changed, quarantineId: legacy.quarantineId, items, diagnostics: [...retention.diagnostics, ...managed.diagnostics, ...legacy.diagnostics] };
}
