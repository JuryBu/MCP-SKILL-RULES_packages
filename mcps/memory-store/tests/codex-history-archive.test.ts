import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as zlib from "node:zlib";
import xxhash from "xxhash-wasm";
import { materializeCodexHistoryArchive, materializeCodexHistoryArchiveSync } from "../src/codex-history-archive.ts";

const xxhashApi = await xxhash();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-history-archive-test-"));
const options = { cacheRoot: path.join(temp, "views"), ownerId: "synthetic-archive-tests", maxDecompressedBytes: 4 * 1024 * 1024, minFreeBytes: 1024 * 1024 };
const hash = (value: Buffer) => crypto.createHash("sha256").update(value).digest("hex");

function rawFrame(value: Buffer, checksum = true): Buffer {
    const header = Buffer.alloc(9);
    header.writeUInt32LE(0xfd2fb528);
    header[4] = checksum ? 0xa4 : 0xa0;
    header.writeUInt32LE(value.length, 5);
    const blocks: Buffer[] = [header];
    for (let position = 0; position < value.length || position === 0;) {
        const count = Math.min(128 * 1024, value.length - position);
        const last = position + count === value.length;
        const block = Buffer.alloc(3);
        block.writeUIntLE(count * 8 + Number(last), 0, 3);
        blocks.push(block, value.subarray(position, position + count));
        position += count;
        if (last) break;
    }
    if (checksum) {
        const trailer = Buffer.alloc(4);
        trailer.writeUInt32LE(Number(xxhashApi.h64Raw(value) & 0xffffffffn));
        blocks.push(trailer);
    }
    return Buffer.concat(blocks);
}

function archive(name: string, value: Buffer): string {
    const file = path.join(temp, `${name}.jsonl.zst`);
    fs.writeFileSync(file, value);
    return file;
}

function partialFiles(): string[] {
    const pending = [options.cacheRoot];
    const partial: string[] = [];
    while (pending.length) {
        const directory = pending.pop()!;
        if (!fs.existsSync(directory)) continue;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name.startsWith(".partial-") || entry.name.includes(".pointer.json.partial-")) partial.push(path.join(directory, entry.name));
            if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
        }
    }
    return partial;
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(complete => { resolve = complete; });
    return { promise, resolve };
}

async function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10000);
        })]);
    } finally { if (timer) clearTimeout(timer); }
}

async function testConcurrentRepair(decoder: "auto" | "fzstd"): Promise<void> {
    const bytes = Buffer.from("synthetic concurrent repair\n".repeat(3000));
    const file = archive(`repair-${decoder}`, rawFrame(bytes));
    const localOptions = { ...options, decoder };
    const old = materializeCodexHistoryArchiveSync(file, localOptions);
    fs.writeFileSync(old.viewPath, Buffer.alloc(bytes.length, 120));
    const gates = [deferred(), deferred()];
    const ready = deferred();
    let readers = 0;
    let completed = 0;
    let secondHashCompleted = false;
    let checksAfterHash = 0;
    const original = fs.createReadStream;
    fs.createReadStream = ((input, streamOptions) => {
        const stream = original(input, streamOptions);
        if (String(input) !== old.viewPath) return stream;
        const reader = readers++;
        assert.ok(reader < gates.length);
        const iterate = stream[Symbol.asyncIterator].bind(stream);
        stream[Symbol.asyncIterator] = async function* () {
            for await (const chunk of { [Symbol.asyncIterator]: iterate }) yield chunk;
            if (++completed === gates.length) ready.resolve();
            await gates[reader]!.promise;
            if (reader === 1) secondHashCompleted = true;
        };
        return stream;
    }) as typeof fs.createReadStream;
    const first = materializeCodexHistoryArchive(file, localOptions);
    const second = materializeCodexHistoryArchive(file, {
        ...localOptions, isCancelled: () => secondHashCompleted && ++checksAfterHash > 1,
    });
    const secondResult = assert.rejects(second, { name: "AbortError" });
    try {
        await withDeadline(ready.promise, "both damaged-view readers");
        gates[0]!.resolve();
        const winner = await withDeadline(first, "first repaired view");
        assert.notEqual(winner.viewPath, old.viewPath);
        assert.equal(hash(fs.readFileSync(winner.viewPath)), hash(bytes));
        gates[1]!.resolve();
        await withDeadline(secondResult, "late reader cancellation");
        assert.equal(hash(fs.readFileSync(winner.viewPath)), hash(bytes));
        assert.equal((await materializeCodexHistoryArchive(file, localOptions)).viewPath, winner.viewPath);
        assert.equal(path.dirname(path.dirname(path.dirname(winner.viewPath))), options.cacheRoot);
    } finally {
        gates.forEach(gate => gate.resolve());
        await Promise.allSettled([first, secondResult]);
        fs.createReadStream = original;
    }
    assert.deepEqual(partialFiles(), []);
}

