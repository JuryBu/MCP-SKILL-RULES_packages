import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-bridge-stderr-"));
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/codex-stderr-policy-rejection.json", import.meta.url), "utf8"));
const fakeScript = path.join(root, "fake-codex.cjs");
const fakeCommand = path.join(root, process.platform === "win32" ? "fake-codex.cmd" : "fake-codex");
const callsMarker = path.join(root, "calls.txt");
const continuationMarker = path.join(root, "continued.txt");
const pidMarker = path.join(root, "pids.json");
const outputMarker = path.join(root, "output-path.txt");
const originalEnvironment = { ...process.env };
const originalFetch = globalThis.fetch;
const networkAttempts: string[] = [];
const ownedPids = new Set<number>();
Object.assign(process.env, {
    MEMORY_STORE_DATA_ROOT: path.join(root, "data"), MEMORY_STORE_AUTO_RECORD: "0",
    MEMORY_STORE_CODEX_COMMAND: fakeCommand, MEMORY_STORE_CODEX_KILL_TIMEOUT: "2000",
    MEMORY_STORE_CODEX_OUTPUT_KILL_TIMEOUT: "2000", FIXTURE_CALLS_MARKER: callsMarker,
    MEMORY_STORE_GROK_PROXY_URL: "http://127.0.0.1:1/fixture-only", MEMORY_STORE_GROK_API_KEY: "fixture-only",
    FIXTURE_CONTINUATION_MARKER: continuationMarker, FIXTURE_PID_MARKER: pidMarker, FIXTURE_OUTPUT_MARKER: outputMarker,
});
globalThis.fetch = async input => {
    networkAttempts.push(String(input));
    throw new Error("offline Codex fixture forbids HTTP requests");
};
fs.writeFileSync(fakeScript, `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const fixture = ${JSON.stringify(fixture)};
if (process.argv.includes("--version")) { console.log("fixture-codex 0.0.0"); process.exit(0); }
fs.appendFileSync(process.env.FIXTURE_CALLS_MARKER, "fixture invocation\\n");
const output = process.argv[process.argv.indexOf("-o") + 1];
fs.writeFileSync(process.env.FIXTURE_OUTPUT_MARKER, output);
fs.writeFileSync(output, "PASS\\nfixture retained output");
for (const event of fixture.stdout) console.log(JSON.stringify(event));
const mode = process.env.FIXTURE_CODEX_MODE;
if (mode === "pending") {
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    fs.writeFileSync(process.env.FIXTURE_PID_MARKER, JSON.stringify([process.pid, descendant.pid]));
    process.stderr.write(fixture.stderr[0] + "\\n");
    const bytes = Buffer.from(fixture.stderr[1] + "\\r\\n");
    const boundary = bytes.indexOf(Buffer.from("中")) + 1;
    process.stderr.write(bytes.subarray(0, boundary));
    setTimeout(() => process.stderr.write(bytes.subarray(boundary)), 30);
    setTimeout(() => fs.writeFileSync(process.env.FIXTURE_CONTINUATION_MARKER, "unexpected continuation"), 2500);
    setInterval(() => {}, 1000);
} else if (mode === "tail") {
    process.stderr.write(fixture.stderr[1], () => process.exit(0));
} else {
    process.stderr.write(JSON.stringify(fixture.stderr[1]) + "\\nExample: " + fixture.stderr[1] + "\\n" + fixture.stderr[0] + "\\n");
}
`, "utf8");
fs.writeFileSync(fakeCommand, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.cjs" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, { encoding: "utf8", mode: 0o700 });

const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
};
const waitForDead = async (pid: number) => {
    for (let attempt = 0; attempt < 30 && alive(pid); attempt++) await delay(50);
    return !alive(pid);
};

