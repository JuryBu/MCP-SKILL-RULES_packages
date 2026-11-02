import type { RetentionSweepResult } from './storage/port.js';

export interface RetentionMaintenanceOptions {
    sweep(): Promise<RetentionSweepResult>;
    afterSweep(result: RetentionSweepResult): Promise<void>;
    blocked(): boolean;
    onError(error: unknown): void;
    intervalMs?: number;
}

export function createRetentionMaintenance(options: RetentionMaintenanceOptions) {
    const intervalMs = options.intervalMs ?? 30_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) throw new Error('Retention interval must be at least 100ms');
    let stopped = false;
    let pending: Promise<void> | undefined;
    const tick = (): Promise<void> => {
        if (stopped || options.blocked()) return Promise.resolve();
        if (pending) return pending;
        const work = (async () => {
            const result = await options.sweep();
            await options.afterSweep(result);
        })().catch(options.onError);
        pending = work;
        void work.finally(() => { if (pending === work) pending = undefined; });
        return work;
    };
    const timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref();
    return { tick, busy: () => Boolean(pending), async stop(): Promise<void> { stopped = true; clearInterval(timer); await pending; } };
}
