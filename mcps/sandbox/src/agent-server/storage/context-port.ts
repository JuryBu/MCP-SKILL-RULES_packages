import { randomUUID } from 'node:crypto';
import type { StateMutationPort, StorePort, StoreRecord, HistoryItem, HistoryQuery, ReceiptKey, StoredReceipt } from './port.js';
import type { AgentEvent, JsonValue } from '../protocol.js';
import { AgentFault } from '../protocol.js';
import type { CompactionCandidate, CompactionPort, ContextCapture, ExecutionLease, FrozenCompressionConfig, Publication,
    RoundBoundary, SchedulerCheckpoint, SummaryView, UnknownContextCleanupInput } from '../context/contracts.js';
import { hashContext } from '../context/config.js';
import { ContextFault } from '../context/errors.js';
import { validateCoverage } from '../context/compaction.js';
import { validatePublication, validateSummaryNodes } from '../context/view.js';
import { ContextTransactions, contextCandidateKey, contextContent, contextConversationKey, contextRunKey, contextStateKey,
    nextContextRecord, requireContextExecution, contextRootBudgetId } from './context-transactions.js';
import type { ContextCandidateData, ContextStateData } from './context-transactions.js';
import type { ModelStepPairing } from './port.js';
import { MAX_MODEL_STEP_PAIRINGS, modelStepPairing } from './model-step-pairing.js';

interface HistoryIndex { historyEpoch: number; appendSeq: number; coveredEndSeq: number; stepSeq: number; items: HistoryItem[] }

export interface StoreCompactionPortOptions {
    now?: () => number;
    maxIndexItems?: number;
    maxReadBytes?: number;
    maxCachedConversations?: number;
}

export class StoreCompactionPort implements CompactionPort {
    readonly transactions: ContextTransactions;
    private readonly index = new Map<string, HistoryIndex>();
    private readonly itemOwners = new WeakMap<HistoryItem, string>();
    private readonly now: () => number;
    private readonly maxIndexItems: number;
    private readonly maxReadBytes: number;
    private readonly maxCachedConversations: number;

    constructor(readonly store: StorePort, options: StoreCompactionPortOptions = {}) {
        this.transactions = new ContextTransactions(store);
        this.now = options.now ?? Date.now;
        this.maxIndexItems = options.maxIndexItems ?? 16_384;
        if (!Number.isSafeInteger(this.maxIndexItems) || this.maxIndexItems < 1) throw new ContextFault('CONFIG_INVALID', 'Context索引项目上限须为正安全整数');
        const requestedReadBytes = options.maxReadBytes ?? 262144;
        if (!Number.isSafeInteger(requestedReadBytes) || requestedReadBytes < 1) throw new ContextFault('CONFIG_INVALID', 'Context历史分页上限须为正安全整数');
        this.maxReadBytes = Math.min(requestedReadBytes, 262144);
        this.maxCachedConversations = options.maxCachedConversations ?? 16;
        if (!Number.isSafeInteger(this.maxCachedConversations) || this.maxCachedConversations < 1) throw new ContextFault('CONFIG_INVALID', 'Context会话索引缓存上限须为正安全整数');
    }

    async readHistory(query: HistoryQuery) {
        const page = await this.store.readHistory(query);
        for (const item of page.items) this.itemOwners.set(item, query.conversationId);
        return page;
    }
    ownerOf(item: HistoryItem): string | undefined { return this.itemOwners.get(item); }
    releaseConversation(conversationId: string): void { this.index.delete(conversationId); }
    cacheSnapshot(): { conversations: number; items: number; maximumConversations: number } {
        return { conversations: this.index.size, items: [...this.index.values()].reduce((total, entry) => total + entry.items.length, 0),
            maximumConversations: this.maxCachedConversations };
    }
    readContent(conversationId: string, contentId: string) { return this.store.readContent(conversationId, contentId); }

    private async conversation(conversationId: string, port: Pick<StateMutationPort, 'getRecord'> = this.store): Promise<StoreRecord> {
        const record = await port.getRecord(contextConversationKey(conversationId));
        if (!record || !['open', 'closing'].includes(String(record.value.state))) throw new ContextFault('HISTORY_STALE', 'Context会话已关闭或清理');
        return record;
    }

