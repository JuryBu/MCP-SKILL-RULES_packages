import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupOwnedRuntimeCopies } from "./owned-runtime-copy-cleanup.mjs";

for (const scenario of ["success", "failed-test", "content-drift", "live-process", "scope-escape"]) {
  test(`owned runtime copy cleanup preserves evidence and source: ${scenario}`, context => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-copy-cleanup-test-"));
    context.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const ownedRoot = path.join(root, "owned");
    fs.mkdirSync(ownedRoot);
    const sourcePath = path.join(root, "codex.exe");
    const targetPath = path.join(ownedRoot, "codex.exe");
    fs.writeFileSync(sourcePath, "rebuildable fixture");
    fs.copyFileSync(sourcePath, targetPath);
    const evidencePath = path.join(ownedRoot, "result.json");
    fs.writeFileSync(evidencePath, JSON.stringify({ state: scenario === "failed-test" ? "failed" : "passed" }));
    const originalEvidence = fs.readFileSync(evidencePath);
    if (scenario === "content-drift") fs.writeFileSync(targetPath, "unique failure bytes");
    const input = { ownedRoot, copies: [{ targetPath, sourcePath }], processIds: [123], isProcessAlive: () => scenario === "live-process" };
    if (scenario === "scope-escape") {
      input.copies[0].targetPath = path.join(root, "elsewhere", "codex.exe");
      assert.throws(() => cleanupOwnedRuntimeCopies(input), /RUNTIME_COPY_SCOPE_INVALID/);
    } else {
      const result = cleanupOwnedRuntimeCopies(input);
      const removable = ["success", "failed-test"].includes(scenario);
      assert.equal(fs.existsSync(targetPath), !removable);
      assert.equal(result.removedBytes, removable ? Buffer.byteLength("rebuildable fixture") : 0);
      if (result.manifestPath) assert.deepEqual(JSON.parse(fs.readFileSync(result.manifestPath, "utf8")).files, result.files);
    }
    assert.equal(fs.readFileSync(sourcePath, "utf8"), "rebuildable fixture");
    assert.deepEqual(fs.readFileSync(evidencePath), originalEvidence);
  });
}

test("owned runtime cleanup rejects junction escapes before removing files", { skip: process.platform !== "win32" }, context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-copy-cleanup-junction-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ownedRoot = path.join(root, "owned");
  const outside = path.join(root, "outside");
  fs.mkdirSync(ownedRoot);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "codex.exe"), "original");
  fs.symlinkSync(outside, path.join(ownedRoot, "link"), "junction");
  assert.throws(() => cleanupOwnedRuntimeCopies({ ownedRoot, copies: [{ targetPath: path.join(ownedRoot, "link", "codex.exe"),
    sourcePath: path.join(outside, "codex.exe") }] }), /RUNTIME_COPY_REPARSE_OR_TYPE_INVALID/);
  assert.equal(fs.readFileSync(path.join(outside, "codex.exe"), "utf8"), "original");
});
