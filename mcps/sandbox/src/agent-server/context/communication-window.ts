import { createHash } from 'node:crypto';
import { canonicalJson } from '../protocol.js';
import type { JsonObject } from '../protocol.js';
import type { HistoryItem } from '../storage/port.js';
import type { CompactionSnapshot, ContextHistoryPort, ContextPolicy, ContextSourcePort, SourceBlock, SummaryNode, TokenCounter } from './contracts.js';
import { derivedContextId, freezeValue, hashBytes, hashContext } from './config.js';
import { checkAbort, ContextFault } from './errors.js';
import { readSourceFrame } from './sources.js';

export interface CommunicationOriginal {
    itemId: string;
    blockId: string;
    seq: number;
    role: 'user' | 'assistant';
    text: string;
    complete: boolean;
    byteLength: number;
    sha256: string;
    retrieval: JsonObject;
}

export interface CommunicationExchange {
    exchangeId: string;
    roundIds: string[];
    firstSeq: number;
    lastSeq: number;
    originals: CommunicationOriginal[];
    gaps?: CommunicationGap[];
}

export interface CommunicationGap {
    reason: 'original_unavailable' | 'read_budget' | 'scan_limit' | 'round_origin_missing' | 'round_identity_missing' | 'semantic_identity_missing';
    itemId?: string;
    contentId?: string;
    code?: string;
}

export interface CommunicationWindow {
    schemaVersion: 1;
    historyEpoch: number;
    coveredEndSeq: number;
    size: number;
    entries: CommunicationExchange[];
    originStartSeq?: number;
    bootstrap?: { source: 'stored_raw_history'; throughSeq: number; requestedSize: number; pages: number;
        grouping?: 'semantic' | 'host_round_fallback' | 'mixed';
        scannedItems: number; scannedBytes: number; readBytes: number; scanComplete: boolean; complete: boolean;
        stoppedBy: 'window_full' | 'history_exhausted' | 'scan_limit'; gaps: CommunicationGap[] };
    hash: string;
}

export interface CommunicationRendering {
    windowHash: string;
    text: string;
    hash: string;
    mode: 'originals' | 'excerpts' | 'index';
}

function visibleOriginal(part: CommunicationOriginal): boolean {
    return part.role !== 'assistant' || part.byteLength > 0 && (part.text.trim().length > 0 || !part.complete);
}

function clipOriginal(text: string, maximum: number): string {
    if (text.length <= maximum) return text;
    if (maximum < 4) return text.slice(0, maximum).replace(/[\uD800-\uDBFF]$/, '');
    const head = Math.ceil((maximum - 3) * 0.6);
    let prefix = text.slice(0, head);
    let suffix = text.slice(-(maximum - 3 - head));
    if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
    if (/^[\uDC00-\uDFFF]/.test(suffix)) suffix = suffix.slice(1);
    return prefix + '\n…\n' + suffix;
}

async function readOriginal(block: SourceBlock, sources: ContextSourcePort, snapshot: { config: { policy: Pick<ContextPolicy, 'readFrameBytes'> } },
    maximum: number, signal: AbortSignal): Promise<{ text: string; complete: boolean }> {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const hash = createHash('sha256');
    let head = '';
    let tail = '';
    let length = 0;
    const retain = Math.max(1, maximum);
    for (let offset = 0; offset < block.byteLength; offset += snapshot.config.policy.readFrameBytes) {
        checkAbort(signal);
        const bytes = await readSourceFrame(sources, { block, startByte: offset,
            endByte: Math.min(block.byteLength, offset + snapshot.config.policy.readFrameBytes),
            maxBytes: snapshot.config.policy.readFrameBytes, signal });
        hash.update(bytes);
        const text = decoder.decode(bytes, { stream: offset + bytes.length < block.byteLength });
        length += text.length;
        if (head.length < retain) head += text.slice(0, retain - head.length);
        tail = (tail + text).slice(-retain);
    }
    if (hash.digest('hex') !== block.sha256) throw new ContextFault('HISTORY_STALE', '交流记录原件与冻结来源哈希不同');
    return length <= retain ? { text: head, complete: true }
        : { text: clipOriginal(head + tail, retain), complete: false };
}

