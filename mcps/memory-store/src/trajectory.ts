import { saveTempFile } from "./temp-store.js";

import fs from "fs";
import path from "path";
import { TEMP_DIR, ensureTempDir } from "./temp-store.js";
import { extractAntigravityToolImages, mergeRoundAttachments } from "./conversation-attachments.js";

/**
 * Trajectory 数据解析与提取
 *
 * 将 LS API 返回的原始 trajectory JSON 转换为结构化的对话轮次，
 * 按配置提取有价值的内容到 markdown 临时文件。
 */

// ===== 类型定义 =====

export interface ConversationRound {
    roundIndex: number;          // 1-indexed
    startStep: number;           // step index in trajectory
    endStep: number;
    userMessage: string;         // 用户消息原文
    mediaAttachments: string[];  // 用户附件图片的本地路径
    attachments?: import("./conversation-attachments.js").ConversationAttachment[]; // Codex/Antigravity 附件引用（不直接输出 data URL）
    aiResponses: AiResponse[];   // AI 回复（可能多条）
    toolCalls: ToolCallInfo[];   // 工具调用列表
    taskBoundaries: TaskInfo[];  // 任务状态
    codeActions: CodeActionInfo[]; // 代码编辑
    subagentSummaries: SubagentSummary[]; // 子代理线程摘要（Codex 链路）
    fileViews?: FileViewInfo[]; // 文件/计划类视图记录（Codex 链路）
    compactionSummaries?: CompactionSummaryInfo[]; // Claude Code / 宿主压缩续聊摘要
}

export interface CompactionSummaryInfo {
    provider: "claude-code";
    kind: "compact_summary";
    text: string;
    summaryChars: number;
    summarySha256: string;
    eventLineNo?: number;
    eventByteOffset?: number;
    boundaryLineNo?: number;
    boundaryByteOffset?: number;
    boundaryUuid?: string;
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
    jsonlPath?: string;
    conversationId?: string;
    createdAt?: string;
}

export interface SubagentSummary {
    threadId: string;
    nickname: string;
    role?: string;
    prompt?: string;
    summary?: string;
}

interface AiResponse {
    stepIndex: number;
    response: string;
    thinking: string;
    toolCalls: { name: string; args: string }[];
}

interface ToolCallInfo {
    stepIndex: number;
    name: string;
    argsSummary: string;     // 参数摘要（截断到 60 字）
    resultSummary: string;   // 结果摘要（截断到 500 字）
}

interface TaskInfo {
    stepIndex: number;
    taskName: string;
    taskStatus: string;
}

interface CodeActionDiff {
    targetContent: string;       // 修改前
    replacementContent: string;  // 修改后
    startLine?: number;
    endLine?: number;
    unifiedDiff?: string;        // Codex patch_apply_end 已经提供统一 diff
}

interface FileViewInfo {
    stepIndex: number;
    kind: string;
    id?: string;
    title?: string;
    textSummary: string;
}

interface CodeActionInfo {
    stepIndex: number;
    description: string;
    targetFile: string;
    instruction: string;     // 截断到 500 字
    diffs: CodeActionDiff[];  // 完整的修改前/后对比
}

export type ExtraType = "thinking" | "tool_results" | "code_actions" | "code_diffs" | "file_views";
export type Depth = "brief" | "normal" | "full";
export type CompactionMode = "folded" | "full" | "omit";
export type ConversationMessageRole = "user" | "system" | "model" | "assistant" | "tool";

// ===== Trajectory 解析 =====

/**
 * 将原始 trajectory steps 解析为对话轮次
 */
