import crypto from "node:crypto";

export const PROVIDER_CONTROL_SCHEMA_VERSION = 2 as const;
export const PROVIDER_CONTROL_KIND = "record-provider-control" as const;
export const PROVIDER_CONTROL_FILE_NAME = "record-provider-control.json" as const;
export const PROVIDER_CONTROL_INITIALIZATION_FILE_NAME = "record-provider-control.initialized" as const;
export const PROVIDER_CONTROL_INSTALL_MANIFEST_DIRECTORY = "provider-control-install" as const;
export const PROVIDER_CONTROL_INSTALL_MANIFEST_FILE_NAME = "manifest.json" as const;
export const PROVIDER_CONTROL_PHYSICAL_MAX = 8 as const;
export const PROVIDER_CONTROL_INITIAL_LIMIT = 2 as const;
export const AGY_FIRST_RUN_OVERFLOW_GUARANTEE = 4 as const;
export const AGY_FALLBACK_GUARANTEE = 4 as const;
export const MAX_BREAKER_OPEN_MS = 30 * 60_000;
export const MAX_RETRY_AFTER_MS = MAX_BREAKER_OPEN_MS;

export const PROVIDER_IDS = ["grok", "agy"] as const;
export type ProviderId = typeof PROVIDER_IDS[number];

export const PROVIDER_TRAFFIC_CLASSES = ["foreground", "record", "agy-first-run-overflow", "agy-fallback"] as const;
export type ProviderTrafficClass = typeof PROVIDER_TRAFFIC_CLASSES[number];

export type TimeFrozenReason = "capacity" | "clock_non_monotonic";

export interface ProviderLease {
    leaseId: string;
    attemptId: string;
    provider: ProviderId;
    trafficClass: ProviderTrafficClass;
    ownerEpoch: number;
    capacityGeneration: number;
    acquiredAtMs: number;
    expiresAtMs: number;
}

export interface ProviderLeaseIdentity {
    provider: ProviderId;
    trafficClass: ProviderTrafficClass;
    attemptId: string;
    leaseId: string;
    ownerEpoch: number;
    capacityGeneration: number;
    acquiredAt: number;
    expiresAt: number;
}

export function providerLeaseIdentity(lease: ProviderLease): ProviderLeaseIdentity {
    return {
        provider: lease.provider,
        trafficClass: lease.trafficClass,
        attemptId: lease.attemptId,
        leaseId: lease.leaseId,
        ownerEpoch: lease.ownerEpoch,
        capacityGeneration: lease.capacityGeneration,
        acquiredAt: lease.acquiredAtMs,
        expiresAt: lease.expiresAtMs,
    };
}

export function matchesProviderLeaseIdentity(lease: ProviderLease, identity: ProviderLeaseIdentity): boolean {
    return lease.provider === identity.provider
        && lease.trafficClass === identity.trafficClass
        && lease.attemptId === identity.attemptId
        && lease.leaseId === identity.leaseId
        && lease.ownerEpoch === identity.ownerEpoch
        && lease.capacityGeneration === identity.capacityGeneration
        && lease.acquiredAtMs === identity.acquiredAt
        && lease.expiresAtMs === identity.expiresAt;
}

export interface ProviderUncertainLease extends ProviderLease {
    unknownOutcomeAtMs: number;
    graceExpiresAtMs: number;
}

export interface ProviderProbeLease {
    leaseId: string;
    attemptId: string;
    ownerEpoch: number;
    capacityGeneration: number;
    acquiredAtMs: number;
    expiresAtMs: number;
}

export interface ProviderBreakerState {
    openUntilMs: number | null;
    retryAfterMs: number | null;
    failureBudget: number;
    consecutiveFailures: number;
    backoffExponent: number;
    probeLease: ProviderProbeLease | null;
}

export interface ProviderLossEpoch {
    lossEpoch: number;
    lostCapacityGeneration: number;
    attemptId: string;
    recordedAtMs: number;
}

export interface ProviderTimeFrozenState {
    frozen: boolean;
    reason: TimeFrozenReason | null;
    enteredAtMs: number | null;
    requiresManualClear: boolean;
    frozenFailureAttemptIds: string[];
    freezeEvidence?: ProviderFreezeEvidence | null;
}

export interface ProviderFreezeEvidence {
    evidenceId: string;
    evidenceHash: string;
    provider: ProviderId;
    reason: TimeFrozenReason;
    ownerEpoch: number;
    controlRevision: number;
    capacityGeneration: number;
    observedAtMs: number;
    previousLastObservedWallClockMs: number;
    activeLeaseIds: string[];
    uncertainLeaseIds: string[];
}

