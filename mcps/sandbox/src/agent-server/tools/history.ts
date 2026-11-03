import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { ContextCapture, SummaryNode } from '../context/contracts.js';
import { validateSummaryNodes } from '../context/view.js';
import type { StorePort } from '../storage/port.js';
import type { ContextSummaryReadInput } from '../storage/context-transactions.js';
import { MAX_CONTEXT_SUMMARY_NODE_BYTES } from '../storage/context-transactions.js';
import { measureCanonicalJsonBytes } from '../media/temporary-budget.js';
import type { ToolExecutionContext } from './types.js';
import { searchHistory } from './history-search.js';

export interface HistoryUsefulHit {
    conversationId: string;
    historyEpoch: number;
    viewRevision: number;
    hitId: string;
    summaryId?: string;
    summaryHash?: string;
    roundHit?: number;
    roundIds: string[];
    firstSeq: number;
    lastSeq: number;
}

export interface HistoryRecallPort {
    readHistory: StorePort['readHistory'];
    readArtifact: StorePort['readArtifact'];
    inspect(conversationId: string): Promise<ContextCapture>;
    readSummary?(input: ContextSummaryReadInput): Promise<SummaryNode | null>;
    markHit?(input: HistoryUsefulHit, context: ToolExecutionContext): Promise<unknown>;
}

export interface HistoryReadArguments {
    summaryId?: string;
    artifactId?: string;
    offset?: number;
    startRound?: number;
    endRound?: number;
    cursor?: string;
    limit: number;
    maxBytes: number;
    direction: 'forward' | 'backward';
}

export interface HistorySearchArguments {
    query: string;
    startRound?: number;
    endRound?: number;
    cursor?: string;
    limit: number;
    maxBytes: number;
    scanBytes: number;
}

export interface HistoryHitArguments {
    summaryId?: string;
    roundHit?: number;
}

export function isHistoryRecallTool(name: string): boolean {
    return name === 'history_read' || name === 'history_search' || name === 'mark_history_hit';
}

export async function assertHistoryCurrent(context: ToolExecutionContext): Promise<void> {
    if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '历史查回已取消');
    await context.assertCurrent?.();
    if (context.signal.aborted) throw new AgentFault('TOOL_CANCELLED', '历史查回已取消');
}

export async function readHistoryRoundNumbers(port: Pick<HistoryRecallPort, 'readHistory'>, capture: ContextCapture,
    context: ToolExecutionContext, targets: ReadonlySet<string>): Promise<Map<string, number>> {
    if (capture.conversationId !== context.conversationId || capture.view.historyEpoch !== capture.historyEpoch) {
        throw new AgentFault('HISTORY_STALE', '历史轮锚点的会话或历史代次不同');
    }
    const numbers = new Map<string, number>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 32 && targets.size; pageIndex++) {
        await assertHistoryCurrent(context);
        const page = await port.readHistory({ conversationId: context.conversationId, cursor, direction: 'forward',
            limit: 200, maxBytes: 65536, view: 'raw', effectiveOnly: false, includeValues: false,
            expectedHistoryEpoch: capture.historyEpoch, throughSeq: capture.appendSeq });
        await assertHistoryCurrent(context);
        for (const item of page.items) {
            if (item.role === 'user' && item.roundId && !numbers.has(item.roundId)) numbers.set(item.roundId, numbers.size + 1);
        }
        if ([...targets].every(roundId => numbers.has(roundId)) || !page.hasMore) return numbers;
        if (!page.nextCursor || page.nextCursor === cursor) throw new AgentFault('STORAGE_CURSOR_STALE', '历史轮锚点分页未向前推进');
        cursor = page.nextCursor;
    }
    return numbers;
}

function summaryName(value: string): string { return value.startsWith('summary:') ? value.slice(8) : value; }

function textFragment(bytes: Buffer, start: number, maxBytes: number): { text: string; end: number } {
    let end = Math.min(bytes.length, start + maxBytes);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    if (end <= start && start < bytes.length) throw new AgentFault('INVALID_PARAMS', '正文预算不足以容纳一个UTF-8字符');
    return { text: bytes.subarray(start, end).toString('utf8'), end };
}

