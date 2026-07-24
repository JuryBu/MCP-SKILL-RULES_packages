import crypto from "node:crypto";
import {
    MAX_BREAKER_OPEN_MS,
    PROVIDER_CONTROL_PHYSICAL_MAX,
    effectiveAgyLimit,
    matchesProviderLeaseIdentity,
    providerLeaseIdentity,
    type ProviderControlState,
    type ProviderId,
    type ProviderLease,
    type ProviderLeaseIdentity,
    type ProviderTrafficClass,
} from "./provider-control-contracts.js";
import {
    ProviderControlFencedError,
    ProviderControlRepairRequiredError,
    clearProviderTimeFrozen,
    claimProviderControlOwner,
    initializeProviderControlStore,
    mutateProviderControlAsOwner,
    readProviderLeaseByAttempt,
    readProviderControlStore,
    reclaimExpiredProviderLeases,
    renewProviderControlOwner,
    settleRecoveredProviderLease,
    verifyProviderControlDurabilityReceipt,
    type ProviderControlDurabilityReceipt,
    type ProviderControlOwnerFence,
    type ProviderControlStoreOptions,
    type ProviderLeaseRecoveryRead,
    type ProviderRecoveredLeaseSettlement,
} from "./provider-control-store.js";

export const PROVIDER_ADMISSION_MODES = ["legacy", "shadow", "test", "enforced"] as const;
export type ProviderAdmissionMode = typeof PROVIDER_ADMISSION_MODES[number];

export type ProviderAdmissionOutcome = {
    kind: "success" | "congestion" | "availability" | "quality" | "complexity" | "local-resource" | "unknown-outcome" | "cancelled";
    retryAfterMs?: number;
};

export interface ProviderAdmissionInvocation {
    attemptId: string;
    lane?: string;
    signal?: AbortSignal;
    leaseDurationMs?: number;
}

export interface ProviderAdmissionRunInvocation<Value> extends ProviderAdmissionInvocation {
    execute(permit: ProviderAdmissionPermit): Promise<Value> | Value;
    classifyError?(error: unknown): ProviderAdmissionOutcome;
}

export interface ProviderAdmissionOptions extends ProviderControlStoreOptions {
    mode?: ProviderAdmissionMode;
    ownerId?: string;
    ownerLeaseDurationMs?: number;
    leaseDurationMs?: number;
    uncertainGraceMs?: number;
    now?: () => number;
}

export interface ProviderAdmissionPermit {
    readonly provider: ProviderId;
    readonly trafficClass: ProviderTrafficClass;
    readonly attemptId: string;
    readonly leaseId: string;
    readonly ownerEpoch: number | null;
    readonly capacityGeneration: number | null;
    readonly leaseIdentity: ProviderLeaseIdentity | null;
    readonly receipt: ProviderControlDurabilityReceipt | null;
    readonly probe: boolean;
    complete(outcome?: ProviderAdmissionOutcome): Promise<boolean>;
    markUnknownOutcome(): Promise<boolean>;
    release(): Promise<boolean>;
    assertCurrent(): Promise<void>;
}

export type ProviderAdmissionLeaseRecovery = ProviderLeaseRecoveryRead;
export type ProviderAdmissionRecoveredLeaseSettlement = ProviderRecoveredLeaseSettlement;

export interface ProviderAdmissionSnapshot {
    provider: ProviderId;
    mode: ProviderAdmissionMode;
    queuedForeground: number;
    queuedRecord: number;
    active: number;
    uncertain: number;
    currentLimit: number | null;
    effectiveLimit: number | null;
    capacityGeneration: number | null;
    lossEpoch: number | null;
    frozen: boolean | null;
    breakerOpenUntilMs: number | null;
    shadowGrants: number;
}

export interface ProviderAdmissionManualRecovery {
    provider: ProviderId;
    evidence: string;
    recoveredAtMs: number;
    receipt: ProviderControlDurabilityReceipt;
}

export class ProviderAdmissionError extends Error {
    constructor(message: string, readonly code: string) {
        super(message);
        this.name = "ProviderAdmissionError";
    }
}

export class ProviderAdmissionCancelledError extends ProviderAdmissionError {
    constructor(attemptId: string) {
        super(`provider admission 已取消：${attemptId}`, "ADMISSION_CANCELLED");
        this.name = "ProviderAdmissionCancelledError";
    }
}

export class ProviderAdmissionFencedError extends ProviderAdmissionError {
    constructor(message: string) {
        super(message, "ADMISSION_FENCED");
        this.name = "ProviderAdmissionFencedError";
    }
}

export class ProviderAdmissionRepairRequiredError extends ProviderAdmissionError {
    constructor(message: string) {
        super(message, "ADMISSION_REPAIR_REQUIRED");
        this.name = "ProviderAdmissionRepairRequiredError";
    }
}

type AdmissionLane = "foreground" | "record";

type QueuedRequest = {
    sequence: number;
    provider: ProviderId;
    trafficClass: ProviderTrafficClass;
    invocation: ProviderAdmissionInvocation;
    lane: AdmissionLane;
    cancelled: boolean;
    granting: boolean;
    settled: boolean;
    resolve: (permit: ProviderAdmissionPermit) => void;
    reject: (error: Error) => void;
    removeAbortListener?: () => void;
};

type ProviderRuntime = {
    foreground: QueuedRequest[];
    record: QueuedRequest[];
    foregroundStreak: number;
    pumping: Promise<void> | null;
    wakeTimer: NodeJS.Timeout | null;
    shadowGrants: number;
};

type GrantedLease = {
    lease: ProviderLease;
    receipt: ProviderControlDurabilityReceipt;
    probe: boolean;
};

const DEFAULT_OWNER_LEASE_MS = 5 * 60_000;
const DEFAULT_CALL_LEASE_MS = 2 * 60_000;
const DEFAULT_UNCERTAIN_GRACE_MS = 30_000;
const BREAKER_FAILURE_BUDGETS = [8, 4, 2, 1] as const;

export class ProviderAdmission {
    private readonly mode: ProviderAdmissionMode;
    private readonly now: () => number;
    private readonly ownerId: string;
    private readonly ownerLeaseDurationMs: number;
    private readonly ownerRenewalWindowMs: number;
    private readonly defaultLeaseDurationMs: number;
    private readonly uncertainGraceMs: number;
    private readonly storeOptions: ProviderControlStoreOptions;
    private readonly runtimes: Record<ProviderId, ProviderRuntime> = {
        grok: createRuntime(),
        agy: createRuntime(),
    };
    private ownerFence: ProviderControlOwnerFence | null = null;
    private ownerLeaseExpiresAtMs: number | null = null;
    private ownerOperation: Promise<void> | null = null;
    private controlTail: Promise<void> = Promise.resolve();
    private readonly backgroundOperations = new Set<Promise<void>>();
    private readonly backgroundErrors: unknown[] = [];
    private readonly inFlightGrants = new Set<QueuedRequest>();
    private closing = false;
    private closed = false;
    private closeOperation: Promise<void> | null = null;
    private nextSequence = 1;
    private readonly manualRecoveries: ProviderAdmissionManualRecovery[] = [];

