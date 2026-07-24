import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DATA_ROOT } from "./store.js";
import { SOURCE_CHAINS, type FencingToken, type SourceChain } from "./record-scheduler-contracts.js";

export const RECORD_WORK_REGISTRY_SCHEMA_VERSION = 2 as const;
export const RECORD_WORK_MANIFEST_SCHEMA_VERSION = 1 as const;
export const DEFAULT_RECORD_WORK_LEASE_MS = 60_000;
export const DEFAULT_RECORD_WORK_LOCK_LEASE_MS = 60_000;
export const DEFAULT_RECORD_WORK_LOCK_WAIT_MS = 10_000;
const REGISTRY_LOCK_IDENTITY_RETRY_LIMIT = 3;
const REGISTRY_LOCK_RESTORE_RETRY_LIMIT = 50;
const REGISTRY_LOCK_RETRY_DELAY_MS = 1;
const REGISTRY_LOCK_RECLAIM_BARRIER_MIN_LEASE_MS = 1_000;

export interface CanonicalConversationIdentity {
    chain: SourceChain;
    workspaceHash: string;
    conversationId: string;
}

export interface RecordWorkRegistryLocation {
    identity: CanonicalConversationIdentity;
    dataRoot?: string;
    lockOptions?: RecordWorkRegistryLockOptions;
}

export interface RecordWorkRegistryLockOptions {
    leaseMs?: number;
    waitMs?: number;
    heartbeatMs?: number;
}

export interface RecordWorkOwnerLease {
    workLeaseId: string;
    ownerId: string;
    schedulerEpoch: number;
    acquiredAt: string;
    expiresAt: string;
}

export type RecordWorkRegistryState = "Active" | "Superseded";

export interface RecordWorkRegistryEntry {
    recordWorkKey: string;
    desiredRevision: string;
    state: RecordWorkRegistryState;
    recordCommitEpoch: number;
    currentFencingToken: number;
    activeTaskIds: string[];
    retiredTaskIds?: string[];
    ownerLease: RecordWorkOwnerLease | null;
    publicationClaim?: RecordWorkPublicationClaim;
    publicationHistory?: RecordWorkPublicationHistoryEntry[];
    createdAt: string;
    updatedAt: string;
    supersededAt?: string;
    supersededByRecordWorkKey?: string;
}

export interface RecordWorkPublicationClaim {
    commitId: string;
    inputHash: string;
    bodyHash: string;
    coveredRevision: string;
    metadataHash: string;
    metadataSnapshot: Record<string, unknown>;
    taskId: string;
    ownerId: string;
    schedulerEpoch: number;
    recordCommitEpoch: number;
    fencingToken: number;
    workLeaseId: string;
    claimedAt: string;
}

export interface RecordWorkPublicationHistoryEntry {
    claim: RecordWorkPublicationClaim;
    supersededByTaskId: string;
    supersededAt: string;
    nextRecordCommitEpoch: number;
    artifactStateHash: string;
    reason: "visible_artifacts_diverged" | "manual_record_mutation";
    rolloverTrigger?: "force_refresh" | "manual_edit" | "manual_delete";
}

export interface RecordWorkRegistry {
    schemaVersion: typeof RECORD_WORK_REGISTRY_SCHEMA_VERSION;
    kind: "record-work-registry";
    identity: CanonicalConversationIdentity;
    registryRevision: number;
    recordCommitEpochCursor: number;
    fencingTokenCursor: number;
    works: RecordWorkRegistryEntry[];
    createdAt: string;
    updatedAt: string;
    persistedHash: string;
}

export type RecordWorkDurabilityMode = "posix_file_and_directory_fsync" | "windows_process_crash_atomic_replace";

export interface RecordWorkDurabilityReceipt {
    mode: RecordWorkDurabilityMode;
    temporaryFileSynced: true;
    targetFileSynced: true;
    targetReadBackVerified: true;
    atomicReplace: true;
    parentDirectoryFsync: boolean;
    suddenPowerLossDurabilityClaimed: boolean;
}

export interface RecordWorkIdentityManifest {
    schemaVersion: typeof RECORD_WORK_MANIFEST_SCHEMA_VERSION;
    kind: "record-work-identity-manifest";
    identity: CanonicalConversationIdentity;
    conversationKey: string;
    state: "Prepared" | "Published";
    manifestRevision: number;
    firstPublicationTokenHash: string;
    registryPath: string;
    publishedRegistryRevision?: number;
    publishedRegistryHash?: string;
    recordCommitEpochFloor: number;
    fencingTokenFloor: number;
    durability: RecordWorkDurabilityReceipt;
    createdAt: string;
    updatedAt: string;
    persistedHash: string;
}

export type RecordWorkRegistryRepairReason =
    | "manifest_missing"
    | "manifest_unreadable"
    | "manifest_invalid_json"
    | "manifest_invalid"
    | "manifest_identity_mismatch"
    | "manifest_hash_mismatch"
    | "publication_not_completed"
    | "registry_missing"
    | "registry_unreadable"
    | "registry_invalid_json"
    | "invalid_registry"
    | "identity_mismatch"
    | "hash_mismatch"
    | "manifest_registry_mismatch";

export interface RecordWorkRegistryRepairRequired {
    kind: "repair_required";
    reason: RecordWorkRegistryRepairReason;
    path: string;
}

export interface RecordWorkRegistryReady {
    kind: "ready";
    path: string;
    registry: RecordWorkRegistry;
    manifest: RecordWorkIdentityManifest;
}

export type ReadRecordWorkRegistryResult = RecordWorkRegistryReady | RecordWorkRegistryRepairRequired;

export type CreateRecordWorkRegistryResult =
    | { kind: "created"; path: string; registry: RecordWorkRegistry; manifest: RecordWorkIdentityManifest }
    | { kind: "already_exists"; path: string; registry: RecordWorkRegistry; manifest: RecordWorkIdentityManifest }
    | { kind: "publication_rejected"; reason: "token_mismatch"; path: string }
    | RecordWorkRegistryRepairRequired;

export type InitializeRecordWorkRegistryIdentityResult =
    | { kind: "prepared" | "already_prepared"; path: string; manifest: RecordWorkIdentityManifest }
    | { kind: "already_published"; path: string; manifest: RecordWorkIdentityManifest }
    | { kind: "publication_rejected"; reason: "token_mismatch"; path: string }
    | RecordWorkRegistryRepairRequired;

export interface RecordWorkRegistryCasConflict {
    kind: "cas_conflict";
    path: string;
    expectedRegistryRevision: number;
    actualRegistryRevision: number;
}

export interface StartOrAttachRecordWorkInput extends RecordWorkRegistryLocation {
    desiredRevision: string;
    taskId: string;
    expectedRegistryRevision: number;
    nowMs?: number;
}

export type StartOrAttachRecordWorkResult =
    | { kind: "started"; disposition: "created" | "attached"; path: string; registry: RecordWorkRegistry; work: RecordWorkRegistryEntry }
    | { kind: "superseded"; path: string; registry: RecordWorkRegistry; work: RecordWorkRegistryEntry; supersededByRecordWorkKey?: string }
    | RecordWorkRegistryCasConflict
    | RecordWorkRegistryRepairRequired;

export interface DetachRecordWorkTaskInput extends RecordWorkRegistryLocation {
    recordWorkKey: string;
    taskId: string;
    expectedRegistryRevision: number;
    nowMs?: number;
}

export type DetachRecordWorkTaskResult =
    | { kind: "detached"; path: string; registry: RecordWorkRegistry; work: RecordWorkRegistryEntry; remainingActiveTaskIds: string[] }
    | { kind: "work_missing" | "task_not_attached"; path: string; registry: RecordWorkRegistry }
    | RecordWorkRegistryCasConflict
    | RecordWorkRegistryRepairRequired;

export interface AcquireRecordWorkLeaseInput extends RecordWorkRegistryLocation {
    recordWorkKey: string;
    taskId: string;
    ownerId: string;
    schedulerEpoch: number;
    expectedRegistryRevision: number;
    workLeaseId?: string;
    leaseDurationMs?: number;
    nowMs?: number;
}

export type AcquireRecordWorkLeaseResult =
    | { kind: "acquired"; disposition: "new" | "renewed"; path: string; registry: RecordWorkRegistry; work: RecordWorkRegistryEntry; lease: RecordWorkOwnerLease; fence: FencingToken }
    | { kind: "lease_held"; path: string; registry: RecordWorkRegistry; work: RecordWorkRegistryEntry; lease: RecordWorkOwnerLease }
    | { kind: "work_missing" | "task_not_attached" | "superseded"; path: string; registry: RecordWorkRegistry; work?: RecordWorkRegistryEntry }
    | RecordWorkRegistryCasConflict
    | RecordWorkRegistryRepairRequired;

export interface RecoverRecordWorkLeaseInput extends RecordWorkRegistryLocation {
    recordWorkKey: string;
    taskId: string;
    ownerId: string;
    schedulerEpoch: number;
    expectedFence: FencingToken;
    expectedRegistryRevision: number;
    leaseDurationMs?: number;
    nowMs?: number;
}

export type RecoverRecordWorkLeaseRejectionReason =
    | "work_missing"
    | "work_superseded"
    | "task_not_attached"
    | "lease_missing"
    | "record_commit_epoch_mismatch"
    | "lease_mismatch"
    | "fencing_token_mismatch"
    | "scheduler_epoch_mismatch"
    | "owner_mismatch"
    | "publication_claim_mismatch";

export type RecoverRecordWorkLeaseResult =
    | {
        kind: "recovered";
        disposition: "transferred" | "already_recovered";
        path: string;
        registry: RecordWorkRegistry;
        work: RecordWorkRegistryEntry;
        lease: RecordWorkOwnerLease;
        fence: FencingToken;
    }
    | {
        kind: "rejected";
        path: string;
        registry: RecordWorkRegistry;
        reason: RecoverRecordWorkLeaseRejectionReason;
        work?: RecordWorkRegistryEntry;
        lease?: RecordWorkOwnerLease;
    }
    | RecordWorkRegistryCasConflict
    | RecordWorkRegistryRepairRequired;

export interface AdvanceRecordWorkFenceInput extends RecordWorkRegistryLocation {
    recordWorkKey: string;
    taskId: string;
    ownerId: string;
    fence: FencingToken;
    expectedRegistryRevision: number;
    leaseDurationMs?: number;
    nowMs?: number;
}

export type AdvanceRecordWorkFenceRejectionReason =
    | "work_missing"
    | "work_superseded"
    | "task_not_attached"
    | "lease_missing"
    | "publication_claimed"
    | "owner_mismatch"
    | "scheduler_epoch_mismatch"
    | "record_commit_epoch_mismatch"
    | "lease_mismatch"
    | "fencing_token_mismatch";

export type AdvanceRecordWorkFenceResult =
    | {
        kind: "advanced";
        path: string;
        registryRevision: number;
        registry: RecordWorkRegistry;
        work: RecordWorkRegistryEntry;
        lease: RecordWorkOwnerLease;
        fence: FencingToken;
    }
    | {
        kind: "rejected";
        path: string;
        registry: RecordWorkRegistry;
        reason: AdvanceRecordWorkFenceRejectionReason;
        work?: RecordWorkRegistryEntry;
    }
    | RecordWorkRegistryCasConflict
    | RecordWorkRegistryRepairRequired;

export type ConditionalCommitRejectionReason =
    | "registry_revision_mismatch"
    | "work_missing"
    | "work_superseded"
    | "task_detached"
    | "lease_missing"
    | "lease_expired"
    | "lease_mismatch"
    | "owner_mismatch"
    | "scheduler_epoch_mismatch"
    | "record_commit_epoch_mismatch"
    | "fencing_token_mismatch";

export interface ConditionalCommitAuthorizationInput extends RecordWorkRegistryLocation {
    recordWorkKey: string;
    taskId: string;
    ownerId: string;
    fence: FencingToken;
    expectedRegistryRevision?: number;
    nowMs?: number;
}

export interface ConditionalCommitAuthorization {
    path: string;
    registryRevision: number;
    identity: CanonicalConversationIdentity;
    recordWorkKey: string;
    recordCommitEpoch: number;
    fence: FencingToken;
}

export interface RecordWorkPublicationClaimInput extends ConditionalCommitAuthorizationInput {
    commitId: string;
    inputHash: string;
    bodyHash: string;
    coveredRevision: string;
    metadataHash: string;
    metadataSnapshot: Record<string, unknown>;
}

export type RecordWorkPublicationClaimResult =
    | {
        kind: "claimed" | "recovered" | "reused" | "conflict";
        path: string;
        registry: RecordWorkRegistry;
        work: RecordWorkRegistryEntry;
        authorization: ConditionalCommitAuthorization;
        claim: RecordWorkPublicationClaim;
    }
    | Exclude<ConditionalCommitAuthorizationResult, { kind: "authorized" }>;

export type RecordWorkPublicationRolloverVerification =
    | { kind: "consistent"; artifactStateHash?: string }
    | { kind: "diverged"; artifactStateHash: string }
    | { kind: "unresolved"; reason: string };

export interface RolloverRecordWorkPublicationInput extends ConditionalCommitAuthorizationInput {
    leaseDurationMs?: number;
    rolloverMode?: "repair_divergence" | "force_refresh";
    withArtifactVerification: (
        claim: Readonly<RecordWorkPublicationClaim>,
        apply: (verification: RecordWorkPublicationRolloverVerification) => Promise<RolloverRecordWorkPublicationResult>,
    ) => Promise<RolloverRecordWorkPublicationResult>;
}

export type RolloverRecordWorkPublicationResult =
    | {
        kind: "rolled_over";
        path: string;
        registry: RecordWorkRegistry;
        work: RecordWorkRegistryEntry;
        lease: RecordWorkOwnerLease;
        fence: FencingToken;
        previousClaim: RecordWorkPublicationClaim;
        history: RecordWorkPublicationHistoryEntry;
    }
    | {
        kind: "not_required";
        reason: "publication_claim_missing" | "artifacts_match_claim";
        path: string;
        registry: RecordWorkRegistry;
        work: RecordWorkRegistryEntry;
        claim?: RecordWorkPublicationClaim;
    }
    | {
        kind: "rejected";
        reason: ConditionalCommitRejectionReason | "artifact_unresolved" | "force_refresh_artifacts_not_consistent";
        detail?: string;
        path: string;
        registryRevision: number;
        work?: RecordWorkRegistryEntry;
        claim?: RecordWorkPublicationClaim;
    }
    | RecordWorkRegistryRepairRequired;

