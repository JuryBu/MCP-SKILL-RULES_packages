import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { StoreKey, StorePort, StoreRecord, TransitionExpected } from '../storage/port.js';
import { MemoryResourceStore } from './registry.js';
import type { OwnedResource, ResourceReceipt, ResourceStorePort } from './registry.js';
import { measureCanonicalJsonBytes } from '../media/temporary-budget.js';
import type { TemporaryBudgetPort } from '../media/temporary-budget.js';

const resourcePrefix = 'web-resource:';
const operationPrefix = 'web-resource-operation:';
const commandOutputLimit = 1048576;
const commandOutputPrefix = 'web-resource-command-output:';
interface StoredResource extends OwnedResource { commandOutput?: { hash: string; chunks: number } }

function commandReceiptFault(): never {
    throw new AgentFault('INVALID_PARAMS', '命令资源回执字段或输出超出支持范围');
}

function commandFields(source: Record<string, unknown>, strings: readonly string[], booleans: readonly string[],
    integers: readonly string[], nullable: readonly string[] = []): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const field of strings) {
        const value = source[field];
        if (value === undefined) continue;
        if (nullable.includes(field) && value === null) { result[field] = null; continue; }
        if (typeof value !== 'string' || value.length > (field === 'recoveryMetadataPath' ? 4096 : 512)) commandReceiptFault();
        result[field] = value;
    }
    for (const field of booleans) {
        const value = source[field];
        if (value === undefined) continue;
        if (typeof value !== 'boolean') commandReceiptFault();
        result[field] = value;
    }
    for (const field of integers) {
        const value = source[field];
        if (value === undefined) continue;
        if (nullable.includes(field) && value === null) { result[field] = null; continue; }
        const exitCode = ['childExitCode', 'helperExitCode', 'startErrorCode', 'cleanupErrorCode'].includes(field);
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (exitCode ? -2147483648 : 0)
            || (exitCode && value > 4294967295)) commandReceiptFault();
        result[field] = value;
    }
    return result;
}

function commandResourceReceiptMetadata(receipt: ResourceReceipt): ResourceReceipt {
    const evidence = commandFields(receipt.evidence,
        ['resourceId', 'requestId', 'actionId', 'attemptId', 'argsHash', 'cleanupState', 'stopReason',
            'startErrorType', 'processEvidenceScope', 'recoveryMetadataPath', 'recoveryState', 'spawnError'],
        ['commandStarted', 'commandStartedKnown', 'mayHaveStarted', 'terminalConfirmed', 'helperExited', 'forcedStop',
            'outputTruncated', 'manualReviewRequired', 'stopAutomaticRetry'],
        ['policyRevision', 'childExitCode', 'helperPid', 'helperExitCode', 'peakMemoryBytes', 'outputBytes', 'observedBytes',
            'activeProcessesAtRelease', 'startErrorCode'],
        ['childExitCode', 'helperPid', 'helperExitCode', 'peakMemoryBytes', 'activeProcessesAtRelease', 'startErrorType', 'startErrorCode', 'stopReason', 'spawnError']);
    const job = receipt.evidence.jobMetadata;
    if (job === null) evidence.jobMetadata = null;
    if (job !== undefined && job !== null) {
        if (typeof job !== 'object' || Array.isArray(job)) commandReceiptFault();
        evidence.jobMetadata = commandFields(job as Record<string, unknown>, ['startErrorType', 'cleanupState'],
            ['memoryLimitHit', 'commandStarted', 'terminalConfirmed', 'cancelRequested'],
            ['peakMemoryBytes', 'childExitCode', 'startErrorCode', 'activeProcessesAtRelease', 'cleanupErrorCode'],
            ['startErrorType', 'childExitCode', 'startErrorCode', 'activeProcessesAtRelease', 'cleanupErrorCode']);
    }
    const terminalConfirmed = receipt.terminalConfirmed === true && evidence.terminalConfirmed !== false;
    const released = receipt.released === true && terminalConfirmed
        && (evidence.cleanupState === undefined || evidence.cleanupState === 'released');
    const output = receipt.evidence.output;
    if (output !== undefined) {
        if (!output || typeof output !== 'object' || Array.isArray(output)) commandReceiptFault();
        const body = output as Record<string, unknown>;
        if (body.encoding !== 'base64') commandReceiptFault();
        let retainedBytes = 0;
        const clean: Record<string, unknown> = { encoding: 'base64' };
        for (const field of ['stdoutBase64', 'stderrBase64']) {
            const value = body[field];
            if (typeof value !== 'string' || value.length > 4 * Math.ceil(commandOutputLimit / 3)
                || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) commandReceiptFault();
            const decoded = Buffer.from(value, 'base64');
            if (decoded.toString('base64') !== value) commandReceiptFault();
            retainedBytes += decoded.length;
            if (retainedBytes > commandOutputLimit) commandReceiptFault();
            clean[field] = value;
        }
        if (body.retainedBytes !== retainedBytes || typeof body.observedBytes !== 'number'
            || !Number.isSafeInteger(body.observedBytes) || body.observedBytes < retainedBytes
            || typeof body.truncated !== 'boolean') commandReceiptFault();
        evidence.output = { ...clean, retainedBytes, observedBytes: body.observedBytes, truncated: body.truncated };
    }
    return { ...(typeof receipt.externalId === 'string' && receipt.externalId.length <= 512 ? { externalId: receipt.externalId } : {}),
        started: receipt.started === true ? true : receipt.started === false ? false : null,
        terminalConfirmed, released, evidence };
}

