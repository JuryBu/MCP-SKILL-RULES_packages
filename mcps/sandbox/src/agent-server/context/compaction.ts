import { createHash, randomUUID } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { CompactionCandidate, CompactionPort, CompactionReason, CompactionSnapshot, CompressionChunk, CompressionModelPort,
    CompressionRequest, CompressionResult, ContextCapture, ContextSourcePort, CoverageReport, ExecutionLease, FoldNode,
    FrozenCompressionConfig, RequirementAnchor, SourceBlock, SourceManifest, SourceSpan, SummaryView, TokenCounter, ChunkDigest, CompactionViewEstimator, SummaryNode } from './contracts.js';
import { computeContextLimits, conservativeTextTokens, totalContextTokens } from './budget.js';
import { derivedContextId, freezeValue, hashBytes, hashContext } from './config.js';
import { checkAbort, contextFailure, ContextFault } from './errors.js';
import { createSourceManifest, readSelectedHistory, selectCompactionRounds } from './rounds.js';
import { readSourceFrame, utf8Boundary } from './sources.js';
import { applySummaryFold, mergeRequirements, planSummaryFold, renderSummary, renderSummaryView, sealSummaryNode, validatePublication } from './view.js';
import { feedbackSourceNodeIds } from './feedback.js';
import { activeRequirements, boundedRequirementGuidance } from './requirements.js';
import { applySemanticChunk, replaySemanticChunks, semanticDigestText, semanticTailInput } from './semantic-tail.js';
import { updateCommunicationWindow } from './communication-window.js';
import { captureCompletedFragments } from './completed-fragments.js';

export interface CompactionPreview {
    conversationId: string;
    historyEpoch: number;
    viewRevision: number;
    appendSeq: number;
    roundIds: string[];
    retainedRoundIds: string[];
    firstSeq: number | null;
    lastSeq: number | null;
    requiresBudget: boolean;
    recentRawRetention: { unit: 'complete_user_rounds' | 'complete_model_steps'; count: number };
}

export function previewCompaction(capture: ContextCapture, config: Pick<FrozenCompressionConfig, 'policy'>): CompactionPreview {
    const selected = selectCompactionRounds(capture, config.policy);
    return { conversationId: capture.conversationId, historyEpoch: capture.historyEpoch, viewRevision: capture.viewRevision,
        appendSeq: capture.appendSeq, roundIds: selected.targets.map(round => round.roundId), retainedRoundIds: selected.retained.map(round => round.roundId),
        firstSeq: selected.targets[0]?.firstSeq ?? null, lastSeq: selected.targets.at(-1)?.lastSeq ?? null,
        requiresBudget: capture.execution === null,
        recentRawRetention: capture.activeCompletedPrefix ? { unit: 'complete_model_steps', count: Math.max(1, config.policy.keepCompleteSteps ?? 2) }
            : { unit: 'complete_user_rounds', count: config.policy.keepCompleteRounds } };
}

export async function prepareCompaction(input: {
    port: CompactionPort; sources: ContextSourcePort; capture: ContextCapture; config: FrozenCompressionConfig;
    execution: ExecutionLease; candidateId?: string; reason: CompactionReason; signal?: AbortSignal; now?: number;
}): Promise<CompactionCandidate> {
    const { config, execution, port, sources, signal } = input;
    const capture = await captureCompletedFragments(port, input.capture, config.policy, signal);
    checkAbort(signal);
    if (execution.conversationId !== capture.conversationId || !execution.runId || !execution.rootBudgetId
        || !execution.stepId || !Number.isSafeInteger(execution.runEpoch) || execution.runEpoch < 1
        || (execution.kind === 'task' && !execution.roundId) || (execution.kind === 'maintenance' && execution.roundId !== null)
        || !Number.isFinite(Date.parse(execution.deadlineAt))) throw new ContextFault('CONFIG_INVALID', '压缩需要活动或维护run的完整执行及根预算身份');
    if (capture.effectiveModelFingerprint !== config.modelFingerprint) throw new ContextFault('MODEL_STALE', '压缩配置与当前有效模型身份不一致');
    if (!capture.execution || hashContext(capture.execution) !== hashContext(execution)) throw new ContextFault('HISTORY_STALE', '压缩执行租约与当前run不一致');
    computeContextLimits(config.model.contextWindow, config.model.maxOutputTokens, config.policy);
    const selected = selectCompactionRounds(capture, config.policy);
    if (!selected.targets.length) throw new ContextFault('ACTIVE_ROUND_TOO_LARGE', '没有可以压缩的完整旧轮，保留最近轮及活动轮原文',
        { activeRoundId: capture.activeRoundId, retainedRoundIds: selected.retained.map(round => round.roundId) });
    const items = await readSelectedHistory(port, capture, [...selected.targets, ...selected.references], config.policy.readFrameBytes, signal);
    const targetIds = new Set(selected.targets.flatMap(round => round.itemIds));
    const manifest = await createSourceManifest(sources, items.filter(item => targetIds.has(item.itemId)), selected.targets, signal);
    const references = await createSourceManifest(sources, items.filter(item => !targetIds.has(item.itemId)), selected.references, signal);
    await verifyManifestSources(manifest, sources, config.policy.readFrameBytes, signal);
    const candidateId = input.candidateId ?? randomUUID();
    const historyFeedback = await port.readHistoryFeedback?.({ conversationId: capture.conversationId, historyEpoch: capture.historyEpoch,
        nodes: capture.view.nodes, roundIds: selected.targets.map(round => round.roundId) });
    const requirementItems = new Map(items.map(item => [item.itemId, { itemId: item.itemId, seq: item.seq, role: item.role, roundId: item.roundId,
        ...(capture.rounds.find(round => round.roundId === item.roundId)?.terminalOutcome
            ? { terminalOutcome: capture.rounds.find(round => round.roundId === item.roundId)!.terminalOutcome } : {}) }]));
    const inheritedSources = activeRequirements(mergeRequirements(capture.view.nodes.map(node => node.unresolved)));
    const sourceCursor = (capture.view.requirementGuidanceCursor ?? 0) % Math.max(1, inheritedSources.length);
    const orderedSources = [...inheritedSources.slice(sourceCursor), ...inheritedSources.slice(0, sourceCursor)];
    const itemIds = [...new Set([...orderedSources.map(requirement => requirement.source.itemId), ...items.map(item => item.itemId)])];
    if (itemIds.length && port.readRequirementSourceMetadata) {
        const seen = new Set<string>();
        for (let offset = 0; offset < itemIds.length; offset += 64) {
            checkAbort(signal);
            const batchIds = itemIds.slice(offset, offset + 64);
            const metadata = await port.readRequirementSourceMetadata({ conversationId: capture.conversationId, historyEpoch: capture.historyEpoch, itemIds: batchIds });
            checkAbort(signal);
            if (metadata.historyEpoch !== capture.historyEpoch) throw new ContextFault('HISTORY_STALE', '要求来源元数据epoch已改变');
            for (const item of metadata.items) {
                if (!batchIds.includes(item.itemId) || seen.has(item.itemId) || !Number.isSafeInteger(item.seq) || item.seq < 1 || item.seq > capture.appendSeq
                    || !['user', 'assistant', 'tool', 'system'].includes(item.role)) throw new ContextFault('SOURCE_GAP', '要求来源元数据与冻结会话不一致');
                seen.add(item.itemId);
                const captured = requirementItems.get(item.itemId);
                if (captured && (captured.seq !== item.seq || captured.role !== item.role || captured.roundId !== item.roundId)) {
                    throw new ContextFault('SOURCE_GAP', '要求来源元数据与已冻结项目身份冲突');
                }
                const terminalOutcome = captured?.terminalOutcome ?? item.terminalOutcome;
                requirementItems.set(item.itemId, { ...item, ...(terminalOutcome ? { terminalOutcome } : {}) });
            }
        }
    }
    const snapshot: CompactionSnapshot = freezeValue({ candidateId, conversationId: capture.conversationId,
        runId: execution.runId, runEpoch: execution.runEpoch, compressionGeneration: capture.compressionGeneration,
        historyEpoch: capture.historyEpoch, snapshotAppendSeq: capture.appendSeq, parentViewRevision: capture.viewRevision,
        startRoundId: selected.targets[0].roundId, endRoundId: selected.targets.at(-1)!.roundId,
        coveredStartSeq: selected.targets[0].firstSeq, coveredEndSeq: selected.targets.at(-1)!.lastSeq,
        snapshotStepSeq: capture.stepSeq, targetReplaceStep: capture.stepSeq + 1 + config.policy.deltaSteps,
        sourceManifestHash: manifest.hash, sourcePrefixHash: manifest.prefixHash,
        sourceSpans: manifest.blocks.map(block => fullSpan(block)), parentBatchIds: capture.view.nodes.map(node => node.nodeId),
        compressionProfileRevision: config.model.profileRevision, effectiveModelFingerprint: config.modelFingerprint,
        configFingerprint: config.configFingerprint, sourceHistoryRoot: capture.historyRoot, workspaceRevision: capture.workspaceRevision,
        createdAt: new Date(input.now ?? Date.now()).toISOString(), manifest, referenceBlocks: references.blocks,
        execution: structuredClone(execution), config, requirementSourceMetadata: [...requirementItems.values()],
        ...(capture.view.communicationWindow ? { communicationWindow: capture.view.communicationWindow } : {}),
        ...(historyFeedback?.revision ? { historyFeedback } : {}) });
    return { candidateId, conversationId: capture.conversationId, state: 'snapshotting', reason: input.reason,
        snapshot, chunks: [], pendingRequest: null, failedResult: null, batch: null, folds: [], nextView: null, coverage: null, error: null,
        publishedViewRevision: null, publicationReceiptKey: null };
}