async function testSyncDuringAsyncRepair(): Promise<void> {
    const bytes = Buffer.from("synthetic sync/async repair\n");
    const file = archive("sync-during-async", rawFrame(bytes));
    const old = materializeCodexHistoryArchiveSync(file, options);
    fs.writeFileSync(old.viewPath, Buffer.alloc(bytes.length, 120));
    const ready = deferred();
    const gate = deferred();
    let hashCompleted = false;
    let checksAfterHash = 0;
    const original = fs.createReadStream;
    fs.createReadStream = ((input, streamOptions) => {
        const stream = original(input, streamOptions);
        if (String(input) !== old.viewPath) return stream;
        const iterate = stream[Symbol.asyncIterator].bind(stream);
        stream[Symbol.asyncIterator] = async function* () {
            for await (const chunk of { [Symbol.asyncIterator]: iterate }) yield chunk;
            ready.resolve();
            await gate.promise;
            hashCompleted = true;
        };
        return stream;
    }) as typeof fs.createReadStream;
    const asynchronous = materializeCodexHistoryArchive(file, {
        ...options, isCancelled: () => hashCompleted && ++checksAfterHash > 1,
    });
    const cancelled = assert.rejects(asynchronous, { name: "AbortError" });
    try {
        await withDeadline(ready.promise, "async damaged-view reader");
        const synchronous = materializeCodexHistoryArchiveSync(file, options);
        gate.resolve();
        await withDeadline(cancelled, "async cancellation after sync publication");
        assert.equal(hash(fs.readFileSync(synchronous.viewPath)), hash(bytes));
        assert.equal(materializeCodexHistoryArchiveSync(file, options).viewPath, synchronous.viewPath);
    } finally {
        gate.resolve();
        await Promise.allSettled([cancelled]);
        fs.createReadStream = original;
    }
}

async function testLegacyViewAndPointerFailure(): Promise<void> {
    const bytes = Buffer.from("synthetic legacy layout\n");
    const file = archive("legacy-layout", rawFrame(bytes));
    const current = materializeCodexHistoryArchiveSync(file, options);
    const directory = path.dirname(current.viewPath);
    const root = path.dirname(directory);
    const key = path.basename(directory).slice(0, 64);
    const pointer = path.join(root, `${key}.pointer.json`);
    const legacy = path.join(root, key);
    fs.renameSync(directory, legacy);
    const legacyView = { ...current, viewPath: path.join(legacy, "content.jsonl") };
    fs.writeFileSync(path.join(legacy, "manifest.json"), JSON.stringify(legacyView));
    fs.unlinkSync(pointer);
    assert.equal(materializeCodexHistoryArchiveSync(file, options).viewPath, legacyView.viewPath);
    assert.equal((await materializeCodexHistoryArchive(file, options)).viewPath, legacyView.viewPath);
    fs.writeFileSync(legacyView.viewPath, Buffer.alloc(bytes.length, 120));
    const rebuilt = await materializeCodexHistoryArchive(file, options);
    assert.notEqual(rebuilt.viewPath, legacyView.viewPath);
    assert.ok(fs.existsSync(legacyView.viewPath));
    assert.equal(hash(fs.readFileSync(rebuilt.viewPath)), hash(bytes));
    const publishedPointer = fs.readFileSync(pointer, "utf8");
    fs.writeFileSync(rebuilt.viewPath, Buffer.alloc(bytes.length, 120));
    const original = fs.renameSync;
    fs.renameSync = ((from, to) => {
        if (String(to) === pointer) throw new Error("synthetic pointer publication failure");
        return original(from, to);
    }) as typeof fs.renameSync;
    try {
        assert.throws(() => materializeCodexHistoryArchiveSync(file, options), /pointer publication failure/);
        assert.equal(fs.readFileSync(pointer, "utf8"), publishedPointer);
        assert.ok(fs.existsSync(rebuilt.viewPath));
        assert.deepEqual(partialFiles(), []);
    } finally { fs.renameSync = original; }
    const repaired = materializeCodexHistoryArchiveSync(file, options);
    assert.equal(hash(fs.readFileSync(repaired.viewPath)), hash(bytes));
}

