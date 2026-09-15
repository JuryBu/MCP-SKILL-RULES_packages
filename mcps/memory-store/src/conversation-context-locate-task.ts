import { DATA_CHAIN_INPUT_VALUES, type DataChainInput } from "./chain.js";
import { listConversationCandidates, normalizeConversationSources, type ListConversationCandidatesOptions, type ListConversationCandidatesResult, type WorkspaceMatchMode, type WorkspaceMatchScope, type ConversationThreadMode } from "./conversation-filter.js";
import { locateConversationContext, locatePositiveInteger, type LocateMode, type LocateRawSource, type ConversationContextLocateOptions, type ConversationContextLocateResult } from "./conversation-context-locate.js";

export interface DeepLocateResumePayload {
    version: 2;
    query: string;
    dataChains: DataChainInput[];
    mode: LocateMode;
    source: LocateRawSource;
    conversationIds?: string[];
    workspaces?: string[];
    workspaceMode?: WorkspaceMatchMode;
    workspaceScope?: WorkspaceMatchScope;
    threadMode?: ConversationThreadMode;
    parentConversationId?: string;
    parentQuery?: string;
    parentDataChain?: DataChainInput;
    maxFiles: number;
    maxBytes: number;
    maxHits: number;
    deadlineMs: number;
    sourceFailureMode?: "warn" | "fail";
}

export function buildDeepLocateResumePayload(args: Omit<DeepLocateResumePayload, "version" | "maxFiles" | "maxBytes" | "maxHits" | "deadlineMs" | "source"> & Partial<Pick<DeepLocateResumePayload, "maxFiles" | "maxBytes" | "maxHits" | "deadlineMs" | "source">>): DeepLocateResumePayload {
    return {
        ...args, version: 2,
        dataChains: normalizeConversationSources(args.dataChains), source: args.source || "auto",
        maxFiles: locatePositiveInteger(args.maxFiles, 20, 20_000),
        maxBytes: locatePositiveInteger(args.maxBytes, 512 * 1024 * 1024),
        maxHits: locatePositiveInteger(args.maxHits, 20, 1000),
        deadlineMs: locatePositiveInteger(args.deadlineMs, 300_000, 1_800_000),
    };
}

export function parseDeepLocateResumePayload(value: unknown): DeepLocateResumePayload {
    if (!value || typeof value !== "object") throw new Error("deep_locate resume payload is missing");
    const raw = value as Record<string, unknown>;
    if ((raw.version !== 1 && raw.version !== 2) || typeof raw.query !== "string" || !raw.query.trim()) throw new Error("invalid deep_locate payload version/query");
    const chains = raw.version === 1 ? [raw.dataChain] : raw.dataChains;
    if (!Array.isArray(chains) || !chains.length || chains.some(chain => !(DATA_CHAIN_INPUT_VALUES as readonly unknown[]).includes(chain))) throw new Error("invalid deep_locate dataChains");
    if (raw.mode !== "exact" && raw.mode !== "fuzzy") throw new Error("invalid deep_locate mode");
    for (const field of ["conversationIds", "workspaces"]) {
        if (raw[field] !== undefined && (!Array.isArray(raw[field]) || (raw[field] as unknown[]).some(item => typeof item !== "string"))) throw new Error(`invalid deep_locate ${field}`);
    }
    for (const field of ["parentConversationId", "parentQuery"]) {
        if (raw[field] !== undefined && typeof raw[field] !== "string") throw new Error(`invalid deep_locate ${field}`);
    }
    for (const field of ["maxFiles", "maxBytes", "maxHits", "deadlineMs"]) {
        if (raw[field] !== undefined && (!Number.isSafeInteger(raw[field]) || Number(raw[field]) <= 0)) throw new Error(`invalid deep_locate ${field}`);
    }
    const enums: Record<string, readonly string[]> = {
        source: ["auto", "local", "ls", "cache"], workspaceMode: ["contains", "exact", "under", "any", "all"],
        workspaceScope: ["any", "primary"], threadMode: ["main", "children", "all"], sourceFailureMode: ["warn", "fail"],
        parentDataChain: DATA_CHAIN_INPUT_VALUES,
    };
    for (const [field, allowed] of Object.entries(enums)) {
        if (raw[field] !== undefined && !allowed.includes(raw[field] as string)) throw new Error(`invalid deep_locate ${field}`);
    }
    return buildDeepLocateResumePayload({
        ...(raw as unknown as DeepLocateResumePayload), dataChains: chains as DataChainInput[],
    });
}

export async function runConversationDeepLocate(
    payload: DeepLocateResumePayload,
    options: Pick<ConversationContextLocateOptions, "isCancelled" | "onProgress" | "adapters"> & {
        listCandidates?: (options: ListConversationCandidatesOptions) => Promise<ListConversationCandidatesResult>;
    } = {},
): Promise<ConversationContextLocateResult> {
    const startedAt = Date.now();
    if (options.isCancelled?.()) return locateConversationContext([], payload.query, { ...options, isCancelled: () => true });
    const candidateLimit = Math.min(20_000, Math.max(payload.maxFiles + 1, 50));
    const listed = await (options.listCandidates || listConversationCandidates)({
        dataChains: payload.dataChains, source: payload.source, workspaces: payload.workspaces,
        workspaceMode: payload.workspaceMode, workspaceScope: payload.workspaceScope,
        threadMode: payload.threadMode || "all", parentConversationId: payload.parentConversationId,
        parentQuery: payload.parentQuery, parentDataChain: payload.parentDataChain,
        conversationIds: payload.conversationIds, candidateLimit,
        maxBytes: payload.maxBytes,
        limit: candidateLimit * normalizeConversationSources(payload.dataChains).length,
        deadlineMs: payload.deadlineMs, isCancelled: options.isCancelled,
    });
    const diagnostics = listed.statuses.flatMap(status => status.status === "failed" ? [`${status.dataChain}: ${status.error}`] : status.warnings || []);
    if (payload.sourceFailureMode === "fail" && listed.statuses.some(status => status.status === "failed")) {
        throw new Error(`deep_locate sourceFailureMode=fail: ${diagnostics.join("; ")}`);
    }
    const sources = normalizeConversationSources(payload.dataChains);
    const groups = sources.map(source => listed.candidates.filter(candidate => candidate.dataChain === source));
    const candidates: typeof listed.candidates = [];
    for (let index = 0; groups.some(group => index < group.length); index++) {
        for (const group of groups) if (group[index]) candidates.push(group[index]);
    }
    const missing = (payload.conversationIds || []).filter(id => !candidates.some(candidate => candidate.id === id || candidate.aliases?.includes(id) || candidate.uuid === id || candidate.sessionId === id));
    const remainingMs = payload.deadlineMs - (Date.now() - startedAt);
    const result = await locateConversationContext(candidates, payload.query, {
        ...options, source: payload.source, mode: payload.mode,
        maxFiles: payload.maxFiles, maxBytes: payload.maxBytes, maxHits: payload.maxHits,
        deadlineMs: Math.max(1, remainingMs),
        candidatesPartial: listed.partial || diagnostics.length > 0 || missing.length > 0 || remainingMs <= 0,
        isCancelled: options.isCancelled,
    });
    result.warnings.push(...diagnostics, ...missing.map(id => `requested ID not resolved in selected scope: ${id}`));
    return result;
}
