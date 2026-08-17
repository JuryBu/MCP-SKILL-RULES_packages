import { normalizeDataChain, type DataChain, type ConversationLinkMode, type ConversationLogicalChainMode } from "./chain.js";
import {
    getCodexThread,
    assertCodexSourceVersion,
    createCodexSourceRevisionAccumulator,
    codexSourceRevisionFromRounds,
    loadCodexConversationAsync,
    loadCodexConversationToRoundSinkAsync,
    readCodexRoundTail,
    resolveCurrentCodexThreadIdAsync,
    resolveCodexThreadIdAsync,
    isCodexSessionStoreAvailable,
    type CodexConversationData,
    type CodexSourceVersionExpectation,
} from "./codex-client.js";
import {
    getClaudeCodeThread,
    loadClaudeCodeConversationAsync,
    readClaudeCodeRoundTail,
    resolveClaudeCodeThreadId,
    isClaudeCodeStoreAvailable,
    type ClaudeCodeConversationData,
} from "./claude-code-client.js";
import {
    listRecentWindsurfThreads,
    loadWindsurfConversation,
    resolveWindsurfThreadId,
    isWindsurfStoreAvailable,
    type WindsurfConversationReadResult,
} from "./windsurf-client.js";
import {
    listDshSessionSnapshots,
    readDshSession,
    resolveDshSessionsRoot,
    type DshSessionHeader,
    type DshSessionProvenance,
} from "./dsh-session-reader.js";
import {
    normalizeDshSessionReadResult,
    type DshConversionDiagnostic,
} from "./dsh-client.js";
import type { ConcurrencyGateRequestClass } from "./concurrency-gate.js";
import { withConversationSourcePressure } from "./conversation-source-pressure.js";
import { isAntigravityLS } from "./lifecycle.js";
import { fetchTrajectory, getCurrentCascadeId, isLsAvailable, listLiveAntigravityConversationIds } from "./ls-client.js";
import { setCurrentContext } from "./conversation-router.js";
import { mergeConsecutiveHumanRounds, normalizeConversationAutomationRound, parseRounds, type ConversationRound } from "./trajectory.js";
import {
    buildConversationCompactionMetadata,
    projectConversationRoundForRecallMetadata,
    type ConversationCompactionMetadata,
} from "./conversation-recall.js";
import { projectConversationRoundForRecord } from "./conversation-record-projection.js";
import {
    readCachedConversationSourceCacheRounds,
    iterateCachedConversationSourceCacheRounds,
    readCachedConversationSourceCache,
    readConversationSourceCacheOnly,
    readOrBuildConversationSourceCache,
    createConversationSourceCacheRoundSpool,
    getConversationSourceCacheGenerationKind,
    type ConversationSourceCacheKey,
    type ConversationSourceCacheGenerationRef,
    type ConversationSourceFingerprint,
    type ConversationSourceCacheBuildResult,
    type ConversationSourceCacheBuildFailure,
} from "./conversation-source-cache.js";
import {
    compareConversationRoundCompleteness,
    discoverLocalPbCandidates,
    fingerprintLocalPbCandidates,
    loadLocalPbConversation,
    type ConversationRawSource,
} from "./conversation-source-adapters.js";
import fs from "node:fs";
import {
    resolveConversationIdAcrossSources,
    type IdResolutionMode,
    type SourceFailureMode,
} from "./conversation-filter.js";
import type { SourceRevision } from "./source-evidence-contracts.js";

export type ResolvedConversationChain = Exclude<DataChain, "auto">;

export interface ConversationLoadResult {
    chainUsed: ResolvedConversationChain;
    conversationId: string;
    rounds: ConversationRound[];
    roundCount?: number;
    roundStart?: number;
    aiResponseCount?: number;
    toolCallCount?: number;
    totalSteps: number;
    fromCache?: boolean;
    codexData?: CodexConversationData;
    claudeCodeData?: ClaudeCodeConversationData;
    windsurfData?: WindsurfConversationReadResult;
    dshData?: {
        header: DshSessionHeader;
        provenance: DshSessionProvenance;
        diagnostics: DshConversionDiagnostic[];
        rounds: ConversationRound[];
    };
    trajectory?: any;
    cacheKey?: ConversationSourceCacheKey;
    cacheGeneration?: string;
    cacheState?: "hit" | "built" | "stale";
    cacheCreatedAt?: string;
    cacheBuildFailure?: ConversationSourceCacheBuildFailure;
    cacheFingerprint?: ConversationSourceFingerprint | null;
    sourceMode?: ConversationRawSource;
    sourceDiagnostics?: string[];
    sourceRevision?: SourceRevision;
    compactionMetadata?: ConversationCompactionMetadata;
}

type ConversationCacheAuthority = Extract<ConversationRawSource, "local" | "ls">;

interface CachedConversationLoadResult extends ConversationLoadResult {
    cacheAuthority?: ConversationCacheAuthority;
}

function countConversationOverview(rounds: ConversationRound[]): { aiResponseCount: number; toolCallCount: number } {
    let aiResponseCount = 0;
    let toolCallCount = 0;
    for (const round of rounds) {
        aiResponseCount += round.aiResponses.length > 0
            ? round.aiResponses.length
            : (round.semanticEvents || []).filter(event => event.semanticRole === "model" || event.semanticRole === "assistant").length;
        toolCallCount += round.toolCalls.length > 0
            ? round.toolCalls.length
            : (round.semanticEvents || []).filter(event => event.semanticRole === "tool").length;
    }
    return { aiResponseCount, toolCallCount };
}

function hasConversationVisibleBody(rounds: ConversationRound[]): boolean {
    return rounds.some(round =>
        (round.userMessages || []).some(message => message.text.trim().length > 0)
        || round.aiResponses.some(response => response.response.trim().length > 0)
        || round.toolCalls.length > 0
    );
}

function assertDshReadableBody(rounds: ConversationRound[], conversationId: string, sourcePath?: string): void {
    if (hasConversationVisibleBody(rounds)) return;
    throw new Error([
        `DSH session ${conversationId} 没有可读对话正文：源文件只包含 session seed/config/preset 等元数据，未发现 user/message 或 assistant/message 正文。`,
        "Memory Store 拒绝发布空壳 fetch 缓存，避免把稀疏系统事件冒充为成功对话。",
        "若 DSH UI 将该 ID 展示为可读对话，说明正文可能位于关联 session/分支；当前 Memory Store 尚未获得可验证关联契约。",
        sourcePath ? `source=${sourcePath}` : "",
    ].filter(Boolean).join(" "));
}

