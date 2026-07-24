import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import os from "node:os";
import { z } from "zod";
import { touchActivity } from "../lifecycle.js";
import { listConversationsByMtime, detectWorkspaceFromSteps, fetchFirstPageSteps } from "../ls-client.js";
import {
    readRecord, readRecordAsync, writeRecord, writeRecordWithCommitArtifactLockHeld, upsertRecordIndex,
    deleteRecord, deleteRecordWithCommitArtifactLockHeld, withRecordCommitArtifactLock, listRecords, copyRecordToHash,
    searchRecordsGlobal,
    resolveWorkspaceHashForRecord, readRecordsIndex, readRecordsIndexAsync, findRecordHash, findRecordHashAsync, resolveRecordConversationId,
    readRecordSidecar, readRecordSidecarAsync, writeRecordSidecar, type RecordIndexEntry,
} from "../record-store.js";
import { DATA_ROOT, GENERAL_DIR, WORKSPACES_DIR, ensureWorkspace, ensureWorkspaceAsync, listWorkspaceHashes, listWorkspaceHashesAsync, readWorkspaceMeta, workspaceHash, writeJsonAtomic, writeJsonAtomicAsync, withIndexLock } from "../store.js";
import {
    generateRecord, countPhasesInRecord, inferCoveredRoundFromRecord, validateRecordCandidateForWrite, type RecordParallelMode,
} from "../record-generator.js";
import { saveTempFile, saveTempFileAsync } from "../temp-store.js";
import { CHAIN_COMPAT_INPUT_VALUES, DATA_CHAIN_INPUT_VALUES, DEFAULT_CHAIN, resolveChainSplit, decideBackground, type Chain, type ChainInput, type DataChainInput, type DataChain, type ConversationLogicalChainMode } from "../chain.js";
import type { ConcurrencyGateRequestClass } from "../concurrency-gate.js";
import { formatToolError } from "../error-format.js";
import { dataChainInputSchema, modelChainInputSchema } from "./schema-utils.js";
import {
    formatRecordSchedulerCancel,
    formatRecordSchedulerRecovery,
    formatRecordSchedulerTaskStatus,
    getRecordSchedulerRuntime,
    RecordSchedulerRepairRequiredError,
    recordSchedulerRequestKey,
    type RecordSchedulerRuntimeDiscoveryRecord,
    type RecordSchedulerRuntimeDiscoveryRequest,
    type RecordSchedulerRuntime,
    type RecordSchedulerRuntimeRecoveryDescriptor,
    type FrozenRuntimeSource,
    type FrozenRuntimeSourceSet,
} from "../record-scheduler-runtime.js";
import {
    createRecordSchedulerProductionSession,
    type RecordSchedulerProductionSession,
} from "../record-scheduler-production-pump.js";
import { verifyOrRecoverTaskAdmission } from "../record-scheduler-store.js";
import { SOURCE_CHAINS, isTerminalTaskState, type SourceChain } from "../record-scheduler-contracts.js";
import {
    recordWorkIdentityManifestPath,
    recordWorkRegistryPath,
    withRecordWorkManualMutationAuthority,
    type RecordWorkManualMutationKind,
} from "../record-work-registry.js";
import {
    createProductionSourceReader,
    PRODUCTION_SOURCE_CONTENT_SCHEMA_VERSION,
    isSupportedProductionSourceFormatterVersion,
    type ProductionSourceReadRequest,
    type ProductionSourceReader,
} from "../record-production-source-readers.js";
import { PROVIDER_CONTROL_PHYSICAL_MAX } from "../provider-control-contracts.js";
import type { RecordCommitStorageAdapterHooks } from "../record-commit-storage-adapter.js";
import {
    inspectUnknownChainMigration,
    type HistoricalRecordIndexEntry,
    type UnknownChainMigrationReaders,
    type UnknownChainMigrationResult,
} from "../record-unknown-chain-migration.js";
import { SOURCE_EVIDENCE_HOSTS, type SourceEvidenceHost } from "../source-evidence-contracts.js";
import {
    loadConversationData,
    resolveConversationChain,
    resolveConversationId,
    type ConversationLoadResult,
    type ResolvedConversationChain,
} from "../conversation-bridge.js";
import type { ConversationRound } from "../trajectory.js";
import { getCodexParentThread, getCodexThread, listRecentCodexThreads } from "../codex-client.js";
import { getClaudeCodeThread } from "../claude-code-client.js";
import {
    BACKGROUND_TASK_RESUME_VERSION,
    cancelBackgroundTask,
    formatBackgroundTask,
    getBackgroundTaskRecoveryHandler,
    getRecordSchedulerProjectionHint,
    inspectBackgroundTaskRecovery,
    isValidBackgroundTaskId,
    recoverBackgroundTask,
    registerBackgroundTaskRecoveryHandler,
    startBackgroundTask,
    waitForBackgroundTask,
} from "../background-tasks.js";
import type { BackgroundTask, BackgroundTaskContext, BackgroundTaskProgress } from "../background-tasks.js";
import { isBackgroundTaskSuspension } from "../background-task-suspension.js";
import {
    RECORD_READER_VERSION,
    RECORD_SECTION_TYPES,
    buildOutline,
    buildRecordReaderIndex,
    formatReaderView,
    isRecordReaderIndexFresh,
    selectRecordReaderBlocks,
    type FormatReaderViewOptions,
    type ReaderBlock,
    type RecordReaderIndex,
    type RecordReaderIndexMode,
    type RecordReaderView,
    type RecordSectionType,
} from "../record-reader.js";
import { search, type SearchMode, type SearchResult, type TextBlock } from "../search-engine.js";
import {
    RecordSingleFlightAbortError,
    RecordUpdatePoolAbortError,
    __recordUpdateCoordinationTest,
    acquireRecordSingleFlightPermit,
    buildAndPersistRecordReaderIndex,
    formatRecordUpdatePoolDetail,
    getRecordPersistenceConcurrencySnapshot,
    getRecordTaskAbortReason,
    getRecordUpdateConcurrencyLimit,
    isRecordPersistenceCongestionError,
    withRecordPersistenceWrite,
    withRecordUpdateSharedPermit,
    type RecordGateAcquireOptions,
    type RecordUpdateSharedPermit,
} from "../record-update-coordination.js";
import type { ConcurrencyGateAcquireOptions, ConcurrencyGatePermit, ConcurrencyGateSnapshot } from "../concurrency-gate.js";
import { waitForRecordMutationReadiness } from "../record-startup-barrier.js";
import type { GrokExecDiagnostics } from "../grok-client.js";

type RecordManageScope = "workspace" | "global" | "general";
type RecordSearchScope = "record" | "phase" | "section" | "item";
type RecordReadFormat = "text" | "json";
type RecordGuideRecommendation = {
    type: "read" | "search";
    reason: string;
    readHint?: Record<string, unknown>;
    searchHint?: Record<string, unknown>;
    provenance?: Record<string, unknown>;
};
type OwnershipSourceType =
    | "explicit_workspace"
    | "antigravity_workspace_uri"
    | "codex_cwd"
    | "claude_code_cwd"
    | "windsurf_cwd"
    | "child_parent"
    | "duplicate"
    | "unknown";
type OwnershipStatus = "ok" | "duplicate" | "migratable" | "conflict" | "unknown";

export interface RecordSourceSnapshot {
    chain: DataChain;
    rounds: number;
    totalSteps: number;
    rolloutPath?: string;
    rolloutMtimeMs?: number;
}

const RECORD_RESUME_MODEL_CHAINS = ["auto", "antigravity", "codex", "grok", "agy", "claude-code"] as const;
const RECORD_RESUME_DATA_CHAINS = ["antigravity", "codex", "claude-code", "windsurf"] as const;
const RECORD_RESUME_PARALLEL_MODES = ["off", "auto", "force"] as const;
const RECORD_RESUME_LOGICAL_CHAINS = ["off", "explain", "auto", "strict"] as const;
const RECORD_RECOVERABLE_TASK_KINDS = new Set(["record-update", "record-batch-update"]);
const RECORD_BATCH_TIMEOUT_MESSAGE = "batch_update 后台批量更新超时；可缩小 limit/时间范围后重试";
const RECORD_RECOVERY_DIR = path.join(DATA_ROOT, "record-task-recovery");
const RECORD_BATCH_LEDGER_VERSION = 2;
const RECORD_SCHEDULER_COORDINATOR_OWNER_ID = `record-tools:${process.pid}:${crypto.randomUUID()}`;

class RecordBatchLedgerRepairRequiredError extends Error {
    readonly code = "SCHEDULER_REPAIR_REQUIRED";

    constructor(resumeKey: string, reason: string) {
        super(`RepairRequired: Record batch ledger ${resumeKey} 无法安全读取：${reason}`);
        this.name = "RecordBatchLedgerRepairRequiredError";
    }
}

const RecordUpdateResumePayloadSchema = z.object({
    kind: z.literal("record-update"),
    conversationId: z.string().min(1),
    workspace: z.string().min(1).optional(),
    workspaceHash: z.string().min(1),
    dataChain: z.enum(RECORD_RESUME_DATA_CHAINS),
    modelChain: z.enum(RECORD_RESUME_MODEL_CHAINS),
    parallelMode: z.enum(RECORD_RESUME_PARALLEL_MODES).optional(),
    force: z.boolean().optional(),
    logicalChain: z.enum(RECORD_RESUME_LOGICAL_CHAINS).optional(),
});

const BatchCandidateSnapshotSchema = z.object({
    id: z.string().min(1),
    workspace: z.string().min(1),
    workspaceHash: z.string().min(1),
    chain: z.enum(RECORD_RESUME_DATA_CHAINS),
    lastModifiedMs: z.number().finite().nonnegative(),
    stepCount: z.number().int().positive().optional(),
});

const BatchConversationCandidateSchema = BatchCandidateSnapshotSchema.extend({
    selectionKind: z.enum(["stale", "missing", "fresh"]),
    refreshExisting: z.boolean(),
});

const LegacyBatchConversationCandidateSchema = z.object({
    id: z.string().min(1),
    workspace: z.string().min(1),
}).passthrough();

const RecordBatchCandidateDiagnosticsSchema = z.object({
    scanned: z.number().int().nonnegative(),
    eligible: z.number().int().nonnegative(),
    selected: z.number().int().nonnegative(),
    truncated: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    sourceEnumerationLimited: z.boolean(),
    workspaceUnresolved: z.number().int().nonnegative().default(0),
});

const RecordBatchResumeBaseSchema = z.object({
    kind: z.literal("record-batch-update"),
    actionName: z.enum(["batch_update", "bulk_update"]),
    resumeKey: z.string().min(1),
    workspaceHash: z.string().min(1),
    dataChain: z.enum(RECORD_RESUME_DATA_CHAINS),
    modelChain: z.enum(RECORD_RESUME_MODEL_CHAINS),
    force: z.boolean().optional(),
    stale_only: z.boolean().optional(),
});

const LegacyRecordBatchResumeBaseSchema = RecordBatchResumeBaseSchema.extend({
    workspaceHash: z.string().min(1).optional(),
});

const RecordBatchRequestSchema = z.object({
    after: z.string().optional(),
    before: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    workspace: z.string().optional(),
});

const LegacyRecordBatchRequestSchema = RecordBatchRequestSchema.extend({
    limit: z.number().finite().optional(),
});

const RecordBatchReadyResumePayloadSchema = RecordBatchResumeBaseSchema.extend({
    phase: z.literal("ready").optional(),
    candidates: z.array(BatchConversationCandidateSchema),
    sourceSelectionHash: z.string().min(1).optional(),
    diagnostics: RecordBatchCandidateDiagnosticsSchema.optional(),
});

const RecordBatchPreparingResumePayloadSchema = RecordBatchResumeBaseSchema.extend({
    phase: z.literal("preparing"),
    request: RecordBatchRequestSchema,
});

const LegacyRecordBatchPreparingResumePayloadSchema = LegacyRecordBatchResumeBaseSchema.extend({
    phase: z.literal("preparing"),
    request: LegacyRecordBatchRequestSchema,
});

const RecordBatchResumePayloadSchema = z.union([
    RecordBatchReadyResumePayloadSchema,
    RecordBatchPreparingResumePayloadSchema,
]);

const LegacyRecordBatchReadyResumePayloadSchema = LegacyRecordBatchResumeBaseSchema.extend({
    phase: z.literal("ready").optional(),
    candidates: z.array(z.object({
        id: z.string().min(1),
        workspace: z.string().min(1),
    })),
});

type RecordUpdateResumePayload = z.infer<typeof RecordUpdateResumePayloadSchema>;
type BatchCandidateSnapshot = z.infer<typeof BatchCandidateSnapshotSchema>;
type FrozenBatchConversationCandidate = z.infer<typeof BatchConversationCandidateSchema>;
type RecordBatchCandidateDiagnostics = z.infer<typeof RecordBatchCandidateDiagnosticsSchema>;
type RecordBatchResumePayload = z.infer<typeof RecordBatchResumePayloadSchema>;
type RecordBatchReadyResumePayload = z.infer<typeof RecordBatchReadyResumePayloadSchema>;
type RecordBatchPreparingResumePayload = z.infer<typeof RecordBatchPreparingResumePayloadSchema>;

function normalizeLegacyRecordBatchLimit(limit: number | undefined): number | undefined {
    if (limit === undefined) return undefined;
    const wholeLimit = Math.trunc(limit);
    if (wholeLimit < 1) return undefined;
    return Math.min(wholeLimit, 200);
}

function normalizeLegacyRecordBatchRequest(
    request: z.infer<typeof LegacyRecordBatchRequestSchema>,
): z.infer<typeof RecordBatchRequestSchema> {
    const { limit, ...rest } = request;
    const normalizedLimit = normalizeLegacyRecordBatchLimit(limit);
    return {
        ...rest,
        ...(normalizedLimit !== undefined ? { limit: normalizedLimit } : {}),
    };
}

function emptyRecordBatchCandidateDiagnostics(
    overrides: Partial<RecordBatchCandidateDiagnostics> = {},
): RecordBatchCandidateDiagnostics {
    return {
        scanned: 0,
        eligible: 0,
        selected: 0,
        truncated: 0,
        conflicts: 0,
        sourceEnumerationLimited: false,
        workspaceUnresolved: 0,
        ...overrides,
    };
}

export function formatRecordBatchCandidateDiagnostics(diagnostics: RecordBatchCandidateDiagnostics): string {
    let out = `🔎 候选诊断: scanned=${diagnostics.scanned} eligible=${diagnostics.eligible} selected=${diagnostics.selected} truncated=${diagnostics.truncated} source-limit=${diagnostics.sourceEnumerationLimited ? "yes" : "no"} conflicts=${diagnostics.conflicts}`;
    if (diagnostics.conflicts > 0) out += "(来源链路冲突已跳过)";
    if (diagnostics.sourceEnumerationLimited) out += "（源枚举达到上限，本次仅覆盖采样集合）";
    if (diagnostics.workspaceUnresolved > 0) {
        out += ` workspace-unresolved=${diagnostics.workspaceUnresolved}(Antigravity workspace 未解析，已跳过)`;
    }
    return out;
}

export function normalizeFrozenBatchCandidate(
    candidate: unknown,
    fallbackChain: ResolvedConversationChain,
    fallbackWorkspaceHash: string,
): FrozenBatchConversationCandidate {
    const legacy = LegacyBatchConversationCandidateSchema.parse(candidate);
    const raw = legacy as z.infer<typeof LegacyBatchConversationCandidateSchema> & {
        chain?: unknown;
        workspaceHash?: unknown;
        lastModifiedMs?: unknown;
        stepCount?: unknown;
        selectionKind?: unknown;
    };
    const parsedChain = z.enum(RECORD_RESUME_DATA_CHAINS).safeParse(raw.chain);
    const parsedWorkspaceHash = z.string().min(1).safeParse(raw.workspaceHash);
    const parsedModified = z.number().finite().nonnegative().safeParse(raw.lastModifiedMs);
    const parsedStepCount = z.number().int().positive().safeParse(raw.stepCount);
    const parsedSelectionKind = z.enum(["stale", "missing", "fresh"]).safeParse(raw.selectionKind);
    const selectionKind = parsedSelectionKind.success ? parsedSelectionKind.data : "fresh";
    return {
        id: legacy.id,
        workspace: legacy.workspace,
        workspaceHash: parsedWorkspaceHash.success ? parsedWorkspaceHash.data : fallbackWorkspaceHash,
        chain: parsedChain.success ? parsedChain.data : fallbackChain,
        lastModifiedMs: parsedModified.success ? parsedModified.data : 0,
        ...(parsedStepCount.success ? { stepCount: parsedStepCount.data } : {}),
        selectionKind,
        refreshExisting: selectionKind !== "missing",
    };
}

function normalizeRecordBatchReadyPayload(payload: {
    kind: "record-batch-update";
    actionName: "batch_update" | "bulk_update";
    resumeKey: string;
    workspaceHash: string;
    dataChain: DataChain;
    modelChain: Chain;
    force?: boolean;
    stale_only?: boolean;
    diagnostics?: RecordBatchCandidateDiagnostics;
    candidates: unknown[];
}): RecordBatchReadyResumePayload {
    return {
        ...payload,
        phase: "ready",
        candidates: payload.candidates.map(candidate => normalizeFrozenBatchCandidate(
            candidate,
            payload.dataChain as ResolvedConversationChain,
            payload.workspaceHash,
        )),
    } as RecordBatchReadyResumePayload;
}

interface RecordBatchLedgerEntry {
    id: string;
    workspace: string;
    recordedAt: string;
    reason?: string;
    isNew?: boolean;
}

type RecordBatchIndexMetadata = Omit<RecordIndexEntry, "lastUpdatedAt" | "sizeBytes">;

interface RecordBatchInFlightEntry extends RecordBatchLedgerEntry {
    contentHash: string;
    metadata?: RecordBatchIndexMetadata;
}

interface RecordBatchResumeLedger {
    version: number;
    resumeKey: string;
    updatedAt: string;
    candidates: FrozenBatchConversationCandidate[];
    completed: RecordBatchLedgerEntry[];
    skipped: RecordBatchLedgerEntry[];
    failed: RecordBatchLedgerEntry[];
    inFlight: RecordBatchInFlightEntry[];
}

type RecordUpdatePoolSummary = {
    peakActive: number;
    peakPending: number;
    maxQueueWaitMs: number;
};

type GrokBatchRuntimeSummary = {
    latest: GrokExecDiagnostics;
    maxBatchQueueWaitMs: number;
    maxGlobalQueueWaitMs: number;
    maxQueueAttempts: number;
};

type UnknownChainMigrationApplyOutcome = "applied" | "conflict";

let unknownChainMigrationReadersOverride: UnknownChainMigrationReaders | null = null;
let unknownChainMigrationSourceReaderOverride: ProductionSourceReader | null = null;

function recordUnknownChainMigrationIndexPath(hash: string): string {
    const base = hash === "general" ? GENERAL_DIR : path.join(WORKSPACES_DIR, hash);
    return path.join(base, "records", "_records_index.json");
}

function recordUnknownChainMigrationHash(value: unknown): string {
    return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function recordUnknownChainMigrationWorkspace(hash: string): { workspaceId: string; canonicalPath: string | null } {
    if (hash === "general") return { workspaceId: hash, canonicalPath: null };
    const meta = readWorkspaceMeta(hash);
    return {
        workspaceId: hash,
        canonicalPath: meta?.canonicalPath || meta?.originalPath || null,
    };
}

function recordUnknownChainMigrationEntries(hash: string): HistoricalRecordIndexEntry[] {
    const index = readRecordsIndex(hash);
    const workspace = recordUnknownChainMigrationWorkspace(hash);
    const indexRevision = recordUnknownChainMigrationHash(index);
    return Object.values(index.records).map(entry => ({
        recordId: entry.conversationId,
        chain: entry.chain,
        workspace,
        conversationId: entry.conversationId,
        indexRevision,
        entryEvidenceHash: recordUnknownChainMigrationHash(entry),
    }));
}

function recordUnknownChainMigrationAntigravitySource(): { endpoint: string; pbRoot: string; vscdbPath: string } {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return {
        endpoint: "antigravity-production",
        pbRoot: path.join(os.homedir(), ".gemini", "antigravity", "conversations"),
        vscdbPath: path.join(appData, "Antigravity", "User", "globalStorage", "state.vscdb"),
    };
}

function recordUnknownChainMigrationSourceRequest(
    entry: HistoricalRecordIndexEntry,
    host: SourceEvidenceHost,
): ProductionSourceReadRequest {
    if (host === "codex") {
        return {
            host,
            conversationId: entry.conversationId,
            workspace: entry.workspace,
        };
    }
    if (host === "claude-code") {
        return {
            host,
            conversationId: entry.conversationId,
            workspaceId: entry.workspace.workspaceId,
            workspacePath: entry.workspace.canonicalPath,
        };
    }
    if (host === "windsurf") {
        return {
            host,
            conversationId: entry.conversationId,
            workspaceId: entry.workspace.workspaceId,
            workspacePath: entry.workspace.canonicalPath,
            requestClass: "background",
        };
    }
    return {
        host,
        conversationId: entry.conversationId,
        workspaceId: entry.workspace.workspaceId,
        workspacePath: entry.workspace.canonicalPath,
        source: recordUnknownChainMigrationAntigravitySource(),
    };
}

function createRecordUnknownChainMigrationReaders(sourceReader: ProductionSourceReader): UnknownChainMigrationReaders {
    const readerForHost = (host: SourceEvidenceHost): NonNullable<UnknownChainMigrationReaders[SourceEvidenceHost]> => ({
        host,
        scan: async ({ entry, signal }) => {
            if (signal?.aborted) throw Object.assign(new Error("unknown-chain migration scan cancelled"), { name: "AbortError" });
            const result = await sourceReader.scan(recordUnknownChainMigrationSourceRequest(entry, host));
            if (signal?.aborted) throw Object.assign(new Error("unknown-chain migration scan cancelled"), { name: "AbortError" });
            return {
                enumeration: result.enumeration,
                exactFetch: result.exactFetch,
                fullSourceRead: result.fullSourceRead.evidence,
            };
        },
    });
    return {
        codex: readerForHost("codex"),
        "claude-code": readerForHost("claude-code"),
        windsurf: readerForHost("windsurf"),
        antigravity: readerForHost("antigravity"),
    };
}

function recordUnknownChainMigrationReaders(): UnknownChainMigrationReaders {
    if (unknownChainMigrationReadersOverride) return unknownChainMigrationReadersOverride;
    return createRecordUnknownChainMigrationReaders(
        unknownChainMigrationSourceReaderOverride || createProductionSourceReader(),
    );
}

async function applyUnknownChainMigrationPatch(
    workspaceHashValue: string,
    result: Extract<UnknownChainMigrationResult, { status: "Patched" }>,
): Promise<UnknownChainMigrationApplyOutcome> {
    const patch = result.patch;
    if (patch.replacement.workspace.workspaceId !== workspaceHashValue
        || patch.replacement.conversationId !== patch.recordId) {
        return "conflict";
    }
    return withIndexLock(`records_${workspaceHashValue}`, async () => {
        const index = await readRecordsIndexAsync(workspaceHashValue);
        const entry = index.records[patch.recordId];
        if (!entry
            || entry.chain !== patch.cas.expectedChain
            || recordUnknownChainMigrationHash(index) !== patch.cas.expectedIndexRevision
            || recordUnknownChainMigrationHash(entry) !== patch.cas.expectedEntryEvidenceHash) {
            return "conflict";
        }
        index.records[patch.recordId] = {
            ...entry,
            chain: patch.replacement.chain,
        };
        await writeJsonAtomicAsync(recordUnknownChainMigrationIndexPath(workspaceHashValue), index);
        return "applied";
    });
}

function updateGrokBatchRuntimeSummary(summary: GrokBatchRuntimeSummary | undefined, diagnostics: GrokExecDiagnostics): GrokBatchRuntimeSummary {
    return {
        latest: diagnostics,
        maxBatchQueueWaitMs: Math.max(summary?.maxBatchQueueWaitMs || 0, diagnostics.batchQueueWaitMs),
        maxGlobalQueueWaitMs: Math.max(summary?.maxGlobalQueueWaitMs || 0, diagnostics.globalQueueWaitMs),
        maxQueueAttempts: Math.max(summary?.maxQueueAttempts || 0, diagnostics.queueAttempts),
    };
}

function getRecordBatchWorkerConcurrency(): number {
    const raw = Number(process.env.MEMORY_STORE_RECORD_BATCH_CONCURRENCY || "");
    const configured = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : getRecordUpdateConcurrencyLimit();
    return Math.max(PROVIDER_CONTROL_PHYSICAL_MAX, configured);
}

type RecordPersistenceTestHook = (event: {
    stage: string;
    conversationId: string;
    persistencePath: "legacy" | "scheduler";
}) => void | Promise<void>;

let recordPersistenceTestHook: RecordPersistenceTestHook | null = null;

async function runRecordPersistenceTestHook(
    stage: string,
    conversationId: string,
    persistencePath: "legacy" | "scheduler" = "legacy",
): Promise<void> {
    await recordPersistenceTestHook?.({ stage, conversationId, persistencePath });
}

function schedulerRecordPersistenceTestHooks(conversationId: string): RecordCommitStorageAdapterHooks | undefined {
    if (!recordPersistenceTestHook) return undefined;
    return {
        onFaultPoint: async ({ stage, point }) => {
            if (point !== "before_write") return;
            if (stage === "BodyPublished") {
                await runRecordPersistenceTestHook("before_write", conversationId, "scheduler");
            }
        },
        onReaderIndexWritePoint: async ({ point }) => {
            if (point === "before_replace") await runRecordPersistenceTestHook("before_reader_index", conversationId, "scheduler");
        },
    };
}

async function withRecordManagementSingleFlight<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const singleFlightPermit = await acquireRecordSingleFlightPermit(conversationId);
    try {
        return await operation();
    } finally {
        singleFlightPermit.release();
    }
}


function updateRecordUpdatePoolSummary(
    summary: RecordUpdatePoolSummary,
    snapshot: ConcurrencyGateSnapshot,
    queueWaitMs: number,
): void {
    summary.peakActive = Math.max(summary.peakActive, snapshot.active);
    summary.peakPending = Math.max(summary.peakPending, snapshot.pending);
    summary.maxQueueWaitMs = Math.max(summary.maxQueueWaitMs, queueWaitMs);
}

function recordUpdatePoolAbortResponse(
    startMs: number,
    error: RecordUpdatePoolAbortError,
    stage: string,
) {
    const prefix = error.reason === "cancelled"
        ? "🛑 Record 更新已取消"
        : "⚠️ 后台任务已结算";
    return rt(`${prefix}：${stage} | ${formatRecordUpdatePoolDetail(error.snapshot)}`, startMs);
}

export function isRecordBatchUpdateAction(action?: string): boolean {
    return action === "batch_update" || action === "bulk_update";
}

function recordTasksDirPath(): string {
    return path.join(DATA_ROOT, "tasks");
}

function recordTaskFilePath(taskId: string): string {
    return path.join(recordTasksDirPath(), `${taskId}.json`);
}

function recordTaskClaimPath(taskId: string): string {
    return path.join(recordTasksDirPath(), `${taskId}.claim`);
}

function recordBatchLedgerPath(resumeKey: string): string {
    return path.join(RECORD_RECOVERY_DIR, `record-batch-${resumeKey}.json`);
}

function ensureRecordRecoveryDir(): void {
    fs.mkdirSync(RECORD_RECOVERY_DIR, { recursive: true });
}

