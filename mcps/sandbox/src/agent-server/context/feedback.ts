import type { StorePort, StoreRecord } from '../storage/port.js';
import { ContextTransactions, contextConversationKey, contextFeedbackHitKey, contextFeedbackStateKey,
    contextFeedbackTargetKey, nextContextRecord } from '../storage/context-transactions.js';
import type { ContextTransactionPort } from '../storage/context-transactions.js';
import type { HistoryFeedbackEntry, HistoryFeedbackSnapshot, HistoryFeedbackTarget,
    SummaryNode, SummaryView } from './contracts.js';
import { hashContext } from './config.js';
import { checkAbort, ContextFault } from './errors.js';
import { sealSummaryNode, validateSummaryNodes } from './view.js';

export type HistoryFeedbackStore = ContextTransactionPort & Pick<StorePort, 'readHistory'>;

export interface HistoryHitInput {
    conversationId: string;
    historyEpoch: number;
    currentStep: number;
    hitId: string;
    nodeId?: string;
    roundId?: string;
    signal?: AbortSignal;
}

export interface HistoryHitReceipt extends HistoryFeedbackEntry {
    conversationId: string;
    historyEpoch: number;
    hitId: string;
    replayed: boolean;
}

interface FeedbackHeader extends Record<string, unknown> {
    kind: 'context_history_feedback';
    schemaVersion: 1;
    historyEpoch: number;
    totalUsefulHits: number;
    lastHitStep: number;
}

interface FeedbackTargetRecord extends Record<string, unknown>, HistoryFeedbackEntry {
    kind: 'context_history_feedback_target';
    schemaVersion: 1;
    historyEpoch: number;
}

interface FeedbackHitRecord extends Record<string, unknown> {
    kind: 'context_history_feedback_hit';
    schemaVersion: 1;
    operationHash: string;
    receipt: HistoryHitReceipt;
}

function integer(value: number, label: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || value < minimum) throw new ContextFault('CONFIG_INVALID', `${label}须为有效安全整数`);
    return value;
}

function identifier(value: string, label: string): string {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 4096) {
        throw new ContextFault('CONFIG_INVALID', `${label}须为明确标识符`);
    }
    return value;
}

function targetFor(input: { nodeId?: string; roundId?: string }): HistoryFeedbackTarget {
    if ((input.nodeId !== undefined) === (input.roundId !== undefined)) throw new ContextFault('CONFIG_INVALID', '命中目标须且只能指定nodeId或roundId');
    return input.nodeId !== undefined ? { kind: 'node', id: identifier(input.nodeId, 'nodeId') }
        : { kind: 'round', id: identifier(input.roundId!, 'roundId') };
}

export function feedbackSourceNodeIds(node: SummaryNode): string[] {
    return [...new Set([node.nodeId, ...(node.feedbackSourceNodeIds ?? []),
        ...(node.kind === 'fold' ? node.children.map(child => child.nodeId) : [])])];
}

function containsTarget(node: SummaryNode, target: HistoryFeedbackTarget): boolean {
    return target.kind === 'node' ? feedbackSourceNodeIds(node).includes(target.id) : node.roundIds.includes(target.id);
}

async function readHeader(store: Pick<StorePort, 'getRecord'>, conversationId: string, historyEpoch: number): Promise<StoreRecord<FeedbackHeader> | undefined> {
    const record = await store.getRecord<FeedbackHeader>(contextFeedbackStateKey(conversationId, historyEpoch));
    if (record && (record.value.kind !== 'context_history_feedback' || record.value.schemaVersion !== 1
        || record.value.historyEpoch !== historyEpoch || !Number.isSafeInteger(record.value.totalUsefulHits) || record.value.totalUsefulHits < 1)) {
        throw new ContextFault('SOURCE_GAP', '历史命中反馈状态损坏');
    }
    return record;
}

async function readTarget(store: Pick<StorePort, 'getRecord'>, conversationId: string, historyEpoch: number,
    target: HistoryFeedbackTarget): Promise<StoreRecord<FeedbackTargetRecord> | undefined> {
    const record = await store.getRecord<FeedbackTargetRecord>(contextFeedbackTargetKey(conversationId, historyEpoch, target));
    if (record && (record.value.kind !== 'context_history_feedback_target' || record.value.schemaVersion !== 1
        || record.value.historyEpoch !== historyEpoch || hashContext(record.value.target) !== hashContext(target)
        || !Number.isSafeInteger(record.value.hitCount) || record.value.hitCount < 1
        || !Number.isSafeInteger(record.value.lastHitStep) || record.value.lastHitStep < 0
        || !Number.isSafeInteger(record.value.feedbackRevision) || record.value.feedbackRevision < 1)) {
        throw new ContextFault('SOURCE_GAP', '历史命中目标状态损坏');
    }
    return record;
}

