import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonObject, JsonValue } from '../protocol.js';
import type { ExecutorContext } from '../runtime.js';
import type { ExecutionPlan } from '../execution.js';
import type { StateMutationPort, StateMutationScope, StorePort, StoreRecord, StoreTransition, TransitionExpected } from '../storage/port.js';
import type { ProviderDispatcher } from '../providers/dispatch.js';
import type { createProviderServices } from '../providers/services.js';
import { resolveRuntimeOutputBudget } from '../models/catalog.js';
import type { NativeSendView, NormalizedResponse, ProviderProfile, RequestSnapshot } from '../providers/types.js';
import { ProviderFault } from '../providers/types.js';
import type { UpperBound } from '../accounting/budget-ledger.js';
import type { PersistedProviderAttempt } from '../storage/provider-journal.js';
import { StoreCompactionPort } from '../storage/context-port.js';
import { assertContextDispatchFence, contextCandidateKey, contextContent, contextRootBudgetId, contextRunKey, contextStateKey, ContextTransactions, nextContextRecord } from '../storage/context-transactions.js';
import type { ContextCandidateData, ContextStateData } from '../storage/context-transactions.js';
import { ContextService, appendPlainUser, injectSummaryText } from './service.js';
import type { ContextExecutionViewInput, ContextExecutionViewResolver, ContextPrepareView } from './service.js';
import type { CompressionModelPort, CompressionModelSelection, CompressionRequest, CompressionResult, ContextPolicy, ContextSourcePort,
    ContextCapture, ConversationContextLimits, ExecutionLease, FrozenCompressionConfig, MaintenanceCallbacks, UnknownContextCleanupInput } from './contracts.js';
import type { ContextExecutionCleanup } from './bpc.js';
import { computeConversationContextLimits, totalContextTokens } from './budget.js';
import { derivedContextId, freezeCompressionConfig, hashBytes, hashContext } from './config.js';
import { checkAbort, contextFailure, ContextFault } from './errors.js';
import { ArtifactProjectionCache, createArtifactHistorySourcePort, readHistoryArtifact } from './artifact-source.js';
import { createContextServerControls } from './server-controls.js';
import type { ContextPreparedMeasurement, ContextServerCompactInput, ContextServerCompactResult, ContextServerControlInput, ContextServerControlResult, ContextServerStatus, ContextServerStatusInput } from './server-controls.js';
import { createContextMaintenanceCallbacks } from './maintenance-budget.js';
import { createHistoricalToolResultResolver } from './history-tool-outcomes.js';
import { parseRequirementResolutions } from './requirements.js';
import type { ContextMaintenanceBudgetOptions } from './maintenance-budget.js';

export type ContextProviderServices = ReturnType<typeof createProviderServices>;
export interface ContextProviderJournal { readAttempt(attemptId: string): Promise<PersistedProviderAttempt | undefined> }

interface DispatchLink extends Record<string, unknown> {
    kind: 'context_dispatch';
    requestHash: string;
    contentId: string;
    attemptId: string;
    providerAttemptId: string;
    state: 'prepared' | 'committed' | 'notAccepted' | 'unknown';
}

interface DispatchMaterial { snapshot: RequestSnapshot; upperBound: UpperBound }
interface ContextControlWrite { capture: ContextCapture; configFingerprint: string | null }

export interface CompressionSelection {
    profileId?: string;
    modelId: string;
    parameters?: JsonObject;
    maxOutputTokens?: number;
    routeId?: string | null;
}

export interface ContextServerAdapterOptions {
    store: StorePort;
    provider: ContextProviderServices;
    dispatcher: Pick<ProviderDispatcher, 'execute' | 'lookup'>;
    journal: ContextProviderJournal;
    maintenance?: MaintenanceCallbacks;
    maintenanceBudget?: ContextMaintenanceBudgetOptions;
    policy?: Partial<ContextPolicy>;
    rules?: string;
    resolveSelection?: (context: ExecutorContext, plan: ExecutionPlan) => Promise<{
        global?: CompressionSelection | null; conversation?: CompressionSelection | null;
        policy?: Partial<ContextPolicy>; revision?: number; rules?: string;
    }>;
    resolveView?: ContextExecutionViewResolver;
    sourceForConversation?: (conversationId: string) => ContextSourcePort;
    authorizeControlWrite?: (conversationId: string) => Promise<TransitionExpected | void>;
    now?: () => number;
    maxCachedConversations?: number;
    maxSourceCacheBytes?: number;
}

export interface ContextServerBinding {
    config: FrozenCompressionConfig;
    execution: ExecutionLease;
    limits: ConversationContextLimits;
    stepSeq: number;
}

export interface ContextServerAdapter {
    service: ContextService;
    prepareView: ContextPrepareView;
    bind(context: ExecutorContext, plan: ExecutionPlan): Promise<ContextServerBinding>;
    postStep(context: ExecutorContext, plan: ExecutionPlan, input?: ContextExecutionViewInput): ReturnType<ContextService['postStep']>;
    finishExecution(context: ExecutorContext): Promise<ContextExecutionCleanup>;
    reconcileCleanup(input: { conversationId: string; runId: string }): Promise<boolean>;
    confirmUnknownCleanup(input: UnknownContextCleanupInput): Promise<boolean>;
    status(input: ContextServerStatusInput): Promise<ContextServerStatus>;
    compact(input: ContextServerCompactInput): Promise<ContextServerCompactResult>;
    cancelCompaction(input: ContextServerControlInput): Promise<ContextServerControlResult>;
    restartCompaction(input: ContextServerControlInput): Promise<ContextServerControlResult>;
    recoverCompaction(input: ContextServerControlInput & { candidateId: string }): Promise<ContextServerControlResult>;
    readPreparedEstimate(input: { conversationId: string; view: NativeSendView; modelId: string }): ContextPreparedMeasurement | null;
    releaseConversation(conversationId: string): boolean;
    cacheSnapshot(): { sourcePorts: number; sourceBytes: number; indexConversations: number; indexItems: number };
    compactionPort: StoreCompactionPort;
    compressionModel: ProviderCompressionModelPort;
}

function dispatchKey(request: CompressionRequest) {
    return { conversationId: request.execution.conversationId, kind: 'step' as const, id: `context:dispatch:${request.attemptId}` };
}

function requestIdentity(request: CompressionRequest): string {
    return hashContext({ attemptId: request.attemptId, actionId: request.actionId, stepId: request.stepId,
        execution: request.execution, chunkId: request.chunk.chunkId, inputBodyHash: request.inputBodyHash,
        modelFingerprint: request.snapshot.effectiveModelFingerprint, compressionGeneration: request.snapshot.compressionGeneration,
        ...(request.validationRepair ? { validationRepair: request.validationRepair } : {}) });
}

