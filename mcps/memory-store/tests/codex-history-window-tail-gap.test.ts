import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readCodexHistoryWindow } from "../src/codex-history-window.js";
import { resolveCodexStreamingHistorySource, scanCodexStreamingHistory } from "../src/codex-history-source.js";
import { projectProgressiveSource } from "../src/conversation-progressive-projection.js";

const conversationId = "10000000-0000-4000-8000-000000000063";
const ancestorId = "20000000-0000-4000-8000-000000000063";
const leafId = "30000000-0000-4000-8000-000000000063";
const archive = { maxCompressedBytes: 64 };

function fixture(rounds = 8) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tail-gap-"));
    const ancestor = path.join(directory, `rollout-2026-01-01T00-00-00-${conversationId}_${ancestorId}.jsonl.zst`);
    const leaf = path.join(directory, `rollout-2026-01-02T00-00-00-${conversationId}_${leafId}.jsonl`);
    const historyBase = { thread_id: ancestorId, end_ordinal_exclusive: 100, end_byte_offset: 4096 };
    const header = { ordinal: 100, type: "session_meta", payload: { id: conversationId, history_base: historyBase } };
    const events: any[] = [header];
    for (let index = 1; index <= rounds; index += 1) {
        events.push({ ordinal: 100 + events.length, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `question ${index}` }] } });
        events.push({ ordinal: 100 + events.length, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${index}` }] } });
    }
    fs.writeFileSync(ancestor, Buffer.alloc(128));
    const save = () => fs.writeFileSync(leaf, events.map(event => JSON.stringify(event)).join("\n") + "\n");
    save();
    const options = { conversationId, sourcePath: leaf, roots: [directory], archive, maxRounds: 2 };
    return { directory, ancestor, leaf, historyBase, header, events, save, options };
}

function healthyAncestorFixture() {
    const input = fixture(2);
    const events: any[] = [{ ordinal: 0, type: "session_meta", payload: { id: conversationId } }];
    for (let round = 1; round <= 49; round += 1) {
        events.push({ ordinal: events.length, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `parent question ${round}` }] } });
        events.push({ ordinal: events.length, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `parent answer ${round}` }] } });
    }
    events.push({ ordinal: 99, type: "event_msg", payload: { type: "task_complete" } });
    const text = events.map(event => JSON.stringify(event)).join("\n") + "\n";
    fs.rmSync(input.ancestor);
    input.ancestor = input.ancestor.slice(0, -4);
    fs.writeFileSync(input.ancestor, text);
    input.historyBase.end_byte_offset = Buffer.byteLength(text);
    input.save();
    return input;
}

test("latest plaintext leaf publishes relative range with declared ancestors unverified", async () => {
    const input = fixture();
    try {
        const result = await readCodexHistoryWindow(input.options);
        assert.deepEqual(result.messages.filter(message => message.role === "user").map(message => message.text), ["question 7", "question 8"]);
        assert.deepEqual(result.source.snapshot.segments.map(segment => segment.path), [input.leaf]);
        assert.deepEqual(result.source.snapshot.unverifiedHistoryBase, { rolloutId: ancestorId, endOrdinalExclusive: 100, endByte: 4096 });
        assert.equal(result.source.snapshot.sourceRangeVerified, false);
        assert.equal(result.coverage.historyStartReached, false);
        assert.equal(result.coverage.snapshotEndReached, true);
        assert.equal(result.coverage.kind, "chunk-local");
        assert.equal(result.coverage.requestedRangeComplete, true);
        const projected = projectProgressiveSource(result.source, {});
        assert.equal((projected.snapshot as { source: { sourceRangeVerified: boolean } }).source.sourceRangeVerified, false);
        assert.ok(result.messages.every(message => message.position.path === input.leaf && message.position.ordinal! > 100));
        const repeated = await readCodexHistoryWindow({ ...input.options, maxRounds: 3 });
        assert.equal(repeated.source.revision, result.source.revision);
        assert.equal(repeated.rangeId, result.rangeId);
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

test("full discovery, oldest and continueHistory retain ancestor archive limits", async () => {
    const input = fixture();
    try {
        await assert.rejects(resolveCodexStreamingHistorySource(input.leaf, { roots: [input.directory], archive }), /compressed size limit/u);
        await assert.rejects(readCodexHistoryWindow({ ...input.options, direction: "oldest" }), /compressed size limit/u);
        await assert.rejects(readCodexHistoryWindow({ ...input.options, continueHistory: true }), /compressed size limit/u);
        const partial = await resolveCodexStreamingHistorySource(input.leaf, { roots: [input.directory], archive, deferAncestors: true });
        await assert.rejects(scanCodexStreamingHistory(partial, () => {}), /requires verified ancestry/u);
        await assert.rejects(readCodexHistoryWindow({ ...input.options, source: partial, continueHistory: true }), /deferred ancestry/u);
        await assert.rejects(readCodexHistoryWindow({ ...input.options, source: partial, direction: "oldest" }), /deferred ancestry/u);
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

test("short leaf preserves partial publication when strict ancestor recovery hits its cap", async () => {
    const input = fixture(2);
    try {
        const published: Awaited<ReturnType<typeof readCodexHistoryWindow>>[] = [];
        await assert.rejects(readCodexHistoryWindow({ ...input.options, onRange: range => { published.push(range); } }), /compressed size limit/u);
        assert.equal(published.length, 1);
        const result = published[0]!;
        assert.deepEqual(result.messages.filter(message => message.role === "user").map(message => message.text), ["question 2"]);
        assert.equal(result.coverage.requestedRangeComplete, false);
        assert.equal(result.coverage.historyStartReached, false);
        assert.equal(result.source.snapshot.sourceRangeVerified, false);
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

test("short leaf automatically fills the same request from a strictly resolved ancestor", async () => {
    const input = healthyAncestorFixture();
    try {
        const published: Awaited<ReturnType<typeof readCodexHistoryWindow>>[] = [];
        const result = await readCodexHistoryWindow({ ...input.options, onRange: range => { published.push(range); } });
        assert.deepEqual(result.messages.filter(message => message.role === "user").map(message => message.text), ["question 1", "question 2"]);
        assert.equal(result.coverage.requestedRangeComplete, true);
        assert.equal(result.source.snapshot.unverifiedHistoryBase, undefined);
        assert.equal(result.source.snapshot.segments.length, 2);
        assert.notEqual(published[0]!.source.revision, result.source.revision);
        assert.equal(published[0]!.source.snapshot.sourceRangeVerified, false);
        assert.equal(result.progress.bytesRead, fs.statSync(input.leaf).size * 2 + fs.statSync(input.ancestor).size);
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

test("ancestor refill shares the original byte budget and cancellation", async () => {
    const input = healthyAncestorFixture();
    try {
        const totalBytes = fs.statSync(input.leaf).size * 2 + fs.statSync(input.ancestor).size;
        let publications = 0;
        await assert.rejects(readCodexHistoryWindow({ ...input.options, maxReadBytes: totalBytes - 1,
            onRange: () => { publications += 1; } }), /read byte limit/u);
        assert.equal(publications, 1);
        const complete = await readCodexHistoryWindow({ ...input.options, maxReadBytes: totalBytes });
        assert.equal(complete.progress.bytesRead, totalBytes);
        let stop = false;
        await assert.rejects(readCodexHistoryWindow({ ...input.options, isCancelled: () => stop,
            onRange: () => { stop = true; } }), /cancelled/u);
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

for (const kind of ["false-only", "unverified-base"] as const) {
    test(`full scan rejects zero-start ${kind} before any filesystem or event work`, async () => {
        const input = fixture(0);
        try {
            const header = { ordinal: 0, type: "session_meta", payload: { id: conversationId } };
            fs.writeFileSync(input.leaf, JSON.stringify(header) + "\n" + JSON.stringify({ ordinal: 1, type: "event_msg", payload: { type: "user_message", message: "fixture" } }) + "\n");
            const source = await resolveCodexStreamingHistorySource(input.leaf, { roots: [input.directory] });
            if (kind === "false-only") source.sourceRangeVerified = false;
            else source.unverifiedHistoryBase = { rolloutId: ancestorId, endOrdinalExclusive: 0, endByte: 4096 };
            let stats = 0;
            let reads = 0;
            let events = 0;
            let proofs = 0;
            const originalStat = fsPromises.stat;
            const originalStream = fs.createReadStream;
            fsPromises.stat = (async (...arguments_: any[]) => { stats += 1; return (originalStat as Function)(...arguments_); }) as typeof fsPromises.stat;
            fs.createReadStream = ((...arguments_: any[]) => { reads += 1; return (originalStream as Function)(...arguments_); }) as typeof fs.createReadStream;
            try {
                await assert.rejects(scanCodexStreamingHistory(source, () => { events += 1; }, {
                    replayFrom: { path: input.leaf, startByte: 0, endByte: 0, ordinal: 0 },
                    previousVerification: { revision: "fixture", sourceBytes: 0, segments: [] },
                    onPrefixProof: () => { proofs += 1; },
                }), /requires verified ancestry/u);
                assert.deepEqual({ stats, reads, events, proofs }, { stats: 0, reads: 0, events: 0, proofs: 0 });
            } finally { fsPromises.stat = originalStat; fs.createReadStream = originalStream; }
        } finally { fs.rmSync(input.directory, { recursive: true }); }
    });
}

test("leaf body ordinals cannot precede its declared start or overflow their successor", async () => {
    const input = fixture(12);
    try {
        for (let index = 1; index < input.events.length; index += 1) input.events[index].ordinal = index;
        input.save();
        let publications = 0;
        await assert.rejects(readCodexHistoryWindow({ ...input.options, onRange: () => { publications += 1; } }), /ordinal ordering mismatch/u);
        assert.equal(publications, 0);
        for (let index = 1; index < input.events.length; index += 1) input.events[index].ordinal = 100 + index * 3;
        input.save();
        assert.equal((await readCodexHistoryWindow(input.options)).rounds.length, 2);
        input.events.at(-1).ordinal = Number.MAX_SAFE_INTEGER;
        input.save();
        await assert.rejects(readCodexHistoryWindow({ ...input.options, onRange: () => { publications += 1; } }), /ordinal ordering mismatch/u);
        assert.equal(publications, 0);
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

test("metadata-selected path wins over newer unrelated filenames", async () => {
    const input = fixture();
    try {
        const otherId = "40000000-0000-4000-8000-000000000063";
        const other = path.join(input.directory, `rollout-2030-01-01T00-00-00-${conversationId}_${otherId}.jsonl`);
        fs.writeFileSync(other, JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id: conversationId } }) + "\n");
        const result = await readCodexHistoryWindow(input.options);
        assert.equal(result.source.snapshot.leafPath, input.leaf);
        assert.ok(result.messages.every(message => message.position.path === input.leaf));
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

test("foreign session identity and inconsistent ordinal header fail before publication", async () => {
    const input = fixture();
    try {
        let publications = 0;
        input.header.payload.id = ancestorId;
        input.save();
        await assert.rejects(readCodexHistoryWindow({ ...input.options, onRange: () => { publications += 1; } }), /does not match rollout filename/u);
        input.header.payload.id = conversationId;
        input.header.ordinal = 99;
        input.save();
        await assert.rejects(readCodexHistoryWindow({ ...input.options, onRange: () => { publications += 1; } }), /header mismatch/u);
        assert.equal(publications, 0);
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

test("self-referential ancestry and compressed replicas remain rejected", async () => {
    const input = fixture();
    try {
        input.historyBase.thread_id = leafId;
        input.save();
        await assert.rejects(readCodexHistoryWindow(input.options), /Circular/u);
        input.historyBase.thread_id = ancestorId;
        input.save();
        fs.writeFileSync(`${input.leaf}.zst`, Buffer.alloc(128));
        await assert.rejects(readCodexHistoryWindow(input.options), /replica verification required/u);
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

test("leaf byte and record budgets and callback cancellation remain enforced", async () => {
    const input = fixture();
    try {
        await assert.rejects(readCodexHistoryWindow({ ...input.options, maxReadBytes: 1 }), /read byte limit/u);
        await assert.rejects(readCodexHistoryWindow({ ...input.options, maxRecordBytes: 16 }), /record byte limit/u);
        let stop = false;
        await assert.rejects(readCodexHistoryWindow({ ...input.options, isCancelled: () => stop, onRange: () => { stop = true; } }), /cancelled/u);
        const source = await resolveCodexStreamingHistorySource(input.leaf, { roots: [input.directory], archive, deferAncestors: true });
        fs.appendFileSync(input.leaf, "\n");
        await assert.rejects(readCodexHistoryWindow({ ...input.options, source }), /source changed/u);
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});