export function parseRounds(steps: any[]): ConversationRound[] {
    const rounds: ConversationRound[] = [];
    let currentRound: ConversationRound | null = null;
    let roundIdx = 0;

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const type = step.type || "";

        if (type === "CORTEX_STEP_TYPE_USER_INPUT") {
            // 开始新轮次
            if (currentRound) {
                currentRound.endStep = i - 1;
                rounds.push(currentRound);
            }
            roundIdx++;

            const ui = step.userInput || {};
            const userMsg = ui.userResponse ||
                (ui.items || [])
                    .filter((item: any) => item.text)
                    .map((item: any) => item.text)
                    .join(" ") || "";

            // 提取用户附件图片路径
            const mediaUris: string[] = (ui.media || [])
                .filter((m: any) => m.uri && m.mimeType?.startsWith("image/"))
                .map((m: any) => m.uri);

            currentRound = {
                roundIndex: roundIdx,
                startStep: i,
                endStep: i,
                userMessage: userMsg,
                mediaAttachments: mediaUris,
                aiResponses: [],
                toolCalls: [],
                taskBoundaries: [],
                codeActions: [],
                subagentSummaries: [],
            };
        } else if (currentRound) {
            // 其他步骤归入当前轮次
            if (type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
                const pr = step.plannerResponse || {};
                currentRound.aiResponses.push({
                    stepIndex: i,
                    response: pr.response || "",
                    thinking: pr.thinking || "",
                    toolCalls: (pr.toolCalls || []).map((tc: any) => ({
                        name: tc.name || "",
                        args: truncate(tc.argumentsJson || "", 60),
                    })),
                });
            } else if (type === "CORTEX_STEP_TYPE_MCP_TOOL") {
                const mt = step.mcpTool || {};
                const tc = mt.toolCall || {};
                currentRound.toolCalls.push({
                    stepIndex: i,
                    name: tc.name || "unknown",
                    argsSummary: truncate(tc.argumentsJson || "", 60),
                    resultSummary: truncate(mt.resultString || "", 500),
                });
                // E3（must-fix）：从工具结果文本提取 AI 当时看到的图片，挂到本 step 位置。
                // 反重力 mcpTool 无 image block，图只在原始 resultString 的本地路径里（探针实测）。
                const toolImages = extractAntigravityToolImages(mt, i);
                if (toolImages.length) mergeRoundAttachments(currentRound, toolImages);
            } else if (type === "CORTEX_STEP_TYPE_TASK_BOUNDARY") {
                const tb = step.taskBoundary || {};
                currentRound.taskBoundaries.push({
                    stepIndex: i,
                    taskName: tb.taskName || "",
                    taskStatus: tb.taskStatus || "",
                });
            } else if (type === "CORTEX_STEP_TYPE_CODE_ACTION") {
                const ca = step.codeAction || {};
                const spec = ca.actionSpec || {};
                const rinfos = ca.replacementInfos || [];

                currentRound.codeActions.push({
                    stepIndex: i,
                    description: ca.description || "",
                    targetFile: spec.targetFile || "",
                    instruction: truncate(spec.instruction || "", 500),
                    diffs: rinfos.map((ri: any) => {
                        const chunk = ri.originalChunk || {};
                        return {
                            targetContent: (chunk.targetContent || "").replace(/\r/g, ""),
                            replacementContent: (chunk.replacementContent || "").replace(/\r/g, ""),
                            startLine: chunk.startLine,
                            endLine: chunk.endLine,
                        };
                    }),
                });
            }
            // EPHEMERAL_MESSAGE, CHECKPOINT, VIEW_FILE, etc. — 不提取
        }
    }

    // 关闭最后一个轮次
    if (currentRound) {
        currentRound.endStep = steps.length - 1;
        rounds.push(currentRound);
    }

    return rounds;
}

// ===== 格式化输出 =====

function escapeMarkdownLabel(input: string): string {
    return input.replace(/[\[\]\r\n]/gu, " ").trim() || "attachment";
}

function formatMarkdownUrl(input: string): string {
    const normalized = input.replace(/\\/gu, "/");
    if (/[\s()<>]/u.test(normalized)) {
        return `<${normalized.replace(/>/gu, "%3E")}>`;
    }
    return normalized;
}

type ConversationAttachment = import("./conversation-attachments.js").ConversationAttachment;

/** CC 加密 thinking 占位符（明文不可读），渲染时折叠标题不标字数。 */
function isEncryptedThinkingPlaceholder(thinking: string): boolean {
    return thinking.startsWith("🔒 加密思考块");
}

/** thinking 折叠块的 summary 文案：加密占位符不标字数（修正 C）。 */
function thinkingSummaryLabel(thinking: string): string {
    return isEncryptedThinkingPlaceholder(thinking)
        ? "💭 思考（加密思考，明文不可读）"
        : `💭 思考 (${thinking.length}字)`;
}

/**
 * 渲染单条附件为一行 markdown / 文本（从 formatRound 原内联逻辑搬出，行为逐字节一致）。
 * attachmentMode==="markdown" 时输出 `![]()` / `[]()`，否则输出纯路径。
 */
function renderAttachmentLine(
    lines: string[],
    attachment: ConversationAttachment,
    roundIndex: number,
    attachmentMode: "text" | "markdown" | undefined,
): void {
    const label = attachment.kind === "image" ? "图片" : "文件";
    const target = attachment.tempPath || attachment.originalPath || attachment.name || "JSONL 内联图片";
    const displayName = attachment.name || target.split(/[\\/]/u).pop() || `${label}-${roundIndex}`;
    const notes: string[] = [];
    if (attachment.source === "codex-data-url" && attachment.tempPath) {
        notes.push("Codex JSONL 内联图片，按需生成");
    } else if (attachment.source === "codex-data-url") {
        notes.push("Codex JSONL 内联图片，read/search 时按需生成临时文件");
    } else if (attachment.source === "claude-code-data-url" && attachment.tempPath) {
        notes.push("Claude Code JSONL 内联图片，按需生成");
    } else if (attachment.source === "claude-code-data-url") {
        notes.push("Claude Code JSONL 内联图片，read/search 时按需生成临时文件");
    } else if (attachment.source === "windsurf-data-url" && attachment.tempPath) {
        notes.push("Windsurf 内联图片，按需生成");
    } else if (attachment.source === "windsurf-data-url") {
        notes.push("Windsurf 内联图片，read/search 时按需生成临时文件");
    }
    if (attachment.originalPath && attachment.exists === false) {
        notes.push("原路径当前不存在");
    }
    if (attachment.warning) {
        notes.push(attachment.warning);
    }
    if (attachmentMode === "markdown") {
        const link = attachment.kind === "image"
            ? `![${escapeMarkdownLabel(displayName)}](${formatMarkdownUrl(target)})`
            : `[${escapeMarkdownLabel(displayName)}](${formatMarkdownUrl(target)})`;
        lines.push(`📎 ${label} ${displayName}: ${link}${notes.length ? `（${notes.join("；")}）` : ""}`);
    } else {
        lines.push(`📎 ${label}: ${target}${notes.length ? `（${notes.join("；")}）` : ""}`);
    }
}

