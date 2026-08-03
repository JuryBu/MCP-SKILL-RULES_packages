import { AsyncLocalStorage } from "node:async_hooks";
import {
    FifoConcurrencyGate,
    type ConcurrencyGateAcquireOptions,
    type ConcurrencyGateRequestClass,
    type ConcurrencyGateSnapshot,
} from "./concurrency-gate.js";

const DEFAULT_TOTAL_CONCURRENCY = 2;
const DEFAULT_BACKGROUND_CONCURRENCY = 1;

function positiveIntegerEnvironment(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || !/^\d+$/u.test(raw.trim())) return fallback;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function totalConcurrency(): number {
    return Math.max(2, positiveIntegerEnvironment(
        "MEMORY_STORE_CONVERSATION_SOURCE_CONCURRENCY",
        DEFAULT_TOTAL_CONCURRENCY,
    ));
}

function backgroundConcurrency(): number {
    return DEFAULT_BACKGROUND_CONCURRENCY;
}

const totalGate = new FifoConcurrencyGate(totalConcurrency);
const backgroundGate = new FifoConcurrencyGate(backgroundConcurrency);
interface ConversationSourcePressureContext {
    requestClass: ConcurrencyGateRequestClass;
    active: boolean;
}

const pressureContext = new AsyncLocalStorage<ConversationSourcePressureContext>();

export interface ConversationSourcePressureSnapshot {
    total: ConcurrencyGateSnapshot;
    background: ConcurrencyGateSnapshot;
}

export interface ConversationSourcePressurePermit {
    run: <T>(operation: () => Promise<T> | T) => Promise<T>;
    release: () => void;
}

export async function acquireConversationSourcePressure(
    requestClass: ConcurrencyGateRequestClass,
    options: Omit<ConcurrencyGateAcquireOptions, "requestClass"> = {},
): Promise<ConversationSourcePressurePermit> {
    const backgroundPermit = requestClass === "background"
        ? await backgroundGate.acquire({ ...options, requestClass: "background" })
        : null;
    let totalPermit;
    try {
        totalPermit = await totalGate.acquire({ ...options, requestClass });
    } catch (error) {
        backgroundPermit?.release();
        throw error;
    }
    let released = false;
    const context: ConversationSourcePressureContext = { requestClass, active: true };
    return {
        async run<T>(operation: () => Promise<T> | T): Promise<T> {
            if (released) throw new Error("conversation source pressure permit has been released");
            return pressureContext.run(context, async () => await operation());
        },
        release(): void {
            if (released) return;
            released = true;
            context.active = false;
            totalPermit.release();
            backgroundPermit?.release();
        },
    };
}

export async function withConversationSourcePressure<T>(
    requestClass: ConcurrencyGateRequestClass,
    run: () => Promise<T> | T,
    options: Omit<ConcurrencyGateAcquireOptions, "requestClass"> = {},
): Promise<T> {
    if (pressureContext.getStore()?.active) return await run();
    const permit = await acquireConversationSourcePressure(requestClass, options);
    try {
        return await permit.run(run);
    } finally {
        permit.release();
    }
}

export function getConversationSourcePressureSnapshot(): ConversationSourcePressureSnapshot {
    return {
        total: totalGate.stats(),
        background: backgroundGate.stats(),
    };
}

export function resetConversationSourcePressureForTests(): void {
    totalGate.resetPeakForTest();
    backgroundGate.resetPeakForTest();
}
