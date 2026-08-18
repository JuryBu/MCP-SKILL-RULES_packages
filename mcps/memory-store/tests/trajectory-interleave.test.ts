import assert from "node:assert/strict";
import type { ConversationAttachment } from "../src/conversation-attachments.ts";
import {
    formatRound,
    formatRoundForMessageRoles,
    mergeConsecutiveHumanRounds,
    parseRounds,
    searchInRounds,
    type ConversationRound,
} from "../src/trajectory.ts";

function createRound(label: string): ConversationRound {
    return {
        roundIndex: 1,
        startStep: 69,
        endStep: 75,
        userMessage: `${label} 用户消息`,
        mediaAttachments: [],
        attachments: [],
        aiResponses: [
            { stepIndex: 70, response: `${label} AI 70`, thinking: "", toolCalls: [] },
            { stepIndex: 72, response: "", thinking: "", toolCalls: [] },
            { stepIndex: 74, response: `${label} AI 74`, thinking: "", toolCalls: [] },
        ],
        toolCalls: [
            { stepIndex: 71, name: "tool-a", argsSummary: "a", resultSummary: "result-a" },
            { stepIndex: 73, name: "tool-b", argsSummary: "b", resultSummary: "result-b" },
            { stepIndex: 75, name: "tool-a", argsSummary: "c", resultSummary: "result-c" },
        ],
        taskBoundaries: [],
        codeActions: [],
        fileViews: [],
        subagentSummaries: [],
    };
}

function assertAppearsInOrder(text: string, markers: string[], context: string): void {
    let previousIndex = -1;
    for (const marker of markers) {
        const currentIndex = text.indexOf(marker, previousIndex + 1);
        assert.ok(currentIndex >= 0, `${context}: missing ${marker}`);
        assert.ok(currentIndex > previousIndex, `${context}: ${marker} is out of step order`);
        previousIndex = currentIndex;
    }
}