    constructor(options: ProviderAdmissionOptions = {}) {
        this.mode = options.mode ?? "legacy";
        if (this.mode === "test" && !options.dataRoot) {
            throw new ProviderAdmissionError("test 模式必须提供临时 dataRoot", "TEST_DATA_ROOT_REQUIRED");
        }
        this.now = options.now ?? (() => Date.now());
        this.ownerId = options.ownerId ?? `provider-admission-${crypto.randomUUID()}`;
        this.ownerLeaseDurationMs = normalizeDuration(options.ownerLeaseDurationMs, DEFAULT_OWNER_LEASE_MS, "ownerLeaseDurationMs");
        this.ownerRenewalWindowMs = Math.max(1, Math.floor(this.ownerLeaseDurationMs / 3));
        this.defaultLeaseDurationMs = normalizeDuration(options.leaseDurationMs, DEFAULT_CALL_LEASE_MS, "leaseDurationMs");
        this.uncertainGraceMs = normalizeDuration(options.uncertainGraceMs, DEFAULT_UNCERTAIN_GRACE_MS, "uncertainGraceMs");
        this.storeOptions = {
            dataRoot: options.dataRoot,
            controlFilePath: options.controlFilePath,
            lock: options.lock,
        };
    }

    async acquire(provider: ProviderId, trafficClass: ProviderTrafficClass, invocation: ProviderAdmissionInvocation): Promise<ProviderAdmissionPermit> {
        assertInvocation(invocation);
        if (this.closing || this.closed) throw new ProviderAdmissionError("provider admission 已关闭", "ADMISSION_CLOSED");
        if (!isLiveMode(this.mode)) return this.acquireBypass(provider, trafficClass, invocation);
        if (invocation.signal?.aborted) throw new ProviderAdmissionCancelledError(invocation.attemptId);
        return await new Promise<ProviderAdmissionPermit>((resolve, reject) => {
            const queued: QueuedRequest = {
                sequence: this.nextSequence++,
                provider,
                trafficClass,
                invocation,
                lane: trafficClass === "foreground" ? "foreground" : "record",
                cancelled: false,
                granting: false,
                settled: false,
                resolve,
                reject,
            };
            const runtime = this.runtimes[provider];
            (queued.lane === "foreground" ? runtime.foreground : runtime.record).push(queued);
            if (invocation.signal) {
                const onAbort = () => this.cancelQueuedRequest(queued);
                invocation.signal.addEventListener("abort", onAbort, { once: true });
                queued.removeAbortListener = () => invocation.signal?.removeEventListener("abort", onAbort);
            }
            this.schedulePump(provider);
        });
    }

    async tryAcquire(provider: ProviderId, trafficClass: ProviderTrafficClass, invocation: ProviderAdmissionInvocation): Promise<ProviderAdmissionPermit | null> {
        assertInvocation(invocation);
        if (this.closing || this.closed) throw new ProviderAdmissionError("provider admission 已关闭", "ADMISSION_CLOSED");
        if (!isLiveMode(this.mode)) return await this.acquireBypass(provider, trafficClass, invocation);
        if (invocation.signal?.aborted) throw new ProviderAdmissionCancelledError(invocation.attemptId);

        const request: QueuedRequest = {
            sequence: this.nextSequence++,
            provider,
            trafficClass,
            invocation,
            lane: trafficClass === "foreground" ? "foreground" : "record",
            cancelled: false,
            granting: false,
            settled: false,
            resolve: () => undefined,
            reject: () => undefined,
        };
        const granted = await this.tryGrant(provider, request);
        if (!granted) {
            this.schedulePump(provider);
            return null;
        }

        const { lease } = granted;
        this.noteGrant(provider, request, request);
        request.granting = false;
        this.inFlightGrants.delete(request);
        if (request.cancelled || invocation.signal?.aborted) {
            const settled = await this.settlePermit(lease, { kind: "cancelled" });
            if (!settled) throw new ProviderAdmissionFencedError(`已取消 Attempt ${invocation.attemptId} 的 grant 无法耐久回收`);
            throw new ProviderAdmissionCancelledError(invocation.attemptId);
        }
        return this.createLivePermit(lease);
    }

    async run<Value>(provider: ProviderId, trafficClass: ProviderTrafficClass, invocation: ProviderAdmissionRunInvocation<Value>): Promise<Value> {
        const permit = await this.acquire(provider, trafficClass, invocation);
        try {
            const value = await invocation.execute(permit);
            if (!await permit.complete({ kind: "success" })) {
                throw new ProviderAdmissionFencedError(`Attempt ${invocation.attemptId} 在提交成功结果前已失去 owner fence`);
            }
            return value;
        } catch (error) {
            if (error instanceof ProviderAdmissionFencedError) throw error;
            await permit.complete(invocation.classifyError?.(error) ?? { kind: "unknown-outcome" });
            throw error;
        }
    }

    async wake(provider?: ProviderId): Promise<void> {
        if (!isLiveMode(this.mode) || this.closing || this.closed) return;
        if (provider) {
            await this.pump(provider);
            return;
        }
        await Promise.all((["grok", "agy"] as const).map(item => this.pump(item)));
    }

    async quiesce(): Promise<void> {
        while (true) {
            const controlTail = this.controlTail;
            const background = [...this.backgroundOperations];
            const pumps = (["grok", "agy"] as const)
                .map(provider => this.runtimes[provider].pumping)
                .filter((operation): operation is Promise<void> => operation !== null);
            const ownerOperation = this.ownerOperation;
            await Promise.all([
                controlTail,
                ...background,
                ...pumps,
                ...(ownerOperation ? [ownerOperation] : []),
            ]);
            if (controlTail === this.controlTail
                && this.backgroundOperations.size === 0
                && this.ownerOperation === null
                && (["grok", "agy"] as const).every(provider => this.runtimes[provider].pumping === null)) break;
        }
        if (this.backgroundErrors.length > 0) {
            const errors = this.backgroundErrors.splice(0);
            throw new AggregateError(errors, "provider admission 后台操作失败");
        }
    }

    async close(): Promise<void> {
        if (!this.closeOperation) this.closeOperation = this.closeExclusive();
        return await this.closeOperation;
    }

