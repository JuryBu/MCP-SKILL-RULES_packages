import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    applyCodexSessionIndexTitleForTest,
    buildCodexRoundsForTest,
    buildCodexRoundsFromRolloutForTest,
    collectCodexEvidenceMessagesForTest,
    matchCodexContextProbeInEvents,
    matchCodexContextProbeInRollout,
    readCodexEvidenceRolloutForTest,
    readRolloutEvents,
    readRolloutEventsAsync,
} from "../src/codex-client.ts";
import { formatRoundsForRecord } from "../src/record-generator.ts";
import { canonicalSerialize } from "../src/source-evidence-contracts.ts";
import { formatRound, formatRoundForMessageRoles, parseRounds } from "../src/trajectory.ts";

const injectedRulesMarker = "STAGE60_RULES_BODY_MARKER_should_not_escape";
const realUserRulesMarker = "STAGE60_REAL_USER_RULES_MARKER_should_survive";

const overlaidThread = applyCodexSessionIndexTitleForTest({
    id: "019ddbe1-5242-7873-b86e-c653a957eabc",
    rolloutPath: "rollout.jsonl",
    cwd: "C:\\repo",
    title: "很长的首条用户消息，不应该作为最终侧栏标题",
    sqliteTitle: "很长的首条用户消息，不应该作为最终侧栏标题",
    titleSource: "sqlite",
    source: "codex",
    updatedAtMs: 1000,
}, [
    "{\"bad json\"",
    JSON.stringify({
        id: "019ddbe1-5242-7873-b86e-c653a957eabc",
        thread_name: "Memory_store 维护对话",
        updated_at: "2026-06-10T01:23:45.000Z",
    }),
]);
assert.equal(overlaidThread.title, "Memory_store 维护对话");
assert.equal(overlaidThread.appTitle, "Memory_store 维护对话");
assert.equal(overlaidThread.sqliteTitle, "很长的首条用户消息，不应该作为最终侧栏标题");
assert.equal(overlaidThread.titleSource, "session_index");

const fallbackThread = applyCodexSessionIndexTitleForTest({
    id: "019ea26c-fc01-7c23-90ba-f92edb53b42b",
    rolloutPath: "rollout.jsonl",
    cwd: "C:\\repo",
    title: "SQLite 标题",
    source: "codex",
    updatedAtMs: 1000,
}, [
    JSON.stringify({ id: "other", thread_name: "其它标题" }),
]);
assert.equal(fallbackThread.title, "SQLite 标题");
assert.equal(fallbackThread.titleSource, "sqlite");

function agentsRulesText(marker: string): string {
    return [
        "# AGENTS.md instructions for C:\\Users\\Stardust\\.gemini\\antigravity",
        "",
        "<INSTRUCTIONS>",
        "# Codex Global Rules",
        "这是一段很长的 RULES 正文，用于验证读取层会折叠系统注入。",
        `${marker} ${"不要输出这段规则正文 ".repeat(120)}`,
        "</INSTRUCTIONS><environment_context>",
        "  <cwd>C:\\Users\\Stardust\\.gemini\\antigravity\\mcp-memory-store</cwd>",
        "  <shell>powershell</shell>",
        "</environment_context>",
    ].join("\n");
}

function agentsRulesTextNewHeader(marker: string): string {
    return agentsRulesText(marker).replace(
        "# AGENTS.md instructions for C:\\Users\\Stardust\\.gemini\\antigravity",
        "# AGENTS.md instructions",
    );
}

function agentsRulesTextWithRecommendedPlugins(marker: string, rest = "", separator = ""): string {
    return [
        "<recommended_plugins>",
        "- Google Drive (google-drive@openai-curated-remote)",
        `</recommended_plugins>${separator}`,
        agentsRulesTextNewHeader(marker),
        rest,
    ].join("");
}

function codexUserMessage(text: string): any {
    return {
        type: "response_item",
        payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
        },
    };
}

function codexUserMessageParts(parts: string[]): any {
    return {
        type: "response_item",
        payload: {
            type: "message",
            role: "user",
            content: parts.map(text => ({ type: "input_text", text })),
        },
    };
}