function fullSpan(block: SourceBlock): SourceSpan {
    return { itemId: block.itemId, blockId: block.blockId, startByte: 0, endByte: block.byteLength,
        sha256: block.sha256, blockHash: block.sha256, purpose: block.kind === 'nativeAnchor' ? 'nativeAnchor' : 'target' };
}

export async function verifyManifestSources(manifest: SourceManifest, sources: ContextSourcePort, maxBytes: number, signal?: AbortSignal): Promise<void> {
    if (hashContext({ blocks: manifest.blocks, rounds: manifest.rounds }) !== manifest.hash
        || hashContext(manifest.blocks.map(block => [block.itemId, block.blockId, block.seq, block.sha256, block.byteLength])) !== manifest.prefixHash) {
        throw new ContextFault('SOURCE_GAP', '来源清单或前缀哈希无效');
    }
    for (const block of manifest.blocks) {
        checkAbort(signal);
        const hash = createHash('sha256');
        for (let startByte = 0; startByte < block.byteLength; startByte += maxBytes) {
            hash.update(await readSourceFrame(sources, { block, startByte, endByte: Math.min(block.byteLength, startByte + maxBytes), maxBytes, signal }));
        }
        if (hash.digest('hex') !== block.sha256) throw new ContextFault('HISTORY_STALE', '目标来源块哈希与快照不一致', { itemId: block.itemId, blockId: block.blockId });
    }
}

interface TextPart { text: string; span: SourceSpan; sourceRoundId: string }

function spanFor(block: SourceBlock, startByte: number, bytes: Buffer, purpose: SourceSpan['purpose']): SourceSpan {
    return { itemId: block.itemId, blockId: block.blockId, startByte, endByte: startByte + bytes.length,
        sha256: hashBytes(bytes), blockHash: block.sha256, purpose };
}

async function readReferences(snapshot: CompactionSnapshot, sources: ContextSourcePort, countTokens: TokenCounter, signal: AbortSignal, referenceBudget: number): Promise<TextPart[]> {
    const parts: TextPart[] = [];
    if (referenceBudget <= 0) return parts;
    for (const block of snapshot.referenceBlocks) {
        checkAbort(signal);
        if (block.seq >= snapshot.coveredStartSeq || block.kind !== 'text' || !block.byteLength) continue;
        const frame = await readSourceFrame(sources, { block, startByte: 0,
            endByte: Math.min(block.byteLength, snapshot.config.policy.readFrameBytes), maxBytes: snapshot.config.policy.readFrameBytes, signal });
        let endByte = utf8Boundary(frame, frame.length);
        while (endByte > 0) {
            const bytes = frame.subarray(0, endByte);
            const part = { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), span: spanFor(block, 0, bytes, 'reference'), sourceRoundId: block.roundId };
            if (countTokens(canonicalJson([...parts, part])) <= referenceBudget) { parts.push(part); break; }
            endByte = utf8Boundary(frame, Math.floor(endByte * 0.8));
        }
    }
    return parts;
}

