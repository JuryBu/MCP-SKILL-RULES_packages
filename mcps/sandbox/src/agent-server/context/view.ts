import type { HistoryItem } from '../storage/port.js';
import { canonicalJson } from '../protocol.js';
import type { JsonValue } from '../protocol.js';
import type { ChunkDigest, ContextCapture, ContextPolicy, FoldNode, RequirementAnchor, SummaryBatch, SummaryNode, SummaryView, TokenCounter } from './contracts.js';
import { conservativeTextTokens } from './budget.js';
import { freezeValue, hashBytes, hashContext } from './config.js';
import { ContextFault } from './errors.js';

export function hasNativeSignature(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hasNativeSignature);
    if (value === null || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, child]) =>
        (['signature', 'thoughtSignature', 'thought_signature'].includes(key) && typeof child === 'string' && child.length > 0) || hasNativeSignature(child));
}

export function mergeRequirements(groups: RequirementAnchor[][]): RequirementAnchor[] {
    const requirements = new Map<string, RequirementAnchor>();
    for (const group of groups) for (const requirement of group) {
        const existing = requirements.get(requirement.id);
        if (existing && (existing.quote !== requirement.quote || hashContext(existing.source) !== hashContext(requirement.source))) {
            throw new ContextFault('SOURCE_GAP', '未决要求身份对应的原句或来源发生冲突', { requirementId: requirement.id });
        }
        if (!existing) requirements.set(requirement.id, structuredClone(requirement));
    }
    return [...requirements.values()];
}

export function sealSummaryNode<Node extends SummaryNode>(node: Omit<Node, 'hash'>): Node {
    return freezeValue({ ...node, hash: hashContext(node) } as Node);
}

export function validateSummaryNodes(nodes: SummaryNode[]): void {
    let previousEnd = 0;
    const ids = new Set<string>();
    for (const node of nodes) {
        const { hash, ...content } = node;
        if (hashContext(content) !== hash || ids.has(node.nodeId) || node.firstSeq <= previousEnd || node.lastSeq < node.firstSeq) {
            throw new ContextFault('SOURCE_GAP', '摘要节点哈希、范围或顺序无效', { nodeId: node.nodeId });
        }
        if (node.kind === 'fold') {
            if (!node.children.length || node.children[0].firstSeq !== node.firstSeq
                || node.children[node.children.length - 1].lastSeq !== node.lastSeq) {
                throw new ContextFault('SOURCE_GAP', '折叠节点缺少完整子来源范围', { nodeId: node.nodeId });
            }
        }
        ids.add(node.nodeId);
        previousEnd = node.lastSeq;
    }
}

export function createSummaryBatch(input: {
    nodeId: string; chunks: ChunkDigest[]; roundIds: string[]; firstSeq: number; lastSeq: number;
    parentBatchIds: string[]; modelFingerprint: string; inheritedRequirements: RequirementAnchor[];
}): SummaryBatch {
    const body = input.chunks.map(chunk => chunk.digest.body).join('\n\n');
    const skeleton = input.chunks.map(chunk => chunk.digest.skeleton).join('\n\n');
    const title = input.chunks.map(chunk => chunk.digest.title).filter(Boolean).join(' / ');
    return sealSummaryNode<SummaryBatch>({ kind: 'batch', nodeId: input.nodeId, firstSeq: input.firstSeq, lastSeq: input.lastSeq,
        roundIds: [...input.roundIds], sourceSpans: input.chunks.flatMap(chunk => chunk.sourceSpans),
        chunkIds: input.chunks.map(chunk => chunk.chunkId), parentBatchIds: [...input.parentBatchIds],
        modelFingerprint: input.modelFingerprint, body, skeleton, title,
        unresolved: mergeRequirements([input.inheritedRequirements, ...input.chunks.map(chunk => chunk.digest.unresolved)]),
        anchors: input.chunks.flatMap(chunk => chunk.anchors) });
}

type SummaryLevel = 'body' | 'skeleton' | 'title';

export interface RenderedSummary {
    text: string;
    tokens: number;
    levels: { nodeId: string; level: SummaryLevel }[];
    degraded: boolean;
    hash: string;
}

