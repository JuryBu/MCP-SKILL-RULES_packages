import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import { test } from "node:test";
import { streamCodexHistoryArchive, type CodexHistoryArchiveStreamIdentity } from "../src/codex-history-archive.ts";

test("bounded archive chunks keep content and physical proofs with caller-owned logical hashing", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-stream-chunks-"));
    try {
        const content = Buffer.from("archive-fixture-".repeat(160000));
        const compressed = zstdCompressSync(content);
        const file = path.join(directory, "fixture.jsonl.zst");
        await fs.writeFile(file, compressed);
        for (const decoder of ["auto", "fzstd"] as const) for (const streamChunkBytes of [64 * 1024, 1024 * 1024]) for (const calculateLogicalSha256 of [true, false]) {
            let identity: CodexHistoryArchiveStreamIdentity | undefined;
            const chunks: Buffer[] = [];
            for await (const chunk of streamCodexHistoryArchive(file, { decoder, streamChunkBytes, calculateLogicalSha256, onComplete: value => { identity = value; } })) chunks.push(chunk);
            assert.deepEqual(Buffer.concat(chunks), content);
            assert.equal(identity?.sourceSha256, createHash("sha256").update(compressed).digest("hex"));
            assert.equal(identity?.logicalSize, content.length);
            assert.equal(identity?.logicalSha256, calculateLogicalSha256 ? createHash("sha256").update(content).digest("hex") : undefined);
        }
        for (const streamChunkBytes of [0, 16383, 4 * 1024 * 1024 + 1, Number.NaN]) {
            await assert.rejects(async () => { for await (const _chunk of streamCodexHistoryArchive(file, { streamChunkBytes })) {} }, /bounded range/u);
        }
        await fs.writeFile(file, compressed.subarray(0, -1));
        for (const calculateLogicalSha256 of [true, false]) await assert.rejects(async () => { for await (const _chunk of streamCodexHistoryArchive(file, { calculateLogicalSha256 })) {} });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