function readPersistedRecordTask(taskId: string): BackgroundTask | null {
    if (!isValidBackgroundTaskId(taskId)) return null;
    try {
        const raw = fs.readFileSync(recordTaskFilePath(taskId), "utf-8");
        const parsed = JSON.parse(raw) as BackgroundTask;
        if (!parsed || typeof parsed.id !== "string" || typeof parsed.kind !== "string" || typeof parsed.status !== "string") {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

function listPersistedRecordTasks(): BackgroundTask[] {
    try {
        if (!fs.existsSync(recordTasksDirPath())) return [];
        return fs.readdirSync(recordTasksDirPath())
            .filter(entry => entry.endsWith(".json"))
            .map(entry => readPersistedRecordTask(entry.slice(0, -5)))
            .filter((task): task is BackgroundTask => Boolean(task));
    } catch {
        return [];
    }
}

function tryParseRecordUpdateResumePayload(payload: unknown): RecordUpdateResumePayload | null {
    const parsed = RecordUpdateResumePayloadSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
}

function tryParseRecordBatchResumePayload(payload: unknown): RecordBatchResumePayload | null {
    const parsed = RecordBatchResumePayloadSchema.safeParse(payload);
    if (parsed.success) {
        if (!("candidates" in parsed.data)) return parsed.data;
        return {
            ...parsed.data,
            candidates: parsed.data.candidates.map(candidate => normalizeFrozenBatchCandidate(
                candidate,
                parsed.data.dataChain as ResolvedConversationChain,
                parsed.data.workspaceHash,
            )),
        };
    }
    const legacy = LegacyRecordBatchReadyResumePayloadSchema.safeParse(payload);
    if (legacy.success) {
        const workspaceHash = legacy.data.workspaceHash || resolveWorkspaceHashForRecord(legacy.data.candidates[0]?.workspace);
        return {
            ...legacy.data,
            workspaceHash,
            phase: "ready",
            candidates: legacy.data.candidates.map(candidate => normalizeFrozenBatchCandidate(
                candidate,
                legacy.data.dataChain as ResolvedConversationChain,
                workspaceHash,
            )),
        };
    }

    const legacyPreparing = LegacyRecordBatchPreparingResumePayloadSchema.safeParse(payload);
    if (!legacyPreparing.success) return null;
    return {
        ...legacyPreparing.data,
        workspaceHash: legacyPreparing.data.workspaceHash || resolveWorkspaceHashForRecord(legacyPreparing.data.request.workspace),
        request: normalizeLegacyRecordBatchRequest(legacyPreparing.data.request),
    };
}

function parseRecordUpdateResumePayload(payload: unknown): RecordUpdateResumePayload {
    return RecordUpdateResumePayloadSchema.parse(payload);
}

function parseRecordBatchResumePayload(payload: unknown): RecordBatchResumePayload {
    const parsed = tryParseRecordBatchResumePayload(payload);
    if (!parsed) throw new Error("无效的 Record batch resumePayload");
    return parsed;
}

function makeRecordBatchResumeKey(): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function createEmptyRecordBatchLedger(payload: RecordBatchReadyResumePayload): RecordBatchResumeLedger {
    return {
        version: RECORD_BATCH_LEDGER_VERSION,
        resumeKey: payload.resumeKey,
        updatedAt: new Date().toISOString(),
        candidates: payload.candidates.map(candidate => ({ ...candidate })),
        completed: [],
        skipped: [],
        failed: [],
        inFlight: [],
    };
}

function isFullySettledRecordBatchLedger(ledger: RecordBatchResumeLedger): boolean {
    if (ledger.inFlight.length > 0) return false;
    const candidateIds = ledger.candidates.map(candidate => candidate.id);
    const settledIds = [...ledger.completed, ...ledger.skipped, ...ledger.failed].map(item => item.id);
    if (new Set(candidateIds).size !== candidateIds.length || new Set(settledIds).size !== settledIds.length) return false;
    if (candidateIds.length !== settledIds.length) return false;
    const settled = new Set(settledIds);
    return candidateIds.every(candidateId => settled.has(candidateId));
}

function matchesLegacyBatchCandidateSnapshot(
    legacyCandidates: unknown[],
    candidates: FrozenBatchConversationCandidate[],
): boolean {
    return legacyCandidates.length === candidates.length && legacyCandidates.every((candidate, index) => {
        if (!candidate || typeof candidate !== "object") return false;
        const legacy = candidate as { id?: unknown; workspace?: unknown; selectionKind?: unknown; refreshExisting?: unknown };
        return legacy.selectionKind === undefined
            && legacy.refreshExisting === undefined
            && legacy.id === candidates[index].id
            && legacy.workspace === candidates[index].workspace;
    });
}

function normalizeRecordBatchLedgerCandidates(
    ledger: RecordBatchResumeLedger,
    fallbackChain: ResolvedConversationChain,
): boolean {
    const normalized = ledger.candidates.map(candidate => normalizeFrozenBatchCandidate(
        candidate,
        fallbackChain,
        resolveWorkspaceHashForRecord(candidate.workspace),
    ));
    if (JSON.stringify(normalized) === JSON.stringify(ledger.candidates)) return false;
    ledger.candidates = normalized;
    return true;
}

function normalizeRecordBatchLedger(raw: unknown, resumeKey: string): RecordBatchResumeLedger | null {
    if (!raw || typeof raw !== "object") return null;
    const parsed = raw as Partial<RecordBatchResumeLedger> & { version?: unknown };
    if ((parsed.version !== 1 && parsed.version !== RECORD_BATCH_LEDGER_VERSION) || parsed.resumeKey !== resumeKey) return null;
    if (!Array.isArray(parsed.candidates) || !Array.isArray(parsed.completed) || !Array.isArray(parsed.skipped) || !Array.isArray(parsed.failed)) return null;
    return {
        version: RECORD_BATCH_LEDGER_VERSION,
        resumeKey,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
        candidates: parsed.candidates,
        completed: parsed.completed,
        skipped: parsed.skipped,
        failed: parsed.failed,
        inFlight: Array.isArray(parsed.inFlight) ? parsed.inFlight : [],
    };
}

function readRecordBatchLedger(resumeKey: string): RecordBatchResumeLedger | null {
    const ledgerPath = recordBatchLedgerPath(resumeKey);
    try {
        const raw = fs.readFileSync(ledgerPath, "utf-8");
        const normalized = normalizeRecordBatchLedger(JSON.parse(raw), resumeKey);
        if (!normalized) throw new RecordBatchLedgerRepairRequiredError(resumeKey, "内容为 null、版本不受支持或结构无效");
        return normalized;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (error instanceof RecordBatchLedgerRepairRequiredError) throw error;
        throw new RecordBatchLedgerRepairRequiredError(resumeKey, error instanceof Error ? error.message : String(error));
    }
}

function writeRecordBatchLedger(ledger: RecordBatchResumeLedger): RecordBatchResumeLedger {
    ensureRecordRecoveryDir();
    ledger.version = RECORD_BATCH_LEDGER_VERSION;
    ledger.updatedAt = new Date().toISOString();
    writeJsonAtomic(recordBatchLedgerPath(ledger.resumeKey), ledger);
    return ledger;
}

function ensureRecordBatchLedger(payload: RecordBatchReadyResumePayload): RecordBatchResumeLedger {
    const normalizedPayload = normalizeRecordBatchReadyPayload(payload);
    const existing = readRecordBatchLedger(normalizedPayload.resumeKey);
    if (!existing) return writeRecordBatchLedger(createEmptyRecordBatchLedger(normalizedPayload));
    normalizeRecordBatchLedgerCandidates(existing, normalizedPayload.dataChain as ResolvedConversationChain);
    const expected = JSON.stringify(normalizedPayload.candidates);
    const actual = JSON.stringify(existing.candidates);
    if (actual !== expected) {
        if (matchesLegacyBatchCandidateSnapshot(existing.candidates, normalizedPayload.candidates)) {
            existing.candidates = normalizedPayload.candidates.map(candidate => ({ ...candidate }));
            return writeRecordBatchLedger(existing);
        }
        throw new RecordBatchLedgerRepairRequiredError(payload.resumeKey, "候选快照与 resumePayload 不匹配");
    }
    return existing;
}

async function ensureRecordRecoveryDirAsync(): Promise<void> {
    await fs.promises.mkdir(RECORD_RECOVERY_DIR, { recursive: true });
}

async function readRecordBatchLedgerAsync(resumeKey: string): Promise<RecordBatchResumeLedger | null> {
    const ledgerPath = recordBatchLedgerPath(resumeKey);
    try {
        const raw = await fs.promises.readFile(ledgerPath, "utf-8");
        const normalized = normalizeRecordBatchLedger(JSON.parse(raw), resumeKey);
        if (!normalized) throw new RecordBatchLedgerRepairRequiredError(resumeKey, "内容为 null、版本不受支持或结构无效");
        return normalized;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (error instanceof RecordBatchLedgerRepairRequiredError) throw error;
        throw new RecordBatchLedgerRepairRequiredError(resumeKey, error instanceof Error ? error.message : String(error));
    }
}

async function writeRecordBatchLedgerAsync(ledger: RecordBatchResumeLedger): Promise<RecordBatchResumeLedger> {
    await ensureRecordRecoveryDirAsync();
    ledger.version = RECORD_BATCH_LEDGER_VERSION;
    ledger.updatedAt = new Date().toISOString();
    await writeJsonAtomicAsync(recordBatchLedgerPath(ledger.resumeKey), ledger);
    return ledger;
}

async function validateLegacyRecordBatchLedgerForScheduler(payload: RecordBatchReadyResumePayload): Promise<void> {
    const resumeKey = payload.resumeKey;
    const ledgerPath = recordBatchLedgerPath(resumeKey);
    let raw: string;
    try {
        raw = await fs.promises.readFile(ledgerPath, "utf-8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new RecordBatchLedgerRepairRequiredError(resumeKey, error instanceof Error ? error.message : String(error));
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new RecordBatchLedgerRepairRequiredError(resumeKey, error instanceof Error ? error.message : String(error));
    }
    const normalized = normalizeRecordBatchLedger(parsed, resumeKey);
    if (!normalized) {
        throw new RecordBatchLedgerRepairRequiredError(resumeKey, "内容为 null、版本不受支持、身份漂移或结构无效");
    }
    const version = (parsed as { version?: unknown }).version;
    const expectedCandidates = payload.candidates.map(candidate => ({ ...candidate }));
    if (version === 1) {
        const exactMatch = JSON.stringify(normalized.candidates) === JSON.stringify(expectedCandidates);
        if (!exactMatch && !matchesLegacyBatchCandidateSnapshot(normalized.candidates, expectedCandidates)) {
            throw new RecordBatchLedgerRepairRequiredError(resumeKey, "v1 候选身份与 scheduler 冻结快照漂移");
        }
        normalized.candidates = expectedCandidates;
        await writeRecordBatchLedgerAsync(normalized);
        return;
    }
    const currentCandidates = z.array(BatchConversationCandidateSchema).safeParse(normalized.candidates);
    if (!currentCandidates.success) {
        throw new RecordBatchLedgerRepairRequiredError(resumeKey, "v2 候选身份与 scheduler 冻结快照漂移");
    }
    if (JSON.stringify(currentCandidates.data) === JSON.stringify(expectedCandidates)) return;
    if (isFullySettledRecordBatchLedger(normalized)) {
        await writeRecordBatchLedgerAsync(createEmptyRecordBatchLedger(payload));
        return;
    }
    throw new RecordBatchLedgerRepairRequiredError(resumeKey, "v2 候选身份与 scheduler 冻结快照漂移");
}

async function ensureRecordBatchLedgerUnlocked(payload: RecordBatchReadyResumePayload): Promise<RecordBatchResumeLedger> {
    const normalizedPayload = normalizeRecordBatchReadyPayload(payload);
    const existing = await readRecordBatchLedgerAsync(normalizedPayload.resumeKey);
    if (!existing) return writeRecordBatchLedgerAsync(createEmptyRecordBatchLedger(normalizedPayload));
    normalizeRecordBatchLedgerCandidates(existing, normalizedPayload.dataChain as ResolvedConversationChain);
    const expected = JSON.stringify(normalizedPayload.candidates);
    const actual = JSON.stringify(existing.candidates);
    if (actual !== expected) {
        if (matchesLegacyBatchCandidateSnapshot(existing.candidates, normalizedPayload.candidates)) {
            existing.candidates = normalizedPayload.candidates.map(candidate => ({ ...candidate }));
            return writeRecordBatchLedgerAsync(existing);
        }
        throw new RecordBatchLedgerRepairRequiredError(payload.resumeKey, "候选快照与 resumePayload 不匹配");
    }
    return existing;
}

async function withRecordBatchLedger<T>(
    payload: RecordBatchReadyResumePayload,
    operation: (ledger: RecordBatchResumeLedger) => Promise<T>,
): Promise<T> {
    return withIndexLock(`record_batch_ledger_${payload.resumeKey}`, async () => {
        const ledger = await ensureRecordBatchLedgerUnlocked(payload);
        return operation(ledger);
    });
}

async function ensureRecordBatchLedgerAsync(payload: RecordBatchReadyResumePayload): Promise<RecordBatchResumeLedger> {
    return withRecordBatchLedger(payload, async ledger => ledger);
}

function recordContentHash(content: string): string {
    return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function normalizeRecordBatchLedgerEntries(entries: RecordBatchLedgerEntry[], entry: RecordBatchLedgerEntry): RecordBatchLedgerEntry[] {
    const next = entries.filter(item => item.id !== entry.id);
    next.push(entry);
    next.sort((a, b) => a.id.localeCompare(b.id, "en"));
    return next;
}

function recordBatchLedgerEntry(
    candidate: Pick<FrozenBatchConversationCandidate, "id" | "workspace">,
    reason?: string,
    isNew?: boolean,
): RecordBatchLedgerEntry {
    return {
        id: candidate.id,
        workspace: candidate.workspace,
        recordedAt: new Date().toISOString(),
        ...(reason ? { reason } : {}),
        ...(isNew !== undefined ? { isNew } : {}),
    };
}

async function updateRecordBatchLedger(
    payload: RecordBatchReadyResumePayload,
    kind: "completed" | "skipped" | "failed",
    candidate: Pick<FrozenBatchConversationCandidate, "id" | "workspace">,
    reason?: string,
    isNew?: boolean,
): Promise<RecordBatchResumeLedger> {
    return withRecordBatchLedger(payload, async ledger => {
        const entry = recordBatchLedgerEntry(candidate, reason, isNew);
        ledger.completed = ledger.completed.filter(item => item.id !== candidate.id);
        ledger.skipped = ledger.skipped.filter(item => item.id !== candidate.id);
        ledger.failed = ledger.failed.filter(item => item.id !== candidate.id);
        ledger.inFlight = ledger.inFlight.filter(item => item.id !== candidate.id);
        ledger[kind] = normalizeRecordBatchLedgerEntries(ledger[kind], entry);
        return writeRecordBatchLedgerAsync(ledger);
    });
}

async function markRecordBatchCandidateInFlight(
    payload: RecordBatchReadyResumePayload,
    candidate: Pick<FrozenBatchConversationCandidate, "id" | "workspace">,
    content: string,
    metadata?: RecordBatchIndexMetadata,
    isNew?: boolean,
): Promise<RecordBatchResumeLedger> {
    return withRecordBatchLedger(payload, async ledger => {
        const entry: RecordBatchInFlightEntry = {
            ...recordBatchLedgerEntry(candidate, undefined, isNew),
            contentHash: recordContentHash(content),
            ...(metadata ? { metadata } : {}),
        };
        ledger.completed = ledger.completed.filter(item => item.id !== candidate.id);
        ledger.skipped = ledger.skipped.filter(item => item.id !== candidate.id);
        ledger.failed = ledger.failed.filter(item => item.id !== candidate.id);
        ledger.inFlight = ledger.inFlight.filter(item => item.id !== candidate.id);
        ledger.inFlight.push(entry);
        ledger.inFlight.sort((a, b) => a.id.localeCompare(b.id, "en"));
        return writeRecordBatchLedgerAsync(ledger);
    });
}

async function clearRecordBatchCandidateInFlight(
    payload: RecordBatchReadyResumePayload,
    candidate: Pick<FrozenBatchConversationCandidate, "id" | "workspace">,
): Promise<RecordBatchResumeLedger> {
    return withRecordBatchLedger(payload, async ledger => {
        ledger.inFlight = ledger.inFlight.filter(item => item.id !== candidate.id);
        return writeRecordBatchLedgerAsync(ledger);
    });
}

async function reconcileRecordBatchInFlight(
    payload: RecordBatchReadyResumePayload,
    ledger: RecordBatchResumeLedger,
    options: Pick<RecordGateAcquireOptions, "isCancelled" | "isSettled" | "onProgress">,
): Promise<RecordBatchResumeLedger> {
    if (ledger.inFlight.length === 0) return ledger;
    for (const entry of [...ledger.inFlight]) {
        const candidate = payload.candidates.find(item => item.id === entry.id && item.workspace === entry.workspace);
        if (!candidate) {
            await withRecordBatchLedger(payload, async current => {
                current.inFlight = current.inFlight.filter(item => item.id !== entry.id);
                return writeRecordBatchLedgerAsync(current);
            });
            continue;
        }
        const hash = resolveWorkspaceHashForRecord(candidate.workspace);
        const singleFlightPermit = await acquireRecordSingleFlightPermit(candidate.id, options);
        try {
            const existing = await readRecordAsync(hash, candidate.id);
            if (existing && recordContentHash(existing) === entry.contentHash) {
                const indexed = (await readRecordsIndexAsync(hash)).records[candidate.id];
                if (entry.metadata) {
                    await upsertRecordIndex(hash, candidate.id, existing, entry.metadata);
                } else if (!indexed) {
                    await clearRecordBatchCandidateInFlight(payload, candidate);
                    continue;
                }

                const readerIndex = await withRecordUpdateSharedPermit({
                    ...options,
                    waitingStage: "等待 Record 写入许可",
                    acquiredStage: "batch_reconcile",
                    waitingDetail: "等待 batch recovery 的 Reader Index 写入许可",
                    acquiredDetail: "已获取 batch recovery 的 Reader Index 写入许可",
                }, async () => buildAndPersistRecordReaderIndex(hash, candidate.id, existing));
                if (readerIndex.value.error) {
                    throw readerIndex.value.error;
                }
                await updateRecordBatchLedger(payload, "completed", candidate, "reconciled after record write", entry.isNew);
                continue;
            }
            await clearRecordBatchCandidateInFlight(payload, candidate);
        } finally {
            singleFlightPermit.release();
        }
    }
    return ensureRecordBatchLedgerAsync(payload);
}

function settledRecordBatchCandidateIds(ledger: RecordBatchResumeLedger): Set<string> {
    return new Set([
        ...ledger.completed.map(item => item.id),
        ...ledger.skipped.map(item => item.id),
        ...ledger.failed.map(item => item.id),
        ...ledger.inFlight.map(item => item.id),
    ]);
}

function pendingRecordBatchCandidates(payload: RecordBatchReadyResumePayload, ledger: RecordBatchResumeLedger): FrozenBatchConversationCandidate[] {
    const settledIds = settledRecordBatchCandidateIds(ledger);
    return payload.candidates.filter(candidate => !settledIds.has(candidate.id));
}

function schedulerBatchCandidates(
    payload: RecordBatchReadyResumePayload,
    frozenSources: FrozenRuntimeSourceSet,
): FrozenBatchConversationCandidate[] {
    if (frozenSources.phase !== "sealed") {
        throw new RecordSchedulerRepairRequiredError("scheduler-managed batch 只能使用 sealed frozen sources");
    }
    return frozenSources.sources.map(source => {
        const candidate = payload.candidates.find(item => (
            item.id === source.snapshot.conversationId
            && item.chain === source.snapshot.chain
            && item.workspaceHash === source.snapshot.workspaceHash
        ));
        if (!candidate) {
            throw new RecordSchedulerRepairRequiredError(
                `scheduler-managed batch 的 frozen source ${frozenRuntimeSourceKey(source.snapshot)} 未匹配 admission 冻结候选`,
            );
        }
        return candidate;
    });
}

function projectRecordBatchOutcomeInMemory(
    ledger: RecordBatchResumeLedger,
    kind: "completed" | "skipped" | "failed",
    candidate: Pick<FrozenBatchConversationCandidate, "id" | "workspace">,
    reason?: string,
    isNew?: boolean,
): RecordBatchResumeLedger {
    const entry = recordBatchLedgerEntry(candidate, reason, isNew);
    const next = {
        ...ledger,
        completed: ledger.completed.filter(item => item.id !== candidate.id),
        skipped: ledger.skipped.filter(item => item.id !== candidate.id),
        failed: ledger.failed.filter(item => item.id !== candidate.id),
        inFlight: ledger.inFlight.filter(item => item.id !== candidate.id),
    };
    next[kind] = normalizeRecordBatchLedgerEntries(next[kind], entry);
    return next;
}

function isRecoverableRecordTask(task: BackgroundTask): boolean {
    if (task.status !== "running") return false;
    if (!RECORD_RECOVERABLE_TASK_KINDS.has(task.kind)) return false;
    if (task.resumeVersion !== BACKGROUND_TASK_RESUME_VERSION || typeof task.resumeHash !== "string") return false;
    if (!inspectBackgroundTaskRecovery(task).recoverable) return false;
    if (task.kind === "record-update") return tryParseRecordUpdateResumePayload(task.resumePayload) !== null;
    if (task.kind === "record-batch-update") return tryParseRecordBatchResumePayload(task.resumePayload) !== null;
    return false;
}

function isSchedulerBackedRecordTask(task: Pick<BackgroundTask, "kind" | "schedulerAdmission">): boolean {
    return RECORD_RECOVERABLE_TASK_KINDS.has(task.kind) && task.schedulerAdmission !== undefined;
}

function schedulerRecoveryRequired(task: Pick<BackgroundTask, "id" | "kind">): RecordSchedulerRepairRequiredError {
    return new RecordSchedulerRepairRequiredError(
        `Record scheduler ${task.kind} ${task.id} 的持久 admission envelope 仍存在，但权威 scheduler ledger 不可读取；拒绝回退旧执行路径（generic status/cancel/recovery）或重新枚举`,
    );
}

function listRecoverableRecordTasks(): BackgroundTask[] {
    return listPersistedRecordTasks()
        .filter(isRecoverableRecordTask)
        .sort((a, b) => Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""));
}

function formatRecoverableRecordTasks(tasks: BackgroundTask[]): string {
    if (tasks.length === 0) return "📦 当前没有可恢复的 Record 后台任务";
    const lines = [`♻️ 可恢复的 Record 后台任务 (${tasks.length} 个)`];
    for (const task of tasks) {
        const claimed = fs.existsSync(recordTaskClaimPath(task.id)) ? " | claim=held" : "";
        const progressBits: string[] = [];
        if (task.progress?.stage) progressBits.push(`stage=${task.progress.stage}`);
        if (task.progress?.current !== undefined && task.progress?.total !== undefined) {
            progressBits.push(`progress=${task.progress.current}/${task.progress.total}`);
        }
        lines.push(
            `- ${task.id} | ${task.kind} | updated=${task.updatedAt}${claimed}${progressBits.length ? ` | ${progressBits.join(" | ")}` : ""}`,
        );
    }
    lines.push("💡 调用 record_manage(action=\"recover\", taskId=\"...\") 可尝试恢复指定任务");
    return lines.join("\n");
}

type VerifiedRecordSchedulerAdmissionCapsule = Extract<
    Awaited<ReturnType<typeof verifyOrRecoverTaskAdmission>>,
    { kind: "verified" }
>["capsule"];

interface SchedulerRecoveryPayload {
    readonly capsule: VerifiedRecordSchedulerAdmissionCapsule;
    readonly payload: RecordUpdateResumePayload | RecordBatchPreparingResumePayload;
}

async function schedulerRecoveryPayload(task: BackgroundTask): Promise<SchedulerRecoveryPayload> {
    const verified = await verifyOrRecoverTaskAdmission(task.id);
    if (verified.kind !== "verified") {
        throw new RecordSchedulerRepairRequiredError(
            `Record scheduler ${task.kind} ${task.id} 的 admission capsule 无法验证：${verified.reason}`,
        );
    }
    if (verified.capsule.taskKind !== task.kind) {
        throw new RecordSchedulerRepairRequiredError(`Record scheduler ${task.id} 的 capsule taskKind 与 projection 不一致`);
    }
    const persistedPayload = verified.capsule.backgroundProjection.resumePayload;
    if (task.kind === "record-update") {
        const payload = tryParseRecordUpdateResumePayload(persistedPayload);
        if (!payload) {
            throw new RecordSchedulerRepairRequiredError(`Record scheduler update ${task.id} 缺少新版本 workspaceHash resumePayload`);
        }
        return { capsule: verified.capsule, payload };
    }
    const payload = tryParseRecordBatchResumePayload(persistedPayload);
    if (!payload || !("request" in payload)) {
        throw new RecordSchedulerRepairRequiredError(`Record scheduler batch ${task.id} 缺少新版本 workspaceHash/preparing resumePayload`);
    }
    return { capsule: verified.capsule, payload };
}

function schedulerRecoveryDescriptor(
    task: BackgroundTask,
    recovery: SchedulerRecoveryPayload,
): RecordSchedulerRuntimeRecoveryDescriptor {
    const { capsule, payload } = recovery;
    if (payload.kind === "record-update") {
        return {
            kind: "record-update",
            requestKey: capsule.admissionIdentity.requestKey,
            requestSummary: capsule.requestSummary,
            resumePayload: capsule.backgroundProjection.resumePayload,
            requestMode: payload.force ? "force" : "normal",
            ...(capsule.backgroundProjection.projection === undefined ? {} : {
                backgroundProjection: capsule.backgroundProjection.projection as Record<string, unknown>,
            }),
            discovery: buildRecordSchedulerDiscoveryRequest({
                kind: "record-update",
                selector: payload.force ? "force" : "normal",
                hash: payload.workspaceHash,
                workspace: payload.workspace,
                dataChain: payload.dataChain,
                limit: 1,
                targetConversationId: payload.conversationId,
            }),
        };
    }
    const selector = payload.stale_only ? "stale_only" : payload.force ? "force" : "normal";
    return {
        kind: "record-batch-update",
        requestKey: capsule.admissionIdentity.requestKey,
        requestSummary: capsule.requestSummary,
        resumePayload: capsule.backgroundProjection.resumePayload,
        requestMode: selector,
        ...(capsule.backgroundProjection.projection === undefined ? {} : {
            backgroundProjection: capsule.backgroundProjection.projection as Record<string, unknown>,
        }),
        discovery: buildRecordSchedulerDiscoveryRequest({
            kind: "record-batch-update",
            selector,
            hash: payload.workspaceHash,
            workspace: payload.request.workspace,
            dataChain: payload.dataChain,
            limit: recordBatchDiscoveryScanLimit(payload.force),
            selectionLimit: effectiveRecordBatchLimit(payload.request.limit, payload.force),
            after: payload.request.after,
            before: payload.request.before,
        }),
        validateLegacyState: schedulerLegacyBatchStateValidator(payload, selector),
    };
}

function formatSchedulerResumeResult(result: Awaited<ReturnType<RecordSchedulerRuntime["resumeExecution"]>>): string {
    if (!result) {
        throw new RecordSchedulerRepairRequiredError("Record scheduler resume 未找到权威 task 状态");
    }
    if (result.kind === "blocked") {
        throw new Error(`Record scheduler owner blocked：${result.reason || "owner lease 仍由其他进程持有"}`);
    }
    if (result.kind === "repair_required" || result.kind === "missing") {
        throw new RecordSchedulerRepairRequiredError(
            `Record scheduler resume ${result.kind}：${result.reason || result.result || "权威 ledger 无法安全继续"}`,
        );
    }
    if (result.status.repairState === "Blocked") {
        throw new Error(`Record scheduler owner fenced/blocked：${result.status.repairState}`);
    }
    if (result.kind === "terminal") return formatRecordSchedulerTaskStatus(result.status);
    if (result.kind === "cancelled") return formatRecordSchedulerCancel(result.cancellation);
    if (result.kind === "resumed" || result.kind === "settled") return result.result;
    throw new RecordSchedulerRepairRequiredError("Record scheduler resume 返回了不可结算状态");
}

function ensureRecordRecoveryHandlersRegistered(): void {
    if (!getBackgroundTaskRecoveryHandler("record-update")) {
        registerBackgroundTaskRecoveryHandler("record-update", async task => ({
            mode: "resume",
            maxRunMs: task.maxRunMs,
            run: async context => {
                const scheduler = getRecordSchedulerRuntime();
                let recoveryPayload: RecordUpdateResumePayload | RecordBatchPreparingResumePayload | null = null;
                const resumed = await scheduler.resumeExecution(task.id, context, async (executionContext, _discovery, frozenSources) => {
                    const payload = recoveryPayload;
                    if (!payload || payload.kind !== "record-update") {
                        throw new RecordSchedulerRepairRequiredError(`Record scheduler ${task.id} 的 update recovery descriptor kind 不匹配`);
                    }
                    const frozenSource = frozenSources?.sources.find(source => (
                        source.snapshot.conversationId === payload.conversationId
                        && source.snapshot.chain === payload.dataChain
                        && source.snapshot.workspaceHash === payload.workspaceHash
                    ));
                    if (!frozenSource) {
                        throw new RecordSchedulerRepairRequiredError(`Record scheduler update ${task.id} 缺少匹配的 sealed frozen source`);
                    }
                    return responseText(await handleUpdate(
                        payload.workspaceHash,
                        payload.conversationId,
                        payload.workspace,
                        payload.dataChain,
                        payload.modelChain,
                        payload.parallelMode,
                        payload.force,
                        payload.logicalChain,
                        Date.now(),
                        {
                            background: true,
                            onProgress: executionContext.updateProgress,
                            isCancelled: executionContext.isCancelled,
                            isSettled: executionContext.isSettled,
                            frozenSource,
                            schedulerExecution: {
                                taskId: executionContext.taskId,
                                frozenSources: frozenSources!,
                                sourceSnapshotId: frozenSource.snapshot.sourceSnapshotId,
                                runtime: scheduler,
                            },
                        },
                    ));
                }, async () => {
                    const recovery = await schedulerRecoveryPayload(task);
                    recoveryPayload = recovery.payload;
                    return schedulerRecoveryDescriptor(task, recovery);
                });
                return formatSchedulerResumeResult(resumed);
            },
        }));
    }
    if (!getBackgroundTaskRecoveryHandler("record-batch-update")) {
        registerBackgroundTaskRecoveryHandler("record-batch-update", async task => ({
            mode: "resume",
            maxRunMs: task.maxRunMs,
            timeoutMessage: RECORD_BATCH_TIMEOUT_MESSAGE,
            run: async context => {
                const scheduler = getRecordSchedulerRuntime();
                let recoveryPayload: RecordUpdateResumePayload | RecordBatchPreparingResumePayload | null = null;
                const resumed = await scheduler.resumeExecution(task.id, context, async (executionContext, discovery, frozenSources) => {
                    const payload = recoveryPayload;
                    if (!payload || payload.kind !== "record-batch-update" || !("request" in payload)) {
                        throw new RecordSchedulerRepairRequiredError(`Record scheduler ${task.id} 的 batch recovery descriptor kind 不匹配`);
                    }
                    const requestMode = payload.stale_only ? "stale_only" : payload.force ? "force" : "normal";
                    if (!frozenSources || frozenSources.phase !== "sealed" || !discovery) {
                        throw new RecordSchedulerRepairRequiredError(`Record scheduler batch ${task.id} 缺少 sealed recovery evidence`);
                    }
                    const readyPayload = recordBatchReadyPayloadFromScheduler(
                        payload,
                        discovery,
                        scheduler.selectDiscoveryCandidates(discovery, requestMode),
                        frozenSources,
                    );
                    return runRecordBatchUpdateFromPayload(
                        readyPayload,
                        executionContext.updateProgress,
                        executionContext.isCancelled,
                        executionContext.isSettled,
                        frozenSources,
                        {
                            taskId: executionContext.taskId,
                            frozenSources,
                            runtime: scheduler,
                        },
                    );
                }, async () => {
                    const recovery = await schedulerRecoveryPayload(task);
                    recoveryPayload = recovery.payload;
                    return schedulerRecoveryDescriptor(task, recovery);
                });
                return formatSchedulerResumeResult(resumed);
            },
        }));
    }
}

interface OwnershipAuditItem {
    conversationId: string;
    title: string;
    currentHash: string;
    expectedHash?: string;
    expectedWorkspace?: string;
    sourceType: OwnershipSourceType;
    status: OwnershipStatus;
    reason: string;
    suggestedAction: "keep" | "move" | "archiveDuplicate" | "manualReview";
}

const RECORD_OWNERSHIP_SIDECAR = "ownership.json";

type RecordWorkspaceMeta = { originalPath?: string; canonicalPath?: string };

async function readRecordWorkspaceMetaAsync(hash: string): Promise<RecordWorkspaceMeta | null> {
    if (hash === "general") return null;
    try {
        return JSON.parse(await fs.promises.readFile(path.join(DATA_ROOT, "workspaces", hash, "_meta.json"), "utf-8")) as RecordWorkspaceMeta;
    } catch {
        return null;
    }
}

async function resolveWorkspaceHashForRecordAsync(workspace?: string): Promise<string> {
    if (!workspace) return "general";
    const requestedHash = workspaceHash(workspace);
    const hashes = await listWorkspaceHashesAsync();
    if (hashes.includes(requestedHash)) return requestedHash;
    for (const hash of hashes) {
        const meta = await readRecordWorkspaceMetaAsync(hash);
        if (!meta) continue;
        if ([meta.originalPath, meta.canonicalPath].some(candidate => candidate && workspaceHash(candidate) === requestedHash)) {
            return hash;
        }
    }
    return requestedHash;
}

function readOwnershipSidecar(hash: string, conversationId: string): { status?: string; supersededBy?: string } | null {
    return readRecordSidecar<{ status?: string; supersededBy?: string }>(hash, conversationId, RECORD_OWNERSHIP_SIDECAR);
}

function resolveSupersededTargetHash(hash: string, conversationId: string, visited = new Set<string>()): string | null {
    if (visited.has(hash)) return null;
    visited.add(hash);
    const sidecar = readOwnershipSidecar(hash, conversationId);
    if (sidecar?.status !== "superseded" || !sidecar.supersededBy) return null;
    const targetHash = sidecar.supersededBy;
    if (visited.has(targetHash) || !readRecord(targetHash, conversationId)) return null;
    const targetSidecar = readOwnershipSidecar(targetHash, conversationId);
    if (targetSidecar?.status === "superseded") {
        return resolveSupersededTargetHash(targetHash, conversationId, visited);
    }
    return targetHash;
}

function isSupersededRecord(hash: string, conversationId: string): boolean {
    return Boolean(resolveSupersededTargetHash(hash, conversationId));
}

async function readOwnershipSidecarAsync(hash: string, conversationId: string): Promise<{ status?: string; supersededBy?: string } | null> {
    return readRecordSidecarAsync<{ status?: string; supersededBy?: string }>(hash, conversationId, RECORD_OWNERSHIP_SIDECAR);
}

async function resolveSupersededTargetHashAsync(hash: string, conversationId: string, visited = new Set<string>()): Promise<string | null> {
    if (visited.has(hash)) return null;
    visited.add(hash);
    const sidecar = await readOwnershipSidecarAsync(hash, conversationId);
    if (sidecar?.status !== "superseded" || !sidecar.supersededBy) return null;
    const targetHash = sidecar.supersededBy;
    if (visited.has(targetHash) || !await readRecordAsync(targetHash, conversationId)) return null;
    const targetSidecar = await readOwnershipSidecarAsync(targetHash, conversationId);
    if (targetSidecar?.status === "superseded") {
        return resolveSupersededTargetHashAsync(targetHash, conversationId, visited);
    }
    return targetHash;
}

async function isSupersededRecordAsync(hash: string, conversationId: string): Promise<boolean> {
    return Boolean(await resolveSupersededTargetHashAsync(hash, conversationId));
}

/**
 * record_manage — 对话记录管理工具 v1.8
 */
export function registerRecord(server: McpServer): void {
    ensureRecordRecoveryHandlersRegistered();
    server.tool(
        "record_manage",
        `管理对话记录（Record）。Record 是对话的结构化过程日志，由 Flash 自动生成，抗 LS 过期。
action:
- update: 触发 Record 生成/更新（拉取对话内容 → Flash 生成）
- list: 列出工作区下所有 Record 概览
- read: 读取指定 Record（支持行范围）
- search: 在 Record 中搜索关键词
- guide: 为长 Record 生成带来源的 read/search 阅读建议，不生成事实摘要
- edit: 手动修改 Record（content 替换 / append 追加）
- delete: 删除指定 Record（不传 conversationId 则清空工作区全部 Record）
- audit_ownership: 审计 Record 归属，不按语义猜测，只看 workspaceUri/cwd/派生关系/重复副本
- repair_ownership: 归属修复，默认 dry-run，只输出迁移计划
- migrate_unknown_chain: 扫描 chain="unknown" 的历史索引，默认只读；仅四宿主权威证据唯一且完整时可显式 apply
- batch_update: 批量更新工作区内多个对话的 Record（按时间/源/工作区筛选候选，后台执行）
- bulk_update: batch_update 的安全别名，用于避开共享 broker 对 batch_update 名称的全局拦截
- recover: 列出或恢复可恢复的 Record 后台任务
- batch_delete: 删除工作区下所有 Record
- task_status: 查询后台任务状态（update/batch_update/bulk_update/guide 返回 taskId 后用此查询）
- cancel: 兼容入口，按 taskId 取消 Record 后台任务；其它后台任务优先使用 background_task_cancel
- stale_check: 检测范围内哪些 Record 已过期（对话有新内容但 Record 未跟进）；近期列表未找到的 Record 标为 unresolved，仅统计不改动`,
        {
            action: z.enum(["update", "list", "read", "search", "guide", "edit", "delete", "batch_update", "bulk_update", "recover", "batch_delete", "task_status", "cancel", "audit_ownership", "repair_ownership", "migrate_unknown_chain", "stale_check"])
                .describe("操作类型"),
            conversationId: z.string().optional()
                .describe("对话 ID（update 不传则自动获取当前对话）"),
            workspace: z.string().optional()
                .describe("工作区路径（不传则 general）"),
            scope: z.enum(["workspace", "global", "general"]).optional()
                .describe("[search/list/audit/migrate_unknown_chain/stale_check] 范围，默认 workspace；workspace 严格只读指定工作区"),
            includeGeneral: z.boolean().optional()
                .describe("[list/search/stale_check] 兼容开关：显式把 general 也并入 workspace 结果，默认 false"),
            query: z.string().optional()
                .describe("[search] 搜索关键词"),
            mode: z.enum(["auto", "exact", "fuzzy", "smart"]).optional()
                .describe("[search] 搜索模式：auto/exact/fuzzy/smart，默认 auto"),
            content: z.string().optional()
                .describe("[edit] 替换全文"),
            append: z.string().optional()
                .describe("[edit] 追加到末尾"),
            startLine: z.number().optional()
                .describe("[read] 起始行号"),
            endLine: z.number().optional()
                .describe("[read] 结束行号"),
            view: z.enum(["raw", "outline", "state", "outputs", "lessons", "risks", "verification", "phase", "custom"]).optional()
                .describe("[read] 结构化视图。未传则保持旧全文读取行为"),
            phaseIds: z.array(z.union([z.string(), z.number()])).optional()
                .describe("[read/search] 限定 Phase，例如 [1] 或 [\"phase-1\"]"),
            startBlockId: z.string().optional()
                .describe("[read] 从指定 reader block 继续读取，通常来自上次结构化读取的 nextReadHint.startBlockId"),
            sectionTypes: z.array(z.enum(RECORD_SECTION_TYPES)).optional()
                .describe("[read/search] 限定 Record 区块类型"),
            include: z.array(z.enum(RECORD_SECTION_TYPES)).optional()
                .describe("[read] 只包含指定区块类型"),
            exclude: z.array(z.enum(RECORD_SECTION_TYPES)).optional()
                .describe("[read] 排除指定区块类型"),
            maxChars: z.number().optional()
                .describe("[read/search/guide] 最大输出字符数，结构化读取会按 block 边界截断"),
            format: z.enum(["text", "json"]).optional()
                .describe("[read/search/guide] 返回格式，默认 text"),
            withCitations: z.boolean().optional()
                .describe("[read] 是否输出 block/行号来源，默认 true"),
            indexMode: z.enum(["auto", "reuse", "rebuild", "off"]).optional()
                .describe("[read/search/guide] reader index 策略，auto=复用新鲜索引或懒重建"),
            recordIds: z.array(z.string()).optional()
                .describe("[search/guide] 限定多个 Record ID"),
            searchScope: z.enum(["record", "phase", "section", "item"]).optional()
                .describe("[search] 结果粒度，不复用 scope，避免和 workspace/global/general 冲突"),
            goal: z.string().optional()
                .describe("[guide] 阅读目标，用于生成 read/search 建议"),
            maxRecommendations: z.number().optional()
                .describe("[guide] 最多返回建议数量，默认 5"),
            after: z.string().optional()
                .describe("[batch_update/bulk_update] 只处理此时间之后的对话(ISO/YYYY-MM-DD)"),
            before: z.string().optional()
                .describe("[batch_update/bulk_update] 只处理此时间之前的对话"),
            limit: z.number().int().min(1).max(200).optional()
                .describe("[list/search/batch_update/bulk_update/stale_check] 1..200 的正整数；批量更新有效上限为非 force 50、force 200，默认分别为 10、200"),
            force: z.boolean().optional()
                .describe("[update/batch_update/bulk_update] 强制更新已有Record；update 时绕过“已是最新”短路并重新生成"),
            stale_only: z.boolean().optional()
                .describe("[batch_update/bulk_update] 始终只选择已过期的 Record；优先级高于 force"),
            dryRun: z.boolean().optional()
                .describe("[repair_ownership] 默认 true，只报告计划不移动文件"),
            apply: z.boolean().optional()
                .describe("[migrate_unknown_chain] 默认 false，只读扫描四宿主权威 source evidence；true 时仅对唯一完整 Match 的 Patch 逐条执行 index revision/hash CAS，Conflict/Unresolved 永不写入"),
            backup: z.boolean().optional()
                .describe("[repair_ownership] 真正迁移前备份 Record 正文和索引，默认 true"),
            waitSeconds: z.number().optional()
                .describe("[task_status] 后台任务查询等待秒数(1-300)，任务完成时提前返回"),
            background: z.boolean().optional()
                .describe("[update/batch_update/bulk_update] 三态后台：true=接纳后立即返回 taskId / false=先完成 scheduler L2 接纳，再等待同一 ledger 终态 / 不传时保持自动后台"),
            parallelMode: z.enum(["off", "auto", "force"]).optional()
                .describe("[update] 实验性 Record 并行管线：off=关闭(默认)，auto=高密对话自动启用，force=能切出多批时强制启用"),
            logicalChain: z.enum(["off", "explain", "auto", "strict"]).optional()
                .describe("[update] Claude Code Record 更新：off=只用指定物理 ID；auto=强证据时合并逻辑续聊链，默认 claude-code 使用 auto"),
            taskId: z.string().optional()
                .describe("[task_status/cancel/recover] 后台任务 ID"),
            chain: z.enum(CHAIN_COMPAT_INPUT_VALUES).default(DEFAULT_CHAIN)
                .describe("兼容旧参数：dataChain/modelChain 未传时沿用；chain=\"windsurf\" 只作为 dataChain，chain=\"grok\"/\"agy\" 只作为 modelChain"),
            dataChain: dataChainInputSchema("dataChain", "对话数据链路：auto=当前宿主优先，支持 antigravity/codex/claude-code/windsurf；agy 与 Grok 只支持 modelChain"),
            modelChain: modelChainInputSchema("modelChain", "模型链路：auto=Grok→（MEMORY_STORE_AGY_AUTO_ENABLED=1 时）agy→Antigravity→Codex→可选 Claude Code CLI；agy=本地 CLI 的三模型内部 fallback，claude-code=显式 Claude Code CLI；Windsurf 只支持 dataChain"),
        },
        async (args) => {
            const startMs = Date.now();
            touchActivity({
                skipRecordAutoCheck: args.action === "update"
                    || isRecordBatchUpdateAction(args.action)
                    || args.action === "task_status"
                    || args.action === "cancel"
                    || args.action === "recover"
                    || args.action === "stale_check",
            });
            try {
                const hash = await resolveWorkspaceHashForRecordAsync(args.workspace);
                const chains = resolveChainSplit({ chain: args.chain, dataChain: args.dataChain, modelChain: args.modelChain });
                if (
                    args.action === "update"
                    || isRecordBatchUpdateAction(args.action)
                    || args.action === "edit"
                    || args.action === "delete"
                    || args.action === "batch_delete"
                    || (args.action === "repair_ownership" && args.dryRun === false)
                    || (args.action === "migrate_unknown_chain" && args.apply === true)
                ) {
                    await waitForRecordMutationReadiness();
                }
                switch (args.action) {
                    case "update": {
                        const decision = decideBackground(args.background, chains.modelChain, "always");
                        return await handleRecordSchedulerUpdate(
                            hash,
                            args.conversationId,
                            args.workspace,
                            chains.dataChain,
                            chains.modelChain,
                            args.parallelMode,
                            args.force,
                            args.logicalChain as ConversationLogicalChainMode | undefined,
                            startMs,
                            decision.useBackground,
                            decision.auto,
                        );
                    }
                    case "list":
                        return handleList(hash, args.scope, args.includeGeneral, args.after, args.before, args.limit, startMs);
                    case "read":
                        return await handleRead(hash, args.conversationId, args.startLine, args.endLine, startMs, {
                            view: args.view,
                            phaseIds: args.phaseIds,
                            startBlockId: args.startBlockId,
                            sectionTypes: args.sectionTypes,
                            include: args.include,
                            exclude: args.exclude,
                            maxChars: args.maxChars,
                            format: args.format,
                            withCitations: args.withCitations,
                            indexMode: args.indexMode,
                        });
                    case "search":
                        return handleSearch(hash, args.query, args.scope, args.includeGeneral, args.mode, chains.modelChain, startMs, {
                            conversationId: args.conversationId,
                            recordIds: args.recordIds,
                            phaseIds: args.phaseIds,
                            sectionTypes: args.sectionTypes,
                            searchScope: args.searchScope,
                            maxChars: args.maxChars,
                            format: args.format,
                            indexMode: args.indexMode,
                            limit: args.limit,
                        });
                    case "guide":
                        return await handleGuide(hash, args.conversationId, args.recordIds, args.scope, args.includeGeneral, args.goal || args.query, args.maxRecommendations, chains.modelChain, startMs, {
                            phaseIds: args.phaseIds,
                            sectionTypes: args.sectionTypes,
                            maxChars: args.maxChars,
                            format: args.format,
                            indexMode: args.indexMode,
                            background: args.background,
                        });
                    case "audit_ownership":
                        return await handleAuditOwnership(hash, args.scope, chains.dataChain, startMs);
                    case "repair_ownership":
                        return await handleRepairOwnership(hash, args.scope, chains.dataChain, args.dryRun ?? true, args.backup ?? true, startMs);
                    case "migrate_unknown_chain":
                        return await handleUnknownChainMigration(hash, args.scope, args.includeGeneral, args.apply, startMs);
                    case "edit":
                        return await handleEdit(hash, args.conversationId, args.content, args.append, startMs);
                    case "delete":
                        return await handleDelete(hash, args.conversationId, startMs);
                    case "batch_delete":
                        return await handleBatchDelete(hash, startMs);
                    case "batch_update":
                    case "bulk_update":
                        return await handleBatchUpdate(hash, args, startMs);
                    case "recover":
                        return await handleRecover(args.taskId, startMs);
                    case "task_status":
                        return await handleTaskStatus(args.taskId, args.waitSeconds, startMs);
                    case "cancel":
                        return await handleRecordCancel(args.taskId, startMs);
                    case "stale_check":
                        if (args.recordIds?.length) {
                            return r("❌ record_manage(stale_check) 不支持 recordIds；请使用 workspace/scope/includeGeneral/dataChain/limit 限定检查范围，避免误以为只检查了指定 Record。");
                        }
                        return await handleStaleCheck(hash, args.workspace, args.scope, args.includeGeneral, chains.dataChain, args.limit, startMs);
                    default:
                        return r(`❌ 未知 action: ${args.action}`);
                }
            } catch (err) {
                return rt(formatToolError(`record_manage(${args.action})`, err, {
                    action: args.action,
                    conversationId: args.conversationId,
                    workspace: args.workspace,
                    scope: args.scope,
                    mode: args.mode,
                    chain: args.chain,
                    dataChain: args.dataChain,
                    modelChain: args.modelChain,
                    background: args.background,
                }), startMs);
            }
        }
    );
}

/** 快捷构建返回值 */
function r(text: string) { return { content: [{ type: "text" as const, text }] }; }
/** 快捷构建返回值（含耗时） */
function rt(text: string, startMs: number) {
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    return r(`${text}\n⏱ 耗时 ${elapsed}s`);
}

function buildRecordTaskAbortResponse(
    startMs: number,
    options: { isCancelled?: () => boolean; isSettled?: () => boolean } = {},
    stage = "停止后续 Record 处理",
) {
    const reason = getRecordTaskAbortReason(options);
    if (!reason) return null;
    const prefix = reason === "cancelled" ? "🛑 Record 更新已取消" : "⚠️ 后台任务已超时/结算";
    return rt(`${prefix}：${stage}，未继续模型调用或写回半成品`, startMs);
}

function responseText(response: ReturnType<typeof r>): string {
    return response.content.map(item => item.text).join("\n");
}

function statMtimeMs(filePath: string | undefined): number | undefined {
    if (!filePath) return undefined;
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return undefined;
    }
}

export function buildSourceChangedWarning(snapshot: RecordSourceSnapshot, latestMtimeMs = statMtimeMs(snapshot.rolloutPath)): string | null {
    if (snapshot.chain !== "codex" || !snapshot.rolloutPath || snapshot.rolloutMtimeMs === undefined) return null;
    if (latestMtimeMs === undefined || latestMtimeMs <= snapshot.rolloutMtimeMs + 50) return null;
    return `目标 Codex 对话在 Record 生成期间继续追加；本次按启动快照覆盖 ${snapshot.rounds} 轮 / ${snapshot.totalSteps} 步。若要纳入新尾巴，请再执行一次 update。`;
}

async function statMtimeMsAsync(filePath: string | undefined): Promise<number | undefined> {
    if (!filePath) return undefined;
    try {
        return (await fs.promises.stat(filePath)).mtimeMs;
    } catch {
        return undefined;
    }
}

export const __recordConcurrencyTest = {
    loadFrozenSource(source: FrozenRuntimeSource): ConversationLoadResult {
        return conversationLoadFromFrozenSource(source);
    },
    stats(): ConcurrencyGateSnapshot {
        return __recordUpdateCoordinationTest.persistenceStats();
    },
    resetPeak(): void {
        __recordUpdateCoordinationTest.resetPersistencePeak();
    },
    async acquire(options: ConcurrencyGateAcquireOptions = {}): Promise<ConcurrencyGatePermit> {
        return __recordUpdateCoordinationTest.acquirePersistenceGate(options);
    },
    async runUpdate(
        args: {
            hash: string;
            conversationId?: string;
            workspace?: string;
            dataChain: DataChain;
            modelChain: Chain;
            parallelMode?: RecordParallelMode;
            force?: boolean;
            logicalChain?: ConversationLogicalChainMode;
            startMs?: number;
            options?: {
                background?: boolean;
                onProgress?: (progress: BackgroundTaskProgress) => void;
                isCancelled?: () => boolean;
                isSettled?: () => boolean;
            };
        },
    ) {
        return handleUpdate(
            args.hash,
            args.conversationId,
            args.workspace,
            args.dataChain,
            args.modelChain,
            args.parallelMode,
            args.force,
            args.logicalChain,
            args.startMs ?? Date.now(),
            args.options,
        );
    },
    async buildUpdateResumePayload(args: {
        workspaceHash: string;
        conversationId?: string;
        workspace?: string;
        dataChain: DataChain;
        modelChain: Chain;
        parallelMode?: RecordParallelMode;
        force?: boolean;
        logicalChain?: ConversationLogicalChainMode;
    }): Promise<RecordUpdateResumePayload | null> {
        return buildRecordUpdateResumePayload(
            args.workspaceHash,
            args.conversationId,
            args.workspace,
            args.dataChain,
            args.modelChain,
            args.parallelMode,
            args.force,
            args.logicalChain,
        );
    },
    async runBatchUpdate(
        payload: {
            kind: "record-batch-update";
            actionName: "batch_update" | "bulk_update";
            resumeKey: string;
            workspaceHash?: string;
            dataChain: DataChain;
            modelChain: Chain;
            force?: boolean;
            candidates: Array<{ id: string; workspace: string }>;
        },
        options: {
            updateProgress?: (progress: BackgroundTaskProgress) => void;
            isCancelled?: () => boolean;
            isSettled?: () => boolean;
        } = {},
    ): Promise<string> {
        const normalizedPayload = normalizeRecordBatchReadyPayload({
            ...payload,
            workspaceHash: payload.workspaceHash || resolveWorkspaceHashForRecord(payload.candidates[0]?.workspace),
        });
        return runRecordBatchUpdateFromPayload(
            normalizedPayload,
            options.updateProgress || (() => undefined),
            options.isCancelled || (() => false),
            options.isSettled || (() => false),
        );
    },
    setBatchCandidateCollector(collector: BatchCandidateCollector | null): void {
        batchCandidateCollectorOverride = collector;
    },
    parseBatchResumePayload(payload: unknown): RecordBatchResumePayload | null {
        return tryParseRecordBatchResumePayload(payload);
    },
    async prepareBatchPayload(payload: unknown): Promise<{ payload?: RecordBatchReadyResumePayload; result?: string }> {
        return prepareRecordBatchPayload(
            parseRecordBatchResumePayload(payload),
            () => undefined,
            () => false,
            () => false,
        );
    },
    async ensureBatchLedger(payload: unknown): Promise<RecordBatchResumeLedger> {
        const parsed = parseRecordBatchResumePayload(payload);
        if (!("candidates" in parsed)) throw new Error("Record batch ledger requires ready payload");
        return ensureRecordBatchLedgerAsync(parsed);
    },
    setPersistenceHook(hook: RecordPersistenceTestHook | null): void {
        recordPersistenceTestHook = hook;
    },
    setUnknownChainMigrationReaders(readers: UnknownChainMigrationReaders | null): void {
        unknownChainMigrationReadersOverride = readers;
    },
    setUnknownChainMigrationProductionSourceReader(reader: ProductionSourceReader | null): void {
        unknownChainMigrationSourceReaderOverride = reader;
    },
    async mutateBatchLedger(
        payload: {
            kind: "record-batch-update";
            actionName: "batch_update" | "bulk_update";
            resumeKey: string;
            workspaceHash?: string;
            dataChain: DataChain;
            modelChain: Chain;
            force?: boolean;
            candidates: Array<{ id: string; workspace: string }>;
        },
        mutation: "completed" | "skipped" | "failed" | "inFlight",
        candidate: { id: string; workspace: string },
        reason?: string,
        details?: { isNew?: boolean; metadata?: RecordBatchIndexMetadata },
    ): Promise<RecordBatchResumeLedger> {
        const readyPayload = normalizeRecordBatchReadyPayload({
            ...payload,
            workspaceHash: payload.workspaceHash || resolveWorkspaceHashForRecord(payload.candidates[0]?.workspace),
        });
        if (mutation === "inFlight") {
            return markRecordBatchCandidateInFlight(readyPayload, candidate, reason || candidate.id, details?.metadata, details?.isNew);
        }
        return updateRecordBatchLedger(readyPayload, mutation, candidate, reason, details?.isNew);
    },
    async readBatchLedger(
        payload: {
            kind: "record-batch-update";
            actionName: "batch_update" | "bulk_update";
            resumeKey: string;
            workspaceHash?: string;
            dataChain: DataChain;
            modelChain: Chain;
            force?: boolean;
            candidates: Array<{ id: string; workspace: string }>;
        },
    ): Promise<RecordBatchResumeLedger> {
        return ensureRecordBatchLedgerAsync(normalizeRecordBatchReadyPayload({
            ...payload,
            workspaceHash: payload.workspaceHash || resolveWorkspaceHashForRecord(payload.candidates[0]?.workspace),
        }));
    },
    formatBatchResult(
        ledger: RecordBatchResumeLedger,
        total = ledger.candidates.length,
        resumeSummary = { hadPriorState: false, initialSettledCount: 0 },
        grokSummary?: GrokBatchRuntimeSummary,
    ): string {
        return buildRecordBatchResultText(ledger, total, 0, resumeSummary, undefined, undefined, grokSummary);
    },
    dedupeCandidates(candidates: Array<{ id: string; workspace?: string }>): Array<{ id: string; workspace?: string }> {
        return dedupeBatchConversationCandidates(candidates);
    },
};

function recordCompletenessScore(hash: string, conversationId: string, content?: string) {
    const entry = readRecordsIndex(hash).records[conversationId];
    return {
        coveredRounds: entry?.lastUpdatedRound || entry?.totalRounds || 0,
        updatedAt: Date.parse(entry?.lastUpdatedAt || "") || 0,
        sizeBytes: entry?.sizeBytes || (content ? Buffer.byteLength(content, "utf-8") : 0),
        nonGeneral: hash === "general" ? 0 : 1,
    };
}

function compareRecordCandidate(
    a: { hash: string; conversationId: string; content?: string },
    b: { hash: string; conversationId: string; content?: string },
): number {
    const as = recordCompletenessScore(a.hash, a.conversationId, a.content);
    const bs = recordCompletenessScore(b.hash, b.conversationId, b.content);
    if (as.coveredRounds !== bs.coveredRounds) return as.coveredRounds - bs.coveredRounds;
    if (as.updatedAt !== bs.updatedAt) return as.updatedAt - bs.updatedAt;
    if (as.sizeBytes !== bs.sizeBytes) return as.sizeBytes - bs.sizeBytes;
    return as.nonGeneral - bs.nonGeneral;
}

async function compareRecordCandidateAsync(
    a: { hash: string; conversationId: string; content?: string },
    b: { hash: string; conversationId: string; content?: string },
): Promise<number> {
    const [aEntry, bEntry] = await Promise.all([
        readRecordsIndexAsync(a.hash).then(index => index.records[a.conversationId]),
        readRecordsIndexAsync(b.hash).then(index => index.records[b.conversationId]),
    ]);
    const as = {
        coveredRounds: aEntry?.lastUpdatedRound || aEntry?.totalRounds || 0,
        updatedAt: Date.parse(aEntry?.lastUpdatedAt || "") || 0,
        sizeBytes: aEntry?.sizeBytes || (a.content ? Buffer.byteLength(a.content, "utf-8") : 0),
        nonGeneral: a.hash === "general" ? 0 : 1,
    };
    const bs = {
        coveredRounds: bEntry?.lastUpdatedRound || bEntry?.totalRounds || 0,
        updatedAt: Date.parse(bEntry?.lastUpdatedAt || "") || 0,
        sizeBytes: bEntry?.sizeBytes || (b.content ? Buffer.byteLength(b.content, "utf-8") : 0),
        nonGeneral: b.hash === "general" ? 0 : 1,
    };
    if (as.coveredRounds !== bs.coveredRounds) return as.coveredRounds - bs.coveredRounds;
    if (as.updatedAt !== bs.updatedAt) return as.updatedAt - bs.updatedAt;
    if (as.sizeBytes !== bs.sizeBytes) return as.sizeBytes - bs.sizeBytes;
    return as.nonGeneral - bs.nonGeneral;
}

/** readRecord 兜底：收集 workspace/general/global 候选后按覆盖轮次、更新时间、大小选择最可信版本 */
function readRecordFallback(hash: string, convId: string): string | null {
    return resolveRecordLocation(hash, convId)?.content || null;
}

function resolveRecordLocation(hash: string, convId: string): { hash: string; conversationId: string; content: string } | null {
    const resolvedId = resolveRecordConversationId(convId, hash) || convId;
    const candidates: Array<{ hash: string; conversationId: string; content: string }> = [];
    const content = readRecord(hash, resolvedId);
    if (content && !isSupersededRecord(hash, resolvedId)) candidates.push({ hash, conversationId: resolvedId, content });
    if (hash !== "general") {
        const fromGeneral = readRecord("general", resolvedId);
        if (fromGeneral && !isSupersededRecord("general", resolvedId)) candidates.push({ hash: "general", conversationId: resolvedId, content: fromGeneral });
    }
    const foundHash = findRecordHash(resolvedId);
    if (foundHash && !candidates.some(candidate => candidate.hash === foundHash)) {
        const found = readRecord(foundHash, resolvedId);
        if (found) candidates.push({ hash: foundHash, conversationId: resolvedId, content: found });
    }
    return candidates.sort((a, b) => compareRecordCandidate(b, a))[0] || null;
}

async function resolveRecordConversationIdAsync(input: string, preferredHash?: string): Promise<string | null> {
    const query = input.trim();
    if (!query) return null;
    const queryLower = query.toLowerCase();
    const hashes = [
        ...(preferredHash ? [preferredHash] : []),
        "general",
        ...await listWorkspaceHashesAsync(),
    ].filter((recordHash, index, entries) => recordHash && entries.indexOf(recordHash) === index);
    const indexes = await Promise.all(hashes.map(async recordHash => readRecordsIndexAsync(recordHash)));
    const entries = indexes.flatMap(index => Object.values(index.records));
    const exact = entries.find(entry => entry.conversationId === query);
    if (exact) return exact.conversationId;
    const prefixMatches = entries.filter(entry => entry.conversationId.startsWith(query));
    if (prefixMatches.length === 1) return prefixMatches[0].conversationId;
    const titleMatches = entries.filter(entry => entry.title.toLowerCase() === queryLower);
    return titleMatches.length === 1 ? titleMatches[0].conversationId : null;
}

async function resolveRecordLocationAsync(hash: string, convId: string): Promise<{ hash: string; conversationId: string; content: string } | null> {
    const resolvedId = await resolveRecordConversationIdAsync(convId, hash) || convId;
    const candidateHashes = [
        hash,
        ...(hash !== "general" ? ["general"] : []),
        await findRecordHashAsync(resolvedId),
    ].filter((recordHash): recordHash is string => Boolean(recordHash))
        .filter((recordHash, index, entries) => entries.indexOf(recordHash) === index);
    const candidates = (await Promise.all(candidateHashes.map(async candidateHash => {
        const [content, superseded] = await Promise.all([
            readRecordAsync(candidateHash, resolvedId),
            isSupersededRecordAsync(candidateHash, resolvedId),
        ]);
        return content && !superseded ? { hash: candidateHash, conversationId: resolvedId, content } : null;
    }))).filter((candidate): candidate is { hash: string; conversationId: string; content: string } => Boolean(candidate));
    let best: { hash: string; conversationId: string; content: string } | null = null;
    for (const candidate of candidates) {
        if (!best || await compareRecordCandidateAsync(candidate, best) > 0) best = candidate;
    }
    return best;
}

async function readOrBuildReaderIndex(hash: string, conversationId: string, content: string, mode: RecordReaderIndexMode = "auto") {
    if (mode !== "rebuild" && mode !== "off") {
        const [cached, rebuildMarker] = await Promise.all([
            readRecordSidecarAsync<RecordReaderIndex>(hash, conversationId, "record_index.json"),
            readRecordSidecarAsync(hash, conversationId, "record_index.rebuild.json"),
        ]);
        if (!rebuildMarker && cached?.version === RECORD_READER_VERSION && isRecordReaderIndexFresh(cached, content)) {
            return { index: cached, indexStatus: "fresh" as const };
        }
        if (mode === "reuse" && cached) {
            return { index: buildRecordReaderIndex(conversationId, content), indexStatus: "rebuilt_in_memory_stale_cache" as const };
        }
    }
    if (mode === "off") {
        return { index: buildRecordReaderIndex(conversationId, content), indexStatus: "rebuilt_in_memory" as const };
    }
    await runRecordPersistenceTestHook("before_reader_index_single_flight", conversationId);
    const persisted = await withRecordManagementSingleFlight(conversationId, async () => {
        const currentContent = await readRecordAsync(hash, conversationId);
        if (currentContent !== content) {
            return {
                index: buildRecordReaderIndex(conversationId, content),
                error: null,
                indexStatus: currentContent ? "rebuilt_in_memory_stale_record" as const : "rebuilt_in_memory_missing_record" as const,
            };
        }
        const result = await withRecordPersistenceWrite(async () => buildAndPersistRecordReaderIndex(hash, conversationId, content, {
            beforeWrite: () => runRecordPersistenceTestHook("before_reader_index", conversationId),
        }));
        return {
            ...result,
            indexStatus: result.error ? "rebuilt_in_memory_pending" as const : "rebuilt" as const,
        };
    });
    if (!persisted.index) throw persisted.error || new Error("Reader Index 构建失败");
    return {
        index: persisted.index,
        indexStatus: persisted.indexStatus,
    };
}

function recordCoverageWarning(hash: string, conversationId: string, content: string): string | null {
    const entry = readRecordsIndex(hash).records[conversationId];
    const indexedRound = entry?.lastUpdatedRound || entry?.totalRounds || 0;
    if (!indexedRound) return null;
    const coveredRound = inferCoveredRoundFromRecord(content, indexedRound);
    if (coveredRound >= indexedRound) return null;
    return `⚠️ Record 正文疑似只覆盖 ${coveredRound}/${indexedRound} 轮；下次 update 会先修正索引并继续生成。`;
}

function normalizeSectionTypes(values?: RecordSectionType[]): RecordSectionType[] | undefined {
    if (!values || values.length === 0) return undefined;
    const allowed = new Set<RecordSectionType>(RECORD_SECTION_TYPES);
    return values.filter(value => allowed.has(value));
}

function dedupeRecordsByCompleteness(records: ReturnType<typeof listRecords>) {
    // 同 convId 保留覆盖轮次更完整、更新、体积更大的版本
    const map = new Map<string, typeof records[0]>();
    for (const rec of records) {
        const existing = map.get(rec.conversationId);
        if (
            !existing ||
            (rec.lastUpdatedRound || rec.totalRounds || 0) > (existing.lastUpdatedRound || existing.totalRounds || 0) ||
            ((rec.lastUpdatedRound || rec.totalRounds || 0) === (existing.lastUpdatedRound || existing.totalRounds || 0)
                && Date.parse(rec.lastUpdatedAt || "") > Date.parse(existing.lastUpdatedAt || "")) ||
            ((rec.lastUpdatedRound || rec.totalRounds || 0) === (existing.lastUpdatedRound || existing.totalRounds || 0)
                && Date.parse(rec.lastUpdatedAt || "") === Date.parse(existing.lastUpdatedAt || "")
                && (rec.sizeBytes || 0) > (existing.sizeBytes || 0))
        ) {
            map.set(rec.conversationId, rec);
        }
    }
    return Array.from(map.values());
}

export function recordHashesForScope(hash: string, scope: RecordManageScope | undefined, includeGeneral = false): string[] {
    if (scope === "global") {
        return ["general", ...listWorkspaceHashes()].filter((h, index, arr) => arr.indexOf(h) === index);
    }
    if (scope === "general" || hash === "general") return ["general"];
    const canonicalHash = canonicalHashForExistingRecordHash(hash) || hash;
    const workspaceHashes = [hash, ...listWorkspaceHashes().filter(h => h !== hash && canonicalHashForExistingRecordHash(h) === canonicalHash)]
        .filter((h, index, arr) => arr.indexOf(h) === index);
    return includeGeneral ? [...workspaceHashes, "general"] : workspaceHashes;
}

async function canonicalHashForExistingRecordHashAsync(hash: string): Promise<string | null> {
    if (hash === "general") return "general";
    const meta = await readRecordWorkspaceMetaAsync(hash);
    const workspace = meta?.canonicalPath || meta?.originalPath;
    return workspace ? workspaceHash(workspace) : null;
}

async function recordHashesForScopeAsync(hash: string, scope: RecordManageScope | undefined, includeGeneral = false): Promise<string[]> {
    const workspaceHashes = await listWorkspaceHashesAsync();
    if (scope === "global") {
        return ["general", ...workspaceHashes].filter((recordHash, index, entries) => entries.indexOf(recordHash) === index);
    }
    if (scope === "general" || hash === "general") return ["general"];
    const canonicalHash = await canonicalHashForExistingRecordHashAsync(hash) || hash;
    const canonicalHashes = await Promise.all(workspaceHashes.map(async recordHash => ({
        hash: recordHash,
        canonicalHash: await canonicalHashForExistingRecordHashAsync(recordHash),
    })));
    const matchingHashes = [hash, ...canonicalHashes
        .filter(item => item.hash !== hash && item.canonicalHash === canonicalHash)
        .map(item => item.hash)]
        .filter((recordHash, index, entries) => entries.indexOf(recordHash) === index);
    return includeGeneral ? [...matchingHashes, "general"] : matchingHashes;
}

export function listRecordsForScope(hash: string, scope: RecordManageScope | undefined, includeGeneral = false) {
    const records = recordHashesForScope(hash, scope, includeGeneral)
        .flatMap(h => listRecords(h).filter(rec => !isSupersededRecord(h, rec.conversationId)));
    return dedupeRecordsByCompleteness(records);
}

function recordDiscoveryHosts(dataChain: string | undefined): SourceEvidenceHost[] {
    return dataChain && dataChain !== "auto" && SOURCE_EVIDENCE_HOSTS.includes(dataChain as SourceEvidenceHost)
        ? [dataChain as SourceEvidenceHost]
        : [...SOURCE_EVIDENCE_HOSTS];
}

function buildRecordSchedulerDiscoveryRequest(input: {
    kind: "stale_check" | "record-update" | "record-batch-update";
    selector: "normal" | "stale_only" | "force";
    hash: string;
    workspace?: string;
    scope?: RecordManageScope;
    includeGeneral?: boolean;
    dataChain?: string;
    limit?: number;
    selectionLimit?: number;
    after?: string;
    before?: string;
    targetConversationId?: string;
}): RecordSchedulerRuntimeDiscoveryRequest {
    const records: RecordSchedulerRuntimeDiscoveryRecord[] = listRecordsForScope(
        input.hash,
        input.scope,
        input.includeGeneral === true,
    ).filter(record => !input.targetConversationId || record.conversationId === input.targetConversationId).map(record => {
        const identity = record.commitArtifact?.identity;
        const mainIndex = record.commitArtifact?.mainIndex;
        const coveredRevision = identity
            && mainIndex
            && identity.conversationId === record.conversationId
            && mainIndex.conversationId === record.conversationId
            && identity.commitId === mainIndex.commitId
            && identity.coveredRevision === mainIndex.coveredRevision
            && identity.recordId === mainIndex.recordId
            ? identity.coveredRevision
            : undefined;
        return {
            conversationId: record.conversationId,
            title: record.title,
            workspaceHash: input.hash,
            workspacePath: input.workspace || null,
            ...(record.chain && SOURCE_EVIDENCE_HOSTS.includes(record.chain as SourceEvidenceHost)
                ? { host: record.chain as SourceEvidenceHost }
                : {}),
            lastUpdatedAt: record.lastUpdatedAt,
            recordBodyHash: `sha256:${crypto.createHash("sha256").update(JSON.stringify(record), "utf8").digest("hex")}`,
            ...(coveredRevision ? { coveredRevision } : {}),
            ...(coveredRevision && Number.isSafeInteger(record.coveredRevisionSequence) && (record.coveredRevisionSequence ?? -1) >= 0
                ? { coveredRevisionSequence: record.coveredRevisionSequence }
                : {}),
        };
    });
    const hosts = recordDiscoveryHosts(input.dataChain);
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit || 50)));
    const selectionLimit = input.selectionLimit === undefined
        ? undefined
        : Math.max(1, Math.min(200, Math.floor(input.selectionLimit)));
    const filters = {
        scope: input.scope || "workspace",
        includeGeneral: input.includeGeneral === true,
        ...(input.after ? { after: input.after } : {}),
        ...(input.before ? { before: input.before } : {}),
        ...(selectionLimit !== undefined ? { selectionLimit } : {}),
    };
    const identity = {
        selector: input.selector,
        workspaceHash: input.hash,
        workspacePath: input.workspace || null,
        hosts,
        limit,
        ...(selectionLimit !== undefined ? { selectionLimit } : {}),
        filters,
        records: records.map(record => ({
            conversationId: record.conversationId,
            workspaceHash: record.workspaceHash,
            host: record.host || null,
            lastUpdatedAt: record.lastUpdatedAt,
            recordBodyHash: record.recordBodyHash,
            coveredRevision: record.coveredRevision || null,
            coveredRevisionSequence: record.coveredRevisionSequence ?? null,
        })),
    };
    return {
        kind: input.kind,
        selector: input.selector,
        requestKey: `record-discovery:${crypto.createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex")}`,
        workspaceHash: input.hash,
        workspacePath: input.workspace || null,
        hosts,
        limit,
        ...(selectionLimit !== undefined ? { selectionLimit } : {}),
        filters,
        records,
        ...(input.targetConversationId ? {
            targets: hosts.map(host => ({
                conversationId: input.targetConversationId!,
                host,
                workspaceHash: input.hash,
                workspacePath: input.workspace || null,
                title: records.find(record => record.conversationId === input.targetConversationId)?.title,
            })),
        } : {}),
    };
}

