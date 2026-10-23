import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { CODEX_CORPUS_CACHE_FORMAT, CODEX_ROLE_PROOF_CACHE_FORMAT, publishCodexCorpusCache, readCodexCorpusCache,
    type CodexCorpusCacheEntry } from "../src/conversation-corpus-reader-cache.ts";
import { createCodexCorpusProvider } from "../src/conversation-corpus-reader-codex.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "corpus-entry-reuse-"));
after(() => fs.rm(temporary, { recursive: true, force: true }));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function entry(id: string, text = "fixture alpha"): CodexCorpusCacheEntry {
    return { format: CODEX_CORPUS_CACHE_FORMAT, sourceIdentities: [], projection: {
        conversation: { id, title: id, workspace: "fixture", source: "codex" }, revision: `fixture-${text}`, complete: true, warnings: [],
        messages: [{ id: `${id}-message`, round: 1, role: "user", text, position: { ordinal: 1 } }],
    } };
}

async function paths(root: string, id: string): Promise<{ manifest: string; body: string }> {
    const directory = path.join(root, digest(id));
    const manifest = path.join(directory, "manifest.json");
    const pointer = JSON.parse(await fs.readFile(manifest, "utf8"));
    return { manifest, body: path.join(directory, pointer.file) };
}

test("verified entry reuse rechecks physical identities without rereading or parsing the body", async context => {
    const root = path.join(temporary, "reuse");
    const id = "fixture-reuse";
    await publishCodexCorpusCache(root, entry(id), {});
    const filenames = await paths(root, id);
    const readFile = fs.readFile.bind(fs);
    let bodyReads = 0;
    let manifestReads = 0;
    context.mock.method(fs, "readFile", async (filename: any, ...arguments_: any[]) => {
        if (String(filename) === filenames.body) bodyReads++;
        if (String(filename) === filenames.manifest) manifestReads++;
        return (readFile as (...input: any[]) => any)(filename, ...arguments_);
    });
    const first = await readCodexCorpusCache(root, id, {});
    const second = await readCodexCorpusCache(root, id, {});
    assert.ok(first);
    assert.strictEqual(first, second);
    assert.equal(bodyReads, 1);
    assert.equal(manifestReads, 1);
    const refreshed = await readCodexCorpusCache(root, id, { forceRefresh: true });
    assert.notStrictEqual(refreshed, first);
    assert.deepEqual(refreshed, first);
    assert.equal(bodyReads, 2);
});

test("same-length body rewrite with restored mtime invalidates the reused entry", async () => {
    const root = path.join(temporary, "body-rewrite");
    const id = "fixture-body-rewrite";
    await publishCodexCorpusCache(root, entry(id), {});
    assert.ok(await readCodexCorpusCache(root, id, {}));
    const filenames = await paths(root, id);
    const physical = await fs.stat(filenames.body);
    const previous = await fs.readFile(filenames.body, "utf8");
    const changed = previous.replaceAll("fixture alpha", "fixture bravo");
    assert.equal(Buffer.byteLength(previous), Buffer.byteLength(changed));
    await delay(10);
    await fs.writeFile(filenames.body, changed, "utf8");
    await fs.utimes(filenames.body, physical.atime, physical.mtime);
    assert.equal(await readCodexCorpusCache(root, id, {}), null);
});

test("manifest rewrite, generation replacement and missing files cannot reuse an old entry", async () => {
    const root = path.join(temporary, "generation");
    const id = "fixture-generation";
    await publishCodexCorpusCache(root, entry(id), {});
    const first = await readCodexCorpusCache(root, id, {});
    const filenames = await paths(root, id);
    const original = await fs.readFile(filenames.manifest, "utf8");
    const physical = await fs.stat(filenames.manifest);
    const pointer = JSON.parse(original);
    await delay(10);
    await fs.writeFile(filenames.manifest, JSON.stringify({ ...pointer, sha256: "0".repeat(64) }), "utf8");
    await fs.utimes(filenames.manifest, physical.atime, physical.mtime);
    assert.equal(await readCodexCorpusCache(root, id, {}), null);
    await publishCodexCorpusCache(root, entry(id, "fixture bravo"), {});
    const replaced = await readCodexCorpusCache(root, id, {});
    assert.notStrictEqual(replaced, first);
    assert.equal(replaced!.projection.messages[0]!.text, "fixture bravo");
    await fs.unlink((await paths(root, id)).body);
    assert.equal(await readCodexCorpusCache(root, id, {}), null);
});

