import type { CorpusSource } from "./conversation-corpus-sources.js";
import type { CorpusConversation, CorpusFastReadRequest, CorpusMessageRole, CorpusProjection, CorpusRangeProvider, CorpusReadControl, CorpusSearchRequest, CorpusSourceStatus, CorpusVerifiedIdentity } from "./conversation-corpus-types.js";
import { canIsolateSourceOptions, isIsolatedSourceWorker, runIsolatedSource } from "./conversation-isolated-source.js";
import { assertHostReadActive, HOST_CORPUS_VERSION, hostConversationMatches, projectHostCorpus, validateHostRange, type HostCorpusSnapshot } from "./conversation-host-projection.js";
import type { ClaudeCodeThreadInfo } from "./claude-code-client.js";
import type { DshReaderOptions } from "./dsh-session-reader.js";
import type { LocalPbFileCandidate, LocalPbReaderOptions } from "./local-pb-reader.js";
import type { DevinReadOptions } from "./devin-types.js";
import { rememberHostCorpusProjection, readHostCorpusSnapshot, selectHostCorpusProjectionRoles } from "./conversation-corpus-host-snapshot.js";

export type HostCorpusSource = Exclude<CorpusSource, "codex">;

export interface HostCorpusBackend {
    list(request: CorpusSearchRequest, control: CorpusReadControl): Promise<CorpusConversation[]>;
    read(conversation: CorpusConversation, request: CorpusFastReadRequest | undefined, control: CorpusReadControl): Promise<HostCorpusSnapshot>;
    readCached?(conversation: CorpusConversation, control: CorpusReadControl): Promise<HostCorpusSnapshot | null>;
    sourceStatuses?(): CorpusSourceStatus[];
}

export interface HostCorpusReaderOptions {
    cacheRoot?: string;
    cacheMaxBytes?: number;
    listLimit?: number;
    backend?: HostCorpusBackend;
    claudeThreads?: () => Promise<ClaudeCodeThreadInfo[]> | ClaudeCodeThreadInfo[];
    dshOptions?: DshReaderOptions;
    maxSourceBytes?: number;
    pbCandidates?: (source: "windsurf" | "antigravity", id: string) => LocalPbFileCandidate[];
    pbReaderOptions?: Omit<LocalPbReaderOptions, "sourceFlavor">;
    devinOptions?: DevinReadOptions;
}

function defaultBackend(source: HostCorpusSource, options: HostCorpusReaderOptions): HostCorpusBackend {
    let statuses: CorpusSourceStatus[] = [];
    let logBackend: HostCorpusBackend | undefined;
    const logs = source === "claude-code" || source === "dsh" ? import("./conversation-host-logs.js").then(module => logBackend = module.createLogHostBackend(source, options)) : undefined;
    const binary = source === "windsurf" || source === "antigravity" ? import("./conversation-host-binary.js").then(module => module.createBinaryHostReader(source, options)) : undefined;
    return {
        sourceStatuses: () => logBackend?.sourceStatuses?.() || statuses,
        async list(request, control) {
            if (logs) return (await logs).list(request, control);
            const { listBinaryHostConversations } = await import("./conversation-host-binary.js");
            const result = await listBinaryHostConversations(source as "windsurf" | "antigravity", request, control, options);
            statuses = result.statuses;
            return result.conversations;
        },
        async read(conversation, request, control) {
            if (logs) return (await logs).read(conversation, request, control);
            return (await binary!).read(conversation, request, control);
        },
        async readCached(conversation, control) {
            return logs ? (await logs).readCached?.(conversation, control) || null : null;
        },
    };
}

