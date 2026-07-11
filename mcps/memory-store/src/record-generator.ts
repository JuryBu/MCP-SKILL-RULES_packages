import fs from "fs";
import { formatRound, type ConversationRound } from "./trajectory.js";
import {
    readRecordAsync, readRecordsIndex, readRecordsIndexAsync,
    type RecordIndexEntry,
} from "./record-store.js";
import { callModelResponse, resolveModelChainCandidates, type ModelBridgeResult } from "./model-bridge.js";
import type { Chain } from "./chain.js";
import { saveTempFile } from "./temp-store.js";
import { mapGrokModel, type GrokExecDiagnostics } from "./grok-client.js";
import { FifoConcurrencyGate, type ConcurrencyGatePermit } from "./concurrency-gate.js";

/**
 * Record 生成引擎
 *
 * 调用 Flash 模型基于对话内容生成/更新对话记录（Record）。
 * 支持分批生成：超长对话自动分批，已有 Record 作为前文摘要回填。
 *
 * v1.8 新增
 *
 * 注：E2-B2 已将本文件按子域拆分到 record-types / record-config / record-prompts /
 * record-checkpoint / record-parse；本文件保留核心编排，并通过下方 re-export 维持
 * 既有外部 import 路径（`from "./record-generator.js"`）的向后兼容。
 */

// ===== 子模块 re-export（barrel，保持外部 import 路径不变）=====
export * from "./record-types.js";
export * from "./record-config.js";
export * from "./record-prompts.js";
export * from "./record-checkpoint.js";
export * from "./record-parse.js";

// ===== 本模块内部使用的子模块符号 import =====
import {
    FLASH_MODEL, MAX_PROMPT_CHARS, CODEX_RECORD_MAX_PROMPT_CHARS, CODEX_RECORD_CONTEXT_CHARS,
    GROK_RECORD_MAX_PROMPT_CHARS,
    PROMPT_TEMPLATE_OVERHEAD, MIN_BATCH_ROUNDS, RECORD_AUTO_THRESHOLD,
    CODEX_RECORD_TIMEOUT_MS, CODEX_RECORD_BACKGROUND_TIMEOUT_MS, RECORD_MODEL_TIMEOUT_MS, GROK_RECORD_TIMEOUT_MS,
    RECORD_PROGRESS_HEARTBEAT_MS, CODEX_RECORD_RETRY_DELAY_MS,
    CC_RECORD_MAX_PROMPT_CHARS, CC_RECORD_CONTEXT_CHARS, CC_RECORD_TIMEOUT_MS, CC_RECORD_BACKGROUND_TIMEOUT_MS,
    RECORD_PARALLEL_MODE, RECORD_PARALLEL_CONCURRENCY, RECORD_PARALLEL_RETRIES,
    RECORD_PARALLEL_CHUNK_CHARS, RECORD_PARALLEL_DENSE_TOOL_THRESHOLD, RECORD_PARALLEL_DENSE_TOOL_CHUNK_CHARS,
    RECORD_REDUCE_DIRECT_PATCH_LIMIT, RECORD_REDUCE_GROUP_SIZE, RECORD_REDUCE_GROUP_CHARS, RECORD_REDUCE_MAX_LEVELS,
    isLocalComposeEnabled, RECORD_FORCE_FULL_REBUILD,
    RECORD_COMPOSE_MIN_SIZE_RATIO,
    RECORD_PARALLEL_SINGLE_CHUNK_RECORD_CHARS, RECORD_ADJACENT_CONTEXT_ROUNDS, RECORD_ADJACENT_CONTEXT_CHARS,
    RECORD_COMPOSE_SERIAL_THRESHOLD_CHARS, RECORD_COMPOSE_SERIAL_WINDOW_CHARS,
    RECORD_COMPOSE_SERIAL_WINDOW_PATCHES, RECORD_COMPOSE_SERIAL_WINDOW_ROUNDS, RECORD_COMPOSE_SERIAL_THRESHOLD_ROUNDS,
    RECORD_SERIAL_OPEN_PHASE_CONTEXT_CHARS, RECORD_MAX_SINGLE_ROUND_CHARS, RECORD_ROUND_SPLIT_PART_CHARS,
    charCount, roundRangeLabel, patchRangeLabel,
} from "./record-config.js";
import type {
    RecordModelCallResult, FormattedRecordRound, RecordChunk, RecordPatch, RecordParallelMode,
    ParsedRecordDocument, LocalComposeBoundary, LocalComposeDelta, RoundSplitPart,
    SerialComposeAccumulator, SerialStepDelta, GenerateRecordResult, GenerateRecordOptions,
    RecordCheckpointScope,
} from "./record-types.js";
import {
    RecordGenerationAbortedError,
    isRecordGenerationAbortedError,
} from "./record-types.js";
import {
    buildNewRecordPrompt, buildUpdateRecordPrompt, buildRecordPatchPrompt, buildReduceRecordPrompt,
    buildCompressRecordPatchesPrompt, buildLocalComposePrompt, buildLocalComposeRepairPrompt,
    buildRoundPartCompressionPrompt, buildSerialComposeStepPrompt, buildSerialComposeTailPrompt,
    summarizeClosedPhasesOutline,
} from "./record-prompts.js";
import {
    readRecordPatchCheckpointAsync, writeRecordPatchCheckpointAsync,
} from "./record-checkpoint.js";
import { RECORD_ANTIGRAVITY_LS_MODEL } from "./ls-model-defaults.js";
import {
    parseRecordPatchResponse, normalizeCanonicalRecordLanguage, parseRecordDocument,
    selectLocalComposeBoundary, parseLocalComposeResponse, enforceRecordHeaderMetadata,
    composeRecordLocally, validateComposedRecord, validateRecordCandidateForWrite,
    validateRecordBeforeAccept, inferCoveredRoundFromRecord, extractRecordTitle, inferRecordTotalRounds,
    salvagePhasesFromTruncatedJson, parseSerialComposeStep, parseSerialComposeTail,
    rewritePhaseRoundsLabel, relabelSerialPhaseMarkdown, buildOpenPhaseSnippet,
    cleanFlashResponse, countPhasesInRecord,
} from "./record-parse.js";

function codexRecordFailureHint(detail: string): string {
    return `${detail}；Codex 完整超时不会自动重试，如需保留 Codex 对话数据源，可改用 dataChain=codex, modelChain=antigravity 重新更新 Record`;
}

function localBridgeRecordFailureHint(modelChain: Chain, detail: string): string {
    if (modelChain === "codex") {
        const message = detail.includes("Codex") ? detail : `Codex ${detail}`;
        return codexRecordFailureHint(message);
    }
    if (modelChain === "claude-code") {
        const message = detail.includes("Claude Code") ? detail : `Claude Code CLI ${detail}`;
        return `${message}；Claude Code CLI 完整超时不会自动重试，如需保留 Claude Code 对话数据源，可改用 dataChain=claude-code, modelChain=antigravity 重新更新 Record`;
    }
    return detail;
}

function recordChainLabel(modelChain: Chain): string {
    if (modelChain === "grok") return "Grok";
    if (modelChain === "antigravity") return "Antigravity";
    if (modelChain === "codex") return "Codex";
    if (modelChain === "claude-code") return "Claude Code CLI";
    return "自动链路";
}

function recordFailureSubject(modelChain: Exclude<Chain, "auto">): string {
    if (modelChain === "codex") return "Codex Record 模型桥";
    if (modelChain === "claude-code") return "Claude Code CLI Record 模型桥";
    if (modelChain === "grok") return "Grok Record 模型";
    return "Antigravity Record 模型";
}

function autoRecordFailurePrefix(actualChain: Chain | null): string {
    if (actualChain && actualChain !== "auto") {
        return `自动链路全部失败（最后尝试 ${recordChainLabel(actualChain)}）`;
    }
    return "自动链路全部失败";
}

function isLocalTextModelBridge(modelChain: Chain): boolean {
    return modelChain === "codex" || modelChain === "claude-code";
}

type RecordModelFailureMeta = {
    requestedChain: Chain;
    actualChain: Chain | null;
};

type RecordRuntimeOptions = GenerateRecordOptions & {
    __modelChainsUsed?: Set<Chain>;
    __modelModelsUsed?: Set<string>;
    __recordModelScope?: RecordModelScope;
    __lastRecordModelFailure?: RecordModelFailureMeta | null;
    __grokDiagnostics?: GrokExecDiagnostics;
};

function captureGrokDiagnostics(response: Pick<ModelBridgeResult, "grokDiagnostics">, options: GenerateRecordOptions): void {
    if (response.grokDiagnostics) {
        (options as RecordRuntimeOptions).__grokDiagnostics = response.grokDiagnostics;
    }
}

function setLastRecordModelFailure(
    requestedChain: Chain,
    actualChain: Chain | null,
    options: GenerateRecordOptions = {},
): void {
    const runtimeOptions = options as RecordRuntimeOptions;
    runtimeOptions.__lastRecordModelFailure = { requestedChain, actualChain };
}

function clearLastRecordModelFailure(options: GenerateRecordOptions = {}): void {
    const runtimeOptions = options as RecordRuntimeOptions;
    runtimeOptions.__lastRecordModelFailure = null;
}

function getLastRecordModelFailureActualChain(
    requestedChain: Chain,
    options: GenerateRecordOptions = {},
): Chain | null {
    const runtimeOptions = options as RecordRuntimeOptions;
    if (runtimeOptions.__lastRecordModelFailure?.requestedChain === requestedChain) {
        return runtimeOptions.__lastRecordModelFailure.actualChain;
    }
    return requestedChain === "auto" ? null : requestedChain;
}

function formatRecordFailureMessage(
    requestedChain: Chain,
    detail: string,
    options: GenerateRecordOptions = {},
): string {
    if (requestedChain === "auto") {
        return `${autoRecordFailurePrefix(getLastRecordModelFailureActualChain(requestedChain, options))}：${detail}`;
    }
    if (isLocalTextModelBridge(requestedChain)) {
        if (detail === "Record 模型调用失败或超时") {
            return localBridgeRecordFailureHint(requestedChain, `${recordFailureSubject(requestedChain)}调用失败或超时`);
        }
        if (detail.startsWith("在第 ")) {
            return localBridgeRecordFailureHint(requestedChain, `${recordFailureSubject(requestedChain)}${detail}`);
        }
        return localBridgeRecordFailureHint(requestedChain, detail);
    }
    return `${recordFailureSubject(requestedChain)}：${detail}`;
}

function formatRecordBatchFailureMessage(
    requestedChain: Chain,
    batchCount: number,
    coveredRound: number,
    options: GenerateRecordOptions = {},
): string {
    if (requestedChain === "auto") {
        return `${autoRecordFailurePrefix(getLastRecordModelFailureActualChain(requestedChain, options))}：第 ${batchCount} 批失败，Record 仅覆盖到第 ${coveredRound} 轮`;
    }
    return `${recordFailureSubject(requestedChain as Exclude<Chain, "auto">)}在第 ${batchCount} 批失败，Record 仅覆盖到第 ${coveredRound} 轮`;
}

export type RecordModelScope = RecordCheckpointScope & {
    timeoutMs: number;
};

const RECORD_GROK_CONTEXT = "record" as const;

function recordModelBridgeOptions(options: GenerateRecordOptions = {}) {
    return {
        allowClaudeCodeFallback: options.allowClaudeCodeFallback,
        grokContext: RECORD_GROK_CONTEXT,
        trafficClass: options.trafficClass,
        antigravityModelOverride: RECORD_ANTIGRAVITY_LS_MODEL,
        shouldCancel: () => Boolean(options.isCancelled?.() || options.isSettled?.()),
    };
}

function recordModelNameForChain(modelChain: Chain): string {
    if (modelChain === "grok") return mapGrokModel(FLASH_MODEL, RECORD_GROK_CONTEXT);
    if (modelChain === "antigravity") return RECORD_ANTIGRAVITY_LS_MODEL;
    return FLASH_MODEL;
}

function recordTimeoutForChain(modelChain: Chain): number {
    if (modelChain === "grok") return GROK_RECORD_TIMEOUT_MS;
    return RECORD_MODEL_TIMEOUT_MS;
}

function getRecordCallTimeout(modelChain: Chain, requestedTimeout: number, options: GenerateRecordOptions = {}): number {
    const baseTimeout = requestedTimeout === RECORD_MODEL_TIMEOUT_MS
        ? recordTimeoutForChain(modelChain)
        : requestedTimeout;
    if (!isLocalTextModelBridge(modelChain)) {
        return baseTimeout;
    }
    const localTimeoutLimit = modelChain === "claude-code"
        ? (options.background ? CC_RECORD_BACKGROUND_TIMEOUT_MS : CC_RECORD_TIMEOUT_MS)
        : (options.background ? CODEX_RECORD_BACKGROUND_TIMEOUT_MS : CODEX_RECORD_TIMEOUT_MS);
    return options.background
        ? Math.max(1, localTimeoutLimit)
        : Math.max(1, Math.min(baseTimeout, localTimeoutLimit));
}

