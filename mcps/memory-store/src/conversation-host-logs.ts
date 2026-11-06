import path from "node:path";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { discoverClaudeCodeThreads, readClaudeCodeRoundTail, readClaudeCodeWindowText, type ClaudeCodeRoundTailCheckpoint, type ClaudeCodeThreadInfo } from "./claude-code-client.js";
import { discoverDshSessionSources, readDshSessionIncremental, readDshSessionColdWindow, type DshReaderOptions, type DshSessionCheckpoint, type DshSessionEvent, type DshSessionSource } from "./dsh-session-reader.js";
import { normalizeDshSessionEvents, DSH_NORMALIZATION_VERSION } from "./dsh-client.js";
import { mergeConsecutiveHumanRounds, type ConversationRound } from "./trajectory.js";
import { DATA_ROOT } from "./store.js";
import { assertHostReadActive, hostConversationMatches, hostCorpusDigest, type HostCorpusSnapshot } from "./conversation-host-projection.js";
import { assertHostFileUnchanged, captureHostFile, readHostCache, readHostTextWindow, writeHostCache, type HostFileRevision } from "./conversation-host-files.js";
import type { HostCorpusBackend, HostCorpusReaderOptions } from "./conversation-corpus-reader-hosts.js";
import type { CorpusConversation, CorpusFastReadRequest, CorpusReadControl, CorpusSourceStatus } from "./conversation-corpus-types.js";

export interface HostLogReaderOptions extends HostCorpusReaderOptions {
    claudeThreads?: () => Promise<ClaudeCodeThreadInfo[]> | ClaudeCodeThreadInfo[];
    dshOptions?: DshReaderOptions;
    maxSourceBytes?: number;
}

interface LogCache {
    version: "host-log/v2";
    source: "claude-code" | "dsh";
    id: string;
    revision: HostFileRevision;
    rounds: ConversationRound[];
    rawRounds?: ConversationRound[];
    claudeCheckpoint?: ClaudeCodeRoundTailCheckpoint;
    dshCheckpoint?: DshSessionCheckpoint;
    events?: DshSessionEvent[];
    warnings: string[];
    partial: boolean;
}

function claudeConversation(thread: ClaudeCodeThreadInfo): CorpusConversation {
    return {
        source: "claude-code", id: thread.id, canonicalId: thread.id, title: thread.title || thread.id,
        workspace: thread.cwd, rolloutPath: thread.jsonlPath, sourceKind: thread.desktopIndexPath ? "claude-desktop-jsonl" : "claude-code-jsonl",
        updatedAt: thread.updatedAtMs ? new Date(thread.updatedAtMs).toISOString() : undefined,
        archived: thread.isArchived || undefined, isChildThread: thread.isChildThread,
        parentConversationId: thread.parentConversationId || undefined, agentRole: thread.agentRole || undefined, agentNickname: thread.agentNickname || undefined,
    };
}

function dshConversation(source: DshSessionSource): CorpusConversation {
    const header = source.header;
    const parent = typeof header.parentSession === "string" ? header.parentSession : undefined;
    return {
        source: "dsh", id: source.id, canonicalId: source.id, title: typeof header.title === "string" ? header.title : source.id,
        workspace: typeof header.cwd === "string" ? header.cwd : typeof header.workspace === "string" ? header.workspace : source.provenance.projectDirectory,
        rolloutPath: source.provenance.sourcePath, sourceKind: `dsh-${source.provenance.format}`,
        updatedAt: new Date(source.provenance.sourceMtimeMs).toISOString(), parentConversationId: parent,
        isChildThread: Boolean(parent), agentRole: typeof header.origin === "string" ? header.origin : undefined,
    };
}

