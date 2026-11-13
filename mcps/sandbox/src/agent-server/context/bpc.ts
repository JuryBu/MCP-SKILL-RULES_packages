import { randomUUID } from 'node:crypto';
import type { ReceiptKey } from '../storage/port.js';
import { AgentFault } from '../protocol.js';
import type { JsonObject } from '../protocol.js';
import type { CompactionCandidate, CompactionPort, CompactionReason, CompactionViewEstimator, ContextCapture, ContextEstimate, ContextLimits, ContextSourcePort,
    ExecutionLease, FrozenCompressionConfig, MaintenanceCallbacks, Publication, SchedulerCheckpoint, TokenCounter, CompressionModelPort, SummaryView } from './contracts.js';
import { backgroundTriggerTokens, checkContextGate, totalContextTokens } from './budget.js';
import { freezeValue, hashContext } from './config.js';
import { contextFailure, ContextFault } from './errors.js';
import { factsOnlyCompressionResult, generateCompaction, prepareCompaction, previewCompaction, fitCompactionSummary, validateCompressionResult, verifyManifestSources } from './compaction.js';
import type { CompactionPreview } from './compaction.js';
import { createSourceManifest, readSelectedHistory } from './rounds.js';
import { sealPublishedSummaryView, validatePublication } from './view.js';
import { applyPublishedHistoryFeedback } from './feedback.js';
import { captureCompletedFragments } from './completed-fragments.js';

interface ActiveCompaction {
    candidate: CompactionCandidate;
    abort: AbortController;
    completion: Promise<CompactionCandidate>;
    settled: boolean;
    estimateCompaction?: CompactionViewEstimator;
}

export interface CompactionHandle {
    candidateId: string;
    execution: ExecutionLease;
    completion: Promise<CompactionCandidate>;
}

export interface ContextExecutionCleanup {
    state: 'not_needed' | 'released' | 'unconfirmed';
    candidateId: string | null;
}

const emptyCheckpoint = (): SchedulerCheckpoint => ({ state: 'idle', cooldownUntil: null, lastPublishStep: null,
    immediateRetriggers: 0, lastFailure: null, lastPublishRevision: null, lastRetriggeredRevision: null });

export class ContextCompactor {
    private readonly active = new Map<string, ActiveCompaction>();
    private readonly starting = new Map<string, { abort: AbortController; config: FrozenCompressionConfig; execution: ExecutionLease; settled: Promise<void> }>();
    private readonly recovering = new Set<string>();
    private readonly checkpoints = new Map<string, SchedulerCheckpoint>();
    private readonly finishedMaintenance = new Map<string, { conversationId: string; result: 'published' | 'cancelled' | 'failed' | 'unknown' }>();
    private readonly now: () => number;
    private readonly maxCachedConversations: number;

    constructor(private readonly options: {
        port: CompactionPort;
        sources: ContextSourcePort;
        model: CompressionModelPort;
        maintenance?: MaintenanceCallbacks;
        countTokens?: TokenCounter;
        now?: () => number;
        maxCachedConversations?: number;
    }) {
        this.now = options.now ?? Date.now;
        this.maxCachedConversations = options.maxCachedConversations ?? 16;
        if (!Number.isSafeInteger(this.maxCachedConversations) || this.maxCachedConversations < 1) throw new ContextFault('CONFIG_INVALID', 'Context调度缓存上限须为正安全整数');
    }

    canReleaseCachedConversation(conversationId: string, options: { confirmedUnknownCandidateId?: string } = {}): boolean {
        const active = this.active.get(conversationId);
        const confirmedUnknown = active?.candidate.state === 'unknown'
            && active.candidate.candidateId === options.confirmedUnknownCandidateId;
        if (this.starting.has(conversationId) || this.recovering.has(conversationId)
            || active && (!active.settled || ['snapshotting', 'generating', 'ready', 'publishing'].includes(active.candidate.state)
                || active.candidate.state === 'unknown' && !confirmedUnknown)) return false;
        return true;
    }

    releaseCachedConversation(conversationId: string, options: { confirmedUnknownCandidateId?: string } = {}): boolean {
        if (!this.canReleaseCachedConversation(conversationId, options)) return false;
        this.active.delete(conversationId);
        this.checkpoints.delete(conversationId);
        for (const [runId, owner] of this.finishedMaintenance) if (owner.conversationId === conversationId) this.finishedMaintenance.delete(runId);
        return true;
    }

    hasLocalCompaction(conversationId: string, options: { runningOnly?: boolean } = {}): boolean {
        const active = this.active.get(conversationId);
        return Boolean(active && (!options.runningOnly || !active.settled)) || this.starting.has(conversationId) || this.recovering.has(conversationId);
    }

    private trimIdleCheckpoints(): void {
        for (const conversationId of this.checkpoints.keys()) {
            if (this.checkpoints.size <= this.maxCachedConversations) break;
            if (!this.active.has(conversationId) && !this.starting.has(conversationId)) this.checkpoints.delete(conversationId);
        }
    }

    private async checkpoint(conversationId: string): Promise<SchedulerCheckpoint> {
        let checkpoint = this.checkpoints.get(conversationId);
        if (!checkpoint) {
            checkpoint = await this.options.port.loadScheduler(conversationId) ?? emptyCheckpoint();
            this.checkpoints.set(conversationId, checkpoint);
            this.trimIdleCheckpoints();
        }
        if (checkpoint.state === 'cooldown' && (checkpoint.cooldownUntil ?? 0) <= this.now()) {
            checkpoint.state = 'idle';
            checkpoint.cooldownUntil = null;
            await this.persist(conversationId, checkpoint);
        }
        return checkpoint;
    }

    private async persist(conversationId: string, checkpoint: SchedulerCheckpoint): Promise<void> {
        this.checkpoints.set(conversationId, checkpoint);
        await this.options.port.saveScheduler(conversationId, structuredClone(checkpoint));
        this.trimIdleCheckpoints();
    }

    private receipt(candidate: CompactionCandidate): ReceiptKey {
        return candidate.publicationReceiptKey ?? { principalId: 'sandbox-agent-runtime', clientId: 'context-compactor',
            conversationId: candidate.conversationId, clientCommandId: `publish:${candidate.candidateId}` };
    }

    async context(conversationId: string): Promise<{ capture: ContextCapture; scheduler: SchedulerCheckpoint; candidate: CompactionCandidate | null }> {
        const capture = await this.options.port.inspect(conversationId);
        const candidate = this.active.get(conversationId)?.candidate
            ?? (capture.candidateId ? await this.options.port.getCandidate(conversationId, capture.candidateId) : null);
        return { capture, scheduler: structuredClone(await this.checkpoint(conversationId)), candidate: candidate ? structuredClone(candidate) : null };
    }

    async preview(conversationId: string, config: FrozenCompressionConfig): Promise<CompactionPreview> {
        return previewCompaction(await captureCompletedFragments(this.options.port, await this.options.port.inspect(conversationId), config.policy), config);
    }

    async readView(conversationId: string, input?: { policy: import('./contracts.js').ContextPolicy; signal?: AbortSignal }): Promise<SummaryView> {
        if (input && this.options.port.ensureCommunicationWindow) return this.options.port.ensureCommunicationWindow({ conversationId, ...input });
        return (await this.options.port.inspect(conversationId)).view;
    }

