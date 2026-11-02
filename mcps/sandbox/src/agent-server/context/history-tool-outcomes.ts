import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson, operationHash } from '../protocol.js';
import type { JsonObject } from '../protocol.js';
import type { HistoryItem, StorePort, StoreRecord } from '../storage/port.js';
import type { NormalizedResponse, ToolCall, ToolResult } from '../providers/types.js';
import { objectValue, stringValue } from '../providers/assemble.js';
import { matchesToolActionId } from '../tool-action-identity.js';
import { readLifecycleBranchToolEvidence } from '../conversation-lifecycle/branch-tool-outcomes.js';
import type { BranchToolEvidence, BranchToolEvidenceQuery } from '../conversation-lifecycle/branch-tool-outcomes.js';
import { checkAbort, ContextFault } from './errors.js';

export interface HistoricalToolGroup {
    viewConversationId: string;
    conversationId: string;
    runId: string;
    runEpoch: number;
    roundId: string;
    stepId: string;
    item: HistoryItem;
    response: NormalizedResponse;
    results: ToolResult[];
    signal: AbortSignal;
}

export type HistoricalToolResultResolver = (group: HistoricalToolGroup) => Promise<ToolResult[] | null>;
type HistoryOutcomeStore = Pick<StorePort, 'getRecord' | 'getReceipt' | 'readContent' | 'readArtifact'>;

export function historicalToolGroup(conversationId: string, item: HistoryItem, content: Record<string, unknown>,
    response: NormalizedResponse, results: ToolResult[], signal: AbortSignal): HistoricalToolGroup | null {
    if (results.length >= response.toolCalls.length || new Set(results.map(result => result.callId)).size !== results.length
        || new Set(response.toolCalls.map(call => call.callId)).size !== response.toolCalls.length
        || results.some(result => !response.toolCalls.some(call => call.callId === result.callId && call.name === result.name))) return null;
    const runId = stringValue(content.runId) ?? item.runId;
    const roundId = stringValue(content.roundId) ?? item.roundId;
    const stepId = stringValue(content.stepId) ?? item.stepId;
    const runEpoch = typeof content.runEpoch === 'number' ? content.runEpoch : item.runEpoch;
    if (!runId || !roundId || !stepId || runEpoch === null || !Number.isSafeInteger(runEpoch) || runEpoch < 0
        || item.runId !== runId || item.runEpoch !== runEpoch || item.roundId !== roundId || item.stepId !== stepId
        || item.attemptId && item.attemptId !== response.attemptId) return null;
    return { viewConversationId: conversationId, conversationId: stringValue(content.conversationId) ?? conversationId, runId, runEpoch, roundId, stepId,
        item, response, results, signal };
}

function sourceFor(group: HistoricalToolGroup, record: StoreRecord, call: ToolCall, frozen: boolean): JsonObject {
    return { viewConversationId: group.viewConversationId, conversationId: group.conversationId, runId: group.runId, runEpoch: group.runEpoch,
        roundId: group.roundId, stepId: group.stepId, callId: call.callId, attemptId: group.response.attemptId,
        historyItemId: group.item.itemId, historyObjectHash: group.item.objectRef.hash,
        evidenceSource: { kind: frozen ? 'lifecycle_branch_snapshot' : 'source_run_record',
            conversationId: frozen ? group.viewConversationId : group.conversationId },
        terminalRecord: { kind: 'run', revision: record.revision, runEpoch: record.value.runEpoch as number,
            state: record.value.state as string, updatedAt: String(record.value.updatedAt ?? ''),
            stopReason: typeof record.value.stopReason === 'string' ? record.value.stopReason : null } };
}

function explicitNotStarted(group: HistoricalToolGroup, record: StoreRecord, call: ToolCall): boolean {
    const failure = objectValue(record.value.failure);
    const error = objectValue(failure?.error);
    if (!failure || failure.cleanupEvidence !== 'no_resources_created' || error?.mayHaveStarted === true) return false;
    const current = objectValue(objectValue(objectValue(error?.details)?.executionProgress)?.currentOperation);
    const facts = failure.acceptance === 'not_sent' ? failure : current?.acceptance === 'not_sent' ? current : null;
    return !!facts && typeof facts.actionId === 'string' && facts.attemptId === group.response.attemptId
        && matchesToolActionId(facts.actionId, { runId: group.runId, stepId: group.stepId,
            attemptId: group.response.attemptId, callId: call.callId });
}

