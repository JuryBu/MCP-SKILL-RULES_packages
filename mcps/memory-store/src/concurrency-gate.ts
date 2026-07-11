export type ConcurrencyGateRequestClass = "foreground" | "background";

export type ConcurrencyGateAcquireOptions = {
    deadlineAt?: number;
    timeoutMs?: number;
    shouldCancel?: () => boolean;
    cancelMessage?: string;
    timeoutMessage?: string;
    requestClass?: ConcurrencyGateRequestClass;
};

export type ConcurrencyGateSnapshot = {
    active: number;
    pending: number;
    peakActive: number;
    limit: number;
    activeForeground?: number;
    activeBackground?: number;
    pendingForeground?: number;
    pendingBackground?: number;
    configuredReserved?: number;
    effectiveReserved?: number;
    borrowing?: boolean;
};

export type ConcurrencyGatePermit = {
    queueWaitMs: number;
    snapshot: ConcurrencyGateSnapshot;
    release: () => void;
};

type PendingAcquire = {
    enqueuedAt: number;
    deadlineAt?: number;
    shouldCancel?: () => boolean;
    cancelMessage: string;
    timeoutMessage: string;
    resolve: (permit: ConcurrencyGatePermit) => void;
    reject: (error: Error) => void;
    timer?: NodeJS.Timeout;
    settled: boolean;
    requestClass: ConcurrencyGateRequestClass;
    sequence: number;
};

export type FifoConcurrencyGateOptions = {
    reservedSlots?: number | (() => number);
};

function finiteDeadline(options: ConcurrencyGateAcquireOptions, now: number): number | undefined {
    const candidates = [
        Number.isFinite(options.deadlineAt) ? Number(options.deadlineAt) : undefined,
        Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) >= 0
            ? now + Number(options.timeoutMs)
            : undefined,
    ].filter((value): value is number => value !== undefined);
    return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

export class FifoConcurrencyGate {
    private active = 0;
    private activeForeground = 0;
    private activeBackground = 0;
    private peakActive = 0;
    private readonly queue: PendingAcquire[] = [];
    private readonly foregroundQueue: PendingAcquire[] = [];
    private readonly backgroundQueue: PendingAcquire[] = [];
    private nextSequence = 0;

    constructor(
        private readonly resolveLimit: () => number,
        private readonly options: FifoConcurrencyGateOptions = {},
    ) {}

    stats(): ConcurrencyGateSnapshot {
        const capacity = this.capacity();
        return {
            active: this.active,
            pending: this.foregroundQueue.length + this.backgroundQueue.length,
            peakActive: this.peakActive,
            limit: capacity.limit,
            ...(this.options.reservedSlots === undefined ? {} : {
                activeForeground: this.activeForeground,
                activeBackground: this.activeBackground,
                pendingForeground: this.foregroundQueue.length,
                pendingBackground: this.backgroundQueue.length,
                configuredReserved: capacity.configuredReserved,
                effectiveReserved: capacity.effectiveReserved,
                borrowing: this.activeBackground > capacity.ordinaryCapacity,
            }),
        };
    }

    resetPeakForTest(): void {
        this.peakActive = this.active;
    }

    notifyCapacityIncrease(): void {
        this.pump();
    }

    async acquire(options: ConcurrencyGateAcquireOptions = {}): Promise<ConcurrencyGatePermit> {
        const enqueuedAt = Date.now();
        const deadlineAt = finiteDeadline(options, enqueuedAt);
        if (this.shouldCancel(options.shouldCancel)) {
            throw new Error(options.cancelMessage || "concurrency gate acquire cancelled");
        }
        if (deadlineAt !== undefined && deadlineAt <= enqueuedAt) {
            throw new Error(options.timeoutMessage || "concurrency gate acquire timed out");
        }

        return new Promise<ConcurrencyGatePermit>((resolve, reject) => {
            const pending: PendingAcquire = {
                enqueuedAt,
                deadlineAt,
                shouldCancel: options.shouldCancel,
                cancelMessage: options.cancelMessage || "concurrency gate acquire cancelled",
                timeoutMessage: options.timeoutMessage || "concurrency gate acquire timed out",
                resolve,
                reject,
                settled: false,
                requestClass: options.requestClass || "foreground",
                sequence: this.nextSequence++,
            };
            if (deadlineAt !== undefined || pending.shouldCancel) {
                pending.timer = setInterval(() => this.checkPending(pending), 25);
            }
            this.queue.push(pending);
            this.queueFor(pending.requestClass).push(pending);
            this.pump();
        });
    }