    async start(input: { conversationId: string; config: FrozenCompressionConfig; execution: ExecutionLease; reason: CompactionReason;
        limits?: ContextLimits; estimateCompaction?: CompactionViewEstimator }): Promise<CompactionHandle> {
        if (this.active.has(input.conversationId) || this.starting.has(input.conversationId) || this.recovering.has(input.conversationId)) throw new ContextFault('COMPACTION_BUSY', '会话已有压缩所有者');
        const abort = new AbortController();
        let finishStarting: () => void = () => {};
        const settled = new Promise<void>(resolve => { finishStarting = resolve; });
        this.starting.set(input.conversationId, { abort, config: input.config, execution: input.execution, settled });
        try {
            const checkpoint = await this.checkpoint(input.conversationId);
            if (checkpoint.state === 'hardPaused') throw new ContextFault('ATTEMPT_UNKNOWN', '压缩状态需要可信恢复后才能新增请求', { failure: checkpoint.lastFailure });
            if (input.reason === 'background' && checkpoint.state !== 'idle') throw new ContextFault('COMPACTION_PAUSED', '后台压缩处于冷却或熔断状态');
            await this.options.port.ensureCommunicationWindow?.({ conversationId: input.conversationId, policy: input.config.policy, signal: abort.signal });
            const current = await this.options.port.inspect(input.conversationId);
            if (current.candidateId) {
                const candidate = await this.options.port.getCandidate(input.conversationId, current.candidateId);
                if (candidate && ['snapshotting', 'generating', 'ready', 'publishing', 'unknown'].includes(candidate.state)) {
                    throw new ContextFault('COMPACTION_BUSY', '持久状态已有待处理压缩候选', { candidateId: candidate.candidateId });
                }
            }
            const capture = await this.options.port.claim({ conversationId: input.conversationId, expectedHistoryEpoch: current.historyEpoch,
                expectedViewRevision: current.viewRevision, expectedGeneration: current.compressionGeneration,
                compressionGeneration: randomUUID(), execution: input.execution });
            let candidate = await prepareCompaction({ port: this.options.port, sources: this.options.sources, capture,
                config: input.config, execution: input.execution, reason: input.reason, signal: abort.signal, now: this.now() });
            if (input.estimateCompaction && input.limits) {
                const fixed = await input.estimateCompaction(candidate.snapshot, { coveredEndSeq: candidate.snapshot.coveredEndSeq, text: '', tokens: 0 }, abort.signal);
                const fixedInputTokens = totalContextTokens(fixed.estimate);
                const target = Math.min(input.limits.target, input.limits.inputBudget);
                const summaryBudget = Math.min(input.limits.summaryBudget, input.limits.inputBudget - fixedInputTokens - 1);
                if (summaryBudget <= 0) throw new ContextFault('SUMMARY_BUDGET', '保留原文、当前输入及工具schema已占满安全输入预算，摘要模型尚未调用',
                    { fixedInputTokens, target, inputBudget: input.limits.inputBudget, summaryBudget, conversationId: input.conversationId, historyEpoch: candidate.snapshot.historyEpoch,
                        appendSeq: candidate.snapshot.snapshotAppendSeq, nativeViewHash: fixed.nativeViewHash });
                candidate = { ...candidate, snapshot: freezeValue({ ...candidate.snapshot, requestBudget: { target, inputBudget: input.limits.inputBudget, summaryBudget, fixedInputTokens,
                    nativeViewHash: fixed.nativeViewHash, modelId: fixed.modelId, adapterVersion: fixed.adapterVersion } }) };
            }
            if (abort.signal.aborted) throw new ContextFault('CANCELLED', '压缩快照已取消');
            await this.options.port.saveCandidate(structuredClone(candidate));
            if (abort.signal.aborted) {
                await this.options.port.discardCandidate({ conversationId: input.conversationId, candidateId: candidate.candidateId,
                    generation: candidate.snapshot.compressionGeneration, state: 'cancelled' });
                throw new ContextFault('CANCELLED', '压缩快照已取消');
            }
            return this.run(candidate, capture, abort, input.estimateCompaction);
        } finally { this.starting.delete(input.conversationId); finishStarting(); }
    }

    private run(candidate: CompactionCandidate, capture: ContextCapture, abort: AbortController, estimateCompaction?: CompactionViewEstimator): CompactionHandle {
        let settled = false;
        const completion = generateCompaction({ candidate, priorView: capture.view, port: this.options.port, sources: this.options.sources,
            model: this.options.model, signal: abort.signal, countTokens: this.options.countTokens, now: this.now, estimateCompaction }).then(async result => {
            if (abort.signal.aborted || candidate.publicationRevoked || this.active.get(candidate.conversationId)?.candidate !== candidate) return candidate;
            if (result.snapshot.execution.kind === 'maintenance') {
                await this.publish(candidate.conversationId, capture.stepSeq);
                await this.finishMaintenance(candidate, 'published');
            }
            return result;
        }).catch(async error => {
            let failure = error;
            if (!abort.signal.aborted && candidate.reason === 'background' && !candidate.pendingRequest
                && candidate.snapshot.execution.kind !== 'maintenance' && error instanceof ContextFault
                && !error.mayHaveStarted && (error.code === 'CONTEXT_CONFIG_INVALID' || error.code === 'CONTEXT_SUMMARY_BUDGET'
                    || error.code === 'CONTEXT_SOURCE_GAP' && error.details?.knownInvalidDigest === true
                        && candidate.state === 'failed' && candidate.error?.details?.knownInvalidDigest === true)) {
                const checkpoint = await this.checkpoint(candidate.conversationId);
                checkpoint.state = 'circuitBroken';
                checkpoint.lastFailure = contextFailure(error);
                await this.persist(candidate.conversationId, checkpoint);
                if (this.active.get(candidate.conversationId)?.candidate.candidateId === candidate.candidateId) {
                    this.active.delete(candidate.conversationId);
                }
                return candidate;
            }
            if (!abort.signal.aborted && candidate.reason === 'background' && !candidate.pendingRequest
                && error instanceof AgentFault && !error.mayHaveStarted && error.code === 'E_BACKGROUND_BUDGET_DEFERRED'
                && candidate.error?.details?.budgetReservationRejected === true) {
                try {
                    await this.options.port.discardCandidate({ conversationId: candidate.conversationId, candidateId: candidate.candidateId,
                        generation: candidate.snapshot.compressionGeneration, state: 'discarded' });
                    candidate.state = 'discarded';
                    const checkpoint = await this.checkpoint(candidate.conversationId);
                    checkpoint.state = 'idle';
                    checkpoint.lastFailure = candidate.error;
                    await this.persist(candidate.conversationId, checkpoint);
                    if (this.active.get(candidate.conversationId)?.candidate.candidateId === candidate.candidateId) {
                        this.active.delete(candidate.conversationId);
                    }
                    return candidate;
                } catch {
                    failure = new ContextFault('COMMIT_UNKNOWN', '后台预算延期的候选收尾尚未确认',
                        { candidateId: candidate.candidateId, budgetDeferralCleanup: true }, true);
                    candidate.state = 'unknown';
                    candidate.error = contextFailure(failure);
                    await this.options.port.saveCandidate(structuredClone(candidate)).catch(() => {});
                }
            }
            if (!abort.signal.aborted) {
                const checkpoint = await this.checkpoint(candidate.conversationId);
                checkpoint.lastFailure = contextFailure(failure);
                checkpoint.state = 'hardPaused';
                await this.persist(candidate.conversationId, checkpoint);
                if (candidate.snapshot.execution.kind === 'maintenance') await this.finishMaintenance(candidate,
                    candidate.state === 'unknown' ? 'unknown' : 'failed');
            }
            throw failure;
        }).finally(() => { settled = true; });
        this.active.set(candidate.conversationId, { candidate, abort, completion, estimateCompaction, get settled() { return settled; } });
        void completion.catch(() => {});
        return { candidateId: candidate.candidateId, execution: candidate.snapshot.execution, completion };
    }

