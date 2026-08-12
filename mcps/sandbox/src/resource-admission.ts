export const RESOURCE_ADMISSION_DEFAULTS = Object.freeze({
    minReservationMB: 64,
    admissionLimitMB: 1536,
    hardLimitMB: 2048,
    systemHeadroomMB: 512,
    commitHeadroomMB: 4096,
    yellowPhysicalMemoryMB: 1536,
    yellowMaxReservationMB: 192,
    maxAgedReservationMB: 256,
    maxQueueSize: 256,
    admissionBudgetMinMs: 8000,
    admissionBudgetMaxMs: 10000,
    agingThresholdMs: 1000,
    retrySlotMs: 500,
    maxRetryExponent: 4,
    progressIntervalMs: 2000,
});

export type ResourceAdmissionErrorCode =
    | "admission_timeout"
    | "admission_aborted"
    | "admission_queue_full"
    | "reservation_exceeds_admission_limit"
    | "reservation_exceeds_hard_limit";

export class ResourceAdmissionError extends Error {
    readonly code: ResourceAdmissionErrorCode;
    readonly queueWaitMs: number;
    readonly retryAfterMs: number;

    constructor(
        code: ResourceAdmissionErrorCode,
        message: string,
        queueWaitMs = 0,
        retryAfterMs = 0,
    ) {
        super(message);
        this.name = "ResourceAdmissionError";
        this.code = code;
        this.queueWaitMs = queueWaitMs;
        this.retryAfterMs = retryAfterMs;
    }

    toJSON(): {
        name: string;
        code: ResourceAdmissionErrorCode;
        message: string;
        queueWaitMs: number;
        retryAfterMs: number;
    } {
        return {
            name: this.name,
            code: this.code,
            message: this.message,
            queueWaitMs: this.queueWaitMs,
            retryAfterMs: this.retryAfterMs,
        };
    }
}

export interface ResourceAdmissionOptions {
    minReservationMB?: number;
    admissionLimitMB?: number;
    hardLimitMB?: number;
    systemHeadroomMB?: number;
    commitHeadroomMB?: number;
    yellowPhysicalMemoryMB?: number;
    yellowMaxReservationMB?: number;
    maxAgedReservationMB?: number;
    maxQueueSize?: number;
    admissionBudgetMinMs?: number;
    admissionBudgetMaxMs?: number;
    agingThresholdMs?: number;
    retrySlotMs?: number;
    maxRetryExponent?: number;
    progressIntervalMs?: number;
    now?: () => number;
    random?: () => number;
}

export interface ResourceAdmissionRequest {
    ownerId?: string;
    reservationMB?: number;
    admissionBudgetMs?: number;
    retryAttempt?: number;
    signal?: AbortSignal;
    control?: boolean;
    onWaitProgress?: (progress: ResourceWaitProgress) => void;
}

export type ResourcePressureLevel = "green" | "yellow" | "red";

export interface ResourceWaitProgress {
    queueWaitMs: number;
    queuePosition: number;
    queued: number;
    pressureLevel: ResourcePressureLevel;
    activeReservedMB: number;
    observedMemoryMB: number;
    systemAvailableMemoryMB: number | null;
    commitAvailableMemoryMB: number | null;
}

export interface ResourceLease {
    readonly reservedMB: number;
    readonly control: boolean;
    readonly acquiredAt: number;
    release(): boolean;
}

export interface ResourceAdmissionState {
    limits: {
        minReservationMB: number;
        admissionLimitMB: number;
        hardLimitMB: number;
        systemHeadroomMB: number;
        commitHeadroomMB: number;
        yellowPhysicalMemoryMB: number;
        yellowMaxReservationMB: number;
        maxQueueSize: number;
    };
    activeReservedMB: number;
    activeLeases: number;
    queued: number;
    observedMemoryMB: number;
    systemAvailableMemoryMB: number | null;
    commitAvailableMemoryMB: number | null;
    highMemorySignaled: boolean | null;
    lowMemorySignaled: boolean | null;
    pressureLevel: ResourcePressureLevel;
    hardLimitExceeded: boolean;
    peak: {
        activeReservedMB: number;
        queued: number;
        observedMemoryMB: number;
    };
    wait: {
        queuedTotal: number;
        admittedTotal: number;
        admittedAfterWait: number;
        cancelledTotal: number;
        timedOutTotal: number;
        queueFullTotal: number;
        completedTotal: number;
        totalMs: number;
        maxMs: number;
        averageMs: number;
    };
}

