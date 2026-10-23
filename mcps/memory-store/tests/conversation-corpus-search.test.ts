import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, after } from "node:test";
import type { CorpusMessage, CorpusProjection, CorpusSearchRequest } from "../src/conversation-corpus-types.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-search-test-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const { searchCorpusProjection, CorpusSearchAccumulator, sortCorpusMatches, compileCorpusSearch } = await import("../src/conversation-corpus-search.js");
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

function message(text: string, round = 1, id = `message-${round}`, extra: Partial<CorpusMessage> = {}): CorpusMessage {
    return { id, round, role: "user", text, timestamp: "2026-01-01T00:00:00Z", position: { ordinal: round, messageId: id }, ...extra };
}

function projection(messages: CorpusMessage[], id = "conversation-a"): CorpusProjection {
    return {
        conversation: { id, title: id, workspace: "C:/projects/demo", source: "codex", updatedAt: "2026-12-01T00:00:00Z" },
        revision: "source-v1", cacheGeneration: "cache-v1", messages, complete: true, warnings: [],
    };
}

test("literal short Chinese, English, punctuation and nonoverlapping counts", () => {
    const result = searchCorpusProjection(projection([message("缓存缓存，a.b A.B aaa Cache CACHE")]), { anyTerms: ["缓存", "a.b", "aa", "cache"] })!;
    assert.deepEqual(result.termCounts, { "缓存": 2, "a.b": 2, aa: 1, cache: 2 });
    assert.equal(result.occurrences, 7);
    assert.equal(result.matchedMessages, 1);
    assert.equal(searchCorpusProjection(projection([message("axb")]), { query: "a.b" }), null);
    assert.equal(searchCorpusProjection(projection([message("CACHE cache")]), { query: "cache", caseSensitive: true })!.occurrences, 1);
});

test("conversation, normalized round and individual message intersection", () => {
    const different = projection([message("alpha", 1, "one"), message("beta", 2, "two")]);
    const request = { allTerms: ["alpha", "beta"] };
    assert.equal(searchCorpusProjection(different, request)!.matchedMessages, 2);
    assert.equal(searchCorpusProjection(different, { ...request, intersectionScope: "round" }), null);
    const sameRound = projection([message("alpha", 1, "one"), message("beta", 1, "two")]);
    assert.deepEqual(searchCorpusProjection(sameRound, { ...request, intersectionScope: "round" })!.rounds, [1]);
    assert.equal(searchCorpusProjection(sameRound, { ...request, intersectionScope: "message" }), null);
    assert.equal(searchCorpusProjection(projection([message("alpha beta")]), { ...request, intersectionScope: "message" })!.matchedMessages, 1);
});

test("boolean trees and exclusions are evaluated at the requested scope", () => {
    const input = projection([message("alpha beta", 1, "one"), message("alpha veto", 2, "two"), message("gamma", 3, "three")]);
    const request: CorpusSearchRequest = { expression: { all: [{ any: [{ term: "alpha" }, { term: "gamma" }] }, { not: { term: "veto" } }] } };
    assert.equal(searchCorpusProjection(input, request), null);
    const round = searchCorpusProjection(input, { ...request, intersectionScope: "round" })!;
    assert.deepEqual(round.rounds, [1, 3]);
    assert.deepEqual(round.termCounts, { alpha: 1, gamma: 1, veto: 0 });
    const onlyOne = searchCorpusProjection(input, { query: "alpha", excludeTerms: ["veto"], intersectionScope: "message" })!;
    assert.equal(onlyOne.occurrences, 1);
    assert.deepEqual(onlyOne.rounds, [1]);
    assert.ok(searchCorpusProjection(input, { expression: { not: { not: { term: "gamma" } } } }));
});

test("mirror identity is deduplicated while genuine repeated text remains", () => {
    const repeated = message("缓存缓存", 1, "one");
    const result = searchCorpusProjection(projection([repeated, { ...repeated }, message("缓存缓存", 2, "two")]), { query: "缓存" })!;
    assert.equal(result.occurrences, 4);
    assert.equal(result.matchedMessages, 2);
    assert.deepEqual(result.rounds, [1, 2]);
    const accumulator = new CorpusSearchAccumulator(projection([]).conversation, { query: "缓存" }, { revision: "one" });
    accumulator.append(repeated);
    accumulator.append(repeated);
    assert.equal(accumulator.scannedMessages, 1);
    assert.equal(accumulator.mirrorMessagesSkipped, 1);
});

