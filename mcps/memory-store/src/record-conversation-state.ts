import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DATA_ROOT } from "./store.js";
import { SOURCE_CHAINS, type SourceChain } from "./record-scheduler-contracts.js";

export const RECORD_CONVERSATION_STATE_SCHEMA_VERSION = 1 as const;
export const RECORD_CONVERSATION_STATE_FILE_NAME = "record-conversation-state.json";
export const DEFAULT_RECORD_CONVERSATION_STATE_LOCK_WAIT_MS = 10_000;
export const DEFAULT_RECORD_CONVERSATION_STATE_LOCK_LEASE_MS = 60_000;
export const RECORD_CONVERSATION_STATE_NOFOLLOW_MODE = process.platform === "win32"
    ? "windows_fd_and_final_path_identity_verification"
    : "posix_o_nofollow_and_fd_identity_verification";

const LOCK_RETRY_DELAY_MS = 8;
const LOCK_RECLAIM_RETRY_LIMIT = 3;
const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const ROOT_BINDING_FIELDS = ["requestedDataRoot", "realDataRoot", "rootIdentity"] as const;
const INDEX_FIELDS = ["schemaVersion", "kind", "initialized", "revision", "rootBinding", "entries", "keysByConversationId", "createdAt", "updatedAt", "persistedHash"] as const;
const ENTRY_FIELDS = ["chain", "workspaceHash", "conversationId", "entryRevision", "workspace", "titleBestEffort", "latestObservedRevision", "latestEvidenceHash", "lastCompleteScanId", "recordCoveredRevision", "recordBodyHash", "state", "evidence", "stateReason", "activeTaskIds", "recordWorkKey", "pendingRefreshKey", "sourceObservedAt", "updatedAt"] as const;
const PATCH_FIELDS = ["workspace", "titleBestEffort", "latestObservedRevision", "latestEvidenceHash", "lastCompleteScanId", "recordCoveredRevision", "recordBodyHash", "state", "evidence", "stateReason", "activeTaskIds", "recordWorkKey", "pendingRefreshKey", "sourceObservedAt"] as const;
const EVIDENCE_FIELDS = ["source", "complete", "observedAt", "evidenceHash", "scanId", "details"] as const;
const AUTHORITY_FIELDS = ["kind", "snapshotId", "capturedAt", "rootBinding", "authorityRevision", "authorityRef", "authorityHash", "recordIndex", "schedulerLedgers", "workRegistry", "recentCompleteEvidence"] as const;

export type ConversationState = "Fresh" | "Stale" | "Missing" | "Unresolved" | "Lost" | "Conflict";
export type ConversationStateDurabilityMode = "posix_file_and_directory_fsync" | "windows_process_crash_atomic_replace";

export interface ConversationStateIdentity {
    chain: SourceChain;
    workspaceHash: string;
    conversationId: string;
}

export interface ConversationStateEvidence {
    source: string;
    complete: boolean;
    observedAt: string;
    evidenceHash?: string;
    scanId?: string;
    details?: Record<string, unknown>;
}

export interface ConversationStateEntry extends ConversationStateIdentity {
    entryRevision: number;
    workspace: string | null;
    titleBestEffort: string | null;
    latestObservedRevision: string | null;
    latestEvidenceHash: string | null;
    lastCompleteScanId: string | null;
    recordCoveredRevision: string | null;
    recordBodyHash: string | null;
    state: ConversationState;
    evidence: ConversationStateEvidence[];
    stateReason: string | null;
    activeTaskIds: string[];
    recordWorkKey: string | null;
    pendingRefreshKey: string | null;
    sourceObservedAt: string | null;
    updatedAt: string;
}

export interface ConversationStateRootBinding {
    requestedDataRoot: string;
    realDataRoot: string;
    rootIdentity: string;
}

export interface RecordConversationStateIndex {
    schemaVersion: typeof RECORD_CONVERSATION_STATE_SCHEMA_VERSION;
    kind: "record-conversation-state-index";
    initialized: true;
    revision: number;
    rootBinding: ConversationStateRootBinding;
    entries: Record<string, ConversationStateEntry>;
    keysByConversationId: Record<string, string[]>;
    createdAt: string;
    updatedAt: string;
    persistedHash: string;
}

export interface ConversationStateStoreOptions {
    dataRoot?: string;
    lockWaitMs?: number;
    lockLeaseMs?: number;
    lockHeartbeatMs?: number | false;
}

export interface ConversationStateStorePaths {
    dataRoot: string;
    statePath: string;
    lockPath: string;
}

export interface ConversationStateDurabilityReceipt {
    mode: ConversationStateDurabilityMode;
    temporaryFileSynced: true;
    targetFileSynced: true;
    targetReadBackVerified: true;
    atomicReplace: true;
    parentDirectoryFsync: boolean;
    suddenPowerLossDurabilityClaimed: boolean;
}

export interface ConversationStateCurrentRead {
    kind: "current";
    paths: ConversationStateStorePaths;
    index: RecordConversationStateIndex;
    receipt: ConversationStateDurabilityReceipt;
}

export interface ConversationStateMissingRead {
    kind: "missing";
    paths: ConversationStateStorePaths;
}

export interface ConversationStateCorruptRead {
    kind: "corrupt";
    paths: ConversationStateStorePaths;
    reason: "invalid_json" | "invalid_schema" | "hash_mismatch";
    detail: string;
}

export type ConversationStateReadResult = ConversationStateCurrentRead | ConversationStateMissingRead | ConversationStateCorruptRead;

export interface ConversationStateFirstInstallAuthority {
    kind: "first-install";
    authorityId: string;
    observedAt: string;
}

export interface InitializeConversationStateStoreInput extends ConversationStateStoreOptions {
    authority: ConversationStateFirstInstallAuthority;
    nowMs?: number;
}

export interface ConversationStateRecordIndexSnapshot {
    identity: ConversationStateIdentity;
    workspace?: string | null;
    titleBestEffort?: string | null;
    recordCoveredRevision: string | null;
    recordBodyHash?: string | null;
    observedAt?: string;
}

export interface ConversationStateSchedulerLedgerSnapshot {
    identity: ConversationStateIdentity;
    taskId: string;
    active: boolean;
    recordWorkKey?: string | null;
    pendingRefreshKey?: string | null;
    observedAt?: string;
}

export interface ConversationStateWorkRegistrySnapshot {
    identity: ConversationStateIdentity;
    activeTaskIds: string[];
    recordWorkKey?: string | null;
    pendingRefreshKey?: string | null;
    observedAt?: string;
}

export interface ConversationStateCompleteEvidenceSnapshot {
    identity: ConversationStateIdentity;
    latestObservedRevision: string;
    state: ConversationState;
    evidence: ConversationStateEvidence;
    workspace?: string | null;
    titleBestEffort?: string | null;
    observedAt?: string;
}

export interface ConversationStateAuthoritySnapshots {
    kind: "record-conversation-state-authority-snapshots";
    snapshotId: string;
    capturedAt: string;
    rootBinding: ConversationStateRootBinding;
    authorityRevision: number;
    authorityRef: string;
    authorityHash: string;
    recordIndex: ReadonlyArray<ConversationStateRecordIndexSnapshot>;
    schedulerLedgers: ReadonlyArray<ConversationStateSchedulerLedgerSnapshot>;
    workRegistry: ReadonlyArray<ConversationStateWorkRegistrySnapshot>;
    recentCompleteEvidence: ReadonlyArray<ConversationStateCompleteEvidenceSnapshot>;
}

export interface RepairConversationStateStoreInput extends ConversationStateStoreOptions {
    authority: ConversationStateAuthoritySnapshots;
    nowMs?: number;
}

export interface ConversationStatePatch {
    workspace?: string | null;
    titleBestEffort?: string | null;
    latestObservedRevision?: string | null;
    latestEvidenceHash?: string | null;
    lastCompleteScanId?: string | null;
    recordCoveredRevision?: string | null;
    recordBodyHash?: string | null;
    state?: ConversationState;
    evidence?: ConversationStateEvidence[];
    stateReason?: string | null;
    activeTaskIds?: string[];
    recordWorkKey?: string | null;
    pendingRefreshKey?: string | null;
    sourceObservedAt?: string | null;
}

export interface UpsertConversationStateInput extends ConversationStateStoreOptions {
    identity: ConversationStateIdentity;
    patch: ConversationStatePatch;
    expectedEntryRevision?: number | null;
    nowMs?: number;
}

export interface ConversationStateUpdated {
    kind: "updated";
    paths: ConversationStateStorePaths;
    indexRevision: number;
    entry: ConversationStateEntry;
    receipt: ConversationStateDurabilityReceipt;
}

export interface ConversationStateConflict {
    kind: "conflict";
    paths: ConversationStateStorePaths;
    expectedEntryRevision: number | null;
    actualEntryRevision: number | null;
    indexRevision: number;
    entry: ConversationStateEntry | null;
}

export type UpsertConversationStateResult = ConversationStateUpdated | ConversationStateConflict;

