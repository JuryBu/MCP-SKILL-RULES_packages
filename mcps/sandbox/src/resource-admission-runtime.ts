import {
    ResourceAdmissionController,
    ResourceAdmissionError,
    type ResourceAdmissionRequest,
    type ResourceAdmissionState,
    type ResourceLease,
} from "./resource-admission.js";
import os from "node:os";
import { hasWindowsJobRunner, startWindowsSystemMemoryMonitor } from "./windows-job-runner.js";

export interface ManagedResourceLease extends ResourceLease {
    readonly queueWaitMs: number;
    updateObservedMemoryMB(memoryMB: number): void;
}

function readEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a finite non-negative number`);
    }
    return value;
}

export const resourceAdmission = new ResourceAdmissionController({
    minReservationMB: readEnvNumber("SANDBOX_ADMISSION_MIN_RESERVATION_MB", 64),
    admissionLimitMB: readEnvNumber("SANDBOX_ADMISSION_LIMIT_MB", 1536),
    hardLimitMB: readEnvNumber("SANDBOX_ADMISSION_HARD_LIMIT_MB", 2048),
    systemHeadroomMB: readEnvNumber("SANDBOX_ADMISSION_SYSTEM_HEADROOM_MB", 512),
    commitHeadroomMB: readEnvNumber("SANDBOX_ADMISSION_COMMIT_HEADROOM_MB", 4096),
    commitCriticalFloorMB: readEnvNumber("SANDBOX_ADMISSION_COMMIT_CRITICAL_FLOOR_MB", 1536),
    yellowPhysicalMemoryMB: readEnvNumber("SANDBOX_ADMISSION_YELLOW_PHYSICAL_MB", 1536),
    yellowMaxReservationMB: readEnvNumber("SANDBOX_ADMISSION_YELLOW_MAX_REQUEST_MB", 192),
    maxAgedReservationMB: readEnvNumber("SANDBOX_ADMISSION_MAX_AGED_RESERVATION_MB", 256),
    maxQueueSize: readEnvNumber("SANDBOX_ADMISSION_MAX_QUEUE", 256),
    admissionBudgetMinMs: readEnvNumber("SANDBOX_ADMISSION_WAIT_MIN_MS", 8000),
    admissionBudgetMaxMs: readEnvNumber("SANDBOX_ADMISSION_WAIT_MAX_MS", 10000),
    agingThresholdMs: readEnvNumber("SANDBOX_ADMISSION_AGING_MS", 1000),
    retrySlotMs: readEnvNumber("SANDBOX_ADMISSION_RETRY_SLOT_MS", 500),
    maxRetryExponent: readEnvNumber("SANDBOX_ADMISSION_MAX_RETRY_EXPONENT", 4),
    progressIntervalMs: readEnvNumber("SANDBOX_ADMISSION_PROGRESS_INTERVAL_MS", 2000),
});

function refreshSystemAvailableMemory(): void {
    resourceAdmission.updateSystemAvailableMemoryMB(os.freemem() / 1024 / 1024);
}

let systemMemoryPoll: NodeJS.Timeout | null = null;
let memoryMonitorRetry: NodeJS.Timeout | null = null;

function ensureFallbackMemoryPoll(): void {
    refreshSystemAvailableMemory();
    if (systemMemoryPoll) return;
    systemMemoryPoll = setInterval(refreshSystemAvailableMemory, 500);
    systemMemoryPoll.unref?.();
}

function stopFallbackMemoryPoll(): void {
    if (!systemMemoryPoll) return;
    clearInterval(systemMemoryPoll);
    systemMemoryPoll = null;
}

function startNativeMemoryMonitor(): boolean {
    const monitor = startWindowsSystemMemoryMonitor((sample) => {
        resourceAdmission.updateSystemPressure({
            systemAvailableMemoryMB: sample.physicalAvailableMB,
            commitAvailableMemoryMB: sample.commitAvailableMB,
            highMemorySignaled: sample.highMemory,
            lowMemorySignaled: sample.lowMemory,
        });
        stopFallbackMemoryPoll();
    }, () => {
        ensureFallbackMemoryPoll();
        if (memoryMonitorRetry) return;
        memoryMonitorRetry = setTimeout(() => {
            memoryMonitorRetry = null;
            startNativeMemoryMonitor();
        }, 2000);
        memoryMonitorRetry.unref?.();
    });
    return monitor !== null;
}

if (!hasWindowsJobRunner() || !startNativeMemoryMonitor()) ensureFallbackMemoryPoll();

const observedMemoryByLease = new Map<ManagedResourceLease, number>();

function refreshObservedMemory(): void {
    let totalMemoryMB = 0;
    for (const memoryMB of observedMemoryByLease.values()) totalMemoryMB += memoryMB;
    resourceAdmission.updateObservedMemoryMB(totalMemoryMB);
}

export async function acquireResourceLease(
    request: ResourceAdmissionRequest = {},
): Promise<ManagedResourceLease> {
    const waitStartedAt = Date.now();
    const lease = await resourceAdmission.acquire(request);
    return manageLease(lease, Math.max(0, lease.acquiredAt - waitStartedAt));
}

export function adoptResourceLease(reservationMB?: number): ManagedResourceLease {
    return manageLease(resourceAdmission.adopt(reservationMB), 0);
}

function manageLease(lease: ResourceLease, queueWaitMs: number): ManagedResourceLease {
    let released = false;

    const managedLease: ManagedResourceLease = Object.freeze({
        reservedMB: lease.reservedMB,
        control: lease.control,
        acquiredAt: lease.acquiredAt,
        queueWaitMs,
        updateObservedMemoryMB(memoryMB: number): void {
            if (released || lease.control) return;
            if (!Number.isFinite(memoryMB) || memoryMB < 0) {
                throw new RangeError("memoryMB must be a finite non-negative number");
            }
            observedMemoryByLease.set(managedLease, memoryMB);
            refreshObservedMemory();
        },
        release(): boolean {
            if (released) return false;
            released = true;
            observedMemoryByLease.delete(managedLease);
            refreshObservedMemory();
            return lease.release();
        },
    });

    return managedLease;
}

export function getResourceAdmissionState(): ResourceAdmissionState {
    return resourceAdmission.getState();
}

export function serializeResourceAdmissionError(error: unknown): {
    type: string;
    message: string;
    queueWaitMs: number;
    retryAfterMs: number;
    commandStarted: false;
    memoryPressure: {
        activeReservedMB: number;
        admissionLimitMB: number;
        observedMemoryMB: number;
        hardLimitMB: number;
        systemAvailableMemoryMB: number | null;
        systemHeadroomMB: number;
        commitAvailableMemoryMB: number | null;
        commitHeadroomMB: number;
        commitCriticalFloorMB: number;
        pressureLevel: string;
        queued: number;
    };
} | null {
    if (!(error instanceof ResourceAdmissionError)) return null;
    const state = resourceAdmission.getState();
    return {
        type: error.code,
        message: error.message,
        queueWaitMs: error.queueWaitMs,
        retryAfterMs: error.retryAfterMs,
        commandStarted: false,
        memoryPressure: {
            activeReservedMB: state.activeReservedMB,
            admissionLimitMB: state.limits.admissionLimitMB,
            observedMemoryMB: state.observedMemoryMB,
            hardLimitMB: state.limits.hardLimitMB,
            systemAvailableMemoryMB: state.systemAvailableMemoryMB,
            systemHeadroomMB: state.limits.systemHeadroomMB,
            commitAvailableMemoryMB: state.commitAvailableMemoryMB,
            commitHeadroomMB: state.limits.commitHeadroomMB,
            commitCriticalFloorMB: state.limits.commitCriticalFloorMB,
            pressureLevel: state.pressureLevel,
            queued: state.queued,
        },
    };
}