export function communicationNeedsBootstrap(window: CommunicationWindow | undefined, coveredEndSeq: number, policy: ContextPolicy): boolean {
    if (!coveredEndSeq) return false;
    if (!window) return true;
    if (window.coveredEndSeq !== coveredEndSeq) throw new ContextFault('PARENT_STALE', '交流记录与已压缩范围不同');
    return window.entries.length < policy.communicationWindowSize
        && (policy.communicationWindowSize > window.size || !window.bootstrap && window.originStartSeq !== 1);
}

function sealWindow(value: Omit<CommunicationWindow, 'hash'>, maximumChars: number): CommunicationWindow {
    const entries = [...value.entries].sort((left, right) => left.firstSeq - right.firstSeq).slice(-value.size);
    const perExchange = Math.max(1, Math.floor(maximumChars / Math.max(1, entries.length)));
    for (const entry of entries) {
        entry.originals = entry.originals.filter(visibleOriginal);
        entry.originals.sort((left, right) => left.seq - right.seq || left.blockId.localeCompare(right.blockId));
        const perPart = Math.max(1, Math.floor(perExchange / Math.max(1, entry.originals.length)));
        entry.originals = entry.originals.map(part => ({ ...part,
            text: clipOriginal(part.text, perPart), complete: part.complete && part.text.length <= perPart }));
    }
    const content = { ...value, entries };
    return freezeValue({ ...content, hash: hashContext(content) });
}

