import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { ConversationRound } from "./trajectory.js";
import type { ConversationAttachment } from "./conversation-attachments.js";
import { AdaptiveConcurrencyGate } from "./adaptive-concurrency.js";
import type { CallOutcome } from "./call-outcome.js";
import { FifoConcurrencyGate, type ConcurrencyGateRequestClass } from "./concurrency-gate.js";
import {
    resolveEndpointForConversation,
    invalidateMapping,
    type RouterEndpoint,
} from "./conversation-router.js";
import { windsurfCascadeExistsLocally } from "./windsurf-local-store.js";
import {
    buildExactFetchEvidence,
    buildFullSourceReadEvidence,
    buildRecordSourceSnapshot,
    buildSourceEnumerationEvidence,
    classifySourceEvidence,
    SOURCE_EVIDENCE_ADAPTER_VERSION,
    type ExactFetchEvidence,
    type FullSourceReadEvidence,
    type RecordSourceSnapshot,
    type SourceConversationIdentity,
    type SourceEvidenceClassification,
    type SourceEvidenceIssue,
    type SourceEnumerationEvidence,
    type SourceRevision,
} from "./source-evidence-contracts.js";

const execFileAsync = promisify(execFile);

const WINDSURF_SERVICE_PREFIX = "exa.language_server_pb.LanguageServerService";
const WINDSURF_CSRF_ENV = "WINDSURF_CSRF_TOKEN";
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_MAX_OVERSIZED_STEP_SKIPS = 50;
const POWERSHELL_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_WINDSURF_CACHE_TTL_MS = 30 * 60_000;
const DEFAULT_WINDSURF_CACHE_MAX_ENTRIES = 10;
const DEFAULT_WINDSURF_CACHE_REVALIDATE_MS = 5_000;
const DEFAULT_WINDSURF_LS_CONCURRENCY = 6;
const DEFAULT_WINDSURF_LS_RESERVED_SLOTS = 2;
const DEFAULT_WINDSURF_TIMING_SLOW_MS = 250;
const DEFAULT_WINDSURF_SOURCE_EVIDENCE_MAX_PAGES = 200;
const WINDSURF_IMAGE_ATTACHMENT_MAX_ENCODED_CHARS = 8 * 1024 * 1024;
const WINDSURF_IMAGE_ATTACHMENT_MAX_DECODED_BYTES = Math.floor((WINDSURF_IMAGE_ATTACHMENT_MAX_ENCODED_CHARS * 3) / 4);
const READ_ONLY_METHODS = new Set([
    "Heartbeat",
    "GetAllCascadeTrajectories",
    "GetCascadeTrajectorySteps",
]);

export interface WindsurfLsProcessCandidate {
    pid: number;
    executablePath?: string;
    commandLine?: string;
    extensionServerPort?: number;
}

export interface WindsurfLsEndpoint extends WindsurfLsProcessCandidate {
    port: number;
    csrfToken: string;
}

export interface WindsurfConversationSummary {
    id: string;
    cascadeId: string;
    trajectoryId?: string;
    title: string;
    renamedTitle?: string;
    titleBestEffort?: string;
    titleSource?: "renamedTitle" | "titleBestEffort" | "summary" | "title" | "fallback";
    isChildThread?: boolean;
    parentConversationId?: string | null;
    agentRole?: string | null;
    agentNickname?: string | null;
    summary: string;
    stepCount: number;
    createdTime?: string;
    lastModifiedTime?: string;
    status?: string;
    trajectoryType?: string;
    lastGeneratorModelUid?: string;
    cwd?: string;
    workspaceUris?: string[];
    referencedFiles?: string[];
}

export interface WindsurfConversationReadResult {
    cascadeId: string;
    thread: WindsurfConversationSummary;
    steps: unknown[];
    rounds: ConversationRound[];
    pagesRead: number;
    totalSteps: number;
    partial?: boolean;
    skippedSteps?: WindsurfSkippedStep[];
    warnings?: string[];
    metadata?: WindsurfConversationMetadata;
}

export interface WindsurfLsTransportDiagnostics {
    method: string;
    requestClass: ConcurrencyGateRequestClass;
    queueWaitMs: number;
    active: number;
    pending: number;
    limit: number;
    current: number;
    max: number;
    min: number;
    successes: number;
    failures: number;
    configuredReserved: number;
    effectiveReserved: number;
    activeForeground: number;
    activeBackground: number;
    pendingForeground: number;
    pendingBackground: number;
    borrowing: boolean;
}

export interface WindsurfLsTransportCallOptions {
    timeoutMs?: number;
    deadlineAt?: number;
    shouldCancel?: () => boolean;
    cancelMessage?: string;
    timeoutMessage?: string;
    requestClass?: ConcurrencyGateRequestClass;
    onConcurrencyEvent?: (diagnostics: WindsurfLsTransportDiagnostics) => void;
}

export type WindsurfLsTransport = (
    method: string,
    payload?: Record<string, unknown>,
    options?: WindsurfLsTransportCallOptions,
) => Promise<unknown>;

const windsurfLsOutcomeReporter = Symbol("windsurfLsOutcomeReporter");

type InternalWindsurfLsTransportCallOptions = WindsurfLsTransportCallOptions & {
    [windsurfLsOutcomeReporter]?: (outcome: CallOutcome) => void;
};

interface ReadStepsOptions {
    maxPages?: number;
    startOffset?: number;
    maxSkippedOversizedSteps?: number;
    timingCollector?: WindsurfTimingCollector;
}

export interface WindsurfStepPageTiming {
    offset: number;
    durationMs: number;
    stepCount: number;
}

export interface WindsurfTimingBreakdown {
    totalMs: number;
    resolveEndpointMs?: number;
    stepsReadMs?: number;
    enrichMs?: number;
    roundConversionMs?: number;
    stepPages?: WindsurfStepPageTiming[];
}

export interface WindsurfConversationMetadata {
    cache?: {
        status: "hit" | "miss" | "refresh" | "stale-fallback";
        refreshRequested: boolean;
        ttlMs: number;
        maxEntries: number;
        cachedAt?: string;
        ageMs?: number;
        lastValidatedAt?: string;
        revalidateWindowMs?: number;
        authoritativeStepCount?: number;
        cachedStepCount?: number;
        reason?: string;
    };
    lsConcurrency?: {
        calls: number;
        queueWaitMs: number;
        maxQueueWaitMs: number;
        active: number;
        pending: number;
        limit: number;
        current: number;
        max: number;
        min: number;
        successes: number;
        failures: number;
        configuredReserved: number;
        effectiveReserved: number;
        activeForeground: number;
        activeBackground: number;
        pendingForeground: number;
        pendingBackground: number;
        borrowing: boolean;
    };
    source?: {
        reason?: "ok" | "not_held" | "no_ls";
        fromMapping?: boolean;
        endpointPid?: number;
        endpointPort?: number;
        retriedAfterInvalidate?: boolean;
    };
    timings?: WindsurfTimingBreakdown;
}

interface WindsurfTimingCollector {
    resolveEndpointMs?: number;
    stepsReadMs?: number;
    enrichMs?: number;
    roundConversionMs?: number;
    pageReads: WindsurfStepPageTiming[];
}

interface WindsurfConversationCacheEntry {
    cachedAt: number;
    lastValidatedAt: number;
    result: WindsurfConversationReadResult;
    authoritativeStepCount: number;
}

type WindsurfLsConcurrencyAccumulator = NonNullable<WindsurfConversationMetadata["lsConcurrency"]>;

export interface WindsurfSkippedStep {
    offset: number;
    reason: "oversized";
    byteLimit?: number;
    message: string;
}

interface RunCommandOptions {
    timeoutMs?: number;
}

type RunCommand = (file: string, args: string[], options?: RunCommandOptions) => Promise<{ stdout: string; stderr: string }>;

interface WindsurfSubagentJobsCache {
    path: string;
    mtimeMs: number;
    jobs: Map<string, WindsurfSubagentJobInfo>;
}

let windsurfSubagentJobsCache: WindsurfSubagentJobsCache | null = null;

export interface WindsurfSubagentJobInfo {
    jobId: string;
    subCid: string;
    mainId: string;
    label?: string;
    titleBestEffort?: string;
    state?: string;
    mode?: string;
    model?: string;
    createdAt?: string;
    updatedAt?: string;
    completedAt?: string;
    resultStepCount?: number;
    resultPreview?: string;
    archivePath?: string;
}

function truncate(input: string, maxChars: number): string {
    if (input.length <= maxChars) return input;
    return `${input.slice(0, maxChars)}...`;
}

function toStringValue(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function decodePathLikeUri(value: unknown): string | undefined {
    const raw = toStringValue(value).trim();
    if (!raw) return undefined;
    if (/^file:\/\//iu.test(raw)) {
        try {
            return fileURLToPath(raw);
        } catch {
            try {
                return decodeURIComponent(raw.replace(/^file:\/\/\/?/iu, ""));
            } catch {
                return raw;
            }
        }
    }
    return raw;
}

function pushUniquePath(target: string[], value: unknown): void {
    const decoded = decodePathLikeUri(value);
    if (!decoded) return;
    if (!target.some(item => item.toLowerCase() === decoded.toLowerCase())) {
        target.push(decoded);
    }
}

function extractWorkspaceUrisFromRecord(record: Record<string, any>): string[] {
    const result: string[] = [];
    for (const workspace of asArray(record.workspaces)) {
        const workspaceRecord = asRecord(workspace);
        pushUniquePath(
            result,
            workspaceRecord.workspaceFolderAbsoluteUri
                ?? workspaceRecord.workspaceUri
                ?? workspaceRecord.uri
                ?? workspaceRecord.path
                ?? workspaceRecord.workspace,
        );
    }
    const candidates = [
        record.workspaceUri,
        record.workspace,
        record.cwd,
        record.projectRoot,
        asRecord(record.activeWorkspace).uri,
        asRecord(record.activeWorkspace).path,
        asRecord(record.localNodeState).workspaceUri,
    ];
    for (const candidate of candidates) {
        pushUniquePath(result, candidate);
    }
    return result;
}

function extractWorkspaceFromRecord(record: Record<string, any>): string | undefined {
    return extractWorkspaceUrisFromRecord(record)[0];
}

function extractReferencedFilesFromRecord(record: Record<string, any>): string[] {
    const result: string[] = [];
    for (const item of asArray(record.referencedFiles)) {
        const itemRecord = asRecord(item);
        if (Object.keys(itemRecord).length > 0) {
            pushUniquePath(result, itemRecord.absolutePathUri ?? itemRecord.uri ?? itemRecord.path ?? itemRecord.filePath ?? itemRecord.name);
        } else {
            pushUniquePath(result, item);
        }
    }
    return result;
}

function toNumberValue(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return 0;
}

function readPositiveEnvNumber(name: string, fallback: number, min = 1): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= min ? value : fallback;
}

