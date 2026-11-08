import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export type ToolQueueClass = "light" | "mixed";
export type ToolRequestClass = ToolQueueClass | "auto-background" | "control";

type ReleaseFn = () => void;
type QueuedAcquire = {
    resolve: (release: ReleaseFn | null) => void;
    timer: ReturnType<typeof setTimeout>;
};

export class AsyncSemaphore {
    private active = 0;
    private readonly waiters: QueuedAcquire[] = [];

    constructor(private readonly limit: number) {}

    get activeCount(): number {
        return this.active;
    }

    get pendingCount(): number {
        return this.waiters.length;
    }

    get capacity(): number {
        return this.limit;
    }

    async acquire(timeoutMs: number): Promise<ReleaseFn | null> {
        if (this.limit <= 0) return null;
        if (this.active < this.limit) {
            this.active++;
            return this.releaseOnce();
        }
        return new Promise<ReleaseFn | null>(resolve => {
            const queued: QueuedAcquire = {
                resolve,
                timer: setTimeout(() => {
                    const index = this.waiters.indexOf(queued);
                    if (index >= 0) this.waiters.splice(index, 1);
                    resolve(null);
                }, Math.max(timeoutMs, 1)),
            };
            this.waiters.push(queued);
        });
    }

    private releaseOnce(): ReleaseFn {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.active = Math.max(0, this.active - 1);
            this.drain();
        };
    }

    private drain(): void {
        while (this.waiters.length > 0 && this.active < this.limit) {
            const next = this.waiters.shift()!;
            clearTimeout(next.timer);
            this.active++;
            next.resolve(this.releaseOnce());
        }
    }
}

export interface ToolConcurrencyOptions<T> {
    timeoutMs?: number;
    bypass?: boolean;
    onBusy?: (message: string) => T | Promise<T>;
    onQuota?: (state: { waitMs: number; limit: number; activeBefore: number; pendingBefore: number; acquired: boolean }) => void;
}

const bypassStorage = new AsyncLocalStorage<boolean>();
const requestStorage = new AsyncLocalStorage<{ deadlineAt?: number; signal?: AbortSignal }>();
let semaphores: Partial<Record<ToolQueueClass, AsyncSemaphore>> = {};

export function currentToolRequestControl(): { deadlineAt?: number; signal?: AbortSignal } {
    return requestStorage.getStore() || {};
}

function envLimit(names: string | string[], fallback: number): number {
    for (const name of Array.isArray(names) ? names : [names]) {
        const value = Number(process.env[name]);
        if (Number.isFinite(value) && value > 0) return Math.floor(value);
    }
    return fallback;
}

function queueLimit(queueClass: ToolQueueClass): number {
    if (queueClass === "light") return envLimit(["MEMORY_STORE_TOOL_LIGHT_LIMIT", "MEMORY_STORE_LIGHT_CONCURRENCY"], 8);
    return envLimit(["MEMORY_STORE_TOOL_MIXED_LIMIT", "MEMORY_STORE_MIXED_CONCURRENCY"], 6);
}

export function defaultToolQueueTimeoutMs(): number {
    return envLimit(["MEMORY_STORE_TOOL_QUEUE_TIMEOUT_MS", "MEMORY_STORE_QUEUE_TIMEOUT_MS"], 30_000);
}

function semaphoreFor(queueClass: ToolQueueClass): AsyncSemaphore {
    const existing = semaphores[queueClass];
    if (existing) return existing;
    const created = new AsyncSemaphore(queueLimit(queueClass));
    semaphores[queueClass] = created;
    return created;
}

export function resetToolConcurrencyForTest(): void {
    semaphores = {};
}

export function isToolConcurrencyBypassed(): boolean {
    return bypassStorage.getStore() === true;
}

export async function runWithoutToolConcurrency<T>(fn: () => Promise<T> | T): Promise<T> {
    return bypassStorage.run(true, () => requestStorage.run({}, async () => fn()));
}

export function formatBusyMessage(queueClass: ToolQueueClass, label: string, timeoutMs = defaultToolQueueTimeoutMs()): string {
    return [
        `⚠️ busy: ${label} 排队超过 ${Math.ceil(timeoutMs / 1000)}s，当前 ${queueClass} 队列繁忙`,
        "retry later：请稍后重试，或缩小本次请求范围。",
    ].join("\n");
}

export function toolConcurrencyBusyResponse(message: string) {
    return { content: [{ type: "text" as const, text: message }] };
}

export async function withToolConcurrency<T>(
    queueClass: ToolQueueClass,
    label: string,
    fn: () => Promise<T> | T,
    options: ToolConcurrencyOptions<T> = {},
): Promise<T> {
    if (options.bypass || isToolConcurrencyBypassed()) return fn();
    const timeoutMs = options.timeoutMs ?? defaultToolQueueTimeoutMs();
    const semaphore = semaphoreFor(queueClass);
    const activeBefore = semaphore.activeCount;
    const pendingBefore = semaphore.pendingCount;
    const acquireStarted = performance.now();
    const release = await semaphore.acquire(timeoutMs);
    options.onQuota?.({ waitMs: performance.now() - acquireStarted, limit: semaphore.capacity, activeBefore, pendingBefore, acquired: release !== null });
    if (!release) {
        const message = formatBusyMessage(queueClass, label, timeoutMs);
        if (options.onBusy) return options.onBusy(message);
        throw new Error(message);
    }
    try {
        return await fn();
    } finally {
        release();
    }
}

