import { randomUUID } from 'node:crypto';
import { AgentFault } from '../protocol.js';
import type { JsonValue } from '../protocol.js';
import { measureCanonicalJsonBytes } from '../media/temporary-budget.js';
import { lifecycleSnapshotHash } from './migration-snapshots.js';
import type { LifecycleConversationSnapshot, LifecycleContentSnapshot } from './migration-snapshots.js';
import type { LifecycleCommit } from './contracts.js';

export function temporaryBranchSnapshot(source: LifecycleConversationSnapshot, input: Extract<LifecycleCommit, { kind: 'branch' }>): LifecycleConversationSnapshot {
    const { sourceHash, ...frozen } = input.manifest;
    if (lifecycleSnapshotHash(frozen) !== sourceHash || input.manifest.sourceConversationId !== source.conversationId) {
        throw new AgentFault('E_REFERENCE_CHANGED', '临时分支来源清单与冻结哈希不同');
    }
    const cid = input.target.key.id, copied = new Map<string, LifecycleContentSnapshot>();
    const kinds = new Set(['media_artifact', 'input_attachment', 'input_conversation', 'input_attachment_manifest', 'input_conversation_manifest']);
    const add = (contentId: string, kind: string, value: JsonValue) => {
        const content = { contentId, kind, value, sha256: lifecycleSnapshotHash(value), rawBytes: measureCanonicalJsonBytes(value) };
        copied.set(contentId, content); return content;
    };
    const copy = (contentId: string) => {
        if (copied.has(contentId)) return;
        const content = source.core.contents.find(content => content.contentId === contentId);
        if (!content) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '临时分支缺少原文或原件引用');
        const value = structuredClone(content.value);
        copied.set(contentId, { ...content, value });
        const visit = (entry: unknown): void => {
            if (typeof entry === 'string' && source.core.contents.some(content => content.contentId === entry)) copy(entry);
            else if (entry && typeof entry === 'object') for (const value of Object.values(entry)) visit(value);
        };
        visit(value);
        if (kinds.has(content.kind) && value && typeof value === 'object' && !Array.isArray(value)) {
            value.conversationId = cid; value.retention = { mode: 'temporary' }; add(contentId, content.kind, value);
        }
    };
    const attempts = new Set(input.manifest.items.flatMap(item => item.attemptId ? [item.attemptId] : []));
    for (const item of input.manifest.items) copy(item.contentId);
    for (const expected of input.manifest.toolOutcomeProvenance?.expected ?? []) {
        const record = source.core.records.find(entry => entry.key.conversationId === expected.key.conversationId
            && entry.key.kind === expected.key.kind && entry.key.id === expected.key.id);
        if ((record?.revision ?? null) !== expected.revision) throw new AgentFault('REVISION_CONFLICT', '临时分支原工具终态在提交前变化');
    }
    for (const group of input.manifest.toolOutcomeProvenance?.groups ?? []) for (const call of group.calls) {
        if (!call.content) continue;
        const content = source.core.contents.find(entry => entry.contentId === call.content!.contentId);
        if (!content || content.sha256 !== call.content.objectHash || content.rawBytes !== call.content.rawBytes) {
            throw new AgentFault('E_REFERENCE_CHANGED', '临时分支原工具结果引用在提交前变化');
        }
        copy(call.content.contentId);
    }
    for (const record of source.core.records) if (record.key.kind === 'step' && record.value.kind === 'context_candidate' && typeof record.value.contentId === 'string') {
        const candidate = source.core.contents.find(content => content.contentId === record.value.contentId);
        const snapshot = (candidate?.value as { snapshot?: { snapshotAppendSeq?: number; coveredEndSeq?: number } } | undefined)?.snapshot;
        if (!snapshot || !Number.isSafeInteger(snapshot.snapshotAppendSeq) || !Number.isSafeInteger(snapshot.coveredEndSeq)
            || snapshot.snapshotAppendSeq! > input.manifest.throughSeq || snapshot.coveredEndSeq! > input.manifest.throughSeq) continue;
        copy(candidate!.contentId);
        const visit = (entry: unknown): void => {
            if (typeof entry === 'string' && [...source.provider.temporaryAttempts.map(value => value.intent.attemptId), ...source.provider.durableAttempts.map(value => value.attempt.attemptId)].includes(entry)) attempts.add(entry);
            else if (entry && typeof entry === 'object') for (const value of Object.values(entry)) visit(value);
        };
        visit(candidate!.value); visit(record.value);
    }
    const artifacts = source.media.artifacts.filter(artifact => attempts.has(artifact.attemptId)).map(artifact => ({ ...structuredClone(artifact), conversationId: cid,
        retention: { mode: 'temporary' as const }, storage: artifact.state === 'ready' ? 'memory' as const : 'remote' as const, path: null, absolutePath: null }));
    for (const artifact of artifacts) add(artifact.artifactId, 'media_artifact', artifact as unknown as JsonValue);
    const originals: { artifactId: string; attemptId: string; slot: string; objectHash: string; sourceConversationId?: string }[] = [];
    for (const attemptId of attempts) {
        const temporary = source.provider.temporaryAttempts.find(entry => entry.intent.attemptId === attemptId);
        const durable = source.provider.durableAttempts.find(entry => entry.attempt.attemptId === attemptId);
        const attempt = temporary?.attempt ?? durable?.attempt, response = temporary?.response ?? durable?.response, failure = temporary?.failure ?? durable?.failure;
        if (attempt) {
            for (const [slot, value] of Object.entries({ attempt, snapshot: attempt.snapshot, response, raw: response?.raw, failure, intent: temporary?.intent })) {
                if (!value) continue;
                const artifactId = `lifecycle:attempt:${attemptId}:${slot}`, content = add(artifactId, `lifecycle_original_${slot}`, value as unknown as JsonValue);
                originals.push({ artifactId, attemptId, slot, objectHash: content.sha256, sourceConversationId: attempt.snapshot.conversationId });
            }
        } else {
            const parent = source.core.contents.find(content => content.contentId === `lifecycle:source:${source.conversationId}`)?.value as {
                provenance?: { originals?: typeof originals } } | undefined;
            for (const original of parent?.provenance?.originals ?? []) if (original.attemptId === attemptId) {
                copy(original.artifactId); originals.push({ ...original });
            }
        }
    }
    add(`lifecycle:source:${cid}`, 'branch_source', { ...input.manifest, provenance: { originals, unknownAttemptIds: [],
        sourceContentIds: [...copied.keys()], financialPolicy: 'original_attempt_ids_no_new_charge' } } as unknown as JsonValue);
    const history = input.manifest.items.map(item => {
        const { sourceSeq: _sourceSeq, localSeq, objectHash: _objectHash, rawBytes: _rawBytes, ...metadata } = item;
        const content = copied.get(item.contentId)!;
        return { ...metadata, itemId: randomUUID(), seq: localSeq, objectRef: { hash: content.sha256, rawBytes: content.rawBytes } };
    });
    return { schemaVersion: 1, conversationId: cid, core: { schemaVersion: 1, conversationId: cid,
        records: [input.target as unknown as LifecycleConversationSnapshot['core']['records'][number]], contents: [...copied.values()], history, events: [], receipts: [] },
        provider: { schemaVersion: 1, conversationId: cid, temporaryAttempts: [], durableAttempts: [], fences: [], closed: false },
        media: { schemaVersion: 1, conversationId: cid, artifacts, payloads: source.media.payloads.filter(payload => artifacts.some(artifact => artifact.sha256 === payload.sha256)) },
        workspace: { schemaVersion: 1, conversationId: cid, actions: [], journalRevision: 0, tickets: [], approvalReceipts: [], restorePlans: [] },
        pending: { schemaVersion: 1, conversationId: cid, pendingToolIds: [] } };
}