export const COMPRESSION_INSTRUCTIONS = [
    'Create durable working memory for an ongoing task. Return exactly one JSON object with string fields body, skeleton, title and array unresolved. Never emit tool calls or Markdown fences.',
    'The body must preserve the current user goal, accepted constraints, key decisions and their reasons, exact identifiers, numbers, units, formulas, file/artifact locations, verified results, failures and unfinished work that later steps need.',
    'Keep corrections, rejected proposals and superseded values distinguishable from the current decision. Preserve why a value changed. Do not present a plan, a test fixture result, an unverified claim or a failed action as a completed real result.',
    'A sourceRoundOutcome closes a stopped local round, not its unfinished user goal. Preserve its actual failure/cancellation and outstanding requirements; never infer that requested work was performed merely because the round terminated.',
    'Summarize tools by their relevant inputs, actual outputs, side effects and remaining uncertainty. Preserve the source item/block identifiers needed to retrieve exact details. Media bytes, native signatures and raw tool records remain in their original stores; retain their retrieval anchors without inventing their contents.',
    'The skeleton is a compact factual index that retains essential current constraints, conclusions and source identifiers even when the full body is not sent. The title should identify the actual topic so the model can find it later.',
    'For every still-active user requirement or unresolved question in targets, include an unresolved entry with its exact quote and source itemId/blockId. Include startByte when the quote is repeated. Quote only the exact target substring, not a paraphrase. Do not use an empty unresolved array while target requirements remain unfinished.',
    'Each unresolved entry must use this JSON shape: {"quote":"an exact contiguous substring of ONE targets entry text","source":{"itemId":"that targets entry span.itemId","blockId":"that targets entry span.blockId"}}. Omit source.startByte for a unique quote: the host computes its exact UTF-8 byte offset from the frozen source. Prefer a longer unique quote over calculating an offset. A repeated quote requires its correct absolute UTF-8 byte offset, not a character index. Never add unresolved entries quoted only from references or priorGuidance; those sources remain outside this target delta.',
    'Use references and priorGuidance only to understand the target delta and preserve continuity. Compress only targets; do not turn reference-only material into new facts. When folding summaries, preserve their still-active obligations, source anchors and relationships.',
    'Read useful-history feedback as a relevance signal, retaining the facts that made that source useful. Keep unresolved obligations accessible even when their source has no hits. Follow the supplied rules and output budget.',
    'When requestBudget is present, summaryBudget is the remaining TOTAL encoded summary allowance in the complete task request after retained originals, current input, rules and tool schemas. Share that allowance across all active summaries, including folds, titles, anchors and verbatim unresolved obligations. It is not a per-chunk output allowance. Preserve all still-active obligations while making body, skeleton and title concise enough for that complete request.',
    'Do not replace concrete facts with generic statements such as details are stored elsewhere. Put the facts needed for the next task step in body and skeleton, then retain anchors for the remaining detail.',
    'You may also return resolutions: [{requirementId,status:"fulfilled"|"superseded",resolvedQuote,evidence:[{quote,source:{itemId,blockId}}],replacementRequirementId?}]. Use only exact IDs in priorGuidance.activeRequirements. Choose the smallest exact resolvedQuote: the contiguous part of the OLD requirement actually resolved by later evidence. The host preserves the original record and all text outside that part as active remainder obligations. Evidence must quote actual later targets/references or a known later requirement. Missing or uncertain evidence means keep the obligation. No resolutions field is required for an ordinary digest.',
    'Use superseded only for an explicit correction, withdrawal or phase continuation from a trusted later user source. Cite the exact user words that change the old obligation, not an assistant or tool restatement, acknowledgment, promise or summary. A later requirement ID is optional and must itself have user provenance; repeating an obligation preserves it. For a numerical threshold change inside a mixed requirement, resolve only the obsolete threshold; the original format and unfinished deliverable remain active unless the user explicitly changes them too.',
    'Use fulfilled only when exact later evidence demonstrates the requested work was actually done: a successful action/read-back, delivered content, or a trusted successfully closed assistant reply that itself completes conversational work. A successful assistant round may fulfill a simple request to confirm or briefly explain scope. For a substantive deliverable, acknowledgment is not delivery: an intent or promise to write, preserve or finish it later leaves it pending. Plans, fixtures, failed/cancelled actions and round termination do not fulfill unfinished work.',
    'For a mixed instruction to briefly explain the scope and keep an unfinished final report, fulfill only the scope-explanation clause after the actual reply; the ongoing report remains active. Keeping a task pending does not complete it. Split independent obligations into exact contiguous unresolved quotes when possible; never retire a whole mixed requirement because just one clause was satisfied or corrected. Phase-scoped waits and confirmation-only turns can be superseded by an actual later user continuation. Preserve ongoing substantive constraints when retiring a phase. The activeRequirements list rotates within a bounded byte budget; requirements not shown on this page remain active.',
].join('\n');