/** 渲染单条 AI 回复（含 thinking 折叠）。空 response 不 push 空文本行（修正 A 空 step 合并）。 */
function renderAiResponseLines(
    lines: string[],
    ai: AiResponse,
    depth: Depth,
    extraTypes: ExtraType[],
): void {
    const showThinking = Boolean(ai.thinking) && (depth === "full" || extraTypes.includes("thinking"));
    // 空 step 抑制（问题2）：AI step 既无正文、也无可显示的思考 → 不输出空标题。
    // 该 step 的工具调用作为独立事件单独渲染并带 step 号，时序与语义不丢。仅 export interleave 路径生效，不影响 read/search。
    if (!ai.response && !showThinking) return;
    lines.push(`### 🤖 AI (step ${ai.stepIndex})`);
    if (ai.response) {
        lines.push(depth === "brief" ? truncate(ai.response, 100) : ai.response);
    }
    if (showThinking) {
        lines.push("");
        lines.push(`<details><summary>${thinkingSummaryLabel(ai.thinking)}</summary>`);
        lines.push("");
        lines.push(ai.thinking);
        lines.push("</details>");
    }
    lines.push("");
}

/** 渲染单条工具调用（非 brief）。与旧分支单行格式逐字节一致。 */
function renderToolCallLine(lines: string[], tc: ToolCallInfo, depth: Depth, extraTypes: ExtraType[]): void {
    let line = `- ${tc.name}`;
    if (depth === "full" || extraTypes.includes("tool_results")) {
        line += `(${tc.argsSummary})`;
        if (tc.resultSummary) {
            line += ` → ${truncate(tc.resultSummary, depth === "full" ? 500 : 200)}`;
        }
    }
    lines.push(line);
}

/**
 * 把 round.attachments 按 stepIndex 分桶（纯函数，便于单测）。
 * - userBucket：stepIndex≤startStep（用户输入图）或首个 AI 之前的兜底图 → 维持用户段。
 * - legacyBucket：无 stepIndex（老数据）→ 用户段。
 * - byAiStep：归到「≤其 stepIndex 的最大 AI step」之后。
 */
function bucketAttachmentsByStep(round: ConversationRound): {
    userBucket: ConversationAttachment[];
    legacyBucket: ConversationAttachment[];
    byAiStep: Map<number, ConversationAttachment[]>;
} {
    const userBucket: ConversationAttachment[] = [];
    const legacyBucket: ConversationAttachment[] = [];
    const byAiStep = new Map<number, ConversationAttachment[]>();
    const aiSteps = round.aiResponses
        .map(a => a.stepIndex)
        .filter(s => Number.isFinite(s))
        .sort((a, b) => a - b);

    for (const att of round.attachments || []) {
        if (typeof att.stepIndex !== "number" || !Number.isFinite(att.stepIndex)) {
            legacyBucket.push(att);
            continue;
        }
        if (aiSteps.length === 0 || att.stepIndex <= round.startStep) {
            userBucket.push(att);
            continue;
        }
        let target = -1;
        for (const s of aiSteps) {
            if (s <= att.stepIndex) target = s;
            else break;
        }
        if (target < 0) {
            userBucket.push(att);
            continue;
        }
        const list = byAiStep.get(target);
        if (list) list.push(att);
        else byAiStep.set(target, [att]);
    }
    return { userBucket, legacyBucket, byAiStep };
}

/**
 * 格式化单个轮次为 markdown
 */
