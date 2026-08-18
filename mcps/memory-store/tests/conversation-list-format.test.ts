import assert from "node:assert/strict";
import {
    formatConversationListDisplayTitleForTest,
    formatConversationListTitleForTest,
} from "../src/tools/conversation.js";

const longPromptTitle = [
    "任务：独立复核 C:\\Users\\Stardust\\Desktop\\水桶理论聊天\\prove.md 中的证明，不要改文件。",
    "请以数学审稿人的方式找真实漏洞，尤其检查第(2)问上界证明。",
    "最终请输出：结论；按严重程度列漏洞；给出具体反例/计算支撑。",
].join("\n\n");

const formatted = formatConversationListTitleForTest(longPromptTitle, 80);

assert.ok(
    formatted.length <= 100,
    "formatted conversation list title should stay short enough for list output",
);
assert.match(formatted, /\[titleTruncated\]$/u);
assert.doesNotMatch(formatted, /\n/u, "formatted title should be single-line");

const shortTitle = "步步开发对话6";
assert.equal(formatConversationListTitleForTest(shortTitle, 80), shortTitle);

const subagentFormatted = formatConversationListDisplayTitleForTest(longPromptTitle, {
    dataChain: "codex",
    agentRole: "explorer",
}, 80);
assert.match(subagentFormatted, /^子代理对话\(explorer\)：/u);
assert.match(subagentFormatted, /\[titleTruncated\]$/u);
assert.doesNotMatch(subagentFormatted, /\n/u, "subagent title should stay single-line");

const claudeCodeFormatted = formatConversationListDisplayTitleForTest(longPromptTitle, {
    dataChain: "claude-code",
    agentRole: "explorer",
}, 80);
assert.match(claudeCodeFormatted, /^子代理对话\(explorer\)：/u);

const windsurfFormatted = formatConversationListDisplayTitleForTest("WSF 子代理", {
    dataChain: "windsurf",
    agentRole: "test-naming-check",
}, 80);
assert.equal(windsurfFormatted, "子代理对话(test-naming-check)：WSF 子代理");

const plainClaudeCodeFormatted = formatConversationListDisplayTitleForTest(longPromptTitle, {
    dataChain: "claude-code",
}, 80);
assert.doesNotMatch(plainClaudeCodeFormatted, /^子代理对话/u, "non-subagent conversations should not be marked as subagents");

console.log("conversation-list-format tests passed");