function parseDigest(request: CompressionRequest, response: NormalizedResponse): { digest: CompressionResult['digest']; valid: boolean;
    validationError?: string; repairable?: boolean; omittedReferenceRequirements?: Array<CompressionRequest['chunk']['sourceSpans'][number]>;
    normalizedRequirementSources?: Array<{ itemId: string; blockId: string; providedStartByte: number; startByte: number; endByte: number }> } {
    const text = response.blocks.filter(block => block.type === 'text' && !block.thought).map(block => block.text ?? '').join('\n').trim();
    let parsingResponse = true;
    try {
        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        const value = JSON.parse(cleaned) as Record<string, unknown>;
        parsingResponse = false;
        if (!value || typeof value.body !== 'string' || typeof value.skeleton !== 'string' || typeof value.title !== 'string'
            || (request.reason !== 'fold' && !Array.isArray(value.unresolved))
            || !value.body.trim() || !value.skeleton.trim() || !value.title.trim()) throw new Error('digest shape');
        if (request.reason === 'fold') return { digest: { body: value.body, skeleton: value.skeleton,
            title: value.title, unresolved: [] }, valid: true };
        type DigestPart = { text: string; span: CompressionRequest['chunk']['sourceSpans'][number] };
        const payload = JSON.parse(request.chunk.body) as { targets: DigestPart[]; references?: DigestPart[] };
        const targets = payload.targets;
        const omittedReferenceRequirements: Array<CompressionRequest['chunk']['sourceSpans'][number]> = [];
        const normalizedRequirementSources: Array<{ itemId: string; blockId: string; providedStartByte: number; startByte: number; endByte: number }> = [];
        const unresolved = (value.unresolved as unknown[]).flatMap(raw => {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('unresolved quote');
            const item = raw as { quote?: unknown; itemId?: string; blockId?: string; startByte?: number;
                source?: { itemId?: string; blockId?: string; startByte?: number } };
            if (typeof item.quote !== 'string' || !item.quote) throw new Error('unresolved quote');
            const quote = item.quote;
            const source = item.source ?? { itemId: item.itemId, blockId: item.blockId, startByte: item.startByte };
            if (typeof source.itemId !== 'string' || !source.itemId || typeof source.blockId !== 'string' || !source.blockId) {
                throw new Error('unresolved source identity');
            }
            const findMatches = (parts: DigestPart[]) => parts.flatMap(target => {
                if ((source.itemId && source.itemId !== target.span.itemId) || (source.blockId && source.blockId !== target.span.blockId)) return [];
                const positions: number[] = [];
                for (let position = target.text.indexOf(quote); position >= 0; position = target.text.indexOf(quote, position + 1)) positions.push(position);
                return positions.map(position => {
                    const startByte = target.span.startByte + Buffer.byteLength(target.text.slice(0, position));
                    const span = { ...target.span, startByte, endByte: startByte + Buffer.byteLength(quote), sha256: hashBytes(quote) };
                    return { span, quote };
                });
            });
            const targetMatches = findMatches(targets);
            let matches = targetMatches.filter(match => source.startByte === undefined || source.startByte === match.span.startByte);
            if (!matches.length && typeof source.itemId === 'string' && source.itemId && typeof source.blockId === 'string' && source.blockId
                && Number.isSafeInteger(source.startByte) && source.startByte! >= 0 && targetMatches.length === 1) {
                matches = targetMatches;
                normalizedRequirementSources.push({ itemId: source.itemId, blockId: source.blockId, providedStartByte: source.startByte!,
                    startByte: matches[0].span.startByte, endByte: matches[0].span.endByte });
            }
            if (matches.length === 1) return [{ id: derivedContextId(['requirement', matches[0].span, quote]), quote, source: matches[0].span }];
            const referenceMatches = findMatches(payload.references ?? []).filter(match => source.startByte === undefined || source.startByte === match.span.startByte);
            const reference = referenceMatches.length === 1 ? referenceMatches[0] : null;
            const referenceBlock = reference && request.snapshot.referenceBlocks?.find(block => block.itemId === reference.span.itemId
                && block.blockId === reference.span.blockId && block.sha256 === reference.span.blockHash);
            const targetEnd = request.snapshot.manifest?.rounds.at(-1)?.lastSeq;
            if (matches.length === 0 && source.itemId && source.blockId && !targets.some(target => target.text.includes(quote))
                && reference && reference.span.purpose === 'reference' && referenceBlock && targetEnd !== undefined
                && referenceBlock.seq > targetEnd && reference.span.startByte >= 0 && reference.span.endByte <= referenceBlock.byteLength) {
                omittedReferenceRequirements.push(reference.span);
                return [];
            }
            throw new Error('unresolved source ambiguous');
        });
        if (omittedReferenceRequirements.length && !unresolved.length) throw new Error('reference-only requirements without a verified target requirement');
        const resolutions = parseRequirementResolutions(value.resolutions, request, unresolved);
        return { digest: { body: value.body, skeleton: value.skeleton, title: value.title, unresolved,
            ...(resolutions.length ? { resolutions } : {}) }, valid: true,
            ...(omittedReferenceRequirements.length ? { omittedReferenceRequirements } : {}),
            ...(normalizedRequirementSources.length ? { normalizedRequirementSources } : {}) };
    } catch (error) { return { digest: { body: text, skeleton: '', title: '', unresolved: [] }, valid: false,
        repairable: (parsingResponse && error instanceof SyntaxError) || (error instanceof Error && ['digest shape', 'unresolved quote',
            'unresolved source identity', 'unresolved source ambiguous', 'reference-only requirements without a verified target requirement'].includes(error.message)),
        validationError: error instanceof Error ? error.message : 'digest validation failed' }; }
}

export class ProviderCompressionModelPort implements CompressionModelPort {
    private readonly active = new Map<string, { abort: AbortController; completion: Promise<CompressionResult> }>();
    private readonly now: () => number;

    constructor(private readonly options: Pick<ContextServerAdapterOptions, 'store' | 'provider' | 'dispatcher' | 'journal' | 'now'>) {
        this.now = options.now ?? Date.now;
    }

    private result(request: CompressionRequest, response: NormalizedResponse, snapshot: RequestSnapshot, committed = false): CompressionResult {
        const parsed = parseDigest(request, response);
        const terminalText = committed && response.complete && response.toolCalls.length === 0
            && response.problems.length === 0 && !response.blocks.some(block => block.type === 'refusal');
        const completed = terminalText && response.stop.kind === 'completed';
        return { attemptId: response.attemptId, requestAttemptId: request.attemptId, inputBodyHash: request.chunk.inputBodyHash,
            modelFingerprint: request.snapshot.effectiveModelFingerprint,
            complete: parsed.valid && response.complete && response.stop.kind === 'completed' && response.toolCalls.length === 0 && response.problems.length === 0,
            digest: parsed.digest, coverage: request.chunk.sourceSpans.map(span => ({ span,
                status: span.purpose === 'nativeAnchor' ? 'anchorOnly' as const : 'complete' as const, gaps: [] })),
            usage: JSON.parse(canonicalJson({ providerAttemptId: response.attemptId, requestAttemptId: request.attemptId,
                providerResponseId: response.providerResponseId, bodyHash: snapshot.bodyHash, reason: request.reason, usage: response.usage,
                digestValidation: parsed.validationError ?? 'valid', providerComplete: response.complete, providerStop: response.stop.kind,
                providerOutputTruncated: terminalText && response.stop.kind === 'truncated',
                validationRepairEligible: completed && !parsed.valid && parsed.repairable === true && parsed.digest.body.trim().length > 0,
                omittedReferenceRequirements: parsed.omittedReferenceRequirements ?? [],
                normalizedRequirementSources: parsed.normalizedRequirementSources ?? [] })) as JsonValue };
    }

    private async link(request: CompressionRequest): Promise<StoreRecord<DispatchLink> | undefined> {
        const record = await this.options.store.getRecord<DispatchLink>(dispatchKey(request));
        if (record && record.value.requestHash !== requestIdentity(request)) throw new ContextFault('USAGE_MISMATCH', '压缩尝试与原持久请求身份冲突', { attemptId: request.attemptId });
        return record;
    }