function readNonNegativeEnvNumber(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function getWindsurfConversationCacheTtlMs(): number {
    return readPositiveEnvNumber("MEMORY_STORE_WINDSURF_CACHE_TTL_MS", DEFAULT_WINDSURF_CACHE_TTL_MS);
}

function getWindsurfConversationCacheMaxEntries(): number {
    return Math.max(1, readPositiveEnvNumber("MEMORY_STORE_WINDSURF_CACHE_MAX_ENTRIES", DEFAULT_WINDSURF_CACHE_MAX_ENTRIES));
}

function getWindsurfCacheRevalidateMs(): number {
    return readNonNegativeEnvNumber("MEMORY_STORE_WINDSURF_CACHE_REVALIDATE_MS", DEFAULT_WINDSURF_CACHE_REVALIDATE_MS);
}

function getWindsurfLsConcurrencyMax(): number {
    return Math.max(1, readPositiveEnvNumber("MEMORY_STORE_WINDSURF_LS_CONCURRENCY", DEFAULT_WINDSURF_LS_CONCURRENCY));
}

function getWindsurfLsReservedSlots(): number {
    const value = Number(process.env.MEMORY_STORE_WINDSURF_LS_RESERVED_SLOTS);
    return Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : DEFAULT_WINDSURF_LS_RESERVED_SLOTS;
}

function createWindsurfLsAdaptiveGate(): AdaptiveConcurrencyGate {
    return new AdaptiveConcurrencyGate(getWindsurfLsConcurrencyMax(), 1, 1);
}

let windsurfLsAdaptiveGate = createWindsurfLsAdaptiveGate();

function getWindsurfLsConcurrency(): number {
    return windsurfLsAdaptiveGate.limit;
}

const windsurfLsConcurrencyGate = new FifoConcurrencyGate(
    () => getWindsurfLsConcurrency(),
    { reservedSlots: getWindsurfLsReservedSlots },
);

let windsurfLsGateAcquireCount = 0;
let windsurfLsGateQueueWaitMsTotal = 0;
let windsurfLsGateMaxQueueWaitMs = 0;
let windsurfLsGateLastQueueWaitMs = 0;

function resolveWindsurfCallDeadlineAt(options: WindsurfLsTransportCallOptions = {}, startedAt = Date.now()): number {
    const requestedTimeoutMs = Number.isFinite(options.timeoutMs) && Number(options.timeoutMs) >= 0
        ? Number(options.timeoutMs)
        : FETCH_TIMEOUT_MS;
    const deadlineCandidates = [startedAt + requestedTimeoutMs];
    if (Number.isFinite(options.deadlineAt)) {
        deadlineCandidates.push(Number(options.deadlineAt));
    }
    return Math.min(...deadlineCandidates);
}

function remainingTimeoutMs(deadlineAt: number, now = Date.now()): number {
    return Math.max(0, deadlineAt - now);
}

function normalizeWindsurfTransportError(method: string, error: unknown): Error {
    const message = error instanceof Error ? redactSensitive(error.message) : redactSensitive(String(error));
    if (message.startsWith(`WSF LS ${method} failed:`)) {
        return new Error(message);
    }
    return new Error(`WSF LS ${method} failed: ${message}`);
}

function isAbortLikeError(error: unknown): boolean {
    if (error instanceof Error) {
        if (error.name === "AbortError") return true;
        if (/aborted/iu.test(error.message)) return true;
    }
    return false;
}

function wasWindsurfCallCancelled(options: WindsurfLsTransportCallOptions, error: unknown): boolean {
    try {
        if (options.shouldCancel?.()) return true;
    } catch {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return /\bcancell?ed\b|\bcancellation\b/iu.test(message);
}

function reportWindsurfLsTransportOutcome(options: WindsurfLsTransportCallOptions, outcome: CallOutcome): void {
    (options as InternalWindsurfLsTransportCallOptions)[windsurfLsOutcomeReporter]?.(outcome);
}

function recordWindsurfLsTransportOutcome(outcome: CallOutcome): void {
    if (outcome.success) {
        if (windsurfLsAdaptiveGate.onSuccess()) {
            windsurfLsConcurrencyGate.notifyCapacityIncrease();
        }
        return;
    }
    if (
        outcome.errorKind === "rate_limit"
        || outcome.errorKind === "server_error"
        || outcome.errorKind === "timeout"
        || outcome.errorKind === "network"
    ) {
        windsurfLsAdaptiveGate.onFailure();
    }
}

function mergeConcurrencyEvent(
    outer: WindsurfLsTransportCallOptions["onConcurrencyEvent"],
    inner: WindsurfLsTransportCallOptions["onConcurrencyEvent"],
): WindsurfLsTransportCallOptions["onConcurrencyEvent"] {
    if (!outer) return inner;
    if (!inner) return outer;
    return (diagnostics) => {
        outer(diagnostics);
        inner(diagnostics);
    };
}

function createWindsurfLsConcurrencyAccumulator(): WindsurfLsConcurrencyAccumulator {
    const adaptive = windsurfLsAdaptiveGate.snapshot();
    const gate = windsurfLsConcurrencyGate.stats();
    return {
        calls: 0,
        queueWaitMs: 0,
        maxQueueWaitMs: 0,
        active: 0,
        pending: 0,
        limit: adaptive.current,
        current: adaptive.current,
        max: adaptive.max,
        min: adaptive.min,
        successes: adaptive.successes,
        failures: adaptive.failures,
        configuredReserved: gate.configuredReserved ?? 0,
        effectiveReserved: gate.effectiveReserved ?? 0,
        activeForeground: gate.activeForeground ?? 0,
        activeBackground: gate.activeBackground ?? 0,
        pendingForeground: gate.pendingForeground ?? 0,
        pendingBackground: gate.pendingBackground ?? 0,
        borrowing: gate.borrowing ?? false,
    };
}

function recordWindsurfLsConcurrency(
    target: WindsurfLsConcurrencyAccumulator,
    diagnostics: WindsurfLsTransportDiagnostics,
): void {
    target.calls += 1;
    target.queueWaitMs += diagnostics.queueWaitMs;
    target.maxQueueWaitMs = Math.max(target.maxQueueWaitMs, diagnostics.queueWaitMs);
    target.active = Math.max(target.active, diagnostics.active);
    target.pending = Math.max(target.pending, diagnostics.pending);
    target.limit = diagnostics.limit;
    target.current = diagnostics.current;
    target.max = diagnostics.max;
    target.min = diagnostics.min;
    target.successes = diagnostics.successes;
    target.failures = diagnostics.failures;
    target.configuredReserved = diagnostics.configuredReserved;
    target.effectiveReserved = diagnostics.effectiveReserved;
    target.activeForeground = Math.max(target.activeForeground, diagnostics.activeForeground);
    target.activeBackground = Math.max(target.activeBackground, diagnostics.activeBackground);
    target.pendingForeground = Math.max(target.pendingForeground, diagnostics.pendingForeground);
    target.pendingBackground = Math.max(target.pendingBackground, diagnostics.pendingBackground);
    target.borrowing ||= diagnostics.borrowing;
}

function cloneWindsurfLsConcurrency(
    value: WindsurfConversationMetadata["lsConcurrency"],
): WindsurfConversationMetadata["lsConcurrency"] {
    return value ? { ...value } : undefined;
}

function isWindsurfCacheFresh(entry: WindsurfConversationCacheEntry, now = Date.now()): boolean {
    const revalidateMs = getWindsurfCacheRevalidateMs();
    return revalidateMs > 0 && now - entry.lastValidatedAt <= revalidateMs;
}

function refreshCachedWindsurfConversationValidation(
    cascadeId: string,
    authoritativeStepCount?: number,
    now = Date.now(),
): WindsurfConversationCacheEntry | null {
    const entry = windsurfConversationCache.get(cascadeId);
    if (!entry) return null;
    entry.lastValidatedAt = now;
    if (Number.isFinite(authoritativeStepCount) && Number(authoritativeStepCount) > 0) {
        entry.authoritativeStepCount = Math.max(entry.authoritativeStepCount, Number(authoritativeStepCount));
    }
    windsurfConversationCache.delete(cascadeId);
    windsurfConversationCache.set(cascadeId, entry);
    return entry;
}

function isWindsurfTimingDebugEnabled(): boolean {
    return process.env.MEMORY_STORE_WINDSURF_READ_TIMING_DEBUG === "1";
}

function shouldExposeWindsurfTimings(timings: WindsurfTimingCollector): boolean {
    if (isWindsurfTimingDebugEnabled()) return true;
    const slowMs = readPositiveEnvNumber("MEMORY_STORE_WINDSURF_READ_TIMING_SLOW_MS", DEFAULT_WINDSURF_TIMING_SLOW_MS);
    if ((timings.resolveEndpointMs || 0) >= slowMs) return true;
    if ((timings.stepsReadMs || 0) >= slowMs) return true;
    if ((timings.enrichMs || 0) >= slowMs) return true;
    if ((timings.roundConversionMs || 0) >= slowMs) return true;
    return timings.pageReads.some(page => page.durationMs >= slowMs);
}

function createTimingCollector(): WindsurfTimingCollector {
    return { pageReads: [] };
}

function buildTimingBreakdown(timings: WindsurfTimingCollector): WindsurfTimingBreakdown | undefined {
    const durations = [
        timings.resolveEndpointMs || 0,
        timings.stepsReadMs || 0,
        timings.enrichMs || 0,
        timings.roundConversionMs || 0,
    ];
    if (!shouldExposeWindsurfTimings(timings)) {
        return undefined;
    }
    const stepPages = timings.pageReads.map(page => ({ ...page }));
    const totalMs = durations.reduce((sum, item) => sum + item, 0);
    return {
        totalMs,
        resolveEndpointMs: timings.resolveEndpointMs,
        stepsReadMs: timings.stepsReadMs,
        enrichMs: timings.enrichMs,
        roundConversionMs: timings.roundConversionMs,
        stepPages,
    };
}

function authoritativeStepCountFromResult(
    result: Pick<WindsurfConversationReadResult, "thread" | "totalSteps" | "rounds">,
    stepCountHint = 0,
): number {
    return Math.max(
        stepCountHint,
        result.thread.stepCount || 0,
        result.totalSteps || 0,
        result.rounds.length > 0 ? result.totalSteps || result.thread.stepCount || 0 : 0,
    );
}

function cloneWindsurfConversationResult(result: WindsurfConversationReadResult): WindsurfConversationReadResult {
    return {
        ...result,
        steps: result.steps.slice(),
        rounds: result.rounds.slice(),
        skippedSteps: result.skippedSteps?.map(item => ({ ...item })),
        warnings: result.warnings ? [...result.warnings] : undefined,
        metadata: result.metadata
            ? {
                ...result.metadata,
                cache: result.metadata.cache ? { ...result.metadata.cache } : undefined,
                lsConcurrency: cloneWindsurfLsConcurrency(result.metadata.lsConcurrency),
                source: result.metadata.source ? { ...result.metadata.source } : undefined,
                timings: result.metadata.timings
                    ? {
                        ...result.metadata.timings,
                        stepPages: result.metadata.timings.stepPages?.map(page => ({ ...page })),
                    }
                    : undefined,
            }
            : undefined,
    };
}

function attachWindsurfMetadata(
    result: WindsurfConversationReadResult,
    options: {
        warnings?: string[];
        cache?: WindsurfConversationMetadata["cache"];
        lsConcurrency?: WindsurfConversationMetadata["lsConcurrency"];
        source?: WindsurfConversationMetadata["source"];
        timings?: WindsurfTimingCollector;
    },
): WindsurfConversationReadResult {
    const cloned = cloneWindsurfConversationResult(result);
    const mergedWarnings = [...(cloned.warnings || []), ...(options.warnings || [])]
        .map(item => item.trim())
        .filter(Boolean);
    cloned.warnings = mergedWarnings.length ? [...new Set(mergedWarnings)] : undefined;
    const timings = options.timings ? buildTimingBreakdown(options.timings) : cloned.metadata?.timings;
    cloned.metadata = {
        ...(cloned.metadata || {}),
        cache: options.cache ?? cloned.metadata?.cache,
        lsConcurrency: options.lsConcurrency ?? cloned.metadata?.lsConcurrency,
        source: options.source ?? cloned.metadata?.source,
        timings,
    };
    return cloned;
}

function shouldKeepLastGoodCache(
    result: WindsurfConversationReadResult,
    authoritativeStepCount: number,
): boolean {
    if (result.partial) return true;
    return authoritativeStepCount > 0 && result.rounds.length === 0;
}

function asRecord(value: unknown): Record<string, any> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function asArray(value: unknown): any[] {
    return Array.isArray(value) ? value : [];
}

function defaultWindsurfSubagentJobsPath(): string {
    return process.env.MEMORY_STORE_WSF_SUBAGENT_JOBS_PATH
        || path.join(os.homedir(), ".codeium", "windsurf", "mcp-subagent", "subagent-data", "jobs.json");
}

function firstStringField(record: Record<string, any>, fields: string[]): string {
    for (const field of fields) {
        const value = toStringValue(record[field]).trim();
        if (value) return value;
    }
    return "";
}

function jobInfoFromRecord(record: Record<string, any>): WindsurfSubagentJobInfo | null {
    const subCid = firstStringField(record, [
        "sub_cid",
        "subCid",
        "subCascadeId",
        "subConversationId",
        "childConversationId",
        "child_cid",
    ]);
    const mainId = firstStringField(record, [
        "main_id",
        "mainCid",
        "mainCascadeId",
        "mainConversationId",
        "parentConversationId",
        "parent_cid",
        "owner_conversation_id",
    ]);
    if (!subCid || !mainId || subCid === mainId) return null;
    return {
        jobId: firstStringField(record, ["job_id", "jobId", "id"]) || subCid,
        subCid,
        mainId,
        label: firstStringField(record, ["label", "name"]) || undefined,
        titleBestEffort: firstStringField(record, ["title_best_effort", "titleBestEffort", "title"]) || undefined,
        state: firstStringField(record, ["state", "status"]) || undefined,
        mode: firstStringField(record, ["mode"]) || undefined,
        model: firstStringField(record, ["model", "model_id", "modelId"]) || undefined,
        createdAt: firstStringField(record, ["created_at", "createdAt"]) || undefined,
        updatedAt: firstStringField(record, ["updated_at", "updatedAt"]) || undefined,
        completedAt: firstStringField(record, ["completed_at", "completedAt"]) || undefined,
        resultStepCount: toNumberValue(record.result_step_count ?? record.resultStepCount) || undefined,
        resultPreview: firstStringField(record, ["result_preview", "resultPreview"]) || undefined,
        archivePath: firstStringField(record, ["archive_path", "archivePath"]) || undefined,
    };
}

function collectWindsurfSubagentJobs(value: unknown, target: Map<string, WindsurfSubagentJobInfo>, depth = 0, deletedSubCids = new Set<string>()): void {
    if (depth > 5 || !value) return;
    if (Array.isArray(value)) {
        for (const item of value) collectWindsurfSubagentJobs(item, target, depth + 1, deletedSubCids);
        return;
    }
    const record = asRecord(value);
    if (Object.keys(record).length === 0) return;

    const info = jobInfoFromRecord(record);
    if (info) {
        if ((info.state || "").toLowerCase() === "deleted") {
            deletedSubCids.add(info.subCid);
            target.delete(info.subCid);
        } else if (!deletedSubCids.has(info.subCid)) {
            target.set(info.subCid, info);
        }
    }

    const nested = record.jobs ?? record.items ?? record.data ?? record.records;
    if (nested) {
        collectWindsurfSubagentJobs(nested, target, depth + 1, deletedSubCids);
        return;
    }
    for (const value of Object.values(record)) {
        collectWindsurfSubagentJobs(value, target, depth + 1, deletedSubCids);
    }
}

export function readWindsurfSubagentJobs(): Map<string, WindsurfSubagentJobInfo> {
    const jobsPath = defaultWindsurfSubagentJobsPath();
    try {
        const stat = fs.statSync(jobsPath);
        if (!stat.isFile()) return new Map();
        if (
            windsurfSubagentJobsCache
            && windsurfSubagentJobsCache.path === jobsPath
            && windsurfSubagentJobsCache.mtimeMs === stat.mtimeMs
        ) {
            return new Map(windsurfSubagentJobsCache.jobs);
        }
        const parsed = JSON.parse(fs.readFileSync(jobsPath, "utf8"));
        const jobs = new Map<string, WindsurfSubagentJobInfo>();
        collectWindsurfSubagentJobs(parsed, jobs);
        windsurfSubagentJobsCache = { path: jobsPath, mtimeMs: stat.mtimeMs, jobs };
        return new Map(jobs);
    } catch {
        return new Map();
    }
}

export function readWindsurfSubagentParentMap(): Map<string, string> {
    return new Map([...readWindsurfSubagentJobs().values()].map(job => [job.subCid, job.mainId]));
}

function isWindsurfSubagentTitle(input: string): boolean {
    return /^\s*\[subagent\]/iu.test(input);
}

function windsurfSubagentRoleFromTitle(input: string): string | null {
    const match = input.match(/^\s*\[subagent\]\s*([^：:\-|]+)?/iu);
    const role = match?.[1]?.trim();
    return role || null;
}

function parseJsonOutput(stdout: string): unknown {
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    return JSON.parse(trimmed);
}

function normalizeJsonArray(value: unknown): any[] {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") return [value];
    return [];
}

function parseExtensionServerPort(commandLine?: string): number | undefined {
    const match = commandLine?.match(/--extension_server_port\s+(\d+)/u);
    if (!match) return undefined;
    const port = Number(match[1]);
    return Number.isInteger(port) && port > 0 ? port : undefined;
}

function isWindsurfLsCandidate(candidate: WindsurfLsProcessCandidate): boolean {
    const combined = `${candidate.executablePath || ""}\n${candidate.commandLine || ""}`.toLowerCase();
    const executable = (candidate.executablePath || "").toLowerCase();
    return executable.includes("language_server_windows_x64")
        && executable.includes("windsurf")
        && !executable.includes("powershell.exe")
        && !executable.includes("pwsh.exe")
        && combined.includes("windsurf");
}

async function defaultRunCommand(file: string, args: string[], options: RunCommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync(file, args, {
        timeout: options.timeoutMs ?? POWERSHELL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
    });
    return {
        stdout: result.stdout || "",
        stderr: result.stderr || "",
    };
}

async function runPowerShellJson<T>(script: string, runCommand: RunCommand): Promise<T> {
    const { stdout } = await runCommand("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ], { timeoutMs: POWERSHELL_TIMEOUT_MS });
    return parseJsonOutput(stdout) as T;
}

function redactSensitive(input: string): string {
    return input
        .replace(new RegExp(`${WINDSURF_CSRF_ENV}=([^\\s;]+)`, "giu"), `${WINDSURF_CSRF_ENV}=<redacted>`)
        .replace(/x-codeium-csrf-token["']?\s*[:=]\s*["']?[^"',\s}]+/giu, "x-codeium-csrf-token=<redacted>");
}

export async function findWindsurfLsProcessCandidates(runCommand: RunCommand = defaultRunCommand): Promise<WindsurfLsProcessCandidate[]> {
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        "$items = Get-CimInstance Win32_Process | Where-Object {",
        "  ($_.CommandLine -like '*language_server_windows_x64*' -or $_.ExecutablePath -like '*language_server_windows_x64*') -and",
        "  ($_.CommandLine -like '*windsurf*' -or $_.ExecutablePath -like '*Windsurf*')",
        "} | ForEach-Object {",
        "  $cmd = [string]$_.CommandLine",
        "  $ext = $null",
        "  if ($cmd -match '--extension_server_port\\s+(\\d+)') { $ext = [int]$Matches[1] }",
        "  [pscustomobject]@{ pid = [int]$_.ProcessId; executablePath = [string]$_.ExecutablePath; commandLine = $cmd; extensionServerPort = $ext }",
        "}",
        "$items | ConvertTo-Json -Depth 4",
    ].join("\n");
    const raw = await runPowerShellJson<unknown>(script, runCommand);
    return normalizeJsonArray(raw)
        .map(item => {
            const record = asRecord(item);
            const commandLine = toStringValue(record.commandLine);
            return {
                pid: toNumberValue(record.pid),
                executablePath: toStringValue(record.executablePath) || undefined,
                commandLine: commandLine || undefined,
                extensionServerPort: toNumberValue(record.extensionServerPort) || parseExtensionServerPort(commandLine),
            };
        })
        .filter(candidate => candidate.pid > 0 && isWindsurfLsCandidate(candidate));
}

export async function findWindsurfListenPorts(
    candidate: WindsurfLsProcessCandidate,
    runCommand: RunCommand = defaultRunCommand,
): Promise<number[]> {
    const script = [
        "$ErrorActionPreference = 'Stop'",
        `[int]$pidValue = ${candidate.pid}`,
        "$ports = Get-NetTCPConnection -OwningProcess $pidValue -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort",
        "$ports | ConvertTo-Json",
    ].join("\n");
    const raw = await runPowerShellJson<unknown>(script, runCommand);
    const ports = normalizeJsonArray(raw)
        .map(toNumberValue)
        .filter(port => Number.isInteger(port) && port > 0 && port <= 65_535);
    return ports.filter(port => port !== candidate.extensionServerPort);
}

export async function readWindsurfCsrfToken(pid: number, runCommand: RunCommand = defaultRunCommand): Promise<string | undefined> {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WindsurfProcessEnvironmentReader {
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr Reserved3;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int processAccess, bool bInheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, int dwSize, out IntPtr lpNumberOfBytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr processHandle, int processInformationClass, ref PROCESS_BASIC_INFORMATION processInformation, int processInformationLength, out int returnLength);

    private const int PROCESS_QUERY_INFORMATION = 0x0400;
    private const int PROCESS_VM_READ = 0x0010;

    private static byte[] ReadBytes(IntPtr handle, IntPtr address, int size) {
        byte[] buffer = new byte[size];
        IntPtr bytesRead;
        if (!ReadProcessMemory(handle, address, buffer, size, out bytesRead)) {
            return null;
        }
        int actual = bytesRead.ToInt32();
        if (actual == size) return buffer;
        byte[] trimmed = new byte[Math.Max(0, actual)];
        Array.Copy(buffer, trimmed, trimmed.Length);
        return trimmed;
    }

    private static long ReadPointer(byte[] bytes, int offset) {
        if (IntPtr.Size == 8) return BitConverter.ToInt64(bytes, offset);
        return BitConverter.ToInt32(bytes, offset);
    }

    public static string ReadVariable(int pid, string variableName) {
        IntPtr handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (handle == IntPtr.Zero) return null;
        try {
            PROCESS_BASIC_INFORMATION info = new PROCESS_BASIC_INFORMATION();
            int returnLength;
            int status = NtQueryInformationProcess(handle, 0, ref info, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out returnLength);
            if (status != 0 || info.PebBaseAddress == IntPtr.Zero) return null;

            byte[] peb = ReadBytes(handle, info.PebBaseAddress, 0x80);
            if (peb == null) return null;
            int processParametersOffset = IntPtr.Size == 8 ? 0x20 : 0x10;
            long processParametersAddress = ReadPointer(peb, processParametersOffset);
            if (processParametersAddress == 0) return null;

            byte[] parameters = ReadBytes(handle, new IntPtr(processParametersAddress), IntPtr.Size == 8 ? 0x88 : 0x50);
            if (parameters == null) return null;
            int environmentOffset = IntPtr.Size == 8 ? 0x80 : 0x48;
            long environmentAddress = ReadPointer(parameters, environmentOffset);
            if (environmentAddress == 0) return null;

            byte[] environment = ReadBytes(handle, new IntPtr(environmentAddress), 65536);
            if (environment == null) return null;
            string text = Encoding.Unicode.GetString(environment);
            string prefix = variableName + "=";
            foreach (string entry in text.Split('\0')) {
                if (entry.StartsWith(prefix, StringComparison.Ordinal)) {
                    return entry.Substring(prefix.Length);
                }
            }
            return null;
        } finally {
            CloseHandle(handle);
        }
    }
}
'@
[WindsurfProcessEnvironmentReader]::ReadVariable(${pid}, '${WINDSURF_CSRF_ENV}')
`;
    try {
        const { stdout } = await runCommand("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ], { timeoutMs: POWERSHELL_TIMEOUT_MS });
        const token = stdout.trim();
        return token || undefined;
    } catch (error) {
        const message = error instanceof Error ? redactSensitive(error.message) : "unknown error";
        throw new Error(`Failed to read WSF CSRF token from process ${pid}: ${message}`);
    }
}

/**
 * 发现「全部」活跃 WSF LS 端点（Heartbeat 通），不再只取第一个（核心修复 ④）。
 * discoverWindsurfLsEndpoint 内部改为「全量枚举取 [0]」（语义不变，供 list/可用性探测）。
 */
export async function discoverAllWindsurfLsEndpoints(runCommand: RunCommand = defaultRunCommand): Promise<WindsurfLsEndpoint[]> {
    if (endpointResolverOverride) return endpointResolverOverride();

    const candidates = await findWindsurfLsProcessCandidates(runCommand);
    const endpoints: WindsurfLsEndpoint[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
        const csrfToken = await readWindsurfCsrfToken(candidate.pid, runCommand);
        if (!csrfToken) continue;
        const ports = await findWindsurfListenPorts(candidate, runCommand);
        for (const port of ports) {
            const endpoint: WindsurfLsEndpoint = { ...candidate, port, csrfToken };
            const transport = makeTransport(endpoint);
            try {
                await transport("Heartbeat");
            } catch {
                continue;
            }
            const key = `${endpoint.pid}:${endpoint.port}`;
            if (seen.has(key)) continue;
            seen.add(key);
            endpoints.push(endpoint);
            // 同一进程多端口只保留第一个 Heartbeat 通的（与原 discoverWindsurfLsEndpoint 语义一致）
            break;
        }
    }
    return endpoints;
}

/** 端点池短缓存（替换旧的全局单一 cachedEndpoint，见失败路径 ⑤） */
let cachedEndpointPool: { endpoints: WindsurfLsEndpoint[]; cachedAt: number } | null = null;
let windsurfConversationCache = new Map<string, WindsurfConversationCacheEntry>();
const ENDPOINT_CACHE_TTL_MS = 30_000;

/** 测试注入：替换端点发现（返回固定端点池，离线 mock 不依赖真实 WSF） */
let endpointResolverOverride: (() => Promise<WindsurfLsEndpoint[]>) | null = null;
/** 测试注入：替换 transport 工厂（按 endpoint 返回桩 transport） */
let transportFactoryOverride: ((endpoint: WindsurfLsEndpoint) => WindsurfLsTransport) | null = null;

/** 内部统一 transport 构造入口（受测试工厂覆盖）。导出供路由大脑构造 WSF endpoint 复用，
 *  使 __setWindsurfTransportFactoryForTest 注入对路由广播同样生效。 */
export function makeWindsurfTransport(endpoint: WindsurfLsEndpoint): WindsurfLsTransport {
    const rawTransport = transportFactoryOverride ? transportFactoryOverride(endpoint) : createRawWindsurfLsTransport(endpoint);
    return withWindsurfLsConcurrencyGate(rawTransport);
}

/** 内部别名（保持原有调用点不变） */
function makeTransport(endpoint: WindsurfLsEndpoint): WindsurfLsTransport {
    return makeWindsurfTransport(endpoint);
}

/**
 * 测试专用：注入端点解析器（返回固定端点池）。传 null 还原真实发现。生产代码不调用。
 */
export function __setWindsurfEndpointResolverForTest(fn: (() => Promise<WindsurfLsEndpoint[]>) | null): void {
    endpointResolverOverride = fn;
    cachedEndpointPool = null;
}

/**
 * 测试专用：注入 transport 工厂（按 endpoint 返回桩 transport）。传 null 还原真实工厂。
 */
export function __setWindsurfTransportFactoryForTest(fn: ((endpoint: WindsurfLsEndpoint) => WindsurfLsTransport) | null): void {
    transportFactoryOverride = fn;
}

/**
 * 测试专用：重置端点池短缓存（避免跨用例污染）。
 */
export function __resetWindsurfEndpointCacheForTest(): void {
    cachedEndpointPool = null;
    windsurfConversationCache.clear();
    __resetWindsurfLsGateStatsForTest();
}

export function __resetWindsurfConversationCacheForTest(): void {
    windsurfConversationCache.clear();
    __resetWindsurfLsGateStatsForTest();
}

export function __getWindsurfLsGateStatsForTest(): {
    active: number;
    pending: number;
    peakActive: number;
    limit: number;
    current: number;
    max: number;
    min: number;
    successes: number;
    failures: number;
    configuredReserved: number;
    effectiveReserved: number;
    activeForeground: number;
    activeBackground: number;
    pendingForeground: number;
    pendingBackground: number;
    borrowing: boolean;
    acquireCount: number;
    queueWaitMsTotal: number;
    maxQueueWaitMs: number;
    lastQueueWaitMs: number;
} {
    const stats = windsurfLsConcurrencyGate.stats();
    const adaptive = windsurfLsAdaptiveGate.snapshot();
    return {
        ...stats,
        configuredReserved: stats.configuredReserved ?? 0,
        effectiveReserved: stats.effectiveReserved ?? 0,
        activeForeground: stats.activeForeground ?? 0,
        activeBackground: stats.activeBackground ?? 0,
        pendingForeground: stats.pendingForeground ?? 0,
        pendingBackground: stats.pendingBackground ?? 0,
        borrowing: stats.borrowing ?? false,
        current: adaptive.current,
        max: adaptive.max,
        min: adaptive.min,
        successes: adaptive.successes,
        failures: adaptive.failures,
        acquireCount: windsurfLsGateAcquireCount,
        queueWaitMsTotal: windsurfLsGateQueueWaitMsTotal,
        maxQueueWaitMs: windsurfLsGateMaxQueueWaitMs,
        lastQueueWaitMs: windsurfLsGateLastQueueWaitMs,
    };
}

export function __resetWindsurfLsGateStatsForTest(): void {
    windsurfLsAdaptiveGate = createWindsurfLsAdaptiveGate();
    windsurfLsGateAcquireCount = 0;
    windsurfLsGateQueueWaitMsTotal = 0;
    windsurfLsGateMaxQueueWaitMs = 0;
    windsurfLsGateLastQueueWaitMs = 0;
    windsurfLsConcurrencyGate.resetPeakForTest();
}

function getCachedWindsurfConversation(cascadeId: string, now = Date.now()): WindsurfConversationCacheEntry | null {
    const entry = windsurfConversationCache.get(cascadeId);
    if (!entry) return null;
    const ttlMs = getWindsurfConversationCacheTtlMs();
    if (now - entry.cachedAt > ttlMs) {
        windsurfConversationCache.delete(cascadeId);
        return null;
    }
    windsurfConversationCache.delete(cascadeId);
    windsurfConversationCache.set(cascadeId, entry);
    return entry;
}

function setCachedWindsurfConversation(
    cascadeId: string,
    result: WindsurfConversationReadResult,
    authoritativeStepCount: number,
): void {
    windsurfConversationCache.delete(cascadeId);
    windsurfConversationCache.set(cascadeId, {
        cachedAt: Date.now(),
        lastValidatedAt: Date.now(),
        result: cloneWindsurfConversationResult(result),
        authoritativeStepCount,
    });
    while (windsurfConversationCache.size > getWindsurfConversationCacheMaxEntries()) {
        const oldest = windsurfConversationCache.keys().next().value;
        if (oldest === undefined) break;
        windsurfConversationCache.delete(oldest);
    }
}

/** 获取端点池（带短缓存） */
async function getWindsurfEndpointPool(): Promise<WindsurfLsEndpoint[]> {
    const now = Date.now();
    if (cachedEndpointPool && now - cachedEndpointPool.cachedAt < ENDPOINT_CACHE_TTL_MS) {
        return cachedEndpointPool.endpoints;
    }
    const endpoints = await discoverAllWindsurfLsEndpoints();
    cachedEndpointPool = endpoints.length ? { endpoints, cachedAt: now } : null;
    return endpoints;
}

export async function isWindsurfStoreAvailable(): Promise<boolean> {
    return (await getWindsurfEndpointPool()).length > 0 || readWindsurfSubagentJobs().size > 0;
}


function withWindsurfLsConcurrencyGate(rawTransport: WindsurfLsTransport): WindsurfLsTransport {
    return async (method: string, payload: Record<string, unknown> = {}, options: WindsurfLsTransportCallOptions = {}) => {
        if (!READ_ONLY_METHODS.has(method)) {
            throw new Error(`WSF client is read-only; method ${method} is not allowed`);
        }
        const requestClass = options.requestClass || "foreground";
        const deadlineAt = resolveWindsurfCallDeadlineAt(options);
        const permit = await windsurfLsConcurrencyGate.acquire({
            deadlineAt,
            shouldCancel: options.shouldCancel,
            cancelMessage: options.cancelMessage || `WSF LS ${method} failed: cancelled while waiting for concurrency gate`,
            timeoutMessage: options.timeoutMessage || `WSF LS ${method} failed: timed out while waiting for concurrency gate`,
            requestClass,
        });
        let rawTransportStarted = false;
        let rawOutcome: CallOutcome | null = null;
        const captureRawOutcome = (outcome: CallOutcome): void => {
            if (rawOutcome === null) rawOutcome = outcome;
        };
        try {
            windsurfLsGateAcquireCount += 1;
            windsurfLsGateQueueWaitMsTotal += permit.queueWaitMs;
            windsurfLsGateMaxQueueWaitMs = Math.max(windsurfLsGateMaxQueueWaitMs, permit.queueWaitMs);
            windsurfLsGateLastQueueWaitMs = permit.queueWaitMs;
            const adaptive = windsurfLsAdaptiveGate.snapshot();
            const diagnostics: WindsurfLsTransportDiagnostics = {
                method,
                requestClass,
                queueWaitMs: permit.queueWaitMs,
                active: permit.snapshot.active,
                pending: permit.snapshot.pending,
                limit: adaptive.current,
                ...adaptive,
                configuredReserved: permit.snapshot.configuredReserved ?? 0,
                effectiveReserved: permit.snapshot.effectiveReserved ?? 0,
                activeForeground: permit.snapshot.activeForeground ?? 0,
                activeBackground: permit.snapshot.activeBackground ?? 0,
                pendingForeground: permit.snapshot.pendingForeground ?? 0,
                pendingBackground: permit.snapshot.pendingBackground ?? 0,
                borrowing: permit.snapshot.borrowing ?? false,
            };
            options.onConcurrencyEvent?.(diagnostics);
            const remainingMs = remainingTimeoutMs(deadlineAt);
            if (remainingMs <= 0) {
                throw new Error(options.timeoutMessage || `WSF LS ${method} failed: timed out before request started`);
            }
            rawTransportStarted = true;
            const rawOptions: InternalWindsurfLsTransportCallOptions = {
                ...options,
                requestClass,
                deadlineAt,
                timeoutMs: remainingMs,
                [windsurfLsOutcomeReporter]: captureRawOutcome,
            };
            const result = await rawTransport(method, payload, rawOptions);
            recordWindsurfLsTransportOutcome(rawOutcome || { success: true });
            return result;
        } catch (error) {
            if (rawTransportStarted) {
                recordWindsurfLsTransportOutcome(rawOutcome || { success: false, errorKind: "unknown" });
            }
            throw normalizeWindsurfTransportError(method, error);
        } finally {
            permit.release();
        }
    };
}

function createRawWindsurfLsTransport(endpoint: WindsurfLsEndpoint): WindsurfLsTransport {
    return async (method: string, payload: Record<string, unknown> = {}, options: WindsurfLsTransportCallOptions = {}) => {
        let reportedOutcome = false;
        const reportOutcome = (outcome: CallOutcome): void => {
            if (reportedOutcome) return;
            reportedOutcome = true;
            reportWindsurfLsTransportOutcome(options, outcome);
        };
        const deadlineAt = resolveWindsurfCallDeadlineAt(options);
        if (options.shouldCancel?.()) {
            reportOutcome({ success: false, errorKind: "cancelled" });
            throw new Error(options.cancelMessage || "cancelled before request started");
        }
        const remainingMs = remainingTimeoutMs(deadlineAt);
        if (remainingMs <= 0) {
            throw new Error(options.timeoutMessage || "timed out before request started");
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), remainingMs);
        timer.unref?.();
        const cancelWatcher = options.shouldCancel
            ? setInterval(() => {
                if (options.shouldCancel?.()) {
                    controller.abort();
                }
            }, 25)
            : undefined;
        cancelWatcher?.unref?.();
        let fetchStarted = false;
        let responseBodyComplete = false;
        try {
            fetchStarted = true;
            const response = await fetch(`http://127.0.0.1:${endpoint.port}/${WINDSURF_SERVICE_PREFIX}/${method}`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-codeium-csrf-token": endpoint.csrfToken,
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            const text = await response.text();
            responseBodyComplete = true;
            if (!response.ok) {
                reportOutcome({
                    success: false,
                    errorKind: response.status === 429
                        ? "rate_limit"
                        : response.status >= 500 && response.status <= 599
                            ? "server_error"
                            : "unknown",
                });
                throw new Error(`HTTP ${response.status}: ${truncate(redactSensitive(text), 500)}`);
            }
            const result = text.trim() ? JSON.parse(text) : {};
            reportOutcome({ success: true });
            return result;
        } catch (error) {
            if (wasWindsurfCallCancelled(options, error)) {
                reportOutcome({ success: false, errorKind: "cancelled" });
                throw new Error(options.cancelMessage || "cancelled during request");
            }
            if (isAbortLikeError(error) || Date.now() >= deadlineAt) {
                if (fetchStarted) reportOutcome({ success: false, errorKind: "timeout" });
                throw new Error(options.timeoutMessage || `timed out after ${Math.max(0, remainingMs)}ms`);
            }
            reportOutcome({
                success: false,
                errorKind: fetchStarted && !responseBodyComplete ? "network" : "unknown",
            });
            throw error;
        } finally {
            clearTimeout(timer);
            if (cancelWatcher) clearInterval(cancelWatcher);
        }
    };
}

