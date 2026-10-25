import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as zlib from "node:zlib";
import {
    assertCodexHistoryManifest,
    assertCodexHistorySourceAsync,
    codexHistorySegmentReadPath,
    resolveCodexHistorySourceAsync,
    type CodexHistorySource,
} from "../src/codex-history-source.ts";

const thread = "11111111-1111-4111-8111-111111111111";
const rollout = "22222222-2222-4222-8222-222222222222";
const encode = (events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n") + "\n";
const body = (message: string) => ({ type: "event_msg", payload: { type: "user_message", message } });
const digest = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");

interface Fixture {
    directory: string;
    parent: string;
    parentText: string;
    leaf: string;
    leafText: string;
}

async function withFixture(run: (fixture: Fixture) => Promise<void>, chain = false): Promise<void> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-capture-append-"));
    const parent = path.join(directory, `rollout-2026-01-01T00-00-00-${thread}.jsonl`);
    const parentText = encode([{ type: "session_meta", payload: { id: thread } }, body("parent prefix")]);
    const leaf = path.join(directory, `rollout-2026-01-02T00-00-00-${thread}_${rollout}.jsonl`);
    const historyBase = chain ? { history_base: { thread_id: thread, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(parentText) } } : {};
    const leafText = encode([
        { type: "session_meta", payload: { id: thread, ...historyBase } },
        body("p".repeat(20000) + "middle-original" + "q".repeat(20000)),
    ]);
    if (chain) fs.writeFileSync(parent, parentText);
    fs.writeFileSync(leaf, leafText);
    try {
        await run({ directory, parent, parentText, leaf, leafText });
    } finally {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        fs.rmSync(directory, { recursive: true });
    }
}

async function captureDuringPrefix(
    fixture: Fixture,
    mutate: (reads: number) => void,
    options: { endByte?: number; target?: string; repeat?: boolean; afterClose?: boolean } = {},
): Promise<{ source: CodexHistorySource; prefixReads: number }> {
    const originalOpen = fsPromises.open;
    let prefixReads = 0;
    fsPromises.open = (async (...parameters: Parameters<typeof fsPromises.open>) => {
        const handle = await originalOpen.apply(fsPromises, parameters);
        if (path.resolve(String(parameters[0])) !== (options.target ?? fixture.leaf)) return handle;
        const originalRead = handle.read.bind(handle);
        const originalClose = handle.close.bind(handle);
        let closesPrefixRead = false;
        handle.read = (async (...readParameters: any[]) => {
            const result = await (originalRead as any)(...readParameters);
            if (Buffer.isBuffer(readParameters[0]) && readParameters[0].length === 1024 * 1024 && readParameters[3] === 0) {
                prefixReads += 1;
                closesPrefixRead = true;
                if (!options.afterClose && (prefixReads === 1 || options.repeat)) mutate(prefixReads);
            }
            return result;
        }) as typeof handle.read;
        handle.close = async () => {
            await originalClose();
            if (options.afterClose && closesPrefixRead && (prefixReads === 1 || options.repeat)) mutate(prefixReads);
        };
        return handle;
    }) as typeof fsPromises.open;
    try {
        const source = await resolveCodexHistorySourceAsync(fixture.leaf, {
            roots: [fixture.directory],
            archive: { cacheRoot: path.join(fixture.directory, "views"), ownerId: "synthetic-capture-append", minFreeBytes: 1024 * 1024 },
            ...(options.endByte === undefined ? {} : { endByte: options.endByte }),
        });
        return { source, prefixReads };
    } finally {
        fsPromises.open = originalOpen;
        assert.ok(prefixReads > 0, "the mutation hook ran inside the bounded prefix read");
    }
}

async function assertPinned(source: CodexHistorySource, fixture: Fixture, leafText = fixture.leafText): Promise<void> {
    assertCodexHistoryManifest(source);
    const leaf = source.segments.at(-1)!;
    assert.equal(leaf.endByte, Buffer.byteLength(leafText));
    assert.equal(leaf.prefixSha256, digest(leafText));
    assert.equal(source.totalBytes, source.segments.reduce((total, segment) => total + segment.endByte, 0));
    const capturedRevision = source.revision;
    await assertCodexHistorySourceAsync(source);
    const reloaded = structuredClone(source);
    await assertCodexHistorySourceAsync(reloaded);
    assert.equal(reloaded.revision, capturedRevision);
    assert.equal(fs.readFileSync(codexHistorySegmentReadPath(leaf)).subarray(0, leaf.endByte).toString("utf8"), leafText);
}