export interface ProviderManualRecoveryEvidence {
    freezeEvidenceId: string;
    freezeEvidenceHash: string;
    acknowledgedBy: string;
    acknowledgedAtMs: number;
    correctedNowMs: number;
}

export interface ProviderManualRecoveryRecord extends ProviderManualRecoveryEvidence {
    recoveredOwnerEpoch: number;
    recoveredControlRevision: number;
}

export interface ProviderPoolState {
    physicalMax: number;
    currentLimit: number;
    capacityGeneration: number;
    lossEpoch: number;
    lastLoss: ProviderLossEpoch | null;
    successCredits: number;
    activeLeases: ProviderLease[];
    uncertainLeases: ProviderUncertainLease[];
    breaker: ProviderBreakerState;
    timeFrozen: ProviderTimeFrozenState;
    lastManualRecovery: ProviderManualRecoveryRecord | null;
}

export interface AgyMemoryAimdState {
    memoryAimdLimit: number;
    recoveryCredits: number;
    lastPressureAtMs: number | null;
    highWaterSamples: number;
    lowWaterSamples: number;
}

export interface AgyAdmissionState {
    firstRunOverflowGuarantee: number;
    fallbackGuarantee: number;
    firstRunOverflowLeaseIds: string[];
    fallbackLeaseIds: string[];
    firstRunOverflowBorrowedSlots: number;
    fallbackBorrowedSlots: number;
}

export interface ProviderOwnerLease {
    ownerId: string;
    leaseId: string;
    acquiredAtMs: number;
    expiresAtMs: number;
}

export interface ProviderControlInstallationIdentity {
    initializationId: string;
    bootstrapIdentityHash: string;
    bootstrapTokenHash: string;
    initialPublicationId: string;
}

export interface ProviderControlState {
    schemaVersion: typeof PROVIDER_CONTROL_SCHEMA_VERSION;
    kind: typeof PROVIDER_CONTROL_KIND;
    initialized: true;
    installation: ProviderControlInstallationIdentity;
    controlRevision: number;
    ownerEpoch: number;
    ownerLease: ProviderOwnerLease | null;
    createdAtMs: number;
    updatedAtMs: number;
    lastObservedWallClockMs: number;
    dispatchBlocked: false;
    repairRequired: false;
    publicationId: string;
    persistedHash: string;
    pools: Record<ProviderId, ProviderPoolState>;
    agy: {
        memory: AgyMemoryAimdState;
        admission: AgyAdmissionState;
    };
}

export type ProviderControlRepairReason = "first_install_required"
    | "control_file_missing"
    | "control_file_corrupt"
    | "control_file_unsafe"
    | "unknown_schema"
    | "legacy_schema"
    | "initialization_marker_missing"
    | "initialization_marker_corrupt"
    | "install_manifest_missing"
    | "install_manifest_corrupt"
    | "install_identity_mismatch"
    | "initialization_interrupted";

export interface ProviderControlRepairState {
    kind: "repair-required";
    dispatchBlocked: true;
    repairRequired: true;
    reason: ProviderControlRepairReason;
    detail: string;
}

export interface ProviderControlDurabilityProfile {
    scope: "process-crash-and-hot-restart";
    suddenPowerLossGuaranteed: false;
    directoryDurability: "not-claimed-on-windows" | "best-effort";
    pathRaceProtection: "root-and-parent-identity-rechecked";
    openAtProtection: "unavailable-in-node-path-api";
    wholeDataRootErasureDetectable: false;
}

export const PROVIDER_CONTROL_WINDOWS_DURABILITY_PROFILE: ProviderControlDurabilityProfile = {
    scope: "process-crash-and-hot-restart",
    suddenPowerLossGuaranteed: false,
    directoryDurability: "not-claimed-on-windows",
    pathRaceProtection: "root-and-parent-identity-rechecked",
    openAtProtection: "unavailable-in-node-path-api",
    wholeDataRootErasureDetectable: false,
};

export class ProviderControlContractError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ProviderControlContractError";
    }
}