    private async updateLink(request: CompressionRequest, previous: StoreRecord<DispatchLink>, patch: Partial<DispatchLink>): Promise<StoreRecord<DispatchLink>> {
        const record = nextContextRecord(previous.key, previous, { ...previous.value, ...patch });
        await this.options.store.commitTransition({ expected: [{ key: previous.key, revision: previous.revision }], records: [record] });
        return record;
    }

    async generate(request: CompressionRequest, signal: AbortSignal): Promise<CompressionResult> {
        checkAbort(signal);
        if (await this.link(request)) {
            const known = await this.lookup(request);
            if (known.status === 'found') return known.result;
            throw new ContextFault('ATTEMPT_UNKNOWN', '压缩尝试已有持久意图，先恢复原请求', { attemptId: request.attemptId }, known.status !== 'notAccepted');
        }
        const abort = new AbortController();
        const onAbort = () => abort.abort(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        const completion = this.dispatch(request, abort.signal).finally(() => {
            signal.removeEventListener('abort', onAbort);
            this.active.delete(request.attemptId);
        });
        this.active.set(request.attemptId, { abort, completion });
        return completion;
    }

    private async dispatch(request: CompressionRequest, signal: AbortSignal): Promise<CompressionResult> {
        const selection = request.model;
        const profileId = selection.profileId ?? selection.provider;
        const profile = await this.options.provider.profiles.get(profileId);
        if (!profile || profile.revision !== selection.profileRevision || profile.credentialRef !== selection.credentialRef
            || profile.credentialGeneration !== selection.credentialGeneration || profile.protocol !== selection.protocol
            || hashContext(profile.routePolicy) !== hashContext(selection.routing)) throw new ContextFault('MODEL_STALE', '压缩模型配置或凭据代次已改变');
        const adapter = this.options.provider.adapterFor(profile.protocol);
        if (adapter.version !== selection.adapterVersion || adapter.endpoint(profile, selection.model) !== selection.endpoint) {
            throw new ContextFault('MODEL_STALE', '压缩适配器或发送端点已改变');
        }
        if (hashBytes(request.chunk.body) !== request.inputBodyHash || request.inputBodyHash !== request.chunk.inputBodyHash) {
            throw new ContextFault('SOURCE_GAP', '压缩分块实际字节与冻结指纹不同');
        }
        const instructions = request.reason === 'fold' ? `${COMPRESSION_INSTRUCTIONS}\nFor this fold, return only body, skeleton and title. The system inherits every child requirement and its resolution state, source proof and identity unchanged. Do not add, resolve or re-source requirements.` : COMPRESSION_INSTRUCTIONS;
        let view = appendPlainUser(injectSummaryText({ protocol: profile.protocol }, instructions), request.chunk.body);
        if (request.validationRepair) view = appendPlainUser(view, canonicalJson({ validationRepair: {
            previousAttemptId: request.validationRepair.previousAttemptId, validationError: request.validationRepair.validationError,
            instructions: 'Return one corrected JSON digest for the same frozen targets. Preserve all active requirements. Use exact source identities and a longer unique verbatim quote, or an exact absolute UTF-8 byte offset for repeated quotes. Return body, skeleton, title and unresolved. The previous response below failed validation.',
            previousResponse: request.validationRepair.previousResponse,
        } }));
        const versions = { conversationId: request.execution.conversationId, runId: request.execution.runId, runEpoch: request.execution.runEpoch,
                roundId: request.execution.roundId, stepId: request.stepId, actionId: request.actionId,
                historyEpoch: request.snapshot.historyEpoch, appendSeq: request.snapshot.snapshotAppendSeq,
                viewRevision: request.snapshot.parentViewRevision, workspaceRevision: request.snapshot.workspaceRevision,
                toolSchemaHash: hashContext([]), skillVersions: {}, attachmentManifestHash: hashContext(request.chunk.anchors),
                nativeReplayHash: hashContext(view), compressionGeneration: request.snapshot.compressionGeneration,
                compressionCandidateId: request.snapshot.candidateId, compressionRequestAttemptId: request.attemptId,
                effectiveCompressionModelFingerprint: request.snapshot.effectiveModelFingerprint,
                ...((request.originReason ?? (request.reason === 'fold' ? undefined : request.reason)) === undefined ? {}
                    : { compressionOriginReason: request.originReason ?? request.reason }) };
        const prepared = await this.options.provider.prepareRequest({ rootBudgetId: request.execution.rootBudgetId, profileId,
            modelId: selection.model, parameters: selection.parameters, view, versions, inputModalities: ['text'], outputModalities: ['text'],
            inputTokenUpperBound: Buffer.byteLength(canonicalJson(view)) + Buffer.byteLength(canonicalJson(selection.parameters)) + selection.model.length + 512,
            inputUpperBoundReliable: true,
            maxOutputTokens: request.maxOutputTokens, deadlineAt: request.execution.deadlineAt });
        if (prepared.snapshot.capabilityVersion !== selection.capabilityVersion || prepared.snapshot.profileRevision !== selection.profileRevision) {
            throw new ContextFault('MODEL_STALE', '压缩模型能力目录或配置在发送前已改变');
        }
        const contentId = randomUUID();
        let link = nextContextRecord<DispatchLink>(dispatchKey(request), undefined, { kind: 'context_dispatch', requestHash: requestIdentity(request),
            contentId, attemptId: request.attemptId, providerAttemptId: request.attemptId, state: 'prepared' });
        await this.options.store.commitTransition({ expected: [{ key: link.key, revision: null }], records: [link], contents: [
            contextContent(request.execution.conversationId, contentId, 'context_dispatch_material', { snapshot: prepared.snapshot, upperBound: prepared.upperBound })] });
        checkAbort(signal);
        try {
            const state = await new ContextTransactions(this.options.store).readState(request.execution.conversationId);
            const candidate = await this.options.store.getRecord<ContextCandidateData>(contextCandidateKey(request.execution.conversationId, request.snapshot.candidateId));
            assertContextDispatchFence(state.value, candidate?.value, prepared.snapshot);
            const response = await this.options.dispatcher.execute(prepared.adapter, prepared.snapshot, request.execution.rootBudgetId,
                prepared.upperBound, { signal, attemptId: request.attemptId });
            const persisted = await this.options.journal.readAttempt(response.attemptId);
            if (!persisted || persisted.state !== 'committed' || !persisted.response || persisted.attempt.rootBudgetId !== request.execution.rootBudgetId
                || persisted.attempt.snapshot.actionId !== request.actionId || persisted.attempt.snapshot.bodyHash !== prepared.snapshot.bodyHash) {
                throw new ContextFault('USAGE_MISMATCH', '压缩结果缺少同根预算及同请求的持久Provider回执', { attemptId: response.attemptId }, true);
            }
            link = await this.updateLink(request, link, { providerAttemptId: response.attemptId, state: 'committed' });
            return this.result(request, persisted.response, prepared.snapshot, true);
        } catch (error) {
            if (error instanceof AgentFault && !error.mayHaveStarted && error.details?.budgetReservationRejected === true
                && error.details.rootBudgetId === request.execution.rootBudgetId) {
                try { await this.updateLink(request, link, { state: 'notAccepted' }); }
                catch {
                    throw new ContextFault('COMMIT_UNKNOWN', '预算拒绝已确认未发送，本地派发回执尚未确认',
                        { attemptId: request.attemptId }, true);
                }
                throw new AgentFault(error.code, error.message, { ...error.details, compressionRequestAttemptId: request.attemptId });
            }
            const acceptance = error instanceof ProviderFault ? error.acceptance : error instanceof AgentFault && !error.mayHaveStarted ? 'not_sent' : 'unknown';
            await this.updateLink(request, link, { state: ['not_sent', 'rejected'].includes(acceptance) ? 'notAccepted' : 'unknown' }).catch(() => {});
            throw error;
        }
    }

    async lookup(request: CompressionRequest): ReturnType<CompressionModelPort['lookup']> {
        const link = await this.link(request);
        if (!link) return this.active.has(request.attemptId) ? { status: 'pending' } : { status: 'notAccepted' };
        const material = await this.options.store.readContent(request.execution.conversationId, link.value.contentId) as unknown as DispatchMaterial | undefined;
        if (!material?.snapshot || material.snapshot.actionId !== request.actionId || material.snapshot.rootBudgetId !== request.execution.rootBudgetId) {
            throw new ContextFault('USAGE_MISMATCH', '压缩持久发送快照与原请求不一致');
        }
        const providerAttempt = await this.options.journal.readAttempt(link.value.providerAttemptId);
        if (providerAttempt?.state === 'committed' && providerAttempt.response) {
            if (providerAttempt.attempt.rootBudgetId !== request.execution.rootBudgetId || providerAttempt.attempt.snapshot.actionId !== request.actionId
                || providerAttempt.attempt.snapshot.bodyHash !== material.snapshot.bodyHash) {
                throw new ContextFault('USAGE_MISMATCH', '恢复的Provider回执不属于原压缩请求', { attemptId: request.attemptId });
            }
            return { status: 'found', result: this.result(request, providerAttempt.response, providerAttempt.attempt.snapshot, true) };
        }
        if (link.value.state === 'notAccepted') return { status: 'notAccepted' };
        if (this.active.has(request.attemptId)) return { status: 'pending' };
        return { status: 'unknown' };
    }

    async cancel(request: CompressionRequest): Promise<'cancelled' | 'completed' | 'unknown'> {
        const active = this.active.get(request.attemptId);
        active?.abort.abort();
        if (active) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([active.completion.catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, 150); })]);
            if (timer) clearTimeout(timer);
        }
        const status = await this.lookup(request);
        return status.status === 'found' ? 'completed' : status.status === 'notAccepted' ? 'cancelled' : 'unknown';
    }
}