function missingEvidence(group: HistoricalToolGroup, reason: string, details?: Record<string, unknown>): ContextFault {
    return new ContextFault('HISTORY_EXECUTION_EVIDENCE_MISSING', '历史工具结果缺失，原执行终态证据不可用，须先核对来源状态',
        { ...details, viewConversationId: group.viewConversationId, sourceConversationId: group.conversationId,
            runId: group.runId, runEpoch: group.runEpoch, roundId: group.roundId, stepId: group.stepId,
            callIds: group.response.toolCalls.filter(call => !group.results.some(result => result.callId === call.callId)).map(call => call.callId),
            historyItemId: group.item.itemId, historyObjectHash: group.item.objectRef.hash, reason });
}

async function frozenEvidence(store: HistoryOutcomeStore, group: HistoricalToolGroup): Promise<BranchToolEvidence | undefined> {
    if (group.conversationId === group.viewConversationId) return undefined;
    const query: BranchToolEvidenceQuery = { viewConversationId: group.viewConversationId, conversationId: group.conversationId,
        runId: group.runId, runEpoch: group.runEpoch, roundId: group.roundId, stepId: group.stepId,
        attemptId: group.response.attemptId, historyContentId: group.item.contentId, historyObjectHash: group.item.objectRef.hash };
    let evidence: BranchToolEvidence | undefined;
    try { evidence = await readLifecycleBranchToolEvidence(store, query, group.signal); }
    catch (error) {
        if (error instanceof AgentFault && error.code === 'HISTORY_EXECUTION_EVIDENCE_MISSING') {
            throw missingEvidence(group, 'frozen_source_not_present', error.details);
        }
        throw error;
    }
    checkAbort(group.signal);
    if (!evidence) throw missingEvidence(group, 'frozen_source_not_present');
    return evidence;
}

async function readRecordedResult(store: HistoryOutcomeStore, group: HistoricalToolGroup, call: ToolCall,
    frozen?: BranchToolEvidence): Promise<ToolResult | null> {
    const operationId = `tool:${group.response.attemptId}:${call.callId}`;
    const clientCommandId = createHash('sha256').update(canonicalJson([group.runId, group.runEpoch, operationId])).digest('hex');
    const key = { principalId: 'sandbox-agent-runtime', clientId: 'executor', conversationId: group.conversationId, clientCommandId };
    const captured = frozen?.calls.find(entry => entry.callId === call.callId && entry.name === call.name);
    if (frozen && !captured) throw missingEvidence(group, 'frozen_call_not_present', { callId: call.callId });
    const receipt = frozen ? captured!.receipt : await store.getReceipt(key);
    checkAbort(group.signal);
    if (!receipt?.result.ok) return null;
    if (receipt.key.principalId !== key.principalId || receipt.key.clientId !== key.clientId
        || receipt.key.conversationId !== key.conversationId || receipt.key.clientCommandId !== key.clientCommandId) {
        throw new ContextFault('NATIVE_PAIRING', '历史工具回执身份不一致', { itemId: group.item.itemId, callId: call.callId });
    }
    const data = objectValue(receipt.result.data);
    if (!data || data.disposition === 'late') return null;
    if (data.stepId !== group.stepId || typeof data.contentId !== 'string'
        || frozen && captured?.content?.contentId !== data.contentId) {
        throw new ContextFault('NATIVE_PAIRING', '历史工具回执缺少原步骤及内容身份', { itemId: group.item.itemId, callId: call.callId });
    }
    const value = objectValue(frozen ? captured?.content?.value : await store.readContent(group.conversationId, data.contentId));
    checkAbort(group.signal);
    const result = objectValue(value?.result);
    if (!value || value.kind !== 'tool' || value.conversationId !== group.conversationId || value.runId !== group.runId
        || value.runEpoch !== group.runEpoch || value.roundId !== group.roundId || value.stepId !== group.stepId
        || value.originStepId !== group.stepId || value.operationId !== operationId || !result
        || group.item.providerProtocol && value.protocol !== group.item.providerProtocol
        || result.callId !== call.callId || result.name !== call.name || typeof value.actionId !== 'string'
        || !matchesToolActionId(value.actionId, { runId: group.runId, stepId: group.stepId,
            attemptId: group.response.attemptId, callId: call.callId })) {
        throw new ContextFault('NATIVE_PAIRING', '历史工具回执与原调用身份不一致', { itemId: group.item.itemId, callId: call.callId });
    }
    const written = { kind: value.kind, operationId: value.operationId, stepId: value.stepId,
        originStepId: value.originStepId, actionId: value.actionId, protocol: value.protocol, result: value.result };
    if (receipt.operationHash !== operationHash('executor.recordStep', written)) {
        throw new ContextFault('NATIVE_PAIRING', '历史工具回执与原工具正文哈希不一致', { itemId: group.item.itemId, callId: call.callId });
    }
    return value.result as unknown as ToolResult;
}

