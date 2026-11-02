import type { JsonObject } from '../protocol.js';
import { AgentFault } from '../protocol.js';
import type { StoreCompactionPort } from '../storage/context-port.js';
import type { CompactionCandidate, CompressionModelPort, ContextCapture, ContextEstimate, ContextEstimateBasis, ContextFailure, ContextTokenCountEvidence, ConversationContextLimits, FrozenCompressionConfig, SchedulerCheckpoint } from './contracts.js';
import type { CompactionPreview } from './compaction.js';
import { previewCompaction } from './compaction.js';
import { validateContextPolicy } from './config.js';
import { ContextFault } from './errors.js';
import type { ContextService } from './service.js';

export interface ContextServerConfiguration {
    config: FrozenCompressionConfig;
    limits: ConversationContextLimits;
}

export interface ContextPreparedMeasurement {
    historyEpoch: number;
    appendSeq: number;
    viewRevision: number;
    configFingerprint: string;
    viewHash: string;
    modelId: string;
    inputTokens: number;
    confidence: Exclude<ContextEstimate['confidence'], 'unknown'>;
    basis: ContextEstimateBasis;
    tokenCountEvidence?: ContextTokenCountEvidence;
}

export interface ContextServerStatus {
    conversationId: string;
    history: { historyEpoch: number; appendSeq: number; viewRevision: number; coveredEndSeq: number };
    scheduler: SchedulerCheckpoint;
    execution: { kind: 'task' | 'maintenance'; runId: string; runEpoch: number; rootBudgetId: string } | null;
    cleanupExecution: { kind: 'task' | 'maintenance'; runId: string; runEpoch: number; rootBudgetId: string; currentRunEpoch: number | null } | null;
    candidate: { candidateId: string; state: CompactionCandidate['state']; reason: CompactionCandidate['reason'];
        pendingAttemptId: string | null; targetReplaceStep: number; publishedViewRevision: number | null; error: ContextFailure | null;
        historyEpoch: number; runId: string; runEpoch: number; compressionGeneration: string; configRevision: number; configFingerprint: string } | null;
    configuration: { modelSource: FrozenCompressionConfig['modelSource']; profileId: string; modelId: string;
        modelFingerprint: string; configFingerprint: string; policy: FrozenCompressionConfig['policy']; limits: ConversationContextLimits } | null;
    estimate: ContextPreparedMeasurement | null;
    estimateConfidence: ContextEstimate['confidence'];
    preview: CompactionPreview;
    unavailable: { code: string; message: string } | null;
}

export interface ContextServerStatusInput { conversationId: string; candidateId?: string }

export interface ContextServerControlInput extends ContextServerStatusInput {
    expectedHistoryEpoch?: number;
    expectedRunEpoch?: number;
}

export interface ContextServerControlResult {
    action: 'cancel' | 'restart' | 'recover';
    candidateId: string | null;
    state: CompactionCandidate['state'] | 'idle';
    resumed: boolean;
    cooldownUntil: number | null;
    status: ContextServerStatus;
}

export interface ContextServerCompactInput {
    conversationId: string;
    mode?: 'preview' | 'manual';
    budget?: JsonObject;
    operationId?: string;
}

export interface ContextServerCompactResult {
    started: boolean;
    preview: CompactionPreview;
    candidateId: string | null;
    execution: ContextServerStatus['execution'];
    status: ContextServerStatus;
}

