import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
    assertCouncilManagedPath,
    councilRuntimeTempRoot,
    ensureCouncilManagedDirectory,
    relativeCouncilManagedPath,
} from "./paths.js";

export const COUNCIL_ARTIFACT_STATUSES = ["running", "done", "error", "interrupted", "quarantined"] as const;

export type CouncilArtifactStatus = typeof COUNCIL_ARTIFACT_STATUSES[number];

export interface CouncilArtifactDependency {
    runId?: string;
    taskId?: string;
}

export interface CouncilArtifactManifest {
    runId: string;
    taskId: string | null;
    ownerId: string;
    status: CouncilArtifactStatus;
    createdAt: string;
    terminalAt: string | null;
    lastAccessedAt: string | null;
    artifactPaths: string[];
    dependsOn: CouncilArtifactDependency[];
    retentionClass: string;
    expiresAt: string;
    externalReferences: string[];
}

export interface CreateCouncilArtifactRunInput {
    runId?: string;
    taskId?: string;
    ownerId: string;
    dependsOn?: CouncilArtifactDependency[];
    retentionClass?: string;
    externalReferences?: string[];
}

export interface CouncilArtifactRun {
    runId: string;
    runDirectory: string;
    artifactManifestPath: string;
    manifest: CouncilArtifactManifest;
}

export type CouncilArtifactManifestRecord =
    | { state: "valid"; artifactManifestPath: string; manifest: CouncilArtifactManifest }
    | { state: "invalid"; artifactManifestPath: string; error: string };

export interface CouncilArtifactRetentionPolicy {
    ttlDays: number;
    diagnostics: string[];
}

const MIN_RETENTION_DAYS = 7;
const DEFAULT_RETENTION_DAYS = 14;

export function validCouncilIdentifier(value: string, label: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
        throw new Error(`${label} 必须是 1-128 位的安全文件名标识`);
    }
    return value;
}

function validOwnerId(value: string): string {
    const ownerId = value.trim();
    if (!ownerId) throw new Error("ownerId 不能为空");
    return ownerId;
}

function isTerminal(status: CouncilArtifactStatus): boolean {
    return status !== "running";
}

function isoNow(): string {
    return new Date().toISOString();
}

function parseRetentionDays(rawValue: string | undefined): CouncilArtifactRetentionPolicy {
    if (!rawValue?.trim()) return { ttlDays: DEFAULT_RETENTION_DAYS, diagnostics: [] };
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
        return { ttlDays: DEFAULT_RETENTION_DAYS, diagnostics: ["SANDBOX_COUNCIL_ARTIFACT_TTL_DAYS 无效，已使用 14 天"] };
    }
    if (parsed < MIN_RETENTION_DAYS) {
        return { ttlDays: MIN_RETENTION_DAYS, diagnostics: ["SANDBOX_COUNCIL_ARTIFACT_TTL_DAYS 小于 7，已钳制为 7 天"] };
    }
    return { ttlDays: Math.floor(parsed), diagnostics: [] };
}

export function councilArtifactRetentionPolicy(): CouncilArtifactRetentionPolicy {
    return parseRetentionDays(process.env.SANDBOX_COUNCIL_ARTIFACT_TTL_DAYS);
}

function expirationFrom(manifest: Pick<CouncilArtifactManifest, "createdAt" | "terminalAt" | "lastAccessedAt">): string {
    const anchors = [manifest.createdAt, manifest.terminalAt, manifest.lastAccessedAt]
        .filter((value): value is string => Boolean(value))
        .map((value) => Date.parse(value))
        .filter(Number.isFinite);
    const anchor = anchors.length > 0 ? Math.max(...anchors) : Date.now();
    const expiresAt = new Date(anchor);
    expiresAt.setUTCDate(expiresAt.getUTCDate() + councilArtifactRetentionPolicy().ttlDays);
    return expiresAt.toISOString();
}

function artifactRoot(): string {
    return path.join(councilRuntimeTempRoot(), "council-artifacts");
}

function artifactDirectory(runId: string): string {
    return path.join(artifactRoot(), validCouncilIdentifier(runId, "runId"));
}

function manifestPathForRun(runId: string): string {
    return path.join(artifactDirectory(runId), "manifest.json");
}

function assertManagedFilePath(filePath: string): string {
    const target = assertCouncilManagedPath(filePath);
    ensureCouncilManagedDirectory(path.dirname(target));
    return assertCouncilManagedPath(target);
}