function compactConversationCacheSnapshot(loaded: CachedConversationLoadResult): CachedConversationLoadResult {
    const compactionMetadata = loaded.compactionMetadata
        || buildConversationCompactionMetadata(loaded.chainUsed, loaded.rounds);
    const overview = countConversationOverview(loaded.rounds);
    return {
        ...loaded,
        roundCount: loaded.roundCount ?? loaded.rounds.length,
        aiResponseCount: loaded.aiResponseCount ?? overview.aiResponseCount,
        toolCallCount: loaded.toolCallCount ?? overview.toolCallCount,
        compactionMetadata,
        rounds: [],
        ...(loaded.codexData ? { codexData: { ...loaded.codexData, rounds: [] } } : {}),
        ...(loaded.claudeCodeData ? { claudeCodeData: { ...loaded.claudeCodeData, rounds: [] } } : {}),
        ...(loaded.windsurfData ? { windsurfData: { ...loaded.windsurfData, rounds: [], steps: [] } } : {}),
        ...(loaded.dshData ? { dshData: { ...loaded.dshData, rounds: [] } } : {}),
        ...(loaded.trajectory ? { trajectory: { ...loaded.trajectory, steps: [] } } : {}),
    };
}

interface ConversationCacheFreshness {
    fingerprint: ConversationSourceFingerprint | null;
    buildSource: ConversationRawSource;
}

let unversionedLsFingerprintSequence = 0;

interface ConversationLoadOptions {
    refresh?: boolean;
    link?: ConversationLinkMode;
    cwd?: string;
    dataChains?: DataChain[];
    idResolutionMode?: IdResolutionMode;
    sourceFailureMode?: SourceFailureMode;
    logicalChain?: ConversationLogicalChainMode;
    requestClass?: ConcurrencyGateRequestClass;
    source?: ConversationRawSource;
    includeRounds?: boolean;
    roundRange?: {
        startRound?: number;
        endRound?: number;
    };
    forceRawCacheRebuild?: boolean;
    isCancelled?: () => boolean;
    expectedCodexSource?: CodexSourceVersionExpectation;
    requireCompactionMetadata?: boolean;
}

function throwIfConversationLoadCancelled(options: Pick<ConversationLoadOptions, "isCancelled">): void {
    if (!options.isCancelled?.()) return;
    const error = new Error("conversation load cancelled");
    error.name = "AbortError";
    throw error;
}

export async function resolveConversationChain(chain: DataChain = "auto"): Promise<ResolvedConversationChain | null> {
    chain = normalizeDataChain(chain);
    if (chain === "antigravity") {
        return (await isLsAvailable()) ? "antigravity" : null;
    }
    if (chain === "codex") {
        return isCodexSessionStoreAvailable() ? "codex" : null;
    }
    if (chain === "claude-code") {
        return isClaudeCodeStoreAvailable() ? "claude-code" : null;
    }
    if (chain === "windsurf") {
        return (await isWindsurfStoreAvailable()) ? "windsurf" : null;
    }
    if (chain === "dsh") {
        return fs.existsSync(resolveDshSessionsRoot()) ? "dsh" : null;
    }

    const preferLs = await isAntigravityLS();
    if (preferLs) {
        if (await isLsAvailable()) return "antigravity";
        if (isCodexSessionStoreAvailable()) return "codex";
        if (isClaudeCodeStoreAvailable()) return "claude-code";
        return null;
    }

    if (isCodexSessionStoreAvailable()) return "codex";
    if (await isLsAvailable()) return "antigravity";
    if (isClaudeCodeStoreAvailable()) return "claude-code";
    return null;
}

export async function resolveConversationId(
    requestedId: string | undefined,
    chain: ResolvedConversationChain,
    cwd: string = process.cwd(),
    requestClass?: ConcurrencyGateRequestClass,
): Promise<string | null> {
    if (chain === "antigravity") {
        if (requestedId) return requestedId;
        return await getCurrentCascadeId();
    }
    if (chain === "claude-code") {
        if (requestedId) return resolveClaudeCodeThreadId(requestedId) || requestedId;
        return null;
    }
    if (chain === "windsurf") {
        if (requestedId) return await resolveWindsurfThreadId(requestedId, { requestClass }) || requestedId;
        return null;
    }
    if (chain === "dsh") return requestedId || null;
    if (requestedId) return await resolveCodexThreadIdAsync(requestedId) || requestedId;
    return resolveCurrentCodexThreadIdAsync(cwd);
}