export function createWindsurfLsTransport(endpoint: WindsurfLsEndpoint): WindsurfLsTransport {
    return withWindsurfLsConcurrencyGate(createRawWindsurfLsTransport(endpoint));
}

export function normalizeWindsurfTrajectoryList(response: unknown): WindsurfConversationSummary[] {
    const root = asRecord(response);
    const summaries = root.trajectorySummaries;
    const subagentJobs = readWindsurfSubagentJobs();
    const entries = Array.isArray(summaries)
        ? summaries.map((info, index) => [asRecord(info).cascadeId || asRecord(info).trajectoryId || String(index), info] as const)
        : Object.entries(asRecord(summaries));

    return entries.map(([cascadeId, info]) => {
        const record = asRecord(info);
        const id = toStringValue(record.cascadeId) || toStringValue(record.id) || cascadeId;
        const rawSummary = toStringValue(record.summary).trim();
        const rawTitle = toStringValue(record.title).trim();
        const renamedTitle = toStringValue(record.renamedTitle).trim();
        const job = subagentJobs.get(id);
        const subagent = asRecord(record.subagent);
        const titleBestEffort = (toStringValue(record.title_best_effort) || toStringValue(record.titleBestEffort) || toStringValue(subagent.title_best_effort) || toStringValue(subagent.titleBestEffort) || job?.titleBestEffort || "").trim();
        const summary = rawSummary || rawTitle || "Untitled WSF Cascade";
        const title = renamedTitle || summary;
        const titleSource: WindsurfConversationSummary["titleSource"] = renamedTitle
            ? "renamedTitle"
            : rawSummary
                ? "summary"
                : rawTitle
                    ? "title"
                    : "fallback";
        const workspaceUris = extractWorkspaceUrisFromRecord(record);
        const referencedFiles = extractReferencedFilesFromRecord(record);
        const parentConversationId = job?.mainId
            || firstStringField(record, ["parentConversationId", "parent_conversation_id", "parentCascadeId", "parent_cascade_id", "mainId", "main_id"])
            || firstStringField(subagent, ["parentConversationId", "parent_conversation_id", "parentCascadeId", "parent_cascade_id", "mainId", "main_id"])
            || null;
        const subagentMarkerTitle = [titleBestEffort, renamedTitle, rawTitle, rawSummary].find(isWindsurfSubagentTitle) || "";
        const explicitSubagent = record.isChildThread === true
            || record.is_child_thread === true
            || record.isSubagent === true
            || record.is_subagent === true
            || record.subagent === true
            || Object.keys(subagent).length > 0;
        const isChildThread = explicitSubagent || Boolean(parentConversationId) || Boolean(subagentMarkerTitle);
        const subagentRole = job?.label
            || firstStringField(record, ["agentRole", "agent_role", "subagentRole", "subagent_role"])
            || firstStringField(subagent, ["agentRole", "agent_role", "subagentRole", "subagent_role", "label"])
            || windsurfSubagentRoleFromTitle(subagentMarkerTitle)
            || (isChildThread ? "windsurf-subagent" : null);
        const agentNickname = firstStringField(record, ["agentNickname", "agent_nickname", "subagentNickname", "subagent_nickname"])
            || firstStringField(subagent, ["agentNickname", "agent_nickname", "subagentNickname", "subagent_nickname", "nickname"])
            || subagentMarkerTitle
            || undefined;
        return {
            id,
            cascadeId: id,
            trajectoryId: toStringValue(record.trajectoryId) || undefined,
            title,
            renamedTitle: renamedTitle || undefined,
            titleBestEffort: titleBestEffort || undefined,
            titleSource,
            isChildThread,
            parentConversationId,
            agentRole: subagentRole,
            agentNickname,
            summary,
            stepCount: toNumberValue(record.stepCount),
            createdTime: toStringValue(record.createdTime) || undefined,
            lastModifiedTime: toStringValue(record.lastModifiedTime) || undefined,
            status: toStringValue(record.status) || job?.state || undefined,
            trajectoryType: toStringValue(record.trajectoryType) || undefined,
            lastGeneratorModelUid: toStringValue(record.lastGeneratorModelUid) || job?.model || undefined,
            cwd: workspaceUris[0] || extractWorkspaceFromRecord(record),
            workspaceUris: workspaceUris.length ? workspaceUris : undefined,
            referencedFiles: referencedFiles.length ? referencedFiles : undefined,
        };
    }).sort((left, right) => {
        const leftTime = Date.parse(left.lastModifiedTime || left.createdTime || "");
        const rightTime = Date.parse(right.lastModifiedTime || right.createdTime || "");
        return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    });
}

