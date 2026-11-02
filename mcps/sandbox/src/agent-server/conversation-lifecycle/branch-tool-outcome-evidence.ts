import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonValue } from '../protocol.js';
import type { ConversationData } from '../runtime.js';
import { MAX_PAGE_BYTES } from '../storage/internal.js';
import type { ReceiptKey, StorePort, StoreRecord } from '../storage/port.js';
import { matchesToolActionId } from '../tool-action-identity.js';
import { canonicalJsonByteChunks } from '../media/payload-codec.js';
import type { BranchHistoryManifest } from './contracts.js';
import type { BranchFrozenToolCall, BranchFrozenToolGroup, BranchToolContentReference, BranchToolEvidence,
    BranchToolEvidenceQuery } from './branch-tool-outcome-contracts.js';

export type BranchToolEvidenceStore = Pick<StorePort, 'getRecord' | 'readContent' | 'readArtifact'>;

export function branchEvidenceSignal(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AgentFault('E_CANCELLED', '分支工具来源读取已取消');
}

export function branchEvidenceObject(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function branchEvidenceHash(value: unknown): string {
    const checksum = createHash('sha256');
    for (const chunk of canonicalJsonByteChunks(value)) checksum.update(chunk);
    return checksum.digest('hex');
}

export function lifecycleToolReceiptKey(source: BranchFrozenToolGroup['source'], callId: string): ReceiptKey {
    return { principalId: 'sandbox-agent-runtime', clientId: 'executor', conversationId: source.conversationId,
        clientCommandId: branchEvidenceHash([source.runId, source.runEpoch, `tool:${source.attemptId}:${callId}`]) };
}

export async function readBranchEvidenceContent(store: Pick<StorePort, 'readContent' | 'readArtifact'>, conversationId: string,
    contentId: string, expected?: BranchToolContentReference, signal?: AbortSignal): Promise<BranchToolContentReference & { value: JsonValue }> {
    branchEvidenceSignal(signal);
    const value = await store.readContent(conversationId, contentId);
    if (value === undefined) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '分支工具来源正文缺失', { conversationId, contentId });
    let offset = 0, totalBytes = -1, objectHash = '';
    const checksum = createHash('sha256');
    do {
        branchEvidenceSignal(signal);
        const chunk = await store.readArtifact({ conversationId, artifactId: contentId, offset, maxBytes: MAX_PAGE_BYTES });
        const bytes = Buffer.from(chunk.dataBase64, 'base64'), nextOffset = offset + bytes.length;
        if (chunk.artifactId !== contentId || chunk.offset !== offset || !Number.isSafeInteger(chunk.totalBytes) || chunk.totalBytes < 0
            || totalBytes !== -1 && totalBytes !== chunk.totalBytes || objectHash && objectHash !== chunk.sha256
            || nextOffset > chunk.totalBytes || chunk.complete !== (nextOffset === chunk.totalBytes)
            || chunk.nextOffset !== (chunk.complete ? null : nextOffset) || !chunk.complete && bytes.length === 0) {
            throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '分支工具来源原文分片不完整', { conversationId, contentId });
        }
        totalBytes = chunk.totalBytes; objectHash = chunk.sha256; checksum.update(bytes); offset = nextOffset;
        if (chunk.complete) break;
    } while (true);
    branchEvidenceSignal(signal);
    const canonicalChecksum = createHash('sha256');
    let canonicalBytes = 0;
    for (const chunk of canonicalJsonByteChunks(value)) {
        branchEvidenceSignal(signal); canonicalChecksum.update(chunk); canonicalBytes += chunk.length;
    }
    if (offset !== totalBytes || checksum.digest('hex') !== objectHash || canonicalChecksum.digest('hex') !== objectHash
        || canonicalBytes !== totalBytes
        || expected && (expected.contentId !== contentId || expected.objectHash !== objectHash || expected.rawBytes !== totalBytes)) {
        throw new AgentFault('E_REFERENCE_CHANGED', '分支工具来源正文的完整SHA256或长度不同', { conversationId, contentId });
    }
    return { contentId, objectHash, rawBytes: totalBytes, value };
}