export async function loadConversationData(
    chain: DataChain = "auto",
    conversationId?: string,
    options: ConversationLoadOptions = {},
): Promise<ConversationLoadResult | null> {
    chain = normalizeDataChain(chain);
    const source = options.source || "auto";
    if (chain === "auto") {
        if (conversationId && source === "cache") {
            const cached = (await Promise.all(
                (["codex", "antigravity", "claude-code", "windsurf", "dsh"] as ResolvedConversationChain[])
                    .map(candidate => loadFromResolvedChain(candidate, conversationId, options).catch(() => null)),
            )).filter((item): item is ConversationLoadResult => Boolean(item));
            if (cached.length > 1) {
                throw new Error(`conversationId 在多个 fetch 缓存中命中：${cached.map(item => item.chainUsed).join("、")}。请显式传 dataChain。`);
            }
            return cached[0] || null;
        }
        if (conversationId && (options.idResolutionMode || "unique") === "unique") {
            const resolvedAcrossSources = await resolveConversationIdAcrossSources(conversationId, {
                dataChains: options.dataChains,
                sourceFailureMode: options.sourceFailureMode || "warn",
            });
            if (resolvedAcrossSources.hits.length === 1) {
                const hit = resolvedAcrossSources.hits[0];
                return loadFromResolvedChain(hit.dataChain, hit.conversationId, options);
            }
            if (resolvedAcrossSources.hits.length > 1) {
                const candidates = resolvedAcrossSources.hits
                    .map(hit => `${hit.dataChain}:${hit.conversationId}${hit.title ? ` (${hit.title})` : ""}`)
                    .join("；");
                throw new Error(`conversationId 在多个数据源中命中，无法自动选择：${candidates}。请显式传 dataChain。`);
            }
            if (source === "auto" || source === "local") {
                const localFallbacks = (await Promise.all(
                    (["antigravity", "windsurf", "dsh"] as ResolvedConversationChain[])
                        .map(candidate => loadFromResolvedChain(candidate, conversationId, { ...options, source: "local" }).catch(() => null)),
                )).filter((item): item is ConversationLoadResult => Boolean(item));
                if (localFallbacks.length > 1) {
                    throw new Error("conversationId 在 Windsurf 与 Antigravity 本地 PB 中同时命中，请显式传 dataChain。");
                }
                if (localFallbacks.length === 1) return localFallbacks[0];
            }
            return null;
        }

        const preferLs = await isAntigravityLS();
        const candidates: ResolvedConversationChain[] = preferLs
            ? ["antigravity", "codex", "claude-code"]
            : ["codex", "antigravity", "claude-code"];
        if (conversationId) {
            candidates.push("windsurf");
            candidates.push("dsh");
        }

        for (const candidate of candidates) {
            const isAvailable = candidate === "antigravity"
                ? await isLsAvailable()
                : candidate === "codex"
                    ? isCodexSessionStoreAvailable()
                    : candidate === "claude-code"
                        ? isClaudeCodeStoreAvailable()
                        : candidate === "windsurf"
                            ? await isWindsurfStoreAvailable()
                            : fs.existsSync(resolveDshSessionsRoot());
            if (!isAvailable) continue;

            let loaded: ConversationLoadResult | null = null;
            try {
                loaded = await loadFromResolvedChain(candidate, conversationId, options);
            } catch {
                loaded = null;
            }
            if (loaded) return loaded;
        }

        return null;
    }

    const resolved = source === "cache" || source === "local"
        ? chain as ResolvedConversationChain
        : await resolveConversationChain(chain);
    if (!resolved) return null;
    return loadFromResolvedChain(resolved, conversationId, options);
}

async function loadFromResolvedChain(
    resolved: ResolvedConversationChain,
    conversationId: string | undefined,
    options: ConversationLoadOptions,
): Promise<ConversationLoadResult | null> {
    throwIfConversationLoadCancelled(options);
    // 方案 D 注入点（见蓝图步骤 7）：把已知 conversationId / workspace 指纹喂给路由大脑，
    // 让 getCurrentCascadeId（无 id 旁路）能精确绑定当前窗口，而非「连第一个 LS 猜全局最新」。
    // 仅 antigravity/windsurf 受益；codex/claude-code 分支不消费 ctx，零影响。
    if (resolved === "antigravity" || resolved === "windsurf") {
        setCurrentContext({
            conversationId: conversationId || undefined,
            workspaceRoot: options.cwd || undefined,
        });
    }

    const source = options.source || "auto";
    if (source === "ls" && (resolved === "codex" || resolved === "claude-code" || resolved === "dsh")) {
        throw new Error(`source=ls 不支持 ${resolved}；该宿主的权威原始源是本地 JSONL`);
    }
    const effectiveId = (source === "cache" || source === "local") && conversationId
        ? conversationId
        : await resolveConversationId(conversationId, resolved, options.cwd, options.requestClass);
    if (!effectiveId) return null;
    if (resolved === "codex" && options.expectedCodexSource) {
        const expectedThread = getCodexThread(effectiveId);
        if (!expectedThread?.rolloutPath) throw new Error("Codex source changed before cache lookup; start a fresh fetch");
        await assertCodexSourceVersion(expectedThread.rolloutPath, options.expectedCodexSource, "before cache lookup");
    }

    const key = conversationSourceCacheKey(resolved, effectiveId, options);
    if (source === "cache") return loadConversationCacheOnly(key, source, options);

    const previous = readCachedConversationSourceCache<CachedConversationLoadResult>({ key });
    const buildPrevious = options.forceRawCacheRebuild ? undefined : previous;
    const requiresMetadataRefresh = Boolean(
        previous
        && (
            (options.requireCompactionMetadata && previous.snapshot.compactionMetadata?.version !== 1)
            || previous.snapshot.aiResponseCount === undefined
            || previous.snapshot.toolCallCount === undefined
        ),
    );
    const freshness = await prepareConversationCacheFreshness(resolved, effectiveId, source, previous, options.requestClass);
    const cached = await readOrBuildConversationSourceCache<CachedConversationLoadResult, ConversationRound>({
        key,
        fingerprint: options.expectedCodexSource
            ? {
                path: options.expectedCodexSource.sourcePath,
                size: options.expectedCodexSource.sourceSize,
                mtime: options.expectedCodexSource.sourceMtimeMs,
            }
            : freshness.fingerprint,
        refresh: options.forceRawCacheRebuild === true
            || requiresMetadataRefresh
            || (options.refresh === true && (resolved === "antigravity" || resolved === "windsurf")),
        assertPublishable: resolved === "codex" && options.expectedCodexSource
            ? () => assertCodexSourceVersion(options.expectedCodexSource!.sourcePath, options.expectedCodexSource, "before cache publication")
            : undefined,
        build: async () => withConversationSourcePressure(options.requestClass || "foreground", async () => {
            throwIfConversationLoadCancelled(options);
            if (!buildPrevious && resolved === "codex" && (options.link || "summary") !== "expand_children") {
                const spool = createConversationSourceCacheRoundSpool<ConversationRound>({
                    key,
                    getRoundNumber: (round, index) => round.roundIndex || index + 1,
                    projectRecordRound: projectConversationRoundForRecord,
                });
                let aiResponseCount = 0;
                let toolCallCount = 0;
                const recallMetadataRounds: ConversationRound[] = [];
                const revisionAccumulator = createCodexSourceRevisionAccumulator();
                try {
                    const streamedLink = options.link === "reference" ? "reference" : "summary";
                    const codexData = await loadCodexConversationToRoundSinkAsync(
                        effectiveId,
                        (round) => {
                            throwIfConversationLoadCancelled(options);
                            spool.append(round);
                            recallMetadataRounds.push(projectConversationRoundForRecallMetadata(round));
                            revisionAccumulator.addRound(round);
                            aiResponseCount += round.aiResponses.length;
                            toolCallCount += round.toolCalls.length;
                        },
                        streamedLink,
                        {
                            isCancelled: options.isCancelled,
                            expectedSource: options.expectedCodexSource,
                        },
                    );
                    if (!codexData) throw new Error("Codex JSONL 对话不存在或无法读取");
                    const preparedRounds = spool.finish();
                    const snapshot: CachedConversationLoadResult = {
                        chainUsed: "codex",
                        conversationId: effectiveId,
                        rounds: [],
                        roundCount: preparedRounds.roundCount,
                        aiResponseCount,
                        toolCallCount,
                        totalSteps: codexData.totalSteps,
                        sourceRevision: revisionAccumulator.finish(
                            Number.isFinite(codexData.sourceCheckpoint?.sourceMtimeMs)
                                ? Math.floor(codexData.sourceCheckpoint!.sourceMtimeMs)
                                : null,
                        ),
                        codexData: { ...codexData, rounds: [] },
                        compactionMetadata: buildConversationCompactionMetadata("codex", recallMetadataRounds),
                        sourceDiagnostics: [`Codex JSONL 已流式规范化为 fetch 缓存，共 ${preparedRounds.roundCount} 轮/${codexData.totalSteps} 步`],
                    };
                    return { snapshot, preparedRounds };
                } catch (error) {
                    spool.abort();
                    throw error;
                }
            }
            const incremental = buildPrevious
                ? await tryBuildIncrementalConversation(resolved, effectiveId, options, buildPrevious)
                : null;
            if (incremental) return incremental;
            const loaded = await loadRawConversationData(
                resolved,
                effectiveId,
                freshness.buildSource === source ? options : { ...options, source: freshness.buildSource },
            );
            throwIfConversationLoadCancelled(options);
            if (!loaded) throw new Error(`无法从 ${resolved} 的 ${source} 原始源构建 fetch 缓存`);
            if (resolved === "codex" && !loaded.sourceRevision) {
                loaded.sourceRevision = codexSourceRevisionFromRounds(
                    loaded.rounds,
                    Number.isFinite(loaded.codexData?.sourceCheckpoint?.sourceMtimeMs)
                        ? Math.floor(loaded.codexData!.sourceCheckpoint!.sourceMtimeMs)
                        : null,
                );
            }
            return { snapshot: compactConversationCacheSnapshot(loaded), rounds: loaded.rounds };
        }),
        getRoundNumber: (round, index) => round.roundIndex || index + 1,
        projectRecordRound: projectConversationRoundForRecord,
    });
    return hydrateConversationCache(cached.snapshot, cached.generation, cached.cacheState, cached.fingerprint, key, source, options, cached.roundCount, cached.buildFailure, cached.createdAt);
}

