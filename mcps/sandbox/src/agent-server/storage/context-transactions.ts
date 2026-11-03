import { canonicalJson } from '../protocol.js';
import { randomUUID } from 'node:crypto';
import type { JsonValue } from '../protocol.js';
import type { ContextCapture, ExecutionLease, SchedulerCheckpoint } from '../context/contracts.js';
import { hashContext } from '../context/config.js';
import { ContextFault } from '../context/errors.js';
import type { ContentWrite, StateMutationPort, StoreCommitResult, StoreKey, StorePort, StoreRecord, StoreTransition } from './port.js';
import { storeKey } from './port.js';
import type { SqlDatabase } from './internal.js';
import type { RequestSnapshot } from '../providers/types.js';

export interface ContextStateData extends Record<string, unknown> {
    kind: 'context_state';
    schemaVersion: 1;
    compressionGeneration: string;
    effectiveModelFingerprint: string;
    execution: ExecutionLease | null;
    candidateId: string | null;
    viewContentId: string | null;
    configContentId: string | null;
    configFingerprint: string | null;
    checkpoint: SchedulerCheckpoint | null;
    checkpointContentId: string | null;
    historyCheckpoint?: { historyEpoch: number; throughSeq: number; stepSeq: number } | null;
}

export interface ContextCandidateData extends Record<string, unknown> {
    kind: 'context_candidate';
    candidateId: string;
    state: string;
    contentId: string;
    contentHash: string;
    runId: string;
    runEpoch: number;
    compressionGeneration: string;
    historyEpoch: number;
    parentViewRevision: number;
    publishedViewRevision: number | null;
    pendingAttemptId?: string | null;
}

export interface ContextSummaryReadInput {
    conversationId: string;
    historyEpoch: number;
    nodeId: string;
    hash?: string;
    signal?: AbortSignal;
}

export interface ContextSummaryArchiveData extends Record<string, unknown> {
    kind: 'context_summary_archive';
    schemaVersion: 1;
    conversationId: string;
    historyEpoch: number;
    nodeId: string;
    nodeHash: string;
    contentId: string;
    contentHash: string;
    byteLength: number;
    firstSeq: number;
    lastSeq: number;
}

export const MAX_CONTEXT_SUMMARY_NODE_BYTES = 2 * 1024 * 1024;
export const MAX_CONTEXT_SUMMARY_ARCHIVE_BYTES = 16 * 1024 * 1024;
export const MAX_CONTEXT_SUMMARY_ARCHIVE_NODES = 4096;

export type ContextTransactionPort = Pick<StorePort, 'getRecord' | 'readContent' | 'getReceipt' | 'commitTransition' | 'mutateState'>;

export const contextStateKey = (conversationId: string): StoreKey => ({ conversationId, kind: 'step', id: `context:state:${conversationId}` });
export const contextCandidateKey = (conversationId: string, candidateId: string): StoreKey => ({ conversationId, kind: 'step', id: `context:candidate:${candidateId}` });
export const contextConversationKey = (conversationId: string): StoreKey => ({ conversationId, kind: 'conversation', id: conversationId });
export const contextRunKey = (conversationId: string, runId: string): StoreKey => ({ conversationId, kind: 'run', id: runId });
export const contextFeedbackStateKey = (conversationId: string, historyEpoch: number): StoreKey =>
    ({ conversationId, kind: 'step', id: `context:feedback:${historyEpoch}` });
export const contextFeedbackTargetKey = (conversationId: string, historyEpoch: number, target: unknown): StoreKey =>
    ({ conversationId, kind: 'step', id: `context:feedback-target:${historyEpoch}:${hashContext(target)}` });
export const contextFeedbackHitKey = (conversationId: string, historyEpoch: number, hitId: string): StoreKey =>
    ({ conversationId, kind: 'step', id: `context:feedback-hit:${historyEpoch}:${hashContext(hitId)}` });
export const contextSummaryKey = (conversationId: string, historyEpoch: number, nodeId: string, hash?: string): StoreKey =>
    ({ conversationId, kind: 'step', id: `context:summary:${historyEpoch}:${hashContext(nodeId)}:${hash ?? 'latest'}` });

export function initialContextState(): ContextStateData {
    return { kind: 'context_state', schemaVersion: 1, compressionGeneration: 'unclaimed', effectiveModelFingerprint: '',
        execution: null, candidateId: null, viewContentId: null, configContentId: null, configFingerprint: null,
        checkpoint: null, checkpointContentId: null, historyCheckpoint: null };
}

