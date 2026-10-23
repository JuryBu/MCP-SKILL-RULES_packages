import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { codexHistoryPhysicalIdentity, readCodexStreamingSessionMeta, resolveCodexStreamingHistorySource, type CodexHistoryPhysicalIdentity, type CodexStreamingHistorySegment } from "./codex-history-source.js";
import { CodexHistorySourceMismatchError, throwIfCodexReadCancelled } from "./codex-history-integrity.js";
import type { CodexHistoryArchiveOptions } from "./codex-history-archive.js";
import type { CorpusConversation, CorpusMessageRole, CorpusProjection, CorpusReadControl } from "./conversation-corpus-types.js";

export interface CodexRoleProofOptions {
    roots: string[];
    pathsByRolloutId?: Map<string, string[]>;
    archive?: CodexHistoryArchiveOptions;
}

export interface CodexRoleProofSegment extends CodexStreamingHistorySegment {
    metadataSha256: string;
    replicaIdentities: Array<{ path: string; physical: CodexHistoryPhysicalIdentity; metadataSha256: string }>;
}

export interface CodexRoleExcludedProjection extends CorpusProjection {
    projectionKind: "requested-role-exclusion";
    sourceIdentities: Array<{ path: string; identity: string }>;
    roleExclusion: {
        version: "codex-role-exclusion/v1";
        requestedRoles: CorpusMessageRole[];
        sourceContentValidated: false;
        adoptedBoundaries: "declared-metadata";
        fullBodyCachePrepared: false;
        segments: CodexRoleProofSegment[];
    };
}

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
}

const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

function isExplicitSubagent(metadata: Record<string, unknown>): boolean {
    let source = metadata.source;
    if (typeof source === "string") {
        if (source === "subagent") return true;
        try { source = JSON.parse(source); } catch { return false; }
    }
    if (source === "subagent") return true;
    if (!source || typeof source !== "object" || Array.isArray(source) || !Object.hasOwn(source, "subagent")) return false;
    const subagent = (source as Record<string, unknown>).subagent;
    return subagent === true || (typeof subagent === "string" && subagent.length > 0)
        || (!!subagent && typeof subagent === "object" && !Array.isArray(subagent));
}

export async function readRoleExcludedCodexProjection(
    conversation: CorpusConversation,
    control: CorpusReadControl,
    options: CodexRoleProofOptions,
): Promise<CodexRoleExcludedProjection | null> {
    const isCancelled = () => !!(control.isCancelled?.() || options.archive?.isCancelled?.());
    const checkCancelled = () => throwIfCodexReadCancelled(isCancelled);
    checkCancelled();
    const roles = [...new Set(control.messageRoles ?? ["user", "assistant"])].sort() as CorpusMessageRole[];
    if (!roles.length || roles.some(role => role !== "user" && role !== "assistant") || conversation.source !== "codex" || !conversation.rolloutPath) return null;
    const archive = { ...options.archive, isCancelled };
    const resolve = () => resolveCodexStreamingHistorySource(conversation.rolloutPath!, {
        roots: options.roots, pathsByRolloutId: options.pathsByRolloutId, archive, isCancelled,
    });
    const source = await resolve();
    checkCancelled();
    const leaf = source.segments.at(-1);
    if (!leaf || leaf.threadId.toLowerCase() !== conversation.id.toLowerCase()) throw new CodexHistorySourceMismatchError("Codex role-proof conversation identity mismatch");
    const sourceSnapshot = canonical(source);
    const segments: CodexRoleProofSegment[] = [];
    const sourceIdentities: CodexRoleExcludedProjection["sourceIdentities"] = [];
    const physicalIdentity = async (filePath: string): Promise<CodexHistoryPhysicalIdentity> => {
        checkCancelled();
        try { return codexHistoryPhysicalIdentity(await fs.stat(filePath)); }
        catch (error) {
            checkCancelled();
            if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new CodexHistorySourceMismatchError("Codex role-proof source disappeared");
            throw error;
        }
    };
    let eligible = true;
    for (const segment of source.segments) {
        checkCancelled();
        if (segment.endOrdinalExclusive !== undefined && segment.endOrdinalExclusive < segment.startOrdinal) throw new CodexHistorySourceMismatchError("Codex role-proof adopted ordinal bounds are reversed");
        if (segment.endByte !== undefined && !/\.zst$/iu.test(segment.path) && segment.endByte > segment.physical.size) throw new CodexHistorySourceMismatchError("Codex role-proof adopted byte bounds exceed the source");
        const before = await physicalIdentity(segment.path);
        if (canonical(before) !== canonical(segment.physical)) throw new CodexHistorySourceMismatchError("Codex role-proof source changed after discovery");
        const metadata = await readCodexStreamingSessionMeta(segment.path, archive);
        checkCancelled();
        const metadataSha256 = digest(metadata);
        eligible &&= isExplicitSubagent(metadata);
        const replicas: CodexRoleProofSegment["replicaIdentities"] = [];
        for (const replicaPath of segment.replicas) {
            const replicaBefore = await physicalIdentity(replicaPath);
            const replicaMetadata = await readCodexStreamingSessionMeta(replicaPath, archive);
            checkCancelled();
            if (digest(replicaMetadata) !== metadataSha256) throw new CodexHistorySourceMismatchError("Conflicting Codex role-proof replica metadata");
            if (canonical(await physicalIdentity(replicaPath)) !== canonical(replicaBefore)) throw new CodexHistorySourceMismatchError("Codex role-proof replica changed while reading metadata");
            eligible &&= isExplicitSubagent(replicaMetadata);
            replicas.push({ path: replicaPath, physical: replicaBefore, metadataSha256 });
            sourceIdentities.push({ path: replicaPath, identity: canonical(replicaBefore) });
        }
        if (canonical(await physicalIdentity(segment.path)) !== canonical(before)) throw new CodexHistorySourceMismatchError("Codex role-proof source changed while reading metadata");
        sourceIdentities.push({ path: segment.path, identity: canonical(before) });
        segments.push({ ...segment, replicas: [...segment.replicas], physical: { ...before }, metadataSha256, replicaIdentities: replicas });
        control.onProgress?.({ phase: "role-proof-headers" });
        checkCancelled();
    }
    if (canonical(await resolve()) !== sourceSnapshot) throw new CodexHistorySourceMismatchError("Codex role-proof source chain changed while proving roles");
    for (const identity of sourceIdentities) {
        if (canonical(await physicalIdentity(identity.path)) !== identity.identity) throw new CodexHistorySourceMismatchError("Codex role-proof source changed before completion");
    }
    checkCancelled();
    if (!eligible) return null;
    sourceIdentities.sort((left, right) => left.path.localeCompare(right.path));
    const roleExclusion: CodexRoleExcludedProjection["roleExclusion"] = {
        version: "codex-role-exclusion/v1", requestedRoles: roles, sourceContentValidated: false,
        adoptedBoundaries: "declared-metadata", fullBodyCachePrepared: false, segments,
    };
    return {
        conversation, revision: `role-excluded:${digest({ conversationId: conversation.id, roleExclusion, sourceIdentities })}`,
        projectionKind: "requested-role-exclusion", roleExclusion, sourceIdentities,
        messages: [], complete: true,
        warnings: ["requested_roles_excluded_by_all_source_headers", "source_content_not_validated", "adopted_boundaries_metadata_only", "full_body_cache_not_prepared", "metadata_read_bytes_not_counted", ...(segments.some(segment => segment.replicas.length) ? ["replica_bodies_not_compared"] : [])],
    };
}
