import { listConversationSourceCacheSnapshots, type ConversationSourceCacheKey } from "./conversation-source-cache.js";
import { resolveCachedDevinIdentity } from "./devin-identity.js";
import type { ConversationSource, ListConversationCandidatesOptions, UnifiedConversationCandidate } from "./conversation-filter.js";

export function listCachedContextCandidates(source: ConversationSource, limit: number, options: ListConversationCandidatesOptions) {
    const variants = source === "codex" ? [":link=summary", ":link=reference", ":link=expand_children"]
        : source === "claude-code" ? [":logical=off", ":logical=auto", ":logical=strict", ":logical=explain"]
        : source === "windsurf" ? ["", ":link=reference", ":link=expand_children"] : [""];
    const requested = options.conversationIds?.map(id => source === "windsurf" ? resolveCachedDevinIdentity(id) : id);
    const keys = requested?.flatMap(conversationId => variants.map(variant => ({ source: `${source}${variant}`, conversationId })));
    const listed = listConversationSourceCacheSnapshots<Record<string, any>>({
        source, keys, limit: limit * variants.length, maxBytes: options.maxBytes,
        deadlineAt: Date.now() + (options.deadlineMs || 12_000), isCancelled: options.isCancelled,
    });
    const candidates = new Map<string, UnifiedConversationCandidate>();
    listed.entries.sort((left, right) => variants.indexOf(left.key.source.slice(source.length)) - variants.indexOf(right.key.source.slice(source.length)));
    for (const entry of listed.entries) {
        if (candidates.has(entry.key.conversationId)) continue;
        const snapshot = entry.snapshot;
        const thread = snapshot.windsurfData?.thread || snapshot.codexData?.thread || snapshot.claudeCodeData?.thread || snapshot.dshData?.header || snapshot.dshData?.snapshot?.header || {};
        const id = entry.key.conversationId;
        const aliases = [...new Set([id, ...(thread.aliases || []), ...(options.conversationIds || []).filter((_, index) => requested?.[index] === id)])];
        const partial = Boolean(snapshot.windsurfData?.partial || thread.partial || snapshot.cacheState === "stale" || entry.key.source.includes(":link=reference"));
        if (entry.key.source.includes(":link=reference")) listed.warnings.push(`cache_link_reference_only:${id}`);
        candidates.set(id, {
            id, dataChain: source, aliases, uuid: thread.uuid, sessionId: thread.sessionId,
            sourceKind: thread.sourceKind, sourcePartial: partial,
            title: thread.title || snapshot.title || id, workspace: thread.cwd || "", workspaces: thread.workspaceUris,
            updatedAt: thread.updatedAt || thread.lastModifiedTime || entry.createdAt, detail: `verified_cache:${entry.key.source}`,
            parentConversationId: thread.parentConversationId, isChildThread: Boolean(thread.isChildThread || thread.parentConversationId),
            cacheKey: entry.key as ConversationSourceCacheKey, cacheGeneration: entry.generation,
        });
    }
    if (requested?.some(id => !candidates.has(id))) listed.warnings.push("requested_cache_missing");
    if (options.workspaces?.length && [...candidates.values()].some(candidate => !candidate.workspace && !candidate.workspaces?.length)) listed.warnings.push("cache_workspace_unknown: raw source was not probed");
    return { candidates: [...candidates.values()].slice(0, limit), warnings: listed.warnings, partial: listed.partial || candidates.size > limit || listed.warnings.length > 0 };
}