export async function bootstrapCommunicationWindow(input: {
    conversationId: string; historyEpoch: number; viewRevision: number; coveredEndSeq: number;
    policy: ContextPolicy; history: ContextHistoryPort; sources: ContextSourcePort; previous?: CommunicationWindow;
    maxScanItems?: number; maxScanBytes?: number; maxReadBytes?: number; signal?: AbortSignal;
}): Promise<CommunicationWindow> {
    const maximumItems = input.maxScanItems ?? 4096;
    const maximumScanBytes = input.maxScanBytes ?? 4 * 1024 * 1024;
    const maximumReadBytes = input.maxReadBytes ?? 16 * 1024 * 1024;
    if (![maximumItems, maximumScanBytes, maximumReadBytes].every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new ContextFault('CONFIG_INVALID', '交流原文首次窗口需要有效的扫描和正文读取预算');
    }
    const previous = input.previous;
    if (previous) renderCommunicationWindow(previous);
    const retained = structuredClone(previous?.entries ?? []);
    const needed = Math.max(0, input.policy.communicationWindowSize - retained.length);
    const throughSeq = retained.length ? Math.min(input.coveredEndSeq, retained[0].firstSeq - 1) : input.coveredEndSeq;
    const semantic = await input.history.readSemanticNodes?.(input.conversationId);
    if (semantic && (semantic.historyEpoch !== input.historyEpoch || semantic.viewRevision !== input.viewRevision)) {
        throw new ContextFault('HISTORY_STALE', '首次交流窗口需要同一已发布语义视图');
    }
    const exchanges = new Map<string, string>();
    for (const entry of retained) for (const roundId of entry.roundIds) exchanges.set(roundId, entry.exchangeId);
    for (const node of semantic?.nodes ?? []) {
        const { hash, ...content } = node;
        if (hash !== hashContext(content)) throw new ContextFault('SOURCE_GAP', '首次交流窗口语义节点哈希不一致');
        if (node.kind === 'batch' && node.exchangeId) for (const roundId of node.roundIds) exchanges.set(roundId, node.exchangeId);
    }
    const groups: { exchangeId: string; roundIds: string[]; items: HistoryItem[]; complete: boolean; semantic: boolean }[] = [];
    let group: typeof groups[number] | undefined;
    const retainedIds = new Set(retained.map(entry => entry.exchangeId));
    const newGroupCount = () => groups.filter(entry => !retainedIds.has(entry.exchangeId)).length;
    let cursor: string | undefined;
    let pages = 0;
    let scannedItems = 0;
    let scannedBytes = 0;
    let readBytes = 0;
    let lastSeq = throughSeq + 1;
    let stoppedBy: NonNullable<CommunicationWindow['bootstrap']>['stoppedBy'] = !needed ? 'window_full' : throughSeq ? 'scan_limit' : 'history_exhausted';
    const gaps: CommunicationGap[] = [];
    const cursors = new Set<string>();
    const signal = input.signal ?? new AbortController().signal;
    const finishGroup = (complete: boolean) => {
        if (group?.items.some(item => item.role === 'user' || item.role === 'assistant')) groups.push({ ...group, complete });
        group = undefined;
    };
    scan: while (throughSeq > 0 && newGroupCount() < needed && scannedItems < maximumItems && scannedBytes < maximumScanBytes) {
        checkAbort(signal);
        const page = await input.history.readHistory({ conversationId: input.conversationId, cursor, direction: 'backward',
            view: 'raw', effectiveOnly: true, includeValues: false, throughSeq, expectedHistoryEpoch: input.historyEpoch,
            limit: Math.min(50, maximumItems - scannedItems), maxBytes: Math.min(input.policy.readFrameBytes, maximumScanBytes - scannedBytes) });
        checkAbort(signal);
        if (page.historyEpoch !== input.historyEpoch || page.viewRevision !== input.viewRevision) throw new ContextFault('HISTORY_STALE', '首次交流窗口读取期间历史或已发布视图已改变');
        const pageBytes = Buffer.byteLength(canonicalJson(page.items));
        if (pageBytes > Math.min(input.policy.readFrameBytes, maximumScanBytes - scannedBytes)) throw new ContextFault('SOURCE_GAP', '首次交流窗口元数据页超过单读预算');
        scannedBytes += pageBytes;
        scannedItems += page.items.length;
        pages++;
        for (const item of page.items) {
            if (!item.effective || item.view !== 'raw' || item.seq >= lastSeq || item.seq > throughSeq) throw new ContextFault('SOURCE_GAP', '首次交流窗口需要有效原文的严格倒序索引');
            lastSeq = item.seq;
            const semanticExchangeId = item.roundId ? exchanges.get(item.roundId) : undefined;
            const exchangeId = semanticExchangeId ?? derivedContextId(['exchange', input.conversationId, input.historyEpoch, item.roundId]);
            if (item.roundId && group && exchangeId !== group.exchangeId) {
                finishGroup(true);
                if (newGroupCount() >= needed) { stoppedBy = 'window_full'; break scan; }
            }
            if (!item.roundId) {
                if (item.role === 'user' || item.role === 'assistant') gaps.push({ reason: 'round_identity_missing', itemId: item.itemId, contentId: item.contentId });
                continue;
            }
            group ??= { exchangeId, roundIds: [], items: [], complete: false, semantic: Boolean(semanticExchangeId) };
            if (!group.roundIds.includes(item.roundId)) group.roundIds.unshift(item.roundId);
            group.items.push(item);
        }
        if (!page.hasMore) { finishGroup(true); stoppedBy = 'history_exhausted'; break; }
        if (!page.items.length || !page.nextCursor || cursors.has(page.nextCursor)) throw new ContextFault('SOURCE_GAP', '首次交流窗口反向分页没有推进');
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
    }
    if (group) finishGroup(false);
    if (stoppedBy === 'scan_limit') gaps.push({ reason: 'scan_limit' });
    if (!scannedItems && throughSeq > 0 && needed > 0 && stoppedBy === 'history_exhausted') {
        gaps.push({ reason: 'original_unavailable', code: 'RAW_HISTORY_UNAVAILABLE' });
    }
    const entries: CommunicationExchange[] = [];
    const perExchange = Math.max(1, Math.floor(input.policy.communicationTextChars / Math.max(1, newGroupCount() + retained.length)));
    for (const selected of groups) {
        const entry: CommunicationExchange = { exchangeId: selected.exchangeId,
            roundIds: selected.roundIds, firstSeq: selected.items.at(-1)!.seq, lastSeq: selected.items[0].seq, originals: [] };
        const entryGaps: CommunicationGap[] = [];
        if (!selected.complete) entryGaps.push({ reason: 'scan_limit' });
        if (semantic && !selected.semantic) entryGaps.push({ reason: 'semantic_identity_missing' });
        if (!selected.items.some(item => item.role === 'user')) entryGaps.push({ reason: 'round_origin_missing' });
        for (const item of selected.items.filter(item => item.role === 'user' || item.role === 'assistant').reverse()) {
            checkAbort(signal);
            if (readBytes + item.objectRef.rawBytes * 2 > maximumReadBytes) {
                entryGaps.push({ reason: 'read_budget', itemId: item.itemId, contentId: item.contentId });
                continue;
            }
            readBytes += item.objectRef.rawBytes;
            let blocks: SourceBlock[] = [];
            try {
                blocks = await input.sources.describe(item, signal);
                for (const block of blocks) {
                    if (block.kind !== 'text' || item.role === 'assistant' && (!block.byteLength || !/^response\.blocks\.\d+\.text$/.test(block.blockId))) continue;
                    if (readBytes + block.byteLength > maximumReadBytes) {
                        entryGaps.push({ reason: 'read_budget', itemId: item.itemId, contentId: item.contentId });
                        continue;
                    }
                    readBytes += block.byteLength;
                    const original = await readOriginal(block, input.sources, { config: { policy: input.policy } }, perExchange, signal);
                    entry.originals.push({ itemId: item.itemId, blockId: block.blockId, seq: item.seq,
                        role: item.role as 'user' | 'assistant', ...original, byteLength: block.byteLength, sha256: block.sha256,
                        retrieval: { ...block.retrieval, contentId: item.contentId } });
                }
            } catch (error) {
                checkAbort(signal);
                const code = error instanceof Error && 'code' in error ? String(error.code) : 'SOURCE_READ_FAILED';
                if (/STORAGE_UNAVAILABLE|CANCELLED/.test(code)) throw error;
                entryGaps.push({ reason: 'original_unavailable', itemId: item.itemId, contentId: item.contentId, code });
            } finally { input.sources.releaseCached?.(blocks); }
        }
        if (entryGaps.length) entry.gaps = entryGaps;
        entries.push(entry);
    }
    const combined = new Map<string, CommunicationExchange>();
    for (const entry of [...entries, ...retained]) {
        const existing = combined.get(entry.exchangeId);
        if (!existing) { combined.set(entry.exchangeId, entry); continue; }
        combined.set(entry.exchangeId, { ...existing, firstSeq: Math.min(existing.firstSeq, entry.firstSeq), lastSeq: Math.max(existing.lastSeq, entry.lastSeq),
            roundIds: [...new Set([...existing.roundIds, ...entry.roundIds])],
            originals: [...new Map([...existing.originals, ...entry.originals].map(part => [JSON.stringify([part.itemId, part.blockId]), part])).values()],
            ...((existing.gaps?.length || entry.gaps?.length) ? { gaps: [...(existing.gaps ?? []), ...(entry.gaps ?? [])] } : {}) });
    }
    const semanticGroups = groups.filter(entry => entry.semantic).length;
    return sealWindow({ schemaVersion: 1, historyEpoch: input.historyEpoch, coveredEndSeq: input.coveredEndSeq,
        size: input.policy.communicationWindowSize, entries: [...combined.values()], originStartSeq: entries.at(-1)?.firstSeq ?? previous?.originStartSeq ?? 1,
        bootstrap: { source: 'stored_raw_history', throughSeq, requestedSize: input.policy.communicationWindowSize, pages,
            grouping: semanticGroups ? semanticGroups === groups.length ? 'semantic' : 'mixed' : 'host_round_fallback',
            scannedItems, scannedBytes, readBytes, scanComplete: stoppedBy !== 'scan_limit',
            complete: stoppedBy !== 'scan_limit' && !gaps.length && entries.every(entry => !entry.gaps?.length), stoppedBy, gaps } }, input.policy.communicationTextChars);
}

