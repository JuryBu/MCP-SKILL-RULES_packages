import { DATA_CHAIN_VALUES, normalizeDataChain, type DataChain, type DataChainInput } from "./chain.js";
import {
    getCodexThread,
    listCodexThreadsForMetadata,
    readCodexThreadParentMap,
    type CodexThreadInfo,
} from "./codex-client.js";
import {
    getClaudeCodeThread,
    listRecentClaudeCodeThreads,
    discoverClaudeCodeThreads,
    type ClaudeCodeMetadataDiscoveryResult,
    type ClaudeCodeThreadInfo,
} from "./claude-code-client.js";
import {
    detectWorkspaceFromSteps,
    fetchFirstPageSteps,
    discoverAntigravityConversations,
} from "./ls-client.js";
import {
    listRecentWindsurfThreads,
    discoverWindsurfThreads,
    resolveWindsurfThreadId,
    type WindsurfConversationSummary,
    type WindsurfDiscoveryResult,
} from "./windsurf-client.js";
import {
    discoverDshSessionSources,
    type DshMetadataDiscoveryResult,
    type DshSessionSource,
    type DshSessionSnapshot,
} from "./dsh-session-reader.js";
import { canonicalWorkspacePath } from "./store.js";
import type { ContextLocateReadBudget, ConversationContextLocateAdapters, ConversationContextLocateResult, ConversationContextLocateSharedBudget, LocateRawSource } from "./conversation-context-locate.js";
import { annotateContextLocateCandidates, contextLocateResolution, locateConversationContext, locatePositiveInteger } from "./conversation-context-locate.js";
import type { DevinConversationSummary } from "./devin-types.js";
import { listLocalPbConversationCandidates, type ConversationDiscoveryDiagnostic } from "./conversation-local-list.js";
import { discoverDevinConversations } from "./devin-sqlite.js";
import type { ConversationSourceCacheKey } from "./conversation-source-cache.js";
import { listCachedContextCandidates } from "./conversation-context-locate-cache.js";
import { discoverDevinChildCandidates } from "./devin-child-discovery.js";
import { splitDevinSubagentId } from "./devin-conversation.js";
import { resolveCachedDevinIdentity } from "./devin-identity.js";
import { isIsolatedSourceWorker, runIsolatedSource } from "./conversation-isolated-source.js";

export type ConversationSource = Exclude<DataChain, "auto">;
export type WorkspaceMatchMode = "contains" | "exact" | "under" | "any" | "all";
export type WorkspaceMatchScope = "any" | "primary";
export type SourceFailureMode = "warn" | "fail";
export type IdResolutionMode = "unique" | "priority";
export type ConversationThreadMode = "main" | "children" | "all";

export interface UnifiedConversationCandidate {
    id: string;
    cacheKey?: ConversationSourceCacheKey;
    cacheGeneration?: string;
    aliases?: string[];
    uuid?: string;
    sessionId?: string;
    sourceKind?: string;
    sourcePath?: string;
    sourceBytes?: number;
    sourcePartial?: boolean;
    discoveryWarnings?: string[];
    dataChain: ConversationSource;
    title: string;
    workspace: string;
    workspaces?: string[];
    updatedAt: string;
    detail: string;
    contextProbe?: string[];
    searchAliases?: string[];
    agentRole?: string | null;
    agentNickname?: string | null;
    parentConversationId?: string | null;
    rootConversationId?: string | null;
    isChildThread?: boolean;
    matchedChildConversationId?: string | null;
    matchedChildTitle?: string | null;
}

export interface SourceStatus {
    dataChain: ConversationSource;
    status: "ok" | "failed";
    count: number;
    error?: string;
    warnings?: string[];
    partial?: boolean;
    diagnostics?: ConversationDiscoveryDiagnostic[];
}

export interface ListConversationCandidatesOptions {
    dataChains?: Array<DataChainInput | string>;
    query?: string;
    workspaces?: string[];
    workspaceMode?: WorkspaceMatchMode;
    workspaceScope?: WorkspaceMatchScope;
    threadMode?: ConversationThreadMode;
    parentConversationId?: string;
    parentQuery?: string;
    parentDataChain?: DataChainInput | string;
    limit?: number;
    sourceFailureMode?: SourceFailureMode;
    adapters?: ConversationSourceAdapters;
    source?: LocateRawSource;
    contextProbe?: string;
    contextAdapters?: ConversationContextLocateAdapters;
    candidateLimit?: number;
    maxBytes?: number;
    maxHits?: number;
    deadlineMs?: number;
    deadlineAt?: number;
    signal?: AbortSignal;
    isCancelled?: () => boolean;
    conversationIds?: string[];
    onCheckpoint?: (result: ListConversationCandidatesResult) => void | Promise<void>;
}

export interface ListConversationCandidatesResult {
    candidates: UnifiedConversationCandidate[];
    statuses: SourceStatus[];
    partial?: boolean;
    contextLocate?: ConversationContextLocateResult;
}

export interface ConversationIdHit {
    dataChain: ConversationSource;
    conversationId: string;
    title?: string;
    workspace?: string;
}

export interface ResolveConversationIdAcrossSourcesOptions {
    dataChains?: Array<DataChainInput | string>;
    sourceFailureMode?: SourceFailureMode;
    adapters?: ConversationSourceAdapters;
}

export interface ResolveConversationIdAcrossSourcesResult {
    hits: ConversationIdHit[];
    statuses: SourceStatus[];
}

export interface ConversationSourceAdapters {
    codex: {
        list(limit: number): Promise<CodexThreadInfo[]> | CodexThreadInfo[];
        get(id: string): Promise<CodexThreadInfo | null> | CodexThreadInfo | null;
    };
    "claude-code": {
        list(limit: number): Promise<ClaudeCodeThreadInfo[]> | ClaudeCodeThreadInfo[];
        get(id: string): Promise<ClaudeCodeThreadInfo | null> | ClaudeCodeThreadInfo | null;
        discover?: (limit: number, options: ListConversationCandidatesOptions) => Promise<ClaudeCodeMetadataDiscoveryResult>;
    };
    antigravity: {
        list(limit: number): Promise<Array<{ id: string; title?: string; mtime: Date; sizeKB?: number; workspace?: string }>> | Array<{ id: string; title?: string; mtime: Date; sizeKB?: number; workspace?: string }>;
        discover?: (limit: number, options: ListConversationCandidatesOptions) => ReturnType<typeof discoverAntigravityConversations> | Promise<ReturnType<typeof discoverAntigravityConversations>>;
    };
    windsurf: {
        list(limit: number): Promise<WindsurfConversationSummary[]> | WindsurfConversationSummary[];
        discover?: (limit: number, options: ListConversationCandidatesOptions) => Promise<WindsurfDiscoveryResult>;
        discoverChildren?: typeof discoverDevinChildCandidates;
        resolve(id: string): Promise<string | null> | string | null;
    };
    dsh?: {
        list(limit: number): Promise<DshCandidateMetadata[]> | DshCandidateMetadata[];
        get(id: string): Promise<DshCandidateMetadata | null> | DshCandidateMetadata | null;
        discover?: (limit: number, options: ListConversationCandidatesOptions) => Promise<DshMetadataDiscoveryResult>;
    };
    localList?: (source: "antigravity" | "windsurf", limit: number, options?: ListConversationCandidatesOptions) => Promise<UnifiedConversationCandidate[]>;
    readWorkspace?: (candidate: UnifiedConversationCandidate) => Promise<string | undefined>;
}

const DEFAULT_SOURCE_ORDER: ConversationSource[] = ["codex", "antigravity", "claude-code", "windsurf", "dsh"];
type DshCandidateMetadata = DshSessionSource & Partial<DshSessionSnapshot>;

