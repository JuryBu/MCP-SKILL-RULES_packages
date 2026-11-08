import { setTimeout as waitForAppend } from 'node:timers/promises';
import { canonicalJson } from '../protocol.js';
import type { JsonObject, JsonValue } from '../protocol.js';
import type { ExecutorContext } from '../runtime.js';
import type { ExecutionPlan, PreparedExecutionView } from '../execution.js';
import type { FunctionTool, NativeSendView, NormalizedResponse, ProviderAdapter, ToolResult } from '../providers/types.js';
import type { HistoryItem, HistoryPage } from '../storage/port.js';
import type { CompactionViewEstimator, ContextEstimate, ContextEstimateBasis, ContextHistoryPort, ContextLimits, ContextPolicy, ContextVersionState, ContextViewEstimator, ExecutionLease, FrozenCompressionConfig, SummaryView, TokenCounter } from './contracts.js';
import type { CompactionPreview } from './compaction.js';
import { ContextCompactor } from './bpc.js';
import type { CompactionHandle } from './bpc.js';
import { conservativeTextTokens } from './budget.js';
import { hashBytes, hashContext, validateContextPolicy } from './config.js';
import { checkAbort, ContextFault } from './errors.js';
import { hasNativeSignature, renderSummaryView } from './view.js';
import { estimateNativeTextView, validateContextEstimateForView } from './input-estimate.js';
import { appendNativeHistoryView, freezeNativeHistoryView } from './native-view-build.js';
import { historicalToolGroup } from './history-tool-outcomes.js';
import type { HistoricalToolResultResolver } from './history-tool-outcomes.js';
import type { NativeHistoryAdapter } from './native-view-build.js';
import type { ToolDeliveryIdentity, ToolDeliveryPolicy, ToolDelivery } from './tool-delivery.js';
import { hasInlineHistoryMedia, historyMatchesReference, MAX_MEDIA_HISTORY_SOURCE_BYTES, MAX_ORDINARY_HISTORY_BYTES,
    nativeHistoryMaterialBytes, validateMediaHistoryExpansion } from './sources.js';

export interface ContextServiceOptions {
    compactor?: ContextCompactor;
    compaction?: ConstructorParameters<typeof ContextCompactor>[0];
    readSummaryView?: (conversationId: string) => Promise<SummaryView | null>;
    readVersionState?: ContextHistoryPort['readVersionState'];
    policy?: Partial<ContextPolicy>;
    pageSize?: number;
    maxReadBytes?: number;
    maxViewBytes?: number;
    maxViewItems?: number;
    countTokens?: TokenCounter;
    preserveToolResult?: (identity: ToolDeliveryIdentity, result: ToolResult, policy?: ToolDeliveryPolicy) => Promise<ToolDelivery>;
    readToolDelivery?: (identity: ToolDeliveryIdentity) => Promise<ToolDelivery | null>;
}

export interface ContextStepInput {
    conversationId: string;
    execution: ExecutionLease;
    config: FrozenCompressionConfig;
    stepSeq: number;
    limits: ContextLimits;
    estimate: ContextEstimate;
    estimateCompaction?: CompactionViewEstimator;
}

export interface ContextBuildViewInput {
    conversationId: string;
    context: Pick<ExecutorContext, 'readHistory' | 'readContent' | 'signal'>;
    adapter: NativeHistoryAdapter & Partial<Pick<ProviderAdapter, 'version' | 'encode' | 'encodeForMeasurement'>>;
    modelId: string;
    baseView: NativeSendView;
    parameters?: JsonObject;
    summaryView?: SummaryView;
    summaryBudget?: number;
    maxViewBytes?: number;
    policy?: Partial<ContextPolicy>;
    appendUser?: (view: NativeSendView, content: JsonValue, item: HistoryItem) => NativeSendView | Promise<NativeSendView>;
    renderToolResults?: (view: NativeSendView, results: ToolResult[]) => Promise<ToolResult[]>;
    resolveHistoricalToolResults?: HistoricalToolResultResolver;
    injectSummary?: (view: NativeSendView, text: string) => NativeSendView | Promise<NativeSendView>;
    readItem?: (item: HistoryItem, bounds: { maxReadBytes: number; signal: AbortSignal }) => Promise<JsonValue>;
    nativeCompatible?: (source: { protocol: string; model: string | null; signed: boolean }, target: { protocol: string; model: string }) => boolean;
    estimateView?: ContextViewEstimator;
    compression?: Omit<ContextStepInput, 'conversationId' | 'estimate'>;
    readTailReuse?: 'offer' | 'consume';
    dynamicContext?: string | (() => Promise<string>);
}

