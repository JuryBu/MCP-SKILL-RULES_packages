export const DEFAULT_AGY_MEMORY_WATERMARK_CONFIG = {
    lowWatermarkRatio: 0.65,
    highWatermarkRatio: 0.85,
    lowWaterRecoverySamples: 3,
    reductionFactor: 0.5,
    recoveryStep: 1,
    minMemoryAimdLimit: 0,
} as const;

export type AgyMemoryWatermarkConfig = {
    lowWatermarkRatio: number;
    highWatermarkRatio: number;
    lowWaterRecoverySamples: number;
    reductionFactor: number;
    recoveryStep: number;
    minMemoryAimdLimit: number;
};

export type AgyMemoryWatermarkFailureReason =
    | "monotonic_time_unavailable"
    | "monotonic_time_non_finite"
    | "monotonic_time_reversed"
    | "memory_sampling_failed"
    | "memory_sample_invalid"
    | "memory_sample_non_finite";

export type AgyMemoryWatermarkReason =
    | "high_watermark"
    | "low_watermark_recovery"
    | "low_watermark_waiting"
    | "middle_band"
    | "manual_frozen"
    | "manual_clear"
    | AgyMemoryWatermarkFailureReason;

export interface AgyMemorySample {
    usedBytes: number;
    totalBytes: number;
}

export interface AgyMemoryWatermarkDependencies {
    sampleMemory: () => AgyMemorySample;
    nowMonotonicMs: () => number;
}

export interface AgyMemoryWatermarkFrozenState {
    reason: AgyMemoryWatermarkFailureReason;
    evidenceHash: string;
    observedAtMonotonicMs: number | null;
    observedBytes: number | null;
    observedCapacityBytes: number | null;
}

export interface AgyMemoryWatermarkState {
    memoryAimdLimit: number;
    recoveryCredits: number;
    lastPressureAtMs: number | null;
    highWaterSamples: number;
    lowWaterSamples: number;
    lastSampledAtMonotonicMs: number | null;
    frozen: AgyMemoryWatermarkFrozenState | null;
}

export interface AgyMemoryWatermarkControlSnapshot {
    controlRevision: number;
    ownerEpoch: number;
    physicalMax: number;
    currentLimit: number;
    activeSlots: number;
    memory: AgyMemoryWatermarkState;
}

export interface AgyMemoryGrantPolicy {
    permitNewGrant: boolean;
    reason: "manual_frozen" | "effective_limit_reached" | "capacity_available";
    activeSlots: number;
    effectiveLimit: number;
    terminateRunningProcesses: false;
}

export interface AgyMemoryWatermarkTransition {
    kind: "agy-memory-watermark";
    expectedControlRevision: number;
    ownerEpoch: number;
    evidenceHash: string;
    reason: AgyMemoryWatermarkReason;
    observedBytes: number | null;
    observedCapacityBytes: number | null;
    observedAtMonotonicMs: number | null;
    observedUtilizationRatio: number | null;
    memoryAimdLimitBefore: number;
    memoryAimdLimitAfter: number;
    effectiveLimitBefore: number;
    effectiveLimitAfter: number;
    nextMemory: AgyMemoryWatermarkState;
    grant: AgyMemoryGrantPolicy;
}

export interface AgyMemoryWatermarkDecision {
    transition: AgyMemoryWatermarkTransition;
}

export interface ClearAgyMemoryWatermarkFreezeInput extends AgyMemoryWatermarkControlSnapshot {
    acknowledgement: string;
    frozenEvidenceHash: string;
}

export class AgyMemoryWatermarkConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AgyMemoryWatermarkConfigurationError";
    }
}

export class AgyMemoryWatermarkEvidenceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AgyMemoryWatermarkEvidenceError";
    }
}

export function createInitialAgyMemoryWatermarkState(memoryAimdLimit: number): AgyMemoryWatermarkState {
    assertSafeIntegerInRange(memoryAimdLimit, 0, Number.MAX_SAFE_INTEGER, "memoryAimdLimit");
    return {
        memoryAimdLimit,
        recoveryCredits: 0,
        lastPressureAtMs: null,
        highWaterSamples: 0,
        lowWaterSamples: 0,
        lastSampledAtMonotonicMs: null,
        frozen: null,
    };
}