export async function* createCompressionChunks(input: {
    snapshot: CompactionSnapshot; sources: ContextSourcePort; blocks?: SourceBlock[]; priorGuidance?: string | (() => string);
    requirementAnchors?: () => RequirementAnchor[];
    semanticTail?: (roundId: string) => ReturnType<typeof semanticTailInput>;
    completedChunks?: readonly ChunkDigest[];
    prepareChunk?: (roundId: string, staticTokens: number, inputLimit: number) => Promise<void>;
    countTokens?: TokenCounter; signal: AbortSignal;
}): AsyncGenerator<CompressionChunk> {
    const { snapshot, sources, signal } = input;
    const countTokens = input.countTokens ?? conservativeTextTokens;
    const policy = snapshot.config.policy;
    const limits = computeContextLimits(snapshot.config.model.contextWindow, snapshot.config.model.maxOutputTokens, policy);
    const inputLimit = Math.min(policy.chunkInputTokens, limits.inputBudget - 1);
    const digestByteLimit = Math.max(1, Math.floor(inputLimit / 3));
    const guidance = () => typeof input.priorGuidance === 'function' ? input.priorGuidance() : input.priorGuidance ?? '';
    const references = input.blocks ? [] : await readReferences(snapshot, sources, countTokens, signal,
        Math.max(0, policy.referenceTokens - countTokens(guidance())));
    const blocks = input.blocks ?? snapshot.manifest.blocks;
    const roundIds = [...new Set(blocks.map(block => block.roundId))];
    const roundOutcomes = new Map(snapshot.manifest.rounds.filter(round => round.terminalOutcome).map(round => [round.roundId, round.terminalOutcome]));
    let currentRoundId = '';
    const body = (parts: TextPart[], anchors: SourceBlock[]) => canonicalJson({ rules: snapshot.config.rules,
        ...(input.semanticTail ? { semanticTail: input.semanticTail(currentRoundId) } : {}),
        ...(input.semanticTail ? { digestBudget: { maxUtf8Bytes: digestByteLimit,
            instructions: 'Aim to keep the encoded body/skeleton/title and any reorganizedTail together within maxUtf8Bytes. Preserve concrete facts and retrieval identities; do not accumulate earlier wording. This target leaves room for the next source delta.' } } : {}),
        taskStateOwner: 'main_model', legacyRequirementsReadOnly: true, taskPlanManaged: policy.taskPlanManaged,
        ...(snapshot.requestBudget ? { requestBudget: snapshot.requestBudget } : {}),
        priorGuidance: guidance(), references, targets: parts.map(part => roundOutcomes.has(part.sourceRoundId)
            ? { ...part, sourceRoundOutcome: roundOutcomes.get(part.sourceRoundId) } : part),
        anchors: anchors.map(anchor => ({ ...fullSpan(anchor), sourceRoundId: anchor.roundId,
            retrieval: anchor.retrieval, kind: anchor.kind, mediaType: anchor.mediaType ?? null })) });
    const finish = (roundId: string, parts: TextPart[], anchors: SourceBlock[]): CompressionChunk => {
        const text = body(parts, anchors);
        const inputTokens = countTokens(text);
        if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > inputLimit) throw new ContextFault('CONFIG_INVALID', '压缩规则、参考和来源头超出单块输入预算',
            { inputTokens, inputLimit, roundId, textParts: parts.length, emptyTextParts: parts.filter(part => !part.text.length).length,
                nativeAnchors: anchors.length, staticTokens: countTokens(body([], [])), rulesTokens: countTokens(snapshot.config.rules),
                priorGuidanceTokens: countTokens(guidance()), referenceTokens: countTokens(canonicalJson(references)) });
        const sourceSpans = [...parts.map(part => part.span), ...anchors.map(fullSpan)];
        return freezeValue({ chunkId: derivedContextId([snapshot.candidateId, roundId, sourceSpans]), roundId, sourceSpans,
            referenceSpans: references.map(part => part.span), anchors, body: text, inputBodyHash: hashBytes(text), inputTokens,
            ...(input.requirementAnchors ? { requirementAnchors: input.requirementAnchors() } : {}) });
    };
    const completedSpans = input.completedChunks?.flatMap(chunk => chunk.sourceSpans) ?? [];
    const completedOffset = (block: SourceBlock) => {
        const spans = completedSpans.filter(span => span.itemId === block.itemId && span.blockId === block.blockId)
            .sort((left, right) => left.startByte - right.startByte);
        let offset = 0;
        for (const span of spans) {
            if (span.blockHash !== block.sha256 || span.startByte !== offset || span.endByte < span.startByte || span.endByte > block.byteLength) {
                throw new ContextFault('SOURCE_GAP', '已知分块来源不是冻结原文的连续前缀');
            }
            offset = span.endByte;
        }
        return { offset, complete: spans.length > 0 && offset === block.byteLength };
    };
    const prepare = async (parts: TextPart[] = [], anchors: SourceBlock[] = []) => {
        await input.prepareChunk?.(currentRoundId, countTokens(body(parts, anchors)), inputLimit);
    };
    for (const roundId of roundIds) {
        currentRoundId = roundId;
        checkAbort(signal);
        const roundBlocks = blocks.filter(block => block.roundId === roundId && !completedOffset(block).complete);
        if (!roundBlocks.length) continue;
        await prepare();
        let anchors: SourceBlock[] = [];
        for (const anchor of roundBlocks.filter(block => block.kind === 'nativeAnchor')) {
            if (countTokens(body([], [...anchors, anchor])) > inputLimit) {
                if (!anchors.length) throw new ContextFault('CONFIG_INVALID', '单个原生检索锚点超过压缩输入预算');
                yield finish(roundId, [], anchors);
                anchors = [];
                await prepare();
            }
            if (countTokens(body([], [anchor])) > inputLimit) await prepare([], [anchor]);
            if (countTokens(body([], [anchor])) > inputLimit) throw new ContextFault('CONFIG_INVALID', '单个原生检索锚点及当前末段超过压缩输入预算',
                { inputLimit, staticTokens: countTokens(body([], [])), itemId: anchor.itemId, blockId: anchor.blockId });
            anchors.push(anchor);
        }
        let parts: TextPart[] = [];
        for (const block of roundBlocks.filter(entry => entry.kind === 'text')) {
            let offset = completedOffset(block).offset;
            if (!block.byteLength) {
                const empty = { text: '', span: spanFor(block, 0, Buffer.alloc(0), 'target'), sourceRoundId: block.roundId };
                if (countTokens(body([...parts, empty], anchors)) > inputLimit && (parts.length || anchors.length)) {
                    yield finish(roundId, parts, anchors);
                    parts = [];
                    anchors = [];
                    await prepare();
                }
                if (countTokens(body([empty], [])) > inputLimit) await prepare([empty]);
                if (countTokens(body([empty], [])) > inputLimit) throw new ContextFault('CONFIG_INVALID', '单个空文本的来源头已超过压缩输入预算',
                    { inputLimit, staticTokens: countTokens(body([], [])), itemId: block.itemId, blockId: block.blockId });
                parts.push(empty);
            }
            while (offset < block.byteLength) {
                checkAbort(signal);
                const frame = await readSourceFrame(sources, { block, startByte: offset,
                    endByte: Math.min(block.byteLength, offset + policy.readFrameBytes), maxBytes: policy.readFrameBytes, signal });
                const available = utf8Boundary(frame, frame.length);
                if (!available) throw new ContextFault('SOURCE_GAP', '来源帧无法形成完整UTF-8字符', { itemId: block.itemId, blockId: block.blockId, offset });
                if (!parts.length && !anchors.length && input.prepareChunk) {
                    let firstEnd = 1;
                    while (!utf8Boundary(frame, firstEnd)) firstEnd++;
                    const bytes = frame.subarray(0, firstEnd);
                    let text: string;
                    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
                    catch { throw new ContextFault('SOURCE_GAP', '目标文本包含无效UTF-8', { itemId: block.itemId, blockId: block.blockId, offset }); }
                    const minimum = { text, span: spanFor(block, offset, bytes, 'target'), sourceRoundId: block.roundId };
                    if (countTokens(body([minimum], [])) > inputLimit) await prepare([minimum]);
                }
                let low = 1;
                let high = available;
                let fitted = 0;
                while (low <= high) {
                    const midpoint = Math.floor((low + high) / 2);
                    const endByte = utf8Boundary(frame, midpoint);
                    if (!endByte) { low = midpoint + 1; continue; }
                    const bytes = frame.subarray(0, endByte);
                    let text: string;
                    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
                    catch { throw new ContextFault('SOURCE_GAP', '目标文本包含无效UTF-8', { itemId: block.itemId, blockId: block.blockId, offset }); }
                    const proposed = { text, span: spanFor(block, offset, bytes, 'target'), sourceRoundId: block.roundId };
                    if (countTokens(body([...parts, proposed], anchors)) <= inputLimit) { fitted = endByte; low = midpoint + 1; }
                    else high = midpoint - 1;
                }
                if (!fitted) {
                    if (!parts.length && !anchors.length) throw new ContextFault('CONFIG_INVALID', '单个文本字符及来源头已超过压缩输入预算');
                    yield finish(roundId, parts, anchors);
                    parts = [];
                    anchors = [];
                    await prepare();
                    continue;
                }
                const bytes = frame.subarray(0, fitted);
                parts.push({ text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), span: spanFor(block, offset, bytes, 'target'), sourceRoundId: block.roundId });
                offset += fitted;
                if (offset < block.byteLength) {
                    yield finish(roundId, parts, anchors);
                    parts = [];
                    anchors = [];
                    await prepare();
                }
            }
        }
        if (parts.length || anchors.length) yield finish(roundId, parts, anchors);
    }
}