export function formatRound(
    round: ConversationRound,
    depth: Depth,
    extraTypes: ExtraType[] = [],
    options: { compactionMode?: CompactionMode; attachmentMode?: "text" | "markdown" } = {},
): string {
    const lines: string[] = [];
    const stepsRange = `steps ${round.startStep}-${round.endStep}`;

    lines.push(`## 轮次 ${round.roundIndex} (${stepsRange})`);

    // 用户消息
    lines.push(`### 👤 用户 (step ${round.startStep})`);
    if (round.compactionSummaries?.length) {
        lines.push(formatCompactionUserMessage(round, depth, options.compactionMode || (depth === "full" ? "full" : "folded")));
    } else if (depth === "brief") {
        lines.push(truncate(round.userMessage, 100));
    } else {
        lines.push(round.userMessage);
    }
    // 用户附件图片
    if (round.mediaAttachments.length > 0) {
        for (const [index, uri] of round.mediaAttachments.entries()) {
            if (options.attachmentMode === "markdown") {
                const label = `round-${round.roundIndex}-media-${index + 1}`;
                lines.push(`📎 图片 ${label}: ![${escapeMarkdownLabel(label)}](${formatMarkdownUrl(uri)})`);
            } else {
                lines.push(`📎 图片: ${uri}`);
            }
        }
    }
    // 严格门控（蓝图冲突1/2 裁决）：仅 export 的 markdown 且非 brief 走交错时间线，
    // read/search/guard/record/brief 一律走旧分支，逐字节不变。
    const interleave = options.attachmentMode === "markdown" && depth !== "brief";

    if (!interleave) {
        // ===== 旧路径：read/search/guard/record/brief，逐字节不变 =====
        if (round.attachments?.length) {
            for (const attachment of round.attachments) {
                const label = attachment.kind === "image" ? "图片" : "文件";
                const target = attachment.tempPath || attachment.originalPath || attachment.name || "JSONL 内联图片";
                const displayName = attachment.name || target.split(/[\\/]/u).pop() || `${label}-${round.roundIndex}`;
                const notes: string[] = [];
                if (attachment.source === "codex-data-url" && attachment.tempPath) {
                    notes.push("Codex JSONL 内联图片，按需生成");
                } else if (attachment.source === "codex-data-url") {
                    notes.push("Codex JSONL 内联图片，read/search 时按需生成临时文件");
                } else if (attachment.source === "claude-code-data-url" && attachment.tempPath) {
                    notes.push("Claude Code JSONL 内联图片，按需生成");
                } else if (attachment.source === "claude-code-data-url") {
                    notes.push("Claude Code JSONL 内联图片，read/search 时按需生成临时文件");
                } else if (attachment.source === "windsurf-data-url" && attachment.tempPath) {
                    notes.push("Windsurf 内联图片，按需生成");
                } else if (attachment.source === "windsurf-data-url") {
                    notes.push("Windsurf 内联图片，read/search 时按需生成临时文件");
                }
                if (attachment.originalPath && attachment.exists === false) {
                    notes.push("原路径当前不存在");
                }
                if (attachment.warning) {
                    notes.push(attachment.warning);
                }
                if (options.attachmentMode === "markdown") {
                    const link = attachment.kind === "image"
                        ? `![${escapeMarkdownLabel(displayName)}](${formatMarkdownUrl(target)})`
                        : `[${escapeMarkdownLabel(displayName)}](${formatMarkdownUrl(target)})`;
                    lines.push(`📎 ${label} ${displayName}: ${link}${notes.length ? `（${notes.join("；")}）` : ""}`);
                } else {
                    lines.push(`📎 ${label}: ${target}${notes.length ? `（${notes.join("；")}）` : ""}`);
                }
            }
        }
        lines.push("");

        // AI 回复
        for (const ai of round.aiResponses) {
            lines.push(`### 🤖 AI (step ${ai.stepIndex})`);
            if (depth === "brief") {
                lines.push(truncate(ai.response, 100));
            } else {
                lines.push(ai.response);
            }

            // thinking
            if (ai.thinking && (depth === "full" || extraTypes.includes("thinking"))) {
                lines.push("");
                lines.push(`<details><summary>${thinkingSummaryLabel(ai.thinking)}</summary>`);
                lines.push("");
                lines.push(ai.thinking);
                lines.push("</details>");
            }

            lines.push("");
        }

        // 工具调用
        if (round.toolCalls.length > 0) {
            if (depth === "brief") {
                const names = round.toolCalls.map((tc) => tc.name);
                const unique = [...new Set(names)];
                const counts = unique.map(n => {
                    const c = names.filter(x => x === n).length;
                    return c > 1 ? `${n} ×${c}` : n;
                });
                lines.push(`🔧 工具: ${counts.join(", ")}`);
            } else {
                lines.push("#### 🔧 工具调用");
                for (const tc of round.toolCalls) {
                    let line = `- ${tc.name}`;
                    if (depth === "full" || extraTypes.includes("tool_results")) {
                        line += `(${tc.argsSummary})`;
                        if (tc.resultSummary) {
                            line += ` → ${truncate(tc.resultSummary, depth === "full" ? 500 : 200)}`;
                        }
                    }
                    lines.push(line);
                }
            }
            lines.push("");
        }
    } else {
        // ===== 新路径：export normal/full，按 stepIndex 交错时间线 =====
        const buckets = bucketAttachmentsByStep(round);

        // 用户段附件：用户桶 + legacy 桶（紧跟用户消息，在事件流之前）。
        for (const att of [...buckets.userBucket, ...buckets.legacyBucket]) {
            renderAttachmentLine(lines, att, round.roundIndex, options.attachmentMode);
        }
        lines.push("");

        // 事件流：AI 文本 / 工具 / 归属图，按 (step, seq) 稳定排序。
        type Ev = { step: number; seq: number; isTool: boolean; render: (l: string[]) => void };
        const events: Ev[] = [];
        let seq = 0;
        const SENTINEL = round.endStep + 1_000_000;   // NaN/缺失 step 排末尾
        const safeStep = (s: number) => (Number.isFinite(s) ? s : SENTINEL);

        for (const ai of round.aiResponses) {
            const step = safeStep(ai.stepIndex);
            events.push({ step, seq: seq++, isTool: false, render: (l) => renderAiResponseLines(l, ai, depth, extraTypes) });
            const imgs = Number.isFinite(ai.stepIndex) ? buckets.byAiStep.get(ai.stepIndex) : undefined;
            if (imgs?.length) {
                for (const att of imgs) {
                    events.push({ step, seq: seq++, isTool: false, render: (l) => renderAttachmentLine(l, att, round.roundIndex, options.attachmentMode) });
                }
            }
        }
        for (const tc of round.toolCalls) {
            events.push({ step: safeStep(tc.stepIndex), seq: seq++, isTool: true, render: (l) => renderToolCallLine(l, tc, depth, extraTypes) });
        }

        events.sort((a, b) => a.step - b.step || a.seq - b.seq);

        // 工具分组标题：连续工具块（同 step）首行前补一次 `#### 🔧 工具调用 (step N)`。
        let prevToolStep: number | null = null;
        for (const ev of events) {
            if (ev.isTool) {
                if (prevToolStep !== ev.step) {
                    lines.push(`#### 🔧 工具调用 (step ${Number.isFinite(ev.step) && ev.step < SENTINEL ? ev.step : "?"})`);
                    prevToolStep = ev.step;
                }
                ev.render(lines);
            } else {
                if (prevToolStep !== null) {
                    lines.push("");
                    prevToolStep = null;
                }
                ev.render(lines);
            }
        }
        if (prevToolStep !== null) lines.push("");
    }

    // 任务状态
    if (round.taskBoundaries.length > 0 && depth !== "brief") {
        const latest = round.taskBoundaries[round.taskBoundaries.length - 1];
        lines.push(`📋 任务: ${latest.taskName} → ${latest.taskStatus}`);
        lines.push("");
    }

    // 代码编辑
    if (round.codeActions.length > 0 && (extraTypes.includes("code_actions") || extraTypes.includes("code_diffs"))) {
        lines.push("#### ✏️ 代码编辑");
        for (const ca of round.codeActions) {
            lines.push(`- **${ca.targetFile}**: ${ca.description}`);
            if (ca.instruction && extraTypes.includes("code_actions")) {
                lines.push(`  指令: ${ca.instruction}`);
            }
            if (ca.diffs.length > 0 && extraTypes.includes("code_diffs")) {
                for (const diff of ca.diffs) {
                    const lineRange = diff.startLine && diff.endLine
                        ? ` (L${diff.startLine}-L${diff.endLine})`
                        : "";
                    if (diff.unifiedDiff) {
                        lines.push(`\`\`\`diff`);
                        lines.push(diff.unifiedDiff.replace(/\r/g, ""));
                        lines.push("```");
                    } else if (diff.targetContent || diff.replacementContent) {
                        lines.push(`\`\`\`diff`);
                        lines.push(`--- ${ca.targetFile}${lineRange}`);
                        lines.push(`+++ ${ca.targetFile}${lineRange}`);
                        // 输出移除的行（修改前）
                        if (diff.targetContent) {
                            for (const line of diff.targetContent.split("\n")) {
                                lines.push(`-${line}`);
                            }
                        }
                        // 输出新增的行（修改后）
                        if (diff.replacementContent) {
                            for (const line of diff.replacementContent.split("\n")) {
                                lines.push(`+${line}`);
                            }
                        }
                        lines.push("```");
                    }
                }
            }
        }
        lines.push("");
    }

    // Codex 文件/计划视图事件
    if (round.fileViews?.length && extraTypes.includes("file_views")) {
        lines.push("#### 📄 文件/计划视图");
        for (const view of round.fileViews) {
            const title = view.title || view.id || "(无标题)";
            lines.push(`- ${view.kind}: ${title} (step ${view.stepIndex})`);
            if (view.textSummary) {
                lines.push(`  ${truncate(view.textSummary, depth === "full" ? 500 : 200)}`);
            }
        }
        lines.push("");
    }

    // 子代理摘要（主要用于 Codex 链路）
    if (round.subagentSummaries.length > 0) {
        if (depth === "brief") {
            const names = round.subagentSummaries.map((item) => item.nickname || "subagent");
            lines.push(`🤝 子代理: ${names.join(", ")}`);
        } else {
            lines.push("#### 🤝 子代理线程");
            for (const item of round.subagentSummaries) {
                const label = item.threadId ? `${item.nickname} (${item.threadId.slice(0, 8)}...)` : item.nickname;
                const detail = item.summary || item.prompt || "";
                lines.push(detail ? `- ${label}: ${truncate(detail, depth === "full" ? 300 : 120)}` : `- ${label}`);
            }
        }
        lines.push("");
    }

    lines.push("---");
    return lines.join("\n");
}