    private limit(): number {
        const value = Math.floor(Number(this.resolveLimit()));
        return Number.isFinite(value) && value > 0 ? value : 1;
    }

    private capacity(): { limit: number; configuredReserved: number; effectiveReserved: number; ordinaryCapacity: number } {
        const limit = this.limit();
        const configuredReserved = this.configuredReserved();
        const effectiveReserved = Math.min(configuredReserved, Math.max(0, limit - 1));
        return {
            limit,
            configuredReserved,
            effectiveReserved,
            ordinaryCapacity: limit - effectiveReserved,
        };
    }

    private configuredReserved(): number {
        try {
            const raw = typeof this.options.reservedSlots === "function"
                ? this.options.reservedSlots()
                : this.options.reservedSlots;
            const value = Math.floor(Number(raw));
            return Number.isFinite(value) && value >= 0 ? value : 0;
        } catch {
            return 0;
        }
    }

    private checkPending(pending: PendingAcquire): void {
        if (pending.settled) return;
        if (this.shouldCancel(pending.shouldCancel)) {
            this.rejectPending(pending, pending.cancelMessage);
            return;
        }
        if (pending.deadlineAt !== undefined && Date.now() >= pending.deadlineAt) {
            this.rejectPending(pending, pending.timeoutMessage);
        }
    }

    private rejectPending(pending: PendingAcquire, message: string, pumpAfterReject = true): void {
        if (pending.settled) return;
        pending.settled = true;
        if (pending.timer) clearInterval(pending.timer);
        this.removePending(pending);
        pending.reject(new Error(message));
        if (pumpAfterReject) this.pump();
    }

    private pump(): void {
        while (this.active < this.capacity().limit) {
            const pending = this.nextPending();
            if (!pending) return;
            this.removePending(pending);
            if (pending.settled) continue;
            if (this.shouldCancel(pending.shouldCancel)) {
                this.rejectPending(pending, pending.cancelMessage, false);
                continue;
            }
            if (pending.deadlineAt !== undefined && Date.now() >= pending.deadlineAt) {
                this.rejectPending(pending, pending.timeoutMessage, false);
                continue;
            }
            pending.settled = true;
            if (pending.timer) clearInterval(pending.timer);
            this.active += 1;
            if (pending.requestClass === "foreground") this.activeForeground += 1;
            else this.activeBackground += 1;
            this.peakActive = Math.max(this.peakActive, this.active);
            let released = false;
            const queueWaitMs = Math.max(0, Date.now() - pending.enqueuedAt);
            pending.resolve({
                queueWaitMs,
                snapshot: this.stats(),
                release: () => {
                    if (released) return;
                    released = true;
                    this.active = Math.max(0, this.active - 1);
                    if (pending.requestClass === "foreground") {
                        this.activeForeground = Math.max(0, this.activeForeground - 1);
                    } else {
                        this.activeBackground = Math.max(0, this.activeBackground - 1);
                    }
                    this.pump();
                },
            });
        }
    }

    private nextPending(): PendingAcquire | undefined {
        const foreground = this.foregroundQueue[0];
        const background = this.backgroundQueue[0];
        if (!foreground) return background;
        if (!background) return foreground;

        const capacity = this.capacity();
        if (capacity.configuredReserved > 0) return foreground;
        return foreground.sequence <= background.sequence ? foreground : background;
    }

    private queueFor(requestClass: ConcurrencyGateRequestClass): PendingAcquire[] {
        return requestClass === "foreground" ? this.foregroundQueue : this.backgroundQueue;
    }

    private removePending(pending: PendingAcquire): void {
        const queueIndex = this.queue.indexOf(pending);
        if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
        const classQueue = this.queueFor(pending.requestClass);
        const classQueueIndex = classQueue.indexOf(pending);
        if (classQueueIndex >= 0) classQueue.splice(classQueueIndex, 1);
    }

    private shouldCancel(callback?: () => boolean): boolean {
        if (!callback) return false;
        try {
            return callback() === true;
        } catch {
            return true;
        }
    }
}
