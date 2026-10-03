import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ConversationRound } from "../src/trajectory.js";
import type { ConversationLoadResult } from "../src/conversation-bridge.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-search-real-cache-"));
const originalHome = os.homedir;
os.homedir = () => temporary;
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.CODEX_HOME = path.join(temporary, ".codex");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const cache = await import("../src/conversation-source-cache.js");
const { registerConversation } = await import("../src/tools/conversation.js");
const conversationId = "fixture-real-cache";

function round(text: string): ConversationRound {
    return { roundIndex: 1, startStep: 1, endStep: 2, userMessage: text, mediaAttachments: [],
        aiResponses: [{ stepIndex: 2, response: "fixture-assistant-response", thinking: "", toolCalls: [] }],
        toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [] };
}

async function publish(source: string, text: string, refresh = false) {
    const chainUsed = source.startsWith("codex") ? "codex" : "antigravity";
    const snapshot: ConversationLoadResult = { chainUsed, conversationId, rounds: [], roundCount: 1, totalSteps: 2 };
    return cache.readOrBuild({ key: { source, conversationId }, refresh, fingerprint: { size: Buffer.byteLength(text), revision: text },
        build: () => ({ snapshot, rounds: [round(text)] }), getRoundNumber: item => item.roundIndex });
}

let handler: (params: any) => Promise<any> = async () => { throw new Error("tool was not registered"); };
let schema: Record<string, z.ZodTypeAny> = {};
registerConversation({ tool: (_name: string, _description: string, rawSchema: typeof schema, callback: typeof handler) => { schema = rawSchema; handler = callback; } } as any);

async function call(params: Record<string, unknown>): Promise<string> {
    const result = await handler(z.object(schema).parse({ action: "search", conversationId, dataChain: "codex", mode: "exact", query: "summary-original-needle", ...params }));
    return result.content.map((item: { text: string }) => item.text).join("\n");
}

try {
    const summary = await publish("codex:link=summary", "summary-original-needle");
    const omitted = await call({});
    assert.match(omitted, /exact 模式命中 1 处/u);
    assert.match(omitted, /本次原文校验: no/u);
    assert.match(omitted, /请求视图: source=omitted, link=summary/u);
    assert.match(omitted, /实际视图: source=cache, link=summary/u);
    assert.match(omitted, new RegExp(summary.generation));
    assert.equal(fs.existsSync(process.env.CODEX_HOME!), false);
    const defaultRead = await call({ action: "read", startRound: 1, endRound: 1 });
    assert.match(defaultRead, /summary-original-needle/u);
    assert.match(defaultRead, /本次原文校验: no/u);
    const strictAuto = await call({ source: "auto" });
    assert.ok(!strictAuto.includes("exact 模式命中"));
    assert.ok(!strictAuto.includes("未找到匹配"));
    assert.match(strictAuto, /无法|失败|not found|不可用|不存在/iu);
    const fixedStrict = await call({ source: "local", cacheGeneration: summary.generation });
    assert.match(fixedStrict, /cacheGeneration 只能与 source=cache/u);
    const missingView = await call({ link: "reference" });
    assert.match(missingView, /请求的已发布缓存不存在/u);
    assert.match(missingView, /可用缓存视图：[\s\S]*codex\/link=summary/u);
    assert.match(missingView, /dataChain="codex", link="reference", source="auto", background=true/u);
    const reference = await publish("codex:link=reference", "reference-only-needle");
    const referenceSearch = await call({ link: "reference", query: "reference-only-needle" });
    assert.match(referenceSearch, /exact 模式命中 1 处/u);
    assert.match(referenceSearch, new RegExp(reference.generation));
    const referenceZero = await call({ link: "reference" });
    assert.match(referenceZero, /未找到匹配/u);
    assert.match(referenceZero, new RegExp(reference.generation));
    assert.ok(!referenceZero.includes(summary.generation));
    const cachedFetch = await call({ action: "fetch", source: "cache" });
    assert.match(cachedFetch, /临时文件/u);
    assert.match(cachedFetch, new RegExp(summary.generation));
    assert.equal(fs.existsSync(process.env.CODEX_HOME!), false);
    const refreshed = await publish("codex:link=summary", "summary-new-needle", true);
    assert.notEqual(refreshed.generation, summary.generation);
    const oldSearch = await call({ source: "cache", cacheGeneration: summary.generation });
    assert.match(oldSearch, /exact 模式命中 1 处/u);
    assert.match(oldSearch, new RegExp(summary.generation));
    const oldRead = await call({ action: "read", source: "cache", cacheGeneration: summary.generation, startRound: 1, endRound: 1 });
    assert.match(oldRead, /summary-original-needle/u);
    assert.ok(!oldRead.includes("summary-new-needle"));
    const latestZero = await call({});
    assert.match(latestZero, /未找到匹配/u);
    assert.match(latestZero, new RegExp(refreshed.generation));
    const unavailableGeneration = await call({ source: "cache", cacheGeneration: "missing-generation" });
    assert.match(unavailableGeneration, /不存在或该 generation 已清理/u);
    assert.match(unavailableGeneration, /generation=missing-generation/u);
    assert.match(unavailableGeneration, /恢复调用/u);
    await publish("antigravity", "other-source-needle");
    assert.match(await call({ dataChain: "auto" }), /多个 fetch 缓存中命中/u);

    const key = { source: "codex:link=summary", conversationId };
    const directory = cache.getConversationSourceCacheEntryDirectory(key);
    const manifestPath = path.join(directory, `manifest.${summary.generation}.json`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const roundsPath = path.join(directory, manifest.files.rounds.file);
    const bytes = fs.readFileSync(roundsPath);
    const position = bytes.indexOf(Buffer.from("summary-original-needle"));
    assert.ok(position >= 0);
    bytes[position] = "S".charCodeAt(0);
    fs.writeFileSync(roundsPath, bytes);
    const corruptSearch = await call({ source: "cache", cacheGeneration: summary.generation });
    assert.match(corruptSearch, /缺失或损坏|缓存损坏/u);
    assert.ok(!corruptSearch.includes("未找到匹配"));
    const corruptRead = await call({ action: "read", query: undefined, source: "cache", cacheGeneration: summary.generation, startRound: 1, endRound: 1 });
    assert.match(corruptRead, /缺失或损坏|缓存损坏/u);
    assert.ok(!corruptRead.includes("summary-original-needle"));
    console.log("conversation-search-cache: PASS unmocked bridge/schema/omitted source/no raw store/view isolation/cache fetch/generation/auto uniqueness/corruption");
} finally {
    os.homedir = originalHome;
    cache.resetConversationSourceCacheForTests();
    cache.setConversationSourceCacheDataRootForTests(null);
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true });
}
