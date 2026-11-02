import type { DispatchJournalPort } from '../providers/dispatch.js';
import type { InternalChildren } from './runtime-children.js';

export function withInternalChildBudgets(journal: DispatchJournalPort, children: Pick<InternalChildren, 'prepareJournalAttempt'>): DispatchJournalPort {
    return {
        prepareAttempt: (attempt, upperBound) => children.prepareJournalAttempt(journal, attempt, upperBound),
        commitResponse: (attempt, response) => journal.commitResponse(attempt, response),
        recordFailure: (attempt, failure) => journal.recordFailure(attempt, failure),
    };
}
