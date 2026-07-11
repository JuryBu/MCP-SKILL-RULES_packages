import fs from "fs";
import path from "path";
import { newUuid } from "../owner.js";
import { callCouncilModel, DEFAULT_COUNCIL_MODEL_TIMEOUT_MS } from "./providers.js";
import { runCouncilTool } from "./tools.js";
import { saveCouncilTranscript } from "./transcript.js";
import { prepareCouncilFiles } from "./file-input.js";
import { prepareCouncilLargeInputs } from "./large-input.js";
import type {
    CouncilModelConfig,
    CouncilModeratorDecision,
    CouncilCheckpoint,
    CouncilRunParams,
    CouncilToolCall,
    CouncilToolResult,
    CouncilTranscript,
    CouncilTurnMessage,
} from "./types.js";

const DEFAULT_MAX_ROUNDS = Number(process.env.SANDBOX_COUNCIL_MAX_ROUNDS || 4);
const DEFAULT_MAX_TOOL_CALLS = Number(process.env.SANDBOX_COUNCIL_MAX_TOOL_CALLS || 6);
const MAX_TOOL_CALLS_PER_ROUND = 3;
const MAX_MODERATOR_STEPS_PER_ROUND = Number(process.env.SANDBOX_COUNCIL_MAX_TOOL_STEPS_PER_ROUND || 4);
const MAX_TOTAL_CONTEXT_CHARS = Number(process.env.SANDBOX_COUNCIL_CONTEXT_MAX_CHARS || 90000);
const DEFAULT_PRESSURE_MODEL_TIMEOUT_MS = Number(process.env.SANDBOX_COUNCIL_PRESSURE_MODEL_TIMEOUT_MS || 600_000);
const COUNCIL_TOOL_NAMES = new Set(["webSearch", "webFetchText", "simpleScript"]);

function clip(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n... (truncated ${text.length - maxChars} chars)`;
}

function supportsDirectImageInput(config: CouncilRunParams["participants"][number] | CouncilRunParams["moderator"]): boolean {
    if (!config.supportsVision) return false;
    return ["openai", "anthropic", "gemini", "geminiCli", "grok", "customOpenAICompatible"].includes(config.provider);
}

function normalizeTimeoutMs(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.max(10_000, Math.min(Math.trunc(value), 30 * 60_000));
}

function hasPressureInputs(files: CouncilTranscript["files"], largeInputs: CouncilTranscript["largeInputs"] = [], imagePaths: string[] = []): boolean {
    return largeInputs.length > 0
        || imagePaths.length > 0
        || files.some((file) => ["large_input_index", "agentic_index", "structured_extract", "promoted_image"].includes(file.ingestMode || ""));
}

function getRunModelTimeoutMs(params: CouncilRunParams, pressureInputs: boolean): number {
    const explicit = normalizeTimeoutMs(params.modelTimeoutMs);
    if (explicit) return explicit;
    if (!pressureInputs) return DEFAULT_COUNCIL_MODEL_TIMEOUT_MS;
    return normalizeTimeoutMs(params.pressureModelTimeoutMs) ?? DEFAULT_PRESSURE_MODEL_TIMEOUT_MS;
}

function modeInstruction(mode: string, roles?: Record<string, string>): string {
    const roleText = roles ? Object.entries(roles).map(([key, value]) => `${key}: ${value}`).join("\n") : "";
    if (mode === "red_blue_black") {
        return `讨论模式: 红蓝黑队。红队找漏洞和反例，蓝队提出建设性方案，黑队做破坏性审查和极端场景压力测试。\n${roleText}`;
    }
    if (mode === "design") return `讨论模式: 设计审议。重点比较方案、接口、风险、实现节奏。\n${roleText}`;
    if (mode === "guard_check") return `讨论模式: Guard 检查。重点审查是否满足任务要求、遗漏、证据和验收标准。\n${roleText}`;
    if (mode === "review") return `讨论模式: 审议 Review。重点输出问题、风险、缺失验证和改进建议。\n${roleText}`;
    return `讨论模式: 自定义。\n${roleText}`;
}

function buildSharedContext(params: CouncilRunParams): string {
    const contextMode = params.contextMode || "summary";
    const parts: string[] = [
        `# 用户输入\n${params.input}`,
        `# 模式说明\n${modeInstruction(params.mode || "review", params.roles)}`,
    ];
    if (contextMode === "none") {
        return clip(parts.join("\n\n"), MAX_TOTAL_CONTEXT_CHARS);
    }
    if (contextMode === "manual" && params.manualContext) {
        parts.push(`# 手动上下文\n${params.manualContext}`);
        return clip(parts.filter(Boolean).join("\n\n"), MAX_TOTAL_CONTEXT_CHARS);
    } else if (params.manualContext) {
        parts.push(`# 附加上下文\n${params.manualContext}`);
    }
    return clip(parts.filter(Boolean).join("\n\n"), MAX_TOTAL_CONTEXT_CHARS);
}

