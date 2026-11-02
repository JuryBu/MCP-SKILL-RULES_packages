import type { LifecycleCommit, LifecycleFence, LifecycleInventory } from './contracts.js';
import type { LifecycleConversationSnapshot } from './migration-snapshots.js';
import type { ReceiptKey, StoreCommitResult, StoredReceipt } from '../storage/port.js';

export type LifecycleSnapshotQuery = { type: 'durable'; source: LifecycleFence }
    | { type: 'financial'; conversationIds: string[] };

export interface LifecycleFinancialFacts { financialHash: string; unknownAttemptIds: string[] }

export type LifecycleSnapshotResult = ({ kind: 'snapshot'; snapshots: LifecycleConversationSnapshot[];
    inventory: LifecycleInventory; snapshotHash: string } & LifecycleFinancialFacts)
    | ({ kind: 'financial' } & LifecycleFinancialFacts);

export interface LifecycleMigrationOperation {
    schemaVersion: 1;
    conversationId: string;
    conversationIds: string[];
    operationId: string;
    principalId: string;
    clientId: string;
    status: 'awaiting_memory' | 'complete' | 'temporary_lost';
    receipt: StoredReceipt;
    updatedAt: string;
}

export type LifecycleMigrationCommand = {
    type: 'import' | 'prepare_temporary';
    commit: Extract<LifecycleCommit, { kind: 'retention' }>;
    snapshots: LifecycleConversationSnapshot[];
    financialHash: string;
    sourceSnapshotHash: string;
} | { type: 'complete_temporary'; key: ReceiptKey; operationHash: string }
    | { type: 'read'; key: ReceiptKey; operationHash: string }
    | { type: 'recover' };

export type LifecycleMigrationResult = { kind: 'committed'; result: StoreCommitResult }
    | { kind: 'temporary_prepared'; operation: LifecycleMigrationOperation }
    | { kind: 'operation'; operation: LifecycleMigrationOperation | null }
    | { kind: 'recovered'; operations: LifecycleMigrationOperation[] };

export interface LifecycleMigrationPersistentPort {
    readConversationLifecycleSnapshot(input: LifecycleSnapshotQuery): Promise<LifecycleSnapshotResult>;
    executeConversationLifecycleMigration(input: LifecycleMigrationCommand): Promise<LifecycleMigrationResult>;
}
