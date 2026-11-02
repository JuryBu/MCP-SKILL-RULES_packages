import type { JsonValue, RpcResult } from '../protocol.js';
import type { BoundToolContext } from '../tools/types.js';
import type { ModelRuleDocument } from './rules.js';

export interface ChildLimits {
    wallMs: number;
    maxModelCalls: number;
    maxCostMicros: number | null;
    maxContextTokens: number;
}

export interface PreparedChild {
    childRunId: string;
    rootRunId: string;
    parentRunId: string;
    parentActionId: string;
    conversationId: string;
    task: string;
    taskKind: string;
    contextRefs: string[];
    contextTokens: number;
    writeRoots: string[];
    rulesSource: 'task' | 'api_global';
    rulesSourceId: string;
    rulesRevision: string;
    rulesHash: string;
    rulesDocument: ModelRuleDocument;
    profileId: string;
    profileRevision: number;
    modelId: string;
    reasoningEffort: string;
    maxOutputTokens: number;
    quotaLimitId: string | null;
    quotaScopeId: string | null;
    currency: string | null;
    quotaBindingSource?: 'profile' | 'trusted_root';
    policyRevision: number;
    runEpoch: number;
    depth: 1;
    allowInternalAgents: false;
    historyInheritance: 'independent';
    dispatchState: 'prepared';
}

export interface ChildSelection {
    content: JsonValue;
    contextTokens: number;
    provenance: JsonValue;
}

export interface ChildReceipt {
    childRunId: string;
    childConversationId: string;
    parentRunId: string;
    parentConversationId: string;
    rootRunId: string;
    budgetReservationId: string | null;
    rulesHash: string;
    state: string;
    terminalConfirmed: boolean;
    cleanupState: string;
    result: JsonValue | null;
    effectState: string;
    artifactRefs: JsonValue[];
    changedActionIds: string[];
    selectedContextRefs: string[];
    failure: JsonValue | null;
}

export interface InternalDelegationPort {
    replay(input: { taskKind: string; task: string; contextRefs: string[]; writeRoots: string[]; limits: ChildLimits }, context: BoundToolContext): Promise<ChildReceipt | null>;
    policy(context: BoundToolContext): Promise<{ options: Record<string, unknown>; maxContextTokens: number }>;
    start(plan: PreparedChild, limits: ChildLimits, selection: ChildSelection, context: BoundToolContext): Promise<ChildReceipt>;
    get(childRunId: string, context: BoundToolContext): Promise<ChildReceipt>;
    wait(childRunId: string, waitMs: number, context: BoundToolContext): Promise<ChildReceipt>;
    cancel(childRunId: string, context: BoundToolContext): Promise<ChildReceipt>;
}

export type DelegationToolResult = RpcResult<ChildReceipt>;
