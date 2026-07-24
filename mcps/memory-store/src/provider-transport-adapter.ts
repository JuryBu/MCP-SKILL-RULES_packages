import crypto from "node:crypto";
import {
    createProviderAdmission,
    ProviderAdmissionFencedError,
    type ProviderAdmission,
    type ProviderAdmissionLeaseRecovery,
    type ProviderAdmissionMode,
    type ProviderAdmissionOutcome,
    type ProviderAdmissionPermit,
    type ProviderAdmissionRecoveredLeaseSettlement,
    type ProviderAdmissionSnapshot,
} from "./provider-admission.js";
import type { ProviderId, ProviderLeaseIdentity, ProviderTrafficClass } from "./provider-control-contracts.js";

export type ProviderTransportSettlementKind = "success" | "congestion" | "availability" | "rate-limit" | "unknown" | "local-resource" | "cancelled";

export interface ProviderTransportMetadata {
    trafficClass?: ProviderTrafficClass;
    signal?: AbortSignal;
    probe?: boolean;
    attemptId?: string;
}

export interface ProviderTransportLease {
    readonly provider: ProviderId;
    readonly trafficClass: ProviderTrafficClass;
    readonly attemptId: string;
    readonly permitId: string;
    readonly probe: boolean;
    readonly identity: ProviderLeaseIdentity | null;
}

export type ProviderTransportLeaseRecovery = ProviderAdmissionLeaseRecovery;
export type ProviderTransportRecoveredLeaseSettlement = ProviderAdmissionRecoveredLeaseSettlement;

export interface ProviderTransportAdapterOptions {
    mode?: ProviderAdmissionMode;
    dataRoot?: string;
    ownerId?: string;
    admission?: ProviderTransportAdmission;
}

type ProviderTransportAdmission = Pick<ProviderAdmission, "acquire" | "snapshot">
    & Partial<Pick<ProviderAdmission, "tryAcquire" | "quiesce" | "close" | "recoverAttempt" | "settleRecoveredLease" | "cancelRecoveredLease">>;

export interface ProviderTransportAdapterDiagnostics {
    mode: "shadow" | "test" | "enforced";
    acquireCount: number;
    settleCount: number;
    settleFailureCount: number;
    attempts: readonly {
        provider: ProviderId;
        trafficClass: ProviderTrafficClass;
        attemptId: string;
        permitId: string;
        probe: boolean;
        settlement: ProviderTransportSettlementKind;
        permitSettled: boolean;
        settlementError?: string;
    }[];
}

export interface ProviderTransportAvailabilityEvent {
    provider: ProviderId;
    trafficClass: ProviderTrafficClass;
    attemptId: string;
    permitId: string;
    settlement: ProviderTransportSettlementKind;
    recovered: boolean;
}

export type ProviderTransportAvailabilityListener = (event: ProviderTransportAvailabilityEvent) => void | Promise<void>;

export function mapProviderTrafficClass(value?: ProviderTrafficClass | "record-batch"): ProviderTrafficClass {
    if (value === "record" || value === "record-batch") return "record";
    return value || "foreground";
}

export class ProviderTransportAdapter {
    private readonly admission: ProviderTransportAdmission;
    private readonly mode: "shadow" | "test" | "enforced";
    private readonly inFlight = new Set<Promise<unknown>>();
    private closed = false;
    private closeOperation: Promise<void> | null = null;
    private nextAttempt = 1;
    private acquireCount = 0;
    private settleCount = 0;
    private settleFailureCount = 0;
    private readonly leases = new WeakMap<ProviderTransportLease, ProviderTransportLeaseState>();
    private readonly outstandingLeases = new Set<ProviderTransportLeaseState>();
    private readonly availabilityListeners = new Set<ProviderTransportAvailabilityListener>();
    private readonly attempts: {
        provider: ProviderId;
        trafficClass: ProviderTrafficClass;
        attemptId: string;
        permitId: string;
        probe: boolean;
        settlement: ProviderTransportSettlementKind;
        permitSettled: boolean;
        settlementError?: string;
    }[] = [];

