import { AdaptiveConcurrencyGate } from "./adaptive-concurrency.js";
import type { CallOutcome } from "./call-outcome.js";
import { FifoConcurrencyGate, type ConcurrencyGatePermit } from "./concurrency-gate.js";

export type GrokContext = "default" | "record" | "guard";
export type GrokTrafficClass = "foreground" | "record-batch";
export type GrokTimeoutKind = "batch_queue" | "global_queue" | "transport";

export interface GrokExecDiagnostics {
    concurrencyScope: "process";
    context: GrokContext;
    active: number;
    pending: number;
    limit: number;
    current: number;
    max: number;
    min: number;
    successes: number;
    failures: number;
    queueWaitMs: number;
    batchQueueWaitMs: number;
    globalQueueWaitMs: number;
    queueAttempts: number;
    trafficClass: GrokTrafficClass;
    pid: number;
    globalActive: number;
    globalPending: number;
    globalLimit: number;
    timeoutKind?: GrokTimeoutKind;
    batchActive: number;
    batchPending: number;
    batchLimit: number;
}

export interface GrokExecResult {
    text: string | null;
    error?: string;
    timedOut?: boolean;
    timeoutKind?: GrokTimeoutKind;
    cancelled?: boolean;
    status?: number;
    finishReason?: string;
    diagnostics?: GrokExecDiagnostics;
}

export interface GrokExecOptions {
    context?: GrokContext;
    trafficClass?: GrokTrafficClass;
    queueTimeoutMs?: number;
    queueRetryLimit?: number;
    queueRetryBackoffMs?: number;
    shouldCancel?: () => boolean;
    signal?: AbortSignal;
}

type JsonParseResult<T> =
    | { type: "parsed"; value: T }
    | { type: "malformed"; error: unknown };

const DEFAULT_GROK_PROXY_URL = "http://127.0.0.1:18645";
const DEFAULT_GROK_API_KEY = "grok-local-proxy";
const DEFAULT_GROK_MODEL = "grok-4.20-0309-non-reasoning";
const DEFAULT_GROK_RECORD_MODEL = "grok-4.3";
const DEFAULT_GROK_GUARD_MODEL = "grok-4.5";
const DEFAULT_GROK_MAX_TOKENS = 800;
const DEFAULT_GROK_RECORD_MAX_TOKENS = 8192;
const DEFAULT_GROK_GUARD_MAX_TOKENS = 4096;
const DEFAULT_GROK_CALL_CONCURRENCY = 8;
const INITIAL_GROK_CALL_CONCURRENCY = 2;
const DEFAULT_GROK_BATCH_CONCURRENCY = 4;
const DEFAULT_GROK_FOREGROUND_RESERVED_SLOTS = 1;
const DEFAULT_GROK_QUEUE_TIMEOUT_MS = 30_000;
const DEFAULT_GROK_QUEUE_RETRY_LIMIT = 1;
const DEFAULT_GROK_QUEUE_RETRY_BACKOFF_MS = 100;
const GROK_STATUS_TTL_MS = 60_000;
const GROK_STATUS_TIMEOUT_MS = 3_000;
const GROK_CALL_CANCEL_MESSAGE = "Grok 模型桥调用已取消";
const GROK_CALL_QUEUE_TIMEOUT_MESSAGE = "Grok 模型桥排队超时";
const GROK_BATCH_QUEUE_TIMEOUT_MESSAGE = "Grok batch 准入排队超时";
const GROK_GLOBAL_QUEUE_TIMEOUT_MESSAGE = "Grok 全局队列排队超时";
const GROK_CALL_TIMEOUT_MESSAGE = "Grok 模型桥超时";
const GROK_CALL_POLL_MS = 25;

let grokAvailableCache: boolean | null = null;
let grokAvailableAt = 0;
let grokCallAdaptiveGate: { max: number; gate: AdaptiveConcurrencyGate } | null = null;
const grokCallGate = new FifoConcurrencyGate(
    () => getGrokCallAdaptiveGate().limit,
    { reservedSlots: () => readNonNegativeIntEnv("MEMORY_STORE_GROK_FOREGROUND_RESERVED_SLOTS", DEFAULT_GROK_FOREGROUND_RESERVED_SLOTS) },
);
const grokBatchAdmissionGate = new FifoConcurrencyGate(
    () => readPositiveIntEnv("MEMORY_STORE_GROK_BATCH_CONCURRENCY", DEFAULT_GROK_BATCH_CONCURRENCY),
);