    async snapshot(provider: ProviderId): Promise<ProviderAdmissionSnapshot> {
        const runtime = this.runtimes[provider];
        if (!isLiveMode(this.mode)) {
            return {
                provider,
                mode: this.mode,
                queuedForeground: 0,
                queuedRecord: 0,
                active: 0,
                uncertain: 0,
                currentLimit: null,
                effectiveLimit: null,
                capacityGeneration: null,
                lossEpoch: null,
                frozen: null,
                breakerOpenUntilMs: null,
                shadowGrants: runtime.shadowGrants,
            };
        }
        if (this.mode === "test" && !this.closing && !this.closed) await this.withControlOperation(() => this.ensureOwner());
        const state = await this.readCurrentState();
        const pool = state.pools[provider];
        return {
            provider,
            mode: this.mode,
            queuedForeground: runtime.foreground.filter(item => !item.cancelled).length,
            queuedRecord: runtime.record.filter(item => !item.cancelled).length,
            active: pool.activeLeases.length,
            uncertain: pool.uncertainLeases.length,
            currentLimit: pool.currentLimit,
            effectiveLimit: limitFor(state, provider),
            capacityGeneration: pool.capacityGeneration,
            lossEpoch: pool.lossEpoch,
            frozen: pool.timeFrozen.frozen,
            breakerOpenUntilMs: pool.breaker.openUntilMs,
            shadowGrants: runtime.shadowGrants,
        };
    }

    async readControlState(): Promise<ProviderControlState | null> {
        if (!isLiveMode(this.mode)) return null;
        return structuredClone(await this.readCurrentState());
    }

    async recoverAttempt(provider: ProviderId, attemptId: string): Promise<ProviderAdmissionLeaseRecovery> {
        if (this.mode === "test" && !this.closing && !this.closed) {
            await this.withControlOperation(async () => {
                const current = await readProviderControlStore(this.storeOptions);
                if (current.kind === "repair-required" && current.repair.reason === "first_install_required") {
                    await initializeProviderControlStore({
                        ...this.storeOptions,
                        initialization: "exclusive-install",
                        nowMs: this.currentTime(),
                    });
                }
            });
        }
        return await readProviderLeaseByAttempt({ ...this.storeOptions, provider, attemptId });
    }

    async settleRecoveredLease(identity: ProviderLeaseIdentity): Promise<ProviderAdmissionRecoveredLeaseSettlement> {
        if (!isLiveMode(this.mode)) return { kind: "already-settled" };
        if (this.closed) throw new ProviderAdmissionFencedError("provider admission 已关闭，不能恢复 lease");
        return await this.withControlOperation(async () => {
            await this.ensureOwner();
            const result = await settleRecoveredProviderLease({
                ...this.storeOptions,
                ...this.requireOwnerFence(),
                identity,
                nowMs: this.currentTime(),
            });
            if (result.value.kind === "settled"
                && !await verifyProviderControlDurabilityReceipt(result.receipt, this.storeOptions)) {
                throw new ProviderAdmissionFencedError("recovered lease settlement receipt 已被其他 owner 取代");
            }
            if (result.value.kind === "settled") await this.pump(identity.provider);
            return result.value;
        });
    }

    async cancelRecoveredLease(identity: ProviderLeaseIdentity): Promise<ProviderAdmissionRecoveredLeaseSettlement> {
        return await this.settleRecoveredLease(identity);
    }

    async clearTimeFrozen(provider: ProviderId, evidence: string): Promise<ProviderAdmissionManualRecovery> {
        if (!isLiveMode(this.mode)) throw new ProviderAdmissionError("legacy/shadow 模式没有可清除的 live time_frozen", "NO_LIVE_CONTROL");
        if (this.closing || this.closed) throw new ProviderAdmissionError("provider admission 已关闭", "ADMISSION_CLOSED");
        if (!evidence.trim()) throw new ProviderAdmissionError("人工解冻必须带可审计证据", "MANUAL_RECOVERY_EVIDENCE_REQUIRED");
        const recovery = await this.withControlOperation(async () => {
            await this.ensureOwner();
            const fence = this.requireOwnerFence();
            const nowMs = this.currentTime();
            const result = await clearProviderTimeFrozen({
                ...this.storeOptions,
                ...fence,
                provider,
                explicitAcknowledgement: "manual-time-recovery",
                nowMs,
            });
            if (!await verifyProviderControlDurabilityReceipt(result.receipt, this.storeOptions)) {
                throw new ProviderAdmissionFencedError("人工解冻的 durability receipt 已不再是当前控制状态");
            }
            return { provider, evidence, recoveredAtMs: nowMs, receipt: result.receipt };
        });
        this.manualRecoveries.push(recovery);
        await this.pump(provider);
        return recovery;
    }

    manualRecoveryEvidence(): readonly ProviderAdmissionManualRecovery[] {
        return this.manualRecoveries.map(item => ({ ...item }));
    }

    private async acquireBypass(provider: ProviderId, trafficClass: ProviderTrafficClass, invocation: ProviderAdmissionInvocation): Promise<ProviderAdmissionPermit> {
        const runtime = this.runtimes[provider];
        if (this.mode === "shadow") runtime.shadowGrants += 1;
        return new BypassPermit(provider, trafficClass, invocation.attemptId);
    }

    private async pump(provider: ProviderId): Promise<void> {
        const runtime = this.runtimes[provider];
        if (runtime.pumping) {
            await runtime.pumping;
            if (!runtime.foreground.length && !runtime.record.length) return;
            return await this.pump(provider);
        }
        const operation = this.pumpExclusive(provider);
        runtime.pumping = operation;
        try {
            await operation;
        } finally {
            if (runtime.pumping === operation) runtime.pumping = null;
        }
    }

    private async pumpExclusive(provider: ProviderId): Promise<void> {
        const runtime = this.runtimes[provider];
        try {
            while (true) {
                this.discardCancelled(provider);
                if (!runtime.foreground.length && !runtime.record.length) return;
                const granted = await this.tryGrant(provider);
                if (!granted) return;
                const { request, lease } = granted;
                this.noteGrant(provider, request);
                this.removeQueuedRequest(request);
                if (request.cancelled) {
                    try {
                        const completed = await this.completeLease(lease, { kind: "cancelled" });
                        if (!completed) {
                            throw new ProviderAdmissionFencedError(`已取消 Attempt ${request.invocation.attemptId} 的 grant 无法耐久回收`);
                        }
                        this.rejectRequest(request, new ProviderAdmissionCancelledError(request.invocation.attemptId));
                    } catch (error) {
                        this.rejectRequest(request, normalizeAdmissionError(error));
                        throw error;
                    } finally {
                        request.granting = false;
                        this.inFlightGrants.delete(request);
                    }
                    continue;
                }
                request.removeAbortListener?.();
                request.granting = false;
                this.inFlightGrants.delete(request);
                this.resolveRequest(request, this.createLivePermit(lease));
            }
        } catch (error) {
            const normalized = normalizeAdmissionError(error);
            this.rejectAll(provider, normalized);
        }
    }

