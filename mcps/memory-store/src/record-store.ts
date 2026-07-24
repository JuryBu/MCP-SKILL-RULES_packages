import path from "path";
import fs from "fs";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import Fuse from "fuse.js";
import {
    DATA_ROOT, WORKSPACES_DIR, GENERAL_DIR,
    writeJsonAtomicAsync, writeTextAtomicAsync,
    workspaceHash, findWorkspaceHash, listWorkspaceHashes, listWorkspaceHashesAsync,
    withIndexLock,
} from "./store.js";

/**
 * Record 存储层
 *
 * 管理 records/ 子目录下的对话记录文件：
 * - {workspaceHash}/records/{conversationId}.md
 * - {workspaceHash}/records/_records_index.json
 *
 * v1.8 新增
 */

// ============= 类型定义 =============

/** Record 索引条目 */
export interface RecordIndexEntry {
    conversationId: string;
    title: string;
    timeSpan: string;         // "YYYY-MM-DD HH:mm ~ YYYY-MM-DD HH:mm"
    totalRounds: number;
    totalSteps: number;
    lastUpdatedRound: number; // Record 覆盖到了第几轮
    lastUpdatedAt: string;    // ISO 时间
    phases: number;           // Phase 数量
    sizeBytes: number;
    tags?: string[];          // v1.8.1: 自动提取的标签
    chain?: string;           // v1.17.2: 对话来源 (codex/claude-code/windsurf/antigravity)，用于 stale_check
    coveredRevisionSequence?: number;
    commitArtifact?: {
        identity: RecordCommitArtifactIdentity;
        mainIndex: RecordCommitMainIndexEntry;
    };
}

export interface RecordIndexEntryMetadataSnapshot {
    conversationId: string;
    title: string;
    timeSpan: string;
    totalRounds: number;
    totalSteps: number;
    lastUpdatedRound: number;
    lastUpdatedAt: string;
    phases: number;
    sizeBytes: number;
    tags: string[];
    chain?: string;
    coveredRevisionSequence?: number;
}

/** Record 索引文件 */
export interface RecordsIndex {
    version: number;
    records: Record<string, RecordIndexEntry>;
}

export interface RecordIndexWriteResult {
    entry: RecordIndexEntry;
    outcome: "created" | "updated";
}

export interface WriteRecordOptions {
    afterContentWrite?: () => void | Promise<void>;
}

export type RecordCommitArtifactKind = "record_body" | "main_index" | "reader_index";

export interface RecordCommitArtifactTarget {
    kind: RecordCommitArtifactKind;
    conversationId: string;
    recordId: string;
    relativePath: string;
}

export interface RecordCommitArtifactIdentity {
    conversationId: string;
    recordId: string;
    commitId: string;
    coveredRevision: string;
    bodyHash: string;
    recordCommitEpoch: number;
    recordIndexMetadata?: RecordIndexEntryMetadataSnapshot;
    recordIndexMetadataHash?: string;
}

export interface RecordCommitBodyArtifactImage {
    body: string | null;
    hash: string | null;
    ownerCommitId: string | null;
    revision: string | null;
    identity: RecordCommitArtifactIdentity | null;
}

export interface RecordCommitJsonArtifactImage<Value = unknown> {
    value: Value | null;
    hash: string | null;
    ownerCommitId: string | null;
    revision: string | null;
    identity: RecordCommitArtifactIdentity | null;
    storageValue?: unknown | null;
}

export interface RecordCommitMainIndexEntry {
    commitId: string;
    coveredRevision: string;
    conversationId: string;
    recordId: string;
}

export type RecordCommitConditionalMutationResult<Image> =
    | { kind: "applied" | "already_applied"; current: Image }
    | { kind: "expected_mismatch" | "ownership_changed"; current: Image };

export type RecordCommitOwnershipValidator = (input: {
    phase: "before_write" | "after_write";
    target: RecordCommitArtifactTarget;
    identity: RecordCommitArtifactIdentity;
    current: RecordCommitBodyArtifactImage | RecordCommitJsonArtifactImage;
}) => boolean | Promise<boolean>;

export type RecordCommitAuthorityScope = <Value>(operation: () => Promise<Value>) => Promise<Value>;

export interface WriteRecordCommitBodyConditionallyInput {
    hash: string;
    target: RecordCommitArtifactTarget;
    identity: RecordCommitArtifactIdentity;
    body: string;
    expected: RecordCommitBodyArtifactImage;
    validateOwnership: RecordCommitOwnershipValidator;
    withCommitAuthority?: RecordCommitAuthorityScope;
}

export interface WriteRecordCommitMainIndexConditionallyInput {
    hash: string;
    target: RecordCommitArtifactTarget;
    identity: RecordCommitArtifactIdentity;
    entry: RecordCommitMainIndexEntry;
    expected: RecordCommitJsonArtifactImage<RecordCommitMainIndexEntry>;
    validateOwnership: RecordCommitOwnershipValidator;
    withCommitAuthority?: RecordCommitAuthorityScope;
    recordMeta?: Partial<RecordIndexEntry>;
}

export interface RestoreRecordCommitBodyIfOwnedInput {
    hash: string;
    target: RecordCommitArtifactTarget;
    identity: RecordCommitArtifactIdentity;
    expectedBodyHash: string;
    before: RecordCommitBodyArtifactImage;
    validateOwnership: RecordCommitOwnershipValidator;
    withCommitAuthority?: RecordCommitAuthorityScope;
}

export interface RestoreRecordCommitMainIndexIfOwnedInput {
    hash: string;
    target: RecordCommitArtifactTarget;
    identity: RecordCommitArtifactIdentity;
    expectedEntryHash: string;
    before: RecordCommitJsonArtifactImage;
    validateOwnership: RecordCommitOwnershipValidator;
    withCommitAuthority?: RecordCommitAuthorityScope;
}

// ============= 路径工具 =============

/** 获取某工作区的 records/ 目录路径 */
function getRecordsDir(hash: string): string {
    const base = hash === "general" ? GENERAL_DIR : path.join(WORKSPACES_DIR, hash);
    return path.join(base, "records");
}

/** 获取 Record 索引文件路径 */
function getRecordsIndexPath(hash: string): string {
    return path.join(getRecordsDir(hash), "_records_index.json");
}

/** 获取单个 Record 文件路径 */
function getRecordPath(hash: string, conversationId: string): string {
    return path.join(getRecordsDir(hash), `${conversationId}.md`);
}

function getRecordCommitBodyIdentityPath(hash: string, conversationId: string): string {
    return getRecordSidecarPath(hash, conversationId, "record_commit_body.json");
}

function getRecordCommitBodyPublishIntentPath(hash: string, conversationId: string): string {
    return getRecordSidecarPath(hash, conversationId, "record_commit_body.intent.json");
}

function getRecordCommitArtifactLockPath(hash: string): string {
    return path.join(getRecordsDir(hash), "_record_commit_artifacts.lock");
}

// ============= 目录初始化 =============

/**
 * 确保指定工作区的 records/ 目录存在
 */
export function ensureRecordsDir(hash: string): void {
    const dir = getRecordsDir(hash);
    fs.mkdirSync(dir, { recursive: true });
}

export async function ensureRecordsDirAsync(hash: string): Promise<void> {
    await fs.promises.mkdir(getRecordsDir(hash), { recursive: true });
}

