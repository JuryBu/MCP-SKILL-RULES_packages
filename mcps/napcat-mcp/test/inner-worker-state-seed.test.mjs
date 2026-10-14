import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { seedInnerWorkerState } from "../src/inner-runtime-profile.mjs";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inner-state-seed-"));
  const stateRoot = path.join(root, "state");
  fs.mkdirSync(stateRoot);
  const initialStateFiles = ["codex-model-stream-delivery-profiles.json", "codex-model-adaptive-delivery.json"].map(name => {
    const sourcePath = path.join(root, name);
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, retainedIdentity: name }));
    fs.writeFileSync(sourcePath, bytes);
    return { name, sourcePath, bytes: bytes.length, sha256: digest(bytes) };
  });
  return { root, stateRoot, profile: { stateRoot, initialStateFiles }, target: path.join(stateRoot, "worker-1") };
}

function discard(context) {
  const resolved = fs.realpathSync(context.root);
  if (path.dirname(resolved).toLowerCase() !== fs.realpathSync(os.tmpdir()).toLowerCase()
    || !path.basename(resolved).startsWith("inner-state-seed-")
    || resolved.toLowerCase() !== path.resolve(context.root).toLowerCase()) throw new Error("SEED_FIXTURE_CLEANUP_SCOPE");
  fs.rmSync(resolved, { recursive: true, force: true });
}

test("frozen tool and adaptive state seed keeps source bytes and refuses reused worker root", () => {
  const context = fixture();
  try {
    seedInnerWorkerState(context.profile, context.target);
    for (const entry of context.profile.initialStateFiles) {
      assert.equal(digest(fs.readFileSync(entry.sourcePath)), entry.sha256);
      assert.equal(digest(fs.readFileSync(path.join(context.target, entry.name))), entry.sha256);
    }
    assert.throws(() => seedInnerWorkerState(context.profile, context.target), /SEED_TARGET_REQUIRED/u);
  } finally { discard(context); }
});

for (const condition of ["hash", "name", "count", "escape", "oversize"]) {
  test(`state seed ${condition} refuses before creating target`, () => {
    const context = fixture();
    try {
      if (condition === "hash") fs.appendFileSync(context.profile.initialStateFiles[0].sourcePath, "drift");
      if (condition === "name") context.profile.initialStateFiles[0].name = "../auth.json";
      if (condition === "count") context.profile.initialStateFiles.push(context.profile.initialStateFiles[0]);
      if (condition === "escape") context.target = path.join(context.root, "foreign-worker");
      if (condition === "oversize") fs.writeFileSync(context.profile.initialStateFiles[0].sourcePath, Buffer.alloc(131073));
      assert.throws(() => seedInnerWorkerState(context.profile, context.target), /INNER_PROFILE_SEED_/u);
      assert.equal(fs.existsSync(context.target), false);
    } finally { discard(context); }
  });
}
