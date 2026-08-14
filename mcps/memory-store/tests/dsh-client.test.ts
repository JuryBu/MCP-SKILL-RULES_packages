import assert from "node:assert/strict";

import { normalizeDshSessionEvents } from "../src/dsh-client.js";
import { callModelResponse } from "../src/model-bridge.js";

type Event = {
    type: string;
    data: Record<string, unknown>;
};

const message = (role: string, source: Record<string, unknown>, content: unknown[]): Record<string, unknown> => ({
    role,
    source,
    content,
});

const humanAndSynthetic = normalizeDshSessionEvents([
    { type: "user/message", data: message("user", { kind: "user" }, [{ type: "text", text: "真人问题" }]) },
    { type: "user/message", data: { message: message("user", { kind: "plugin", plugin: "scheduler" }, [{ type: "text", text: "plugin context" }]) } },
    { type: "user/message", data: { message: message("user", { kind: "synthetic" }, [{ type: "text", text: "synthetic context" }]) } },
    { type: "user/message", data: { message: message("user", { kind: "subagent" }, [{ type: "text", text: "subagent context" }]) } },
    { type: "user/message", data: { message: message("user", { kind: "automation" }, [{ type: "text", text: "automation context" }]) } },
    { type: "user/message", data: { message: message("user", { kind: "user" }, [{ type: "text", text: "真人补充" }]) } },
] as any).rounds;

assert.equal(humanAndSynthetic.length, 1);
assert.deepEqual(humanAndSynthetic[0].userMessages?.map(item => item.text), ["真人问题", "真人补充"]);
assert.equal(humanAndSynthetic[0].userMessages?.some(item => item.text.includes("plugin context")), false);
assert.equal(humanAndSynthetic[0].semanticEvents?.some(item => item.kind === "plugin_message" && item.semanticRole === "system"), true);
assert.equal(humanAndSynthetic[0].semanticEvents?.filter(item => item.semanticRole === "system" && item.kind.endsWith("_message")).length, 4);

const inboxMessage = { ...message("user", { kind: "user" }, [{ type: "text", text: "inbox 真人消息" }]), id: "human-1" };
const inboxAndCanonical = normalizeDshSessionEvents([
    { type: "agent/inbox/spliced", data: { target: "next-turn", inserted: [inboxMessage] } },
    { type: "user/message", data: inboxMessage },
] as any).rounds[0];
assert.deepEqual(inboxAndCanonical.userMessages?.map(item => item.text), ["inbox 真人消息"]);

const inboxOnly = normalizeDshSessionEvents([
    { type: "agent/inbox/spliced", data: { target: "next-turn", inserted: [{ ...message("user", { kind: "user" }, [{ type: "text", text: "尚未落 canonical" }]), id: "pending-1" }] } },
] as any).rounds[0];
assert.deepEqual(inboxOnly.userMessages?.map(item => item.text), ["尚未落 canonical"]);

const assistantAndTool = normalizeDshSessionEvents([
    { type: "turn/start", data: { turn: 1 } },
    { type: "user/message", data: { message: message("user", { kind: "user" }, [{ type: "text", text: "运行工具" }]) } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "先检查" } } },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 1, text: "最终文本不能重复" } } },
    { type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "tool-call-delta", index: 2, id: "call-1", name: "lookup", argumentsDelta: "{\"q\":\"x\"}" } } },
    { type: "tool/call", data: { turn: 1, step: 1, callId: "call-1", name: "lookup", arguments: "{\"q\":\"x\"}" } },
    { type: "assistant/message", data: { turn: 1, step: 1, message: message("assistant", { kind: "model" }, [{ type: "text", text: "最终文本" }]) } },
    { type: "tool/result", data: { turn: 1, step: 1, message: message("user", { kind: "tool", callId: "call-1" }, [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "查询结果" }] }]) } },
    { type: "step/end", data: { turn: 1, step: 1 } },
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
] as any).rounds[0];

assert.equal(assistantAndTool.aiResponses[0].response, "最终文本");
assert.equal(assistantAndTool.aiResponses[0].thinking, "先检查");
assert.equal(assistantAndTool.aiResponses[0].toolCalls[0].name, "lookup");
assert.equal(assistantAndTool.toolCalls[0].resultSummary, "查询结果");
assert.equal(assistantAndTool.taskBoundaries.length, 4);

const withHeader = normalizeDshSessionEvents([
    { type: "user/message", data: { message: message("user", { kind: "user" }, [{ type: "text", text: "子代理不冒充人类" }]) } },
] as any, { id: "child-1", parentSession: "parent-1", origin: "subagent" }).rounds[0];

assert.equal(withHeader.userMessages?.length, 1);
assert.equal(withHeader.semanticEvents?.some(item => item.kind === "session_header" && item.text?.includes("parentSession=parent-1") && item.text?.includes("origin=subagent")), true);

const attachmentsAndUnknown = normalizeDshSessionEvents([
    { type: "user/message", data: { message: message("user", { kind: "user" }, [
        { type: "text", text: "看图" },
        { type: "image", attachment: { id: "image-1" } },
        { type: "future-block", value: "kept" },
    ]) } },
] as any);

assert.equal(attachmentsAndUnknown.rounds[0].userMessages?.[0].text.includes("image-1"), true);
assert.equal(attachmentsAndUnknown.diagnostics.some(item => item.code === "unknown_content_block" && item.detail.includes("future-block")), true);

const rejectedModelChain = await callModelResponse("unused", "unused", "dsh");
assert.equal(rejectedModelChain.text, null);
assert.match(rejectedModelChain.error || "", /DSH 只支持 dataChain/u);

console.log("dsh-client tests passed");
