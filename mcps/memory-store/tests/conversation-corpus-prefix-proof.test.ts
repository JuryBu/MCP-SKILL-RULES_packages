import assert from "node:assert/strict";
import fs from "node:fs";
import promises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { zstdCompressSync } from "node:zlib";
import { test } from "node:test";
import { proveCodexAdoptedPrefix } from "../src/codex-adopted-prefix-proof.ts";
import { codexHistoryPhysicalIdentity, resolveCodexStreamingHistorySource } from "../src/codex-history-source.ts";

async function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-prefix-proof-"));
    const source = path.join(directory, "rollout-2026-01-01T00-00-00-10000000-0000-4000-8000-000000000062.jsonl.zst");
    const header = JSON.stringify({ type: "session_meta", payload: { id: "10000000-0000-4000-8000-000000000062" } }) + "\n";
    const content = Buffer.from(header + "adopted-prefix-fixture\n".repeat(400000));
    fs.writeFileSync(source, zstdCompressSync(content));
    const segment = (await resolveCodexStreamingHistorySource(source, { roots: [directory] })).segments[0]!;
    const cacheRoot = path.join(directory, "proofs");
    const options = { cacheRoot, segment, endByte: content.length, expectedSha256: createHash("sha256").update(content).digest("hex"), archive: { streamChunkBytes: 16384 } };
    return { directory, source, content, segment, cacheRoot, options, close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
}

for (const [name, value] of [
    ["MEMORY_STORE_CODEX_HISTORY_MAX_DECOMPRESSED_BYTES", "1024"],
    ["MEMORY_STORE_CODEX_HISTORY_MAX_COMPRESSED_BYTES", "1"],
    ["MEMORY_STORE_CODEX_HISTORY_MAX_WINDOW_BYTES", "1"],
    ["MEMORY_STORE_CODEX_HISTORY_MAX_DECOMPRESSED_BYTES", "invalid"],
] as const) {
    test(`warm proofs enforce effective environment policy ${name}=${value}`, async () => {
        const sample = await fixture();
        const previous = process.env[name];
        try {
            await proveCodexAdoptedPrefix(sample.options);
            process.env[name] = value;
            await assert.rejects(proveCodexAdoptedPrefix(sample.options));
        } finally {
            if (previous === undefined) delete process.env[name];
            else process.env[name] = previous;
            sample.close();
        }
    });
}

test("a new process cannot reuse a proof after environment policy tightens", async () => {
    const sample = await fixture();
    try {
        await proveCodexAdoptedPrefix(sample.options);
        const script = `const { proveCodexAdoptedPrefix } = await import(${JSON.stringify(new URL("../src/codex-adopted-prefix-proof.ts", import.meta.url).href)}); const { rejects } = await import("node:assert/strict"); await rejects(proveCodexAdoptedPrefix(${JSON.stringify(sample.options)}));`;
        const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", windowsHide: true, env: { ...process.env, MEMORY_STORE_CODEX_HISTORY_MAX_DECOMPRESSED_BYTES: "1024" } });
        assert.equal(child.status, 0, child.stderr);
    } finally { sample.close(); }
});

test("the last cancelled consumer waits for an outstanding proof write and cleanup", async () => {
    const sample = await fixture();
    const originalWrite = promises.writeFile;
    const originalRemove = promises.rm;
    const entered = gate();
    const releaseWrite = gate();
    const cancellationObserved = gate();
    const cleanupFinished = gate();
    let cancelled = false;
    let settled = false;
    promises.writeFile = (async (filename: any, ...args: any[]) => {
        const result = await (originalWrite as (...input: any[]) => any)(filename, ...args);
        if (String(filename).startsWith(sample.cacheRoot) && String(filename).endsWith(".tmp")) { entered.release(); await releaseWrite.promise; }
        return result;
    }) as typeof promises.writeFile;
    promises.rm = (async (filename: any, ...args: any[]) => {
        try { return await (originalRemove as (...input: any[]) => any)(filename, ...args); }
        finally { if (String(filename).startsWith(sample.cacheRoot) && String(filename).endsWith(".tmp")) cleanupFinished.release(); }
    }) as typeof promises.rm;
    const outcome = proveCodexAdoptedPrefix({ ...sample.options, isCancelled: () => { if (cancelled) cancellationObserved.release(); return cancelled; } })
        .then(value => { settled = true; return { value, error: undefined }; }, error => { settled = true; return { error, value: undefined }; });
    try {
        await entered.promise;
        cancelled = true;
        await cancellationObserved.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(settled, false, "Cancellation returned while the gated producer was still active");
        releaseWrite.release();
        assert.equal((await outcome).error?.name, "AbortError");
        assert.deepEqual(fs.readdirSync(sample.cacheRoot), []);
    } finally {
        releaseWrite.release();
        await outcome;
        await cleanupFinished.promise;
        promises.writeFile = originalWrite;
        promises.rm = originalRemove;
        sample.close();
    }
});

