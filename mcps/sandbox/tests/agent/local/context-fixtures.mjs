import assert from 'node:assert/strict';
import { canonicalJson } from '../../../src/agent-server/protocol.ts';
import { receiptKey } from '../../../src/agent-server/storage/port.ts';
import { ContextCompactor, ContextFault, createHistorySourcePort, freezeCompressionConfig, hashBytes, hashContext,
    validateCoverage, validatePublication, validateSummaryNodes } from '../../../src/agent-server/context/index.ts';

export const fixtureModel = {
    provider: 'local-fixture', endpoint: 'fixture:in-memory', model: 'context-fixture-model', protocol: 'compatible_chat',
    adapterVersion: 'fixture-v1', capabilityVersion: 'fixture-v1', profileRevision: 1, routing: {}, parameters: {},
    accountFingerprint: 'local-fixture-no-account', credentialRef: null, credentialGeneration: 0,
    contextWindow: 128_000, maxOutputTokens: 2048,
};

export const fixtureConfig = overrides => freezeCompressionConfig({ currentModel: fixtureModel, revision: 1, ...overrides });

export function execution(kind = 'task', ordinal = 1) {
    return { kind, conversationId: 'fixture-conversation', runId: `fixture-${kind}-${ordinal}`, runEpoch: ordinal,
        rootBudgetId: `fixture-root-${ordinal}`, roundId: kind === 'task' ? 'round-6' : null,
        stepId: `fixture-compression-step-${ordinal}`, deadlineAt: '2099-01-01T00:00:00.000Z' };
}

export class FixturePort {
    candidates = new Map();
    receipts = new Map();
    checkpoints = new Map();
    contents = new Map();
    items = [];
    readSizes = [];
    commits = 0;
    claims = 0;
    beforePublish = null;
    losePublicationResponse = false;
    hideReceipts = false;
    beforeSave = null;

    constructor(config = fixtureConfig()) {
        this.capture = { conversationId: 'fixture-conversation', historyEpoch: 1, appendSeq: 0, viewRevision: 0, workspaceRevision: 0,
            compressionGeneration: 'initial-generation', effectiveModelFingerprint: config.modelFingerprint, historyRoot: 'fixture-root-0',
            stepSeq: 12, activeRoundId: 'round-6', rounds: [], view: { revision: 0, historyEpoch: 1, coveredEndSeq: 0, nodes: [] },
            execution: execution(), candidateId: null };
    }

    appendRound(text, { active = false, nativePairing = 'complete', modelValue } = {}) {
        const ordinal = this.capture.rounds.length + 1;
        const roundId = `round-${ordinal}`;
        const firstSeq = this.capture.appendSeq + 1;
        const userId = `user-${ordinal}`;
        const modelId = `model-${ordinal}`;
        this.appendItem(userId, { text, references: [] }, { role: 'user', roundId, stepId: `user-step-${ordinal}`, kind: 'input_consumed' });
        const response = modelValue ?? { kind: 'model', protocol: 'compatible_chat', response: {
            attemptId: `fixture-attempt-${ordinal}`, modelId: fixtureModel.model, complete: true, canExecuteTools: false,
            blocks: [{ type: 'text', text: `fixture answer ${ordinal}`, nativeRef: `fixture-native-${ordinal}`, native: { text: `fixture answer ${ordinal}` } }],
            toolCalls: [], raw: { httpStatus: 200, headers: {}, body: `fixture answer ${ordinal}`, json: { text: `fixture answer ${ordinal}` } },
        } };
        this.appendItem(modelId, response, { role: 'assistant', roundId, stepId: `model-step-${ordinal}`, kind: 'model_step', providerProtocol: 'compatible_chat' });
        this.capture.rounds.push({ roundId, firstSeq, lastSeq: this.capture.appendSeq, itemIds: [userId, modelId],
            complete: !active, nativePairing, lastStepSeq: ordinal * 2 });
        if (active) this.capture.activeRoundId = roundId;
        return roundId;
    }

    appendItem(itemId, value, metadata) {
        const contentId = `${itemId}-content`;
        const bytes = Buffer.from(canonicalJson(value));
        this.contents.set(contentId, structuredClone(value));
        const item = { itemId, seq: ++this.capture.appendSeq, contentId, view: 'raw', effective: true,
            runId: this.capture.execution?.runId ?? 'fixture-old-task', runEpoch: this.capture.execution?.runEpoch ?? 1,
            objectRef: { hash: hashBytes(bytes), rawBytes: bytes.length }, ...metadata };
        this.items.push(item);
        this.capture.historyRoot = hashContext(this.items.map(entry => [entry.itemId, entry.objectRef.hash]));
        return item;
    }

    async inspect() { return structuredClone(this.capture); }

    async readContent(conversationId, contentId) {
        assert.equal(conversationId, this.capture.conversationId);
        return structuredClone(this.contents.get(contentId));
    }

