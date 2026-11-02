import type { LifecycleCaller } from './contracts.js';
import type { ConversationLifecycleService } from './service.js';

export { ConversationLifecycleService } from './service.js';
export type { ConversationLifecycleServiceOptions } from './service.js';
export { CONVERSATION_LIFECYCLE_RPC_METHOD_SPECS } from './rpc-signatures.js';
export { DurableConversationLifecycleAdapter, createPersistentConversationLifecycleStorage,
    LIFECYCLE_CONVERSATION_TABLES, LIFECYCLE_FINANCIAL_QUERIES } from './storage-adapter.js';
export type { LifecycleWorkerCommand, LifecycleWorkerOptions } from './storage-adapter.js';
export { readLifecycleNativeOrigin } from './originals.js';
export { readLifecycleBranchToolEvidence } from './branch-tool-outcomes.js';
export type * from './branch-tool-outcome-contracts.js';
export type * from './contracts.js';

export async function dispatchConversationLifecycle(service: ConversationLifecycleService, method: string, params: unknown, caller: LifecycleCaller) {
    if (method === 'conversations.previewBranch') return service.previewBranch(params, caller);
    if (method === 'conversations.previewRetention') return service.previewRetention(params, caller);
    if (method === 'conversations.setRetention') return service.setRetention(params, caller);
    if (method === 'conversations.branch') return service.branch(params, caller);
    return undefined;
}
export { createMigratingConversationLifecycleStorage } from './migration-adapter.js';
export type { MigratingConversationLifecycleOptions, MigratingConversationLifecycleStorage } from './migration-adapter.js';
export type { LifecycleSnapshotQuery, LifecycleSnapshotResult, LifecycleMigrationCommand, LifecycleMigrationResult } from './migration-contracts.js';