async function readView(transactions: ContextTransactions, conversation: StoreRecord): Promise<SummaryView> {
    const state = await transactions.readState(String(conversation.key.conversationId));
    const view = state.value.viewContentId ? await transactions.readObject<SummaryView>(String(conversation.key.conversationId), state.value.viewContentId)
        : { revision: Number(conversation.value.viewRevision), historyEpoch: Number(conversation.value.historyEpoch), coveredEndSeq: 0, nodes: [] };
    if (view.historyEpoch !== Number(conversation.value.historyEpoch) || view.revision !== Number(conversation.value.viewRevision)) {
        throw new ContextFault('PARENT_STALE', '历史命中目标的摘要视图已经变化');
    }
    validateSummaryNodes(view.nodes);
    return view;
}

async function requireTarget(store: Pick<StorePort, 'readHistory'>, conversation: StoreRecord, view: SummaryView,
    target: HistoryFeedbackTarget, signal?: AbortSignal): Promise<void> {
    if (view.nodes.some(node => containsTarget(node, target))) return;
    if (target.kind === 'node') throw new ContextFault('HISTORY_TARGET_NOT_FOUND', '当前对话的已发布摘要中没有该节点');
    let cursor: string | undefined;
    for (;;) {
        checkAbort(signal);
        const page = await store.readHistory({ conversationId: String(conversation.key.conversationId), cursor, direction: 'backward',
            view: 'raw', effectiveOnly: true, includeValues: false, limit: 100, maxBytes: 65536,
            expectedHistoryEpoch: view.historyEpoch, throughSeq: Number(conversation.value.appendSeq) });
        if (page.historyEpoch !== view.historyEpoch) throw new ContextFault('HISTORY_STALE', '定位命中轮时历史代次已改变');
        if (page.items.some(item => item.roundId === target.id)) return;
        if (!page.hasMore) break;
        if (!page.nextCursor || page.nextCursor === cursor || !page.items.length) throw new ContextFault('SOURCE_GAP', '历史命中定位分页没有推进');
        cursor = page.nextCursor;
    }
    throw new ContextFault('HISTORY_TARGET_NOT_FOUND', '当前对话的有效原文中没有该轮');
}

export async function recordHistoryHit(store: HistoryFeedbackStore, input: HistoryHitInput): Promise<HistoryHitReceipt> {
    identifier(input.conversationId, 'conversationId');
    identifier(input.hitId, 'hitId');
    integer(input.historyEpoch, 'historyEpoch');
    integer(input.currentStep, 'currentStep');
    const target = targetFor(input);
    const transactions = new ContextTransactions(store);
    const hitKey = contextFeedbackHitKey(input.conversationId, input.historyEpoch, input.hitId);
    const operationHash = hashContext({ conversationId: input.conversationId, historyEpoch: input.historyEpoch, hitId: input.hitId, target });
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            return await transactions.mutateState(input.conversationId, async port => {
                checkAbort(input.signal);
                const conversation = await port.getRecord(contextConversationKey(input.conversationId));
                if (!conversation || Number(conversation.value.historyEpoch) !== input.historyEpoch) throw new ContextFault('HISTORY_STALE', '命中标记的会话或历史代次已变化');
                if (conversation.value.state === 'closed' || conversation.value.state === 'closing') throw new ContextFault('HISTORY_STALE', '会话正在关闭或已经关闭');
                const replay = await port.getRecord<FeedbackHitRecord>(hitKey);
                if (replay) {
                    if (replay.value.kind !== 'context_history_feedback_hit' || replay.value.operationHash !== operationHash) {
                        throw new ContextFault('HISTORY_HIT_CONFLICT', '同一命中动作ID已经用于不同参数');
                    }
                    return { ...replay.value.receipt, replayed: true };
                }
                const view = await readView(transactions, conversation);
                await requireTarget(store, conversation, view, target, input.signal);
                const header = await readHeader(port, input.conversationId, input.historyEpoch);
                const previous = await readTarget(port, input.conversationId, input.historyEpoch, target);
                const feedbackRevision = (header?.revision ?? 0) + 1;
                const receipt: HistoryHitReceipt = { conversationId: input.conversationId, historyEpoch: input.historyEpoch, hitId: input.hitId,
                    target, hitCount: integer((previous?.value.hitCount ?? 0) + 1, 'hitCount', 1),
                    lastHitStep: Math.max(previous?.value.lastHitStep ?? 0, input.currentStep), feedbackRevision, replayed: false };
                const nextHeader = nextContextRecord(contextFeedbackStateKey(input.conversationId, input.historyEpoch), header,
                    { kind: 'context_history_feedback' as const, schemaVersion: 1 as const, historyEpoch: input.historyEpoch,
                        totalUsefulHits: integer((header?.value.totalUsefulHits ?? 0) + 1, 'totalUsefulHits', 1),
                        lastHitStep: Math.max(header?.value.lastHitStep ?? 0, input.currentStep) });
                const nextTarget = nextContextRecord(contextFeedbackTargetKey(input.conversationId, input.historyEpoch, target), previous,
                    { kind: 'context_history_feedback_target' as const, schemaVersion: 1 as const, historyEpoch: input.historyEpoch,
                        target, hitCount: receipt.hitCount, lastHitStep: receipt.lastHitStep, feedbackRevision });
                const nextHit = nextContextRecord<FeedbackHitRecord>(hitKey, undefined,
                    { kind: 'context_history_feedback_hit', schemaVersion: 1, operationHash, receipt });
                checkAbort(input.signal);
                await transactions.commit({ expected: [{ key: conversation.key, revision: conversation.revision },
                    { key: nextHeader.key, revision: header?.revision ?? null }, { key: nextTarget.key, revision: previous?.revision ?? null },
                    { key: hitKey, revision: null }], records: [nextHeader, nextTarget, nextHit] }, port);
                return receipt;
            });
        } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'REVISION_CONFLICT') || attempt === 3) throw error;
        }
    }
    throw new ContextFault('PARENT_STALE', '历史命中反馈未能提交');
}