    async readHistory(query) {
        const epoch = this.capture.historyEpoch;
        if (query.expectedHistoryEpoch !== undefined && query.expectedHistoryEpoch !== epoch) throw new ContextFault('HISTORY_STALE', 'fixture history epoch changed');
        const cursor = query.cursor ? JSON.parse(Buffer.from(query.cursor, 'base64url').toString()) : null;
        if (cursor && cursor.historyEpoch !== epoch) throw new ContextFault('HISTORY_STALE', 'fixture cursor changed');
        const throughSeq = cursor?.throughSeq ?? query.throughSeq ?? this.capture.appendSeq;
        const roundNumbers = new Map(this.capture.rounds.map((round, index) => [round.roundId, index + 1]));
        const backward = query.direction === 'backward';
        const matching = this.items.filter(item => (backward ? item.seq < (cursor?.lastSeq ?? Number.MAX_SAFE_INTEGER) : item.seq > (cursor?.lastSeq ?? 0)) && item.seq <= throughSeq
            && (!query.effectiveOnly || item.effective) && (!query.view || query.view === 'all' || item.view === query.view)
            && (query.startRound === undefined || roundNumbers.get(item.roundId) >= query.startRound)
            && (query.endRound === undefined || roundNumbers.get(item.roundId) <= query.endRound))
            .sort((left, right) => backward ? right.seq - left.seq : left.seq - right.seq);
        const items = [];
        for (const item of matching) {
            if (items.length === (query.limit ?? 50) || Buffer.byteLength(canonicalJson([...items, item])) > (query.maxBytes ?? 262144)) break;
            items.push(structuredClone(item));
        }
        const hasMore = matching.length > items.length;
        const nextCursor = hasMore ? Buffer.from(JSON.stringify({ historyEpoch: epoch, throughSeq, lastSeq: items.at(-1)?.seq ?? 0 })).toString('base64url') : null;
        return { items, hasMore, nextCursor, historyEpoch: epoch, appendSeq: throughSeq, viewRevision: this.capture.viewRevision };
    }

    async claim(input) {
        if (input.expectedHistoryEpoch !== this.capture.historyEpoch || input.expectedViewRevision !== this.capture.viewRevision
            || input.expectedGeneration !== this.capture.compressionGeneration || hashContext(input.execution) !== hashContext(this.capture.execution)) {
            throw new ContextFault('HISTORY_STALE', 'fixture claim compare failed');
        }
        this.capture.compressionGeneration = input.compressionGeneration;
        this.claims++;
        return this.inspect();
    }

    async saveCandidate(candidate) {
        if (this.beforeSave) await this.beforeSave(candidate);
        const previous = this.candidates.get(candidate.candidateId);
        if (previous?.state === 'published') return;
        if (candidate.snapshot.compressionGeneration !== this.capture.compressionGeneration) throw new ContextFault('HISTORY_STALE', 'fixture generation changed');
        if (previous && ['cancelled', 'discarded'].includes(previous.state)) throw new ContextFault('HISTORY_STALE', 'fixture owner discarded');
        this.candidates.set(candidate.candidateId, structuredClone(candidate));
        this.capture.candidateId = candidate.candidateId;
    }

    async getCandidate(conversationId, candidateId) { return structuredClone(this.candidates.get(candidateId) ?? null); }

    async publishCandidate({ candidate, receiptKey: key }) {
        const prior = this.receipts.get(receiptKey(key));
        if (prior) return { ...structuredClone(prior), replayed: true };
        const previous = this.candidates.get(candidate.candidateId);
        if (previous?.state === 'published') {
            const publication = { candidateId: candidate.candidateId, viewRevision: previous.publishedViewRevision,
                coveredEndSeq: previous.coverage.coveredEndSeq, appendSeq: this.capture.appendSeq, replayed: true };
            this.receipts.set(receiptKey(key), publication);
            return publication;
        }
        if (this.beforePublish) await this.beforePublish(candidate);
        if (candidate.state !== 'ready' || previous?.state !== 'ready') throw new ContextFault('PARENT_STALE', 'fixture candidate not ready');
        validatePublication(candidate, this.capture, candidate.snapshot.manifest.prefixHash);
        const coverage = validateCoverage(candidate.snapshot.manifest, candidate.chunks, this.capture.view.coveredEndSeq);
        assert.deepEqual(candidate.coverage, coverage);
        assert.equal(candidate.batch.lastSeq, coverage.coveredEndSeq);
        validateSummaryNodes(candidate.nextView.nodes);
        this.capture.view = structuredClone(candidate.nextView);
        this.capture.viewRevision = candidate.nextView.revision;
        this.commits++;
        const publication = { candidateId: candidate.candidateId, viewRevision: this.capture.viewRevision,
            coveredEndSeq: coverage.coveredEndSeq, appendSeq: this.capture.appendSeq, replayed: false };
        this.candidates.set(candidate.candidateId, { ...structuredClone(candidate), state: 'published', publishedViewRevision: publication.viewRevision });
        this.receipts.set(receiptKey(key), publication);
        if (this.losePublicationResponse) throw new Error('fixture reply lost after commit');
        return publication;
    }

