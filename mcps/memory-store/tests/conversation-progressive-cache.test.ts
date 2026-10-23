import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { openProgressiveCache } from "../src/conversation-progressive-cache.js";
import type { ProgressivePublishInput, ProgressiveSource } from "../src/conversation-progressive-types.js";
import type { ConversationRound } from "../src/trajectory.js";
import type { CorpusMessage } from "../src/conversation-corpus-types.js";

const source: ProgressiveSource = { conversationId: "fictional-conversation", host: "codex", revision: "whole-chain-1", snapshot: { files: [{ name: "fictional.jsonl", bytes: 1234 }] } };

function input(startRound: number, endRound: number, options: { relative?: boolean; anchor?: string; text?: string } = {}): ProgressivePublishInput {
    const rounds: ConversationRound[] = [];
    const messages: CorpusMessage[] = [];
    for (let roundIndex = startRound; roundIndex <= endRound; roundIndex++) {
        const text = options.text ?? `fictional-${roundIndex}`;
        rounds.push({ roundIndex, startStep: roundIndex * 2, endStep: roundIndex * 2 + 1, userMessage: text,
            aiResponses: [{ text: `reply-${roundIndex}`, stepIndex: roundIndex * 2 + 1 }] as ConversationRound["aiResponses"],
            mediaAttachments: [], toolCalls: [], taskBoundaries: [], codeActions: [], subagentSummaries: [], createdAt: "2026-01-02T03:04:05Z" });
        messages.push({ id: `u-${roundIndex}`, round: roundIndex, role: "user", text, timestamp: "2026-01-02T03:04:05Z", position: { path: "fictional.jsonl", startByte: roundIndex * 20, endByte: roundIndex * 20 + 10, ordinal: roundIndex * 2 } });
        messages.push({ id: `a-${roundIndex}`, round: roundIndex, role: "assistant", text: `reply-${roundIndex}`, position: { ordinal: roundIndex * 2 + 1 } });
    }
    return { coverage: { kind: options.relative ? "relative" : "absolute", startRound, endRound }, anchor: { name: options.anchor ?? `anchor-${startRound}` }, rounds, messages,
        ...(options.relative ? { order: options.anchor === "older" ? -1 : 0 } : {}) };
}

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "progressive-fictional-"));
    try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function child(script: string, ...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const processHandle = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, ...args], { cwd: process.cwd(), windowsHide: true });
        let stdout = ""; let stderr = "";
        processHandle.stdout.on("data", chunk => { stdout += chunk; });
        processHandle.stderr.on("data", chunk => { stderr += chunk; });
        processHandle.once("error", reject);
        processHandle.once("exit", code => code === 0 ? resolve(stdout) : reject(new Error(`Child exit ${code}: ${stderr}`)));
    });
}

test("absolute immutable blocks render canonical content, keep refs and finish exact coverage", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source: { ...source, totalRounds: 4 } });
    const writer = await cache.beginWrite();
    const recent = input(3, 4);
    const block = await cache.publish(writer, recent);
    const first = await cache.read({ direction: "oldest", startRound: 3, endRound: 4 });
    assert.deepEqual(first.rounds, recent.rounds);
    assert.deepEqual(first.messages, recent.messages);
    assert.equal(first.requestedRangeComplete, true);
    assert.equal(first.status.complete, false);
    const ref = first.rows[0].ref;
    await assert.rejects(cache.finish(writer), { code: "incomplete_coverage" });
    assert.equal((await cache.publish(writer, recent)).blockId, block.blockId);
    await cache.publish(writer, input(1, 2));
    assert.deepEqual((await cache.read({ direction: "latest" })).rounds.map(round => round.roundIndex), [4, 3, 2, 1]);
    assert.deepEqual((await cache.locate(ref)).round, recent.rounds[0]);
    assert.deepEqual((await cache.status()).absoluteRanges, [{ startRound: 1, endRound: 4 }]);
    assert.deepEqual((await cache.search({ query: "fictional" }, { startRound: 3, endRound: 3 })).searchedRanges.map(range => [range.startRound, range.endRound]), [[3, 3]]);
    assert.equal((await cache.finish(writer)).complete, true);
    await assert.rejects(cache.publish(writer, input(5, 5)), { code: "stale_writer" });
}));

