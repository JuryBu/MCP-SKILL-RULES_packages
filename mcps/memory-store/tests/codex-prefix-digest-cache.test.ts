import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashCodexPrefix, hashCodexPrefixSync } from "../src/codex-history-integrity.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codex-prefix-digest-"));
const file = path.join(temporary, "source.jsonl");
const bytes = Buffer.from(`{"type":"session_meta"}\n${"visible body\n".repeat(300000)}`);
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const identity = {
    headerSha256: sha256(bytes.subarray(0, bytes.indexOf(0x0a))),
    anchorStartByte: bytes.length - 8192,
    anchorSha256: sha256(bytes.subarray(-8192)),
};
const originalOpen = fs.promises.open;
const originalOpenSync = fs.openSync;
let asynchronousOpens = 0;
let synchronousOpens = 0;
fs.promises.open = (async (...parameters: Parameters<typeof fs.promises.open>) => {
    asynchronousOpens += 1;
    return originalOpen.apply(fs.promises, parameters);
}) as typeof fs.promises.open;
fs.openSync = ((...parameters: Parameters<typeof fs.openSync>) => {
    synchronousOpens += 1;
    return originalOpenSync.apply(fs, parameters);
}) as typeof fs.openSync;

try {
    fs.writeFileSync(file, bytes);
    assert.equal(await hashCodexPrefix(file, bytes.length), sha256(bytes));
    const firstOpens = asynchronousOpens;
    assert.equal(await hashCodexPrefix(file, bytes.length, undefined, identity), sha256(bytes));
    assert.equal(asynchronousOpens, firstOpens, "a verified full digest also proves the same header and anchor");
    const firstSyncOpens = synchronousOpens;
    assert.equal(hashCodexPrefixSync(file, bytes.length, identity), sha256(bytes));
    assert.equal(synchronousOpens, firstSyncOpens, "sync and async readers share only physically verified digests");
    await assert.rejects(() => hashCodexPrefix(file, bytes.length, undefined, { ...identity, headerSha256: "0".repeat(64) }), /header changed/u);
    await assert.rejects(() => hashCodexPrefix(file, bytes.length, undefined, { ...identity, anchorSha256: "0".repeat(64) }), /boundary changed/u);
    await assert.rejects(() => hashCodexPrefix(file, bytes.length, () => true), { name: "AbortError" });
    assert.throws(() => hashCodexPrefixSync(file, bytes.length, undefined, () => true), { name: "AbortError" });

    const originalStat = fs.statSync(file);
    const originalPhysical = fs.statSync(file, { bigint: true });
    const changed = Buffer.from(bytes);
    changed[1000] ^= 1;
    fs.writeFileSync(file, changed);
    fs.utimesSync(file, originalStat.atime, originalStat.mtime);
    assert.notEqual(fs.statSync(file, { bigint: true }).ctimeNs, originalPhysical.ctimeNs);
    assert.equal(await hashCodexPrefix(file, changed.length), sha256(changed));
    assert.ok(asynchronousOpens > firstOpens, "same size and restored mtime do not reuse a digest after a write");

    const replacement = path.join(temporary, "replacement.jsonl");
    fs.writeFileSync(replacement, changed);
    fs.utimesSync(replacement, originalStat.atime, originalStat.mtime);
    const replacementOpens = asynchronousOpens;
    fs.renameSync(replacement, file);
    assert.equal(await hashCodexPrefix(file, changed.length), sha256(changed));
    assert.ok(asynchronousOpens > replacementOpens, "replacement inode is independently verified");

    fs.appendFileSync(file, "append\n");
    assert.equal(await hashCodexPrefix(file, changed.length), sha256(changed));
    const unusualIdentity = { ...identity, anchorStartByte: 1000, anchorSha256: sha256(changed.subarray(1000)) };
    assert.equal(await hashCodexPrefix(file, changed.length, undefined, unusualIdentity), sha256(changed));
    const unusualOpens = asynchronousOpens;
    assert.equal(await hashCodexPrefix(file, changed.length, undefined, unusualIdentity), sha256(changed));
    assert.equal(asynchronousOpens, unusualOpens, "an explicitly verified nonstandard anchor is preserved");
    fs.truncateSync(file, 1000);
    await assert.rejects(() => hashCodexPrefix(file, changed.length), /shortened/u);
    console.log("codex prefix digest cache: PASS full/read reuse, identity proofs, rewrites, replacements, append, truncate, cancellation");
} finally {
    fs.promises.open = originalOpen;
    fs.openSync = originalOpenSync;
    fs.rmSync(temporary, { recursive: true });
}