test("default roles keep tools and subagents separate", () => {
    const input = projection([message("cache", 1, "one", { role: "assistant" }), message("cache", 2, "two", { role: "tool" }), message("cache", 3, "three", { role: "subagent" })]);
    assert.equal(searchCorpusProjection(input, { query: "cache" })!.occurrences, 1);
    assert.equal(searchCorpusProjection(input, { query: "cache", messageRoles: ["tool", "subagent"] })!.occurrences, 2);
});

test("provisional hit is retracted when a later exclusion appears", () => {
    const accumulator = new CorpusSearchAccumulator(projection([]).conversation, { query: "allow", excludeTerms: ["veto"] }, { revision: "one" });
    accumulator.append(message("allow", 1, "one"));
    assert.equal(accumulator.snapshot()!.provisional, true);
    accumulator.append(message("veto", 2, "two"));
    assert.equal(accumulator.snapshot(true), null);
});

test("tail replacement removes old counts, IDs, exclusions and latest timestamps", () => {
    const accumulator = new CorpusSearchAccumulator(projection([]).conversation, { query: "cache", excludeTerms: ["veto"] }, { revision: "v1" });
    accumulator.append(message("cache", 1, "head"));
    accumulator.append(message("cache", 1, "head"));
    accumulator.append(message("cache cache veto", 2, "tail", { timestamp: "2026-02-01T00:00:00Z" }));
    accumulator.append(message("cache cache veto", 2, "tail"));
    assert.equal(accumulator.mirrorMessagesSkipped, 2);
    assert.equal(accumulator.snapshot(), null);
    accumulator.replaceFromRound(2, [message("cache", 2, "tail", { timestamp: "2026-01-02T00:00:00Z" })], { revision: "v2", cacheGeneration: "generation-two" });
    const result = accumulator.snapshot(true)!;
    assert.equal(result.occurrences, 2);
    assert.equal(result.matchedMessages, 2);
    assert.equal(accumulator.scannedMessages, 2);
    assert.equal(accumulator.mirrorMessagesSkipped, 1);
    assert.equal(result.latestMatchAt, "2026-01-02T00:00:00Z");
    assert.equal(result.revision, "v2");
    assert.equal(result.sourceRevision, "v2");
    assert.equal(result.round, 1);
    assert.ok(result.snippets.every(snippet => snippet.sourceRevision === "v2"));
    accumulator.replaceFromRound(2, []);
    assert.equal(accumulator.snapshot()!.occurrences, 1);
    assert.throws(() => accumulator.replaceFromRound(2, [message("cache", 1)]), /before/);
});

test("latest match uses original message timestamps and unknown remains null", () => {
    const olderChat = projection([message("hit", 1, "one", { timestamp: "2026-02-02T00:00:00Z" })], "b");
    olderChat.conversation.updatedAt = "2026-02-03T00:00:00Z";
    const activeChat = projection([message("hit", 1, "one", { timestamp: "2026-01-01T00:00:00Z" })], "a");
    const unknown = searchCorpusProjection(projection([message("hit", 1, "one", { timestamp: undefined })], "c"), { query: "hit" })!;
    assert.equal(unknown.latestMatchAt, null);
    assert.equal(unknown.latestMatchTimeSource, "unknown");
    const results = [searchCorpusProjection(activeChat, { query: "hit" })!, unknown, searchCorpusProjection(olderChat, { query: "hit" })!];
    assert.deepEqual(sortCorpusMatches(results).map(result => result.conversation.id), ["b", "a", "c"]);
    assert.equal(sortCorpusMatches(results, "activity")[0].conversation.id, "a");
});

test("sort modes and stable ties", () => {
    const first = searchCorpusProjection(projection([message("hit hit hit")], "b"), { query: "hit" })!;
    const second = searchCorpusProjection(projection([message("hit", 1, "one"), message("hit", 2, "two")], "a"), { query: "hit" })!;
    assert.deepEqual(sortCorpusMatches([first, second], "occurrences").map(item => item.conversation.id), ["b", "a"]);
    assert.deepEqual(sortCorpusMatches([first, second], "messages").map(item => item.conversation.id), ["a", "b"]);
    assert.deepEqual(sortCorpusMatches([first, second]).map(item => item.conversation.id), ["a", "b"]);
});

