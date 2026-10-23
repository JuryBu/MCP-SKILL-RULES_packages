import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { constants, zstdCompressSync } from "node:zlib";
import { test } from "node:test";
import { streamCodexHistoryArchive, type CodexHistoryArchiveOptions } from "../src/codex-history-archive.ts";
import { proveCodexAdoptedPrefix } from "../src/codex-adopted-prefix-proof.ts";
import { codexHistoryPhysicalIdentity, readCodexStreamingSessionMeta } from "../src/codex-history-source.ts";

const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const archive = { maxCompressedBytes: 1024 * 1024, maxDecompressedBytes: 1024 * 1024, maxWindowBytes: 1024 * 1024, minFreeBytes: 0 };

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-layout-cache-"));
    const threadId = "00000000-0000-4000-8000-000000000059";
    const source = path.join(directory, `rollout-2026-01-01T00-00-00-${threadId}.jsonl.zst`);
    const header = Buffer.from(JSON.stringify({ type: "session_meta", payload: { id: threadId } }));
    const logical = Buffer.concat([header, Buffer.from("\nsynthetic-layout-content\n".repeat(4096))]);
    const compressed = zstdCompressSync(logical, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
    fs.writeFileSync(source, compressed);
    const proof = () => ({
        cacheRoot: path.join(directory, "proofs"),
        segment: { path: source, replicas: [], rolloutId: threadId, threadId, startOrdinal: 0, endOrdinalExclusive: 2, headerSha256: hash(header), ordinalMode: "legacy" as const, physical: codexHistoryPhysicalIdentity(fs.statSync(source)) },
        endByte: 1024, expectedSha256: hash(logical.subarray(0, 1024)), archive,
    });
    return { directory, source, logical, compressed, threadId, proof, close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

async function consume(source: string, options: CodexHistoryArchiveOptions = {}) {
    const chunks: Buffer[] = [];
    for await (const chunk of streamCodexHistoryArchive(source, { ...archive, ...options })) chunks.push(chunk);
    return Buffer.concat(chunks);
}

async function syncReadCount(operation: () => Promise<unknown>) {
    const original = fs.readSync;
    let reads = 0;
    fs.readSync = ((...args: any[]) => { reads++; return (original as (...values: any[]) => number)(...args); }) as typeof fs.readSync;
    try { await operation(); return reads; }
    finally { fs.readSync = original; }
}

test("session header layout is shared with a full prefix proof, not its content verification", async () => {
    const sample = fixture();
    try {
        assert.ok(await syncReadCount(async () => assert.equal((await readCodexStreamingSessionMeta(sample.source, archive)).id, sample.threadId)) > 0);
        let progress = 0;
        const reads = await syncReadCount(async () => {
            const proof = await proveCodexAdoptedPrefix({ ...sample.proof(), onProgress: () => progress++ });
            assert.equal(proof.cacheHit, false);
            assert.equal(proof.decodedBytes, sample.logical.length);
            assert.equal(proof.physicalSha256, hash(sample.compressed));
        });
        assert.equal(reads, 0, "Full proof repeated the frame layout read");
        assert.ok(progress > 0, "Layout reuse skipped full content decoding");
        const warm = await proveCodexAdoptedPrefix(sample.proof());
        assert.equal(warm.cacheHit, true);
        assert.equal(warm.decodedBytes, 0);
    } finally { sample.close(); }
});

test("a warm layout enforces new limits and cancellation, then permits a clean retry", async () => {
    const sample = fixture();
    try {
        assert.deepEqual(await consume(sample.source), sample.logical);
        for (const limits of [{ maxWindowBytes: 1 }, { maxDecompressedBytes: 1 }, { maxCompressedBytes: 1 }]) {
            await assert.rejects(consume(sample.source, limits));
        }
        let cancelled = false;
        await assert.rejects(proveCodexAdoptedPrefix({ ...sample.proof(), isCancelled: () => cancelled, onProgress: () => { cancelled = true; } }), { name: "AbortError" });
        assert.equal(fs.existsSync(sample.proof().cacheRoot), false);
        assert.equal((await proveCodexAdoptedPrefix(sample.proof())).cacheHit, false);
    } finally { sample.close(); }
});

test("same-size rewrites with restored mtime invalidate layouts and publish no corrupt proof", async () => {
    const sample = fixture();
    try {
        await consume(sample.source);
        const before = fs.statSync(sample.source);
        const corrupted = Buffer.from(sample.compressed);
        corrupted[corrupted.length - 1]! ^= 1;
        fs.writeFileSync(sample.source, corrupted);
        fs.utimesSync(sample.source, before.atime, before.mtime);
        assert.ok(await syncReadCount(async () => {
            await assert.rejects(proveCodexAdoptedPrefix(sample.proof()), /checksum|corruption/iu);
        }) > 0);
        assert.equal(fs.existsSync(sample.proof().cacheRoot), false);
        await assert.rejects(proveCodexAdoptedPrefix({ ...sample.proof(), archive: { ...archive, decoder: "fzstd" } }), /checksum/iu);
        assert.equal(fs.existsSync(sample.proof().cacheRoot), false);
        fs.writeFileSync(sample.source, Buffer.concat([sample.compressed, Buffer.from("tail")]));
        await assert.rejects(consume(sample.source), /magic|trailing/iu);
    } finally { sample.close(); }
});

test("complete layouts are LRU-bounded to 64 physical sources", async () => {
    const sample = fixture();
    try {
        await consume(sample.source);
        assert.equal(await syncReadCount(() => consume(sample.source)), 0);
        for (let index = 0; index < 64; index++) {
            const source = path.join(sample.directory, `source-${index}.jsonl.zst`);
            fs.writeFileSync(source, sample.compressed);
            await consume(source);
        }
        assert.ok(await syncReadCount(() => consume(sample.source)) > 0);
    } finally { sample.close(); }
});

test("the 4096 frame-record budget evicts older layouts and streams larger ones without retaining them", async () => {
    const sample = fixture();
    const skippable = Buffer.alloc(8);
    skippable.writeUInt32LE(0x184d2a50);
    try {
        const first = path.join(sample.directory, "first.jsonl.zst");
        const second = path.join(sample.directory, "second.jsonl.zst");
        fs.writeFileSync(first, Buffer.concat(Array.from({ length: 2049 }, () => skippable)));
        fs.writeFileSync(second, fs.readFileSync(first));
        await consume(first);
        assert.equal(await syncReadCount(() => consume(first)), 2049, "Only skippable payload reads should remain");
        await consume(second);
        assert.ok(await syncReadCount(() => consume(first)) > 2049);
        const oversized = path.join(sample.directory, "oversized.jsonl.zst");
        fs.writeFileSync(oversized, Buffer.concat(Array.from({ length: 4097 }, () => skippable)));
        const initial = await syncReadCount(async () => assert.equal((await consume(oversized)).length, 0));
        assert.equal(await syncReadCount(() => consume(oversized)), initial);
        assert.ok(initial > 4097);
    } finally { sample.close(); }
});