function completeUtf8End(bytes: Buffer): number {
    if (!bytes.length) return 0;
    let lead = bytes.length - 1;
    while (lead >= 0 && (bytes[lead] & 0xc0) === 0x80) lead--;
    if (lead < 0) return 0;
    const first = bytes[lead];
    const width = first < 0x80 ? 1 : (first & 0xe0) === 0xc0 ? 2 : (first & 0xf0) === 0xe0 ? 3 : 4;
    return lead + width <= bytes.length ? bytes.length : lead;
}

export class HistoryRecallTools {
    constructor(private readonly port: HistoryRecallPort) {}

    get canMarkHit(): boolean { return typeof this.port.markHit === 'function'; }

    async execute(name: string, args: unknown, context: ToolExecutionContext): Promise<unknown> {
        await assertHistoryCurrent(context);
        if (name === 'history_read') return this.read(args as HistoryReadArguments, context);
        if (name === 'history_search') return searchHistory(this.port, args as HistorySearchArguments, context);
        if (name === 'mark_history_hit') return this.markHit(args as HistoryHitArguments, context);
        throw new AgentFault('TOOL_NOT_ALLOWED', '未知的历史查回工具');
    }

    private async read(args: HistoryReadArguments, context: ToolExecutionContext): Promise<unknown> {
        if (args.summaryId) return this.readSummary(args, context);
        if (args.artifactId) return this.readArtifact(args, context);
        const page = await this.port.readHistory({ conversationId: context.conversationId, cursor: args.cursor,
            startRound: args.startRound, endRound: args.endRound, direction: args.direction, limit: args.limit,
            maxBytes: args.maxBytes - 2048, view: 'raw', effectiveOnly: true });
        await assertHistoryCurrent(context);
        const roundIds = new Set(page.items.map(item => item.roundId).filter((roundId): roundId is string => Boolean(roundId)));
        const capture = await this.port.inspect(context.conversationId);
        await assertHistoryCurrent(context);
        if (capture.historyEpoch !== page.historyEpoch) throw new AgentFault('STORAGE_CURSOR_STALE', '历史读取期间的历史代次已经变化');
        const numbers = await readHistoryRoundNumbers(this.port, { ...capture, appendSeq: page.appendSeq }, context, roundIds);
        const roundNumber = roundIds.size === 1 ? numbers.get([...roundIds][0]) : undefined;
        return { sourceHost: 'agent-server', representation: 'history_items', ...page,
            coverage: { requestedStartRound: args.startRound ?? null, requestedEndRound: args.endRound ?? null,
                direction: args.direction, throughSeq: page.appendSeq, firstSeq: page.items.at(0)?.seq ?? null,
                lastSeq: page.items.at(-1)?.seq ?? null, complete: !page.hasMore && page.items.every(item => item.value !== undefined),
                referenceCoverageComplete: !page.hasMore,
                omittedValueItemIds: page.items.filter(item => item.value === undefined).map(item => item.itemId) },
            originalRead: page.items.length ? { tool: 'history_read', arguments: { artifactId: page.items[0].contentId, offset: 0, maxBytes: args.maxBytes } } : null,
            usefulHit: roundNumber === undefined ? null : { tool: 'mark_history_hit', arguments: { roundHit: roundNumber } },
            usefulHitTool: 'mark_history_hit' };
    }

    private async readArtifact(args: HistoryReadArguments, context: ToolExecutionContext): Promise<unknown> {
        const chunk = await this.port.readArtifact({ conversationId: context.conversationId, artifactId: args.artifactId!,
            offset: args.offset ?? 0, maxBytes: Math.floor((args.maxBytes - 2048) / 8) });
        await assertHistoryCurrent(context);
        const bytes = Buffer.from(chunk.dataBase64, 'base64');
        const end = chunk.complete ? bytes.length : completeUtf8End(bytes);
        let textStart = 0;
        while (textStart < end && (bytes[textStart] & 0xc0) === 0x80) textStart++;
        const nextOffset = chunk.offset + end < chunk.totalBytes ? chunk.offset + end : null;
        return { sourceHost: 'agent-server', representation: 'canonical_json_fragment', ...chunk,
            dataBase64: bytes.subarray(0, end).toString('base64'), nextOffset, complete: nextOffset === null,
            text: bytes.subarray(textStart, end).toString('utf8'), textStartByte: chunk.offset + textStart,
            textSkippedLeadingBytes: textStart,
            coverage: { startByte: chunk.offset, endByte: chunk.offset + end, complete: chunk.offset === 0 && nextOffset === null },
            nextRead: nextOffset === null ? null : { tool: 'history_read', arguments: { artifactId: args.artifactId,
                offset: nextOffset, maxBytes: args.maxBytes } } };
    }

