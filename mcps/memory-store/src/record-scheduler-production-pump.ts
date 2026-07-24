import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createBackgroundTaskSuspension } from "./background-task-suspension.js";
import { getBackgroundTask, wakeBackgroundTask } from "./background-tasks.js";

import {
    RecordSchedulerCoordinator,
    type RecordSchedulerCoordinatorClaim,
    type RecordSchedulerCoordinatorPersistedClaim,
    type RecordSchedulerCoordinatorSnapshot,
} from "./record-scheduler-coordinator.js";
import {
    acquireRecordSchedulerCoordinatorOwner,
    initializeRecordSchedulerCoordinatorStore,
    mutateRecordSchedulerCoordinatorSnapshot,
    readRecordSchedulerCoordinatorStore,
    releaseRecordSchedulerCoordinatorOwner,
    renewRecordSchedulerCoordinatorOwner,
    type RecordSchedulerCoordinatorOwnerLease,
    type RecordSchedulerCoordinatorStoreOptions,
} from "./record-scheduler-coordinator-store.js";
import {
    commitRecordSchedulerFinalizedRecord,
    RecordSchedulerExecutionDriverError,
    type RecordSchedulerFinalizedCommitResult,
    type RecordSchedulerUnitCommitMetadata,
} from "./record-scheduler-execution-driver.js";
import { reconcileRecordWorkPublicationGeneration } from "./record-commit-storage-adapter.js";
import type { RecordSchedulerControl } from "./record-scheduler-control.js";
import {
    assertAttemptTransition,
    assertTaskTransition,
    assertUnitTransition,
    UNKNOWN_OUTCOME_GRACE_MS,
    type ImmutableBlobReference,
    type FailureClass,
    type RecordSchedulerLedger,
    type SchedulerAttemptAdmission,
    type SchedulerAttemptLedger,
    type SchedulerRecordWork,
    type SchedulerUnitLedger,
} from "./record-scheduler-contracts.js";
import type { FrozenRuntimeSource, FrozenRuntimeSourceSet } from "./record-scheduler-runtime.js";
import {
    mutateRecordSchedulerLedgerAsOwner,
    readRecordSchedulerLedgerStore,
    type SchedulerOwnerLease,
} from "./record-scheduler-store.js";
import type { RecordSchedulerSpool } from "./record-scheduler-spool.js";
import {
    acquireRecordWorkLease,
    advanceRecordWorkFence,
    createRecordWorkRegistry,
    initializeRecordWorkRegistryIdentity,
    readRecordWorkRegistry,
    recordWorkKey,
    startOrAttachRecordWork,
    type CanonicalConversationIdentity,
    type RecordWorkOwnerLease,
    type RecordWorkRegistry,
    type RecordWorkRegistryEntry,
} from "./record-work-registry.js";
import type { ProviderId, ProviderLeaseIdentity, ProviderTrafficClass } from "./provider-control-contracts.js";
import { getProviderTransportAdapter, type ProviderTransportAdapter, type ProviderTransportLease } from "./provider-transport-adapter.js";
import type {
    RecordModelCallResult,
    RecordSchedulerModelCallContext,
    RecordSchedulerModelCallHook,
    RecordSchedulerModelCallRecipe,
    RecordSchedulerProviderCall,
} from "./record-types.js";
import { DATA_ROOT } from "./store.js";

const PUMP_SCHEMA_VERSION = 1 as const;
const MAX_CAS_RETRIES = 16;
const DEFAULT_COORDINATOR_LEASE_MS = 60_000;
const DEFAULT_COORDINATOR_RESTART_CREDIT_CAP_MS = 60_000;
const DEFAULT_WORK_LEASE_MS = 120_000;
const PROVIDER_BLOCKED_WAKE_MS = 250;
const MODEL_RETRY_BACKOFF_MS = 25;
type AcquiredRecordWorkLease = Extract<Awaited<ReturnType<typeof acquireRecordWorkLease>>, { kind: "acquired" }>;
type ResolvedRecordWorkFence = {
    path: string;
    registry: RecordWorkRegistry;
    work: RecordWorkRegistryEntry;
    lease: RecordWorkOwnerLease;
    fence: SchedulerAttemptLedger["fence"];
};

export interface RecordSchedulerProductionRegistration {
    taskId: string;
    frozenSources: FrozenRuntimeSourceSet;
    sourceSnapshotId: string;
    recordStoreHash: string;
    schedulerOwner: {
        ownerId: string;
        leaseMs?: number;
        workLeaseMs?: number;
    };
    control: RecordSchedulerControl;
    spool: RecordSchedulerSpool;
    firstPublicationToken: string;
}

export interface RecordSchedulerProductionPumpPhaseEvent {
    phase: "unit-prepared" | "intent-persisted" | "grant-persisted" | "attempt-bound" | "before-invoke" | "provider-result-received" | "output-spool-persisted" | "known-success" | "known-failure" | "unknown-outcome" | "local-finalize" | "local-finalize-verified";
    taskId: string;
    unitId: string;
    attemptId: string;
    idempotencyKey?: string;
    fence?: SchedulerAttemptLedger["fence"];
    claim?: Pick<RecordSchedulerCoordinatorClaim, "claimId" | "permitId" | "dispatchSeq" | "providerAdmission" | "providerEvidence">;
    output?: {
        hash: string;
        byteLength: number;
        reference?: ImmutableBlobReference;
    };
}

export interface RecordSchedulerProductionPumpClock {
    nowMs(): number;
}

export function calculateRecordSchedulerRestartElapsedMs(updatedAt: string, nowMs: number, capMs: number): number {
    if (!Number.isFinite(nowMs) || !Number.isFinite(capMs) || capMs < 0) return 0;
    const updatedAtMs = Date.parse(updatedAt);
    if (!Number.isFinite(updatedAtMs) || updatedAtMs > nowMs) return 0;
    return Math.min(nowMs - updatedAtMs, capMs);
}

export interface RecordSchedulerProductionPumpOptions {
    coordinatorOwnerId: string;
    coordinatorLeaseMs?: number;
    coordinatorRestartCreditCapMs?: number;
    coordinatorStore?: RecordSchedulerCoordinatorStoreOptions;
    providerTransport?: ProviderTransportAdapter;
    unknownOutcomeGraceMs?: number;
    clock?: RecordSchedulerProductionPumpClock;
    onPhase?: (event: RecordSchedulerProductionPumpPhaseEvent) => void | Promise<void>;
    onCoordinatorPersist?: (event: { phase: "before-write" | "after-write"; snapshot: Readonly<RecordSchedulerCoordinatorSnapshot> }) => void | Promise<void>;
}

export interface RecordSchedulerLocalFinalizeInput {
    registration: RecordSchedulerProductionRegistration;
    modelUnitIds: readonly string[];
    content: string;
    commit: Pick<RecordSchedulerUnitCommitMetadata, "firstPublicationToken" | "recordMeta" | "leaseMs" | "workLeaseMs" | "clock" | "hooks">;
}

export type RecordSchedulerProductionSessionFinalizeInput = Omit<RecordSchedulerLocalFinalizeInput, "registration" | "modelUnitIds">;

export interface RecordSchedulerProductionSession {
    schedulerModelCall: RecordSchedulerModelCallHook;
    finalizeLocalRecord(input: RecordSchedulerProductionSessionFinalizeInput): Promise<RecordSchedulerFinalizedCommitResult>;
}

export interface RecordSchedulerProductionPersistedHandoff {
    taskId: string;
    dispatchIntentAttemptIds: readonly string[];
    activeAttemptIds: readonly string[];
    unknownOutcomeAttemptIds: readonly string[];
}

export interface RecordSchedulerProductionSessionsHandoff {
    acceptingDispatches: boolean;
    closed: boolean;
    timedOut: boolean;
    activePendingAttemptIds: readonly string[];
    invokingAttemptIds: readonly string[];
    persisted: readonly RecordSchedulerProductionPersistedHandoff[];
}

export interface RecordSchedulerProductionSessionsQuiesceOptions {
    timeoutMs?: number;
}

interface PreparedModelAttempt {
    registration: RecordSchedulerProductionRegistration;
    source: FrozenRuntimeSource;
    ownerLease: SchedulerOwnerLease;
    identity: CanonicalConversationIdentity;
    recordWorkKey: string;
    unitId: string;
    attemptId: string;
    idempotencyKey: string;
    inputHash: string;
    provider: RecordSchedulerModelCallContext["provider"];
    model: string;
    routeIndex: number;
    retryOrdinal: number;
    trafficClass: ProviderTrafficClass;
    providerCall: RecordSchedulerProviderCall;
    descriptor: ModelUnitDescriptor;
    call: RecordSchedulerModelCallContext;
}

interface ModelUnitDescriptor {
    unitId: string;
    prompt: string;
    recipe: RecordSchedulerModelCallRecipe;
    parentUnitId?: string;
    splitDepth: number;
    dependencies: string[];
    promptDependencyIds?: string[];
}

interface RouteExecutionResult {
    unitId: string;
    result: RecordModelCallResult;
}

type ManagedDispatchIdentity = Pick<PreparedModelAttempt, "registration" | "ownerLease" | "identity" | "recordWorkKey" | "unitId" | "attemptId">;
type CoordinatorClaimBinding = Pick<RecordSchedulerCoordinatorClaim, "claimId" | "permitId" | "dispatchSeq" | "attemptId" | "providerAdmission" | "providerEvidence" | "providerLeaseIdentity">;

interface PendingAttempt {
    prepared: PreparedModelAttempt;
    waiters: Array<{ resolve: (value: RecordModelCallResult) => void; reject: (error: unknown) => void }>;
}

interface CoordinatorSession {
    coordinator: RecordSchedulerCoordinator;
    lease: RecordSchedulerCoordinatorOwnerLease;
    revision: number;
}

interface LocalFinalizeIdentity {
    source: FrozenRuntimeSource;
    identity: CanonicalConversationIdentity;
    recordWorkKey: string;
    unitId: string;
    attemptId: string;
    commitId: string;
    inputHash: string;
    contentHash: string;
    contentByteLength: number;
}

export class RecordSchedulerProductionPump {
    private readonly registrations = new Map<string, RecordSchedulerProductionRegistration>();
    private readonly pending = new Map<string, PendingAttempt>();
    private readonly transport: ProviderTransportAdapter;
    private readonly leaseByAttempt = new Map<string, ProviderTransportLease>();
    private readonly runningByAttempt = new Map<string, Promise<void>>();
    private readonly activeRoutes = new Map<string, Promise<RouteExecutionResult>>();
    private readonly ownerRecoveryByTask = new Map<string, Promise<SchedulerOwnerLease>>();
    private readonly coordinatorLeaseMs: number;
    private readonly coordinatorRestartCreditCapMs: number;
    private readonly unknownOutcomeGraceMs: number;
    private readonly clock: RecordSchedulerProductionPumpClock;
    private coordinatorLease: RecordSchedulerCoordinatorOwnerLease | undefined;
    private coordinatorMutationTail: Promise<void> = Promise.resolve();
    private drainOperation: Promise<void> | undefined;
    private acceptingDispatches = true;
    private closed = false;
    private quiesceOperation: Promise<RecordSchedulerProductionSessionsHandoff> | undefined;
    private availabilityUnsubscribe: (() => void) | undefined;

    public constructor(private readonly options: RecordSchedulerProductionPumpOptions) {
        if (!isNonEmptyString(options.coordinatorOwnerId)) throw new TypeError("coordinatorOwnerId 必须是非空字符串");
        this.transport = options.providerTransport || getProviderTransportAdapter();
        this.coordinatorLeaseMs = options.coordinatorLeaseMs ?? DEFAULT_COORDINATOR_LEASE_MS;
        this.coordinatorRestartCreditCapMs = options.coordinatorRestartCreditCapMs ?? DEFAULT_COORDINATOR_RESTART_CREDIT_CAP_MS;
        this.unknownOutcomeGraceMs = options.unknownOutcomeGraceMs ?? UNKNOWN_OUTCOME_GRACE_MS;
        this.clock = options.clock || { nowMs: Date.now };
        this.availabilityUnsubscribe = this.transport.subscribeAvailability(event => {
            this.wakeProviderBlockedTasks(event.provider);
        });
        if (!Number.isSafeInteger(this.coordinatorLeaseMs) || this.coordinatorLeaseMs <= 0) {
            throw new TypeError("coordinatorLeaseMs 必须是正安全整数");
        }
        if (!Number.isSafeInteger(this.coordinatorRestartCreditCapMs) || this.coordinatorRestartCreditCapMs < 0) {
            throw new TypeError("coordinatorRestartCreditCapMs 必须是非负安全整数");
        }
        if (!Number.isSafeInteger(this.unknownOutcomeGraceMs) || this.unknownOutcomeGraceMs <= 0) {
            throw new TypeError("unknownOutcomeGraceMs 必须是正安全整数");
        }
    }

    public isClosed(): boolean {
        return this.closed;
    }

    public register(registration: RecordSchedulerProductionRegistration): RecordSchedulerModelCallHook {
        this.assertOpenForRegistration();
        this.assertRegistration(registration);
        this.registrations.set(registrationKey(registration), registration);
        return async call => await this.submit(registration, call);
    }

    public createSession(registration: RecordSchedulerProductionRegistration): RecordSchedulerProductionSession {
        this.assertOpenForRegistration();
        this.assertRegistration(registration);
        this.registrations.set(registrationKey(registration), registration);
        return {
            schedulerModelCall: async call => await this.submit(registration, call),
            finalizeLocalRecord: async input => await this.finalizeLocalRecord({
                ...input,
                registration,
                modelUnitIds: [],
            }),
        };
    }

    public async submit(
        registration: RecordSchedulerProductionRegistration,
        call: RecordSchedulerModelCallContext,
    ): Promise<RecordModelCallResult> {
        return await this.submitWithSuccessfulObserver(registration, call);
    }

    private async submitWithSuccessfulObserver(
        registration: RecordSchedulerProductionRegistration,
        call: RecordSchedulerModelCallContext,
        onKnownSuccess?: (prepared: Pick<PreparedModelAttempt, "unitId">) => void,
    ): Promise<RecordModelCallResult> {
        this.assertAcceptingDispatches();
        this.assertRegistration(registration);
        this.assertRouteCall(call);
        this.registrations.set(registrationKey(registration), registration);
        const cancelled = await this.isTaskCancelled(registration.taskId);
        if (cancelled) return { text: null, cancelled: true, error: "Record scheduler task 已取消，禁止派发新的 provider Unit" };
        const routeKey = `${registration.taskId}:${registration.sourceSnapshotId}:${call.logicalCallKey}`;
        let operation = this.activeRoutes.get(routeKey);
        if (!operation) {
            operation = this.executeRoute(registration, call).finally(() => {
                if (this.activeRoutes.get(routeKey) === operation) this.activeRoutes.delete(routeKey);
            });
            this.activeRoutes.set(routeKey, operation);
        }
        const executed = await operation;
        if (executed.result.text !== null && executed.result.text !== undefined) onKnownSuccess?.({ unitId: executed.unitId });
        return executed.result;
    }

    private async submitPreparedAttempt(
        registration: RecordSchedulerProductionRegistration,
        call: RecordSchedulerModelCallContext,
        descriptor: ModelUnitDescriptor,
        providerCall: RecordSchedulerProviderCall,
    ): Promise<RecordModelCallResult> {
        let prepared = await this.prepareModelAttempt(registration, call, descriptor, providerCall);
        await this.serializeCoordinatorMutation(async () => {
            await this.openCoordinatorSession();
        });
        let existing = await this.readAttemptIfPresent(prepared);
        if (existing?.state === "KnownFailure") {
            const retryOrdinal = await this.selectModelAttemptOrdinal(registration.taskId, prepared.unitId);
            if (retryOrdinal > attemptOrdinal(prepared.attemptId, prepared.unitId)) {
                prepared = await this.prepareModelAttempt(registration, call, descriptor, providerCall);
                existing = await this.readAttemptIfPresent(prepared);
            }
        }
        if (existing?.state === "KnownSuccess" && existing.outputRef) {
            return await this.replayKnownSuccess(prepared, existing.outputRef);
        }
        if (existing?.state === "KnownFailure") {
            return {
                text: null,
                error: existing.providerEvidence || "持久 provider attempt 已知失败",
                failureClass: existing.errorClass,
                chainUsed: prepared.provider,
                modelUsed: existing.model,
            };
        }
        if (existing?.state === "UnknownOutcome" || existing?.state === "Discarded") {
            throw new RecordSchedulerExecutionDriverError("UNKNOWN_OUTCOME", `Attempt ${prepared.attemptId} 处于 ${existing.state}，禁止自动重发 provider`);
        }
        const key = attemptKey(prepared);
        const active = this.pending.get(key);
        if (active) return await this.attachWaiter(active);
        const next: PendingAttempt = { prepared, waiters: [] };
        this.pending.set(key, next);
        this.kickDrain();
        return await this.attachWaiter(next);
    }

    private assertRouteCall(call: RecordSchedulerModelCallContext): void {
        if (!isNonEmptyString(call.logicalCallKey)
            || !isNonEmptyString(call.prompt)
            || !Array.isArray(call.routePlan)
            || call.routePlan.length === 0
            || !Array.isArray(call.providerCalls)
            || call.providerCalls.length !== call.routePlan.length
            || !Number.isSafeInteger(call.retryBudget)
            || call.retryBudget < 0
            || typeof call.splitPrompt !== "function") {
            throw new TypeError("schedulerModelCall 必须提供稳定 logicalCallKey、prompt、routePlan、providerCalls、recipe、retryBudget 与 splitPrompt");
        }
        const providers = new Set<string>();
        for (let index = 0; index < call.routePlan.length; index += 1) {
            const provider = call.routePlan[index];
            const providerCall = call.providerCalls[index];
            if (!isNonEmptyString(provider)
                || provider === "auto"
                || providers.has(provider)
                || providerCall?.provider !== provider
                || !isNonEmptyString(providerCall.model)
                || !Number.isSafeInteger(providerCall.logicalTimeout)
                || providerCall.logicalTimeout <= 0
                || !Number.isSafeInteger(providerCall.invokeTimeout)
                || providerCall.invokeTimeout <= 0
                || typeof providerCall.invoke !== "function"
                || typeof providerCall.invokePrompt !== "function") {
                throw new TypeError("schedulerModelCall routePlan 与 providerCalls 必须一一对应且 provider 唯一");
            }
            providers.add(provider);
        }
        const recipe = call.recipe;
        if (recipe?.recipeVersion !== 1
            || !isNonEmptyString(recipe.templateId)
            || !["round", "step"].includes(recipe.range?.axis)
            || !Number.isSafeInteger(recipe.range?.start)
            || !Number.isSafeInteger(recipe.range?.end)
            || recipe.range.start > recipe.range.end
            || !Number.isSafeInteger(recipe.composeOrder)
            || recipe.composeOrder < 0
            || recipe.continuationKey !== undefined && !isNonEmptyString(recipe.continuationKey)) {
            throw new TypeError("schedulerModelCall recipe 非法");
        }
    }

    private async rootDescriptor(
        registration: RecordSchedulerProductionRegistration,
        call: RecordSchedulerModelCallContext,
    ): Promise<ModelUnitDescriptor> {
        const ledger = await requireLedger(registration.taskId);
        const predecessors = call.recipe.continuationKey
            ? ledger.units.filter(unit => unit.layer === "provider-attempt"
                && unit.sourceSnapshotId === registration.sourceSnapshotId
                && unit.promptRecipe?.continuationKey === call.recipe.continuationKey
                && unit.composeOrder < call.recipe.composeOrder
                && !unit.childUnitIds?.length
                && (unit.state === "ResultReady" || unit.state === "Succeeded"))
            : [];
        const predecessorOrder = predecessors.reduce((maximum, unit) => Math.max(maximum, unit.composeOrder), -1);
        return {
            unitId: stableId("record-provider-unit", {
                taskId: registration.taskId,
                sourceSnapshotId: registration.sourceSnapshotId,
                logicalCallKey: call.logicalCallKey,
            }),
            prompt: call.prompt,
            recipe: structuredClone(call.recipe),
            splitDepth: 0,
            dependencies: uniqueSorted(predecessors
                .filter(unit => unit.composeOrder === predecessorOrder)
                .map(unit => unit.unitId)),
        };
    }

    private async executeRoute(
        registration: RecordSchedulerProductionRegistration,
        call: RecordSchedulerModelCallContext,
    ): Promise<RouteExecutionResult> {
        const root = await this.rootDescriptor(registration, call);
        const replayed = await this.replayComposedResult(registration, call, root);
        if (replayed) return { unitId: root.unitId, result: replayed };
        const before = await requireLedger(registration.taskId);
        const existingParent = before.units.find(unit => unit.unitId === root.unitId);
        if (existingParent?.childUnitIds?.length) {
            const composed = await this.executeSplitChildren(registration, call, root, existingParent.childUnitIds);
            return { unitId: root.unitId, result: composed };
        }
        const result = await this.executeUnitRoute(registration, call, root);
        const ledger = await requireLedger(registration.taskId);
        const parent = ledger.units.find(unit => unit.unitId === root.unitId);
        if (!parent?.childUnitIds?.length) return { unitId: root.unitId, result };
        const composed = await this.executeSplitChildren(registration, call, root, parent.childUnitIds);
        return { unitId: root.unitId, result: composed };
    }