export function restoreAgyMemoryWatermarkState(
    state: AgyMemoryWatermarkState,
    physicalMax: number,
): AgyMemoryWatermarkState {
    assertSafeIntegerInRange(physicalMax, 1, Number.MAX_SAFE_INTEGER, "physicalMax");
    assertMemoryState(state, physicalMax);
    return cloneMemoryState(state);
}

export function effectiveAgyMemoryWatermarkLimit(snapshot: Pick<AgyMemoryWatermarkControlSnapshot, "physicalMax" | "currentLimit" | "memory">): number {
    return Math.min(snapshot.physicalMax, snapshot.currentLimit, snapshot.memory.memoryAimdLimit);
}

export function observeAgyMemoryWatermark(
    snapshot: AgyMemoryWatermarkControlSnapshot,
    config: AgyMemoryWatermarkConfig,
    dependencies: AgyMemoryWatermarkDependencies,
): AgyMemoryWatermarkDecision {
    assertSnapshot(snapshot);
    assertConfig(config, snapshot.physicalMax);

    let observedAtMonotonicMs: number;
    try {
        observedAtMonotonicMs = dependencies.nowMonotonicMs();
    } catch {
        return failClosed(snapshot, "monotonic_time_unavailable", null, null, null);
    }
    if (!isValidTimestamp(observedAtMonotonicMs)) {
        return failClosed(snapshot, "monotonic_time_non_finite", null, null, null);
    }
    if (snapshot.memory.lastSampledAtMonotonicMs !== null && observedAtMonotonicMs < snapshot.memory.lastSampledAtMonotonicMs) {
        return failClosed(snapshot, "monotonic_time_reversed", null, null, observedAtMonotonicMs);
    }

    let sample: AgyMemorySample;
    try {
        sample = dependencies.sampleMemory();
    } catch {
        return failClosed(snapshot, "memory_sampling_failed", null, null, observedAtMonotonicMs);
    }
    const sampleFailure = validateSample(sample);
    if (sampleFailure !== null) {
        return failClosed(snapshot, sampleFailure, null, null, observedAtMonotonicMs);
    }

    const observedBytes = sample.usedBytes;
    const observedCapacityBytes = sample.totalBytes;
    const observedUtilizationRatio = observedBytes / observedCapacityBytes;
    const beforeEffectiveLimit = effectiveAgyMemoryWatermarkLimit(snapshot);

    if (snapshot.memory.frozen !== null) {
        const nextMemory = {
            ...cloneMemoryState(snapshot.memory),
            memoryAimdLimit: 0,
            lastSampledAtMonotonicMs: observedAtMonotonicMs,
        };
        return {
            transition: buildTransition(snapshot, nextMemory, "manual_frozen", observedBytes, observedCapacityBytes, observedAtMonotonicMs, observedUtilizationRatio, beforeEffectiveLimit),
        };
    }

    if (observedUtilizationRatio >= config.highWatermarkRatio) {
        const nextMemory = cloneMemoryState(snapshot.memory);
        nextMemory.memoryAimdLimit = Math.max(
            config.minMemoryAimdLimit,
            Math.floor(snapshot.memory.memoryAimdLimit * config.reductionFactor),
        );
        nextMemory.recoveryCredits = 0;
        nextMemory.highWaterSamples = incrementCounter(snapshot.memory.highWaterSamples);
        nextMemory.lowWaterSamples = 0;
        nextMemory.lastPressureAtMs = observedAtMonotonicMs;
        nextMemory.lastSampledAtMonotonicMs = observedAtMonotonicMs;
        return {
            transition: buildTransition(snapshot, nextMemory, "high_watermark", observedBytes, observedCapacityBytes, observedAtMonotonicMs, observedUtilizationRatio, beforeEffectiveLimit),
        };
    }

    if (observedUtilizationRatio <= config.lowWatermarkRatio) {
        const nextMemory = cloneMemoryState(snapshot.memory);
        nextMemory.highWaterSamples = 0;
        nextMemory.lowWaterSamples = incrementCounter(snapshot.memory.lowWaterSamples);
        nextMemory.recoveryCredits = incrementCounter(snapshot.memory.recoveryCredits);
        nextMemory.lastSampledAtMonotonicMs = observedAtMonotonicMs;

        if (nextMemory.recoveryCredits >= config.lowWaterRecoverySamples && nextMemory.memoryAimdLimit < snapshot.physicalMax) {
            nextMemory.memoryAimdLimit = Math.min(snapshot.physicalMax, nextMemory.memoryAimdLimit + config.recoveryStep);
            nextMemory.recoveryCredits = 0;
            nextMemory.lowWaterSamples = 0;
            return {
                transition: buildTransition(snapshot, nextMemory, "low_watermark_recovery", observedBytes, observedCapacityBytes, observedAtMonotonicMs, observedUtilizationRatio, beforeEffectiveLimit),
            };
        }

        return {
            transition: buildTransition(snapshot, nextMemory, "low_watermark_waiting", observedBytes, observedCapacityBytes, observedAtMonotonicMs, observedUtilizationRatio, beforeEffectiveLimit),
        };
    }

    const nextMemory = cloneMemoryState(snapshot.memory);
    nextMemory.recoveryCredits = 0;
    nextMemory.highWaterSamples = 0;
    nextMemory.lowWaterSamples = 0;
    nextMemory.lastSampledAtMonotonicMs = observedAtMonotonicMs;
    return {
        transition: buildTransition(snapshot, nextMemory, "middle_band", observedBytes, observedCapacityBytes, observedAtMonotonicMs, observedUtilizationRatio, beforeEffectiveLimit),
    };
}

