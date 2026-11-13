import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAntigravityAgentCli } from "../../src/antigravity-agent-cli.js";

if (process.env.SANDBOX_AGY_RUNNER_SMOKE_TEST !== "1") throw new Error("Set SANDBOX_AGY_RUNNER_SMOKE_TEST=1 to explicitly check the guarded process runner without invoking agy");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-agy-runner-smoke-"));
let completed = false;
try {
    const result = await runAntigravityAgentCli("Write-Output 'AGY_RUNNER_SMOKE_OK 中文'\nexit 0", directory, path.join(directory, "success"), { timeoutMs: 10_000 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.aborted, false);
    assert.match(fs.readFileSync(result.stdoutPath, "utf8"), /AGY_RUNNER_SMOKE_OK 中文/u);
    const startedAt = Date.now();
    const cancelled = await runAntigravityAgentCli("Start-Sleep -Seconds 5\nexit 0", directory, path.join(directory, "cancel"), { timeoutMs: 1200 });
    assert.equal(cancelled.timedOut, true);
    assert.ok(Date.now() - startedAt < 2200);
    completed = true;
    console.log(JSON.stringify({ state: "passed", successExitCode: result.exitCode, cancelExitCode: cancelled.exitCode,
        cancellationElapsedMs: Date.now() - startedAt, agyStarts: 0, getUserStatusRequests: 0, generationRequests: 0, workDirectoryRemoved: true }));
} finally {
    if (completed) fs.rmSync(directory, { recursive: true, force: true });
    else console.error(JSON.stringify({ state: "failed", evidenceDirectory: directory, agyStarts: 0, generationRequests: 0 }));
}