export function createHostCorpusProvider(source: HostCorpusSource, options: HostCorpusReaderOptions = {}): CorpusRangeProvider {
    if (!["claude-code", "windsurf", "antigravity", "dsh"].includes(source)) throw new Error("Host corpus provider requires an explicit non-Codex source");
    const backend = options.backend || defaultBackend(source, options);
    const isolated = !isIsolatedSourceWorker() && canIsolateSourceOptions(options);
    const canonicalRounds = source === "dsh" || source === "claude-code" || source === "windsurf";
    let statuses: CorpusSourceStatus[] = [];
    const assertActive = (control: CorpusReadControl) => {
        assertHostReadActive(control);
        if (control.deadlineAt !== undefined && Date.now() >= control.deadlineAt) {
            throw Object.assign(new Error("Host conversation source reading deadline exceeded"), { name: "TimeoutError" });
        }
    };
    const assertSource = (conversation: CorpusConversation, control: CorpusReadControl) => {
        assertActive(control);
        if (conversation.source !== source) throw new Error(`Provider ${source} cannot read ${conversation.source}`);
    };
    const remember = async (projection: CorpusProjection, control: CorpusReadControl): Promise<CorpusProjection> => {
        const completeRoles = ["user", "assistant", "tool", "subagent"].every(role => control.messageRoles?.includes(role as CorpusMessageRole));
        await rememberHostCorpusProjection(projection, control, { ...options, canonicalRounds: canonicalRounds && (source !== "windsurf" || completeRoles) });
        assertActive(control);
        return projection;
    };
    const read = async (conversation: CorpusConversation, request: CorpusFastReadRequest | undefined, control: CorpusReadControl): Promise<CorpusProjection> => {
        assertSource(conversation, control);
        if (request) validateHostRange(request);
        const requestedRoles = request?.messageRoles ?? control.messageRoles;
        const snapshotRoles: CorpusMessageRole[] = ["user", "assistant", "tool", "subagent"];
        const snapshotControl = source === "windsurf" && !request ? { ...control, messageRoles: snapshotRoles } : control;
        const snapshotRequest = request;
        if (isolated) {
            const result = await runIsolatedSource<{ projection: CorpusProjection; identity?: CorpusVerifiedIdentity }>("host-read",
                { source, options, conversation, request: snapshotRequest, messageRoles: snapshotControl.messageRoles, forceRefresh: control.forceRefresh }, control,
                { timeoutMs: request ? 30_000 : 120_000 });
            const { restoreIsolatedCorpusIdentity } = await import("./conversation-host-binary.js");
            restoreIsolatedCorpusIdentity(result.projection.conversation, result.identity);
            const projection = source === "windsurf" ? selectHostCorpusProjectionRoles(result.projection, requestedRoles) : result.projection;
            if (!request && control.onChunk) await control.onChunk({ ...projection, verified: !projection.partial });
            assertActive(control);
            await remember(result.projection, snapshotControl);
            return projection;
        }
        const snapshot = await backend.read(conversation, snapshotRequest, snapshotControl);
        assertActive(control);
        const storedProjection = projectHostCorpus(conversation, snapshot, snapshotRequest, snapshotControl);
        const projection = source === "windsurf" ? selectHostCorpusProjectionRoles(storedProjection, requestedRoles) : storedProjection;
        if (!request && control.onChunk) await control.onChunk({
            conversation: projection.conversation, revision: projection.revision, messages: projection.messages,
            rounds: projection.rounds, roundNumbering: projection.roundNumbering, warnings: projection.warnings,
            sourceBytes: projection.sourceBytes, verified: !snapshot.partial,
        });
        assertActive(control);
        await remember(storedProjection, snapshotControl);
        return projection;
    };
    return {
        semanticVersion: `${HOST_CORPUS_VERSION}/${source}${source === "windsurf" ? "/role-snapshot-v2" : ""}`,
        sourceStatuses: () => { const current = backend.sourceStatuses?.(); return current?.length ? current : statuses; },
        async list(request, control) {
            assertActive(control);
            try {
                if (isolated) {
                    const result = await runIsolatedSource<{ candidates: CorpusConversation[]; statuses: CorpusSourceStatus[] }>("host-list", { source, options, request }, control, { timeoutMs: 12_000 });
                    statuses = result.statuses;
                    return result.candidates;
                }
                let listed = await backend.list(request, control);
                if (source === "windsurf" && request.conversationIds?.length && !listed.length) {
                    assertActive(control);
                    listed = await backend.list(request, control);
                }
                const candidates = listed.filter(conversation => {
                    if (conversation.source !== source) throw new Error(`Unexpected ${conversation.source} candidate from ${source}`);
                    return hostConversationMatches(conversation, request);
                });
                assertActive(control);
                statuses = [{ source, status: "ok", candidateCount: candidates.length, warnings: [] }];
                return candidates;
            } catch (error) {
                statuses = [{ source, status: "error", candidateCount: 0, warnings: [], error: error instanceof Error ? error.message : String(error) }];
                throw error;
            }
        },
        async readCached(conversation, control) {
            assertSource(conversation, control);
            const snapshotControl = source === "windsurf"
                ? { ...control, messageRoles: ["user", "assistant", "tool", "subagent"] as CorpusMessageRole[] } : control;
            if (isolated) {
                const result = await runIsolatedSource<{ projection: CorpusProjection | null; identity?: CorpusVerifiedIdentity }>("host-cached", { source, options, conversation, messageRoles: snapshotControl.messageRoles, forceRefresh: control.forceRefresh }, control);
                if (result.projection) {
                    const { restoreIsolatedCorpusIdentity } = await import("./conversation-host-binary.js");
                    restoreIsolatedCorpusIdentity(result.projection.conversation, result.identity);
                }
                if (!result.projection) return null;
                await remember(result.projection, snapshotControl);
                return source === "windsurf" ? selectHostCorpusProjectionRoles(result.projection, control.messageRoles) : result.projection;
            }
            const cached = await backend.readCached?.(conversation, snapshotControl);
            if (!cached) return null;
            const projection = projectHostCorpus(conversation, cached, undefined, snapshotControl);
            await remember(projection, snapshotControl);
            return source === "windsurf" ? selectHostCorpusProjectionRoles(projection, control.messageRoles) : projection;
        },
        read: (conversation, control) => read(conversation, undefined, control),
        readFast: (conversation, request, control = {}) => read(conversation, request, control),
        async readRounds(conversation, request, control = {}) {
            assertSource(conversation, control);
            const snapshot = await readHostCorpusSnapshot(conversation, request, control, { ...options, canonicalRounds });
            assertActive(control);
            if (snapshot) return snapshot;
            const { revision, messageRoles, ...range } = request;
            const projection = await read(conversation, range, { ...control, messageRoles: messageRoles ?? control.messageRoles });
            if (!revision || projection.revision !== revision) throw new Error(`${source} source revision changed; run a fresh search before expanding the hit`);
            return projection;
        },
    };
}

export const hostCorpusProviders = {
    "claude-code": createHostCorpusProvider("claude-code"),
    windsurf: createHostCorpusProvider("windsurf"),
    antigravity: createHostCorpusProvider("antigravity"),
    dsh: createHostCorpusProvider("dsh"),
};
