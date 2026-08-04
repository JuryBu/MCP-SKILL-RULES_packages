import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-output-delivery-"));
process.env.SANDBOX_DATA_ROOT = dataRoot;
delete process.env.SANDBOX_OUTPUT_ARTIFACT_TTL_MS;

const {
    createOutputDeliveryCollector,
    HARD_RESPONSE_BYTE_LIMIT,
} = await import("../mcps/sandbox/dist/output-delivery.js");
const {
    cleanExpiredOutputArtifacts,
    createOutputArtifactRun,
    getOutputArtifactStats,
    OUTPUT_ARTIFACT_ROOT,
} = await import("../mcps/sandbox/dist/output-artifact-store.js");

const tests = [];
const test = (name, run) => tests.push({ name, run });
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function readManifest(result) {
    return JSON.parse(fs.readFileSync(result.artifact.manifestPath, "utf8"));
}

function assertAtomicManifest(result) {
    const entries = fs.readdirSync(path.dirname(result.artifact.manifestPath));
    assert.equal(entries.some((entry) => entry.endsWith(".tmp")), false);
}

function artifactIds() {
    if (!fs.existsSync(OUTPUT_ARTIFACT_ROOT)) return [];
    return fs.readdirSync(OUTPUT_ARTIFACT_ROOT).sort();
}

test("auto returns split UTF-8 and CRLF inline with exact metrics", async () => {
    const before = artifactIds();
    const collector = await createOutputDeliveryCollector();
    const stdout = Buffer.from("甲\r\n乙🙂\n", "utf8");
    const emojiStart = stdout.indexOf(Buffer.from("🙂", "utf8"));
    await collector.write("stdout", stdout.subarray(0, emojiStart + 1));
    await collector.write("stdout", stdout.subarray(emojiStart + 1, emojiStart + 3));
    await collector.write("stdout", stdout.subarray(emojiStart + 3));
    await collector.write("stderr", "warn\r");
    await collector.write("stderr", "x");
    const result = await collector.finalize();

    assert.equal(result.mode, "inline");
    assert.equal(result.stdout, stdout.toString("utf8"));
    assert.equal(result.stderr, "warn\rx");
    assert.equal(result.stats.stdout.rawBytes, stdout.length);
    assert.equal(result.stats.stdout.lines, 2);
    assert.equal(result.stats.stderr.lines, 2);
    assert.equal(result.stats.stdout.sha256, sha256(stdout));
    assert.equal(result.complete, true);
    assert.equal(result.status, "done");
    assert.equal(result.artifact, undefined);
    assert.equal(result.readHint, undefined);
    assert.deepEqual(artifactIds(), before);
});

test("auto falls back after 2000 combined lines while inline can override it", async () => {
    const content = "x\n".repeat(2001);
    const automatic = await createOutputDeliveryCollector();
    await automatic.write("stdout", content);
    const automaticResult = await automatic.finalize();
    assert.equal(automaticResult.mode, "file");
    assert.equal(automaticResult.stats.combined.lines, 2001);
    assert.ok(automaticResult.reasons.includes("combined_line_limit_exceeded"));

    const beforeForced = artifactIds();
    const forced = await createOutputDeliveryCollector({ mode: "inline" });
    await forced.write("stdout", content);
    const forcedResult = await forced.finalize();
    assert.equal(forcedResult.mode, "inline");
    assert.equal(forcedResult.stdout, content);
    assert.equal(forcedResult.artifact, undefined);
    assert.deepEqual(artifactIds(), beforeForced);
});

test("interrupted auto output retains a recovery artifact", async () => {
    const before = await getOutputArtifactStats();
    const collector = await createOutputDeliveryCollector();
    await collector.write("stdout", "partial output");
    const result = await collector.finalize({ status: "interrupted", error: "timeout" });
    assert.equal(result.mode, "file");
    assert.ok(result.reasons.includes("interrupted_output_preserved"));
    assert.equal(fs.readFileSync(result.artifact.stdoutPath, "utf8"), "partial output");
    const after = await getOutputArtifactStats();
    assert.equal(after.runs, before.runs + 1);
    assert.ok(after.payloadBytes >= before.payloadBytes + Buffer.byteLength("partial output"));
});

