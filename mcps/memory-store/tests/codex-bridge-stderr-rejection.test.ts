import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stderr-rejection-"));
process.env.MEMORY_STORE_DATA_ROOT = fixtureRoot;
const { CodexDiagnosticRecorder } = await import("../src/codex-bridge-diagnostics.js");
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/codex-stderr-policy-rejection.json", import.meta.url), "utf8"));
const metadata = {
    command: "fixture-codex", args: ["exec", "--json"], cwd: fixtureRoot,
    model: "fixture-model", reasoningEffort: "max", requestedServiceTier: "default", requestedFastMode: false,
    timeoutMs: 1000, promptSha256: "fixture-prompt-hash",
};
const digest = (bytes: Buffer | string) => crypto.createHash("sha256").update(bytes).digest("hex");
const stdout = fixture.stdout.map((event: unknown) => JSON.stringify(event)).join("\n") + "\n";
const policyLine: string = fixture.stderr[1];
const policyBytes = Buffer.from(policyLine + "\r\n", "utf8");
const manifestFor = (result: { manifestPath?: string }) => JSON.parse(fs.readFileSync(result.manifestPath!, "utf8"));

try {
    const recorder = new CodexDiagnosticRecorder(metadata);
    recorder.recordStdout(stdout);
    recorder.recordStderr(fixture.stderr[0] + "\r\n");
    for (const byte of policyBytes.subarray(0, -1)) recorder.recordStderr(Buffer.from([byte]));
    assert.equal(recorder.hasObservedRejection(), false, "a partial log record must wait for its line boundary");
    recorder.recordStderr(policyBytes.subarray(-1));
    assert.equal(recorder.hasObservedRejection(), true, "stderr refusal must be observable before finish");
    const result = recorder.finish({ exitCode: 0, timedOut: false });
    assert.equal(result.rejectedCommandCount, 1);
    assert.equal(result.stderrRejectedCommandCount, 1);
    assert.equal(result.commandCount, 1);
    assert.equal(result.failedCommandCount, 1);
    assert.equal(result.runningCommandCount, 0);
    assert.equal(result.eventCount, 5);
    assert.equal(result.eventCoverage, "partial");
    assert.equal(result.modelReportedRefusal, false);
    const manifest = manifestFor(result);
    assert.equal(manifest.commands[0].type, "mcp_tool_call");
    assert.equal(manifest.commands[0].rejectionEvidence, undefined);
    assert.deepEqual(manifest.stderrRejections, [{
        source: "stderr", lineNumber: 2, lineSha256: digest(policyLine), logger: "codex_core::tools::router",
        tool: "exec_command", rejectionEvidence: "cli-policy-error", reason: "blocked by policy",
        command: "fixture-read-rules 中文猫", commandTruncated: false, executionObserved: false,
    }]);
    assert.equal(JSON.stringify(result).includes("fixture-read-rules"), false);
    assert.equal(result.stderr.streamSha256, digest(fixture.stderr[0] + "\r\n" + policyLine + "\r\n"));
    assert.equal(result.manifestSha256, digest(fs.readFileSync(result.manifestPath!)));
    assert.equal(recorder.finish({ exitCode: 9, timedOut: true }), result);
    recorder.recordStderr(policyBytes);
    assert.equal(result.stderrRejectedCommandCount, 1);

    for (let boundary = 1; boundary < policyBytes.length; boundary++) {
        const split = new CodexDiagnosticRecorder(metadata);
        split.recordStderr(policyBytes.subarray(0, boundary));
        split.recordStderr(policyBytes.subarray(boundary));
        assert.equal(split.hasObservedRejection(), true, `UTF-8/escape/CRLF boundary ${boundary}`);
        assert.equal(split.finish({ exitCode: 0, timedOut: false }).rejectedCommandCount, 1);
    }

    const negatives = [
        JSON.stringify(policyLine), "Example: " + policyLine, "`" + policyLine + "`",
        "The CLI may print Rejected(\"`fixture` rejected: blocked by policy\") as an example.",
        policyLine.replace(" ERROR ", " INFO "), policyLine.replace("codex_core::tools::router", "fixture::logger"),
        policyLine.replace("error=exec_command", "error=web_search"),
        policyLine.replace("blocked by policy", "request timed out"),
        policyLine.replace("Rejected(", "Example Rejected("),
        fixture.stderr[0], "ECONNRESET permission denied; command rejected by policy", "{incomplete JSON",
    ];
    const quoted = new CodexDiagnosticRecorder(metadata);
    quoted.recordStderr(negatives.join("\n") + "\n");
    quoted.recordStdout(JSON.stringify({ type: "item.completed", item: {
        id: "quoted-output", type: "command_execution", command: "fixture-only", status: "failed", exit_code: 1,
        aggregated_output: policyLine,
    } }) + "\n");
    const quotedResult = quoted.finish({ exitCode: 0, timedOut: false });
    assert.equal(quoted.hasObservedRejection(), false);
    assert.equal(quotedResult.rejectedCommandCount, 0);
    assert.equal(quotedResult.stderrRejectedCommandCount, 0);
    assert.equal(quotedResult.failedCommandCount, 1);
    assert.equal(quotedResult.eventCoverage, "complete");

    const tail = new CodexDiagnosticRecorder(metadata);
    tail.recordStderr(policyLine);
    assert.equal(tail.hasObservedRejection(), false);
    const tailResult = tail.finish({ exitCode: 0, timedOut: false });
    assert.equal(tailResult.stderrRejectedCommandCount, 1);
    assert.equal(manifestFor(tailResult).stderrRejections[0].lineNumber, 1);

    const repeated = new CodexDiagnosticRecorder(metadata);
    repeated.recordStderr(policyLine + "\n" + policyLine + "\n");
    assert.equal(repeated.finish({ exitCode: 0, timedOut: false }).stderrRejectedCommandCount, 1);
    const distinct = new CodexDiagnosticRecorder(metadata);
    distinct.recordStderr(policyLine + "\n" + policyLine.replace("00:00:01", "00:00:02") + "\n");
    assert.equal(distinct.finish({ exitCode: 0, timedOut: false }).rejectedCommandCount, 2);

    const correlated = new CodexDiagnosticRecorder(metadata);
    correlated.recordStdout(JSON.stringify({ type: "item.completed", item: {
        id: "same-command", type: "command_execution", command: "fixture-read-rules 中文猫", status: "declined",
    } }) + "\n");
    correlated.recordStderr(policyBytes);
    const correlatedResult = correlated.finish({ exitCode: 0, timedOut: false });
    assert.equal(correlatedResult.rejectedCommandCount, 1);
    assert.equal(correlatedResult.stderrRejectedCommandCount, 1);

    const capped = new CodexDiagnosticRecorder(metadata, { stderrBytes: 7 });
    capped.recordStderr(policyBytes);
    const cappedResult = capped.finish({ exitCode: 0, timedOut: false });
    assert.equal(cappedResult.stderr.capturedBytes, 7);
    assert.equal(cappedResult.stderr.sha256, digest(policyBytes.subarray(0, 7)));
    assert.equal(cappedResult.stderr.streamSha256, digest(policyBytes));
    assert.equal(cappedResult.stderr.truncated, true);
    assert.equal(cappedResult.rejectedCommandCount, 1);
    assert.equal(cappedResult.eventCoverage, "partial");

    const oversized = new CodexDiagnosticRecorder(metadata);
    oversized.recordStderr("x".repeat(262_144));
    oversized.recordStderr(policyLine + "\n" + policyLine + "\n");
    const oversizedResult = oversized.finish({ exitCode: 0, timedOut: false });
    assert.equal(oversizedResult.stderrRejectedCommandCount, 1);
    assert.equal(manifestFor(oversizedResult).stderrRejections[0].lineNumber, 2);
    assert.equal(oversizedResult.eventCoverage, "partial");

    const colored = new CodexDiagnosticRecorder(metadata);
    colored.recordStderr("\u001b[31m" + policyLine + "\u001b[0m\n");
    assert.equal(colored.finish({ exitCode: 0, timedOut: false }).stderrRejectedCommandCount, 1);

    const failedCapture = new CodexDiagnosticRecorder(metadata);
    const originalWrite = fs.writeSync;
    try {
        fs.writeSync = () => { throw new Error("fixture stderr write failure"); };
        failedCapture.recordStderr(policyBytes);
    } finally {
        fs.writeSync = originalWrite;
    }
    assert.equal(failedCapture.hasObservedRejection(), true);
    const failedCaptureResult = failedCapture.finish({ exitCode: 0, timedOut: false });
    assert.equal(failedCaptureResult.stderrRejectedCommandCount, 1);
    assert.equal(failedCaptureResult.stderr.capturedBytes, 0);
    assert.equal(failedCaptureResult.stderr.streamSha256, digest(policyBytes));
    assert.match(failedCaptureResult.captureError || "", /fixture stderr write failure/u);
    assert.equal(failedCaptureResult.eventCoverage, "partial");

    const replayPath = process.env.CODEX_DIAGNOSTIC_REPLAY_MANIFEST;
    if (replayPath) {
        const original = JSON.parse(fs.readFileSync(replayPath, "utf8"));
        const replay = new CodexDiagnosticRecorder(metadata);
        for (const source of ["stdout", "stderr"] as const) {
            const bytes = fs.readFileSync(original[source].path);
            assert.equal(bytes.length, original[source].bytes);
            assert.equal(digest(bytes), original[source].sha256);
            for (let offset = 0; offset < bytes.length; offset += 31) {
                if (source === "stdout") replay.recordStdout(bytes.subarray(offset, offset + 31));
                else replay.recordStderr(bytes.subarray(offset, offset + 31));
            }
        }
        const replayResult = replay.finish(original.outcome);
        assert.equal(replayResult.rejectedCommandCount, 1);
        assert.equal(replayResult.stderrRejectedCommandCount, 1);
        assert.equal(replayResult.commandCount, 1);
        assert.equal(replayResult.eventCount, 5);
        assert.equal(replayResult.eventCoverage, "partial");
        assert.equal(manifestFor(replayResult).stderrRejections[0].lineNumber, 6);
        assert.equal(manifestFor(replayResult).stderrRejections[0].executionObserved, false);
        console.log("original-readonly-replay: PASS " + JSON.stringify({
            stdoutBytes: replayResult.stdout.bytes, stderrBytes: replayResult.stderr.bytes,
            stdoutSha256: replayResult.stdout.sha256, stderrSha256: replayResult.stderr.sha256,
            events: replayResult.eventCount, commands: replayResult.commandCount,
            rejected: replayResult.rejectedCommandCount, stderrRejected: replayResult.stderrRejectedCommandCount,
            eventCoverage: replayResult.eventCoverage, stderrLine: 6,
        }));
    }
    console.log(`codex-bridge-stderr-rejection: PASS ${policyBytes.length - 1} split boundaries; live refusal/provenance/negative controls/tail/dedup/caps/oversized/ANSI`);
} finally {
    assert.equal(path.dirname(path.resolve(fixtureRoot)), path.resolve(os.tmpdir()));
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
