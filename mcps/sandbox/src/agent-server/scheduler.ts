export class SerialScheduler {
    private tail: Promise<unknown> = Promise.resolve();

    run<Value>(operation: () => Promise<Value>): Promise<Value> {
        const result = this.tail.then(operation);
        this.tail = result.catch(() => undefined);
        return result;
    }

    async idle(): Promise<void> { await this.tail; }
}

export class ExecutionRegistry {
    private readonly jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();

    has(runId?: string): boolean { return runId ? this.jobs.has(runId) : this.jobs.size > 0; }

    start(runId: string, operation: (signal: AbortSignal) => Promise<void>, onSettled?: () => void): void {
        if (this.jobs.has(runId)) return;
        const controller = new AbortController();
        const done = Promise.resolve().then(() => operation(controller.signal)).catch(() => undefined)
            .finally(() => { this.jobs.delete(runId); onSettled?.(); });
        this.jobs.set(runId, { controller, done });
    }

    cancel(runId: string, reason: string): void { this.jobs.get(runId)?.controller.abort(reason); }

    async wait(maxMs: number): Promise<boolean> {
        if (!this.jobs.size) return true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([Promise.all([...this.jobs.values()].map(job => job.done)).then(() => true),
            new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), maxMs); })])
            .finally(() => { if (timer) clearTimeout(timer); });
    }
}
