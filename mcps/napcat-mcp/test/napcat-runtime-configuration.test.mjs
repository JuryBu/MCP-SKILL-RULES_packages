import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scriptPath = path.resolve("ops/set-napcat-runtime.ps1");

function runScript(argumentsList) {
  const output = execFileSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    ...argumentsList,
  ], { encoding: "utf8", windowsHide: true });
  return JSON.parse(output.trim());
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-runtime-config-test-"));
  const dataRoot = path.join(root, "data");
  const napcatRoot = path.join(root, "napcat");
  const qqRoot = path.join(root, "qq");
  const qqUserDataDir = path.join(root, "qq-user-data");
  const runtimePath = path.join(dataRoot, "napcat-runtime.json");
  fs.mkdirSync(napcatRoot, { recursive: true });
  fs.mkdirSync(qqRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });

  const signedSource = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const qqExePath = path.join(qqRoot, "QQ.exe");
  fs.copyFileSync(signedSource, qqExePath);
  const version = fs.readFileSync(qqExePath).length > 0
    ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Item -LiteralPath '${qqExePath.replaceAll("'", "''")}').VersionInfo.FileVersion`], { encoding: "utf8", windowsHide: true }).trim()
    : "";
  const match = /^(\d+\.\d+\.\d+)\.(\d+)(?:\s.*)?$/.exec(version);
  assert.ok(match, `test executable must expose a four-part version: ${version}`);
  const mappingKey = `${match[1]}-${match[2]}-x64`;
  fs.writeFileSync(path.join(napcatRoot, "napcat.mjs"), `export const mapping = { "${mappingKey}": {} };\n`, "utf8");
  fs.writeFileSync(path.join(napcatRoot, "NapCatWinBootMain.exe"), "boot", "utf8");
  fs.writeFileSync(path.join(napcatRoot, "NapCatWinBootHook.dll"), "hook", "utf8");
  fs.writeFileSync(runtimePath, `${JSON.stringify({ schemaVersion: 1, napCatRoot: "C:\\old", preserved: "yes" }, null, 2)}\n`, "utf8");
  return {
    root,
    dataRoot,
    napcatRoot,
    qqExePath,
    qqUserDataDir,
    runtimePath,
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test("独立 QQ runtime 可先零写入验证，再原子应用并按原字节回滚", { skip: process.platform !== "win32" }, () => {
  const fixture = createFixture();
  try {
    const originalBytes = fs.readFileSync(fixture.runtimePath);
    const commonArguments = [
      "-DataRoot", fixture.dataRoot,
      "-NapCatRoot", fixture.napcatRoot,
      "-QqExePath", fixture.qqExePath,
      "-QqUserDataDir", fixture.qqUserDataDir,
      "-ExpectedSignerSubject", "Microsoft",
    ];
    const validation = runScript([...commonArguments, "-ValidateOnly"]);
    assert.equal(validation.action, "validate");
    assert.equal(validation.changed, false);
    assert.deepEqual(fs.readFileSync(fixture.runtimePath), originalBytes);

    const applied = runScript(commonArguments);
    assert.equal(applied.action, "apply");
    assert.equal(applied.changed, true);
    assert.equal(fs.existsSync(applied.backupPath), true);
    const runtime = JSON.parse(fs.readFileSync(fixture.runtimePath, "utf8"));
    assert.equal(runtime.napCatRoot, path.resolve(fixture.napcatRoot));
    assert.equal(runtime.qqExePath, path.resolve(fixture.qqExePath));
    assert.equal(runtime.qqUserDataDir, path.resolve(fixture.qqUserDataDir));
    assert.equal(runtime.preserved, "yes");

    fs.rmSync(fixture.runtimePath);

    const rolledBack = runScript([
      "-DataRoot", fixture.dataRoot,
      "-Rollback",
      "-BackupPath", applied.backupPath,
    ]);
    assert.equal(rolledBack.action, "rollback");
    assert.equal(rolledBack.beforeSha256, null);
    assert.deepEqual(fs.readFileSync(fixture.runtimePath), originalBytes);
  } finally {
    fixture.cleanup();
  }
});

test("独立 QQ 数据目录必须使用绝对路径", { skip: process.platform !== "win32" }, () => {
  const fixture = createFixture();
  try {
    assert.throws(() => runScript([
      "-DataRoot", fixture.dataRoot,
      "-NapCatRoot", fixture.napcatRoot,
      "-QqExePath", fixture.qqExePath,
      "-QqUserDataDir", "relative-qq-user-data",
      "-ExpectedSignerSubject", "Microsoft",
      "-ValidateOnly",
    ]), /QqUserDataDir/);
  } finally {
    fixture.cleanup();
  }
});

test("独立 QQ 版本没有精确 PacketBackend 映射时拒绝写入", { skip: process.platform !== "win32" }, () => {
  const fixture = createFixture();
  try {
    const originalBytes = fs.readFileSync(fixture.runtimePath);
    fs.writeFileSync(path.join(fixture.napcatRoot, "napcat.mjs"), "export const mapping = {};\n", "utf8");
    assert.throws(() => runScript([
      "-DataRoot", fixture.dataRoot,
      "-NapCatRoot", fixture.napcatRoot,
      "-QqExePath", fixture.qqExePath,
      "-ExpectedSignerSubject", "Microsoft",
      "-ValidateOnly",
    ]), /PacketBackend/);
    assert.deepEqual(fs.readFileSync(fixture.runtimePath), originalBytes);
  } finally {
    fixture.cleanup();
  }
});