function isNotFoundError(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function unlinkIfExists(filePath: string): Promise<boolean> {
    try {
        await fs.promises.unlink(filePath);
        return true;
    } catch (error) {
        if (isNotFoundError(error)) return false;
        throw error;
    }
}

async function copyFileIfExists(sourcePath: string, targetPath: string): Promise<void> {
    try {
        await fs.promises.copyFile(sourcePath, targetPath);
    } catch (error) {
        if (!isNotFoundError(error)) throw error;
    }
}

const RECORD_COMMIT_LOCK_TIMEOUT_MS = 30_000;
const RECORD_COMMIT_LOCK_RETRY_MS = 10;
const RECORD_COMMIT_LOCK_PROCESS_START_TOLERANCE_MS = 250;
const RECORD_COMMIT_LOCK_PROCESS_QUERY_TIMEOUT_MS = 2_000;
const execFileAsync = promisify(execFile);

type RecordCommitFileLock = {
    path: string;
    token: string;
    handle: fs.promises.FileHandle;
};

type RecordCommitFileLockMetadata = {
    token: string;
    ownerPid: number;
    createdAtMs: number;
    ownerStartedAtMs?: number;
};

type RecordCommitBodyPublishIntent = {
    version: 1;
    target: Pick<RecordCommitArtifactTarget, "conversationId" | "recordId">;
    desired: {
        identity: RecordCommitArtifactIdentity | null;
        bodyHash: string | null;
    };
    before: {
        body: string | null;
        identity: RecordCommitArtifactIdentity | null;
    };
};

type RecordCommitBodyArtifactFiles = {
    body: string | null;
    identity: RecordCommitArtifactIdentity | null;
};

function sleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function sha256(value: string): string {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new TypeError("Record commit artifact 不能包含非有限数字");
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (!value || typeof value !== "object") throw new TypeError("Record commit artifact 必须是 JSON 值");
    return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
        .join(",")}}`;
}

function hashJson(value: unknown): string {
    return sha256(canonicalJson(value));
}

export function calculateRecordCommitArtifactJsonHash(value: unknown): string {
    return hashJson(value);
}

export function calculateRecordIndexEntryMetadataHash(value: RecordIndexEntryMetadataSnapshot): string {
    return hashJson(value);
}

export function createRecordIndexEntryMetadataSnapshot(
    conversationId: string,
    sizeBytes: number,
    meta: Partial<RecordIndexEntry> | undefined,
    committedAt: string,
): RecordIndexEntryMetadataSnapshot {
    if (!isNonEmptyString(conversationId) || !isNonEmptyString(committedAt) || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
        throw new TypeError("Record Index metadata snapshot 缺少 conversationId/committedAt 或 sizeBytes 无效");
    }
    const tags = Array.isArray(meta?.tags) && meta.tags.every(item => typeof item === "string")
        ? [...new Set(meta.tags)].sort()
        : [];
    return {
        conversationId,
        title: meta?.title || "Untitled",
        timeSpan: meta?.timeSpan || "",
        totalRounds: meta?.totalRounds ?? 0,
        totalSteps: meta?.totalSteps ?? 0,
        lastUpdatedRound: meta?.lastUpdatedRound ?? 0,
        lastUpdatedAt: meta?.lastUpdatedAt || committedAt,
        phases: meta?.phases ?? 0,
        sizeBytes,
        tags,
        ...(meta?.chain ? { chain: meta.chain } : {}),
        ...(Number.isSafeInteger(meta?.coveredRevisionSequence) && (meta?.coveredRevisionSequence ?? -1) >= 0
            ? { coveredRevisionSequence: meta!.coveredRevisionSequence }
            : {}),
    };
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

export function isRecordIndexEntryMetadataSnapshot(value: unknown): value is RecordIndexEntryMetadataSnapshot {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Partial<RecordIndexEntryMetadataSnapshot>;
    return isNonEmptyString(candidate.conversationId)
        && typeof candidate.title === "string"
        && typeof candidate.timeSpan === "string"
        && Number.isInteger(candidate.totalRounds) && (candidate.totalRounds ?? -1) >= 0
        && Number.isInteger(candidate.totalSteps) && (candidate.totalSteps ?? -1) >= 0
        && Number.isInteger(candidate.lastUpdatedRound) && (candidate.lastUpdatedRound ?? -1) >= 0
        && isNonEmptyString(candidate.lastUpdatedAt)
        && Number.isInteger(candidate.phases) && (candidate.phases ?? -1) >= 0
        && Number.isInteger(candidate.sizeBytes) && (candidate.sizeBytes ?? -1) >= 0
        && Array.isArray(candidate.tags) && candidate.tags.every(item => typeof item === "string")
        && (candidate.chain === undefined || isNonEmptyString(candidate.chain))
        && (candidate.coveredRevisionSequence === undefined
            || Number.isSafeInteger(candidate.coveredRevisionSequence) && candidate.coveredRevisionSequence >= 0);
}

function hasBoundRecordIndexMetadata(identity: RecordCommitArtifactIdentity): identity is RecordCommitArtifactIdentity & {
    recordIndexMetadata: RecordIndexEntryMetadataSnapshot;
    recordIndexMetadataHash: string;
} {
    return identity.recordIndexMetadata !== undefined
        && isNonEmptyString(identity.recordIndexMetadataHash)
        && isRecordIndexEntryMetadataSnapshot(identity.recordIndexMetadata)
        && calculateRecordIndexEntryMetadataHash(identity.recordIndexMetadata) === identity.recordIndexMetadataHash;
}

export function isRecordCommitArtifactIdentity(value: unknown): value is RecordCommitArtifactIdentity {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Partial<RecordCommitArtifactIdentity>;
    const baseValid = isNonEmptyString(candidate.conversationId)
        && isNonEmptyString(candidate.recordId)
        && isNonEmptyString(candidate.commitId)
        && isNonEmptyString(candidate.coveredRevision)
        && isNonEmptyString(candidate.bodyHash)
        && Number.isInteger(candidate.recordCommitEpoch)
        && (candidate.recordCommitEpoch ?? 0) > 0;
    if (!baseValid) return false;
    const hasSnapshot = candidate.recordIndexMetadata !== undefined || candidate.recordIndexMetadataHash !== undefined;
    return !hasSnapshot || hasBoundRecordIndexMetadata(candidate as RecordCommitArtifactIdentity);
}

function clone<Value>(value: Value): Value {
    return JSON.parse(JSON.stringify(value)) as Value;
}

function sameIdentity(left: RecordCommitArtifactIdentity | null, right: RecordCommitArtifactIdentity | null): boolean {
    return left?.conversationId === right?.conversationId
        && left?.recordId === right?.recordId
        && left?.commitId === right?.commitId
        && left?.coveredRevision === right?.coveredRevision
        && left?.bodyHash === right?.bodyHash
        && left?.recordCommitEpoch === right?.recordCommitEpoch
        && left?.recordIndexMetadataHash === right?.recordIndexMetadataHash
        && canonicalJson(left?.recordIndexMetadata ?? null) === canonicalJson(right?.recordIndexMetadata ?? null);
}

function sameBodyImage(left: RecordCommitBodyArtifactImage, right: RecordCommitBodyArtifactImage): boolean {
    return left.body === right.body
        && left.hash === right.hash
        && left.ownerCommitId === right.ownerCommitId
        && left.revision === right.revision
        && sameIdentity(left.identity, right.identity);
}

function sameJsonImage(left: RecordCommitJsonArtifactImage, right: RecordCommitJsonArtifactImage): boolean {
    return left.hash === right.hash
        && left.ownerCommitId === right.ownerCommitId
        && left.revision === right.revision
        && sameIdentity(left.identity, right.identity)
        && canonicalJson(left.value) === canonicalJson(right.value);
}

function expectedRelativePath(kind: RecordCommitArtifactKind, conversationId: string): string {
    if (kind === "record_body") return `${conversationId}.md`;
    if (kind === "main_index") return "_records_index.json";
    return `${conversationId}.record_index.json`;
}

export function getRecordCommitArtifactRelativePath(kind: RecordCommitArtifactKind, conversationId: string): string {
    return expectedRelativePath(kind, conversationId);
}

export function validateRecordCommitArtifactTarget(
    hash: string,
    target: RecordCommitArtifactTarget,
    expectedKind: RecordCommitArtifactKind,
): boolean {
    if (target.kind !== expectedKind || !isNonEmptyString(target.conversationId) || !isNonEmptyString(target.recordId)) return false;
    if (!isNonEmptyString(target.relativePath) || path.isAbsolute(target.relativePath) || target.relativePath.includes("\\")) return false;
    const root = path.resolve(getRecordsDir(hash));
    const resolved = path.resolve(root, target.relativePath);
    const relative = path.relative(root, resolved);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
    return relative.split(path.sep).join("/") === expectedRelativePath(expectedKind, target.conversationId);
}

function assertRecordCommitTarget(
    hash: string,
    target: RecordCommitArtifactTarget,
    expectedKind: RecordCommitArtifactKind,
    identity?: RecordCommitArtifactIdentity,
): void {
    if (!validateRecordCommitArtifactTarget(hash, target, expectedKind)) {
        throw new TypeError(`${expectedKind} target 必须映射到规范 Record 根内的当前 artifact 路径`);
    }
    if (identity && (target.conversationId !== identity.conversationId || target.recordId !== identity.recordId)) {
        throw new TypeError(`${expectedKind} target identity 与 commit identity 不匹配`);
    }
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === "EPERM";
    }
}

type RecordCommitLockOwnerState = "dead" | "same_instance" | "different_instance" | "unknown";

type ProcessStartedAt = {
    valueMs: number;
    precisionMs: number;
};

function currentProcessStartedAtMs(): number {
    return Math.round(Date.now() - process.uptime() * 1_000);
}

function parseProcessStartedAtMs(output: string): number | null {
    const value = output.trim();
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function readWindowsProcessStartedAt(pid: number): Promise<ProcessStartedAt | null> {
    try {
        const { stdout } = await execFileAsync(
            "powershell.exe",
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `$target = Get-Process -Id ${pid} -ErrorAction Stop; ([DateTimeOffset]$target.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`,
            ],
            { timeout: RECORD_COMMIT_LOCK_PROCESS_QUERY_TIMEOUT_MS, windowsHide: true },
        );
        const valueMs = parseProcessStartedAtMs(stdout);
        return valueMs === null ? null : { valueMs, precisionMs: RECORD_COMMIT_LOCK_PROCESS_START_TOLERANCE_MS };
    } catch {
        return null;
    }
}

async function readLinuxProcessStartedAt(pid: number): Promise<ProcessStartedAt | null> {
    try {
        const [stat, uptime, clockTicks] = await Promise.all([
            fs.promises.readFile(`/proc/${pid}/stat`, "utf8"),
            fs.promises.readFile("/proc/uptime", "utf8"),
            execFileAsync("getconf", ["CLK_TCK"], { timeout: RECORD_COMMIT_LOCK_PROCESS_QUERY_TIMEOUT_MS, windowsHide: true }),
        ]);
        const closingParenthesis = stat.lastIndexOf(")");
        const fields = closingParenthesis === -1 ? [] : stat.slice(closingParenthesis + 2).trim().split(/\s+/u);
        const startTicks = Number(fields[19]);
        const uptimeSeconds = Number(uptime.trim().split(/\s+/u)[0]);
        const ticksPerSecond = Number(clockTicks.stdout.trim());
        if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeSeconds) || !Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) {
            return null;
        }
        return {
            valueMs: Math.round(Date.now() - (uptimeSeconds - startTicks / ticksPerSecond) * 1_000),
            precisionMs: RECORD_COMMIT_LOCK_PROCESS_START_TOLERANCE_MS,
        };
    } catch {
        return null;
    }
}

async function readPosixProcessStartedAt(pid: number): Promise<ProcessStartedAt | null> {
    try {
        const { stdout } = await execFileAsync(
            "ps",
            ["-o", "lstart=", "-p", String(pid)],
            { timeout: RECORD_COMMIT_LOCK_PROCESS_QUERY_TIMEOUT_MS, windowsHide: true },
        );
        const valueMs = Date.parse(stdout.trim());
        return Number.isFinite(valueMs) ? { valueMs, precisionMs: 1_500 } : null;
    } catch {
        return null;
    }
}

async function readProcessStartedAt(pid: number): Promise<ProcessStartedAt | null> {
    if (process.platform === "win32") return readWindowsProcessStartedAt(pid);
    if (process.platform === "linux") {
        const linuxProcessStartedAt = await readLinuxProcessStartedAt(pid);
        if (linuxProcessStartedAt) return linuxProcessStartedAt;
    }
    return readPosixProcessStartedAt(pid);
}

async function getRecordCommitLockOwnerState(metadata: RecordCommitFileLockMetadata): Promise<RecordCommitLockOwnerState> {
    if (!isProcessAlive(metadata.ownerPid)) return "dead";
    const ownerStartedAtMs = metadata.ownerStartedAtMs;
    if (typeof ownerStartedAtMs !== "number" || !Number.isFinite(ownerStartedAtMs)) return "unknown";
    const current = await readProcessStartedAt(metadata.ownerPid);
    if (!current) return "unknown";
    return Math.abs(current.valueMs - ownerStartedAtMs) <= current.precisionMs
        ? "same_instance"
        : "different_instance";
}

function isReclaimableRecordCommitLockOwnerState(state: RecordCommitLockOwnerState): boolean {
    return state === "dead" || state === "different_instance";
}

async function readRecordCommitFileLock(lockPath: string): Promise<{
    metadata: RecordCommitFileLockMetadata;
    mtimeMs: number;
    size: number;
    dev: number;
    ino: number;
} | null> {
    try {
        const [content, stat] = await Promise.all([
            fs.promises.readFile(lockPath, "utf8"),
            fs.promises.stat(lockPath),
        ]);
        const metadata = JSON.parse(content) as Partial<RecordCommitFileLockMetadata>;
        if (!isNonEmptyString(metadata.token)
            || !Number.isInteger(metadata.ownerPid)
            || !Number.isFinite(metadata.createdAtMs)
            || (metadata.ownerStartedAtMs !== undefined && !Number.isFinite(metadata.ownerStartedAtMs))) return null;
        return {
            metadata: metadata as RecordCommitFileLockMetadata,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            dev: stat.dev,
            ino: stat.ino,
        };
    } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
    }
}

async function reclaimStaleRecordCommitFileLock(lockPath: string): Promise<void> {
    const observed = await readRecordCommitFileLock(lockPath);
    if (!observed || !isReclaimableRecordCommitLockOwnerState(await getRecordCommitLockOwnerState(observed.metadata))) return;
    const confirmed = await readRecordCommitFileLock(lockPath);
    if (!confirmed
        || confirmed.metadata.token !== observed.metadata.token
        || confirmed.mtimeMs !== observed.mtimeMs
        || confirmed.size !== observed.size
        || confirmed.dev !== observed.dev
        || confirmed.ino !== observed.ino
        || !isReclaimableRecordCommitLockOwnerState(await getRecordCommitLockOwnerState(confirmed.metadata))) return;
    const quarantinePath = `${lockPath}.stale.${crypto.randomUUID()}`;
    try {
        await fs.promises.rename(lockPath, quarantinePath);
    } catch (error) {
        if (isNotFoundError(error) || (error as NodeJS.ErrnoException)?.code === "EEXIST") return;
        throw error;
    }
    const quarantined = await readRecordCommitFileLock(quarantinePath);
    if (quarantined?.metadata.token === observed.metadata.token) {
        await fs.promises.rm(quarantinePath, { force: true });
    } else {
        try {
            await fs.promises.rename(quarantinePath, lockPath);
        } catch (error) {
            if (!isNotFoundError(error) && (error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
        }
    }
}

async function acquireRecordCommitFileLock(hash: string): Promise<RecordCommitFileLock> {
    const lockPath = getRecordCommitArtifactLockPath(hash);
    const deadline = Date.now() + RECORD_COMMIT_LOCK_TIMEOUT_MS;
    for (;;) {
        const token = crypto.randomUUID();
        try {
            const handle = await fs.promises.open(lockPath, "wx", 0o600);
            try {
                await handle.writeFile(JSON.stringify({
                    token,
                    ownerPid: process.pid,
                    createdAtMs: Date.now(),
                    ownerStartedAtMs: currentProcessStartedAtMs(),
                }), "utf8");
                await handle.sync();
                return { path: lockPath, token, handle };
            } catch (error) {
                await handle.close().catch(() => undefined);
                await fs.promises.rm(lockPath, { force: true }).catch(() => undefined);
                throw error;
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
        }
        await reclaimStaleRecordCommitFileLock(lockPath);
        if (Date.now() >= deadline) throw new Error(`等待 Record commit artifact 锁超时: ${lockPath}`);
        await sleep(RECORD_COMMIT_LOCK_RETRY_MS);
    }
}

async function assertRecordCommitFileLock(lock: RecordCommitFileLock): Promise<void> {
    const current = await readRecordCommitFileLock(lock.path);
    if (!current || current.metadata.token !== lock.token) throw new Error("Record commit artifact 锁已被其他 owner 接管");
}

async function releaseRecordCommitFileLock(lock: RecordCommitFileLock): Promise<void> {
    try {
        await lock.handle.close();
    } finally {
        const current = await readRecordCommitFileLock(lock.path);
        if (current?.metadata.token === lock.token) await fs.promises.rm(lock.path, { force: true });
    }
}

export async function withRecordCommitArtifactLock<Value>(hash: string, operation: () => Promise<Value>): Promise<Value> {
    return withIndexLock(`record_commit_artifacts_${hash}`, async () => {
        await ensureRecordsDirAsync(hash);
        const lock = await acquireRecordCommitFileLock(hash);
        try {
            await assertRecordCommitFileLock(lock);
            const value = await operation();
            await assertRecordCommitFileLock(lock);
            return value;
        } finally {
            await releaseRecordCommitFileLock(lock);
        }
    });
}

// ============= 索引操作 =============

/**
 * 读取 Record 索引
 */
export function readRecordsIndex(hash: string): RecordsIndex {
    const indexPath = getRecordsIndexPath(hash);
    if (!fs.existsSync(indexPath)) {
        return { version: 1, records: {} };
    }
    try {
        return JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    } catch {
        return { version: 1, records: {} };
    }
}

export async function readRecordsIndexAsync(hash: string): Promise<RecordsIndex> {
    try {
        return JSON.parse(await fs.promises.readFile(getRecordsIndexPath(hash), "utf-8")) as RecordsIndex;
    } catch {
        return { version: 1, records: {} };
    }
}

/**
 * 写入 Record 索引（原子写入，带锁）
 */
export async function writeRecordsIndex(hash: string, index: RecordsIndex): Promise<void> {
    await withIndexLock(`records_${hash}`, async () => {
        await ensureRecordsDirAsync(hash);
        await writeJsonAtomicAsync(getRecordsIndexPath(hash), index);
    });
}

// ============= Record 文件操作 =============

/**
 * 读取 Record 内容
 * @returns Record markdown 内容，不存在返回 null
 */
export function readRecord(hash: string, conversationId: string): string | null {
    const filePath = getRecordPath(hash, conversationId);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8");
}

export async function readRecordAsync(hash: string, conversationId: string): Promise<string | null> {
    try {
        return await fs.promises.readFile(getRecordPath(hash, conversationId), "utf-8");
    } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
    }
}

function getRecordSidecarPath(hash: string, conversationId: string, suffix: string): string {
    return path.join(getRecordsDir(hash), `${conversationId}.${suffix}`);
}

export function readRecordSidecar<T = unknown>(hash: string, conversationId: string, suffix: string): T | null {
    const filePath = getRecordSidecarPath(hash, conversationId, suffix);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    } catch {
        return null;
    }
}

export async function readRecordSidecarAsync<T = unknown>(hash: string, conversationId: string, suffix: string): Promise<T | null> {
    try {
        return JSON.parse(await fs.promises.readFile(getRecordSidecarPath(hash, conversationId, suffix), "utf-8")) as T;
    } catch {
        return null;
    }
}

export async function writeRecordSidecar(hash: string, conversationId: string, suffix: string, data: unknown): Promise<void> {
    await withIndexLock(`record_sidecar_${hash}_${conversationId}_${suffix}`, async () => {
        await ensureRecordsDirAsync(hash);
        await writeJsonAtomicAsync(getRecordSidecarPath(hash, conversationId, suffix), data);
    });
}

export async function deleteRecordSidecar(hash: string, conversationId: string, suffix: string): Promise<boolean> {
    const filePath = getRecordSidecarPath(hash, conversationId, suffix);
    return withIndexLock(`record_sidecar_${hash}_${conversationId}_${suffix}`, async () => {
        return unlinkIfExists(filePath);
    });
}

function emptyBodyArtifactImage(): RecordCommitBodyArtifactImage {
    return { body: null, hash: null, ownerCommitId: null, revision: null, identity: null };
}

function emptyJsonArtifactImage<Value = unknown>(): RecordCommitJsonArtifactImage<Value> {
    return { value: null, hash: null, ownerCommitId: null, revision: null, identity: null, storageValue: null };
}

function bodyArtifactImage(
    body: string | null,
    identity: RecordCommitArtifactIdentity | null,
): RecordCommitBodyArtifactImage {
    if (body === null) return emptyBodyArtifactImage();
    return {
        body,
        hash: sha256(body),
        ownerCommitId: identity?.commitId ?? null,
        revision: identity?.coveredRevision ?? null,
        identity: identity ? clone(identity) : null,
    };
}

function sameBodyArtifactBinding(
    body: string | null,
    identity: RecordCommitArtifactIdentity | null,
    expected: { body: string | null; identity: RecordCommitArtifactIdentity | null },
): boolean {
    return body === expected.body && sameIdentity(identity, expected.identity);
}

function isIntentIdentityForTarget(
    identity: RecordCommitArtifactIdentity | null,
    target: Pick<RecordCommitArtifactTarget, "conversationId" | "recordId">,
): boolean {
    return identity === null || (isRecordCommitArtifactIdentity(identity)
        && identity.conversationId === target.conversationId
        && identity.recordId === target.recordId);
}

function isRecordCommitBodyPublishIntent(value: unknown): value is RecordCommitBodyPublishIntent {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Partial<RecordCommitBodyPublishIntent>;
    if (candidate.version !== 1 || !candidate.target || !candidate.desired || !candidate.before) return false;
    const target = candidate.target as Partial<RecordCommitBodyPublishIntent["target"]>;
    const desired = candidate.desired as Partial<RecordCommitBodyPublishIntent["desired"]>;
    const before = candidate.before as Partial<RecordCommitBodyPublishIntent["before"]>;
    if (!isNonEmptyString(target.conversationId) || !isNonEmptyString(target.recordId)
        || (desired.bodyHash !== null && !isNonEmptyString(desired.bodyHash))
        || (before.body !== null && typeof before.body !== "string")) return false;
    const intentTarget = { conversationId: target.conversationId, recordId: target.recordId };
    if (!isIntentIdentityForTarget(desired.identity ?? null, intentTarget)
        || !isIntentIdentityForTarget(before.identity ?? null, intentTarget)) return false;
    if (before.identity && (before.body === null || sha256(before.body) !== before.identity.bodyHash)) return false;
    if (desired.bodyHash === null) return desired.identity === null;
    return desired.identity !== null && desired.identity !== undefined && desired.identity.bodyHash === desired.bodyHash;
}

function sameBodyPublishIntentDesired(
    intent: RecordCommitBodyPublishIntent,
    body: string | null,
    identity: RecordCommitArtifactIdentity | null,
): boolean {
    return intent.desired.bodyHash === (body === null ? null : sha256(body))
        && sameIdentity(intent.desired.identity, identity);
}

function sameBodyPublishIntentBefore(
    intent: RecordCommitBodyPublishIntent,
    before: RecordCommitBodyArtifactImage,
): boolean {
    return sameBodyArtifactBinding(intent.before.body, intent.before.identity, before);
}

async function readRecordCommitBodyPublishIntent(
    hash: string,
    target: RecordCommitArtifactTarget,
): Promise<RecordCommitBodyPublishIntent | null> {
    const intentPath = getRecordCommitBodyPublishIntentPath(hash, target.conversationId);
    let content: string;
    try {
        content = await fs.promises.readFile(intentPath, "utf8");
    } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch (error) {
        throw new Error(`Record commit 正文发布 intent 已损坏: ${intentPath}`, { cause: error });
    }
    if (!isRecordCommitBodyPublishIntent(parsed)
        || parsed.target.conversationId !== target.conversationId
        || parsed.target.recordId !== target.recordId) {
        throw new Error(`Record commit 正文发布 intent 与目标不匹配: ${intentPath}`);
    }
    return parsed;
}

async function readRecordCommitBodyArtifactFiles(
    hash: string,
    target: RecordCommitArtifactTarget,
): Promise<RecordCommitBodyArtifactFiles> {
    const body = await readRecordAsync(hash, target.conversationId);
    const identity = await readRecordSidecarAsync<RecordCommitArtifactIdentity>(hash, target.conversationId, "record_commit_body.json");
    const currentIdentity = identity && isRecordCommitArtifactIdentity(identity)
        && identity.conversationId === target.conversationId
        && identity.recordId === target.recordId
        ? identity
        : null;
    return { body, identity: currentIdentity };
}

function isCompletedBodyPublishIntent(
    intent: RecordCommitBodyPublishIntent,
    files: RecordCommitBodyArtifactFiles,
): boolean {
    if (intent.desired.bodyHash === null) {
        return files.body === null && files.identity === null;
    }
    return files.body !== null
        && sha256(files.body) === intent.desired.bodyHash
        && sameIdentity(files.identity, intent.desired.identity);
}

function isRecoverableBodyPublishIntentState(
    intent: RecordCommitBodyPublishIntent,
    files: RecordCommitBodyArtifactFiles,
): boolean {
    return files.body === intent.before.body
        && (sameIdentity(files.identity, intent.before.identity)
            || sameIdentity(files.identity, intent.desired.identity));
}

async function compensateAbandonedBodyPublishIntentUnlocked(
    hash: string,
    target: RecordCommitArtifactTarget,
    intent: RecordCommitBodyPublishIntent,
): Promise<void> {
    const files = await readRecordCommitBodyArtifactFiles(hash, target);
    if (!isRecoverableBodyPublishIntentState(intent, files)) {
        throw new Error(`Record commit 正文发布 intent 已损坏，需要 RepairRequired: ${target.conversationId}`);
    }
    const filePath = getRecordPath(hash, target.conversationId);
    const identityPath = getRecordCommitBodyIdentityPath(hash, target.conversationId);
    if (intent.before.identity) {
        await writeJsonAtomicAsync(identityPath, intent.before.identity);
    } else {
        await unlinkIfExists(identityPath);
    }
    if (intent.before.body === null) {
        await unlinkIfExists(filePath);
    } else {
        await writeTextAtomicAsync(filePath, intent.before.body);
    }
    const restored = await readRecordCommitBodyArtifactFiles(hash, target);
    if (!sameBodyArtifactBinding(restored.body, restored.identity, intent.before)) {
        throw new Error(`Record commit 正文发布 intent 补偿后回读不一致，需要 RepairRequired: ${target.conversationId}`);
    }
    await unlinkIfExists(getRecordCommitBodyPublishIntentPath(hash, target.conversationId));
}

async function readRecordCommitBodyArtifactUnlocked(
    hash: string,
    target: RecordCommitArtifactTarget,
): Promise<RecordCommitBodyArtifactImage> {
    const intent = await readRecordCommitBodyPublishIntent(hash, target);
    const files = await readRecordCommitBodyArtifactFiles(hash, target);
    if (!intent) {
        if (files.identity && (files.body === null || sha256(files.body) !== files.identity.bodyHash)) {
            throw new Error(`Record commit 正文 artifact 已损坏，需要 RepairRequired: identity.bodyHash 与正文不一致 (${target.conversationId})`);
        }
        return bodyArtifactImage(files.body, files.identity);
    }
    if (isCompletedBodyPublishIntent(intent, files)) {
        await unlinkIfExists(getRecordCommitBodyPublishIntentPath(hash, target.conversationId));
        return bodyArtifactImage(files.body, files.identity);
    }
    if (!isRecoverableBodyPublishIntentState(intent, files)) {
        throw new Error(`Record commit 正文发布 intent 与已落盘 artifact 不一致，需要 RepairRequired: ${target.conversationId}`);
    }
    return bodyArtifactImage(intent.before.body, intent.before.identity);
}

export async function readRecordCommitBodyArtifact(
    hash: string,
    target: RecordCommitArtifactTarget,
): Promise<RecordCommitBodyArtifactImage> {
    assertRecordCommitTarget(hash, target, "record_body");
    return withRecordCommitArtifactLock(hash, () => readRecordCommitBodyArtifactUnlocked(hash, target));
}

export async function readRecordCommitBodyArtifactLocked(
    hash: string,
    target: RecordCommitArtifactTarget,
): Promise<RecordCommitBodyArtifactImage> {
    assertRecordCommitTarget(hash, target, "record_body");
    return readRecordCommitBodyArtifactUnlocked(hash, target);
}

async function writeRecordCommitBodyArtifactUnlocked(
    hash: string,
    target: RecordCommitArtifactTarget,
    body: string | null,
    identity: RecordCommitArtifactIdentity | null,
    before: RecordCommitBodyArtifactImage,
): Promise<void> {
    const filePath = getRecordPath(hash, target.conversationId);
    const identityPath = getRecordCommitBodyIdentityPath(hash, target.conversationId);
    if (body === null && identity !== null) {
        throw new TypeError("删除 Record 正文时不得保留 commit identity");
    }
    if (body !== null && (!identity || sha256(body) !== identity.bodyHash)) {
        throw new TypeError("非空 Record 正文必须携带匹配 bodyHash 的 commit identity");
    }
    let intent = await readRecordCommitBodyPublishIntent(hash, target);
    if (intent) {
        if (!sameBodyPublishIntentDesired(intent, body, identity)
            || !sameBodyPublishIntentBefore(intent, before)) {
            throw new Error(`Record commit 正文存在其他发布 intent: ${target.conversationId}`);
        }
    } else {
        intent = {
            version: 1,
            target: { conversationId: target.conversationId, recordId: target.recordId },
            desired: { identity: identity ? clone(identity) : null, bodyHash: body === null ? null : sha256(body) },
            before: { body: before.body, identity: before.identity ? clone(before.identity) : null },
        };
        await writeJsonAtomicAsync(getRecordCommitBodyPublishIntentPath(hash, target.conversationId), intent);
    }
    let files = await readRecordCommitBodyArtifactFiles(hash, target);
    if (isCompletedBodyPublishIntent(intent, files)) {
        await unlinkIfExists(getRecordCommitBodyPublishIntentPath(hash, target.conversationId));
        return;
    }
    if (!isRecoverableBodyPublishIntentState(intent, files)) {
        throw new Error(`Record commit 正文发布 intent 恢复前状态不一致: ${target.conversationId}`);
    }
    if (identity) {
        await writeJsonAtomicAsync(identityPath, identity);
    } else {
        await unlinkIfExists(identityPath);
    }
    if (body === null) {
        await unlinkIfExists(filePath);
    } else {
        await writeTextAtomicAsync(filePath, body);
    }
    files = await readRecordCommitBodyArtifactFiles(hash, target);
    if (!isCompletedBodyPublishIntent(intent, files)) {
        throw new Error("Record commit 正文发布后 identity/bodyHash 回读不一致");
    }
    await unlinkIfExists(getRecordCommitBodyPublishIntentPath(hash, target.conversationId));
}

async function validateOwnership(
    callback: RecordCommitOwnershipValidator,
    phase: "before_write" | "after_write",
    target: RecordCommitArtifactTarget,
    identity: RecordCommitArtifactIdentity,
    current: RecordCommitBodyArtifactImage | RecordCommitJsonArtifactImage,
): Promise<boolean> {
    return Boolean(await callback({ phase, target, identity: clone(identity), current: clone(current) }));
}

async function withCommitAuthority<Value>(scope: RecordCommitAuthorityScope | undefined, operation: () => Promise<Value>): Promise<Value> {
    return scope ? scope(operation) : operation();
}

export async function writeRecordCommitBodyConditionally(
    input: WriteRecordCommitBodyConditionallyInput,
): Promise<RecordCommitConditionalMutationResult<RecordCommitBodyArtifactImage>> {
    assertRecordCommitTarget(input.hash, input.target, "record_body", input.identity);
    if (!isRecordCommitArtifactIdentity(input.identity) || sha256(input.body) !== input.identity.bodyHash) {
        throw new TypeError("Record 正文与 commit identity.bodyHash 不匹配");
    }
    return withRecordCommitArtifactLock(input.hash, () => withCommitAuthority(input.withCommitAuthority, async () => {
        const pendingIntent = await readRecordCommitBodyPublishIntent(input.hash, input.target);
        let current = await readRecordCommitBodyArtifactUnlocked(input.hash, input.target);
        if (!await validateOwnership(input.validateOwnership, "before_write", input.target, input.identity, current)) {
            return { kind: "ownership_changed", current };
        }
        const desired = bodyArtifactImage(input.body, input.identity);
        if (sameBodyImage(current, desired)) return { kind: "already_applied", current };
        if (pendingIntent && !sameBodyPublishIntentDesired(pendingIntent, input.body, input.identity)) {
            const activeIntent = await readRecordCommitBodyPublishIntent(input.hash, input.target);
            if (activeIntent) {
                await compensateAbandonedBodyPublishIntentUnlocked(input.hash, input.target, activeIntent);
                current = await readRecordCommitBodyArtifactUnlocked(input.hash, input.target);
            }
        }
        if (!sameBodyImage(current, input.expected)) return { kind: "expected_mismatch", current };
        await writeRecordCommitBodyArtifactUnlocked(input.hash, input.target, input.body, input.identity, current);
        const written = await readRecordCommitBodyArtifactUnlocked(input.hash, input.target);
        if (!sameBodyImage(written, desired)) throw new Error("Record commit 正文回读与条件写入内容不一致");
        if (!await validateOwnership(input.validateOwnership, "after_write", input.target, input.identity, written)) {
            return { kind: "ownership_changed", current: written };
        }
        return { kind: "applied", current: written };
    }));
}

export async function restoreRecordCommitBodyIfOwned(
    input: RestoreRecordCommitBodyIfOwnedInput,
): Promise<RecordCommitConditionalMutationResult<RecordCommitBodyArtifactImage>> {
    assertRecordCommitTarget(input.hash, input.target, "record_body", input.identity);
    return withRecordCommitArtifactLock(input.hash, () => withCommitAuthority(input.withCommitAuthority, async () => {
        const pendingIntent = await readRecordCommitBodyPublishIntent(input.hash, input.target);
        const current = await readRecordCommitBodyArtifactUnlocked(input.hash, input.target);
        if (sameBodyImage(current, input.before)) return { kind: "already_applied", current };
        if (pendingIntent && !sameBodyPublishIntentDesired(pendingIntent, input.before.body, input.before.identity)) {
            return { kind: "expected_mismatch", current };
        }
        if (current.ownerCommitId !== input.identity.commitId
            || current.hash !== input.expectedBodyHash
            || !sameIdentity(current.identity, input.identity)) {
            return { kind: "ownership_changed", current };
        }
        if (!await validateOwnership(input.validateOwnership, "before_write", input.target, input.identity, current)) {
            return { kind: "ownership_changed", current };
        }
        await writeRecordCommitBodyArtifactUnlocked(input.hash, input.target, input.before.body, input.before.identity, current);
        const restored = await readRecordCommitBodyArtifactUnlocked(input.hash, input.target);
        if (!sameBodyImage(restored, input.before)) throw new Error("Record commit 正文 before-image 恢复后回读不一致");
        if (!await validateOwnership(input.validateOwnership, "after_write", input.target, input.identity, restored)) {
            return { kind: "ownership_changed", current: restored };
        }
        return { kind: "applied", current: restored };
    }));
}

function isMainIndexEntry(value: unknown): value is RecordCommitMainIndexEntry {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const entry = value as Partial<RecordCommitMainIndexEntry>;
    return isNonEmptyString(entry.commitId)
        && isNonEmptyString(entry.coveredRevision)
        && isNonEmptyString(entry.conversationId)
        && isNonEmptyString(entry.recordId);
}

async function readRecordCommitMainIndexArtifactUnlocked(
    hash: string,
    target: RecordCommitArtifactTarget,
): Promise<RecordCommitJsonArtifactImage<RecordCommitMainIndexEntry>> {
    const index = await readRecordsIndexAsync(hash);
    const stored = index.records[target.conversationId];
    if (!stored) return emptyJsonArtifactImage<RecordCommitMainIndexEntry>();
    const commitArtifact = stored.commitArtifact;
    if (commitArtifact
        && isRecordCommitArtifactIdentity(commitArtifact.identity)
        && isMainIndexEntry(commitArtifact.mainIndex)
        && commitArtifact.identity.conversationId === target.conversationId
        && commitArtifact.identity.recordId === target.recordId
        && commitArtifact.mainIndex.conversationId === target.conversationId
        && commitArtifact.mainIndex.recordId === target.recordId) {
        return {
            value: clone(commitArtifact.mainIndex),
            hash: hashJson(commitArtifact.mainIndex),
            ownerCommitId: commitArtifact.identity.commitId,
            revision: commitArtifact.identity.coveredRevision,
            identity: clone(commitArtifact.identity),
            storageValue: clone(stored),
        };
    }
    return {
        value: clone(stored) as unknown as RecordCommitMainIndexEntry,
        hash: hashJson(stored),
        ownerCommitId: null,
        revision: null,
        identity: null,
        storageValue: clone(stored),
    };
}

function metadataSnapshotFromRecordIndexEntry(entry: RecordIndexEntry): RecordIndexEntryMetadataSnapshot {
    return {
        conversationId: entry.conversationId,
        title: entry.title,
        timeSpan: entry.timeSpan,
        totalRounds: entry.totalRounds,
        totalSteps: entry.totalSteps,
        lastUpdatedRound: entry.lastUpdatedRound,
        lastUpdatedAt: entry.lastUpdatedAt,
        phases: entry.phases,
        sizeBytes: entry.sizeBytes,
        tags: [...(entry.tags || [])],
        ...(entry.chain ? { chain: entry.chain } : {}),
        ...(Number.isSafeInteger(entry.coveredRevisionSequence) && (entry.coveredRevisionSequence ?? -1) >= 0
            ? { coveredRevisionSequence: entry.coveredRevisionSequence }
            : {}),
    };
}

export function validateRecordCommitMainIndexStorageBinding(
    image: RecordCommitJsonArtifactImage<RecordCommitMainIndexEntry>,
): boolean {
    if (!image.identity || !hasBoundRecordIndexMetadata(image.identity)) return true;
    if (!image.storageValue || typeof image.storageValue !== "object" || Array.isArray(image.storageValue)) return false;
    const stored = image.storageValue as RecordIndexEntry;
    const commitArtifact = stored.commitArtifact;
    if (!commitArtifact
        || !sameIdentity(commitArtifact.identity, image.identity)
        || !sameJsonImage({
            value: commitArtifact.mainIndex,
            hash: hashJson(commitArtifact.mainIndex),
            ownerCommitId: commitArtifact.identity.commitId,
            revision: commitArtifact.identity.coveredRevision,
            identity: commitArtifact.identity,
        }, image)) return false;
    const snapshot = metadataSnapshotFromRecordIndexEntry(stored);
    return canonicalJson(snapshot) === canonicalJson(image.identity.recordIndexMetadata)
        && calculateRecordIndexEntryMetadataHash(snapshot) === image.identity.recordIndexMetadataHash;
}

export async function readRecordCommitMainIndexArtifact(
    hash: string,
    target: RecordCommitArtifactTarget,
): Promise<RecordCommitJsonArtifactImage<RecordCommitMainIndexEntry>> {
    assertRecordCommitTarget(hash, target, "main_index");
    return withRecordCommitArtifactLock(hash, () => readRecordCommitMainIndexArtifactUnlocked(hash, target));
}

export async function readRecordCommitMainIndexArtifactLocked(
    hash: string,
    target: RecordCommitArtifactTarget,
): Promise<RecordCommitJsonArtifactImage<RecordCommitMainIndexEntry>> {
    assertRecordCommitTarget(hash, target, "main_index");
    return readRecordCommitMainIndexArtifactUnlocked(hash, target);
}

function recordIndexEntryForCommit(
    target: RecordCommitArtifactTarget,
    identity: RecordCommitArtifactIdentity,
    entry: RecordCommitMainIndexEntry,
    existing: RecordIndexEntry | undefined,
    body: string,
    meta: Partial<RecordIndexEntry> | undefined,
): RecordIndexEntry {
    if (hasBoundRecordIndexMetadata(identity)) {
        const snapshot = identity.recordIndexMetadata;
        if (snapshot.conversationId !== target.conversationId || snapshot.sizeBytes !== Buffer.byteLength(body, "utf8")) {
            throw new TypeError("Record commit identity metadata snapshot 与主索引 target/body 不匹配");
        }
        return {
            conversationId: snapshot.conversationId,
            title: snapshot.title,
            timeSpan: snapshot.timeSpan,
            totalRounds: snapshot.totalRounds,
            totalSteps: snapshot.totalSteps,
            lastUpdatedRound: snapshot.lastUpdatedRound,
            lastUpdatedAt: snapshot.lastUpdatedAt,
            phases: snapshot.phases,
            sizeBytes: snapshot.sizeBytes,
            tags: [...snapshot.tags],
            ...(snapshot.chain ? { chain: snapshot.chain } : {}),
            ...(Number.isSafeInteger(snapshot.coveredRevisionSequence) && (snapshot.coveredRevisionSequence ?? -1) >= 0
                ? { coveredRevisionSequence: snapshot.coveredRevisionSequence }
                : {}),
            commitArtifact: {
                identity: clone(identity),
                mainIndex: clone(entry),
            },
        };
    }
    return {
        conversationId: target.conversationId,
        title: meta?.title || existing?.title || "Untitled",
        timeSpan: meta?.timeSpan || existing?.timeSpan || "",
        totalRounds: meta?.totalRounds ?? existing?.totalRounds ?? 0,
        totalSteps: meta?.totalSteps ?? existing?.totalSteps ?? 0,
        lastUpdatedRound: meta?.lastUpdatedRound ?? existing?.lastUpdatedRound ?? 0,
        lastUpdatedAt: meta?.lastUpdatedAt || new Date().toISOString(),
        phases: meta?.phases ?? existing?.phases ?? 0,
        sizeBytes: Buffer.byteLength(body, "utf8"),
        tags: meta?.tags || existing?.tags || [],
        chain: meta?.chain || existing?.chain,
        ...(Number.isSafeInteger(meta?.coveredRevisionSequence) && (meta?.coveredRevisionSequence ?? -1) >= 0
            ? { coveredRevisionSequence: meta!.coveredRevisionSequence }
            : {}),
        commitArtifact: {
            identity: clone(identity),
            mainIndex: clone(entry),
        },
    };
}

export async function writeRecordCommitMainIndexConditionally(
    input: WriteRecordCommitMainIndexConditionallyInput,
): Promise<RecordCommitConditionalMutationResult<RecordCommitJsonArtifactImage<RecordCommitMainIndexEntry>>> {
    assertRecordCommitTarget(input.hash, input.target, "main_index", input.identity);
    if (!isRecordCommitArtifactIdentity(input.identity)
        || !isMainIndexEntry(input.entry)
        || input.entry.commitId !== input.identity.commitId
        || input.entry.coveredRevision !== input.identity.coveredRevision
        || input.entry.conversationId !== input.identity.conversationId
        || input.entry.recordId !== input.identity.recordId) {
        throw new TypeError("Record 主索引 entry 与 commit identity 不匹配");
    }
    return withRecordCommitArtifactLock(input.hash, () => withCommitAuthority(input.withCommitAuthority, async () => {
        const bodyTarget: RecordCommitArtifactTarget = {
            kind: "record_body",
            conversationId: input.target.conversationId,
            recordId: input.target.recordId,
            relativePath: expectedRelativePath("record_body", input.target.conversationId),
        };
        const body = await readRecordCommitBodyArtifactUnlocked(input.hash, bodyTarget);
        if (body.body === null || body.hash !== input.identity.bodyHash || !sameIdentity(body.identity, input.identity)) {
            throw new TypeError("Record 主索引写入前正文 identity/bodyHash 不匹配");
        }
        const current = await readRecordCommitMainIndexArtifactUnlocked(input.hash, input.target);
        if (!await validateOwnership(input.validateOwnership, "before_write", input.target, input.identity, current)) {
            return { kind: "ownership_changed", current };
        }
        const desired: RecordCommitJsonArtifactImage<RecordCommitMainIndexEntry> = {
            value: clone(input.entry),
            hash: hashJson(input.entry),
            ownerCommitId: input.identity.commitId,
            revision: input.identity.coveredRevision,
            identity: clone(input.identity),
        };
        if (sameJsonImage(current, desired)) return { kind: "already_applied", current };
        if (!sameJsonImage(current, input.expected)) return { kind: "expected_mismatch", current };
        const index = await readRecordsIndexAsync(input.hash);
        index.records[input.target.conversationId] = recordIndexEntryForCommit(
            input.target,
            input.identity,
            input.entry,
            index.records[input.target.conversationId],
            body.body,
            input.recordMeta,
        );
        await writeJsonAtomicAsync(getRecordsIndexPath(input.hash), index);
        const written = await readRecordCommitMainIndexArtifactUnlocked(input.hash, input.target);
        if (!sameJsonImage(written, desired)) throw new Error("Record commit 主索引回读与条件写入内容不一致");
        if (!validateRecordCommitMainIndexStorageBinding(written)) {
            throw new Error("Record commit 主索引完整 storage value 与 metadata snapshot 不一致");
        }
        if (!await validateOwnership(input.validateOwnership, "after_write", input.target, input.identity, written)) {
            return { kind: "ownership_changed", current: written };
        }
        return { kind: "applied", current: written };
    }));
}

export async function restoreRecordCommitMainIndexIfOwned(
    input: RestoreRecordCommitMainIndexIfOwnedInput,
): Promise<RecordCommitConditionalMutationResult<RecordCommitJsonArtifactImage<RecordCommitMainIndexEntry>>> {
    assertRecordCommitTarget(input.hash, input.target, "main_index", input.identity);
    return withRecordCommitArtifactLock(input.hash, () => withCommitAuthority(input.withCommitAuthority, async () => {
        const current = await readRecordCommitMainIndexArtifactUnlocked(input.hash, input.target);
        if (sameJsonImage(current, input.before)) return { kind: "already_applied", current };
        if (current.ownerCommitId !== input.identity.commitId
            || current.hash !== input.expectedEntryHash
            || !sameIdentity(current.identity, input.identity)) {
            return { kind: "ownership_changed", current };
        }
        if (!await validateOwnership(input.validateOwnership, "before_write", input.target, input.identity, current)) {
            return { kind: "ownership_changed", current };
        }
        const index = await readRecordsIndexAsync(input.hash);
        if (input.before.value === null) {
            delete index.records[input.target.conversationId];
        } else {
            const storageValue = input.before.storageValue ?? input.before.value;
            if (!storageValue || typeof storageValue !== "object" || Array.isArray(storageValue)
                || (storageValue as Partial<RecordIndexEntry>).conversationId !== input.target.conversationId) {
                throw new TypeError("Record 主索引 before-image 无法安全恢复到当前 conversation");
            }
            index.records[input.target.conversationId] = clone(storageValue) as RecordIndexEntry;
        }
        await writeJsonAtomicAsync(getRecordsIndexPath(input.hash), index);
        const restored = await readRecordCommitMainIndexArtifactUnlocked(input.hash, input.target);
        if (!sameJsonImage(restored, input.before)) throw new Error("Record commit 主索引 before-image 恢复后回读不一致");
        if (!await validateOwnership(input.validateOwnership, "after_write", input.target, input.identity, restored)) {
            return { kind: "ownership_changed", current: restored };
        }
        return { kind: "applied", current: restored };
    }));
}

/**
 * 写入 Record 文件 + 更新索引
 */
export async function writeRecord(
    hash: string,
    conversationId: string,
    content: string,
    meta: Partial<RecordIndexEntry>,
    options: WriteRecordOptions = {},
): Promise<RecordIndexWriteResult> {
    return withRecordCommitArtifactLock(hash, () => writeRecordWithCommitArtifactLockHeld(
        hash,
        conversationId,
        content,
        meta,
        options,
    ));
}

export async function writeRecordWithCommitArtifactLockHeld(
    hash: string,
    conversationId: string,
    content: string,
    meta: Partial<RecordIndexEntry>,
    options: WriteRecordOptions = {},
): Promise<RecordIndexWriteResult> {
    await ensureRecordsDirAsync(hash);
    const target: RecordCommitArtifactTarget = {
        kind: "record_body",
        conversationId,
        recordId: conversationId,
        relativePath: getRecordCommitArtifactRelativePath("record_body", conversationId),
    };
    const pendingIntent = await readRecordCommitBodyPublishIntent(hash, target);
    if (pendingIntent) {
        const files = await readRecordCommitBodyArtifactFiles(hash, target);
        if (isCompletedBodyPublishIntent(pendingIntent, files)) {
            await unlinkIfExists(getRecordCommitBodyPublishIntentPath(hash, conversationId));
        } else {
            await compensateAbandonedBodyPublishIntentUnlocked(hash, target, pendingIntent);
        }
    }
    await unlinkIfExists(getRecordCommitBodyIdentityPath(hash, conversationId));
    await deleteRecordSidecar(hash, conversationId, "record_index.json");
    const filePath = getRecordPath(hash, conversationId);
    await writeTextAtomicAsync(filePath, content);
    await options.afterContentWrite?.();
    return upsertRecordIndex(hash, conversationId, content, meta);
}

export async function upsertRecordIndex(
    hash: string,
    conversationId: string,
    content: string,
    meta: Partial<RecordIndexEntry>,
): Promise<RecordIndexWriteResult> {
    await ensureRecordsDirAsync(hash);
    // 更新索引（read-modify-write 必须在锁内原子执行，防并发互相覆盖导致 list 延迟丢失条目）
    return withIndexLock(`records_${hash}`, async () => {
        const index = await readRecordsIndexAsync(hash);
        const existing = index.records[conversationId];
        const entry: RecordIndexEntry = {
            conversationId,
            title: meta.title || existing?.title || "Untitled",
            timeSpan: meta.timeSpan || existing?.timeSpan || "",
            totalRounds: meta.totalRounds ?? existing?.totalRounds ?? 0,
            totalSteps: meta.totalSteps ?? existing?.totalSteps ?? 0,
            lastUpdatedRound: meta.lastUpdatedRound ?? existing?.lastUpdatedRound ?? 0,
            lastUpdatedAt: new Date().toISOString(),
            phases: meta.phases ?? existing?.phases ?? 0,
            sizeBytes: Buffer.byteLength(content, "utf-8"),
            tags: meta.tags || existing?.tags || [],
            chain: meta.chain || existing?.chain,
        };
        index.records[conversationId] = entry;
        await writeJsonAtomicAsync(getRecordsIndexPath(hash), index);
        return {
            entry,
            outcome: existing ? "updated" : "created",
        };
    });
}

/**
 * 复制 Record 到另一个 hash，尽量保留原索引元数据。
 * 用于归属修复的非破坏 copy/upsert；不会删除来源副本。
 */
export async function copyRecordToHash(
    sourceHash: string,
    targetHash: string,
    conversationId: string,
    metaPatch: Partial<RecordIndexEntry> = {},
    options: { backup?: boolean } = {},
): Promise<boolean> {
    const content = await readRecordAsync(sourceHash, conversationId);
    if (!content) return false;

    if (options.backup !== false) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backupDir = path.join(DATA_ROOT, "record-ownership-backups", `${stamp}_${conversationId.slice(0, 8)}_${sourceHash}_to_${targetHash}`);
        await fs.promises.mkdir(backupDir, { recursive: true });
        const sourcePath = getRecordPath(sourceHash, conversationId);
        const targetPath = getRecordPath(targetHash, conversationId);
        const sourceIndexPath = getRecordsIndexPath(sourceHash);
        const targetIndexPath = getRecordsIndexPath(targetHash);
        await Promise.all([
            copyFileIfExists(sourcePath, path.join(backupDir, `${sourceHash}_${conversationId}.md`)),
            copyFileIfExists(targetPath, path.join(backupDir, `${targetHash}_${conversationId}.md`)),
            copyFileIfExists(sourceIndexPath, path.join(backupDir, `${sourceHash}_records_index.json`)),
            copyFileIfExists(targetIndexPath, path.join(backupDir, `${targetHash}_records_index.json`)),
        ]);
    }

    await ensureRecordsDirAsync(targetHash);
    await writeTextAtomicAsync(getRecordPath(targetHash, conversationId), content);

    const sourceEntry = (await readRecordsIndexAsync(sourceHash)).records[conversationId];
    await withIndexLock(`records_${targetHash}`, async () => {
        const targetIndex = await readRecordsIndexAsync(targetHash);
        const existing = targetIndex.records[conversationId] || {};
        const entry: RecordIndexEntry = {
            conversationId,
            title: metaPatch.title || sourceEntry?.title || existing.title || "Untitled",
            timeSpan: metaPatch.timeSpan || sourceEntry?.timeSpan || existing.timeSpan || "",
            totalRounds: metaPatch.totalRounds ?? sourceEntry?.totalRounds ?? existing.totalRounds ?? 0,
            totalSteps: metaPatch.totalSteps ?? sourceEntry?.totalSteps ?? existing.totalSteps ?? 0,
            lastUpdatedRound: metaPatch.lastUpdatedRound ?? sourceEntry?.lastUpdatedRound ?? existing.lastUpdatedRound ?? 0,
            lastUpdatedAt: metaPatch.lastUpdatedAt || sourceEntry?.lastUpdatedAt || existing.lastUpdatedAt || new Date().toISOString(),
            phases: metaPatch.phases ?? sourceEntry?.phases ?? existing.phases ?? 0,
            sizeBytes: Buffer.byteLength(content, "utf-8"),
            tags: metaPatch.tags || sourceEntry?.tags || existing.tags || [],
            chain: metaPatch.chain || sourceEntry?.chain || existing.chain,
        };
        targetIndex.records[conversationId] = entry;
        await writeJsonAtomicAsync(getRecordsIndexPath(targetHash), targetIndex);
    });
    return true;
}

/**
 * 删除 Record 文件 + 更新索引
 */
export async function deleteRecord(hash: string, conversationId: string): Promise<boolean> {
    return withRecordCommitArtifactLock(hash, () => deleteRecordWithCommitArtifactLockHeld(hash, conversationId));
}

export async function deleteRecordWithCommitArtifactLockHeld(hash: string, conversationId: string): Promise<boolean> {
    const filePath = getRecordPath(hash, conversationId);
    if (!await unlinkIfExists(filePath)) return false;
    const sidecarPrefix = path.join(getRecordsDir(hash), `${conversationId}.`);
    let recordFiles: string[];
    try {
        recordFiles = await fs.promises.readdir(getRecordsDir(hash));
    } catch (error) {
        if (isNotFoundError(error)) recordFiles = [];
        else throw error;
    }
    await Promise.all(recordFiles.map(async (item) => {
        const itemPath = path.join(getRecordsDir(hash), item);
        if (itemPath.startsWith(sidecarPrefix) && itemPath !== filePath) {
            try { await fs.promises.unlink(itemPath); } catch {}
        }
    }));

    // 更新索引（read-modify-write 在锁内原子执行）
    await withIndexLock(`records_${hash}`, async () => {
        const index = await readRecordsIndexAsync(hash);
        delete index.records[conversationId];
        await writeJsonAtomicAsync(getRecordsIndexPath(hash), index);
    });
    return true;
}

/**
 * 列出工作区下所有 Record 概览
 */
export function listRecords(hash: string): RecordIndexEntry[] {
    const index = readRecordsIndex(hash);
    return Object.values(index.records).sort(
        (a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime()
    );
}

/**
 * 在 Record 中搜索关键词（grep 模式）
 * @returns 匹配结果数组
 */
export function searchRecords(
    query: string,
    hash: string,
): { conversationId: string; title: string; matches: { lineNum: number; line: string; context: string }[] }[] {
    const index = readRecordsIndex(hash);
    const results: ReturnType<typeof searchRecords> = [];
    const queryLower = query.toLowerCase();

    for (const [convId, entry] of Object.entries(index.records)) {
        const content = readRecord(hash, convId);
        if (!content) continue;

        const lines = content.split(/\r?\n/);
        const matches: { lineNum: number; line: string; context: string }[] = [];

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(queryLower)) {
                // 前后各 2 行上下文
                const ctxStart = Math.max(0, i - 2);
                const ctxEnd = Math.min(lines.length - 1, i + 2);
                const context = lines.slice(ctxStart, ctxEnd + 1).join("\n");
                matches.push({ lineNum: i + 1, line: lines[i], context });
            }
        }

        if (matches.length > 0) {
            results.push({ conversationId: convId, title: entry.title, matches });
        }
    }

    // 按匹配数降序
    results.sort((a, b) => b.matches.length - a.matches.length);
    return results;
}

/**
 * 搜索所有工作区的 Record（全局搜索）
 */
export function searchRecordsGlobal(
    query: string,
): { hash: string; conversationId: string; title: string; matchCount: number }[] {
    const results: ReturnType<typeof searchRecordsGlobal> = [];

    // general
    const generalResults = searchRecords(query, "general");
    for (const r of generalResults) {
        results.push({ hash: "general", conversationId: r.conversationId, title: r.title, matchCount: r.matches.length });
    }

    // 所有工作区
    const wsDir = WORKSPACES_DIR;
    if (fs.existsSync(wsDir)) {
        for (const h of fs.readdirSync(wsDir)) {
            if (!fs.statSync(path.join(wsDir, h)).isDirectory()) continue;
            const wsResults = searchRecords(query, h);
            for (const r of wsResults) {
                results.push({ hash: h, conversationId: r.conversationId, title: r.title, matchCount: r.matches.length });
            }
        }
    }

    results.sort((a, b) => b.matchCount - a.matchCount);
    return results;
}

/**
 * 统计工作区 Record 数量
 */
export function countRecords(hash: string): number {
    const index = readRecordsIndex(hash);
    return Object.keys(index.records).length;
}

/**
 * 解析工作区路径得到 hash（兼容 workspace 参数）
 * 如果传入的是已有工作区路径，返回 hash；否则返回 null
 */
export function resolveWorkspaceHashForRecord(workspace?: string): string {
    if (!workspace) return "general";
    return findWorkspaceHash(workspace) || workspaceHash(workspace);
}

/**
 * 查找某个 conversationId 的 Record 存在于哪个 hash 下
 * 遍历所有工作区+general 的 records 索引；同一对话多处存在时返回最新版本。
 */
export function findRecordHash(conversationId: string): string | null {
    let best: { hash: string; updatedAt: number; coveredRounds: number; sizeBytes: number } | null = null;
    const hashes = ["general", ...listWorkspaceHashes()];

    for (const hash of hashes) {
        const idx = readRecordsIndex(hash);
        const entry = idx.records[conversationId];
        if (!entry) continue;
        const updatedAt = Date.parse(entry.lastUpdatedAt || "") || 0;
        const coveredRounds = entry.lastUpdatedRound || entry.totalRounds || 0;
        const sizeBytes = entry.sizeBytes || 0;
        if (
            !best ||
            coveredRounds > best.coveredRounds ||
            (coveredRounds === best.coveredRounds && updatedAt > best.updatedAt) ||
            (coveredRounds === best.coveredRounds && updatedAt === best.updatedAt && sizeBytes > best.sizeBytes)
        ) {
            best = { hash, updatedAt, coveredRounds, sizeBytes };
        }
    }

    return best?.hash || null;
}

export async function findRecordHashAsync(conversationId: string): Promise<string | null> {
    let best: { hash: string; updatedAt: number; coveredRounds: number; sizeBytes: number } | null = null;
    const hashes = ["general", ...await listWorkspaceHashesAsync()];
    const indexes = await Promise.all(hashes.map(async hash => ({ hash, index: await readRecordsIndexAsync(hash) })));

    for (const { hash, index } of indexes) {
        const entry = index.records[conversationId];
        if (!entry) continue;
        const updatedAt = Date.parse(entry.lastUpdatedAt || "") || 0;
        const coveredRounds = entry.lastUpdatedRound || entry.totalRounds || 0;
        const sizeBytes = entry.sizeBytes || 0;
        if (
            !best ||
            coveredRounds > best.coveredRounds ||
            (coveredRounds === best.coveredRounds && updatedAt > best.updatedAt) ||
            (coveredRounds === best.coveredRounds && updatedAt === best.updatedAt && sizeBytes > best.sizeBytes)
        ) {
            best = { hash, updatedAt, coveredRounds, sizeBytes };
        }
    }

    return best?.hash || null;
}

/**
 * 解析 Record conversationId。支持完整 ID、唯一前缀，以及标题精确匹配。
 */
export function resolveRecordConversationId(input: string, preferredHash?: string): string | null {
    const query = input.trim();
    if (!query) return null;
    const queryLower = query.toLowerCase();
    const hashes = [
        ...(preferredHash ? [preferredHash] : []),
        "general",
        ...listWorkspaceHashes(),
    ].filter((hash, index, arr) => hash && arr.indexOf(hash) === index);

    const entries: RecordIndexEntry[] = [];
    for (const hash of hashes) {
        const idx = readRecordsIndex(hash);
        entries.push(...Object.values(idx.records));
    }

    const exact = entries.find((entry) => entry.conversationId === query);
    if (exact) return exact.conversationId;

    const prefixMatches = entries.filter((entry) => entry.conversationId.startsWith(query));
    if (prefixMatches.length === 1) return prefixMatches[0].conversationId;

    const titleMatches = entries.filter((entry) => entry.title.toLowerCase() === queryLower);
    if (titleMatches.length === 1) return titleMatches[0].conversationId;

    return null;
}

/**
 * 模糊搜索 Record（Fuse.js）
 * 搜索字段：conversationId 前8位、title、tags、正文前500字
 */
export function fuzzySearchRecords(
    query: string,
    hash: string,
    limit = 10,
): { conversationId: string; title: string; tags: string[]; score: number; preview: string }[] {
    const index = readRecordsIndex(hash);
    const entries = Object.values(index.records).map(rec => {
        const content = readRecord(hash, rec.conversationId);
        return {
            id: rec.conversationId,
            shortId: rec.conversationId.slice(0, 8),
            title: rec.title,
            tagsStr: (rec.tags || []).join(" "),
            preview: (content || "").slice(0, 500),
            tags: rec.tags || [],
        };
    });

    if (entries.length === 0) return [];

    const fuse = new Fuse(entries, {
        keys: [
            { name: "shortId", weight: 0.1 },
            { name: "title", weight: 0.3 },
            { name: "tagsStr", weight: 0.4 },
            { name: "preview", weight: 0.2 },
        ],
        threshold: 0.4,
        includeScore: true,
    });

    const results = fuse.search(query, { limit });
    return results.map((r: any) => ({
        conversationId: r.item.id,
        title: r.item.title,
        tags: r.item.tags,
        score: r.score ?? 1,
        preview: r.item.preview.slice(0, 100),
    }));
}