const DEFAULT_ADAPTERS: ConversationSourceAdapters = {
    codex: {
        list: limit => listCodexThreadsForMetadata(limit),
        get: id => getCodexThread(id),
    },
    "claude-code": {
        list: limit => listRecentClaudeCodeThreads(limit),
        get: async id => (await discoverClaudeCodeThreads({ conversationIds: [id], limit: 1 })).threads[0] || null,
        discover: (limit, options) => discoverClaudeCodeThreads({ limit, conversationIds: options.conversationIds,
            workspaces: options.workspaces, workspaceMode: options.workspaceMode,
            maxBytes: options.maxBytes, deadlineAt: options.deadlineAt, isCancelled: options.isCancelled }),
    },
    antigravity: {
        list: limit => discoverAntigravityConversations({ limit }).conversations,
        discover: (limit, options) => discoverAntigravityConversations({ limit, conversationIds: options.conversationIds, deadlineAt: options.deadlineAt, isCancelled: options.isCancelled }),
    },
    windsurf: {
        list: limit => listRecentWindsurfThreads(limit),
        discoverChildren: discoverDevinChildCandidates,
        discover: (limit, options) => discoverWindsurfThreads(limit, {
            conversationIds: options.conversationIds?.map(id => splitDevinSubagentId(id)?.parentId || id),
            workspaces: options.workspaces, workspaceMode: options.workspaceMode, workspaceScope: options.workspaceScope,
            maxBytes: options.maxBytes, deadlineAt: options.deadlineAt, isCancelled: options.isCancelled,
        }),
        resolve: id => resolveWindsurfThreadId(id),
    },
    dsh: {
        list: async limit => (await discoverDshSessionSources({ limit })).sources,
        get: async id => (await discoverDshSessionSources({ conversationIds: [id], limit: 1 })).sources[0] || null,
        discover: (limit, options) => discoverDshSessionSources({ limit, conversationIds: options.conversationIds,
            workspaces: options.workspaces, workspaceMode: options.workspaceMode,
            maxBytes: options.maxBytes, deadlineAt: options.deadlineAt, isCancelled: options.isCancelled }),
    },
};

export function normalizeConversationSources(inputs?: Array<DataChainInput | string>): ConversationSource[] {
    if (!inputs || inputs.length === 0) return [...DEFAULT_SOURCE_ORDER];
    const result: ConversationSource[] = [];
    for (const input of inputs) {
        const normalized = normalizeDataChain(input, "auto");
        const expanded = normalized === "auto"
            ? DEFAULT_SOURCE_ORDER
            : [normalized as ConversationSource];
        for (const chain of expanded) {
            if ((DATA_CHAIN_VALUES as readonly string[]).includes(chain) && !result.includes(chain)) {
                result.push(chain);
            }
        }
    }
    return result.length > 0 ? result : [...DEFAULT_SOURCE_ORDER];
}

export function normalizeConversationQuery(input: string | undefined): string {
    return (input || "")
        .toLowerCase()
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N}]+/gu, "");
}

function isUsefulQueryTerm(term: string): boolean {
    if (!term) return false;
    if (/^[a-z0-9]$/u.test(term)) return false;
    return term.length >= 2 || /[\u3400-\u9fff]/u.test(term);
}

export function splitConversationQueryTerms(input: string | undefined): string[] {
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const rawTerm of (input || "").trim().split(/\s+/u)) {
        const term = normalizeConversationQuery(rawTerm);
        if (!isUsefulQueryTerm(term) || seen.has(term)) continue;
        seen.add(term);
        terms.push(term);
    }
    return terms;
}

function isoFromMs(ms?: number): string {
    return ms ? new Date(ms).toISOString() : "";
}

function rootConversationIdFor(itemId: string, parentMap: Map<string, string>): string | null {
    let current = itemId;
    let root: string | null = null;
    const seen = new Set<string>();
    for (let depth = 0; depth < 16; depth++) {
        const parent = parentMap.get(current);
        if (!parent || seen.has(parent)) return root;
        seen.add(parent);
        root = parent;
        current = parent;
    }
    return root;
}

function candidateFromCodexThread(item: CodexThreadInfo, parentMap = new Map<string, string>()): UnifiedConversationCandidate {
    const parentConversationId = item.parentConversationId || parentMap.get(item.id) || null;
    const isChildThread = Boolean(parentConversationId);
    return {
        id: item.id,
        sourcePath: item.rolloutPath,
        dataChain: "codex",
        title: item.title || "",
        workspace: item.cwd || "",
        updatedAt: isoFromMs(item.updatedAtMs || undefined),
        detail: [
            item.agentRole ? `agent=${item.agentRole}` : "",
            isChildThread ? "childThread" : "",
            parentConversationId ? `parentConversationId=${parentConversationId}` : "",
            item.model,
            item.reasoningEffort,
        ].filter(Boolean).join(" / "),
        agentRole: item.agentRole || null,
        agentNickname: item.agentNickname || null,
        parentConversationId,
        rootConversationId: rootConversationIdFor(item.id, parentMap),
        isChildThread,
    };
}

function candidateFromClaudeCodeThread(item: ClaudeCodeThreadInfo): UnifiedConversationCandidate {
    const isChildThread = Boolean(item.isChildThread || item.parentConversationId);
    const parentConversationId = item.parentConversationId || null;
    return {
        id: item.id,
        sourcePath: item.jsonlPath,
        dataChain: "claude-code",
        title: item.title || "",
        workspace: item.cwd || "",
        updatedAt: isoFromMs(item.updatedAtMs || undefined),
        detail: [
            "claude-code",
            isChildThread ? "childThread" : "",
            parentConversationId ? `parentConversationId=${parentConversationId}` : "",
            item.agentRole ? `agent=${item.agentRole}` : "",
            item.agentNickname ? `agentNickname=${item.agentNickname}` : "",
            item.accountId ? `account=${item.accountId}` : "",
            item.organizationId ? `org=${item.organizationId}` : "",
            item.isArchived === true ? "archived" : "",
            item.desktopIndexPath ? "desktop-index" : "",
            item.model,
            item.entrypoint,
        ].filter(Boolean).join(" / "),
        agentRole: item.agentRole || null,
        agentNickname: item.agentNickname || null,
        parentConversationId,
        isChildThread,
        searchAliases: item.titleAliases,
    };
}

function candidateFromDshSession(item: DshCandidateMetadata): UnifiedConversationCandidate {
    const header = item.header as Record<string, unknown>;
    const parentConversationId = typeof header.parentSession === "string" ? header.parentSession : null;
    const isChildThread = parentConversationId !== null || header.origin === "subagent";
    const workspace = typeof header.cwd === "string" ? header.cwd : "";
    const title = item.titleBestEffort
        || (typeof header.title === "string"
        ? header.title
        : typeof header.agentPreset === "string"
            ? header.agentPreset
            : item.id);
    return {
        id: item.id,
        sourceBytes: item.provenance.sourceSizeBytes,
        dataChain: "dsh",
        title,
        workspace,
        workspaces: workspace ? [workspace] : undefined,
        updatedAt: isoFromMs(item.provenance.sourceMtimeMs),
        detail: [
            "dsh format v0",
            item.provenance.format,
            typeof item.eventCount === "number" ? `${item.eventCount} events` : "仅会话元数据",
            `${item.provenance.sourceSizeBytes} bytes`,
            isChildThread ? "childThread" : "",
        ].filter(Boolean).join(" / "),
        searchAliases: typeof header.agentPreset === "string" ? [header.agentPreset] : undefined,
        agentRole: header.origin === "subagent" ? "subagent" : null,
        agentNickname: typeof header.agentPreset === "string" ? header.agentPreset : null,
        parentConversationId,
        rootConversationId: parentConversationId,
        isChildThread,
    };
}