export async function rebuildConversationCacheForRecord(
    resolved: ResolvedConversationChain,
    conversationId: string,
    previousGeneration: ConversationSourceCacheGenerationRef,
): Promise<ConversationLoadResult> {
    const cached = readCachedConversationSourceCache<CachedConversationLoadResult>({
        key: previousGeneration.key,
        expectedFingerprint: previousGeneration.fingerprint,
    });
    if (cached && getConversationSourceCacheGenerationKind({
        key: cached.key,
        generation: cached.generation,
        fingerprint: cached.fingerprint,
    }) === "projection") {
        const reused = hydrateConversationCache(
            cached.snapshot,
            cached.generation,
            cached.cacheState,
            cached.fingerprint,
            cached.key,
            "cache",
            { includeRounds: false },
            cached.roundCount,
            undefined,
            cached.createdAt,
        );
        if (reused) return reused;
    }

    const sourceName = previousGeneration.key.source;
    const link: ConversationLinkMode = sourceName.includes(":link=reference") ? "reference" : "summary";
    const logicalName = sourceName.match(/:logical=([^:]+)/u)?.[1];
    const logicalChain: ConversationLogicalChainMode = logicalName === "explain"
        || logicalName === "auto"
        || logicalName === "strict"
        ? logicalName
        : "off";
    const originName = sourceName.match(/:origin=(local|ls)/u)?.[1];
    const source: ConversationRawSource = originName === "local" || originName === "ls" ? originName : "auto";
    const rebuilt = await loadFromResolvedChain(resolved, conversationId, {
        source,
        link,
        logicalChain,
        includeRounds: false,
        requestClass: "background",
        forceRawCacheRebuild: true,
    });
    if (!rebuilt?.cacheKey || !rebuilt.cacheGeneration || rebuilt.cacheState !== "built") {
        throw new Error(`legacy fetch 缓存无法重建 Record 投影: ${resolved}/${conversationId}`);
    }
    return rebuilt;
}

