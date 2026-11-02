import type { ProviderProtocol, ToolResult } from '../providers/types.js';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { RetainPolicy } from '../protocol.js';
import type { ToolExecutionResult } from './types.js';

export type PendingToolState = 'awaiting_approval' | 'executing' | 'cancelling' | 'completed' | 'denied' | 'cancelled' | 'timed_out' | 'failed' | 'unknown';

export interface FrozenToolInvocation {
    name: string;
    args: Record<string, unknown>;
    argsHash: string;
    principalId: string;
    conversationId: string;
    runId: string;
    rootRunId: string;
    originalRunEpoch: number;
    roundId: string;
    stepId: string;
    actionId: string;
    attemptId: string;
    callId: string;
    providerCallId: string | null;
    providerProtocol?: ProviderProtocol;
    modelContentId?: string;
    rootBudgetId?: string;
    roots: string[];
    protectedPaths: string[];
    approvalRequiredTools: string[];
    policyRevision: number;
    retention: RetainPolicy;
}

export interface PendingToolRecord {
    pendingToolId: string;
    approvalId: string | null;
    frozen: FrozenToolInvocation;
    executionEpoch: number;
    state: PendingToolState;
    revision: number;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    claimToken?: string;
    cancelReason?: 'cancelled' | 'timed_out';
    result?: ToolExecutionResult;
}

export interface PendingToolSummary {
    pendingToolId: string;
    approvalId: string | null;
    principalId: string;
    conversationId: string;
    runId: string;
    rootRunId: string;
    state: PendingToolState;
    revision: number;
    executionEpoch: number;
    originalRunEpoch: number;
    policyRevision: number;
    name: string;
    argsHash: string;
    callId: string;
    stepId: string;
    actionId: string;
    attemptId: string;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
}

export interface PendingToolQuery {
    principalId: string;
    conversationId: string;
    runId?: string;
    cursor?: string;
    limit?: number;
    includeTerminal?: boolean;
}

export type PendingToolListOptions = Pick<PendingToolQuery, 'cursor' | 'limit' | 'includeTerminal'>;
export interface PendingToolPage { items: PendingToolSummary[]; nextCursor: string | null }

export interface PendingToolStorePort {
    readonly persistence: 'memory' | 'durable';
    get(pendingToolId: string): Promise<PendingToolRecord | undefined>;
    put(record: PendingToolRecord, expectedRevision: number | null): Promise<PendingToolRecord>;
    list(query: PendingToolQuery): Promise<PendingToolPage>;
}

export interface PendingToolCompletion {
    pending: PendingToolSummary;
    ready: boolean;
    operationId: string;
    invocation: Pick<FrozenToolInvocation, 'name' | 'args' | 'argsHash'>;
    origin: Omit<FrozenToolInvocation, 'args' | 'roots' | 'protectedPaths' | 'approvalRequiredTools'>;
    toolResult?: ToolResult;
}

export function summarizePending(record: PendingToolRecord): PendingToolSummary {
    const origin = record.frozen;
    return { pendingToolId: record.pendingToolId, approvalId: record.approvalId, principalId: origin.principalId,
        conversationId: origin.conversationId, runId: origin.runId, rootRunId: origin.rootRunId,
        state: record.state, revision: record.revision, executionEpoch: record.executionEpoch, originalRunEpoch: origin.originalRunEpoch,
        policyRevision: origin.policyRevision, name: origin.name, argsHash: origin.argsHash,
        callId: origin.callId, stepId: origin.stepId, actionId: origin.actionId, attemptId: origin.attemptId,
        createdAt: record.createdAt, updatedAt: record.updatedAt, expiresAt: record.expiresAt };
}

export const TERMINAL_PENDING_STATES: readonly PendingToolState[] = ['completed', 'denied', 'cancelled', 'timed_out', 'failed'];

export function assertPendingTransition(record: PendingToolRecord, previous?: PendingToolRecord): void {
    if (!Number.isSafeInteger(record.executionEpoch) || record.executionEpoch < record.frozen.originalRunEpoch
        || !Number.isFinite(Date.parse(record.expiresAt))) throw new AgentFault('INVALID_PARAMS', '原工具等待项的代际或期限无效');
    if (TERMINAL_PENDING_STATES.includes(record.state) && !record.result) throw new AgentFault('INVALID_PARAMS', '原工具最终状态需要配对结果');
    if (!previous) {
        if (record.state !== 'awaiting_approval' || record.result || record.claimToken || record.cancelReason) throw new AgentFault('INVALID_PARAMS', '原工具等待项必须从awaiting_approval开始');
        return;
    }
    const narrowedDeadline = !previous.approvalId && Boolean(record.approvalId) && previous.state === 'awaiting_approval' && record.state === 'awaiting_approval'
        && Date.parse(record.expiresAt) <= Date.parse(previous.expiresAt);
    if (canonicalJson(previous.frozen) !== canonicalJson(record.frozen) || previous.createdAt !== record.createdAt || (previous.expiresAt !== record.expiresAt && !narrowedDeadline)
        || (previous.approvalId && previous.approvalId !== record.approvalId)) throw new AgentFault('COMMAND_ID_REUSED', '原工具调用与冻结参数已经固定');
    if (record.executionEpoch < previous.executionEpoch || (previous.cancelReason && previous.cancelReason !== record.cancelReason)) throw new AgentFault('POLICY_CHANGED', '原工具执行代际或取消决定变化');
    if (TERMINAL_PENDING_STATES.includes(previous.state)) {
        if (canonicalJson({ ...previous, revision: 0, updatedAt: '' }) !== canonicalJson({ ...record, revision: 0, updatedAt: '' })) throw new AgentFault('COMMAND_ID_REUSED', '原工具最终结果已经固定');
        return;
    }
    const transitions: Record<string, PendingToolState[]> = {
        awaiting_approval: ['awaiting_approval', 'executing', 'completed', 'denied', 'cancelled', 'timed_out', 'failed', 'unknown'],
        executing: ['executing', 'cancelling', 'completed', 'cancelled', 'timed_out', 'failed', 'unknown'],
        cancelling: ['cancelling', 'completed', 'cancelled', 'timed_out', 'failed', 'unknown'],
        unknown: ['unknown', 'executing', 'completed', 'cancelled', 'timed_out', 'failed'],
    };
    if (!transitions[previous.state]?.includes(record.state) || (record.state === 'executing' && record.cancelReason)
        || (previous.claimToken && record.claimToken !== previous.claimToken && record.executionEpoch <= previous.executionEpoch)) throw new AgentFault('PENDING_TOOL_STATE_CONFLICT', '原工具等待项状态转移无效');
}