function truncateForRoleView(input: string, depth: Depth): string {
    const text = input || "";
    const limit = depth === "brief" ? 100 : depth === "normal" ? 20_000 : Number.POSITIVE_INFINITY;
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n\n⚠️ 本段过长已截断（${text.length}→${limit}字），可用 depth="full" 展开`;
}

export function normalizeMessageRoles(input?: ConversationMessageRole[]): Set<ConversationMessageRole> {
    const result = new Set<ConversationMessageRole>();
    for (const role of input || []) {
        if (role === "model" || role === "assistant") {
            result.add("model");
            result.add("assistant");
        } else {
            result.add(role);
        }
    }
    return result;
}

/** thinking 折叠块 summary：CC 加密占位符不标字数（修正 C，明文不可读）。 */
function thinkingSummaryLabelForRoleView(thinking: string): string {
    return thinking.startsWith("🔒 加密思考块")
        ? "💭 思考（加密思考，明文不可读）"
        : `💭 思考 (${thinking.length}字)`;
}

function isSystemLikeRound(round: ConversationRound): boolean {
    if (round.compactionSummaries?.length) return true;
    const text = (round.userMessage || "").trimStart();
    return text.startsWith("[Codex AGENTS/RULES 注入已折叠")
        || text.startsWith("# AGENTS.md instructions for ")
        || text.startsWith("[Claude Code compact summary folded")
        || text.includes("<<<CLAUDE_CODE_COMPACT_SUMMARY>>>");
}

export function formatRoundForMessageRoles(
    round: ConversationRound,
    depth: Depth,
    extraTypes: ExtraType[],
    roles: Set<ConversationMessageRole>,
    compactionMode: CompactionMode,
): string {
    if (roles.size === 0) return formatRound(round, depth, extraTypes, { compactionMode });

    const systemLike = isSystemLikeRound(round);
    const includeUser = roles.has("user") && !systemLike;
    const includeSystem = roles.has("system") && systemLike;
    const includeModel = roles.has("model") || roles.has("assistant");
    const includeTool = roles.has("tool");
    const hasToolLike = round.toolCalls.length > 0
        || round.taskBoundaries.length > 0
        || round.codeActions.length > 0
        || (round.fileViews?.length || 0) > 0
        || round.subagentSummaries.length > 0;

    if (!includeUser && !includeSystem && !(includeModel && round.aiResponses.length > 0) && !(includeTool && hasToolLike)) {
        return "";
    }

    const lines: string[] = [`## 轮次 ${round.roundIndex} (steps ${round.startStep}-${round.endStep})`];

    if (includeUser || includeSystem) {
        lines.push(includeSystem
            ? `### 🧩 系统/压缩内容 (step ${round.startStep})`
            : `### 👤 用户 (step ${round.startStep})`);
        if (round.compactionSummaries?.length) {
            for (const item of round.compactionSummaries) {
                const meta = `chars=${item.summaryChars}, sha256=${item.summarySha256.slice(0, 12)}`;
                if (compactionMode === "full" || depth === "full") {
                    lines.push(`🧩 Claude Code 压缩续聊摘要（已展开；这不是用户真实输入，${meta}）`);
                    lines.push("<<<CLAUDE_CODE_COMPACT_SUMMARY>>>");
                    lines.push(truncateForRoleView(item.text, depth));
                    lines.push("<<<END_CLAUDE_CODE_COMPACT_SUMMARY>>>");
                } else if (compactionMode === "omit") {
                    lines.push(`🧩 Claude Code 压缩续聊摘要已省略（${meta}）`);
                } else {
                    lines.push(`🧩 Claude Code 压缩续聊摘要已折叠（${meta}）`);
                    lines.push("说明：这是上下文压缩后的 summary，不是原始用户发言；可用 depth=\"full\" 或 compactionMode=\"full\" 展开。");
                }
            }
        } else {
            lines.push(truncateForRoleView(round.userMessage, depth));
        }
        if (includeUser && round.attachments?.length) {
            for (const attachment of round.attachments) {
                const label = attachment.kind === "image" ? "图片" : "文件";
                const target = attachment.tempPath || attachment.originalPath || attachment.name || "JSONL 内联图片";
                lines.push(`📎 ${label}: ${target}`);
            }
        }
        if (includeUser && round.mediaAttachments.length > 0) {
            for (const uri of round.mediaAttachments) lines.push(`📎 图片: ${uri}`);
        }
        lines.push("");
    }

    // 修正 A：当同时请求 model + tool 角色时，按 stepIndex 把 AI 回复与工具调用归并成一条
    // 时间线，避免「AI 全渲完再渲所有工具」导致的时序错乱与空 step。空 response 的 AI step
    // 不单独出空文本行（与其工具合并成一个 step 块）。单角色（只 model 或只 tool）维持分段。
    const mergeAiTool = includeModel && includeTool;

    const renderAiBlock = (ai: ConversationRound["aiResponses"][number]): void => {
        lines.push(`### 🤖 AI (step ${ai.stepIndex})`);
        if (ai.response) lines.push(truncateForRoleView(ai.response, depth));
        if (ai.thinking && (depth === "full" || extraTypes.includes("thinking"))) {
            lines.push("");
            lines.push(`<details><summary>${thinkingSummaryLabelForRoleView(ai.thinking)}</summary>`);
            lines.push("");
            lines.push(ai.thinking);
            lines.push("</details>");
        }
        lines.push("");
    };

    const renderToolLine = (tc: ConversationRound["toolCalls"][number]): void => {
        let line = `- ${tc.name}`;
        if (depth === "full" || extraTypes.includes("tool_results")) {
            line += `(${tc.argsSummary})`;
            if (tc.resultSummary) line += ` → ${truncateForRoleView(tc.resultSummary, depth === "full" ? "normal" : depth)}`;
        }
        lines.push(line);
    };

    if (mergeAiTool) {
        type Ev = { step: number; seq: number; isTool: boolean; render: () => void };
        const events: Ev[] = [];
        let seq = 0;
        const SENTINEL = round.endStep + 1_000_000;
        const safeStep = (s: number) => (Number.isFinite(s) ? s : SENTINEL);
        for (const ai of round.aiResponses) {
            events.push({ step: safeStep(ai.stepIndex), seq: seq++, isTool: false, render: () => renderAiBlock(ai) });
        }
        for (const tc of round.toolCalls) {
            events.push({ step: safeStep(tc.stepIndex), seq: seq++, isTool: true, render: () => renderToolLine(tc) });
        }
        events.sort((a, b) => a.step - b.step || a.seq - b.seq);
        let prevToolStep: number | null = null;
        for (const ev of events) {
            if (ev.isTool) {
                if (prevToolStep !== ev.step) {
                    lines.push(`#### 🔧 工具调用 (step ${Number.isFinite(ev.step) && ev.step < SENTINEL ? ev.step : "?"})`);
                    prevToolStep = ev.step;
                }
                ev.render();
            } else {
                if (prevToolStep !== null) { lines.push(""); prevToolStep = null; }
                ev.render();
            }
        }
        if (prevToolStep !== null) lines.push("");
    } else if (includeModel) {
        for (const ai of round.aiResponses) renderAiBlock(ai);
    } else if (includeTool && round.toolCalls.length > 0) {
        lines.push("#### 🔧 工具调用");
        for (const tc of round.toolCalls) renderToolLine(tc);
        lines.push("");
    }

    if (includeTool) {
        if (round.taskBoundaries.length > 0 && depth !== "brief") {
            const latest = round.taskBoundaries[round.taskBoundaries.length - 1];
            lines.push(`📋 任务: ${latest.taskName} → ${latest.taskStatus}`);
            lines.push("");
        }
        if (round.codeActions.length > 0 && (extraTypes.includes("code_actions") || extraTypes.includes("code_diffs"))) {
            lines.push("#### ✏️ 代码编辑");
            for (const ca of round.codeActions) lines.push(`- **${ca.targetFile}**: ${ca.description}`);
            lines.push("");
        }
        if (round.fileViews?.length && extraTypes.includes("file_views")) {
            lines.push("#### 📄 文件/计划视图");
            for (const view of round.fileViews) lines.push(`- ${view.kind}${view.title ? ` / ${view.title}` : ""}: ${view.textSummary}`);
            lines.push("");
        }
        if (round.subagentSummaries.length > 0) {
            lines.push("#### 🤝 子代理线程");
            for (const subagent of round.subagentSummaries) {
                lines.push(`- ${subagent.nickname || subagent.threadId} (${subagent.threadId})${subagent.role ? ` / ${subagent.role}` : ""}`);
            }
            lines.push("");
        }
    }

    return lines.join("\n").trimEnd();
}