export async function updateCommunicationWindow(input: {
    previous?: CommunicationWindow; snapshot: CompactionSnapshot; nodes: SummaryNode[];
    coveredEndSeq: number; sources: ContextSourcePort; signal: AbortSignal;
}): Promise<CommunicationWindow> {
    const { snapshot, previous, signal } = input;
    const policy = snapshot.config.policy;
    const previousContent = previous ? (({ hash: _hash, ...content }) => content)(previous) : null;
    if (previous && (previous.historyEpoch !== snapshot.historyEpoch || previous.coveredEndSeq >= input.coveredEndSeq
        || previous.hash !== hashContext(previousContent))) {
        throw new ContextFault('HISTORY_STALE', '交流记录版本、范围或原件索引不一致');
    }
    const entries = new Map((previous?.entries ?? []).map(entry => [entry.exchangeId, structuredClone(entry)]));
    const accepted = snapshot.manifest.rounds.filter(round => round.lastSeq <= input.coveredEndSeq);
    for (const round of accepted) {
        const node = input.nodes.find(entry => entry.roundIds.includes(round.roundId));
        if (!node) throw new ContextFault('SOURCE_GAP', '交流记录缺少新进入完整轮的语义归属');
        const overlapping = [...entries.values()].reverse().find(entry => entry.roundIds.some(roundId => node.roundIds.includes(roundId)));
        const exchangeId = overlapping?.exchangeId ?? node.exchangeId ?? derivedContextId(['exchange', snapshot.conversationId, snapshot.historyEpoch, round.roundId]);
        const existing = entries.get(exchangeId);
        entries.set(exchangeId, existing ? { ...existing, lastSeq: round.lastSeq,
            roundIds: [...new Set([...existing.roundIds, round.roundId])] }
            : { exchangeId, firstSeq: round.firstSeq, lastSeq: round.lastSeq, roundIds: [round.roundId], originals: [] });
    }
    const selected = [...entries.values()].sort((left, right) => left.firstSeq - right.firstSeq).slice(-policy.communicationWindowSize);
    const selectedRounds = new Map(selected.flatMap(entry => entry.roundIds.map(roundId => [roundId, entry] as const)));
    const roles = new Map(snapshot.requirementSourceMetadata?.map(item => [item.itemId, item.role]));
    const available = Math.max(1, Math.floor(policy.communicationTextChars / Math.max(1, selected.length)));
    for (const block of snapshot.manifest.blocks) {
        checkAbort(signal);
        const entry = selectedRounds.get(block.roundId);
        const role = roles.get(block.itemId);
        if (!entry || block.seq > input.coveredEndSeq || block.kind !== 'text'
            || role !== 'user' && role !== 'assistant'
            || role === 'assistant' && (!block.byteLength || !/^response\.blocks\.\d+\.text$/.test(block.blockId))
            || entry.originals.some(part => part.itemId === block.itemId && part.blockId === block.blockId)) continue;
        const original = await readOriginal(block, input.sources, snapshot, available, signal);
        entry.originals.push({ itemId: block.itemId, blockId: block.blockId, seq: block.seq, role,
            ...original, byteLength: block.byteLength, sha256: block.sha256, retrieval: structuredClone(block.retrieval) });
    }
    for (const entry of selected) {
        entry.originals = entry.originals.filter(visibleOriginal);
        entry.originals.sort((left, right) => left.seq - right.seq || left.blockId.localeCompare(right.blockId));
        const partBudget = Math.max(1, Math.floor(available / Math.max(1, entry.originals.length)));
        entry.originals = entry.originals.map(part => ({ ...part,
            text: clipOriginal(part.text, partBudget), complete: part.complete && part.text.length <= partBudget }));
    }
    const value = { schemaVersion: 1 as const, historyEpoch: snapshot.historyEpoch,
        coveredEndSeq: input.coveredEndSeq, size: policy.communicationWindowSize, entries: selected,
        originStartSeq: previous?.originStartSeq ?? snapshot.coveredStartSeq,
        ...(previous?.bootstrap ? { bootstrap: previous.bootstrap } : {}) };
    return freezeValue({ ...value, hash: hashContext(value) });
}

