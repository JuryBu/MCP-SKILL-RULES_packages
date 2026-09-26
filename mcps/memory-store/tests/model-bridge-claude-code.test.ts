import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const tempRoot = os.tmpdir();
fs.mkdirSync(tempRoot, { recursive: true });
const tempDir = fs.mkdtempSync(path.join(tempRoot, "cc-bridge-test-"));
const fakeClaudeJs = path.join(tempDir, "fake-claude.js");
const fakeClaudeCmd = path.join(tempDir, "fake-claude.cmd");
const childPidMarker = path.join(tempDir, "child-pid.txt");
const callMarker = path.join(tempDir, "calls.txt");
process.env.MEMORY_STORE_DATA_ROOT = path.join(tempDir, "data");

fs.writeFileSync(fakeClaudeJs, `
const { spawn } = require("node:child_process");
const fs = require("node:fs");

if (process.argv.includes("--version")) {
  console.log("fake-claude 0.0.0");
  process.exit(0);
}
if (process.env.FAKE_CLAUDE_CALL_MARKER) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_CALL_MARKER, "call\\n", "utf-8");
}

let stdin = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", chunk => { stdin += chunk; });
process.stdin.on("end", () => {
  const mode = process.env.FAKE_CLAUDE_MODE || "success";
  if (mode === "success") {
    console.log("fake claude output: " + stdin.trim());
    process.exit(0);
  }
  if (mode === "guard") {
    console.log("PASS\\nfixture guard passed");
    process.exit(0);
  }
  if (mode === "empty") {
    process.exit(0);
  }
  if (mode === "error") {
    console.log("partial claude output");
    console.error("fake claude error");
    process.exit(7);
  }
  if (mode === "bytes") {
    process.stdout.write(process.env.FAKE_CLAUDE_OUTPUT || "", () => process.exit(0));
    return;
  }
  if (mode === "split") {
    const bytes = Buffer.from("汉🙂字", "utf-8");
    let offset = 0;
    const writeNext = () => {
      if (offset === bytes.length) { process.exit(0); return; }
      process.stdout.write(bytes.subarray(offset, ++offset), () => setTimeout(writeNext, 5));
    };
    writeNext();
    return;
  }
  if (mode === "both") {
    process.stdout.write("a".repeat(40));
    process.stderr.write("b".repeat(25));
    return;
  }
  if (mode === "stderr-overflow") {
    process.stderr.write("b".repeat(65));
    return;
  }
  if (mode === "overflow-tree") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    fs.writeFileSync(process.env.FAKE_CLAUDE_CHILD_PID_MARKER, String(child.pid), "utf-8");
    process.stdout.write("x".repeat(65));
    setInterval(() => {}, 1000);
  }
  if (mode === "orphan-pipe") {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 6000)"], { stdio: ["ignore", "inherit", "inherit"], detached: true, windowsHide: true });
    child.unref();
    fs.writeFileSync(process.env.FAKE_CLAUDE_CHILD_PID_MARKER, String(child.pid), "utf-8");
    process.stdout.write("incomplete response");
    setTimeout(() => process.exit(0), 100);
  }
  if (mode === "sleep") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    if (process.env.FAKE_CLAUDE_CHILD_PID_MARKER) {
      fs.writeFileSync(process.env.FAKE_CLAUDE_CHILD_PID_MARKER, String(child.pid), "utf-8");
    }
    setInterval(() => {}, 1000);
  }
});
`, "utf-8");

fs.writeFileSync(fakeClaudeCmd, `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.js" %*\r\n`, "utf-8");

process.env.MEMORY_STORE_CC_COMMAND = fakeClaudeCmd;
process.env.MEMORY_STORE_CODEX_COMMAND = path.join(tempDir, "missing-codex.cmd");
process.env.FAKE_CLAUDE_CHILD_PID_MARKER = childPidMarker;
process.env.FAKE_CLAUDE_CALL_MARKER = callMarker;
process.env.MEMORY_STORE_CC_MODEL_TIMEOUT_MS = "500";
process.env.MEMORY_STORE_CC_MAX_TIMEOUT_MS = "5000";
process.env.MEMORY_STORE_CC_OUTPUT_MAX_BYTES = "64";

