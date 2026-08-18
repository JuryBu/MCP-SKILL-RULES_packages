import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deepLocateCodexConversations, type CodexThreadInfo } from "../src/codex-client.ts";
import { formatDeepLocateResult } from "../src/tools/conversation.ts";

function writeJsonl(filePath: string, events: any[]): void {
    fs.writeFileSync(filePath, events.map(event => JSON.stringify(event)).join("\n") + "\n", "utf8");
}

const injectedRulesMarker = "STAGE60_DEEP_LOCATE_RULES_MARKER_should_not_hit";
const realUserRulesMarker = "STAGE60_DEEP_LOCATE_REAL_USER_RULES_should_hit";

function agentsRulesText(marker: string): string {
    return [
        "# AGENTS.md instructions for C:\\Users\\Stardust\\.gemini\\antigravity",
        "",
        "<INSTRUCTIONS>",
        "# Codex Global Rules",
        `${marker} ${"deep locate 不应命中规则正文 ".repeat(120)}`,
        "</INSTRUCTIONS>",
    ].join("\n");
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-deep-locate-"));
const rolloutPath = path.join(tempDir, "rollout.jsonl");
writeJsonl(rolloutPath, [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "用户提出普通问题" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "这里包含 deep locate unique marker 12345 用于精确命中" }] } },
    { type: "event_msg", payload: { type: "exec_command_end", command: "npm test", aggregated_output: "工具输出包含 upload success artifact marker" } },
]);

const thread: CodexThreadInfo = {
    id: "thread-deep-locate",
    rolloutPath,
    cwd: "C:\\workspace",
    title: "Deep Locate Test",
    source: "codex",
    model: "gpt-test",
    reasoningEffort: "high",
    updatedAtMs: Date.now(),
};

const exact = deepLocateCodexConversations("deep locate unique marker 12345", [thread], {
    mode: "exact",
    maxFiles: 1,
    maxBytes: 1024 * 1024,
    maxHits: 5,
    deadlineMs: 10_000,
});
assert.equal(exact.status, "found");
assert.equal(exact.hits.length, 1);
assert.equal(exact.hits[0].conversationId, thread.id);
assert.equal(exact.hits[0].role, "assistant");
assert.equal(exact.hits[0].roundIndex, 1);
assert.match(exact.hits[0].snippet, /deep locate unique marker/u);
assert.match(formatDeepLocateResult(exact, "deep locate unique marker 12345"), /Deep Locate Test/u);

const toolHit = deepLocateCodexConversations("upload success artifact marker", [thread], {
    mode: "exact",
    maxFiles: 1,
    maxBytes: 1024 * 1024,
    maxHits: 5,
    deadlineMs: 10_000,
});
assert.equal(toolHit.status, "found");
assert.equal(toolHit.hits[0].role, "tool_result");

const rulesRolloutPath = path.join(tempDir, "rules-rollout.jsonl");
writeJsonl(rulesRolloutPath, [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: agentsRulesText(injectedRulesMarker) }] } },
    { type: "event_msg", payload: { type: "user_message", message: "真实用户消息不含 deep locate 规则 marker" } },
]);
const rulesThread: CodexThreadInfo = {
    ...thread,
    id: "thread-rules-injection",
    rolloutPath: rulesRolloutPath,
    title: "Rules Injection Test",
};
const rulesHit = deepLocateCodexConversations(injectedRulesMarker, [rulesThread], {
    mode: "exact",
    maxFiles: 1,
    maxBytes: 1024 * 1024,
    maxHits: 5,
    deadlineMs: 10_000,
});
assert.equal(rulesHit.status, "no_hit_after_full_scan");
assert.equal(rulesHit.hits.length, 0);

const realRulesRolloutPath = path.join(tempDir, "real-rules-rollout.jsonl");
const realUserRules = agentsRulesText(realUserRulesMarker);
writeJsonl(realRulesRolloutPath, [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: realUserRules }] } },
    { type: "event_msg", payload: { type: "user_message", message: realUserRules } },
]);
const realRulesThread: CodexThreadInfo = {
    ...thread,
    id: "thread-real-rules-user-message",
    rolloutPath: realRulesRolloutPath,
    title: "Real User Rules Test",
};
const realRulesHit = deepLocateCodexConversations(realUserRulesMarker, [realRulesThread], {
    mode: "exact",
    maxFiles: 1,
    maxBytes: 1024 * 1024,
    maxHits: 5,
    deadlineMs: 10_000,
});
assert.equal(realRulesHit.status, "found");
assert.ok(realRulesHit.hits.length >= 1);

const fuzzy = deepLocateCodexConversations("unique marker 精确", [thread], {
    mode: "fuzzy",
    maxFiles: 1,
    maxBytes: 1024 * 1024,
    maxHits: 5,
    deadlineMs: 10_000,
});
assert.equal(fuzzy.status, "found");
assert.ok(fuzzy.hits.length >= 1);

const budget = deepLocateCodexConversations("deep locate unique marker 12345", [thread], {
    mode: "exact",
    maxFiles: 1,
    maxBytes: 64,
    maxHits: 5,
    deadlineMs: 10_000,
});
assert.equal(budget.status, "found");
assert.equal(budget.truncated, false);

const largeRolloutPath = path.join(tempDir, "large-rollout.jsonl");
const fillerEvents = Array.from({ length: 900 }, (_, index) => ({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ text: `filler line ${index} ${"x".repeat(120)}` }] },
}));
writeJsonl(largeRolloutPath, [
    ...fillerEvents,
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "late budget marker should not be reached" }] } },
]);
const largeThread: CodexThreadInfo = {
    ...thread,
    id: "thread-large-budget",
    rolloutPath: largeRolloutPath,
    title: "Large Budget Test",
};
const budgetExhausted = deepLocateCodexConversations("late budget marker should not be reached", [largeThread], {
    mode: "exact",
    maxFiles: 1,
    maxBytes: 64 * 1024,
    maxHits: 5,
    deadlineMs: 10_000,
});
assert.equal(budgetExhausted.status, "budget_exhausted");
assert.equal(budgetExhausted.truncated, true);

let cancelChecks = 0;
const cancelled = deepLocateCodexConversations("deep locate unique marker 12345", [thread], {
    mode: "exact",
    maxFiles: 1,
    maxBytes: 1024 * 1024,
    maxHits: 5,
    deadlineMs: 10_000,
    isCancelled: () => {
        cancelChecks += 1;
        return cancelChecks > 0;
    },
});
assert.equal(cancelled.status, "cancelled");
