import { AgentFault, canonicalJson } from '../protocol.js';
import { randomUUID } from 'node:crypto';
import type { AgentEvent, JsonValue } from '../protocol.js';
import { DEFAULT_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES, receiptKey, storeKey } from './port.js';
import type { ReceiptKey, StoredReceipt, StoreCapabilities, StoreCommitResult, StoreEventQuery,
    StoreKey, StorePage, StorePort, StoreRecord, StoreRecordQuery, StoreTransition, HistoryItem, HistoryPage, HistoryQuery,
    ArtifactChunk, ArtifactQuery } from './port.js';
import type { TemporaryMetadataSweepOptions, TemporaryMetadataSweepResult, TemporaryMetadataUsage } from './port.js';
import type { ModelStepPairing, ModelStepPairingQuery } from './port.js';
import { modelStepPairing, validateModelStepPairingQuery } from './model-step-pairing.js';
import { TemporaryMemoryBudget, encodeTemporaryJson, measureCanonicalJsonBytes } from '../media/temporary-budget.js';
import type { TemporaryBudgetPort, TemporaryJsonBuffer } from '../media/temporary-budget.js';
import { canonicalJsonByteChunks } from '../media/payload-codec.js';
import { lifecycleFrozen, lifecycleReceiptOwner, requireLifecycleSnapshotOwner } from '../conversation-lifecycle/migration-snapshots.js';
import type { LifecycleCapture, LifecycleCoreSnapshot, LifecycleStage } from '../conversation-lifecycle/migration-snapshots.js';
import { lifecycleBusinessValue } from '../conversation-lifecycle/policy.js';
import { controlKey } from '../controller.js';
import type { ConversationData } from '../runtime.js';
import { performance } from 'node:perf_hooks';
import { TEMPORARY_METADATA_SWEEP_MS } from '../temporary-create-command.js';

function copy<Value>(value: Value): Value {
    return structuredClone(value);
}

interface MemoryContent extends TemporaryJsonBuffer { kind: string }

interface MetadataHold { value: object; conversationId: string; bytes: number; retryAfter?: number }
interface ConversationMetadataIndex { records: Set<StoreRecord>; receipts: Set<StoredReceipt>; contentCount: number }

const SERVER_MEMORY_ID = 'sandbox-agent-server-metadata';

export class MemoryStore implements StorePort {
    readonly capabilities: StoreCapabilities;
    private records = new Map<string, StoreRecord>();
    private receipts = new Map<string, StoredReceipt>();
    private contents = new Map<string, MemoryContent>();
    private events = new Map<string, AgentEvent[]>();
    private history = new Map<string, HistoryItem[]>();
    private readonly temporaryBudget: TemporaryBudgetPort;
    private readonly metadataHolds = new Map<object, MetadataHold>();
    private closed = false;
    private readonly lifecycleFrozenIds = new Set<string>();
    private readonly lifecycleStages = new Set<() => void>();
    private nextTemporaryMetadataExpiry = Infinity;
    private readonly conversationMetadata = new Map<string, ConversationMetadataIndex>();
    private readonly temporaryMetadataCandidates = new Map<string, StoreRecord>();
    private temporaryMetadataScan?: { records: IterableIterator<StoreRecord>; nextExpiry: number };
    private temporaryMetadataPending?: StoreRecord;

    constructor(options: { maxConversationBytes?: number; temporaryBudget?: TemporaryBudgetPort } = {}) {
        this.capabilities = { persistent: false, retentionModes: ['temporary'],
            maxConversationBytes: options.maxConversationBytes ?? 64 * 1024 * 1024 };
        if (!Number.isSafeInteger(this.capabilities.maxConversationBytes) || this.capabilities.maxConversationBytes < 1) {
            throw new TypeError('maxConversationBytes must be a positive safe integer');
        }
        this.temporaryBudget = options.temporaryBudget ?? new TemporaryMemoryBudget({
            maxConversationBytes: this.capabilities.maxConversationBytes, maxTotalBytes: this.capabilities.maxConversationBytes }).scope('memory-store');
    }

    private assertOpen(): void {
        if (this.closed) throw new AgentFault('STORAGE_UNAVAILABLE', '内存存储已经关闭');
    }

    private scratch<Value>(conversationId: string, bytes: number, operation: () => Value): Value {
        this.temporaryBudget.reserve(conversationId, bytes, 'scratch');
        try { return operation(); }
        finally { this.temporaryBudget.release(conversationId, bytes, 'scratch'); }
    }

    private readCopy<Value>(value: Value, conversationId: string): Value {
        const bytes = measureCanonicalJsonBytes(value);
        return this.scratch(conversationId, bytes * 2 + 256, () => copy(value));
    }

    private decodeContent(content: MemoryContent, conversationId: string): JsonValue {
        return this.scratch(conversationId, content.bytes.length * 3 + 256,
            () => JSON.parse(content.bytes.toString('utf8')) as JsonValue);
    }

    private sameContent(content: MemoryContent, conversationId: string, value: JsonValue, bytes: number): boolean {
        if (content.bytes.length !== bytes) return false;
        return this.scratch(conversationId, Math.min(512 * 1024, bytes * 3 + 256), () => {
            let offset = 0;
            for (const chunk of canonicalJsonByteChunks(value, { maxBytes: bytes })) {
                if (!content.bytes.subarray(offset, offset + chunk.length).equals(chunk)) return false;
                offset += chunk.length;
            }
            return offset === bytes;
        });
    }

