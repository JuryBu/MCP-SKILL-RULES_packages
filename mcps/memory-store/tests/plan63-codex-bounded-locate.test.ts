import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { zstdCompressSync } from "node:zlib";

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "plan63-codex-bounded-")));
const originalHome = os.homedir;
const originalDataRoot = process.env.MEMORY_STORE_DATA_ROOT;
os.homedir = () => root;
process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
const client = await import("../src/codex-client.ts");
const history = await import("../src/codex-history-source.ts");
const marker = "synthetic context probe marker plan63";
const absent = "synthetic marker absent from all records";
const line = (value: unknown) => JSON.stringify(value) + "\n";
let nextId = 63;

function fixture(options: { large?: boolean; historyBase?: unknown; text?: string } = {}) {
    const id = `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;
    const file = path.join(root, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
    const text = line({ type: "session_meta", payload: { id, ...(options.historyBase ? { history_base: options.historyBase } : {}) } })
        + (options.large ? Array.from({ length: 1100 }, () => line({ type: "event_msg", payload: { type: "token_count", padding: "x".repeat(900) } })).join("") : "")
        + line({ type: "event_msg", payload: { type: "user_message", message: options.text ?? marker } });
    fs.writeFileSync(file, text);
    const thread = { id, rolloutPath: file, cwd: "synthetic-workspace", title: "synthetic", source: "codex" };
    return { file, text, thread };
}

async function measure<Result>(run: () => Result | Promise<Result>, onRead?: () => void) {
    const open = fs.openSync;
    const read = fs.readSync;
    const close = fs.closeSync;
    const readdir = fs.readdirSync;
    const readdirAsync = fsPromises.readdir;
    const descriptors = new Map<number, string>();
    const files = new Set<string>();
    let physicalReadBytes = 0;
    let readCalls = 0;
    fs.openSync = ((filename: fs.PathLike, ...args: unknown[]) => {
        const resolved = path.resolve(String(filename));
        assert.ok(resolved.startsWith(root + path.sep), `fixture escaped its isolated root: ${resolved}`);
        const descriptor = (open as Function)(filename, ...args);
        descriptors.set(descriptor, resolved);
        files.add(resolved);
        return descriptor;
    }) as typeof open;
    fs.readSync = ((descriptor: number, ...args: unknown[]) => {
        const count = (read as Function)(descriptor, ...args);
        if (descriptors.has(descriptor)) { physicalReadBytes += count; readCalls += 1; onRead?.(); }
        return count;
    }) as typeof read;
    fs.closeSync = ((descriptor: number) => { descriptors.delete(descriptor); return close(descriptor); }) as typeof close;
    fs.readdirSync = (() => { throw new Error("locate must not enumerate sessions or default roots"); }) as typeof readdir;
    fsPromises.readdir = (async () => { throw new Error("locate must not enumerate sessions or default roots"); }) as typeof readdirAsync;
    const started = performance.now();
    try {
        const result = await run();
        assert.equal(descriptors.size, 0, "all source descriptors must be closed");
        return { result, physicalReadBytes, readCalls, files: [...files], durationMs: performance.now() - started };
    } finally {
        fs.openSync = open;
        fs.readSync = read;
        fs.closeSync = close;
        fs.readdirSync = readdir;
        fsPromises.readdir = readdirAsync;
    }
}

function assertIo(measured: Awaited<ReturnType<typeof measure>>, window: { physicalReadBytes: number; readCalls: number }, maxBytes: number) {
    assert.equal(window.physicalReadBytes, measured.physicalReadBytes);
    assert.equal(window.readCalls, measured.readCalls);
    assert.ok(measured.physicalReadBytes <= maxBytes);
}

test("formal 1MiB rollout: legacy 64KiB probe has no hidden full-prefix read", async () => {
    const sample = fixture({ large: true });
    const measured = await measure(() => client.matchCodexContextProbeInRollout(sample.file, marker, { maxBytes: 65536 }));
    assert.equal(measured.result.length, 1);
    assert.ok(measured.physicalReadBytes <= 65536);
    assert.ok(Buffer.byteLength(sample.text) > 1024 * 1024);
    console.log("PLAN63_LEGACY_PROBE_IO", JSON.stringify({ sourceBytes: Buffer.byteLength(sample.text), budgetBytes: 65536,
        physicalReadBytes: measured.physicalReadBytes, readCalls: measured.readCalls, hits: measured.result.length, durationMs: measured.durationMs }));
});

test("async probe reports actual header plus tail I/O, byte ranges and relative rounds", async () => {
    const sample = fixture({ large: true });
    const measured = await measure(() => client.scanCodexContextProbeInRollout(sample.file, marker, { maxBytes: 65536 }));
    assertIo(measured, measured.result.window, 65536);
    assert.equal(measured.result.hits.length, 1);
    assert.equal(measured.result.hits[0].roundIndexIsRelative, true);
    assert.equal(measured.result.partial, true);
    assert.equal(measured.result.window.ranges.length, 2);
    assert.equal(measured.result.scannedBytes, measured.physicalReadBytes);
    assert.equal(measured.result.window.sourceReadBytes, measured.physicalReadBytes);
    for (const range of measured.result.window.ranges) assert.match(range.sha256, /^[a-f0-9]{64}$/u);
    console.log("PLAN63_ASYNC_PROBE_IO", JSON.stringify({ physicalReadBytes: measured.physicalReadBytes, readCalls: measured.readCalls,
        searchedBytes: measured.result.window.searchedBytes, partial: measured.result.partial, durationMs: measured.durationMs }));
});

test("bounded probe honors sub-64KiB and zero budgets", async () => {
    const sample = fixture({ large: true });
    for (const maxBytes of [0, 31, 4096]) {
        const measured = await measure(() => client.scanCodexContextProbeInRollout(sample.file, marker, { maxBytes }));
        assertIo(measured, measured.result.window, maxBytes);
        assert.equal(measured.result.partial, true);
        assert.equal(measured.result.hits.length, 0);
    }
});

test("deep locate shares the physical byte budget instead of resolving the full source", async () => {
    const sample = fixture({ large: true });
    const measured = await measure(() => client.deepLocateCodexConversationsBounded(marker, [sample.thread], { maxBytes: 65536 }));
    assert.equal(measured.result.status, "budget_exhausted");
    assert.equal(measured.result.hits.length, 0);
    assertIo(measured, measured.result.sourceWindows![0], 65536);
    assert.equal(measured.result.scannedBytes, measured.physicalReadBytes);
    console.log("PLAN63_DEEP_IO", JSON.stringify({ physicalReadBytes: measured.physicalReadBytes, readCalls: measured.readCalls,
        status: measured.result.status, durationMs: measured.durationMs }));
});

test("an unread history_base never becomes a complete logical miss or triggers root enumeration", async () => {
    const base = fixture({ text: marker });
    const leaf = fixture({ text: "synthetic leaf without the marker", historyBase: {
        thread_id: base.thread.id, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(base.text),
    } });
    const probe = await measure(() => client.scanCodexContextProbeInRollout(leaf.file, marker, { maxBytes: 65536 }));
    assert.equal(probe.result.hits.length, 0);
    assert.equal(probe.result.partial, true);
    assert.ok(probe.result.warnings.includes("history_base_not_scanned"));
    assert.deepEqual(probe.files, [leaf.file]);
    const deep = await measure(() => client.deepLocateCodexConversations(marker, [leaf.thread], { maxBytes: 65536 }));
    assert.equal(deep.result.status, "budget_exhausted");
    assert.equal(deep.result.truncated, true);
    assert.deepEqual(deep.files, [leaf.file]);
});

test("cold compression is explicitly partial and does not materialize or read an archive", async () => {
    const sample = fixture({ large: true });
    const archive = sample.file + ".zst";
    fs.writeFileSync(archive, zstdCompressSync(Buffer.from(sample.text)));
    fs.unlinkSync(sample.file);
    const probe = await measure(() => client.scanCodexContextProbeInRollout(sample.file, marker, { maxBytes: 65536 }));
    assert.equal(probe.result.partial, true);
    assert.ok(probe.result.warnings.includes("compressed_source_requires_verified_view"));
    assert.equal(probe.physicalReadBytes, 0);
    assert.equal(probe.result.window.readCalls, 0);
    const deep = await measure(() => client.deepLocateCodexConversationsBounded(absent, [{ ...sample.thread, rolloutPath: archive }], { maxBytes: 65536 }));
    assert.equal(deep.result.status, "budget_exhausted");
    assert.equal(deep.physicalReadBytes, 0);
    console.log("PLAN63_COLD_ARCHIVE_IO", JSON.stringify({ archiveBytes: fs.statSync(archive).size, physicalReadBytes: probe.physicalReadBytes,
        warnings: probe.result.warnings, durationMs: probe.durationMs }));
});

test("fully verified compressed views are reused without rehashing or reopening compressed bytes", async () => {
    const sample = fixture({ large: true });
    const archive = sample.file + ".zst";
    fs.writeFileSync(archive, zstdCompressSync(Buffer.from(sample.text)));
    fs.unlinkSync(sample.file);
    const source = await history.resolveCodexHistorySourceAsync(archive, { roots: [root], archive: {
        cacheRoot: path.join(root, "verified-views"), ownerId: "plan63-codex-fixture", minFreeBytes: 0, maxDecompressedBytes: 4 * 1024 * 1024,
    } });
    const measured = await measure(() => client.scanCodexContextProbeInRollout(sample.file, marker, { maxBytes: 65536, verifiedSource: source }));
    assertIo(measured, measured.result.window, 65536);
    assert.equal(measured.result.hits.length, 1);
    assert.equal(measured.result.window.sourceReadBytes, 0);
    assert.equal(measured.result.window.viewReadBytes, measured.physicalReadBytes);
    assert.equal(measured.result.window.sourceRevision, source.revision);
    const full = await measure(() => client.deepLocateCodexConversationsBounded(absent, [{ ...sample.thread, rolloutPath: archive }], { maxBytes: 2 * 1024 * 1024 }));
    assert.equal(full.result.status, "no_hit_after_full_scan");
    assert.equal(full.result.sourceWindows![0].sourceReadBytes, 0);
    assert.equal(full.physicalReadBytes, Buffer.byteLength(sample.text));
    console.log("PLAN63_VERIFIED_VIEW_IO", JSON.stringify({ probePhysicalReadBytes: measured.physicalReadBytes,
        compressedReadBytes: measured.result.window.sourceReadBytes, fullScanReadBytes: full.physicalReadBytes,
        fullScanStatus: full.result.status, durationMs: measured.durationMs }));
    fs.writeFileSync(source.segments[0]!.readPath!, "x".repeat(Buffer.byteLength(sample.text)));
    const stale = await measure(() => client.scanCodexContextProbeInRollout(archive, marker, { maxBytes: 65536 }));
    assert.equal(stale.result.hits.length, 0);
    assert.equal(stale.physicalReadBytes, 0);
    assert.equal(stale.result.partial, true);
    await assert.rejects(() => measure(() => client.scanCodexContextProbeInRollout(archive, marker, { maxBytes: 65536, verifiedSource: source })), /stale or was not fully verified/u);
});

test("cancellation before and during I/O closes the reader and a later request recovers", async () => {
    const sample = fixture({ large: true });
    const before = await measure(() => client.scanCodexContextProbeInRollout(sample.file, marker, { maxBytes: 65536, isCancelled: () => true }));
    assert.equal(before.result.cancelled, true);
    assert.equal(before.physicalReadBytes, 0);
    let cancelled = false;
    let scheduled = false;
    const during = await measure(() => client.scanCodexContextProbeInRollout(sample.file, marker, { maxBytes: 65536, isCancelled: () => cancelled }), () => {
        if (!scheduled) { scheduled = true; setImmediate(() => { cancelled = true; }); }
    });
    assert.equal(during.result.cancelled, true);
    assert.equal(during.result.partial, true);
    assert.ok(during.physicalReadBytes > 0 && during.physicalReadBytes <= 4096);
    const recovered = await measure(() => client.scanCodexContextProbeInRollout(sample.file, marker, { maxBytes: 65536 }));
    assert.equal(recovered.result.hits.length, 1);
    console.log("PLAN63_CANCEL_IO", JSON.stringify({ beforeReadBytes: before.physicalReadBytes, duringReadBytes: during.physicalReadBytes,
        cancelled: during.result.cancelled, recoveredHits: recovered.result.hits.length, durationMs: during.durationMs }));
});

test("expired deadlines stop before opening a source", async () => {
    const sample = fixture({ large: true });
    const probe = await measure(() => client.scanCodexContextProbeInRollout(sample.file, marker, { maxBytes: 65536, deadlineAt: Date.now() - 1 }));
    assert.equal(probe.physicalReadBytes, 0);
    assert.equal(probe.result.partial, true);
    assert.ok(probe.result.warnings.includes("deadline_exhausted"));
    const deep = await measure(() => client.deepLocateCodexConversationsBounded(marker, [sample.thread], { maxBytes: 65536, deadlineMs: 0 }));
    assert.equal(deep.physicalReadBytes, 0);
    assert.equal(deep.result.status, "budget_exhausted");
});

test("deadline expiration after the first physical read stops all later reads", async () => {
    const sample = fixture({ large: true });
    const originalNow = Date.now;
    let clock = 1000;
    Date.now = () => clock;
    try {
        const measured = await measure(() => client.scanCodexContextProbeInRollout(sample.file, marker, { maxBytes: 65536, deadlineAt: 1001 }), () => { clock = 1001; });
        assert.equal(measured.physicalReadBytes, 4096);
        assert.equal(measured.result.partial, true);
        assert.ok(measured.result.warnings.includes("deadline_exhausted"));
    } finally { Date.now = originalNow; }
});

test("source replacement or removal during a window rejects its collected hits", async () => {
    for (const remove of [false, true]) {
        const sample = fixture({ large: true });
        let changed = false;
        await assert.rejects(() => measure(() => client.scanCodexContextProbeInRollout(sample.file, marker, { maxBytes: 65536 }), () => {
            if (changed) return;
            changed = true;
            if (remove) fs.unlinkSync(sample.file);
            else fs.appendFileSync(sample.file, line({ type: "event_msg", payload: { type: "user_message", message: "late append" } }));
        }), /changed during window read/u);
    }
});

test("metadata-only manifests cannot authorize compressed view reuse", async () => {
    const sample = fixture();
    const archive = sample.file + ".zst";
    fs.writeFileSync(archive, zstdCompressSync(Buffer.from(sample.text)));
    fs.unlinkSync(sample.file);
    const metadata = await history.resolveCodexHistorySourceAsync(archive, { roots: [root], metadataOnly: true, archive: {
        cacheRoot: path.join(root, "metadata-views"), ownerId: "plan63-codex-metadata-fixture", minFreeBytes: 0,
    } });
    await assert.rejects(() => measure(() => client.scanCodexContextProbeInRollout(archive, marker, { verifiedSource: metadata })), /was not fully verified/u);
    const cold = await measure(() => client.scanCodexContextProbeInRollout(archive, marker));
    assert.equal(cold.physicalReadBytes, 0);
    assert.equal(cold.result.partial, true);
});

test("unverified replicas and invalid ordinals remain partial", async () => {
    const sample = fixture();
    fs.writeFileSync(sample.file + ".zst", zstdCompressSync(Buffer.from(sample.text.replace(marker, absent))));
    const pair = await measure(() => client.scanCodexContextProbeInRollout(sample.file, marker));
    assert.equal(pair.result.partial, true);
    assert.ok(pair.result.warnings.includes("replicas_not_verified"));
    const ordinal = fixture();
    fs.writeFileSync(ordinal.file, line({ ordinal: 0, type: "session_meta", payload: { id: ordinal.thread.id } })
        + line({ ordinal: 4, type: "event_msg", payload: { type: "token_count" } })
        + line({ ordinal: 3, type: "event_msg", payload: { type: "token_count" } }));
    const invalid = await measure(() => client.deepLocateCodexConversationsBounded(absent, [ordinal.thread]));
    assert.equal(invalid.result.status, "budget_exhausted");
    assert.ok(invalid.result.sourceWindows![0].warnings.includes("malformed_record_not_searched"));
});

test("an unavailable compressed candidate does not prevent scanning a later healthy candidate", async () => {
    const compressed = fixture();
    fs.writeFileSync(compressed.file + ".zst", zstdCompressSync(Buffer.from(compressed.text)));
    fs.unlinkSync(compressed.file);
    const healthy = fixture();
    const measured = await measure(() => client.deepLocateCodexConversationsBounded(marker, [compressed.thread, healthy.thread], { maxBytes: 65536 }));
    assert.equal(measured.result.scannedFiles, 2);
    assert.equal(measured.result.status, "partial_found_scanning");
    assert.equal(measured.result.hits[0].conversationId, healthy.thread.id);
    assert.equal(measured.result.totalBytesExact, false);
});

test("contextProbe tolerates punctuation, whitespace, NFKC and case while rejecting added or removed words", async () => {
    const original = "第一段按原文逐字保存，\n第二段保留 Server ABC１２３ 的顺序。\n最后一段继续完整校验。";
    const reformatted = "第一段按原文逐字保存。第二段保留 server abc123 的顺序，最后一段继续完整校验";
    const sample = fixture({ text: original });
    const measured = await measure(() => client.scanCodexContextProbeInRollout(sample.file, reformatted, { maxBytes: 65536 }));
    assert.equal(measured.result.hits.length, 1);
    assert.ok(measured.result.hits[0].snippet.includes("Server ABC１２３"), "the shared matcher returns original source text");
    const events = [{ type: "event_msg", payload: { type: "user_message", message: original } }];
    assert.equal(client.matchCodexContextProbeInEvents(events, reformatted).length, 1);
    for (const changed of [reformatted.replace("第二段保留", "第二段额外保留"), reformatted.replace("逐字保存", "保存")]) {
        const rejected = await measure(() => client.scanCodexContextProbeInRollout(sample.file, changed, { maxBytes: 65536 }));
        assert.equal(rejected.result.hits.length, 0);
        assert.equal(client.matchCodexContextProbeInEvents(events, changed).length, 0);
    }
    const exact = await measure(() => client.deepLocateCodexConversationsBounded(reformatted, [sample.thread], { maxBytes: 65536 }));
    assert.equal(exact.result.status, "no_hit_after_full_scan", "deep exact retains its literal punctuation semantics");
});

test("exact source-sized budgets can finish while omitted candidates and malformed records remain partial", async () => {
    const sample = fixture();
    const measured = await measure(() => client.scanCodexContextProbeInRollout(sample.file, absent, { maxBytes: Buffer.byteLength(sample.text) }));
    assert.equal(measured.result.partial, false);
    assertIo(measured, measured.result.window, Buffer.byteLength(sample.text));
    const exact = await measure(() => client.deepLocateCodexConversationsBounded(absent, [sample.thread], { maxBytes: Buffer.byteLength(sample.text) }));
    assert.equal(exact.result.status, "no_hit_after_full_scan");
    const omitted = await measure(() => client.deepLocateCodexConversationsBounded(absent, [sample.thread, fixture().thread], { maxFiles: 1 }));
    assert.equal(omitted.result.totalFiles, 2);
    assert.equal(omitted.result.status, "budget_exhausted");
    fs.appendFileSync(sample.file, "not-json\n");
    const malformed = await measure(() => client.deepLocateCodexConversationsBounded(absent, [sample.thread]));
    assert.equal(malformed.result.status, "budget_exhausted");
    assert.ok(malformed.result.sourceWindows![0].warnings.includes("malformed_record_not_searched"));
});

after(() => {
    os.homedir = originalHome;
    if (originalDataRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
    else process.env.MEMORY_STORE_DATA_ROOT = originalDataRoot;
    fs.rmSync(root, { recursive: true, force: true });
    console.log("CLEANED_PLAN63_CODEX_FIXTURES");
});