async function testInvalidPointers(): Promise<void> {
    const bytes = Buffer.from("synthetic pointer validation\n");
    const file = archive("pointer-validation", rawFrame(bytes));
    let current = materializeCodexHistoryArchiveSync(file, options);
    const root = path.dirname(path.dirname(current.viewPath));
    const key = path.basename(path.dirname(current.viewPath)).slice(0, 64);
    const pointer = path.join(root, `${key}.pointer.json`);
    for (const invalid of ["{", "x".repeat(4097), JSON.stringify({ format: "memory-store-codex-history-view-pointer-v1", directory: "../outside" }),
        JSON.stringify({ format: "memory-store-codex-history-view-pointer-v1", directory: `${key}.00000000-0000-4000-8000-000000000000` })]) {
        const previous = current;
        fs.writeFileSync(pointer, invalid);
        current = await materializeCodexHistoryArchive(file, options);
        assert.notEqual(current.viewPath, previous.viewPath);
        assert.equal(hash(fs.readFileSync(current.viewPath)), hash(bytes));
        assert.equal(hash(fs.readFileSync(previous.viewPath)), hash(bytes));
    }
    assert.deepEqual(partialFiles(), []);
}

async function testCrossProcessRepair(): Promise<void> {
    const bytes = Buffer.from("synthetic shared-directory repair\n".repeat(2000));
    const file = archive("cross-process", rawFrame(bytes));
    const old = materializeCodexHistoryArchiveSync(file, options);
    fs.writeFileSync(old.viewPath, Buffer.alloc(bytes.length, 120));
    const directory = path.join(temp, "process-gates");
    fs.mkdirSync(directory);
    const moduleUrl = pathToFileURL(path.resolve("src/codex-history-archive.ts")).href;
    const script = `
import fs from "node:fs";
import path from "node:path";
const [moduleUrl, file, optionsJson, oldPath, directory, role] = process.argv.slice(1);
const { materializeCodexHistoryArchive } = await import(moduleUrl);
const options = JSON.parse(optionsJson);
let hashCompleted = false;
let checksAfterHash = 0;
const original = fs.createReadStream;
fs.createReadStream = (input, streamOptions) => {
    const stream = original(input, streamOptions);
    if (String(input) !== oldPath) return stream;
    const iterate = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = async function* () {
        for await (const chunk of { [Symbol.asyncIterator]: iterate }) yield chunk;
        fs.writeFileSync(path.join(directory, role + ".ready"), "ready");
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(path.join(directory, role + ".release"))) {
            if (Date.now() > deadline) throw new Error("child barrier timeout");
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        hashCompleted = true;
    };
    return stream;
};
try {
    const view = await materializeCodexHistoryArchive(file, { ...options,
        isCancelled: () => role === "second" && hashCompleted && ++checksAfterHash > 1 });
    console.log(JSON.stringify({ role, view }));
} catch (error) {
    if (role !== "second" || error.name !== "AbortError") throw error;
    console.log(JSON.stringify({ role, cancelled: true }));
}
`;
    const children = ["first", "second"].map(role => {
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script,
            moduleUrl, file, JSON.stringify(options), old.viewPath, directory, role], { cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let errors = "";
        child.stdout.on("data", chunk => { output += chunk; });
        child.stderr.on("data", chunk => { errors += chunk; });
        const result = new Promise<{ view?: { viewPath: string }; cancelled?: boolean }>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", code => code === 0 ? resolve(JSON.parse(output.trim())) : reject(new Error(`archive child ${role}: ${code} ${errors}`)));
        });
        void result.catch(() => undefined);
        return { child, result, role };
    });
    try {
        await withDeadline((async () => {
            const deadline = Date.now() + 9500;
            while (!children.every(({ role }) => fs.existsSync(path.join(directory, `${role}.ready`)))) {
                if (Date.now() > deadline) throw new Error("cross-process parent barrier timeout");
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        })(), "both cross-process damaged-view readers");
        fs.writeFileSync(path.join(directory, "first.release"), "release");
        const first = await withDeadline(children[0]!.result, "cross-process winner");
        assert.ok(first.view);
        fs.writeFileSync(path.join(directory, "second.release"), "release");
        assert.equal((await withDeadline(children[1]!.result, "cross-process cancellation")).cancelled, true);
        assert.equal(hash(fs.readFileSync(first.view.viewPath)), hash(bytes));
        assert.equal(materializeCodexHistoryArchiveSync(file, options).viewPath, first.view.viewPath);
    } finally {
        for (const { role } of children) fs.writeFileSync(path.join(directory, `${role}.release`), "release");
        await Promise.allSettled(children.map(({ result }) => result));
    }
    assert.deepEqual(partialFiles(), []);
}