    async readExecutionForCleanup(conversationId: string): Promise<ExecutionLease | null> {
        const state = await this.transactions.readState(conversationId);
        return state.value.execution ? structuredClone(state.value.execution) : null;
    }

    async confirmUnknownExecutionCleanup(input: UnknownContextCleanupInput): Promise<boolean> {
        return this.transactions.mutateState(input.conversationId, async port => {
            const conversation = await port.getRecord(contextConversationKey(input.conversationId));
            const run = await port.getRecord(contextRunKey(input.conversationId, input.runId));
            if (!conversation || !['open', 'closing'].includes(String(conversation.value.state))
                || conversation.value.activeRunId !== input.runId || !run || run.value.state !== 'outcome_unknown'
                || run.value.conversationId !== input.conversationId || run.value.runId !== input.runId
                || !Number.isSafeInteger(input.runEpoch) || run.value.runEpoch !== input.runEpoch
                || typeof input.rootBudgetId !== 'string' || !input.rootBudgetId
                || contextRootBudgetId(run) !== input.rootBudgetId) return false;
            const state = await this.transactions.readState(input.conversationId, port);
            const execution = state.value.execution;
            return state.value.candidateId === null && (execution === null
                || execution.conversationId === input.conversationId && execution.runId === input.runId
                && execution.runEpoch === input.runEpoch && execution.rootBudgetId === input.rootBudgetId
                && execution.kind === run.value.kind);
        });
    }

    async reconcileExecutionCleanup(input: { conversationId: string; runId: string }):
        Promise<{ state: 'not_needed' | 'released' | 'unconfirmed'; candidateId: string | null }> {
        return this.retry(async () => {
            const conversation = await this.store.getRecord(contextConversationKey(input.conversationId));
            if (!conversation || !['open', 'closing', 'closed'].includes(String(conversation.value.state))) {
                return { state: 'unconfirmed', candidateId: null };
            }
            const state = await this.transactions.readState(input.conversationId);
            const execution = state.value.execution;
            const run = await this.store.getRecord(contextRunKey(input.conversationId, input.runId));
            if (!run || !['succeeded', 'failed', 'cancelled'].includes(String(run.value.state))) {
                return { state: 'unconfirmed', candidateId: state.value.candidateId };
            }
            if (!execution) return { state: state.value.candidateId ? 'unconfirmed' : 'not_needed', candidateId: state.value.candidateId };
            const closedByOneStop = run.value.state === 'cancelled' && run.value.stopTarget === 'cancelled'
                && run.value.stopReason === 'CONVERSATION_CLOSED' && run.value.cleanupState === 'unconfirmed'
                && ['none', 'confirmed'].includes(String(run.value.effectState)) && run.value.runEpoch === execution.runEpoch + 1;
            if (execution.conversationId !== input.conversationId || execution.runId !== input.runId || execution.kind !== run.value.kind
                || execution.runEpoch !== run.value.runEpoch && !closedByOneStop) {
                return { state: 'unconfirmed', candidateId: state.value.candidateId };
            }
            if (contextRootBudgetId(run) !== execution.rootBudgetId) {
                return { state: 'unconfirmed', candidateId: state.value.candidateId };
            }
            const candidateId = state.value.candidateId;
            const candidate = candidateId ? await this.getCandidate(input.conversationId, candidateId) : null;
            if (candidateId && !candidate) return { state: 'unconfirmed', candidateId };
            if (candidate && (candidate.snapshot.runId !== input.runId || candidate.snapshot.runEpoch !== execution.runEpoch
                || candidate.snapshot.execution.rootBudgetId !== execution.rootBudgetId)) return { state: 'unconfirmed', candidateId };
            if (candidate && (candidate.state === 'publishing' || candidate.state === 'unknown' && !candidate.pendingRequest)) {
                return { state: 'unconfirmed', candidateId };
            }
            const candidateRecord = candidateId ? await this.store.getRecord<ContextCandidateData>(contextCandidateKey(input.conversationId, candidateId)) : undefined;
            const next = nextContextRecord(contextStateKey(input.conversationId), state.record, { ...state.value, execution: null,
                candidateId: null, compressionGeneration: randomUUID(), checkpoint: null, checkpointContentId: null });
            const records: StoreRecord[] = [next];
            const contents = [];
            if (candidate && candidateRecord && !['published', 'discarded', 'cancelled', 'failed'].includes(candidate.state)) {
                const discarded = { ...candidate, state: 'discarded' as const };
                const contentId = randomUUID();
                records.push(nextContextRecord(candidateRecord.key, candidateRecord, { ...candidateRecord.value, state: 'discarded',
                    contentId, contentHash: hashContext(discarded) }));
                contents.push(contextContent(input.conversationId, contentId, 'context_candidate', discarded));
            }
            await this.transactions.commit({ expected: [{ key: conversation.key, revision: conversation.revision },
                { key: run.key, revision: run.revision }, { key: next.key, revision: state.record?.revision ?? null },
                ...(candidateRecord ? [{ key: candidateRecord.key, revision: candidateRecord.revision }] : [])], records, contents });
            return { state: 'released', candidateId };
        });
    }

