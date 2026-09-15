import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { DevinRawConversation, DevinReadOptions } from "./devin-types.js";
import type { ConversationRound } from "./trajectory.js";
import { projectConversationRoundForRecord } from "./conversation-record-projection.js";
import {
    SOURCE_EVIDENCE_ADAPTER_VERSION,
    buildExactFetchEvidence,
    buildFullSourceReadEvidence,
    buildSourceEnumerationEvidence,
    canonicalSerialize,
    classifySourceEvidence,
    type ExactFetchEvidence,
    type FullSourceReadEvidence,
    type SourceConversationIdentity,
    type SourceEnumerationEvidence,
    type SourceEvidenceClassification,
    type SourceEvidenceIssue,
} from "./source-evidence-contracts.js";
import { scanWindsurfSourceEvidence, withLegacyWindsurfFallback, type WindsurfSourceEvidenceScanOptions } from "./windsurf-client.js";

export type DevinEvidenceReader = (
    conversationId: string,
    options?: DevinReadOptions,
) => Promise<{ raw: DevinRawConversation; rounds: ConversationRound[] } | null>;

export interface DevinSourceEvidenceScanResult {
    scanId: string;
    cacheBypassed: true;
    identity: SourceConversationIdentity;
    enumeration: SourceEnumerationEvidence;
    exactFetch: ExactFetchEvidence;
    classification: SourceEvidenceClassification;
    fullSourceRead?: FullSourceReadEvidence;
    readResult?: { rounds: ConversationRound[]; partial: boolean };
}

export interface DevinSourceEvidenceOptions extends WindsurfSourceEvidenceScanOptions {
    readDevin?: DevinEvidenceReader;
    maxBytes?: number;
}

const defaultDevinReader: DevinEvidenceReader = async (conversationId, options) => {
    const { readDevinConversation } = await import("./devin-conversation.js");
    return withLegacyWindsurfFallback(conversationId, () => readDevinConversation(conversationId, options));
};

export function assertConversationConsumerSourceComplete(snapshot: unknown): void {
    if (!snapshot || typeof snapshot !== "object") throw new Error("Conversation source snapshot is unavailable");
    const source = snapshot as Record<string, any>;
    const parts = [source, source.windsurfData, source.devinData, source.devinData?.raw];
    if (source.cacheState === "stale" || parts.some(part => part?.partial === true || part?.summary?.partial === true)) {
        throw new Error("Record/Guard refuses a stale or partial conversation source snapshot");
    }
}

export async function scanDevinSourceEvidence(
    conversationId: string,
    options: DevinSourceEvidenceOptions = {},
): Promise<DevinSourceEvidenceScanResult | null> {
    const requestedId = conversationId.trim();
    if (!requestedId) throw new Error("Devin source evidence requires a conversation ID");
    const now = options.now || (() => new Date());
    const scanId = options.scanId || randomUUID();
    const startedAt = now().toISOString();
    const sequence = Math.max(1, Math.floor(options.sequence || 1));
    const issues: SourceEvidenceIssue[] = [];
    let loaded: Awaited<ReturnType<DevinEvidenceReader>> = null;
    try {
        loaded = await (options.readDevin || defaultDevinReader)(requestedId, {
            ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
        });
        if (!loaded) return null;
    } catch (error) {
        issues.push({ code: "source_unavailable", message: `Devin source read failed: ${error instanceof Error ? error.message : String(error)}` });
    }
    const raw = loaded?.raw;
    const summary = raw?.summary;
    const canonicalId = summary?.canonicalId || requestedId;
    if (raw && (raw.partial || summary?.partial || raw.compactions.some(compaction => !compaction.restored))) {
        issues.push({ code: "pagination_incomplete", message: "Devin source is partial or contains unrecovered compaction history" });
    }
    if (summary && ![summary.canonicalId, summary.id, summary.uuid, summary.sessionId, ...summary.aliases].includes(requestedId)) {
        issues.push({ code: "parse_error", message: "Devin source identity does not match the requested conversation alias" });
    }
    if (loaded && (!summary?.canonicalId || !summary.sourcePath || !raw?.fingerprint.revision)) {
        issues.push({ code: "parse_error", message: "Devin source lacks canonical identity, source path, or a verified revision" });
    }
    if (loaded && loaded.rounds.length === 0) {
        issues.push({ code: "parse_error", message: "Devin source contains no normalized conversation rounds" });
    }
    const complete = loaded !== null && issues.length === 0;
    const sourcePath = summary?.sourcePath || options.sourceCanonicalPath || null;
    const identity: SourceConversationIdentity = {
        conversationId: canonicalId,
        workspace: {
            workspaceId: options.workspaceId || "general",
            canonicalPath: summary?.cwd || options.workspacePath || null,
        },
        source: {
            kind: "database",
            authority: `windsurf-${summary?.sourceKind || "devin-unresolved"}`,
            authoritativeRoot: sourcePath ? path.dirname(sourcePath) : "devin-unresolved",
            canonicalPath: sourcePath,
        },
    };
    const sourceRevision = {
        revision: raw?.fingerprint.revision || `devin-unresolved:${scanId}`,
        contentCursor: summary?.mainChainId !== undefined ? String(summary.mainChainId) : null,
        eventWatermark: raw?.fingerprint.revision || null,
        sequence: null,
    };
    const common = {
        adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: "windsurf" as const,
        identity,
        sourceRevision,
        pagination: { cursor: null, pages: loaded ? 1 : 0, limit: null, truncated: !complete },
        enumerationComplete: complete,
        cacheBypassed: true,
        exactFetchResult: complete ? "present" as const : "unresolved" as const,
        errors: issues,
        warnings: [],
    };
    const completedAt = now().toISOString();
    const enumeration = buildSourceEnumerationEvidence({
        ...common,
        targetStatus: loaded ? "present" : "unknown",
        observedAt: { scanId, sequence, startedAt, completedAt },
    });
    const exactFetch = buildExactFetchEvidence({
        ...common,
        observedAt: { scanId, sequence: sequence + 1, startedAt, completedAt },
    });
    let fullSourceRead: FullSourceReadEvidence | undefined;
    if (complete && loaded) {
        const serialized = canonicalSerialize(loaded.rounds.map(projectConversationRoundForRecord));
        fullSourceRead = buildFullSourceReadEvidence({
            ...common,
            observedAt: { scanId, sequence: sequence + 2, startedAt, completedAt },
            content: {
                mode: "full",
                byteLength: Buffer.byteLength(serialized, "utf8"),
                contentHash: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
                roundRange: { start: 1, end: loaded.rounds.length },
                truncated: false,
                staleCache: false,
            },
        });
    }
    return {
        scanId,
        cacheBypassed: true,
        identity,
        enumeration,
        exactFetch,
        classification: classifySourceEvidence({ enumeration, exactFetch }),
        ...(fullSourceRead ? { fullSourceRead } : {}),
        ...(loaded ? { readResult: { rounds: loaded.rounds, partial: !complete } } : {}),
    };
}

export async function scanWindsurfConsumerSourceEvidence(
    conversationId: string,
    options: DevinSourceEvidenceOptions = {},
) {
    const devin = await scanDevinSourceEvidence(conversationId, options);
    return devin || scanWindsurfSourceEvidence(conversationId, options);
}
