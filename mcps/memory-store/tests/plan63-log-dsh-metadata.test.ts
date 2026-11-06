import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import { test, type TestContext } from "node:test";
import { discoverDshSessionSources, readDshSession } from "../src/dsh-session-reader.ts";

const line = (value: unknown): string => JSON.stringify(value) + "\n";
const header = (id: string, cwd = "synthetic-workspace") => ({ type: "session", version: 0, id, cwd, created: "2026-01-01T00:00:00.000Z" });
const body = { type: "assistant/chunk", seq: 0, time: 1, data: { turn: 0, step: 0, chunk: { type: "text-delta", index: 0, text: "synthetic body" } } };

async function fixture(context: TestContext): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "plan63-log-dsh-"));
    context.after(async () => { await rm(root, { recursive: true, force: true }); });
    return root;
}

async function session(root: string, name: string, text: string, compressed = false): Promise<void> {
    const directory = path.join(root, "synthetic-project", name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, compressed ? "session.jsonl.zstd" : "session.jsonl"), compressed ? zlib.zstdCompressSync(Buffer.from(text)) : text);
}

test("DSH metadata isolates bad headers and never parses unrelated bodies", async context => {
    const root = await fixture(context);
    await session(root, "good", line(header("synthetic-good")) + line(body));
    await session(root, "bad-body", line(header("synthetic-bad-body")) + "not-json\n");
    await session(root, "bad-header", "not-json\n");
    const discovered = await discoverDshSessionSources({ sessionsRoot: root });
    assert.deepEqual(discovered.sources.map(source => source.id).sort(), ["synthetic-bad-body", "synthetic-good"]);
    assert.equal(discovered.partial, true);
    assert.ok(discovered.warnings.some(warning => warning.includes("candidate_error")));
    assert.equal((await readDshSession("synthetic-good", { sessionsRoot: root })).events.length, 1);
});

test("DSH applies explicit ID and workspace scope to metadata", async context => {
    const root = await fixture(context);
    await session(root, "selected", line(header("synthetic-selected", path.join(root, "wanted"))) + "not-json\n");
    await session(root, "other", line(header("synthetic-other", path.join(root, "other"))) + "not-json\n");
    const discovered = await discoverDshSessionSources({ sessionsRoot: root, conversationIds: ["synthetic-selected"], workspaces: [path.join(root, "wanted")], workspaceMode: "exact" });
    assert.deepEqual(discovered.sources.map(source => source.id), ["synthetic-selected"]);
    assert.equal(discovered.partial, false);
});

test("DSH bounds global bytes and retains metadata when enumeration stops", async context => {
    const root = await fixture(context);
    await session(root, "first", line(header("synthetic-first")));
    await session(root, "second", line(header("synthetic-second")));
    const bounded = await discoverDshSessionSources({ sessionsRoot: root, maxBytes: 3 });
    assert.ok(bounded.scannedBytes <= 3);
    assert.equal(bounded.partial, true);
    const entries = await discoverDshSessionSources({ sessionsRoot: root, maxEntries: 2 });
    assert.equal(entries.sources.length, 1);
    assert.equal(entries.partial, true);
    assert.ok(entries.warnings.some(warning => warning.includes("entry_budget")));
    const expired = await discoverDshSessionSources({ sessionsRoot: root, deadlineMs: 0 });
    assert.equal(expired.scannedBytes, 0);
    assert.equal(expired.partial, true);
    assert.ok(expired.warnings.some(warning => warning.includes("deadline")));
});

test("DSH per-candidate budget leaves capacity for a healthy candidate", async context => {
    const root = await fixture(context);
    await session(root, "oversized", "x".repeat(128 * 1024));
    await session(root, "healthy", line(header("synthetic-healthy")));
    const discovered = await discoverDshSessionSources({ sessionsRoot: root, maxCandidateBytes: 16 * 1024, maxBytes: 64 * 1024 });
    assert.deepEqual(discovered.sources.map(source => source.id), ["synthetic-healthy"]);
    assert.equal(discovered.partial, true);
    assert.ok(discovered.scannedBytes <= 64 * 1024);
});

test("DSH cancellation closes metadata handles and later requests still work", async context => {
    const root = await fixture(context);
    await session(root, "selected", line(header("synthetic-selected")));
    let cancelled = false;
    let reads = 0;
    await assert.rejects(discoverDshSessionSources({ sessionsRoot: root, isCancelled: () => cancelled, onProgress: () => { reads += 1; cancelled = true; } }), error => (error as Error).name === "AbortError");
    assert.equal(reads, 1);
    assert.equal((await discoverDshSessionSources({ sessionsRoot: root })).sources.length, 1);
});

test("DSH duplicate headers remain ambiguous and compressed headers stay bounded", async context => {
    const root = await fixture(context);
    await session(root, "duplicate-one", line(header("synthetic-duplicate")));
    await session(root, "duplicate-two", line(header("synthetic-duplicate")));
    await session(root, "compressed", line(header("synthetic-compressed")) + "not-json\n", true);
    const discovered = await discoverDshSessionSources({ sessionsRoot: root });
    assert.deepEqual(discovered.sources.map(source => source.id), ["synthetic-compressed"]);
    assert.equal(discovered.partial, true);
    assert.ok(discovered.warnings.some(warning => warning.includes("duplicate_id")));
    const bounded = await discoverDshSessionSources({ sessionsRoot: root, maxBytes: 4 });
    assert.equal(bounded.partial, true);
    assert.ok(bounded.scannedBytes <= 4);
});

test("DSH production log backend preserves partial discovery and source identity", async context => {
    const root = await fixture(context);
    const previousData = process.env.MEMORY_STORE_DATA_ROOT;
    process.env.MEMORY_STORE_DATA_ROOT = path.join(root, "data");
    context.after(() => { if (previousData === undefined) delete process.env.MEMORY_STORE_DATA_ROOT; else process.env.MEMORY_STORE_DATA_ROOT = previousData; });
    const readable = line({ type: "user/message", seq: 0, time: 1, data: { message: { id: "synthetic-user", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "synthetic question" }] } } })
        + line({ type: "assistant/message", seq: 1, time: 2, data: { turn: 0, step: 1, message: { role: "assistant", content: [{ type: "text", text: "synthetic answer" }] } } });
    await session(root, "good", line(header("synthetic-good")) + readable);
    await session(root, "bad", "not-json\n");
    const { createLogHostBackend } = await import("../src/conversation-host-logs.ts");
    const backend = createLogHostBackend("dsh", { cacheRoot: path.join(root, "cache"), dshOptions: { sessionsRoot: root } });
    const candidates = await backend.list({ conversationIds: ["synthetic-good"] }, {});
    assert.equal(candidates.length, 1);
    assert.equal(backend.sourceStatuses!()[0]!.status, "partial");
    const first = await backend.read(candidates[0]!, undefined, {});
    const warm = await backend.read(candidates[0]!, undefined, {});
    assert.equal(first.revision, warm.revision);
    assert.equal(warm.timings!.cacheHit, 1);
    await assert.rejects(backend.read(candidates[0]!, undefined, { deadlineAt: 0 }), error => (error as Error).name === "TimeoutError");
    await session(root, "good", line(header("synthetic-replaced")) + readable);
    await assert.rejects(backend.read(candidates[0]!, undefined, {}), /source not found|identity changed/u);
});
