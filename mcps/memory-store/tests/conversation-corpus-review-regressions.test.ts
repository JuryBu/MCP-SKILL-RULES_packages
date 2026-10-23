import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { createCodexCorpusProvider } from "../src/conversation-corpus-reader-codex.ts";
import { compileCorpusSearch, corpusConversationMatchesScope } from "../src/conversation-corpus-search.ts";
import { buildCodexRoundsForTest } from "../src/codex-client.ts";
import { mergeConsecutiveHumanRounds } from "../src/trajectory.ts";
import { resolveCodexHistorySourceAsync } from "../src/codex-history-source.ts";
import { projectConversationRoundForRecord } from "../src/conversation-record-projection.ts";
import { readOrBuildConversationSourceCache, resetConversationSourceCacheForTests, setConversationSourceCacheDataRootForTests } from "../src/conversation-source-cache.ts";

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-review-"));
    const codexHome = path.join(directory, "home");
    const sessions = path.join(codexHome, "sessions");
    fs.mkdirSync(sessions, { recursive: true });
    const id = "10000000-0000-4000-8000-000000000059";
    const rolloutPath = path.join(sessions, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
    const events: any[] = [{ type: "session_meta", payload: { id, cwd: directory, source: "cli" } }];
    for (const round of [1, 2, 3]) events.push(
        { timestamp: `2026-01-01T00:00:0${round}Z`, type: "event_msg", payload: { type: "user_message", message: `缓存问题${round}` } },
        { timestamp: `2026-01-01T00:01:0${round}Z`, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `回复${round}` }] } },
    );
    const encode = () => events.map(event => JSON.stringify(event)).join("\n") + "\n";
    fs.writeFileSync(rolloutPath, encode());
    const conversation = { id, title: id, workspace: directory, rolloutPath, source: "codex" as const };
    const provider = createCodexCorpusProvider({ codexHome, cacheRoot: path.join(directory, "cache"), listThreads: async () => [] });
    return { directory, sessions, rolloutPath, events, encode, conversation, provider, close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test("fast range rejects a conflicting replica inside the adopted prefix", async () => {
    const sample = fixture();
    try {
        fs.writeFileSync(`${sample.rolloutPath}.zst`, zstdCompressSync(Buffer.from(sample.encode().replace("缓存问题1", "冲突问题1"))));
        await assert.rejects(sample.provider.readFast(sample.conversation, { startRound: 1, endRound: 1 }), /Conflicting plaintext\/compressed/u);
    } finally { sample.close(); }
});

test("warm body cache rejects a newly added conflicting replica", async () => {
    const sample = fixture();
    try {
        await sample.provider.list({ conversationIds: [sample.conversation.id] }, {});
        await sample.provider.read(sample.conversation, {});
        fs.writeFileSync(`${sample.rolloutPath}.zst`, zstdCompressSync(Buffer.from(sample.encode().replace("缓存问题1", "冲突问题1"))));
        await assert.rejects(sample.provider.read(sample.conversation, {}), /Conflicting plaintext\/compressed/u);
    } finally { sample.close(); }
});

test("startRound-only fast reads retain the same single round before and after preparation", async () => {
    const sample = fixture();
    try {
        const cold = await sample.provider.readFast(sample.conversation, { startRound: 2 });
        await sample.provider.read(sample.conversation, {});
        const warm = await sample.provider.readFast(sample.conversation, { startRound: 2 });
        assert.ok(cold.messages.length > 0);
        assert.deepEqual(warm.messages.map(message => [message.round, message.role, message.text]), cold.messages.map(message => [message.round, message.role, message.text]));
        assert.ok(warm.messages.every(message => message.round === 2));
    } finally { sample.close(); }
});

test("linked conversation scope survives compilation and secondary filtering", () => {
    const id = "10000000-0000-4000-8000-000000000059";
    const compiled = compileCorpusSearch({ query: "缓存", conversationIds: [` CODEX://threads/${id.toUpperCase()} `] });
    assert.deepEqual(compiled.request.conversationIds, [id]);
    assert.equal(corpusConversationMatchesScope({ id, title: id, workspace: "", source: "codex" }, compiled.request), true);
});

test("published fetch projections retain image-only and file references without inline binary", async () => {
    const sample = fixture();
    try {
        const history = await resolveCodexHistorySourceAsync(sample.rolloutPath, { roots: [sample.sessions] });
        const rounds = mergeConsecutiveHumanRounds(buildCodexRoundsForTest(sample.events, "summary").rounds);
        const inline = "data:image/png;base64,iVBORw0KGgo=";
        rounds[0]!.userMessages![0]!.text = "";
        rounds[0]!.userMessages![0]!.attachments = [{ kind: "file", source: "codex-local-file", originalPath: "C:/fixture/report.txt" }, { kind: "image", source: "codex-data-url", dataUrl: inline }];
        rounds[0]!.userMessages![0]!.mediaAttachments = ["C:/fixture/photo.png", inline];
        rounds[0]!.userMessages![0]!.annotations = [{ selectedText: "原句", comment: "主人批注" }];
        rounds[0]!.semanticEvents = [{ semanticRole: "model", stepIndex: rounds[0]!.aiResponses[0]!.stepIndex, attachments: [{ kind: "image", source: "codex-local-image", originalPath: "C:/fixture/output.png" }] }];
        setConversationSourceCacheDataRootForTests(path.join(sample.directory, "published"));
        await readOrBuildConversationSourceCache({ key: { source: "codex:link=summary", conversationId: sample.conversation.id }, fingerprint: { revision: history.revision }, build: () => ({ snapshot: { codexData: { historySource: history } }, rounds }), projectRecordRound: projectConversationRoundForRecord });
        const result = await sample.provider.readFast(sample.conversation, { startRound: 1, endRound: 1 });
        assert.ok(result.warnings.includes("published_cache_snapshot"));
        const message = result.messages.find(message => message.role === "user")!;
        assert.equal(message.text, "");
        assert.equal(message.attachments?.length, 3);
        assert.equal(message.attachments?.[0]?.originalPath, "C:/fixture/report.txt");
        assert.deepEqual(message.mediaAttachments, ["C:/fixture/photo.png"]);
        assert.deepEqual(message.annotations, [{ selectedText: "原句", comment: "主人批注" }]);
        assert.equal(result.messages.find(item => item.role === "assistant")?.attachments?.[0]?.originalPath, "C:/fixture/output.png");
        assert.equal(JSON.stringify(result).includes(inline), false);
        assert.equal(JSON.stringify(result).includes('"dataUrl"'), false);
    } finally { resetConversationSourceCacheForTests(); sample.close(); }
});

test("a legacy record-only projection falls back to lossless source rounds", async () => {
    const sample = fixture();
    try {
        const history = await resolveCodexHistorySourceAsync(sample.rolloutPath, { roots: [sample.sessions] });
        const rounds = mergeConsecutiveHumanRounds(buildCodexRoundsForTest(sample.events, "summary").rounds);
        setConversationSourceCacheDataRootForTests(path.join(sample.directory, "published"));
        await readOrBuildConversationSourceCache({ key: { source: "codex:link=summary", conversationId: sample.conversation.id }, fingerprint: { revision: history.revision }, build: () => ({ snapshot: { codexData: { historySource: history } }, rounds }), projectRecordRound: (round, index) => {
            const { bodyMetadataVersion, ...legacy } = projectConversationRoundForRecord(round, index);
            return legacy;
        } });
        const result = await sample.provider.readFast(sample.conversation, { startRound: 1 });
        assert.ok(!result.warnings.includes("published_cache_snapshot"));
        assert.deepEqual(result.messages.map(message => message.text), ["缓存问题1", "回复1"]);
    } finally { resetConversationSourceCacheForTests(); sample.close(); }
});
