import { AgentFault } from '../protocol.js';
import type { JsonValue } from '../protocol.js';
import { assertPendingTransition, summarizePending, TERMINAL_PENDING_STATES } from '../tools/pending-types.js';
import type { PendingToolQuery, PendingToolRecord, PendingToolStorePort, PendingToolSummary } from '../tools/pending-types.js';
import type { AgentStore } from './index.js';
import type { StoreRecord, StoreKey } from './port.js';
import { SqlitePendingToolStore } from './workspace-port.js';
import { lifecycleFrozen, requireLifecycleSnapshotOwner } from '../conversation-lifecycle/migration-snapshots.js';
import type { LifecycleCoreSnapshot, LifecyclePendingSnapshot, LifecycleStage } from '../conversation-lifecycle/migration-snapshots.js';

interface PendingPointer {
    type: 'temporary_pending_tool';
    summary: PendingToolSummary;
    contentId: string;
}

export class AgentPendingToolStore implements PendingToolStorePort {
    readonly persistence = 'durable' as const;
    private readonly durable: SqlitePendingToolStore;
    private readonly temporaryOwners = new Map<string, string>();
    private readonly lifecycleFrozenIds = new Set<string>();

    constructor(readonly store: AgentStore) {
        this.durable = new SqlitePendingToolStore(store.persistent);
        store.onTemporaryTransition(async transition => {
            if (transition.purgeConversationId) for (const [id, conversationId] of this.temporaryOwners) {
                if (conversationId === transition.purgeConversationId) this.temporaryOwners.delete(id);
            }
        });
        store.onClosing(async () => { this.temporaryOwners.clear(); });
    }

    async get(pendingToolId: string): Promise<PendingToolRecord | undefined> {
        const conversationId = this.temporaryOwners.get(pendingToolId);
        if (!conversationId) return this.durable.get(pendingToolId);
        const pointer = await this.store.temporary.getRecord<PendingPointer>({ conversationId, kind: 'control', id: `pending-tool:${pendingToolId}` });
        if (!pointer) return undefined;
        return await this.store.temporary.readContent(conversationId, pointer.value.contentId) as unknown as PendingToolRecord | undefined;
    }