export function renderCommunicationWindow(window?: CommunicationWindow, maximumTextChars = Number.MAX_SAFE_INTEGER): string {
    if (!window) return '';
    const { hash, ...value } = window;
    if (hash !== hashContext(value)) throw new ContextFault('SOURCE_GAP', '交流记录发布快照哈希无效');
    return ['Communication originals from the compressed range (tools excluded; grouped by stored round identities, not message counts):',
        ...(window.bootstrap ? [`[raw bootstrap; throughSeq=${window.bootstrap.throughSeq}; scanComplete=${window.bootstrap.scanComplete}; originalsComplete=${window.bootstrap.complete}; stoppedBy=${window.bootstrap.stoppedBy}; gaps=${canonicalJson(window.bootstrap.gaps)}]`] : []),
        ...window.entries.map(entry => `[exchange ${entry.exchangeId}; rounds=${entry.roundIds.join(',')}; seq=${entry.firstSeq}..${entry.lastSeq}]\n`
            + entry.originals.filter(visibleOriginal).map(part => `[${part.role}; ${maximumTextChars === 0 ? 'original index' : part.complete && part.text.length <= maximumTextChars ? 'original' : 'original excerpt'}; read=history_read; artifactId=${String(part.retrieval.contentId ?? part.itemId)}; item=${part.itemId}; block=${part.blockId}; sha256=${part.sha256}]\n${clipOriginal(part.text, maximumTextChars)}`).join('\n')
            + (entry.gaps?.length ? `\n[original gaps; ${canonicalJson(entry.gaps)}]` : ''))].join('\n\n');
}