export function factsOnlyCompressionResult<Result extends CompressionResult>(result: Result): Result {
    const { resolutions: _resolutions, ...digest } = result.digest;
    return { ...result, digest: { ...digest, unresolved: [] } };
}

export function validateCompressionResult(request: CompressionRequest, result: CompressionResult): void {
    if ((result.attemptId !== request.attemptId && result.requestAttemptId !== request.attemptId) || result.inputBodyHash !== request.chunk.inputBodyHash
        || result.modelFingerprint !== request.snapshot.effectiveModelFingerprint) throw new ContextFault('USAGE_MISMATCH', '压缩结果与冻结请求身份不一致', { attemptId: request.attemptId }, true);
    if (!result.complete || !result.digest || typeof result.digest.body !== 'string' || !result.digest.body.trim()
        || typeof result.digest.skeleton !== 'string' || typeof result.digest.title !== 'string'
        || !Array.isArray(result.digest.unresolved) || !Array.isArray(result.coverage)) {
        const usage = result.usage && typeof result.usage === 'object' && !Array.isArray(result.usage) ? result.usage : null;
        const boundTerminal = !result.complete && result.requestAttemptId === request.attemptId
            && usage?.requestAttemptId === request.attemptId && usage.providerAttemptId === result.attemptId
            && usage.providerComplete === true;
        const outputTruncated = boundTerminal && usage.providerOutputTruncated === true && usage.providerStop === 'truncated';
        const knownInvalidDigest = outputTruncated || boundTerminal && usage.validationRepairEligible === true
            && usage.providerStop === 'completed' && typeof usage.digestValidation === 'string'
            && !!usage.digestValidation && usage.digestValidation !== 'valid';
        throw new ContextFault('SOURCE_GAP', outputTruncated ? '压缩模型输出达到本次输出上限而截断，原响应及费用记录已保留，请调整压缩模型参数或输出预算后明确继续' : '压缩模型未返回完整、可核验的摘要结构',
            { attemptId: request.attemptId, ...(knownInvalidDigest ? { knownInvalidDigest: true } : {}),
                ...(outputTruncated ? { compressionOutputTruncated: true } : {}) }, !knownInvalidDigest);
    }
    if (request.chunk.digestByteLimit !== undefined
        && Buffer.byteLength(canonicalJson(semanticDigestText(result.digest))) > request.chunk.digestByteLimit) {
        throw new ContextFault('SOURCE_GAP', '压缩摘要超过本次末段长度预算，原响应及费用记录已保留',
            { attemptId: request.attemptId, knownInvalidDigest: true, digestBudgetExceeded: true,
                digestByteLimit: request.chunk.digestByteLimit });
    }
    const requested = new Set(request.chunk.sourceSpans.map(span => hashContext(span)));
    const seen = new Set<string>();
    for (const entry of result.coverage) {
        const key = hashContext(entry.span);
        if (!requested.has(key) || seen.has(key) || !['complete', 'partial', 'anchorOnly'].includes(entry.status)
            || !Array.isArray(entry.gaps) || entry.gaps.some(gap => !Number.isSafeInteger(gap.startByte) || !Number.isSafeInteger(gap.endByte)
                || gap.startByte < entry.span.startByte || gap.endByte > entry.span.endByte || gap.endByte <= gap.startByte)) {
            throw new ContextFault('SOURCE_GAP', '模型端返回的实际输入覆盖清单与请求冲突', { attemptId: request.attemptId }, true);
        }
        if (entry.status === 'complete' && entry.gaps.length) throw new ContextFault('SOURCE_GAP', '完整覆盖条目仍含缺口', { attemptId: request.attemptId }, true);
        seen.add(key);
    }
}

export function validateCoverage(manifest: SourceManifest, chunks: ChunkDigest[], priorCoveredEndSeq = 0): CoverageReport {
    const entries = chunks.flatMap(chunk => chunk.coverage);
    const gaps: CoverageReport['gaps'] = [];
    const incomplete = new Set<string>();
    const anchorOnly: SourceBlock[] = [];
    for (const block of manifest.blocks) {
        const applicable = entries.filter(entry => entry.span.itemId === block.itemId && entry.span.blockId === block.blockId
            && entry.span.blockHash === block.sha256 && entry.span.purpose !== 'reference');
        if (block.kind === 'nativeAnchor') {
            if (applicable.some(entry => entry.span.purpose === 'nativeAnchor' && entry.span.startByte === 0 && entry.span.endByte === block.byteLength
                && entry.span.sha256 === block.sha256 && entry.gaps.length === 0 && ['complete', 'anchorOnly'].includes(entry.status))) anchorOnly.push(block);
            else { gaps.push({ itemId: block.itemId, blockId: block.blockId, startByte: 0, endByte: block.byteLength, reason: 'native anchor missing' }); incomplete.add(block.roundId); }
            continue;
        }
        const ranges = applicable.filter(entry => entry.status === 'complete' && !entry.gaps.length && entry.span.purpose === 'target')
            .map(entry => [entry.span.startByte, entry.span.endByte] as const).sort((left, right) => left[0] - right[0]);
        let cursor = 0;
        for (const [startByte, endByte] of ranges) {
            if (startByte < 0 || endByte < startByte || endByte > block.byteLength) throw new ContextFault('SOURCE_GAP', '摘要覆盖区间超过原文块');
            if (startByte > cursor) gaps.push({ itemId: block.itemId, blockId: block.blockId, startByte: cursor, endByte: startByte, reason: 'text range missing' });
            cursor = Math.max(cursor, endByte);
        }
        if (cursor < block.byteLength || (!block.byteLength && !ranges.length)) {
            gaps.push({ itemId: block.itemId, blockId: block.blockId, startByte: cursor, endByte: block.byteLength, reason: 'text tail missing' });
        }
        if (gaps.some(gap => gap.itemId === block.itemId && gap.blockId === block.blockId)) incomplete.add(block.roundId);
    }
    const completeRoundIds: string[] = [];
    let coveredEndSeq = priorCoveredEndSeq;
    for (const round of manifest.rounds) {
        if (incomplete.has(round.roundId) || !round.complete || round.nativePairing !== 'complete') break;
        completeRoundIds.push(round.roundId);
        coveredEndSeq = round.lastSeq;
    }
    return { completeRoundIds, coveredEndSeq, gaps, anchorOnly };
}