    private async finishMaintenance(candidate: CompactionCandidate, result: 'published' | 'cancelled' | 'failed' | 'unknown'): Promise<void> {
        const previous = this.finishedMaintenance.get(candidate.snapshot.runId);
        if (candidate.snapshot.execution.kind !== 'maintenance' || previous && (previous.result !== 'unknown' || result === 'unknown')) return;
        if (!this.options.maintenance) throw new ContextFault('CONFIG_INVALID', '维护run缺少结束与清理回调');
        await this.options.maintenance.finishRun({ execution: candidate.snapshot.execution, result, ...(candidate.error ? { failure: candidate.error } : {}) });
        this.finishedMaintenance.set(candidate.snapshot.runId, { conversationId: candidate.conversationId, result });
        while (this.finishedMaintenance.size > this.maxCachedConversations * 4) this.finishedMaintenance.delete(this.finishedMaintenance.keys().next().value!);
    }

    async manual(input: { conversationId: string; config: FrozenCompressionConfig; budget?: JsonObject; operationId?: string }): Promise<{ preview: CompactionPreview; handle: CompactionHandle | null }> {
        const capture = await captureCompletedFragments(this.options.port, await this.options.port.inspect(input.conversationId), input.config.policy);
        const preview = previewCompaction(capture, input.config);
        if (!preview.roundIds.length) return { preview, handle: null };
        let execution = capture.execution;
        if (!execution) {
            if (!this.options.maintenance) throw new ContextFault('BUDGET_REQUIRED', '空闲压缩需要维护run及独立根预算，预览已保留', { preview });
            try { execution = await this.options.maintenance.createRun({ conversationId: input.conversationId, config: input.config,
                ...(input.budget ? { budget: input.budget } : {}), ...(input.operationId ? { operationId: input.operationId } : {}) }); }
            catch (error) {
                if (error instanceof Error && 'code' in error && error.code === 'BUDGET_REQUIRED') throw new ContextFault('BUDGET_REQUIRED', error.message, { preview });
                throw error;
            }
        }
        try {
            if (capture.execution === null && (execution.kind !== 'maintenance' || execution.roundId !== null)) {
                throw new ContextFault('CONFIG_INVALID', '空闲压缩回调须创建无人工轮的维护run');
            }
            const config = execution.kind === 'maintenance' && this.options.maintenance?.prepareRun
                ? await this.options.maintenance.prepareRun({ execution, config: input.config }) : input.config;
            return { preview, handle: await this.start({ conversationId: input.conversationId, config, execution, reason: 'manual' }) };
        }
        catch (error) {
            if (capture.execution === null && execution.kind === 'maintenance' && this.options.maintenance) {
                const failure = contextFailure(error);
                await this.options.maintenance.finishRun({ execution,
                    result: failure.code === 'CONTEXT_CANCELLED' ? 'cancelled' : 'failed', failure });
            }
            throw error;
        }
    }

    async publish(conversationId: string, stepSeq: number, receiptKey?: ReceiptKey, estimateCompaction?: CompactionViewEstimator): Promise<Publication | null> {
        const active = this.active.get(conversationId);
        const capture = await this.options.port.inspect(conversationId);
        const candidate = active?.candidate ?? (capture.candidateId ? await this.options.port.getCandidate(conversationId, capture.candidateId) : null);
        if (!candidate) return null;
        if (candidate.state === 'published') return this.options.port.getPublication(this.receipt(candidate));
        if (candidate.publicationRevoked) return null;
        if (candidate.state !== 'ready') return null;
        if (receiptKey && receiptKey.conversationId !== conversationId) throw new ContextFault('CONFIG_INVALID', '发布回执必须属于当前会话');
        await verifyManifestSources(candidate.snapshot.manifest, this.options.sources, candidate.snapshot.config.policy.readFrameBytes, active?.abort.signal);
        validatePublication(candidate, capture, candidate.snapshot.manifest.prefixHash);
        if (!candidate.coverage?.completeRoundIds.length || !candidate.nextView || !candidate.batch
            || candidate.nextView.coveredEndSeq !== candidate.coverage.coveredEndSeq || candidate.batch.lastSeq !== candidate.coverage.coveredEndSeq) {
            throw new ContextFault('SOURCE_GAP', '候选尚未形成真实连续覆盖视图');
        }
        if (candidate.snapshot.requestBudget) {
            const estimator = estimateCompaction ?? active?.estimateCompaction;
            if (!estimator) throw new ContextFault('CONFIG_INVALID', '带原生请求预算的候选发布需要当前只读完整请求估计');
            const fitted = await fitCompactionSummary({ snapshot: candidate.snapshot, nodes: candidate.nextView.nodes,
                coveredEndSeq: candidate.nextView.coveredEndSeq, countTokens: this.options.countTokens,
                summaryBudget: candidate.nextView.summaryBudget, estimateCompaction: estimator, signal: active?.abort.signal,
                communicationWindow: candidate.nextView.communicationWindow });
            candidate.nextView = freezeValue({ ...candidate.nextView, summaryBudget: fitted.budget, renderedLevels: fitted.rendered.levels,
                ...(fitted.rendered.communicationRendering ? { communicationRendering: fitted.rendered.communicationRendering } : {}),
                ...(fitted.fitEvidence ? { fitEvidence: fitted.fitEvidence } : {}) });
        }
        const feedback = await this.options.port.readHistoryFeedback?.({ conversationId, historyEpoch: candidate.snapshot.historyEpoch,
            nodes: candidate.nextView.nodes });
        candidate.nextView = sealPublishedSummaryView(feedback ? applyPublishedHistoryFeedback(candidate.nextView, feedback, stepSeq) : candidate.nextView,
            candidate.snapshot.config.policy, candidate.nextView.summaryBudget, this.options.countTokens);
        candidate.publicationReceiptKey = receiptKey ?? this.receipt(candidate);
        await this.options.port.saveCandidate(structuredClone(candidate));
        const ready = structuredClone(candidate);
        candidate.state = 'publishing';
        let publication: Publication;
        try { publication = await this.options.port.publishCandidate({ candidate: ready, receiptKey: this.receipt(candidate) }); }
        catch (error) {
            if (error instanceof AgentFault && !error.mayHaveStarted) {
                if (active?.abort.signal.aborted) {
                    await this.options.port.discardCandidate({ conversationId, candidateId: candidate.candidateId,
                        generation: candidate.snapshot.compressionGeneration, state: 'cancelled' });
                    candidate.state = 'cancelled';
                    const cancelled = await this.checkpoint(conversationId);
                    cancelled.state = (cancelled.cooldownUntil ?? 0) > this.now() ? 'cooldown' : 'idle';
                    cancelled.lastFailure = null;
                    await this.persist(conversationId, cancelled);
                    this.active.delete(conversationId);
                    throw new ContextFault('CANCELLED', '候选在发布提交前已取消');
                }
                candidate.state = 'ready';
                if (['CONTEXT_HISTORY_STALE', 'CONTEXT_PARENT_STALE', 'CONTEXT_MODEL_STALE'].includes(error.code)) this.active.delete(conversationId);
                throw error;
            }
            const known = await this.options.port.getPublication(this.receipt(candidate)).catch(() => null);
            if (known) publication = known;
            else {
                candidate.state = 'unknown';
                candidate.error = { code: 'CONTEXT_COMMIT_UNKNOWN', message: '发布尚未取得原事务回执，需要查询后恢复', mayHaveStarted: true,
                    details: { cause: contextFailure(error), receiptKey: this.receipt(candidate) } };
                await this.options.port.saveCandidate(structuredClone(candidate));
                const checkpoint = await this.checkpoint(conversationId);
                checkpoint.state = 'hardPaused';
                checkpoint.lastFailure = candidate.error;
                await this.persist(conversationId, checkpoint);
                throw new ContextFault('COMMIT_UNKNOWN', candidate.error.message, candidate.error.details, true);
            }
        }
        candidate.state = 'published';
        candidate.publishedViewRevision = publication.viewRevision;
        const checkpoint = await this.checkpoint(conversationId);
        checkpoint.lastPublishStep = stepSeq;
        checkpoint.lastPublishRevision = publication.viewRevision;
        if (checkpoint.state === 'hardPaused' && ['CONTEXT_ATTEMPT_UNKNOWN', 'CONTEXT_COMMIT_UNKNOWN'].includes(checkpoint.lastFailure?.code ?? '')) {
            checkpoint.state = (checkpoint.cooldownUntil ?? 0) > this.now() ? 'cooldown' : 'idle';
        }
        checkpoint.lastFailure = null;
        await this.persist(conversationId, checkpoint);
        if (active?.candidate.candidateId === candidate.candidateId) this.active.delete(conversationId);
        this.options.sources.releaseCached?.([...candidate.snapshot.manifest.blocks, ...candidate.snapshot.referenceBlocks]);
        return publication;
    }

