import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { readDshSessionFingerprint } from "../src/dsh-session-reader.ts";
import { shouldUsePublishedConversationCache } from "../src/conversation-search-policy.ts";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-store-plan65-dsh-use-freshness-"));
const target = path.join(root, "project", "target", "session.jsonl");
const unrelated = path.join(root, "project", "unrelated", "session.jsonl.zstd");
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.mkdir(path.dirname(unrelated), { recursive: true });
await fs.writeFile(target, '{"type":"session","version":0,"id":"target"}\ninvalid-body-A\n');
await fs.writeFile(unrelated, "invalid-zstd-unrelated");
const phases: string[] = [];
const before = await fs.stat(target);
const first = await readDshSessionFingerprint("target", { sessionsRoot: root, onProgress: value => phases.push(value.phase) }, target);
assert(first);
assert(phases.every(phase => phase === "verify"));
await fs.writeFile(target, '{"type":"session","version":0,"id":"target"}\ninvalid-body-B\n');
await fs.utimes(target, before.atime, before.mtime);
const changed = await readDshSessionFingerprint("target", { sessionsRoot: root }, target);
assert(changed);
assert.equal(first.size, changed.size);
assert.notEqual(first.revision, changed.revision);
assert(shouldUsePublishedConversationCache("read", "dsh", false));
assert(!shouldUsePublishedConversationCache("read", "dsh", true));
const actual = process.env.MEMORY_STORE_DSH_REAL_FRESHNESS_SOURCE;
if (process.env.MEMORY_STORE_DSH_REAL_FRESHNESS_PROBE === "1" && actual) {
    const started = performance.now();
    const real = await readDshSessionFingerprint(path.basename(path.dirname(actual)), {}, actual);
    console.log(JSON.stringify({ actual, elapsedMs: Math.round(performance.now() - started), real }));
}
console.log(JSON.stringify({ root, targetedFingerprintWithoutBodyParsing: true, sameSizeChangedTargetDetected: true, defaultDshCachePolicy: true }));