function assertLegacyInterleave(round: ConversationRound, source: string): void {
    const formatted = formatRound(round, "normal");
    assertAppearsInOrder(formatted, [
        `### 🤖 AI (step 70)`,
        `#### 🔧 工具调用 (step 71)`,
        `- tool-a`,
        `#### 🔧 工具调用 (step 73)`,
        `- tool-b`,
        `### 🤖 AI (step 74)`,
        `#### 🔧 工具调用 (step 75)`,
        `- tool-a`,
    ], `${source} formatRound`);
    assert.doesNotMatch(formatted, /### 🤖 AI \(step 72\)/u, `${source}: empty AI step must be suppressed`);
}

const windsurfAttachment: ConversationAttachment = {
    kind: "image",
    source: "windsurf-data-url",
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,AA==",
    sizeBytes: 1,
};

const sourceRounds: Record<string, ConversationRound> = {
    Antigravity: {
        ...createRound("Antigravity"),
        mediaAttachments: ["file:///tmp/antigravity-input.png"],
    },
    "Claude Code": {
        ...createRound("Claude Code"),
        compactionSummaries: [{
            provider: "claude-code",
            kind: "compact_summary",
            text: "Claude Code compact summary",
            summaryChars: 27,
            summarySha256: "1234567890abcdef",
        }],
    },
    Codex: {
        ...createRound("Codex"),
        codeActions: [{
            stepIndex: 75,
            description: "edit",
            targetFile: "src/demo.ts",
            instruction: "update demo",
            diffs: [],
        }],
        fileViews: [{ stepIndex: 75, kind: "plan", title: "Plan_33", textSummary: "Codex plan view" }],
        subagentSummaries: [{ threadId: "child-1", nickname: "worker", role: "worker" }],
    },
    Windsurf: {
        ...createRound("Windsurf"),
        attachments: [windsurfAttachment],
    },
};

for (const [source, round] of Object.entries(sourceRounds)) {
    assertLegacyInterleave(round, source);
}

const briefRound = createRound("brief");
const legacyBriefExpected = [
    "## 轮次 1 (steps 69-75)",
    "### 👤 用户 (step 69)",
    "brief 用户消息",
    "",
    "### 🤖 AI (step 70)",
    "brief AI 70",
    "",
    "### 🤖 AI (step 74)",
    "brief AI 74",
    "",
    "🔧 工具: tool-a ×2, tool-b",
    "",
    "---",
].join("\n");
assert.equal(formatRound(briefRound, "brief"), legacyBriefExpected);
assert.doesNotMatch(formatRound(briefRound, "brief"), /### 🤖 AI \(step 72\)/u, "brief: empty AI step must be suppressed");

const noMessageRoles = formatRoundForMessageRoles(
    createRound("no-message-roles"),
    "normal",
    [],
    new Set(),
    "folded",
);
assert.equal(noMessageRoles, formatRound(createRound("no-message-roles"), "normal"));

const messageRoles = formatRoundForMessageRoles(
    createRound("message-roles"),
    "normal",
    [],
    new Set(["model", "tool"]),
    "folded",
);
assertAppearsInOrder(messageRoles, [
    "### 🤖 AI (step 70)",
    "#### 🔧 工具调用 (step 71)",
    "#### 🔧 工具调用 (step 73)",
    "### 🤖 AI (step 74)",
    "#### 🔧 工具调用 (step 75)",
], "formatRoundForMessageRoles");
assert.doesNotMatch(messageRoles, /### 🤖 AI \(step 72\)/u);

const toolOnlyRound: ConversationRound = {
    ...createRound("tool-only"),
    toolCalls: [
        { stepIndex: 75, name: "tool-late", argsSummary: "late", resultSummary: "late-result" },
        { stepIndex: 71, name: "tool-early-a", argsSummary: "early-a", resultSummary: "early-a-result" },
        { stepIndex: 73, name: "tool-middle", argsSummary: "middle", resultSummary: "middle-result" },
        { stepIndex: 71, name: "tool-early-b", argsSummary: "early-b", resultSummary: "early-b-result" },
    ],
};
const toolOnly = formatRoundForMessageRoles(toolOnlyRound, "normal", [], new Set(["tool"]), "folded");
assertAppearsInOrder(toolOnly, [
    "#### 🔧 工具调用 (step 71)",
    "- tool-early-a",
    "- tool-early-b",
    "#### 🔧 工具调用 (step 73)",
    "- tool-middle",
    "#### 🔧 工具调用 (step 75)",
    "- tool-late",
], "formatRoundForMessageRoles tool-only");

const invalidAiStepRound: ConversationRound = {
    ...createRound("invalid-ai-step"),
    aiResponses: [
        { stepIndex: Number.NaN, response: "NaN AI response", thinking: "", toolCalls: [] },
        { stepIndex: undefined as unknown as number, response: "undefined AI response", thinking: "", toolCalls: [] },
    ],
    toolCalls: [],
};
const invalidAiStepOutputs = [
    formatRound(invalidAiStepRound, "normal"),
    formatRound(invalidAiStepRound, "brief"),
    formatRoundForMessageRoles(invalidAiStepRound, "normal", [], new Set(["model"]), "folded"),
];
for (const output of invalidAiStepOutputs) {
    assert.doesNotMatch(output, /step (?:NaN|undefined|\?)/u, "invalid AI step must not leak into a title");
    assert.equal((output.match(/^### 🤖 AI$/gmu) || []).length, 2, "invalid AI steps must use the safe title");
}

const groupedRounds = parseRounds([
    { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "第一条人类消息" } },
    { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "第二条人类消息" } },
    { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: "模型开始工作" } },
    { type: "CORTEX_STEP_TYPE_MODEL_RESPONSE", modelResponse: { response: "模型正文输出" } },
    { type: "CORTEX_STEP_TYPE_MCP_TOOL", mcpTool: { toolCall: { name: "tool-a", argumentsJson: "{}" }, resultString: "ok" } },
    { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "工作中引导一" } },
    { type: "CORTEX_STEP_TYPE_USER_INPUT", userInput: { userResponse: "工作中引导二" } },
    { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: "继续处理" } },
]);
assert.equal(groupedRounds.length, 2, "连续人类消息应按消息组合并，模型活动后的引导应开启下一轮");
assert.deepEqual(groupedRounds[0].userMessages?.map((message) => message.text), ["第一条人类消息", "第二条人类消息"]);
assert.deepEqual(groupedRounds[0].legacyRoundIndices, [1, 2]);
assert.deepEqual(groupedRounds[1].userMessages?.map((message) => message.text), ["工作中引导一", "工作中引导二"]);
assert.deepEqual(groupedRounds[1].legacyRoundIndices, [3, 4]);
assert.deepEqual(groupedRounds[0].semanticEvents?.map((event) => event.semanticRole), ["user", "user", "model", "model", "tool"]);
assert.ok(groupedRounds[0].aiResponses.some(response => response.response === "模型正文输出"));

const legacyRounds = [
    { ...createRound("legacy-user-a"), roundIndex: 8, aiResponses: [], toolCalls: [] },
    { ...createRound("legacy-user-b"), roundIndex: 9, aiResponses: [{ stepIndex: 74, response: "模型活动", thinking: "", toolCalls: [] }], toolCalls: [] },
    { ...createRound("guidance-after-model"), roundIndex: 10, aiResponses: [], toolCalls: [] },
];
const normalizedLegacyRounds = mergeConsecutiveHumanRounds(legacyRounds);
assert.equal(normalizedLegacyRounds.length, 2, "旧解析的连续人类轮次应合并，模型活动后的引导不得回并");
assert.deepEqual(normalizedLegacyRounds[0].legacyRoundIndices, [8, 9]);
assert.deepEqual(normalizedLegacyRounds[1].legacyRoundIndices, [10]);
assert.equal(normalizedLegacyRounds[0].roundIndex, 1);
assert.equal(normalizedLegacyRounds[1].roundIndex, 2);
const shiftedLegacyRounds = mergeConsecutiveHumanRounds(legacyRounds, 94);
assert.deepEqual(shiftedLegacyRounds.map(round => round.roundIndex), [94, 95], "增量尾部合并后必须从替换轮次继续编号");

const cacheSearchRound = createRound("cache-search");
cacheSearchRound.toolCalls = [{
    stepIndex: 76,
    name: "tool-cache",
    argsSummary: "参数摘要",
    resultSummary: "结果摘要",
    argsFull: "CACHE_FULL_TOOL_ARGUMENT_MARKER",
    resultFull: "CACHE_FULL_TOOL_RESULT_MARKER",
}];
assert.equal(searchInRounds([cacheSearchRound], "CACHE_FULL_TOOL_ARGUMENT_MARKER").length, 1);
assert.equal(searchInRounds([cacheSearchRound], "CACHE_FULL_TOOL_RESULT_MARKER").length, 1);

const legacyStructuredSearchRound = createRound("legacy-structured-search");
legacyStructuredSearchRound.aiResponses = [{
    stepIndex: 77,
    response: { text: "LEGACY_STRUCTURED_RESPONSE_MARKER" } as unknown as string,
    thinking: ["LEGACY_STRUCTURED_THINKING_MARKER"] as unknown as string,
    toolCalls: [{
        name: "legacy-tool",
        args: { query: "LEGACY_STRUCTURED_ARGS_MARKER" } as unknown as string,
    }],
}];
assert.equal(searchInRounds([legacyStructuredSearchRound], "LEGACY_STRUCTURED_RESPONSE_MARKER").length, 1);
assert.equal(searchInRounds([legacyStructuredSearchRound], "LEGACY_STRUCTURED_THINKING_MARKER").length, 1);
assert.equal(searchInRounds([legacyStructuredSearchRound], "LEGACY_STRUCTURED_ARGS_MARKER").length, 1);

console.log("✅ trajectory-interleave 通过：四源旧路径按 step 交错，连续人类消息、工作中引导、旧序号映射与安全 AI 标题均已覆盖");
