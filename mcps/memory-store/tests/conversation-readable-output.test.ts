import assert from "node:assert/strict";
import { formatCorpusReadableResult, withCorpusOutputFormat } from "../src/conversation-readable-output.js";

const params = { action: "read_ready", conversationId: "reader", dataChain: "windsurf" };
const result = {
    taskId: "progressive-example", requestedRangeComplete: false, fullSourceComplete: false,
    source: { host: "windsurf", conversationId: "example", conversation: { id: "example", title: "可读对话", source: "windsurf" } },
    rounds: [{ round: 1, roundNumbering: "relative", ref: "stable-ref", blockId: "published-block" }],
    messages: [
        { id: "user-message", round: 1, role: "user", text: "第一行\n第二行", annotations: [{ selectedText: "原句", comment: "补充要求" }],
            attachments: [{ kind: "image", originalPath: "C:/example/image.png", exists: false }] },
        { id: "child-message", round: 1, role: "subagent", text: "子代理原文", sourceThreadId: "child-example" },
    ], warnings: ["来源仍有未覆盖范围"],
};
const readable = formatCorpusReadableResult(result, params)!;
for (const expected of ["# 📖 可读对话", "## 相对轮次 1", "### 👤 用户", "第一行\n第二行", "补充要求", "C:/example/image.png", "🧩 子代理", "child-example", "stable-ref", "published-block", "来源仍有未覆盖范围"]) assert.ok(readable.includes(expected), expected);
assert.doesNotMatch(readable, /"messages"\s*:/u);
assert.equal(formatCorpusReadableResult(result, { ...params, format: "json" }), undefined);
assert.equal(formatCorpusReadableResult(result), undefined);
assert.deepEqual(result.messages[0].annotations, [{ selectedText: "原句", comment: "补充要求" }]);

const next = { action: "read_result", taskId: "result-example", continuationCursor: "digest:24000" };
const page = formatCorpusReadableResult({ delivery: "paged", format: "markdown", text: "中文正文", startByte: 0, endByte: 24000, bytes: 30000, artifactPath: "example.md", next }, { action: "read_result" })!;
assert.ok(page.startsWith("中文正文"));
assert.ok(page.includes(JSON.stringify(next)));
const pending = formatCorpusReadableResult({ taskId: "progressive-example", rangeAvailable: false, phase: "initial", next: { action: "prepare_status", taskId: "progressive-example" } }, { action: "read_fast" })!;
assert.ok(pending.includes("所需范围仍在准备"));
assert.ok(pending.includes("prepare_status"));

const search = formatCorpusReadableResult({ taskId: "search-example", status: "running", totalMatches: 1, results: [{ conversation: { id: "example", title: "命中", source: "windsurf" }, sourceRevision: "verified-version", occurrences: 3, matchedMessages: 2, rounds: [1], termCounts: { 内容: 3 }, snippets: [{ round: 1, role: "user", text: "命中内容" }] }], coverage: { scannedConversations: 1, candidateConversations: 2, complete: false } }, { action: "search_all_status", conversationId: "reader" })!;
for (const expected of ["出现3次", "命中2条消息", "「内容」3次", "1/2个候选对话", "verified-version", "read_hit", "search_all_status"]) assert.ok(search.includes(expected), expected);
const delta = formatCorpusReadableResult({ taskId: "search-example", status: "completed", revision: 9, results: [],
    request: { dataChains: ["antigravity", "dsh"] }, nextAfterRevision: 4,
    changes: { upserts: [{ conversation: { source: "dsh", id: "updated-id" }, sourceRevision: "pending:version", provisional: true, termCounts: { 内容: 2 } }],
        removedConversations: [{ source: "antigravity", conversationId: "removed-id" }], removedConversationKeys: ["antigravity:removed-id"], removedConversationIds: ["legacy-id"], throughRevision: 4, hasMore: true },
    coverage: { scannedConversations: 1, candidateConversations: 3, complete: false, discoveryComplete: false, pendingConversations: 2,
        warnings: ["partial-warning"], errors: [{ source: "dsh", message: "source-error" }], sourceStatuses: [{ source: "dsh", status: "failed", warnings: ["source-warning"], error: "unreadable" }] },
}, { action: "search_all_status", conversationId: "reader", limit: 1 })!;
for (const expected of ["updated-id", "removed-id", "antigravity:removed-id", "legacy-id", "partial-warning", "source-error", "source-warning", "unreadable", '"afterRevision":4', '"dataChains":["antigravity","dsh"]', "本次已消费位置：4"]) assert.ok(delta.includes(expected), expected);
assert.ok(!delta.includes('"afterRevision":9'));
const pendingSearch = formatCorpusReadableResult({ taskId: "search-example", results: [{ conversation: { source: "dsh", id: "target" }, sourceRevision: "pending:version", snippets: [{ round: 2, text: "待核验命中" }] }] }, { action: "search_all_status", conversationId: "reader" })!;
assert.ok(pendingSearch.includes('"action":"read_fast"'));
assert.ok(!pendingSearch.includes('"action":"read_hit"'));
const stableSearch = formatCorpusReadableResult({ taskId: "progressive-example", status: { complete: false }, match: { conversation: { source: "dsh", id: "target" }, snippets: [{ round: 2, text: "相对轮号命中" }] },
    hits: [{ round: 2, ref: "stable-ref", next: { action: "read_ready", taskId: "progressive-example", rangeRef: "stable-ref" } }], searchedRanges: [{ kind: "relative", startRound: 1, endRound: 2, blockId: "block" }], scannedRounds: 2, totalHits: 5, hasMoreHits: true,
}, { action: "search_ready", conversationId: "reader" })!;
for (const expected of ["搜索相对轮次：1–2", "totalHits：5", "hasMoreHits：true", '"rangeRef":"stable-ref"']) assert.ok(stableSearch.includes(expected), expected);
assert.ok(!stableSearch.includes('"action":"read_hit"'));
assert.ok(!stableSearch.includes("[object Object]"));
const sourceEvent = { kind: "pb_wire_variant", payload: { originalField: "原字段" } };
const details = formatCorpusReadableResult({ rounds: [{ roundIndex: 1, sourceEvents: [sourceEvent] }], messages: [{ round: 1, role: "user", text: "正文" }] }, { action: "read_hit", extraTypes: ["tool_results"] })!;
assert.ok(details.includes("pb_wire_variant") && details.includes("originalField"));
const toolOverview = formatCorpusReadableResult({ rounds: [{ round: 1, toolSummary: [{ name: "sandbox_exec", count: 2 }], toolSummaryAvailable: true }], messages: [{ round: 1, role: "assistant", text: "答复" }] }, { action: "read_ready", depth: "normal" })!;
assert.ok(toolOverview.includes("sandbox_exec × 2") && toolOverview.includes("### 🤖 AI"));
const executable = { action: "read_ready", taskId: "task" };
const machineSource = { next: { read: executable, status: { action: "prepare_status", taskId: "task" } }, hits: [{ next: executable }], cachePreparation: { next: executable }, fullFetchCache: { next: { action: "read" } }, messages: [{ text: "完整正文", next: { action: "historical-payload" } }] };
const machine = withCorpusOutputFormat(machineSource, "json") as any;
for (const nextValue of [machine.next.read, machine.next.status, machine.hits[0].next, machine.cachePreparation.next]) assert.equal(nextValue.format, "json");
assert.equal(machine.fullFetchCache.next.format, undefined);
assert.deepEqual(machine.fullFetchCache, machineSource.fullFetchCache);
assert.equal(machineSource.next.read, executable);
assert.ok(!("format" in executable));
assert.equal(machine.messages, machineSource.messages);

