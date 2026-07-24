import { AsyncLocalStorage } from "node:async_hooks";

export const RECORD_SCHEDULER_FAIRNESS_STATE_VERSION = 2 as const;

export class FairnessGrantReentrancyError extends Error {
    public readonly code = "FAIRNESS_GRANT_REENTRANCY";

    public constructor() {
        super("Fairness grantNext cannot re-enter from its permit callback");
        this.name = "FairnessGrantReentrancyError";
    }
}

export type FairnessUnitStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface RecordSchedulerInnerFairnessConfig {
    layerWaitHorizonMs: number;
    taskAgeHorizonMs: number;
    unitQueueCreditQuantumMs: number;
    sizeCostCap: number;
    layerFailureCap: number;
    totalFailureCap: number;
    layerWaitWeight: number;
    taskAgeWeight: number;
    unitQueueCreditWeight: number;
    sizeWeight: number;
    layerFailureWeight: number;
    totalFailureWeight: number;
    completionWeight: number;
}

export interface RecordSchedulerFairnessConfig {
    waitingCreditPerMs: number;
    serviceDebtWeight: number;
    maxRestartElapsedMs: number;
    inner: RecordSchedulerInnerFairnessConfig;
}

export type RecordSchedulerFairnessConfigInput = Partial<Omit<RecordSchedulerFairnessConfig, "inner">> & {
    inner?: Partial<RecordSchedulerInnerFairnessConfig>;
};

export const DEFAULT_RECORD_SCHEDULER_FAIRNESS_CONFIG: Readonly<RecordSchedulerFairnessConfig> = {
    waitingCreditPerMs: 0.01,
    serviceDebtWeight: 1,
    maxRestartElapsedMs: 60_000,
    inner: {
        layerWaitHorizonMs: 60_000,
        taskAgeHorizonMs: 300_000,
        unitQueueCreditQuantumMs: 50,
        sizeCostCap: 100,
        layerFailureCap: 3,
        totalFailureCap: 5,
        layerWaitWeight: 0.7,
        taskAgeWeight: 0.4,
        unitQueueCreditWeight: 1,
        sizeWeight: 0.4,
        layerFailureWeight: 0.3,
        totalFailureWeight: 0.3,
        completionWeight: 0.4,
    },
};

export interface FairnessUnitInput {
    unitId: string;
    layer: string;
    estimatedCost: number;
    dependencies?: readonly string[];
    nextEligibleAt?: number;
    enqueueAt?: number;
    layerEnteredAt?: number;
    layerFailures?: number;
    totalFailures?: number;
    status?: FairnessUnitStatus;
}

export interface FairnessRecordInput {
    taskId: string;
    recordId: string;
    taskCreatedAt: number;
    serviceDebt?: number;
    units?: readonly FairnessUnitInput[];
}

export interface FairnessUnitSnapshot {
    unitId: string;
    layer: string;
    estimatedCost: number;
    dependencies: string[];
    nextEligibleAt?: number;
    enqueueAt: number;
    layerEnteredAt: number;
    layerFailures: number;
    totalFailures: number;
    status: FairnessUnitStatus;
    chargedCost?: number;
    parentUnitId?: string;
}

export interface FairnessWindowSnapshot {
    startSeq: number;
    deadlineSeq: number;
    populationN: number;
}

export interface FairnessRecordSnapshot {
    taskId: string;
    recordId: string;
    taskCreatedAt: number;
    serviceDebt: number;
    waitingCredit: number;
    cumulativeWaitingMs: number;
    lastServedSeq?: number;
    baselinePending: boolean;
    window?: FairnessWindowSnapshot;
    units: FairnessUnitSnapshot[];
}

export interface RecordSchedulerFairnessSnapshot {
    version: typeof RECORD_SCHEDULER_FAIRNESS_STATE_VERSION;
    logicalNowMs: number;
    dispatchSeq: number;
    records: FairnessRecordSnapshot[];
}

export interface FairnessUnitFactors {
    layerWait: number;
    taskAge: number;
    unitQueueCredit: number;
    sizeBonus: number;
    layerFailure: number;
    totalFailure: number;
    completionProgress: number;
}

export interface FairnessCandidate {
    taskId: string;
    recordId: string;
    unitId: string;
    estimatedCost: number;
    outerScore: number;
    innerScore: number;
    factors: FairnessUnitFactors;
    deadlineSeq?: number;
}

export type FairnessGrantResult =
    | { granted: true; dispatchSeq: number; candidate: FairnessCandidate }
    | { granted: false; reason: "no-eligible" | "provider-denied"; candidate?: FairnessCandidate };