export class ConversationStateStoreError extends Error {
    readonly code: string;

    constructor(message: string, code: string) {
        super(message);
        this.name = "ConversationStateStoreError";
        this.code = code;
    }
}

export class ConversationStateRepairRequiredError extends ConversationStateStoreError {
    constructor(message: string) {
        super(message, "REPAIR_REQUIRED");
        this.name = "ConversationStateRepairRequiredError";
    }
}

export class ConversationStatePathSafetyError extends ConversationStateStoreError {
    constructor(message: string) {
        super(message, "PATH_SAFETY");
        this.name = "ConversationStatePathSafetyError";
    }
}

class ConversationStateSnapshotRaceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConversationStateSnapshotRaceError";
    }
}

export class ConversationStateLockTimeoutError extends ConversationStateStoreError {
    constructor(message: string) {
        super(message, "LOCK_TIMEOUT");
        this.name = "ConversationStateLockTimeoutError";
    }
}

export class ConversationStateLockFencedError extends ConversationStateStoreError {
    constructor(message: string) {
        super(message, "LOCK_FENCED");
        this.name = "ConversationStateLockFencedError";
    }
}

export type ConversationStateLockTestPhase = "after-acquire" | "before-heartbeat" | "before-publish-fence" | "after-publish-fence" | "stale-observed" | "before-stale-rename" | "stale-quarantined" | "before-release";

export interface ConversationStateLockTestContext {
    phase: ConversationStateLockTestPhase;
    lockPath: string;
    token: string;
    fencingToken: string;
    nowMs: number;
}

export interface ConversationStateLockTestControl {
    nowMs?: () => number;
    onPhase?: (context: ConversationStateLockTestContext) => void | Promise<void>;
}

export type ConversationStatePathSafetyTestPhase = "after-open-before-path-verify";

export interface ConversationStatePathSafetyTestContext {
    phase: ConversationStatePathSafetyTestPhase;
    filePath: string;
    label: string;
}

export type ConversationStatePathSafetyTestHook = (context: ConversationStatePathSafetyTestContext) => void | Promise<void>;

interface SafePaths extends ConversationStateStorePaths {
    rootBinding: ConversationStateRootBinding;
}

interface ConversationStateFileLock {
    token: string;
    fencingToken: string;
    renewForPublish: () => Promise<void>;
    assertOwned: () => Promise<void>;
    release: () => Promise<void>;
}

interface LockMetadata {
    schemaVersion: 1;
    kind: "record-conversation-state-lock";
    token: string;
    fencingToken: string;
    ownerPid: number;
    acquiredAt: string;
    heartbeatAt: string;
    expiresAt: string;
    rootIdentity: string;
}

interface VerifiedFileSnapshot {
    content: string;
    identity: string;
    size: number;
    mtimeMs: number;
    contentHash: string;
}

let lockTestControl: ConversationStateLockTestControl | undefined;
let pathSafetyTestHook: ConversationStatePathSafetyTestHook | undefined;

export function setRecordConversationStateLockTestControlForTest(control?: ConversationStateLockTestControl): void {
    lockTestControl = control;
}

export function setRecordConversationStatePathSafetyTestHookForTest(hook?: ConversationStatePathSafetyTestHook): void {
    pathSafetyTestHook = hook;
}

interface RebuildDraft extends Omit<ConversationStateEntry, "entryRevision" | "updatedAt"> {
    observedAtMs: number;
    contentHashesByRevision: Map<string, Set<string>>;
}

export function canonicalConversationStateKey(identity: ConversationStateIdentity): string {
    assertIdentity(identity);
    const { chain, workspaceHash, conversationId } = identity;
    return createHash("sha256")
        .update(JSON.stringify({ kind: "record-conversation-state-canonical-key-v1", chain, workspaceHash, conversationId }))
        .digest("hex");
}

export function recordConversationStatePath(options: ConversationStateStoreOptions = {}): string {
    return path.join(resolveDataRoot(options), RECORD_CONVERSATION_STATE_FILE_NAME);
}

export function recordConversationStateLockPath(options: ConversationStateStoreOptions = {}): string {
    return `${recordConversationStatePath(options)}.lock`;
}

export async function resolveRecordConversationStateRootBinding(
    options: ConversationStateStoreOptions = {},
): Promise<ConversationStateRootBinding> {
    const paths = await resolveSafePaths(options);
    return { ...paths.rootBinding };
}

export function recordConversationStateDurabilityProfile(): ConversationStateDurabilityReceipt {
    const isWindows = process.platform === "win32";
    return {
        mode: isWindows ? "windows_process_crash_atomic_replace" : "posix_file_and_directory_fsync",
        temporaryFileSynced: true,
        targetFileSynced: true,
        targetReadBackVerified: true,
        atomicReplace: true,
        parentDirectoryFsync: !isWindows,
        suddenPowerLossDurabilityClaimed: !isWindows,
    };
}

export function calculateRecordConversationStateHash(index: Omit<RecordConversationStateIndex, "persistedHash"> | RecordConversationStateIndex): string {
    const serializable = { ...index } as Record<string, unknown>;
    delete serializable.persistedHash;
    return createHash("sha256").update(stableJson(serializable)).digest("hex");
}

export function calculateRecordConversationStateAuthorityHash(
    authority: Omit<ConversationStateAuthoritySnapshots, "authorityHash"> | ConversationStateAuthoritySnapshots,
): string {
    const serializable = { ...authority } as Record<string, unknown>;
    delete serializable.authorityHash;
    return createHash("sha256").update(stableJson(serializable)).digest("hex");
}

export async function readRecordConversationStateStore(options: ConversationStateStoreOptions = {}): Promise<ConversationStateReadResult> {
    const paths = await resolveSafePaths(options);
    return readIndex(paths);
}

export async function initializeRecordConversationStateStore(input: InitializeConversationStateStoreInput): Promise<ConversationStateCurrentRead> {
    assertFirstInstallAuthority(input.authority);
    const paths = await resolveSafePaths(input);
    return withConversationStateFileLock(paths, input, async lock => {
        const current = await readIndex(paths);
        if (current.kind === "current") return current;
        if (current.kind === "corrupt") {
            throw new ConversationStateRepairRequiredError("conversation-state 索引已损坏，首次初始化不得覆盖损坏文件；请使用显式权威快照 repair");
        }
        const now = nowIso(input.nowMs);
        const index = finalizeIndex({
            schemaVersion: RECORD_CONVERSATION_STATE_SCHEMA_VERSION,
            kind: "record-conversation-state-index",
            initialized: true,
            revision: 1,
            rootBinding: paths.rootBinding,
            entries: {},
            keysByConversationId: {},
            createdAt: now,
            updatedAt: now,
            persistedHash: "",
        });
        const receipt = await writeIndexAtomic(paths, index, lock);
        return { kind: "current", paths, index, receipt };
    });
}

export async function repairRecordConversationStateStore(input: RepairConversationStateStoreInput): Promise<ConversationStateCurrentRead> {
    const paths = await resolveSafePaths(input);
    await verifyAuthoritySnapshots(input.authority, paths);
    return withConversationStateFileLock(paths, input, async lock => {
        const current = await readIndex(paths);
        if (current.kind === "current") {
            throw new ConversationStateStoreError("conversation-state 索引当前可读，repair 只允许处理 missing 或 corrupt", "REPAIR_NOT_NEEDED");
        }
        const index = rebuildIndex(paths.rootBinding, input.authority, input.nowMs);
        const receipt = await writeIndexAtomic(paths, index, lock);
        return { kind: "current", paths, index, receipt };
    });
}

export async function upsertRecordConversationState(input: UpsertConversationStateInput): Promise<UpsertConversationStateResult> {
    assertIdentity(input.identity);
    assertPatch(input.patch);
    if (input.expectedEntryRevision !== undefined && input.expectedEntryRevision !== null && (!Number.isInteger(input.expectedEntryRevision) || input.expectedEntryRevision < 1)) {
        throw new ConversationStateStoreError("expectedEntryRevision 必须为正整数、null 或省略", "INVALID_EXPECTED_REVISION");
    }
    const paths = await resolveSafePaths(input);
    return withConversationStateFileLock(paths, input, async lock => {
        const read = await readIndex(paths);
        if (read.kind !== "current") {
            throw new ConversationStateRepairRequiredError(read.kind === "missing"
                ? "conversation-state 索引尚未初始化；请显式 first-install 或 repair"
                : `conversation-state 索引损坏：${read.detail}`);
        }
        const key = canonicalConversationStateKey(input.identity);
        const existing = read.index.entries[key] || null;
        const actualEntryRevision = existing?.entryRevision ?? null;
        if (input.expectedEntryRevision !== undefined && input.expectedEntryRevision !== actualEntryRevision) {
            return {
                kind: "conflict",
                paths,
                expectedEntryRevision: input.expectedEntryRevision,
                actualEntryRevision,
                indexRevision: read.index.revision,
                entry: existing ? cloneEntry(existing) : null,
            };
        }
        const now = nowIso(input.nowMs);
        const entry = applyPatch(existing, input.identity, input.patch, now);
        const entries = { ...read.index.entries, [key]: entry };
        const keysByConversationId = rebuildConversationIdIndex(entries);
        const next = finalizeIndex({
            ...read.index,
            revision: read.index.revision + 1,
            entries,
            keysByConversationId,
            updatedAt: now,
            persistedHash: "",
        });
        const receipt = await writeIndexAtomic(paths, next, lock);
        return { kind: "updated", paths, indexRevision: next.revision, entry: cloneEntry(entry), receipt };
    });
}

