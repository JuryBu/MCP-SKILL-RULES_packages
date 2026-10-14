import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createTrainingTemporaryDirectory } from "./training-temporary-directory.mjs";
import { acquireInstanceLock, runCodexAppServerProxyService } from "../src/codex-app-server-proxy-runner.mjs";
import { validateOpenAiSignatures } from "../src/codex-runtime-bundle.mjs";
import { windowsPowerShellEnvironment } from "../src/windows-powershell-environment.mjs";

function withFixture(action) {
  const root = createTrainingTemporaryDirectory(path.join(os.tmpdir(), "training-a422-guard-"));
  const lockPath = path.join(root, "existing.lock");
  const runtimePath = path.join(root, "existing-runtime.json");
  const metadata = { pid: process.pid, token: crypto.randomUUID(), startedAt: new Date().toISOString() };
  const lockBytes = Buffer.from(JSON.stringify(metadata) + "\n");
  const runtimeBytes = Buffer.from(JSON.stringify({ ...metadata, instanceToken: metadata.token, state: "running" }) + "\n");
  fs.writeFileSync(lockPath, lockBytes, { flag: "wx" });
  fs.writeFileSync(runtimePath, runtimeBytes, { flag: "wx" });
  try {
    return action({ root, lockPath, runtimePath, metadata, lockBytes, runtimeBytes });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("WinPS child module path is canonical and parent environment stays unchanged", () => {
  const parent = { SystemRoot: "C:\\Windows", PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules", psmodulepath: "C:\\untrusted-ps7", TASK_OWNER: "fixture" };
  const before = JSON.stringify(parent);
  const child = windowsPowerShellEnvironment(parent);
  assert.equal(child.executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(child.environment.PSModulePath, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules");
  assert.equal(Object.hasOwn(child.environment, "psmodulepath"), false);
  assert.equal(child.environment.TASK_OWNER, "fixture");
  assert.equal(JSON.stringify(parent), before);
});

test("native WinPS Security and CIM load under PS7 inheritance with UTF8 output", { skip: process.platform !== "win32" }, () => {
  const inherited = { ...process.env, PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules" };
  const child = windowsPowerShellEnvironment(inherited);
  const security = path.win32.join(child.modulesPath, "Microsoft.PowerShell.Security", "Microsoft.PowerShell.Security.psd1").replaceAll("'", "''");
  const script = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);Import-Module '" + security + "' -ErrorAction Stop;$row=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$PID) -ErrorAction Stop;[pscustomobject]@{version=$PSVersionTable.PSVersion.ToString();security=(Get-Command Get-AuthenticodeSignature).ModuleName;pid=$row.ProcessId;text='中文含空格'}|ConvertTo-Json -Compress";
  const result = spawnSync(child.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { env: child.environment, encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout.trim());
  assert.match(actual.version, /^5\.1\./u);
  assert.equal(actual.security, "Microsoft.PowerShell.Security");
  assert.ok(actual.pid > 0);
  assert.equal(actual.text, "中文含空格");
  console.log(JSON.stringify({ nativeChild: actual, parentModulePath: process.env.PSModulePath, canonicalChildModulePath: child.modulesPath }));
});

test("unsigned executable remains rejected by the unchanged OpenAI signer requirement", { skip: process.platform !== "win32" }, async () => {
  const root = createTrainingTemporaryDirectory(path.join(os.tmpdir(), "training-a422-signature-"));
  fs.writeFileSync(path.join(root, "unsigned.exe"), "owned unsigned fixture\n", { flag: "wx" });
  try {
    await assert.rejects(validateOpenAiSignatures(root, [{ name: "unsigned.exe" }]), /Invalid OpenAI signature/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const [label, check] of [
  ["null", () => null],
  ["unknown", () => "unknown"],
  ["query exception", () => { throw new Error("owned fixture CIM unavailable"); }],
]) {
  test("live owner with " + label + " keeps exact runtime and lock bytes", () => {
    withFixture(({ root, lockPath, runtimePath, lockBytes, runtimeBytes }) => {
      const result = acquireInstanceLock(lockPath, { validateExistingProcess: check, validateExistingLock: () => false });
      assert.equal(result.acquired, false);
      assert.equal(result.identityUnknown, true);
      assert.deepEqual(fs.readFileSync(lockPath), lockBytes);
      assert.deepEqual(fs.readFileSync(runtimePath), runtimeBytes);
      assert.deepEqual(fs.readdirSync(root).sort(), ["existing-runtime.json", "existing.lock"]);
    });
  });
}

test("live owner with lock validation exception also remains untouched", () => {
  withFixture(({ root, lockPath, runtimePath, lockBytes, runtimeBytes }) => {
    const result = acquireInstanceLock(lockPath, { validateExistingProcess: () => true, validateExistingLock: () => { throw new Error("owned read failure"); } });
    assert.equal(result.acquired, false);
    assert.equal(result.identityUnknown, true);
    assert.deepEqual(fs.readFileSync(lockPath), lockBytes);
    assert.deepEqual(fs.readFileSync(runtimePath), runtimeBytes);
    assert.deepEqual(fs.readdirSync(root).sort(), ["existing-runtime.json", "existing.lock"]);
  });
});

test("explicit verified identity mismatch keeps the existing reclamation branch", () => {
  withFixture(({ root, lockPath, runtimePath, lockBytes, runtimeBytes }) => {
    const result = acquireInstanceLock(lockPath, { validateExistingProcess: () => false });
    assert.equal(result.acquired, true);
    assert.deepEqual(fs.readFileSync(runtimePath), runtimeBytes);
    const archived = fs.readdirSync(root).filter(name => name.startsWith("existing.lock.stale-"));
    assert.equal(archived.length, 1);
    assert.deepEqual(fs.readFileSync(path.join(root, archived[0])), lockBytes);
    result.release();
  });
});

for (const [label, query] of [
  ["null", () => null],
  ["blank", () => ""],
  ["exception", () => { throw new Error("owned CIM query failure"); }],
]) {
  test("service returns explicit UNKNOWN without publishing new runtime for " + label, async () => {
    const root = createTrainingTemporaryDirectory(path.join(os.tmpdir(), "training-a422-service-"));
    const lockPath = path.join(root, "owned.lock");
    const runtimeStatePath = path.join(root, "owned-runtime.json");
    const metadata = { pid: process.pid, token: crypto.randomUUID(), startedAt: new Date().toISOString() };
    const lockBytes = Buffer.from(JSON.stringify(metadata));
    const runtimeBytes = Buffer.from(JSON.stringify({ pid: metadata.pid, instanceToken: metadata.token, startedAt: metadata.startedAt, state: "running" }));
    fs.writeFileSync(lockPath, lockBytes, { flag: "wx" });
    fs.writeFileSync(runtimeStatePath, runtimeBytes, { flag: "wx" });
    try {
      const result = await runCodexAppServerProxyService({ lockPath, runtimeStatePath, stopFilePath: path.join(root, "absent.stop"), processCommandLine: query });
      assert.equal(result.state, "failed");
      assert.equal(result.error.code, "EXISTING_PROCESS_IDENTITY_UNKNOWN");
      assert.deepEqual(fs.readFileSync(lockPath), lockBytes);
      assert.deepEqual(fs.readFileSync(runtimeStatePath), runtimeBytes);
      assert.deepEqual(fs.readdirSync(root).sort(), ["owned-runtime.json", "owned.lock"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