export function createInitialProviderControlState(
    nowMs = Date.now(),
    publicationId = globalThis.crypto.randomUUID(),
    installation?: ProviderControlInstallationIdentity,
): ProviderControlState {
    assertSafeTimestamp(nowMs, "initial nowMs");
    const initialInstallation = installation ?? {
        initializationId: crypto.randomUUID(),
        bootstrapIdentityHash: crypto.createHash("sha256").update(`bootstrap:${publicationId}`).digest("hex"),
        bootstrapTokenHash: crypto.createHash("sha256").update(`token:${publicationId}`).digest("hex"),
        initialPublicationId: publicationId,
    };
    return {
        schemaVersion: PROVIDER_CONTROL_SCHEMA_VERSION,
        kind: PROVIDER_CONTROL_KIND,
        initialized: true,
        installation: initialInstallation,
        controlRevision: 1,
        ownerEpoch: 0,
        ownerLease: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        lastObservedWallClockMs: nowMs,
        dispatchBlocked: false,
        repairRequired: false,
        publicationId,
        persistedHash: "",
        pools: {
            grok: createInitialPool(),
            agy: createInitialPool(),
        },
        agy: {
            memory: {
                memoryAimdLimit: PROVIDER_CONTROL_INITIAL_LIMIT,
                recoveryCredits: 0,
                lastPressureAtMs: null,
                highWaterSamples: 0,
                lowWaterSamples: 0,
            },
            admission: {
                firstRunOverflowGuarantee: AGY_FIRST_RUN_OVERFLOW_GUARANTEE,
                fallbackGuarantee: AGY_FALLBACK_GUARANTEE,
                firstRunOverflowLeaseIds: [],
                fallbackLeaseIds: [],
                firstRunOverflowBorrowedSlots: 0,
                fallbackBorrowedSlots: 0,
            },
        },
    };
}

export function assertProviderControlState(value: unknown): asserts value is ProviderControlState {
    const state = expectRecord(value, "provider control");
    assertExactKeys(state, [
        "schemaVersion", "kind", "initialized", "installation", "controlRevision", "ownerEpoch", "ownerLease", "createdAtMs", "updatedAtMs",
        "lastObservedWallClockMs", "dispatchBlocked", "repairRequired", "publicationId", "persistedHash", "pools", "agy",
    ], "provider control");
    if (state.schemaVersion !== PROVIDER_CONTROL_SCHEMA_VERSION) throw new ProviderControlContractError(`unknown provider control schemaVersion=${String(state.schemaVersion)}`);
    if (state.kind !== PROVIDER_CONTROL_KIND || state.initialized !== true) throw new ProviderControlContractError("provider control initialized/kind 非法");
    assertInstallationIdentity(state.installation);
    assertPositiveInteger(state.controlRevision, "controlRevision");
    assertNonNegativeInteger(state.ownerEpoch, "ownerEpoch");
    assertOwnerLease(state.ownerLease);
    assertSafeTimestamp(state.createdAtMs, "createdAtMs");
    assertSafeTimestamp(state.updatedAtMs, "updatedAtMs");
    assertSafeTimestamp(state.lastObservedWallClockMs, "lastObservedWallClockMs");
    if (state.updatedAtMs < state.createdAtMs) throw new ProviderControlContractError("updatedAtMs 不能早于 createdAtMs");
    if (state.dispatchBlocked !== false || state.repairRequired !== false) throw new ProviderControlContractError("可运行 provider control 不能携带 repair 状态");
    assertNonEmptyString(state.publicationId, "publicationId");
    assertSha256(state.persistedHash, "persistedHash", true);
    const pools = expectRecord(state.pools, "pools");
    assertExactKeys(pools, PROVIDER_IDS, "pools");
    for (const provider of PROVIDER_IDS) assertProviderPool(pools[provider], provider, state.ownerEpoch, state.ownerLease, state.lastObservedWallClockMs);
    const typedState = state as unknown as ProviderControlState;
    assertGlobalLeaseIdentity(typedState);
    assertAgyState(typedState.agy, typedState.pools.agy);
}

export function isProviderControlState(value: unknown): value is ProviderControlState {
    try {
        assertProviderControlState(value);
        return true;
    } catch {
        return false;
    }
}

export function effectiveAgyLimit(state: Pick<ProviderControlState, "pools" | "agy">): number {
    return Math.min(state.pools.agy.currentLimit, state.agy.memory.memoryAimdLimit, state.pools.agy.physicalMax);
}

function createInitialPool(): ProviderPoolState {
    return {
        physicalMax: PROVIDER_CONTROL_PHYSICAL_MAX,
        currentLimit: PROVIDER_CONTROL_INITIAL_LIMIT,
        capacityGeneration: 1,
        lossEpoch: 0,
        lastLoss: null,
        successCredits: 0,
        activeLeases: [],
        uncertainLeases: [],
        breaker: {
            openUntilMs: null,
            retryAfterMs: null,
            failureBudget: 0,
            consecutiveFailures: 0,
            backoffExponent: 0,
            probeLease: null,
        },
        timeFrozen: {
            frozen: false,
            reason: null,
            enteredAtMs: null,
            requiresManualClear: false,
            frozenFailureAttemptIds: [],
            freezeEvidence: null,
        },
        lastManualRecovery: null,
    };
}

