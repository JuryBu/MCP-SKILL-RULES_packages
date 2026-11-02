import type { AccountingCommand, AccountingPort, AccountingResult, BudgetDefinition, BudgetView, UpperBound } from '../accounting/budget-ledger.js';
import type { DispatchJournalPort, PreparedDispatch, RecordedFailure } from '../providers/dispatch.js';
import type { NormalizedResponse, ProviderAttempt } from '../providers/types.js';
import type { SqliteStore } from './sqlite.js';

export interface PersistedProviderAttempt {
    state: 'dispatching' | 'unknown' | 'committed' | 'rejected';
    attempt: ProviderAttempt;
    upperBound: UpperBound;
    response?: NormalizedResponse;
    failure?: RecordedFailure;
    toolsAuthorized: boolean;
    lateResponse: boolean;
}

export class SqliteAccountingPort implements AccountingPort {
    constructor(private readonly store: SqliteStore) {}
    execute(command: AccountingCommand): Promise<AccountingResult> { return this.store.executeAccounting(command); }
    read(rootBudgetId: string): Promise<BudgetView> { return this.store.readAccounting(rootBudgetId); }
    createBudget(definition: BudgetDefinition): Promise<AccountingResult> { return this.execute({ type: 'create_budget', definition }); }
}

export class SqliteDispatchJournalPort implements DispatchJournalPort {
    constructor(private readonly store: SqliteStore) {}
    prepareAttempt(attempt: ProviderAttempt, upperBound: UpperBound): Promise<PreparedDispatch> {
        return this.store.prepareProviderAttempt(attempt, upperBound);
    }
    commitResponse(attempt: ProviderAttempt, response: NormalizedResponse): Promise<{ canExecuteTools: boolean }> {
        return this.store.commitProviderResponse(attempt, response);
    }
    recordFailure(attempt: ProviderAttempt, failure: RecordedFailure): Promise<void> {
        return this.store.recordProviderFailure(attempt, failure);
    }
    readAttempt(attemptId: string): Promise<PersistedProviderAttempt | undefined> {
        return this.store.readProviderAttempt(attemptId);
    }
}

export function createSqliteProviderPorts(store: SqliteStore): { accountingPort: SqliteAccountingPort; journal: SqliteDispatchJournalPort } {
    return { accountingPort: new SqliteAccountingPort(store), journal: new SqliteDispatchJournalPort(store) };
}