test("relative anchors never merge rounds in matcher; snapshots can expand under fixed revision", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source });
    const writer = await cache.beginWrite();
    const first = await cache.publish(writer, input(1, 1, { relative: true, anchor: "recent", text: "ς" }));
    const ref = (await cache.read({ blockId: first.blockId })).rows[0].ref;
    const older = input(1, 1, { relative: true, anchor: "older", text: "other" });
    older.sourceSnapshot = { files: ["earlier-fictional.jsonl", "fictional.jsonl"] };
    await cache.publish(writer, older);
    const search = await cache.search({ query: "σ" });
    assert.equal(search.match?.occurrences, 1);
    assert.equal(search.hits[0].ref, ref);
    assert.equal((await cache.search({ query: "σ", caseSensitive: true })).match, null);
    assert.equal((await cache.search({ query: "roundIndex" })).match, null);
    assert.equal((await cache.search({ allTerms: ["ς", "other"], intersectionScope: "round" })).match, null);
    assert.ok((await cache.search({ allTerms: ["ς", "other"], intersectionScope: "conversation" })).match);
    assert.equal((await cache.status()).relativeReadyRounds, 2);
    assert.equal((await cache.status()).coveredAbsoluteRounds, 0);
    assert.deepEqual((await cache.read({ direction: "latest" })).rounds.map(round => round.userMessage), ["ς", "other"]);
    assert.deepEqual((await cache.read({ direction: "oldest" })).rounds.map(round => round.userMessage), ["other", "ς"]);
    assert.equal((await cache.locate(ref)).messages[0].text, "ς");
    await assert.rejects(cache.finish(writer), { code: "incomplete_coverage" });
    await cache.cancel(writer);
    const reopened = await openProgressiveCache({ root, source: { ...source, snapshot: older.sourceSnapshot } });
    assert.equal(reopened.sourceKey, cache.sourceKey);
    assert.equal((await reopened.locate(ref)).messages[0].text, "ς");
}));

test("cancel fences writers, allows readers and new process resume without original cache", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source });
    const writer = await cache.beginWrite();
    await assert.rejects(cache.beginWrite(), { code: "writer_busy" });
    const block = await cache.publish(writer, input(1, 1));
    const ref = (await cache.read()).rows[0].ref;
    await cache.cancel(writer);
    await assert.rejects(cache.publish(writer, input(2, 2)), { code: "stale_writer" });
    const script = `import {openProgressiveCache} from './src/conversation-progressive-cache.ts';
        const cache = await openProgressiveCache({root: process.argv[1], source: JSON.parse(process.argv[2])});
        const writer = await cache.beginWrite();
        const row = await cache.locate(process.argv[3]);
        await cache.cancel(writer);
        console.log(JSON.stringify({text: row.messages[0].text, blocks: (await cache.status()).blocks.length}));`;
    const result = JSON.parse(await child(script, root, JSON.stringify(source), ref));
    assert.deepEqual(result, { text: "fictional-1", blocks: 1 });
    assert.equal((await cache.status()).blocks[0].blockId, block.blockId);
}));

test("dead process writer is recoverable and old tokens stay fenced", async () => fixture(async root => {
    const script = `import {openProgressiveCache} from './src/conversation-progressive-cache.ts';
        const cache = await openProgressiveCache({root: process.argv[1], source: JSON.parse(process.argv[2])});
        console.log(JSON.stringify(await cache.beginWrite()));`;
    const oldWriter = JSON.parse(await child(script, root, JSON.stringify(source)));
    const cache = await openProgressiveCache({ root, source });
    const writer = await cache.beginWrite();
    await assert.rejects(cache.publish(oldWriter, input(1, 1)), { code: "stale_writer" });
    await cache.publish(writer, input(1, 1));
    await cache.cancel(writer);
}));

test("coverage rejects holes, overlaps, changed revision and invalid canonical ranges", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source: { ...source, totalRounds: 4 } });
    const writer = await cache.beginWrite();
    await cache.publish(writer, input(2, 3));
    await assert.rejects(cache.publish(writer, input(3, 4)), { code: "overlapping_range" });
    await assert.rejects(cache.publish(writer, input(5, 5)), { code: "invalid_range" });
    const invalid = input(1, 1); invalid.rounds = [];
    await assert.rejects(cache.publish(writer, invalid), { code: "invalid_range" });
    assert.equal((await cache.read({ startRound: 1, endRound: 4 })).requestedRangeComplete, false);
    await assert.rejects(openProgressiveCache({ root, source: { ...source, revision: "different" } }), { code: "source_mismatch" });
    await cache.cancel(writer);
}));