    private async tryGrant(provider: ProviderId, candidate?: QueuedRequest): Promise<{ request: QueuedRequest; lease: GrantedLease } | null> {
        return await this.withControlOperation(() => this.tryGrantExclusive(provider, candidate));
    }

    private async tryGrantExclusive(provider: ProviderId, candidate?: QueuedRequest): Promise<{ request: QueuedRequest; lease: GrantedLease } | null> {
        let selection: QueuedRequest | null = null;
        let grantLeaseStaged = false;
        try {
            await this.ensureOwner();
            let state = await this.readCurrentState();
            let nowMs = this.currentTime();
            if (nowMs < state.lastObservedWallClockMs) {
                await this.freezeForClockRollback(nowMs);
                return null;
            }
            const reclaimed = await reclaimExpiredProviderLeases({
                ...this.storeOptions,
                ...this.requireOwnerFence(),
                provider,
                nowMs,
            });
            if ((reclaimed.value.activeLeaseIds.length > 0 || reclaimed.value.uncertainLeaseIds.length > 0)
                && !await verifyProviderControlDurabilityReceipt(reclaimed.receipt, this.storeOptions)) {
                throw new ProviderAdmissionFencedError("expired provider lease reclaim receipt 已被其他 owner 取代");
            }
            state = reclaimed.state;
            selection = this.selectRequest(provider, state, candidate);
            if (!selection || candidate && selection !== candidate) return null;
            const request = selection;
            const pool = state.pools[provider];
            if (pool.timeFrozen.frozen) return null;
            if (pool.breaker.openUntilMs !== null && pool.breaker.openUntilMs > nowMs) {
                this.scheduleWake(provider, pool.breaker.openUntilMs - nowMs);
                return null;
            }
            if (pool.breaker.probeLease !== null) return null;
            if (occupiedSlots(pool) >= limitFor(state, provider)) return null;
            const leaseDurationMs = normalizeDuration(selection.invocation.leaseDurationMs, this.defaultLeaseDurationMs, "invocation.leaseDurationMs");
            if (leaseDurationMs > this.ownerLeaseDurationMs) {
                throw new ProviderAdmissionError("invocation leaseDurationMs 不能超过 ownerLeaseDurationMs", "INVALID_DURATION");
            }
            selection.granting = true;
            this.inFlightGrants.add(selection);
            await this.ensureOwner(leaseDurationMs);
            nowMs = this.currentTime();
            const fence = this.requireOwnerFence();
            const result = await mutateProviderControlAsOwner({
                ...this.storeOptions,
                ...fence,
                mutate: control => {
                    const current = control.pools[provider];
                    if (control.lastObservedWallClockMs > nowMs) throw new ProviderAdmissionFencedError("派发期间检测到时间倒退");
                    if (current.timeFrozen.frozen || current.breaker.probeLease !== null || (current.breaker.openUntilMs !== null && current.breaker.openUntilMs > nowMs)) {
                        if (candidate) return null;
                        throw new ProviderAdmissionError("provider 在 grant 持久化前变为不可派发", "ADMISSION_BLOCKED");
                    }
                    if (occupiedSlots(current) >= limitFor(control, provider)) {
                        if (candidate) return null;
                        throw new ProviderAdmissionError("provider 物理槽已满", "ADMISSION_BLOCKED");
                    }
                    const matchingAttempts = [
                        ...current.activeLeases.filter(lease => lease.attemptId === request.invocation.attemptId),
                        ...current.uncertainLeases.filter(lease => lease.attemptId === request.invocation.attemptId),
                    ];
                    if (matchingAttempts.length > 0) {
                        throw new ProviderAdmissionError(
                            `Attempt ${request.invocation.attemptId} 已存在 provider lease，拒绝重复 grant`,
                            "ATTEMPT_ALREADY_LEASED",
                        );
                    }
                    const lease: ProviderLease = {
                        leaseId: crypto.randomUUID(),
                        attemptId: request.invocation.attemptId,
                        provider,
                        trafficClass: request.trafficClass,
                        ownerEpoch: fence.ownerEpoch,
                        capacityGeneration: current.capacityGeneration,
                        acquiredAtMs: nowMs,
                        expiresAtMs: nowMs + leaseDurationMs,
                    };
                    grantLeaseStaged = true;
                    current.activeLeases.push(lease);
                    if (provider === "agy") addAgyAdmissionLease(control, lease);
                    const isProbe = current.breaker.openUntilMs !== null && current.breaker.openUntilMs <= nowMs;
                    if (isProbe) {
                        current.breaker.probeLease = {
                            leaseId: lease.leaseId,
                            attemptId: lease.attemptId,
                            ownerEpoch: lease.ownerEpoch,
                            capacityGeneration: lease.capacityGeneration,
                            acquiredAtMs: lease.acquiredAtMs,
                            expiresAtMs: lease.expiresAtMs,
                        };
                    }
                    control.lastObservedWallClockMs = Math.max(control.lastObservedWallClockMs, nowMs);
                    return { lease, probe: isProbe };
                },
            });
            const granted = result.value;
            if (granted === null) {
                selection.granting = false;
                this.inFlightGrants.delete(selection);
                return null;
            }
            if (!await verifyProviderControlDurabilityReceipt(result.receipt, this.storeOptions)) {
                throw new ProviderAdmissionFencedError("grant durability receipt 已被更新的控制状态取代");
            }
            state = result.state;
            if (!state.pools[provider].activeLeases.some(lease => lease.leaseId === granted.lease.leaseId)) {
                throw new ProviderAdmissionFencedError("持久化 grant 未包含已申请的 lease");
            }
            return { request: selection, lease: { lease: granted.lease, receipt: result.receipt, probe: granted.probe } };
        } catch (error) {
            if (selection) {
                selection.granting = false;
                this.inFlightGrants.delete(selection);
            }
            let normalized = normalizeAdmissionError(error);
            if (selection && grantLeaseStaged) {
                try {
                    await this.reconcileGrantMutationFailure(provider, selection.invocation.attemptId);
                } catch (recoveryError) {
                    normalized = normalizeAdmissionError(recoveryError);
                }
            }
            if (candidate && isTemporaryOwnerFenceError(error) && !(normalized instanceof ProviderAdmissionRepairRequiredError)) return null;
            if (selection) this.rejectRequest(selection, normalized);
            throw normalized;
        }
    }