export function contextContent(conversationId: string, contentId: string, kind: string, value: unknown): ContentWrite {
    return { conversationId, contentId, kind, indexHistory: false, value: JSON.parse(canonicalJson(value)) as JsonValue };
}

export function nextContextRecord<Value extends Record<string, unknown>>(key: StoreKey, previous: StoreRecord<Value> | undefined, value: Value): StoreRecord<Value> {
    if (Buffer.byteLength(canonicalJson(value)) > 64 * 1024) throw new ContextFault('CONFIG_INVALID', 'Context小状态超过64KiB，正文须改用内容对象');
    return { key, revision: (previous?.revision ?? 0) + 1, value };
}

export function contextRootBudgetId(run: StoreRecord): string {
    if (run.key.kind !== 'run' || run.key.id !== run.value.runId || run.key.conversationId !== run.value.conversationId
        || typeof run.value.rootRunId !== 'string' || !run.value.rootRunId) {
        throw new ContextFault('CONFIG_INVALID', 'Context根预算须来自Runtime持久run的rootRunId');
    }
    return run.value.rootRunId;
}

export function requireContextExecution(conversation: StoreRecord, run: StoreRecord | undefined, execution: ExecutionLease, now: number): void {
    const value = run?.value;
    if (!value || value.conversationId !== execution.conversationId || value.runId !== execution.runId || value.kind !== execution.kind
        || value.runEpoch !== execution.runEpoch || conversation.key.conversationId !== execution.conversationId
        || !['queued', 'running', 'waiting', 'paused', 'recovering', 'outcome_unknown'].includes(String(value.state))
        || conversation.value.state !== 'open' || conversation.value.activeRunId !== execution.runId) {
        throw new ContextFault('HISTORY_STALE', 'Context执行已终止、被替换或不再属于当前会话');
    }
    const rootBudgetId = contextRootBudgetId(run!);
    if (rootBudgetId !== execution.rootBudgetId || !Number.isFinite(Date.parse(execution.deadlineAt)) || Date.parse(execution.deadlineAt) <= now) {
        throw new ContextFault('CONFIG_INVALID', 'Context根预算身份或期限与原run不同');
    }
}

export function verifyContextCapture(capture: ContextCapture, conversation: StoreRecord, state: ContextStateData): void {
    if (Number(conversation.value.historyEpoch) !== capture.historyEpoch || Number(conversation.value.viewRevision) !== capture.viewRevision
        || state.compressionGeneration !== capture.compressionGeneration || state.effectiveModelFingerprint !== capture.effectiveModelFingerprint) {
        throw new ContextFault('HISTORY_STALE', 'Context捕获状态与提交前的会话版本不同');
    }
}

export type ContextDispatchSnapshot = Pick<RequestSnapshot, 'conversationId' | 'runId' | 'runEpoch' | 'historyEpoch' | 'viewRevision' | 'rootBudgetId'> & {
    compressionGeneration?: string;
    compressionCandidateId?: string;
    compressionRequestAttemptId?: string;
    effectiveCompressionModelFingerprint?: string;
};

export function assertContextDispatchFence(state: ContextStateData | undefined, candidate: ContextCandidateData | undefined, snapshot: ContextDispatchSnapshot): void {
    if (snapshot.compressionGeneration === undefined && snapshot.compressionCandidateId === undefined) return;
    if (!state || !candidate || !snapshot.compressionGeneration || !snapshot.compressionCandidateId || !snapshot.compressionRequestAttemptId
        || state.compressionGeneration !== snapshot.compressionGeneration || state.candidateId !== snapshot.compressionCandidateId
        || state.execution?.runId !== snapshot.runId || state.execution.runEpoch !== snapshot.runEpoch
        || state.execution.rootBudgetId !== snapshot.rootBudgetId || candidate.candidateId !== snapshot.compressionCandidateId
        || candidate.compressionGeneration !== snapshot.compressionGeneration || candidate.state !== 'generating'
        || candidate.pendingAttemptId !== snapshot.compressionRequestAttemptId || candidate.runId !== snapshot.runId
        || candidate.runEpoch !== snapshot.runEpoch || candidate.historyEpoch !== snapshot.historyEpoch
        || candidate.parentViewRevision !== snapshot.viewRevision || state.effectiveModelFingerprint !== snapshot.effectiveCompressionModelFingerprint) {
        throw new ContextFault('HISTORY_STALE', '压缩派发的候选、epoch、模型或代次已经失效');
    }
}

