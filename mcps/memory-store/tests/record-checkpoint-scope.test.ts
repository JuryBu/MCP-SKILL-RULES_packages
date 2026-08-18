import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RecordCheckpointScope, RecordPatch } from "../src/record-types.js";

process.env.MEMORY_STORE_DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-checkpoint-scope-"));

const {
    hashText,
    readRecordPatchCheckpoint,
    recordPatchCheckpointPath,
    writeRecordPatchCheckpoint,
} = await import("../src/record-checkpoint.ts");

const conversationId = `checkpoint-scope-${Date.now()}`;
const workspace = "checkpoint-scope-test";
const prompt = "same prompt for every scoped checkpoint";
const promptHash = hashText(prompt);
const patch: RecordPatch = {
    startRound: 1,
    endRound: 3,
    title: "Scoped patch",
    markdown: "## Phase Draft\n\n- scoped",
    files: ["src/scoped.ts"],
    tags: ["checkpoint", "scope"],
    risks: [],
    status: "ok",
};

const autoGrok: RecordCheckpointScope = {
    requestedChain: "auto",
    modelChain: "grok",
    modelName: "grok-4.3",
    grokContext: "record",
};
const autoAntigravity: RecordCheckpointScope = {
    requestedChain: "auto",
    modelChain: "antigravity",
    modelName: "MODEL_PLACEHOLDER_M20",
    grokContext: "record",
};
const explicitGrok: RecordCheckpointScope = {
    requestedChain: "grok",
    modelChain: "grok",
    modelName: "grok-4.3",
    grokContext: "record",
};

try {
    const autoGrokPath = recordPatchCheckpointPath("map", conversationId, autoGrok, 1, 3, promptHash);
    const autoAntigravityPath = recordPatchCheckpointPath("map", conversationId, autoAntigravity, 1, 3, promptHash);
    const explicitGrokPath = recordPatchCheckpointPath("map", conversationId, explicitGrok, 1, 3, promptHash);
    assert.notEqual(autoGrokPath, autoAntigravityPath, "auto Grok and auto Antigravity scopes must not share checkpoint path");
    assert.notEqual(autoGrokPath, explicitGrokPath, "auto Grok and explicit Grok scopes must not share checkpoint path");
    assert.notEqual(autoAntigravityPath, explicitGrokPath, "fallback M20 and explicit Grok scopes must not share checkpoint path");

    writeRecordPatchCheckpoint("map", conversationId, workspace, autoGrok, 1, 3, prompt, "done", patch);
    assert.deepEqual(readRecordPatchCheckpoint("map", conversationId, autoGrok, 1, 3, prompt), patch);
    assert.equal(readRecordPatchCheckpoint("map", conversationId, autoAntigravity, 1, 3, prompt), null);
    assert.equal(readRecordPatchCheckpoint("map", conversationId, explicitGrok, 1, 3, prompt), null);
    assert.equal(readRecordPatchCheckpoint("map", conversationId, null, 1, 3, prompt), null);
} finally {
    fs.rmSync(process.env.MEMORY_STORE_DATA_ROOT, { recursive: true, force: true });
}