export function classifyToolRequest(name: string, args: Record<string, unknown> = {}): ToolRequestClass {
    if (name === "background_task_status" || name === "background_task_cancel") return "control";
    if (name === "memory_read" || name === "memory_delete") return "light";
    if (name === "memory_write" || name === "memory_update" || name === "memory_batch") return "mixed";
    if (name === "memory_stats") return args.action === "enhance" ? "mixed" : "light";
    if (name === "memory_query") {
        const mode = typeof args.mode === "string" ? args.mode : "auto";
        return args.query && (mode === "auto" || mode === "smart") ? "mixed" : "light";
    }
    if (name === "record_manage") {
        const action = typeof args.action === "string" ? args.action : "";
        if (action === "task_status" || action === "cancel") return "control";
        if (action === "update" || action === "batch_update" || action === "bulk_update") return "auto-background";
        if (action === "search" || action === "guide") return "mixed";
        return "light";
    }
    if (name === "conversation_golden_extract") return args.taskId ? "control" : "auto-background";
    if (name === "stage_guard") return args.action === "status" || args.action === "cancel" || (args.action === "check" && args.taskId) ? "control" : args.action === "check" ? "mixed" : "light";
    if (name === "conversation_read_original") {
        if (["prepare_status", "prepare_cancel", "search_all_status", "search_all_cancel", "deep_locate_status", "deep_locate_cancel"].includes(String(args.action))) return "control";
        if (args.action === "deep_locate") return "auto-background";
        if (args.action === "deep_locate_status" || args.action === "deep_locate_cancel") return "light";
        if (args.action === "export" && args.exportBatch === true) return "auto-background";
        return "mixed";
    }
    return "mixed";
}

export function backgroundTaskQueueClass(kind: string): "background" | null {
    if (kind === "record-update") return "background";
    if (kind === "record-batch-update") return "background";
    if (kind === "stage-guard-check") return "background";
    if (kind === "golden-extract") return "background";
    if (kind === "conversation-deep-locate") return "background";
    if (kind === "conversation-batch-export") return "background";
    if (kind === "record-guide") return "background";
    return null;
}

export function installToolConcurrency(server: { tool: (...args: any[]) => unknown }): void {
    const originalTool = server.tool.bind(server);
    server.tool = (name: string, description: string, schema: unknown, handler: (args: any, extra?: unknown) => unknown) => {
        const wrapped = async (args: Record<string, unknown> = {}, extra?: unknown) => {
            const receivedAt = new Date().toISOString();
            const started = performance.now();
            const requestId = randomUUID();
            const queueClass = classifyToolRequest(name, args);
            const action = typeof args.action === "string" ? `.${args.action}` : "";
            let quota: Parameters<NonNullable<ToolConcurrencyOptions<unknown>["onQuota"]>>[0] | null = null;
            let handlerMs = 0;
            let handlerStarted = false;
            const invoke = async () => {
                handlerStarted = true;
                const handlerStart = performance.now();
                try {
                    return await handler(args, extra);
                } finally {
                    handlerMs = performance.now() - handlerStart;
                }
            };
            const inheritedBypass = isToolConcurrencyBypassed();
            let result: unknown;
            if (queueClass === "auto-background" || queueClass === "control") {
                result = await invoke();
            } else {
                const requested = Number(args.deadlineMs);
                const fallback = name === "conversation_read_original" ? args.action === "list" ? 12_000 : args.action === "read_fast" ? 30_000 : 120_000 : undefined;
                const timeoutMs = Number.isFinite(requested) && requested > 0 ? requested : fallback;
                const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
                result = await requestStorage.run({ deadlineAt: timeoutMs === undefined ? undefined : Date.now() + timeoutMs, signal }, () => withToolConcurrency(
                    queueClass,
                    `${name}${action}`,
                    invoke,
                    {
                        onBusy: toolConcurrencyBusyResponse,
                        timeoutMs: Math.min(timeoutMs ?? Infinity, defaultToolQueueTimeoutMs()),
                        onQuota: state => { quota = state; },
                    },
                ));
            }
            if (!result || typeof result !== "object" || Array.isArray(result)) return result;
            const response = result as Record<string, unknown>;
            const metadata = response._meta && typeof response._meta === "object" && !Array.isArray(response._meta) ? response._meta as Record<string, unknown> : {};
            return {
                ...response,
                _meta: {
                    ...metadata,
                    "memory-store/toolTiming": {
                        version: 1, requestId, tool: name, requestClass: queueClass, processId: process.pid,
                        receivedAt, completedAt: new Date().toISOString(), quota, handlerStarted, handlerMs,
                        bypass: queueClass === "control" || queueClass === "auto-background" ? queueClass : inheritedBypass ? "inherited" : null,
                        totalMs: performance.now() - started,
                    },
                },
            };
        };
        return originalTool(name, description, schema, wrapped);
    };
}
