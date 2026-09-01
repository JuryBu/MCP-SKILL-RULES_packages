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

function createNodeFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-node-runtime-config-test-"));
  const dataRoot = path.join(root, "data");
  const napcatRoot = path.join(root, "node-runtime");
  const qqUserDataDir = path.join(root, "qq-user-data");
  const runtimePath = path.join(dataRoot, "napcat-runtime.json");
  fs.mkdirSync(napcatRoot, { recursive: true });
  fs.mkdirSync(path.join(napcatRoot, "napcat"), { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(napcatRoot, "launcher-user.bat"), "@echo off\nnode.exe index.js -q %1\n", "utf8");
  fs.writeFileSync(path.join(napcatRoot, "napcat.bat"), "@echo off\nnode.exe index.js\n", "utf8");
  fs.writeFileSync(path.join(napcatRoot, "node.exe"), "node", "utf8");
  fs.writeFileSync(path.join(napcatRoot, "index.js"), "import('./napcat.mjs')\n", "utf8");
  fs.writeFileSync(path.join(napcatRoot, "package.json"), `${JSON.stringify({ version: "9.9.32-50969" }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(napcatRoot, "config.json"), `${JSON.stringify({ curVersion: "9.9.32-50969" }, null, 2)}\n`, "utf8");
  const nodeModuleSource = [
    'export const mapping = { "9.9.32-50969-x64": {} };',
    "class QQPaths {",
    "  get dataPath() {",
    "    let e = this.context.wrapper.NodeQQNTWrapperUtil.getNTUserDataInfoConfig();",
    "    return e || (e = Ps.join(Dn.homedir(), \".config\", \"QQ\"), Fs.existsSync(e) || Fs.mkdirSync(e, { recursive: !0 }), e);",
    "  }",
    "}",
    "function zEe(t) {",
    "  if (Dn.platform() === \"darwin\") {",
    "    const r = Dn.homedir(), i = be.resolve(r, \"./Library/Application Support/QQ\");",
    "    return [i, be.join(i, \"global\")];",
    "  }",
    "  let e = t.NodeQQNTWrapperUtil.getNTUserDataInfoConfig();",
    "  e || (e = be.resolve(Dn.homedir(), \"./.config/QQ\"), de.mkdirSync(e, { recursive: !0 }));",
    "  const n = be.resolve(e, \"./nt_qq/global\");",
    "  return [e, n];",
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(napcatRoot, "napcat.mjs"), options.duplicateTopLevelModule
    ? nodeModuleSource
    : "throw new Error('top-level shim should not be validated for node runtime');\n", "utf8");
  fs.writeFileSync(path.join(napcatRoot, "napcat", "napcat.mjs"), nodeModuleSource, "utf8");
  fs.writeFileSync(runtimePath, `${JSON.stringify({ schemaVersion: 1, napCatRoot: "C:\\old", qqExePath: "C:\\old\\QQ.exe", preserved: "yes" }, null, 2)}\n`, "utf8");
  return {
    root,
    dataRoot,
    napcatRoot,
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
      "-MinimumQqBuild", "0",
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

test("NapCat node runtime 会同时补丁顶层和嵌套真实模块，并可原字节回滚", { skip: process.platform !== "win32" }, () => {
  const fixture = createNodeFixture({ duplicateTopLevelModule: true });
  try {
    const topLevelModulePath = path.join(fixture.napcatRoot, "napcat.mjs");
    const nestedModulePath = path.join(fixture.napcatRoot, "napcat", "napcat.mjs");
    const originalTopLevelModule = fs.readFileSync(topLevelModulePath);
    const originalNestedModule = fs.readFileSync(nestedModulePath);
    const originalRuntime = fs.readFileSync(fixture.runtimePath);
    const commonArguments = [
      "-DataRoot", fixture.dataRoot,
      "-NapCatRoot", fixture.napcatRoot,
      "-QqUserDataDir", fixture.qqUserDataDir,
    ];

    const validation = runScript([...commonArguments, "-ValidateOnly"]);
    assert.equal(validation.nodeUserDataPatch.modules.length, 2);
    assert.equal(validation.nodeUserDataPatch.modules.every((item) => item.wouldChange), true);

    const applied = runScript(commonArguments);
    assert.equal(applied.nodeUserDataPatch.changed, true);
    assert.equal(applied.nodeUserDataPatch.modules.length, 2);
    assert.equal(applied.nodeUserDataPatch.modules.every((item) => item.changed), true);
    assert.equal(fs.existsSync(applied.nodeUserDataPatch.rollbackManifestPath), true);
    for (const modulePath of [topLevelModulePath, nestedModulePath]) {
      const patched = fs.readFileSync(modulePath, "utf8");
      assert.equal((patched.match(/NAPCAT_QQ_USER_DATA_DIR/g) ?? []).length, 2);
      assert.match(patched, /function zEe\(t\)[\s\S]{0,1200}NAPCAT_QQ_USER_DATA_DIR/);
    }

    const rolledBack = runScript([
      "-DataRoot", fixture.dataRoot,
      "-Rollback",
      "-BackupPath", applied.backupPath,
    ]);
    assert.equal(rolledBack.action, "rollback");
    assert.equal(rolledBack.moduleRollbacks.length, 2);
    assert.deepEqual(fs.readFileSync(fixture.runtimePath), originalRuntime);
    assert.deepEqual(fs.readFileSync(topLevelModulePath), originalTopLevelModule);
    assert.deepEqual(fs.readFileSync(nestedModulePath), originalNestedModule);
  } finally {
    fixture.cleanup();
  }
});

test("NapCat node runtime 不需要 QQ.exe，应用时会清除旧 qqExePath", { skip: process.platform !== "win32" }, () => {
  const fixture = createNodeFixture();
  try {
    const napcatModulePath = path.join(fixture.napcatRoot, "napcat", "napcat.mjs");
    const originalModule = fs.readFileSync(napcatModulePath, "utf8");
    const commonArguments = [
      "-DataRoot", fixture.dataRoot,
      "-NapCatRoot", fixture.napcatRoot,
      "-QqUserDataDir", fixture.qqUserDataDir,
    ];
    const validation = runScript([...commonArguments, "-ValidateOnly"]);
    assert.equal(validation.action, "validate");
    assert.equal(validation.qqExePath, null);
    assert.equal(validation.qqVersion, "9.9.32-50969");
    assert.equal(validation.packetMappingKey, "9.9.32-50969-x64");
    assert.equal(validation.nodeUserDataPatch.enabled, true);
    assert.equal(validation.nodeUserDataPatch.wouldChange, true);
    assert.equal(validation.nodeUserDataPatch.dataPathPatched, true);
    assert.equal(validation.nodeUserDataPatch.startupPatched, true);
    assert.equal(fs.readFileSync(napcatModulePath, "utf8"), originalModule);

    const applied = runScript(commonArguments);
    assert.equal(applied.action, "apply");
    assert.equal(applied.nodeUserDataPatch.changed, true);
    assert.equal(applied.nodeUserDataPatch.wouldChange, false);
    assert.equal(fs.existsSync(applied.nodeUserDataPatch.backupPath), true);
    const runtime = JSON.parse(fs.readFileSync(fixture.runtimePath, "utf8"));
    assert.equal(runtime.napCatRoot, path.resolve(fixture.napcatRoot));
    assert.equal(runtime.qqExePath, undefined);
    assert.equal(runtime.qqUserDataDir, path.resolve(fixture.qqUserDataDir));
    assert.equal(runtime.preserved, "yes");
    const patchedModule = fs.readFileSync(napcatModulePath, "utf8");
    assert.equal((patchedModule.match(/NAPCAT_QQ_USER_DATA_DIR/g) ?? []).length, 2);
    assert.match(patchedModule, /get dataPath\(\)[\s\S]{0,800}NAPCAT_QQ_USER_DATA_DIR/);
    assert.match(patchedModule, /function zEe\(t\)[\s\S]{0,1200}NAPCAT_QQ_USER_DATA_DIR/);

    const reapplied = runScript(commonArguments);
    assert.equal(reapplied.nodeUserDataPatch.changed, false);
    assert.equal(reapplied.nodeUserDataPatch.wouldChange, false);
  } finally {
    fixture.cleanup();
  }
});

test("NapCat node runtime 配置独立数据目录时拒绝不可补丁的包", { skip: process.platform !== "win32" }, () => {
  const fixture = createNodeFixture();
  try {
    fs.writeFileSync(path.join(fixture.napcatRoot, "napcat", "napcat.mjs"), 'export const mapping = { "9.9.32-50969-x64": {} };\n', "utf8");
    assert.throws(() => runScript([
      "-DataRoot", fixture.dataRoot,
      "-NapCatRoot", fixture.napcatRoot,
      "-QqUserDataDir", fixture.qqUserDataDir,
      "-ValidateOnly",
    ]));
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
      "-MinimumQqBuild", "0",
      "-ValidateOnly",
    ]), /PacketBackend/);
    assert.deepEqual(fs.readFileSync(fixture.runtimePath), originalBytes);
  } finally {
    fixture.cleanup();
  }
});

test("独立 QQ 版本低于官方最低支持 build 时拒绝写入", { skip: process.platform !== "win32" }, () => {
  const fixture = createFixture();
  try {
    const originalBytes = fs.readFileSync(fixture.runtimePath);
    assert.throws(() => runScript([
      "-DataRoot", fixture.dataRoot,
      "-NapCatRoot", fixture.napcatRoot,
      "-QqExePath", fixture.qqExePath,
      "-ExpectedSignerSubject", "Microsoft",
      "-MinimumQqBuild", "999999",
      "-ValidateOnly",
    ]), /minimum=999999/);
    assert.deepEqual(fs.readFileSync(fixture.runtimePath), originalBytes);
  } finally {
    fixture.cleanup();
  }
});