try {
    const { callCodexExec, callModelResponse } = await import("../src/model-bridge.js");
    process.env.FIXTURE_CODEX_MODE = "pending";
    const started = performance.now();
    const stopped = await callModelResponse("fixture-model", "inert fixture input", "codex", 8000, { preResolvedCandidate: "codex" });
    const elapsedMs = Math.round(performance.now() - started);
    assert.equal(stopped.safetyStopped, true);
    assert.equal(stopped.failureClass, "DeterministicInput");
    assert.equal(stopped.timedOut, false);
    assert.equal(stopped.cancelled, false);
    assert.match(stopped.error || "", /明确拒绝/u);
    assert.equal(stopped.codexDiagnostics?.rejectedCommandCount, 1);
    assert.equal(stopped.codexDiagnostics?.stderrRejectedCommandCount, 1);
    assert.equal(stopped.codexDiagnostics?.eventCount, 5);
    assert.equal(stopped.codexDiagnostics?.commandCount, 1);
    assert.equal(stopped.codexDiagnostics?.eventCoverage, "partial");
    assert.ok(elapsedMs < 6500, `refusal must stop before the 8000ms deadline; observed ${elapsedMs}ms`);
    const pids: number[] = JSON.parse(fs.readFileSync(pidMarker, "utf8"));
    for (const pid of pids) ownedPids.add(pid);
    for (const pid of pids) assert.equal(await waitForDead(pid), true, `fixture process ${pid} must be dead before return`);
    assert.equal(fs.existsSync(continuationMarker), false);
    assert.equal(fs.readFileSync(callsMarker, "utf8").trim().split("\n").length, 1, "a refusal must never be resubmitted");
    assert.equal(fs.existsSync(fs.readFileSync(outputMarker, "utf8")), false);
    const manifest = JSON.parse(fs.readFileSync(stopped.codexDiagnostics!.manifestPath!, "utf8"));
    assert.equal(manifest.outcome.timedOut, false);
    assert.equal(manifest.stderrRejections[0].executionObserved, false);
    assert.equal(manifest.stderrRejections[0].lineNumber, 2);
    assert.ok(manifest.outcome.killTree);

    process.env.FIXTURE_CODEX_MODE = "tail";
    const tail = await callCodexExec("inert fixture input", "fixture-model", 8000);
    assert.equal(tail.safetyStopped, true);
    assert.equal(tail.failureClass, "DeterministicInput");
    assert.match(tail.error || "", /明确拒绝/u);
    assert.equal(tail.codexDiagnostics?.stderrRejectedCommandCount, 1);
    assert.equal(tail.codexDiagnostics?.eventCoverage, "partial");

    process.env.FIXTURE_CODEX_MODE = "negative";
    const ordinary = await callCodexExec("inert fixture input", "fixture-model", 8000);
    assert.match(ordinary.text || "", /^PASS/u);
    assert.equal(ordinary.error, undefined);
    assert.notEqual(ordinary.safetyStopped, true);
    assert.equal(ordinary.codexDiagnostics?.rejectedCommandCount, 0);
    assert.equal(ordinary.codexDiagnostics?.stderrRejectedCommandCount, 0);
    assert.equal(ordinary.codexDiagnostics?.eventCoverage, "complete");
    assert.equal(fs.readFileSync(callsMarker, "utf8").trim().split("\n").length, 3);

    const bridgeSource = fs.readFileSync(new URL("../src/model-bridge.ts", import.meta.url), "utf8");
    assert.equal(bridgeSource.match(/available\(\(\) => isGrokBridgeAvailable\(scopedOptions\)\)/gu)?.length, 2);
    assert.deepEqual(networkAttempts, [], "offline Codex fixtures must not query any actual model directory or provider");
    console.log(`model-bridge-codex-stderr: PASS early stop ${elapsedMs}ms < 8000ms; 2 fixture processes dead; one submission; no continuation; tail/quoted/network controls; both scoped Grok probes; HTTP attempts=0`);
} finally {
    if (fs.existsSync(pidMarker)) for (const pid of JSON.parse(fs.readFileSync(pidMarker, "utf8")) as number[]) ownedPids.add(pid);
    for (const pid of ownedPids) {
        if (alive(pid)) try { process.kill(pid); } catch {}
    }
    for (const name of Object.keys(process.env)) if (!(name in originalEnvironment)) delete process.env[name];
    Object.assign(process.env, originalEnvironment);
    globalThis.fetch = originalFetch;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
}
