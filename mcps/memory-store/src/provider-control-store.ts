import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DATA_ROOT } from "./store.js";
import {
    MAX_BREAKER_OPEN_MS,
    PROVIDER_CONTROL_FILE_NAME,
    PROVIDER_CONTROL_INSTALL_MANIFEST_DIRECTORY,
    PROVIDER_CONTROL_INSTALL_MANIFEST_FILE_NAME,
    PROVIDER_CONTROL_INITIALIZATION_FILE_NAME,
    PROVIDER_CONTROL_KIND,
    PROVIDER_CONTROL_SCHEMA_VERSION,
    PROVIDER_IDS,
    assertProviderControlState,
    createInitialProviderControlState,
    matchesProviderLeaseIdentity,
    providerLeaseIdentity,
    type ProviderControlDurabilityProfile,
    type ProviderControlInstallationIdentity,
    type ProviderFreezeEvidence,
    type ProviderManualRecoveryEvidence,
    type ProviderControlRepairReason,
    type ProviderControlRepairState,
    type ProviderControlState,
    type ProviderId,
    type ProviderLease,
    type ProviderLeaseIdentity,
    type ProviderOwnerLease,
    type ProviderUncertainLease,
} from "./provider-control-contracts.js";

const DEFAULT_LOCK_TIMEOUT_MS = 15_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const LOCK_SNAPSHOT_MAX_ATTEMPTS = 8;
const LOCK_SNAPSHOT_MAX_BACKOFF_MS = 4;
const LOCK_RELEASE_MAX_ATTEMPTS = 32;
const INITIALIZATION_MARKER_SCHEMA_VERSION = 1 as const;
const INSTALL_MANIFEST_SCHEMA_VERSION = 1 as const;
const SYNTHETIC_CLOCK_CUTOFF_MS = Date.UTC(2000, 0, 1);

export interface ProviderControlLockOptions {
    timeoutMs?: number;
    staleMs?: number;
    retryMs?: number;
}

export interface ProviderControlStoreOptions {
    dataRoot?: string;
    controlFilePath?: string;
    lock?: ProviderControlLockOptions;
}

export interface ProviderControlPaths {
    dataRoot: string;
    controlPath: string;
    initializationMarkerPath: string;
    installManifestDirectory: string;
    installManifestPath: string;
    lockPath: string;
}

export interface ProviderControlDurabilityReceipt {
    verifier: "provider-control-store";
    controlPath: string;
    controlRevision: number;
    ownerEpoch: number;
    ownerLeaseId: string | null;
    ownerLeaseExpiresAtMs: number | null;
    installationId: string;
    publicationId: string;
    stateHash: string;
    readBackHash: string;
    fileIdentity: string;
    rootIdentity: string;
    verifiedAtMs: number;
    durability: ProviderControlDurabilityProfile;
}

export interface ProviderControlCurrentRead {
    kind: "current";
    paths: ProviderControlPaths;
    state: ProviderControlState;
    receipt: ProviderControlDurabilityReceipt;
}

export interface ProviderControlRepairRead {
    kind: "repair-required";
    paths: ProviderControlPaths;
    repair: ProviderControlRepairState;
}

export type ProviderControlReadResult = ProviderControlCurrentRead | ProviderControlRepairRead;

export interface ProviderControlFileLock {
    readonly path: string;
    readonly token: string;
    heartbeat(): Promise<void>;
    assertHeld(): Promise<void>;
    release(): Promise<void>;
}

export type ProviderControlLockTestPhase = "snapshot-before-open" | "stale-observed" | "stale-claim-acquired" | "before-stale-rename" | "stale-quarantined" | "before-release-unlink";

export interface ProviderControlLockTestContext {
    phase: ProviderControlLockTestPhase;
    lockPath: string;
}

export type ProviderControlLockTestHook = (context: ProviderControlLockTestContext) => void | Promise<void>;

export type ProviderControlPathSafetyTestPhase = "before-read" | "before-publish" | "before-publish-rename-attempt" | "after-publish";

export interface ProviderControlPathSafetyTestContext {
    phase: ProviderControlPathSafetyTestPhase;
    paths: ProviderControlPaths;
    renameAttempt?: number;
    sourcePath?: string;
    targetPath?: string;
}

export type ProviderControlPathSafetyTestHook = (context: ProviderControlPathSafetyTestContext) => void | Promise<void>;

export interface InitializeProviderControlStoreInput extends ProviderControlStoreOptions {
    initialization: "exclusive-install";
    nowMs?: number;
    bootstrap?: ProviderControlBootstrapIdentity;
}

export interface ProviderControlBootstrapIdentity {
    token: string;
    identity: string;
}

export interface BootstrapProviderControlStoreInput extends ProviderControlStoreOptions {
    initialization: "exclusive-install";
    bootstrap: ProviderControlBootstrapIdentity;
    nowMs?: number;
}

export interface ProviderControlMutationInput<Value> extends ProviderControlStoreOptions {
    expectedRevision?: number;
    nowMs?: number;
    mutate(state: ProviderControlState): Promise<Value> | Value;
}

export interface ProviderControlMutationResult<Value> {
    state: ProviderControlState;
    receipt: ProviderControlDurabilityReceipt;
    value: Value;
}

export interface ProviderControlOwnerFence {
    ownerEpoch: number;
    ownerLeaseId: string;
}

export interface ClaimProviderControlOwnerInput extends ProviderControlStoreOptions {
    ownerId: string;
    ownerLeaseId?: string;
    leaseDurationMs: number;
    nowMs?: number;
    expectedRevision?: number;
}

export interface RenewProviderControlOwnerInput extends ProviderControlStoreOptions, ProviderControlOwnerFence {
    leaseDurationMs: number;
    nowMs?: number;
    expectedRevision?: number;
}

export interface ApplyProviderCongestionLossInput extends ProviderControlStoreOptions, ProviderControlOwnerFence {
    provider: ProviderId;
    attemptId: string;
    capacityGeneration: number;
    nowMs?: number;
}

export interface ApplyProviderCongestionLossResult {
    applied: boolean;
    state: ProviderControlState;
    receipt: ProviderControlDurabilityReceipt;
}

export interface ObserveProviderControlTimeInput extends ProviderControlStoreOptions, ProviderControlOwnerFence {
    observedNowMs: number;
}

export interface ClearProviderTimeFrozenInput extends ProviderControlStoreOptions, ProviderControlOwnerFence {
    provider: ProviderId;
    recoveryEvidence?: ProviderManualRecoveryEvidence;
    explicitAcknowledgement?: "manual-time-recovery";
    nowMs?: number;
}

export type ProviderLeaseRecoveryRead = {
    kind: "absent";
} | {
    kind: "active" | "uncertain";
    identity: ProviderLeaseIdentity;
} | {
    kind: "corrupt";
    detail: string;
};

export interface ReadProviderLeaseByAttemptInput extends ProviderControlStoreOptions {
    provider: ProviderId;
    attemptId: string;
}

export interface ReclaimExpiredProviderLeasesInput extends ProviderControlStoreOptions, ProviderControlOwnerFence {
    provider?: ProviderId;
    nowMs?: number;
}

export interface ProviderLeaseReclaimResult {
    activeLeaseIds: string[];
    uncertainLeaseIds: string[];
}

export interface SettleRecoveredProviderLeaseInput extends ProviderControlStoreOptions, ProviderControlOwnerFence {
    identity: ProviderLeaseIdentity;
    nowMs?: number;
}

export type ProviderRecoveredLeaseSettlement = {
    kind: "settled" | "already-settled";
};

export interface VerifyProviderControlReceiptOptions extends ProviderControlStoreOptions {
    nowMs?: number;
}

export class ProviderControlStoreError extends Error {
    constructor(message: string, readonly code: string) {
        super(message);
        this.name = "ProviderControlStoreError";
    }
}

export class ProviderControlRepairRequiredError extends ProviderControlStoreError {
    constructor(readonly repair: ProviderControlRepairState) {
        super(`provider control 需要修复：${repair.reason}，${repair.detail}`, "REPAIR_REQUIRED");
        this.name = "ProviderControlRepairRequiredError";
    }
}

export class ProviderControlConflictError extends ProviderControlStoreError {
    constructor(expectedRevision: number, actualRevision: number) {
        super(`provider control revision 冲突：expected=${expectedRevision} actual=${actualRevision}`, "REVISION_CONFLICT");
        this.name = "ProviderControlConflictError";
    }
}

export class ProviderControlFencedError extends ProviderControlStoreError {
    constructor(message: string) {
        super(message, "OWNER_FENCED");
        this.name = "ProviderControlFencedError";
    }
}

export class ProviderControlLockTimeoutError extends ProviderControlStoreError {
    constructor(timeoutMs: number) {
        super(`provider control 文件锁在 ${timeoutMs}ms 内未释放`, "LOCK_TIMEOUT");
        this.name = "ProviderControlLockTimeoutError";
    }
}

export class ProviderControlPathSafetyError extends ProviderControlStoreError {
    constructor(message: string) {
        super(message, "PATH_UNSAFE");
        this.name = "ProviderControlPathSafetyError";
    }
}

let lockTestHook: ProviderControlLockTestHook | undefined;
let pathSafetyTestHook: ProviderControlPathSafetyTestHook | undefined;

export function setProviderControlLockTestHookForTest(hook?: ProviderControlLockTestHook): void {
    lockTestHook = hook;
}

export function setProviderControlPathSafetyTestHookForTest(hook?: ProviderControlPathSafetyTestHook): void {
    pathSafetyTestHook = hook;
}

