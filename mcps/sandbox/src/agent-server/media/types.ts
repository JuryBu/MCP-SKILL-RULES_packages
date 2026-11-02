import type { JsonValue, RetainPolicy } from '../protocol.js';

export interface MediaOwner {
    conversationId: string;
    runId: string;
    runEpoch: number;
    attemptId: string;
    candidateIndex: number;
    blockIndex: number;
    retention: RetainPolicy;
}

export interface BinaryPayloadRef {
    sha256: string;
    byteLength: number;
    mime: string;
    path: string;
}

export interface PreparedBinaryPayload extends BinaryPayloadRef {
    created: boolean;
}

export interface BinaryPayloadStore {
    prepare(chunks: Iterable<Uint8Array>, expected: Omit<BinaryPayloadRef, 'path'>): PreparedBinaryPayload;
    chunks(reference: BinaryPayloadRef, chunkBytes?: number): Iterable<Uint8Array>;
    absolutePath?(reference: BinaryPayloadRef): string;
}

export interface MediaArtifact extends MediaOwner {
    schemaVersion: 1;
    artifactId: string;
    type: 'image' | 'audio' | 'video' | 'file';
    state: 'ready' | 'remote_pending';
    storage: 'memory' | 'objects' | 'remote';
    mime: string;
    mimeVerification: 'signature' | 'declared' | 'remote_pending';
    sha256: string | null;
    byteLength: number | null;
    path: string | null;
    absolutePath: string | null;
    uri: string | null;
    nativeRef: string;
    createdAt: string;
}

export interface MediaPublishInput {
    artifact: MediaArtifact;
    dataBase64?: string;
}

export interface MediaArtifactQuery {
    conversationId: string;
    artifactId: string;
    offset?: number;
    maxBytes?: number;
}

export interface MediaArtifactChunk {
    artifactId: string;
    mime: string;
    offset: number;
    totalBytes: number;
    sha256: string;
    dataBase64: string;
    nextOffset: number | null;
    complete: boolean;
}

export interface MediaArtifactPage {
    items: MediaArtifact[];
    nextCursor: string | null;
    hasMore: boolean;
}

export interface MediaPersistencePort {
    readonly persistence: 'durable';
    publish(input: MediaPublishInput): Promise<MediaArtifact>;
    get(conversationId: string, artifactId: string): Promise<MediaArtifact | undefined>;
    read(query: MediaArtifactQuery): Promise<MediaArtifactChunk>;
    list(query: { conversationId: string; cursor?: string; limit?: number; maxBytes?: number }): Promise<MediaArtifactPage>;
}

export interface MediaLimits {
    maxBlockBytes: number;
    maxResponseBytes: number;
    maxBlocks: number;
    maxTemporaryBytes: number;
}

export const DEFAULT_MEDIA_LIMITS: Readonly<MediaLimits> = Object.freeze({
    maxBlockBytes: 32 * 1024 * 1024,
    maxResponseBytes: 64 * 1024 * 1024,
    maxBlocks: 256,
    maxTemporaryBytes: 64 * 1024 * 1024,
});

export function mediaArtifactValue(artifact: MediaArtifact): JsonValue {
    return { ...artifact, retention: { ...artifact.retention } };
}
