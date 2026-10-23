import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { createCodexCorpusProvider } from "../src/conversation-corpus-reader-codex.ts";
import { readCodexCorpusCache } from "../src/conversation-corpus-reader-cache.ts";
import { readCodexRoundTail } from "../src/codex-client.ts";
import { resolveCodexHistorySourceAsync } from "../src/codex-history-source.ts";
import { mergeConsecutiveHumanRounds } from "../src/trajectory.ts";
import { projectConversationRoundForRecord } from "../src/conversation-record-projection.ts";
import { readOrBuildConversationSourceCache, setConversationSourceCacheDataRootForTests, resetConversationSourceCacheForTests } from "../src/conversation-source-cache.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-legacy-corpus-"));
const home = path.join(temporary, "home");
const sessions = path.join(home, "sessions");
fs.mkdirSync(sessions, { recursive: true });
setConversationSourceCacheDataRootForTests(path.join(temporary, "published"));
const timestamp = "2026-01-01T01:02:03.000Z";
const event = (ordinal: number, role: string, text: string) => ({ ordinal, timestamp, type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
const encode = (events: unknown[]) => Buffer.from(events.map(value => JSON.stringify(value)).join("\n") + "\n");

try {
    for (const compressed of [false, true]) {
        const id = compressed ? "10000000-0000-4000-8000-000000000022" : "10000000-0000-4000-8000-000000000021";
        const baseId = compressed ? "20000000-0000-4000-8000-000000000022" : "20000000-0000-4000-8000-000000000021";
        const base = path.join(sessions, `rollout-2026-01-01T00-00-00-${id}_${baseId}.jsonl`);
        const leaf = path.join(sessions, `rollout-2026-01-02T00-00-00-${id}.jsonl`);
        const baseBytes = encode([{ ordinal: 0, type: "session_meta", payload: { id } }, event(1, "user", "prefix human"), { ordinal: 2, type: "response_item", payload: { type: "function_call", call_id: "fixture-call", name: "fixture_tool", arguments: "{}" } }, { ordinal: 3, type: "response_item", payload: { type: "function_call_output", call_id: "fixture-call", output: "TOOL_SECRET_RESULT" } }, event(4, "assistant", "prefix answer")]);
        const leafBytes = encode([{ ordinal: 5, type: "session_meta", payload: { id, history_base: { thread_id: baseId, end_ordinal_exclusive: 5, end_byte_offset: baseBytes.length } } }, event(6, "user", "old tail human"), event(7, "assistant", "old tail answer")]);
        fs.writeFileSync(base, baseBytes);
        fs.writeFileSync(leaf, leafBytes);
        const historySource = await resolveCodexHistorySourceAsync(leaf, { roots: [sessions] });
        const tail = await readCodexRoundTail(leaf, "summary");
        const baseTail = await readCodexRoundTail(base, "summary");
        const rounds = mergeConsecutiveHumanRounds([...baseTail.rounds, ...tail.rounds.map(round => ({ ...round, roundIndex: round.roundIndex + baseTail.rounds.length, startStep: round.startStep + 5, endStep: round.endStep + 5, userMessages: round.userMessages?.map(message => ({ ...message, stepIndex: message.stepIndex! + 5 })), aiResponses: round.aiResponses.map(response => ({ ...response, stepIndex: response.stepIndex + 5 })), semanticEvents: round.semanticEvents?.map(item => ({ ...item, stepIndex: item.stepIndex! + 5 })) }))]);
        assert.equal(rounds.length, 2);
        const sourceCheckpoint = { ...tail.checkpoint!, replayStartStep: 7, replaceFromRound: 2, replayStartOrdinal: 6 };
        await readOrBuildConversationSourceCache({ key: { source: "codex:link=summary", conversationId: id }, fingerprint: { revision: historySource.revision }, build: () => ({ snapshot: { codexData: { historySource, sourceCheckpoint } }, rounds }), projectRecordRound: projectConversationRoundForRecord });
        fs.appendFileSync(leaf, encode([event(8, "user", "new tail human"), event(9, "assistant", "new tail answer")]));
        if (compressed) {
            fs.writeFileSync(`${base}.zst`, zstdCompressSync(fs.readFileSync(base)));
            fs.unlinkSync(base);
            fs.writeFileSync(`${leaf}.zst`, zstdCompressSync(fs.readFileSync(leaf)));
            fs.unlinkSync(leaf);
        }
        const cacheRoot = path.join(temporary, `body-${compressed}`);
        const provider = createCodexCorpusProvider({ codexHome: home, cacheRoot, listThreads: async () => [] });
        const conversation = { id, source: "codex", title: id, workspace: temporary, rolloutPath: leaf };
        const cancelledRoot = path.join(temporary, `cancelled-${compressed}`);
        const cancelledProvider = createCodexCorpusProvider({ codexHome: home, cacheRoot: cancelledRoot, listThreads: async () => [] });
        let cancelled = false;
        await assert.rejects(cancelledProvider.readFast(conversation, { lastRounds: 1 }, { isCancelled: () => cancelled, onChunk: () => { cancelled = true; } }), { name: "AbortError" });
        assert.equal(await readCodexCorpusCache(cancelledRoot, id, {}), null);
        const recent = await provider.readFast(conversation, { lastRounds: 1 });
        assert.ok(recent.warnings.includes("legacy_cache_body_browsing_only"));
        assert.equal(recent.requestedRangeComplete, true);
        assert.deepEqual(recent.messages.map(message => [message.round, message.text]), [[3, "new tail human"], [3, "new tail answer"]]);
        const legacyTools = await provider.readRounds(conversation, { revision: recent.revision, startRound: 1, endRound: 3, messageRoles: ["tool"] });
        assert.ok(legacyTools.messages.some(message => message.role === "tool" && message.text.includes("TOOL_SECRET_RESULT")));
        const body = await provider.read(conversation, {});
        assert.ok(body.messages.every(message => message.timestamp === timestamp));
        assert.ok(!body.warnings.includes("legacy_cache_body_browsing_only"));
        const tools = await provider.read(conversation, { messageRoles: ["tool"] });
        assert.ok(tools.messages.length > 0 && tools.messages.every(message => message.role === "tool"));
        assert.ok(tools.messages.some(message => message.text.includes("TOOL_SECRET_RESULT")));
        const after = await provider.read(conversation, {});
        assert.equal(after.revision, body.revision);
        assert.deepEqual(after.messages, body.messages);
        const persisted = await readCodexCorpusCache(cacheRoot, id, {});
        assert.ok(persisted?.projection.messages.every(message => message.role !== "tool"));
        assert.doesNotMatch(JSON.stringify(persisted?.projection.messages), /TOOL_SECRET_RESULT/u);
        const toolFirstRoot = path.join(temporary, `tool-first-${compressed}`);
        const toolFirstProvider = createCodexCorpusProvider({ codexHome: home, cacheRoot: toolFirstRoot, listThreads: async () => [] });
        let toolChunks = 0;
        const toolFirst = await toolFirstProvider.read(conversation, { messageRoles: ["tool"], onChunk: async chunk => { assert.ok(chunk.messages.every(message => message.role === "tool")); toolChunks += chunk.messages.length; } });
        assert.equal(toolChunks, toolFirst.messages.length);
        assert.ok(toolFirst.messages.some(message => message.text.includes("TOOL_SECRET_RESULT")));
        assert.equal(await readCodexCorpusCache(toolFirstRoot, id, {}), null);
        const bodySecond = await toolFirstProvider.read(conversation, {});
        assert.deepEqual(bodySecond.messages, body.messages);
        const leafPhysical = compressed ? `${leaf}.zst` : leaf;
        const validLeaf = fs.readFileSync(leafPhysical);
        const rewritten = Buffer.concat([leafBytes, encode([event(8, "user", "new tail human"), event(9, "assistant", "new tail answer")])]).toString("utf8").replace("old tail human", "bad tail human");
        const previousStats = fs.statSync(leafPhysical);
        fs.writeFileSync(leafPhysical, compressed ? zstdCompressSync(Buffer.from(rewritten)) : rewritten);
        fs.utimesSync(leafPhysical, previousStats.atime, previousStats.mtime);
        const rewrittenProvider = createCodexCorpusProvider({ codexHome: home, cacheRoot: path.join(temporary, `rewritten-${compressed}`), listThreads: async () => [] });
        await assert.rejects(rewrittenProvider.readFast(conversation, { lastRounds: 1 }), /cached prefix changed/u);
        fs.writeFileSync(leafPhysical, validLeaf);
    }
    console.log("Codex legacy migration: formal prefix/tail, compressed successor proof, late/last ranges, timestamps and body-tool-body coverage passed");
} finally {
    resetConversationSourceCacheForTests();
    fs.rmSync(temporary, { recursive: true, force: true });
}