export function resolveProviderControlPaths(options: ProviderControlStoreOptions = {}): ProviderControlPaths {
    const dataRoot = path.resolve(options.dataRoot ?? DATA_ROOT);
    const controlPath = path.resolve(options.controlFilePath ?? path.join(dataRoot, PROVIDER_CONTROL_FILE_NAME));
    if (path.dirname(controlPath) !== dataRoot || path.basename(controlPath) !== PROVIDER_CONTROL_FILE_NAME) {
        throw new ProviderControlPathSafetyError(`provider control 路径必须是 DATA_ROOT 下的 ${PROVIDER_CONTROL_FILE_NAME}`);
    }
    const installManifestDirectory = path.join(dataRoot, PROVIDER_CONTROL_INSTALL_MANIFEST_DIRECTORY);
    return {
        dataRoot,
        controlPath,
        initializationMarkerPath: path.join(dataRoot, PROVIDER_CONTROL_INITIALIZATION_FILE_NAME),
        installManifestDirectory,
        installManifestPath: path.join(installManifestDirectory, PROVIDER_CONTROL_INSTALL_MANIFEST_FILE_NAME),
        lockPath: `${controlPath}.lock`,
    };
}

export function providerControlPath(options: ProviderControlStoreOptions = {}): string {
    return resolveProviderControlPaths(options).controlPath;
}

export function providerControlLockPath(options: ProviderControlStoreOptions = {}): string {
    return resolveProviderControlPaths(options).lockPath;
}

export function calculateProviderControlHash(state: ProviderControlState): string {
    const payload = structuredClone(state) as unknown as Record<string, unknown>;
    delete payload.persistedHash;
    return crypto.createHash("sha256").update(stableJsonStringify(payload), "utf8").digest("hex");
}

export function providerControlDurabilityProfile(): ProviderControlDurabilityProfile {
    return {
        scope: "process-crash-and-hot-restart",
        suddenPowerLossGuaranteed: false,
        directoryDurability: process.platform === "win32" ? "not-claimed-on-windows" : "best-effort",
        pathRaceProtection: "root-and-parent-identity-rechecked",
        openAtProtection: "unavailable-in-node-path-api",
        wholeDataRootErasureDetectable: false,
    };
}

export async function readProviderControlStore(options: ProviderControlStoreOptions = {}): Promise<ProviderControlReadResult> {
    const paths = resolveProviderControlPaths(options);
    try {
        return await readProviderControlStoreAt(paths);
    } catch (error) {
        if (error instanceof ProviderControlPathSafetyError) return repairRead(paths, "control_file_unsafe", error.message);
        throw error;
    }
}

export async function readProviderLeaseByAttempt(input: ReadProviderLeaseByAttemptInput): Promise<ProviderLeaseRecoveryRead> {
    assertProviderId(input.provider, "provider");
    assertNonEmpty(input.attemptId, "attemptId");
    const current = await readProviderControlStore(input);
    if (current.kind === "repair-required") {
        return { kind: "corrupt", detail: `${current.repair.reason}: ${current.repair.detail}` };
    }
    const pool = current.state.pools[input.provider];
    const active = pool.activeLeases.filter(lease => lease.attemptId === input.attemptId);
    const uncertain = pool.uncertainLeases.filter(lease => lease.attemptId === input.attemptId);
    if (active.length === 0 && uncertain.length === 0) return { kind: "absent" };
    if (active.length === 1 && uncertain.length === 0) return { kind: "active", identity: providerLeaseIdentity(active[0]) };
    if (active.length === 0 && uncertain.length === 1) return { kind: "uncertain", identity: providerLeaseIdentity(uncertain[0]) };
    return { kind: "corrupt", detail: `provider=${input.provider} attemptId=${input.attemptId} 在 active/uncertain 中存在多个 lease` };
}

export async function initializeProviderControlStore(input: InitializeProviderControlStoreInput): Promise<ProviderControlCurrentRead> {
    if (input.initialization !== "exclusive-install") throw new ProviderControlStoreError("首次 provider control 初始化必须显式使用 exclusive-install", "INITIALIZATION_MODE_REQUIRED");
    const paths = resolveProviderControlPaths(input);
    const compatibilityBootstrap = input.bootstrap ?? {
        token: `exclusive-install:${paths.dataRoot}`,
        identity: `canonical-data-root:${paths.dataRoot}`,
    };
    return initializeProviderControlStoreInternal(input, compatibilityBootstrap);
}

export async function bootstrapProviderControlStore(input: BootstrapProviderControlStoreInput): Promise<ProviderControlCurrentRead> {
    assertNonEmpty(input.bootstrap.token, "bootstrap.token");
    assertNonEmpty(input.bootstrap.identity, "bootstrap.identity");
    return initializeProviderControlStoreInternal(input, input.bootstrap);
}

async function initializeProviderControlStoreInternal(
    input: InitializeProviderControlStoreInput | BootstrapProviderControlStoreInput,
    bootstrap: ProviderControlBootstrapIdentity,
): Promise<ProviderControlCurrentRead> {
    const paths = resolveProviderControlPaths(input);
    return withProviderControlFileLock(async lock => {
        const current = await readProviderControlStoreAt(paths);
        if (current.kind === "current") return current;
        if (current.repair.reason !== "first_install_required") throw new ProviderControlRepairRequiredError(current.repair);
        const nowMs = input.nowMs ?? Date.now();
        assertSafeTime(nowMs, "initialization nowMs");
        assertNonEmpty(bootstrap.token, "bootstrap.token");
        assertNonEmpty(bootstrap.identity, "bootstrap.identity");
        const initializationId = crypto.randomUUID();
        const initialPublicationId = crypto.randomUUID();
        const installation: ProviderControlInstallationIdentity = {
            initializationId,
            bootstrapIdentityHash: sha256(bootstrap.identity),
            bootstrapTokenHash: sha256(bootstrap.token),
            initialPublicationId,
        };
        const manifest = createInstallManifest(installation, nowMs);
        await writeDurableJsonAtomic(paths, paths.installManifestPath, manifest, lock);
        await writeDurableJsonAtomic(paths, paths.initializationMarkerPath, {
            schemaVersion: INITIALIZATION_MARKER_SCHEMA_VERSION,
            kind: "record-provider-control-initialization",
            initializationId,
            initialPublicationId,
            manifestHash: manifest.manifestHash,
            initializedAtMs: nowMs,
        }, lock);
        const state = createInitialProviderControlState(nowMs, initialPublicationId, installation);
        const receipt = await publishProviderControlState(paths, state, lock);
        return { kind: "current", paths, state, receipt };
    }, input);
}

export async function mutateProviderControlState<Value>(input: ProviderControlMutationInput<Value>): Promise<ProviderControlMutationResult<Value>> {
    const paths = resolveProviderControlPaths(input);
    return withProviderControlFileLock(async lock => {
        const current = await readProviderControlStoreAt(paths);
        if (current.kind !== "current") throw new ProviderControlRepairRequiredError(current.repair);
        if (input.expectedRevision !== undefined && current.state.controlRevision !== input.expectedRevision) {
            throw new ProviderControlConflictError(input.expectedRevision, current.state.controlRevision);
        }
        if (current.state.ownerLease !== null) {
            throw new ProviderControlFencedError("运行期 provider control 已有 owner，通用 maintenance mutation 不得绕过 owner fence");
        }
        const next = structuredClone(current.state);
        const protectedBefore = protectedRuntimeHash(current.state);
        const value = await input.mutate(next);
        if (protectedRuntimeHash(next) !== protectedBefore) {
            throw new ProviderControlFencedError("通用 maintenance mutation 不得修改 owner、lease、容量、breaker、time 或 agy 运行字段");
        }
        prepareNextRevision(current.state, next, input.nowMs ?? current.state.lastObservedWallClockMs);
        const receipt = await publishProviderControlState(paths, next, lock);
        return { state: next, receipt, value };
    }, input);
}

export async function claimProviderControlOwner(input: ClaimProviderControlOwnerInput): Promise<ProviderControlMutationResult<ProviderOwnerLease>> {
    assertNonEmpty(input.ownerId, "ownerId");
    assertDuration(input.leaseDurationMs, "leaseDurationMs", 24 * 60 * 60_000);
    const nowMs = input.nowMs ?? Date.now();
    assertSafeTime(nowMs, "claim nowMs");
    const paths = resolveProviderControlPaths(input);
    return withProviderControlFileLock(async lock => {
        const current = await requireCurrent(paths);
        assertExpectedRevision(current.state, input.expectedRevision);
        if (nowMs < current.state.lastObservedWallClockMs) throw new ProviderControlFencedError("owner claim nowMs 早于 lastObservedWallClockMs");
        const next = structuredClone(current.state);
            const ownerLease: ProviderOwnerLease = {
                ownerId: input.ownerId,
                leaseId: input.ownerLeaseId ?? crypto.randomUUID(),
                acquiredAtMs: nowMs,
                expiresAtMs: nowMs + input.leaseDurationMs,
            };
        next.ownerEpoch += 1;
        next.ownerLease = ownerLease;
        next.lastObservedWallClockMs = nowMs;
        for (const provider of PROVIDER_IDS) next.pools[provider].breaker.probeLease = null;
        prepareNextRevision(current.state, next, nowMs);
        const receipt = await publishProviderControlState(paths, next, lock);
        return { state: next, receipt, value: ownerLease };
    }, input);
}

export async function renewProviderControlOwner(input: RenewProviderControlOwnerInput): Promise<ProviderControlMutationResult<ProviderOwnerLease>> {
    assertDuration(input.leaseDurationMs, "leaseDurationMs", 24 * 60 * 60_000);
    const nowMs = input.nowMs ?? Date.now();
    assertSafeTime(nowMs, "renew nowMs");
    const requestedExpiresAtMs = nowMs + input.leaseDurationMs;
    assertSafeTime(requestedExpiresAtMs, "renew expiresAtMs");
    const paths = resolveProviderControlPaths(input);
    return withProviderControlFileLock(async lock => {
        const current = await requireCurrent(paths);
        assertCurrentOwnerIdentity(current.state, input);
        if (nowMs < current.state.lastObservedWallClockMs) throw new ProviderControlFencedError("owner renew nowMs 早于 lastObservedWallClockMs");
        assertCurrentOwnerFence(current.state, input, nowMs);
        const ownerLease = current.state.ownerLease!;
        if (requestedExpiresAtMs <= ownerLease.expiresAtMs) {
            return { state: current.state, receipt: current.receipt, value: ownerLease };
        }
        assertExpectedRevision(current.state, input.expectedRevision);
        const next = structuredClone(current.state);
        next.ownerLease = { ...ownerLease, expiresAtMs: requestedExpiresAtMs };
        prepareNextRevision(current.state, next, nowMs);
        const receipt = await publishProviderControlState(paths, next, lock);
        if (receipt.ownerEpoch !== input.ownerEpoch
            || receipt.ownerLeaseId !== input.ownerLeaseId
            || receipt.ownerLeaseExpiresAtMs !== requestedExpiresAtMs) {
            throw new ProviderControlStoreError("owner renew 原子发布后的 fence/expiry 回读不一致", "READBACK_MISMATCH");
        }
        return { state: next, receipt, value: next.ownerLease! };
    }, input);
}

