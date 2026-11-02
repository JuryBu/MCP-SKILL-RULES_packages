import assert from "node:assert/strict";
import test from "node:test";
import { corpusConversationKey, resolveCorpusSources } from "../src/conversation-corpus-sources.js";
import { createMultiCorpusProvider } from "../src/conversation-corpus-reader-multi.js";
import type { CorpusConversation, CorpusProjection, CorpusRangeProvider } from "../src/conversation-corpus-types.js";
import type { CorpusSource } from "../src/conversation-corpus-sources.js";

function provider(source: CorpusSource, text = source): CorpusRangeProvider {
    const conversation: CorpusConversation = { source, id: "shared-id", title: source, workspace: "/project" };
    const result: CorpusProjection = { conversation, revision: "revision-1", complete: true, warnings: [],
        messages: [{ id: "message", round: 1, role: "user", text, position: {} }] };
    return { list: async () => [conversation], read: async () => result, readCached: async () => result,
        readFast: async () => result, readRounds: async () => result };
}

test("new searches require explicit concrete sources and reject conflicting selections", () => {
    assert.throws(() => resolveCorpusSources({}), /concrete dataChain/);
    assert.throws(() => resolveCorpusSources({ dataChain: "auto" }), /concrete dataChain/);
    assert.throws(() => resolveCorpusSources({ dataChains: [] }), /at least one/);
    assert.throws(() => resolveCorpusSources({ dataChain: "codex", dataChains: ["codex", "dsh"] }), /same source/);
    assert.deepEqual(resolveCorpusSources({ chain: "auto", dataChains: ["wsf", "cc", "wsf"] }), ["windsurf", "claude-code"]);
    assert.deepEqual(resolveCorpusSources({ dataChain: "deepseek-harness" }), ["dsh"]);
});

test("source identity keeps equal ids in separate hosts and routes reads correctly", async () => {
    const api = createMultiCorpusProvider({ providers: { codex: provider("codex"), dsh: provider("dsh") } });
    const conversations = await api.list({ dataChains: ["codex", "dsh"] }, {});
    assert.equal(conversations.length, 2);
    assert.notEqual(corpusConversationKey(conversations[0]!), corpusConversationKey(conversations[1]!));
    const selected = conversations.find(conversation => conversation.source === "dsh")!;
    assert.equal((await api.read(selected, {})).messages[0]!.text, "dsh");
    assert.equal((await api.readFast(selected, { lastRounds: 1 })).conversation.source, "dsh");
    assert.deepEqual(api.sourceStatuses!().map(status => status.status), ["ok", "ok"]);
});

test("source failures remain visible with zero candidates and explicit fail stops listing", async () => {
    const broken = provider("dsh");
    broken.list = async () => { throw new Error("source unavailable"); };
    const api = createMultiCorpusProvider({ providers: { codex: provider("codex"), dsh: broken } });
    assert.equal((await api.list({ dataChains: ["codex", "dsh"] }, {})).length, 1);
    assert.deepEqual(api.sourceStatuses!().map(status => [status.source, status.status]), [["codex", "ok"], ["dsh", "error"]]);
    await assert.rejects(api.list({ dataChains: ["dsh"], sourceFailureMode: "fail" }, {}), /source unavailable/);
});

test("partial source enumeration and source revisions remain separate from successful transport", async () => {
    const partial = provider("antigravity");
    partial.sourceStatuses = () => [{ source: "antigravity", status: "partial", candidateCount: 1, warnings: ["PB_CANDIDATE_LIMIT"] }];
    const api = createMultiCorpusProvider({ providers: { antigravity: partial } });
    const [conversation] = await api.list({ dataChains: ["antigravity"] }, {});
    assert.equal(api.sourceStatuses!()[0]!.status, "partial");
    await assert.rejects(api.readRounds(conversation!, { revision: "different" }), /source revision changed/);
});

test("a projection cannot silently switch sources while keeping the same id", async () => {
    const broken = provider("dsh");
    const other = provider("codex");
    broken.read = other.read;
    const api = createMultiCorpusProvider({ providers: { dsh: broken } });
    const [conversation] = await api.list({ dataChains: ["dsh"] }, {});
    await assert.rejects(api.read(conversation!, {}), /source identity changed/);
});