interface PendingRequest {
    id: number;
    ownerId: string;
    reservedMB: number;
    enqueuedAt: number;
    retryAttempt?: number;
    signal?: AbortSignal;
    abortHandler?: () => void;
    timer?: ReturnType<typeof setTimeout>;
    progressTimer?: ReturnType<typeof setTimeout>;
    onWaitProgress?: (progress: ResourceWaitProgress) => void;
    resolve: (lease: ResourceLease) => void;
    reject: (error: ResourceAdmissionError) => void;
    settled: boolean;
}

interface WaitCounters {
    queuedTotal: number;
    admittedTotal: number;
    admittedAfterWait: number;
    cancelledTotal: number;
    timedOutTotal: number;
    queueFullTotal: number;
    completedTotal: number;
    totalMs: number;
    maxMs: number;
}

export class ResourceAdmissionController {
    readonly minReservationMB: number;
    readonly admissionLimitMB: number;
    readonly hardLimitMB: number;
    readonly systemHeadroomMB: number;
    readonly commitHeadroomMB: number;
    readonly yellowPhysicalMemoryMB: number;
    readonly yellowMaxReservationMB: number;
    readonly maxQueueSize: number;

    private readonly admissionBudgetMinMs: number;
    private readonly admissionBudgetMaxMs: number;
    private readonly agingThresholdMs: number;
    private readonly retrySlotMs: number;
    private readonly maxRetryExponent: number;
    private readonly maxAgedReservationMB: number;
    private readonly progressIntervalMs: number;
    private readonly now: () => number;
    private readonly random: () => number;
    private readonly queue: PendingRequest[] = [];
    private readonly waitCounters: WaitCounters = {
        queuedTotal: 0,
        admittedTotal: 0,
        admittedAfterWait: 0,
        cancelledTotal: 0,
        timedOutTotal: 0,
        queueFullTotal: 0,
        completedTotal: 0,
        totalMs: 0,
        maxMs: 0,
    };

    private activeReservedMB = 0;
    private activeLeases = 0;
    private observedMemoryMB = 0;
    private systemAvailableMemoryMB = Number.POSITIVE_INFINITY;
    private commitAvailableMemoryMB = Number.POSITIVE_INFINITY;
    private highMemorySignaled: boolean | null = null;
    private lowMemorySignaled: boolean | null = null;
    private peakActiveReservedMB = 0;
    private peakQueued = 0;
    private peakObservedMemoryMB = 0;
    private nextRequestId = 1;
    private lastGrantedOwnerId: string | null = null;
    private draining = false;