export function webResourceReceiptMetadata(receipt: ResourceReceipt): ResourceReceipt {
    const evidence: Record<string, unknown> = {};
    for (const field of ['toolName', 'operation', 'requestId', 'leaseUntil', 'hardLeaseUntil', 'referenceKind', 'contractHash', 'outputRoot', 'backendOwnerId', 'backendInstanceId', 'callerSource', 'remoteAuthentication', 'backendOutcome', 'emptyArtifact', 'backendReleased', 'artifactErrorCode', 'artifactAbandoned']) {
        const value = receipt.evidence[field];
        if (typeof value === 'string') evidence[field] = value;
    }
    if (Array.isArray(receipt.evidence.outputRefs)) evidence.outputRefs = receipt.evidence.outputRefs.map(value => {
        const reference = value as Record<string, unknown>;
        return Object.fromEntries(Object.entries(reference).filter(([field, item]) =>
            (['path', 'artifactId', 'mimeType', 'sha256'].includes(field) && typeof item === 'string')
            || (field === 'byteLength' && typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)));
    });
    return { externalId: receipt.externalId, started: receipt.started, terminalConfirmed: receipt.terminalConfirmed,
        released: receipt.released, evidence };
}

function metadata(resource: OwnedResource): OwnedResource {
    const receipt = resource.receipt && (resource.adapterId === 'native.command'
        ? commandResourceReceiptMetadata(resource.receipt) : webResourceReceiptMetadata(resource.receipt));
    const unconfirmed = resource.adapterId === 'native.command' && receipt && (!receipt.terminalConfirmed || !receipt.released);
    return { resourceId: resource.resourceId, issuerId: resource.issuerId, principalId: resource.principalId,
        conversationId: resource.conversationId, runId: resource.runId, rootRunId: resource.rootRunId,
        runEpoch: resource.runEpoch, actionId: resource.actionId, requestId: resource.requestId, argsHash: resource.argsHash,
        adapterId: resource.adapterId, kind: resource.kind, externalId: resource.externalId,
        leaseUntil: resource.leaseUntil, state: unconfirmed && resource.state === 'released' ? 'unresolved' : resource.state,
        cleanupState: unconfirmed && resource.cleanupState === 'released' ? 'unconfirmed' : resource.cleanupState,
        retention: { mode: resource.retention.mode, ...(resource.retention.ttlDurationMs === undefined ? {} : { ttlDurationMs: resource.retention.ttlDurationMs }) },
        ...(receipt ? { receipt } : {}) };
}