    private async resolveSummary(capture: ContextCapture, id: string, context: ToolExecutionContext, hash?: string): Promise<SummaryNode> {
        if (capture.conversationId !== context.conversationId || capture.view.historyEpoch !== capture.historyEpoch) {
            throw new AgentFault('HISTORY_STALE', '摘要查回的会话或历史代次不同');
        }
        const nodeId = summaryName(id);
        let node = capture.view.nodes.find(entry => entry.nodeId === nodeId && (hash === undefined || entry.hash === hash));
        if (!node && this.port.readSummary) {
            node = await this.port.readSummary({ conversationId: context.conversationId, historyEpoch: capture.historyEpoch,
                nodeId, hash, signal: context.signal }) ?? undefined;
            await assertHistoryCurrent(context);
        }
        if (!node) throw new AgentFault(hash === undefined ? 'NOT_FOUND' : 'STORAGE_CURSOR_STALE',
            '当前摘要视图与摘要归档未找到该版本，可按原轮查回原文', { summaryId: nodeId, historyEpoch: capture.historyEpoch,
                viewRevision: capture.viewRevision, lookupCoverage: this.port.readSummary ? 'current_view_and_summary_archive' : 'current_view',
                legacyCandidatesScanned: false });
        if (this.port.readSummary) {
            measureCanonicalJsonBytes(node, { maxBytes: MAX_CONTEXT_SUMMARY_NODE_BYTES });
            validateSummaryNodes([node]);
            if (!['batch', 'fold'].includes(node.kind) || node.nodeId !== nodeId || hash !== undefined && node.hash !== hash || !Number.isSafeInteger(node.firstSeq)
                || !Number.isSafeInteger(node.lastSeq) || node.firstSeq < 1 || node.lastSeq > capture.appendSeq
                || !Array.isArray(node.roundIds) || !node.roundIds.length || node.roundIds.some(roundId => typeof roundId !== 'string' || !roundId)) {
                throw new AgentFault('SOURCE_GAP', '摘要查回结果的原哈希或来源范围不同');
            }
        }
        return node;
    }

    private async readSummary(args: HistoryReadArguments, context: ToolExecutionContext): Promise<unknown> {
        const capture = await this.port.inspect(context.conversationId);
        await assertHistoryCurrent(context);
        let cursor: Record<string, unknown> | undefined;
        if (args.cursor) {
            try {
                cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
                if (!cursor || cursor.kind !== 'summary' || cursor.version !== 1 && cursor.version !== 2
                    || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0
                    || cursor.version === 2 && (cursor.conversationId !== context.conversationId || cursor.historyEpoch !== capture.historyEpoch
                        || cursor.nodeId !== summaryName(args.summaryId!) || typeof cursor.nodeHash !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.nodeHash))) throw new Error();
            } catch { throw new AgentFault('STORAGE_CURSOR_STALE', '摘要游标与会话、历史代次或摘要版本不一致'); }
        }
        const node = await this.resolveSummary(capture, args.summaryId!, context, cursor?.version === 2 ? String(cursor.nodeHash) : undefined);
        const bytes = Buffer.from(canonicalJson(node));
        const payloadHash = createHash('sha256').update(bytes).digest('hex');
        const fingerprint = createHash('sha256').update(canonicalJson([context.conversationId, capture.historyEpoch,
            capture.viewRevision, node.nodeId, node.hash, payloadHash])).digest('hex');
        const offset = cursor ? Number(cursor.offset) : 0;
        if (cursor && (cursor.version === 1 && cursor.fingerprint !== fingerprint || cursor.version === 2 && cursor.payloadHash !== payloadHash
            || offset > bytes.length || offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) {
            throw new AgentFault('STORAGE_CURSOR_STALE', '摘要游标与固定摘要正文或字节范围不一致');
        }
        const fragment = textFragment(bytes, offset, Math.floor((args.maxBytes - 2048) / 6));
        const complete = fragment.end === bytes.length;
        const nextCursor = complete ? null : Buffer.from(JSON.stringify(this.port.readSummary ? { kind: 'summary', version: 2,
            conversationId: context.conversationId, historyEpoch: capture.historyEpoch, nodeId: node.nodeId, nodeHash: node.hash,
            payloadHash, offset: fragment.end } : { kind: 'summary', version: 1, fingerprint, offset: fragment.end })).toString('base64url');
        const sourceRounds = new Set(node.roundIds);
        let startRound: number | undefined;
        let endRound: number | undefined;
        for (let index = 0; index < capture.rounds.length; index++) {
            const round = capture.rounds[index];
            if (!sourceRounds.has(round.roundId)) continue;
            const number = round.roundNumber;
            if (number === undefined) continue;
            startRound = Math.min(startRound ?? number, number);
            endRound = Math.max(endRound ?? number, number);
        }
        return { sourceHost: 'agent-server', representation: 'summary_canonical_json', summaryId: node.nodeId, kind: node.kind,
            hash: node.hash, payloadHash, historyEpoch: capture.historyEpoch, viewRevision: capture.viewRevision,
            source: capture.view.nodes.some(entry => entry.nodeId === node.nodeId && entry.hash === node.hash) ? 'current_view' : 'summary_archive',
            sourceRoundIds: node.roundIds,
            firstSeq: node.firstSeq, lastSeq: node.lastSeq, offset, totalBytes: bytes.length, text: fragment.text,
            hasMore: !complete, nextCursor, coverage: { startByte: offset, endByte: fragment.end,
                complete: offset === 0 && complete, sourceFirstSeq: node.firstSeq, sourceLastSeq: node.lastSeq },
            originalRead: startRound === undefined ? null : { tool: 'history_read', arguments: { startRound, endRound, maxBytes: args.maxBytes } },
            usefulHit: { tool: 'mark_history_hit', arguments: { summaryId: node.nodeId } } };
    }

