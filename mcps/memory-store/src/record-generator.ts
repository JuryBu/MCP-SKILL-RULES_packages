import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { formatRound, type ConversationRound } from "./trajectory.js";
import {
    readRecord, readRecordsIndex, writeRecordsIndex,
    type RecordIndexEntry,
} from "./record-store.js";
import { callModelResponse } from "./model-bridge.js";
import type { Chain } from "./chain.js";
import { saveTempFile, TEMP_DIR } from "./temp-store.js";
import { DEFAULT_ANTIGRAVITY_LS_MODEL } from "./ls-model-defaults.js";

/**
 * Record 生成引擎
 *
 * 调用 Flash 模型基于对话内容生成/更新对话记录（Record）。
 * 支持分批生成：超长对话自动分批，已有 Record 作为前文摘要回填。
 *
 * v1.8 新增
 */

// ============= 常量 =============

/** Flash 模型标识符 */
const FLASH_MODEL = process.env.MEMORY_STORE_LS_MODEL || DEFAULT_ANTIGRAVITY_LS_MODEL;

/** 总 Prompt 字符数上限（Flash 1M token ≈ 3-4M chars，取 500K 留足余量） */
const MAX_PROMPT_CHARS = 500_000;

/** Codex CLI 模型桥不适合一次吞超长上下文，按较小批次稳定生成。 */
const CODEX_RECORD_MAX_PROMPT_CHARS = Number(process.env.MEMORY_STORE_CODEX_RECORD_MAX_PROMPT_CHARS || 60_000);

/** Codex 更新 Record 时携带的已有 Record 上下文上限，避免后期 Record 变长拖垮单批 prompt。 */
const CODEX_RECORD_CONTEXT_CHARS = Number(process.env.MEMORY_STORE_CODEX_RECORD_CONTEXT_CHARS || 30_000);

/** Prompt 模板固定开销 */
const PROMPT_TEMPLATE_OVERHEAD = 2_000;

/** 每批至少取的轮次数 */
const MIN_BATCH_ROUNDS = 5;

/** 自动触发 Record 更新的新增轮次阈值 */
export const RECORD_AUTO_THRESHOLD = 3;

/** Codex 宿主工具调用有隐性超时，同步 Record 模型桥必须快失败。 */
const CODEX_RECORD_TIMEOUT_MS = Number(process.env.MEMORY_STORE_CODEX_RECORD_TIMEOUT || 45_000);
/** 后台 Record 更新不占用宿主同步调用窗口，可以给 Codex 更长生成时间。 */
const CODEX_RECORD_BACKGROUND_TIMEOUT_MS = Number(process.env.MEMORY_STORE_CODEX_RECORD_BACKGROUND_TIMEOUT || 8 * 60_000);
/** Antigravity/LS Record 模型调用超时，独立于其它轻量模型调用。 */
const RECORD_MODEL_TIMEOUT_MS = Number(process.env.MEMORY_STORE_RECORD_MODEL_TIMEOUT || 180_000);
/** 长模型调用阶段的后台进度心跳间隔。 */
const RECORD_PROGRESS_HEARTBEAT_MS = Number(process.env.MEMORY_STORE_RECORD_PROGRESS_HEARTBEAT_MS || 30_000);
/** Codex 模型桥只对快失败轻量重试，完整超时不重试。 */
const CODEX_RECORD_RETRY_DELAY_MS = Number(process.env.MEMORY_STORE_CODEX_RECORD_RETRY_DELAY || 1_000);
/** Claude Code CLI 也是本地模型桥，默认沿用 Codex 级别的保守 Record 预算。 */
const CC_RECORD_MAX_PROMPT_CHARS = Number(process.env.MEMORY_STORE_CC_RECORD_MAX_PROMPT_CHARS || CODEX_RECORD_MAX_PROMPT_CHARS);
const CC_RECORD_CONTEXT_CHARS = Number(process.env.MEMORY_STORE_CC_RECORD_CONTEXT_CHARS || CODEX_RECORD_CONTEXT_CHARS);
const CC_RECORD_TIMEOUT_MS = Number(process.env.MEMORY_STORE_CC_RECORD_TIMEOUT_MS || 3 * 60_000);
const CC_RECORD_BACKGROUND_TIMEOUT_MS = Number(process.env.MEMORY_STORE_CC_RECORD_BACKGROUND_TIMEOUT_MS || 8 * 60_000);
const RECORD_PARALLEL_MODE = (process.env.MEMORY_STORE_RECORD_PARALLEL_MODE || "off") as RecordParallelMode;
const RECORD_PARALLEL_CONCURRENCY = Number(process.env.MEMORY_STORE_RECORD_PARALLEL_CONCURRENCY || 2);
const RECORD_PARALLEL_RETRIES = Number(process.env.MEMORY_STORE_RECORD_PARALLEL_RETRIES || 1);
const RECORD_PARALLEL_CHUNK_CHARS = Number(process.env.MEMORY_STORE_RECORD_PARALLEL_CHUNK_CHARS || 60_000);
const RECORD_PARALLEL_DENSE_TOOL_THRESHOLD = Number(process.env.MEMORY_STORE_RECORD_PARALLEL_DENSE_TOOL_THRESHOLD || 120);
const RECORD_PARALLEL_DENSE_TOOL_CHUNK_CHARS = Number(process.env.MEMORY_STORE_RECORD_PARALLEL_DENSE_TOOL_CHUNK_CHARS || 45_000);
const RECORD_REDUCE_DIRECT_PATCH_LIMIT = Number(process.env.MEMORY_STORE_RECORD_REDUCE_DIRECT_PATCH_LIMIT || 4);
const RECORD_REDUCE_GROUP_SIZE = Number(process.env.MEMORY_STORE_RECORD_REDUCE_GROUP_SIZE || 3);
const RECORD_REDUCE_GROUP_CHARS = Number(process.env.MEMORY_STORE_RECORD_REDUCE_GROUP_CHARS || 70_000);
const RECORD_REDUCE_MAX_LEVELS = Number(process.env.MEMORY_STORE_RECORD_REDUCE_MAX_LEVELS || 4);
const RECORD_LOCAL_COMPOSE_ENABLED = process.env.MEMORY_STORE_RECORD_LOCAL_COMPOSE !== "0";
const RECORD_COMPOSE_ROLLBACK_PHASES = Number(process.env.MEMORY_STORE_RECORD_COMPOSE_ROLLBACK_PHASES || 1);
const RECORD_COMPOSE_MAX_ROLLBACK_PHASES = Number(process.env.MEMORY_STORE_RECORD_COMPOSE_MAX_ROLLBACK_PHASES || 2);
const RECORD_COMPOSE_MIN_SIZE_RATIO = Number(process.env.MEMORY_STORE_RECORD_COMPOSE_MIN_SIZE_RATIO || 0.65);
const RECORD_PARALLEL_SINGLE_CHUNK_RECORD_CHARS = Number(process.env.MEMORY_STORE_RECORD_PARALLEL_SINGLE_CHUNK_RECORD_CHARS || 30_000);
const RECORD_ADJACENT_CONTEXT_ROUNDS = Number(process.env.MEMORY_STORE_RECORD_ADJACENT_CONTEXT_ROUNDS || 1);
const RECORD_ADJACENT_CONTEXT_CHARS = Number(process.env.MEMORY_STORE_RECORD_ADJACENT_CONTEXT_CHARS || 6_000);
const RECORD_PATCH_CHECKPOINT_ENABLED = process.env.MEMORY_STORE_RECORD_PATCH_CHECKPOINT !== "0";
const RECORD_PATCH_CHECKPOINT_VERSION = 1;

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

function isLocalTextModelBridge(modelChain: Chain): boolean {
    return modelChain === "codex" || modelChain === "claude-code";
}

/** Flash 调用带重试（1 次重试 + 5s 退避） */
async function callFlashWithRetry(model: string, prompt: string, timeout: number): Promise<string | null> {
    return callFlashWithRetryChain(model, prompt, "auto", timeout);
}

interface RecordModelCallResult {
    text: string | null;
    error?: string;
    timedOut?: boolean;
}