    constructor(options: ProviderTransportAdapterOptions = {}) {
        const mode = options.mode || "enforced";
        if (mode !== "shadow" && mode !== "test" && mode !== "enforced") {
            throw new Error(`provider transport 不支持 admission mode=${mode}`);
        }
        if (mode === "test" && !options.dataRoot && !options.admission) {
            throw new Error("provider transport test 模式必须提供临时 dataRoot");
        }
        this.mode = mode;
        this.admission = options.admission || createProviderAdmission({
            mode,
            dataRoot: options.dataRoot,
            ownerId: options.ownerId,
        });
    }

    execute<Value>(
        provider: ProviderId,
        metadata: ProviderTransportMetadata,
        execute: () => Promise<Value>,
        classifyResult: (value: Value) => ProviderTransportSettlementKind,
        classifyError: (error: unknown) => ProviderTransportSettlementKind = () => "unknown",
    ): Promise<Value> {
        if (this.closed) return Promise.reject(new Error("provider transport adapter 已关闭"));
        const shadowExecution = this.mode === "shadow" ? startExecution(execute) : null;
        return this.track((async () => {
            const lease = await this.acquire(provider, metadata);
            return await this.executeGranted(
                lease,
                () => shadowExecution || startExecution(execute),
                classifyResult,
                classifyError,
            );
        })());
    }

    acquire(provider: ProviderId, metadata: ProviderTransportMetadata = {}): Promise<ProviderTransportLease> {
        if (this.closed) return Promise.reject(new Error("provider transport adapter 已关闭"));
        return this.track(this.acquireLease(provider, metadata));
    }

    tryAcquire(provider: ProviderId, metadata: ProviderTransportMetadata = {}): Promise<ProviderTransportLease | null> {
        if (this.closed) return Promise.reject(new Error("provider transport adapter 已关闭"));
        return this.track(this.tryAcquireLease(provider, metadata));
    }

    subscribeAvailability(listener: ProviderTransportAvailabilityListener): () => void {
        this.availabilityListeners.add(listener);
        let subscribed = true;
        return () => {
            if (!subscribed) return;
            subscribed = false;
            this.availabilityListeners.delete(listener);
        };
    }

    executeGranted<Value>(
        lease: ProviderTransportLease,
        execute: () => Promise<Value>,
        classifyResult: (value: Value) => ProviderTransportSettlementKind,
        classifyError: (error: unknown) => ProviderTransportSettlementKind = () => "unknown",
    ): Promise<Value> {
        if (this.closed) return Promise.reject(new Error("provider transport adapter 已关闭"));
        let state: ProviderTransportLeaseState;
        try {
            state = this.consumeLease(lease);
        } catch (error) {
            return Promise.reject(error);
        }
        return this.track((async () => {
            try {
                await state.permit.assertCurrent();
            } catch (error) {
                this.outstandingLeases.delete(state);
                throw error;
            }
            return await this.completeExecution(state, startExecution(execute), classifyResult, classifyError);
        })());
    }

    async release(lease: ProviderTransportLease): Promise<boolean> {
        const state = this.requireLease(lease);
        if (state.status !== "granted") return false;
        state.status = "released";
        const settlement = await this.settleLease(state, "cancelled");
        if (settlement.error !== undefined) throw settlement.error;
        return true;
    }

    async cancel(lease: ProviderTransportLease): Promise<boolean> {
        return await this.release(lease);
    }

    async recoverAttempt(provider: ProviderId, attemptId: string): Promise<ProviderTransportLeaseRecovery> {
        if (!this.admission.recoverAttempt) throw new Error("provider admission 不支持 persisted lease recovery");
        return await this.admission.recoverAttempt(provider, attemptId);
    }

    async settleRecoveredLease(identity: ProviderLeaseIdentity): Promise<ProviderTransportRecoveredLeaseSettlement> {
        if (!this.admission.settleRecoveredLease) throw new Error("provider admission 不支持 recovered lease settlement");
        const settled = await this.admission.settleRecoveredLease(identity);
        if (settled.kind === "settled") {
            this.notifyAvailability({
                provider: identity.provider,
                trafficClass: identity.trafficClass,
                attemptId: identity.attemptId,
                permitId: identity.leaseId,
                settlement: "unknown",
                recovered: true,
            });
        }
        return settled;
    }

