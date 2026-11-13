import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-antigravity-local-bridge-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(fixtureRoot, "store");
process.env.MEMORY_STORE_ANTIGRAVITY_ROOT = path.join(fixtureRoot, "gui");
process.env.MEMORY_STORE_ANTIGRAVITY_CLI_ROOT = path.join(fixtureRoot, "cli");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
const { loadConversationData, resolveConversationChain } = await import("../src/conversation-bridge.js");
const { createProductionSourceReader } = await import("../src/record-production-source-readers.js");
const { assertConversationConsumerSourceComplete } = await import("../src/devin-source-evidence.js");
const id = "11111111-2222-4333-8444-555555555555";
const logs = path.join(process.env.MEMORY_STORE_ANTIGRAVITY_ROOT, "brain", id, ".system_generated", "logs");

try {
    fs.mkdirSync(logs, { recursive: true });
    const records = [
        { step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>保留完整本地请求</USER_REQUEST>", created_at: "2026-11-13T00:00:00Z" },
        { step_index: 1, type: "PLANNER_RESPONSE", content: "本地答复与来源完整保留", created_at: "2026-11-13T00:00:01Z" },
    ];
    fs.writeFileSync(path.join(logs, "transcript_full.jsonl"), records.map(value => JSON.stringify(value)).join("\n") + "\n");
    assert.equal(await resolveConversationChain("antigravity"), "antigravity");
    const loaded = await loadConversationData("antigravity", id, { source: "local" });
    assert.ok(loaded?.cacheKey && loaded.cacheGeneration);
    assert.equal(loaded.sourcePartial, false);
    assert.equal(loaded.sourceCoverage?.complete, true);
    assert.equal(loaded.rounds[0].userMessage, "保留完整本地请求");
    assert.match(JSON.stringify(loaded.rounds), /本地答复与来源完整保留/u);
    const cached = await loadConversationData("antigravity", id, { source: "cache", cacheGeneration: loaded.cacheGeneration });
    assert.deepEqual(cached?.rounds, loaded.rounds);
    const consumer = await createProductionSourceReader().scan({
        host: "antigravity", conversationId: id, workspaceId: "general", workspacePath: null,
        source: { endpoint: "unused-offline", pbRoot: path.join(fixtureRoot, "absent-pb"), vscdbPath: path.join(fixtureRoot, "absent-state.vscdb") },
        cacheGeneration: { key: loaded.cacheKey, generation: loaded.cacheGeneration, fingerprint: loaded.cacheFingerprint },
        sourceSnapshot: { chainUsed: "antigravity", totalSteps: loaded.totalSteps },
    });
    assert.equal(consumer.classification.state, "Present");
    assert.equal(consumer.fullSourceRead.status, "complete");
    const content = Buffer.from(consumer.fullSourceRead.payload!.bytes).toString("utf8");
    assert.match(content, /保留完整本地请求/u);
    assert.doesNotMatch(content, /USER_REQUEST/u);
    assert.throws(() => assertConversationConsumerSourceComplete({ ...loaded, sourcePartial: true }), /partial/u);
    assert.throws(() => assertConversationConsumerSourceComplete({ ...loaded, sourceCoverage: { complete: false } }), /partial/u);
    const raceId = "11111111-2222-4333-8444-555555555556";
    const raceLogs = path.join(process.env.MEMORY_STORE_ANTIGRAVITY_ROOT, "brain", raceId, ".system_generated", "logs");
    fs.mkdirSync(raceLogs, { recursive: true });
    const raceFile = path.join(raceLogs, "transcript_full.jsonl");
    const originalText = records.map(value => JSON.stringify(value)).join("\n") + "\n";
    fs.writeFileSync(raceFile, originalText);
    const originalStat = fs.promises.stat;
    let targetStats = 0;
    fs.promises.stat = (async (...args: Parameters<typeof originalStat>) => {
        const result = await originalStat(...args);
        if (String(args[0]) === raceFile && ++targetStats === 2) fs.writeFileSync(raceFile, originalText.replace("保留完整本地请求", "变化后的真实请求"));
        return result;
    }) as typeof originalStat;
    try {
        await assert.rejects(() => loadConversationData("antigravity", raceId, { source: "local" }), /source changed/u);
        assert.ok(targetStats >= 2);
    } finally { fs.promises.stat = originalStat; }
    console.log("Antigravity local bridge: offline fetch, fixed generation and production Record projection passed");
} finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