test("capture permits a pure append after the fixed endByte and preserves provenance", async () => {
    await withFixture(async fixture => {
        const initial = fs.statSync(fixture.leaf);
        const { source, prefixReads } = await captureDuringPrefix(fixture, () => fs.appendFileSync(fixture.leaf, encode([body("unadopted append")])));
        assert.ok(prefixReads >= 2, "changed physical identity requires a fresh prefix proof");
        assert.equal(source.segments.at(-1)!.size, initial.size);
        assert.equal(source.segments.at(-1)!.mtimeMs, initial.mtimeMs);
        await assertPinned(source, fixture);
        fs.appendFileSync(fixture.leaf, encode([body("later append")]));
        await assertPinned(source, fixture);
        const expanded = await resolveCodexHistorySourceAsync(fixture.leaf, { roots: [fixture.directory] });
        assert.ok(expanded.totalBytes > source.totalBytes);
        assert.notEqual(expanded.revision, source.revision);
    });
});

test("capture rejects an interior rewrite hidden behind an append", async () => {
    await withFixture(async fixture => {
        await assert.rejects(() => captureDuringPrefix(fixture, () => {
            fs.writeFileSync(fixture.leaf, fixture.leafText.replace("middle-original", "middle-modified") + encode([body("append")]));
        }), /content changed|source capture/u);
    });
});

test("capture rejects a same-size rewrite with a different mtime", async () => {
    await withFixture(async fixture => {
        const before = fs.statSync(fixture.leaf);
        await assert.rejects(() => captureDuringPrefix(fixture, () => {
            fs.writeFileSync(fixture.leaf, fixture.leafText.replace("middle-original", "middle-modified"));
            fs.utimesSync(fixture.leaf, before.atime, new Date(before.mtimeMs + 10000));
            assert.equal(fs.statSync(fixture.leaf).size, before.size);
            assert.notEqual(fs.statSync(fixture.leaf).mtimeMs, before.mtimeMs);
        }), /source capture/u);
    });
});

test("capture rejects truncation after the prefix was read", async () => {
    await withFixture(async fixture => {
        await assert.rejects(() => captureDuringPrefix(fixture, () => fs.truncateSync(fixture.leaf, 100)), /source capture|shorter|shortened/u);
    });
});

test("capture rejects a replacement inode even when its prefix and append are valid", async () => {
    await withFixture(async fixture => {
        const before = fs.statSync(fixture.leaf);
        await assert.rejects(() => captureDuringPrefix(fixture, () => {
            const replacement = path.join(fixture.directory, "replacement.jsonl");
            fs.writeFileSync(replacement, fixture.leafText + encode([body("valid append")]));
            fs.renameSync(replacement, fixture.leaf);
            assert.notEqual(fs.statSync(fixture.leaf).ino, before.ino);
        }, { afterClose: true }), /source capture/u);
    });
});

test("capture keeps an incomplete trailing line outside the fixed range", async () => {
    await withFixture(async fixture => {
        fs.appendFileSync(fixture.leaf, '{"type":');
        const { source } = await captureDuringPrefix(fixture, () => fs.appendFileSync(fixture.leaf, '"event_msg","payload":{"type":"user_message","message":"completed later"}}\n'));
        assert.equal(source.segments.at(-1)!.unterminatedLeaf, undefined);
        await assertPinned(source, fixture);
    });
});

test("capture preserves a complete unterminated JSON leaf when later bytes arrive", async () => {
    await withFixture(async fixture => {
        const leafText = fixture.leafText.trimEnd();
        fs.writeFileSync(fixture.leaf, leafText);
        const { source } = await captureDuringPrefix(fixture, () => fs.appendFileSync(fixture.leaf, "\n" + encode([body("later")])));
        assert.equal(source.segments.at(-1)!.unterminatedLeaf, true);
        await assertPinned(source, fixture, leafText);
    });
});

test("an explicit endByte stays fixed during append and rejects an incomplete boundary", async () => {
    await withFixture(async fixture => {
        const endByte = Buffer.byteLength(fixture.leafText);
        const { source } = await captureDuringPrefix(fixture, () => fs.appendFileSync(fixture.leaf, encode([body("later")])), { endByte });
        await assertPinned(source, fixture);
        await assert.rejects(() => resolveCodexHistorySourceAsync(fixture.leaf, { roots: [], endByte: endByte - 1 }), /not a complete JSONL line/u);
    });
});

test("ancestor identity changes during its capture remain forbidden", async () => {
    await withFixture(async fixture => {
        await assert.rejects(() => captureDuringPrefix(fixture, () => fs.appendFileSync(fixture.parent, encode([body("ancestor append")])), { target: fixture.parent }), /source capture/u);
    }, true);
});

