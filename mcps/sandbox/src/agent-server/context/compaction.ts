import { createHash, randomUUID } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { CompactionCandidate, CompactionPort, CompactionReason, CompactionSnapshot, CompressionChunk, CompressionModelPort,
    CompressionRequest, CompressionResult, ContextCapture, ContextSourcePort, CoverageReport, ExecutionLease, FoldNode,
    FrozenCompressionConfig, RequirementAnchor, SourceBlock, SourceManifest, SourceSpan, SummaryView, TokenCounter, ChunkDigest } from './contracts.js';
import { computeContextLimits, conservativeTextTokens } from './budget.js';
import { derivedContextId, freezeValue, hashBytes, hashContext } from './config.js';
import { checkAbort, contextFailure, ContextFault } from './errors.js';
import { createSourceManifest, readSelectedHistory, selectCompactionRounds } from './rounds.js';
import { readSourceFrame, utf8Boundary } from './sources.js';
import { applySummaryFold, createSummaryBatch, mergeRequirements, planSummaryFold, renderSummary, sealSummaryNode, validatePublication } from './view.js';

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
}

export function previewCompaction(capture: ContextCapture, config: Pick<FrozenCompressionConfig, 'policy'>): CompactionPreview {
    const selected = selectCompactionRounds(capture, config.policy);
    return { conversationId: capture.conversationId, historyEpoch: capture.historyEpoch, viewRevision: capture.viewRevision,
        appendSeq: capture.appendSeq, roundIds: selected.targets.map(round => round.roundId), retainedRoundIds: selected.retained.map(round => round.roundId),
        firstSeq: selected.targets[0]?.firstSeq ?? null, lastSeq: selected.targets.at(-1)?.lastSeq ?? null,
        requiresBudget: capture.execution === null };
}

export async function prepareCompaction(input: {
    port: CompactionPort; sources: ContextSourcePort; capture: ContextCapture; config: FrozenCompressionConfig;
    execution: ExecutionLease; candidateId?: string; reason: CompactionReason; signal?: AbortSignal; now?: number;
}): Promise<CompactionCandidate> {
    const { capture, config, execution, port, sources, signal } = input;
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
        execution: structuredClone(execution), config });
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

interface TextPart { text: string; span: SourceSpan }

function spanFor(block: SourceBlock, startByte: number, bytes: Buffer, purpose: SourceSpan['purpose']): SourceSpan {
    return { itemId: block.itemId, blockId: block.blockId, startByte, endByte: startByte + bytes.length,
        sha256: hashBytes(bytes), blockHash: block.sha256, purpose };
}

async function readReferences(snapshot: CompactionSnapshot, sources: ContextSourcePort, countTokens: TokenCounter, signal: AbortSignal, referenceBudget: number): Promise<TextPart[]> {
    const parts: TextPart[] = [];
    if (referenceBudget <= 0) return parts;
    for (const block of snapshot.referenceBlocks) {
        checkAbort(signal);
        if (block.kind !== 'text' || !block.byteLength) continue;
        const frame = await readSourceFrame(sources, { block, startByte: 0,
            endByte: Math.min(block.byteLength, snapshot.config.policy.readFrameBytes), maxBytes: snapshot.config.policy.readFrameBytes, signal });
        let endByte = utf8Boundary(frame, frame.length);
        while (endByte > 0) {
            const bytes = frame.subarray(0, endByte);
            const part = { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), span: spanFor(block, 0, bytes, 'reference') };
            if (countTokens(canonicalJson([...parts, part])) <= referenceBudget) { parts.push(part); break; }
            endByte = utf8Boundary(frame, Math.floor(endByte * 0.8));
        }
    }
    return parts;
}