export function validateBranchTerminal(source: BranchFrozenToolGroup['source'], run: StoreRecord, step: StoreRecord | null,
    toolCalls: { callId: string; name: string }[]): void {
    if (run.key.kind !== 'run' || run.key.id !== source.runId || run.key.conversationId !== source.conversationId
        || !Number.isSafeInteger(run.revision) || run.revision < 1 || run.value.runId !== source.runId
        || run.value.conversationId !== source.conversationId || !['cancelled', 'failed', 'succeeded'].includes(String(run.value.state))
        || !Number.isSafeInteger(run.value.runEpoch) || Number(run.value.runEpoch) < source.runEpoch) {
        throw new AgentFault('HISTORY_EXECUTION_EVIDENCE_MISSING', '分支缺结果工具组没有可核的原执行终态', { ...source });
    }
    if (step && (step.key.kind !== 'step' || step.key.id !== source.stepId || step.key.conversationId !== source.conversationId
        || !Number.isSafeInteger(step.revision) || step.revision < 1 || step.value.kind !== 'model' || step.value.runId !== source.runId
        || step.value.runEpoch !== source.runEpoch || step.value.complete !== true || step.value.canExecuteTools !== true
        || step.value.roundId !== source.roundId || step.value.stepId !== source.stepId || step.value.attemptId !== source.attemptId
        || canonicalJson(step.value.toolCalls) !== canonicalJson(toolCalls))) {
        throw new AgentFault('E_REFERENCE_CHANGED', '分支工具组与原模型步骤身份不同', { ...source });
    }
}

export function validateBranchToolReceipt(source: BranchFrozenToolGroup['source'], call: BranchFrozenToolCall,
    value: JsonValue | null, protocol?: string | null): void {
    const receipt = call.receipt;
    if (!receipt) {
        if (call.content || value !== null) throw new AgentFault('E_REFERENCE_CHANGED', '缺少原工具回执的冻结来源含额外结果');
        return;
    }
    if (canonicalJson(receipt.key) !== canonicalJson(lifecycleToolReceiptKey(source, call.callId))) {
        throw new AgentFault('E_REFERENCE_CHANGED', '分支原工具回执身份不同');
    }
    const data = branchEvidenceObject(receipt.result.data);
    if (!receipt.result.ok || data?.disposition === 'late') {
        if (call.content || value !== null) throw new AgentFault('E_REFERENCE_CHANGED', '未生效原工具回执含有效结果');
        return;
    }
    const content = branchEvidenceObject(value), result = branchEvidenceObject(content?.result);
    if (!data || data.stepId !== source.stepId || data.contentId !== call.content?.contentId || !content || !result
        || content.kind !== 'tool' || content.conversationId !== source.conversationId || content.runId !== source.runId
        || content.runEpoch !== source.runEpoch || content.roundId !== source.roundId || content.stepId !== source.stepId
        || content.originStepId !== source.stepId || content.operationId !== `tool:${source.attemptId}:${call.callId}`
        || protocol && content.protocol !== protocol || result.callId !== call.callId || result.name !== call.name
        || typeof content.actionId !== 'string' || !matchesToolActionId(content.actionId, { runId: source.runId, stepId: source.stepId,
            attemptId: source.attemptId, callId: call.callId })
        || receipt.operationHash !== branchEvidenceHash({ method: 'executor.recordStep', params: { kind: content.kind, operationId: content.operationId,
            stepId: content.stepId, originStepId: content.originStepId, actionId: content.actionId, protocol: content.protocol, result: content.result } })) {
        throw new AgentFault('E_REFERENCE_CHANGED', '分支工具回执、原调用与结果正文不一致', { ...source, callId: call.callId });
    }
}