function atomicWriteJson(filePath: string, value: unknown): void {
    const target = assertManagedFilePath(filePath);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf-8");
        fs.renameSync(temporary, target);
    } finally {
        if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
}

function normalizeStoredArtifactPath(value: unknown, runId: string, sourcePath: string): string {
    if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) {
        throw new Error(`manifest artifact 路径无效: ${sourcePath}`);
    }
    const target = assertCouncilManagedPath(path.resolve(councilRuntimeTempRoot(), value));
    const relativePath = relativeCouncilManagedPath(target);
    if (relativePath !== value.replace(/\\/gu, "/") || !relativePath.startsWith(`council-artifacts/${runId}/`)) {
        throw new Error(`manifest artifact 路径越出所属 run: ${sourcePath}`);
    }
    return relativePath;
}

function parseManifest(value: unknown, sourcePath: string): CouncilArtifactManifest {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`manifest 格式无效: ${sourcePath}`);
    const manifest = value as Partial<CouncilArtifactManifest>;
    if (!manifest.runId || !manifest.ownerId || !manifest.createdAt || !manifest.expiresAt) {
        throw new Error(`manifest 缺少必要字段: ${sourcePath}`);
    }
    validCouncilIdentifier(manifest.runId, "manifest.runId");
    validOwnerId(manifest.ownerId);
    if (!COUNCIL_ARTIFACT_STATUSES.includes(manifest.status as CouncilArtifactStatus)) {
        throw new Error(`manifest 状态无效: ${sourcePath}`);
    }
    for (const value of [manifest.createdAt, manifest.expiresAt, manifest.terminalAt, manifest.lastAccessedAt]) {
        if (value !== null && value !== undefined && !Number.isFinite(Date.parse(value))) {
            throw new Error(`manifest 时间字段无效: ${sourcePath}`);
        }
    }
    if (!Array.isArray(manifest.artifactPaths) || !Array.isArray(manifest.dependsOn)) {
        throw new Error(`manifest 路径或依赖字段无效: ${sourcePath}`);
    }
    const dependsOn = manifest.dependsOn.map((dependency) => {
        if (!dependency || typeof dependency !== "object") throw new Error(`manifest 依赖字段无效: ${sourcePath}`);
        const runId = dependency.runId ? validCouncilIdentifier(dependency.runId, "dependsOn.runId") : undefined;
        const taskId = dependency.taskId ? validCouncilIdentifier(dependency.taskId, "dependsOn.taskId") : undefined;
        if (!runId && !taskId) throw new Error(`manifest 依赖缺少 runId/taskId: ${sourcePath}`);
        return { runId, taskId };
    });
    const artifactPaths = [...new Set(manifest.artifactPaths.map((artifactPath) => normalizeStoredArtifactPath(artifactPath, manifest.runId!, sourcePath)))];
    return {
        runId: manifest.runId,
        taskId: manifest.taskId || null,
        ownerId: manifest.ownerId,
        status: manifest.status as CouncilArtifactStatus,
        createdAt: manifest.createdAt,
        terminalAt: manifest.terminalAt || null,
        lastAccessedAt: manifest.lastAccessedAt || null,
        artifactPaths,
        dependsOn,
        retentionClass: manifest.retentionClass || "default",
        expiresAt: manifest.expiresAt,
        externalReferences: Array.isArray(manifest.externalReferences) ? [...new Set(manifest.externalReferences)] : [],
    };
}

function readManifestFile(filePath: string): CouncilArtifactManifest {
    const target = assertManagedFilePath(filePath);
    if (!fs.existsSync(target)) throw new Error(`未找到 council manifest: ${target}`);
    return parseManifest(JSON.parse(fs.readFileSync(target, "utf-8")) as unknown, target);
}

function writeManifest(manifest: CouncilArtifactManifest): CouncilArtifactRun {
    const runDirectory = ensureCouncilManagedDirectory(artifactDirectory(manifest.runId));
    const artifactManifestPath = path.join(runDirectory, "manifest.json");
    atomicWriteJson(artifactManifestPath, manifest);
    return { runId: manifest.runId, runDirectory, artifactManifestPath, manifest };
}

export function councilArtifactDirectory(runId: string): string {
    return ensureCouncilManagedDirectory(artifactDirectory(runId));
}

export function councilTaskDirectory(taskId: string): string {
    return ensureCouncilManagedDirectory(path.join(councilRuntimeTempRoot(), "council-tasks", validCouncilIdentifier(taskId, "taskId")));
}

