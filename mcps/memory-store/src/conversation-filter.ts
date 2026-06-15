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
    type ClaudeCodeThreadInfo,
} from "./claude-code-client.js";
import {
    detectWorkspaceFromSteps,
    fetchFirstPageSteps,
    listConversationsByMtime,
} from "./ls-client.js";
import {
    listRecentWindsurfThreads,
    resolveWindsurfThreadId,
    type WindsurfConversationSummary,
} from "./windsurf-client.js";
import { canonicalWorkspacePath } from "./store.js";

export type ConversationSource = Exclude<DataChain, "auto">;
export type WorkspaceMatchMode = "contains" | "exact" | "under" | "any" | "all";
export type WorkspaceMatchScope = "any" | "primary";
export type SourceFailureMode = "warn" | "fail";
export type IdResolutionMode = "unique" | "priority";
export type ConversationThreadMode = "main" | "children" | "all";

export interface UnifiedConversationCandidate {
    id: string;
    dataChain: ConversationSource;
    title: string;
    workspace: string;
    workspaces?: string[];
    updatedAt: string;
    detail: string;
    contextProbe?: string[];
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
}

export interface ListConversationCandidatesResult {
    candidates: UnifiedConversationCandidate[];
    statuses: SourceStatus[];
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
    };
    antigravity: {
        list(limit: number): Promise<Array<{ id: string; title?: string; mtime: Date; sizeKB?: number }>> | Array<{ id: string; title?: string; mtime: Date; sizeKB?: number }>;
    };
    windsurf: {
        list(limit: number): Promise<WindsurfConversationSummary[]> | WindsurfConversationSummary[];
        resolve(id: string): Promise<string | null> | string | null;
    };
}

const DEFAULT_SOURCE_ORDER: ConversationSource[] = ["codex", "antigravity", "claude-code", "windsurf"];

