/**
 * Trajectory 数据解析与提取
 *
 * 将 LS API 返回的原始 trajectory JSON 转换为结构化的对话轮次，
 * 按配置提取有价值的内容到 markdown 临时文件。
 */
export interface ConversationRound {
    roundIndex: number;
    startStep: number;
    endStep: number;
    userMessage: string;
    mediaAttachments: string[];
    aiResponses: AiResponse[];
    toolCalls: ToolCallInfo[];
    taskBoundaries: TaskInfo[];
    codeActions: CodeActionInfo[];
}
interface AiResponse {
    stepIndex: number;
    response: string;
    thinking: string;
    toolCalls: {
        name: string;
        args: string;
    }[];
}
interface ToolCallInfo {
    stepIndex: number;
    name: string;
    argsSummary: string;
    resultSummary: string;
}
interface TaskInfo {
    stepIndex: number;
    taskName: string;
    taskStatus: string;
}
interface CodeActionDiff {
    targetContent: string;
    replacementContent: string;
    startLine?: number;
    endLine?: number;
}
interface CodeActionInfo {
    stepIndex: number;
    description: string;
    targetFile: string;
    instruction: string;
    diffs: CodeActionDiff[];
}
export type ExtraType = "thinking" | "tool_results" | "code_actions" | "code_diffs" | "file_views";
export type Depth = "brief" | "normal" | "full";
/**
 * 将原始 trajectory steps 解析为对话轮次
 */
export declare function parseRounds(steps: any[]): ConversationRound[];
/**
 * 格式化单个轮次为 markdown
 */
export declare function formatRound(round: ConversationRound, depth: Depth, extraTypes?: ExtraType[]): string;
/**
 * 生成对话概览统计
 */
export declare function formatOverview(cascadeId: string, rounds: ConversationRound[], totalSteps: number): string;
/**
 * 将解析后的对话轮次保存到临时文件
 */
export declare function saveConversationToTemp(cascadeId: string, rounds: ConversationRound[], totalSteps: number): string;
interface SearchResult {
    roundIndex: number;
    matchType: "user" | "ai";
    matchText: string;
    contextStart: number;
    hitCount: number;
}
/**
 * 在对话轮次中搜索关键词（分词模糊匹配）
 *
 * 按空格将 query 拆分为多个 token，任一 token 命中即算匹配，
 * 按命中 token 数降序排列。单个 token 时退化为子串搜索。
 */
export declare function searchInRounds(rounds: ConversationRound[], query: string, limit?: number): SearchResult[];
export {};
//# sourceMappingURL=trajectory.d.ts.map