export async function findRecordConversationStatesByConversationId(
    conversationId: string,
    options: ConversationStateStoreOptions = {},
): Promise<{ kind: "current"; entries: ConversationStateEntry[]; indexRevision: number } | Exclude<ConversationStateReadResult, ConversationStateCurrentRead>> {
    if (!isNonEmptyString(conversationId)) throw new ConversationStateStoreError("conversationId 不能为空", "INVALID_CONVERSATION_ID");
    const read = await readRecordConversationStateStore(options);
    if (read.kind !== "current") return read;
    const entries = (read.index.keysByConversationId[conversationId] || [])
        .map(key => read.index.entries[key])
        .filter((entry): entry is ConversationStateEntry => entry !== undefined)
        .map(cloneEntry);
    return { kind: "current", entries, indexRevision: read.index.revision };
}

export async function rebuildRecordConversationStateIndex(
    authority: ConversationStateAuthoritySnapshots,
    options: Pick<ConversationStateStoreOptions, "dataRoot"> = {},
    nowMs?: number,
): Promise<RecordConversationStateIndex> {
    const paths = await resolveSafePaths(options);
    await verifyAuthoritySnapshots(authority, paths);
    return rebuildIndex(paths.rootBinding, authority, nowMs);
}

function resolveDataRoot(options: ConversationStateStoreOptions): string {
    return path.resolve(options.dataRoot || DATA_ROOT);
}

async function resolveSafePaths(options: ConversationStateStoreOptions): Promise<SafePaths> {
    const dataRoot = resolveDataRoot(options);
    await fs.promises.mkdir(dataRoot, { recursive: true });
    const root = await snapshotRoot(dataRoot);
    const statePath = path.join(dataRoot, RECORD_CONVERSATION_STATE_FILE_NAME);
    const lockPath = `${statePath}.lock`;
    if (path.dirname(statePath) !== dataRoot || path.dirname(lockPath) !== dataRoot) {
        throw new ConversationStatePathSafetyError("conversation-state 文件路径逃逸 DATA_ROOT");
    }
    await assertSafeRegularFileOrMissing(statePath, "conversation-state 索引");
    await assertSafeRegularFileOrMissing(lockPath, "conversation-state 锁");
    return {
        dataRoot,
        statePath,
        lockPath,
        rootBinding: root,
    };
}

async function snapshotRoot(dataRoot: string): Promise<ConversationStateRootBinding> {
    const root = await fs.promises.lstat(dataRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) {
        throw new ConversationStatePathSafetyError(`DATA_ROOT 不是安全真实目录：${dataRoot}`);
    }
    const realDataRoot = await fs.promises.realpath(dataRoot);
    if (!samePath(realDataRoot, dataRoot)) {
        throw new ConversationStatePathSafetyError(`DATA_ROOT realpath 不一致，拒绝 symlink/junction：${dataRoot}`);
    }
    return {
        requestedDataRoot: dataRoot,
        realDataRoot,
        rootIdentity: `${root.dev}:${root.ino}`,
    };
}

async function assertCurrentRoot(paths: SafePaths): Promise<void> {
    const current = await snapshotRoot(paths.dataRoot);
    if (!samePath(current.requestedDataRoot, paths.rootBinding.requestedDataRoot)
        || !samePath(current.realDataRoot, paths.rootBinding.realDataRoot)
        || current.rootIdentity !== paths.rootBinding.rootIdentity) {
        throw new ConversationStatePathSafetyError("DATA_ROOT 在 conversation-state 操作期间被替换或重绑定");
    }
}

async function readIndex(paths: SafePaths): Promise<ConversationStateReadResult> {
    await assertCurrentRoot(paths);
    let raw: string;
    try {
        raw = await readUtf8NoFollow(paths, paths.statePath, "conversation-state 索引");
    } catch (error) {
        if (isErrno(error, "ENOENT")) return { kind: "missing", paths };
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw) as unknown;
    } catch (error) {
        return { kind: "corrupt", paths, reason: "invalid_json", detail: error instanceof Error ? error.message : String(error) };
    }
    const validation = validateIndex(parsed, paths.rootBinding);
    if (validation.kind === "invalid") return { kind: "corrupt", paths, reason: validation.reason, detail: validation.detail };
    return { kind: "current", paths, index: validation.index, receipt: recordConversationStateDurabilityProfile() };
}

async function withConversationStateFileLock<Value>(
    paths: SafePaths,
    options: ConversationStateStoreOptions,
    operation: (lock: ConversationStateFileLock) => Promise<Value>,
): Promise<Value> {
    const lock = await acquireLock(paths, options);
    try {
        await assertCurrentRoot(paths);
        return await operation(lock);
    } finally {
        await lock.release();
    }
}

async function acquireLock(paths: SafePaths, options: ConversationStateStoreOptions): Promise<ConversationStateFileLock> {
    const deadline = Date.now() + (options.lockWaitMs ?? DEFAULT_RECORD_CONVERSATION_STATE_LOCK_WAIT_MS);
    const leaseMs = options.lockLeaseMs ?? DEFAULT_RECORD_CONVERSATION_STATE_LOCK_LEASE_MS;
    const heartbeatMs = options.lockHeartbeatMs === false ? false : options.lockHeartbeatMs ?? Math.max(1, Math.floor(leaseMs / 3));
    if (!Number.isFinite(leaseMs) || leaseMs <= 0 || heartbeatMs !== false && (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0 || heartbeatMs >= leaseMs)) {
        throw new ConversationStateStoreError("lockLeaseMs 必须为正数，lockHeartbeatMs 必须关闭或处于 0 与 lease 之间", "INVALID_LOCK_OPTIONS");
    }
    while (Date.now() <= deadline) {
        await assertCurrentRoot(paths);
        const token = randomUUID();
        const fencingToken = randomUUID();
        try {
            const handle = await fs.promises.open(paths.lockPath, "wx", 0o600);
            try {
                const nowMs = currentLockTimeMs();
                const metadata: LockMetadata = {
                    schemaVersion: 1,
                    kind: "record-conversation-state-lock",
                    token,
                    fencingToken,
                    ownerPid: process.pid,
                    acquiredAt: new Date(nowMs).toISOString(),
                    heartbeatAt: new Date(nowMs).toISOString(),
                    expiresAt: new Date(nowMs + leaseMs).toISOString(),
                    rootIdentity: paths.rootBinding.rootIdentity,
                };
                await handle.writeFile(JSON.stringify(metadata), "utf8");
                await handle.sync();
            } finally {
                await handle.close();
            }
            await assertCurrentRoot(paths);
            await invokeLockTestHook("after-acquire", paths, token, fencingToken);
            return createOwnedLock(paths, token, fencingToken, leaseMs, heartbeatMs);
        } catch (error) {
            if (!isErrno(error, "EEXIST")) throw error;
            if (!await reclaimExpiredLock(paths)) await sleep(LOCK_RETRY_DELAY_MS);
        }
    }
    throw new ConversationStateLockTimeoutError(`等待 conversation-state 跨进程锁超时：${paths.lockPath}`);
}

function createOwnedLock(
    paths: SafePaths,
    token: string,
    fencingToken: string,
    leaseMs: number,
    heartbeatMs: number | false,
): ConversationStateFileLock {
    let stopped = false;
    let fenced: ConversationStateLockFencedError | null = null;
    let renewalQueue: Promise<void> = Promise.resolve();
    const scheduleRenewal = (phase: "heartbeat" | "publish"): Promise<void> => {
        const operation = renewalQueue.then(async () => {
            if (fenced) throw fenced;
            if (phase === "heartbeat" && stopped) return;
            await invokeLockTestHook(phase === "heartbeat" ? "before-heartbeat" : "before-publish-fence", paths, token, fencingToken);
            await renewLockLease(paths, token, fencingToken, leaseMs);
            if (phase === "publish") await invokeLockTestHook("after-publish-fence", paths, token, fencingToken);
        });
        renewalQueue = operation.catch(error => {
            fenced = asLockFencedError(error, token);
        });
        return operation;
    };
    const timer = heartbeatMs === false ? undefined : setInterval(() => {
        void scheduleRenewal("heartbeat").catch(() => undefined);
    }, heartbeatMs);
    timer?.unref();
    const assertOwned = async () => {
        await renewalQueue;
        if (fenced) throw fenced;
        await assertLockOwned(paths, token, fencingToken, true);
    };
    return {
        token,
        fencingToken,
        assertOwned,
        renewForPublish: async () => {
            await scheduleRenewal("publish");
        },
        release: async () => {
            stopped = true;
            if (timer) clearInterval(timer);
            await renewalQueue;
            await releaseLock(paths, token, fencingToken);
        },
    };
}