    private async reconcileGrantMutationFailure(provider: ProviderId, attemptId: string): Promise<"absent" | "settled"> {
        const recovered = await readProviderLeaseByAttempt({ ...this.storeOptions, provider, attemptId });
        if (recovered.kind === "absent") return "absent";
        if (recovered.kind !== "active") {
            throw new ProviderAdmissionRepairRequiredError(
                `Attempt ${attemptId} grant 失败后的 provider lease 状态为 ${recovered.kind}${recovered.kind === "corrupt" ? `：${recovered.detail}` : ""}`,
            );
        }
        let settlementError: unknown;
        try {
            await this.ensureOwner();
            const result = await settleRecoveredProviderLease({
                ...this.storeOptions,
                ...this.requireOwnerFence(),
                identity: recovered.identity,
                nowMs: this.currentTime(),
            });
            if (result.value.kind === "settled"
                && !await verifyProviderControlDurabilityReceipt(result.receipt, this.storeOptions)) {
                throw new ProviderAdmissionFencedError("grant 失败后的 recovered lease 清理 receipt 已被其他 owner 取代");
            }
        } catch (error) {
            settlementError = error;
        }
        const finalState = await readProviderLeaseByAttempt({ ...this.storeOptions, provider, attemptId });
        if (finalState.kind === "absent") return "settled";
        throw new ProviderAdmissionRepairRequiredError(
            `Attempt ${attemptId} grant 结果不确定且 lease 无法确认回收：${settlementError instanceof Error ? settlementError.message : String(settlementError || finalState.kind)}`,
        );
    }

    private selectRequest(provider: ProviderId, state: ProviderControlState, candidate?: QueuedRequest): QueuedRequest | null {
        const runtime = this.runtimes[provider];
        const foreground = runtime.foreground[0] ?? (candidate?.lane === "foreground" && !candidate.cancelled ? candidate : null);
        const records = candidate?.lane === "record" && !candidate.cancelled ? [...runtime.record, candidate] : runtime.record;
        const record = provider === "agy" ? selectAgyRecord(records, state) : records[0] ?? null;
        if (!foreground) return record;
        if (!record) return foreground;
        return runtime.foregroundStreak >= 2 ? record : foreground;
    }

    private noteGrant(provider: ProviderId, request: QueuedRequest, candidate?: QueuedRequest): void {
        const runtime = this.runtimes[provider];
        const foregroundQueued = runtime.foreground.some(item => !item.cancelled) || candidate?.lane === "foreground" && !candidate.cancelled;
        const recordQueued = runtime.record.some(item => !item.cancelled) || candidate?.lane === "record" && !candidate.cancelled;
        const bothQueued = foregroundQueued && recordQueued;
        if (request.lane === "record") {
            runtime.foregroundStreak = 0;
            return;
        }
        runtime.foregroundStreak = bothQueued ? runtime.foregroundStreak + 1 : 0;
    }

    private createLivePermit(lease: GrantedLease): ProviderAdmissionPermit {
        return new LivePermit(
            lease.lease,
            lease.receipt,
            lease.probe,
            outcome => this.settlePermit(lease, outcome),
            () => this.assertLeaseCurrent(lease.lease),
        );
    }

    private async completeLease(granted: GrantedLease, outcome: ProviderAdmissionOutcome): Promise<boolean> {
        if (!isLiveMode(this.mode)) return true;
        if (this.closed) return false;
        return await this.withControlOperation(() => this.completeLeaseExclusive(granted, outcome));
    }

    private async completeLeaseExclusive(granted: GrantedLease, outcome: ProviderAdmissionOutcome): Promise<boolean> {
        try {
            await this.ensureOwner();
            const nowMs = this.currentTime();
            const fence = this.requireOwnerFence();
            const result = await mutateProviderControlAsOwner({
                ...this.storeOptions,
                ...fence,
                mutate: state => {
                    const pool = state.pools[granted.lease.provider];
                    const identity = providerLeaseIdentity(granted.lease);
                    const index = pool.activeLeases.findIndex(item => matchesProviderLeaseIdentity(item, identity));
                    if (index < 0) return false;
                    const lease = pool.activeLeases[index];
                    pool.activeLeases.splice(index, 1);
                    if (lease.provider === "agy") removeAgyAdmissionLease(state, lease.leaseId);
                    const isProbe = pool.breaker.probeLease?.leaseId === lease.leaseId;
                    if (outcome.kind === "unknown-outcome") {
                        pool.uncertainLeases.push({
                            ...lease,
                            unknownOutcomeAtMs: nowMs,
                            graceExpiresAtMs: nowMs + this.uncertainGraceMs,
                        });
                    } else if (outcome.kind === "success") {
                        if (!pool.timeFrozen.frozen && lease.capacityGeneration === pool.capacityGeneration) {
                            pool.successCredits += 1;
                            if (pool.successCredits >= pool.currentLimit && pool.currentLimit < pool.physicalMax) {
                                pool.currentLimit += 1;
                                pool.capacityGeneration += 1;
                                pool.successCredits = 0;
                            }
                        }
                        if (isProbe) {
                            pool.breaker.openUntilMs = null;
                            pool.breaker.retryAfterMs = null;
                            pool.breaker.consecutiveFailures = 0;
                            pool.breaker.backoffExponent = 0;
                        }
                        pool.breaker.probeLease = null;
                    } else if (outcome.kind === "congestion") {
                        applyCongestion(pool, lease, nowMs);
                        applyRetryAfter(pool, outcome.retryAfterMs, nowMs);
                        if (isProbe) openBreaker(pool, nowMs, lease, outcome.retryAfterMs);
                        pool.breaker.probeLease = null;
                    } else if (outcome.kind === "availability") {
                        openBreaker(pool, nowMs, lease, outcome.retryAfterMs);
                        pool.breaker.probeLease = null;
                    } else if (isProbe) {
                        openBreaker(pool, nowMs, lease, outcome.retryAfterMs);
                        pool.breaker.probeLease = null;
                    }
                    state.lastObservedWallClockMs = Math.max(state.lastObservedWallClockMs, nowMs);
                    refreshCapacityFrozen(state, lease.provider, nowMs);
                    return true;
                },
            });
            if (!result.value) return false;
            return await verifyProviderControlDurabilityReceipt(result.receipt, this.storeOptions);
        } catch (error) {
            if (error instanceof ProviderControlFencedError || error instanceof ProviderAdmissionFencedError) return false;
            throw error;
        }
    }

    private async settlePermit(granted: GrantedLease, outcome: ProviderAdmissionOutcome): Promise<boolean> {
        try {
            return await this.completeLease(granted, outcome);
        } finally {
            await this.pump(granted.lease.provider);
        }
    }