export async function listWindsurfConversations(
    transport: WindsurfLsTransport,
    options: Pick<WindsurfLsTransportCallOptions, "requestClass"> = {},
): Promise<WindsurfConversationSummary[]> {
    return normalizeWindsurfTrajectoryList(await transport("GetAllCascadeTrajectories", {}, options));
}

function windsurfSummaryFromSubagentJob(
    job: WindsurfSubagentJobInfo,
    parent?: WindsurfConversationSummary,
): WindsurfConversationSummary {
    const titleBestEffort = job.titleBestEffort || (job.label ? `[subagent] ${job.label}` : "[subagent] Windsurf subagent");
    const label = job.label || windsurfSubagentRoleFromTitle(titleBestEffort) || "windsurf-subagent";
    return {
        id: job.subCid,
        cascadeId: job.subCid,
        title: titleBestEffort,
        titleBestEffort,
        titleSource: "titleBestEffort",
        isChildThread: true,
        parentConversationId: job.mainId,
        agentRole: label,
        agentNickname: titleBestEffort,
        summary: titleBestEffort,
        stepCount: job.resultStepCount || 0,
        createdTime: job.createdAt,
        lastModifiedTime: job.updatedAt || job.completedAt || job.createdAt,
        status: job.state,
        lastGeneratorModelUid: job.model,
        cwd: parent?.cwd,
        workspaceUris: parent?.workspaceUris,
        referencedFiles: parent?.referencedFiles,
    };
}

/**
 * 判定某 GetAllCascadeTrajectories 响应是否包含指定 cascadeId（供路由大脑 holds 判定）。
 * 复用 normalizeWindsurfTrajectoryList，summaries 数组/对象两形态均判对。
 */
export function windsurfListContainsId(data: unknown, cascadeId: string): boolean {
    if (!cascadeId) return false;
    const summaries = normalizeWindsurfTrajectoryList(data);
    return summaries.some(item => item.id === cascadeId || item.cascadeId === cascadeId);
}

/**
 * 列出近期 WSF 对话：跨「全部」活跃 WSF LS 端点聚合去重（同 cascadeId 取 stepCount 最大），
 * 修「list 只看一个窗口」（失败路径 ④ 连带）。
 */
export async function listRecentWindsurfThreads(
    limit = 50,
    options: Pick<WindsurfLsTransportCallOptions, "requestClass"> = {},
): Promise<WindsurfConversationSummary[]> {
    const endpoints = await getWindsurfEndpointPool();

    const merged = new Map<string, WindsurfConversationSummary>();
    const lists = endpoints.length
        ? await Promise.all(endpoints.map(async ep => {
            try {
                return await listWindsurfConversations(makeTransport(ep), options);
            } catch {
                return [] as WindsurfConversationSummary[];
            }
        }))
        : [];

    for (const list of lists) {
        for (const item of list) {
            const existing = merged.get(item.id);
            if (!existing || (item.stepCount || 0) > (existing.stepCount || 0)) {
                merged.set(item.id, item);
            }
        }
    }

    for (const job of readWindsurfSubagentJobs().values()) {
        const parent = merged.get(job.mainId);
        const existing = merged.get(job.subCid);
        const synthesized = windsurfSummaryFromSubagentJob(job, parent);
        if (existing) {
            merged.set(job.subCid, {
                ...existing,
                titleBestEffort: existing.titleBestEffort || synthesized.titleBestEffort,
                isChildThread: true,
                parentConversationId: existing.parentConversationId || job.mainId,
                agentRole: existing.agentRole || synthesized.agentRole,
                agentNickname: existing.agentNickname || synthesized.agentNickname,
                status: existing.status || synthesized.status,
                lastGeneratorModelUid: existing.lastGeneratorModelUid || synthesized.lastGeneratorModelUid,
            });
        } else {
            merged.set(job.subCid, synthesized);
        }
    }

    return Array.from(merged.values())
        .sort((left, right) => {
            const leftTime = Date.parse(left.lastModifiedTime || left.createdTime || "");
            const rightTime = Date.parse(right.lastModifiedTime || right.createdTime || "");
            return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
        })
        .slice(0, Math.max(0, limit));
}

export async function resolveWindsurfThreadId(
    input: string,
    options: Pick<WindsurfLsTransportCallOptions, "requestClass"> = {},
): Promise<string | null> {
    const query = input.trim().toLowerCase();
    if (!query) return null;
    const threads = await listRecentWindsurfThreads(500, options);
    const exact = threads.find(item => item.id.toLowerCase() === query || item.cascadeId.toLowerCase() === query);
    if (exact) return exact.id;
    const prefix = threads.filter(item => item.id.toLowerCase().startsWith(query) || item.cascadeId.toLowerCase().startsWith(query));
    return prefix.length === 1 ? prefix[0].id : null;
}

function extractSteps(response: unknown): unknown[] {
    const record = asRecord(response);
    if (Array.isArray(record.steps)) return record.steps;
    if (Array.isArray(record.trajectorySteps)) return record.trajectorySteps;
    if (Array.isArray(record.cascadeTrajectorySteps)) return record.cascadeTrajectorySteps;
    return [];
}

function extractStepsFromNestedPreview(value: unknown, depth = 0): unknown[] {
    if (depth > 5 || value == null) return [];
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return [];
        try {
            return extractStepsFromNestedPreview(JSON.parse(trimmed), depth + 1);
        } catch {
            return [];
        }
    }
    const direct = extractSteps(value);
    if (direct.length > 0) return direct;
    const record = asRecord(value);
    for (const key of ["result_preview", "resultPreview", "result", "payload", "data", "response"]) {
        const nested = record[key];
        const steps = extractStepsFromNestedPreview(nested, depth + 1);
        if (steps.length > 0) return steps;
    }
    return [];
}

function readWindsurfSubagentArchive(job: WindsurfSubagentJobInfo): unknown | null {
    if (!job.archivePath) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(job.archivePath, "utf8"));
        return parsed;
    } catch {
        return null;
    }
}

function windsurfSubagentJobSteps(job: WindsurfSubagentJobInfo): unknown[] {
    const archived = readWindsurfSubagentArchive(job);
    const archiveSteps = extractStepsFromNestedPreview(archived);
    if (archiveSteps.length > 0) return archiveSteps;
    return extractStepsFromNestedPreview(job.resultPreview);
}

function loadWindsurfSubagentJobConversation(cascadeId: string): WindsurfConversationReadResult | null {
    const job = readWindsurfSubagentJobs().get(cascadeId);
    if (!job) return null;
    const steps = windsurfSubagentJobSteps(job);
    const thread = windsurfSummaryFromSubagentJob(job);
    return {
        cascadeId: job.subCid,
        thread,
        steps,
        rounds: windsurfStepsToConversationRounds(steps),
        pagesRead: steps.length > 0 ? 1 : 0,
        totalSteps: Math.max(steps.length, job.resultStepCount || 0),
        skippedSteps: [],
        partial: steps.length === 0 && Boolean(job.resultStepCount),
    };
}

function nextOffsetFromResponse(response: unknown, currentOffset: number, pageLength: number): number {
    const record = asRecord(response);
    const explicit = toNumberValue(record.nextStepOffset ?? record.nextOffset);
    if (explicit > currentOffset) return explicit;
    return currentOffset + pageLength;
}

const OVERSIZED_STEP_TYPE = "MEMORY_STORE_WSF_OVERSIZED_STEP";

function parseOversizedStepError(error: unknown, currentOffset: number): WindsurfSkippedStep | null {
    const message = error instanceof Error ? error.message : String(error);
    const match = message.match(/step at offset\s+(\d+)\s+larger than\s+(\d+)\s+byte limit/iu);
    if (!match) return null;
    const offset = Number(match[1]);
    const byteLimit = Number(match[2]);
    if (!Number.isInteger(offset) || offset < currentOffset) return null;
    return {
        offset,
        reason: "oversized",
        byteLimit: Number.isFinite(byteLimit) && byteLimit > 0 ? byteLimit : undefined,
        message,
    };
}

function buildOversizedStepPlaceholder(skipped: WindsurfSkippedStep): Record<string, unknown> {
    return {
        type: OVERSIZED_STEP_TYPE,
        memoryStoreWarning: skipped,
    };
}

function isOversizedStepPlaceholder(step: Record<string, any>): boolean {
    return toStringValue(step.type) === OVERSIZED_STEP_TYPE;
}

function createOversizedStepRound(roundIndex: number, step: Record<string, any>, fallbackStepIndex: number): ConversationRound {
    const warning = asRecord(step.memoryStoreWarning);
    const offset = toNumberValue(warning.offset) || fallbackStepIndex;
    const byteLimit = toNumberValue(warning.byteLimit);
    const message = toStringValue(warning.message);
    return {
        roundIndex,
        startStep: offset,
        endStep: offset,
        userMessage: [
            `⚠️ WSF 原始 step ${offset} 超过${byteLimit ? ` ${byteLimit} 字节` : ""}读取限制，memory-store 已跳过该单步并继续读取后续内容。`,
            "这通常是单条 Cascade step 内含超大图片、文件快照或宿主内部状态，当前 read/fetch 只能提供降级占位；需要完整原始内容时，请回到 Windsurf UI 或官方导出查看该位置。",
            message ? `原始错误：${truncate(message, 500)}` : "",
        ].filter(Boolean).join("\n"),
        mediaAttachments: [],
        attachments: [],
        aiResponses: [],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    };
}