const DEFAULT_ADAPTERS: ConversationSourceAdapters = {
    codex: {
        list: limit => listCodexThreadsForMetadata(limit),
        get: id => getCodexThread(id),
    },
    "claude-code": {
        list: limit => listRecentClaudeCodeThreads(limit),
        get: id => getClaudeCodeThread(id),
    },
    antigravity: {
        list: limit => listConversationsByMtime({ limit }),
    },
    windsurf: {
        list: limit => listRecentWindsurfThreads(limit),
        resolve: id => resolveWindsurfThreadId(id),
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
    return {
        id: item.id,
        dataChain: "claude-code",
        title: item.title || "",
        workspace: item.cwd || "",
        updatedAt: isoFromMs(item.updatedAtMs || undefined),
        detail: [
            "claude-code",
            item.accountId ? `account=${item.accountId}` : "",
            item.organizationId ? `org=${item.organizationId}` : "",
            item.isArchived === true ? "archived" : "",
            item.desktopIndexPath ? "desktop-index" : "",
            item.model,
            item.entrypoint,
        ].filter(Boolean).join(" / "),
    };
}

function candidateFromWindsurfThread(item: WindsurfConversationSummary): UnifiedConversationCandidate {
    return {
        id: item.id,
        dataChain: "windsurf",
        title: item.title || item.summary || "",
        workspace: item.cwd || "",
        workspaces: item.workspaceUris,
        updatedAt: item.lastModifiedTime || item.createdTime || "",
        detail: [
            "windsurf",
            item.titleSource === "renamedTitle" ? "title=renamedTitle" : "",
            item.workspaceUris?.length ? `workspaces=${item.workspaceUris.length}` : "",
            item.referencedFiles?.length ? `referencedFiles=${item.referencedFiles.length}` : "",
            item.status,
            item.stepCount ? `${item.stepCount} steps` : "",
            item.lastGeneratorModelUid,
        ].filter(Boolean).join(" / "),
    };
}

function candidateSearchHaystack(item: UnifiedConversationCandidate): string {
    return normalizeConversationQuery([
        item.id,
        item.title,
        item.workspace,
        ...(item.workspaces || []),
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
    const agent = normalizeConversationQuery([item.agentRole || "", item.agentNickname || ""].join("\n"));
    const haystack = [id, title, workspace, workspaces, agent].join("\n");
    if (id === normalizedQuery) return 0;
    if (normalizedQuery.length >= 8 && id.startsWith(normalizedQuery)) return 1;
    if (title === normalizedQuery) return 2;
    if (title.includes(normalizedQuery)) return 3;
    if (workspace.includes(normalizedQuery)) return 4;
    if (fieldIncludesAny(title, queryTerms)) return 5;
    if (fieldIncludesAny(workspace, queryTerms) || fieldIncludesAny(workspaces, queryTerms)) return 6;
    if (fieldIncludesAny(agent, queryTerms)) return 7;
    if (queryTermsMatch(haystack, queryTerms)) return 8;
    return 9;
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
): Promise<UnifiedConversationCandidate[]> {
    if (source === "codex") {
        const parentMap = readCodexThreadParentMap();
        return (await adapters.codex.list(limit)).map(item => candidateFromCodexThread(item, parentMap));
    }
    if (source === "claude-code") {
        return (await adapters["claude-code"].list(limit)).map(candidateFromClaudeCodeThread);
    }
    if (source === "windsurf") {
        return (await adapters.windsurf.list(limit)).map(candidateFromWindsurfThread);
    }
    const rows = await adapters.antigravity.list(limit);
    const candidates = rows.map(item => ({
        id: item.id,
        dataChain: "antigravity",
        title: item.title || "",
        workspace: "",
        updatedAt: item.mtime.toISOString(),
        detail: `${(item.sizeKB || 0).toFixed(1)} KB`,
    } satisfies UnifiedConversationCandidate));
    if (!probeWorkspace) return candidates;
    const probeLimit = Math.min(candidates.length, Math.max(Number(process.env.MEMORY_STORE_CONVERSATION_ANTIGRAVITY_WORKSPACE_PROBE_LIMIT || 12), 0));
    const timeoutMs = Math.max(Number(process.env.MEMORY_STORE_CONVERSATION_ANTIGRAVITY_WORKSPACE_PROBE_TIMEOUT_MS || 2500), 100);
    await Promise.all(candidates.slice(0, probeLimit).map(async candidate => {
        try {
            const steps = await withTimeout(fetchFirstPageSteps(candidate.id), timeoutMs);
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
    const baseLimit = Math.max(sourceLimit * 3, 50);
    if (source !== "codex") return baseLimit;
    const needsMetadataLocate = Boolean(
        options.query?.trim()
        || options.workspaces?.length
        || options.parentConversationId?.trim()
        || options.parentQuery?.trim()
        || options.threadMode === "children"
        || options.threadMode === "all"
    );
    if (!needsMetadataLocate) return baseLimit;
    return Math.max(baseLimit, Number(process.env.MEMORY_STORE_CODEX_METADATA_THREAD_LIMIT || 20_000));
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
        return { parentId: options.parentConversationId.trim(), warnings: [] };
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

function applyCodexThreadMode(
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
            filtered: raw
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

export async function listConversationCandidates(options: ListConversationCandidatesOptions = {}): Promise<ListConversationCandidatesResult> {
    const adapters = options.adapters || DEFAULT_ADAPTERS;
    const sources = normalizeConversationSources(options.dataChains);
    const normalizedQuery = normalizeConversationQuery(options.query);
    const queryTerms = splitConversationQueryTerms(options.query);
    const sourceLimit = Math.max(options.limit || 50, 1);
    const statuses: SourceStatus[] = [];
    const collected: UnifiedConversationCandidate[] = [];

    const settled = await Promise.allSettled(sources.map(async source => {
        const raw = await listSourceCandidates(source, conversationSourceFetchLimit(source, sourceLimit, options), adapters, source === "antigravity" && Boolean(options.workspaces?.length));
        const warnings = raw.flatMap(candidateWarnings);
        let filtered = raw
            .filter(item => candidateMatchesQuery(item, normalizedQuery, queryTerms))
            .filter(item => workspaceMatches(candidateWorkspacesForScope(item, options.workspaceScope || "any"), options.workspaces || [], options.workspaceMode || "any"))
            .sort((a, b) => {
                const queryPriority = candidateQueryPriority(a, normalizedQuery, queryTerms) - candidateQueryPriority(b, normalizedQuery, queryTerms);
                if (queryPriority !== 0) return queryPriority;
                return (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0);
            });
        if (source === "codex") {
            const result = applyCodexThreadMode(raw, filtered, normalizedQuery, queryTerms, options);
            filtered = result.filtered;
            warnings.push(...result.warnings);
        }
        return { source, filtered, warnings };
    }));

    for (const [idx, item] of settled.entries()) {
        const source = sources[idx];
        if (item.status === "fulfilled") {
            statuses.push({ dataChain: source, status: "ok", count: item.value.filtered.length, warnings: item.value.warnings.length ? item.value.warnings : undefined });
            collected.push(...item.value.filtered);
        } else {
            const error = item.reason instanceof Error ? item.reason.message : String(item.reason);
            statuses.push({ dataChain: source, status: "failed", count: 0, error });
        }
    }

    collected.sort((a, b) => {
        const queryPriority = candidateQueryPriority(a, normalizedQuery) - candidateQueryPriority(b, normalizedQuery);
        if (queryPriority !== 0) return queryPriority;
        return (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0);
    });

    return { candidates: collected.slice(0, sourceLimit), statuses };
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
