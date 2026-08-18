import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCodexRoundsFromRolloutForTest, readCodexRoundTail } from "../src/codex-client.ts";

function codexEvent(payload: unknown, type = "response_item"): string {
    return JSON.stringify({ type, payload });
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-codex-tail-"));
const rolloutPath = path.join(tempDir, "rollout.jsonl");
try {
    const agentsText = [
        "# AGENTS.md instructions",
        "<INSTRUCTIONS>",
        "TAIL_AGENTS_MARKER",
        "</INSTRUCTIONS><environment_context>",
    ].join("\n");
    fs.writeFileSync(rolloutPath, [
        codexEvent({ type: "message", role: "user", content: [{ type: "input_text", text: agentsText }] }),
        codexEvent({ type: "message", role: "assistant", content: [{ type: "output_text", text: "准备调用工具" }] }),
        codexEvent({ type: "function_call", call_id: "tail-call", name: "shell_command", arguments: "{\"command\":\"echo tail\"}" }),
        codexEvent({ type: "reasoning", summary: [{ text: "TAIL_THINKING_MARKER" }] }),
    ].join("\n") + "\n", "utf8");

    const initial = await readCodexRoundTail(rolloutPath, "summary");
    assert.equal(initial.status, "ok");
    assert.equal(initial.rounds.length, 1);
    assert.ok(initial.checkpoint);
    assert.ok(initial.checkpoint.replayStartByte < initial.sourceSize);
    assert.ok(initial.sourceCheckpoints.some(item => item.kind === "agents"));
    assert.ok(initial.sourceCheckpoints.some(item => item.kind === "thinking"));
    assert.ok(initial.sourceCheckpoints.some(item => item.kind === "tool_call"));

    fs.appendFileSync(rolloutPath, [
        codexEvent({ type: "function_call_output", call_id: "tail-call", output: "TAIL_TOOL_RESULT_FROM_APPEND" }),
        codexEvent({ type: "user_message", text: "TAIL_REAL_USER_AFTER_AGENTS" }, "event_msg"),
        codexEvent({ type: "message", role: "assistant", content: [{ type: "output_text", text: "TAIL_NEW_ROUND_RESPONSE" }] }),
    ].join("\n") + "\n", "utf8");

    const appended = await readCodexRoundTail(rolloutPath, "summary", { checkpoint: initial.checkpoint });
    assert.equal(appended.status, "ok");
    assert.equal(appended.startByte, initial.checkpoint.replayStartByte);
    assert.equal(appended.replaceFromRound, initial.checkpoint.replaceFromRound);
    assert.equal(appended.rounds.length, 2);
    assert.match(appended.rounds[0].toolCalls[0].resultSummary, /TAIL_TOOL_RESULT_FROM_APPEND/u);
    assert.match(appended.rounds[0].aiResponses.map(item => item.thinking).join("\n"), /TAIL_THINKING_MARKER/u);
    assert.match(appended.rounds[1].userMessage, /TAIL_REAL_USER_AFTER_AGENTS/u);
    assert.match(appended.rounds[1].aiResponses.map(item => item.response).join("\n"), /TAIL_NEW_ROUND_RESPONSE/u);

    const fidelityPath = path.join(tempDir, "fidelity-rollout.jsonl");
    const fullUser = `CODEX_FULL_USER_${"u".repeat(200_100)}`;
    const fullResponse = `CODEX_FULL_RESPONSE_${"r".repeat(200_100)}`;
    const fullThinking = `CODEX_FULL_THINKING_${"t".repeat(200_100)}`;
    const dataUrl = `data:image/png;base64,${"A".repeat(1024)}`;
    const fullArgs = JSON.stringify({ script: `CODEX_FULL_ARGS_${"a".repeat(800)}`, screenshot: dataUrl });
    const fullResult = `CODEX_FULL_RESULT_${"o".repeat(800)}`;
    fs.writeFileSync(fidelityPath, [
        codexEvent({
            type: "message",
            role: "user",
            content: [
                { type: "input_text", text: fullUser },
                { type: "input_image", image_url: dataUrl },
            ],
        }),
        codexEvent({ type: "message", role: "assistant", content: [{ type: "output_text", text: fullResponse }] }),
        codexEvent({ type: "reasoning", summary: [{ text: fullThinking }] }),
        codexEvent({ type: "function_call", call_id: "fidelity-call", name: "shell_command", arguments: fullArgs }),
        codexEvent({ type: "function_call_output", call_id: "fidelity-call", output: fullResult }),
    ].join("\n") + "\n", "utf8");
    const fidelity = await readCodexRoundTail(fidelityPath, "summary");
    assert.equal(fidelity.status, "ok");
    const fidelityRound = fidelity.rounds[0];
    assert.equal(fidelityRound.userMessage, fullUser);
    assert.equal(fidelityRound.aiResponses[0].response, fullResponse);
    assert.equal(fidelityRound.aiResponses[0].thinking, fullThinking);
    assert.equal(fidelityRound.toolCalls[0].resultFull, fullResult);
    assert.ok(fidelityRound.toolCalls[0].argsFull);
    assert.ok(fidelityRound.toolCalls[0].argsSummary.length < fidelityRound.toolCalls[0].argsFull.length);
    const safeArgs = JSON.parse(fidelityRound.toolCalls[0].argsFull);
    assert.match(safeArgs.screenshot, /^\[binary omitted mime=image\/png chars=\d+ sha256=[a-f0-9]{12}\]$/u);
    assert.doesNotMatch(fidelityRound.toolCalls[0].argsFull, /data:image\/png;base64/u);
    const cacheRound = JSON.parse(JSON.stringify(fidelityRound));
    assert.equal(cacheRound.toolCalls[0].resultFull, fullResult);
    assert.ok(cacheRound.attachments?.length);
    assert.match(cacheRound.attachments[0].sha256, /^sha256:[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(cacheRound), /data:image\/png;base64/u);

    const streamedRounds: typeof fidelity.rounds = [];
    const streamed = await buildCodexRoundsFromRolloutForTest(fidelityPath, "summary", {
        retainRounds: false,
        onRound: (round) => streamedRounds.push(round),
    });
    assert.equal(streamed.rounds.length, 0, "流式缓存构建不得在内存中保留已落盘轮次");
    assert.equal(streamedRounds.length, 1);
    assert.equal(streamed.lastRound?.roundIndex, streamedRounds[0].roundIndex);
    assert.equal(streamedRounds[0].toolCalls[0].resultFull, fullResult);

    const missingCheckpoint = await readCodexRoundTail(rolloutPath, "summary", { startByte: initial.sourceSize });
    assert.equal(missingCheckpoint.status, "rebuild_required");
    assert.equal(missingCheckpoint.reason, "checkpoint_required");

    const replacement = await readCodexRoundTail(rolloutPath, "summary", { checkpoint: initial.checkpoint, sourceChange: "replace" });
    assert.equal(replacement.status, "rebuild_required");
    assert.equal(replacement.reason, "source_replaced");

    fs.truncateSync(rolloutPath, initial.sourceSize - 1);
    const truncated = await readCodexRoundTail(rolloutPath, "summary", { checkpoint: initial.checkpoint });
    assert.equal(truncated.status, "rebuild_required");
    assert.equal(truncated.reason, "source_truncated");
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("codex client tail-read tests passed");