function chunkComplete(chunk: Pick<CompressionChunk, 'sourceSpans'>, result: CompressionResult): boolean {
    return chunk.sourceSpans.every(span => result.coverage.some(entry => hashContext(entry.span) === hashContext(span)
        && !entry.gaps.length && (entry.status === 'complete' || (span.purpose === 'nativeAnchor' && entry.status === 'anchorOnly'))));
}

export async function verifyRequirements(requirements: RequirementAnchor[], snapshot: CompactionSnapshot, sources: ContextSourcePort, signal: AbortSignal): Promise<void> {
    for (const requirement of requirements) {
        if (!requirement || typeof requirement.id !== 'string' || !requirement.id || typeof requirement.quote !== 'string' || !requirement.source) {
            throw new ContextFault('SOURCE_GAP', '未决要求缺少原句或来源');
        }
        const block = snapshot.manifest.blocks.find(entry => entry.itemId === requirement.source.itemId && entry.blockId === requirement.source.blockId);
        if (!block || block.kind !== 'text' || requirement.source.purpose !== 'target' || requirement.source.blockHash !== block.sha256
            || requirement.source.endByte - requirement.source.startByte > snapshot.config.policy.readFrameBytes) {
            throw new ContextFault('SOURCE_GAP', '新增未决要求的原句必须来自本次目标文本', { requirementId: requirement.id });
        }
        const bytes = await readSourceFrame(sources, { block, startByte: requirement.source.startByte, endByte: requirement.source.endByte,
            maxBytes: snapshot.config.policy.readFrameBytes, signal });
        if (hashBytes(bytes) !== requirement.source.sha256 || bytes.toString('utf8') !== requirement.quote) {
            throw new ContextFault('SOURCE_GAP', '未决要求原句与来源字节不一致', { requirementId: requirement.id });
        }
    }
}

function validateRequestBudgetIdentity(snapshot: CompactionSnapshot, measured: { modelId: string; adapterVersion: string | null }): void {
    if (snapshot.requestBudget && (measured.modelId !== snapshot.requestBudget.modelId
        || measured.adapterVersion !== snapshot.requestBudget.adapterVersion)) {
        throw new ContextFault('MODEL_STALE', '完整请求重估与冻结摘要预算的前台模型或适配器身份不同',
            { expectedModelId: snapshot.requestBudget.modelId, modelId: measured.modelId,
                expectedAdapterVersion: snapshot.requestBudget.adapterVersion, adapterVersion: measured.adapterVersion });
    }
}

export async function fitCompactionSummary(input: { snapshot: CompactionSnapshot; nodes: SummaryNode[]; coveredEndSeq: number;
    countTokens?: TokenCounter; summaryBudget?: number; estimateCompaction?: CompactionViewEstimator; signal?: AbortSignal;
    communicationWindow?: SummaryView['communicationWindow'] }) {
    const countTokens = input.countTokens ?? conservativeTextTokens;
    const limits = computeContextLimits(input.snapshot.config.model.contextWindow, input.snapshot.config.model.maxOutputTokens, input.snapshot.config.policy);
    let budget = Math.min(limits.summaryBudget, input.snapshot.requestBudget?.summaryBudget ?? limits.summaryBudget,
        input.summaryBudget ?? limits.summaryBudget);
    const minimumRecord = renderSummary(input.nodes, input.snapshot.config.policy, Number.MAX_SAFE_INTEGER, countTokens,
        input.nodes.map(node => ({ nodeId: node.nodeId, level: 'title' as const }))).tokens;
    let safeFit: { rendered: ReturnType<typeof renderSummaryView>; budget: number; fitEvidence: NonNullable<SummaryView['fitEvidence']> } | undefined;
    while (true) {
        let rendered: ReturnType<typeof renderSummaryView>;
        try {
            rendered = renderSummaryView({ nodes: input.nodes, communicationWindow: input.communicationWindow }, input.snapshot.config.policy, budget, countTokens);
        }
        catch (error) {
            if (safeFit && error instanceof ContextFault && error.code === 'CONTEXT_SUMMARY_BUDGET') {
                const current = await input.estimateCompaction!(input.snapshot, { coveredEndSeq: input.coveredEndSeq,
                    text: safeFit.rendered.text, tokens: safeFit.rendered.tokens }, input.signal);
                validateRequestBudgetIdentity(input.snapshot, current);
                const inputTokens = totalContextTokens(current.estimate);
                if (typeof safeFit.fitEvidence.inputBudget !== 'number' || inputTokens >= safeFit.fitEvidence.inputBudget) {
                    throw new ContextFault('SUMMARY_BUDGET', '摘要最小表示的最新完整输入已达到安全输入预算',
                        { inputTokens, inputBudget: safeFit.fitEvidence.inputBudget, target: safeFit.fitEvidence.target });
                }
                return { ...safeFit, fitEvidence: { ...safeFit.fitEvidence, inputTokens,
                    targetReached: inputTokens < safeFit.fitEvidence.target, optimizationStoppedAtMinimum: true } };
            }
            throw error;
        }
        if (!input.estimateCompaction || !input.snapshot.requestBudget) return { rendered, budget, fitEvidence: undefined };
        const measured = await input.estimateCompaction(input.snapshot, { coveredEndSeq: input.coveredEndSeq, text: rendered.text, tokens: rendered.tokens }, input.signal);
        validateRequestBudgetIdentity(input.snapshot, measured);
        const inputTokens = totalContextTokens(measured.estimate);
        const { target, inputBudget } = input.snapshot.requestBudget;
        const validInputBudget = typeof inputBudget === 'number' && Number.isSafeInteger(inputBudget) && inputBudget > target;
        const fitEvidence = { inputTokens, target, inputBudget: validInputBudget ? inputBudget : null, targetReached: inputTokens < target };
        if (fitEvidence.targetReached) return { rendered, budget, fitEvidence };
        if (validInputBudget && inputTokens < inputBudget && input.snapshot.requestBudget.fixedInputTokens >= target) {
            return { rendered, budget, fitEvidence: { ...fitEvidence, optimizationStoppedAtMinimum: false } };
        }
        if (validInputBudget && inputTokens < inputBudget) safeFit = { rendered, budget, fitEvidence };
        const nextBudget = Math.max(minimumRecord, rendered.tokens - Math.max(1, inputTokens - target + 1));
        if (nextBudget >= budget) {
            if (safeFit && inputTokens < Number(inputBudget)) return { ...safeFit,
                fitEvidence: { ...safeFit.fitEvidence, optimizationStoppedAtMinimum: true } };
            throw new ContextFault('SUMMARY_BUDGET', '摘要最小表示的完整输入已达到安全输入预算',
                { inputTokens, inputBudget, target, summaryBudget: budget });
        }
        budget = nextBudget;
    }
}

