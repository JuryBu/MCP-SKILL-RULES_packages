import assert from "node:assert/strict";
import { formatCorpusReadableResult, withCorpusOutputFormat } from "../src/conversation-readable-output.js";
import { compactProgressiveRef } from "../src/conversation-progressive-reference.js";

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

for (const status of ["done", "failed", "cancelled", "resumable"]) {
    const completedPreparation = formatCorpusReadableResult({ taskId: "finished-partial", status, rangeAvailable: true,
        requestedRangeComplete: false, fullSourceComplete: false }, { action: "prepare_status" })!;
    assert.ok(completedPreparation.includes("本任务已结束，已取得部分范围"));
    assert.ok(completedPreparation.includes("本次未准备完整历史"));
    assert.ok(!completedPreparation.includes("仍在准备"));
}
const runningPreparation = formatCorpusReadableResult({ taskId: "running-partial", status: "running", rangeAvailable: true,
    requestedRangeComplete: false, fullSourceComplete: false }, { action: "prepare_status" })!;
assert.ok(runningPreparation.includes("所需范围仍在准备"));
const finishedEmptyPreparation = formatCorpusReadableResult({ taskId: "finished-empty", status: "done", rangeAvailable: false,
    requestedRangeComplete: false }, { action: "prepare_status" })!;
assert.ok(finishedEmptyPreparation.includes("本任务已结束，未取得所需范围"));

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