// ============= update =============

function frozenRuntimeSourceKey(source: Pick<FrozenRuntimeSource["snapshot"], "chain" | "workspaceHash" | "conversationId">): string {
    return `${source.chain}\u0000${source.workspaceHash}\u0000${source.conversationId}`;
}

interface RecordSchedulerExecutionContext {
    taskId: string;
    frozenSources: FrozenRuntimeSourceSet;
    sourceSnapshotId: string;
    runtime: RecordSchedulerRuntime;
}

interface RecordSchedulerBatchExecutionContext {
    taskId: string;
    frozenSources: FrozenRuntimeSourceSet;
    runtime: RecordSchedulerRuntime;
}

function stableFirstPublicationToken(source: Pick<FrozenRuntimeSource["snapshot"], "chain" | "workspaceHash" | "conversationId">): string {
    const canonicalIdentity = JSON.stringify({
        version: 1,
        chain: source.chain,
        workspaceHash: source.workspaceHash,
        conversationId: source.conversationId,
    });
    return `record-first-publication:v1:${crypto.createHash("sha256").update(canonicalIdentity, "utf8").digest("hex")}`;
}

function createSchedulerProductionSession(
    execution: RecordSchedulerExecutionContext,
    source: FrozenRuntimeSource,
): RecordSchedulerProductionSession {
    if (execution.frozenSources.phase !== "sealed") {
        throw new RecordSchedulerRepairRequiredError("Record scheduler execution 只能使用 sealed frozen source set");
    }
    if (execution.sourceSnapshotId !== source.snapshot.sourceSnapshotId
        || !execution.frozenSources.sources.some(item => item.snapshot.sourceSnapshotId === execution.sourceSnapshotId)) {
        throw new RecordSchedulerRepairRequiredError("Record scheduler execution sourceSnapshotId 与 sealed source set 不匹配");
    }
    return createRecordSchedulerProductionSession({
        taskId: execution.taskId,
        frozenSources: execution.frozenSources,
        sourceSnapshotId: execution.sourceSnapshotId,
        recordStoreHash: source.snapshot.workspaceHash,
        schedulerOwner: { ownerId: execution.runtime.ownerId },
        control: execution.runtime.control,
        spool: execution.runtime.control.spool,
        firstPublicationToken: stableFirstPublicationToken(source.snapshot),
    }, {
        coordinatorOwnerId: RECORD_SCHEDULER_COORDINATOR_OWNER_ID,
    });
}