export async function generateCompaction(input: {
    candidate: CompactionCandidate; priorView: SummaryView; port: CompactionPort; sources: ContextSourcePort;
    model: CompressionModelPort; signal: AbortSignal; countTokens?: TokenCounter; now?: () => number; estimateCompaction?: CompactionViewEstimator;
}): Promise<CompactionCandidate> {
    const { candidate, priorView, port, sources, model, signal } = input;
    const snapshot = candidate.snapshot;
    const countTokens = input.countTokens ?? conservativeTextTokens;
    const now = input.now ?? Date.now;
    const inherited = mergeRequirements(priorView.nodes.map(node => node.unresolved));
    let semanticNodes = priorView.nodes;
    candidate.chunks = candidate.chunks.map(chunk => freezeValue(factsOnlyCompressionResult(chunk)));
    let guidanceCursor = priorView.requirementGuidanceCursor ?? 0;
    const usefulHistory: NonNullable<CompactionSnapshot['historyFeedback']>['entries'] = [];
    for (const entry of [...(snapshot.historyFeedback?.entries ?? [])].sort((left, right) => right.lastHitStep - left.lastHitStep || right.hitCount - left.hitCount)) {
        if (countTokens(canonicalJson({ summaries: [], usefulHistory: [...usefulHistory, entry], unresolvedCount: inherited.length })) <= snapshot.config.policy.referenceTokens) usefulHistory.push(entry);
    }
    const feedbackGuidance = usefulHistory.length ? { usefulHistory } : {};
    const guidanceNodes: { nodeId: string; hash: string; title: string }[] = [];
    for (const node of priorView.nodes) {
        const next = { nodeId: node.nodeId, hash: node.hash, title: node.title };
        if (countTokens(canonicalJson({ summaries: [...guidanceNodes, next], unresolvedCount: inherited.length, ...feedbackGuidance })) <= snapshot.config.policy.referenceTokens) guidanceNodes.push(next);
        else break;
    }
    const priorGuidance = () => {
        const selected = boundedRequirementGuidance(inherited, Math.floor(snapshot.config.policy.referenceTokens * 0.75), countTokens, guidanceCursor);
        const base = { summaries: [] as typeof guidanceNodes, unresolvedCount: activeRequirements(inherited).length,
            legacyRequirementsReadOnly: true, handoffRequirements: selected.map(({ id, quote }) => ({ id, quote })) };
        const useful: typeof usefulHistory = [];
        for (const entry of usefulHistory) {
            if (countTokens(canonicalJson({ ...base, usefulHistory: [...useful, entry] })) <= snapshot.config.policy.referenceTokens) useful.push(entry);
        }
        for (const node of guidanceNodes) {
            if (countTokens(canonicalJson({ ...base, summaries: [...base.summaries, node], usefulHistory: useful })) <= snapshot.config.policy.referenceTokens) base.summaries.push(node);
        }
        return canonicalJson({ ...base, ...(useful.length ? { usefulHistory: useful } : {}) });
    };
    const runChunk = async (chunk: CompressionChunk, reason: CompactionReason): Promise<ChunkDigest> => {
        checkAbort(signal);
        if (now() >= Date.parse(snapshot.execution.deadlineAt)) throw new ContextFault('CONFIG_INVALID', '根任务期限已到，停止新增压缩请求');
        const existing = candidate.chunks.find(entry => entry.chunkId === chunk.chunkId);
        if (existing) {
            if (existing.inputBodyHash !== chunk.inputBodyHash) throw new ContextFault('SOURCE_GAP', '恢复块与原冻结输入不一致');
            if (reason !== 'fold') {
                guidanceCursor += Math.max(1, chunk.requirementAnchors?.length ?? 0);
            }
            return existing;
        }
        if (candidate.pendingRequest) throw new ContextFault('ATTEMPT_UNKNOWN', '原压缩attempt尚未查明，暂停新增请求', { attemptId: candidate.pendingRequest.attemptId }, true);
        validatePublication(candidate, await port.inspect(candidate.conversationId), snapshot.sourcePrefixHash);
        if (candidate.validationRepair?.request.chunk.chunkId === chunk.chunkId) {
            throw new ContextFault('SOURCE_GAP', '该候选分块的一次结构纠错已经使用，保持原失败结果');
        }
        let request = freezeValue<CompressionRequest>({ attemptId: randomUUID(), actionId: randomUUID(), stepId: randomUUID(),
            reason, originReason: candidate.reason, execution: snapshot.execution, snapshot, model: snapshot.config.model, chunk,
            maxOutputTokens: snapshot.config.model.maxOutputTokens, inputBodyHash: chunk.inputBodyHash });
        let result: CompressionResult;
        for (;;) {
            checkAbort(signal);
            if (now() >= Date.parse(snapshot.execution.deadlineAt)) throw new ContextFault('CONFIG_INVALID', '根任务期限已到，停止新增压缩请求');
            candidate.pendingRequest = request;
            await port.saveCandidate(structuredClone(candidate));
            checkAbort(signal);
            result = await model.generate(request, signal);
            checkAbort(signal);
            try {
                validateCompressionResult(request, result);
                break;
            } catch (error) {
                candidate.failedResult = structuredClone(result);
                await port.saveCandidate(structuredClone(candidate));
                candidate.pendingRequest = null;
                const usage = result.usage && typeof result.usage === 'object' && !Array.isArray(result.usage) ? result.usage : null;
                if (candidate.validationRepair || request.validationRepair || result.complete || usage?.validationRepairEligible !== true
                    || typeof usage.digestValidation !== 'string' || !usage.digestValidation
                    || result.requestAttemptId !== request.attemptId || result.inputBodyHash !== chunk.inputBodyHash
                    || result.modelFingerprint !== snapshot.effectiveModelFingerprint
                    || !(error instanceof ContextFault) || error.code !== 'CONTEXT_SOURCE_GAP') throw error;
                checkAbort(signal);
                if (now() >= Date.parse(snapshot.execution.deadlineAt)) throw error;
                validatePublication(candidate, await port.inspect(candidate.conversationId), snapshot.sourcePrefixHash);
                const repair = freezeValue<CompressionRequest>({ ...request, attemptId: randomUUID(), actionId: randomUUID(), stepId: randomUUID(),
                    validationRepair: { previousAttemptId: request.attemptId, validationError: usage.digestValidation,
                        previousResponse: result.digest.body } });
                candidate.validationRepair = { request, failedResult: structuredClone(result), repairAttemptId: repair.attemptId };
                request = repair;
            }
        }
        const digest: ChunkDigest = freezeValue({ ...structuredClone(factsOnlyCompressionResult(result)), chunkId: chunk.chunkId, roundId: chunk.roundId,
            sourceSpans: chunk.sourceSpans, anchors: chunk.anchors });
        candidate.chunks.push(digest);
        if (reason !== 'fold') guidanceCursor += Math.max(1, chunk.requirementAnchors?.length ?? 0);
        candidate.pendingRequest = null;
        await port.saveCandidate(structuredClone(candidate));
        return digest;
    };
    try {
        candidate.state = 'generating';
        await port.saveCandidate(structuredClone(candidate));
        if (candidate.pendingRequest) throw new ContextFault('ATTEMPT_UNKNOWN', '原压缩attempt尚未查明，保持原请求并停止新增请求',
            { attemptId: candidate.pendingRequest.attemptId }, true);
        await verifyManifestSources(snapshot.manifest, sources, snapshot.config.policy.readFrameBytes, signal);
        const targetRoundIds = new Set(snapshot.manifest.rounds.map(round => round.roundId));
        const reorganizations = () => candidate.semanticTailReorganizations
            ?? (candidate.semanticTailReorganization ? [candidate.semanticTailReorganization] : []);
        const sourceChunks = () => candidate.chunks.filter(chunk => targetRoundIds.has(chunk.roundId)
            && !reorganizations().some(event => event.chunkId === chunk.chunkId));
        const replay = (chunks: ChunkDigest[]) => replaySemanticChunks(priorView.nodes, chunks, snapshot, reorganizations(), candidate.chunks);
        const completed = sourceChunks();
        for (const chunk of completed) {
            if (!chunkComplete(chunk, chunk)) break;
            if (chunk.modelFingerprint !== snapshot.effectiveModelFingerprint) throw new ContextFault('MODEL_STALE', '已知分块与冻结模型身份不同');
            for (const span of chunk.sourceSpans) {
                const block = snapshot.manifest.blocks.find(entry => entry.itemId === span.itemId && entry.blockId === span.blockId);
                if (!block || block.roundId !== chunk.roundId || span.blockHash !== block.sha256
                    || !Number.isSafeInteger(span.startByte) || !Number.isSafeInteger(span.endByte)
                    || span.startByte < 0 || span.endByte < span.startByte || span.endByte > block.byteLength
                    || span.purpose !== (block.kind === 'nativeAnchor' ? 'nativeAnchor' : 'target')) {
                    throw new ContextFault('SOURCE_GAP', '已知分块与冻结原文范围不一致');
                }
                const hash = createHash('sha256');
                for (let offset = span.startByte; offset < span.endByte; offset += snapshot.config.policy.readFrameBytes) {
                    hash.update(await readSourceFrame(sources, { block, startByte: offset,
                        endByte: Math.min(span.endByte, offset + snapshot.config.policy.readFrameBytes),
                        maxBytes: snapshot.config.policy.readFrameBytes, signal }));
                }
                if (hash.digest('hex') !== span.sha256) throw new ContextFault('HISTORY_STALE', '已知分块的实际来源字节与冻结指纹不同');
            }
            guidanceCursor += Math.max(1, boundedRequirementGuidance(inherited,
                Math.floor(snapshot.config.policy.referenceTokens * 0.75), countTokens, guidanceCursor).length);
        }
        semanticNodes = replay(completed.filter(chunk => chunkComplete(chunk, chunk)));
        const prepareChunk = async (_roundId: string, staticTokens: number, inputLimit: number) => {
            const tail = semanticNodes.at(-1);
            const digestByteLimit = Math.max(1, Math.floor(inputLimit / 3));
            if (!tail || Buffer.byteLength(canonicalJson(semanticDigestText(tail))) <= digestByteLimit && staticTokens <= inputLimit) return;
            const afterChunkId = sourceChunks().at(-1)?.chunkId ?? null;
            const previous = reorganizations().find(event => event.afterChunkId === afterChunkId && event.nodeId === tail.nodeId);
            if (previous) {
                if (candidate.chunks.some(chunk => chunk.chunkId === previous.chunkId && chunk.complete)) return;
                throw new ContextFault('CONFIG_INVALID', '同一末段来源的一次重整已经使用，停止重复请求',
                    { inputLimit, staticTokens, chunkId: previous.chunkId });
            }
            const body = canonicalJson({ rules: snapshot.config.rules, semanticTail: {
                body: tail.body, skeleton: tail.skeleton, title: tail.title, retrieval: { nodeId: tail.nodeId, hash: tail.hash } },
                taskStateOwner: 'main_model', legacyRequirementsReadOnly: true, targets: [], anchors: [],
                digestBudget: { maxUtf8Bytes: digestByteLimit,
                    instructions: 'Reorganize only the supplied known tail. Return body/skeleton/title within this combined encoded UTF-8 byte limit. Preserve concrete facts and retrieval identities; earlier segments and source coverage remain unchanged.' } });
            const inputTokens = countTokens(body);
            if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > inputLimit) {
                throw new ContextFault('CONFIG_INVALID', '已知末段的完整重整请求超过单块输入预算，原结果保持', { inputTokens, inputLimit });
            }
            const inputBodyHash = hashBytes(body);
            const chunkId = derivedContextId([candidate.candidateId, 'semantic-tail-reorganization', tail.nodeId, tail.hash]);
            candidate.semanticTailReorganizations = [...reorganizations(), { chunkId, afterChunkId,
                nodeId: tail.nodeId, hash: tail.hash, inputBodyHash }];
            await runChunk(freezeValue({ chunkId, roundId: `tail-reorganization:${tail.nodeId}`, sourceSpans: [], referenceSpans: [],
                anchors: [], body, inputBodyHash, inputTokens, digestByteLimit }), 'fold');
            semanticNodes = replay(sourceChunks());
        };
        const hasIncompleteChunk = completed.some(chunk => !chunkComplete(chunk, chunk));
        for await (const chunk of hasIncompleteChunk ? [] : createCompressionChunks({ snapshot, sources, priorGuidance, countTokens, signal,
            completedChunks: completed, prepareChunk,
            semanticTail: (roundId: string) => semanticTailInput(semanticNodes, roundId),
            requirementAnchors: () => boundedRequirementGuidance(inherited, Math.floor(snapshot.config.policy.referenceTokens * 0.75), countTokens, guidanceCursor) })) {
            const digest = await runChunk(chunk, candidate.reason);
            if (!chunkComplete(chunk, digest)) break;
            semanticNodes = applySemanticChunk(semanticNodes, digest, snapshot);
        }
        const coverage = validateCoverage(snapshot.manifest, candidate.chunks, priorView.coveredEndSeq);
        candidate.coverage = coverage;
        if (!coverage.completeRoundIds.length) throw new ContextFault('SOURCE_GAP', '目标来源未完整覆盖一个连续整轮，保持原发送视图', { coverage });
        const accepted = new Set(coverage.completeRoundIds);
        const chunks = candidate.chunks.filter(chunk => accepted.has(chunk.roundId));
        let nodes = replay(chunks);
        const last = nodes.at(-1)!;
        if (last.kind !== 'batch') throw new ContextFault('SOURCE_GAP', '语义增量末节点须为可独立发布的新批');
        candidate.batch = last;
        const communicationWindow = await updateCommunicationWindow({ previous: priorView.communicationWindow,
            snapshot, nodes, coveredEndSeq: coverage.coveredEndSeq, sources, signal });
        const limits = computeContextLimits(snapshot.config.model.contextWindow, snapshot.config.model.maxOutputTokens, snapshot.config.policy);
        let foldBudget = Math.min(limits.summaryBudget, input.estimateCompaction ? limits.summaryBudget
            : snapshot.requestBudget?.summaryBudget ?? limits.summaryBudget);
        if (input.estimateCompaction && snapshot.requestBudget) {
            const full = renderSummary(nodes, snapshot.config.policy, Number.MAX_SAFE_INTEGER, countTokens);
            const measured = await input.estimateCompaction(snapshot, { coveredEndSeq: coverage.coveredEndSeq, text: full.text, tokens: full.tokens }, signal);
            validateRequestBudgetIdentity(snapshot, measured);
            if (totalContextTokens(measured.estimate) >= snapshot.requestBudget.target) foldBudget = Math.min(foldBudget, full.tokens - 1);
        }
        const plan = planSummaryFold(nodes, snapshot.config.policy, foldBudget, countTokens);
        if (plan) {
            const foldBytes = new Map<string, Buffer>();
            const foldBlocks: SourceBlock[] = plan.children.map(node => {
                const bytes = Buffer.from(canonicalJson({ body: node.body, skeleton: node.skeleton, title: node.title,
                    sourceNodeId: node.nodeId, sourceRoundIds: node.roundIds, feedbackSourceNodeIds: feedbackSourceNodeIds(node),
                    legacyRequirementHandoff: node.unresolved, anchors: node.anchors, sourceSpans: node.sourceSpans }), 'utf8');
                foldBytes.set(node.nodeId, bytes);
                return { itemId: node.nodeId, blockId: 'summary', contentId: node.nodeId, seq: node.firstSeq, roundId: `fold:${node.nodeId}`,
                    kind: 'text', byteLength: bytes.length, sha256: hashBytes(bytes), retrieval: { summaryId: node.nodeId, hash: node.hash } };
            });
            const foldSources: ContextSourcePort = { describe: async () => foldBlocks,
                read: async request => foldBytes.get(request.block.itemId)!.subarray(request.startByte, request.endByte) };
            const foldedChunks: ChunkDigest[] = [];
            for await (const chunk of createCompressionChunks({ snapshot, sources: foldSources, blocks: foldBlocks, countTokens, signal,
                priorGuidance: priorGuidance() })) {
                const digest = await runChunk(chunk, 'fold');
                if (!chunkComplete(chunk, digest)) throw new ContextFault('SOURCE_GAP', '折叠输入存在覆盖缺口，保留原批及旧视图');
                foldedChunks.push(digest);
            }
            const requirements = mergeRequirements(plan.children.map(node => node.unresolved));
            const fold = sealSummaryNode<FoldNode>({ kind: 'fold', nodeId: derivedContextId([candidate.candidateId, 'fold', plan.children.map(node => node.hash)]),
                firstSeq: plan.children[0].firstSeq, lastSeq: plan.children.at(-1)!.lastSeq,
                roundIds: plan.children.flatMap(node => node.roundIds), sourceSpans: plan.children.flatMap(node => node.sourceSpans),
                chunkIds: foldedChunks.map(chunk => chunk.chunkId), parentBatchIds: plan.children.map(node => node.nodeId),
                modelFingerprint: snapshot.effectiveModelFingerprint, anchors: plan.children.flatMap(node => node.anchors),
                body: foldedChunks.map(chunk => chunk.digest.body).join('\n\n'), skeleton: foldedChunks.map(chunk => chunk.digest.skeleton).join('\n\n'),
                title: foldedChunks.map(chunk => chunk.digest.title).join(' / '), unresolved: requirements,
                feedbackSourceNodeIds: [...new Set(plan.children.flatMap(feedbackSourceNodeIds))],
                children: plan.children.map(node => ({ nodeId: node.nodeId, hash: node.hash, firstSeq: node.firstSeq, lastSeq: node.lastSeq })) });
            candidate.folds = [fold];
            nodes = applySummaryFold(nodes, plan, fold);
            if (nodes.length > snapshot.config.policy.maxActiveNodes) throw new ContextFault('SUMMARY_BUDGET', '折叠后活动节点仍超过上限');
        }
        const fitted = await fitCompactionSummary({ snapshot, nodes, coveredEndSeq: coverage.coveredEndSeq,
            countTokens, estimateCompaction: input.estimateCompaction, signal, communicationWindow });
        candidate.nextView = freezeValue({ revision: priorView.revision + 1, historyEpoch: snapshot.historyEpoch,
            coveredEndSeq: coverage.coveredEndSeq, nodes, requirementGuidanceCursor: guidanceCursor % Math.max(1, activeRequirements(inherited).length),
            renderedLevels: fitted.rendered.levels,
            ...(fitted.rendered.communicationRendering ? { communicationRendering: fitted.rendered.communicationRendering } : {}),
            ...(communicationWindow ? { communicationWindow } : {}),
            summaryBudget: fitted.budget,
            ...(fitted.fitEvidence ? { fitEvidence: fitted.fitEvidence } : {}) });
        checkAbort(signal);
        candidate.state = 'ready';
        await port.saveCandidate(structuredClone(candidate));
        return candidate;
    } catch (error) {
        if (signal.aborted) throw error;
        candidate.error = contextFailure(error);
        if (candidate.pendingRequest && error instanceof AgentFault && !error.mayHaveStarted
            && error.details?.budgetReservationRejected === true
            && error.details.compressionRequestAttemptId === candidate.pendingRequest.attemptId
            && error.details.rootBudgetId === candidate.pendingRequest.execution.rootBudgetId) {
            candidate.pendingRequest = null;
        }
        candidate.state = candidate.pendingRequest && (candidate.error.mayHaveStarted || candidate.error.code === 'CONTEXT_INTERNAL') ? 'unknown' : 'failed';
        await port.saveCandidate(structuredClone(candidate));
        throw error;
    } finally {
        sources.releaseCached?.([...snapshot.manifest.blocks, ...snapshot.referenceBlocks]);
    }
}
