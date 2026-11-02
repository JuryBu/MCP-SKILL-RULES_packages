import { AgentFault, canonicalJson } from '../protocol.js';
import type { RetainPolicy } from '../protocol.js';
import type { ConversationData } from '../runtime.js';
import type { StoreRecord } from '../storage/port.js';
import { recordRetention } from '../storage/retention.js';
import type { LifecycleFence } from './contracts.js';

export function lifecycleFence(record: StoreRecord<ConversationData>): LifecycleFence {
    const value = record.value;
    return { conversationId: value.conversationId, revision: record.revision, historyEpoch: value.historyEpoch,
        appendSeq: value.appendSeq, viewRevision: value.viewRevision, workspaceRevision: value.workspaceRevision,
        policyRevision: value.policyRevision, configRevision: value.configRevision };
}

export function lifecycleBusinessValue(value: ConversationData): Record<string, unknown> {
    const { updatedAt: _updatedAt, eventSeq: _eventSeq, ...business } = value;
    return business;
}

export function sameLifecycleFence(left: LifecycleFence, right: LifecycleFence): boolean {
    return canonicalJson(left) === canonicalJson(right);
}

export function plainRetention(policy: RetainPolicy): RetainPolicy {
    recordRetention({ retention: policy });
    return policy.mode === 'ttl' ? { mode: 'ttl', ttlDurationMs: policy.ttlDurationMs } : { mode: policy.mode };
}

export function convertedConversation(source: StoreRecord<ConversationData>, policy: RetainPolicy, confirmedAt: string): StoreRecord<ConversationData> {
    const selected = plainRetention(policy);
    const value = structuredClone(source.value);
    const confirmation = Date.parse(confirmedAt);
    if (!Number.isFinite(confirmation)) throw new AgentFault('INVALID_PARAMS', '转换确认时间无效');
    const previousEnd = value.retention.lastRunEnd === null ? confirmation : Date.parse(value.retention.lastRunEnd);
    if (!Number.isFinite(previousEnd)) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '原会话执行结束时间无效');
    value.retention = { ...selected, lastRunEnd: value.retention.lastRunEnd,
        lastClose: selected.mode === 'ttl' ? confirmedAt : value.retention.lastClose,
        expiresAt: selected.mode === 'ttl' ? new Date(Math.max(previousEnd, confirmation) + selected.ttlDurationMs!).toISOString() : null,
        activeRuns: 0 };
    value.policyRevision++;
    value.updatedAt = confirmedAt;
    return { key: { ...source.key }, revision: source.revision + 1, value };
}

export function branchConversation(source: StoreRecord<ConversationData>, input: {
    conversationId: string; eventGeneration: string; createdAt: string; title?: string; writeRoots: string[];
    ttlDurationMs?: number; appendSeq: number; sourceManifestHash: string; selectedRoundId: string;
}): StoreRecord<ConversationData> {
    const inherited = plainRetention(source.value.retention);
    if (inherited.mode === 'ttl' && input.ttlDurationMs === undefined) throw new AgentFault('RETENTION_DURATION_REQUIRED', 'TTL分支必须重新明确提供保存时长');
    if (inherited.mode !== 'ttl' && input.ttlDurationMs !== undefined) throw new AgentFault('INVALID_PARAMS', '只有TTL分支接受保存时长');
    const retention = plainRetention(inherited.mode === 'ttl' ? { mode: 'ttl', ttlDurationMs: input.ttlDurationMs } : inherited);
    const options = structuredClone(source.value.options);
    for (const name of ['parentConversationId', 'parentRunId', 'rootRunId', 'parentActionId', 'childRunId',
        'workspaceRoots', 'writableRoots', 'resumeRequired', 'workspaceQuiesce']) delete options[name];
    options.writeRoots = [...input.writeRoots];
    if (input.title !== undefined) options.title = input.title;
    options.branchSource = { conversationId: source.value.conversationId, historyEpoch: source.value.historyEpoch,
        viewRevision: source.value.viewRevision, roundId: input.selectedRoundId, manifestHash: input.sourceManifestHash,
        workspaceFiles: 'unchanged' };
    const value: ConversationData = { conversationId: input.conversationId, principalId: source.value.principalId,
        callerHost: source.value.callerHost, callerConversationId: source.value.callerConversationId, state: 'open',
        retention: { ...retention, lastRunEnd: null, lastClose: null, expiresAt: null, activeRuns: 0 }, options,
        createdAt: input.createdAt, updatedAt: input.createdAt, historyEpoch: 1, appendSeq: input.appendSeq,
        viewRevision: 0, workspaceRevision: 0, runEpoch: 0, activeRunId: null, eventGeneration: input.eventGeneration,
        eventSeq: '0', policyRevision: 1, configRevision: 1, cleanupState: 'not_needed', cleanupError: null,
        closeCleanupCompleted: false };
    return { key: { conversationId: input.conversationId, kind: 'conversation', id: input.conversationId }, revision: 1, value };
}