    private async executeUnitRoute(
        registration: RecordSchedulerProductionRegistration,
        call: RecordSchedulerModelCallContext,
        descriptor: ModelUnitDescriptor,
    ): Promise<RecordModelCallResult> {
        const maximumTurns = call.routePlan.length + call.retryBudget + 2;
        for (let turn = 0; turn < maximumTurns; turn += 1) {
            const selection = await this.selectUnitProvider(registration, call, descriptor);
            if (selection.kind === "terminal") return selection.result;
            const result = await this.submitPreparedAttempt(registration, call, descriptor, selection.providerCall);
            if (result.text !== null && result.text !== undefined) return result;
            if (result.cancelled && await this.isTaskCancelled(registration.taskId)) return result;
            const ledger = await requireLedger(registration.taskId);
            const unit = requireUnit(ledger, descriptor.unitId);
            if (unit.childUnitIds?.length || ["FailedFinal", "Superseded", "Cancelled"].includes(unit.state)) return result;
        }
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Unit ${descriptor.unitId} 的 route/retry 次数超过持久预算`);
    }

    private async selectUnitProvider(
        registration: RecordSchedulerProductionRegistration,
        call: RecordSchedulerModelCallContext,
        descriptor: ModelUnitDescriptor,
    ): Promise<{ kind: "provider"; providerCall: RecordSchedulerProviderCall } | { kind: "terminal"; result: RecordModelCallResult }> {
        let ledger = await requireLedger(registration.taskId);
        let unit = ledger.units.find(candidate => candidate.unitId === descriptor.unitId);
        if (!unit) return { kind: "provider", providerCall: this.providerCallForDescriptor(call.providerCalls[0], descriptor) };
        if (unit.state === "WaitingRetry") {
            await this.activateWaitingRetry(registration, descriptor.unitId);
            ledger = await requireLedger(registration.taskId);
            unit = requireUnit(ledger, descriptor.unitId);
        }
        const successful = latestAttempt(ledger, descriptor.unitId, attempt => attempt.state === "KnownSuccess" && attempt.outputRef !== undefined);
        if ((unit.state === "ResultReady" || unit.state === "Succeeded") && successful?.outputRef) {
            const providerCall = call.providerCalls.find(candidate => candidate.provider === successful.provider);
            if (!providerCall) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Unit ${descriptor.unitId} 的成功 provider 不在冻结 routePlan 中`);
            const prepared = await this.prepareModelAttempt(registration, call, descriptor, this.providerCallForDescriptor(providerCall, descriptor));
            return { kind: "terminal", result: await this.replayKnownSuccess(prepared, successful.outputRef) };
        }
        if (unit.state === "FailedFinal" || unit.state === "Superseded" && !unit.childUnitIds?.length) {
            const failure = latestAttempt(ledger, descriptor.unitId, attempt => attempt.state === "KnownFailure");
            return {
                kind: "terminal",
                result: {
                    text: null,
                    error: failure?.providerEvidence || `Unit ${descriptor.unitId} 已终止: ${unit.state}`,
                    failureClass: failure?.errorClass || unit.failureClass,
                    chainUsed: failure?.provider === "local" ? null : failure?.provider,
                    modelUsed: failure?.model,
                },
            };
        }
        const active = latestAttempt(ledger, descriptor.unitId, attempt => ["Created", "DispatchIntentPersisted", "Dispatched", "UnknownOutcome"].includes(attempt.state));
        const provider = active?.provider || unit.routePlan[unit.routeCursor ?? 0];
        const providerCall = call.providerCalls.find(candidate => candidate.provider === provider);
        if (!providerCall) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Unit ${descriptor.unitId} 的 routeCursor provider ${provider} 不在冻结 providerCalls 中`);
        return { kind: "provider", providerCall: this.providerCallForDescriptor(providerCall, descriptor) };
    }

    private providerCallForDescriptor(providerCall: RecordSchedulerProviderCall, descriptor: ModelUnitDescriptor): RecordSchedulerProviderCall {
        if (descriptor.prompt === undefined) return providerCall;
        return {
            ...providerCall,
            invoke: options => providerCall.invokePrompt(descriptor.prompt, options),
        };
    }

    private providerTrafficClass(
        call: RecordSchedulerModelCallContext,
        provider: RecordSchedulerProviderCall["provider"],
        routeIndex: number,
    ): ProviderTrafficClass {
        if (provider !== "agy" || call.context.requestedChain !== "auto") return "record";
        return routeIndex === 0 ? "agy-first-run-overflow" : "agy-fallback";
    }

    private async prepareFirstRunOverflowAttempt(prepared: PreparedModelAttempt): Promise<PreparedModelAttempt | null> {
        if (prepared.provider !== "grok"
            || prepared.routeIndex !== 0
            || prepared.call.context.requestedChain !== "auto"
            || prepared.call.routePlan[0] !== "grok") return null;
        const agyRouteIndex = prepared.call.routePlan.indexOf("agy");
        if (agyRouteIndex <= prepared.routeIndex) return null;
        const agyProviderCall = prepared.call.providerCalls[agyRouteIndex];
        if (agyProviderCall?.provider !== "agy") {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "auto route 的 agy providerCall 与冻结 routePlan 不一致");
        }
        const ledger = await requireLedger(prepared.registration.taskId);
        const unit = requireUnit(ledger, prepared.unitId);
        if (unit.state !== "Queued"
            || unit.routeCursor !== prepared.routeIndex
            || unit.unitAttempts !== 0
            || unit.attemptedProviders.length !== 0
            || ledger.attempts.some(attempt => attempt.unitId === prepared.unitId)) return null;
        return await this.prepareModelAttempt(
            prepared.registration,
            prepared.call,
            prepared.descriptor,
            this.providerCallForDescriptor(agyProviderCall, prepared.descriptor),
            "agy-first-run-overflow",
        );
    }

    private modelUnitInputHash(
        registration: RecordSchedulerProductionRegistration,
        call: RecordSchedulerModelCallContext,
        descriptor: ModelUnitDescriptor,
        sourceSnapshotId: string,
    ): string {
        return hashJson({
            schemaVersion: PUMP_SCHEMA_VERSION,
            kind: "record-scheduler-production-route-unit",
            taskId: registration.taskId,
            sourceSnapshotId,
            logicalCallKey: call.logicalCallKey,
            unitId: descriptor.unitId,
            parentUnitId: descriptor.parentUnitId ?? null,
            splitDepth: descriptor.splitDepth,
            dependencies: descriptor.dependencies,
            routePlan: call.routePlan,
            providerModels: call.providerCalls.map(candidate => ({
                provider: candidate.provider,
                model: candidate.model,
                logicalTimeout: candidate.logicalTimeout,
                invokeTimeout: candidate.invokeTimeout,
            })),
            prompt: descriptor.prompt,
            recipe: descriptor.recipe,
            retryBudget: call.retryBudget,
            logicalTimeout: call.logicalTimeout,
        });
    }

    private splitDescriptors(call: RecordSchedulerModelCallContext, parent: ModelUnitDescriptor): ModelUnitDescriptor[] {
        const range = parent.recipe.range;
        if (parent.splitDepth >= 1 || range.end <= range.start) return [];
        const splitAt = Math.floor((range.start + range.end) / 2);
        const firstRange = { axis: range.axis, start: range.start, end: splitAt } as const;
        const secondRange = { axis: range.axis, start: splitAt + 1, end: range.end } as const;
        const firstId = `${parent.unitId}.split-1`;
        const secondId = `${parent.unitId}.split-2`;
        const recipe = (childRange: RecordSchedulerModelCallRecipe["range"]): RecordSchedulerModelCallRecipe => ({
            ...structuredClone(parent.recipe),
            range: childRange,
        });
        return [
            {
                unitId: firstId,
                prompt: call.splitPrompt(firstRange),
                recipe: recipe(firstRange),
                parentUnitId: parent.unitId,
                splitDepth: parent.splitDepth + 1,
                dependencies: [...parent.dependencies],
                promptDependencyIds: [],
            },
            {
                unitId: secondId,
                prompt: call.splitPrompt(secondRange),
                recipe: recipe(secondRange),
                parentUnitId: parent.unitId,
                splitDepth: parent.splitDepth + 1,
                dependencies: parent.recipe.continuationKey
                    ? uniqueSorted([...parent.dependencies, firstId])
                    : [...parent.dependencies],
                promptDependencyIds: parent.recipe.continuationKey ? [firstId] : [],
            },
        ];
    }

    private async activateWaitingRetry(registration: RecordSchedulerProductionRegistration, unitId: string): Promise<void> {
        let initial = await requireLedger(registration.taskId);
        let unit = requireUnit(initial, unitId);
        if (unit.state !== "WaitingRetry") return;
        const now = this.nowMs();
        const wakeAt = unit.nextEligibleAt ? Date.parse(unit.nextEligibleAt) : now;
        if (!Number.isFinite(wakeAt)) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `WaitingRetry Unit ${unitId} 的 nextEligibleAt 无效`);
        }
        if (wakeAt > now) {
            throw createBackgroundTaskSuspension({
                taskId: registration.taskId,
                wakeAt: new Date(wakeAt).toISOString(),
                waitingReason: `record-scheduler:waiting-retry:${unitId}`,
                ledgerRevision: initial.revision,
            });
        }
        initial = await requireLedger(registration.taskId);
        unit = requireUnit(initial, unitId);
        if (unit.state !== "WaitingRetry") return;
        const settledAttempt = latestAttempt(initial, unitId, attempt => attempt.state === "KnownFailure");
        if (!settledAttempt) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `WaitingRetry Unit ${unitId} 缺少 KnownFailure Attempt`);
        const source = selectSource(registration.frozenSources, registration.sourceSnapshotId);
        const ownerLease = await this.getOrRecoverTaskOwner(registration);
        const identity = canonicalIdentity(source);
        const schedulerWork = requireWork(initial, unit.recordWorkKey);
        const resolved = await this.resolveRetryFence(
            registration,
            ownerLease,
            identity,
            schedulerWork,
            settledAttempt,
            initial,
            "provider failure",
        );
        const registryRef = await registryReference(registration.control.dataRoot, resolved.path, resolved.registry);
        await this.mutateOwnerLedger(registration.taskId, ownerLease, ledger => {
            const work = requireWork(ledger, unit.recordWorkKey);
            const currentUnit = requireUnit(ledger, unitId);
            if (currentUnit.state === "Queued") return;
            if (currentUnit.state !== "WaitingRetry") {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `WaitingRetry Unit ${unitId} 在 fence 换发时变为 ${currentUnit.state}`);
            }
            const currentAttempt = requireAttempt(ledger, settledAttempt.attemptId);
            if (currentAttempt.state !== "KnownFailure") {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `WaitingRetry Attempt ${currentAttempt.attemptId} 不再是 KnownFailure`);
            }
            const beforeFence = currentFence(work);
            const expectedFence = currentFence(schedulerWork);
            if (!sameFence(beforeFence, expectedFence) && !sameFence(beforeFence, resolved.fence)) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `WaitingRetry Unit ${unitId} 的 scheduler fence 与 registry 漂移`);
            }
            work.registryRevision = resolved.registry.registryRevision;
            work.registryRef = registryRef;
            work.schedulerEpoch = resolved.fence.schedulerEpoch;
            work.workLeaseId = resolved.fence.workLeaseId;
            work.leaseOwnerId = resolved.lease.ownerId;
            work.leaseExpiresAt = resolved.lease.expiresAt;
            work.activeTaskIds = [...resolved.work.activeTaskIds];
            work.currentFencingToken = resolved.fence.fencingToken;
            for (const candidate of ledger.attempts) {
                if (candidate.attemptId === currentAttempt.attemptId
                    || candidate.recordWorkKey !== work.recordWorkKey
                    || !["Created", "DispatchIntentPersisted", "Dispatched", "KnownSuccess"].includes(candidate.state)) continue;
                if (!sameFence(candidate.fence, beforeFence) && !sameFence(candidate.fence, resolved.fence)) {
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${candidate.attemptId} 无法迁移到 WaitingRetry 新 fence`);
                }
                candidate.fence = { ...resolved.fence };
                if (candidate.leaseExpiresAt) candidate.leaseExpiresAt = resolved.lease.expiresAt;
            }
            for (const commit of ledger.commits) {
                if (commit.recordWorkKey !== work.recordWorkKey
                    || !["ResultReady", "BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten", "Verified", "CleanupPending"].includes(commit.state)) continue;
                if (!sameFence(commit.fence, beforeFence) && !sameFence(commit.fence, resolved.fence)) {
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Commit ${commit.commitId} 无法迁移到 WaitingRetry 新 fence`);
                }
                commit.fence = { ...resolved.fence };
                if (commit.beforeImage) commit.beforeImage.fence = { ...resolved.fence };
                if (commit.cleanupReadBack) commit.cleanupReadBack.fence = { ...resolved.fence };
            }
            assertUnitTransition(currentUnit.state, "Queued");
            currentUnit.state = "Queued";
            currentUnit.nextEligibleAt = undefined;
            currentUnit.enqueueTime = new Date().toISOString();
            currentUnit.layerEnterTime = new Date().toISOString();
            refreshUnitCounters(ledger);
        });
    }

    private async executeSplitChildren(
        registration: RecordSchedulerProductionRegistration,
        call: RecordSchedulerModelCallContext,
        parent: ModelUnitDescriptor,
        childUnitIds: readonly string[],
    ): Promise<RecordModelCallResult> {
        const descriptors = this.splitDescriptors(call, parent)
            .sort((left, right) => left.recipe.range.start - right.recipe.range.start || left.unitId.localeCompare(right.unitId));
        if (!sameStringArray(descriptors.map(descriptor => descriptor.unitId), childUnitIds)) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `split family ${parent.unitId} 的持久 childUnitIds 与 recipe 不一致`);
        }
        const results: Array<{ descriptor: ModelUnitDescriptor; result: RecordModelCallResult; outputRef: ImmutableBlobReference }> = [];
        for (const initialDescriptor of descriptors) {
            const descriptor = await this.resolveDescriptorDependencies(registration, call, initialDescriptor);
            const result = await this.executeUnitRoute(registration, call, descriptor);
            if (result.text === null || result.text === undefined) return result;
            const ledger = await requireLedger(registration.taskId);
            const success = latestAttempt(ledger, descriptor.unitId, attempt => attempt.state === "KnownSuccess" && attempt.outputRef !== undefined);
            if (!success?.outputRef) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `split child ${descriptor.unitId} 成功后缺少 outputRef`);
            results.push({ descriptor, result, outputRef: success.outputRef });
        }
        const outputHash = splitCompositionHash(results);
        const ownerLease = await this.getOrRecoverTaskOwner(registration);
        await this.mutateOwnerLedger(registration.taskId, ownerLease, ledger => {
            const parentUnit = requireUnit(ledger, parent.unitId);
            if (!sameStringArray(parentUnit.childUnitIds || [], descriptors.map(descriptor => descriptor.unitId))) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `split parent ${parent.unitId} child 闭包漂移`);
            }
            for (const descriptor of descriptors) {
                const child = requireUnit(ledger, descriptor.unitId);
                if (child.state !== "ResultReady" && child.state !== "Succeeded") {
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `split child ${descriptor.unitId} 尚未 ResultReady`);
                }
            }
            parentUnit.composeProvenance = {
                childUnitIds: descriptors.map(descriptor => descriptor.unitId),
                outputHash,
                composedAt: new Date().toISOString(),
            };
            refreshUnitCounters(ledger);
        });
        return composedModelResult(results.map(item => item.result));
    }

    private async resolveDescriptorDependencies(
        registration: RecordSchedulerProductionRegistration,
        call: RecordSchedulerModelCallContext,
        descriptor: ModelUnitDescriptor,
    ): Promise<ModelUnitDescriptor> {
        if (descriptor.dependencies.length === 0) return descriptor;
        const ledger = await requireLedger(registration.taskId);
        const dependencyTexts: string[] = [];
        const promptDependencyIds = new Set(descriptor.promptDependencyIds || []);
        for (const dependencyId of descriptor.dependencies) {
            const dependency = requireUnit(ledger, dependencyId);
            const success = latestAttempt(ledger, dependencyId, attempt => attempt.state === "KnownSuccess" && attempt.outputRef !== undefined);
            if ((dependency.state !== "ResultReady" && dependency.state !== "Succeeded") || !success?.outputRef) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Unit ${descriptor.unitId} 的依赖 ${dependencyId} 尚未成功`);
            }
            if (promptDependencyIds.has(dependencyId)) {
                const result = await this.readModelResult(registration, success.outputRef);
                dependencyTexts.push(`【依赖 ${dependencyId}】\n${result.text || ""}`);
            }
        }
        const resolved: ModelUnitDescriptor = {
            ...descriptor,
            prompt: dependencyTexts.length > 0
                ? `${descriptor.prompt}\n\n${dependencyTexts.join("\n\n")}`
                : descriptor.prompt,
        };
        const ownerLease = await this.getOrRecoverTaskOwner(registration);
        await this.mutateOwnerLedger(registration.taskId, ownerLease, current => {
            const unit = requireUnit(current, descriptor.unitId);
            if (unit.state === "Blocked") {
                if (current.attempts.some(attempt => attempt.unitId === unit.unitId)) {
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Blocked Unit ${unit.unitId} 已存在 Attempt，禁止重写 resolved inputHash`);
                }
                unit.inputHash = this.modelUnitInputHash(registration, call, resolved, registration.sourceSnapshotId);
                assertUnitTransition(unit.state, "Queued");
                unit.state = "Queued";
                unit.enqueueTime = new Date().toISOString();
                unit.layerEnterTime = new Date().toISOString();
                refreshUnitCounters(current);
            }
        });
        return resolved;
    }

    private async replayComposedResult(
        registration: RecordSchedulerProductionRegistration,
        call: RecordSchedulerModelCallContext,
        parent: ModelUnitDescriptor,
    ): Promise<RecordModelCallResult | undefined> {
        const ledger = await requireLedger(registration.taskId);
        const unit = ledger.units.find(candidate => candidate.unitId === parent.unitId);
        if (!unit?.composeProvenance) return undefined;
        const descriptors = this.splitDescriptors(call, parent)
            .sort((left, right) => left.recipe.range.start - right.recipe.range.start || left.unitId.localeCompare(right.unitId));
        if (!sameStringArray(unit.composeProvenance.childUnitIds, descriptors.map(descriptor => descriptor.unitId))) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `split parent ${parent.unitId} compose provenance child 闭包漂移`);
        }
        const results: Array<{ descriptor: ModelUnitDescriptor; result: RecordModelCallResult; outputRef: ImmutableBlobReference }> = [];
        for (const descriptor of descriptors) {
            const success = latestAttempt(ledger, descriptor.unitId, attempt => attempt.state === "KnownSuccess" && attempt.outputRef !== undefined);
            if (!success?.outputRef) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `split child ${descriptor.unitId} replay 缺少 KnownSuccess output`);
            results.push({ descriptor, outputRef: success.outputRef, result: await this.readModelResult(registration, success.outputRef) });
        }
        if (splitCompositionHash(results) !== unit.composeProvenance.outputHash) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `split parent ${parent.unitId} compose outputHash 回读不一致`);
        }
        return composedModelResult(results.map(item => item.result));
    }

    public async quiesce(options: RecordSchedulerProductionSessionsQuiesceOptions = {}): Promise<RecordSchedulerProductionSessionsHandoff> {
        if (!this.quiesceOperation) {
            this.acceptingDispatches = false;
            this.availabilityUnsubscribe?.();
            this.availabilityUnsubscribe = undefined;
            this.quiesceOperation = this.quiesceInternal(options);
        }
        return await this.quiesceOperation;
    }

    public async close(options: RecordSchedulerProductionSessionsQuiesceOptions = {}): Promise<RecordSchedulerProductionSessionsHandoff> {
        const handoff = await this.quiesce(options);
        if (!this.closed) {
            this.closed = true;
            const error = new RecordSchedulerExecutionDriverError("OWNER_UNAVAILABLE", "production pump 已关闭，持久化 dispatch intent 等待后续进程接管");
            for (const pending of this.pending.values()) {
                for (const waiter of pending.waiters) waiter.reject(error);
            }
            this.pending.clear();
            if (!handoff.timedOut && this.runningByAttempt.size === 0) {
                await this.releaseCoordinatorOwnerForHandoff();
            }
            this.scheduleClosedCleanup();
        }
        return { ...handoff, closed: true };
    }

    public async finalizeLocalRecord(input: RecordSchedulerLocalFinalizeInput): Promise<RecordSchedulerFinalizedCommitResult> {
        this.assertRegistration(input.registration);
        if (!isNonEmptyString(input.content)) throw new TypeError("local-finalize content 必须是非空字符串");
        if (!isNonEmptyString(input.commit.firstPublicationToken)) throw new TypeError("local-finalize firstPublicationToken 必须是非空字符串");
        if (input.commit.firstPublicationToken !== input.registration.firstPublicationToken) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "local-finalize firstPublicationToken 与注册 work 不一致");
        }
        if (await this.isTaskCancelled(input.registration.taskId)) {
            return { kind: "cancelled", taskId: input.registration.taskId, reason: "任务已取消，未创建 local-finalize Unit" };
        }
        const source = selectSource(input.registration.frozenSources, input.registration.sourceSnapshotId);
        const ownerLease = await this.getOrRecoverTaskOwner(input.registration);
        const identity = canonicalIdentity(source);
        const workKey = await this.ensureRecordWork(input.registration, source, identity, ownerLease);
        const modelUnitIds = await this.resolveSuccessfulModelDependencies(input.registration);
        if (input.modelUnitIds.length > 0 && !sameStringArray(uniqueSorted(input.modelUnitIds), modelUnitIds)) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "local-finalize 调用方提供的 modelUnitIds 与持久成功叶子闭包不一致");
        }
        const resolvedInput = { ...input, modelUnitIds };
        const local = this.deriveLocalFinalizeIdentity(resolvedInput, source, identity, workKey);
        await this.ensureLocalFinalizeAttempt(resolvedInput, local, ownerLease);
        const current = await requireLedger(input.registration.taskId);
        if (["CancelRequested", "Cancelling", "Cancelled"].includes(current.task.state)) {
            return { kind: "cancelled", taskId: input.registration.taskId, reason: "local-finalize Attempt 建立后任务已取消" };
        }
        const attempt = requireAttempt(current, local.attemptId);
        if (attempt.state === "KnownSuccess" && attempt.outputRef) {
            await this.assertLocalOutputMatchesExpected(resolvedInput, local, attempt.outputRef);
            return await this.commitLocalFinalize(resolvedInput, source, local, ownerLease, attempt.outputRef);
        }
        if (attempt.state === "UnknownOutcome" || attempt.state === "Discarded") {
            if (await this.isTaskCancelled(input.registration.taskId)) {
                return { kind: "cancelled", taskId: input.registration.taskId, reason: `local-finalize Attempt ${local.attemptId} 已由取消流程隔离` };
            }
            throw new RecordSchedulerExecutionDriverError("UNKNOWN_OUTCOME", `local-finalize Attempt ${local.attemptId} 是 ${attempt.state}，禁止自动重放`);
        }
        const output = await input.registration.spool.writeImmutable({
            taskId: input.registration.taskId,
            kind: "output",
            content: input.content,
        });
        await this.assertLocalOutputMatchesExpected(resolvedInput, local, output.reference);
        try {
            await this.mutateOwnerLedger(input.registration.taskId, ownerLease, ledger => {
                const work = requireWork(ledger, local.recordWorkKey);
                const unit = requireUnit(ledger, local.unitId);
                const target = requireAttempt(ledger, local.attemptId);
                if (target.state === "DispatchIntentPersisted") {
                    assertAttemptTransition(target.state, "Dispatched");
                    target.state = "Dispatched";
                    target.outcome = "dispatched";
                    target.startedAt = new Date().toISOString();
                    target.leaseExpiresAt = work.leaseExpiresAt;
                    target.providerEvidence = `local-finalize:${local.attemptId}`;
                    unit.state = "Running";
                    unit.attemptedProviders = unit.attemptedProviders.includes("local")
                        ? unit.attemptedProviders
                        : [...unit.attemptedProviders, "local"];
                }
                if (target.state !== "Dispatched") {
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `local-finalize Attempt 无法写入 output: ${target.state}`);
                }
                assertAttemptTransition(target.state, "KnownSuccess");
                assertUnitTransition(unit.state, "ResultReady");
                target.state = "KnownSuccess";
                target.outcome = "known_success";
                target.outputRef = output.reference;
                target.elapsedMs = 0;
                target.fence = currentFence(work);
                unit.state = "ResultReady";
                unit.resultRef = output.reference;
                unit.coveredRevision = work.desiredRevision;
                refreshUnitCounters(ledger);
            });
        } catch (error) {
            if (await this.isTaskCancelled(input.registration.taskId)) {
                return { kind: "cancelled", taskId: input.registration.taskId, reason: "local-finalize output 持久化时任务已取消" };
            }
            throw error;
        }
        await this.emitPhase({ phase: "local-finalize", taskId: input.registration.taskId, unitId: local.unitId, attemptId: local.attemptId });
        return await this.commitLocalFinalize(resolvedInput, source, local, ownerLease, output.reference);
    }

    private async resolveSuccessfulModelDependencies(
        registration: RecordSchedulerProductionRegistration,
    ): Promise<string[]> {
        const ledger = await requireLedger(registration.taskId);
        return ledger.units
            .filter(unit => unit.layer === "provider-attempt"
                && unit.sourceSnapshotId === registration.sourceSnapshotId
                && !unit.childUnitIds?.length
                && (unit.state === "ResultReady" || unit.state === "Succeeded")
                && ledger.attempts.some(attempt => attempt.unitId === unit.unitId
                    && attempt.state === "KnownSuccess"
                    && attempt.provider !== "local"
                    && attempt.outputRef !== undefined))
            .sort((left, right) => left.composeOrder - right.composeOrder
                || (left.promptRecipe?.range.start || 0) - (right.promptRecipe?.range.start || 0)
                || left.unitId.localeCompare(right.unitId))
            .map(unit => unit.unitId);
    }

    private async commitLocalFinalize(
        input: RecordSchedulerLocalFinalizeInput,
        source: FrozenRuntimeSource,
        local: LocalFinalizeIdentity,
        ownerLease: SchedulerOwnerLease,
        outputRef: ImmutableBlobReference,
    ): Promise<RecordSchedulerFinalizedCommitResult> {
        await this.assertLocalOutputMatchesExpected(input, local, outputRef);
        const committed = await commitRecordSchedulerFinalizedRecord({
            taskId: input.registration.taskId,
            source,
            recordStoreHash: input.registration.recordStoreHash,
            schedulerOwner: input.registration.schedulerOwner,
            control: input.registration.control,
            spool: input.registration.spool,
            recordWorkKey: local.recordWorkKey,
            unitId: local.unitId,
            attemptId: local.attemptId,
            commitId: local.commitId,
            outputRef,
            commit: {
                ...input.commit,
                clock: input.commit.clock || {
                    now: () => new Date(this.nowMs()).toISOString(),
                    nowMs: () => this.nowMs(),
                },
            },
        });
        if (committed.kind === "cancelled") return committed;
        await this.emitPhase({ phase: "local-finalize-verified", taskId: input.registration.taskId, unitId: local.unitId, attemptId: local.attemptId });
        await this.completeModelDependencies(input.registration, ownerLease, local, input.modelUnitIds);
        return committed;
    }

    private async completeModelDependencies(
        registration: RecordSchedulerProductionRegistration,
        ownerLease: SchedulerOwnerLease,
        local: LocalFinalizeIdentity,
        modelUnitIds: readonly string[],
    ): Promise<void> {
        const dependencies = [...new Set(modelUnitIds)].sort();
        await this.mutateOwnerLedger(registration.taskId, ownerLease, ledger => {
            const localUnit = requireUnit(ledger, local.unitId);
            const localAttempt = requireAttempt(ledger, local.attemptId);
            const localCommit = ledger.commits.find(candidate => candidate.commitId === local.commitId);
            if (localUnit.state !== "Succeeded"
                || localUnit.commitId !== local.commitId
                || localAttempt.state !== "KnownSuccess"
                || localCommit?.state !== "Verified") {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "local-finalize Verified 后无法收束 model Units");
            }
            for (const unitId of dependencies) {
                const unit = requireUnit(ledger, unitId);
                const attempt = ledger.attempts.find(candidate => candidate.unitId === unitId && candidate.state === "KnownSuccess");
                if (!attempt || attempt.provider === "local") {
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `local-finalize 依赖的 model Unit ${unitId} 缺少 KnownSuccess`);
                }
                if (unit.state === "ResultReady") {
                    assertUnitTransition(unit.state, "Committing");
                    unit.state = "Committing";
                    assertUnitTransition(unit.state, "Succeeded");
                    unit.state = "Succeeded";
                } else if (unit.state !== "Succeeded") {
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `local-finalize 依赖的 model Unit ${unitId} 状态异常: ${unit.state}`);
                }
            }
            refreshUnitCounters(ledger);
        });
    }

    private async attachWaiter(pending: PendingAttempt): Promise<RecordModelCallResult> {
        return await new Promise<RecordModelCallResult>((resolve, reject) => {
            pending.waiters.push({ resolve, reject });
        });
    }

    private kickDrain(): void {
        if (!this.acceptingDispatches) return;
        if (!this.drainOperation) {
            this.drainOperation = this.drain()
                .catch(error => {
                    for (const key of [...this.pending.keys()]) this.rejectPending(key, error);
                })
                .finally(() => {
                    this.drainOperation = undefined;
                });
        }
    }

    private async serializeCoordinatorMutation<Value>(operation: () => Promise<Value>): Promise<Value> {
        const next = this.coordinatorMutationTail.then(operation, operation);
        this.coordinatorMutationTail = next.then(() => undefined, () => undefined);
        return await next;
    }

    private async drain(): Promise<void> {
        while (this.acceptingDispatches && this.pending.size > 0) {
            const dispatched = await this.serializeCoordinatorMutation(async () => await this.dispatchOne());
            if (!dispatched) return;
        }
    }

    private async dispatchOne(): Promise<boolean> {
        if (!this.acceptingDispatches) return false;
        const session = await this.openCoordinatorSession();
        let permitCandidate: PreparedModelAttempt | undefined;
        let step: Awaited<ReturnType<RecordSchedulerCoordinator["step"]>>;
        try {
            step = await session.coordinator.step(async candidate => {
                const pending = this.findPendingForUnit(candidate.taskId, candidate.recordId, candidate.unitId);
                if (!pending) return false;
                let prepared = pending.prepared;
                const admission = providerAdmission(prepared.provider);
                if (admission === "synthetic") {
                    permitCandidate = prepared;
                    await this.ensureModelAttemptIntent(prepared);
                    return {
                        granted: true,
                        permitId: `synthetic:${prepared.attemptId}`,
                        attemptId: prepared.attemptId,
                        dispatchPhase: "permit-granted",
                        providerAdmission: admission,
                        providerEvidence: `synthetic:${prepared.provider}:${prepared.attemptId}`,
                    };
                }
                let provider = physicalProvider(prepared.provider);
                await this.reconcileUnboundProviderLease(prepared, provider);
                permitCandidate = prepared;
                let lease = await this.transport.tryAcquire(provider, {
                    trafficClass: prepared.trafficClass,
                    attemptId: prepared.attemptId,
                });
                if (!lease) {
                    const overflow = await this.prepareFirstRunOverflowAttempt(prepared);
                    if (overflow) {
                        const overflowProvider = physicalProvider(overflow.provider);
                        await this.reconcileUnboundProviderLease(overflow, overflowProvider);
                        permitCandidate = overflow;
                        const overflowLease = await this.transport.tryAcquire(overflowProvider, {
                            trafficClass: overflow.trafficClass,
                            attemptId: overflow.attemptId,
                        });
                        if (overflowLease) {
                            prepared = overflow;
                            pending.prepared = overflow;
                            permitCandidate = overflow;
                            provider = overflowProvider;
                            lease = overflowLease;
                        }
                    }
                }
                if (!lease) {
                    permitCandidate = undefined;
                    return { granted: false };
                }
                this.leaseByAttempt.set(prepared.attemptId, lease);
                const leaseIdentity = requirePhysicalLeaseIdentity(lease, provider, prepared.attemptId, prepared.trafficClass);
                await this.ensureModelAttemptIntent(prepared);
                return {
                    granted: true,
                    permitId: lease.permitId,
                    attemptId: prepared.attemptId,
                    dispatchPhase: "permit-granted",
                    providerAdmission: admission,
                    providerEvidence: `provider-transport:${leaseIdentity.provider}:${leaseIdentity.leaseId}:${leaseIdentity.ownerEpoch}:${leaseIdentity.capacityGeneration}`,
                    providerLeaseIdentity: leaseIdentity,
                    release: async () => {
                        await this.releaseUnconsumedLease(prepared.attemptId);
                    },
                };
            });
        } catch (error) {
            if (!permitCandidate) throw error;
            await this.failClosedPermitGrantFailure(session, permitCandidate, error);
            return false;
        }
        if (!step.dispatched) {
            await this.persistCoordinator(session);
            await this.suspendDispatchablePending(step);
            return false;
        }
        if (!isNonEmptyString(step.claim.attemptId)) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `已派发 coordinator claim ${step.claim.claimId} 缺少 attemptId`);
        }
        try {
            await this.persistCoordinator(session);
        } catch (error) {
            await this.failClosedAfterGrantPersistFailure(session, step.claim, this.pending.get(pendingIdentityKey(step.claim.taskId, step.claim.recordId, step.claim.unitId, step.claim.attemptId)), error);
            return false;
        }
        const pending = this.pending.get(pendingIdentityKey(step.claim.taskId, step.claim.recordId, step.claim.unitId, step.claim.attemptId));
        if (!pending) {
            await session.coordinator.settleClaim(step.claim, { actualCost: 0, status: "queued" });
            await this.persistCoordinator(session);
            return true;
        }
        await this.dispatchPending(session, step.claim, pending);
        return true;
    }

    private async suspendDispatchablePending(
        step: Extract<Awaited<ReturnType<RecordSchedulerCoordinator["step"]>>, { dispatched: false }>,
    ): Promise<void> {
        const pending = [...this.pending.entries()]
            .filter(([, candidate]) => !this.runningByAttempt.has(candidate.prepared.attemptId));
        if (pending.length === 0) return;
        if (step.reason === "repair-required" || step.reason === "prompt-unavailable") {
            const error = new RecordSchedulerExecutionDriverError(
                "REPAIR_REQUIRED",
                `coordinator 无法继续 provider handoff: ${step.reason}`,
            );
            for (const [key] of pending) this.rejectPending(key, error);
            return;
        }
        const now = this.nowMs();
        const wakeAtMs = step.nextWakeAt !== undefined && Number.isFinite(step.nextWakeAt) && step.nextWakeAt > now
            ? step.nextWakeAt
            : now + PROVIDER_BLOCKED_WAKE_MS;
        const ledgerRevisionByTask = new Map<string, number>();
        for (const [key, candidate] of pending) {
            const taskId = candidate.prepared.registration.taskId;
            let ledgerRevision = ledgerRevisionByTask.get(taskId);
            if (ledgerRevision === undefined) {
                ledgerRevision = (await requireLedger(taskId)).revision;
                ledgerRevisionByTask.set(taskId, ledgerRevision);
            }
            this.rejectPending(key, createBackgroundTaskSuspension({
                taskId,
                wakeAt: new Date(wakeAtMs).toISOString(),
                waitingReason: step.reason === "waiting-provider"
                    ? `record-scheduler:waiting-provider:${physicalProvider(candidate.prepared.provider)}`
                    : `record-scheduler:${step.reason}`,
                ledgerRevision,
            }));
        }
    }

    private async reconcileUnboundProviderLease(prepared: PreparedModelAttempt, provider: ProviderId): Promise<void> {
        const recovered = await this.transport.recoverAttempt(provider, prepared.attemptId);
        if (recovered.kind === "absent") return;
        if (recovered.kind === "corrupt") {
            throw new RecordSchedulerExecutionDriverError(
                "REPAIR_REQUIRED",
                `Attempt ${prepared.attemptId} 的 unbound provider recovery 已损坏：${recovered.detail}`,
            );
        }
        if (recovered.kind === "uncertain") {
            throw new RecordSchedulerExecutionDriverError(
                "REPAIR_REQUIRED",
                `Attempt ${prepared.attemptId} 在持久 intent 前发现 uncertain provider lease，无法证明 RPC 未发生`,
            );
        }
        if (recovered.identity.trafficClass !== prepared.trafficClass) {
            throw new RecordSchedulerExecutionDriverError(
                "REPAIR_REQUIRED",
                `Attempt ${prepared.attemptId} 的 recovered trafficClass=${recovered.identity.trafficClass} 与冻结值 ${prepared.trafficClass} 不一致`,
            );
        }
        const settled = await this.transport.cancelRecoveredLease(recovered.identity);
        if (settled.kind !== "settled" && settled.kind !== "already-settled") {
            throw new RecordSchedulerExecutionDriverError(
                "REPAIR_REQUIRED",
                `Attempt ${prepared.attemptId} 的 unbound provider lease 无法安全回收`,
            );
        }
    }

    private wakeProviderBlockedTasks(provider: ProviderId): void {
        if (!this.acceptingDispatches || this.closed) return;
        const taskIds = [...new Set([...this.registrations.values()].map(registration => registration.taskId))];
        for (const taskId of taskIds) {
            const task = getBackgroundTask(taskId);
            if (task?.status !== "suspended"
                || task.waitingReason !== `record-scheduler:waiting-provider:${provider}`
                || !Number.isSafeInteger(task.suspensionRevision)
                || !Number.isSafeInteger(task.suspensionLedgerRevision)) continue;
            wakeBackgroundTask(taskId, {
                suspensionRevision: task.suspensionRevision!,
                ledgerRevision: task.suspensionLedgerRevision!,
            });
        }
    }

    private findPendingForUnit(taskId: string, recordId: string, unitId: string): PendingAttempt | undefined {
        const matches = [...this.pending.values()].filter(candidate => candidate.prepared.registration.taskId === taskId
            && candidate.prepared.identity.conversationId === recordId
            && candidate.prepared.unitId === unitId);
        return matches.sort((left, right) => attemptOrdinal(right.prepared.attemptId, unitId) - attemptOrdinal(left.prepared.attemptId, unitId))[0];
    }

    private async failClosedPermitGrantFailure(
        session: CoordinatorSession,
        prepared: PreparedModelAttempt,
        error: unknown,
    ): Promise<void> {
        const cleanupFailures: unknown[] = [];
        try {
            await this.releaseUnconsumedLease(prepared.attemptId);
        } catch (releaseError) {
            cleanupFailures.push(releaseError);
        }
        try {
            const recovered = await this.transport.recoverAttempt(physicalProvider(prepared.provider), prepared.attemptId);
            if (recovered.kind === "corrupt") {
                cleanupFailures.push(new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `provider recovery corrupt after permit grant failure: ${recovered.detail}`));
            } else if (recovered.kind === "active") {
                await this.cancelRecoveredLease(recovered.identity);
            } else if (recovered.kind === "uncertain") {
                cleanupFailures.push(new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "provider recovery remains uncertain after permit grant failure"));
            }
        } catch (recoveryError) {
            cleanupFailures.push(recoveryError);
        }
        try {
            await this.markTaskRepair(prepared, `provider permit grant failed before coordinator claim: ${errorMessage(error)}`);
        } catch (repairError) {
            cleanupFailures.push(repairError);
        }
        try {
            await this.persistCoordinator(session);
        } catch (persistError) {
            cleanupFailures.push(persistError);
        }
        const cleanupDetail = cleanupFailures.length === 0
            ? ""
            : `; cleanup failures: ${cleanupFailures.map(errorMessage).join(" | ")}`;
        this.rejectPending(
            attemptKey(prepared),
            new RecordSchedulerExecutionDriverError(
                "REPAIR_REQUIRED",
                `provider permit grant failed before coordinator claim: ${errorMessage(error)}${cleanupDetail}`,
            ),
        );
    }

    private async dispatchPending(
        session: CoordinatorSession,
        claim: RecordSchedulerCoordinatorClaim,
        pending: PendingAttempt,
    ): Promise<void> {
        const prepared = pending.prepared;
        const key = attemptKey(prepared);
        try {
            await this.emitPhase({
                phase: "grant-persisted",
                taskId: prepared.registration.taskId,
                unitId: prepared.unitId,
                attemptId: prepared.attemptId,
                claim,
            });
        } catch (error) {
            await this.discardUnboundClaim(session, claim, prepared, error);
            return;
        }
        let bound = false;
        try {
            await this.bindAttempt(prepared, claim, "attempt-bound");
            bound = true;
            await session.coordinator.bindClaim(claim, {
                claimId: claim.claimId,
                permitId: claim.permitId,
                dispatchSeq: claim.dispatchSeq,
                attemptId: prepared.attemptId,
                dispatchPhase: "attempt-bound",
                providerAdmission: requireClaimAdmission(claim),
                providerEvidence: requireClaimEvidence(claim),
                providerLeaseIdentity: claimProviderLeaseIdentity(claim),
            });
            await this.persistCoordinator(session);
            await this.emitPhase({ phase: "attempt-bound", taskId: prepared.registration.taskId, unitId: prepared.unitId, attemptId: prepared.attemptId, claim });
            await this.bindAttempt(prepared, claim, "invoking");
            await session.coordinator.bindClaim(claim, {
                claimId: claim.claimId,
                permitId: claim.permitId,
                dispatchSeq: claim.dispatchSeq,
                attemptId: prepared.attemptId,
                dispatchPhase: "invoking",
                providerAdmission: requireClaimAdmission(claim),
                providerEvidence: requireClaimEvidence(claim),
                providerLeaseIdentity: claimProviderLeaseIdentity(claim),
            });
            await this.persistCoordinator(session);
            await this.emitPhase({ phase: "before-invoke", taskId: prepared.registration.taskId, unitId: prepared.unitId, attemptId: prepared.attemptId, claim });
            await this.assertClaimBinding(prepared, claim);
        } catch (error) {
            if (bound) await this.settlePreInvokeFailure(session, claim, prepared, error);
            else await this.discardUnboundClaim(session, claim, prepared, error);
            return;
        }
        this.startRunningInvocation(prepared, claim);
    }

    private startRunningInvocation(prepared: PreparedModelAttempt, claim: RecordSchedulerCoordinatorClaim): void {
        if (this.runningByAttempt.has(prepared.attemptId)) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${prepared.attemptId} has duplicate in-memory RPC runner`);
        }
        const running = this.runProviderInvocation(prepared, claim)
            .catch(error => {
                this.rejectPending(attemptKey(prepared), error);
            })
            .finally(() => {
                this.runningByAttempt.delete(prepared.attemptId);
                this.scheduleClosedCleanup();
                this.kickDrain();
            });
        this.runningByAttempt.set(prepared.attemptId, running);
    }

    private async runProviderInvocation(prepared: PreparedModelAttempt, claim: RecordSchedulerCoordinatorClaim): Promise<void> {
        const key = attemptKey(prepared);
        let result: RecordModelCallResult;
        let invokeStarted = false;
        try {
            const lease = this.leaseByAttempt.get(prepared.attemptId);
            assertInvokeLeaseBinding(prepared, claim, lease);
            const persistedAttempt = await this.readAttempt(prepared);
            if (persistedAttempt.idempotencyKey !== prepared.idempotencyKey) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${prepared.attemptId} 的 ledger idempotencyKey 不一致`);
            }
            invokeStarted = true;
            result = await prepared.providerCall.invoke({
                ...(lease ? { transportLease: lease } : {}),
                attemptId: prepared.attemptId,
                idempotencyKey: persistedAttempt.idempotencyKey,
            });
            this.leaseByAttempt.delete(prepared.attemptId);
        } catch (error) {
            if (!invokeStarted) {
                try {
                    await this.releaseUnconsumedLease(prepared.attemptId);
                } catch (releaseError) {
                    await this.serializeCoordinatorMutation(async () => {
                        await this.markTaskRepair(prepared, `pre-invoke physical lease release failed: ${errorMessage(releaseError)}`);
                    });
                    this.rejectPending(key, releaseError);
                    return;
                }
            } else {
                this.leaseByAttempt.delete(prepared.attemptId);
            }
            try {
                await this.serializeCoordinatorMutation(async () => {
                    await this.settleInvocationFailure(prepared, claim, error, invokeStarted);
                });
            } catch (settleError) {
                this.rejectPending(key, settleError);
            }
            return;
        }
        try {
            await this.serializeCoordinatorMutation(async () => {
                await this.settleInvocationResult(prepared, claim, result);
            });
        } catch (error) {
            this.rejectPending(key, error);
        }
    }

    private async settleInvocationResult(
        prepared: PreparedModelAttempt,
        claim: RecordSchedulerCoordinatorClaim,
        result: RecordModelCallResult,
    ): Promise<void> {
        const session = await this.openCoordinatorSession();
        let cancelled = false;
        if (result.text !== null && result.text !== undefined) {
            const output = Buffer.from(JSON.stringify(result), "utf8");
            await this.emitAttemptPhase("provider-result-received", prepared, claim, {
                hash: sha256(output),
                byteLength: output.byteLength,
            });
            cancelled = await this.markKnownSuccess(prepared, claim, result);
            await session.coordinator.settleClaim(claim, {
                actualCost: claim.candidate.estimatedCost,
                status: cancelled ? "cancelled" : "done",
            });
        } else {
            cancelled = await this.markKnownFailure(prepared, claim, result);
            await session.coordinator.settleClaim(claim, {
                actualCost: claim.candidate.estimatedCost,
                status: cancelled || result.cancelled ? "cancelled" : "failed",
            });
        }
        await this.persistCoordinator(session);
        if (cancelled) {
            const cancellation = await prepared.registration.control.cancel(prepared.registration.taskId);
            if (cancellation.disposition === "repair_required") {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", cancellation.reason || "迟到 provider 结果丢弃后取消清理失败");
            }
            this.resolvePending(attemptKey(prepared), {
                text: null,
                cancelled: true,
                error: "Record scheduler task 已取消，迟到 provider 结果已丢弃",
                chainUsed: result.chainUsed,
                modelUsed: result.modelUsed,
            });
            return;
        }
        this.resolvePending(attemptKey(prepared), result);
    }

    private async settleInvocationFailure(
        prepared: PreparedModelAttempt,
        claim: RecordSchedulerCoordinatorClaim,
        error: unknown,
        invokeStarted: boolean,
    ): Promise<void> {
        const session = await this.openCoordinatorSession();
        if (invokeStarted) await this.markUnknownOutcome(prepared, claim, error);
        else await this.markKnownPreInvokeFailure(prepared, claim, error);
        await session.coordinator.settleClaim(claim, { actualCost: invokeStarted ? claim.candidate.estimatedCost : 0, status: "failed" });
        await this.persistCoordinator(session);
        if (invokeStarted) this.rejectPending(attemptKey(prepared), error);
        else this.resolvePending(attemptKey(prepared), preInvokeFailureResult(error));
    }

    private async settlePreInvokeFailure(
        session: CoordinatorSession,
        claim: RecordSchedulerCoordinatorClaim,
        prepared: PreparedModelAttempt,
        error: unknown,
    ): Promise<void> {
        if (errorCode(error) === "REPAIR_REQUIRED") {
            await this.failClosedPreInvokeRepair(session, claim, prepared, error);
            return;
        }
        const result = preInvokeFailureResult(error);
        try {
            await this.markKnownPreInvokeFailure(prepared, claim, error);
            await session.coordinator.settleClaim(claim, { actualCost: 0, status: "failed" });
            await this.persistCoordinator(session);
            this.resolvePending(attemptKey(prepared), result);
        } catch (settleError) {
            await this.failClosedPreInvokeRepair(session, claim, prepared, settleError);
        }
    }

    private async failClosedPreInvokeRepair(
        session: CoordinatorSession,
        claim: RecordSchedulerCoordinatorClaim,
        prepared: PreparedModelAttempt,
        error: unknown,
    ): Promise<void> {
        const cleanupFailures: unknown[] = [];
        try {
            await this.releaseUnconsumedLease(prepared.attemptId);
        } catch (releaseError) {
            cleanupFailures.push(releaseError);
        }
        try {
            await this.markUnknownOutcome(prepared, claim, error);
        } catch (markError) {
            cleanupFailures.push(markError);
        }
        try {
            const activeClaim = session.coordinator.snapshot().activeClaims
                .find(candidate => candidate.claimId === claim.claimId);
            if (activeClaim) {
                await session.coordinator.settleClaim(claim, { actualCost: 0, status: "failed" });
            }
            await this.persistCoordinator(session);
        } catch (settleError) {
            cleanupFailures.push(settleError);
        }
        try {
            await this.markTaskRepair(prepared, `pre-invoke integrity failure: ${errorMessage(error)}`);
        } catch (repairError) {
            cleanupFailures.push(repairError);
        }
        const cleanupDetail = cleanupFailures.length === 0
            ? ""
            : `; cleanup failures: ${cleanupFailures.map(errorMessage).join(" | ")}`;
        this.rejectPending(
            attemptKey(prepared),
            new RecordSchedulerExecutionDriverError(
                "REPAIR_REQUIRED",
                `pre-invoke Attempt/claim integrity failure: ${errorMessage(error)}${cleanupDetail}`,
            ),
        );
    }

    private async markKnownPreInvokeFailure(
        prepared: ManagedDispatchIdentity,
        claim: CoordinatorClaimBinding,
        error: unknown,
    ): Promise<void> {
        const initial = await requireLedger(prepared.registration.taskId);
        const initialWork = requireWork(initial, prepared.recordWorkKey);
        const initialUnit = requireUnit(initial, prepared.unitId);
        const initialAttempt = requireAttempt(initial, prepared.attemptId);
        if (initialAttempt.state !== "Dispatched" || !claimIdentityMatchesAttempt(initialAttempt, claim)
            || (initialAttempt.dispatchPhase !== "attempt-bound" && initialAttempt.dispatchPhase !== "invoking")) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "pre-invoke failure cannot safely settle a mismatched dispatch");
        }
        let resolved: ResolvedRecordWorkFence | undefined;
        let registryRef: ImmutableBlobReference | undefined;
        if (initialUnit.retryBudget > 0) {
            resolved = await this.resolveRetryFence(
                prepared.registration,
                prepared.ownerLease,
                prepared.identity,
                initialWork,
                initialAttempt,
                initial,
                "pre-invoke failure",
            );
            registryRef = await registryReference(prepared.registration.control.dataRoot, resolved.path, resolved.registry);
        }
        await this.mutateOwnerLedger(prepared.registration.taskId, prepared.ownerLease, ledger => {
            const work = requireWork(ledger, prepared.recordWorkKey);
            const unit = requireUnit(ledger, prepared.unitId);
            const attempt = requireAttempt(ledger, prepared.attemptId);
            if (attempt.state !== "Dispatched" || !claimIdentityMatchesAttempt(attempt, claim)
                || (attempt.dispatchPhase !== "attempt-bound" && attempt.dispatchPhase !== "invoking")) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "pre-invoke failure cannot safely settle a mismatched dispatch");
            }
            const beforeFence = currentFence(work);
            if (resolved && registryRef) {
                const expectedFence = currentFence(initialWork);
                if (!sameFence(beforeFence, expectedFence) && !sameFence(beforeFence, resolved.fence)) {
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `pre-invoke Attempt ${attempt.attemptId} 的 scheduler fence 与 registry 漂移`);
                }
                work.registryRevision = resolved.registry.registryRevision;
                work.registryRef = registryRef;
                work.schedulerEpoch = resolved.fence.schedulerEpoch;
                work.workLeaseId = resolved.fence.workLeaseId;
                work.leaseOwnerId = resolved.lease.ownerId;
                work.leaseExpiresAt = resolved.lease.expiresAt;
                work.activeTaskIds = [...resolved.work.activeTaskIds];
                work.currentFencingToken = resolved.fence.fencingToken;
                for (const candidate of ledger.attempts) {
                    if (candidate.attemptId === attempt.attemptId
                        || candidate.recordWorkKey !== work.recordWorkKey
                        || !["Created", "DispatchIntentPersisted", "Dispatched", "KnownSuccess"].includes(candidate.state)) continue;
                    if (!sameFence(candidate.fence, beforeFence) && !sameFence(candidate.fence, resolved.fence)) {
                        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${candidate.attemptId} 无法迁移到 pre-invoke retry 新 fence`);
                    }
                    candidate.fence = { ...resolved.fence };
                    if (candidate.leaseExpiresAt) candidate.leaseExpiresAt = resolved.lease.expiresAt;
                }
                for (const commit of ledger.commits) {
                    if (commit.recordWorkKey !== work.recordWorkKey
                        || !["ResultReady", "BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten", "Verified", "CleanupPending"].includes(commit.state)) continue;
                    if (!sameFence(commit.fence, beforeFence) && !sameFence(commit.fence, resolved.fence)) {
                        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Commit ${commit.commitId} 无法迁移到 pre-invoke retry 新 fence`);
                    }
                    commit.fence = { ...resolved.fence };
                    if (commit.beforeImage) commit.beforeImage.fence = { ...resolved.fence };
                    if (commit.cleanupReadBack) commit.cleanupReadBack.fence = { ...resolved.fence };
                }
            }
            assertAttemptTransition(attempt.state, "KnownFailure");
            attempt.state = "KnownFailure";
            attempt.outcome = "known_failure";
            attempt.dispatchPhase = "invoking";
            attempt.errorClass = "Persistence";
            attempt.providerEvidence = `${requireClaimEvidence(claim)};pre-invoke:${errorMessage(error)}`;
            attempt.elapsedMs = elapsedMs(attempt.startedAt);
            if (!resolved) attempt.fence = currentFence(work);
            if (unit.retryBudget > 0) {
                unit.retryBudget -= 1;
                assertUnitTransition(unit.state, "WaitingRetry");
                unit.state = "WaitingRetry";
                unit.failureClass = undefined;
                unit.nextEligibleAt = undefined;
                unit.enqueueTime = new Date().toISOString();
                unit.layerEnterTime = new Date().toISOString();
                assertUnitTransition(unit.state, "Queued");
                unit.state = "Queued";
            } else {
                assertUnitTransition(unit.state, "FailedFinal");
                unit.state = "FailedFinal";
                unit.failureClass = "Persistence";
            }
            refreshUnitCounters(ledger);
        });
        await this.emitPhase({ phase: "known-failure", taskId: prepared.registration.taskId, unitId: prepared.unitId, attemptId: prepared.attemptId, claim });
    }

    private async markTaskRepair(prepared: ManagedDispatchIdentity, detail: string): Promise<void> {
        await this.mutateOwnerLedger(prepared.registration.taskId, prepared.ownerLease, ledger => {
            if (ledger.task.state !== "RepairRequired") {
                assertTaskTransition(ledger.task.state, "RepairRequired");
                ledger.task.state = "RepairRequired";
                ledger.task.terminalState = "RepairRequired";
                ledger.task.repairState = "Required";
                ledger.task.updatedAt = new Date().toISOString();
            }
            const attempt = ledger.attempts.find(candidate => candidate.attemptId === prepared.attemptId);
            if (attempt) attempt.providerEvidence = `${attempt.providerEvidence || "repair"};repair:${detail}`;
            refreshUnitCounters(ledger);
        });
    }

    private async discardUnboundClaim(
        session: CoordinatorSession,
        claim: RecordSchedulerCoordinatorClaim,
        prepared: PreparedModelAttempt,
        error: unknown,
    ): Promise<void> {
        await this.mutateOwnerLedger(prepared.registration.taskId, prepared.ownerLease, ledger => {
            const unit = requireUnit(ledger, prepared.unitId);
            const attempt = requireAttempt(ledger, prepared.attemptId);
            if (attempt.state === "DispatchIntentPersisted") {
                attempt.providerEvidence = `unbound-grant-released:${errorMessage(error)}`;
                if (unit.state !== "Queued") {
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "unbound grant 对应 Unit 在 bind 前已离开 Queued");
                }
            }
            refreshUnitCounters(ledger);
        });
        await session.coordinator.settleClaim(claim, { actualCost: 0, status: "queued" });
        await this.persistCoordinator(session);
        this.rejectPending(attemptKey(prepared), error);
    }

    private async failClosedAfterGrantPersistFailure(
        session: CoordinatorSession,
        claim: RecordSchedulerCoordinatorClaim,
        pending: PendingAttempt | undefined,
        error: unknown,
    ): Promise<void> {
        const prepared = pending?.prepared;
        const persistence = await this.readPersistedClaimState(claim);
        let releaseError: unknown;
        try {
            await session.coordinator.settleClaim(claim, { actualCost: 0, status: "queued" });
        } catch (settleError) {
            releaseError = settleError;
        }
        const physicalLeaseOutstanding = requireClaimAdmission(claim) === "provider-transport"
            && prepared !== undefined
            && this.leaseByAttempt.has(prepared.attemptId);
        if (prepared === undefined || persistence !== "absent" || physicalLeaseOutstanding || releaseError !== undefined) {
            if (prepared !== undefined) {
                await this.markGrantPersistRepair(prepared, errorMessage(releaseError || error));
                this.rejectPending(attemptKey(prepared), error);
            }
            return;
        }
        try {
            await this.persistCoordinator(session);
        } catch (cleanupError) {
            const cleanupPersistence = await this.readPersistedClaimState(claim);
            if (cleanupPersistence !== "absent") {
                await this.markGrantPersistRepair(prepared, errorMessage(cleanupError));
                this.rejectPending(attemptKey(prepared), error);
                return;
            }
        }
        await this.recordUnboundGrantRelease(prepared, error);
        this.rejectPending(attemptKey(prepared), error);
    }

    private async readPersistedClaimState(claim: RecordSchedulerCoordinatorClaim): Promise<"absent" | "present" | "uncertain"> {
        try {
            const stored = await readRecordSchedulerCoordinatorStore(this.options.coordinatorStore);
            if (stored.kind === "missing") return "absent";
            if (stored.kind !== "current") return "uncertain";
            return stored.snapshot.activeClaims.some(candidate => candidate.claimId === claim.claimId
                && candidate.permitId === claim.permitId
                && candidate.dispatchSeq === claim.dispatchSeq)
                ? "present"
                : "absent";
        } catch {
            return "uncertain";
        }
    }

    private async markGrantPersistRepair(prepared: PreparedModelAttempt, detail: string): Promise<void> {
        await this.mutateOwnerLedger(prepared.registration.taskId, prepared.ownerLease, ledger => {
            const attempt = requireAttempt(ledger, prepared.attemptId);
            if (attempt.state === "DispatchIntentPersisted") {
                attempt.providerEvidence = `grant-persist-uncertain:${detail}`;
            }
            if (ledger.task.state !== "RepairRequired") {
                assertTaskTransition(ledger.task.state, "RepairRequired");
                ledger.task.state = "RepairRequired";
                ledger.task.terminalState = "RepairRequired";
                ledger.task.repairState = "Required";
                ledger.task.updatedAt = new Date().toISOString();
            }
            refreshUnitCounters(ledger);
        });
    }

    private async recordUnboundGrantRelease(prepared: PreparedModelAttempt, error: unknown): Promise<void> {
        await this.mutateOwnerLedger(prepared.registration.taskId, prepared.ownerLease, ledger => {
            const unit = requireUnit(ledger, prepared.unitId);
            const attempt = requireAttempt(ledger, prepared.attemptId);
            if (attempt.state !== "DispatchIntentPersisted" || unit.state !== "Queued") {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "grant 持久化失败后 Attempt/Unit 已离开未绑定状态");
            }
            attempt.providerEvidence = `unbound-grant-released:${errorMessage(error)}`;
            refreshUnitCounters(ledger);
        });
    }

    private async prepareModelAttempt(
        registration: RecordSchedulerProductionRegistration,
        call: RecordSchedulerModelCallContext,
        descriptor: ModelUnitDescriptor,
        providerCall: RecordSchedulerProviderCall,
        trafficClassOverride?: ProviderTrafficClass,
    ): Promise<PreparedModelAttempt> {
        if (registration.control.spool !== registration.spool) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "production pump 要求 control 与 hook 使用同一 RecordSchedulerSpool 实例");
        }
        const source = selectSource(registration.frozenSources, registration.sourceSnapshotId);
        await registration.spool.initializeRoot({ mode: "create" });
        await registration.spool.initializeTask({ taskId: registration.taskId, mode: "create" });
        await assertFrozenSourceMatchesLedger(registration.taskId, source);
        const ownerLease = await this.getOrRecoverTaskOwner(registration);
        const identity = canonicalIdentity(source);
        const workKey = await this.ensureRecordWork(registration, source, identity, ownerLease);
        const inputHash = this.modelUnitInputHash(registration, call, descriptor, source.snapshot.sourceSnapshotId);
        const unitId = descriptor.unitId;
        const routeIndex = call.routePlan.indexOf(providerCall.provider);
        if (routeIndex < 0) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `provider ${providerCall.provider} 不在冻结 routePlan 中`);
        await this.advanceExpiredUnknownOutcome(registration, ownerLease, identity, workKey, unitId);
        const attemptOrdinal = await this.selectModelAttemptOrdinal(registration.taskId, unitId);
        const attemptId = `${unitId}:attempt:${attemptOrdinal}`;
        const currentLedger = await requireLedger(registration.taskId);
        const existingAttempt = currentLedger.attempts.find(candidate => candidate.attemptId === attemptId);
        const retryOrdinal = existingAttempt?.retryOrdinal
            ?? currentLedger.attempts.filter(candidate => candidate.unitId === unitId && candidate.provider === providerCall.provider).length;
        const idempotencyKey = stableId("record-provider-attempt", {
            taskId: registration.taskId,
            unitId,
            attemptId,
        });
        const prepared: PreparedModelAttempt = {
            registration,
            source,
            ownerLease,
            identity,
            recordWorkKey: workKey,
            unitId,
            attemptId,
            idempotencyKey,
            inputHash,
            provider: providerCall.provider,
            model: providerCall.model,
            routeIndex,
            retryOrdinal,
            trafficClass: trafficClassOverride ?? this.providerTrafficClass(call, providerCall.provider, routeIndex),
            providerCall,
            descriptor,
            call,
        };
        await this.ensureModelUnit(prepared);
        await this.emitPhase({ phase: "unit-prepared", taskId: registration.taskId, unitId, attemptId });
        return prepared;
    }

    private async ensureModelUnit(prepared: PreparedModelAttempt): Promise<void> {
        await this.mutateOwnerLedger(prepared.registration.taskId, prepared.ownerLease, ledger => {
            const work = requireWork(ledger, prepared.recordWorkKey);
            let unit = ledger.units.find(candidate => candidate.unitId === prepared.unitId);
            if (!unit) {
                unit = createPreparedModelUnit(prepared, work);
                ledger.units.push(unit);
            } else assertPreparedModelUnitMatches(unit, prepared, work);
            refreshUnitCounters(ledger);
        });
    }

    private async ensureModelAttemptIntent(prepared: PreparedModelAttempt): Promise<void> {
        const intent = await prepared.registration.spool.writeImmutable({
            taskId: prepared.registration.taskId,
            kind: "source",
            content: JSON.stringify({
                schemaVersion: PUMP_SCHEMA_VERSION,
                kind: "record-scheduler-provider-dispatch-intent",
                taskId: prepared.registration.taskId,
                sourceSnapshotId: prepared.source.snapshot.sourceSnapshotId,
                recordWorkKey: prepared.recordWorkKey,
                unitId: prepared.unitId,
                attemptId: prepared.attemptId,
                logicalCallKey: prepared.call.logicalCallKey,
                inputHash: prepared.inputHash,
                idempotencyKey: prepared.idempotencyKey,
                provider: prepared.provider,
                model: prepared.model,
                routeIndex: prepared.routeIndex,
                retryOrdinal: prepared.retryOrdinal,
                recipe: prepared.descriptor.recipe,
            }),
        });
        await this.mutateOwnerLedger(prepared.registration.taskId, prepared.ownerLease, ledger => {
            const work = requireWork(ledger, prepared.recordWorkKey);
            const unit = ledger.units.find(candidate => candidate.unitId === prepared.unitId);
            if (!unit) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt intent ${prepared.attemptId} 缺少先行持久化的 Unit ${prepared.unitId}`);
            assertPreparedModelUnitMatches(unit, prepared, work);
            let attempt = ledger.attempts.find(candidate => candidate.attemptId === prepared.attemptId);
            if (!attempt) {
                attempt = {
                    attemptId: prepared.attemptId,
                    unitId: prepared.unitId,
                    recordWorkKey: work.recordWorkKey,
                    originTaskIds: [prepared.registration.taskId],
                    activeTaskIds: [prepared.registration.taskId],
                    state: "Created",
                    provider: prepared.provider,
                    model: prepared.model,
                    inputHash: prepared.inputHash,
                    idempotencyKey: prepared.idempotencyKey,
                    managedByProductionPump: true,
                    retryOrdinal: prepared.retryOrdinal,
                    trafficClass: prepared.trafficClass,
                    fence: currentFence(work),
                };
                ledger.attempts.push(attempt);
                unit.unitAttempts = (unit.unitAttempts || 0) + 1;
                unit.providerAttemptCounts = {
                    ...(unit.providerAttemptCounts || {}),
                    [prepared.provider]: (unit.providerAttemptCounts?.[prepared.provider] || 0) + 1,
                };
                unit.routeCursor = prepared.routeIndex;
            } else if (attempt.unitId !== prepared.unitId
                || attempt.recordWorkKey !== work.recordWorkKey
                || attempt.inputHash !== prepared.inputHash
                || attempt.provider !== prepared.provider
                || attempt.model !== prepared.model
                || attempt.managedByProductionPump !== true
                || attempt.retryOrdinal !== prepared.retryOrdinal
                || attempt.trafficClass !== prepared.trafficClass
                || attempt.idempotencyKey !== prepared.idempotencyKey) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "稳定 logicalCallKey 对应的 Attempt 与 provider/model 不一致");
            }
            if (attempt.state === "Created") {
                assertAttemptTransition(attempt.state, "DispatchIntentPersisted");
                attempt.state = "DispatchIntentPersisted";
                attempt.dispatchIntentAt = new Date().toISOString();
                attempt.dispatchIntentLedgerRevision = ledger.revision + 1;
                attempt.dispatchIntentRef = intent.reference;
                attempt.fence = currentFence(work);
            }
            refreshUnitCounters(ledger);
        });
        await this.emitPhase({ phase: "intent-persisted", taskId: prepared.registration.taskId, unitId: prepared.unitId, attemptId: prepared.attemptId });
    }

    private async bindAttempt(
        prepared: PreparedModelAttempt,
        claim: RecordSchedulerCoordinatorClaim,
        phase: "attempt-bound" | "invoking",
    ): Promise<void> {
        const admission = requireClaimAdmission(claim);
        const evidence = requireClaimEvidence(claim);
        await this.mutateOwnerLedger(prepared.registration.taskId, prepared.ownerLease, ledger => {
            const work = requireWork(ledger, prepared.recordWorkKey);
            const unit = requireUnit(ledger, prepared.unitId);
            const attempt = requireAttempt(ledger, prepared.attemptId);
            if (attempt.state === "DispatchIntentPersisted") {
                assertAttemptTransition(attempt.state, "Dispatched");
                assertUnitTransition(unit.state, "Running");
                attempt.state = "Dispatched";
                attempt.outcome = "dispatched";
                attempt.startedAt = new Date().toISOString();
                attempt.leaseExpiresAt = work.leaseExpiresAt;
                unit.state = "Running";
                unit.attemptedProviders = unit.attemptedProviders.includes(prepared.provider)
                    ? unit.attemptedProviders
                    : [...unit.attemptedProviders, prepared.provider];
            }
            const hasPriorClaimBinding = attempt.claimId !== undefined
                || attempt.permitId !== undefined
                || attempt.dispatchSeq !== undefined
                || attempt.dispatchPhase !== undefined
                || attempt.providerAdmission !== undefined
                || attempt.providerLeaseIdentity !== undefined;
            if (attempt.state !== "Dispatched"
                || hasPriorClaimBinding && (attempt.claimId !== claim.claimId
                    || attempt.permitId !== claim.permitId
                    || attempt.dispatchSeq !== claim.dispatchSeq
                    || attempt.providerEvidence !== evidence
                    || !sameProviderLeaseIdentity(attempt.providerLeaseIdentity, claimProviderLeaseIdentity(claim)))) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "Attempt 与 active coordinator claim 的 binding 不一致");
            }
            attempt.claimId = claim.claimId;
            attempt.permitId = claim.permitId;
            attempt.dispatchSeq = claim.dispatchSeq;
            attempt.dispatchPhase = phase;
            attempt.providerAdmission = admission;
            attempt.providerEvidence = evidence;
            attempt.providerLeaseIdentity = cloneProviderLeaseIdentity(claimProviderLeaseIdentity(claim));
            attempt.fence = currentFence(work);
            refreshUnitCounters(ledger);
        });
    }

    private async assertClaimBinding(prepared: PreparedModelAttempt, claim: RecordSchedulerCoordinatorClaim): Promise<void> {
        const ledger = await requireLedger(prepared.registration.taskId);
        const attempt = requireAttempt(ledger, prepared.attemptId);
        if (attempt.state !== "Dispatched"
            || attempt.claimId !== claim.claimId
            || attempt.permitId !== claim.permitId
            || attempt.dispatchSeq !== claim.dispatchSeq
            || attempt.dispatchPhase !== "invoking"
            || attempt.providerAdmission !== requireClaimAdmission(claim)
            || attempt.providerEvidence !== requireClaimEvidence(claim)
            || !sameProviderLeaseIdentity(attempt.providerLeaseIdentity, claimProviderLeaseIdentity(claim))) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "invoke 前 Attempt/claim/permit/dispatchSeq 双向校验失败");
        }
    }

    private async markKnownSuccess(
        prepared: PreparedModelAttempt,
        claim: RecordSchedulerCoordinatorClaim,
        result: RecordModelCallResult,
    ): Promise<boolean> {
        const output = await prepared.registration.spool.writeImmutable({
            taskId: prepared.registration.taskId,
            kind: "output",
            content: JSON.stringify(result),
        });
        await this.emitAttemptPhase("output-spool-persisted", prepared, claim, {
            hash: output.reference.hash,
            byteLength: output.reference.byteLength,
            reference: output.reference,
        });
        let cancelled = false;
        await this.mutateOwnerLedger(prepared.registration.taskId, prepared.ownerLease, ledger => {
            if (["CancelRequested", "Cancelling", "Cancelled"].includes(ledger.task.state)) {
                cancelled = true;
                return;
            }
            const work = requireWork(ledger, prepared.recordWorkKey);
            const unit = requireUnit(ledger, prepared.unitId);
            const attempt = requireAttempt(ledger, prepared.attemptId);
            assertActiveClaim(attempt, claim);
            assertAttemptFenceCurrent(attempt, work);
            if (attempt.state !== "Dispatched") throw new RecordSchedulerExecutionDriverError("UNKNOWN_OUTCOME", `provider output 返回时 Attempt 已变为 ${attempt.state}`);
            assertAttemptTransition(attempt.state, "KnownSuccess");
            assertUnitTransition(unit.state, "ResultReady");
            attempt.state = "KnownSuccess";
            attempt.outcome = "known_success";
            attempt.outputRef = output.reference;
            attempt.elapsedMs = elapsedMs(attempt.startedAt);
            attempt.model = result.modelUsed || prepared.model;
            attempt.fence = currentFence(work);
            unit.state = "ResultReady";
            unit.resultRef = output.reference;
            unit.coveredRevision = work.desiredRevision;
            refreshUnitCounters(ledger);
        });
        if (cancelled) {
            await prepared.registration.control.discardLateAttempt({
                taskId: prepared.registration.taskId,
                attemptId: prepared.attemptId,
                outputRef: output.reference,
            });
            return true;
        }
        await this.emitPhase({ phase: "known-success", taskId: prepared.registration.taskId, unitId: prepared.unitId, attemptId: prepared.attemptId, claim });
        return false;
    }

    private async markKnownFailure(
        prepared: PreparedModelAttempt,
        claim: RecordSchedulerCoordinatorClaim,
        result: RecordModelCallResult,
    ): Promise<boolean> {
        let cancelled = false;
        const failureClass: FailureClass = result.failureClass
            || (result.cancelled || result.timedOut ? "Availability" : result.error ? "Quality" : "Availability");
        let splitDescriptors: ModelUnitDescriptor[] = [];
        let splitError: string | undefined;
        if (failureClass === "Quality" || failureClass === "Complexity") {
            try {
                splitDescriptors = this.splitDescriptors(prepared.call, prepared.descriptor);
            } catch (error) {
                splitError = errorMessage(error);
            }
        }
        await this.mutateOwnerLedger(prepared.registration.taskId, prepared.ownerLease, ledger => {
            if (["CancelRequested", "Cancelling", "Cancelled"].includes(ledger.task.state)) {
                cancelled = true;
                return;
            }
            const work = requireWork(ledger, prepared.recordWorkKey);
            const unit = requireUnit(ledger, prepared.unitId);
            const attempt = requireAttempt(ledger, prepared.attemptId);
            assertActiveClaim(attempt, claim);
            if (attempt.state !== "Dispatched") throw new RecordSchedulerExecutionDriverError("UNKNOWN_OUTCOME", `provider failure 返回时 Attempt 已变为 ${attempt.state}`);
            assertAttemptTransition(attempt.state, "KnownFailure");
            attempt.state = "KnownFailure";
            attempt.outcome = "known_failure";
            attempt.errorClass = failureClass;
            attempt.providerEvidence = `${requireClaimEvidence(claim)};result:${result.error || "empty-text"}${splitError ? `;split:${splitError}` : ""}`;
            attempt.elapsedMs = elapsedMs(attempt.startedAt);
            attempt.fence = currentFence(work);
            const retrySameProvider = (failureClass === "Congestion" || failureClass === "LocalResource") && unit.retryBudget > 0;
            const nextRouteIndex = prepared.routeIndex + 1 < unit.routePlan.length ? prepared.routeIndex + 1 : undefined;
            const canFallback = ["Availability", "Congestion", "LocalResource"].includes(failureClass) && nextRouteIndex !== undefined;
            if (retrySameProvider || canFallback) {
                assertUnitTransition(unit.state, "WaitingRetry");
                unit.state = "WaitingRetry";
                unit.failureClass = undefined;
                unit.routeCursor = retrySameProvider ? prepared.routeIndex : nextRouteIndex;
                if (retrySameProvider) unit.retryBudget -= 1;
                const retryDelay = retrySameProvider
                    ? MODEL_RETRY_BACKOFF_MS * Math.max(1, unit.providerAttemptCounts?.[prepared.provider] || 1)
                    : 0;
                unit.nextEligibleAt = new Date(this.nowMs() + retryDelay).toISOString();
                unit.enqueueTime = new Date().toISOString();
                unit.layerEnterTime = new Date().toISOString();
            } else if (splitDescriptors.length === 2) {
                assertUnitTransition(unit.state, "Superseded");
                unit.state = "Superseded";
                unit.failureClass = failureClass;
                unit.nextEligibleAt = undefined;
                unit.childUnitIds = splitDescriptors.map(descriptor => descriptor.unitId);
                for (const descriptor of splitDescriptors) {
                    const existing = ledger.units.find(candidate => candidate.unitId === descriptor.unitId);
                    const inputHash = this.modelUnitInputHash(
                        prepared.registration,
                        prepared.call,
                        descriptor,
                        prepared.source.snapshot.sourceSnapshotId,
                    );
                    if (existing) {
                        if (existing.taskId !== prepared.registration.taskId
                            || existing.recordId !== prepared.identity.conversationId
                            || existing.layer !== "provider-attempt"
                            || existing.parentUnitId !== unit.unitId
                            || existing.splitDepth !== descriptor.splitDepth
                            || existing.recordWorkKey !== work.recordWorkKey
                            || existing.recordCommitEpoch !== work.recordCommitEpoch
                            || !sameStringArray(existing.dependencies, descriptor.dependencies)
                            || (existing.continuationKey || undefined) !== (descriptor.recipe.continuationKey || undefined)
                            || existing.composeOrder !== descriptor.recipe.composeOrder
                            || existing.sourceSnapshotId !== prepared.source.snapshot.sourceSnapshotId
                            || existing.inputHash !== inputHash
                            || existing.estimatedCost !== Math.max(0.5, unit.estimatedCost / 2)
                            || !sameStringArray(existing.routePlan, unit.routePlan)
                            || hashJson(existing.promptRecipe ?? null) !== hashJson(descriptor.recipe)) {
                            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `split child ${descriptor.unitId} 与 parent provenance 不一致`);
                        }
                        continue;
                    }
                    ledger.units.push({
                        unitId: descriptor.unitId,
                        taskId: prepared.registration.taskId,
                        recordId: prepared.identity.conversationId,
                        state: descriptor.dependencies.length > 0 ? "Blocked" : "Queued",
                        layer: "provider-attempt",
                        splitDepth: descriptor.splitDepth,
                        parentUnitId: unit.unitId,
                        recordWorkKey: work.recordWorkKey,
                        recordCommitEpoch: work.recordCommitEpoch,
                        dependencies: [...descriptor.dependencies],
                        composeOrder: descriptor.recipe.composeOrder,
                        continuationKey: descriptor.recipe.continuationKey,
                        sourceSnapshotId: prepared.source.snapshot.sourceSnapshotId,
                        inputHash,
                        estimatedCost: Math.max(0.5, unit.estimatedCost / 2),
                        routePlan: [...unit.routePlan],
                        routeCursor: 0,
                        attemptedProviders: [],
                        retryBudget: prepared.call.retryBudget,
                        promptRecipe: structuredClone(descriptor.recipe),
                        unitAttempts: 0,
                        providerAttemptCounts: {},
                        enqueueTime: new Date().toISOString(),
                        layerEnterTime: new Date().toISOString(),
                    });
                }
            } else {
                assertUnitTransition(unit.state, "FailedFinal");
                unit.state = "FailedFinal";
                unit.failureClass = failureClass;
                unit.nextEligibleAt = undefined;
            }
            refreshUnitCounters(ledger);
        });
        if (cancelled) {
            await prepared.registration.control.discardLateAttempt({
                taskId: prepared.registration.taskId,
                attemptId: prepared.attemptId,
            });
            return true;
        }
        await this.emitPhase({ phase: "known-failure", taskId: prepared.registration.taskId, unitId: prepared.unitId, attemptId: prepared.attemptId, claim });
        return false;
    }

    private async markUnknownOutcome(
        prepared: ManagedDispatchIdentity,
        claim: CoordinatorClaimBinding,
        error: unknown,
    ): Promise<void> {
        await this.mutateOwnerLedger(prepared.registration.taskId, prepared.ownerLease, ledger => {
            const work = requireWork(ledger, prepared.recordWorkKey);
            const unit = requireUnit(ledger, prepared.unitId);
            const attempt = requireAttempt(ledger, prepared.attemptId);
            if (attempt.state !== "Dispatched") return;
            const bindingMatches = claimMatchesAttempt(attempt, claim);
            assertAttemptTransition(attempt.state, "UnknownOutcome");
            assertUnitTransition(unit.state, "UnknownOutcome");
            const now = this.nowMs();
            attempt.state = "UnknownOutcome";
            attempt.outcome = "unknown_outcome";
            attempt.unknownOutcomeAt = new Date(now).toISOString();
            attempt.unknownOutcomeUntil = new Date(now + this.unknownOutcomeGraceMs).toISOString();
            attempt.unknownOutcomeGraceMs = this.unknownOutcomeGraceMs;
            attempt.errorClass = "UnknownOutcome";
            attempt.providerEvidence = bindingMatches
                ? `${requireClaimEvidence(claim)};unknown:${errorMessage(error)}`
                : `${attempt.providerEvidence || "claim-attempt-mismatch"};repair:${errorMessage(error)}`;
            attempt.fence = currentFence(work);
            unit.state = "UnknownOutcome";
            unit.failureClass = "UnknownOutcome";
            if (!bindingMatches && ledger.task.state !== "RepairRequired") {
                assertTaskTransition(ledger.task.state, "RepairRequired");
                ledger.task.state = "RepairRequired";
                ledger.task.terminalState = "RepairRequired";
                ledger.task.repairState = "Required";
                ledger.task.updatedAt = new Date(now).toISOString();
            }
            refreshUnitCounters(ledger);
        });
        await this.emitPhase({ phase: "unknown-outcome", taskId: prepared.registration.taskId, unitId: prepared.unitId, attemptId: prepared.attemptId, claim });
    }

    private async advanceExpiredUnknownOutcome(
        registration: RecordSchedulerProductionRegistration,
        ownerLease: SchedulerOwnerLease,
        identity: CanonicalConversationIdentity,
        recordWorkKeyValue: string,
        unitId: string,
    ): Promise<void> {
        const now = this.nowMs();
        const initial = await requireLedger(registration.taskId);
        const unit = initial.units.find(candidate => candidate.unitId === unitId);
        const unknownAttempts = initial.attempts.filter(candidate => candidate.unitId === unitId
            && candidate.recordWorkKey === recordWorkKeyValue
            && candidate.state === "UnknownOutcome");
        if (unknownAttempts.length === 0) {
            if (unit?.state === "FailedFinal" && unit.failureClass === "UnknownOutcome" && unit.retryBudget === 0) {
                throw new RecordSchedulerExecutionDriverError("UNKNOWN_OUTCOME", `Unit ${unitId} 的 UnknownOutcome 重试预算已耗尽`);
            }
            return;
        }
        if (unknownAttempts.length !== 1 || !unit) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Unit ${unitId} 的 UnknownOutcome attempt 关系不唯一`);
        }
        const attempt = unknownAttempts[0];
        if (!attempt.unknownOutcomeUntil) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `UnknownOutcome Attempt ${attempt.attemptId} 缺少截止时间`);
        }
        const until = Date.parse(attempt.unknownOutcomeUntil);
        if (!Number.isFinite(until)) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `UnknownOutcome Attempt ${attempt.attemptId} 截止时间无效`);
        }
        if (until > now) {
            throw new RecordSchedulerExecutionDriverError("UNKNOWN_OUTCOME", `UnknownOutcome Attempt ${attempt.attemptId} 仍在宽限期内`);
        }
        if (unit.state !== "UnknownOutcome") {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `UnknownOutcome Attempt ${attempt.attemptId} 的 Unit 已变为 ${unit.state}`);
        }
        const expectedWork = requireWork(initial, recordWorkKeyValue);
        const resolved = await this.resolveRetryFence(
            registration,
            ownerLease,
            identity,
            expectedWork,
            attempt,
            initial,
            "UnknownOutcome",
        );
        const registryRef = await registryReference(registration.control.dataRoot, resolved.path, resolved.registry);
        await this.mutateOwnerLedger(registration.taskId, ownerLease, ledger => {
            const work = requireWork(ledger, recordWorkKeyValue);
            const currentUnit = requireUnit(ledger, unitId);
            const currentAttempt = ledger.attempts.find(candidate => candidate.attemptId === attempt.attemptId);
            if (!currentAttempt || currentAttempt.state !== "UnknownOutcome") {
                if (currentUnit.state === "Queued" || currentUnit.state === "FailedFinal") return;
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `UnknownOutcome Attempt ${attempt.attemptId} 在 fence 结算前发生非法变化`);
            }
            const beforeFence = currentFence(work);
            const expectedFence = currentFence(expectedWork);
            if (!sameFence(beforeFence, expectedFence) && !sameFence(beforeFence, resolved.fence)) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `UnknownOutcome Attempt ${attempt.attemptId} 的 scheduler fence 与 registry 漂移`);
            }
            if (ledger.attempts.some(candidate => candidate.attemptId !== currentAttempt.attemptId
                && candidate.unitId === unitId
                && sameFence(candidate.fence, resolved.fence)
                && !["KnownFailure", "Discarded"].includes(candidate.state))) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `新 fence 已绑定到 Unit ${unitId} 的其他 Attempt`);
            }
            work.registryRevision = resolved.registry.registryRevision;
            work.registryRef = registryRef;
            work.schedulerEpoch = resolved.fence.schedulerEpoch;
            work.workLeaseId = resolved.fence.workLeaseId;
            work.leaseOwnerId = resolved.lease.ownerId;
            work.leaseExpiresAt = resolved.lease.expiresAt;
            work.activeTaskIds = [...resolved.work.activeTaskIds];
            work.currentFencingToken = resolved.fence.fencingToken;
            for (const candidate of ledger.attempts) {
                if (candidate.attemptId === currentAttempt.attemptId
                    || candidate.recordWorkKey !== work.recordWorkKey
                    || !["Created", "DispatchIntentPersisted", "Dispatched", "KnownSuccess"].includes(candidate.state)) continue;
                if (!sameFence(candidate.fence, beforeFence) && !sameFence(candidate.fence, resolved.fence)) {
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${candidate.attemptId} 无法迁移到 UnknownOutcome 新 fence`);
                }
                candidate.fence = { ...resolved.fence };
                if (candidate.leaseExpiresAt) candidate.leaseExpiresAt = resolved.lease.expiresAt;
            }
            for (const commit of ledger.commits) {
                if (commit.recordWorkKey !== work.recordWorkKey
                    || !["ResultReady", "BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten", "Verified", "CleanupPending"].includes(commit.state)) continue;
                if (!sameFence(commit.fence, beforeFence) && !sameFence(commit.fence, resolved.fence)) {
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Commit ${commit.commitId} 无法迁移到 UnknownOutcome 新 fence`);
                }
                commit.fence = { ...resolved.fence };
                if (commit.beforeImage) commit.beforeImage.fence = { ...resolved.fence };
                if (commit.cleanupReadBack) commit.cleanupReadBack.fence = { ...resolved.fence };
            }
            assertAttemptTransition(currentAttempt.state, "Discarded");
            currentAttempt.state = "Discarded";
            currentAttempt.outcome = "discarded";
            currentAttempt.activeTaskIds = currentAttempt.activeTaskIds.filter(taskId => taskId !== registration.taskId);
            currentAttempt.providerEvidence = `${currentAttempt.providerEvidence || "unknown"};unknown-window-expired`;
            if (currentUnit.retryBudget > 0) {
                currentUnit.retryBudget -= 1;
                assertUnitTransition(currentUnit.state, "WaitingRetry");
                currentUnit.state = "WaitingRetry";
                currentUnit.failureClass = undefined;
                currentUnit.nextEligibleAt = undefined;
                currentUnit.enqueueTime = new Date(now).toISOString();
                currentUnit.layerEnterTime = new Date(now).toISOString();
                assertUnitTransition(currentUnit.state, "Queued");
                currentUnit.state = "Queued";
            } else {
                assertUnitTransition(currentUnit.state, "FailedFinal");
                currentUnit.state = "FailedFinal";
                currentUnit.failureClass = "UnknownOutcome";
                currentUnit.nextEligibleAt = undefined;
                currentAttempt.providerEvidence += ";retry-budget-exhausted";
            }
            refreshUnitCounters(ledger);
        });
        const settled = await requireLedger(registration.taskId);
        const settledUnit = requireUnit(settled, unitId);
        if (settledUnit.state === "FailedFinal") {
            throw new RecordSchedulerExecutionDriverError("UNKNOWN_OUTCOME", `Unit ${unitId} 的 UnknownOutcome 重试预算已耗尽`);
        }
    }

    private async resolveRetryFence(
        registration: RecordSchedulerProductionRegistration,
        ownerLease: SchedulerOwnerLease,
        identity: CanonicalConversationIdentity,
        schedulerWork: SchedulerRecordWork,
        settledAttempt: SchedulerAttemptLedger,
        ledger: RecordSchedulerLedger,
        reason: "UnknownOutcome" | "pre-invoke failure" | "provider failure",
    ): Promise<ResolvedRecordWorkFence> {
        const location = { identity, dataRoot: registration.control.dataRoot };
        for (let index = 0; index < MAX_CAS_RETRIES; index += 1) {
            const current = await readRecordWorkRegistry(location);
            if (current.kind !== "ready") {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `${reason} registry 无法读取: ${current.reason}`);
            }
            const work = current.registry.works.find(candidate => candidate.recordWorkKey === schedulerWork.recordWorkKey);
            if (!work || work.state !== "Active" || !work.ownerLease || !work.activeTaskIds.includes(registration.taskId)) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `${reason} registry work 缺失、已 superseded、无 lease 或 Task 已脱离`);
            }
            if (work.publicationClaim) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `${reason} work 已存在 publication claim，禁止换发 fence`);
            }
            const registryFence = {
                schedulerEpoch: work.ownerLease.schedulerEpoch,
                recordCommitEpoch: work.recordCommitEpoch,
                fencingToken: work.currentFencingToken,
                workLeaseId: work.ownerLease.workLeaseId,
            };
            if (work.ownerLease.ownerId !== ownerLease.ownerId
                || work.ownerLease.schedulerEpoch !== ownerLease.schedulerEpoch
                || work.recordCommitEpoch !== schedulerWork.recordCommitEpoch) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `${reason} registry owner 或 epoch 与当前 scheduler owner 不一致`);
            }
            const schedulerFence = currentFence(schedulerWork);
            const registryMatchesScheduler = sameFence(registryFence, schedulerFence);
            const registryLeadsScheduler = registryFence.fencingToken > schedulerFence.fencingToken
                && registryFence.recordCommitEpoch === schedulerFence.recordCommitEpoch
                && registryFence.workLeaseId !== schedulerFence.workLeaseId;
            if (!registryMatchesScheduler && !registryLeadsScheduler) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `${reason} registry fence 未与 scheduler 对齐且不是可恢复的领先 fence`);
            }
            if (!sameFence(registryFence, settledAttempt.fence)) {
                if (registryFence.fencingToken <= settledAttempt.fence.fencingToken
                    || registryFence.workLeaseId === settledAttempt.fence.workLeaseId
                    || ledger.attempts.some(candidate => candidate.attemptId !== settledAttempt.attemptId
                        && candidate.unitId === settledAttempt.unitId
                        && sameFence(candidate.fence, registryFence)
                        && !["KnownFailure", "Discarded"].includes(candidate.state))) {
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `${reason} 领先 fence 无法安全复用`);
                }
                return { path: current.path, registry: current.registry, work, lease: work.ownerLease, fence: registryFence };
            }
            const advanced = await advanceRecordWorkFence({
                ...location,
                recordWorkKey: schedulerWork.recordWorkKey,
                taskId: registration.taskId,
                ownerId: ownerLease.ownerId,
                fence: registryFence,
                expectedRegistryRevision: current.registry.registryRevision,
                leaseDurationMs: registration.schedulerOwner.workLeaseMs || DEFAULT_WORK_LEASE_MS,
                nowMs: this.nowMs(),
            });
            if (advanced.kind === "cas_conflict") continue;
            if (advanced.kind === "advanced") return advanced;
            const failureReason = advanced.kind === "rejected" ? advanced.reason : advanced.kind;
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `${reason} fence 换发失败: ${failureReason}`);
        }
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `${reason} fence 换发 CAS 重试耗尽`);
    }

    private async selectModelAttemptOrdinal(taskId: string, unitId: string): Promise<number> {
        const ledger = await requireLedger(taskId);
        const attempts = ledger.attempts.filter(candidate => candidate.unitId === unitId);
        if (attempts.length === 0) return 1;
        const latest = attempts.reduce((selected, candidate) => attemptOrdinal(candidate.attemptId, unitId) > attemptOrdinal(selected.attemptId, unitId)
            ? candidate
            : selected);
        const ordinal = attemptOrdinal(latest.attemptId, unitId);
        const unit = requireUnit(ledger, unitId);
        if (latest.state === "Discarded" && latest.errorClass === "UnknownOutcome" && unit.state === "Queued") {
            return ordinal + 1;
        }
        if (latest.state === "KnownFailure" && unit.state === "Queued") {
            return ordinal + 1;
        }
        return ordinal;
    }

    private async replayKnownSuccess(prepared: PreparedModelAttempt, outputRef: ImmutableBlobReference): Promise<RecordModelCallResult> {
        return await this.readModelResult(prepared.registration, outputRef);
    }

    private async readModelResult(
        registration: RecordSchedulerProductionRegistration,
        outputRef: ImmutableBlobReference,
    ): Promise<RecordModelCallResult> {
        const bytes = await registration.spool.readImmutable({ taskId: registration.taskId, kind: "output", reference: outputRef });
        if (bytes.byteLength !== outputRef.byteLength || sha256(bytes) !== outputRef.hash) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "KnownSuccess provider output spool 回读哈希不一致");
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(bytes.toString("utf8"));
        } catch {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "KnownSuccess provider output spool 不是 JSON");
        }
        if (!isRecordModelResult(parsed)) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "KnownSuccess provider output spool 不是完整 RecordModelCallResult");
        return parsed;
    }

    private async reconcileRestartedDispatches(
        ledgers: readonly RecordSchedulerLedger[],
        snapshot: Readonly<RecordSchedulerCoordinatorSnapshot>,
    ): Promise<boolean> {
        const ledgersByTask = new Map(ledgers.map(ledger => [ledger.task.taskId, ledger]));
        const claimsByAttempt = new Map<string, RecordSchedulerCoordinatorPersistedClaim>();
        let changed = false;
        for (const claim of snapshot.activeClaims) {
            const registration = [...this.registrations.values()].find(candidate => candidate.taskId === claim.taskId);
            const ledger = ledgersByTask.get(claim.taskId);
            if (!registration || !ledger || !claim.attemptId || !claim.dispatchPhase || !claim.providerAdmission || claim.disposition !== "active") {
                if (registration) await this.markRestartRecoveryRepair(registration, claim.attemptId, `invalid persisted claim ${claim.claimId}`);
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `cannot reconcile persisted coordinator claim ${claim.claimId}`);
            }
            const attempt = ledger.attempts.find(candidate => candidate.attemptId === claim.attemptId);
            const unit = ledger.units.find(candidate => candidate.unitId === claim.unitId);
            if (!attempt || !unit || unit.recordId !== claim.recordId || attempt.unitId !== unit.unitId) {
                await this.markRestartRecoveryRepair(registration, claim.attemptId, `claim ${claim.claimId} does not identify one ledger attempt/unit`);
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `persisted coordinator claim ${claim.claimId} contradicts the task ledger`);
            }
            claimsByAttempt.set(recoveryAttemptKey(claim.taskId, claim.attemptId), claim);
            if (this.runningByAttempt.has(attempt.attemptId)) continue;
            await this.assertRestartProviderAttemptIdentity(registration, attempt, unit);
            if (attempt.state === "Discarded" && attempt.errorClass === "UnknownOutcome"
                && (unit.state === "Queued" || unit.state === "FailedFinal")) {
                if (!recoveryDiscardedUnknownClaimMatchesAttempt(claim, attempt, unit)) {
                    await this.markRestartRecoveryRepair(registration, attempt.attemptId, `discarded UnknownOutcome claim ${claim.claimId} and attempt binding disagree`);
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `discarded UnknownOutcome claim ${claim.claimId} and Attempt ${attempt.attemptId} disagree during recovery`);
                }
                await this.cancelRecoveredTerminalProviderLease(registration, claim, attempt);
                changed = true;
                continue;
            }
            if (attempt.state === "KnownSuccess" && unit.state === "ResultReady") {
                if (!recoverySettledClaimMatchesAttempt(claim, attempt, unit)) {
                    await this.markRestartRecoveryRepair(registration, attempt.attemptId, `settled claim ${claim.claimId} and KnownSuccess attempt binding disagree`);
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `settled claim ${claim.claimId} and Attempt ${attempt.attemptId} disagree during recovery`);
                }
                await this.settleRecoveredSuccessfulProviderLease(registration, claim, attempt);
                changed = true;
                continue;
            }
            if (claim.dispatchPhase === "permit-granted") {
                if (!recoveryPermitClaimMatchesAttempt(claim, attempt, unit)) {
                    await this.markRestartRecoveryRepair(registration, attempt.attemptId, `permit-granted claim ${claim.claimId} does not match an unbound dispatch intent`);
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `permit-granted claim ${claim.claimId} is not safely revocable`);
                }
                await this.reconcileProviderLeaseBeforeInvoke(registration, claim, attempt, "permit-granted");
                changed = true;
                continue;
            }
            if (!recoveryClaimMatchesAttempt(claim, attempt, unit)) {
                await this.markRestartRecoveryRepair(registration, attempt.attemptId, `claim ${claim.claimId} and attempt binding disagree`);
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `claim ${claim.claimId} and Attempt ${attempt.attemptId} disagree during recovery`);
            }
            const recovery = await this.recoveryDispatchIdentity(registration, attempt);
            await this.reconcileBoundProviderLease(registration, recovery, claim, attempt);
            changed = true;
        }
        for (const ledger of ledgers) {
            const registration = [...this.registrations.values()].find(candidate => candidate.taskId === ledger.task.taskId);
            for (const attempt of ledger.attempts) {
                if (attempt.managedByProductionPump !== true || attempt.state !== "Dispatched" || this.runningByAttempt.has(attempt.attemptId)) continue;
                const claim = claimsByAttempt.get(recoveryAttemptKey(ledger.task.taskId, attempt.attemptId));
                const unit = ledger.units.find(candidate => candidate.unitId === attempt.unitId);
                if (!registration
                    || !claim
                    || !unit
                    || claim.dispatchPhase === "permit-granted"
                    || !recoveryClaimMatchesAttempt(claim, attempt, unit)) {
                    if (registration) await this.markRestartRecoveryRepair(registration, attempt.attemptId, `dispatched Attempt ${attempt.attemptId} has no matching persisted active claim`);
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `dispatched Attempt ${attempt.attemptId} cannot be recovered without a matching persisted claim`);
                }
            }
        }
        return changed;
    }

    private async assertRestartProviderAttemptIdentity(
        registration: RecordSchedulerProductionRegistration,
        attempt: SchedulerAttemptLedger,
        unit: SchedulerUnitLedger,
    ): Promise<void> {
        if (attempt.managedByProductionPump !== true || unit.layer !== "provider-attempt") return;
        try {
            const expectedIdempotencyKey = stableId("record-provider-attempt", {
                taskId: registration.taskId,
                unitId: attempt.unitId,
                attemptId: attempt.attemptId,
            });
            if (attempt.idempotencyKey !== expectedIdempotencyKey) {
                throw new Error(`ledger idempotencyKey ${String(attempt.idempotencyKey)} 与稳定 Attempt identity 不一致`);
            }
            if (!attempt.dispatchIntentRef || !unit.promptRecipe) {
                throw new Error("缺少 dispatchIntentRef 或 provider prompt recipe");
            }
            const bytes = await registration.spool.readImmutable({
                taskId: registration.taskId,
                kind: "source",
                reference: attempt.dispatchIntentRef,
            });
            let parsed: unknown;
            try {
                parsed = JSON.parse(bytes.toString("utf8"));
            } catch {
                throw new Error("dispatch intent 不是 JSON");
            }
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("dispatch intent 不是对象");
            }
            const intent = parsed as Record<string, unknown>;
            const routeIndex = attempt.provider === "local" ? -1 : unit.routePlan.indexOf(attempt.provider);
            if (intent.schemaVersion !== PUMP_SCHEMA_VERSION
                || intent.kind !== "record-scheduler-provider-dispatch-intent"
                || intent.taskId !== registration.taskId
                || intent.sourceSnapshotId !== unit.sourceSnapshotId
                || intent.recordWorkKey !== attempt.recordWorkKey
                || intent.unitId !== attempt.unitId
                || intent.attemptId !== attempt.attemptId
                || !isNonEmptyString(intent.logicalCallKey)
                || intent.inputHash !== attempt.inputHash
                || intent.idempotencyKey !== expectedIdempotencyKey
                || intent.provider !== attempt.provider
                || intent.model !== attempt.model
                || routeIndex < 0
                || intent.routeIndex !== routeIndex
                || intent.retryOrdinal !== attempt.retryOrdinal
                || hashJson(intent.recipe) !== hashJson(unit.promptRecipe)) {
                throw new Error("dispatch intent 内容与持久 Unit/Attempt identity 不一致");
            }
        } catch (error) {
            const detail = `provider dispatch identity invalid: ${errorMessage(error)}`;
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, detail);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${attempt.attemptId} ${detail}`);
        }
    }

    private async cancelRecoveredTerminalProviderLease(
        registration: RecordSchedulerProductionRegistration,
        claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>,
        attempt: SchedulerAttemptLedger,
    ): Promise<void> {
        if (claim.providerAdmission === "synthetic") {
            if (claim.providerLeaseIdentity !== undefined) {
                await this.markRestartRecoveryRepair(registration, attempt.attemptId, `synthetic terminal claim ${claim.claimId} carries a physical lease identity`);
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `synthetic terminal claim ${claim.claimId} carries a physical lease identity`);
            }
            return;
        }
        if (claim.providerAdmission !== "provider-transport" || (attempt.provider !== "grok" && attempt.provider !== "agy")) {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `terminal claim ${claim.claimId} has unsupported provider admission`);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `terminal claim ${claim.claimId} has unsupported provider admission`);
        }
        const identity = requirePersistedClaimLeaseIdentity(claim, attempt.provider, attempt.attemptId, attempt.trafficClass ?? "record");
        const recovered = await this.transport.recoverAttempt(attempt.provider, attempt.attemptId);
        if (recovered.kind === "corrupt") {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `terminal provider recovery corrupt: ${recovered.detail}`);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `terminal provider recovery corrupt for ${attempt.attemptId}: ${recovered.detail}`);
        }
        if (recovered.kind === "absent") return;
        if (!sameProviderLeaseIdentity(identity, recovered.identity)) {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `terminal provider recovery identity mismatches claim ${claim.claimId}`);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `terminal provider recovery identity mismatches claim ${claim.claimId}`);
        }
        await this.cancelRecoveredLease(identity);
    }

    private async settleRecoveredSuccessfulProviderLease(
        registration: RecordSchedulerProductionRegistration,
        claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>,
        attempt: SchedulerAttemptLedger,
    ): Promise<void> {
        if (claim.providerAdmission === "synthetic") {
            if (claim.providerLeaseIdentity !== undefined) {
                await this.markRestartRecoveryRepair(registration, attempt.attemptId, `synthetic KnownSuccess claim ${claim.claimId} carries a physical lease identity`);
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `synthetic KnownSuccess claim ${claim.claimId} carries a physical lease identity`);
            }
            return;
        }
        if (claim.providerAdmission !== "provider-transport" || (attempt.provider !== "grok" && attempt.provider !== "agy")) {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `KnownSuccess claim ${claim.claimId} has unsupported provider admission`);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `KnownSuccess claim ${claim.claimId} has unsupported provider admission`);
        }
        const identity = requirePersistedClaimLeaseIdentity(claim, attempt.provider, attempt.attemptId, attempt.trafficClass ?? "record");
        const recovered = await this.transport.recoverAttempt(attempt.provider, attempt.attemptId);
        if (recovered.kind === "corrupt") {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `KnownSuccess provider recovery corrupt: ${recovered.detail}`);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `KnownSuccess provider recovery corrupt for ${attempt.attemptId}: ${recovered.detail}`);
        }
        if (recovered.kind === "absent") return;
        if (!sameProviderLeaseIdentity(identity, recovered.identity)) {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `KnownSuccess provider recovery identity mismatches claim ${claim.claimId}`);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `KnownSuccess provider recovery identity mismatches claim ${claim.claimId}`);
        }
        const settled = await this.transport.settleRecoveredLease(identity);
        if (settled.kind !== "settled" && settled.kind !== "already-settled") {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `KnownSuccess provider lease ${identity.leaseId} settlement receipt invalid`);
        }
    }

    private async reconcileProviderLeaseBeforeInvoke(
        registration: RecordSchedulerProductionRegistration,
        claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>,
        attempt: SchedulerAttemptLedger,
        phase: "permit-granted",
    ): Promise<void> {
        if (claim.providerAdmission === "synthetic") {
            if (claim.providerLeaseIdentity !== undefined) {
                await this.markRestartRecoveryRepair(registration, attempt.attemptId, `synthetic claim ${claim.claimId} carries a physical lease identity`);
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `synthetic claim ${claim.claimId} carries a physical lease identity`);
            }
            return;
        }
        if (claim.providerAdmission !== "provider-transport") {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `unsupported ${phase} admission ${claim.providerAdmission}`);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `unsupported ${phase} admission ${claim.providerAdmission}`);
        }
        if (attempt.provider !== "grok" && attempt.provider !== "agy") {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `provider-transport claim ${claim.claimId} is bound to nonphysical provider ${attempt.provider}`);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `provider-transport claim ${claim.claimId} is bound to nonphysical provider ${attempt.provider}`);
        }
        const provider = attempt.provider;
        let identity: ProviderLeaseIdentity;
        try {
            identity = requirePersistedClaimLeaseIdentity(claim, provider, attempt.attemptId, attempt.trafficClass ?? "record");
        } catch (error) {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `provider lease identity invalid: ${errorMessage(error)}`);
            throw error;
        }
        const recovered = await this.transport.recoverAttempt(provider, attempt.attemptId);
        if (recovered.kind === "corrupt") {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `provider recovery corrupt: ${recovered.detail}`);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `provider recovery corrupt for ${attempt.attemptId}: ${recovered.detail}`);
        }
        if (recovered.kind === "absent") return;
        if (!sameProviderLeaseIdentity(identity, recovered.identity)) {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `provider recovery identity mismatches claim ${claim.claimId}`);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `provider recovery identity mismatches claim ${claim.claimId}`);
        }
        if (recovered.kind === "active") {
            await this.cancelRecoveredLease(identity);
            return;
        }
        await this.markRestartRecoveryRepair(registration, attempt.attemptId, `provider recovery is uncertain for provably pre-invoke ${phase}`);
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `provider recovery is uncertain for ${phase} claim ${claim.claimId}`);
    }

    private async reconcileBoundProviderLease(
        registration: RecordSchedulerProductionRegistration,
        recovery: ManagedDispatchIdentity,
        claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>,
        attempt: SchedulerAttemptLedger,
    ): Promise<void> {
        const phase = claim.dispatchPhase;
        if (phase !== "attempt-bound" && phase !== "invoking") {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `unsupported bound claim phase ${String(phase)}`);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `unsupported bound claim phase ${String(phase)}`);
        }
        if (claim.providerAdmission === "synthetic") {
            if (claim.providerLeaseIdentity !== undefined) {
                await this.markRestartRecoveryRepair(registration, attempt.attemptId, `synthetic claim ${claim.claimId} carries a physical lease identity`);
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `synthetic claim ${claim.claimId} carries a physical lease identity`);
            }
            if (phase === "attempt-bound") {
                await this.markKnownPreInvokeFailure(recovery, claim, new Error("recovered synthetic attempt-bound dispatch without an in-memory RPC runner"));
            } else {
                await this.markUnknownOutcome(recovery, claim, new Error("recovered synthetic invoking dispatch without an in-memory RPC runner"));
            }
            return;
        }
        if (claim.providerAdmission !== "provider-transport") {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `unsupported ${phase} admission ${claim.providerAdmission}`);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `unsupported ${phase} admission ${claim.providerAdmission}`);
        }
        if (attempt.provider !== "grok" && attempt.provider !== "agy") {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `provider-transport claim ${claim.claimId} is bound to nonphysical provider ${attempt.provider}`);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `provider-transport claim ${claim.claimId} is bound to nonphysical provider ${attempt.provider}`);
        }
        const provider = attempt.provider;
        let identity: ProviderLeaseIdentity;
        try {
            identity = requirePersistedClaimLeaseIdentity(claim, provider, attempt.attemptId, attempt.trafficClass ?? "record");
        } catch (error) {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `provider lease identity invalid: ${errorMessage(error)}`);
            throw error;
        }
        const recovered = await this.transport.recoverAttempt(provider, attempt.attemptId);
        if (recovered.kind === "corrupt") {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `provider recovery corrupt: ${recovered.detail}`);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `provider recovery corrupt for ${attempt.attemptId}: ${recovered.detail}`);
        }
        if (recovered.kind !== "absent" && !sameProviderLeaseIdentity(identity, recovered.identity)) {
            await this.markRestartRecoveryRepair(registration, attempt.attemptId, `provider recovery identity mismatches claim ${claim.claimId}`);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `provider recovery identity mismatches claim ${claim.claimId}`);
        }
        if (phase === "attempt-bound" && recovered.kind === "active") {
            await this.cancelRecoveredLease(identity);
            await this.markKnownPreInvokeFailure(recovery, claim, new Error("recovered attempt-bound provider lease was fenced and settled before RPC"));
            return;
        }
        if (phase === "attempt-bound" && recovered.kind === "absent") {
            await this.markKnownPreInvokeFailure(recovery, claim, new Error("recovered attempt-bound provider lease is absent with matching pre-invoke receipts"));
            return;
        }
        await this.markUnknownOutcome(recovery, claim, new Error(`recovered ${phase} provider dispatch cannot prove RPC absence (${recovered.kind})`));
    }

    private async cancelRecoveredLease(identity: ProviderLeaseIdentity): Promise<void> {
        const settled = await this.transport.cancelRecoveredLease(identity);
        if (settled.kind !== "settled" && settled.kind !== "already-settled") {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `recovered provider lease ${identity.leaseId} cancellation receipt invalid`);
        }
    }

    private async recoveryDispatchIdentity(
        registration: RecordSchedulerProductionRegistration,
        attempt: SchedulerAttemptLedger,
    ): Promise<ManagedDispatchIdentity> {
        const ownerLease = await this.getOrRecoverTaskOwner(registration);
        const ledger = await requireLedger(registration.taskId);
        const unit = requireUnit(ledger, attempt.unitId);
        const source = registration.frozenSources.sources.find(candidate => candidate.snapshot.sourceSnapshotId === unit.sourceSnapshotId);
        if (!source) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${attempt.attemptId} 的冻结来源无法恢复`);
        }
        const identity = canonicalIdentity(source);
        if (recordWorkKey(identity, source.snapshot.desiredRevision) !== attempt.recordWorkKey) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${attempt.attemptId} 的冻结来源与 record work 不一致`);
        }
        return {
            registration,
            ownerLease,
            identity,
            recordWorkKey: attempt.recordWorkKey,
            unitId: attempt.unitId,
            attemptId: attempt.attemptId,
        };
    }

    private async markRestartRecoveryRepair(
        registration: RecordSchedulerProductionRegistration,
        attemptId: string | undefined,
        detail: string,
    ): Promise<void> {
        const ownerLease = await this.getOrRecoverTaskOwner(registration);
        await this.mutateOwnerLedger(registration.taskId, ownerLease, ledger => {
            if (ledger.task.state !== "RepairRequired") {
                assertTaskTransition(ledger.task.state, "RepairRequired");
                ledger.task.state = "RepairRequired";
                ledger.task.terminalState = "RepairRequired";
                ledger.task.repairState = "Required";
                ledger.task.updatedAt = new Date().toISOString();
            }
            const attempt = attemptId === undefined ? undefined : ledger.attempts.find(candidate => candidate.attemptId === attemptId);
            if (attempt) attempt.providerEvidence = `${attempt.providerEvidence || "recovery"};repair:${detail}`;
            refreshUnitCounters(ledger);
        });
    }

    private async openCoordinatorSession(): Promise<CoordinatorSession> {
        const ledgers = await this.currentLedgers();
        let stored = await readRecordSchedulerCoordinatorStore(this.options.coordinatorStore);
        let initializedCoordinatorStore = false;
        if (stored.kind === "missing") {
            const bootstrap = new RecordSchedulerCoordinator({ clock: { now: () => this.nowMs() } });
            await bootstrap.rebuild(ledgers);
            stored = await initializeRecordSchedulerCoordinatorStore({
                ...this.options.coordinatorStore,
                snapshot: jsonSnapshot(bootstrap.snapshot()),
            });
            initializedCoordinatorStore = true;
        }
        if (stored.kind !== "current") {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `coordinator snapshot 无法安全读取: ${stored.kind}`);
        }
        const restoredEnvelopeUpdatedAt = stored.envelope.updatedAt;
        let ownerMutation;
        let acquiredNewOwnerEpoch = false;
        if (this.coordinatorLease
            && this.coordinatorLease.ownerId === this.options.coordinatorOwnerId
            && this.coordinatorLease.expiresAtMs > this.nowMs()) {
            try {
                ownerMutation = await renewRecordSchedulerCoordinatorOwner({
                    ...this.options.coordinatorStore,
                    expectedRevision: stored.envelope.revision,
                    ownerEpoch: this.coordinatorLease.epoch,
                    ownerLeaseId: this.coordinatorLease.leaseId,
                    leaseDurationMs: this.coordinatorLeaseMs,
                });
            } catch (error) {
                if (errorCode(error) !== "OWNER_FENCED") throw error;
                ownerMutation = await acquireRecordSchedulerCoordinatorOwner({
                    ...this.options.coordinatorStore,
                    ownerId: this.options.coordinatorOwnerId,
                    leaseDurationMs: this.coordinatorLeaseMs,
                    expectedRevision: stored.envelope.revision,
                });
                acquiredNewOwnerEpoch = true;
            }
        } else {
            ownerMutation = await acquireRecordSchedulerCoordinatorOwner({
                ...this.options.coordinatorStore,
                ownerId: this.options.coordinatorOwnerId,
                leaseDurationMs: this.coordinatorLeaseMs,
                expectedRevision: stored.envelope.revision,
            });
            acquiredNewOwnerEpoch = true;
        }
        if (!ownerMutation.lease) throw new RecordSchedulerExecutionDriverError("OWNER_UNAVAILABLE", "coordinator owner lease 未取得");
        this.coordinatorLease = ownerMutation.lease;
        const reconciled = await this.reconcileRestartedDispatches(ledgers, ownerMutation.snapshot);
        const reconciledLedgers = reconciled ? await this.currentLedgers() : ledgers;
        const coordinator = new RecordSchedulerCoordinator({ clock: { now: () => this.nowMs() } });
        const restartElapsedMs = acquiredNewOwnerEpoch && !initializedCoordinatorStore
            ? calculateRecordSchedulerRestartElapsedMs(
                restoredEnvelopeUpdatedAt,
                this.nowMs(),
                this.coordinatorRestartCreditCapMs,
            )
            : 0;
        await coordinator.rebuild(reconciledLedgers, { snapshot: ownerMutation.snapshot, restartElapsedMs });
        const snapshot = coordinator.snapshot();
        if (snapshot.repairRequired) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `coordinator recovery 已 fail closed: ${snapshot.recoveryIssues.map(issue => issue.code).join(",")}`);
        }
        const session: CoordinatorSession = { coordinator, lease: ownerMutation.lease, revision: ownerMutation.envelope.revision };
        await this.persistCoordinator(session);
        return session;
    }

    private async persistCoordinator(session: CoordinatorSession): Promise<void> {
        const snapshot = jsonSnapshot(session.coordinator.snapshot());
        await this.options.onCoordinatorPersist?.({ phase: "before-write", snapshot });
        await this.refreshCoordinatorSessionOwner(session);
        const mutation = await mutateRecordSchedulerCoordinatorSnapshot({
            ...this.options.coordinatorStore,
            expectedRevision: session.revision,
            ownerEpoch: session.lease.epoch,
            ownerLeaseId: session.lease.leaseId,
            mutate: persisted => replaceSnapshot(persisted, snapshot),
        });
        session.revision = mutation.envelope.revision;
        this.coordinatorLease = mutation.envelope.ownerLease || undefined;
        if (!this.coordinatorLease) throw new RecordSchedulerExecutionDriverError("OWNER_UNAVAILABLE", "持久化 coordinator snapshot 时 owner lease 丢失");
        await this.options.onCoordinatorPersist?.({ phase: "after-write", snapshot });
    }

    private async refreshCoordinatorSessionOwner(session: CoordinatorSession): Promise<void> {
        let ownerMutation;
        try {
            ownerMutation = await renewRecordSchedulerCoordinatorOwner({
                ...this.options.coordinatorStore,
                expectedRevision: session.revision,
                ownerEpoch: session.lease.epoch,
                ownerLeaseId: session.lease.leaseId,
                leaseDurationMs: this.coordinatorLeaseMs,
            });
        } catch (error) {
            if (errorCode(error) !== "OWNER_FENCED") throw error;
            ownerMutation = await acquireRecordSchedulerCoordinatorOwner({
                ...this.options.coordinatorStore,
                ownerId: this.options.coordinatorOwnerId,
                leaseDurationMs: this.coordinatorLeaseMs,
                expectedRevision: session.revision,
            });
        }
        if (!ownerMutation.lease) {
            throw new RecordSchedulerExecutionDriverError("OWNER_UNAVAILABLE", "刷新 coordinator owner lease 时未取得 lease");
        }
        session.lease = ownerMutation.lease;
        session.revision = ownerMutation.envelope.revision;
        this.coordinatorLease = ownerMutation.lease;
    }

    private async currentLedgers(): Promise<RecordSchedulerLedger[]> {
        const taskIds = [...new Set([...this.registrations.values()].map(registration => registration.taskId))];
        const ledgers: RecordSchedulerLedger[] = [];
        for (const taskId of taskIds) ledgers.push(await requireLedger(taskId));
        return ledgers;
    }

    private async getOrRecoverTaskOwner(registration: RecordSchedulerProductionRegistration): Promise<SchedulerOwnerLease> {
        const active = this.ownerRecoveryByTask.get(registration.taskId);
        if (active) return await active;
        const recovery = this.recoverTaskOwner(registration);
        this.ownerRecoveryByTask.set(registration.taskId, recovery);
        try {
            return await recovery;
        } finally {
            if (this.ownerRecoveryByTask.get(registration.taskId) === recovery) {
                this.ownerRecoveryByTask.delete(registration.taskId);
            }
        }
    }

    private async recoverTaskOwner(registration: RecordSchedulerProductionRegistration): Promise<SchedulerOwnerLease> {
        let lastReason = "owner recovery exhausted";
        for (let index = 0; index < MAX_CAS_RETRIES; index += 1) {
            const nowMs = this.nowMs();
            const ledger = await requireLedger(registration.taskId, nowMs);
            if (ledger.schedulerOwner
                && ledger.schedulerOwner.ownerId === registration.schedulerOwner.ownerId
                && Date.parse(ledger.schedulerOwner.expiresAt) > nowMs
                && ledger.schedulerOwnerRecovery === undefined) {
                return ledger.schedulerOwner;
            }
            const recovered = await registration.control.recoverOwner({
                taskId: registration.taskId,
                ownerId: registration.schedulerOwner.ownerId,
                nowMs,
                leaseMs: registration.schedulerOwner.leaseMs,
                workLeaseMs: registration.schedulerOwner.workLeaseMs,
            });
            if (recovered.kind === "recovered") return recovered.ownerLease;
            lastReason = recovered.reason;
            if (!/revision conflict|CAS|冲突|lease 仍有效|并发接管/iu.test(recovered.reason)) {
                throw new RecordSchedulerExecutionDriverError("OWNER_UNAVAILABLE", `无法取得 scheduler owner: ${recovered.reason}`);
            }
            await new Promise<void>(resolve => setTimeout(resolve, 5));
        }
        throw new RecordSchedulerExecutionDriverError("OWNER_UNAVAILABLE", `无法取得 scheduler owner: ${lastReason}`);
    }

    private async ensureRecordWork(
        registration: RecordSchedulerProductionRegistration,
        source: FrozenRuntimeSource,
        identity: CanonicalConversationIdentity,
        ownerLease: SchedulerOwnerLease,
    ): Promise<string> {
        const location = { identity, dataRoot: registration.control.dataRoot };
        const initialized = await initializeRecordWorkRegistryIdentity(location, { firstPublicationToken: registration.firstPublicationToken });
        if (initialized.kind === "repair_required" || initialized.kind === "publication_rejected") {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `无法准备 record work identity: ${initialized.kind}`);
        }
        const created = await createRecordWorkRegistry(location, { firstPublicationToken: registration.firstPublicationToken });
        if (created.kind === "repair_required" || created.kind === "publication_rejected") {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `无法建立 record work registry: ${created.kind}`);
        }
        const started = await startOrAttachWithRetry(location, source.snapshot.desiredRevision, registration.taskId);
        if (started.kind !== "started") throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `无法建立或附着 record work: ${started.kind}`);
        const expectedWorkKey = recordWorkKey(identity, source.snapshot.desiredRevision);
        if (started.work.recordWorkKey !== expectedWorkKey) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "record work registry 返回的稳定 key 不一致");
        const acquired = await acquireRecordWorkLeaseWithRetry(
            location,
            expectedWorkKey,
            registration.taskId,
            ownerLease,
            registration.schedulerOwner.workLeaseMs || DEFAULT_WORK_LEASE_MS,
            this.nowMs(),
        );
        const taskLedger = await requireLedger(registration.taskId, this.nowMs());
        const resolved: ResolvedRecordWorkFence = taskLedger.candidateSnapshot.requestMode === "force"
            ? await reconcileRecordWorkPublicationGeneration({
                taskId: registration.taskId,
                recordWorkKey: expectedWorkKey,
                identity,
                dataRoot: registration.control.dataRoot,
                recordStoreHash: registration.recordStoreHash,
                schedulerOwnerLease: ownerLease,
                leaseDurationMs: registration.schedulerOwner.workLeaseMs || DEFAULT_WORK_LEASE_MS,
                nowMsProvider: () => this.nowMs(),
            })
            : acquired;
        const registryRef = await registryReference(registration.control.dataRoot, resolved.path, resolved.registry);
        await this.mutateOwnerLedger(registration.taskId, ownerLease, ledger => {
            const existing = ledger.recordWork.find(work => work.recordWorkKey === expectedWorkKey);
            if (existing) {
                if (existing.conversationId !== identity.conversationId
                    || existing.chain !== identity.chain
                    || existing.workspaceHash !== identity.workspaceHash
                    || existing.desiredRevision !== source.snapshot.desiredRevision
                    || (existing.recordCommitEpoch !== resolved.work.recordCommitEpoch
                        && !isPublicationGenerationAdvanceForTask(resolved.work, registration.taskId, existing))) {
                    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "scheduler ledger recordWork 与冻结来源不兼容");
                }
                synchronizeSchedulerWorkFromRegistry(ledger, existing, resolved, registryRef);
                return;
            }
            ledger.recordWork.push({
                recordWorkKey: resolved.work.recordWorkKey,
                conversationId: identity.conversationId,
                chain: identity.chain,
                workspaceHash: identity.workspaceHash,
                desiredRevision: source.snapshot.desiredRevision,
                recordCommitEpoch: resolved.work.recordCommitEpoch,
                registryRevision: resolved.registry.registryRevision,
                registryRef,
                schedulerEpoch: resolved.fence.schedulerEpoch,
                workLeaseId: resolved.fence.workLeaseId,
                leaseOwnerId: resolved.lease.ownerId,
                leaseExpiresAt: resolved.lease.expiresAt,
                activeTaskIds: [...resolved.work.activeTaskIds],
                currentFencingToken: resolved.fence.fencingToken,
            });
        });
        return expectedWorkKey;
    }

    private deriveLocalFinalizeIdentity(
        input: RecordSchedulerLocalFinalizeInput,
        source: FrozenRuntimeSource,
        identity: CanonicalConversationIdentity,
        workKey: string,
    ): LocalFinalizeIdentity {
        const dependencies = uniqueSorted(input.modelUnitIds);
        const content = Buffer.from(input.content, "utf8");
        const contentHash = sha256(content);
        const inputHash = hashJson({
            schemaVersion: PUMP_SCHEMA_VERSION,
            kind: "record-scheduler-local-finalize",
            taskId: input.registration.taskId,
            sourceSnapshotId: source.snapshot.sourceSnapshotId,
            modelUnitIds: dependencies,
            contentHash,
            contentByteLength: content.byteLength,
            recordMeta: input.commit.recordMeta ?? null,
            recordStoreHash: input.registration.recordStoreHash,
        });
        const unitId = stableId("record-local-finalize", {
            taskId: input.registration.taskId,
            sourceSnapshotId: source.snapshot.sourceSnapshotId,
            modelUnitIds: dependencies,
        });
        const attemptId = `${unitId}:attempt:1`;
        const commitId = stableId("record-local-finalize-commit", {
            taskId: input.registration.taskId,
            sourceSnapshotId: source.snapshot.sourceSnapshotId,
            workKey,
            unitId,
            attemptId,
            inputHash,
        });
        return { source, identity, recordWorkKey: workKey, unitId, attemptId, commitId, inputHash, contentHash, contentByteLength: content.byteLength };
    }

    private async ensureLocalFinalizeAttempt(
        input: RecordSchedulerLocalFinalizeInput,
        local: LocalFinalizeIdentity,
        ownerLease: SchedulerOwnerLease,
    ): Promise<void> {
        const intent = await input.registration.spool.writeImmutable({
            taskId: input.registration.taskId,
            kind: "source",
            content: JSON.stringify({
                schemaVersion: PUMP_SCHEMA_VERSION,
                kind: "record-scheduler-local-finalize-intent",
                taskId: input.registration.taskId,
                sourceSnapshotId: local.source.snapshot.sourceSnapshotId,
                unitId: local.unitId,
                attemptId: local.attemptId,
                dependencies: [...input.modelUnitIds].sort(),
                inputHash: local.inputHash,
            }),
        });
        await this.mutateOwnerLedger(input.registration.taskId, ownerLease, ledger => {
            const work = requireWork(ledger, local.recordWorkKey);
            const dependencies = uniqueSorted(input.modelUnitIds);
            if (dependencies.some(dependency => {
                const unit = ledger.units.find(candidate => candidate.unitId === dependency);
                const attempt = ledger.attempts.find(candidate => candidate.unitId === dependency && candidate.state === "KnownSuccess");
                return !unit || !["ResultReady", "Succeeded"].includes(unit.state) || !attempt || attempt.provider === "local";
            })) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "local-finalize 只能依赖本次已成功的 model Units");
            }
            let unit = ledger.units.find(candidate => candidate.unitId === local.unitId);
            if (!unit) {
                unit = {
                    unitId: local.unitId,
                    taskId: input.registration.taskId,
                    recordId: local.identity.conversationId,
                    state: "Queued",
                    layer: "local-finalize",
                    splitDepth: 0,
                    recordWorkKey: work.recordWorkKey,
                    recordCommitEpoch: work.recordCommitEpoch,
                    dependencies,
                    composeOrder: ledger.units.length,
                    sourceSnapshotId: local.source.snapshot.sourceSnapshotId,
                    inputHash: local.inputHash,
                    estimatedCost: 0,
                    routePlan: [],
                    attemptedProviders: [],
                    retryBudget: 1,
                    enqueueTime: new Date().toISOString(),
                    layerEnterTime: new Date().toISOString(),
                };
                ledger.units.push(unit);
            } else if (unit.taskId !== input.registration.taskId
                || unit.recordId !== local.identity.conversationId
                || unit.layer !== "local-finalize"
                || unit.recordWorkKey !== work.recordWorkKey
                || unit.recordCommitEpoch !== work.recordCommitEpoch
                || !sameStringArray(unit.dependencies, dependencies)
                || unit.sourceSnapshotId !== local.source.snapshot.sourceSnapshotId
                || unit.inputHash !== local.inputHash
                || unit.estimatedCost !== 0
                || unit.routePlan.length !== 0) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "已有 local-finalize Unit 与本次正文、来源或依赖不一致");
            }
            let attempt = ledger.attempts.find(candidate => candidate.attemptId === local.attemptId);
            if (!attempt) {
                attempt = {
                    attemptId: local.attemptId,
                    unitId: local.unitId,
                    recordWorkKey: work.recordWorkKey,
                    originTaskIds: [input.registration.taskId],
                    activeTaskIds: [input.registration.taskId],
                    state: "Created",
                    provider: "local",
                    model: "local-finalize",
                    inputHash: local.inputHash,
                    managedByProductionPump: true,
                    fence: currentFence(work),
                };
                ledger.attempts.push(attempt);
            } else if (attempt.unitId !== local.unitId
                || attempt.recordWorkKey !== work.recordWorkKey
                || attempt.provider !== "local"
                || attempt.model !== "local-finalize"
                || attempt.inputHash !== local.inputHash
                || attempt.managedByProductionPump !== true) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "已有 local-finalize Attempt 与本次正文、work 或 provider 不一致");
            }
            if (attempt.state === "Created") {
                assertAttemptTransition(attempt.state, "DispatchIntentPersisted");
                attempt.state = "DispatchIntentPersisted";
                attempt.dispatchIntentAt = new Date().toISOString();
                attempt.dispatchIntentLedgerRevision = ledger.revision + 1;
                attempt.dispatchIntentRef = intent.reference;
                attempt.providerEvidence = `local-finalize:${local.attemptId}`;
                attempt.fence = currentFence(work);
            }
            refreshUnitCounters(ledger);
        });
    }

    private async assertLocalOutputMatchesExpected(
        input: RecordSchedulerLocalFinalizeInput,
        local: LocalFinalizeIdentity,
        outputRef: ImmutableBlobReference,
    ): Promise<void> {
        if (outputRef.hash !== local.contentHash || outputRef.byteLength !== local.contentByteLength) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "local-finalize KnownSuccess outputRef 与本次正文哈希不一致");
        }
        const bytes = await input.registration.spool.readImmutable({
            taskId: input.registration.taskId,
            kind: "output",
            reference: outputRef,
        });
        if (bytes.byteLength !== local.contentByteLength
            || sha256(bytes) !== local.contentHash
            || bytes.toString("utf8") !== input.content) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "local-finalize immutable output 与本次正文不一致");
        }
    }

    private async mutateOwnerLedger(
        taskId: string,
        ownerLease: SchedulerOwnerLease,
        mutate: (ledger: RecordSchedulerLedger) => void | Promise<void>,
    ): Promise<void> {
        for (let index = 0; index < MAX_CAS_RETRIES; index += 1) {
            const current = await requireLedger(taskId);
            const currentOwner = current.schedulerOwner;
            if (!currentOwner
                || currentOwner.ownerId !== ownerLease.ownerId
                || currentOwner.leaseId !== ownerLease.leaseId
                || currentOwner.schedulerEpoch !== ownerLease.schedulerEpoch
                || currentOwner.fencingToken !== ownerLease.fencingToken) {
                throw new RecordSchedulerExecutionDriverError("OWNER_UNAVAILABLE", "scheduler owner lease 已被替换或 fencing");
            }
            try {
                await mutateRecordSchedulerLedgerAsOwner(taskId, current.revision, currentOwner, mutate);
                return;
            } catch (error) {
                if (isSchedulerLedgerConflict(error)) continue;
                throw error;
            }
        }
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "production pump scheduler ledger CAS 重试耗尽");
    }

    private async isTaskCancelled(taskId: string): Promise<boolean> {
        const ledger = await requireLedger(taskId);
        return ledger.task.state === "CancelRequested" || ledger.task.state === "Cancelling" || ledger.task.state === "Cancelled";
    }

    private async readAttempt(prepared: PreparedModelAttempt): Promise<SchedulerAttemptLedger> {
        return requireAttempt(await requireLedger(prepared.registration.taskId), prepared.attemptId);
    }

    private async readAttemptIfPresent(prepared: PreparedModelAttempt): Promise<SchedulerAttemptLedger | undefined> {
        const ledger = await requireLedger(prepared.registration.taskId);
        return ledger.attempts.find(candidate => candidate.attemptId === prepared.attemptId);
    }

    private async releaseUnconsumedLease(attemptId: string): Promise<void> {
        const lease = this.leaseByAttempt.get(attemptId);
        if (!lease) return;
        try {
            await this.cancelAndVerifyPhysicalLease(lease);
        } finally {
            this.leaseByAttempt.delete(attemptId);
        }
    }

    private async cancelAndVerifyPhysicalLease(lease: ProviderTransportLease): Promise<void> {
        const identity = lease.identity;
        if (!identity) {
            await this.transport.cancel(lease);
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `provider lease ${lease.permitId} 缺少可恢复 identity`);
        }
        try {
            await this.transport.cancel(lease);
        } catch {}
        const settled = await this.transport.cancelRecoveredLease(identity);
        if (settled.kind !== "settled" && settled.kind !== "already-settled") {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `provider lease ${identity.leaseId} 取消回执无效`);
        }
    }

    private async quiesceInternal(options: RecordSchedulerProductionSessionsQuiesceOptions): Promise<RecordSchedulerProductionSessionsHandoff> {
        const timeoutMs = options.timeoutMs ?? 5_000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new TypeError("production pump quiesce timeoutMs 必须是非负安全整数");
        const critical = Promise.allSettled([
            this.coordinatorMutationTail,
            this.drainOperation ?? Promise.resolve(),
        ]).then(() => undefined);
        const timedOut = timeoutMs === 0 || !await waitForCritical(critical, timeoutMs);
        return await this.handoffSummary(timedOut);
    }

    private async releaseCoordinatorOwnerForHandoff(): Promise<void> {
        const lease = this.coordinatorLease;
        if (!lease) return;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const stored = await readRecordSchedulerCoordinatorStore(this.options.coordinatorStore);
            if (stored.kind !== "current") return;
            const persistedLease = stored.envelope.ownerLease;
            if (!persistedLease
                || persistedLease.epoch !== lease.epoch
                || persistedLease.leaseId !== lease.leaseId) {
                this.coordinatorLease = undefined;
                return;
            }
            try {
                await releaseRecordSchedulerCoordinatorOwner({
                    ...this.options.coordinatorStore,
                    expectedRevision: stored.envelope.revision,
                    ownerEpoch: lease.epoch,
                    ownerLeaseId: lease.leaseId,
                });
                this.coordinatorLease = undefined;
                return;
            } catch (error) {
                const code = errorCode(error);
                if (code === "OWNER_FENCED") {
                    this.coordinatorLease = undefined;
                    return;
                }
                if (code !== "REVISION_CONFLICT" || attempt > 0) throw error;
            }
        }
    }

    private async handoffSummary(timedOut: boolean): Promise<RecordSchedulerProductionSessionsHandoff> {
        const persisted: RecordSchedulerProductionPersistedHandoff[] = [];
        const taskIds = [...new Set([...this.registrations.values()].map(registration => registration.taskId))].sort();
        for (const taskId of taskIds) {
            const ledger = await requireLedger(taskId);
            const attempts = ledger.attempts.filter(attempt => attempt.managedByProductionPump === true);
            persisted.push({
                taskId,
                dispatchIntentAttemptIds: attempts.filter(attempt => attempt.state === "DispatchIntentPersisted").map(attempt => attempt.attemptId).sort(),
                activeAttemptIds: attempts.filter(attempt => attempt.state === "Dispatched").map(attempt => attempt.attemptId).sort(),
                unknownOutcomeAttemptIds: attempts.filter(attempt => attempt.state === "UnknownOutcome").map(attempt => attempt.attemptId).sort(),
            });
        }
        return {
            acceptingDispatches: this.acceptingDispatches,
            closed: this.closed,
            timedOut,
            activePendingAttemptIds: [...this.pending.values()].map(pending => pending.prepared.attemptId).sort(),
            invokingAttemptIds: [...this.runningByAttempt.keys()].sort(),
            persisted,
        };
    }

    private assertOpenForRegistration(): void {
        if (this.closed) throw new RecordSchedulerExecutionDriverError("OWNER_UNAVAILABLE", "production pump 已关闭，不能注册新 session");
    }

    private assertAcceptingDispatches(): void {
        this.assertOpenForRegistration();
        if (!this.acceptingDispatches) throw new RecordSchedulerExecutionDriverError("OWNER_UNAVAILABLE", "production pump 正在 quiesce，禁止创建新 claim 或 dispatch");
    }

    private scheduleClosedCleanup(): void {
        if (!this.closed || this.runningByAttempt.size > 0) return;
        const critical = Promise.allSettled([
            this.coordinatorMutationTail,
            this.drainOperation ?? Promise.resolve(),
        ]).then(() => {
            if (this.closed && this.runningByAttempt.size === 0) {
                this.registrations.clear();
                this.ownerRecoveryByTask.clear();
            }
        });
        void critical;
    }

    private resolvePending(key: string, result: RecordModelCallResult): void {
        const pending = this.pending.get(key);
        this.pending.delete(key);
        for (const waiter of pending?.waiters ?? []) waiter.resolve(result);
    }

    private rejectPending(key: string, error: unknown): void {
        const pending = this.pending.get(key);
        this.pending.delete(key);
        for (const waiter of pending?.waiters ?? []) waiter.reject(error);
    }

    private nowMs(): number {
        const now = this.clock.nowMs();
        if (!Number.isFinite(now)) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "production pump clock 返回了无效时间");
        return now;
    }

    private async emitAttemptPhase(
        phase: Extract<RecordSchedulerProductionPumpPhaseEvent["phase"], "provider-result-received" | "output-spool-persisted">,
        prepared: PreparedModelAttempt,
        claim: CoordinatorClaimBinding,
        output: NonNullable<RecordSchedulerProductionPumpPhaseEvent["output"]>,
    ): Promise<void> {
        const attempt = await this.readAttempt(prepared);
        if (!isNonEmptyString(attempt.idempotencyKey)) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${attempt.attemptId} 缺少 idempotencyKey`);
        }
        await this.emitPhase({
            phase,
            taskId: prepared.registration.taskId,
            unitId: prepared.unitId,
            attemptId: prepared.attemptId,
            idempotencyKey: attempt.idempotencyKey,
            fence: { ...attempt.fence },
            claim,
            output,
        });
    }

    private async emitPhase(event: RecordSchedulerProductionPumpPhaseEvent): Promise<void> {
        await this.options.onPhase?.(event);
    }

    private assertRegistration(registration: RecordSchedulerProductionRegistration): void {
        if (!isNonEmptyString(registration.taskId)
            || !isNonEmptyString(registration.sourceSnapshotId)
            || !isNonEmptyString(registration.recordStoreHash)
            || !isNonEmptyString(registration.schedulerOwner.ownerId)
            || !isNonEmptyString(registration.firstPublicationToken)) {
            throw new TypeError("production registration 缺少 task/source/owner/publication 绑定");
        }
        if (registration.frozenSources.phase !== "sealed") throw new RecordSchedulerExecutionDriverError("FROZEN_SOURCE_MISMATCH", "production pump 只能接收 sealed FrozenRuntimeSourceSet");
        const selectedSource = selectSource(registration.frozenSources, registration.sourceSnapshotId);
        if (registration.recordStoreHash !== selectedSource.snapshot.workspaceHash) {
            throw new RecordSchedulerExecutionDriverError("FROZEN_SOURCE_MISMATCH", "production registration recordStoreHash 必须等于 selected frozen source workspaceHash");
        }
    }
}

const sharedPumps = new Map<string, RecordSchedulerProductionPump>();

export function getRecordSchedulerProductionPump(options: RecordSchedulerProductionPumpOptions): RecordSchedulerProductionPump {
    const key = JSON.stringify([
        path.resolve(options.coordinatorStore?.dataRoot || DATA_ROOT),
        options.coordinatorStore?.snapshotFilePath || null,
    ]);
    const existing = sharedPumps.get(key);
    if (existing && !existing.isClosed()) return existing;
    if (existing) sharedPumps.delete(key);
    const created = new RecordSchedulerProductionPump(options);
    sharedPumps.set(key, created);
    return created;
}

export async function quiesceRecordSchedulerProductionSessions(
    options: RecordSchedulerProductionSessionsQuiesceOptions = {},
): Promise<RecordSchedulerProductionSessionsHandoff> {
    const handoffs = await Promise.all([...sharedPumps.values()].map(async pump => await pump.quiesce(options)));
    return mergeProductionHandoffs(handoffs, false);
}

export async function closeRecordSchedulerProductionSessions(
    options: RecordSchedulerProductionSessionsQuiesceOptions = {},
): Promise<RecordSchedulerProductionSessionsHandoff> {
    const entries = [...sharedPumps.entries()];
    const handoffs = await Promise.all(entries.map(async ([, pump]) => await pump.close(options)));
    for (const [key, pump] of entries) {
        if (sharedPumps.get(key) === pump) sharedPumps.delete(key);
    }
    return mergeProductionHandoffs(handoffs, true);
}

export function createRecordSchedulerProductionModelCallHook(
    registration: RecordSchedulerProductionRegistration,
    options: RecordSchedulerProductionPumpOptions,
): RecordSchedulerModelCallHook {
    return getRecordSchedulerProductionPump(options).register(registration);
}

export function createRecordSchedulerProductionSession(
    registration: RecordSchedulerProductionRegistration,
    options: RecordSchedulerProductionPumpOptions,
): RecordSchedulerProductionSession {
    return getRecordSchedulerProductionPump(options).createSession(registration);
}

function providerAdmission(provider: RecordSchedulerModelCallContext["provider"]): SchedulerAttemptAdmission {
    return provider === "grok" || provider === "agy" ? "provider-transport" : "synthetic";
}

function physicalProvider(provider: RecordSchedulerModelCallContext["provider"]): ProviderId {
    if (provider === "grok" || provider === "agy") return provider;
    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `provider ${provider} 不能请求物理 transport permit`);
}

function requirePhysicalLeaseIdentity(
    lease: ProviderTransportLease,
    provider: ProviderId,
    attemptId: string,
    trafficClass: ProviderTrafficClass,
): ProviderLeaseIdentity {
    const identity = lease.identity;
    if (!identity
        || identity.provider !== provider
        || identity.trafficClass !== trafficClass
        || identity.attemptId !== attemptId
        || identity.leaseId !== lease.permitId
        || identity.expiresAt < identity.acquiredAt) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `physical provider lease ${lease.permitId} identity 不完整或与 Attempt 不一致`);
    }
    return cloneProviderLeaseIdentity(identity)!;
}

function requirePersistedClaimLeaseIdentity(
    claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>,
    provider: ProviderId,
    attemptId: string,
    trafficClass?: ProviderTrafficClass,
): ProviderLeaseIdentity {
    const identity = claim.providerLeaseIdentity;
    if (!identity
        || identity.provider !== provider
        || trafficClass !== undefined && identity.trafficClass !== trafficClass
        || identity.attemptId !== attemptId
        || identity.leaseId !== claim.permitId
        || identity.expiresAt < identity.acquiredAt) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `coordinator claim ${claim.claimId} provider lease identity 不完整或不匹配`);
    }
    return cloneProviderLeaseIdentity(identity)!;
}

function claimProviderLeaseIdentity(claim: CoordinatorClaimBinding): ProviderLeaseIdentity | undefined {
    const admission = requireClaimAdmission(claim);
    if (admission !== "provider-transport") {
        if (claim.providerLeaseIdentity !== undefined) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "synthetic coordinator claim 不得携带物理 provider lease identity");
        }
        return undefined;
    }
    const provider = claim.providerLeaseIdentity?.provider;
    if (!provider || (provider !== "grok" && provider !== "agy")) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "provider-transport coordinator claim 缺少 lease identity");
    }
    return requirePersistedClaimLeaseIdentity(claim as RecordSchedulerCoordinatorPersistedClaim, provider, claim.attemptId || "");
}

function assertInvokeLeaseBinding(
    prepared: PreparedModelAttempt,
    claim: RecordSchedulerCoordinatorClaim,
    lease: ProviderTransportLease | undefined,
): void {
    const admission = requireClaimAdmission(claim);
    if (admission !== "provider-transport") {
        if (lease !== undefined || claim.providerLeaseIdentity !== undefined) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "synthetic provider invocation 不能携带物理 lease");
        }
        return;
    }
    if (!lease) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${prepared.attemptId} invoking 前丢失物理 provider lease`);
    const identity = requirePhysicalLeaseIdentity(lease, physicalProvider(prepared.provider), prepared.attemptId, prepared.trafficClass);
    if (!sameProviderLeaseIdentity(identity, claimProviderLeaseIdentity(claim))) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${prepared.attemptId} 的内存 lease 与持久 claim 不一致`);
    }
}

function cloneProviderLeaseIdentity(identity: ProviderLeaseIdentity | undefined): ProviderLeaseIdentity | undefined {
    return identity === undefined ? undefined : { ...identity };
}

function sameProviderLeaseIdentity(left: ProviderLeaseIdentity | undefined, right: ProviderLeaseIdentity | undefined): boolean {
    return left?.provider === right?.provider
        && left?.trafficClass === right?.trafficClass
        && left?.attemptId === right?.attemptId
        && left?.leaseId === right?.leaseId
        && left?.ownerEpoch === right?.ownerEpoch
        && left?.capacityGeneration === right?.capacityGeneration
        && left?.acquiredAt === right?.acquiredAt
        && left?.expiresAt === right?.expiresAt;
}

function recoveryPermitClaimMatchesAttempt(
    claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>,
    attempt: SchedulerAttemptLedger,
    unit: SchedulerUnitLedger,
): boolean {
    if (claim.attemptId !== attempt.attemptId
        || claim.taskId !== unit.taskId
        || claim.recordId !== unit.recordId
        || claim.unitId !== unit.unitId
        || attempt.state !== "DispatchIntentPersisted"
        || unit.state !== "Queued"
        || attempt.claimId !== undefined
        || attempt.permitId !== undefined
        || attempt.dispatchSeq !== undefined
        || attempt.providerAdmission !== undefined
        || attempt.providerLeaseIdentity !== undefined
        || attempt.dispatchPhase !== undefined) return false;
    if (claim.providerAdmission === "synthetic") return claim.providerLeaseIdentity === undefined;
    if (claim.providerAdmission !== "provider-transport" || (attempt.provider !== "grok" && attempt.provider !== "agy")) return false;
    try {
        requirePersistedClaimLeaseIdentity(claim, attempt.provider, attempt.attemptId, attempt.trafficClass ?? "record");
        return true;
    } catch {
        return false;
    }
}

async function waitForCritical(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation.then(() => true),
            new Promise<boolean>(resolve => {
                timer = setTimeout(() => resolve(false), timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

function mergeProductionHandoffs(
    handoffs: readonly RecordSchedulerProductionSessionsHandoff[],
    closed: boolean,
): RecordSchedulerProductionSessionsHandoff {
    return {
        acceptingDispatches: handoffs.every(handoff => handoff.acceptingDispatches),
        closed,
        timedOut: handoffs.some(handoff => handoff.timedOut),
        activePendingAttemptIds: [...new Set(handoffs.flatMap(handoff => handoff.activePendingAttemptIds))].sort(),
        invokingAttemptIds: [...new Set(handoffs.flatMap(handoff => handoff.invokingAttemptIds))].sort(),
        persisted: handoffs.flatMap(handoff => handoff.persisted).sort((left, right) => left.taskId.localeCompare(right.taskId)),
    };
}

function selectSource(sources: FrozenRuntimeSourceSet, sourceSnapshotId: string): FrozenRuntimeSource {
    if (sources.phase !== "sealed") throw new RecordSchedulerExecutionDriverError("FROZEN_SOURCE_MISMATCH", "只允许 sealed frozen sources");
    const source = sources.sources.find(candidate => candidate.snapshot.sourceSnapshotId === sourceSnapshotId);
    if (!source) throw new RecordSchedulerExecutionDriverError("FROZEN_SOURCE_MISMATCH", `冻结来源缺少 ${sourceSnapshotId}`);
    return source;
}

async function assertFrozenSourceMatchesLedger(taskId: string, source: FrozenRuntimeSource): Promise<void> {
    const ledger = await requireLedger(taskId);
    const stored = ledger.sourceSnapshots.find(candidate => candidate.sourceSnapshotId === source.snapshot.sourceSnapshotId);
    if (!stored
        || stored.snapshotHash !== source.snapshot.snapshotHash
        || stored.contentHash !== source.snapshot.contentHash
        || stored.desiredRevision !== source.snapshot.desiredRevision
        || stored.conversationId !== source.snapshot.conversationId
        || stored.chain !== source.snapshot.chain
        || stored.workspaceHash !== source.snapshot.workspaceHash) {
        throw new RecordSchedulerExecutionDriverError("FROZEN_SOURCE_MISMATCH", "scheduler ledger 与 frozen source 的身份或内容哈希不一致");
    }
}

function canonicalIdentity(source: FrozenRuntimeSource): CanonicalConversationIdentity {
    return {
        chain: source.snapshot.chain,
        workspaceHash: source.snapshot.workspaceHash,
        conversationId: source.snapshot.conversationId,
    };
}

async function startOrAttachWithRetry(
    location: { identity: CanonicalConversationIdentity; dataRoot: string },
    desiredRevision: string,
    taskId: string,
) {
    for (let index = 0; index < MAX_CAS_RETRIES; index += 1) {
        const registry = await readRecordWorkRegistry(location);
        if (registry.kind !== "ready") return registry;
        const started = await startOrAttachRecordWork({
            ...location,
            desiredRevision,
            taskId,
            expectedRegistryRevision: registry.registry.registryRevision,
        });
        if (started.kind !== "cas_conflict") return started;
    }
    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "record work registry CAS 重试耗尽");
}

async function acquireRecordWorkLeaseWithRetry(
    location: { identity: CanonicalConversationIdentity; dataRoot: string },
    recordWorkKeyValue: string,
    taskId: string,
    ownerLease: SchedulerOwnerLease,
    leaseDurationMs: number,
    nowMs: number,
): Promise<AcquiredRecordWorkLease> {
    for (let index = 0; index < MAX_CAS_RETRIES; index += 1) {
        const current = await readRecordWorkRegistry(location);
        if (current.kind !== "ready") {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `record work registry 无法读取: ${current.reason}`);
        }
        const work = current.registry.works.find(candidate => candidate.recordWorkKey === recordWorkKeyValue);
        const reusableLeaseId = work?.ownerLease
            && work.ownerLease.ownerId === ownerLease.ownerId
            && work.ownerLease.schedulerEpoch === ownerLease.schedulerEpoch
            ? work.ownerLease.workLeaseId
            : undefined;
        const acquired = await acquireRecordWorkLease({
            ...location,
            recordWorkKey: recordWorkKeyValue,
            taskId,
            ownerId: ownerLease.ownerId,
            schedulerEpoch: ownerLease.schedulerEpoch,
            expectedRegistryRevision: current.registry.registryRevision,
            ...(reusableLeaseId ? { workLeaseId: reusableLeaseId } : {}),
            leaseDurationMs,
            nowMs,
        });
        if (acquired.kind === "cas_conflict") continue;
        if (acquired.kind === "acquired") return acquired;
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `record work lease 无法取得: ${acquired.kind}`);
    }
    throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "record work lease CAS 重试耗尽");
}

function isPublicationGenerationAdvanceForTask(
    work: RecordWorkRegistryEntry,
    taskId: string,
    previous: SchedulerRecordWork,
): boolean {
    return (work.publicationHistory || []).some(entry => entry.supersededByTaskId === taskId
        && entry.claim.schedulerEpoch === previous.schedulerEpoch
        && entry.claim.recordCommitEpoch === previous.recordCommitEpoch
        && entry.claim.fencingToken === previous.currentFencingToken
        && entry.claim.workLeaseId === previous.workLeaseId
        && entry.nextRecordCommitEpoch === work.recordCommitEpoch);
}

function synchronizeSchedulerWorkFromRegistry(
    ledger: RecordSchedulerLedger,
    work: SchedulerRecordWork,
    acquired: ResolvedRecordWorkFence,
    registryRef: ImmutableBlobReference,
): void {
    const previousFence = currentFence(work);
    const nextFence = acquired.fence;
    const generationAdvanced = work.recordCommitEpoch !== acquired.work.recordCommitEpoch;
    if (generationAdvanced) {
        const hasBoundExecution = ledger.units.some(unit => unit.recordWorkKey === work.recordWorkKey)
            || ledger.attempts.some(attempt => attempt.recordWorkKey === work.recordWorkKey)
            || ledger.commits.some(commit => commit.recordWorkKey === work.recordWorkKey);
        if (hasBoundExecution) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "publication generation 推进前 scheduler ledger 已存在绑定旧 epoch 的 Unit/Attempt/Commit");
        }
        work.recordCommitEpoch = acquired.work.recordCommitEpoch;
    }
    work.registryRevision = acquired.registry.registryRevision;
    work.registryRef = registryRef;
    work.schedulerEpoch = nextFence.schedulerEpoch;
    work.workLeaseId = nextFence.workLeaseId;
    work.leaseOwnerId = acquired.lease.ownerId;
    work.leaseExpiresAt = acquired.lease.expiresAt;
    work.activeTaskIds = [...acquired.work.activeTaskIds];
    work.currentFencingToken = nextFence.fencingToken;
    for (const attempt of ledger.attempts) {
        if (attempt.recordWorkKey !== work.recordWorkKey) continue;
        if (["Created", "DispatchIntentPersisted", "Dispatched", "KnownSuccess"].includes(attempt.state)) {
            if (!sameFence(attempt.fence, previousFence) && !sameFence(attempt.fence, nextFence)) {
                throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${attempt.attemptId} 的 fence 无法与 registry 同步`);
            }
            attempt.fence = { ...nextFence };
            if (attempt.leaseExpiresAt) attempt.leaseExpiresAt = acquired.lease.expiresAt;
        } else if (attempt.state === "UnknownOutcome"
            && attempt.fence.fencingToken === nextFence.fencingToken
            && sameFence(attempt.fence, previousFence)) {
            attempt.fence = { ...nextFence };
        }
    }
    for (const commit of ledger.commits) {
        if (commit.recordWorkKey !== work.recordWorkKey
            || !["ResultReady", "BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten", "Verified", "CleanupPending"].includes(commit.state)) continue;
        if (!sameFence(commit.fence, previousFence) && !sameFence(commit.fence, nextFence)) {
            throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Commit ${commit.commitId} 的 fence 无法与 registry 同步`);
        }
        commit.fence = { ...nextFence };
        if (commit.beforeImage) commit.beforeImage.fence = { ...nextFence };
        if (commit.cleanupReadBack) commit.cleanupReadBack.fence = { ...nextFence };
    }
}

async function registryReference(dataRoot: string, registryPath: string, registry: RecordWorkRegistry): Promise<ImmutableBlobReference> {
    const relativePath = path.relative(dataRoot, registryPath).replace(/\\/gu, "/");
    if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "record work registry 路径越出 dataRoot");
    }
    const stat = await fs.stat(registryPath);
    return { path: relativePath, hash: registry.persistedHash, byteLength: stat.size };
}

async function requireLedger(taskId: string, nowMs?: number): Promise<RecordSchedulerLedger & { schedulerOwner?: SchedulerOwnerLease; schedulerOwnerRecovery?: unknown }> {
    const current = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true, nowMs });
    if (current.kind !== "current") {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `无法读取 scheduler ledger ${taskId}: ${current.kind}`);
    }
    return current.ledger;
}

function requireWork(ledger: RecordSchedulerLedger, key: string): SchedulerRecordWork {
    const work = ledger.recordWork.find(candidate => candidate.recordWorkKey === key);
    if (!work) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `缺少 record work ${key}`);
    return work;
}

function requireUnit(ledger: RecordSchedulerLedger, unitId: string): SchedulerUnitLedger {
    const unit = ledger.units.find(candidate => candidate.unitId === unitId);
    if (!unit) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `缺少 Unit ${unitId}`);
    return unit;
}

function requireAttempt(ledger: RecordSchedulerLedger, attemptId: string): SchedulerAttemptLedger {
    const attempt = ledger.attempts.find(candidate => candidate.attemptId === attemptId);
    if (!attempt) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `缺少 Attempt ${attemptId}`);
    return attempt;
}

function createPreparedModelUnit(prepared: PreparedModelAttempt, work: SchedulerRecordWork): SchedulerUnitLedger {
    const enteredAt = new Date().toISOString();
    return {
        unitId: prepared.unitId,
        taskId: prepared.registration.taskId,
        recordId: prepared.identity.conversationId,
        state: "Queued",
        layer: "provider-attempt",
        splitDepth: prepared.descriptor.splitDepth,
        recordWorkKey: work.recordWorkKey,
        recordCommitEpoch: work.recordCommitEpoch,
        dependencies: [...prepared.descriptor.dependencies],
        ...(prepared.descriptor.recipe.continuationKey ? { continuationKey: prepared.descriptor.recipe.continuationKey } : {}),
        composeOrder: prepared.descriptor.recipe.composeOrder,
        sourceSnapshotId: prepared.source.snapshot.sourceSnapshotId,
        inputHash: prepared.inputHash,
        estimatedCost: 1,
        routePlan: [...prepared.call.routePlan],
        routeCursor: prepared.routeIndex,
        attemptedProviders: [],
        retryBudget: prepared.call.retryBudget,
        promptRecipe: structuredClone(prepared.descriptor.recipe),
        ...(prepared.descriptor.parentUnitId ? { parentUnitId: prepared.descriptor.parentUnitId } : {}),
        unitAttempts: 0,
        providerAttemptCounts: {},
        enqueueTime: enteredAt,
        layerEnterTime: enteredAt,
    };
}

function assertPreparedModelUnitMatches(unit: SchedulerUnitLedger, prepared: PreparedModelAttempt, work: SchedulerRecordWork): void {
    const mismatches: string[] = [];
    if (unit.taskId !== prepared.registration.taskId) mismatches.push("taskId");
    if (unit.recordId !== prepared.identity.conversationId) mismatches.push("recordId");
    if (unit.layer !== "provider-attempt") mismatches.push("layer");
    if (unit.recordWorkKey !== work.recordWorkKey) mismatches.push("recordWorkKey");
    if (unit.recordCommitEpoch !== work.recordCommitEpoch) mismatches.push("recordCommitEpoch");
    if (unit.sourceSnapshotId !== prepared.source.snapshot.sourceSnapshotId) mismatches.push("sourceSnapshotId");
    if (unit.inputHash !== prepared.inputHash) mismatches.push("inputHash");
    if (!sameStringArray(unit.routePlan, prepared.call.routePlan)) mismatches.push("routePlan");
    if (unit.splitDepth !== prepared.descriptor.splitDepth) mismatches.push("splitDepth");
    if (unit.composeOrder !== prepared.descriptor.recipe.composeOrder) mismatches.push("composeOrder");
    if ((unit.parentUnitId || undefined) !== (prepared.descriptor.parentUnitId || undefined)) mismatches.push("parentUnitId");
    if (!sameStringArray(unit.dependencies, prepared.descriptor.dependencies)) mismatches.push("dependencies");
    if ((unit.continuationKey || undefined) !== (prepared.descriptor.recipe.continuationKey || undefined)) mismatches.push("continuationKey");
    if (hashJson(unit.promptRecipe ?? null) !== hashJson(prepared.descriptor.recipe)) mismatches.push("promptRecipe");
    if (mismatches.length > 0) {
        throw new RecordSchedulerExecutionDriverError(
            "REPAIR_REQUIRED",
            `稳定 logicalCallKey ${prepared.call.logicalCallKey} 对应的 Unit 与冻结来源不一致：${mismatches.join(",")}`,
        );
    }
}

function currentFence(work: SchedulerRecordWork): SchedulerAttemptLedger["fence"] {
    return {
        schedulerEpoch: work.schedulerEpoch,
        recordCommitEpoch: work.recordCommitEpoch,
        fencingToken: work.currentFencingToken,
        workLeaseId: work.workLeaseId,
    };
}

function sameFence(left: SchedulerAttemptLedger["fence"], right: SchedulerAttemptLedger["fence"]): boolean {
    return left.schedulerEpoch === right.schedulerEpoch
        && left.recordCommitEpoch === right.recordCommitEpoch
        && left.fencingToken === right.fencingToken
        && left.workLeaseId === right.workLeaseId;
}

function assertAttemptFenceCurrent(attempt: SchedulerAttemptLedger, work: SchedulerRecordWork): void {
    if (!sameFence(attempt.fence, currentFence(work))) {
        throw new RecordSchedulerExecutionDriverError("UNKNOWN_OUTCOME", `Attempt ${attempt.attemptId} 的 fence 已过期，禁止写入 provider 结果`);
    }
}

function refreshUnitCounters(ledger: RecordSchedulerLedger): void {
    ledger.task.units.materialized = ledger.units.length;
    ledger.task.units.eligible = ledger.units.filter(unit => unit.state === "Queued").length;
    ledger.task.units.running = ledger.units.filter(unit => unit.state === "Running" || unit.state === "Committing").length;
    ledger.task.units.done = ledger.units.filter(unit => ["Succeeded", "FailedFinal", "Cancelled", "Discarded", "Superseded"].includes(unit.state)).length;
    ledger.task.units.failed = ledger.units.filter(unit => unit.state === "FailedFinal").length;
    ledger.task.recordItems.succeeded = ledger.units.filter(unit => unit.state === "Succeeded" && unit.layer === "local-finalize").length;
    ledger.task.recordItems.failed = ledger.units.filter(unit => unit.state === "FailedFinal" && unit.layer === "local-finalize").length;
}

function assertActiveClaim(attempt: SchedulerAttemptLedger, claim: CoordinatorClaimBinding): void {
    if (!claimMatchesAttempt(attempt, claim)) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "Attempt 与 active coordinator claim 双向绑定不一致");
    }
}

function claimIdentityMatchesAttempt(attempt: SchedulerAttemptLedger, claim: CoordinatorClaimBinding): boolean {
    return attempt.claimId === claim.claimId
        && attempt.permitId === claim.permitId
        && attempt.dispatchSeq === claim.dispatchSeq
        && attempt.providerAdmission === requireClaimAdmission(claim)
        && attempt.providerEvidence === requireClaimEvidence(claim)
        && sameProviderLeaseIdentity(attempt.providerLeaseIdentity, claimProviderLeaseIdentity(claim));
}

function claimMatchesAttempt(attempt: SchedulerAttemptLedger, claim: CoordinatorClaimBinding): boolean {
    return claimIdentityMatchesAttempt(attempt, claim)
        && attempt.dispatchPhase === "invoking";
}

function preInvokeFailureResult(error: unknown): RecordModelCallResult {
    return { text: null, error: errorMessage(error), failureClass: "Persistence" };
}

function requireClaimAdmission(claim: CoordinatorClaimBinding): SchedulerAttemptAdmission {
    if (!claim.providerAdmission) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "coordinator claim 缺少 provider admission 类型");
    return claim.providerAdmission;
}

function requireClaimEvidence(claim: CoordinatorClaimBinding): string {
    if (!isNonEmptyString(claim.providerEvidence)) throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", "coordinator claim 缺少 provider evidence");
    return claim.providerEvidence;
}

function replaceSnapshot(target: RecordSchedulerCoordinatorSnapshot, source: RecordSchedulerCoordinatorSnapshot): void {
    for (const key of Object.keys(target) as Array<keyof RecordSchedulerCoordinatorSnapshot>) delete target[key];
    Object.assign(target, structuredClone(source));
}

function jsonSnapshot(snapshot: RecordSchedulerCoordinatorSnapshot): RecordSchedulerCoordinatorSnapshot {
    return JSON.parse(JSON.stringify(snapshot)) as RecordSchedulerCoordinatorSnapshot;
}

function registrationKey(registration: RecordSchedulerProductionRegistration): string {
    return JSON.stringify([registration.taskId, registration.sourceSnapshotId]);
}

function pendingIdentityKey(taskId: string, recordId: string, unitId: string, attemptId: string): string {
    return JSON.stringify([taskId, recordId, unitId, attemptId]);
}

function recoveryAttemptKey(taskId: string, attemptId: string): string {
    return JSON.stringify([taskId, attemptId]);
}

function recoveryClaimMatchesAttempt(
    claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>,
    attempt: SchedulerAttemptLedger,
    unit: SchedulerUnitLedger,
): boolean {
    return claim.attemptId === attempt.attemptId
        && claim.taskId === unit.taskId
        && claim.recordId === unit.recordId
        && claim.unitId === unit.unitId
        && claim.claimId === attempt.claimId
        && claim.permitId === attempt.permitId
        && claim.dispatchSeq === attempt.dispatchSeq
        && claim.dispatchPhase === attempt.dispatchPhase
        && claim.providerAdmission === attempt.providerAdmission
        && claim.providerEvidence === attempt.providerEvidence
        && sameProviderLeaseIdentity(claim.providerLeaseIdentity, attempt.providerLeaseIdentity)
        && attempt.activeTaskIds.includes(claim.taskId)
        && attempt.state === "Dispatched"
        && unit.state === "Running"
        && (claim.dispatchPhase === "attempt-bound" || claim.dispatchPhase === "invoking");
}

function recoverySettledClaimMatchesAttempt(
    claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>,
    attempt: SchedulerAttemptLedger,
    unit: SchedulerUnitLedger,
): boolean {
    return claim.attemptId === attempt.attemptId
        && claim.taskId === unit.taskId
        && claim.recordId === unit.recordId
        && claim.unitId === unit.unitId
        && claim.claimId === attempt.claimId
        && claim.permitId === attempt.permitId
        && claim.dispatchSeq === attempt.dispatchSeq
        && claim.dispatchPhase === attempt.dispatchPhase
        && claim.providerAdmission === attempt.providerAdmission
        && claim.providerEvidence === attempt.providerEvidence
        && sameProviderLeaseIdentity(claim.providerLeaseIdentity, attempt.providerLeaseIdentity)
        && attempt.activeTaskIds.includes(claim.taskId)
        && claim.dispatchPhase === "invoking";
}

function recoveryDiscardedUnknownClaimMatchesAttempt(
    claim: Readonly<RecordSchedulerCoordinatorPersistedClaim>,
    attempt: SchedulerAttemptLedger,
    unit: SchedulerUnitLedger,
): boolean {
    return claim.attemptId === attempt.attemptId
        && claim.taskId === unit.taskId
        && claim.recordId === unit.recordId
        && claim.unitId === unit.unitId
        && claim.claimId === attempt.claimId
        && claim.permitId === attempt.permitId
        && claim.dispatchSeq === attempt.dispatchSeq
        && claim.dispatchPhase === attempt.dispatchPhase
        && claim.providerAdmission === attempt.providerAdmission
        && isNonEmptyString(claim.providerEvidence)
        && attempt.providerEvidence?.startsWith(`${claim.providerEvidence};unknown:`) === true
        && sameProviderLeaseIdentity(claim.providerLeaseIdentity, attempt.providerLeaseIdentity)
        && !attempt.activeTaskIds.includes(claim.taskId)
        && claim.dispatchPhase === "invoking";
}

function latestAttempt(
    ledger: RecordSchedulerLedger,
    unitId: string,
    predicate: (attempt: SchedulerAttemptLedger) => boolean,
): SchedulerAttemptLedger | undefined {
    return ledger.attempts
        .filter(attempt => attempt.unitId === unitId && predicate(attempt))
        .sort((left, right) => attemptOrdinal(right.attemptId, unitId) - attemptOrdinal(left.attemptId, unitId))[0];
}

function splitCompositionHash(
    items: ReadonlyArray<{ descriptor: ModelUnitDescriptor; outputRef: ImmutableBlobReference }>,
): string {
    return hashJson(items.map(item => ({
        unitId: item.descriptor.unitId,
        range: item.descriptor.recipe.range,
        outputHash: item.outputRef.hash,
    })));
}

function commonValue<Value>(values: readonly (Value | null | undefined)[]): Value | null {
    const present = values.filter((value): value is Value => value !== null && value !== undefined);
    if (present.length === 0) return null;
    return present.every(value => value === present[0]) ? present[0] : null;
}

function composedModelResult(results: readonly RecordModelCallResult[]): RecordModelCallResult {
    return {
        text: results.map(result => result.text || "").join("\n\n"),
        chainUsed: commonValue(results.map(result => result.chainUsed)),
        modelUsed: commonValue(results.map(result => result.modelUsed)) || "record-scheduler-compose/v1",
    };
}

function attemptKey(prepared: PreparedModelAttempt): string {
    return pendingIdentityKey(prepared.registration.taskId, prepared.identity.conversationId, prepared.unitId, prepared.attemptId);
}

function attemptOrdinal(attemptId: string, unitId: string): number {
    const prefix = `${unitId}:attempt:`;
    if (!attemptId.startsWith(prefix)) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${attemptId} 不属于 Unit ${unitId}`);
    }
    const ordinal = Number(attemptId.slice(prefix.length));
    if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
        throw new RecordSchedulerExecutionDriverError("REPAIR_REQUIRED", `Attempt ${attemptId} 缺少有效代际 ordinal`);
    }
    return ordinal;
}

function stableId(prefix: string, value: unknown): string {
    return `${prefix}-${hashJson(value).slice(0, 32)}`;
}

function uniqueSorted(values: readonly string[]): string[] {
    return [...new Set(values)].sort();
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hashJson(value: unknown): string {
    return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function sha256(value: Uint8Array): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function elapsedMs(startedAt: string | undefined): number {
    const startedMs = startedAt ? Date.parse(startedAt) : Date.now();
    return Math.max(0, Date.now() - (Number.isFinite(startedMs) ? startedMs : Date.now()));
}

function isRecordModelResult(value: unknown): value is RecordModelCallResult {
    return typeof value === "object" && value !== null && "text" in value
        && (((value as RecordModelCallResult).text === null) || typeof (value as RecordModelCallResult).text === "string");
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function errorCode(error: unknown): string | undefined {
    return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function isSchedulerLedgerConflict(error: unknown): boolean {
    const code = errorCode(error);
    return code === "SCHEDULER_LEDGER_CONFLICT" || code === "REVISION_CONFLICT";
}