export function createLogHostBackend(source: "claude-code" | "dsh", options: HostLogReaderOptions = {}): HostCorpusBackend {
    const root = options.cacheRoot || path.join(DATA_ROOT, "conversation-corpus", "hosts", source);
    const maxCacheBytes = options.cacheMaxBytes ?? 64 * 1024 * 1024;
    const maxSourceBytes = options.maxSourceBytes ?? 256 * 1024 * 1024;
    let statuses: CorpusSourceStatus[] = [];
    let dshSources: DshSessionSource[] = [];
    const claudeThreads = new Map<string, ClaudeCodeThreadInfo>();
    const cacheFile = (id: string) => path.join(root, `${hostCorpusDigest([source, id])}.json`);
    const loadCache = async (id: string) => {
        const cached = await readHostCache<LogCache>(cacheFile(id), maxCacheBytes);
        return cached?.version === "host-log/v2" && cached.source === source && cached.id === id && Array.isArray(cached.rounds) && Array.isArray(cached.warnings) ? cached : null;
    };
    const windowBytes = 4 * 1024 * 1024;
    const readWindow = async (conversation: CorpusConversation, request: CorpusFastReadRequest, control: CorpusReadControl, filePath: string, dshSource?: DshSessionSource): Promise<HostCorpusSnapshot | null> => {
        const started = performance.now();
        const id = conversation.canonicalId || conversation.id;
        const direction = request.lastRounds !== undefined || request.startRound === undefined && request.endRound === undefined ? "tail" : "head";
        const revision = await captureHostFile(filePath, { verifyUtf8: !dshSource || dshSource.provenance.format === "jsonl", isCancelled: control.isCancelled,
            onProgress: (bytes, totalBytes) => control.onProgress?.({ phase: `${source}-window-source-verification`, bytes, totalBytes }) });
        if (dshSource && (revision.size !== dshSource.provenance.sourceSizeBytes || revision.mtimeMs !== dshSource.provenance.sourceMtimeMs)) throw new Error("DSH source changed after metadata discovery");
        if (revision.size > maxSourceBytes) throw new Error(`${source} source exceeds maxSourceBytes; use a larger explicit reader budget`);
        const verifiedAt = performance.now();
        const windowFile = path.join(root, `${hostCorpusDigest([source, id, request, "cold-window/v1"])}.window.json`);
        const cached = control.forceRefresh ? null : await readHostCache<{ sha256: string; path: string; snapshot: HostCorpusSnapshot }>(windowFile, maxCacheBytes);
        if (cached?.sha256 === revision.sha256 && cached.path === revision.path) {
            await assertHostFileUnchanged(revision, control.isCancelled);
            return { ...cached.snapshot, timings: { ...cached.snapshot.timings, totalMs: performance.now() - started, verificationMs: verifiedAt - started,
                verificationBytes: revision.size, knownSourceReadBytes: revision.size, parsedBytes: 0, decodedBytes: 0, cacheHit: 1 } };
        }
        let rounds: ConversationRound[];
        let prefixOmitted: boolean;
        let suffixOmitted: boolean;
        let parsedBytes: number;
        let decodedBytes: number;
        let readBytes: number;
        const warnings: string[] = [];
        if (dshSource) {
            const window = await readDshSessionColdWindow(dshSource, revision, direction, windowBytes, { ...options.dshOptions,
                maxDecompressedBytes: options.dshOptions?.maxDecompressedBytes ?? maxSourceBytes, isCancelled: control.isCancelled,
                onProgress: progress => control.onProgress?.({ ...progress, phase: `dsh-${progress.phase}` }) });
            if (!window.prefixOmitted && !window.suffixOmitted) return null;
            const converted = normalizeDshSessionEvents(window.events, dshSource.header, control.isCancelled);
            rounds = converted.rounds;
            prefixOmitted = window.prefixOmitted;
            suffixOmitted = window.suffixOmitted;
            parsedBytes = window.parsedBytes;
            decodedBytes = window.decodedBytes;
            readBytes = window.readBytes;
            warnings.push(...window.warnings, ...converted.diagnostics.map(item => `dsh_${item.code}@${item.eventIndex}/${item.eventType}`));
            warnings.push("dsh_window_outside_event_sequence_validation_pending");
        } else {
            const window = await readHostTextWindow(revision, direction, windowBytes, control.isCancelled);
            control.onProgress?.({ phase: "claude-window-parse", bytes: 0, totalBytes: Buffer.byteLength(window.text) });
            rounds = mergeConsecutiveHumanRounds(await readClaudeCodeWindowText(revision.path, window.text, window.startByte, conversation.workspace, control.isCancelled));
            prefixOmitted = window.prefixOmitted;
            suffixOmitted = window.suffixOmitted;
            parsedBytes = Buffer.byteLength(window.text);
            decodedBytes = window.readBytes;
            readBytes = window.readBytes;
            control.onProgress?.({ phase: "claude-window-parse", bytes: parsedBytes, totalBytes: parsedBytes });
            if (window.incompleteTrailingRecord) warnings.push("claude_incomplete_trailing_record");
        }
        if (prefixOmitted) rounds = rounds.slice(1);
        if (suffixOmitted) rounds = rounds.slice(0, -1);
        if (direction === "tail") rounds = rounds.slice(-(request.lastRounds || 5)).map((round, index) => ({ ...round, roundIndex: index + 1 }));
        else rounds = rounds.filter(round => round.roundIndex >= (request.startRound || 1) && round.roundIndex <= (request.endRound || (request.startRound || 1) + 4));
        const unresolvedTool = rounds.some(round => round.toolCalls.some(tool => tool.name === "tool_result" || tool.name === "unknown_tool" || tool.resultFull === undefined));
        if (unresolvedTool) warnings.push("host_window_tool_origin_outside_window_pending");
        if (!rounds.length || request.lastRounds !== undefined && rounds.length < request.lastRounds || request.endRound !== undefined && (rounds.at(-1)?.roundIndex || 0) < request.endRound) warnings.push("host_window_budget_requires_full_read");
        warnings.push(direction === "tail" ? "host_cold_tail_relative_rounds" : "host_cold_head_source_incomplete");
        await assertHostFileUnchanged(revision, control.isCancelled);
        const snapshot: HostCorpusSnapshot = {
            conversation: { ...conversation, rolloutPath: revision.path, canonicalId: id }, rounds,
            revision: hostCorpusDigest(["host-log/v2", source === "dsh" ? DSH_NORMALIZATION_VERSION : 1, source, id, revision.path, revision.sha256]),
            cacheGeneration: hostCorpusDigest([source, id, revision.sha256]), sourceComplete: false, partial: direction === "tail" || unresolvedTool || warnings.some(item => item.includes("incomplete_trailing") || item.startsWith("dsh_unknown") || item.startsWith("dsh_malformed")),
            roundNumbering: direction === "tail" ? "relative" : "absolute", rangeComplete: rounds.length > 0 && (request.endRound === undefined || rounds.at(-1)!.roundIndex >= request.endRound),
            warnings, sourceBytes: revision.size, timings: { totalMs: performance.now() - started, verificationMs: verifiedAt - started, verificationBytes: revision.size,
                knownSourceReadBytes: revision.size + readBytes, parsedBytes, decodedBytes, windowBytes, cacheHit: 0, append: 0 },
        };
        if (!await writeHostCache(windowFile, { sha256: revision.sha256, path: revision.path, snapshot }, maxCacheBytes, control.isCancelled)) snapshot.warnings!.push("host_persistent_cache_budget_exceeded");
        await assertHostFileUnchanged(revision, control.isCancelled);
        assertHostReadActive(control);
        return snapshot;
    };
    const read = async (conversation: CorpusConversation, control: CorpusReadControl, cachedOnly = false, request?: CorpusFastReadRequest): Promise<HostCorpusSnapshot | null> => {
        const originalControl = control;
        control = { ...control, isCancelled: () => {
            if (originalControl.isCancelled?.()) return true;
            if (originalControl.deadlineAt !== undefined && Date.now() >= originalControl.deadlineAt) {
                const error = new Error("Log conversation source read deadline exceeded");
                error.name = "TimeoutError";
                Object.assign(error, { code: "LOG_SOURCE_DEADLINE" });
                throw error;
            }
            return false;
        } };
        assertHostReadActive(control);
        const started = performance.now();
        const id = conversation.canonicalId || conversation.id;
        const previous = control.forceRefresh ? null : await loadCache(id);
        if (cachedOnly && !previous) return null;
        let entry: LogCache;
        let parseBytes = 0;
        let decodedBytes = 0;
        let cacheHit = false;
        let append = false;
        let verifiedAt = performance.now();
        let normalizedMs = 0;
        if (source === "claude-code") {
            let thread = claudeThreads.get(id);
            if (!thread && options.claudeThreads) thread = (await options.claudeThreads()).find(item => item.id === id);
            if (!thread && !options.claudeThreads) {
                const discovery = await discoverClaudeCodeThreads({ conversationIds: [id], deadlineAt: control.deadlineAt, isCancelled: control.isCancelled });
                thread = discovery.threads.find(item => item.id === id);
                if (thread) claudeThreads.set(id, thread);
            }
            if (!thread) throw new Error(`Claude Code source not found: ${id}`);
            if ((await fs.stat(thread.jsonlPath)).size > maxSourceBytes) throw new Error("Claude Code source exceeds maxSourceBytes; use a larger explicit reader budget");
            if (request && !previous && (await fs.stat(thread.jsonlPath)).size > windowBytes) return readWindow(conversation, request, control, thread.jsonlPath);
            const revision = await captureHostFile(thread.jsonlPath, { prefixSize: previous?.revision.size, isCancelled: control.isCancelled,
                onProgress: (bytes, totalBytes) => control.onProgress?.({ phase: "claude-source-verification", bytes, totalBytes }) });
            if (revision.size > maxSourceBytes) throw new Error("Claude Code source exceeds maxSourceBytes; use a larger explicit reader budget");
            verifiedAt = performance.now();
            cacheHit = Boolean(previous && previous.revision.path === revision.path && previous.revision.sha256 === revision.sha256);
            append = Boolean(previous?.claudeCheckpoint && previous.rawRounds && previous.revision.path === revision.path && previous.revision.dev === revision.dev && previous.revision.ino === revision.ino && revision.size > previous.revision.size && revision.prefixSha256 === previous.revision.sha256 && !previous.partial);
            if (cacheHit) entry = { ...previous!, revision };
            else {
                if (cachedOnly) return null;
                let tail = await readClaudeCodeRoundTail(thread.jsonlPath, { cwd: thread.cwd, checkpoint: append ? previous!.claudeCheckpoint : undefined, isCancelled: control.isCancelled,
                    onProgress: (bytes, totalBytes) => control.onProgress?.({ phase: "claude-body-parse", bytes, totalBytes }) });
                if (tail.status === "rebuild_required") throw new Error(`Claude Code source changed: ${tail.reason}`);
                parseBytes = tail.sourceSize - tail.startByte;
                if (append && tail.rounds.some(round => round.toolCalls.some(tool => tool.name === "tool_result"))) {
                    tail = await readClaudeCodeRoundTail(thread.jsonlPath, { cwd: thread.cwd, isCancelled: control.isCancelled,
                        onProgress: (bytes, totalBytes) => control.onProgress?.({ phase: "claude-body-parse-rebuild", bytes, totalBytes }) });
                    if (tail.status === "rebuild_required") throw new Error(`Claude Code source changed: ${tail.reason}`);
                    append = false;
                    parseBytes += tail.sourceSize - tail.startByte;
                }
                const rawRounds = append ? [...previous!.rawRounds!.filter(round => round.roundIndex < tail.replaceFromRound), ...tail.rounds] : tail.rounds;
                const normalizeAt = performance.now();
                const rounds = mergeConsecutiveHumanRounds(rawRounds);
                normalizedMs = performance.now() - normalizeAt;
                const handle = await fs.open(revision.path, "r");
                let completeLine = revision.size === 0;
                try {
                    if (revision.size) { const byte = Buffer.allocUnsafe(1); await handle.read(byte, 0, 1, revision.size - 1); completeLine = byte[0] === 10; }
                } finally { await handle.close(); }
                await assertHostFileUnchanged(revision, control.isCancelled);
                entry = { version: "host-log/v2", source, id, revision, rounds, rawRounds, claudeCheckpoint: tail.checkpoint,
                    warnings: completeLine ? [] : ["claude_incomplete_trailing_record"], partial: !completeLine };
            }
        } else {
            const configured = { ...options.dshOptions, maxDecompressedBytes: options.dshOptions?.maxDecompressedBytes ?? maxSourceBytes,
                isCancelled: control.isCancelled, onProgress: (progress: { bytes: number; totalBytes: number; phase: string }) => control.onProgress?.({ ...progress, phase: `dsh-${progress.phase}` }) };
            let selected = dshSources.find(item => item.id === id);
            if (selected) {
                try {
                    const metadata = await fs.stat(selected.provenance.sourcePath);
                    if (metadata.size !== selected.provenance.sourceSizeBytes || metadata.mtimeMs !== selected.provenance.sourceMtimeMs) selected = undefined;
                } catch (error) {
                    if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
                    selected = undefined;
                }
            }
            if (!selected) {
                const discovery = await discoverDshSessionSources({ ...configured, conversationIds: [id], deadlineAt: control.deadlineAt });
                dshSources = discovery.sources;
                selected = dshSources.find(item => item.id === id);
            }
            if (!selected) throw new Error(`DSH source not found: ${id}`);
            if (selected.provenance.sourceSizeBytes > maxSourceBytes) throw new Error("DSH source exceeds maxSourceBytes; use a larger explicit reader budget");
            if (request && !previous && (selected.provenance.sourceSizeBytes > windowBytes || selected.provenance.format === "jsonl.zstd")) {
                const window = await readWindow(conversation, request, control, selected.provenance.sourcePath, selected);
                if (window) return window;
            }
            const result = await readDshSessionIncremental(selected, { ...configured, checkpoint: previous?.dshCheckpoint });
            if (result.header.id !== id) throw new Error("DSH source identity changed during read");
            verifiedAt = performance.now();
            cacheHit = result.status === "unchanged" && Boolean(previous);
            if (cacheHit) entry = { ...previous!, revision: result.checkpoint.source };
            else {
                if (cachedOnly) return null;
                const events = previous?.events && result.replaceFromEvent > 0 ? [...previous.events.slice(0, result.replaceFromEvent), ...result.events] : result.events;
                const normalizeAt = performance.now();
                const converted = normalizeDshSessionEvents(events, result.header, control.isCancelled);
                normalizedMs = performance.now() - normalizeAt;
                if (!converted.rounds.some(round => round.userMessage.trim() || round.aiResponses.some(response => response.response.trim()) || round.toolCalls.length)) throw new Error("DSH session has no readable conversation body");
                append = Boolean(previous && result.replaceFromEvent > 0);
                parseBytes = result.readBytes;
                decodedBytes = result.decodedBytes;
                const warnings = converted.diagnostics.map(item => `dsh_${item.code}@${item.eventIndex}/${item.eventType}`);
                if (result.provenance.ignoredTrailingTextRecord) warnings.push("dsh_incomplete_trailing_record");
                if (result.provenance.ignoredTrailingZstdFrame) warnings.push("dsh_incomplete_trailing_frame");
                entry = { version: "host-log/v2", source, id, revision: result.checkpoint.source, rounds: converted.rounds,
                    dshCheckpoint: result.checkpoint, events, warnings, partial: warnings.length > 0 };
            }
        }
        assertHostReadActive(control);
        const publishAt = performance.now();
        if (!cacheHit && !await writeHostCache(cacheFile(id), entry, maxCacheBytes, control.isCancelled)) entry.warnings = [...entry.warnings, "host_persistent_cache_budget_exceeded"];
        const finished = performance.now();
        const origin = { ...conversation, rolloutPath: entry.revision.path, canonicalId: id };
        return {
            conversation: origin, rounds: entry.rounds, revision: hostCorpusDigest(["host-log/v2", source === "dsh" ? DSH_NORMALIZATION_VERSION : 1, source, id, entry.revision.path, entry.revision.sha256]),
            cacheGeneration: hostCorpusDigest([source, id, entry.revision.sha256]), partial: entry.partial, warnings: entry.warnings,
            sourceBytes: entry.revision.size, totalRounds: entry.rounds.at(-1)?.roundIndex || 0, roundNumbering: "absolute",
            timings: { totalMs: finished - started, verificationMs: verifiedAt - started, normalizationMs: normalizedMs, cacheWriteMs: finished - publishAt,
                verificationBytes: entry.revision.size, knownSourceReadBytes: entry.revision.size + parseBytes, parsedBytes: parseBytes, decodedBytes, cacheHit: Number(cacheHit), append: Number(append) },
        };
    };
    return {
        sourceStatuses: () => statuses,
        async list(request, control) {
            assertHostReadActive(control);
            try {
                let candidates: CorpusConversation[];
                let discoveryPartial = false;
                let discoveryWarnings: string[] = [];
                if (source === "claude-code") {
                    let threads: ClaudeCodeThreadInfo[];
                    if (options.claudeThreads) threads = await options.claudeThreads();
                    else {
                        const discovery = await discoverClaudeCodeThreads({ conversationIds: request.conversationIds, workspaces: request.workspaces,
                            workspaceMode: request.workspaceMode, limit: options.listLimit || 10_000, deadlineAt: control.deadlineAt,
                            isCancelled: control.isCancelled, onProgress: progress => control.onProgress?.({ ...progress, phase: "claude-" + progress.phase }) });
                        threads = discovery.threads;
                        discoveryPartial = discovery.partial;
                        discoveryWarnings = discovery.warnings;
                    }
                    for (const thread of threads) claudeThreads.set(thread.id, thread);
                    candidates = threads.map(claudeConversation);
                } else {
                    const discovery = await discoverDshSessionSources({ ...options.dshOptions, conversationIds: request.conversationIds,
                        workspaces: request.workspaces, workspaceMode: request.workspaceMode, limit: options.listLimit || 10_000,
                        deadlineAt: control.deadlineAt, isCancelled: control.isCancelled,
                        onProgress: progress => control.onProgress?.({ ...progress, phase: "dsh-" + progress.phase }) });
                    dshSources = discovery.sources;
                    discoveryPartial = discovery.partial;
                    discoveryWarnings = discovery.warnings;
                    candidates = dshSources.map(dshConversation);
                }
                const limited = candidates.length >= (options.listLimit || 10_000);
                const unknownWorkspace = Boolean(request.workspaces?.length && candidates.some(candidate => !candidate.workspace));
                candidates = candidates.filter(candidate => hostConversationMatches(candidate, request));
                statuses = [{ source, status: discoveryPartial || limited || unknownWorkspace ? "partial" : "ok", candidateCount: candidates.length,
                    warnings: [...discoveryWarnings, ...(limited ? ["host_source_enumeration_limit"] : []), ...(unknownWorkspace ? ["host_workspace_metadata_unavailable"] : [])] }];
                assertHostReadActive(control);
                return candidates;
            } catch (error) {
                statuses = [{ source, status: "error", candidateCount: 0, warnings: [], error: error instanceof Error ? error.message : String(error) }];
                throw error;
            }
        },
        read: async (conversation, request, control) => (await read(conversation, control, false, request))!,
        readCached: (conversation, control) => read(conversation, control, true),
    };
}
