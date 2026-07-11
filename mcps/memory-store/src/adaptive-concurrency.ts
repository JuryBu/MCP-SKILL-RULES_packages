export type AdaptiveConcurrencySnapshot = {
    current: number;
    max: number;
    min: number;
    successes: number;
    failures: number;
};

function normalizePositiveInteger(value: number, fallback: number): number {
    const normalized = Math.floor(value);
    return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

export class AdaptiveConcurrencyGate {
    private currentLimit: number;
    private consecutiveSuccesses = 0;
    private totalSuccesses = 0;
    private totalFailures = 0;
    private readonly maxLimit: number;
    private readonly minLimit: number;

    constructor(maxLimit: number, minLimit = 1, initialLimit?: number) {
        this.maxLimit = normalizePositiveInteger(maxLimit, 1);
        this.minLimit = Math.min(
            normalizePositiveInteger(minLimit, 1),
            this.maxLimit,
        );
        this.currentLimit = Math.min(
            Math.max(
                normalizePositiveInteger(initialLimit ?? this.minLimit, this.minLimit),
                this.minLimit,
            ),
            this.maxLimit,
        );
    }

    get limit(): number {
        return this.currentLimit;
    }

    onSuccess(): boolean {
        this.consecutiveSuccesses += 1;
        this.totalSuccesses += 1;
        if (this.consecutiveSuccesses >= this.currentLimit && this.currentLimit < this.maxLimit) {
            this.currentLimit = Math.min(this.maxLimit, this.currentLimit + 1);
            this.consecutiveSuccesses = 0;
            return true;
        }
        return false;
    }

    onFailure(): void {
        this.totalFailures += 1;
        this.currentLimit = Math.max(this.minLimit, Math.floor(this.currentLimit / 2));
        this.consecutiveSuccesses = 0;
    }

    snapshot(): AdaptiveConcurrencySnapshot {
        return {
            current: this.currentLimit,
            max: this.maxLimit,
            min: this.minLimit,
            successes: this.totalSuccesses,
            failures: this.totalFailures,
        };
    }
}