export type RecordWorkPublicationAuthorityResult<Value> =
    | {
        kind: "committed";
        authorization: ConditionalCommitAuthorization;
        claim: RecordWorkPublicationClaim;
        value: Value;
    }
    | {
        kind: "reused" | "conflict" | "claim_missing";
        path: string;
        registryRevision: number;
        claim?: RecordWorkPublicationClaim;
    }
    | Exclude<ConditionalCommitAuthorizationResult, { kind: "authorized" }>;

export type RecordWorkManualMutationKind = "manual_edit" | "manual_delete";

export interface RecordWorkManualMutationInput extends RecordWorkRegistryLocation {
    mutationKind: RecordWorkManualMutationKind;
    artifactLockHeld: true;
    mutationId?: string;
    nowMs?: number;
}

export type RecordWorkManualMutationResult<Value> =
    | {
        kind: "mutated";
        path: string;
        registry: RecordWorkRegistry | null;
        mutationId: string;
        fencedRecordWorkKeys: string[];
        value: Value;
    }
    | RecordWorkRegistryRepairRequired;

export interface RecordWorkCommitToken {
    kind: "record-work-commit-token";
    tokenId: string;
    identity: CanonicalConversationIdentity;
    recordWorkKey: string;
    taskId: string;
    ownerId: string;
    authorizedRegistryRevision: number;
    fence: FencingToken;
    issuedAt: string;
    integrityHash: string;
}

export type ConditionalCommitAuthorizationResult =
    | { kind: "authorized"; authorization: ConditionalCommitAuthorization }
    | { kind: "rejected"; path: string; registryRevision: number; reason: ConditionalCommitRejectionReason }
    | RecordWorkRegistryRepairRequired;

export type PrepareRecordWorkCommitResult =
    | { kind: "prepared"; authorization: ConditionalCommitAuthorization; commitToken: RecordWorkCommitToken }
    | Exclude<ConditionalCommitAuthorizationResult, { kind: "authorized" }>;

export type ConditionalCommitExecutionResult<Value> =
    | { kind: "staged"; authorization: ConditionalCommitAuthorization; commitToken: RecordWorkCommitToken; value: Value }
    | { kind: "invalid_commit_token"; reason: "identity_mismatch" | "integrity_mismatch"; path: string }
    | Exclude<ConditionalCommitAuthorizationResult, { kind: "authorized" }>;

export type PublishRecordWorkCommitResult<Value> =
    | { kind: "committed"; authorization: ConditionalCommitAuthorization; commitToken: RecordWorkCommitToken; value: Value }
    | { kind: "invalid_commit_token"; reason: "identity_mismatch" | "integrity_mismatch"; path: string }
    | Exclude<ConditionalCommitAuthorizationResult, { kind: "authorized" }>;

export interface RecordWorkCommitAuthorityOptions {
    allowDetachedCleanup?: boolean;
    detachedCleanupMustBeExclusive?: boolean;
}

export type RecordWorkCommitAuthorityResult<Value> =
    | { kind: "committed"; authorization: ConditionalCommitAuthorization; value: Value }
    | Exclude<ConditionalCommitAuthorizationResult, { kind: "authorized" }>;

interface RegistryFileLock {
    token: string;
    fileHandle: fs.promises.FileHandle;
    path: string;
    acquiredAt: string;
    leaseMs: number;
    heartbeatMs: number;
    heartbeatTimer?: NodeJS.Timeout;
    heartbeatInFlight?: Promise<void>;
    ownershipError?: Error;
    released: boolean;
    metadataTail: Promise<void>;
}

interface RegistryLockFileIdentity {
    dev: number;
    ino: number;
}

interface PersistedRegistryFileLock {
    token: string;
    acquiredAt: string;
    expiresAt: string;
    heartbeatMs: number;
    releasedAt?: string;
}

interface RegistryLockReclaimBarrier {
    token: string;
    acquiredAt: string;
    expiresAt: string;
    releasedAt?: string;
}

interface RegistryLockInspection {
    exists: boolean;
    state?: Partial<PersistedRegistryFileLock>;
    reclaimable: boolean;
}

interface RegistryLockReclaimBarrierHandle {
    token: string;
    path: string;
    fileHandle: fs.promises.FileHandle;
    leaseMs: number;
    acquiredAt: string;
}

interface RegistryLockReclaimBarrierInspection {
    exists: boolean;
    state?: Partial<RegistryLockReclaimBarrier>;
    active: boolean;
    reclaimable: boolean;
}

interface RegistryLockTestHooks {
    afterReclaimValidated?: (details: { lockPath: string; reclaimPath: string }) => void | Promise<void>;
    afterReclaimBarrierRetireValidated?: (details: { reclaimPath: string; observedToken?: string }) => void | Promise<void>;
    beforeInitialLockStateWrite?: (details: { lockPath: string; token: string }) => void | Promise<void>;
    beforeFailedAcquireLockCleanup?: (details: { lockPath: string; token: string }) => void | Promise<void>;
    beforeFailedAcquireLockDelete?: (details: { lockPath: string; token: string }) => void | Promise<void>;
}

interface MutationSuccess<Value> {
    kind: "updated";
    path: string;
    registry: RecordWorkRegistry;
    value: Value;
}

type MutationResult<Value> = MutationSuccess<Value> | RecordWorkRegistryCasConflict | RecordWorkRegistryRepairRequired;

interface MutationDecision<Value> {
    changed: boolean;
    value: Value;
}

type StartMutationValue =
    | { kind: "started"; disposition: "created" | "attached"; work: RecordWorkRegistryEntry }
    | { kind: "superseded"; work: RecordWorkRegistryEntry; supersededByRecordWorkKey?: string };

type DetachMutationValue =
    | { kind: "detached"; work: RecordWorkRegistryEntry }
    | { kind: "work_missing" }
    | { kind: "task_not_attached" };

type LeaseMutationValue =
    | { kind: "acquired"; disposition: "new" | "renewed"; work: RecordWorkRegistryEntry }
    | { kind: "lease_held"; work: RecordWorkRegistryEntry; lease: RecordWorkOwnerLease }
    | { kind: "work_missing" }
    | { kind: "task_not_attached"; work: RecordWorkRegistryEntry }
    | { kind: "superseded"; work: RecordWorkRegistryEntry };

type RecoverLeaseMutationValue =
    | { kind: "recovered"; disposition: "transferred" | "already_recovered"; work: RecordWorkRegistryEntry }
    | { kind: "rejected"; reason: RecoverRecordWorkLeaseRejectionReason; work?: RecordWorkRegistryEntry; lease?: RecordWorkOwnerLease };