test("the 1 MiB serialized response guard overrides explicit inline", async () => {
    const content = "\0".repeat(180_000);
    const collector = await createOutputDeliveryCollector({ mode: "inline" });
    await collector.write("stdout", content);
    const result = await collector.finalize();
    assert.equal(HARD_RESPONSE_BYTE_LIMIT, 1024 * 1024);
    assert.equal(result.mode, "file");
    assert.ok(result.reasons.includes("response_byte_limit_exceeded"));
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= HARD_RESPONSE_BYTE_LIMIT);
    assert.equal(fs.statSync(result.artifact.stdoutPath).size, Buffer.byteLength(content));
});

test("hard guard streams a huge inline request to file with bounded UTF-8 preview", async () => {
    const prefix = Buffer.from("🙂".repeat(3000), "utf8");
    const body = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const content = Buffer.concat([prefix, body, prefix]);
    const collector = await createOutputDeliveryCollector({
        mode: "inline",
        inputHighWaterMarkBytes: 32,
        writeHighWaterMarkBytes: 32,
    });
    const acceptedWithoutBackpressure = collector.stdout.write(content);
    assert.equal(acceptedWithoutBackpressure, false);
    collector.stdout.end();
    const result = await collector.finalize();

    assert.equal(result.mode, "file");
    assert.ok(result.reasons.includes("response_byte_limit_exceeded"));
    assert.equal(result.stats.stdout.lines, 1);
    assert.equal(result.stats.stdout.rawBytes, content.length);
    assert.equal(result.stats.stdout.sha256, sha256(content));
    assert.ok(Buffer.byteLength(result.preview.stdout.head, "utf8") <= 4096);
    assert.ok(Buffer.byteLength(result.preview.stdout.tail, "utf8") <= 4096);
    assert.equal(result.preview.stdout.head.includes("�"), false);
    assert.equal(result.preview.stdout.tail.includes("�"), false);
    assert.equal(fs.statSync(result.artifact.stdoutPath).size, content.length);
    assert.equal(fs.readFileSync(result.artifact.stdoutPath).compare(content), 0);
    assertAtomicManifest(result);
});

test("manifest mode returns only durable metadata", async () => {
    const collector = await createOutputDeliveryCollector({ mode: "manifest" });
    await collector.write("stderr", "failure details");
    const result = await collector.finalize({ status: "error", error: "command failed" });
    assert.equal(result.mode, "manifest");
    assert.equal(result.status, "error");
    assert.equal(result.stdout, undefined);
    assert.equal(result.stderr, undefined);
    assert.equal(result.preview, undefined);
    assert.ok(result.readHint.includes("manifest.json"));
    assert.equal(readManifest(result).error, "command failed");
});

test("a small caller response budget falls back to manifest metadata", async () => {
    const collector = await createOutputDeliveryCollector({ responseByteLimit: 100 });
    await collector.write("stdout", "x".repeat(2000));
    const result = await collector.finalize();
    assert.equal(result.mode, "manifest");
    assert.equal(result.stdout, undefined);
    assert.ok(result.reasons.includes("response_byte_limit_exceeded"));
    assert.ok(result.reasons.includes("file_preview_response_limit_exceeded"));
});

test("startup cleanup may remove expired incomplete artifacts", async () => {
    const run = await createOutputArtifactRun({ ttlMs: 1 });
    const manifest = JSON.parse(fs.readFileSync(run.manifestPath, "utf8"));
    const now = Date.parse(manifest.expiresAt) + 1;
    const retained = await cleanExpiredOutputArtifacts(now);
    assert.ok(retained.retained >= 1);
    assert.equal(fs.existsSync(run.directory), true);
    const removed = await cleanExpiredOutputArtifacts(now, true);
    assert.equal(removed.removed, 1);
    assert.equal(fs.existsSync(run.directory), false);
});

test("cleanup removes only complete artifacts after expiresAt", async () => {
    const collector = await createOutputDeliveryCollector({ mode: "manifest", artifactTtlMs: 1 });
    await collector.write("stdout", "expired");
    const result = await collector.finalize();
    const cleanup = await cleanExpiredOutputArtifacts(Date.parse(result.artifact.expiresAt) + 1);
    assert.equal(cleanup.removed, 1);
    assert.equal(fs.existsSync(path.dirname(result.artifact.manifestPath)), false);
});

let passed = 0;
try {
    for (const { name, run } of tests) {
        await run();
        passed += 1;
        console.log(`ok ${passed} - ${name}`);
    }
    console.log(`\n${passed}/${tests.length} sandbox output-delivery design tests passed`);
} finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