export async function readLifecycleBranchToolEvidence(store: BranchToolEvidenceStore, query: BranchToolEvidenceQuery,
    signal?: AbortSignal): Promise<BranchToolEvidence | undefined> {
    branchEvidenceSignal(signal);
    if (query.conversationId === query.viewConversationId) return undefined;
    const owner = await store.getRecord<ConversationData>({ conversationId: query.viewConversationId, kind: 'conversation', id: query.viewConversationId });
    const declared = branchEvidenceObject(owner?.value.options?.branchSource);
    if (!owner || !declared) throw new AgentFault('HISTORY_EXECUTION_EVIDENCE_MISSING', '目标缺少该原工具组的分支冻结来源',
        { viewConversationId: query.viewConversationId, conversationId: query.conversationId, runId: query.runId, stepId: query.stepId });
    const manifest = await store.readContent(query.viewConversationId, `lifecycle:source:${query.viewConversationId}`) as
        (BranchHistoryManifest & { provenance?: unknown }) | undefined;
    branchEvidenceSignal(signal);
    if (!manifest) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '分支冻结清单缺失');
    const { sourceHash, provenance: _provenance, ...frozen } = manifest;
    if (manifest.sourceConversationId !== declared.conversationId || sourceHash !== declared.manifestHash || branchEvidenceHash(frozen) !== sourceHash) {
        throw new AgentFault('E_REFERENCE_CHANGED', '分支工具来源与本分支不可变清单不同');
    }
    const { viewConversationId: _viewConversationId, ...source } = query;
    const group = manifest.toolOutcomeProvenance?.groups.find(entry => canonicalJson(entry.source) === canonicalJson(source));
    if (!group) {
        if (query.conversationId !== query.viewConversationId) throw new AgentFault('HISTORY_EXECUTION_EVIDENCE_MISSING',
            '本分支缺少该原工具组的冻结终态来源', { ...source, viewConversationId: query.viewConversationId });
        return undefined;
    }
    const item = manifest.items.find(entry => entry.contentId === source.historyContentId && entry.objectHash === source.historyObjectHash);
    if (!item || item.runId !== source.runId || item.runEpoch !== source.runEpoch || item.roundId !== source.roundId
        || item.stepId !== source.stepId || item.attemptId !== source.attemptId) throw new AgentFault('E_REFERENCE_CHANGED', '冻结工具组缺少对应原历史项目');
    const model = await readBranchEvidenceContent(store, query.viewConversationId, source.historyContentId,
        { contentId: source.historyContentId, objectHash: source.historyObjectHash, rawBytes: item.rawBytes }, signal);
    const body = branchEvidenceObject(model.value), response = branchEvidenceObject(body?.response);
    const toolCalls = response?.toolCalls as { callId: string; name: string }[] | undefined;
    if (!body || body.kind !== 'model' || body.conversationId !== source.conversationId || body.runId !== source.runId
        || body.runEpoch !== source.runEpoch || body.roundId !== source.roundId || body.stepId !== source.stepId
        || response?.attemptId !== source.attemptId || !Array.isArray(toolCalls)) throw new AgentFault('E_REFERENCE_CHANGED', '冻结模型原文身份不同');
    validateBranchTerminal(source, group.run, group.step, toolCalls.map(call => ({ callId: call.callId, name: call.name })));
    if (new Set(group.calls.map(call => call.callId)).size !== group.calls.length || group.calls.some(call =>
        !toolCalls.some(original => original.callId === call.callId && original.name === call.name))) throw new AgentFault('E_REFERENCE_CHANGED', '冻结缺结果调用列表不同');
    const calls: BranchToolEvidence['calls'] = [];
    for (const call of group.calls) {
        const content = call.content ? await readBranchEvidenceContent(store, query.viewConversationId, call.content.contentId, call.content, signal) : null;
        validateBranchToolReceipt(source, call, content?.value ?? null, item.providerProtocol);
        calls.push({ ...structuredClone(call), content });
    }
    branchEvidenceSignal(signal);
    return { run: structuredClone(group.run), step: structuredClone(group.step), calls };
}
