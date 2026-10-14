import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { test } from "node:test";
import { readPinnedRuntimeDependency } from "../ops/build-full-upgrade-payload.mjs";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

test("pinned external executable accepts hard links without changing their bytes or identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-pinned-executable-"));
  try {
    const filename = path.join(root, "runtime.exe");
    const alias = path.join(root, "runtime-alias.exe");
    const bytes = Buffer.from("owned synthetic executable dependency");
    fs.writeFileSync(filename, bytes);
    fs.linkSync(filename, alias);
    const before = fs.statSync(filename);
    assert.equal(before.nlink, 2);
    assert.deepEqual(readPinnedRuntimeDependency({ path: filename, sha256: digest(bytes) }), bytes);
    const after = fs.statSync(filename);
    assert.equal(after.ino, before.ino);
    assert.equal(after.nlink, before.nlink);
    assert.deepEqual(fs.readFileSync(alias), bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pinned external dependencies retain hash, file type, and script-link checks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-pinned-guards-"));
  try {
    const bytes = Buffer.from("owned synthetic dependency");
    const filename = path.join(root, "runtime.exe");
    fs.writeFileSync(filename, bytes);
    assert.throws(() => readPinnedRuntimeDependency({ path: filename, sha256: "0".repeat(64) }), /FULL_QQ_POST_INSTALL_PIN_CHANGED/u);
    assert.throws(() => readPinnedRuntimeDependency({ path: filename, sha256: "invalid" }), /FULL_QQ_DEPENDENCY_PIN_INVALID/u);
    assert.throws(() => readPinnedRuntimeDependency({ path: root, sha256: digest(bytes) }), /FULL_QQ_DEPENDENCY_NOT_PLAIN/u);
    const script = path.join(root, "script.ps1");
    fs.writeFileSync(script, bytes);
    fs.linkSync(script, path.join(root, "script-alias.ps1"));
    assert.throws(() => readPinnedRuntimeDependency({ path: script, sha256: digest(bytes) }), /FULL_QQ_DEPENDENCY_NOT_PLAIN/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
