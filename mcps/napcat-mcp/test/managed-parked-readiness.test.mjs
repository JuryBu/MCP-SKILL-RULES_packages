import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { windowsPowerShellEnvironment } from "../src/windows-powershell-environment.mjs";

test("managed readiness verifies a parked parent's live identity without claiming model health", { skip: process.platform !== "win32", timeout: 45000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parked-readiness-owned-"));
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  try {
    const ops = path.join(root, "ops");
    const state = path.join(root, "state");
    fs.mkdirSync(ops); fs.mkdirSync(state);
    for (const name of ["get-codex-model-stream-proxy-status.ps1", "get-codex-app-server-proxy-status.ps1"]) {
      fs.copyFileSync(fileURLToPath(new URL(`../ops/${name}`, import.meta.url)), path.join(ops, name));
    }
    fs.writeFileSync(path.join(ops, "resolve-napcat-data-root.ps1"), "function Resolve-NapCatDataRoot {param($ExplicitDataRoot,$BrokerRoot) $ExplicitDataRoot}");
    fs.writeFileSync(path.join(ops, "resolve-codex-outer-runtime-startup.ps1"), `function Resolve-CodexOuterRuntimeStartup {param($DataRoot) @{innerManagedProfilePath=(Join-Path $DataRoot 'profile.json');innerManagedProfileSha256='fixture'}}
function Get-CodexInnerManagedStartupProfile {param($Startup,$DataRoot) Get-Content (Join-Path $DataRoot 'profile.json') -Raw | ConvertFrom-Json}
function Assert-CodexStartupPathWithoutReparsePoint {param($Path)}`);
    const instance = crypto.randomUUID();
    const tokenFile = path.join(state, "codex-app-server-proxy-token.txt");
    fs.writeFileSync(tokenFile, "isolated-token");
    const managed = { schemaVersion: 1, ownerId: "fixture", nativeSourceId: "native", pid: 98765, instanceToken: instance,
      front: { pid: 98765, host: "127.0.0.1", port: 31001 }, livenessAt: new Date().toISOString(), state: "running", coordinator: { defaultWorkerId: "worker-1" } };
    const outer = { pid: 98765, instanceToken: instance, state: "waiting_for_desktop", waitingForDesktop: true, appServerPid: null,
      livenessAt: new Date().toISOString(), downstreamUrl: "ws://127.0.0.1:31002", controlUrl: "http://127.0.0.1:31003/v1" };
    fs.writeFileSync(path.join(root, "profile.json"), JSON.stringify({ ownerId: "fixture", nativeSourceId: "native", managedStatePath: path.join(state, "managed.json"),
      ports: { inner: 31001, control: 31003 }, outerPaths: { tokenFilePath: tokenFile }, controlTokenSha256: crypto.createHash("sha256").update("isolated-token").digest("hex") }));
    fs.writeFileSync(path.join(state, "codex-app-server-proxy.lock"), JSON.stringify({ pid: 98765, token: instance }));
    const runnerPath = path.join(root, "src", "codex-app-server-proxy-runner.mjs");
    const command = `"${runnerPath}" "--inner-managed-profile" "${path.join(root, "profile.json")}" "--instance-token" "${instance}" "${path.join(state, "codex-app-server-proxy-runtime.json")}" "${path.join(state, "codex-app-server-proxy.lock")}"`;
    const harness = `param([string]$Case)
function Get-Process {param($Id,$ErrorAction) @{Id=98765}}
function Get-CimInstance {param($ClassName,$Filter,$ErrorAction) @{CommandLine=${quote(command)}}}
function Get-NetTCPConnection {param($State,$LocalPort,$ErrorAction) if($Case -ne 'wrong-port') { [pscustomobject]@{LocalAddress='127.0.0.1';OwningProcess=98765} }}
function Invoke-RestMethod {param($Uri,$Method,$Headers,$TimeoutSec)
 if($Uri -like '*/inner/status') {throw 'parked'}
 if($Case -eq 'control-unavailable') {throw 'unavailable'}
 $identity=${quote(instance)};if($Case -eq 'wrong-instance'){$identity='other'}
 [pscustomobject]@{closed=($Case -eq 'closed');outerRuntime=@{instanceId=$identity}}
}
& ${quote(path.join(ops, "get-codex-model-stream-proxy-status.ps1"))} -DataRoot ${quote(root)}`;
    const harnessPath = path.join(root, "check.ps1");
    fs.writeFileSync(harnessPath, "\uFEFF" + harness);
    const shell = windowsPowerShellEnvironment();
    for (const scenario of ["parked", "wrong-instance", "wrong-port", "control-unavailable", "closed", "stale", "not-parked", "bad-token"]) {
      fs.writeFileSync(path.join(state, "managed.json"), JSON.stringify({ ...managed, livenessAt: new Date().toISOString() }));
      fs.writeFileSync(path.join(state, "codex-app-server-proxy-runtime.json"), JSON.stringify({ ...outer,
        state: scenario === "not-parked" ? "running" : outer.state,
        livenessAt: new Date(Date.now() - (scenario === "stale" ? 60000 : 0)).toISOString() }));
      fs.writeFileSync(tokenFile, scenario === "bad-token" ? "changed" : "isolated-token");
      const run = spawnSync(process.env.NAPCAT_TEST_POWERSHELL ?? shell.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", harnessPath, scenario],
        { env: shell.environment, encoding: "utf8", windowsHide: true, timeout: 7000 });
      assert.equal(run.status, 0, run.stderr);
      const status = JSON.parse(run.stdout.replace(/^\uFEFF/u, ""));
      assert.equal(status.healthy, false, scenario);
      assert.equal(status.readyForDesktop, scenario === "parked", scenario);
    }
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
