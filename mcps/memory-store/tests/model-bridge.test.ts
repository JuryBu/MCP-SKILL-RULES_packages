import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const originalDataRoot = process.env.MEMORY_STORE_DATA_ROOT;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-model-bridge-test-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(tempDir, "data");
const fakeCodexJs = path.join(tempDir, "fake-codex.js");
const fakeCodexCmd = path.join(tempDir, "fake-codex.cmd");
const fakeAgyJs = path.join(tempDir, "fake-agy.js");
const fakeAgyCmd = path.join(tempDir, "fake-agy.cmd");
const outputPathMarker = path.join(tempDir, "output-path.txt");
const childPidMarker = path.join(tempDir, "child-pid.txt");
const argsMarker = path.join(tempDir, "codex-args.json");
const originalCodexDefaults = Object.fromEntries(["MEMORY_STORE_CODEX_MODEL", "MEMORY_STORE_CODEX_REASONING", "MEMORY_STORE_CODEX_SPEED"].map(name => [name, process.env[name]]));
for (const name of Object.keys(originalCodexDefaults)) delete process.env[name];
let grokMode: "success" | "length" | "status-429" | "status-502" | "delay" = "success";
let grokModelsOk = true;
let grokCalls = 0;
let grokDelayMs = 200;
let lastGrokBody: any = null;
let lastLsBody: any = null;
let lsMode: "success" | "empty" | "delay" | "status-500" = "success";
let lsDelayMs = 200;

const grokServer = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
        res.writeHead(grokModelsOk ? 200 : 503, { "content-type": "application/json" });
        res.end(grokModelsOk ? JSON.stringify({ data: [{ id: "grok-test" }] }) : JSON.stringify({ error: "down" }));
        return;
    }
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
        res.writeHead(404);
        res.end("not found");
        return;
    }
    grokCalls++;
    let raw = "";
    req.setEncoding("utf-8");
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
        lastGrokBody = raw ? JSON.parse(raw) : null;
        if (grokMode === "delay") {
            setTimeout(() => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ choices: [{ message: { content: "late grok" }, finish_reason: "stop" }] }));
            }, grokDelayMs);
            return;
        }
        if (grokMode === "status-429") {
            res.writeHead(429, { "content-type": "text/plain" });
            res.end("rate limited");
            return;
        }
        if (grokMode === "status-502") {
            res.writeHead(502, { "content-type": "text/plain" });
            res.end("bad gateway");
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        if (grokMode === "length") {
            res.end(JSON.stringify({ choices: [{ message: { content: "partial grok output" }, finish_reason: "length" }] }));
            return;
        }
        res.end(JSON.stringify({ choices: [{ message: { content: "fake grok output" }, finish_reason: "stop" }] }));
    });
});

await new Promise<void>(resolve => grokServer.listen(0, "127.0.0.1", resolve));
const grokAddress = grokServer.address();
if (!grokAddress || typeof grokAddress === "string") {
    throw new Error("failed to start fake Grok server");
}

const lsServer = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf-8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
        const url = req.url || "";
        if (url.endsWith("/Heartbeat")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
            return;
        }
        if (url.endsWith("/GetModelResponse")) {
            lastLsBody = body ? JSON.parse(body) : null;
            const mode = lsMode;
            if (mode === "status-500") {
                res.writeHead(500, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "forced LS failure" }));
                return;
            }
            const respond = () => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ response: mode === "empty" ? "" : "fake ls output" }));
            };
            if (mode === "delay") {
                setTimeout(respond, lsDelayMs);
                return;
            }
            respond();
            return;
        }
        res.writeHead(404);
        res.end("not found");
    });
});

await new Promise<void>(resolve => lsServer.listen(0, "127.0.0.1", resolve));
const lsAddress = lsServer.address();
if (!lsAddress || typeof lsAddress === "string") {
    throw new Error("failed to start fake LS server");
}

