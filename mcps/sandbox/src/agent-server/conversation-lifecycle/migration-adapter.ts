import { randomUUID } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { RetainPolicy, JsonValue } from '../protocol.js';
import type { ConversationData } from '../runtime.js';
import type { AgentStore } from '../storage/index.js';
import type { AgentDispatchJournalPort } from '../storage/temporary-provider.js';
import type { createAgentWorkspacePorts } from '../storage/temporary-workspace.js';
import type { MediaService } from '../media/service.js';
import type { ReceiptKey, StoreRecord, StoredReceipt, StoreCommitResult } from '../storage/port.js';
import { storeKey } from '../storage/port.js';
import { requireControl, controlKey } from '../controller.js';
import type { ControlLease } from '../controller.js';
import { binaryObjectPath } from '../media/binary-files.js';
import { measureCanonicalJsonBytes } from '../media/temporary-budget.js';
import { convertedConversation, lifecycleBusinessValue, lifecycleFence, plainRetention, sameLifecycleFence } from './policy.js';
import type { ConversationLifecycleStoragePort, LifecycleCommit, LifecycleFence, LifecycleInventory } from './contracts.js';
import { lifecycleSnapshotHash } from './migration-snapshots.js';
import type { LifecycleCapture, LifecycleConversationSnapshot, LifecycleCoreSnapshot, LifecycleStage } from './migration-snapshots.js';
import type { LifecycleMigrationPersistentPort } from './migration-contracts.js';
import { temporaryBranchSnapshot } from './migration-branch.js';

export interface MigratingConversationLifecycleOptions {
    store: AgentStore;
    persistent: ConversationLifecycleStoragePort & LifecycleMigrationPersistentPort;
    journal: AgentDispatchJournalPort;
    media: MediaService;
    workspace: ReturnType<typeof createAgentWorkspacePorts>;
    runMutation<Value>(operation: () => Promise<Value>): Promise<Value>;
    onRouteApplied?(conversationIds: string[], mode: RetainPolicy['mode']): void;
}

export interface MigratingConversationLifecycleStorage extends ConversationLifecycleStoragePort {
    resumeConversationLifecycle(key: ReceiptKey, operationHash: string): Promise<StoreCommitResult | undefined>;
    recoverColdStart(): ReturnType<LifecycleMigrationPersistentPort['executeConversationLifecycleMigration']>;
}

const ownedKinds = new Set(['media_artifact', 'input_attachment', 'input_conversation', 'input_attachment_manifest', 'input_conversation_manifest']);
const recordKey = (conversationId: string) => ({ conversationId, kind: 'conversation' as const, id: conversationId });

export function convertedSnapshot(source: LifecycleConversationSnapshot, policy: RetainPolicy, confirmedAt: string): LifecycleConversationSnapshot {
    const snapshot = structuredClone(source);
    const root = snapshot.core.records.find(record => record.key.kind === 'conversation') as unknown as StoreRecord<ConversationData>;
    const next = convertedConversation(root, policy, confirmedAt);
    snapshot.core.records = snapshot.core.records.map(record => record.key.kind === 'conversation' ? next as unknown as StoreRecord : record);
    snapshot.workspace.actions = snapshot.workspace.actions.map(action => ({ ...action, retention: { ...policy } }));
    snapshot.media.artifacts = snapshot.media.artifacts.map(artifact => ({ ...artifact, retention: { ...policy },
        storage: artifact.state === 'ready' ? policy.mode === 'temporary' ? 'memory' : 'objects' : 'remote',
        path: artifact.state === 'ready' && policy.mode !== 'temporary' ? binaryObjectPath(artifact.sha256!) : null, absolutePath: null }));
    const preserveOriginal = (content: LifecycleCoreSnapshot['contents'][number]): void => {
        const contentId = `lifecycle:object:${content.sha256}`;
        const existing = snapshot.core.contents.find(candidate => candidate.contentId === contentId);
        if (existing) {
            if (existing.sha256 !== content.sha256) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '迁移原件别名与完整原对象不同');
            return;
        }
        snapshot.core.contents.push({ ...structuredClone(content), contentId, kind: 'lifecycle_original' });
    };
    for (const content of snapshot.core.contents) if (ownedKinds.has(content.kind) && content.value && typeof content.value === 'object' && !Array.isArray(content.value)) {
        const artifact = content.kind === 'media_artifact' ? snapshot.media.artifacts.find(artifact => artifact.artifactId === content.contentId) : undefined;
        const value = artifact ? artifact as unknown as JsonValue : { ...content.value, retention: { ...policy } };
        const checksum = lifecycleSnapshotHash(value);
        if (checksum !== content.sha256) preserveOriginal(content);
        content.value = value; content.sha256 = checksum; content.rawBytes = measureCanonicalJsonBytes(value);
    }
    for (const artifact of snapshot.media.artifacts) {
        const existing = snapshot.core.contents.find(content => content.contentId === artifact.artifactId);
        const content = { contentId: artifact.artifactId, kind: 'media_artifact', value: artifact as unknown as JsonValue,
            sha256: lifecycleSnapshotHash(artifact), rawBytes: measureCanonicalJsonBytes(artifact) };
        if (existing) { if (existing.sha256 !== content.sha256) preserveOriginal(existing); Object.assign(existing, content); }
        else snapshot.core.contents.push(content);
    }
    for (const payload of snapshot.media.payloads) {
        const contentId = `lifecycle:binary:${payload.sha256}`;
        if (!snapshot.core.contents.some(content => content.contentId === contentId)) {
            const artifact = snapshot.media.artifacts.find(artifact => artifact.sha256 === payload.sha256)!;
            const value = { ...payload, mime: artifact.mime };
            snapshot.core.contents.push({ contentId, kind: 'lifecycle_binary_payload', value, sha256: lifecycleSnapshotHash(value), rawBytes: measureCanonicalJsonBytes(value) });
        }
    }
    for (const item of snapshot.core.history) {
        const content = snapshot.core.contents.find(content => content.contentId === item.contentId)!;
        item.objectRef = { hash: content.sha256, rawBytes: content.rawBytes };
    }
    return snapshot;
}

