import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexCorpusProvider } from "../src/conversation-corpus-reader-codex.ts";
import { readCodexCorpusCache } from "../src/conversation-corpus-reader-cache.ts";
import { resolveCodexStreamingHistorySource, scanCodexStreamingHistory } from "../src/codex-history-source.ts";
import type { CorpusProjectionChunk } from "../src/conversation-corpus-types.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-reader-chunks-"));
const codexHome = path.join(temporary, "home");
const sessions = path.join(codexHome, "sessions");
const cacheRoot = path.join(temporary, "cache");
const identifier = "10000000-0000-4000-8000-000000000011";
const sourcePath = path.join(sessions, `rollout-2026-01-01T00-00-00-${identifier}.jsonl`);
const message = (role: string, text: string) => ({ timestamp: "2026-01-01T01:02:03.000Z", type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
const encode = (events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n") + "\n";
fs.mkdirSync(sessions, { recursive: true });
const original = encode([{ type: "session_meta", payload: { id: identifier, cwd: temporary } }, ...[1, 2, 3, 4].flatMap(round => [message("user", `question${round}`), message("assistant", `answer${round}`)])]);
fs.writeFileSync(sourcePath, original);
const conversation = { id: identifier, title: "Synthetic chunks", workspace: temporary, rolloutPath: sourcePath, source: "codex" as const };
const provider = createCodexCorpusProvider({ codexHome, cacheRoot, listThreads: async () => [] });
assert.equal(provider.semanticVersion, "codex-corpus-reader/v5");

try {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const chunks: CorpusProjectionChunk[] = [];
    let completed = false;
    const reading = provider.read(conversation, { onChunk: async chunk => {
        chunks.push(chunk);
        assert.ok(chunk.revision.startsWith("pending:"));
        assert.ok(chunk.warnings.includes("unverified_source_projection"));
        if (chunks.length === 1) { enter(); await gate; }
    } }).then(result => { completed = true; return result; });
    await entered;
    assert.equal(completed, false);
    assert.equal(await readCodexCorpusCache(cacheRoot, identifier, {}), null);
    release();
    const projection = await reading;
    assert.equal(projection.complete, true);
    assert.equal(projection.revision.startsWith("pending:"), false);
    assert.equal(chunks[0]!.replaceFromRound, 1);
    assert.ok(chunks.length > 1);
    assert.equal(new Set(chunks.map(chunk => chunk.revision)).size, 1);
    assert.deepEqual(chunks.flatMap(chunk => chunk.messages), projection.messages);

    const callbackFailure = new Error("synthetic chunk failure");
    await assert.rejects(provider.read(conversation, { forceRefresh: true, onChunk: async () => { throw callbackFailure; } }), error => error === callbackFailure);
    assert.equal((await readCodexCorpusCache(cacheRoot, identifier, {}))?.projection.revision, projection.revision);
    let cancelled = false;
    await assert.rejects(provider.read(conversation, { forceRefresh: true, isCancelled: () => cancelled, onChunk: async () => { cancelled = true; } }), { name: "AbortError" });
    assert.equal((await readCodexCorpusCache(cacheRoot, identifier, {}))?.projection.revision, projection.revision);

    let changed = false;
    await assert.rejects(provider.read(conversation, { forceRefresh: true, onChunk: async () => {
        if (!changed) { changed = true; await new Promise(resolve => setTimeout(resolve, 5)); fs.writeFileSync(sourcePath, original.replace("answer4", "ansWer4")); }
    } }), /changed during parsing/u);
    assert.equal(changed, true);
    assert.equal((await readCodexCorpusCache(cacheRoot, identifier, {}))?.projection.revision, projection.revision);
    fs.writeFileSync(sourcePath, original.replace("question1", "questiOn1") + encode([message("user", "invalid prefix append"), message("assistant", "reply")]));
    let invalidPrefixChunks = 0;
    await assert.rejects(provider.read(conversation, { onChunk: () => { invalidPrefixChunks += 1; } }), /cached prefix changed during incremental replay/u);
    assert.ok(invalidPrefixChunks > 0);
    assert.equal((await readCodexCorpusCache(cacheRoot, identifier, {}))?.projection.revision, projection.revision);
    fs.writeFileSync(sourcePath, original + encode([message("user", "question5"), message("assistant", "answer5"), message("user", "question6"), message("assistant", "answer6")]));
    const incrementChunks: CorpusProjectionChunk[] = [];
    const incremented = await provider.read(conversation, { onChunk: chunk => { incrementChunks.push(chunk); } });
    assert.equal(incremented.timings?.incrementalReplay, 1);
    assert.equal(incrementChunks[0]!.replaceFromRound, 1);
    assert.ok(incrementChunks[0]!.messages.every(entry => entry.round < 4));
    assert.deepEqual(incrementChunks.flatMap(chunk => chunk.messages), incremented.messages);

    const source = await resolveCodexStreamingHistorySource(sourcePath, { roots: [sessions] });
    let microtaskRan = false;
    let callbacks = 0;
    await scanCodexStreamingHistory(source, () => {
        callbacks += 1;
        if (callbacks === 1) queueMicrotask(() => { microtaskRan = true; });
        if (callbacks === 2) assert.equal(microtaskRan, false, "a synchronous callback must not introduce a per-record await");
    });
    let inCallback = false;
    await scanCodexStreamingHistory(source, async () => {
        assert.equal(inCallback, false);
        inCallback = true;
        await new Promise(resolve => setTimeout(resolve, 1));
        inCallback = false;
    });

    const limitedRoot = path.join(temporary, "limited");
    const limited = createCodexCorpusProvider({ codexHome, cacheRoot: limitedRoot, cacheMaxBytes: 128, listThreads: async () => [] });
    const limitedChunks: CorpusProjectionChunk[] = [];
    const uncached = await limited.read(conversation, { onChunk: chunk => { limitedChunks.push(chunk); } });
    assert.equal(uncached.complete, true);
    assert.ok(uncached.warnings.includes("persistent_body_cache_limit_streamed_projection_returned"));
    assert.deepEqual(limitedChunks.flatMap(chunk => chunk.messages), uncached.messages);
    assert.equal(await readCodexCorpusCache(limitedRoot, identifier, {}), null);
    const previousCache = await readCodexCorpusCache(cacheRoot, identifier, {});
    const limitedExisting = createCodexCorpusProvider({ codexHome, cacheRoot, cacheMaxBytes: 128, listThreads: async () => [] });
    const retainedCache = await limitedExisting.read(conversation, { forceRefresh: true });
    assert.ok(retainedCache.warnings.includes("persistent_body_cache_limit_streamed_projection_returned"));
    assert.deepEqual(await readCodexCorpusCache(cacheRoot, identifier, {}), previousCache);
    console.log("Codex corpus chunks: pending canonical batches, backpressure, callback failure, cancellation, source mutation, incremental replacement, sync no-await, async serialization and cache-size streaming fallback passed");
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
