import { AgentFault, canonicalJson } from '../protocol.js';
import type { StorePort, StoreRecord, TransitionExpected } from '../storage/port.js';
import type { BranchHistoryItem } from './contracts.js';
import type { BranchFrozenToolGroup, BranchToolOutcomeProvenance } from './branch-tool-outcome-contracts.js';
import { branchEvidenceObject, branchEvidenceSignal, lifecycleToolReceiptKey, readBranchEvidenceContent,
    readLifecycleBranchToolEvidence, validateBranchTerminal, validateBranchToolReceipt } from './branch-tool-outcome-evidence.js';

export { readLifecycleBranchToolEvidence } from './branch-tool-outcome-evidence.js';
export type * from './branch-tool-outcome-contracts.js';

function projection(value: Record<string, unknown>, names: string[]): Record<string, unknown> {
    return Object.fromEntries(names.filter(name => value[name] !== undefined).map(name => [name, structuredClone(value[name])]));
}

function frozenRun(record: StoreRecord): StoreRecord {
    const value = projection(record.value, ['conversationId', 'runId', 'runEpoch', 'state', 'updatedAt', 'stopReason']);
    const failure = branchEvidenceObject(record.value.failure);
    if (failure) {
        const saved = projection(failure, ['acceptance', 'cleanupEvidence', 'actionId', 'attemptId']);
        const error = branchEvidenceObject(failure.error);
        if (error) {
            const retained = projection(error, ['code', 'mayHaveStarted']);
            const operation = branchEvidenceObject(branchEvidenceObject(branchEvidenceObject(error.details)?.executionProgress)?.currentOperation);
            if (operation) retained.details = { executionProgress: { currentOperation: projection(operation, ['acceptance', 'actionId', 'attemptId']) } };
            saved.error = retained;
        }
        value.failure = saved;
    }
    return { key: { ...record.key }, revision: record.revision, value };
}

function frozenStep(record: StoreRecord | undefined): StoreRecord | null {
    return record ? { key: { ...record.key }, revision: record.revision,
        value: projection(record.value, ['kind', 'runId', 'runEpoch', 'roundId', 'stepId', 'actionId', 'attemptId', 'contentId',
            'complete', 'canExecuteTools', 'toolCalls', 'resolvedCallIds']) } : null;
}