test("cancellation arriving during the proof write is sampled before publication", async () => {
    const sample = await fixture();
    const originalWrite = promises.writeFile;
    let cancelled = false;
    promises.writeFile = (async (filename: any, ...args: any[]) => {
        const result = await (originalWrite as (...input: any[]) => any)(filename, ...args);
        if (String(filename).startsWith(sample.cacheRoot) && String(filename).endsWith(".tmp")) cancelled = true;
        return result;
    }) as typeof promises.writeFile;
    try {
        await assert.rejects(proveCodexAdoptedPrefix({ ...sample.options, isCancelled: () => cancelled }), { name: "AbortError" });
        assert.deepEqual(fs.readdirSync(sample.cacheRoot), [], "Cancelled proof was published");
    } finally { promises.writeFile = originalWrite; sample.close(); }
});

test("a delayed cache miss cannot start a second decode after a peer publishes", async () => {
    const sample = await fixture();
    const originalStat = promises.stat;
    const originalStream = fs.createReadStream;
    const releaseMiss = gate();
    let checks = 0;
    let decoderInputs = 0;
    promises.stat = (async (filename: any, ...args: any[]) => {
        const delayed = String(filename).startsWith(sample.cacheRoot) && String(filename).endsWith(".json") && ++checks === 2;
        try { return await (originalStat as (...input: any[]) => any)(filename, ...args); }
        catch (error) { if (delayed) await releaseMiss.promise; throw error; }
    }) as typeof promises.stat;
    fs.createReadStream = ((filename: any, ...args: any[]) => {
        if (path.resolve(String(filename)) === sample.source && args[0]?.start !== undefined && args[0]?.highWaterMark === sample.options.archive.streamChunkBytes) decoderInputs++;
        return (originalStream as (...input: any[]) => any)(filename, ...args);
    }) as typeof fs.createReadStream;
    const first = proveCodexAdoptedPrefix(sample.options);
    const second = proveCodexAdoptedPrefix(sample.options);
    try {
        await first;
        releaseMiss.release();
        await second;
        assert.equal(decoderInputs, 1);
    } finally {
        releaseMiss.release();
        await Promise.allSettled([first, second]);
        promises.stat = originalStat;
        fs.createReadStream = originalStream;
        sample.close();
    }
});

test("complete prefix proofs persist and a new process reuses them without decoding", async () => {
    const sample = await fixture();
    try {
        let progress = 0;
        const cold = await proveCodexAdoptedPrefix({ ...sample.options, onProgress: () => progress++ });
        assert.ok(progress > 0);
        assert.equal(cold.cacheHit, false);
        assert.equal(cold.logicalBytes, sample.content.length);
        const warm = await proveCodexAdoptedPrefix({ ...sample.options, onProgress: () => { throw new Error("Persistent proof must not decode again"); } });
        assert.equal(warm.cacheHit, true);
        assert.equal(warm.decodedBytes, 0);
        assert.equal(warm.physicalSha256, cold.physicalSha256);
        const script = `const { proveCodexAdoptedPrefix } = await import(${JSON.stringify(new URL("../src/codex-adopted-prefix-proof.ts", import.meta.url).href)}); console.log(JSON.stringify(await proveCodexAdoptedPrefix(${JSON.stringify(sample.options)})));`;
        const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", windowsHide: true });
        assert.equal(child.status, 0, child.stderr);
        assert.equal(JSON.parse(child.stdout).cacheHit, true);
        assert.equal(JSON.parse(child.stdout).decodedBytes, 0);
    } finally { sample.close(); }
});

