import { AsyncLocalStorage } from "node:async_hooks";

export type ToolQueueClass = "light" | "mixed" | "heavy";

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
}

const bypassStorage = new AsyncLocalStorage<boolean>();
let semaphores: Partial<Record<ToolQueueClass, AsyncSemaphore>> = {};

function envLimit(names: string | string[], fallback: number): number {
    for (const name of Array.isArray(names) ? names : [names]) {
        const value = Number(process.env[name]);
        if (Number.isFinite(value) && value > 0) return Math.floor(value);
    }
    return fallback;
}

function queueLimit(queueClass: ToolQueueClass): number {
    if (queueClass === "light") return envLimit(["MEMORY_STORE_TOOL_LIGHT_LIMIT", "MEMORY_STORE_LIGHT_CONCURRENCY"], 8);
    if (queueClass === "mixed") return envLimit(["MEMORY_STORE_TOOL_MIXED_LIMIT", "MEMORY_STORE_MIXED_CONCURRENCY"], 6);
    return envLimit(["MEMORY_STORE_TOOL_HEAVY_LIMIT", "MEMORY_STORE_HEAVY_CONCURRENCY"], 3);
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
    return bypassStorage.run(true, async () => fn());
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
    const release = await semaphoreFor(queueClass).acquire(timeoutMs);
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

export function classifyToolRequest(name: string, args: Record<string, unknown> = {}): ToolQueueClass {
    if (name === "memory_read" || name === "memory_delete") return "light";
    if (name === "memory_write" || name === "memory_update" || name === "memory_batch") return "mixed";
    if (name === "memory_stats") return args.action === "enhance" ? "heavy" : "light";
    if (name === "memory_query") {
        const mode = typeof args.mode === "string" ? args.mode : "auto";
        return args.query && (mode === "auto" || mode === "smart") ? "mixed" : "light";
    }
    if (name === "record_manage") {
        const action = typeof args.action === "string" ? args.action : "";
        if (action === "update" || action === "batch_update" || action === "bulk_update") return "heavy";
        if (action === "search" || action === "guide") return "mixed";
        return "light";
    }
    if (name === "conversation_golden_extract") return args.taskId ? "light" : "heavy";
    if (name === "stage_guard") return args.action === "check" && !args.taskId ? "heavy" : "light";
    if (name === "conversation_read_original") {
        if (args.action === "deep_locate") return "heavy";
        if (args.action === "deep_locate_status" || args.action === "deep_locate_cancel") return "light";
        if (args.action === "export" && (args.exportBatch === true || args.exportFormat === "pdf" || args.exportFormat === "both")) return "heavy";
        if ((args.dataChain === "claude-code" || args.dataChain === "cc" || args.dataChain === "windsurf" || args.dataChain === "wsf") && args.query) return "heavy";
        return "mixed";
    }
    return "mixed";
}

export function backgroundTaskQueueClass(kind: string): ToolQueueClass | null {
    if (kind === "record-update") return "heavy";
    if (kind === "stage-guard-check") return "heavy";
    if (kind === "golden-extract") return "heavy";
    if (kind === "conversation-deep-locate") return "heavy";
    if (kind === "record-guide") return "mixed";
    return null;
}

export function installToolConcurrency(server: { tool: (...args: any[]) => unknown }): void {
    const originalTool = server.tool.bind(server);
    server.tool = (name: string, description: string, schema: unknown, handler: (args: any, extra?: unknown) => unknown) => {
        const wrapped = async (args: Record<string, unknown> = {}, extra?: unknown) => {
            const queueClass = classifyToolRequest(name, args);
            const action = typeof args.action === "string" ? `.${args.action}` : "";
            return withToolConcurrency(
                queueClass,
                `${name}${action}`,
                () => handler(args, extra),
                { onBusy: toolConcurrencyBusyResponse },
            );
        };
        return originalTool(name, description, schema, wrapped);
    };
}