function fallbackRecordModelScope(requestedChain: Chain, modelChain: Chain = requestedChain): RecordModelScope {
    return {
        requestedChain,
        modelChain,
        modelName: recordModelNameForChain(modelChain),
        grokContext: RECORD_GROK_CONTEXT,
        timeoutMs: recordTimeoutForChain(modelChain),
    };
}

export async function resolveRecordModelScope(
    requestedChain: Chain,
    options: GenerateRecordOptions = {},
): Promise<RecordModelScope> {
    const runtimeOptions = options as RecordRuntimeOptions;
    if (runtimeOptions.__recordModelScope?.requestedChain === requestedChain) {
        return runtimeOptions.__recordModelScope;
    }
    const candidates = requestedChain === "auto"
        ? await resolveModelChainCandidates(requestedChain, recordModelBridgeOptions(options))
        : [];
    const modelChain = candidates[0] || requestedChain;
    const scope = fallbackRecordModelScope(requestedChain, modelChain);
    runtimeOptions.__recordModelScope = scope;
    return scope;
}

function getCachedRecordModelScope(
    requestedChain: Chain,
    options: GenerateRecordOptions = {},
): RecordModelScope | null {
    const runtimeOptions = options as RecordRuntimeOptions;
    if (runtimeOptions.__recordModelScope?.requestedChain === requestedChain) {
        return runtimeOptions.__recordModelScope;
    }
    if (requestedChain === "auto") return null;
    return fallbackRecordModelScope(requestedChain);
}

function checkpointScopeFromResponse(
    requestedChain: Chain,
    response: Pick<RecordModelCallResult, "chainUsed" | "modelUsed">,
    options: GenerateRecordOptions = {},
): RecordCheckpointScope {
    const fallbackScope = getCachedRecordModelScope(requestedChain, options) || fallbackRecordModelScope(requestedChain);
    const modelChain = response.chainUsed || fallbackScope.modelChain;
    return {
        requestedChain,
        modelChain,
        modelName: response.modelUsed || recordModelNameForChain(modelChain) || fallbackScope.modelName,
        grokContext: RECORD_GROK_CONTEXT,
    };
}

function reportRecordModelSuccess(
    requestedChain: Chain,
    result: Pick<RecordModelCallResult, "chainUsed" | "modelUsed">,
    options: GenerateRecordOptions = {},
): void {
    clearLastRecordModelFailure(options);
    const actualChain = result.chainUsed || "unknown";
    const actualModel = result.modelUsed || "unknown";
    const runtimeOptions = options as RecordRuntimeOptions;
    if (result.chainUsed) {
        runtimeOptions.__modelChainsUsed ??= new Set();
        runtimeOptions.__modelChainsUsed.add(result.chainUsed);
    }
    if (result.modelUsed) {
        runtimeOptions.__modelModelsUsed ??= new Set();
        runtimeOptions.__modelModelsUsed.add(result.modelUsed);
    }
    console.error(`[record-generator] Record model call success requestedChain=${requestedChain} actualChain=${actualChain} actualModel=${actualModel} grokContext=record`);
    options.onProgress?.({
        stage: "模型链路",
        detail: `Record 模型调用成功：requested=${requestedChain}, actual=${actualChain}, model=${actualModel}, grokContext=record`,
    });
}

function getRecordAbortReason(options: GenerateRecordOptions = {}): "cancelled" | "settled" | null {
    if (options.isCancelled?.()) return "cancelled";
    if (options.isSettled?.()) return "settled";
    return null;
}

function throwIfRecordRunAborted(options: GenerateRecordOptions = {}, detail = "停止后续 Record 生成"): void {
    const reason = getRecordAbortReason(options);
    if (!reason) return;
    throw new RecordGenerationAbortedError(
        reason,
        reason === "cancelled"
            ? `Record 更新已取消：${detail}`
            : `后台任务已结算：${detail}`,
    );
}

function readPositiveIntEnv(name: string, fallback: number): number {
    const raw = Number(process.env[name] || "");
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

const RECORD_GENERATION_QUEUE_TIMEOUT_MS = 30 * 60_000;
const recordGenerationGate = new FifoConcurrencyGate(() => readPositiveIntEnv("MEMORY_STORE_RECORD_GENERATION_CONCURRENCY", 8));

async function acquireRecordGenerationPermit(options: GenerateRecordOptions): Promise<ConcurrencyGatePermit> {
    try {
        return await recordGenerationGate.acquire({
            timeoutMs: readPositiveIntEnv("MEMORY_STORE_RECORD_GENERATION_QUEUE_TIMEOUT_MS", RECORD_GENERATION_QUEUE_TIMEOUT_MS),
            shouldCancel: () => Boolean(options.isCancelled?.() || options.isSettled?.()),
            cancelMessage: "record generation gate cancelled",
            timeoutMessage: "record generation gate timed out",
        });
    } catch (error) {
        const reason = getRecordAbortReason(options);
        if (reason) throw new RecordGenerationAbortedError(reason, `Record 生成并发等待期间已${reason === "cancelled" ? "取消" : "结算"}`);
        if (error instanceof Error && error.message === "record generation gate timed out") {
            throw new Error("Record 生成并发等待超时");
        }
        throw error;
    }
}

export const __recordGenerationConcurrencyTest = {
    stats(): ReturnType<FifoConcurrencyGate["stats"]> {
        return recordGenerationGate.stats();
    },
    resetPeak(): void {
        recordGenerationGate.resetPeakForTest();
    },
};

function throwRecordModelCancelled(
    result: Pick<RecordModelCallResult, "error">,
    options: GenerateRecordOptions = {},
): never {
    const reason = getRecordAbortReason(options) || "cancelled";
    throw new RecordGenerationAbortedError(
        reason,
        result.error || (reason === "settled" ? "后台任务已结算，Record 模型调用已停止" : "Record 模型调用已取消"),
    );
}

async function callRecordModelBridgeOnce(
    model: string,
    prompt: string,
    modelChain: Chain,
    timeout: number,
    options: GenerateRecordOptions = {},
): Promise<RecordModelCallResult> {
    const bridgeOptions = recordModelBridgeOptions(options);
    if (modelChain !== "auto") {
        throwIfRecordRunAborted(options, `准备调用 ${modelChain} 模型`);
        const scopedTimeout = getRecordCallTimeout(modelChain, timeout, options);
        const resp = await callModelResponse(model, prompt, modelChain, scopedTimeout, bridgeOptions);
        captureGrokDiagnostics(resp, options);
        return {
            text: resp.text,
            error: resp.error,
            timedOut: resp.timedOut,
            cancelled: resp.cancelled,
            chainUsed: resp.chainUsed || modelChain,
            modelUsed: resp.modelUsed,
            grokDiagnostics: resp.grokDiagnostics,
        };
    }

    const candidates = await resolveModelChainCandidates("auto", bridgeOptions);
    if (candidates.length === 0) {
        return {
            text: null,
            chainUsed: null,
            error: options.allowClaudeCodeFallback
                ? "Grok、Antigravity LS、Codex 模型桥与 Claude Code CLI 当前都不可用"
                : "Grok、Antigravity LS 与 Codex 模型桥当前都不可用",
        };
    }

    const errors: string[] = [];
    const logicalDeadlineAt = Date.now() + Math.max(0, timeout);
    for (const candidate of candidates) {
        throwIfRecordRunAborted(options, `准备调用 ${candidate} 模型`);
        const remainingMs = Math.max(0, logicalDeadlineAt - Date.now());
        if (remainingMs <= 0) {
            return {
                text: null,
                error: errors.join("；") || "Record auto 模型调用总预算已耗尽",
                timedOut: true,
                chainUsed: candidate,
            };
        }
        const scopedTimeout = Math.min(getRecordCallTimeout(candidate, timeout, options), remainingMs);
        const resp = await callModelResponse(model, prompt, candidate, scopedTimeout, bridgeOptions);
        captureGrokDiagnostics(resp, options);
        if (resp.cancelled) {
            return {
                text: null,
                error: resp.error,
                cancelled: true,
                chainUsed: resp.chainUsed || candidate,
                modelUsed: resp.modelUsed,
                grokDiagnostics: resp.grokDiagnostics,
            };
        }
        if (resp.text) {
            return {
                text: resp.text,
                chainUsed: resp.chainUsed,
                modelUsed: resp.modelUsed,
                grokDiagnostics: resp.grokDiagnostics,
            };
        }
        errors.push(resp.error || `${candidate} 模型桥调用失败`);
        if (resp.timedOut && candidate !== "grok") {
            return {
                text: null,
                error: resp.error,
                timedOut: true,
                chainUsed: resp.chainUsed || candidate,
                modelUsed: resp.modelUsed,
                grokDiagnostics: resp.grokDiagnostics,
            };
        }
    }
    return {
        text: null,
        chainUsed: candidates[candidates.length - 1] || null,
        error: errors.join("；") || "模型桥调用失败",
    };
}

function withRecordModelUsage<T extends GenerateRecordResult>(result: T, options: GenerateRecordOptions): T {
    const runtimeOptions = options as RecordRuntimeOptions;
    const modelChainsUsed = runtimeOptions.__modelChainsUsed ? Array.from(runtimeOptions.__modelChainsUsed) : [];
    const modelModelsUsed = runtimeOptions.__modelModelsUsed ? Array.from(runtimeOptions.__modelModelsUsed) : [];
    return {
        ...result,
        ...(modelChainsUsed.length > 0 ? { modelChainsUsed } : {}),
        ...(modelModelsUsed.length > 0 ? { modelModelsUsed } : {}),
        ...(runtimeOptions.__grokDiagnostics ? { grokDiagnostics: runtimeOptions.__grokDiagnostics } : {}),
    };
}

async function callRecordModelWithRetry(
    model: string,
    prompt: string,
    modelChain: Chain,
    timeout: number,
    options: GenerateRecordOptions = {},
): Promise<RecordModelCallResult> {
    throwIfRecordRunAborted(options, "模型调用前检查到任务已终止");
    const scope = await resolveRecordModelScope(modelChain, options);
    const bridgeName = scope.modelChain === "claude-code" ? "Claude Code CLI" : "Codex";
    const resp = await callRecordModelBridgeOnce(model, prompt, modelChain, timeout, options);
    if (resp.text) {
        reportRecordModelSuccess(modelChain, resp, options);
        return { text: resp.text, chainUsed: resp.chainUsed, modelUsed: resp.modelUsed };
    }
    if (resp.cancelled) throwRecordModelCancelled(resp, options);
    // 守卫放宽（C2）：凡是「真超时」一律不重试，无论本地文本桥（Codex/CC）还是 antigravity/Flash 链路。
    // 真超时已经白等满了整个 timeout，再无条件重试只会把总耗时翻倍（如 antigravity 180s → 360s）。
    // 连接拒/进程死/空响应等普通失败 timedOut=false，仍走下方原有重试逻辑（可重试 / 换候选）。
    if (resp.timedOut) {
        const actualChain = resp.chainUsed || scope.modelChain;
        const label = modelChain === "auto" ? autoRecordFailurePrefix(actualChain) : recordChainLabel(actualChain);
        setLastRecordModelFailure(modelChain, actualChain, options);
        console.error(`[record-generator] ${label} 模型调用超时，不重试: ${resp.error || "unknown error"}`);
        return { text: null, error: resp.error, timedOut: true, chainUsed: resp.chainUsed, modelUsed: resp.modelUsed };
    }
    if (isLocalTextModelBridge(scope.modelChain)) {
        console.error(`[record-generator] ${bridgeName} 模型调用快失败，${CODEX_RECORD_RETRY_DELAY_MS}ms 后重试 1 次: ${resp.error || "unknown error"}`);
        options.onProgress?.({
            stage: "模型生成重试",
            detail: `${bridgeName} 模型桥快失败，准备重试 1 次：${resp.error || "unknown error"}`,
        });
        if (CODEX_RECORD_RETRY_DELAY_MS > 0) {
            await new Promise(r => setTimeout(r, CODEX_RECORD_RETRY_DELAY_MS));
        }
        throwIfRecordRunAborted(options, `${bridgeName} 模型桥重试前检查到任务已终止`);
        const retry = await callRecordModelBridgeOnce(model, prompt, modelChain, timeout, options);
        if (retry.cancelled) throwRecordModelCancelled(retry, options);
        if (retry.text) {
            reportRecordModelSuccess(modelChain, retry, options);
            return { text: retry.text, chainUsed: retry.chainUsed, modelUsed: retry.modelUsed };
        }
        setLastRecordModelFailure(modelChain, retry.chainUsed || resp.chainUsed || scope.modelChain, options);
        console.error(`[record-generator] ${bridgeName} 模型调用重试失败: ${retry.error || "unknown error"}`);
        return { text: null, error: retry.error || resp.error, timedOut: retry.timedOut, chainUsed: retry.chainUsed || resp.chainUsed, modelUsed: retry.modelUsed || resp.modelUsed };
    }
    // 第一次失败，等 5 秒重试
    const retryLabel = modelChain === "auto" ? "自动链路" : recordChainLabel(scope.modelChain);
    console.error(`[record-generator] ${retryLabel} 首次失败，5s 后重试...`);
    await new Promise(r => setTimeout(r, 5000));
    throwIfRecordRunAborted(options, `${retryLabel} 重试前检查到任务已终止`);
    const retry = await callRecordModelBridgeOnce(model, prompt, modelChain, timeout, options);
    if (retry.cancelled) throwRecordModelCancelled(retry, options);
    if (retry.text) reportRecordModelSuccess(modelChain, retry, options);
    if (!retry.text) {
        setLastRecordModelFailure(modelChain, retry.chainUsed || resp.chainUsed || scope.modelChain, options);
    }
    return {
        text: retry.text,
        error: retry.error || resp.error,
        timedOut: retry.timedOut || resp.timedOut,
        chainUsed: retry.chainUsed || resp.chainUsed,
        modelUsed: retry.modelUsed || resp.modelUsed,
    };
}

async function callFlashWithRetryChain(
    model: string,
    prompt: string,
    modelChain: Chain,
    timeout: number,
    options: GenerateRecordOptions = {},
): Promise<string | null> {
    const result = await callRecordModelWithRetry(model, prompt, modelChain, timeout, options);
    return result.text;
}

export function formatRoundsForRecord(rounds: ConversationRound[]): FormattedRecordRound[] {
    return rounds.map((round) => {
        const rawText = formatRound(round, "normal");
        const text = capSingleRoundText(rawText, round.roundIndex);
        return { round, text, chars: charCount(text) };
    });
}

/** R1：对单轮 formatted 文本做硬上限截断（头尾保留、中段带标记省略），防病态巨轮（如一轮塞几十个大 diff）撑爆 prompt。
 *  正常轮远不及上限、不触发；只截真·异常巨轮，且轮次号不变，不影响下游整轮对齐契约。 */
function capSingleRoundText(text: string, roundIndex: number): string {
    if (text.length <= RECORD_MAX_SINGLE_ROUND_CHARS) return text;
    const lines = text.split("\n");
    const avgLineChars = Math.max(1, Math.ceil(text.length / Math.max(1, lines.length)));
    const keepLines = Math.max(40, Math.floor(RECORD_MAX_SINGLE_ROUND_CHARS / avgLineChars));
    const headLines = Math.floor(keepLines * 0.6);
    const tailLines = Math.max(20, keepLines - headLines);
    if (lines.length <= headLines + tailLines) {
        // 行数少但单行超长（极端：一行巨 diff）→ 退化为按字符头尾截断
        const headChars = Math.floor(RECORD_MAX_SINGLE_ROUND_CHARS * 0.6);
        const tailChars = RECORD_MAX_SINGLE_ROUND_CHARS - headChars;
        return [
            text.slice(0, headChars),
            `\n\n[轮次 ${roundIndex} 原文 ${text.length} 字，超单轮上限 ${RECORD_MAX_SINGLE_ROUND_CHARS} 字，中段已省略约 ${text.length - headChars - tailChars} 字]\n\n`,
            text.slice(-tailChars),
        ].join("");
    }
    return [
        ...lines.slice(0, headLines),
        `\n[轮次 ${roundIndex} 原文 ${text.length} 字 / ${lines.length} 行，超单轮上限 ${RECORD_MAX_SINGLE_ROUND_CHARS} 字，中段省略 ${lines.length - headLines - tailLines} 行（多为大段 diff/thinking）]\n`,
        ...lines.slice(-tailLines),
    ].join("\n");
}

/**
 * 方案1：step 级超大轮切分 + 逐段压缩 + 合并（B3 / Stage R1）。
 *
 * 保留「一轮=最小对齐单元」契约不变：roundIndex 不变，下游 chunk/phase/coverage 零感知。
 * 与 `formatRoundsForRecord`（同步、必须保留原签名）并存——本异步版仅在轮文本超
 * `RECORD_MAX_SINGLE_ROUND_CHARS` 时，对该轮内部按 step 边界切成多个 part 逐段压缩后合并，
 * 用「压缩保留内容」替代原来的「头尾有损截断」。
 *
 * 降级 100% 兜底：任一 part 的模型调用失败 / 空返回 → 该轮整体退回 `capSingleRoundText(rawText)`，
 * 绝不抛异常、绝不让整条 Record 生成失败（沿用「降级不中止」原则）。
 */
function readNonNegativeIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return fallback;
    return n;
}

