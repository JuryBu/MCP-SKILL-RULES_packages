import { createHash } from 'node:crypto';
import { AgentFault } from '../protocol.js';
import type { AgentEvent, JsonValue } from '../protocol.js';
import type { HistoryItem, StoreRecord, StoredReceipt } from '../storage/port.js';
import type { ProviderAttempt, NormalizedResponse } from '../providers/types.js';
import type { RecordedFailure } from '../providers/dispatch.js';
import type { UpperBound } from '../accounting/budget-ledger.js';
import type { PersistedProviderAttempt } from '../storage/provider-journal.js';
import type { TemporaryFinancialIntent, TemporaryRunFence } from '../storage/temporary-finance.js';
import type { ApprovalTicket } from '../security/approvals.js';
import type { ChangeAction } from '../workspace/journal.js';
import type { StoredRestorePlan } from '../storage/workspace-port.js';
import type { MediaArtifact } from '../media/types.js';
import { canonicalJsonByteChunks } from '../media/payload-codec.js';

export interface LifecycleCapture<Value> { value: Value; release(): void }
export interface LifecycleStage { activate(): void; discard(): void }

export interface LifecycleContentSnapshot {
    contentId: string;
    kind: string;
    value: JsonValue;
    sha256: string;
    rawBytes: number;
}

export interface LifecycleCoreSnapshot {
    schemaVersion: 1;
    conversationId: string;
    records: StoreRecord[];
    receipts: StoredReceipt[];
    contents: LifecycleContentSnapshot[];
    history: HistoryItem[];
    events: AgentEvent[];
}

export interface LifecycleTemporaryAttempt {
    intent: TemporaryFinancialIntent;
    state: PersistedProviderAttempt['state'];
    attempt?: ProviderAttempt;
    upperBound?: UpperBound;
    attemptHash?: string;
    upperHash?: string;
    response?: NormalizedResponse;
    responseHash?: string;
    failure?: RecordedFailure;
    toolsAuthorized: boolean;
    lateResponse: boolean;
    memoryBytes: number;
    commitUncertain?: boolean;
    failureBytes?: number;
}

export interface LifecycleProviderSnapshot {
    schemaVersion: 1;
    conversationId: string;
    temporaryAttempts: LifecycleTemporaryAttempt[];
    durableAttempts: PersistedProviderAttempt[];
    fences: TemporaryRunFence[];
    closed: boolean;
}

export type LifecycleChangeSnapshot = Omit<ChangeAction, 'before' | 'after'> & { beforeBase64: string | null; afterBase64: string };

export interface LifecycleWorkspaceSnapshot {
    schemaVersion: 1;
    conversationId: string;
    journalRevision: number;
    actions: LifecycleChangeSnapshot[];
    tickets: ApprovalTicket[];
    approvalReceipts: { key: string; hash: string; value: JsonValue }[];
    restorePlans: StoredRestorePlan[];
}

export interface LifecycleMediaSnapshot {
    schemaVersion: 1;
    conversationId: string;
    artifacts: MediaArtifact[];
    payloads: { sha256: string; byteLength: number; dataBase64: string }[];
}

export interface LifecyclePendingSnapshot { schemaVersion: 1; conversationId: string; pendingToolIds: string[] }

export interface LifecycleConversationSnapshot {
    schemaVersion: 1;
    conversationId: string;
    core: LifecycleCoreSnapshot;
    provider: LifecycleProviderSnapshot;
    workspace: LifecycleWorkspaceSnapshot;
    media: LifecycleMediaSnapshot;
    pending: LifecyclePendingSnapshot;
}

export function lifecycleSnapshotHash(value: unknown): string {
    const checksum = createHash('sha256');
    for (const chunk of canonicalJsonByteChunks(value)) checksum.update(chunk);
    return checksum.digest('hex');
}

export function requireLifecycleSnapshotOwner(value: { schemaVersion: number; conversationId: string }, conversationId: string): void {
    if (value.schemaVersion !== 1 || value.conversationId !== conversationId || !conversationId) {
        throw new AgentFault('INVALID_PARAMS', '生命周期快照的版本或会话归属不一致');
    }
}

export function lifecycleFrozen(conversationId: string): AgentFault {
    return new AgentFault('RETENTION_TRANSITION_BUSY', '当前会话正在核对或切换完整保存工厂', { conversationId, transitionState: 'pending' });
}

export function lifecycleReceiptOwner(receipt: StoredReceipt): string | undefined {
    if (receipt.key.conversationId) return receipt.key.conversationId;
    const data = receipt.result.data;
    const value = data as Record<string, unknown> | undefined;
    return value && !Array.isArray(value) && typeof value.conversationId === 'string' ? value.conversationId : undefined;
}