fs.writeFileSync(fakeCodexJs, `
const { spawn } = require("node:child_process");
const fs = require("node:fs");

if (process.argv.includes("--version")) {
  console.log("fake-codex 0.0.0");
  process.exit(0);
}

const mode = process.env.FAKE_CODEX_MODE || "success";
const outputIndex = process.argv.indexOf("-o");
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : "";
if (process.env.FAKE_CODEX_ARGS_MARKER) {
  fs.writeFileSync(process.env.FAKE_CODEX_ARGS_MARKER, JSON.stringify(process.argv.slice(2)), "utf-8");
}
if (process.env.FAKE_CODEX_OUTPUT_MARKER && outputPath) {
  fs.writeFileSync(process.env.FAKE_CODEX_OUTPUT_MARKER, outputPath, "utf-8");
}

if (mode === "success") {
  fs.writeFileSync(outputPath, "fake bridge output", "utf-8");
  process.exit(0);
}

if (["rejected-success", "rejected-error", "rejected-pending", "ordinary-command-error", "claimed-refusal", "running-error"].includes(mode)) {
  if (mode === "claimed-refusal") {
    console.log(JSON.stringify({type: "thread.started", thread_id: "fixture-thread"}));
    fs.writeFileSync(outputPath, "EVIDENCE_INSUFFICIENT\\n本机读取命令被策略拒绝", "utf-8");
  } else {
    console.log(JSON.stringify({type: "item.completed", item: {id: "fixture-command", type: "command_execution", command: "echo ordinary-fixture", status: mode.startsWith("rejected-") ? "declined" : mode === "running-error" ? "in_progress" : "failed", exit_code: mode === "ordinary-command-error" ? 1 : null}}));
    if (!mode.endsWith("error") || mode === "ordinary-command-error") fs.writeFileSync(outputPath, "PASS\\nordinary fixture reply", "utf-8");
  }
  if (mode === "rejected-pending") {
    fs.writeFileSync(process.env.FAKE_CODEX_REJECTION_PID, String(process.pid));
    setTimeout(() => fs.writeFileSync(process.env.FAKE_CODEX_REJECTION_CONTINUED, "unexpected continuation"), 2500);
    setInterval(() => {}, 1000);
  } else process.exit(mode === "rejected-error" || mode === "running-error" ? 7 : 0);
}

if (mode === "empty") {
  process.exit(0);
}

if (mode === "directory") {
  fs.mkdirSync(outputPath);
  process.exit(0);
}

if (mode === "error") {
  console.log("partial codex output");
  console.error("fake codex error");
  process.exit(7);
}

if (mode === "json-error" || mode === "turn-failed" || mode === "terminal-metadata") {
  const message = "The 'gpt-retired' model is not supported when using Codex with a ChatGPT account.";
  console.error("model-list refresh timed out");
  console.log("startup noise");
  if (mode === "json-error") {
    console.log(JSON.stringify({type: "error", status: 400, error: {type: "invalid_request_error", message}}));
  }
  if (mode === "terminal-metadata") {
    console.log(JSON.stringify({type: "error", error: {message}}));
    console.log(JSON.stringify({type: "turn.failed", error: {message, status: 429, type: "rate_limit_error"}}));
  } else {
    console.log(JSON.stringify({type: "turn.failed", error: {message}}));
  }
  process.exit(1);
}

if (mode === "sleep") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  if (process.env.FAKE_CODEX_CHILD_PID_MARKER) {
    fs.writeFileSync(process.env.FAKE_CODEX_CHILD_PID_MARKER, String(child.pid), "utf-8");
  }
  setInterval(() => {}, 1000);
}
`, "utf-8");