function safeFilePart(input: string): string {
    return input.replace(/[^a-zA-Z0-9\u4e00-\u9fff_.-]/gu, "_").slice(0, 120);
}

function formatTokenNumber(value?: number): string {
    return typeof value === "number" && Number.isFinite(value) ? String(value) : "?";
}

function formatDurationMs(value?: number): string {
    if (typeof value !== "number" || !Number.isFinite(value)) return "?";
    if (value < 1000) return `${value}ms`;
    return `${(value / 1000).toFixed(1)}s`;
}

function materializeCompactionSummary(info: CompactionSummaryInfo): string {
    ensureTempDir();
    const ttlMs = Math.min(
        Math.max(60_000, Number(process.env.MEMORY_STORE_CC_COMPACT_SUMMARY_CACHE_TTL_MS || 60 * 60 * 1000)),
        24 * 60 * 60 * 1000,
    );
    const conversationSlug = safeFilePart((info.conversationId || "unknown").slice(0, 64)) || "unknown";
    const dir = path.join(TEMP_DIR, "claude-code-compact-summaries", conversationSlug);
    fs.mkdirSync(dir, { recursive: true });
    const linePart = String(info.eventLineNo || 0).padStart(6, "0");
    const offsetPart = String(info.eventByteOffset || 0).padStart(10, "0");
    const hashPart = info.summarySha256.slice(0, 12);
    const filePath = path.join(dir, `compact_line-${linePart}_off-${offsetPart}_sha256-${hashPart}.md`);
    const now = Date.now();
    try {
        const stat = fs.statSync(filePath);
        if (stat.isFile() && now - stat.mtimeMs <= ttlMs) return filePath;
    } catch {
        // cache miss
    }
    const metadata = [
        "# Claude Code Compact Summary",
        "",
        "⚠️ 这是 Claude Code 在上下文压缩后注入的续聊摘要，不是用户真实输入的原始正文。",
        "",
        "## 元数据",
        `- conversationId: ${info.conversationId || "(unknown)"}`,
        `- jsonlPath: ${info.jsonlPath || "(unknown)"}`,
        `- eventLineNo: ${info.eventLineNo ?? "(unknown)"}`,
        `- eventByteOffset: ${info.eventByteOffset ?? "(unknown)"}`,
        `- boundaryLineNo: ${info.boundaryLineNo ?? "(unknown)"}`,
        `- trigger: ${info.trigger || "(unknown)"}`,
        `- tokens: ${formatTokenNumber(info.preTokens)} → ${formatTokenNumber(info.postTokens)}`,
        `- duration: ${formatDurationMs(info.durationMs)}`,
        `- summaryChars: ${info.summaryChars}`,
        `- summarySha256: ${info.summarySha256}`,
        "",
        "## 摘要正文",
        "<<<CLAUDE_CODE_COMPACT_SUMMARY>>>",
        info.text,
        "<<<END_CLAUDE_CODE_COMPACT_SUMMARY>>>",
        "",
    ].join("\n");
    const tmpPath = `${filePath}.${process.pid}.${now}.tmp`;
    fs.writeFileSync(tmpPath, metadata, "utf-8");
    fs.renameSync(tmpPath, filePath);
    return filePath;
}