export function clearAgyMemoryWatermarkFreeze(
    input: ClearAgyMemoryWatermarkFreezeInput,
    dependencies: Pick<AgyMemoryWatermarkDependencies, "nowMonotonicMs">,
): AgyMemoryWatermarkDecision {
    assertSnapshot(input);
    if (input.memory.frozen === null) {
        throw new AgyMemoryWatermarkEvidenceError("agy memory 未处于需要人工解除的 frozen 状态");
    }
    if (input.acknowledgement.trim().length === 0) {
        throw new AgyMemoryWatermarkEvidenceError("人工解除 frozen 必须给出 acknowledgement 证据");
    }
    if (input.frozenEvidenceHash !== input.memory.frozen.evidenceHash) {
        throw new AgyMemoryWatermarkEvidenceError("人工解除 frozen 的证据哈希与冻结记录不匹配");
    }

    let observedAtMonotonicMs: number;
    try {
        observedAtMonotonicMs = dependencies.nowMonotonicMs();
    } catch {
        throw new AgyMemoryWatermarkEvidenceError("人工解除 frozen 时无法读取单调时间");
    }
    if (!isValidTimestamp(observedAtMonotonicMs)) {
        throw new AgyMemoryWatermarkEvidenceError("人工解除 frozen 时单调时间非法");
    }
    if (input.memory.lastSampledAtMonotonicMs !== null && observedAtMonotonicMs < input.memory.lastSampledAtMonotonicMs) {
        throw new AgyMemoryWatermarkEvidenceError("人工解除 frozen 时单调时间倒退");
    }

    const nextMemory = cloneMemoryState(input.memory);
    nextMemory.frozen = null;
    nextMemory.lastSampledAtMonotonicMs = observedAtMonotonicMs;
    const transition = buildTransition(
        input,
        nextMemory,
        "manual_clear",
        input.memory.frozen.observedBytes,
        input.memory.frozen.observedCapacityBytes,
        observedAtMonotonicMs,
        null,
        effectiveAgyMemoryWatermarkLimit(input),
        input.acknowledgement,
    );
    return { transition };
}

function failClosed(
    snapshot: AgyMemoryWatermarkControlSnapshot,
    reason: AgyMemoryWatermarkFailureReason,
    observedBytes: number | null,
    observedCapacityBytes: number | null,
    observedAtMonotonicMs: number | null,
): AgyMemoryWatermarkDecision {
    const beforeEffectiveLimit = effectiveAgyMemoryWatermarkLimit(snapshot);
    const evidenceHash = hashEvidence([
        "failure",
        reason,
        snapshot.controlRevision,
        snapshot.ownerEpoch,
        observedBytes,
        observedCapacityBytes,
        observedAtMonotonicMs,
        snapshot.memory.lastSampledAtMonotonicMs,
    ]);
    const nextMemory = cloneMemoryState(snapshot.memory);
    nextMemory.memoryAimdLimit = 0;
    nextMemory.recoveryCredits = 0;
    nextMemory.highWaterSamples = 0;
    nextMemory.lowWaterSamples = 0;
    if (observedAtMonotonicMs !== null && (snapshot.memory.lastSampledAtMonotonicMs === null || observedAtMonotonicMs >= snapshot.memory.lastSampledAtMonotonicMs)) {
        nextMemory.lastPressureAtMs = observedAtMonotonicMs;
        nextMemory.lastSampledAtMonotonicMs = observedAtMonotonicMs;
    }
    nextMemory.frozen = {
        reason,
        evidenceHash,
        observedAtMonotonicMs,
        observedBytes,
        observedCapacityBytes,
    };
    return {
        transition: buildTransition(snapshot, nextMemory, reason, observedBytes, observedCapacityBytes, observedAtMonotonicMs, null, beforeEffectiveLimit, undefined, evidenceHash),
    };
}