    constructor(options: ResourceAdmissionOptions = {}) {
        this.minReservationMB = positiveNumber(
            options.minReservationMB,
            RESOURCE_ADMISSION_DEFAULTS.minReservationMB,
            "minReservationMB",
        );
        this.admissionLimitMB = positiveNumber(
            options.admissionLimitMB,
            RESOURCE_ADMISSION_DEFAULTS.admissionLimitMB,
            "admissionLimitMB",
        );
        this.hardLimitMB = positiveNumber(
            options.hardLimitMB,
            RESOURCE_ADMISSION_DEFAULTS.hardLimitMB,
            "hardLimitMB",
        );
        this.systemHeadroomMB = nonNegativeNumber(
            options.systemHeadroomMB,
            RESOURCE_ADMISSION_DEFAULTS.systemHeadroomMB,
            "systemHeadroomMB",
        );
        this.commitHeadroomMB = nonNegativeNumber(
            options.commitHeadroomMB,
            RESOURCE_ADMISSION_DEFAULTS.commitHeadroomMB,
            "commitHeadroomMB",
        );
        this.yellowPhysicalMemoryMB = nonNegativeNumber(
            options.yellowPhysicalMemoryMB,
            RESOURCE_ADMISSION_DEFAULTS.yellowPhysicalMemoryMB,
            "yellowPhysicalMemoryMB",
        );
        this.yellowMaxReservationMB = positiveNumber(
            options.yellowMaxReservationMB,
            RESOURCE_ADMISSION_DEFAULTS.yellowMaxReservationMB,
            "yellowMaxReservationMB",
        );
        this.maxAgedReservationMB = nonNegativeNumber(
            options.maxAgedReservationMB,
            RESOURCE_ADMISSION_DEFAULTS.maxAgedReservationMB,
            "maxAgedReservationMB",
        );
        this.maxQueueSize = positiveInteger(
            options.maxQueueSize,
            RESOURCE_ADMISSION_DEFAULTS.maxQueueSize,
            "maxQueueSize",
        );
        this.admissionBudgetMinMs = nonNegativeNumber(
            options.admissionBudgetMinMs,
            RESOURCE_ADMISSION_DEFAULTS.admissionBudgetMinMs,
            "admissionBudgetMinMs",
        );
        this.admissionBudgetMaxMs = nonNegativeNumber(
            options.admissionBudgetMaxMs,
            RESOURCE_ADMISSION_DEFAULTS.admissionBudgetMaxMs,
            "admissionBudgetMaxMs",
        );
        this.agingThresholdMs = nonNegativeNumber(
            options.agingThresholdMs,
            RESOURCE_ADMISSION_DEFAULTS.agingThresholdMs,
            "agingThresholdMs",
        );
        this.retrySlotMs = nonNegativeNumber(
            options.retrySlotMs,
            RESOURCE_ADMISSION_DEFAULTS.retrySlotMs,
            "retrySlotMs",
        );
        this.maxRetryExponent = nonNegativeInteger(
            options.maxRetryExponent,
            RESOURCE_ADMISSION_DEFAULTS.maxRetryExponent,
            "maxRetryExponent",
        );
        this.progressIntervalMs = positiveNumber(
            options.progressIntervalMs,
            RESOURCE_ADMISSION_DEFAULTS.progressIntervalMs,
            "progressIntervalMs",
        );
        this.now = options.now ?? Date.now;
        this.random = options.random ?? Math.random;

        if (this.minReservationMB > this.admissionLimitMB) {
            throw new RangeError("minReservationMB cannot exceed admissionLimitMB");
        }
        if (this.admissionLimitMB > this.hardLimitMB) {
            throw new RangeError("admissionLimitMB cannot exceed hardLimitMB");
        }
        if (this.admissionBudgetMinMs > this.admissionBudgetMaxMs) {
            throw new RangeError("admissionBudgetMinMs cannot exceed admissionBudgetMaxMs");
        }
    }

    acquire(request: ResourceAdmissionRequest = {}): Promise<ResourceLease> {
        if (request.signal?.aborted) {
            return Promise.reject(this.makeAbortError(0));
        }

        if (request.control) {
            return Promise.resolve(this.createLease(0, true));
        }

        const reservedMB = this.normalizeReservation(request.reservationMB);
        const ownerId = normalizeOwnerId(request.ownerId);

        if (this.queue.length === 0 && this.canGrant(reservedMB)) {
            return Promise.resolve(this.grantImmediate(reservedMB));
        }

        if (this.queue.length >= this.maxQueueSize) {
            this.waitCounters.queueFullTotal += 1;
            return Promise.reject(new ResourceAdmissionError(
                "admission_queue_full",
                "Sandbox resource admission queue is full",
                0,
                this.computeRetryAfterMs(request.retryAttempt),
            ));
        }

        const admissionBudgetMs = request.admissionBudgetMs === undefined
            ? this.randomInteger(this.admissionBudgetMinMs, this.admissionBudgetMaxMs)
            : Math.min(
                nonNegativeNumber(request.admissionBudgetMs, 0, "admissionBudgetMs"),
                this.admissionBudgetMaxMs,
            );

        return new Promise<ResourceLease>((resolve, reject) => {
            const pending: PendingRequest = {
                id: this.nextRequestId++,
                ownerId,
                reservedMB,
                enqueuedAt: this.now(),
                retryAttempt: request.retryAttempt,
                signal: request.signal,
                onWaitProgress: request.onWaitProgress,
                resolve,
                reject,
                settled: false,
            };

            pending.abortHandler = () => this.rejectPending(pending, "admission_aborted");
            pending.timer = setTimeout(
                () => this.rejectPending(pending, "admission_timeout"),
                admissionBudgetMs,
            );
            pending.timer.unref?.();

            this.queue.push(pending);
            this.waitCounters.queuedTotal += 1;
            this.peakQueued = Math.max(this.peakQueued, this.queue.length);
            request.signal?.addEventListener("abort", pending.abortHandler, { once: true });
            this.scheduleWaitProgress(pending);

            if (request.signal?.aborted) {
                this.rejectPending(pending, "admission_aborted");
                return;
            }

            this.drainQueue();
        });
    }

