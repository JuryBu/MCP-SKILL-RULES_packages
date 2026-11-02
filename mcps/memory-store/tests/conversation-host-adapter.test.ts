import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConversationRound } from "../src/trajectory.ts";

const temporary = await mkdtemp(path.join(os.tmpdir(), "conversation-host-adapter-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(temporary, "data");
const { createHostCorpusProvider, hostCorpusProviders } = await import("../src/conversation-corpus-reader-hosts.ts");
const { projectHostCorpus } = await import("../src/conversation-host-projection.ts");

function round(index: number, text = `user-${index}`): ConversationRound {
    return { roundIndex: index, startStep: index * 2, endStep: index * 2 + 1, userMessage: text,
        mediaAttachments: [], aiResponses: text ? [{ stepIndex: index * 2 + 1, response: `answer-${index}`, thinking: "", toolCalls: [] }] : [],
        toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [] };
}

try {
    assert.deepEqual(Object.keys(hostCorpusProviders), ["claude-code", "windsurf", "antigravity", "dsh"]);
    let revision = "original";
    const rounds = [round(1), round(2, ""), round(3)];
    rounds[0].userMessages = [{ text: "annotated", stepIndex: 2, annotations: [{ selectedText: "annotated", comment: "comment" }], attachments: [{ kind: "image", source: "attachment-metadata-redacted", dataUrl: "data:image/png;base64,AAAA" }] }];
    rounds[0].semanticEvents = [{ semanticRole: "assistant", stepIndex: 3, attachments: [{ kind: "image", source: "attachment-metadata-redacted", dataUrl: "data:image/png;base64,BBBB" }] }];
    const projections = [];
    for (const source of ["claude-code", "windsurf", "antigravity", "dsh"] as const) {
        const conversation = { source, id: "same-id", canonicalId: "canonical", aliases: ["known-alias"], title: "fixture", workspace: path.join(temporary, "workspace"), rolloutPath: path.join(temporary, `${source}.jsonl`) };
        const backend = { list: async () => [conversation], read: async () => ({ rounds, revision }), readCached: async () => ({ rounds, revision }) };
        const provider = createHostCorpusProvider(source, { backend });
        assert.equal((await provider.list({ conversationIds: ["known-alias"], workspaces: [conversation.workspace], workspaceMode: "exact" }, {})).length, 1);
        assert.equal((await provider.list({ workspaces: [path.join(temporary, "other")], workspaceMode: "exact" }, {})).length, 0);
        const all = await provider.read(conversation, { messageRoles: ["user", "assistant", "tool", "subagent"] });
        assert.equal(all.totalRounds, 3);
        assert.equal(all.roundNumbering, "absolute");
        assert.equal(all.complete, true);
        assert.equal(all.messages[0].annotations?.[0].comment, "comment");
        assert.ok(all.messages[0].attachments?.[0].sha256);
        assert.ok(all.messages.find(message => message.role === "assistant")?.attachments?.[0].sha256);
        assert.doesNotMatch(JSON.stringify(all.messages), /data:image/u);
        projections.push(all);
        const window = await provider.readFast(conversation, { lastRounds: 2 });
        assert.deepEqual(window.rounds?.map(item => item.roundIndex), [2, 3]);
        assert.equal(window.totalRounds, 3);
        assert.equal(window.requestedRangeComplete, true);
        assert.equal(window.complete, false);
        const opened = await provider.readRounds(conversation, { revision: all.revision, startRound: 1, endRound: 1 });
        assert.equal(opened.messages[0].text, "annotated");
        assert.ok(await provider.readCached?.(conversation, {}));
        revision = "changed";
        await assert.rejects(provider.readRounds(conversation, { revision: all.revision, startRound: 1 }), /revision changed/u);
        revision = "original";
        await assert.rejects(provider.readFast(conversation, { startRound: 0 }), /positive integer/u);
        await assert.rejects(provider.readFast(conversation, { lastRounds: 1, startRound: 1 }), /not both/u);
        await assert.rejects(provider.read({ ...conversation, source: "codex" }, {}), /cannot read/u);
        let chunks = 0;
        await assert.rejects(provider.read(conversation, { isCancelled: () => true, onChunk: () => { chunks++; } }), error => (error as Error).name === "AbortError");
        assert.equal(chunks, 0);
        const chunkRevisions: string[] = [];
        await provider.read(conversation, { onChunk: chunk => { assert.equal(chunk.verified, true); assert.equal(chunk.replaceFromRound, undefined); chunkRevisions.push(chunk.revision); } });
        assert.deepEqual(chunkRevisions, [all.revision]);
    }
    assert.equal(new Set(projections.map(item => item.revision)).size, 4);
    assert.equal(new Set(projections.map(item => item.messages[0].id)).size, 4);
    const conversation = { source: "dsh" as const, id: "metadata-only", title: "fixture", workspace: "" };
    const partial = createHostCorpusProvider("dsh", { backend: {
        list: async () => [], sourceStatuses: () => [{ source: "dsh", status: "partial", candidateCount: 0, warnings: ["partial-enumeration"] }],
        read: async () => ({ revision: "partial", rounds, partial: true, warnings: ["unknown-variant"] }),
    } });
    assert.equal((await partial.list({}, {})).length, 0);
    assert.equal(partial.sourceStatuses?.()[0].status, "partial");
    const incomplete = await partial.read(conversation, { onChunk: chunk => { assert.equal(chunk.verified, false); } });
    assert.equal(incomplete.complete, false);
    assert.equal(incomplete.requestedRangeComplete, false);
    assert.ok(incomplete.warnings.includes("unknown-variant"));
    const relative = projectHostCorpus(conversation, { revision: "relative", rounds: [round(1), round(2)], roundNumbering: "relative", rangeComplete: true }, { lastRounds: 2 }, {});
    assert.equal(relative.roundNumbering, "relative");
    assert.equal(relative.totalRounds, undefined);
    assert.equal(relative.complete, false);
    const hole = projectHostCorpus(conversation, { revision: "hole", rounds: [round(1), round(3)], totalRounds: 3, rangeComplete: true }, { startRound: 1, endRound: 3 }, {});
    assert.equal(hole.requestedRangeComplete, false);
    assert.equal(hole.complete, false);
    const forcedPartial = projectHostCorpus(conversation, { revision: "partial", rounds, partial: true, rangeComplete: true }, { lastRounds: 2 }, {});
    assert.equal(forcedPartial.requestedRangeComplete, false);
    assert.throws(() => projectHostCorpus(conversation, { conversation: { ...conversation, id: "foreign" }, revision: "foreign", rounds }, undefined, {}), /identity changed/u);
    assert.throws(() => projectHostCorpus(conversation, { revision: "pending:unverified", rounds }, undefined, {}), /no verified revision/u);
    console.log("conversation host adapter: four-source identity, ranges, roles, attachments, partial, revision and cancellation passed");
} finally {
    await rm(temporary, { recursive: true, force: true });
}