function buildTransition(
    snapshot: AgyMemoryWatermarkControlSnapshot,
    nextMemory: AgyMemoryWatermarkState,
    reason: AgyMemoryWatermarkReason,
    observedBytes: number | null,
    observedCapacityBytes: number | null,
    observedAtMonotonicMs: number | null,
    observedUtilizationRatio: number | null,
    beforeEffectiveLimit: number,
    acknowledgement?: string,
    evidenceHashOverride?: string,
): AgyMemoryWatermarkTransition {
    const afterEffectiveLimit = Math.min(snapshot.physicalMax, snapshot.currentLimit, nextMemory.memoryAimdLimit);
    const evidenceHash = evidenceHashOverride ?? hashEvidence([
        "observation",
        reason,
        snapshot.controlRevision,
        snapshot.ownerEpoch,
        observedBytes,
        observedCapacityBytes,
        observedAtMonotonicMs,
        snapshot.memory.memoryAimdLimit,
        nextMemory.memoryAimdLimit,
        snapshot.memory.lastSampledAtMonotonicMs,
        acknowledgement ?? "",
    ]);
    return {
        kind: "agy-memory-watermark",
        expectedControlRevision: snapshot.controlRevision,
        ownerEpoch: snapshot.ownerEpoch,
        evidenceHash,
        reason,
        observedBytes,
        observedCapacityBytes,
        observedAtMonotonicMs,
        observedUtilizationRatio,
        memoryAimdLimitBefore: snapshot.memory.memoryAimdLimit,
        memoryAimdLimitAfter: nextMemory.memoryAimdLimit,
        effectiveLimitBefore: beforeEffectiveLimit,
        effectiveLimitAfter: afterEffectiveLimit,
        nextMemory,
        grant: buildGrantPolicy(snapshot.activeSlots, afterEffectiveLimit, nextMemory.frozen !== null),
    };
}

function buildGrantPolicy(activeSlots: number, effectiveLimit: number, frozen: boolean): AgyMemoryGrantPolicy {
    if (frozen) {
        return {
            permitNewGrant: false,
            reason: "manual_frozen",
            activeSlots,
            effectiveLimit,
            terminateRunningProcesses: false,
        };
    }
    return {
        permitNewGrant: activeSlots < effectiveLimit,
        reason: activeSlots < effectiveLimit ? "capacity_available" : "effective_limit_reached",
        activeSlots,
        effectiveLimit,
        terminateRunningProcesses: false,
    };
}

function validateSample(sample: unknown): AgyMemoryWatermarkFailureReason | null {
    if (typeof sample !== "object" || sample === null || Array.isArray(sample)) return "memory_sample_invalid";
    const value = sample as Partial<AgyMemorySample>;
    if (typeof value.usedBytes !== "number" || typeof value.totalBytes !== "number") return "memory_sample_invalid";
    if (!Number.isFinite(value.usedBytes) || !Number.isFinite(value.totalBytes)) return "memory_sample_non_finite";
    if (!Number.isSafeInteger(value.usedBytes) || !Number.isSafeInteger(value.totalBytes) || value.usedBytes < 0 || value.totalBytes <= 0 || value.usedBytes > value.totalBytes) {
        return "memory_sample_invalid";
    }
    return null;
}

function assertConfig(config: AgyMemoryWatermarkConfig, physicalMax: number): void {
    if (!Number.isFinite(config.lowWatermarkRatio) || !Number.isFinite(config.highWatermarkRatio)
        || config.lowWatermarkRatio < 0 || config.lowWatermarkRatio >= config.highWatermarkRatio || config.highWatermarkRatio > 1) {
        throw new AgyMemoryWatermarkConfigurationError("低/高水位必须满足 0 <= low < high <= 1");
    }
    assertSafeIntegerInRange(config.lowWaterRecoverySamples, 1, Number.MAX_SAFE_INTEGER, "lowWaterRecoverySamples");
    if (!Number.isFinite(config.reductionFactor) || config.reductionFactor < 0 || config.reductionFactor >= 1) {
        throw new AgyMemoryWatermarkConfigurationError("reductionFactor 必须满足 0 <= factor < 1");
    }
    assertSafeIntegerInRange(config.recoveryStep, 1, physicalMax, "recoveryStep");
    assertSafeIntegerInRange(config.minMemoryAimdLimit, 0, physicalMax, "minMemoryAimdLimit");
}