    private metadataOwners(records: Map<string, StoreRecord>, receipts: Map<string, StoredReceipt>,
        events: Map<string, AgentEvent[]>, history: Map<string, HistoryItem[]>): Map<object, string> {
        const owners = new Map<object, string>();
        for (const record of records.values()) owners.set(record, record.key.conversationId ?? SERVER_MEMORY_ID);
        for (const receipt of receipts.values()) owners.set(receipt, this.receiptOwner(receipt));
        for (const [conversationId, items] of events) for (const item of items) owners.set(item, conversationId);
        for (const [conversationId, items] of history) for (const item of items) owners.set(item, conversationId);
        return owners;
    }

    private temporaryCreateOwner(receipt: StoredReceipt): string | undefined {
        const data = receipt.result.data;
        return receipt.key.serverScope === 'server' && receipt.key.conversationId === undefined && receipt.result.ok
            && data !== null && typeof data === 'object' && !Array.isArray(data)
            && typeof receipt.temporaryCreate?.conversationId === 'string'
            && (data as Record<string, unknown>).conversationId === receipt.temporaryCreate.conversationId
            ? receipt.temporaryCreate.conversationId : undefined;
    }

    private receiptOwner(receipt: StoredReceipt): string {
        return receipt.key.conversationId ?? this.temporaryCreateOwner(receipt) ?? SERVER_MEMORY_ID;
    }

    private closedTemporaryExpiry(record: StoreRecord): number {
        const value = record.value;
        if (record.key.kind !== 'conversation' || value.state !== 'closed' || value.cleanupState !== 'released' || value.activeRunId
            || value.closeCleanupCompleted !== true || (value.retention as { mode?: string } | undefined)?.mode !== 'temporary') return Infinity;
        const expiry = typeof value.temporaryMetadataExpiresAt === 'string' ? Date.parse(value.temporaryMetadataExpiresAt) : NaN;
        return Number.isFinite(expiry) ? expiry : Infinity;
    }

    private indexConversationMetadata(): void {
        this.conversationMetadata.clear();
        const indexFor = (conversationId: string): ConversationMetadataIndex => {
            let index = this.conversationMetadata.get(conversationId);
            if (!index) { index = { records: new Set(), receipts: new Set(), contentCount: 0 }; this.conversationMetadata.set(conversationId, index); }
            return index;
        };
        for (const record of this.records.values()) {
            if (record.key.conversationId) indexFor(record.key.conversationId).records.add(record);
            if (this.closedTemporaryExpiry(record) !== Infinity) this.temporaryMetadataCandidates.set(record.key.id, record);
        }
        for (const [conversationId, record] of this.temporaryMetadataCandidates) {
            if (this.records.get(storeKey(record.key)) !== record || this.closedTemporaryExpiry(record) === Infinity) this.temporaryMetadataCandidates.delete(conversationId);
        }
        for (const receipt of this.receipts.values()) indexFor(this.receiptOwner(receipt)).receipts.add(receipt);
        for (const key of this.contents.keys()) indexFor((JSON.parse(key) as string[])[0]).contentCount++;
    }

    temporaryMetadataUsage(): TemporaryMetadataUsage {
        this.assertOpen();
        const closed = new Set<string>();
        let nextExpiry = Infinity;
        for (const record of this.records.values()) {
            const expiry = this.closedTemporaryExpiry(record);
            if (expiry !== Infinity) { closed.add(record.key.id); nextExpiry = Math.min(nextExpiry, expiry); }
        }
        let recordCount = 0, receiptCount = 0, createReceiptCount = 0, contentBytes = 0;
        for (const record of this.records.values()) if (record.key.conversationId && closed.has(record.key.conversationId)) {
            recordCount++; contentBytes += this.metadataHolds.get(record)?.bytes ?? 0;
        }
        for (const receipt of this.receipts.values()) if (closed.has(this.receiptOwner(receipt))) {
            receiptCount++; contentBytes += this.metadataHolds.get(receipt)?.bytes ?? 0;
            if (this.temporaryCreateOwner(receipt)) createReceiptCount++;
        }
        return { closedConversations: closed.size, recordCount, receiptCount, createReceiptCount, contentBytes,
            nextExpiryAt: nextExpiry === Infinity ? null : new Date(nextExpiry).toISOString() };
    }