    private async retry<Value>(operation: () => Promise<Value>): Promise<Value> {
        for (let attempt = 0; ; attempt++) {
            try { return await operation(); }
            catch (error) {
                if (attempt >= 3 || !(error instanceof Error && 'code' in error && error.code === 'REVISION_CONFLICT')) throw error;
            }
        }
    }

    async bindExecution(execution: ExecutionLease, config?: FrozenCompressionConfig): Promise<void> {
        const contentId = config ? randomUUID() : null;
        const content = config && contentId ? contextContent(execution.conversationId, contentId, 'context_config', config) : null;
        await this.retry(() => this.transactions.mutateState(execution.conversationId, async port => {
            const conversation = await this.conversation(execution.conversationId, port);
            const run = await port.getRecord(contextRunKey(execution.conversationId, execution.runId));
            requireContextExecution(conversation, run, execution, this.now());
            const state = await this.transactions.readState(execution.conversationId, port);
            if (hashContext(state.value.execution) === hashContext(execution) && (!config || state.value.configFingerprint === config.configFingerprint)) return;
            const next = nextContextRecord(contextStateKey(execution.conversationId), state.record, { ...state.value,
                execution: structuredClone(execution), ...(config ? { effectiveModelFingerprint: config.modelFingerprint, configContentId: contentId, configFingerprint: config.configFingerprint } : {}) });
            await this.transactions.commit({ expected: [{ key: conversation.key, revision: conversation.revision },
                { key: run!.key, revision: run!.revision }, { key: next.key, revision: state.record?.revision ?? null }], records: [next],
                ...(content ? { contents: [content] } : {}) }, port);
        }));
    }

    async readConfig(conversationId: string): Promise<FrozenCompressionConfig | null> {
        const state = await this.transactions.readState(conversationId);
        return state.value.configContentId ? this.transactions.readObject(conversationId, state.value.configContentId) : null;
    }