export function renderSummary(nodes: SummaryNode[], policy: ContextPolicy, budget = Number.MAX_SAFE_INTEGER,
    countTokens: TokenCounter = conservativeTextTokens): RenderedSummary {
    validateSummaryNodes(nodes);
    const middleEnd = nodes.length - policy.stableTailBatches;
    const levels: SummaryLevel[] = nodes.map((_, index) => index < policy.stableHeadBatches || index >= middleEnd ? 'body'
        : index < middleEnd - policy.middleSkeletonBatches ? 'title' : 'skeleton');
    const requirements = mergeRequirements(nodes.map(node => node.unresolved));
    const nativeAnchors = new Map<string, { itemId: string; blockId: string; sha256: string; retrieval: SummaryNode['anchors'][number]['retrieval'] }>();
    for (const node of nodes) for (const anchor of node.anchors) {
        if (anchor.mediaType || typeof anchor.retrieval.nativeType === 'string') nativeAnchors.set(JSON.stringify([anchor.itemId, anchor.blockId, anchor.sha256]),
            { itemId: anchor.itemId, blockId: anchor.blockId, sha256: anchor.sha256, retrieval: anchor.retrieval });
    }
    const render = () => {
        const parts = nodes.map((node, index) => `[summary ${node.nodeId}; seq=${node.firstSeq}..${node.lastSeq}; hash=${node.hash}; read=summary:${node.nodeId}]\n${node[levels[index]]}`);
        if (requirements.length) parts.push(`Unresolved requirements (verbatim):\n${requirements.map(requirement => canonicalJson({
            id: requirement.id, quote: requirement.quote, source: requirement.source,
        })).join('\n')}`);
        if (nativeAnchors.size) parts.push(`Native source anchors (original content retained):\n${[...nativeAnchors.values()].map(anchor => canonicalJson(anchor)).join('\n')}`);
        return parts.join('\n\n');
    };
    let text = render();
    const original = [...levels];
    const middle = nodes.map((_, index) => index).filter(index => index >= policy.stableHeadBatches && index < middleEnd);
    const edges = nodes.map((_, index) => index).filter(index => !middle.includes(index));
    for (const level of ['skeleton', 'title'] as const) {
        for (const index of [...middle, ...edges]) {
            if (countTokens(text) <= budget) break;
            if (levels[index] === 'title' || (level === 'skeleton' && levels[index] !== 'body')) continue;
            levels[index] = level;
            text = render();
        }
    }
    const tokens = countTokens(text);
    if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > budget) {
        throw new ContextFault('SUMMARY_BUDGET', '摘要标题、检索锚点和未决原句仍超过预算',
            { summaryTokens: tokens, summaryBudget: budget, unresolvedCount: requirements.length, nodeCount: nodes.length });
    }
    return { text, tokens, levels: nodes.map((node, index) => ({ nodeId: node.nodeId, level: levels[index] })),
        degraded: levels.some((level, index) => level !== original[index]), hash: hashBytes(text) };
}

export function planSummaryFold(nodes: SummaryNode[], policy: ContextPolicy, summaryBudget: number,
    countTokens: TokenCounter = conservativeTextTokens): { children: SummaryNode[]; startIndex: number; endIndex: number } | null {
    validateSummaryNodes(nodes);
    let overBudget = false;
    try { overBudget = renderSummary(nodes, policy, Number.MAX_SAFE_INTEGER, countTokens).tokens > summaryBudget; }
    catch (error) { throw error; }
    if (nodes.length <= policy.foldAfterBatches && !overBudget) return null;
    const startIndex = Math.min(policy.stableHeadBatches, nodes.length);
    const availableEnd = Math.max(startIndex, nodes.length - policy.stableTailBatches);
    const count = Math.min(availableEnd - startIndex, Math.max(1, nodes.length - policy.maxActiveNodes + 1));
    if (count < 1) return null;
    return { children: nodes.slice(startIndex, startIndex + count), startIndex, endIndex: startIndex + count };
}

export function applySummaryFold(nodes: SummaryNode[], plan: { children: SummaryNode[]; startIndex: number; endIndex: number }, folded: FoldNode): SummaryNode[] {
    const current = nodes.slice(plan.startIndex, plan.endIndex);
    if (hashContext(current) !== hashContext(plan.children)
        || hashContext(folded.children) !== hashContext(current.map(node => ({ nodeId: node.nodeId, hash: node.hash, firstSeq: node.firstSeq, lastSeq: node.lastSeq })))) {
        throw new ContextFault('PARENT_STALE', '折叠节点与冻结子批不一致');
    }
    const result = [...nodes.slice(0, plan.startIndex), folded, ...nodes.slice(plan.endIndex)];
    validateSummaryNodes(result);
    return result;
}