    acquireControl(signal?: AbortSignal): Promise<ResourceLease> {
        return this.acquire({ control: true, signal });
    }

    adopt(reservationMB?: number): ResourceLease {
        return this.createLease(this.normalizeReservation(reservationMB), false);
    }

    updateObservedMemoryMB(observedMemoryMB: number): ResourceAdmissionState {
        if (!Number.isFinite(observedMemoryMB) || observedMemoryMB < 0) {
            throw new RangeError("observedMemoryMB must be a finite non-negative number");
        }

        const wasBlocked = this.observedMemoryMB >= this.hardLimitMB;
        this.observedMemoryMB = observedMemoryMB;
        this.peakObservedMemoryMB = Math.max(this.peakObservedMemoryMB, observedMemoryMB);

        if (wasBlocked && observedMemoryMB < this.hardLimitMB) {
            this.drainQueue();
        }

        return this.getState();
    }

    updateSystemAvailableMemoryMB(systemAvailableMemoryMB: number): ResourceAdmissionState {
        if (!Number.isFinite(systemAvailableMemoryMB) || systemAvailableMemoryMB < 0) {
            throw new RangeError("systemAvailableMemoryMB must be a finite non-negative number");
        }

        const previous = this.systemAvailableMemoryMB;
        this.systemAvailableMemoryMB = systemAvailableMemoryMB;
        if (systemAvailableMemoryMB > previous) this.drainQueue();
        return this.getState();
    }

    updateSystemPressure(sample: {
        systemAvailableMemoryMB: number;
        commitAvailableMemoryMB: number;
        highMemorySignaled: boolean;
        lowMemorySignaled: boolean;
    }): ResourceAdmissionState {
        if (!Number.isFinite(sample.systemAvailableMemoryMB) || sample.systemAvailableMemoryMB < 0
            || !Number.isFinite(sample.commitAvailableMemoryMB) || sample.commitAvailableMemoryMB < 0) {
            throw new RangeError("system pressure memory values must be finite non-negative numbers");
        }
        const previousPhysical = this.systemAvailableMemoryMB;
        const previousCommit = this.commitAvailableMemoryMB;
        const previousHighMemory = this.highMemorySignaled;
        const previousLowMemory = this.lowMemorySignaled;
        this.systemAvailableMemoryMB = sample.systemAvailableMemoryMB;
        this.commitAvailableMemoryMB = sample.commitAvailableMemoryMB;
        this.highMemorySignaled = sample.highMemorySignaled;
        this.lowMemorySignaled = sample.lowMemorySignaled;
        if (sample.systemAvailableMemoryMB > previousPhysical
            || sample.commitAvailableMemoryMB > previousCommit
            || (previousLowMemory === true && !sample.lowMemorySignaled)
            || (previousHighMemory === false && sample.highMemorySignaled)) {
            this.drainQueue();
        }
        return this.getState();
    }