async function finalizeSchedulerLocalRecord(
    session: RecordSchedulerProductionSession,
    input: Parameters<RecordSchedulerProductionSession["finalizeLocalRecord"]>[0],
): Promise<Awaited<ReturnType<RecordSchedulerProductionSession["finalizeLocalRecord"]>>> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
            return await session.finalizeLocalRecord(input);
        } catch (error) {
            const code = (error as { code?: unknown })?.code;
            if ((code !== "REVISION_CONFLICT" && code !== "SCHEDULER_LEDGER_CONFLICT") || attempt === 3) throw error;
            await new Promise(resolve => setTimeout(resolve, 10 * (attempt + 1)));
        }
    }
    throw new Error("local-finalize retry loop 未返回结果");
}

function completeRecordMetadata(input: {
    conversationId: string;
    content: string;
    rounds: number;
    totalSteps: number;
    coveredRounds: number;
    phases: number;
    title?: string;
    timeSpan?: string;
    tags?: string[];
    chain?: string;
    coveredRevisionSequence?: number;
}): RecordIndexEntry {
    return {
        conversationId: input.conversationId,
        title: input.title || extractTitle(input.content) || `对话 ${input.conversationId.slice(0, 8)}`,
        timeSpan: input.timeSpan || "",
        totalRounds: input.rounds,
        totalSteps: input.totalSteps,
        lastUpdatedRound: input.coveredRounds,
        lastUpdatedAt: new Date().toISOString(),
        phases: input.phases,
        sizeBytes: Buffer.byteLength(input.content, "utf8"),
        ...(input.tags ? { tags: input.tags } : {}),
        ...(input.chain ? { chain: input.chain } : {}),
        ...(Number.isSafeInteger(input.coveredRevisionSequence) && (input.coveredRevisionSequence ?? -1) >= 0
            ? { coveredRevisionSequence: input.coveredRevisionSequence }
            : {}),
    };
}

type FrozenConversationAttachment = NonNullable<ConversationRound["attachments"]>[number];

const FROZEN_CANONICAL_ATTACHMENT_SOURCES = new Set<FrozenConversationAttachment["source"]>([
    "claude-code-data-url",
    "claude-code-local-file",
    "codex-data-url",
    "codex-local-file",
    "files-mentioned",
    "windsurf-data-url",
    "windsurf-media-attachment",
    "antigravity-raw-attachment",
    "attachment-metadata-redacted",
]);

const FROZEN_CANONICAL_ATTACHMENT_WARNINGS = new Set([
    "attachment descriptor could not be parsed",
    "attachment descriptor could not be fully resolved",
    "attachment data URL could not be decoded",
    "attachment data URL is not a supported base64 descriptor",
    "attachment base64 descriptor is invalid",
    "attachment base64 exceeds safe decode limit",
    "attachment base64 decoded length verification failed",
    "attachment has no stable data URL or path reference",
    "attachment metadata warning redacted",
]);

function frozenCanonicalAttachmentName(value: unknown): string {
    const extension = typeof value === "string" ? /\.([a-z0-9]{1,16})$/iu.exec(value.trim())?.[1]?.toLowerCase() : undefined;
    return extension ? `attachment.${extension}` : "attachment";
}

function frozenCanonicalAttachmentMimeType(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const mimeType = value.trim().toLowerCase();
    return mimeType.length <= 128 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mimeType) ? mimeType : undefined;
}

function frozenCanonicalAttachmentHash(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const match = /^(?:sha256:)?([a-f0-9]{64})$/iu.exec(value.trim());
    return match ? `sha256:${match[1].toLowerCase()}` : undefined;
}

function frozenCanonicalAttachmentReference(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const reference = value.trim().toLowerCase();
    return /^(?:path-sha256|attachment-sha256):[a-f0-9]{64}$/u.test(reference)
        || /^attachment-policy:sha256:[a-f0-9]{64}$/u.test(reference)
        ? reference
        : undefined;
}

function frozenCanonicalAttachments(attachments: unknown, stepIndex: number): FrozenConversationAttachment[] {
    if (!Array.isArray(attachments)) return [];
    return attachments.flatMap(rawAttachment => {
        if (!rawAttachment || typeof rawAttachment !== "object" || Array.isArray(rawAttachment)) return [];
        const raw = rawAttachment as Record<string, unknown>;
        const source = typeof raw.source === "string" && FROZEN_CANONICAL_ATTACHMENT_SOURCES.has(raw.source as FrozenConversationAttachment["source"])
            ? raw.source as FrozenConversationAttachment["source"]
            : "attachment-metadata-redacted";
        const reference = frozenCanonicalAttachmentReference(raw.reference);
        const sha256 = frozenCanonicalAttachmentHash(raw.sha256);
        const mimeType = frozenCanonicalAttachmentMimeType(raw.mimeType);
        const sizeBytes = typeof raw.sizeBytes === "number" && Number.isSafeInteger(raw.sizeBytes) && raw.sizeBytes >= 0
            ? raw.sizeBytes
            : undefined;
        const exists = typeof raw.exists === "boolean" ? raw.exists : undefined;
        const warning = typeof raw.warning === "string"
            ? FROZEN_CANONICAL_ATTACHMENT_WARNINGS.has(raw.warning) ? raw.warning : "attachment metadata warning redacted"
            : undefined;
        const metadata = [
            `source=${source}`,
            ...(reference ? [`reference=${reference}`] : []),
            ...(sha256 ? [`sha256=${sha256}`] : []),
            ...(mimeType ? [`mime=${mimeType}`] : []),
            ...(sizeBytes !== undefined ? [`sizeBytes=${sizeBytes}`] : []),
            ...(exists !== undefined ? [`exists=${exists}`] : []),
        ];
        return [{
            kind: raw.kind === "image" ? "image" : "file",
            source,
            name: `${frozenCanonicalAttachmentName(raw.name)} [${metadata.join("; ")}]`,
            ...(mimeType ? { mimeType } : {}),
            ...(reference ? { reference } : {}),
            ...(sizeBytes !== undefined ? { sizeBytes } : {}),
            ...(sha256 ? { sha256 } : {}),
            ...(exists !== undefined ? { exists } : {}),
            ...(warning ? { warning } : {}),
            stepIndex,
        }];
    });
}

function assertFrozenCanonicalDocument(source: FrozenRuntimeSource): void {
    if (source.document.schemaVersion !== PRODUCTION_SOURCE_CONTENT_SCHEMA_VERSION) {
        throw new RecordSchedulerRepairRequiredError(
            `frozen source ${source.snapshot.sourceSnapshotId} 的 schemaVersion 不受支持: ${source.document.schemaVersion}`,
        );
    }
    if (!isSupportedProductionSourceFormatterVersion(source.document.formatterVersion)) {
        throw new RecordSchedulerRepairRequiredError(
            `frozen source ${source.snapshot.sourceSnapshotId} 的 formatterVersion 不受支持: ${source.document.formatterVersion}`,
        );
    }
    if (!Array.isArray(source.document.messages)
        || source.document.source.host !== source.snapshot.chain
        || source.document.source.conversationId !== source.snapshot.conversationId
        || !source.snapshot.contentHash
        || source.snapshot.contentHash !== source.snapshot.contentRef.hash
        || source.document.messages.some((message, index) => (
            message.order !== index + 1
            || (message.role !== "user" && message.role !== "assistant")
            || typeof message.content !== "string"
        ))) {
        throw new RecordSchedulerRepairRequiredError(
            `frozen source ${source.snapshot.sourceSnapshotId} 的 canonical document/version/content binding 无法验证`,
        );
    }
}

function conversationLoadFromFrozenSource(source: FrozenRuntimeSource): ConversationLoadResult {
    assertFrozenCanonicalDocument(source);
    const rounds: ConversationRound[] = [];
    let current: ConversationRound | null = null;
    const publishCurrent = () => {
        if (!current) return;
        current.roundIndex = rounds.length + 1;
        rounds.push(current);
        current = null;
    };
    for (const message of source.document.messages) {
        if (message.role === "user") {
            publishCurrent();
            current = {
                roundIndex: rounds.length + 1,
                startStep: message.order,
                endStep: message.order,
                userMessage: message.content,
                mediaAttachments: [],
                attachments: frozenCanonicalAttachments(message.attachments, message.order),
                aiResponses: [],
                toolCalls: [],
                taskBoundaries: [],
                codeActions: [],
                subagentSummaries: [],
            };
            continue;
        }
        current ||= {
            roundIndex: rounds.length + 1,
            startStep: message.order,
            endStep: message.order,
            userMessage: "",
            mediaAttachments: [],
            attachments: [],
            aiResponses: [],
            toolCalls: [],
            taskBoundaries: [],
            codeActions: [],
            subagentSummaries: [],
        };
        current.endStep = message.order;
        current.attachments!.push(...frozenCanonicalAttachments(message.attachments, message.order));
        current.aiResponses.push({
            stepIndex: message.order,
            response: message.content,
            thinking: "",
            toolCalls: [],
        });
    }
    publishCurrent();
    return {
        chainUsed: source.snapshot.chain,
        conversationId: source.snapshot.conversationId,
        rounds,
        totalSteps: source.document.messages.length,
    };
}

async function handleUpdate(
    hash: string, conversationId: string | undefined,
    workspace: string | undefined, dataChain: DataChain, modelChain: Chain, parallelMode: RecordParallelMode | undefined, force: boolean | undefined, logicalChain: ConversationLogicalChainMode | undefined, startMs: number,
    options: {
        background?: boolean;
        onProgress?: (progress: BackgroundTaskProgress) => void;
        isCancelled?: () => boolean;
        isSettled?: () => boolean;
        frozenSource?: FrozenRuntimeSource;
        schedulerExecution?: RecordSchedulerExecutionContext;
    } = {},
) {
    const preflightAbort = buildRecordTaskAbortResponse(startMs, options, "开始加载对话前检查到任务已终止");
    if (preflightAbort) return preflightAbort;
    const effectiveLogicalChain = logicalChain || (dataChain === "claude-code" ? "auto" : "off");
    let sharedPool: Pick<RecordUpdateSharedPermit, "queueWaitMs" | "snapshot"> | null = null;
    let loaded: Awaited<ReturnType<typeof loadConversationData>> | null = null;
    let result: Awaited<ReturnType<typeof generateRecord>> | null = null;
    let singleFlightPermit: Awaited<ReturnType<typeof acquireRecordSingleFlightPermit>> | null = null;
    let schedulerSession: RecordSchedulerProductionSession | undefined;
    let effectiveHash = hash;
    let effectiveWs = workspace || "general";
    let sourceSnapshot: RecordSourceSnapshot | null = null;
    try {
        loaded = options.frozenSource
            ? conversationLoadFromFrozenSource(options.frozenSource)
            : await loadConversationData(dataChain, conversationId, {
                link: "summary",
                logicalChain: effectiveLogicalChain,
                requestClass: options.background ? "background" : "foreground",
            });
        if (!loaded) return rt(`❌ 无法通过 dataChain=${dataChain} 获取对话数据`, startMs);
        if (loaded.windsurfData?.partial) {
            const skipped = loaded.windsurfData.skippedSteps || [];
            const shown = skipped.slice(0, 5).map(item => `offset ${item.offset}`).join(", ");
            const more = skipped.length > 5 ? ` 等 ${skipped.length} 个` : "";
            return rt([
                "❌ Record 更新已中止：Windsurf 原文读取不完整",
                `⚠️ 已跳过超大 step ${shown || "(未知)"}${more}`,
                "原因：Windsurf Language Server 拒绝返回超过单步大小限制的内容；memory-store 可以降级 read/search，但不会把缺失原文写成正式 Record。",
                "建议：先用 conversation_read_original(read/search, dataChain=\"windsurf\") 阅读可用部分；若需要完整 Record，请回到 Windsurf UI 或官方导出补齐该超大 step 后再生成。",
            ].join("\n"), startMs);
        }

        const rounds = loaded.rounds;
        const totalSteps = loaded.totalSteps;
        const afterLoadAbort = buildRecordTaskAbortResponse(startMs, options, "对话已加载，停止后续 Record 生成");
        if (afterLoadAbort) return afterLoadAbort;
        options.onProgress?.({
            stage: "解析完成",
            current: 0,
            total: rounds.length,
            unit: "轮",
            detail: `${rounds.length} 轮 / ${totalSteps} 步，开始检查 Record 索引`,
        });

        if (hash === "general" && !workspace) {
            const detectedWs = loaded.chainUsed === "antigravity"
                ? detectWorkspaceFromSteps(loaded.trajectory?.steps || [])
                : (loaded.codexData?.thread.cwd || loaded.claudeCodeData?.thread.cwd || loaded.windsurfData?.thread.cwd);
            if (detectedWs) effectiveWs = detectedWs;
        }
        if (effectiveWs !== "general") {
            effectiveHash = (await ensureWorkspaceAsync(effectiveWs)).hash;
        }

        const cascadeId = loaded.conversationId;
        if (options.schedulerExecution) {
            if (!options.frozenSource
                || options.frozenSource.snapshot.sourceSnapshotId !== options.schedulerExecution.sourceSnapshotId
                || options.frozenSource.snapshot.conversationId !== cascadeId
                || options.frozenSource.snapshot.chain !== loaded.chainUsed
                || options.frozenSource.snapshot.workspaceHash !== hash) {
                throw new RecordSchedulerRepairRequiredError("scheduler-managed update 缺少匹配的 sealed frozen source");
            }
            effectiveHash = options.frozenSource.snapshot.workspaceHash;
        }
        sourceSnapshot = {
            chain: loaded.chainUsed,
            rounds: rounds.length,
            totalSteps,
            rolloutPath: loaded.codexData?.thread.rolloutPath,
            rolloutMtimeMs: await statMtimeMsAsync(loaded.codexData?.thread.rolloutPath),
        };
        singleFlightPermit = await acquireRecordSingleFlightPermit(cascadeId, options);
        const existingBestHash = await findRecordHashAsync(cascadeId);
        if (!options.schedulerExecution && existingBestHash && existingBestHash !== effectiveHash) {
            const [currentContent, bestContent] = await Promise.all([
                readRecordAsync(effectiveHash, cascadeId),
                readRecordAsync(existingBestHash, cascadeId),
            ]);
            const shouldSeedOfficial = bestContent && (
                !currentContent ||
                await compareRecordCandidateAsync(
                    { hash: existingBestHash, conversationId: cascadeId, content: bestContent },
                    { hash: effectiveHash, conversationId: cascadeId, content: currentContent },
                ) > 0
            );
            if (shouldSeedOfficial) {
                const seeded = await withRecordUpdateSharedPermit({
                    isCancelled: options.isCancelled,
                    isSettled: options.isSettled,
                    onProgress: options.onProgress,
                    waitingStage: "等待 Record 写入许可",
                    acquiredStage: "迁移 Record 副本",
                    waitingDetail: `等待 Record 迁移写入许可（dataChain=${dataChain}）`,
                    acquiredDetail: `已获取 Record 迁移写入许可（dataChain=${dataChain}）`,
                }, async () => {
                    await runRecordPersistenceTestHook("before_copy", cascadeId);
                    await copyRecordToHash(existingBestHash, effectiveHash, cascadeId, { lastUpdatedAt: new Date().toISOString() }, { backup: true });
                    await writeRecordSidecar(existingBestHash, cascadeId, RECORD_OWNERSHIP_SIDECAR, {
                        status: "superseded",
                        supersededBy: effectiveHash,
                        reason: "record update remapped existing alias/general copy to official workspace",
                        updatedAt: new Date().toISOString(),
                    });
                });
                sharedPool = { queueWaitMs: seeded.permit.queueWaitMs, snapshot: seeded.permit.snapshot };
            }
        }

        schedulerSession = options.schedulerExecution && options.frozenSource
            ? createSchedulerProductionSession(options.schedulerExecution, options.frozenSource)
            : undefined;
        result = await generateRecord(effectiveHash, cascadeId, effectiveWs, rounds, totalSteps, modelChain, {
            background: options.background,
            parallelMode,
            force,
            isCancelled: options.isCancelled,
            isSettled: options.isSettled,
            onProgress: options.onProgress,
            ...(schedulerSession ? {
                schedulerManagedExecution: true,
                schedulerModelCall: schedulerSession.schedulerModelCall,
            } : {}),
        });
    } catch (error) {
        if (error instanceof RecordUpdatePoolAbortError) {
            return recordUpdatePoolAbortResponse(startMs, error, "写入许可排队中止，未继续迁移或生成 Record");
        }
        if (error instanceof RecordSingleFlightAbortError) {
            return rt(`⚠️ ${error.message} | ${formatRecordUpdatePoolDetail(error.snapshot)}`, startMs);
        }
        throw error;
    } finally {
        if (!result) singleFlightPermit?.release();
    }
    if (!loaded || !result) {
        return rt("❌ Record 更新失败：共享池执行结束后未拿到完整结果", startMs);
    }

    try {
        const cascadeId = loaded.conversationId;
        const rounds = loaded.rounds;
        const totalSteps = loaded.totalSteps;
        if (result.aborted) {
            return rt(
                result.abortReason === "cancelled"
                    ? `🛑 Record 更新已取消：${result.error || "已停止后续模型调用和写回"}`
                    : `⚠️ 后台任务已超时/结算：${result.error || "已停止后续模型调用和写回"}`,
                startMs,
            );
        }
        if (!result.success) return rt(`❌ Record 生成失败: ${result.error}`, startMs);

        const beforeWriteAbort = buildRecordTaskAbortResponse(startMs, options, "写回正式 Record 前检查到任务已终止");
        if (beforeWriteAbort) return beforeWriteAbort;
        const oldRecordForGate = await readRecordAsync(effectiveHash, cascadeId) || "";
        const gate = validateRecordCandidateForWrite(result.content!, cascadeId, rounds.length, result.coveredRounds || rounds.length, {
            oldRecord: oldRecordForGate,
        });
        if (!gate.ok) return rt(`❌ Record 生成失败: ${gate.error}`, startMs);
        const phases = countPhasesInRecord(result.content!);
        const existingIndexEntry = (await readRecordsIndexAsync(effectiveHash)).records[cascadeId];
        const recordMeta = completeRecordMetadata({
            conversationId: cascadeId,
            content: result.content!,
            rounds: rounds.length,
            totalSteps,
            coveredRounds: result.coveredRounds || rounds.length,
            phases,
            timeSpan: existingIndexEntry?.timeSpan,
            tags: result.tags ?? existingIndexEntry?.tags,
            chain: loaded.chainUsed,
            coveredRevisionSequence: options.frozenSource?.snapshot.sourceRevisionSequence,
        });
        let readerIndexStatus = "rebuilt";
        try {
            const committed = await withRecordUpdateSharedPermit({
                isCancelled: options.isCancelled,
                isSettled: options.isSettled,
                onProgress: options.onProgress,
                waitingStage: "等待 Record 写入许可",
                acquiredStage: "写回 Record",
                waitingDetail: `等待 Record 写回许可（dataChain=${dataChain}）`,
                acquiredDetail: `已获取 Record 写回许可（dataChain=${dataChain}）`,
            }, async permit => {
                const abortReason = getRecordTaskAbortReason(options);
                if (abortReason) throw new RecordUpdatePoolAbortError(abortReason, permit.snapshot);
                const beforeCommitReason = getRecordTaskAbortReason(options);
                if (beforeCommitReason) throw new RecordUpdatePoolAbortError(beforeCommitReason, permit.snapshot);
                if (schedulerSession) {
                    const finalized = await finalizeSchedulerLocalRecord(schedulerSession, {
                        content: result.content!,
                        commit: {
                            firstPublicationToken: stableFirstPublicationToken(options.frozenSource!.snapshot),
                            recordMeta,
                            hooks: schedulerRecordPersistenceTestHooks(cascadeId),
                        },
                    });
                    if (finalized.kind === "cancelled") throw new RecordUpdatePoolAbortError("cancelled", permit.snapshot);
                    readerIndexStatus = "verified";
                    return;
                }
                await runRecordPersistenceTestHook("before_write", cascadeId);
                await writeRecord(effectiveHash, cascadeId, result.content!, recordMeta);
                const readerIndex = await buildAndPersistRecordReaderIndex(effectiveHash, cascadeId, result.content!, {
                    beforeWrite: () => runRecordPersistenceTestHook("before_reader_index", cascadeId),
                });
                if (readerIndex.error) {
                    readerIndexStatus = `error: ${readerIndex.error instanceof Error ? readerIndex.error.message : String(readerIndex.error)}`;
                }
            });
            sharedPool = { queueWaitMs: committed.permit.queueWaitMs, snapshot: committed.permit.snapshot };
        } catch (error) {
            if (error instanceof RecordUpdatePoolAbortError) {
                return recordUpdatePoolAbortResponse(startMs, error, "写回 Record 前已中止");
            }
            throw error;
        }

        const sizeKB = (Buffer.byteLength(result.content!, "utf-8") / 1024).toFixed(1);
        let out = result.upToDate
            ? "✅ Record 已是最新（索引已刷新）"
            : `✅ Record 已${conversationId ? "更新" : "生成"}`;
        out += `\n📝 对话: ${cascadeId.slice(0, 8)}...`;
        out += `\n🔗 对话链路: ${loaded.chainUsed}`;
        out += `\n🧠 模型链路: ${modelChain}`;
        if (result.modelChainsUsed?.length) {
            out += `\n🧠 实际模型链路: ${result.modelChainsUsed.join(", ")}`;
        }
        if (result.modelModelsUsed?.length) {
            out += `\n🧠 实际模型: ${result.modelModelsUsed.join(", ")}`;
        }
        if (loaded.claudeCodeData?.logicalChain && loaded.claudeCodeData.logicalChain.mode !== "off") {
            const info = loaded.claudeCodeData.logicalChain;
            const merged = info.segments.filter(item => item.role === "predecessor-merged");
            out += `\n🧩 Claude Code 逻辑续聊: ${info.merged ? `已合并 ${merged.length} 个前序片段` : "未发现可安全自动合并的前序片段"}`;
            if (info.warnings?.length) out += `\n⚠️ ${info.warnings.join("\n⚠️ ")}`;
        }
        if (parallelMode) out += `\n🧪 并行模式: ${parallelMode}`;
        if (force) out += `\n♻️ force: 已绕过“已是最新”短路`;
        if (result.warnings?.length) {
            out += `\n⚠️ ${result.warnings.join("\n⚠️ ")}`;
        }
        const sourceChangedWarning = sourceSnapshot
            ? buildSourceChangedWarning(sourceSnapshot, await statMtimeMsAsync(sourceSnapshot.rolloutPath))
            : null;
        if (sourceChangedWarning) out += `\n⚠️ ${sourceChangedWarning}`;
        if (sharedPool) out += `\n🚦 共享池: ${formatRecordUpdatePoolDetail(sharedPool.snapshot, sharedPool.queueWaitMs)}`;
        out += `\n📊 ${rounds.length} 轮 / ${totalSteps} 步骤 → ${phases} 个 Phase`;
        out += `\n💾 大小: ${sizeKB}KB`;
        out += `\n🔎 Reader Index: ${readerIndexStatus}`;
        if (result.batches && result.batches > 1) {
            out += `\n🔄 分 ${result.batches} 批生成，覆盖到第 ${result.coveredRounds} 轮`;
        }
        return rt(out, startMs);
    } finally {
        singleFlightPermit?.release();
    }
}

