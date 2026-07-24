import { canDispatchTask, type ImmutableBlobReference, type RecordSchedulerLedger, type RecordSourceSnapshot, type SchedulerTaskLedger, type SchedulerUnitLedger } from "./record-scheduler-contracts.js";

export type RecordSchedulerQueueWakeReason = "timer" | "provider" | "dependency" | "resource" | "cancel" | "rebuild";
export type RecordSchedulerQueueWaitingReason = "waiting_resource" | "waiting_backoff" | "blocked_dependency" | "waiting_source";
export type RecordSchedulerQueueMode = "materializing" | "eligibility-only";

export class QueueMaterializeReentrancyError extends Error {
    public readonly code = "QUEUE_MATERIALIZE_REENTRANCY";

    public constructor(public readonly operation: string) {
        super(`Record scheduler queue operation ${operation} cannot re-enter from materializePrompt`);
        this.name = "QueueMaterializeReentrancyError";
    }
}

export interface RecordSchedulerQueueClock {
    now(): number;
}

export interface RecordSchedulerQueueTimer {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
}

export interface RecordSchedulerQueueResources {
    memorySoftLimit: boolean;
    diskSoftLimit: boolean;
}

export interface RecordSchedulerPromptRecipe {
    sourceSnapshotId: string;
    sourceSpool: ImmutableBlobReference;
    recipe: {
        unitId: string;
        layer: string;
        continuationKey?: string;
        composeOrder: number;
        inputHash: string;
    };
}

export interface MaterializedRecordSchedulerPrompt {
    taskId: string;
    recordId: string;
    unitId: string;
    recipe: RecordSchedulerPromptRecipe;
    prompt: unknown;
    materializedAt: number;
}

export interface RecordSchedulerQueueUnitView {
    taskId: string;
    recordId: string;
    unitId: string;
    state: SchedulerUnitLedger["state"];
    dependencies: readonly string[];
    continuationKey?: string;
    composeOrder: number;
    nextEligibleAt?: number;
    promptRecipe?: RecordSchedulerPromptRecipe;
}

export interface RecordSchedulerQueueRecordBucket {
    taskId: string;
    recordId: string;
    unitIds: readonly string[];
}

export interface RecordSchedulerQueueSnapshot {
    logicalUnitCount: number;
    eligibleUnitCount: number;
    materializedPromptCount: number;
    dispatchCandidateUnitIds: readonly string[];
    recordBuckets: readonly RecordSchedulerQueueRecordBucket[];
    waitingReasons: readonly RecordSchedulerQueueWaitingReason[];
    nextWakeAt?: number;
}

export interface RecordSchedulerQueueOptions {
    clock?: RecordSchedulerQueueClock;
    timer?: RecordSchedulerQueueTimer;
    mode?: RecordSchedulerQueueMode;
    maxMaterializedPrompts?: number;
    materializePrompt?: (recipe: RecordSchedulerPromptRecipe) => unknown;
    onWake?: (reason: RecordSchedulerQueueWakeReason) => void;
}

interface IndexedTask {
    task: SchedulerTaskLedger;
    createdAt: string;
}

interface IndexedUnit {
    taskId: string;
    recordId: string;
    unit: SchedulerUnitLedger;
    task: IndexedTask;
    source?: RecordSourceSnapshot;
    promptRecipe?: RecordSchedulerPromptRecipe;
}

interface IndexedRecordBucket {
    taskId: string;
    recordId: string;
    unitKeys: string[];
}

const defaultClock: RecordSchedulerQueueClock = {
    now: () => Date.now(),
};

