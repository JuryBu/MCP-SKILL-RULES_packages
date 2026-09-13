import { snapshotBrowserStorage, type BrowserStorageSnapshotResult } from "./chrome-helper.js";

export class StorageSnapshotTracker {
    private timer?: ReturnType<typeof setTimeout>;
    private queue: Promise<BrowserStorageSnapshotResult>;
    private stopped = true;
    private state: BrowserStorageSnapshotResult;
    private readonly intervalMs: number;
    private readonly prefix: string;

    constructor(private readonly context: any, options?: { reasonPrefix?: string; intervalMs?: number }) {
        this.intervalMs = Math.max(10, options?.intervalMs ?? 2000);
        this.prefix = options?.reasonPrefix ?? "storage";
        this.state = { reason: this.prefix, cookieCount: 0, savedCookieCount: 0, cookies: [], localStorageDomains: [], errors: [] };
        this.queue = Promise.resolve(this.summary());
    }

    async start(): Promise<void> {
        if (!this.stopped) return;
        this.stopped = false;
        await this.capture(`${this.prefix}-initial`);
        this.schedule();
    }

    private schedule(): void {
        if (this.stopped) return;
        this.timer = setTimeout(() => {
            void this.capture(`${this.prefix}-periodic`).finally(() => this.schedule());
        }, this.intervalMs);
        this.timer.unref();
    }

    capture(reason: string): Promise<BrowserStorageSnapshotResult> {
        this.queue = this.queue.then(async () => {
            let sample: BrowserStorageSnapshotResult;
            try {
                sample = await snapshotBrowserStorage(this.context, { reason });
            } catch {
                sample = { reason, cookieCount: 0, savedCookieCount: 0, cookies: [], localStorageDomains: [], errors: ["snapshot: unavailable"], capturedAt: new Date().toISOString() };
            }
            this.state.reason = sample.reason;
            this.state.capturedAt = sample.capturedAt;
            this.state.errors = [...sample.errors];
            if ((sample.savedCookieCount ?? 0) > 0) {
                this.state.cookies = sample.cookies;
                this.state.cookieCount = sample.cookieCount;
                this.state.savedCookieCount = sample.savedCookieCount;
                this.state.mergedCookieCount = sample.mergedCookieCount;
            }
            const origins = new Map(this.state.localStorageDomains.map(entry => [entry.domain, entry]));
            for (const entry of sample.localStorageDomains) origins.set(entry.domain, entry);
            this.state.localStorageDomains = [...origins.values()];
            if (sample.savedAt) this.state.savedAt = sample.savedAt;
            return this.summary();
        });
        return this.queue;
    }

    async stop(reason?: string): Promise<BrowserStorageSnapshotResult> {
        this.stopped = true;
        clearTimeout(this.timer);
        await this.queue;
        if (reason) await this.capture(reason);
        return this.summary();
    }

    summary(): BrowserStorageSnapshotResult {
        return { ...this.state, cookies: this.state.cookies.map(cookie => ({ ...cookie })), localStorageDomains: this.state.localStorageDomains.map(entry => ({ ...entry })), errors: [...this.state.errors] };
    }
}