export async function readHistoryFeedbackState(store: HistoryFeedbackStore, input: {
    conversationId: string; historyEpoch: number; nodeId?: string; roundId?: string;
}): Promise<{ conversationId: string; historyEpoch: number; feedbackRevision: number; appliedFeedbackRevision: number;
    pending: boolean; target: HistoryFeedbackEntry | null }> {
    identifier(input.conversationId, 'conversationId');
    integer(input.historyEpoch, 'historyEpoch');
    const conversation = await store.getRecord(contextConversationKey(input.conversationId));
    if (!conversation || Number(conversation.value.historyEpoch) !== input.historyEpoch) throw new ContextFault('HISTORY_STALE', '读取命中状态时会话或历史代次已变化');
    const view = await readView(new ContextTransactions(store), conversation);
    const header = await readHeader(store, input.conversationId, input.historyEpoch);
    const target = input.nodeId !== undefined || input.roundId !== undefined ? targetFor(input) : null;
    const record = target ? await readTarget(store, input.conversationId, input.historyEpoch, target) : undefined;
    const entry = record ? { target: record.value.target, hitCount: record.value.hitCount,
        lastHitStep: record.value.lastHitStep, feedbackRevision: record.value.feedbackRevision } : null;
    const appliedFeedbackRevision = view.historyFeedbackRevision ?? 0;
    return { conversationId: input.conversationId, historyEpoch: input.historyEpoch, feedbackRevision: header?.revision ?? 0,
        appliedFeedbackRevision, pending: entry ? entry.feedbackRevision > appliedFeedbackRevision
            || !view.nodes.some(node => containsTarget(node, entry.target)) : (header?.revision ?? 0) > appliedFeedbackRevision, target: entry };
}

export async function readHistoryFeedbackSnapshot(store: Pick<StorePort, 'getRecord'>, input: {
    conversationId: string; historyEpoch: number; nodes: SummaryNode[]; roundIds?: string[];
}): Promise<HistoryFeedbackSnapshot> {
    const header = await readHeader(store, input.conversationId, input.historyEpoch);
    const result: HistoryFeedbackSnapshot = { historyEpoch: input.historyEpoch, revision: header?.revision ?? 0, entries: [] };
    if (!header) return result;
    const targets = new Map<string, HistoryFeedbackTarget>();
    for (const node of input.nodes) {
        for (const nodeId of feedbackSourceNodeIds(node)) targets.set(`node:${nodeId}`, { kind: 'node', id: nodeId });
        for (const roundId of node.roundIds) targets.set(`round:${roundId}`, { kind: 'round', id: roundId });
    }
    for (const roundId of input.roundIds ?? []) targets.set(`round:${roundId}`, { kind: 'round', id: roundId });
    for (const target of targets.values()) {
        const record = await readTarget(store, input.conversationId, input.historyEpoch, target);
        if (record) result.entries.push({ target: record.value.target, hitCount: record.value.hitCount,
            lastHitStep: record.value.lastHitStep, feedbackRevision: record.value.feedbackRevision });
    }
    return result;
}

export function applyPublishedHistoryFeedback(view: SummaryView, snapshot: HistoryFeedbackSnapshot, currentStep: number): SummaryView {
    integer(currentStep, 'currentStep');
    if (snapshot.historyEpoch !== view.historyEpoch) throw new ContextFault('HISTORY_STALE', '命中反馈与待发布视图历史代次不同');
    if (!snapshot.revision) return view;
    const nodes = view.nodes.map(node => {
        const entries = snapshot.entries.filter(entry => containsTarget(node, entry.target));
        if (!entries.length) return node;
        const hitCount = integer(entries.reduce((total, entry) => total + entry.hitCount, 0), 'hitCount', 1);
        const lastHitStep = Math.max(...entries.map(entry => entry.lastHitStep));
        const age = Math.max(0, currentStep - lastHitStep);
        const level = hitCount / (1 + age / 64) >= 1.5 ? 'body' as const : 'skeleton' as const;
        const { hash: _previousHash, ...content } = node;
        return sealSummaryNode({ ...content, historyFeedback: { hitCount, lastHitStep, publishedAtStep: currentStep, level } });
    });
    return { ...view, nodes, historyFeedbackRevision: snapshot.revision };
}
