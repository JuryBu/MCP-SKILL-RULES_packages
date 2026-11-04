import { randomUUID } from 'node:crypto';
import type { StateMutationPort, StorePort, StoreRecord, HistoryItem, HistoryQuery, ReceiptKey, StoredReceipt, StoreTransition, HistoryMetadataQuery } from './port.js';
import type { AgentEvent, JsonValue } from '../protocol.js';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { CompactionCandidate, CompactionPort, ContextCapture, ExecutionLease, FrozenCompressionConfig, Publication,
    RoundBoundary, SchedulerCheckpoint, SummaryNode, SummaryView, UnknownContextCleanupInput, RequirementSourceMetadata, ContextPolicy } from '../context/contracts.js';
import { hashBytes, hashContext } from '../context/config.js';
import { ContextFault } from '../context/errors.js';
import { validateCoverage } from '../context/compaction.js';
import { sealPublishedSummaryView, validatePublication, validateSummaryNodes } from '../context/view.js';
import { applyPublishedHistoryFeedback, readHistoryFeedbackSnapshot } from '../context/feedback.js';
import { ContextTransactions, contextCandidateKey, contextContent, contextConversationKey, contextRunKey, contextStateKey,
    nextContextRecord, requireContextExecution, contextRootBudgetId, contextFeedbackStateKey, contextSummaryKey,
    MAX_CONTEXT_SUMMARY_NODE_BYTES, MAX_CONTEXT_SUMMARY_ARCHIVE_BYTES, MAX_CONTEXT_SUMMARY_ARCHIVE_NODES } from './context-transactions.js';
import type { ContextCandidateData, ContextStateData, ContextSummaryArchiveData, ContextSummaryReadInput } from './context-transactions.js';
import type { ModelStepPairing } from './port.js';
import { MAX_MODEL_STEP_PAIRINGS, modelStepPairing } from './model-step-pairing.js';
import { measureCanonicalJsonBytes } from '../media/temporary-budget.js';
import { MAX_WRITE_BATCH } from './internal.js';
import { isStoppedUnknownWait } from '../cleanup-reconciliation.js';
import { bootstrapCommunicationWindow, communicationNeedsBootstrap, renderCommunicationWindow } from '../context/communication-window.js';
import type { CommunicationWindow } from '../context/communication-window.js';
import { createArtifactHistorySourcePort } from '../context/artifact-source.js';

interface HistoryIndex { historyEpoch: number; appendSeq: number; coveredEndSeq: number; stepSeq: number; items: HistoryItem[] }

export interface StoreCompactionPortOptions {
    now?: () => number;
    maxIndexItems?: number;
    maxReadBytes?: number;
    maxCachedConversations?: number;
    maxCommunicationScanItems?: number;
    maxCommunicationScanBytes?: number;
    maxCommunicationReadBytes?: number;
}