test("reuse separates roots and formats and evicts the least recently used entry after sixteen keys", async context => {
    const root = path.join(temporary, "lru");
    const firstRoot = path.join(root, "first");
    const secondRoot = path.join(root, "second");
    const id = "fixture-separate";
    await publishCodexCorpusCache(firstRoot, entry(id, "fixture alpha"), {});
    await publishCodexCorpusCache(secondRoot, entry(id, "fixture bravo"), {});
    const first = await readCodexCorpusCache(firstRoot, id, {});
    assert.equal((await readCodexCorpusCache(secondRoot, id, {}))!.projection.messages[0]!.text, "fixture bravo");
    assert.equal(await readCodexCorpusCache(firstRoot, id, {}, CODEX_ROLE_PROOF_CACHE_FORMAT), null);
    assert.strictEqual(await readCodexCorpusCache(firstRoot, id, {}), first);
    const filenames = await paths(firstRoot, id);
    const readFile = fs.readFile.bind(fs);
    let rereads = 0;
    context.mock.method(fs, "readFile", async (filename: any, ...arguments_: any[]) => {
        if (String(filename) === filenames.body) rereads++;
        return (readFile as (...input: any[]) => any)(filename, ...arguments_);
    });
    for (let index = 0; index < 16; index++) {
        const nextId = `fixture-lru-${index}`;
        await publishCodexCorpusCache(root, entry(nextId), {});
        assert.ok(await readCodexCorpusCache(root, nextId, {}));
    }
    assert.deepEqual(await readCodexCorpusCache(firstRoot, id, {}), first);
    assert.equal(rereads, 1);
});

test("cancellation during warm identity validation propagates AbortError before returning a reused entry", async context => {
    const root = path.join(temporary, "cancel");
    const id = "fixture-cancel";
    await publishCodexCorpusCache(root, entry(id), {});
    await readCodexCorpusCache(root, id, {});
    const filenames = await paths(root, id);
    const stat = fs.stat.bind(fs);
    let cancelled = false;
    context.mock.method(fs, "stat", async (filename: any, ...arguments_: any[]) => {
        const result = await (stat as (...input: any[]) => any)(filename, ...arguments_);
        if (String(filename) === filenames.manifest) cancelled = true;
        return result;
    });
    await assert.rejects(readCodexCorpusCache(root, id, { isCancelled: () => cancelled }), { name: "AbortError" });
    await assert.rejects(readCodexCorpusCache(root, id, { isCancelled: () => true }), { name: "AbortError" });
});

test("provider still rejects a source rewrite after an entry has been reused", async () => {
    const root = path.join(temporary, "source-change");
    const home = path.join(root, "home");
    await fs.mkdir(path.join(home, "sessions"), { recursive: true });
    const id = "60000000-0000-4000-8000-000000000070";
    const source = path.join(home, "sessions", `rollout-2026-01-01T00-00-00-${id}.jsonl`);
    const original = [{ type: "session_meta", payload: { id, cwd: "fixture" } },
        { timestamp: "2026-01-01T00:00:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fixture source alpha" }] } }]
        .map(value => JSON.stringify(value)).join("\n") + "\n";
    await fs.writeFile(source, original, "utf8");
    const cacheRoot = path.join(root, "cache");
    const provider = createCodexCorpusProvider({ codexHome: home, cacheRoot, listThreads: async () => [] });
    const conversation = { id, source: "codex" as const, rolloutPath: source, workspace: "fixture", title: id };
    const first = await provider.read(conversation, {});
    assert.ok(await provider.readCached!(conversation, {}));
    assert.ok(await provider.readCached!(conversation, {}));
    const physical = await fs.stat(source);
    await delay(10);
    await fs.writeFile(source, original.replace("fixture source alpha", "fixture source delta"), "utf8");
    await fs.utimes(source, physical.atime, physical.mtime);
    assert.equal(await provider.readCached!(conversation, {}), null);
    const changed = await provider.read(conversation, {});
    assert.notEqual(changed.revision, first.revision);
    assert.equal(changed.messages[0]!.text, "fixture source delta");
});