function assertSnapshot(snapshot: AgyMemoryWatermarkControlSnapshot): void {
    assertSafeIntegerInRange(snapshot.controlRevision, 1, Number.MAX_SAFE_INTEGER, "controlRevision");
    assertSafeIntegerInRange(snapshot.ownerEpoch, 0, Number.MAX_SAFE_INTEGER, "ownerEpoch");
    assertSafeIntegerInRange(snapshot.physicalMax, 1, Number.MAX_SAFE_INTEGER, "physicalMax");
    assertSafeIntegerInRange(snapshot.currentLimit, 0, snapshot.physicalMax, "currentLimit");
    assertSafeIntegerInRange(snapshot.activeSlots, 0, Number.MAX_SAFE_INTEGER, "activeSlots");
    assertMemoryState(snapshot.memory, snapshot.physicalMax);
}

function assertMemoryState(state: AgyMemoryWatermarkState, physicalMax: number): void {
    assertSafeIntegerInRange(state.memoryAimdLimit, 0, physicalMax, "memoryAimdLimit");
    assertSafeIntegerInRange(state.recoveryCredits, 0, Number.MAX_SAFE_INTEGER, "recoveryCredits");
    assertSafeIntegerInRange(state.highWaterSamples, 0, Number.MAX_SAFE_INTEGER, "highWaterSamples");
    assertSafeIntegerInRange(state.lowWaterSamples, 0, Number.MAX_SAFE_INTEGER, "lowWaterSamples");
    assertNullableTimestamp(state.lastPressureAtMs, "lastPressureAtMs");
    assertNullableTimestamp(state.lastSampledAtMonotonicMs, "lastSampledAtMonotonicMs");
    if (state.frozen === null) return;
    if (typeof state.frozen !== "object" || !isFailureReason(state.frozen.reason) || typeof state.frozen.evidenceHash !== "string" || state.frozen.evidenceHash.length === 0) {
        throw new AgyMemoryWatermarkConfigurationError("frozen state 非法");
    }
    assertNullableTimestamp(state.frozen.observedAtMonotonicMs, "frozen.observedAtMonotonicMs");
    assertNullableObservedBytes(state.frozen.observedBytes, "frozen.observedBytes");
    assertNullableObservedBytes(state.frozen.observedCapacityBytes, "frozen.observedCapacityBytes");
}

function assertSafeIntegerInRange(value: number, minimum: number, maximum: number, name: string): void {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new AgyMemoryWatermarkConfigurationError(`${name} 必须是 ${minimum}..${maximum} 范围内的安全整数`);
    }
}

function assertNullableTimestamp(value: number | null, name: string): void {
    if (value !== null && !isValidTimestamp(value)) {
        throw new AgyMemoryWatermarkConfigurationError(`${name} 必须是非负有限单调时间或 null`);
    }
}

function assertNullableObservedBytes(value: number | null, name: string): void {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        throw new AgyMemoryWatermarkConfigurationError(`${name} 必须是非负安全整数或 null`);
    }
}

function isValidTimestamp(value: number): boolean {
    return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function isFailureReason(value: string): value is AgyMemoryWatermarkFailureReason {
    return value === "monotonic_time_unavailable"
        || value === "monotonic_time_non_finite"
        || value === "monotonic_time_reversed"
        || value === "memory_sampling_failed"
        || value === "memory_sample_invalid"
        || value === "memory_sample_non_finite";
}

function incrementCounter(value: number): number {
    return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

function cloneMemoryState(state: AgyMemoryWatermarkState): AgyMemoryWatermarkState {
    return {
        ...state,
        frozen: state.frozen === null ? null : { ...state.frozen },
    };
}

function hashEvidence(parts: readonly unknown[]): string {
    let hash = 0xcbf29ce484222325n;
    const canonical = parts.map(part => part === null ? "null" : String(part)).join("|");
    for (const character of canonical) {
        hash ^= BigInt(character.codePointAt(0) ?? 0);
        hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}