    async collectTemporaryMetadata(options: TemporaryMetadataSweepOptions): Promise<TemporaryMetadataSweepResult> {
        this.assertOpen();
        if (!Number.isSafeInteger(options.now)) throw new AgentFault('INVALID_PARAMS', '临时元数据回收需要有效时钟');
        const collectedConversationIds: string[] = [];
        let bytesReleased = 0;
        if (!this.temporaryMetadataScan && !this.temporaryMetadataPending && options.now < this.nextTemporaryMetadataExpiry) {
            return { collectedConversationIds, bytesReleased, hasMore: false };
        }
        if (!this.temporaryMetadataScan) {
            this.temporaryMetadataScan = { records: this.temporaryMetadataCandidates.values(), nextExpiry: Infinity };
            this.nextTemporaryMetadataExpiry = Infinity;
        }
        const scan = this.temporaryMetadataScan;
        const started = performance.now();
        let work = 0;
        const hasOnlyMetadata = (record: StoreRecord): boolean => {
            const conversationId = record.key.id;
            const index = this.conversationMetadata.get(conversationId);
            return !this.lifecycleFrozenIds.has(conversationId) && !record.value.lifecycleTransition
                && index?.records.size === 1 && index.records.has(record) && index.contentCount === 0
                && !this.history.get(conversationId)?.length && !this.events.get(conversationId)?.length
                && !record.value.activeRunId;
        };
        const releaseMetadata = (value: object): void => {
            const hold = this.metadataHolds.get(value);
            if (!hold) throw new AgentFault('TEMPORARY_BUDGET_ACCOUNTING', '待回收元数据缺少原字节预留');
            this.temporaryBudget.release(hold.conversationId, hold.bytes);
            bytesReleased += hold.bytes; this.metadataHolds.delete(value);
        };
        while (work < 128 && collectedConversationIds.length < 4 && (work === 0 || performance.now() - started < 4)) {
            const pending = this.temporaryMetadataPending;
            const next = pending ? { value: pending, done: false } : scan.records.next();
            this.temporaryMetadataPending = undefined;
            if (next.done) {
                this.nextTemporaryMetadataExpiry = Math.min(this.nextTemporaryMetadataExpiry, scan.nextExpiry);
                this.temporaryMetadataScan = undefined;
                break;
            }
            const record = next.value;
            work++;
            const conversationId = record.key.id;
            if (this.records.get(storeKey(record.key)) !== record) continue;
            const expiry = this.closedTemporaryExpiry(record);
            const hold = this.metadataHolds.get(record);
            const due = Math.max(expiry, hold?.retryAfter ?? -Infinity);
            if (due > options.now) { scan.nextExpiry = Math.min(scan.nextExpiry, due); continue; }
            const defer = (): void => {
                if (hold) hold.retryAfter = options.now + TEMPORARY_METADATA_SWEEP_MS;
                scan.nextExpiry = Math.min(scan.nextExpiry, options.now + TEMPORARY_METADATA_SWEEP_MS);
            };
            if (!hasOnlyMetadata(record)) { defer(); continue; }
            if (options.canCollect) {
                let allowed: boolean;
                try { allowed = await options.canCollect(conversationId); }
                catch (error) {
                    if (error instanceof AgentFault && !error.code.startsWith('STORAGE_') && error.code !== 'IPC_UNAVAILABLE') throw error;
                    if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError || error instanceof SyntaxError) throw error;
                    defer(); continue;
                }
                if (!allowed) { defer(); continue; }
            }
            if (this.records.get(storeKey(record.key)) !== record || !hasOnlyMetadata(record)) { defer(); continue; }
            const index = this.conversationMetadata.get(conversationId)!;
            let removed = 0;
            for (const receipt of index.receipts) {
                if (work >= 128 || removed > 0 && performance.now() - started >= 4) break;
                this.receipts.delete(receiptKey(receipt.key)); index.receipts.delete(receipt);
                releaseMetadata(receipt); removed++; work++;
            }
            if (index.receipts.size) { this.temporaryMetadataPending = record; break; }
            this.records.delete(storeKey(record.key));
            this.temporaryMetadataCandidates.delete(conversationId);
            releaseMetadata(record); this.conversationMetadata.delete(conversationId);
            this.history.delete(conversationId); this.events.delete(conversationId);
            collectedConversationIds.push(conversationId);
        }
        return { collectedConversationIds, bytesReleased, hasMore: Boolean(this.temporaryMetadataScan || this.temporaryMetadataPending)
            || this.nextTemporaryMetadataExpiry <= options.now };
    }

    async getRecord<Value = Record<string, unknown>>(key: StoreKey): Promise<StoreRecord<Value> | undefined> {
        this.assertOpen();
        const record = this.records.get(storeKey(key));
        return record ? this.readCopy(record, key.conversationId ?? SERVER_MEMORY_ID) as StoreRecord<Value> : undefined;
    }

    async readModelStepPairings(query: ModelStepPairingQuery): Promise<ModelStepPairing[]> {
        this.assertOpen();
        validateModelStepPairingQuery(query);
        return query.stepIds.map(stepId => modelStepPairing(this.records.get(storeKey({ conversationId: query.conversationId, kind: 'step', id: stepId }))?.value));
    }

    async listRecords<Value = Record<string, unknown>>(query: StoreRecordQuery): Promise<StorePage<StoreRecord<Value>>> {
        this.assertOpen();
        const limit = query.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new AgentFault('INVALID_PARAMS', '分页大小须为1至200');
        const matching = [...this.records.values()].filter(record => record.key.kind === query.kind
            && (query.conversationId === undefined || record.key.conversationId === query.conversationId))
            .sort((left, right) => storeKey(left.key).localeCompare(storeKey(right.key)))
            .filter(record => !query.cursor || storeKey(record.key).localeCompare(query.cursor) > 0);
        const items = matching.slice(0, limit);
        const copied = items.map(record => this.readCopy(record, record.key.conversationId ?? SERVER_MEMORY_ID));
        return { items: copied as StoreRecord<Value>[], hasMore: matching.length > limit,
            nextCursor: matching.length > limit && items.length ? storeKey(items[items.length - 1].key) : null };
    }

    async getReceipt(key: ReceiptKey): Promise<StoredReceipt | undefined> {
        this.assertOpen();
        const receipt = this.receipts.get(receiptKey(key));
        return receipt ? this.readCopy(receipt, key.conversationId ?? SERVER_MEMORY_ID) : undefined;
    }

    async readContent(conversationId: string, contentId: string): Promise<JsonValue | undefined> {
        this.assertOpen();
        const value = this.contents.get(JSON.stringify([conversationId, contentId]));
        return value === undefined ? undefined : this.decodeContent(value, conversationId);
    }

    async readArtifact(query: ArtifactQuery): Promise<ArtifactChunk> {
        this.assertOpen();
        const offset = query.offset ?? 0;
        const maxBytes = query.maxBytes ?? DEFAULT_ARTIFACT_BYTES;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARTIFACT_BYTES) {
            throw new AgentFault('INVALID_PARAMS', '正文分片偏移须为非负安全整数，读取上限为512KiB');
        }
        const content = this.contents.get(JSON.stringify([query.conversationId, query.artifactId]));
        if (!content) throw new AgentFault('NOT_FOUND', '找不到该会话内的正文引用');
        if (offset > content.bytes.length) throw new AgentFault('INVALID_PARAMS', '正文分片偏移超过总字节数', { totalBytes: content.bytes.length });
        const end = Math.min(content.bytes.length, offset + maxBytes);
        const complete = end === content.bytes.length;
        return this.scratch(query.conversationId, Math.ceil((end - offset) / 3) * 8 + 256, () => ({ artifactId: query.artifactId,
            mime: 'application/json' as const, offset, totalBytes: content.bytes.length, sha256: content.sha256,
            dataBase64: content.bytes.subarray(offset, end).toString('base64'), nextOffset: complete ? null : end, complete }));
    }

    async readEvents(query: StoreEventQuery): Promise<StorePage<AgentEvent>> {
        this.assertOpen();
        const matching = (this.events.get(query.conversationId) ?? []).filter(event => BigInt(event.eventSeq) > BigInt(query.afterSeq));
        const items: AgentEvent[] = [];
        let bytes = 0;
        for (const event of matching) {
            const size = Buffer.byteLength(canonicalJson(event));
            if (items.length >= query.limit || bytes + size > query.maxBytes) break;
            items.push(event);
            bytes += size;
        }
        if (!items.length && matching.length) {
            throw new AgentFault('FRAME_TOO_LARGE', '首个事件超过当前maxBytes，请增大读取预算',
                { requiredBytes: Buffer.byteLength(canonicalJson(matching[0])) });
        }
        return { items: this.readCopy(items, query.conversationId), nextCursor: items.at(-1)?.eventSeq ?? query.afterSeq, hasMore: items.length < matching.length };
    }

    async readHistory(query: HistoryQuery): Promise<HistoryPage> {
        this.assertOpen();
        const conversation = this.records.get(storeKey({ conversationId: query.conversationId, kind: 'conversation', id: query.conversationId }));
        if (!conversation) throw new AgentFault('NOT_FOUND', '找不到历史所属会话');
        const historyEpoch = Number(conversation.value.historyEpoch ?? 1);
        const viewRevision = Number(conversation.value.viewRevision ?? 0);
        const head = this.history.get(query.conversationId) ?? [];
        const currentSeq = head.at(-1)?.seq ?? 0;
        const limit = query.limit ?? 50;
        const maxBytes = query.maxBytes ?? 256 * 1024;
        const direction = query.direction ?? 'forward';
        const view = query.view ?? 'raw';
        const effectiveOnly = query.effectiveOnly ?? false;
        if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024
            || !['forward', 'backward'].includes(direction) || !['raw', 'summary', 'all'].includes(view)) {
            throw new AgentFault('INVALID_PARAMS', '历史分页参数无效');
        }
        if (query.expectedHistoryEpoch !== undefined && query.expectedHistoryEpoch !== historyEpoch) throw new AgentFault('STORAGE_CURSOR_STALE', '历史版本已经变化');
        let throughSeq = query.throughSeq ?? currentSeq;
        let lastSeq = direction === 'forward' ? 0 : throughSeq + 1;
        if (query.cursor) {
            try {
                const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
                if (cursor.version !== 1 || cursor.conversationId !== query.conversationId || cursor.historyEpoch !== historyEpoch
                    || cursor.view !== view || cursor.effectiveOnly !== effectiveOnly || cursor.direction !== direction
                    || cursor.startRound !== (query.startRound ?? null) || cursor.endRound !== (query.endRound ?? null)
                    || !Number.isSafeInteger(cursor.lastSeq) || !Number.isSafeInteger(cursor.throughSeq)
                    || Number(cursor.throughSeq) > currentSeq || Number(cursor.throughSeq) < 0
                    || (query.throughSeq !== undefined && query.throughSeq !== cursor.throughSeq)) throw new Error();
                lastSeq = Number(cursor.lastSeq);
                throughSeq = Number(cursor.throughSeq);
            } catch { throw new AgentFault('STORAGE_CURSOR_STALE', '历史游标与当前范围或版本不一致'); }
        }
        if (!Number.isSafeInteger(throughSeq) || throughSeq < 0 || throughSeq > currentSeq) throw new AgentFault('STORAGE_CURSOR_STALE', '历史读取上限已经失效');
        const rounds = [...new Set(head.filter(item => item.view === 'raw' && item.role === 'user' && item.roundId).map(item => item.roundId))];
        const matching = head.filter(item => item.seq <= throughSeq && (direction === 'forward' ? item.seq > lastSeq : item.seq < lastSeq)
            && (view === 'all' || item.view === view) && (!effectiveOnly || item.effective)
            && (query.startRound === undefined || (item.roundId && rounds.indexOf(item.roundId) + 1 >= query.startRound))
            && (query.endRound === undefined || (item.roundId && rounds.indexOf(item.roundId) + 1 <= query.endRound)));
        if (direction === 'backward') matching.reverse();
        const items: HistoryItem[] = [];
        let bytes = 0;
        for (const item of matching) {
            if (items.length === limit) break;
            let reference = item;
            if (query.includeValues === false) {
                const { value: _value, ...metadata } = item;
                reference = metadata;
            }
            const result = this.readCopy(reference, query.conversationId);
            if (query.includeValues !== false) {
                const content = this.contents.get(JSON.stringify([query.conversationId, item.contentId]));
                if (content === undefined) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '历史正文对象缺失', { contentId: item.contentId });
                if (item.objectRef.rawBytes <= 64 * 1024) result.value = this.decodeContent(content, query.conversationId);
            }
            let size = Buffer.byteLength(canonicalJson(result));
            if (size + bytes > maxBytes && result.value !== undefined) {
                delete result.value;
                size = Buffer.byteLength(canonicalJson(result));
            }
            if (size + bytes > maxBytes) break;
            items.push(result);
            bytes += size;
            lastSeq = item.seq;
        }
        if (matching.length && !items.length) throw new AgentFault('FRAME_TOO_LARGE', '历史引用超过当前分页预算');
        const hasMore = items.length < matching.length;
        const cursor = { version: 1, conversationId: query.conversationId, historyEpoch, lastSeq, throughSeq, direction, view, effectiveOnly,
            startRound: query.startRound ?? null, endRound: query.endRound ?? null };
        return { items, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null,
            historyEpoch, appendSeq: throughSeq, viewRevision };
    }

    async commitTransition(transition: StoreTransition): Promise<StoreCommitResult> {
        this.assertOpen();
        const touched = [...(transition.expected ?? []).map(entry => entry.key.conversationId),
            ...(transition.records ?? []).map(entry => entry.key.conversationId), ...(transition.remove ?? []).map(entry => entry.conversationId),
            ...(transition.contents ?? []).map(entry => entry.conversationId), ...(transition.events ?? []).map(entry => entry.conversationId),
            transition.receipt?.key.conversationId, transition.purgeConversationId];
        for (const conversationId of touched) if (conversationId && this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        if (transition.receipt) {
            const existing = this.receipts.get(receiptKey(transition.receipt.key));
            if (existing) {
                if (existing.operationHash !== transition.receipt.operationHash) throw new AgentFault('COMMAND_CONFLICT', '同一命令ID已经用于不同参数');
                return { replayed: true, receipt: this.readCopy(existing, existing.key.conversationId ?? SERVER_MEMORY_ID) };
            }
        }
        for (const conversationId of new Set(touched)) {
            if (!conversationId) continue;
            const root = this.records.get(storeKey({ conversationId, kind: 'conversation', id: conversationId }));
            if (!root?.value.lifecycleTransition) continue;
            const blocked = transition.purgeConversationId === conversationId
                || transition.contents?.some(content => content.conversationId === conversationId)
                || transition.remove?.some(key => key.conversationId === conversationId)
                || transition.events?.some(event => event.conversationId === conversationId && !event.type.startsWith('control.'))
                || transition.records?.some(record => record.key.conversationId === conversationId && (record.key.kind === 'conversation'
                    ? canonicalJson(lifecycleBusinessValue(record.value as unknown as ConversationData)) !== canonicalJson(lifecycleBusinessValue(root.value as unknown as ConversationData))
                    : record.key.kind !== 'eventAck' && storeKey(record.key) !== storeKey(controlKey(conversationId))));
            if (blocked) throw lifecycleFrozen(conversationId);
        }
        for (const expected of transition.expected) {
            const actual = this.records.get(storeKey(expected.key));
            if ((actual?.revision ?? null) !== expected.revision) {
                throw new AgentFault('REVISION_CONFLICT', '存储状态版本已经变化',
                    { key: expected.key, expectedRevision: expected.revision, currentRevision: actual?.revision ?? null });
            }
        }
        for (const record of transition.records ?? []) {
            const expected = transition.expected.find(entry => storeKey(entry.key) === storeKey(record.key));
            if (!expected || !Number.isSafeInteger(record.revision) || record.revision !== (expected.revision ?? 0) + 1) {
                throw new AgentFault('REVISION_CONFLICT', '每份状态写入须声明原版本并递增一次');
            }
            if (measureCanonicalJsonBytes(record.value) > 64 * 1024) throw new AgentFault('STORAGE_METADATA_LIMIT', '状态元数据超过64KiB，请将正文放入内容对象');
        }
        if (transition.receipt && measureCanonicalJsonBytes(transition.receipt.result) > 64 * 1024) {
            throw new AgentFault('STORAGE_METADATA_LIMIT', '回执元数据超过64KiB，请将正文放入内容对象');
        }
        const records = new Map(this.records);
        const receipts = new Map(this.receipts);
        const contents = new Map(this.contents);
        const events = new Map(this.events);
        const history = new Map(this.history);
        const createdContents = new Set<MemoryContent>();
        const createdMetadata: MetadataHold[] = [];
        const holdMetadata = <Value extends object>(value: Value, conversationId: string): Value => {
            const bytes = measureCanonicalJsonBytes(value);
            this.temporaryBudget.reserve(conversationId, bytes);
            let stored: Value;
            try { stored = copy(value); }
            catch (error) { this.temporaryBudget.release(conversationId, bytes); throw error; }
            createdMetadata.push({ value: stored, conversationId, bytes });
            return stored;
        };
        let committed = false;
        try {
        if (transition.purgeConversationId) {
            const conversationId = transition.purgeConversationId;
            const retained = new Set((transition.retainReceiptKeys ?? []).map(key => receiptKey(key)));
            for (const [key, record] of records) if (record.key.conversationId === conversationId) records.delete(key);
            for (const [key, receipt] of receipts) if (receipt.key.conversationId === conversationId && !retained.has(key)) receipts.delete(key);
            for (const key of contents.keys()) if ((JSON.parse(key) as string[])[0] === conversationId) contents.delete(key);
            events.delete(conversationId);
            history.delete(conversationId);
        }
        for (const key of transition.remove ?? []) records.delete(storeKey(key));
        for (const record of transition.records ?? []) {
            records.set(storeKey(record.key), holdMetadata(record, record.key.conversationId ?? SERVER_MEMORY_ID));
        }
        for (const content of transition.contents ?? []) {
            const bytes = measureCanonicalJsonBytes(content.value, { maxBytes: this.capabilities.maxConversationBytes });
            const key = JSON.stringify([content.conversationId, content.contentId]);
            let stored = contents.get(key);
            const previous = history.get(content.conversationId) ?? [];
            const indexed = previous.find(item => item.contentId === content.contentId);
            const sameValue = stored !== undefined && this.sameContent(stored, content.conversationId, content.value, bytes);
            if (stored && stored.kind !== content.kind) {
                const firstUserInput = stored.kind === 'input' && content.kind === 'user_input' && sameValue && !indexed
                    && content.indexHistory === true && content.history?.view === 'raw' && content.history.role === 'user' && content.history.effective === true;
                if (!firstUserInput) throw new AgentFault('INPUT_FROZEN', '同一内容ID不能改变原内容种类');
                stored = { ...stored, kind: content.kind };
            } else if (!stored || !sameValue) {
                stored = { ...encodeTemporaryJson(this.temporaryBudget, content.conversationId, content.value,
                    { maxBytes: this.capabilities.maxConversationBytes }), kind: content.kind };
                createdContents.add(stored);
            }
            const hash = stored.sha256;
            if (indexed && indexed.objectRef.hash !== hash) throw new AgentFault('INPUT_FROZEN', '已经进入历史的正文不可覆盖');
            contents.set(key, stored);
            if (content.indexHistory === true) {
                if (!content.history || !['raw', 'summary'].includes(content.history.view) || typeof content.history.effective !== 'boolean') {
                    throw new AgentFault('INVALID_PARAMS', '进入历史的内容必须有完整历史元数据');
                }
                if (indexed) {
                    const { itemId: _itemId, seq: _seq, contentId: _contentId, kind: _kind, objectRef: _ref, ...metadata } = indexed;
                    if (canonicalJson(metadata) !== canonicalJson(content.history)) throw new AgentFault('COMMAND_CONFLICT', '同一历史内容不能改变来源元数据');
                } else history.set(content.conversationId, [...previous, holdMetadata({ ...content.history, itemId: randomUUID(),
                    seq: (previous.at(-1)?.seq ?? 0) + 1, contentId: content.contentId, kind: content.kind,
                    objectRef: { hash, rawBytes: bytes } }, content.conversationId)]);
            }
        }
        for (const event of transition.events ?? []) {
            if (measureCanonicalJsonBytes(event) > 64 * 1024) throw new AgentFault('FRAME_TOO_LARGE', '单个事件超过64KiB');
            const previous = events.get(event.conversationId) ?? [];
            const lastSeq = previous.at(-1)?.eventSeq ?? '0';
            if (BigInt(event.eventSeq) !== BigInt(lastSeq) + 1n) throw new AgentFault('REVISION_CONFLICT', '事件序号须连续递增');
            events.set(event.conversationId, [...previous, holdMetadata(event, event.conversationId)]);
        }
        if (transition.receipt) receipts.set(receiptKey(transition.receipt.key),
            holdMetadata(transition.receipt, this.receiptOwner(transition.receipt)));
        const owners = this.metadataOwners(records, receipts, events, history);
        const nextHolds = new Map(this.metadataHolds);
        for (const hold of createdMetadata) nextHolds.set(hold.value, hold);
        const totals = new Map<string, number>();
        for (const [value, conversationId] of owners) {
            const hold = nextHolds.get(value);
            if (!hold) throw new AgentFault('TEMPORARY_BUDGET_ACCOUNTING', '元数据缺少共同内存预留');
            totals.set(conversationId, (totals.get(conversationId) ?? 0) + hold.bytes);
        }
        for (const [key, content] of contents) {
            const conversationId = (JSON.parse(key) as string[])[0];
            totals.set(conversationId, (totals.get(conversationId) ?? 0) + content.bytes.length);
        }
        for (const [conversationId, bytes] of totals) {
            if (bytes > this.capabilities.maxConversationBytes) throw new AgentFault('TEMPORARY_CONTENT_LIMIT', '临时会话达到内存内容上限',
                { bytes, maxBytes: this.capabilities.maxConversationBytes });
        }
        const resultReceipt = transition.receipt ? this.readCopy(transition.receipt, transition.receipt.key.conversationId ?? SERVER_MEMORY_ID) : undefined;
        const oldContents = this.contents;
        this.records = records;
        this.receipts = receipts;
        this.contents = contents;
        this.events = events;
        this.history = history;
        for (const record of transition.records ?? []) this.nextTemporaryMetadataExpiry = Math.min(this.nextTemporaryMetadataExpiry, this.closedTemporaryExpiry(record));
        committed = true;
        for (const [value, hold] of nextHolds) if (!owners.has(value)) {
            this.temporaryBudget.release(hold.conversationId, hold.bytes);
            nextHolds.delete(value);
        }
        this.metadataHolds.clear();
        for (const [value, hold] of nextHolds) this.metadataHolds.set(value, hold);
        this.indexConversationMetadata();
        const retained = new Set([...contents.values()].map(content => content.release));
        for (const content of new Set([...oldContents.values(), ...createdContents])) if (!retained.has(content.release)) content.release();
        return { replayed: false, ...(resultReceipt ? { receipt: resultReceipt } : {}) };
        } catch (error) {
            if (!committed) {
                for (const content of createdContents) content.release();
                for (const hold of createdMetadata) this.temporaryBudget.release(hold.conversationId, hold.bytes);
            }
            throw error;
        }
    }

    freezeConversationLifecycle(conversationId: string): () => void {
        this.assertOpen();
        if (this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        this.lifecycleFrozenIds.add(conversationId);
        return () => this.lifecycleFrozenIds.delete(conversationId);
    }

    captureConversationLifecycle(conversationId: string): LifecycleCapture<LifecycleCoreSnapshot> {
        this.assertOpen();
        if (!this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        const records = [...this.records.values()].filter(record => record.key.conversationId === conversationId);
        const receipts = [...this.receipts.values()].filter(receipt => lifecycleReceiptOwner(receipt) === conversationId);
        const contents = [...this.contents].filter(([key]) => (JSON.parse(key) as string[])[0] === conversationId);
        const events = this.events.get(conversationId) ?? [], history = this.history.get(conversationId) ?? [];
        const bytes = measureCanonicalJsonBytes({ records, receipts, events, history }) * 3
            + contents.reduce((total, [, content]) => total + content.bytes.length * 4, 0);
        this.temporaryBudget.reserve(conversationId, bytes, 'scratch');
        let released = false;
        try {
            const value: LifecycleCoreSnapshot = { schemaVersion: 1, conversationId, records: copy(records), receipts: copy(receipts),
                events: copy(events), history: copy(history), contents: contents.map(([key, content]) => ({
                    contentId: (JSON.parse(key) as string[])[1], kind: content.kind, sha256: content.sha256,
                    rawBytes: content.bytes.length, value: JSON.parse(content.bytes.toString('utf8')) as JsonValue })) };
            return { value, release: () => { if (!released) { released = true; this.temporaryBudget.release(conversationId, bytes, 'scratch'); } } };
        } catch (error) { this.temporaryBudget.release(conversationId, bytes, 'scratch'); throw error; }
    }

    stageConversationLifecycle(snapshot: LifecycleCoreSnapshot): LifecycleStage {
        this.assertOpen();
        const conversationId = snapshot.conversationId;
        requireLifecycleSnapshotOwner(snapshot, conversationId);
        if (!this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        if ([...this.records.values()].some(record => record.key.conversationId === conversationId)
            || [...this.contents.keys()].some(key => (JSON.parse(key) as string[])[0] === conversationId)) {
            throw new AgentFault('REVISION_CONFLICT', '临时目标工厂已存在同会话原件');
        }
        const records = new Map<string, StoreRecord>(), receipts = new Map<string, StoredReceipt>(), contents = new Map<string, MemoryContent>();
        const holds: MetadataHold[] = [];
        const hold = <Value extends object>(entry: Value, ownerId = conversationId): Value => {
            const bytes = measureCanonicalJsonBytes(entry);
            this.temporaryBudget.reserve(ownerId, bytes);
            try { const value = copy(entry); holds.push({ value, conversationId: ownerId, bytes }); return value; }
            catch (error) { this.temporaryBudget.release(ownerId, bytes); throw error; }
        };
        let settled = false;
        const discard = () => {
            if (settled) return;
            settled = true; this.lifecycleStages.delete(discard);
            for (const content of contents.values()) content.release();
            for (const entry of holds) this.temporaryBudget.release(entry.conversationId, entry.bytes);
        };
        try {
            for (const record of snapshot.records) {
                if (record.key.conversationId !== conversationId || records.has(storeKey(record.key)) || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new AgentFault('STORAGE_SNAPSHOT_INVALID', '状态快照归属、主键或版本无效');
                records.set(storeKey(record.key), hold(record));
            }
            for (const receipt of snapshot.receipts) {
                if (lifecycleReceiptOwner(receipt) !== conversationId || receipts.has(receiptKey(receipt.key))) throw new AgentFault('STORAGE_SNAPSHOT_INVALID', '回执快照的归属或主键无效');
                const previous = this.receipts.get(receiptKey(receipt.key));
                if (previous && canonicalJson(previous) !== canonicalJson(receipt)) throw new AgentFault('COMMAND_CONFLICT', '迁移目标已有不同的原回执');
                receipts.set(receiptKey(receipt.key), previous ?? hold(receipt, this.receiptOwner(receipt)));
            }
            for (const content of snapshot.contents) {
                const key = JSON.stringify([conversationId, content.contentId]);
                if (!content.kind || contents.has(key)) throw new AgentFault('STORAGE_SNAPSHOT_INVALID', '内容快照缺少种类或存在重复ID');
                const encoded = encodeTemporaryJson(this.temporaryBudget, conversationId, content.value, { maxBytes: this.capabilities.maxConversationBytes });
                if (encoded.sha256 !== content.sha256 || encoded.bytes.length !== content.rawBytes) { encoded.release(); throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '内容快照与原SHA或字节数不同'); }
                contents.set(key, { ...encoded, kind: content.kind });
            }
            const history = snapshot.history.map((item, index) => {
                const content = contents.get(JSON.stringify([conversationId, item.contentId]));
                if (item.seq !== index + 1 || !content || item.objectRef.hash !== content.sha256 || item.objectRef.rawBytes !== content.bytes.length || item.kind !== content.kind) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '历史快照的原序号或正文引用不同');
                return hold(item);
            });
            const events = snapshot.events.map((event, index) => {
                if (event.conversationId !== conversationId || BigInt(event.eventSeq) !== BigInt(index + 1)) throw new AgentFault('STORAGE_SNAPSHOT_INVALID', '事件快照的原序号或归属不同');
                return hold(event);
            });
            this.lifecycleStages.add(discard);
            return { discard, activate: () => {
                if (settled) return;
                settled = true; this.lifecycleStages.delete(discard);
                for (const [key, record] of records) this.records.set(key, record);
                for (const record of records.values()) this.nextTemporaryMetadataExpiry = Math.min(this.nextTemporaryMetadataExpiry, this.closedTemporaryExpiry(record));
                for (const [key, receipt] of receipts) this.receipts.set(key, receipt);
                for (const [key, content] of contents) this.contents.set(key, content);
                this.history.set(conversationId, history); this.events.set(conversationId, events);
                for (const entry of holds) this.metadataHolds.set(entry.value, entry);
                this.indexConversationMetadata();
            } };
        } catch (error) { discard(); throw error; }
    }

    releaseConversationLifecycle(conversationId: string): void {
        if (!this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        for (const [key, record] of this.records) if (record.key.conversationId === conversationId) this.records.delete(key);
        for (const [key, receipt] of this.receipts) if (lifecycleReceiptOwner(receipt) === conversationId) this.receipts.delete(key);
        for (const [key, content] of this.contents) if ((JSON.parse(key) as string[])[0] === conversationId) { this.contents.delete(key); content.release(); }
        this.events.delete(conversationId); this.history.delete(conversationId);
        const owners = this.metadataOwners(this.records, this.receipts, this.events, this.history);
        for (const [value, entry] of this.metadataHolds) if (!owners.has(value)) { this.metadataHolds.delete(value); this.temporaryBudget.release(entry.conversationId, entry.bytes); }
        this.indexConversationMetadata();
    }

    finishConversationLifecycle(conversationId: string, operationId: string): void {
        if (!this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        const record = this.records.get(storeKey({ conversationId, kind: 'conversation', id: conversationId }));
        const transition = record?.value.lifecycleTransition as { operationId?: string } | undefined;
        if (!record || transition?.operationId !== operationId) throw new AgentFault('REVISION_CONFLICT', '临时工厂与原转换操作不同');
        delete record.value.lifecycleTransition;
    }

    stageConversationLifecycleReceipt(receipt: StoredReceipt): LifecycleStage {
        const conversationId = lifecycleReceiptOwner(receipt);
        if (!conversationId || !this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId ?? '');
        const key = receiptKey(receipt.key), previous = this.receipts.get(key);
        if (previous) {
            if (previous.operationHash !== receipt.operationHash) throw new AgentFault('COMMAND_CONFLICT', '原生命周期命令已有不同参数');
            return { activate: () => {}, discard: () => {} };
        }
        const ownerId = this.receiptOwner(receipt), bytes = measureCanonicalJsonBytes(receipt);
        this.temporaryBudget.reserve(ownerId, bytes);
        let value: StoredReceipt;
        try { value = copy(receipt); }
        catch (error) { this.temporaryBudget.release(ownerId, bytes); throw error; }
        let settled = false;
        const discard = () => { if (!settled) { settled = true; this.lifecycleStages.delete(discard); this.temporaryBudget.release(ownerId, bytes); } };
        this.lifecycleStages.add(discard);
        return { discard, activate: () => {
            if (settled) return;
            settled = true; this.lifecycleStages.delete(discard);
            this.receipts.set(key, value); this.metadataHolds.set(value, { value, conversationId: ownerId, bytes });
            this.indexConversationMetadata();
        } };
    }

    async close(): Promise<void> {
        if (this.closed) return;
        for (const discard of this.lifecycleStages) discard();
        for (const content of new Set(this.contents.values())) content.release();
        for (const hold of this.metadataHolds.values()) this.temporaryBudget.release(hold.conversationId, hold.bytes);
        this.metadataHolds.clear();
        this.closed = true;
        this.records.clear();
        this.receipts.clear();
        this.contents.clear();
        this.events.clear();
        this.history.clear();
        this.lifecycleFrozenIds.clear();
        this.conversationMetadata.clear(); this.temporaryMetadataCandidates.clear();
        this.temporaryMetadataScan = undefined; this.temporaryMetadataPending = undefined;
    }
}

export function createMemoryStore(options: { maxConversationBytes?: number; temporaryBudget?: TemporaryBudgetPort } = {}): MemoryStore {
    return new MemoryStore(options);
}