function assertProviderPool(value: unknown, provider: ProviderId, ownerEpoch: number, ownerLease: unknown, lastObservedWallClockMs: number): asserts value is ProviderPoolState {
    const pool = expectRecord(value, `${provider} pool`);
    assertExactKeys(pool, ["physicalMax", "currentLimit", "capacityGeneration", "lossEpoch", "lastLoss", "successCredits", "activeLeases", "uncertainLeases", "breaker", "timeFrozen", "lastManualRecovery"], `${provider} pool`);
    if (pool.physicalMax !== PROVIDER_CONTROL_PHYSICAL_MAX) throw new ProviderControlContractError(`${provider}.physicalMax 必须为 ${PROVIDER_CONTROL_PHYSICAL_MAX}`);
    assertIntegerInRange(pool.currentLimit, 1, pool.physicalMax, `${provider}.currentLimit`);
    assertPositiveInteger(pool.capacityGeneration, `${provider}.capacityGeneration`);
    assertNonNegativeInteger(pool.lossEpoch, `${provider}.lossEpoch`);
    assertNonNegativeInteger(pool.successCredits, `${provider}.successCredits`);
    assertLoss(pool.lastLoss, pool.lossEpoch, pool.capacityGeneration, provider);
    assertLeaseArray(pool.activeLeases, provider, ownerEpoch, false);
    assertLeaseArray(pool.uncertainLeases, provider, ownerEpoch, true);
    const leases = [...(pool.activeLeases as ProviderLease[]), ...(pool.uncertainLeases as ProviderUncertainLease[])];
    if (leases.length > pool.physicalMax) throw new ProviderControlContractError(`${provider} active+uncertain 数量不能超过 physicalMax`);
    const localLeaseIds = new Set(leases.map(lease => lease.leaseId));
    if (localLeaseIds.size !== leases.length) throw new ProviderControlContractError(`${provider} 同一 lease 不能同时 active/uncertain`);
    const typedOwnerLease = ownerLease as ProviderOwnerLease | null;
    for (const lease of leases) {
        if (lease.ownerEpoch === ownerEpoch && (!typedOwnerLease || lease.expiresAtMs > typedOwnerLease.expiresAtMs)) {
            throw new ProviderControlContractError(`${provider} 当前 owner 的 lease 不能越过 owner expiresAtMs`);
        }
    }
    assertBreaker(pool.breaker, provider, ownerEpoch, pool.capacityGeneration, lastObservedWallClockMs);
    const typedBreaker = pool.breaker as ProviderBreakerState;
    if (typedBreaker.probeLease && typedBreaker.probeLease.ownerEpoch === ownerEpoch
        && (!typedOwnerLease || typedBreaker.probeLease.expiresAtMs > typedOwnerLease.expiresAtMs)) {
        throw new ProviderControlContractError(`${provider} probe 不能越过 owner expiresAtMs`);
    }
    assertTimeFrozen(pool.timeFrozen, provider);
    assertManualRecovery(pool.lastManualRecovery, provider);
}

function assertLoss(value: unknown, lossEpoch: number, capacityGeneration: number, provider: ProviderId): void {
    if (value === null) {
        if (lossEpoch !== 0) throw new ProviderControlContractError(`${provider}.lossEpoch 非零时必须保留 lastLoss`);
        return;
    }
    const loss = expectRecord(value, `${provider}.lastLoss`);
    assertExactKeys(loss, ["lossEpoch", "lostCapacityGeneration", "attemptId", "recordedAtMs"], `${provider}.lastLoss`);
    assertPositiveInteger(loss.lossEpoch, `${provider}.lastLoss.lossEpoch`);
    if (loss.lossEpoch !== lossEpoch) throw new ProviderControlContractError(`${provider}.lastLoss 与 lossEpoch 不一致`);
    assertPositiveInteger(loss.lostCapacityGeneration, `${provider}.lastLoss.lostCapacityGeneration`);
    if (loss.lostCapacityGeneration >= capacityGeneration) throw new ProviderControlContractError(`${provider}.lastLoss generation 必须早于当前 generation`);
    assertNonEmptyString(loss.attemptId, `${provider}.lastLoss.attemptId`);
    assertSafeTimestamp(loss.recordedAtMs, `${provider}.lastLoss.recordedAtMs`);
}

