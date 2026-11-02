import { createHash } from 'node:crypto';
import { AgentFault, canonicalJson } from '../protocol.js';
import type { JsonValue, RetainPolicy } from '../protocol.js';
import type { ExecutorContext } from '../runtime.js';
import type { NativeBlock, NormalizedResponse } from '../providers/types.js';
import { base64Chunks, inspectBase64, normalizeMime, requireMediaSlice, validateMediaBytes, validateRemoteUri } from './validation.js';
import type { MediaArtifact, MediaArtifactChunk, MediaArtifactPage, MediaArtifactQuery, MediaLimits, MediaPersistencePort } from './types.js';
import { DEFAULT_MEDIA_LIMITS, mediaArtifactValue } from './types.js';
import { measureCanonicalJsonBytes, TemporaryMemoryBudget } from './temporary-budget.js';
import type { TemporaryBudgetPort } from './temporary-budget.js';
import { lifecycleFrozen, requireLifecycleSnapshotOwner } from '../conversation-lifecycle/migration-snapshots.js';
import type { LifecycleCapture, LifecycleMediaSnapshot, LifecycleStage } from '../conversation-lifecycle/migration-snapshots.js';

interface TemporaryMedia {
    artifacts: Map<string, MediaArtifact>;
    payloads: Map<string, Buffer>;
    bytes: number;
}

export interface MediaServiceOptions {
    retention(conversationId: string): Promise<RetainPolicy>;
    durable?: MediaPersistencePort;
    limits?: Partial<MediaLimits>;
    now?: () => Date;
    temporaryBudget?: TemporaryBudgetPort;
}

export function mediaArtifactId(owner: { conversationId: string; runId: string; attemptId: string; candidateIndex: number; blockIndex: number }): string {
    return `media:${createHash('sha256').update(canonicalJson({ conversationId: owner.conversationId,
        runId: owner.runId, attemptId: owner.attemptId, candidateIndex: owner.candidateIndex, blockIndex: owner.blockIndex })).digest('hex')}`;
}

function publicationFingerprint(artifact: MediaArtifact): string {
    const { createdAt: _createdAt, absolutePath: _absolutePath, path: _path, ...stable } = artifact;
    return canonicalJson(stable);
}

export class MediaService {
    readonly limits: Readonly<MediaLimits>;
    private readonly temporary = new Map<string, TemporaryMedia>();
    private readonly closedTemporary = new Set<string>();
    private readonly temporaryBudget: TemporaryBudgetPort;
    private readonly lifecycleFrozenIds = new Set<string>();
    private readonly lifecycleStages = new Map<string, () => void>();
    private readonly publications = new Map<string, Set<Promise<JsonValue[]>>>();