type AdvanceRecordWorkFenceMutationValue =
    | { kind: "advanced"; work: RecordWorkRegistryEntry }
    | { kind: "rejected"; reason: AdvanceRecordWorkFenceRejectionReason; work?: RecordWorkRegistryEntry };

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is string {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isUnique(values: readonly string[]): boolean {
    return new Set(values).size === values.length;
}

function isSorted(values: readonly string[]): boolean {
    return values.every((value, index) => index === 0 || values[index - 1].localeCompare(value) <= 0);
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function sha256(value: unknown): string {
    return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function clone<Value>(value: Value): Value {
    return structuredClone(value);
}

function normalizeTaskIds(taskIds: readonly string[]): string[] {
    return [...new Set(taskIds)].sort((left, right) => left.localeCompare(right));
}

function nowIso(nowMs: number | undefined): string {
    return new Date(nowMs ?? Date.now()).toISOString();
}

function resolvedDataRoot(location: RecordWorkRegistryLocation): string {
    return location.dataRoot || DATA_ROOT;
}

function assertIdentity(identity: CanonicalConversationIdentity): void {
    if (!SOURCE_CHAINS.includes(identity.chain)) throw new Error(`未知 source chain: ${identity.chain}`);
    if (!isNonEmptyString(identity.workspaceHash)) throw new Error("workspaceHash 不能为空");
    if (!isNonEmptyString(identity.conversationId)) throw new Error("conversationId 不能为空");
}

function sameIdentity(left: CanonicalConversationIdentity, right: CanonicalConversationIdentity): boolean {
    return left.chain === right.chain
        && left.workspaceHash === right.workspaceHash
        && left.conversationId === right.conversationId;
}

export function canonicalConversationKey(identity: CanonicalConversationIdentity): string {
    assertIdentity(identity);
    return sha256({ kind: "canonical-conversation-v1", ...identity });
}

export function recordWorkKey(identity: CanonicalConversationIdentity, desiredRevision: string): string {
    assertIdentity(identity);
    if (!isNonEmptyString(desiredRevision)) throw new Error("desiredRevision 不能为空");
    return sha256({ kind: "record-work-v1", ...identity, desiredRevision });
}

export function recordWorkRegistryDirectory(location: RecordWorkRegistryLocation): string {
    assertIdentity(location.identity);
    return path.join(resolvedDataRoot(location), "record-recovery", "record-work");
}

export function recordWorkRegistryPath(location: RecordWorkRegistryLocation): string {
    return path.join(recordWorkRegistryDirectory(location), `${canonicalConversationKey(location.identity)}.json`);
}

export function recordWorkIdentityManifestPath(location: RecordWorkRegistryLocation): string {
    return path.join(recordWorkRegistryDirectory(location), `${canonicalConversationKey(location.identity)}.manifest.json`);
}

function recordWorkRegistryLockPath(location: RecordWorkRegistryLocation): string {
    return path.join(recordWorkRegistryDirectory(location), `${canonicalConversationKey(location.identity)}.lock`);
}

function recordWorkRegistryReclaimPath(lockPath: string): string {
    return `${lockPath}.reclaim`;
}

function registryHash(registry: Omit<RecordWorkRegistry, "persistedHash">): string {
    return sha256(registry);
}

function withRegistryHash(registry: Omit<RecordWorkRegistry, "persistedHash">): RecordWorkRegistry {
    return { ...registry, persistedHash: registryHash(registry) };
}

function manifestHash(manifest: Omit<RecordWorkIdentityManifest, "persistedHash">): string {
    return sha256(manifest);
}

function withManifestHash(manifest: Omit<RecordWorkIdentityManifest, "persistedHash">): RecordWorkIdentityManifest {
    return { ...manifest, persistedHash: manifestHash(manifest) };
}

function publicationTokenHash(identity: CanonicalConversationIdentity, token: string): string {
    return sha256({ kind: "record-work-first-publication-v1", conversationKey: canonicalConversationKey(identity), token });
}

function assertFirstPublicationToken(token: string): void {
    if (!isNonEmptyString(token) || token.length < 16) throw new Error("firstPublicationToken 必须至少包含 16 个字符");
}

function durabilityReceipt(): RecordWorkDurabilityReceipt {
    return process.platform === "win32"
        ? {
            mode: "windows_process_crash_atomic_replace",
            temporaryFileSynced: true,
            targetFileSynced: true,
            targetReadBackVerified: true,
            atomicReplace: true,
            parentDirectoryFsync: false,
            suddenPowerLossDurabilityClaimed: false,
        }
        : {
            mode: "posix_file_and_directory_fsync",
            temporaryFileSynced: true,
            targetFileSynced: true,
            targetReadBackVerified: true,
            atomicReplace: true,
            parentDirectoryFsync: true,
            suddenPowerLossDurabilityClaimed: true,
        };
}
async function replaceFileAtomically(temporaryPath: string, targetPath: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await fs.promises.rename(temporaryPath, targetPath);
            return;
        } catch (error) {
            lastError = error;
            const code = (error as NodeJS.ErrnoException).code;
            if (!new Set(["EPERM", "EACCES", "EBUSY"]).has(code || "") || attempt >= 4) break;
            await sleep(10 * (2 ** attempt));
        }
    }
    throw lastError;
}

async function syncFile(filePath: string): Promise<void> {
    const fileHandle = await fs.promises.open(filePath, "r+");
    try {
        await fileHandle.sync();
    } finally {
        await fileHandle.close();
    }
}

async function syncParentDirectory(directoryPath: string): Promise<void> {
    if (process.platform === "win32") return;
    const directoryHandle = await fs.promises.open(directoryPath, fs.constants.O_RDONLY);
    try {
        await directoryHandle.sync();
    } finally {
        await directoryHandle.close();
    }
}

async function writeJsonDurableAtomic(filePath: string, value: unknown): Promise<void> {
    const directoryPath = path.dirname(filePath);
    await fs.promises.mkdir(directoryPath, { recursive: true });
    const temporaryPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
    const bytes = Buffer.from(JSON.stringify(value, null, 2), "utf8");
    let temporaryHandle: fs.promises.FileHandle | undefined;
    try {
        temporaryHandle = await fs.promises.open(temporaryPath, "wx", 0o600);
        await temporaryHandle.writeFile(bytes);
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = undefined;
        await replaceFileAtomically(temporaryPath, filePath);
        await syncFile(filePath);
        const readBack = await fs.promises.readFile(filePath);
        if (!readBack.equals(bytes)) throw new Error(`Record work durable readback 不一致: ${filePath}`);
        await syncParentDirectory(directoryPath);
    } catch (error) {
        if (temporaryHandle) await temporaryHandle.close().catch(() => undefined);
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

function validateLease(value: unknown): value is RecordWorkOwnerLease {
    return isPlainObject(value)
        && isNonEmptyString(value.workLeaseId)
        && isNonEmptyString(value.ownerId)
        && isPositiveInteger(value.schedulerEpoch)
        && isTimestamp(value.acquiredAt)
        && isTimestamp(value.expiresAt)
        && Date.parse(value.expiresAt) > Date.parse(value.acquiredAt);
}

function validatePublicationClaim(value: unknown): value is RecordWorkPublicationClaim {
    if (!isPlainObject(value)
        || !isNonEmptyString(value.commitId)
        || !isNonEmptyString(value.inputHash)
        || !isNonEmptyString(value.bodyHash)
        || !isNonEmptyString(value.coveredRevision)
        || !isNonEmptyString(value.metadataHash)
        || !isPlainObject(value.metadataSnapshot)
        || !isNonEmptyString(value.taskId)
        || !isNonEmptyString(value.ownerId)
        || !isPositiveInteger(value.schedulerEpoch)
        || !isPositiveInteger(value.recordCommitEpoch)
        || !isPositiveInteger(value.fencingToken)
        || !isNonEmptyString(value.workLeaseId)
        || !isTimestamp(value.claimedAt)) return false;
    return true;
}

function validatePublicationHistoryEntry(value: unknown): value is RecordWorkPublicationHistoryEntry {
    return isPlainObject(value)
        && validatePublicationClaim(value.claim)
        && isNonEmptyString(value.supersededByTaskId)
        && isTimestamp(value.supersededAt)
        && isPositiveInteger(value.nextRecordCommitEpoch)
        && value.nextRecordCommitEpoch > value.claim.recordCommitEpoch
        && typeof value.artifactStateHash === "string"
        && /^[0-9a-f]{64}$/u.test(value.artifactStateHash)
        && ((value.reason === "visible_artifacts_diverged"
            && (value.rolloverTrigger === undefined || value.rolloverTrigger === "force_refresh"))
            || (value.reason === "manual_record_mutation"
                && (value.rolloverTrigger === "manual_edit" || value.rolloverTrigger === "manual_delete")));
}

function validateWorkEntry(value: unknown, identity: CanonicalConversationIdentity): value is RecordWorkRegistryEntry {
    if (!isPlainObject(value)
        || !isNonEmptyString(value.recordWorkKey)
        || !isNonEmptyString(value.desiredRevision)
        || (value.state !== "Active" && value.state !== "Superseded")
        || !isPositiveInteger(value.recordCommitEpoch)
        || !isNonNegativeInteger(value.currentFencingToken)
        || !Array.isArray(value.activeTaskIds)
        || !value.activeTaskIds.every(isNonEmptyString)
        || !isUnique(value.activeTaskIds)
        || !isSorted(value.activeTaskIds)
        || !(value.retiredTaskIds === undefined
            || (Array.isArray(value.retiredTaskIds)
                && value.retiredTaskIds.every(isNonEmptyString)
                && isUnique(value.retiredTaskIds)
                && isSorted(value.retiredTaskIds)))
        || !(value.ownerLease === null || validateLease(value.ownerLease))
        || !(value.publicationClaim === undefined || validatePublicationClaim(value.publicationClaim))
        || !(value.publicationHistory === undefined
            || (Array.isArray(value.publicationHistory) && value.publicationHistory.every(validatePublicationHistoryEntry)))
        || !isTimestamp(value.createdAt)
        || !isTimestamp(value.updatedAt)
        || (value.supersededAt !== undefined && !isTimestamp(value.supersededAt))
        || (value.supersededByRecordWorkKey !== undefined && !isNonEmptyString(value.supersededByRecordWorkKey))) return false;
    const candidate = value as unknown as RecordWorkRegistryEntry;
    if (candidate.recordWorkKey !== recordWorkKey(identity, candidate.desiredRevision)) return false;
    if (candidate.state === "Active" && (candidate.supersededAt !== undefined || candidate.supersededByRecordWorkKey !== undefined)) return false;
    if (candidate.state === "Superseded" && (candidate.ownerLease !== null || !isTimestamp(candidate.supersededAt))) return false;
    if (candidate.publicationClaim && (candidate.publicationClaim.coveredRevision !== candidate.desiredRevision
        || candidate.publicationClaim.recordCommitEpoch !== candidate.recordCommitEpoch)) return false;
    const publicationHistory = candidate.publicationHistory || [];
    if (publicationHistory.some(entry => entry.claim.coveredRevision !== candidate.desiredRevision
        || entry.nextRecordCommitEpoch > candidate.recordCommitEpoch)) return false;
    if (!isUnique(publicationHistory.map(entry => entry.claim.commitId))
        || !isUnique(publicationHistory.map(entry => String(entry.nextRecordCommitEpoch)))) return false;
    if (publicationHistory.some((entry, index) => index > 0
        && publicationHistory[index - 1]!.nextRecordCommitEpoch >= entry.nextRecordCommitEpoch)) return false;
    if (candidate.publicationClaim && publicationHistory.some(entry => entry.claim.commitId === candidate.publicationClaim?.commitId)) return false;
    if (candidate.activeTaskIds.some(taskId => candidate.retiredTaskIds?.includes(taskId))) return false;
    return true;
}

function validateRegistry(value: unknown, identity: CanonicalConversationIdentity): value is RecordWorkRegistry {
    if (!isPlainObject(value)
        || value.schemaVersion !== RECORD_WORK_REGISTRY_SCHEMA_VERSION
        || value.kind !== "record-work-registry"
        || !isPlainObject(value.identity)
        || !isPositiveInteger(value.registryRevision)
        || !isNonNegativeInteger(value.recordCommitEpochCursor)
        || !isNonNegativeInteger(value.fencingTokenCursor)
        || !Array.isArray(value.works)
        || !isTimestamp(value.createdAt)
        || !isTimestamp(value.updatedAt)
        || !isNonEmptyString(value.persistedHash)) return false;
    const candidate = value as unknown as RecordWorkRegistry;
    const storedIdentity = candidate.identity;
    if (!sameIdentity(storedIdentity, identity) || !validateIdentity(storedIdentity)) return false;
    if (!candidate.works.every(work => validateWorkEntry(work, identity))) return false;
    const works = candidate.works;
    if (!isUnique(works.map(work => work.recordWorkKey))) return false;
    if (!isUnique(works.map(work => work.desiredRevision))) return false;
    if (!isUnique(works.map(work => String(work.recordCommitEpoch)))) return false;
    if (works.filter(work => work.state === "Active").length > 1) return false;
    if (works.some(work => work.recordCommitEpoch > candidate.recordCommitEpochCursor || work.currentFencingToken > candidate.fencingTokenCursor)) return false;
    const { persistedHash, ...withoutHash } = candidate;
    return persistedHash === registryHash(withoutHash);
}

function validateIdentity(identity: CanonicalConversationIdentity): boolean {
    return SOURCE_CHAINS.includes(identity.chain)
        && isNonEmptyString(identity.workspaceHash)
        && isNonEmptyString(identity.conversationId);
}

function validateDurabilityReceipt(value: unknown): value is RecordWorkDurabilityReceipt {
    if (!isPlainObject(value)
        || value.temporaryFileSynced !== true
        || value.targetFileSynced !== true
        || value.targetReadBackVerified !== true
        || value.atomicReplace !== true
        || typeof value.parentDirectoryFsync !== "boolean"
        || typeof value.suddenPowerLossDurabilityClaimed !== "boolean") return false;
    return (value.mode === "posix_file_and_directory_fsync" && value.parentDirectoryFsync && value.suddenPowerLossDurabilityClaimed)
        || (value.mode === "windows_process_crash_atomic_replace" && !value.parentDirectoryFsync && !value.suddenPowerLossDurabilityClaimed);
}

function validateManifest(value: unknown, location: RecordWorkRegistryLocation): value is RecordWorkIdentityManifest {
    if (!isPlainObject(value)
        || value.schemaVersion !== RECORD_WORK_MANIFEST_SCHEMA_VERSION
        || value.kind !== "record-work-identity-manifest"
        || !isPlainObject(value.identity)
        || !isNonEmptyString(value.conversationKey)
        || (value.state !== "Prepared" && value.state !== "Published")
        || !isPositiveInteger(value.manifestRevision)
        || !isNonEmptyString(value.firstPublicationTokenHash)
        || !isNonEmptyString(value.registryPath)
        || !isNonNegativeInteger(value.recordCommitEpochFloor)
        || !isNonNegativeInteger(value.fencingTokenFloor)
        || !validateDurabilityReceipt(value.durability)
        || !isTimestamp(value.createdAt)
        || !isTimestamp(value.updatedAt)
        || !isNonEmptyString(value.persistedHash)) return false;
    const candidate = value as unknown as RecordWorkIdentityManifest;
    if (!validateIdentity(candidate.identity) || !sameIdentity(candidate.identity, location.identity)) return false;
    if (candidate.conversationKey !== canonicalConversationKey(location.identity)) return false;
    if (path.resolve(candidate.registryPath) !== path.resolve(recordWorkRegistryPath(location))) return false;
    if (candidate.state === "Prepared") {
        if (candidate.publishedRegistryRevision !== undefined || candidate.publishedRegistryHash !== undefined
            || candidate.recordCommitEpochFloor !== 0 || candidate.fencingTokenFloor !== 0) return false;
    } else if (!isPositiveInteger(candidate.publishedRegistryRevision) || !isNonEmptyString(candidate.publishedRegistryHash)) {
        return false;
    }
    const { persistedHash, ...withoutHash } = candidate;
    return persistedHash === manifestHash(withoutHash);
}

interface LoadedManifest {
    kind: "manifest_ready";
    path: string;
    manifest: RecordWorkIdentityManifest;
}

interface LoadedRegistry {
    kind: "registry_ready";
    path: string;
    registry: RecordWorkRegistry;
}

async function loadManifest(location: RecordWorkRegistryLocation): Promise<LoadedManifest | RecordWorkRegistryRepairRequired> {
    const manifestPath = recordWorkIdentityManifestPath(location);
    let raw: string;
    try {
        raw = await fs.promises.readFile(manifestPath, "utf-8");
    } catch (error) {
        return {
            kind: "repair_required",
            reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "manifest_missing" : "manifest_unreadable",
            path: manifestPath,
        };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { kind: "repair_required", reason: "manifest_invalid_json", path: manifestPath };
    }
    if (!isPlainObject(parsed)) return { kind: "repair_required", reason: "manifest_invalid", path: manifestPath };
    const parsedIdentity = parsed.identity as unknown as CanonicalConversationIdentity;
    if (!isPlainObject(parsed.identity) || !validateIdentity(parsedIdentity) || !sameIdentity(parsedIdentity, location.identity)) {
        return { kind: "repair_required", reason: "manifest_identity_mismatch", path: manifestPath };
    }
    if (!validateManifest(parsed, location)) {
        const { persistedHash, ...withoutHash } = parsed as unknown as RecordWorkIdentityManifest;
        const hashMismatch = isNonEmptyString(persistedHash) && persistedHash !== manifestHash(withoutHash as Omit<RecordWorkIdentityManifest, "persistedHash">);
        return { kind: "repair_required", reason: hashMismatch ? "manifest_hash_mismatch" : "manifest_invalid", path: manifestPath };
    }
    return { kind: "manifest_ready", path: manifestPath, manifest: clone(parsed) };
}

async function loadRegistryFile(location: RecordWorkRegistryLocation): Promise<LoadedRegistry | RecordWorkRegistryRepairRequired> {
    const filePath = recordWorkRegistryPath(location);
    let raw: string;
    try {
        raw = await fs.promises.readFile(filePath, "utf-8");
    } catch (error) {
        return {
            kind: "repair_required",
            reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "registry_missing" : "registry_unreadable",
            path: filePath,
        };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { kind: "repair_required", reason: "registry_invalid_json", path: filePath };
    }
    if (!isPlainObject(parsed)) return { kind: "repair_required", reason: "invalid_registry", path: filePath };
    const parsedIdentity = parsed.identity as unknown as CanonicalConversationIdentity;
    if (!isPlainObject(parsed.identity) || !validateIdentity(parsedIdentity)
        || !sameIdentity(parsedIdentity, location.identity)) {
        return { kind: "repair_required", reason: "identity_mismatch", path: filePath };
    }
    if (!validateRegistry(parsed, location.identity)) {
        const { persistedHash, ...withoutHash } = parsed as unknown as RecordWorkRegistry;
        const hashMismatch = isNonEmptyString(persistedHash) && persistedHash !== registryHash(withoutHash as Omit<RecordWorkRegistry, "persistedHash">);
        return { kind: "repair_required", reason: hashMismatch ? "hash_mismatch" : "invalid_registry", path: filePath };
    }
    return { kind: "registry_ready", path: filePath, registry: clone(parsed) };
}

async function loadRegistry(location: RecordWorkRegistryLocation): Promise<ReadRecordWorkRegistryResult> {
    const loadedManifest = await loadManifest(location);
    if (loadedManifest.kind !== "manifest_ready") return loadedManifest;
    if (loadedManifest.manifest.state !== "Published") {
        return { kind: "repair_required", reason: "publication_not_completed", path: loadedManifest.path };
    }
    const loadedRegistry = await loadRegistryFile(location);
    if (loadedRegistry.kind !== "registry_ready") return loadedRegistry;
    const manifest = loadedManifest.manifest;
    const registry = loadedRegistry.registry;
    if (manifest.publishedRegistryRevision !== registry.registryRevision
        || manifest.publishedRegistryHash !== registry.persistedHash
        || manifest.recordCommitEpochFloor !== registry.recordCommitEpochCursor
        || manifest.fencingTokenFloor !== registry.fencingTokenCursor) {
        return { kind: "repair_required", reason: "manifest_registry_mismatch", path: loadedManifest.path };
    }
    return { kind: "ready", path: loadedRegistry.path, registry, manifest };
}

function createInitialRegistry(identity: CanonicalConversationIdentity, now: string): RecordWorkRegistry {
    return withRegistryHash({
        schemaVersion: RECORD_WORK_REGISTRY_SCHEMA_VERSION,
        kind: "record-work-registry",
        identity: clone(identity),
        registryRevision: 1,
        recordCommitEpochCursor: 0,
        fencingTokenCursor: 0,
        works: [],
        createdAt: now,
        updatedAt: now,
    });
}

function createPreparedManifest(location: RecordWorkRegistryLocation, firstPublicationToken: string, now: string): RecordWorkIdentityManifest {
    return withManifestHash({
        schemaVersion: RECORD_WORK_MANIFEST_SCHEMA_VERSION,
        kind: "record-work-identity-manifest",
        identity: clone(location.identity),
        conversationKey: canonicalConversationKey(location.identity),
        state: "Prepared",
        manifestRevision: 1,
        firstPublicationTokenHash: publicationTokenHash(location.identity, firstPublicationToken),
        registryPath: recordWorkRegistryPath(location),
        recordCommitEpochFloor: 0,
        fencingTokenFloor: 0,
        durability: durabilityReceipt(),
        createdAt: now,
        updatedAt: now,
    });
}

function publishedManifestForRegistry(manifest: RecordWorkIdentityManifest, registry: RecordWorkRegistry, now: string): RecordWorkIdentityManifest {
    const { persistedHash: _persistedHash, ...withoutHash } = manifest;
    return withManifestHash({
        ...withoutHash,
        state: "Published",
        manifestRevision: manifest.manifestRevision + 1,
        publishedRegistryRevision: registry.registryRevision,
        publishedRegistryHash: registry.persistedHash,
        recordCommitEpochFloor: registry.recordCommitEpochCursor,
        fencingTokenFloor: registry.fencingTokenCursor,
        durability: durabilityReceipt(),
        updatedAt: now,
    });
}

function recoverInitialPublishedRegistry(location: RecordWorkRegistryLocation, manifest: RecordWorkIdentityManifest): RecordWorkRegistry | null {
    if (manifest.state !== "Published"
        || manifest.publishedRegistryRevision !== 1
        || manifest.recordCommitEpochFloor !== 0
        || manifest.fencingTokenFloor !== 0) return null;
    const registry = createInitialRegistry(location.identity, manifest.updatedAt);
    return manifest.publishedRegistryHash === registry.persistedHash ? registry : null;
}

export class RecordWorkRegistryLockOwnershipError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RecordWorkRegistryLockOwnershipError";
    }
}

function isPersistedRegistryFileLock(value: Partial<PersistedRegistryFileLock>): value is PersistedRegistryFileLock {
    return isNonEmptyString(value.token)
        && isTimestamp(value.acquiredAt)
        && isTimestamp(value.expiresAt)
        && isPositiveInteger(value.heartbeatMs)
        && (value.releasedAt === undefined || isTimestamp(value.releasedAt));
}

function isReclaimableRegistryLock(state: Partial<PersistedRegistryFileLock>, nowMs: number): boolean {
    if (!isPersistedRegistryFileLock(state)) return false;
    return state.releasedAt !== undefined || Date.parse(state.expiresAt) + state.heartbeatMs <= nowMs;
}

async function inspectRegistryLock(lockPath: string, nowMs: number, leaseMs: number): Promise<RegistryLockInspection> {
    try {
        const parsed = JSON.parse(await fs.promises.readFile(lockPath, "utf8")) as Partial<PersistedRegistryFileLock>;
        return {
            exists: true,
            state: parsed,
            reclaimable: isReclaimableRegistryLock(parsed, nowMs),
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, reclaimable: true };
    }
    try {
        const stat = await fs.promises.stat(lockPath);
        return { exists: true, reclaimable: nowMs - stat.mtimeMs >= leaseMs };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, reclaimable: true };
        return { exists: true, reclaimable: false };
    }
}