    getState(): ResourceAdmissionState {
        const completedTotal = this.waitCounters.completedTotal;
        return {
            limits: {
                minReservationMB: this.minReservationMB,
                admissionLimitMB: this.admissionLimitMB,
                hardLimitMB: this.hardLimitMB,
                systemHeadroomMB: this.systemHeadroomMB,
                commitHeadroomMB: this.commitHeadroomMB,
                yellowPhysicalMemoryMB: this.yellowPhysicalMemoryMB,
                yellowMaxReservationMB: this.yellowMaxReservationMB,
                maxQueueSize: this.maxQueueSize,
            },
            activeReservedMB: this.activeReservedMB,
            activeLeases: this.activeLeases,
            queued: this.queue.length,
            observedMemoryMB: this.observedMemoryMB,
            systemAvailableMemoryMB: Number.isFinite(this.systemAvailableMemoryMB)
                ? this.systemAvailableMemoryMB
                : null,
            commitAvailableMemoryMB: Number.isFinite(this.commitAvailableMemoryMB)
                ? this.commitAvailableMemoryMB
                : null,
            highMemorySignaled: this.highMemorySignaled,
            lowMemorySignaled: this.lowMemorySignaled,
            pressureLevel: this.getPressureLevel(),
            hardLimitExceeded: this.observedMemoryMB >= this.hardLimitMB,
            peak: {
                activeReservedMB: this.peakActiveReservedMB,
                queued: this.peakQueued,
                observedMemoryMB: this.peakObservedMemoryMB,
            },
            wait: {
                ...this.waitCounters,
                averageMs: completedTotal === 0
                    ? 0
                    : this.waitCounters.totalMs / completedTotal,
            },
        };
    }

    private normalizeReservation(reservationMB: number | undefined): number {
        const requestedMB = reservationMB === undefined
            ? this.minReservationMB
            : positiveNumber(reservationMB, this.minReservationMB, "reservationMB");
        const reservedMB = Math.max(this.minReservationMB, Math.ceil(requestedMB));

        if (reservedMB > this.hardLimitMB) {
            throw new ResourceAdmissionError(
                "reservation_exceeds_hard_limit",
                `Requested reservation exceeds the ${this.hardLimitMB}MB hard limit`,
            );
        }
        if (reservedMB > this.admissionLimitMB) {
            throw new ResourceAdmissionError(
                "reservation_exceeds_admission_limit",
                `Requested reservation exceeds the ${this.admissionLimitMB}MB admission limit`,
            );
        }

        return reservedMB;
    }

    private getPressureLevel(): ResourcePressureLevel {
        if (this.lowMemorySignaled === true
            || this.systemAvailableMemoryMB < this.systemHeadroomMB
            || this.commitAvailableMemoryMB < this.commitHeadroomMB) return "red";
        if (this.highMemorySignaled === false
            || this.systemAvailableMemoryMB < this.yellowPhysicalMemoryMB) return "yellow";
        return "green";
    }

    private canGrant(reservedMB: number, protectedReservationMB = 0): boolean {
        const reservedButNotObservedMB = Math.max(0, this.activeReservedMB - this.observedMemoryMB);
        const preservesSystemHeadroom = this.systemAvailableMemoryMB
            - reservedButNotObservedMB
            - reservedMB
            - protectedReservationMB >= this.systemHeadroomMB;
        const preservesCommitHeadroom = this.commitAvailableMemoryMB
            - reservedButNotObservedMB
            - reservedMB
            - protectedReservationMB >= this.commitHeadroomMB;
        const pressureLevel = this.getPressureLevel();
        return pressureLevel !== "red"
            && !(pressureLevel === "yellow" && reservedMB > this.yellowMaxReservationMB)
            && this.observedMemoryMB < this.hardLimitMB
            && this.activeReservedMB + reservedMB + protectedReservationMB <= this.admissionLimitMB
            && preservesSystemHeadroom
            && preservesCommitHeadroom;
    }

    private grantImmediate(reservedMB: number): ResourceLease {
        this.waitCounters.admittedTotal += 1;
        return this.createLease(reservedMB, false);
    }

