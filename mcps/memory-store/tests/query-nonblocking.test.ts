import assert from "node:assert/strict";
import syncFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memory-store-query-nonblocking-"));
process.env.MEMORY_STORE_DATA_ROOT = directory;
process.env.MEMORY_STORE_AUTO_RECORD = "0";

const { registerQuery } = await import("../src/tools/query.js");
const { ensureDataDirs, getEntryPath } = await import("../src/store.js");
const { indexCache } = await import("../src/cache.js");
type QueryEntry = import("../src/cache.js").MemoryIndexEntry;
type QueryResponse = { content?: Array<{ text?: string }> };
type QueryHandler = (args: Record<string, unknown>) => Promise<QueryResponse>;
const handlers = new Map<string, QueryHandler>();
registerQuery({
    tool(name: string, _description: string, _schema: unknown, handler: QueryHandler) {
        handlers.set(name, handler);
    },
} as never);
const query = handlers.get("memory_query")!;
assert.ok(query);
ensureDataDirs();

after(async () => {
    indexCache.clear();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("memory-store-query-nonblocking-"));
    await fs.rm(directory, { recursive: true, force: true });
});

function entry(id: string, title = `Entry ${id}`): QueryEntry {
    return {
        id, title, searchSummary: "neutral summary", tags: [], category: "fixture",
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        lastAccessed: "2026-01-01T00:00:00Z", sizeBytes: 4 * 1024 * 1024, lineCount: 1,
    };
}

async function setIndex(entries: QueryEntry[], hash = "general"): Promise<void> {
    const root = hash === "general" ? path.join(directory, "general") : path.join(directory, "workspaces", hash);
    await fs.mkdir(path.join(root, "entries"), { recursive: true });
    await fs.writeFile(path.join(root, "_index.json"), JSON.stringify({ version: 1, entries }));
    indexCache.clear();
}

function textOf(response: QueryResponse): string {
    return (response.content || []).map(item => item.text || "").join("\n");
}

test("exact summary with a small result limit reads bounded prefixes and keeps the event loop responsive", async context => {
    const warm = entry("warm");
    await setIndex([warm]);
    await fs.writeFile(getEntryPath("general", warm.id), "warmneedle");
    await query({ query: "warmneedle", mode: "exact", depth: "summary", limit: 1 });

    const candidates = Array.from({ length: 64 }, (_, index) => entry(`large-${index}`));
    await setIndex(candidates);
    const source = getEntryPath("general", candidates[0].id);
    await fs.writeFile(source, "---\ntitle: frontmatterneedle\n---\nbodyprefixneedle " + "x".repeat(4 * 1024 * 1024) + " beyondprefixneedle");
    for (const candidate of candidates.slice(1)) await fs.link(source, getEntryPath("general", candidate.id));

    const originalReadFileSync = syncFs.readFileSync;
    context.mock.method(syncFs, "readFileSync", (...args: Parameters<typeof syncFs.readFileSync>) => {
        if (String(args[0]).endsWith(".md")) throw new Error("candidate body must not use readFileSync");
        return originalReadFileSync(...args);
    });
    const originalOpen = fs.open;
    let bodyBytes = 0;
    const opened = new Set<string>();
    context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (String(args[0]).endsWith(".md")) {
            opened.add(String(args[0]));
            const originalRead = handle.read.bind(handle);
            context.mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number | null) => {
                const result = await originalRead(buffer, offset, length, position);
                bodyBytes += result.bytesRead;
                return result;
            });
        }
        return handle;
    });

    let pending = true;
    let heartbeats = 0;
    const heartbeat = setInterval(() => { if (pending) heartbeats++; }, 1);
    let controlRespondedBeforeQuery = false;
    const control = new Promise<void>(resolve => setImmediate(() => {
        controlRespondedBeforeQuery = pending;
        resolve();
    }));
    let response: QueryResponse;
    try {
        response = await query({ query: "bodyprefixneedle", mode: "exact", depth: "summary", limit: 1 });
    } finally {
        pending = false;
        clearInterval(heartbeat);
    }
    await control;
    assert.match(textOf(response!), /找到 1 条记忆/u);
    assert.match(textOf(response!), /large-/u);
    assert.equal(opened.size, candidates.length);
    assert.ok(bodyBytes <= candidates.length * 9003, `read ${bodyBytes} candidate bytes`);
    assert.equal(controlRespondedBeforeQuery, true);
    assert.ok(heartbeats > 0, "a heartbeat must run while candidate prefix reads are pending");
    context.diagnostic(JSON.stringify({ candidates: candidates.length, bodyBytes, heartbeats, controlRespondedBeforeQuery }));

    assert.match(textOf(await query({ query: "frontmatterneedle", mode: "exact", depth: "summary", limit: 1 })), /large-/u);
    assert.match(textOf(await query({ query: "beyondprefixneedle", mode: "exact", depth: "summary", limit: 1 })), /未找到/u);
});