export async function mutateProviderControlAsOwner<Value>(
    input: ProviderControlMutationInput<Value> & ProviderControlOwnerFence,
): Promise<ProviderControlMutationResult<Value>> {
    return mutateProviderControlAsOwnerInternal(input, false);
}

export async function reclaimExpiredProviderLeases(
    input: ReclaimExpiredProviderLeasesInput,
): Promise<ProviderControlMutationResult<ProviderLeaseReclaimResult>> {
    const nowMs = input.nowMs ?? Date.now();
    assertSafeTime(nowMs, "reclaim nowMs");
    if (input.provider !== undefined) assertProviderId(input.provider, "provider");
    const paths = resolveProviderControlPaths(input);
    return withProviderControlFileLock(async lock => {
        const current = await requireCurrent(paths);
        assertCurrentOwnerIdentity(current.state, input);
        assertCurrentOwnerFence(current.state, input, nowMs);
        const next = structuredClone(current.state);
        const reclaimed = pruneExpiredProviderLeases(next, input.provider, nowMs);
        if (reclaimed.activeLeaseIds.length === 0 && reclaimed.uncertainLeaseIds.length === 0) {
            return { state: current.state, receipt: current.receipt, value: reclaimed };
        }
        next.lastObservedWallClockMs = Math.max(next.lastObservedWallClockMs, nowMs);
        prepareNextRevision(current.state, next, next.lastObservedWallClockMs);
        const receipt = await publishProviderControlState(paths, next, lock);
        return { state: next, receipt, value: reclaimed };
    }, input);
}

export async function settleRecoveredProviderLease(
    input: SettleRecoveredProviderLeaseInput,
): Promise<ProviderControlMutationResult<ProviderRecoveredLeaseSettlement>> {
    assertProviderLeaseIdentity(input.identity);
    const nowMs = input.nowMs ?? Date.now();
    assertSafeTime(nowMs, "recovered settle nowMs");
    const paths = resolveProviderControlPaths(input);
    return withProviderControlFileLock(async lock => {
        const current = await requireCurrent(paths);
        assertCurrentOwnerIdentity(current.state, input);
        assertCurrentOwnerFence(current.state, input, nowMs);
        const pool = current.state.pools[input.identity.provider];
        const activeMatches = pool.activeLeases.filter(lease => matchesProviderLeaseIdentity(lease, input.identity));
        const uncertainMatches = pool.uncertainLeases.filter(lease => matchesProviderLeaseIdentity(lease, input.identity));
        if (activeMatches.length === 0 && uncertainMatches.length === 0) {
            if (pool.activeLeases.some(lease => lease.attemptId === input.identity.attemptId || lease.leaseId === input.identity.leaseId)
                || pool.uncertainLeases.some(lease => lease.attemptId === input.identity.attemptId || lease.leaseId === input.identity.leaseId)) {
                throw new ProviderControlFencedError(`recovered lease ${input.identity.leaseId} identity 已被不同值取代`);
            }
            return { state: current.state, receipt: current.receipt, value: { kind: "already-settled" } };
        }
        if (activeMatches.length + uncertainMatches.length !== 1) {
            throw new ProviderControlStoreError(`recovered lease ${input.identity.leaseId} 在 active/uncertain 中重复`, "RECOVERY_LEASE_CORRUPT");
        }
        const next = structuredClone(current.state);
        const nextPool = next.pools[input.identity.provider];
        nextPool.activeLeases = nextPool.activeLeases.filter(lease => !matchesProviderLeaseIdentity(lease, input.identity));
        nextPool.uncertainLeases = nextPool.uncertainLeases.filter(lease => !matchesProviderLeaseIdentity(lease, input.identity));
        if (nextPool.breaker.probeLease?.leaseId === input.identity.leaseId) nextPool.breaker.probeLease = null;
        if (input.identity.provider === "agy") rebuildAgyAdmissionLeaseIndexes(next);
        next.lastObservedWallClockMs = Math.max(next.lastObservedWallClockMs, nowMs);
        prepareNextRevision(current.state, next, next.lastObservedWallClockMs);
        const receipt = await publishProviderControlState(paths, next, lock);
        return { state: next, receipt, value: { kind: "settled" } };
    }, input);
}

async function mutateProviderControlAsOwnerInternal<Value>(
    input: ProviderControlMutationInput<Value> & ProviderControlOwnerFence,
    allowClockRollbackFreeze: boolean,
): Promise<ProviderControlMutationResult<Value>> {
    const paths = resolveProviderControlPaths(input);
    return withProviderControlFileLock(async lock => {
        const current = await requireCurrent(paths);
        assertExpectedRevision(current.state, input.expectedRevision);
        assertCurrentOwnerIdentity(current.state, input);
        const next = structuredClone(current.state);
        const value = await input.mutate(next);
        if (next.ownerEpoch !== current.state.ownerEpoch || stableJsonStringify(next.ownerLease) !== stableJsonStringify(current.state.ownerLease)) {
            throw new ProviderControlFencedError("运行期 mutation 不得改写 owner；owner 接管必须使用 claimProviderControlOwner");
        }
        const mutationNowMs = resolveMutationNow(current.state, next, input.nowMs);
        assertCurrentOwnerFence(current.state, input, Math.max(mutationNowMs, current.state.lastObservedWallClockMs));
        if (mutationNowMs < current.state.lastObservedWallClockMs && !allowClockRollbackFreeze) {
            throw new ProviderControlFencedError("owner mutation nowMs 发生倒退");
        }
        prepareNextRevision(current.state, next, Math.max(mutationNowMs, current.state.lastObservedWallClockMs));
        const receipt = await publishProviderControlState(paths, next, lock);
        return { state: next, receipt, value };
    }, input);
}

export async function applyProviderCongestionLoss(input: ApplyProviderCongestionLossInput): Promise<ApplyProviderCongestionLossResult> {
    assertNonEmpty(input.attemptId, "attemptId");
    assertPositiveInteger(input.capacityGeneration, "capacityGeneration");
    const nowMs = input.nowMs ?? Date.now();
    assertSafeTime(nowMs, "loss nowMs");
    let applied = false;
    const result = await mutateProviderControlAsOwner({
        ...input,
        nowMs,
        mutate(state) {
            const pool = state.pools[input.provider];
            if (pool.capacityGeneration !== input.capacityGeneration) return;
            const lostGeneration = pool.capacityGeneration;
            pool.currentLimit = Math.max(1, Math.floor(pool.currentLimit / 2));
            pool.capacityGeneration += 1;
            pool.lossEpoch += 1;
            pool.lastLoss = {
                lossEpoch: pool.lossEpoch,
                lostCapacityGeneration: lostGeneration,
                attemptId: input.attemptId,
                recordedAtMs: nowMs,
            };
            if (pool.activeLeases.length + pool.uncertainLeases.length > pool.currentLimit) {
                pool.timeFrozen = {
                    frozen: true,
                    reason: "capacity",
                    enteredAtMs: nowMs,
                    requiresManualClear: false,
                    frozenFailureAttemptIds: pool.timeFrozen.frozenFailureAttemptIds.includes(input.attemptId)
                        ? pool.timeFrozen.frozenFailureAttemptIds
                        : [...pool.timeFrozen.frozenFailureAttemptIds, input.attemptId],
                    freezeEvidence: null,
                };
            }
            state.lastObservedWallClockMs = Math.max(state.lastObservedWallClockMs, nowMs);
            applied = true;
        },
    });
    return { applied, state: result.state, receipt: result.receipt };
}

export async function observeProviderControlTime(input: ObserveProviderControlTimeInput): Promise<ProviderControlMutationResult<void>> {
    assertSafeTime(input.observedNowMs, "observedNowMs");
    return mutateProviderControlAsOwnerInternal({
        ...input,
        nowMs: input.observedNowMs,
        mutate(state) {
            if (input.observedNowMs < state.lastObservedWallClockMs) {
                for (const provider of PROVIDER_IDS) {
                    const pool = state.pools[provider];
                    pool.timeFrozen = {
                        frozen: true,
                        reason: "clock_non_monotonic",
                        enteredAtMs: state.lastObservedWallClockMs,
                        requiresManualClear: true,
                        frozenFailureAttemptIds: pool.timeFrozen.frozenFailureAttemptIds,
                        freezeEvidence: null,
                    };
                }
                return;
            }
            state.lastObservedWallClockMs = input.observedNowMs;
        },
    }, true);
}

