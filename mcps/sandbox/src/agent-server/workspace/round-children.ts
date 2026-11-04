import { AgentFault } from '../protocol.js';
import { pathIdentity } from '../security/policy.js';
import type { StorePort } from '../storage/port.js';
import type { BoundToolContext } from '../tools/types.js';
import type { ChangeAction, WorkspaceJournalPort } from './journal.js';

export interface RestoreSelection {
    roundIds?: string[];
    childActions?: ChangeAction[];
    childRevisions?: Record<string, number>;
    actionOrder?: Record<string, number>;
}

export async function collectRoundChildChanges(store: Pick<StorePort, 'getRecord' | 'listRecords' | 'readHistory'>,
    journal: WorkspaceJournalPort, context: BoundToolContext, roundIds: readonly string[], historyEpoch: number): Promise<RestoreSelection> {
    const actionOrder: Record<string, number> = {};
    const actionRounds = new Map<string, string>();
    const links: { childId: string; actionId?: string; roundId?: string; runId: string }[] = [];
    const children = new Set<string>();
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
        const page = await store.listRecords({ conversationId: context.conversationId, kind: 'run', cursor, limit: 100 });
        for (const run of page.items) {
            const owned = Array.isArray(run.value.internalChildren) ? run.value.internalChildren : [];
            for (const value of owned) {
                if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
                const link = value as Record<string, unknown>;
                const childId = link.childConversationId;
                if (typeof childId !== 'string' || children.has(childId)) continue;
                let actionId = typeof link.parentActionId === 'string' ? link.parentActionId : undefined;
                if (!actionId && typeof link.callKey === 'string') {
                    try { const key: unknown = JSON.parse(link.callKey); if (Array.isArray(key) && typeof key[0] === 'string') actionId = key[0]; }
                    catch { throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '子任务原派发动作引用无效'); }
                }
                children.add(childId);
                links.push({ childId, actionId, roundId: typeof link.parentRoundId === 'string' ? link.parentRoundId : undefined, runId: run.key.id });
            }
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new AgentFault('STORAGE_CURSOR_STALE', '父任务分页未前进');
        if (cursor) seen.add(cursor);
    } while (cursor);
    const unresolved = new Set(links.filter(link => !link.roundId && link.actionId).map(link => link.actionId!));
    cursor = undefined;
    seen.clear();
    while (unresolved.size) {
        const page = await store.readHistory({ conversationId: context.conversationId, view: 'raw', effectiveOnly: false,
            expectedHistoryEpoch: historyEpoch, cursor, limit: 200, maxBytes: 512 * 1024 });
        for (const item of page.items) if (item.actionId && item.roundId && unresolved.has(item.actionId)) {
            actionOrder[item.actionId] = item.seq;
            actionRounds.set(item.actionId, item.roundId);
            unresolved.delete(item.actionId);
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new AgentFault('STORAGE_CURSOR_STALE', '父轮历史分页未前进');
        if (!cursor) break;
        seen.add(cursor);
    }
    const childActions: ChangeAction[] = [];
    const childRevisions: Record<string, number> = {};
    for (const link of links) {
        const roundId = link.roundId ?? (link.actionId ? actionRounds.get(link.actionId) : undefined);
        if (!roundId) throw new AgentFault('RESTORE_PENDING', '原子任务缺少可核对的父轮归属，保留原修改');
        if (!roundIds.includes(roundId)) continue;
        const child = await store.getRecord({ conversationId: link.childId, kind: 'conversation', id: link.childId });
        const options = child?.value.options as Record<string, unknown> | undefined;
        if (!child || child.value.principalId !== context.principalId || options?.parentConversationId !== context.conversationId
            || options.parentRunId !== undefined && options.parentRunId !== link.runId) {
            throw new AgentFault('POLICY_CHANGED', '子修改记录的父级归属或主体不同');
        }
        const revision = await journal.revision(link.childId);
        const actions = await readJournalActions(journal, link.childId);
        if (revision !== await journal.revision(link.childId)) throw new AgentFault('VERSION_CONFLICT', '读取期间子任务工作区已变化');
        childRevisions[link.childId] = revision;
        childActions.push(...actions.map(action => ({ ...action, sourceRoundId: action.roundId, roundId,
            workspaceOrigin: { conversationId: context.conversationId, runId: link.runId, roundId, actionId: link.actionId ?? '' } })));
    }
    return { childActions, childRevisions, actionOrder };
}

