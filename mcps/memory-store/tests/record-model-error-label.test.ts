import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationRound } from "../src/trajectory.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-error-label-"));
process.env.MEMORY_STORE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-error-label-data-"));

const fakeCodexJs = path.join(tempDir, "fake-codex.js");
const fakeCodexCmd = path.join(tempDir, "fake-codex.cmd");
const fakeClaudeJs = path.join(tempDir, "fake-claude.js");
const fakeClaudeCmd = path.join(tempDir, "fake-claude.cmd");

fs.writeFileSync(fakeCodexJs, `
if (process.argv.includes("--version")) {
  console.log("fake-codex 0.0.0");
  process.exit(0);
}

if (process.argv.includes("exec")) {
  const mode = process.env.FAKE_CODEX_MODE || "empty";
  if (mode === "sleep") {
    setInterval(() => {}, 1000);
    return;
  }
  process.exit(0);
}

process.exit(1);
`, "utf-8");

fs.writeFileSync(fakeCodexCmd, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.js" %*\r\n`, "utf-8");

fs.writeFileSync(fakeClaudeJs, `
if (process.argv.includes("--version")) {
  console.log("fake-claude 0.0.0");
  process.exit(0);
}

let stdin = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", chunk => { stdin += chunk; });
process.stdin.on("end", () => {
  const mode = process.env.FAKE_CLAUDE_MODE || "empty";
  if (mode === "sleep") {
    setInterval(() => {}, 1000);
    return;
  }
  process.exit(0);
});
`, "utf-8");

fs.writeFileSync(fakeClaudeCmd, `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.js" %*\r\n`, "utf-8");

process.env.MEMORY_STORE_GROK_PROXY_URL = "http://127.0.0.1:9";
process.env.MEMORY_STORE_GROK_API_KEY = "record-error-label-test";
process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS = "50";
process.env.MEMORY_STORE_CODEX_RECORD_TIMEOUT = "800";
process.env.MEMORY_STORE_CODEX_RECORD_RETRY_DELAY = "10";
process.env.MEMORY_STORE_CC_MODEL_TIMEOUT_MS = "800";
process.env.MEMORY_STORE_CC_MAX_TIMEOUT_MS = "800";

const { __setParentLsForTest, __disableLsForTest, __resetLsTestOverridesForTest } = await import("../src/ls-client.ts");
const { generateRecord } = await import("../src/record-generator.ts");

const rounds: ConversationRound[] = [
    {
        roundIndex: 1,
        startStep: 1,
        endStep: 2,
        userMessage: "请记录这个测试对话",
        mediaAttachments: [],
        aiResponses: [{ stepIndex: 2, response: "测试回复", thinking: "", toolCalls: [] }],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    },
];

function conversationId(label: string): string {
    return `record-model-error-label-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

try {
    __disableLsForTest();
    process.env.MEMORY_STORE_CODEX_COMMAND = path.join(tempDir, "missing-codex.cmd");
    process.env.MEMORY_STORE_CC_COMMAND = path.join(tempDir, "missing-claude.cmd");

    const grokResult = await generateRecord("general", conversationId("grok"), "test", rounds, 2, "grok");
    assert.equal(grokResult.success, false);
    assert.match(grokResult.error || "", /Grok Record 模型/u);
    assert.doesNotMatch(grokResult.error || "", /Flash/u);

    const antigravityResult = await generateRecord("general", conversationId("antigravity"), "test", rounds, 2, "antigravity");
    assert.equal(antigravityResult.success, false);
    assert.match(antigravityResult.error || "", /Antigravity Record 模型/u);
    assert.doesNotMatch(antigravityResult.error || "", /Flash/u);

    process.env.MEMORY_STORE_CODEX_COMMAND = fakeCodexCmd;
    process.env.FAKE_CODEX_MODE = "empty";
    const autoResult = await generateRecord("general", conversationId("auto"), "test", rounds, 2, "auto");
    assert.equal(autoResult.success, false);
    assert.match(autoResult.error || "", /自动链路全部失败/u);
    assert.match(autoResult.error || "", /Codex/u);
    assert.doesNotMatch(autoResult.error || "", /Flash/u);

    const codexResult = await generateRecord("general", conversationId("codex"), "test", rounds, 2, "codex");
    assert.equal(codexResult.success, false);
    assert.match(codexResult.error || "", /Codex Record 模型桥/u);
    assert.doesNotMatch(codexResult.error || "", /Flash/u);

    process.env.MEMORY_STORE_CC_COMMAND = fakeClaudeCmd;
    process.env.FAKE_CLAUDE_MODE = "empty";
    const claudeCodeResult = await generateRecord("general", conversationId("claude-code"), "test", rounds, 2, "claude-code");
    assert.equal(claudeCodeResult.success, false);
    assert.match(claudeCodeResult.error || "", /Claude Code CLI Record 模型桥/u);
    assert.doesNotMatch(claudeCodeResult.error || "", /Flash/u);

    process.env.MEMORY_STORE_AGY_COMMAND = path.join(tempDir, "missing-agy.cmd");
    const agyResult = await generateRecord("general", conversationId("agy"), "test", rounds, 2, "agy");
    assert.equal(agyResult.success, false);
    assert.match(agyResult.error || "", /agy CLI Record 模型/u);
    assert.doesNotMatch(agyResult.error || "", /Antigravity|Codex|Claude Code/u);
} finally {
    __resetLsTestOverridesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
}