function formatFilesSection(files: CouncilTranscript["files"], contextMode: CouncilRunParams["contextMode"] = "summary"): string {
    if (files.length > 0) {
        return `# 背景文件\n${files.map((file) => {
            const title = `${file.label ? `${file.label}: ` : ""}${file.path}${file.range ? ` (${file.range})` : ""}`;
            const fileText = contextMode === "summary" ? clip(file.text, 4000) : file.text;
            return `## ${title}\n${file.ok ? fileText : `读取失败: ${file.text}`}`;
        }).join("\n\n")}`;
    }
    return "";
}

function buildParticipantContext(
    params: CouncilRunParams,
    actor: CouncilRunParams["participants"][number] | CouncilRunParams["moderator"],
    sharedContext: string,
    files: CouncilTranscript["files"],
    imageObservations: string,
    textProjection: string,
): string {
    const contextMode = params.contextMode || "summary";
    const parts = [sharedContext];
    const usesOnlyTextProjection = (params.images?.length || files.length) && !supportsDirectImageInput(actor) && Boolean(textProjection);
    if (usesOnlyTextProjection) {
        parts.push(`# 供纯文本模型使用的转换后材料\n${contextMode === "summary" ? clip(textProjection, 6000) : textProjection}`);
    } else {
        const filesSection = formatFilesSection(files, contextMode);
        if (filesSection) {
            parts.push(filesSection);
        }
        if (imageObservations && !supportsDirectImageInput(actor)) {
            parts.push(`# 多模态转述\n${contextMode === "summary" ? clip(imageObservations, 4000) : imageObservations}`);
        }
    }
    return clip(parts.filter(Boolean).join("\n\n"), MAX_TOTAL_CONTEXT_CHARS);
}

function formatHistory(rounds: CouncilTranscript["rounds"]): string {
    const text = rounds.map((round) => {
        const messages = round.messages.map((message) => {
            const body = message.error ? `ERROR: ${message.error}` : message.text;
            return `[${message.participantId}/${message.role}]\n${body}`;
        }).join("\n\n");
        const moderatorSteps = round.moderatorSteps && round.moderatorSteps.length > 0
            ? round.moderatorSteps
            : [round.moderator];
        const moderatorText = moderatorSteps.map((step, index) => {
            const tools = step.toolResults && step.toolResults.length > 0
                ? `\n\n${step.toolResults.map((toolResult, toolIndex) => `[tool-step:${index + 1}:${toolIndex + 1}:${toolResult.tool}:${toolResult.ok ? "ok" : "error"}]\n${toolResult.text}`).join("\n\n")}`
                : "";
            const afterToolInstruction = step.afterToolInstruction
                ? `\n\n[moderator-step:${index + 1}:afterToolInstruction]\n${step.afterToolInstruction}`
                : "";
            return `[moderator-step:${index + 1}:${step.action}]\n${step.summary}${tools}${afterToolInstruction}`;
        }).join("\n\n");
        return `Round ${round.round}\n${messages}\n\n${moderatorText}`;
    }).join("\n\n---\n\n");
    return clip(text, 50000);
}

function participantPrompt(params: CouncilRunParams, participantId: string, role: string, baseContext: string, history: string, extraInstruction?: string): string {
    return [
        "你是 sandbox_council 的参与模型。你不能调用工具，只能提出分析、质疑、建议或说明需要主持人查证的内容。",
        `你的身份: ${participantId}`,
        `你的角色: ${role}`,
        extraInstruction ? `主持人额外指令: ${extraInstruction}` : "",
        baseContext,
        history ? `# 已有讨论\n${history}` : "",
        "请用中文输出，保持聚焦。明确写出你的判断、证据、风险和下一步建议。",
    ].filter(Boolean).join("\n\n");
}