    private async historyIndex(conversationId: string, conversation: StoreRecord, view: SummaryView,
        storedCheckpoint?: ContextStateData['historyCheckpoint']): Promise<HistoryIndex> {
        const historyEpoch = Number(conversation.value.historyEpoch);
        const appendSeq = Number(conversation.value.appendSeq);
        const cached = this.index.get(conversationId);
        if (cached && cached.historyEpoch === historyEpoch && cached.appendSeq === appendSeq && cached.coveredEndSeq === view.coveredEndSeq) {
            this.index.delete(conversationId);
            this.index.set(conversationId, cached);
            return cached;
        }
        const incremental = cached?.historyEpoch === historyEpoch && cached.appendSeq <= appendSeq ? cached : undefined;
        const checkpoint = !incremental && storedCheckpoint?.historyEpoch === historyEpoch
            && Number.isSafeInteger(storedCheckpoint.throughSeq) && storedCheckpoint.throughSeq >= view.coveredEndSeq
            && storedCheckpoint.throughSeq <= appendSeq && Number.isSafeInteger(storedCheckpoint.stepSeq) && storedCheckpoint.stepSeq >= 0
            ? storedCheckpoint : null;
        const fresh: HistoryItem[] = [];
        let cursor: string | undefined;
        const cursors = new Set<string>();
        let done = false;
        let addedSteps = 0;
        let referenceRoundId: string | null = null;
        do {
            const page = await this.store.readHistory({ conversationId, cursor, direction: 'backward', limit: 50,
                maxBytes: this.maxReadBytes, view: 'raw', effectiveOnly: true, includeValues: false, expectedHistoryEpoch: historyEpoch,
                ...(cursor ? {} : { throughSeq: appendSeq }) });
            if (page.historyEpoch !== historyEpoch || page.appendSeq !== appendSeq) throw new ContextFault('HISTORY_STALE', 'Context元数据索引读取期间版本改变');
            for (const item of page.items) {
                if (incremental && item.seq <= incremental.appendSeq) { done = true; break; }
                if ((item.role === 'user' || item.role === 'assistant') && (!checkpoint || item.seq > checkpoint.throughSeq)) addedSteps++;
                if (!incremental && item.seq <= view.coveredEndSeq) {
                    referenceRoundId ??= item.roundId;
                    if (item.roundId !== referenceRoundId) {
                        if (checkpoint) { done = true; break; }
                        continue;
                    }
                }
                const { value: _value, ...metadata } = item;
                fresh.push(metadata);
                if (fresh.length > this.maxIndexItems) throw new ContextFault('INPUT_BUDGET', '未压缩原文索引达到有界项目上限', { maxIndexItems: this.maxIndexItems });
            }
            if (done || !page.hasMore) break;
            if (!page.nextCursor || cursors.has(page.nextCursor)) throw new ContextFault('SOURCE_GAP', 'Context元数据分页未推进');
            cursors.add(page.nextCursor);
            cursor = page.nextCursor;
        } while (cursor);
        fresh.reverse();
        const all = [...(incremental?.items ?? []), ...fresh];
        const stepSeq = (incremental?.stepSeq ?? checkpoint?.stepSeq ?? 0) + addedSteps;
        const coveredRound = all.filter(item => item.seq <= view.coveredEndSeq).at(-1)?.roundId;
        const items = all.filter(item => item.seq > view.coveredEndSeq || (coveredRound !== undefined && item.roundId === coveredRound));
        if (items.length > this.maxIndexItems) throw new ContextFault('INPUT_BUDGET', '累计未压缩原文索引达到有界项目上限',
            { maxIndexItems: this.maxIndexItems, indexedItems: items.length, appendSeq, coveredEndSeq: view.coveredEndSeq });
        const result = { historyEpoch, appendSeq, coveredEndSeq: view.coveredEndSeq, stepSeq, items };
        this.index.delete(conversationId);
        this.index.set(conversationId, result);
        while (this.index.size > this.maxCachedConversations) this.index.delete(this.index.keys().next().value!);
        return result;
    }

    private async readPairings(conversationId: string, items: HistoryItem[]): Promise<Map<string, ModelStepPairing>> {
        const stepIds = [...new Set(items.filter(item => item.role === 'assistant' && item.stepId).map(item => item.stepId!))];
        const pairings = new Map<string, ModelStepPairing>();
        for (let offset = 0; offset < stepIds.length; offset += MAX_MODEL_STEP_PAIRINGS) {
            const ids = stepIds.slice(offset, offset + MAX_MODEL_STEP_PAIRINGS);
            const states: ModelStepPairing[] = [];
            if (this.store.readModelStepPairings) states.push(...await this.store.readModelStepPairings({ conversationId, stepIds: ids }));
            else for (const id of ids) states.push(modelStepPairing((await this.store.getRecord({ conversationId, kind: 'step', id }))?.value));
            if (states.length !== ids.length) throw new ContextFault('SOURCE_GAP', '模型步骤配对批读未返回全部步骤');
            for (let index = 0; index < ids.length; index++) pairings.set(ids[index], states[index]);
        }
        return pairings;
    }