    private async assertLeaseCurrent(lease: ProviderLease): Promise<void> {
        if (!isLiveMode(this.mode)) return;
        await this.withControlOperation(async () => {
            await this.ensureOwner();
            const state = await this.readCurrentState();
            const owner = this.ownerFence;
            if (!owner || state.ownerEpoch !== owner.ownerEpoch || state.ownerLease?.leaseId !== owner.ownerLeaseId) {
                throw new ProviderAdmissionFencedError(`Attempt ${lease.attemptId} 的 provider owner fence 已推进`);
            }
            const pool = state.pools[lease.provider];
            const active = pool.activeLeases.find(item => matchesProviderLeaseIdentity(item, providerLeaseIdentity(lease)));
            if (!active || active.expiresAtMs <= this.currentTime()
                || pool.breaker.probeLease?.leaseId === lease.leaseId && pool.breaker.probeLease.ownerEpoch !== lease.ownerEpoch) {
                throw new ProviderAdmissionFencedError(`Attempt ${lease.attemptId} 的 lease 已不可提交`);
            }
        });
    }

    private async ensureOwner(minimumValidityMs = 0): Promise<void> {
        if (!isLiveMode(this.mode)) return;
        if (minimumValidityMs > this.ownerLeaseDurationMs) {
            throw new ProviderAdmissionError("owner lease 无法覆盖请求的最小有效期", "INVALID_DURATION");
        }
        const requiredValidityMs = Math.max(this.ownerRenewalWindowMs, minimumValidityMs);
        if (this.ownerOperation) {
            await this.ownerOperation;
            if (this.ownerFence && this.ownerLeaseExpiresAtMs !== null
                && this.ownerLeaseExpiresAtMs - this.currentTime() < requiredValidityMs) {
                return await this.ensureOwner(minimumValidityMs);
            }
            return;
        }
        const operation = this.ensureOwnerExclusive(requiredValidityMs);
        this.ownerOperation = operation;
        try {
            await operation;
        } finally {
            if (this.ownerOperation === operation) this.ownerOperation = null;
        }
    }

    private async ensureOwnerExclusive(requiredValidityMs: number): Promise<void> {
        const nowMs = this.currentTime();
        if (this.ownerFence) {
            if (this.ownerLeaseExpiresAtMs === null) throw new ProviderAdmissionFencedError("provider owner 本地 lease expiry 缺失");
            if (this.ownerLeaseExpiresAtMs - nowMs >= requiredValidityMs) return;
            let renewed: Awaited<ReturnType<typeof renewProviderControlOwner>>;
            try {
                renewed = await renewProviderControlOwner({
                    ...this.storeOptions,
                    ...this.ownerFence,
                    leaseDurationMs: this.ownerLeaseDurationMs,
                    nowMs,
                });
            } catch (error) {
                if (error instanceof ProviderControlFencedError) {
                    throw new ProviderAdmissionFencedError(`provider owner 续租被 fence：${error.message}`);
                }
                throw error;
            }
            if (!await verifyProviderControlDurabilityReceipt(renewed.receipt, { ...this.storeOptions, nowMs })) {
                throw new ProviderAdmissionFencedError("owner renew receipt 已被其他 owner 取代");
            }
            if (renewed.state.ownerEpoch !== this.ownerFence.ownerEpoch
                || renewed.value.leaseId !== this.ownerFence.ownerLeaseId
                || renewed.value.expiresAtMs <= nowMs) {
                throw new ProviderAdmissionFencedError("owner renew 回读的 fence/expiry 不一致");
            }
            this.ownerLeaseExpiresAtMs = renewed.value.expiresAtMs;
            return;
        }
        let current = await readProviderControlStore(this.storeOptions);
        if (current.kind === "repair-required") {
            if (this.mode !== "test" || current.repair.reason !== "first_install_required") {
                throw new ProviderAdmissionRepairRequiredError(`provider control dispatchBlocked：${current.repair.reason}`);
            }
            current = await initializeProviderControlStore({
                ...this.storeOptions,
                initialization: "exclusive-install",
                nowMs,
            });
        }
        const owner = await claimProviderControlOwner({
            ...this.storeOptions,
            ownerId: this.ownerId,
            leaseDurationMs: this.ownerLeaseDurationMs,
            nowMs,
        });
        this.ownerFence = { ownerEpoch: owner.state.ownerEpoch, ownerLeaseId: owner.value.leaseId };
        this.ownerLeaseExpiresAtMs = owner.value.expiresAtMs;
        if (!await verifyProviderControlDurabilityReceipt(owner.receipt, { ...this.storeOptions, nowMs })) {
            this.ownerFence = null;
            this.ownerLeaseExpiresAtMs = null;
            throw new ProviderAdmissionFencedError("owner claim receipt 已被其他 owner 取代");
        }
        await this.reconcileLeasesAfterFence();
    }

    private async reconcileLeasesAfterFence(): Promise<void> {
        const nowMs = this.currentTime();
        const fence = this.requireOwnerFence();
        const result = await reclaimExpiredProviderLeases({
            ...this.storeOptions,
            ...fence,
            nowMs,
        });
        if ((result.value.activeLeaseIds.length > 0 || result.value.uncertainLeaseIds.length > 0)
            && !await verifyProviderControlDurabilityReceipt(result.receipt, this.storeOptions)) {
            throw new ProviderAdmissionFencedError("lease 恢复 receipt 已被其他 owner 取代");
        }
    }

    private async freezeForClockRollback(nowMs: number): Promise<void> {
        const fence = this.requireOwnerFence();
        const result = await mutateProviderControlAsOwner({
            ...this.storeOptions,
            ...fence,
            mutate: state => {
                if (nowMs >= state.lastObservedWallClockMs) return;
                for (const provider of ["grok", "agy"] as const) {
                    const pool = state.pools[provider];
                    pool.timeFrozen = {
                        frozen: true,
                        reason: "clock_non_monotonic",
                        enteredAtMs: state.lastObservedWallClockMs,
                        requiresManualClear: true,
                        frozenFailureAttemptIds: pool.timeFrozen.frozenFailureAttemptIds,
                    };
                }
            },
        });
        if (!await verifyProviderControlDurabilityReceipt(result.receipt, this.storeOptions)) {
            throw new ProviderAdmissionFencedError("time_frozen receipt 已被其他 owner 取代");
        }
    }

    private async readCurrentState(): Promise<ProviderControlState> {
        const current = await readProviderControlStore(this.storeOptions);
        if (current.kind === "repair-required") throw new ProviderAdmissionRepairRequiredError(`provider control dispatchBlocked：${current.repair.reason}`);
        return current.state;
    }

    private requireOwnerFence(): ProviderControlOwnerFence {
        if (!this.ownerFence) throw new ProviderAdmissionFencedError("provider owner 尚未取得");
        return this.ownerFence;
    }

    private currentTime(): number {
        const value = this.now();
        if (!Number.isSafeInteger(value) || value < 0) throw new ProviderAdmissionError("admission clock 必须返回非负安全整数毫秒", "INVALID_CLOCK");
        return value;
    }