const defaultTimer: RecordSchedulerQueueTimer = {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function compareText(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function compareNumber(left: number, right: number): number {
    return left - right;
}

function unitKey(taskId: string, unitId: string): string {
    return `${taskId}\u0000${unitId}`;
}

function bucketKey(taskId: string, recordId: string): string {
    return `${taskId}\u0000${recordId}`;
}

function timestampMs(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function isCandidateState(state: SchedulerUnitLedger["state"]): boolean {
    return state === "Materialized" || state === "Blocked" || state === "Queued" || state === "WaitingRetry";
}

function isDependencyReady(unit: SchedulerUnitLedger): boolean {
    return unit.state === "Succeeded"
        || unit.state === "ResultReady" && unit.resultRef !== undefined;
}

export class RecordSchedulerQueue {
    private readonly clock: RecordSchedulerQueueClock;
    private readonly timer: RecordSchedulerQueueTimer;
    private readonly mode: RecordSchedulerQueueMode;
    private readonly maxMaterializedPrompts: number;
    private readonly materializePrompt: (recipe: RecordSchedulerPromptRecipe) => unknown;
    private readonly onWake?: (reason: RecordSchedulerQueueWakeReason) => void;
    private readonly tasks = new Map<string, IndexedTask>();
    private readonly units = new Map<string, IndexedUnit>();
    private readonly buckets = new Map<string, IndexedRecordBucket>();
    private readonly materializedPrompts = new Map<string, MaterializedRecordSchedulerPrompt>();
    private readonly claimedPrompts = new Set<string>();
    private readonly cancelledTaskIds = new Set<string>();
    private readonly completedUnitKeys = new Set<string>();
    private resources: RecordSchedulerQueueResources = { memorySoftLimit: false, diskSoftLimit: false };
    private timerHandle: unknown;
    private scheduledWakeAt?: number;
    private materializeInProgress = false;

    constructor(options: RecordSchedulerQueueOptions = {}) {
        this.clock = options.clock ?? defaultClock;
        this.timer = options.timer ?? defaultTimer;
        this.mode = options.mode ?? "materializing";
        this.maxMaterializedPrompts = options.maxMaterializedPrompts ?? 32;
        if (!Number.isInteger(this.maxMaterializedPrompts) || this.maxMaterializedPrompts < 1) {
            throw new Error("maxMaterializedPrompts 必须是正整数");
        }
        this.materializePrompt = options.materializePrompt ?? (() => undefined);
        this.onWake = options.onWake;
    }

    rebuild(ledgers: Iterable<RecordSchedulerLedger>): void {
        this.ensureNotMaterializing("rebuild");
        const sortedLedgers = [...ledgers].sort((left, right) => compareText(left.task.taskId, right.task.taskId));
        this.tasks.clear();
        this.units.clear();
        this.buckets.clear();
        this.materializedPrompts.clear();
        this.claimedPrompts.clear();
        this.cancelledTaskIds.clear();
        this.completedUnitKeys.clear();
        for (const ledger of sortedLedgers) this.indexLedger(ledger);
        this.refresh();
        this.onWake?.("rebuild");
    }

    setResources(resources: Partial<RecordSchedulerQueueResources>): void {
        this.ensureNotMaterializing("setResources");
        this.resources = { ...this.resources, ...resources };
        this.emitWake("resource");
    }

    notifyProviderChanged(): void {
        this.ensureNotMaterializing("notifyProviderChanged");
        this.emitWake("provider");
    }

    notifyDependenciesChanged(): void {
        this.ensureNotMaterializing("notifyDependenciesChanged");
        this.emitWake("dependency");
    }

    notifyDependencySucceeded(taskId: string, unitId: string): void {
        this.ensureNotMaterializing("notifyDependencySucceeded");
        const key = unitKey(taskId, unitId);
        this.completedUnitKeys.add(key);
        this.claimedPrompts.delete(key);
        this.materializedPrompts.delete(key);
        this.emitWake("dependency");
    }

    notifyCancelled(taskId: string): void {
        this.ensureNotMaterializing("notifyCancelled");
        this.cancelledTaskIds.add(taskId);
        for (const [key, prompt] of this.materializedPrompts) {
            if (prompt.taskId === taskId && !this.claimedPrompts.has(key)) this.materializedPrompts.delete(key);
        }
        this.emitWake("cancel");
    }

    getEligibleUnits(): RecordSchedulerQueueUnitView[] {
        this.ensureNotMaterializing("getEligibleUnits");
        this.refresh();
        return this.eligibleUnits(this.clock.now()).map(unit => this.toUnitView(unit));
    }

    getDispatchCandidates(): MaterializedRecordSchedulerPrompt[] {
        this.ensureNotMaterializing("getDispatchCandidates");
        this.refresh();
        return this.pendingMaterializedPrompts();
    }

    claimNext(): MaterializedRecordSchedulerPrompt | undefined {
        this.ensureNotMaterializing("claimNext");
        this.refresh();
        const prompt = this.pendingMaterializedPrompts()[0];
        if (prompt === undefined) return undefined;
        this.claimedPrompts.add(unitKey(prompt.taskId, prompt.unitId));
        return prompt;
    }

    releasePrompt(taskId: string, unitId: string): void {
        this.ensureNotMaterializing("releasePrompt");
        const key = unitKey(taskId, unitId);
        this.claimedPrompts.delete(key);
        this.materializedPrompts.delete(key);
        this.refresh();
    }

    snapshot(): RecordSchedulerQueueSnapshot {
        this.ensureNotMaterializing("snapshot");
        this.refresh();
        const now = this.clock.now();
        return {
            logicalUnitCount: this.units.size,
            eligibleUnitCount: this.eligibleUnits(now).length,
            materializedPromptCount: this.materializedPrompts.size,
            dispatchCandidateUnitIds: this.pendingMaterializedPrompts().map(prompt => prompt.unitId),
            recordBuckets: this.recordBuckets(),
            waitingReasons: this.waitingReasons(now),
            nextWakeAt: this.scheduledWakeAt,
        };
    }

    dispose(): void {
        this.ensureNotMaterializing("dispose");
        if (this.timerHandle !== undefined) this.timer.clearTimeout(this.timerHandle);
        this.timerHandle = undefined;
        this.scheduledWakeAt = undefined;
    }

    private indexLedger(ledger: RecordSchedulerLedger): void {
        const taskId = ledger.task.taskId;
        if (this.tasks.has(taskId)) throw new Error(`重复的 scheduler Task：${taskId}`);
        const task: IndexedTask = { task: ledger.task, createdAt: ledger.task.createdAt };
        this.tasks.set(taskId, task);
        const sourceById = new Map(ledger.sourceSnapshots.map(source => [source.sourceSnapshotId, source]));
        const sortedUnits = [...ledger.units].sort((left, right) => this.compareLedgerUnits(left, right));
        for (const unit of sortedUnits) {
            const key = unitKey(taskId, unit.unitId);
            if (this.units.has(key)) throw new Error(`重复的 scheduler Unit：${taskId}/${unit.unitId}`);
            const source = sourceById.get(unit.sourceSnapshotId);
            const indexed: IndexedUnit = {
                taskId,
                recordId: unit.recordId,
                unit,
                task,
                source,
                promptRecipe: source === undefined ? undefined : this.createPromptRecipe(unit, source),
            };
            this.units.set(key, indexed);
            const recordKey = bucketKey(taskId, unit.recordId);
            const bucket = this.buckets.get(recordKey) ?? { taskId, recordId: unit.recordId, unitKeys: [] };
            bucket.unitKeys.push(key);
            this.buckets.set(recordKey, bucket);
        }
        for (const bucket of this.buckets.values()) bucket.unitKeys.sort((left, right) => this.compareUnits(this.units.get(left)!, this.units.get(right)!));
    }

    private createPromptRecipe(unit: SchedulerUnitLedger, source: RecordSourceSnapshot): RecordSchedulerPromptRecipe {
        return {
            sourceSnapshotId: source.sourceSnapshotId,
            sourceSpool: { ...source.contentRef },
            recipe: {
                unitId: unit.unitId,
                layer: unit.layer,
                continuationKey: unit.continuationKey,
                composeOrder: unit.composeOrder,
                inputHash: unit.inputHash,
            },
        };
    }

    private compareLedgerUnits(left: SchedulerUnitLedger, right: SchedulerUnitLedger): number {
        return compareText(left.recordId, right.recordId)
            || compareNumber(left.composeOrder, right.composeOrder)
            || compareText(left.unitId, right.unitId);
    }

    private compareUnits(left: IndexedUnit, right: IndexedUnit): number {
        return compareText(left.task.createdAt, right.task.createdAt)
            || compareText(left.recordId, right.recordId)
            || compareNumber(left.unit.composeOrder, right.unit.composeOrder)
            || compareText(left.unit.unitId, right.unit.unitId);
    }

    private toUnitView(indexed: IndexedUnit): RecordSchedulerQueueUnitView {
        return {
            taskId: indexed.taskId,
            recordId: indexed.recordId,
            unitId: indexed.unit.unitId,
            state: indexed.unit.state,
            dependencies: [...indexed.unit.dependencies],
            continuationKey: indexed.unit.continuationKey,
            composeOrder: indexed.unit.composeOrder,
            nextEligibleAt: timestampMs(indexed.unit.nextEligibleAt),
            promptRecipe: indexed.promptRecipe,
        };
    }

    private refresh(): void {
        const now = this.clock.now();
        this.pruneMaterializedPrompts(now);
        if (this.mode === "materializing" && !this.resourcesLimited()) this.materializeEligiblePrompts(now);
        this.armEarliestWake(now);
    }

    private pruneMaterializedPrompts(now: number): void {
        for (const [key, prompt] of this.materializedPrompts) {
            const indexed = this.units.get(key);
            if (indexed === undefined) {
                if (!this.claimedPrompts.has(key)) this.materializedPrompts.delete(key);
                continue;
            }
            if (this.isTaskCancelled(indexed) || (!this.claimedPrompts.has(key) && !this.isEligible(indexed, now))) {
                this.materializedPrompts.delete(key);
                this.claimedPrompts.delete(key);
                continue;
            }
            if (this.resourcesLimited() && !this.claimedPrompts.has(key)) this.materializedPrompts.delete(key);
            if (prompt.taskId !== indexed.taskId || prompt.unitId !== indexed.unit.unitId) this.materializedPrompts.delete(key);
        }
    }

    private materializeEligiblePrompts(now: number): void {
        const vacantSlots = this.maxMaterializedPrompts - this.materializedPrompts.size;
        if (vacantSlots <= 0) return;
        const candidates = this.eligibleUnits(now);
        let materialized = 0;
        for (const indexed of candidates) {
            if (materialized >= vacantSlots) break;
            const key = unitKey(indexed.taskId, indexed.unit.unitId);
            if (this.materializedPrompts.has(key) || indexed.promptRecipe === undefined) continue;
            this.materializeInProgress = true;
            let prompt: unknown;
            try {
                prompt = this.materializePrompt(indexed.promptRecipe);
            } finally {
                this.materializeInProgress = false;
            }
            this.materializedPrompts.set(key, {
                taskId: indexed.taskId,
                recordId: indexed.recordId,
                unitId: indexed.unit.unitId,
                recipe: indexed.promptRecipe,
                prompt,
                materializedAt: now,
            });
            materialized += 1;
        }
    }

    private eligibleUnits(now: number): IndexedUnit[] {
        return [...this.units.values()]
            .filter(indexed => this.isEligible(indexed, now))
            .sort((left, right) => this.compareUnits(left, right));
    }

    private isEligible(indexed: IndexedUnit, now: number): boolean {
        if (this.completedUnitKeys.has(unitKey(indexed.taskId, indexed.unit.unitId)) || !this.isTaskDispatchable(indexed) || indexed.promptRecipe === undefined || !isCandidateState(indexed.unit.state)) return false;
        if (!this.dependenciesSatisfied(indexed)) return false;
        const nextEligibleAt = timestampMs(indexed.unit.nextEligibleAt);
        return nextEligibleAt === undefined || nextEligibleAt <= now;
    }

    private ensureNotMaterializing(operation: string): void {
        if (this.materializeInProgress) throw new QueueMaterializeReentrancyError(operation);
    }

    private isTaskDispatchable(indexed: IndexedUnit): boolean {
        return !this.isTaskCancelled(indexed) && canDispatchTask(indexed.task.task.state, indexed.task.task.repairState);
    }

    private isTaskCancelled(indexed: IndexedUnit): boolean {
        return this.cancelledTaskIds.has(indexed.taskId);
    }

    private dependenciesSatisfied(indexed: IndexedUnit): boolean {
        return indexed.unit.dependencies.every(dependencyId => {
            const dependency = this.units.get(unitKey(indexed.taskId, dependencyId));
            return dependency !== undefined
                && (isDependencyReady(dependency.unit) || this.completedUnitKeys.has(unitKey(indexed.taskId, dependencyId)));
        });
    }

    private resourcesLimited(): boolean {
        return this.resources.memorySoftLimit || this.resources.diskSoftLimit;
    }

    private pendingMaterializedPrompts(): MaterializedRecordSchedulerPrompt[] {
        return [...this.materializedPrompts.entries()]
            .filter(([key]) => !this.claimedPrompts.has(key))
            .map(([, prompt]) => prompt)
            .sort((left, right) => {
                const leftIndexed = this.units.get(unitKey(left.taskId, left.unitId));
                const rightIndexed = this.units.get(unitKey(right.taskId, right.unitId));
                if (leftIndexed === undefined || rightIndexed === undefined) return compareText(left.unitId, right.unitId);
                return this.compareUnits(leftIndexed, rightIndexed);
            });
    }

    private recordBuckets(): RecordSchedulerQueueRecordBucket[] {
        return [...this.buckets.values()]
            .sort((left, right) => {
                const leftFirst = this.units.get(left.unitKeys[0]);
                const rightFirst = this.units.get(right.unitKeys[0]);
                if (leftFirst === undefined || rightFirst === undefined) return compareText(left.recordId, right.recordId);
                return this.compareUnits(leftFirst, rightFirst);
            })
            .map(bucket => ({
                taskId: bucket.taskId,
                recordId: bucket.recordId,
                unitIds: bucket.unitKeys.map(key => this.units.get(key)!.unit.unitId),
            }));
    }

    private waitingReasons(now: number): RecordSchedulerQueueWaitingReason[] {
        const reasons = new Set<RecordSchedulerQueueWaitingReason>();
        const dispatchable = [...this.units.values()].filter(indexed => this.isTaskDispatchable(indexed) && isCandidateState(indexed.unit.state));
        if (this.resourcesLimited() && dispatchable.some(indexed => this.dependenciesSatisfied(indexed) && indexed.promptRecipe !== undefined)) reasons.add("waiting_resource");
        for (const indexed of dispatchable) {
            if (indexed.promptRecipe === undefined) reasons.add("waiting_source");
            else if (!this.dependenciesSatisfied(indexed)) reasons.add("blocked_dependency");
            else {
                const nextEligibleAt = timestampMs(indexed.unit.nextEligibleAt);
                if (nextEligibleAt !== undefined && nextEligibleAt > now) reasons.add("waiting_backoff");
            }
        }
        return [...reasons].sort(compareText);
    }

    private armEarliestWake(now: number): void {
        let earliest: number | undefined;
        for (const indexed of this.units.values()) {
            if (!this.isTaskDispatchable(indexed) || indexed.promptRecipe === undefined || !isCandidateState(indexed.unit.state) || !this.dependenciesSatisfied(indexed)) continue;
            const nextEligibleAt = timestampMs(indexed.unit.nextEligibleAt);
            if (nextEligibleAt !== undefined && nextEligibleAt > now && (earliest === undefined || nextEligibleAt < earliest)) earliest = nextEligibleAt;
        }
        if (earliest === this.scheduledWakeAt && this.timerHandle !== undefined) return;
        if (this.timerHandle !== undefined) this.timer.clearTimeout(this.timerHandle);
        this.timerHandle = undefined;
        this.scheduledWakeAt = earliest;
        if (earliest === undefined) return;
        this.timerHandle = this.timer.setTimeout(() => {
            this.timerHandle = undefined;
            this.scheduledWakeAt = undefined;
            this.refresh();
            this.onWake?.("timer");
        }, Math.max(0, earliest - this.clock.now()));
    }

    private emitWake(reason: RecordSchedulerQueueWakeReason): void {
        this.refresh();
        this.onWake?.(reason);
    }
}

export function createRecordSchedulerQueue(options: RecordSchedulerQueueOptions = {}): RecordSchedulerQueue {
    return new RecordSchedulerQueue(options);
}
