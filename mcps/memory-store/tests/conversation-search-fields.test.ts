import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationRound } from "../src/trajectory.js";
import type { ConversationLoadResult } from "../src/conversation-bridge.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-search-fields-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
const search = await import("../src/conversation-search.js");
const policy = await import("../src/conversation-search-policy.js");
const cache = await import("../src/conversation-source-cache.js");
const { searchInRounds } = await import("../src/trajectory.js");

function round(roundIndex: number, userMessage = ""): ConversationRound {
    return { roundIndex, startStep: roundIndex * 3, endStep: roundIndex * 3 + 2, userMessage,
        mediaAttachments: [], aiResponses: [], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [] };
}

function loaded(rounds: ConversationRound[]): ConversationLoadResult {
    return { chainUsed: "codex", conversationId: "fixture-search", rounds, roundCount: rounds.at(-1)?.roundIndex ?? 0, totalSteps: rounds.length * 3 };
}

try {
    const rangeRounds = [round(1, "Alpha outside"), round(44, "Alpha 中文子串 /fixture/path"), round(56, "Beta tail"), round(57, "Alpha outside")];
    rangeRounds[1].aiResponses.push({ stepIndex: 133, response: "MODEL_ONLY alpha", thinking: "private-thinking-marker", toolCalls: [] });
    const filtered = search.searchConversationRoundsExact(rangeRounds, "ALPHA missing", 1, { startRound: 44, endRound: 56, messageRoles: ["user"] });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].roundIndex, 44);
    assert.equal(filtered[0].role, "user");
    assert.equal(search.searchConversationRoundsExact(rangeRounds, "中文子串 /fixture/path", 8, { messageRoles: ["user"] })[0].hitCount, 2);
    assert.deepEqual(search.searchConversationRoundsExact(rangeRounds, "MODEL_ONLY", 8, { messageRoles: ["model"] }),
        search.searchConversationRoundsExact(rangeRounds, "MODEL_ONLY", 8, { messageRoles: ["assistant"] }));
    assert.equal(search.searchConversationRoundsExact(rangeRounds, "private-thinking-marker", 8, { messageRoles: ["assistant"] }).length, 1);
    assert.equal(search.searchConversationRoundsExact(rangeRounds, "MODEL_ONLY", 8, { messageRoles: ["user"] }).length, 0);
    assert.deepEqual(search.searchConversationRoundsExact(rangeRounds, "alpha missing", 8).filter(match => match.matchType !== "tool")
        .map(match => [match.roundIndex, match.matchType, match.hitCount]), searchInRounds(rangeRounds, "alpha missing", 8)
        .map(match => [match.roundIndex, match.matchType, match.hitCount]));
    const rankedRounds = [round(1, "alpha"), round(2, "alpha beta")];
    assert.equal(search.searchConversationRoundsExact(rankedRounds, "alpha beta", 1)[0].roundIndex, 2);
    assert.deepEqual(search.conversationSearchContextIndices([{ roundIndex: 44 }, { roundIndex: 56 }], 80, 4,
        { startRound: 44, endRound: 56 }), [44, 45, 46, 47, 48, 52, 53, 54, 55, 56]);
    for (const filter of [{ startRound: 0 }, { startRound: 1.5 }, { startRound: 5, endRound: 4 }]) {
        assert.throws(() => search.validateConversationSearchFilter(filter), /1-based|endRound/u);
    }
    assert.equal(search.resolveConversationSearchLimit(undefined, 4), 4);
    assert.equal(search.resolveConversationSearchLimit(4, 4), 4);
    assert.throws(() => search.resolveConversationSearchLimit(3, 4), /冲突/u);
    assert.throws(() => search.resolveConversationSearchLimit(0), /正整数/u);

    const annotationRound = round(5, "regular user text");
    annotationRound.userMessages = [{ text: "regular user text", annotations: [
        { selectedText: "selected-needle " + "选".repeat(20_000), comment: "comment-needle " + "评".repeat(20_000) },
        { selectedText: "selected-needle " + "选".repeat(20_000), comment: "comment-needle " + "评".repeat(20_000) },
    ] }];
    const annotations = search.searchConversationRoundsExact([annotationRound], "selected-needle comment-needle", 8, { messageRoles: ["user"] });
    assert.equal(annotations.length, 2);
    assert.deepEqual(annotations.map(match => match.annotationField), ["selectedText", "comment"]);
    assert.deepEqual(annotations.map(match => match.annotationIndex), [1, 1]);
    assert.ok(annotations.every(match => match.matchText.length < 400));
    assert.equal(search.searchConversationRoundsExact([annotationRound], "comment-needle", 8, { messageRoles: ["assistant"] }).length, 0);

    const automatic = round(6, ["[NAPCAT_QQ_MONITOR_WAKE]", "task_id=fixture-monitor", "generation=2", "pending_count=3", "请处理并 ACK"].join("\n"));
    assert.equal(search.searchConversationRoundsExact([automatic], "自动QQ消息提醒", 8, { messageRoles: ["user"] }).length, 0);
    const automaticMatch = search.searchConversationRoundsExact([automatic], "自动QQ消息提醒", 8, { messageRoles: ["system"] });
    assert.equal(automaticMatch[0].matchType, "automation");
    assert.equal(automaticMatch[0].role, "system");
    const rules = round(7, "# AGENTS.md instructions\nSYSTEM_RULE_NEEDLE");
    assert.equal(search.searchConversationRoundsExact([rules], "SYSTEM_RULE_NEEDLE", 8, { messageRoles: ["user"] }).length, 0);
    assert.equal(search.searchConversationRoundsExact([rules], "SYSTEM_RULE_NEEDLE", 8, { messageRoles: ["system"] }).length, 1);

    const toolRound = round(8, "tool-independent-human");
    toolRound.aiResponses.push({ stepIndex: 25, response: "assistant-independent", thinking: "", toolCalls: [{ name: "fixture", args: "ai-tool-argument" }] });
    toolRound.toolCalls.push({ stepIndex: 26, name: "fixture-tool", argsSummary: "short", resultSummary: "short",
        argsFull: "x".repeat(9_000) + "TOOL_ARGUMENT_TAIL", resultFull: "x".repeat(2_000_000) + "TOOL_RESULT_TAIL" });
    for (const query of ["ai-tool-argument", "TOOL_ARGUMENT_TAIL", "TOOL_RESULT_TAIL"]) {
        assert.equal(search.searchConversationRoundsExact([toolRound], query, 8, { messageRoles: ["tool"] }).length, 1);
        assert.equal(search.searchConversationRoundsExact([toolRound], query, 8, { messageRoles: ["assistant"] }).length, 0);
    }
    const subagentRound = round(9);
    subagentRound.subagentSummaries.push({ threadId: "fixture-child", nickname: "fixture-nickname", prompt: "x".repeat(9_000) + "CHILD_PROMPT_TAIL",
        summary: "child-summary", status: "child-complete", role: "child-reviewer" });
    for (const query of ["fixture-child", "fixture-nickname", "CHILD_PROMPT_TAIL", "child-summary", "child-complete", "child-reviewer"]) {
        assert.equal(search.searchConversationRoundsExact([subagentRound], query, 8, { messageRoles: ["subagent"] }).length, 1);
        assert.equal(search.searchConversationRoundsExact([subagentRound], query, 8, { messageRoles: ["assistant", "tool"] }).length, 0);
    }
    const semanticRound = round(10, "human-in-mixed-round");
    semanticRound.semanticEvents = [
        { semanticRole: "assistant", text: "semantic-model" },
        { semanticRole: "tool", argsFull: "semantic-tool-argument", resultFull: "semantic-tool-result" },
        { semanticRole: "system", text: "semantic-system" },
        { semanticRole: "subagent", name: "semantic-child", text: "semantic-child-result" },
    ];
    for (const [query, role] of [["semantic-model", "model"], ["semantic-tool-result", "tool"], ["semantic-system", "system"],
        ["semantic-child-result", "subagent"], ["human-in-mixed-round", "user"]] as const) {
        assert.equal(search.searchConversationRoundsExact([semanticRound], query, 8, { messageRoles: [role] }).length, 1);
    }
    const largeRound = round(11, "😀正文".repeat(600_000) + "DEEP_TAIL_NEEDLE");
    const largeMatch = search.searchConversationRoundsExact([largeRound], "DEEP_TAIL_NEEDLE", 1, { messageRoles: ["user"] })[0];
    assert.ok(largeMatch.contextStart > 2_000_000);
    assert.ok(largeMatch.matchText.length < 400);
    assert.match(largeMatch.matchText, /DEEP_TAIL_NEEDLE/u);
    assert.ok(!/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/u.test(largeMatch.matchText));
    const rankedBlocks = [...search.iterateConversationSearchBlocks([toolRound, subagentRound], { startRound: 8, endRound: 8, messageRoles: ["tool"] })];
    assert.ok(rankedBlocks.every(block => block.content.length <= 1_800 && block.metadata?.roundIndex === 8 && block.metadata?.role === "tool"));
    assert.ok(rankedBlocks.some(block => block.content.includes("TOOL_ARGUMENT_TAIL")));
    assert.ok(rankedBlocks.some(block => block.content.includes("TOOL_RESULT_TAIL")));
    assert.ok(!rankedBlocks.some(block => block.content.includes("assistant-independent") || block.content.includes("CHILD_PROMPT_TAIL")));

    cache.setConversationSourceCacheDataRootForTests(path.join(temporary, "cache-data"));
    const key = { source: "codex:link=summary", conversationId: "fixture-fixed-generation" };
    const first = await cache.readOrBuild({ key, fingerprint: { size: 100, revision: "first" }, build: () => ({ snapshot: loaded([round(1, "OLD_GENERATION_NEEDLE")]),
        rounds: [round(1, "OLD_GENERATION_NEEDLE"), round(2, "late-cache-text")] }), getRoundNumber: item => item.roundIndex });
    const second = await cache.readOrBuild({ key, refresh: true, fingerprint: { size: 200, revision: "second" },
        build: () => ({ snapshot: loaded([round(1, "NEW_GENERATION_NEEDLE")]), rounds: [round(1, "NEW_GENERATION_NEEDLE")] }), getRoundNumber: item => item.roundIndex });
    assert.notEqual(first.generation, second.generation);
    const fixed = { ...loaded([]), cacheKey: key, cacheGeneration: first.generation, roundCount: 2 };
    assert.equal(search.searchConversationRoundsExact(search.iterateConversationSearchRounds(fixed), "OLD_GENERATION_NEEDLE", 1)[0].roundIndex, 1);
    assert.equal(search.searchConversationRoundsExact(search.iterateConversationSearchRounds(fixed), "NEW_GENERATION_NEEDLE", 1).length, 0);
    assert.throws(() => search.iterateConversationSearchRounds({ ...fixed, cacheGeneration: "missing-generation" }), /缺失或损坏/u);
    assert.throws(() => search.iterateConversationSearchRounds({ ...fixed, cacheGeneration: undefined }), /key\/generation/u);
    const directory = cache.getConversationSourceCacheEntryDirectory(key);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, `manifest.${first.generation}.json`), "utf8"));
    const roundsPath = path.join(directory, manifest.files.rounds.file);
    const bytes = fs.readFileSync(roundsPath);
    const tailOffset = bytes.indexOf(Buffer.from("late-cache-text"));
    assert.ok(tailOffset > 0);
    bytes[tailOffset] = "L".charCodeAt(0);
    fs.writeFileSync(roundsPath, bytes);
    assert.throws(() => search.searchConversationRoundsExact(search.iterateConversationSearchRounds(fixed), "OLD_GENERATION_NEEDLE", 1), /corrupt|mismatch|hash|checksum|invalid/iu);

    const request = { source: "auto", sourceExplicit: false, link: "summary" } as const;
    const metadata = policy.formatConversationSearchReadCache({ ...fixed, cacheCreatedAt: "2026-01-01T00:00:00.000Z", cacheReadPolicy: "published", sourceMode: "cache" }, request,
        Date.parse("2026-01-01T00:00:30.000Z"));
    assert.match(metadata, /age: 30s/u);
    assert.match(metadata, /本次原文校验: no/u);
    assert.match(metadata, /实际视图: source=cache, link=summary/u);
    assert.match(policy.formatConversationSearchReadCache(loaded([round(1)]), request), /createdAt: unknown \| age: unknown/u);
    const strict = { ...request, sourceExplicit: true };
    assert.throws(() => policy.assertConversationStrictCacheState({ ...fixed, cacheState: "stale" }, "search", strict), /上一份完整缓存仍保留/u);
    assert.throws(() => policy.assertConversationStrictCacheState({ ...fixed, cacheState: "stale" }, "fetch", request), /严格原文校验/u);
    assert.doesNotThrow(() => policy.assertConversationStrictCacheState({ ...fixed, cacheState: "stale" }, "search", { ...strict, source: "cache" }));

    const taskStates = new Map([["task", "done"], ["task-retry-1", "failed"], ["task-retry-2", "running"]]);
    const getTask = (taskId: string) => taskStates.has(taskId) ? { status: taskStates.get(taskId)! } : null;
    assert.equal(policy.selectConversationFetchTaskId("task", { version: 1 }, getTask), "task");
    assert.equal(policy.selectConversationFetchTaskId("task", { version: 2 }, getTask), "task-retry-2");
    assert.equal(policy.selectConversationFetchTaskId("task", { version: 1, verificationDeferred: true }, getTask), "task-retry-2");
    taskStates.set("task-retry-2", "done");
    assert.equal(policy.selectConversationFetchTaskId("task", { version: 2 }, getTask), "task-retry-3");
    taskStates.set("task", "suspended");
    assert.equal(policy.selectConversationFetchTaskId("task", { version: 2 }, getTask), "task");
    assert.throws(() => policy.selectConversationFetchTaskId("task", { version: 2 }, () => ({ status: "done" })), /已耗尽/u);
    console.log("conversation-search-fields: PASS roles/ranges/full fields/annotations/automation/8K and 2M tails/generation/corruption/task reuse");
} finally {
    cache.resetConversationSourceCacheForTests();
    cache.setConversationSourceCacheDataRootForTests(null);
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true });
}