export async function* createCompressionChunks(input: {
    snapshot: CompactionSnapshot; sources: ContextSourcePort; blocks?: SourceBlock[]; priorGuidance?: string;
    countTokens?: TokenCounter; signal: AbortSignal;
}): AsyncGenerator<CompressionChunk> {
    const { snapshot, sources, signal } = input;
    const countTokens = input.countTokens ?? conservativeTextTokens;
    const policy = snapshot.config.policy;
    const limits = computeContextLimits(snapshot.config.model.contextWindow, snapshot.config.model.maxOutputTokens, policy);
    const inputLimit = Math.min(policy.chunkInputTokens, limits.inputBudget - 1);
    const references = input.blocks ? [] : await readReferences(snapshot, sources, countTokens, signal,
        Math.max(0, policy.referenceTokens - countTokens(input.priorGuidance ?? '')));
    const blocks = input.blocks ?? snapshot.manifest.blocks;
    const roundIds = [...new Set(blocks.map(block => block.roundId))];
    const body = (parts: TextPart[], anchors: SourceBlock[]) => canonicalJson({ rules: snapshot.config.rules,
        priorGuidance: input.priorGuidance ?? '', references, targets: parts,
        anchors: anchors.map(anchor => ({ ...fullSpan(anchor), retrieval: anchor.retrieval, kind: anchor.kind, mediaType: anchor.mediaType ?? null })) });
    const finish = (roundId: string, parts: TextPart[], anchors: SourceBlock[]): CompressionChunk => {
        const text = body(parts, anchors);
        const inputTokens = countTokens(text);
        if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || inputTokens > inputLimit) throw new ContextFault('CONFIG_INVALID', '压缩规则、参考和来源头超出单块输入预算');
        const sourceSpans = [...parts.map(part => part.span), ...anchors.map(fullSpan)];
        return freezeValue({ chunkId: derivedContextId([snapshot.candidateId, roundId, sourceSpans]), roundId, sourceSpans,
            referenceSpans: references.map(part => part.span), anchors, body: text, inputBodyHash: hashBytes(text), inputTokens });
    };
    for (const roundId of roundIds) {
        checkAbort(signal);
        const roundBlocks = blocks.filter(block => block.roundId === roundId);
        let anchors: SourceBlock[] = [];
        for (const anchor of roundBlocks.filter(block => block.kind === 'nativeAnchor')) {
            if (countTokens(body([], [...anchors, anchor])) > inputLimit) {
                if (!anchors.length) throw new ContextFault('CONFIG_INVALID', '单个原生检索锚点超过压缩输入预算');
                yield finish(roundId, [], anchors);
                anchors = [];
            }
            anchors.push(anchor);
        }
        let parts: TextPart[] = [];
        for (const block of roundBlocks.filter(entry => entry.kind === 'text')) {
            let offset = 0;
            if (!block.byteLength) parts.push({ text: '', span: spanFor(block, 0, Buffer.alloc(0), 'target') });
            while (offset < block.byteLength) {
                checkAbort(signal);
                const frame = await readSourceFrame(sources, { block, startByte: offset,
                    endByte: Math.min(block.byteLength, offset + policy.readFrameBytes), maxBytes: policy.readFrameBytes, signal });
                const available = utf8Boundary(frame, frame.length);
                if (!available) throw new ContextFault('SOURCE_GAP', '来源帧无法形成完整UTF-8字符', { itemId: block.itemId, blockId: block.blockId, offset });
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
                    const proposed = { text, span: spanFor(block, offset, bytes, 'target') };
                    if (countTokens(body([...parts, proposed], anchors)) <= inputLimit) { fitted = endByte; low = midpoint + 1; }
                    else high = midpoint - 1;
                }
                if (!fitted) {
                    if (!parts.length && !anchors.length) throw new ContextFault('CONFIG_INVALID', '单个文本字符及来源头已超过压缩输入预算');
                    yield finish(roundId, parts, anchors);
                    parts = [];
                    anchors = [];
                    continue;
                }
                const bytes = frame.subarray(0, fitted);
                parts.push({ text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), span: spanFor(block, offset, bytes, 'target') });
                offset += fitted;
                if (offset < block.byteLength) {
                    yield finish(roundId, parts, anchors);
                    parts = [];
                    anchors = [];
                }
            }
        }
        if (parts.length || anchors.length) yield finish(roundId, parts, anchors);
    }
}