export function fitCommunicationRendering(window: CommunicationWindow | undefined, budget: number, countTokens: TokenCounter): CommunicationRendering | undefined {
    if (!window) return undefined;
    const full = renderCommunicationWindow(window);
    const finish = (text: string, mode: CommunicationRendering['mode']) => freezeValue({ windowHash: window.hash, text, hash: hashBytes(text), mode });
    if (countTokens(full) <= budget) return finish(full, window.entries.every(entry => entry.originals.filter(visibleOriginal).every(part => part.complete)) ? 'originals' : 'excerpts');
    const index = renderCommunicationWindow(window, 0);
    if (countTokens(index) <= budget) {
        let lower = 0;
        let upper = Math.max(0, ...window.entries.flatMap(entry => entry.originals.map(part => part.text.length)));
        let selected = index;
        while (lower < upper) {
            const middle = Math.ceil((lower + upper) / 2);
            const text = renderCommunicationWindow(window, middle);
            if (countTokens(text) <= budget) { lower = middle; selected = text; }
            else upper = middle - 1;
        }
        return finish(selected, lower ? 'excerpts' : 'index');
    }
    const gaps = Boolean(window.bootstrap?.gaps.length || window.entries.some(entry => entry.gaps?.length));
    const header = `[Communication originals indexed; window-sha256=${window.hash}; exchanges=${window.entries.length}; throughSeq=${window.coveredEndSeq}; originalGaps=${gaps}; text omitted for summary budget; read=history_read]`;
    const minimal = `[Communication originals omitted for budget; originalGaps=${gaps}; read=history_read]`;
    let selected = countTokens(header) <= budget ? header : countTokens(minimal) <= budget ? minimal : '';
    if (selected) for (const entry of [...window.entries].reverse()) {
        for (const part of entry.originals.filter(visibleOriginal).reverse()) {
            const line = `[original index; artifactId=${String(part.retrieval.contentId ?? part.itemId)}; item=${part.itemId}; block=${part.blockId}; sha256=${part.sha256}]`;
            if (countTokens(`${selected}\n${line}`) <= budget) selected += `\n${line}`;
        }
    }
    return finish(selected, 'index');
}

export function readCommunicationRendering(window: CommunicationWindow | undefined, rendering: CommunicationRendering): string {
    if (!window || rendering.windowHash !== window.hash || rendering.hash !== hashBytes(rendering.text)) {
        throw new ContextFault('SOURCE_GAP', '交流窗口固定渲染与原件索引不一致');
    }
    renderCommunicationWindow(window);
    return rendering.text;
}