    async cancel(conversationId: string, options: { human?: boolean } = {}): Promise<{ state: 'cancelled' | 'unknown' | 'idle'; cooldownUntil: number | null }> {
        const capture = await this.options.port.inspect(conversationId);
        const active = this.active.get(conversationId);
        const candidate = active?.candidate ?? (capture.candidateId ? await this.options.port.getCandidate(conversationId, capture.candidateId) : null);
        const checkpoint = await this.checkpoint(conversationId);
        if (!candidate || ['published', 'discarded', 'cancelled'].includes(candidate.state)) {
            const starting = this.starting.get(conversationId);
            if (!starting) return { state: 'idle', cooldownUntil: checkpoint.cooldownUntil };
            starting.abort.abort();
            if (options.human ?? true) {
                checkpoint.state = 'cooldown';
                checkpoint.cooldownUntil = this.now() + starting.config.policy.cooldownMs;
                await this.persist(conversationId, checkpoint);
            }
            return { state: 'cancelled', cooldownUntil: checkpoint.cooldownUntil };
        }
        this.starting.get(conversationId)?.abort.abort();
        candidate.publicationRevoked ??= { reason: 'cancelled', revokedAt: new Date(this.now()).toISOString(),
            pendingAttemptId: candidate.pendingRequest?.attemptId ?? null };
        active?.abort.abort();
        this.options.sources.releaseCached?.([...candidate.snapshot.manifest.blocks, ...candidate.snapshot.referenceBlocks]);
        if (options.human ?? true) checkpoint.cooldownUntil = this.now() + candidate.snapshot.config.policy.cooldownMs;
        let confirmation: 'cancelled' | 'completed' | 'unknown' = 'cancelled';
        if (candidate.pendingRequest) confirmation = await this.options.model.cancel(candidate.pendingRequest).catch(() => 'unknown' as const);
        if (confirmation === 'unknown' || candidate.state === 'publishing' || (candidate.state === 'unknown' && !candidate.pendingRequest)) {
            const originalFailure = candidate.state === 'unknown' ? candidate.error : null;
            candidate.state = 'unknown';
            const cancellation = { code: 'CONTEXT_ATTEMPT_UNKNOWN', message: '取消回执或原发布结果尚未查明', mayHaveStarted: true,
                ...(candidate.pendingRequest ? { attemptId: candidate.pendingRequest.attemptId } : {}) };
            candidate.error = originalFailure ? { ...originalFailure, mayHaveStarted: true,
                details: { ...originalFailure.details, cancellation } } : cancellation;
            await this.options.port.saveCandidate(structuredClone(candidate));
            checkpoint.state = 'hardPaused';
            checkpoint.lastFailure = candidate.error;
            await this.persist(conversationId, checkpoint);
            await this.finishMaintenance(candidate, 'unknown');
            return { state: 'unknown', cooldownUntil: checkpoint.cooldownUntil };
        }
        candidate.state = 'cancelled';
        await this.options.port.discardCandidate({ conversationId, candidateId: candidate.candidateId,
            generation: candidate.snapshot.compressionGeneration, state: 'cancelled' });
        if (options.human ?? true) {
            checkpoint.state = 'cooldown';
            checkpoint.cooldownUntil = this.now() + candidate.snapshot.config.policy.cooldownMs;
        }
        await this.persist(conversationId, checkpoint);
        this.active.delete(conversationId);
        await this.finishMaintenance(candidate, 'cancelled');
        return { state: 'cancelled', cooldownUntil: checkpoint.cooldownUntil };
    }

    async restart(conversationId: string): Promise<void> {
        const checkpoint = await this.checkpoint(conversationId);
        const failure = checkpoint.lastFailure;
        const quotaText = failure ? JSON.stringify({ code: failure.code, details: failure.details }) : '';
        if (/QUOTA|CREDIT|INSUFFICIENT_BALANCE|PAYMENT|BILLING|insufficient_quota|quota_exceeded|"httpStatus":402/i.test(quotaText)) {
            throw new ContextFault('MODEL_REQUESTS_STOPPED', '额度错误已停止本窗口新增模型请求，保留原错误和预算状态', { failure });
        }
        const capture = await this.options.port.inspect(conversationId);
        const active = this.active.get(conversationId);
        const candidate = active?.candidate ?? (capture.candidateId ? await this.options.port.getCandidate(conversationId, capture.candidateId) : null);
        if (candidate && ['snapshotting', 'generating', 'ready', 'publishing', 'unknown'].includes(candidate.state)) {
            throw new ContextFault(candidate.state === 'unknown' ? 'ATTEMPT_UNKNOWN' : 'COMPACTION_BUSY', '先核实或取消原候选，再重启压缩');
        }
        this.active.delete(conversationId);
        await this.persist(conversationId, emptyCheckpoint());
    }