function moderatorPrompt(
    params: CouncilRunParams,
    baseContext: string,
    history: string,
    messages: CouncilTurnMessage[],
    toolCallsUsed: number,
    maxToolCalls: number,
    roundToolResults: CouncilToolResult[] = [],
    moderatorStep = 1,
): string {
    const availableTools = Object.entries({
        webSearch: params.tools?.webSearch !== false,
        webFetchText: params.tools?.webFetchText !== false,
        simpleScript: params.tools?.simpleScript !== false,
    }).filter(([, enabled]) => enabled).map(([name]) => name).join(", ");
    const currentMessages = messages.map((message) => `[${message.participantId}/${message.role}]\n${message.error ? `ERROR: ${message.error}` : message.text}`).join("\n\n");
    const currentToolResults = roundToolResults.length > 0
        ? `# 本轮已执行工具\n${roundToolResults.map((toolResult, index) => `[tool:${index + 1}:${toolResult.tool}:${toolResult.ok ? "ok" : "error"}]\n${toolResult.text}`).join("\n\n")}`
        : "";
    return [
        "你是 sandbox_council 的主持模型。你负责控制讨论节奏、决定是否调用工具、点名补充或终止。",
        "只有你可以调用工具。参与模型的工具请求只能作为建议。",
        `可用工具: ${availableTools || "无"}`,
        `已用工具次数: ${toolCallsUsed}/${maxToolCalls}`,
        `当前主持步骤: ${moderatorStep}/${MAX_MODERATOR_STEPS_PER_ROUND}`,
        "",
        "你必须只输出 JSON，不要输出 Markdown。JSON schema:",
        `{"action":"continue|tool|ask|terminate","summary":"本轮简洁总结","targetParticipantId":"可选，被点名参与者 id","instruction":"可选，点名补充要求","toolCall":{"tool":"webSearch|webFetchText|simpleScript","reason":"旧版单工具调用，仍兼容","args":{}},"toolCalls":[{"tool":"webSearch|webFetchText|simpleScript","reason":"为什么需要工具","args":{}}],"afterToolInstruction":"可选，工具结果返回后给下一轮所有参与者的额外指令","finalAnswer":"终止时的最终结论"}`,
        "",
        "工具参数约定:",
        "- webSearch: {\"query\":\"...\",\"maxResults\":5}",
        "- webFetchText: {\"url\":\"https://...\",\"maxChars\":8000,\"extract\":\"text|html|links|tables\"}",
        "- simpleScript: {\"language\":\"node|python\",\"code\":\"...\",\"input\":{}}。默认 language=node；Python 仅限 AST 白名单和安全模块子集。",
        `- 每轮最多请求 ${MAX_TOOL_CALLS_PER_ROUND} 个工具；总工具调用仍受 maxToolCalls 限制。优先使用 toolCalls 数组；只有单个工具时也可以继续使用旧版 toolCall。`,
        "- 如果刚执行完工具，请先基于本轮已执行工具结果判断：还要不要继续工具调用。只有仍缺少关键信息时才继续 action=tool。",
        `- 同一轮里你最多会被再次调用 ${MAX_MODERATOR_STEPS_PER_ROUND} 次；到上限后系统会强制进入下一轮或收束。`,
        "",
        baseContext,
        history ? `# 已有讨论\n${history}` : "",
        `# 本轮参与者发言\n${currentMessages}`,
        currentToolResults,
        "",
        "如果信息已经足够，请 action=terminate。若仍需查证且工具次数未用尽，可 action=tool。若只需下一轮讨论，action=continue 或 action=ask。",
    ].join("\n");
}