test("corruption is detected before first row is yielded and result budgets fail explicitly", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source, limits: { maxResultBytes: 20 } });
    const writer = await cache.beginWrite();
    const block = await cache.publish(writer, input(1, 1));
    await assert.rejects(cache.read(), { code: "size_limit" });
    assert.equal((await cache.iterate().next()).value?.round.roundIndex, 1);
    await cache.cancel(writer);
    const filename = path.join(root, `block-${block.sha256}.jsonl`);
    await fs.appendFile(filename, "corruption");
    await assert.rejects(cache.iterate().next(), { code: "corrupt_cache" });
}));

test("search role filtering and size bounds preserve existing matcher defaults", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source, limits: { maxSearchMessages: 4 } });
    const writer = await cache.beginWrite();
    const ready = input(1, 1);
    ready.messages = [...ready.messages, { id: "tool-1", round: 1, role: "tool", text: "toolonly", position: {} }];
    await cache.publish(writer, ready);
    assert.equal((await cache.search({ query: "toolonly" })).match, null);
    assert.equal((await cache.search({ query: "toolonly", messageRoles: ["tool"] })).match?.occurrences, 1);
    await cache.publish(writer, input(2, 2));
    await assert.rejects(cache.search({ query: "fictional" }), { code: "size_limit" });
    await cache.cancel(writer);
}));

test("cancel capability crosses process boundary and fences the original live writer", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source });
    const writer = await cache.beginWrite();
    await cache.publish(writer, input(1, 1));
    const script = `import {openProgressiveCache} from './src/conversation-progressive-cache.ts';
        const cache = await openProgressiveCache({root: process.argv[1], source: JSON.parse(process.argv[2])});
        console.log((await cache.cancel(JSON.parse(process.argv[3]))).state);`;
    assert.equal((await child(script, root, JSON.stringify(source), JSON.stringify(writer))).trim(), "cancelled");
    await assert.rejects(cache.publish(writer, input(2, 2)), { code: "stale_writer" });
    const replacement = await cache.beginWrite();
    await cache.publish(replacement, input(2, 2));
    await cache.cancel(replacement);
}));

test("concurrent publication commits every block and readers retain an immutable manifest view", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source });
    const writer = await cache.beginWrite();
    const outcomes = await Promise.allSettled([2, 3, 4, 5, 6].map(round => cache.publish(writer, input(round, round))));
    assert.deepEqual(outcomes.filter(result => result.status === "rejected").map(result => String(result.reason)), []);
    const iterator = cache.iterate({ direction: "oldest" });
    assert.equal((await iterator.next()).value?.round.roundIndex, 2);
    await cache.publish(writer, input(1, 1));
    await cache.cancel(writer);
    const remainder: number[] = [];
    for await (const row of iterator) remainder.push(row.round.roundIndex);
    assert.deepEqual(remainder, [3, 4, 5, 6]);
    assert.deepEqual((await cache.read({ direction: "oldest" })).rounds.map(round => round.roundIndex), [1, 2, 3, 4, 5, 6]);
    assert.equal((await fs.readdir(root)).filter(name => name.startsWith("pending-")).length, 0);
}));

test("source revision and relative ordering ambiguity fail explicitly", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source });
    const writer = await cache.beginWrite();
    const first = input(1, 1, { relative: true, anchor: "first" });
    delete first.order;
    const second = input(1, 1, { relative: true, anchor: "second" });
    delete second.order;
    await assert.rejects(cache.publish(writer, { ...first, sourceRevision: "subset-revision" }), { code: "source_mismatch" });
    const block = await cache.publish(writer, first);
    await cache.publish(writer, second);
    await assert.rejects(cache.read(), { code: "ambiguous_order" });
    assert.equal((await cache.read({ blockId: block.blockId })).rows.length, 1);
    await cache.cancel(writer);
}));

test("a dead transaction owner can be reclaimed without age-based live-owner takeover", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source });
    const deadPid = Number((await child("console.log(process.pid)")).trim());
    const lockDirectory = path.join(root, "transaction.lock");
    await fs.mkdir(lockDirectory);
    await fs.writeFile(path.join(lockDirectory, "owner.json"), JSON.stringify({ token: "fictional-dead-owner", pid: deadPid }));
    const reopened = await openProgressiveCache({ root, source });
    const writer = await reopened.beginWrite();
    await reopened.publish(writer, input(1, 1));
    await reopened.cancel(writer);
    assert.equal((await cache.status()).blocks.length, 1);
}));