async function tryBuildIncrementalConversation(
    resolved: ResolvedConversationChain,
    conversationId: string,
    options: ConversationLoadOptions,
    previous: ReturnType<typeof readCachedConversationSourceCache<ConversationLoadResult>>,
): Promise<ConversationSourceCacheBuildResult<CachedConversationLoadResult, ConversationRound> | null> {
    if (!previous || (resolved !== "codex" && resolved !== "claude-code")) return null;
    const prefixRounds = (replaceFromRound: number): ConversationRound[] | null => {
        if (replaceFromRound <= 1) return [];
        return readCachedConversationSourceCacheRounds<ConversationRound>({
            key: previous.key,
            generation: previous.generation,
            startRound: 1,
            endRound: replaceFromRound - 1,
        })?.rounds || null;
    };

    if (resolved === "codex") {
        const oldData = previous.snapshot.codexData;
        const checkpoint = oldData?.sourceCheckpoint;
        const rolloutPath = oldData?.thread.rolloutPath;
        if (!checkpoint || !rolloutPath) return null;
        const tail = await readCodexRoundTail(rolloutPath, options.link || "summary", {
            checkpoint,
            cwd: oldData.thread.cwd,
            endByte: options.expectedCodexSource?.sourceSize,
            sourceMtimeMs: options.expectedCodexSource?.sourceMtimeMs,
        });
        if (tail.status === "unchanged") {
            const spool = createConversationSourceCacheRoundSpool<ConversationRound>({
                key: previous.key,
                getRoundNumber: (round, index) => round.roundIndex || index + 1,
                projectRecordRound: projectConversationRoundForRecord,
            });
            let aiResponseCount = 0;
            let toolCallCount = 0;
            const recallMetadataRounds: ConversationRound[] = [];
            const revisionAccumulator = createCodexSourceRevisionAccumulator();
            try {
                const cachedRounds = iterateCachedConversationSourceCacheRounds<ConversationRound>({
                    key: previous.key,
                    generation: previous.generation,
                });
                if (!cachedRounds) throw new Error("Codex 增量更新无法读取上一代 fetch 缓存");
                for (const cachedRound of cachedRounds.rounds) {
                    const round = normalizeConversationAutomationRound(cachedRound);
                    spool.append(round);
                    recallMetadataRounds.push(projectConversationRoundForRecallMetadata(round));
                    revisionAccumulator.addRound(round);
                    aiResponseCount += round.aiResponses.length;
                    toolCallCount += round.toolCalls.length;
                }
            } catch (error) {
                spool.abort();
                throw error;
            }
            const preparedRounds = spool.finish();
            const snapshot: CachedConversationLoadResult = {
                ...previous.snapshot,
                rounds: [],
                roundCount: preparedRounds.roundCount,
                aiResponseCount,
                toolCallCount,
                sourceRevision: revisionAccumulator.finish(Math.floor(checkpoint.sourceMtimeMs)),
                codexData: { ...oldData, rounds: [] },
                compactionMetadata: buildConversationCompactionMetadata("codex", recallMetadataRounds),
            };
            return { snapshot, preparedRounds };
        }
        if (tail.status !== "ok" || !tail.checkpoint) return null;
        const spool = createConversationSourceCacheRoundSpool<ConversationRound>({
            key: previous.key,
            getRoundNumber: (round, index) => round.roundIndex || index + 1,
            projectRecordRound: projectConversationRoundForRecord,
        });
        let aiResponseCount = 0;
        let toolCallCount = 0;
        const recallMetadataRounds: ConversationRound[] = [];
        const revisionAccumulator = createCodexSourceRevisionAccumulator();
        const appendRound = (sourceRound: ConversationRound): void => {
            const round = normalizeConversationAutomationRound(sourceRound);
            spool.append(round);
            recallMetadataRounds.push(projectConversationRoundForRecallMetadata(round));
            revisionAccumulator.addRound(round);
            aiResponseCount += round.aiResponses.length;
            toolCallCount += round.toolCalls.length;
        };
        try {
            if (tail.replaceFromRound > 1) {
                const prefix = iterateCachedConversationSourceCacheRounds<ConversationRound>({
                    key: previous.key,
                    generation: previous.generation,
                    startRound: 1,
                    endRound: tail.replaceFromRound - 1,
                });
                if (!prefix) throw new Error("Codex 增量更新无法读取上一代 fetch 缓存前缀");
                for (const round of prefix.rounds) appendRound(round);
            }
            for (const round of mergeConsecutiveHumanRounds(tail.rounds, tail.replaceFromRound)) appendRound(round);
        } catch (error) {
            spool.abort();
            throw error;
        }
        const preparedRounds = spool.finish();
        const childThreads = [...oldData.childThreads];
        for (const child of tail.childThreads) {
            const existing = childThreads.findIndex(item => item.threadId === child.threadId);
            if (existing >= 0) childThreads[existing] = child;
            else childThreads.push(child);
        }
        const totalSteps = tail.rounds.at(-1)?.endStep || previous.snapshot.totalSteps;
        const snapshot: CachedConversationLoadResult = {
            ...previous.snapshot,
            conversationId,
            rounds: [],
            roundCount: preparedRounds.roundCount,
            aiResponseCount,
            toolCallCount,
            totalSteps,
            sourceRevision: revisionAccumulator.finish(Math.floor(tail.checkpoint.sourceMtimeMs)),
            codexData: {
                ...oldData,
                rounds: [],
                totalSteps,
                childThreads,
                sourceCheckpoints: tail.sourceCheckpoints,
                sourceCheckpoint: tail.checkpoint,
            },
            compactionMetadata: buildConversationCompactionMetadata("codex", recallMetadataRounds),
            sourceDiagnostics: [...(previous.snapshot.sourceDiagnostics || []), `Codex JSONL 仅重放第 ${tail.replaceFromRound} 轮起的追加尾部`],
        };
        return { snapshot, preparedRounds };
    }

    const oldData = previous.snapshot.claudeCodeData;
    const checkpoint = oldData?.sourceCheckpoint;
    const jsonlPath = oldData?.thread.jsonlPath;
    if (!checkpoint || !jsonlPath || oldData.logicalChain?.merged) return null;
    const tail = await readClaudeCodeRoundTail(jsonlPath, { checkpoint, cwd: oldData.thread.cwd });
    const buildClaudePrepared = (
        sources: Iterable<ConversationRound>[],
        totalSteps: number,
        nextCheckpoint: NonNullable<typeof tail.checkpoint>,
        diagnostic: string,
    ): ConversationSourceCacheBuildResult<CachedConversationLoadResult, ConversationRound> => {
        const spool = createConversationSourceCacheRoundSpool<ConversationRound>({
            key: previous.key,
            getRoundNumber: (round, index) => round.roundIndex || index + 1,
            projectRecordRound: projectConversationRoundForRecord,
        });
        let aiResponseCount = 0;
        let toolCallCount = 0;
        const recallMetadataRounds: ConversationRound[] = [];
        try {
            for (const source of sources) {
                for (const sourceRound of source) {
                    const round = normalizeConversationAutomationRound(sourceRound);
                    spool.append(round);
                    recallMetadataRounds.push(projectConversationRoundForRecallMetadata(round));
                    aiResponseCount += round.aiResponses.length;
                    toolCallCount += round.toolCalls.length;
                }
            }
        } catch (error) {
            spool.abort();
            throw error;
        }
        const preparedRounds = spool.finish();
        return {
            snapshot: compactConversationCacheSnapshot({
                ...previous.snapshot,
                conversationId,
                roundCount: preparedRounds.roundCount,
                aiResponseCount,
                toolCallCount,
                totalSteps,
                claudeCodeData: {
                    ...oldData,
                    rounds: [],
                    totalSteps,
                    sourceCheckpoints: tail.sourceCheckpoints,
                    sourceCheckpoint: nextCheckpoint,
                },
                sourceDiagnostics: [...(previous.snapshot.sourceDiagnostics || []), diagnostic],
                compactionMetadata: buildConversationCompactionMetadata("claude-code", recallMetadataRounds),
            }),
            preparedRounds,
        };
    };
    if (tail.status === "unchanged" && tail.checkpoint) {
        const cachedRounds = iterateCachedConversationSourceCacheRounds<ConversationRound>({
            key: previous.key,
            generation: previous.generation,
        });
        if (!cachedRounds) return null;
        return buildClaudePrepared([cachedRounds.rounds], previous.snapshot.totalSteps, tail.checkpoint, "Claude Code JSONL 内容未变化，复用上一代 fetch 缓存轮次");
    }
    if (tail.status !== "ok" || !tail.checkpoint) return null;
    const prefix = tail.replaceFromRound > 1
        ? iterateCachedConversationSourceCacheRounds<ConversationRound>({
            key: previous.key,
            generation: previous.generation,
            startRound: 1,
            endRound: tail.replaceFromRound - 1,
        })
        : null;
    if (tail.replaceFromRound > 1 && !prefix) return null;
    const normalizedTail = mergeConsecutiveHumanRounds(tail.rounds, tail.replaceFromRound);
    const totalSteps = normalizedTail.at(-1)?.endStep || previous.snapshot.totalSteps;
    return buildClaudePrepared(
        [...(prefix ? [prefix.rounds] : []), normalizedTail],
        totalSteps,
        tail.checkpoint,
        `Claude Code JSONL 仅重放第 ${tail.replaceFromRound} 轮起的追加尾部`,
    );
}