test("leaf append during ancestor capture is revalidated without changing ancestry", async () => {
    await withFixture(async fixture => {
        const { source } = await captureDuringPrefix(fixture, () => fs.appendFileSync(fixture.leaf, encode([body("late leaf append")])), { target: fixture.parent });
        assert.equal(source.segments.length, 2);
        assert.equal(source.segments[0]!.endByte, Buffer.byteLength(fixture.parentText));
        assert.equal(source.segments[0]!.endOrdinalExclusive, 2);
        assert.equal(source.segments[1]!.startOrdinal, 2);
        await assertPinned(source, fixture);
    }, true);
});

test("a rewritten captured parent cannot slip through while a later ancestor is loaded", async () => {
    await withFixture(async fixture => {
        const grandparentId = "33333333-3333-4333-8333-333333333333";
        const grandparent = path.join(fixture.directory, `rollout-2025-12-31T00-00-00-${grandparentId}.jsonl`);
        const grandparentText = encode([{ type: "session_meta", payload: { id: grandparentId } }, body("grandparent")]);
        fs.writeFileSync(grandparent, grandparentText);
        const parentText = encode([{ type: "session_meta", payload: { id: thread, history_base: { thread_id: grandparentId, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(grandparentText) } } }, body("parent prefix")]);
        fs.writeFileSync(fixture.parent, parentText);
        fs.writeFileSync(fixture.leaf, fixture.leafText.replace('"end_ordinal_exclusive":2', '"end_ordinal_exclusive":4').replace(`"end_byte_offset":${Buffer.byteLength(fixture.parentText)}`, `"end_byte_offset":${Buffer.byteLength(parentText)}`));
        await assert.rejects(() => captureDuringPrefix(fixture, () => {
            fs.writeFileSync(fixture.parent, parentText.replace("parent prefix", "parent edited"));
        }, { target: grandparent }), /source capture/u);
    }, true);
});

test("a same-size rewrite between header load and the capture identity sample is rejected", async () => {
    await withFixture(async fixture => {
        const originalOpen = fsPromises.open;
        const before = fs.statSync(fixture.leaf);
        let mutated = false;
        fsPromises.open = (async (...parameters: Parameters<typeof fsPromises.open>) => {
            const handle = await originalOpen.apply(fsPromises, parameters);
            if (path.resolve(String(parameters[0])) !== fixture.leaf) return handle;
            const originalRead = handle.read.bind(handle);
            handle.read = (async (...readParameters: any[]) => {
                const result = await (originalRead as any)(...readParameters);
                if (!mutated) {
                    mutated = true;
                    fs.writeFileSync(fixture.leaf, fixture.leafText.replace("middle-original", "middle-modified"));
                    fs.utimesSync(fixture.leaf, before.atime, new Date(before.mtimeMs + 10000));
                }
                return result;
            }) as typeof handle.read;
            return handle;
        }) as typeof fsPromises.open;
        try {
            await assert.rejects(() => resolveCodexHistorySourceAsync(fixture.leaf, { roots: [fixture.directory] }), /source capture/u);
            assert.equal(mutated, true);
        } finally {
            fsPromises.open = originalOpen;
        }
    });
});

test("the validation cache cannot adopt an identity sampled after the last verified observation", async () => {
    await withFixture(async fixture => {
        const originalStat = fsPromises.stat;
        let leafStats = 0;
        let mutated = false;
        fsPromises.stat = (async (...parameters: Parameters<typeof fsPromises.stat>) => {
            const result = await originalStat.apply(fsPromises, parameters);
            if (path.resolve(String(parameters[0])) === fixture.leaf && parameters[1] === undefined && ++leafStats === 5) {
                mutated = true;
                fs.writeFileSync(fixture.leaf, fixture.leafText.replace("middle-original", "middle-modified"));
            }
            return result;
        }) as typeof fsPromises.stat;
        let source: CodexHistorySource;
        try {
            source = await resolveCodexHistorySourceAsync(fixture.leaf, { roots: [fixture.directory] });
            assert.equal(mutated, true);
            assert.equal(leafStats, 5, "no unchecked identity is sampled just to populate the validation cache");
        } finally {
            fsPromises.stat = originalStat;
        }
        await assert.rejects(() => assertCodexHistorySourceAsync(source), /content changed/u);
    });
});

test("continuous append has a bounded fresh-proof budget", async () => {
    await withFixture(async fixture => {
        let mutations = 0;
        await assert.rejects(() => captureDuringPrefix(fixture, () => {
            mutations += 1;
            assert.ok(mutations <= 4, "capture must not retry indefinitely");
            fs.appendFileSync(fixture.leaf, encode([body("continuous append")]));
        }, { repeat: true }), /source capture/u);
        assert.ok(mutations >= 2 && mutations <= 4);
    });
});

