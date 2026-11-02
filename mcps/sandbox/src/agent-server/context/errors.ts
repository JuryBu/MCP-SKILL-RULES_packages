import { AgentFault } from '../protocol.js';
import type { ContextFailure } from './contracts.js';

export class ContextFault extends AgentFault {
    constructor(code: string, message: string, details?: Record<string, unknown>, mayHaveStarted = false) {
        super(code.startsWith('CONTEXT_') || code === 'BUDGET_REQUIRED' ? code : `CONTEXT_${code}`,
            message, details, mayHaveStarted, false);
        this.name = 'ContextFault';
    }
}

export function contextFailure(error: unknown): ContextFailure {
    if (error instanceof AgentFault) return { code: error.code, message: error.message,
        mayHaveStarted: error.mayHaveStarted, details: error.details,
        ...(typeof error.details?.attemptId === 'string' ? { attemptId: error.details.attemptId } : {}) };
    return { code: 'CONTEXT_INTERNAL', message: error instanceof Error ? error.message : String(error), mayHaveStarted: false };
}

export function checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) throw new ContextFault('CANCELLED', '压缩已取消');
}