    private cancelQueuedRequest(request: QueuedRequest): void {
        if (request.cancelled) return;
        request.cancelled = true;
        this.removeQueuedRequest(request);
        if (!request.granting) this.rejectRequest(request, new ProviderAdmissionCancelledError(request.invocation.attemptId));
        this.schedulePump(request.provider);
    }

    private removeQueuedRequest(request: QueuedRequest): void {
        const queue = request.lane === "foreground" ? this.runtimes[request.provider].foreground : this.runtimes[request.provider].record;
        const index = queue.indexOf(request);
        if (index >= 0) queue.splice(index, 1);
        request.removeAbortListener?.();
        request.removeAbortListener = undefined;
    }

    private discardCancelled(provider: ProviderId): void {
        const runtime = this.runtimes[provider];
        for (const request of [...runtime.foreground, ...runtime.record]) {
            if (!request.cancelled) continue;
            this.rejectRequest(request, new ProviderAdmissionCancelledError(request.invocation.attemptId));
        }
    }

    private rejectAll(provider: ProviderId, error: Error): void {
        const runtime = this.runtimes[provider];
        for (const request of [...runtime.foreground, ...runtime.record]) {
            this.rejectRequest(request, error);
        }
    }

    private resolveRequest(request: QueuedRequest, permit: ProviderAdmissionPermit): void {
        if (request.settled) return;
        request.settled = true;
        this.removeQueuedRequest(request);
        request.resolve(permit);
    }

    private rejectRequest(request: QueuedRequest, error: Error): void {
        if (request.settled) return;
        request.settled = true;
        this.removeQueuedRequest(request);
        request.reject(error);
    }

    private schedulePump(provider: ProviderId): void {
        if (this.closed) return;
        const operation = this.pump(provider);
        let tracked!: Promise<void>;
        tracked = operation.then(
            () => { this.backgroundOperations.delete(tracked); },
            error => {
                this.backgroundOperations.delete(tracked);
                this.backgroundErrors.push(error);
            },
        );
        this.backgroundOperations.add(tracked);
    }

    private scheduleWake(provider: ProviderId, delayMs: number): void {
        const runtime = this.runtimes[provider];
        if (this.closing || this.closed || runtime.wakeTimer) return;
        runtime.wakeTimer = setTimeout(() => {
            runtime.wakeTimer = null;
            this.schedulePump(provider);
        }, Math.max(1, Math.min(delayMs, MAX_BREAKER_OPEN_MS)));
        runtime.wakeTimer.unref?.();
    }

    private async withControlOperation<Value>(operation: () => Promise<Value>): Promise<Value> {
        const previous = this.controlTail;
        let release!: () => void;
        const current = new Promise<void>(resolve => { release = resolve; });
        this.controlTail = previous.then(() => current, () => current);
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }

    private async closeExclusive(): Promise<void> {
        this.closing = true;
        try {
            for (const provider of ["grok", "agy"] as const) {
                const runtime = this.runtimes[provider];
                if (runtime.wakeTimer) {
                    clearTimeout(runtime.wakeTimer);
                    runtime.wakeTimer = null;
                }
                for (const request of [...runtime.foreground, ...runtime.record]) this.cancelQueuedRequest(request);
            }
            for (const request of [...this.inFlightGrants]) this.cancelQueuedRequest(request);
            await this.quiesce();
        } finally {
            for (const provider of ["grok", "agy"] as const) {
                const runtime = this.runtimes[provider];
                if (runtime.wakeTimer) clearTimeout(runtime.wakeTimer);
                runtime.wakeTimer = null;
            }
            this.closed = true;
            this.closing = false;
        }
    }
}

class LivePermit implements ProviderAdmissionPermit {
    readonly provider: ProviderId;
    readonly trafficClass: ProviderTrafficClass;
    readonly attemptId: string;
    readonly leaseId: string;
    readonly ownerEpoch: number;
    readonly capacityGeneration: number;
    readonly leaseIdentity: ProviderLeaseIdentity;
    readonly receipt: ProviderControlDurabilityReceipt;
    readonly probe: boolean;
    private completion: Promise<boolean> | null = null;

    constructor(
        private readonly granted: ProviderLease,
        receipt: ProviderControlDurabilityReceipt,
        probe: boolean,
        private readonly settle: (outcome: ProviderAdmissionOutcome) => Promise<boolean>,
        private readonly checkCurrent: () => Promise<void>,
    ) {
        this.provider = granted.provider;
        this.trafficClass = granted.trafficClass;
        this.attemptId = granted.attemptId;
        this.leaseId = granted.leaseId;
        this.ownerEpoch = granted.ownerEpoch;
        this.capacityGeneration = granted.capacityGeneration;
        this.leaseIdentity = providerLeaseIdentity(granted);
        this.receipt = receipt;
        this.probe = probe;
    }

    complete(outcome: ProviderAdmissionOutcome = { kind: "success" }): Promise<boolean> {
        if (!this.completion) this.completion = this.settle(outcome);
        return this.completion;
    }

    markUnknownOutcome(): Promise<boolean> {
        return this.complete({ kind: "unknown-outcome" });
    }

    release(): Promise<boolean> {
        return this.complete({ kind: "cancelled" });
    }

    assertCurrent(): Promise<void> {
        return this.checkCurrent();
    }
}

class BypassPermit implements ProviderAdmissionPermit {
    readonly leaseId = `bypass-${crypto.randomUUID()}`;
    readonly ownerEpoch = null;
    readonly capacityGeneration = null;
    readonly leaseIdentity = null;
    readonly receipt = null;
    readonly probe = false;

    constructor(
        readonly provider: ProviderId,
        readonly trafficClass: ProviderTrafficClass,
        readonly attemptId: string,
    ) {}

    async complete(): Promise<boolean> { return true; }
    async markUnknownOutcome(): Promise<boolean> { return true; }
    async release(): Promise<boolean> { return true; }
    async assertCurrent(): Promise<void> {}
}

export function createProviderAdmission(options: ProviderAdmissionOptions = {}): ProviderAdmission {
    return new ProviderAdmission(options);
}

function createRuntime(): ProviderRuntime {
    return { foreground: [], record: [], foregroundStreak: 0, pumping: null, wakeTimer: null, shadowGrants: 0 };
}

function isLiveMode(mode: ProviderAdmissionMode): boolean {
    return mode === "test" || mode === "enforced";
}

function assertInvocation(invocation: ProviderAdmissionInvocation): void {
    if (!invocation.attemptId || typeof invocation.attemptId !== "string") throw new ProviderAdmissionError("provider admission invocation 必须带 attemptId", "ATTEMPT_ID_REQUIRED");
}