export class StoreCompactionPort implements CompactionPort {
    readonly transactions: ContextTransactions;
    private readonly index = new Map<string, HistoryIndex>();
    private readonly itemOwners = new WeakMap<HistoryItem, string>();
    private readonly now: () => number;
    private readonly maxIndexItems: number;
    private readonly maxReadBytes: number;
    private readonly maxCachedConversations: number;
    private readonly communicationBounds: { maxScanItems: number; maxScanBytes: number; maxReadBytes: number };

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
        this.communicationBounds = { maxScanItems: options.maxCommunicationScanItems ?? 4096,
            maxScanBytes: options.maxCommunicationScanBytes ?? 4 * 1024 * 1024,
            maxReadBytes: options.maxCommunicationReadBytes ?? 16 * 1024 * 1024 };
        if (!Object.values(this.communicationBounds).every(value => Number.isSafeInteger(value) && value > 0)) throw new ContextFault('CONFIG_INVALID', '交流首次窗口扫描/原文预算须为正安全整数');
    }

    async readHistory(query: HistoryQuery) {
        const page = await this.store.readHistory(query);
        for (const item of page.items) this.itemOwners.set(item, query.conversationId);
        return page;
    }

    async readRequirementSourceMetadata(input: HistoryMetadataQuery): Promise<{ historyEpoch: number; items: RequirementSourceMetadata[] }> {
        if (!input || typeof input.conversationId !== 'string' || !input.conversationId.trim()
            || !Number.isSafeInteger(input.historyEpoch) || input.historyEpoch < 0 || !Array.isArray(input.itemIds)) {
            throw new AgentFault('INVALID_PARAMS', '要求来源元数据查询参数无效');
        }
        const query = { conversationId: input.conversationId, historyEpoch: input.historyEpoch, itemIds: [...new Set(input.itemIds)] };
        if (query.itemIds.length > 64 || query.itemIds.some(itemId => typeof itemId !== 'string' || !itemId.trim())) {
            throw new AgentFault('INVALID_PARAMS', '要求来源查询须包含最多64个唯一有效项目ID');
        }
        const requireEpoch = async () => {
            const conversation = await this.conversation(query.conversationId);
            if (Number(conversation.value.historyEpoch) !== query.historyEpoch) throw new ContextFault('HISTORY_STALE', '要求来源的历史代次已经变化');
        };
        await requireEpoch();
        const result = this.store.readHistoryMetadata ? await this.store.readHistoryMetadata(query) : { historyEpoch: query.historyEpoch, items: [] };
        if (result.historyEpoch !== query.historyEpoch) throw new ContextFault('HISTORY_STALE', '要求来源的历史代次已经变化');
        const requested = new Set(query.itemIds);
        const runs = new Map<string, StoreRecord | undefined>();
        const items: RequirementSourceMetadata[] = [];
        for (const item of result.items) {
            if (!requested.delete(item.itemId) || !Number.isSafeInteger(item.seq) || item.seq < 1
                || !['user', 'assistant', 'tool', 'system'].includes(item.role)
                || !(item.roundId === null || typeof item.roundId === 'string' && item.roundId.length > 0)) {
                throw new ContextFault('SOURCE_GAP', '要求来源元数据与请求不一致');
            }
            const source: RequirementSourceMetadata = { itemId: item.itemId, seq: item.seq, role: item.role, roundId: item.roundId };
            if (item.runId && item.roundId) {
                if (!runs.has(item.runId)) runs.set(item.runId, await this.store.getRecord(contextRunKey(query.conversationId, item.runId)));
                const run = runs.get(item.runId);
                const state = run?.value.state;
                if (run?.key.conversationId === query.conversationId && run.key.kind === 'run' && run.key.id === item.runId
                    && run.value.conversationId === query.conversationId && run.value.runId === item.runId
                    && (run.value.activeRoundId === null || run.value.activeRoundId === item.roundId)
                    && (state === 'succeeded' || state === 'failed' || state === 'cancelled')
                    && (run.value.cleanupState === 'not_needed' || run.value.cleanupState === 'released')
                    && run.value.internalOwnCleanupState === 'released') {
                    source.terminalOutcome = { state, stopReason: typeof run.value.stopReason === 'string' ? run.value.stopReason : null };
                }
            }
            items.push(source);
        }
        await requireEpoch();
        return { historyEpoch: query.historyEpoch, items };
    }
    ownerOf(item: HistoryItem): string | undefined { return this.itemOwners.get(item); }
    releaseConversation(conversationId: string): void { this.index.delete(conversationId); }
    cacheSnapshot(): { conversations: number; items: number; maximumConversations: number } {
        return { conversations: this.index.size, items: [...this.index.values()].reduce((total, entry) => total + entry.items.length, 0),
            maximumConversations: this.maxCachedConversations };
    }
    readContent(conversationId: string, contentId: string) { return this.store.readContent(conversationId, contentId); }

    private async communicationView(conversationId: string, state: ContextStateData, view: SummaryView): Promise<SummaryView> {
        const bootstrap = state.communicationBootstrap;
        if (!bootstrap || bootstrap.historyEpoch !== view.historyEpoch || bootstrap.viewRevision !== view.revision
            || bootstrap.coveredEndSeq !== view.coveredEndSeq) return view;
        const window = await this.transactions.readObject<CommunicationWindow>(conversationId, bootstrap.contentId, bootstrap.contentHash);
        if (window.historyEpoch !== view.historyEpoch || window.coveredEndSeq !== view.coveredEndSeq) throw new ContextFault('PARENT_STALE', '首次交流窗口与已发布范围不同');
        renderCommunicationWindow(window);
        return { ...view, communicationWindow: window };
    }

    async ensureCommunicationWindow(input: { conversationId: string; policy: ContextPolicy; signal?: AbortSignal }): Promise<SummaryView> {
        if (input.signal?.aborted) throw new ContextFault('CANCELLED', '交流首次窗口已取消');
        const conversation = await this.conversation(input.conversationId);
        const state = await this.transactions.readState(input.conversationId);
        const rawView = state.value.viewContentId ? await this.transactions.readObject<SummaryView>(input.conversationId, state.value.viewContentId)
            : { revision: Number(conversation.value.viewRevision), historyEpoch: Number(conversation.value.historyEpoch), coveredEndSeq: 0, nodes: [] };
        const view = await this.communicationView(input.conversationId, state.value, rawView);
        if (view.revision !== Number(conversation.value.viewRevision) || view.historyEpoch !== Number(conversation.value.historyEpoch)) throw new ContextFault('PARENT_STALE', '首次交流窗口需要同一已发布视图');
        if (!communicationNeedsBootstrap(view.communicationWindow, view.coveredEndSeq, input.policy)) return view;
        const sources = createArtifactHistorySourcePort(this.store, { conversationId: input.conversationId,
            maxBytes: this.communicationBounds.maxReadBytes, maxCacheBytes: this.communicationBounds.maxReadBytes, preferProjection: true });
        const window = await bootstrapCommunicationWindow({ conversationId: input.conversationId, historyEpoch: view.historyEpoch,
            viewRevision: view.revision, coveredEndSeq: view.coveredEndSeq, policy: input.policy,
            history: this, sources, previous: view.communicationWindow, signal: input.signal, ...this.communicationBounds });
        return this.retry(() => this.transactions.mutateState(input.conversationId, async port => {
            if (input.signal?.aborted) throw new ContextFault('CANCELLED', '交流首次窗口发布前已取消');
            const current = await this.conversation(input.conversationId, port);
            const latest = await this.transactions.readState(input.conversationId, port);
            if (current.value.historyEpoch !== view.historyEpoch || current.value.viewRevision !== view.revision
                || latest.value.viewContentId !== state.value.viewContentId) throw new ContextFault('HISTORY_STALE', '首次交流窗口提交前发布视图已改变');
            const known = latest.value.communicationBootstrap;
            if (known?.historyEpoch === view.historyEpoch && known.viewRevision === view.revision && known.coveredEndSeq === view.coveredEndSeq) {
                const adopted = await this.communicationView(input.conversationId, latest.value, rawView);
                if (!communicationNeedsBootstrap(adopted.communicationWindow, view.coveredEndSeq, input.policy)) return adopted;
            }
            const contentId = randomUUID();
            const next = nextContextRecord(contextStateKey(input.conversationId), latest.record, { ...latest.value,
                communicationBootstrap: { historyEpoch: view.historyEpoch, viewRevision: view.revision, coveredEndSeq: view.coveredEndSeq,
                    contentId, contentHash: hashContext(window) } });
            await this.transactions.commit({ expected: [{ key: current.key, revision: current.revision },
                { key: next.key, revision: latest.record?.revision ?? null }], records: [next],
                contents: [contextContent(input.conversationId, contentId, 'context_communication_bootstrap', window)] }, port);
            return { ...rawView, communicationWindow: window };
        }));
    }

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
        return this.retry(() => this.transactions.mutateState(input.conversationId, async port => {
            const conversation = await port.getRecord(contextConversationKey(input.conversationId));
            const run = await port.getRecord(contextRunKey(input.conversationId, input.runId));
            const stopped = run ? isStoppedUnknownWait(run.value) : false;
            if (!conversation || !['open', 'closing'].includes(String(conversation.value.state))
                || conversation.value.activeRunId !== input.runId || !run || run.value.state !== 'outcome_unknown' && !stopped
                || run.value.conversationId !== input.conversationId || run.value.runId !== input.runId
                || !Number.isSafeInteger(input.runEpoch) || run.value.runEpoch !== input.runEpoch
                || typeof input.rootBudgetId !== 'string' || !input.rootBudgetId
                || contextRootBudgetId(run) !== input.rootBudgetId) return false;
            const state = await this.transactions.readState(input.conversationId, port);
            const execution = state.value.execution;
            const sourceRunEpoch = input.runEpoch - (stopped ? 1 : 0);
            const ownedExecution = execution !== null && execution.conversationId === input.conversationId && execution.runId === input.runId
                && execution.runEpoch === sourceRunEpoch && execution.rootBudgetId === input.rootBudgetId
                && execution.kind === run.value.kind;
            if (state.value.candidateId === null) return execution === null || ownedExecution;
            if (!ownedExecution) return false;
            const candidateRecord = await port.getRecord<ContextCandidateData>(contextCandidateKey(input.conversationId, state.value.candidateId));
            if (!candidateRecord || !['unknown', 'failed', 'cancelled', 'discarded', 'published'].includes(candidateRecord.value.state)) return false;
            const candidate = await this.transactions.readObject<CompactionCandidate>(input.conversationId,
                candidateRecord.value.contentId, candidateRecord.value.contentHash);
            if (candidate.state !== candidateRecord.value.state || candidate.state === 'unknown' && !candidate.pendingRequest
                || candidate.snapshot.runId !== input.runId || candidate.snapshot.runEpoch !== sourceRunEpoch
                || candidate.snapshot.execution.conversationId !== input.conversationId || candidate.snapshot.execution.runId !== input.runId
                || candidate.snapshot.execution.runEpoch !== sourceRunEpoch || candidate.snapshot.execution.kind !== run.value.kind
                || candidate.snapshot.execution.rootBudgetId !== input.rootBudgetId
                || candidate.snapshot.historyEpoch !== conversation.value.historyEpoch
                || candidate.snapshot.compressionGeneration !== state.value.compressionGeneration
                || candidate.pendingRequest && (candidate.pendingRequest.execution.runId !== input.runId
                    || candidate.pendingRequest.execution.runEpoch !== sourceRunEpoch
                    || candidate.pendingRequest.execution.rootBudgetId !== input.rootBudgetId)) return false;
            const next = nextContextRecord(contextStateKey(input.conversationId), state.record, { ...state.value,
                execution: null, candidateId: null, compressionGeneration: randomUUID(), checkpoint: null, checkpointContentId: null,
                lastUnknownWaitEnd: { runId: input.runId, runEpoch: input.runEpoch, candidateId: candidate.candidateId,
                    attemptId: candidate.pendingRequest?.attemptId ?? null, compressionGeneration: state.value.compressionGeneration,
                    historyEpoch: candidate.snapshot.historyEpoch, at: new Date(this.now()).toISOString() } });
            await this.transactions.commit({ expected: [{ key: conversation.key, revision: conversation.revision },
                { key: run.key, revision: run.revision }, { key: next.key, revision: state.record?.revision ?? null },
                { key: candidateRecord.key, revision: candidateRecord.revision }], records: [next] }, port);
            return true;
        }));
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
        const storedView = state.value.viewContentId ? await this.transactions.readObject<SummaryView>(conversationId, state.value.viewContentId)
            : { revision: viewRevision, historyEpoch, coveredEndSeq: 0, nodes: [] };
        const view = await this.communicationView(conversationId, state.value, storedView);
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
            let terminalOutcome: RoundBoundary['terminalOutcome'];
            const sourceRunId = items[0].runId;
            if (!models.length && roundId !== activeRoundId && nativePairing === 'complete' && sourceRunId
                && items.every(item => item.role === 'user' && item.runId === sourceRunId)) {
                const sourceRun = await this.store.getRecord(contextRunKey(conversationId, sourceRunId));
                const terminalState = sourceRun?.value.state;
                if (sourceRun?.value.conversationId === conversationId && sourceRun.value.runId === sourceRunId
                    && (sourceRun.value.activeRoundId === null || sourceRun.value.activeRoundId === roundId)
                    && ['succeeded', 'failed', 'cancelled'].includes(String(terminalState))
                    && ['not_needed', 'released'].includes(String(sourceRun.value.cleanupState))
                    && sourceRun.value.internalOwnCleanupState === 'released') {
                    terminalOutcome = { state: terminalState as 'succeeded' | 'failed' | 'cancelled',
                        stopReason: typeof sourceRun.value.stopReason === 'string' ? sourceRun.value.stopReason : null };
                }
            }
            stepSeq += items.filter(item => item.role === 'user' || item.role === 'assistant').length;
            rounds.push({ roundId, itemIds: items.map(item => item.itemId), firstSeq: items[0].seq, lastSeq: items.at(-1)!.seq,
                lastStepSeq: stepSeq, complete: roundId !== activeRoundId && (models.length > 0 || terminalOutcome !== undefined)
                    && nativePairing === 'complete', nativePairing, ...(terminalOutcome ? { terminalOutcome } : {}) });
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
            if (previous?.value.publicationRevoked) return;
            if (previous?.value.state === 'unknown' && previous.value.pendingAttemptId
                && candidate.pendingRequest?.attemptId === previous.value.pendingAttemptId
                && ['snapshotting', 'generating', 'ready'].includes(candidate.state)) return;
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

    async revokeCandidatePublication(candidate: CompactionCandidate): Promise<void> {
        const revocation = candidate.publicationRevoked;
        if (!revocation) throw new ContextFault('CONFIG_INVALID', '撤销候选需要明确的发布失效原因');
        await this.retry(() => this.transactions.mutateState(candidate.conversationId, async port => {
            const key = contextCandidateKey(candidate.conversationId, candidate.candidateId);
            const previous = await port.getRecord<ContextCandidateData>(key);
            if (!previous) throw new ContextFault('SOURCE_GAP', '待撤销候选缺少持久原件');
            if (previous.value.state === 'published') return;
            const stored = await this.transactions.readObject<CompactionCandidate>(candidate.conversationId,
                previous.value.contentId, previous.value.contentHash);
            if (stored.snapshot.sourceManifestHash !== candidate.snapshot.sourceManifestHash
                || stored.snapshot.runId !== candidate.snapshot.runId
                || stored.snapshot.compressionGeneration !== candidate.snapshot.compressionGeneration) {
                throw new ContextFault('SOURCE_GAP', '待撤销候选与原来源身份不同');
            }
            if (stored.publicationRevoked && stored.state === 'discarded') return;
            if (stored.pendingRequest && candidate.pendingRequest
                && stored.pendingRequest.attemptId !== candidate.pendingRequest.attemptId) {
                throw new ContextFault('ATTEMPT_UNKNOWN', '撤销候选须继续核查原压缩请求', undefined, true);
            }
            const resolution = revocation.resolution;
            const resolved = stored.pendingRequest && !candidate.pendingRequest && resolution?.attemptId === stored.pendingRequest.attemptId
                && (resolution.status === 'notAccepted' || resolution.status === 'found' && candidate.failedResult
                    && (candidate.failedResult.attemptId === resolution.attemptId || candidate.failedResult.requestAttemptId === resolution.attemptId)
                    && candidate.failedResult.inputBodyHash === stored.pendingRequest.inputBodyHash
                    && candidate.failedResult.modelFingerprint === stored.snapshot.effectiveModelFingerprint);
            const pendingRequest = candidate.pendingRequest ?? (resolved ? null : stored.pendingRequest);
            const revoked: CompactionCandidate = { ...candidate, pendingRequest,
                failedResult: candidate.failedResult ?? stored.failedResult,
                error: pendingRequest ? candidate.error ?? stored.error : candidate.error,
                publicationRevoked: { ...(stored.publicationRevoked ?? revocation), ...(resolved ? { resolution } : {}) },
                state: pendingRequest ? 'unknown' : 'discarded' };
            const contentId = randomUUID();
            const record = nextContextRecord(key, previous, { ...previous.value, state: revoked.state, contentId,
                contentHash: hashContext(revoked), pendingAttemptId: revoked.pendingRequest?.attemptId ?? null,
                publicationRevoked: revoked.publicationRevoked });
            const state = await this.transactions.readState(candidate.conversationId, port);
            const next = state.value.candidateId === candidate.candidateId
                ? nextContextRecord(contextStateKey(candidate.conversationId), state.record, { ...state.value, candidateId: null }) : null;
            await this.transactions.commit({ expected: [{ key, revision: previous.revision },
                ...(next ? [{ key: next.key, revision: state.record?.revision ?? null }] : [])],
                records: [record, ...(next ? [next] : [])],
                contents: [contextContent(candidate.conversationId, contentId, 'context_candidate', revoked)] }, port);
        }));
    }

    private summaryReadCurrent(input: ContextSummaryReadInput): Promise<StoreRecord> {
        if (input.signal?.aborted) throw new AgentFault('TOOL_CANCELLED', '摘要归档查回已取消');
        return this.conversation(input.conversationId).then(conversation => {
            if (input.signal?.aborted) throw new AgentFault('TOOL_CANCELLED', '摘要归档查回已取消');
            if (conversation.value.historyEpoch !== input.historyEpoch) throw new ContextFault('HISTORY_STALE', '摘要归档的历史代次已变化');
            return conversation;
        });
    }

    async readSummary(input: ContextSummaryReadInput): Promise<SummaryNode | null> {
        if (typeof input.conversationId !== 'string' || !input.conversationId || !Number.isSafeInteger(input.historyEpoch) || input.historyEpoch < 0
            || typeof input.nodeId !== 'string' || !input.nodeId || input.nodeId.length > 4096
            || input.hash !== undefined && (typeof input.hash !== 'string' || !/^[a-f0-9]{64}$/.test(input.hash))) throw new AgentFault('INVALID_PARAMS', '摘要归档查回须提供有效会话、历史代次、节点和可选哈希');
        const conversation = await this.summaryReadCurrent(input);
        const key = contextSummaryKey(input.conversationId, input.historyEpoch, input.nodeId, input.hash);
        const record = await this.store.getRecord<ContextSummaryArchiveData>(key);
        await this.summaryReadCurrent(input);
        if (!record) return null;
        const index = record.value;
        if (hashContext(record.key) !== hashContext(key) || !index || typeof index !== 'object' || index.kind !== 'context_summary_archive' || index.schemaVersion !== 1
            || index.conversationId !== input.conversationId || index.historyEpoch !== input.historyEpoch || index.nodeId !== input.nodeId
            || !/^[a-f0-9]{64}$/.test(index.nodeHash) || input.hash !== undefined && input.hash !== index.nodeHash
            || !/^[a-f0-9]{64}$/.test(index.contentHash) || typeof index.contentId !== 'string' || !index.contentId
            || !Number.isSafeInteger(index.byteLength) || index.byteLength < 1 || index.byteLength > MAX_CONTEXT_SUMMARY_NODE_BYTES
            || !Number.isSafeInteger(index.firstSeq) || !Number.isSafeInteger(index.lastSeq) || index.firstSeq < 1
            || index.lastSeq < index.firstSeq || index.lastSeq > Number(conversation.value.appendSeq)) {
            throw new ContextFault('SOURCE_GAP', '摘要归档索引的会话、版本、范围或大小无效');
        }
        if (input.hash === undefined) {
            const version = await this.store.getRecord<ContextSummaryArchiveData>(contextSummaryKey(input.conversationId, input.historyEpoch, input.nodeId, index.nodeHash));
            if (input.signal?.aborted) throw new AgentFault('TOOL_CANCELLED', '摘要归档查回已取消');
            if (!version || hashContext(version.value) !== hashContext(index)) throw new ContextFault('SOURCE_GAP', '摘要归档最新指针与不可变版本不同');
        }
        const bytes = Buffer.allocUnsafe(index.byteLength);
        let offset = 0;
        while (offset < bytes.length) {
            if (input.signal?.aborted) throw new AgentFault('TOOL_CANCELLED', '摘要归档查回已取消');
            const size = Math.min(this.maxReadBytes, bytes.length - offset);
            const chunk = await this.store.readArtifact({ conversationId: input.conversationId, artifactId: index.contentId, offset, maxBytes: size });
            if (input.signal?.aborted) throw new AgentFault('TOOL_CANCELLED', '摘要归档查回已取消');
            if (chunk.artifactId !== index.contentId || chunk.totalBytes !== bytes.length || chunk.sha256 !== index.contentHash
                || chunk.offset !== offset || typeof chunk.dataBase64 !== 'string' || chunk.dataBase64.length > Math.ceil(size / 3) * 4) {
                throw new ContextFault('SOURCE_GAP', '摘要归档正文分片与固定对象不同');
            }
            const fragment = Buffer.from(chunk.dataBase64, 'base64');
            if (fragment.length !== size || chunk.complete !== (offset + size === bytes.length)
                || chunk.nextOffset !== (offset + size === bytes.length ? null : offset + size)) {
                throw new ContextFault('SOURCE_GAP', '摘要归档正文分片未连续覆盖');
            }
            fragment.copy(bytes, offset);
            offset += fragment.length;
        }
        if (hashBytes(bytes) !== index.contentHash) throw new ContextFault('SOURCE_GAP', '摘要归档正文哈希不一致');
        let node: SummaryNode;
        try {
            node = JSON.parse(bytes.toString('utf8')) as SummaryNode;
            validateSummaryNodes([node]);
            if (!['batch', 'fold'].includes(node.kind) || node.nodeId !== input.nodeId || node.hash !== index.nodeHash || node.firstSeq !== index.firstSeq || node.lastSeq !== index.lastSeq
                || !Array.isArray(node.roundIds) || !node.roundIds.length || node.roundIds.some(roundId => typeof roundId !== 'string' || !roundId)
                || hashContext(node) !== index.contentHash) throw new Error('summary archive source mismatch');
        } catch { throw new ContextFault('SOURCE_GAP', '摘要归档节点的原哈希或来源范围无效'); }
        const current = await this.summaryReadCurrent(input);
        if (node.lastSeq > Number(current.value.appendSeq)) throw new ContextFault('HISTORY_STALE', '摘要归档来源已超出当前有效历史范围');
        return node;
    }

    private async archiveSummaryNodes(conversationId: string, historyEpoch: number, nodes: SummaryNode[]): Promise<Required<Pick<StoreTransition, 'expected' | 'records' | 'contents'>>> {
        if (nodes.length > MAX_CONTEXT_SUMMARY_ARCHIVE_NODES) throw new ContextFault('INPUT_BUDGET', '单次发布摘要归档节点超过有界上限');
        const versions = new Map<string, { node: SummaryNode; index: ContextSummaryArchiveData }>();
        const latest = new Map<string, string>();
        let totalBytes = 0;
        for (const node of nodes) {
            if (!['batch', 'fold'].includes(node.kind) || !Number.isSafeInteger(node.firstSeq) || !Number.isSafeInteger(node.lastSeq)
                || node.firstSeq < 1 || node.lastSeq < node.firstSeq || !Array.isArray(node.roundIds) || !node.roundIds.length
                || node.roundIds.some(roundId => typeof roundId !== 'string' || !roundId)) throw new ContextFault('SOURCE_GAP', '待归档摘要的节点类型或来源范围无效');
            const identity = hashContext([node.nodeId, node.hash]);
            latest.set(node.nodeId, identity);
            if (versions.has(identity)) continue;
            let byteLength: number;
            try {
                byteLength = measureCanonicalJsonBytes(node, { maxBytes: Math.min(MAX_CONTEXT_SUMMARY_NODE_BYTES,
                    MAX_CONTEXT_SUMMARY_ARCHIVE_BYTES - totalBytes) });
            } catch (error) {
                if (!(error instanceof AgentFault) || error.code !== 'TEMPORARY_CONTENT_LIMIT') throw error;
                throw new ContextFault('INPUT_BUDGET', '摘要归档在分配正文缓冲前达到字节或结构上限',
                    { nodeId: node.nodeId, totalBytes, maxNodeBytes: MAX_CONTEXT_SUMMARY_NODE_BYTES,
                        maxArchiveBytes: MAX_CONTEXT_SUMMARY_ARCHIVE_BYTES });
            }
            validateSummaryNodes([node]);
            const bytes = Buffer.from(canonicalJson(node));
            if (bytes.length !== byteLength) throw new ContextFault('SOURCE_GAP', '摘要归档的正文编码与预先计量不同');
            totalBytes += byteLength;
            versions.set(identity, { node, index: { kind: 'context_summary_archive', schemaVersion: 1,
                conversationId, historyEpoch, nodeId: node.nodeId, nodeHash: node.hash, contentId: randomUUID(),
                contentHash: hashBytes(bytes), byteLength: bytes.length, firstSeq: node.firstSeq, lastSeq: node.lastSeq } });
        }
        const transition: Required<Pick<StoreTransition, 'expected' | 'records' | 'contents'>> = { expected: [], records: [], contents: [] };
        for (const entry of versions.values()) {
            const key = contextSummaryKey(conversationId, historyEpoch, entry.node.nodeId, entry.node.hash);
            const previous = await this.store.getRecord<ContextSummaryArchiveData>(key);
            if (previous) {
                const { contentId: _previousId, ...stored } = previous.value;
                const { contentId: _newId, ...expected } = entry.index;
                if (hashContext(stored) !== hashContext(expected)) throw new ContextFault('SOURCE_GAP', '已有摘要归档版本与发布节点不同');
                entry.index = previous.value;
            } else {
                transition.expected.push({ key, revision: null });
                transition.records.push(nextContextRecord(key, undefined, entry.index));
                transition.contents.push({ conversationId, contentId: entry.index.contentId, kind: 'context_summary_node',
                    indexHistory: false, value: entry.node as unknown as JsonValue });
            }
        }
        for (const [nodeId, identity] of latest) {
            const index = versions.get(identity)!.index;
            const key = contextSummaryKey(conversationId, historyEpoch, nodeId);
            const previous = await this.store.getRecord<ContextSummaryArchiveData>(key);
            if (previous && hashContext(previous.value) === hashContext(index)) continue;
            transition.expected.push({ key, revision: previous?.revision ?? null });
            transition.records.push(nextContextRecord(key, previous, index));
        }
        if (transition.records.length + transition.contents.length + 6 > MAX_WRITE_BATCH) {
            throw new ContextFault('INPUT_BUDGET', '摘要归档与发布合并后超过单次存储事务上限，保持原视图',
                { archiveRecords: transition.records.length, archiveContents: transition.contents.length, maxWriteBatch: MAX_WRITE_BATCH });
        }
        return transition;
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
            const feedback = await this.readHistoryFeedback({ conversationId: candidate.conversationId,
                historyEpoch: capture.historyEpoch, nodes: candidate.nextView.nodes });
            const nextView = sealPublishedSummaryView(applyPublishedHistoryFeedback(candidate.nextView, feedback, capture.stepSeq),
                candidate.snapshot.config.policy);
            const publishedNodes = new Map(nextView.nodes.map(node => [node.nodeId, node]));
            const published = { ...candidate, nextView, batch: publishedNodes.get(candidate.batch.nodeId) ?? candidate.batch,
                folds: candidate.folds.map(node => publishedNodes.get(node.nodeId) ?? node),
                state: 'published' as const, publishedViewRevision: nextView.revision };
            const archive = await this.archiveSummaryNodes(candidate.conversationId, capture.historyEpoch,
                [...capture.view.nodes, candidate.batch, ...candidate.folds, ...candidate.nextView.nodes,
                    published.batch, ...published.folds, ...nextView.nodes]);
            const candidateContentId = randomUUID();
            const viewContentId = randomUUID();
            const candidateRecord = nextContextRecord(previous!.key, previous, { ...previous!.value, state: 'published', contentId: candidateContentId,
                contentHash: hashContext(published), publishedViewRevision: candidate.nextView.revision });
            const stateRecord = nextContextRecord(contextStateKey(candidate.conversationId), state.record, { ...state.value, viewContentId, communicationBootstrap: null,
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
                { key: run!.key, revision: run!.revision },
                { key: contextFeedbackStateKey(candidate.conversationId, capture.historyEpoch), revision: feedback.revision || null },
                ...archive.expected], records: [conversationRecord, stateRecord, candidateRecord, ...archive.records],
                contents: [contextContent(candidate.conversationId, candidateContentId, 'context_candidate', published),
                    contextContent(candidate.conversationId, viewContentId, 'context_view', nextView), ...archive.contents], receipt, events: [event] });
            if (!result.replayed) return publication;
            const replay = result.receipt?.result.ok ? result.receipt.result.data as unknown as Publication : await this.getPublication(input.receiptKey);
            if (!replay) throw new ContextFault('COMMIT_UNKNOWN', '发布已重放但原回执尚不可取', undefined, true);
            return { ...replay, replayed: true };
        });
    }

    async readHistoryFeedback(input: Parameters<NonNullable<CompactionPort['readHistoryFeedback']>>[0]) {
        return readHistoryFeedbackSnapshot(this.store, input);
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
