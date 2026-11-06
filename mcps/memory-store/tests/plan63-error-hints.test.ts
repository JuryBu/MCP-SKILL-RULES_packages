import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyError, formatToolError } from "../src/error-format.ts";

const timeout = new Error("source request timed out");
const originalTaskId = "synthetic-original-task";

function hint(action: string, keyArgs?: Record<string, unknown>): string {
    return formatToolError(action, timeout, keyArgs).split("\n").find(line => line.startsWith("💡 建议:"))!;
}

test("context-free timeout classification keeps its contract without inventing task actions", () => {
    const result = classifyError(timeout);
    assert.equal(result.category, "timeout");
    assert.equal(result.retryable, true);
    assert.equal(result.message, timeout.message);
    assert.doesNotMatch(result.hint, /background=true|task_status/);
});

test("list on all five sources recommends only its synchronous controls", () => {
    for (const dataChain of ["codex", "claude-code", "windsurf", "antigravity", "dsh"]) {
        const suggestion = hint("conversation_read_original(list)", { dataChain });
        assert.match(suggestion, /workspaces/);
        assert.match(suggestion, /deadlineMs/);
        assert.doesNotMatch(suggestion, /background=true|task_status|deep_locate_status|prepare_status/);
    }
});

test("tool name plus action key receives the same context as the existing parenthesized name", () => {
    assert.equal(hint("conversation_read_original", { action: "list" }), hint("conversation_read_original(list)"));
    assert.doesNotMatch(hint("memory_query", { action: "update" }), /background=true|task_status/);
});

test("deep locate start, status and cancellation always follow the original task", () => {
    for (const action of ["deep_locate", "deep_locate_status", "deep_locate_cancel"]) {
        const suggestion = hint(`conversation_read_original(${action})`, { taskId: originalTaskId });
        assert.match(suggestion, /action="deep_locate_status"/);
        assert.match(suggestion, /action="deep_locate_cancel"/);
        assert.ok(suggestion.includes(originalTaskId));
        assert.doesNotMatch(suggestion, /background=true|task_status|deep_locate_resume/);
    }
    assert.match(hint("conversation_read_original(deep_locate)"), /原.*taskId|taskId.*原/);
});

test("prepare and its consumers use only the original progressive task lifecycle", () => {
    for (const action of ["prepare", "prepare_status", "prepare_cancel", "prepare_resume", "read_ready", "search_ready", "locate_ready", "extract_ready"]) {
        const suggestion = hint(`conversation_read_original(${action})`, { taskId: originalTaskId });
        for (const next of ["prepare_status", "prepare_cancel", "prepare_resume"]) assert.ok(suggestion.includes(`action="${next}"`));
        assert.ok(suggestion.includes(originalTaskId));
        assert.doesNotMatch(suggestion, /background=true|search_all_status|task_status/);
    }
    for (const action of ["read", "search"]) {
        const suggestion = hint(`conversation_read_original(${action})`, { progressiveTaskId: originalTaskId });
        assert.match(suggestion, /action="prepare_status"/);
        assert.ok(suggestion.includes(originalTaskId));
    }
});

test("a taskId attached after task acceptance survives an error before the normal receipt", () => {
    const error = Object.assign(new Error("preparation index write timed out"), { taskId: originalTaskId, content: "synthetic-hidden-error-payload" });
    const text = formatToolError("conversation_read_original(read_fast)", error);
    const deepLocate = formatToolError("conversation_read_original(deep_locate)", error);
    assert.ok(deepLocate.includes(originalTaskId));
    assert.doesNotMatch(deepLocate, /background=true|synthetic-hidden-error-payload/);
    assert.match(text, /search_all_status/);
    assert.ok(text.includes(originalTaskId));
    const explicit = formatToolError("conversation_read_original(deep_locate_status)", error, { taskId: "synthetic-explicit-task" });
    assert.ok(explicit.includes("synthetic-explicit-task"));
    assert.ok(!explicit.includes(originalTaskId));
});

test("corpus search status, cancellation and resume stay bound to the original search", () => {
    for (const action of ["search_all", "search_all_status", "search_all_cancel", "search_all_resume"]) {
        const suggestion = hint(`conversation_read_original(${action})`, { taskId: originalTaskId });
        for (const next of ["search_all_status", "search_all_cancel", "search_all_resume"]) assert.ok(suggestion.includes(`action="${next}"`));
        assert.ok(suggestion.includes(originalTaskId));
        assert.doesNotMatch(suggestion, /background=true|prepare_status|task_status/);
    }
});