test("immediately resolved reads still yield between bounded candidate batches", async context => {
    const warm = entry("batch-warm");
    await setIndex([warm]);
    await fs.writeFile(getEntryPath("general", warm.id), "batchwarmneedle");
    await query({ query: "batchwarmneedle", mode: "exact", depth: "summary", limit: 1 });
    const candidates = Array.from({ length: 48 }, (_, index) => entry(`cached-${index}`));
    await setIndex(candidates);
    const content = Buffer.from("cachedprefixneedle " + "x".repeat(3000));
    let active = 0;
    let peakActive = 0;
    let opened = 0;
    context.mock.method(fs, "open", async () => {
        active++;
        opened++;
        peakActive = Math.max(peakActive, active);
        return {
            async read(buffer: Buffer, offset: number, length: number) {
                const bytesRead = Math.min(length, content.length);
                content.copy(buffer, offset, 0, bytesRead);
                return { buffer, bytesRead };
            },
            async close() { active--; },
        };
    });
    let pending = true;
    let controlRespondedBeforeQuery = false;
    const control = new Promise<void>(resolve => setImmediate(() => {
        controlRespondedBeforeQuery = pending;
        resolve();
    }));
    let response: QueryResponse;
    try {
        response = await query({ query: "cachedprefixneedle", mode: "exact", depth: "summary", limit: 1 });
    } finally { pending = false; }
    await control;
    assert.match(textOf(response!), /cached-/u);
    assert.equal(opened, candidates.length);
    assert.ok(peakActive <= 16, `opened ${peakActive} candidate files at once`);
    assert.equal(active, 0);
    assert.equal(controlRespondedBeforeQuery, true);
});

test("auto and exact preserve raw frontmatter, Unicode and the 3000-unit boundary", async () => {
    const candidate = entry("unicode-boundary");
    await setIndex([candidate]);
    const start = "---\ntitle: headeronlyneedle\n---\n猫咪边界 ";
    const prefix = start + "界".repeat(3000 - start.length);
    await fs.writeFile(getEntryPath("general", candidate.id), prefix + "outsideonlyneedle");
    for (const mode of ["exact", "auto"]) {
        assert.match(textOf(await query({ query: "headeronlyneedle", mode, depth: "summary", limit: 1 })), /unicode-boundary/u);
        assert.match(textOf(await query({ query: "猫咪边界", mode, depth: "summary", limit: 1 })), /unicode-boundary/u);
    }
    assert.match(textOf(await query({ query: "outsideonlyneedle", mode: "exact", depth: "summary", limit: 1 })), /未找到/u);
});

test("a missing memory body remains searchable through metadata", async () => {
    const candidate = entry("absent-body", "metadataonlyneedle");
    await setIndex([candidate]);
    const result = await query({ query: "metadataonlyneedle", mode: "exact", depth: "summary", limit: 1 });
    assert.match(textOf(result), /absent-body/u);
});

test("body read errors preserve exact metadata fallback and auto error reporting", async context => {
    const candidate = entry("read-failure", "fallbackneedle");
    await setIndex([candidate]);
    const originalOpen = fs.open;
    context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]) === getEntryPath("general", candidate.id)) {
            throw Object.assign(new Error("query prefix permission denied"), { code: "EACCES" });
        }
        return originalOpen(...args);
    });
    assert.match(textOf(await query({ query: "fallbackneedle", mode: "exact", depth: "summary", limit: 1 })), /read-failure/u);
    assert.match(textOf(await query({ query: "fallbackneedle", mode: "auto", depth: "summary", limit: 1 })), /query prefix permission denied/u);
});

test("global candidates read the body from their original workspace", async () => {
    await setIndex([]);
    const candidate = entry("other-workspace");
    await setIndex([candidate], "query-fixture-workspace");
    await fs.writeFile(getEntryPath("query-fixture-workspace", candidate.id), "foreignbodyneedle");
    assert.match(textOf(await query({ query: "foreignbodyneedle", mode: "exact", scope: "global", depth: "summary", limit: 1 })), /other-workspace/u);
});
