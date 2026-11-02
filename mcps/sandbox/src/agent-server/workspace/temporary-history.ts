import { createHash, randomUUID } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { HistoryQuery, HistoryPage, StorePort, StoreRecord, StoreKey } from '../storage/port.js';
import type { RestorePlanStorePort } from '../storage/workspace-port.js';
import type { BoundToolContext } from '../tools/types.js';
import type { WorkspaceJournalPort } from './journal.js';
import type { CoreRestorePort } from './restore.js';
import type { RestorePreviewInput } from './restore.js';

interface HistoryMask extends Record<string, unknown> {
    kind: 'workspace_history_mask';
    ranges: { from: number; through: number }[];
    summaryThrough: number;
}

const maskKey = (conversationId: string): StoreKey => ({ conversationId, kind: 'step', id: 'workspace:history-mask' });

export async function readWorkspaceHistory(store: StorePort, query: HistoryQuery): Promise<HistoryPage> {
    const temporary = (store as StorePort & { temporary?: StorePort }).temporary;
    if (temporary && await temporary.getRecord({ conversationId: query.conversationId, kind: 'conversation', id: query.conversationId })) {
        return readWorkspaceHistory(temporary, query);
    }
    const mask = await store.getRecord<HistoryMask>(maskKey(query.conversationId));
    if (!mask) return store.readHistory(query);
    const page = await store.readHistory({ ...query, effectiveOnly: false });
    const items = page.items.map(item => ({ ...item, effective: item.effective
        && !(item.view === 'summary' && item.seq <= mask.value.summaryThrough)
        && !mask.value.ranges.some(range => item.seq >= range.from && item.seq <= range.through) }));
    const current = await store.getRecord(mask.key);
    if (current?.revision !== mask.revision) throw new AgentFault('STORAGE_CURSOR_STALE', '读取期间历史回溯版本变化');
    return { ...page, items: query.effectiveOnly ? items.filter(item => item.effective) : items };
}