function businessHash(snapshots: LifecycleConversationSnapshot[], financialHash: string): string {
    const stable = snapshots.map(snapshot => ({ ...snapshot, core: {
        ...snapshot.core,
        records: snapshot.core.records.filter(record => !['control', 'eventAck'].includes(record.key.kind))
            .map(record => record.key.kind === 'conversation' ? { key: record.key, value: lifecycleBusinessValue(record.value as unknown as ConversationData) } : record),
        receipts: snapshot.core.receipts.filter(receipt => {
            const data = receipt.result.data as Record<string, unknown> | undefined;
            return !data || Array.isArray(data) || typeof data.controlLeaseId !== 'string';
        }),
        events: snapshot.core.events.filter(event => !event.type.startsWith('control.')),
    } }));
    return lifecycleSnapshotHash({ snapshots: stable, financialHash });
}

export function createMigratingConversationLifecycleStorage(options: MigratingConversationLifecycleOptions): MigratingConversationLifecycleStorage {
    const { store, persistent, journal, media, workspace } = options;
    const stages = async (snapshot: LifecycleConversationSnapshot): Promise<LifecycleStage[]> => {
        const held: LifecycleStage[] = [];
        try {
            held.push(store.temporary.stageConversationLifecycle(snapshot.core));
            held.push(journal.stageConversationLifecycle(snapshot.provider));
            held.push(media.stageConversationLifecycle(snapshot.media));
            held.push(await workspace.lifecycle.stageConversationLifecycle(snapshot.workspace));
            held.push(workspace.pendingTools.stageConversationLifecycle(snapshot.pending, snapshot.core));
            return held;
        } catch (error) { for (const stage of held.reverse()) stage.discard(); throw error; }
    };
    const freeze = async <Value>(conversationIds: string[], operation: () => Promise<Value>): Promise<Value> => {
        const releases: (() => void)[] = [];
        try {
            for (const conversationId of [...new Set(conversationIds)].sort()) {
                releases.push(await journal.freezeConversationLifecycle(conversationId));
                releases.push(await media.freezeConversationLifecycle(conversationId));
                releases.push(await workspace.lifecycle.freezeConversationLifecycle(conversationId));
                releases.push(workspace.pendingTools.freezeConversationLifecycle(conversationId));
                releases.push(store.temporary.freezeConversationLifecycle(conversationId));
            }
            return await operation();
        } finally { for (const release of releases.reverse()) release(); }
    };
    const temporaryFamily = async (sourceId: string) => {
        const records: StoreRecord<ConversationData>[] = [];
        let cursor: string | undefined;
        do {
            const page = await store.listRecords<ConversationData>({ kind: 'conversation', cursor, limit: 50 }); records.push(...page.items);
            cursor = page.hasMore ? page.nextCursor! : undefined;
        } while (cursor);
        const byId = new Map(records.map(record => [record.key.id, record]));
        let root = byId.get(sourceId);
        if (!root) throw new AgentFault('NOT_FOUND', '迁移源会话不存在');
        const seen = new Set<string>();
        while (typeof root.value.options.parentConversationId === 'string') {
            if (seen.has(root.key.id)) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '原保存归属链存在环');
            seen.add(root.key.id); const parent = byId.get(root.value.options.parentConversationId);
            if (!parent) throw new AgentFault('RETENTION_TRANSITION_BUSY', '原保存家族缺少父会话'); root = parent;
        }
        const members = [root];
        for (const parent of members) for (const record of records) if (record.value.options.parentConversationId === parent.key.id && !members.some(member => member.key.id === record.key.id)) members.push(record);
        if (members.some(record => record.value.retention.mode !== 'temporary' || record.value.principalId !== root!.value.principalId)) throw new AgentFault('RETENTION_TRANSITION_BUSY', '原保存家族的模式或主体不同');
        return { rootId: root.key.id, ids: members.map(record => record.key.id).sort() };
    };
    const captureTemporary = async (ids: string[]): Promise<{ snapshots: LifecycleConversationSnapshot[]; release(): void }> => {
        const leases: LifecycleCapture<unknown>[] = [];
        try {
            const snapshots: LifecycleConversationSnapshot[] = [];
            for (const conversationId of ids) {
                const core = store.temporary.captureConversationLifecycle(conversationId); leases.push(core);
                const provider = journal.captureConversationLifecycle(conversationId); leases.push(provider);
                const originalMedia = media.captureConversationLifecycle(conversationId); leases.push(originalMedia);
                const originalWorkspace = await workspace.lifecycle.captureConversationLifecycle(conversationId); leases.push(originalWorkspace);
                snapshots.push({ schemaVersion: 1, conversationId, core: core.value, provider: provider.value, media: originalMedia.value,
                    workspace: originalWorkspace.value, pending: workspace.pendingTools.captureConversationLifecycle(core.value) });
            }
            return { snapshots, release: () => { for (const lease of leases.reverse()) lease.release(); } };
        } catch (error) { for (const lease of leases.reverse()) lease.release(); throw error; }
    };
    const temporaryInventory = (snapshots: LifecycleConversationSnapshot[], source: LifecycleFence, rootId: string, financialHash: string, unknownAttemptIds: string[]): LifecycleInventory => ({
        schemaVersion: 1, fence: source, inventoryHash: businessHash(snapshots, financialHash), totalBytes: measureCanonicalJsonBytes(snapshots),
        contentCount: snapshots.reduce((total, snapshot) => total + snapshot.core.contents.length, 0),
        originalCount: snapshots.reduce((total, snapshot) => total + snapshot.media.artifacts.length + snapshot.core.contents.filter(content => content.kind === 'input_attachment_manifest').length, 0),
        retentionRootConversationId: rootId, dependentConversationIds: snapshots.map(snapshot => snapshot.conversationId).filter(id => id !== source.conversationId),
        retainedSharedObjects: 0, unknownAttemptIds, activeResourceIds: [], complete: true,
    });
    const assertSource = (snapshots: LifecycleConversationSnapshot[], source: LifecycleFence) => {
        const snapshot = snapshots.find(snapshot => snapshot.conversationId === source.conversationId);
        const root = snapshot?.core.records.find(record => record.key.kind === 'conversation') as unknown as StoreRecord<ConversationData> | undefined;
        if (!root || !sameLifecycleFence(lifecycleFence(root), source)) throw new AgentFault('REVISION_CONFLICT', '冻结工厂期间原源版本已变化');
    };
    const releaseSource = (ids: string[]) => {
        for (const id of ids) {
            journal.releaseConversationLifecycle(id); media.releaseConversationLifecycle(id); workspace.lifecycle.releaseConversationLifecycle(id);
            workspace.pendingTools.releaseConversationLifecycle(id); store.temporary.releaseConversationLifecycle(id);
        }
    };
    const inspect: ConversationLifecycleStoragePort['inspectConversationLifecycle'] = async input => {
        const source = await store.getRecord<ConversationData>(recordKey(input.source.conversationId));
        if (!source) throw new AgentFault('NOT_FOUND', '找不到原源会话');
        if (source.value.retention.mode !== 'temporary' && input.targetRetention?.mode !== 'temporary') return persistent.inspectConversationLifecycle(input);
        return options.runMutation(async () => {
            if (source.value.retention.mode === 'temporary') {
                const family = await temporaryFamily(source.key.id);
                return freeze(family.ids, async () => {
                    const capture = await captureTemporary(family.ids);
                    try {
                        assertSource(capture.snapshots, input.source);
                        const financial = await persistent.readConversationLifecycleSnapshot({ type: 'financial', conversationIds: family.ids });
                        return temporaryInventory(capture.snapshots, input.source, family.rootId, financial.financialHash, financial.unknownAttemptIds);
                    } finally { capture.release(); }
                });
            }
            const captured = await persistent.readConversationLifecycleSnapshot({ type: 'durable', source: input.source });
            if (captured.kind !== 'snapshot') throw new AgentFault('STORAGE_RESPONSE_INVALID', '原持久快照响应类型不同');
            return freeze(captured.snapshots.map(snapshot => snapshot.conversationId), async () => {
                const held: LifecycleStage[] = [];
                try {
                    for (const snapshot of captured.snapshots) held.push(...await stages(convertedSnapshot(snapshot, input.targetRetention!, new Date().toISOString())));
                    return captured.inventory;
                } finally { for (const stage of held.reverse()) stage.discard(); }
            });
        });
    };
    const resume = (key: ReceiptKey, operationHash: string): Promise<StoreCommitResult | undefined> => options.runMutation(async () => {
        const read = await persistent.executeConversationLifecycleMigration({ type: 'read', key, operationHash });
        if (read.kind !== 'operation' || !read.operation) return undefined;
        if (read.operation.status !== 'awaiting_memory') return { replayed: true, receipt: read.operation.receipt };
        const operation = read.operation;
        return freeze(operation.conversationIds, async () => {
            for (const id of operation.conversationIds) {
                const root = await store.temporary.getRecord<ConversationData>(recordKey(id));
                if (!root || (root.value.lifecycleTransition as { operationId?: string } | undefined)?.operationId !== operation.operationId) throw new AgentFault('RETENTION_TRANSITION_BUSY', '原临时工厂尚无可确认的完整接纳', { operationId: operation.operationId });
            }
            const completed = await persistent.executeConversationLifecycleMigration({ type: 'complete_temporary', key, operationHash });
            if (completed.kind !== 'committed') throw new AgentFault('STORAGE_RESPONSE_INVALID', '原转换尚无最终回执');
            for (const id of operation.conversationIds) store.temporary.finishConversationLifecycle(id, operation.operationId);
            return completed.result;
        });
    });
    const commit: ConversationLifecycleStoragePort['commitConversationLifecycle'] = async input => {
        const source = await store.getRecord<ConversationData>(recordKey(input.source.conversationId));
        if (!source) throw new AgentFault('NOT_FOUND', '找不到原源会话');
        if (source.value.retention.mode !== 'temporary' && input.target.value.retention.mode !== 'temporary') return persistent.commitConversationLifecycle(input);
        if (input.kind === 'branch') return options.runMutation(async () => {
            const family = await temporaryFamily(source.key.id);
            return freeze([...family.ids, input.target.key.id], async () => {
                const capture = await captureTemporary(family.ids), held: LifecycleStage[] = [];
                try {
                    assertSource(capture.snapshots, input.source);
                    const financial = await persistent.readConversationLifecycleSnapshot({ type: 'financial', conversationIds: family.ids });
                    const inventory = temporaryInventory(capture.snapshots, input.source, family.rootId, financial.financialHash, financial.unknownAttemptIds);
                    if (inventory.inventoryHash !== input.inventoryHash) throw new AgentFault('RETENTION_PREVIEW_STALE', '临时分支原件或原费用已变化');
                    const snapshot = capture.snapshots.find(snapshot => snapshot.conversationId === input.source.conversationId)!;
                    const control = snapshot.core.records.find(record => storeKey(record.key) === storeKey(controlKey(input.source.conversationId))) as StoreRecord<ControlLease>;
                    if (!input.expected.some(expected => storeKey(expected.key) === storeKey(control.key) && expected.revision === control.revision)) throw new AgentFault('REVISION_CONFLICT', '临时分支原控制版本已变化');
                    requireControl(control, control.value, input.receipt.key, Date.now());
                    held.push(...await stages(temporaryBranchSnapshot(snapshot, input)));
                    held.push(store.temporary.stageConversationLifecycleReceipt(input.receipt));
                    for (const stage of held) stage.activate(); options.onRouteApplied?.([input.target.key.id], 'temporary');
                    return { replayed: false, receipt: input.receipt };
                } finally { for (const stage of held.reverse()) stage.discard(); capture.release(); }
            });
        });
        return options.runMutation(async () => {
            const temporary = source.value.retention.mode === 'temporary';
            const family = temporary ? await temporaryFamily(source.key.id) : undefined;
            const durable = temporary ? undefined : await persistent.readConversationLifecycleSnapshot({ type: 'durable', source: input.source });
            if (durable && durable.kind !== 'snapshot') throw new AgentFault('STORAGE_RESPONSE_INVALID', '原持久工厂快照类型不同');
            const ids = family?.ids ?? (durable as Extract<typeof durable, { kind: 'snapshot' }>)!.snapshots.map(snapshot => snapshot.conversationId);
            return freeze(ids, async () => {
                const capture = temporary ? await captureTemporary(ids) : undefined;
                const snapshots = capture?.snapshots ?? (durable as Extract<typeof durable, { kind: 'snapshot' }>)!.snapshots;
                const held: LifecycleStage[] = [];
                try {
                    assertSource(snapshots, input.source);
                    const financial = await persistent.readConversationLifecycleSnapshot({ type: 'financial', conversationIds: ids });
                    const inventory = temporary ? temporaryInventory(snapshots, input.source, family!.rootId, financial.financialHash, financial.unknownAttemptIds)
                        : (durable as Extract<typeof durable, { kind: 'snapshot' }>)!.inventory;
                    if (inventory.inventoryHash !== input.inventoryHash) throw new AgentFault('RETENTION_PREVIEW_STALE', '权威提交前完整工厂或原费用已变化');
                    const control = snapshots.find(snapshot => snapshot.conversationId === input.source.conversationId)!.core.records.find(record => storeKey(record.key) === storeKey(controlKey(input.source.conversationId))) as StoreRecord<ControlLease>;
                    const expected = input.expected.find(entry => storeKey(entry.key) === storeKey(control.key));
                    if (!expected || expected.revision !== control.revision) throw new AgentFault('REVISION_CONFLICT', '原控制记录版本已变化');
                    requireControl(control, control.value, input.receipt.key, Date.now());
                    const targets = snapshots.map(snapshot => convertedSnapshot(snapshot, plainRetention(input.target.value.retention), input.confirmedAt));
                    if (temporary) {
                        const result = await persistent.executeConversationLifecycleMigration({ type: 'import', commit: input, snapshots: targets,
                            financialHash: financial.financialHash, sourceSnapshotHash: lifecycleSnapshotHash(snapshots) });
                        if (result.kind !== 'committed') throw new AgentFault('STORAGE_RESPONSE_INVALID', '持久导入尚无权威回执');
                        releaseSource(ids); options.onRouteApplied?.(ids, input.target.value.retention.mode); return result.result;
                    }
                    for (const target of targets) {
                        const root = target.core.records.find(record => record.key.kind === 'conversation')!;
                        root.value.lifecycleTransition = { operationId: input.operationId, kind: 'retention', phase: 'cleanup' };
                        held.push(...await stages(target));
                    }
                    const result = await persistent.executeConversationLifecycleMigration({ type: 'prepare_temporary', commit: input, snapshots: targets,
                        financialHash: financial.financialHash, sourceSnapshotHash: (durable as Extract<typeof durable, { kind: 'snapshot' }>)!.snapshotHash });
                    if (result.kind !== 'temporary_prepared') throw new AgentFault('STORAGE_RESPONSE_INVALID', '转临时尚无权威准备结果');
                    for (const stage of held) stage.activate(); options.onRouteApplied?.(ids, 'temporary');
                    const completed = await persistent.executeConversationLifecycleMigration({ type: 'complete_temporary', key: input.receipt.key, operationHash: input.receipt.operationHash });
                    if (completed.kind !== 'committed') throw new AgentFault('STORAGE_RESPONSE_INVALID', '原持久清理尚无最终回执');
                    for (const id of ids) store.temporary.finishConversationLifecycle(id, input.operationId);
                    return completed.result;
                } finally { for (const stage of held.reverse()) stage.discard(); capture?.release(); }
            });
        });
    };
    return { inspectConversationLifecycle: inspect, commitConversationLifecycle: commit, resumeConversationLifecycle: resume,
        recoverColdStart: () => persistent.executeConversationLifecycleMigration({ type: 'recover' }) };
}
