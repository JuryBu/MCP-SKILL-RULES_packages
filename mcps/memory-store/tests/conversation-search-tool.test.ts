import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ConversationRound } from "../src/trajectory.js";
import type { ConversationLoadResult, loadConversationData } from "../src/conversation-bridge.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-search-tool-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const { registerConversation } = await import("../src/tools/conversation.js");
const cache = await import("../src/conversation-source-cache.js");

function round(roundIndex: number, userMessage: string, response = ""): ConversationRound {
    return { roundIndex, startStep: roundIndex * 3, endStep: roundIndex * 3 + 2, userMessage, mediaAttachments: [],
        aiResponses: response ? [{ stepIndex: roundIndex * 3 + 1, response, thinking: "", toolCalls: [] }] : [],
        toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [] };
}

let handler: (params: any) => Promise<any> = async () => { throw new Error("tool was not registered"); };
let schema: Record<string, z.ZodTypeAny> = {};
let activeLoaded: ConversationLoadResult | null = { chainUsed: "codex", conversationId: "fixture-tool", totalSteps: 9, roundCount: 3,
    rounds: [round(1, "outside needle", "assistant-only-secret"), round(2, "target needle " + "字".repeat(30_000), "assistant-only-secret"), round(3, "outside needle")] };
const loads: Array<{ chain: string; conversationId?: string; options: Parameters<typeof loadConversationData>[2] }> = [];
let estimates = 0;
let loader: typeof loadConversationData = async (chain = "auto", conversationId, options) => {
    loads.push({ chain, conversationId, options });
    return activeLoaded;
};
registerConversation({ tool: (_name: string, _description: string, rawSchema: typeof schema, callback: typeof handler) => { schema = rawSchema; handler = callback; } } as any,
    { loadConversation: (...args) => loader(...args), resolveFetchChain: async () => "codex",
        estimateCodexFetchWork: async () => { estimates += 1; return null; } });

async function call(params: Record<string, unknown>): Promise<string> {
    const result = await handler(z.object(schema).parse({ action: "search", conversationId: "fixture-tool", dataChain: "codex", mode: "exact", ...params }));
    return result.content.map((item: { text: string }) => item.text).join("\n");
}