    constructor(private readonly options: MediaServiceOptions) {
        this.limits = Object.freeze({ ...DEFAULT_MEDIA_LIMITS, ...options.limits });
        for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value < 1) {
            throw new AgentFault('INVALID_PARAMS', '媒体资源上限须为正整数');
        }
        this.temporaryBudget = options.temporaryBudget ?? new TemporaryMemoryBudget({
            maxConversationBytes: this.limits.maxTemporaryBytes, maxTotalBytes: this.limits.maxTemporaryBytes }).scope('media');
    }

    publish(context: Pick<ExecutorContext, 'snapshot' | 'signal'>, response: NormalizedResponse): Promise<JsonValue[]> {
        const conversationId = context.snapshot.conversationId;
        if (this.lifecycleFrozenIds.has(conversationId)) return Promise.reject(lifecycleFrozen(conversationId));
        const pending = this.publishActive(context, response);
        const publications = this.publications.get(conversationId) ?? new Set<Promise<JsonValue[]>>();
        publications.add(pending); this.publications.set(conversationId, publications);
        void pending.finally(() => { publications.delete(pending); if (!publications.size) this.publications.delete(conversationId); }).catch(() => undefined);
        return pending;
    }

    private async publishActive(context: Pick<ExecutorContext, 'snapshot' | 'signal'>, response: NormalizedResponse): Promise<JsonValue[]> {
        const { conversationId } = context.snapshot;
        if (context.signal.aborted) throw new AgentFault('E_CANCELLED', '媒体发布前任务已取消');
        const blocks = response.blocks.filter((block): block is NativeBlock & { type: MediaArtifact['type'] } =>
            block.type === 'image' || block.type === 'audio' || block.type === 'video' || block.type === 'file');
        if (!blocks.length) return [];
        const configuredRetention = await this.options.retention(conversationId);
        const retention: RetainPolicy = { mode: configuredRetention.mode,
            ...(configuredRetention.mode === 'ttl' ? { ttlDurationMs: configuredRetention.ttlDurationMs } : {}) };
        if (retention.mode !== 'temporary' && !this.options.durable) {
            throw new AgentFault('MEDIA_PERSISTENCE_UNAVAILABLE', '当前服务未接入持久媒体事务');
        }
        if (blocks.length > this.limits.maxBlocks) throw new AgentFault('MEDIA_CONTENT_LIMIT', '单次响应媒体块数量超过上限');
        const inline = blocks.filter(block => typeof block.dataBase64 === 'string');
        const scratchBytes = retention.mode === 'temporary' && inline.length ? Math.max(...inline.map(block =>
            Math.min(48 * 1024, Math.floor(block.dataBase64!.length * 3 / 4)))) * 6 + 1024 : 0;
        if (scratchBytes) this.temporaryBudget.reserve(conversationId, scratchBytes, 'scratch');
        try { return await this.publishBlocks(context, response, blocks, retention); }
        finally { if (scratchBytes) this.temporaryBudget.release(conversationId, scratchBytes, 'scratch'); }
    }

    private async publishBlocks(context: Pick<ExecutorContext, 'snapshot' | 'signal'>, response: NormalizedResponse,
        blocks: (NativeBlock & { type: MediaArtifact['type'] })[], retention: RetainPolicy): Promise<JsonValue[]> {
        const { conversationId, runId, runEpoch } = context.snapshot;
        const prepared: { artifact: MediaArtifact; dataBase64?: string }[] = [];
        const positions = new Set<string>();
        let totalBytes = 0;
        for (const block of blocks) {
            if (!Number.isSafeInteger(block.index) || block.index < 0 || !Number.isSafeInteger(block.candidateIndex) || block.candidateIndex < 0) {
                throw new AgentFault('MEDIA_OWNER_INVALID', '媒体块位置无效');
            }
            const position = `${block.candidateIndex}:${block.index}`;
            if (positions.has(position)) throw new AgentFault('MEDIA_OWNER_INVALID', '同一响应存在重复媒体块位置');
            positions.add(position);
            const mime = normalizeMime(block.mime);
            const owner = { conversationId, runId, runEpoch, attemptId: response.attemptId,
                candidateIndex: block.candidateIndex, blockIndex: block.index, retention: { ...retention } };
            const artifact: MediaArtifact = { ...owner, schemaVersion: 1, artifactId: mediaArtifactId(owner), type: block.type,
                state: 'remote_pending', storage: 'remote', mime, mimeVerification: 'remote_pending', sha256: null, byteLength: null, path: null,
                absolutePath: null, uri: block.uri ?? null, nativeRef: block.nativeRef,
                createdAt: (this.options.now?.() ?? new Date()).toISOString() };
            if (block.dataBase64 !== undefined) {
                const info = inspectBase64(block.dataBase64, this.limits.maxBlockBytes);
                const mimeVerification = validateMediaBytes(block.type, mime, info);
                if (block.byteLength !== undefined && block.byteLength !== info.byteLength) throw new AgentFault('MEDIA_LENGTH_MISMATCH', '媒体声明长度与原字节不一致');
                if (block.sha256 !== undefined && block.sha256 !== info.sha256) throw new AgentFault('MEDIA_HASH_MISMATCH', '媒体声明SHA256与原字节不一致');
                totalBytes += info.byteLength;
                if (totalBytes > this.limits.maxResponseBytes) throw new AgentFault('MEDIA_CONTENT_LIMIT', '单次响应媒体总字节超过上限');
                Object.assign(artifact, { state: 'ready', storage: retention.mode === 'temporary' ? 'memory' : 'objects',
                    sha256: info.sha256, byteLength: info.byteLength, mimeVerification });
                prepared.push({ artifact, dataBase64: block.dataBase64 });
            } else {
                if (!block.uri) throw new AgentFault('MEDIA_PAYLOAD_MISSING', '媒体块缺少原件字节与远端URI');
                validateRemoteUri(block.uri);
                prepared.push({ artifact });
            }
        }
        const result: JsonValue[] = [];
        for (const input of prepared) {
            if (context.signal.aborted) throw new AgentFault('E_CANCELLED', '媒体发布已取消，已提交原件仍保留');
            const artifact = retention.mode === 'temporary' ? this.publishTemporary(input.artifact, input.dataBase64)
                : await this.options.durable!.publish(input);
            result.push(mediaArtifactValue(artifact));
        }
        return result;
    }

    async get(conversationId: string, artifactId: string): Promise<MediaArtifact | undefined> {
        const policy = await this.options.retention(conversationId);
        if (policy.mode !== 'temporary') {
            if (!this.options.durable) throw new AgentFault('MEDIA_PERSISTENCE_UNAVAILABLE', '持久媒体端口尚未接入');
            return this.options.durable.get(conversationId, artifactId);
        }
        const artifact = this.temporary.get(conversationId)?.artifacts.get(artifactId);
        return artifact ? structuredClone(artifact) : undefined;
    }

    async read(query: MediaArtifactQuery): Promise<MediaArtifactChunk> {
        const policy = await this.options.retention(query.conversationId);
        if (policy.mode !== 'temporary') {
            if (!this.options.durable) throw new AgentFault('MEDIA_PERSISTENCE_UNAVAILABLE', '持久媒体端口尚未接入');
            return this.options.durable.read(query);
        }
        const { offset, maxBytes } = requireMediaSlice(query.offset, query.maxBytes);
        const state = this.temporary.get(query.conversationId);
        const artifact = state?.artifacts.get(query.artifactId);
        if (!artifact) throw new AgentFault('MEDIA_NOT_FOUND', '当前会话没有这份媒体原件');
        if (artifact.state === 'remote_pending') throw new AgentFault('MEDIA_REMOTE_PENDING', '远端媒体尚未取回原件', { uri: artifact.uri });
        const bytes = state!.payloads.get(artifact.sha256!);
        if (!bytes) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '临时媒体原件已缺失');
        if (offset > bytes.length) throw new AgentFault('INVALID_PARAMS', '媒体偏移超过原件长度');
        const end = Math.min(bytes.length, offset + maxBytes);
        return { artifactId: artifact.artifactId, mime: artifact.mime, sha256: artifact.sha256!, totalBytes: bytes.length,
            offset, dataBase64: bytes.subarray(offset, end).toString('base64'), nextOffset: end < bytes.length ? end : null, complete: end === bytes.length };
    }

    async list(query: { conversationId: string; cursor?: string; limit?: number; maxBytes?: number }): Promise<MediaArtifactPage> {
        const policy = await this.options.retention(query.conversationId);
        if (policy.mode !== 'temporary') {
            if (!this.options.durable) throw new AgentFault('MEDIA_PERSISTENCE_UNAVAILABLE', '持久媒体端口尚未接入');
            return this.options.durable.list(query);
        }
        const limit = query.limit ?? 50;
        const maxBytes = query.maxBytes ?? 256 * 1024;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024) {
            throw new AgentFault('INVALID_PARAMS', '媒体列表分页参数无效');
        }
        const all = [...(this.temporary.get(query.conversationId)?.artifacts.values() ?? [])].sort((left, right) => left.artifactId.localeCompare(right.artifactId));
        const items: MediaArtifact[] = [];
        let bytes = 0;
        let hasMore = false;
        for (const artifact of all) {
            if (query.cursor && artifact.artifactId <= query.cursor) continue;
            const size = Buffer.byteLength(canonicalJson(artifact));
            if (items.length >= limit || bytes + size > maxBytes) { hasMore = true; break; }
            items.push(structuredClone(artifact));
            bytes += size;
        }
        if (hasMore && !items.length) throw new AgentFault('MEDIA_PAGE_LIMIT', '媒体页预算无法容纳一条元数据');
        return { items, nextCursor: hasMore ? items.at(-1)!.artifactId : null, hasMore };
    }

    async onConversationClosed(conversation: { conversationId: string; retention: RetainPolicy }): Promise<void> {
        if (conversation.retention.mode !== 'temporary') return;
        this.lifecycleStages.get(conversation.conversationId)?.();
        this.closedTemporary.add(conversation.conversationId);
        const state = this.temporary.get(conversation.conversationId);
        if (state) this.temporaryBudget.release(conversation.conversationId, state.bytes);
        if (state) for (const payload of state.payloads.values()) payload.fill(0);
        this.temporary.delete(conversation.conversationId);
    }

    temporaryUsage(conversationId: string): { bytes: number; artifacts: number; payloads: number } {
        const state = this.temporary.get(conversationId);
        return { bytes: state?.bytes ?? 0, artifacts: state?.artifacts.size ?? 0, payloads: state?.payloads.size ?? 0 };
    }

    async freezeConversationLifecycle(conversationId: string): Promise<() => void> {
        if (this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        this.lifecycleFrozenIds.add(conversationId);
        await Promise.allSettled([...(this.publications.get(conversationId) ?? [])]);
        return () => this.lifecycleFrozenIds.delete(conversationId);
    }

    captureConversationLifecycle(conversationId: string): LifecycleCapture<LifecycleMediaSnapshot> {
        if (!this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        const state = this.temporary.get(conversationId);
        const bytes = (state?.bytes ?? 0) * 3;
        this.temporaryBudget.reserve(conversationId, bytes, 'scratch');
        let released = false;
        try {
            const value: LifecycleMediaSnapshot = { schemaVersion: 1, conversationId,
                artifacts: structuredClone([...(state?.artifacts.values() ?? [])]),
                payloads: [...(state?.payloads ?? [])].map(([sha256, payload]) => ({ sha256, byteLength: payload.length, dataBase64: payload.toString('base64') })) };
            return { value, release: () => { if (!released) { released = true; this.temporaryBudget.release(conversationId, bytes, 'scratch'); } } };
        } catch (error) { this.temporaryBudget.release(conversationId, bytes, 'scratch'); throw error; }
    }

    stageConversationLifecycle(snapshot: LifecycleMediaSnapshot): LifecycleStage {
        const conversationId = snapshot.conversationId;
        requireLifecycleSnapshotOwner(snapshot, conversationId);
        if (!this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        if (this.temporary.has(conversationId) || this.lifecycleStages.has(conversationId)) throw new AgentFault('REVISION_CONFLICT', '临时媒体目标已有原件');
        const state: TemporaryMedia = { artifacts: new Map(), payloads: new Map(), bytes: 0 };
        let settled = false;
        const discard = () => {
            if (settled) return;
            settled = true; this.lifecycleStages.delete(conversationId);
            for (const payload of state.payloads.values()) payload.fill(0);
            this.temporaryBudget.release(conversationId, state.bytes);
        };
        try {
            for (const input of snapshot.payloads) {
                const info = inspectBase64(input.dataBase64, this.limits.maxBlockBytes);
                if (info.sha256 !== input.sha256 || info.byteLength !== input.byteLength || state.payloads.has(input.sha256)) throw new AgentFault('MEDIA_HASH_MISMATCH', '媒体迁移原件与原SHA或字节数不同');
                this.temporaryBudget.reserve(conversationId, input.byteLength); state.bytes += input.byteLength;
                state.payloads.set(input.sha256, Buffer.from(input.dataBase64, 'base64'));
            }
            for (const artifact of snapshot.artifacts) {
                if (artifact.conversationId !== conversationId || artifact.retention.mode !== 'temporary' || state.artifacts.has(artifact.artifactId)) throw new AgentFault('MEDIA_OWNER_INVALID', '临时媒体迁移的归属、保存方式或ID不同');
                if (artifact.state === 'ready') {
                    const payload = artifact.sha256 ? state.payloads.get(artifact.sha256) : undefined;
                    if (!payload || payload.length !== artifact.byteLength) throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '媒体快照缺少完整原件');
                    validateMediaBytes(artifact.type, artifact.mime, inspectBase64(snapshot.payloads.find(input => input.sha256 === artifact.sha256)!.dataBase64, this.limits.maxBlockBytes));
                }
                const bytes = measureCanonicalJsonBytes(artifact, { maxBytes: 16 * 1024 });
                this.temporaryBudget.reserve(conversationId, bytes); state.bytes += bytes;
                state.artifacts.set(artifact.artifactId, structuredClone(artifact));
            }
            if (state.bytes > this.limits.maxTemporaryBytes) throw new AgentFault('TEMPORARY_CONTENT_LIMIT', '完整媒体迁移超过原临时媒体上限');
            this.lifecycleStages.set(conversationId, discard);
            return { discard, activate: () => {
                if (settled) return;
                settled = true; this.lifecycleStages.delete(conversationId);
                this.temporary.set(conversationId, state); this.closedTemporary.delete(conversationId);
            } };
        } catch (error) { discard(); throw error; }
    }

    releaseConversationLifecycle(conversationId: string): void {
        if (!this.lifecycleFrozenIds.has(conversationId)) throw lifecycleFrozen(conversationId);
        const state = this.temporary.get(conversationId);
        if (state) {
            for (const payload of state.payloads.values()) payload.fill(0);
            this.temporaryBudget.release(conversationId, state.bytes); this.temporary.delete(conversationId);
        }
        this.closedTemporary.delete(conversationId);
    }

    private publishTemporary(artifact: MediaArtifact, dataBase64?: string): MediaArtifact {
        if (this.closedTemporary.has(artifact.conversationId)) throw new AgentFault('MEDIA_OWNER_STALE', '临时会话已关闭');
        const existingState = this.temporary.get(artifact.conversationId);
        const state = existingState ?? { artifacts: new Map<string, MediaArtifact>(), payloads: new Map<string, Buffer>(), bytes: 0 };
        const metadataBytes = measureCanonicalJsonBytes(artifact, { maxBytes: 16 * 1024 });
        const previous = state.artifacts.get(artifact.artifactId);
        if (previous) {
            if (publicationFingerprint(previous) !== publicationFingerprint(artifact)) throw new AgentFault('MEDIA_PUBLICATION_CONFLICT', '相同媒体位置已有不同原件');
            return structuredClone(previous);
        }
        const payloadBytes = artifact.sha256 && !state.payloads.has(artifact.sha256) ? artifact.byteLength! : 0;
        if (state.bytes + metadataBytes + payloadBytes > this.limits.maxTemporaryBytes) {
            throw new AgentFault('TEMPORARY_CONTENT_LIMIT', '临时媒体达到当前会话内存上限');
        }
        const allocatedBytes = metadataBytes + payloadBytes;
        this.temporaryBudget.reserve(artifact.conversationId, allocatedBytes);
        let payload: Buffer | undefined;
        try {
            const stored = structuredClone(artifact);
            if (payloadBytes > 0 || (artifact.sha256 && !state.payloads.has(artifact.sha256))) {
                payload = Buffer.allocUnsafe(artifact.byteLength!);
                let offset = 0;
                for (const chunk of base64Chunks(dataBase64!)) { payload.set(chunk, offset); offset += chunk.byteLength; }
                state.payloads.set(artifact.sha256!, payload);
            }
            state.artifacts.set(artifact.artifactId, stored);
            if (!existingState) this.temporary.set(artifact.conversationId, state);
            state.bytes += allocatedBytes;
        } catch (error) {
            if (payload) { payload.fill(0); state.payloads.delete(artifact.sha256!); }
            state.artifacts.delete(artifact.artifactId);
            if (!existingState) this.temporary.delete(artifact.conversationId);
            this.temporaryBudget.release(artifact.conversationId, allocatedBytes);
            throw error;
        }
        return structuredClone(artifact);
    }
}