function assertLeaseArray(value: unknown, provider: ProviderId, ownerEpoch: number, uncertain: boolean): void {
    if (!Array.isArray(value)) throw new ProviderControlContractError(`${provider}.${uncertain ? "uncertain" : "active"}Leases 必须为数组`);
    const leaseIds = new Set<string>();
    for (const candidate of value) {
        const lease = expectRecord(candidate, `${provider} lease`);
        const keys = uncertain
            ? ["leaseId", "attemptId", "provider", "trafficClass", "ownerEpoch", "capacityGeneration", "acquiredAtMs", "expiresAtMs", "unknownOutcomeAtMs", "graceExpiresAtMs"]
            : ["leaseId", "attemptId", "provider", "trafficClass", "ownerEpoch", "capacityGeneration", "acquiredAtMs", "expiresAtMs"];
        assertExactKeys(lease, keys, `${provider} lease`);
        assertNonEmptyString(lease.leaseId, `${provider} leaseId`);
        if (leaseIds.has(lease.leaseId)) throw new ProviderControlContractError(`${provider} leaseId 重复`);
        leaseIds.add(lease.leaseId);
        assertNonEmptyString(lease.attemptId, `${provider} attemptId`);
        if (lease.provider !== provider || !PROVIDER_TRAFFIC_CLASSES.includes(lease.trafficClass as ProviderTrafficClass)) throw new ProviderControlContractError(`${provider} lease provider/trafficClass 非法`);
        assertNonNegativeInteger(lease.ownerEpoch, `${provider} lease ownerEpoch`);
        if (lease.ownerEpoch > ownerEpoch) throw new ProviderControlContractError(`${provider} lease ownerEpoch 不能超前`);
        assertPositiveInteger(lease.capacityGeneration, `${provider} lease capacityGeneration`);
        assertSafeTimestamp(lease.acquiredAtMs, `${provider} lease acquiredAtMs`);
        assertSafeTimestamp(lease.expiresAtMs, `${provider} lease expiresAtMs`);
        if (lease.expiresAtMs < lease.acquiredAtMs) throw new ProviderControlContractError(`${provider} lease expiresAtMs 非法`);
        if (uncertain) {
            assertSafeTimestamp(lease.unknownOutcomeAtMs, `${provider} uncertain unknownOutcomeAtMs`);
            assertSafeTimestamp(lease.graceExpiresAtMs, `${provider} uncertain graceExpiresAtMs`);
            if (lease.unknownOutcomeAtMs < lease.acquiredAtMs || lease.graceExpiresAtMs < lease.unknownOutcomeAtMs) throw new ProviderControlContractError(`${provider} uncertain lease 时间非法`);
        }
    }
}

function assertBreaker(value: unknown, provider: ProviderId, ownerEpoch: number, capacityGeneration: number, lastObservedWallClockMs: number): void {
    const breaker = expectRecord(value, `${provider}.breaker`);
    assertExactKeys(breaker, ["openUntilMs", "retryAfterMs", "failureBudget", "consecutiveFailures", "backoffExponent", "probeLease"], `${provider}.breaker`);
    assertNullableOpenUntil(breaker.openUntilMs, lastObservedWallClockMs, `${provider}.breaker.openUntilMs`);
    assertNullableDuration(breaker.retryAfterMs, `${provider}.breaker.retryAfterMs`);
    assertNonNegativeInteger(breaker.failureBudget, `${provider}.breaker.failureBudget`);
    assertNonNegativeInteger(breaker.consecutiveFailures, `${provider}.breaker.consecutiveFailures`);
    assertNonNegativeInteger(breaker.backoffExponent, `${provider}.breaker.backoffExponent`);
    if (breaker.probeLease === null) return;
    const probe = expectRecord(breaker.probeLease, `${provider}.breaker.probeLease`);
    assertExactKeys(probe, ["leaseId", "attemptId", "ownerEpoch", "capacityGeneration", "acquiredAtMs", "expiresAtMs"], `${provider}.breaker.probeLease`);
    assertNonEmptyString(probe.leaseId, `${provider}.probe leaseId`);
    assertNonEmptyString(probe.attemptId, `${provider}.probe attemptId`);
    assertNonNegativeInteger(probe.ownerEpoch, `${provider}.probe ownerEpoch`);
    if (probe.ownerEpoch > ownerEpoch) throw new ProviderControlContractError(`${provider}.probe ownerEpoch 不能超前`);
    assertPositiveInteger(probe.capacityGeneration, `${provider}.probe capacityGeneration`);
    if (probe.capacityGeneration > capacityGeneration) throw new ProviderControlContractError(`${provider}.probe generation 不能超前`);
    assertSafeTimestamp(probe.acquiredAtMs, `${provider}.probe acquiredAtMs`);
    assertSafeTimestamp(probe.expiresAtMs, `${provider}.probe expiresAtMs`);
    if (probe.expiresAtMs < probe.acquiredAtMs) throw new ProviderControlContractError(`${provider}.probe 时间非法`);
}

