import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBoundedJsonlWriter } from "../src/bounded-jsonl-log.mjs";

test("bounded JSONL rejects an empty path instead of writing into cwd", () => {
  assert.throws(() => createBoundedJsonlWriter({ filePath: "   " }), /filePath is required/);
});

test("bounded JSONL rotates and keeps the configured file count", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-bounded-log-"));
  try {
    const filePath = path.join(root, "events.jsonl");
    const writer = createBoundedJsonlWriter({ filePath, maxBytes: 1024, maxFiles: 3 });
    for (let index = 0; index < 20; index += 1) writer.append({ index, payload: "x".repeat(180) });
    assert.equal(fs.existsSync(filePath), true);
    assert.equal(fs.existsSync(`${filePath}.1`), true);
    assert.equal(fs.existsSync(`${filePath}.2`), true);
    assert.equal(fs.existsSync(`${filePath}.3`), false);
    assert.ok(fs.statSync(filePath).size <= 1024);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bounded JSONL prunes expired files and omits an oversized entry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-bounded-expiry-"));
  try {
    const filePath = path.join(root, "events.jsonl");
    fs.writeFileSync(`${filePath}.1`, "old\n", "utf8");
    fs.utimesSync(`${filePath}.1`, new Date(0), new Date(0));
    const writer = createBoundedJsonlWriter({
      filePath,
      maxBytes: 1024,
      maxFiles: 2,
      retentionMs: 1000,
      now: () => new Date("2026-08-15T12:00:00Z"),
    });
    writer.append({ payload: "x".repeat(5000) });
    assert.equal(fs.existsSync(`${filePath}.1`), false);
    assert.match(fs.readFileSync(filePath, "utf8"), /log_entry_omitted/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