function candidateFromWindsurfThread(item: WindsurfConversationSummary): UnifiedConversationCandidate {
    const identity = item as WindsurfConversationSummary & { aliases?: string[]; uuid?: string; sessionId?: string; sourceKind?: string; sourcePath?: string; partial?: boolean };
    const isChildThread = Boolean(item.isChildThread || item.parentConversationId);
    const parentConversationId = item.parentConversationId || null;
    return {
        id: item.id,
        aliases: identity.aliases,
        uuid: identity.uuid,
        sessionId: identity.sessionId,
        sourceKind: identity.sourceKind,
        sourcePath: identity.sourcePath,
        sourcePartial: identity.partial || Boolean(item.discoveryWarnings?.length),
        discoveryWarnings: item.discoveryWarnings,
        searchAliases: [identity.uuid, identity.sessionId, ...(identity.aliases || [])].filter((value): value is string => Boolean(value)),
        dataChain: "windsurf",
        title: item.titleBestEffort || item.title || item.summary || "",
        workspace: item.cwd || "",
        workspaces: item.workspaceUris,
        updatedAt: item.lastModifiedTime || item.createdTime || "",
        detail: [
            "windsurf",
            item.titleSource === "renamedTitle" ? "title=renamedTitle" : "",
            item.titleBestEffort ? "title=titleBestEffort" : "",
            isChildThread ? "childThread" : "",
            parentConversationId ? `parentConversationId=${parentConversationId}` : "",
            item.agentRole ? `agent=${item.agentRole}` : "",
            item.agentNickname ? `agentNickname=${item.agentNickname}` : "",
            item.workspaceUris?.length ? `workspaces=${item.workspaceUris.length}` : "",
            item.referencedFiles?.length ? `referencedFiles=${item.referencedFiles.length}` : "",
            item.status,
            item.stepCount ? `${item.stepCount} steps` : "",
            item.lastGeneratorModelUid,
        ].filter(Boolean).join(" / "),
        agentRole: item.agentRole || null,
        agentNickname: item.agentNickname || null,
        parentConversationId,
        isChildThread,
    };
}

export function candidateFromDevinConversation(item: DevinConversationSummary): UnifiedConversationCandidate {
    return {
        id: item.canonicalId || item.id, aliases: item.aliases, uuid: item.uuid, sessionId: item.sessionId,
        sourceKind: item.sourceKind, sourcePath: item.sourcePath, dataChain: "windsurf",
        sourcePartial: item.partial,
        discoveryWarnings: item.warnings.length ? item.warnings : undefined,
        title: item.title, workspace: item.cwd || "", workspaces: item.workspaceUris,
        updatedAt: item.updatedAt || item.createdAt || "", detail: item.sourceKind,
        searchAliases: item.aliases, isChildThread: item.isChildThread,
        parentConversationId: item.parentConversationId, agentRole: item.isChildThread ? "subagent" : null,
    };
}

async function listLocalSourceCandidates(source: "antigravity" | "windsurf", limit: number, options: ListConversationCandidatesOptions = {}, diagnostics: ConversationDiscoveryDiagnostic[] = []): Promise<UnifiedConversationCandidate[]> {
    const pbCandidates = listLocalPbConversationCandidates(source, { limit, conversationIds: options.conversationIds,
        deadlineAt: options.deadlineAt, isCancelled: options.isCancelled, onDiagnostic: diagnostic => diagnostics.push(diagnostic) });
    const candidates: UnifiedConversationCandidate[] = pbCandidates.map(item => ({
        id: item.id, dataChain: source, title: "", workspace: "", updatedAt: item.updatedAt,
        sourceKind: "cascade-pb", sourceBytes: item.bytes,
        detail: `${item.kinds.join("+")} / ${item.bytes} bytes / ${item.files} files`,
    }));
    if (source === "windsurf") {
        const discovered = await discoverDevinConversations({ limit, maxBytes: options.maxBytes,
            conversationIds: options.conversationIds?.map(id => splitDevinSubagentId(id)?.parentId || id),
            workspaces: options.workspaces, workspaceMode: options.workspaceMode, workspaceScope: options.workspaceScope,
            deadlineMs: options.deadlineAt ?? Date.now() + (options.deadlineMs ?? 12_000), isCancelled: options.isCancelled });
        diagnostics.push(...discovered.diagnostics);
        candidates.push(...discovered.conversations.map(candidateFromDevinConversation));
    }
    const seen = new Set<string>();
    return candidates.filter(candidate => {
        if (options.conversationIds?.length && !options.conversationIds.some(requested => {
            const id = splitDevinSubagentId(requested)?.parentId || requested;
            return id === candidate.id || candidate.aliases?.includes(id) || id === candidate.uuid || id === candidate.sessionId;
        })) return false;
        if (seen.has(candidate.id)) return false;
        seen.add(candidate.id);
        return true;
    }).sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0)).slice(0, limit);
}

function candidateSearchHaystack(item: UnifiedConversationCandidate): string {
    return normalizeConversationQuery([
        item.id,
        ...(item.aliases || []),
        item.uuid || "",
        item.sessionId || "",
        item.title,
        item.workspace,
        ...(item.workspaces || []),
        ...(item.searchAliases || []),
        item.agentRole || "",
        item.agentNickname || "",
    ].join("\n"));
}

function queryTermsMatch(haystack: string, queryTerms: string[]): boolean {
    return queryTerms.length > 1 && queryTerms.some(term => haystack.includes(term));
}

function candidateMatchesQuery(item: UnifiedConversationCandidate, normalizedQuery: string, queryTerms: string[] = []): boolean {
    if (!normalizedQuery) return true;
    const haystack = candidateSearchHaystack(item);
    return haystack.includes(normalizedQuery) || queryTermsMatch(haystack, queryTerms);
}

function fieldIncludesAny(field: string, queryTerms: string[]): boolean {
    return queryTerms.length > 1 && queryTerms.some(term => field.includes(term));
}

function candidateQueryPriority(item: UnifiedConversationCandidate, normalizedQuery: string, queryTerms: string[] = []): number {
    if (!normalizedQuery) return 9;
    const id = normalizeConversationQuery(item.id);
    const title = normalizeConversationQuery(item.title || "");
    const workspace = normalizeConversationQuery(item.workspace || "");
    const workspaces = normalizeConversationQuery((item.workspaces || []).join("\n"));
    const aliases = normalizeConversationQuery((item.searchAliases || []).join("\n"));
    const agent = normalizeConversationQuery([item.agentRole || "", item.agentNickname || ""].join("\n"));
    const haystack = [id, title, aliases, workspace, workspaces, agent].join("\n");
    if (id === normalizedQuery) return 0;
    if (normalizedQuery.length >= 8 && id.startsWith(normalizedQuery)) return 1;
    if (title === normalizedQuery) return 2;
    if (title.includes(normalizedQuery)) return 3;
    if (aliases === normalizedQuery) return 4;
    if (aliases.includes(normalizedQuery)) return 5;
    if (workspace.includes(normalizedQuery)) return 6;
    if (fieldIncludesAny(title, queryTerms) || fieldIncludesAny(aliases, queryTerms)) return 7;
    if (fieldIncludesAny(workspace, queryTerms) || fieldIncludesAny(workspaces, queryTerms)) return 8;
    if (fieldIncludesAny(agent, queryTerms)) return 9;
    if (queryTermsMatch(haystack, queryTerms)) return 10;
    return 11;
}

function workspaceSingleMatch(candidate: string, requested: string, mode: WorkspaceMatchMode): boolean {
    if (mode === "exact") return candidate === requested;
    if (mode === "under") return candidate === requested || candidate.startsWith(`${requested}\\`) || candidate.startsWith(`${requested}/`);
    return candidate === requested
        || candidate.startsWith(`${requested}\\`)
        || candidate.startsWith(`${requested}/`)
        || requested.startsWith(`${candidate}\\`)
        || requested.startsWith(`${candidate}/`);
}

export function workspaceMatches(candidateWorkspace: string | string[], requestedWorkspaces: string[] = [], mode: WorkspaceMatchMode = "contains"): boolean {
    if (requestedWorkspaces.length === 0) return true;
    const candidates = (Array.isArray(candidateWorkspace) ? candidateWorkspace : [candidateWorkspace])
        .map(item => canonicalWorkspacePath(item || ""))
        .filter(Boolean);
    if (candidates.length === 0) return false;
    const singleMode: WorkspaceMatchMode = mode === "any" || mode === "all" ? "contains" : mode;
    const checks = requestedWorkspaces
        .map(item => canonicalWorkspacePath(item || ""))
        .filter(Boolean)
        .map(requested => candidates.some(candidate => workspaceSingleMatch(candidate, requested, singleMode)));
    if (checks.length === 0) return true;
    return mode === "all" ? checks.every(Boolean) : checks.some(Boolean);
}

function candidateWorkspacesForScope(item: UnifiedConversationCandidate, scope: WorkspaceMatchScope = "any"): string | string[] {
    if (scope === "primary") return item.workspace;
    return item.workspaces?.length ? item.workspaces : item.workspace;
}