    async inspect(conversationId: string): Promise<ContextCapture> {
        const conversation = await this.conversation(conversationId);
        const state = await this.transactions.readState(conversationId);
        const historyEpoch = Number(conversation.value.historyEpoch);
        const viewRevision = Number(conversation.value.viewRevision);
        const view = state.value.viewContentId ? await this.transactions.readObject<SummaryView>(conversationId, state.value.viewContentId)
            : { revision: viewRevision, historyEpoch, coveredEndSeq: 0, nodes: [] };
        if (view.revision !== viewRevision || view.historyEpoch !== historyEpoch) throw new ContextFault('PARENT_STALE', 'Context已提交视图与会话版本不同');
        let execution = state.value.execution;
        let activeRoundId: string | null = null;
        if (typeof conversation.value.activeRunId === 'string') {
            const run = await this.store.getRecord(contextRunKey(conversationId, conversation.value.activeRunId));
            activeRoundId = typeof run?.value.activeRoundId === 'string' ? run.value.activeRoundId : null;
            if (!execution || execution.runId !== run?.value.runId || execution.runEpoch !== run.value.runEpoch
                || ['succeeded', 'failed', 'cancelled'].includes(String(run?.value.state))) execution = null;
        } else execution = null;
        const index = await this.historyIndex(conversationId, conversation, view, state.value.historyCheckpoint);
        const pairings = await this.readPairings(conversationId, index.items);
        const groups = new Map<string, HistoryItem[]>();
        for (const item of index.items) {
            if (!item.roundId) throw new ContextFault('SOURCE_GAP', '有效原文缺少显式roundId', { itemId: item.itemId });
            const items = groups.get(item.roundId) ?? [];
            items.push(item);
            groups.set(item.roundId, items);
        }
        let stepSeq = index.stepSeq - index.items.filter(item => item.role === 'user' || item.role === 'assistant').length;
        const rounds: RoundBoundary[] = [];
        for (const [roundId, items] of groups) {
            let nativePairing: RoundBoundary['nativePairing'] = 'complete';
            const models = items.filter(item => item.role === 'assistant');
            for (const model of models) {
                const pairing = model.stepId ? pairings.get(model.stepId) : 'incomplete';
                if (pairing === 'incomplete' || pairing === undefined) { nativePairing = 'pending'; break; }
                if (pairing !== 'complete') nativePairing = pairing;
            }
            stepSeq += items.filter(item => item.role === 'user' || item.role === 'assistant').length;
            rounds.push({ roundId, itemIds: items.map(item => item.itemId), firstSeq: items[0].seq, lastSeq: items.at(-1)!.seq,
                lastStepSeq: stepSeq, complete: roundId !== activeRoundId && models.length > 0 && nativePairing === 'complete', nativePairing });
        }
        return { conversationId, historyEpoch, appendSeq: index.appendSeq, viewRevision,
            workspaceRevision: Number(conversation.value.workspaceRevision ?? 0), compressionGeneration: state.value.compressionGeneration,
            effectiveModelFingerprint: state.value.effectiveModelFingerprint, historyRoot: typeof conversation.value.historyRoot === 'string'
                ? conversation.value.historyRoot : `store:${conversationId}:${historyEpoch}:${index.appendSeq}`,
            stepSeq: index.stepSeq, activeRoundId, rounds, view, execution, candidateId: state.value.candidateId };
    }

