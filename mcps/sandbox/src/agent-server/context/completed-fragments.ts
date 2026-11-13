import type { HistoryItem, ModelStepPairing } from '../storage/port.js';
import type { CompactionPort, ContextCapture, ContextPolicy } from './contracts.js';
import { canonicalJson } from '../protocol.js';
import { checkAbort, ContextFault } from './errors.js';
import { readSelectedHistory } from './rounds.js';

function objectValue(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function fallbackPairing(port: CompactionPort, capture: ContextCapture, items: HistoryItem[], maximumBytes: number): Promise<ModelStepPairing> {
    const model = items[0];
    if (items.some(item => item.objectRef.rawBytes > maximumBytes)) return 'incomplete';
    const value = objectValue(model.value ?? await port.readContent(capture.conversationId, model.contentId));
    const response = objectValue(value?.response);
    if (value?.kind !== 'model' || response?.complete !== true || !Array.isArray(response.toolCalls)) return 'incomplete';
    const calls = response.toolCalls.map(objectValue);
    if (calls.some(call => !call || typeof call.callId !== 'string' || typeof call.name !== 'string')) return 'conflict';
    const expected = new Map(calls.map(call => [call!.callId, call!.name]));
    if (expected.size !== calls.length) return 'conflict';
    const resolved = new Set<string>();
    for (const item of items.slice(1)) {
        if (item.role !== 'tool' || item.stepId !== model.stepId) return 'conflict';
        const content = objectValue(item.value ?? await port.readContent(capture.conversationId, item.contentId));
        const result = objectValue(content?.result);
        const callId = item.callId ?? result?.callId;
        if (typeof callId !== 'string' || resolved.has(callId) || expected.get(callId) !== result?.name) return 'conflict';
        resolved.add(callId);
    }
    return resolved.size === expected.size ? 'complete' : 'pending';
}

export async function captureCompletedFragments(port: CompactionPort, capture: ContextCapture, policy: ContextPolicy,
    signal?: AbortSignal): Promise<ContextCapture> {
    capture = { ...capture };
    delete capture.activeCompletedPrefix;
    const crossing = capture.rounds.filter(round => round.firstSeq <= capture.view.coveredEndSeq && round.lastSeq > capture.view.coveredEndSeq);
    const active = capture.rounds.find(round => round.roundId === capture.activeRoundId);
    const keep = Math.max(1, policy.keepCompleteSteps ?? 2);
    if (!crossing.length && (!active || active.itemIds.length <= keep + 1)) return capture;
    const needed = [...new Map([...crossing, ...(active ? [active] : [])].map(round => [round.roundId, round])).values()];
    if (!needed.length) return capture;
    const items = await readSelectedHistory(port, capture, needed, policy.readFrameBytes, signal, false);
    const uncovered = items.filter(item => item.seq > capture.view.coveredEndSeq);
    const rounds = capture.rounds.map(round => {
        if (!crossing.some(entry => entry.roundId === round.roundId)) return round;
        const tail = uncovered.filter(item => item.roundId === round.roundId);
        if (!tail.length) throw new ContextFault('SOURCE_GAP', '跨压缩边界的轮索引缺少未覆盖尾部',
            { roundId: round.roundId, coveredEndSeq: capture.view.coveredEndSeq });
        const published = capture.view.nodes.find(node => node.lastSeq === capture.view.coveredEndSeq && node.roundIds.includes(round.roundId));
        const boundary = items.filter(item => item.roundId === round.roundId && item.seq <= capture.view.coveredEndSeq).at(-1);
        if (!published || !boundary || boundary.seq !== capture.view.coveredEndSeq || boundary.role === 'user'
            || tail[0].role === 'tool' || boundary.stepId === tail[0].stepId) {
            throw new ContextFault('SOURCE_GAP', '压缩游标缺少已发布片段或切断了原生步骤组',
                { roundId: round.roundId, coveredEndSeq: capture.view.coveredEndSeq });
        }
        return { ...round, firstSeq: tail[0].seq, itemIds: tail.map(item => item.itemId) };
    });
    const result: ContextCapture = { ...capture, rounds };
    if (!active || active.nativePairing === 'conflict') return result;
    const activeItems = uncovered.filter(item => item.roundId === active.roundId);
    const groups: HistoryItem[][] = [];
    let pendingUsers: HistoryItem[] = [];
    for (const item of activeItems) {
        if (item.role === 'user') { pendingUsers.push(item); continue; }
        if (item.role === 'assistant') {
            if (!item.stepId) return result;
            groups.push([...pendingUsers, item]);
            pendingUsers = [];
        } else if (item.role === 'tool') {
            const group = groups.at(-1);
            if (!group || group.find(entry => entry.role === 'assistant')?.stepId !== item.stepId) return result;
            group.push(item);
        } else return result;
    }
    if (groups.length <= keep) return result;
    const modelItems = groups.map(group => group.find(item => item.role === 'assistant')!);
    const states: ModelStepPairing[] = [];
    if (port.readModelStepPairings) {
        for (let offset = 0; offset < modelItems.length; offset += 100) {
            checkAbort(signal);
            const stepIds = modelItems.slice(offset, offset + 100).map(item => item.stepId!);
            const batch = await port.readModelStepPairings({ conversationId: capture.conversationId, stepIds });
            if (batch.length !== stepIds.length) throw new ContextFault('SOURCE_GAP', '活动轮完整片段缺少步骤配对状态');
            states.push(...batch);
        }
    } else for (const group of groups) {
        checkAbort(signal);
        states.push(await fallbackPairing(port, capture, group.filter(item => item.role !== 'user'), policy.readFrameBytes));
    }
    const firstPending = states.findIndex(state => state !== 'complete');
    const completeCount = firstPending < 0 ? groups.length : firstPending;
    if (completeCount <= keep) return result;
    const firstRetained = groups[completeCount - keep][0].seq;
    const prefix = activeItems.filter(item => item.seq < firstRetained);
    if (!prefix.length) return result;
    checkAbort(signal);
    const version = await port.readHistory({ conversationId: capture.conversationId, direction: 'backward', view: 'raw',
        effectiveOnly: true, includeValues: false, limit: 1, maxBytes: policy.readFrameBytes, expectedHistoryEpoch: capture.historyEpoch,
        throughSeq: capture.appendSeq });
    if (version.historyEpoch !== capture.historyEpoch || version.viewRevision !== capture.viewRevision || version.appendSeq !== capture.appendSeq) {
        throw new ContextFault('HISTORY_STALE', '活动轮片段读取期间历史或摘要版本改变');
    }
    if (Buffer.byteLength(canonicalJson(version.items)) > policy.readFrameBytes) throw new ContextFault('SOURCE_GAP', '活动轮片段校验超过单读预算');
    result.activeCompletedPrefix = { ...active, firstSeq: prefix[0].seq, lastSeq: prefix.at(-1)!.seq,
        itemIds: prefix.map(item => item.itemId), complete: true, nativePairing: 'complete' };
    return result;
}