function normalizeDuration(value: number | undefined, fallback: number, name: string): number {
    const result = value ?? fallback;
    if (!Number.isSafeInteger(result) || result <= 0 || result > MAX_BREAKER_OPEN_MS) throw new ProviderAdmissionError(`${name} 必须是 1..${MAX_BREAKER_OPEN_MS} 的安全整数`, "INVALID_DURATION");
    return result;
}

function normalizeRetryAfter(value: number | undefined): number | null {
    if (value === undefined) return null;
    if (!Number.isSafeInteger(value) || value < 0) throw new ProviderAdmissionError("retryAfterMs 必须为非负安全整数", "INVALID_RETRY_AFTER");
    return Math.min(value, MAX_BREAKER_OPEN_MS);
}

function limitFor(state: ProviderControlState, provider: ProviderId): number {
    return provider === "agy" ? effectiveAgyLimit(state) : state.pools[provider].currentLimit;
}

function occupiedSlots(pool: ProviderControlState["pools"][ProviderId]): number {
    return pool.activeLeases.length + pool.uncertainLeases.length;
}

function selectAgyRecord(records: QueuedRequest[], state: ProviderControlState): QueuedRequest | null {
    const first = records.find(item => item.trafficClass === "agy-first-run-overflow") ?? null;
    const fallback = records.find(item => item.trafficClass === "agy-fallback") ?? null;
    const generic = records.find(item => item.trafficClass === "record") ?? null;
    if (!first && !fallback) return generic;
    if (!first) return fallback;
    if (!fallback) return first;
    const admission = state.agy.admission;
    const firstCount = admission.firstRunOverflowLeaseIds.length;
    const fallbackCount = admission.fallbackLeaseIds.length;
    if (firstCount < admission.firstRunOverflowGuarantee && fallbackCount >= admission.fallbackGuarantee) return first;
    if (fallbackCount < admission.fallbackGuarantee && firstCount >= admission.firstRunOverflowGuarantee) return fallback;
    return first.sequence <= fallback.sequence ? first : fallback;
}

function addAgyAdmissionLease(state: ProviderControlState, lease: ProviderLease): void {
    if (lease.trafficClass === "agy-first-run-overflow") state.agy.admission.firstRunOverflowLeaseIds.push(lease.leaseId);
    if (lease.trafficClass === "agy-fallback") state.agy.admission.fallbackLeaseIds.push(lease.leaseId);
}

function removeAgyAdmissionLease(state: ProviderControlState, leaseId: string): void {
    state.agy.admission.firstRunOverflowLeaseIds = state.agy.admission.firstRunOverflowLeaseIds.filter(item => item !== leaseId);
    state.agy.admission.fallbackLeaseIds = state.agy.admission.fallbackLeaseIds.filter(item => item !== leaseId);
}

function rebuildAgyAdmissionState(state: ProviderControlState): void {
    state.agy.admission.firstRunOverflowLeaseIds = state.pools.agy.activeLeases
        .filter(lease => lease.trafficClass === "agy-first-run-overflow")
        .map(lease => lease.leaseId);
    state.agy.admission.fallbackLeaseIds = state.pools.agy.activeLeases
        .filter(lease => lease.trafficClass === "agy-fallback")
        .map(lease => lease.leaseId);
}

function applyCongestion(pool: ProviderControlState["pools"][ProviderId], lease: ProviderLease, nowMs: number): void {
    if (lease.capacityGeneration !== pool.capacityGeneration) return;
    const lostGeneration = pool.capacityGeneration;
    pool.currentLimit = Math.max(1, Math.floor(pool.currentLimit / 2));
    pool.capacityGeneration += 1;
    pool.lossEpoch += 1;
    pool.lastLoss = {
        lossEpoch: pool.lossEpoch,
        lostCapacityGeneration: lostGeneration,
        attemptId: lease.attemptId,
        recordedAtMs: nowMs,
    };
    pool.successCredits = 0;
}

function applyRetryAfter(pool: ProviderControlState["pools"][ProviderId], retryAfterMs: number | undefined, nowMs: number): void {
    const delay = normalizeRetryAfter(retryAfterMs);
    if (delay === null) return;
    pool.breaker.retryAfterMs = delay;
    pool.breaker.openUntilMs = Math.max(pool.breaker.openUntilMs ?? 0, nowMs + delay);
}

function openBreaker(pool: ProviderControlState["pools"][ProviderId], nowMs: number, lease: ProviderLease, retryAfterMs: number | undefined): void {
    const retryAfter = normalizeRetryAfter(retryAfterMs);
    pool.breaker.consecutiveFailures += 1;
    const budgetIndex = Math.min(pool.breaker.backoffExponent, BREAKER_FAILURE_BUDGETS.length - 1);
    pool.breaker.failureBudget = BREAKER_FAILURE_BUDGETS[budgetIndex];
    const needsOpen = retryAfter !== null || pool.breaker.consecutiveFailures >= pool.breaker.failureBudget;
    if (!needsOpen) return;
    const elapsedMs = Math.max(1, nowMs - lease.acquiredAtMs);
    const exponentialMs = Math.min(MAX_BREAKER_OPEN_MS, 5 * elapsedMs * (2 ** pool.breaker.backoffExponent));
    const delayMs = retryAfter ?? exponentialMs;
    if (retryAfter !== null) pool.breaker.retryAfterMs = retryAfter;
    pool.breaker.openUntilMs = Math.max(pool.breaker.openUntilMs ?? 0, nowMs + delayMs);
    pool.breaker.backoffExponent = Math.min(pool.breaker.backoffExponent + 1, BREAKER_FAILURE_BUDGETS.length - 1);
    pool.breaker.consecutiveFailures = 0;
}

function refreshCapacityFrozen(state: ProviderControlState, provider: ProviderId, nowMs: number): void {
    const pool = state.pools[provider];
    if (pool.timeFrozen.reason === "clock_non_monotonic") return;
    if (occupiedSlots(pool) > limitFor(state, provider)) {
        pool.timeFrozen = {
            frozen: true,
            reason: "capacity",
            enteredAtMs: pool.timeFrozen.enteredAtMs ?? nowMs,
            requiresManualClear: false,
            frozenFailureAttemptIds: pool.timeFrozen.frozenFailureAttemptIds,
        };
        return;
    }
    if (pool.timeFrozen.reason === "capacity") {
        pool.timeFrozen = {
            frozen: false,
            reason: null,
            enteredAtMs: null,
            requiresManualClear: false,
            frozenFailureAttemptIds: [],
        };
    }
}

function normalizeAdmissionError(error: unknown): Error {
    if (error instanceof Error) return error;
    return new ProviderAdmissionError(String(error), "ADMISSION_FAILURE");
}

function isTemporaryOwnerFenceError(error: unknown): boolean {
    return error instanceof ProviderControlFencedError || error instanceof ProviderAdmissionFencedError;
}