export type FairnessPermitDecision = boolean | { granted: false; continueHandoff: true };

export interface SettleUnitInput {
    actualCost: number;
    status: Extract<FairnessUnitStatus, "queued" | "done" | "failed" | "cancelled">;
    nextEligibleAt?: number;
}

export interface SplitUnitInput extends Omit<FairnessUnitInput, "estimatedCost"> {
    estimatedCost?: number;
}

interface FairnessUnitRuntime extends FairnessUnitSnapshot {}

interface FairnessRecordRuntime extends Omit<FairnessRecordSnapshot, "units"> {
    units: Map<string, FairnessUnitRuntime>;
}

function mergeConfig(input: RecordSchedulerFairnessConfigInput): RecordSchedulerFairnessConfig {
    const config: RecordSchedulerFairnessConfig = {
        waitingCreditPerMs: input.waitingCreditPerMs ?? DEFAULT_RECORD_SCHEDULER_FAIRNESS_CONFIG.waitingCreditPerMs,
        serviceDebtWeight: input.serviceDebtWeight ?? DEFAULT_RECORD_SCHEDULER_FAIRNESS_CONFIG.serviceDebtWeight,
        maxRestartElapsedMs: input.maxRestartElapsedMs ?? DEFAULT_RECORD_SCHEDULER_FAIRNESS_CONFIG.maxRestartElapsedMs,
        inner: {
            ...DEFAULT_RECORD_SCHEDULER_FAIRNESS_CONFIG.inner,
            ...input.inner,
        },
    };
    for (const value of [
        config.waitingCreditPerMs,
        config.serviceDebtWeight,
        config.maxRestartElapsedMs,
        ...Object.values(config.inner),
    ]) {
        if (!Number.isFinite(value) || value <= 0) throw new Error("Fairness configuration values must be positive finite numbers");
    }
    return config;
}

