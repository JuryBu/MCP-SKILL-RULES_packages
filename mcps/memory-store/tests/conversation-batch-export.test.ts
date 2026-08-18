import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import type { ConversationRound } from "../src/trajectory.ts";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-conversation-batch-export-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;

const { exportConversationBatch } = await import("../src/conversation-batch-export.ts");

function makeRound(index: number, userMessage: string, aiResponse: string): ConversationRound {
    return {
        roundIndex: index,
        startStep: index * 10,
        endStep: index * 10 + 1,
        userMessage,
        mediaAttachments: [],
        aiResponses: [{
            stepIndex: index * 10 + 1,
            response: aiResponse,
            thinking: "",
            toolCalls: [],
        }],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
    };
}

const outputDir = path.join(os.tmpdir(), "memory-store-batch-export-dir", String(Date.now()));
const loadedIds: string[] = [];

const result = await exportConversationBatch({
    candidates: [{
        id: "batch-a",
        dataChain: "codex",
        title: "Batch A",
        workspace: "C:\\repo-a",
        updatedAt: "2026-07-03T00:00:00.000Z",
        detail: "fixture",
    }, {
        id: "batch-b",
        dataChain: "windsurf",
        title: "Batch B",
        workspace: "C:\\repo-b",
        updatedAt: "2026-07-03T00:00:00.000Z",
        detail: "fixture",
    }],
    batchConcurrency: 2,
    sourceStatuses: [{
        dataChain: "codex",
        status: "ok",
        count: 1,
    }, {
        dataChain: "windsurf",
        status: "ok",
        count: 1,
    }],
    scope: "full",
    depth: "normal",
    messageRoles: ["model"],
    outputDir,
    format: "markdown",
    includeAssets: false,
}, {
    loadConversationData: async (dataChain: any, conversationId: string) => {
        loadedIds.push(`${dataChain}:${conversationId}`);
        return {
            conversationId,
            chainUsed: dataChain,
            rounds: [makeRound(1, `用户 ${conversationId}`, `模型 ${conversationId}`)],
            totalSteps: 11,
        } as any;
    },
});

assert.equal(result.success, true);
assert.equal(result.succeeded, 2);
assert.deepEqual(loadedIds.sort(), ["codex:batch-a", "windsurf:batch-b"]);

const batchManifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf-8"));
assert.deepEqual(batchManifest.request.messageRoles, ["model"]);
assert.equal(batchManifest.sourceStatuses.length, 2);

for (const item of result.items) {
    assert.ok(item.manifestPath);
    const itemManifest = JSON.parse(fs.readFileSync(item.manifestPath || "", "utf-8"));
    assert.deepEqual(itemManifest.messageRoles, ["model"]);
    const markdown = fs.readFileSync(item.markdownPath || "", "utf-8");
    assert.match(markdown, new RegExp(`模型 ${item.conversationId}`, "u"));
    assert.doesNotMatch(markdown, new RegExp(`用户 ${item.conversationId}`, "u"));
}

fs.rmSync(dataRoot, { recursive: true, force: true });
fs.rmSync(outputDir, { recursive: true, force: true });