function registryLockIdentityChanged(before: RegistryLockInspection, after: RegistryLockInspection): boolean {
    return before.state?.token !== undefined
        && after.state?.token !== undefined
        && before.state.token !== after.state.token;
}

function registryLockTestHooks(): RegistryLockTestHooks | undefined {
    return (globalThis as { [key: symbol]: RegistryLockTestHooks | undefined })[
        Symbol.for("memory-store.record-work-registry.lock-test-hooks")
    ];
}

function registryLockFileIdentity(stats: fs.Stats): RegistryLockFileIdentity {
    return { dev: stats.dev, ino: stats.ino };
}

function isSameRegistryLockFile(left: RegistryLockFileIdentity, right: fs.Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino;
}

function asRegistryLockCleanupError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

async function registryLockPathStillMatchesCreatedLock(lock: RegistryFileLock, createdFileIdentity?: RegistryLockFileIdentity): Promise<boolean> {
    if (createdFileIdentity) {
        try {
            if (isSameRegistryLockFile(createdFileIdentity, await fs.promises.stat(lock.path))) return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
        }
    }
    try {
        const parsed = JSON.parse(await fs.promises.readFile(lock.path, "utf8")) as Partial<PersistedRegistryFileLock>;
        return parsed.token === lock.token;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

async function cleanupFailedRegistryLockAcquisition(
    lock: RegistryFileLock,
    createdFileIdentity: RegistryLockFileIdentity | undefined,
    acquisitionError: unknown,
): Promise<never> {
    const cleanupErrors: Error[] = [];
    const rememberCleanupError = (error: unknown): void => {
        cleanupErrors.push(asRegistryLockCleanupError(error));
    };
    lock.released = true;
    if (lock.heartbeatTimer) clearTimeout(lock.heartbeatTimer);
    if (lock.heartbeatInFlight) {
        try {
            await lock.heartbeatInFlight;
        } catch (error) {
            rememberCleanupError(error);
        }
    }
    let fileHandleClosed = false;
    try {
        await lock.fileHandle.close();
        fileHandleClosed = true;
    } catch (error) {
        rememberCleanupError(error);
    }
    if (fileHandleClosed) {
        try {
            await registryLockTestHooks()?.beforeFailedAcquireLockCleanup?.({ lockPath: lock.path, token: lock.token });
            if (await registryLockPathStillMatchesCreatedLock(lock, createdFileIdentity)) {
                await registryLockTestHooks()?.beforeFailedAcquireLockDelete?.({ lockPath: lock.path, token: lock.token });
                try {
                    await fs.promises.unlink(lock.path);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
            }
        } catch (error) {
            rememberCleanupError(error);
        }
    }
    if (cleanupErrors.length === 0) throw acquisitionError;
    const cleanupError = new AggregateError(cleanupErrors, "Record work registry 获取锁失败后的清理也失败");
    const combinedError = new Error(
        `${asRegistryLockCleanupError(acquisitionError).message}; ${cleanupError.message}`,
        { cause: acquisitionError },
    );
    Object.defineProperty(combinedError, "cleanupError", { value: cleanupError });
    throw combinedError;
}

async function writeLockState(lock: RegistryFileLock, expiresAtMs: number, releasedAt?: string): Promise<void> {
    const state: PersistedRegistryFileLock = {
        token: lock.token,
        acquiredAt: lock.acquiredAt,
        expiresAt: nowIso(expiresAtMs),
        heartbeatMs: lock.heartbeatMs,
        ...(releasedAt === undefined ? {} : { releasedAt }),
    };
    const bytes = Buffer.from(JSON.stringify(state), "utf8");
    await lock.fileHandle.write(bytes, 0, bytes.length, 0);
    await lock.fileHandle.truncate(bytes.length);
    await lock.fileHandle.sync();
}

async function writeReclaimBarrierState(barrier: RegistryLockReclaimBarrierHandle, releasedAt?: string): Promise<void> {
    const state: RegistryLockReclaimBarrier = {
        token: barrier.token,
        acquiredAt: barrier.acquiredAt,
        expiresAt: nowIso(Date.now() + barrier.leaseMs),
        ...(releasedAt === undefined ? {} : { releasedAt }),
    };
    const bytes = Buffer.from(JSON.stringify(state), "utf8");
    await barrier.fileHandle.write(bytes, 0, bytes.length, 0);
    await barrier.fileHandle.truncate(bytes.length);
    await barrier.fileHandle.sync();
}

function isRegistryLockReclaimBarrier(value: Partial<RegistryLockReclaimBarrier>): value is RegistryLockReclaimBarrier {
    return isNonEmptyString(value.token)
        && isTimestamp(value.acquiredAt)
        && isTimestamp(value.expiresAt)
        && (value.releasedAt === undefined || isTimestamp(value.releasedAt));
}

async function inspectReclaimBarrier(reclaimPath: string, nowMs: number, leaseMs: number): Promise<RegistryLockReclaimBarrierInspection> {
    try {
        const parsed = JSON.parse(await fs.promises.readFile(reclaimPath, "utf8")) as Partial<RegistryLockReclaimBarrier>;
        if (isRegistryLockReclaimBarrier(parsed)) {
            const active = parsed.releasedAt === undefined && Date.parse(parsed.expiresAt) > nowMs;
            return { exists: true, state: parsed, active, reclaimable: !active };
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { exists: false, active: false, reclaimable: true };
        }
    }
    try {
        const stat = await fs.promises.stat(reclaimPath);
        const reclaimable = nowMs - stat.mtimeMs >= leaseMs;
        return { exists: true, active: !reclaimable, reclaimable };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { exists: false, active: false, reclaimable: true };
        }
        return { exists: true, active: true, reclaimable: false };
    }
}

function reclaimBarrierIdentityChanged(before: RegistryLockReclaimBarrierInspection, after: RegistryLockReclaimBarrierInspection): boolean {
    return before.state?.token !== undefined
        && after.state?.token !== undefined
        && before.state.token !== after.state.token;
}

async function retireReclaimBarrier(reclaimPath: string, observed: RegistryLockReclaimBarrierInspection, leaseMs: number): Promise<boolean> {
    const verified = await inspectReclaimBarrier(reclaimPath, Date.now(), leaseMs);
    if (!verified.exists) return true;
    if (!verified.reclaimable || reclaimBarrierIdentityChanged(observed, verified)) return false;
    await registryLockTestHooks()?.afterReclaimBarrierRetireValidated?.({ reclaimPath, observedToken: verified.state?.token });
    const retiredPath = `${reclaimPath}.retired.${process.pid}.${randomUUID()}`;
    try {
        await fs.promises.rename(reclaimPath, retiredPath);
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    const moved = await inspectReclaimBarrier(retiredPath, Date.now(), leaseMs);
    if (!moved.reclaimable || reclaimBarrierIdentityChanged(verified, moved)) {
        await restoreLiveLock(retiredPath, reclaimPath);
        return false;
    }
    await fs.promises.rm(retiredPath, { force: true });
    return true;
}

async function waitForReclaimBarrier(reclaimPath: string, leaseMs: number): Promise<boolean> {
    const observed = await inspectReclaimBarrier(reclaimPath, Date.now(), leaseMs);
    if (!observed.exists) return false;
    if (observed.active) return true;
    await retireReclaimBarrier(reclaimPath, observed, leaseMs);
    return true;
}

async function acquireReclaimBarrier(lockPath: string, leaseMs: number): Promise<RegistryLockReclaimBarrierHandle | undefined> {
    const reclaimPath = recordWorkRegistryReclaimPath(lockPath);
    const token = randomUUID();
    let fileHandle: fs.promises.FileHandle;
    try {
        fileHandle = await fs.promises.open(reclaimPath, "wx", 0o600);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
        throw error;
    }
    const barrier: RegistryLockReclaimBarrierHandle = {
        token,
        path: reclaimPath,
        fileHandle,
        leaseMs: Math.max(leaseMs, REGISTRY_LOCK_RECLAIM_BARRIER_MIN_LEASE_MS),
        acquiredAt: nowIso(undefined),
    };
    try {
        await writeReclaimBarrierState(barrier);
        return barrier;
    } catch (error) {
        await fileHandle.close().catch(() => undefined);
        await fs.promises.rm(reclaimPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

async function releaseReclaimBarrier(barrier: RegistryLockReclaimBarrierHandle): Promise<void> {
    try {
        const observed = await inspectReclaimBarrier(barrier.path, Date.now(), barrier.leaseMs);
        if (observed.active && observed.state?.token === barrier.token) {
            await fs.promises.rm(barrier.path).catch(error => {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            });
        }
    } catch {
    } finally {
        await barrier.fileHandle.close().catch(() => undefined);
    }
}

async function restoreLiveLock(stalePath: string, lockPath: string): Promise<boolean> {
    for (let attempt = 0; attempt < REGISTRY_LOCK_RESTORE_RETRY_LIMIT; attempt += 1) {
        try {
            await fs.promises.link(stalePath, lockPath);
            await fs.promises.rm(stalePath, { force: true });
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
            await sleep(REGISTRY_LOCK_RETRY_DELAY_MS);
        }
    }
    return false;
}

async function reclaimLock(lockPath: string, nowMs: number, leaseMs: number): Promise<boolean> {
    const observed = await inspectRegistryLock(lockPath, nowMs, leaseMs);
    if (!observed.exists) return true;
    if (!observed.reclaimable) return false;
    const barrier = await acquireReclaimBarrier(lockPath, leaseMs);
    if (!barrier) return false;
    try {
        const verified = await inspectRegistryLock(lockPath, Date.now(), leaseMs);
        if (!verified.exists) return true;
        if (!verified.reclaimable || registryLockIdentityChanged(observed, verified)) return false;
        await registryLockTestHooks()?.afterReclaimValidated?.({ lockPath, reclaimPath: barrier.path });
        const stalePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
        try {
            await fs.promises.rename(lockPath, stalePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
            return false;
        }
        const moved = await inspectRegistryLock(stalePath, Date.now(), leaseMs);
        if (!moved.reclaimable) {
            await restoreLiveLock(stalePath, lockPath);
            return false;
        }
        await fs.promises.rm(stalePath, { force: true });
        return true;
    } finally {
        await releaseReclaimBarrier(barrier);
    }
}

async function readOwnedLock(lock: RegistryFileLock): Promise<PersistedRegistryFileLock> {
    if (lock.ownershipError) throw lock.ownershipError;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < REGISTRY_LOCK_IDENTITY_RETRY_LIMIT; attempt += 1) {
        try {
            const parsed = JSON.parse(await fs.promises.readFile(lock.path, "utf8")) as Partial<PersistedRegistryFileLock>;
            if (parsed.token !== lock.token) {
                lastError = new RecordWorkRegistryLockOwnershipError("Record work registry 锁已被其他 owner 接管");
            } else if (!isPersistedRegistryFileLock(parsed)) {
                lastError = new RecordWorkRegistryLockOwnershipError("Record work registry 锁内容损坏");
            } else if (parsed.releasedAt !== undefined) {
                lastError = new RecordWorkRegistryLockOwnershipError("Record work registry 锁已释放");
            } else if (Date.parse(parsed.expiresAt) <= Date.now()) {
                lastError = new RecordWorkRegistryLockOwnershipError("Record work registry 锁已过期");
            } else {
                return parsed;
            }
        } catch (error) {
            lastError = new RecordWorkRegistryLockOwnershipError(`Record work registry 锁不可读: ${(error as Error).message}`);
        }
        if (attempt + 1 < REGISTRY_LOCK_IDENTITY_RETRY_LIMIT) await sleep(REGISTRY_LOCK_RETRY_DELAY_MS);
    }
    throw lastError ?? new RecordWorkRegistryLockOwnershipError("Record work registry 锁所有权无法确认");
}

async function withLockMetadata<Value>(lock: RegistryFileLock, operation: () => Promise<Value>): Promise<Value> {
    const previous = lock.metadataTail;
    let release!: () => void;
    lock.metadataTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
        return await operation();
    } finally {
        release();
    }
}

async function refreshRegistryLock(lock: RegistryFileLock): Promise<void> {
    if (lock.released) return;
    await withLockMetadata(lock, async () => {
        if (lock.released) return;
        await readOwnedLock(lock);
        if (lock.released) return;
        await writeLockState(lock, Date.now() + lock.leaseMs);
        if (lock.released) return;
        await readOwnedLock(lock);
    });
}

function scheduleRegistryLockHeartbeat(lock: RegistryFileLock): void {
    if (lock.released || lock.ownershipError) return;
    lock.heartbeatTimer = setTimeout(() => {
        lock.heartbeatInFlight = refreshRegistryLock(lock)
            .catch(error => {
                if (!lock.released) {
                    lock.ownershipError = error instanceof Error
                        ? error
                        : new RecordWorkRegistryLockOwnershipError(String(error));
                }
            })
            .finally(() => {
                lock.heartbeatInFlight = undefined;
                scheduleRegistryLockHeartbeat(lock);
            });
    }, lock.heartbeatMs);
    lock.heartbeatTimer.unref();
}

async function assertRegistryLockOwnership(lock: RegistryFileLock): Promise<void> {
    await withLockMetadata(lock, async () => {
        await readOwnedLock(lock);
    });
}

async function acquireRegistryLock(location: RecordWorkRegistryLocation): Promise<RegistryFileLock> {
    const lockPath = recordWorkRegistryLockPath(location);
    const leaseMs = location.lockOptions?.leaseMs ?? DEFAULT_RECORD_WORK_LOCK_LEASE_MS;
    const waitMs = location.lockOptions?.waitMs ?? DEFAULT_RECORD_WORK_LOCK_WAIT_MS;
    const heartbeatMs = location.lockOptions?.heartbeatMs ?? Math.max(10, Math.floor(leaseMs / 3));
    if (!isPositiveInteger(leaseMs) || !isPositiveInteger(waitMs) || !isPositiveInteger(heartbeatMs) || heartbeatMs >= leaseMs) {
        throw new Error("registry lock 的 leaseMs、waitMs、heartbeatMs 必须为正整数，且 heartbeatMs 必须小于 leaseMs");
    }
    await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
    const deadline = Date.now() + waitMs;
    for (;;) {
        if (await waitForReclaimBarrier(recordWorkRegistryReclaimPath(lockPath), leaseMs)) {
            if (Date.now() >= deadline) throw new Error(`等待 Record work registry 锁超时: ${lockPath}`);
            await sleep(Math.min(5, Math.max(1, deadline - Date.now())));
            continue;
        }
        const token = randomUUID();
        try {
            const fileHandle = await fs.promises.open(lockPath, "wx", 0o600);
            const acquiredAt = nowIso(undefined);
            const registryLock: RegistryFileLock = {
                token,
                fileHandle,
                path: lockPath,
                leaseMs,
                heartbeatMs,
                acquiredAt,
                released: false,
                metadataTail: Promise.resolve(),
            };
            let createdFileIdentity: RegistryLockFileIdentity | undefined;
            try {
                createdFileIdentity = registryLockFileIdentity(await fileHandle.stat());
                await registryLockTestHooks()?.beforeInitialLockStateWrite?.({ lockPath, token });
                await writeLockState(registryLock, Date.now() + leaseMs);
                if (await waitForReclaimBarrier(recordWorkRegistryReclaimPath(lockPath), leaseMs)) {
                    await releaseRegistryLock(registryLock);
                    continue;
                }
                await readOwnedLock(registryLock);
                scheduleRegistryLockHeartbeat(registryLock);
                return registryLock;
            } catch (error) {
                await cleanupFailedRegistryLockAcquisition(registryLock, createdFileIdentity, error);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const nowMs = Date.now();
        if (await reclaimLock(lockPath, nowMs, leaseMs)) continue;
        if (nowMs >= deadline) throw new Error(`等待 Record work registry 锁超时: ${lockPath}`);
        await sleep(Math.min(5, Math.max(1, deadline - nowMs)));
    }
}

async function releaseRegistryLock(lock: RegistryFileLock): Promise<void> {
    lock.released = true;
    if (lock.heartbeatTimer) clearTimeout(lock.heartbeatTimer);
    if (lock.heartbeatInFlight) await lock.heartbeatInFlight.catch(() => undefined);
    try {
        await withLockMetadata(lock, async () => {
            try {
                const parsed = JSON.parse(await fs.promises.readFile(lock.path, "utf8")) as Partial<PersistedRegistryFileLock>;
                if (parsed.token === lock.token) await writeLockState(lock, Date.now(), nowIso(undefined));
            } catch {
            }
        });
    } finally {
        await lock.fileHandle.close().catch(() => undefined);
    }
}

async function withRegistryLock<Value>(location: RecordWorkRegistryLocation, operation: (lock: RegistryFileLock) => Promise<Value>): Promise<Value> {
    assertIdentity(location.identity);
    const lock = await acquireRegistryLock(location);
    try {
        await assertRegistryLockOwnership(lock);
        const value = await operation(lock);
        await assertRegistryLockOwnership(lock);
        return value;
    } finally {
        await releaseRegistryLock(lock);
    }
}


async function persistRegistry(filePath: string, registry: RecordWorkRegistry): Promise<void> {
    const { persistedHash, ...withoutHash } = registry;
    const normalized = withRegistryHash(withoutHash);
    if (normalized.persistedHash !== persistedHash) throw new Error("Record work registry 哈希未在写入前更新");
    await writeJsonDurableAtomic(filePath, normalized);
}

async function persistManifest(filePath: string, manifest: RecordWorkIdentityManifest): Promise<void> {
    const { persistedHash, ...withoutHash } = manifest;
    const normalized = withManifestHash(withoutHash);
    if (normalized.persistedHash !== persistedHash) throw new Error("Record work manifest 哈希未在写入前更新");
    await writeJsonDurableAtomic(filePath, normalized);
}

async function persistPublishedRegistryState(location: RecordWorkRegistryLocation, manifest: RecordWorkIdentityManifest, registry: RecordWorkRegistry, now: string, lock: RegistryFileLock): Promise<RecordWorkIdentityManifest> {
    const publishedManifest = publishedManifestForRegistry(manifest, registry, now);
    await assertRegistryLockOwnership(lock);
    await persistManifest(recordWorkIdentityManifestPath(location), publishedManifest);
    await assertRegistryLockOwnership(lock);
    await persistRegistry(recordWorkRegistryPath(location), registry);
    await assertRegistryLockOwnership(lock);
    return publishedManifest;
}

async function mutateRegistry<Value>(location: RecordWorkRegistryLocation, expectedRegistryRevision: number, nowMs: number | undefined, mutator: (registry: RecordWorkRegistry, now: string) => MutationDecision<Value>): Promise<MutationResult<Value>> {
    if (!isPositiveInteger(expectedRegistryRevision)) throw new Error("expectedRegistryRevision 必须为正整数");
    return withRegistryLock(location, async lock => {
        const loaded = await loadRegistry(location);
        if (loaded.kind !== "ready") return loaded;
        if (loaded.registry.registryRevision !== expectedRegistryRevision) {
            return {
                kind: "cas_conflict",
                path: loaded.path,
                expectedRegistryRevision,
                actualRegistryRevision: loaded.registry.registryRevision,
            };
        }
        const registry = clone(loaded.registry);
        const decision = mutator(registry, nowIso(nowMs));
        if (!decision.changed) return { kind: "updated", path: loaded.path, registry, value: decision.value };
        registry.registryRevision += 1;
        registry.updatedAt = nowIso(nowMs);
        const { persistedHash: _persistedHash, ...withoutHash } = registry;
        const persisted = withRegistryHash(withoutHash);
        await persistPublishedRegistryState(location, loaded.manifest, persisted, registry.updatedAt, lock);
        return { kind: "updated", path: loaded.path, registry: clone(persisted), value: decision.value };
    });
}

function findWork(registry: RecordWorkRegistry, recordWorkKeyValue: string): RecordWorkRegistryEntry | undefined {
    return registry.works.find(work => work.recordWorkKey === recordWorkKeyValue);
}

function workFence(work: RecordWorkRegistryEntry): FencingToken {
    if (!work.ownerLease || work.currentFencingToken <= 0) throw new Error("无 owner lease 的 work 不存在可用 fencing token");
    return {
        schedulerEpoch: work.ownerLease.schedulerEpoch,
        recordCommitEpoch: work.recordCommitEpoch,
        fencingToken: work.currentFencingToken,
        workLeaseId: work.ownerLease.workLeaseId,
    };
}

function sameFence(left: FencingToken, right: FencingToken): boolean {
    return left.schedulerEpoch === right.schedulerEpoch
        && left.recordCommitEpoch === right.recordCommitEpoch
        && left.fencingToken === right.fencingToken
        && left.workLeaseId === right.workLeaseId;
}

export async function readRecordWorkRegistry(location: RecordWorkRegistryLocation): Promise<ReadRecordWorkRegistryResult> {
    assertIdentity(location.identity);
    return withRegistryLock(location, async () => loadRegistry(location));
}

export async function withRecordWorkManualMutationAuthority<Value>(
    input: RecordWorkManualMutationInput,
    operation: () => Promise<Value>,
): Promise<RecordWorkManualMutationResult<Value>> {
    assertIdentity(input.identity);
    if (input.mutationKind !== "manual_edit" && input.mutationKind !== "manual_delete") {
        throw new Error(`未知 Record 手动修改类型: ${input.mutationKind}`);
    }
    if (input.artifactLockHeld !== true) throw new Error("Record 手动修改必须先持有 commit artifact 锁");
    if (typeof operation !== "function") throw new TypeError("Record 手动修改需要 operation");
    const mutationId = input.mutationId || `record-manage-${input.mutationKind}-${randomUUID()}`;
    if (!isNonEmptyString(mutationId)) throw new Error("Record 手动修改 mutationId 不能为空");
    return withRegistryLock(input, async lock => {
        const manifestPath = recordWorkIdentityManifestPath(input);
        const registryPath = recordWorkRegistryPath(input);
        const exists = async (filePath: string): Promise<boolean> => {
            try {
                await fs.promises.access(filePath, fs.constants.F_OK);
                return true;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
                throw error;
            }
        };
        const [manifestExists, registryExists] = await Promise.all([exists(manifestPath), exists(registryPath)]);
        if (!manifestExists && !registryExists) {
            const value = await operation();
            await assertRegistryLockOwnership(lock);
            return {
                kind: "mutated",
                path: registryPath,
                registry: null,
                mutationId,
                fencedRecordWorkKeys: [],
                value,
            };
        }
        if (!manifestExists) return { kind: "repair_required", reason: "manifest_missing", path: manifestPath };
        if (!registryExists) return { kind: "repair_required", reason: "registry_missing", path: registryPath };

        const loaded = await loadRegistry(input);
        if (loaded.kind !== "ready") return loaded;
        const registry = clone(loaded.registry);
        const now = nowIso(input.nowMs);
        const fencedRecordWorkKeys: string[] = [];
        for (const work of registry.works) {
            if (work.state !== "Active"
                || (work.activeTaskIds.length === 0 && work.ownerLease === null && work.publicationClaim === undefined)) {
                continue;
            }
            registry.recordCommitEpochCursor += 1;
            registry.fencingTokenCursor += 1;
            if (work.publicationClaim) {
                const claim = clone(work.publicationClaim);
                const history: RecordWorkPublicationHistoryEntry = {
                    claim,
                    supersededByTaskId: mutationId,
                    supersededAt: now,
                    nextRecordCommitEpoch: registry.recordCommitEpochCursor,
                    artifactStateHash: sha256({
                        version: 1,
                        visibleArtifactState: "manual_mutation_fence",
                        mutationKind: input.mutationKind,
                        mutationId,
                        claim,
                    }),
                    reason: "manual_record_mutation",
                    rolloverTrigger: input.mutationKind,
                };
                work.publicationHistory = [...(work.publicationHistory || []), history];
            }
            work.retiredTaskIds = normalizeTaskIds([
                ...(work.retiredTaskIds || []),
                ...work.activeTaskIds,
                ...(work.publicationClaim ? [work.publicationClaim.taskId] : []),
            ]);
            work.recordCommitEpoch = registry.recordCommitEpochCursor;
            work.currentFencingToken = registry.fencingTokenCursor;
            work.activeTaskIds = [];
            work.ownerLease = null;
            delete work.publicationClaim;
            work.updatedAt = now;
            fencedRecordWorkKeys.push(work.recordWorkKey);
        }

        let publishedRegistry = loaded.registry;
        if (fencedRecordWorkKeys.length > 0) {
            registry.registryRevision += 1;
            registry.updatedAt = now;
            const { persistedHash: _persistedHash, ...withoutHash } = registry;
            publishedRegistry = withRegistryHash(withoutHash);
            await persistPublishedRegistryState(input, loaded.manifest, publishedRegistry, now, lock);
        }
        await assertRegistryLockOwnership(lock);
        const value = await operation();
        await assertRegistryLockOwnership(lock);
        return {
            kind: "mutated",
            path: loaded.path,
            registry: clone(publishedRegistry),
            mutationId,
            fencedRecordWorkKeys,
            value,
        };
    });
}

export async function initializeRecordWorkRegistryIdentity(location: RecordWorkRegistryLocation, options: { firstPublicationToken: string; nowMs?: number }): Promise<InitializeRecordWorkRegistryIdentityResult> {
    assertIdentity(location.identity);
    assertFirstPublicationToken(options.firstPublicationToken);
    return withRegistryLock(location, async lock => {
        const loadedManifest = await loadManifest(location);
        if (loadedManifest.kind === "manifest_ready") {
            if (loadedManifest.manifest.firstPublicationTokenHash !== publicationTokenHash(location.identity, options.firstPublicationToken)) {
                return { kind: "publication_rejected", reason: "token_mismatch", path: loadedManifest.path };
            }
            return loadedManifest.manifest.state === "Published"
                ? { kind: "already_published", path: loadedManifest.path, manifest: loadedManifest.manifest }
                : { kind: "already_prepared", path: loadedManifest.path, manifest: loadedManifest.manifest };
        }
        if (loadedManifest.reason !== "manifest_missing") return loadedManifest;
        const loadedRegistry = await loadRegistryFile(location);
        if (loadedRegistry.kind === "registry_ready" || loadedRegistry.reason !== "registry_missing") {
            return { kind: "repair_required", reason: "manifest_missing", path: recordWorkIdentityManifestPath(location) };
        }
        const manifest = createPreparedManifest(location, options.firstPublicationToken, nowIso(options.nowMs));
        await assertRegistryLockOwnership(lock);
        await persistManifest(recordWorkIdentityManifestPath(location), manifest);
        await assertRegistryLockOwnership(lock);
        return { kind: "prepared", path: recordWorkIdentityManifestPath(location), manifest: clone(manifest) };
    });
}

export async function createRecordWorkRegistry(location: RecordWorkRegistryLocation, options: { firstPublicationToken: string; nowMs?: number }): Promise<CreateRecordWorkRegistryResult> {
    assertIdentity(location.identity);
    assertFirstPublicationToken(options.firstPublicationToken);
    return withRegistryLock(location, async lock => {
        const loadedManifest = await loadManifest(location);
        if (loadedManifest.kind !== "manifest_ready") return loadedManifest;
        if (loadedManifest.manifest.firstPublicationTokenHash !== publicationTokenHash(location.identity, options.firstPublicationToken)) {
            return { kind: "publication_rejected", reason: "token_mismatch", path: loadedManifest.path };
        }
        if (loadedManifest.manifest.state === "Published") {
            const loaded = await loadRegistry(location);
            if (loaded.kind === "ready") {
                return { kind: "already_exists", path: loaded.path, registry: loaded.registry, manifest: loaded.manifest };
            }
            const recoveredInitialRegistry = loaded.reason === "registry_missing"
                ? recoverInitialPublishedRegistry(location, loadedManifest.manifest)
                : null;
            if (!recoveredInitialRegistry) return loaded;
            await assertRegistryLockOwnership(lock);
            await persistRegistry(recordWorkRegistryPath(location), recoveredInitialRegistry);
            await assertRegistryLockOwnership(lock);
            return {
                kind: "created",
                path: recordWorkRegistryPath(location),
                registry: clone(recoveredInitialRegistry),
                manifest: loadedManifest.manifest,
            };
        }
        const existingRegistry = await loadRegistryFile(location);
        if (existingRegistry.kind === "registry_ready" || existingRegistry.reason !== "registry_missing") {
            return { kind: "repair_required", reason: "manifest_registry_mismatch", path: loadedManifest.path };
        }
        const registry = createInitialRegistry(location.identity, nowIso(options.nowMs));
        const manifest = await persistPublishedRegistryState(location, loadedManifest.manifest, registry, nowIso(options.nowMs), lock);
        return { kind: "created", path: recordWorkRegistryPath(location), registry: clone(registry), manifest };
    });
}

export async function startOrAttachRecordWork(input: StartOrAttachRecordWorkInput): Promise<StartOrAttachRecordWorkResult> {
    if (!isNonEmptyString(input.taskId)) throw new Error("taskId 不能为空");
    if (!isNonEmptyString(input.desiredRevision)) throw new Error("desiredRevision 不能为空");
    const mutation = await mutateRegistry<StartMutationValue>(input, input.expectedRegistryRevision, input.nowMs, (registry, now) => {
        const workKey = recordWorkKey(input.identity, input.desiredRevision);
        const existing = findWork(registry, workKey);
        if (existing) {
            if (existing.state === "Superseded") {
                return { changed: false, value: { kind: "superseded" as const, work: clone(existing), supersededByRecordWorkKey: existing.supersededByRecordWorkKey } };
            }
            if (existing.retiredTaskIds?.includes(input.taskId)) {
                return { changed: false, value: { kind: "superseded" as const, work: clone(existing), supersededByRecordWorkKey: existing.supersededByRecordWorkKey } };
            }
            const activeTaskIds = normalizeTaskIds([...existing.activeTaskIds, input.taskId]);
            const changed = activeTaskIds.length !== existing.activeTaskIds.length;
            if (changed) {
                existing.activeTaskIds = activeTaskIds;
                existing.updatedAt = now;
            }
            return { changed, value: { kind: "started" as const, disposition: "attached" as const, work: clone(existing) } };
        }

        for (const work of registry.works) {
            if (work.state !== "Active") continue;
            work.state = "Superseded";
            work.ownerLease = null;
            work.supersededAt = now;
            work.supersededByRecordWorkKey = workKey;
            work.updatedAt = now;
        }
        registry.recordCommitEpochCursor += 1;
        const work: RecordWorkRegistryEntry = {
            recordWorkKey: workKey,
            desiredRevision: input.desiredRevision,
            state: "Active",
            recordCommitEpoch: registry.recordCommitEpochCursor,
            currentFencingToken: 0,
            activeTaskIds: [input.taskId],
            ownerLease: null,
            createdAt: now,
            updatedAt: now,
        };
        registry.works.push(work);
        return { changed: true, value: { kind: "started" as const, disposition: "created" as const, work: clone(work) } };
    });
    if (mutation.kind !== "updated") return mutation;
    if (mutation.value.kind === "superseded") {
        return { ...mutation.value, path: mutation.path, registry: mutation.registry };
    }
    const work = findWork(mutation.registry, mutation.value.work.recordWorkKey);
    if (!work) throw new Error("Record work mutation 后丢失目标 work");
    return { ...mutation.value, path: mutation.path, registry: mutation.registry, work: clone(work) };
}

export async function detachRecordWorkTask(input: DetachRecordWorkTaskInput): Promise<DetachRecordWorkTaskResult> {
    if (!isNonEmptyString(input.recordWorkKey) || !isNonEmptyString(input.taskId)) throw new Error("recordWorkKey 和 taskId 不能为空");
    const mutation = await mutateRegistry<DetachMutationValue>(input, input.expectedRegistryRevision, input.nowMs, (registry, now) => {
        const work = findWork(registry, input.recordWorkKey);
        if (!work) return { changed: false, value: { kind: "work_missing" as const } };
        if (!work.activeTaskIds.includes(input.taskId)) return { changed: false, value: { kind: "task_not_attached" as const } };
        work.activeTaskIds = work.activeTaskIds.filter(taskId => taskId !== input.taskId);
        work.updatedAt = now;
        return { changed: true, value: { kind: "detached" as const, work: clone(work) } };
    });
    if (mutation.kind !== "updated") return mutation;
    if (mutation.value.kind !== "detached") return { kind: mutation.value.kind, path: mutation.path, registry: mutation.registry };
    const work = findWork(mutation.registry, input.recordWorkKey);
    if (!work) throw new Error("Record work detach 后丢失目标 work");
    return { kind: "detached", path: mutation.path, registry: mutation.registry, work: clone(work), remainingActiveTaskIds: [...work.activeTaskIds] };
}

export async function acquireRecordWorkLease(input: AcquireRecordWorkLeaseInput): Promise<AcquireRecordWorkLeaseResult> {
    if (!isNonEmptyString(input.recordWorkKey) || !isNonEmptyString(input.taskId) || !isNonEmptyString(input.ownerId)) throw new Error("recordWorkKey、taskId 和 ownerId 不能为空");
    if (!isPositiveInteger(input.schedulerEpoch)) throw new Error("schedulerEpoch 必须为正整数");
    const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_RECORD_WORK_LEASE_MS;
    if (!isPositiveInteger(leaseDurationMs)) throw new Error("leaseDurationMs 必须为正整数");
    const mutation = await mutateRegistry<LeaseMutationValue>(input, input.expectedRegistryRevision, input.nowMs, (registry, now) => {
        const work = findWork(registry, input.recordWorkKey);
        if (!work) return { changed: false, value: { kind: "work_missing" as const } };
        if (work.state === "Superseded") return { changed: false, value: { kind: "superseded" as const, work: clone(work) } };
        if (!work.activeTaskIds.includes(input.taskId)) return { changed: false, value: { kind: "task_not_attached" as const, work: clone(work) } };
        const nowValue = Date.parse(now);
        const currentLease = work.ownerLease;
        if (currentLease && Date.parse(currentLease.expiresAt) > nowValue) {
            if (currentLease.ownerId !== input.ownerId
                || currentLease.workLeaseId !== input.workLeaseId
                || currentLease.schedulerEpoch !== input.schedulerEpoch) {
                return { changed: false, value: { kind: "lease_held" as const, work: clone(work), lease: clone(currentLease) } };
            }
            currentLease.expiresAt = nowIso(nowValue + leaseDurationMs);
            work.updatedAt = now;
            return { changed: true, value: { kind: "acquired" as const, disposition: "renewed" as const, work: clone(work) } };
        }
        registry.fencingTokenCursor += 1;
        work.currentFencingToken = registry.fencingTokenCursor;
        work.ownerLease = {
            workLeaseId: randomUUID(),
            ownerId: input.ownerId,
            schedulerEpoch: input.schedulerEpoch,
            acquiredAt: now,
            expiresAt: nowIso(nowValue + leaseDurationMs),
        };
        work.updatedAt = now;
        return { changed: true, value: { kind: "acquired" as const, disposition: "new" as const, work: clone(work) } };
    });
    if (mutation.kind !== "updated") return mutation;
    if (mutation.value.kind === "work_missing") return { kind: "work_missing", path: mutation.path, registry: mutation.registry };
    if (mutation.value.kind === "task_not_attached" || mutation.value.kind === "superseded") {
        return { kind: mutation.value.kind, path: mutation.path, registry: mutation.registry, work: mutation.value.work };
    }
    if (mutation.value.kind === "lease_held") {
        return { kind: "lease_held", path: mutation.path, registry: mutation.registry, work: mutation.value.work, lease: mutation.value.lease };
    }
    const work = findWork(mutation.registry, input.recordWorkKey);
    if (!work || !work.ownerLease) throw new Error("Record work lease mutation 后缺少 lease");
    return {
        kind: "acquired",
        disposition: mutation.value.disposition,
        path: mutation.path,
        registry: mutation.registry,
        work: clone(work),
        lease: clone(work.ownerLease),
        fence: workFence(work),
    };
}

export async function recoverRecordWorkLease(input: RecoverRecordWorkLeaseInput): Promise<RecoverRecordWorkLeaseResult> {
    if (!isNonEmptyString(input.recordWorkKey) || !isNonEmptyString(input.taskId) || !isNonEmptyString(input.ownerId)) {
        throw new Error("recordWorkKey、taskId 和 ownerId 不能为空");
    }
    if (!isPositiveInteger(input.schedulerEpoch)
        || !isPositiveInteger(input.expectedFence.schedulerEpoch)
        || !isPositiveInteger(input.expectedFence.recordCommitEpoch)
        || !isPositiveInteger(input.expectedFence.fencingToken)
        || !isNonEmptyString(input.expectedFence.workLeaseId)) {
        throw new Error("recoverRecordWorkLease 需要完整的新 schedulerEpoch 与旧 fence");
    }
    if (input.schedulerEpoch <= input.expectedFence.schedulerEpoch) {
        throw new Error("recoverRecordWorkLease 的新 schedulerEpoch 必须严格领先旧 fence");
    }
    const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_RECORD_WORK_LEASE_MS;
    if (!isPositiveInteger(leaseDurationMs)) throw new Error("leaseDurationMs 必须为正整数");

    const mutation = await mutateRegistry<RecoverLeaseMutationValue>(input, input.expectedRegistryRevision, input.nowMs, (registry, now) => {
        const work = findWork(registry, input.recordWorkKey);
        if (!work) return { changed: false, value: { kind: "rejected" as const, reason: "work_missing" as const } };
        if (work.state !== "Active") {
            return { changed: false, value: { kind: "rejected" as const, reason: "work_superseded" as const, work: clone(work) } };
        }
        if (!work.activeTaskIds.includes(input.taskId)) {
            return { changed: false, value: { kind: "rejected" as const, reason: "task_not_attached" as const, work: clone(work) } };
        }
        const currentLease = work.ownerLease;
        if (!currentLease) {
            return { changed: false, value: { kind: "rejected" as const, reason: "lease_missing" as const, work: clone(work) } };
        }
        if (work.recordCommitEpoch !== input.expectedFence.recordCommitEpoch) {
            return { changed: false, value: { kind: "rejected" as const, reason: "record_commit_epoch_mismatch" as const, work: clone(work), lease: clone(currentLease) } };
        }
        if (currentLease.workLeaseId !== input.expectedFence.workLeaseId) {
            return { changed: false, value: { kind: "rejected" as const, reason: "lease_mismatch" as const, work: clone(work), lease: clone(currentLease) } };
        }
        if (work.currentFencingToken !== input.expectedFence.fencingToken) {
            return { changed: false, value: { kind: "rejected" as const, reason: "fencing_token_mismatch" as const, work: clone(work), lease: clone(currentLease) } };
        }
        if (currentLease.schedulerEpoch < input.expectedFence.schedulerEpoch || currentLease.schedulerEpoch > input.schedulerEpoch) {
            return { changed: false, value: { kind: "rejected" as const, reason: "scheduler_epoch_mismatch" as const, work: clone(work), lease: clone(currentLease) } };
        }
        if (currentLease.schedulerEpoch === input.schedulerEpoch && currentLease.ownerId !== input.ownerId) {
            return { changed: false, value: { kind: "rejected" as const, reason: "owner_mismatch" as const, work: clone(work), lease: clone(currentLease) } };
        }
        const publicationClaim = work.publicationClaim;
        if (publicationClaim && (publicationClaim.ownerId !== currentLease.ownerId
            || publicationClaim.schedulerEpoch !== currentLease.schedulerEpoch
            || publicationClaim.recordCommitEpoch !== work.recordCommitEpoch
            || publicationClaim.fencingToken !== work.currentFencingToken
            || publicationClaim.workLeaseId !== currentLease.workLeaseId)) {
            return { changed: false, value: { kind: "rejected" as const, reason: "publication_claim_mismatch" as const, work: clone(work), lease: clone(currentLease) } };
        }
        const disposition = currentLease.schedulerEpoch === input.schedulerEpoch && currentLease.ownerId === input.ownerId
            ? "already_recovered" as const
            : "transferred" as const;
        const nowValue = Date.parse(now);
        work.ownerLease = {
            workLeaseId: currentLease.workLeaseId,
            ownerId: input.ownerId,
            schedulerEpoch: input.schedulerEpoch,
            acquiredAt: now,
            expiresAt: nowIso(nowValue + leaseDurationMs),
        };
        if (publicationClaim) {
            publicationClaim.ownerId = input.ownerId;
            publicationClaim.schedulerEpoch = input.schedulerEpoch;
        }
        work.updatedAt = now;
        return { changed: true, value: { kind: "recovered" as const, disposition, work: clone(work) } };
    });
    if (mutation.kind !== "updated") return mutation;
    if (mutation.value.kind === "rejected") {
        return {
            kind: "rejected",
            path: mutation.path,
            registry: mutation.registry,
            reason: mutation.value.reason,
            ...(mutation.value.work ? { work: mutation.value.work } : {}),
            ...(mutation.value.lease ? { lease: mutation.value.lease } : {}),
        };
    }
    const work = findWork(mutation.registry, input.recordWorkKey);
    if (!work?.ownerLease) throw new Error("Record work recovery mutation 后缺少 lease");
    return {
        kind: "recovered",
        disposition: mutation.value.disposition,
        path: mutation.path,
        registry: mutation.registry,
        work: clone(work),
        lease: clone(work.ownerLease),
        fence: workFence(work),
    };
}

export async function advanceRecordWorkFence(input: AdvanceRecordWorkFenceInput): Promise<AdvanceRecordWorkFenceResult> {
    if (!isNonEmptyString(input.recordWorkKey) || !isNonEmptyString(input.taskId) || !isNonEmptyString(input.ownerId)) {
        throw new Error("recordWorkKey、taskId 和 ownerId 不能为空");
    }
    if (!isPositiveInteger(input.fence.schedulerEpoch)
        || !isPositiveInteger(input.fence.recordCommitEpoch)
        || !isPositiveInteger(input.fence.fencingToken)
        || !isNonEmptyString(input.fence.workLeaseId)) {
        throw new Error("advanceRecordWorkFence 需要完整的旧 fence");
    }
    const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_RECORD_WORK_LEASE_MS;
    if (!isPositiveInteger(leaseDurationMs)) throw new Error("leaseDurationMs 必须为正整数");

    const mutation = await mutateRegistry<AdvanceRecordWorkFenceMutationValue>(input, input.expectedRegistryRevision, input.nowMs, (registry, now) => {
        const work = findWork(registry, input.recordWorkKey);
        if (!work) return { changed: false, value: { kind: "rejected" as const, reason: "work_missing" as const } };
        if (work.state !== "Active") return { changed: false, value: { kind: "rejected" as const, reason: "work_superseded" as const, work: clone(work) } };
        if (!work.activeTaskIds.includes(input.taskId)) return { changed: false, value: { kind: "rejected" as const, reason: "task_not_attached" as const, work: clone(work) } };
        if (work.publicationClaim) return { changed: false, value: { kind: "rejected" as const, reason: "publication_claimed" as const, work: clone(work) } };

        const currentLease = work.ownerLease;
        if (!currentLease) return { changed: false, value: { kind: "rejected" as const, reason: "lease_missing" as const, work: clone(work) } };
        if (currentLease.ownerId !== input.ownerId) return { changed: false, value: { kind: "rejected" as const, reason: "owner_mismatch" as const, work: clone(work) } };
        if (currentLease.schedulerEpoch !== input.fence.schedulerEpoch) return { changed: false, value: { kind: "rejected" as const, reason: "scheduler_epoch_mismatch" as const, work: clone(work) } };
        if (work.recordCommitEpoch !== input.fence.recordCommitEpoch) return { changed: false, value: { kind: "rejected" as const, reason: "record_commit_epoch_mismatch" as const, work: clone(work) } };
        if (currentLease.workLeaseId !== input.fence.workLeaseId) return { changed: false, value: { kind: "rejected" as const, reason: "lease_mismatch" as const, work: clone(work) } };
        if (!sameFence(workFence(work), input.fence)) return { changed: false, value: { kind: "rejected" as const, reason: "fencing_token_mismatch" as const, work: clone(work) } };

        let nextWorkLeaseId = randomUUID();
        while (nextWorkLeaseId === currentLease.workLeaseId) nextWorkLeaseId = randomUUID();
        const nowValue = Date.parse(now);
        registry.fencingTokenCursor += 1;
        work.currentFencingToken = registry.fencingTokenCursor;
        work.ownerLease = {
            workLeaseId: nextWorkLeaseId,
            ownerId: currentLease.ownerId,
            schedulerEpoch: currentLease.schedulerEpoch,
            acquiredAt: now,
            expiresAt: nowIso(nowValue + leaseDurationMs),
        };
        work.updatedAt = now;
        return { changed: true, value: { kind: "advanced" as const, work: clone(work) } };
    });

    if (mutation.kind !== "updated") return mutation;
    if (mutation.value.kind === "rejected") {
        return {
            kind: "rejected",
            path: mutation.path,
            registry: mutation.registry,
            reason: mutation.value.reason,
            ...(mutation.value.work ? { work: mutation.value.work } : {}),
        };
    }
    const work = findWork(mutation.registry, input.recordWorkKey);
    if (!work || !work.ownerLease) throw new Error("Record work fence advance 后缺少 lease");
    return {
        kind: "advanced",
        path: mutation.path,
        registryRevision: mutation.registry.registryRevision,
        registry: mutation.registry,
        work: clone(work),
        lease: clone(work.ownerLease),
        fence: workFence(work),
    };
}

export async function rolloverRecordWorkPublication(
    input: RolloverRecordWorkPublicationInput,
): Promise<RolloverRecordWorkPublicationResult> {
    assertIdentity(input.identity);
    if (typeof input.withArtifactVerification !== "function") {
        throw new Error("rolloverRecordWorkPublication 需要 artifact verification scope");
    }
    const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_RECORD_WORK_LEASE_MS;
    if (!isPositiveInteger(leaseDurationMs)) throw new Error("leaseDurationMs 必须为正整数");
    return withRegistryLock(input, async lock => {
        const loaded = await loadRegistry(input);
        if (loaded.kind !== "ready") return loaded;
        const authorization = evaluateConditionalCommitAuthorization(input, loaded.registry, input);
        if (authorization.kind === "repair_required") return authorization;
        if (authorization.kind === "rejected") {
            const work = findWork(loaded.registry, input.recordWorkKey);
            return {
                kind: "rejected",
                reason: authorization.reason,
                path: authorization.path,
                registryRevision: authorization.registryRevision,
                ...(work ? { work: clone(work) } : {}),
            };
        }
        const existingWork = findWork(loaded.registry, input.recordWorkKey);
        if (!existingWork) throw new Error("已授权的 publication rollover 缺少 record work");
        const existingClaim = existingWork.publicationClaim;
        if (!existingClaim) {
            return {
                kind: "not_required",
                reason: "publication_claim_missing",
                path: loaded.path,
                registry: loaded.registry,
                work: clone(existingWork),
            };
        }
        return input.withArtifactVerification(clone(existingClaim), async verification => {
            const forceRefresh = input.rolloverMode === "force_refresh";
            if (verification.kind === "consistent" && !forceRefresh) {
                return {
                    kind: "not_required",
                    reason: "artifacts_match_claim",
                    path: loaded.path,
                    registry: loaded.registry,
                    work: clone(existingWork),
                    claim: clone(existingClaim),
                };
            }
            if (verification.kind === "unresolved") {
                return {
                    kind: "rejected",
                    reason: "artifact_unresolved",
                    detail: verification.reason,
                    path: loaded.path,
                    registryRevision: loaded.registry.registryRevision,
                    work: clone(existingWork),
                    claim: clone(existingClaim),
                };
            }
            if (forceRefresh && verification.kind !== "consistent") {
                return {
                    kind: "rejected",
                    reason: "force_refresh_artifacts_not_consistent",
                    detail: "force refresh requires body, main index, and reader index to match the existing publication claim",
                    path: loaded.path,
                    registryRevision: loaded.registry.registryRevision,
                    work: clone(existingWork),
                    claim: clone(existingClaim),
                };
            }
            if (!verification.artifactStateHash || !/^[0-9a-f]{64}$/u.test(verification.artifactStateHash)) {
                throw new Error("publication rollover artifactStateHash 必须是 sha256 hex");
            }
            const registry = clone(loaded.registry);
            const work = findWork(registry, input.recordWorkKey);
            if (!work?.ownerLease || !work.publicationClaim) {
                throw new Error("publication rollover mutation 前 work/lease/claim 丢失");
            }
            if (stableStringify(work.publicationClaim) !== stableStringify(existingClaim)) {
                throw new Error("publication rollover mutation 前 claim 漂移");
            }
            const now = nowIso(input.nowMs);
            const nowValue = Date.parse(now);
            registry.recordCommitEpochCursor += 1;
            registry.fencingTokenCursor += 1;
            let nextWorkLeaseId = randomUUID();
            while (nextWorkLeaseId === work.ownerLease.workLeaseId) nextWorkLeaseId = randomUUID();
            const history: RecordWorkPublicationHistoryEntry = {
                claim: clone(existingClaim),
                supersededByTaskId: input.taskId,
                supersededAt: now,
                nextRecordCommitEpoch: registry.recordCommitEpochCursor,
                artifactStateHash: verification.artifactStateHash,
                reason: "visible_artifacts_diverged",
                ...(verification.kind === "consistent" ? { rolloverTrigger: "force_refresh" as const } : {}),
            };
            work.publicationHistory = [...(work.publicationHistory || []), history];
            work.recordCommitEpoch = registry.recordCommitEpochCursor;
            work.currentFencingToken = registry.fencingTokenCursor;
            work.ownerLease = {
                workLeaseId: nextWorkLeaseId,
                ownerId: input.ownerId,
                schedulerEpoch: input.fence.schedulerEpoch,
                acquiredAt: now,
                expiresAt: nowIso(nowValue + leaseDurationMs),
            };
            delete work.publicationClaim;
            work.updatedAt = now;
            registry.registryRevision += 1;
            registry.updatedAt = now;
            const { persistedHash: _persistedHash, ...withoutHash } = registry;
            const persisted = withRegistryHash(withoutHash);
            await assertRegistryLockOwnership(lock);
            await persistPublishedRegistryState(input, loaded.manifest, persisted, now, lock);
            const persistedWork = findWork(persisted, input.recordWorkKey);
            if (!persistedWork?.ownerLease) throw new Error("publication rollover 持久化后 work lease 丢失");
            return {
                kind: "rolled_over",
                path: loaded.path,
                registry: clone(persisted),
                work: clone(persistedWork),
                lease: clone(persistedWork.ownerLease),
                fence: workFence(persistedWork),
                previousClaim: clone(existingClaim),
                history: clone(history),
            };
        });
    });
}

function evaluateConditionalCommitAuthorization(
    location: RecordWorkRegistryLocation,
    registry: RecordWorkRegistry,
    input: ConditionalCommitAuthorizationInput,
    options: RecordWorkCommitAuthorityOptions = {},
): ConditionalCommitAuthorizationResult {
    const filePath = recordWorkRegistryPath(location);
    if (input.expectedRegistryRevision !== undefined && input.expectedRegistryRevision !== registry.registryRevision) {
        return { kind: "rejected", path: filePath, registryRevision: registry.registryRevision, reason: "registry_revision_mismatch" };
    }
    const work = findWork(registry, input.recordWorkKey);
    if (!work) return { kind: "rejected", path: filePath, registryRevision: registry.registryRevision, reason: "work_missing" };
    if (work.state === "Superseded") return { kind: "rejected", path: filePath, registryRevision: registry.registryRevision, reason: "work_superseded" };
    if (!work.activeTaskIds.includes(input.taskId)
        && (!options.allowDetachedCleanup
            || (options.detachedCleanupMustBeExclusive && work.activeTaskIds.length !== 0))) {
        return { kind: "rejected", path: filePath, registryRevision: registry.registryRevision, reason: "task_detached" };
    }
    if (!work.ownerLease) return { kind: "rejected", path: filePath, registryRevision: registry.registryRevision, reason: "lease_missing" };
    const nowMs = input.nowMs ?? Date.now();
    if (Date.parse(work.ownerLease.expiresAt) <= nowMs) return { kind: "rejected", path: filePath, registryRevision: registry.registryRevision, reason: "lease_expired" };
    if (work.ownerLease.workLeaseId !== input.fence.workLeaseId) return { kind: "rejected", path: filePath, registryRevision: registry.registryRevision, reason: "lease_mismatch" };
    if (work.ownerLease.ownerId !== input.ownerId) return { kind: "rejected", path: filePath, registryRevision: registry.registryRevision, reason: "owner_mismatch" };
    if (work.ownerLease.schedulerEpoch !== input.fence.schedulerEpoch) return { kind: "rejected", path: filePath, registryRevision: registry.registryRevision, reason: "scheduler_epoch_mismatch" };
    if (work.recordCommitEpoch !== input.fence.recordCommitEpoch) return { kind: "rejected", path: filePath, registryRevision: registry.registryRevision, reason: "record_commit_epoch_mismatch" };
    const currentFence = workFence(work);
    if (!sameFence(currentFence, input.fence)) return { kind: "rejected", path: filePath, registryRevision: registry.registryRevision, reason: "fencing_token_mismatch" };
    return {
        kind: "authorized",
        authorization: {
            path: filePath,
            registryRevision: registry.registryRevision,
            identity: clone(registry.identity),
            recordWorkKey: work.recordWorkKey,
            recordCommitEpoch: work.recordCommitEpoch,
            fence: clone(currentFence),
        },
    };
}

function assertPublicationClaimInput(input: RecordWorkPublicationClaimInput): void {
    if (!isNonEmptyString(input.commitId)
        || !isNonEmptyString(input.inputHash)
        || !isNonEmptyString(input.bodyHash)
        || !isNonEmptyString(input.coveredRevision)
        || !isNonEmptyString(input.metadataHash)
        || !isPlainObject(input.metadataSnapshot)) {
        throw new Error("publication claim commitId/inputHash/bodyHash/coveredRevision/metadataHash 必须非空");
    }
}

function publicationClaimFromInput(input: RecordWorkPublicationClaimInput, now: string): RecordWorkPublicationClaim {
    return {
        commitId: input.commitId,
        inputHash: input.inputHash,
        bodyHash: input.bodyHash,
        coveredRevision: input.coveredRevision,
        metadataHash: input.metadataHash,
        metadataSnapshot: clone(input.metadataSnapshot),
        taskId: input.taskId,
        ownerId: input.ownerId,
        schedulerEpoch: input.fence.schedulerEpoch,
        recordCommitEpoch: input.fence.recordCommitEpoch,
        fencingToken: input.fence.fencingToken,
        workLeaseId: input.fence.workLeaseId,
        claimedAt: now,
    };
}

function isSamePublicationClaim(claim: RecordWorkPublicationClaim, input: RecordWorkPublicationClaimInput): boolean {
    return claim.commitId === input.commitId
        && claim.inputHash === input.inputHash
        && claim.bodyHash === input.bodyHash
        && claim.coveredRevision === input.coveredRevision
        && claim.metadataHash === input.metadataHash
        && claim.taskId === input.taskId
        && claim.ownerId === input.ownerId
        && claim.schedulerEpoch === input.fence.schedulerEpoch
        && claim.recordCommitEpoch === input.fence.recordCommitEpoch
        && claim.fencingToken === input.fence.fencingToken
        && claim.workLeaseId === input.fence.workLeaseId;
}

function isReusablePublicationClaim(claim: RecordWorkPublicationClaim, input: RecordWorkPublicationClaimInput): boolean {
    return claim.inputHash === input.inputHash
        && claim.bodyHash === input.bodyHash
        && claim.coveredRevision === input.coveredRevision;
}

function authorizationWithoutRegistryRevision(input: RecordWorkPublicationClaimInput): ConditionalCommitAuthorizationInput {
    const { expectedRegistryRevision: _expectedRegistryRevision, ...withoutRevision } = input;
    return withoutRevision;
}

export async function claimRecordWorkPublication(input: RecordWorkPublicationClaimInput): Promise<RecordWorkPublicationClaimResult> {
    assertIdentity(input.identity);
    assertPublicationClaimInput(input);
    return withRegistryLock(input, async lock => {
        const loaded = await loadRegistry(input);
        if (loaded.kind !== "ready") return loaded;
        const authorization = evaluateConditionalCommitAuthorization(input, loaded.registry, input);
        if (authorization.kind !== "authorized") return authorization;
        const existingWork = findWork(loaded.registry, input.recordWorkKey);
        if (!existingWork) throw new Error("已授权的 publication claim 缺少 record work");
        const existingClaim = existingWork.publicationClaim;
        if (existingClaim) {
            const kind = isSamePublicationClaim(existingClaim, input)
                ? "recovered" as const
                : existingClaim.commitId !== input.commitId && isReusablePublicationClaim(existingClaim, input)
                    ? "reused" as const
                    : "conflict" as const;
            return {
                kind,
                path: loaded.path,
                registry: loaded.registry,
                work: clone(existingWork),
                authorization: authorization.authorization,
                claim: clone(existingClaim),
            };
        }
        const registry = clone(loaded.registry);
        const work = findWork(registry, input.recordWorkKey);
        if (!work) throw new Error("publication claim mutation 后丢失 record work");
        const now = nowIso(input.nowMs);
        work.publicationClaim = publicationClaimFromInput(input, now);
        work.updatedAt = now;
        registry.registryRevision += 1;
        registry.updatedAt = now;
        const { persistedHash: _persistedHash, ...withoutHash } = registry;
        const persisted = withRegistryHash(withoutHash);
        await assertRegistryLockOwnership(lock);
        const manifest = await persistPublishedRegistryState(input, loaded.manifest, persisted, now, lock);
        const currentWork = findWork(persisted, input.recordWorkKey);
        if (!currentWork?.publicationClaim) throw new Error("publication claim 持久化后丢失");
        const afterAuthorization = evaluateConditionalCommitAuthorization(
            input,
            persisted,
            authorizationWithoutRegistryRevision(input),
        );
        if (afterAuthorization.kind !== "authorized") return afterAuthorization;
        return {
            kind: "claimed",
            path: loaded.path,
            registry: clone(persisted),
            work: clone(currentWork),
            authorization: afterAuthorization.authorization,
            claim: clone(currentWork.publicationClaim),
        };
    });
}

export async function withRecordWorkPublicationAuthority<Value>(
    input: RecordWorkPublicationClaimInput,
    operation: (authorization: ConditionalCommitAuthorization, claim: RecordWorkPublicationClaim) => Promise<Value>,
    options: RecordWorkCommitAuthorityOptions = {},
): Promise<RecordWorkPublicationAuthorityResult<Value>> {
    assertIdentity(input.identity);
    assertPublicationClaimInput(input);
    return withRegistryLock(input, async lock => {
        const loaded = await loadRegistry(input);
        if (loaded.kind !== "ready") return loaded;
        const authorization = evaluateConditionalCommitAuthorization(input, loaded.registry, input, options);
        if (authorization.kind !== "authorized") return authorization;
        const work = findWork(loaded.registry, input.recordWorkKey);
        if (!work) throw new Error("已授权的 publication authority 缺少 record work");
        const claim = work.publicationClaim;
        if (!claim) {
            return { kind: "claim_missing", path: loaded.path, registryRevision: loaded.registry.registryRevision };
        }
        if (isReusablePublicationClaim(claim, input) && claim.commitId !== input.commitId) {
            return { kind: "reused", path: loaded.path, registryRevision: loaded.registry.registryRevision, claim: clone(claim) };
        }
        if (!isSamePublicationClaim(claim, input)) {
            return { kind: "conflict", path: loaded.path, registryRevision: loaded.registry.registryRevision, claim: clone(claim) };
        }
        await assertRegistryLockOwnership(lock);
        const value = await operation(clone(authorization.authorization), clone(claim));
        await assertRegistryLockOwnership(lock);
        const after = await loadRegistry(input);
        if (after.kind !== "ready") return after;
        const afterAuthorization = evaluateConditionalCommitAuthorization(input, after.registry, input, options);
        if (afterAuthorization.kind !== "authorized") return afterAuthorization;
        const afterWork = findWork(after.registry, input.recordWorkKey);
        if (!afterWork?.publicationClaim || !isSamePublicationClaim(afterWork.publicationClaim, input)) {
            return {
                kind: "conflict",
                path: after.path,
                registryRevision: after.registry.registryRevision,
                ...(afterWork?.publicationClaim ? { claim: clone(afterWork.publicationClaim) } : {}),
            };
        }
        await assertRegistryLockOwnership(lock);
        return {
            kind: "committed",
            authorization: afterAuthorization.authorization,
            claim: clone(afterWork.publicationClaim),
            value,
        };
    });
}

export async function authorizeRecordWorkCommit(input: ConditionalCommitAuthorizationInput): Promise<ConditionalCommitAuthorizationResult> {
    assertIdentity(input.identity);
    return withRegistryLock(input, async () => {
        const loaded = await loadRegistry(input);
        if (loaded.kind !== "ready") return loaded;
        return evaluateConditionalCommitAuthorization(input, loaded.registry, input);
    });
}

function createRecordWorkCommitToken(input: ConditionalCommitAuthorizationInput, authorization: ConditionalCommitAuthorization): RecordWorkCommitToken {
    const withoutHash: Omit<RecordWorkCommitToken, "integrityHash"> = {
        kind: "record-work-commit-token",
        tokenId: randomUUID(),
        identity: clone(input.identity),
        recordWorkKey: input.recordWorkKey,
        taskId: input.taskId,
        ownerId: input.ownerId,
        authorizedRegistryRevision: authorization.registryRevision,
        fence: clone(authorization.fence),
        issuedAt: nowIso(input.nowMs),
    };
    return { ...withoutHash, integrityHash: sha256(withoutHash) };
}

function validateRecordWorkCommitToken(location: RecordWorkRegistryLocation, token: RecordWorkCommitToken): "valid" | "identity_mismatch" | "integrity_mismatch" {
    if (!sameIdentity(location.identity, token.identity)) return "identity_mismatch";
    const { integrityHash, ...withoutHash } = token;
    return integrityHash === sha256(withoutHash) ? "valid" : "integrity_mismatch";
}

function authorizationInputFromToken(location: RecordWorkRegistryLocation, token: RecordWorkCommitToken, nowMs?: number): ConditionalCommitAuthorizationInput {
    return {
        ...location,
        recordWorkKey: token.recordWorkKey,
        taskId: token.taskId,
        ownerId: token.ownerId,
        fence: clone(token.fence),
        nowMs,
    };
}

export async function prepareRecordWorkCommit(input: ConditionalCommitAuthorizationInput): Promise<PrepareRecordWorkCommitResult> {
    assertIdentity(input.identity);
    return withRegistryLock(input, async () => {
        const loaded = await loadRegistry(input);
        if (loaded.kind !== "ready") return loaded;
        const authorization = evaluateConditionalCommitAuthorization(input, loaded.registry, input);
        if (authorization.kind !== "authorized") return authorization;
        return {
            kind: "prepared",
            authorization: authorization.authorization,
            commitToken: createRecordWorkCommitToken(input, authorization.authorization),
        };
    });
}

export async function revalidateRecordWorkCommit(location: RecordWorkRegistryLocation, token: RecordWorkCommitToken, options: { nowMs?: number } = {}): Promise<ConditionalCommitAuthorizationResult | { kind: "invalid_commit_token"; reason: "identity_mismatch" | "integrity_mismatch"; path: string }> {
    assertIdentity(location.identity);
    const tokenValidation = validateRecordWorkCommitToken(location, token);
    if (tokenValidation !== "valid") return { kind: "invalid_commit_token", reason: tokenValidation, path: recordWorkRegistryPath(location) };
    return withRegistryLock(location, async () => {
        const loaded = await loadRegistry(location);
        if (loaded.kind !== "ready") return loaded;
        const input = authorizationInputFromToken(location, token, options.nowMs);
        return evaluateConditionalCommitAuthorization(location, loaded.registry, input);
    });
}

export async function withAuthorizedRecordWorkCommit<Value>(input: ConditionalCommitAuthorizationInput, stage: (authorization: ConditionalCommitAuthorization) => Value | Promise<Value>): Promise<ConditionalCommitExecutionResult<Value>> {
    const prepared = await prepareRecordWorkCommit(input);
    if (prepared.kind !== "prepared") return prepared;
    const value = await stage(clone(prepared.authorization));
    const revalidated = await revalidateRecordWorkCommit(input, prepared.commitToken, { nowMs: input.nowMs });
    if (revalidated.kind !== "authorized") return revalidated;
    return {
        kind: "staged",
        authorization: revalidated.authorization,
        commitToken: prepared.commitToken,
        value,
    };
}

export async function withRecordWorkCommitAuthority<Value>(
    input: ConditionalCommitAuthorizationInput,
    operation: (authorization: ConditionalCommitAuthorization) => Promise<Value>,
    options: RecordWorkCommitAuthorityOptions = {},
): Promise<RecordWorkCommitAuthorityResult<Value>> {
    assertIdentity(input.identity);
    return withRegistryLock(input, async lock => {
        const before = await loadRegistry(input);
        if (before.kind !== "ready") return before;
        const beforeAuthorization = evaluateConditionalCommitAuthorization(input, before.registry, input, options);
        if (beforeAuthorization.kind !== "authorized") return beforeAuthorization;
        await assertRegistryLockOwnership(lock);
        const value = await operation(clone(beforeAuthorization.authorization));
        await assertRegistryLockOwnership(lock);
        const after = await loadRegistry(input);
        if (after.kind !== "ready") return after;
        const afterAuthorization = evaluateConditionalCommitAuthorization(input, after.registry, input, options);
        if (afterAuthorization.kind !== "authorized") return afterAuthorization;
        await assertRegistryLockOwnership(lock);
        return {
            kind: "committed",
            authorization: afterAuthorization.authorization,
            value,
        };
    });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (typeof value === "object" || typeof value === "function")
        && value !== null
        && typeof (value as PromiseLike<unknown>).then === "function";
}

export async function publishRecordWorkCommit<Value>(location: RecordWorkRegistryLocation, token: RecordWorkCommitToken, publish: (authorization: ConditionalCommitAuthorization) => Value, options: { nowMs?: number } = {}): Promise<PublishRecordWorkCommitResult<Value>> {
    assertIdentity(location.identity);
    const tokenValidation = validateRecordWorkCommitToken(location, token);
    if (tokenValidation !== "valid") return { kind: "invalid_commit_token", reason: tokenValidation, path: recordWorkRegistryPath(location) };
    return withRegistryLock(location, async lock => {
        const before = await loadRegistry(location);
        if (before.kind !== "ready") return before;
        const input = authorizationInputFromToken(location, token, options.nowMs);
        const beforeAuthorization = evaluateConditionalCommitAuthorization(location, before.registry, input);
        if (beforeAuthorization.kind !== "authorized") return beforeAuthorization;
        await assertRegistryLockOwnership(lock);
        const value = publish(clone(beforeAuthorization.authorization));
        if (isPromiseLike(value)) throw new TypeError("publishRecordWorkCommit 的 publish callback 必须同步且短时；异步工作应先写入幂等 staging");
        await assertRegistryLockOwnership(lock);
        const after = await loadRegistry(location);
        if (after.kind !== "ready") return after;
        const afterAuthorization = evaluateConditionalCommitAuthorization(location, after.registry, input);
        if (afterAuthorization.kind !== "authorized") return afterAuthorization;
        await assertRegistryLockOwnership(lock);
        return {
            kind: "committed",
            authorization: afterAuthorization.authorization,
            commitToken: token,
            value,
        };
    });
}
