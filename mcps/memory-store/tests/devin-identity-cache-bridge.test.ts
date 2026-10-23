import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "devin-identity-cache-bridge-"));
const dataRoot = path.join(directory, "data");
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
const alias = "11111111-2222-4333-8444-555555555555";
const canonical = "fixture-falcon";
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const mappingDirectory = path.join(dataRoot, "conversation-cache", "devin-identities");
fs.mkdirSync(mappingDirectory, { recursive: true });
fs.writeFileSync(path.join(mappingDirectory, `${hash(alias)}.json`), JSON.stringify({ version: 1, alias, canonicalId: canonical, legacyReadIds: [alias] }));
fs.writeFileSync(path.join(mappingDirectory, `${hash(canonical)}.json`), JSON.stringify({ version: 1, alias: canonical, canonicalId: canonical }));
const { readOrBuildConversationSourceCache } = await import("../src/conversation-source-cache.js");
const { loadConversationData } = await import("../src/conversation-bridge.js");

function round(text: string) {
    return { roundIndex: 1, userMessage: text, aiResponses: [], toolCalls: [] };
}

try {
    const oldKey = { source: "windsurf", conversationId: alias };
    const canonicalKey = { source: "windsurf", conversationId: canonical };
    const oldRounds = [round("retained alias body")];
    const canonicalRounds = [round("canonical body")];
    const oldCache = await readOrBuildConversationSourceCache({ key: oldKey, fingerprint: { revision: "old" }, build: () => ({
        snapshot: { chainUsed: "windsurf", conversationId: alias, rounds: oldRounds, totalSteps: 1 }, rounds: oldRounds,
    }) });
    const canonicalCache = await readOrBuildConversationSourceCache({ key: canonicalKey, fingerprint: { revision: "canonical" }, build: () => ({
        snapshot: { chainUsed: "windsurf", conversationId: canonical, rounds: canonicalRounds, totalSteps: 1 }, rounds: canonicalRounds,
    }) });
    for (const requested of [alias, canonical]) {
        const old = await loadConversationData("windsurf", requested, { source: "cache", cacheGeneration: oldCache.generation });
        assert.equal(old?.conversationId, alias);
        assert.equal(old?.cacheKey?.conversationId, alias);
        assert.equal(old?.cacheGeneration, oldCache.generation);
        assert.equal(old?.rounds[0].userMessage, "retained alias body");
        const current = await loadConversationData("windsurf", requested, { source: "cache", cacheGeneration: canonicalCache.generation });
        assert.equal(current?.conversationId, canonical);
        assert.equal(current?.cacheGeneration, canonicalCache.generation);
        assert.equal(current?.rounds[0].userMessage, "canonical body");
    }
    const current = await loadConversationData("windsurf", alias, { source: "cache" });
    assert.equal(current?.conversationId, canonical);
    assert.equal(current?.cacheGeneration, canonicalCache.generation);
    assert.equal(await loadConversationData("windsurf", canonical, { source: "cache", cacheGeneration: "unrelated-generation" }), null);
    console.log("PASS canonical default and exact retained alias generation through real cache-only bridge");
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