test("fetch distinguishes progressive and complete-fetch tasks and limits background advice to local Codex", () => {
    const codex = hint("conversation_read_original(fetch)", { dataChain: "codex" });
    assert.match(codex, /background=true/);
    assert.match(codex, /prepare_status/);
    assert.match(codex, /background_task_status/);
    const progressive = hint("conversation_read_original(fetch)", { progressiveTaskId: originalTaskId });
    assert.match(progressive, /action="prepare_status"/);
    assert.ok(progressive.includes(originalTaskId));
    assert.doesNotMatch(progressive, /background=true/);
    const complete = hint("conversation_read_original(fetch)", { dataChain: "codex", progressive: false, taskId: originalTaskId });
    assert.match(complete, /background_task_status/);
    assert.ok(complete.includes(originalTaskId));
    assert.doesNotMatch(complete, /background=true/);
    for (const dataChain of ["claude-code", "windsurf", "antigravity", "dsh"]) {
        assert.doesNotMatch(hint("conversation_read_original(fetch)", { dataChain }), /background=true/);
    }
    for (const source of ["ls", "cache"]) {
        assert.doesNotMatch(hint("conversation_read_original(fetch)", { dataChain: "codex", source }), /background=true/);
    }
});

test("read_fast follows the returned next entry instead of confusing its two preparation task types", () => {
    const suggestion = hint("conversation_read_original(read_fast)");
    assert.match(suggestion, /next/);
    assert.match(suggestion, /prepare_status/);
    assert.match(suggestion, /search_all_status/);
    assert.doesNotMatch(suggestion, /background=true|task_status/);
});

test("record background-capable operations retain their actual query and cancellation entries", () => {
    for (const action of ["update", "batch_update", "bulk_update", "guide"]) {
        const initial = hint(`record_manage(${action})`);
        assert.match(initial, /background=true/);
        assert.match(initial, /action="task_status"/);
        const existing = hint(`record_manage(${action})`, { taskId: originalTaskId });
        assert.match(existing, /action="task_status"/);
        assert.ok(existing.includes(originalTaskId));
        assert.doesNotMatch(existing, /background=true/);
    }
    for (const action of ["task_status", "cancel", "recover"]) {
        const suggestion = hint(`record_manage(${action})`, { taskId: originalTaskId });
        assert.match(suggestion, /action="task_status"/);
        assert.doesNotMatch(suggestion, /background=true/);
    }
});

test("Guard check queries the same check task, while other synchronous operations get no background advice", () => {
    assert.match(hint("stage_guard(check)"), /background=true/);
    const suggestion = hint("stage_guard(check)", { taskId: originalTaskId });
    assert.match(suggestion, /stage_guard\(action="check", taskId=/);
    assert.ok(suggestion.includes(originalTaskId));
    assert.doesNotMatch(suggestion, /background=true|task_status/);
    for (const action of ["start", "status"]) assert.doesNotMatch(hint(`stage_guard(${action})`), /background=true|task_status/);
});

test("golden extraction retains its taskId query rather than a nonexistent action", () => {
    assert.match(hint("conversation_golden_extract"), /background=true/);
    const suggestion = hint("conversation_golden_extract", { taskId: originalTaskId });
    assert.match(suggestion, /conversation_golden_extract\(taskId=/);
    assert.ok(suggestion.includes(originalTaskId));
    assert.doesNotMatch(suggestion, /background=true|task_status/);
});

test("synchronous and unknown actions never inherit a made-up background lifecycle", () => {
    for (const action of ["record_manage(list)", "record_manage(read)", "record_manage(search)", "record_manage(edit)", "conversation_read_original(read)", "conversation_read_original(search)", "memory_read", "memory_write", "unknown_tool(update)"]) {
        assert.doesNotMatch(hint(action), /background=true|task_status/);
    }
});

test("non-timeout classifications and suggestions remain independent of tool context", () => {
    for (const error of [new Error("ENOENT"), new Error("permission denied"), new Error("invalid argument"), new Error("ECONNRESET"), new Error("unclassified failure")]) {
        const classified = classifyError(error);
        const text = formatToolError("conversation_read_original(list)", error);
        assert.ok(text.includes(`🏷 分类: ${classified.category}`));
        assert.ok(text.includes(`🔁 可重试: ${classified.retryable ? "是" : "否"}`));
        assert.ok(text.includes(`💡 建议: ${classified.hint}`));
    }
});

test("contextual suggestions preserve bounded argument echoes and exclude private payloads", () => {
    const text = formatToolError("conversation_read_original(prepare)", timeout, {
        taskId: "t".repeat(200), query: "q".repeat(200), content: "synthetic-private-payload", append: "synthetic-private-append",
    });
    assert.doesNotMatch(text, /synthetic-private-payload|synthetic-private-append/);
    assert.ok(!text.includes("t".repeat(100)));
    assert.ok(!text.includes("q".repeat(100)));
    assert.equal(text.split("\n").filter(line => line.startsWith("💡 建议:")).length, 1);
});