const RECORD_FORMAT_YIELD_INTERVAL = readNonNegativeIntEnv("MEMORY_STORE_RECORD_FORMAT_YIELD_INTERVAL", 5);

function eventLoopYield(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

export async function formatRoundsForRecordAsync(
    rounds: ConversationRound[],
    modelChain: Chain = "auto",
    options: GenerateRecordOptions = {},
): Promise<FormattedRecordRound[]> {
    const result: FormattedRecordRound[] = [];
    for (let i = 0; i < rounds.length; i++) {
        const round = rounds[i];
        const rawText = formatRound(round, "normal");
        if (rawText.length <= RECORD_MAX_SINGLE_ROUND_CHARS) {
            result.push({ round, text: rawText, chars: charCount(rawText) });
        } else {
            const text = await compressOversizedRound(round, rawText, modelChain, options);
            result.push({ round, text, chars: charCount(text) });
        }
        if (RECORD_FORMAT_YIELD_INTERVAL > 0 && (i + 1) % RECORD_FORMAT_YIELD_INTERVAL === 0) {
            await eventLoopYield();
            throwIfRecordRunAborted(options, `格式化轮次 ${round.roundIndex} 让步后检查到任务已终止`);
        }
    }
    return result;
}

/**
 * 把一个超大轮按 step 边界切成连续的若干 part：
 * - 每个 part 构造一个「合成子 ConversationRound」，只含该 step 区间的
 *   aiResponses / toolCalls / codeActions / taskBoundaries / fileViews；
 * - userMessage + mediaAttachments + attachments + subagentSummaries + compactionSummaries
 *   只归 part 1（避免重复 / 错位）；
 * - 用 `formatRound(child, "normal")` 格式化，按累计大小切到 ≤ RECORD_ROUND_SPLIT_PART_CHARS；
 * - 某个 step 单独成 part 仍超上限时，对该 part 文本兜底 `capSingleRoundText`。
 *
 * 切分以 step 为最小粒度，保证「各 step 不丢不重」。
 */
function splitOversizedRoundBySteps(round: ConversationRound): RoundSplitPart[] {
    const stepStart = round.startStep;
    const stepEnd = round.endStep;
    // 退化保护：start>end（异常数据）时整轮作为单 part 处理。
    if (!Number.isFinite(stepStart) || !Number.isFinite(stepEnd) || stepEnd < stepStart) {
        const child = buildChildRound(round, stepStart, stepEnd, true);
        const rawText = capSingleRoundText(formatRound(child, "normal"), round.roundIndex);
        return [{ startStep: stepStart, endStep: stepEnd, rawText }];
    }

    const parts: RoundSplitPart[] = [];
    let curStart = stepStart;
    let curEnd = stepStart - 1; // 尚未纳入任何 step
    let curChars = 0;
    let isFirst = true;

    const flush = (forceEnd?: number) => {
        if (curEnd < curStart) return; // 空区间不产出
        const includeRoundHead = isFirst;
        const child = buildChildRound(round, curStart, forceEnd ?? curEnd, includeRoundHead);
        let partText = formatRound(child, "normal");
        if (partText.length > RECORD_MAX_SINGLE_ROUND_CHARS) {
            partText = capSingleRoundText(partText, round.roundIndex);
        }
        parts.push({ startStep: curStart, endStep: forceEnd ?? curEnd, rawText: partText });
        isFirst = false;
    };

    for (let step = stepStart; step <= stepEnd; step++) {
        // 估算把 step 纳入当前 part 后的体量：用「仅含该 step 的合成子轮」文本长度近似单 step 增量。
        const stepChild = buildChildRound(round, step, step, false);
        const stepChars = formatRound(stepChild, "normal").length;
        const wouldExceed = curEnd >= curStart && curChars + stepChars > RECORD_ROUND_SPLIT_PART_CHARS;
        if (wouldExceed) {
            flush();
            curStart = step;
            curEnd = step;
            curChars = stepChars;
        } else {
            curEnd = step;
            curChars += stepChars;
        }
    }
    flush();

    // 极端：所有 step 都没产生任何内容（理论上 stepStart..stepEnd 至少有一段），兜一个含 round head 的 part。
    if (parts.length === 0) {
        const child = buildChildRound(round, stepStart, stepEnd, true);
        const rawText = capSingleRoundText(formatRound(child, "normal"), round.roundIndex);
        parts.push({ startStep: stepStart, endStep: stepEnd, rawText });
    }
    return parts;
}

/**
 * 构造一个只覆盖 [fromStep, toStep] 的合成子 ConversationRound。
 * includeRoundHead=true 时保留 userMessage / mediaAttachments / attachments / subagentSummaries /
 * compactionSummaries（这些无可靠 step 归属，统一归 part 1）；否则清空，避免在后续 part 重复出现。
 */
function buildChildRound(
    round: ConversationRound,
    fromStep: number,
    toStep: number,
    includeRoundHead: boolean,
): ConversationRound {
    const inRange = (stepIndex: number) => stepIndex >= fromStep && stepIndex <= toStep;
    return {
        roundIndex: round.roundIndex,
        startStep: fromStep,
        endStep: toStep,
        userMessage: includeRoundHead ? round.userMessage : "",
        mediaAttachments: includeRoundHead ? round.mediaAttachments : [],
        attachments: includeRoundHead ? round.attachments : undefined,
        aiResponses: round.aiResponses.filter(item => inRange(item.stepIndex)),
        toolCalls: round.toolCalls.filter(item => inRange(item.stepIndex)),
        taskBoundaries: round.taskBoundaries.filter(item => inRange(item.stepIndex)),
        codeActions: round.codeActions.filter(item => inRange(item.stepIndex)),
        subagentSummaries: includeRoundHead ? round.subagentSummaries : [],
        fileViews: round.fileViews ? round.fileViews.filter(item => inRange(item.stepIndex)) : undefined,
        compactionSummaries: includeRoundHead ? round.compactionSummaries : undefined,
    };
}

/**
 * 对一个超大轮做「step 切分→逐段压缩→合并」，返回压缩版单轮文本（roundIndex 不变）。
 * 任一 part 压缩失败/空返回 → 整轮退回 capSingleRoundText(rawText)（降级 100% 兜底，绝不抛）。
 */
async function compressOversizedRound(
    round: ConversationRound,
    rawText: string,
    modelChain: Chain,
    options: GenerateRecordOptions,
): Promise<string> {
    try {
        const parts = splitOversizedRoundBySteps(round);
        const compressedParts: string[] = [];
        let prevSummary = "";
        for (let i = 0; i < parts.length; i++) {
            throwIfRecordRunAborted(options, `压缩超大轮 ${round.roundIndex} 的第 ${i + 1}/${parts.length} 段前检查到任务已终止`);
            const part = parts[i];
            const prompt = buildRoundPartCompressionPrompt(
                round.roundIndex,
                part.startStep,
                part.endStep,
                i + 1,
                parts.length,
                prevSummary,
                part.rawText,
            );
            options.onProgress?.({
                stage: "压缩超大轮",
                detail: `轮次 ${round.roundIndex}：压缩第 ${i + 1}/${parts.length} 段（steps ${part.startStep}-${part.endStep}）`,
            });
            const resp = await callRecordModelWithRetry(
                FLASH_MODEL,
                prompt,
                modelChain,
                RECORD_MODEL_TIMEOUT_MS,
                options,
            );
            const summary = (resp.text || "").trim();
            if (!summary) {
                // 任一段失败/空返回 → 整轮降级到有损截断，绝不让 Record 生成失败。
                console.error(`[record-generator] 轮次 ${round.roundIndex} 第 ${i + 1}/${parts.length} 段压缩失败/空返回，整轮降级 capSingleRoundText: ${resp.error || "empty"}`);
                return capSingleRoundText(rawText, round.roundIndex);
            }
            compressedParts.push(`【steps ${part.startStep}-${part.endStep}】\n${summary}`);
            prevSummary = summary;
        }
        const header = `## 轮次 ${round.roundIndex} (steps ${round.startStep}-${round.endStep})`;
        const userBlock = round.userMessage
            ? `### 👤 用户 (step ${round.startStep})\n${round.userMessage}`
            : "";
        const note = `> ⚠️ 本轮原文 ${rawText.length} 字超单轮上限 ${RECORD_MAX_SINGLE_ROUND_CHARS} 字，已按 step 切成 ${parts.length} 段逐段压缩（内容保留、非有损截断）。`;
        const merged = [header, note, userBlock, ...compressedParts]
            .filter(block => block.length > 0)
            .join("\n\n");
        return merged;
    } catch (err) {
        if (isRecordGenerationAbortedError(err)) throw err;
        // 任何意外都降级，绝不冒泡到 Record 生成主流程。
        console.error(`[record-generator] 轮次 ${round.roundIndex} 超大轮压缩异常，整轮降级 capSingleRoundText: ${err instanceof Error ? err.message : String(err)}`);
        return capSingleRoundText(rawText, round.roundIndex);
    }
}

export function createRecordChunks(
    formattedRounds: FormattedRecordRound[],
    targetChars: number,
    minRounds = 1,
): RecordChunk[] {
    const chunks: RecordChunk[] = [];
    let current: FormattedRecordRound[] = [];
    let currentChars = 0;

    const flush = () => {
        if (current.length === 0) return;
        chunks.push({
            startRound: current[0].round.roundIndex,
            endRound: current[current.length - 1].round.roundIndex,
            rounds: current.map(item => item.round),
            text: current.map(item => item.text).join("\n\n---\n\n"),
            chars: currentChars,
        });
        current = [];
        currentChars = 0;
    };

    for (const item of formattedRounds) {
        const separatorChars = current.length > 0 ? "\n\n---\n\n".length : 0;
        const nextChars = currentChars + separatorChars + item.chars;
        const wouldExceed = current.length > 0 && nextChars > targetChars;
        const hasSoftMinimum = current.length >= Math.max(1, minRounds);
        if (wouldExceed && (hasSoftMinimum || currentChars > 0)) {
            flush();
        }
        const sep = current.length > 0 ? "\n\n---\n\n".length : 0;
        current.push(item);
        currentChars += sep + item.chars;
    }

    flush();
    return chunks;
}

function countToolCalls(rounds: ConversationRound[]): number {
    return rounds.reduce((sum, round) => sum + (round.toolCalls?.length || 0), 0);
}

export function getParallelChunkBudget(formattedRounds: FormattedRecordRound[], promptBudget: number): number {
    const rounds = formattedRounds.map(item => item.round);
    const totalToolCalls = countToolCalls(rounds);
    const maxRoundToolCalls = rounds.reduce((max, round) => Math.max(max, round.toolCalls?.length || 0), 0);
    const dense = totalToolCalls >= RECORD_PARALLEL_DENSE_TOOL_THRESHOLD || maxRoundToolCalls >= RECORD_PARALLEL_DENSE_TOOL_THRESHOLD;
    const target = dense
        ? Math.min(RECORD_PARALLEL_CHUNK_CHARS, RECORD_PARALLEL_DENSE_TOOL_CHUNK_CHARS)
        : RECORD_PARALLEL_CHUNK_CHARS;
    return Math.max(5_000, Math.min(promptBudget, target));
}

export function shouldUseParallelPipeline(
    mode: RecordParallelMode,
    chunks: RecordChunk[],
    options: { existingRecordChars?: number; promptWouldBeHeavy?: boolean } = {},
): boolean {
    if (mode === "off") return false;
    if (mode === "force") return chunks.length >= 2;
    if (chunks.length === 1) {
        return (options.existingRecordChars ?? 0) >= RECORD_PARALLEL_SINGLE_CHUNK_RECORD_CHARS
            || options.promptWouldBeHeavy === true;
    }
    return chunks.length >= 2;
}

function resolveParallelMode(mode?: RecordParallelMode): RecordParallelMode {
    if (mode === "off" || mode === "auto" || mode === "force") return mode;
    if (RECORD_PARALLEL_MODE === "off" || RECORD_PARALLEL_MODE === "auto" || RECORD_PARALLEL_MODE === "force") {
        return RECORD_PARALLEL_MODE;
    }
    return "off";
}

function summarizeRecordStructure(record: string, maxChars = 12_000): string {
    if (!record.trim()) return "";
    const lines = record.split(/\r?\n/u);
    const kept: string[] = [];
    for (const line of lines) {
        if (
            /^#\s/u.test(line) ||
            /^\*\*?(对话ID|工作区|时间跨度|总轮次)/u.test(line) ||
            /^-\s*(对话ID|工作区|总轮次|总步骤)/u.test(line) ||
            /^## Phase \d+/u.test(line) ||
            /^<!--\s*TAGS:/iu.test(line)
        ) {
            kept.push(line);
        }
    }
    const summary = kept.join("\n").trim() || record.slice(0, maxChars);
    return summary.length > maxChars
        ? `${summary.slice(0, maxChars)}\n...（旧 Record 结构摘要已截断）`
        : summary;
}

function buildAdjacentContext(allFormatted: FormattedRecordRound[], chunk: RecordChunk): string {
    const startIndex = allFormatted.findIndex(item => item.round.roundIndex === chunk.startRound);
    const endIndex = allFormatted.findIndex(item => item.round.roundIndex === chunk.endRound);
    if (startIndex < 0 || endIndex < 0) return "";
    const before = allFormatted.slice(Math.max(0, startIndex - RECORD_ADJACENT_CONTEXT_ROUNDS), startIndex);
    const after = allFormatted.slice(endIndex + 1, endIndex + 1 + RECORD_ADJACENT_CONTEXT_ROUNDS);
    const parts: string[] = [];
    for (const item of before) {
        parts.push(`### 前文轮次 ${item.round.roundIndex}\n${item.text.slice(0, RECORD_ADJACENT_CONTEXT_CHARS)}`);
    }
    for (const item of after) {
        parts.push(`### 后文轮次 ${item.round.roundIndex}\n${item.text.slice(0, RECORD_ADJACENT_CONTEXT_CHARS)}`);
    }
    return parts.join("\n\n---\n\n");
}

export function getMaxPromptChars(modelChain: Chain): number {
    if (modelChain === "grok") return GROK_RECORD_MAX_PROMPT_CHARS;
    if (modelChain === "codex") return CODEX_RECORD_MAX_PROMPT_CHARS;
    if (modelChain === "claude-code") return CC_RECORD_MAX_PROMPT_CHARS;
    return MAX_PROMPT_CHARS;
}

export function getMinBatchRounds(modelChain: Chain): number {
    return isLocalTextModelBridge(modelChain) ? 1 : MIN_BATCH_ROUNDS;
}

function trimRecordForPrompt(record: string, modelChain: Chain): string {
    const contextChars = modelChain === "claude-code" ? CC_RECORD_CONTEXT_CHARS : CODEX_RECORD_CONTEXT_CHARS;
    if (!isLocalTextModelBridge(modelChain) || record.length <= contextChars) {
        return record;
    }

    const bridgeName = modelChain === "claude-code" ? "Claude Code CLI" : "Codex";
    const headChars = Math.min(8_000, Math.floor(contextChars * 0.3));
    const tailChars = Math.max(4_000, contextChars - headChars);
    const head = record.slice(0, headChars);
    const tail = record.slice(-tailChars);
    // B5/M3 治标：中段省略时保留被截区间内的所有 `## Phase` 标题行作为骨架，避免模型看不到
    // 中段 Phase 结构（头尾纯字符截断会连 Phase 标题一起截掉，模型续写时易丢失/重写中段阶段）。
    const middle = record.slice(headChars, record.length - tailChars);
    const middlePhaseTitles = middle
        .split(/\r?\n/u)
        .filter(line => /^##\s*Phase\b/iu.test(line.trim()))
        .map(line => line.trim());
    const skeleton = middlePhaseTitles.length > 0
        ? `\n（中段省略区的 Phase 骨架，供结构对齐，正文已省略）：\n${middlePhaseTitles.join("\n")}`
        : "";
    return [
        head,
        "",
        `<!-- Record 中段已为 ${bridgeName} 模型桥压缩省略，原始 Record 总长 ${record.length} 字；请保持已有结构并优先基于末尾最新阶段续写。${skeleton} -->`,
        "",
        tail,
    ].join("\n");
}

async function reconcileRecordIndexCoverage(
    hash: string,
    conversationId: string,
    existingRecord: string,
    totalRounds: number,
): Promise<RecordIndexEntry | undefined> {
    const index = await readRecordsIndexAsync(hash);
    const existingIndex = index.records[conversationId];
    const inferredCoveredRound = inferCoveredRoundFromRecord(existingRecord, totalRounds);
    const indexedRound = Math.min(Math.max(existingIndex?.lastUpdatedRound ?? 0, 0), totalRounds);

    if (inferredCoveredRound === indexedRound) {
        return existingIndex;
    }

    const phases = countPhasesInRecord(existingRecord);
    const now = new Date().toISOString();
    const repaired: RecordIndexEntry = {
        conversationId,
        title: existingIndex?.title || extractRecordTitle(existingRecord) || `对话 ${conversationId.slice(0, 8)}`,
        timeSpan: existingIndex?.timeSpan || "",
        totalRounds: Math.max(existingIndex?.totalRounds ?? 0, inferRecordTotalRounds(existingRecord), totalRounds),
        totalSteps: existingIndex?.totalSteps ?? 0,
        lastUpdatedRound: inferredCoveredRound,
        lastUpdatedAt: now,
        phases: existingIndex?.phases || phases,
        sizeBytes: Buffer.byteLength(existingRecord, "utf-8"),
        tags: existingIndex?.tags || [],
    };

    console.error(
        `[record-generator] 按 Record 正文修正索引覆盖轮次: ${conversationId.slice(0, 8)} ${indexedRound} → ${inferredCoveredRound}`
    );
    return repaired;
}

async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
    options: GenerateRecordOptions = {},
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
        while (next < items.length) {
            throwIfRecordRunAborted(options, "并行任务取下一个批次前检查到任务已终止");
            const index = next++;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

async function generatePatchForChunk(
    conversationId: string,
    workspace: string,
    modelChain: Chain,
    options: GenerateRecordOptions,
    prompt: string,
    chunk: RecordChunk,
    chunkIndex: number,
    totalChunks: number,
): Promise<RecordPatch> {
    throwIfRecordRunAborted(options, `生成 RecordPatch ${roundRangeLabel(chunk.startRound, chunk.endRound)} 前检查到任务已终止`);
    const readScope = getCachedRecordModelScope(modelChain, options);
    const cached = await readRecordPatchCheckpointAsync("map", conversationId, readScope, chunk.startRound, chunk.endRound, prompt);
    if (cached) {
        options.onProgress?.({
            stage: "并行生成 RecordPatch",
            current: chunkIndex + 1,
            total: totalChunks,
            unit: "批",
            detail: `复用已完成区段缓存，${roundRangeLabel(chunk.startRound, chunk.endRound)}`,
        });
        return cached;
    }
    let lastError = "";
    let lastCheckpointScope: RecordCheckpointScope = readScope || fallbackRecordModelScope(modelChain);
    for (let attempt = 0; attempt <= RECORD_PARALLEL_RETRIES; attempt++) {
        options.onProgress?.({
            stage: "并行生成 RecordPatch",
            current: chunkIndex,
            total: totalChunks,
            unit: "批",
            detail: `第 ${chunkIndex + 1}/${totalChunks} 个区段，${roundRangeLabel(chunk.startRound, chunk.endRound)}，尝试 ${attempt + 1}/${RECORD_PARALLEL_RETRIES + 1}`,
        });
        const response = await callRecordModelWithRetry(FLASH_MODEL, prompt, modelChain, RECORD_MODEL_TIMEOUT_MS, options);
        lastCheckpointScope = checkpointScopeFromResponse(modelChain, response, options);
        if (response.text) {
            throwIfRecordRunAborted(options, `RecordPatch ${roundRangeLabel(chunk.startRound, chunk.endRound)} 已生成，写 checkpoint 前检查到任务已终止`);
            const patch = parseRecordPatchResponse(response.text, chunk.startRound, chunk.endRound);
            const status = patch.status === "parse_fallback" ? "invalid" : "done";
            await writeRecordPatchCheckpointAsync(
                "map",
                conversationId,
                workspace,
                lastCheckpointScope,
                chunk.startRound,
                chunk.endRound,
                prompt,
                status,
                status === "done" ? patch : undefined,
                status === "invalid" ? "RecordPatch 输出缺少可解析 JSON，已隔离为 invalid" : undefined,
            );
            if (status === "invalid") {
                throw new Error(`RecordPatch ${roundRangeLabel(chunk.startRound, chunk.endRound)} 输出格式无效，已隔离 invalid checkpoint`);
            }
            return patch;
        }
        if (response.timedOut && isLocalTextModelBridge(modelChain)) {
            const bridgeName = modelChain === "claude-code" ? "Claude Code CLI" : "Codex";
            throwIfRecordRunAborted(options, `RecordPatch ${roundRangeLabel(chunk.startRound, chunk.endRound)} 超时后写 checkpoint 前检查到任务已终止`);
            await writeRecordPatchCheckpointAsync("map", conversationId, workspace, lastCheckpointScope, chunk.startRound, chunk.endRound, prompt, "timeout", undefined, response.error);
            throw new Error(`RecordPatch ${roundRangeLabel(chunk.startRound, chunk.endRound)} ${bridgeName} 模型桥完整超时，不自动重试`);
        }
        lastError = `RecordPatch ${roundRangeLabel(chunk.startRound, chunk.endRound)} 生成失败`;
    }
    throwIfRecordRunAborted(options, `RecordPatch ${roundRangeLabel(chunk.startRound, chunk.endRound)} 失败后写 checkpoint 前检查到任务已终止`);
    await writeRecordPatchCheckpointAsync("map", conversationId, workspace, lastCheckpointScope, chunk.startRound, chunk.endRound, prompt, "failed", undefined, lastError);
    throw new Error(`${lastError}；可缩小 chunk 或改用 dataChain=${modelChain === "claude-code" ? "claude-code" : "codex"}, modelChain=antigravity`);
}

async function compressRecordPatchGroup(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    patches: RecordPatch[],
    groupIndex: number,
    totalGroups: number,
    level: number,
    modelChain: Chain,
    options: GenerateRecordOptions,
): Promise<RecordPatch> {
    const startRound = patches[0]?.startRound ?? 0;
    const endRound = patches[patches.length - 1]?.endRound ?? startRound;
    throwIfRecordRunAborted(options, `压缩 RecordPatch ${roundRangeLabel(startRound, endRound)} 前检查到任务已终止`);
    const prompt = buildCompressRecordPatchesPrompt(
        conversationId,
        workspace,
        totalRounds,
        totalSteps,
        patches,
        groupIndex,
        totalGroups,
    );
    const readScope = getCachedRecordModelScope(modelChain, options);
    const cached = await readRecordPatchCheckpointAsync("compress", conversationId, readScope, startRound, endRound, prompt);
    if (cached) {
        options.onProgress?.({
            stage: "压缩 RecordPatch",
            current: groupIndex + 1,
            total: totalGroups,
            unit: "组",
            detail: `复用第 ${level} 层压缩缓存，${roundRangeLabel(startRound, endRound)}`,
        });
        return cached;
    }
    let lastError = "";
    let lastCheckpointScope: RecordCheckpointScope = readScope || fallbackRecordModelScope(modelChain);
    for (let attempt = 0; attempt <= RECORD_PARALLEL_RETRIES; attempt++) {
        options.onProgress?.({
            stage: "压缩 RecordPatch",
            current: groupIndex,
            total: totalGroups,
            unit: "组",
            detail: `第 ${level} 层，第 ${groupIndex + 1}/${totalGroups} 组，${roundRangeLabel(startRound, endRound)}，尝试 ${attempt + 1}/${RECORD_PARALLEL_RETRIES + 1}`,
        });
        const response = await callRecordModelWithRetry(FLASH_MODEL, prompt, modelChain, RECORD_MODEL_TIMEOUT_MS, options);
        lastCheckpointScope = checkpointScopeFromResponse(modelChain, response, options);
        if (response.text) {
            throwIfRecordRunAborted(options, `压缩 RecordPatch ${roundRangeLabel(startRound, endRound)} 已生成，写 checkpoint 前检查到任务已终止`);
            const patch = parseRecordPatchResponse(response.text, startRound, endRound);
            const status = patch.status === "parse_fallback" ? "invalid" : "done";
            await writeRecordPatchCheckpointAsync(
                "compress",
                conversationId,
                workspace,
                lastCheckpointScope,
                startRound,
                endRound,
                prompt,
                status,
                status === "done" ? patch : undefined,
                status === "invalid" ? "RecordPatch 压缩输出缺少可解析 JSON，已隔离为 invalid" : undefined,
            );
            if (status === "invalid") {
                throw new Error(`RecordPatch 压缩组 ${groupIndex + 1}/${totalGroups} 输出格式无效，已隔离 invalid checkpoint`);
            }
            return patch;
        }
        if (response.timedOut && isLocalTextModelBridge(modelChain)) {
            const bridgeName = modelChain === "claude-code" ? "Claude Code CLI" : "Codex";
            throwIfRecordRunAborted(options, `压缩 RecordPatch ${roundRangeLabel(startRound, endRound)} 超时后写 checkpoint 前检查到任务已终止`);
            await writeRecordPatchCheckpointAsync("compress", conversationId, workspace, lastCheckpointScope, startRound, endRound, prompt, "timeout", undefined, response.error);
            throw new Error(`RecordPatch 压缩组 ${groupIndex + 1}/${totalGroups} ${bridgeName} 模型桥完整超时，不自动重试`);
        }
        lastError = response.error || `RecordPatch 压缩组 ${groupIndex + 1}/${totalGroups} 生成失败`;
    }
    throwIfRecordRunAborted(options, `压缩 RecordPatch ${roundRangeLabel(startRound, endRound)} 失败后写 checkpoint 前检查到任务已终止`);
    await writeRecordPatchCheckpointAsync("compress", conversationId, workspace, lastCheckpointScope, startRound, endRound, prompt, "failed", undefined, lastError);
    throw new Error(lastError || `RecordPatch 压缩组 ${groupIndex + 1}/${totalGroups} 生成失败`);
}

function getPatchChars(patch: RecordPatch): number {
    return JSON.stringify({
        startRound: patch.startRound,
        endRound: patch.endRound,
        title: patch.title,
        files: patch.files,
        tags: patch.tags,
        risks: patch.risks,
        status: patch.status,
    }).length + patch.markdown.length;
}

export function groupPatchesForCompression(patches: RecordPatch[], groupSize: number, targetChars: number, maxRounds = 0): RecordPatch[][] {
    const groups: RecordPatch[][] = [];
    let current: RecordPatch[] = [];
    let currentChars = 0;

    const flush = () => {
        if (current.length === 0) return;
        groups.push(current);
        current = [];
        currentChars = 0;
    };

    for (const patch of patches.sort((a, b) => a.startRound - b.startRound)) {
        const patchChars = getPatchChars(patch);
        const wouldExceedCount = current.length >= groupSize;
        const wouldExceedChars = current.length > 0 && currentChars + patchChars > targetChars;
        // 轮次跨度上限：patch 可能很粗，仅靠数量/字数限不住单窗【输出】规模，按轮数兜底切窗（maxRounds<=0 时不启用）。
        const wouldExceedRounds = maxRounds > 0 && current.length > 0
            && (patch.endRound - current[0].startRound + 1) > maxRounds;
        if (wouldExceedCount || wouldExceedChars || wouldExceedRounds) {
            flush();
        }
        current.push(patch);
        currentChars += patchChars;
    }

    flush();
    return groups;
}

async function compressPatchesIfNeeded(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    patches: RecordPatch[],
    modelChain: Chain,
    options: GenerateRecordOptions,
): Promise<RecordPatch[]> {
    const directLimit = Math.max(1, RECORD_REDUCE_DIRECT_PATCH_LIMIT);
    const groupSize = Math.max(2, RECORD_REDUCE_GROUP_SIZE);
    const targetChars = Math.max(8_000, Math.min(getMaxPromptChars(modelChain), RECORD_REDUCE_GROUP_CHARS));
    let current = patches.sort((a, b) => a.startRound - b.startRound);
    let level = 0;

    while (current.length > directLimit && level < Math.max(1, RECORD_REDUCE_MAX_LEVELS)) {
        throwIfRecordRunAborted(options, `第 ${level + 1} 层 RecordPatch 压缩前检查到任务已终止`);
        level++;
        const groups = groupPatchesForCompression(current, groupSize, targetChars);
        if (groups.length >= current.length) break;

        const concurrency = Math.max(1, Math.min(RECORD_PARALLEL_CONCURRENCY, groups.length));
        let completed = 0;
        current = await mapWithConcurrency(groups, concurrency, async (group, index) => {
            const patch = await compressRecordPatchGroup(
                conversationId,
                workspace,
                totalRounds,
                totalSteps,
                group,
                index,
                groups.length,
                level,
                modelChain,
                options,
            );
            completed++;
            options.onProgress?.({
                stage: "压缩 RecordPatch",
                current: completed,
                total: groups.length,
                unit: "组",
                detail: `第 ${level} 层第 ${index + 1}/${groups.length} 组完成，${roundRangeLabel(patch.startRound, patch.endRound)}`,
            });
            return patch;
        }, options);
        current = current.sort((a, b) => a.startRound - b.startRound);
    }

    return current;
}

// ============================================================
// 串行本地合成（R2）：把"一次性生成整段重写区 phaseMarkdown"改成
// "按子窗口串行累积"，每步模型只产一小段结构化增量，代码累积成全长。
// 集成点：替换 generateRecordWithLocalCompose 内的单次模型调用，
// 仍产出同构的 LocalComposeDelta 喂给下游 composeRecordLocally。
// ============================================================


/** 串行本地合成主循环 */
async function composeDeltaSerially(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    boundary: LocalComposeBoundary,
    parsed: ParsedRecordDocument,
    rollbackPhaseText: string,
    rewritePatches: RecordPatch[],
    modelChain: Chain,
    options: GenerateRecordOptions,
): Promise<LocalComposeDelta> {
    const windows = groupPatchesForCompression(
        rewritePatches,
        Math.max(1, RECORD_COMPOSE_SERIAL_WINDOW_PATCHES),
        Math.max(2_000, RECORD_COMPOSE_SERIAL_WINDOW_CHARS),
        Math.max(5, RECORD_COMPOSE_SERIAL_WINDOW_ROUNDS),
    );
    if (windows.length === 0) {
        throw new Error("串行本地合成失败：重写区无 patch 可处理");
    }

    const acc: SerialComposeAccumulator = {
        closedPhaseMarkdown: [],
        openPhase: null,
        lastEndRound: boundary.stableEndRound,
        warnings: [],
        tags: [],
    };

    for (let i = 0; i < windows.length; i++) {
        throwIfRecordRunAborted(options, `本地合成子窗口 ${i + 1}/${windows.length} 前检查到任务已终止`);
        const window = windows[i];
        const windowStartRound = window[0].startRound;
        // 用 max 防止上游某天传入 endRound 非单调的 patches 导致少覆盖
        const windowEndRound = Math.max(...window.map(p => p.endRound));
        const isFirstWindow = i === 0;
        const isLastWindow = i === windows.length - 1;

        const openPhaseSnippet = acc.openPhase
            ? buildOpenPhaseSnippet(acc.openPhase)
            : "";

        options.onProgress?.({
            stage: "本地合成串行累积",
            current: acc.lastEndRound,
            total: totalRounds,
            unit: "轮",
            detail: `子窗口 ${i + 1}/${windows.length}，${roundRangeLabel(windowStartRound, windowEndRound)}`,
        });

        const stepPrompt = buildSerialComposeStepPrompt(
            conversationId, workspace, totalRounds, totalSteps,
            boundary.rewriteStartRound, windowStartRound, windowEndRound,
            summarizeClosedPhasesOutline(acc.closedPhaseMarkdown),
            openPhaseSnippet,
            window,
            rollbackPhaseText,
            parsed.manualSupplementSnippets,
            isFirstWindow,
            isLastWindow,
        );

        const stepStartedAt = Date.now();
        const heartbeat = RECORD_PROGRESS_HEARTBEAT_MS > 0
            ? setInterval(() => {
                const elapsed = Math.round((Date.now() - stepStartedAt) / 1000);
                options.onProgress?.({
                    stage: "本地合成串行累积",
                    current: acc.lastEndRound,
                    total: totalRounds,
                    unit: "轮",
                    detail: `子窗口 ${i + 1}/${windows.length} 模型生成中，已用 ${elapsed}s`,
                });
            }, RECORD_PROGRESS_HEARTBEAT_MS)
            : null;

        let response: RecordModelCallResult;
        try {
            response = await callRecordModelWithRetry(FLASH_MODEL, stepPrompt, modelChain, RECORD_MODEL_TIMEOUT_MS, options);
        } finally {
            if (heartbeat) clearInterval(heartbeat);
        }
        if (!response.text) {
            throw new Error(`串行子窗口 ${i + 1}/${windows.length}${patchRangeLabel(windowStartRound, windowEndRound)}模型调用失败${response.error ? `：${response.error}` : ""}`);
        }

        let step = parseSerialComposeStep(response.text);
        // M2：以「markdown 非空的有效 Phase 数」判定，而非 phases.length——salvage 可能抢救出结构有效但 markdown 空的对象，
        // 那些会在下方循环被 continue 跳过、整窗 0 实际入账；若只看 phases.length 会漏掉重试，导致整窗内容被静默吞掉却伪标记已覆盖。
        const effectivePhaseCount = (s: SerialStepDelta) => s.phases.filter(p => (p.markdown || "").trim().length > 0).length;
        if (effectivePhaseCount(step) === 0) {
            // 健壮性：本窗一个有正文的 Phase 都没解析出（截断到首个 Phase 之前 / 空响应 / 拒答 / 格式跑偏 / markdown 全空）。
            // 落盘首次原始响应便于离线定位，并重试一次模型调用（输出有随机性，重试常能拿到可解析结果）。
            try {
                const diag = saveTempFile("record_serial_step_nophase", conversationId.slice(0, 8),
                    `[window] ${i + 1}/${windows.length} rounds ${windowStartRound}-${windowEndRound}\n[response.text length] ${response.text.length}\n[response.error] ${response.error ?? ""}\n\n=== RAW RESPONSE ===\n${response.text}\n\n=== STEP PROMPT ===\n${stepPrompt}`);
                console.error(`[record-generator] 串行子窗口 ${i + 1} 首次无有效 phases，已落盘诊断: ${diag}`);
            } catch { /* 诊断失败不影响主流程 */ }
            acc.warnings.push(`子窗口 ${i + 1}/${windows.length} 首次未产出有效 phases，已重试一次`);
            const retryResp = await callRecordModelWithRetry(FLASH_MODEL, stepPrompt, modelChain, RECORD_MODEL_TIMEOUT_MS, options);
            if (retryResp.text) step = parseSerialComposeStep(retryResp.text);
            if (effectivePhaseCount(step) === 0) {
                throw new Error(`串行子窗口 ${i + 1}/${windows.length} 解析失败：未产出任何有效 phases（已重试，仍无可解析结构）`);
            }
        }
        acc.warnings.push(...step.warnings);

        // 处理本步 phases：除最后一个外全推入 closed；最后一个根据 open 决定
        for (let pi = 0; pi < step.phases.length; pi++) {
            const p = step.phases[pi];
            const isLastInStep = pi === step.phases.length - 1;
            let md = (p.markdown || "").trim();
            if (!md) continue;

            // 轮次连续性兜底：模型给的 startRound 若 < lastEndRound+1，强制改写
            let pStart = p.startRound ?? acc.lastEndRound + 1;
            let pEnd = p.endRound ?? Math.max(pStart, windowEndRound);
            const isFirstPhaseOfStep = pi === 0;
            const shouldMergeWithOpen = isFirstPhaseOfStep && acc.openPhase !== null;

            if (shouldMergeWithOpen) {
                // 合并到上一步留下的 openPhase：startRound 取 openPhase 的，结束按模型给的
                pStart = acc.openPhase!.startRound;
                if (pEnd < pStart) pEnd = pStart;
            } else {
                if (pStart < acc.lastEndRound + 1) {
                    acc.warnings.push(`子窗口 ${i + 1} phase ${pi + 1}: 模型给 startRound=${pStart}，已修正为 ${acc.lastEndRound + 1}`);
                    pStart = acc.lastEndRound + 1;
                }
                if (pEnd < pStart) pEnd = pStart;
            }

            md = rewritePhaseRoundsLabel(md, pStart, pEnd);
            acc.lastEndRound = pEnd;

            const stillOpen = isLastInStep && (p.open === true) && !isLastWindow;
            if (stillOpen) {
                acc.openPhase = { startRound: pStart, endRound: pEnd, markdown: md };
            } else {
                acc.closedPhaseMarkdown.push(md);
                if (isLastInStep) acc.openPhase = null;
            }
        }

        // 截断兜底：本窗输出疑似被截断、覆盖不到 windowEndRound（如超大窗输出超 token 上限被砍半截）→ 把本窗末
        // Phase 的轮次延展到 windowEndRound，避免与下一窗之间留下轮次空洞（被截断的尾段轮次折叠进末 Phase，内容略）。
        if (!isLastWindow && acc.lastEndRound < windowEndRound) {
            const oldEnd = acc.lastEndRound;
            // A3：截断缺口在正文留显式占位标记，让下游/人看见这段是低保真兜底、可被后续增量重跑补全。
            // 措辞刻意避开覆盖判定触发词（覆盖到/轮次/回合/rounds），不会被 inferCoveredRoundFromRecord/Phase 解析误读。
            const gapNote = `\n\n<!-- 截断缺口：本 Phase 第 ${oldEnd + 1}-${windowEndRound} 段内容因模型输出截断未完整保留（低保真兜底），建议重跑补全 -->`;
            if (acc.openPhase) {
                acc.openPhase.markdown = rewritePhaseRoundsLabel(acc.openPhase.markdown, acc.openPhase.startRound, windowEndRound) + gapNote;
                acc.openPhase.endRound = windowEndRound;
            } else if (acc.closedPhaseMarkdown.length > 0) {
                const li = acc.closedPhaseMarkdown.length - 1;
                const lastMd = acc.closedPhaseMarkdown[li];
                const sm = lastMd.match(/[（(]\s*轮次?\s*(\d+)\s*[-~–—－]\s*\d+\s*[)）]/u);
                const ls = sm ? Number(sm[1]) : oldEnd;
                acc.closedPhaseMarkdown[li] = rewritePhaseRoundsLabel(lastMd, ls, windowEndRound) + gapNote;
            }
            acc.lastEndRound = windowEndRound;
            acc.warnings.push(`子窗口 ${i + 1}/${windows.length} 输出疑似截断（仅覆盖到 ${oldEnd}<${windowEndRound}），末 Phase 轮次延展 ${windowEndRound - oldEnd} 轮到 ${windowEndRound}（低保真兜底，已在正文插占位标记）`);
        }
    }

    // 末尾兜底：如还有 openPhase（理论上末窗口已强制收尾，这里只防御性），推入 closed
    if (acc.openPhase) {
        acc.closedPhaseMarkdown.push(acc.openPhase.markdown);
        acc.openPhase = null;
    }

    // 轮次覆盖兜底：若末轮 < totalRounds，把最后一个 Phase 的 endRound 补到 totalRounds
    if (acc.lastEndRound < totalRounds && acc.closedPhaseMarkdown.length > 0) {
        const oldLastEndRound = acc.lastEndRound;
        const lastIdx = acc.closedPhaseMarkdown.length - 1;
        const lastMd = acc.closedPhaseMarkdown[lastIdx];
        const startMatch = lastMd.match(/[（(]\s*轮次?\s*(\d+)\s*[-~–—－]\s*\d+\s*[)）]/u);
        const lastStart = startMatch ? Number(startMatch[1]) : oldLastEndRound;
        acc.closedPhaseMarkdown[lastIdx] = rewritePhaseRoundsLabel(lastMd, lastStart, totalRounds);
        acc.warnings.push(`末轮覆盖兜底：lastEndRound 从 ${oldLastEndRound} 补到 ${totalRounds}`);
        acc.lastEndRound = totalRounds;
    }

    const phaseMarkdown = acc.closedPhaseMarkdown
        .map(s => s.trim())
        .filter(Boolean)
        .join("\n\n");

    // 全局尾部：单独一次短调用，失败则用旧 tail 兜底
    let tailMarkdown = "";
    let tailTags: string[] = [];
    try {
        throwIfRecordRunAborted(options, "本地合成尾部生成前检查到任务已终止");
        options.onProgress?.({
            stage: "本地合成尾部生成",
            current: totalRounds,
            total: totalRounds,
            unit: "轮",
            detail: "生成全局尾部（产出清单/经验/风险）",
        });
        const fileHints = Array.from(new Set(rewritePatches.flatMap(p => p.files || [])));
        const tailPrompt = buildSerialComposeTailPrompt(
            conversationId, workspace, totalRounds, totalSteps,
            summarizeClosedPhasesOutline(acc.closedPhaseMarkdown),
            parsed.tail,
            fileHints,
            parsed.manualSupplementSnippets,
        );
        const tailResp = await callRecordModelWithRetry(FLASH_MODEL, tailPrompt, modelChain, RECORD_MODEL_TIMEOUT_MS, options);
        if (tailResp.text) {
            const parsedTail = parseSerialComposeTail(tailResp.text);
            tailMarkdown = parsedTail.tailMarkdown;
            tailTags = parsedTail.tags;
        } else {
            acc.warnings.push(`全局尾部生成失败，使用旧 tail 兜底${tailResp.error ? `：${tailResp.error}` : ""}`);
        }
    } catch (err) {
        acc.warnings.push(`全局尾部生成异常，使用旧 tail 兜底：${err instanceof Error ? err.message : String(err)}`);
    }

    // 合并 tags：rewritePatches 的 tags + tailTags（normalizeTags 由下游 composeRecordLocally 处理）
    const mergedTags = [...rewritePatches.flatMap(p => p.tags || []), ...tailTags];

    return {
        rewriteStartRound: boundary.rewriteStartRound,
        rewriteEndRound: totalRounds,
        phaseMarkdown,
        tailMarkdown,
        tags: mergedTags,
        warnings: acc.warnings,
    };
}

async function generateRecordWithLocalCompose(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    existingRecord: string,
    resumeFromRound: number,
    patches: RecordPatch[],
    modelChain: Chain,
    options: GenerateRecordOptions,
): Promise<GenerateRecordResult> {
    throwIfRecordRunAborted(options, "进入 Local Compose 前检查到任务已终止");
    const parsedRaw = parseRecordDocument(existingRecord);
    // 从零 / 0-Phase（损坏旧 Record，或 force 重建后 existingRecord 为空）：不再硬判败，
    // 而是构造从零边界（stableEndRound=0 / rewriteStartRound=1，selectLocalComposeBoundary 对 0 Phase 已内建）
    // 走结构化串行合成，复用代码级骨架兜底（renumberPhaseMarkdown 重排编号 + relabelSerialPhaseMarkdown 强制覆写轮次标签），
    // 根治 reduce 老路「模型自由写整篇 → 出现 ## Phase 1-63 这类格式漂移被覆盖门禁误杀」。
    const fromScratch = parsedRaw.phases.length === 0;
    const parsed = fromScratch ? parseRecordDocument("") : parsedRaw;
    // 从零时不拿（可能损坏的）旧 blob 当防缩水/稳定区基线，避免坏记录污染门禁。
    const baselineRecord = fromScratch ? "" : existingRecord;
    const boundary = selectLocalComposeBoundary(parsed, resumeFromRound, totalRounds);
    const rollbackPhaseText = boundary.rollbackPhases.map(phase => phase.content).join("\n\n---\n\n");
    options.onProgress?.({
        stage: "本地合成准备",
        current: boundary.stableEndRound,
        total: totalRounds,
        unit: "轮",
        detail: `稳定区保留到第 ${boundary.stableEndRound} 轮，回滚 ${boundary.rollbackCount} 个 Phase：${boundary.reason}`,
    });
    // 估算重写区字数，决定走单次还是串行累积
    const rewritePatches = patches.filter(p => p.endRound >= boundary.rewriteStartRound);
    const rewriteCharsEstimate = rollbackPhaseText.length
        + parsed.tail.length
        + rewritePatches.reduce((sum, p) => sum + getPatchChars(p), 0);
    const rewriteRoundSpan = totalRounds - boundary.rewriteStartRound + 1;
    const useSerial = rewritePatches.length > 0
        && (rewriteRoundSpan > RECORD_COMPOSE_SERIAL_THRESHOLD_ROUNDS
            || rewriteCharsEstimate > RECORD_COMPOSE_SERIAL_THRESHOLD_CHARS);

    let delta: LocalComposeDelta;
    if (useSerial) {
        options.onProgress?.({
            stage: "本地合成串行累积",
            current: boundary.stableEndRound,
            total: totalRounds,
            unit: "轮",
            detail: `重写区估算 ${rewriteCharsEstimate} 字 > 阈值 ${RECORD_COMPOSE_SERIAL_THRESHOLD_CHARS}，改走串行累积`,
        });
        try {
            delta = await composeDeltaSerially(
                conversationId, workspace, totalRounds, totalSteps,
                boundary, parsed, rollbackPhaseText, rewritePatches, modelChain, options,
            );
        } catch (err) {
            if (isRecordGenerationAbortedError(err)) throw err;
            const msg = err instanceof Error ? err.message : String(err);
            return {
                success: false,
                error: formatRecordFailureMessage(modelChain, `串行本地合成失败：${msg}`, options),
                batches: patches.length,
                pipeline: "parallel",
            };
        }
    } else {
        const prompt = buildLocalComposePrompt(
            conversationId,
            workspace,
            totalRounds,
            totalSteps,
            boundary.stableEndRound,
            boundary.rewriteStartRound,
            rollbackPhaseText,
            parsed.tail,
            parsed.manualSupplementSnippets,
            patches,
        );
        const composeStartedAt = Date.now();
        const heartbeat = RECORD_PROGRESS_HEARTBEAT_MS > 0
            ? setInterval(() => {
                const elapsed = Math.round((Date.now() - composeStartedAt) / 1000);
                options.onProgress?.({
                    stage: "本地合成增量生成",
                    current: boundary.stableEndRound,
                    total: totalRounds,
                    unit: "轮",
                    detail: `生成第 ${boundary.rewriteStartRound}-${totalRounds} 轮结构化增量，已用 ${elapsed}s`,
                });
            }, RECORD_PROGRESS_HEARTBEAT_MS)
            : null;
        let response: RecordModelCallResult;
        try {
            response = await callRecordModelWithRetry(FLASH_MODEL, prompt, modelChain, RECORD_MODEL_TIMEOUT_MS, options);
        } finally {
            if (heartbeat) clearInterval(heartbeat);
        }
        if (!response.text) {
            return {
                success: false,
                error: formatRecordFailureMessage(modelChain, "Local Compose 增量生成失败或超时", options),
                batches: patches.length,
                pipeline: "parallel",
            };
        }
        delta = parseLocalComposeResponse(response.text, boundary.rewriteStartRound, totalRounds);
    }
    let candidate = composeRecordLocally(parsed, boundary, delta, { conversationId, workspace, totalRounds, totalSteps });
    let validation = validateComposedRecord(candidate, baselineRecord, parsed, boundary, totalRounds);
    if (!validation.ok) {
        // 诊断：第一次校验失败即落盘候选+错误，便于离线定位（不影响后续修复流程）
        try {
            const diagPath = saveTempFile("record_serial_diag", conversationId.slice(0, 8),
                `[validation errors]\n${validation.errors.join("\n")}\n\n[candidate length] ${candidate.length}\n[old record length] ${baselineRecord.length}\n[delta.phaseMarkdown length] ${delta.phaseMarkdown.length}\n[delta.warnings]\n${delta.warnings.join("\n")}\n\n=== candidate ===\n${candidate}`);
            console.error(`[record-generator] 本地合成首次校验失败，诊断已存: ${diagPath}; errors: ${validation.errors.join(" | ")}`);
        } catch { /* 诊断失败不影响主流程 */ }
        // 第一道修复：代码级轮次对齐（无模型调用，专治串行产物的轮次不连续/覆盖不足等机械问题）
        const relabeled = relabelSerialPhaseMarkdown(delta.phaseMarkdown, boundary.rewriteStartRound, totalRounds);
        if (relabeled && relabeled !== delta.phaseMarkdown.trim()) {
            const fixedDelta: LocalComposeDelta = { ...delta, phaseMarkdown: relabeled };
            const fixedCandidate = composeRecordLocally(parsed, boundary, fixedDelta, { conversationId, workspace, totalRounds, totalSteps });
            const fixedValidation = validateComposedRecord(fixedCandidate, baselineRecord, parsed, boundary, totalRounds);
            if (fixedValidation.ok) {
                delta = fixedDelta;
                candidate = fixedCandidate;
                validation = fixedValidation;
                options.onProgress?.({
                    stage: "本地合成代码级修复",
                    current: totalRounds,
                    total: totalRounds,
                    unit: "轮",
                    detail: "代码级轮次对齐修复通过，无需模型重写",
                });
            }
        }
        // 第二道修复：单次模型重写——仅非串行（小 delta）才走，避免串行长 delta 撞回长输出墙
        if (!validation.ok && !useSerial) {
            options.onProgress?.({
                stage: "本地合成增量修复",
                current: boundary.stableEndRound,
                total: totalRounds,
                unit: "轮",
                detail: `质量检查未通过，尝试修复结构化增量：${validation.errors.slice(0, 2).join("; ")}`,
            });
            const repairPrompt = buildLocalComposeRepairPrompt(totalRounds, boundary, delta, validation.errors, parsed.manualSupplementSnippets);
            const repairStartedAt = Date.now();
            const repairHeartbeat = RECORD_PROGRESS_HEARTBEAT_MS > 0
                ? setInterval(() => {
                    const elapsed = Math.round((Date.now() - repairStartedAt) / 1000);
                    options.onProgress?.({
                        stage: "本地合成增量修复",
                        current: boundary.stableEndRound,
                        total: totalRounds,
                        unit: "轮",
                        detail: `修复结构化增量，已用 ${elapsed}s`,
                    });
                }, RECORD_PROGRESS_HEARTBEAT_MS)
                : null;
            let repairResponse: RecordModelCallResult;
            try {
                repairResponse = await callRecordModelWithRetry(FLASH_MODEL, repairPrompt, modelChain, RECORD_MODEL_TIMEOUT_MS, options);
            } finally {
                if (repairHeartbeat) clearInterval(repairHeartbeat);
            }
            if (repairResponse.text) {
                delta = parseLocalComposeResponse(repairResponse.text, boundary.rewriteStartRound, totalRounds);
                candidate = composeRecordLocally(parsed, boundary, delta, { conversationId, workspace, totalRounds, totalSteps });
                validation = validateComposedRecord(candidate, baselineRecord, parsed, boundary, totalRounds);
            }
        }
    }
    if (!validation.ok) {
        const candidatePath = saveTempFile("record_candidate", conversationId.slice(0, 8), candidate);
        return {
            success: false,
            error: `Local Compose 质量检查失败，未覆盖旧 Record；候选已保存: ${candidatePath}；问题: ${validation.errors.join("; ")}`,
            batches: patches.length,
            pipeline: "parallel",
        };
    }
    const finalTags = parseRecordDocument(candidate).tags;
    return {
        success: true,
        content: candidate,
        batches: patches.length,
        coveredRounds: totalRounds,
        tags: finalTags,
        pipeline: "parallel",
    };
}

async function generateRecordParallel(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    existingRecord: string,
    chunks: RecordChunk[],
    allFormattedRounds: FormattedRecordRound[],
    modelChain: Chain,
    options: GenerateRecordOptions,
    resumeFromRound = 0,
): Promise<GenerateRecordResult> {
    throwIfRecordRunAborted(options, "进入并行 Record 生成前检查到任务已终止");
    const recordSummary = summarizeRecordStructure(existingRecord);
    const concurrency = Math.max(1, RECORD_PARALLEL_CONCURRENCY);
    options.onProgress?.({
        stage: "并行生成 RecordPatch",
        current: 0,
        total: chunks.length,
        unit: "批",
        detail: `并发 ${concurrency}，共 ${chunks.length} 个区段`,
    });

    let completed = 0;
    const patches = await mapWithConcurrency(chunks, concurrency, async (chunk, index) => {
        const adjacentContext = buildAdjacentContext(allFormattedRounds, chunk);
        const prompt = buildRecordPatchPrompt(
            conversationId,
            workspace,
            totalRounds,
            totalSteps,
            recordSummary,
            chunk.text,
            adjacentContext,
            chunk.startRound,
            chunk.endRound,
        );
        const patch = await generatePatchForChunk(conversationId, workspace, modelChain, options, prompt, chunk, index, chunks.length);
        completed++;
        options.onProgress?.({
            stage: "并行生成 RecordPatch",
            current: completed,
            total: chunks.length,
            unit: "批",
            detail: `区段 ${chunk.startRound}-${chunk.endRound} 完成`,
        });
        return patch;
    }, options);

    // 大重写区且将走串行本地合成时，跳过压缩——串行循环需要细粒度的原始 patch（每个约 10 轮），
    // 压缩会把它们合并成少数大 patch，导致串行退化成单次大输出；顺带省掉一次压缩耗时。
    // 从零长对话也要跳过压缩，保留细粒度 patch 供串行逐窗累积（压缩会把它们合并成少数大 patch → 串行退化成单次大输出）。
    const serialComposeLikely = isLocalComposeEnabled()
        && (totalRounds - resumeFromRound) > RECORD_COMPOSE_SERIAL_THRESHOLD_ROUNDS;
    const patchesForReduce = serialComposeLikely
        ? patches.slice().sort((a, b) => a.startRound - b.startRound)
        : await compressPatchesIfNeeded(
            conversationId,
            workspace,
            totalRounds,
            totalSteps,
            patches,
            modelChain,
            options,
        );
    throwIfRecordRunAborted(options, "RecordPatch 阶段完成后、整合前检查到任务已终止");

    // local-compose 现在也接管「从零 / 无旧 Record」生成：parsed.phases===0 时由 selectLocalComposeBoundary
    // 给出从零边界，走结构化串行合成 + 代码骨架兜底。从零场景不再掉进下方 reduce 老路（模型自由写整篇、
    // 无骨架兜底，曾导致 ## Phase 1-63 这类格式漂移被覆盖门禁误杀）。reduce 仅在 env 显式关闭 local-compose 时作为逃生口。
    if (isLocalComposeEnabled()) {
        return generateRecordWithLocalCompose(
            conversationId,
            workspace,
            totalRounds,
            totalSteps,
            existingRecord,
            resumeFromRound,
            patchesForReduce,
            modelChain,
            options,
        );
    }

    // R3 gate：默认情况下「有旧 Record + reduce 兜底」是禁止的——上面 local-compose 分支才是默认路径。
    // 当 RECORD_LOCAL_COMPOSE_ENABLED 被显式关闭，且有旧 Record，且未设 RECORD_FORCE_FULL_REBUILD 时，
    // 拒绝走 reduce 整篇重写老路（曾是 61157a04 类长对话的超时与压缩缩水来源）。
    // 「无旧 Record」的新建场景仍允许 reduce（首次生成无可保留稳定区）。
    if (existingRecord.trim() && !RECORD_FORCE_FULL_REBUILD) {
        return {
            success: false,
            error: "Local Compose 已关闭但有旧 Record 时，禁止退回 reduce 整篇重写老路（防超时/防缩水）。如确需旧式全量整合请设置 MEMORY_STORE_RECORD_FORCE_FULL_REBUILD=1；推荐做法是保持 MEMORY_STORE_RECORD_LOCAL_COMPOSE 启用（默认）",
            batches: chunks.length,
            pipeline: "parallel",
        };
    }

    options.onProgress?.({
        stage: "整合 RecordPatch",
        current: chunks[chunks.length - 1]?.endRound || totalRounds,
        total: totalRounds,
        unit: "轮",
        detail: `整合 ${patchesForReduce.length} 个 RecordPatch 为完整 Record`,
    });
    const reducePrompt = buildReduceRecordPrompt(conversationId, workspace, totalRounds, totalSteps, existingRecord, patchesForReduce);
    const reduceStartedAt = Date.now();
    const reduceCurrent = chunks[chunks.length - 1]?.endRound || totalRounds;
    const heartbeat = RECORD_PROGRESS_HEARTBEAT_MS > 0
        ? setInterval(() => {
            const elapsed = Math.round((Date.now() - reduceStartedAt) / 1000);
            options.onProgress?.({
                stage: "整合 RecordPatch",
                current: reduceCurrent,
                total: totalRounds,
                unit: "轮",
                detail: `整合 ${patchesForReduce.length} 个 RecordPatch 为完整 Record，已用 ${elapsed}s`,
            });
        }, RECORD_PROGRESS_HEARTBEAT_MS)
        : null;
    let response: string | null;
    try {
        response = await callFlashWithRetryChain(FLASH_MODEL, reducePrompt, modelChain, RECORD_MODEL_TIMEOUT_MS, options);
    } finally {
        if (heartbeat) clearInterval(heartbeat);
    }
    if (!response) {
        return {
            success: false,
            error: formatRecordFailureMessage(modelChain, "RecordPatch 整合失败或超时", options),
            batches: chunks.length,
            pipeline: "parallel",
        };
    }

    const { content, tags } = cleanFlashResponse(response);
    const finalContent = enforceRecordHeaderMetadata(content, { conversationId, workspace, totalRounds, totalSteps });
    return {
        success: true,
        content: finalContent,
        batches: chunks.length,
        coveredRounds: totalRounds,
        tags,
        pipeline: "parallel",
    };
}

/**
 * 生成或更新 Record
 *
 * 分批策略：
 * 1. 按实际格式化后的单轮字符数累加切批
 * 2. 默认串行仍逐批更新完整 Record
 * 3. 实验并行管线先生成 RecordPatch，再统一整合完整 Record
 */
export async function generateRecord(
    hash: string,
    conversationId: string,
    workspace: string,
    rounds: ConversationRound[],
    totalSteps: number,
    modelChain: Chain = "auto",
    options: GenerateRecordOptions = {},
): Promise<GenerateRecordResult> {
    let generationPermit: ConcurrencyGatePermit | null = null;
    try {
        if (rounds.length === 0) {
            return { success: false, error: "对话无内容" };
        }
        throwIfRecordRunAborted(options, "Record 生成启动前检查到任务已终止");

        // 读取已有 Record。force=true 默认表示“强制刷新”，但不再丢弃可解析旧 Record。
        // 超长对话直接从 0 全量重建容易把高质量旧 Record 压缩成少数 Phase；
        // 如确实需要旧式全量重建，可显式设置 MEMORY_STORE_RECORD_FORCE_FULL_REBUILD=1。
        const storedRecord = await readRecordAsync(hash, conversationId) || "";
        const forceRequested = options.force === true;
        const storedParsedForForce = storedRecord ? parseRecordDocument(storedRecord) : null;
        const preserveExistingForForce = forceRequested
            && !RECORD_FORCE_FULL_REBUILD
            && storedParsedForForce !== null
            && storedParsedForForce.phases.length > 0;
        const forceRebuild = forceRequested && !preserveExistingForForce;
        let existingRecord = forceRebuild ? "" : storedRecord;
        let currentRecord = existingRecord;
        const totalRounds = rounds.length;
        const indexBeforeRepair = (await readRecordsIndexAsync(hash)).records[conversationId];
        const indexedBeforeRepair = Math.min(Math.max(indexBeforeRepair?.lastUpdatedRound ?? 0, 0), totalRounds);
        const inferredBeforeRepair = storedRecord ? inferCoveredRoundFromRecord(storedRecord, totalRounds) : 0;
        const existingIndex = existingRecord
            ? await reconcileRecordIndexCoverage(hash, conversationId, existingRecord, totalRounds)
            : forceRebuild ? undefined : indexBeforeRepair;
        let resumeFromRound = existingRecord
            ? Math.min(Math.max(existingIndex?.lastUpdatedRound ?? 0, 0), totalRounds)
            : 0;
        const forcePreserveWarning = preserveExistingForForce
            ? "force=true 已按安全刷新处理：保留旧 Record 稳定 Phase，仅回滚尾部并继续增量合成；若确需丢弃旧 Record 全量重建，请设置 MEMORY_STORE_RECORD_FORCE_FULL_REBUILD=1"
            : undefined;
    // 只要会走 local-compose（force=true 安全刷新 / force=false 增量），就要把 resumeFromRound
    // 预先拉齐到 boundary.stableEndRound——否则 chunks 从旧 lastUpdatedRound 起，会跳过 boundary
    // 决定回滚的 Phase 所覆盖的轮次（如 lastUpdatedRound=43，回滚 2 个 Phase 后 stableEndRound=41，
    // 第 42-43 轮就会"凭空消失"，串行累积时表现为 Phase 41→44 不连续）。
    const willRunLocalCompose = isLocalComposeEnabled()
        && Boolean(existingRecord)
        && storedParsedForForce !== null
        && storedParsedForForce.phases.length > 0
        && (resumeFromRound < totalRounds || preserveExistingForForce);
    if (willRunLocalCompose) {
        const boundary = selectLocalComposeBoundary(storedParsedForForce!, resumeFromRound, totalRounds);
        // 仅当 boundary 留下了非空稳定区且回滚跨越了原 resumeFromRound（旧 Record 末段 Phase 被回滚导致空洞）才拉齐；
        // force=true 的安全刷新还必须允许单 Phase Record 回滚到 0，确保 stale/fresh 强刷会真实调用模型而非 upToDate 短路。
        if ((boundary.stablePhases.length > 0 || preserveExistingForForce) && boundary.stableEndRound < resumeFromRound) {
            resumeFromRound = Math.max(0, boundary.stableEndRound);
        }
    }
    const roundsToProcess = rounds.slice(resumeFromRound);
    const repairedCoverageWarning = storedRecord && !forceRebuild && indexBeforeRepair && inferredBeforeRepair !== indexedBeforeRepair
        ? `Record 正文实际覆盖 ${inferredBeforeRepair}/${totalRounds} 轮，索引原为 ${indexedBeforeRepair}/${totalRounds} 轮，提交时会刷新索引`
        : undefined;
    const warnings = [repairedCoverageWarning, forcePreserveWarning].filter((item): item is string => Boolean(item));
    options.onProgress?.({
        stage: roundsToProcess.length > 0 ? "准备生成 Record" : "Record 已是最新",
        current: resumeFromRound,
        total: totalRounds,
        unit: "轮",
        detail: forceRebuild
            ? `force=true，忽略旧 Record 覆盖状态，从 0/${totalRounds} 轮重建`
            : `已覆盖 ${resumeFromRound}/${totalRounds} 轮，待处理 ${roundsToProcess.length} 轮${warnings.length ? `；${warnings.join("；")}` : ""}`,
    });

    if (existingRecord && roundsToProcess.length === 0) {
        return {
            success: true,
            content: existingRecord,
            batches: 0,
            coveredRounds: totalRounds,
            tags: existingIndex?.tags || [],
            upToDate: true,
            warnings: warnings.length ? warnings : undefined,
        };
    }

    generationPermit = await acquireRecordGenerationPermit(options);
    throwIfRecordRunAborted(options, "开始格式化轮次前检查到任务已终止");
    // 只把未覆盖的新轮次送进模型；全量重写会让超长对话每次更新都超时。
    // 方案1：超大轮（>RECORD_MAX_SINGLE_ROUND_CHARS）走「step 切分→逐段压缩→合并」保内容，
    // 普通轮原样返回；任一段压缩失败整轮降级到有损截断，绝不让 Record 生成失败。
    const recordModelScope = await resolveRecordModelScope(modelChain, options);
    const budgetChain = recordModelScope.modelChain;
    const formattedRounds = await formatRoundsForRecordAsync(roundsToProcess, modelChain, options);
    const maxPromptChars = getMaxPromptChars(budgetChain);

    // 计算可用空间，并按实际轮次大小切批。
    const promptRecord = trimRecordForPrompt(currentRecord, budgetChain);
    const recordChars = charCount(promptRecord);
    const minBatchRounds = getMinBatchRounds(budgetChain);
    const availableChars = Math.max(5_000, maxPromptChars - recordChars - PROMPT_TEMPLATE_OVERHEAD);
    const parallelMode = resolveParallelMode(options.parallelMode);
    const chunkBudget = parallelMode === "off"
        ? availableChars
        : getParallelChunkBudget(formattedRounds, availableChars);
    const chunks = createRecordChunks(formattedRounds, chunkBudget, parallelMode === "off" ? minBatchRounds : 1);
    const totalChars = formattedRounds.reduce((sum, item) => sum + item.chars, 0);

    console.error(`[record-generator] modelChain=${modelChain} budgetChain=${budgetChain} budgetModel=${recordModelScope.modelName} background=${options.background ? "1" : "0"} parallelMode=${parallelMode} roundsToProcess=${roundsToProcess.length} totalChars=${totalChars} maxPromptChars=${maxPromptChars} chunkBudget=${chunkBudget} chunks=${chunks.length}`);
    options.onProgress?.({
        stage: "计算批次",
        current: resumeFromRound,
        total: totalRounds,
        unit: "轮",
        detail: `待处理 ${roundsToProcess.length} 轮，按实际大小切为 ${chunks.length} 批`,
    });

    const promptWouldBeHeavy = recordChars + totalChars + PROMPT_TEMPLATE_OVERHEAD > maxPromptChars * 0.75;
    if ((preserveExistingForForce && Boolean(existingRecord.trim())) || shouldUseParallelPipeline(parallelMode, chunks, {
        existingRecordChars: existingRecord.length,
        promptWouldBeHeavy,
    })) {
        try {
            const parallelResult = await generateRecordParallel(
                conversationId,
                workspace,
                totalRounds,
                totalSteps,
                existingRecord,
                chunks,
                formattedRounds,
                modelChain,
                options,
                resumeFromRound,
            );
            const mergedParallelResult = warnings.length && parallelResult.success
                ? { ...parallelResult, warnings: [...(parallelResult.warnings || []), ...warnings] }
                : parallelResult;
            return withRecordModelUsage(mergedParallelResult, options);
        } catch (err) {
            if (isRecordGenerationAbortedError(err)) throw err;
            const message = err instanceof Error ? err.message : String(err);
            return withRecordModelUsage({
                success: false,
                error: isLocalTextModelBridge(modelChain) ? localBridgeRecordFailureHint(modelChain, message) : message,
                batches: chunks.length,
                pipeline: "parallel",
            }, options);
        }
    }

    // 判断是否需要分批
    if (chunks.length === 1) {
        // 一次性处理
        const onlyChunk = chunks[0];
        options.onProgress?.({
            stage: "模型生成",
            current: resumeFromRound,
            total: totalRounds,
            unit: "轮",
            detail: `单批处理${roundRangeLabel(onlyChunk.startRound, onlyChunk.endRound)}，${onlyChunk.chars} 字`,
        });
        throwIfRecordRunAborted(options, `单批 ${roundRangeLabel(onlyChunk.startRound, onlyChunk.endRound)} 模型调用前检查到任务已终止`);
        const prompt = promptRecord
            ? buildUpdateRecordPrompt(conversationId, workspace, totalRounds, totalSteps, promptRecord, onlyChunk.text)
            : buildNewRecordPrompt(conversationId, workspace, totalRounds, totalSteps, onlyChunk.text);

        const response = await callFlashWithRetryChain(FLASH_MODEL, prompt, modelChain, RECORD_MODEL_TIMEOUT_MS, options);
        if (!response) {
            return withRecordModelUsage({
                success: false,
                error: formatRecordFailureMessage(modelChain, "Record 模型调用失败或超时", options),
            }, options);
        }

        const { content: cleanedContent, tags } = cleanFlashResponse(response);
        const finalContent = enforceRecordHeaderMetadata(cleanedContent, { conversationId, workspace, totalRounds, totalSteps });
        const validation = validateRecordBeforeAccept(finalContent, conversationId, totalRounds, totalRounds, existingRecord);
        if (!validation.ok) {
            return withRecordModelUsage({
                success: false,
                error: validation.error,
                pipeline: "serial",
            }, options);
        }
        options.onProgress?.({
            stage: "生成完成",
            current: totalRounds,
            total: totalRounds,
            unit: "轮",
            detail: `已覆盖到第 ${totalRounds} 轮`,
        });
        return withRecordModelUsage({ success: true, content: finalContent, batches: 1, coveredRounds: totalRounds, tags, pipeline: "serial", warnings }, options);
    }

    // 分批处理
    let processedUpTo = 0;
    let batchCount = 0;
    let lastTags: string[] = [];

    while (processedUpTo < formattedRounds.length) {
        batchCount++;
        throwIfRecordRunAborted(options, `第 ${batchCount}/${chunks.length} 批开始前检查到任务已终止`);
        const curPromptRecord = trimRecordForPrompt(currentRecord, budgetChain);
        const curRecordChars = charCount(curPromptRecord);
        const curAvailable = Math.max(5_000, maxPromptChars - curRecordChars - PROMPT_TEMPLATE_OVERHEAD);
        const [chunk] = createRecordChunks(formattedRounds.slice(processedUpTo), curAvailable, minBatchRounds);
        if (!chunk) break;
        options.onProgress?.({
            stage: "模型分批生成",
            current: chunk.startRound - 1,
            total: totalRounds,
            unit: "轮",
            detail: `第 ${batchCount}/${chunks.length} 批处理中，${roundRangeLabel(chunk.startRound, chunk.endRound)}，${chunk.chars} 字`,
        });

        // 构建 prompt
        const prompt = curPromptRecord
            ? buildUpdateRecordPrompt(conversationId, workspace, totalRounds, totalSteps, curPromptRecord, chunk.text)
            : buildNewRecordPrompt(conversationId, workspace, chunk.endRound, totalSteps, chunk.text);

        const response = await callFlashWithRetryChain(FLASH_MODEL, prompt, modelChain, RECORD_MODEL_TIMEOUT_MS, options);
        if (!response) {
            // 部分完成
            if (currentRecord && currentRecord !== existingRecord) {
                return withRecordModelUsage({
                    success: true,
                    content: currentRecord,
                    batches: batchCount,
                    coveredRounds: chunk.startRound - 1,
                    error: formatRecordBatchFailureMessage(modelChain, batchCount, chunk.startRound - 1, options),
                    pipeline: "serial",
                }, options);
            }
            return withRecordModelUsage({
                success: false,
                error: formatRecordFailureMessage(modelChain, `在第 ${batchCount} 批调用失败或超时`, options),
            }, options);
        }

        const { content: batchContent, tags: batchTags } = cleanFlashResponse(response);
        const candidateRecord = enforceRecordHeaderMetadata(batchContent, { conversationId, workspace, totalRounds, totalSteps });
        const validation = validateRecordBeforeAccept(candidateRecord, conversationId, totalRounds, chunk.endRound, currentRecord || existingRecord);
        if (!validation.ok) {
            if (currentRecord && currentRecord !== existingRecord) {
                return withRecordModelUsage({
                    success: true,
                    content: currentRecord,
                    batches: batchCount,
                    coveredRounds: chunk.startRound - 1,
                    error: validation.error,
                    pipeline: "serial",
                    warnings,
                }, options);
            }
            return withRecordModelUsage({
                success: false,
                error: validation.error,
                pipeline: "serial",
            }, options);
        }
        currentRecord = candidateRecord;
        lastTags = batchTags;
        processedUpTo += chunk.rounds.length;

        console.error(`[record-generator] 第 ${batchCount} 批完成，覆盖到第 ${chunk.endRound}/${totalRounds} 轮`);
        options.onProgress?.({
            stage: "模型分批生成",
            current: chunk.endRound,
            total: totalRounds,
            unit: "轮",
            detail: `第 ${batchCount} 批完成，已覆盖到第 ${chunk.endRound}/${totalRounds} 轮`,
        });
    }

    options.onProgress?.({
        stage: "生成完成",
        current: totalRounds,
        total: totalRounds,
        unit: "轮",
        detail: `分 ${batchCount} 批完成`,
    });
    return withRecordModelUsage({ success: true, content: currentRecord, batches: batchCount, coveredRounds: totalRounds, tags: lastTags, pipeline: "serial", warnings }, options);
    } catch (err) {
        if (isRecordGenerationAbortedError(err)) {
            return withRecordModelUsage({
                success: false,
                error: err.message,
                aborted: true,
                abortReason: err.reason,
            }, options);
        }
        throw err;
    } finally {
        generationPermit?.release();
    }
}

/**
 * 异步检查是否需要自动触发 Record 更新，供会话读取与生命周期热路径使用。
 * 保留 shouldAutoUpdateRecord 的同步兼容 API 给非热路径调用方。
 */
export async function shouldAutoUpdateRecordAsync(
    hash: string,
    conversationId: string,
    currentTotalRounds: number,
): Promise<boolean> {
    const index = await readRecordsIndexAsync(hash);
    const entry = index.records[conversationId];
    if (!entry) {
        return currentTotalRounds >= RECORD_AUTO_THRESHOLD;
    }
    return (currentTotalRounds - entry.lastUpdatedRound) >= RECORD_AUTO_THRESHOLD;
}

/**
 * 检查是否需要自动触发 Record 更新
 * @returns true 表示需要更新
 */
export function shouldAutoUpdateRecord(
    hash: string,
    conversationId: string,
    currentTotalRounds: number,
): boolean {
    const index = readRecordsIndex(hash);
    const entry = index.records[conversationId];
    if (!entry) {
        // 首次：超过阈值就触发
        return currentTotalRounds >= RECORD_AUTO_THRESHOLD;
    }
    // 已有 Record：新增轮次超过阈值
    return (currentTotalRounds - entry.lastUpdatedRound) >= RECORD_AUTO_THRESHOLD;
}
