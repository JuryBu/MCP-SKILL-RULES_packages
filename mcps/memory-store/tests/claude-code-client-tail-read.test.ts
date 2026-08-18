import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readClaudeCodeRoundTail } from "../src/claude-code-client.ts";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-claude-tail-"));
const jsonlPath = path.join(tempDir, "session.jsonl");
try {
    fs.writeFileSync(jsonlPath, [
        JSON.stringify({ type: "user", message: { role: "user", content: "CLAUDE_TAIL_INITIAL_USER" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "CLAUDE_TAIL_THINKING" }] } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "claude-tail-call", name: "Bash", input: { command: "echo tail" } }] } }),
    ].join("\n") + "\n", "utf8");

    const initial = await readClaudeCodeRoundTail(jsonlPath);
    assert.equal(initial.status, "ok");
    assert.equal(initial.rounds.length, 1);
    assert.ok(initial.checkpoint);
    assert.ok(initial.sourceCheckpoints.some(item => item.kind === "thinking"));
    assert.ok(initial.sourceCheckpoints.some(item => item.kind === "tool_call"));

    fs.appendFileSync(jsonlPath, [
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "claude-tail-call", content: "CLAUDE_TAIL_TOOL_RESULT" }] } }),
        JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "compact-tail-boundary", compactMetadata: { trigger: "auto" } }),
        JSON.stringify({
            type: "user",
            parentUuid: "compact-tail-boundary",
            message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context. CLAUDE_TAIL_COMPACT" },
        }),
    ].join("\n") + "\n", "utf8");

    const firstAppend = await readClaudeCodeRoundTail(jsonlPath, { checkpoint: initial.checkpoint });
    assert.equal(firstAppend.status, "ok");
    assert.equal(firstAppend.rounds.length, 2);
    assert.match(firstAppend.rounds[0].toolCalls[0].resultSummary, /CLAUDE_TAIL_TOOL_RESULT/u);
    assert.match(firstAppend.rounds[0].aiResponses.map(item => item.thinking).join("\n"), /CLAUDE_TAIL_THINKING/u);
    assert.ok(firstAppend.checkpoint);
    const compactCheckpoint = firstAppend.sourceCheckpoints.find(item => item.kind === "compact_boundary");
    assert.ok(compactCheckpoint);
    assert.equal(firstAppend.checkpoint.replayStartByte, compactCheckpoint.sourceByte);
    assert.equal(firstAppend.checkpoint.replaceFromRound, 2);

    fs.appendFileSync(jsonlPath, [
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "CLAUDE_TAIL_COMPACT_RESPONSE" } }),
        JSON.stringify({ type: "user", message: { role: "user", content: "CLAUDE_TAIL_NEW_USER" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "CLAUDE_TAIL_NEW_RESPONSE" } }),
    ].join("\n") + "\n", "utf8");

    const secondAppend = await readClaudeCodeRoundTail(jsonlPath, { checkpoint: firstAppend.checkpoint });
    assert.equal(secondAppend.status, "ok");
    assert.equal(secondAppend.startByte, compactCheckpoint.sourceByte);
    assert.equal(secondAppend.replaceFromRound, 2);
    assert.equal(secondAppend.rounds.length, 2);
    assert.ok(secondAppend.rounds[0].compactionSummaries?.[0]);
    assert.equal(secondAppend.rounds[0].compactionSummaries?.[0].boundaryByteOffset, compactCheckpoint.sourceByte);
    assert.match(secondAppend.rounds[1].userMessage, /CLAUDE_TAIL_NEW_USER/u);

    const fidelityPath = path.join(tempDir, "fidelity-session.jsonl");
    const fullUser = `CLAUDE_FULL_USER_${"u".repeat(200_100)}`;
    const fullResponse = `CLAUDE_FULL_RESPONSE_${"r".repeat(200_100)}`;
    const fullThinking = `CLAUDE_FULL_THINKING_${"t".repeat(200_100)}`;
    const fullResult = `CLAUDE_FULL_RESULT_${"o".repeat(800)}`;
    const rawBase64 = "A".repeat(1024);
    fs.writeFileSync(fidelityPath, [
        JSON.stringify({
            type: "user",
            message: {
                role: "user",
                content: [
                    { type: "text", text: fullUser },
                    { type: "image", source: { type: "base64", media_type: "image/png", data: rawBase64 } },
                ],
            },
        }),
        JSON.stringify({
            type: "assistant",
            message: {
                role: "assistant",
                content: [
                    { type: "thinking", thinking: fullThinking },
                    { type: "text", text: fullResponse },
                    { type: "tool_use", id: "fidelity-call", name: "Bash", input: { script: `CLAUDE_FULL_ARGS_${"a".repeat(800)}`, image: { data: rawBase64 } } },
                ],
            },
        }),
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "fidelity-call", content: fullResult }] } }),
    ].join("\n") + "\n", "utf8");
    const fidelity = await readClaudeCodeRoundTail(fidelityPath);
    assert.equal(fidelity.status, "ok");
    const fidelityRound = fidelity.rounds[0];
    assert.equal(fidelityRound.userMessage, fullUser);
    assert.equal(fidelityRound.aiResponses[0].response, fullResponse);
    assert.equal(fidelityRound.aiResponses[0].thinking, fullThinking);
    assert.equal(fidelityRound.toolCalls[0].resultFull, fullResult);
    assert.ok(fidelityRound.toolCalls[0].argsFull);
    assert.ok(fidelityRound.toolCalls[0].argsSummary.length < fidelityRound.toolCalls[0].argsFull.length);
    const safeArgs = JSON.parse(fidelityRound.toolCalls[0].argsFull);
    assert.match(safeArgs.image.data, /^\[binary omitted chars=1024 sha256=[a-f0-9]{64}\]$/u);
    assert.doesNotMatch(fidelityRound.toolCalls[0].argsFull, new RegExp(rawBase64, "u"));
    const cacheRound = JSON.parse(JSON.stringify(fidelityRound));
    assert.equal(cacheRound.toolCalls[0].resultFull, fullResult);
    assert.ok(cacheRound.attachments?.length);
    assert.match(cacheRound.attachments[0].sha256, /^sha256:[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(cacheRound), new RegExp(rawBase64, "u"));

    const missingCheckpoint = await readClaudeCodeRoundTail(jsonlPath, { startByte: initial.sourceSize });
    assert.equal(missingCheckpoint.status, "rebuild_required");
    assert.equal(missingCheckpoint.reason, "checkpoint_required");

    const replacement = await readClaudeCodeRoundTail(jsonlPath, { checkpoint: initial.checkpoint, sourceChange: "replace" });
    assert.equal(replacement.status, "rebuild_required");
    assert.equal(replacement.reason, "source_replaced");

    fs.truncateSync(jsonlPath, initial.sourceSize - 1);
    const truncated = await readClaudeCodeRoundTail(jsonlPath, { checkpoint: initial.checkpoint });
    assert.equal(truncated.status, "rebuild_required");
    assert.equal(truncated.reason, "source_truncated");
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("claude code client tail-read tests passed");
