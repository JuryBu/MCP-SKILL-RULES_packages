import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-currentness-io-"));
process.env.MEMORY_STORE_DATA_ROOT = root;
process.env.MEMORY_STORE_AUTO_RECORD = "0";
let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => { networkCalls++; throw new Error("Network prohibited"); }) as typeof fetch;
const store = await import("../src/store.ts");
const api = await import("../src/auto-summary-currentness.ts");
const { autoSummarySourceFingerprint } = await import("../src/auto-summary-snapshot.ts");
type Entry = Parameters<typeof api.inspectIndexedAutoSummaryCurrentness>[0];
const entriesDir = path.join(root, "general", "entries");
fs.mkdirSync(entriesDir, { recursive: true });
const sourceFiles = new Set<string>();
const counters = { opens: 0, reads: 0, bytes: 0, fullReads: 0 };
let readHook: ((filePath: string) => void) | undefined;
let deniedPath: string | undefined;
const descriptors = new Map<number, string>();
const originalOpen = fs.openSync;
const originalRead = fs.readSync;
const originalReadFile = fs.readFileSync;
const originalClose = fs.closeSync;
const originalAsyncOpen = fs.promises.open;
const originalAsyncReadFile = fs.promises.readFile;

fs.openSync = ((...args: any[]) => {
    if (String(args[0]) === deniedPath) throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    const descriptor = (originalOpen as any)(...args) as number;
    const filePath = String(args[0]);
    if (sourceFiles.has(filePath)) { counters.opens++; descriptors.set(descriptor, filePath); }
    return descriptor;
}) as typeof fs.openSync;
fs.readSync = ((...args: any[]) => {
    const count = (originalRead as any)(...args) as number;
    const filePath = descriptors.get(args[0]);
    if (filePath) {
        counters.reads++; counters.bytes += count;
        const hook = readHook; readHook = undefined; hook?.(filePath);
    }
    return count;
}) as typeof fs.readSync;
fs.closeSync = ((descriptor: number) => { descriptors.delete(descriptor); return originalClose(descriptor); }) as typeof fs.closeSync;
fs.readFileSync = ((...args: any[]) => {
    if (sourceFiles.has(String(args[0]))) counters.fullReads++;
    return (originalReadFile as any)(...args);
}) as typeof fs.readFileSync;
fs.promises.open = (async (...args: any[]) => {
    if (String(args[0]) === deniedPath) throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    const handle = await (originalAsyncOpen as any)(...args);
    const filePath = String(args[0]);
    if (!sourceFiles.has(filePath)) return handle;
    counters.opens++;
    return new Proxy(handle, {
        get(target, property) {
            if (property === "read") return async (...readArgs: any[]) => {
                const result = await target.read(...readArgs);
                counters.reads++; counters.bytes += result.bytesRead;
                const hook = readHook; readHook = undefined; hook?.(filePath);
                return result;
            };
            const value = target[property];
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}) as typeof fs.promises.open;
fs.promises.readFile = (async (...args: any[]) => {
    if (sourceFiles.has(String(args[0]))) counters.fullReads++;
    return (originalAsyncReadFile as any)(...args);
}) as typeof fs.promises.readFile;

function reset(): void { Object.assign(counters, { opens: 0, reads: 0, bytes: 0, fullReads: 0 }); }
function evidence(name: string): void { console.log(JSON.stringify({ name, ...counters })); }
function fixture(id: string, body = "small current body"): { entry: Entry; filePath: string; content: string } {
    const fields = { id, title: "IO fixture", tags: ["fixture"], category: "general", workspace: "general", created: "2026-01-01", updated: "2026-01-02", searchSummary: "fixture", autoSummary: "shortsummary" };
    const source = store.buildMemoryFile(fields, body);
    const provenance = JSON.stringify({ version: 1, status: "generated", provider: "fixture", model: "fixture", generatedAt: "2026-01-02T00:00:00Z", failures: [], summarySource: { provider: "fixture", model: "fixture", generatedAt: "2026-01-02T00:00:00Z", sourceFingerprint: autoSummarySourceFingerprint(source) } });
    const content = store.buildMemoryFile({ ...fields, autoSummaryProvenance: provenance }, body);
    const filePath = store.getEntryPath("general", id);
    fs.writeFileSync(filePath, content, "utf8");
    sourceFiles.add(filePath);
    const entry: Entry = { id, title: fields.title, searchSummary: fields.searchSummary, autoSummary: fields.autoSummary, autoSummaryProvenance: provenance, tags: fields.tags, category: fields.category, createdAt: fields.created, updatedAt: fields.updated, lastAccessed: fields.updated, sizeBytes: Buffer.byteLength(content), lineCount: store.countLines(content) };
    return { entry, filePath, content };
}

try {
    const base = fixture("metadata");
    const provenance = JSON.parse(base.entry.autoSummaryProvenance!);
    reset();
    for (const [status, extra, expected] of [
        ["failed", {}, "failed"], ["pending", {}, "pending"],
        ["failed", { failureClass: "UnknownOutcome" }, "failed"],
    ] as const) {
        const entry = { ...base.entry, autoSummaryProvenance: JSON.stringify({ ...provenance, status, ...extra }) };
        assert.equal(api.inspectIndexedAutoSummaryCurrentness(entry, "general").status, expected);
        assert.equal((await api.inspectIndexedAutoSummaryCurrentnessAsync(entry, "general")).status, expected);
        assert.equal(api.projectCurrentAutoSummary(entry, "general").autoSummary, "");
        assert.equal((await api.projectCurrentAutoSummaryAsync(entry, "general")).autoSummary, "");
    }
    for (const entry of [{ ...base.entry, autoSummaryProvenance: undefined }, { ...base.entry, autoSummary: undefined }, { ...base.entry, autoSummaryProvenance: "x".repeat(131073) }]) {
        assert.equal(api.inspectIndexedAutoSummaryCurrentness(entry, "general").summary, "");
        assert.equal((await api.inspectIndexedAutoSummaryCurrentnessAsync(entry, "general")).summary, "");
    }
    assert.equal(counters.opens, 0);
    assert.equal(counters.bytes, 0);
    evidence("failed/pending/legacy/missing/oversized-metadata: zero opens");

    const noFingerprint = { ...base.entry, autoSummaryProvenance: JSON.stringify({ ...provenance, summarySource: { generatedAt: "fixture" } }) };
    assert.equal(api.inspectIndexedAutoSummaryCurrentness(noFingerprint, "general").status, "unverified");
    assert.equal((await api.inspectIndexedAutoSummaryCurrentnessAsync(noFingerprint, "general")).status, "unverified");
    assert.equal(counters.opens, 0);

    const large = Array.from({ length: 20 }, (_, index) => fixture(`large-${index}`, "z".repeat(1024 * 1024)));
    reset();
    for (const item of large) assert.equal(api.inspectIndexedAutoSummaryCurrentness(item.entry, "general").status, "unverified");
    await Promise.all(large.map(async item => {
        const state = await api.inspectIndexedAutoSummaryCurrentnessAsync(item.entry, "general");
        assert.equal(state.status, "unverified"); assert.equal(state.summary, ""); assert.equal(state.retryBlocked, true);
    }));
    assert.equal(counters.opens, 40); assert.equal(counters.reads, 0); assert.equal(counters.bytes, 0); assert.equal(counters.fullReads, 0);
    evidence("20x1MiB sync+async: fstat rejects, zero bytes");

    const small = fixture("small");
    reset();
    assert.equal(api.inspectIndexedAutoSummaryCurrentness(small.entry, "general").status, "current");
    assert.equal(counters.bytes, Buffer.byteLength(small.content));
    evidence("small: initial bounded read");
    reset();
    assert.equal(api.projectCurrentAutoSummary(small.entry, "general").autoSummary, "shortsummary");
    assert.equal((await api.projectCurrentAutoSummaryAsync(small.entry, "general")).autoSummary, "shortsummary");
    assert.equal(counters.bytes, 0); evidence("small: sync+async cache hits");
    fs.appendFileSync(small.filePath, " changed");
    reset();
    assert.equal((await api.inspectIndexedAutoSummaryCurrentnessAsync(small.entry, "general")).status, "stale");
    assert.ok(counters.bytes > 0); evidence("size change invalidates cache");

    const sameSize = fixture("same-size");
    assert.equal((await api.inspectIndexedAutoSummaryCurrentnessAsync(sameSize.entry, "general")).status, "current");
    const previous = fs.statSync(sameSize.filePath, { bigint: true });
    fs.writeFileSync(sameSize.filePath, sameSize.content.replace("small current body", "small changed body"));
    reset();
    assert.equal(api.inspectIndexedAutoSummaryCurrentness(sameSize.entry, "general").status, "stale");
    assert.equal(fs.statSync(sameSize.filePath, { bigint: true }).size, previous.size);
    assert.ok(counters.bytes > 0); evidence("same-size rewrite invalidates cache");

    const replacement = fixture("cached-replace");
    assert.equal(api.inspectIndexedAutoSummaryCurrentness(replacement.entry, "general").status, "current");
    fs.renameSync(replacement.filePath, replacement.filePath + ".old");
    fs.writeFileSync(replacement.filePath, replacement.content.replace("small current body", "small changed body"));
    reset();
    assert.equal((await api.inspectIndexedAutoSummaryCurrentnessAsync(replacement.entry, "general")).status, "stale");
    assert.ok(counters.bytes > 0); evidence("same-path replacement invalidates cache");

    for (const mode of ["sync", "async"] as const) {
        for (const mutation of ["growth", "replacement"] as const) {
            const item = fixture(`${mode}-${mutation}`);
            reset();
            readHook = filePath => {
                if (mutation === "growth") fs.appendFileSync(filePath, "z".repeat(150000));
                else {
                    fs.renameSync(filePath, filePath + ".old");
                    fs.writeFileSync(filePath, item.content.replace("small current body", "small changed body"));
                }
            };
            const state = mode === "sync" ? api.inspectIndexedAutoSummaryCurrentness(item.entry, "general")
                : await api.inspectIndexedAutoSummaryCurrentnessAsync(item.entry, "general");
            assert.equal(state.status, "unverified"); assert.equal(state.summary, "");
            assert.ok(counters.bytes <= 128 * 1024); assert.equal(counters.fullReads, 0);
            evidence(`${mode}: ${mutation} during read rejected`);
        }
    }

    const boundary = fixture("boundary", "z".repeat(128 * 1024));
    const overhead = Buffer.byteLength(boundary.content) - 128 * 1024;
    const exact = fixture("boundary", "z".repeat(128 * 1024 - overhead));
    assert.equal(Buffer.byteLength(exact.content), 128 * 1024);
    reset();
    assert.equal((await api.inspectIndexedAutoSummaryCurrentnessAsync(exact.entry, "general")).status, "current");
    assert.equal(counters.bytes, 128 * 1024); evidence("128KiB boundary: exactly bounded");

    const missing = fixture("deleted");
    fs.unlinkSync(missing.filePath);
    assert.equal(api.inspectIndexedAutoSummaryCurrentness(missing.entry, "general").status, "unavailable");
    assert.equal((await api.inspectIndexedAutoSummaryCurrentnessAsync(missing.entry, "general")).status, "unavailable");
    assert.equal((await api.projectCurrentAutoSummaryAsync(missing.entry, "general")).autoSummary, "");
    const preferred = fixture("preferred");
    assert.equal(api.inspectIndexedAutoSummaryCurrentness({ ...preferred.entry, _sourceHash: "general" } as Entry, "wrong-workspace").status, "current");
    deniedPath = preferred.filePath;
    for (const state of [api.inspectIndexedAutoSummaryCurrentness(preferred.entry, "general"), await api.inspectIndexedAutoSummaryCurrentnessAsync(preferred.entry, "general")]) {
        assert.equal(state.status, "unavailable"); assert.equal(state.summary, ""); assert.equal(state.retained, true);
    }
    deniedPath = undefined;

    const timestamp = fixture("ctime-change");
    const fixedTime = new Date("2026-01-01T00:00:00Z");
    fs.utimesSync(timestamp.filePath, fixedTime, fixedTime);
    assert.equal(api.inspectIndexedAutoSummaryCurrentness(timestamp.entry, "general").status, "current");
    const oldTimes = fs.statSync(timestamp.filePath, { bigint: true });
    fs.writeFileSync(timestamp.filePath, timestamp.content.replace("small current body", "small changed body"));
    fs.utimesSync(timestamp.filePath, fixedTime, fixedTime);
    const restored = fs.statSync(timestamp.filePath, { bigint: true });
    assert.equal(restored.mtimeNs, oldTimes.mtimeNs);
    assert.equal(restored.size, oldTimes.size);
    assert.notEqual(restored.ctimeNs, oldTimes.ctimeNs);
    reset();
    assert.equal((await api.inspectIndexedAutoSummaryCurrentnessAsync(timestamp.entry, "general")).status, "stale");
    assert.ok(counters.bytes > 0); evidence("same-size rewrite with restored mtime invalidates cache");

    const lru = Array.from({ length: 257 }, (_, index) => fixture(`lru-${index}`));
    for (const item of lru) assert.equal(api.inspectIndexedAutoSummaryCurrentness(item.entry, "general").status, "current");
    reset();
    assert.equal(api.inspectIndexedAutoSummaryCurrentness(lru[256].entry, "general").status, "current");
    assert.equal(counters.bytes, 0);
    assert.equal(api.inspectIndexedAutoSummaryCurrentness(lru[0].entry, "general").status, "current");
    assert.ok(counters.bytes > 0); evidence("256-path LRU: latest cached, oldest evicted");
    assert.equal(counters.fullReads, 0); assert.equal(networkCalls, 0);
    console.log("PASS: bounded sync/async I/O, metadata rejection, cache invalidation, growth/replacement, unavailable, hash priority, 256-path LRU; networkCalls=0");
} finally {
    readHook = undefined;
    fs.openSync = originalOpen; fs.readSync = originalRead; fs.closeSync = originalClose;
    fs.readFileSync = originalReadFile; fs.promises.open = originalAsyncOpen; fs.promises.readFile = originalAsyncReadFile;
    globalThis.fetch = originalFetch;
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
}