async function recordCoverageWarningAsync(hash: string, conversationId: string, content: string): Promise<string | null> {
    const entry = (await readRecordsIndexAsync(hash)).records[conversationId];
    const indexedRound = entry?.lastUpdatedRound || entry?.totalRounds || 0;
    if (!indexedRound) return null;
    const coveredRound = inferCoveredRoundFromRecord(content, indexedRound);
    if (coveredRound >= indexedRound) return null;
    return `⚠️ Record 正文疑似只覆盖 ${coveredRound}/${indexedRound} 轮；下次 update 会先修正索引并继续生成。`;
}

async function buildRecordUpdateResumePayload(
    workspaceHash: string,
    conversationId: string | undefined,
    workspace: string | undefined,
    dataChain: DataChain,
    modelChain: Chain,
    parallelMode: RecordParallelMode | undefined,
    force: boolean | undefined,
    logicalChain: ConversationLogicalChainMode | undefined,
): Promise<RecordUpdateResumePayload | null> {
    const resolvedChain = await resolveConversationChain(dataChain);
    if (!resolvedChain) return null;
    const resolvedConversationId = await resolveConversationId(conversationId, resolvedChain, process.cwd(), "background");
    if (!resolvedConversationId) return null;
    let resolvedWorkspaceHash = workspaceHash;
    if (workspace) {
        resolvedWorkspaceHash = resolveWorkspaceHashForRecord(workspace);
    } else if (workspaceHash === "general") {
        resolvedWorkspaceHash = (await detectOwnershipSource(resolvedConversationId, resolvedChain, "background")).expectedHash || workspaceHash;
    }
    return {
        kind: "record-update",
        conversationId: resolvedConversationId,
        ...(workspace ? { workspace } : {}),
        workspaceHash: resolvedWorkspaceHash,
        dataChain: resolvedChain,
        modelChain,
        ...(parallelMode ? { parallelMode } : {}),
        ...(force !== undefined ? { force } : {}),
        ...(logicalChain ? { logicalChain } : {}),
    };
}

async function handleRecordSchedulerUpdate(
    hash: string,
    conversationId: string | undefined,
    workspace: string | undefined,
    dataChain: DataChain,
    modelChain: Chain,
    parallelMode: RecordParallelMode | undefined,
    force: boolean | undefined,
    logicalChain: ConversationLogicalChainMode | undefined,
    startMs: number,
    background: boolean,
    autoBackground: boolean,
) {
    await waitForRecordMutationReadiness();
    const resumePayload = await buildRecordUpdateResumePayload(
        hash,
        conversationId,
        workspace,
        dataChain,
        modelChain,
        parallelMode,
        force,
        logicalChain,
    );
    if (!resumePayload) {
        return rt(`❌ 无法为 dataChain=${dataChain} 冻结可恢复的 conversationId`, startMs);
    }
    const requestSummary = {
        operation: "record-update",
        conversationId: resumePayload.conversationId,
        workspace: resumePayload.workspace || "general",
        workspaceHash: resumePayload.workspaceHash,
        dataChain: resumePayload.dataChain,
        modelChain: resumePayload.modelChain,
        parallelMode: resumePayload.parallelMode || "off",
        force: resumePayload.force === true,
        logicalChain: resumePayload.logicalChain || "off",
    };
    const runtime = getRecordSchedulerRuntime();
    const discoveryRequest = buildRecordSchedulerDiscoveryRequest({
        kind: "record-update",
        selector: force ? "force" : "normal",
        hash: resumePayload.workspaceHash,
        workspace: resumePayload.workspace,
        dataChain: resumePayload.dataChain,
        limit: 1,
        targetConversationId: resumePayload.conversationId,
    });
    const admission = await runtime.admit({
        kind: "record-update",
        requestKey: recordSchedulerRequestKey("record-update", requestSummary),
        requestSummary,
        resumePayload,
        requestMode: force ? "force" : "normal",
        backgroundProjection: { background, autoBackground },
        replayTerminal: false,
        discovery: discoveryRequest,
        execute: async ({ taskId, updateProgress, isCancelled, isSettled }, _discovery, sourceSnapshots) => {
            const frozenSource = sourceSnapshots?.sources.find(source => (
                source.snapshot.conversationId === resumePayload.conversationId
                && source.snapshot.chain === resumePayload.dataChain
                && source.snapshot.workspaceHash === resumePayload.workspaceHash
            ));
            if (!sourceSnapshots || sourceSnapshots.phase !== "sealed" || !frozenSource) {
                const issue = sourceSnapshots?.unresolved.find(item => (
                    item.conversationId === resumePayload.conversationId
                    && item.chain === resumePayload.dataChain
                    && item.workspaceHash === resumePayload.workspaceHash
                ));
                const availableSources = sourceSnapshots
                    ? [
                        ...sourceSnapshots.sources.map(source => `source:${source.snapshot.chain}/${source.snapshot.workspaceHash}/${source.snapshot.conversationId}`),
                        ...sourceSnapshots.unresolved.map(item => `${item.kind}:${item.chain}/${item.workspaceHash}/${item.conversationId}:${item.reason}`),
                    ].join(" | ") || "empty"
                    : "missing";
                throw new RecordSchedulerRepairRequiredError(
                    `Record scheduler update ${taskId} 缺少 ${resumePayload.dataChain}/${resumePayload.workspaceHash}/${resumePayload.conversationId} 的 sealed frozen source：${issue?.reason || "完整源读取未形成可回读 immutable spool"}；available=${availableSources}`,
                );
            }
            const result = await handleUpdate(
                resumePayload.workspaceHash,
                resumePayload.conversationId,
                resumePayload.workspace,
                resumePayload.dataChain,
                resumePayload.modelChain,
                resumePayload.parallelMode,
                resumePayload.force,
                resumePayload.logicalChain,
                Date.now(),
                {
                    background: true,
                    onProgress: updateProgress,
                    isCancelled,
                    isSettled,
                    frozenSource,
                    schedulerExecution: {
                        taskId: taskId,
                        frozenSources: sourceSnapshots,
                        sourceSnapshotId: frozenSource.snapshot.sourceSnapshotId,
                        runtime,
                    },
                },
            );
            return responseText(result);
        },
    });
    if (admission.outcome === "UnknownOutcome") {
        return rt([
            "⚠️ Record scheduler 接纳结果未确定，未返回成功 taskId",
            `候选 ledger: ${admission.candidateTaskIds.join(", ") || "无"}`,
            `原因: ${admission.reasons.join("; ") || "未知"}`,
        ].join("\n"), startMs);
    }
    if (!background) {
        const status = await runtime.waitForTerminal(admission.taskId);
        const persistedTask = await waitForBackgroundTask(admission.taskId, 1);
        return rt(persistedTask?.result || formatRecordSchedulerTaskStatus(status, persistedTask?.error), startMs);
    }
    return rt([
        `🚀 Record scheduler 已接纳更新 (${admission.outcome === "Replayed" ? "复用既有任务" : "新任务"})`,
        autoBackground ? "（未显式指定 background，保持自动后台）" : "",
        `🆔 taskId: ${admission.taskId}`,
        `🔗 dataChain: ${resumePayload.dataChain}`,
        `🧠 modelChain: ${resumePayload.modelChain}`,
        `🧷 resume conversationId: ${resumePayload.conversationId}`,
        "💡 后续调用 record_manage(action=\"task_status\", taskId=\"...\") 查询账本状态",
    ].filter(Boolean).join("\n"), startMs);
}

export interface RecordAutoUpdateAdmissionInput {
    workspaceHash: string;
    conversationId: string;
    workspace?: string;
    dataChain: DataChain;
    modelChain: Chain;
    logicalChain?: ConversationLogicalChainMode;
}

export async function admitRecordAutoUpdate(input: RecordAutoUpdateAdmissionInput): Promise<string> {
    const response = await handleRecordSchedulerUpdate(
        input.workspaceHash,
        input.conversationId,
        input.workspace,
        input.dataChain,
        input.modelChain,
        undefined,
        false,
        input.logicalChain,
        Date.now(),
        true,
        true,
    );
    return responseText(response);
}

async function handleTaskStatus(taskId: string | undefined, waitSeconds: number | undefined, startMs: number) {
    if (!taskId) return rt("❌ task_status 需要 taskId 参数", startMs);
    const runtime = getRecordSchedulerRuntime();
    const schedulerStatus = runtime.status(taskId);
    if (schedulerStatus) {
        const settled = await runtime.waitForTerminal(taskId, waitSeconds || 0);
        const persistedTask = await waitForBackgroundTask(taskId, settled && isTerminalTaskState(settled.state) ? 1 : 0);
        return rt(formatRecordSchedulerTaskStatus(settled, persistedTask?.error), startMs);
    }
    const projectionHint = getRecordSchedulerProjectionHint(taskId);
    if (projectionHint) {
        return rt(`⚠️ ${schedulerRecoveryRequired(projectionHint).message}`, startMs);
    }
    const task = await waitForBackgroundTask(taskId, waitSeconds || 0);
    return rt(formatBackgroundTask(task), startMs);
}

async function resumeSchedulerBackgroundTask(task: BackgroundTask): Promise<string> {
    if (!getRecordSchedulerRuntime().status(task.id)) {
        throw schedulerRecoveryRequired(task);
    }
    ensureRecordRecoveryHandlersRegistered();
    const handler = getBackgroundTaskRecoveryHandler(task.kind);
    if (!handler) {
        throw new RecordSchedulerRepairRequiredError(`Record scheduler ${task.id} 未注册 background recovery handler`);
    }
    const action = await handler(task);
    if (!action || action.mode !== "resume") {
        throw new RecordSchedulerRepairRequiredError(`Record scheduler ${task.id} recovery handler 未返回同 taskId resume action`);
    }
    return await action.run({
        taskId: task.id,
        updateProgress: () => undefined,
        isCancelled: () => readPersistedRecordTask(task.id)?.status === "cancelled",
        isSettled: () => {
            const latest = readPersistedRecordTask(task.id);
            return latest === null || latest.status !== "running";
        },
    });
}

async function handleRecover(taskId: string | undefined, startMs: number) {
    if (!taskId) {
        return rt(formatRecoverableRecordTasks(listRecoverableRecordTasks()), startMs);
    }
    const persistedTask = readPersistedRecordTask(taskId);
    if (persistedTask && isSchedulerBackedRecordTask(persistedTask)) {
        const result = await resumeSchedulerBackgroundTask(persistedTask);
        return rt(`♻️ Record scheduler 已通过 background recovery handler 继续执行：${taskId}\n${result}`, startMs);
    }
    const runtime = getRecordSchedulerRuntime();
    const schedulerStatus = runtime.status(taskId);
    if (schedulerStatus) {
        throw new RecordSchedulerRepairRequiredError(`Record scheduler ${taskId} 缺少持久 background admission envelope，禁止仅抢 owner 后伪造恢复成功`);
    }
    if (!persistedTask) {
        return rt(`❌ 未找到可读取的后台任务：${taskId}`, startMs);
    }
    if (!RECORD_RECOVERABLE_TASK_KINDS.has(persistedTask.kind)) {
        return rt(`❌ record_manage(recover) 仅恢复 Record 任务；${taskId} 的类型为 ${persistedTask.kind}`, startMs);
    }
    if (isSchedulerBackedRecordTask(persistedTask)) {
        return rt(`⚠️ ${schedulerRecoveryRequired(persistedTask).message}`, startMs);
    }
    const result = await recoverBackgroundTask(taskId);
    const summaryLines = [
        result.outcome === "resumed"
            ? `♻️ Record 后台任务已恢复：${result.taskId}`
            : result.outcome === "loaded"
                ? `ℹ️ Record 后台任务无需恢复：${result.taskId}`
                : result.outcome === "claimed"
                    ? `⏭ Record 后台任务已被其他进程 claim：${result.taskId}`
                    : result.outcome === "restarted"
                        ? `♻️ Record 后台任务已重启：${result.taskId}`
                        : `❌ Record 后台任务恢复失败：${result.taskId}`,
        `📌 类型: ${result.kind}`,
        result.recoveredTaskId ? `🆔 recoveredTaskId: ${result.recoveredTaskId}` : "",
        result.reason ? `📋 原因: ${result.reason}` : "",
        "",
        formatBackgroundTask(result.task),
    ].filter(Boolean);
    return rt(summaryLines.join("\n"), startMs);
}

async function handleRecordCancel(taskId: string | undefined, startMs: number) {
    if (!taskId) return rt("❌ cancel 需要 taskId 参数", startMs);
    const runtime = getRecordSchedulerRuntime();
    const cancelled = await runtime.cancel(taskId);
    if (cancelled) return rt(formatRecordSchedulerCancel(cancelled), startMs);
    const projectionHint = getRecordSchedulerProjectionHint(taskId);
    if (projectionHint) {
        return rt(`⚠️ ${schedulerRecoveryRequired(projectionHint).message}`, startMs);
    }
    return rt(formatBackgroundTask(cancelBackgroundTask(taskId, "用户取消 Record 任务")), startMs);
}

// ============= list =============