    async invalidate(conversationId: string, reason: NonNullable<CompactionCandidate['publicationRevoked']>['reason']): Promise<CompactionCandidate | null> {
        this.starting.get(conversationId)?.abort.abort();
        const capture = await this.options.port.inspect(conversationId);
        const active = this.active.get(conversationId);
        const candidate = active?.candidate ?? (capture.candidateId ? await this.options.port.getCandidate(conversationId, capture.candidateId) : null);
        if (!candidate || ['published', 'cancelled', 'discarded'].includes(candidate.state)) return candidate;
        if (candidate.state === 'publishing') throw new ContextFault('COMMIT_UNKNOWN', '先核原发布回执，再撤销候选发布资格', undefined, true);
        candidate.publicationRevoked ??= { reason, revokedAt: new Date(this.now()).toISOString(), pendingAttemptId: candidate.pendingRequest?.attemptId ?? null };
        active?.abort.abort();
        if (candidate.pendingRequest) {
            await this.options.model.cancel(candidate.pendingRequest).catch(() => 'unknown');
            candidate.state = 'unknown';
            candidate.error = { code: 'CONTEXT_ATTEMPT_UNKNOWN', message: '候选发布资格已撤销；原attempt费用与结果沿原身份继续核对',
                mayHaveStarted: true, attemptId: candidate.pendingRequest.attemptId };
            if (!this.options.port.revokeCandidatePublication) {
                await this.options.port.saveCandidate(structuredClone(candidate));
                throw new ContextFault('ATTEMPT_UNKNOWN', '存储尚未接入保留原费用未知的发布资格撤销事务', { candidateId: candidate.candidateId }, true);
            }
        } else candidate.state = 'discarded';
        if (this.options.port.revokeCandidatePublication) await this.options.port.revokeCandidatePublication(structuredClone(candidate));
        else await this.options.port.discardCandidate({ conversationId, candidateId: candidate.candidateId,
            generation: candidate.snapshot.compressionGeneration, state: 'discarded' });
        if (this.active.get(conversationId) === active) this.active.delete(conversationId);
        this.options.sources.releaseCached?.([...candidate.snapshot.manifest.blocks, ...candidate.snapshot.referenceBlocks]);
        return structuredClone(candidate);
    }

    async beforeRequest(input: { conversationId: string; execution: ExecutionLease; config: FrozenCompressionConfig;
        stepSeq: number; limits: ContextLimits; estimateCompaction?: CompactionViewEstimator;
        estimate(): Promise<ContextEstimate> }): Promise<{ estimate: ContextEstimate; inputTokens: number; backgroundCandidateId: string | null }> {
        let checkpoint = await this.checkpoint(input.conversationId);
        if (checkpoint.state === 'hardPaused' && checkpoint.lastFailure?.code === 'CONTEXT_CONFIG_INVALID'
            && !checkpoint.lastFailure.mayHaveStarted) {
            const capture = await this.options.port.inspect(input.conversationId);
            const candidate = capture.candidateId ? await this.options.port.getCandidate(input.conversationId, capture.candidateId) : null;
            if (candidate?.state === 'failed' && !candidate.pendingRequest
                && candidate.error?.code === 'CONTEXT_CONFIG_INVALID' && !candidate.error.mayHaveStarted) {
                checkpoint.state = 'circuitBroken';
                await this.persist(input.conversationId, checkpoint);
                if (this.active.get(input.conversationId)?.candidate.candidateId === candidate.candidateId) this.active.delete(input.conversationId);
            }
        }
        if (checkpoint.state === 'hardPaused') {
            const failure = checkpoint.lastFailure;
            if (failure?.code === 'CONTEXT_SUMMARY_BUDGET' && !failure.mayHaveStarted) {
                throw new ContextFault('SUMMARY_BUDGET', failure.message, failure.details);
            }
            if (failure?.details?.budgetReservationRejected === true && !failure.mayHaveStarted
                && ['E_BUDGET_EXCEEDED', 'E_GLOBAL_BUDGET_EXCEEDED'].includes(failure.code)) {
                throw new AgentFault(failure.code, failure.message, failure.details);
            }
            throw new ContextFault('ATTEMPT_UNKNOWN', '压缩结果或占用需要显式恢复', { failure });
        }
        const previous = this.active.get(input.conversationId)?.candidate;
        if (previous && previous.snapshot.effectiveModelFingerprint !== input.config.modelFingerprint) {
            await this.invalidate(input.conversationId, 'model_changed');
        }
        await this.publish(input.conversationId, input.stepSeq, undefined, input.estimateCompaction);
        let estimate = await input.estimate();
        let gate = checkContextGate(estimate, input.limits);
        let active = this.active.get(input.conversationId);
        if (!gate.allowed) {
            if (active) {
                if (this.options.port.revokeCandidatePublication && active.candidate.state !== 'publishing') {
                    await this.invalidate(input.conversationId, 'hard_takeover');
                } else {
                    const cancellation = await this.cancel(input.conversationId, { human: false });
                    if (cancellation.state === 'unknown') throw new ContextFault('ATTEMPT_UNKNOWN', '原后台attempt尚未结清，硬压缩保持阻塞', undefined, true);
                }
            }
            const capture = await this.options.port.inspect(input.conversationId);
            const preview = previewCompaction(await captureCompletedFragments(this.options.port, capture, input.config.policy), input.config);
            if (!preview.roundIds.length) throw new ContextFault('ACTIVE_ROUND_TOO_LARGE', '完整保留轮及活动轮已超过有效输入预算，当前没有可压缩的旧轮',
                { activeRoundId: capture.activeRoundId, retainedRoundIds: preview.retainedRoundIds, keepCompleteRounds: input.config.policy.keepCompleteRounds,
                    inputTokens: gate.inputTokens, inputBudget: input.limits.inputBudget, target: input.limits.target, limits: input.limits,
                    estimate, estimateConfidence: estimate.confidence, localContextWindowTokens: input.config.policy.localContextWindowTokens,
                    recovery: [input.config.policy.localContextWindowTokens === null ? 'select_model_with_larger_verified_window' : 'clear_or_raise_explicit_local_window_limit',
                        'reduce_or_split_unconsumed_input', 'keep_completed_tool_results_and_artifacts'] });
            const handle = await this.start({ conversationId: input.conversationId, config: input.config, execution: input.execution, reason: 'hard',
                limits: input.limits, estimateCompaction: input.estimateCompaction });
            await handle.completion;
            await this.publish(input.conversationId, input.stepSeq, undefined, input.estimateCompaction);
            estimate = await input.estimate();
            gate = checkContextGate(estimate, input.limits);
            if (!gate.allowed) {
                checkpoint = await this.checkpoint(input.conversationId);
                checkpoint.state = 'hardPaused';
                checkpoint.lastFailure = { code: 'CONTEXT_SUMMARY_BUDGET', message: `压缩后完整输入${gate.inputTokens} token达到或超过有效输入预算${input.limits.inputBudget}，压缩目标为${input.limits.target}，暂停相同输入的自动重生成`,
                    mayHaveStarted: false, details: { estimate, inputTokens: gate.inputTokens, inputBudget: input.limits.inputBudget, target: input.limits.target } };
                await this.persist(input.conversationId, checkpoint);
                throw new ContextFault('SUMMARY_BUDGET', checkpoint.lastFailure.message, checkpoint.lastFailure.details);
            }
        }
        const background = await this.postStep({ ...input, estimate });
        return { estimate, inputTokens: gate.inputTokens, backgroundCandidateId: background.backgroundCandidateId };
    }

