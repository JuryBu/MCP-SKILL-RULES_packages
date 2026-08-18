import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-cc-bridge-test-"));
const fakeClaudeJs = path.join(tempDir, "fake-claude.js");
const fakeClaudeCmd = path.join(tempDir, "fake-claude.cmd");
const childPidMarker = path.join(tempDir, "child-pid.txt");

fs.writeFileSync(fakeClaudeJs, `
const { spawn } = require("node:child_process");
const fs = require("node:fs");

if (process.argv.includes("--version")) {
  console.log("fake-claude 0.0.0");
  process.exit(0);
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
  if (mode === "empty") {
    process.exit(0);
  }
  if (mode === "error") {
    console.log("partial claude output");
    console.error("fake claude error");
    process.exit(7);
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
process.env.MEMORY_STORE_CC_MODEL_TIMEOUT_MS = "500";
process.env.MEMORY_STORE_CC_MAX_TIMEOUT_MS = "1000";

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

    process.env.FAKE_CLAUDE_MODE = "sleep";
    fs.rmSync(childPidMarker, { force: true });
    const timeout = await callClaudeCodeExec("hello", "sonnet", 300);
    assert.equal(timeout.text, null);
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.failureClass, "Availability");
    assert.match(timeout.error || "", /超时/u);

    const childPid = Number(fs.readFileSync(childPidMarker, "utf-8"));
    assert.equal(await waitForDead(childPid), true, "timeout should kill fake Claude Code child process tree");
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