export async function clearProviderTimeFrozen(input: ClearProviderTimeFrozenInput): Promise<ProviderControlMutationResult<void>> {
    const nowMs = input.nowMs ?? Date.now();
    assertSafeTime(nowMs, "clear frozen nowMs");
    return mutateProviderControlAsOwner({
        ...input,
        nowMs,
        mutate(state) {
            const pool = state.pools[input.provider];
            if (!pool.timeFrozen.frozen || !pool.timeFrozen.freezeEvidence) throw new ProviderControlFencedError("provider 当前没有可匹配的 freeze evidence");
            if (!input.recoveryEvidence && input.explicitAcknowledgement !== "manual-time-recovery") {
                throw new ProviderControlFencedError("人工恢复必须提交结构化 evidence；兼容调用仅接受固定 manual-time-recovery acknowledgement");
            }
            const evidence = input.recoveryEvidence ?? createCompatibilityRecoveryEvidence(state, input.provider, nowMs);
            assertManualRecoveryEvidence(evidence);
            if (evidence.freezeEvidenceId !== pool.timeFrozen.freezeEvidence.evidenceId
                || evidence.freezeEvidenceHash !== pool.timeFrozen.freezeEvidence.evidenceHash) {
                throw new ProviderControlFencedError("人工恢复证据与当前 freeze evidence 不匹配");
            }
            if (evidence.correctedNowMs !== nowMs || evidence.correctedNowMs < state.lastObservedWallClockMs) {
                throw new ProviderControlFencedError("人工恢复 corrected time 早于或不等于本次 nowMs");
            }
            if (evidence.acknowledgedAtMs < pool.timeFrozen.freezeEvidence.observedAtMs || evidence.acknowledgedAtMs > evidence.correctedNowMs) {
                throw new ProviderControlFencedError("人工恢复 ack 时间不在 freeze 到 corrected time 的范围内");
            }
            pool.lastManualRecovery = {
                ...evidence,
                recoveredOwnerEpoch: state.ownerEpoch,
                recoveredControlRevision: state.controlRevision + 1,
            };
            pool.timeFrozen = {
                frozen: false,
                reason: null,
                enteredAtMs: null,
                requiresManualClear: false,
                frozenFailureAttemptIds: [],
                freezeEvidence: null,
            };
            state.lastObservedWallClockMs = nowMs;
        },
    });
}

export async function verifyProviderControlDurabilityReceipt(
    receipt: ProviderControlDurabilityReceipt,
    options: VerifyProviderControlReceiptOptions = {},
): Promise<boolean> {
    let paths: ProviderControlPaths;
    try {
        paths = resolveProviderControlPaths(options);
    } catch {
        return false;
    }
    if (!samePath(receipt.controlPath, paths.controlPath)) return false;
    const current = await readProviderControlStore(options);
    if (current.kind !== "current") return false;
    const verificationNowMs = options.nowMs ?? current.state.lastObservedWallClockMs;
    if (!Number.isSafeInteger(verificationNowMs) || verificationNowMs < current.state.lastObservedWallClockMs) return false;
    if (receipt.ownerEpoch > 0 && (current.state.ownerLease === null
        || current.state.ownerLease.leaseId !== receipt.ownerLeaseId
        || current.state.ownerLease.expiresAtMs !== receipt.ownerLeaseExpiresAtMs
        || verificationNowMs >= current.state.ownerLease.expiresAtMs)) return false;
    return current.state.controlRevision === receipt.controlRevision
        && current.state.ownerEpoch === receipt.ownerEpoch
        && current.state.installation.initializationId === receipt.installationId
        && current.state.publicationId === receipt.publicationId
        && current.state.persistedHash === receipt.stateHash
        && receipt.stateHash === receipt.readBackHash
        && current.receipt.fileIdentity === receipt.fileIdentity
        && current.receipt.rootIdentity === receipt.rootIdentity;
}

export async function withProviderControlFileLock<Value>(
    callback: (lock: ProviderControlFileLock) => Promise<Value> | Value,
    options: ProviderControlStoreOptions = {},
): Promise<Value> {
    const paths = resolveProviderControlPaths(options);
    const lock = await acquireProviderControlFileLock(paths, options.lock ?? {});
    try {
        return await callback(lock);
    } finally {
        await lock.release();
    }
}

async function readProviderControlStoreAt(paths: ProviderControlPaths): Promise<ProviderControlReadResult> {
    await pathSafetyTestHook?.({ phase: "before-read", paths });
    await assertSafeLayout(paths);
    const marker = await readInitializationMarker(paths);
    const manifest = await readInstallManifest(paths);
    const control = await readControlState(paths);
    if (control.kind === "missing") {
        if (marker.kind === "missing" && manifest.kind === "missing") {
            return repairRead(paths, "first_install_required", "本地未发现任何安装证据；只有显式 bootstrap 可首次创建。若整个 DATA_ROOT 连同冗余证据被擦除，本机无法区分全盘擦除与真正首次安装");
        }
        if (marker.kind === "invalid") return repairRead(paths, "initialization_marker_corrupt", marker.detail);
        if (manifest.kind === "invalid") return repairRead(paths, "install_manifest_corrupt", manifest.detail);
        return repairRead(paths, "control_file_missing", "初始化标记或冗余 install manifest 仍存在，但 provider control 文件缺失");
    }
    if (control.kind === "invalid") return repairRead(paths, control.reason, control.detail);
    if (marker.kind === "missing") return repairRead(paths, "initialization_marker_missing", "provider control 存在但没有初始化标记，拒绝推断历史");
    if (marker.kind === "invalid") return repairRead(paths, "initialization_marker_corrupt", marker.detail);
    if (manifest.kind === "missing") return repairRead(paths, "install_manifest_missing", "provider control 存在但冗余 install manifest 缺失");
    if (manifest.kind === "invalid") return repairRead(paths, "install_manifest_corrupt", manifest.detail);
    if (control.state.installation.initializationId !== marker.value.initializationId
        || control.state.installation.initializationId !== manifest.value.initializationId
        || control.state.installation.initialPublicationId !== marker.value.initialPublicationId
        || control.state.installation.initialPublicationId !== manifest.value.initialPublicationId
        || marker.value.manifestHash !== manifest.value.manifestHash
        || control.state.installation.bootstrapIdentityHash !== manifest.value.bootstrapIdentityHash
        || control.state.installation.bootstrapTokenHash !== manifest.value.bootstrapTokenHash) {
        return repairRead(paths, "install_identity_mismatch", "control、marker 与冗余 install manifest 的安装身份不一致");
    }
    const receipt = await createReceipt(paths, control.state);
    return { kind: "current", paths, state: control.state, receipt };
}