    async cancelRecoveredLease(identity: ProviderLeaseIdentity): Promise<ProviderTransportRecoveredLeaseSettlement> {
        if (!this.admission.cancelRecoveredLease) throw new Error("provider admission 不支持 recovered lease cancellation");
        const settled = await this.admission.cancelRecoveredLease(identity);
        if (settled.kind === "settled") {
            this.notifyAvailability({
                provider: identity.provider,
                trafficClass: identity.trafficClass,
                attemptId: identity.attemptId,
                permitId: identity.leaseId,
                settlement: "cancelled",
                recovered: true,
            });
        }
        return settled;
    }

    private async acquireLease(
        provider: ProviderId,
        metadata: ProviderTransportMetadata,
    ): Promise<ProviderTransportLease> {
        const trafficClass = mapProviderTrafficClass(metadata.trafficClass);
        const attemptId = metadata.attemptId || `provider-transport-${provider}-${this.nextAttempt++}-${crypto.randomUUID()}`;
        const permit = await this.admission.acquire(provider, trafficClass, {
            attemptId,
            signal: metadata.signal,
            lane: metadata.probe ? "probe" : undefined,
        });
        return this.createLease(provider, trafficClass, attemptId, metadata, permit);
    }

    private async tryAcquireLease(
        provider: ProviderId,
        metadata: ProviderTransportMetadata,
    ): Promise<ProviderTransportLease | null> {
        if (!this.admission.tryAcquire) throw new Error("provider admission 不支持 non-blocking tryAcquire");
        const trafficClass = mapProviderTrafficClass(metadata.trafficClass);
        const attemptId = metadata.attemptId || `provider-transport-${provider}-${this.nextAttempt++}-${crypto.randomUUID()}`;
        const permit = await this.admission.tryAcquire(provider, trafficClass, {
            attemptId,
            signal: metadata.signal,
            lane: metadata.probe ? "probe" : undefined,
        });
        if (!permit) return null;
        return this.createLease(provider, trafficClass, attemptId, metadata, permit);
    }

    private createLease(
        provider: ProviderId,
        trafficClass: ProviderTrafficClass,
        attemptId: string,
        metadata: ProviderTransportMetadata,
        permit: ProviderAdmissionPermit,
    ): ProviderTransportLease {
        this.acquireCount++;
        const lease = Object.freeze({
            provider,
            trafficClass,
            attemptId,
            permitId: permit.leaseId,
            probe: metadata.probe === true,
            identity: permit.leaseIdentity,
        });
        const state: ProviderTransportLeaseState = { lease, permit, status: "granted" };
        this.leases.set(lease, state);
        this.outstandingLeases.add(state);
        return lease;
    }

    async admissionSnapshot(provider: ProviderId): Promise<ProviderAdmissionSnapshot> {
        return await this.admission.snapshot(provider);
    }

    async quiesce(): Promise<void> {
        while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
        await this.admission.quiesce?.();
    }

    async close(): Promise<void> {
        if (!this.closeOperation) {
            this.closed = true;
            this.closeOperation = (async () => {
                await this.quiesce();
                await Promise.allSettled([...this.outstandingLeases]
                    .filter(lease => lease.status === "granted")
                    .map(lease => this.release(lease.lease)));
                if (this.admission.close) await this.admission.close();
            })();
        }
        return await this.closeOperation;
    }

    private async completeExecution<Value>(
        state: ProviderTransportLeaseState,
        execution: Promise<Value>,
        classifyResult: (value: Value) => ProviderTransportSettlementKind,
        classifyError: (error: unknown) => ProviderTransportSettlementKind,
    ): Promise<Value> {
        let value!: Value;
        let executionFailed = false;
        let executionError: unknown;
        let settlement: ProviderTransportSettlementKind = "unknown";
        try {
            value = await execution;
            settlement = classifyResult(value);
        } catch (error) {
            executionFailed = true;
            executionError = error;
            try {
                settlement = classifyError(error);
            } catch {
                settlement = "unknown";
            }
        }

        const settled = await this.settleLease(state, settlement);

        if (executionFailed) throw executionError;
        if (settled.error !== undefined) throw settled.error;
        return value;
    }

    private consumeLease(lease: ProviderTransportLease): ProviderTransportLeaseState {
        const state = this.requireLease(lease);
        if (state.status !== "granted") {
            throw new Error(`provider transport lease ${lease.permitId} 已${state.status === "released" ? "释放" : "消费"}`);
        }
        state.status = "consumed";
        return state;
    }