const events = [
    {
        type: "response_item",
        payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "请检查 Codex parser" }],
        },
    },
    {
        type: "response_item",
        payload: {
            type: "reasoning",
            summary: [{ text: "内部摘要" }],
            encrypted_content: "secret-encrypted-blob",
        },
    },
    {
        type: "event_msg",
        payload: {
            type: "agent_reasoning",
            text: "明文 agent reasoning",
        },
    },
    {
        type: "response_item",
        payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "准备调用工具" }],
        },
    },
    {
        type: "response_item",
        payload: {
            type: "function_call",
            call_id: "call-shell",
            name: "shell_command",
            arguments: "{\"command\":\"echo ok\"}",
        },
    },
    {
        type: "event_msg",
        payload: {
            type: "exec_command_end",
            call_id: "call-shell",
            command: ["powershell.exe", "-Command", "echo ok"],
            aggregated_output: "ok",
            exit_code: 0,
        },
    },
    {
        type: "response_item",
        payload: {
            type: "function_call_output",
            call_id: "call-shell",
            output: "less structured output",
        },
    },
    {
        type: "response_item",
        payload: {
            type: "function_call",
            call_id: "call-mcp",
            name: "mcp__memory_store__memory_query",
            arguments: "{\"query\":\"parser\"}",
        },
    },
    {
        type: "event_msg",
        payload: {
            type: "mcp_tool_call_end",
            call_id: "call-mcp",
            invocation: {
                server: "memory-store",
                tool: "memory_query",
                arguments: { query: "parser" },
            },
            result: {
                Ok: {
                    content: [{ type: "text", text: "memory result" }],
                },
            },
        },
    },
    {
        type: "response_item",
        payload: {
            type: "custom_tool_call",
            call_id: "call-patch",
            name: "apply_patch",
            input: "*** Begin Patch\n*** Update File: demo.ts\n@@\n-old\n+new\n*** End Patch\n",
        },
    },
    {
        type: "event_msg",
        payload: {
            type: "patch_apply_end",
            call_id: "call-patch",
            stdout: "Success. Updated the following files:\nM demo.ts\n",
            changes: {
                "demo.ts": {
                    type: "update",
                    unified_diff: "@@ -1 +1 @@\n-old\n+new\n",
                },
            },
            status: "completed",
        },
    },
    {
        type: "response_item",
        payload: {
            type: "custom_tool_call_output",
            call_id: "call-patch",
            output: "{\"output\":\"Success\"}",
        },
    },
    {
        type: "event_msg",
        payload: {
            type: "item_completed",
            item: {
                type: "Plan",
                id: "plan-1",
                title: "Parser plan",
                text: "计划正文",
            },
        },
    },
    {
        type: "event_msg",
        payload: {
            type: "collab_agent_spawn_end",
            new_thread_id: "child-thread",
            new_agent_nickname: "Explorer",
            new_agent_role: "explorer",
            prompt: "查子线程",
        },
    },
    {
        type: "event_msg",
        payload: {
            type: "collab_waiting_end",
            agent_statuses: [{
                thread_id: "child-thread",
                agent_nickname: "Explorer",
                agent_role: "explorer",
                status: { completed: "子线程完成摘要" },
            }],
        },
    },
];

const unknownContentBlocks = buildCodexRoundsForTest([
    {
        type: "response_item",
        payload: {
            type: "message",
            role: "user",
            content: [{ type: "future_input_block", opaque: "must-not-disappear" }],
        },
    },
    {
        type: "response_item",
        payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "future_output_block", opaque: "must-not-disappear" }],
        },
    },
], "summary");
assert.equal(unknownContentBlocks.rounds[0].userMessage, "[Codex 未识别内容块：type=future_input_block]");
assert.equal(unknownContentBlocks.rounds[0].aiResponses[0].response, "[Codex 未识别内容块：type=future_output_block]");

const { rounds, childThreads } = buildCodexRoundsForTest(events, "summary");
const referenceMode = buildCodexRoundsForTest(events, "reference");
const expandMode = buildCodexRoundsForTest(events, "expand_children");
assert.equal(rounds.length, 1);

const round = rounds[0];
assert.equal(round.aiResponses.length, 1);
assert.equal(round.aiResponses[0].response, "准备调用工具");
assert.match(round.aiResponses[0].thinking, /内部摘要/u);
assert.match(round.aiResponses[0].thinking, /明文 agent reasoning/u);
assert.doesNotMatch(round.aiResponses[0].thinking, /secret-encrypted-blob/u);

assert.equal(round.toolCalls.length, 3);
assert.equal(round.toolCalls[0].name, "shell_command");
assert.match(round.toolCalls[0].resultSummary, /ok/u);
assert.equal(round.toolCalls[1].name, "mcp__memory_store__memory_query");
assert.match(round.toolCalls[1].resultSummary, /memory result/u);
assert.equal(round.toolCalls[2].name, "apply_patch");
assert.match(round.toolCalls[2].resultSummary, /Success/u);

assert.equal(round.codeActions.length, 1);
assert.equal(round.codeActions[0].targetFile, "demo.ts");
assert.match(round.codeActions[0].diffs[0].unifiedDiff || "", /-old/u);
assert.match(round.codeActions[0].diffs[0].unifiedDiff || "", /\+new/u);

assert.equal(round.fileViews?.length, 1);
assert.equal(round.fileViews?.[0].title, "Parser plan");

assert.equal(childThreads.length, 1);
assert.equal(childThreads[0].summary, "子线程完成摘要");
assert.equal(referenceMode.childThreads[0].summary, undefined);
assert.equal(expandMode.childThreads[0].summary, "子线程完成摘要");

