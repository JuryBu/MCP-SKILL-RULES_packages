import type { AgentError, RetainPolicy, RpcResult } from '../protocol.js';
import type { ApprovalTicket } from '../security/approvals.js';
import type { OwnedResource } from '../resources/registry.js';
import type { ProviderProtocol } from '../providers/types.js';
import type { PendingToolSummary } from './pending-types.js';

export type EffectKind = 'read' | 'write' | 'network' | 'process' | 'delete' | 'configuration' | 'external';
export type ModelEffect = 'none' | 'invokes_model' | 'unknown';

export interface TrustedToolContext {
    runId: string;
    conversationId: string;
    roots: readonly string[];
    signal: AbortSignal;
    principalId?: string;
    callerConversationId?: string;
    callerHost?: string;
    toolSchemaHash?: string;
    rootRunId?: string;
    roundId?: string;
    stepId?: string;
    callId?: string;
    providerCallId?: string | null;
    providerProtocol?: ProviderProtocol;
    modelContentId?: string;
    rootBudgetId?: string;
    actionId?: string;
    attemptId?: string;
    runEpoch?: number;
    policyRevision?: number;
    retention?: RetainPolicy;
    protectedPaths?: readonly string[];
    approvalId?: string;
    approvalRequiredTools?: readonly string[];
    deadlineAt?: string;
    pendingExecution?: { pendingToolId: string; claimToken: string };
    command?: {
        controlRoot: string;
        aclApprovalId: string;
        approvedAclRoots: readonly string[];
        policyRevision: number;
        expiresAt: string;
    };
    assertCurrent?: () => void | Promise<void>;
}

export interface ExecutionToolContext extends Omit<TrustedToolContext, 'roots'> {
    writeRoots: readonly string[];
    roots?: readonly string[];
}

export type ToolExecutionContext = TrustedToolContext | ExecutionToolContext;

export interface ToolCleanupResult {
    cleanupState: 'released' | 'unconfirmed';
    resources: OwnedResource[];
    unresolvedResourceIds: string[];
    error?: AgentError;
}

export interface BoundToolContext extends TrustedToolContext {
    principalId: string;
    rootRunId: string;
    roundId: string;
    actionId: string;
    attemptId: string;
    runEpoch: number;
    policyRevision: number;
    retention: RetainPolicy;
}

export interface ModelFunctionSchema {
    type: 'function';
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface ToolCatalogEntry {
    toolId: string;
    serviceId: string;
    name: string;
    summary: string;
    effectKinds: readonly EffectKind[];
    modelEffect: ModelEffect;
    resourceKind: string | null;
    schemaHash: string | null;
    adapterVersion: string;
    availability: 'available' | 'unavailable' | 'disabled';
    reason: string | null;
}

export type ToolExecutionResult<Data = unknown> = RpcResult<Data> & {
    error?: AgentError & { actionId: string; attemptId: string };
    approval?: ApprovalTicket;
    disposition?: 'completed' | 'awaiting_approval';
    pendingTool?: PendingToolSummary;
};
