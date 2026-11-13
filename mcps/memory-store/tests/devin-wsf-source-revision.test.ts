import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "devin-wsf-source-revision-"));
process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH = path.join(root, "sessions.db");
process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT = path.join(root, "desktop");
fs.mkdirSync(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT);
fs.writeFileSync(process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH, Buffer.alloc(100, 1));
const { devinSourceValidationRevision } = await import("../src/devin-source-validation.js");
try {
    const initial = devinSourceValidationRevision();
    assert.equal(devinSourceValidationRevision(), initial);
    fs.writeFileSync(`${process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH}-wal`, "");
    assert.equal(devinSourceValidationRevision(), initial);
    fs.writeFileSync(`${process.env.MEMORY_STORE_DEVIN_CLI_DB_PATH}-journal`, "");
    assert.equal(devinSourceValidationRevision(), initial);
    const desktop = path.join(process.env.MEMORY_STORE_DEVIN_DESKTOP_ROOT, "11111111-2222-4333-8444-555555555555.db");
    fs.writeFileSync(desktop, Buffer.alloc(100, 2));
    const added = devinSourceValidationRevision();
    assert.notEqual(added, initial);
    fs.renameSync(desktop, `${desktop}.saved`);
    fs.writeFileSync(desktop, Buffer.alloc(100, 2));
    const replacement = devinSourceValidationRevision();
    assert.notEqual(replacement, added);
    const originalTimes = fs.statSync(desktop);
    fs.writeFileSync(desktop, Buffer.alloc(100, 3));
    fs.utimesSync(desktop, originalTimes.atime, originalTimes.mtime);
    assert.notEqual(devinSourceValidationRevision(), replacement);
    fs.renameSync(desktop, `${desktop}.removed`);
    assert.equal(devinSourceValidationRevision(), initial);
    console.log("PASS stable revision, empty WAL/journal, new Desktop, source replacement, same-size/header edit with restored mtime and removal");
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
