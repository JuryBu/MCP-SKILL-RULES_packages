import type { RetainPolicy } from '../protocol.js';
import type { ModelEntry } from '../models/catalog.js';
import type { ProviderProfile } from '../providers/types.js';

export interface ToolImageOwner {
    conversationId: string;
    runId: string;
    rootRunId: string;
    runEpoch: number;
    actionId: string;
    stepId: string;
    attemptId: string;
    callId: string;
    toolName: string;
    principalId: string;
}

export interface InputAttachmentReference {
    schemaVersion: 1;
    referenceId: string;
    kind: 'attachment' | 'conversation';
    sourceHost: 'agent-server';
    sourceId: string;
    revision: 1;
    sha256: string;
    byteLength: number;
    mediaType: string;
    attachmentType: 'image' | 'text' | 'conversation';
    prepareState: 'ready';
    label: string;
    range?: string;
    sourceVersion?: { historyEpoch: number; appendSeq: number; viewRevision: number };
    nativeSource?: { conversationId: string; runId: string; attemptId: string; nativeRef: string; snapshotConversationId?: string; contentId?: string; sha256?: string; byteLength?: number };
    toolSource?: ToolImageOwner & { blockIndex: number };
}

export interface InputAttachmentChunk {
    contentId: string;
    offset: number;
    byteLength: number;
    sha256: string;
}

export interface InputAttachmentManifest {
    schemaVersion: 1;
    kind: 'input_attachment';
    conversationId: string;
    reference: InputAttachmentReference;
    retention: RetainPolicy;
    state: 'preparing' | 'ready';
    operationHash: string;
    source: { path: string; byteLength: number; mtimeMs: number; ctimeMs: number }
        | { kind: 'tool_image'; owner: ToolImageOwner; blockIndex: number }
        | { kind: 'inline'; sourceId: string; byteLength: number; sha256: string };
    chunks: InputAttachmentChunk[];
    createdAt: string;
    origin?: { conversationId: string; referenceId: string; sha256: string };
    nativeOrigin?: { contentId: string; sha256: string; byteLength: number; protocol: string; modelId: string | null };
}

export interface ConversationSourceItem {
    contentId: string;
    sourceContentId: string;
    objectHash: string;
    byteLength: number;
    itemId: string | null;
    roundId: string | null;
    seq: number | null;
    role: string;
    providerProtocol: string | null;
}

export interface ConversationSourceManifest {
    schemaVersion: 1;
    sourceHost: 'agent-server';
    sourceId: string;
    version: { historyEpoch: number; appendSeq: number; viewRevision: number };
    range: string | null;
    totalSourceBytes: number;
    items: ConversationSourceItem[];
}

export interface InputConversationManifest {
    schemaVersion: 1;
    kind: 'input_conversation';
    conversationId: string;
    reference: InputAttachmentReference;
    retention: RetainPolicy;
    state: 'preparing' | 'ready';
    operationHash: string;
    sourceManifest: ConversationSourceManifest;
    copiedContentIds: string[];
    createdAt: string;
}

export type PreparedInputManifest = InputAttachmentManifest | InputConversationManifest;

export interface PrepareInputAttachment {
    conversationId: string;
    clientCommandId: string;
    kind: 'file' | 'attachment' | 'conversation';
    source: string;
    mime?: string;
    range?: string;
    expectedSha256?: string;
    sourceHost?: string;
    contentIds?: string[];
    expectedHistoryEpoch?: number;
    expectedViewRevision?: number;
    throughSeq?: number;
}

export interface InputAttachmentCaller { principalId: string; clientId: string; signal?: AbortSignal }
export interface PrepareInlineInputAttachment {
    conversationId: string;
    clientCommandId: string;
    sourceId: string;
    mime: string;
    expectedSha256: string;
    bytes: Uint8Array;
    label?: string;
}
export interface InputReferenceSourceGrant {
    readerConversationId: string;
    sources: readonly { conversationId: string; references: readonly { referenceId: string; sha256: string }[] }[];
}
export interface AttachmentModelSelection { profile: ProviderProfile; entry: ModelEntry; selectionSource?: InputReferenceSourceGrant }
export interface InputAttachmentLimits {
    chunkBytes: number;
    maxSourceBytes: number;
    maxTextBytes: number;
    maxViewBytes: number;
    maxReferences: number;
    maxConversationItems: number;
    maxContentBytes: number;
}

export const DEFAULT_INPUT_ATTACHMENT_LIMITS: Readonly<InputAttachmentLimits> = Object.freeze({
    chunkBytes: 192 * 1024, maxSourceBytes: 32 * 1024 * 1024, maxTextBytes: 4 * 1024 * 1024,
    maxViewBytes: 16 * 1024 * 1024, maxReferences: 32, maxConversationItems: 64, maxContentBytes: 4 * 1024 * 1024,
});
