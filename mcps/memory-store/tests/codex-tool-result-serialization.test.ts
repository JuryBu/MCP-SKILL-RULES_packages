import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCodexRoundsForTest } from "../src/codex-client.ts";

function resultCall(output: unknown, endings: unknown[] = []) {
    return buildCodexRoundsForTest([
        { type: "event_msg", payload: { type: "user_message", message: "synthetic serialization request" } },
        { type: "response_item", payload: { type: "function_call", call_id: "fixture-call", name: "fixture", arguments: "{}" } },
        { type: "response_item", payload: { type: "function_call_output", call_id: "fixture-call", output } },
        ...endings,
    ], "full").rounds[0]!.toolCalls[0]!;
}

test("identical tool result and summary serialize once", () => {
    let reads = 0;
    const value = { get text() { reads++; return "synthetic result"; } };
    const call = resultCall(value);
    assert.equal(call.resultFull, '{"text":"synthetic result"}');
    assert.equal(call.resultSummary, call.resultFull);
    assert.equal(reads, 1);
});

test("Unicode and binary sanitization remain identical in result and summary", () => {
    for (const output of ["synthetic result", "猫😀".repeat(20), { text: "猫😀", data: Buffer.from("synthetic binary".repeat(40)).toString("base64") }, ["猫😀", null, 1], { nested: { value: "synthetic result" } }]) {
        const call = resultCall(output);
        assert.equal(call.resultSummary, call.resultFull);
        assert.doesNotMatch(call.resultFull ?? "", /c3ludGhldGljIGJpbmFyeQ/u);
    }
    const long = resultCall("猫😀".repeat(1000));
    assert.ok(long.resultFull!.length > long.resultSummary.length);
    assert.doesNotMatch(long.resultSummary, /[\uD800-\uDBFF]$/u);
});

test("distinct MCP summaries and overwriting result events retain their own content", () => {
    const result = { content: [{ type: "text", text: "distinct synthetic summary" }], metadata: "synthetic metadata" };
    const mcp = resultCall("old result", [{ type: "event_msg", payload: { type: "mcp_tool_call_end", call_id: "fixture-call", result } }]);
    assert.equal(mcp.resultFull, JSON.stringify(result));
    assert.equal(mcp.resultSummary, "distinct synthetic summary");
    const overwritten = resultCall("old result", [{ type: "event_msg", payload: { type: "exec_command_end", call_id: "fixture-call", aggregated_output: "replacement result" } }]);
    assert.equal(overwritten.resultFull, "replacement result");
    assert.equal(overwritten.resultSummary, "replacement result");
});