async function reclaimExpiredLock(paths: SafePaths): Promise<boolean> {
    for (let attempt = 0; attempt < LOCK_RECLAIM_RETRY_LIMIT; attempt += 1) {
        let observed: VerifiedFileSnapshot & { metadata: LockMetadata };
        try {
            observed = await readLockSnapshot(paths, paths.lockPath);
        } catch (error) {
            if (isErrno(error, "ENOENT")) return true;
            throw error;
        }
        if (Date.parse(observed.metadata.expiresAt) > currentLockTimeMs()) return false;
        await invokeLockTestHook("stale-observed", paths, observed.metadata.token, observed.metadata.fencingToken);
        const barrier = await readLockSnapshot(paths, paths.lockPath);
        if (!sameVerifiedSnapshot(observed, barrier) || Date.parse(barrier.metadata.expiresAt) > currentLockTimeMs()) return false;
        await invokeLockTestHook("before-stale-rename", paths, barrier.metadata.token, barrier.metadata.fencingToken);
        const quarantined = `${paths.lockPath}.stale-${randomUUID()}`;
        try {
            await fs.promises.rename(paths.lockPath, quarantined);
            const quarantinedSnapshot = await readLockSnapshot(paths, quarantined);
            if (!sameVerifiedSnapshot(barrier, quarantinedSnapshot)) {
                await restoreQuarantinedLock(paths, quarantined);
                return false;
            }
            await invokeLockTestHook("stale-quarantined", paths, barrier.metadata.token, barrier.metadata.fencingToken);
            await fs.promises.unlink(quarantined);
            await syncDirectory(paths.dataRoot);
            return true;
        } catch (error) {
            if (isErrno(error, "ENOENT") || isErrno(error, "EEXIST")) return false;
            if (TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException).code || "")) return false;
            throw error;
        }
    }
    return false;
}

async function releaseLock(paths: SafePaths, token: string, fencingToken: string): Promise<void> {
    try {
        await assertCurrentRoot(paths);
        const snapshot = await readLockSnapshot(paths, paths.lockPath);
        if (!sameLockOwner(snapshot.metadata, paths, token, fencingToken) || Date.parse(snapshot.metadata.expiresAt) <= currentLockTimeMs()) return;
        await invokeLockTestHook("before-release", paths, token, fencingToken);
        const barrier = await readLockSnapshot(paths, paths.lockPath);
        if (!sameVerifiedSnapshot(snapshot, barrier) || !sameLockOwner(barrier.metadata, paths, token, fencingToken)) return;
        const releasePath = `${paths.lockPath}.release-${token}`;
        await fs.promises.rename(paths.lockPath, releasePath);
        const released = await readLockSnapshot(paths, releasePath);
        if (!sameVerifiedSnapshot(barrier, released)) {
            await restoreQuarantinedLock(paths, releasePath);
            return;
        }
        await fs.promises.unlink(releasePath);
        await syncDirectory(paths.dataRoot);
    } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
    }
}

