import assert from "node:assert/strict";
import fs from "node:fs";
import { materializeRoundAttachments, type ConversationAttachment } from "../src/conversation-attachments.ts";
import {
    formatRound,
    formatRoundForMessageRoles,
    parseResponseAnnotations,
    searchInRounds,
    type ConversationRound,
    type FormatRoundForMessageRolesBudgetResult,
} from "../src/trajectory.ts";

function imageAttachment(seed: string): ConversationAttachment {
    return {
        kind: "image",
        source: "codex-data-url",
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${Buffer.from(seed).toString("base64")}`,
        sizeBytes: seed.length,
    };
}

const round: ConversationRound = {
    roundIndex: 1,
    startStep: 10,
    endStep: 14,
    userMessage: "用户消息",
    mediaAttachments: ["file:///tmp/media.png"],
    attachments: [
        { kind: "image", source: "files-mentioned", originalPath: "C:\\tmp\\user.png", exists: true },
    ],
    aiResponses: [
        { stepIndex: 11, response: "第一段 AI 回复", thinking: "", toolCalls: [] },
        { stepIndex: 13, response: "第二段 AI 回复", thinking: "这里是思考", toolCalls: [] },
    ],
    toolCalls: [
        { stepIndex: 12, name: "web_search", argsSummary: "{\"q\":\"stage5\"}", resultSummary: "命中结果" },
    ],
    taskBoundaries: [
        { stepIndex: 14, taskName: "Stage 5", taskStatus: "running" },
    ],
    codeActions: [
        { stepIndex: 14, description: "update", targetFile: "src/demo.ts", instruction: "", diffs: [] },
    ],
    fileViews: [
        { stepIndex: 14, kind: "plan", title: "Plan_32", textSummary: "摘要" },
    ],
    subagentSummaries: [
        { threadId: "child-1", nickname: "worker-a", role: "worker" },
    ],
};

const expected = [
    "## 轮次 1 (steps 10-14)",
    "### 👤 用户 (step 10)",
    "用户消息",
    "📎 图片: C:\\tmp\\user.png",
    "📎 图片: file:///tmp/media.png",
    "",
    "### 🤖 AI (step 11)",
    "第一段 AI 回复",
    "",
    "#### 🔧 工具调用 (step 12)",
    "- web_search({\"q\":\"stage5\"}) → 命中结果",
    "",
    "### 🤖 AI (step 13)",
    "第二段 AI 回复",
    "",
    "<details><summary>💭 思考 (5字)</summary>",
    "",
    "这里是思考",
    "</details>",
    "",
    "📋 任务: Stage 5 → running",
    "",
    "#### ✏️ 代码编辑",
    "- **src/demo.ts**: update",
    "",
    "#### 📄 文件/计划视图",
    "- plan / Plan_32: 摘要",
].join("\n");

const actual = formatRoundForMessageRoles(
    round,
    "full",
    ["thinking", "tool_results", "code_actions", "file_views"],
    new Set(["user", "model", "tool"]),
    "folded",
);
assert.equal(actual, expected);

const legacyFieldOutput = formatRound(round, "normal", ["tool_results", "code_actions", "file_views"]);
assert.match(legacyFieldOutput, /用户消息/u);
assert.match(legacyFieldOutput, /Subagent-worker-a \(child-1\)/u);

const annotationRound: ConversationRound = {
    ...round,
    roundIndex: 8,
    userMessage: "<response-annotations>{\"annotations\":[{\"selected_text\":\"旧文本\",\"comment\":\"请补充证据\"}]}</response-annotations>\n## My request\n继续处理",
    userMessages: [{
        stepIndex: 10,
        text: "<response-annotations>{\"annotations\":[{\"selected_text\":\"旧文本\",\"comment\":\"请补充证据\"}]}</response-annotations>\n## My request\n继续处理",
    }],
};
const annotationOutput = formatRoundForMessageRoles(annotationRound, "normal", [], new Set(["user"]), "folded");
assert.match(annotationOutput, /被批注文本: 旧文本/u);
assert.match(annotationOutput, /用户评论: 请补充证据/u);
assert.match(annotationOutput, /## My request/u);
assert.doesNotMatch(annotationOutput, /selected_text/u);

const annotationMatches = searchInRounds([annotationRound], "请补充证据", 5);
assert.equal(annotationMatches.length, 1);
assert.equal(annotationMatches[0]?.matchType, "annotation");
assert.equal(annotationMatches[0]?.annotationIndex, 1);
assert.equal(annotationMatches[0]?.annotationField, "comment");
assert.equal(annotationMatches[0]?.annotationSelectedText, "旧文本");
assert.equal(annotationMatches[0]?.annotationComment, "请补充证据");
assert.doesNotMatch(annotationMatches[0]?.matchText || "", /selected_text/u);

const nativeCodexAnnotation = parseResponseAnnotations(
    '<response-annotations>[{"text":"原生选中文本","annotation":"原生用户评论"}]</response-annotations>\n继续',
);
assert.equal(nativeCodexAnnotation.annotations[0]?.selectedText, "原生选中文本");
assert.equal(nativeCodexAnnotation.annotations[0]?.comment, "原生用户评论");

const codexInjectedPreamble = [
    "# Response annotations:",
    "Each item contains text selected from an earlier Codex response and may include a user comment. Treat items as Annotation 1, Annotation 2, and so on in array order. Use every selection as context and address every comment.",
    '<response-annotations>[{"text":"仅选中文本"}]</response-annotations>',
    "",
    "## My request for Codex:",
    "这才是真实消息正文",
].join("\n");
const emptyCommentRound: ConversationRound = {
    ...round,
    roundIndex: 9,
    userMessage: codexInjectedPreamble,
    userMessages: [{ stepIndex: 15, text: codexInjectedPreamble }],
};
const emptyCommentOutput = formatRoundForMessageRoles(emptyCommentRound, "normal", [], new Set(["user"]), "folded");
assert.doesNotMatch(emptyCommentOutput, /# Response annotations:/u);
assert.doesNotMatch(emptyCommentOutput, /Each item contains text selected/u);
assert.match(emptyCommentOutput, /## My request for Codex:\n这才是真实消息正文/u);
assert.match(emptyCommentOutput, /被批注文本: 仅选中文本/u);
assert.match(emptyCommentOutput, /用户评论: （未填写）/u);

const malformedAnnotation = "<response-annotations>{bad json}</response-annotations>\n继续处理";
const malformedParsed = parseResponseAnnotations(malformedAnnotation);
assert.equal(malformedParsed.annotations.length, 0);
assert.match(malformedParsed.text, /\{bad json\}/u);
assert.match(malformedParsed.warnings.join("\n"), /格式损坏，已保留原文/u);

const diffRound: ConversationRound = {
    ...round,
    roundIndex: 9,
    codeActions: [{
        stepIndex: 14,
        description: "patch",
        targetFile: "src/demo.ts",
        instruction: "",
        diffs: [{ targetContent: "before", replacementContent: "after", startLine: 3, endLine: 3 }],
    }],
};
const diffOnlyOutput = formatRoundForMessageRoles(diffRound, "normal", ["code_diffs"], new Set(["tool"]), "folded");
assert.match(diffOnlyOutput, /#### ✏️ 代码编辑/u);
assert.match(diffOnlyOutput, /--- src\/demo\.ts \(L3-L3\)/u);
assert.match(diffOnlyOutput, /-before/u);
assert.match(diffOnlyOutput, /\+after/u);

const subagentRound: ConversationRound = {
    ...round,
    roundIndex: 8,
    subagentSummaries: [],
    semanticEvents: [{
        stepIndex: 14,
        rawRole: "collab_agent_spawn_end",
        semanticRole: "subagent",
        subagent: { threadId: "abcdef123456", nickname: "worker-b", status: "已完成" },
    }],
};
const subagentOutput = formatRoundForMessageRoles(subagentRound, "normal", [], new Set(["subagent"]), "folded");
assert.match(subagentOutput, /Subagent-worker-b \(abcdef12…\): 已完成/u);
assert.doesNotMatch(subagentOutput, /轮次 8\.a/u);

const withBudget = formatRoundForMessageRoles(
    round,
    "full",
    ["thinking", "tool_results", "code_actions", "file_views"],
    new Set(["user", "model", "tool"]),
    "folded",
    { deadlineAt: Date.now() + 60_000 },
) as FormatRoundForMessageRolesBudgetResult;
assert.equal(withBudget.budgetExceeded, false);
assert.equal(withBudget.text, expected);

let budgetCallbackCount = 0;
let checks = 0;
const partial = formatRoundForMessageRoles(
    round,
    "full",
    ["thinking", "tool_results", "code_actions", "file_views"],
    new Set(["user", "model", "tool"]),
    "folded",
    {
        shouldAbort: () => (++checks) >= 8,
        onBudgetExceeded: () => { budgetCallbackCount += 1; },
    },
) as FormatRoundForMessageRolesBudgetResult;
assert.equal(partial.budgetExceeded, true);
assert.equal(budgetCallbackCount, 1);
assert.match(partial.text, /达到时间预算/u);
assert.doesNotMatch(partial.text, /子代理线程/u);

const materializedDefault = await materializeRoundAttachments([
    {
        ...round,
        roundIndex: 2,
        attachments: [imageAttachment("shared-default")],
    },
], "test-conversation-shared-format-regression");
assert.equal(materializedDefault.truncated, 0);
assert.ok(materializedDefault.rounds[0].attachments?.[0].tempPath);
assert.ok(fs.existsSync(materializedDefault.rounds[0].attachments?.[0].tempPath || ""));
assert.equal(materializedDefault.budgetExceeded, false);

console.log("✅ conversation-shared-format-regression 通过：默认无预算行为保持不变，可选预算只在显式启用时生效");