function requireFiniteNonNegative(value: number, field: string): void {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative finite number`);
}

function requireFinite(value: number, field: string): void {
    if (!Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
}

function requireNonEmptyString(value: string, field: string): void {
    if (value.length === 0) throw new Error(`${field} must be a non-empty string`);
}

function recordIdentityKey(taskId: string, recordId: string): string {
    return JSON.stringify([taskId, recordId]);
}

function unitIdentityKey(taskId: string, recordId: string, unitId: string): string {
    return JSON.stringify([taskId, recordId, unitId]);
}

function compareFiniteNumbers(left: number, right: number, field: string): number {
    requireFinite(left, `${field}.left`);
    requireFinite(right, `${field}.right`);
    return left < right ? -1 : left > right ? 1 : 0;
}

function finitePositiveProduct(left: number, right: number): number {
    requireFiniteNonNegative(left, "weighted score value");
    requireFiniteNonNegative(right, "weighted score weight");
    if (left === 0 || right === 0) return 0;
    return left > Number.MAX_VALUE / right ? Number.MAX_VALUE : left * right;
}

function finitePositiveSum(values: readonly number[]): number {
    let total = 0;
    for (const value of values) {
        requireFiniteNonNegative(value, "weighted score term");
        if (total > Number.MAX_VALUE - value) return Number.MAX_VALUE;
        total += value;
    }
    return total;
}

function finiteDifference(left: number, right: number): number {
    requireFinite(left, "difference.left");
    requireFinite(right, "difference.right");
    const difference = left - right;
    if (Number.isFinite(difference)) return difference;
    return left >= 0 && right < 0 ? Number.MAX_VALUE : -Number.MAX_VALUE;
}

function clamp(value: number, maximum: number): number {
    return Math.min(Math.max(value, 0), maximum);
}

function compareStrings(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function copyWindow(window: FairnessWindowSnapshot | undefined): FairnessWindowSnapshot | undefined {
    return window === undefined ? undefined : { ...window };
}

export class RecordSchedulerFairness {
    private readonly config: RecordSchedulerFairnessConfig;
    private readonly records = new Map<string, FairnessRecordRuntime>();
    private readonly grantCallbackContext = new AsyncLocalStorage<boolean>();
    private logicalNowMs = 0;
    private dispatchSeq = 0;
    private grantChain: Promise<void> = Promise.resolve();
    private grantInProgress = false;

    public constructor(config: RecordSchedulerFairnessConfigInput = {}) {
        this.config = mergeConfig(config);
    }

    public static restore(
        snapshot: Readonly<RecordSchedulerFairnessSnapshot>,
        config: RecordSchedulerFairnessConfigInput = {},
        restartElapsedMs = 0,
    ): RecordSchedulerFairness {
        if (snapshot.version !== RECORD_SCHEDULER_FAIRNESS_STATE_VERSION) throw new Error("Unsupported fairness scheduler snapshot version");
        requireFiniteNonNegative(snapshot.logicalNowMs, "snapshot.logicalNowMs");
        requireFiniteNonNegative(snapshot.dispatchSeq, "snapshot.dispatchSeq");
        requireFiniteNonNegative(restartElapsedMs, "restartElapsedMs");
        const scheduler = new RecordSchedulerFairness(config);
        scheduler.logicalNowMs = snapshot.logicalNowMs;
        scheduler.dispatchSeq = snapshot.dispatchSeq;
        for (const record of snapshot.records) scheduler.loadRecord(record);
        scheduler.reconcileEligibility();
        if (restartElapsedMs > 0) scheduler.advance(Math.min(restartElapsedMs, scheduler.config.maxRestartElapsedMs));
        return scheduler;
    }

    public get nowMs(): number {
        return this.logicalNowMs;
    }

    public get currentDispatchSeq(): number {
        return this.dispatchSeq;
    }

    public advance(elapsedMs: number): void {
        this.ensureNotGranting();
        requireFiniteNonNegative(elapsedMs, "elapsedMs");
        this.reconcileEligibility();
        const previousNowMs = this.logicalNowMs;
        const nextNowMs = previousNowMs + elapsedMs;
        requireFinite(nextNowMs, "logical clock");
        const waitingRecords: Array<{ record: FairnessRecordRuntime; waitedMs: number }> = [];
        for (const record of this.records.values()) {
            const eligibleAtMs = this.firstEligibleAt(record, previousNowMs, nextNowMs);
            if (eligibleAtMs === undefined) continue;
            const waitedMs = nextNowMs - eligibleAtMs;
            if (waitedMs <= 0) continue;
            record.cumulativeWaitingMs += waitedMs;
            requireFiniteNonNegative(record.cumulativeWaitingMs, "cumulative waiting time");
            waitingRecords.push({ record, waitedMs });
        }
        this.addWaitingCredits(waitingRecords);
        this.logicalNowMs = nextNowMs;
        this.reconcileEligibility();
    }

    public addRecord(input: FairnessRecordInput): void {
        this.ensureNotGranting();
        requireNonEmptyString(input.taskId, "taskId");
        requireNonEmptyString(input.recordId, "recordId");
        const key = recordIdentityKey(input.taskId, input.recordId);
        if (this.records.has(key)) throw new Error(`Record already exists: ${input.taskId}/${input.recordId}`);
        requireFiniteNonNegative(input.taskCreatedAt, "taskCreatedAt");
        const serviceDebt = input.serviceDebt ?? 0;
        requireFiniteNonNegative(serviceDebt, "serviceDebt");
        const record: FairnessRecordRuntime = {
            taskId: input.taskId,
            recordId: input.recordId,
            taskCreatedAt: input.taskCreatedAt,
            serviceDebt,
            waitingCredit: 0,
            cumulativeWaitingMs: 0,
            baselinePending: true,
            units: new Map(),
        };
        this.records.set(key, record);
        for (const unit of input.units ?? []) this.addUnitToRecord(record, unit);
    }

    public addUnit(taskId: string, recordId: string, input: FairnessUnitInput): void {
        this.ensureNotGranting();
        this.addUnitToRecord(this.requireRecord(taskId, recordId), input);
    }

    public updateUnit(
        taskId: string,
        recordId: string,
        unitId: string,
        update: Partial<Pick<FairnessUnitInput, "layer" | "estimatedCost" | "dependencies" | "nextEligibleAt" | "enqueueAt" | "layerEnteredAt" | "layerFailures" | "totalFailures" | "status">>,
    ): void {
        this.ensureNotGranting();
        const unit = this.requireUnit(taskId, recordId, unitId);
        if (update.layer !== undefined) unit.layer = update.layer;
        if (update.estimatedCost !== undefined) {
            requireFiniteNonNegative(update.estimatedCost, "estimatedCost");
            unit.estimatedCost = update.estimatedCost;
        }
        if (update.dependencies !== undefined) unit.dependencies = [...update.dependencies];
        if (update.nextEligibleAt !== undefined) {
            requireFiniteNonNegative(update.nextEligibleAt, "nextEligibleAt");
            unit.nextEligibleAt = update.nextEligibleAt;
        }
        if (update.enqueueAt !== undefined) {
            requireFiniteNonNegative(update.enqueueAt, "enqueueAt");
            unit.enqueueAt = update.enqueueAt;
        }
        if (update.layerEnteredAt !== undefined) {
            requireFiniteNonNegative(update.layerEnteredAt, "layerEnteredAt");
            unit.layerEnteredAt = update.layerEnteredAt;
        }
        if (update.layerFailures !== undefined) {
            requireFiniteNonNegative(update.layerFailures, "layerFailures");
            unit.layerFailures = update.layerFailures;
        }
        if (update.totalFailures !== undefined) {
            requireFiniteNonNegative(update.totalFailures, "totalFailures");
            unit.totalFailures = update.totalFailures;
        }
        if (update.status !== undefined) unit.status = update.status;
    }

    public settleUnit(taskId: string, recordId: string, unitId: string, input: SettleUnitInput): void {
        this.ensureNotGranting();
        requireFiniteNonNegative(input.actualCost, "actualCost");
        const record = this.requireRecord(taskId, recordId);
        const unit = this.requireUnit(taskId, recordId, unitId);
        if (unit.status !== "running" || unit.chargedCost === undefined) throw new Error(`Unit is not an unsettled running attempt: ${unitId}`);
        record.serviceDebt = Math.max(0, record.serviceDebt + input.actualCost - unit.chargedCost);
        unit.chargedCost = undefined;
        unit.status = input.status;
        if (input.status === "queued") {
            if (input.nextEligibleAt !== undefined) {
                requireFiniteNonNegative(input.nextEligibleAt, "nextEligibleAt");
                unit.nextEligibleAt = input.nextEligibleAt;
            } else {
                unit.nextEligibleAt = undefined;
            }
        }
        this.reconcileEligibility();
    }

    public splitUnit(taskId: string, recordId: string, parentUnitId: string, children: readonly SplitUnitInput[]): void {
        this.ensureNotGranting();
        if (children.length === 0) throw new Error("A split requires at least one child unit");
        const record = this.requireRecord(taskId, recordId);
        const parent = this.requireUnit(taskId, recordId, parentUnitId);
        if (parent.status !== "failed" || parent.chargedCost !== undefined) throw new Error("Split requires a settled failed parent unit");
        for (const child of children) {
            if (record.units.has(child.unitId)) throw new Error(`Unit already exists: ${child.unitId}`);
        }
        const inheritedCost = parent.estimatedCost / children.length;
        for (const child of children) {
            this.addUnitToRecord(record, {
                ...child,
                estimatedCost: child.estimatedCost ?? inheritedCost,
            }, parent.unitId);
        }
        this.reconcileEligibility();
    }

    public getRecordState(taskId: string, recordId: string): FairnessRecordSnapshot {
        this.ensureNotGranting();
        this.reconcileEligibility();
        return this.snapshotRecord(this.requireRecord(taskId, recordId));
    }

    public snapshot(): RecordSchedulerFairnessSnapshot {
        this.ensureNotGranting();
        this.reconcileEligibility();
        return {
            version: RECORD_SCHEDULER_FAIRNESS_STATE_VERSION,
            logicalNowMs: this.logicalNowMs,
            dispatchSeq: this.dispatchSeq,
            records: [...this.records.values()]
                .sort((left, right) => this.compareRecordIdentity(left, right))
                .map((record) => this.snapshotRecord(record)),
        };
    }

    public grantNext(requestPermit: (candidate: Readonly<FairnessCandidate>) => FairnessPermitDecision | Promise<FairnessPermitDecision>): Promise<FairnessGrantResult> {
        if (this.grantCallbackContext.getStore() === true) throw new FairnessGrantReentrancyError();
        const run = async (): Promise<FairnessGrantResult> => this.grantNextSerial(requestPermit);
        const result = this.grantChain.then(run, run);
        this.grantChain = result.then(() => undefined, () => undefined);
        return result;
    }

    private async grantNextSerial(requestPermit: (candidate: Readonly<FairnessCandidate>) => FairnessPermitDecision | Promise<FairnessPermitDecision>): Promise<FairnessGrantResult> {
        this.reconcileEligibility();
        const denied = new Set<string>();
        let lastDenied: FairnessCandidate | undefined;
        this.grantInProgress = true;
        try {
            while (true) {
                const candidate = this.selectCandidate(denied);
                if (candidate === undefined) {
                    return lastDenied === undefined
                        ? { granted: false, reason: "no-eligible" }
                        : { granted: false, reason: "provider-denied", candidate: lastDenied };
                }
                const decision = await this.grantCallbackContext.run(true, () => requestPermit(candidate));
                if (decision !== true) {
                    if (decision === false) return { granted: false, reason: "provider-denied", candidate };
                    denied.add(unitIdentityKey(candidate.taskId, candidate.recordId, candidate.unitId));
                    lastDenied = candidate;
                    continue;
                }
                const record = this.requireRecord(candidate.taskId, candidate.recordId);
                const unit = this.requireUnit(candidate.taskId, candidate.recordId, candidate.unitId);
                if (!this.isEligible(record, unit)) throw new Error("Candidate changed while its permit grant was in progress");
                unit.status = "running";
                unit.chargedCost = unit.estimatedCost;
                record.serviceDebt += unit.estimatedCost;
                this.dispatchSeq += 1;
                record.lastServedSeq = this.dispatchSeq;
                record.window = undefined;
                return { granted: true, dispatchSeq: this.dispatchSeq, candidate };
            }
        } finally {
            this.grantInProgress = false;
        }
    }

    private selectCandidate(excluded: ReadonlySet<string> = new Set()): FairnessCandidate | undefined {
        const candidates = [...this.records.values()]
            .map((record) => ({ record, candidate: this.selectUnit(record, excluded) }))
            .filter((entry): entry is { record: FairnessRecordRuntime; candidate: FairnessCandidate } => entry.candidate !== undefined);
        if (candidates.length === 0) return undefined;
        const due = candidates
            .filter(({ record }) => record.window !== undefined && record.window.deadlineSeq <= this.dispatchSeq + 1)
            .sort((left, right) => this.compareDueRecords(left.record, right.record));
        if (due.length > 0) return due[0].candidate;
        candidates.sort((left, right) => this.compareSoftRecords(left, right));
        return candidates[0].candidate;
    }

    private selectUnit(record: FairnessRecordRuntime, excluded: ReadonlySet<string>): FairnessCandidate | undefined {
        const units = [...record.units.values()]
            .filter((unit) => this.isEligible(record, unit))
            .filter((unit) => !excluded.has(unitIdentityKey(record.taskId, record.recordId, unit.unitId)))
            .map((unit) => this.toCandidate(record, unit));
        units.sort((left, right) => {
            const leftUnit = this.requireUnit(left.taskId, left.recordId, left.unitId);
            const rightUnit = this.requireUnit(right.taskId, right.recordId, right.unitId);
            if (left.factors.unitQueueCredit === Number.MAX_VALUE || right.factors.unitQueueCredit === Number.MAX_VALUE) {
                const queueCreditComparison = this.compareUnitQueueCredit(rightUnit, leftUnit);
                if (queueCreditComparison !== 0) return queueCreditComparison;
            }
            const scoreComparison = compareFiniteNumbers(right.innerScore, left.innerScore, "inner score");
            if (scoreComparison !== 0) return scoreComparison;
            const enqueueComparison = compareFiniteNumbers(leftUnit.enqueueAt, rightUnit.enqueueAt, "enqueue time");
            if (enqueueComparison !== 0) return enqueueComparison;
            return compareStrings(left.unitId, right.unitId);
        });
        return units[0];
    }

    private toCandidate(record: FairnessRecordRuntime, unit: FairnessUnitRuntime): FairnessCandidate {
        const factors = this.innerFactors(record, unit);
        const innerScore = finitePositiveSum([
            finitePositiveProduct(factors.layerWait, this.config.inner.layerWaitWeight),
            finitePositiveProduct(factors.taskAge, this.config.inner.taskAgeWeight),
            finitePositiveProduct(factors.unitQueueCredit, this.config.inner.unitQueueCreditWeight),
            finitePositiveProduct(factors.sizeBonus, this.config.inner.sizeWeight),
            finitePositiveProduct(factors.layerFailure, this.config.inner.layerFailureWeight),
            finitePositiveProduct(factors.totalFailure, this.config.inner.totalFailureWeight),
            finitePositiveProduct(factors.completionProgress, this.config.inner.completionWeight),
        ]);
        return {
            taskId: record.taskId,
            recordId: record.recordId,
            unitId: unit.unitId,
            estimatedCost: unit.estimatedCost,
            outerScore: this.outerScore(record),
            innerScore,
            factors,
            deadlineSeq: record.window?.deadlineSeq,
        };
    }

    private innerFactors(record: FairnessRecordRuntime, unit: FairnessUnitRuntime): FairnessUnitFactors {
        const unitCount = Math.max(record.units.size, 1);
        const completed = [...record.units.values()].filter((entry) => entry.status === "done").length;
        return {
            layerWait: clamp((this.logicalNowMs - unit.layerEnteredAt) / this.config.inner.layerWaitHorizonMs, 1),
            taskAge: clamp((this.logicalNowMs - record.taskCreatedAt) / this.config.inner.taskAgeHorizonMs, 1),
            unitQueueCredit: this.unitQueueCredit(unit),
            sizeBonus: 1 - clamp(unit.estimatedCost / this.config.inner.sizeCostCap, 1),
            layerFailure: clamp(unit.layerFailures / this.config.inner.layerFailureCap, 1),
            totalFailure: clamp(unit.totalFailures / this.config.inner.totalFailureCap, 1),
            completionProgress: clamp(completed / unitCount, 1),
        };
    }

    private compareDueRecords(left: FairnessRecordRuntime, right: FairnessRecordRuntime): number {
        const leftWindow = left.window;
        const rightWindow = right.window;
        if (leftWindow === undefined || rightWindow === undefined) throw new Error("Due records require active fairness windows");
        const deadlineComparison = compareFiniteNumbers(leftWindow.deadlineSeq, rightWindow.deadlineSeq, "deadline sequence");
        if (deadlineComparison !== 0) return deadlineComparison;
        const startComparison = compareFiniteNumbers(leftWindow.startSeq, rightWindow.startSeq, "window start sequence");
        if (startComparison !== 0) return startComparison;
        const taskComparison = compareFiniteNumbers(left.taskCreatedAt, right.taskCreatedAt, "task creation time");
        if (taskComparison !== 0) return taskComparison;
        return this.compareRecordIdentity(left, right);
    }

    private compareSoftRecords(
        left: { record: FairnessRecordRuntime; candidate: FairnessCandidate },
        right: { record: FairnessRecordRuntime; candidate: FairnessCandidate },
    ): number {
        const scoreComparison = compareFiniteNumbers(right.candidate.outerScore, left.candidate.outerScore, "outer score");
        if (scoreComparison !== 0) return scoreComparison;
        const taskComparison = compareFiniteNumbers(left.record.taskCreatedAt, right.record.taskCreatedAt, "task creation time");
        if (taskComparison !== 0) return taskComparison;
        const recordComparison = this.compareRecordIdentity(left.record, right.record);
        if (recordComparison !== 0) return recordComparison;
        return compareStrings(left.candidate.unitId, right.candidate.unitId);
    }

    private reconcileEligibility(): void {
        const eligibleRecords = [...this.records.values()].filter((record) => this.hasEligibleUnit(record));
        const eligibleIds = new Set(eligibleRecords.map((record) => recordIdentityKey(record.taskId, record.recordId)));
        for (const record of this.records.values()) {
            if (!eligibleIds.has(recordIdentityKey(record.taskId, record.recordId))) record.window = undefined;
        }
        const entering = eligibleRecords.filter((record) => record.window === undefined);
        const incumbents = eligibleRecords.filter((record) => record.window !== undefined);
        const baseline = incumbents.length === 0 ? 0 : Math.min(...incumbents.map((record) => this.outerScore(record)));
        for (const record of entering) {
            if (!record.baselinePending) continue;
            const scoreDifference = finiteDifference(this.outerScore(record), baseline);
            if (scoreDifference > 0) record.serviceDebt += scoreDifference / this.config.serviceDebtWeight;
            requireFiniteNonNegative(record.serviceDebt, "service debt");
            record.baselinePending = false;
        }
        const populationN = eligibleRecords.length;
        for (const record of entering) {
            record.window = {
                startSeq: this.dispatchSeq,
                deadlineSeq: this.dispatchSeq + 2 * populationN,
                populationN,
            };
        }
    }

    private hasEligibleUnit(record: FairnessRecordRuntime): boolean {
        return [...record.units.values()].some((unit) => this.isEligible(record, unit));
    }

    private isEligible(record: FairnessRecordRuntime, unit: FairnessUnitRuntime): boolean {
        if (unit.status !== "queued") return false;
        if (unit.nextEligibleAt !== undefined && this.logicalNowMs < unit.nextEligibleAt) return false;
        return unit.dependencies.every((dependencyId) => this.isDependencyDone(record, dependencyId));
    }

    private isDependencyDone(record: FairnessRecordRuntime, dependencyId: string): boolean {
        return record.units.get(dependencyId)?.status === "done";
    }

    private outerScore(record: FairnessRecordRuntime): number {
        return finiteDifference(record.waitingCredit, finitePositiveProduct(record.serviceDebt, this.config.serviceDebtWeight));
    }

    private compareRecordIdentity(left: FairnessRecordRuntime, right: FairnessRecordRuntime): number {
        const taskComparison = compareStrings(left.taskId, right.taskId);
        return taskComparison !== 0 ? taskComparison : compareStrings(left.recordId, right.recordId);
    }

    private firstEligibleAt(record: FairnessRecordRuntime, startMs: number, endMs: number): number | undefined {
        let earliest: number | undefined;
        for (const unit of record.units.values()) {
            if (unit.status !== "queued" || !unit.dependencies.every((dependencyId) => this.isDependencyDone(record, dependencyId))) continue;
            const eligibleAt = Math.max(startMs, unit.nextEligibleAt ?? startMs);
            if (eligibleAt > endMs || (earliest !== undefined && eligibleAt >= earliest)) continue;
            earliest = eligibleAt;
        }
        return earliest;
    }

    private addWaitingCredits(records: readonly { record: FairnessRecordRuntime; waitedMs: number }[]): void {
        const remaining = records.map(({ record, waitedMs }) => ({ record, remainingMs: waitedMs }));
        const maxStepMs = (Number.MAX_VALUE / 4) / this.config.waitingCreditPerMs;
        while (remaining.some(({ remainingMs }) => remainingMs > 0)) {
            const credits = remaining.map((entry) => {
                if (entry.remainingMs <= 0) return 0;
                const stepMs = Math.min(entry.remainingMs, maxStepMs);
                if (stepMs <= 0) throw new Error("Waiting-credit step must make progress");
                entry.remainingMs -= stepMs;
                const credit = stepMs * this.config.waitingCreditPerMs;
                requireFiniteNonNegative(credit, "waiting-credit increment");
                return credit;
            });
            this.rebaseWaitingCredits(Math.max(...credits));
            for (let index = 0; index < remaining.length; index += 1) {
                if (credits[index] === 0) continue;
                remaining[index].record.waitingCredit += credits[index];
                requireFinite(remaining[index].record.waitingCredit, "waiting credit");
            }
        }
    }

    private rebaseWaitingCredits(increment: number): void {
        const maximumMagnitude = Math.max(...[...this.records.values()].map((record) => Math.abs(record.waitingCredit)), 0);
        if (maximumMagnitude <= Number.MAX_VALUE - increment) return;
        const credits = [...this.records.values()].map((record) => record.waitingCredit);
        const minimum = Math.min(...credits);
        const maximum = Math.max(...credits);
        const center = minimum / 2 + maximum / 2;
        if (center === 0) throw new Error("Waiting-credit range exceeds finite numeric representation");
        for (const record of this.records.values()) {
            record.waitingCredit -= center;
            requireFinite(record.waitingCredit, "rebased waiting credit");
        }
    }

    private unitQueueCredit(unit: FairnessUnitRuntime): number {
        const queuedForMs = Math.max(0, this.logicalNowMs - unit.enqueueAt);
        const credit = queuedForMs / this.config.inner.unitQueueCreditQuantumMs;
        return Number.isFinite(credit) ? credit : Number.MAX_VALUE;
    }

    private compareUnitQueueCredit(left: FairnessUnitRuntime, right: FairnessUnitRuntime): number {
        const leftQueuedForMs = Math.max(0, this.logicalNowMs - left.enqueueAt);
        const rightQueuedForMs = Math.max(0, this.logicalNowMs - right.enqueueAt);
        const leftCredit = leftQueuedForMs / this.config.inner.unitQueueCreditQuantumMs;
        const rightCredit = rightQueuedForMs / this.config.inner.unitQueueCreditQuantumMs;
        if (Number.isFinite(leftCredit) && Number.isFinite(rightCredit)) {
            return compareFiniteNumbers(leftCredit, rightCredit, "unit queue credit");
        }
        if (Number.isFinite(leftCredit)) return -1;
        if (Number.isFinite(rightCredit)) return 1;
        const leftMagnitude = Math.log(leftQueuedForMs) - Math.log(this.config.inner.unitQueueCreditQuantumMs);
        const rightMagnitude = Math.log(rightQueuedForMs) - Math.log(this.config.inner.unitQueueCreditQuantumMs);
        return compareFiniteNumbers(leftMagnitude, rightMagnitude, "layered unit queue credit");
    }

    private addUnitToRecord(record: FairnessRecordRuntime, input: FairnessUnitInput, parentUnitId?: string): void {
        if (record.units.has(input.unitId)) throw new Error(`Unit already exists: ${input.unitId}`);
        requireFiniteNonNegative(input.estimatedCost, "estimatedCost");
        const enqueueAt = input.enqueueAt ?? this.logicalNowMs;
        const layerEnteredAt = input.layerEnteredAt ?? enqueueAt;
        requireFiniteNonNegative(enqueueAt, "enqueueAt");
        requireFiniteNonNegative(layerEnteredAt, "layerEnteredAt");
        if (input.nextEligibleAt !== undefined) requireFiniteNonNegative(input.nextEligibleAt, "nextEligibleAt");
        requireFiniteNonNegative(input.layerFailures ?? 0, "layerFailures");
        requireFiniteNonNegative(input.totalFailures ?? 0, "totalFailures");
        record.units.set(input.unitId, {
            unitId: input.unitId,
            layer: input.layer,
            estimatedCost: input.estimatedCost,
            dependencies: [...(input.dependencies ?? [])],
            nextEligibleAt: input.nextEligibleAt,
            enqueueAt,
            layerEnteredAt,
            layerFailures: input.layerFailures ?? 0,
            totalFailures: input.totalFailures ?? 0,
            status: input.status ?? "queued",
            parentUnitId,
        });
    }

    private loadRecord(snapshot: Readonly<FairnessRecordSnapshot>): void {
        requireNonEmptyString(snapshot.taskId, "snapshot.taskId");
        requireNonEmptyString(snapshot.recordId, "snapshot.recordId");
        const key = recordIdentityKey(snapshot.taskId, snapshot.recordId);
        if (this.records.has(key)) throw new Error(`Duplicate record in snapshot: ${snapshot.taskId}/${snapshot.recordId}`);
        requireFiniteNonNegative(snapshot.taskCreatedAt, "snapshot.taskCreatedAt");
        requireFiniteNonNegative(snapshot.serviceDebt, "snapshot.serviceDebt");
        requireFinite(snapshot.waitingCredit, "snapshot.waitingCredit");
        requireFiniteNonNegative(snapshot.cumulativeWaitingMs, "snapshot.cumulativeWaitingMs");
        const record: FairnessRecordRuntime = {
            taskId: snapshot.taskId,
            recordId: snapshot.recordId,
            taskCreatedAt: snapshot.taskCreatedAt,
            serviceDebt: snapshot.serviceDebt,
            waitingCredit: snapshot.waitingCredit,
            cumulativeWaitingMs: snapshot.cumulativeWaitingMs,
            lastServedSeq: snapshot.lastServedSeq,
            baselinePending: snapshot.baselinePending,
            window: copyWindow(snapshot.window),
            units: new Map(),
        };
        this.records.set(key, record);
        for (const unit of snapshot.units) {
            this.addUnitToRecord(record, unit, unit.parentUnitId);
            const loaded = this.requireUnit(record.taskId, record.recordId, unit.unitId);
            loaded.status = unit.status;
            loaded.chargedCost = unit.chargedCost;
        }
    }

    private snapshotRecord(record: FairnessRecordRuntime): FairnessRecordSnapshot {
        return {
            taskId: record.taskId,
            recordId: record.recordId,
            taskCreatedAt: record.taskCreatedAt,
            serviceDebt: record.serviceDebt,
            waitingCredit: record.waitingCredit,
            cumulativeWaitingMs: record.cumulativeWaitingMs,
            lastServedSeq: record.lastServedSeq,
            baselinePending: record.baselinePending,
            window: copyWindow(record.window),
            units: [...record.units.values()]
                .sort((left, right) => compareStrings(left.unitId, right.unitId))
                .map((unit) => ({
                    unitId: unit.unitId,
                    layer: unit.layer,
                    estimatedCost: unit.estimatedCost,
                    dependencies: [...unit.dependencies],
                    nextEligibleAt: unit.nextEligibleAt,
                    enqueueAt: unit.enqueueAt,
                    layerEnteredAt: unit.layerEnteredAt,
                    layerFailures: unit.layerFailures,
                    totalFailures: unit.totalFailures,
                    status: unit.status,
                    chargedCost: unit.chargedCost,
                    parentUnitId: unit.parentUnitId,
                })),
        };
    }

    private requireRecord(taskId: string, recordId: string): FairnessRecordRuntime {
        const record = this.records.get(recordIdentityKey(taskId, recordId));
        if (record === undefined) throw new Error(`Unknown record: ${taskId}/${recordId}`);
        return record;
    }

    private requireUnit(taskId: string, recordId: string, unitId: string): FairnessUnitRuntime {
        const unit = this.requireRecord(taskId, recordId).units.get(unitId);
        if (unit === undefined) throw new Error(`Unknown unit: ${taskId}/${recordId}/${unitId}`);
        return unit;
    }

    private ensureNotGranting(): void {
        if (this.grantInProgress) throw new Error("Fairness scheduler state cannot change while a permit grant is in progress");
    }
}
