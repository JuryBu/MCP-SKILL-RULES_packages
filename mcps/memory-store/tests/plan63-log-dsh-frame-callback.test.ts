import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { test, type TestContext } from "node:test";
import { discoverDshSessionSources, readDshSessionIncremental } from "../src/dsh-session-reader.ts";

const line = (value: unknown): string => JSON.stringify(value) + "\n";
const sessionHeader = line({ type: "session", version: 0, id: "synthetic-frame", created: "2026-01-01T00:00:00.000Z" });
const message = line({ type: "user/message", seq: 0, time: 1, data: { message: { id: "synthetic-user", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "synthetic 尾字节" }] } } });
const compress = (text: string): Buffer => Buffer.from(zstdCompressSync(Buffer.from(text)));

async function fixture(context: TestContext, trailingNewline: boolean) {
    const root = await mkdtemp(path.join(os.tmpdir(), "plan63-log-frame-"));
    context.after(async () => { await rm(root, { recursive: true, force: true }); });
    const directory = path.join(root, "synthetic-project", "synthetic-session");
    await mkdir(directory, { recursive: true });
    const filename = path.join(directory, "session.jsonl.zstd");
    const first = compress(sessionHeader);
    const second = compress(trailingNewline ? message : message.trimEnd());
    await writeFile(filename, Buffer.concat([first, second]));
    const discovery = await discoverDshSessionSources({ sessionsRoot: root });
    assert.equal(discovery.sources.length, 1);
    return { root, filename, source: discovery.sources[0]!, firstBytes: first.length, totalBytes: first.length + second.length };
}

test("DSH frame output callback records the final decoded newline", async context => {
    const fixture_ = await fixture(context, true);
    const result = await readDshSessionIncremental(fixture_.source, { sessionsRoot: fixture_.root });
    assert.equal(result.events.length, 1);
    assert.equal(result.checkpoint.resumeByte, fixture_.totalBytes);
    assert.equal(result.checkpoint.resumeEventCount, 1);
    assert.equal(result.provenance.ignoredTrailingTextRecord, false);
});

test("DSH incomplete decoded tail keeps the last complete checkpoint and resumes after append", async context => {
    const fixture_ = await fixture(context, false);
    const initial = await readDshSessionIncremental(fixture_.source, { sessionsRoot: fixture_.root });
    assert.equal(initial.events.length, 0);
    assert.equal(initial.checkpoint.resumeByte, fixture_.firstBytes);
    assert.equal(initial.provenance.ignoredTrailingTextRecord, true);
    const newline = compress("\n");
    await appendFile(fixture_.filename, newline);
    const source = (await discoverDshSessionSources({ sessionsRoot: fixture_.root })).sources[0]!;
    const appended = await readDshSessionIncremental(source, { sessionsRoot: fixture_.root, checkpoint: initial.checkpoint });
    assert.equal(appended.events.length, 1);
    assert.equal(appended.checkpoint.resumeByte, fixture_.totalBytes + newline.length);
    assert.equal(appended.provenance.ignoredTrailingTextRecord, false);
});

test("DSH frame cancellation and decoded-byte budget fail without publishing a checkpoint", async context => {
    const fixture_ = await fixture(context, true);
    let cancelled = false;
    await assert.rejects(readDshSessionIncremental(fixture_.source, { sessionsRoot: fixture_.root, isCancelled: () => cancelled,
        onProgress: progress => { if (progress.phase === "decode") cancelled = true; } }), error => (error as Error).name === "AbortError");
    await assert.rejects(readDshSessionIncremental(fixture_.source, { sessionsRoot: fixture_.root,
        maxDecompressedBytes: Buffer.byteLength(sessionHeader + message) - 1 }), /maxDecompressedBytes/u);
    assert.equal((await readDshSessionIncremental(fixture_.source, { sessionsRoot: fixture_.root })).events.length, 1);
});