function selectionFromOptions(value: unknown): CompressionSelection | null {
    if (value === undefined || value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as JsonObject).modelId !== 'string') {
        throw new ContextFault('CONFIG_INVALID', '压缩模型选择需要明确modelId及可选profileId');
    }
    return value as unknown as CompressionSelection;
}

export function createContextServerAdapter(options: ContextServerAdapterOptions): ContextServerAdapter {
    if (options.maintenance && options.maintenanceBudget) throw new ContextFault('CONFIG_INVALID', '维护执行只允许一个预算所有者');
    const now = options.now ?? Date.now;
    const maximumConversations = options.maxCachedConversations ?? 16;
    const controlWrites = new AsyncLocalStorage<ContextControlWrite>();
    const fenceTransition = async (port: StateMutationPort, transition: StoreTransition, frozen: ContextControlWrite,
        authorization: TransitionExpected | void): Promise<StoreTransition> => {
        const capture = frozen.capture;
        const conversation = await port.getRecord({ conversationId: capture.conversationId, kind: 'conversation', id: capture.conversationId });
        const state = await port.getRecord<ContextStateData>(contextStateKey(capture.conversationId));
        if (!conversation || conversation.value.state !== 'open' || conversation.value.historyEpoch !== capture.historyEpoch
            || state?.value.compressionGeneration !== capture.compressionGeneration
            || state.value.effectiveModelFingerprint !== capture.effectiveModelFingerprint
            || state.value.configFingerprint !== frozen.configFingerprint
            || state.value.candidateId !== null && state.value.candidateId !== capture.candidateId) {
            throw new ContextFault('HISTORY_STALE', '压缩控制等待期间会话、候选或冻结配置已经变化');
        }
        const expected = [...transition.expected];
        const requireRevision = (required: TransitionExpected) => {
            const previous = expected.find(entry => canonicalJson(entry.key) === canonicalJson(required.key));
            if (previous && previous.revision !== required.revision) throw new AgentFault('REVISION_CONFLICT', '压缩控制事务的原版本已经变化', { key: required.key });
            if (!previous) expected.push(required);
        };
        requireRevision({ key: conversation.key, revision: conversation.revision });
        requireRevision({ key: contextStateKey(capture.conversationId), revision: state?.revision ?? null });
        if (capture.execution) {
            const run = await port.getRecord(contextRunKey(capture.conversationId, capture.execution.runId));
            if (conversation.value.activeRunId !== capture.execution.runId || run?.value.runEpoch !== capture.execution.runEpoch
                || contextRootBudgetId(run) !== capture.execution.rootBudgetId) {
                throw new ContextFault('HISTORY_STALE', '压缩控制所属原执行已经结束或更换代次');
            }
            requireRevision({ key: run.key, revision: run.revision });
        }
        if (authorization) requireRevision(authorization);
        return { ...transition, expected };
    };
    const controlStore = new Proxy(options.store, { get(target, property) {
        if (property === 'commitTransition') return async (transition: StoreTransition) => {
            const frozen = controlWrites.getStore();
            if (!frozen) return target.commitTransition(transition);
            const authorization = await options.authorizeControlWrite?.(frozen.capture.conversationId);
            return target.commitTransition(await fenceTransition(target, transition, frozen, authorization));
        };
        if (property === 'mutateState') {
            if (!target.mutateState) return undefined;
            return async <Value>(scope: StateMutationScope, operation: (port: StateMutationPort) => Promise<Value>): Promise<Value> => {
                const frozen = controlWrites.getStore();
                if (!frozen) return target.mutateState!(scope, operation);
                if (scope.conversationId !== frozen.capture.conversationId) throw new ContextFault('HISTORY_STALE', '压缩控制的状态事务须属于原会话');
                const authorization = await options.authorizeControlWrite?.(frozen.capture.conversationId);
                return target.mutateState!(scope, port => operation({ getRecord: port.getRecord.bind(port),
                    commitTransition: async transition => port.commitTransition(await fenceTransition(port, transition, frozen, authorization)) }));
            };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    const compactionPort = new StoreCompactionPort(controlStore, { now, maxCachedConversations: maximumConversations });
    const compressionModel = new ProviderCompressionModelPort(options);
    const sourcePorts = new Map<string, ContextSourcePort>();
    const projectionCache = new ArtifactProjectionCache(options.maxSourceCacheBytes);
    const measurements = new Map<string, ContextPreparedMeasurement>();
    const rememberMeasurement = (conversationId: string, measurement: ContextPreparedMeasurement) => {
        measurements.delete(conversationId);
        measurements.set(conversationId, measurement);
        while (measurements.size > maximumConversations) measurements.delete(measurements.keys().next().value!);
    };
    const sourceFor = (conversationId: string): ContextSourcePort => {
        let source = sourcePorts.get(conversationId);
        if (!source) {
            source = options.sourceForConversation?.(conversationId) ?? createArtifactHistorySourcePort(options.store, { conversationId, cache: projectionCache });
        }
        sourcePorts.delete(conversationId);
        sourcePorts.set(conversationId, source);
        while (sourcePorts.size > maximumConversations) {
            const oldest = sourcePorts.keys().next().value!;
            sourcePorts.delete(oldest);
            projectionCache.releaseConversation(oldest);
        }
        return source;
    };
    const sources: ContextSourcePort = {
        async describe(item, signal) {
            const conversationId = compactionPort.ownerOf(item);
            if (!conversationId) throw new ContextFault('SOURCE_GAP', '来源项目没有会话归属');
            const source = sourceFor(conversationId);
            return (await source.describe(item, signal)).map(block => ({ ...block, retrieval: { ...block.retrieval, contextConversationId: conversationId } }));
        },
        async read(request) {
            const conversationId = request.block.retrieval.contextConversationId;
            if (typeof conversationId !== 'string') throw new ContextFault('SOURCE_GAP', '来源块缺少会话归属');
            return sourceFor(conversationId).read(request);
        },
        releaseCached(blocks) {
            for (const [conversationId, source] of sourcePorts) source.releaseCached?.(blocks.filter(block => block.retrieval.contextConversationId === conversationId));
        },
    };
    const maintenanceOwner = options.maintenanceBudget
        ? createContextMaintenanceCallbacks({ ...options.maintenanceBudget, ledger: options.provider.ledger }) : options.maintenance;
    const maintenance: MaintenanceCallbacks | undefined = maintenanceOwner ? {
        async createRun(input) {
            return maintenanceOwner.createRun(input);
        },
        async prepareRun(input) {
            const selected = await maintenanceOwner.prepareRun?.(input) ?? input.config;
            const root = await options.provider.ledger.read(input.execution.rootBudgetId);
            if (!root.budget.quotaLimitId || !root.quotaLimit) throw new ContextFault('CONFIG_INVALID', '维护压缩根任务需要全局费用上限');
            const maxOutputTokens = Math.min(selected.model.maxOutputTokens, root.budget.maxOutputTokens);
            const model = { ...selected.model, maxOutputTokens, parameters: { ...selected.model.parameters, maxOutputTokens } };
            const config = freezeCompressionConfig({ currentModel: model,
                ...(selected.modelSource === 'global' ? { globalModel: model } : selected.modelSource === 'conversation' ? { conversationModel: model } : {}),
                policy: selected.policy, revision: selected.revision, rules: selected.rules });
            await compactionPort.bindExecution(input.execution, config);
            return config;
        },
        finishRun: input => maintenanceOwner.finishRun(input),
    } : undefined;
    const service = new ContextService({ compaction: { port: compactionPort, sources, model: compressionModel, maintenance, now,
        maxCachedConversations: maximumConversations }, policy: options.policy, readVersionState: async conversationId => {
            const record = await options.store.getRecord({ conversationId, kind: 'conversation', id: conversationId });
            const historyEpoch = record?.value.historyEpoch;
            const appendSeq = record?.value.appendSeq;
            const viewRevision = record?.value.viewRevision;
            if (typeof historyEpoch !== 'number' || !Number.isSafeInteger(historyEpoch) || historyEpoch < 1
                || typeof appendSeq !== 'number' || !Number.isSafeInteger(appendSeq) || appendSeq < 0
                || typeof viewRevision !== 'number' || !Number.isSafeInteger(viewRevision) || viewRevision < 0) return undefined;
            return { historyEpoch, appendSeq, viewRevision };
        } });

    const makeSelection = async (plan: Pick<ExecutionPlan, 'profile' | 'modelId' | 'parameters'>, selected: CompressionSelection, rootMaximum: number): Promise<CompressionModelSelection> => {
        const profileId = selected.profileId ?? plan.profile.profileId;
        const profile = await options.provider.profiles.get(profileId);
        if (!profile) throw new ContextFault('MODEL_STALE', '压缩API配置不可用');
        const { entry } = await options.provider.models.get(profileId, selected.modelId, selected.routeId ?? null);
        if (entry.contextWindow.value === null) throw new ContextFault('CONFIG_INVALID', '压缩模型需要可核实的窗口');
        const maxOutputTokens = resolveRuntimeOutputBudget(entry, profile, Math.min(selected.maxOutputTokens ?? 2048, rootMaximum), now());
        const parameters: JsonObject = { ...(profileId === plan.profile.profileId && selected.modelId === plan.modelId ? plan.parameters : {}),
            ...selected.parameters, maxOutputTokens };
        if (Array.isArray(parameters.responseModalities)) parameters.responseModalities = ['TEXT'];
        const adapter = options.provider.adapterFor(profile.protocol);
        return { profileId, provider: profileId, endpoint: adapter.endpoint(profile, selected.modelId), model: selected.modelId,
            protocol: profile.protocol, adapterVersion: adapter.version, capabilityVersion: hashContext(entry), profileRevision: profile.revision,
            routing: profile.routePolicy as unknown as JsonObject, parameters, accountFingerprint: hashContext({ quotaScopeId: profile.quotaScopeId,
                credentialRef: profile.credentialRef, credentialGeneration: profile.credentialGeneration }), credentialRef: profile.credentialRef,
            credentialGeneration: profile.credentialGeneration, contextWindow: entry.contextWindow.value, maxOutputTokens };
    };

    const bind = async (context: ExecutorContext, plan: ExecutionPlan) => {
        const run = await options.store.getRecord(contextRunKey(context.snapshot.conversationId, context.snapshot.runId));
        if (!run || run.value.runEpoch !== context.snapshot.runEpoch) throw new ContextFault('HISTORY_STALE', 'Context绑定的Runtime执行已改变');
        const rootBudgetId = contextRootBudgetId(run);
        if (plan.rootBudgetId !== rootBudgetId) throw new ContextFault('CONFIG_INVALID', 'ExecutionPlan根预算须采用Runtime持久rootRunId',
            { rootRunId: rootBudgetId, planRootBudgetId: plan.rootBudgetId });
        const root = await options.provider.ledger.read(rootBudgetId);
        if (!root.budget.quotaLimitId || !root.quotaLimit) throw new ContextFault('CONFIG_INVALID', '压缩必须复用当前根任务的全局费用上限');
        const resolved = await options.resolveSelection?.(context, plan);
        const local = resolved && Object.hasOwn(resolved, 'conversation') ? resolved.conversation
            : selectionFromOptions(context.conversationOptions.compressionModelSelection ?? context.conversationOptions.compressionModel);
        const globalSelection = resolved && Object.hasOwn(resolved, 'global') ? resolved.global
            : (plan.profile.compressionModelRef ? { modelId: plan.profile.compressionModelRef } : null);
        const maximum = root.budget.maxOutputTokens;
        const selectedModel = await makeSelection(plan, local ?? globalSelection ?? { profileId: plan.profile.profileId, modelId: plan.modelId }, maximum);
        const config = freezeCompressionConfig({ currentModel: selectedModel,
            ...(local ? { conversationModel: selectedModel } : globalSelection ? { globalModel: selectedModel } : {}),
            policy: { ...options.policy, ...(context.conversationOptions.contextPolicy as Partial<ContextPolicy> | undefined), ...resolved?.policy },
            revision: resolved?.revision ?? plan.profile.revision, rules: resolved?.rules ?? options.rules });
        const execution: ExecutionLease = { kind: context.snapshot.kind, conversationId: context.snapshot.conversationId,
            runId: context.snapshot.runId, runEpoch: context.snapshot.runEpoch, rootBudgetId,
            roundId: context.snapshot.activeRoundId, stepId: context.snapshot.activeStepId ?? context.snapshot.runId, deadlineAt: plan.deadlineAt };
        await compactionPort.bindExecution(execution, config);
        const { entry } = await options.provider.models.get(plan.profile.profileId, plan.modelId);
        if (entry.contextWindow.value === null) throw new ContextFault('CONFIG_INVALID', '前台模型缺少窗口上界');
        const limits = computeConversationContextLimits(entry.contextWindow.value, plan.maxOutputTokens, config.policy);
        const capture = await compactionPort.inspect(context.snapshot.conversationId);
        return { config, execution, limits, stepSeq: capture.stepSeq };
    };

    const prepareView = service.createPrepareView(async (context, plan, input) => {
        const binding = await bind(context, plan);
        const overrides = await options.resolveView?.(context, plan, input) ?? {};
        return { ...overrides, readTailReuse: 'consume', policy: binding.config.policy,
            resolveHistoricalToolResults: overrides.resolveHistoricalToolResults ?? createHistoricalToolResultResolver(options.store),
            readItem: overrides.readItem ?? ((item, bounds) => item.value !== undefined ? Promise.resolve(item.value) : readHistoryArtifact(options.store,
                { conversationId: context.snapshot.conversationId, item, maxReadBytes: bounds.maxReadBytes, signal: bounds.signal })),
            compression: binding, baseView: { ...(overrides.baseView ?? { protocol: plan.adapter.protocol }), ...(input?.tools ? { tools: input.tools } : {}) } };
    }, (built, details) => {
        const conversationId = details.conversationId;
        if (details.configFingerprint && built.estimate.confidence !== 'unknown') rememberMeasurement(conversationId,
            { ...built.history, configFingerprint: details.configFingerprint, viewHash: hashContext(built.view), modelId: details.modelId,
                inputTokens: totalContextTokens(built.estimate), confidence: built.estimate.confidence, basis: details.estimateBasis,
                ...(built.estimate.tokenCountEvidence ? { tokenCountEvidence: built.estimate.tokenCountEvidence } : {}) });
        else measurements.delete(conversationId);
    });

    const postStep = async (context: ExecutorContext, plan: ExecutionPlan, input?: ContextExecutionViewInput) => {
        const binding = await bind(context, plan);
        const overrides = await options.resolveView?.(context, plan, input) ?? {};
        try {
            const viewInput = { ...overrides, readTailReuse: 'offer' as const, conversationId: context.snapshot.conversationId, context, adapter: plan.adapter,
                resolveHistoricalToolResults: overrides.resolveHistoricalToolResults ?? createHistoricalToolResultResolver(options.store),
                readItem: overrides.readItem ?? ((item, bounds) => item.value !== undefined ? Promise.resolve(item.value) : readHistoryArtifact(options.store,
                    { conversationId: context.snapshot.conversationId, item, maxReadBytes: bounds.maxReadBytes, signal: bounds.signal })),
                modelId: plan.modelId, parameters: plan.parameters,
                baseView: { ...(overrides.baseView ?? { protocol: plan.adapter.protocol }), ...(input?.tools ? { tools: input.tools } : {}) } };
            const built = await service.buildView(viewInput);
            if (built.estimate.confidence !== 'unknown') rememberMeasurement(context.snapshot.conversationId,
                { ...built.history, configFingerprint: binding.config.configFingerprint, viewHash: hashContext(built.view), modelId: plan.modelId,
                    inputTokens: totalContextTokens(built.estimate), confidence: built.estimate.confidence,
                    basis: built.estimate.tokenCountEvidence ? 'provider_native_count_tokens' : overrides.estimateView ? 'injected_estimator' : 'native_view_utf8_upper_bound',
                    ...(built.estimate.tokenCountEvidence ? { tokenCountEvidence: built.estimate.tokenCountEvidence } : {}) });
            else measurements.delete(context.snapshot.conversationId);
            return service.postStep({ ...binding, conversationId: context.snapshot.conversationId, estimate: built.estimate,
                estimateCompaction: service.createCompactionEstimator(viewInput, binding.execution) });
        } catch (error) {
            if (error instanceof AgentFault && error.code === 'CONTEXT_NATIVE_PAIRING') return { backgroundCandidateId: null };
            throw error;
        }
    };

    const finishExecution = async (context: ExecutorContext): Promise<ContextExecutionCleanup> => {
        try {
            const capture = await compactionPort.inspect(context.snapshot.conversationId);
            const execution = capture.execution ?? await compactionPort.readExecutionForCleanup(context.snapshot.conversationId);
            if (!execution || execution.runId !== context.snapshot.runId || execution.runEpoch !== context.snapshot.runEpoch) {
                return { state: 'not_needed', candidateId: null };
            }
            const conversation = await options.store.getRecord({ conversationId: context.snapshot.conversationId,
                kind: 'conversation', id: context.snapshot.conversationId });
            return await service.compactor!.finishExecution(context.snapshot.conversationId, execution, capture.stepSeq,
                { publishReady: !context.signal.aborted && conversation?.value.state === 'open', signal: context.signal });
        }
        finally {
            service.releaseReadTail(context.snapshot.conversationId);
            sourcePorts.delete(context.snapshot.conversationId);
            projectionCache.releaseConversation(context.snapshot.conversationId);
        }
    };

    const releaseConversation = (conversationId: string): boolean => {
        if (!service.compactor!.releaseCachedConversation(conversationId)) return false;
        compactionPort.releaseConversation(conversationId);
        service.releaseReadTail(conversationId);
        sourcePorts.delete(conversationId);
        projectionCache.releaseConversation(conversationId);
        measurements.delete(conversationId);
        return true;
    };
    const cacheSnapshot = () => ({ sourcePorts: sourcePorts.size, sourceBytes: projectionCache.snapshot().bytes,
        indexConversations: compactionPort.cacheSnapshot().conversations, indexItems: compactionPort.cacheSnapshot().items });

    const confirmUnknownCleanup: ContextServerAdapter['confirmUnknownCleanup'] = async input => {
        if (service.compactor!.hasLocalCompaction(input.conversationId)) return false;
        if (!await compactionPort.confirmUnknownExecutionCleanup(input)) return false;
        return releaseConversation(input.conversationId);
    };

    const reconcileCleanup: ContextServerAdapter['reconcileCleanup'] = async input => {
        if (service.compactor!.hasLocalCompaction(input.conversationId)) return false;
        const execution = await compactionPort.readExecutionForCleanup(input.conversationId);
        if (execution && execution.runId !== input.runId) return false;
        if (!releaseConversation(input.conversationId)) return false;
        const result = await compactionPort.reconcileExecutionCleanup(input);
        return result.state !== 'unconfirmed';
    };

    const controls = createContextServerControls({ port: compactionPort, service, model: compressionModel, now, readMeasurement: conversationId => measurements.get(conversationId),
        async withControl(capture, operation, configFingerprint) {
            const state = await options.store.getRecord<ContextStateData>(contextStateKey(capture.conversationId));
            return controlWrites.run({ capture: structuredClone(capture), configFingerprint: configFingerprint ?? state?.value.configFingerprint ?? null }, operation);
        },
        async resolveConfiguration(conversationId, budget) {
            const conversation = await options.store.getRecord({ conversationId, kind: 'conversation', id: conversationId });
            if (!conversation) throw new ContextFault('HISTORY_STALE', '上下文状态所属会话不存在');
            const capture = await compactionPort.inspect(conversationId);
            const run = capture.execution ? await options.store.getRecord(contextRunKey(conversationId, capture.execution.runId)) : undefined;
            const selectedOptions = { ...(conversation.value.options as Record<string, unknown> | undefined), ...(run?.value.options as Record<string, unknown> | undefined) };
            if (typeof selectedOptions.profileId !== 'string') return null;
            const profile = await options.provider.profiles.get(selectedOptions.profileId) as ProviderProfile | undefined;
            if (!profile) throw new ContextFault('MODEL_STALE', '当前会话API配置不可用');
            const modelId = typeof selectedOptions.modelId === 'string' ? selectedOptions.modelId : profile.defaultModel;
            if (!modelId) return null;
            const { entry } = await options.provider.models.get(profile.profileId, modelId);
            if (entry.contextWindow.value === null) throw new ContextFault('CONFIG_INVALID', '当前模型需要可核实的窗口');
            const parameters = selectedOptions.parameters && typeof selectedOptions.parameters === 'object' ? selectedOptions.parameters as JsonObject : {};
            const root = capture.execution ? await options.provider.ledger.read(contextRootBudgetId(run!)) : null;
            const requestedMaximum = root?.budget.maxOutputTokens ?? budget?.maxOutputTokens ?? parameters.maxOutputTokens
                ?? (entry.maxOutputTokens.value === null ? null : Math.min(4096, entry.maxOutputTokens.value));
            if (!Number.isSafeInteger(requestedMaximum) || Number(requestedMaximum) < 1) throw new ContextFault('CONFIG_INVALID', '手动压缩最大输出须为正安全整数');
            const maximum = Number(requestedMaximum);
            const current = { profile, modelId, parameters };
            const local = selectionFromOptions(selectedOptions.compressionModelSelection ?? selectedOptions.compressionModel);
            const frozen = capture.execution ? await compactionPort.readConfig(conversationId) : null;
            const globalSelection = profile.compressionModelRef ? { modelId: profile.compressionModelRef } : null;
            const selectedModel = frozen ? null : await makeSelection(current, local ?? globalSelection ?? { profileId: profile.profileId, modelId }, maximum);
            const config = frozen ?? freezeCompressionConfig({ currentModel: selectedModel!,
                ...(local ? { conversationModel: selectedModel! } : globalSelection ? { globalModel: selectedModel! } : {}),
                policy: { ...options.policy, ...(selectedOptions.contextPolicy as Partial<ContextPolicy> | undefined) },
                revision: profile.revision, rules: options.rules });
            return { config, limits: computeConversationContextLimits(entry.contextWindow.value, maximum, config.policy) };
        } });

    const readPreparedEstimate = (input: { conversationId: string; view: NativeSendView; modelId: string }): ContextPreparedMeasurement | null => {
        const measurement = measurements.get(input.conversationId);
        if (!measurement || measurement.modelId !== input.modelId || measurement.viewHash !== hashContext(input.view)) return null;
        return structuredClone(measurement);
    };

    return { service, prepareView, postStep, bind, finishExecution, reconcileCleanup, confirmUnknownCleanup, releaseConversation, cacheSnapshot, readPreparedEstimate, compactionPort, compressionModel, ...controls };
}