function handleList(hash: string, scope: RecordManageScope | undefined, includeGeneral: boolean | undefined, after: string | undefined, before: string | undefined, limit: number | undefined, startMs: number) {
    const recordMap = new Map<string, ReturnType<typeof listRecords>[0] & { hash: string }>();
    for (const recordHash of recordHashesForScope(hash, scope, includeGeneral === true)) {
        for (const rec of listRecords(recordHash).filter(item => !isSupersededRecord(recordHash, item.conversationId))) {
            const existing = recordMap.get(rec.conversationId);
            if (!existing || compareRecordCandidate(
                { hash: recordHash, conversationId: rec.conversationId },
                { hash: existing.hash, conversationId: existing.conversationId },
            ) > 0) {
                recordMap.set(rec.conversationId, { ...rec, hash: recordHash });
            }
        }
    }
    let records = Array.from(recordMap.values()).sort(
        (a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime()
    );

    // 时间筛选
    if (after) {
        const afterMs = new Date(after).getTime();
        records = records.filter(r => new Date(r.lastUpdatedAt).getTime() >= afterMs);
    }
    if (before) {
        const beforeMs = new Date(before).getTime();
        records = records.filter(r => new Date(r.lastUpdatedAt).getTime() <= beforeMs);
    }

    // B1：默认 limit + 超长落盘，防 list 全量返回撑爆 token（截断在时间筛选之后）
    const total = records.length;
    const effectiveLimit = Math.min(Math.max(1, limit ?? 30), 200);
    const shown = records.slice(0, effectiveLimit);
    const lines = [total > shown.length
        ? `📋 Record 列表 (显示最近 ${shown.length}/${total} 份，按更新时间倒序；需更多用 limit，上限 200)：\n`
        : `📋 Record 列表 (${total} 份):\n`];
    for (const rec of shown) {
        const readerIndex = readRecordSidecar<RecordReaderIndex>(rec.hash, rec.conversationId, "record_index.json");
        const sectionCounts = readerIndex?.blocks
            ? readerIndex.blocks.reduce((stats, block) => {
                stats[block.sectionType] = (stats[block.sectionType] || 0) + 1;
                return stats;
            }, {} as Record<string, number>)
            : {};
        const indexStatus = readerIndex?.version === RECORD_READER_VERSION ? "ok" : "missing";
        lines.push(`  📝 ${rec.conversationId} | ${rec.title}`);
        lines.push(`     ${rec.totalRounds}轮/${rec.totalSteps}步 → ${rec.phases}Phase | ${(rec.sizeBytes / 1024).toFixed(1)}KB | ${rec.lastUpdatedAt.slice(0, 16)} | readerIndex=${indexStatus}`);
        if (readerIndex?.blocks) {
            lines.push(`     🔎 sections: ${Object.entries(sectionCounts).filter(([, count]) => count > 0).map(([type, count]) => `${type}:${count}`).join(", ")}`);
        }
        if (rec.tags && rec.tags.length > 0) {
            lines.push(`     🏷 ${rec.tags.join(", ")}`);
        }
    }
    if (total === 0) lines.push("  (无 Record)");
    const body = lines.join("\n");
    // 即便已 limit，内容仍可能超大（含 sections/tags）→ 落盘只返概览+路径，防撑爆 token
    if (body.length > 8000) {
        const tmpPath = saveTempFile("record-list", (hash || "all").slice(0, 8), body);
        return rt(`📋 Record 列表共 ${total} 份（已显示 ${shown.length}），完整列表 ${body.length} 字超长已落盘：\n${tmpPath}\n建议用 record_manage(read/search) 定位具体 Record，或调小 limit / 加 after/before 时间筛选。`, startMs);
    }
    return rt(body, startMs);
}

// ============= stale_check =============

interface ConversationMtimeInfo {
    id: string;
    lastModifiedMs: number;
    title?: string;
    stepCount?: number; // Windsurf LS 返回，用于区分 rename vs 真正内容更新
}

async function fetchConversationListForChain(chain: string, limit: number): Promise<Map<string, ConversationMtimeInfo>> {
    const map = new Map<string, ConversationMtimeInfo>();
    if (chain === "antigravity") {
        const conversations = listConversationsByMtime({ limit: Math.max(limit * 3, 50) });
        for (const conv of conversations) {
            map.set(conv.id, { id: conv.id, lastModifiedMs: conv.mtime.getTime(), title: conv.title });
        }
    } else if (chain === "codex") {
        for (const thread of listRecentCodexThreads(Math.max(limit * 3, 50))) {
            map.set(thread.id, { id: thread.id, lastModifiedMs: thread.updatedAtMs || 0, title: thread.title });
        }
    } else if (chain === "claude-code") {
        const { listRecentClaudeCodeThreads } = await import("../claude-code-client.js");
        for (const thread of listRecentClaudeCodeThreads(Math.max(limit * 3, 50))) {
            map.set(thread.id, { id: thread.id, lastModifiedMs: thread.updatedAtMs || 0, title: thread.title });
        }
    } else if (chain === "windsurf") {
        const { listRecentWindsurfThreads } = await import("../windsurf-client.js");
        for (const thread of await listRecentWindsurfThreads(Math.max(limit * 3, 50))) {
            const ms = Date.parse(thread.lastModifiedTime || thread.createdTime || "") || 0;
            map.set(thread.id, { id: thread.id, lastModifiedMs: ms, title: thread.title, stepCount: thread.stepCount });
        }
    }
    return map;
}

function isRenameOnly(conv: ConversationMtimeInfo, rec: { totalSteps: number }): boolean {
    // Windsurf LS 返回 stepCount：如果步数没变，说明只是 rename/元数据变化，不算过期
    return conv.stepCount !== undefined && conv.stepCount > 0 && conv.stepCount === rec.totalSteps;
}

const STALE_THRESHOLD_MS = 60_000; // 60s 容差，避免 mtime 精度/record 生成延迟误报

async function handleStaleCheck(
    hash: string,
    workspace: string | undefined,
    scope: RecordManageScope | undefined,
    includeGeneral: boolean | undefined,
    dataChain: string | undefined,
    limit: number | undefined,
    startMs: number,
) {
    const schedulerRuntime = getRecordSchedulerRuntime();
    const discoveryRequest = buildRecordSchedulerDiscoveryRequest({
        kind: "stale_check",
        selector: "stale_only",
        hash,
        workspace,
        scope,
        includeGeneral,
        dataChain,
        limit,
    });
    const schedulerSnapshot = await schedulerRuntime.discover(discoveryRequest);
    const candidates = schedulerRuntime.selectDiscoveryCandidates(schedulerSnapshot, "stale_only");
    const unresolvedCandidates = schedulerSnapshot.candidates.filter(candidate => candidate.classification === "Unresolved");
    const unresolved = unresolvedCandidates.length;
    const lost = schedulerSnapshot.candidates.filter(candidate => candidate.classification === "Lost").length;
    const effectiveLimit = Math.min(Math.max(1, limit ?? 50), 200);
    const lines = [
        `🔎 scheduler stale_check：冻结快照 ${schedulerSnapshot.snapshotId}`,
        `📦 共扫描 ${schedulerSnapshot.candidates.length} 份，其中 ${candidates.length} 份已过期；Unresolved ${unresolved}；Lost ${lost}`,
        ...candidates.slice(0, effectiveLimit).map(candidate => `- ${candidate.source.host}:${candidate.source.identity.conversationId}`),
        ...unresolvedCandidates.slice(0, effectiveLimit).map(candidate => `- ⚠️ ${candidate.source.host}:${candidate.source.identity.conversationId}：${candidate.classificationReason.code}`),
    ];
    if (candidates.length > effectiveLimit) lines.push(`…其余 ${candidates.length - effectiveLimit} 份已省略`);
    return rt(lines.join("\n"), startMs);
}

// ============= read =============

async function handleRead(
    hash: string, conversationId: string | undefined,
    startLine: number | undefined, endLine: number | undefined, startMs: number,
    options: {
        view?: RecordReaderView;
        phaseIds?: Array<string | number>;
        startBlockId?: string;
        sectionTypes?: RecordSectionType[];
        include?: RecordSectionType[];
        exclude?: RecordSectionType[];
        maxChars?: number;
        format?: RecordReadFormat;
        withCitations?: boolean;
        indexMode?: RecordReaderIndexMode;
    } = {},
) {
    if (!conversationId) return rt("❌ read 需要 conversationId 参数", startMs);

    const location = await resolveRecordLocationAsync(hash, conversationId);
    if (!location) return rt(`❌ 未找到 ${conversationId} 的 Record`, startMs);
    const { conversationId: resolvedId, content } = location;
    const hasStructuredRead = Boolean(
        options.view && options.view !== "raw"
        || options.phaseIds?.length
        || options.sectionTypes?.length
        || options.include?.length
        || options.exclude?.length
        || options.indexMode
    );

    if (!hasStructuredRead && (startLine !== undefined || endLine !== undefined)) {
        const lines = content.split(/\r?\n/);
        const s = Math.max(1, startLine || 1);
        const e = Math.min(lines.length, endLine || lines.length);
        const slice = lines.slice(s - 1, e).join("\n");
        return rt(`📄 Record ${resolvedId.slice(0, 8)}... (行 ${s}-${e}/${lines.length}):\n\n${slice}`, startMs);
    }

    if (!hasStructuredRead) {
        if (content.length > 8000) {
            const tmpPath = await saveTempFileAsync("record", resolvedId.slice(0, 8), content);
            return rt(`📄 Record ${resolvedId.slice(0, 8)}... (${content.split(/\r?\n/).length}行, ${(Buffer.byteLength(content) / 1024).toFixed(1)}KB)\n已保存到临时文件: ${tmpPath}\n请用 view_file 查看。`, startMs);
        }

        return rt(`📄 Record ${resolvedId.slice(0, 8)}...:\n\n${content}`, startMs);
    }

    const { index, indexStatus } = await readOrBuildReaderIndex(location.hash, resolvedId, content, options.indexMode || "auto");
    const coverageWarning = await recordCoverageWarningAsync(location.hash, resolvedId, content);
    if (options.view === "outline") {
        const outline = buildOutline(index);
        const payload = { recordId: resolvedId, hash: location.hash, indexStatus, view: "outline", warning: coverageWarning || undefined, outline };
        if (options.format === "json") return rt(JSON.stringify(payload, null, 2), startMs);
        return rt(`📚 Record Outline ${resolvedId.slice(0, 8)}... (${indexStatus})${coverageWarning ? `\n${coverageWarning}` : ""}\n\n${JSON.stringify(outline, null, 2)}`, startMs);
    }

    const viewOptions: FormatReaderViewOptions = {
        view: options.view || (options.phaseIds?.length ? "phase" : "custom"),
        phaseIds: options.phaseIds,
        startBlockId: options.startBlockId,
        sectionTypes: normalizeSectionTypes(options.sectionTypes),
        include: normalizeSectionTypes(options.include),
        exclude: normalizeSectionTypes(options.exclude),
        maxChars: options.maxChars,
        format: options.format,
        withCitations: options.withCitations,
    };
    const result = formatReaderView(index, viewOptions);
    if (options.format === "json") {
        const selected = selectRecordReaderBlocks(index, viewOptions);
        return rt(JSON.stringify({
            recordId: resolvedId,
            hash: location.hash,
            indexStatus,
            warning: coverageWarning || undefined,
            view: viewOptions.view,
            truncated: selected.truncated,
            truncatedReason: selected.truncatedReason,
            nextReadHint: selected.nextReadHint,
            matchedBlockCount: selected.totalBlocks,
            returnedBlockCount: selected.blocks.length,
            blockCount: selected.blocks.length,
            blocks: selected.blocks.map(block => ({
                id: block.id,
                phaseId: block.phaseId,
                sectionType: block.sectionType,
                title: block.title,
                lineRange: block.lineRange,
                charRange: block.charRange,
                text: block.text,
            })),
        }, null, 2), startMs);
    }

    if (!result.text) {
        if (result.truncated) {
            return rt(`⚠️ Record ${resolvedId.slice(0, 8)}... 结构化读取命中区块，但当前 maxChars 太小，未返回正文（index=${indexStatus}）${coverageWarning ? `\n${coverageWarning}` : ""}\n${result.nextReadHint}`, startMs);
        }
        return rt(`📭 Record ${resolvedId.slice(0, 8)}... 结构化读取无匹配区块（index=${indexStatus}）${coverageWarning ? `\n${coverageWarning}` : ""}`, startMs);
    }
    const suffix = result.truncated ? `\n\n⚠️ 已按 block 边界截断：${result.nextReadHint}` : "";
    if (result.text.length > 8000 && !options.maxChars) {
        const tmpPath = await saveTempFileAsync("record-reader", resolvedId.slice(0, 8), result.text);
        return rt(`📄 Record ${resolvedId.slice(0, 8)}... 结构化读取结果过长，已保存结构化结果到临时文件: ${tmpPath}${coverageWarning ? `\n${coverageWarning}` : ""}\n建议补传 maxChars / phaseIds / sectionTypes 缩小读取范围。`, startMs);
    }
    return rt(`📄 Record ${resolvedId.slice(0, 8)}... 结构化读取 (${viewOptions.view}, index=${indexStatus})${coverageWarning ? `\n${coverageWarning}` : ""}\n\n${result.text}${suffix}`, startMs);
}

// ============= search =============

async function handleSearch(
    hash: string,
    query: string | undefined,
    scope: RecordManageScope | undefined,
    includeGeneral: boolean | undefined,
    mode: "auto" | "exact" | "fuzzy" | "smart" | undefined,
    chain: Chain,
    startMs: number,
    options: {
        conversationId?: string;
        recordIds?: string[];
        phaseIds?: Array<string | number>;
        sectionTypes?: RecordSectionType[];
        searchScope?: RecordSearchScope;
        maxChars?: number;
        format?: RecordReadFormat;
        indexMode?: RecordReaderIndexMode;
        limit?: number;
    } = {},
) {
    if (!query) return rt("❌ search 需要 query 参数", startMs);

    const hasStructuredSearch = Boolean(
        options.conversationId
        || options.recordIds?.length
        || options.phaseIds?.length
        || options.sectionTypes?.length
        || options.searchScope
        || options.format === "json"
        || options.maxChars
        || options.indexMode
    );

    const blocks = hasStructuredSearch
        ? await buildStructuredRecordSearchBlocks(hash, scope, includeGeneral === true, options)
        : await buildRecordSearchBlocksForScopeAsync(hash, scope, includeGeneral === true);

    if (blocks.length === 0) return rt("📭 当前工作区无 Record", startMs);

    let results = await search(blocks, query, { mode: mode || "auto", limit: options.limit || 10, chain });
    if ((mode || "auto") === "auto" && results.length === 0) {
        results = await search(blocks, query, { mode: "smart", limit: options.limit || 10, chain });
    }

    if (results.length === 0) return rt(`🔍 搜索 "${query}" — 无匹配`, startMs);

    if (hasStructuredSearch) {
        const body = formatStructuredSearchResults(query, results, options.format || "text", options.maxChars);
        if (body.length > 8000) {
            const tmpPath = await saveTempFileAsync("record-search", (options.conversationId || hash || "all").slice(0, 8), body);
            return rt(`🔍 Record 搜索结果 ${body.length} 字超长已保存到临时文件: ${tmpPath}`, startMs);
        }
        return rt(body, startMs);
    }

    const lines = [`🔍 搜索 "${query}" — ${results.length} 份 Record 命中 (${results[0].matchType} 模式):\n`];
    for (const rec of results.slice(0, 5)) {
        lines.push(`📝 ${rec.id} | ${rec.title} (${rec.matchType}, score: ${rec.score.toFixed(2)})`);
        for (const m of rec.matches.slice(0, 3)) {
            const lineInfo = m.lineNum ? `L${m.lineNum}: ` : "";
            lines.push(`  ${lineInfo}${m.line.trim().slice(0, 100)}`);
        }
    }
    const body = lines.join("\n");
    if (body.length > 8000) {
        const tmpPath = await saveTempFileAsync("record-search", (options.conversationId || hash || "all").slice(0, 8), body);
        return rt(`🔍 Record 搜索结果 ${body.length} 字超长已保存到临时文件: ${tmpPath}`, startMs);
    }
    return rt(body, startMs);
}

interface RecordSearchTarget {
    hash: string;
    conversationId: string;
    title: string;
    tags: string[];
    updatedAt: number;
    content: string;
}

export function formatStaleCheckNoStaleSummary(unresolved: number): string {
    if (unresolved > 0) {
        return `  ⚠️ 未发现确认过期，仍有 ${unresolved} 份 unresolved（近期列表未找到，仅统计，不更新、不改动）`;
    }
    return "  ✅ 所有 Record 均已跟进到最新";
}

function collectRecordSearchTargets(
    hash: string,
    scope: RecordManageScope | undefined,
    includeGeneral: boolean,
    conversationId?: string,
    recordIds?: string[],
): RecordSearchTarget[] {
    const ids = [...(conversationId ? [conversationId] : []), ...(recordIds || [])].filter(Boolean);
    if (ids.length > 0) {
        const targets: RecordSearchTarget[] = [];
        for (const id of ids) {
            const location = resolveRecordLocation(hash, id);
            if (!location) continue;
            const entry = readRecordsIndex(location.hash).records[location.conversationId];
            targets.push({
                hash: location.hash,
                conversationId: location.conversationId,
                title: entry?.title || location.conversationId,
                tags: entry?.tags || [],
                updatedAt: Date.parse(entry?.lastUpdatedAt || "") || 0,
                content: location.content,
            });
        }
        return dedupeSearchTargets(targets);
    }

    const targets: RecordSearchTarget[] = [];
    for (const h of recordHashesForScope(hash, scope, includeGeneral)) {
        const index = readRecordsIndex(h);
        for (const entry of Object.values(index.records)) {
            if (isSupersededRecord(h, entry.conversationId)) continue;
            const content = readRecord(h, entry.conversationId);
            if (!content) continue;
            targets.push({
                hash: h,
                conversationId: entry.conversationId,
                title: entry.title,
                tags: entry.tags || [],
                updatedAt: Date.parse(entry.lastUpdatedAt || "") || 0,
                content,
            });
        }
    }
    return dedupeSearchTargets(targets);
}

async function collectRecordSearchTargetsAsync(
    hash: string,
    scope: RecordManageScope | undefined,
    includeGeneral: boolean,
    conversationId?: string,
    recordIds?: string[],
): Promise<RecordSearchTarget[]> {
    const ids = [...(conversationId ? [conversationId] : []), ...(recordIds || [])].filter(Boolean);
    if (ids.length > 0) {
        const targets = (await Promise.all(ids.map(async id => {
            const location = await resolveRecordLocationAsync(hash, id);
            if (!location) return null;
            const entry = (await readRecordsIndexAsync(location.hash)).records[location.conversationId];
            return {
                hash: location.hash,
                conversationId: location.conversationId,
                title: entry?.title || location.conversationId,
                tags: entry?.tags || [],
                updatedAt: Date.parse(entry?.lastUpdatedAt || "") || 0,
                content: location.content,
            } satisfies RecordSearchTarget;
        }))).filter((target): target is RecordSearchTarget => Boolean(target));
        return dedupeSearchTargetsAsync(targets);
    }

    const hashes = await recordHashesForScopeAsync(hash, scope, includeGeneral);
    const targets = (await Promise.all(hashes.map(async recordHash => {
        const index = await readRecordsIndexAsync(recordHash);
        return Promise.all(Object.values(index.records).map(async entry => {
            if (await isSupersededRecordAsync(recordHash, entry.conversationId)) return null;
            const content = await readRecordAsync(recordHash, entry.conversationId);
            if (!content) return null;
            return {
                hash: recordHash,
                conversationId: entry.conversationId,
                title: entry.title,
                tags: entry.tags || [],
                updatedAt: Date.parse(entry.lastUpdatedAt || "") || 0,
                content,
            } satisfies RecordSearchTarget;
        }));
    }))).flat().filter((target): target is RecordSearchTarget => Boolean(target));
    return dedupeSearchTargetsAsync(targets);
}

function dedupeSearchTargets(targets: RecordSearchTarget[]): RecordSearchTarget[] {
    const map = new Map<string, RecordSearchTarget>();
    for (const target of targets) {
        const existing = map.get(target.conversationId);
        if (!existing || compareRecordCandidate(
            { hash: target.hash, conversationId: target.conversationId, content: target.content },
            { hash: existing.hash, conversationId: existing.conversationId, content: existing.content },
        ) > 0) {
            map.set(target.conversationId, target);
        }
    }
    return Array.from(map.values());
}

async function dedupeSearchTargetsAsync(targets: RecordSearchTarget[]): Promise<RecordSearchTarget[]> {
    const map = new Map<string, RecordSearchTarget>();
    for (const target of targets) {
        const existing = map.get(target.conversationId);
        if (!existing || await compareRecordCandidateAsync(
            { hash: target.hash, conversationId: target.conversationId, content: target.content },
            { hash: existing.hash, conversationId: existing.conversationId, content: existing.content },
        ) > 0) {
            map.set(target.conversationId, target);
        }
    }
    return Array.from(map.values());
}

export async function buildStructuredRecordSearchBlocks(
    hash: string,
    scope: RecordManageScope | undefined,
    includeGeneral = false,
    options: {
        conversationId?: string;
        recordIds?: string[];
        phaseIds?: Array<string | number>;
        sectionTypes?: RecordSectionType[];
        searchScope?: RecordSearchScope;
        indexMode?: RecordReaderIndexMode;
    } = {},
): Promise<TextBlock[]> {
    const blocks: TextBlock[] = [];
    const targets = await collectRecordSearchTargetsAsync(hash, scope, includeGeneral, options.conversationId, options.recordIds);
    for (const target of targets) {
        const { index, indexStatus } = await readOrBuildReaderIndex(target.hash, target.conversationId, target.content, options.indexMode || "auto");
        const selected = blocksForSearchScope(index, options.searchScope || "section")
            .filter(block => matchesPhaseAndSection(block, options.phaseIds, options.sectionTypes));
        for (const block of selected) {
            const phaseLabel = block.phaseId || "tail";
            blocks.push({
                id: `${target.conversationId}:${block.id}`,
                title: `${target.title} / ${phaseLabel} / ${block.title || block.sectionType}`,
                content: block.text,
                tags: [...(target.tags || []), block.sectionType, phaseLabel],
                metadata: {
                    hash: target.hash,
                    recordId: target.conversationId,
                    conversationId: target.conversationId,
                    recordTitle: target.title,
                    blockId: block.id,
                    phaseId: block.phaseId,
                    sectionType: block.sectionType,
                    lineRange: block.lineRange,
                    charRange: block.charRange,
                    indexStatus,
                    readHint: {
                        action: "read",
                        conversationId: target.conversationId,
                        view: block.phaseId ? "phase" : "custom",
                        phaseIds: block.phaseId ? [block.phaseId] : undefined,
                        sectionTypes: [block.sectionType],
                        withCitations: true,
                    },
                },
            });
        }
    }
    return blocks;
}

function blocksForSearchScope(index: RecordReaderIndex, searchScope: RecordSearchScope): ReaderBlock[] {
    if (searchScope === "record") {
        return [{
            id: "record",
            blockId: "record",
            kind: "block",
            sectionType: "unknown",
            title: index.title || index.recordId,
            heading: index.title || index.recordId,
            text: index.blocks.map(block => block.text).join("\n\n"),
            lineRange: { start: 1, end: index.totalLines },
            charRange: { start: 0, end: index.totalChars },
            lineStart: 1,
            lineEnd: index.totalLines,
            charStart: 0,
            charEnd: index.totalChars,
            textPreview: index.title || index.recordId,
        }];
    }
    if (searchScope === "phase") {
        return index.phases.map(phase => {
            const phaseBlocks = index.blocks.filter(block => block.phaseId === phase.id);
            return {
                id: phase.id,
                blockId: phase.id,
                kind: "phase",
                phaseId: phase.id,
                sectionType: "phase_title",
                title: phase.title,
                heading: phase.title,
                text: phaseBlocks.map(block => block.text).join("\n\n"),
                lineRange: phase.lineRange,
                charRange: phase.charRange,
                lineStart: phase.lineStart,
                lineEnd: phase.lineEnd,
                charStart: phase.charStart,
                charEnd: phase.charEnd,
                textPreview: phase.textPreview,
            } satisfies ReaderBlock;
        });
    }
    return index.blocks.filter(block => searchScope === "item" ? block.sectionType !== "phase_title" && block.sectionType !== "header" : true);
}

function matchesPhaseAndSection(block: ReaderBlock, phaseIds?: Array<string | number>, sectionTypes?: RecordSectionType[]): boolean {
    if (phaseIds?.length) {
        const blockPhaseNumber = block.phaseId ? Number(block.phaseId.replace(/^phase-/u, "")) : undefined;
        const phaseMatch = block.phaseId && phaseIds.some(phaseId => phaseId === block.phaseId || phaseId === blockPhaseNumber || String(phaseId) === block.phaseId);
        if (!phaseMatch) return false;
    }
    if (sectionTypes?.length && !sectionTypes.includes(block.sectionType)) return false;
    return true;
}

function formatStructuredSearchResults(query: string, results: SearchResult[], format: RecordReadFormat, maxChars?: number): string {
    const payload = {
        query,
        count: results.length,
        results: results.map(result => ({
            id: result.id,
            title: result.title,
            score: result.score,
            matchType: result.matchType,
            matches: result.matches.slice(0, 3),
            provenance: {
                recordId: result.metadata?.recordId,
                blockId: result.metadata?.blockId,
                phaseId: result.metadata?.phaseId,
                sectionType: result.metadata?.sectionType,
                lineRange: result.metadata?.lineRange,
                charRange: result.metadata?.charRange,
            },
            readHint: result.metadata?.readHint,
        })),
    };
    if (format === "json") return JSON.stringify(payload, null, 2);

    const lines = [`🔍 结构化搜索 "${query}" — ${results.length} 个区块命中 (${results[0].matchType} 模式):\n`];
    let used = lines.join("\n").length;
    for (const result of results) {
        const meta = result.metadata || {};
        const itemLines = [
            `🧩 ${meta.recordId || result.id} / ${meta.phaseId || "record"} / ${meta.sectionType || "unknown"} (${result.matchType}, score: ${result.score.toFixed(2)})`,
            `   block=${meta.blockId || result.id} L${meta.lineRange?.start ?? "?"}-${meta.lineRange?.end ?? "?"}`,
            `   readHint=${JSON.stringify(meta.readHint)}`,
            ...result.matches.slice(0, 2).map(match => `   ${match.lineNum ? `L${match.lineNum}: ` : ""}${match.line.trim().slice(0, 160)}`),
        ];
        const chunk = `${itemLines.join("\n")}\n`;
        if (maxChars && used + chunk.length > maxChars) {
            lines.push(`⚠️ 已截断，增加 maxChars 或缩小 phaseIds/sectionTypes 可继续读取`);
            break;
        }
        lines.push(chunk);
        used += chunk.length;
    }
    return lines.join("\n");
}

export async function handleGuide(
    hash: string,
    conversationId: string | undefined,
    recordIds: string[] | undefined,
    scope: RecordManageScope | undefined,
    includeGeneral: boolean | undefined,
    goal: string | undefined,
    maxRecommendations: number | undefined,
    chain: Chain,
    startMs: number,
    options: {
        phaseIds?: Array<string | number>;
        sectionTypes?: RecordSectionType[];
        maxChars?: number;
        format?: RecordReadFormat;
        indexMode?: RecordReaderIndexMode;
        background?: boolean;
        isCancelled?: BackgroundTaskContext["isCancelled"];
        isSettled?: BackgroundTaskContext["isSettled"];
    } = {},
) {
    if (options.background) {
        const task = startBackgroundTask("record-guide", async ({ isCancelled, isSettled }) => {
            const result = await handleGuide(hash, conversationId, recordIds, scope, includeGeneral, goal, maxRecommendations, chain, Date.now(), {
                ...options,
                background: false,
                isCancelled,
                isSettled,
            });
            return responseText(result);
        });
        return rt([
            "🚀 Record guide 已转入后台任务",
            `🆔 taskId: ${task.id}`,
            `🧭 goal: ${goal || "(未提供，输出默认阅读路线)"}`,
            "💡 后续调用 record_manage(action=\"task_status\", taskId=\"...\") 查询结果",
        ].join("\n"), startMs);
    }

    if (options.isCancelled?.() || options.isSettled?.()) {
        return rt("⚠️ Record guide 后台任务已取消/结算，未继续生成阅读建议", startMs);
    }

    const recommendations = await buildRecordGuideRecommendations(hash, scope, includeGeneral === true, {
        conversationId,
        recordIds,
        goal,
        phaseIds: options.phaseIds,
        sectionTypes: options.sectionTypes,
        maxRecommendations,
        indexMode: options.indexMode,
        chain,
    });
    if (options.isCancelled?.() || options.isSettled?.()) {
        return rt("⚠️ Record guide 后台任务已取消/结算，已丢弃生成结果", startMs);
    }
    const payload = {
        goal: goal || null,
        note: "guide 只给阅读路线、搜索路线和来源定位；不生成 Record 事实摘要，也不作为新的事实源。",
        recommendations,
    };
    if (options.format === "json") return rt(JSON.stringify(payload, null, 2), startMs);

    const lines = [
        `🧭 Record guide${goal ? `: ${goal}` : ""}`,
        "说明：这里只给 read/search 建议和来源，不替代正式 Record。",
        "",
    ];
    for (const [index, rec] of recommendations.entries()) {
        const chunk = [
            `${index + 1}. ${rec.type.toUpperCase()} — ${rec.reason}`,
            rec.readHint ? `   readHint=${JSON.stringify(rec.readHint)}` : "",
            rec.searchHint ? `   searchHint=${JSON.stringify(rec.searchHint)}` : "",
            rec.provenance ? `   provenance=${JSON.stringify(rec.provenance)}` : "",
        ].filter(Boolean).join("\n");
        if (options.maxChars && lines.join("\n").length + chunk.length > options.maxChars) {
            lines.push("⚠️ guide 输出已截断，可提高 maxChars 或缩小目标。");
            break;
        }
        lines.push(chunk);
    }
    return rt(lines.join("\n"), startMs);
}

export async function buildRecordGuideRecommendations(
    hash: string,
    scope: RecordManageScope | undefined,
    includeGeneral: boolean,
    options: {
        conversationId?: string;
        recordIds?: string[];
        goal?: string;
        phaseIds?: Array<string | number>;
        sectionTypes?: RecordSectionType[];
        maxRecommendations?: number;
        indexMode?: RecordReaderIndexMode;
        chain?: Chain;
    } = {},
): Promise<RecordGuideRecommendation[]> {
    const max = Math.max(1, Math.min(options.maxRecommendations || 5, 12));
    const ids = options.recordIds?.length ? options.recordIds : (options.conversationId ? [options.conversationId] : undefined);
    const recommendations: RecordGuideRecommendation[] = [];

    if (options.goal) {
        const blocks = await buildStructuredRecordSearchBlocks(hash, scope, includeGeneral, {
            conversationId: options.conversationId,
            recordIds: ids,
            phaseIds: options.phaseIds,
            sectionTypes: options.sectionTypes,
            searchScope: "section",
            indexMode: options.indexMode,
        });
        const results = await search(blocks, options.goal, { mode: "auto", limit: max, chain: options.chain });
        const finalResults = results.length > 0 ? results : await search(blocks, options.goal, { mode: "smart", limit: max, chain: options.chain });
        for (const result of finalResults.slice(0, max)) {
            recommendations.push({
                type: "read",
                reason: `目标与区块匹配：${result.title}`,
                readHint: result.metadata?.readHint,
                searchHint: {
                    action: "search",
                    query: options.goal,
                    conversationId: result.metadata?.recordId,
                    phaseIds: result.metadata?.phaseId ? [result.metadata.phaseId] : undefined,
                    sectionTypes: result.metadata?.sectionType ? [result.metadata.sectionType] : undefined,
                    searchScope: "section",
                },
                provenance: {
                    recordId: result.metadata?.recordId,
                    blockId: result.metadata?.blockId,
                    phaseId: result.metadata?.phaseId,
                    sectionType: result.metadata?.sectionType,
                    lineRange: result.metadata?.lineRange,
                },
            });
        }
    }

    if (recommendations.length === 0) {
        const targets = await collectRecordSearchTargetsAsync(hash, scope, includeGeneral, options.conversationId, ids);
        for (const target of targets) {
            const { index } = await readOrBuildReaderIndex(target.hash, target.conversationId, target.content, options.indexMode || "auto");
            recommendations.push({
                type: "read",
                reason: `先读目录，确认 ${target.title} 的 Phase 与结构入口`,
                readHint: { action: "read", conversationId: target.conversationId, view: "outline", format: "json" },
                provenance: { recordId: target.conversationId, hash: target.hash, phaseCount: index.phases.length, blockCount: index.blocks.length },
            });
            recommendations.push({
                type: "read",
                reason: "再读当前状态与风险，快速判断后续工作入口",
                readHint: { action: "read", conversationId: target.conversationId, view: "state", withCitations: true },
                provenance: { recordId: target.conversationId, hash: target.hash },
            });
            recommendations.push({
                type: "read",
                reason: "需要文件线索时读取产出文件区块",
                readHint: { action: "read", conversationId: target.conversationId, view: "outputs", withCitations: true },
                provenance: { recordId: target.conversationId, hash: target.hash },
            });
            if (recommendations.length >= max) break;
        }
    }

    return recommendations.slice(0, max);
}

export function buildRecordSearchBlocksForScope(hash: string, scope: RecordManageScope | undefined, includeGeneral = false) {
    // 三级搜索：构建 TextBlock 列表
    const blockMap = new Map<string, import("../search-engine.js").TextBlock>();

    const addBlocks = (h: string) => {
        const index = readRecordsIndex(h);
        for (const [convId, entry] of Object.entries(index.records) as [string, any][]) {
            if (isSupersededRecord(h, convId)) continue;
            const content = readRecord(h, convId);
            if (!content) continue;
            const existing = blockMap.get(convId);
            const updatedAt = Date.parse(entry.lastUpdatedAt || "") || 0;
            const existingUpdatedAt = existing ? Number(existing.metadata?.updatedAt || 0) : 0;
            // 同一 conversationId 可能因 workspace hash 变化存在多份 Record，优先保留最新索引。
            if (!existing || updatedAt > existingUpdatedAt || (updatedAt === existingUpdatedAt && content.length > existing.content.length)) {
                blockMap.set(convId, {
                    id: convId,
                    title: entry.title,
                    content,
                    tags: entry.tags || [],
                    metadata: { hash: h, updatedAt },
                });
            }
        }
    };

    for (const h of recordHashesForScope(hash, scope, includeGeneral)) addBlocks(h);
    return Array.from(blockMap.values());
}

async function buildRecordSearchBlocksForScopeAsync(hash: string, scope: RecordManageScope | undefined, includeGeneral = false): Promise<TextBlock[]> {
    const blockMap = new Map<string, TextBlock>();
    const hashes = await recordHashesForScopeAsync(hash, scope, includeGeneral);
    const indexedBlocks = await Promise.all(hashes.map(async recordHash => {
        const index = await readRecordsIndexAsync(recordHash);
        return Promise.all(Object.entries(index.records).map(async ([conversationId, entry]) => {
            if (await isSupersededRecordAsync(recordHash, conversationId)) return null;
            const content = await readRecordAsync(recordHash, conversationId);
            if (!content) return null;
            return { recordHash, conversationId, entry, content };
        }));
    }));
    for (const item of indexedBlocks.flat().filter((entry): entry is { recordHash: string; conversationId: string; entry: Awaited<ReturnType<typeof readRecordsIndexAsync>>["records"][string]; content: string } => Boolean(entry))) {
        const existing = blockMap.get(item.conversationId);
        const updatedAt = Date.parse(item.entry.lastUpdatedAt || "") || 0;
        const existingUpdatedAt = existing ? Number(existing.metadata?.updatedAt || 0) : 0;
        if (!existing || updatedAt > existingUpdatedAt || (updatedAt === existingUpdatedAt && item.content.length > existing.content.length)) {
            blockMap.set(item.conversationId, {
                id: item.conversationId,
                title: item.entry.title,
                content: item.content,
                tags: item.entry.tags || [],
                metadata: { hash: item.recordHash, updatedAt },
            });
        }
    }
    return Array.from(blockMap.values());
}

// ============= ownership audit / repair =============

function collectRecordLocations(hash: string, scope: RecordManageScope | undefined) {
    const hashes = recordHashesForScope(hash, scope, false);
    const locations: Array<{ hash: string; conversationId: string; title: string; totalRounds: number; lastUpdatedRound: number; lastUpdatedAt: string; sizeBytes: number }> = [];
    for (const h of hashes) {
        const index = readRecordsIndex(h);
        for (const entry of Object.values(index.records)) {
            locations.push({
                hash: h,
                conversationId: entry.conversationId,
                title: entry.title,
                totalRounds: entry.totalRounds,
                lastUpdatedRound: entry.lastUpdatedRound,
                lastUpdatedAt: entry.lastUpdatedAt,
                sizeBytes: entry.sizeBytes,
            });
        }
    }
    return locations;
}

function betterRecordLocation<T extends { lastUpdatedAt: string; totalRounds: number; lastUpdatedRound: number; sizeBytes: number }>(items: T[]): T | null {
    return [...items].sort((a, b) => {
        const roundDiff = (b.lastUpdatedRound || b.totalRounds || 0) - (a.lastUpdatedRound || a.totalRounds || 0);
        if (roundDiff !== 0) return roundDiff;
        const updatedDiff = (Date.parse(b.lastUpdatedAt || "") || 0) - (Date.parse(a.lastUpdatedAt || "") || 0);
        if (updatedDiff !== 0) return updatedDiff;
        return (b.sizeBytes || 0) - (a.sizeBytes || 0);
    })[0] || null;
}

function canonicalHashForExistingRecordHash(hash: string): string | null {
    if (hash === "general") return "general";
    const meta = readWorkspaceMeta(hash);
    if (!meta) return null;
    return workspaceHash(meta.canonicalPath || meta.originalPath);
}

function isWorkspacePathAliasHash(currentHash: string, expectedHash: string): boolean {
    if (currentHash === "general" || currentHash === expectedHash) return false;
    return canonicalHashForExistingRecordHash(currentHash) === expectedHash;
}

async function detectOwnershipSource(
    conversationId: string,
    dataChain: DataChain,
    requestClass?: ConcurrencyGateRequestClass,
): Promise<{
    expectedHash?: string;
    expectedWorkspace?: string;
    sourceType: OwnershipSourceType;
    conflict?: string;
}> {
    const sources: Array<{ hash: string; identityHash: string; workspace: string; sourceType: OwnershipSourceType }> = [];
    const allowAntigravity = dataChain === "auto" || dataChain === "antigravity";
    const allowCodex = dataChain === "auto" || dataChain === "codex";
    const allowClaudeCode = dataChain === "auto" || dataChain === "claude-code";
    const allowWindsurf = dataChain === "windsurf";

    if (allowAntigravity) {
        try {
            const steps = await fetchFirstPageSteps(conversationId);
            const workspace = steps ? detectWorkspaceFromSteps(steps) : null;
            if (workspace) sources.push({ workspace, hash: resolveWorkspaceHashForRecord(workspace), identityHash: workspaceHash(workspace), sourceType: "antigravity_workspace_uri" });
        } catch {
            // keep unknown; audit must not fail because one chain is unavailable
        }
    }

    if (allowCodex) {
        try {
            const thread = getCodexThread(conversationId);
            if (thread?.cwd) {
                sources.push({ workspace: thread.cwd, hash: resolveWorkspaceHashForRecord(thread.cwd), identityHash: workspaceHash(thread.cwd), sourceType: "codex_cwd" });
            } else {
                const parent = getCodexParentThread(conversationId);
                if (parent?.cwd) {
                    sources.push({ workspace: parent.cwd, hash: resolveWorkspaceHashForRecord(parent.cwd), identityHash: workspaceHash(parent.cwd), sourceType: "child_parent" });
                }
            }
        } catch {
            // keep unknown; audit must not fail because one chain is unavailable
        }
    }

    if (allowClaudeCode) {
        try {
            const thread = getClaudeCodeThread(conversationId);
            if (thread?.cwd) {
                sources.push({ workspace: thread.cwd, hash: resolveWorkspaceHashForRecord(thread.cwd), identityHash: workspaceHash(thread.cwd), sourceType: "claude_code_cwd" });
            }
        } catch {
            // keep unknown; audit must not fail because one chain is unavailable
        }
    }

    if (allowWindsurf) {
        try {
            const { loadWindsurfConversation } = await import("../windsurf-client.js");
            const conversation = await loadWindsurfConversation(conversationId, false, { requestClass });
            const workspace = conversation?.thread.cwd;
            if (workspace) {
                sources.push({ workspace, hash: resolveWorkspaceHashForRecord(workspace), identityHash: workspaceHash(workspace), sourceType: "windsurf_cwd" });
            }
        } catch {
            // keep unknown; audit must not fail because WSF LS is unavailable
        }
    }

    if (sources.length === 0) return { sourceType: "unknown" };
    const first = sources[0];
    const conflict = sources.find(s => s.identityHash !== first.identityHash);
    if (conflict) {
        return {
            expectedHash: first.hash,
            expectedWorkspace: first.workspace,
            sourceType: first.sourceType,
            conflict: `${first.sourceType}:${first.workspace} vs ${conflict.sourceType}:${conflict.workspace}`,
        };
    }
    return { expectedHash: first.hash, expectedWorkspace: first.workspace, sourceType: first.sourceType };
}

export async function auditRecordOwnership(
    hash: string,
    scope: RecordManageScope | undefined,
    dataChain: DataChain,
    sourceResolver: typeof detectOwnershipSource = detectOwnershipSource,
): Promise<OwnershipAuditItem[]> {
    const locations = collectRecordLocations(hash, scope);
    const byConversation = new Map<string, typeof locations>();
    for (const loc of locations) {
        const group = byConversation.get(loc.conversationId) || [];
        group.push(loc);
        byConversation.set(loc.conversationId, group);
    }

    const items: OwnershipAuditItem[] = [];
    for (const loc of locations) {
        const siblings = byConversation.get(loc.conversationId) || [loc];
        const best = betterRecordLocation(siblings);
        const detected = await sourceResolver(loc.conversationId, dataChain);

        if (detected.conflict) {
            items.push({
                conversationId: loc.conversationId,
                title: loc.title,
                currentHash: loc.hash,
                expectedHash: detected.expectedHash,
                expectedWorkspace: detected.expectedWorkspace,
                sourceType: detected.sourceType,
                status: "conflict",
                reason: `结构来源冲突：${detected.conflict}`,
                suggestedAction: "manualReview",
            });
            continue;
        }

        if (detected.expectedHash) {
            if (loc.hash === detected.expectedHash) {
                items.push({
                    conversationId: loc.conversationId,
                    title: loc.title,
                    currentHash: loc.hash,
                    expectedHash: detected.expectedHash,
                    expectedWorkspace: detected.expectedWorkspace,
                    sourceType: detected.sourceType,
                    status: "ok",
                    reason: "当前位置与结构来源一致",
                    suggestedAction: "keep",
                });
            } else if (loc.hash === "general") {
                const targetSibling = siblings.find(s => s.hash === detected.expectedHash);
                const locIsBest = best?.hash === loc.hash;
                items.push({
                    conversationId: loc.conversationId,
                    title: loc.title,
                    currentHash: loc.hash,
                    expectedHash: detected.expectedHash,
                    expectedWorkspace: detected.expectedWorkspace,
                    sourceType: detected.sourceType,
                    status: targetSibling && !locIsBest ? "duplicate" : "migratable",
                    reason: targetSibling
                        ? "general 中存在副本，目标 workspace 已有同 ID Record"
                        : "general 中 Record 可由结构来源确定目标 workspace",
                    suggestedAction: targetSibling && !locIsBest ? "archiveDuplicate" : "move",
                });
            } else if (isWorkspacePathAliasHash(loc.hash, detected.expectedHash)) {
                const targetSibling = siblings.find(s => s.hash === detected.expectedHash);
                const locIsBest = best?.hash === loc.hash;
                items.push({
                    conversationId: loc.conversationId,
                    title: loc.title,
                    currentHash: loc.hash,
                    expectedHash: detected.expectedHash,
                    expectedWorkspace: detected.expectedWorkspace,
                    sourceType: detected.sourceType,
                    status: !targetSibling || locIsBest ? "migratable" : "duplicate",
                    reason: targetSibling
                        ? "当前 Record 位于同一 workspace 的旧路径别名桶，目标 official workspace 已有同 ID Record"
                        : "当前 Record 位于同一 workspace 的旧路径别名桶，可迁回 official workspace",
                    suggestedAction: !targetSibling || locIsBest ? "move" : "archiveDuplicate",
                });
            } else {
                items.push({
                    conversationId: loc.conversationId,
                    title: loc.title,
                    currentHash: loc.hash,
                    expectedHash: detected.expectedHash,
                    expectedWorkspace: detected.expectedWorkspace,
                    sourceType: detected.sourceType,
                    status: "conflict",
                    reason: "当前位置与结构来源不一致，且不是 general 兜底副本",
                    suggestedAction: "manualReview",
                });
            }
            continue;
        }

        const nonGeneralBest = best?.hash !== "general" ? best : siblings.find(s => s.hash !== "general");
        if (loc.hash === "general" && nonGeneralBest) {
            items.push({
                conversationId: loc.conversationId,
                title: loc.title,
                currentHash: loc.hash,
                expectedHash: nonGeneralBest.hash,
                sourceType: "duplicate",
                status: "duplicate",
                reason: "同 ID 已存在非 general 副本，但无法从结构来源确认真实 workspace",
                suggestedAction: "archiveDuplicate",
            });
        } else {
            items.push({
                conversationId: loc.conversationId,
                title: loc.title,
                currentHash: loc.hash,
                sourceType: "unknown",
                status: "unknown",
                reason: "未找到 workspaceUri、Codex cwd 或 parent/root 派生关系",
                suggestedAction: "keep",
            });
        }
    }
    return items;
}

function summarizeOwnershipAudit(items: OwnershipAuditItem[], title: string): string {
    const counts = items.reduce((map, item) => {
        map.set(item.status, (map.get(item.status) || 0) + 1);
        return map;
    }, new Map<OwnershipStatus, number>());
    const lines = [
        title,
        `📊 ok=${counts.get("ok") || 0} duplicate=${counts.get("duplicate") || 0} migratable=${counts.get("migratable") || 0} conflict=${counts.get("conflict") || 0} unknown=${counts.get("unknown") || 0}`,
        "",
    ];
    for (const item of items.filter(i => i.status !== "ok").slice(0, 20)) {
        lines.push(`- ${item.status} | ${item.conversationId.slice(0, 8)} | ${item.title}`);
        lines.push(`  ${item.currentHash}${item.expectedHash ? ` → ${item.expectedHash}` : ""} | ${item.sourceType} | ${item.suggestedAction}`);
        lines.push(`  ${item.reason}`);
    }
    if (items.filter(i => i.status !== "ok").length > 20) {
        lines.push(`... 另有 ${items.filter(i => i.status !== "ok").length - 20} 条未显示`);
    }
    return lines.join("\n");
}

async function handleAuditOwnership(hash: string, scope: RecordManageScope | undefined, dataChain: DataChain, startMs: number) {
    const items = await auditRecordOwnership(hash, scope || "general", dataChain);
    return rt(summarizeOwnershipAudit(items, "🔎 Record 归属审计（只读）"), startMs);
}

async function handleRepairOwnership(hash: string, scope: RecordManageScope | undefined, dataChain: DataChain, dryRun: boolean, backup: boolean, startMs: number) {
    const { moves } = await planOwnershipRepair(hash, scope || "general", dataChain);
    if (dryRun) {
        return rt(summarizeOwnershipAudit(moves, "🧭 Record 归属修复计划（dry-run，未改文件）"), startMs);
    }

    const lines = [`🛠 Record 归属修复执行（copy/upsert，不删除来源；backup=${backup}）`];
    let moved = 0;
    for (const item of moves) {
        if (!item.expectedHash || !item.expectedWorkspace) continue;
        const ok = await withRecordManagementSingleFlight(item.conversationId, async () => {
            const source = await readRecordAsync(item.currentHash, item.conversationId);
            if (!source) return false;
            ensureWorkspace(item.expectedWorkspace!);
            const stamp = new Date().toISOString();
            return withRecordPersistenceWrite(async () => {
                await runRecordPersistenceTestHook("before_copy", item.conversationId);
                const copied = await copyRecordToHash(item.currentHash, item.expectedHash!, item.conversationId, { lastUpdatedAt: stamp }, { backup });
                if (!copied) return false;
                await writeRecordSidecar(item.currentHash, item.conversationId, RECORD_OWNERSHIP_SIDECAR, {
                    status: "superseded",
                    supersededBy: item.expectedHash,
                    sourceType: item.sourceType,
                    reason: item.reason,
                    updatedAt: stamp,
                });
                return true;
            });
        });
        if (ok) {
            moved++;
            lines.push(`✅ ${item.conversationId.slice(0, 8)} ${item.currentHash} → ${item.expectedHash}`);
        } else {
            lines.push(`❌ ${item.conversationId.slice(0, 8)} 复制失败`);
        }
    }
    if (moved === 0) lines.push("无可自动迁移项");
    lines.push("⚠️ 首版 repair 不删除或归档旧副本；duplicate 清理需后续显式 prune。");
    return rt(lines.join("\n"), startMs);
}

export async function planOwnershipRepair(
    hash: string,
    scope: RecordManageScope | undefined,
    dataChain: DataChain,
    sourceResolver: typeof detectOwnershipSource = detectOwnershipSource,
) {
    const items = await auditRecordOwnership(hash, scope || "general", dataChain, sourceResolver);
    const moves = items.filter(item => item.status === "migratable" && item.expectedHash && item.expectedWorkspace && item.suggestedAction === "move");
    return { items, moves };
}

function unknownChainMigrationWorkspaceHashes(
    hash: string,
    scope: RecordManageScope | undefined,
    includeGeneral: boolean | undefined,
): string[] {
    if (scope === "general") return ["general"];
    if (scope === "global") {
        return [...new Set([
            ...listWorkspaceHashes(),
            ...(includeGeneral ? ["general"] : []),
        ])];
    }
    return [hash];
}

function formatUnknownChainMigrationResult(result: UnknownChainMigrationResult): string {
    if (result.status === "Patched") {
        return `🧭 ${result.recordId}: 可迁移到 ${result.patch.replacement.chain}（patch=${result.patch.patchId.slice(-16)}）`;
    }
    if (result.status === "Conflict") {
        return `⚠️ ${result.recordId}: Conflict，多 host 同时匹配 ${result.matchingHosts.join(", ")}，未改动`;
    }
    if (result.status === "Unresolved") {
        const observations = result.observations
            .map(observation => `${observation.host}=${observation.status}(${observation.reason})`)
            .join("; ");
        return `⚠️ ${result.recordId}: Unresolved，${result.reason}，未改动${observations ? `；evidence: ${observations}` : ""}`;
    }
    if (result.status === "Cancelled") return `🛑 ${result.recordId}: 扫描已取消，未改动`;
    return `⏭ ${result.recordId}: 已有已知 chain，跳过`;
}

async function handleUnknownChainMigration(
    hash: string,
    scope: RecordManageScope | undefined,
    includeGeneral: boolean | undefined,
    apply: boolean | undefined,
    startMs: number,
) {
    const workspaceHashes = unknownChainMigrationWorkspaceHashes(hash, scope, includeGeneral);
    const readers = recordUnknownChainMigrationReaders();
    const lines = [apply === true
        ? "🛠 Unknown-chain 迁移执行（逐条 index revision/hash CAS）"
        : "🔎 Unknown-chain 迁移 dry-run（只读，传 apply=true 才写入）"];
    let inspected = 0;
    let proposed = 0;
    let applied = 0;
    let conflicts = 0;
    let unresolved = 0;

    for (const workspaceHashValue of workspaceHashes) {
        const entries = recordUnknownChainMigrationEntries(workspaceHashValue)
            .filter(entry => entry.chain === "unknown");
        for (const entry of entries) {
            inspected++;
            const result = await inspectUnknownChainMigration(entry, readers);
            if (result.status === "Patched") {
                proposed++;
                if (apply === true) {
                    const outcome = await applyUnknownChainMigrationPatch(workspaceHashValue, result);
                    if (outcome === "applied") {
                        applied++;
                        lines.push(`✅ ${entry.recordId}: chain → ${result.patch.replacement.chain}`);
                        continue;
                    }
                    conflicts++;
                    lines.push(`⚠️ ${entry.recordId}: CAS Conflict，索引在扫描后变化，未改动`);
                    continue;
                }
            } else if (result.status === "Conflict") {
                conflicts++;
            } else if (result.status === "Unresolved") {
                unresolved++;
            }
            lines.push(formatUnknownChainMigrationResult(result));
        }
    }
    lines.push(`📊 inspected=${inspected} proposed=${proposed} applied=${applied} conflict=${conflicts} unresolved=${unresolved}`);
    return rt(lines.join("\n"), startMs);
}

// ============= edit =============

async function withRecordManagementPublicationFenceWithinArtifactLock<Value>(
    hash: string,
    conversationId: string,
    mutationKind: RecordWorkManualMutationKind,
    operation: () => Promise<Value>,
): Promise<Value> {
    const entry = (await readRecordsIndexAsync(hash)).records[conversationId];
    const hintedChain = SOURCE_CHAINS.find(chain => chain === entry?.chain);
    const pathExists = async (filePath: string): Promise<boolean> => {
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
        }
    };
    const discoverRegistryCandidates = async (chains: readonly SourceChain[]) => (await Promise.all(chains.map(async chain => {
        const location = { identity: { chain, workspaceHash: hash, conversationId } };
        const [manifestExists, registryExists] = await Promise.all([
            pathExists(recordWorkIdentityManifestPath(location)),
            pathExists(recordWorkRegistryPath(location)),
        ]);
        return manifestExists || registryExists ? location : null;
    }))).filter((location): location is { identity: { chain: SourceChain; workspaceHash: string; conversationId: string } } => location !== null);
    let location: { identity: { chain: SourceChain; workspaceHash: string; conversationId: string } } | null;
    if (hintedChain) {
        const foreignCandidates = await discoverRegistryCandidates(SOURCE_CHAINS.filter(chain => chain !== hintedChain));
        if (foreignCandidates.length > 0) {
            throw new RecordSchedulerRepairRequiredError(
                `Record 手动修改发现索引宿主 ${hintedChain} 之外的发布注册表: ${foreignCandidates.map(candidate => candidate.identity.chain).join(", ")}`,
            );
        }
        location = { identity: { chain: hintedChain, workspaceHash: hash, conversationId } };
    } else {
        const registryCandidates = await discoverRegistryCandidates(SOURCE_CHAINS);
        if (registryCandidates.length > 1) {
            throw new RecordSchedulerRepairRequiredError(
                `Record 手动修改发现多个宿主发布注册表: ${registryCandidates.map(candidate => candidate.identity.chain).join(", ")}`,
            );
        }
        location = registryCandidates[0] || null;
    }
    if (!location) return operation();
    const mutation = await withRecordWorkManualMutationAuthority({
        ...location,
        mutationKind,
        artifactLockHeld: true,
    }, operation);
    if (mutation.kind === "repair_required") {
        throw new RecordSchedulerRepairRequiredError(
            `Record 手动修改无法安全围栏发布状态: ${mutation.reason} (${mutation.path})`,
        );
    }
    return mutation.value;
}

