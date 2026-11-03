import type { CompressionRequest, CompactionSnapshot, ContextSourcePort, RequirementAnchor, RequirementResolution, SourceSpan, TokenCounter } from './contracts.js';
import { canonicalJson } from '../protocol.js';
import { derivedContextId, hashBytes, hashContext } from './config.js';
import { ContextFault } from './errors.js';
import { readSourceFrame } from './sources.js';

export function mergeRequirementRecords(groups: RequirementAnchor[][]): RequirementAnchor[] {
    const records = new Map<string, RequirementAnchor>();
    for (const group of groups) for (const requirement of group) {
        const previous = records.get(requirement.id);
        if (previous && (previous.quote !== requirement.quote || hashContext(previous.source) !== hashContext(requirement.source))) {
            throw new ContextFault('SOURCE_GAP', '要求身份对应的原句或来源发生冲突', { requirementId: requirement.id });
        }
        if (!previous || (!previous.resolvedBy?.length && requirement.resolvedBy?.length)) records.set(requirement.id, structuredClone(requirement));
        else if (previous.resolvedBy?.length && requirement.resolvedBy?.length && hashContext(previous) !== hashContext(requirement)) {
            throw new ContextFault('SOURCE_GAP', '同一要求具有冲突的解决证据', { requirementId: requirement.id });
        }
    }
    return [...records.values()];
}

export function activeRequirements(records: RequirementAnchor[]): RequirementAnchor[] {
    return records.filter(requirement => !requirement.resolvedBy?.length);
}

export function boundedRequirementGuidance(records: RequirementAnchor[], budget: number, countTokens: TokenCounter, offset = 0): RequirementAnchor[] {
    const selected: RequirementAnchor[] = [];
    const active = activeRequirements(records);
    const start = Number.isSafeInteger(offset) && offset >= 0 && active.length ? offset % active.length : 0;
    for (const requirement of [...active.slice(start), ...active.slice(0, start)]) {
        if (selected.length === 64) break;
        if (countTokens(canonicalJson([...selected, requirement].map(({ id, quote }) => ({ id, quote })))) <= budget) selected.push(requirement);
    }
    return selected;
}

type EvidencePart = { text: string; span: SourceSpan };

function locateQuote(raw: unknown, parts: EvidencePart[]): { quote: string; source: SourceSpan } | null {
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as { quote?: unknown; source?: Partial<SourceSpan> };
    const source = value.source;
    if (typeof value.quote !== 'string' || !value.quote || !source?.itemId || !source.blockId) return null;
    const quote = value.quote;
    const matches = parts.flatMap(part => {
        if (part.span.itemId !== source.itemId || part.span.blockId !== source.blockId) return [];
        const found: SourceSpan[] = [];
        for (let offset = part.text.indexOf(quote); offset >= 0; offset = part.text.indexOf(quote, offset + 1)) {
            const startByte = part.span.startByte + Buffer.byteLength(part.text.slice(0, offset));
            const span = { ...part.span, startByte, endByte: startByte + Buffer.byteLength(quote), sha256: hashBytes(quote) };
            if ((source.startByte === undefined || source.startByte === startByte)
                && (source.endByte === undefined || source.endByte === span.endByte)
                && (source.sha256 === undefined || source.sha256 === span.sha256)
                && (source.blockHash === undefined || source.blockHash === span.blockHash)) found.push(span);
        }
        return found;
    });
    const unique = new Map(matches.map(span => [hashContext(span), span]));
    return unique.size === 1 ? { quote, source: [...unique.values()][0] } : null;
}