const formatted = formatRound(round, "full", ["thinking", "tool_results", "code_actions", "code_diffs", "file_views"]);
assert.match(formatted, /<details><summary>💭 思考/u);
assert.match(formatted, /```diff\n@@ -1 \+1 @@\n-old\n\+new/u);
assert.match(formatted, /文件\/计划视图/u);

const contextHits = matchCodexContextProbeInEvents(events, "请检查 Codex parser");
assert.equal(contextHits.length, 1);
assert.equal(contextHits[0].role, "user");
assert.equal(contextHits[0].roundIndex, 1);

const whitespaceProbeHits = matchCodexContextProbeInEvents([
    {
        type: "response_item",
        payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "这一段上下文\n包含  多余空格 和换行" }],
        },
    },
], "这一段上下文 包含 多余空格 和换行");
assert.equal(whitespaceProbeHits.length, 1);

const fixedStringHits = matchCodexContextProbeInEvents([
    {
        type: "response_item",
        payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "正则字符 a+b(c)?[x] 必须按普通文本匹配" }],
        },
    },
], "a+b(c)?[x] 必须按普通文本");
assert.equal(fixedStringHits.length, 1);

const tooShortProbeHits = matchCodexContextProbeInEvents(events, "parser");
assert.equal(tooShortProbeHits.length, 0);

const eventMessageHits = matchCodexContextProbeInEvents([
    { type: "event_msg", payload: { type: "user_message", message: "event_msg 用户消息只在轻量事件里出现" } },
    { type: "event_msg", payload: { type: "agent_message", message: "event_msg 助手回复只在轻量事件里出现" } },
], "助手回复只在轻量事件里出现");
assert.equal(eventMessageHits.length, 1);
assert.equal(eventMessageHits[0].role, "assistant");

const toolOutputHits = matchCodexContextProbeInEvents([
    { type: "response_item", payload: { type: "function_call_output", output: "工具输出里的唯一片段 context-probe-output" } },
], "唯一片段 context-probe-output");
assert.equal(toolOutputHits.length, 1);
assert.equal(toolOutputHits[0].role, "tool_result");

const patchHits = matchCodexContextProbeInEvents([
    {
        type: "event_msg",
        payload: {
            type: "patch_apply_end",
            changes: { "demo.ts": { unified_diff: "@@ -1 +1 @@\n-old\n+contextProbePatchMarker" } },
        },
    },
], "contextProbePatchMarker");
assert.equal(patchHits.length, 1);
assert.equal(patchHits[0].role, "tool_result");

const injectedRulesText = agentsRulesText(injectedRulesMarker);
const compactedRulesText = agentsRulesText(`${injectedRulesMarker}_after_compaction`);
const foldedRulesData = buildCodexRoundsForTest([
    codexUserMessage(injectedRulesText),
    codexUserMessage("真正的开场用户消息 Stage60 hello"),
    { type: "event_msg", payload: { type: "user_message", message: "真正的开场用户消息 Stage60 hello" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "收到真实用户消息" }] } },
    { type: "event_msg", payload: { type: "context_compacted", message: "context compacted" } },
    codexUserMessage(compactedRulesText),
    codexUserMessage("压缩后的真实用户消息 Stage60 resume"),
    { type: "event_msg", payload: { type: "user_message", message: "压缩后的真实用户消息 Stage60 resume" } },
], "summary");
const foldedOutput = foldedRulesData.rounds.map(round => formatRound(round, "normal")).join("\n");
assert.doesNotMatch(foldedOutput, /# Codex Global Rules/u);
assert.doesNotMatch(foldedOutput, new RegExp(injectedRulesMarker, "u"));
assert.doesNotMatch(foldedOutput, /AGENTS\/RULES 注入已折叠/u);
assert.match(foldedOutput, /真正的开场用户消息 Stage60 hello/u);
assert.match(foldedOutput, /压缩后的真实用户消息 Stage60 resume/u);
const foldedSystemOutput = foldedRulesData.rounds
    .map(round => formatRoundForMessageRoles(round, "normal", [], new Set(["system"]), "folded"))
    .join("\n");
assert.match(foldedSystemOutput, /AGENTS\/RULES 注入已折叠/u);

const foldedProbeHits = matchCodexContextProbeInEvents([
    codexUserMessage(injectedRulesText),
], injectedRulesMarker);
assert.equal(foldedProbeHits.length, 0);

const realUserRulesText = agentsRulesText(realUserRulesMarker);
const realUserRulesEvents = [
    codexUserMessage(realUserRulesText),
    { type: "event_msg", payload: { type: "user_message", message: realUserRulesText } },
];
const realUserRulesData = buildCodexRoundsForTest(realUserRulesEvents, "summary");
assert.equal(realUserRulesData.rounds.length, 1);
assert.match(formatRound(realUserRulesData.rounds[0], "normal"), new RegExp(realUserRulesMarker, "u"));
assert.equal(matchCodexContextProbeInEvents(realUserRulesEvents, realUserRulesMarker).length, 1);

const recordFormattedRules = formatRoundsForRecord(foldedRulesData.rounds).map(item => item.text).join("\n");
assert.doesNotMatch(recordFormattedRules, /# Codex Global Rules/u);
assert.doesNotMatch(recordFormattedRules, new RegExp(injectedRulesMarker, "u"));
assert.doesNotMatch(recordFormattedRules, /AGENTS\/RULES 注入已折叠/u);

const rawNewHeaderRoleRound = {
    roundIndex: 1,
    startStep: 1,
    endStep: 1,
    userMessage: agentsRulesTextNewHeader("STAGE30A_NEW_HEADER_RAW_SYSTEM"),
    aiResponses: [],
    toolCalls: [],
    taskBoundaries: [],
    codeActions: [],
    fileViews: [],
    subagentSummaries: [],
};
assert.match(
    formatRoundForMessageRoles(rawNewHeaderRoleRound as any, "normal", [], new Set(["system"]), "folded"),
    /系统\/压缩内容/u,
);
assert.equal(
    formatRoundForMessageRoles(rawNewHeaderRoleRound as any, "normal", [], new Set(["user"]), "folded"),
    "",
);

const recommendedPluginsRulesMarker = "STAGE60_RECOMMENDED_PLUGINS_RULES_MARKER_should_not_escape";
const recommendedPluginsRestMarker = "STAGE60_RECOMMENDED_PLUGINS_REST_should_survive";
const recommendedPluginsRulesData = buildCodexRoundsForTest([
    codexUserMessageParts([
        "<recommended_plugins>\n- Google Drive (google-drive@openai-curated-remote)\n</recommended_plugins>",
        agentsRulesTextNewHeader(recommendedPluginsRulesMarker),
        `\n${recommendedPluginsRestMarker}`,
    ]),
], "summary");
const recommendedPluginsRulesOutput = recommendedPluginsRulesData.rounds.map(round => formatRound(round, "normal")).join("\n");
assert.doesNotMatch(recommendedPluginsRulesOutput, new RegExp(recommendedPluginsRulesMarker, "u"));
assert.doesNotMatch(recommendedPluginsRulesOutput, /google-drive@openai-curated-remote/u);
assert.doesNotMatch(recommendedPluginsRulesOutput, /AGENTS\/RULES 注入已折叠/u);
assert.match(recommendedPluginsRulesOutput, new RegExp(recommendedPluginsRestMarker, "u"));
assert.match(
    formatRoundForMessageRoles(recommendedPluginsRulesData.rounds[0], "normal", [], new Set(["system"]), "folded"),
    /AGENTS\/RULES 注入已折叠/u,
);

const recommendedPluginsWhitespaceOutput = formatRound(
    buildCodexRoundsForTest([
        codexUserMessage(agentsRulesTextWithRecommendedPlugins(recommendedPluginsRulesMarker, recommendedPluginsRestMarker, "\n\n")),
    ], "summary").rounds[0],
    "normal",
);
assert.doesNotMatch(recommendedPluginsWhitespaceOutput, new RegExp(recommendedPluginsRulesMarker, "u"));
assert.match(recommendedPluginsWhitespaceOutput, new RegExp(recommendedPluginsRestMarker, "u"));

const ordinaryHeaderInUserText = [
    "普通用户正文开头 STAGE60_ORDINARY_TEXT_should_survive",
    "# AGENTS.md instructions",
    "<INSTRUCTIONS>",
    "普通正文里偶然出现的 header 不应折叠",
    "</INSTRUCTIONS>",
].join("\n");
const ordinaryHeaderOutput = formatRound(
    buildCodexRoundsForTest([codexUserMessage(ordinaryHeaderInUserText)], "summary").rounds[0],
    "normal",
);
assert.match(ordinaryHeaderOutput, /STAGE60_ORDINARY_TEXT_should_survive/u);
assert.match(ordinaryHeaderOutput, /普通正文里偶然出现的 header 不应折叠/u);
assert.doesNotMatch(ordinaryHeaderOutput, /AGENTS\/RULES 注入已折叠/u);

const unclosedRecommendedPluginsRulesText = [
    "<recommended_plugins>",
    "- Google Drive (google-drive@openai-curated-remote)",
    "</recommended_plugins># AGENTS.md instructions",
    "<INSTRUCTIONS>",
    "STAGE60_UNCLOSED_INSTRUCTIONS_should_survive",
].join("\n");
const unclosedRecommendedPluginsOutput = formatRound(
    buildCodexRoundsForTest([codexUserMessage(unclosedRecommendedPluginsRulesText)], "summary").rounds[0],
    "normal",
);
assert.match(unclosedRecommendedPluginsOutput, /STAGE60_UNCLOSED_INSTRUCTIONS_should_survive/u);
assert.doesNotMatch(unclosedRecommendedPluginsOutput, /AGENTS\/RULES 注入已折叠/u);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-codex-jsonl-test-"));
try {
    const rolloutPath = path.join(tempDir, "large-rollout.jsonl");
    const largeText = "大文件流式读取 ".repeat(90_000);
    const jsonl = [
        JSON.stringify({
            type: "session_meta",
            payload: {
                id: "stream-demo",
                cwd: "C:\\demo",
                source: "test",
                base_instructions: { text: largeText },
            },
        }),
        JSON.stringify({
            type: "response_item",
            payload: {
                type: "reasoning",
                summary: [{ text: "流式 reasoning 摘要" }],
                encrypted_content: largeText,
            },
        }),
        JSON.stringify({
            type: "response_item",
            payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "流式读取用户消息" }],
            },
        }),
    ].join("\n");
    fs.writeFileSync(rolloutPath, jsonl, "utf-8");
    const streamedEvents = readRolloutEvents(rolloutPath);
    const asyncStreamedEvents = await readRolloutEventsAsync(rolloutPath);
    assert.equal(streamedEvents.length, 3);
    assert.deepEqual(asyncStreamedEvents, streamedEvents);
    assert.equal(streamedEvents[0].payload.base_instructions, undefined, "session_meta heavy instructions should be dropped");
    assert.equal(streamedEvents[1].payload.encrypted_content, undefined, "encrypted reasoning payload should be dropped");
    const streamedRounds = buildCodexRoundsForTest(streamedEvents, "summary");
    assert.ok(streamedRounds.rounds.some(round => round.userMessage === "流式读取用户消息"));
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}

const yieldProbeData = Buffer.from(Array.from({ length: 256 }, (_, index) => JSON.stringify({
    type: "response_item",
    payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `让步探针 ${index}` }],
    },
})).join("\n"), "utf8");
const fsPromises = fs.promises as { open: (...args: any[]) => Promise<any> };
const originalOpen = fsPromises.open;
let yieldProbeOffset = 0;
let yieldProbeImmediateRan = false;
let yieldProbeImmediateScheduled = false;
try {
    fsPromises.open = async () => ({
        read: async (buffer: Buffer, bufferOffset: number, length: number) => {
            if (yieldProbeOffset >= yieldProbeData.length) return { bytesRead: 0, buffer };
            const bytesRead = Math.min(length, yieldProbeData.length - yieldProbeOffset);
            yieldProbeData.copy(buffer, bufferOffset, yieldProbeOffset, yieldProbeOffset + bytesRead);
            yieldProbeOffset += bytesRead;
            if (!yieldProbeImmediateScheduled) {
                yieldProbeImmediateScheduled = true;
                setImmediate(() => { yieldProbeImmediateRan = true; });
            }
            return { bytesRead, buffer };
        },
        close: async () => {},
    });
    const yieldProbeEvents = await readRolloutEventsAsync("memory-store-codex-yield-probe.jsonl");
    assert.equal(yieldProbeEvents.length, 256);
    assert.equal(yieldProbeImmediateRan, true, "async JSONL parser should yield before finishing a large in-memory chunk");
} finally {
    fsPromises.open = originalOpen;
}

const streamingRoundsTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-codex-rounds-stream-"));
try {
    const rolloutPath = path.join(streamingRoundsTempDir, "rounds-stream.jsonl");
    const mirroredAgentsText = agentsRulesText("STREAM_AGENTS_MIRROR_ONCE");
    const unmirroredAgentsText = agentsRulesText("STREAM_AGENTS_FOLDED_WITH_REAL_USER");
    const windowAgentsText = agentsRulesText("STREAM_AGENTS_WINDOW_BOUND");
    const streamingRoundEvents = [
        codexUserMessage(mirroredAgentsText),
        { type: "event_msg", payload: { type: "user_message", message: mirroredAgentsText } },
        codexUserMessage("连续用户消息首段"),
        { type: "event_msg", payload: { type: "user_message", message: "连续用户消息最终定义" } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "模型已开始工作" }] } },
        { type: "event_msg", payload: { type: "user_message", message: "工作中引导消息" } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "第二轮模型输出" }] } },
        codexUserMessage(unmirroredAgentsText),
        codexUserMessage("AGENTS 折叠后的真实用户消息"),
        { type: "event_msg", payload: { type: "user_message", message: "AGENTS 折叠后的真实用户消息" } },
        codexUserMessage(windowAgentsText),
        ...Array.from({ length: 2048 }, (_, index) => ({
            type: "event_msg",
            payload: { type: "item_completed", item: { type: "stream_item", title: "bulk item " + index } },
        })),
    ];
    fs.writeFileSync(rolloutPath, streamingRoundEvents.map(event => JSON.stringify(event)).join("\n"), "utf8");
    const streamed = await buildCodexRoundsFromRolloutForTest(rolloutPath, "summary");
    const arrayBuilt = buildCodexRoundsForTest(streamingRoundEvents, "summary");
    assert.equal(streamed.totalSteps, streamingRoundEvents.length);
    assert.equal(streamed.peakBufferedEvents, 6, "AGENTS mirror lookahead must retain only candidate plus five future events");
    assert.deepEqual(streamed.rounds, arrayBuilt.rounds, "streaming and array builders must share semantics");
    assert.deepEqual(streamed.childThreads, arrayBuilt.childThreads);
    assert.equal(streamed.rounds.length, 3);
    assert.equal((streamed.rounds[0].userMessage.match(/STREAM_AGENTS_MIRROR_ONCE/gu) || []).length, 1);
    assert.match(streamed.rounds[0].userMessage, /连续用户消息首段/u);
    assert.match(streamed.rounds[0].userMessage, /连续用户消息最终定义/u);
    assert.equal(streamed.rounds[1].userMessage, "工作中引导消息");
    assert.doesNotMatch(streamed.rounds[2].userMessage, /AGENTS\/RULES 注入已折叠/u);
    assert.ok(streamed.rounds[2].semanticEvents?.some(event => event.semanticRole === "system" && event.text?.includes("AGENTS/RULES 注入已折叠")));
    assert.equal((streamed.rounds[2].userMessage.match(/AGENTS 折叠后的真实用户消息/gu) || []).length, 1);
} finally {
    fs.rmSync(streamingRoundsTempDir, { recursive: true, force: true });
}

const subagentNotificationText = `<subagent_notification>\n${JSON.stringify({
    agent_path: "019f0000-0000-7000-8000-000000000001",
    status: { completed: "子代理完成正文" },
})}\n</subagent_notification>`;
const delegationText = "<codex_delegation>\n<source_thread_id>019f0000-0000-7000-8000-000000000002</source_thread_id>\n<input>系统委派</input>\n</codex_delegation>";
const heartbeatText = "<heartbeat>\n<automation_id>stage70</automation_id>\n<current_time_iso>2026-08-12T07:36:51.198Z</current_time_iso>\n<instructions>自动推进，不得成为用户正文</instructions>\n</heartbeat>";
const ownerReplyText = "[NAPCAT_OWNER_REPLY]\nroute_key=owner-private\nmessage_seq=42\n主人通过 QQ 通知通道回复了这条 Codex 对话，请把下面内容作为用户补充信息处理：\n主人通过 QQ 的真实回复";
const isolatedLeadingSemanticData = buildCodexRoundsForTest([
    codexUserMessage(heartbeatText),
    codexUserMessage(subagentNotificationText),
], "summary");
assert.equal(isolatedLeadingSemanticData.rounds.length, 0, "首发系统或子代理事件不得创建无真人消息的公共轮次");

const isolatedAssistantData = buildCodexRoundsForTest([
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "首发模型消息" }] } },
], "summary");
assert.equal(isolatedAssistantData.rounds.length, 0, "首发 assistant 事件不得创建无真人消息的公共轮次");

const isolatedTailData = buildCodexRoundsForTest([
    { type: "response_item", payload: { type: "reasoning", summary: [{ text: "尾部孤立思考" }] } },
    { type: "response_item", payload: { type: "function_call", name: "tail_tool", arguments: "{}" } },
    { type: "event_msg", payload: { type: "collab_agent_spawn_end", new_thread_id: "tail-child" } },
], "summary");
assert.equal(isolatedTailData.rounds.length, 0, "尾部孤立事件不得创建无真人消息的公共轮次");

const leadingSystemWithHumanData = buildCodexRoundsForTest([
    codexUserMessage(heartbeatText),
    codexUserMessage("首个真人消息"),
], "summary");
assert.equal(leadingSystemWithHumanData.rounds.length, 1, "真人消息必须是唯一的公共轮次创建者");
assert.equal(leadingSystemWithHumanData.rounds[0].userMessage, "首个真人消息");
assert.ok(leadingSystemWithHumanData.rounds[0].semanticEvents?.some(event => event.semanticRole === "system" && event.kind === "automation_event" && event.automation));
assert.deepEqual(
    leadingSystemWithHumanData.rounds[0].semanticEvents?.map(event => event.semanticRole),
    ["system", "user"],
    "前导系统事件挂入首个真人轮时必须保留原始先后顺序",
);
assert.ok(
    (leadingSystemWithHumanData.rounds[0].semanticEvents?.[0]?.stepIndex || 0)
        < (leadingSystemWithHumanData.rounds[0].semanticEvents?.[1]?.stepIndex || 0),
    "前导系统事件必须保留早于真人消息的步骤编号",
);

const normalDelegationData = buildCodexRoundsForTest([
    codexUserMessage("真人请求委派"),
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "开始处理" }] } },
    codexUserMessage(delegationText),
    codexUserMessage(subagentNotificationText),
], "summary");
assert.equal(normalDelegationData.rounds.length, 2, "其它线程送来的真实任务正文必须形成用户轮，子代理通知不得形成用户轮");
assert.equal(normalDelegationData.rounds[0].aiResponses.length, 1);
assert.equal(normalDelegationData.rounds[1].subagentSummaries.length, 1);
assert.match(normalDelegationData.rounds[1].userMessage, /<codex_delegation>/u);

const ownerReplyData = buildCodexRoundsForTest([
    codexUserMessage(ownerReplyText),
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "已收到主人回复" }] } },
], "summary");
assert.equal(ownerReplyData.rounds.length, 1);
assert.equal(ownerReplyData.rounds[0].userMessage, "主人通过 QQ 的真实回复");
assert.ok(ownerReplyData.rounds[0].semanticEvents?.some(event => event.kind === "automation_event" && event.automation?.type === "napcat_owner_reply"));

const semanticBoundaryData = buildCodexRoundsForTest([
    codexUserMessage("完全相同的人类消息"),
    { type: "event_msg", payload: { type: "user_message", message: "完全相同的人类消息" } },
    codexUserMessage("完全相同的人类消息"),
    { type: "event_msg", payload: { type: "user_message", message: "完全相同的人类消息" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "模型第一段" }] } },
    { type: "event_msg", payload: { type: "agent_message", message: "模型第一段" } },
    codexUserMessage(subagentNotificationText),
    codexUserMessage(delegationText),
    { type: "event_msg", payload: { type: "user_message", message: delegationText } },
    { type: "event_msg", payload: { type: "agent_message", message: "模型继续工作" } },
    codexUserMessage("工作中真实引导"),
    { type: "event_msg", payload: { type: "user_message", message: "工作中真实引导" } },
    { type: "event_msg", payload: { type: "agent_message", message: "引导后的模型输出" } },
], "summary");
assert.equal(semanticBoundaryData.rounds.length, 3);
assert.equal(semanticBoundaryData.rounds[0].userMessages?.length, 2, "相同正文的两次真实人类消息不能被正文哈希吞掉");
assert.equal(semanticBoundaryData.rounds[0].aiResponses.length, 1, "response/event 模型镜像只保留一次");
assert.equal(semanticBoundaryData.rounds[1].aiResponses.length, 1, "跨线程真实任务后的模型继续消息必须保留");
assert.equal(semanticBoundaryData.rounds[0].subagentSummaries.length, 1);
assert.equal(semanticBoundaryData.rounds[0].subagentSummaries[0].threadId, "019f0000-0000-7000-8000-000000000001");
assert.match(semanticBoundaryData.rounds[1].userMessage, /<codex_delegation>/u);
assert.equal(semanticBoundaryData.rounds[2].userMessage, "工作中真实引导");
assert.ok(semanticBoundaryData.rounds[0].semanticEvents?.some(event => event.semanticRole === "subagent"));

const abortedTurnData = buildCodexRoundsForTest([
    codexUserMessage("第一次发送后立刻中止"),
    codexUserMessage("<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>"),
    { type: "event_msg", payload: { type: "turn_aborted" } },
    codexUserMessage("中止后重新发送"),
    { type: "event_msg", payload: { type: "user_message", message: "中止后重新发送" } },
], "summary");
assert.equal(abortedTurnData.rounds.length, 2, "中止的模型轮仍是边界，重新发送不能并入上一条真人消息");
assert.equal(abortedTurnData.rounds[0].userMessage, "第一次发送后立刻中止");
assert.equal(abortedTurnData.rounds[1].userMessage, "中止后重新发送");

const distinctPrefixMessages = buildCodexRoundsForTest([
    {
        type: "response_item",
        payload: {
            type: "message",
            role: "user",
            id: "submission-a",
            content: [{ type: "input_text", text: "共同前缀正文" }],
        },
    },
    {
        type: "event_msg",
        payload: {
            type: "user_message",
            id: "submission-b",
            message: "共同前缀正文，第二次提交新增内容",
            images: ["data:image/png;base64,aGk="],
        },
    },
], "summary");
assert.equal(distinctPrefixMessages.rounds[0].userMessages?.length, 2, "前缀相似但 ID 不同的两次真人提交不得误判为镜像");
assert.match(distinctPrefixMessages.rounds[0].userMessages?.[1]?.text || "", /第二次提交新增内容/u);
assert.equal(distinctPrefixMessages.rounds[0].userMessages?.[1]?.attachments?.length, 1);

const imageMirrorText = "带附件的同一次真人提交";
const imageMirrorData = buildCodexRoundsForTest([
    {
        type: "response_item",
        payload: {
            type: "message",
            role: "user",
            id: "msg-response-namespace",
            content: [
                { type: "input_text", text: imageMirrorText },
                { type: "input_image", image_url: "data:image/png;base64,aGk=" },
                { type: "input_text", text: '<image name=[Image #1] path="C:\\fixture\\image.png"></image>' },
            ],
        },
    },
    { type: "event_msg", payload: { type: "user_message", client_id: "event-client-namespace", message: imageMirrorText } },
], "summary");
assert.equal(imageMirrorData.rounds[0].userMessages?.length, 1, "仅多出宿主生成 image 标签的跨源记录仍是同一次提交");
assert.equal(imageMirrorData.rounds[0].userMessages?.[0]?.attachments?.length, 1);

const subagentImageData = buildCodexRoundsForTest([
    codexUserMessage("父线程请求"),
    {
        type: "response_item",
        payload: {
            type: "message",
            role: "user",
            content: [
                { type: "input_text", text: subagentNotificationText },
                { type: "input_image", image_url: "data:image/png;base64,aGk=" },
            ],
        },
    },
], "summary");
const subagentImageEvent = subagentImageData.rounds[0].semanticEvents?.find(event => event.semanticRole === "subagent");
assert.equal(subagentImageData.rounds[0].attachments?.length, 1, "子代理通知附件必须保留在所在轮次");
assert.equal(subagentImageEvent?.attachments?.length, 1, "子代理附件必须保留与通知的关系");
assert.equal(subagentImageEvent?.subagent?.attachments?.length, 1);
const subagentImageEvidence = collectCodexEvidenceMessagesForTest([
    codexUserMessage("父线程请求"),
    {
        type: "response_item",
        payload: {
            type: "message",
            role: "user",
            content: [
                { type: "input_text", text: subagentNotificationText },
                { type: "input_image", image_url: "data:image/png;base64,aGk=" },
            ],
        },
    },
]);
assert.equal(subagentImageEvidence.messages.find(message => message.role === "assistant")?.attachments?.length, 1, "Record 证据投影不得丢失子代理附件");

const roundYieldProbeData = Buffer.from(Array.from({ length: 256 }, (_, index) => JSON.stringify({
    type: "event_msg",
    payload: { type: "item_completed", item: { type: "stream_item", title: "yield item " + index } },
})).join("\n"), "utf8");
const originalRoundYieldOpen = fsPromises.open;
let roundYieldOffset = 0;
let roundYieldImmediateRan = false;
let roundYieldImmediateScheduled = false;
try {
    fsPromises.open = async () => ({
        read: async (buffer: Buffer, bufferOffset: number, length: number) => {
            if (roundYieldOffset >= roundYieldProbeData.length) return { bytesRead: 0, buffer };
            const bytesRead = Math.min(length, roundYieldProbeData.length - roundYieldOffset);
            roundYieldProbeData.copy(buffer, bufferOffset, roundYieldOffset, roundYieldOffset + bytesRead);
            roundYieldOffset += bytesRead;
            if (!roundYieldImmediateScheduled) {
                roundYieldImmediateScheduled = true;
                setImmediate(() => { roundYieldImmediateRan = true; });
            }
            return { bytesRead, buffer };
        },
        close: async () => {},
    });
    const yieldedRounds = await buildCodexRoundsFromRolloutForTest("memory-store-codex-round-yield-probe.jsonl", "summary");
    assert.equal(yieldedRounds.totalSteps, 256);
    assert.equal(roundYieldImmediateRan, true, "streaming round builder should yield during large in-memory chunks");
} finally {
    fsPromises.open = originalRoundYieldOpen;
}

const evidenceStreamTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-codex-evidence-stream-"));
try {
    const rolloutPath = path.join(evidenceStreamTempDir, "rollout-2026-08-03T20-00-00-019ddbe1-5242-7873-b86e-c653a957eabc.jsonl");
    const evidenceEvents = [
        { type: "session_meta", payload: { id: "evidence-stream-conversation" } },
        { type: "response_item", payload: { type: "message", role: "user", message_id: "mirror-1", content: [{ type: "input_text", text: "证据用户消息" }] } },
        { type: "event_msg", payload: { type: "user_message", message_id: "mirror-1", message: "证据用户消息" } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "证据助手消息" }] } },
        { type: "event_msg", payload: { type: "agent_message", message: "轻量助手镜像" } },
    ];
    fs.writeFileSync(rolloutPath, evidenceEvents.map(event => JSON.stringify(event)).join("\n"), "utf8");
    const arrayEvidence = collectCodexEvidenceMessagesForTest(evidenceEvents);
    const streamedEvidence = await readCodexEvidenceRolloutForTest(rolloutPath);
    const expectedHash = "sha256:" + createHash("sha256").update(
        canonicalSerialize({ messages: arrayEvidence.messages }),
        "utf8",
    ).digest("hex");
    assert.equal(streamedEvidence.conversationId, "evidence-stream-conversation");
    assert.deepEqual(streamedEvidence.messages, arrayEvidence.messages);
    assert.equal(streamedEvidence.roundEnd, arrayEvidence.roundEnd);
    assert.equal(streamedEvidence.contentHash, expectedHash);
    assert.deepEqual(streamedEvidence.errors, []);
} finally {
    fs.rmSync(evidenceStreamTempDir, { recursive: true, force: true });
}

const hugeUserText = "超大用户消息".repeat(60_000);
const hugeRoundData = buildCodexRoundsForTest([
    {
        type: "response_item",
        payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: hugeUserText }],
        },
    },
], "summary");
assert.equal(hugeRoundData.rounds.length, 1);
assert.equal(hugeRoundData.rounds[0].userMessage, hugeUserText);

const probeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-codex-probe-tail-test-"));
try {
    const rolloutPath = path.join(probeTempDir, "probe-tail-rollout.jsonl");
    const oldLines = Array.from({ length: 200 }, (_, index) => JSON.stringify({
        type: "response_item",
        payload: {
            type: "message",
            role: index % 2 === 0 ? "user" : "assistant",
            content: [{ type: "input_text", text: `旧消息 ${index} ${"x".repeat(2000)}` }],
        },
    }));
    const tailProbe = "尾部 contextProbe 独特点 12345";
    fs.writeFileSync(rolloutPath, [
        ...oldLines,
        JSON.stringify({
            type: "response_item",
            payload: {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: `最新消息 ${tailProbe}` }],
            },
        }),
    ].join("\n"), "utf-8");
    const tailHits = matchCodexContextProbeInRollout(rolloutPath, tailProbe, { maxBytes: 16 * 1024 });
    assert.equal(tailHits.length, 1);
    assert.equal(tailHits[0].role, "user");
} finally {
    fs.rmSync(probeTempDir, { recursive: true, force: true });
}

const antigravityRounds = parseRounds([
    {
        type: "CORTEX_STEP_TYPE_USER_INPUT",
        userInput: {
            userResponse: "AG 用户",
            media: [{ uri: "C:\\Users\\Stardust\\.gemini\\antigravity\\brain\\demo\\media__1.png", mimeType: "image/png" }],
        },
    },
    { type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE", plannerResponse: { response: "AG 回复", thinking: "AG thinking" } },
    {
        type: "CORTEX_STEP_TYPE_CODE_ACTION",
        codeAction: {
            description: "AG edit",
            actionSpec: { targetFile: "ag.ts", instruction: "edit ag" },
            replacementInfos: [{
                originalChunk: {
                    targetContent: "old",
                    replacementContent: "new",
                    startLine: 1,
                    endLine: 1,
                },
            }],
        },
    },
]);

assert.equal(antigravityRounds.length, 1);
assert.equal(antigravityRounds[0].aiResponses[0].thinking, "AG thinking");
assert.equal(antigravityRounds[0].codeActions[0].diffs[0].targetContent, "old");
assert.equal(antigravityRounds[0].mediaAttachments.length, 1);
assert.match(formatRound(antigravityRounds[0], "normal"), /media__1\.png/u);