async function handleEdit(
    hash: string, conversationId: string | undefined,
    content: string | undefined, append: string | undefined, startMs: number,
) {
    if (!conversationId) return rt("❌ edit 需要 conversationId 参数", startMs);
    const resolvedId = resolveRecordConversationId(conversationId, hash) || conversationId;
    return withRecordManagementSingleFlight(resolvedId, async () => {
        const existing = await readRecordAsync(hash, resolvedId);
        if (!existing && !content) return rt(`❌ 未找到 ${conversationId} 的 Record，且未提供 content`, startMs);

        let newContent: string;
        if (content) {
            newContent = content;
        } else if (append) {
            newContent = (existing || "") + "\n\n" + `[手动补充] ${new Date().toISOString().slice(0, 16)}\n\n` + append;
        } else {
            return rt("❌ edit 需要 content 或 append 参数", startMs);
        }

        const phases = countPhasesInRecord(newContent);
        let readerIndexStatus = "rebuilt";
        await withRecordPersistenceWrite(async () => {
            await withRecordCommitArtifactLock(hash, async () => {
                await withRecordManagementPublicationFenceWithinArtifactLock(hash, resolvedId, "manual_edit", async () => {
                    await runRecordPersistenceTestHook("before_write", resolvedId);
                    await writeRecordWithCommitArtifactLockHeld(hash, resolvedId, newContent, { phases });
                    const readerIndex = await buildAndPersistRecordReaderIndex(hash, resolvedId, newContent, {
                        beforeWrite: () => runRecordPersistenceTestHook("before_reader_index", resolvedId),
                    });
                    if (readerIndex.error) {
                        readerIndexStatus = `error: ${readerIndex.error instanceof Error ? readerIndex.error.message : String(readerIndex.error)}`;
                    }
                });
            });
        });
        return rt(`✅ Record ${resolvedId.slice(0, 8)}... 已更新 (${phases} Phase, ${(Buffer.byteLength(newContent) / 1024).toFixed(1)}KB)\n🔎 Reader Index: ${readerIndexStatus}`, startMs);
    });
}

// ============= delete =============

async function handleDelete(hash: string, conversationId: string | undefined, startMs: number) {
    if (!conversationId) {
        // 不传 conversationId → 清空工作区全部 Record
        return await handleBatchDelete(hash, startMs);
    }
    const resolvedId = resolveRecordConversationId(conversationId, hash) || conversationId;
    const deleted = await withRecordManagementSingleFlight(resolvedId, async () => {
        if (!await readRecordAsync(hash, resolvedId)) return false;
        return withRecordPersistenceWrite(async () => {
            return withRecordCommitArtifactLock(hash, async () => {
                return withRecordManagementPublicationFenceWithinArtifactLock(hash, resolvedId, "manual_delete", async () => {
                    return deleteRecordWithCommitArtifactLockHeld(hash, resolvedId);
                });
            });
        });
    });
    if (!deleted) return rt(`❌ 未找到 ${conversationId} 的 Record`, startMs);
    return rt(`✅ Record ${resolvedId.slice(0, 8)}... 已删除`, startMs);
}

// ============= batch_delete =============

async function handleBatchDelete(hash: string, startMs: number) {
    const records = listRecords(hash);
    if (records.length === 0) return rt("📦 该工作区下无 Record", startMs);
    let count = 0;
    for (const rec of records) {
        const deleted = await withRecordManagementSingleFlight(rec.conversationId, async () => {
            if (!await readRecordAsync(hash, rec.conversationId)) return false;
            return withRecordPersistenceWrite(async () => {
                return withRecordCommitArtifactLock(hash, async () => {
                    return withRecordManagementPublicationFenceWithinArtifactLock(hash, rec.conversationId, "manual_delete", async () => {
                        return deleteRecordWithCommitArtifactLockHeld(hash, rec.conversationId);
                    });
                });
            });
        });
        if (!deleted) continue;
        count++;
    }
    return rt(`✅ 已删除 ${count} 份 Record`, startMs);
}

// ============= batch_update（后台模式）=============

interface BatchConversationCandidate {
    id: string;
    workspace?: string;
    workspaceUris?: string[];
    chain: ResolvedConversationChain;
    lastModifiedMs: number;
    stepCount?: number;
}

type BatchCandidateCollectionArgs = {
    after?: string;
    before?: string;
    limit?: number;
    workspace?: string;
    force?: boolean;
    stale_only?: boolean;
};

type BatchCandidateCollectionResult = {
    candidates: FrozenBatchConversationCandidate[];
    emptyReason?: string;
    diagnostics?: RecordBatchCandidateDiagnostics;
};

type BatchCandidateCollector = (
    resolvedChain: ResolvedConversationChain,
    args: BatchCandidateCollectionArgs,
    hash: string,
) => Promise<BatchCandidateCollectionResult>;

let batchCandidateCollectorOverride: BatchCandidateCollector | null = null;

function normalizeWorkspaceForMatch(workspace: string): string {
    return workspace.replace(/\\/g, "/").toLowerCase();
}

function workspaceMatchesFilter(workspace: string | undefined, workspaceFilter: string | undefined): boolean {
    if (!workspaceFilter) return true;
    const target = normalizeWorkspaceForMatch(workspaceFilter);
    const current = normalizeWorkspaceForMatch(workspace || "");
    if (!current) return false;
    return current.includes(target) || target.includes(current);
}

function dedupeBatchConversationCandidates<T extends { id: string }>(candidates: T[]): T[] {
    const seen = new Set<string>();
    return candidates.filter(candidate => {
        if (seen.has(candidate.id)) return false;
        seen.add(candidate.id);
        return true;
    });
}

type RecordBatchCandidateCategory = "stale" | "missing" | "fresh" | "conflict";
type RecordBatchSelectionKind = Exclude<RecordBatchCandidateCategory, "conflict">;

export interface RecordBatchExistingRecord {
    chain?: string;
    lastUpdatedAt?: string;
    totalSteps?: number;
}

export interface RecordBatchCandidateClassification {
    candidate: BatchCandidateSnapshot;
    category: RecordBatchCandidateCategory;
    record?: RecordBatchExistingRecord;
}

export interface RecordBatchCandidateSelection {
    classifications: RecordBatchCandidateClassification[];
    candidates: FrozenBatchConversationCandidate[];
    diagnostics: RecordBatchCandidateDiagnostics;
}

export function effectiveRecordBatchLimit(limit: number | undefined, force: boolean | undefined): number {
    return Math.min(limit ?? (force ? 200 : 10), force ? 200 : 50);
}

export function recordBatchDiscoveryScanLimit(force: boolean | undefined): number {
    return force ? 200 : 50;
}

function isWindsurfRenameOnly(candidate: BatchCandidateSnapshot, record: RecordBatchExistingRecord): boolean {
    return candidate.chain === "windsurf"
        && Number.isInteger(candidate.stepCount)
        && (candidate.stepCount || 0) > 0
        && candidate.stepCount === record.totalSteps;
}

function classifyRecordBatchCandidate(
    candidate: BatchCandidateSnapshot,
    record: RecordBatchExistingRecord | undefined,
): RecordBatchCandidateClassification {
    if (!record) return { candidate, category: "missing" };
    if (record.chain && candidate.chain && record.chain !== candidate.chain) {
        return { candidate, category: "conflict", record };
    }
    const recordUpdatedMs = Date.parse(record.lastUpdatedAt || "");
    const stale = !Number.isFinite(recordUpdatedMs)
        || (candidate.lastModifiedMs > recordUpdatedMs + STALE_THRESHOLD_MS && !isWindsurfRenameOnly(candidate, record));
    return { candidate, category: stale ? "stale" : "fresh", record };
}

export function selectRecordBatchCandidates(
    candidates: BatchCandidateSnapshot[],
    recordsByWorkspaceHash: Record<string, Record<string, RecordBatchExistingRecord>>,
    options: { force?: boolean; stale_only?: boolean; limit?: number; sourceEnumerationLimited?: boolean } = {},
): RecordBatchCandidateSelection {
    const classifications = candidates.map(candidate => classifyRecordBatchCandidate(
        candidate,
        recordsByWorkspaceHash[candidate.workspaceHash]?.[candidate.id],
    ));
    const rank: Record<RecordBatchCandidateCategory, number> = { stale: 0, missing: 1, fresh: 2, conflict: 3 };
    classifications.sort((a, b) => {
        const categoryOrder = rank[a.category] - rank[b.category];
        if (categoryOrder !== 0) return categoryOrder;
        const modifiedOrder = b.candidate.lastModifiedMs - a.candidate.lastModifiedMs;
        return modifiedOrder !== 0 ? modifiedOrder : a.candidate.id.localeCompare(b.candidate.id);
    });
    const eligibleCategories = options.stale_only
        ? new Set<RecordBatchCandidateCategory>(["stale"])
        : options.force
            ? new Set<RecordBatchCandidateCategory>(["stale", "missing", "fresh"])
            : new Set<RecordBatchCandidateCategory>(["stale", "missing"]);
    const eligible = classifications.filter(item => eligibleCategories.has(item.category));
    const selected = eligible.slice(0, effectiveRecordBatchLimit(options.limit, options.force));
    return {
        classifications,
        candidates: selected.map(item => ({
            ...item.candidate,
            selectionKind: item.category as RecordBatchSelectionKind,
            refreshExisting: item.category !== "missing",
        })),
        diagnostics: {
            scanned: classifications.length,
            eligible: eligible.length,
            selected: selected.length,
            truncated: Math.max(0, eligible.length - selected.length),
            conflicts: classifications.filter(item => item.category === "conflict").length,
            sourceEnumerationLimited: options.sourceEnumerationLimited === true,
            workspaceUnresolved: 0,
        },
    };
}

export function recordBatchGenerateForce(candidate: Pick<FrozenBatchConversationCandidate, "refreshExisting">): boolean {
    return candidate.refreshExisting;
}

async function resolveFrozenBatchWorkspace(
    candidate: BatchConversationCandidate,
    resolvedChain: ResolvedConversationChain,
    workspaceFilter: string | undefined,
): Promise<{ workspace: string | null; workspaceUnresolved: boolean }> {
    if (resolvedChain === "antigravity") {
        const steps = await fetchFirstPageSteps(candidate.id);
        const detectedWorkspace = steps ? detectWorkspaceFromSteps(steps) : "";
        if (!detectedWorkspace) return { workspace: null, workspaceUnresolved: true };
        return {
            workspace: resolveBatchCandidateWorkspace(candidate, resolvedChain, workspaceFilter, detectedWorkspace),
            workspaceUnresolved: false,
        };
    }
    return {
        workspace: resolveBatchCandidateWorkspace(candidate, resolvedChain, workspaceFilter),
        workspaceUnresolved: false,
    };
}

export function resolveBatchCandidateWorkspace(
    candidate: Pick<BatchConversationCandidate, "workspace" | "workspaceUris">,
    resolvedChain: ResolvedConversationChain,
    workspaceFilter: string | undefined,
    detectedWorkspace?: string,
): string | null {
    if (resolvedChain === "antigravity") {
        if (!detectedWorkspace) return null;
        return workspaceMatchesFilter(detectedWorkspace, workspaceFilter) ? detectedWorkspace : null;
    }
    const workspaces = resolvedChain === "windsurf"
        ? [candidate.workspace, ...(candidate.workspaceUris || [])]
        : [candidate.workspace];
    const actualWorkspace = workspaces.find(workspace => typeof workspace === "string" && workspaceMatchesFilter(workspace, workspaceFilter));
    return actualWorkspace || null;
}

async function collectBatchConversationCandidates(
    resolvedChain: ResolvedConversationChain,
    args: BatchCandidateCollectionArgs,
    hash: string,
): Promise<BatchCandidateCollectionResult> {
    if (batchCandidateCollectorOverride) {
        const overridden = await batchCandidateCollectorOverride(resolvedChain, args, hash);
        return {
            ...overridden,
            diagnostics: emptyRecordBatchCandidateDiagnostics(overridden.diagnostics),
        };
    }
    const maxLimit = effectiveRecordBatchLimit(args.limit, args.force);
    const sourceEnumerationLimit = maxLimit * (resolvedChain === "antigravity" ? 3 : 5);
    let rawCandidates: BatchConversationCandidate[] = [];
    let sourceEnumerationLimited = false;

    if (resolvedChain === "antigravity") {
        const conversations = listConversationsByMtime({
            after: args.after,
            before: args.before,
            limit: sourceEnumerationLimit,
        });
        if (conversations.length === 0) {
            return {
                candidates: [],
                emptyReason: "📦 无符合条件的对话",
                diagnostics: emptyRecordBatchCandidateDiagnostics(),
            };
        }
        sourceEnumerationLimited = conversations.length >= sourceEnumerationLimit;
        rawCandidates = conversations.map(conv => ({
            id: conv.id,
            chain: "antigravity",
            lastModifiedMs: conv.mtime.getTime(),
        }));
    } else if (resolvedChain === "codex") {
        const afterMs = args.after ? new Date(args.after).getTime() : null;
        const beforeMs = args.before ? new Date(args.before).getTime() : null;
        const threads = listRecentCodexThreads(sourceEnumerationLimit);
        sourceEnumerationLimited = threads.length >= sourceEnumerationLimit;
        rawCandidates = threads
            .filter(thread => {
                if (afterMs !== null && (thread.updatedAtMs || 0) < afterMs) return false;
                if (beforeMs !== null && (thread.updatedAtMs || 0) > beforeMs) return false;
                return workspaceMatchesFilter(thread.cwd, args.workspace);
            })
            .map(thread => ({
                id: thread.id,
                workspace: thread.cwd,
                chain: "codex",
                lastModifiedMs: thread.updatedAtMs || 0,
            }));
        if (rawCandidates.length === 0) {
            return {
                candidates: [],
                emptyReason: "📦 无符合条件的对话",
                diagnostics: emptyRecordBatchCandidateDiagnostics({ sourceEnumerationLimited }),
            };
        }
    } else if (resolvedChain === "claude-code") {
        const { listRecentClaudeCodeThreads } = await import("../claude-code-client.js");
        const afterMs = args.after ? new Date(args.after).getTime() : null;
        const beforeMs = args.before ? new Date(args.before).getTime() : null;
        const threads = listRecentClaudeCodeThreads(sourceEnumerationLimit);
        sourceEnumerationLimited = threads.length >= sourceEnumerationLimit;
        rawCandidates = threads
            .filter(thread => {
                if (afterMs !== null && (thread.updatedAtMs || 0) < afterMs) return false;
                if (beforeMs !== null && (thread.updatedAtMs || 0) > beforeMs) return false;
                return workspaceMatchesFilter(thread.cwd, args.workspace);
            })
            .map(thread => ({
                id: thread.id,
                workspace: thread.cwd,
                chain: "claude-code",
                lastModifiedMs: thread.updatedAtMs || 0,
            }));
        if (rawCandidates.length === 0) {
            return {
                candidates: [],
                emptyReason: "📦 无符合条件的对话",
                diagnostics: emptyRecordBatchCandidateDiagnostics({ sourceEnumerationLimited }),
            };
        }
    } else {
        const { listRecentWindsurfThreads } = await import("../windsurf-client.js");
        const afterMs = args.after ? new Date(args.after).getTime() : null;
        const beforeMs = args.before ? new Date(args.before).getTime() : null;
        const threads = await listRecentWindsurfThreads(sourceEnumerationLimit);
        sourceEnumerationLimited = threads.length >= sourceEnumerationLimit;
        rawCandidates = threads
            .filter(thread => {
                const updatedMs = Date.parse(thread.lastModifiedTime || thread.createdTime || "") || 0;
                if (afterMs !== null && updatedMs < afterMs) return false;
                if (beforeMs !== null && updatedMs > beforeMs) return false;
                return workspaceMatchesFilter(thread.cwd, args.workspace)
                    || (thread.workspaceUris || []).some(workspace => workspaceMatchesFilter(workspace, args.workspace));
            })
            .map(thread => ({
                id: thread.id,
                workspace: thread.cwd,
                workspaceUris: thread.workspaceUris,
                chain: "windsurf",
                lastModifiedMs: Date.parse(thread.lastModifiedTime || thread.createdTime || "") || 0,
                ...(Number.isInteger(thread.stepCount) && thread.stepCount > 0 ? { stepCount: thread.stepCount } : {}),
            }));
        if (rawCandidates.length === 0) {
            return {
                candidates: [],
                emptyReason: "📦 无符合条件的 WSF 对话",
                diagnostics: emptyRecordBatchCandidateDiagnostics({ sourceEnumerationLimited }),
            };
        }
    }

    rawCandidates = dedupeBatchConversationCandidates(rawCandidates);

    const candidateSnapshots: BatchCandidateSnapshot[] = [];
    let workspaceUnresolved = 0;
    for (const candidate of rawCandidates) {
        const resolution = await resolveFrozenBatchWorkspace(candidate, resolvedChain, args.workspace);
        if (!resolution.workspace) {
            if (resolution.workspaceUnresolved) workspaceUnresolved++;
            continue;
        }
        candidateSnapshots.push({
            id: candidate.id,
            workspace: resolution.workspace,
            workspaceHash: resolveWorkspaceHashForRecord(resolution.workspace),
            chain: candidate.chain,
            lastModifiedMs: candidate.lastModifiedMs,
            ...(candidate.stepCount !== undefined ? { stepCount: candidate.stepCount } : {}),
        });
    }

    if (candidateSnapshots.length === 0) {
        const unresolvedSuffix = workspaceUnresolved > 0
            ? `；${workspaceUnresolved} 个 Antigravity 对话 workspace 未解析，已跳过`
            : "";
        return {
            candidates: [],
            emptyReason: `${args.workspace ? `📦 无属于 ${args.workspace} 的对话` : "📦 无符合条件的对话"}${unresolvedSuffix}`,
            diagnostics: emptyRecordBatchCandidateDiagnostics({
                scanned: rawCandidates.length,
                sourceEnumerationLimited,
                workspaceUnresolved,
            }),
        };
    }

    const hashes = [...new Set(candidateSnapshots.map(candidate => candidate.workspaceHash))];
    const indexes = await Promise.all(hashes.map(async workspaceHash => [workspaceHash, await readRecordsIndexAsync(workspaceHash)] as const));
    const recordsByWorkspaceHash: Record<string, Record<string, RecordBatchExistingRecord>> = Object.fromEntries(
        indexes.map(([workspaceHash, index]) => [workspaceHash, index.records]),
    );
    const selection = selectRecordBatchCandidates(candidateSnapshots, recordsByWorkspaceHash, {
        force: args.force,
        stale_only: args.stale_only,
        limit: args.limit,
        sourceEnumerationLimited,
    });
    const diagnostics = {
        ...selection.diagnostics,
        workspaceUnresolved,
    };
    if (selection.candidates.length === 0) {
        const conflictSuffix = diagnostics.conflicts > 0
            ? `；${diagnostics.conflicts} 个来源链路冲突已跳过`
            : "";
        return {
            candidates: [],
            diagnostics,
            emptyReason: `${args.stale_only ? "📦 无 stale Record" : "📦 无可更新的 stale 或 missing 对话"}${conflictSuffix}`,
        };
    }

    return { candidates: selection.candidates, diagnostics };
}

function readyRecordBatchPayload(
    payload: RecordBatchResumePayload,
    candidates: FrozenBatchConversationCandidate[],
    diagnostics?: RecordBatchCandidateDiagnostics,
): RecordBatchReadyResumePayload {
    return {
        kind: "record-batch-update",
        actionName: payload.actionName,
        resumeKey: payload.resumeKey,
        workspaceHash: payload.workspaceHash,
        dataChain: payload.dataChain,
        modelChain: payload.modelChain,
        ...(payload.force !== undefined ? { force: payload.force } : {}),
        ...(payload.stale_only !== undefined ? { stale_only: payload.stale_only } : {}),
        phase: "ready",
        candidates: candidates.map(candidate => normalizeFrozenBatchCandidate(
            candidate,
            payload.dataChain as ResolvedConversationChain,
            payload.workspaceHash,
        )),
        ...(diagnostics ? { diagnostics } : {}),
    };
}