const childFull = formatCorpusReadableResult({ conversation: { isChildThread: true, id: "child", agentNickname: "Plato" },
    rounds: [{ roundIndex: 1, roundNumbering: "relative", aiResponses: [{ thinking: "child-thinking" }], toolCalls: [{ name: "read", resultFull: "single-tool-payload" }] }],
    messages: [{ round: 1, role: "subagent", text: "child-body", agentNickname: "Plato", sourceThreadId: "child" }, { round: 1, role: "tool", text: "read\nargs\nsingle-tool-payload" }],
}, { action: "read_ready", depth: "full" })!;
for (const expected of ["child-body", "child-thinking", "Plato", "相对轮次"]) assert.ok(childFull.includes(expected), expected);
assert.equal(childFull.split("single-tool-payload").length - 1, 1);

const fs = await import("node:fs/promises");
const os = await import("node:os");
const path = await import("node:path");
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "readable-output-test-"));
const previousRoot = process.env.MEMORY_STORE_DATA_ROOT;
process.env.MEMORY_STORE_DATA_ROOT = temporary;
try {
    const { corpusToolResult, runCorpusAction } = await import("../src/tools/conversation-corpus-tool.js");
    const pageParams = { action: "read_ready", conversationId: "reader", dataChain: "dsh", format: "json" as const };
    const largeValue = { messages: [{ round: 1, role: "user", text: "中文😀".repeat(16000) }], next: executable };
    const first = await corpusToolResult(largeValue, pageParams);
    let current = JSON.parse(first.content[0].text);
    let combined = current.text;
    let pages = 1;
    while (current.next) {
        assert.equal(current.next.format, "json");
        const returned = await corpusToolResult(await runCorpusAction(current.next), current.next);
        const following = JSON.parse(returned.content[0].text);
        assert.equal(following.startByte, current.endByte);
        assert.equal(following.sha256, current.sha256);
        combined += following.text;
        current = following;
        pages++;
    }
    assert.ok(pages > 1);
    assert.equal(current.complete, true);
    const recovered = JSON.parse(combined);
    assert.equal(recovered.messages[0].text, largeValue.messages[0].text);
    assert.equal(recovered.next.format, "json");
    const markdown = await corpusToolResult(largeValue, { ...pageParams, format: "markdown" });
    assert.ok(markdown.content[0].text.startsWith("# 📖"));
    assert.ok(markdown.content[0].text.includes("read_result"));
    assert.ok(!("structuredContent" in markdown));
} finally {
    if (previousRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
    else process.env.MEMORY_STORE_DATA_ROOT = previousRoot;
    await fs.rm(temporary, { recursive: true, force: true });
}
console.log("PASS readable output: delta identity/cursors, coverage/errors, stable refs, pending fallback, source events, JSON next propagation and UTF-8 pagination");