const blockId = "b".repeat(64);
const longRef = `pcache:v1:${"a".repeat(64)}:${blockId}:${"c".repeat(64)}:relative:1`;
const shortRef = compactProgressiveRef(longRef)!;
const sameDay = new Date(2026, 10, 9, 14, 23).toISOString();
const nextDay = new Date(2026, 10, 10, 0, 5).toISOString();
const densityResult = {
    conversation: { id: "same-source", title: "来源精简", source: "codex" }, roundNumbering: "relative",
    rounds: [{ round: 1, ref: longRef, blockId, toolSummary: [{ name: "sandbox_exec", count: 2 }] }],
    messages: [
        { round: 1, role: "user", text: "简略正文", truncated: true, originalTextChars: 300, timestamp: sameDay, sourceThreadId: "same-source" },
        { round: 1, role: "assistant", text: "AI正文", truncated: true, timestamp: sameDay, sourceThreadId: "same-source" },
        { round: 1, role: "subagent", agentNickname: "Sol", text: "不同来源", sourceThreadId: "child-source" },
        { round: 1, role: "assistant", text: "返回主对话", timestamp: nextDay, sourceThreadId: "same-source" },
    ], next: { action: "read_ready", taskId: "task", rangeRef: longRef },
};
const densitySnapshot = JSON.stringify(densityResult);
const densityNormal = formatCorpusReadableResult(densityResult, { action: "read_ready", depth: "normal", lastRounds: 4 })!;
for (const expected of ["# 📖 来源精简", "范围：末4轮 · 本页相对轮次1–1", "时间：2026-11-09（本机时间）", "14:23", "2026-11-10 00:05", shortRef, "sandbox_exec × 2", "Sol", "不同来源"]) assert.ok(densityNormal.includes(expected), expected);
assert.equal(densityNormal.split("same-source").length - 1, 2);
assert.equal(densityNormal.split("child-source").length - 1, 1);
assert.ok(!densityNormal.includes("已发布块"));
assert.ok(!densityNormal.includes(sameDay));
assert.ok(densityNormal.includes(JSON.stringify(densityResult.next)));
const densityBrief = formatCorpusReadableResult(densityResult, { action: "read_ready", depth: "brief", startRound: 1, endRound: 1 })!;
assert.ok(densityBrief.includes("范围：所选轮次1–1 · 本页相对轮次1–1"));
assert.ok(densityBrief.includes("### 👤 · 14:23"));
assert.ok(densityBrief.includes("简略正文…"));
assert.equal(densityBrief.split("正文已截短").length - 1, 1);
assert.ok(!densityBrief.includes("当前为简略文本"));
const premarkedBrief = formatCorpusReadableResult({ messages: [{ round: 1, role: "user", text: "已有省略号…", truncated: true }] }, { action: "read_ready", depth: "brief" })!;
assert.ok(premarkedBrief.includes("已有省略号…"));
assert.ok(!premarkedBrief.includes("已有省略号……"));
assert.equal(premarkedBrief.split("正文已截短").length - 1, 1);
assert.equal(JSON.stringify(densityResult), densitySnapshot);
assert.equal(formatCorpusReadableResult(densityResult, { action: "read_ready", format: "json" }), undefined);
const homogeneous = formatCorpusReadableResult({ ...densityResult, messages: densityResult.messages.slice(0, 2) }, { action: "read_ready" })!;
assert.equal(homogeneous.split("same-source").length - 1, 1);
const mismatchedBlock = formatCorpusReadableResult({ messages: [], rounds: [{ round: 1, ref: longRef, blockId: "different-block" }] }, { action: "read_ready" })!;
assert.ok(mismatchedBlock.includes("different-block"));
const compactSearch = formatCorpusReadableResult({ taskId: "task", hits: [{ round: 1, ref: longRef, next: densityResult.next }] }, { action: "search_ready" })!;
assert.ok(compactSearch.includes(`固定引用：\`${shortRef}\``));
assert.ok(compactSearch.includes(JSON.stringify(densityResult.next)));
const invalidTime = formatCorpusReadableResult({ messages: [{ round: 1, role: "user", text: "时间保留", timestamp: "unknown-time" }] }, { action: "read_ready" })!;
assert.ok(invalidTime.includes("unknown-time"));
const unverified = formatCorpusReadableResult({ sourceRangeVerified: false, partial: true, rounds: [{ round: 1, roundNumbering: "relative" }], messages: [{ round: 1, role: "user", text: "部分正文" }] }, { action: "read_ready" })!;
for (const expected of ["来源范围仍待核验", "当前只返回可读范围", "相对轮号仅属于当前已准备范围"]) assert.ok(unverified.includes(expected), expected);
const detailPendingResult = { taskId: "task", status: "needs_preparation", phase: "details-not-prepared", preparedDepth: "normal", requestedDepth: "full", detail: "原准备仅含正文，补充工具详情", next: { action: "prepare", depth: "full", lastRounds: 4 } };
for (const detailResult of [detailPendingResult, { ...detailPendingResult, messages: [{ round: 1, role: "user", text: "已有正文" }] }]) {
    const detailPending = formatCorpusReadableResult(detailResult, { action: "read_ready", depth: "full" })!;
    for (const expected of ["已有正文可读，详情需要补充准备", "已准备 normal", "请求 full", "补充工具详情", JSON.stringify(detailPendingResult.next)]) assert.ok(detailPending.includes(expected), expected);
    assert.ok(!detailPending.includes("失败"));
    assert.ok(!detailPending.includes("所需范围已经就绪"));
}
const absoluteNext = { action: "read_fast", depth: "full", startRound: 8, endRound: 9, format: "markdown" };
const relativeSelection = { rangeRef: longRef, roundNumbering: "relative" };
const absoluteDetailPending = formatCorpusReadableResult({ ...detailPendingResult, requestedSelection: relativeSelection, next: absoluteNext }, { action: "read_ready", depth: "full" })!;
assert.ok(absoluteDetailPending.includes(JSON.stringify(relativeSelection)));
assert.ok(absoluteDetailPending.includes(JSON.stringify(absoluteNext)));
assert.ok(!absoluteDetailPending.includes('"action":"prepare"'));
const relativeBlockSelection = { blockId, startRound: 2, endRound: 3 };
const relativeBlockNext = { action: "prepare", conversationId: "reader", conversationIds: ["same-source"], dataChain: "codex", lastRounds: 4, buildOrder: "latest", depth: "full", messageRoles: ["user", "assistant", "tool"], prepareCache: false };
const relativeBlockResult = { ...detailPendingResult, requestedSelection: relativeBlockSelection, next: relativeBlockNext };
const relativeBlockSnapshot = JSON.stringify(relativeBlockResult);
const relativeBlockPending = formatCorpusReadableResult(relativeBlockResult, { action: "read_ready", depth: "full", ...relativeBlockSelection })!;
for (const expected of ["已有正文可读，详情需要补充准备", `原请求范围：${JSON.stringify(relativeBlockSelection)}`, JSON.stringify(relativeBlockNext)]) assert.ok(relativeBlockPending.includes(expected), expected);
assert.ok(!relativeBlockPending.includes('"action":"read_fast"'));
assert.equal(JSON.stringify(relativeBlockResult), relativeBlockSnapshot);
const legacyBrief = formatCorpusReadableResult({ rounds: [{ roundIndex: 1, startStep: 1, endStep: 2, userMessage: "原文".repeat(101), aiResponses: [{ stepIndex: 2, response: "答复".repeat(101) }], toolCalls: [], subagentSummaries: [], taskBoundaries: [], codeActions: [] }], messages: [] }, { action: "read_fast", depth: "brief" })!;
assert.ok(!legacyBrief.includes("本段过长已截断"));
assert.equal(legacyBrief.split("正文已截短").length - 1, 1);

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
console.log("PASS readable output: compact refs, source transitions, brief density, local dates/ranges, detail preparation, delta cursors, coverage, attachments, JSON and UTF-8 pagination");
