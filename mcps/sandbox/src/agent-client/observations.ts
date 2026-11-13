import type { RpcResult } from '../agent-server/protocol.js';
import type { RunObservation } from '../agent-server/rpc-observation.js';
import type { renderHistoryExport } from '../agent-server/rpc-history-export.js';

export type { RunObservation };
export type ConversationExportPage = ReturnType<typeof renderHistoryExport>;

export interface RunObservationOptions {
    afterCursor?: string;
    limit?: number;
    maxBytes?: number;
}

export interface ConversationExportOptions {
    cursor?: string;
    limit?: number;
    startRound?: number;
    endRound?: number;
    maxBytes?: number;
}

export interface ReadBatchRequest {
    method: string;
    params?: Record<string, unknown>;
}

export interface ReadBatchResult {
    results: { index: number; method: string | null; result: RpcResult }[];
    source: 'read_dispatch';
    observedAt: string;
}

export interface ConversationContextSnapshot extends Record<string, unknown> {
    conversationId?: string;
    source?: 'closed_context_snapshot' | 'closed_conversation_metadata';
    observedAt?: string;
    snapshotCursor?: string;
    final?: boolean;
    partial?: boolean;
    readOnly?: boolean;
}