export async function captureBranchToolOutcomeProvenance(store: StorePort, conversationId: string, items: BranchHistoryItem[],
    signal?: AbortSignal): Promise<BranchToolOutcomeProvenance | undefined> {
    const groups: BranchFrozenToolGroup[] = [], expected = new Map<string, TransitionExpected>();
    let pending: { item: BranchHistoryItem; body: Record<string, unknown>; response: Record<string, unknown>;
        calls: { callId: string; name: string }[]; resolved: Set<string> } | undefined;
    const remember = (entry: TransitionExpected): void => {
        const key = canonicalJson(entry.key), previous = expected.get(key);
        if (previous && previous.revision !== entry.revision) throw new AgentFault('REVISION_CONFLICT', '分支工具来源记录在冻结期间变化');
        expected.set(key, entry);
    };
    const flush = async (): Promise<void> => {
        if (!pending) return;
        const { item, body, response, calls, resolved } = pending;
        pending = undefined;
        const missing = calls.filter(call => !resolved.has(call.callId));
        const source = { conversationId: String(body.conversationId ?? conversationId), runId: item.runId!, runEpoch: item.runEpoch!,
            roundId: item.roundId!, stepId: item.stepId!, attemptId: String(response.attemptId), historyContentId: item.contentId, historyObjectHash: item.objectHash };
        if (!item.runId || !item.roundId || !item.stepId || !Number.isSafeInteger(item.runEpoch) || Number(item.runEpoch) < 0
            || body.runId !== item.runId || body.runEpoch !== item.runEpoch || body.roundId !== item.roundId || body.stepId !== item.stepId
            || typeof response.attemptId !== 'string' || response.attemptId !== item.attemptId || response.complete !== true) {
            throw new AgentFault('E_REFERENCE_CHANGED', '缺结果工具组缺少精确原执行身份', { contentId: item.contentId });
        }
        if (!missing.length) return;
        if (source.conversationId !== conversationId) {
            const inherited = await readLifecycleBranchToolEvidence(store, { viewConversationId: conversationId, ...source }, signal);
            if (!inherited) throw new AgentFault('HISTORY_EXECUTION_EVIDENCE_MISSING', '原分支缺少可独立保留的工具终态来源', { ...source });
            groups.push({ source, run: inherited.run, step: inherited.step, calls: missing.map(call => {
                const original = inherited.calls.find(entry => entry.callId === call.callId && entry.name === call.name);
                if (!original) throw new AgentFault('HISTORY_EXECUTION_EVIDENCE_MISSING', '原分支没有该缺结果调用的冻结来源');
                const { content, ...retained } = original;
                return { ...retained, content: content ? { contentId: content.contentId, objectHash: content.objectHash, rawBytes: content.rawBytes } : null };
            }) });
            return;
        }
        const runKey = { conversationId, kind: 'run' as const, id: source.runId }, stepKey = { conversationId, kind: 'step' as const, id: source.stepId };
        const run = await store.getRecord(runKey), step = await store.getRecord(stepKey);
        branchEvidenceSignal(signal);
        if (!run) throw new AgentFault('HISTORY_EXECUTION_EVIDENCE_MISSING', '所选历史缺少原执行终态记录', { ...source });
        validateBranchTerminal(source, run, step ?? null, calls);
        remember({ key: runKey, revision: run.revision }); remember({ key: stepKey, revision: step?.revision ?? null });
        const captured: BranchFrozenToolGroup = { source, run: frozenRun(run), step: frozenStep(step), calls: [] };
        for (const call of missing) {
            const receipt = await store.getReceipt(lifecycleToolReceiptKey(source, call.callId));
            branchEvidenceSignal(signal);
            const data = branchEvidenceObject(receipt?.result.data);
            const content = receipt?.result.ok && data?.disposition !== 'late'
                ? await readBranchEvidenceContent(store, conversationId, String(data?.contentId ?? ''), undefined, signal) : null;
            const frozen = { callId: call.callId, name: call.name, receipt: receipt ? structuredClone(receipt) : null,
                content: content ? { contentId: content.contentId, objectHash: content.objectHash, rawBytes: content.rawBytes } : null };
            validateBranchToolReceipt(source, frozen, content?.value ?? null, item.providerProtocol);
            captured.calls.push(frozen);
        }
        groups.push(captured);
    };
    for (const item of items) {
        branchEvidenceSignal(signal);
        if (item.role === 'tool') {
            if (!pending) continue;
            const body = branchEvidenceObject(await store.readContent(conversationId, item.contentId)), result = branchEvidenceObject(body?.result);
            if (!body || body.kind !== 'tool' || item.stepId !== pending.item.stepId || item.roundId !== pending.item.roundId
                || item.runId !== pending.item.runId || item.runEpoch !== pending.item.runEpoch
                || body.conversationId !== (pending.body.conversationId ?? conversationId) || body.runId !== item.runId
                || body.runEpoch !== item.runEpoch || body.roundId !== item.roundId || body.stepId !== item.stepId || body.originStepId !== item.stepId
                || item.attemptId !== undefined && item.attemptId !== null && item.attemptId !== pending.response.attemptId
                || item.providerProtocol && body.protocol !== item.providerProtocol
                || item.actionId !== undefined && item.actionId !== null && body.actionId !== item.actionId
                || item.callId !== undefined && item.callId !== null && result?.callId !== item.callId
                || typeof result?.callId !== 'string' || pending.resolved.has(result.callId)
                || !pending.calls.some(call => call.callId === result.callId && call.name === result.name)) {
                throw new AgentFault('E_REFERENCE_CHANGED', '分支历史的原工具组配对不同', { contentId: item.contentId });
            }
            pending.resolved.add(result.callId); continue;
        }
        await flush();
        if (item.role !== 'assistant') continue;
        const body = branchEvidenceObject(await store.readContent(conversationId, item.contentId)), response = branchEvidenceObject(body?.response);
        if (body?.kind !== 'model' || !Array.isArray(response?.toolCalls) || response.toolCalls.length === 0) continue;
        const calls = response.toolCalls.map(value => {
            const call = branchEvidenceObject(value);
            if (typeof call?.callId !== 'string' || typeof call?.name !== 'string') throw new AgentFault('E_REFERENCE_CHANGED', '原工具调用身份缺失');
            return { callId: call.callId, name: call.name };
        });
        if (new Set(calls.map(call => call.callId)).size !== calls.length) throw new AgentFault('E_REFERENCE_CHANGED', '原工具组调用身份重复');
        pending = { item, body, response, calls, resolved: new Set() };
    }
    await flush(); branchEvidenceSignal(signal);
    return groups.length ? { schemaVersion: 1, groups, expected: [...expected.values()] } : undefined;
}