function candidateWarnings(item: UnifiedConversationCandidate): string[] {
    return item.detail
        .split("/")
        .map(part => part.trim())
        .filter(part => part.startsWith("workspaceProbeWarning="));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

async function listSourceCandidates(
    source: ConversationSource,
    limit: number,
    adapters: ConversationSourceAdapters,
    probeWorkspace = false,
    options: ListConversationCandidatesOptions = {},
    diagnostics: ConversationDiscoveryDiagnostic[] = [],
): Promise<UnifiedConversationCandidate[]> {
    if (options.source === "local" && (source === "antigravity" || source === "windsurf")) {
        return adapters.localList ? adapters.localList(source, limit, options) : listLocalSourceCandidates(source, limit, options, diagnostics);
    }
    if (source === "codex") {
        const parentMap = options.adapters ? new Map<string, string>() : readCodexThreadParentMap();
        const rows = options.conversationIds?.length
            ? (await Promise.all(options.conversationIds.map(id => adapters.codex.get(id)))).filter((item): item is CodexThreadInfo => Boolean(item))
            : await adapters.codex.list(limit);
        return rows.map(item => candidateFromCodexThread(item, parentMap));
    }
    if (source === "claude-code") {
        const discovered = await adapters["claude-code"].discover?.(limit, options);
        if (discovered) {
            const warnings = discovered.warnings.length ? discovered.warnings : discovered.partial ? ["Claude Code metadata discovery is incomplete"] : [];
            diagnostics.push(...warnings.map(message => ({ code: "CC_METADATA_DISCOVERY", sourceKind: "claude-code", message })));
        }
        const rows = discovered?.threads || (options.conversationIds?.length
            ? (await Promise.all(options.conversationIds.map(id => adapters["claude-code"].get(id)))).filter((item): item is ClaudeCodeThreadInfo => Boolean(item))
            : await adapters["claude-code"].list(limit));
        return rows.map(candidateFromClaudeCodeThread);
    }
    if (source === "windsurf") {
        const discovered = await adapters.windsurf.discover?.(limit, options);
        if (discovered) diagnostics.push(...discovered.diagnostics);
        const candidates = (discovered?.conversations || await adapters.windsurf.list(limit)).map(candidateFromWindsurfThread);
        for (const id of options.conversationIds || []) {
            if (candidates.some(item => item.id === id || item.aliases?.includes(id))) continue;
            if (!options.adapters) continue;
            const resolved = await adapters.windsurf.resolve(id);
            const existing = candidates.find(item => item.id === resolved);
            if (existing) existing.aliases = [...new Set([...(existing.aliases || []), id])];
            if (resolved && !existing) candidates.push({
                id: resolved, aliases: [...new Set([resolved, id])], dataChain: "windsurf", title: resolved,
                workspace: "", updatedAt: "", detail: "explicit ID resolved outside recent metadata window",
            });
        }
        return candidates;
    }
    if (source === "dsh") {
        const dsh = (adapters.dsh || DEFAULT_ADAPTERS.dsh)!;
        const discovered = await dsh.discover?.(limit, options);
        if (discovered) {
            const warnings = discovered.warnings.length ? discovered.warnings : discovered.partial ? ["DSH metadata discovery is incomplete"] : [];
            diagnostics.push(...warnings.map(message => ({ code: "DSH_METADATA_DISCOVERY", sourceKind: "dsh", message })));
        }
        const rows = discovered?.sources || (options.conversationIds?.length
            ? (await Promise.all(options.conversationIds.map(id => dsh.get(id)))).filter((item): item is DshCandidateMetadata => Boolean(item))
            : await dsh.list(limit));
        return rows.map(candidateFromDshSession);
    }
    const discovered = await adapters.antigravity.discover?.(limit, options);
    if (discovered) diagnostics.push(...discovered.diagnostics);
    const rows = discovered?.conversations || await adapters.antigravity.list(limit);
    const candidates = rows.map(item => ({
        id: item.id,
        dataChain: "antigravity",
        title: item.title || "",
        workspace: item.workspace || "",
        updatedAt: item.mtime.toISOString(),
        detail: `${(item.sizeKB || 0).toFixed(1)} KB`,
    } satisfies UnifiedConversationCandidate));
    if (!probeWorkspace) return candidates;
    const probeLimit = Math.min(candidates.length, Math.max(Number(process.env.MEMORY_STORE_CONVERSATION_ANTIGRAVITY_WORKSPACE_PROBE_LIMIT || 50), 0));
    const timeoutMs = Math.max(Number(process.env.MEMORY_STORE_CONVERSATION_ANTIGRAVITY_WORKSPACE_PROBE_TIMEOUT_MS || 5000), 100);
    await Promise.all(candidates.slice(0, probeLimit).map(async candidate => {
        if (candidate.workspace) return;
        try {
            if (options.isCancelled?.()) throw new Error("Antigravity workspace discovery cancelled");
            const remainingMs = Math.min(timeoutMs, (options.deadlineAt ?? Date.now() + timeoutMs) - Date.now());
            if (remainingMs <= 0) throw new Error("Antigravity workspace discovery deadline exceeded");
            const steps = await withTimeout(fetchFirstPageSteps(candidate.id, options), remainingMs);
            const workspace = steps ? detectWorkspaceFromSteps(steps) : null;
            if (workspace) candidate.workspace = workspace;
            if (!workspace) {
                candidate.detail = [candidate.detail, "workspaceProbeWarning=no-workspace-detected"].filter(Boolean).join(" / ");
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            candidate.detail = [candidate.detail, `workspaceProbeWarning=${message}`].filter(Boolean).join(" / ");
        }
    }));
    return candidates;
}

function conversationSourceFetchLimit(source: ConversationSource, sourceLimit: number, options: ListConversationCandidatesOptions): number {
    if (options.candidateLimit) return Math.min(Math.max(options.candidateLimit, 1), 20_000);
    if (options.contextProbe?.trim()) return Math.max(sourceLimit, 50);
    const baseLimit = Math.max(sourceLimit * 3, 50);
    const needsMetadataLocate = Boolean(
        options.query?.trim()
        || options.workspaces?.length
        || options.parentConversationId?.trim()
        || options.parentQuery?.trim()
        || options.threadMode === "children"
        || options.threadMode === "all"
    );
    if (!needsMetadataLocate) return baseLimit;
    if (source !== "codex" && source !== "claude-code" && source !== "windsurf" && source !== "antigravity") return baseLimit;
    const sourceSpecific = source === "claude-code"
        ? process.env.MEMORY_STORE_CLAUDE_CODE_METADATA_THREAD_LIMIT
        : source === "windsurf"
            ? process.env.MEMORY_STORE_WINDSURF_METADATA_THREAD_LIMIT
            : process.env.MEMORY_STORE_CODEX_METADATA_THREAD_LIMIT;
    const shared = process.env.MEMORY_STORE_CONVERSATION_METADATA_THREAD_LIMIT;
    return Math.max(baseLimit, Number(sourceSpecific || shared || process.env.MEMORY_STORE_CODEX_METADATA_THREAD_LIMIT || 20_000));
}

function cloneWithChildMatch(parent: UnifiedConversationCandidate, child: UnifiedConversationCandidate): UnifiedConversationCandidate {
    const childTitle = child.title || child.agentNickname || child.id;
    return {
        ...parent,
        matchedChildConversationId: child.id,
        matchedChildTitle: childTitle,
        detail: [
            parent.detail,
            `matchedChildConversationId=${child.id}`,
            childTitle ? `matchedChildTitle=${childTitle.slice(0, 80)}` : "",
        ].filter(Boolean).join(" / "),
    };
}

function resolveParentForChildrenMode(
    raw: UnifiedConversationCandidate[],
    normalizedParentQuery: string,
    parentQueryTerms: string[],
    options: ListConversationCandidatesOptions,
): { parentId?: string; warnings: string[] } {
    if (options.parentConversationId?.trim()) {
        const requested = options.parentConversationId.trim();
        const parents = raw.filter(item => item.id === requested || item.aliases?.includes(requested));
        const cachedParent = options.source === "cache" && raw.some(item => item.dataChain === "windsurf") ? resolveCachedDevinIdentity(requested) : requested;
        return parents.length > 1 ? { warnings: ["parent alias is ambiguous"] } : { parentId: parents[0]?.id || cachedParent, warnings: [] };
    }
    if (!normalizedParentQuery) {
        return { warnings: ["threadMode=children 需要 parentConversationId 或 parentQuery"] };
    }
    const parentMatches = raw
        .filter(item => !item.isChildThread)
        .filter(item => candidateMatchesQuery(item, normalizedParentQuery, parentQueryTerms))
        .filter(item => workspaceMatches(candidateWorkspacesForScope(item, options.workspaceScope || "any"), options.workspaces || [], options.workspaceMode || "any"));
    if (parentMatches.length === 1) {
        return { parentId: parentMatches[0].id, warnings: [] };
    }
    if (parentMatches.length === 0) {
        return { warnings: [`parentQuery 未唯一定位父线程：0 个候选`] };
    }
    return { warnings: [`parentQuery 未唯一定位父线程：${parentMatches.length} 个候选，请传 parentConversationId`] };
}

function applyThreadMode(
    raw: UnifiedConversationCandidate[],
    filtered: UnifiedConversationCandidate[],
    normalizedQuery: string,
    queryTerms: string[],
    options: ListConversationCandidatesOptions,
): { filtered: UnifiedConversationCandidate[]; warnings: string[] } {
    const threadMode = options.threadMode || "main";
    if (threadMode === "all") return { filtered, warnings: [] };

    if (threadMode === "children") {
        const { parentId, warnings } = resolveParentForChildrenMode(raw, normalizeConversationQuery(options.parentQuery), splitConversationQueryTerms(options.parentQuery), options);
        if (!parentId) return { filtered: [], warnings };
        return {
            filtered: filtered
                .filter(item => item.isChildThread && item.parentConversationId === parentId)
                .filter(item => candidateMatchesQuery(item, normalizedQuery, queryTerms))
                .filter(item => workspaceMatches(candidateWorkspacesForScope(item, options.workspaceScope || "any"), options.workspaces || [], options.workspaceMode || "any")),
            warnings,
        };
    }

    const main = filtered.filter(item => !item.isChildThread);
    const byId = new Map(main.map(item => [item.id, item]));
    const childHits = filtered.filter(item => item.isChildThread && item.parentConversationId);
    for (const child of childHits) {
        const parent = raw.find(item => item.id === child.parentConversationId);
        if (!parent || parent.isChildThread || byId.has(parent.id)) continue;
        if (!workspaceMatches(candidateWorkspacesForScope(parent, options.workspaceScope || "any"), options.workspaces || [], options.workspaceMode || "any")) {
            continue;
        }
        const promoted = cloneWithChildMatch(parent, child);
        main.push(promoted);
        byId.set(promoted.id, promoted);
    }
    return { filtered: main, warnings: [] };
}

function candidateMatchesIdentity(candidate: UnifiedConversationCandidate, id: string): boolean {
    return [candidate.id, ...(candidate.aliases || []), candidate.uuid, candidate.sessionId]
        .some(value => value?.toLowerCase() === id.trim().toLowerCase());
}

function exactQueryTargets(raw: UnifiedConversationCandidate[], options: ListConversationCandidatesOptions): string[] | undefined {
    if (options.conversationIds?.length || !options.query?.trim()) return undefined;
    return raw.some(candidate => candidateMatchesIdentity(candidate, options.query!)) ? [options.query.trim()] : undefined;
}

function appendDevinChildren(raw: UnifiedConversationCandidate[], children: Awaited<ReturnType<typeof discoverDevinChildCandidates>>): void {
    for (const parent of children.verifiedParents) {
        const verifiedIds = new Set([parent.summary.id, parent.summary.canonicalId, ...parent.summary.aliases]);
        const matchingIndices: number[] = [];
        for (const [index, candidate] of raw.entries()) {
            if (candidate.sourceKind?.startsWith("devin-") && [candidate.id, ...(candidate.aliases || [])].some(id => verifiedIds.has(id))) matchingIndices.push(index);
        }
        if (matchingIndices.length) {
            raw[matchingIndices[0]!] = { ...candidateFromDevinConversation(parent.summary), sourcePartial: parent.partial || parent.summary.partial };
            for (const index of matchingIndices.slice(1).reverse()) raw.splice(index, 1);
        }
    }
    raw.push(...children.candidates.filter(child => !raw.some(candidate => candidate.id === child.id)));
}

function partialCandidateDeadlineResult(checkpoint: ListConversationCandidatesResult | undefined, options: ListConversationCandidatesOptions): ListConversationCandidatesResult {
    const sources = normalizeConversationSources(options.dataChains);
    const warning = "candidate_discovery_deadline: source or text scan is incomplete";
    const statuses = sources.map(dataChain => {
        const previous = checkpoint?.statuses.find(status => status.dataChain === dataChain);
        return previous ? { ...previous, partial: true, warnings: [...new Set([...(previous.warnings || []), warning])] }
            : { dataChain, status: "failed" as const, count: 0, error: "Candidate discovery did not complete before its deadline", partial: true, warnings: [warning] };
    });
    const previous = checkpoint?.contextLocate;
    const contextLocate: ConversationContextLocateResult | undefined = options.contextProbe?.trim() ? {
        ...(previous || { scannedFiles: 0, totalFiles: statuses.reduce((total, status) => total + status.count, 0), scannedBytes: 0, totalBytes: 0,
            hits: [], scope: "provided_candidates" as const, matchedConversationCount: 0, matchIdentityScope: "listed_threads" as const }),
        status: previous?.hits.length ? "partial_found_scanning" : "budget_exhausted",
        truncated: true, reason: "candidate_discovery_deadline", warnings: [...new Set([...(previous?.warnings || []), warning])],
        resolution: (previous?.matchedConversationCount || 0) > 1 ? "ambiguous" : previous?.hits.length ? "single_match_in_partial_scan" : "unverified",
    } : undefined;
    return { candidates: checkpoint?.candidates || [], statuses, partial: true, contextLocate };
}

function locatedCandidateResult(collected: UnifiedConversationCandidate[], rawBySource: Map<ConversationSource, UnifiedConversationCandidate[]>,
    sources: ConversationSource[], options: ListConversationCandidatesOptions, sourceStatuses: SourceStatus[], sourcePartial: boolean,
    sourceLocate: ConversationContextLocateResult): ListConversationCandidatesResult {
    const contextLocate = { ...sourceLocate, hits: [...sourceLocate.hits], warnings: [...sourceLocate.warnings] };
    const statuses = sourceStatuses.map(status => ({ ...status, warnings: status.warnings ? [...status.warnings] : undefined }));
    let partial = sourcePartial;
    const annotated = annotateContextLocateCandidates(collected, contextLocate);
    const selected: UnifiedConversationCandidate[] = [];
    for (const source of sources) {
        const scoped = annotated.filter(item => item.dataChain === source && item.contextProbe?.length);
        if (options.parentDataChain && normalizeDataChain(options.parentDataChain) !== source && options.threadMode === "children") continue;
        const threadResult = applyThreadMode(rawBySource.get(source) || [], scoped, "", [], { ...options, query: undefined });
        selected.push(...threadResult.filtered.map(item => {
            if (!item.matchedChildConversationId || item.contextProbe?.length) return item;
            const child = scoped.find(candidate => candidate.id === item.matchedChildConversationId);
            return { ...item, contextProbe: child?.contextProbe?.map(note => `[child-hit:${child.id}] ${note}`) };
        }));
        if (threadResult.warnings.length) {
            const status = statuses.find(item => item.dataChain === source);
            if (status) { status.warnings = [...new Set([...(status.warnings || []), ...threadResult.warnings])]; status.partial = true; }
            partial = true;
        }
    }
    const matchCount = new Set(selected.map(item => `${item.dataChain}:${item.id}`)).size;
    contextLocate.truncated ||= partial;
    if (contextLocate.status !== "cancelled") {
        contextLocate.status = contextLocate.truncated ? contextLocate.hits.length ? "partial_found_scanning" : "budget_exhausted"
            : contextLocate.hits.length ? "found" : "no_hit_after_full_scan";
        contextLocate.reason = contextLocate.truncated ? "bounded_or_incomplete_source_scan" : undefined;
    }
    contextLocate.matchedConversationCount = matchCount;
    contextLocate.matchIdentityScope = "listed_threads";
    contextLocate.resolution = matchCount > 1 ? "ambiguous" : matchCount === 1 ? contextLocate.truncated ? "single_match_in_partial_scan" : "unique_in_scope" : contextLocate.truncated ? "unverified" : "no_match";
    const sourceLimit = Math.max(options.limit || 50, 1);
    return { candidates: selected.slice(0, sourceLimit), statuses, partial: partial || contextLocate.truncated || selected.length > sourceLimit, contextLocate };
}

export async function listConversationCandidates(options: ListConversationCandidatesOptions = {}): Promise<ListConversationCandidatesResult> {
    const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + (options.deadlineMs ?? 12_000));
    if (!options.adapters && !options.contextAdapters && !isIsolatedSourceWorker()) {
        const { adapters: _adapters, contextAdapters: _contextAdapters, isCancelled, signal, onCheckpoint: _onCheckpoint, ...payload } = options;
        let checkpoint: ListConversationCandidatesResult | undefined;
        try {
            return await runIsolatedSource<ListConversationCandidatesResult>("candidates", payload, { deadlineAt, isCancelled, signal,
                onCheckpoint: value => { checkpoint = value as ListConversationCandidatesResult; },
            }, { timeoutMs: Math.max(1, deadlineAt - Date.now()) });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "SOURCE_WORKER_DEADLINE" && !signal?.aborted && !isCancelled?.()) {
                return partialCandidateDeadlineResult(checkpoint, options);
            }
            throw error;
        }
    }
    const adapters = options.adapters || DEFAULT_ADAPTERS;
    const sources = normalizeConversationSources(options.dataChains);
    const normalizedQuery = normalizeConversationQuery(options.query);
    const queryTerms = splitConversationQueryTerms(options.query);
    const sourceLimit = Math.max(options.limit || 50, 1);
    const statuses = new Map<ConversationSource, SourceStatus>();
    const collected: UnifiedConversationCandidate[] = [];
    const rawBySource = new Map<ConversationSource, UnifiedConversationCandidate[]>();
    const completed = new Set<ConversationSource>();
    const located = new Map<ConversationSource, ConversationContextLocateResult>();
    let stopped = false;
    const callerCancelled = options.isCancelled;
    const signal = options.signal;
    options = { ...options, deadlineAt, isCancelled: () => Boolean(stopped || signal?.aborted || callerCancelled?.()) };
    const diagnosticsBySource = new Map<ConversationSource, ConversationDiscoveryDiagnostic[]>();
    let deferredDevinLookup: { parents: UnifiedConversationCandidate[]; options: ListConversationCandidatesOptions } | undefined;
    await options.onCheckpoint?.({ candidates: [], statuses: [], partial: true });

    const discoverSource = async (source: ConversationSource) => {
        if (options.isCancelled?.()) throw new Error("candidate discovery cancelled");
        if (Date.now() >= deadlineAt) throw new Error("candidate discovery deadline exceeded");
        if (options.threadMode === "children" && options.parentDataChain && normalizeDataChain(options.parentDataChain) !== source) return { source, filtered: [], warnings: [] };
        const fetchLimit = conversationSourceFetchLimit(source, sourceLimit, options);
        const diagnostics: ConversationDiscoveryDiagnostic[] = [];
        diagnosticsBySource.set(source, diagnostics);
        const metadataOptions = source === "windsurf" && adapters.windsurf.discoverChildren && options.threadMode === "children"
            && options.parentConversationId && !options.conversationIds?.length ? { ...options, conversationIds: [options.parentConversationId] } : options;
        const cacheListing = options.source === "cache" ? listCachedContextCandidates(source, fetchLimit, options) : undefined;
        const raw = cacheListing?.candidates || await listSourceCandidates(source, fetchLimit, adapters, source === "antigravity" && Boolean(options.workspaces?.length), metadataOptions, diagnostics);
        const warnings = [...(cacheListing?.warnings || []), ...diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`)];
        if (cacheListing?.partial && !warnings.length) warnings.push("cache_candidate_budget");
        if (raw.length >= fetchLimit && !options.conversationIds?.length) warnings.push("candidate_limit: source enumeration may be incomplete");
        const queryTargets = exactQueryTargets(raw, options);
        const queryChild = !options.conversationIds?.length && options.query?.trim() && splitDevinSubagentId(options.query.trim()) ? [options.query.trim()] : undefined;
        const targets = options.conversationIds?.length ? options.conversationIds : queryTargets || queryChild;
        const workspaceTargets = targets?.flatMap(id => [id, splitDevinSubagentId(id)?.parentId].filter((value): value is string => Boolean(value)));
        const workspaceCandidates = workspaceTargets ? raw.filter(candidate => workspaceTargets.some(id => candidateMatchesIdentity(candidate, id))) : raw;
        if (options.source !== "cache" && (options.source === "local" || (source === "windsurf" && options.conversationIds?.length)) && options.workspaces?.length) {
            const hasKnownScope = Boolean(options.contextProbe?.trim()) && workspaceCandidates.some(candidate => workspaceMatches(candidateWorkspacesForScope(candidate, options.workspaceScope || "any"), options.workspaces || [], options.workspaceMode || "any"));
            for (const candidate of workspaceCandidates) {
                if (candidate.workspace || candidate.workspaces?.length) continue;
                if (hasKnownScope) { warnings.push(`workspace_unknown_deferred:${candidate.id}`); continue; }
                if (Date.now() >= deadlineAt || options.isCancelled?.()) { warnings.push("workspace_probe_budget: unresolved local workspaces"); break; }
                try {
                    if (adapters.readWorkspace) candidate.workspace = await adapters.readWorkspace(candidate) || "";
                    else {
                        const { loadConversationData } = await import("./conversation-bridge.js");
                        const loaded = await loadConversationData(source, candidate.id, {
                            source: options.source || "auto", includeRounds: false, isCancelled: () => Boolean(options.isCancelled?.()) || Date.now() >= deadlineAt,
                            sourceReadBudget: { deadlineMs: deadlineAt, maxBytes: options.maxBytes, isCancelled: options.isCancelled },
                        });
                        candidate.workspace = loaded?.windsurfData?.thread.cwd || detectWorkspaceFromSteps(loaded?.trajectory?.steps || []) || "";
                        candidate.workspaces = loaded?.windsurfData?.thread.workspaceUris;
                    }
                    if (!candidate.workspace && !candidate.workspaces?.length) warnings.push(`workspace_unknown:${candidate.id}`);
                } catch (error) { warnings.push(`workspace_probe_failed:${candidate.id}:${String(error)}`); }
            }
        }
        const explicitMainTargets = Boolean(targets?.length && targets.every(id => !splitDevinSubagentId(id)));
        const explicitChildren = options.threadMode === "children" || options.threadMode === "all" || targets?.some(id => Boolean(splitDevinSubagentId(id)));
        if (source === "windsurf" && options.source !== "cache" && adapters.windsurf.discoverChildren && !explicitMainTargets
            && (explicitChildren || options.contextProbe?.trim() || options.query?.trim())) {
            let scopedParents = raw.filter(candidate => candidate.sourceKind?.startsWith("devin-") && !candidate.isChildThread)
                .filter(candidate => workspaceMatches(candidateWorkspacesForScope(candidate, options.workspaceScope || "any"), options.workspaces || [], options.workspaceMode || "any"));
            let childOptions = { ...options, conversationIds: targets };
            let parentResolved = true;
            if (options.threadMode === "children") {
                const resolved = resolveParentForChildrenMode(raw, normalizeConversationQuery(options.parentQuery), splitConversationQueryTerms(options.parentQuery), options);
                warnings.push(...resolved.warnings);
                parentResolved = Boolean(resolved.parentId);
                if (resolved.parentId) childOptions = { ...childOptions, parentConversationId: resolved.parentId };
            }
            if (childOptions.parentConversationId) {
                scopedParents = scopedParents.filter(candidate => candidateMatchesIdentity(candidate, childOptions.parentConversationId!));
                const knownParents = raw.filter(candidate => !candidate.isChildThread && candidateMatchesIdentity(candidate, childOptions.parentConversationId!));
                if (knownParents.length && knownParents.every(candidate => Boolean(candidate.workspace || candidate.workspaces?.length)
                    && !workspaceMatches(candidateWorkspacesForScope(candidate, options.workspaceScope || "any"), options.workspaces || [], options.workspaceMode || "any"))) parentResolved = false;
            }
            if (parentResolved && explicitChildren) {
                const children = await adapters.windsurf.discoverChildren(scopedParents, childOptions);
                appendDevinChildren(raw, children);
                warnings.push(...children.warnings);
            } else if (parentResolved && scopedParents.length) {
                if (options.contextProbe?.trim()) deferredDevinLookup = { parents: scopedParents, options: childOptions };
                else if (raw.some(candidate => candidateMatchesQuery(candidate, normalizedQuery, queryTerms)
                    && workspaceMatches(candidateWorkspacesForScope(candidate, options.workspaceScope || "any"), options.workspaces || [], options.workspaceMode || "any"))) {
                    warnings.push("devin_child_discovery_deferred: metadata matches returned before child enumeration");
                } else {
                    const children = await adapters.windsurf.discoverChildren(scopedParents, childOptions);
                    appendDevinChildren(raw, children);
                    warnings.push(...children.warnings);
                }
            }
        }
        if (Date.now() >= deadlineAt || options.isCancelled?.()) warnings.push("candidate_discovery_budget: deadline or cancellation reached");
        warnings.push(...raw.flatMap(candidateWarnings), ...raw.flatMap(candidate => candidate.discoveryWarnings || []));
        warnings.push(...raw.filter(item => item.sourcePartial).map(item => `partial_source:${item.id}`));
        rawBySource.set(source, raw);
        let filtered = raw
            .filter(item => !options.conversationIds?.length || options.conversationIds.some(id => item.id === id || item.aliases?.includes(id) || item.uuid === id || item.sessionId === id))
            .filter(item => !options.contextProbe?.trim() || !targets?.length || targets.some(id => candidateMatchesIdentity(item, id)))
            .filter(item => options.contextProbe?.trim() || candidateMatchesQuery(item, normalizedQuery, queryTerms))
            .filter(item => workspaceMatches(candidateWorkspacesForScope(item, options.workspaceScope || "any"), options.workspaces || [], options.workspaceMode || "any"))
            .sort((a, b) => {
                const queryPriority = candidateQueryPriority(a, normalizedQuery, queryTerms) - candidateQueryPriority(b, normalizedQuery, queryTerms);
                if (queryPriority !== 0) return queryPriority;
                return (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0);
            });
        if (!options.contextProbe?.trim() && (source === "codex" || source === "claude-code" || source === "windsurf" || source === "dsh")) {
            const result = applyThreadMode(raw, filtered, normalizedQuery, queryTerms, options);
            filtered = result.filtered;
            warnings.push(...result.warnings);
        }
        return { source, filtered, warnings };
    };

    const maximumFiles = locatePositiveInteger(options.candidateLimit, 50, 20_000);
    const maximumBytes = locatePositiveInteger(options.maxBytes, 16 * 1024 * 1024);
    const maximumHits = locatePositiveInteger(options.maxHits, Math.max(sourceLimit * 3, 20), 1000);
    const sharedBudget: ConversationContextLocateSharedBudget = {
        remainingFiles: maximumFiles, remainingBytes: maximumBytes, remainingHits: maximumHits,
        activeReads: 0, concurrency: sources.length,
    };
    const mergeLocations = (results: ConversationContextLocateResult[], incomplete = false): ConversationContextLocateResult => {
        const hits = results.flatMap(result => result.hits);
        const truncated = incomplete || results.some(result => result.truncated);
        const cancelled = results.some(result => result.status === "cancelled");
        const identities = new Set(hits.map(hit => `${hit.dataChain}:${hit.conversationId}`));
        return {
            status: cancelled ? "cancelled" : truncated ? hits.length ? "partial_found_scanning" : "budget_exhausted" : hits.length ? "found" : "no_hit_after_full_scan",
            scannedFiles: results.reduce((total, result) => total + result.scannedFiles, 0),
            totalFiles: results.reduce((total, result) => total + result.totalFiles, 0),
            scannedBytes: results.reduce((total, result) => total + result.scannedBytes, 0),
            totalBytes: results.reduce((total, result) => total + result.totalBytes, 0),
            hits, truncated, reason: cancelled ? "cancelled" : truncated ? "bounded_or_incomplete_source_scan" : undefined,
            warnings: [...new Set(results.flatMap(result => result.warnings))].slice(0, 20),
            resolution: contextLocateResolution(identities.size, truncated), matchedConversationCount: identities.size,
            matchIdentityScope: "provided_candidates", candidateFailures: results.flatMap(result => result.candidateFailures || []), scope: "provided_candidates",
        };
    };
    const snapshot = (): ListConversationCandidatesResult => {
        const sourceStatuses = sources.flatMap(source => statuses.has(source) ? [statuses.get(source)!] : []);
        const incomplete = completed.size < sources.length || sourceStatuses.some(status => status.status === "failed" || status.partial || status.warnings?.length);
        const candidates = [...collected].sort((first, second) => candidateQueryPriority(first, normalizedQuery) - candidateQueryPriority(second, normalizedQuery)
            || (Date.parse(second.updatedAt || "") || 0) - (Date.parse(first.updatedAt || "") || 0));
        if (!options.contextProbe?.trim()) return { candidates: candidates.slice(0, sourceLimit), statuses: sourceStatuses, partial: incomplete || candidates.length > sourceLimit };
        const contextLocate = mergeLocations(sources.flatMap(source => located.has(source) ? [located.get(source)!] : []), incomplete);
        for (const source of sources) if (!completed.has(source)) contextLocate.warnings.push(`source_pending:${source}: metadata or text verification is incomplete`);
        return locatedCandidateResult(candidates, rawBySource, sources, options, sourceStatuses, incomplete, contextLocate);
    };
    const publicationFailures = new Set<unknown>();
    const publish = async (): Promise<void> => {
        if (stopped) return;
        try { await options.onCheckpoint?.(snapshot()); }
        catch (error) { publicationFailures.add(error); throw error; }
    };
    const readers = options.contextProbe?.trim()
        ? options.contextAdapters || (await import("./conversation-context-locate-adapters.js")).defaultContextLocateAdapters : undefined;
    const scanSource = async (source: ConversationSource, candidates: UnifiedConversationCandidate[]): Promise<void> => {
        if (!readers) return;
        const boundContextBudget = (budget: ContextLocateReadBudget): ContextLocateReadBudget => {
            if (options.isCancelled?.() || Date.now() >= deadlineAt) throw new Error("context discovery deadline exceeded or cancelled");
            return { ...budget, deadlineAt: Math.min(budget.deadlineAt, deadlineAt),
                isCancelled: () => Boolean(options.isCancelled?.()) };
        };
        const contextAdapters: ConversationContextLocateAdapters = {
            readRounds: (candidate, budget) => readers.readRounds(candidate, boundContextBudget(budget)),
            scanStream: readers.scanStream ? (candidate, query, budget) => readers.scanStream!(candidate, query, boundContextBudget(budget)) : undefined,
        };
        const contextLocate = await locateConversationContext(candidates, options.contextProbe!, {
            probe: true, source: options.source, maxFiles: maximumFiles,
            maxBytes: maximumBytes, maxHits: maximumHits,
            deadlineMs: Math.max(1, deadlineAt - Date.now()), isCancelled: options.isCancelled,
            candidatesPartial: Boolean(statuses.get(source)?.partial), adapters: contextAdapters, sharedBudget,
            reserveFollowup: source === "windsurf" && Boolean(deferredDevinLookup) && maximumFiles > 1,
            onCheckpoint: async result => { if (!stopped) { located.set(source, result); await publish(); } },
        });
        if (stopped) return;
        located.set(source, contextLocate);
        if (source === "windsurf" && deferredDevinLookup) {
            const sourceStatus = statuses.get(source);
            const childWarnings: string[] = [];
            const remainingFiles = sharedBudget.remainingFiles;
            const remainingBytes = sharedBudget.remainingBytes;
            const remainingHits = sharedBudget.remainingHits;
            const exhaustedParents = new Set(contextLocate.warnings.flatMap(warning => {
                const match = /^devin_context_source_budget:(.*):DEVIN_(?:BYTE_BUDGET|NODE_BUDGET)$/u.exec(warning);
                return match ? [match[1]!] : [];
            }));
            const childParents = deferredDevinLookup.parents.filter(parent => !exhaustedParents.has(parent.id));
            if (contextLocate.hits.some(hit => hit.dataChain === "windsurf")) {
                childWarnings.push("devin_child_discovery_deferred: context matches returned before child enumeration");
            } else if (!childParents.length || options.isCancelled?.() || Date.now() >= deadlineAt || remainingFiles <= 0 || remainingBytes <= 0 || remainingHits <= 0) {
                childWarnings.push("devin_child_discovery_deferred: context discovery budget exhausted");
            } else {
                try {
                    if (exhaustedParents.size) childWarnings.push("devin_child_discovery_deferred: parents that exhausted physical source budgets were not read again");
                    const children = await adapters.windsurf.discoverChildren!(childParents, {
                        ...deferredDevinLookup.options, maxBytes: undefined,
                    });
                    if (stopped) return;
                    const raw = rawBySource.get("windsurf") || [];
                    appendDevinChildren(raw, children);
                    childWarnings.push(...children.warnings);
                    const added = children.candidates.filter(candidate => !collected.some(existing => existing.dataChain === candidate.dataChain && existing.id === candidate.id))
                        .filter(candidate => workspaceMatches(candidateWorkspacesForScope(candidate, options.workspaceScope || "any"), options.workspaces || [], options.workspaceMode || "any"));
                    collected.push(...added);
                    const childLocate = await locateConversationContext(added, options.contextProbe!, {
                        probe: true, source: options.source, maxFiles: remainingFiles, maxBytes: remainingBytes, maxHits: remainingHits,
                        deadlineMs: Math.max(1, deadlineAt - Date.now()), isCancelled: options.isCancelled,
                        candidatesPartial: Boolean(sourceStatus?.partial) || childWarnings.length > 0, adapters: contextAdapters, sharedBudget,
                        onCheckpoint: async result => { if (!stopped) { located.set(source, mergeLocations([contextLocate, result])); await publish(); } },
                    });
                    if (stopped) return;
                    Object.assign(contextLocate, mergeLocations([contextLocate, childLocate]));
                    if (sourceStatus) sourceStatus.count += added.length;
                } catch (error) {
                    childWarnings.push(`devin_child_discovery_failed:${String(error)}`);
                }
            }
            if (childWarnings.length) {
                contextLocate.truncated = true;
                contextLocate.warnings = [...new Set([...contextLocate.warnings, ...childWarnings])].slice(0, 20);
                if (sourceStatus) {
                    sourceStatus.partial = true;
                    sourceStatus.warnings = [...(sourceStatus.warnings || []), ...childWarnings];
                }
            }
        }
        located.set(source, contextLocate);
    };
    let poll: ReturnType<typeof setInterval> | undefined;
    const interrupted = new Promise<"deadline" | "cancelled">(resolve => {
        const check = (): void => {
            if (signal?.aborted || callerCancelled?.()) resolve("cancelled");
            else if (Date.now() >= deadlineAt) resolve("deadline");
        };
        poll = setInterval(check, 10);
        check();
    });
    try {
        const jobs = sources.map(async source => {
            try {
                const result = await discoverSource(source);
                if (stopped) return;
                const diagnostics = diagnosticsBySource.get(source);
                statuses.set(source, { dataChain: source, status: "ok", count: result.filtered.length,
                    warnings: result.warnings.length ? result.warnings : undefined, partial: result.warnings.length > 0 || undefined,
                    diagnostics: diagnostics?.length ? diagnostics : undefined });
                collected.push(...result.filtered);
                await publish();
                if (stopped) return;
                await scanSource(source, result.filtered);
                if (stopped) return;
                completed.add(source);
                await publish();
            } catch (error) {
                if (publicationFailures.has(error)) throw error;
                if (stopped) return;
                statuses.set(source, { dataChain: source, status: "failed", count: statuses.get(source)?.count || 0,
                    error: error instanceof Error ? error.message : String(error), partial: true, diagnostics: diagnosticsBySource.get(source) });
                completed.add(source);
                await publish();
            }
        });
        const outcome = await Promise.race([Promise.all(jobs).then(() => "complete" as const), interrupted]);
        if (outcome === "cancelled" || signal?.aborted || callerCancelled?.()) {
            throw Object.assign(new Error("History source reading was cancelled"), { name: "AbortError", code: "SOURCE_WORKER_CANCELLED" });
        }
        const result = snapshot();
        return outcome === "deadline" ? partialCandidateDeadlineResult(result, options) : result;
    } finally {
        stopped = true;
        if (poll) clearInterval(poll);
    }
}

async function resolveIdInSource(
    source: ConversationSource,
    conversationId: string,
    adapters: ConversationSourceAdapters,
): Promise<ConversationIdHit | null> {
    if (source === "codex") {
        const thread = await adapters.codex.get(conversationId);
        return thread ? { dataChain: "codex", conversationId: thread.id, title: thread.title, workspace: thread.cwd } : null;
    }
    if (source === "claude-code") {
        const thread = await adapters["claude-code"].get(conversationId);
        return thread ? { dataChain: "claude-code", conversationId: thread.id, title: thread.title, workspace: thread.cwd } : null;
    }
    if (source === "windsurf") {
        const resolved = await adapters.windsurf.resolve(conversationId);
        return resolved ? { dataChain: "windsurf", conversationId: resolved } : null;
    }
    if (source === "dsh") {
        const snapshot = await (adapters.dsh || DEFAULT_ADAPTERS.dsh)!.get(conversationId);
        return snapshot
            ? {
                dataChain: "dsh",
                conversationId: snapshot.id,
                title: typeof snapshot.header.title === "string" ? snapshot.header.title : snapshot.id,
                workspace: typeof snapshot.header.cwd === "string" ? snapshot.header.cwd : "",
            }
            : null;
    }
    const query = conversationId.trim().toLowerCase();
    const rows = await adapters.antigravity.list(1000);
    const hit = rows.find(item => item.id.toLowerCase() === query)
        || (query.length >= 8 ? rows.find(item => item.id.toLowerCase().startsWith(query)) : undefined);
    return hit ? { dataChain: "antigravity", conversationId: hit.id, title: hit.title } : null;
}

export async function resolveConversationIdAcrossSources(
    conversationId: string,
    options: ResolveConversationIdAcrossSourcesOptions = {},
): Promise<ResolveConversationIdAcrossSourcesResult> {
    const adapters = options.adapters || DEFAULT_ADAPTERS;
    const sources = normalizeConversationSources(options.dataChains);
    const statuses: SourceStatus[] = [];
    const hits: ConversationIdHit[] = [];
    const settled = await Promise.allSettled(sources.map(async source => {
        const hit = await resolveIdInSource(source, conversationId, adapters);
        return { source, hit };
    }));

    for (const [idx, item] of settled.entries()) {
        const source = sources[idx];
        if (item.status === "fulfilled") {
            statuses.push({ dataChain: source, status: "ok", count: item.value.hit ? 1 : 0 });
            if (item.value.hit) hits.push(item.value.hit);
        } else {
            const error = item.reason instanceof Error ? item.reason.message : String(item.reason);
            statuses.push({ dataChain: source, status: "failed", count: 0, error });
        }
    }

    return { hits, statuses };
}

export function formatSourceStatuses(statuses: SourceStatus[]): string[] {
    return statuses.map(item => {
        const warning = item.warnings?.length ? ` | warnings: ${item.warnings.slice(0, 3).join("；")}` : "";
        return item.status === "ok"
            ? `- ${item.dataChain}: ok (${item.count})${warning}`
            : `- ${item.dataChain}: failed — ${item.error || "unknown"}${warning}`;
    });
}
