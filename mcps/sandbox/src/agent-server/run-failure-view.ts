import type { RpcResult } from './protocol.js';
import { objectValue } from './providers/assemble.js';
import type { BudgetView } from './accounting/budget-ledger.js';
import type { PersistedProviderAttempt } from './storage/provider-journal.js';

export async function reconcileRunFailureView(result: RpcResult, ports: {
    readBudget(rootBudgetId: string): Promise<BudgetView>;
    readAttempt(attemptId: string): Promise<PersistedProviderAttempt | undefined>;
}): Promise<RpcResult> {
    if (!result.ok) return result;
    const snapshot = objectValue(result.data);
    const failure = objectValue(snapshot?.failure);
    const attemptId = failure?.attemptId;
    if (!snapshot || failure?.acceptance !== 'not_sent' || typeof attemptId !== 'string'
        || typeof snapshot.conversationId !== 'string' || typeof snapshot.runId !== 'string') return result;
    const rootBudgetId = typeof snapshot.rootRunId === 'string' ? snapshot.rootRunId : snapshot.runId;
    const budget = await ports.readBudget(rootBudgetId);
    const reservation = budget.reservations.find(item => item.attemptId === attemptId);
    if (budget.budget.rootBudgetId !== rootBudgetId || reservation?.dispatched !== true
        || !['dispatched', 'unknown'].includes(reservation.state)) return result;
    const recorded = await ports.readAttempt(attemptId);
    if (!recorded || !['dispatching', 'unknown'].includes(recorded.state)
        || recorded.attempt.rootBudgetId !== rootBudgetId
        || recorded.attempt.snapshot.conversationId !== snapshot.conversationId
        || recorded.attempt.snapshot.runId !== snapshot.runId) return result;
    const originalError = objectValue(failure.error);
    return { ...result, data: { ...snapshot, failure: { ...failure, acceptance: 'unknown',
        error: { ...originalError, mayHaveStarted: true, details: { ...objectValue(originalError?.details),
            dispatchReconciliation: { source: 'persisted_provider_attempt', originalAcceptance: 'not_sent',
                originalMayHaveStarted: originalError?.mayHaveStarted ?? null, dispatched: true,
                journalState: recorded.state, reservationState: reservation.state } } } } } };
}