try {
    for (const length of [0, 1, 3, 4, 7, 8, 15, 31, 32, 33, 127, 65537, 262177]) {
        const bytes = Buffer.alloc(length);
        for (let index = 0; index < length; index += 1) bytes[index] = index % 251;
        const file = archive(`checksum-${length}`, rawFrame(bytes));
        const sync = materializeCodexHistoryArchiveSync(file, options);
        assert.equal(sync.logicalSha256, hash(bytes));
        assert.equal(sync.logicalSize, bytes.length);
        assert.equal(sync.sourcePath, file);
        assert.equal(sync.sourceSha256, hash(fs.readFileSync(file)));
        assert.deepEqual(fs.readFileSync(sync.viewPath), bytes);
        assert.deepEqual(await materializeCodexHistoryArchive(file, options), sync);
        const fallback = await materializeCodexHistoryArchive(file, { ...options, ownerId: `fallback-${length}`, decoder: "fzstd" });
        assert.equal(fallback.logicalSha256, sync.logicalSha256);
    }

    const first = Buffer.from('{"type":"session_meta","payload":{"id":"synthetic"}}\n');
    const second = Buffer.from('{"type":"event","value":"中文🙂"}\n');
    const concatenated = archive("concatenated", Buffer.concat([rawFrame(first), rawFrame(second)]));
    const native = await materializeCodexHistoryArchive(concatenated, { ...options, ownerId: "native" });
    const fallback = await materializeCodexHistoryArchive(concatenated, { ...options, decoder: "fzstd", ownerId: "fallback" });
    assert.equal(native.logicalSha256, hash(Buffer.concat([first, second])));
    assert.equal(native.logicalSha256, fallback.logicalSha256);
    assert.equal(materializeCodexHistoryArchiveSync(concatenated, options).logicalSha256, native.logicalSha256);
    assert.ok(native.rebuildable && native.cleanupCondition.includes("active readers"));
    const concurrent = archive("concurrent", rawFrame(Buffer.alloc(131099, 97)));
    const views = await Promise.all([materializeCodexHistoryArchive(concurrent, options), materializeCodexHistoryArchive(concurrent, options)]);
    assert.equal(views[0]!.logicalSha256, views[1]!.logicalSha256);
    for (const view of views) assert.equal(hash(fs.readFileSync(view.viewPath)), view.logicalSha256);
    assert.ok(views.some(view => view.viewPath === materializeCodexHistoryArchiveSync(concurrent, options).viewPath));

    const mutableFs = fs as { statfsSync?: typeof fs.statfsSync };
    const statfs = mutableFs.statfsSync;
    try {
        mutableFs.statfsSync = undefined;
        const oldNodeFile = archive("without-statfs", rawFrame(Buffer.from("old Node disk admission\n")));
        assert.equal(materializeCodexHistoryArchiveSync(oldNodeFile, options).logicalSize, 24);
    } finally { mutableFs.statfsSync = statfs; }

    if (typeof zlib.zstdCompressSync === "function") {
        const compressedText = Buffer.from("synthetic event 中文\n".repeat(20000));
        const compressed = archive("compressed-blocks", zlib.zstdCompressSync(compressedText));
        assert.equal((await materializeCodexHistoryArchive(compressed, options)).logicalSha256, hash(compressedText));
        assert.equal(materializeCodexHistoryArchiveSync(compressed, options).logicalSha256, hash(compressedText));
    }

    const valid = rawFrame(Buffer.from("safe synthetic bytes\n"));
    const badChecksum = Buffer.from(valid);
    badChecksum[badChecksum.length - 1] ^= 1;
    for (const [name, bytes] of [
        ["truncated", valid.subarray(0, valid.length - 1)],
        ["checksum", badChecksum],
        ["junk", Buffer.concat([valid, Buffer.from("junk")])],
        ["invalid", Buffer.from("plain text")],
        ["empty", Buffer.alloc(0)],
    ] as const) {
        const file = archive(`bad-${name}`, bytes);
        assert.throws(() => materializeCodexHistoryArchiveSync(file, options), /archive|zstd|EOF/);
        await assert.rejects(materializeCodexHistoryArchive(file, { ...options, ownerId: `native-bad-${name}` }));
        await assert.rejects(materializeCodexHistoryArchive(file, { ...options, ownerId: `fallback-bad-${name}`, decoder: "fzstd" }));
        assert.deepEqual(partialFiles(), [], `failure ${name} must leave no usable partial view`);
    }

    const limited = archive("limited", rawFrame(Buffer.alloc(65536)));
    assert.throws(() => materializeCodexHistoryArchiveSync(limited, { ...options, maxCompressedBytes: 5 }), /compressed size limit/);
    assert.throws(() => materializeCodexHistoryArchiveSync(limited, { ...options, maxDecompressedBytes: 1024 }), /decompressed size limit/);
    assert.throws(() => materializeCodexHistoryArchiveSync(limited, { ...options, maxWindowBytes: 1024 }), /window limit/);
    assert.throws(() => materializeCodexHistoryArchiveSync(limited, { ...options, minFreeBytes: Number.MAX_SAFE_INTEGER - options.maxDecompressedBytes }), /free disk space/);
    assert.deepEqual(partialFiles(), []);
    const noContentSizeHeader = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 4, 56]);
    const unknownSize = archive("unknown-content-size", Buffer.concat([noContentSizeHeader, rawFrame(Buffer.alloc(65536)).subarray(9)]));
    assert.throws(() => materializeCodexHistoryArchiveSync(unknownSize, { ...options, maxDecompressedBytes: 1024 }), /decompressed size limit/);
    await assert.rejects(materializeCodexHistoryArchive(unknownSize, { ...options, maxDecompressedBytes: 1024 }), /decompressed size limit/);
    assert.deepEqual(partialFiles(), []);

    const changing = archive("changing", rawFrame(Buffer.from("alpha\n")));
    const oldStat = fs.statSync(changing);
    const old = materializeCodexHistoryArchiveSync(changing, options);
    fs.writeFileSync(changing, rawFrame(Buffer.from("omega\n")));
    fs.utimesSync(changing, oldStat.atime, oldStat.mtime);
    const updated = await materializeCodexHistoryArchive(changing, options);
    assert.notEqual(updated.sourceSha256, old.sourceSha256, "same-size/mtime archive replacement must invalidate the view");
    assert.notEqual(updated.viewPath, old.viewPath);
    assert.equal(updated.logicalSha256, hash(Buffer.from("omega\n")));
    assert.deepEqual(fs.readFileSync(old.viewPath), Buffer.from("alpha\n"));
    fs.writeFileSync(updated.viewPath, "broken");
    const rebuilt = await materializeCodexHistoryArchive(changing, options);
    assert.notEqual(rebuilt.viewPath, updated.viewPath);
    assert.equal(rebuilt.logicalSha256, updated.logicalSha256);
    fs.unlinkSync(rebuilt.viewPath);
    assert.equal(materializeCodexHistoryArchiveSync(changing, options).logicalSha256, updated.logicalSha256);

    const cancelled = archive("cancelled", rawFrame(Buffer.alloc(2 * 1024 * 1024)));
    let syncChecks = 0;
    assert.throws(() => materializeCodexHistoryArchiveSync(cancelled, { ...options, isCancelled: () => ++syncChecks > 70 }), { name: "AbortError" });
    let asyncChecks = 0;
    await assert.rejects(materializeCodexHistoryArchive(cancelled, { ...options, ownerId: "cancel-async", isCancelled: () => ++asyncChecks > 70 }), { name: "AbortError" });
    await assert.rejects(materializeCodexHistoryArchive(cancelled, { ...options, isCancelled: () => true }), { name: "AbortError" });
    let fallbackChecks = 0;
    await assert.rejects(materializeCodexHistoryArchive(cancelled, { ...options, ownerId: "cancel-fallback", decoder: "fzstd", isCancelled: () => ++fallbackChecks > 350 }), { name: "AbortError" });
    assert.deepEqual(partialFiles(), []);
    assert.equal((await materializeCodexHistoryArchive(cancelled, options)).logicalSize, 2 * 1024 * 1024, "a cancelled attempt must be rebuildable");
    await testConcurrentRepair("auto");
    await testConcurrentRepair("fzstd");
    await testSyncDuringAsyncRepair();
    await testLegacyViewAndPointerFailure();
    await testInvalidPointers();
    await testCrossProcessRepair();
    console.log("codex-history-archive: PASS checksums/native/fzstd/concatenation/limits/source replacement/cancellation/atomic cleanup/immutable views/damaged-view concurrency/sync-async/legacy layout/pointer failure/cross-process cancellation");
} finally {
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith("codex-history-archive-test-"));
    fs.rmSync(temp, { recursive: true, force: true });
}