function formatCompactionUserMessage(round: ConversationRound, depth: Depth, mode: CompactionMode): string {
    const items = round.compactionSummaries || [];
    const lines: string[] = [];
    for (const item of items) {
        const meta = [
            `chars=${item.summaryChars}`,
            `sha256=${item.summarySha256.slice(0, 12)}`,
            `tokens=${formatTokenNumber(item.preTokens)}→${formatTokenNumber(item.postTokens)}`,
            `duration=${formatDurationMs(item.durationMs)}`,
        ].join(", ");
        if (mode === "omit") {
            lines.push(`🧩 Claude Code 压缩续聊摘要已省略（${meta}）`);
            continue;
        }
        if (mode === "full") {
            lines.push(`🧩 Claude Code 压缩续聊摘要（已展开；这不是用户真实输入，${meta}）`);
            lines.push("<<<CLAUDE_CODE_COMPACT_SUMMARY>>>");
            lines.push(depth === "brief" ? truncate(item.text, 100) : item.text);
            lines.push("<<<END_CLAUDE_CODE_COMPACT_SUMMARY>>>");
            continue;
        }
        const artifactPath = materializeCompactionSummary(item);
        lines.push(`🧩 Claude Code 压缩续聊摘要已折叠（${meta}）`);
        lines.push(`📄 完整压缩摘要临时文件: ${artifactPath}`);
        lines.push("说明：这是上下文压缩后的 summary，不是原始用户发言；默认搜索、Record、Guard 不把它当事实正文。");
    }
    return lines.join("\n");
}