export function parseRequirementResolutions(raw: unknown, request: CompressionRequest, additions: RequirementAnchor[]): RequirementResolution[] {
    if (!Array.isArray(raw)) return [];
    const payload = JSON.parse(request.chunk.body) as { targets?: EvidencePart[]; references?: EvidencePart[]; priorGuidance?: string };
    let inherited: RequirementAnchor[] = [];
    try { inherited = JSON.parse(payload.priorGuidance ?? '{}').activeRequirements ?? []; } catch { inherited = []; }
    const presentedIds = new Set(inherited.map(requirement => requirement.id));
    inherited = (request.chunk.requirementAnchors ?? inherited).filter(requirement => presentedIds.has(requirement.id) && requirement.source);
    const known = new Map([...inherited, ...additions].map(requirement => [requirement.id, requirement]));
    const parts = [...(payload.targets ?? []), ...(payload.references ?? []), ...inherited.map(requirement => ({ text: requirement.quote, span: requirement.source }))];
    return raw.slice(0, 64).flatMap(value => {
        if (!value || typeof value !== 'object') return [];
        const proposal = value as RequirementResolution;
        const requirement = known.get(proposal.requirementId);
        if (!requirement || !['fulfilled', 'superseded'].includes(proposal.status) || typeof proposal.resolvedQuote !== 'string'
            || !proposal.resolvedQuote || requirement.quote.indexOf(proposal.resolvedQuote) < 0
            || requirement.quote.indexOf(proposal.resolvedQuote) !== requirement.quote.lastIndexOf(proposal.resolvedQuote)) return [];
        const replacement = proposal.replacementRequirementId ? known.get(proposal.replacementRequirementId) : undefined;
        if (proposal.replacementRequirementId && (!replacement || replacement.id === requirement.id)) return [];
        const rawEvidence = Array.isArray(proposal.evidence) ? proposal.evidence : [];
        const evidence = rawEvidence.map(entry => locateQuote(entry, parts));
        if (evidence.some(entry => !entry)) return [];
        if (replacement) evidence.push({ quote: replacement.quote, source: replacement.source });
        if (!evidence.length || (proposal.status === 'fulfilled' && !rawEvidence.length)) return [];
        return [{ requirementId: requirement.id, status: proposal.status, resolvedQuote: proposal.resolvedQuote,
            evidence: evidence as RequirementResolution['evidence'], ...(replacement ? { replacementRequirementId: replacement.id } : {}) }];
    });
}

function remainderAnchors(requirement: RequirementAnchor, resolvedQuote: string): RequirementAnchor[] {
    const offset = requirement.quote.indexOf(resolvedQuote);
    const fragments = [{ text: requirement.quote.slice(0, offset), offset: 0 },
        { text: requirement.quote.slice(offset + resolvedQuote.length), offset: offset + resolvedQuote.length }];
    return fragments.flatMap(fragment => {
        const quote = fragment.text.replace(/^[\s，,。.;；、]+|[\s，,。.;；、]+$/gu, '');
        if (!quote) return [];
        const position = fragment.offset + fragment.text.indexOf(quote);
        const startByte = requirement.source.startByte + Buffer.byteLength(requirement.quote.slice(0, position));
        const source = { ...requirement.source, startByte, endByte: startByte + Buffer.byteLength(quote), sha256: hashBytes(quote) };
        return [{ id: derivedContextId(['requirement-remainder', requirement.id, source]), quote, source, parentRequirementId: requirement.id }];
    });
}

function overlapsRecurringScope(quote: string, resolvedQuote: string): boolean {
    const start = quote.indexOf(resolvedQuote);
    const end = start + resolvedQuote.length;
    let recurring = false;
    for (const clause of quote.matchAll(/[^，,。.;；！？!?\n]+/gu)) {
        if (/每(?:一)?(?:轮|次|回(?:合)?|(?:条|个)(?:消息|回复|请求|轮次|回合|步骤))|始终|总是|一直|持续|长期|\b(?:every|each)\s+(?:turn|round|time|reply|response|message|request|step)s?\b|\b(?:always|continually|continuously)\b/iu.test(clause[0])) recurring = true;
        else if (/^\s*(?:(?:并(?:且)?|同时|另外|而|and|also)\s*)?(?:本(?:轮|次|回)|这(?:一)?(?:轮|次|回)|当前(?:这一)?(?:轮|次|回)|仅(?:此|限)?(?:一)?(?:轮|次)|(?:this|current)\s+(?:turn|round|time|reply|response|message|request|step)\b|(?:only\s+)?once\b)/iu.test(clause[0])) recurring = false;
        if (recurring && clause.index < end && clause.index + clause[0].length > start) return true;
    }
    return false;
}

