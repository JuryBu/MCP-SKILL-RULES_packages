import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-codex-diagnostics-"));
process.env.MEMORY_STORE_DATA_ROOT = fixtureRoot;
const { CodexDiagnosticRecorder, hasCodexModelRefusalClaim } = await import("../src/codex-bridge-diagnostics.js");
const metadata = {
    command: "fixture-codex", args: ["exec", "--json", "--ephemeral", "--sandbox", "read-only"], cwd: fixtureRoot,
    model: "gpt-6.1-sol", reasoningEffort: "max", requestedServiceTier: "priority", requestedFastMode: true,
    timeoutMs: 1000, promptSha256: "fixture-prompt-hash", context: { conversationId: "fixture-conversation", guardId: "fixture-guard" },
};
const digest = (bytes: Buffer | string) => crypto.createHash("sha256").update(bytes).digest("hex");
const event = (identifier: string, status: string, additional: Record<string, unknown> = {}) => JSON.stringify({
    type: "item.completed", item: { id: identifier, type: "command_execution", command: "echo private-command-marker", status, ...additional },
}) + "\n";

try {
    const recorder = new CodexDiagnosticRecorder(metadata);
    assert.equal(recorder.hasObservedRejection(), false);
    const stdout = Buffer.from(event("ordinary-error", "failed", { exit_code: 1, aggregated_output: "permission denied; command rejected by policy is ordinary command output here" }) + event("rejected", "declined") + event("rejected", "failed") + event("finished", "completed", { exit_code: 0 }), "utf8");
    recorder.recordStdout(stdout.subarray(0, 17));
    assert.equal(recorder.hasObservedRejection(), false);
    recorder.recordStdout(stdout.subarray(17));
    assert.equal(recorder.hasObservedRejection(), true);
    recorder.recordStderr("fixture stderr\n");
    const result = recorder.finish({ exitCode: 0, timedOut: false, lastText: "EVIDENCE_INSUFFICIENT\n本机读取命令被策略拒绝" });
    assert.equal(result.commandCount, 3);
    assert.equal(result.rejectedCommandCount, 1);
    assert.equal(result.failedCommandCount, 2);
    assert.equal(result.eventCount, 4);
    assert.equal(result.eventCoverage, "complete");
    assert.equal(result.modelReportedRefusal, true);
    assert.equal(result.stdout.sha256, digest(stdout));
    assert.equal(result.stdout.streamSha256, digest(stdout));
    assert.equal(fs.statSync(result.stdout.path!).size, result.stdout.capturedBytes);
    assert.equal(result.manifestSha256, digest(fs.readFileSync(result.manifestPath!)));
    assert.equal(result.manifestBytes, fs.statSync(result.manifestPath!).size);
    assert.equal(JSON.stringify(result).includes("private-command-marker"), false);
    const manifest = JSON.parse(fs.readFileSync(result.manifestPath!, "utf8"));
    assert.equal(manifest.metadata.context.guardId, "fixture-guard");
    assert.equal(manifest.commands[1].rejectionEvidence, "structured-status");
    assert.equal(manifest.outcome.lastText, undefined);
    assert.equal(fs.existsSync(path.join(path.dirname(result.manifestPath!), "pending.json")), false);
    assert.equal(recorder.finish({ exitCode: 9, timedOut: true }), result);
    assert.equal(recorder.hasObservedRejection(), true);

    const capacityEvents = Array.from({ length: 128 }, (_, index) => event(`retained-${index}`, "completed", { exit_code: 0 })).join("");
    const overflow = new CodexDiagnosticRecorder(metadata);
    overflow.recordStdout(capacityEvents);
    assert.equal(overflow.hasObservedRejection(), false);
    const overflowRejection = event("overflow", "declined");
    overflow.recordStdout(overflowRejection.slice(0, 17));
    assert.equal(overflow.hasObservedRejection(), false);
    overflow.recordStdout(overflowRejection.slice(17));
    assert.equal(overflow.hasObservedRejection(), true);
    overflow.recordStdout(overflowRejection + event("overflow", "completed", { exit_code: 0 }));
    assert.equal(overflow.hasObservedRejection(), true);
    const overflowResult = overflow.finish({ exitCode: 0, timedOut: false });
    assert.equal(overflowResult.commandCount, 128);
    assert.equal(overflowResult.eventCount, 131);
    assert.equal(overflowResult.rejectedCommandCount, 1);
    assert.equal(overflowResult.eventCoverage, "partial");
    assert.equal(overflowResult.captureError, undefined);
    const overflowManifest = JSON.parse(fs.readFileSync(overflowResult.manifestPath!, "utf8"));
    assert.equal(overflowManifest.commands.length, 128);
    assert.equal(overflowManifest.rejectedCommandCount, 1);
    assert.equal(overflowManifest.eventCoverage, "partial");

    const overflowCode = new CodexDiagnosticRecorder(metadata);
    overflowCode.recordStdout(capacityEvents);
    overflowCode.recordStdout(JSON.stringify({ type: "item.completed", item: { id: "overflow-code", type: "mcp_tool_call", tool: "fixture_tool", status: "failed", error: { code: "policy_denied" } } }) + "\n");
    assert.equal(overflowCode.hasObservedRejection(), true);
    const overflowCodeResult = overflowCode.finish({ exitCode: 0, timedOut: false });
    assert.equal(overflowCodeResult.commandCount, 128);
    assert.equal(overflowCodeResult.rejectedCommandCount, 1);
    assert.equal(overflowCodeResult.eventCoverage, "partial");

    const updated = new CodexDiagnosticRecorder(metadata);
    updated.recordStdout(capacityEvents);
    updated.recordStdout(event("retained-0", "declined"));
    assert.equal(updated.hasObservedRejection(), true);
    updated.recordStdout(event("retained-0", "completed", { exit_code: 0 }) + event("retained-0", "declined"));
    updated.recordStdout(event("retained-1", "failed", { error: { code: "policy_denied" } }) + event("retained-1", "completed", { exit_code: 0 }));
    assert.equal(updated.hasObservedRejection(), true);
    const updatedResult = updated.finish({ exitCode: 0, timedOut: false });
    assert.equal(updatedResult.commandCount, 128);
    assert.equal(updatedResult.rejectedCommandCount, 2);
    assert.equal(updatedResult.eventCoverage, "complete");
    const updatedManifest = JSON.parse(fs.readFileSync(updatedResult.manifestPath!, "utf8"));
    assert.equal(updatedManifest.commands[0].rejectionEvidence, "structured-status");
    assert.equal(updatedManifest.commands[1].rejectionEvidence, "structured-error-code");
    assert.equal(updated.hasObservedRejection(), true);
    assert.equal(updated.finish({ exitCode: 9, timedOut: true }), updatedResult);

    const oversized = new CodexDiagnosticRecorder(metadata);
    const oversizedEvent = event("oversized", "declined", { aggregated_output: "x".repeat(300_000) });
    oversized.recordStdout(oversizedEvent.slice(0, 131_072));
    oversized.recordStdout(oversizedEvent.slice(131_072));
    assert.equal(oversized.hasObservedRejection(), false);
    oversized.recordStdout(event("after-oversized", "declined"));
    assert.equal(oversized.hasObservedRejection(), true);
    const oversizedResult = oversized.finish({ exitCode: 0, timedOut: false });
    assert.equal(oversizedResult.eventCoverage, "partial");
    assert.equal(oversizedResult.captureError, undefined);
    assert.equal(oversizedResult.commandCount, 1);
    assert.equal(oversizedResult.rejectedCommandCount, 1);
    assert.equal(oversizedResult.stdout.streamSha256, digest(oversizedEvent + event("after-oversized", "declined")));

    const writeFailure = new CodexDiagnosticRecorder(metadata);
    const originalWrite = fs.writeSync;
    try {
        fs.writeSync = () => { throw new Error("fixture diagnostic write failure"); };
        writeFailure.recordStdout(event("write-failure-refusal", "denied"));
        writeFailure.recordStderr("fixture failed stderr write");
    } finally {
        fs.writeSync = originalWrite;
    }
    assert.equal(writeFailure.hasObservedRejection(), true);
    const writeFailureResult = writeFailure.finish({ exitCode: 0, timedOut: false });
    assert.match(writeFailureResult.captureError || "", /fixture diagnostic write failure/u);
    assert.equal(writeFailureResult.eventCoverage, "partial");
    assert.equal(writeFailureResult.rejectedCommandCount, 1);
    assert.equal(writeFailureResult.stdout.capturedBytes, 0);
    assert.equal(writeFailureResult.stdout.truncated, true);
    assert.equal(writeFailureResult.stdout.streamSha256, digest(event("write-failure-refusal", "denied")));
    assert.equal(writeFailureResult.stderr.capturedBytes, 0);
    assert.equal(writeFailureResult.stderr.truncated, true);

    const closeFailure = new CodexDiagnosticRecorder(metadata);
    closeFailure.recordStdout(event("close-failure", "completed"));
    const originalClose = fs.closeSync;
    let closeFailureResult;
    try {
        fs.closeSync = descriptor => {
            originalClose(descriptor);
            throw new Error("fixture diagnostic close failure");
        };
        closeFailureResult = closeFailure.finish({ exitCode: 0, timedOut: false });
    } finally {
        fs.closeSync = originalClose;
    }
    assert.match(closeFailureResult.captureError || "", /fixture diagnostic close failure/u);
    assert.equal(closeFailureResult.eventCoverage, "partial");
    assert.equal(closeFailureResult.rejectedCommandCount, 0);
    assert.equal(closeFailure.hasObservedRejection(), false);

    const truncated = new CodexDiagnosticRecorder(metadata, { stdoutBytes: 24, stderrBytes: 7 });
    const unicodeEvent = Buffer.from(event("unicode", "completed", { command: "echo 中文猫" }), "utf8");
    const split = unicodeEvent.indexOf(Buffer.from("中")) + 1;
    truncated.recordStdout(unicodeEvent.subarray(0, split));
    truncated.recordStdout(unicodeEvent.subarray(split));
    truncated.recordStderr("long stderr output");
    const truncatedResult = truncated.finish({ exitCode: 0, timedOut: false });
    assert.equal(truncatedResult.stdout.capturedBytes, 24);
    assert.equal(truncatedResult.stdout.bytes, unicodeEvent.length);
    assert.equal(truncatedResult.stdout.truncated, true);
    assert.equal(truncatedResult.stdout.sha256, digest(unicodeEvent.subarray(0, 24)));
    assert.equal(truncatedResult.stdout.streamSha256, digest(unicodeEvent));
    assert.equal(truncatedResult.stderr.capturedBytes, 7);
    assert.equal(truncatedResult.eventCoverage, "complete");
    assert.equal(truncatedResult.commandCount, 1);
    assert.equal(JSON.parse(fs.readFileSync(truncatedResult.manifestPath!, "utf8")).commands[0].command, "echo 中文猫");

    const partial = new CodexDiagnosticRecorder(metadata);
    partial.recordStdout("startup noise\n" + "x".repeat(300_000) + "\n" + event("running", "in_progress") + "{partial");
    const partialResult = partial.finish({ exitCode: null, timedOut: true });
    assert.equal(partialResult.eventCoverage, "partial");
    assert.equal(partialResult.runningCommandCount, 1);
    assert.equal(partialResult.rejectedCommandCount, 0);

    const structured = new CodexDiagnosticRecorder(metadata);
    structured.recordStdout(JSON.stringify({ type: "item.completed", item: { id: "tool", type: "mcp_tool_call", tool: "fixture_tool", status: "failed", error: { code: "policy_denied" } } }));
    assert.equal(structured.finish({ exitCode: 0, timedOut: false }).rejectedCommandCount, 1);
    assert.equal(hasCodexModelRefusalClaim("本机读取命令被策略拒绝"), true);
    assert.equal(hasCodexModelRefusalClaim("fixture completed normally"), false);
    assert.equal(hasCodexModelRefusalClaim("本机读取命令未被策略拒绝"), false);
    assert.equal(hasCodexModelRefusalClaim("No command was rejected"), false);

    const storage = path.join(fixtureRoot, "model-bridge-diagnostics", "codex");
    fs.rmSync(storage, { recursive: true, force: true });
    fs.writeFileSync(storage, "fixture blocking file", "utf8");
    const failedCapture = new CodexDiagnosticRecorder(metadata);
    assert.equal(failedCapture.hasObservedRejection(), false);
    failedCapture.recordStdout(event("no-storage", "completed"));
    const failedResult = failedCapture.finish({ exitCode: 0, timedOut: false });
    assert.ok(failedResult.captureError);
    assert.equal(failedResult.eventCoverage, "partial");
    assert.equal(failedResult.stdout.capturedBytes, 0);
    assert.equal(failedResult.stdout.truncated, true);
    assert.equal(failedResult.manifestPath, undefined);
    assert.equal(failedResult.commandCount, 1);
    const rejectedWithoutStorage = new CodexDiagnosticRecorder(metadata);
    rejectedWithoutStorage.recordStdout(event("no-storage-refusal", "rejected"));
    assert.equal(rejectedWithoutStorage.hasObservedRejection(), true);
    const rejectedWithoutStorageResult = rejectedWithoutStorage.finish({ exitCode: 0, timedOut: false });
    assert.ok(rejectedWithoutStorageResult.captureError);
    assert.equal(rejectedWithoutStorageResult.eventCoverage, "partial");
    assert.equal(rejectedWithoutStorageResult.rejectedCommandCount, 1);
    assert.equal(rejectedWithoutStorageResult.manifestPath, undefined);
    console.log("codex-bridge-diagnostics: PASS event provenance/privacy/chunks/caps/hashes/unknown/storage failure/129th rejection/sticky updates/oversized line/write-close failure/live rejection getter");
} finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