export async function readWindsurfCascadeSteps(
    transport: WindsurfLsTransport,
    cascadeId: string,
    options: ReadStepsOptions = {},
): Promise<{ steps: unknown[]; pagesRead: number; skippedSteps: WindsurfSkippedStep[]; partial: boolean }> {
    const maxPages = Math.max(1, options.maxPages ?? DEFAULT_MAX_PAGES);
    const maxSkippedOversizedSteps = Math.max(0, options.maxSkippedOversizedSteps ?? DEFAULT_MAX_OVERSIZED_STEP_SKIPS);
    let offset = Math.max(0, options.startOffset ?? 0);
    const steps: unknown[] = [];
    const skippedSteps: WindsurfSkippedStep[] = [];
    const seenOffsets = new Set<number>();

    for (let page = 0; page < maxPages; page++) {
        if (seenOffsets.has(offset)) break;
        seenOffsets.add(offset);

        let response: unknown;
        const startedAt = Date.now();
        try {
            response = await transport("GetCascadeTrajectorySteps", { cascadeId, stepOffset: offset });
        } catch (error) {
            const durationMs = Date.now() - startedAt;
            const oversized = parseOversizedStepError(error, offset);
            if (!oversized) throw error;
            options.timingCollector?.pageReads.push({ offset, durationMs, stepCount: 0 });
            if (skippedSteps.length >= maxSkippedOversizedSteps) {
                steps.push(buildOversizedStepPlaceholder({
                    ...oversized,
                    message: `${oversized.message}\nmemory-store 已达到 WSF 超大 step 跳过上限 ${maxSkippedOversizedSteps}，后续内容未继续读取。`,
                }));
                return { steps, pagesRead: seenOffsets.size, skippedSteps: [...skippedSteps, oversized], partial: true };
            }
            skippedSteps.push(oversized);
            steps.push(buildOversizedStepPlaceholder(oversized));
            offset = oversized.offset + 1;
            continue;
        }
        const pageSteps = extractSteps(response);
        options.timingCollector?.pageReads.push({
            offset,
            durationMs: Date.now() - startedAt,
            stepCount: pageSteps.length,
        });
        if (pageSteps.length === 0) {
            return { steps, pagesRead: seenOffsets.size, skippedSteps, partial: skippedSteps.length > 0 };
        }

        steps.push(...pageSteps);
        offset = nextOffsetFromResponse(response, offset, pageSteps.length);
    }

    return { steps, pagesRead: seenOffsets.size, skippedSteps, partial: skippedSteps.length > 0 };
}

export async function readWindsurfConversation(
    transport: WindsurfLsTransport,
    cascadeId: string,
    options: ReadStepsOptions = {},
): Promise<WindsurfConversationReadResult> {
    const timingCollector = options.timingCollector;
    const stepsStartedAt = Date.now();
    const { steps, pagesRead, skippedSteps, partial } = await readWindsurfCascadeSteps(transport, cascadeId, options);
    if (timingCollector) {
        timingCollector.stepsReadMs = Date.now() - stepsStartedAt;
    }
    const roundStartedAt = Date.now();
    const rounds = windsurfStepsToConversationRounds(steps);
    if (timingCollector) {
        timingCollector.roundConversionMs = Date.now() - roundStartedAt;
    }
    return {
        cascadeId,
        thread: {
            id: cascadeId,
            cascadeId,
            title: cascadeId,
            summary: cascadeId,
            stepCount: steps.length,
        },
        steps,
        rounds,
        pagesRead,
        totalSteps: steps.length,
        skippedSteps,
        partial,
    };
}

/**
 * 用持有者 endpoint 的 list 给 read 结果补 thread 摘要（标题/stepCount/workspace 等）。
 */
async function enrichThreadSummary(
    result: WindsurfConversationReadResult,
    transport: WindsurfLsTransport,
    resolvedId: string,
): Promise<void> {
    try {
        const summaries = await listWindsurfConversations(transport);
        const summary = summaries.find(item => item.id === resolvedId || item.cascadeId === resolvedId);
        if (summary) {
            result.thread = summary;
            result.totalSteps = Math.max(result.totalSteps, summary.stepCount || 0);
        } else {
            const job = readWindsurfSubagentJobs().get(resolvedId);
            if (job) {
                result.thread = windsurfSummaryFromSubagentJob(job);
                result.totalSteps = Math.max(result.totalSteps, job.resultStepCount || 0);
            }
        }
    } catch { /* 摘要补全失败不影响正文 */ }
}

/**
 * 本地兜底空壳：活跃 LS 都不持有但本地 .pb 存在 → partial:true 明确提示（失败路径 ⑥-a）。
 * 本地无 .pb → 返回 null（对话确实不存在）。
 */
function localFallbackResult(cascadeId: string): WindsurfConversationReadResult | null {
    if (!windsurfCascadeExistsLocally(cascadeId)) return null;
    return {
        cascadeId,
        thread: {
            id: cascadeId,
            cascadeId,
            title: cascadeId,
            summary: "当前没有持有此 WSF 对话的活跃 Windsurf 窗口（对话曾存在于本地，可能窗口已关闭）。请重新打开对应 Windsurf 窗口后重试。",
            stepCount: 0,
        },
        steps: [],
        rounds: [],
        pagesRead: 0,
        totalSteps: 0,
        partial: true,
    };
}

function buildCacheMetadata(
    status: NonNullable<WindsurfConversationMetadata["cache"]>["status"],
    refreshRequested: boolean,
    cacheEntry: WindsurfConversationCacheEntry | null,
    authoritativeStepCount: number,
    reason?: string,
): NonNullable<WindsurfConversationMetadata["cache"]> {
    const ttlMs = getWindsurfConversationCacheTtlMs();
    const revalidateWindowMs = getWindsurfCacheRevalidateMs();
    const maxEntries = getWindsurfConversationCacheMaxEntries();
    const ageMs = cacheEntry ? Math.max(0, Date.now() - cacheEntry.cachedAt) : undefined;
    return {
        status,
        refreshRequested,
        ttlMs,
        maxEntries,
        cachedAt: cacheEntry ? new Date(cacheEntry.cachedAt).toISOString() : undefined,
        ageMs,
        lastValidatedAt: cacheEntry ? new Date(cacheEntry.lastValidatedAt).toISOString() : undefined,
        revalidateWindowMs,
        authoritativeStepCount,
        cachedStepCount: cacheEntry?.authoritativeStepCount,
        reason,
    };
}

function buildSourceMetadata(
    resolved: { endpoint: RouterEndpoint | null; reason: "ok" | "not_held" | "no_ls"; fromMapping: boolean } | null,
    retriedAfterInvalidate = false,
): WindsurfConversationMetadata["source"] | undefined {
    if (!resolved) return undefined;
    return {
        reason: resolved.reason,
        fromMapping: resolved.fromMapping,
        endpointPid: resolved.endpoint?.pid,
        endpointPort: resolved.endpoint?.port,
        retriedAfterInvalidate,
    };
}

/**
 * 薄壳化：先问路由大脑要「已验证持有该对话」的 endpoint，再用它的 transport 读正文。
 *   - 读空且 stepCount>0 → 映射可能粘错，invalidate + 换持有者重试一次。
 *   - 全不持有 + 本地有 .pb → localFallbackResult(partial:true) 明确提示。
 *   - 全不持有 + 本地无 .pb → null。
 */
export async function loadWindsurfConversation(
    cascadeId: string,
    refresh = false,
    loadOptions: { requestClass?: ConcurrencyGateRequestClass } = {},
): Promise<WindsurfConversationReadResult | null> {
    const requestedId = cascadeId.trim();
    const directCachedEntry = requestedId ? getCachedWindsurfConversation(requestedId) : null;
    const requestClass = loadOptions.requestClass || "foreground";
    const resolvedId = directCachedEntry
        ? requestedId
        : (await resolveWindsurfThreadId(requestedId, { requestClass }) || requestedId);
    const cachedEntry = directCachedEntry && resolvedId === requestedId
        ? directCachedEntry
        : getCachedWindsurfConversation(resolvedId);
    const timingCollector = createTimingCollector();
    const lsConcurrency = createWindsurfLsConcurrencyAccumulator();

    if (!refresh && cachedEntry && isWindsurfCacheFresh(cachedEntry)) {
        return attachWindsurfMetadata(cachedEntry.result, {
            cache: buildCacheMetadata("hit", false, cachedEntry, cachedEntry.authoritativeStepCount, "fresh-cache-within-revalidate-window"),
            lsConcurrency,
            timings: timingCollector,
        });
    }

    const resolveWithTiming = async () => {
        const startedAt = Date.now();
        const resolved = await resolveEndpointForConversation(resolvedId, "windsurf", {
            requestClass,
        });
        timingCollector.resolveEndpointMs = (timingCollector.resolveEndpointMs || 0) + (Date.now() - startedAt);
        for (const diagnostics of resolved.transportDiagnostics || []) {
            recordWindsurfLsConcurrency(lsConcurrency, diagnostics);
        }
        return resolved;
    };

    let resolved = await resolveWithTiming();
    let retriedAfterInvalidate = false;

    if (cachedEntry && !resolved.endpoint) {
        const duringRefresh = refresh ? "（强制刷新期间）" : "";
        return attachWindsurfMetadata(cachedEntry.result, {
            warnings: [`WSF 源端${duringRefresh}当前不可用（${resolved.reason}），已返回 last-good 缓存。`],
            cache: buildCacheMetadata(
                "stale-fallback",
                refresh,
                cachedEntry,
                Math.max(0, resolved.stepCount),
                refresh ? "source-unavailable-during-refresh" : "source-unavailable",
            ),
            lsConcurrency,
            source: buildSourceMetadata(resolved),
            timings: timingCollector,
        });
    }

    if (!refresh && cachedEntry) {
        const authoritativeStepCount = Math.max(0, resolved.stepCount);
        const cachedStepCount = cachedEntry.authoritativeStepCount;
        if (authoritativeStepCount <= 0 || authoritativeStepCount === cachedStepCount) {
            const freshenedEntry = refreshCachedWindsurfConversationValidation(resolvedId, authoritativeStepCount) || cachedEntry;
            return attachWindsurfMetadata(cachedEntry.result, {
                cache: buildCacheMetadata("hit", false, freshenedEntry, authoritativeStepCount, "authoritative-step-count-unchanged"),
                lsConcurrency,
                source: buildSourceMetadata(resolved),
                timings: timingCollector,
            });
        }
    }

    const attemptRead = async (): Promise<WindsurfConversationReadResult | null> => {
        if (!resolved.endpoint) return null;
        const endpointTransport = makeWindsurfTransport({
            pid: resolved.endpoint.pid,
            port: resolved.endpoint.port,
            csrfToken: resolved.endpoint.csrfToken,
            executablePath: resolved.endpoint.executablePath,
        });
        const transport: WindsurfLsTransport = (method, payload = {}, options = {}) => endpointTransport(method, payload, {
            ...options,
            requestClass: options.requestClass || loadOptions.requestClass,
            onConcurrencyEvent: mergeConcurrencyEvent(options.onConcurrencyEvent, diagnostics => {
                recordWindsurfLsConcurrency(lsConcurrency, diagnostics);
            }),
        });
        const result = await readWindsurfConversation(transport, resolvedId, { timingCollector });
        const enrichStartedAt = Date.now();
        await enrichThreadSummary(result, transport, resolvedId);
        timingCollector.enrichMs = (timingCollector.enrichMs || 0) + (Date.now() - enrichStartedAt);
        return result;
    };

    let result: WindsurfConversationReadResult | null = null;
    let fetchError: unknown = null;
    try {
        result = await attemptRead();
    } catch (error) {
        fetchError = error;
    }

    if (
        resolved.endpoint
        && result
        && result.steps.length === 0
        && resolved.stepCount > 0
    ) {
        invalidateMapping(resolvedId, "windsurf");
        retriedAfterInvalidate = true;
        resolved = await resolveWithTiming();
        try {
            result = await attemptRead();
            fetchError = null;
        } catch (error) {
            fetchError = error;
        }
    }

    if (fetchError) {
        if (cachedEntry) {
            const message = fetchError instanceof Error ? fetchError.message : String(fetchError);
            return attachWindsurfMetadata(cachedEntry.result, {
                warnings: [`WSF 源读取失败，已保留 last-good 缓存：${truncate(message, 300)}`],
                cache: buildCacheMetadata("stale-fallback", refresh, cachedEntry, Math.max(0, resolved.stepCount), "source-error"),
                lsConcurrency,
                source: buildSourceMetadata(resolved, retriedAfterInvalidate),
                timings: timingCollector,
            });
        }
        throw fetchError;
    }

    if (resolved.endpoint && result) {
        const authoritativeStepCount = authoritativeStepCountFromResult(result, resolved.stepCount);
        const cacheStatus = refresh ? "refresh" : cachedEntry ? "miss" : "miss";
        if (shouldKeepLastGoodCache(result, authoritativeStepCount)) {
            if (cachedEntry) {
                const warning = result.partial
                    ? "WSF 源结果为 partial，已保留 last-good 缓存。"
                    : "WSF 源返回 stepCount>0 但 rounds=0，已保留 last-good 缓存。";
                return attachWindsurfMetadata(cachedEntry.result, {
                    warnings: [warning.replace(/^WSF/u, "WSF LS")],
                    cache: buildCacheMetadata("stale-fallback", refresh, cachedEntry, authoritativeStepCount, result.partial ? "partial-source-result" : "zero-rounds-with-authoritative-steps"),
                    lsConcurrency,
                    source: buildSourceMetadata(resolved, retriedAfterInvalidate),
                    timings: timingCollector,
                });
            }
            return attachWindsurfMetadata(result, {
                warnings: [
                    result.partial
                        ? "WSF LS 读取不完整（partial），当前返回未写入 last-good 缓存。"
                        : "WSF LS 返回 stepCount>0 但 rounds=0，当前返回未写入 last-good 缓存。",
                ],
                cache: buildCacheMetadata(cacheStatus, refresh, null, authoritativeStepCount, result.partial ? "partial-source-result" : "zero-rounds-with-authoritative-steps"),
                lsConcurrency,
                source: buildSourceMetadata(resolved, retriedAfterInvalidate),
                timings: timingCollector,
            });
        }

        setCachedWindsurfConversation(resolvedId, result, authoritativeStepCount);
        const freshEntry = getCachedWindsurfConversation(resolvedId);
        return attachWindsurfMetadata(result, {
            cache: buildCacheMetadata(refresh ? "refresh" : "miss", refresh, freshEntry, authoritativeStepCount, refresh ? "forced-refresh" : "fetched-from-source"),
            lsConcurrency,
            source: buildSourceMetadata(resolved, retriedAfterInvalidate),
            timings: timingCollector,
        });
    }

    const subagentJobResult = loadWindsurfSubagentJobConversation(resolvedId);
    if (subagentJobResult) return subagentJobResult;

    // 无持有者：本地兜底（partial 空壳）或 null。
    return localFallbackResult(resolvedId);
}

export interface WindsurfSourceEvidenceScanOptions {
    transport?: WindsurfLsTransport;
    endpoint?: Pick<WindsurfLsEndpoint, "pid" | "port">;
    workspaceId?: string;
    workspacePath?: string | null;
    sourceAuthority?: string;
    authoritativeRoot?: string;
    sourceCanonicalPath?: string | null;
    scanId?: string;
    sequence?: number;
    now?: () => Date;
    maxPages?: number;
    requestClass?: ConcurrencyGateRequestClass;
}