    async claim(input: Parameters<CompactionPort['claim']>[0]): Promise<ContextCapture> {
        await this.retry(async () => {
            const conversation = await this.conversation(input.conversationId);
            const run = await this.store.getRecord(contextRunKey(input.conversationId, input.execution.runId));
            requireContextExecution(conversation, run, input.execution, this.now());
            const state = await this.transactions.readState(input.conversationId);
            if (Number(conversation.value.historyEpoch) !== input.expectedHistoryEpoch || Number(conversation.value.viewRevision) !== input.expectedViewRevision
                || state.value.compressionGeneration !== input.expectedGeneration) throw new ContextFault('HISTORY_STALE', '压缩所有权的比较版本已经变化');
            if (state.value.candidateId) {
                const prior = await this.getCandidate(input.conversationId, state.value.candidateId);
                if (prior && ['snapshotting', 'generating', 'ready', 'publishing', 'unknown'].includes(prior.state)) throw new ContextFault('COMPACTION_BUSY', '会话已有有效压缩所有者');
            }
            const next = nextContextRecord(contextStateKey(input.conversationId), state.record,
                { ...state.value, compressionGeneration: input.compressionGeneration, execution: input.execution, candidateId: null });
            await this.transactions.commit({ expected: [{ key: conversation.key, revision: conversation.revision },
                { key: run!.key, revision: run!.revision }, { key: next.key, revision: state.record?.revision ?? null }], records: [next] });
        });
        return this.inspect(input.conversationId);
    }

    async saveCandidate(candidate: CompactionCandidate): Promise<void> {
        const contentId = randomUUID();
        const content = contextContent(candidate.conversationId, contentId, 'context_candidate', candidate);
        const contentHash = hashContext(candidate);
        await this.retry(() => this.transactions.mutateState(candidate.conversationId, async port => {
            const conversation = await this.conversation(candidate.conversationId, port);
            const state = await this.transactions.readState(candidate.conversationId, port);
            const key = contextCandidateKey(candidate.conversationId, candidate.candidateId);
            const previous = await port.getRecord<ContextCandidateData>(key);
            if (previous?.value.state === 'published') return;
            if (previous && ['discarded', 'cancelled'].includes(previous.value.state)) throw new ContextFault('HISTORY_STALE', '压缩候选已被丢弃');
            if (state.value.compressionGeneration !== candidate.snapshot.compressionGeneration
                || Number(conversation.value.historyEpoch) !== candidate.snapshot.historyEpoch) throw new ContextFault('HISTORY_STALE', '候选历史或压缩代次已经变化');
            const run = await port.getRecord(contextRunKey(candidate.conversationId, candidate.snapshot.runId));
            if (['snapshotting', 'generating', 'ready'].includes(candidate.state)) requireContextExecution(conversation, run, candidate.snapshot.execution, this.now());
            const index = nextContextRecord(key, previous, { kind: 'context_candidate' as const, candidateId: candidate.candidateId,
                state: candidate.state, contentId, contentHash, runId: candidate.snapshot.runId,
                runEpoch: candidate.snapshot.runEpoch, compressionGeneration: candidate.snapshot.compressionGeneration,
                historyEpoch: candidate.snapshot.historyEpoch, parentViewRevision: candidate.snapshot.parentViewRevision,
                publishedViewRevision: candidate.publishedViewRevision, pendingAttemptId: candidate.pendingRequest?.attemptId ?? null });
            const next = nextContextRecord(contextStateKey(candidate.conversationId), state.record, { ...state.value, candidateId: candidate.candidateId });
            await this.transactions.commit({ expected: [{ key: conversation.key, revision: conversation.revision },
                { key, revision: previous?.revision ?? null }, { key: next.key, revision: state.record?.revision ?? null },
                ...(run ? [{ key: run.key, revision: run.revision }] : [])], records: [index, next],
                contents: [content] }, port);
        }));
    }

    async getCandidate(conversationId: string, candidateId: string): Promise<CompactionCandidate | null> {
        const index = await this.store.getRecord<ContextCandidateData>(contextCandidateKey(conversationId, candidateId));
        return index ? this.transactions.readObject<CompactionCandidate>(conversationId, index.value.contentId, index.value.contentHash) : null;
    }

    async getPublication(receiptKey: ReceiptKey): Promise<Publication | null> {
        const receipt = await this.store.getReceipt(receiptKey);
        const data = receipt?.result.ok ? receipt.result.data as unknown as Publication : null;
        return data && typeof data.candidateId === 'string' && Number.isSafeInteger(data.viewRevision) && Number.isSafeInteger(data.coveredEndSeq) ? data : null;
    }

