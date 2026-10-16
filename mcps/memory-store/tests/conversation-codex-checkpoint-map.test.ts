import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-checkpoint-map-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_LIFECYCLE_ENABLED = "false";
const { readCodexRoundTail } = await import("../src/codex-client.ts");
const { normalizeCodexCacheCheckpoints, assertCodexCacheCheckpointCompatible } = await import("../src/conversation-bridge.ts");
const { mergeConsecutiveHumanRounds, createConsecutiveHumanRoundMerger } = await import("../src/trajectory.ts");
import type { ConversationRound } from "../src/trajectory.js";
import type { CodexRoundTailCheckpoint, CodexSourceByteCheckpoint } from "../src/codex-client.js";

const rollout = path.join(temporary, "rollout-2026-10-16T00-00-00-11111111-1111-4111-8111-111111111111.jsonl");
let ordinal = 0;
const append = (type: string, payload: object): void => {
    fs.appendFileSync(rollout, `${JSON.stringify({ ordinal: ordinal++, type, payload })}\n`);
};
const user = (text: string): void => append("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistant = (text: string): void => append("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const abort = (): void => append("event_msg", { type: "turn_aborted" });
const normalize = (raw: Awaited<ReturnType<typeof readCodexRoundTail>>) => {
    const rounds = mergeConsecutiveHumanRounds(raw.rounds, raw.replaceFromRound);
    const mapped = normalizeCodexCacheCheckpoints({ sourceCheckpoints: raw.sourceCheckpoints, sourceCheckpoint: raw.checkpoint },
        rounds.map(round => ({ roundIndex: round.roundIndex, sourceRoundIndices: round.legacyRoundIndices || [round.roundIndex], startStep: round.startStep })));
    return { rounds, ...mapped };
};

try {
    append("session_meta", { id: "11111111-1111-4111-8111-111111111111" });
    user("stable first"); assistant("first reply");
    user("merged first"); abort(); user("merged second"); abort(); user("merged third"); assistant("merged reply");
    const initialRaw = await readCodexRoundTail(rollout, "summary");
    const initial = normalize(initialRaw);
    assert.deepEqual(initial.rounds.map(round => round.roundIndex), [1, 2]);
    assert.deepEqual(initial.rounds[1].legacyRoundIndices, [2, 3, 4]);
    assert.equal(initial.sourceCheckpoint?.replaceFromRound, 2);
    assert.equal(initial.sourceCheckpoint?.sourceRoundIndex, 2);
    assert.equal(initial.sourceCheckpoint?.replayStartByte, initialRaw.sourceCheckpoints.find(point => point.kind === "round_start" && point.roundIndex === 2)?.sourceByte);
    const streamed: ConversationRound[] = [];
    const merger = createConsecutiveHumanRoundMerger(round => streamed.push(round));
    for (const round of initialRaw.rounds) merger.append(round);
    merger.finish();
    assert.deepEqual(streamed, initial.rounds);

    let cached = initial.rounds;
    let checkpoint = initial.sourceCheckpoint!;
    let points = initial.sourceCheckpoints!;
    for (const pass of [1, 2]) {
        if (pass === 1) { user("append interrupted"); abort(); user("append completed"); assistant("append reply"); }
        else { user("last append"); assistant("last reply"); }
        const raw = await readCodexRoundTail(rollout, "summary", { checkpoint });
        assert.equal(raw.status, "ok");
        assert.equal(raw.startByte, checkpoint.replayStartByte);
        assert.ok(raw.startByte > 0);
        const tail = normalize(raw);
        cached = [...cached.filter(round => round.roundIndex < raw.replaceFromRound), ...tail.rounds];
        points = [...points.filter(point => point.roundIndex < raw.replaceFromRound), ...tail.sourceCheckpoints!];
        checkpoint = tail.sourceCheckpoint!;
        const full = normalize(await readCodexRoundTail(rollout, "summary"));
        assert.deepEqual(cached, full.rounds, `append ${pass} must match full normalization`);
        assert.deepEqual(checkpoint, full.sourceCheckpoint);
        assert.deepEqual(points, full.sourceCheckpoints);
        assertCodexCacheCheckpointCompatible(checkpoint, { first: 1, last: cached.length }, cached.length, points);
    }
    const bad: CodexRoundTailCheckpoint = { ...checkpoint, replaceFromRound: 676 };
    assert.throws(() => assertCodexCacheCheckpointCompatible(bad, { first: 1, last: 673 }, 654, points), /forceRawCacheRebuild/u);
    const badSource: CodexRoundTailCheckpoint = { ...checkpoint, sourceRoundIndex: 99999 };
    assert.throws(() => assertCodexCacheCheckpointCompatible(badSource, { first: 1, last: cached.length }, cached.length, points), /forceRawCacheRebuild/u);
    const invalidPoints: CodexSourceByteCheckpoint[] = points.map(point => ({ ...point, sourceByte: point.sourceByte + 1 }));
    assert.throws(() => assertCodexCacheCheckpointCompatible(checkpoint, { first: 1, last: cached.length }, cached.length, invalidPoints), /forceRawCacheRebuild/u);
    const last = cached.at(-1)!;
    const mapping = { roundIndex: last.roundIndex, sourceRoundIndices: last.legacyRoundIndices || [last.roundIndex], startStep: last.startStep };
    assertCodexCacheCheckpointCompatible(checkpoint, { first: 1, last: cached.length }, cached.length, points, mapping);
    assert.throws(() => assertCodexCacheCheckpointCompatible(checkpoint, { first: 1, last: cached.length }, cached.length, points, { ...mapping, startStep: mapping.startStep + 1 }), /forceRawCacheRebuild/u);
    assert.throws(() => assertCodexCacheCheckpointCompatible(checkpoint, { first: 1, last: cached.length }, cached.length, points, { ...mapping, sourceRoundIndices: [99999] }), /forceRawCacheRebuild/u);
    console.log("conversation-codex-checkpoint-map: PASS streaming merge, complete replay start, two appends/full equality, invalid checkpoint rejection");
} finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    fs.rmSync(temporary, { recursive: true, force: true });
}
