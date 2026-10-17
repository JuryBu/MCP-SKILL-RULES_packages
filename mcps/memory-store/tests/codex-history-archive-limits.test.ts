import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeCodexArchiveFixture } from "./helpers/codex-zstd-fixture.ts";
import { materializeCodexHistoryArchive, materializeCodexHistoryArchiveSync } from "../src/codex-history-archive.ts";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-archive-limits-"));
const filePath = path.join(temporaryRoot, "synthetic.jsonl.zst");
const data = Buffer.alloc(65536, 65);
const options = { cacheRoot: path.join(temporaryRoot, "views"), ownerId: "synthetic-limits" };
const names = ["MEMORY_STORE_CODEX_HISTORY_MAX_COMPRESSED_BYTES", "MEMORY_STORE_CODEX_HISTORY_MAX_DECOMPRESSED_BYTES", "MEMORY_STORE_CODEX_HISTORY_MAX_WINDOW_BYTES", "MEMORY_STORE_CODEX_HISTORY_MIN_FREE_BYTES"];
const previous = names.map(name => process.env[name]);
try {
    fs.writeFileSync(filePath, encodeCodexArchiveFixture(data));
    for (const name of names) delete process.env[name];
    assert.equal((await materializeCodexHistoryArchive(filePath, options)).logicalSize, data.length);
    process.env[names[0]!] = "5";
    assert.throws(() => materializeCodexHistoryArchiveSync(filePath, options), /compressed size limit/);
    await assert.rejects(materializeCodexHistoryArchive(filePath, options), /compressed size limit/);
    assert.equal(materializeCodexHistoryArchiveSync(filePath, { ...options, maxCompressedBytes: 1024 * 1024 }).logicalSize, data.length);
    delete process.env[names[0]!];
    process.env[names[1]!] = "1024";
    await assert.rejects(materializeCodexHistoryArchive(filePath, options), /decompressed size limit/);
    delete process.env[names[1]!];
    process.env[names[2]!] = "1024";
    assert.throws(() => materializeCodexHistoryArchiveSync(filePath, { ...options, ownerId: "synthetic-limits-window" }), /window limit/);
    delete process.env[names[2]!];
    process.env[names[3]!] = "0";
    assert.equal((await materializeCodexHistoryArchive(filePath, options)).logicalSize, data.length);
    for (const invalid of ["", "-1", "1.5", "Infinity", "9007199254740992", "0"]) {
        process.env[names[0]!] = invalid;
        assert.throws(() => materializeCodexHistoryArchiveSync(filePath, options), /invalid/);
        await assert.rejects(materializeCodexHistoryArchive(filePath, options), /invalid/);
    }
    console.log("codex-history-archive-limits: PASS defaults/environment/explicit override/validation/native stream");
} finally {
    names.forEach((name, index) => {
        const value = previous[index];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    });
    assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
