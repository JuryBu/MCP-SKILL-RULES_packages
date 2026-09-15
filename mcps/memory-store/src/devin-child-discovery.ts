import { readDevinRawConversation } from "./devin-sqlite.js";
import { devinSubagentId, selectDevinSubagents, splitDevinSubagentId } from "./devin-conversation.js";
import type { DevinRawConversation, DevinReadOptions } from "./devin-types.js";
import type { ListConversationCandidatesOptions, UnifiedConversationCandidate } from "./conversation-filter.js";

export async function discoverDevinChildCandidates(parents: UnifiedConversationCandidate[], options: ListConversationCandidatesOptions & {
    readRaw?: (id: string, options: DevinReadOptions) => Promise<DevinRawConversation | null>;
}): Promise<{ candidates: UnifiedConversationCandidate[]; warnings: string[] }> {
    const requestedParents = options.conversationIds?.map(id => splitDevinSubagentId(id)?.parentId || id);
    const pool = [...parents];
    const explicitParents = [options.parentConversationId, ...(options.conversationIds || []).map(id => splitDevinSubagentId(id)?.parentId)].filter((id): id is string => Boolean(id));
    for (const id of new Set(explicitParents)) {
        if (!pool.some(parent => [parent.id, ...(parent.aliases || [])].includes(id))) pool.push({ id, dataChain: "windsurf", sourceKind: "devin-cli", title: id, workspace: "", updatedAt: "", detail: "explicit parent lookup" });
    }
    const selected = pool.filter(parent => parent.sourceKind?.startsWith("devin-") && !parent.isChildThread)
        .filter(parent => !options.parentConversationId || [parent.id, ...(parent.aliases || [])].includes(options.parentConversationId))
        .filter(parent => !requestedParents?.length || requestedParents.some(id => [parent.id, ...(parent.aliases || [])].includes(id)));
    const warnings: string[] = [];
    const candidates: UnifiedConversationCandidate[] = [];
    const maximumParents = Math.min(8, Math.max(1, options.candidateLimit || 8));
    if (selected.length > maximumParents) warnings.push("devin_child_parent_budget: child enumeration incomplete");
    const limited = selected.slice(0, maximumParents);
    const maximumChildren = Math.min(2000, Math.max(1, options.candidateLimit || 2000));
    const perParentBytes = Math.floor((options.maxBytes || 128 * 1024 * 1024) / Math.max(1, limited.length));
    const deadlineAt = Date.now() + (options.deadlineMs || 12_000);
    for (const parent of limited) {
        if (options.isCancelled?.() || Date.now() >= deadlineAt || perParentBytes < 1) { warnings.push("devin_child_read_budget"); break; }
        try {
            const raw = await (options.readRaw || readDevinRawConversation)(parent.id, { maxBytes: perParentBytes, deadlineMs: deadlineAt, isCancelled: options.isCancelled });
            if (!raw) { warnings.push(`devin_child_parent_unavailable:${parent.id}`); continue; }
            const children = selectDevinSubagents(raw);
            if (raw.partial) warnings.push(`devin_child_source_partial:${parent.id}`);
            for (const [agentId, entry] of children) {
                if (candidates.length >= maximumChildren || options.isCancelled?.() || Date.now() >= deadlineAt) {
                    warnings.push("devin_child_candidate_budget");
                    return { candidates, warnings };
                }
                const id = devinSubagentId(raw.summary.canonicalId, agentId);
                const payload = entry.payload;
                const hasTranscript = payload.rawNodes?.length > 0 || payload.childMessages?.length > 0;
                const partial = raw.partial || payload.partial === true || !hasTranscript;
                if (partial) warnings.push(`devin_child_partial:${id}`);
                candidates.push({ ...parent, id, sourceKind: raw.summary.sourceKind, sourcePath: raw.summary.sourcePath,
                    workspace: raw.summary.cwd || "", workspaces: raw.summary.workspaceUris, updatedAt: raw.summary.updatedAt || raw.summary.createdAt || "",
                    aliases: [...new Set([id, ...raw.summary.aliases.map(alias => devinSubagentId(alias, agentId))])],
                    uuid: undefined, sessionId: undefined, title: typeof payload.title === "string" ? payload.title : agentId,
                    isChildThread: true, parentConversationId: raw.summary.canonicalId, agentRole: typeof payload.profile === "string" ? payload.profile : "subagent",
                    sourcePartial: partial, detail: "devin-subagent", searchAliases: [agentId, payload.task].filter((value): value is string => typeof value === "string"),
                });
            }
        } catch (error) { warnings.push(`devin_child_read_failed:${parent.id}:${String(error)}`); }
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    return { candidates, warnings };
}
