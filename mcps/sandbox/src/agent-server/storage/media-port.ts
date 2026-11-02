import { AgentFault } from '../protocol.js';
import type { MediaArtifact, MediaArtifactChunk, MediaArtifactPage, MediaArtifactQuery, MediaPersistencePort, MediaPublishInput } from '../media/types.js';

export type MediaCommand = { type: 'publish'; input: MediaPublishInput };
export type MediaQuery = { type: 'get'; conversationId: string; artifactId: string }
    | { type: 'read'; query: MediaArtifactQuery }
    | { type: 'list'; conversationId: string; cursor?: string; limit?: number; maxBytes?: number };
export type MediaResult = { kind: 'artifact'; artifact: MediaArtifact | null }
    | { kind: 'chunk'; chunk: MediaArtifactChunk }
    | { kind: 'page'; page: MediaArtifactPage };

export interface MediaRpcStore {
    executeMedia(command: MediaCommand): Promise<MediaResult>;
    queryMedia(query: MediaQuery): Promise<MediaResult>;
}

export class SqliteMediaPort implements MediaPersistencePort {
    readonly persistence = 'durable' as const;

    constructor(readonly store: MediaRpcStore) {
        if (typeof store.executeMedia !== 'function' || typeof store.queryMedia !== 'function') {
            throw new AgentFault('MEDIA_PERSISTENCE_UNAVAILABLE', '存储尚未接入媒体事务端口');
        }
    }

    async publish(input: MediaPublishInput): Promise<MediaArtifact> {
        const result = await this.store.executeMedia({ type: 'publish', input });
        if (result.kind !== 'artifact' || !result.artifact) throw new AgentFault('STORAGE_RESPONSE_INVALID', '媒体发布回执无效');
        return result.artifact;
    }

    async get(conversationId: string, artifactId: string): Promise<MediaArtifact | undefined> {
        const result = await this.store.queryMedia({ type: 'get', conversationId, artifactId });
        if (result.kind !== 'artifact') throw new AgentFault('STORAGE_RESPONSE_INVALID', '媒体读取回执无效');
        return result.artifact ?? undefined;
    }

    async read(query: MediaArtifactQuery): Promise<MediaArtifactChunk> {
        const result = await this.store.queryMedia({ type: 'read', query });
        if (result.kind !== 'chunk') throw new AgentFault('STORAGE_RESPONSE_INVALID', '媒体分片回执无效');
        return result.chunk;
    }

    async list(query: { conversationId: string; cursor?: string; limit?: number; maxBytes?: number }): Promise<MediaArtifactPage> {
        const result = await this.store.queryMedia({ type: 'list', ...query });
        if (result.kind !== 'page') throw new AgentFault('STORAGE_RESPONSE_INVALID', '媒体列表回执无效');
        return result.page;
    }
}

export function createSqliteMediaPort(store: MediaRpcStore): SqliteMediaPort { return new SqliteMediaPort(store); }