function assertTimeFrozen(value: unknown, provider: ProviderId): void {
    const frozen = expectRecord(value, "timeFrozen");
    assertExactKeys(frozen, ["frozen", "reason", "enteredAtMs", "requiresManualClear", "frozenFailureAttemptIds", "freezeEvidence"], "timeFrozen");
    if (typeof frozen.frozen !== "boolean" || typeof frozen.requiresManualClear !== "boolean") throw new ProviderControlContractError("timeFrozen 布尔字段非法");
    if (frozen.reason !== null && frozen.reason !== "capacity" && frozen.reason !== "clock_non_monotonic") throw new ProviderControlContractError("timeFrozen reason 非法");
    if (frozen.frozen !== (frozen.reason !== null) || frozen.frozen !== (frozen.enteredAtMs !== null)) throw new ProviderControlContractError("timeFrozen 状态不一致");
    if (frozen.enteredAtMs !== null) assertSafeTimestamp(frozen.enteredAtMs, "timeFrozen enteredAtMs");
    if (frozen.reason === "clock_non_monotonic" && !frozen.requiresManualClear) throw new ProviderControlContractError("时钟倒退冻结必须人工解除");
    if (!Array.isArray(frozen.frozenFailureAttemptIds) || frozen.frozenFailureAttemptIds.some(value => typeof value !== "string" || !value)) throw new ProviderControlContractError("frozenFailureAttemptIds 非法");
    if (new Set(frozen.frozenFailureAttemptIds).size !== frozen.frozenFailureAttemptIds.length) throw new ProviderControlContractError("frozenFailureAttemptIds 不能重复");
    if (!frozen.frozen) {
        if (frozen.freezeEvidence !== null) throw new ProviderControlContractError("未冻结状态不能保留 active freezeEvidence");
        return;
    }
    assertFreezeEvidence(frozen.freezeEvidence, provider, frozen.reason as TimeFrozenReason);
}

function assertAgyState(value: unknown, agyPool: ProviderPoolState): void {
    const agy = expectRecord(value, "agy");
    assertExactKeys(agy, ["memory", "admission"], "agy");
    const memory = expectRecord(agy.memory, "agy.memory");
    assertExactKeys(memory, ["memoryAimdLimit", "recoveryCredits", "lastPressureAtMs", "highWaterSamples", "lowWaterSamples"], "agy.memory");
    assertIntegerInRange(memory.memoryAimdLimit, 0, agyPool.physicalMax, "agy.memory.memoryAimdLimit");
    assertNonNegativeInteger(memory.recoveryCredits, "agy.memory.recoveryCredits");
    if (memory.lastPressureAtMs !== null) assertSafeTimestamp(memory.lastPressureAtMs, "agy.memory.lastPressureAtMs");
    assertNonNegativeInteger(memory.highWaterSamples, "agy.memory.highWaterSamples");
    assertNonNegativeInteger(memory.lowWaterSamples, "agy.memory.lowWaterSamples");
    const admission = expectRecord(agy.admission, "agy.admission");
    assertExactKeys(admission, ["firstRunOverflowGuarantee", "fallbackGuarantee", "firstRunOverflowLeaseIds", "fallbackLeaseIds", "firstRunOverflowBorrowedSlots", "fallbackBorrowedSlots"], "agy.admission");
    if (admission.firstRunOverflowGuarantee !== AGY_FIRST_RUN_OVERFLOW_GUARANTEE || admission.fallbackGuarantee !== AGY_FALLBACK_GUARANTEE) throw new ProviderControlContractError("agy 4+4 保障份额非法");
    const firstRunOverflowLeaseIds = admission.firstRunOverflowLeaseIds as string[];
    const fallbackLeaseIds = admission.fallbackLeaseIds as string[];
    const leaseUnion = [...agyPool.activeLeases, ...agyPool.uncertainLeases];
    assertLeaseIdSubset(firstRunOverflowLeaseIds, leaseUnion, "agy-first-run-overflow");
    assertLeaseIdSubset(fallbackLeaseIds, leaseUnion, "agy-fallback");
    if (new Set([...firstRunOverflowLeaseIds, ...fallbackLeaseIds]).size !== firstRunOverflowLeaseIds.length + fallbackLeaseIds.length) throw new ProviderControlContractError("agy 保障 lease 不可重复归类");
    assertNonNegativeInteger(admission.firstRunOverflowBorrowedSlots, "agy.admission.firstRunOverflowBorrowedSlots");
    assertNonNegativeInteger(admission.fallbackBorrowedSlots, "agy.admission.fallbackBorrowedSlots");
    if (admission.firstRunOverflowBorrowedSlots !== Math.max(0, firstRunOverflowLeaseIds.length - AGY_FIRST_RUN_OVERFLOW_GUARANTEE)
        || admission.fallbackBorrowedSlots !== Math.max(0, fallbackLeaseIds.length - AGY_FALLBACK_GUARANTEE)) {
        throw new ProviderControlContractError("agy borrowed slots 与 lane lease 联合不一致");
    }
}