async function readControlState(paths: ProviderControlPaths): Promise<{ kind: "current"; state: ProviderControlState } | { kind: "missing" } | { kind: "invalid"; reason: ProviderControlRepairReason; detail: string }> {
    let content: string;
    try {
        content = await readUtf8NoFollow(paths.controlPath);
    } catch (error) {
        if (isErrno(error, "ENOENT")) return { kind: "missing" };
        throw asStoreError("读取 provider control 失败", "CONTROL_READ_FAILED", error);
    }
    let value: unknown;
    try {
        value = JSON.parse(content);
    } catch (error) {
        return { kind: "invalid", reason: "control_file_corrupt", detail: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` };
    }
    if (value && typeof value === "object" && !Array.isArray(value) && "schemaVersion" in value && (value as { schemaVersion?: unknown }).schemaVersion !== PROVIDER_CONTROL_SCHEMA_VERSION) {
        const version = (value as { schemaVersion?: unknown }).schemaVersion;
        return {
            kind: "invalid",
            reason: typeof version === "number" && version < PROVIDER_CONTROL_SCHEMA_VERSION ? "legacy_schema" : "unknown_schema",
            detail: `不支持 provider control schemaVersion=${String(version)}`,
        };
    }
    try {
        assertProviderControlState(value);
        const state = value as ProviderControlState;
        const expectedHash = calculateProviderControlHash(state);
        if (state.persistedHash !== expectedHash) return { kind: "invalid", reason: "control_file_corrupt", detail: "persistedHash 与内容不匹配" };
        return { kind: "current", state };
    } catch (error) {
        return { kind: "invalid", reason: "control_file_corrupt", detail: error instanceof Error ? error.message : String(error) };
    }
}

interface InitializationMarker {
    schemaVersion: typeof INITIALIZATION_MARKER_SCHEMA_VERSION;
    kind: "record-provider-control-initialization";
    initializationId: string;
    initialPublicationId: string;
    manifestHash: string;
    initializedAtMs: number;
}

interface ProviderControlInstallManifest extends ProviderControlInstallationIdentity {
    schemaVersion: typeof INSTALL_MANIFEST_SCHEMA_VERSION;
    kind: "record-provider-control-install-manifest";
    createdAtMs: number;
    manifestHash: string;
}

type AuxiliaryRead<Value> = { kind: "current"; value: Value } | { kind: "missing" } | { kind: "invalid"; detail: string };

async function readInitializationMarker(paths: ProviderControlPaths): Promise<AuxiliaryRead<InitializationMarker>> {
    let content: string;
    try {
        content = await readUtf8NoFollow(paths.initializationMarkerPath);
    } catch (error) {
        if (isErrno(error, "ENOENT")) return { kind: "missing" };
        throw asStoreError("读取 provider control 初始化标记失败", "MARKER_READ_FAILED", error);
    }
    try {
        const value = JSON.parse(content) as Record<string, unknown>;
        const keys = Object.keys(value).sort();
        if (!value || typeof value !== "object" || Array.isArray(value)
            || keys.join("|") !== "initialPublicationId|initializationId|initializedAtMs|kind|manifestHash|schemaVersion"
            || value.schemaVersion !== INITIALIZATION_MARKER_SCHEMA_VERSION
            || value.kind !== "record-provider-control-initialization"
            || typeof value.initializationId !== "string" || !value.initializationId
            || typeof value.initialPublicationId !== "string" || !value.initialPublicationId
            || typeof value.manifestHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.manifestHash)
            || typeof value.initializedAtMs !== "number" || !Number.isSafeInteger(value.initializedAtMs) || value.initializedAtMs < 0) {
            return { kind: "invalid", detail: "初始化标记字段非法" };
        }
        return { kind: "current", value: value as unknown as InitializationMarker };
    } catch (error) {
        return { kind: "invalid", detail: `初始化标记解析失败：${error instanceof Error ? error.message : String(error)}` };
    }
}

async function readInstallManifest(paths: ProviderControlPaths): Promise<AuxiliaryRead<ProviderControlInstallManifest>> {
    let content: string;
    try {
        content = await readUtf8NoFollow(paths.installManifestPath);
    } catch (error) {
        if (isErrno(error, "ENOENT")) return { kind: "missing" };
        throw asStoreError("读取 provider control install manifest 失败", "MANIFEST_READ_FAILED", error);
    }
    try {
        const value = JSON.parse(content) as Record<string, unknown>;
        const expectedKeys = "bootstrapIdentityHash|bootstrapTokenHash|createdAtMs|initialPublicationId|initializationId|kind|manifestHash|schemaVersion";
        if (!value || typeof value !== "object" || Array.isArray(value)
            || Object.keys(value).sort().join("|") !== expectedKeys
            || value.schemaVersion !== INSTALL_MANIFEST_SCHEMA_VERSION
            || value.kind !== "record-provider-control-install-manifest"
            || typeof value.initializationId !== "string" || !value.initializationId
            || typeof value.initialPublicationId !== "string" || !value.initialPublicationId
            || typeof value.bootstrapIdentityHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.bootstrapIdentityHash)
            || typeof value.bootstrapTokenHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.bootstrapTokenHash)
            || typeof value.manifestHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.manifestHash)
            || typeof value.createdAtMs !== "number" || !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0) {
            return { kind: "invalid", detail: "install manifest 字段非法" };
        }
        const manifest = value as unknown as ProviderControlInstallManifest;
        if (manifest.manifestHash !== calculateInstallManifestHash(manifest)) return { kind: "invalid", detail: "install manifest hash 不匹配" };
        return { kind: "current", value: manifest };
    } catch (error) {
        return { kind: "invalid", detail: `install manifest 解析失败：${error instanceof Error ? error.message : String(error)}` };
    }
}

async function publishProviderControlState(paths: ProviderControlPaths, state: ProviderControlState, lock: ProviderControlFileLock): Promise<ProviderControlDurabilityReceipt> {
    await lock.assertHeld();
    normalizeProviderControlState(state);
    if (state.ownerLease && state.lastObservedWallClockMs >= state.ownerLease.expiresAtMs) {
        throw new ProviderControlFencedError("provider control owner lease 已过期，拒绝生成 mutation/grant receipt");
    }
    state.persistedHash = "";
    state.persistedHash = calculateProviderControlHash(state);
    assertProviderControlState(state);
    await writeDurableJsonAtomic(paths, paths.controlPath, state, lock);
    await pathSafetyTestHook?.({ phase: "after-publish", paths });
    await assertSafeLayout(paths);
    const readBack = await readControlState(paths);
    if (readBack.kind !== "current" || readBack.state.persistedHash !== state.persistedHash || readBack.state.publicationId !== state.publicationId) {
        throw new ProviderControlStoreError("provider control 原子发布后的回读 hash/identity 不一致", "READBACK_MISMATCH");
    }
    return createReceipt(paths, readBack.state);
}

async function createReceipt(paths: ProviderControlPaths, state: ProviderControlState): Promise<ProviderControlDurabilityReceipt> {
    const safety = await assertSafeLayout(paths);
    const stat = await statNoFollow(paths.controlPath);
    return {
        verifier: "provider-control-store",
        controlPath: paths.controlPath,
        controlRevision: state.controlRevision,
        ownerEpoch: state.ownerEpoch,
        ownerLeaseId: state.ownerLease?.leaseId ?? null,
        ownerLeaseExpiresAtMs: state.ownerLease?.expiresAtMs ?? null,
        installationId: state.installation.initializationId,
        publicationId: state.publicationId,
        stateHash: state.persistedHash,
        readBackHash: state.persistedHash,
        fileIdentity: fileIdentity(stat),
        rootIdentity: safety.rootIdentity,
        verifiedAtMs: Date.now(),
        durability: providerControlDurabilityProfile(),
    };
}

async function writeDurableJsonAtomic(paths: ProviderControlPaths, targetPath: string, value: unknown, lock: ProviderControlFileLock): Promise<void> {
    await lock.assertHeld();
    await ensureSafeTargetParent(paths, targetPath);
    const initialSafety = await assertSafeLayout(paths);
    const temporaryPath = `${targetPath}.tmp.${process.pid}.${crypto.randomUUID()}`;
    let temporaryHandle: fs.promises.FileHandle | undefined;
    try {
        temporaryHandle = await fs.promises.open(temporaryPath, "wx");
        await temporaryHandle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = undefined;
        await pathSafetyTestHook?.({ phase: "before-publish", paths });
        await lock.assertHeld();
        await assertSafeLayout(paths, initialSafety);
        await renameWithRetry(temporaryPath, targetPath, paths);
        await assertSafeLayout(paths, initialSafety);
        const persisted = await openNoFollow(targetPath, fs.constants.O_RDWR);
        try {
            await persisted.sync();
        } finally {
            await persisted.close();
        }
    } catch (error) {
        if (temporaryHandle) await temporaryHandle.close().catch(() => undefined);
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
        if (error instanceof ProviderControlStoreError) throw error;
        throw asStoreError("provider control 原子发布失败", "ATOMIC_PUBLISH_FAILED", error);
    }
}

async function acquireProviderControlFileLock(paths: ProviderControlPaths, options: ProviderControlLockOptions): Promise<ProviderControlFileLock> {
    const timeoutMs = positiveMs(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS, "lock timeout");
    const staleMs = positiveMs(options.staleMs, DEFAULT_LOCK_STALE_MS, "lock stale");
    const retryMs = positiveMs(options.retryMs, DEFAULT_LOCK_RETRY_MS, "lock retry");
    const deadline = Date.now() + timeoutMs;
    while (true) {
        await assertSafeLayout(paths);
        const token = crypto.randomUUID();
        try {
            const handle = await fs.promises.open(paths.lockPath, "wx");
            const metadata: ProviderControlLockMetadata = { token, ownerPid: process.pid, createdAtMs: Date.now(), heartbeatAtMs: Date.now() };
            try {
                await handle.writeFile(JSON.stringify(metadata), "utf8");
                await handle.sync();
            } catch (error) {
                await handle.close().catch(() => undefined);
                await releaseOwnedLock(paths.lockPath, token).catch(() => undefined);
                throw asStoreError("写入 provider control lock 失败", "LOCK_WRITE_FAILED", error);
            }
            return createFileLock(paths, token, handle);
        } catch (error) {
            if (!isErrno(error, "EEXIST") && !isTransientWindowsLockRace(error)) {
                if (error instanceof ProviderControlStoreError) throw error;
                throw asStoreError("获取 provider control lock 失败", "LOCK_ACQUIRE_FAILED", error);
            }
            await breakStaleLock(paths, staleMs);
            if (Date.now() >= deadline) throw new ProviderControlLockTimeoutError(timeoutMs);
            await sleep(retryMs);
        }
    }
}

function createFileLock(paths: ProviderControlPaths, token: string, handle: fs.promises.FileHandle): ProviderControlFileLock {
    let released = false;
    const assertHeld = async (): Promise<void> => {
        if (released) throw new ProviderControlStoreError("provider control lock 已释放", "LOCK_RELEASED");
        const snapshot = await readLockSnapshot(paths.lockPath);
        if (!snapshot || snapshot.metadata.token !== token) throw new ProviderControlStoreError("provider control lock 已被其他 owner 接管", "LOCK_LOST");
    };
    return {
        path: paths.lockPath,
        token,
        assertHeld,
        async heartbeat(): Promise<void> {
            await assertHeld();
            const metadata: ProviderControlLockMetadata = { token, ownerPid: process.pid, createdAtMs: Date.now(), heartbeatAtMs: Date.now() };
            try {
                await handle.truncate(0);
                await handle.writeFile(JSON.stringify(metadata), "utf8");
                await handle.sync();
                await assertHeld();
            } catch (error) {
                if (error instanceof ProviderControlStoreError) throw error;
                throw asStoreError("provider control lock heartbeat 失败", "LOCK_HEARTBEAT_FAILED", error);
            }
        },
        async release(): Promise<void> {
            if (released) return;
            released = true;
            try {
                await handle.close();
                await releaseOwnedLock(paths.lockPath, token);
            } catch (error) {
                throw asStoreError("释放 provider control lock 失败", "LOCK_RELEASE_FAILED", error);
            }
        },
    };
}

interface ProviderControlLockMetadata {
    token: string;
    ownerPid: number;
    createdAtMs: number;
    heartbeatAtMs: number;
}

interface ProviderControlLockSnapshot {
    metadata: ProviderControlLockMetadata;
    identity: string;
    mtimeMs: number;
    size: number;
}

async function breakStaleLock(paths: ProviderControlPaths, staleMs: number): Promise<void> {
    const observed = await readLockSnapshot(paths.lockPath);
    if (!observed || Date.now() - observed.mtimeMs < staleMs) return;
    if (isProcessAlive(observed.metadata.ownerPid)) return;
    await lockTestHook?.({ phase: "stale-observed", lockPath: paths.lockPath });
    const confirmed = await readLockSnapshot(paths.lockPath);
    if (!confirmed || !sameLockSnapshot(observed, confirmed) || Date.now() - confirmed.mtimeMs < staleMs) return;
    if (isProcessAlive(confirmed.metadata.ownerPid)) return;
    const claimDirectory = `${paths.lockPath}.stale-claim-${crypto.createHash("sha256").update(crypto.randomUUID()).digest("hex").slice(0, 16)}`;
    try {
        await fs.promises.mkdir(claimDirectory);
    } catch (error) {
        if (isErrno(error, "EEXIST")) return;
        throw asStoreError("创建 provider control stale lock claim 失败", "LOCK_STALE_CLAIM_FAILED", error);
    }
    const quarantinePath = path.join(claimDirectory, "quarantined.lock");
    try {
        await lockTestHook?.({ phase: "stale-claim-acquired", lockPath: paths.lockPath });
        const beforeRename = await readLockSnapshot(paths.lockPath);
        if (!beforeRename || !sameLockSnapshot(confirmed, beforeRename) || Date.now() - beforeRename.mtimeMs < staleMs) return;
        if (isProcessAlive(beforeRename.metadata.ownerPid)) return;
        await lockTestHook?.({ phase: "before-stale-rename", lockPath: paths.lockPath });
        const renameBarrier = await readLockSnapshot(paths.lockPath);
        if (!renameBarrier || !sameLockSnapshot(beforeRename, renameBarrier) || isProcessAlive(renameBarrier.metadata.ownerPid)) return;
        let quarantinedByRename = false;
        for (let attempt = 0; attempt < LOCK_SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
            try {
                await fs.promises.rename(paths.lockPath, quarantinePath);
                quarantinedByRename = true;
                break;
            } catch (error) {
                if (!isLockPathMutationRace(error)) throw error;
                const quarantinedRace = await readLockSnapshot(quarantinePath);
                const raced = await readLockSnapshot(paths.lockPath);
                if (quarantinedRace && sameLockSnapshot(renameBarrier, quarantinedRace)) {
                    quarantinedByRename = true;
                    break;
                }
                if (!raced || !sameLockSnapshot(renameBarrier, raced) || isProcessAlive(raced.metadata.ownerPid) || quarantinedRace) return;
                await sleep(lockSnapshotBackoffMs(attempt));
            }
        }
        if (!quarantinedByRename) return;
        await lockTestHook?.({ phase: "stale-quarantined", lockPath: paths.lockPath });
        const quarantined = await readLockSnapshot(quarantinePath);
        const replacement = await readLockSnapshot(paths.lockPath);
        if (replacement && replacement.metadata.token !== quarantined?.metadata.token) {
            await preserveQuarantinedEvidence(quarantinePath, paths.lockPath);
            return;
        }
        if (!quarantined || !sameLockSnapshot(renameBarrier, quarantined) || isProcessAlive(quarantined.metadata.ownerPid)) {
            await restoreQuarantinedLock(quarantinePath, paths.lockPath);
            return;
        }
        await unlinkWithRaceCheck(quarantinePath, quarantined.metadata.token);
    } catch (error) {
        if (error instanceof ProviderControlStoreError) throw error;
        throw asStoreError("原子隔离 stale provider control lock 失败", "LOCK_STALE_QUARANTINE_FAILED", error);
    } finally {
        await fs.promises.rmdir(claimDirectory).catch(() => undefined);
    }
}

async function releaseOwnedLock(lockPath: string, token: string): Promise<void> {
    for (let attempt = 0; attempt < LOCK_RELEASE_MAX_ATTEMPTS; attempt += 1) {
        const snapshot = await readLockSnapshot(lockPath);
        if (!snapshot) return;
        if (snapshot.metadata.token !== token) return;
        await lockTestHook?.({ phase: "before-release-unlink", lockPath });
        const confirmed = await readLockSnapshot(lockPath);
        if (!confirmed) return;
        if (confirmed.metadata.token !== token) return;
        if (!sameLockSnapshot(snapshot, confirmed)) {
            await sleep(lockSnapshotBackoffMs(attempt));
            continue;
        }
        try {
            await fs.promises.unlink(lockPath);
            return;
        } catch (error) {
            if (!isLockPathMutationRace(error)) throw error;
            const raced = await readLockSnapshot(lockPath);
            if (!raced || raced.metadata.token !== token) return;
            await sleep(lockSnapshotBackoffMs(attempt));
        }
    }
    const remaining = await readLockSnapshot(lockPath);
    if (remaining?.metadata.token === token) {
        throw new ProviderControlStoreError(`provider control lock 在有界重试后仍无法安全释放：${lockPath}`, "LOCK_RELEASE_RACE");
    }
}

async function unlinkWithRaceCheck(lockPath: string, token: string): Promise<void> {
    for (let attempt = 0; attempt < LOCK_SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
        const snapshot = await readLockSnapshot(lockPath);
        if (!snapshot || snapshot.metadata.token !== token) return;
        try {
            await fs.promises.unlink(lockPath);
            return;
        } catch (error) {
            if (!isLockPathMutationRace(error)) throw error;
            const raced = await readLockSnapshot(lockPath);
            if (!raced || raced.metadata.token !== token) return;
            await sleep(lockSnapshotBackoffMs(attempt));
        }
    }
}

async function preserveQuarantinedEvidence(quarantinePath: string, lockPath: string): Promise<void> {
    const evidencePath = `${lockPath}.stale-evidence-${crypto.randomUUID()}`;
    try {
        await fs.promises.rename(quarantinePath, evidencePath);
    } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
    }
}

async function readLockSnapshot(lockPath: string): Promise<ProviderControlLockSnapshot | null> {
    let metadataError: ProviderControlStoreError | undefined;
    for (let attempt = 0; attempt < LOCK_SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
        let result: ProviderControlLockSnapshotAttempt;
        try {
            result = await readLockSnapshotAttempt(lockPath);
        } catch (error) {
            if (error instanceof ProviderControlStoreError) throw error;
            throw asStoreError("读取 provider control lock 快照失败", "LOCK_STALE_READ_FAILED", error);
        }
        if (result.kind === "snapshot") return result.snapshot;
        metadataError = result.kind === "invalid" ? result.error : undefined;
        if (attempt + 1 < LOCK_SNAPSHOT_MAX_ATTEMPTS) await sleep(lockSnapshotBackoffMs(attempt));
    }
    if (metadataError) throw metadataError;
    return null;
}

type ProviderControlLockSnapshotAttempt =
    | { kind: "snapshot"; snapshot: ProviderControlLockSnapshot }
    | { kind: "absent" | "changed" }
    | { kind: "invalid"; error: ProviderControlStoreError };

async function readLockSnapshotAttempt(lockPath: string): Promise<ProviderControlLockSnapshotAttempt> {
    let beforeOpen: fs.Stats;
    try {
        beforeOpen = await fs.promises.lstat(lockPath);
    } catch (error) {
        if (isErrno(error, "ENOENT")) return { kind: "absent" };
        if (isTransientWindowsLockRace(error)) return { kind: "changed" };
        throw error;
    }
    assertSafeLockObject(beforeOpen, lockPath);
    await lockTestHook?.({ phase: "snapshot-before-open", lockPath });

    let handle: fs.promises.FileHandle | undefined;
    try {
        try {
            handle = await openTransientLockNoFollow(lockPath);
        } catch (error) {
            if (isErrno(error, "ENOENT")) return { kind: "changed" };
            if (isTransientWindowsLockRace(error)) return { kind: "changed" };
            throw error;
        }
        const handleBeforeRead = await handle.stat();
        if (!handleBeforeRead.isFile()) throw new ProviderControlPathSafetyError(`provider control lock handle 不是普通文件：${lockPath}`);
        const afterOpen = await lstatTransientLock(lockPath);
        if (!afterOpen) return { kind: "changed" };
        assertSafeLockObject(afterOpen, lockPath);
        if (!sameObject(beforeOpen, handleBeforeRead) || !sameObject(handleBeforeRead, afterOpen)) return { kind: "changed" };

        const content = await handle.readFile("utf8");
        const handleAfterRead = await handle.stat();
        if (!handleAfterRead.isFile()) throw new ProviderControlPathSafetyError(`provider control lock handle 不是普通文件：${lockPath}`);
        const afterRead = await lstatTransientLock(lockPath);
        if (!afterRead) return { kind: "changed" };
        assertSafeLockObject(afterRead, lockPath);
        if (!sameObject(handleBeforeRead, handleAfterRead)
            || !sameObject(handleAfterRead, afterRead)
            || fileIdentity(handleBeforeRead) !== fileIdentity(handleAfterRead)
            || fileIdentity(handleAfterRead) !== fileIdentity(afterRead)) {
            return { kind: "changed" };
        }

        let metadata: unknown;
        try {
            metadata = JSON.parse(content);
        } catch {
            return {
                kind: "invalid",
                error: new ProviderControlStoreError(`provider control lock 元数据半写或损坏：${lockPath}`, "LOCK_METADATA_INVALID"),
            };
        }
        if (!isLockMetadata(metadata)) {
            return {
                kind: "invalid",
                error: new ProviderControlStoreError(`provider control lock 元数据非法：${lockPath}`, "LOCK_METADATA_INVALID"),
            };
        }
        return {
            kind: "snapshot",
            snapshot: {
                metadata,
                identity: fileIdentity(handleAfterRead),
                mtimeMs: handleAfterRead.mtimeMs,
                size: handleAfterRead.size,
            },
        };
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

async function openTransientLockNoFollow(lockPath: string): Promise<fs.promises.FileHandle> {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    try {
        return await fs.promises.open(lockPath, fs.constants.O_RDONLY | noFollow);
    } catch (error) {
        if (isNoFollowLinkError(error)) throw new ProviderControlPathSafetyError(`provider control lock 拒绝 symlink/junction：${lockPath}`);
        if (process.platform !== "win32" || !isErrno(error, "EINVAL")) throw error;
        return fs.promises.open(lockPath, fs.constants.O_RDONLY);
    }
}

async function lstatTransientLock(lockPath: string): Promise<fs.Stats | null> {
    try {
        return await fs.promises.lstat(lockPath);
    } catch (error) {
        if (isErrno(error, "ENOENT")) return null;
        if (isTransientWindowsLockRace(error)) return null;
        throw error;
    }
}

function assertSafeLockObject(stat: fs.Stats, lockPath: string): void {
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new ProviderControlPathSafetyError(`provider control lock 不是安全普通文件：${lockPath}`);
    }
}

function sameObject(left: fs.Stats, right: fs.Stats): boolean {
    return objectIdentity(left) === objectIdentity(right);
}

function lockSnapshotBackoffMs(attempt: number): number {
    return Math.min(attempt + 1, LOCK_SNAPSHOT_MAX_BACKOFF_MS);
}

function isNoFollowLinkError(error: unknown): boolean {
    return isErrno(error, "ELOOP") || isErrno(error, "EMLINK");
}

function isLockPathMutationRace(error: unknown): boolean {
    return isErrno(error, "ENOENT") || isErrno(error, "EEXIST") || isTransientWindowsLockRace(error);
}

function isTransientWindowsLockRace(error: unknown): boolean {
    return process.platform === "win32" && (isErrno(error, "EPERM") || isErrno(error, "EACCES") || isErrno(error, "EBUSY"));
}

function sameLockSnapshot(left: ProviderControlLockSnapshot, right: ProviderControlLockSnapshot): boolean {
    return left.metadata.token === right.metadata.token && left.identity === right.identity && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

async function restoreQuarantinedLock(quarantinePath: string, lockPath: string): Promise<void> {
    try {
        await fs.promises.link(quarantinePath, lockPath);
        await fs.promises.unlink(quarantinePath);
    } catch (error) {
        if (isErrno(error, "EEXIST")) {
            await preserveQuarantinedEvidence(quarantinePath, lockPath);
            return;
        }
        throw asStoreError("恢复被错误隔离的 provider control lock 失败", "LOCK_STALE_RESTORE_FAILED", error);
    }
}

interface SafeLayoutSnapshot {
    rootIdentity: string;
    rootRealPath: string;
    manifestParentIdentity: string | null;
}

async function assertSafeLayout(paths: ProviderControlPaths, expected?: SafeLayoutSnapshot): Promise<SafeLayoutSnapshot> {
    await fs.promises.mkdir(paths.dataRoot, { recursive: true });
    const root = await fs.promises.lstat(paths.dataRoot);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new ProviderControlPathSafetyError(`DATA_ROOT 不是安全真实目录：${paths.dataRoot}`);
    const realRoot = await fs.promises.realpath(paths.dataRoot);
    if (!samePath(realRoot, paths.dataRoot)) throw new ProviderControlPathSafetyError(`DATA_ROOT realpath 不一致，拒绝 symlink/junction：${paths.dataRoot}`);
    let manifestParentIdentity: string | null = null;
    try {
        const manifestParent = await fs.promises.lstat(paths.installManifestDirectory);
        if (!manifestParent.isDirectory() || manifestParent.isSymbolicLink()) throw new ProviderControlPathSafetyError(`install manifest parent 不是安全真实目录：${paths.installManifestDirectory}`);
        const realManifestParent = await fs.promises.realpath(paths.installManifestDirectory);
        if (!samePath(realManifestParent, paths.installManifestDirectory)) throw new ProviderControlPathSafetyError(`install manifest parent realpath 不一致：${paths.installManifestDirectory}`);
        manifestParentIdentity = objectIdentity(manifestParent);
    } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
    }
    for (const candidate of [paths.controlPath, paths.initializationMarkerPath, paths.installManifestPath, paths.lockPath]) {
        try {
            const stat = await fs.promises.lstat(candidate);
            if (stat.isSymbolicLink() || !stat.isFile()) throw new ProviderControlPathSafetyError(`provider control 目标不是安全普通文件：${candidate}`);
        } catch (error) {
            if (!isErrno(error, "ENOENT")) throw error;
        }
    }
    const snapshot = { rootIdentity: objectIdentity(root), rootRealPath: realRoot, manifestParentIdentity };
    if (expected && (snapshot.rootIdentity !== expected.rootIdentity
        || !samePath(snapshot.rootRealPath, expected.rootRealPath)
        || expected.manifestParentIdentity !== null && snapshot.manifestParentIdentity !== expected.manifestParentIdentity)) {
        throw new ProviderControlPathSafetyError("provider control parent/root identity 在操作期间发生变化");
    }
    return snapshot;
}

async function ensureSafeTargetParent(paths: ProviderControlPaths, targetPath: string): Promise<void> {
    const rootSnapshot = await assertSafeLayout(paths);
    const parent = path.dirname(targetPath);
    if (samePath(parent, paths.installManifestDirectory)) {
        await fs.promises.mkdir(parent);
    } else if (!samePath(parent, paths.dataRoot)) {
        throw new ProviderControlPathSafetyError(`provider control target parent 越界：${parent}`);
    }
    const parentStat = await fs.promises.lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new ProviderControlPathSafetyError(`target parent 不是安全真实目录：${parent}`);
    const realParent = await fs.promises.realpath(parent);
    if (!samePath(realParent, parent)) throw new ProviderControlPathSafetyError(`target parent realpath 不一致：${parent}`);
    await assertSafeLayout(paths, rootSnapshot);
}

async function openNoFollow(filePath: string, flags: number): Promise<fs.promises.FileHandle> {
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    let handle: fs.promises.FileHandle;
    try {
        handle = await fs.promises.open(filePath, flags | noFollow);
    } catch (error) {
        if (process.platform !== "win32" || !isErrno(error, "EINVAL")) throw error;
        handle = await fs.promises.open(filePath, flags);
    }
    try {
        const handleStat = await handle.stat();
        const pathStat = await fs.promises.lstat(filePath);
        if (pathStat.isSymbolicLink() || !pathStat.isFile() || fileIdentity(handleStat) !== fileIdentity(pathStat)) {
            throw new ProviderControlPathSafetyError(`no-follow 打开后对象身份不一致：${filePath}`);
        }
        return handle;
    } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
    }
}

async function readUtf8NoFollow(filePath: string): Promise<string> {
    const handle = await openNoFollow(filePath, fs.constants.O_RDONLY);
    try {
        return await handle.readFile("utf8");
    } finally {
        await handle.close();
    }
}

async function statNoFollow(filePath: string): Promise<fs.Stats> {
    const handle = await openNoFollow(filePath, fs.constants.O_RDONLY);
    try {
        return await handle.stat();
    } finally {
        await handle.close();
    }
}

function repairRead(paths: ProviderControlPaths, reason: ProviderControlRepairReason, detail: string): ProviderControlRepairRead {
    return {
        kind: "repair-required",
        paths,
        repair: { kind: "repair-required", dispatchBlocked: true, repairRequired: true, reason, detail },
    };
}

async function requireCurrent(paths: ProviderControlPaths): Promise<ProviderControlCurrentRead> {
    const current = await readProviderControlStoreAt(paths);
    if (current.kind !== "current") throw new ProviderControlRepairRequiredError(current.repair);
    return current;
}

function assertExpectedRevision(state: ProviderControlState, expectedRevision: number | undefined): void {
    if (expectedRevision !== undefined && state.controlRevision !== expectedRevision) {
        throw new ProviderControlConflictError(expectedRevision, state.controlRevision);
    }
}

function assertCurrentOwnerIdentity(state: ProviderControlState, fence: ProviderControlOwnerFence): void {
    if (state.ownerEpoch !== fence.ownerEpoch || state.ownerLease?.leaseId !== fence.ownerLeaseId) {
        throw new ProviderControlFencedError(`provider control owner fence 已失效：epoch=${fence.ownerEpoch}`);
    }
}

function assertCurrentOwnerFence(state: ProviderControlState, fence: ProviderControlOwnerFence, nowMs: number): void {
    assertCurrentOwnerIdentity(state, fence);
    if (!state.ownerLease || nowMs >= state.ownerLease.expiresAtMs) {
        throw new ProviderControlFencedError(`provider control owner lease 已过期：epoch=${fence.ownerEpoch}`);
    }
}

function resolveMutationNow(current: ProviderControlState, next: ProviderControlState, explicitNowMs: number | undefined): number {
    if (explicitNowMs !== undefined) {
        assertSafeTime(explicitNowMs, "owner mutation nowMs");
        return explicitNowMs;
    }
    const candidate = Math.max(current.lastObservedWallClockMs, next.lastObservedWallClockMs);
    return current.createdAtMs < SYNTHETIC_CLOCK_CUTOFF_MS ? candidate : Math.max(candidate, Date.now());
}

function prepareNextRevision(current: ProviderControlState, next: ProviderControlState, nowMs: number): void {
    assertSafeTime(nowMs, "mutation nowMs");
    next.controlRevision = current.controlRevision + 1;
    next.updatedAtMs = Math.max(current.updatedAtMs, nowMs);
    next.publicationId = crypto.randomUUID();
    normalizeProviderControlState(next);
}

function normalizeProviderControlState(state: ProviderControlState): void {
    for (const provider of PROVIDER_IDS) {
        const pool = state.pools[provider];
        if (pool.breaker.openUntilMs !== null && pool.breaker.openUntilMs < state.lastObservedWallClockMs) {
            pool.breaker.openUntilMs = state.lastObservedWallClockMs;
        }
        if (pool.timeFrozen.freezeEvidence === undefined) pool.timeFrozen.freezeEvidence = null;
        if (pool.timeFrozen.frozen) {
            const evidence = pool.timeFrozen.freezeEvidence;
            if (!evidence || evidence.provider !== provider || evidence.reason !== pool.timeFrozen.reason) {
                pool.timeFrozen.freezeEvidence = createFreezeEvidence(state, provider);
            }
        } else {
            pool.timeFrozen.freezeEvidence = null;
        }
        if (pool.lastManualRecovery === undefined) pool.lastManualRecovery = null;
    }
    const agyLeases = [...state.pools.agy.activeLeases, ...state.pools.agy.uncertainLeases];
    state.agy.admission.firstRunOverflowLeaseIds = agyLeases
        .filter(lease => lease.trafficClass === "agy-first-run-overflow")
        .map(lease => lease.leaseId);
    state.agy.admission.fallbackLeaseIds = agyLeases
        .filter(lease => lease.trafficClass === "agy-fallback")
        .map(lease => lease.leaseId);
    state.agy.admission.firstRunOverflowBorrowedSlots = Math.max(0, state.agy.admission.firstRunOverflowLeaseIds.length - state.agy.admission.firstRunOverflowGuarantee);
    state.agy.admission.fallbackBorrowedSlots = Math.max(0, state.agy.admission.fallbackLeaseIds.length - state.agy.admission.fallbackGuarantee);
}

function createFreezeEvidence(state: ProviderControlState, provider: ProviderId): ProviderFreezeEvidence {
    const pool = state.pools[provider];
    if (!pool.timeFrozen.reason || pool.timeFrozen.enteredAtMs === null) throw new ProviderControlStoreError("冻结状态缺少 reason/enteredAtMs", "FREEZE_EVIDENCE_INVALID");
    const withoutHash = {
        evidenceId: crypto.randomUUID(),
        provider,
        reason: pool.timeFrozen.reason,
        ownerEpoch: state.ownerEpoch,
        controlRevision: state.controlRevision,
        capacityGeneration: pool.capacityGeneration,
        observedAtMs: pool.timeFrozen.enteredAtMs,
        previousLastObservedWallClockMs: state.lastObservedWallClockMs,
        activeLeaseIds: pool.activeLeases.map(lease => lease.leaseId).sort(),
        uncertainLeaseIds: pool.uncertainLeases.map(lease => lease.leaseId).sort(),
    };
    return { ...withoutHash, evidenceHash: sha256(stableJsonStringify(withoutHash)) };
}

function protectedRuntimeHash(state: ProviderControlState): string {
    return sha256(stableJsonStringify({
        installation: state.installation,
        ownerEpoch: state.ownerEpoch,
        ownerLease: state.ownerLease,
        lastObservedWallClockMs: state.lastObservedWallClockMs,
        pools: state.pools,
        agy: state.agy,
    }));
}

function createCompatibilityRecoveryEvidence(state: ProviderControlState, provider: ProviderId, nowMs: number): ProviderManualRecoveryEvidence {
    const freezeEvidence = state.pools[provider].timeFrozen.freezeEvidence;
    if (!freezeEvidence || !state.ownerLease) throw new ProviderControlFencedError("兼容人工恢复缺少 freeze/owner identity");
    return {
        freezeEvidenceId: freezeEvidence.evidenceId,
        freezeEvidenceHash: freezeEvidence.evidenceHash,
        acknowledgedBy: state.ownerLease.ownerId,
        acknowledgedAtMs: nowMs,
        correctedNowMs: nowMs,
    };
}

function assertManualRecoveryEvidence(evidence: ProviderManualRecoveryEvidence): void {
    assertNonEmpty(evidence.freezeEvidenceId, "recovery.freezeEvidenceId");
    if (!/^[a-f0-9]{64}$/u.test(evidence.freezeEvidenceHash)) throw new ProviderControlStoreError("recovery.freezeEvidenceHash 非法", "RECOVERY_EVIDENCE_INVALID");
    assertNonEmpty(evidence.acknowledgedBy, "recovery.acknowledgedBy");
    assertSafeTime(evidence.acknowledgedAtMs, "recovery.acknowledgedAtMs");
    assertSafeTime(evidence.correctedNowMs, "recovery.correctedNowMs");
}

function createInstallManifest(installation: ProviderControlInstallationIdentity, createdAtMs: number): ProviderControlInstallManifest {
    const manifest: ProviderControlInstallManifest = {
        schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
        kind: "record-provider-control-install-manifest",
        ...installation,
        createdAtMs,
        manifestHash: "",
    };
    manifest.manifestHash = calculateInstallManifestHash(manifest);
    return manifest;
}

function calculateInstallManifestHash(manifest: ProviderControlInstallManifest): string {
    const payload = { ...manifest, manifestHash: undefined } as Record<string, unknown>;
    delete payload.manifestHash;
    return sha256(stableJsonStringify(payload));
}

function sha256(value: string): string {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJsonStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`).join(",")}}`;
}

async function renameWithRetry(sourcePath: string, targetPath: string, paths: ProviderControlPaths): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            await pathSafetyTestHook?.({
                phase: "before-publish-rename-attempt",
                paths,
                renameAttempt: attempt + 1,
                sourcePath,
                targetPath,
            });
            await fs.promises.rename(sourcePath, targetPath);
            return;
        } catch (error) {
            lastError = error;
            if (!isErrno(error, "EPERM") && !isErrno(error, "EBUSY")) throw error;
            await sleep(15 * (attempt + 1));
        }
    }
    throw lastError;
}

function positiveMs(value: number | undefined, fallback: number, name: string): number {
    const normalized = value ?? fallback;
    if (!Number.isSafeInteger(normalized) || normalized <= 0) throw new ProviderControlStoreError(`${name} 必须为正毫秒数`, "INVALID_LOCK_OPTIONS");
    return normalized;
}

function assertDuration(value: unknown, name: string, maximum: number): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new ProviderControlStoreError(`${name} 必须在 1..${maximum}`, "INVALID_DURATION");
}

function assertSafeTime(value: unknown, name: string): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new ProviderControlStoreError(`${name} 必须为有限非负毫秒时间`, "INVALID_TIME");
}

function assertPositiveInteger(value: unknown, name: string): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new ProviderControlStoreError(`${name} 必须为正安全整数`, "INVALID_INTEGER");
}

function assertNonEmpty(value: unknown, name: string): asserts value is string {
    if (typeof value !== "string" || !value) throw new ProviderControlStoreError(`${name} 必须为非空字符串`, "INVALID_STRING");
}

function assertProviderId(value: unknown, name: string): asserts value is ProviderId {
    if (typeof value !== "string" || !PROVIDER_IDS.includes(value as ProviderId)) {
        throw new ProviderControlStoreError(`${name} 必须是受支持的 provider`, "INVALID_PROVIDER");
    }
}

function assertProviderLeaseIdentity(value: unknown): asserts value is ProviderLeaseIdentity {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ProviderControlStoreError("recovered lease identity 非法", "INVALID_LEASE_IDENTITY");
    }
    const identity = value as ProviderLeaseIdentity;
    assertProviderId(identity.provider, "identity.provider");
    assertNonEmpty(identity.trafficClass, "identity.trafficClass");
    assertNonEmpty(identity.attemptId, "identity.attemptId");
    assertNonEmpty(identity.leaseId, "identity.leaseId");
    assertPositiveInteger(identity.ownerEpoch, "identity.ownerEpoch");
    assertPositiveInteger(identity.capacityGeneration, "identity.capacityGeneration");
    assertSafeTime(identity.acquiredAt, "identity.acquiredAt");
    assertSafeTime(identity.expiresAt, "identity.expiresAt");
    if (identity.expiresAt < identity.acquiredAt) {
        throw new ProviderControlStoreError("identity.expiresAt 不能早于 acquiredAt", "INVALID_LEASE_IDENTITY");
    }
}

function pruneExpiredProviderLeases(
    state: ProviderControlState,
    provider: ProviderId | undefined,
    nowMs: number,
): ProviderLeaseReclaimResult {
    const result: ProviderLeaseReclaimResult = { activeLeaseIds: [], uncertainLeaseIds: [] };
    const providers = provider === undefined ? PROVIDER_IDS : [provider];
    for (const currentProvider of providers) {
        const pool = state.pools[currentProvider];
        const expiredActive = pool.activeLeases.filter(lease => lease.expiresAtMs <= nowMs);
        const expiredUncertain = pool.uncertainLeases.filter(lease => lease.graceExpiresAtMs <= nowMs);
        if (expiredActive.length === 0 && expiredUncertain.length === 0) continue;
        const expiredIds = new Set([...expiredActive, ...expiredUncertain].map(lease => lease.leaseId));
        pool.activeLeases = pool.activeLeases.filter(lease => !expiredIds.has(lease.leaseId));
        pool.uncertainLeases = pool.uncertainLeases.filter(lease => !expiredIds.has(lease.leaseId));
        if (pool.breaker.probeLease !== null && expiredIds.has(pool.breaker.probeLease.leaseId)) {
            pool.breaker.probeLease = null;
        }
        result.activeLeaseIds.push(...expiredActive.map(lease => lease.leaseId));
        result.uncertainLeaseIds.push(...expiredUncertain.map(lease => lease.leaseId));
        if (currentProvider === "agy") rebuildAgyAdmissionLeaseIndexes(state);
    }
    return result;
}

function rebuildAgyAdmissionLeaseIndexes(state: ProviderControlState): void {
    state.agy.admission.firstRunOverflowLeaseIds = state.pools.agy.activeLeases
        .filter(lease => lease.trafficClass === "agy-first-run-overflow")
        .map(lease => lease.leaseId);
    state.agy.admission.fallbackLeaseIds = state.pools.agy.activeLeases
        .filter(lease => lease.trafficClass === "agy-fallback")
        .map(lease => lease.leaseId);
}

function isLockMetadata(value: unknown): value is ProviderControlLockMetadata {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).sort().join("|") === "createdAtMs|heartbeatAtMs|ownerPid|token"
        && typeof record.token === "string" && !!record.token
        && Number.isSafeInteger(record.ownerPid) && (record.ownerPid as number) > 0
        && Number.isSafeInteger(record.createdAtMs) && (record.createdAtMs as number) >= 0
        && Number.isSafeInteger(record.heartbeatAtMs) && (record.heartbeatAtMs as number) >= 0;
}

function isProcessAlive(pid: number): boolean {
    if (pid === process.pid) return true;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !isErrno(error, "ESRCH");
    }
}

function fileIdentity(stat: fs.Stats): string {
    return `${stat.dev}:${stat.ino}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

function objectIdentity(stat: fs.Stats): string {
    return `${stat.dev}:${stat.ino}`;
}

function samePath(left: string, right: string): boolean {
    const normalize = (value: string) => path.resolve(value).replace(/\\\\\?\\/u, "").replace(/\\/gu, "/").toLowerCase();
    return normalize(left) === normalize(right);
}

function isErrno(error: unknown, code: string): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function asStoreError(message: string, code: string, cause: unknown): ProviderControlStoreError {
    const suffix = cause instanceof Error ? `：${cause.message}` : "";
    return new ProviderControlStoreError(`${message}${suffix}`, code);
}
