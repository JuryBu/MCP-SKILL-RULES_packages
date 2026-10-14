import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createCodexDisplayPolicyControl, createCodexDisplayPolicyManager } from "../src/codex-display-policy.mjs";
import { parseArguments } from "../src/codex-app-server-proxy-runner.mjs";
import { parseDisplayPolicyArguments } from "../ops/codex-display-policy.mjs";

const digest = source => crypto.createHash("sha256").update(source).digest("hex");
const root = fs.mkdtempSync(path.join(process.env.NAPCAT_DISPLAY_TEST_ROOT ?? os.tmpdir(), "outer-full-control-test-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const source = 'export default {apiVersion:1, version:"control-v1", decideReminder:({text})=>({visibility:"visible",text})};';
fs.writeFileSync(path.join(root, "valid.mjs"), source);
const manager = createCodexDisplayPolicyManager();
const control = createCodexDisplayPolicyControl(manager, { candidateRoot: root, instanceId: "owned-instance" });
const input = () => ({ instanceId: "owned-instance", rootId: control.status().rootId,
  expectedRevision: control.status().revision, candidate: "valid.mjs", sha256: digest(source) });

test("normal runner parsing defaults off and carries the explicit root", () => {
  const required = ["runtime-state", "log", "stop-file", "lock", "journal", "token-file", "maintenance-file", "alert-file", "fallback-file"]
    .flatMap(name => [`--${name}`, path.join(root, name)]);
  assert.equal(parseArguments(required).displayPolicyRoot, null);
  assert.equal(parseArguments([...required, "--display-policy-root", root]).displayPolicyRoot, root);
  assert.throws(() => parseDisplayPolicyArguments(["--action", "prepare", "--runtime-state", "a", "--token-file", "b"]), /CANDIDATE_REQUIRED/);
});

test("root and content stay bound, with exclusive preparation and serialized idempotency", async () => {
  assert.equal((await control.prepare({ ...input(), instanceId: "wrong" })).error.code, "DISPLAY_POLICY_INSTANCE_MISMATCH");
  assert.equal((await control.prepare({ ...input(), rootId: "wrong" })).error.code, "DISPLAY_POLICY_ROOT_MISMATCH");
  assert.equal((await control.prepare({ ...input(), candidate: "../valid.mjs" })).error.code, "INVALID_DISPLAY_POLICY_CANDIDATE");
  assert.equal((await control.prepare({ ...input(), sha256: "0".repeat(64) })).error.code, "DISPLAY_POLICY_SHA_MISMATCH");
  const first = control.prepare(input());
  assert.equal((await control.prepare(input())).error.code, "DISPLAY_POLICY_PREPARE_BUSY");
  const prepared = await first;
  assert.equal(prepared.prepared, true);
  assert.equal(manager.status().version, "original");
  assert.equal((await control.prepare(input())).error.code, "DISPLAY_POLICY_PREPARATION_PENDING");
  const serialized = JSON.parse(JSON.stringify(prepared.receipt));
  fs.writeFileSync(path.join(root, "valid.mjs"), `${source}\n`);
  assert.equal(control.activate(serialized).error.code, "DISPLAY_POLICY_SHA_MISMATCH");
  assert.equal(manager.status().version, "original");
  fs.writeFileSync(path.join(root, "valid.mjs"), source);
  assert.equal(control.activate(serialized).activated, true);
  assert.equal(control.activate(serialized).alreadyActivated, true);
  assert.equal(manager.status().revision, 1);
  assert.equal(control.activate({ ...serialized, candidate: "other.mjs" }).error.code, "INVALID_OR_STALE_PREPARATION");
  assert.equal(control.restore({ ...input(), expectedRevision: 0 }).error.code, "DISPLAY_POLICY_REVISION_MISMATCH");
  assert.equal(control.restore(input()).version, "original");
  assert.equal(control.restore({ ...input(), expectedRevision: 1 }).error.code, "DISPLAY_POLICY_REVISION_MISMATCH");
  assert.equal(control.activate(serialized).alreadyActivated, true);
  assert.equal(manager.status().version, "original");
});

test("disabled control and invalid modules preserve the current choice", async () => {
  const disabled = createCodexDisplayPolicyControl(manager, { instanceId: "owned-instance" });
  assert.equal((await disabled.prepare(input())).error.code, "DISPLAY_POLICY_CONTROL_DISABLED");
  const bad = 'throw new Error("bad-reviewed-module");';
  fs.writeFileSync(path.join(root, "bad.mjs"), bad);
  assert.equal((await control.prepare({ ...input(), candidate: "bad.mjs", sha256: digest(bad) })).error.code, "bad-reviewed-module");
  assert.equal(manager.status().version, "original");
  const prepared = await control.prepare(input());
  assert.equal(control.discard(prepared.receipt).discarded, true);
  assert.equal(control.activate(prepared.receipt).error.code, "INVALID_OR_STALE_PREPARATION");
});

test("restoration preserves the full sequence of previous selections", async () => {
  const ownedManager = createCodexDisplayPolicyManager();
  const original = path.join(root, "previous.mjs");
  fs.writeFileSync(original, 'export default {apiVersion:1,version:"previous-v1",decideReminder:()=>({visibility:"inherit"})};');
  assert.equal(ownedManager.activate(await ownedManager.prepare(original)).activated, true);
  fs.writeFileSync(original, 'export default {apiVersion:1,version:"previous-v2",decideReminder:()=>({visibility:"visible"})};');
  assert.equal(ownedManager.activate(await ownedManager.prepare(original)).activated, true);
  fs.writeFileSync(original, 'export default {apiVersion:1,version:"previous-v3",decideReminder:()=>({visibility:"inherit"})};');
  assert.equal(ownedManager.activate(await ownedManager.prepare(original)).activated, true);
  assert.equal(ownedManager.restore().version, "previous-v2");
  assert.equal(ownedManager.restore().version, "previous-v1");
  assert.equal(ownedManager.restore().version, "original");
});