interface CachedReadTail {
    context: ContextBuildViewInput['context'];
    coveredEndSeq: number;
    history: { historyEpoch: number; appendSeq: number; viewRevision: number };
    pages: HistoryPage[];
    values: Map<string, JsonValue>;
    bytes: number;
}

class PendingNativeToolStep extends Error {
    constructor(readonly history: ContextVersionState) {
        super('Current native tool step is still being recorded');
    }
}

export interface ContextBuildViewResult {
    view: NativeSendView;
    estimate: ContextEstimate;
    nativeReplayHash: string;
    attachmentManifestHash: string;
    history: { historyEpoch: number; appendSeq: number; viewRevision: number; firstSeq: number | null; lastSeq: number | null;
        loadedItems: number; pages: number; completeTail: true };
    summary: { coveredEndSeq: number; textHash: string; tokens: number };
}

export interface ContextCompactInput {
    conversationId: string;
    mode: 'preview' | 'background' | 'blocking' | 'manual';
    config: FrozenCompressionConfig;
    execution?: ExecutionLease;
    budget?: JsonObject;
    stepSeq?: number;
    operationId?: string;
}

export interface ContextCompactResult {
    preview: CompactionPreview;
    handle: CompactionHandle | null;
}

export interface ContextExecutionViewInput { tools?: FunctionTool[] }
export type ContextPrepareView = (context: ExecutorContext, plan: ExecutionPlan, input?: ContextExecutionViewInput) => Promise<PreparedExecutionView>;
export type ContextExecutionViewOverrides = Partial<Omit<ContextBuildViewInput, 'conversationId' | 'context' | 'adapter' | 'modelId'>>;
export type ContextExecutionViewResolver = (context: ExecutorContext, plan: ExecutionPlan, input?: ContextExecutionViewInput) => ContextExecutionViewOverrides | Promise<ContextExecutionViewOverrides>;