    private createLease(reservedMB: number, control: boolean): ResourceLease {
        const acquiredAt = this.now();
        let released = false;

        if (!control) {
            this.activeReservedMB += reservedMB;
            this.activeLeases += 1;
            this.peakActiveReservedMB = Math.max(
                this.peakActiveReservedMB,
                this.activeReservedMB,
            );
        }

        return Object.freeze({
            reservedMB,
            control,
            acquiredAt,
            release: (): boolean => {
                if (released) return false;
                released = true;

                if (!control) {
                    this.activeReservedMB = Math.max(0, this.activeReservedMB - reservedMB);
                    this.activeLeases = Math.max(0, this.activeLeases - 1);
                    this.drainQueue();
                }

                return true;
            },
        });
    }

    private drainQueue(): void {
        if (this.draining) return;
        this.draining = true;

        try {
            while (this.queue.length > 0) {
                const pending = this.selectNextPending();
                if (!pending) return;

                if (pending.signal?.aborted) {
                    this.rejectPending(pending, "admission_aborted");
                    continue;
                }

                this.grantPending(pending);
            }
        } finally {
            this.draining = false;
        }
    }

    private selectNextPending(): PendingRequest | undefined {
        const liveQueue = this.queue.filter((pending) => !pending.settled);
        if (liveQueue.length === 0) return undefined;

        const oldest = liveQueue[0];
        const oldestWaitMs = Math.max(0, this.now() - oldest.enqueuedAt);
        if (oldestWaitMs >= this.agingThresholdMs && this.canGrant(oldest.reservedMB)) return oldest;
        const protectedReservationMB = this.computeAgedReservation(oldest, oldestWaitMs);

        const ownerQueues = new Map<string, PendingRequest[]>();
        for (const pending of liveQueue) {
            const ownerQueue = ownerQueues.get(pending.ownerId) ?? [];
            ownerQueue.push(pending);
            ownerQueues.set(pending.ownerId, ownerQueue);
        }

        const owners = [...ownerQueues.keys()];
        const lastOwnerIndex = this.lastGrantedOwnerId === null
            ? -1
            : owners.indexOf(this.lastGrantedOwnerId);
        const startIndex = lastOwnerIndex >= 0
            ? (lastOwnerIndex + 1) % owners.length
            : 0;

        for (let offset = 0; offset < owners.length; offset += 1) {
            const ownerId = owners[(startIndex + offset) % owners.length];
            const ownerQueue = ownerQueues.get(ownerId) ?? [];
            for (const pending of ownerQueue) {
                if (this.canGrant(
                    pending.reservedMB,
                    pending === oldest ? 0 : protectedReservationMB,
                )) {
                    return pending;
                }
            }
        }

        return undefined;
    }

    private computeAgedReservation(oldest: PendingRequest, oldestWaitMs: number): number {
        if (oldestWaitMs < this.agingThresholdMs || this.agingThresholdMs <= 0) return 0;
        if (this.activeReservedMB + oldest.reservedMB <= this.admissionLimitMB) return 0;
        const agingSteps = Math.max(1, Math.floor(oldestWaitMs / this.agingThresholdMs));
        return Math.min(
            oldest.reservedMB,
            this.maxAgedReservationMB,
            Math.max(0, agingSteps - 2) * this.minReservationMB,
        );
    }

    private scheduleWaitProgress(pending: PendingRequest): void {
        if (!pending.onWaitProgress) return;
        const emit = () => {
            if (pending.settled) return;
            const liveQueue = this.queue.filter((item) => !item.settled);
            const queuePosition = liveQueue.indexOf(pending) + 1;
            try {
                pending.onWaitProgress?.({
                    queueWaitMs: Math.max(0, this.now() - pending.enqueuedAt),
                    queuePosition: Math.max(1, queuePosition),
                    queued: liveQueue.length,
                    pressureLevel: this.getPressureLevel(),
                    activeReservedMB: this.activeReservedMB,
                    observedMemoryMB: this.observedMemoryMB,
                    systemAvailableMemoryMB: Number.isFinite(this.systemAvailableMemoryMB)
                        ? this.systemAvailableMemoryMB
                        : null,
                    commitAvailableMemoryMB: Number.isFinite(this.commitAvailableMemoryMB)
                        ? this.commitAvailableMemoryMB
                        : null,
                });
            } catch {
            }
            pending.progressTimer = setTimeout(emit, this.progressIntervalMs);
            pending.progressTimer.unref?.();
        };
        pending.progressTimer = setTimeout(emit, this.agingThresholdMs);
        pending.progressTimer.unref?.();
    }

