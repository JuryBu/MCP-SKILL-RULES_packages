import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CorpusConversation, CorpusMessageRole } from "../src/conversation-corpus-types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "plan62-host-force-refresh-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
process.env.MEMORY_STORE_AUTO_RECORD = "0";
const { createHostCorpusProvider } = await import("../src/conversation-corpus-reader-hosts.js");

async function fixture(name: string) {
    const sessionsRoot = path.join(root, name, "sessions");
    const id = `synthetic-${name}`;
    const directory = path.join(sessionsRoot, "project", id);
    await mkdir(directory, { recursive: true });
    const filename = path.join(directory, "session.jsonl");
    const records = [
        { type: "session", version: 0, id, cwd: root },
        { type: "user/message", seq: 0, time: 0, data: { message: { role: "user", content: [{ type: "text", text: "synthetic question" }] } } },
        { type: "assistant/message", seq: 1, time: 1, data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "synthetic answer" }] } } },
    ];
    await writeFile(filename, records.map(record => JSON.stringify(record)).join("\n") + "\n");
    const options = { cacheRoot: path.join(root, name, "cache"), dshOptions: { sessionsRoot } };
    const conversation: CorpusConversation = { source: "dsh", id, canonicalId: id, title: id, workspace: root, rolloutPath: filename };
    return { options, conversation };
}

test("default isolated read skips a warm cache only for explicit forceRefresh", async () => {
    const { options, conversation } = await fixture("read");
    const provider = createHostCorpusProvider("dsh", options);
    const cold = await provider.read(conversation, {});
    assert.equal(cold.timings?.cacheHit, 0);
    assert.equal((await provider.read(conversation, {})).timings?.cacheHit, 1);
    assert.equal((await provider.read(conversation, { forceRefresh: false })).timings?.cacheHit, 1);

    const messageRoles: CorpusMessageRole[] = ["assistant"];
    const progress: string[] = [];
    let chunks = 0;
    const forced = await provider.read(conversation, {
        forceRefresh: true, messageRoles, deadlineAt: Date.now() + 10_000,
        onProgress: value => { progress.push(value.phase); },
        onChunk: chunk => {
            chunks++;
            assert.equal(chunk.verified, true);
            assert.deepEqual(chunk.messages.map(message => message.role), messageRoles);
        },
    });
    assert.equal(forced.timings?.cacheHit, 0);
    assert.ok((forced.timings?.parsedBytes || 0) > 0);
    assert.equal(forced.revision, cold.revision);
    assert.deepEqual(forced.messages.map(message => message.role), messageRoles);
    assert.equal(chunks, 1);
    assert.ok(progress.length > 0);

    const inline = createHostCorpusProvider("dsh", { ...options, dshOptions: { ...options.dshOptions, isCancelled: () => false } });
    const expected = await inline.read(conversation, { forceRefresh: true, messageRoles });
    assert.equal(expected.timings?.cacheHit, 0);
    assert.deepEqual(forced.messages, expected.messages);
    assert.equal(forced.revision, expected.revision);
    assert.equal((await provider.read(conversation, {})).timings?.cacheHit, 1);
});

test("default isolated readCached preserves warm-cache and forceRefresh miss semantics", async () => {
    const { options, conversation } = await fixture("cached");
    const provider = createHostCorpusProvider("dsh", options);
    const cold = await provider.read(conversation, {});
    const messageRoles: CorpusMessageRole[] = ["assistant"];
    const warm = await provider.readCached!(conversation, { messageRoles });
    assert.ok(warm);
    assert.equal(warm.timings?.cacheHit, 1);
    assert.deepEqual(warm.messages.map(message => message.role), messageRoles);
    assert.equal(warm.revision, cold.revision);
    assert.equal((await provider.readCached!(conversation, { forceRefresh: false }))?.timings?.cacheHit, 1);
    assert.equal(await provider.readCached!(conversation, { forceRefresh: true, messageRoles }), null);

    const inline = createHostCorpusProvider("dsh", { ...options, dshOptions: { ...options.dshOptions, isCancelled: () => false } });
    assert.equal(await inline.readCached!(conversation, { forceRefresh: true, messageRoles }), null);
    assert.equal((await provider.readCached!(conversation, {}))?.timings?.cacheHit, 1);
});

after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await rm(root, { recursive: true, force: true });
});