function grokProxyUrl(): string {
    return (process.env.MEMORY_STORE_GROK_PROXY_URL || DEFAULT_GROK_PROXY_URL).replace(/\/+$/u, "");
}

function grokApiKey(): string {
    return process.env.MEMORY_STORE_GROK_API_KEY || DEFAULT_GROK_API_KEY;
}

function readPositiveIntEnv(name: string, fallback: number): number {
    const value = Math.floor(Number(process.env[name] || ""));
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readNonNegativeIntEnv(name: string, fallback: number): number {
    const value = Math.floor(Number(process.env[name] || ""));
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseJsonBody<T>(body: string): JsonParseResult<T> {
    try {
        return { type: "parsed", value: JSON.parse(body) as T };
    } catch (error) {
        return { type: "malformed", error };
    }
}

function getGrokCallAdaptiveGate(): AdaptiveConcurrencyGate {
    const max = readPositiveIntEnv("MEMORY_STORE_GROK_CALL_CONCURRENCY", DEFAULT_GROK_CALL_CONCURRENCY);
    if (!grokCallAdaptiveGate || grokCallAdaptiveGate.max !== max) {
        grokCallAdaptiveGate = {
            max,
            gate: new AdaptiveConcurrencyGate(max, 1, INITIAL_GROK_CALL_CONCURRENCY),
        };
    }
    return grokCallAdaptiveGate.gate;
}

function getGrokBatchAdmissionGate(): FifoConcurrencyGate {
    return grokBatchAdmissionGate;
}

function normalizeExecOptions(options?: GrokContext | GrokExecOptions): GrokExecOptions {
    return typeof options === "string" ? { context: options } : (options || {});
}

function safeShouldCancel(options: GrokExecOptions): boolean {
    if (options.signal?.aborted) return true;
    try {
        return options.shouldCancel?.() === true;
    } catch {
        return true;
    }
}

function resolveDeadline(timeoutMs: number): number {
    const safeTimeout = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
    return Date.now() + safeTimeout;
}

type GrokQueueMetrics = {
    batchQueueWaitMs: number;
    globalQueueWaitMs: number;
    queueAttempts: number;
    timeoutKind?: GrokTimeoutKind;
};

function buildDiagnostics(
    context: GrokContext,
    trafficClass: GrokTrafficClass,
    queue: GrokQueueMetrics,
    adaptiveGate: AdaptiveConcurrencyGate,
): GrokExecDiagnostics {
    const concurrency = grokCallGate.stats();
    const batch = getGrokBatchAdmissionGate().stats();
    const adaptive = adaptiveGate.snapshot();
    return {
        concurrencyScope: "process",
        context,
        active: concurrency.active,
        pending: concurrency.pending,
        limit: adaptive.current,
        current: adaptive.current,
        max: adaptive.max,
        min: adaptive.min,
        successes: adaptive.successes,
        failures: adaptive.failures,
        queueWaitMs: queue.batchQueueWaitMs + queue.globalQueueWaitMs,
        batchQueueWaitMs: queue.batchQueueWaitMs,
        globalQueueWaitMs: queue.globalQueueWaitMs,
        queueAttempts: queue.queueAttempts,
        trafficClass,
        pid: process.pid,
        globalActive: concurrency.active,
        globalPending: concurrency.pending,
        globalLimit: adaptive.current,
        ...(queue.timeoutKind ? { timeoutKind: queue.timeoutKind } : {}),
        batchActive: batch.active,
        batchPending: batch.pending,
        batchLimit: batch.limit,
    };
}

function timeoutResult(
    context: GrokContext,
    trafficClass: GrokTrafficClass,
    queue: GrokQueueMetrics,
    adaptiveGate: AdaptiveConcurrencyGate,
    timeoutKind: GrokTimeoutKind,
    error = GROK_CALL_TIMEOUT_MESSAGE,
): GrokExecResult {
    const metrics = { ...queue, timeoutKind };
    return { text: null, error, timedOut: true, timeoutKind, diagnostics: buildDiagnostics(context, trafficClass, metrics, adaptiveGate) };
}

function cancelledResult(
    context: GrokContext,
    trafficClass: GrokTrafficClass,
    queue: GrokQueueMetrics,
    adaptiveGate: AdaptiveConcurrencyGate,
    error = GROK_CALL_CANCEL_MESSAGE,
): GrokExecResult {
    return { text: null, error, cancelled: true, diagnostics: buildDiagnostics(context, trafficClass, queue, adaptiveGate) };
}

function recordTransportOutcome(outcome: CallOutcome, adaptiveGate: AdaptiveConcurrencyGate): void {
    if (outcome.success) {
        if (adaptiveGate.onSuccess()) grokCallGate.notifyCapacityIncrease();
        return;
    }
    if (
        outcome.errorKind === "rate_limit"
        || outcome.errorKind === "server_error"
        || outcome.errorKind === "timeout"
        || outcome.errorKind === "network"
    ) {
        adaptiveGate.onFailure();
    }
}

function createFetchAbortController(timeoutMs: number, options: GrokExecOptions): {
    signal: AbortSignal;
    getReason: () => "timeout" | "cancel" | null;
    cleanup: () => void;
} {
    const controller = new AbortController();
    let reason: "timeout" | "cancel" | null = null;
    const abort = (nextReason: "timeout" | "cancel", message: string) => {
        if (controller.signal.aborted) return;
        reason = nextReason;
        controller.abort(new Error(message));
    };

    const timeoutTimer = setTimeout(() => abort("timeout", GROK_CALL_TIMEOUT_MESSAGE), timeoutMs);
    timeoutTimer.unref?.();

    const cancelTimer = setInterval(() => {
        if (safeShouldCancel(options)) {
            abort("cancel", GROK_CALL_CANCEL_MESSAGE);
        }
    }, GROK_CALL_POLL_MS);
    cancelTimer.unref?.();

    let detachSignalAbort: (() => void) | undefined;
    if (options.signal) {
        if (options.signal.aborted) {
            abort("cancel", GROK_CALL_CANCEL_MESSAGE);
        } else {
            const onAbort = () => abort("cancel", GROK_CALL_CANCEL_MESSAGE);
            options.signal.addEventListener("abort", onAbort, { once: true });
            detachSignalAbort = () => options.signal?.removeEventListener("abort", onAbort);
        }
    }

    return {
        signal: controller.signal,
        getReason: () => reason,
        cleanup: () => {
            clearTimeout(timeoutTimer);
            clearInterval(cancelTimer);
            detachSignalAbort?.();
        },
    };
}

function resolveQueueTimeoutMs(options: GrokExecOptions, trafficClass: GrokTrafficClass, timeoutMs: number): number {
    if (Number.isFinite(options.queueTimeoutMs) && Number(options.queueTimeoutMs) >= 0) {
        return Math.floor(Number(options.queueTimeoutMs));
    }
    if (trafficClass === "record-batch") {
        return readPositiveIntEnv("MEMORY_STORE_GROK_QUEUE_TIMEOUT_MS", DEFAULT_GROK_QUEUE_TIMEOUT_MS);
    }
    return Number.isFinite(timeoutMs) ? Math.max(0, Math.floor(timeoutMs)) : 0;
}

function resolveQueueRetryLimit(options: GrokExecOptions, trafficClass: GrokTrafficClass): number {
    if (trafficClass !== "record-batch") return 0;
    if (Number.isFinite(options.queueRetryLimit) && Number(options.queueRetryLimit) >= 0) {
        return Math.min(1, Math.floor(Number(options.queueRetryLimit)));
    }
    return Math.min(1, readNonNegativeIntEnv("MEMORY_STORE_GROK_QUEUE_RETRY_LIMIT", DEFAULT_GROK_QUEUE_RETRY_LIMIT));
}

function resolveQueueRetryBackoffMs(options: GrokExecOptions): number {
    if (Number.isFinite(options.queueRetryBackoffMs) && Number(options.queueRetryBackoffMs) >= 0) {
        return Math.floor(Number(options.queueRetryBackoffMs));
    }
    return readNonNegativeIntEnv("MEMORY_STORE_GROK_QUEUE_RETRY_BACKOFF_MS", DEFAULT_GROK_QUEUE_RETRY_BACKOFF_MS);
}

async function waitForQueueRetry(
    delayMs: number,
    logicalDeadlineAt: number,
    options: GrokExecOptions,
): Promise<"ready" | "cancelled" | "deadline"> {
    const targetAt = Math.min(logicalDeadlineAt, Date.now() + Math.max(0, delayMs));
    while (Date.now() < targetAt) {
        if (safeShouldCancel(options)) return "cancelled";
        await new Promise(resolve => setTimeout(resolve, Math.min(GROK_CALL_POLL_MS, Math.max(1, targetAt - Date.now()))));
    }
    if (safeShouldCancel(options)) return "cancelled";
    return Date.now() >= logicalDeadlineAt ? "deadline" : "ready";
}

export function mapGrokModel(model: string, context: GrokContext = "default"): string {
    if (context === "record") return process.env.MEMORY_STORE_GROK_RECORD_MODEL || DEFAULT_GROK_RECORD_MODEL;
    if (context === "guard") return process.env.MEMORY_STORE_GROK_GUARD_MODEL || DEFAULT_GROK_GUARD_MODEL;
    if (process.env.MEMORY_STORE_GROK_MODEL) return process.env.MEMORY_STORE_GROK_MODEL;
    if (/^grok-/iu.test(model)) return model;
    return DEFAULT_GROK_MODEL;
}

export function mapGrokMaxTokens(context: GrokContext = "default"): number {
    if (context === "record") return readPositiveIntEnv("MEMORY_STORE_GROK_RECORD_MAX_TOKENS", DEFAULT_GROK_RECORD_MAX_TOKENS);
    if (context === "guard") return readPositiveIntEnv("MEMORY_STORE_GROK_GUARD_MAX_TOKENS", DEFAULT_GROK_GUARD_MAX_TOKENS);
    return readPositiveIntEnv("MEMORY_STORE_GROK_MAX_TOKENS", DEFAULT_GROK_MAX_TOKENS);
}

export async function callGrokExec(
    prompt: string,
    model: string,
    timeoutMs: number,
    maxTokens = DEFAULT_GROK_MAX_TOKENS,
    options?: GrokContext | GrokExecOptions,
): Promise<GrokExecResult> {
    const execOptions = normalizeExecOptions(options);
    const context = execOptions.context || "default";
    const trafficClass = execOptions.trafficClass || "foreground";
    const logicalDeadlineAt = resolveDeadline(timeoutMs);
    const adaptiveGate = getGrokCallAdaptiveGate();
    const queueTimeoutMs = resolveQueueTimeoutMs(execOptions, trafficClass, timeoutMs);
    const queueRetryLimit = resolveQueueRetryLimit(execOptions, trafficClass);
    const queueRetryBackoffMs = resolveQueueRetryBackoffMs(execOptions);
    const queue: GrokQueueMetrics = {
        batchQueueWaitMs: 0,
        globalQueueWaitMs: 0,
        queueAttempts: 0,
    };

    if (safeShouldCancel(execOptions)) {
        return cancelledResult(context, trafficClass, queue, adaptiveGate);
    }

    let batchPermit: ConcurrencyGatePermit | null = null;
    let permit: ConcurrencyGatePermit | null = null;
    for (let attempt = 0; ; attempt++) {
        queue.queueAttempts = attempt + 1;
        const attemptDeadlineAt = Math.min(logicalDeadlineAt, Date.now() + queueTimeoutMs);
        let queueTimeoutKind: Exclude<GrokTimeoutKind, "transport"> | null = null;

        if (trafficClass === "record-batch") {
            const batchWaitStartedAt = Date.now();
            try {
                batchPermit = await getGrokBatchAdmissionGate().acquire({
                    deadlineAt: attemptDeadlineAt,
                    shouldCancel: () => safeShouldCancel(execOptions),
                    cancelMessage: GROK_CALL_CANCEL_MESSAGE,
                    timeoutMessage: GROK_BATCH_QUEUE_TIMEOUT_MESSAGE,
                    requestClass: "background",
                });
                queue.batchQueueWaitMs += batchPermit.queueWaitMs;
                if (Date.now() >= attemptDeadlineAt) {
                    batchPermit.release();
                    batchPermit = null;
                    queueTimeoutKind = "batch_queue";
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                queue.batchQueueWaitMs += Math.max(0, Date.now() - batchWaitStartedAt);
                if (message === GROK_CALL_CANCEL_MESSAGE || safeShouldCancel(execOptions)) {
                    return cancelledResult(context, trafficClass, queue, adaptiveGate);
                }
                if (message === GROK_BATCH_QUEUE_TIMEOUT_MESSAGE) {
                    queueTimeoutKind = "batch_queue";
                } else {
                    return {
                        text: null,
                        error: `Grok 模型桥调用失败: ${message}`,
                        diagnostics: buildDiagnostics(context, trafficClass, queue, adaptiveGate),
                    };
                }
            }
        }

        if (!queueTimeoutKind) {
            const globalWaitStartedAt = Date.now();
            try {
                permit = await grokCallGate.acquire({
                    deadlineAt: attemptDeadlineAt,
                    shouldCancel: () => safeShouldCancel(execOptions),
                    cancelMessage: GROK_CALL_CANCEL_MESSAGE,
                    timeoutMessage: GROK_GLOBAL_QUEUE_TIMEOUT_MESSAGE,
                    requestClass: trafficClass === "record-batch" ? "background" : "foreground",
                });
                queue.globalQueueWaitMs += permit.queueWaitMs;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                queue.globalQueueWaitMs += Math.max(0, Date.now() - globalWaitStartedAt);
                batchPermit?.release();
                batchPermit = null;
                if (message === GROK_CALL_CANCEL_MESSAGE || safeShouldCancel(execOptions)) {
                    return cancelledResult(context, trafficClass, queue, adaptiveGate);
                }
                if (message === GROK_GLOBAL_QUEUE_TIMEOUT_MESSAGE) {
                    adaptiveGate.onFailure();
                    queueTimeoutKind = "global_queue";
                } else {
                    return {
                        text: null,
                        error: `Grok 模型桥调用失败: ${message}`,
                        diagnostics: buildDiagnostics(context, trafficClass, queue, adaptiveGate),
                    };
                }
            }
        }

        if (!queueTimeoutKind && permit) break;

        permit?.release();
        permit = null;
        batchPermit?.release();
        batchPermit = null;
        const canRetry = attempt < queueRetryLimit && Date.now() < logicalDeadlineAt;
        if (!canRetry) {
            return timeoutResult(
                context,
                trafficClass,
                queue,
                adaptiveGate,
                queueTimeoutKind || "global_queue",
                `${GROK_CALL_QUEUE_TIMEOUT_MESSAGE} (${queueTimeoutKind || "global_queue"})`,
            );
        }
        const retryWait = await waitForQueueRetry(queueRetryBackoffMs, logicalDeadlineAt, execOptions);
        if (retryWait === "cancelled") {
            return cancelledResult(context, trafficClass, queue, adaptiveGate);
        }
        if (retryWait === "deadline") {
            return timeoutResult(
                context,
                trafficClass,
                queue,
                adaptiveGate,
                queueTimeoutKind || "global_queue",
                `${GROK_CALL_QUEUE_TIMEOUT_MESSAGE}（重试前总预算不足）`,
            );
        }
    }

    let fetchAbortReason: "timeout" | "cancel" | null = null;
    let fetchStarted = false;
    let receivedResponse = false;
    let bodyComplete = false;
    const finishTransport = (
        result: Omit<GrokExecResult, "diagnostics">,
        outcome: CallOutcome,
        timeoutKind?: GrokTimeoutKind,
    ): GrokExecResult => {
        recordTransportOutcome(outcome, adaptiveGate);
        const metrics = timeoutKind ? { ...queue, timeoutKind } : queue;
        return {
            ...result,
            ...(timeoutKind ? { timeoutKind } : {}),
            diagnostics: buildDiagnostics(context, trafficClass, metrics, adaptiveGate),
        };
    };
    try {
        if (safeShouldCancel(execOptions)) {
            return cancelledResult(context, trafficClass, queue, adaptiveGate);
        }

        const remainingMs = Math.max(0, logicalDeadlineAt - Date.now());
        if (remainingMs <= 0) {
            adaptiveGate.onFailure();
            return timeoutResult(
                context,
                trafficClass,
                queue,
                adaptiveGate,
                "global_queue",
                `${GROK_CALL_TIMEOUT_MESSAGE}（排队后剩余预算不足）`,
            );
        }

        const fetchAbort = createFetchAbortController(remainingMs, execOptions);
        try {
            fetchStarted = true;
            const resp = await fetch(`${grokProxyUrl()}/v1/chat/completions`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${grokApiKey()}`,
                },
                body: JSON.stringify({
                    model,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.3,
                    max_tokens: maxTokens,
                }),
                signal: fetchAbort.signal,
            });
            receivedResponse = true;
            if (!resp.ok) {
                const body = (await resp.text()).trim();
                bodyComplete = true;
                const transient = resp.status === 429 ? "限流" : resp.status === 502 ? "上游不可用" : "HTTP 错误";
                const detail = body ? `: ${body.slice(0, 200)}` : "";
                return finishTransport(
                    {
                        text: null,
                        error: `Grok 模型桥调用失败 (${transient}) HTTP ${resp.status}${detail}`,
                        status: resp.status,
                    },
                    {
                        success: false,
                        errorKind: resp.status === 429
                            ? "rate_limit"
                            : resp.status >= 500 && resp.status <= 599
                                ? "server_error"
                                : "unknown",
                    },
                );
            }

            const body = await resp.text();
            bodyComplete = true;
            const parsedBody = parseJsonBody<{
                choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
            }>(body);
            if (parsedBody.type === "malformed") {
                const message = parsedBody.error instanceof Error ? parsedBody.error.message : String(parsedBody.error);
                return finishTransport(
                    { text: null, error: `Grok 模型桥调用失败: ${message}` },
                    { success: false, errorKind: "unknown" },
                );
            }
            const data = parsedBody.value;
            const choice = data.choices?.[0];
            const content = choice?.message?.content;
            if (choice?.finish_reason === "length") {
                return finishTransport(
                    {
                        text: null,
                        error: "Grok 模型桥输出被 max_tokens 截断 finish_reason=length",
                        finishReason: choice.finish_reason,
                    },
                    { success: false, errorKind: "content_truncated" },
                );
            }
            if (typeof content !== "string" || !content.trim()) {
                const finish = choice?.finish_reason ? ` finish_reason=${choice.finish_reason}` : "";
                return finishTransport(
                    {
                        text: null,
                        error: `Grok 模型桥输出为空${finish}`,
                        finishReason: choice?.finish_reason,
                    },
                    { success: false, errorKind: "empty_output" },
                );
            }
            return finishTransport(
                { text: content, finishReason: choice?.finish_reason },
                { success: true },
            );
        } finally {
            fetchAbortReason = fetchAbort.getReason();
            fetchAbort.cleanup();
        }
    } catch (error) {
        if (fetchAbortReason === "cancel" || safeShouldCancel(execOptions)) {
            return cancelledResult(context, trafficClass, queue, adaptiveGate);
        }
        if (fetchAbortReason === "timeout") {
            return finishTransport(
                { text: null, error: GROK_CALL_TIMEOUT_MESSAGE, timedOut: true, timeoutKind: "transport" },
                { success: false, errorKind: "timeout" },
                "transport",
            );
        }
        const message = error instanceof Error ? error.message : String(error);
        return finishTransport(
            { text: null, error: `Grok 模型桥调用失败: ${message}` },
            { success: false, errorKind: fetchStarted && (!receivedResponse || !bodyComplete) ? "network" : "unknown" },
        );
    } finally {
        permit?.release();
        batchPermit?.release();
    }
}

export async function isGrokBridgeAvailable(): Promise<boolean> {
    const now = Date.now();
    if (grokAvailableCache !== null && now - grokAvailableAt < GROK_STATUS_TTL_MS) {
        return grokAvailableCache;
    }

    try {
        const resp = await fetch(`${grokProxyUrl()}/v1/models`, {
            method: "GET",
            headers: { authorization: `Bearer ${grokApiKey()}` },
            signal: AbortSignal.timeout(Number(process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS || GROK_STATUS_TIMEOUT_MS)),
        });
        grokAvailableCache = resp.ok;
    } catch {
        grokAvailableCache = false;
    }
    grokAvailableAt = Date.now();
    return grokAvailableCache;
}

export function resetGrokBridgeAvailabilityForTest(): void {
    grokAvailableCache = null;
    grokAvailableAt = 0;
}

export function resetGrokCallConcurrencyForTest(): void {
    grokCallAdaptiveGate = null;
    grokCallGate.resetPeakForTest();
    grokBatchAdmissionGate.resetPeakForTest();
}

export function getGrokCallConcurrencyForTest() {
    return {
        global: grokCallGate.stats(),
        batch: getGrokBatchAdmissionGate().stats(),
        adaptive: getGrokCallAdaptiveGate().snapshot(),
    };
}