test("directory links are rejected even when pointing inside the fixture", async () => fixture(async root => {
    const target = path.join(root, "target"); const linked = path.join(root, "linked");
    await fs.mkdir(target);
    await fs.symlink(target, linked, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(openProgressiveCache({ root: linked, source }), { code: "unsafe_path" });
}));

test("building in a different order or extending snapshot does not change logical references", async () => fixture(async root => {
    const first = await openProgressiveCache({ root: path.join(root, "latest-first"), source });
    const second = await openProgressiveCache({ root: path.join(root, "oldest-first"), source: { ...source, snapshot: { files: ["earlier-fictional.jsonl", "fictional.jsonl"] } } });
    const writerFirst = await first.beginWrite(); const writerSecond = await second.beginWrite();
    const recent = input(1, 1, { relative: true, anchor: "recent" });
    const older = input(1, 1, { relative: true, anchor: "older" });
    const original = await first.publish(writerFirst, { ...recent, order: 0 });
    await first.publish(writerFirst, { ...older, order: -1 });
    await second.publish(writerSecond, { ...older, order: 0 });
    const alternate = await second.publish(writerSecond, { ...recent, order: 1 });
    assert.equal(alternate.blockId, original.blockId);
    assert.notEqual(alternate.sha256, original.sha256);
    const originalRow = (await first.read({ blockId: original.blockId })).rows[0];
    assert.deepEqual((await second.locate(originalRow.ref)).round, originalRow.round);
    const reused = await first.publish(writerFirst, { ...recent, order: 99, sourceSnapshot: { files: ["expanded-fictional.jsonl"] } });
    assert.equal(reused.blockId, original.blockId);
    assert.deepEqual(reused.sourceSnapshot, original.sourceSnapshot);
    await first.cancel(writerFirst); await second.cancel(writerSecond);
}));

test("self-contained body remains readable after the original fictional cache is removed", async () => fixture(async root => {
    const previousCache = path.join(root, "previous-cache.json");
    const ready = input(1, 1);
    await fs.writeFile(previousCache, JSON.stringify(ready));
    const cacheSource = { ...source, snapshot: { previousCache } };
    const cache = await openProgressiveCache({ root: path.join(root, "sidecar"), source: cacheSource });
    const writer = await cache.beginWrite();
    await cache.publish(writer, ready);
    const ref = (await cache.read()).rows[0].ref;
    await cache.cancel(writer);
    await fs.unlink(previousCache);
    const reopened = await openProgressiveCache({ root: path.join(root, "sidecar"), source: cacheSource });
    assert.deepEqual((await reopened.locate(ref)).round, ready.rounds[0]);
}));

test("empty complete source and forged complete manifest have accurate status", async () => fixture(async root => {
    const empty = await openProgressiveCache({ root: path.join(root, "empty"), source: { ...source, totalRounds: 0 } });
    const emptyWriter = await empty.beginWrite();
    assert.equal((await empty.finish(emptyWriter)).complete, true);
    assert.equal((await empty.read()).requestedRangeComplete, true);
    const cache = await openProgressiveCache({ root: path.join(root, "partial"), source: { ...source, totalRounds: 2 } });
    const writer = await cache.beginWrite();
    await cache.publish(writer, input(2, 2));
    await cache.cancel(writer);
    const filename = path.join(root, "partial", "manifest.json");
    const manifest = JSON.parse(await fs.readFile(filename, "utf8"));
    manifest.state = "complete";
    await fs.writeFile(filename, JSON.stringify(manifest));
    await assert.rejects(cache.status(), { code: "corrupt_cache" });
}));

test("atomic transaction ownership tolerates repeated short publication contention", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source });
    const writer = await cache.beginWrite();
    const failures: string[] = [];
    for (let batch = 0; batch < 8; batch++) {
        const outcomes = await Promise.allSettled(Array.from({ length: 5 }, (_, offset) => {
            const round = batch * 5 + offset + 1;
            return cache.publish(writer, input(round, round));
        }));
        failures.push(...outcomes.filter(result => result.status === "rejected").map(result => String(result.reason)));
    }
    assert.deepEqual(failures, []);
    assert.equal((await cache.status()).coveredAbsoluteRounds, 40);
    await cache.cancel(writer);
    assert.deepEqual((await fs.readdir(root)).filter(name => /pending-|candidate-|released-|retired-|transaction\.lock/.test(name)), []);
}));