export function createHistoricalToolResultResolver(store: HistoryOutcomeStore): HistoricalToolResultResolver {
    const runs = new Map<string, Promise<StoreRecord | undefined>>();
    return async group => {
        checkAbort(group.signal);
        const frozen = await frozenEvidence(store, group);
        const key = { conversationId: group.conversationId, kind: 'run' as const, id: group.runId };
        let record: StoreRecord | undefined;
        if (frozen) record = frozen.run;
        else {
            const cacheKey = canonicalJson([group.conversationId, group.runId]);
            let reading = runs.get(cacheKey);
            if (!reading) { reading = store.getRecord(key); runs.set(cacheKey, reading); }
            record = await reading;
        }
        checkAbort(group.signal);
        if (!record) throw missingEvidence(group, 'source_run_not_present');
        if (!['cancelled', 'failed', 'succeeded'].includes(String(record.value.state))
            || record.value.runId !== group.runId || record.value.conversationId !== group.conversationId
            || typeof record.value.runEpoch !== 'number' || record.value.runEpoch < group.runEpoch) return null;
        const step = frozen ? frozen.step : await store.getRecord({ conversationId: group.conversationId, kind: 'step', id: group.stepId });
        checkAbort(group.signal);
        if (step && (step.value.kind !== 'model' || step.value.runId !== group.runId || step.value.runEpoch !== group.runEpoch
            || step.value.complete !== true || step.value.canExecuteTools !== true
            || step.value.roundId !== group.roundId || step.value.stepId !== group.stepId || step.value.attemptId !== group.response.attemptId
            || !Array.isArray(step.value.toolCalls) || canonicalJson(step.value.toolCalls)
                !== canonicalJson(group.response.toolCalls.map(call => ({ callId: call.callId, name: call.name }))))) {
            throw new ContextFault('NATIVE_PAIRING', '历史工具组与原模型步骤身份不一致', { itemId: group.item.itemId });
        }
        const results: ToolResult[] = [];
        for (const call of group.response.toolCalls) {
            const original = group.results.find(result => result.callId === call.callId);
            if (original) { results.push(original); continue; }
            const recorded = await readRecordedResult(store, group, call, frozen);
            if (recorded) { results.push(recorded); continue; }
            const notStarted = !!step && explicitNotStarted(group, record, call);
            results.push({ callId: call.callId, name: call.name, isError: true,
                result: { kind: 'historical_tool_outcome', derivedForSendView: true,
                    outcome: notStarted ? record.value.state === 'cancelled' ? 'cancelled_not_started' : 'terminated_not_started' : 'result_unknown',
                    runState: String(record.value.state),
                    instruction: notStarted ? '原执行已终止，该调用有明确未启动记录，未执行此工具。'
                        : '原执行已终止，工具结果未知，副作用可能已经发生。继续前先核对原状态和回执，勿重跑该调用。',
                    source: sourceFor(group, record, call, !!frozen) } });
        }
        if (!frozen) {
            const current = await store.getRecord(key);
            checkAbort(group.signal);
            if (!current || current.revision !== record.revision) throw new ContextFault('PARENT_STALE', '历史执行终态在构建视图期间变化');
        }
        return results;
    };
}