    async postStep(input: { conversationId: string; execution: ExecutionLease; config: FrozenCompressionConfig;
        stepSeq: number; limits: ContextLimits; estimate: ContextEstimate; estimateCompaction?: CompactionViewEstimator }): Promise<{ backgroundCandidateId: string | null }> {
        const checkpoint = await this.checkpoint(input.conversationId);
        if (checkpoint.lastFailure?.code === 'E_BACKGROUND_BUDGET_DEFERRED'
            && checkpoint.lastFailure.details?.rootBudgetId === input.execution.rootBudgetId) {
            return { backgroundCandidateId: this.active.get(input.conversationId)?.candidate.candidateId ?? null };
        }
        if (checkContextGate(input.estimate, input.limits).allowed
            && totalContextTokens(input.estimate) >= backgroundTriggerTokens(input.limits, input.config.policy)
            && checkpoint.state === 'idle' && !this.active.has(input.conversationId) && !this.starting.has(input.conversationId) && !this.recovering.has(input.conversationId)) {
            if (checkpoint.lastPublishStep !== null && input.stepSeq >= checkpoint.lastPublishStep
                && input.stepSeq - checkpoint.lastPublishStep <= input.config.policy.immediateRetriggerSteps
                && checkpoint.lastRetriggeredRevision !== checkpoint.lastPublishRevision) {
                checkpoint.immediateRetriggers++;
                checkpoint.lastRetriggeredRevision = checkpoint.lastPublishRevision;
            } else if (checkpoint.lastPublishStep !== null && input.stepSeq - checkpoint.lastPublishStep > input.config.policy.immediateRetriggerSteps) checkpoint.immediateRetriggers = 0;
            if (checkpoint.immediateRetriggers >= input.config.policy.immediateRetriggerLimit) checkpoint.state = 'circuitBroken';
            await this.persist(input.conversationId, checkpoint);
            if (checkpoint.state === 'idle') {
                const preview = await this.preview(input.conversationId, input.config);
                if (preview.roundIds.length) {
                    try {
                        await this.start({ conversationId: input.conversationId, config: input.config, execution: input.execution, reason: 'background',
                            limits: input.limits, estimateCompaction: input.estimateCompaction });
                    } catch (error) {
                        if (!(error instanceof ContextFault) || error.code !== 'CONTEXT_SUMMARY_BUDGET'
                            || typeof error.details?.fixedInputTokens !== 'number') throw error;
                        checkpoint.lastFailure = contextFailure(error);
                        await this.persist(input.conversationId, checkpoint);
                    }
                }
            }
        }
        return { backgroundCandidateId: this.active.get(input.conversationId)?.candidate.candidateId ?? null };
    }

    private async settleOwnedCompaction(conversationId: string, execution: ExecutionLease, signal?: AbortSignal): Promise<boolean> {
        const owns = (lease: ExecutionLease): boolean => lease.runId === execution.runId && lease.runEpoch === execution.runEpoch
            && lease.rootBudgetId === execution.rootBudgetId;
        while (true) {
            const starting = this.starting.get(conversationId);
            const active = this.active.get(conversationId);
            const snapshot = starting && owns(starting.execution) ? starting : undefined;
            const generation = active && owns(active.candidate.snapshot.execution) ? active : undefined;
            const pending = snapshot?.settled ?? generation?.completion;
            if (!pending) return true;
            const remaining = Date.parse(execution.deadlineAt) - this.now();
            if (signal?.aborted || !Number.isFinite(remaining) || remaining <= 0) return false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let interrupted: () => void = () => {};
            const stop = new Promise<boolean>(resolve => {
                interrupted = () => resolve(false);
                timer = setTimeout(interrupted, Math.min(remaining, 2_147_483_647));
                signal?.addEventListener('abort', interrupted, { once: true });
                if (signal?.aborted) interrupted();
            });
            try {
                if (!await Promise.race([pending.then(() => true, () => true), stop])) return false;
            } finally {
                if (timer) clearTimeout(timer);
                signal?.removeEventListener('abort', interrupted);
            }
            if (!snapshot) return !signal?.aborted && Date.parse(execution.deadlineAt) > this.now();
        }
    }

    async finishExecution(conversationId: string, execution: ExecutionLease, stepSeq: number,
        options: { publishReady?: boolean; signal?: AbortSignal } = {}): Promise<ContextExecutionCleanup> {
        const publishReady = options.publishReady !== false && !options.signal?.aborted
            && await this.settleOwnedCompaction(conversationId, execution, options.signal);
        const starting = this.starting.get(conversationId);
        if (starting?.execution.runId === execution.runId && starting.execution.runEpoch === execution.runEpoch
            && starting.execution.rootBudgetId === execution.rootBudgetId) {
            const cancelled = await this.cancel(conversationId, { human: false });
            return { state: cancelled.state === 'unknown' ? 'unconfirmed' : 'released', candidateId: null };
        }
        const state = await this.context(conversationId);
        if (!state.candidate || state.candidate.snapshot.runId !== execution.runId || state.candidate.snapshot.runEpoch !== execution.runEpoch
            || state.candidate.snapshot.execution.rootBudgetId !== execution.rootBudgetId) return { state: 'not_needed', candidateId: null };
        const candidateId = state.candidate.candidateId;
        if (state.candidate.state === 'ready') {
            if (!publishReady || options.signal?.aborted) {
                const cancelled = await this.cancel(conversationId, { human: false });
                return { state: cancelled.state === 'unknown' ? 'unconfirmed' : 'released', candidateId };
            }
            try {
                await this.publish(conversationId, stepSeq);
            } catch (error) {
                const failure = contextFailure(error);
                if (state.candidate.reason !== 'background' || !(error instanceof ContextFault)
                    || error.code !== 'CONTEXT_SUMMARY_BUDGET' || error.mayHaveStarted
                    || state.candidate.pendingRequest || state.candidate.publicationReceiptKey) throw error;
                const current = await this.context(conversationId);
                if (current.candidate?.candidateId !== candidateId || current.candidate.state !== 'ready'
                    || current.candidate.pendingRequest || current.candidate.publicationReceiptKey) throw error;
                const candidate = { ...current.candidate, error: failure };
                await this.options.port.saveCandidate(structuredClone(candidate));
                await this.options.port.discardCandidate({ conversationId, candidateId,
                    generation: candidate.snapshot.compressionGeneration, state: 'discarded' });
                const checkpoint = await this.checkpoint(conversationId);
                checkpoint.state = 'circuitBroken';
                checkpoint.lastFailure = failure;
                await this.persist(conversationId, checkpoint);
                if (this.active.get(conversationId)?.candidate.candidateId === candidateId) this.active.delete(conversationId);
            }
            return { state: 'released', candidateId };
        }
        if (['snapshotting', 'generating', 'publishing', 'unknown'].includes(state.candidate.state) || state.candidate.pendingRequest) {
            if (publishReady) return { state: 'unconfirmed', candidateId };
            const cancelled = await this.cancel(conversationId, { human: false });
            return { state: cancelled.state === 'unknown' ? 'unconfirmed' : 'released', candidateId };
        }
        return { state: 'not_needed', candidateId };
    }