export function createContextServerControls(options: {
    port: StoreCompactionPort;
    service: ContextService;
    resolveConfiguration(conversationId: string, budget?: JsonObject): Promise<ContextServerConfiguration | null>;
    readMeasurement(conversationId: string): ContextPreparedMeasurement | undefined;
    model: Pick<CompressionModelPort, 'lookup'>;
    withControl<T>(capture: ContextCapture, operation: () => Promise<T>, configFingerprint?: string): Promise<T>;
    now: () => number;
}) {
    const status = async (input: ContextServerStatusInput): Promise<ContextServerStatus> => {
        input = { ...input };
        const capture = await options.port.inspect(input.conversationId);
        const cleanupLease = capture.execution ? null : await options.port.readExecutionForCleanup(input.conversationId);
        const cleanupRun = cleanupLease ? await options.port.store.getRecord({ conversationId: input.conversationId, kind: 'run', id: cleanupLease.runId }) : undefined;
        const candidateId = input.candidateId ?? capture.candidateId;
        const candidate = candidateId ? await options.port.getCandidate(input.conversationId, candidateId) : null;
        if (input.candidateId && !candidate) throw new ContextFault('SOURCE_GAP', '原压缩候选不存在', { candidateId: input.candidateId });
        const scheduler = await options.port.loadScheduler(input.conversationId) ?? { state: 'idle', cooldownUntil: null, lastPublishStep: null,
            immediateRetriggers: 0, lastFailure: null, lastPublishRevision: null, lastRetriggeredRevision: null };
        if (scheduler.state === 'cooldown' && (scheduler.cooldownUntil ?? 0) <= options.now()) {
            scheduler.state = 'idle';
            scheduler.cooldownUntil = null;
        }
        let configuration: ContextServerConfiguration | null = null;
        let unavailable: ContextServerStatus['unavailable'] = null;
        try { configuration = await options.resolveConfiguration(input.conversationId); }
        catch (error) {
            if (!(error instanceof AgentFault)) throw error;
            unavailable = { code: error.code, message: error.message };
        }
        if (!configuration && !unavailable) unavailable = { code: 'CONTEXT_CONFIG_REQUIRED', message: '当前会话尚未选择可用模型' };
        const config = configuration?.config;
        const measured = options.readMeasurement(input.conversationId);
        const estimate = measured?.historyEpoch === capture.historyEpoch && measured.appendSeq === capture.appendSeq
            && measured.viewRevision === capture.viewRevision && measured.configFingerprint === config?.configFingerprint ? measured : null;
        return { conversationId: input.conversationId,
            history: { historyEpoch: capture.historyEpoch, appendSeq: capture.appendSeq, viewRevision: capture.viewRevision, coveredEndSeq: capture.view.coveredEndSeq },
            scheduler, execution: capture.execution ? { kind: capture.execution.kind, runId: capture.execution.runId,
                runEpoch: capture.execution.runEpoch, rootBudgetId: capture.execution.rootBudgetId } : null,
            cleanupExecution: cleanupLease ? { kind: cleanupLease.kind, runId: cleanupLease.runId, runEpoch: cleanupLease.runEpoch,
                rootBudgetId: cleanupLease.rootBudgetId, currentRunEpoch: typeof cleanupRun?.value.runEpoch === 'number' ? cleanupRun.value.runEpoch : null } : null,
            candidate: candidate ? { candidateId: candidate.candidateId, state: candidate.state, reason: candidate.reason,
                pendingAttemptId: candidate.pendingRequest?.attemptId ?? null, targetReplaceStep: candidate.snapshot.targetReplaceStep,
                publishedViewRevision: candidate.publishedViewRevision, error: candidate.error, historyEpoch: candidate.snapshot.historyEpoch,
                runId: candidate.snapshot.runId, runEpoch: candidate.snapshot.runEpoch, compressionGeneration: candidate.snapshot.compressionGeneration,
                configRevision: candidate.snapshot.config.revision, configFingerprint: candidate.snapshot.config.configFingerprint } : null,
            configuration: config && configuration ? { modelSource: config.modelSource, profileId: config.model.profileId ?? config.model.provider,
                modelId: config.model.model, modelFingerprint: config.modelFingerprint, configFingerprint: config.configFingerprint,
                policy: config.policy, limits: configuration.limits } : null,
            estimate: estimate ? structuredClone(estimate) : null, estimateConfidence: estimate?.confidence ?? 'unknown',
            preview: previewCompaction(capture, { policy: config?.policy ?? validateContextPolicy() }), unavailable };
    };

    const compact = async (input: ContextServerCompactInput): Promise<ContextServerCompactResult> => {
        const before = await status(input);
        if (input.mode === 'preview' || !before.preview.roundIds.length) return { started: false, preview: before.preview,
            candidateId: null, execution: before.execution, status: before };
        const configuration = await options.resolveConfiguration(input.conversationId, input.budget);
        if (!configuration) throw new ContextFault('CONFIG_INVALID', '手动压缩需要先选择当前会话模型', { preview: before.preview });
        const capture = await options.port.inspect(input.conversationId);
        if (capture.execution) await options.port.bindExecution(capture.execution, configuration.config);
        const result = await options.service.compact({ conversationId: input.conversationId, mode: 'manual', config: configuration.config,
            ...(input.budget ? { budget: input.budget } : {}), ...(input.operationId ? { operationId: input.operationId } : {}) });
        const after = await status(input);
        return { started: result.handle !== null, preview: result.preview, candidateId: result.handle?.candidateId ?? null,
            execution: result.handle ? { kind: result.handle.execution.kind, runId: result.handle.execution.runId,
                runEpoch: result.handle.execution.runEpoch, rootBudgetId: result.handle.execution.rootBudgetId } : after.execution, status: after };
    };
    const captureControl = async (input: ContextServerControlInput) => {
        const capture = await options.port.inspect(input.conversationId);
        if (input.expectedHistoryEpoch !== undefined && input.expectedHistoryEpoch !== capture.historyEpoch) {
            throw new ContextFault('HISTORY_STALE', '压缩控制所属历史代次已经变化');
        }
        if (input.expectedRunEpoch !== undefined && input.expectedRunEpoch !== capture.execution?.runEpoch) {
            throw new ContextFault('HISTORY_STALE', '压缩控制所属执行代次已经变化');
        }
        const candidateId = input.candidateId ?? capture.candidateId;
        const candidate = candidateId ? await options.port.getCandidate(input.conversationId, candidateId) : null;
        if (input.candidateId && !candidate) throw new ContextFault('SOURCE_GAP', '原压缩候选不存在', { candidateId });
        return { capture, candidate };
    };
    const assertCurrentCandidate = (capture: ContextCapture, candidate: CompactionCandidate | null) => {
        if (candidate && capture.candidateId !== candidate.candidateId && (capture.candidateId !== null || !['published', 'cancelled', 'discarded', 'failed'].includes(candidate.state))) {
            throw new ContextFault('HISTORY_STALE', '当前压缩所有者已经变化，请按原候选查看状态', { candidateId: candidate.candidateId, currentCandidateId: capture.candidateId });
        }
    };
    const result = async (input: ContextServerControlInput, action: ContextServerControlResult['action'], candidateId: string | null,
        state?: ContextServerControlResult['state'], resumed = false): Promise<ContextServerControlResult> => {
        const after = await status({ conversationId: input.conversationId, ...(candidateId ? { candidateId } : {}) });
        return { action, candidateId, state: state ?? after.candidate?.state ?? 'idle', resumed,
            cooldownUntil: after.scheduler.cooldownUntil, status: after };
    };
    const cancelCompaction = async (input: ContextServerControlInput): Promise<ContextServerControlResult> => {
        input = { ...input };
        const { capture, candidate } = await captureControl(input);
        assertCurrentCandidate(capture, candidate);
        const cancelled = await options.withControl(capture, () => options.service.compactor!.cancel(input.conversationId, { human: true }),
            candidate?.snapshot.config.configFingerprint);
        return result(input, 'cancel', candidate?.candidateId ?? null, cancelled.state);
    };
    const restartCompaction = async (input: ContextServerControlInput): Promise<ContextServerControlResult> => {
        input = { ...input };
        const { capture, candidate } = await captureControl(input);
        assertCurrentCandidate(capture, candidate);
        const checkpoint = await options.port.loadScheduler(input.conversationId);
        if (!candidate && !checkpoint) return result(input, 'restart', null, 'idle');
        await options.withControl(capture, async () => {
            if (candidate?.pendingRequest && !['published', 'cancelled', 'discarded', 'failed'].includes(candidate.state)) {
                const lookup = await options.model.lookup(candidate.pendingRequest);
                if (lookup.status !== 'notAccepted') throw new ContextFault(lookup.status === 'found' ? 'COMPACTION_BUSY' : 'ATTEMPT_UNKNOWN',
                    lookup.status === 'found' ? '原压缩结果已查回，请按原candidateId恢复' : '原压缩attempt尚未确认，保留冷却、候选和预算',
                    { candidateId: candidate.candidateId, attemptId: candidate.pendingRequest.attemptId, lookupStatus: lookup.status }, true);
                try { await options.service.compactor!.recover(input.conversationId, candidate.candidateId); }
                catch (error) { if (!(error instanceof ContextFault) || error.code !== 'CONTEXT_ATTEMPT_NOT_ACCEPTED') throw error; }
            }
            await options.service.compactor!.restart(input.conversationId);
        }, candidate?.snapshot.config.configFingerprint);
        return result(input, 'restart', candidate?.candidateId ?? null, 'idle');
    };
    const recoverCompaction = async (input: ContextServerControlInput & { candidateId: string }): Promise<ContextServerControlResult> => {
        input = { ...input };
        const { capture, candidate } = await captureControl(input);
        if (!candidate) throw new ContextFault('SOURCE_GAP', '恢复需要原压缩候选');
        if (candidate.state === 'published' && (capture.candidateId !== candidate.candidateId
            || capture.compressionGeneration !== candidate.snapshot.compressionGeneration || capture.execution?.runId !== candidate.snapshot.runId
            || capture.execution.runEpoch !== candidate.snapshot.runEpoch)) return result(input, 'recover', candidate.candidateId, 'published');
        assertCurrentCandidate(capture, candidate);
        const config = await options.port.readConfig(input.conversationId);
        if (!config || config.configFingerprint !== candidate.snapshot.config.configFingerprint || config.revision !== candidate.snapshot.config.revision) {
            throw new ContextFault('MODEL_STALE', '恢复需要原候选的冻结配置版本', { candidateId: candidate.candidateId });
        }
        if (candidate.state === 'ready' && options.service.compactor!.hasLocalCompaction(input.conversationId)) {
            return result(input, 'recover', candidate.candidateId, 'ready');
        }
        return options.withControl(capture, async () => {
            if (candidate.pendingRequest) {
                const lookup = await options.model.lookup(candidate.pendingRequest);
                if (lookup.status === 'pending' || lookup.status === 'unknown') throw new ContextFault('ATTEMPT_UNKNOWN',
                    '原压缩attempt尚无完整结果，保留原候选、配置和预算', { candidateId: candidate.candidateId,
                        attemptId: candidate.pendingRequest.attemptId, lookupStatus: lookup.status }, true);
            }
            const recovered = await options.service.compactor!.recover(input.conversationId, candidate.candidateId);
            return result(input, 'recover', candidate.candidateId, undefined, 'completion' in recovered);
        }, candidate.snapshot.config.configFingerprint);
    };
    return { status, compact, cancelCompaction, restartCompaction, recoverCompaction };
}
