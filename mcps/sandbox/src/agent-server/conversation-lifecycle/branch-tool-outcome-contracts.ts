import type { JsonValue } from '../protocol.js';
import type { StoredReceipt, StoreRecord, TransitionExpected } from '../storage/port.js';

export interface BranchToolEvidenceQuery {
    viewConversationId: string;
    conversationId: string;
    runId: string;
    runEpoch: number;
    roundId: string;
    stepId: string;
    attemptId: string;
    historyContentId: string;
    historyObjectHash: string;
}

export interface BranchToolContentReference {
    contentId: string;
    objectHash: string;
    rawBytes: number;
}

export interface BranchFrozenToolCall {
    callId: string;
    name: string;
    receipt: StoredReceipt | null;
    content: BranchToolContentReference | null;
}

export interface BranchFrozenToolGroup {
    source: Omit<BranchToolEvidenceQuery, 'viewConversationId'>;
    run: StoreRecord;
    step: StoreRecord | null;
    calls: BranchFrozenToolCall[];
}

export interface BranchToolOutcomeProvenance {
    schemaVersion: 1;
    groups: BranchFrozenToolGroup[];
    expected: TransitionExpected[];
}

export interface BranchToolEvidence {
    run: StoreRecord;
    step: StoreRecord | null;
    calls: Array<Omit<BranchFrozenToolCall, 'content'> & {
        content: (BranchToolContentReference & { value: JsonValue }) | null;
    }>;
}
