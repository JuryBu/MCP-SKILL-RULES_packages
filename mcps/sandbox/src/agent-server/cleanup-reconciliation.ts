import { AgentFault } from './protocol.js';
import type { RunSnapshot } from './protocol.js';
import type { CleanupEvidence } from './runtime.js';
import type { BudgetView } from './accounting/budget-ledger.js';
import type { PersistedProviderAttempt } from './storage/provider-journal.js';

export interface RunCleanupInput {
    snapshot: RunSnapshot;
    conversationOptions: Record<string, unknown>;
    preserveUnknownOutcome?: boolean;
}

export interface CleanupReconciliationPorts {
    readBudget(rootBudgetId: string): Promise<BudgetView>;
    readAttempt(attemptId: string): Promise<PersistedProviderAttempt | undefined>;
    releaseTools(input: RunCleanupInput): Promise<'released' | 'not_needed' | 'unconfirmed'>;
    releaseContext(input: RunCleanupInput): Promise<boolean>;
}

export async function reconcileRunCleanup(input: RunCleanupInput, ports: CleanupReconciliationPorts): Promise<CleanupEvidence> {
    if (input.snapshot.rootRunId !== undefined && input.snapshot.rootRunId !== null && typeof input.snapshot.rootRunId !== 'string') return 'unconfirmed';
    if (input.preserveUnknownOutcome === true) {
        if (input.snapshot.state !== 'outcome_unknown') return 'unconfirmed';
        const tools = await ports.releaseTools(input);
        if (tools === 'unconfirmed' || !await ports.releaseContext(input)) return 'unconfirmed';
        return 'resources_released';
    }
    const rootBudgetId = typeof input.snapshot.rootRunId === 'string' ? input.snapshot.rootRunId : input.snapshot.runId;
    let budget: BudgetView | undefined;
    try {
        budget = await ports.readBudget(rootBudgetId);
    } catch (error) {
        if (!(error instanceof AgentFault) || error.code !== 'BUDGET_REQUIRED') return 'unconfirmed';
    }
    if (budget && budget.budget.rootBudgetId !== rootBudgetId) return 'unconfirmed';
    for (const reservation of budget?.reservations ?? []) {
        if (reservation.callHeld || ['reserved', 'dispatched', 'unknown'].includes(reservation.state)) return 'unconfirmed';
        const recorded = await ports.readAttempt(reservation.attemptId);
        if (!recorded || recorded.attempt.rootBudgetId !== rootBudgetId
            || recorded.attempt.snapshot.conversationId !== input.snapshot.conversationId) return 'unconfirmed';
        if (recorded.state === 'committed') {
            if (!recorded.response?.complete) return 'unconfirmed';
        } else if (recorded.state !== 'rejected' || !recorded.failure
            || !['not_sent', 'rejected'].includes(recorded.failure.acceptance)) return 'unconfirmed';
    }
    const tools = await ports.releaseTools(input);
    if (tools === 'unconfirmed' || !await ports.releaseContext(input)) return 'unconfirmed';
    return 'resources_released';
}