function extractJsonObject(text: string): any | null {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
    const candidate = fenced || text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(candidate.slice(start, end + 1));
    } catch {
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolCall(value: unknown): CouncilToolCall | undefined {
    if (!isRecord(value) || typeof value.tool !== "string" || !COUNCIL_TOOL_NAMES.has(value.tool) || !isRecord(value.args)) {
        return undefined;
    }
    return {
        tool: value.tool as CouncilToolCall["tool"],
        args: value.args,
        reason: typeof value.reason === "string" ? value.reason : undefined,
    };
}

function getModeratorToolCalls(moderator: CouncilModeratorDecision): CouncilToolCall[] {
    if (moderator.toolCalls && moderator.toolCalls.length > 0) {
        return moderator.toolCalls;
    }
    return moderator.toolCall ? [moderator.toolCall] : [];
}

function getRoundToolResults(round: CouncilTranscript["rounds"][number]) {
    if (round.toolResults && round.toolResults.length > 0) {
        return round.toolResults;
    }
    return round.toolResult ? [round.toolResult] : [];
}

function summarizeForProgress(text: string, maxChars = 500): string {
    const normalized = text.replace(/\s+/gu, " ").trim();
    return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}...` : normalized;
}

function formatProgressLine(transcript: CouncilTranscript, message: string): string {
    const lastRound = transcript.rounds.at(-1);
    const toolCalls = transcript.rounds.reduce((total, round) => total + getRoundToolResults(round).length, 0);
    const lines = [
        message,
        `已完成轮次: ${transcript.rounds.length}`,
        `已执行工具: ${toolCalls}`,
    ];
    if (lastRound) {
        const okMessages = lastRound.messages.filter((item) => !item.error).length;
        const errorMessages = lastRound.messages.filter((item) => item.error).length;
        lines.push(`最近一轮: Round ${lastRound.round}，参与者成功 ${okMessages}，失败 ${errorMessages}`);
        if (lastRound.moderator.summary) {
            lines.push(`主持摘要: ${summarizeForProgress(lastRound.moderator.summary)}`);
        }
        const toolResults = getRoundToolResults(lastRound);
        if (toolResults.length > 0) {
            lines.push(`最近工具: ${toolResults.map((tool) => `${tool.tool}:${tool.ok ? "ok" : "error"}`).join(", ")}`);
        }
    }
    return lines.join("\n");
}

function emitProgress(params: CouncilRunParams, transcript: CouncilTranscript, message: string): void {
    params.onProgress?.(formatProgressLine(transcript, message));
}

function writeJsonAtomic(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf-8");
    fs.renameSync(temp, filePath);
}

function writeCheckpoint(params: CouncilRunParams, transcript: CouncilTranscript, checkpoint: Omit<CouncilCheckpoint, "transcriptId" | "updatedAt">): void {
    if (!params.checkpointPath) return;
    writeJsonAtomic(params.checkpointPath, {
        ...checkpoint,
        transcriptId: transcript.id,
        updatedAt: new Date().toISOString(),
    });
}

function savePartialTranscript(params: CouncilRunParams, transcript: CouncilTranscript): CouncilTranscript {
    if (!params.transcriptPath) return transcript;
    return saveCouncilTranscript(transcript, params.transcriptPath, params.outputDir);
}

function cloneTranscript(transcript: CouncilTranscript): CouncilTranscript {
    return JSON.parse(JSON.stringify(transcript)) as CouncilTranscript;
}

function roundsBeforeResumePoint(rounds: CouncilTranscript["rounds"], checkpoint: CouncilCheckpoint): CouncilTranscript["rounds"] {
    if (checkpoint.roundComplete) {
        const completedRound = Math.max(checkpoint.lastCompletedRound || 0, checkpoint.currentRound || 0);
        return rounds.filter((round) => round.round <= completedRound);
    }
    return rounds.filter((round) => round.round < checkpoint.currentRound);
}

function getNextRoundFromCheckpoint(transcript: CouncilTranscript, checkpoint?: CouncilCheckpoint): number {
    if (!checkpoint) {
        return transcript.rounds.length > 0
            ? Math.max(...transcript.rounds.map((round) => round.round)) + 1
            : 1;
    }
    if (checkpoint.roundComplete) {
        return Math.max(checkpoint.lastCompletedRound || 0, checkpoint.currentRound || 0) + 1;
    }
    return Math.max(1, checkpoint.currentRound);
}

function restoreLoopState(rounds: CouncilTranscript["rounds"]): {
    toolCallsUsed: number;
    askTarget?: string;
    askInstruction?: string;
    afterToolInstruction?: string;
} {
    const lastRound = rounds.at(-1);
    const lastModerator = lastRound?.moderator;
    const lastSteps = lastRound?.moderatorSteps && lastRound.moderatorSteps.length > 0
        ? lastRound.moderatorSteps
        : lastModerator ? [lastModerator] : [];
    const lastAfterToolInstruction = [...lastSteps].reverse().find((step) => step.afterToolInstruction)?.afterToolInstruction;
    return {
        toolCallsUsed: rounds.reduce((total, round) => total + getRoundToolResults(round).length, 0),
        askTarget: lastModerator?.action === "ask" ? lastModerator.targetParticipantId : undefined,
        askInstruction: lastModerator?.action === "ask" ? lastModerator.instruction : undefined,
        afterToolInstruction: lastAfterToolInstruction,
    };
}

function parseModeratorDecision(rawText: string): CouncilModeratorDecision {
    const parsed = extractJsonObject(rawText);
    if (!parsed) {
        const isTerminate = /\bTERMINATE\b|最终|结论/iu.test(rawText);
        const fallbackSummary = rawText.trim()
            ? `主持模型未输出可解析 JSON，已按文本兜底处理。\n\n原始输出:\n${rawText}`
            : "主持模型未输出可解析 JSON，且返回内容为空，已按 continue 兜底处理。";
        return {
            action: isTerminate ? "terminate" : "continue",
            summary: fallbackSummary,
            finalAnswer: isTerminate ? fallbackSummary : undefined,
            rawText,
        };
    }
    const action = ["continue", "tool", "ask", "terminate"].includes(parsed.action) ? parsed.action : "continue";
    const parsedToolCalls = Array.isArray(parsed.toolCalls)
        ? (parsed.toolCalls as unknown[]).map(parseToolCall).filter((call): call is CouncilToolCall => Boolean(call))
        : [];
    const toolCall = parseToolCall(parsed.toolCall);
    const toolCalls = parsedToolCalls.length > 0
        ? parsedToolCalls
        : (toolCall ? [toolCall] : undefined);
    const legacyToolCall = toolCall || toolCalls?.[0];
    return {
        action,
        summary: typeof parsed.summary === "string" ? parsed.summary : rawText,
        targetParticipantId: typeof parsed.targetParticipantId === "string" ? parsed.targetParticipantId : undefined,
        instruction: typeof parsed.instruction === "string" ? parsed.instruction : undefined,
        toolCall: legacyToolCall,
        toolCalls,
        afterToolInstruction: typeof parsed.afterToolInstruction === "string" ? parsed.afterToolInstruction : undefined,
        finalAnswer: typeof parsed.finalAnswer === "string" ? parsed.finalAnswer : undefined,
        rawText,
    };
}

function buildModeratorFailureDecision(messages: CouncilTurnMessage[], err: unknown): CouncilModeratorDecision {
    const error = err instanceof Error ? err.message : String(err);
    const successful = messages.filter((message) => !message.error && message.text.trim());
    const failed = messages.filter((message) => message.error);
    const sections = [
        `主持模型调用失败，已使用规则兜底提前收束。错误: ${error}`,
        `已收集 ${messages.length} 条参与者发言：成功 ${successful.length} 条，失败 ${failed.length} 条。`,
    ];

    if (successful.length > 0) {
        sections.push([
            "可用参与者意见摘要:",
            ...successful.map((message) => `- ${message.participantId}/${message.role}: ${summarizeForProgress(message.text, 700)}`),
        ].join("\n"));
    }

    if (failed.length > 0) {
        sections.push([
            "失败参与者:",
            ...failed.map((message) => `- ${message.participantId}/${message.role}: ${message.error}`),
        ].join("\n"));
    }

    sections.push("风险: 该结论是规则兜底汇总，不包含主持模型的二次综合判断。");
    const summary = sections.join("\n\n");
    return {
        action: "terminate",
        summary,
        finalAnswer: summary,
        rawText: "",
    };
}

async function buildImageObservations(params: CouncilRunParams): Promise<string> {
    const imagePaths = params.images || [];
    if (imagePaths.length === 0) return "";
    const model = (params.transcriptionModel && supportsDirectImageInput(params.transcriptionModel) ? params.transcriptionModel : undefined)
        || params.participants.find((p) => supportsDirectImageInput(p))
        || (supportsDirectImageInput(params.moderator) ? params.moderator : undefined);
    if (!model) {
        return "未配置能直接读取图片的转述模型；图片未被模型读取。";
    }
    try {
        const prompt = [
            "请把这些图片转述成可供多模型文本讨论使用的观察记录。",
            "要求：描述可见文字、布局、数据、异常、可能不确定处；不要做身份识别。",
        ].join("\n");
        const result = await callCouncilModel({ ...model, supportsVision: true }, prompt, imagePaths);
        return result.text;
    } catch (err) {
        return `多模态转述失败: ${err instanceof Error ? err.message : String(err)}`;
    }
}

function hasOnlyTextActors(params: CouncilRunParams): boolean {
    return [...params.participants, params.moderator].some((actor) => !supportsDirectImageInput(actor));
}

function defaultTextProjectionModel(): CouncilModelConfig {
    return {
        id: "text_projection",
        role: "纯文本输入转述器",
        provider: "codex",
        model: process.env.SANDBOX_COUNCIL_TEXT_PROJECTION_MODEL || "gpt-5.4-mini",
        params: {
            reasoning: process.env.SANDBOX_COUNCIL_TEXT_PROJECTION_REASONING || "medium",
            speed: process.env.SANDBOX_COUNCIL_TEXT_PROJECTION_SPEED || "fast",
        },
    };
}

async function buildOnlyTextProjection(
    params: CouncilRunParams,
    sharedContext: string,
    files: CouncilTranscript["files"],
    imageObservations: string,
): Promise<string> {
    if ((files.length === 0 && (!params.images || params.images.length === 0)) || !hasOnlyTextActors(params)) {
        return "";
    }
    const fileSection = formatFilesSection(files, params.contextMode || "summary");
    const prompt = [
        "你在为 sandbox_council 的纯文本参与者准备输入材料。",
        "请把下面的文件内容、图片观察和上下文整理成忠实、细致、可直接讨论的纯文本 dossier。",
        "要求：能直接保留文字、数字、代码、表格结论的尽量保留；图片或非文本材料要详细转述；标出不确定性，不要编造。",
        "输出建议结构：关键事实 / 文件要点与摘录 / 图片与非文本材料转述 / 不确定性。",
        sharedContext,
        fileSection,
        imageObservations ? `# 图片观察原始转述\n${imageObservations}` : "",
    ].filter(Boolean).join("\n\n");
    const model = params.textProjectionModel || defaultTextProjectionModel();
    try {
        const result = await callCouncilModel(model, prompt, []);
        return result.text;
    } catch (err) {
        const fallbackSections = [
            "纯文本输入转述生成失败，以下为原始可用材料回退。",
            err instanceof Error ? `错误: ${err.message}` : `错误: ${String(err)}`,
            fileSection,
            imageObservations ? `# 图片观察原始转述\n${imageObservations}` : "",
        ].filter(Boolean);
        return fallbackSections.join("\n\n");
    }
}