async function callRecordModelWithRetry(
    model: string,
    prompt: string,
    modelChain: Chain,
    timeout: number,
    options: GenerateRecordOptions = {},
): Promise<RecordModelCallResult> {
    const localTimeoutLimit = modelChain === "claude-code"
        ? (options.background ? CC_RECORD_BACKGROUND_TIMEOUT_MS : CC_RECORD_TIMEOUT_MS)
        : (options.background ? CODEX_RECORD_BACKGROUND_TIMEOUT_MS : CODEX_RECORD_TIMEOUT_MS);
    const effectiveTimeout = isLocalTextModelBridge(modelChain)
        ? (options.background
            ? Math.max(1, localTimeoutLimit)
            : Math.max(1, Math.min(timeout, localTimeoutLimit)))
        : timeout;
    const bridgeName = modelChain === "claude-code" ? "Claude Code CLI" : "Codex";
    const resp = await callModelResponse(model, prompt, modelChain, effectiveTimeout, {
        allowClaudeCodeFallback: options.allowClaudeCodeFallback,
    });
    if (resp.text) return { text: resp.text };
    if (isLocalTextModelBridge(modelChain)) {
        if (resp.timedOut) {
            console.error(`[record-generator] ${bridgeName} 模型调用超时，不重试: ${resp.error || "unknown error"}`);
            return { text: null, error: resp.error, timedOut: true };
        }
        console.error(`[record-generator] ${bridgeName} 模型调用快失败，${CODEX_RECORD_RETRY_DELAY_MS}ms 后重试 1 次: ${resp.error || "unknown error"}`);
        options.onProgress?.({
            stage: "模型生成重试",
            detail: `${bridgeName} 模型桥快失败，准备重试 1 次：${resp.error || "unknown error"}`,
        });
        if (CODEX_RECORD_RETRY_DELAY_MS > 0) {
            await new Promise(r => setTimeout(r, CODEX_RECORD_RETRY_DELAY_MS));
        }
        const retry = await callModelResponse(model, prompt, modelChain, effectiveTimeout, {
            allowClaudeCodeFallback: options.allowClaudeCodeFallback,
        });
        if (retry.text) return { text: retry.text };
        console.error(`[record-generator] ${bridgeName} 模型调用重试失败: ${retry.error || "unknown error"}`);
        return { text: null, error: retry.error || resp.error, timedOut: retry.timedOut };
    }
    // 第一次失败，等 5 秒重试
    console.error(`[record-generator] Flash 首次失败，5s 后重试...`);
    await new Promise(r => setTimeout(r, 5000));
    const retry = await callModelResponse(model, prompt, modelChain, timeout, {
        allowClaudeCodeFallback: options.allowClaudeCodeFallback,
    });
    return { text: retry.text, error: retry.error || resp.error, timedOut: retry.timedOut || resp.timedOut };
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

// ============= Prompt 模板 =============

function buildNewRecordPrompt(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    conversationContent: string,
): string {
    return `你是一个技术文档助手。请根据以下对话内容，按固定模板生成一份对话记录（Record）。

## 模板要求

1. 开头元数据：对话ID、工作区、时间跨度、总轮次/步骤/工具调用数
2. 按主题/任务切换点将对话划分为多个 Phase
3. 每个 Phase 包含：标题（含轮次范围）、时间、用户操作、AI执行、关键决策、产出文件（如有）
4. 末尾：产出文件总清单（如有）+ 经验教训
5. 输出纯 markdown，不要用 \`\`\` 代码块包裹整个输出
6. Phase 标题格式：## Phase N：{标题}（轮次 X-Y）
7. 在 Record 最末尾单独一行输出标签，格式：<!-- TAGS: 标签1, 标签2, 标签3 -->
   标签 5-10 个，包含：项目名、核心技术栈、关键事件、模型/工具名等
8. “对话ID”“工作区”“总轮次”“总步骤”必须逐字使用下方“对话元数据”，不要根据正文猜测或改写；如需记录其它路径，可另写“关联工作区”或“相关文件”

## 对话元数据

- 对话ID: ${conversationId}
- 工作区: ${workspace}
- 总轮次: ${totalRounds}
- 总步骤: ${totalSteps}

## 对话内容

${conversationContent}`;
}

function buildUpdateRecordPrompt(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    existingRecord: string,
    newContent: string,
): string {
    return `你是一个技术文档助手。以下是一个对话的已有 Record 和新增内容。
请基于已有 Record 和新增对话内容，更新并输出完整的 Record。

## 重要规则

1. 保持固定模板格式（Phase 结构）
2. 已有 Record 中标记了 "[手动补充]" 的内容必须保留
3. 根据新增内容合理扩展或新增 Phase
4. 输出完整的 Record（不是增量，是全文）
5. 输出纯 markdown，不要用 \`\`\` 代码块包裹整个输出
6. 在 Record 最末尾单独一行输出标签：<!-- TAGS: 标签1, 标签2, 标签3 -->
   标签 5-10 个，包含：项目名、核心技术栈、关键事件等
7. “对话ID”“工作区”“总轮次”“总步骤”必须逐字使用下方“对话元数据”，不要根据正文猜测或改写；如需记录其它路径，可另写“关联工作区”或“相关文件”

## 对话元数据

- 对话ID: ${conversationId}
- 工作区: ${workspace}
- 总轮次: ${totalRounds}
- 总步骤: ${totalSteps}

## 现有 Record

${existingRecord}

## 新增对话内容

${newContent}`;
}

function buildRecordPatchPrompt(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    recordSummary: string,
    chunkText: string,
    adjacentContext: string,
    startRound: number,
    endRound: number,
): string {
    return `你是一个技术文档助手。请把指定轮次区段整理为 RecordPatch 草稿。

## 输出格式

先输出一个 JSON 代码块，再输出 Markdown 草稿。

\`\`\`json
{
  "startRound": ${startRound},
  "endRound": ${endRound},
  "title": "本区段标题",
  "files": ["主要产出文件路径"],
  "tags": ["标签"],
  "risks": ["风险或失败点"],
  "status": "ok"
}
\`\`\`

## Phase Draft

用现有 Record 的 Phase 风格，写本区段应该纳入完整 Record 的草稿。只覆盖第 ${startRound}-${endRound} 轮，不要生成完整 Record，不要改写其它轮次。

## 对话元数据

- 对话ID: ${conversationId}
- 工作区: ${workspace}
- 总轮次: ${totalRounds}
- 总步骤: ${totalSteps}

## 旧 Record 结构摘要

${recordSummary || "(无旧 Record)"}

## 相邻轮次上下文（只用于理解边界，不要覆盖这些轮次）

${adjacentContext || "(无相邻上下文)"}

## 当前区段正文（必须覆盖）

${chunkText}`;
}

function buildReduceRecordPrompt(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    existingRecord: string,
    patches: RecordPatch[],
): string {
    const patchText = patches
        .sort((a, b) => a.startRound - b.startRound)
        .map((patch, index) => {
            const meta = {
                startRound: patch.startRound,
                endRound: patch.endRound,
                title: patch.title,
                files: patch.files,
                tags: patch.tags,
                risks: patch.risks,
                status: patch.status,
            };
            return `### Patch ${index + 1}\n\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\`\n\n${patch.markdown}`;
        })
        .join("\n\n---\n\n");

    return `你是一个技术文档助手。以下是已有 Record 和多个并行生成的 RecordPatch 草稿。
请整合所有 Patch，输出完整更新后的 Record。

## 重要规则

1. 输出完整 Record，不是增量
2. 保持 Phase 模板和轮次范围
3. 合并相邻或重复主题，避免重复文件清单
4. 保留已有 Record 中标记为 "[手动补充]" 的内容
5. 末尾输出标签：<!-- TAGS: 标签1, 标签2, 标签3 -->
6. 输出纯 markdown，不要用代码块包裹整个输出
7. 不要为了缩短篇幅而删除已有 Record 的关键 Phase 细节；已有 Phase 的任务、文件、验证和风险应尽量保留
8. 新增 Patch 可以压缩表达，但最终 Record 不能退化成只剩总览

## 对话元数据

- 对话ID: ${conversationId}
- 工作区: ${workspace}
- 总轮次: ${totalRounds}
- 总步骤: ${totalSteps}

## 现有 Record

${existingRecord || "(无旧 Record)"}

## RecordPatch 草稿

${patchText}`;
}

function buildCompressRecordPatchesPrompt(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    patches: RecordPatch[],
    groupIndex: number,
    totalGroups: number,
): string {
    const startRound = patches[0]?.startRound ?? 0;
    const endRound = patches[patches.length - 1]?.endRound ?? startRound;
    const patchText = patches
        .sort((a, b) => a.startRound - b.startRound)
        .map((patch, index) => {
            const meta = {
                startRound: patch.startRound,
                endRound: patch.endRound,
                title: patch.title,
                files: patch.files,
                tags: patch.tags,
                risks: patch.risks,
                status: patch.status,
            };
            return `### Patch ${index + 1}\n\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\`\n\n${patch.markdown}`;
        })
        .join("\n\n---\n\n");

    return `你是一个技术文档助手。请把多个 RecordPatch 草稿压缩为一个中间 RecordPatch。

## 输出格式

先输出一个 JSON 代码块，再输出 Markdown 草稿。

\`\`\`json
{
  "startRound": ${startRound},
  "endRound": ${endRound},
  "title": "本组标题",
  "files": ["主要产出文件路径"],
  "tags": ["标签"],
  "risks": ["风险或失败点"],
  "status": "ok"
}
\`\`\`

## Phase Draft

合并本组 Patch 的重复内容，保留关键决策、文件、风险、验证结果和未完成事项。只覆盖第 ${startRound}-${endRound} 轮，不要生成完整 Record。

## 对话元数据

- 对话ID: ${conversationId}
- 工作区: ${workspace}
- 总轮次: ${totalRounds}
- 总步骤: ${totalSteps}
- 当前组: ${groupIndex + 1}/${totalGroups}

## RecordPatch 草稿

${patchText}`;
}

function buildLocalComposePrompt(
    conversationId: string,
    workspace: string,
    totalRounds: number,
    totalSteps: number,
    stableEndRound: number,
    rewriteStartRound: number,
    rollbackPhaseText: string,
    oldTail: string,
    manualSupplementSnippets: string[],
    patches: RecordPatch[],
): string {
    const patchText = patches
        .sort((a, b) => a.startRound - b.startRound)
        .map((patch, index) => {
            const meta = {
                startRound: patch.startRound,
                endRound: patch.endRound,
                title: patch.title,
                files: patch.files,
                tags: patch.tags,
                risks: patch.risks,
                status: patch.status,
            };
            return `### Patch ${index + 1}\n\n\`\`\`json\n${JSON.stringify(meta, null, 2)}\n\`\`\`\n\n${patch.markdown}`;
        })
        .join("\n\n---\n\n");
    const manualText = manualSupplementSnippets.length > 0
        ? manualSupplementSnippets.map((snippet, index) => `${index + 1}. ${snippet}`).join("\n")
        : "(无手动补充)";

    return `你是一个技术文档助手。请输出 Record 的结构化增量，不要输出完整 Record。

## 重要规则

1. 只生成第 ${rewriteStartRound}-${totalRounds} 轮附近的衔接 Phase、新增 Phase 和新版尾部。
2. 不要复述稳定区旧 Phase；稳定区已由代码原样保留到第 ${stableEndRound} 轮。
3. 回滚 Phase 可以被延展、拆分、改名或与新增 Phase 合并，但不能丢失其中关键文件、验证、风险和结论。
4. 新增 Patch 边界要自然合并，不要保留“本批开始/本批结束”这类中间痕迹。
5. tailMarkdown 生成新版产出文件总清单、经验教训、风险/后续建议等结尾内容。
6. 输出一个 JSON 代码块，JSON 字段必须包含 rewriteStartRound、rewriteEndRound、phaseMarkdown、tailMarkdown、tags、warnings。
7. phaseMarkdown 内的 Phase 轮次必须按顺序连续覆盖 ${rewriteStartRound}-${totalRounds}，不要互相重叠，也不要留下断档；如果多个 Patch 覆盖同一阶段，请合并成一个更大的 Phase，而不是写成多个重叠 Phase。
8. 每个 Phase 标题只保留最终自然阶段名，不要保留 Patch 编号、批次编号或“压缩区段”字样。
9. 下方“必须保留的手动补充”必须原文出现在 phaseMarkdown 或 tailMarkdown 中，不得改写、摘要或删除。

## 输出格式

\`\`\`json
{
  "rewriteStartRound": ${rewriteStartRound},
  "rewriteEndRound": ${totalRounds},
  "phaseMarkdown": "## Phase ...",
  "tailMarkdown": "# 产出文件总清单\\n...",
  "tags": ["标签"],
  "warnings": []
}
\`\`\`

## 对话元数据

- 对话ID: ${conversationId}
- 工作区: ${workspace}
- 总轮次: ${totalRounds}
- 总步骤: ${totalSteps}
- 稳定区已覆盖到: ${stableEndRound}
- 需要重写起点: ${rewriteStartRound}

## 旧 Record 回滚 Phase（需要自然衔接）

${rollbackPhaseText || "(无回滚 Phase)"}

## 旧 Record 尾部（用于更新新版尾部）

${oldTail || "(无旧尾部)"}

## 必须保留的手动补充

${manualText}

## 新增/压缩后的 RecordPatch

${patchText}`;
}

function buildLocalComposeRepairPrompt(
    totalRounds: number,
    boundary: LocalComposeBoundary,
    delta: LocalComposeDelta,
    errors: string[],
    manualSupplementSnippets: string[] = [],
): string {
    const manualText = manualSupplementSnippets.length > 0
        ? manualSupplementSnippets.map((snippet, index) => `${index + 1}. ${snippet}`).join("\n")
        : "(无手动补充)";
    return `你是一个技术文档助手。下面是一份 Record 结构化增量，质量检查发现 Phase 轮次范围或结构有问题。请只修复增量 JSON，不要输出完整 Record。

## 必须修复的问题

${errors.map((error, index) => `${index + 1}. ${error}`).join("\n")}

## 修复规则

1. phaseMarkdown 必须从第 ${boundary.rewriteStartRound} 轮开始，覆盖到第 ${totalRounds} 轮。
2. Phase 按顺序排列，后一 Phase 的开始轮次必须晚于前一 Phase 的结束轮次；不要写 48-58 后又写 51-58 这类重叠范围。
3. 如果多个 Phase 在语义上属于并行/交叠工作，请合并、改名或拆成连续区间，优先保证范围连续和不重叠。
4. 保留原增量里的关键文件、验证结果、风险、经验和结论。
5. tailMarkdown 与 tags 可沿用原内容，但仍要保持唯一尾部和唯一标签语义。
6. 只输出一个 JSON 代码块，字段仍是 rewriteStartRound、rewriteEndRound、phaseMarkdown、tailMarkdown、tags、warnings。
7. 下方“必须保留的手动补充”必须原文出现在 phaseMarkdown 或 tailMarkdown 中，不得改写、摘要或删除。

## 必须保留的手动补充

${manualText}

## 原增量 JSON

\`\`\`json
${JSON.stringify(delta, null, 2)}
\`\`\``;
}

// ============= 内容提取 =============

/**
 * 将 ConversationRound[] 格式化为供 Flash 阅读的文本
 */
function formatRoundsForFlash(rounds: ConversationRound[]): string {
    const parts: string[] = [];
    for (const round of rounds) {
        parts.push(formatRound(round, "normal"));
    }
    return parts.join("\n\n---\n\n");
}

/**
 * 计算文本字符数
 */
function charCount(text: string): number {
    return text.length;
}

export interface FormattedRecordRound {
    round: ConversationRound;
    text: string;
    chars: number;
}

export interface RecordChunk {
    startRound: number;
    endRound: number;
    rounds: ConversationRound[];
    text: string;
    chars: number;
}

export interface RecordPatch {
    startRound: number;
    endRound: number;
    title: string;
    files: string[];
    tags: string[];
    risks: string[];
    status: string;
    markdown: string;
}

export type RecordParallelMode = "off" | "auto" | "force";

interface RecordPatchCheckpoint {
    version: number;
    kind: "map" | "compress";
    status: "done" | "failed" | "timeout" | "invalid";
    conversationId: string;
    workspace: string;
    modelChain: Chain;
    startRound: number;
    endRound: number;
    promptHash: string;
    savedAt: string;
    patch?: RecordPatch;
    error?: string;
}

export interface ParsedRecordPhase {
    number: number;
    title: string;
    startRound: number;
    endRound: number;
    content: string;
}

export interface ParsedRecordDocument {
    header: string;
    phases: ParsedRecordPhase[];
    tail: string;
    tags: string[];
    manualSupplementSnippets: string[];
    parseWarnings: string[];
}

export interface LocalComposeBoundary {
    stablePhases: ParsedRecordPhase[];
    rollbackPhases: ParsedRecordPhase[];
    stableEndRound: number;
    rewriteStartRound: number;
    rollbackCount: number;
    reason: string;
}

export interface LocalComposeDelta {
    rewriteStartRound: number;
    rewriteEndRound: number;
    phaseMarkdown: string;
    tailMarkdown: string;
    tags: string[];
    warnings: string[];
}

export interface ComposeValidationResult {
    ok: boolean;
    errors: string[];
    warnings: string[];
    candidatePath?: string;
}

export function formatRoundsForRecord(rounds: ConversationRound[]): FormattedRecordRound[] {
    return rounds.map((round) => {
        const text = formatRound(round, "normal");
        return { round, text, chars: charCount(text) };
    });
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

function hashText(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function safePathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function recordPatchCheckpointDir(conversationId: string): string {
    return path.join(TEMP_DIR, "record-patch-checkpoints", safePathSegment(conversationId));
}

function recordPatchCheckpointPath(
    kind: RecordPatchCheckpoint["kind"],
    conversationId: string,
    modelChain: Chain,
    startRound: number,
    endRound: number,
    promptHash: string,
): string {
    const filename = [
        kind,
        safePathSegment(modelChain),
        `${startRound}-${endRound}`,
        promptHash.slice(0, 16),
    ].join("__") + ".json";
    return path.join(recordPatchCheckpointDir(conversationId), filename);
}

function readRecordPatchCheckpoint(
    kind: RecordPatchCheckpoint["kind"],
    conversationId: string,
    modelChain: Chain,
    startRound: number,
    endRound: number,
    prompt: string,
): RecordPatch | null {
    if (!RECORD_PATCH_CHECKPOINT_ENABLED) return null;
    const promptHash = hashText(prompt);
    const filePath = recordPatchCheckpointPath(kind, conversationId, modelChain, startRound, endRound, promptHash);
    try {
        const checkpoint = JSON.parse(fs.readFileSync(filePath, "utf-8")) as RecordPatchCheckpoint;
        if (
            checkpoint.version === RECORD_PATCH_CHECKPOINT_VERSION
            && checkpoint.status === "done"
            && checkpoint.promptHash === promptHash
            && checkpoint.patch
        ) {
            return checkpoint.patch;
        }
    } catch {
        return null;
    }
    return null;
}

function writeRecordPatchCheckpoint(
    kind: RecordPatchCheckpoint["kind"],
    conversationId: string,
    workspace: string,
    modelChain: Chain,
    startRound: number,
    endRound: number,
    prompt: string,
    status: RecordPatchCheckpoint["status"],
    patch?: RecordPatch,
    error?: string,
): string | null {
    if (!RECORD_PATCH_CHECKPOINT_ENABLED) return null;
    const promptHash = hashText(prompt);
    const dir = recordPatchCheckpointDir(conversationId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = recordPatchCheckpointPath(kind, conversationId, modelChain, startRound, endRound, promptHash);
    const checkpoint: RecordPatchCheckpoint = {
        version: RECORD_PATCH_CHECKPOINT_VERSION,
        kind,
        status,
        conversationId,
        workspace,
        modelChain,
        startRound,
        endRound,
        promptHash,
        savedAt: new Date().toISOString(),
        patch,
        error,
    };
    fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), "utf-8");
    return filePath;
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

export function parseRecordPatchResponse(response: string, fallbackStartRound: number, fallbackEndRound: number): RecordPatch {
    const trimmed = response.trim();
    const jsonMatch = trimmed.match(/```json\s*([\s\S]*?)```/iu) || trimmed.match(/(\{[\s\S]*?\})/u);
    let parsed: any = {};
    if (jsonMatch) {
        try {
            parsed = JSON.parse(jsonMatch[1]);
        } catch {
            parsed = {};
        }
    }
    const markdown = jsonMatch
        ? trimmed.replace(jsonMatch[0], "").trim()
        : trimmed;
    return {
        startRound: Number(parsed.startRound) || fallbackStartRound,
        endRound: Number(parsed.endRound) || fallbackEndRound,
        title: typeof parsed.title === "string" ? parsed.title : `轮次 ${fallbackStartRound}-${fallbackEndRound}`,
        files: Array.isArray(parsed.files) ? parsed.files.map(String) : [],
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
        status: typeof parsed.status === "string" ? parsed.status : "parse_fallback",
        markdown: markdown || trimmed,
    };
}

function stripFencedCodeBlocks(text: string): string {
    return text.replace(/```[\s\S]*?```/gu, "");
}

function extractPhaseRange(text: string): { startRound: number; endRound: number; english: boolean } {
    const source = stripFencedCodeBlocks(text);
    const range = source.match(/(?:\*\*)?\s*(轮次(?:范围)?|回合|rounds?)\s*(?:\*\*)?\s*[：:]?\s*(\d+)\s*(?:[-~–—－]+|至|到|to)\s*(\d+)/iu);
    if (range) {
        return {
            startRound: Number(range[2]) || 0,
            endRound: Number(range[3]) || Number(range[2]) || 0,
            english: /^round/i.test(range[1]),
        };
    }
    const single = source.match(/(?:\*\*)?\s*(轮次(?:范围)?|回合|rounds?)\s*(?:\*\*)?\s*[：:]?\s*(\d+)/iu);
    const round = single ? Number(single[2]) || 0 : 0;
    return { startRound: round, endRound: round, english: !!single && /^round/i.test(single[1]) };
}

function normalizeCanonicalRecordLanguage(content: string): { content: string; warnings: string[] } {
    const warnings: string[] = [];
    const normalized = content.replace(
        /^(##\s*Phase\b[^\n（(]*)([（(])\s*(rounds?)\s*(\d+)\s*(?:[-~–—－]+|to)\s*(\d+)\s*([）)])/gimu,
        (_match, prefix, open, _label, start, end, close) => {
            warnings.push(`Phase 标题使用英文 Rounds，已规范为中文轮次 ${start}-${end}`);
            return `${prefix}${open}轮次 ${start}-${end}${close}`;
        },
    );
    return { content: normalized, warnings };
}

function collectManualSupplementSnippets(content: string): string[] {
    return content
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(line => line.includes("[手动补充]"));
}

function normalizeManualSupplementForCompare(text: string): string {
    return text
        .split(/\r?\n/u)
        .map(line => line
            .trim()
            .replace(/^(?:>\s*)+/u, "")
            .replace(/^(?:[-*+]\s*)+/u, "")
            .replace(/^(?:(?:\d+|[一二三四五六七八九十百千]+)[.、)]\s*)+/u, "")
            .trim())
        .join("\n")
        .replace(/\s+/gu, " ")
        .trim();
}

function hasManualSupplementSnippet(candidate: string, snippet: string): boolean {
    if (!snippet.trim()) return true;
    if (candidate.includes(snippet)) return true;
    const normalizedSnippet = normalizeManualSupplementForCompare(snippet);
    if (!normalizedSnippet) return true;
    const normalizedCandidate = normalizeManualSupplementForCompare(candidate);
    return normalizedCandidate.includes(normalizedSnippet);
}

function splitTags(content: string): { body: string; tags: string[] } {
    const tagMatches = [...content.matchAll(/^<!--\s*TAGS:\s*([\s\S]*?)-->\s*$/gimu)];
    if (tagMatches.length === 0) return { body: content.trim(), tags: [] };
    const last = tagMatches[tagMatches.length - 1];
    const tags = String(last[1] || "")
        .split(/[,，]/u)
        .map(tag => tag.trim())
        .filter(Boolean);
    return { body: content.replace(/^<!--\s*TAGS:\s*[\s\S]*?-->\s*$/gimu, "").trim(), tags };
}

function isTailHeading(line: string): boolean {
    return /^#{1,3}\s*(产出文件|文件总清单|经验教训|后续|未完成|风险|验证结果|总结|关键文件|变更清单)/u.test(line.trim());
}

export function parseRecordDocument(content: string): ParsedRecordDocument {
    const { body, tags } = splitTags(content);
    const lines = body.split(/\r?\n/u);
    const phaseHeadingRegex = /^##\s*Phase\b(.*)$/iu;
    const headingIndexes: { index: number; number: number; title: string }[] = [];
    const parseWarnings: string[] = [];
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
        if (/^\s*```/u.test(lines[i])) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        const match = lines[i].match(phaseHeadingRegex);
        if (match) {
            const parsedHeading = parsePhaseHeadingSuffix(match[1] || "", headingIndexes.length + 1);
            headingIndexes.push({ index: i, number: parsedHeading.number, title: parsedHeading.title });
        }
    }

    if (headingIndexes.length === 0) {
        return {
            header: body.trim(),
            phases: [],
            tail: "",
            tags,
            manualSupplementSnippets: collectManualSupplementSnippets(content),
            parseWarnings: ["未找到 Phase 标题"],
        };
    }

    const header = lines.slice(0, headingIndexes[0].index).join("\n").trim();
    const phases: ParsedRecordPhase[] = [];
    let tailStart = lines.length;

    for (let i = 0; i < headingIndexes.length; i++) {
        const heading = headingIndexes[i];
        const nextHeadingIndex = headingIndexes[i + 1]?.index ?? lines.length;
        let endIndex = nextHeadingIndex;
        if (i === headingIndexes.length - 1) {
            for (let j = heading.index + 1; j < nextHeadingIndex; j++) {
                if (isTailHeading(lines[j])) {
                    endIndex = j;
                    tailStart = j;
                    break;
                }
            }
        }
        const phaseContent = lines.slice(heading.index, endIndex).join("\n").trim();
        const headingRange = extractPhaseRange(lines[heading.index]);
        const contentRange = headingRange.startRound === 0 || headingRange.endRound === 0
            ? extractPhaseRange(phaseContent)
            : headingRange;
        const { startRound, endRound } = contentRange;
        if (contentRange.english) {
            parseWarnings.push(`Phase ${heading.number} 使用英文 Rounds 轮次标记，建议规范为中文“轮次”`);
        }
        if (startRound === 0 || endRound === 0) {
            parseWarnings.push(`Phase ${heading.number} 缺少可解析轮次范围`);
        }
        phases.push({
            number: heading.number,
            title: heading.title,
            startRound,
            endRound,
            content: phaseContent,
        });
    }

    const tail = tailStart < lines.length
        ? lines.slice(tailStart).join("\n").trim()
        : "";

    return {
        header,
        phases,
        tail,
        tags,
        manualSupplementSnippets: collectManualSupplementSnippets(content),
        parseWarnings,
    };
}

function parsePhaseHeadingSuffix(suffix: string, fallbackNumber: number): { number: number; title: string } {
    const raw = suffix || "";
    const rangeLabel = raw.match(/^\s*\d+\s*[-~–—－]\s*\d+/u);
    if (rangeLabel) {
        return {
            number: fallbackNumber,
            title: raw.replace(/^[\s：:.\-、]+/u, "").trim(),
        };
    }

    const ordinal = raw.match(/^\s*(\d+)/u);
    if (ordinal) {
        return {
            number: Number(ordinal[1]) || fallbackNumber,
            title: raw.slice(ordinal[0].length).replace(/^[\s：:.\-、]+/u, "").trim(),
        };
    }

    return {
        number: fallbackNumber,
        title: raw.replace(/^[\s：:.\-、]+/u, "").trim(),
    };
}

function hasOpenPhaseSignal(phase: ParsedRecordPhase, tail: string): boolean {
    const text = `${phase.title}\n${phase.content}\n${tail}`;
    return /进行中|未完成|待验证|阻塞|失败|下一步|Stage Guard 未通过|异常|自指|待修复/iu.test(text);
}

export function selectLocalComposeBoundary(
    parsed: ParsedRecordDocument,
    resumeFromRound: number,
    totalRounds: number,
): LocalComposeBoundary {
    if (parsed.phases.length === 0) {
        return {
            stablePhases: [],
            rollbackPhases: [],
            stableEndRound: 0,
            rewriteStartRound: Math.max(1, resumeFromRound + 1),
            rollbackCount: 0,
            reason: "无可解析 Phase",
        };
    }

    const maxRollback = Math.max(1, Math.min(RECORD_COMPOSE_MAX_ROLLBACK_PHASES, parsed.phases.length));
    let rollbackCount = Math.max(1, Math.min(RECORD_COMPOSE_ROLLBACK_PHASES, maxRollback));
    const last = parsed.phases[parsed.phases.length - 1];
    const lastSpan = last.startRound > 0 && last.endRound >= last.startRound
        ? last.endRound - last.startRound + 1
        : 0;
    const addedRounds = Math.max(0, totalRounds - resumeFromRound);
    let reason = "默认回滚最后 1 个 Phase";

    if (hasOpenPhaseSignal(last, parsed.tail)) {
        reason = "最后 Phase 或尾部呈现开放状态，至少回滚最后 Phase";
    }
    if (maxRollback >= 2 && lastSpan > 0 && lastSpan <= 3 && addedRounds >= 10) {
        rollbackCount = Math.max(rollbackCount, 2);
        reason = "最后 Phase 较短且新增轮次较多";
    }

    const splitIndex = Math.max(0, parsed.phases.length - rollbackCount);
    const stablePhases = parsed.phases.slice(0, splitIndex);
    const rollbackPhases = parsed.phases.slice(splitIndex);
    const stableEndRound = stablePhases[stablePhases.length - 1]?.endRound || 0;
    const rewriteStartRound = rollbackPhases[0]?.startRound || Math.max(1, resumeFromRound + 1);

    return { stablePhases, rollbackPhases, stableEndRound, rewriteStartRound, rollbackCount, reason };
}

export function parseLocalComposeResponse(response: string, fallbackStartRound: number, fallbackEndRound: number): LocalComposeDelta {
    const trimmed = response.trim();
    const jsonMatch = trimmed.match(/```json\s*([\s\S]*?)```/iu) || trimmed.match(/(\{[\s\S]*\})/u);
    let parsed: any = {};
    if (jsonMatch) {
        try {
            parsed = JSON.parse(jsonMatch[1]);
        } catch {
            parsed = {};
        }
    }
    const markdownFallback = jsonMatch ? trimmed.replace(jsonMatch[0], "").trim() : trimmed;
    const rawPhaseMarkdown = typeof parsed.phaseMarkdown === "string" && parsed.phaseMarkdown.trim()
        ? parsed.phaseMarkdown.trim()
        : markdownFallback;
    return {
        rewriteStartRound: Number(parsed.rewriteStartRound) || fallbackStartRound,
        rewriteEndRound: Number(parsed.rewriteEndRound) || fallbackEndRound,
        phaseMarkdown: dropStaleLocalComposePhases(rawPhaseMarkdown, fallbackStartRound),
        tailMarkdown: typeof parsed.tailMarkdown === "string" ? parsed.tailMarkdown.trim() : "",
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).filter(Boolean) : [],
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String).filter(Boolean) : [],
    };
}

function dropStaleLocalComposePhases(markdown: string, rewriteStartRound: number): string {
    if (!markdown.trim() || !/^##\s*Phase/imu.test(markdown)) return markdown.trim();
    const parsed = parseRecordDocument(markdown);
    if (parsed.phases.length === 0) return markdown.trim();
    const keptPhases = parsed.phases.filter(phase => {
        if (!phase.endRound) return true;
        return phase.endRound >= rewriteStartRound;
    });
    if (keptPhases.length === 0) return markdown.trim();
    if (keptPhases.length === parsed.phases.length) return markdown.trim();
    const parts = [
        ...keptPhases.map(phase => phase.content.trim()).filter(Boolean),
        parsed.tail.trim(),
    ].filter(Boolean);
    return parts.join("\n\n").trim();
}

function updateRecordHeader(header: string, conversationId: string, workspace: string, totalRounds: number, totalSteps: number): string {
    let next = header.trim() || "# 对话记录 Record";
    const replacements: Array<[RegExp, string]> = [
        [/^-?\s*(?:\*\*)?对话ID(?:\*\*)?[：:]\s*.*$/imu, `- 对话ID：\`${conversationId}\``],
        [/^-?\s*(?:\*\*)?工作区(?:\*\*)?[：:]\s*.*$/imu, `- 工作区：\`${workspace}\``],
        [/^-?\s*(?:\*\*)?总轮次(?:\*\*)?[：:]\s*.*$/imu, `- 总轮次：${totalRounds}`],
        [/^-?\s*(?:\*\*)?总步骤(?:\*\*)?[：:]\s*.*$/imu, `- 总步骤：${totalSteps}`],
    ];
    for (const [pattern, replacement] of replacements) {
        next = pattern.test(next) ? next.replace(pattern, replacement) : `${next}\n${replacement}`;
    }
    return next.trim();
}

export function enforceRecordHeaderMetadata(
    content: string,
    metadata: { conversationId: string; workspace: string; totalRounds: number; totalSteps: number },
): string {
    const normalized = normalizeCanonicalRecordLanguage(content).content;
    const parsed = parseRecordDocument(normalized);
    const header = updateRecordHeader(parsed.header, metadata.conversationId, metadata.workspace, metadata.totalRounds, metadata.totalSteps);
    if (parsed.phases.length === 0) {
        const tags = normalizeTags(parsed.tags);
        const parts = [header];
        if (tags.length > 0) {
            parts.push(`<!-- TAGS: ${tags.join(", ")} -->`);
        }
        return `${parts.join("\n\n")}\n`;
    }
    const phasesText = parsed.phases.map(phase => phase.content).join("\n\n").trim();
    const tags = normalizeTags(parsed.tags);
    const parts = [header, phasesText, parsed.tail]
        .map(part => part.trim())
        .filter(Boolean);
    if (tags.length > 0) {
        parts.push(`<!-- TAGS: ${tags.join(", ")} -->`);
    }
    return `${parts.join("\n\n")}\n`;
}

function normalizeRenumberedPhaseSuffix(rest: string): string {
    const trimmed = rest.trimStart();
    if (!trimmed) return "";
    if (/^[（(]/u.test(trimmed)) return trimmed;
    const text = trimmed.replace(/^[：:.\-、]\s*/u, "").trimStart();
    return text ? `：${text}` : "";
}

function renumberPhaseMarkdown(markdown: string, startNumber = 1): string {
    let current = startNumber;
    return markdown.replace(/^##\s*Phase\b(.*)$/gimu, (_match, suffix) => {
        let rest = String(suffix || "");
        const rangeLabel = rest.match(/^\s*\d+\s*[-~–—－]\s*\d+/u);
        const ordinal = rangeLabel ? null : rest.match(/^\s*\d+/u);
        if (ordinal) {
            rest = rest.slice(ordinal[0].length);
        } else if (rangeLabel) {
            rest = rest.slice(rangeLabel[0].length);
        }
        return `## Phase ${current++}${normalizeRenumberedPhaseSuffix(rest)}`;
    });
}

function normalizeTags(tags: string[]): string[] {
    return [...new Set(tags.map(tag => tag.trim()).filter(Boolean))].slice(0, 12);
}

export function composeRecordLocally(
    parsed: ParsedRecordDocument,
    boundary: LocalComposeBoundary,
    delta: LocalComposeDelta,
    metadata: { conversationId: string; workspace: string; totalRounds: number; totalSteps: number },
): string {
    const header = updateRecordHeader(parsed.header, metadata.conversationId, metadata.workspace, metadata.totalRounds, metadata.totalSteps);
    const stableText = boundary.stablePhases.map(phase => phase.content).join("\n\n").trim();
    const phaseStartNumber = boundary.stablePhases.length + 1;
    const rewritten = renumberPhaseMarkdown(delta.phaseMarkdown.trim(), phaseStartNumber);
    const tail = delta.tailMarkdown.trim() || parsed.tail.trim();
    const tags = normalizeTags(delta.tags.length > 0 ? delta.tags : parsed.tags);
    const parts = [header, stableText, rewritten, tail]
        .map(part => part.trim())
        .filter(Boolean);
    if (tags.length > 0) {
        parts.push(`<!-- TAGS: ${tags.join(", ")} -->`);
    }
    return `${normalizeCanonicalRecordLanguage(parts.join("\n\n")).content}\n`;
}

export function validateComposedRecord(
    candidate: string,
    oldRecord: string,
    parsed: ParsedRecordDocument,
    boundary: LocalComposeBoundary,
    totalRounds: number,
): ComposeValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const candidateCovered = inferCoveredRoundFromRecord(candidate, totalRounds);
    if (candidateCovered < totalRounds) {
        errors.push(`候选 Record 只覆盖到第 ${candidateCovered} 轮，目标是第 ${totalRounds} 轮`);
    }
    for (const phase of boundary.stablePhases) {
        if (phase.content && !candidate.includes(phase.content)) {
            errors.push(`稳定区 Phase ${phase.number} 未原样保留`);
            break;
        }
    }
    for (const snippet of parsed.manualSupplementSnippets) {
        if (snippet && !hasManualSupplementSnippet(candidate, snippet)) {
            errors.push(`缺少手动补充内容: ${snippet.slice(0, 80)}`);
            break;
        }
    }
    const tagCount = (candidate.match(/<!--\s*TAGS:/giu) || []).length;
    if (tagCount !== 1) {
        errors.push(`TAGS 数量异常: ${tagCount}`);
    }
    if (!/产出文件|经验教训|后续|风险|验证结果|总结/u.test(candidate)) {
        warnings.push("候选 Record 缺少明显尾部总结/经验/风险段落");
    }
    const stableLength = boundary.stablePhases.map(phase => phase.content).join("\n\n").length;
    if (candidate.length < stableLength * 0.98) {
        errors.push("候选 Record 短于稳定区内容，疑似丢失旧 Phase");
    }
    if (oldRecord.length > 0 && candidate.length < oldRecord.length * RECORD_COMPOSE_MIN_SIZE_RATIO) {
        errors.push(`候选 Record 明显短于旧 Record (${candidate.length}/${oldRecord.length})，疑似过度压缩`);
    }
    const parsedCandidate = parseRecordDocument(candidate);
    for (let i = 1; i < parsedCandidate.phases.length; i++) {
        const prev = parsedCandidate.phases[i - 1];
        const cur = parsedCandidate.phases[i];
        if (cur.number !== prev.number + 1) {
            errors.push(`Phase 编号不连续: ${prev.number} -> ${cur.number}`);
            break;
        }
        const bothStable = cur.endRound > 0 && cur.endRound <= boundary.stableEndRound;
        if (bothStable) {
            continue;
        }
        if (prev.endRound > 0 && cur.startRound > 0 && cur.startRound < prev.endRound) {
            errors.push(`Phase 轮次重叠或倒退: ${prev.endRound} -> ${cur.startRound}`);
            break;
        }
        if (prev.endRound > 0 && cur.startRound > 0 && cur.startRound > prev.endRound + 1) {
            errors.push(`Phase 轮次不连续: ${prev.endRound} -> ${cur.startRound}`);
            break;
        }
    }
    return { ok: errors.length === 0, errors, warnings };
}

function getMaxPromptChars(modelChain: Chain): number {
    if (modelChain === "codex") return CODEX_RECORD_MAX_PROMPT_CHARS;
    if (modelChain === "claude-code") return CC_RECORD_MAX_PROMPT_CHARS;
    return MAX_PROMPT_CHARS;
}

function getMinBatchRounds(modelChain: Chain): number {
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
    return [
        record.slice(0, headChars),
        "",
        `<!-- Record 中段已为 ${bridgeName} 模型桥压缩省略，原始 Record 总长 ${record.length} 字；请保持已有结构并优先基于末尾最新阶段续写。 -->`,
        "",
        record.slice(-tailChars),
    ].join("\n");
}

function extractRecordTitle(content: string): string | null {
    const match = content.match(/^#\s*(?:Record|对话记录 Record)[：:]\s*(.+)$/m);
    return match?.[1]?.trim() || null;
}

function inferRecordTotalRounds(content: string): number {
    const match = content.match(/总轮次[：:]\s*`?(\d+)/u);
    return match ? Number(match[1]) : 0;
}

export function validateRecordCandidateForWrite(
    content: string,
    conversationId: string,
    totalRounds: number,
    expectedCoveredRound: number,
    options: { oldRecord?: string; strictShrinkCheck?: boolean } = {},
): { ok: true; warnings: string[] } | { ok: false; error: string; candidatePath: string; warnings: string[] } {
    const phaseCount = countPhasesInRecord(content);
    const oldPhaseCount = options.oldRecord ? countPhasesInRecord(options.oldRecord) : 0;
    const coveredRound = inferCoveredRoundFromRecord(content, totalRounds);
    const errors: string[] = [];
    const warnings: string[] = [];
    if (phaseCount === 0 && (totalRounds >= 3 || oldPhaseCount > 0)) {
        errors.push("候选 Record 未识别到任何 Phase");
    }
    if (oldPhaseCount > 0 && phaseCount === 0) {
        errors.push("旧 Record 已有 Phase，候选却变成 0 Phase，疑似模型输出格式崩坏");
    }
    if (expectedCoveredRound > 0 && coveredRound < expectedCoveredRound) {
        errors.push(`候选 Record 只明确覆盖到第 ${coveredRound} 轮，目标至少第 ${expectedCoveredRound} 轮`);
    }
    if (options.oldRecord && options.strictShrinkCheck !== false && options.oldRecord.length > 2000 && content.length < options.oldRecord.length * RECORD_COMPOSE_MIN_SIZE_RATIO) {
        errors.push(`候选 Record 明显短于旧 Record (${content.length}/${options.oldRecord.length})，疑似过度压缩`);
    }
    const parsed = parseRecordDocument(content);
    for (let i = 1; i < parsed.phases.length; i++) {
        const prev = parsed.phases[i - 1];
        const cur = parsed.phases[i];
        if (cur.number !== prev.number + 1) {
            errors.push(`Phase 编号不连续: ${prev.number} -> ${cur.number}`);
            break;
        }
        if (prev.endRound > 0 && cur.startRound > 0 && cur.startRound < prev.endRound) {
            errors.push(`Phase 轮次重叠或倒退: ${prev.endRound} -> ${cur.startRound}`);
            break;
        }
        if (prev.endRound > 0 && cur.startRound > 0 && cur.startRound > prev.endRound + 1) {
            warnings.push(`Phase 轮次存在空洞: ${prev.endRound} -> ${cur.startRound}`);
        }
    }
    if (phaseCount > 0 && !/产出文件|经验教训|后续|风险|验证结果|总结/u.test(content)) {
        warnings.push("候选 Record 缺少明显尾部总结/经验/风险段落");
    }
    if (errors.length === 0) return { ok: true, warnings };
    const candidatePath = saveTempFile("record_candidate_rejected", conversationId.slice(0, 8), content);
    return {
        ok: false,
        error: `${errors.join("; ")}；已拒绝覆盖正式 Record，候选已保存: ${candidatePath}`,
        candidatePath,
        warnings,
    };
}

function validateRecordBeforeAccept(
    content: string,
    conversationId: string,
    totalRounds: number,
    expectedCoveredRound: number,
): { ok: true } | { ok: false; error: string; candidatePath: string } {
    const result = validateRecordCandidateForWrite(content, conversationId, totalRounds, expectedCoveredRound, {
        strictShrinkCheck: false,
    });
    return result.ok ? { ok: true } : { ok: false, error: result.error, candidatePath: result.candidatePath };
}

/**
 * 从 Record 正文推断它实际覆盖到的轮次。
 *
 * 只使用明确的覆盖声明、Phase 标题或 Phase 内轮次范围。
 * 不能用头部“总轮次”兜底，否则坏 Record 会把目标总轮次误当作正文已覆盖轮次。
 */
export function inferCoveredRoundFromRecord(content: string, currentTotalRounds: number): number {
    let covered = 0;
    const update = (value: number) => {
        if (Number.isFinite(value) && value > covered) {
            covered = value;
        }
    };

    const parsed = parseRecordDocument(content);
    for (const phase of parsed.phases) {
        update(phase.endRound);
    }

    let inFence = false;
    for (const rawLine of content.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (/^\s*```/u.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;
        if (!line || /总轮次/u.test(line)) continue;

        const isExplicitCoverageComment = /^<!--.*(?:当前明确覆盖到|已覆盖到|覆盖到)第?\s*\d+\s*轮.*-->$/u.test(line);

        if (isExplicitCoverageComment) {
            const match = line.match(/(?:当前明确覆盖到|已覆盖到|覆盖到)第?\s*(\d+)\s*轮/u);
            if (match) update(Number(match[1]));
        }
    }

    return Math.min(Math.max(covered, 0), currentTotalRounds);
}

async function reconcileRecordIndexCoverage(
    hash: string,
    conversationId: string,
    existingRecord: string,
    totalRounds: number,
): Promise<RecordIndexEntry | undefined> {
    const index = readRecordsIndex(hash);
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

    index.records[conversationId] = repaired;
    await writeRecordsIndex(hash, index);
    console.error(
        `[record-generator] 修正 Record 索引覆盖轮次: ${conversationId.slice(0, 8)} ${indexedRound} → ${inferredCoveredRound}`
    );
    return repaired;
}

// ============= 核心生成逻辑 =============

export interface GenerateRecordResult {
    success: boolean;
    content?: string;
    error?: string;
    batches?: number;
    coveredRounds?: number;
    tags?: string[];
    pipeline?: "serial" | "parallel";
    upToDate?: boolean;
    warnings?: string[];
}

export interface GenerateRecordOptions {
    background?: boolean;
    allowClaudeCodeFallback?: boolean;
    parallelMode?: RecordParallelMode;
    force?: boolean;
    onProgress?: (progress: {
        stage?: string;
        detail?: string;
        current?: number;
        total?: number;
        unit?: string;
    }) => void;
}

async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
        while (next < items.length) {
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
    const cached = readRecordPatchCheckpoint("map", conversationId, modelChain, chunk.startRound, chunk.endRound, prompt);
    if (cached) {
        options.onProgress?.({
            stage: "并行生成 RecordPatch",
            current: chunkIndex + 1,
            total: totalChunks,
            unit: "批",
            detail: `复用已完成区段缓存，轮次 ${chunk.startRound}-${chunk.endRound}`,
        });
        return cached;
    }
    let lastError = "";
    for (let attempt = 0; attempt <= RECORD_PARALLEL_RETRIES; attempt++) {
        options.onProgress?.({
            stage: "并行生成 RecordPatch",
            current: chunkIndex,
            total: totalChunks,
            unit: "批",
            detail: `第 ${chunkIndex + 1}/${totalChunks} 个区段，轮次 ${chunk.startRound}-${chunk.endRound}，尝试 ${attempt + 1}/${RECORD_PARALLEL_RETRIES + 1}`,
        });
        const response = await callRecordModelWithRetry(FLASH_MODEL, prompt, modelChain, RECORD_MODEL_TIMEOUT_MS, options);
        if (response.text) {
            const patch = parseRecordPatchResponse(response.text, chunk.startRound, chunk.endRound);
            const status = patch.status === "parse_fallback" ? "invalid" : "done";
            writeRecordPatchCheckpoint(
                "map",
                conversationId,
                workspace,
                modelChain,
                chunk.startRound,
                chunk.endRound,
                prompt,
                status,
                status === "done" ? patch : undefined,
                status === "invalid" ? "RecordPatch 输出缺少可解析 JSON，已隔离为 invalid" : undefined,
            );
            if (status === "invalid") {
                throw new Error(`RecordPatch 轮次 ${chunk.startRound}-${chunk.endRound} 输出格式无效，已隔离 invalid checkpoint`);
            }
            return patch;
        }
        if (response.timedOut && isLocalTextModelBridge(modelChain)) {
            const bridgeName = modelChain === "claude-code" ? "Claude Code CLI" : "Codex";
            writeRecordPatchCheckpoint("map", conversationId, workspace, modelChain, chunk.startRound, chunk.endRound, prompt, "timeout", undefined, response.error);
            throw new Error(`RecordPatch 轮次 ${chunk.startRound}-${chunk.endRound} ${bridgeName} 模型桥完整超时，不自动重试`);
        }
        lastError = `RecordPatch 轮次 ${chunk.startRound}-${chunk.endRound} 生成失败`;
    }
    writeRecordPatchCheckpoint("map", conversationId, workspace, modelChain, chunk.startRound, chunk.endRound, prompt, "failed", undefined, lastError);
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
    const prompt = buildCompressRecordPatchesPrompt(
        conversationId,
        workspace,
        totalRounds,
        totalSteps,
        patches,
        groupIndex,
        totalGroups,
    );
    const cached = readRecordPatchCheckpoint("compress", conversationId, modelChain, startRound, endRound, prompt);
    if (cached) {
        options.onProgress?.({
            stage: "压缩 RecordPatch",
            current: groupIndex + 1,
            total: totalGroups,
            unit: "组",
            detail: `复用第 ${level} 层压缩缓存，轮次 ${startRound}-${endRound}`,
        });
        return cached;
    }
    let lastError = "";
    for (let attempt = 0; attempt <= RECORD_PARALLEL_RETRIES; attempt++) {
        options.onProgress?.({
            stage: "压缩 RecordPatch",
            current: groupIndex,
            total: totalGroups,
            unit: "组",
            detail: `第 ${level} 层，第 ${groupIndex + 1}/${totalGroups} 组，轮次 ${startRound}-${endRound}，尝试 ${attempt + 1}/${RECORD_PARALLEL_RETRIES + 1}`,
        });
        const response = await callRecordModelWithRetry(FLASH_MODEL, prompt, modelChain, RECORD_MODEL_TIMEOUT_MS, options);
        if (response.text) {
            const patch = parseRecordPatchResponse(response.text, startRound, endRound);
            const status = patch.status === "parse_fallback" ? "invalid" : "done";
            writeRecordPatchCheckpoint(
                "compress",
                conversationId,
                workspace,
                modelChain,
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
            writeRecordPatchCheckpoint("compress", conversationId, workspace, modelChain, startRound, endRound, prompt, "timeout", undefined, response.error);
            throw new Error(`RecordPatch 压缩组 ${groupIndex + 1}/${totalGroups} ${bridgeName} 模型桥完整超时，不自动重试`);
        }
        lastError = response.error || `RecordPatch 压缩组 ${groupIndex + 1}/${totalGroups} 生成失败`;
    }
    writeRecordPatchCheckpoint("compress", conversationId, workspace, modelChain, startRound, endRound, prompt, "failed", undefined, lastError);
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

function groupPatchesForCompression(patches: RecordPatch[], groupSize: number, targetChars: number): RecordPatch[][] {
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
        if (wouldExceedCount || wouldExceedChars) {
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
                detail: `第 ${level} 层第 ${index + 1}/${groups.length} 组完成，轮次 ${patch.startRound}-${patch.endRound}`,
            });
            return patch;
        });
        current = current.sort((a, b) => a.startRound - b.startRound);
    }

    return current;
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
    const parsed = parseRecordDocument(existingRecord);
    if (parsed.phases.length === 0) {
        return {
            success: false,
            error: "Local Compose 失败：旧 Record 无法解析 Phase 边界，已拒绝覆盖",
            pipeline: "parallel",
        };
    }
    const boundary = selectLocalComposeBoundary(parsed, resumeFromRound, totalRounds);
    const rollbackPhaseText = boundary.rollbackPhases.map(phase => phase.content).join("\n\n---\n\n");
    options.onProgress?.({
        stage: "本地合成准备",
        current: boundary.stableEndRound,
        total: totalRounds,
        unit: "轮",
        detail: `稳定区保留到第 ${boundary.stableEndRound} 轮，回滚 ${boundary.rollbackCount} 个 Phase：${boundary.reason}`,
    });
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
            error: isLocalTextModelBridge(modelChain)
                ? localBridgeRecordFailureHint(modelChain, "Local Compose 增量生成失败或超时")
                : "Flash Local Compose 增量生成失败",
            batches: patches.length,
            pipeline: "parallel",
        };
    }

    let delta = parseLocalComposeResponse(response.text, boundary.rewriteStartRound, totalRounds);
    let candidate = composeRecordLocally(parsed, boundary, delta, { conversationId, workspace, totalRounds, totalSteps });
    let validation = validateComposedRecord(candidate, existingRecord, parsed, boundary, totalRounds);
    if (!validation.ok) {
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
            validation = validateComposedRecord(candidate, existingRecord, parsed, boundary, totalRounds);
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
    });

    const patchesForReduce = await compressPatchesIfNeeded(
        conversationId,
        workspace,
        totalRounds,
        totalSteps,
        patches,
        modelChain,
        options,
    );

    if (RECORD_LOCAL_COMPOSE_ENABLED && existingRecord.trim()) {
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
            error: isLocalTextModelBridge(modelChain)
                ? localBridgeRecordFailureHint(modelChain, "RecordPatch 整合失败或超时")
                : "Flash RecordPatch 整合失败",
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
    if (rounds.length === 0) {
        return { success: false, error: "对话无内容" };
    }

    // 读取已有 Record。force=true 表示重新生成，不让旧索引/旧正文触发“已是最新”短路。
    const storedRecord = readRecord(hash, conversationId) || "";
    const forceRebuild = options.force === true;
    let existingRecord = forceRebuild ? "" : storedRecord;
    let currentRecord = existingRecord;
    const totalRounds = rounds.length;
    const indexBeforeRepair = readRecordsIndex(hash).records[conversationId];
    const indexedBeforeRepair = Math.min(Math.max(indexBeforeRepair?.lastUpdatedRound ?? 0, 0), totalRounds);
    const inferredBeforeRepair = storedRecord ? inferCoveredRoundFromRecord(storedRecord, totalRounds) : 0;
    const existingIndex = existingRecord
        ? await reconcileRecordIndexCoverage(hash, conversationId, existingRecord, totalRounds)
        : forceRebuild ? undefined : indexBeforeRepair;
    const resumeFromRound = existingRecord
        ? Math.min(Math.max(existingIndex?.lastUpdatedRound ?? 0, 0), totalRounds)
        : 0;
    const roundsToProcess = rounds.slice(resumeFromRound);
    const repairedCoverageWarning = storedRecord && !forceRebuild && indexBeforeRepair && inferredBeforeRepair !== indexedBeforeRepair
        ? `Record 正文实际覆盖 ${inferredBeforeRepair}/${totalRounds} 轮，索引原为 ${indexedBeforeRepair}/${totalRounds} 轮，已修正并继续更新`
        : undefined;
    const warnings = repairedCoverageWarning ? [repairedCoverageWarning] : undefined;
    options.onProgress?.({
        stage: roundsToProcess.length > 0 ? "准备生成 Record" : "Record 已是最新",
        current: resumeFromRound,
        total: totalRounds,
        unit: "轮",
        detail: forceRebuild
            ? `force=true，忽略旧 Record 覆盖状态，从 0/${totalRounds} 轮重建`
            : `已覆盖 ${resumeFromRound}/${totalRounds} 轮，待处理 ${roundsToProcess.length} 轮${repairedCoverageWarning ? `；${repairedCoverageWarning}` : ""}`,
    });

    if (existingRecord && roundsToProcess.length === 0) {
        return {
            success: true,
            content: existingRecord,
            batches: 0,
            coveredRounds: totalRounds,
            tags: existingIndex?.tags || [],
            upToDate: true,
            warnings,
        };
    }

    // 只把未覆盖的新轮次送进模型；全量重写会让超长对话每次更新都超时。
    const formattedRounds = formatRoundsForRecord(roundsToProcess);
    const maxPromptChars = getMaxPromptChars(modelChain);

    // 计算可用空间，并按实际轮次大小切批。
    const promptRecord = trimRecordForPrompt(currentRecord, modelChain);
    const recordChars = charCount(promptRecord);
    const minBatchRounds = getMinBatchRounds(modelChain);
    const availableChars = Math.max(5_000, maxPromptChars - recordChars - PROMPT_TEMPLATE_OVERHEAD);
    const parallelMode = resolveParallelMode(options.parallelMode);
    const chunkBudget = parallelMode === "off"
        ? availableChars
        : getParallelChunkBudget(formattedRounds, availableChars);
    const chunks = createRecordChunks(formattedRounds, chunkBudget, parallelMode === "off" ? minBatchRounds : 1);
    const totalChars = formattedRounds.reduce((sum, item) => sum + item.chars, 0);

    console.error(`[record-generator] modelChain=${modelChain} background=${options.background ? "1" : "0"} parallelMode=${parallelMode} roundsToProcess=${roundsToProcess.length} totalChars=${totalChars} maxPromptChars=${maxPromptChars} chunkBudget=${chunkBudget} chunks=${chunks.length}`);
    options.onProgress?.({
        stage: "计算批次",
        current: resumeFromRound,
        total: totalRounds,
        unit: "轮",
        detail: `待处理 ${roundsToProcess.length} 轮，按实际大小切为 ${chunks.length} 批`,
    });

    const promptWouldBeHeavy = recordChars + totalChars + PROMPT_TEMPLATE_OVERHEAD > maxPromptChars * 0.75;
    if (shouldUseParallelPipeline(parallelMode, chunks, {
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
            return warnings && parallelResult.success
                ? { ...parallelResult, warnings: [...(parallelResult.warnings || []), ...warnings] }
                : parallelResult;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                success: false,
                error: isLocalTextModelBridge(modelChain) ? localBridgeRecordFailureHint(modelChain, message) : message,
                batches: chunks.length,
                pipeline: "parallel",
            };
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
            detail: `单批处理轮次 ${onlyChunk.startRound}-${onlyChunk.endRound}，${onlyChunk.chars} 字`,
        });
        const prompt = promptRecord
            ? buildUpdateRecordPrompt(conversationId, workspace, totalRounds, totalSteps, promptRecord, onlyChunk.text)
            : buildNewRecordPrompt(conversationId, workspace, totalRounds, totalSteps, onlyChunk.text);

        const response = await callFlashWithRetryChain(FLASH_MODEL, prompt, modelChain, RECORD_MODEL_TIMEOUT_MS, options);
        if (!response) {
            return {
                success: false,
                error: isLocalTextModelBridge(modelChain)
                    ? localBridgeRecordFailureHint(modelChain, "Record 模型桥调用失败或超时")
                    : "Flash 模型调用失败（LS 不可用或超时）",
            };
        }

        const { content: cleanedContent, tags } = cleanFlashResponse(response);
        const finalContent = enforceRecordHeaderMetadata(cleanedContent, { conversationId, workspace, totalRounds, totalSteps });
        const validation = validateRecordBeforeAccept(finalContent, conversationId, totalRounds, totalRounds);
        if (!validation.ok) {
            return {
                success: false,
                error: validation.error,
                pipeline: "serial",
            };
        }
        options.onProgress?.({
            stage: "生成完成",
            current: totalRounds,
            total: totalRounds,
            unit: "轮",
            detail: `已覆盖到第 ${totalRounds} 轮`,
        });
        return { success: true, content: finalContent, batches: 1, coveredRounds: totalRounds, tags, pipeline: "serial", warnings };
    }

    // 分批处理
    let processedUpTo = 0;
    let batchCount = 0;
    let lastTags: string[] = [];

    while (processedUpTo < formattedRounds.length) {
        batchCount++;
        const curPromptRecord = trimRecordForPrompt(currentRecord, modelChain);
        const curRecordChars = charCount(curPromptRecord);
        const curAvailable = Math.max(5_000, maxPromptChars - curRecordChars - PROMPT_TEMPLATE_OVERHEAD);
        const [chunk] = createRecordChunks(formattedRounds.slice(processedUpTo), curAvailable, minBatchRounds);
        if (!chunk) break;
        options.onProgress?.({
            stage: "模型分批生成",
            current: chunk.startRound - 1,
            total: totalRounds,
            unit: "轮",
            detail: `第 ${batchCount}/${chunks.length} 批处理中，轮次 ${chunk.startRound}-${chunk.endRound}，${chunk.chars} 字`,
        });

        // 构建 prompt
        const prompt = curPromptRecord
            ? buildUpdateRecordPrompt(conversationId, workspace, totalRounds, totalSteps, curPromptRecord, chunk.text)
            : buildNewRecordPrompt(conversationId, workspace, chunk.endRound, totalSteps, chunk.text);

        const response = await callFlashWithRetryChain(FLASH_MODEL, prompt, modelChain, RECORD_MODEL_TIMEOUT_MS, options);
        if (!response) {
            // 部分完成
            if (currentRecord && currentRecord !== existingRecord) {
                return {
                    success: true,
                    content: currentRecord,
                    batches: batchCount,
                    coveredRounds: chunk.startRound - 1,
                    error: `${isLocalTextModelBridge(modelChain) ? "本地模型桥" : "Flash"} 在第 ${batchCount} 批失败，Record 仅覆盖到第 ${chunk.startRound - 1} 轮`,
                    pipeline: "serial",
                };
            }
            return {
                success: false,
                error: isLocalTextModelBridge(modelChain)
                    ? localBridgeRecordFailureHint(modelChain, `Record 模型桥在第 ${batchCount} 批调用失败或超时`)
                    : `Flash 模型在第 ${batchCount} 批调用失败`,
            };
        }

        const { content: batchContent, tags: batchTags } = cleanFlashResponse(response);
        const candidateRecord = enforceRecordHeaderMetadata(batchContent, { conversationId, workspace, totalRounds, totalSteps });
        const validation = validateRecordBeforeAccept(candidateRecord, conversationId, totalRounds, chunk.endRound);
        if (!validation.ok) {
            if (currentRecord && currentRecord !== existingRecord) {
                return {
                    success: true,
                    content: currentRecord,
                    batches: batchCount,
                    coveredRounds: chunk.startRound - 1,
                    error: validation.error,
                    pipeline: "serial",
                    warnings,
                };
            }
            return {
                success: false,
                error: validation.error,
                pipeline: "serial",
            };
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
    return { success: true, content: currentRecord, batches: batchCount, coveredRounds: totalRounds, tags: lastTags, pipeline: "serial", warnings };
}

// ============= 辅助函数 =============

/**
 * 清理 Flash 响应（去掉代码块包裹 + 提取 tags）
 */
function cleanFlashResponse(response: string): { content: string; tags: string[] } {
    let cleaned = response.trim();
    // 去掉 ```markdown ... ``` 包裹
    if (cleaned.startsWith("```markdown")) {
        cleaned = cleaned.slice("```markdown".length);
    } else if (cleaned.startsWith("```")) {
        cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith("```")) {
        cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    // 提取 <!-- TAGS: ... --> 标签
    let tags: string[] = [];
    const tagMatch = cleaned.match(/<!--\s*TAGS:\s*(.+?)\s*-->/i);
    if (tagMatch) {
        tags = tagMatch[1].split(/[,，]/).map(t => t.trim()).filter(t => t.length > 0);
        cleaned = cleaned.replace(tagMatch[0], "").trim();
    }

    return { content: cleaned, tags };
}

/**
 * 从 Record 内容中提取 Phase 数量
 */
export function countPhasesInRecord(content: string): number {
    return parseRecordDocument(content).phases.length;
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