test("different processes can safely publish using the same writer capability", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source });
    const writer = await cache.beginWrite();
    const script = `import {openProgressiveCache} from './src/conversation-progressive-cache.ts';
        const cache = await openProgressiveCache({root: process.argv[1], source: JSON.parse(process.argv[2])});
        const writer = JSON.parse(process.argv[3]);
        for (const range of JSON.parse(process.argv[4])) await cache.publish(writer, range);
        console.log('published');`;
    const results = await Promise.allSettled([0, 5].map(offset => child(script, root, JSON.stringify(source), JSON.stringify(writer),
        JSON.stringify(Array.from({ length: 5 }, (_, index) => input(offset + index + 1, offset + index + 1))))));
    assert.deepEqual(results.filter(result => result.status === "rejected").map(result => String(result.reason)), []);
    assert.deepEqual((await cache.status()).absoluteRanges, [{ startRound: 1, endRound: 10 }]);
    await cache.cancel(writer);
}));

test("release retains readable partial coverage and fences the token without cancellation", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source: { ...source, totalRounds: 3 } });
    const writer = await cache.beginWrite();
    await cache.publish(writer, input(2, 3));
    const before = await cache.status();
    const ref = (await cache.read()).rows[0].ref;
    const released = await cache.release(writer);
    assert.equal(released.state, "idle");
    assert.equal(released.complete, false);
    assert.equal(released.version, before.version + 1);
    assert.deepEqual(released.blocks, before.blocks);
    assert.deepEqual(released.completeRanges, before.completeRanges);
    assert.equal((await cache.locate(ref)).ref, ref);
    await assert.rejects(cache.publish(writer, input(1, 1)), { code: "stale_writer" });
    await assert.rejects(cache.release(writer), { code: "stale_writer" });
    await assert.rejects(cache.cancel(writer), { code: "stale_writer" });
    const next = await cache.beginWrite();
    await cache.publish(next, input(1, 1));
    assert.equal((await cache.release(next)).complete, false);
    const finisher = await cache.beginWrite();
    assert.equal((await cache.finish(finisher)).complete, true);
}));

test("release accepts the writer capability from another process and permits reopen", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source });
    const writer = await cache.beginWrite();
    await cache.publish(writer, input(1, 1));
    const script = `import {openProgressiveCache} from './src/conversation-progressive-cache.ts';
        const cache = await openProgressiveCache({root: process.argv[1], source: JSON.parse(process.argv[2])});
        console.log((await cache.release(JSON.parse(process.argv[3]))).state);`;
    assert.equal((await child(script, root, JSON.stringify(source), JSON.stringify(writer))).trim(), "idle");
    const reopened = await openProgressiveCache({ root, source });
    const next = await reopened.beginWrite();
    assert.equal((await reopened.read()).rows.length, 1);
    await reopened.release(next);
}));

test("readLatest counts across relative blocks in publication or explicit order without renumbering", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source });
    const writer = await cache.beginWrite();
    const publish = async (anchor: string) => {
        const ready = input(1, 4, { relative: true, anchor, text: anchor });
        delete ready.order;
        return cache.publish(writer, ready);
    };
    const recent = await publish("recent");
    const older = await publish("older");
    await publish("oldest");
    await cache.release(writer);
    const latest = await cache.readLatest({ blockOrder: "publication" }, 6);
    assert.equal(latest.selectionScope, "published");
    assert.equal(latest.requestedRounds, 6);
    assert.equal(latest.returnedRounds, 6);
    assert.equal(latest.requestedRangeComplete, true);
    assert.equal(latest.status.complete, false);
    assert.deepEqual(latest.rows.map(row => [row.blockId, row.round.roundIndex]), [
        [recent.blockId, 4], [recent.blockId, 3], [recent.blockId, 2], [recent.blockId, 1], [older.blockId, 4], [older.blockId, 3],
    ]);
    assert.equal(new Set(latest.rows.map(row => row.ref)).size, 6);
    for (const row of latest.rows) assert.deepEqual((await cache.locate(row.ref)).round, row.round);
    const reversed = await cache.readLatest({ blockIds: [older.blockId, recent.blockId] }, 5);
    assert.deepEqual(reversed.rows.map(row => row.messages[0].text), ["older", "older", "older", "older", "recent"]);
    assert.deepEqual(reversed.rows.map(row => row.round.roundIndex), [4, 3, 2, 1, 4]);
    const forward = await cache.read({ blockIds: [older.blockId, recent.blockId], direction: "oldest" });
    assert.deepEqual(forward.rows.map(row => row.round.roundIndex), [1, 2, 3, 4, 1, 2, 3, 4]);
    assert.equal(forward.requestedRangeComplete, true);
    const insufficient = await cache.readLatest({ blockIds: [recent.blockId] }, 10);
    assert.equal(insufficient.returnedRounds, 4);
    assert.equal(insufficient.requestedRangeComplete, false);
}));

