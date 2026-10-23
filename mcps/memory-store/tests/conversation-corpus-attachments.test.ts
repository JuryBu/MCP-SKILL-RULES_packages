import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { projectCodexCorpusRound } from "../src/conversation-corpus-reader-projection.ts";
import { createCodexCorpusProvider } from "../src/conversation-corpus-reader-codex.ts";
import type { ConversationRound } from "../src/trajectory.ts";

test("body projection retains message attachment references and annotations without inline binary", () => {
    const inline = "data:image/png;base64,iVBORw0KGgo=";
    const round: ConversationRound = {
        roundIndex: 8, startStep: 1, endStep: 4, userMessage: "看附件", mediaAttachments: [],
        userMessages: [{ text: "看附件", stepIndex: 1, attachments: [
            { kind: "image", source: "codex-data-url", dataUrl: inline, mimeType: "image/png" },
            { kind: "file", source: "codex-local-file", originalPath: "C:/fixture/report.txt", name: "report.txt", exists: false },
        ], annotations: [{ selectedText: "原句", comment: "主人批注" }] },
        { text: "", stepIndex: 2, mediaAttachments: ["C:/fixture/photo.png", inline] }],
        aiResponses: [{ stepIndex: 3, response: "已看", thinking: "", toolCalls: [] }],
        semanticEvents: [{ semanticRole: "model", stepIndex: 3, attachments: [{ kind: "image", source: "codex-local-image", originalPath: "C:/fixture/output.png" }] }],
        toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [],
    };
    const projected = projectCodexCorpusRound("fixture-thread", round, new Map(), ["user", "assistant"], "fixture.jsonl");
    assert.equal(projected.length, 3);
    assert.equal(projected[0].attachments?.length, 2);
    assert.equal(projected[0].attachments?.[1].originalPath, "C:/fixture/report.txt");
    assert.deepEqual(projected[0].annotations, [{ selectedText: "原句", comment: "主人批注" }]);
    assert.equal(projected[1].text, "");
    assert.deepEqual(projected[1].mediaAttachments, ["C:/fixture/photo.png"]);
    assert.ok(projected[1].attachments?.[0].sha256);
    assert.equal(projected[2].attachments?.[0].originalPath, "C:/fixture/output.png");
    assert.equal(JSON.stringify(projected).includes(inline), false);
    assert.equal(JSON.stringify(projected).includes('"dataUrl"'), false);
    assert.equal(round.userMessages?.[0].attachments?.[0].dataUrl, inline);
    const child = projectCodexCorpusRound("fixture-thread", round, new Map(), ["subagent"], "fixture.jsonl", new Map([["fixture.jsonl", { sourceThreadId: "child", isChildThread: true }]]));
    assert.equal(child.length, 3);
    assert.ok(child.every(message => message.role === "subagent"));
    assert.equal(child[0].attachments?.length, 2);
});

test("real provider keeps an image-only owner message through cold build, warm cache and round expansion", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-attachment-round-"));
    try {
        const sessions = path.join(directory, "sessions");
        await fs.mkdir(sessions);
        const conversationId = "10000000-0000-4000-8000-000000000059";
        const rolloutPath = path.join(sessions, `rollout-2026-01-01T00-00-00-${conversationId}.jsonl`);
        const source = [
            { type: "session_meta", payload: { id: conversationId, cwd: directory, source: "cli" } },
            { type: "response_item", timestamp: "2026-01-01T00:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" }] } },
            { type: "response_item", timestamp: "2026-01-01T00:00:02Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "图片已收到" }] } },
        ].map(event => JSON.stringify(event)).join("\n") + "\n";
        await fs.writeFile(rolloutPath, source);
        const provider = createCodexCorpusProvider({ codexHome: directory, cacheRoot: path.join(directory, "cache"), listThreads: async () => [] });
        const [conversation] = await provider.list({ conversationIds: [conversationId] }, {});
        assert.ok(conversation);
        const cold = await provider.read(conversation, {});
        const owner = cold.messages.find(message => message.role === "user");
        assert.ok(owner);
        assert.equal(owner.round, 1);
        assert.equal(owner.attachments?.length, 1);
        assert.ok(owner.attachments?.[0].sha256);
        assert.equal(JSON.stringify(cold).includes("iVBORw0KGgo="), false);
        const warm = await provider.read(conversation, {});
        assert.equal(warm.timings?.cacheHit, 1);
        assert.deepEqual(warm.messages, cold.messages);
        const expanded = await provider.readRounds(conversation, { revision: cold.revision, startRound: 1, endRound: 1 });
        assert.deepEqual(expanded.messages, cold.messages);
        const latest = await provider.readFast(conversation, { lastRounds: 1 });
        assert.deepEqual(latest.messages, cold.messages);
        assert.equal(await fs.readFile(rolloutPath, "utf8"), source);
    } finally {
        assert.equal(path.dirname(directory), os.tmpdir());
        assert.ok(path.basename(directory).startsWith("corpus-attachment-round-"));
        await fs.rm(directory, { recursive: true });
    }
});