/**
 * 生成对话概览统计
 */
export function formatOverview(cascadeId: string, rounds: ConversationRound[], totalSteps: number): string {
    const totalUserMsgs = rounds.length;
    const totalAiMsgs = rounds.reduce((sum, r) => sum + r.aiResponses.length, 0);
    const totalTools = rounds.reduce((sum, r) => sum + r.toolCalls.length, 0);

    return [
        `📂 对话: ${cascadeId}`,
        `📊 统计: ${totalUserMsgs} 轮对话 | ${totalSteps} 步骤 | AI 回复 ${totalAiMsgs} 条 | 工具调用 ${totalTools} 次`,
    ].join("\n");
}

/**
 * 将解析后的对话轮次保存到临时文件
 */
export function saveConversationToTemp(
    cascadeId: string,
    rounds: ConversationRound[],
    totalSteps: number
): string {
    const lines: string[] = [];
    const now = new Date().toISOString();

    lines.push(`# 对话原文: ${cascadeId}`);
    lines.push(`> 拉取时间: ${now} | 步骤: ${totalSteps} | 轮次: ${rounds.length}`);
    lines.push("");

    for (const round of rounds) {
        lines.push(formatRound(round, "normal"));
        lines.push("");
    }

    const content = lines.join("\n");
    const slug = cascadeId.slice(0, 8);
    return saveTempFile("conv", slug, content);
}

// ===== 搜索 =====

interface SearchResult {
    roundIndex: number;
    matchType: "user" | "ai";
    matchText: string;        // 匹配的文本片段
    contextStart: number;     // 上下文起始位置（字符）
    hitCount: number;         // 命中的 token 数量（用于排序）
}

/**
 * 在对话轮次中搜索关键词（分词模糊匹配）
 *
 * 按空格将 query 拆分为多个 token，任一 token 命中即算匹配，
 * 按命中 token 数降序排列。单个 token 时退化为子串搜索。
 */
export function searchInRounds(
    rounds: ConversationRound[],
    query: string,
    limit: number = 5
): SearchResult[] {
    // 分词：按空格拆分，去空，转小写
    const tokens = query.split(/\s+/).filter(t => t.length > 0).map(t => t.toLowerCase());
    if (tokens.length === 0) return [];

    const candidates: SearchResult[] = [];

    for (const round of rounds) {
        const userLower = round.userMessage.toLowerCase();

        // 搜索用户消息
        const userHits = tokens.filter(t => userLower.includes(t));
        if (userHits.length > 0) {
            // 找第一个命中 token 的位置作为上下文锚点
            const firstToken = userHits[0];
            const idx = userLower.indexOf(firstToken);
            candidates.push({
                roundIndex: round.roundIndex,
                matchType: "user",
                matchText: extractContext(round.userMessage, idx, firstToken.length, 100),
                contextStart: idx,
                hitCount: userHits.length,
            });
        }

        // 搜索 AI 回复
        for (const ai of round.aiResponses) {
            const aiLower = ai.response.toLowerCase();
            const aiHits = tokens.filter(t => aiLower.includes(t));
            if (aiHits.length > 0) {
                const firstToken = aiHits[0];
                const idx = aiLower.indexOf(firstToken);
                candidates.push({
                    roundIndex: round.roundIndex,
                    matchType: "ai",
                    matchText: extractContext(ai.response, idx, firstToken.length, 100),
                    contextStart: idx,
                    hitCount: aiHits.length,
                });
            }
        }
    }

    // 按命中 token 数降序，同命中数按轮次升序
    candidates.sort((a, b) => b.hitCount - a.hitCount || a.roundIndex - b.roundIndex);

    return candidates.slice(0, limit);
}

// ===== 工具函数 =====

function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + "...";
}

function truncateLines(text: string, headLines: number, tailLines: number): string {
    const lines = text.split("\n");
    if (lines.length <= headLines + tailLines) return text;
    return [
        ...lines.slice(0, headLines),
        `[... 省略 ${lines.length - headLines - tailLines} 行 ...]`,
        ...lines.slice(-tailLines),
    ].join("\n");
}

function extractContext(text: string, matchStart: number, matchLen: number, contextLen: number): string {
    const start = Math.max(0, matchStart - contextLen);
    const end = Math.min(text.length, matchStart + matchLen + contextLen);
    let snippet = text.slice(start, end);
    if (start > 0) snippet = "..." + snippet;
    if (end < text.length) snippet = snippet + "...";
    return snippet;
}