    async retryKnownFailure(input: { conversationId: string; candidateId: string; budget: JsonObject; operationId: string;
        estimateCompaction(execution: ExecutionLease): Promise<CompactionViewEstimator>;
        prepareCandidate?(candidate: CompactionCandidate): Promise<void> }): Promise<CompactionHandle> {
        const conversationId = input.conversationId;
        if (this.recovering.has(conversationId) || this.starting.has(conversationId)
            || this.hasLocalCompaction(conversationId, { runningOnly: true })) throw new ContextFault('COMPACTION_BUSY', '原压缩仍在运行');
        this.recovering.add(conversationId);
        let execution: ExecutionLease | undefined;
        try {
            const original = await this.options.port.getCandidate(conversationId, input.candidateId);
            if (!original || original.state !== 'failed' || original.pendingRequest || original.publicationReceiptKey
                || original.publicationRevoked || !original.error || original.error.mayHaveStarted
                || !(['CONTEXT_CONFIG_INVALID', 'CONTEXT_SUMMARY_BUDGET'].includes(original.error.code)
                    || original.error.details?.budgetReservationRejected === true)) {
                throw new ContextFault('COMPACTION_PAUSED', '仅确定未发送的预算失败可以显式重试，原未知请求及发布保持');
            }
            if (!this.options.maintenance) throw new ContextFault('BUDGET_REQUIRED', '已知失败重试需要独立维护执行');
            const before = await this.options.port.inspect(conversationId);
            const snapshot = original.snapshot;
            if (before.execution || before.historyEpoch !== snapshot.historyEpoch || before.viewRevision !== snapshot.parentViewRevision
                || before.appendSeq < snapshot.snapshotAppendSeq) throw new ContextFault('HISTORY_STALE', '原失败来源所属历史或父视图已改变');
            if (before.candidateId && before.candidateId !== original.candidateId) {
                const current = await this.options.port.getCandidate(conversationId, before.candidateId);
                if (current && !['failed', 'cancelled', 'discarded', 'published'].includes(current.state)) throw new ContextFault('COMPACTION_BUSY', '当前会话已有其它有效候选');
            }
            const referenceRoundIds = new Set(snapshot.referenceBlocks.map(block => block.roundId));
            const rounds = [...snapshot.manifest.rounds, ...before.rounds.filter(round => referenceRoundIds.has(round.roundId))];
            const items = await readSelectedHistory(this.options.port, { ...before, appendSeq: snapshot.snapshotAppendSeq }, rounds,
                snapshot.config.policy.readFrameBytes);
            const sourceIds = new Set(snapshot.manifest.blocks.map(block => block.itemId));
            const manifest = await createSourceManifest(this.options.sources, items.filter(item => sourceIds.has(item.itemId)), snapshot.manifest.rounds);
            for (const item of items.filter(item => !sourceIds.has(item.itemId))) await this.options.sources.describe(item);
            if (manifest.hash !== snapshot.sourceManifestHash || manifest.prefixHash !== snapshot.sourcePrefixHash) {
                throw new ContextFault('HISTORY_STALE', '原失败冻结来源清单或前缀已经变化');
            }
            await verifyManifestSources(manifest, this.options.sources, snapshot.config.policy.readFrameBytes);
            execution = await this.options.maintenance.createRun({ conversationId, config: snapshot.config,
                budget: input.budget, operationId: input.operationId });
            const config = await this.options.maintenance.prepareRun?.({ execution, config: snapshot.config }) ?? snapshot.config;
            if (hashContext(config) !== hashContext(snapshot.config)) throw new ContextFault('MODEL_STALE', '新维护预算须完整承接原冻结模型参数及输出额度');
            const capture = await this.options.port.claim({ conversationId, execution, expectedHistoryEpoch: before.historyEpoch,
                expectedViewRevision: before.viewRevision, expectedGeneration: before.compressionGeneration, compressionGeneration: randomUUID() });
            const candidateId = randomUUID();
            const candidate: CompactionCandidate = { ...structuredClone(original), candidateId, state: 'snapshotting',
                snapshot: freezeValue({ ...structuredClone(snapshot), candidateId, runId: execution.runId, runEpoch: execution.runEpoch,
                    execution, compressionGeneration: capture.compressionGeneration, createdAt: new Date(this.now()).toISOString(),
                    semanticCandidateId: snapshot.semanticCandidateId ?? snapshot.candidateId,
                    retryOf: { candidateId: original.candidateId, runId: snapshot.runId, runEpoch: snapshot.runEpoch,
                        rootBudgetId: snapshot.execution.rootBudgetId, sourceManifestHash: snapshot.sourceManifestHash, sourcePrefixHash: snapshot.sourcePrefixHash } }),
                error: null, pendingRequest: null, failedResult: null, batch: null, folds: [], nextView: null, coverage: null,
                publicationReceiptKey: null, publishedViewRevision: null };
            const estimateCompaction = await input.estimateCompaction(execution);
            if (candidate.snapshot.requestBudget) await estimateCompaction(candidate.snapshot,
                { coveredEndSeq: candidate.snapshot.coveredEndSeq, text: '', tokens: 0 });
            this.active.delete(conversationId);
            await this.persist(conversationId, emptyCheckpoint());
            await this.options.port.saveCandidate(structuredClone(candidate));
            await input.prepareCandidate?.(candidate);
            return this.run(candidate, capture, new AbortController(), estimateCompaction);
        } catch (error) {
            if (execution) await this.options.maintenance!.finishRun({ execution, result: 'failed', failure: contextFailure(error) });
            throw error;
        } finally { this.recovering.delete(conversationId); }
    }

    async recover(conversationId: string, candidateId: string, estimateCompaction?: CompactionViewEstimator): Promise<CompactionHandle | CompactionCandidate> {
        if (this.recovering.has(conversationId) || this.starting.has(conversationId)) throw new ContextFault('COMPACTION_BUSY', '当前会话正在准备或恢复压缩');
        this.recovering.add(conversationId);
        try { return await this.recoverCandidate(conversationId, candidateId, estimateCompaction); }
        finally { this.recovering.delete(conversationId); }
    }