try {
    assert.equal(schema.source.parse(undefined), undefined);
    assert.equal(schema.contextRounds.parse(undefined), undefined);
    assert.equal(schema.limit.parse(undefined), undefined);
    assert.equal(schema.source.parse("auto"), "auto");
    const text = await call({ query: "needle", messageRoles: ["user"], startRound: 2, endRound: 2, maxHits: 1 });
    assert.match(text, /exact 模式命中 1 处/u);
    assert.match(text, /轮次 2 · user/u);
    assert.ok(text.length < 2_500);
    assert.ok(!text.includes("assistant-only-secret"));
    assert.ok(!text.includes("轮次 1 ·") && !text.includes("轮次 3 ·"));
    assert.equal(loads.at(-1)?.options?.publishedCacheOnly, true);
    assert.equal(loads.at(-1)?.options?.source, "auto");
    await call({ query: "needle", source: "auto" });
    assert.equal(loads.at(-1)?.options?.publishedCacheOnly, false);
    await call({ query: "needle", source: "local" });
    assert.equal(loads.at(-1)?.options?.publishedCacheOnly, false);
    await call({ query: "needle", dataChain: "antigravity" });
    assert.equal(loads.at(-1)?.options?.publishedCacheOnly, false);
    activeLoaded!.chainUsed = "antigravity";
    const beforeAutomaticOtherSource = loads.length;
    await call({ query: "needle", dataChain: "auto" });
    assert.equal(loads.length, beforeAutomaticOtherSource + 2);
    assert.equal(loads[beforeAutomaticOtherSource].options?.publishedCacheOnly, true);
    assert.equal(loads.at(-1)?.chain, "antigravity");
    assert.equal(loads.at(-1)?.options?.publishedCacheOnly, false);
    activeLoaded!.chainUsed = "codex";
    const beforeConflict = loads.length;
    assert.match(await call({ query: "needle", limit: 1, maxHits: 2 }), /limit 与 maxHits 冲突/u);
    assert.equal(loads.length, beforeConflict);
    const zero = await call({ query: "missing-token", messageRoles: ["user"] });
    assert.match(zero, /未找到匹配/u);
    assert.match(zero, /cacheGeneration: unknown/u);
    assert.match(zero, /createdAt: unknown \| age: unknown/u);
    assert.match(zero, /本次原文校验: unknown/u);
    const context = await call({ query: "needle", startRound: 2, endRound: 2, messageRoles: ["user"], contextRounds: 2, maxHits: 1 });
    assert.match(context, /轮次 2 \(steps/u);
    assert.ok(!context.includes("assistant-only-secret"));
    assert.ok(!context.includes("轮次 1 (steps") && !context.includes("轮次 3 (steps"));
    const fuzzy = await call({ mode: "fuzzy", query: "target", startRound: 2, endRound: 2, messageRoles: ["user"], limit: 1 });
    assert.match(fuzzy, /fuzzy 模式命中 1 处/u);
    assert.ok(!fuzzy.includes("assistant-only-secret"));
    const fuzzyExcluded = await call({ mode: "fuzzy", query: "assistant-only-secret", startRound: 2, endRound: 2, messageRoles: ["user"] });
    assert.match(fuzzyExcluded, /未找到匹配/u);
    activeLoaded!.rounds[1].userMessage += "\nFUZZY_BEYOND_EIGHT_K_NEEDLE";
    const fuzzyTail = await call({ mode: "fuzzy", query: "FUZZY_BEYOND_EIGHT_K_NEEDLE", startRound: 2, endRound: 2, messageRoles: ["user"], maxHits: 1 });
    assert.match(fuzzyTail, /fuzzy 模式命中 1 处/u);
    assert.match(fuzzyTail, /FUZZY_BEYOND_EIGHT_K_NEEDLE/u);
    const smartExcluded = await call({ mode: "smart", query: "unrelated", startRound: 2, endRound: 2, messageRoles: ["subagent"] });
    assert.match(smartExcluded, /未找到匹配/u);
    activeLoaded!.rounds[1].userMessage += "字".repeat(250_000);
    const smartLarge = await call({ mode: "smart", query: "unrelated", startRound: 2, endRound: 2, messageRoles: ["user"] });
    assert.match(smartLarge, /smart 暂不支持超过 128 个完整正文分片/u);

    activeLoaded = { ...activeLoaded!, rounds: [round(2, "Annotation wrapper")], roundCount: 2 };
    activeLoaded.rounds[0].userMessages = [{ text: "Annotation wrapper", annotations: [{ selectedText: "selection-not-matched " + "选".repeat(20_000),
        comment: "annotation-comment-needle " + "评".repeat(20_000) }] }];
    const annotation = await call({ query: "annotation-comment-needle", messageRoles: ["user"] });
    assert.match(annotation, /命中字段: 用户评论/u);
    assert.ok(!annotation.includes("selection-not-matched"));
    assert.ok(annotation.length < 2_500);
    const fuzzyAnnotation = await call({ mode: "fuzzy", query: "annotation-comment-needle", messageRoles: ["user"], maxHits: 1 });
    assert.match(fuzzyAnnotation, /Annotation 1 · 命中字段: 用户评论/u);
    assert.ok(!fuzzyAnnotation.includes("selection-not-matched"));

    activeLoaded = { ...activeLoaded!, cacheState: "stale", cacheGeneration: "fixture-old-generation", cacheBuildFailure: { name: "FixtureFailure", message: "source changed" } };
    assert.match(await call({ query: "needle", source: "auto" }), /严格原文校验或 fetch 失败/u);
    assert.match(await call({ action: "fetch", source: "cache" }), /上一份完整缓存仍保留/u);
    assert.equal(estimates, 0);
    assert.match(await call({ action: "fetch" }), /严格原文校验或 fetch 失败/u);
    assert.equal(estimates, 1);
    assert.equal(loads.at(-1)?.options?.source, "auto");
    assert.equal(loads.at(-1)?.options?.publishedCacheOnly, false);
    activeLoaded = null;
    const missing = await call({ query: "needle", link: "reference", cacheGeneration: "fixture-missing-generation" });
    assert.match(missing, /已发布缓存不存在|已发布缓存损坏/u);
    assert.match(missing, /link=reference/u);
    assert.match(missing, /恢复调用：conversation_read_original\(action="fetch"/u);
    assert.equal(loads.at(-1)?.options?.cacheGeneration, "fixture-missing-generation");
    assert.equal(loads.at(-1)?.options?.link, "reference");
    const estimatesBeforeCachedFetch = estimates;
    await call({ action: "fetch", source: "cache" });
    assert.equal(estimates, estimatesBeforeCachedFetch);
    assert.equal(loads.at(-1)?.options?.source, "cache");
    assert.equal(loads.at(-1)?.options?.publishedCacheOnly, false);

    cache.setConversationSourceCacheDataRootForTests(path.join(temporary, "cache-data"));
    const key = { source: "codex:link=summary", conversationId: "fixture-tool" };
    const originalRounds = [round(1, "fixed-generation-body\n" + "长段😀\n".repeat(25_000)), round(2, "old-generation-ending")];
    const snapshot: ConversationLoadResult = { chainUsed: "codex", conversationId: "fixture-tool", rounds: [], roundCount: 2, totalSteps: 6 };
    const original = await cache.readOrBuild({ key, fingerprint: { size: 100, revision: "old" }, build: () => ({ snapshot, rounds: originalRounds }), getRoundNumber: item => item.roundIndex });
    loader = async (chain = "auto", conversationId, options) => {
        loads.push({ chain, conversationId, options });
        const cached = cache.readConversationSourceCacheOnly<ConversationLoadResult>({ key, generation: options?.cacheGeneration });
        return cached ? { ...cached.snapshot, cacheKey: key, cacheGeneration: cached.generation, cacheCreatedAt: cached.createdAt,
            cacheState: "hit", cacheReadPolicy: "published", sourceMode: "cache" } : null;
    };
    const cacheSearch = await call({ query: "old-generation-ending", source: "cache" });
    const readHint = cacheSearch.split("\n").find(line => line.startsWith('{"action":"read"'))!;
    const readParams = JSON.parse(readHint);
    assert.equal(readParams.cacheGeneration, original.generation);
    assert.equal(readParams.source, "cache");
    assert.equal(readParams.link, "summary");
    assert.match(await call(readParams), /old-generation-ending/u);
    const firstPage = await call({ action: "read", startRound: 1, endRound: 2, depth: "full", maxBytes: 8_192 });
    assert.match(firstPage, new RegExp(original.generation));
    assert.match(firstPage, /本次原文校验: no/u);
    assert.ok(Buffer.byteLength(firstPage, "utf8") <= 8_192);
    const nextLine = firstPage.split("\n").find(line => line.startsWith('{"action":"read"') && line.includes("continuationCursor"))!;
    const next = JSON.parse(nextLine);
    assert.equal(next.source, "cache");
    assert.equal(next.link, "summary");
    assert.equal(next.cacheGeneration, original.generation);
    const replacement = await cache.readOrBuild({ key, refresh: true, fingerprint: { size: 101, revision: "new" },
        build: () => ({ snapshot, rounds: [round(1, "replacement-only-body"), round(2, "new-generation-ending")] }), getRoundNumber: item => item.roundIndex });
    assert.notEqual(original.generation, replacement.generation);
    const originalNow = Date.now;
    let nextPage: string;
    try {
        Date.now = () => originalNow() + 60_000;
        nextPage = await call(next);
    } finally {
        Date.now = originalNow;
    }
    assert.ok(!nextPage.includes("source changed; restart"));
    assert.ok(!nextPage.includes("replacement-only-body"));
    assert.match(nextPage, new RegExp(original.generation));
    assert.match(nextPage, /本次原文校验: no/u);
    assert.equal(loads.at(-1)?.options?.cacheGeneration, original.generation);
    assert.match(await call({ action: "read", source: "cache", cacheGeneration: "missing-generation", startRound: 1 }), /恢复调用/u);
    console.log("conversation-search-tool: PASS schema/source explicitness/filters/short excerpts/fuzzy/cache diagnostics/fixed generation/continuation");
} finally {
    cache.resetConversationSourceCacheForTests();
    cache.setConversationSourceCacheDataRootForTests(null);
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true });
}
