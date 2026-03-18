import { saveTempFile } from "./temp-store.js";
// ===== Trajectory 解析 =====
/**
 * 将原始 trajectory steps 解析为对话轮次
 */
export function parseRounds(steps) {
    const rounds = [];
    let currentRound = null;
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
                    .filter((item) => item.text)
                    .map((item) => item.text)
                    .join(" ") || "";
            // 提取用户附件图片路径
            const mediaUris = (ui.media || [])
                .filter((m) => m.uri && m.mimeType?.startsWith("image/"))
                .map((m) => m.uri);
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
            };
        }
        else if (currentRound) {
            // 其他步骤归入当前轮次
            if (type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
                const pr = step.plannerResponse || {};
                currentRound.aiResponses.push({
                    stepIndex: i,
                    response: pr.response || "",
                    thinking: pr.thinking || "",
                    toolCalls: (pr.toolCalls || []).map((tc) => ({
                        name: tc.name || "",
                        args: truncate(tc.argumentsJson || "", 60),
                    })),
                });
            }
            else if (type === "CORTEX_STEP_TYPE_MCP_TOOL") {
                const mt = step.mcpTool || {};
                const tc = mt.toolCall || {};
                currentRound.toolCalls.push({
                    stepIndex: i,
                    name: tc.name || "unknown",
                    argsSummary: truncate(tc.argumentsJson || "", 60),
                    resultSummary: truncate(mt.resultString || "", 500),
                });
            }
            else if (type === "CORTEX_STEP_TYPE_TASK_BOUNDARY") {
                const tb = step.taskBoundary || {};
                currentRound.taskBoundaries.push({
                    stepIndex: i,
                    taskName: tb.taskName || "",
                    taskStatus: tb.taskStatus || "",
                });
            }
            else if (type === "CORTEX_STEP_TYPE_CODE_ACTION") {
                const ca = step.codeAction || {};
                const spec = ca.actionSpec || {};
                const rinfos = ca.replacementInfos || [];
                currentRound.codeActions.push({
                    stepIndex: i,
                    description: ca.description || "",
                    targetFile: spec.targetFile || "",
                    instruction: truncate(spec.instruction || "", 500),
                    diffs: rinfos.map((ri) => {
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
/**
 * 格式化单个轮次为 markdown
 */
export function formatRound(round, depth, extraTypes = []) {
    const lines = [];
    const stepsRange = `steps ${round.startStep}-${round.endStep}`;
    lines.push(`## 轮次 ${round.roundIndex} (${stepsRange})`);
    // 用户消息
    lines.push(`### 👤 用户 (step ${round.startStep})`);
    if (depth === "brief") {
        lines.push(truncate(round.userMessage, 100));
    }
    else {
        lines.push(round.userMessage);
    }
    // 用户附件图片
    if (round.mediaAttachments.length > 0) {
        for (const uri of round.mediaAttachments) {
            lines.push(`📎 图片: ${uri}`);
        }
    }
    lines.push("");
    // AI 回复
    for (const ai of round.aiResponses) {
        lines.push(`### 🤖 AI (step ${ai.stepIndex})`);
        if (depth === "brief") {
            lines.push(truncate(ai.response, 100));
        }
        else {
            lines.push(ai.response);
        }
        // thinking
        if (ai.thinking && (depth === "full" || extraTypes.includes("thinking"))) {
            lines.push("");
            lines.push(`<details><summary>💭 思考 (${ai.thinking.length}字)</summary>`);
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
        }
        else {
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
                    if (diff.targetContent || diff.replacementContent) {
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
    lines.push("---");
    return lines.join("\n");
}
/**
 * 生成对话概览统计
 */
export function formatOverview(cascadeId, rounds, totalSteps) {
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
export function saveConversationToTemp(cascadeId, rounds, totalSteps) {
    const lines = [];
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
/**
 * 在对话轮次中搜索关键词（分词模糊匹配）
 *
 * 按空格将 query 拆分为多个 token，任一 token 命中即算匹配，
 * 按命中 token 数降序排列。单个 token 时退化为子串搜索。
 */
export function searchInRounds(rounds, query, limit = 5) {
    // 分词：按空格拆分，去空，转小写
    const tokens = query.split(/\s+/).filter(t => t.length > 0).map(t => t.toLowerCase());
    if (tokens.length === 0)
        return [];
    const candidates = [];
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
function truncate(text, maxLen) {
    if (text.length <= maxLen)
        return text;
    return text.slice(0, maxLen) + "...";
}
function truncateLines(text, headLines, tailLines) {
    const lines = text.split("\n");
    if (lines.length <= headLines + tailLines)
        return text;
    return [
        ...lines.slice(0, headLines),
        `[... 省略 ${lines.length - headLines - tailLines} 行 ...]`,
        ...lines.slice(-tailLines),
    ].join("\n");
}
function extractContext(text, matchStart, matchLen, contextLen) {
    const start = Math.max(0, matchStart - contextLen);
    const end = Math.min(text.length, matchStart + matchLen + contextLen);
    let snippet = text.slice(start, end);
    if (start > 0)
        snippet = "..." + snippet;
    if (end < text.length)
        snippet = snippet + "...";
    return snippet;
}
//# sourceMappingURL=trajectory.js.map