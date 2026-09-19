import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { patchWakeVisibility, prepareWakeVisibility } from "../ops/prepare-wake-visibility.mjs";

const source = [
  'import { WebSocket, WebSocketServer } from "ws";',
  '    this.journal = options.journal ?? null;',
  '      journal: this.journal?.status?.() ?? null,',
  '    let mutationAttempted = false;',
  '      mutationAttempted = true;\n      const result = await this.#injectRequest(',
  '      const outcomeUnknown = Boolean(error?.outcomeUnknown);',
  '      upstreamAlive: false,',
  '      if (client.downstream.readyState === this.WebSocketImpl.OPEN) {\n        this.#sendOrClose(client, client.downstream, data, isBinary, "upstream_to_downstream");',
  '    client.closed = true;',
  '    for (const client of [...this.clients]) this.#closeClient(client, "proxy_closed");',
  '  pauseUpstream() { preserveManagedProcess(); }',
  '  setUpstreamUrl(value) { preserveEndpointValidation(value); }',
  '  resumeUpstream() { preserveManagedReconnect(); }',
].join("\n");

function hash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

test("preparation preserves unrelated local lifecycle methods and line endings", () => {
  for (const lineEnding of ["\n", "\r\n"]) {
    const candidate = patchWakeVisibility(source.replace(/\n/g, lineEnding));
    for (const method of ["preserveManagedProcess();", "preserveEndpointValidation(value);", "preserveManagedReconnect();"]) {
      assert.ok(candidate.includes(method));
    }
    assert.ok(candidate.includes('import { createWakeVisibilityAdapter } from "./wake-visibility.mjs";'));
    if (lineEnding === "\r\n") assert.equal(candidate.replace(/\r\n/g, "").includes("\n"), false);
    else assert.equal(candidate.includes("\r"), false);
    assert.throws(() => patchWakeVisibility(candidate), /already present/);
  }
});

test("unknown and duplicate anchors are rejected rather than guessing", () => {
  assert.throws(() => patchWakeVisibility(source.replace("    client.closed = true;", "    client.closed = false;")), /Expected one patch anchor/);
  assert.throws(() => patchWakeVisibility(`${source}\n    client.closed = true;`), /Expected one patch anchor/);
});

test("prepare writes only a new candidate directory and validates both file hashes", context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-wake-visibility-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "installed-proxy.mjs");
  const outputDirectory = path.join(root, "candidate");
  fs.writeFileSync(sourcePath, source, "utf8");
  const manifest = prepareWakeVisibility({ sourcePath, outputDirectory, expectedSha256: hash(source) });
  assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
  assert.equal(manifest.productionModified, false);
  assert.equal(manifest.sourceSha256, hash(source));
  assert.equal(manifest.files.length, 2);
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(outputDirectory, file.name));
    assert.equal(bytes.length, file.bytes);
    assert.equal(hash(bytes), file.sha256);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDirectory, "manifest.json"), "utf8")), manifest);
  assert.throws(() => prepareWakeVisibility({ sourcePath, outputDirectory, expectedSha256: hash(source) }), /EEXIST/);
});

test("source hash mismatch leaves no prepared directory", context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-wake-visibility-mismatch-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "installed-proxy.mjs");
  const outputDirectory = path.join(root, "candidate");
  fs.writeFileSync(sourcePath, source, "utf8");
  assert.throws(() => prepareWakeVisibility({ sourcePath, outputDirectory, expectedSha256: "0".repeat(64) }), /Source changed/);
  assert.equal(fs.existsSync(outputDirectory), false);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), source);
});