    async getPublication(key) { return this.hideReceipts ? null : structuredClone(this.receipts.get(receiptKey(key)) ?? null); }
    async discardCandidate({ candidateId, generation, state }) {
        if (generation !== this.capture.compressionGeneration) throw new ContextFault('HISTORY_STALE', 'fixture discard generation changed');
        const candidate = this.candidates.get(candidateId);
        if (candidate && candidate.state !== 'published') this.candidates.set(candidateId, { ...candidate, state });
        this.capture.candidateId = null;
    }
    async loadScheduler(conversationId) { return structuredClone(this.checkpoints.get(conversationId) ?? null); }
    async saveScheduler(conversationId, checkpoint) { this.checkpoints.set(conversationId, structuredClone(checkpoint)); }
}

export class FixtureCompressionModel {
    calls = [];
    lookups = [];
    cancellations = [];
    results = new Map();
    onGenerate = null;
    lookupStatus = 'found';
    cancelStatus = 'cancelled';

    result(request) {
        return { attemptId: request.attemptId, inputBodyHash: request.chunk.inputBodyHash,
            modelFingerprint: request.snapshot.effectiveModelFingerprint, complete: true,
            digest: { body: `fixture digest ${request.chunk.roundId}`, skeleton: `fixture skeleton ${request.chunk.roundId}`,
                title: `fixture ${request.chunk.roundId}`, unresolved: [] }, usage: { inputTokens: request.chunk.inputTokens, outputTokens: 10 },
            coverage: request.chunk.sourceSpans.map(span => ({ span, status: span.purpose === 'nativeAnchor' ? 'anchorOnly' : 'complete', gaps: [] })) };
    }

    async generate(request, signal) {
        this.calls.push(request);
        const result = this.onGenerate ? await this.onGenerate(request, signal, this.result(request)) : this.result(request);
        this.results.set(request.attemptId, structuredClone(result));
        return result;
    }
    async lookup(request) {
        this.lookups.push(request.attemptId);
        return this.lookupStatus === 'found' && this.results.has(request.attemptId)
            ? { status: 'found', result: structuredClone(this.results.get(request.attemptId)) } : { status: this.lookupStatus === 'found' ? 'unknown' : this.lookupStatus };
    }
    async cancel(request) { this.cancellations.push(request.attemptId); return this.cancelStatus; }
}

export function createFixture(options = {}) {
    const config = options.config ?? fixtureConfig();
    const port = new FixturePort(config);
    const count = options.rounds ?? 6;
    for (let ordinal = 1; ordinal <= count; ordinal++) port.appendRound(options.text?.(ordinal) ?? `normal fixture input ${ordinal}`,
        { active: options.active !== false && ordinal === count });
    if (options.active === false) port.capture.activeRoundId = null;
    port.capture.execution.roundId = port.capture.activeRoundId ?? port.capture.rounds.at(-1)?.roundId ?? 'round-1';
    const largeContent = {
        async describe(item) {
            const value = port.contents.get(item.contentId);
            const bytes = Buffer.from(value.text);
            return [{ itemId: item.itemId, blockId: 'text', contentId: item.contentId, seq: item.seq, roundId: item.roundId,
                kind: 'text', byteLength: bytes.length, sha256: hashBytes(bytes), retrieval: { contentId: item.contentId, blockId: 'text' } }];
        },
        async read(request) {
            const bytes = Buffer.from(port.contents.get(request.block.contentId).text);
            assert.equal(hashBytes(bytes), request.block.sha256);
            port.readSizes.push(request.endByte - request.startByte);
            return bytes.subarray(request.startByte, request.endByte);
        },
    };
    const rawSources = createHistorySourcePort(port, { conversationId: port.capture.conversationId,
        ...(options.allowLarge ? { largeContent } : {}) });
    const sources = { describe: (...args) => rawSources.describe(...args), read: async request => {
        port.readSizes.push(request.endByte - request.startByte);
        return rawSources.read(request);
    } };
    const model = new FixtureCompressionModel();
    const compactor = new ContextCompactor({ port, sources, model, ...(options.countTokens ? { countTokens: options.countTokens } : {}),
        ...(options.now ? { now: options.now } : {}), ...(options.maintenance ? { maintenance: options.maintenance } : {}) });
    return { port, sources, model, compactor, config };
}

export async function ready(fixture, reason = 'background') {
    const handle = await fixture.compactor.start({ conversationId: fixture.port.capture.conversationId,
        execution: fixture.port.capture.execution, config: fixture.config, reason });
    const candidate = await handle.completion;
    return { handle, candidate };
}

export const estimate = input => ({ rules: 0, schema: 0, native: 0, summary: 0, retained: input, media: 0, protocol: 0, confidence: 'estimated' });
