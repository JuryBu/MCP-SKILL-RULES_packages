import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import { after, test } from "node:test";
import { createCodexCorpusProvider } from "../src/conversation-corpus-reader-codex.ts";
import { CODEX_ROLE_PROOF_CACHE_FORMAT, readCodexCorpusCache } from "../src/conversation-corpus-reader-cache.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-role-cache-"));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const threadId = "10000000-0000-4000-8000-000000000001";
let fixtureNumber = 0;

function fixture() {
    const root = path.join(temporary, String(++fixtureNumber));
    const codexHome = path.join(root, "home");
    const sessions = path.join(codexHome, "sessions");
    const cacheRoot = path.join(root, "cache");
    fs.mkdirSync(sessions, { recursive: true });
    const leafPath = path.join(sessions, `rollout-2026-01-01T00-00-00-${threadId}.jsonl`);
    const body = [
        { type: "event_msg", payload: { type: "user_message", message: "delegated prompt" } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "delegated answer" }] } },
    ];
    const write = (source = "subagent") => fs.writeFileSync(leafPath, [
        { type: "session_meta", payload: { id: threadId, source, cwd: root } }, ...body,
    ].map(record => JSON.stringify(record)).join("\n") + "\n");
    write();
    const provider = () => createCodexCorpusProvider({ codexHome, cacheRoot, listThreads: async () => [] });
    const listed = async () => { const current = provider(); const conversations = await current.list({ conversationIds: [threadId] }); return { current, conversation: conversations[0]! }; };
    return { root, cacheRoot, leafPath, provider, listed, write };
}

test("reopened provider reuses role metadata proof and retains explicit body coverage warnings", async () => {
    const sample = fixture();
    const first = await sample.listed();
    let headerReads = 0;
    const cold = await first.current.read(first.conversation, { onProgress: progress => { if (progress.phase === "role-proof-headers") headerReads++; } });
    assert.ok(headerReads > 0);
    assert.equal(await readCodexCorpusCache(sample.cacheRoot, threadId, {}), null);
    const entry = await readCodexCorpusCache(path.join(sample.cacheRoot, "role-proofs"), threadId, {}, CODEX_ROLE_PROOF_CACHE_FORMAT);
    assert.ok(entry);
    assert.equal(entry.verification, undefined);
    assert.equal(entry.projection.cacheGeneration, undefined);
    assert.ok(entry.projection.warnings.includes("source_content_not_validated"));
    const second = await sample.listed();
    headerReads = 0;
    const warm = await second.current.read(second.conversation, { onProgress: progress => { if (progress.phase === "role-proof-headers") headerReads++; } });
    assert.equal(headerReads, 0);
    assert.equal(warm.timings?.cacheHit, 1);
    assert.equal(warm.revision, cold.revision);
    assert.deepEqual(warm.messages, []);
    assert.deepEqual(warm.warnings, cold.warnings);
    assert.equal(warm.sourceBytes, undefined);
    const subset = await second.current.read(second.conversation, { messageRoles: ["user"] });
    assert.equal(subset.timings?.cacheHit, 1);
});

test("role proof cannot replace requested subagent or tool content", async () => {
    const sample = fixture();
    const { current, conversation } = await sample.listed();
    await current.read(conversation, {});
    const fast = await current.readFast(conversation, { lastRounds: 1 });
    assert.deepEqual(fast.messages, []);
    const delegated = await current.read(conversation, { messageRoles: ["subagent"] });
    assert.ok(delegated.messages.some(message => message.text.includes("delegated")));
    assert.ok(delegated.messages.every(message => message.role === "subagent"));
    assert.ok(!delegated.warnings.includes("requested_roles_excluded_by_all_source_headers"));
});

test("changed origin invalidates a cached exclusion and returns actual human content", async () => {
    const sample = fixture();
    const first = await sample.listed();
    await first.current.read(first.conversation, {});
    sample.write("cli");
    const second = await sample.listed();
    const changed = await second.current.read(second.conversation, {});
    assert.ok(changed.messages.some(message => message.role === "user" && message.text === "delegated prompt"));
    assert.ok(changed.messages.some(message => message.role === "assistant" && message.text === "delegated answer"));
    assert.ok(!changed.warnings.includes("requested_roles_excluded_by_all_source_headers"));
});

test("new conflicting replica invalidates a cached role proof", async context => {
    const compress = (zlib as unknown as { zstdCompressSync?: (value: Buffer) => Buffer }).zstdCompressSync;
    if (!compress) { context.skip("native zstd unavailable"); return; }
    const sample = fixture();
    const first = await sample.listed();
    await first.current.read(first.conversation, {});
    const records = fs.readFileSync(sample.leafPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    records[0].payload.source = "cli";
    fs.writeFileSync(`${sample.leafPath}.zst`, compress(Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n")));
    const second = await sample.listed();
    await assert.rejects(second.current.read(second.conversation, {}), /replica metadata/u);
});

test("direct reads rebuild the source inventory before role cache reuse and cancelled calls fail closed", async () => {
    const sample = fixture();
    const first = await sample.listed();
    await first.current.read(first.conversation, {});
    const direct = sample.provider();
    let headerReads = 0;
    const warm = await direct.read(first.conversation, { onProgress: progress => { if (progress.phase === "role-proof-headers") headerReads++; } });
    assert.equal(headerReads, 0);
    assert.equal(warm.timings?.cacheHit, 1);
    await assert.rejects(direct.read(first.conversation, { isCancelled: () => true }), { name: "AbortError" });
});