export function validateCompressionResult(request: CompressionRequest, result: CompressionResult): void {
    if ((result.attemptId !== request.attemptId && result.requestAttemptId !== request.attemptId) || result.inputBodyHash !== request.chunk.inputBodyHash
        || result.modelFingerprint !== request.snapshot.effectiveModelFingerprint) throw new ContextFault('USAGE_MISMATCH', '压缩结果与冻结请求身份不一致', { attemptId: request.attemptId }, true);
    if (!result.complete || !result.digest || typeof result.digest.body !== 'string' || !result.digest.body.trim()
        || typeof result.digest.skeleton !== 'string' || typeof result.digest.title !== 'string'
        || !Array.isArray(result.digest.unresolved) || !Array.isArray(result.coverage)) {
        throw new ContextFault('SOURCE_GAP', '压缩模型未返回完整、可核验的摘要结构', { attemptId: request.attemptId }, true);
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

function chunkComplete(chunk: CompressionChunk, result: CompressionResult): boolean {
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

export async function generateCompaction(input: {
    candidate: CompactionCandidate; priorView: SummaryView; port: CompactionPort; sources: ContextSourcePort;
    model: CompressionModelPort; signal: AbortSignal; countTokens?: TokenCounter; now?: () => number;
}): Promise<CompactionCandidate> {
    const { candidate, priorView, port, sources, model, signal } = input;
    const snapshot = candidate.snapshot;
    const countTokens = input.countTokens ?? conservativeTextTokens;
    const now = input.now ?? Date.now;
    const inherited = mergeRequirements(priorView.nodes.map(node => node.unresolved));
    const guidanceNodes: { nodeId: string; hash: string; title: string }[] = [];
    for (const node of priorView.nodes) {
        const next = { nodeId: node.nodeId, hash: node.hash, title: node.title };
        if (countTokens(canonicalJson({ summaries: [...guidanceNodes, next], unresolvedCount: inherited.length })) <= snapshot.config.policy.referenceTokens) guidanceNodes.push(next);
        else break;
    }
    const priorGuidance = canonicalJson({ summaries: guidanceNodes, unresolvedCount: inherited.length });
    const runChunk = async (chunk: CompressionChunk, reason: CompactionReason): Promise<ChunkDigest> => {
        checkAbort(signal);
        if (now() >= Date.parse(snapshot.execution.deadlineAt)) throw new ContextFault('CONFIG_INVALID', '根任务期限已到，停止新增压缩请求');
        const existing = candidate.chunks.find(entry => entry.chunkId === chunk.chunkId);
        if (existing) {
            if (existing.inputBodyHash !== chunk.inputBodyHash) throw new ContextFault('SOURCE_GAP', '恢复块与原冻结输入不一致');
            return existing;
        }
        if (candidate.pendingRequest) throw new ContextFault('ATTEMPT_UNKNOWN', '原压缩attempt尚未查明，暂停新增请求', { attemptId: candidate.pendingRequest.attemptId }, true);
        validatePublication(candidate, await port.inspect(candidate.conversationId), snapshot.sourcePrefixHash);
        const request = freezeValue<CompressionRequest>({ attemptId: randomUUID(), actionId: randomUUID(), stepId: randomUUID(),
            reason, originReason: candidate.reason, execution: snapshot.execution, snapshot, model: snapshot.config.model, chunk,
            maxOutputTokens: snapshot.config.model.maxOutputTokens, inputBodyHash: chunk.inputBodyHash });
        candidate.pendingRequest = request;
        await port.saveCandidate(structuredClone(candidate));
        checkAbort(signal);
        const result = await model.generate(request, signal);
        checkAbort(signal);
        try {
            validateCompressionResult(request, result);
            if (reason !== 'fold') await verifyRequirements(result.digest.unresolved, snapshot, sources, signal);
        } catch (error) {
            candidate.pendingRequest = null;
            candidate.failedResult = structuredClone(result);
            throw error;
        }
        const digest: ChunkDigest = freezeValue({ ...structuredClone(result), chunkId: chunk.chunkId, roundId: chunk.roundId,
            sourceSpans: chunk.sourceSpans, anchors: chunk.anchors });
        candidate.chunks.push(digest);
        candidate.pendingRequest = null;
        await port.saveCandidate(structuredClone(candidate));
        return digest;
    };
    try {
        const preliminaryLimits = computeContextLimits(snapshot.config.model.contextWindow, snapshot.config.model.maxOutputTokens, snapshot.config.policy);
        if (countTokens(canonicalJson(inherited)) > preliminaryLimits.summaryBudget) {
            throw new ContextFault('SUMMARY_BUDGET', '必须保留的未决要求原句已超过摘要预算', { unresolvedCount: inherited.length });
        }
        candidate.state = 'generating';
        await port.saveCandidate(structuredClone(candidate));
        await verifyManifestSources(snapshot.manifest, sources, snapshot.config.policy.readFrameBytes, signal);
        for await (const chunk of createCompressionChunks({ snapshot, sources, priorGuidance, countTokens, signal })) {
            const digest = await runChunk(chunk, candidate.reason);
            if (!chunkComplete(chunk, digest)) break;
        }
        const coverage = validateCoverage(snapshot.manifest, candidate.chunks, priorView.coveredEndSeq);
        candidate.coverage = coverage;
        if (!coverage.completeRoundIds.length) throw new ContextFault('SOURCE_GAP', '目标来源未完整覆盖一个连续整轮，保持原发送视图', { coverage });
        const accepted = new Set(coverage.completeRoundIds);
        const chunks = candidate.chunks.filter(chunk => accepted.has(chunk.roundId));
        candidate.batch = createSummaryBatch({ nodeId: derivedContextId([candidate.candidateId, 'batch']), chunks,
            roundIds: coverage.completeRoundIds, firstSeq: snapshot.manifest.rounds[0].firstSeq, lastSeq: coverage.coveredEndSeq,
            parentBatchIds: snapshot.parentBatchIds, modelFingerprint: snapshot.effectiveModelFingerprint, inheritedRequirements: inherited });
        let nodes = [...priorView.nodes, candidate.batch];
        const limits = computeContextLimits(snapshot.config.model.contextWindow, snapshot.config.model.maxOutputTokens, snapshot.config.policy);
        const plan = planSummaryFold(nodes, snapshot.config.policy, limits.summaryBudget, countTokens);
        if (plan) {
            const foldBytes = new Map<string, Buffer>();
            const foldBlocks: SourceBlock[] = plan.children.map(node => {
                const bytes = Buffer.from(canonicalJson({ body: node.body, skeleton: node.skeleton, title: node.title,
                    unresolved: node.unresolved, anchors: node.anchors, sourceSpans: node.sourceSpans }), 'utf8');
                foldBytes.set(node.nodeId, bytes);
                return { itemId: node.nodeId, blockId: 'summary', contentId: node.nodeId, seq: node.firstSeq, roundId: `fold:${node.nodeId}`,
                    kind: 'text', byteLength: bytes.length, sha256: hashBytes(bytes), retrieval: { summaryId: node.nodeId, hash: node.hash } };
            });
            const foldSources: ContextSourcePort = { describe: async () => foldBlocks,
                read: async request => foldBytes.get(request.block.itemId)!.subarray(request.startByte, request.endByte) };
            const foldedChunks: ChunkDigest[] = [];
            for await (const chunk of createCompressionChunks({ snapshot, sources: foldSources, blocks: foldBlocks, countTokens, signal,
                priorGuidance: canonicalJson({ unresolvedCount: mergeRequirements(plan.children.map(node => node.unresolved)).length }) })) {
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
                children: plan.children.map(node => ({ nodeId: node.nodeId, hash: node.hash, firstSeq: node.firstSeq, lastSeq: node.lastSeq })) });
            candidate.folds = [fold];
            nodes = applySummaryFold(nodes, plan, fold);
            if (nodes.length > snapshot.config.policy.maxActiveNodes) throw new ContextFault('SUMMARY_BUDGET', '折叠后活动节点仍超过上限');
        }
        renderSummary(nodes, snapshot.config.policy, limits.summaryBudget, countTokens);
        candidate.nextView = freezeValue({ revision: priorView.revision + 1, historyEpoch: snapshot.historyEpoch,
            coveredEndSeq: coverage.coveredEndSeq, nodes });
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
