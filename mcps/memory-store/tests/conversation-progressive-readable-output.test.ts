import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationRound } from "../src/trajectory.js";
import type { ProgressiveReadResult } from "../src/conversation-progressive-types.js";
import type { ProgressiveRequest } from "../src/conversation-progressive-task-types.js";
import { formatProgressiveReadRows } from "../src/tools/conversation-progressive-tool.js";
import { progressiveReadyReadNext } from "../src/conversation-progressive-task.js";

function fixture(): ProgressiveReadResult {
    const round: ConversationRound = {
        roundIndex: 1, startStep: 1, endStep: 6, userMessage: "主人正文", mediaAttachments: [],
        userMessages: [{ stepIndex: 1, text: "主人正文", annotations: [{ selectedText: "引用", comment: "批注" }] }],
        aiResponses: [{ stepIndex: 2, response: "长".repeat(180), thinking: "saved-thinking", toolCalls: [] }],
        toolCalls: [{ stepIndex: 3, name: "read", argsFull: "private-args", argsSummary: "args", resultFull: "private-result", resultSummary: "result" },
            { stepIndex: 4, name: "read", argsSummary: "args", resultSummary: "result" }],
        taskBoundaries: [], codeActions: [], fileViews: [], subagentSummaries: [],
    };
    return {
        status: { source: { host: "codex", conversationId: "fixture", revision: "revision",
            snapshot: { projection: { format: "progressive-projection/v3", depth: "full", messageRoles: ["user", "assistant", "tool", "subagent"] } } }, complete: false } as ProgressiveReadResult["status"],
        rows: [{ ref: "fixed-ref", blockId: "block", kind: "relative", round, messages: [] }],
        rounds: [round], messages: [
            { id: "user", round: 1, role: "user", text: "主人正文", position: { ordinal: 1 }, annotations: [{ selectedText: "引用", comment: "批注" }] },
            { id: "assistant", round: 1, role: "assistant", text: "长".repeat(180), position: { ordinal: 2 } },
            { id: "tool", round: 1, role: "tool", text: "read\nprivate-result", position: { ordinal: 3 } },
        ], requestedRangeComplete: true,
    };
}

test("brief truncates text without changing canonical data and keeps tool names", () => {
    const input = fixture();
    const output = formatProgressiveReadRows(input, { action: "read_ready", depth: "brief" });
    assert.equal(output.messages[1]!.text, "长".repeat(100) + "…");
    assert.equal(input.messages[1]!.text.length, 180);
    assert.deepEqual(output.rounds[0]!.toolSummary, [{ name: "read", count: 2 }]);
    assert.equal(output.rounds[0]!.ref, "fixed-ref");
    assert.equal(output.rounds[0]!.roundNumbering, "relative");
    assert.equal(JSON.stringify(output).includes("private-result"), false);
});

test("normal keeps complete prose and lightweight tool summary", () => {
    const output = formatProgressiveReadRows(fixture(), { action: "read_ready", depth: "normal" });
    assert.equal(output.messages[1]!.text.length, 180);
    assert.deepEqual(output.rounds[0]!.toolSummary, [{ name: "read", count: 2 }]);
    assert.equal(JSON.stringify(output).includes("saved-thinking"), false);
});

test("published zero-tool metadata remains known rather than missing", () => {
    const input = fixture();
    input.rounds[0]!.toolCalls = [];
    input.rounds[0]!.toolSummary = [];
    const output = formatProgressiveReadRows(input, { action: "read_ready", depth: "normal" });
    assert.deepEqual(output.rounds[0]!.toolSummary, []);
    assert.equal(output.rounds[0]!.toolSummaryAvailable, true);
});

test("full exposes cached thinking and canonical tool details", () => {
    const output = formatProgressiveReadRows(fixture(), { action: "read_ready", depth: "full" });
    assert.ok(JSON.stringify(output.rounds).includes("saved-thinking"));
    assert.ok(JSON.stringify(output.rounds).includes("private-result"));
    assert.equal(output.rounds[0]!.ref, "fixed-ref");
});

test("extraTypes exposes requested saved details under normal", () => {
    const output = formatProgressiveReadRows(fixture(), { action: "read_ready", depth: "normal", extraTypes: ["thinking", "tool_results"] });
    assert.deepEqual(output.rounds[0]!.thinking, [{ stepIndex: 2, thinking: "saved-thinking" }]);
    assert.ok(JSON.stringify(output.rounds[0]!.toolCalls).includes("private-result"));
});

test("explicit user-only filters thinking tools and summary even with full extras", () => {
    for (const depth of ["normal", "brief", "full"]) {
        const output = formatProgressiveReadRows(fixture(), { action: "read_ready", depth, messageRoles: ["user"], extraTypes: ["thinking", "tool_results"] });
        assert.deepEqual(output.messages.map(message => message.role), ["user"]);
        assert.equal(output.rounds[0]!.toolSummary, undefined);
        assert.equal(JSON.stringify(output).includes("private-result"), false);
        assert.equal(JSON.stringify(output).includes("saved-thinking"), false);
        assert.deepEqual(output.messages[0]!.annotations, [{ selectedText: "引用", comment: "批注" }]);
    }
});

test("ready continuation retains original one-round request", () => {
    const request: ProgressiveRequest = { ownerId: "owner", conversationId: "target", dataChain: "codex", direction: "latest", initialRounds: 1, buildFull: false };
    assert.deepEqual(progressiveReadyReadNext(request, "original-task"), { action: "read_ready", conversationId: "owner", dataChain: "codex", taskId: "original-task", lastRounds: 1 });
});

test("oldest continuation retains its initial block instead of selecting the latest window", () => {
    const request: ProgressiveRequest = { ownerId: "owner", conversationId: "target", dataChain: "codex", direction: "oldest", initialRounds: 1, buildFull: true };
    assert.deepEqual(progressiveReadyReadNext(request, "original-task", ["first-block"]), {
        action: "read_ready", conversationId: "owner", dataChain: "codex", taskId: "original-task", lastRounds: 1, buildOrder: "oldest", blockId: "first-block",
    });
    assert.equal(progressiveReadyReadNext(request, "original-task", ["first-half", "second-half"]).buildOrder, "oldest");
});