test("subsequent validation rejects a middle rewrite even if mtime is restored", async () => {
    await withFixture(async fixture => {
        const { source } = await captureDuringPrefix(fixture, () => fs.appendFileSync(fixture.leaf, encode([body("append")])));
        const before = fs.statSync(fixture.leaf);
        fs.writeFileSync(fixture.leaf, fs.readFileSync(fixture.leaf, "utf8").replace("middle-original", "middle-modified"));
        fs.utimesSync(fixture.leaf, before.atime, before.mtime);
        await assert.rejects(() => assertCodexHistorySourceAsync(source), /content changed/u);
    });
});

test("compressed leaf and identical replicas retain their fixed-range checks", async () => {
    await withFixture(async fixture => {
        const compressed = `${fixture.leaf}.zst`;
        fs.writeFileSync(compressed, zlib.zstdCompressSync(Buffer.from(fixture.leafText)));
        const archive = { cacheRoot: path.join(fixture.directory, "views"), ownerId: "synthetic-capture-append", minFreeBytes: 1024 * 1024 };
        const source = await resolveCodexHistorySourceAsync(compressed, { roots: [fixture.directory], archive });
        assert.ok(source.segments.at(-1)!.archive);
        assert.equal(source.segments.at(-1)!.replicas?.length, 1);
        await assertPinned(source, fixture);
        fs.writeFileSync(fixture.leaf, fixture.leafText.replace("middle-original", "middle-modified"));
        await assert.rejects(() => assertCodexHistorySourceAsync(source), /replica changed/u);
        await assert.rejects(() => resolveCodexHistorySourceAsync(compressed, { roots: [fixture.directory], archive }), /Conflicting plaintext\/compressed/u);
    });
});

test("a leaf with a compressed replica cannot use the plain-append exception", async () => {
    await withFixture(async fixture => {
        fs.writeFileSync(`${fixture.leaf}.zst`, zlib.zstdCompressSync(Buffer.from(fixture.leafText)));
        await assert.rejects(() => captureDuringPrefix(fixture, () => fs.appendFileSync(fixture.leaf, encode([body("replica divergence")]))), /source capture|Conflicting plaintext\/compressed/u);
    });
});

test("a compressed-only leaf retains logical byte boundaries and its archive identity", async () => {
    await withFixture(async fixture => {
        const compressed = `${fixture.leaf}.zst`;
        fs.writeFileSync(compressed, zlib.zstdCompressSync(Buffer.from(fixture.leafText)));
        fs.unlinkSync(fixture.leaf);
        const archive = { cacheRoot: path.join(fixture.directory, "views"), ownerId: "synthetic-capture-append", minFreeBytes: 1024 * 1024 };
        const source = await resolveCodexHistorySourceAsync(compressed, { roots: [fixture.directory], archive });
        assert.equal(source.segments.at(-1)!.archive?.sourceSha256, digest(fs.readFileSync(compressed)));
        await assertPinned(source, fixture);
        fs.writeFileSync(compressed, zlib.zstdCompressSync(Buffer.from(fixture.leafText.replace("middle-original", "middle-modified"))));
        await assert.rejects(() => assertCodexHistorySourceAsync(source), /physical archive changed/u);
    });
});

test("the bounded production parser reads only the captured prefix and detects a later rewrite", async () => {
    await withFixture(async fixture => {
        const previousRoot = process.env.MEMORY_STORE_DATA_ROOT;
        process.env.MEMORY_STORE_DATA_ROOT = path.join(fixture.directory, "data");
        try {
            const { readRolloutEvents } = await import("../src/codex-client.ts");
            const { source } = await captureDuringPrefix(fixture, () => fs.appendFileSync(fixture.leaf, encode([body("unadopted")])));
            const leaf = source.segments.at(-1)!;
            const options = { endByte: leaf.endByte, strict: true, expectedPrefixSha256: leaf.prefixSha256, prefixIdentity: leaf };
            const events = readRolloutEvents(fixture.leaf, options);
            assert.equal(events.length, 2);
            assert.equal(events[1]!.payload.message.includes("unadopted"), false);
            fs.appendFileSync(fixture.leaf, encode([body("also unadopted")]));
            assert.deepEqual(readRolloutEvents(fixture.leaf, options), events);
            fs.writeFileSync(fixture.leaf, fs.readFileSync(fixture.leaf, "utf8").replace("middle-original", "middle-modified"));
            assert.throws(() => readRolloutEvents(fixture.leaf, options), /content changed during parsing/u);
        } finally {
            if (previousRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
            else process.env.MEMORY_STORE_DATA_ROOT = previousRoot;
        }
    });
});