export interface WindsurfSourceEvidenceScanResult {
    scanId: string;
    cacheBypassed: true;
    identity: SourceConversationIdentity;
    enumeration: SourceEnumerationEvidence;
    exactFetch: ExactFetchEvidence;
    classification: SourceEvidenceClassification;
    fullSourceRead?: FullSourceReadEvidence;
    sourceSnapshot?: RecordSourceSnapshot;
    thread?: WindsurfConversationSummary;
    readResult?: WindsurfConversationReadResult;
    exactFetchAttempted: boolean;
}

interface WindsurfSourceEvidenceTransport {
    transport: WindsurfLsTransport;
    endpoint?: Pick<WindsurfLsEndpoint, "pid" | "port">;
}

interface WindsurfSourceEvidencePagination {
    cursor: string | null;
    pages: number;
    limit: number | null;
    truncated: boolean;
}

interface WindsurfSourceEvidenceListing {
    threads: WindsurfConversationSummary[];
    owners: Map<string, WindsurfSourceEvidenceTransport>;
    pagination: WindsurfSourceEvidencePagination;
    issues: SourceEvidenceIssue[];
    complete: boolean;
    fingerprint: string;
}

interface WindsurfSourceEvidenceSteps {
    steps: unknown[];
    pagesRead: number;
    partial: boolean;
    limit: number | null;
    issues: SourceEvidenceIssue[];
}

interface WindsurfSourceEvidenceListPage {
    threads: WindsurfConversationSummary[];
    nextCursor: string | null;
    partial: boolean;
    missingCursor: boolean;
}

interface WindsurfSourceEvidenceStepPage {
    steps: unknown[];
    partial: boolean;
}

export async function scanWindsurfSourceEvidence(
    cascadeId: string,
    options: WindsurfSourceEvidenceScanOptions = {},
): Promise<WindsurfSourceEvidenceScanResult> {
    const requestedId = cascadeId.trim();
    if (!requestedId) throw new Error("Windsurf source evidence 需要非空 cascadeId");

    const now = options.now || (() => new Date());
    const scanId = options.scanId?.trim() || crypto.randomUUID();
    const initialSequence = Math.max(1, Math.floor(options.sequence || 1));
    const sources = await resolveWindsurfSourceEvidenceTransports(options);
    const enumerationStartedAt = windsurfSourceEvidenceTimestamp(now);
    const initialListing = await collectWindsurfSourceEvidenceListing(sources.transports, options);
    const enumerationCompletedAt = windsurfSourceEvidenceTimestamp(now);
    const initialThread = initialListing.threads.find(thread => thread.id === requestedId || thread.cascadeId === requestedId);
    const initialTargetStatus = initialThread
        ? "present" as const
        : initialListing.complete
            ? "absent" as const
            : "unknown" as const;
    const targetIssues = initialThread ? validateWindsurfSourceEvidenceThread(initialThread) : [];
    const sharedIssues = mergeWindsurfSourceEvidenceIssues(sources.issues, initialListing.issues, targetIssues);
    const exactStartedAt = windsurfSourceEvidenceTimestamp(now);
    let exactFetchAttempted = false;
    let exactFetchResult: ExactFetchEvidence["exactFetchResult"] = "unresolved";
    let exactIssues: SourceEvidenceIssue[] = [];
    let exactReadResult: WindsurfConversationReadResult | undefined;
    const exactSource = initialThread
        ? initialListing.owners.get(initialThread.id) || initialListing.owners.get(initialThread.cascadeId) || sources.transports[0]
        : sources.transports[0];

    if (exactSource && (initialTargetStatus === "present" || initialTargetStatus === "absent")) {
        exactFetchAttempted = true;
        try {
            const steps = await readWindsurfSourceEvidenceSteps(exactSource.transport, requestedId, options);
            const thread = initialThread || createWindsurfSourceEvidenceFallbackThread(requestedId);
            const rounds = windsurfStepsToConversationRounds(steps.steps);
            exactIssues = mergeWindsurfSourceEvidenceIssues(exactIssues, steps.issues);
            exactFetchResult = steps.partial ? "unresolved" : "present";
            exactReadResult = {
                cascadeId: requestedId,
                thread,
                steps: steps.steps,
                rounds,
                pagesRead: steps.pagesRead,
                totalSteps: Math.max(steps.steps.length, thread.stepCount),
                partial: steps.partial,
                warnings: steps.issues.map(issue => issue.message),
            };
            if (initialThread && steps.steps.length !== initialThread.stepCount) {
                exactIssues = mergeWindsurfSourceEvidenceIssues(exactIssues, [
                    windsurfSourceEvidenceIssue(
                        "pagination_incomplete",
                        `WSF exact steps 数量 ${steps.steps.length} 与列表 stepCount ${initialThread.stepCount} 不一致`,
                    ),
                ]);
            }
        } catch (error) {
            if (isWindsurfSourceEvidenceNotFound(error)) {
                exactFetchResult = "not_found";
            } else {
                exactFetchResult = "unresolved";
                exactIssues = mergeWindsurfSourceEvidenceIssues(exactIssues, [windsurfSourceEvidenceIssueFromError(error, "exact")]);
            }
        }
    }

    let verificationListing: WindsurfSourceEvidenceListing | undefined;
    if (exactFetchAttempted) {
        verificationListing = await collectWindsurfSourceEvidenceListing(sources.transports, options);
        sharedIssues.push(...verificationListing.issues);
        if (verificationListing.fingerprint !== initialListing.fingerprint) {
            sharedIssues.push(windsurfSourceEvidenceIssue("revision_drift", "WSF 枚举在 exact fetch 前后发生变化"));
        }
    }

    const allSharedIssues = mergeWindsurfSourceEvidenceIssues(sharedIssues);
    const allExactIssues = mergeWindsurfSourceEvidenceIssues(allSharedIssues, exactIssues);
    const pagination = mergeWindsurfSourceEvidencePagination(initialListing.pagination, verificationListing?.pagination);
    const enumerationComplete = sources.transports.length > 0
        && initialListing.complete
        && (!verificationListing || verificationListing.complete)
        && !allSharedIssues.some(issue => issue.code === "timeout" || issue.code === "limit_reached" || issue.code === "pagination_incomplete" || issue.code === "parse_error" || issue.code === "source_unavailable" || issue.code === "revision_drift");
    const resolvedThread = verificationListing?.threads.find(thread => thread.id === requestedId || thread.cascadeId === requestedId) || initialThread;
    if (exactReadResult && resolvedThread) exactReadResult.thread = resolvedThread;
    const identity = buildWindsurfSourceEvidenceIdentity(requestedId, resolvedThread, sources.transports, options);
    const sourceRevision = buildWindsurfSourceEvidenceRevision(identity, initialListing, verificationListing, exactReadResult, initialTargetStatus);
    const exactCompletedAt = windsurfSourceEvidenceTimestamp(now);

    const enumeration = buildSourceEnumerationEvidence({
        adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: "windsurf",
        identity,
        sourceRevision,
        pagination,
        enumerationComplete,
        cacheBypassed: true,
        exactFetchResult,
        errors: allSharedIssues,
        warnings: [],
        observedAt: {
            scanId,
            sequence: initialSequence,
            startedAt: enumerationStartedAt,
            completedAt: enumerationCompletedAt,
        },
        targetStatus: initialTargetStatus,
    });
    const exactFetch = buildExactFetchEvidence({
        adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: "windsurf",
        identity,
        sourceRevision,
        pagination,
        enumerationComplete,
        cacheBypassed: true,
        exactFetchResult,
        errors: allExactIssues,
        warnings: [],
        observedAt: {
            scanId,
            sequence: initialSequence + 1,
            startedAt: exactStartedAt,
            completedAt: exactCompletedAt,
        },
    });
    const classification = classifySourceEvidence({ enumeration, exactFetch });
    const fullSourceRead = buildWindsurfFullSourceReadEvidence(
        identity,
        sourceRevision,
        pagination,
        enumerationComplete,
        exactFetchResult,
        allExactIssues,
        exactFetch.observedAt,
        exactReadResult,
    );
    const sourceSnapshot = fullSourceRead
        ? buildRecordSourceSnapshot({ snapshotId: `windsurf:${requestedId}:${sourceRevision.revision}`, fullSourceRead })
        : undefined;

    return {
        scanId,
        cacheBypassed: true,
        identity,
        enumeration,
        exactFetch,
        classification,
        fullSourceRead,
        sourceSnapshot,
        thread: resolvedThread,
        readResult: exactReadResult,
        exactFetchAttempted,
    };
}

async function resolveWindsurfSourceEvidenceTransports(options: WindsurfSourceEvidenceScanOptions): Promise<{
    transports: WindsurfSourceEvidenceTransport[];
    issues: SourceEvidenceIssue[];
}> {
    if (options.transport) return { transports: [{ transport: options.transport, endpoint: options.endpoint }], issues: [] };
    try {
        const endpoints = await getWindsurfEndpointPool();
        if (!endpoints.length) {
            return {
                transports: [],
                issues: [windsurfSourceEvidenceIssue("source_unavailable", "未发现可用于 WSF source evidence 的活动 Language Server endpoint")],
            };
        }
        return {
            transports: endpoints.map(endpoint => ({ transport: makeWindsurfTransport(endpoint), endpoint })),
            issues: [],
        };
    } catch (error) {
        return { transports: [], issues: [windsurfSourceEvidenceIssueFromError(error, "list")] };
    }
}

async function collectWindsurfSourceEvidenceListing(
    sources: WindsurfSourceEvidenceTransport[],
    options: WindsurfSourceEvidenceScanOptions,
): Promise<WindsurfSourceEvidenceListing> {
    const threads = new Map<string, WindsurfConversationSummary>();
    const owners = new Map<string, WindsurfSourceEvidenceTransport>();
    const issues: SourceEvidenceIssue[] = [];
    const paginations: WindsurfSourceEvidencePagination[] = [];

    for (const source of sources) {
        const listing = await listWindsurfSourceEvidenceFromTransport(source.transport, options);
        paginations.push(listing.pagination);
        issues.push(...listing.issues);
        for (const thread of listing.threads) {
            const existing = threads.get(thread.id) || threads.get(thread.cascadeId);
            if (existing && windsurfSourceEvidenceHash(windsurfSourceEvidenceThreadProjection(existing)) !== windsurfSourceEvidenceHash(windsurfSourceEvidenceThreadProjection(thread))) {
                issues.push(windsurfSourceEvidenceIssue("revision_drift", `多个 WSF endpoint 对 ${thread.id} 返回不同摘要`));
                continue;
            }
            threads.set(thread.id, thread);
            owners.set(thread.id, source);
            if (thread.cascadeId) {
                threads.set(thread.cascadeId, thread);
                owners.set(thread.cascadeId, source);
            }
        }
    }

    const uniqueThreads = [...new Map([...threads.values()].map(thread => [thread.id, thread])).values()]
        .sort((left, right) => left.id.localeCompare(right.id, "en"));
    const pagination = mergeWindsurfSourceEvidencePagination(...paginations);
    const normalizedIssues = mergeWindsurfSourceEvidenceIssues(issues);
    const complete = sources.length > 0
        && !pagination.truncated
        && pagination.cursor === null
        && pagination.limit === null
        && normalizedIssues.length === 0;
    return {
        threads: uniqueThreads,
        owners,
        pagination,
        issues: normalizedIssues,
        complete,
        fingerprint: windsurfSourceEvidenceHash(uniqueThreads.map(windsurfSourceEvidenceThreadProjection)),
    };
}

async function listWindsurfSourceEvidenceFromTransport(
    transport: WindsurfLsTransport,
    options: WindsurfSourceEvidenceScanOptions,
): Promise<{ threads: WindsurfConversationSummary[]; pagination: WindsurfSourceEvidencePagination; issues: SourceEvidenceIssue[] }> {
    const maxPages = normalizeWindsurfSourceEvidenceMaxPages(options.maxPages);
    let cursor: string | null = null;
    let pages = 0;
    const threads: WindsurfConversationSummary[] = [];
    const issues: SourceEvidenceIssue[] = [];
    const seenCursors = new Set<string>();

    while (pages < maxPages) {
        try {
            const payload = cursor === null ? {} : { cursor };
            const response = await transport("GetAllCascadeTrajectories", payload, { requestClass: options.requestClass });
            const page = parseWindsurfSourceEvidenceListPage(response);
            pages += 1;
            threads.push(...page.threads);
            if (page.partial) issues.push(windsurfSourceEvidenceIssue("pagination_incomplete", "WSF list 响应标记为 partial 或 truncated"));
            if (page.missingCursor) issues.push(windsurfSourceEvidenceIssue("pagination_incomplete", "WSF list 声明存在后续页但没有 nextCursor"));
            if (page.partial || page.missingCursor || page.nextCursor === null) {
                return {
                    threads,
                    pagination: { cursor: page.nextCursor, pages, limit: null, truncated: page.partial || page.missingCursor },
                    issues: mergeWindsurfSourceEvidenceIssues(issues),
                };
            }
            if (seenCursors.has(page.nextCursor)) {
                issues.push(windsurfSourceEvidenceIssue("pagination_incomplete", "WSF list pagination cursor 重复，无法证明枚举完整"));
                return {
                    threads,
                    pagination: { cursor: page.nextCursor, pages, limit: null, truncated: true },
                    issues: mergeWindsurfSourceEvidenceIssues(issues),
                };
            }
            seenCursors.add(page.nextCursor);
            cursor = page.nextCursor;
        } catch (error) {
            issues.push(windsurfSourceEvidenceIssueFromError(error, "list"));
            return {
                threads,
                pagination: { cursor, pages, limit: null, truncated: true },
                issues: mergeWindsurfSourceEvidenceIssues(issues),
            };
        }
    }

    issues.push(windsurfSourceEvidenceIssue("limit_reached", `WSF list 达到 ${maxPages} 页安全上限，不能将 partial 当成完整枚举`));
    return {
        threads,
        pagination: { cursor, pages, limit: maxPages, truncated: true },
        issues: mergeWindsurfSourceEvidenceIssues(issues),
    };
}

function parseWindsurfSourceEvidenceListPage(value: unknown): WindsurfSourceEvidenceListPage {
    const response = windsurfSourceEvidenceRecord(value, "WSF list response");
    if (!Object.prototype.hasOwnProperty.call(response, "trajectorySummaries")) {
        throw new Error("WSF list response 缺少 trajectorySummaries");
    }
    const summaries = response.trajectorySummaries;
    if (Array.isArray(summaries)) {
        summaries.forEach((summary, index) => windsurfSourceEvidenceRecord(summary, `WSF list trajectorySummaries[${index}]`));
    } else {
        const summaryRecord = windsurfSourceEvidenceRecord(summaries, "WSF list trajectorySummaries");
        for (const [cascadeId, summary] of Object.entries(summaryRecord)) {
            windsurfSourceEvidenceRecord(summary, `WSF list trajectorySummaries.${cascadeId}`);
        }
    }
    const nextCursor = windsurfSourceEvidenceOptionalString(response.nextCursor, "WSF list nextCursor")
        || windsurfSourceEvidenceOptionalString(response.nextPageToken, "WSF list nextPageToken")
        || windsurfSourceEvidenceOptionalString(response.continuationToken, "WSF list continuationToken");
    const partial = windsurfSourceEvidenceOptionalBoolean(response.partial, "WSF list partial")
        || windsurfSourceEvidenceOptionalBoolean(response.truncated, "WSF list truncated")
        || windsurfSourceEvidenceOptionalBoolean(response.incomplete, "WSF list incomplete");
    const hasMore = windsurfSourceEvidenceOptionalBoolean(response.hasMore, "WSF list hasMore")
        || windsurfSourceEvidenceOptionalBoolean(response.more, "WSF list more");
    return {
        threads: normalizeWindsurfTrajectoryList(response),
        nextCursor,
        partial,
        missingCursor: hasMore && nextCursor === null,
    };
}