const {
    callClaudeCodeExec,
    callModelResponse,
    resolveModelChain,
    resolveModelChainCandidates,
} = await import("../src/model-bridge.ts");

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForDead(pid: number): Promise<boolean> {
    for (let i = 0; i < 20; i++) {
        if (!isProcessAlive(pid)) return true;
        await delay(100);
    }
    return !isProcessAlive(pid);
}

try {
    assert.equal(await resolveModelChain("claude-code"), "claude-code");
    const fallbackCandidates = await resolveModelChainCandidates("auto", { allowClaudeCodeFallback: true });
    assert.ok(fallbackCandidates.includes("claude-code"));
    assert.equal(fallbackCandidates[fallbackCandidates.length - 1], "claude-code");
    const defaultCandidates = await resolveModelChainCandidates("auto");
    assert.equal(defaultCandidates.includes("claude-code"), false);

    process.env.FAKE_CLAUDE_MODE = "success";
    const success = await callClaudeCodeExec("hello cc", "sonnet", 5_000);
    assert.equal(success.text, "fake claude output: hello cc");
    assert.equal(success.error, undefined);

    const explicit = await callModelResponse("sonnet", "explicit cc", "claude-code", 5_000);
    assert.equal(explicit.text, "fake claude output: explicit cc");
    assert.equal(explicit.chainUsed, "claude-code");

    process.env.FAKE_CLAUDE_MODE = "empty";
    const empty = await callClaudeCodeExec("hello", "sonnet", 5_000);
    assert.equal(empty.text, null);
    assert.match(empty.error || "", /输出为空/u);
    assert.equal(empty.failureClass, "Quality");

    const emptyExplicit = await callModelResponse("sonnet", "empty cc", "claude-code", 5_000);
    assert.equal(emptyExplicit.text, null);
    assert.equal(emptyExplicit.failureClass, "Quality");

    process.env.FAKE_CLAUDE_MODE = "error";
    const failedExplicit = await callModelResponse("sonnet", "bad", "claude-code", 5_000);
    assert.equal(failedExplicit.text, null);
    assert.equal(failedExplicit.chainUsed, null);
    assert.equal(failedExplicit.failureClass, "Availability");
    assert.match(failedExplicit.error || "", /fake claude error/u);

    process.env.FAKE_CLAUDE_MODE = "bytes";
    process.env.FAKE_CLAUDE_OUTPUT = "a".repeat(64);
    const exact = await callClaudeCodeExec("boundary", "sonnet", 5_000);
    assert.equal(exact.text, "a".repeat(64), "64 UTF-8 bytes may succeed");
    process.env.FAKE_CLAUDE_OUTPUT = "a".repeat(65);
    const overflow = await callClaudeCodeExec("boundary", "sonnet", 5_000);
    assert.equal(overflow.text, null);
    assert.match(overflow.error || "", /超过 64 UTF-8 bytes.*不完整答案/u);
    assert.equal(overflow.timedOut, undefined);
    process.env.FAKE_CLAUDE_OUTPUT = "a".repeat(57) + "汉🙂";
    assert.equal((await callClaudeCodeExec("unicode boundary", "sonnet", 5_000)).text, process.env.FAKE_CLAUDE_OUTPUT);
    process.env.FAKE_CLAUDE_OUTPUT = "a".repeat(58) + "汉🙂";
    assert.match((await callClaudeCodeExec("unicode overflow", "sonnet", 5_000)).error || "", /超过 64 UTF-8 bytes/u);
    process.env.FAKE_CLAUDE_OUTPUT = "a".repeat(65);

    const callsBefore = fs.readFileSync(callMarker, "utf-8").trim().split("\n").length;
    const explicitOverflow = await callModelResponse("sonnet", "overflow", "claude-code", 5_000);
    const callsAfter = fs.readFileSync(callMarker, "utf-8").trim().split("\n").length;
    assert.equal(explicitOverflow.text, null, "incomplete output cannot become model answer");
    assert.equal(callsAfter - callsBefore, 1, "overflow must not trigger a paid retry");

    process.env.FAKE_CLAUDE_MODE = "split";
    const split = await callClaudeCodeExec("split", "sonnet", 5_000);
    assert.equal(split.text, "汉🙂字", "UTF-8 code points split across pipe chunks must survive");

    process.env.FAKE_CLAUDE_MODE = "both";
    const both = await callClaudeCodeExec("both", "sonnet", 5_000);
    assert.equal(both.text, null, "stdout and stderr share the byte ceiling");
    assert.match(both.error || "", /超过 64 UTF-8 bytes/u);
    process.env.FAKE_CLAUDE_MODE = "stderr-overflow";
    const stderrOverflow = await callClaudeCodeExec("stderr", "sonnet", 5_000);
    assert.equal(stderrOverflow.text, null);
    assert.match(stderrOverflow.error || "", /超过 64 UTF-8 bytes/u);

    process.env.FAKE_CLAUDE_MODE = "overflow-tree";
    fs.rmSync(childPidMarker, { force: true });
    const treeOverflow = await callClaudeCodeExec("tree", "sonnet", 5_000);
    assert.equal(treeOverflow.text, null);
    assert.match(treeOverflow.error || "", /超过 64 UTF-8 bytes/u);
    const overflowChildPid = Number(fs.readFileSync(childPidMarker, "utf-8"));
    assert.equal(isProcessAlive(overflowChildPid), false, "overflow response must follow confirmed cleanup");
    assert.equal(await waitForDead(overflowChildPid), true, "overflow should kill fake CLI descendant");

    process.env.FAKE_CLAUDE_MODE = "orphan-pipe";
    fs.rmSync(childPidMarker, { force: true });
    const callsBeforeOrphan = fs.readFileSync(callMarker, "utf8").trim().split("\n").length;
    const orphan = await callClaudeCodeExec("orphan", "sonnet", 5000);
    assert.equal(orphan.text, null, "a parent exiting with pipe-holding descendants cannot make partial output successful");
    assert.equal(orphan.failureClass, "UnknownOutcome");
    assert.equal(isProcessAlive(Number(fs.readFileSync(childPidMarker, "utf8"))), false, "orphan response must follow confirmed cleanup");
    assert.equal(fs.readFileSync(callMarker, "utf8").trim().split("\n").length, callsBeforeOrphan + 1);

    process.env.FAKE_CLAUDE_MODE = "bytes";
    process.env.FAKE_CLAUDE_OUTPUT = "a".repeat(65);
    for (const invalid of ["", "0", "-1", "1.5", "1e3", "0x10", "NaN", "9007199254740992"]) {
        process.env.MEMORY_STORE_CC_OUTPUT_MAX_BYTES = invalid;
        assert.equal((await callClaudeCodeExec("invalid cap", "sonnet", 5_000)).text, "a".repeat(65), `invalid cap ${invalid} uses safe default`);
    }
    process.env.MEMORY_STORE_CC_OUTPUT_MAX_BYTES = "64";

    process.env.FAKE_CLAUDE_MODE = "sleep";
    fs.rmSync(childPidMarker, { force: true });
    const timeout = await callClaudeCodeExec("hello", "sonnet", 1500);
    assert.equal(timeout.text, null);
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.failureClass, "Availability");
    assert.match(timeout.error || "", /超时/u);

    const childPid = Number(fs.readFileSync(childPidMarker, "utf-8"));
    assert.equal(isProcessAlive(childPid), false, "timeout response must follow confirmed cleanup");
    assert.equal(await waitForDead(childPid), true, "timeout should kill fake Claude Code child process tree");

    let cancelled = false;
    fs.rmSync(childPidMarker, { force: true });
    const cancelledCall = callClaudeCodeExec("cancel", "sonnet", 5_000, { shouldCancel: () => cancelled });
    for (let attempt = 0; attempt < 100 && !fs.existsSync(childPidMarker); attempt++) await delay(20);
    assert.equal(fs.existsSync(childPidMarker), true, "fake CLI entered its running phase");
    const cancelledChildPid = Number(fs.readFileSync(childPidMarker, "utf-8"));
    cancelled = true;
    const cancelledResult = await cancelledCall;
    assert.equal(cancelledResult.text, null);
    assert.equal(cancelledResult.cancelled, true);
    assert.equal(cancelledResult.timedOut, undefined);
    assert.equal(isProcessAlive(cancelledChildPid), false, "cancel response must follow confirmed cleanup");
    assert.equal(await waitForDead(cancelledChildPid), true, "cancellation should kill fake CLI descendant");

    const { buildGuardInputBundle, runGuardCheck } = await import("../src/guard-engine.ts");
    process.env.FAKE_CLAUDE_MODE = "sleep";
    const taskPath = path.join(tempDir, "Task.md");
    const planPath = path.join(tempDir, "Plan.md");
    fs.writeFileSync(taskPath, "# Other work\n- [ ] unfinished\n", "utf-8");
    fs.writeFileSync(planPath, "# Other plan\n", "utf-8");
    const inputBundle = buildGuardInputBundle([planPath], [taskPath], "Stage 99", []);
    assert.notEqual(inputBundle.coverage.confidence, "high", "fixture must activate locator");
    cancelled = false;
    fs.rmSync(childPidMarker, { force: true });
    const stages: string[] = [];
    const guardCall = runGuardCheck({
        active: true, guardId: "fixture-guard", conversationId: "", modelChain: "claude-code",
        stageId: "Stage 99", childScopeId: "main", scopeSelectors: [],
        taskFiles: [taskPath], planFiles: [planPath], startRound: 1,
        startedAt: new Date().toISOString(), checkHistory: [],
    }, undefined, undefined, {
        isCancelled: () => cancelled,
        onProgress: stage => stages.push(stage),
    });
    for (let attempt = 0; attempt < 40 && !fs.existsSync(childPidMarker); attempt++) await delay(25);
    assert.equal(fs.existsSync(childPidMarker), true, "locator should have started fake CLI");
    const locatorChildPid = Number(fs.readFileSync(childPidMarker, "utf-8"));
    cancelled = true;
    const guardResult = await guardCall;
    assert.equal(guardResult.cancelled, true);
    assert.deepEqual(stages, ["input", "locator"]);
    assert.equal(await waitForDead(locatorChildPid), true, "locator cancellation should kill fake CLI descendant");

    process.env.FAKE_CLAUDE_MODE = "guard";
    const completedStages: string[] = [];
    const completedGuard = await runGuardCheck({
        active: true, guardId: "fixture-guard-complete", conversationId: "", modelChain: "claude-code",
        stageId: "Stage 99", childScopeId: "main", scopeSelectors: [],
        taskFiles: [taskPath], planFiles: [planPath], startRound: 1,
        startedAt: new Date().toISOString(), checkHistory: [],
    }, undefined, undefined, { onProgress: stage => completedStages.push(stage) });
    assert.equal(completedGuard.passed, true);
    assert.deepEqual(completedStages, ["input", "locator", "evidence", "model", "parse", "complete"]);
    assert.equal(completedGuard.reportPath?.startsWith(process.env.MEMORY_STORE_DATA_ROOT), true);

    process.env.MEMORY_STORE_GUARD_CLAUDE_CODE_PROMPT_BUDGET = "1";
    const callsBeforeBudgetFailure = fs.readFileSync(callMarker, "utf-8").trim().split("\n").length;
    const budgetFailure = await runGuardCheck({
        active: true, guardId: "fixture-guard-budget", conversationId: "", modelChain: "claude-code",
        stageId: "Stage 99", childScopeId: "main", scopeSelectors: ["Other work"],
        taskFiles: [taskPath], planFiles: [planPath], startRound: 1,
        startedAt: new Date().toISOString(), checkHistory: [],
    });
    const callsAfterBudgetFailure = fs.readFileSync(callMarker, "utf-8").trim().split("\n").length;
    assert.equal(budgetFailure.passed, false);
    assert.equal(budgetFailure.infrastructureError, true);
    assert.match(budgetFailure.summary, /小于必需模板.*模型调用已阻止/u);
    assert.equal(callsAfterBudgetFailure, callsBeforeBudgetFailure, "template overflow must fail before model invocation");
    delete process.env.MEMORY_STORE_GUARD_CLAUDE_CODE_PROMPT_BUDGET;
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
