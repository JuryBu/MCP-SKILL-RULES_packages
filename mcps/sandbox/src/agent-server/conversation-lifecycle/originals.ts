import { AgentFault } from '../protocol.js';
import type { JsonValue } from '../protocol.js';
import type { ConversationData } from '../runtime.js';
import type { StorePort } from '../storage/port.js';
import { lifecycleSnapshotHash } from './migration-snapshots.js';

export async function readLifecycleNativeOrigin(store: Pick<StorePort, 'getRecord' | 'readContent'>,
    source: { conversationId: string; runId: string; attemptId: string; nativeRef: string }): Promise<{
        value: JsonValue; protocol: string; modelId: string | null;
    } | undefined> {
    const owner = await store.getRecord<ConversationData>({ conversationId: source.conversationId, kind: 'conversation', id: source.conversationId });
    const declared = owner?.value.options.branchSource as { conversationId?: string; manifestHash?: string } | undefined;
    if (!owner || !declared?.conversationId) return undefined;
    const manifest = await store.readContent(source.conversationId, `lifecycle:source:${source.conversationId}`) as {
        sourceConversationId?: string; sourceHash?: string;
        provenance?: { originals?: { artifactId: string; attemptId: string; slot: string; objectHash: string; sourceConversationId?: string }[] };
    } | undefined;
    if (!manifest || manifest.sourceConversationId !== declared.conversationId || manifest.sourceHash !== declared.manifestHash) {
        throw new AgentFault('STORAGE_SEGMENT_CORRUPT', '分支原生来源与冻结清单不一致');
    }
    const originals = manifest.provenance?.originals ?? [];
    const attemptRef = originals.find(original => original.attemptId === source.attemptId && original.slot === 'attempt');
    const responseRef = originals.find(original => original.attemptId === source.attemptId && original.slot === 'response');
    if (!attemptRef || !responseRef) return undefined;
    const attempt = await store.readContent(source.conversationId, attemptRef.artifactId) as {
        attemptId?: string; snapshot?: { conversationId?: string; runId?: string; profile?: { protocol?: string } };
    } | undefined;
    const response = await store.readContent(source.conversationId, responseRef.artifactId) as {
        attemptId?: string; modelId?: string | null; blocks?: { nativeRef?: string }[];
    } | undefined;
    const originalConversationId = attemptRef.sourceConversationId ?? responseRef.sourceConversationId ?? attempt?.snapshot?.conversationId;
    if (!attempt || !response || attempt.attemptId !== source.attemptId || response.attemptId !== source.attemptId
        || typeof originalConversationId !== 'string' || attempt.snapshot?.conversationId !== originalConversationId
        || responseRef.sourceConversationId !== undefined && responseRef.sourceConversationId !== originalConversationId
        || lifecycleSnapshotHash(attempt) !== attemptRef.objectHash || lifecycleSnapshotHash(response) !== responseRef.objectHash
        || attempt.snapshot.runId !== source.runId
        || typeof attempt.snapshot.profile?.protocol !== 'string' || !response.blocks?.some(block => block.nativeRef === source.nativeRef)) {
        throw new AgentFault('E_REFERENCE_CHANGED', '分支原生附件的原执行、尝试或原生块来源不同');
    }
    return { value: response as unknown as JsonValue, protocol: attempt.snapshot.profile.protocol, modelId: response.modelId ?? null };
}