async function readWindsurfSourceEvidenceSteps(
    transport: WindsurfLsTransport,
    cascadeId: string,
    options: WindsurfSourceEvidenceScanOptions,
): Promise<WindsurfSourceEvidenceSteps> {
    const maxPages = normalizeWindsurfSourceEvidenceMaxPages(options.maxPages);
    const steps: unknown[] = [];
    const seenOffsets = new Set<number>();
    let offset = 0;

    for (let page = 0; page < maxPages; page++) {
        if (seenOffsets.has(offset)) {
            return {
                steps,
                pagesRead: seenOffsets.size,
                partial: true,
                limit: null,
                issues: [windsurfSourceEvidenceIssue("pagination_incomplete", "WSF exact fetch stepOffset 重复，无法证明 trajectory 完整")],
            };
        }
        seenOffsets.add(offset);
        const response = await transport("GetCascadeTrajectorySteps", { cascadeId, stepOffset: offset }, { requestClass: options.requestClass });
            const page = parseWindsurfSourceEvidenceStepPage(response);
            steps.push(...page.steps);
            if (page.steps.some(step => hasOversizedWindsurfImageBase64(step))) {
                return {
                    steps,
                    pagesRead: seenOffsets.size,
                    partial: true,
                    limit: null,
                    issues: [windsurfSourceEvidenceIssue("limit_reached", "WSF exact fetch 包含超过附件安全上限的 base64，不能生成完整 source snapshot")],
                };
            }
            if (page.partial) {
                return {
                    steps,
                    pagesRead: seenOffsets.size,
                    partial: true,
                    limit: null,
                    issues: [windsurfSourceEvidenceIssue("pagination_incomplete", "WSF exact fetch 响应标记为 partial、truncated 或 incomplete")],
                };
            }
            if (page.steps.length === 0) {
                return { steps, pagesRead: seenOffsets.size, partial: false, limit: null, issues: [] };
            }
            offset = nextOffsetFromResponse(response, offset, page.steps.length);
    }

    return {
        steps,
        pagesRead: seenOffsets.size,
        partial: true,
        limit: maxPages,
        issues: [windsurfSourceEvidenceIssue("limit_reached", `WSF exact fetch 达到 ${maxPages} 页安全上限，不能生成完整 source snapshot`)],
    };
}

function parseWindsurfSourceEvidenceStepPage(value: unknown): WindsurfSourceEvidenceStepPage {
    const response = windsurfSourceEvidenceRecord(value, "WSF exact fetch response");
    const partial = windsurfSourceEvidenceOptionalBoolean(response.partial, "WSF exact fetch partial")
        || windsurfSourceEvidenceOptionalBoolean(response.truncated, "WSF exact fetch truncated")
        || windsurfSourceEvidenceOptionalBoolean(response.incomplete, "WSF exact fetch incomplete");
    const fields = ["steps", "trajectorySteps", "cascadeTrajectorySteps"];
    for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(response, field)) continue;
        if (!Array.isArray(response[field])) throw new Error(`WSF exact fetch ${field} 必须是数组`);
        return { steps: response[field] as unknown[], partial };
    }
    if (Object.keys(response).length === 0) return { steps: [], partial };
    throw new Error("WSF exact fetch response 缺少 steps");
}

function buildWindsurfSourceEvidenceIdentity(
    conversationId: string,
    thread: WindsurfConversationSummary | undefined,
    sources: WindsurfSourceEvidenceTransport[],
    options: WindsurfSourceEvidenceScanOptions,
): SourceConversationIdentity {
    const endpointIdentity = sources
        .map(source => source.endpoint ? `${source.endpoint.pid}:${source.endpoint.port}` : "direct-transport")
        .sort((left, right) => left.localeCompare(right, "en"));
    const canonicalPath = options.workspacePath ?? thread?.cwd ?? thread?.workspaceUris?.[0] ?? null;
    const workspaceId = options.workspaceId?.trim() || canonicalPath || "windsurf:workspace:unknown";
    return {
        workspace: {
            workspaceId,
            canonicalPath,
        },
        source: {
            kind: sources.length > 1 ? "hybrid" : "endpoint",
            authority: options.sourceAuthority?.trim() || "windsurf-language-server",
            authoritativeRoot: options.authoritativeRoot?.trim() || `windsurf://endpoint-pool/${endpointIdentity.join(",") || "unavailable"}`,
            canonicalPath: options.sourceCanonicalPath ?? null,
        },
        conversationId,
    };
}

function buildWindsurfSourceEvidenceRevision(
    identity: SourceConversationIdentity,
    initialListing: WindsurfSourceEvidenceListing,
    verificationListing: WindsurfSourceEvidenceListing | undefined,
    readResult: WindsurfConversationReadResult | undefined,
    targetStatus: "present" | "absent" | "unknown",
): SourceRevision {
    const completeReadResult = readResult && !readResult.partial ? readResult : undefined;
    const contentHash = completeReadResult
        ? windsurfSourceEvidenceHash({ steps: completeReadResult.steps, rounds: completeReadResult.rounds })
        : windsurfSourceEvidenceHash({ listing: initialListing.fingerprint, targetStatus });
    const contentCursor = completeReadResult
        ? windsurfSourceEvidenceHash({ stepCount: completeReadResult.steps.length, contentHash, lastStep: completeReadResult.steps.at(-1) ?? null })
        : null;
    const eventWatermark = windsurfSourceEvidenceHash({
        initialListing: initialListing.fingerprint,
        verificationListing: verificationListing?.fingerprint ?? null,
        sourceIdentity: identity.source,
    });
    return {
        revision: windsurfSourceEvidenceHash({ identity, contentHash, contentCursor, eventWatermark, targetStatus }),
        contentCursor,
        eventWatermark,
    };
}

function buildWindsurfFullSourceReadEvidence(
    identity: SourceConversationIdentity,
    sourceRevision: SourceRevision,
    pagination: WindsurfSourceEvidencePagination,
    enumerationComplete: boolean,
    exactFetchResult: ExactFetchEvidence["exactFetchResult"],
    issues: SourceEvidenceIssue[],
    observedAt: ExactFetchEvidence["observedAt"],
    readResult: WindsurfConversationReadResult | undefined,
): FullSourceReadEvidence | undefined {
    if (!readResult || exactFetchResult !== "present" || !enumerationComplete || issues.length > 0) return undefined;
    if (readResult.partial || readResult.steps.length !== readResult.thread.stepCount || readResult.rounds.length === 0) return undefined;
    const serialized = windsurfSourceEvidenceSerialize({ steps: readResult.steps, rounds: readResult.rounds });
    return buildFullSourceReadEvidence({
        adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: "windsurf",
        identity,
        sourceRevision,
        pagination,
        enumerationComplete: true,
        cacheBypassed: true,
        exactFetchResult: "present",
        errors: [],
        warnings: [],
        observedAt,
        content: {
            mode: "full",
            byteLength: Buffer.byteLength(serialized, "utf8"),
            contentHash: windsurfSourceEvidenceHash({ steps: readResult.steps, rounds: readResult.rounds }),
            roundRange: { start: 1, end: readResult.rounds.length },
            truncated: false,
            staleCache: false,
        },
    });
}

function createWindsurfSourceEvidenceFallbackThread(cascadeId: string): WindsurfConversationSummary {
    return {
        id: cascadeId,
        cascadeId,
        title: cascadeId,
        summary: cascadeId,
        stepCount: 0,
    };
}

function validateWindsurfSourceEvidenceThread(thread: WindsurfConversationSummary): SourceEvidenceIssue[] {
    const issues: SourceEvidenceIssue[] = [];
    if (!Number.isSafeInteger(thread.stepCount) || thread.stepCount < 0) {
        issues.push(windsurfSourceEvidenceIssue("parse_error", `WSF list ${thread.id} 缺少有效 stepCount`));
    }
    if (!thread.lastModifiedTime) {
        issues.push(windsurfSourceEvidenceIssue("parse_error", `WSF list ${thread.id} 缺少 lastModifiedTime`));
    }
    return issues;
}

function mergeWindsurfSourceEvidencePagination(...paginations: Array<WindsurfSourceEvidencePagination | undefined>): WindsurfSourceEvidencePagination {
    const values = paginations.filter((pagination): pagination is WindsurfSourceEvidencePagination => Boolean(pagination));
    return {
        cursor: values.find(pagination => pagination.cursor !== null)?.cursor || null,
        pages: values.reduce((total, pagination) => total + pagination.pages, 0),
        limit: values.reduce<number | null>((current, pagination) => {
            if (pagination.limit === null) return current;
            return current === null ? pagination.limit : Math.max(current, pagination.limit);
        }, null),
        truncated: values.some(pagination => pagination.truncated),
    };
}

function mergeWindsurfSourceEvidenceIssues(...groups: Array<readonly SourceEvidenceIssue[]>): SourceEvidenceIssue[] {
    const deduplicated = new Map<string, SourceEvidenceIssue>();
    for (const group of groups) {
        for (const issue of group) deduplicated.set(`${issue.code}\u0000${issue.message}`, issue);
    }
    return [...deduplicated.values()].sort((left, right) => left.code === right.code ? left.message.localeCompare(right.message, "en") : left.code.localeCompare(right.code, "en"));
}

function windsurfSourceEvidenceIssue(code: SourceEvidenceIssue["code"], message: string): SourceEvidenceIssue {
    return { code, message };
}

function windsurfSourceEvidenceIssueFromError(error: unknown, phase: "list" | "exact"): SourceEvidenceIssue {
    const message = error instanceof Error ? error.message : String(error);
    if (/\btimeout\b|timed out|abort(?:ed)?/iu.test(message)) return windsurfSourceEvidenceIssue("timeout", `WSF ${phase} 超时: ${truncate(message, 400)}`);
    if (/^WSF (?:list response|list trajectorySummaries|exact fetch response|exact fetch (?:steps|trajectorySteps|cascadeTrajectorySteps))/u.test(message)) {
        return windsurfSourceEvidenceIssue("parse_error", `WSF ${phase} payload 无法解析: ${truncate(message, 400)}`);
    }
    if (phase === "exact") return windsurfSourceEvidenceIssue("exact_fetch_failed", `WSF exact fetch 失败: ${truncate(message, 400)}`);
    return windsurfSourceEvidenceIssue("source_unavailable", `WSF list 失败: ${truncate(message, 400)}`);
}

function isWindsurfSourceEvidenceNotFound(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /\b404\b|not[ _-]?found|does not exist|unknown cascade/iu.test(message);
}

function normalizeWindsurfSourceEvidenceMaxPages(value: number | undefined): number {
    if (value === undefined) return DEFAULT_WINDSURF_SOURCE_EVIDENCE_MAX_PAGES;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("Windsurf source evidence maxPages 必须是正整数");
    return value;
}

function windsurfSourceEvidenceRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} 必须是普通对象`);
    return value as Record<string, unknown>;
}

function windsurfSourceEvidenceOptionalString(value: unknown, label: string): string | null {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
    const normalized = value.trim();
    if (!normalized) throw new Error(`${label} 不能为空白`);
    return normalized;
}

function windsurfSourceEvidenceOptionalBoolean(value: unknown, label: string): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value !== "boolean") throw new Error(`${label} 必须是布尔值`);
    return value;
}

function windsurfSourceEvidenceThreadProjection(thread: WindsurfConversationSummary): Record<string, unknown> {
    return {
        id: thread.id,
        cascadeId: thread.cascadeId,
        trajectoryId: thread.trajectoryId || null,
        title: thread.title,
        renamedTitle: thread.renamedTitle || null,
        titleBestEffort: thread.titleBestEffort || null,
        titleSource: thread.titleSource || null,
        isChildThread: Boolean(thread.isChildThread),
        parentConversationId: thread.parentConversationId || null,
        agentRole: thread.agentRole || null,
        agentNickname: thread.agentNickname || null,
        summary: thread.summary,
        stepCount: thread.stepCount,
        createdTime: thread.createdTime || null,
        lastModifiedTime: thread.lastModifiedTime || null,
        status: thread.status || null,
        trajectoryType: thread.trajectoryType || null,
        lastGeneratorModelUid: thread.lastGeneratorModelUid || null,
        cwd: thread.cwd || null,
        workspaceUris: thread.workspaceUris || [],
        referencedFiles: thread.referencedFiles || [],
    };
}

function windsurfSourceEvidenceTimestamp(now: () => Date): string {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Windsurf source evidence now() 必须返回有效 Date");
    return value.toISOString();
}

function windsurfSourceEvidenceHash(value: unknown): string {
    return `sha256:${crypto.createHash("sha256").update(windsurfSourceEvidenceSerialize(value), "utf8").digest("hex")}`;
}

function windsurfSourceEvidenceSerialize(value: unknown): string {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0) ? JSON.stringify(value) : JSON.stringify(String(value));
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    if (Array.isArray(value)) return `[${value.map(item => windsurfSourceEvidenceSerialize(item)).join(",")}]`;
    if (typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key.normalize("NFC"))}:${windsurfSourceEvidenceSerialize(record[key])}`).join(",")}}`;
    }
    return JSON.stringify(String(value));
}

function extractUserText(userInput: Record<string, any>): string {
    const direct = toStringValue(userInput.userResponse);
    if (direct.length > 0) return direct;

    const chunks: string[] = [];
    for (const item of asArray(userInput.items)) {
        const text = toStringValue(asRecord(item).text);
        if (text.length > 0 && !chunks.includes(text)) chunks.push(text);
    }

    return chunks.join("\n\n");
}

function estimateBase64Bytes(base64: string): number {
    let encodedChars = 0;
    let trailingPadding = 0;
    for (let index = base64.length - 1; index >= 0; index -= 1) {
        const character = base64.charCodeAt(index);
        if (character === 9 || character === 10 || character === 11 || character === 12 || character === 13 || character === 32) continue;
        encodedChars += 1;
        if (encodedChars === trailingPadding + 1 && character === 61) {
            trailingPadding += 1;
        }
    }
    return Math.max(0, Math.floor((encodedChars * 3) / 4) - Math.min(trailingPadding, 2));
}

function exceedsWindsurfAttachmentBase64Limit(base64: string): boolean {
    return base64.length > WINDSURF_IMAGE_ATTACHMENT_MAX_ENCODED_CHARS
        || estimateBase64Bytes(base64) > WINDSURF_IMAGE_ATTACHMENT_MAX_DECODED_BYTES;
}

function hasOversizedWindsurfImageBase64(value: unknown, seen = new Set<object>()): boolean {
    if (!value || typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(item => hasOversizedWindsurfImageBase64(item, seen));
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (key === "base64Data" && typeof nested === "string" && exceedsWindsurfAttachmentBase64Limit(nested)) return true;
        if (hasOversizedWindsurfImageBase64(nested, seen)) return true;
    }
    return false;
}

function prepareWindsurfAttachmentBase64(value: unknown): { base64: string | null; sizeBytes: number; warning?: string } {
    const raw = toStringValue(value);
    if (!raw) return { base64: null, sizeBytes: 0 };

    const sizeBytes = estimateBase64Bytes(raw);
    if (exceedsWindsurfAttachmentBase64Limit(raw)) {
        return {
            base64: null,
            sizeBytes,
            warning: `WSF image base64 omitted because its encoded input exceeds the ${WINDSURF_IMAGE_ATTACHMENT_MAX_ENCODED_CHARS}-character safety limit`,
        };
    }

    const base64 = raw.normalize("NFC").replace(/\s+/gu, "");
    const normalizedSizeBytes = estimateBase64Bytes(base64);
    if (exceedsWindsurfAttachmentBase64Limit(base64)) {
        return {
            base64: null,
            sizeBytes: normalizedSizeBytes,
            warning: `WSF image base64 omitted because its normalized payload exceeds the ${WINDSURF_IMAGE_ATTACHMENT_MAX_ENCODED_CHARS}-character safety limit`,
        };
    }

    return { base64, sizeBytes: normalizedSizeBytes };
}

function extensionFromMime(mimeType: string): string {
    switch (mimeType.toLowerCase()) {
        case "image/jpeg":
        case "image/jpg":
            return ".jpg";
        case "image/webp":
            return ".webp";
        case "image/gif":
            return ".gif";
        case "image/bmp":
            return ".bmp";
        case "image/png":
        default:
            return ".png";
    }
}

function buildImageAttachment(image: unknown, stepIndex: number, imageIndex: number): ConversationAttachment {
    const record = asRecord(image);
    const mimeType = toStringValue(record.mimeType) || "image/png";
    const preparedBase64 = prepareWindsurfAttachmentBase64(record.base64Data);
    const name = `wsf-step-${stepIndex}-image-${imageIndex + 1}${extensionFromMime(mimeType)}`;
    const descriptor: Record<string, unknown> = {
        kind: "image",
        source: "windsurf-data-url",
        name,
        mimeType,
        sizeBytes: preparedBase64.sizeBytes,
        stepIndex,
    };

    if (preparedBase64.warning) {
        descriptor.warning = preparedBase64.warning;
    } else if (preparedBase64.base64) {
        try {
            const decoded = Buffer.from(preparedBase64.base64, "base64");
            if (decoded.byteLength > WINDSURF_IMAGE_ATTACHMENT_MAX_DECODED_BYTES) {
                descriptor.warning = `WSF image base64 omitted because its decoded payload exceeds the ${WINDSURF_IMAGE_ATTACHMENT_MAX_DECODED_BYTES}-byte safety limit`;
            } else {
                descriptor.dataUrl = `data:${mimeType};base64,${preparedBase64.base64}`;
                descriptor.sha256 = crypto.createHash("sha256").update(decoded).digest("hex");
            }
        } catch {
            descriptor.warning = "WSF image base64 could not be hashed";
        }
    } else {
        descriptor.warning = "WSF image descriptor has no base64Data";
    }

    return descriptor as unknown as ConversationAttachment;
}

function extractImageAttachments(step: Record<string, any>, stepIndex: number): ConversationAttachment[] {
    return asArray(asRecord(step.userInput).images).map((image, imageIndex) => buildImageAttachment(image, stepIndex, imageIndex));
}

function extractPlannerText(plannerResponse: Record<string, any>): string {
    if (typeof plannerResponse.modifiedResponse === "string" && plannerResponse.modifiedResponse.length > 0) {
        return plannerResponse.modifiedResponse;
    }
    return typeof plannerResponse.response === "string" ? plannerResponse.response : "";
}

function extractMetadataToolCall(step: Record<string, any>): Record<string, any> {
    return asRecord(asRecord(step.metadata).toolCall);
}

function pushMetadataToolCall(
    round: ConversationRound,
    step: Record<string, any>,
    stepIndex: number,
    resultSummary: string,
    fallbackName: string,
): void {
    const toolCall = extractMetadataToolCall(step);
    const name = toStringValue(toolCall.name) || fallbackName;
    const argsSummary = toStringValue(toolCall.argumentsJson);
    round.toolCalls.push({
        stepIndex,
        name,
        argsSummary: truncate(argsSummary, 240),
        resultSummary: truncate(resultSummary, 2000),
    });
}

function extractThinkingMetadata(plannerResponse: Record<string, any>): Record<string, string | boolean> | undefined {
    const metadata: Record<string, string | boolean> = {};
    const thinkingDuration = toStringValue(plannerResponse.thinkingDuration);
    const signatureType = toStringValue(plannerResponse.signatureType);
    const messageId = toStringValue(plannerResponse.messageId);
    if (thinkingDuration) metadata.thinkingDuration = thinkingDuration;
    if (signatureType) metadata.signatureType = signatureType;
    if (messageId) metadata.messageId = messageId;
    if (toStringValue(plannerResponse.thinking)) metadata.hasThinking = true;
    return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function summarizeRunCommand(runCommand: Record<string, any>): string {
    const command = toStringValue(runCommand.commandLine || runCommand.proposedCommandLine);
    const cwd = toStringValue(runCommand.cwd);
    const exitCode = runCommand.exitCode !== undefined ? `exit=${runCommand.exitCode}` : "";
    const output = toStringValue(asRecord(runCommand.combinedOutput).full)
        || toStringValue(asRecord(runCommand.combinedOutput).ansiOutput)
        || toStringValue(runCommand.rawDebugOutput);
    return [
        command ? `command: ${command}` : "",
        cwd ? `cwd: ${cwd}` : "",
        exitCode,
        output ? `output:\n${output}` : "",
    ].filter(Boolean).join("\n");
}

function summarizeCommandStatus(commandStatus: Record<string, any>): string {
    const commandId = toStringValue(commandStatus.commandId);
    const status = toStringValue(commandStatus.status);
    const combined = toStringValue(commandStatus.combined);
    return [
        commandId ? `commandId: ${commandId}` : "",
        status ? `status: ${status}` : "",
        combined,
    ].filter(Boolean).join("\n");
}

function summarizeListDirectory(listDirectory: Record<string, any>): string {
    const uri = toStringValue(listDirectory.directoryPathUri);
    const results = asArray(listDirectory.results).map(item => {
        const record = asRecord(item);
        const name = toStringValue(record.name);
        const suffix = record.isDir ? "/" : "";
        const size = record.sizeBytes ? ` (${record.sizeBytes} bytes)` : "";
        return name ? `${name}${suffix}${size}` : "";
    }).filter(Boolean).join("\n");
    return [uri ? `directory: ${uri}` : "", results].filter(Boolean).join("\n");
}

function summarizeFind(find: Record<string, any>): string {
    const directory = toStringValue(find.searchDirectory);
    const pattern = toStringValue(find.pattern);
    const total = find.totalResults !== undefined ? `total=${find.totalResults}` : "";
    const output = toStringValue(find.rawOutput) || toStringValue(find.truncatedOutput);
    return [
        directory ? `directory: ${directory}` : "",
        pattern ? `pattern: ${pattern}` : "",
        total,
        output,
    ].filter(Boolean).join("\n");
}

function summarizeViewFile(viewFile: Record<string, any>): string {
    const uri = toStringValue(viewFile.absolutePathUri);
    const endLine = viewFile.endLine !== undefined ? `endLine=${viewFile.endLine}` : "";
    const content = toStringValue(viewFile.content);
    return [uri ? `file: ${uri}` : "", endLine, content].filter(Boolean).join("\n");
}

function summarizeMcpTool(mcpTool: Record<string, any>): string {
    const serverName = toStringValue(mcpTool.serverName);
    const result = toStringValue(mcpTool.resultString);
    return [serverName ? `server: ${serverName}` : "", result].filter(Boolean).join("\n");
}

function summarizeProxyWebServer(proxyWebServer: Record<string, any>): string {
    const name = toStringValue(proxyWebServer.name);
    const targetUrl = toStringValue(proxyWebServer.targetUrl);
    const proxyUrl = toStringValue(proxyWebServer.proxyUrl);
    return [
        name ? `name: ${name}` : "",
        targetUrl ? `target: ${targetUrl}` : "",
        proxyUrl ? `proxy: ${proxyUrl}` : "",
    ].filter(Boolean).join("\n");
}

function uriToPathLike(uri: string): string {
    if (!uri) return "";
    try {
        if (uri.startsWith("file://")) return decodeURIComponent(new URL(uri).pathname).replace(/^\/([A-Za-z]:)/u, "$1").replace(/\//gu, "\\");
    } catch {
        return uri;
    }
    return uri;
}

function diffLinesToUnified(diff: Record<string, any>): string {
    const lines = asArray(asRecord(diff.unifiedDiff).lines);
    return lines.map(line => {
        const record = asRecord(line);
        const text = toStringValue(record.text);
        const type = toStringValue(record.type);
        if (type.includes("INSERT")) return `+${text}`;
        if (type.includes("DELETE")) return `-${text}`;
        return ` ${text}`;
    }).join("\n");
}

function summarizeCodeAction(codeAction: Record<string, any>): string {
    const actionSpec = asRecord(codeAction.actionSpec);
    const targetUri = toStringValue(asRecord(asRecord(actionSpec.createFile).path).absoluteUri)
        || toStringValue(asRecord(asRecord(actionSpec.updateFile).path).absoluteUri)
        || toStringValue(asRecord(actionSpec.path).absoluteUri)
        || toStringValue(actionSpec.targetFile);
    const result = asRecord(codeAction.actionResult);
    const edit = asRecord(result.edit);
    const uri = toStringValue(edit.absoluteUri) || targetUri;
    const createFile = edit.createFile === true ? "createFile=true" : "";
    const instruction = toStringValue(asRecord(actionSpec.createFile).instruction)
        || toStringValue(asRecord(actionSpec.updateFile).instruction)
        || toStringValue(actionSpec.instruction);
    return [
        uri ? `file: ${uriToPathLike(uri)}` : "",
        createFile,
        instruction ? `instruction:\n${instruction}` : "",
    ].filter(Boolean).join("\n");
}

function extractCodeActionFile(codeAction: Record<string, any>): string {
    const actionSpec = asRecord(codeAction.actionSpec);
    const edit = asRecord(asRecord(codeAction.actionResult).edit);
    const uri = toStringValue(edit.absoluteUri)
        || toStringValue(asRecord(asRecord(actionSpec.createFile).path).absoluteUri)
        || toStringValue(asRecord(asRecord(actionSpec.updateFile).path).absoluteUri)
        || toStringValue(asRecord(actionSpec.path).absoluteUri)
        || toStringValue(actionSpec.targetFile);
    return uriToPathLike(uri);
}

function extractCodeActionDiff(codeAction: Record<string, any>): string {
    const diff = asRecord(asRecord(asRecord(codeAction.actionResult).edit).diff);
    return diffLinesToUnified(diff);
}

function attachWindsurfToolStep(round: ConversationRound, step: Record<string, any>, stepIndex: number): void {
    const type = toStringValue(step.type);
    if (type === "CORTEX_STEP_TYPE_MCP_TOOL") {
        const mcpTool = asRecord(step.mcpTool);
        const toolCall = asRecord(mcpTool.toolCall);
        round.toolCalls.push({
            stepIndex,
            name: toStringValue(toolCall.name) || toStringValue(extractMetadataToolCall(step).name) || "mcp_tool",
            argsSummary: truncate(toStringValue(toolCall.argumentsJson || extractMetadataToolCall(step).argumentsJson), 240),
            resultSummary: truncate(summarizeMcpTool(mcpTool), 2000),
        });
        return;
    }
    if (type === "CORTEX_STEP_TYPE_RUN_COMMAND") {
        pushMetadataToolCall(round, step, stepIndex, summarizeRunCommand(asRecord(step.runCommand)), "run_command");
        return;
    }
    if (type === "CORTEX_STEP_TYPE_COMMAND_STATUS") {
        pushMetadataToolCall(round, step, stepIndex, summarizeCommandStatus(asRecord(step.commandStatus)), "command_status");
        return;
    }
    if (type === "CORTEX_STEP_TYPE_LIST_DIRECTORY") {
        pushMetadataToolCall(round, step, stepIndex, summarizeListDirectory(asRecord(step.listDirectory)), "list_dir");
        return;
    }
    if (type === "CORTEX_STEP_TYPE_FIND") {
        pushMetadataToolCall(round, step, stepIndex, summarizeFind(asRecord(step.find)), "find_by_name");
        return;
    }
    if (type === "CORTEX_STEP_TYPE_VIEW_FILE") {
        const viewFile = asRecord(step.viewFile);
        const textSummary = summarizeViewFile(viewFile);
        pushMetadataToolCall(round, step, stepIndex, textSummary, "read_file");
        round.fileViews = round.fileViews || [];
        round.fileViews.push({
            stepIndex,
            kind: "windsurf_view_file",
            title: uriToPathLike(toStringValue(viewFile.absolutePathUri)),
            textSummary: truncate(textSummary, 2000),
        } as NonNullable<ConversationRound["fileViews"]>[number]);
        return;
    }
    if (type === "CORTEX_STEP_TYPE_CODE_ACTION") {
        const codeAction = asRecord(step.codeAction);
        pushMetadataToolCall(round, step, stepIndex, summarizeCodeAction(codeAction), "code_action");
        const unifiedDiff = extractCodeActionDiff(codeAction);
        round.codeActions.push({
            stepIndex,
            description: toStringValue(extractMetadataToolCall(step).name) || "Windsurf code action",
            targetFile: extractCodeActionFile(codeAction),
            instruction: truncate(summarizeCodeAction(codeAction), 500),
            diffs: unifiedDiff ? [{ targetContent: "", replacementContent: "", unifiedDiff }] : [],
        });
        return;
    }
    if (type === "CORTEX_STEP_TYPE_PROXY_WEB_SERVER") {
        pushMetadataToolCall(round, step, stepIndex, summarizeProxyWebServer(asRecord(step.proxyWebServer)), "proxy_web_server");
    }
}

function createRound(roundIndex: number, step: Record<string, any>, stepIndex: number): ConversationRound {
    const userInput = asRecord(step.userInput);
    return {
        roundIndex,
        startStep: stepIndex,
        endStep: stepIndex,
        userMessage: extractUserText(userInput),
        mediaAttachments: [],
        attachments: extractImageAttachments(step, stepIndex),
        aiResponses: [],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    };
}

export function windsurfStepsToConversationRounds(steps: unknown[]): ConversationRound[] {
    const rounds: ConversationRound[] = [];
    let currentRound: ConversationRound | undefined;

    for (let index = 0; index < steps.length; index++) {
        const step = asRecord(steps[index]);
        const type = toStringValue(step.type);

        if (isOversizedStepPlaceholder(step)) {
            if (currentRound) {
                rounds.push(currentRound);
            }
            currentRound = createOversizedStepRound(rounds.length + 1, step, index);
            continue;
        }

        if (type === "CORTEX_STEP_TYPE_USER_INPUT") {
            if (currentRound) rounds.push(currentRound);
            currentRound = createRound(rounds.length + 1, step, index);
            continue;
        }

        if (!currentRound) continue;
        currentRound.endStep = index;

        if (type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
            const plannerResponse = asRecord(step.plannerResponse);
            const aiResponse: Record<string, unknown> = {
                stepIndex: index,
                response: extractPlannerText(plannerResponse),
                thinking: toStringValue(plannerResponse.thinking),
                toolCalls: asArray(plannerResponse.toolCalls).map(toolCall => {
                    const record = asRecord(toolCall);
                    return {
                        name: toStringValue(record.name),
                        args: truncate(toStringValue(record.argumentsJson), 120),
                    };
                }),
            };
            const thinkingMetadata = extractThinkingMetadata(plannerResponse);
            if (thinkingMetadata) aiResponse.thinkingMetadata = thinkingMetadata;
            currentRound.aiResponses.push(aiResponse as unknown as ConversationRound["aiResponses"][number]);
            continue;
        }

        attachWindsurfToolStep(currentRound, step, index);
    }

    if (currentRound) rounds.push(currentRound);
    return rounds;
}