function conversationSourceCacheKey(
    resolved: ResolvedConversationChain,
    conversationId: string,
    options: Pick<ConversationLoadOptions, "link" | "logicalChain" | "source">,
): ConversationSourceCacheKey {
    const variant = resolved === "codex"
        ? `:link=${options.link || "summary"}`
        : resolved === "claude-code"
            ? `:logical=${options.logicalChain || "off"}`
            : "";
    return { source: `${resolved}${variant}`, conversationId };
}

function fileFingerprint(filePath: string | undefined): ConversationSourceFingerprint | null {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return { path: filePath, size: stat.size, mtime: stat.mtimeMs };
}

function localConversationSourceFingerprint(
    resolved: ResolvedConversationChain,
    conversationId: string,
    source: ConversationRawSource,
): ConversationSourceFingerprint | null {
    if (resolved === "codex") return fileFingerprint(getCodexThread(conversationId)?.rolloutPath);
    if (resolved === "claude-code") return fileFingerprint(getClaudeCodeThread(conversationId)?.jsonlPath);
    if (resolved === "windsurf" || resolved === "antigravity") {
        if (source === "ls") return null;
        const candidates = discoverLocalPbCandidates(resolved, conversationId);
        return candidates.length ? fingerprintLocalPbCandidates(candidates) : null;
    }
    return null;
}

function nextUnversionedLsFingerprint(resolved: "antigravity" | "windsurf", conversationId: string): ConversationSourceFingerprint {
    unversionedLsFingerprintSequence += 1;
    return { revision: `${resolved}:ls-unversioned:${conversationId}:${unversionedLsFingerprintSequence}` };
}

async function lsConversationSourceFingerprint(
    resolved: "antigravity" | "windsurf",
    conversationId: string,
    requestClass?: ConcurrencyGateRequestClass,
    allowUnversioned = true,
): Promise<ConversationSourceFingerprint | null> {
    if (resolved === "antigravity") {
        const listing = await listLiveAntigravityConversationIds();
        const watermark = listing.eventWatermarks[conversationId];
        return typeof watermark === "string" && watermark
            ? { revision: `antigravity:ls:${watermark}` }
            : listing.ids.includes(conversationId) && allowUnversioned
                ? nextUnversionedLsFingerprint(resolved, conversationId)
                : null;
    }

    const thread = (await listRecentWindsurfThreads(500, { requestClass }))
        .find(item => item.id === conversationId || item.cascadeId === conversationId);
    if (thread?.lastModifiedTime) {
        return { revision: `windsurf:ls:${thread.lastModifiedTime}:${thread.stepCount}` };
    }
    return thread && allowUnversioned ? nextUnversionedLsFingerprint(resolved, conversationId) : null;
}

function fingerprintRevision(fingerprint: ConversationSourceFingerprint | null): string | null {
    if (!fingerprint) return null;
    return JSON.stringify({
        path: fingerprint.path,
        size: fingerprint.size,
        mtime: fingerprint.mtime,
        revision: fingerprint.revision,
    });
}

function autoLsFingerprint(
    live: ConversationSourceFingerprint | null,
    local: ConversationSourceFingerprint | null,
): ConversationSourceFingerprint {
    return {
        revision: JSON.stringify({
            version: 1,
            live: fingerprintRevision(live),
            local: fingerprintRevision(local),
        }),
    };
}

function localFingerprintMatchesAutoLsCache(
    previous: ConversationSourceFingerprint | null | undefined,
    local: ConversationSourceFingerprint | null,
): boolean {
    if (!previous?.revision) return false;
    try {
        const revision = JSON.parse(previous.revision) as { version?: unknown; local?: unknown };
        return revision.version === 1 && revision.local === fingerprintRevision(local);
    } catch {
        return false;
    }
}

function cachedConversationAuthority(
    previous: ReturnType<typeof readCachedConversationSourceCache<CachedConversationLoadResult>>,
): ConversationCacheAuthority | null {
    const authority = previous?.snapshot.cacheAuthority;
    if (authority === "local" || authority === "ls") return authority;
    const diagnostics = previous?.snapshot.sourceDiagnostics || [];
    if (diagnostics.some(item => /来源比较: .*采用 LS$/u.test(item) || /^(Antigravity|Windsurf) LS:/u.test(item))) return "ls";
    if (diagnostics.some(item => /来源比较: .*采用 本地 PB$/u.test(item) || /^本地 PB:/u.test(item))) return "local";
    return null;
}