test("readLatest stops disk reads at its window and preserves source-order defaults", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source });
    const writer = await cache.beginWrite();
    const older = await cache.publish(writer, { ...input(1, 2, { relative: true, anchor: "older", text: "older" }), order: -1 });
    const recent = await cache.publish(writer, { ...input(1, 2, { relative: true, anchor: "recent", text: "recent" }), order: 0 });
    await cache.release(writer);
    assert.equal((await cache.readLatest({}, 1)).messages[0].text, "recent");
    assert.equal((await cache.readLatest({ blockOrder: "publication" }, 1)).messages[0].text, "older");
    await fs.appendFile(path.join(root, `block-${older.sha256}.jsonl`), "fictional-corruption");
    assert.equal((await cache.readLatest({}, 2)).returnedRounds, 2);
    assert.equal((await cache.readLatest({ blockIds: [recent.blockId] }, 1)).rows.length, 1);
    await assert.rejects(cache.readLatest({}, 3), { code: "corrupt_cache" });
}));

test("readLatest validates bounds and IDs and enforces the same byte budget", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source });
    assert.equal((await cache.readLatest({}, 100)).returnedRounds, 0);
    const writer = await cache.beginWrite();
    const block = await cache.publish(writer, input(1, 2));
    await cache.release(writer);
    await assert.rejects(cache.readLatest({}, 0), { code: "invalid_range" });
    await assert.rejects(cache.readLatest({}, 1.5), { code: "invalid_range" });
    await assert.rejects(cache.readLatest({}, 100001), { code: "invalid_range" });
    await assert.rejects(cache.readLatest({ direction: "oldest" }, 1), { code: "invalid_range" });
    await assert.rejects(cache.readLatest({ startRound: 1 }, 1), { code: "invalid_range" });
    await assert.rejects(cache.readLatest({ blockIds: [] }, 1), { code: "invalid_range" });
    await assert.rejects(cache.readLatest({ blockIds: [block.blockId, block.blockId] }, 1), { code: "invalid_range" });
    await assert.rejects(cache.readLatest({ blockId: block.blockId, blockIds: [block.blockId] }, 1), { code: "invalid_range" });
    await assert.rejects(cache.readLatest({ blockIds: [block.blockId], blockOrder: "publication" }, 1), { code: "invalid_range" });
    await assert.rejects(cache.readLatest({ blockIds: ["0".repeat(64)] }, 1), { code: "unpublished_ref" });
    const one = await cache.readLatest({}, 1);
    const limited = await openProgressiveCache({ root, source, limits: { maxResultBytes: Buffer.byteLength(JSON.stringify(one.rows[0])) } });
    assert.equal((await limited.readLatest({}, 1)).returnedRounds, 1);
    await assert.rejects(limited.readLatest({}, 2), { code: "size_limit" });
}));

test("readLatest returns an actual 100-round window across four chunk-local blocks", async () => fixture(async root => {
    const cache = await openProgressiveCache({ root, source });
    const writer = await cache.beginWrite();
    const blockIds: string[] = [];
    for (let chunk = 0; chunk < 4; chunk++) {
        const ready = input(1, 30, { relative: true, anchor: `chunk-${chunk}`, text: `chunk-${chunk}` });
        delete ready.order;
        blockIds.push((await cache.publish(writer, ready)).blockId);
    }
    await cache.release(writer);
    const result = await cache.readLatest({ blockIds }, 100);
    assert.equal(result.returnedRounds, 100);
    assert.equal(result.messages.length, 200);
    assert.equal(result.requestedRangeComplete, true);
    assert.equal(result.status.complete, false);
    assert.deepEqual(blockIds.map(blockId => result.rows.filter(row => row.blockId === blockId).length), [30, 30, 30, 10]);
    assert.equal(result.rows.at(-1)?.round.roundIndex, 21);
    assert.equal(new Set(result.rows.map(row => row.ref)).size, 100);
}));