    async publishCandidate(input: Parameters<CompactionPort['publishCandidate']>[0]): Promise<Publication> {
        const original = await this.getPublication(input.receiptKey);
        if (original) {
            if (original.candidateId !== input.candidate.candidateId) throw new AgentFault('COMMAND_CONFLICT', '同一压缩发布命令已经用于另一候选');
            return { ...original, replayed: true };
        }
        return this.retry(async () => {
            const candidate = input.candidate;
            const existing = await this.getCandidate(candidate.conversationId, candidate.candidateId);
            if (existing?.state === 'published') return { candidateId: candidate.candidateId, viewRevision: existing.publishedViewRevision!,
                coveredEndSeq: existing.coverage!.coveredEndSeq, appendSeq: (await this.inspect(candidate.conversationId)).appendSeq, replayed: true };
            if (existing?.state !== 'ready' || candidate.state !== 'ready' || hashContext(existing) !== hashContext(candidate)) throw new ContextFault('PARENT_STALE', '发布候选与ready持久对象不同');
            const capture = await this.inspect(candidate.conversationId);
            validatePublication(candidate, capture, candidate.snapshot.sourcePrefixHash);
            const coverage = validateCoverage(candidate.snapshot.manifest, candidate.chunks, capture.view.coveredEndSeq);
            if (!candidate.nextView || !candidate.batch || !coverage.completeRoundIds.length || hashContext(coverage) !== hashContext(candidate.coverage)
                || coverage.coveredEndSeq !== candidate.nextView.coveredEndSeq || candidate.batch.lastSeq !== coverage.coveredEndSeq
                || candidate.nextView.revision !== capture.viewRevision + 1) throw new ContextFault('SOURCE_GAP', '实际连续覆盖与发布视图不同');
            validateSummaryNodes(candidate.nextView.nodes);
            const conversation = await this.conversation(candidate.conversationId);
            const state = await this.transactions.readState(candidate.conversationId);
            const run = await this.store.getRecord(contextRunKey(candidate.conversationId, candidate.snapshot.runId));
            requireContextExecution(conversation, run, candidate.snapshot.execution, this.now());
            if (Number(conversation.value.historyEpoch) !== capture.historyEpoch || Number(conversation.value.viewRevision) !== capture.viewRevision
                || state.value.compressionGeneration !== capture.compressionGeneration || state.value.effectiveModelFingerprint !== capture.effectiveModelFingerprint) {
                throw new ContextFault('HISTORY_STALE', '发布准备期间Context版本已经变化');
            }
            const history = await this.historyIndex(candidate.conversationId, conversation, capture.view, state.value.historyCheckpoint);
            const sourceItems = new Map(history.items.map(item => [item.itemId, item]));
            for (const block of candidate.snapshot.manifest.blocks) {
                const item = sourceItems.get(block.itemId);
                if (!item || item.seq !== block.seq || item.roundId !== block.roundId || item.contentId !== block.contentId
                    || item.objectRef.hash !== block.retrieval.rawObjectHash || item.objectRef.rawBytes !== block.retrieval.rawObjectBytes) {
                    throw new ContextFault('SOURCE_GAP', '发布前的不可变来源前缀与实际历史索引不同', { itemId: block.itemId, blockId: block.blockId });
                }
            }
            const previous = await this.store.getRecord<ContextCandidateData>(contextCandidateKey(candidate.conversationId, candidate.candidateId));
            if (previous?.value.state !== 'ready' || previous.value.contentHash !== hashContext(candidate) || state.value.candidateId !== candidate.candidateId) {
                throw new ContextFault('PARENT_STALE', '候选在发布事务前已被取消或替换');
            }
            const published = { ...candidate, state: 'published' as const, publishedViewRevision: candidate.nextView.revision };
            const candidateContentId = randomUUID();
            const viewContentId = randomUUID();
            const candidateRecord = nextContextRecord(previous!.key, previous, { ...previous!.value, state: 'published', contentId: candidateContentId,
                contentHash: hashContext(published), publishedViewRevision: candidate.nextView.revision });
            const stateRecord = nextContextRecord(contextStateKey(candidate.conversationId), state.record, { ...state.value, viewContentId,
                historyCheckpoint: { historyEpoch: history.historyEpoch, throughSeq: history.appendSeq, stepSeq: history.stepSeq } });
            const eventSeq = String(BigInt(String(conversation.value.eventSeq ?? '0')) + 1n);
            const conversationRecord = { ...conversation, revision: conversation.revision + 1, value: { ...conversation.value,
                viewRevision: candidate.nextView.revision, eventSeq, updatedAt: new Date(this.now()).toISOString() } };
            const publication: Publication = { candidateId: candidate.candidateId, viewRevision: candidate.nextView.revision,
                coveredEndSeq: coverage.coveredEndSeq, appendSeq: Number(conversation.value.appendSeq), replayed: false };
            const receipt: StoredReceipt = { key: input.receiptKey, operationHash: hashContext(['context.publish', candidate.candidateId]),
                result: { ok: true, data: publication as unknown as JsonValue }, createdAt: new Date(this.now()).toISOString() };
            const event: AgentEvent = { schemaVersion: 1, eventId: randomUUID(), eventSeq, conversationId: candidate.conversationId,
                runId: candidate.snapshot.runId, runEpoch: candidate.snapshot.runEpoch, occurredAt: new Date(this.now()).toISOString(),
                type: 'context.published', payload: { candidateId: candidate.candidateId, viewRevision: publication.viewRevision, coveredEndSeq: publication.coveredEndSeq } };
            const result = await this.transactions.commit({ expected: [{ key: conversation.key, revision: conversation.revision },
                { key: previous!.key, revision: previous!.revision }, { key: stateRecord.key, revision: state.record?.revision ?? null },
                { key: run!.key, revision: run!.revision }], records: [conversationRecord, stateRecord, candidateRecord],
                contents: [contextContent(candidate.conversationId, candidateContentId, 'context_candidate', published),
                    contextContent(candidate.conversationId, viewContentId, 'context_view', candidate.nextView)], receipt, events: [event] });
            if (!result.replayed) return publication;
            const replay = result.receipt?.result.ok ? result.receipt.result.data as unknown as Publication : await this.getPublication(input.receiptKey);
            if (!replay) throw new ContextFault('COMMIT_UNKNOWN', '发布已重放但原回执尚不可取', undefined, true);
            return { ...replay, replayed: true };
        });
    }