async function prepareConversationCacheFreshness(
    resolved: ResolvedConversationChain,
    conversationId: string,
    source: ConversationRawSource,
    previous: ReturnType<typeof readCachedConversationSourceCache<CachedConversationLoadResult>>,
    requestClass?: ConcurrencyGateRequestClass,
): Promise<ConversationCacheFreshness> {
    if (resolved !== "antigravity" && resolved !== "windsurf") {
        if (resolved === "dsh") {
            const snapshot = (await listDshSessionSnapshots()).find(item => item.id === conversationId);
            return {
                fingerprint: snapshot
                    ? {
                        path: snapshot.provenance.sourcePath,
                        size: snapshot.provenance.sourceSizeBytes,
                        mtime: snapshot.provenance.sourceMtimeMs,
                        revision: snapshot.fingerprint,
                    }
                    : null,
                buildSource: "local",
            };
        }
        return { fingerprint: localConversationSourceFingerprint(resolved, conversationId, source), buildSource: source };
    }
    if (source === "ls") {
        const fingerprint = await lsConversationSourceFingerprint(resolved, conversationId, requestClass);
        return {
            fingerprint: fingerprint || nextUnversionedLsFingerprint(resolved, conversationId),
            buildSource: "ls",
        };
    }
    if (source === "auto") {
        const local = localConversationSourceFingerprint(resolved, conversationId, "local");
        let live: ConversationSourceFingerprint | null = null;
        try {
            live = await lsConversationSourceFingerprint(resolved, conversationId, requestClass, false);
        } catch {
            live = null;
        }
        const fingerprint = autoLsFingerprint(live, local);
        return {
            fingerprint,
            buildSource: "auto",
        };
    }
    return { fingerprint: localConversationSourceFingerprint(resolved, conversationId, source), buildSource: source };
}

function hydrateConversationCache(
    snapshot: CachedConversationLoadResult,
    generation: string,
    cacheState: "hit" | "built" | "stale",
    fingerprint: ConversationSourceFingerprint | null,
    key: ConversationSourceCacheKey,
    sourceMode: ConversationRawSource,
    options: Pick<ConversationLoadOptions, "includeRounds" | "roundRange"> = {},
    cachedRoundCount?: number,
    cacheBuildFailure?: ConversationSourceCacheBuildFailure,
    cacheCreatedAt?: string,
): ConversationLoadResult | null {
    const roundResult = options.includeRounds === false
        ? null
        : readCachedConversationSourceCacheRounds<ConversationRound>({
            key,
            generation,
            startRound: options.roundRange?.startRound,
            endRound: options.roundRange?.endRound,
        });
    if (options.includeRounds !== false && !roundResult) return null;
    const rounds = roundResult ? roundResult.rounds : [];
    if (snapshot.chainUsed === "dsh" && options.includeRounds !== false) {
        assertDshReadableBody(rounds, snapshot.conversationId, snapshot.dshData?.provenance.sourcePath);
    }
    const roundCount = roundResult?.roundCount || cachedRoundCount || snapshot.roundCount || snapshot.rounds.length;
    const { cacheAuthority: _cacheAuthority, ...snapshotData } = snapshot;
    const loaded: ConversationLoadResult = {
        ...snapshotData,
        rounds,
        roundCount,
        roundStart: options.roundRange?.startRound || 1,
        cacheKey: { ...key },
        cacheGeneration: generation,
        cacheCreatedAt,
        cacheState,
        cacheBuildFailure,
        cacheFingerprint: fingerprint,
        sourceMode,
    };
    if (loaded.codexData) loaded.codexData = { ...loaded.codexData, rounds };
    if (loaded.claudeCodeData) loaded.claudeCodeData = { ...loaded.claudeCodeData, rounds };
    if (loaded.windsurfData) loaded.windsurfData = { ...loaded.windsurfData, rounds };
    if (loaded.dshData) loaded.dshData = { ...loaded.dshData, rounds };
    return loaded;
}

function loadConversationCacheOnly(
    key: ConversationSourceCacheKey,
    sourceMode: ConversationRawSource,
    options: Pick<ConversationLoadOptions, "includeRounds" | "roundRange"> = {},
): ConversationLoadResult | null {
    const cached = readConversationSourceCacheOnly<ConversationLoadResult>({ key });
    if (!cached) return null;
    return hydrateConversationCache(cached.snapshot, cached.generation, cached.cacheState, cached.fingerprint, key, sourceMode, options, cached.roundCount, cached.buildFailure, cached.createdAt);
}

function localPbToConversationResult(
    resolved: "antigravity" | "windsurf",
    conversationId: string,
): CachedConversationLoadResult | null {
    const local = loadLocalPbConversation(resolved, conversationId);
    if (!local) return null;
    const diagnostics = [
        `本地 PB: ${local.candidateKinds.join("+")}，${local.rounds.length} 轮/${local.totalSteps} 步${local.partial ? "（部分候选解码失败）" : ""}`,
        ...local.diagnostics.map(diagnostic => (
            `本地 PB ${diagnostic.kind}: ${diagnostic.status}${diagnostic.errorCode ? `/${diagnostic.errorCode}` : ""}，${diagnostic.message}`
        )),
    ];
    if (resolved === "antigravity") {
        return {
            chainUsed: resolved,
            conversationId,
            rounds: local.rounds,
            totalSteps: local.totalSteps,
            cacheAuthority: "local",
            trajectory: {
                id: local.selected.trajectory.id || conversationId,
                steps: local.selected.trajectory.steps,
                numTotalSteps: local.totalSteps,
            },
            sourceDiagnostics: diagnostics,
        };
    }
    const steps = local.selected.trajectory.steps;
    const windsurfData: WindsurfConversationReadResult = {
        cascadeId: conversationId,
        thread: {
            id: conversationId,
            cascadeId: conversationId,
            trajectoryId: local.selected.trajectory.id,
            title: conversationId,
            summary: "",
            stepCount: local.totalSteps,
        },
        steps,
        rounds: local.rounds,
        pagesRead: 0,
        totalSteps: local.totalSteps,
        partial: local.partial,
        warnings: diagnostics,
    };
    return { chainUsed: resolved, conversationId, rounds: local.rounds, totalSteps: local.totalSteps, cacheAuthority: "local", windsurfData, sourceDiagnostics: diagnostics };
}

