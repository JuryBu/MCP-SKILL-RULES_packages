import { formatRound, type ConversationRound } from "./trajectory.js";
import { sliceUnicodeSafe } from "./unicode-text.js";

const RECORD_TOOL_ARGUMENT_CHARS = 1_200;
const RECORD_TOOL_RESULT_CHARS = 1_600;

export interface RecordRoundToolMaterial {
    version: 1;
    startStep: number;
    endStep: number;
    toolCalls: ConversationRound["toolCalls"];
}

export interface RecordToolMaterialMessage {
    role: "user" | "assistant";
    roundIndex?: number;
    stepIndex?: number;
    recordToolMaterial?: RecordRoundToolMaterial;
}

function boundedToolEvidence(text: string, limit: number): string {
    if (text.length <= limit) return text;
    const keptChars = Math.max(2, limit - 128);
    const headChars = Math.floor(keptChars * 0.6);
    const tailChars = keptChars - headChars;
    return `${sliceUnicodeSafe(text, 0, headChars)}\n[工具字段原文 ${text.length} 字符，中段省略约 ${text.length - keptChars} 字符]\n${sliceUnicodeSafe(text, text.length - tailChars, text.length)}`;
}

function boundedToolResult(text: string): string {
    try {
        const parsed = JSON.parse(text);
        const blocks = Array.isArray(parsed) ? parsed : parsed?.content;
        if (Array.isArray(blocks) && blocks.length > 1
            && blocks.every(block => block && (block.type === "text" || block.type === "input_text") && typeof block.text === "string")) {
            const shortChars = blocks.reduce((total, block) => total + (block.text.length <= 128 ? block.text.length : 0), 0);
            const longCount = blocks.filter(block => block.text.length > 128).length;
            const blockLimit = Math.max(64, Math.floor((RECORD_TOOL_RESULT_CHARS - shortChars - (blocks.length - 1) * 2) / Math.max(1, longCount)));
            return blocks.map(block => boundedToolEvidence(block.text, block.text.length <= 128 ? 128 : blockLimit)).join("\n\n");
        }
    } catch {}
    return boundedToolEvidence(text, RECORD_TOOL_RESULT_CHARS);
}

export function projectRecordToolMaterial(round: ConversationRound): RecordRoundToolMaterial {
    return {
        version: 1,
        startStep: round.startStep,
        endStep: round.endStep,
        toolCalls: round.toolCalls.map(tool => ({
            stepIndex: tool.stepIndex,
            name: tool.name,
            argsSummary: tool.argsSummary,
            resultSummary: tool.resultSummary,
            argsFull: boundedToolEvidence(tool.argsFull || tool.argsSummary, RECORD_TOOL_ARGUMENT_CHARS),
            ...(tool.resultFull || tool.resultSummary
                ? { resultFull: boundedToolResult(tool.resultFull || tool.resultSummary) }
                : {}),
        })),
    };
}

export function restoreRecordToolMaterials(
    rounds: ConversationRound[],
    messages: readonly RecordToolMaterialMessage[],
): void {
    const byRound = new Map<number, RecordToolMaterialMessage[]>();
    for (const message of messages) {
        if (message.roundIndex === undefined) continue;
        const entries = byRound.get(message.roundIndex) || [];
        entries.push(message);
        byRound.set(message.roundIndex, entries);
    }
    for (const round of rounds) {
        const entries = byRound.get(round.roundIndex) || [];
        const materials = entries.flatMap(message => message.recordToolMaterial ? [message.recordToolMaterial] : []);
        if (materials.length === 0) continue;
        const material = materials[0];
        if (materials.length !== 1 || material.version !== 1
            || !Number.isSafeInteger(material.startStep) || !Number.isSafeInteger(material.endStep)
            || material.startStep < 0 || material.endStep < material.startStep
            || !Array.isArray(material.toolCalls)
            || material.toolCalls.some(tool => !tool || typeof tool.name !== "string"
                || !Number.isSafeInteger(tool.stepIndex) || tool.stepIndex < material.startStep || tool.stepIndex > material.endStep
                || typeof tool.argsSummary !== "string" || typeof tool.resultSummary !== "string"
                || (tool.argsFull !== undefined && typeof tool.argsFull !== "string")
                || (tool.resultFull !== undefined && typeof tool.resultFull !== "string"))) {
            throw new Error(`Record 第 ${round.roundIndex} 轮工具材料结构或步骤范围无效`);
        }
        const users = entries.filter(message => message.role === "user");
        const responses = entries.filter(message => message.role === "assistant");
        if (users.length !== (round.userMessages?.length || 0) || responses.length !== round.aiResponses.length
            || entries.some(message => !Number.isSafeInteger(message.stepIndex)
                || message.stepIndex! < material.startStep || message.stepIndex! > material.endStep)) {
            throw new Error(`Record 第 ${round.roundIndex} 轮工具材料与消息步骤无法对应`);
        }
        round.startStep = material.startStep;
        round.endStep = material.endStep;
        round.toolCalls = material.toolCalls.map(tool => ({ ...tool }));
        round.userMessages?.forEach((message, index) => { message.stepIndex = users[index].stepIndex; });
        round.aiResponses.forEach((response, index) => { response.stepIndex = responses[index].stepIndex!; });
    }
}

export function formatRoundForRecord(round: ConversationRound): string {
    const text = formatRound(round, "normal");
    if (round.toolCalls.length === 0) return text;
    const tools = projectRecordToolMaterial(round).toolCalls;
    const wrappers = tools.filter(tool => tool.name === "exec" || tool.name === "functions.exec").length;
    const waits = tools.filter(tool => tool.name === "wait" || tool.name === "functions.wait").length;
    const directMcp = tools.filter(tool => tool.name.startsWith("mcp__") || tool.name.includes("/")).length;
    const lines = [text, "### 工具事件证据（来源：结构化工具调用与原回执）",
        `本轮工具事件数：${tools.length}；直接 MCP：${directMcp}；exec 脚本包装：${wrappers}；wait：${waits}；其它：${tools.length - directMcp - wrappers - waits}`,
        "exec 参数保留调用脚本，内部工具操作以脚本和对应回执共同核对；事件计数按外层调用记录。"];
    for (const tool of tools) {
        lines.push(`#### step ${tool.stepIndex}：${tool.name}`, "参数：", tool.argsFull || tool.argsSummary || "（无参数）",
            "回执：", tool.resultFull || tool.resultSummary || "本次冻结材料尚无该调用回执");
    }
    return lines.join("\n\n");
}
