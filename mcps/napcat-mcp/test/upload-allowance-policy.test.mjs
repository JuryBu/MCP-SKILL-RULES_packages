import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readUploadAllowancePolicy } from "../src/upload-allowance-policy.mjs";
import { requestUploadAllowanceMs, DEFAULT_UPLOAD_ALLOWANCE_MS_PER_MIB, MAX_UPLOAD_ALLOWANCE_MS } from "../src/request-wait-budget.mjs";

test("upload policy preserves defaults and scales the full encoded request allowance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-policy-"));
  try {
    assert.deepEqual(readUploadAllowancePolicy(root, {}), { uploadAllowanceMsPerMiB: DEFAULT_UPLOAD_ALLOWANCE_MS_PER_MIB,
      maxUploadAllowanceMs: 128 * DEFAULT_UPLOAD_ALLOWANCE_MS_PER_MIB });
    for (const rate of [0, 1000, 2000, 3000, 33555, 60000]) {
      fs.writeFileSync(path.join(root, "codex-model-upload-policy.json"), JSON.stringify({ schemaVersion: 1, uploadAllowanceMsPerMiB: rate }));
      const policy = readUploadAllowancePolicy(root, {});
      assert.equal(policy.maxUploadAllowanceMs, 128 * rate);
      assert.equal(requestUploadAllowanceMs(128 * 1024 * 1024, policy.uploadAllowanceMsPerMiB, policy.maxUploadAllowanceMs), 128 * rate);
      assert.equal(requestUploadAllowanceMs(6_962_097, policy.uploadAllowanceMsPerMiB, policy.maxUploadAllowanceMs), Math.ceil(6_962_097 / 1048576 * rate));
    }
    assert.deepEqual(readUploadAllowancePolicy(root, { CODEX_MODEL_STREAM_PROXY_UPLOAD_ALLOWANCE_MS_PER_MIB: "2000",
      CODEX_MODEL_STREAM_PROXY_MAX_UPLOAD_ALLOWANCE_MS: "123456" }), { uploadAllowanceMsPerMiB: 2000, maxUploadAllowanceMs: 123456 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("upload policy rejects malformed files and invalid environment overrides", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upload-policy-invalid-"));
  try {
    const policyPath = path.join(root, "codex-model-upload-policy.json");
    for (const policy of [null, [], { schemaVersion: 2 }, { schemaVersion: 1, idleTimeoutMs: 2 },
      { schemaVersion: 1, uploadAllowanceMsPerMiB: "2000" }, { schemaVersion: 1, uploadAllowanceMsPerMiB: -1 },
      { schemaVersion: 1, uploadAllowanceMsPerMiB: 60001 }, { schemaVersion: 1, maxUploadAllowanceMs: MAX_UPLOAD_ALLOWANCE_MS + 1 }]) {
      fs.writeFileSync(policyPath, JSON.stringify(policy));
      assert.throws(() => readUploadAllowancePolicy(root, {}));
    }
    fs.writeFileSync(policyPath, " ".repeat(4097));
    assert.throws(() => readUploadAllowancePolicy(root, {}), /UPLOAD_POLICY_FILE_INVALID/u);
    fs.writeFileSync(policyPath, JSON.stringify({ schemaVersion: 1 }));
    for (const value of ["", "-1", "1.1", "NaN", "60001", "2000junk"]) {
      assert.throws(() => readUploadAllowancePolicy(root, { CODEX_MODEL_STREAM_PROXY_UPLOAD_ALLOWANCE_MS_PER_MIB: value }));
    }
    const capped = readUploadAllowancePolicy(root, { CODEX_MODEL_STREAM_PROXY_UPLOAD_ALLOWANCE_MS_PER_MIB: "60000" });
    assert.equal(capped.maxUploadAllowanceMs, 128 * 60000);
    assert.equal(readUploadAllowancePolicy(root, { CODEX_MODEL_STREAM_PROXY_MAX_UPLOAD_ALLOWANCE_MS: "4295040" }).maxUploadAllowanceMs, 4295040);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