async function lsConversationResult(
    resolved: "antigravity" | "windsurf",
    conversationId: string,
    options: ConversationLoadOptions,
): Promise<CachedConversationLoadResult | null> {
    if (resolved === "antigravity") {
        const result = await fetchTrajectory(conversationId, options.refresh);
        if (!result) return null;
        const trajectory = result.trajectory || {};
        const steps = trajectory.steps || [];
        return {
            chainUsed: resolved,
            conversationId,
            rounds: mergeConsecutiveHumanRounds(parseRounds(steps)),
            totalSteps: trajectory.numTotalSteps || steps.length,
            cacheAuthority: "ls",
            fromCache: result.fromCache,
            trajectory,
            sourceDiagnostics: [`Antigravity LS: ${trajectory.numTotalSteps || steps.length} 步`],
        };
    }
    const windsurfData = await loadWindsurfConversation(conversationId, options.refresh, { requestClass: options.requestClass });
    if (!windsurfData) return null;
    const rounds = mergeConsecutiveHumanRounds(windsurfData.rounds);
    return {
        chainUsed: resolved,
        conversationId,
        rounds,
        totalSteps: windsurfData.totalSteps,
        cacheAuthority: "ls",
        windsurfData: { ...windsurfData, rounds },
        sourceDiagnostics: [`Windsurf LS: ${windsurfData.totalSteps} 步${windsurfData.partial ? "（不完整）" : ""}`],
    };
}

async function loadRawConversationData(
    resolved: ResolvedConversationChain,
    effectiveId: string,
    options: ConversationLoadOptions,
): Promise<CachedConversationLoadResult | null> {
    const source = options.source || "auto";

    if (resolved === "antigravity" || resolved === "windsurf") {
        if (source === "local") return localPbToConversationResult(resolved, effectiveId);
        if (source === "ls") return lsConversationResult(resolved, effectiveId, options);
        let local: ConversationLoadResult | null = null;
        let localError: unknown;
        try {
            local = localPbToConversationResult(resolved, effectiveId);
        } catch (error) {
            localError = error;
        }
        let live: ConversationLoadResult | null = null;
        let liveError: unknown;
        try {
            live = await lsConversationResult(resolved, effectiveId, options);
        } catch (error) {
            liveError = error;
        }
        if (local && live) {
            const relation = compareConversationRoundCompleteness(local.rounds, live.rounds);
            if (relation === "conflict") {
                throw new Error(`${resolved} 本地 PB 与 LS 内容冲突，拒绝盲目拼接`);
            }
            const selected = relation === "live_contains_local" ? live : local;
            selected.sourceDiagnostics = [
                ...(local.sourceDiagnostics || []),
                ...(live.sourceDiagnostics || []),
                `来源比较: ${relation}，采用 ${selected === local ? "本地 PB" : "LS"}`,
            ];
            return selected;
        }
        if (local) {
            if (liveError) local.sourceDiagnostics = [...(local.sourceDiagnostics || []), `LS 不可用: ${liveError instanceof Error ? liveError.message : String(liveError)}`];
            return local;
        }
        if (live) {
            if (localError) live.sourceDiagnostics = [...(live.sourceDiagnostics || []), `本地 PB 不可用: ${localError instanceof Error ? localError.message : String(localError)}`];
            return live;
        }
        if (localError) throw localError;
        if (liveError) throw liveError;
        return null;
    }

    if (resolved === "claude-code") {
        const claudeCodeData = await loadClaudeCodeConversationAsync(effectiveId, { logicalChain: options.logicalChain });
        if (!claudeCodeData) return null;
        return {
            chainUsed: "claude-code",
            conversationId: effectiveId,
            rounds: mergeConsecutiveHumanRounds(claudeCodeData.rounds),
            totalSteps: claudeCodeData.totalSteps,
            claudeCodeData: { ...claudeCodeData, rounds: mergeConsecutiveHumanRounds(claudeCodeData.rounds) },
        };
    }

    if (resolved === "dsh") {
        if (source === "ls") throw new Error("source=ls 不支持 dsh；DSH 的权威原始源是本地 session-persistence-jsonl");
        const read = await readDshSession(effectiveId);
        const converted = normalizeDshSessionReadResult(read);
        const rounds = converted.rounds;
        assertDshReadableBody(rounds, effectiveId, read.provenance.sourcePath);
        const lastEvent = read.events.at(-1);
        const lastSequence = typeof lastEvent?.seq === "number" ? lastEvent.seq : null;
        return {
            chainUsed: "dsh",
            conversationId: effectiveId,
            rounds,
            totalSteps: rounds.at(-1)?.endStep || read.events.length,
            cacheAuthority: "local",
            dshData: {
                header: read.header,
                provenance: read.provenance,
                diagnostics: converted.diagnostics,
                rounds,
            },
            sourceRevision: {
                revision: read.fingerprint,
                contentCursor: lastSequence === null ? null : String(lastSequence),
                eventWatermark: String(read.provenance.sourceMtimeMs),
                sequence: lastSequence,
            },
            sourceDiagnostics: [
                `DSH 本地 ${read.provenance.format}: ${rounds.length} 轮/${read.events.length} 事件`,
                `DSH format v${read.header.version}，source=${read.provenance.sourcePath}`,
                ...(read.provenance.ignoredTrailingTextRecord || read.provenance.ignoredTrailingZstdFrame
                    ? ["DSH 活动日志存在尚未提交完成的尾部，本次缓存只包含最后一个完整记录"]
                    : []),
                ...converted.diagnostics.slice(0, 20).map(item => `DSH ${item.code}@${item.eventIndex}/${item.eventType}: ${item.detail}`),
            ],
        };
    }

    const codexData = await loadCodexConversationAsync(effectiveId, options.link || "summary");
    if (!codexData) return null;
    const rounds = mergeConsecutiveHumanRounds(codexData.rounds);
    return {
        chainUsed: "codex",
        conversationId: effectiveId,
        rounds,
        totalSteps: codexData.totalSteps,
        codexData: { ...codexData, rounds },
    };
}