async function writeIndexAtomic(paths: SafePaths, index: RecordConversationStateIndex, lock: ConversationStateFileLock): Promise<ConversationStateDurabilityReceipt> {
    await assertCurrentRoot(paths);
    await assertSafeRegularFileOrMissing(paths.statePath, "conversation-state 索引");
    const payload = `${JSON.stringify(index, null, 2)}\n`;
    const temporaryPath = path.join(paths.dataRoot, `.${RECORD_CONVERSATION_STATE_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
    let handle: fs.promises.FileHandle | undefined;
    try {
        handle = await fs.promises.open(temporaryPath, "wx", 0o600);
        await handle.writeFile(payload, "utf8");
        await handle.sync();
    } finally {
        await handle?.close();
    }
    try {
        await lock.renewForPublish();
        await lock.assertOwned();
        await assertCurrentRoot(paths);
        await renameWithRetry(temporaryPath, paths.statePath);
        await assertCurrentRoot(paths);
        await assertSafeRegularFileOrMissing(paths.statePath, "conversation-state 索引");
        const target = await openVerifiedFile(paths, paths.statePath, "conversation-state 索引", true);
        try {
            await target.handle.sync();
        } finally {
            await target.handle.close();
        }
        await syncDirectory(paths.dataRoot);
        const readBack = await readIndex(paths);
        if (readBack.kind !== "current" || readBack.index.persistedHash !== index.persistedHash || readBack.index.revision !== index.revision) {
            throw new ConversationStateStoreError("conversation-state 原子替换后回读校验失败", "DURABILITY_READBACK_FAILED");
        }
        return recordConversationStateDurabilityProfile();
    } catch (error) {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

async function renameWithRetry(sourcePath: string, targetPath: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await fs.promises.rename(sourcePath, targetPath);
            return;
        } catch (error) {
            if (!TRANSIENT_RENAME_CODES.has((error as NodeJS.ErrnoException).code || "") || attempt === 4) throw error;
            await sleep(10 * 2 ** attempt);
        }
    }
}

async function syncDirectory(directoryPath: string): Promise<void> {
    if (process.platform === "win32") return;
    const handle = await fs.promises.open(directoryPath, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

function rebuildIndex(rootBinding: ConversationStateRootBinding, authority: ConversationStateAuthoritySnapshots, nowMs?: number): RecordConversationStateIndex {
    const drafts = new Map<string, RebuildDraft>();
    const ensure = (identity: ConversationStateIdentity): RebuildDraft => {
        assertIdentity(identity);
        const key = canonicalConversationStateKey(identity);
        const existing = drafts.get(key);
        if (existing) return existing;
        const draft: RebuildDraft = {
            ...identity,
            workspace: null,
            titleBestEffort: null,
            latestObservedRevision: null,
            latestEvidenceHash: null,
            lastCompleteScanId: null,
            recordCoveredRevision: null,
            recordBodyHash: null,
            state: "Unresolved",
            evidence: [],
            stateReason: "rebuilt from explicit authority snapshots",
            activeTaskIds: [],
            recordWorkKey: null,
            pendingRefreshKey: null,
            sourceObservedAt: null,
            observedAtMs: 0,
            contentHashesByRevision: new Map(),
        };
        drafts.set(key, draft);
        return draft;
    };

    for (const record of authority.recordIndex) {
        assertIdentity(record.identity);
        assertNullableString(record.recordCoveredRevision, "recordCoveredRevision");
        const draft = ensure(record.identity);
        draft.workspace = preferNullableString(draft.workspace, record.workspace);
        draft.titleBestEffort = preferNullableString(draft.titleBestEffort, record.titleBestEffort);
        draft.recordCoveredRevision = record.recordCoveredRevision;
        draft.recordBodyHash = preferNullableString(draft.recordBodyHash, record.recordBodyHash);
    }
    for (const ledger of authority.schedulerLedgers) {
        assertIdentity(ledger.identity);
        if (!isNonEmptyString(ledger.taskId)) throw new ConversationStateStoreError("scheduler ledger taskId 不能为空", "INVALID_AUTHORITY_SNAPSHOT");
        const draft = ensure(ledger.identity);
        if (ledger.active) draft.activeTaskIds.push(ledger.taskId);
        draft.recordWorkKey = preferNullableString(draft.recordWorkKey, ledger.recordWorkKey);
        draft.pendingRefreshKey = preferNullableString(draft.pendingRefreshKey, ledger.pendingRefreshKey);
    }
    for (const work of authority.workRegistry) {
        assertIdentity(work.identity);
        if (!Array.isArray(work.activeTaskIds) || work.activeTaskIds.some(taskId => !isNonEmptyString(taskId))) {
            throw new ConversationStateStoreError("work registry activeTaskIds 必须为非空字符串数组", "INVALID_AUTHORITY_SNAPSHOT");
        }
        const draft = ensure(work.identity);
        draft.activeTaskIds.push(...work.activeTaskIds);
        draft.recordWorkKey = preferNullableString(draft.recordWorkKey, work.recordWorkKey);
        draft.pendingRefreshKey = preferNullableString(draft.pendingRefreshKey, work.pendingRefreshKey);
    }
    for (const snapshot of authority.recentCompleteEvidence) {
        assertIdentity(snapshot.identity);
        if (!isNonEmptyString(snapshot.latestObservedRevision)) throw new ConversationStateStoreError("complete evidence latestObservedRevision 不能为空", "INVALID_AUTHORITY_SNAPSHOT");
        assertState(snapshot.state);
        assertEvidence(snapshot.evidence, true);
        const draft = ensure(snapshot.identity);
        const observedAt = snapshot.observedAt || snapshot.evidence.observedAt;
        const observedAtMs = Date.parse(observedAt);
        if (!Number.isFinite(observedAtMs)) throw new ConversationStateStoreError("complete evidence observedAt 无效", "INVALID_AUTHORITY_SNAPSHOT");
        const tieBreaker = `${snapshot.latestObservedRevision}\u0000${snapshot.evidence.scanId || ""}\u0000${snapshot.evidence.evidenceHash || ""}`;
        const previousTieBreaker = `${draft.latestObservedRevision || ""}\u0000${draft.lastCompleteScanId || ""}\u0000${draft.latestEvidenceHash || ""}`;
        const evidence = cloneEvidence(snapshot.evidence);
        const evidenceKey = evidence.evidenceHash || `${evidence.source}\u0000${evidence.scanId || ""}\u0000${evidence.observedAt}`;
        const uniqueEvidence = new Map(draft.evidence.map(item => [
            item.evidenceHash || `${item.source}\u0000${item.scanId || ""}\u0000${item.observedAt}`,
            item,
        ]));
        uniqueEvidence.set(evidenceKey, evidence);
        draft.evidence = [...uniqueEvidence.values()].sort((left, right) => (
            Date.parse(left.observedAt) - Date.parse(right.observedAt)
        ));
        const sourceRevision = typeof evidence.details?.sourceRevision === "string" ? evidence.details.sourceRevision : null;
        const contentHash = typeof evidence.details?.contentHash === "string" ? evidence.details.contentHash : null;
        if (sourceRevision && contentHash) {
            const hashes = draft.contentHashesByRevision.get(sourceRevision) || new Set<string>();
            hashes.add(contentHash);
            draft.contentHashesByRevision.set(sourceRevision, hashes);
        }
        if (observedAtMs > draft.observedAtMs || observedAtMs === draft.observedAtMs && tieBreaker > previousTieBreaker) {
            draft.latestObservedRevision = snapshot.latestObservedRevision;
            draft.latestEvidenceHash = snapshot.evidence.evidenceHash || null;
            draft.lastCompleteScanId = snapshot.evidence.scanId || null;
            if (draft.state !== "Conflict") draft.state = snapshot.state;
            draft.sourceObservedAt = observedAt;
            draft.workspace = preferNullableString(draft.workspace, snapshot.workspace);
            draft.titleBestEffort = preferNullableString(draft.titleBestEffort, snapshot.titleBestEffort);
            draft.observedAtMs = observedAtMs;
            draft.stateReason = `rebuilt from complete evidence ${authority.snapshotId}`;
        }
        if (snapshot.state === "Conflict" || [...draft.contentHashesByRevision.values()].some(hashes => hashes.size > 1)) {
            draft.state = "Conflict";
            draft.pendingRefreshKey = null;
            draft.stateReason = "same-revision-different-source-bytes";
        }
    }

    const entries: Record<string, ConversationStateEntry> = {};
    for (const [key, draft] of drafts) {
        if (draft.state === "Conflict") draft.pendingRefreshKey = null;
        const entry: ConversationStateEntry = {
            chain: draft.chain,
            workspaceHash: draft.workspaceHash,
            conversationId: draft.conversationId,
            entryRevision: 1,
            workspace: draft.workspace,
            titleBestEffort: draft.titleBestEffort,
            latestObservedRevision: draft.latestObservedRevision,
            latestEvidenceHash: draft.latestEvidenceHash,
            lastCompleteScanId: draft.lastCompleteScanId,
            recordCoveredRevision: draft.recordCoveredRevision,
            recordBodyHash: draft.recordBodyHash,
            state: draft.state,
            evidence: draft.evidence.map(cloneEvidence),
            stateReason: draft.stateReason,
            activeTaskIds: uniqueSorted(draft.activeTaskIds),
            recordWorkKey: draft.recordWorkKey,
            pendingRefreshKey: draft.pendingRefreshKey,
            sourceObservedAt: draft.sourceObservedAt,
            updatedAt: nowIso(nowMs),
        };
        assertEntry(entry);
        entries[key] = entry;
    }
    const now = nowIso(nowMs);
    return finalizeIndex({
        schemaVersion: RECORD_CONVERSATION_STATE_SCHEMA_VERSION,
        kind: "record-conversation-state-index",
        initialized: true,
        revision: 1,
        rootBinding,
        entries,
        keysByConversationId: rebuildConversationIdIndex(entries),
        createdAt: now,
        updatedAt: now,
        persistedHash: "",
    });
}

function applyPatch(existing: ConversationStateEntry | null, identity: ConversationStateIdentity, patch: ConversationStatePatch, updatedAt: string): ConversationStateEntry {
    const base: ConversationStateEntry = existing ? cloneEntry(existing) : {
        ...identity,
        entryRevision: 0,
        workspace: null,
        titleBestEffort: null,
        latestObservedRevision: null,
        latestEvidenceHash: null,
        lastCompleteScanId: null,
        recordCoveredRevision: null,
        recordBodyHash: null,
        state: "Unresolved",
        evidence: [],
        stateReason: null,
        activeTaskIds: [],
        recordWorkKey: null,
        pendingRefreshKey: null,
        sourceObservedAt: null,
        updatedAt,
    };
    const entry: ConversationStateEntry = {
        chain: identity.chain,
        workspaceHash: identity.workspaceHash,
        conversationId: identity.conversationId,
        entryRevision: base.entryRevision + 1,
        workspace: patch.workspace === undefined ? base.workspace : patch.workspace,
        titleBestEffort: patch.titleBestEffort === undefined ? base.titleBestEffort : patch.titleBestEffort,
        latestObservedRevision: patch.latestObservedRevision === undefined ? base.latestObservedRevision : patch.latestObservedRevision,
        latestEvidenceHash: patch.latestEvidenceHash === undefined ? base.latestEvidenceHash : patch.latestEvidenceHash,
        lastCompleteScanId: patch.lastCompleteScanId === undefined ? base.lastCompleteScanId : patch.lastCompleteScanId,
        recordCoveredRevision: patch.recordCoveredRevision === undefined ? base.recordCoveredRevision : patch.recordCoveredRevision,
        recordBodyHash: patch.recordBodyHash === undefined ? base.recordBodyHash : patch.recordBodyHash,
        state: patch.state === undefined ? base.state : patch.state,
        evidence: patch.evidence ? patch.evidence.map(cloneEvidence) : base.evidence.map(cloneEvidence),
        stateReason: patch.stateReason === undefined ? base.stateReason : patch.stateReason,
        activeTaskIds: patch.activeTaskIds ? uniqueSorted(patch.activeTaskIds) : uniqueSorted(base.activeTaskIds),
        recordWorkKey: patch.recordWorkKey === undefined ? base.recordWorkKey : patch.recordWorkKey,
        pendingRefreshKey: patch.pendingRefreshKey === undefined ? base.pendingRefreshKey : patch.pendingRefreshKey,
        sourceObservedAt: patch.sourceObservedAt === undefined ? base.sourceObservedAt : patch.sourceObservedAt,
        updatedAt,
    };
    assertEntry(entry);
    return entry;
}

function validateIndex(value: unknown, expectedBinding: ConversationStateRootBinding): { kind: "valid"; index: RecordConversationStateIndex } | { kind: "invalid"; reason: ConversationStateCorruptRead["reason"]; detail: string } {
    if (!isRecord(value)) return { kind: "invalid", reason: "invalid_schema", detail: "索引根对象必须是 object" };
    try {
        assertExactKeys(value, INDEX_FIELDS, "conversation-state index");
        if (value.schemaVersion !== RECORD_CONVERSATION_STATE_SCHEMA_VERSION || value.kind !== "record-conversation-state-index" || value.initialized !== true) {
            return { kind: "invalid", reason: "invalid_schema", detail: "schemaVersion、kind 或 initialized 不匹配" };
        }
        const revision = value.revision;
        if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) return { kind: "invalid", reason: "invalid_schema", detail: "revision 必须为正整数" };
        if (!isRootBinding(value.rootBinding)) return { kind: "invalid", reason: "invalid_schema", detail: "rootBinding 无效" };
        if (!sameRootBinding(value.rootBinding, expectedBinding)) {
            throw new ConversationStatePathSafetyError("conversation-state 索引绑定到另一个 DATA_ROOT，拒绝跨根读取或 repair");
        }
        if (!isRecord(value.entries) || !isRecord(value.keysByConversationId)) return { kind: "invalid", reason: "invalid_schema", detail: "entries 或二级索引无效" };
        if (!isNonEmptyString(value.createdAt) || !isNonEmptyString(value.updatedAt) || !isNonEmptyString(value.persistedHash)) {
            return { kind: "invalid", reason: "invalid_schema", detail: "时间戳或 persistedHash 无效" };
        }
        const index = value as unknown as RecordConversationStateIndex;
        for (const [key, entry] of Object.entries(index.entries)) {
            assertEntry(entry);
            if (key !== canonicalConversationStateKey(entry)) return { kind: "invalid", reason: "invalid_schema", detail: `entries key 与 identity 不匹配：${key}` };
        }
        const expectedSecondary = rebuildConversationIdIndex(index.entries);
        if (stableJson(expectedSecondary) !== stableJson(index.keysByConversationId)) {
            return { kind: "invalid", reason: "invalid_schema", detail: "conversationId 二级索引与 entries 不一致" };
        }
        if (calculateRecordConversationStateHash(index) !== index.persistedHash) {
            return { kind: "invalid", reason: "hash_mismatch", detail: "persistedHash 与文件内容不一致" };
        }
        return { kind: "valid", index: cloneIndex(index) };
    } catch (error) {
        if (error instanceof ConversationStatePathSafetyError) throw error;
        return { kind: "invalid", reason: "invalid_schema", detail: error instanceof Error ? error.message : String(error) };
    }
}

function finalizeIndex(index: RecordConversationStateIndex): RecordConversationStateIndex {
    const finalized = { ...index, persistedHash: "" };
    return { ...finalized, persistedHash: calculateRecordConversationStateHash(finalized) };
}

function rebuildConversationIdIndex(entries: Record<string, ConversationStateEntry>): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [key, entry] of Object.entries(entries)) {
        const keys = result[entry.conversationId] || [];
        keys.push(key);
        result[entry.conversationId] = keys;
    }
    for (const keys of Object.values(result)) keys.sort();
    return result;
}

function assertFirstInstallAuthority(authority: ConversationStateFirstInstallAuthority): void {
    if (!isRecord(authority)) throw new ConversationStateStoreError("首次初始化 authority 必须是 object", "INVALID_FIRST_INSTALL_AUTHORITY");
    assertExactKeys(authority, ["kind", "authorityId", "observedAt"], "first-install authority");
    if (authority.kind !== "first-install" || !isNonEmptyString(authority.authorityId) || !isIsoDate(authority.observedAt)) {
        throw new ConversationStateStoreError("首次初始化必须提供明确的 first-install authority", "INVALID_FIRST_INSTALL_AUTHORITY");
    }
}

async function verifyAuthoritySnapshots(authority: ConversationStateAuthoritySnapshots, paths: SafePaths): Promise<void> {
    assertAuthoritySnapshotsShape(authority, paths.rootBinding);
    const authorityRef = path.resolve(authority.authorityRef);
    if (!samePath(authorityRef, authority.authorityRef) || path.dirname(authorityRef) !== paths.dataRoot) {
        throw new ConversationStatePathSafetyError("repair authorityRef 必须是当前 DATA_ROOT 直属的绝对文件路径");
    }
    let persisted: unknown;
    try {
        persisted = JSON.parse(await readUtf8NoFollow(paths, authorityRef, "conversation-state authority")) as unknown;
    } catch (error) {
        if (error instanceof SyntaxError) throw new ConversationStateStoreError("repair authorityRef JSON 无效", "INVALID_AUTHORITY_REFERENCE");
        throw error;
    }
    assertAuthoritySnapshotsShape(persisted as ConversationStateAuthoritySnapshots, paths.rootBinding);
    if (stableJson(persisted) !== stableJson(authority)) {
        throw new ConversationStateStoreError("repair authorityRef 内容与调用方 snapshots 不一致", "AUTHORITY_REFERENCE_MISMATCH");
    }
}

function assertAuthoritySnapshotsShape(authority: ConversationStateAuthoritySnapshots, expectedBinding: ConversationStateRootBinding): void {
    if (!isRecord(authority)
        || authority.kind !== "record-conversation-state-authority-snapshots"
        || !isNonEmptyString(authority.snapshotId)
        || !isIsoDate(authority.capturedAt)
        || !isRootBinding(authority.rootBinding)
        || !Number.isInteger(authority.authorityRevision)
        || authority.authorityRevision < 1
        || !isNonEmptyString(authority.authorityRef)
        || !isNonEmptyString(authority.authorityHash)
        || !Array.isArray(authority.recordIndex)
        || !Array.isArray(authority.schedulerLedgers)
        || !Array.isArray(authority.workRegistry)
        || !Array.isArray(authority.recentCompleteEvidence)) {
        throw new ConversationStateStoreError("repair 必须提供四类显式 authority snapshots", "INVALID_AUTHORITY_SNAPSHOT");
    }
    assertExactKeys(authority, AUTHORITY_FIELDS, "authority snapshots");
    if (!sameRootBinding(authority.rootBinding, expectedBinding)) {
        throw new ConversationStatePathSafetyError("repair authority snapshots 绑定到另一个 DATA_ROOT");
    }
    if (calculateRecordConversationStateAuthorityHash(authority) !== authority.authorityHash) {
        throw new ConversationStateStoreError("repair authority snapshots hash 校验失败", "AUTHORITY_HASH_MISMATCH");
    }
    for (const record of authority.recordIndex) {
        if (!isRecord(record)) throw new ConversationStateStoreError("recordIndex snapshot 必须是 object", "INVALID_AUTHORITY_SNAPSHOT");
        assertExactKeys(record, ["identity", "workspace", "titleBestEffort", "recordCoveredRevision", "recordBodyHash", "observedAt"], "recordIndex snapshot");
        assertExactIdentity(record.identity, "recordIndex identity");
    }
    for (const ledger of authority.schedulerLedgers) {
        if (!isRecord(ledger)) throw new ConversationStateStoreError("scheduler ledger snapshot 必须是 object", "INVALID_AUTHORITY_SNAPSHOT");
        assertExactKeys(ledger, ["identity", "taskId", "active", "recordWorkKey", "pendingRefreshKey", "observedAt"], "scheduler ledger snapshot");
        assertExactIdentity(ledger.identity, "scheduler ledger identity");
    }
    for (const work of authority.workRegistry) {
        if (!isRecord(work)) throw new ConversationStateStoreError("work registry snapshot 必须是 object", "INVALID_AUTHORITY_SNAPSHOT");
        assertExactKeys(work, ["identity", "activeTaskIds", "recordWorkKey", "pendingRefreshKey", "observedAt"], "work registry snapshot");
        assertExactIdentity(work.identity, "work registry identity");
    }
    for (const evidence of authority.recentCompleteEvidence) {
        if (!isRecord(evidence)) throw new ConversationStateStoreError("complete evidence snapshot 必须是 object", "INVALID_AUTHORITY_SNAPSHOT");
        assertExactKeys(evidence, ["identity", "latestObservedRevision", "state", "evidence", "workspace", "titleBestEffort", "observedAt"], "complete evidence snapshot");
        assertExactIdentity(evidence.identity, "complete evidence identity");
    }
}

function assertIdentity(identity: ConversationStateIdentity): void {
    if (!SOURCE_CHAINS.includes(identity.chain)) throw new ConversationStateStoreError(`未知 source chain: ${identity.chain}`, "INVALID_IDENTITY");
    if (!isNonEmptyString(identity.workspaceHash) || identity.workspaceHash.includes("\u0000")) throw new ConversationStateStoreError("workspaceHash 不能为空或包含 NUL", "INVALID_IDENTITY");
    if (!isNonEmptyString(identity.conversationId) || identity.conversationId.includes("\u0000")) throw new ConversationStateStoreError("conversationId 不能为空或包含 NUL", "INVALID_IDENTITY");
}

function assertPatch(patch: ConversationStatePatch): void {
    if (!isRecord(patch)) throw new ConversationStateStoreError("conversation-state patch 必须是 object", "INVALID_PATCH");
    assertExactKeys(patch, PATCH_FIELDS, "conversation-state patch");
    if (patch.state !== undefined) assertState(patch.state);
    for (const [name, value] of Object.entries(patch)) {
        if (["workspace", "titleBestEffort", "latestObservedRevision", "latestEvidenceHash", "lastCompleteScanId", "recordCoveredRevision", "recordBodyHash", "stateReason", "recordWorkKey", "pendingRefreshKey", "sourceObservedAt"].includes(name)) {
            if (["latestObservedRevision", "recordCoveredRevision", "recordWorkKey", "pendingRefreshKey"].includes(name)) assertNullableNonEmptyString(value, name);
            else assertNullableString(value, name);
        }
    }
    if (patch.activeTaskIds !== undefined && (!Array.isArray(patch.activeTaskIds) || patch.activeTaskIds.some(taskId => !isNonEmptyString(taskId)))) {
        throw new ConversationStateStoreError("activeTaskIds 必须是非空字符串数组", "INVALID_PATCH");
    }
    if (patch.evidence !== undefined) {
        if (!Array.isArray(patch.evidence)) throw new ConversationStateStoreError("evidence 必须是数组", "INVALID_PATCH");
        patch.evidence.forEach(evidence => assertEvidence(evidence, false));
    }
}

function assertEntry(entry: ConversationStateEntry): void {
    if (!isRecord(entry)) throw new ConversationStateStoreError("conversation-state entry 必须是 object", "INVALID_ENTRY");
    assertExactKeys(entry, ENTRY_FIELDS, "conversation-state entry");
    assertIdentity(entry);
    if (!Number.isInteger(entry.entryRevision) || entry.entryRevision < 1) throw new ConversationStateStoreError("entryRevision 必须为正整数", "INVALID_ENTRY");
    assertNullableString(entry.workspace, "workspace");
    assertNullableString(entry.titleBestEffort, "titleBestEffort");
    assertNullableNonEmptyString(entry.latestObservedRevision, "latestObservedRevision");
    assertNullableString(entry.latestEvidenceHash, "latestEvidenceHash");
    assertNullableString(entry.lastCompleteScanId, "lastCompleteScanId");
    assertNullableNonEmptyString(entry.recordCoveredRevision, "recordCoveredRevision");
    assertNullableString(entry.recordBodyHash, "recordBodyHash");
    assertState(entry.state);
    if (!Array.isArray(entry.evidence)) throw new ConversationStateStoreError("entry evidence 必须是数组", "INVALID_ENTRY");
    entry.evidence.forEach(evidence => assertEvidence(evidence, false));
    assertNullableString(entry.stateReason, "stateReason");
    if (!Array.isArray(entry.activeTaskIds) || entry.activeTaskIds.some(taskId => !isNonEmptyString(taskId)) || stableJson(entry.activeTaskIds) !== stableJson(uniqueSorted(entry.activeTaskIds))) {
        throw new ConversationStateStoreError("activeTaskIds 必须是排序去重后的非空字符串数组", "INVALID_ENTRY");
    }
    assertNullableString(entry.recordWorkKey, "recordWorkKey");
    assertNullableString(entry.pendingRefreshKey, "pendingRefreshKey");
    assertNullableString(entry.sourceObservedAt, "sourceObservedAt");
    if (!isIsoDate(entry.updatedAt)) throw new ConversationStateStoreError("updatedAt 无效", "INVALID_ENTRY");
    assertEntryStateInvariant(entry);
}

function assertEvidence(evidence: ConversationStateEvidence, mustBeComplete: boolean): void {
    if (!isRecord(evidence)) throw new ConversationStateStoreError("evidence 必须是 object", "INVALID_EVIDENCE");
    assertExactKeys(evidence, EVIDENCE_FIELDS, "conversation-state evidence");
    if (!isNonEmptyString(evidence.source)
        || typeof evidence.complete !== "boolean"
        || !isIsoDate(evidence.observedAt)
        || mustBeComplete && evidence.complete !== true
        || evidence.evidenceHash !== undefined && !isNonEmptyString(evidence.evidenceHash)
        || evidence.scanId !== undefined && !isNonEmptyString(evidence.scanId)
        || evidence.details !== undefined && !isJsonRecord(evidence.details)) {
        throw new ConversationStateStoreError("evidence 无效，repair 只接受 complete=true 的 recent evidence", "INVALID_EVIDENCE");
    }
}

function assertState(state: unknown): asserts state is ConversationState {
    if (state !== "Fresh" && state !== "Stale" && state !== "Missing" && state !== "Unresolved" && state !== "Lost" && state !== "Conflict") {
        throw new ConversationStateStoreError(`未知 conversation-state：${String(state)}`, "INVALID_STATE");
    }
}

function assertNullableString(value: unknown, name: string): void {
    if (value !== null && typeof value !== "string") throw new ConversationStateStoreError(`${name} 必须为 string 或 null`, "INVALID_VALUE");
}

function assertNullableNonEmptyString(value: unknown, name: string): void {
    if (value !== null && !isNonEmptyString(value)) throw new ConversationStateStoreError(`${name} 必须为非空 string 或 null`, "INVALID_VALUE");
}

function assertEntryStateInvariant(entry: ConversationStateEntry): void {
    const latest = entry.latestObservedRevision;
    const covered = entry.recordCoveredRevision;
    const refresh = entry.pendingRefreshKey;
    if (entry.state === "Fresh") {
        if (latest === null || covered === null || latest !== covered || refresh !== null) {
            throw new ConversationStateStoreError("Fresh 要求 latestObservedRevision 与 recordCoveredRevision 非空且严格相等，并且 pendingRefreshKey 为空", "INVALID_STATE_INVARIANT");
        }
        return;
    }
    if (entry.state === "Stale") {
        if (latest === null || covered === null || latest === covered || !isNonEmptyString(refresh)) {
            throw new ConversationStateStoreError("Stale 要求 latestObservedRevision 与旧 recordCoveredRevision 均非空且不同，并且 pendingRefreshKey 非空", "INVALID_STATE_INVARIANT");
        }
        return;
    }
    if (entry.state === "Missing") {
        if (latest === null || covered !== null || !isNonEmptyString(refresh)) {
            throw new ConversationStateStoreError("Missing 要求存在 latestObservedRevision、recordCoveredRevision 为空，并且 pendingRefreshKey 非空", "INVALID_STATE_INVARIANT");
        }
        return;
    }
    if (refresh !== null) {
        throw new ConversationStateStoreError(`${entry.state} 不得携带 pendingRefreshKey`, "INVALID_STATE_INVARIANT");
    }
}

function assertExactIdentity(value: unknown, label: string): asserts value is ConversationStateIdentity {
    if (!isRecord(value)) throw new ConversationStateStoreError(`${label} 必须是 object`, "INVALID_IDENTITY");
    assertExactKeys(value, ["chain", "workspaceHash", "conversationId"], label);
    assertIdentity(value as unknown as ConversationStateIdentity);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
    const allowedKeys = new Set(allowed);
    const unknown = Object.keys(value).filter(key => !allowedKeys.has(key));
    if (unknown.length > 0) {
        throw new ConversationStateStoreError(`${label} 含未知字段：${unknown.sort().join(", ")}`, "UNKNOWN_FIELD");
    }
}

function isRootBinding(value: unknown): value is ConversationStateRootBinding {
    if (!isRecord(value)) return false;
    assertExactKeys(value, ROOT_BINDING_FIELDS, "rootBinding");
    return isNonEmptyString(value.requestedDataRoot)
        && isNonEmptyString(value.realDataRoot)
        && isNonEmptyString(value.rootIdentity);
}

function sameRootBinding(left: ConversationStateRootBinding, right: ConversationStateRootBinding): boolean {
    return samePath(left.requestedDataRoot, right.requestedDataRoot)
        && samePath(left.realDataRoot, right.realDataRoot)
        && left.rootIdentity === right.rootIdentity;
}

async function assertSafeRegularFileOrMissing(filePath: string, label: string): Promise<void> {
    try {
        const stat = await fs.promises.lstat(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new ConversationStatePathSafetyError(`${label} 不是安全普通文件：${filePath}`);
    } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
    }
}

async function readUtf8NoFollow(paths: SafePaths, filePath: string, label: string): Promise<string> {
    return (await readVerifiedFileSnapshot(paths, filePath, label)).content;
}

async function openVerifiedFile(
    paths: SafePaths,
    filePath: string,
    label: string,
    writable: boolean,
): Promise<{ handle: fs.promises.FileHandle; identity: string }> {
    if (path.dirname(filePath) !== paths.dataRoot) throw new ConversationStatePathSafetyError(`${label} 路径逃逸 DATA_ROOT：${filePath}`);
    await assertCurrentRoot(paths);
    const baseFlags = writable ? fs.constants.O_RDWR : fs.constants.O_RDONLY;
    const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
    if (process.platform !== "win32" && typeof noFollow !== "number") {
        throw new ConversationStatePathSafetyError("当前平台缺少 O_NOFOLLOW，拒绝不安全读取");
    }
    let handle: fs.promises.FileHandle;
    try {
        handle = await fs.promises.open(filePath, baseFlags | (noFollow || 0));
    } catch (error) {
        if (isErrno(error, "ELOOP")) throw new ConversationStatePathSafetyError(`${label} 是 symlink，拒绝跟随：${filePath}`);
        throw error;
    }
    try {
        const descriptorStat = await handle.stat();
        if (!descriptorStat.isFile()) throw new ConversationStatePathSafetyError(`${label} 的 fd 不是普通文件：${filePath}`);
        await pathSafetyTestHook?.({ phase: "after-open-before-path-verify", filePath, label });
        await verifyOpenFilePath(paths, filePath, label, descriptorStat);
        return { handle, identity: fileIdentity(descriptorStat) };
    } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
    }
}

async function verifyOpenFilePath(paths: SafePaths, filePath: string, label: string, descriptorStat: fs.Stats): Promise<void> {
    await assertCurrentRoot(paths);
    const pathStat = await fs.promises.lstat(filePath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw new ConversationStatePathSafetyError(`${label} 最终路径不是安全普通文件：${filePath}`);
    if (fileIdentity(pathStat) !== fileIdentity(descriptorStat)) throw new ConversationStatePathSafetyError(`${label} 在 open 后被替换：${filePath}`);
    const realFilePath = await fs.promises.realpath(filePath);
    if (!samePath(realFilePath, filePath)) {
        const internalLockRename = label === "conversation-state 锁"
            && samePath(path.dirname(realFilePath), paths.dataRoot)
            && [".release-", ".stale-"].some(marker => realFilePath.startsWith(`${filePath}${marker}`));
        if (internalLockRename) throw new ConversationStateSnapshotRaceError(`${label} 正在内部改名：${realFilePath}`);
        throw new ConversationStatePathSafetyError(`${label} realpath 不一致，拒绝 symlink/junction：expected=${filePath}; actual=${realFilePath}`);
    }
    await assertCurrentRoot(paths);
}

async function readVerifiedFileSnapshot(paths: SafePaths, filePath: string, label: string): Promise<VerifiedFileSnapshot> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        let opened: Awaited<ReturnType<typeof openVerifiedFile>> | undefined;
        try {
            opened = await openVerifiedFile(paths, filePath, label, false);
            const before = await opened.handle.stat();
            const content = await opened.handle.readFile({ encoding: "utf8" });
            const after = await opened.handle.stat();
            await verifyOpenFilePath(paths, filePath, label, after);
            if (fileIdentity(before) !== fileIdentity(after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) continue;
            return {
                content,
                identity: opened.identity,
                size: after.size,
                mtimeMs: after.mtimeMs,
                contentHash: createHash("sha256").update(content).digest("hex"),
            };
        } catch (error) {
            if (!isTransientWindowsSnapshotRace(error) || attempt === 4) throw error;
            await sleep(Math.min(attempt + 1, 5));
        } finally {
            await opened?.handle.close().catch(() => undefined);
        }
    }
    throw new ConversationStatePathSafetyError(`${label} 在读取期间持续变化，拒绝使用不稳定快照：${filePath}`);
}

async function readLockSnapshot(paths: SafePaths, filePath: string): Promise<VerifiedFileSnapshot & { metadata: LockMetadata }> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const snapshot = await readVerifiedFileSnapshot(paths, filePath, "conversation-state 锁");
        const metadata = parseLockMetadata(snapshot.content);
        if (metadata && metadata.rootIdentity === paths.rootBinding.rootIdentity) return { ...snapshot, metadata };
    }
    throw new ConversationStatePathSafetyError(`conversation-state 锁元数据无效或 rootIdentity 不匹配：${filePath}`);
}

async function assertLockOwned(paths: SafePaths, token: string, fencingToken: string, requireUnexpired: boolean): Promise<void> {
    let snapshot: VerifiedFileSnapshot & { metadata: LockMetadata };
    try {
        snapshot = await readLockSnapshot(paths, paths.lockPath);
    } catch (error) {
        throw asLockFencedError(error, token);
    }
    if (!sameLockOwner(snapshot.metadata, paths, token, fencingToken)
        || requireUnexpired && Date.parse(snapshot.metadata.expiresAt) <= currentLockTimeMs()) {
        throw new ConversationStateLockFencedError(`conversation-state lock ${token} 已过期或被接管`);
    }
}

async function renewLockLease(paths: SafePaths, token: string, fencingToken: string, leaseMs: number): Promise<void> {
    const opened = await openVerifiedFile(paths, paths.lockPath, "conversation-state 锁", true).catch(error => {
        throw asLockFencedError(error, token);
    });
    try {
        const before = await opened.handle.stat();
        const raw = await opened.handle.readFile({ encoding: "utf8" });
        const metadata = parseLockMetadata(raw);
        const nowMs = currentLockTimeMs();
        if (!metadata || !sameLockOwner(metadata, paths, token, fencingToken) || Date.parse(metadata.expiresAt) <= nowMs) {
            throw new ConversationStateLockFencedError(`conversation-state lock ${token} 无法续租：所有权已失效`);
        }
        const next: LockMetadata = {
            ...metadata,
            heartbeatAt: new Date(nowMs).toISOString(),
            expiresAt: new Date(nowMs + leaseMs).toISOString(),
        };
        const payload = JSON.stringify(next);
        await opened.handle.write(payload, 0, "utf8");
        await opened.handle.truncate(Buffer.byteLength(payload));
        await opened.handle.sync();
        const after = await opened.handle.stat();
        if (fileIdentity(before) !== fileIdentity(after)) throw new ConversationStateLockFencedError(`conversation-state lock ${token} fd 身份已变化`);
        await verifyOpenFilePath(paths, paths.lockPath, "conversation-state 锁", after).catch(error => {
            throw asLockFencedError(error, token);
        });
    } finally {
        await opened.handle.close();
    }
    await assertLockOwned(paths, token, fencingToken, true);
}

async function restoreQuarantinedLock(paths: SafePaths, quarantinedPath: string): Promise<void> {
    try {
        await fs.promises.rename(quarantinedPath, paths.lockPath);
    } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        await fs.promises.rm(quarantinedPath, { force: true });
    }
}

function sameVerifiedSnapshot(left: VerifiedFileSnapshot, right: VerifiedFileSnapshot): boolean {
    return left.identity === right.identity
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs
        && left.contentHash === right.contentHash;
}

function sameLockOwner(metadata: LockMetadata, paths: SafePaths, token: string, fencingToken: string): boolean {
    return metadata.token === token
        && metadata.fencingToken === fencingToken
        && metadata.rootIdentity === paths.rootBinding.rootIdentity;
}

function fileIdentity(stat: fs.Stats): string {
    return `${stat.dev}:${stat.ino}`;
}

function currentLockTimeMs(): number {
    const value = lockTestControl?.nowMs?.() ?? Date.now();
    if (!Number.isFinite(value)) throw new ConversationStateStoreError("lock test clock 返回了无效时间", "INVALID_LOCK_CLOCK");
    return value;
}

async function invokeLockTestHook(
    phase: ConversationStateLockTestPhase,
    paths: SafePaths,
    token: string,
    fencingToken: string,
): Promise<void> {
    await lockTestControl?.onPhase?.({ phase, lockPath: paths.lockPath, token, fencingToken, nowMs: currentLockTimeMs() });
}

function asLockFencedError(error: unknown, token: string): ConversationStateLockFencedError {
    if (error instanceof ConversationStateLockFencedError) return error;
    return new ConversationStateLockFencedError(`conversation-state lock ${token} 已失去所有权：${error instanceof Error ? error.message : String(error)}`);
}

function parseLockMetadata(raw: string): LockMetadata | null {
    try {
        const value = JSON.parse(raw) as unknown;
        if (!isRecord(value)) return null;
        assertExactKeys(value, ["schemaVersion", "kind", "token", "fencingToken", "ownerPid", "acquiredAt", "heartbeatAt", "expiresAt", "rootIdentity"], "conversation-state lock metadata");
        if (value.schemaVersion !== 1
            || value.kind !== "record-conversation-state-lock"
            || !isNonEmptyString(value.token)
            || !isNonEmptyString(value.fencingToken)
            || typeof value.ownerPid !== "number"
            || !Number.isInteger(value.ownerPid)
            || value.ownerPid <= 0
            || !isIsoDate(value.acquiredAt)
            || !isIsoDate(value.heartbeatAt)
            || !isIsoDate(value.expiresAt)
            || Date.parse(value.acquiredAt) > Date.parse(value.heartbeatAt)
            || Date.parse(value.heartbeatAt) >= Date.parse(value.expiresAt)
            || !isNonEmptyString(value.rootIdentity)) return null;
        return value as unknown as LockMetadata;
    } catch {
        return null;
    }
}

function cloneIndex(index: RecordConversationStateIndex): RecordConversationStateIndex {
    return JSON.parse(JSON.stringify(index)) as RecordConversationStateIndex;
}

function cloneEntry(entry: ConversationStateEntry): ConversationStateEntry {
    return JSON.parse(JSON.stringify(entry)) as ConversationStateEntry;
}

function cloneEvidence(evidence: ConversationStateEvidence): ConversationStateEvidence {
    return JSON.parse(JSON.stringify(evidence)) as ConversationStateEvidence;
}

function uniqueSorted(values: string[]): string[] {
    return [...new Set(values)].sort();
}

function preferNullableString(current: string | null, candidate: string | null | undefined): string | null {
    if (candidate === undefined || candidate === null || candidate.length === 0) return current;
    return candidate;
}

function nowIso(nowMs?: number): string {
    return new Date(nowMs ?? Date.now()).toISOString();
}

function isIsoDate(value: unknown): value is string {
    return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRecord(value: Record<string, unknown>): boolean {
    try {
        JSON.stringify(value);
        return true;
    } catch {
        return false;
    }
}

function stableJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function samePath(left: string, right: string): boolean {
    const normalize = (value: string) => path.normalize(value).replace(/[\\/]+$/u, "");
    const normalizedLeft = normalize(left);
    const normalizedRight = normalize(right);
    return process.platform === "win32"
        ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
        : normalizedLeft === normalizedRight;
}

function isErrno(error: unknown, code: string): boolean {
    return (error as NodeJS.ErrnoException).code === code;
}

function isTransientWindowsSnapshotRace(error: unknown): boolean {
    return error instanceof ConversationStateSnapshotRaceError
        || process.platform === "win32" && ["EBADF", "EACCES", "EBUSY", "EPERM"].some(code => isErrno(error, code));
}
