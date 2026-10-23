import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readCodexRoundTail } from "../src/codex-client.ts";
import { normalizeCodexCacheCheckpoints } from "../src/conversation-bridge.ts";
import { mergeConsecutiveHumanRounds } from "../src/trajectory.ts";
import { resolveCodexHistorySourceAsync } from "../src/codex-history-source.ts";
import { readOrBuildConversationSourceCache, resetConversationSourceCacheForTests, setConversationSourceCacheDataRootForTests } from "../src/conversation-source-cache.ts";
import { projectConversationRoundForRecord } from "../src/conversation-record-projection.ts";
import { readLegacyCodexCorpus } from "../src/conversation-corpus-reader-legacy.ts";
import { createCodexCorpusProvider } from "../src/conversation-corpus-reader-codex.ts";
import { readCodexCorpusCache } from "../src/conversation-corpus-reader-cache.ts";

test("legacy canonical range reads equal full conversion without publishing a partial body cache", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-legacy-range-"));
    const codexHome = path.join(directory, "home");
    const sessions = path.join(codexHome, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const id = "10000000-0000-4000-8000-000000000059";
    const rolloutPath = path.join(sessions, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
    let ordinal = 0;
    const append = (type: string, payload: object) => fs.appendFileSync(rolloutPath, JSON.stringify({ ordinal: ordinal++, type, payload }) + "\n");
    const user = (text: string) => append("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
    const assistant = (text: string) => append("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
    const conversation = { id, title: id, rolloutPath, workspace: directory, source: "codex" as const };
    try {
        append("session_meta", { id, cwd: directory });
        for (const round of [1, 2, 3]) { user(`question ${round}`); assistant(`answer ${round}`); }
        const raw = await readCodexRoundTail(rolloutPath, "summary");
        const rounds = mergeConsecutiveHumanRounds(raw.rounds, raw.replaceFromRound);
        const normalized = normalizeCodexCacheCheckpoints({ sourceCheckpoints: raw.sourceCheckpoints, sourceCheckpoint: raw.checkpoint }, rounds.map(round => ({ roundIndex: round.roundIndex, sourceRoundIndices: round.legacyRoundIndices || [round.roundIndex], startStep: round.startStep })));
        assert.equal(normalized.sourceCheckpoint?.roundIndexSpace, "normalized-cache-v1");
        const history = await resolveCodexHistorySourceAsync(rolloutPath, { roots: [sessions] });
        setConversationSourceCacheDataRootForTests(path.join(directory, "published"));
        await readOrBuildConversationSourceCache({ key: { source: "codex:link=summary", conversationId: id }, fingerprint: { revision: history.revision }, build: () => ({ snapshot: { codexData: { historySource: history, ...normalized } }, rounds }), projectRecordRound: projectConversationRoundForRecord });
        user("question 4"); assistant("answer 4");
        const full = await readLegacyCodexCorpus(conversation, {}, { roots: [sessions] });
        assert.ok(full, JSON.stringify({ checkpoint: normalized.sourceCheckpoint, leaf: history.segments.at(-1), roundStarts: rounds.map(round => round.startStep) }));
        assert.equal(full?.projection.timings?.legacyRoundCount, 4);
        for (const request of [{ startRound: 2, endRound: 2 }, { lastRounds: 2 }]) {
            const selected = await readLegacyCodexCorpus(conversation, {}, { roots: [sessions] }, request);
            assert.equal(selected?.projection.complete, false);
            assert.equal(selected?.projection.requestedRangeComplete, true);
            assert.equal(selected?.projection.revision, full!.projection.revision);
            const expected = full!.projection.messages.filter(message => "lastRounds" in request ? message.round >= 3 : message.round === 2);
            assert.deepEqual(selected?.projection.messages, expected);
        }
        const cacheRoot = path.join(directory, "body");
        const provider = createCodexCorpusProvider({ codexHome, cacheRoot, listThreads: async () => [] });
        const fast = await provider.readFast(conversation, { lastRounds: 2 });
        assert.deepEqual(fast.messages.map(message => message.round), [3, 3, 4, 4]);
        assert.equal(await readCodexCorpusCache(cacheRoot, id, {}), null);
        const second = await provider.readFast(conversation, { startRound: 2 });
        assert.ok(second.messages.every(message => message.round === 2));
        await assert.rejects(provider.readFast(conversation, { startRound: 5 }), /exceeds the available canonical rounds/u);
        const unmarked = { ...normalized.sourceCheckpoint!, roundIndexSpace: undefined };
        await readOrBuildConversationSourceCache({ key: { source: "codex:link=summary", conversationId: id }, fingerprint: { revision: `${history.revision}:unmarked` }, build: () => ({ snapshot: { codexData: { historySource: history, sourceCheckpoint: unmarked } }, rounds }), projectRecordRound: projectConversationRoundForRecord });
        const unmarkedFull = await readLegacyCodexCorpus(conversation, {}, { roots: [sessions] });
        const unmarkedRange = await readLegacyCodexCorpus(conversation, {}, { roots: [sessions] }, { lastRounds: 2 });
        assert.equal(unmarkedRange?.projection.complete, false);
        assert.deepEqual(unmarkedRange?.projection.messages, unmarkedFull!.projection.messages.filter(message => message.round >= 3));
        fs.writeFileSync(rolloutPath, fs.readFileSync(rolloutPath, "utf8").replace("question 1", "question X"));
        await assert.rejects(provider.readFast(conversation, { lastRounds: 2 }), /cached prefix changed/u);
    } finally {
        resetConversationSourceCacheForTests();
        setConversationSourceCacheDataRootForTests(undefined);
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