    private async recoverCandidate(conversationId: string, candidateId: string, estimateCompaction?: CompactionViewEstimator): Promise<CompactionHandle | CompactionCandidate> {
        const local = this.active.get(conversationId);
        if (local && (local.candidate.candidateId !== candidateId || !local.settled)) {
            throw new ContextFault('COMPACTION_BUSY', '原本地压缩执行仍在运行，保留原worker和候选');
        }
        const releaseSettled = () => {
            if (this.active.get(conversationId) !== local || this.starting.has(conversationId) || local && !local.settled) {
                throw new ContextFault('COMPACTION_BUSY', '恢复核对期间本地压缩所有者已经变化');
            }
            if (local) this.active.delete(conversationId);
        };
        const candidate = await this.options.port.getCandidate(conversationId, candidateId);
        if (!candidate) throw new ContextFault('SOURCE_GAP', '待恢复候选不存在');
        if (candidate.publicationRevoked) {
            if (!candidate.pendingRequest && candidate.publicationReceiptKey && ['publishing', 'unknown'].includes(candidate.state)) {
                const publication = await this.options.port.getPublication(candidate.publicationReceiptKey);
                if (!publication) throw new ContextFault('COMMIT_UNKNOWN', '已撤销候选的原发布回执仍未查明', undefined, true);
                candidate.state = 'published';
                candidate.publishedViewRevision = publication.viewRevision;
                candidate.error = null;
                releaseSettled();
                const checkpoint = await this.checkpoint(conversationId);
                checkpoint.state = (checkpoint.cooldownUntil ?? 0) > this.now() ? 'cooldown' : 'idle';
                checkpoint.lastFailure = null;
                checkpoint.lastPublishRevision = publication.viewRevision;
                await this.persist(conversationId, checkpoint);
                await this.finishMaintenance(candidate, 'published');
                return candidate;
            }
            if (candidate.pendingRequest) {
                const lookup = await this.options.model.lookup(candidate.pendingRequest);
                if (lookup.status === 'found') {
                    if ((lookup.result.attemptId !== candidate.pendingRequest.attemptId && lookup.result.requestAttemptId !== candidate.pendingRequest.attemptId)
                        || lookup.result.inputBodyHash !== candidate.pendingRequest.inputBodyHash
                        || lookup.result.modelFingerprint !== candidate.snapshot.effectiveModelFingerprint) throw new ContextFault('USAGE_MISMATCH', '已撤销候选的查回结果与原请求身份不同', undefined, true);
                    candidate.publicationRevoked = { ...candidate.publicationRevoked,
                        resolution: { attemptId: candidate.pendingRequest.attemptId, status: 'found' } };
                    candidate.failedResult = structuredClone(lookup.result);
                    candidate.pendingRequest = null;
                    candidate.state = 'discarded';
                    candidate.error = null;
                } else if (lookup.status === 'notAccepted') {
                    candidate.publicationRevoked = { ...candidate.publicationRevoked,
                        resolution: { attemptId: candidate.pendingRequest.attemptId, status: 'notAccepted' } };
                    candidate.pendingRequest = null;
                    candidate.state = 'discarded';
                    candidate.error = null;
                }
            }
            if (this.options.port.revokeCandidatePublication) await this.options.port.revokeCandidatePublication(structuredClone(candidate));
            else {
                await this.options.port.saveCandidate(structuredClone(candidate));
                if (candidate.state === 'discarded') await this.options.port.discardCandidate({ conversationId, candidateId,
                    generation: candidate.snapshot.compressionGeneration, state: 'discarded' });
            }
            releaseSettled();
            if (!candidate.pendingRequest && candidate.state === 'discarded') {
                const current = await this.options.port.inspect(conversationId);
                const checkpoint = await this.checkpoint(conversationId);
                if ((!current.candidateId || current.candidateId === candidateId)
                    && checkpoint.lastFailure?.attemptId === candidate.publicationRevoked.pendingAttemptId) {
                    checkpoint.lastFailure = null;
                    checkpoint.state = (checkpoint.cooldownUntil ?? 0) > this.now() ? 'cooldown' : 'idle';
                    await this.persist(conversationId, checkpoint);
                }
                await this.finishMaintenance(candidate, 'cancelled');
            }
            return candidate;
        }
        if (candidate.error?.details?.budgetDeferralCleanup === true) {
            throw new ContextFault('COMMIT_UNKNOWN', '先核实原预算延期候选的持久收尾，不新增压缩请求',
                { candidateId, failure: candidate.error }, true);
        }
        if (candidate.state === 'published') {
            releaseSettled();
            const checkpoint = await this.checkpoint(conversationId);
            checkpoint.state = 'idle';
            checkpoint.lastFailure = null;
            checkpoint.lastPublishRevision = candidate.publishedViewRevision;
            await this.persist(conversationId, checkpoint);
            await this.finishMaintenance(candidate, 'published');
            return candidate;
        }
        if (candidate.publicationReceiptKey && ['publishing', 'unknown'].includes(candidate.state) && !candidate.pendingRequest) {
            const publication = await this.options.port.getPublication(candidate.publicationReceiptKey);
            if (!publication) throw new ContextFault('COMMIT_UNKNOWN', '原发布回执仍不可取，保持阻塞', undefined, true);
            candidate.state = 'published';
            candidate.publishedViewRevision = publication.viewRevision;
            candidate.error = null;
            releaseSettled();
            const checkpoint = await this.checkpoint(conversationId);
            checkpoint.state = 'idle';
            checkpoint.lastFailure = null;
            checkpoint.lastPublishRevision = publication.viewRevision;
            await this.persist(conversationId, checkpoint);
            await this.finishMaintenance(candidate, 'published');
            return candidate;
        }
        const capture = await this.options.port.inspect(conversationId);
        validatePublication(candidate, capture, candidate.snapshot.sourcePrefixHash);
        const referenceRoundIds = new Set(candidate.snapshot.referenceBlocks.map(block => block.roundId));
        const rounds = [...candidate.snapshot.manifest.rounds, ...capture.rounds.filter(round => referenceRoundIds.has(round.roundId))];
        const items = await readSelectedHistory(this.options.port, { ...capture, appendSeq: candidate.snapshot.snapshotAppendSeq }, rounds,
            candidate.snapshot.config.policy.readFrameBytes);
        const sourceItems = new Set(candidate.snapshot.manifest.blocks.map(block => block.itemId));
        const manifest = await createSourceManifest(this.options.sources, items.filter(item => sourceItems.has(item.itemId)), candidate.snapshot.manifest.rounds);
        for (const item of items.filter(entry => !sourceItems.has(entry.itemId))) await this.options.sources.describe(item);
        if (manifest.hash !== candidate.snapshot.sourceManifestHash) throw new ContextFault('HISTORY_STALE', '恢复时不可变来源清单已经变化');
        await verifyManifestSources(manifest, this.options.sources, candidate.snapshot.config.policy.readFrameBytes);
        const abort = new AbortController();
        let recoveredAttemptId: string | undefined;
        if (candidate.pendingRequest) {
            const lookup = await this.options.model.lookup(candidate.pendingRequest);
            if (lookup.status !== 'found') {
                const failure = new ContextFault(lookup.status === 'notAccepted' ? 'ATTEMPT_NOT_ACCEPTED' : 'ATTEMPT_UNKNOWN', '原压缩attempt尚无完整结果，保持原根预算并停止新增请求',
                    { attemptId: candidate.pendingRequest.attemptId, lookupStatus: lookup.status }, lookup.status !== 'notAccepted');
                if (lookup.status === 'notAccepted') {
                    candidate.pendingRequest = null;
                    candidate.state = 'failed';
                    candidate.error = contextFailure(failure);
                    await this.options.port.saveCandidate(structuredClone(candidate));
                }
                const checkpoint = await this.checkpoint(conversationId);
                checkpoint.state = 'hardPaused';
                checkpoint.lastFailure = contextFailure(failure);
                await this.persist(conversationId, checkpoint);
                if (lookup.status === 'notAccepted') {
                    releaseSettled();
                    await this.finishMaintenance(candidate, 'failed');
                }
                throw failure;
            }
            validateCompressionResult(candidate.pendingRequest, lookup.result);
            recoveredAttemptId = candidate.pendingRequest.attemptId;
            const chunk = candidate.pendingRequest.chunk;
            if (!candidate.chunks.some(entry => entry.chunkId === chunk.chunkId)) candidate.chunks.push(freezeValue({ ...factsOnlyCompressionResult(lookup.result),
                chunkId: chunk.chunkId, roundId: chunk.roundId, sourceSpans: chunk.sourceSpans, anchors: chunk.anchors }));
            candidate.pendingRequest = null;
        }
        if (['cancelled', 'discarded', 'failed'].includes(candidate.state)) throw new ContextFault('COMPACTION_PAUSED', '终态候选需显式重启后按新代次生成');
        if (candidate.snapshot.execution.kind === 'maintenance' && candidate.state !== 'ready' && recoveredAttemptId) {
            if (!this.options.maintenance?.prepareRun) throw new ContextFault('CONFIG_INVALID', '维护恢复需要原根预算的可信准备回调');
            const config = await this.options.maintenance.prepareRun({ execution: candidate.snapshot.execution,
                config: candidate.snapshot.config, recoveredAttemptId });
            if (hashContext(config) !== hashContext(candidate.snapshot.config)) throw new ContextFault('MODEL_STALE', '维护恢复必须保留原候选的完整冻结配置');
        }
        releaseSettled();
        candidate.error = null;
        const checkpoint = await this.checkpoint(conversationId);
        checkpoint.state = 'idle';
        checkpoint.lastFailure = null;
        await this.persist(conversationId, checkpoint);
        if (candidate.state === 'ready') {
            this.active.set(conversationId, { candidate, abort, completion: Promise.resolve(candidate), settled: true, estimateCompaction });
            if (candidate.snapshot.execution.kind === 'maintenance') {
                await this.publish(conversationId, capture.stepSeq);
                await this.finishMaintenance(candidate, 'published');
            }
            return candidate;
        }
        candidate.state = 'generating';
        await this.options.port.saveCandidate(structuredClone(candidate));
        return this.run(candidate, capture, abort, estimateCompaction);
    }
}