export function requireSqlContextDispatchFence(database: SqlDatabase, snapshot: ContextDispatchSnapshot): void {
    if (snapshot.compressionGeneration === undefined && snapshot.compressionCandidateId === undefined) return;
    const runKey = contextRunKey(snapshot.conversationId, snapshot.runId);
    const run = database.prepare('SELECT revision,value_json FROM store_records WHERE record_key = ?').get(storeKey(runKey));
    if (!run || contextRootBudgetId({ key: runKey, revision: Number(run.revision), value: JSON.parse(String(run.value_json)) }) !== snapshot.rootBudgetId) {
        throw new ContextFault('CONFIG_INVALID', '压缩发送根预算与Runtime的rootRunId不同');
    }
    const state = database.prepare('SELECT value_json FROM store_records WHERE record_key = ?').get(storeKey(contextStateKey(snapshot.conversationId)));
    const candidate = snapshot.compressionCandidateId ? database.prepare('SELECT value_json FROM store_records WHERE record_key = ?')
        .get(storeKey(contextCandidateKey(snapshot.conversationId, snapshot.compressionCandidateId))) : undefined;
    assertContextDispatchFence(state ? JSON.parse(String(state.value_json)) as ContextStateData : undefined,
        candidate ? JSON.parse(String(candidate.value_json)) as ContextCandidateData : undefined, snapshot);
}

export class ContextTransactions {
    constructor(readonly port: ContextTransactionPort) {}

    async readState(conversationId: string, port: Pick<StorePort, 'getRecord'> = this.port): Promise<{ record: StoreRecord<ContextStateData> | undefined; value: ContextStateData }> {
        const record = await port.getRecord<ContextStateData>(contextStateKey(conversationId));
        if (record && (record.value.kind !== 'context_state' || record.value.schemaVersion !== 1)) throw new ContextFault('CONFIG_INVALID', 'Context状态版本不兼容');
        return { record, value: record?.value ?? initialContextState() };
    }

    async commit(transition: StoreTransition, port: Pick<StorePort, 'commitTransition'> = this.port): Promise<StoreCommitResult> {
        const expected = new Map(transition.expected.map(entry => [canonicalJson(entry.key), entry]));
        if (expected.size !== transition.expected.length) throw new ContextFault('CONFIG_INVALID', 'Context事务包含重复版本条件');
        return port.commitTransition(transition);
    }

    mutateState<Value>(conversationId: string, operation: (port: StateMutationPort) => Promise<Value>): Promise<Value> {
        if (this.port.mutateState) return this.port.mutateState({ conversationId }, operation);
        return operation({ getRecord: this.port.getRecord.bind(this.port), commitTransition: this.port.commitTransition.bind(this.port) });
    }

    async checkpoint(conversationId: string, checkpoint: SchedulerCheckpoint): Promise<void> {
        const contentId = randomUUID();
        const content = contextContent(conversationId, contentId, 'context_checkpoint', checkpoint);
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                await this.mutateState(conversationId, async port => {
                    const state = await this.readState(conversationId, port);
                    const conversation = await port.getRecord(contextConversationKey(conversationId));
                    if (!conversation) throw new ContextFault('HISTORY_STALE', '会话已经清理');
                    const next = nextContextRecord(contextStateKey(conversationId), state.record, { ...state.value, checkpoint: null, checkpointContentId: contentId });
                    await this.commit({ expected: [{ key: next.key, revision: state.record?.revision ?? null },
                        { key: conversation.key, revision: conversation.revision }], records: [next], contents: [content] }, port);
                });
                return;
            } catch (error) {
                if (!(error instanceof Error && 'code' in error && error.code === 'REVISION_CONFLICT') || attempt === 3) throw error;
            }
        }
    }

    async readObject<Value>(conversationId: string, contentId: string, expectedHash?: string): Promise<Value> {
        const value = await this.port.readContent(conversationId, contentId);
        if (value === undefined || (expectedHash && hashContext(value) !== expectedHash)) throw new ContextFault('SOURCE_GAP', 'Context内容对象缺失或哈希不一致', { contentId });
        return value as Value;
    }
}