export function councilArtifactPath(runId: string, ...relativeParts: string[]): string {
    if (relativeParts.length === 0) throw new Error("托管 artifact 路径不能为空");
    const directory = councilArtifactDirectory(runId);
    const target = assertManagedFilePath(path.join(directory, ...relativeParts));
    const relativePath = relativeCouncilManagedPath(target);
    if (!relativePath.startsWith(`council-artifacts/${runId}/`)) {
        throw new Error(`artifact 路径越出 run 目录: ${target}`);
    }
    ensureCouncilManagedDirectory(path.dirname(target));
    return target;
}

export function createCouncilArtifactRun(input: CreateCouncilArtifactRunInput): CouncilArtifactRun {
    const runId = validCouncilIdentifier(input.runId || crypto.randomUUID(), "runId");
    const runDirectory = artifactDirectory(runId);
    if (fs.existsSync(runDirectory)) throw new Error(`council run 已存在: ${runId}`);
    ensureCouncilManagedDirectory(runDirectory);
    const taskId = input.taskId ? validCouncilIdentifier(input.taskId, "taskId") : null;
    if (taskId) councilTaskDirectory(taskId);
    const createdAt = isoNow();
    const manifest: CouncilArtifactManifest = {
        runId,
        taskId,
        ownerId: validOwnerId(input.ownerId),
        status: "running",
        createdAt,
        terminalAt: null,
        lastAccessedAt: null,
        artifactPaths: [],
        dependsOn: input.dependsOn ? [...input.dependsOn] : [],
        retentionClass: input.retentionClass || "default",
        expiresAt: expirationFrom({ createdAt, terminalAt: null, lastAccessedAt: null }),
        externalReferences: input.externalReferences ? [...new Set(input.externalReferences.map((reference) => path.resolve(reference)))] : [],
    };
    return writeManifest(manifest);
}

export function readCouncilArtifactManifest(runId: string, options: { touch?: "resume" | "restore" } = {}): CouncilArtifactRun {
    const artifactManifestPath = manifestPathForRun(runId);
    const manifest = readManifestFile(artifactManifestPath);
    if (manifest.runId !== runId) throw new Error(`manifest runId 与目录不一致: ${artifactManifestPath}`);
    if (!options.touch) {
        return { runId: manifest.runId, runDirectory: councilArtifactDirectory(manifest.runId), artifactManifestPath, manifest };
    }
    const touched: CouncilArtifactManifest = {
        ...manifest,
        lastAccessedAt: isoNow(),
        expiresAt: expirationFrom({ ...manifest, lastAccessedAt: isoNow() }),
    };
    return writeManifest(touched);
}

export function registerCouncilArtifact(runId: string, filePath: string): CouncilArtifactRun {
    const current = readCouncilArtifactManifest(runId);
    const managedPath = assertManagedFilePath(filePath);
    if (!fs.existsSync(managedPath)) throw new Error(`只能登记已存在的托管 artifact: ${managedPath}`);
    const relativePath = relativeCouncilManagedPath(managedPath);
    if (!relativePath.startsWith(`council-artifacts/${current.runId}/`)) {
        throw new Error(`artifact 必须位于对应 run 目录: ${managedPath}`);
    }
    return writeManifest({ ...current.manifest, artifactPaths: [...new Set([...current.manifest.artifactPaths, relativePath])] });
}

export function registerCouncilExternalReference(runId: string, referencePath: string): CouncilArtifactRun {
    const current = readCouncilArtifactManifest(runId);
    const reference = path.resolve(referencePath);
    return writeManifest({ ...current.manifest, externalReferences: [...new Set([...current.manifest.externalReferences, reference])] });
}

export function finishCouncilArtifactRun(runId: string, status: Exclude<CouncilArtifactStatus, "running">): CouncilArtifactRun {
    const current = readCouncilArtifactManifest(runId);
    const terminalAt = isoNow();
    const manifest: CouncilArtifactManifest = {
        ...current.manifest,
        status,
        terminalAt,
        expiresAt: expirationFrom({ ...current.manifest, terminalAt }),
    };
    return writeManifest(manifest);
}

export function listCouncilArtifactManifests(): CouncilArtifactManifestRecord[] {
    const root = artifactRoot();
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry): CouncilArtifactManifestRecord => {
            const artifactManifestPath = path.join(root, entry.name, "manifest.json");
            try {
                return { state: "valid", artifactManifestPath, manifest: readCouncilArtifactManifest(entry.name).manifest };
            } catch (error) {
                return { state: "invalid", artifactManifestPath, error: error instanceof Error ? error.message : String(error) };
            }
        });
}