    async discardCandidate(input: Parameters<CompactionPort['discardCandidate']>[0]): Promise<void> {
        await this.retry(async () => {
            const state = await this.transactions.readState(input.conversationId);
            if (state.value.compressionGeneration !== input.generation) throw new ContextFault('HISTORY_STALE', '待丢弃候选的压缩代次已失效');
            const candidate = await this.getCandidate(input.conversationId, input.candidateId);
            if (!candidate || candidate.state === 'published') return;
            const index = await this.store.getRecord<ContextCandidateData>(contextCandidateKey(input.conversationId, input.candidateId));
            const contentId = randomUUID();
            const discarded = { ...candidate, state: input.state };
            const record = nextContextRecord(index!.key, index, { ...index!.value, state: input.state, contentId, contentHash: hashContext(discarded) });
            const next = nextContextRecord(contextStateKey(input.conversationId), state.record, { ...state.value, candidateId: null });
            await this.transactions.commit({ expected: [{ key: record.key, revision: index!.revision }, { key: next.key, revision: state.record?.revision ?? null }],
                records: [record, next], contents: [contextContent(input.conversationId, contentId, 'context_candidate', discarded)] });
        });
    }

    async loadScheduler(conversationId: string): Promise<SchedulerCheckpoint | null> {
        const state = (await this.transactions.readState(conversationId)).value;
        return state.checkpointContentId ? this.transactions.readObject(conversationId, state.checkpointContentId) : state.checkpoint;
    }
    saveScheduler(conversationId: string, checkpoint: SchedulerCheckpoint): Promise<void> { return this.transactions.checkpoint(conversationId, checkpoint); }
}

export function createStoreCompactionPort(store: StorePort, options?: StoreCompactionPortOptions): StoreCompactionPort {
    return new StoreCompactionPort(store, options);
}