function assertLeaseIdSubset(value: unknown, activeLeases: ProviderLease[], trafficClass: ProviderTrafficClass): void {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item)) throw new ProviderControlContractError(`${trafficClass} leaseIds 非法`);
    if (new Set(value).size !== value.length) throw new ProviderControlContractError(`${trafficClass} leaseIds 重复`);
    const active = new Map(activeLeases.map(lease => [lease.leaseId, lease]));
    for (const leaseId of value) {
        if (active.get(leaseId)?.trafficClass !== trafficClass) throw new ProviderControlContractError(`${trafficClass} lease 不在对应 active 集合`);
    }
}

function assertGlobalLeaseIdentity(state: ProviderControlState): void {
    const leaseIds = new Set<string>();
    for (const provider of PROVIDER_IDS) {
        for (const lease of [...state.pools[provider].activeLeases, ...state.pools[provider].uncertainLeases]) {
            if (leaseIds.has(lease.leaseId)) throw new ProviderControlContractError(`leaseId=${lease.leaseId} 在 provider control 中不全局唯一`);
            leaseIds.add(lease.leaseId);
        }
    }
}

function assertFreezeEvidence(value: unknown, provider: ProviderId, reason: TimeFrozenReason): void {
    const evidence = expectRecord(value, `${provider}.freezeEvidence`);
    assertExactKeys(evidence, [
        "evidenceId", "evidenceHash", "provider", "reason", "ownerEpoch", "controlRevision", "capacityGeneration",
        "observedAtMs", "previousLastObservedWallClockMs", "activeLeaseIds", "uncertainLeaseIds",
    ], `${provider}.freezeEvidence`);
    assertNonEmptyString(evidence.evidenceId, `${provider}.freezeEvidence.evidenceId`);
    assertSha256(evidence.evidenceHash, `${provider}.freezeEvidence.evidenceHash`, false);
    if (evidence.provider !== provider || evidence.reason !== reason) throw new ProviderControlContractError(`${provider}.freezeEvidence provider/reason 不匹配`);
    assertNonNegativeInteger(evidence.ownerEpoch, `${provider}.freezeEvidence.ownerEpoch`);
    assertPositiveInteger(evidence.controlRevision, `${provider}.freezeEvidence.controlRevision`);
    assertPositiveInteger(evidence.capacityGeneration, `${provider}.freezeEvidence.capacityGeneration`);
    assertSafeTimestamp(evidence.observedAtMs, `${provider}.freezeEvidence.observedAtMs`);
    assertSafeTimestamp(evidence.previousLastObservedWallClockMs, `${provider}.freezeEvidence.previousLastObservedWallClockMs`);
    assertStringSet(evidence.activeLeaseIds, `${provider}.freezeEvidence.activeLeaseIds`);
    assertStringSet(evidence.uncertainLeaseIds, `${provider}.freezeEvidence.uncertainLeaseIds`);
}