export async function readJournalActions(journal: WorkspaceJournalPort, conversationId: string,
    select: (action: ChangeAction) => boolean = () => true): Promise<ChangeAction[]> {
    if (!journal.listPage) return (await journal.list(conversationId)).filter(select);
    const actions: ChangeAction[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
        const page = await journal.listPage(conversationId, { cursor, limit: 24, maxBytes: 32 * 1024 * 1024 });
        actions.push(...page.actions.filter(select));
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new AgentFault('STORAGE_CURSOR_STALE', '工作区修改分页未前进');
        if (cursor) seen.add(cursor);
    } while (cursor);
    return actions;
}

export function mergeRestoreActions(actions: ChangeAction[], selection?: RestoreSelection): ChangeAction[] {
    const ordered = [...actions, ...(selection?.childActions ?? [])].sort((first, second) => {
        const firstTime = first.settledAt ?? first.receipt?.committedAt ?? first.recordedAt;
        const secondTime = second.settledAt ?? second.receipt?.committedAt ?? second.recordedAt;
        if (firstTime && secondTime && firstTime !== secondTime) return firstTime.localeCompare(secondTime);
        const firstOrder = selection?.actionOrder?.[first.workspaceOrigin?.actionId ?? first.commandActionId ?? first.actionId];
        const secondOrder = selection?.actionOrder?.[second.workspaceOrigin?.actionId ?? second.commandActionId ?? second.actionId];
        if (firstOrder !== undefined && secondOrder !== undefined && firstOrder !== secondOrder) return firstOrder - secondOrder;
        return (first.recordedAt ?? '').localeCompare(second.recordedAt ?? '');
    });
    const afterVersions = new Map<string, number>();
    const versionKey = (filePath: string, version: string) => JSON.stringify([pathIdentity(filePath), version]);
    for (const [index, action] of ordered.entries()) {
        if (action.afterVersion?.versionToken) afterVersions.set(versionKey(action.path, action.afterVersion.versionToken), index);
        if (action.receipt?.destinationPath && action.receipt.destinationAfterVersion?.versionToken) {
            afterVersions.set(versionKey(action.receipt.destinationPath, action.receipt.destinationAfterVersion.versionToken), index);
        }
    }
    const predecessors = ordered.map((action, index) => {
        const previous = new Set<number>();
        const add = (filePath: string, version?: string | null) => {
            const owner = version ? afterVersions.get(versionKey(filePath, version)) : undefined;
            if (owner !== undefined && owner !== index) previous.add(owner);
        };
        if (action.beforeVersion.exists) add(action.path, action.beforeVersion.versionToken);
        if (action.receipt?.destinationPath && action.receipt.destinationBeforeVersion?.exists) {
            add(action.receipt.destinationPath, action.receipt.destinationBeforeVersion.versionToken);
        }
        return previous;
    });
    const remaining = new Set(ordered.map((_, index) => index));
    const merged: ChangeAction[] = [];
    while (remaining.size) {
        const next = [...remaining].find(index => [...predecessors[index]].every(previous => !remaining.has(previous)));
        if (next === undefined) throw new AgentFault('RESTORE_PENDING', '所属修改的文件版本关系尚未确认，保留原文件');
        remaining.delete(next);
        merged.push(ordered[next]);
    }
    return merged;
}

export async function assertChildWorkspaceRevisions(journal: WorkspaceJournalPort, revisions?: Record<string, number>): Promise<void> {
    for (const [conversationId, revision] of Object.entries(revisions ?? {})) {
        if (await journal.revision(conversationId) !== revision) throw new AgentFault('VERSION_CONFLICT', '预览后所属子任务文件记录已变化，请重新预览');
    }
}
