import assert from "node:assert/strict";
import { test } from "node:test";
import { matchContextProbeText } from "../src/context-probe-text.js";
import { annotateContextLocateCandidates, locateConversationContext } from "../src/conversation-context-locate.js";
import type { UnifiedConversationCandidate } from "../src/conversation-filter.js";
import type { ConversationRound } from "../src/trajectory.js";

const body = "前文：甲组先读正文，乙组再核来源。\n\n确认之后，我们继续比较结果。后文。";
const probe = "甲组先读正文乙组再核来源，确认之后我们继续比较结果";
const candidate: UnifiedConversationCandidate = {
    id: "synthetic-format-probe", dataChain: "windsurf", title: "Synthetic format probe", workspace: "synthetic-workspace", updatedAt: "", detail: "synthetic only",
};
const round = (text: string): ConversationRound => ({
    roundIndex: 3, userMessage: { text, stepIndex: 7 }, userMessages: [{ text, stepIndex: 7 }],
    aiResponses: [], toolCalls: [], semanticEvents: [],
} as unknown as ConversationRound);
const locate = (text: string, query: string, isProbe: boolean) => locateConversationContext([candidate], query, {
    mode: "exact", probe: isProbe,
    adapters: { readRounds: async () => ({ rounds: [round(text)], filePath: "synthetic-history", freshness: "fresh" }) },
});

test("probe format matching ignores punctuation and paragraph whitespace but returns original text", () => {
    const snippet = matchContextProbeText(body, probe);
    assert.equal(snippet, body);
    assert.ok(snippet.includes("来源。\n\n确认之后，我们"));
});

test("probe format matching requires the entire probe in contiguous textual order", () => {
    for (const changed of [
        "甲组先读新增正文乙组再核来源确认之后我们继续比较结果",
        "甲组先读乙组再核来源确认之后我们继续比较结果",
        "甲组先读正文乙组再核地址确认之后我们继续比较结果",
        "甲组先读正文确认之后我们继续比较结果乙组再核来源",
    ]) assert.equal(matchContextProbeText(changed, probe), null);
});

test("empty and punctuation-only probes have no textual match", () => {
    for (const query of ["", " \n\t", "，。！？—…"]) assert.equal(matchContextProbeText(body, query), null);
});

test("compatibility normalization keeps original glyphs, casing and symbols in snippets", () => {
    const original = "说明：ＡＢＣ，Cafe\u0301\n版本＋乙组。";
    assert.equal(matchContextProbeText(original, "abc café版本+乙组"), original);
    assert.equal(matchContextProbeText("甲组使用C语言乙组继续核查", "甲组使用C++语言乙组继续核查"), null);
});

test("source snippets remain bounded and retain the original matching region", () => {
    const text = "前".repeat(500) + body + "后".repeat(500);
    const snippet = matchContextProbeText(text, probe)!;
    assert.ok(snippet.includes("来源。\n\n确认之后，我们"));
    assert.ok(snippet.length <= 420);
});

test("round contextProbe uses format tolerance and keeps source and original snippet", async () => {
    const result = await locate(body, probe, true);
    assert.equal(result.status, "found");
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].snippet, body);
    assert.equal(result.hits[0].filePath, "synthetic-history");
    assert.equal(result.hits[0].roundIndex, 3);
    assert.equal(result.hits[0].role, "user");
});

test("deep exact retains its strict punctuation semantics", async () => {
    const result = await locate(body, probe, false);
    assert.equal(result.hits.length, 0);
    assert.equal(result.status, "no_hit_after_full_scan");
    const literal = await locate(body, "甲组先读正文，乙组再核来源。", false);
    assert.equal(literal.hits.length, 1);
});

test("round format tolerance never accepts inserted, deleted or replaced words", async () => {
    for (const changed of ["甲组先读新增正文乙组再核来源确认之后我们继续比较结果", "甲组先读乙组再核来源确认之后我们继续比较结果", "甲组先读正文乙组再核地址确认之后我们继续比较结果"]) {
        assert.equal((await locate(changed, probe, true)).hits.length, 0);
    }
});

test("relative round metadata reaches hits and candidate labels without changing absolute rounds", async () => {
    const relativeCandidate = { ...candidate, dataChain: "antigravity" as const };
    const relative = await locateConversationContext([relativeCandidate], probe, { probe: true,
        adapters: { readRounds: async () => ({ rounds: [{ ...round(body), roundIndex: 1 }], roundIndexIsRelative: true }) },
    });
    assert.equal(relative.hits[0].roundIndexIsRelative, true);
    assert.equal(relative.hits[0].roundIndex, 1);
    assert.equal(relative.hits[0].sourcePosition.roundIndex, 1);
    assert.match(annotateContextLocateCandidates([relativeCandidate], relative)[0].contextProbe![0], /相对R1（末段／尾窗起算）/u);
    const absolute = await locate(body, probe, true);
    assert.equal(absolute.hits[0].roundIndexIsRelative, undefined);
    assert.match(annotateContextLocateCandidates([candidate], absolute)[0].contextProbe![0], /^\[user\] R3 /u);
});