function assertManualRecovery(value: unknown, provider: ProviderId): void {
    if (value === null) return;
    const recovery = expectRecord(value, `${provider}.lastManualRecovery`);
    assertExactKeys(recovery, [
        "freezeEvidenceId", "freezeEvidenceHash", "acknowledgedBy", "acknowledgedAtMs", "correctedNowMs",
        "recoveredOwnerEpoch", "recoveredControlRevision",
    ], `${provider}.lastManualRecovery`);
    assertNonEmptyString(recovery.freezeEvidenceId, `${provider}.lastManualRecovery.freezeEvidenceId`);
    assertSha256(recovery.freezeEvidenceHash, `${provider}.lastManualRecovery.freezeEvidenceHash`, false);
    assertNonEmptyString(recovery.acknowledgedBy, `${provider}.lastManualRecovery.acknowledgedBy`);
    assertSafeTimestamp(recovery.acknowledgedAtMs, `${provider}.lastManualRecovery.acknowledgedAtMs`);
    assertSafeTimestamp(recovery.correctedNowMs, `${provider}.lastManualRecovery.correctedNowMs`);
    if (recovery.acknowledgedAtMs > recovery.correctedNowMs) throw new ProviderControlContractError(`${provider}.lastManualRecovery 确认时间不能晚于校正时间`);
    assertNonNegativeInteger(recovery.recoveredOwnerEpoch, `${provider}.lastManualRecovery.recoveredOwnerEpoch`);
    assertPositiveInteger(recovery.recoveredControlRevision, `${provider}.lastManualRecovery.recoveredControlRevision`);
}

function assertInstallationIdentity(value: unknown): void {
    const installation = expectRecord(value, "installation");
    assertExactKeys(installation, ["initializationId", "bootstrapIdentityHash", "bootstrapTokenHash", "initialPublicationId"], "installation");
    assertNonEmptyString(installation.initializationId, "installation.initializationId");
    assertSha256(installation.bootstrapIdentityHash, "installation.bootstrapIdentityHash", false);
    assertSha256(installation.bootstrapTokenHash, "installation.bootstrapTokenHash", false);
    assertNonEmptyString(installation.initialPublicationId, "installation.initialPublicationId");
}

function assertStringSet(value: unknown, name: string): asserts value is string[] {
    if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item)) throw new ProviderControlContractError(`${name} 非法`);
    if (new Set(value).size !== value.length) throw new ProviderControlContractError(`${name} 不能重复`);
}

function assertOwnerLease(value: unknown): void {
    if (value === null) return;
    const owner = expectRecord(value, "ownerLease");
    assertExactKeys(owner, ["ownerId", "leaseId", "acquiredAtMs", "expiresAtMs"], "ownerLease");
    assertNonEmptyString(owner.ownerId, "ownerLease.ownerId");
    assertNonEmptyString(owner.leaseId, "ownerLease.leaseId");
    assertSafeTimestamp(owner.acquiredAtMs, "ownerLease.acquiredAtMs");
    assertSafeTimestamp(owner.expiresAtMs, "ownerLease.expiresAtMs");
    if (owner.expiresAtMs < owner.acquiredAtMs) throw new ProviderControlContractError("ownerLease expiresAtMs 非法");
}

function expectRecord(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderControlContractError(`${name} 必须为对象`);
    return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new ProviderControlContractError(`${name} 包含未知或缺失字段`);
}

function assertNonEmptyString(value: unknown, name: string): asserts value is string {
    if (typeof value !== "string" || !value) throw new ProviderControlContractError(`${name} 必须为非空字符串`);
}

function assertPositiveInteger(value: unknown, name: string): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new ProviderControlContractError(`${name} 必须为正安全整数`);
}

function assertNonNegativeInteger(value: unknown, name: string): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ProviderControlContractError(`${name} 必须为非负安全整数`);
}

function assertIntegerInRange(value: unknown, minimum: number, maximum: number, name: string): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ProviderControlContractError(`${name} 必须在 ${minimum}..${maximum}`);
}

function assertSafeTimestamp(value: unknown, name: string): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new ProviderControlContractError(`${name} 必须为有限非负毫秒时间`);
}

function assertNullableDuration(value: unknown, name: string): void {
    if (value === null) return;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_BREAKER_OPEN_MS) throw new ProviderControlContractError(`${name} 必须为 0..${MAX_BREAKER_OPEN_MS} 内的有限毫秒数`);
}

function assertNullableOpenUntil(value: unknown, lastObservedWallClockMs: number, name: string): void {
    if (value === null) return;
    assertSafeTimestamp(value, name);
    if (value < lastObservedWallClockMs || value - lastObservedWallClockMs > MAX_BREAKER_OPEN_MS) throw new ProviderControlContractError(`${name} 必须在当前观测时间后的 ${MAX_BREAKER_OPEN_MS}ms 范围内`);
}

function assertSha256(value: unknown, name: string, allowEmpty: boolean): void {
    if (allowEmpty && value === "") return;
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new ProviderControlContractError(`${name} 必须为 SHA-256 hex`);
}
