import { getStorageWriteState, snapshotBrowserStorage, StorageWriteState, type BrowserStorageSnapshotResult } from "./chrome-helper.js";
import { addStorageIssue, mergeStorageSnapshots, storageOrigin } from "./storage-snapshot.js";

export class StorageSnapshotTracker {
    private timer?: ReturnType<typeof setTimeout>;
    private queue: Promise<BrowserStorageSnapshotResult>;
    private stopped = true;
    private state: BrowserStorageSnapshotResult;
    private readonly intervalMs: number;
    private readonly prefix: string;
    private readonly origins = new Set<string>();
    private readonly pageListeners = new Map<any, (frame: any) => void>();
    private pageListener?: (page: any) => void;
    private trackingComplete = false;
    readonly writeState: StorageWriteState;

    constructor(private readonly context: any, options?: { reasonPrefix?: string; intervalMs?: number; writeState?: StorageWriteState }) {
        this.writeState = options?.writeState ?? getStorageWriteState(context);
        this.intervalMs = Math.max(10, options?.intervalMs ?? 2000);
        this.prefix = options?.reasonPrefix ?? "storage";
        this.state = { reason: this.prefix, cookieCount: 0, savedCookieCount: 0, cookies: [], localStorageDomains: [], errors: [] };
        this.queue = Promise.resolve(this.summary());
    }

    async start(): Promise<void> {
        if (!this.stopped) return;
        this.stopped = false;
        if (typeof this.context.on === "function" && typeof this.context.removeListener === "function") {
            this.pageListener = page => this.observePage(page);
            this.context.on("page", this.pageListener);
            this.trackingComplete = true;
        }
        for (const page of this.context.pages?.() ?? []) this.observePage(page);
        await this.capture(`${this.prefix}-initial`);
        this.schedule();
    }

    private observeUrl(url: string): void {
        const origin = storageOrigin(url);
        if (!origin || this.origins.has(origin)) return;
        if (this.origins.size >= 64) {
            this.trackingComplete = false;
            addStorageIssue(this.state, { area: "recovery", phase: "coverage", code: "origin-limit-exceeded" });
            return;
        }
        this.origins.add(origin);
    }

    private observePage(page: any): void {
        try {
            this.observeUrl(page.url());
            if (this.pageListeners.has(page)) return;
            if (typeof page.on !== "function" || typeof page.removeListener !== "function") {
                this.trackingComplete = false;
                return;
            }
            const listener = (frame: any) => {
                if (typeof page.mainFrame === "function" && frame !== page.mainFrame()) {
                    try {
                        const origin = storageOrigin(frame.url());
                        if (origin && origin !== storageOrigin(page.url())) {
                            this.trackingComplete = false;
                            addStorageIssue(this.state, { area: "recovery", phase: "coverage", code: "third-party-storage-unverified", origin });
                        }
                    } catch { this.trackingComplete = false; }
                    return;
                }
                try { this.observeUrl(frame.url()); } catch { this.trackingComplete = false; }
            };
            page.on("framenavigated", listener);
            this.pageListeners.set(page, listener);
            for (const frame of page.frames?.() ?? []) listener(frame);
        } catch {
            this.trackingComplete = false;
        }
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
                sample = await snapshotBrowserStorage(this.context, { reason }, this.writeState);
            } catch {
                sample = { reason, cookieCount: 0, savedCookieCount: 0, cookies: [], localStorageDomains: [], errors: ["snapshot: unavailable"], capturedAt: new Date().toISOString() };
            }
            for (const origin of sample.observedOrigins ?? []) this.observeUrl(origin);
            this.state = mergeStorageSnapshots(this.state, sample);
            return this.summary();
        });
        return this.queue;
    }

    async stop(reason?: string): Promise<BrowserStorageSnapshotResult> {
        this.stopped = true;
        clearTimeout(this.timer);
        await this.queue;
        if (reason) await this.capture(reason);
        if (this.pageListener) this.context.removeListener("page", this.pageListener);
        for (const [page, listener] of this.pageListeners) page.removeListener("framenavigated", listener);
        this.pageListeners.clear();
        this.pageListener = undefined;
        return this.summary();
    }

    summary(): BrowserStorageSnapshotResult {
        return {
            ...this.state, cookies: this.state.cookies.map(cookie => ({ ...cookie })),
            localStorageDomains: this.state.localStorageDomains.map(entry => ({ ...entry })), errors: [...this.state.errors],
            issues: this.state.issues?.map(issue => ({ ...issue })),
            originEvidence: this.state.originEvidence?.map(entry => ({ ...entry })),
            cookieEvidence: this.state.cookieEvidence ? { ...this.state.cookieEvidence } : undefined,
            observedOrigins: [...this.origins], originTrackingComplete: this.trackingComplete,
        };
    }
}
