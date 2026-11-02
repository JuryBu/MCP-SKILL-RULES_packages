import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { ConversationData } from '../runtime.js';
import type { HistoryItem, StorePort, StoreRecord } from '../storage/port.js';
import { MAX_PAGE_BYTES } from '../storage/internal.js';
import type { BranchHistoryItem, BranchHistoryManifest } from './contracts.js';
import { captureBranchToolOutcomeProvenance } from './branch-tool-outcomes.js';

export function lifecycleSignal(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AgentFault('E_CANCELLED', '对话生命周期操作已取消，尚未提交的源会话保持原状态');
}

export async function verifyHistoryOriginal(store: StorePort, conversationId: string, item: HistoryItem, signal?: AbortSignal): Promise<void> {
    let offset = 0;
    const checksum = createHash('sha256');
    do {
        lifecycleSignal(signal);
        const chunk = await store.readArtifact({ conversationId, artifactId: item.contentId, offset, maxBytes: MAX_PAGE_BYTES });
        const bytes = Buffer.from(chunk.dataBase64, 'base64');
        const nextOffset = offset + bytes.length;
        if (chunk.artifactId !== item.contentId || chunk.offset !== offset || chunk.sha256 !== item.objectRef.hash
            || chunk.totalBytes !== item.objectRef.rawBytes || nextOffset > chunk.totalBytes
            || chunk.complete !== (nextOffset === chunk.totalBytes)
            || chunk.nextOffset !== (chunk.complete ? null : nextOffset) || !chunk.complete && bytes.length === 0) {
            throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '所选历史的原文分片、长度或来源哈希不完整', { contentId: item.contentId, sourceSeq: item.seq });
        }
        checksum.update(bytes);
        offset = nextOffset;
        if (chunk.complete) break;
    } while (offset < item.objectRef.rawBytes);
    if (offset !== item.objectRef.rawBytes || checksum.digest('hex') !== item.objectRef.hash) {
        throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '所选历史原文的完整SHA256不同', { contentId: item.contentId, sourceSeq: item.seq });
    }
}

function historyItem(item: HistoryItem, localSeq: number): BranchHistoryItem {
    return { itemId: item.itemId, sourceSeq: item.seq, localSeq, contentId: item.contentId, kind: item.kind,
        objectHash: item.objectRef.hash, rawBytes: item.objectRef.rawBytes, roundId: item.roundId,
        role: item.role, view: item.view, effective: item.effective, stepId: item.stepId,
        runId: item.runId, runEpoch: item.runEpoch, ...(item.actionId !== undefined ? { actionId: item.actionId } : {}),
        ...(item.attemptId !== undefined ? { attemptId: item.attemptId } : {}), ...(item.callId !== undefined ? { callId: item.callId } : {}),
        ...(item.providerProtocol !== undefined ? { providerProtocol: item.providerProtocol } : {}) };
}

export async function captureBranchHistory(store: StorePort, source: StoreRecord<ConversationData>, selectedRound: string, signal?: AbortSignal): Promise<BranchHistoryManifest> {
    const items: BranchHistoryItem[] = [];
    const rounds = new Map<string, number>();
    let cursor: string | undefined;
    let previousSeq = 0;
    let selectedRoundId: string | undefined;
    let selectedRoundNumber = 0;
    let complete = false;
    do {
        lifecycleSignal(signal);
        const page = await store.readHistory({ conversationId: source.value.conversationId, cursor, direction: 'forward',
            view: 'raw', effectiveOnly: true, expectedHistoryEpoch: source.value.historyEpoch,
            throughSeq: source.value.appendSeq, limit: 50, maxBytes: MAX_PAGE_BYTES });
        if (page.historyEpoch !== source.value.historyEpoch || page.appendSeq !== source.value.appendSeq
            || page.viewRevision !== source.value.viewRevision) throw new AgentFault('E_HISTORY_CONFLICT', '分支冻结期间源历史版本发生变化');
        for (const item of page.items) {
            if (!Number.isSafeInteger(item.seq) || item.seq <= previousSeq || item.seq > source.value.appendSeq) {
                throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '所选历史顺序不完整');
            }
            previousSeq = item.seq;
            if (item.roundId && !rounds.has(item.roundId)) rounds.set(item.roundId, rounds.size + 1);
            const roundNumber = item.roundId ? rounds.get(item.roundId)! : 0;
            if (!selectedRoundId && item.roundId && (selectedRound === item.roundId || selectedRound === String(roundNumber))) {
                selectedRoundId = item.roundId;
                selectedRoundNumber = roundNumber;
            }
            if (selectedRoundId && item.roundId && roundNumber > selectedRoundNumber) { complete = true; break; }
            await verifyHistoryOriginal(store, source.value.conversationId, item, signal);
            items.push(historyItem(item, items.length + 1));
        }
        if (complete || !page.hasMore) break;
        if (!page.nextCursor || page.nextCursor === cursor || page.items.length === 0) throw new AgentFault('STORAGE_CURSOR_STALE', '历史分页没有推进，源会话保持不变');
        cursor = page.nextCursor;
    } while (true);
    if (!selectedRoundId) throw new AgentFault('NOT_FOUND', '当前历史版本找不到指定分支轮次', { roundId: selectedRound, historyEpoch: source.value.historyEpoch });
    const selectedItems = items.filter(item => !item.roundId || rounds.get(item.roundId)! <= selectedRoundNumber);
    const toolOutcomeProvenance = await captureBranchToolOutcomeProvenance(store, source.value.conversationId, selectedItems, signal);
    const base = { schemaVersion: 1 as const, sourceConversationId: source.value.conversationId,
        sourceHistoryEpoch: source.value.historyEpoch, sourceViewRevision: source.value.viewRevision,
        sourceAppendSeq: source.value.appendSeq, throughSeq: selectedItems.at(-1)?.sourceSeq ?? 0,
        selectedRoundId, selectedRoundNumber, firstSeq: selectedItems[0]?.sourceSeq ?? 0,
        lastSeq: selectedItems.at(-1)?.sourceSeq ?? 0, items: selectedItems,
        roundMap: [...rounds].filter(([, number]) => number <= selectedRoundNumber)
            .map(([roundId, number]) => ({ roundId, sourceRound: number, localRound: number })),
        workspaceFiles: 'unchanged' as const, contextPolicy: 'rebuild_from_selected_raw' as const,
        ...(toolOutcomeProvenance ? { toolOutcomeProvenance } : {}) };
    return { ...base, sourceHash: createHash('sha256').update(canonicalJson(base)).digest('hex') };
}
