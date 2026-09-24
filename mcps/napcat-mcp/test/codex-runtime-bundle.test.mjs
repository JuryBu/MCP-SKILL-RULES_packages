import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inspectCodexSource,
  prepareCodexRuntimeBundle,
  verifyCodexRuntimeBundle,
} from "../src/codex-runtime-bundle.mjs";

const requiredFiles = ["codex.exe", "codex-code-mode-host.exe", "codex-command-runner.exe", "codex-windows-sandbox-setup.exe"];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runtime-bundle-test-"));
  const sourceRoot = path.join(root, "Desktop", "bin", "revision");
  const bundleRoot = path.join(root, "managed");
  fs.mkdirSync(path.join(sourceRoot, "support"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "codex.exe"), "app server");
  fs.writeFileSync(path.join(sourceRoot, "codex-code-mode-host.exe"), "tool host");
  fs.writeFileSync(path.join(sourceRoot, "codex-command-runner.exe"), "command runner");
  fs.writeFileSync(path.join(sourceRoot, "codex-windows-sandbox-setup.exe"), "sandbox setup");
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
    assert.equal(fs.readFileSync(path.join(path.dirname(prepared.executablePath), "codex-command-runner.exe"), "utf8"), "command runner");
    assert.equal(fs.readFileSync(path.join(path.dirname(prepared.executablePath), "codex-windows-sandbox-setup.exe"), "utf8"), "sandbox setup");
    assert.equal(fs.readFileSync(path.join(path.dirname(prepared.executablePath), "support", "data.bin"), "utf8"), "support file");
    assert.equal((await verifyCodexRuntimeBundle(prepared.executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: trustedFixture,
    })).digest, prepared.digest);
  } finally {
    fs.rmSync(fixturePaths.root, { recursive: true, force: true });
  }
});

for (const missingFile of requiredFiles) test(`missing ${missingFile} fails before publishing a bundle`, async () => {
  const fixturePaths = fixture();
  try {
    fs.rmSync(path.join(fixturePaths.sourceRoot, missingFile));
    await assert.rejects(prepareCodexRuntimeBundle(fixturePaths.executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: trustedFixture,
    }), new RegExp(`missing ${missingFile.replaceAll(".", "\\.")}`));
    assert.equal(fs.existsSync(fixturePaths.bundleRoot), false);
  } finally {
    fs.rmSync(fixturePaths.root, { recursive: true, force: true });
  }
});

test("missing Windows helpers cannot refresh a source or reuse a damaged bundle; the good bundle remains", async () => {
  const fixturePaths = fixture();
  try {
    const prepared = await prepareCodexRuntimeBundle(fixturePaths.executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: trustedFixture,
    });
    for (const helper of requiredFiles.slice(2)) {
      const helperPath = path.join(fixturePaths.sourceRoot, helper);
      const content = fs.readFileSync(helperPath);
      fs.rmSync(helperPath);
      await assert.rejects(prepareCodexRuntimeBundle(fixturePaths.executablePath, {
        bundleRoot: fixturePaths.bundleRoot,
        validateBundleSignature: trustedFixture,
      }), new RegExp(`missing ${helper.replaceAll(".", "\\.")}`));
      assert.equal((await verifyCodexRuntimeBundle(prepared.executablePath, {
        bundleRoot: fixturePaths.bundleRoot,
        validateBundleSignature: trustedFixture,
      })).digest, prepared.digest);
      fs.writeFileSync(helperPath, content);
      const bundledHelper = path.join(path.dirname(prepared.executablePath), helper);
      fs.rmSync(bundledHelper);
      await assert.rejects(verifyCodexRuntimeBundle(prepared.executablePath, {
        bundleRoot: fixturePaths.bundleRoot,
        validateBundleSignature: trustedFixture,
      }), new RegExp(`missing ${helper.replaceAll(".", "\\.")}`));
      await assert.rejects(prepareCodexRuntimeBundle(fixturePaths.executablePath, {
        bundleRoot: fixturePaths.bundleRoot,
        validateBundleSignature: trustedFixture,
      }), new RegExp(`missing ${helper.replaceAll(".", "\\.")}`));
      fs.writeFileSync(bundledHelper, content);
      assert.equal(fs.readdirSync(fixturePaths.bundleRoot).length, 1);
    }
    assert.equal((await verifyCodexRuntimeBundle(prepared.executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: trustedFixture,
    })).digest, prepared.digest);
  } finally {
    fs.rmSync(fixturePaths.root, { recursive: true, force: true });
  }
});

test("both Windows helpers participate in signature input and content hashes", async () => {
  const fixturePaths = fixture();
  const checked = [];
  try {
    const source = await inspectCodexSource(fixturePaths.executablePath);
    assert.deepEqual(source.entries.filter((entry) => entry.name.endsWith(".exe")).map((entry) => entry.name).sort(), [...requiredFiles].sort());
    const prepared = await prepareCodexRuntimeBundle(fixturePaths.executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: async (root, entries) => checked.push({ root, entries }),
    });
    await verifyCodexRuntimeBundle(prepared.executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: async (root, entries) => checked.push({ root, entries }),
    });
    assert.equal(checked.length, 2);
    for (const { entries } of checked) {
      assert.deepEqual(entries.filter((entry) => entry.name.endsWith(".exe")).map((entry) => entry.name).sort(), [...requiredFiles].sort());
      for (const helper of requiredFiles.slice(2)) {
        const entry = entries.find((item) => item.name === helper);
        assert.equal(entry.sha256, crypto.createHash("sha256").update(fs.readFileSync(path.join(fixturePaths.sourceRoot, helper))).digest("hex"));
      }
    }
    fs.writeFileSync(path.join(fixturePaths.sourceRoot, "codex-command-runner.exe"), "updated command runner");
    const updated = await prepareCodexRuntimeBundle(fixturePaths.executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: trustedFixture,
    });
    assert.notEqual(updated.digest, prepared.digest);
    assert.equal(fs.readdirSync(fixturePaths.bundleRoot).length, 2);
    assert.equal((await verifyCodexRuntimeBundle(prepared.executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: trustedFixture,
    })).digest, prepared.digest);
    fs.writeFileSync(path.join(path.dirname(prepared.executablePath), "codex-windows-sandbox-setup.exe"), "tampered");
    await assert.rejects(verifyCodexRuntimeBundle(prepared.executablePath, {
      bundleRoot: fixturePaths.bundleRoot,
      validateBundleSignature: trustedFixture,
    }), /manifest does not match/);
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