export async function runCouncil(params: CouncilRunParams): Promise<CouncilTranscript> {
    if (!params.participants || params.participants.length === 0) {
        throw new Error("sandbox_council 需要至少 1 个 participant");
    }
    const maxRounds = Math.max(1, Math.min(params.maxRounds || DEFAULT_MAX_ROUNDS, 8));
    const maxToolCalls = Math.max(0, Math.min(params.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS, 10));
    let effectiveParams: CouncilRunParams;
    let transcript: CouncilTranscript;
    let files: CouncilTranscript["files"];
    let largeInputs: NonNullable<CouncilTranscript["largeInputs"]>;
    let imagePaths: string[];
    let imageObservations: string;
    let textProjection: string | undefined;
    let startRound = 1;

    if (params.resumeState) {
        const checkpoint = params.resumeState.checkpoint;
        const resumedTranscript = cloneTranscript(params.resumeState.transcript);
        resumedTranscript.rounds = roundsBeforeResumePoint(resumedTranscript.rounds, checkpoint);
        resumedTranscript.terminationReason = "not-finished";
        resumedTranscript.finalAnswer = "";
        effectiveParams = { ...params, images: resumedTranscript.images };
        transcript = {
            ...resumedTranscript,
            mode: effectiveParams.mode || resumedTranscript.mode,
            input: effectiveParams.input,
            contextMode: effectiveParams.contextMode || resumedTranscript.contextMode,
            participants: effectiveParams.participants,
            moderator: effectiveParams.moderator,
        };
        files = transcript.files;
        largeInputs = transcript.largeInputs || [];
        imagePaths = transcript.images;
        imageObservations = transcript.imageObservations;
        textProjection = transcript.textProjection;
        startRound = getNextRoundFromCheckpoint(transcript, checkpoint);
        emitProgress(params, transcript, `council resume 已读取旧任务 ${params.resumeState.sourceTaskId}，将从 Round ${startRound} 继续。`);
    } else {
        const largePrepared = await prepareCouncilLargeInputs(params);
        const runParams = largePrepared.params;
        const prepared = await prepareCouncilFiles({
            files: runParams.files,
            largeInput: runParams.largeInput,
            onProgress: (message) => params.onProgress?.(`## 当前进度\n${message}`),
        });
        files = prepared.files;
        largeInputs = [...largePrepared.largeInputs, ...prepared.largeInputs];
        imagePaths = [...new Set([...(runParams.images || []).map((item) => path.resolve(item)), ...prepared.promotedImages])];
        effectiveParams = imagePaths.length === (runParams.images || []).length
            ? runParams
            : { ...runParams, images: imagePaths };
        imageObservations = await buildImageObservations(effectiveParams);
        const sharedContextForProjection = buildSharedContext(effectiveParams);
        textProjection = await buildOnlyTextProjection(effectiveParams, sharedContextForProjection, files, imageObservations);
        transcript = {
            id: newUuid(),
            mode: effectiveParams.mode || "review",
            input: effectiveParams.input,
            contextMode: effectiveParams.contextMode || "summary",
            participants: effectiveParams.participants,
            moderator: effectiveParams.moderator,
            files,
            largeInputs,
            images: imagePaths,
            imageObservations,
            textProjection,
            rounds: [],
            terminationReason: "not-finished",
            finalAnswer: "",
            createdAt: new Date().toISOString(),
        };
        emitProgress(params, transcript, "council 已完成输入、文件和图片准备；纯文本参与者的专用转述也已生成，准备开始第 1 轮参与者发言。");
    }

    writeCheckpoint(params, transcript, {
        taskId: params.resumeState?.sourceTaskId,
        currentRound: startRound,
        lastCompletedRound: transcript.rounds.at(-1)?.round || 0,
        phase: "prepared",
        roundComplete: false,
    });
    const sharedContext = buildSharedContext(effectiveParams);
    const participantContexts = new Map(effectiveParams.participants.map((participant) => [
        participant.id,
        buildParticipantContext(effectiveParams, participant, sharedContext, files, imageObservations, textProjection || ""),
    ]));
    const moderatorContext = buildParticipantContext(effectiveParams, effectiveParams.moderator, sharedContext, files, imageObservations, textProjection || "");
    const pressureInputs = hasPressureInputs(files, largeInputs, imagePaths);
    const modelTimeoutMs = getRunModelTimeoutMs(effectiveParams, pressureInputs);
    if (pressureInputs) {
        emitProgress(params, transcript, `检测到大输入/复杂文件/图片压力输入，正式模型调用超时已放宽到 ${Math.round(modelTimeoutMs / 1000)}s；仍可用 modelTimeoutMs、pressureModelTimeoutMs 或单个模型 params.timeoutMs 覆盖。`);
    }

    let { toolCallsUsed, askTarget, askInstruction, afterToolInstruction } = restoreLoopState(transcript.rounds);

    for (let round = startRound; round <= maxRounds; round++) {
        writeCheckpoint(params, transcript, {
            taskId: params.resumeState?.sourceTaskId,
            currentRound: round,
            lastCompletedRound: transcript.rounds.at(-1)?.round || 0,
            phase: "participants",
            roundComplete: false,
        });
        const history = formatHistory(transcript.rounds);
        const activeParticipants = askTarget
            ? effectiveParams.participants.filter((p) => p.id === askTarget)
            : effectiveParams.participants;
        const participantsToCall = activeParticipants.length > 0 ? activeParticipants : effectiveParams.participants;
        const extraInstruction = [afterToolInstruction, askInstruction].filter(Boolean).join("\n\n");
        let completedParticipants = 0;
        emitProgress(params, transcript, `Round ${round}: 正在调用 ${participantsToCall.length} 个参与模型。`);
        const messages = await Promise.all(participantsToCall.map(async (participant): Promise<CouncilTurnMessage> => {
            try {
                const prompt = participantPrompt(effectiveParams, participant.id, participant.role, participantContexts.get(participant.id) || sharedContext, history, extraInstruction);
                const result = await callCouncilModel(participant, prompt, supportsDirectImageInput(participant) ? imagePaths : [], modelTimeoutMs);
                completedParticipants++;
                params.onProgress?.(`Round ${round}: ${participant.id}/${participant.role} 已返回 (${completedParticipants}/${participantsToCall.length})，模型=${result.model}\n摘要: ${summarizeForProgress(result.text)}`);
                return {
                    round,
                    participantId: participant.id,
                    role: participant.role,
                    provider: participant.provider,
                    model: result.model,
                    text: result.text,
                    metadata: result.metadata,
                };
            } catch (err) {
                completedParticipants++;
                params.onProgress?.(`Round ${round}: ${participant.id}/${participant.role} 调用失败 (${completedParticipants}/${participantsToCall.length})\n错误: ${err instanceof Error ? err.message : String(err)}`);
                return {
                    round,
                    participantId: participant.id,
                    role: participant.role,
                    provider: participant.provider,
                    text: "",
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        }));
        askTarget = undefined;
        askInstruction = undefined;
        afterToolInstruction = undefined;
        // 参与者返回后立即落盘半完成轮，确保 moderator 阶段被中断时 transcript 可 resume
        const partialRoundEntry: CouncilTranscript["rounds"][number] = {
            round,
            messages,
            moderator: { action: "continue", summary: "", rawText: "" },
        };
        const partialTranscript = cloneTranscript(transcript);
        partialTranscript.rounds.push(partialRoundEntry);
        savePartialTranscript(params, partialTranscript);
        writeCheckpoint(params, transcript, {
            taskId: params.resumeState?.sourceTaskId,
            currentRound: round,
            lastCompletedRound: transcript.rounds.at(-1)?.round || 0,
            phase: "moderator",
            roundComplete: false,
        });

        let moderator: CouncilModeratorDecision = {
            action: "continue",
            summary: "",
            rawText: "",
        };
        const moderatorSteps: CouncilModeratorDecision[] = [];
        const roundToolResults: CouncilToolResult[] = [];
        let moderatorStep = 0;
        while (true) {
            moderatorStep++;
            const modPrompt = moderatorPrompt(effectiveParams, moderatorContext, history, messages, toolCallsUsed, maxToolCalls, roundToolResults, moderatorStep);
            try {
                const moderatorResult = await callCouncilModel(effectiveParams.moderator, modPrompt, supportsDirectImageInput(effectiveParams.moderator) ? imagePaths : [], modelTimeoutMs);
                moderator = parseModeratorDecision(moderatorResult.text);
                moderator.metadata = moderatorResult.metadata;
                params.onProgress?.(`Round ${round} / 主持步骤 ${moderatorStep}: 主持模型已返回，动作=${moderator.action}，模型=${moderatorResult.model}\n摘要: ${summarizeForProgress(moderator.summary)}`);
            } catch (err) {
                moderator = buildModeratorFailureDecision(messages, err);
                moderatorSteps.push(moderator);
                params.onProgress?.(`Round ${round}: 主持模型调用失败，已使用规则兜底提前终止\n错误: ${err instanceof Error ? err.message : String(err)}`);
                break;
            }

            if (moderator.action !== "tool") {
                moderatorSteps.push(moderator);
                break;
            }

            const requestedToolCalls = getModeratorToolCalls(moderator);
            if (toolCallsUsed >= maxToolCalls) {
                moderator.action = "terminate";
                moderator.summary = `${moderator.summary}\n\n工具调用上限已达到，强制收束。`;
                moderator.finalAnswer = moderator.finalAnswer || moderator.summary;
                transcript.terminationReason = "maxToolCalls";
                moderatorSteps.push(moderator);
                break;
            }

            if (requestedToolCalls.length === 0) {
                moderator.summary = `${moderator.summary}\n\n主持模型选择了 tool，但未给出有效 toolCall/toolCalls，跳过工具执行。`;
                moderatorSteps.push(moderator);
                break;
            }

            const remainingBudget = maxToolCalls - toolCallsUsed;
            const toolCallsForRound = requestedToolCalls.slice(0, Math.min(MAX_TOOL_CALLS_PER_ROUND, remainingBudget));
            const droppedCount = requestedToolCalls.length - toolCallsForRound.length;
            const stepToolResults: CouncilToolResult[] = [];
            for (const toolCall of toolCallsForRound) {
                params.onProgress?.(`Round ${round}: 正在执行工具 ${toolCall.tool}\n原因: ${toolCall.reason || "未提供"}`);
                const toolResult = await runCouncilTool(toolCall, effectiveParams.tools);
                toolCallsUsed++;
                stepToolResults.push(toolResult);
                roundToolResults.push(toolResult);
                params.onProgress?.(`Round ${round}: 工具 ${toolCall.tool} ${toolResult.ok ? "完成" : "失败"} (${toolCallsUsed}/${maxToolCalls})\n结果摘要: ${summarizeForProgress(toolResult.text)}`);
            }
            moderator.toolResults = stepToolResults;
            if (droppedCount > 0) {
                moderator.summary = `${moderator.summary}\n\n${droppedCount} 个工具请求因每轮上限或总工具调用上限未执行。`;
            }
            if (stepToolResults.length > 0 && moderator.afterToolInstruction) {
                afterToolInstruction = moderator.afterToolInstruction;
            }
            moderatorSteps.push(moderator);

            if (stepToolResults.length === 0) {
                break;
            }
            if (moderatorStep >= MAX_MODERATOR_STEPS_PER_ROUND) {
                moderator = {
                    action: "continue",
                    summary: `${moderator.summary}\n\n同一轮的主持工具步骤已达到上限，下一轮再综合这些结果。`,
                    rawText: moderator.rawText,
                };
                moderatorSteps.push(moderator);
                break;
            }
        }

        const roundEntry: CouncilTranscript["rounds"][number] = {
            round,
            messages,
            moderator,
            moderatorSteps: moderatorSteps.length > 1 ? moderatorSteps : undefined,
        };
        if (roundToolResults.length > 0) {
            roundEntry.toolResult = roundToolResults[0];
            roundEntry.toolResults = roundToolResults;
        }

        if (moderator.action === "ask") {
            askTarget = moderator.targetParticipantId;
            askInstruction = moderator.instruction;
        }

        transcript.rounds.push(roundEntry);
        transcript = savePartialTranscript(params, transcript);
        writeCheckpoint(params, transcript, {
            taskId: params.resumeState?.sourceTaskId,
            currentRound: round,
            lastCompletedRound: round,
            phase: "round_complete",
            roundComplete: true,
        });
        emitProgress(params, transcript, `Round ${round}: 已写入本轮讨论进度。`);

        if (moderator.action === "terminate") {
            transcript.terminationReason = transcript.terminationReason === "not-finished" ? "moderatorTerminate" : transcript.terminationReason;
            transcript.finalAnswer = moderator.finalAnswer || moderator.summary;
            break;
        }
        if (round === maxRounds) {
            transcript.terminationReason = "maxRounds";
            transcript.finalAnswer = moderator.finalAnswer || moderator.summary || "达到最大讨论轮次，已强制收束。";
            break;
        }
    }

    if (!transcript.finalAnswer) {
        transcript.finalAnswer = transcript.rounds.at(-1)?.moderator.summary || "讨论结束但没有生成最终结论。";
    }
    const saved = saveCouncilTranscript(transcript, params.transcriptPath, params.outputDir);
    return saved;
}

export async function resumeCouncil(params: CouncilRunParams): Promise<CouncilTranscript> {
    if (!params.resumeState) {
        throw new Error("resumeCouncil 需要 resumeState");
    }
    return runCouncil(params);
}