export function validatePublication(candidate: { snapshot: { historyEpoch: number; parentViewRevision: number; runId: string; runEpoch: number;
    compressionGeneration: string; effectiveModelFingerprint: string; snapshotAppendSeq: number; sourcePrefixHash: string } }, current: ContextCapture,
    verifiedPrefixHash: string): void {
    const snapshot = candidate.snapshot;
    if (current.historyEpoch !== snapshot.historyEpoch) throw new ContextFault('HISTORY_STALE', '历史epoch已改变');
    if (current.viewRevision !== snapshot.parentViewRevision) throw new ContextFault('PARENT_STALE', '候选父视图已改变');
    if (current.effectiveModelFingerprint !== snapshot.effectiveModelFingerprint) throw new ContextFault('MODEL_STALE', '有效压缩模型身份已改变');
    if (current.compressionGeneration !== snapshot.compressionGeneration || current.execution?.runId !== snapshot.runId
        || current.execution.runEpoch !== snapshot.runEpoch) throw new ContextFault('HISTORY_STALE', '压缩或执行代次已改变');
    if (current.appendSeq < snapshot.snapshotAppendSeq || verifiedPrefixHash !== snapshot.sourcePrefixHash) {
        throw new ContextFault('SOURCE_GAP', '来源追加上限回退或不可变前缀校验失败');
    }
}

export function selectRawTail(items: HistoryItem[], view: SummaryView): HistoryItem[] {
    return items.filter(item => item.effective && item.view === 'raw' && item.seq > view.coveredEndSeq).sort((left, right) => left.seq - right.seq);
}

export function validateNativeTail(items: HistoryItem[], values: Map<string, JsonValue>, target: { protocol: string; model: string },
    compatible?: (source: { protocol: string; model: string | null; signed: boolean }, target: { protocol: string; model: string }) => boolean): void {
    const calls = new Map<string, { stepId: string | null; roundId: string | null; name: string; resolved: boolean }>();
    for (const item of items) {
        const value = values.get(item.contentId) as Record<string, unknown> | undefined;
        if (!value) throw new ContextFault('SOURCE_GAP', '原生尾部正文尚未读取', { itemId: item.itemId });
        if (item.providerProtocol) {
            const response = value.response as Record<string, unknown> | undefined;
            const blocks = Array.isArray(response?.blocks) ? response.blocks as Record<string, unknown>[] : [];
            const source = { protocol: item.providerProtocol, model: typeof response?.modelId === 'string' ? response.modelId : null,
                signed: hasNativeSignature(response?.replayMessages) || blocks.some(block => typeof block.thoughtSignature === 'string') };
            const allowed = compatible ? compatible(source, target) : source.protocol === target.protocol && (!source.signed || source.model === target.model);
            if (!allowed) throw new ContextFault('PROTOCOL_INCOMPATIBLE', '原生尾部需要兼容协议、签名或可信语义分支', { itemId: item.itemId });
            if (response && Array.isArray(response.toolCalls)) for (const rawCall of response.toolCalls) {
                const call = rawCall as Record<string, unknown>;
                if (typeof call.callId !== 'string' || typeof call.name !== 'string' || calls.has(call.callId)) throw new ContextFault('NATIVE_PAIRING', '原生调用ID缺失或重复');
                calls.set(call.callId, { stepId: item.stepId, roundId: item.roundId, name: call.name, resolved: false });
            }
        }
        if (item.role === 'tool') {
            const result = value.result as Record<string, unknown> | undefined;
            const callId = item.callId ?? (typeof result?.callId === 'string' ? result.callId : '');
            const call = calls.get(callId);
            if (!call || call.resolved || call.stepId !== item.stepId || call.roundId !== item.roundId || result?.name !== call.name) {
                throw new ContextFault('NATIVE_PAIRING', '原生工具结果缺少唯一配对调用', { itemId: item.itemId, callId });
            }
            call.resolved = true;
        }
    }
    const pending = [...calls].filter(([, call]) => !call.resolved).map(([callId]) => callId);
    if (pending.length) throw new ContextFault('NATIVE_PAIRING', '原生调用结果尚未结清', { callIds: pending });
}