function key(id: string): StoreKey { return { conversationId: null, kind: 'control', id }; }

export interface WebResourceStoreOptions {
    adapterIds?: readonly string[];
    fallback?: ResourceStorePort;
    temporaryBudget?: TemporaryBudgetPort;
}

export interface WebResourceRetentionRemoval {
    expected: TransitionExpected[];
    remove: StoreKey[];
    deferredResourceIds: string[];
}

export class WebResourceStore implements ResourceStorePort {
    private readonly fallback: ResourceStorePort;
    private readonly adapterIds?: ReadonlySet<string>;
    private readonly temporaryBudget?: TemporaryBudgetPort;
    private readonly temporaryCharges = new Map<string, { conversationId: string; bytes: number }>();
    private temporarySerial: Promise<void> = Promise.resolve();

    constructor(readonly port: StorePort, options: WebResourceStoreOptions = {}) {
        this.fallback = options.fallback ?? new MemoryResourceStore();
        this.adapterIds = options.adapterIds === undefined ? undefined : new Set(options.adapterIds);
        this.temporaryBudget = options.temporaryBudget;
    }

    private handles(resource: OwnedResource): boolean {
        return !this.adapterIds || this.adapterIds.has(resource.adapterId);
    }

    private temporaryWrite<Value>(resource: OwnedResource, write: () => Promise<Value>, retained: (value: Value) => boolean): Promise<Value> {
        if (resource.adapterId !== 'native.command') return write();
        const pending = this.temporarySerial.then(async () => {
            const budget = this.temporaryBudget;
            if (!budget) throw new AgentFault('TEMPORARY_BUDGET_ACCOUNTING', '临时命令资源须接入共享内存预算');
            const retainedResource = await this.fallback.get(resource.resourceId);
            if (retainedResource?.receipt) {
                resource.receipt ??= structuredClone(retainedResource.receipt);
                if (resource.receipt.evidence.output === undefined && retainedResource.receipt.evidence.output !== undefined) {
                    resource.receipt.evidence.output = structuredClone(retainedResource.receipt.evidence.output);
                }
            }
            const bytes = measureCanonicalJsonBytes(resource);
            const previous = this.temporaryCharges.get(resource.resourceId);
            if (previous && previous.conversationId !== resource.conversationId) {
                throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '临时命令回执须保留原会话归属');
            }
            const increase = Math.max(0, bytes - (previous?.bytes ?? 0));
            if (increase) budget.reserve(resource.conversationId, increase);
            let held = true;
            try {
                const result = await write();
                if (retained(result)) {
                    if (previous && previous.bytes > bytes) budget.release(previous.conversationId, previous.bytes - bytes);
                    this.temporaryCharges.set(resource.resourceId, { conversationId: resource.conversationId, bytes });
                    held = false;
                }
                return result;
            } finally { if (held && increase) budget.release(resource.conversationId, increase); }
        });
        this.temporarySerial = pending.then(() => {}, () => {});
        return pending;
    }

    private operationKey(resource: OwnedResource): StoreKey {
        const hash = createHash('sha256').update(canonicalJson([resource.issuerId, resource.principalId,
            resource.conversationId, resource.runId, resource.actionId, resource.adapterId])).digest('hex');
        return key(operationPrefix + hash);
    }

    private outputKeys(resource: StoredResource): StoreKey[] {
        const reference = resource.commandOutput;
        if (!reference) return [];
        if (!/^[a-f0-9]{64}$/.test(reference.hash) || !Number.isSafeInteger(reference.chunks)
            || reference.chunks < 1 || reference.chunks > 44) throw new AgentFault('RESOURCE_UNRESOLVED', '命令输出引用待恢复');
        return Array.from({ length: reference.chunks }, (_, index) => key(commandOutputPrefix + resource.resourceId + ':' + reference.hash + ':' + index));
    }

    private async hydrate(stored: StoredResource): Promise<OwnedResource> {
        const resource = structuredClone(stored);
        delete resource.commandOutput;
        if (!stored.commandOutput) return resource;
        const chunks: string[] = [];
        for (const recordKey of this.outputKeys(stored)) {
            const chunk = await this.port.getRecord<{ text: string }>(recordKey);
            if (!chunk || typeof chunk.value.text !== 'string' || chunk.value.text.length > 32768) {
                throw new AgentFault('RESOURCE_UNRESOLVED', '原命令输出分片待恢复', { resourceId: stored.resourceId }, true);
            }
            chunks.push(chunk.value.text);
        }
        const text = chunks.join('');
        if (createHash('sha256').update(text).digest('hex') !== stored.commandOutput.hash || !resource.receipt) {
            throw new AgentFault('RESOURCE_UNRESOLVED', '原命令输出校验未确认', { resourceId: stored.resourceId }, true);
        }
        resource.receipt.evidence.output = JSON.parse(text);
        resource.receipt = commandResourceReceiptMetadata(resource.receipt);
        return resource;
    }

    private outputTransition(resource: OwnedResource, previous?: StoredResource): {
        stored: StoredResource; expected: TransitionExpected[]; records: StoreRecord[]; remove: StoreKey[];
    } {
        const stored: StoredResource = structuredClone(resource);
        const output = resource.adapterId === 'native.command' ? stored.receipt?.evidence.output : undefined;
        const records: StoreRecord[] = [];
        const expected: TransitionExpected[] = [];
        if (output !== undefined) {
            const text = canonicalJson(output);
            const hash = createHash('sha256').update(text).digest('hex');
            stored.commandOutput = { hash, chunks: Math.ceil(text.length / 32768) };
            delete stored.receipt!.evidence.output;
            if (hash !== previous?.commandOutput?.hash) {
                for (const [index, recordKey] of this.outputKeys(stored).entries()) {
                    expected.push({ key: recordKey, revision: null });
                    records.push({ key: recordKey, revision: 1, value: { text: text.slice(index * 32768, (index + 1) * 32768) } });
                }
            }
        }
        const remove = previous?.commandOutput?.hash === stored.commandOutput?.hash ? [] : previous ? this.outputKeys(previous) : [];
        expected.push(...remove.map(recordKey => ({ key: recordKey, revision: 1 })));
        return { stored, expected, records, remove };
    }

    async allocate(resource: OwnedResource): Promise<{ resource: OwnedResource; reused: boolean }> {
        if (!this.handles(resource)) return this.fallback.allocate(resource);
        const clean = metadata(resource);
        if (resource.retention.mode === 'temporary') return this.temporaryWrite(clean, () => this.fallback.allocate(clean), result => !result.reused);
        const operationKey = this.operationKey(clean);
        const lookup = async (): Promise<OwnedResource | undefined> => {
            const existing = await this.port.getRecord<{ resourceId: string; argsHash: string }>(operationKey);
            if (!existing) return undefined;
            if (existing.value.argsHash !== clean.argsHash) throw new AgentFault('COMMAND_ID_REUSED', '同一网页资源动作的参数已变化');
            const previous = await this.get(existing.value.resourceId);
            if (!previous) throw new AgentFault('RESOURCE_UNRESOLVED', '网页资源索引存在，原记录待恢复', { resourceId: existing.value.resourceId }, true);
            return previous;
        };
        const previous = await lookup();
        if (previous) return { resource: previous, reused: true };
        const resourceKey = key(resourcePrefix + clean.resourceId);
        const output = this.outputTransition(clean);
        try {
            await this.port.commitTransition({ expected: [{ key: resourceKey, revision: null }, { key: operationKey, revision: null }, ...output.expected], records: [
                { key: resourceKey, revision: 1, value: output.stored as unknown as Record<string, unknown> },
                { key: operationKey, revision: 1, value: { conversationId: clean.conversationId, rootRunId: clean.rootRunId,
                    runId: clean.runId, adapterId: clean.adapterId, resourceId: clean.resourceId, argsHash: clean.argsHash } },
                ...output.records,
            ] });
        } catch (error) {
            if (!(error instanceof AgentFault) || error.code !== 'REVISION_CONFLICT') throw error;
            const winner = await lookup();
            if (!winner) throw error;
            return { resource: winner, reused: true };
        }
        return { resource: structuredClone(clean), reused: false };
    }

    async get(resourceId: string): Promise<OwnedResource | undefined> {
        const temporary = await this.fallback.get(resourceId);
        if (temporary) return temporary;
        const stored = await this.port.getRecord<StoredResource>(key(resourcePrefix + resourceId));
        return stored ? this.hydrate(stored.value) : undefined;
    }

    async put(resource: OwnedResource): Promise<void> {
        if (!this.handles(resource)) { await this.fallback.put(resource); return; }
        const clean = metadata(resource);
        if (clean.retention.mode === 'temporary') { await this.temporaryWrite(clean, () => this.fallback.put(clean), () => true); return; }
        const recordKey = key(resourcePrefix + clean.resourceId);
        const previous = await this.port.getRecord<StoredResource>(recordKey);
        if (!previous || canonicalJson([previous.value.issuerId, previous.value.principalId, previous.value.conversationId,
            previous.value.rootRunId, previous.value.runId, previous.value.actionId, previous.value.requestId, previous.value.argsHash,
            previous.value.adapterId, previous.value.kind, previous.value.runEpoch, previous.value.retention])
            !== canonicalJson([clean.issuerId, clean.principalId, clean.conversationId, clean.rootRunId, clean.runId,
                clean.actionId, clean.requestId, clean.argsHash, clean.adapterId, clean.kind, clean.runEpoch, clean.retention])) throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '网页资源更新须保留原始归属');
        if (previous.value.state === 'released' && clean.state !== 'released') throw new AgentFault('POLICY_CHANGED', '已释放网页资源停止更新活动状态');
        if (previous.value.receipt) {
            const originalReceipt = (await this.hydrate(previous.value)).receipt!;
            clean.receipt ??= originalReceipt;
            const recovery = originalReceipt.evidence;
            const fields = clean.adapterId === 'native.command'
                ? ['resourceId', 'actionId', 'attemptId', 'policyRevision', 'argsHash']
                : ['outputRoot', 'outputRefs', 'referenceKind', 'toolName'];
            for (const field of fields) {
                if (clean.adapterId === 'native.command' && recovery[field] !== undefined && clean.receipt.evidence[field] !== undefined
                    && clean.receipt.evidence[field] !== recovery[field]) throw new AgentFault('RESOURCE_IDENTITY_MISMATCH', '命令资源更新须保留原执行标识');
                if (clean.receipt.evidence[field] === undefined && recovery[field] !== undefined) clean.receipt.evidence[field] = structuredClone(recovery[field]);
            }
            if (clean.adapterId === 'native.command') clean.receipt = commandResourceReceiptMetadata({ ...clean.receipt,
                evidence: { ...recovery, ...clean.receipt.evidence } });
        }
        const output = this.outputTransition(clean, previous.value);
        await this.port.commitTransition({ expected: [{ key: recordKey, revision: previous.revision }, ...output.expected],
            records: [{ key: recordKey, revision: previous.revision + 1, value: output.stored as unknown as Record<string, unknown> }, ...output.records],
            remove: output.remove });
    }

    async list(conversationId: string, rootRunId: string): Promise<OwnedResource[]> {
        const records = await this.fallback.list(conversationId, rootRunId);
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
            const page = await this.port.listRecords<OwnedResource>({ kind: 'control', conversationId: null, cursor, limit: 100 });
            for (const record of page.items as StoreRecord<OwnedResource>[]) {
                if (record.key.id.startsWith(resourcePrefix) && record.value.conversationId === conversationId
                    && record.value.rootRunId === rootRunId) records.push(await this.hydrate(record.value));
            }
            if (!page.hasMore) break;
            if (!page.nextCursor || seen.has(page.nextCursor)) throw new AgentFault('STORAGE_CURSOR_STALE', '网页资源记录分页未前进');
            seen.add(page.nextCursor);
            cursor = page.nextCursor;
        } while (cursor);
        return records;
    }

    async retentionRemovalPlan(deletedConversationIds: readonly string[]): Promise<WebResourceRetentionRemoval> {
        const conversations = new Set(deletedConversationIds);
        const resources = new Map<string, StoreRecord<OwnedResource>>();
        const deferred = new Set<string>();
        const selected: StoreRecord[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
            const page = await this.port.listRecords<OwnedResource>({ conversationId: null, kind: 'control', ...(cursor ? { cursor } : {}) });
            for (const record of page.items) if (record.key.id.startsWith(resourcePrefix) && conversations.has(record.value.conversationId) && this.handles(record.value)) {
                resources.set(record.value.resourceId, record);
                if (record.value.state !== 'released' || record.value.cleanupState !== 'released'
                    || !record.value.receipt?.released || !record.value.receipt.terminalConfirmed) deferred.add(record.value.resourceId);
                else {
                    selected.push(record as unknown as StoreRecord);
                    for (const recordKey of this.outputKeys(record.value)) {
                        const chunk = await this.port.getRecord(recordKey);
                        if (!chunk) throw new AgentFault('RESOURCE_UNRESOLVED', '原命令输出分片待恢复');
                        selected.push(chunk);
                    }
                }
            }
            if (page.nextCursor === null) { cursor = undefined; break; }
            if (!page.nextCursor || seen.has(page.nextCursor)) throw new AgentFault('STORAGE_CURSOR_STALE', '网页资源记录分页未前进');
            seen.add(page.nextCursor);
            cursor = page.nextCursor;
        } while (cursor);
        seen.clear();
        do {
            const page = await this.port.listRecords<{ conversationId?: string; resourceId: string }>({ conversationId: null,
                kind: 'control', ...(cursor ? { cursor } : {}) });
            for (const record of page.items) if (record.key.id.startsWith(operationPrefix)) {
                const original = resources.get(record.value.resourceId);
                if (original && !deferred.has(record.value.resourceId)) selected.push(record as unknown as StoreRecord);
                else if (!original && record.value.conversationId && conversations.has(record.value.conversationId)) deferred.add(record.value.resourceId);
            }
            if (page.nextCursor === null) { cursor = undefined; break; }
            if (!page.nextCursor || seen.has(page.nextCursor)) throw new AgentFault('STORAGE_CURSOR_STALE', '网页资源索引分页未前进');
            seen.add(page.nextCursor);
            cursor = page.nextCursor;
        } while (cursor);
        return { expected: selected.map(record => ({ key: record.key, revision: record.revision })),
            remove: selected.map(record => record.key), deferredResourceIds: [...deferred] };
    }

    async listTemporaryConversation(conversationId: string): Promise<OwnedResource[]> {
        if (!this.fallback.listTemporaryConversation) throw new AgentFault('CLEANUP_UNCONFIRMED', '原资源Store尚未提供完整临时CID列举，原记录保留');
        return this.fallback.listTemporaryConversation(conversationId);
    }

    async forgetTemporaryConversation(conversationId: string, expected: readonly OwnedResource[]): Promise<void> {
        if (!this.fallback.forgetTemporaryConversation) throw new AgentFault('CLEANUP_UNCONFIRMED', '原资源Store尚未提供临时CID原子清理，原记录保留');
        const pending = this.temporarySerial.then(async () => {
            await this.fallback.forgetTemporaryConversation!(conversationId, expected);
            for (const resource of expected) {
                const charge = this.temporaryCharges.get(resource.resourceId);
                if (!charge) continue;
                this.temporaryBudget!.release(charge.conversationId, charge.bytes);
                this.temporaryCharges.delete(resource.resourceId);
            }
        });
        this.temporarySerial = pending.then(() => {}, () => {});
        await pending;
    }
}
