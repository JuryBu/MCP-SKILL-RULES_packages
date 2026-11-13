export interface CorpusSearchContinuationState {
    ownerId: string;
    taskId: string;
    status: string;
    revision: number;
    nextAfterRevision?: number;
    continuationCursor?: string;
    nextCursor?: string;
    cursor?: string;
    hasMore?: boolean;
    changes?: { throughRevision: number; hasMore: boolean };
    request: { dataChains: readonly string[]; conversationIds?: readonly string[] };
}

export interface CorpusSearchNextCall {
    action: "search_all_status" | "search_all_resume";
    conversationId: string;
    taskId: string;
    dataChain?: string;
    dataChains?: string[];
    conversationIds?: string[];
    afterRevision?: number;
    waitSeconds?: number;
    continuationCursor?: string;
}

export function corpusSearchContinuation(state: CorpusSearchContinuationState): {
    next?: CorpusSearchNextCall; nextKind: "wait" | "page" | "resume" | "error" | "complete" | "unknown";
} {
    const identity = { conversationId: state.ownerId, taskId: state.taskId,
        ...(state.request.dataChains.length === 1 ? { dataChain: state.request.dataChains[0] } : { dataChains: [...state.request.dataChains] }),
        ...(state.request.conversationIds ? { conversationIds: [...state.request.conversationIds] } : {}) };
    const statusNext: CorpusSearchNextCall = { action: "search_all_status", ...identity,
        afterRevision: state.nextAfterRevision ?? state.changes?.throughRevision ?? state.revision, waitSeconds: 30 };
    const snapshotCursor = state.nextCursor ?? state.continuationCursor ?? (state.hasMore ? state.cursor : undefined);
    if (snapshotCursor) return { next: { ...statusNext, continuationCursor: snapshotCursor, waitSeconds: 0,
        afterRevision: state.nextAfterRevision ?? state.changes?.throughRevision ?? 0 }, nextKind: "page" as const };
    if (state.changes?.hasMore) return { next: { ...statusNext, waitSeconds: 0 }, nextKind: "page" as const };
    if (state.status === "running" || state.status === "queued") return { next: statusNext, nextKind: "wait" as const };
    if (state.status === "partial" || state.status === "cancelled") {
        return { next: { action: "search_all_resume", ...identity }, nextKind: "resume" as const };
    }
    if (state.status === "error") return { nextKind: "error" as const };
    if (state.status === "completed") return { nextKind: "complete" as const };
    return { nextKind: "unknown" as const };
}