    async put(record: PendingToolRecord, expectedRevision: number | null): Promise<PendingToolRecord> {
        const conversationId = record.frozen.conversationId;
        if (this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        const conversation = await this.store.temporary.getRecord({ conversationId, kind: 'conversation', id: conversationId });
        if (!conversation) {
            if (record.frozen.retention.mode === 'temporary') throw new AgentFault('CONVERSATION_NOT_FOUND', '临时工具所属会话已经关闭');
            return this.durable.put(record, expectedRevision);
        }
        if (record.frozen.retention.mode !== 'temporary' || conversation.value.principalId !== record.frozen.principalId) {
            throw new AgentFault('TOOL_NOT_ALLOWED', '临时工具记录的主体或保存方式与原会话不同');
        }
        const key: StoreKey = { conversationId, kind: 'control', id: `pending-tool:${record.pendingToolId}` };
        const previousPointer = await this.store.temporary.getRecord<PendingPointer>(key);
        if ((previousPointer?.revision ?? null) !== expectedRevision) throw new AgentFault('WORKSPACE_CAS_CONFLICT', '原工具等待项版本已变化');
        const previous = previousPointer ? await this.store.temporary.readContent(conversationId, previousPointer.value.contentId) as unknown as PendingToolRecord : undefined;
        assertPendingTransition(record, previous);
        const next = { ...record, revision: (expectedRevision ?? 0) + 1 };
        const contentId = `pending-tool:${record.pendingToolId}`;
        const pointer: StoreRecord<PendingPointer> = { key, revision: next.revision,
            value: { type: 'temporary_pending_tool', summary: summarizePending(next), contentId } };
        await this.store.commitTransition({ expected: [{ key: conversation.key, revision: conversation.revision },
            { key, revision: expectedRevision }], records: [pointer as unknown as StoreRecord],
            contents: [{ conversationId, contentId, kind: 'pending_tool', indexHistory: false, value: next as unknown as JsonValue }] });
        this.temporaryOwners.set(next.pendingToolId, conversationId);
        return (await this.get(next.pendingToolId))!;
    }

    async list(query: PendingToolQuery): Promise<{ items: PendingToolSummary[]; nextCursor: string | null }> {
        const conversation = await this.store.temporary.getRecord({ conversationId: query.conversationId,
            kind: 'conversation', id: query.conversationId });
        if (!conversation) return this.durable.list(query);
        if (conversation.value.principalId !== query.principalId) throw new AgentFault('TOOL_NOT_ALLOWED', '原工具等待项未绑定该会话主体');
        const page = await this.store.temporary.listRecords<PendingPointer>({ conversationId: query.conversationId,
            kind: 'control', limit: query.limit ?? 24, cursor: query.cursor });
        const items = page.items.filter(item => item.value.type === 'temporary_pending_tool').map(item => item.value.summary).filter(item => (!query.runId || item.runId === query.runId)
            && (query.includeTerminal || !TERMINAL_PENDING_STATES.includes(item.state)));
        for (const item of items) this.temporaryOwners.set(item.pendingToolId, query.conversationId);
        return { items, nextCursor: page.nextCursor ?? null };
    }

    freezeConversationLifecycle(conversationId: string): () => void {
        if (this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        this.lifecycleFrozenIds.add(conversationId);
        return () => this.lifecycleFrozenIds.delete(conversationId);
    }

    captureConversationLifecycle(core: LifecycleCoreSnapshot): LifecyclePendingSnapshot {
        const conversationId = core.conversationId;
        if (!this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        const pendingToolIds = core.records.filter(record => record.key.kind === 'control' && record.value.type === 'temporary_pending_tool')
            .map(record => String((record.value.summary as unknown as PendingToolSummary).pendingToolId)).sort();
        return { schemaVersion: 1, conversationId, pendingToolIds };
    }

    stageConversationLifecycle(snapshot: LifecyclePendingSnapshot, core: LifecycleCoreSnapshot): LifecycleStage {
        const conversationId = snapshot.conversationId;
        requireLifecycleSnapshotOwner(snapshot, core.conversationId);
        if (!this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        const expected = this.captureConversationLifecycle(core).pendingToolIds;
        if (JSON.stringify(expected) !== JSON.stringify([...snapshot.pendingToolIds].sort())) throw new AgentFault('STORAGE_SNAPSHOT_INVALID', '待办迁移清单与原Store指针不同');
        for (const pendingToolId of expected) {
            if (this.temporaryOwners.has(pendingToolId)) throw new AgentFault('REVISION_CONFLICT', '待办迁移目标已有同ID归属');
            const pointer = core.records.find(record => record.key.id === `pending-tool:${pendingToolId}`)!;
            const content = core.contents.find(content => content.contentId === pointer.value.contentId);
            if (!content || (content.value as unknown as PendingToolRecord).frozen.conversationId !== conversationId) throw new AgentFault('STORAGE_SNAPSHOT_INVALID', '待办快照缺少原冻结记录');
        }
        let settled = false;
        return { discard: () => { settled = true; }, activate: () => {
            if (settled) return;
            settled = true;
            for (const pendingToolId of expected) this.temporaryOwners.set(pendingToolId, conversationId);
        } };
    }

    releaseConversationLifecycle(conversationId: string): void {
        if (!this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        for (const [pendingToolId, owner] of this.temporaryOwners) if (owner === conversationId) this.temporaryOwners.delete(pendingToolId);
    }
}

const pendingStores = new WeakMap<AgentStore, AgentPendingToolStore>();

export function createAgentPendingToolStore(store: AgentStore): AgentPendingToolStore {
    let pending = pendingStores.get(store);
    if (!pending) { pending = new AgentPendingToolStore(store); pendingStores.set(store, pending); }
    return pending;
}