fs.writeFileSync(fakeCodexCmd, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.js" %*\r\n`, "utf-8");

fs.writeFileSync(fakeAgyJs, `
const args = process.argv.slice(2);
if (process.env.FAKE_AGY_ARGS_MARKER) {
  require("node:fs").appendFileSync(process.env.FAKE_AGY_ARGS_MARKER, JSON.stringify(args) + "\\n", "utf-8");
}
if (args.includes("--help")) {
  console.log("fake-agy 0.0.0");
  process.exit(0);
}
const mode = process.env.FAKE_AGY_MODE || "success";
if (mode === "fail") {
  console.error("forced agy failure");
  process.exit(1);
}
if (mode === "fallback" && args.includes("Gemini 3.8 Flash (High)")) {
  console.error("first agy model failed");
  process.exit(1);
}
if (mode === "sleep") {
  if (process.env.FAKE_AGY_SLEEP_MARKER) require("node:fs").writeFileSync(process.env.FAKE_AGY_SLEEP_MARKER, "started", "utf-8");
  setTimeout(() => console.log("late agy output"), 5000);
  return;
}
console.log("fake agy output");
`, "utf-8");

fs.writeFileSync(fakeAgyCmd, `@echo off\r\n"${process.execPath}" "%~dp0fake-agy.js" %*\r\n`, "utf-8");

process.env.MEMORY_STORE_CODEX_COMMAND = fakeCodexCmd;
process.env.MEMORY_STORE_AGY_COMMAND = fakeAgyCmd;
process.env.FAKE_CODEX_OUTPUT_MARKER = outputPathMarker;
process.env.FAKE_CODEX_CHILD_PID_MARKER = childPidMarker;
process.env.FAKE_CODEX_ARGS_MARKER = argsMarker;
process.env.MEMORY_STORE_GROK_PROXY_URL = `http://127.0.0.1:${grokAddress.port}`;
process.env.MEMORY_STORE_GROK_API_KEY = "bridge-test-key";

const { __disableLsForTest, __setParentLsForTest } = await import("../src/ls-client.ts");
__setParentLsForTest({
    info: { pid: process.pid, csrfToken: "fake-csrf", workspaceId: "fake-ws", ports: [lsAddress.port] },
    port: lsAddress.port,
});
const { callCodexExec, callModelResponse, resolveCodexCommandForTest, resolveModelChain, resolveModelChainCandidates } = await import("../src/model-bridge.ts");
const { callGrokExec, resetGrokBridgeAvailabilityForTest } = await import("../src/grok-client.ts");
const { configureProviderTransportAdapterForTest, resetProviderTransportAdapterForTest } = await import("../src/provider-transport-adapter.ts");
await configureProviderTransportAdapterForTest({ mode: "shadow" });
const agyBridgeOptions = { agyCommand: process.execPath, agyCommandArgs: [fakeAgyJs] };

function readOutputPath(): string {
    return fs.readFileSync(outputPathMarker, "utf-8");
}

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
    const localAppData = path.join(tempDir, "local-app-data");
    const olderCodexExe = path.join(localAppData, "OpenAI", "Codex", "bin", "older", "codex.exe");
    const newerCodexExe = path.join(localAppData, "OpenAI", "Codex", "bin", "newer", "codex.exe");
    fs.mkdirSync(path.dirname(olderCodexExe), { recursive: true });
    fs.mkdirSync(path.dirname(newerCodexExe), { recursive: true });
    fs.writeFileSync(olderCodexExe, "older", "utf-8");
    fs.writeFileSync(newerCodexExe, "newer", "utf-8");
    fs.utimesSync(olderCodexExe, new Date(1_000), new Date(1_000));
    fs.utimesSync(newerCodexExe, new Date(2_000), new Date(2_000));
    assert.equal(resolveCodexCommandForTest({
        configuredCommand: path.join(tempDir, "rotated-away", "codex.exe"),
        platform: "win32",
        localAppData,
    }), newerCodexExe, "a rotated Codex Desktop path should fall back to the newest installed executable");
    assert.equal(resolveCodexCommandForTest({
        configuredCommand: "codex-custom",
        platform: "win32",
        localAppData,
    }), "codex-custom", "a configured PATH command should not be replaced by Desktop discovery");

    process.env.FAKE_CODEX_MODE = "success";
    const defaultCodex = await callModelResponse("flash", "hello", "codex", 5_000);
    assert.equal(defaultCodex.text, "fake bridge output");
    assert.equal(defaultCodex.modelUsed, "gpt-6.1-sol");
    const capturedArgs: string[] = JSON.parse(fs.readFileSync(argsMarker, "utf-8"));
    assert.equal(capturedArgs[capturedArgs.indexOf("-m") + 1], "gpt-6.1-sol");
    for (const setting of ["model_reasoning_effort=max", "service_tier=priority", "features.fast_mode=true"]) {
        assert.ok(capturedArgs.includes(setting), `missing per-request setting: ${setting}`);
    }
    for (const flag of ["--strict-config", "--ignore-rules", "--ignore-user-config", "--ephemeral"]) {
        assert.ok(capturedArgs.includes(flag), `missing isolation flag: ${flag}`);
    }
    assert.equal(capturedArgs.some(argument => argument.startsWith("model_speed_tier=")), false);
    assert.ok(defaultCodex.codexDiagnostics?.manifestPath, "successful CLI calls must retain their diagnostic reference");

    process.env.FAKE_CODEX_MODE = "rejected-success";
    const rejectedSuccess = await callModelResponse("flash", "ordinary fixture", "codex", 5_000, { diagnosticContext: { conversationId: "fixture-owner", guardId: "fixture-guard" } });
    assert.match(rejectedSuccess.text || "", /^PASS/u);
    assert.equal(rejectedSuccess.safetyStopped, true);
    assert.equal(rejectedSuccess.codexDiagnostics?.rejectedCommandCount, 1);
    const rejectionManifest = JSON.parse(fs.readFileSync(rejectedSuccess.codexDiagnostics!.manifestPath!, "utf8"));
    assert.equal(rejectionManifest.metadata.context.guardId, "fixture-guard");
    assert.equal(rejectionManifest.outcome.exitCode, 0);

    process.env.FAKE_CODEX_MODE = "rejected-error";
    const rejectedError = await callModelResponse("flash", "ordinary fixture", "codex", 5_000);
    assert.equal(rejectedError.text, null);
    assert.equal(rejectedError.safetyStopped, true);
    assert.equal(rejectedError.failureClass, "DeterministicInput");
    assert.ok(rejectedError.codexDiagnostics?.manifestPath);

    process.env.FAKE_CODEX_MODE = "rejected-pending";
    process.env.FAKE_CODEX_REJECTION_PID = path.join(tempDir, "rejected-pending.pid");
    process.env.FAKE_CODEX_REJECTION_CONTINUED = path.join(tempDir, "rejected-pending-continued.txt");
    const rejectedPending = await callModelResponse("flash", "ordinary fixture", "codex", 8000);
    assert.equal(rejectedPending.safetyStopped, true);
    assert.equal(rejectedPending.codexDiagnostics?.rejectedCommandCount, 1);
    const rejectedPid = Number(fs.readFileSync(process.env.FAKE_CODEX_REJECTION_PID, "utf8"));
    assert.equal(await waitForDead(rejectedPid), true);
    assert.equal(fs.existsSync(process.env.FAKE_CODEX_REJECTION_CONTINUED), false);

    process.env.FAKE_CODEX_MODE = "ordinary-command-error";
    const ordinaryCommandError = await callModelResponse("flash", "ordinary fixture", "codex", 5_000);
    assert.equal(ordinaryCommandError.codexDiagnostics?.failedCommandCount, 1);
    assert.equal(ordinaryCommandError.codexDiagnostics?.rejectedCommandCount, 0);
    assert.notEqual(ordinaryCommandError.safetyStopped, true);

    process.env.FAKE_CODEX_MODE = "claimed-refusal";
    const claimedRefusal = await callModelResponse("flash", "ordinary fixture", "codex", 5_000);
    assert.equal(claimedRefusal.codexDiagnostics?.modelReportedRefusal, true);
    assert.equal(claimedRefusal.codexDiagnostics?.rejectedCommandCount, 0);

    process.env.FAKE_CODEX_MODE = "running-error";
    const runningError = await callModelResponse("flash", "ordinary fixture", "codex", 5_000);
    assert.equal(runningError.failureClass, "UnknownOutcome");
    assert.equal(runningError.codexDiagnostics?.runningCommandCount, 1);
    assert.ok(runningError.codexDiagnostics?.manifestPath);

    process.env.FAKE_CODEX_MODE = "sleep";
    const abortController = new AbortController();
    const abortTimer = setTimeout(() => abortController.abort(), 500);
    const cancelledCodex = await callCodexExec("ordinary cancelled fixture", "gpt-6.1-sol", 5_000, { conversationId: "fixture-owner" }, { signal: abortController.signal });
    clearTimeout(abortTimer);
    assert.equal(cancelledCodex.cancelled, true);
    assert.notEqual(cancelledCodex.timedOut, true);
    assert.ok(cancelledCodex.codexDiagnostics?.manifestPath);
    const cancelledManifest = JSON.parse(fs.readFileSync(cancelledCodex.codexDiagnostics!.manifestPath!, "utf8"));
    assert.equal(cancelledManifest.outcome.cancelled, true);
    if (fs.existsSync(childPidMarker)) assert.equal(await waitForDead(Number(fs.readFileSync(childPidMarker, "utf8"))), true);

    process.env.FAKE_CODEX_MODE = "success";
    delete process.env.MEMORY_STORE_AGY_AUTO_ENABLED;
    process.env.FAKE_AGY_MODE = "success";
    resetGrokBridgeAvailabilityForTest();
    grokModelsOk = true;
    grokMode = "success";
    const autoCandidates = await resolveModelChainCandidates("auto");
    assert.equal(autoCandidates[0], "grok", "chain=auto should try Grok first");
    assert.equal(await resolveModelChain("auto"), "grok", "chain=auto should resolve to Grok when available");
    const directGrok = await callGrokExec("hello", "grok-test", 5_000);
    assert.equal(directGrok.text, "fake grok output");
    const grokAuto = await callModelResponse("flash", "hello", "auto", 5_000);
    assert.equal(grokAuto.text, "fake grok output");
    assert.equal(grokAuto.chainUsed, "grok");
    assert.equal(grokAuto.modelUsed, "grok-4.20-0309-non-reasoning");
    assert.equal(lastGrokBody.model, "grok-4.20-0309-non-reasoning");
    assert.equal(lastGrokBody.max_tokens, 800);
    assert.ok(grokCalls >= 1, "fake Grok server should receive chat requests");

    const defaultAutoCandidates = await resolveModelChainCandidates("auto");
    assert.equal(defaultAutoCandidates.includes("agy"), false, "agy must stay out of auto routing until explicitly enabled");

    process.env.MEMORY_STORE_AGY_AUTO_ENABLED = "1";
    const enabledAutoCandidates = await resolveModelChainCandidates("auto", agyBridgeOptions);
    assert.deepEqual(enabledAutoCandidates.slice(0, 2), ["grok", "agy"], "enabled auto routing should try Grok before agy");
    const explicitAgy = await callModelResponse("flash", "hello", "agy", 5_000, agyBridgeOptions);
    assert.equal(explicitAgy.text, "fake agy output", explicitAgy.error);
    assert.equal(explicitAgy.chainUsed, "agy");
    assert.equal(explicitAgy.modelUsed, "Gemini 3.8 Flash (High)");

    process.env.FAKE_AGY_MODE = "fallback";
    const agyInternalFallback = await callModelResponse("flash", "hello", "agy", 5_000, agyBridgeOptions);
    assert.equal(agyInternalFallback.text, "fake agy output");
    assert.equal(agyInternalFallback.chainUsed, "agy");
    assert.equal(agyInternalFallback.modelUsed, "Gemini 3.8 Flash (Medium)");

    process.env.FAKE_AGY_MODE = "fail";
    const explicitAgyFailure = await callModelResponse("flash", "hello", "agy", 5_000, agyBridgeOptions);
    assert.equal(explicitAgyFailure.text, null);
    assert.equal(explicitAgyFailure.chainUsed, null);
    assert.match(explicitAgyFailure.error || "", /agy/u);
    assert.equal(explicitAgyFailure.failureClass, "Availability");
    assert.equal(explicitAgyFailure.retryStrategy, "provider-fallback-exhausted");
    assert.deepEqual(explicitAgyFailure.agyAttempts?.map(attempt => attempt.model), [
        "Gemini 3.8 Flash (High)",
        "Gemini 3.8 Flash (Medium)",
        "Gemini 3.1 Pro (Low)",
    ]);

    process.env.FAKE_AGY_MODE = "sleep";
    const sleepMarker = path.join(tempDir, "fake-agy-sleep-started");
    process.env.FAKE_AGY_SLEEP_MARKER = sleepMarker;
    let cancelAgy = false;
    const cancelledAgyPromise = callModelResponse("flash", "cancel agy", "agy", 5_000, {
        ...agyBridgeOptions,
        shouldCancel: () => cancelAgy,
    });
    for (let attempt = 0; attempt < 250 && !fs.existsSync(sleepMarker); attempt++) {
        await delay(20);
    }
    assert.equal(fs.existsSync(sleepMarker), true, "fake agy CLI must have started before shouldCancel is triggered");
    const cancelStartedAt = Date.now();
    cancelAgy = true;
    const cancelledAgy = await cancelledAgyPromise;
    assert.equal(cancelledAgy.text, null);
    assert.equal(cancelledAgy.cancelled, true);
    assert.equal(cancelledAgy.failureClass, "UnknownOutcome");
    assert.ok(Date.now() - cancelStartedAt < 2_000, "shouldCancel must terminate a running agy CLI without an external AbortSignal");
    delete process.env.FAKE_AGY_SLEEP_MARKER;
    process.env.FAKE_AGY_MODE = "success";

    const grokRecordContext = await callModelResponse("flash", "record", "grok", 5_000, { grokContext: "record" });
    assert.equal(grokRecordContext.chainUsed, "grok");
    assert.equal(grokRecordContext.modelUsed, "grok-4.3");
    assert.equal(lastGrokBody.model, "grok-4.3");
    assert.equal(lastGrokBody.max_tokens, 8192);

    const grokGuardContext = await callModelResponse("flash", "guard", "grok", 5_000, { grokContext: "guard" });
    assert.equal(grokGuardContext.chainUsed, "grok");
    assert.equal(grokGuardContext.modelUsed, "grok-4.5");
    assert.equal(lastGrokBody.model, "grok-4.5");
    assert.equal(lastGrokBody.max_tokens, 4096);

    resetGrokBridgeAvailabilityForTest();
    grokModelsOk = false;
    assert.equal(await resolveModelChain("auto", agyBridgeOptions), "agy", "enabled chain=auto should fall back to agy when Grok is unavailable");
    process.env.MEMORY_STORE_AGY_AUTO_ENABLED = "0";
    assert.equal(await resolveModelChain("auto"), "antigravity", "disabled chain=auto should preserve the Antigravity fallback after Grok is unavailable");

    resetGrokBridgeAvailabilityForTest();
    grokModelsOk = false;
    const grokUnavailable = await callModelResponse("flash", "hello", "grok", 5_000);
    assert.equal(grokUnavailable.text, null);
    assert.equal(grokUnavailable.chainUsed, null);
    assert.match(grokUnavailable.error || "", /Grok/u);

    resetGrokBridgeAvailabilityForTest();
    grokModelsOk = true;
    grokMode = "success";
    const grokExplicit = await callModelResponse("flash", "hello", "grok", 5_000);
    assert.equal(grokExplicit.text, "fake grok output");
    assert.equal(grokExplicit.chainUsed, "grok");
    assert.equal(grokExplicit.modelUsed, "grok-4.20-0309-non-reasoning");

    resetGrokBridgeAvailabilityForTest();
    grokModelsOk = true;
    grokMode = "status-502";
    const grok502 = await callModelResponse("flash", "hello", "auto", 5_000);
    assert.equal(grok502.text, "fake ls output");
    assert.equal(grok502.chainUsed, "antigravity");
    assert.equal(grok502.modelUsed, "flash");

    resetGrokBridgeAvailabilityForTest();
    grokMode = "status-429";
    const grok429 = await callModelResponse("flash", "hello", "auto", 5_000);
    assert.equal(grok429.text, "fake ls output");
    assert.equal(grok429.chainUsed, "antigravity");

    resetGrokBridgeAvailabilityForTest();
    grokMode = "length";
    const grokLengthFallback = await callModelResponse("flash", "hello", "auto", 5_000);
    assert.equal(grokLengthFallback.text, "fake ls output");
    assert.equal(grokLengthFallback.chainUsed, "antigravity");

    resetGrokBridgeAvailabilityForTest();
    grokMode = "length";
    const grokLengthExplicit = await callModelResponse("flash", "hello", "grok", 5_000);
    assert.equal(grokLengthExplicit.text, null);
    assert.equal(grokLengthExplicit.chainUsed, null);
    assert.equal(grokLengthExplicit.failureClass, "Complexity");
    assert.match(grokLengthExplicit.error || "", /截断/u);

    resetGrokBridgeAvailabilityForTest();
    grokMode = "status-502";
    const grok502Explicit = await callModelResponse("flash", "hello", "grok", 5_000);
    assert.equal(grok502Explicit.text, null);
    assert.equal(grok502Explicit.failureClass, "Congestion");

    resetGrokBridgeAvailabilityForTest();
    grokMode = "status-429";
    const grok429Explicit = await callModelResponse("flash", "hello", "grok", 5_000);
    assert.equal(grok429Explicit.text, null);
    assert.equal(grok429Explicit.failureClass, "Congestion");

    resetGrokBridgeAvailabilityForTest();
    grokMode = "delay";
    grokDelayMs = 6_000;
    lastLsBody = null;
    const grokTimeoutFallback = await callModelResponse("flash", "hello", "auto", 5_000);
    assert.equal(grokTimeoutFallback.text, null);
    assert.equal(grokTimeoutFallback.timedOut, true);
    assert.equal(lastLsBody, null, "an exhausted operation deadline must not start another model");

    resetGrokBridgeAvailabilityForTest();
    grokMode = "delay";
    grokDelayMs = 200;
    const grokTimeoutExplicit = await callModelResponse("flash", "hello", "grok", 30);
    assert.equal(grokTimeoutExplicit.text, null);
    assert.equal(grokTimeoutExplicit.chainUsed, null);
    assert.equal(grokTimeoutExplicit.timedOut, true);
    assert.equal(grokTimeoutExplicit.failureClass, "UnknownOutcome");
    assert.match(grokTimeoutExplicit.error || "", /超时/u);

    lsMode = "empty";
    const lsEmpty = await callModelResponse("flash", "hello", "antigravity", 5_000);
    assert.equal(lsEmpty.text, null);
    assert.equal(lsEmpty.failureClass, "Quality");
    assert.match(lsEmpty.error || "", /返回为空/u);

    lsMode = "status-500";
    const lsHttpFailure = await callModelResponse("flash", "hello", "antigravity", 5_000);
    assert.equal(lsHttpFailure.text, null);
    assert.equal(lsHttpFailure.failureClass, "Availability");
    assert.match(lsHttpFailure.error || "", /HTTP 500/u);

    lsMode = "delay";
    lsDelayMs = 200;
    const lsTimeout = await callModelResponse("flash", "hello", "antigravity", 30);
    assert.equal(lsTimeout.text, null);
    assert.equal(lsTimeout.timedOut, true);
    assert.equal(lsTimeout.failureClass, "UnknownOutcome");

    __disableLsForTest();
    const lsUnavailable = await callModelResponse("flash", "hello", "antigravity", 5_000);
    assert.equal(lsUnavailable.text, null);
    assert.equal(lsUnavailable.failureClass, "Availability");
    __setParentLsForTest(null);
    __setParentLsForTest({
        info: { pid: process.pid, csrfToken: "fake-csrf", workspaceId: "fake-ws", ports: [lsAddress.port] },
        port: lsAddress.port,
    });
    lsMode = "success";

    const windsurfModel = await callModelResponse("sonnet", "hello", "windsurf", 5_000);
    assert.equal(windsurfModel.text, null);
    assert.equal(windsurfModel.chainUsed, null);
    assert.match(windsurfModel.error || "", /只支持 dataChain/u);

    process.env.FAKE_CODEX_MODE = "success";
    fs.rmSync(outputPathMarker, { force: true });
    const success = await callCodexExec("hello", "gpt-5.5", 5_000);
    assert.equal(success.text, "fake bridge output");
    assert.equal(success.error, undefined);
    assert.equal(fs.existsSync(readOutputPath()), false, "normal output file should be cleaned");

    process.env.FAKE_CODEX_MODE = "empty";
    fs.rmSync(outputPathMarker, { force: true });
    const empty = await callCodexExec("hello", "gpt-5.5", 5_000);
    assert.equal(empty.text, null);
    assert.match(empty.error || "", /输出为空/u);
    assert.equal(empty.failureClass, "Quality");
    assert.equal(fs.existsSync(readOutputPath()), false, "empty output path should be cleaned");

    const emptyExplicit = await callModelResponse("gpt-5.5", "hello", "codex", 5_000);
    assert.equal(emptyExplicit.text, null);
    assert.equal(emptyExplicit.failureClass, "Quality");

    process.env.FAKE_CODEX_MODE = "directory";
    fs.rmSync(outputPathMarker, { force: true });
    const unreadableOutput = await callCodexExec("hello", "gpt-5.5", 5_000);
    assert.equal(unreadableOutput.text, null);
    assert.equal(unreadableOutput.failureClass, "Availability");
    assert.match(unreadableOutput.error || "", /输出文件读取失败/u);
    fs.rmSync(readOutputPath(), { recursive: true, force: true });

    process.env.FAKE_CODEX_MODE = "error";
    const failed = await callCodexExec("hello", "gpt-5.5", 5_000);
    assert.equal(failed.text, null);
    assert.equal(failed.failureClass, "Availability");
    assert.match(failed.error || "", /fake codex error/u);

    const failedExplicit = await callModelResponse("gpt-5.5", "hello", "codex", 5_000);
    assert.equal(failedExplicit.text, null);
    assert.equal(failedExplicit.failureClass, "Availability");

    process.env.FAKE_CODEX_MODE = "json-error";
    const structuredFailure = await callCodexExec("hello", "flash", 5_000);
    assert.equal(structuredFailure.text, null);
    assert.equal(structuredFailure.failureClass, "Availability");
    assert.match(structuredFailure.error || "", /HTTP 400.*invalid_request_error.*not supported/u);
    assert.doesNotMatch(structuredFailure.error || "", /model-list refresh/u);
    assert.equal(fs.existsSync(readOutputPath()), false);

    process.env.FAKE_CODEX_MODE = "turn-failed";
    const terminalFailure = await callCodexExec("hello", "flash", 5_000);
    assert.match(terminalFailure.error || "", /gpt-retired.*not supported/u);
    assert.doesNotMatch(terminalFailure.error || "", /model-list refresh/u);

    process.env.FAKE_CODEX_MODE = "terminal-metadata";
    const terminalMetadata = await callCodexExec("hello", "flash", 5_000);
    assert.match(terminalMetadata.error || "", /HTTP 429.*rate_limit_error.*not supported/u);

    process.env.FAKE_CODEX_MODE = "sleep";
    fs.rmSync(outputPathMarker, { force: true });
    fs.rmSync(childPidMarker, { force: true });
    const timeout = await callCodexExec("hello", "gpt-5.5", 500);
    assert.equal(timeout.text, null);
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.failureClass, "Availability");
    assert.match(timeout.error || "", /超时/u);

    const childPid = Number(fs.readFileSync(childPidMarker, "utf-8"));
    assert.equal(await waitForDead(childPid), true, "timeout should kill fake Codex child process tree");
} finally {
    __setParentLsForTest(null);
    await resetProviderTransportAdapterForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
    else process.env.MEMORY_STORE_DATA_ROOT = originalDataRoot;
    delete process.env.MEMORY_STORE_GROK_PROXY_URL;
    delete process.env.MEMORY_STORE_GROK_API_KEY;
    delete process.env.MEMORY_STORE_AGY_AUTO_ENABLED;
    delete process.env.MEMORY_STORE_AGY_COMMAND;
    delete process.env.FAKE_CODEX_ARGS_MARKER;
    for (const [name, value] of Object.entries(originalCodexDefaults)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    await new Promise<void>(resolve => grokServer.close(() => resolve()));
    await new Promise<void>(resolve => lsServer.close(() => resolve()));
}