export async function applyRequirementResolutions(input: {
    records: RequirementAnchor[]; resolutions: RequirementResolution[]; snapshot: CompactionSnapshot;
    sources: ContextSourcePort; signal: AbortSignal;
}): Promise<RequirementAnchor[]> {
    const records = new Map(mergeRequirementRecords([input.records]).map(requirement => [requirement.id, requirement]));
    const metadata = new Map((input.snapshot.requirementSourceMetadata ?? []).map(item => [item.itemId, item]));
    const blocks = [...input.snapshot.manifest.blocks, ...input.snapshot.referenceBlocks];
    const proposals = input.resolutions.slice(0, 64).sort((left, right) => {
        const leftRecord = records.get(left.requirementId);
        const rightRecord = records.get(right.requirementId);
        return (metadata.get(leftRecord?.source.itemId ?? '')?.seq ?? 0) - (metadata.get(rightRecord?.source.itemId ?? '')?.seq ?? 0);
    });
    const counts = new Map<string, number>();
    for (const proposal of proposals) counts.set(proposal.requirementId, (counts.get(proposal.requirementId) ?? 0) + 1);
    for (const proposal of proposals) {
        const requirement = records.get(proposal.requirementId);
        if (!requirement || requirement.resolvedBy?.length || counts.get(proposal.requirementId) !== 1
            || !['fulfilled', 'superseded'].includes(proposal.status) || !proposal.resolvedQuote
            || requirement.quote.indexOf(proposal.resolvedQuote) < 0
            || requirement.quote.indexOf(proposal.resolvedQuote) !== requirement.quote.lastIndexOf(proposal.resolvedQuote)
            || !Array.isArray(proposal.evidence) || !proposal.evidence.length) continue;
        const original = metadata.get(requirement.source.itemId);
        if (!original || !Number.isSafeInteger(original.seq) || original.seq < 1) continue;
        const replacement = proposal.replacementRequirementId ? records.get(proposal.replacementRequirementId) : undefined;
        if (proposal.replacementRequirementId && (!replacement || replacement.id === requirement.id || replacement.resolvedBy?.length)) continue;
        let valid = true;
        let actualCompletion = false;
        for (const evidence of proposal.evidence) {
            const item = metadata.get(evidence.source.itemId);
            if (!item || !Number.isSafeInteger(item.seq) || item.seq <= original.seq || item.seq > input.snapshot.snapshotAppendSeq
                || evidence.source.sha256 !== hashBytes(evidence.quote) || !evidence.quote) { valid = false; break; }
            if (proposal.status === 'superseded' && item.role !== 'user') { valid = false; break; }
            const trusted = [...records.values()].some(record => record.quote === evidence.quote && hashContext(record.source) === hashContext(evidence.source));
            const block = blocks.find(entry => entry.itemId === evidence.source.itemId && entry.blockId === evidence.source.blockId);
            if (block) {
                if (block.kind !== 'text' || block.seq !== item.seq || block.sha256 !== evidence.source.blockHash
                    || evidence.source.endByte - evidence.source.startByte > input.snapshot.config.policy.readFrameBytes) { valid = false; break; }
                const bytes = await readSourceFrame(input.sources, { block, startByte: evidence.source.startByte, endByte: evidence.source.endByte,
                    maxBytes: input.snapshot.config.policy.readFrameBytes, signal: input.signal });
                if (hashBytes(bytes) !== evidence.source.sha256 || bytes.toString('utf8') !== evidence.quote) { valid = false; break; }
            } else if (!trusted) { valid = false; break; }
            if (proposal.status === 'fulfilled') {
                if (item.terminalOutcome?.state !== 'succeeded') { valid = false; break; }
                if (block && (item.role === 'tool' || item.role === 'assistant')) actualCompletion = true;
            }
        }
        if (replacement && !proposal.evidence.some(evidence => evidence.quote === replacement.quote
            && hashContext(evidence.source) === hashContext(replacement.source))) valid = false;
        if (!valid || (proposal.status === 'fulfilled' && !actualCompletion)) continue;
        if (proposal.status === 'fulfilled' && overlapsRecurringScope(requirement.quote, proposal.resolvedQuote)) continue;
        const remaining = remainderAnchors(requirement, proposal.resolvedQuote);
        records.set(requirement.id, { ...requirement, resolvedBy: proposal.evidence.map(evidence => evidence.source),
            resolution: { status: proposal.status, conversationId: input.snapshot.conversationId, historyEpoch: input.snapshot.historyEpoch,
                ...(replacement ? { replacementRequirementId: replacement.id } : {}), remainingIds: remaining.map(record => record.id) } });
        for (const remainder of remaining) records.set(remainder.id, remainder);
    }
    return [...records.values()];
}
