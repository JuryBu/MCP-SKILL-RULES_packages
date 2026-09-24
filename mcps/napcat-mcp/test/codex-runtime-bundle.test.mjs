import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prepareCodexRuntimeBundle,
  verifyCodexRuntimeBundle,
} from "../src/codex-runtime-bundle.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runtime-bundle-test-"));
  const sourceRoot = path.join(root, "Desktop", "bin", "revision");
  const bundleRoot = path.join(root, "managed");
  fs.mkdirSync(path.join(sourceRoot, "support"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "codex.exe"), "app server");
  fs.writeFileSync(path.join(sourceRoot, "codex-code-mode-host.exe"), "tool host");
  fs.writeFileSync(path.join(sourceRoot, "support", "data.bin"), "support file");
  return { root, sourceRoot, bundleRoot, executablePath: path.join(sourceRoot, "codex.exe") };
}

const trustedFixture = async () => {};

test("a managed bundle keeps all companion files after Desktop removes its source", async () => {
  const fixturePaths = fixture();
  try {
    const prepared = await prepareCodexRuntimeBundle(fixturePaths.executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: trustedFixture,
    });
    const repeated = await prepareCodexRuntimeBundle(fixturePaths.executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: trustedFixture,
    });
    assert.equal(repeated.executablePath, prepared.executablePath);
    assert.equal(fs.readdirSync(fixturePaths.bundleRoot).length, 1);
    fs.rmSync(fixturePaths.sourceRoot, { recursive: true });
    assert.equal(fs.readFileSync(path.join(path.dirname(prepared.executablePath), "codex-code-mode-host.exe"), "utf8"), "tool host");
    assert.equal(fs.readFileSync(path.join(path.dirname(prepared.executablePath), "support", "data.bin"), "utf8"), "support file");
    assert.equal((await verifyCodexRuntimeBundle(prepared.executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: trustedFixture,
    })).digest, prepared.digest);
  } finally {
    fs.rmSync(fixturePaths.root, { recursive: true, force: true });
  }
});

test("missing tool host fails before publishing a bundle", async () => {
  const fixturePaths = fixture();
  try {
    fs.rmSync(path.join(fixturePaths.sourceRoot, "codex-code-mode-host.exe"));
    await assert.rejects(prepareCodexRuntimeBundle(fixturePaths.executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: trustedFixture,
    }), /missing codex-code-mode-host/);
    assert.equal(fs.existsSync(fixturePaths.bundleRoot), false);
  } finally {
    fs.rmSync(fixturePaths.root, { recursive: true, force: true });
  }
});

test("a changing source or rejected signature leaves no published or staging package", async () => {
  const fixturePaths = fixture();
  try {
    await assert.rejects(prepareCodexRuntimeBundle(fixturePaths.executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: trustedFixture,
      afterCopy: () => fs.writeFileSync(path.join(fixturePaths.sourceRoot, "support", "data.bin"), "changed during copy"),
    }), /source changed/);
    assert.deepEqual(fs.readdirSync(fixturePaths.bundleRoot), []);
    await assert.rejects(prepareCodexRuntimeBundle(fixturePaths.executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: async () => { throw new Error("not an official signature"); },
    }), /not an official signature/);
    assert.deepEqual(fs.readdirSync(fixturePaths.bundleRoot), []);
  } finally {
    fs.rmSync(fixturePaths.root, { recursive: true, force: true });
  }
});

test("concurrent preparation converges on one verified package", async () => {
  const fixturePaths = fixture();
  try {
    const attempts = await Promise.all(Array.from({ length: 2 }, () => prepareCodexRuntimeBundle(fixturePaths.executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: trustedFixture,
    })));
    assert.equal(attempts[0].executablePath, attempts[1].executablePath);
    assert.equal(fs.readdirSync(fixturePaths.bundleRoot).length, 1);
    fs.writeFileSync(path.join(path.dirname(attempts[0].executablePath), "support", "data.bin"), "tampered");
    await assert.rejects(verifyCodexRuntimeBundle(attempts[0].executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: trustedFixture,
    }), /manifest does not match/);
  } finally {
    fs.rmSync(fixturePaths.root, { recursive: true, force: true });
  }
});