function objectValue(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function appendMessages(view: NativeSendView, messages: JsonObject[]): NativeSendView {
    if (view.protocol === 'gemini') return { ...view, contents: [...(view.contents ?? []), ...messages] };
    if (view.protocol === 'openai_responses') return { ...view, input: [...(view.input ?? []), ...messages] };
    return { ...view, messages: [...(view.messages ?? []), ...messages] };
}

export function appendPlainUser(view: NativeSendView, content: JsonValue): NativeSendView {
    const input = objectValue(content);
    const text = typeof content === 'string' ? content : typeof input?.text === 'string' ? input.text : null;
    if (text === null || (Array.isArray(input?.references) && input.references.length)) {
        throw new ContextFault('PROTOCOL_INCOMPATIBLE', '带引用或非纯文本输入需要注入原生appendUser适配', { requiredCallback: 'appendUser' });
    }
    if (view.protocol === 'gemini') return appendMessages(view, [{ role: 'user', parts: [{ text }] }]);
    if (view.protocol === 'openai_responses') return appendMessages(view, [{ role: 'user', content: [{ type: 'input_text', text }] }]);
    if (view.protocol === 'anthropic') return appendMessages(view, [{ role: 'user', content: [{ type: 'text', text }] }]);
    return appendMessages(view, [{ role: 'user', content: text }]);
}

export function injectSummaryText(view: NativeSendView, text: string): NativeSendView {
    if (!text) return view;
    if (view.protocol === 'gemini') {
        const instruction = view.systemInstruction ?? {};
        const parts = Array.isArray(instruction.parts) ? instruction.parts : [];
        return { ...view, systemInstruction: { ...instruction, parts: [...parts, { text }] } };
    }
    if (view.protocol === 'anthropic' || view.protocol === 'openai_responses') {
        if (view.system === undefined || typeof view.system === 'string') return { ...view, system: `${view.system ?? ''}${view.system ? '\n\n' : ''}${text}` };
        if (Array.isArray(view.system)) return { ...view, system: [...view.system, { type: 'text', text }] };
        throw new ContextFault('PROTOCOL_INCOMPATIBLE', '该system形状需要注入原生injectSummary适配', { requiredCallback: 'injectSummary' });
    }
    return appendMessages(view, [{ role: 'system', content: text }]);
}

export function appendDynamicContext(view: NativeSendView, text: string): NativeSendView {
    if (!text) return view;
    const content = `[Runtime workspace context; current snapshot, not a user message]\n${text}`;
    if (view.protocol === 'gemini') return appendMessages(view, [{ role: 'user', parts: [{ text: content }] }]);
    if (view.protocol === 'openai_responses') return appendMessages(view, [{ role: 'developer', content: [{ type: 'input_text', text: content }] }]);
    if (view.protocol === 'anthropic') return appendMessages(view, [{ role: 'user', content: [{ type: 'text', text: content }] }]);
    return appendMessages(view, [{ role: 'system', content }]);
}

export class ContextService {
    readonly compactor: ContextCompactor | undefined;
    private readonly policy: ContextPolicy;
    private readonly maxReadBytes: number;
    private readonly pageSize: number;
    private readonly maxViewBytes: number;
    private readonly maxViewItems: number;
    private readonly countTokens: TokenCounter;
    private readonly readTails = new Map<string, CachedReadTail>();
    private readTailBytes = 0;

    constructor(private readonly options: ContextServiceOptions = {}) {
        this.compactor = options.compactor ?? (options.compaction ? new ContextCompactor(options.compaction) : undefined);
        this.policy = validateContextPolicy(options.policy);
        this.maxReadBytes = options.maxReadBytes ?? this.policy.readFrameBytes;
        this.pageSize = options.pageSize ?? 50;
        this.maxViewBytes = options.maxViewBytes ?? 32 * 1024 * 1024;
        this.maxViewItems = options.maxViewItems ?? 2048;
        this.countTokens = options.countTokens ?? conservativeTextTokens;
        if (!Number.isSafeInteger(this.maxReadBytes) || this.maxReadBytes < 1024 || this.maxReadBytes > 262144
            || !Number.isSafeInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 50
            || !Number.isSafeInteger(this.maxViewBytes) || this.maxViewBytes < this.maxReadBytes
            || !Number.isSafeInteger(this.maxViewItems) || this.maxViewItems < 1) {
            throw new ContextFault('CONFIG_INVALID', 'ContextService读取帧、页或视图预算无效');
        }
    }

    async buildView(input: ContextBuildViewInput): Promise<ContextBuildViewResult> {
        const build = async () => {
            try { return await this.buildRawView(input); }
            catch (error) {
                if (input.summaryView || !(error instanceof ContextFault)
                    || !['CONTEXT_HISTORY_STALE', 'CONTEXT_PARENT_STALE'].includes(error.code)) throw error;
                return this.buildRawView({ ...input, readTailReuse: undefined });
            }
        };
        let result = await build();
        if (input.compression) {
            if (!this.compactor) throw new ContextFault('CONFIG_INVALID', '尚未注入压缩存储及模型端口');
            await this.compactor.beforeRequest({ ...input.compression, conversationId: input.conversationId,
                estimateCompaction: this.createCompactionEstimator(input, input.compression.execution), estimate: async () => {
                checkAbort(input.context.signal);
                const current = await this.readVersionState(input);
                checkAbort(input.context.signal);
                if (input.summaryView || current.historyEpoch !== result.history.historyEpoch || current.appendSeq !== result.history.appendSeq
                    || current.viewRevision !== result.history.viewRevision) result = await this.buildRawView({ ...input, summaryView: undefined });
                else validateContextEstimateForView(result.estimate, result.view, { modelId: input.modelId, adapterVersion: input.adapter.version });
                return result.estimate;
            } });
        }
        return result;
    }

    createCompactionEstimator(input: ContextBuildViewInput, execution: ExecutionLease): CompactionViewEstimator {
        return async (snapshot, summary, signal) => {
            const effectiveSignal = signal ? AbortSignal.any([input.context.signal, signal]) : input.context.signal;
            const currentInput = { ...input, context: { signal: effectiveSignal,
                readHistory: input.context.readHistory.bind(input.context), readContent: input.context.readContent.bind(input.context) } };
            checkAbort(effectiveSignal);
            if (snapshot.conversationId !== input.conversationId || execution.conversationId !== input.conversationId
                || snapshot.execution.conversationId !== input.conversationId || snapshot.execution.kind !== execution.kind
                || snapshot.execution.runId !== execution.runId || snapshot.execution.runEpoch !== execution.runEpoch
                || snapshot.execution.rootBudgetId !== execution.rootBudgetId || snapshot.execution.roundId !== execution.roundId
                || snapshot.execution.deadlineAt !== execution.deadlineAt
                || summary.coveredEndSeq < snapshot.coveredStartSeq || summary.coveredEndSeq > snapshot.coveredEndSeq) {
                throw new ContextFault('HISTORY_STALE', '摘要余量估计必须属于同一会话、来源覆盖和执行租约');
            }
            const compactionInput = { ...currentInput, compression: undefined, readTailReuse: undefined,
                summaryView: { revision: snapshot.parentViewRevision, historyEpoch: snapshot.historyEpoch,
                    coveredEndSeq: summary.coveredEndSeq, nodes: [] } };
            let built: ContextBuildViewResult;
            for (;;) {
                try { built = await this.buildRawView(compactionInput, summary, execution); break; }
                catch (error) {
                    if (!(error instanceof PendingNativeToolStep)) throw error;
                    const deadline = Date.parse(execution.deadlineAt);
                    if (!Number.isFinite(deadline)) throw new ContextFault('CONFIG_INVALID', '等待当前工具步骤需要有效的原任务期限');
                    let delay = 25;
                    for (;;) {
                        checkAbort(effectiveSignal);
                        const remaining = deadline - Date.now();
                        if (remaining <= 0) throw new ContextFault('CANCELLED', '等待当前工具步骤时原任务期限已到');
                        try { await waitForAppend(Math.min(delay, remaining), undefined, { signal: effectiveSignal }); }
                        catch (waitingError) { checkAbort(effectiveSignal); throw waitingError; }
                        const current = await this.readVersionState(currentInput);
                        if (current.historyEpoch !== error.history.historyEpoch || current.viewRevision !== error.history.viewRevision
                            || current.appendSeq !== error.history.appendSeq) break;
                        delay = Math.min(delay * 2, 250);
                    }
                }
            }
            if (built.history.historyEpoch !== snapshot.historyEpoch || built.history.viewRevision !== snapshot.parentViewRevision
                || built.history.appendSeq < snapshot.snapshotAppendSeq) throw new ContextFault('HISTORY_STALE', '摘要余量估计的历史版本或追加边界已改变');
            let estimate = built.estimate;
            const encodeForMeasurement = input.adapter.encodeForMeasurement ?? input.adapter.encode;
            if (!input.estimateView && encodeForMeasurement && estimate.confidence !== 'unknown') {
                estimate = { rules: 0, schema: 0, native: this.countTokens(JSON.stringify(encodeForMeasurement.call(input.adapter, built.view, input.modelId, input.parameters ?? {}))),
                    summary: 0, retained: 0, media: 0, protocol: 0, confidence: 'conservative' };
            }
            checkAbort(effectiveSignal);
            return { estimate, nativeViewHash: hashContext(built.view), modelId: input.modelId, adapterVersion: input.adapter.version ?? null };
        };
    }

    releaseReadTail(conversationId: string): void {
        const previous = this.readTails.get(conversationId);
        if (!previous) return;
        this.readTails.delete(conversationId);
        this.readTailBytes -= previous.bytes;
    }

    private async readVersionState(input: ContextBuildViewInput): Promise<ContextVersionState | HistoryPage> {
        checkAbort(input.context.signal);
        const current = await this.options.readVersionState?.(input.conversationId)
            ?? await input.context.readHistory({ direction: 'backward', limit: 1, maxBytes: this.maxReadBytes });
        checkAbort(input.context.signal);
        return current;
    }

    private offerReadTail(conversationId: string, tail: CachedReadTail): void {
        this.releaseReadTail(conversationId);
        const maxBytes = 4 * 1024 * 1024;
        if (tail.bytes > maxBytes || tail.values.size > 512) return;
        while (this.readTails.size && (this.readTails.size >= 16 || this.readTailBytes + tail.bytes > maxBytes)) {
            this.releaseReadTail(this.readTails.keys().next().value!);
        }
        this.readTails.set(conversationId, tail);
        this.readTailBytes += tail.bytes;
    }

    private async buildRawView(input: ContextBuildViewInput, renderedSummary?: { text: string; tokens: number },
        pendingExecution?: ExecutionLease): Promise<ContextBuildViewResult> {
        checkAbort(input.context.signal);
        if (input.baseView.protocol !== input.adapter.protocol) throw new ContextFault('PROTOCOL_INCOMPATIBLE', '发送视图与Provider适配器协议不同');
        const policy = input.policy ? validateContextPolicy(input.policy) : input.compression?.config.policy ?? this.policy;
        const summary = input.summaryView ?? await this.options.readSummaryView?.(input.conversationId)
            ?? (this.compactor ? await this.compactor.readView(input.conversationId, { policy, signal: input.context.signal }) : undefined);
        const coveredEndSeq = summary?.coveredEndSeq ?? 0;
        const summaryText = renderedSummary ? { ...renderedSummary, hash: hashBytes(renderedSummary.text) }
            : renderSummaryView(summary ?? { nodes: [] }, policy, Math.min(summary?.summaryBudget ?? Number.MAX_SAFE_INTEGER,
                input.summaryBudget ?? summary?.summaryBudget ?? input.compression?.limits.summaryBudget ?? Number.MAX_SAFE_INTEGER), this.countTokens);
        const text = summaryText.text;
        const rendered = { ...summaryText, text, tokens: this.countTokens(text), hash: hashBytes(text) };
        const selected: HistoryItem[] = [];
        const values = new Map<string, JsonValue>();
        const cursorSet = new Set<string>();
        const maxViewBytes = input.maxViewBytes ?? this.maxViewBytes;
        const offered = input.readTailReuse === 'consume' ? this.readTails.get(input.conversationId) : undefined;
        if (input.readTailReuse === 'consume') this.releaseReadTail(input.conversationId);
        let replayPages: HistoryPage[] | undefined;
        if (offered && offered.context === input.context && offered.coveredEndSeq === coveredEndSeq) {
            const current = await this.readVersionState(input);
            checkAbort(input.context.signal);
            const previousLast = offered.pages[0]?.items[0];
            const currentLast = 'items' in current ? current.items[0] : undefined;
            if (current.historyEpoch === offered.history.historyEpoch && current.appendSeq === offered.history.appendSeq
                && current.viewRevision === offered.history.viewRevision && (!('items' in current)
                    || (previousLast?.itemId === currentLast?.itemId && previousLast?.seq === currentLast?.seq
                        && previousLast?.objectRef.hash === currentLast?.objectRef.hash))) {
                replayPages = offered.pages;
            }
        }
        let cursor: string | undefined;
        let metadata: { historyEpoch: number; appendSeq: number; viewRevision: number } | undefined;
        let previousSeq = Number.MAX_SAFE_INTEGER;
        let bytes = Buffer.byteLength(canonicalJson(input.baseView)) + Buffer.byteLength(rendered.text);
        const baseBytes = bytes;
        let restoredSourceBytes = 0;
        let ordinarySourceBytes = 0;
        const capturedPages: HistoryPage[] = [];
        let capturedPageBytes = 0;
        let replayIndex = 0;
        let pages = 0;
        let reachedCovered = false;
        const readValue = (item: HistoryItem): JsonValue | Promise<JsonValue> => {
            if (input.readItem) return input.readItem(item, { maxReadBytes: this.maxReadBytes, signal: input.context.signal });
            if (item.objectRef.rawBytes > this.maxReadBytes) throw new ContextFault('SOURCE_GAP', '大原生内容需要有界readItem回调', { itemId: item.itemId, requiredCallback: 'readItem' });
            return item.value ?? input.context.readContent(item.contentId);
        };
        do {
            checkAbort(input.context.signal);
            const page = replayPages ? replayPages[replayIndex++]
                : await input.context.readHistory({ cursor, direction: 'backward', limit: this.pageSize, maxBytes: this.maxReadBytes });
            if (!page) throw new ContextFault('SOURCE_GAP', '复用历史页未覆盖原完整尾部');
            pages++;
            if (!metadata) metadata = { historyEpoch: page.historyEpoch, appendSeq: page.appendSeq, viewRevision: page.viewRevision };
            if (page.historyEpoch !== metadata.historyEpoch || page.appendSeq !== metadata.appendSeq || page.viewRevision !== metadata.viewRevision
                || (summary && (summary.historyEpoch !== page.historyEpoch || summary.revision !== page.viewRevision))) {
                throw new ContextFault('HISTORY_STALE', '有界发送视图读取期间历史或摘要版本已经变化');
            }
            const pageBytes = Buffer.byteLength(canonicalJson(page.items));
            if (pageBytes > this.maxReadBytes) throw new ContextFault('SOURCE_GAP', '历史页超过单读上限');
            if (input.readTailReuse === 'offer') { capturedPages.push(page); capturedPageBytes += pageBytes; }
            for (const item of page.items) {
                if (!item.effective || item.view !== 'raw' || item.seq >= previousSeq || item.seq > page.appendSeq) throw new ContextFault('SOURCE_GAP', '发送视图需要已消费有效原文及严格反向序号');
                previousSeq = item.seq;
                if (item.seq <= coveredEndSeq) { reachedCovered = true; break; }
                if (selected.length >= this.maxViewItems) throw new ContextFault('INPUT_BUDGET', '发送尾部达到有界项目上限，需要先压缩',
                    { maxViewItems: this.maxViewItems, appendSeq: page.appendSeq, coveredEndSeq });
                restoredSourceBytes += item.objectRef.rawBytes;
                if (!Number.isSafeInteger(item.objectRef.rawBytes) || item.objectRef.rawBytes < 0
                    || restoredSourceBytes > MAX_MEDIA_HISTORY_SOURCE_BYTES) throw new ContextFault('INPUT_BUDGET', '历史原件累计恢复量超过有界媒体预算',
                    { maxRecoveryBytes: MAX_MEDIA_HISTORY_SOURCE_BYTES, nextItemId: item.itemId });
                if (item.objectRef.rawBytes > MAX_ORDINARY_HISTORY_BYTES && (item.kind !== 'model_step' || item.role !== 'assistant' || !input.readItem)) {
                    throw new ContextFault('INPUT_BUDGET', '普通历史正文超过32MiB材料预算', { itemId: item.itemId });
                }
                const cachedValue = replayPages ? offered?.values.get(item.contentId) : undefined;
                let value = cachedValue !== undefined ? cachedValue : await readValue(item);
                let matchesReference = historyMatchesReference(item, value);
                if (cachedValue !== undefined && !matchesReference) {
                    value = await readValue(item);
                    matchesReference = historyMatchesReference(item, value);
                }
                if (!matchesReference) {
                    throw new ContextFault('HISTORY_STALE', '原生尾部正文与不可变历史引用不一致', { itemId: item.itemId });
                }
                if (hasInlineHistoryMedia(value)) validateMediaHistoryExpansion(value);
                else {
                    ordinarySourceBytes += item.objectRef.rawBytes;
                    if (ordinarySourceBytes > MAX_ORDINARY_HISTORY_BYTES) throw new ContextFault('INPUT_BUDGET', '普通历史累计正文超过32MiB材料预算');
                }
                const materialBytes = nativeHistoryMaterialBytes(value, maxViewBytes);
                if (bytes + materialBytes > maxViewBytes) throw new ContextFault('INPUT_BUDGET', '实际原生重放材料超过发送视图预算',
                    { maxViewBytes, loadedBytes: bytes, nextItemId: item.itemId });
                values.set(item.contentId, value);
                selected.push(item);
                bytes += materialBytes;
            }
            if (reachedCovered || !page.hasMore) break;
            if (!page.items.length || !page.nextCursor || cursorSet.has(page.nextCursor)) throw new ContextFault('SOURCE_GAP', '反向历史分页未推进');
            cursorSet.add(page.nextCursor);
            cursor = page.nextCursor;
        } while (cursor);
        if (!metadata) throw new ContextFault('SOURCE_GAP', '历史页缺少版本身份');
        if (coveredEndSeq > metadata.appendSeq) throw new ContextFault('PARENT_STALE', '摘要覆盖位置超过当前历史');
        const historyVersion = metadata;
        const rawTail = selected.reverse();
        const attachmentManifest: { itemId: string; objectHash: string; references?: JsonValue; nativeMedia?: JsonValue }[] = [];
        let view = await (input.injectSummary ?? injectSummaryText)(structuredClone(input.baseView), rendered.text);
        let pending: { item: HistoryItem; content: Record<string, unknown>; response: NormalizedResponse; results: ToolResult[] } | null = null;
        const flush = async (finalTail = false) => {
            if (!pending) return;
            const { item, content, response, results } = pending;
            if (!response.complete || !Array.isArray(response.replayMessages)) throw new ContextFault('NATIVE_PAIRING', '历史模型往返缺少完整原生replayMessages', { itemId: item.itemId });
            if (response.toolCalls.length) {
                const group = input.resolveHistoricalToolResults
                    ? historicalToolGroup(input.conversationId, item, content, response, results, input.context.signal) : null;
                const resolved = group ? await input.resolveHistoricalToolResults!(group) ?? results : results;
                if (finalTail && pendingExecution && item.runId === pendingExecution.runId && item.runEpoch === pendingExecution.runEpoch
                    && item.roundId === pendingExecution.roundId && item.stepId && resolved.length < response.toolCalls.length
                    && new Set(response.toolCalls.map(call => call.callId)).size === response.toolCalls.length
                    && new Set(resolved.map(result => result.callId)).size === resolved.length
                    && resolved.every(result => response.toolCalls.some(call => call.callId === result.callId && call.name === result.name))) {
                    throw new PendingNativeToolStep(historyVersion);
                }
                const stableResults: ToolResult[] = [];
                for (const result of resolved) {
                    if (!this.options.preserveToolResult) { stableResults.push(result); continue; }
                    if (!item.runId || !item.runEpoch || !item.stepId) throw new ContextFault('SOURCE_GAP', '工具稳定发送版本缺少原生历史执行身份');
                    const identity = { conversationId: input.conversationId, runId: item.runId,
                        runEpoch: item.runEpoch, stepId: item.stepId, callId: result.callId };
                    const previous = await this.options.readToolDelivery?.(identity);
                    if (previous && ![previous.receivedHash, previous.sentHash].includes(hashContext(result))) {
                        throw new ContextFault('SOURCE_GAP', '历史工具结果与原raw或固定sent版本不同');
                    }
                    stableResults.push((previous ?? await this.options.preserveToolResult(identity, result)).sent);
                }
                const nativeResults = input.renderToolResults ? await input.renderToolResults(view, stableResults) : stableResults;
                view = appendNativeHistoryView(input.adapter, view, response, nativeResults);
            }
            else {
                if (results.length) throw new ContextFault('NATIVE_PAIRING', '无工具调用的原生响应带了工具结果');
                view = appendMessages(view, response.replayMessages);
            }
            pending = null;
        };
        for (const item of rawTail) {
            checkAbort(input.context.signal);
            const value = values.get(item.contentId)!;
            const content = objectValue(value);
            if (item.role === 'user') {
                if (Array.isArray(content?.references) && content.references.length) attachmentManifest.push({ itemId: item.itemId,
                    objectHash: item.objectRef.hash, references: content.references as JsonValue });
                await flush();
                view = await (input.appendUser ?? appendPlainUser)(view, value, item);
            } else if (content?.kind === 'model' && objectValue(content.response)) {
                await flush();
                const response = content.response as unknown as NormalizedResponse;
                if (!Array.isArray(response.toolCalls) || !Array.isArray(response.blocks)) throw new ContextFault('NATIVE_PAIRING', '历史模型往返结构不完整', { itemId: item.itemId });
                const nativeMedia = response.blocks.filter(block => ['image', 'audio', 'video', 'file', 'native_unknown'].includes(block.type))
                    .map(block => ({ type: block.type, nativeRef: block.nativeRef, sha256: block.sha256 ?? null, mime: block.mime ?? null, uri: block.uri ?? null }));
                if (nativeMedia.length) attachmentManifest.push({ itemId: item.itemId, objectHash: item.objectRef.hash, nativeMedia });
                const source = { protocol: typeof content.protocol === 'string' ? content.protocol : item.providerProtocol ?? '',
                    model: response.modelId, signed: hasNativeSignature(response.replayMessages) || response.blocks.some(block => typeof block.thoughtSignature === 'string') };
                const target = { protocol: input.adapter.protocol, model: input.modelId };
                const compatible = input.nativeCompatible ? input.nativeCompatible(source, target)
                    : source.protocol === target.protocol && (!source.signed || source.model === target.model);
                if (!compatible) throw new ContextFault('PROTOCOL_INCOMPATIBLE', '历史原生响应协议或签名模型需要兼容确认', { itemId: item.itemId });
                pending = { item, content: content!, response, results: [] };
            } else if (content?.kind === 'tool' && objectValue(content.result)) {
                if (!pending || pending.item.stepId !== item.stepId || pending.item.roundId !== item.roundId) {
                    throw new ContextFault('NATIVE_PAIRING', '历史工具结果缺少相邻原生调用组', { itemId: item.itemId });
                }
                pending.results.push(content.result as unknown as ToolResult);
            } else throw new ContextFault('PROTOCOL_INCOMPATIBLE', '历史项目缺少可重放的原生类型', { itemId: item.itemId, kind: item.kind });
        }
        await flush(true);
        const dynamic = typeof input.dynamicContext === 'function' ? await input.dynamicContext() : input.dynamicContext;
        if (dynamic) view = appendDynamicContext(view, dynamic);
        if (Buffer.byteLength(canonicalJson(view)) > maxViewBytes) throw new ContextFault('INPUT_BUDGET', '完整原生发送视图超过明确内存预算', { maxViewBytes });
        view = freezeNativeHistoryView(view);
        const estimate = input.estimateView ? await input.estimateView(view, { baseView: input.baseView, summaryTokens: rendered.tokens })
            : estimateNativeTextView(view, { baseView: input.baseView, summaryTokens: rendered.tokens }, this.countTokens);
        checkAbort(input.context.signal);
        validateContextEstimateForView(estimate, view, { modelId: input.modelId, adapterVersion: input.adapter.version });
        if (input.readTailReuse === 'offer') this.offerReadTail(input.conversationId, { context: input.context, coveredEndSeq,
            history: metadata, pages: capturedPages, values, bytes: capturedPageBytes + restoredSourceBytes });
        return { view, estimate, nativeReplayHash: hashContext(rawTail.map(item => [item.itemId, item.objectRef.hash])),
            attachmentManifestHash: hashContext(attachmentManifest),
            history: { ...metadata, firstSeq: rawTail[0]?.seq ?? null, lastSeq: rawTail.at(-1)?.seq ?? null, loadedItems: rawTail.length, pages, completeTail: true },
            summary: { coveredEndSeq, textHash: rendered.hash, tokens: rendered.tokens } };
    }

    async compact(input: ContextCompactInput): Promise<ContextCompactResult> {
        if (!this.compactor) throw new ContextFault('CONFIG_INVALID', '尚未注入CompactionPort及CompressionModelPort');
        const preview = await this.compactor.preview(input.conversationId, input.config);
        if (input.mode === 'preview' || !preview.roundIds.length) return { preview, handle: null };
        if (input.mode === 'manual') return this.compactor.manual(input);
        if (!input.execution) throw new ContextFault('BUDGET_REQUIRED', '后台或硬压缩需要现有活动run及根预算', { preview });
        const handle = await this.compactor.start({ ...input, execution: input.execution, reason: input.mode === 'blocking' ? 'hard' : 'background' });
        if (input.mode === 'blocking') {
            await handle.completion;
            await this.compactor.publish(input.conversationId, input.stepSeq ?? 0);
        }
        return { preview, handle };
    }

    async postStep(input: ContextStepInput): Promise<{ backgroundCandidateId: string | null }> {
        if (!this.compactor) return { backgroundCandidateId: null };
        return this.compactor.postStep(input);
    }

    createPrepareView(resolve?: ContextExecutionViewResolver, onBuilt?: (result: ContextBuildViewResult,
        details: { conversationId: string; modelId: string; configFingerprint: string | null; estimateBasis: ContextEstimateBasis }) => void): ContextPrepareView {
        return async (context, plan, input): Promise<PreparedExecutionView> => {
            const overrides = await resolve?.(context, plan, input) ?? {};
            const baseView = { ...(overrides.baseView ?? { protocol: plan.adapter.protocol }), ...(input?.tools ? { tools: input.tools } : {}) };
            const result = await this.buildView({ ...overrides, conversationId: context.snapshot.conversationId,
                context, adapter: plan.adapter, modelId: plan.modelId,
                parameters: plan.parameters, baseView });
            onBuilt?.(result, { conversationId: context.snapshot.conversationId, modelId: plan.modelId, configFingerprint: overrides.compression?.config.configFingerprint ?? null,
                estimateBasis: result.estimate.tokenCountEvidence ? 'provider_native_count_tokens'
                    : overrides.estimateView || this.countTokens !== conservativeTextTokens ? 'injected_estimator' : 'native_view_utf8_upper_bound' });
            return { view: result.view, history: { historyEpoch: result.history.historyEpoch,
                appendSeq: result.history.appendSeq, viewRevision: result.history.viewRevision }, attachmentManifestHash: result.attachmentManifestHash };
        };
    }
}

export function adaptContextPrepareView(service: ContextService, resolve?: ContextExecutionViewResolver): ContextPrepareView {
    return service.createPrepareView(resolve);
}
