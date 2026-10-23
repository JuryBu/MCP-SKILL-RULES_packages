import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import test from "node:test";
import { readCodexHistoryWindow, hashCodexHistoryWindowCanonical } from "../src/codex-history-window.js";
import { codexHistoryPhysicalIdentity, type CodexStreamingHistorySource } from "../src/codex-history-source.js";
import { createCodexCorpusCollector } from "../src/conversation-corpus-reader-projection.js";
import { openProgressiveCache } from "../src/conversation-progressive-cache.js";

const conversationId = "10000000-0000-4000-8000-000000000059";
const timestamp = "2026-01-01T00:00:00Z";
function fixture(rounds = 8) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-window-fiction-"));
    const filename = path.join(directory, `rollout-2026-01-01T00-00-00-${conversationId}.jsonl`);
    const events: any[] = [{ ordinal: 0, type: "session_meta", payload: { id: conversationId } }];
    for (let index = 1; index <= rounds; index += 1) {
        events.push({ ordinal: events.length, timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `question ${index}` }] } });
        events.push({ ordinal: events.length, timestamp, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${index}` }] } });
    }
    const header = JSON.stringify(events[0]);
    fs.writeFileSync(filename, events.map(event => JSON.stringify(event)).join("\n") + "\n");
    const snapshot = (): CodexStreamingHistorySource => ({ leafPath: filename, segments: [{ path: filename, replicas: [], threadId: conversationId, rolloutId: conversationId, startOrdinal: 0, ordinalMode: "explicit", physical: codexHistoryPhysicalIdentity(fs.statSync(filename)), headerSha256: createHash("sha256").update(header).digest("hex") }] });
    return { filename, directory, events, snapshot };
}

test("latest and oldest canonical windows carry timestamps and LF-inclusive raw anchors", async () => {
    const input = fixture();
    try {
        const latest = await readCodexHistoryWindow({ conversationId, source: input.snapshot(), maxRounds: 3 });
        const oldest = await readCodexHistoryWindow({ conversationId, source: input.snapshot(), maxRounds: 3, direction: "oldest" });
        assert.deepEqual(latest.messages.filter(message => message.role === "user").map(message => message.text), ["question 6", "question 7", "question 8"]);
        assert.deepEqual(oldest.messages.filter(message => message.role === "user").map(message => message.text), ["question 1", "question 2", "question 3"]);
        for (const message of latest.messages) {
            assert.equal(message.timestamp, timestamp);
            assert.equal(message.position.path, input.filename);
            const bytes = fs.readFileSync(input.filename).subarray(message.position.startByte, message.position.endByte);
            assert.equal(bytes.at(-1), 10);
            assert.equal(JSON.parse(bytes.toString("utf8")).ordinal, message.position.ordinal);
        }
        assert.equal(latest.source.revision, oldest.source.revision);
        assert.equal(latest.coverage.kind, "chunk-local");
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

test("fixed revision survives different selected counts and callbacks declare replacement", async () => {
    const input = fixture();
    try {
        const published: string[] = [];
        const small = await readCodexHistoryWindow({ conversationId, source: input.snapshot(), maxRounds: 2, onRange: range => { assert.equal(range.publication, "replace"); published.push(range.source.revision); } });
        const larger = await readCodexHistoryWindow({ conversationId, source: input.snapshot(), maxRounds: 5 });
        assert.equal(small.source.revision, larger.source.revision);
        assert.equal(small.rangeId, larger.rangeId);
        assert.deepEqual(published, [larger.source.revision]);
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

test("fatal UTF-8 and changed fixed sources fail without publishing", async () => {
    const input = fixture();
    try {
        fs.appendFileSync(input.filename, Buffer.from([0xff, 10]));
        await assert.rejects(readCodexHistoryWindow({ conversationId, source: input.snapshot(), maxRounds: 1 }), /UTF-8/u);
        const fixed = input.snapshot();
        fs.appendFileSync(input.filename, "\n");
        await assert.rejects(readCodexHistoryWindow({ conversationId, source: fixed }), /source changed/u);
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

test("cancellation after a ready callback stops further publication", async () => {
    const input = fixture();
    try {
        let stop = false;
        await assert.rejects(readCodexHistoryWindow({ conversationId, source: input.snapshot(), isCancelled: () => stop, onRange: () => { stop = true; } }), /cancelled/u);
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

test("continueHistory publishes disjoint ranges without rereading a plaintext segment", async () => {
    const input = fixture(80);
    try {
        for (const direction of ["latest", "oldest"] as const) {
            const chunks: Awaited<ReturnType<typeof readCodexHistoryWindow>>[] = [];
            const result = await readCodexHistoryWindow({ conversationId, source: input.snapshot(), direction, maxRounds: 6, rangeRounds: 3, continueHistory: true, onRange: range => { chunks.push(range); } });
            assert.ok(chunks.length > 2);
            assert.ok(chunks.every(chunk => chunk.publication === "append" && chunk.source.revision === result.source.revision));
            const messages = chunks.flatMap(chunk => chunk.messages);
            assert.equal(messages.length, 160);
            assert.equal(new Set(messages.map(message => message.id)).size, 160);
            assert.equal(new Set(chunks.map(chunk => chunk.rangeId)).size, chunks.length);
            const ordered = [...messages].sort((left, right) => left.position.startByte! - right.position.startByte!);
            assert.deepEqual(ordered.filter(message => message.role === "user").map(message => message.text), Array.from({ length: 80 }, (_, index) => `question ${index + 1}`));
            assert.equal(chunks.at(-1)!.progress.bytesRead, fs.statSync(input.filename).size);
            assert.deepEqual(result.messages.filter(message => message.role === "user").map(message => message.text), Array.from({ length: 6 }, (_, index) => `question ${direction === "latest" ? 75 + index : 1 + index}`));
        }
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

test("adopted byte and ordinal boundaries preserve consecutive human supplements", async () => {
    const input = fixture(40);
    try {
        const original = input.events;
        const cut = 42;
        const parentEvents = original.slice(0, cut);
        const supplement = { ordinal: cut, timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "continued question" }] } };
        const parentBytes = Buffer.byteLength(parentEvents.map(event => JSON.stringify(event)).join("\n") + "\n");
        const childHeader = { ordinal: cut, type: "session_meta", payload: { id: conversationId, history_base: { thread_id: conversationId, end_byte_offset: parentBytes, end_ordinal_exclusive: cut } } };
        const childEvents = [childHeader, { ...supplement, ordinal: cut + 1 }, ...original.slice(cut).map(event => ({ ...event, ordinal: event.ordinal + 2 }))];
        fs.writeFileSync(input.filename, parentEvents.map(event => JSON.stringify(event)).join("\n") + "\n");
        const childPath = path.join(input.directory, "child.jsonl");
        fs.writeFileSync(childPath, childEvents.map(event => JSON.stringify(event)).join("\n") + "\n");
        const parent = input.snapshot().segments[0]!;
        parent.endByte = fs.statSync(input.filename).size;
        parent.endOrdinalExclusive = cut;
        const child = { ...parent, path: childPath, rolloutId: "child", startOrdinal: cut, endByte: undefined, endOrdinalExclusive: undefined, physical: codexHistoryPhysicalIdentity(fs.statSync(childPath)), headerSha256: createHash("sha256").update(JSON.stringify(childHeader)).digest("hex") };
        const source = { leafPath: childPath, segments: [parent, child] };
        const expected: any[] = [];
        const collector = createCodexCorpusCollector({ conversationId, retainPositions: true, onRound: (_round, messages) => { expected.push(...messages); } });
        for (const segment of source.segments) {
            let startByte = 0;
            for (const line of fs.readFileSync(segment.path, "utf8").trimEnd().split("\n")) {
                const event = JSON.parse(line);
                const endByte = startByte + Buffer.byteLength(line) + 1;
                collector.addEvent(event, { path: segment.path, startByte, endByte, ordinal: event.ordinal });
                startByte = endByte;
            }
        }
        collector.finish();
        const chunks: any[] = [];
        await readCodexHistoryWindow({ conversationId, source, maxRounds: 7, rangeRounds: 3, continueHistory: true, onRange: range => { chunks.push(range); } });
        const actual = chunks.flatMap(chunk => chunk.messages).sort((left, right) => left.position.ordinal - right.position.ordinal);
        const normalize = (messages: any[]) => messages.map(({ round: _round, ...message }) => message);
        assert.deepEqual(normalize(actual), normalize(expected));
        const supplementChunk = chunks.find(chunk => chunk.messages.some((message: any) => message.text === "continued question"));
        const supplementRound = supplementChunk.rows.find((round: any) => round.messages.some((message: any) => message.text === "continued question"));
        assert.equal(supplementRound.messages.filter((message: any) => message.role === "user").length, 2);
        const broken = structuredClone(source);
        broken.segments[0]!.endOrdinalExclusive = cut - 1;
        await assert.rejects(readCodexHistoryWindow({ conversationId, source: broken, maxRounds: 100 }), /(?:ordinal boundary|adopted declaration)/u);
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

test("compressed leaf verifies its frame before callbacks and keeps exact metadata", async () => {
    const input = fixture(30);
    try {
        const source = input.snapshot();
        const compressedPath = `${input.filename}.zst`;
        fs.writeFileSync(compressedPath, zlib.zstdCompressSync(fs.readFileSync(input.filename)));
        source.leafPath = compressedPath;
        source.segments[0] = { ...source.segments[0]!, path: compressedPath, physical: codexHistoryPhysicalIdentity(fs.statSync(compressedPath)) };
        const result = await readCodexHistoryWindow({ conversationId, source, maxRounds: 3 });
        assert.ok(result.messages.every(message => message.timestamp === timestamp && message.position.path === compressedPath));
        assert.equal(result.messages[0]!.position.ordinal, 55);
        const broken = fs.readFileSync(compressedPath).subarray(0, -3);
        fs.writeFileSync(compressedPath, broken);
        source.segments[0]!.physical = codexHistoryPhysicalIdentity(fs.statSync(compressedPath));
        let callbacks = 0;
        await assert.rejects(readCodexHistoryWindow({ conversationId, source, maxRounds: 3, onRange: () => { callbacks += 1; } }));
        assert.equal(callbacks, 0);
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

test("ordered canonical hash normalizes JSON undefined only and detects body changes", () => {
    const message = { id: "fiction", round: 1, role: "user" as const, text: "fictional text", timestamp: undefined, position: { path: undefined, ordinal: 1 } };
    const persisted = JSON.parse(JSON.stringify(message));
    assert.equal(hashCodexHistoryWindowCanonical([message]), hashCodexHistoryWindowCanonical([persisted]));
    assert.notEqual(hashCodexHistoryWindowCanonical([message]), hashCodexHistoryWindowCanonical([{ ...message, text: "changed fictional text" }]));
    assert.notEqual(hashCodexHistoryWindowCanonical([message, { ...message, id: "second" }]), hashCodexHistoryWindowCanonical([{ ...message, id: "second" }, message]));
});

test("canonical raw chunks publish directly to progressive storage and old refs survive older blocks", async () => {
    const input = fixture(40);
    try {
        let cache: Awaited<ReturnType<typeof openProgressiveCache>> | undefined;
        let writer: Awaited<ReturnType<NonNullable<typeof cache>["beginWrite"]>> | undefined;
        let firstRef: string | undefined;
        let firstText: string | undefined;
        let order = 0;
        await readCodexHistoryWindow({ conversationId, source: input.snapshot(), maxRounds: 6, rangeRounds: 3, continueHistory: true, onRange: async range => {
            cache ??= await openProgressiveCache({ root: path.join(input.directory, "progressive"), source: range.source });
            writer ??= await cache.beginWrite();
            const block = await cache.publish(writer, { rounds: range.rounds, messages: range.messages, anchor: range.anchor, sourceRevision: range.source.revision, sourceSnapshot: range.source.snapshot, coverage: { kind: "relative", startRound: 1, endRound: range.rounds.length }, order: order-- });
            if (!firstRef) {
                const rows = await cache.read({ blockId: block.blockId });
                firstRef = rows.rows[0]!.ref;
                firstText = rows.rows[0]!.round.userMessage;
            }
        } });
        assert.equal((await cache!.status()).relativeReadyRounds, 40);
        const original = await cache!.locate(firstRef!);
        assert.equal(original.round.userMessage, firstText);
        assert.equal((await cache!.read()).messages.length, 80);
    } finally { fs.rmSync(input.directory, { recursive: true }); }
});

test("empty source returns explicit zero coverage and callback failures stop the reader", async () => {
    const input = fixture(0);
    try {
        const phases: string[] = [];
        let callbacks = 0;
        const result = await readCodexHistoryWindow({ conversationId, source: input.snapshot(), continueHistory: true, onRange: () => { callbacks += 1; }, onProgress: progress => { phases.push(progress.phase); } });
        assert.equal(result.messages.length, 0);
        assert.equal(result.coverage.endRound, 0);
        assert.equal(result.coverage.requestedRangeComplete, false);
        assert.equal(callbacks, 0);
        assert.equal(phases.at(-1), "complete");
    } finally { fs.rmSync(input.directory, { recursive: true }); }
    const populated = fixture(40);
    try {
        let callbacks = 0;
        await assert.rejects(readCodexHistoryWindow({ conversationId, source: populated.snapshot(), continueHistory: true, rangeRounds: 3, maxRounds: 6, onRange: async () => { callbacks += 1; await Promise.resolve(); throw new Error("fictional callback failure"); } }), /fictional callback failure/u);
        assert.equal(callbacks, 1);
    } finally { fs.rmSync(populated.directory, { recursive: true }); }
});