async function prepareRecordBatchPayload(
    payload: RecordBatchResumePayload,
    updateProgress: (progress: BackgroundTaskProgress) => void,
    isCancelled: () => boolean,
    isSettled: () => boolean,
): Promise<{ payload?: RecordBatchReadyResumePayload; result?: string }> {
    if ("candidates" in payload) return { payload };

    const existingLedger = await readRecordBatchLedgerAsync(payload.resumeKey);
    if (existingLedger) {
        return { payload: readyRecordBatchPayload(payload, existingLedger.candidates) };
    }

    updateProgress({
        stage: "batch_prepare",
        current: 0,
        total: effectiveRecordBatchLimit(payload.request.limit, payload.force),
        unit: "个候选",
        detail: `后台准备 ${payload.dataChain} 批量候选`,
    });
    if (isCancelled() || isSettled()) {
        return { result: "🛑 批量更新在候选准备前已取消或结算" };
    }

    const hash = resolveWorkspaceHashForRecord(payload.request.workspace);
    const { candidates, diagnostics, emptyReason } = await collectBatchConversationCandidates(
        payload.dataChain as ResolvedConversationChain,
        { ...payload.request, force: payload.force, stale_only: payload.stale_only },
        hash,
    );
    if (isCancelled() || isSettled()) {
        return { result: "🛑 批量更新在候选准备后已取消或结算" };
    }
    if (candidates.length === 0) {
        const diagnosticText = diagnostics ? `\n  ${formatRecordBatchCandidateDiagnostics(diagnostics)}` : "";
        return { result: `${emptyReason || "📦 无符合条件的对话"}${diagnosticText}` };
    }

    const readyPayload = readyRecordBatchPayload(payload, candidates, diagnostics);
    await ensureRecordBatchLedgerAsync(readyPayload);
    updateProgress({
        stage: "batch_prepare",
        current: candidates.length,
        total: candidates.length,
        unit: "个候选",
        detail: `候选快照已冻结：${candidates.length} 个对话${diagnostics ? `，scanned=${diagnostics.scanned} eligible=${diagnostics.eligible} selected=${diagnostics.selected}` : ""}`,
    });
    return { payload: readyPayload };
}

function buildRecordBatchResultText(
    ledger: RecordBatchResumeLedger,
    total: number,
    elapsedSeconds: number,
    resumeSummary: { hadPriorState: boolean; initialSettledCount: number },
    poolSummary?: RecordUpdatePoolSummary,
    diagnostics?: RecordBatchCandidateDiagnostics,
    grokSummary?: GrokBatchRuntimeSummary,
): string {
    const failedMessages = ledger.failed
        .map(item => `${item.id.slice(0, 8)}: ${item.reason || "unknown"}`);
    const created = ledger.completed.filter(item => item.isNew === true).length;
    const updated = ledger.completed.filter(item => item.isNew === false).length;
    const unclassified = ledger.completed.length - created - updated;
    let out = `📦 批量更新完成\n  ✅ 本 batch 成功: ${ledger.completed.length} 份（新建 ${created} / 更新 ${updated} / 未分类 ${unclassified}）`;
    if (ledger.failed.length > 0) out += `\n  ❌ 失败: ${ledger.failed.length} 份`;
    if (ledger.skipped.length > 0) out += `\n  ⏭ 跳过: ${ledger.skipped.length} 份`;
    if (ledger.inFlight.length > 0) out += `\n  ♻️ 待恢复: ${ledger.inFlight.length} 份（正文、主索引或 Reader Index 尚未全部确认）`;
    if (resumeSummary.hadPriorState) {
        const finalSettledCount = ledger.completed.length + ledger.failed.length + ledger.skipped.length;
        const processedThisRun = Math.max(0, finalSettledCount - resumeSummary.initialSettledCount);
        out += `\n  ♻️ 恢复续跑: 本次处理 ${processedThisRun} 份；以上数字仍为同一 resumeKey 的最终 ledger 总计 ${finalSettledCount}/${total}`;
    }
    if (failedMessages.length > 0) out += `\n  📋 错误: ${failedMessages.join("; ")}`;
    if (poolSummary) {
        const adaptive = getRecordPersistenceConcurrencySnapshot();
        out += `\n  🚦 进程内 AIMD 累计: activePeak=${poolSummary.peakActive} pendingPeak=${poolSummary.peakPending} queueWaitMsMax=${poolSummary.maxQueueWaitMs}ms limit=${adaptive.limit} current=${adaptive.current} max=${adaptive.max} min=${adaptive.min} successes=${adaptive.successes}（成功持久化事务） failures=${adaptive.failures}（拥塞反馈失败；均非本 batch ledger 数字）`;
    }
    if (diagnostics) {
        out += `\n  ${formatRecordBatchCandidateDiagnostics(diagnostics)}`;
    }
    if (grokSummary) {
        const grok = grokSummary.latest;
        out += `\n  🌐 Grok 请求级保护（仅当前 memory-store Node 进程 pid=${grok.pid}）: trafficClass=${grok.trafficClass} batchQueueWaitMsMax=${grokSummary.maxBatchQueueWaitMs} globalQueueWaitMsMax=${grokSummary.maxGlobalQueueWaitMs} queueAttemptsMax=${grokSummary.maxQueueAttempts} batchActive=${grok.batchActive} batchPending=${grok.batchPending} batchLimit=${grok.batchLimit} globalActive=${grok.globalActive} globalPending=${grok.globalPending} globalLimit=${grok.globalLimit} AIMD=${grok.current}/${grok.max} failures=${grok.failures}`;
    }
    out += `\n  📊 总耗时: ${elapsedSeconds.toFixed(0)}s`;
    return out;
}

async function runRecordBatchUpdateFromPayload(
    payload: RecordBatchReadyResumePayload,
    updateProgress: (progress: BackgroundTaskProgress) => void,
    isCancelled: () => boolean,
    isSettled: () => boolean,
    sourceSnapshots?: FrozenRuntimeSourceSet,
    schedulerExecution?: RecordSchedulerBatchExecutionContext,
): Promise<string> {
    const taskStartMs = Date.now();
    const poolSummary: RecordUpdatePoolSummary = {
        peakActive: 0,
        peakPending: 0,
        maxQueueWaitMs: 0,
    };
    let grokSummary: GrokBatchRuntimeSummary | undefined;
    const schedulerManaged = schedulerExecution !== undefined;
    let ledger = schedulerManaged
        ? createEmptyRecordBatchLedger(payload)
        : await ensureRecordBatchLedgerAsync(payload);
    const resumeSummary = {
        hadPriorState: !schedulerManaged && ledger.completed.length + ledger.failed.length + ledger.skipped.length + ledger.inFlight.length > 0,
        initialSettledCount: schedulerManaged ? 0 : ledger.completed.length + ledger.failed.length + ledger.skipped.length,
    };
    if (!schedulerManaged && ledger.inFlight.length > 0) {
        try {
            ledger = await reconcileRecordBatchInFlight(payload, ledger, {
                isCancelled,
                isSettled,
                onProgress: updateProgress,
            });
        } catch (error) {
            if (error instanceof RecordUpdatePoolAbortError || error instanceof RecordSingleFlightAbortError) {
                return `⚠️ ${error.message} | ${formatRecordUpdatePoolDetail(error.snapshot)}`;
            }
            throw error;
        }
    }
    let pending = schedulerManaged
        ? schedulerBatchCandidates(payload, schedulerExecution.frozenSources)
        : pendingRecordBatchCandidates(payload, ledger);
    const total = schedulerManaged ? pending.length : payload.candidates.length;
    let current = "";

    const updateBatchProgress = (detail?: string) => {
        updateProgress({
            stage: "batch_update",
            current: Math.min(ledger.completed.length + ledger.failed.length + ledger.skipped.length, total),
            total,
            unit: "个对话",
            detail: detail || (current ? `当前: ${current}` : undefined),
        });
    };

    updateBatchProgress(
        pending.length === total
            ? `准备批量更新 ${total} 个对话`
            : `恢复批量更新，剩余 ${pending.length}/${total} 个对话待处理`,
    );

    if (pending.length === 0) {
        return buildRecordBatchResultText(ledger, total, (Date.now() - taskStartMs) / 1000, resumeSummary, poolSummary, payload.diagnostics, grokSummary);
    }

    const concurrency = Math.min(getRecordBatchWorkerConcurrency(), pending.length);
    let nextIndex = 0;

    const worker = async (workerId: number) => {
        while (true) {
            if (isCancelled() || isSettled()) break;
            const idx = nextIndex++;
            if (idx >= pending.length) break;

            const candidate = pending[idx];
            current = `${candidate.id.slice(0, 8)}...`;
            updateBatchProgress(`worker ${workerId + 1} 处理 ${current} (${idx + 1}/${pending.length})`);
            let candidateInFlight = false;

            try {
                if (isCancelled() || isSettled()) break;
                const startedAt = Date.now();
                let singleFlightPermit: Awaited<ReturnType<typeof acquireRecordSingleFlightPermit>> | null = null;
                try {
                    const frozenSource = schedulerManaged
                        ? schedulerExecution!.frozenSources.sources.find(source => (
                            source.snapshot.conversationId === candidate.id
                            && source.snapshot.chain === candidate.chain
                            && source.snapshot.workspaceHash === candidate.workspaceHash
                        ))
                        : sourceSnapshots?.sources.find(source => (
                            source.snapshot.conversationId === candidate.id
                            && source.snapshot.chain === candidate.chain
                        ));
                    if (!schedulerManaged && sourceSnapshots && !frozenSource) {
                        const issue = sourceSnapshots.unresolved.find(item => (
                            item.conversationId === candidate.id && item.chain === candidate.chain
                        ));
                        ledger = await updateRecordBatchLedger(
                            payload,
                            "skipped",
                            candidate,
                            `source snapshot unresolved: ${issue?.reason || "durable source snapshot missing"}`,
                        );
                        updateBatchProgress(`跳过 ${current}: source snapshot unresolved`);
                        continue;
                    }
                    if (schedulerManaged && !frozenSource) {
                        throw new RecordSchedulerRepairRequiredError(
                            `scheduler-managed batch 缺少 ${candidate.chain}/${candidate.workspaceHash}/${candidate.id} 的 frozen source`,
                        );
                    }
                    const loaded = frozenSource
                        ? conversationLoadFromFrozenSource(frozenSource)
                        : await loadConversationData(payload.dataChain, candidate.id, {
                            link: "summary",
                            requestClass: "background",
                        });
                    const fetchMs = Date.now() - startedAt;
                    if (!loaded) {
                        ledger = schedulerManaged
                            ? projectRecordBatchOutcomeInMemory(ledger, "skipped", candidate, "无法加载冻结对话")
                            : await updateRecordBatchLedger(payload, "skipped", candidate, "无法加载对话");
                        updateBatchProgress(`跳过 ${current}: 无法加载对话`);
                        continue;
                    }

                    const rounds = loaded.rounds;
                    const parseMs = Date.now() - startedAt - fetchMs;
                    if (rounds.length < 3) {
                        ledger = schedulerManaged
                            ? projectRecordBatchOutcomeInMemory(ledger, "skipped", candidate, "轮次不足")
                            : await updateRecordBatchLedger(payload, "skipped", candidate, "轮次不足");
                        updateBatchProgress(`跳过 ${current}: 轮次不足`);
                        continue;
                    }

                    const totalSteps = loaded.totalSteps;
                    const actualWorkspace = candidate.workspace || "general";
                    const actualHash = frozenSource?.snapshot.workspaceHash || candidate.workspaceHash;
                    if (schedulerManaged && actualHash !== candidate.workspaceHash) {
                        throw new RecordSchedulerRepairRequiredError(
                            `scheduler-managed batch 的 frozen source ${candidate.id} workspaceHash 与候选快照不一致`,
                        );
                    }
                    singleFlightPermit = await acquireRecordSingleFlightPermit(candidate.id, {
                        isCancelled,
                        isSettled,
                        onProgress: updateProgress,
                    });
                    const flashStartedAt = Date.now();
                    const schedulerSession = schedulerManaged && frozenSource
                        ? createSchedulerProductionSession({
                            ...schedulerExecution!,
                            sourceSnapshotId: frozenSource.snapshot.sourceSnapshotId,
                        }, frozenSource)
                        : undefined;
                    if (schedulerManaged && !schedulerSession) {
                        throw new RecordSchedulerRepairRequiredError(`scheduler-managed batch 缺少 ${candidate.id} 的 production session`);
                    }
                    const result = await generateRecord(actualHash, candidate.id, actualWorkspace, rounds, totalSteps, payload.modelChain, {
                        background: true,
                        trafficClass: "record-batch",
                        force: recordBatchGenerateForce(candidate),
                        isCancelled,
                        isSettled,
                        ...(schedulerSession ? {
                            schedulerManagedExecution: true,
                            schedulerModelCall: schedulerSession.schedulerModelCall,
                        } : {}),
                    });
                    const flashMs = Date.now() - flashStartedAt;
                    if (result.grokDiagnostics) {
                        grokSummary = updateGrokBatchRuntimeSummary(grokSummary, result.grokDiagnostics);
                    }
                    if (result.aborted) {
                        updateBatchProgress(`停止 ${current}: ${result.error || "任务已终止"}`);
                        break;
                    }
                    if (!result.success || !result.content) {
                        ledger = schedulerManaged
                            ? projectRecordBatchOutcomeInMemory(ledger, "failed", candidate, result.error || "unknown")
                            : await updateRecordBatchLedger(payload, "failed", candidate, result.error || "unknown");
                        updateBatchProgress(`失败 ${current}: ${result.error || "unknown"}`);
                        continue;
                    }

                    const content = result.content;
                    const oldRecord = await readRecordAsync(actualHash, candidate.id) || "";
                    const gate = validateRecordCandidateForWrite(content, candidate.id, rounds.length, result.coveredRounds || rounds.length, {
                        oldRecord,
                    });
                    if (!gate.ok) {
                        ledger = schedulerManaged
                            ? projectRecordBatchOutcomeInMemory(ledger, "failed", candidate, gate.error)
                            : await updateRecordBatchLedger(payload, "failed", candidate, gate.error);
                        updateBatchProgress(`失败 ${current}: ${gate.error}`);
                        continue;
                    }
                    const phases = countPhasesInRecord(content);
                    const committed = await withRecordUpdateSharedPermit({
                        isCancelled,
                        isSettled,
                        onProgress: updateProgress,
                        waitingStage: "等待 Record 写入许可",
                        acquiredStage: "batch_update",
                        waitingDetail: `worker ${workerId + 1} 等待 ${current} 的写回`,
                        acquiredDetail: `worker ${workerId + 1} 获取 ${current} 的写回许可`,
                    }, async permit => {
                        const abortReason = getRecordTaskAbortReason({ isCancelled, isSettled });
                        if (abortReason) throw new RecordUpdatePoolAbortError(abortReason, permit.snapshot);
                        const existingIndexEntry = (await readRecordsIndexAsync(actualHash)).records[candidate.id];
                        const metadata = completeRecordMetadata({
                            conversationId: candidate.id,
                            content,
                            rounds: rounds.length,
                            totalSteps,
                            coveredRounds: result.coveredRounds || rounds.length,
                            phases,
                            tags: result.tags ?? existingIndexEntry?.tags ?? [],
                            chain: loaded.chainUsed || payload.dataChain || existingIndexEntry?.chain,
                            timeSpan: existingIndexEntry?.timeSpan,
                            coveredRevisionSequence: frozenSource?.snapshot.sourceRevisionSequence,
                        });
                        if (schedulerSession) {
                            const finalized = await finalizeSchedulerLocalRecord(schedulerSession, {
                                content,
                                commit: {
                                    firstPublicationToken: stableFirstPublicationToken(frozenSource!.snapshot),
                                    recordMeta: metadata,
                                    hooks: schedulerRecordPersistenceTestHooks(candidate.id),
                                },
                            });
                            if (finalized.kind === "cancelled") throw new RecordUpdatePoolAbortError("cancelled", permit.snapshot);
                            ledger = projectRecordBatchOutcomeInMemory(ledger, "completed", candidate, undefined, !existingIndexEntry);
                            try {
                                await updateRecordBatchLedger(payload, "completed", candidate, undefined, !existingIndexEntry);
                            } catch (projectionError) {
                                console.error(`[record-batch] legacy ledger projection failed after scheduler Verified commit for ${candidate.id}: ${projectionError instanceof Error ? projectionError.message : String(projectionError)}`);
                            }
                            return true;
                        }
                        ledger = await markRecordBatchCandidateInFlight(payload, candidate, content, metadata, !existingIndexEntry);
                        candidateInFlight = true;
                        await runRecordPersistenceTestHook("before_write", candidate.id);
                        const beforeCommitReason = getRecordTaskAbortReason({ isCancelled, isSettled });
                        if (beforeCommitReason) throw new RecordUpdatePoolAbortError(beforeCommitReason, permit.snapshot);
                        const writeResult = await writeRecord(actualHash, candidate.id, content, metadata, {
                            afterContentWrite: () => runRecordPersistenceTestHook("after_record_body", candidate.id),
                        });
                        await runRecordPersistenceTestHook("after_record_index", candidate.id);
                        const readerIndex = await buildAndPersistRecordReaderIndex(actualHash, candidate.id, content, {
                            beforeWrite: () => runRecordPersistenceTestHook("before_reader_index", candidate.id),
                        });
                        if (readerIndex.error) {
                            throw readerIndex.error;
                        }
                        ledger = await updateRecordBatchLedger(payload, "completed", candidate, undefined, writeResult.outcome === "created");
                        candidateInFlight = false;
                        return true;
                    });
                    updateRecordUpdatePoolSummary(poolSummary, committed.permit.snapshot, committed.permit.queueWaitMs);
                    if (!committed.value) continue;
                    updateBatchProgress(`完成 ${current}: ${((Date.now() - startedAt) / 1000).toFixed(1)}s | ${formatRecordUpdatePoolDetail(committed.permit.snapshot, committed.permit.queueWaitMs)}`);
                    console.error(
                        `[batch-w${workerId + 1}] ✅ ${candidate.id.slice(0, 8)}: fetch=${(fetchMs / 1000).toFixed(1)}s parse=${(parseMs / 1000).toFixed(1)}s flash=${(flashMs / 1000).toFixed(1)}s (${rounds.length}轮/${totalSteps}步) | ${formatRecordUpdatePoolDetail(committed.permit.snapshot, committed.permit.queueWaitMs)}`,
                    );
                } finally {
                    singleFlightPermit?.release();
                }
            } catch (error) {
                if (isBackgroundTaskSuspension(error)) throw error;
                if (error instanceof RecordUpdatePoolAbortError) {
                    updateBatchProgress(`停止 ${current}: ${error.message} | ${formatRecordUpdatePoolDetail(error.snapshot)}`);
                    break;
                }
                if (error instanceof RecordSingleFlightAbortError) {
                    updateBatchProgress(`停止 ${current}: ${error.message} | ${formatRecordUpdatePoolDetail(error.snapshot)}`);
                    break;
                }
                const message = error instanceof Error ? error.message : String(error);
                if (candidateInFlight) {
                    ledger = await ensureRecordBatchLedgerAsync(payload);
                    updateBatchProgress(`待恢复 ${current}: ${message}`);
                } else {
                    ledger = schedulerManaged
                        ? projectRecordBatchOutcomeInMemory(ledger, "failed", candidate, message)
                        : await updateRecordBatchLedger(payload, "failed", candidate, message);
                    updateBatchProgress(`失败 ${current}: ${message}`);
                }
            }
        }
    };

    const workerSettlements = await Promise.allSettled(
        Array.from({ length: concurrency }, (_, index) => worker(index)),
    );
    const rejectedWorker = workerSettlements.find(
        (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
    );
    if (rejectedWorker) throw rejectedWorker.reason;

    if (!schedulerManaged) {
        ledger = await ensureRecordBatchLedgerAsync(payload);
        pending = pendingRecordBatchCandidates(payload, ledger);
    }
    const out = buildRecordBatchResultText(ledger, total, (Date.now() - taskStartMs) / 1000, resumeSummary, poolSummary, payload.diagnostics, grokSummary);
    console.error(`[batch] ${out}`);
    return out;
}

interface ReadonlySchedulerBatchCandidate {
    readonly source: {
        readonly host: SourceEvidenceHost;
        readonly identity: {
            readonly conversationId: string;
            readonly workspace: { readonly workspaceId: string; readonly canonicalPath: string | null };
        };
    };
    readonly sourceRevision: { readonly sequence: number | null } | null;
    readonly discoveredAtSequence: number;
    readonly classification: string;
}

interface ReadonlySchedulerBatchSnapshot {
    readonly candidates: readonly { readonly classification: string }[];
    readonly sourceEnumerations: readonly {
        readonly evidence: { readonly pagination: { readonly truncated: boolean } };
    }[];
}

function recordBatchReadyPayloadFromScheduler(
    payload: RecordBatchPreparingResumePayload,
    snapshot: ReadonlySchedulerBatchSnapshot,
    candidates: readonly ReadonlySchedulerBatchCandidate[],
    frozenSources: FrozenRuntimeSourceSet,
): RecordBatchReadyResumePayload {
    if (frozenSources.phase !== "sealed") {
        throw new RecordBatchLedgerRepairRequiredError(payload.resumeKey, "scheduler source materialization 尚未 sealed");
    }
    const selectedKeys = new Set([
        ...frozenSources.sources.map(source => frozenRuntimeSourceKey(source.snapshot)),
        ...frozenSources.unresolved.map(source => `${source.chain}\u0000${source.workspaceHash}\u0000${source.conversationId}`),
    ]);
    const selected = candidates.filter(candidate => selectedKeys.has(frozenRuntimeSourceKey({
        chain: candidate.source.host,
        workspaceHash: candidate.source.identity.workspace.workspaceId,
        conversationId: candidate.source.identity.conversationId,
    })));
    if (selected.length !== frozenSources.selectedCount || selectedKeys.size !== frozenSources.selectedCount) {
        throw new RecordBatchLedgerRepairRequiredError(payload.resumeKey, "scheduler frozen source set 与 CandidateSnapshot selected set 不一致");
    }
    const ready = recordBatchReadyPayloadFromSelectedCandidates(payload, snapshot, selected);
    return {
        ...ready,
        diagnostics: {
            scanned: snapshot.candidates.length,
            eligible: candidates.length,
            selected: selected.length,
            truncated: Math.max(0, candidates.length - selected.length),
            conflicts: snapshot.candidates.filter(candidate => candidate.classification === "Conflict").length,
            sourceEnumerationLimited: snapshot.sourceEnumerations.some(envelope => envelope.evidence.pagination.truncated),
            workspaceUnresolved: 0,
        },
        ...(frozenSources.selectionHash ? { sourceSelectionHash: frozenSources.selectionHash } : {}),
    };
}

function recordBatchReadyPayloadFromSelectedCandidates(
    payload: RecordBatchPreparingResumePayload,
    snapshot: ReadonlySchedulerBatchSnapshot,
    selected: readonly ReadonlySchedulerBatchCandidate[],
): RecordBatchReadyResumePayload {
    const frozen = selected.map((candidate): FrozenBatchConversationCandidate => {
        const workspace = candidate.source.identity.workspace.canonicalPath || payload.request.workspace;
        if (!workspace) {
            throw new RecordBatchLedgerRepairRequiredError(
                payload.resumeKey,
                `scheduler 候选 ${candidate.source.identity.conversationId} 缺少可执行 workspace`,
            );
        }
        let selectionKind: RecordBatchSelectionKind;
        if (candidate.classification === "Stale") selectionKind = "stale";
        else if (candidate.classification === "Missing") selectionKind = "missing";
        else if (candidate.classification === "Fresh") selectionKind = "fresh";
        else {
            throw new RecordBatchLedgerRepairRequiredError(
                payload.resumeKey,
                `scheduler 候选 ${candidate.source.identity.conversationId} 状态 ${candidate.classification} 不可执行`,
            );
        }
        return {
            id: candidate.source.identity.conversationId,
            workspace,
            workspaceHash: candidate.source.identity.workspace.workspaceId,
            chain: candidate.source.host,
            lastModifiedMs: Math.max(0, candidate.sourceRevision?.sequence ?? candidate.discoveredAtSequence),
            selectionKind,
            refreshExisting: selectionKind !== "missing",
        };
    });
    return {
        ...readyRecordBatchPayload(payload, frozen, {
            scanned: snapshot.candidates.length,
            eligible: selected.length,
            selected: frozen.length,
            truncated: 0,
            conflicts: snapshot.candidates.filter(candidate => candidate.classification === "Conflict").length,
            sourceEnumerationLimited: snapshot.sourceEnumerations.some(envelope => envelope.evidence.pagination.truncated),
            workspaceUnresolved: 0,
        }),
    };
}

function schedulerLegacyBatchStateValidator(
    payload: RecordBatchPreparingResumePayload,
    selector: "normal" | "force" | "stale_only",
): (snapshot?: ReadonlySchedulerBatchSnapshot) => Promise<void> {
    return async snapshot => {
        if (!snapshot) throw new RecordBatchLedgerRepairRequiredError(payload.resumeKey, "scheduler legacy boundary 缺少 CandidateSnapshot");
        const selected = getRecordSchedulerRuntime().selectDiscoveryCandidates(snapshot as never, selector) as readonly ReadonlySchedulerBatchCandidate[];
        await validateLegacyRecordBatchLedgerForScheduler(recordBatchReadyPayloadFromSelectedCandidates(payload, snapshot, selected));
    };
}

async function handleBatchUpdate(
    _hash: string,
    args: { action?: string; after?: string; before?: string; limit?: number; force?: boolean; stale_only?: boolean; workspace?: string; waitSeconds?: number; background?: boolean; chain?: ChainInput | DataChainInput; dataChain?: DataChainInput; modelChain?: ChainInput },
    startMs: number,
) {
    await waitForRecordMutationReadiness();
    const actionName: "batch_update" | "bulk_update" = args.action === "bulk_update" ? "bulk_update" : "batch_update";
    const batchChains = resolveChainSplit({ chain: args.chain, dataChain: args.dataChain, modelChain: args.modelChain });
    const requestedDataChain = batchChains.dataChain;
    const requestedModelChain = batchChains.modelChain;
    const resolvedChain = await resolveConversationChain(requestedDataChain);
    if (!resolvedChain) {
        return rt(`❌ 指定 dataChain ${requestedDataChain} 当前不可用`, startMs);
    }

    const request = {
        ...(args.after !== undefined ? { after: args.after } : {}),
        ...(args.before !== undefined ? { before: args.before } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
    };
    const requestSummary = {
        operation: "record-batch-update",
        actionName,
        workspaceHash: _hash,
        dataChain: resolvedChain,
        modelChain: requestedModelChain,
        force: args.force === true,
        staleOnly: args.stale_only === true,
        request,
    };
    const requestKey = recordSchedulerRequestKey("record-batch-update", requestSummary);
    const resumePayload: RecordBatchPreparingResumePayload = {
        kind: "record-batch-update",
        actionName,
        resumeKey: `scheduler-${requestKey.slice("record-batch-update:".length)}`,
        workspaceHash: _hash,
        dataChain: resolvedChain,
        modelChain: requestedModelChain,
        ...(args.force !== undefined ? { force: args.force } : {}),
        ...(args.stale_only !== undefined ? { stale_only: args.stale_only } : {}),
        phase: "preparing",
        request,
    };
    const runtime = getRecordSchedulerRuntime();
    const discoveryRequest = buildRecordSchedulerDiscoveryRequest({
        kind: "record-batch-update",
        selector: args.stale_only ? "stale_only" : args.force ? "force" : "normal",
        hash: _hash,
        workspace: args.workspace,
        dataChain: requestedDataChain,
        limit: recordBatchDiscoveryScanLimit(args.force),
        selectionLimit: effectiveRecordBatchLimit(args.limit, args.force),
        after: args.after,
        before: args.before,
    });
    const admission = await runtime.admit({
        kind: "record-batch-update",
        requestKey,
        requestSummary,
        resumePayload,
        requestMode: args.stale_only ? "stale_only" : args.force ? "force" : "normal",
        backgroundProjection: { background: args.background !== false, actionName },
        replayTerminal: false,
        discovery: discoveryRequest,
        validateLegacyState: schedulerLegacyBatchStateValidator(
            resumePayload,
            args.stale_only ? "stale_only" : args.force ? "force" : "normal",
        ),
        execute: async ({ taskId, updateProgress, isCancelled, isSettled }, discovery, sourceSnapshots) => {
            if (!sourceSnapshots || sourceSnapshots.phase !== "sealed" || !discovery) {
                throw new RecordSchedulerRepairRequiredError("scheduler-managed batch 缺少 sealed frozen source set");
            }
            const readyResumePayload = recordBatchReadyPayloadFromScheduler(
                resumePayload,
                discovery,
                runtime.selectDiscoveryCandidates(discovery, discoveryRequest.selector),
                sourceSnapshots,
            );
            return runRecordBatchUpdateFromPayload(readyResumePayload, updateProgress, isCancelled, isSettled, sourceSnapshots, {
                taskId,
                frozenSources: sourceSnapshots,
                runtime,
            });
        },
    });
    if (admission.outcome === "UnknownOutcome") {
        return rt([
            `⚠️ ${actionName} scheduler 接纳结果未确定，未返回成功 taskId`,
            `候选 ledger: ${admission.candidateTaskIds.join(", ") || "无"}`,
            `原因: ${admission.reasons.join("; ") || "未知"}`,
        ].join("\n"), startMs);
    }
    if (args.background === false) {
        const status = await runtime.waitForTerminal(admission.taskId);
        const persistedTask = await waitForBackgroundTask(admission.taskId, 1);
        return rt(persistedTask?.result || formatRecordSchedulerTaskStatus(status, persistedTask?.error), startMs);
    }
    return rt([
        `🚀 ${actionName} 已由 Record scheduler 接纳（候选、来源与提交均由 scheduler ledger 驱动）`,
        `🆔 taskId: ${admission.taskId}`,
        `🔗 dataChain: ${resolvedChain}`,
        `🤖 modelChain: ${requestedModelChain}`,
        `🧷 resumeKey: ${resumePayload.resumeKey}`,
        "💡 后续调用 record_manage(action=\"task_status\", taskId=\"...\") 查询账本状态",
    ].join("\n"), startMs);
}

// ============= 辅助 =============

function extractTitle(content: string): string | null {
    const match = content.match(/^# Record[:：]\s*(.+)$/m);
    return match ? match[1].trim() : null;
}