    private grantPending(pending: PendingRequest): void {
        const queueWaitMs = this.finishPending(pending);
        this.waitCounters.admittedTotal += 1;
        this.waitCounters.admittedAfterWait += 1;
        this.recordCompletedWait(queueWaitMs);
        this.lastGrantedOwnerId = pending.ownerId;
        pending.resolve(this.createLease(pending.reservedMB, false));
    }

    private rejectPending(
        pending: PendingRequest,
        code: "admission_aborted" | "admission_timeout",
    ): void {
        if (pending.settled) return;

        const queueWaitMs = this.finishPending(pending);
        this.recordCompletedWait(queueWaitMs);

        if (code === "admission_aborted") {
            this.waitCounters.cancelledTotal += 1;
            pending.reject(this.makeAbortError(queueWaitMs));
        } else {
            this.waitCounters.timedOutTotal += 1;
            pending.reject(new ResourceAdmissionError(
                "admission_timeout",
                "Sandbox resource admission timed out before the command started",
                queueWaitMs,
                this.computeRetryAfterMs(pending.retryAttempt),
            ));
        }

        this.drainQueue();
    }

    private finishPending(pending: PendingRequest): number {
        pending.settled = true;
        const queueIndex = this.queue.findIndex((candidate) => candidate.id === pending.id);
        if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
        if (pending.timer) clearTimeout(pending.timer);
        if (pending.progressTimer) clearTimeout(pending.progressTimer);
        if (pending.signal && pending.abortHandler) {
            pending.signal.removeEventListener("abort", pending.abortHandler);
        }
        return Math.max(0, this.now() - pending.enqueuedAt);
    }

    private recordCompletedWait(queueWaitMs: number): void {
        this.waitCounters.completedTotal += 1;
        this.waitCounters.totalMs += queueWaitMs;
        this.waitCounters.maxMs = Math.max(this.waitCounters.maxMs, queueWaitMs);
    }

    private makeAbortError(queueWaitMs: number): ResourceAdmissionError {
        return new ResourceAdmissionError(
            "admission_aborted",
            "Sandbox resource admission was cancelled before the command started",
            queueWaitMs,
            0,
        );
    }

    private computeRetryAfterMs(retryAttempt: number | undefined): number {
        const exponent = retryAttempt === undefined
            ? this.maxRetryExponent
            : Math.min(
                this.maxRetryExponent,
                Math.max(0, Math.floor(retryAttempt)),
            );
        const slotCount = 2 ** exponent;
        return Math.floor(this.safeRandom() * slotCount) * this.retrySlotMs;
    }

    private randomInteger(minimum: number, maximum: number): number {
        if (minimum === maximum) return minimum;
        return Math.floor(minimum + this.safeRandom() * (maximum - minimum + 1));
    }

    private safeRandom(): number {
        const value = this.random();
        if (!Number.isFinite(value)) return 0;
        return Math.min(0.999999999999, Math.max(0, value));
    }
}

export { ResourceAdmissionController as ResourceAdmissionManager };

function normalizeOwnerId(ownerId: string | undefined): string {
    if (typeof ownerId !== "string") return "anonymous";
    const normalized = ownerId.trim();
    return normalized.length > 0 ? normalized : "anonymous";
}

function positiveNumber(value: number | undefined, fallback: number, name: string): number {
    const resolved = value ?? fallback;
    if (!Number.isFinite(resolved) || resolved <= 0) {
        throw new RangeError(`${name} must be a finite positive number`);
    }
    return resolved;
}

function nonNegativeNumber(value: number | undefined, fallback: number, name: string): number {
    const resolved = value ?? fallback;
    if (!Number.isFinite(resolved) || resolved < 0) {
        throw new RangeError(`${name} must be a finite non-negative number`);
    }
    return resolved;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved <= 0) {
        throw new RangeError(`${name} must be a positive integer`);
    }
    return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved < 0) {
        throw new RangeError(`${name} must be a non-negative integer`);
    }
    return resolved;
}