    private async markHit(args: HistoryHitArguments, context: ToolExecutionContext): Promise<unknown> {
        if (!this.port.markHit) throw new AgentFault('TOOL_UNAVAILABLE', '历史有用命中的持久反馈端口尚未接入');
        const capture = await this.port.inspect(context.conversationId);
        await assertHistoryCurrent(context);
        let source: Omit<HistoryUsefulHit, 'conversationId' | 'historyEpoch' | 'viewRevision' | 'hitId'>;
        if (args.summaryId) {
            const node = await this.resolveSummary(capture, args.summaryId, context);
            source = { summaryId: node.nodeId, summaryHash: node.hash, roundIds: [...node.roundIds], firstSeq: node.firstSeq, lastSeq: node.lastSeq };
        } else {
            let cursor: string | undefined;
            let roundId: string | undefined;
            let firstSeq: number | undefined;
            let lastSeq: number | undefined;
            for (let pageIndex = 0; pageIndex < 32; pageIndex++) {
                const page = await this.port.readHistory({ conversationId: context.conversationId, cursor,
                    startRound: args.roundHit, endRound: args.roundHit, direction: 'forward', limit: 200,
                    maxBytes: 65536, view: 'raw', effectiveOnly: true, includeValues: false,
                    expectedHistoryEpoch: capture.historyEpoch, throughSeq: capture.appendSeq });
                await assertHistoryCurrent(context);
                for (const item of page.items) {
                    if (!item.roundId || roundId !== undefined && roundId !== item.roundId) {
                        throw new AgentFault('SOURCE_GAP', '原轮范围中出现不同的轮身份');
                    }
                    roundId = item.roundId;
                    firstSeq ??= item.seq;
                    lastSeq = item.seq;
                }
                if (!page.hasMore) break;
                if (pageIndex === 31) throw new AgentFault('SOURCE_GAP', '原轮范围超过有界查回预算，尚未记录有用命中');
                if (!page.nextCursor || page.nextCursor === cursor) throw new AgentFault('STORAGE_CURSOR_STALE', '原轮范围分页未向前推进');
                cursor = page.nextCursor;
            }
            if (!roundId || firstSeq === undefined || lastSeq === undefined) throw new AgentFault('NOT_FOUND',
                '原文存储中没有该历史轮，请使用查回结果中的轮锚点');
            source = { roundHit: args.roundHit, roundIds: [roundId], firstSeq, lastSeq };
        }
        const hit: HistoryUsefulHit = { conversationId: context.conversationId, historyEpoch: capture.historyEpoch,
            viewRevision: capture.viewRevision, hitId: context.actionId!, ...source };
        const receipt = await this.port.markHit(hit, context);
        return { recorded: true, source: hit, receipt: receipt ?? null,
            application: '有用命中已交给持久反馈端口，后续压缩发布按该反馈调整保留程度' };
    }
}
