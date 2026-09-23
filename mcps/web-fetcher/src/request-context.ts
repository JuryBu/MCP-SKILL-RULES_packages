import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { PageAccessIssue } from './page-access.js';

export interface RequestContext {
    humanAssistance?: 'auto' | 'never';
    pageAccessIssue?: PageAccessIssue;
    ownerId: string;
    toolName: string;
    intent: string;
    signal?: AbortSignal;
    viewport?: { width: number; height: number };
    startedAt: number;
    deadline: number;
    timings: Array<{ stage: string; durationMs: number; failed: boolean }>;
    leasedPages: Set<object>;
    finalizers: Array<() => void | Promise<void>>;
}

export interface RequestOptions {
    humanAssistance?: 'auto' | 'never';
    ownerId?: string;
    toolName?: string;
    intent?: string;
    signal?: AbortSignal;
    viewport?: { width: number; height: number };
    timeoutMs?: number;
    deadline?: number;
}

export class RequestAdmissionError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
        this.name = "RequestAdmissionError";
    }
}

const requestStorage = new AsyncLocalStorage<RequestContext>();
let activeRequests = 0;

export function getActiveRequestCount(): number { return activeRequests; }

export function getRequestContext(): RequestContext | undefined {
    return requestStorage.getStore();
}

export async function runWithRequestContext<Result>(options: RequestOptions, handler: () => Promise<Result>): Promise<Result> {
    const startedAt = performance.now();
    const context: RequestContext = {
        humanAssistance: options.humanAssistance,
        ownerId: options.ownerId?.trim() || "global",
        toolName: options.toolName || "unknown",
        intent: options.intent || "operation",
        signal: options.signal,
        viewport: options.viewport,
        startedAt,
        deadline: options.deadline ?? startedAt + (options.timeoutMs ?? 120_000),
        timings: [],
        leasedPages: new Set(),
        finalizers: [],
    };
    return requestStorage.run(context, async () => {
        activeRequests++;
        try {
            return await handler();
        } finally {
            let cleanupError: unknown;
            for (const finalize of context.finalizers.reverse()) {
                try { await finalize(); }
                catch (error) { cleanupError ??= error; }
            }
            context.leasedPages.clear();
            activeRequests--;
            if (cleanupError) throw cleanupError;
        }
    });
}

export function remainingRequestMs(fallback = 30_000): number {
    const context = getRequestContext();
    return context ? Math.max(0, context.deadline - performance.now()) : fallback;
}

export function throwIfRequestExpired(): void {
    const context = getRequestContext();
    if (context?.signal?.aborted) throw new RequestAdmissionError("request_cancelled", "请求已取消，未开始后续操作");
    if (context && remainingRequestMs() <= 0) throw new RequestAdmissionError("request_deadline_exceeded", "请求总期限已到，未开始后续操作");
}

export function extendRequestDeadline(durationMs: number): void {
    const context = getRequestContext();
    if (context && Number.isFinite(durationMs) && durationMs > 0) {
        context.deadline = Math.max(context.deadline, performance.now() + durationMs);
    }
}

export async function withSuspendedRequestDeadline<Result>(handler: () => Promise<Result>, manualBudgetMs = 600_000): Promise<Result> {
    const context = getRequestContext();
    if (!context) return handler();
    const startedAt = performance.now();
    const previousDeadline = context.deadline;
    const budget = Math.max(0, Math.min(manualBudgetMs, 600_000));
    extendRequestDeadline(budget);
    try { return await handler(); }
    finally { context.deadline = previousDeadline + Math.min(performance.now() - startedAt, budget); }
}

export async function withRequestStage<Result>(stage: string, handler: () => Promise<Result>): Promise<Result> {
    const context = getRequestContext();
    const startedAt = performance.now();
    let failed = true;
    try {
        const result = await handler();
        failed = false;
        return result;
    } finally {
        context?.timings.push({ stage, durationMs: performance.now() - startedAt, failed });
    }
}

export interface AdmissionOptions {
    ownerId?: string;
    signal?: AbortSignal;
    deadline?: number;
    queueTimeoutMs?: number;
}

interface Waiter {
    ownerId: string;
    signal?: AbortSignal;
    deadline: number;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
    abort?: () => void;
}

export class OperationGate {
    private active = 0;
    private queue: Waiter[] = [];
    private lastOwner = "";

    constructor(readonly limit: number, readonly maxQueue = 64, readonly name = "operation") {
        if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(maxQueue) || maxQueue < 0) {
            throw new Error("操作并发和排队上限必须是有效整数");
        }
    }

    getStats() { return { active: this.active, queued: this.queue.length, limit: this.limit, maxQueue: this.maxQueue }; }

    acquire(options: AdmissionOptions = {}): Promise<() => void> {
        const deadline = Math.min(options.deadline ?? Infinity, performance.now() + (options.queueTimeoutMs ?? 30_000));
        if (options.signal?.aborted) return Promise.reject(this.error("request_cancelled"));
        if (deadline <= performance.now()) return Promise.reject(this.error("admission_timeout"));
        if (this.active < this.limit && this.queue.length === 0) {
            this.lastOwner = options.ownerId || "global";
            return Promise.resolve(this.grant());
        }
        if (this.queue.length >= this.maxQueue) return Promise.reject(this.error("queue_full"));
        return new Promise((resolve, reject) => {
            const waiter: Waiter = { ownerId: options.ownerId || "global", signal: options.signal, deadline, resolve, reject };
            waiter.abort = () => this.remove(waiter, this.error("request_cancelled"));
            waiter.timer = setTimeout(() => this.remove(waiter, this.error("admission_timeout")), Math.max(1, deadline - performance.now()));
            this.queue.push(waiter);
            options.signal?.addEventListener("abort", waiter.abort, { once: true });
            if (options.signal?.aborted) waiter.abort();
        });
    }

    private error(code: string): RequestAdmissionError {
        return new RequestAdmissionError(code, `${this.name}: ${code}，操作尚未开始，请先核对队列/会话状态，不自动重放`);
    }

    private cleanup(waiter: Waiter): void {
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
    }

    private remove(waiter: Waiter, error: Error): void {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1);
        this.cleanup(waiter);
        waiter.reject(error);
        this.pump();
    }

    private grant(): () => void {
        this.active++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.active--;
            this.pump();
        };
    }

    private pump(): void {
        while (this.active < this.limit && this.queue.length > 0) {
            const otherOwner = this.queue.findIndex(waiter => waiter.ownerId !== this.lastOwner);
            const [waiter] = this.queue.splice(otherOwner < 0 ? 0 : otherOwner, 1);
            this.cleanup(waiter);
            if (waiter.signal?.aborted || waiter.deadline <= performance.now()) {
                waiter.reject(this.error(waiter.signal?.aborted ? "request_cancelled" : "admission_timeout"));
                continue;
            }
            this.lastOwner = waiter.ownerId;
            waiter.resolve(this.grant());
        }
    }
}
