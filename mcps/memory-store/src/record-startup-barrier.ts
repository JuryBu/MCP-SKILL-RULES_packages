export type RecordMutationReadinessState = "pending" | "recovering" | "ready" | "failed";

export interface RecordMutationReadinessSnapshot {
    state: RecordMutationReadinessState;
    error?: string;
}

export type RecordMutationStartupWork = () => void | Promise<void>;

export interface RecordMutationStartupRecoverySummary {
    generic: {
        results: Array<{
            outcome: string;
            taskId: string;
            kind: string;
        }>;
    };
    recordScheduler: {
        repairRequired: number;
        unknownOutcome: number;
    };
}

export class RecordMutationStartupRecoveryError extends Error {
    readonly code = "RECORD_MUTATION_STARTUP_RECOVERY_FAILED";

    constructor(readonly startupFailure: unknown) {
        super(`Record mutation startup recovery failed; mutations remain blocked: ${describeStartupFailure(startupFailure)}`);
        this.name = "RecordMutationStartupRecoveryError";
    }
}

export interface RecordMutationReadinessBarrier {
    start: (work: RecordMutationStartupWork) => Promise<void>;
    waitForReadiness: () => Promise<void>;
    snapshot: () => RecordMutationReadinessSnapshot;
}

function describeStartupFailure(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message;
    if (typeof error === "string" && error.trim()) return error;
    if (error === undefined) return "unknown error";
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

export function assertRecordMutationStartupRecoverySafe(summary: RecordMutationStartupRecoverySummary): void {
    const legacyRecordFailures = summary.generic.results.filter(result => (
        result.outcome === "error"
        && (result.kind === "record-update" || result.kind === "record-batch-update")
    ));
    const blockers: string[] = [];
    if (legacyRecordFailures.length > 0) {
        blockers.push(`legacyRecordFailures=${legacyRecordFailures.length} (${legacyRecordFailures.map(result => result.taskId).join(",")})`);
    }
    if (summary.recordScheduler.repairRequired > 0) {
        blockers.push(`schedulerRepairRequired=${summary.recordScheduler.repairRequired}`);
    }
    if (summary.recordScheduler.unknownOutcome > 0) {
        blockers.push(`schedulerUnknownOutcome=${summary.recordScheduler.unknownOutcome}`);
    }
    if (blockers.length > 0) {
        throw new Error(`Record startup recovery contains unresolved mutation state: ${blockers.join("; ")}`);
    }
}

export function createRecordMutationReadinessBarrier(): RecordMutationReadinessBarrier {
    let state: RecordMutationReadinessState = "pending";
    let startupError: RecordMutationStartupRecoveryError | undefined;
    let startPromise: Promise<void> | undefined;
    let resolveReadiness!: () => void;
    let rejectReadiness!: (reason: unknown) => void;
    const readiness = new Promise<void>((resolve, reject) => {
        resolveReadiness = resolve;
        rejectReadiness = reject;
    });

    void readiness.catch(() => undefined);

    return {
        start(work: RecordMutationStartupWork): Promise<void> {
            if (startPromise) return startPromise;
            state = "recovering";
            startPromise = Promise.resolve()
                .then(work)
                .then(
                    () => {
                        state = "ready";
                        resolveReadiness();
                    },
                    error => {
                        startupError = new RecordMutationStartupRecoveryError(error);
                        state = "failed";
                        rejectReadiness(startupError);
                        throw startupError;
                    },
                );
            return startPromise;
        },
        waitForReadiness(): Promise<void> {
            return readiness;
        },
        snapshot(): RecordMutationReadinessSnapshot {
            return startupError
                ? { state, error: startupError.message }
                : { state };
        },
    };
}

export const recordMutationReadinessBarrier = createRecordMutationReadinessBarrier();

export function waitForRecordMutationReadiness(): Promise<void> {
    if (recordMutationReadinessBarrier.snapshot().state === "pending") return Promise.resolve();
    return recordMutationReadinessBarrier.waitForReadiness();
}