    private requireLease(lease: ProviderTransportLease): ProviderTransportLeaseState {
        const state = this.leases.get(lease);
        if (!state) throw new Error("provider transport lease 不属于当前 adapter");
        return state;
    }

    private async settleLease(
        state: ProviderTransportLeaseState,
        settlement: ProviderTransportSettlementKind,
    ): Promise<{ error?: unknown }> {
        let permitSettled = false;
        let settlementError: unknown;
        try {
            permitSettled = await state.permit.complete(toAdmissionOutcome(settlement));
            if (!permitSettled) {
                settlementError = new ProviderAdmissionFencedError(`Attempt ${state.lease.attemptId} 的 provider permit 已失效，结果不得提交`);
            }
        } catch (error) {
            settlementError = error;
        }
        if (settlementError !== undefined) this.settleFailureCount++;
        this.settleCount++;
        this.outstandingLeases.delete(state);
        this.attempts.push({
            provider: state.lease.provider,
            trafficClass: state.lease.trafficClass,
            attemptId: state.lease.attemptId,
            permitId: state.lease.permitId,
            probe: state.lease.probe,
            settlement,
            permitSettled,
            ...(settlementError !== undefined ? { settlementError: errorMessage(settlementError) } : {}),
        });
        if (permitSettled && settlementReleasesDispatchCapacity(state.lease.probe, settlement)) {
            this.notifyAvailability({
                provider: state.lease.provider,
                trafficClass: state.lease.trafficClass,
                attemptId: state.lease.attemptId,
                permitId: state.lease.permitId,
                settlement,
                recovered: false,
            });
        }
        return settlementError === undefined ? {} : { error: settlementError };
    }

    private notifyAvailability(event: ProviderTransportAvailabilityEvent): void {
        for (const listener of this.availabilityListeners) {
            try {
                void Promise.resolve(listener(event)).catch(() => undefined);
            } catch {}
        }
    }

    private track<Value>(operation: Promise<Value>): Promise<Value> {
        this.inFlight.add(operation);
        operation.then(
            () => { this.inFlight.delete(operation); },
            () => { this.inFlight.delete(operation); },
        );
        return operation;
    }

    diagnostics(): ProviderTransportAdapterDiagnostics {
        return {
            mode: this.mode,
            acquireCount: this.acquireCount,
            settleCount: this.settleCount,
            settleFailureCount: this.settleFailureCount,
            attempts: this.attempts.map(attempt => ({ ...attempt })),
        };
    }
}

function settlementReleasesDispatchCapacity(probe: boolean, settlement: ProviderTransportSettlementKind): boolean {
    if (settlement === "unknown" || settlement === "congestion" || settlement === "availability") return false;
    return !probe || settlement === "success";
}

type ProviderTransportLeaseState = {
    lease: ProviderTransportLease;
    permit: ProviderAdmissionPermit;
    status: "granted" | "consumed" | "released";
};

function startExecution<Value>(execute: () => Promise<Value>): Promise<Value> {
    try {
        return Promise.resolve(execute());
    } catch (error) {
        return Promise.reject(error);
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toAdmissionOutcome(settlement: ProviderTransportSettlementKind): ProviderAdmissionOutcome {
    switch (settlement) {
        case "success": return { kind: "success" };
        case "congestion":
        case "rate-limit": return { kind: "congestion" };
        case "availability": return { kind: "availability" };
        case "local-resource": return { kind: "local-resource" };
        case "cancelled": return { kind: "cancelled" };
        case "unknown": return { kind: "unknown-outcome" };
    }
}

let singleton = new ProviderTransportAdapter();

export function getProviderTransportAdapter(): ProviderTransportAdapter {
    return singleton;
}

export async function configureProviderTransportAdapterForTest(options: ProviderTransportAdapterOptions): Promise<ProviderTransportAdapter> {
    const replacement = new ProviderTransportAdapter(options);
    await singleton.close();
    singleton = replacement;
    return singleton;
}

export async function resetProviderTransportAdapterForTest(): Promise<void> {
    const replacement = new ProviderTransportAdapter({ mode: "shadow" });
    await singleton.close();
    singleton = replacement;
}