for (const order of ["natural", "second-publishes-first"] as const) test(`concurrent consumers share one proof and cancelling one leaves the other alive (${order})`, async () => {
    const sample = await fixture();
    const createReadStream = fs.createReadStream;
    const originalStat = promises.stat;
    const firstStatStarted = gate();
    const releaseFirstStat = gate();
    const releaseLookup = gate();
    const outcomes: Promise<unknown>[] = [];
    let holdFirstStat = order === "second-publishes-first";
    let lookupHeld = false;
    let decoderInputs = 0;
    promises.stat = (async (filename: any, ...args: any[]) => {
        if (path.resolve(String(filename)) === sample.source && holdFirstStat) {
            holdFirstStat = false;
            firstStatStarted.release();
            await releaseFirstStat.promise;
        }
        if (order === "second-publishes-first" && String(filename).startsWith(sample.cacheRoot) && String(filename).endsWith(".json") && !lookupHeld) {
            lookupHeld = true;
            releaseFirstStat.release();
            await releaseLookup.promise;
        }
        return (originalStat as (...input: any[]) => any)(filename, ...args);
    }) as typeof promises.stat;
    fs.createReadStream = ((filename: any, ...args: any[]) => {
        if (path.resolve(String(filename)) === sample.source && args[0]?.start !== undefined && args[0]?.highWaterMark === sample.options.archive.streamChunkBytes) decoderInputs++;
        return (createReadStream as (...input: any[]) => any)(filename, ...args);
    }) as typeof fs.createReadStream;
    try {
        let cancelled = false;
        const first = proveCodexAdoptedPrefix({ ...sample.options, isCancelled: () => { if (lookupHeld) releaseLookup.release(); return cancelled; }, onProgress: bytes => { if (bytes >= 1024 * 1024) cancelled = true; } });
        outcomes.push(first);
        if (order === "second-publishes-first") await firstStatStarted.promise;
        const second = proveCodexAdoptedPrefix(sample.options);
        outcomes.push(second);
        const settled = await Promise.allSettled([first, second]);
        assert.equal(settled[0].status, "rejected");
        assert.equal((settled[0] as PromiseRejectedResult).reason.name, "AbortError");
        assert.equal(settled[1].status, "fulfilled");
        assert.equal((settled[1] as PromiseFulfilledResult<Awaited<typeof second>>).value.cacheHit, false);
        if (order === "second-publishes-first") assert.equal((settled[1] as PromiseFulfilledResult<Awaited<typeof second>>).value.sharedFlight, false);
        assert.equal(decoderInputs, 1);
        assert.equal((await proveCodexAdoptedPrefix(sample.options)).cacheHit, true);
        assert.equal(fs.readdirSync(sample.cacheRoot).filter(filename => filename.endsWith(".json")).length, 1);
    } finally {
        releaseFirstStat.release();
        releaseLookup.release();
        await Promise.allSettled(outcomes);
        promises.stat = originalStat;
        fs.createReadStream = createReadStream;
        sample.close();
    }
});

test("interrupted and mismatching proofs do not publish and the same input can retry", async () => {
    const sample = await fixture();
    try {
        let cancelled = false;
        await assert.rejects(proveCodexAdoptedPrefix({ ...sample.options, isCancelled: () => cancelled, onProgress: () => { cancelled = true; } }), { name: "AbortError" });
        await assert.rejects(proveCodexAdoptedPrefix({ ...sample.options, expectedSha256: "0".repeat(64) }), /adopted prefix differs/u);
        assert.equal(fs.existsSync(sample.cacheRoot), false);
        assert.equal((await proveCodexAdoptedPrefix(sample.options)).cacheHit, false);
    } finally { sample.close(); }
});

test("physical replacement, changed boundaries and new replicas cannot reuse a proof", async () => {
    const sample = await fixture();
    try {
        await proveCodexAdoptedPrefix(sample.options);
        await assert.rejects(proveCodexAdoptedPrefix({ ...sample.options, endByte: sample.content.length + 1 }), /adopted prefix differs/u);
        await assert.rejects(proveCodexAdoptedPrefix({ ...sample.options, segment: { ...sample.segment, replicas: ["new-replica.jsonl"] } }), /complete replica discovery/u);
        fs.writeFileSync(sample.source, zstdCompressSync(Buffer.from(sample.content.toString("utf8").replace("adopted-prefix-fixture", "rewritten-prefix-data"))));
        await assert.rejects(proveCodexAdoptedPrefix(sample.options), /changed before adopted prefix reuse/u);
    } finally { sample.close(); }
});

test("corrupt proof records and changed archive limits trigger actual validation", async () => {
    const sample = await fixture();
    try {
        await proveCodexAdoptedPrefix(sample.options);
        const filename = path.join(sample.cacheRoot, fs.readdirSync(sample.cacheRoot)[0]!);
        fs.writeFileSync(filename, "{broken");
        let progress = 0;
        assert.equal((await proveCodexAdoptedPrefix({ ...sample.options, onProgress: () => progress++ })).cacheHit, false);
        assert.ok(progress > 0);
        await assert.rejects(proveCodexAdoptedPrefix({ ...sample.options, archive: { ...sample.options.archive, maxDecompressedBytes: 1024 } }));
        fs.writeFileSync(sample.source, fs.readFileSync(sample.source).subarray(0, -1));
        await assert.rejects(resolveCodexStreamingHistorySource(sample.source, { roots: [sample.directory] }), /incomplete zstd block/u);
        const changed = { ...sample.segment, physical: codexHistoryPhysicalIdentity(fs.statSync(sample.source)) };
        await assert.rejects(proveCodexAdoptedPrefix({ ...sample.options, segment: changed }));
    } finally { sample.close(); }
});