test("scope reuses canonical workspace paths and IDs", () => {
    const input = projection([message("cache")]);
    assert.ok(searchCorpusProjection(input, { query: "cache", workspaces: ["c:\\PROJECTS\\DEMO\\"], workspaceMode: "exact" }));
    assert.ok(searchCorpusProjection(input, { query: "cache", workspaces: ["C:/projects"], workspaceMode: "under" }));
    assert.equal(searchCorpusProjection(input, { query: "cache", workspaces: ["C:/projects/demography"] }), null);
    assert.equal(searchCorpusProjection(input, { query: "cache", conversationIds: ["other"] }), null);
});

test("snippet offsets stay in original Unicode text with provenance", () => {
    const text = "İ 😀 CACHE 缓存";
    const input = projection([message(text)]);
    const snippet = searchCorpusProjection(input, { query: "cache" })!.snippets[0];
    assert.equal(text.slice(snippet.matchStart, snippet.matchEnd), "CACHE");
    assert.equal(snippet.text, text.slice(snippet.snippetStart, snippet.snippetEnd));
    assert.equal(snippet.revision, "source-v1");
    assert.equal(snippet.sourceRevision, "source-v1");
    assert.equal(snippet.cacheGeneration, "cache-v1");
    assert.deepEqual(snippet.position, { ordinal: 1, messageId: "message-1" });
});

test("malformed expressions, roles and empty queries fail explicitly", () => {
    for (const request of [{}, { query: " " }, { expression: { all: [] } }, { expression: { term: "a", not: { term: "b" } } }, { query: "a", messageRoles: [] }]) {
        assert.throws(() => compileCorpusSearch(request as CorpusSearchRequest));
    }
    assert.ok(searchCorpusProjection(projection([message("safe")]), { excludeTerms: ["veto"] }));
    const input = projection([message("cache")]);
    input.complete = false;
    input.warnings = ["Source coverage is partial"];
    assert.equal(searchCorpusProjection(input, { query: "cache" })!.provisional, true);
    assert.deepEqual(searchCorpusProjection(input, { query: "cache" })!.warnings, input.warnings);
});

test("long literal matches keep bounded snippets and exact original offsets", () => {
    const term = "中".repeat(10000);
    const result = searchCorpusProjection(projection([message(`prefix ${term} suffix`)]), { query: term })!;
    assert.equal(result.occurrences, 1);
    assert.ok(result.snippets[0].text.length <= 180);
    assert.equal(result.snippets[0].matchEnd - result.snippets[0].matchStart, 10000);
});

test("Unicode literal conditions retain distinct regex identities and counts", () => {
    const input = projection([message("\u0130")]);
    assert.equal(searchCorpusProjection(input, { allTerms: ["\u0130", "i\u0307"] }), null);
    assert.deepEqual(searchCorpusProjection(input, { query: "\u0130", excludeTerms: ["i\u0307"] })!.termCounts, { "\u0130": 1, "i\u0307": 0 });
    assert.deepEqual(searchCorpusProjection(projection([message("\u0130 i\u0307")]), { allTerms: ["\u0130", "i\u0307"] })!.termCounts,
        { "\u0130": 1, "i\u0307": 1 });
});

test("negative branches retain satisfying messages, rounds and latest timestamps separately from snippets", () => {
    const input = projection([message("safe", 1, "one"), message("needle", 2, "two", { timestamp: "2026-01-02T00:00:00Z" })]);
    for (const intersectionScope of ["message", "round", "conversation"] as const) {
        const mixed = searchCorpusProjection(input, { expression: { any: [{ term: "needle" }, { not: { term: "veto" } }] }, intersectionScope })!;
        assert.deepEqual(mixed.rounds, [1, 2]);
        assert.equal(mixed.matchedMessages, 2);
        assert.equal(mixed.latestMatchAt, "2026-01-02T00:00:00Z");
        assert.equal(mixed.snippets.length, 1);
        const pure = searchCorpusProjection(input, { excludeTerms: ["veto"], intersectionScope })!;
        assert.deepEqual(pure.rounds, [1, 2]);
        assert.equal(pure.matchedMessages, 2);
        assert.equal(pure.latestMatchAt, "2026-01-02T00:00:00Z");
        assert.deepEqual(pure.snippets, []);
    }
});