export function withWorkspaceHistory(store: StorePort): StorePort {
    return new Proxy(store, { get(target, property) {
        if (property === 'readHistory') return (query: HistoryQuery) => readWorkspaceHistory(target, query);
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
}

export async function validateRestoreHistory(store: Pick<StorePort, 'readHistory'>, input: Pick<RestorePreviewInput, 'mode' | 'roundId' | 'expectedHistoryEpoch'>,
    conversationId: string): Promise<{ roundIds?: string[] }> {
    let cursor: string | undefined; let found = false; let count = 0;
    const roundIds: string[] = [];
    do {
        const page = await store.readHistory({ conversationId, cursor, view: 'raw', effectiveOnly: true,
            expectedHistoryEpoch: input.expectedHistoryEpoch, limit: input.mode === 'round_restart' ? 200 : 1, maxBytes: 512 * 1024 });
        if (input.mode === 'files_only') return {};
        for (const item of page.items) {
            if (++count > 1024) throw new AgentFault('STORAGE_WORKSPACE_LIMIT', '回溯轮次选择超过本次有界历史预算');
            if (item.roundId === input.roundId) found = true;
            if (found && item.roundId && !roundIds.includes(item.roundId)) roundIds.push(item.roundId);
        }
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
    if (!found) throw new AgentFault('NOT_FOUND', '目标轮没有可回溯的有效原文');
    return { roundIds };
}

export function createMemoryWorkspaceRestoreCore(options: { store: StorePort; journal: WorkspaceJournalPort;
    plans: RestorePlanStorePort; quiesce: CoreRestorePort['quiesce'] }): CoreRestorePort {
    if (options.store.capabilities.persistent) throw new AgentFault('WORKSPACE_JOURNAL_REQUIRED', '临时历史事务必须绑定纯内存StorePort');
    const history = withWorkspaceHistory(options.store);
    return { validatePreview: (input, context) => validateRestoreHistory(history, input, context.conversationId),
        async quiesce(input, context) {
            const previous = await options.store.getRecord({ conversationId: context.conversationId, kind: 'step', id: `workspace:restore-history:${input.restorePlanId}` });
            if (!previous) await validateRestoreHistory(history, { ...input, roundId: input.targetRoundId ?? undefined }, context.conversationId);
            return options.quiesce(previous ? { ...input, expectedHistoryEpoch: Number(previous.value.historyEpoch) } : input, context);
        }, async commitHistory(input, context) {
        return commitTemporaryHistory(options.store, options.journal, options.plans, input, context);
    } };
}

async function commitTemporaryHistory(store: StorePort, journal: WorkspaceJournalPort, plans: RestorePlanStorePort,
    input: Parameters<CoreRestorePort['commitHistory']>[0], context: BoundToolContext): Promise<Record<string, unknown>> {
    if (context.retention.mode !== 'temporary') throw new AgentFault('WORKSPACE_JOURNAL_REQUIRED', '临时历史端口只接纳临时会话');
    const conversationKey: StoreKey = { conversationId: context.conversationId, kind: 'conversation', id: context.conversationId };
    const factKey: StoreKey = { conversationId: context.conversationId, kind: 'step', id: `workspace:restore-history:${input.restorePlanId}` };
    const operationHash = createHash('sha256').update(canonicalJson({ ...input, principalId: context.principalId })).digest('hex');
    const previous = await store.getRecord(factKey);
    if (previous) {
        if (previous.value.operationHash !== operationHash) throw new AgentFault('COMMAND_ID_REUSED', '原临时历史提交参数不同');
        return previous.value;
    }
    const plan = await plans.get(input.restorePlanId);
    if (!plan || plan.conversationId !== context.conversationId || plan.principalId !== context.principalId || plan.mode !== input.mode
        || plan.historyEpoch !== input.expectedHistoryEpoch || canonicalJson(plan.actionIds) !== canonicalJson(input.actionIds)
        || canonicalJson(plan.data.results) !== canonicalJson(input.files) || !['committing', 'pending'].includes(plan.state)
        || input.files.some(file => !['restored', 'skipped_conflict'].includes(file.status))) throw new AgentFault('RESTORE_PENDING', '临时恢复计划身份不同或文件尚未结清');
    const conversation = await store.getRecord(conversationKey);
    if (!conversation || conversation.value.state !== 'open' || conversation.value.principalId !== context.principalId
        || conversation.value.historyEpoch !== input.expectedHistoryEpoch || conversation.value.policyRevision !== context.policyRevision
        || await journal.revision(context.conversationId) !== input.workspaceRevision) throw new AgentFault('VERSION_CONFLICT', '临时历史提交前会话或文件版本变化');
    const mask = await store.getRecord<HistoryMask>(maskKey(context.conversationId));
    const history: HistoryPage['items'] = [];
    let cursor: string | undefined; let appendSeq = 0;
    if (input.mode === 'round_restart') do {
        const page = await readWorkspaceHistory(store, { conversationId: context.conversationId, cursor, limit: 200,
            maxBytes: 512 * 1024, view: 'raw', effectiveOnly: true, expectedHistoryEpoch: input.expectedHistoryEpoch });
        history.push(...page.items); appendSeq = page.appendSeq;
        if (history.length > 1024) throw new AgentFault('STORAGE_WORKSPACE_LIMIT', '临时回溯历史超过本次有界事务预算');
        cursor = page.nextCursor ?? undefined;
    } while (cursor);
    const first = history.find(item => item.roundId === input.targetRoundId);
    if (input.mode === 'round_restart' && !first) throw new AgentFault('NOT_FOUND', '目标临时轮没有可回溯原文');
    const rounds = new Set(first ? history.filter(item => item.seq >= first.seq).map(item => item.roundId) : []);
    const records: StoreRecord[] = [];
    const expected = [{ key: conversationKey, revision: conversation.revision }, { key: factKey, revision: null as number | null },
        { key: maskKey(context.conversationId), revision: mask?.revision ?? null }];
    const draftInputIds: string[] = []; const unconsumedInputIds: string[] = [];
    if (input.mode === 'round_restart') for (const kind of ['input', 'step'] as const) {
        let position: string | undefined;
        do {
            const page = await store.listRecords({ conversationId: context.conversationId, kind, cursor: position, limit: 200 });
            for (const record of page.items) {
                let value = { ...record.value };
                if (kind === 'input' && value.state === 'consumed' && rounds.has(String(value.roundId))) {
                    const draft = value.roundId === input.targetRoundId;
                    (draft ? draftInputIds : unconsumedInputIds).push(String(value.inputId));
                    value = { ...value, state: draft ? 'withdrawn' : 'queued', roundId: null, targetRoundId: null,
                        consumedAtStepId: null, restorePlanId: input.restorePlanId };
                } else if (value.kind === 'context_state') value = { ...value, compressionGeneration: randomUUID(), execution: null,
                    candidateId: null, viewContentId: null, checkpoint: null, checkpointContentId: null, historyCheckpoint: null };
                else if (value.kind === 'context_candidate') value = { ...value, state: 'discarded', errorCode: 'HISTORY_STALE' };
                else continue;
                records.push({ ...record, revision: record.revision + 1, value }); expected.push({ key: record.key, revision: record.revision });
                if (records.length > 1024) throw new AgentFault('STORAGE_WORKSPACE_LIMIT', '临时回溯状态数量超过本次事务预算');
            }
            position = page.nextCursor ?? undefined;
        } while (position);
    }
    const receipt: Record<string, unknown> = { restorePlanId: input.restorePlanId, mode: input.mode, operationHash,
        historyEpoch: input.expectedHistoryEpoch + (input.mode === 'round_restart' ? 1 : 0), workspaceRevision: input.workspaceRevision,
        viewRevision: Number(conversation.value.viewRevision ?? 0) + (input.mode === 'round_restart' ? 1 : 0), targetRoundId: input.targetRoundId,
        draftContentIds: history.filter(item => item.roundId === input.targetRoundId && item.role === 'user').map(item => item.contentId),
        draftInputIds, unconsumedInputIds, queueResumeRequired: input.mode === 'round_restart', files: input.files, committedAt: new Date().toISOString() };
    records.push({ key: factKey, revision: 1, value: receipt }, { key: conversationKey, revision: conversation.revision + 1,
        value: { ...conversation.value, historyEpoch: receipt.historyEpoch, viewRevision: receipt.viewRevision,
            workspaceRevision: input.workspaceRevision, lastWorkspaceRestore: receipt } });
    if (first) {
        const ranges = [...(mask?.value.ranges ?? []), { from: first.seq, through: appendSeq }];
        if (ranges.length > 128) throw new AgentFault('STORAGE_WORKSPACE_LIMIT', '临时回溯范围达到有界上限');
        records.push({ key: maskKey(context.conversationId), revision: (mask?.revision ?? 0) + 1,
            value: { kind: 'workspace_history_mask', ranges, summaryThrough: appendSeq } });
    }
    await store.commitTransition({ expected, records });
    return receipt;
}
