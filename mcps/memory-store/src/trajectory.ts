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
    /** 同一轮内的真实人类消息组；缺失时兼容读取旧 userMessage。 */
    userMessages?: ConversationUserMessage[];
    /** 合并前的旧轮次编号，供历史书签和旧调用定位。 */
    legacyRoundIndices?: number[];
    /** 保留原始来源角色后的统一语义事件。 */
    semanticEvents?: ConversationSemanticEvent[];
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
    attachments?: import("./conversation-attachments.js").ConversationAttachment[];
    status?: string;
    rawRole?: string;
    semanticRole?: "subagent";
}

export interface ConversationAnnotation {
    selectedText: string;
    comment: string;
}

export interface ConversationUserMessage {
    stepIndex?: number;
    text: string;
    rawRole?: string;
    semanticRole?: "user";
    mediaAttachments?: string[];
    attachments?: import("./conversation-attachments.js").ConversationAttachment[];
    annotations?: ConversationAnnotation[];
}

export interface ConversationSemanticEvent {
    stepIndex?: number;
    rawRole?: string;
    semanticRole: ConversationMessageRole;
    kind?: string;
    text?: string;
    name?: string;
    argsFull?: string;
    resultSummary?: string;
    resultFull?: string;
    subagent?: SubagentSummary;
    attachments?: import("./conversation-attachments.js").ConversationAttachment[];
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
    argsFull?: string;
    resultFull?: string;
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
export type ConversationMessageRole = "user" | "system" | "model" | "assistant" | "tool" | "subagent";
export type FormatRoundForMessageRolesOptions = {
    deadlineAt?: number;
    shouldAbort?: () => boolean;
    onBudgetExceeded?: () => void;
};
export type FormatRoundForMessageRolesBudgetResult = {
    text: string;
    budgetExceeded: boolean;
};

// ===== Trajectory 解析 =====

/**
 * 将原始 trajectory steps 解析为对话轮次
 */
export function parseRounds(steps: any[]): ConversationRound[] {
    const rounds: ConversationRound[] = [];
    let currentRound: ConversationRound | null = null;
    let roundIdx = 0;
    let legacyRoundIdx = 0;

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const type = step.type || "";

        if (type === "CORTEX_STEP_TYPE_USER_INPUT") {
            const legacyRoundIndex = ++legacyRoundIdx;
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
            const userMessage: ConversationUserMessage = {
                stepIndex: i,
                text: userMsg,
                rawRole: type,
                semanticRole: "user",
                mediaAttachments: mediaUris,
            };

            // 连续的人类消息没有模型侧活动时，属于同一个人类消息组。
            if (currentRound && !hasModelSideActivity(currentRound)) {
                currentRound.userMessages = [...(currentRound.userMessages || []), userMessage];
                currentRound.legacyRoundIndices = [...(currentRound.legacyRoundIndices || []), legacyRoundIndex];
                currentRound.userMessage = currentRound.userMessages.map((item) => item.text).filter(Boolean).join("\n\n");
                currentRound.mediaAttachments.push(...mediaUris);
                currentRound.semanticEvents?.push({ stepIndex: i, rawRole: type, semanticRole: "user", kind: "message", text: userMsg });
                currentRound.endStep = i;
                continue;
            }

            if (currentRound) {
                currentRound.endStep = i - 1;
                rounds.push(currentRound);
            }
            roundIdx++;

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
                userMessages: [userMessage],
                legacyRoundIndices: [legacyRoundIndex],
                semanticEvents: [{ stepIndex: i, rawRole: type, semanticRole: "user", kind: "message", text: userMsg }],
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
                currentRound.semanticEvents?.push({ stepIndex: i, rawRole: type, semanticRole: "model", kind: "response", text: pr.response || "" });
            } else if (type === "CORTEX_STEP_TYPE_MODEL_RESPONSE") {
                const response = step.modelResponse?.response || step.modelResponse?.text || step.response || step.text || "";
                const thinking = step.modelResponse?.thinking || step.thinking || "";
                currentRound.aiResponses.push({ stepIndex: i, response, thinking, toolCalls: [] });
                currentRound.semanticEvents?.push({ stepIndex: i, rawRole: type, semanticRole: "model", kind: "response", text: response });
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
                currentRound.semanticEvents?.push({ stepIndex: i, rawRole: type, semanticRole: "tool", kind: "tool", name: tc.name || "unknown", resultSummary: mt.resultString || "" });
            } else if (type === "CORTEX_STEP_TYPE_TASK_BOUNDARY") {
                const tb = step.taskBoundary || {};
                currentRound.taskBoundaries.push({
                    stepIndex: i,
                    taskName: tb.taskName || "",
                    taskStatus: tb.taskStatus || "",
                });
                currentRound.semanticEvents?.push({ stepIndex: i, rawRole: type, semanticRole: "tool", kind: "task_boundary", text: `${tb.taskName || ""} ${tb.taskStatus || ""}`.trim() });
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
                currentRound.semanticEvents?.push({ stepIndex: i, rawRole: type, semanticRole: "tool", kind: "code_action", text: ca.description || "" });
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

function hasModelSideActivity(round: ConversationRound): boolean {
    return round.aiResponses.length > 0
        || round.toolCalls.length > 0
        || round.taskBoundaries.length > 0
        || round.codeActions.length > 0
        || round.subagentSummaries.length > 0
        || Boolean(round.semanticEvents?.some((event) => event.semanticRole === "model" || event.semanticRole === "assistant" || event.semanticRole === "tool" || event.semanticRole === "subagent"));
}

function getRoundUserMessages(round: ConversationRound): ConversationUserMessage[] {
    if (round.userMessages?.length) return round.userMessages;
    return [{
        stepIndex: round.startStep,
        text: round.userMessage,
        mediaAttachments: round.mediaAttachments || [],
        attachments: round.attachments,
    }];
}

/**
 * 合并由旧宿主解析器拆开的连续人类消息轮次，并保留旧序号映射。
 * 宿主仍可继续传入旧 ConversationRound；调用方在接入点按需使用本函数即可。
 */
export function mergeConsecutiveHumanRounds(sourceRounds: ConversationRound[]): ConversationRound[] {
    const merged: ConversationRound[] = [];
    for (const source of sourceRounds) {
        const next: ConversationRound = {
            ...source,
            userMessages: getRoundUserMessages(source).map((message) => ({ ...message })),
            legacyRoundIndices: [...(source.legacyRoundIndices?.length ? source.legacyRoundIndices : [source.roundIndex])],
            semanticEvents: source.semanticEvents?.map((event) => ({ ...event })),
            mediaAttachments: [...(source.mediaAttachments || [])],
            attachments: source.attachments ? [...source.attachments] : undefined,
            aiResponses: [...source.aiResponses],
            toolCalls: [...source.toolCalls],
            taskBoundaries: [...source.taskBoundaries],
            codeActions: [...source.codeActions],
            subagentSummaries: [...source.subagentSummaries],
            fileViews: source.fileViews ? [...source.fileViews] : undefined,
        };
        const previous = merged[merged.length - 1];
        if (previous && !hasModelSideActivity(previous)) {
            const previousMessages = getRoundUserMessages(previous);
            const nextMessages = getRoundUserMessages(next);
            previous.userMessages = [...previousMessages, ...nextMessages];
            previous.userMessage = previous.userMessages.map((message) => message.text).filter(Boolean).join("\n\n");
            previous.mediaAttachments.push(...next.mediaAttachments);
            previous.attachments = [...(previous.attachments || []), ...(next.attachments || [])];
            previous.aiResponses.push(...next.aiResponses);
            previous.toolCalls.push(...next.toolCalls);
            previous.taskBoundaries.push(...next.taskBoundaries);
            previous.codeActions.push(...next.codeActions);
            previous.subagentSummaries.push(...next.subagentSummaries);
            previous.fileViews = [...(previous.fileViews || []), ...(next.fileViews || [])];
            previous.semanticEvents = [...(previous.semanticEvents || []), ...(next.semanticEvents || [])];
            previous.legacyRoundIndices = [...(previous.legacyRoundIndices || []), ...(next.legacyRoundIndices || [])];
            previous.endStep = Math.max(previous.endStep, next.endStep);
            continue;
        }
        merged.push(next);
    }
    return merged.map((round, index) => ({ ...round, roundIndex: index + 1 }));
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

function formatAiHeading(stepIndex: number): string {
    return Number.isFinite(stepIndex) ? `### 🤖 AI (step ${stepIndex})` : "### 🤖 AI";
}

/**
 * 渲染单条附件为一行 markdown / 文本（从 formatRound 原内联逻辑搬出，保持输出兼容）。
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
    // 该 step 的工具调用仍作为独立事件按 step 号渲染，时序与语义不丢。
    if (!ai.response && !showThinking) return;
    lines.push(formatAiHeading(ai.stepIndex));
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

/** 渲染单条工具调用（非 brief），保持旧分支的单行输出格式。 */
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

type ParsedAnnotationMessage = {
    text: string;
    annotations: ConversationAnnotation[];
    warnings: string[];
};

function readAnnotationText(value: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
        const candidate = value[key];
        if (typeof candidate === "string") return candidate;
    }
    return "";
}

function annotationsFromPayload(payload: unknown): ConversationAnnotation[] {
    const records = Array.isArray(payload)
        ? payload
        : payload && typeof payload === "object"
            ? Array.isArray((payload as Record<string, unknown>).annotations)
                ? (payload as Record<string, unknown>).annotations as unknown[]
                : Array.isArray((payload as Record<string, unknown>).items)
                    ? (payload as Record<string, unknown>).items as unknown[]
                    : [payload]
            : [];
    return records.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        const selectedText = readAnnotationText(record, ["selectedText", "selected_text", "selected", "quote", "text"]);
        const comment = readAnnotationText(record, ["comment", "annotation", "feedback", "note", "message"]);
        return selectedText || comment ? [{ selectedText, comment }] : [];
    });
}

/** 将 Codex response-annotations 转成可读结构；损坏数据保留原文并附警告。 */
export function parseResponseAnnotations(input: string): ParsedAnnotationMessage {
    const blockPattern = /<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/giu;
    const annotations: ConversationAnnotation[] = [];
    const warnings: string[] = [];
    let found = false;
    let parsedBlock = false;
    let text = input.replace(blockPattern, (_block, json: string) => {
        found = true;
        try {
            const parsed = annotationsFromPayload(JSON.parse(json));
            if (parsed.length > 0) {
                annotations.push(...parsed);
                parsedBlock = true;
                return "";
            }
        } catch {
            // 保留下面的原文回退，避免坏数据被静默吞掉。
        }
        warnings.push("response-annotations 格式损坏，已保留原文");
        return _block;
    });
    if (!found && input.includes("<response-annotations")) {
        warnings.push("response-annotations 缺少完整结束标记，已保留原文");
    }
    if (parsedBlock) {
        const blockStart = input.search(/<response-annotations>/iu);
        const prefix = blockStart >= 0 ? input.slice(0, blockStart) : "";
        const normalizedPrefix = prefix.trim();
        const isCodexInjectedPreamble = normalizedPrefix.startsWith("# Response annotations:")
            && normalizedPrefix.includes("Each item contains text selected from an earlier Codex response")
            && normalizedPrefix.includes("Treat items as Annotation 1");
        if (isCodexInjectedPreamble && text.startsWith(prefix)) {
            text = text.slice(prefix.length).trimStart();
        }
    }
    return { text, annotations, warnings };
}

function renderHumanMessageContent(
    lines: string[],
    message: ConversationUserMessage,
    depth: Depth,
    truncateText: (input: string, depth: Depth) => string,
): void {
    const parsed = parseResponseAnnotations(message.text || "");
    const annotations = [...parsed.annotations, ...(message.annotations || [])];
    if (parsed.text) lines.push(truncateText(parsed.text, depth));
    if (annotations.length > 0) {
        lines.push("#### 📝 批注");
        for (const annotation of annotations) {
            lines.push(`- 被批注文本: ${truncateText(annotation.selectedText, depth)}`);
            const comment = annotation.comment.trim()
                ? truncateText(annotation.comment, depth)
                : "（未填写）";
            lines.push(`  用户评论: ${comment}`);
        }
    }
    for (const warning of parsed.warnings) {
        lines.push(`⚠️ ${warning}`);
    }
}

function getRoundAiResponses(round: ConversationRound): AiResponse[] {
    if (round.aiResponses.length > 0) return round.aiResponses;
    return (round.semanticEvents || [])
        .filter((event) => event.semanticRole === "model" || event.semanticRole === "assistant")
        .map((event) => ({ stepIndex: event.stepIndex ?? Number.NaN, response: event.text || "", thinking: "", toolCalls: [] }));
}

function getRoundToolCalls(round: ConversationRound): ToolCallInfo[] {
    if (round.toolCalls.length > 0) return round.toolCalls;
    return (round.semanticEvents || [])
        .filter((event) => event.semanticRole === "tool")
        .map((event) => ({
            stepIndex: event.stepIndex ?? Number.NaN,
            name: event.name || event.kind || "tool",
            argsSummary: "",
            resultSummary: event.resultSummary || event.text || "",
            argsFull: event.argsFull,
            resultFull: event.resultFull || event.resultSummary || event.text || "",
        }));
}

function getRoundSubagentSummaries(round: ConversationRound): SubagentSummary[] {
    const summaries = [...round.subagentSummaries];
    for (const event of round.semanticEvents || []) {
        if (event.semanticRole !== "subagent") continue;
        const subagent = event.subagent || {
            threadId: "",
            nickname: event.name || "subagent",
            status: event.text || event.resultSummary,
            rawRole: event.rawRole,
            semanticRole: "subagent" as const,
        };
        if (!summaries.some((item) => item.threadId === subagent.threadId && item.nickname === subagent.nickname)) {
            summaries.push(subagent);
        }
    }
    return summaries;
}

function formatSubagentLabel(subagent: SubagentSummary): string {
    const nickname = subagent.nickname || "subagent";
    const shortId = subagent.threadId ? `${subagent.threadId.slice(0, 8)}${subagent.threadId.length > 8 ? "…" : ""}` : "unknown";
    return `Subagent-${nickname} (${shortId})`;
}

function renderCodeActionSection(
    round: ConversationRound,
    extraTypes: ExtraType[],
    writeLine: (line: string) => boolean,
): boolean {
    if (round.codeActions.length === 0 || (!extraTypes.includes("code_actions") && !extraTypes.includes("code_diffs"))) return true;
    if (!writeLine("#### ✏️ 代码编辑")) return false;
    for (const action of round.codeActions) {
        if (!writeLine(`- **${action.targetFile}**: ${action.description}`)) return false;
        if (action.instruction && extraTypes.includes("code_actions") && !writeLine(`  指令: ${action.instruction}`)) return false;
        if (!extraTypes.includes("code_diffs")) continue;
        for (const diff of action.diffs) {
            const lineRange = diff.startLine && diff.endLine ? ` (L${diff.startLine}-L${diff.endLine})` : "";
            if (diff.unifiedDiff) {
                if (!writeLine("```diff") || !writeLine(diff.unifiedDiff.replace(/\r/g, "")) || !writeLine("```")) return false;
            } else if (diff.targetContent || diff.replacementContent) {
                if (!writeLine("```diff") || !writeLine(`--- ${action.targetFile}${lineRange}`) || !writeLine(`+++ ${action.targetFile}${lineRange}`)) return false;
                for (const line of diff.targetContent.split("\n")) {
                    if (!writeLine(`-${line}`)) return false;
                }
                for (const line of diff.replacementContent.split("\n")) {
                    if (!writeLine(`+${line}`)) return false;
                }
                if (!writeLine("```")) return false;
            }
        }
    }
    return writeLine("");
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
    const userMessages = getRoundUserMessages(round);

    lines.push(`## 轮次 ${round.roundIndex} (${stepsRange})`);

    // 用户消息
    if (round.compactionSummaries?.length) {
        lines.push(`### 👤 用户 (step ${round.startStep})`);
        lines.push(formatCompactionUserMessage(round, depth, options.compactionMode || (depth === "full" ? "full" : "folded")));
    } else {
        for (const message of userMessages) {
            lines.push(`### 👤 用户 (step ${message.stepIndex ?? round.startStep})`);
            renderHumanMessageContent(lines, message, depth, (text, selectedDepth) => selectedDepth === "brief" ? truncate(text, 100) : text);
            if (userMessages.length > 1) {
                for (const attachment of message.attachments || []) {
                    renderAttachmentLine(lines, attachment, round.roundIndex, options.attachmentMode);
                }
                for (const uri of message.mediaAttachments || []) {
                    lines.push(options.attachmentMode === "markdown"
                        ? `📎 图片: ![round-${round.roundIndex}-media](${formatMarkdownUrl(uri)})`
                        : `📎 图片: ${uri}`);
                }
                lines.push("");
            }
        }
    }
    // 用户附件图片
    const singleMessageMedia = userMessages.length === 1
        ? (round.mediaAttachments.length > 0 ? round.mediaAttachments : userMessages[0].mediaAttachments || [])
        : [];
    if (singleMessageMedia.length > 0) {
        for (const [index, uri] of singleMessageMedia.entries()) {
            if (options.attachmentMode === "markdown") {
                const label = `round-${round.roundIndex}-media-${index + 1}`;
                lines.push(`📎 图片 ${label}: ![${escapeMarkdownLabel(label)}](${formatMarkdownUrl(uri)})`);
            } else {
                lines.push(`📎 图片: ${uri}`);
            }
        }
    }
    // 附件渲染分支：markdown normal/full 将附件纳入时间线；其它输出保持既有附件布局。
    const interleave = options.attachmentMode === "markdown" && depth !== "brief";

    if (!interleave) {
        // 非附件时间线分支：normal/full 的 AI 与工具仍按 stepIndex 交替渲染。
        const singleMessageAttachments = userMessages.length === 1
            ? (round.attachments || userMessages[0].attachments || [])
            : round.attachments || [];
        if (singleMessageAttachments.length) {
            for (const attachment of singleMessageAttachments) {
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

        // AI 回复 + 工具调用：按 stepIndex 交替渲染
        if (depth === "brief") {
            for (const ai of round.aiResponses) {
                renderAiResponseLines(lines, ai, depth, extraTypes);
            }
            if (round.toolCalls.length > 0) {
                const names = round.toolCalls.map((tc) => tc.name);
                const unique = [...new Set(names)];
                const counts = unique.map(n => {
                    const c = names.filter(x => x === n).length;
                    return c > 1 ? `${n} ×${c}` : n;
                });
                lines.push(`🔧 工具: ${counts.join(", ")}`);
                lines.push("");
            }
        } else {
            type Ev = { step: number; seq: number; isTool: boolean; render: (l: string[]) => void };
            const events: Ev[] = [];
            let seq = 0;
            const SENTINEL = round.endStep + 1_000_000;
            const safeStep = (s: number) => (Number.isFinite(s) ? s : SENTINEL);
            for (const ai of round.aiResponses) {
                events.push({ step: safeStep(ai.stepIndex), seq: seq++, isTool: false, render: (l) => renderAiResponseLines(l, ai, depth, extraTypes) });
            }
            for (const tc of round.toolCalls) {
                events.push({ step: safeStep(tc.stepIndex), seq: seq++, isTool: true, render: (l) => renderToolCallLine(l, tc, depth, extraTypes) });
            }
            events.sort((a, b) => a.step - b.step || a.seq - b.seq);
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
    } else {
        // 附件时间线分支：markdown normal/full 将附件与事件按 stepIndex 交错渲染。
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
    renderCodeActionSection(round, extraTypes, (line) => {
        lines.push(line);
        return true;
    });

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
    const subagentSummaries = getRoundSubagentSummaries(round);
    if (subagentSummaries.length > 0) {
        if (depth === "brief") {
            const names = subagentSummaries.map((item) => formatSubagentLabel(item));
            lines.push(`🤝 子代理: ${names.join(", ")}`);
        } else {
            lines.push("#### 🤝 子代理线程");
            for (const item of subagentSummaries) {
                const label = formatSubagentLabel(item);
                const detail = item.status || item.summary || item.prompt || "";
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
    if (round.semanticEvents?.some((event) => event.semanticRole === "system")) return true;
    const text = getRoundUserMessages(round).map((message) => message.text).join("\n").trimStart();
    return text.startsWith("[Codex AGENTS/RULES 注入已折叠")
        || text.startsWith("# AGENTS.md instructions")
        || text.startsWith("[Claude Code compact summary folded")
        || text.includes("<<<CLAUDE_CODE_COMPACT_SUMMARY>>>");
}

export function formatRoundForMessageRoles(
    round: ConversationRound,
    depth: Depth,
    extraTypes: ExtraType[],
    roles: Set<ConversationMessageRole>,
    compactionMode: CompactionMode,
): string;
export function formatRoundForMessageRoles(
    round: ConversationRound,
    depth: Depth,
    extraTypes: ExtraType[],
    roles: Set<ConversationMessageRole>,
    compactionMode: CompactionMode,
    options: FormatRoundForMessageRolesOptions,
): FormatRoundForMessageRolesBudgetResult;
export function formatRoundForMessageRoles(
    round: ConversationRound,
    depth: Depth,
    extraTypes: ExtraType[],
    roles: Set<ConversationMessageRole>,
    compactionMode: CompactionMode,
    options?: FormatRoundForMessageRolesOptions,
): string | FormatRoundForMessageRolesBudgetResult {
    const budgetState = {
        exceeded: false,
        notified: false,
        warningAppended: false,
    };
    const hasSoftBudget = Boolean(options?.shouldAbort) || Number.isFinite(options?.deadlineAt);
    const markBudgetExceeded = (): void => {
        if (budgetState.exceeded) return;
        budgetState.exceeded = true;
        if (!budgetState.notified) {
            budgetState.notified = true;
            options?.onBudgetExceeded?.();
        }
    };
    const isBudgetExceeded = (): boolean => {
        if (!options) return false;
        if (budgetState.exceeded) return true;
        if (options.shouldAbort?.()) {
            markBudgetExceeded();
            return true;
        }
        if (Number.isFinite(options.deadlineAt) && Date.now() >= Number(options.deadlineAt)) {
            markBudgetExceeded();
            return true;
        }
        return false;
    };
    const pushLine = (lines: string[], line: string): boolean => {
        if (isBudgetExceeded()) return false;
        lines.push(line);
        return true;
    };
    const appendBudgetWarning = (lines: string[]): void => {
        if (!budgetState.exceeded || budgetState.warningAppended || lines.length === 0) return;
        budgetState.warningAppended = true;
        lines.push("");
        lines.push("⚠️ 当前轮次格式化达到时间预算，剩余内容未展开");
    };
    const finalizeResult = (text: string): string | FormatRoundForMessageRolesBudgetResult => {
        if (!options) return text;
        return { text, budgetExceeded: budgetState.exceeded || isBudgetExceeded() };
    };

    if (roles.size === 0) {
        if (!options) return formatRound(round, depth, extraTypes, { compactionMode });
        if (isBudgetExceeded()) return finalizeResult("");
        return finalizeResult(formatRound(round, depth, extraTypes, { compactionMode }));
    }

    const systemLike = isSystemLikeRound(round);
    const userMessages = getRoundUserMessages(round);
    const explicitSystemEvents = (round.semanticEvents || []).filter(event => event.semanticRole === "system" && event.text);
    const legacySystemLike = systemLike && explicitSystemEvents.length === 0;
    const aiResponses = getRoundAiResponses(round);
    const toolCalls = getRoundToolCalls(round);
    const subagentSummaries = getRoundSubagentSummaries(round);
    const includeUser = roles.has("user") && !legacySystemLike;
    const includeSystem = roles.has("system") && (legacySystemLike || explicitSystemEvents.length > 0);
    const includeModel = roles.has("model") || roles.has("assistant");
    const includeTool = roles.has("tool");
    const includeSubagent = roles.has("subagent");
    const hasToolLike = toolCalls.length > 0
        || round.taskBoundaries.length > 0
        || round.codeActions.length > 0
        || (round.fileViews?.length || 0) > 0;

    if (!includeUser && !includeSystem && !(includeModel && aiResponses.length > 0) && !(includeTool && hasToolLike) && !(includeSubagent && subagentSummaries.length > 0)) {
        return finalizeResult("");
    }

    const lines: string[] = [];
    pushLine(lines, `## 轮次 ${round.roundIndex} (steps ${round.startStep}-${round.endStep})`);

    const renderUserMessages = (asSystem: boolean): void => {
        for (const message of userMessages) {
            const stepIndex = message.stepIndex ?? round.startStep;
            if (!pushLine(lines, asSystem
                ? `### 🧩 系统/压缩内容 (step ${stepIndex})`
                : `### 👤 用户 (step ${stepIndex})`)) break;
            const messageLines: string[] = [];
            renderHumanMessageContent(messageLines, message, depth, truncateForRoleView);
            for (const line of messageLines) {
                if (!pushLine(lines, line)) break;
            }
            const attachments = message.attachments || (userMessages.length === 1 ? round.attachments || [] : []);
            for (const attachment of attachments) {
                const label = attachment.kind === "image" ? "图片" : "文件";
                const target = attachment.tempPath || attachment.originalPath || attachment.name || "JSONL 内联图片";
                if (!pushLine(lines, `📎 ${label}: ${target}`)) break;
            }
            const mediaAttachments = message.mediaAttachments || (userMessages.length === 1 ? round.mediaAttachments || [] : []);
            for (const uri of mediaAttachments) {
                if (!pushLine(lines, `📎 图片: ${uri}`)) break;
            }
            if (budgetState.exceeded || !pushLine(lines, "")) break;
        }
    };

    if (includeSystem) {
        if (round.compactionSummaries?.length) {
            if (!pushLine(lines, `### 🧩 系统/压缩内容 (step ${round.startStep})`)) {
                appendBudgetWarning(lines);
                return finalizeResult(lines.join("\n").trimEnd());
            }
            for (const item of round.compactionSummaries) {
                const meta = `chars=${item.summaryChars}, sha256=${item.summarySha256.slice(0, 12)}`;
                if (compactionMode === "full" || depth === "full") {
                    if (!pushLine(lines, `🧩 Claude Code 压缩续聊摘要（已展开；这不是用户真实输入，${meta}）`)) break;
                    if (!pushLine(lines, "<<<CLAUDE_CODE_COMPACT_SUMMARY>>>")) break;
                    if (!pushLine(lines, truncateForRoleView(item.text, depth))) break;
                    if (!pushLine(lines, "<<<END_CLAUDE_CODE_COMPACT_SUMMARY>>>")) break;
                } else if (compactionMode === "omit") {
                    if (!pushLine(lines, `🧩 Claude Code 压缩续聊摘要已省略（${meta}）`)) break;
                } else {
                    if (!pushLine(lines, `🧩 Claude Code 压缩续聊摘要已折叠（${meta}）`)) break;
                    if (!pushLine(lines, "说明：这是上下文压缩后的 summary，不是原始用户发言；可用 depth=\"full\" 或 compactionMode=\"full\" 展开。")) break;
                }
            }
            if (!budgetState.exceeded) pushLine(lines, "");
        } else if (explicitSystemEvents.length > 0) {
            for (const event of explicitSystemEvents) {
                if (!pushLine(lines, `### 🧩 系统/压缩内容 (step ${event.stepIndex ?? round.startStep})`)) break;
                if (!pushLine(lines, truncateForRoleView(event.text || "", depth))) break;
                if (!pushLine(lines, "")) break;
            }
        } else {
            renderUserMessages(true);
        }
    }
    if (includeUser) renderUserMessages(false);

    const mergeAiTool = includeModel && includeTool;

    const renderAiBlock = (ai: ConversationRound["aiResponses"][number]): boolean => {
        const showThinking = Boolean(ai.thinking) && (depth === "full" || extraTypes.includes("thinking"));
        if (!ai.response && !showThinking) return true;
        if (!pushLine(lines, formatAiHeading(ai.stepIndex))) return false;
        if (ai.response && !pushLine(lines, truncateForRoleView(ai.response, depth))) return false;
        if (ai.thinking && (depth === "full" || extraTypes.includes("thinking"))) {
            if (!pushLine(lines, "")) return false;
            if (!pushLine(lines, `<details><summary>${thinkingSummaryLabelForRoleView(ai.thinking)}</summary>`)) return false;
            if (!pushLine(lines, "")) return false;
            if (!pushLine(lines, ai.thinking)) return false;
            if (!pushLine(lines, "</details>")) return false;
        }
        return pushLine(lines, "");
    };

    const renderToolLine = (tc: ConversationRound["toolCalls"][number]): boolean => {
        let line = `- ${tc.name}`;
        if (depth === "full" || extraTypes.includes("tool_results")) {
            line += `(${tc.argsSummary})`;
            if (tc.resultSummary) line += ` → ${truncateForRoleView(tc.resultSummary, depth === "full" ? "normal" : depth)}`;
        }
        return pushLine(lines, line);
    };

    if (!budgetState.exceeded && (mergeAiTool || includeTool)) {
        type Ev = { step: number; seq: number; isTool: boolean; render: () => boolean };
        const events: Ev[] = [];
        let seq = 0;
        const SENTINEL = round.endStep + 1_000_000;
        const safeStep = (s: number) => (Number.isFinite(s) ? s : SENTINEL);
        if (includeModel) {
            for (const ai of aiResponses) {
                events.push({ step: safeStep(ai.stepIndex), seq: seq++, isTool: false, render: () => renderAiBlock(ai) });
            }
        }
        for (const tc of toolCalls) {
            events.push({ step: safeStep(tc.stepIndex), seq: seq++, isTool: true, render: () => renderToolLine(tc) });
        }
        events.sort((a, b) => a.step - b.step || a.seq - b.seq);
        let prevToolStep: number | null = null;
        for (const ev of events) {
            if (budgetState.exceeded) break;
            if (ev.isTool) {
                if (prevToolStep !== ev.step) {
                    if (!pushLine(lines, `#### 🔧 工具调用 (step ${Number.isFinite(ev.step) && ev.step < SENTINEL ? ev.step : "?"})`)) break;
                    prevToolStep = ev.step;
                }
                if (!ev.render()) break;
            } else {
                if (prevToolStep !== null) {
                    if (!pushLine(lines, "")) break;
                    prevToolStep = null;
                }
                if (!ev.render()) break;
            }
        }
        if (!budgetState.exceeded && prevToolStep !== null) pushLine(lines, "");
    } else if (!budgetState.exceeded && includeModel) {
        for (const ai of aiResponses) {
            if (!renderAiBlock(ai)) break;
        }
    } else if (!budgetState.exceeded && includeTool && toolCalls.length > 0) {
        if (pushLine(lines, "#### 🔧 工具调用")) {
            for (const tc of toolCalls) {
                if (!renderToolLine(tc)) break;
            }
            if (!budgetState.exceeded) pushLine(lines, "");
        }
    }

    if (!budgetState.exceeded && includeTool) {
        if (round.taskBoundaries.length > 0 && depth !== "brief") {
            const latest = round.taskBoundaries[round.taskBoundaries.length - 1];
            if (pushLine(lines, `📋 任务: ${latest.taskName} → ${latest.taskStatus}`)) {
                pushLine(lines, "");
            }
        }
        if (!budgetState.exceeded && round.codeActions.length > 0 && (extraTypes.includes("code_actions") || extraTypes.includes("code_diffs"))) {
            renderCodeActionSection(round, extraTypes, (line) => pushLine(lines, line));
        }
        if (!budgetState.exceeded && round.fileViews?.length && extraTypes.includes("file_views")) {
            if (pushLine(lines, "#### 📄 文件/计划视图")) {
                for (const view of round.fileViews) {
                    if (!pushLine(lines, `- ${view.kind}${view.title ? ` / ${view.title}` : ""}: ${view.textSummary}`)) break;
                }
                if (!budgetState.exceeded) pushLine(lines, "");
            }
        }
    }

    if (!budgetState.exceeded && includeSubagent && subagentSummaries.length > 0) {
        if (pushLine(lines, "#### 🤝 子代理线程")) {
            for (const subagent of subagentSummaries) {
                const detail = subagent.status || subagent.summary || subagent.prompt || "";
                if (!pushLine(lines, detail
                    ? `- ${formatSubagentLabel(subagent)}: ${truncateForRoleView(detail, depth)}`
                    : `- ${formatSubagentLabel(subagent)}`)) break;
            }
            if (!budgetState.exceeded) pushLine(lines, "");
        }
    }

    if (hasSoftBudget && budgetState.exceeded) appendBudgetWarning(lines);
    return finalizeResult(lines.join("\n").trimEnd());
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
    matchType: "user" | "ai" | "annotation";
    matchText: string;        // 匹配的文本片段
    contextStart: number;     // 上下文起始位置（字符）
    hitCount: number;         // 命中的 token 数量（用于排序）
    annotationIndex?: number;
    annotationField?: "selectedText" | "comment";
    annotationSelectedText?: string;
    annotationComment?: string;
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
        const userTexts: string[] = [];
        const seenAnnotations = new Set<string>();
        let annotationIndex = 0;
        for (const message of getRoundUserMessages(round)) {
            const parsed = parseResponseAnnotations(message.text || "");
            if (parsed.text.trim()) userTexts.push(parsed.text);
            for (const annotation of [...parsed.annotations, ...(message.annotations || [])]) {
                const annotationKey = `${annotation.selectedText}\u0000${annotation.comment}`;
                if (seenAnnotations.has(annotationKey)) continue;
                seenAnnotations.add(annotationKey);
                annotationIndex += 1;
                for (const [field, value] of [
                    ["selectedText", annotation.selectedText],
                    ["comment", annotation.comment],
                ] as const) {
                    const valueLower = value.toLowerCase();
                    const annotationHits = tokens.filter(token => valueLower.includes(token));
                    if (annotationHits.length === 0) continue;
                    const firstToken = annotationHits[0];
                    const idx = valueLower.indexOf(firstToken);
                    candidates.push({
                        roundIndex: round.roundIndex,
                        matchType: "annotation",
                        matchText: extractContext(value, idx, firstToken.length, 100),
                        contextStart: idx,
                        hitCount: annotationHits.length,
                        annotationIndex,
                        annotationField: field,
                        annotationSelectedText: annotation.selectedText,
                        annotationComment: annotation.comment,
                    });
                }
            }
        }
        const userText = userTexts.join("\n");
        const userLower = userText.toLowerCase();

        // 搜索用户消息
        const userHits = tokens.filter(t => userLower.includes(t));
        if (userHits.length > 0) {
            // 找第一个命中 token 的位置作为上下文锚点
            const firstToken = userHits[0];
            const idx = userLower.indexOf(firstToken);
            candidates.push({
                roundIndex: round.roundIndex,
                matchType: "user",
                matchText: extractContext(userText, idx, firstToken.length, 100),
                contextStart: idx,
                hitCount: userHits.length,
            });
        }

        const aiTexts = [
            ...getRoundAiResponses(round).flatMap((ai) => [
                ai.response,
                ai.thinking,
                ...ai.toolCalls.map((toolCall) => toolCall.args),
            ]),
            ...getRoundToolCalls(round).flatMap((toolCall) => [
                toolCall.argsFull || toolCall.argsSummary,
                toolCall.resultFull || toolCall.resultSummary,
            ]),
        ];
        const seenAiTexts = new Set<string>();
        for (const aiText of aiTexts) {
            if (!aiText || seenAiTexts.has(aiText)) continue;
            seenAiTexts.add(aiText);
            const aiLower = aiText.toLowerCase();
            const aiHits = tokens.filter(t => aiLower.includes(t));
            if (aiHits.length > 0) {
                const firstToken = aiHits[0];
                const idx = aiLower.indexOf(firstToken);
                candidates.push({
                    roundIndex: round.roundIndex,
                    matchType: "ai",
                    matchText: extractContext(aiText, idx, firstToken.length, 100),
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
