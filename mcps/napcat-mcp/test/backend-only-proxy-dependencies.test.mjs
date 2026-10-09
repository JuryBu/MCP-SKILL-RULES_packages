import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const updater = fs.readFileSync(new URL("../ops/update-codex-napcat-bridge.ps1", import.meta.url), "utf8");
const windowsOnly = { skip: process.platform !== "win32" };
const fixturePrefix = "napcat-backend-only-dependencies-";
const loadedProxyPaths = [
  "src/codex-app-server-proxy.mjs",
  "src/codex-app-server-proxy-runner.mjs",
  "src/wake-visibility.mjs",
  "src/reasoning-placeholder.mjs",
];
const nextStartProxyPaths = [
  "src/codex-model-stream-proxy.mjs",
  "src/codex-stream-recovery.mjs",
  "src/adaptive-delivery.mjs",
  "src/tool-preparation-deadline.mjs",
  "src/partial-response-progress.mjs",
  "src/tool-delivery-profile.mjs",
  "src/reasoning-progress.mjs",
  "src/codex-model-stream-proxy-runner.mjs",
];
const dependencyPaths = loadedProxyPaths.slice(2);

function extractFunction(name) {
  const match = updater.match(new RegExp(`^function ${name} \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, `missing pure check function: ${name}`);
  return match[0];
}

const compatibilityFunctions = ["Get-NormalizedTextHash", "Assert-BackendOnlyCompatible"]
  .map(extractFunction)
  .join("\n\n");

function write(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function createFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), fixturePrefix));
  context.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith(fixturePrefix));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const previousRoot = path.join(root, "previous");
  const nextRoot = path.join(root, "next");
  for (const codeRoot of [previousRoot, nextRoot]) {
    for (const relativePath of [...loadedProxyPaths, ...nextStartProxyPaths]) {
      write(path.join(codeRoot, relativePath), 'export const fixtureValue = "unchanged";\n');
    }
  }
  return { root, previousRoot, nextRoot };
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runCompatibility(fixture) {
  const command = [
    '$ErrorActionPreference = "Stop"',
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    compatibilityFunctions,
    "try {",
    `  Assert-BackendOnlyCompatible -PreviousRoot ${quotePowerShell(fixture.previousRoot)} -NextRoot ${quotePowerShell(fixture.nextRoot)}`,
    '  [Console]::WriteLine("COMPATIBLE")',
    "  exit 0",
    "} catch {",
    "  [Console]::WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\n");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: fixture.root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function assertCompatible(fixture) {
  const result = runCompatibility(fixture);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.trim(), "COMPATIBLE");
}

function assertRejected(fixture, relativePath, reason) {
  const result = runCompatibility(fixture);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`${reason}: ${relativePath.replaceAll("/", "\\")}`), result.stdout + result.stderr);
}

test("backend-only compatibility accepts unchanged outer proxy modules and dependencies", windowsOnly, (context) => {
  assertCompatible(createFixture(context));
});

test("backend-only compatibility still permits backend and next-start lifecycle script changes", windowsOnly, (context) => {
  const fixture = createFixture(context);
  write(path.join(fixture.nextRoot, "src/index.mjs"), "changed backend\n");
  write(path.join(fixture.nextRoot, "ops/start-codex-app-server-proxy.ps1"), "changed next-start launcher\n");
  assertCompatible(fixture);
});

test("backend-only dependency comparison preserves BOM and newline normalization", windowsOnly, (context) => {
  const fixture = createFixture(context);
  for (const relativePath of dependencyPaths) {
    write(path.join(fixture.nextRoot, relativePath), '\uFEFFexport const fixtureValue = "unchanged";\r\n');
  }
  assertCompatible(fixture);
});

for (const relativePath of loadedProxyPaths) {
  test(`backend-only compatibility rejects a change isolated to ${relativePath}`, windowsOnly, (context) => {
    const fixture = createFixture(context);
    write(path.join(fixture.nextRoot, relativePath), 'export const fixtureValue = "changed";\n');
    assertRejected(fixture, relativePath, "proxy-critical file changed");
  });
}

for (const relativePath of dependencyPaths) {
  for (const rootName of ["previousRoot", "nextRoot"]) {
    test(`backend-only compatibility rejects ${relativePath} missing from ${rootName}`, windowsOnly, (context) => {
      const fixture = createFixture(context);
      fs.unlinkSync(path.join(fixture[rootName], relativePath));
      assertRejected(fixture, relativePath, "proxy-critical file is missing");
    });
  }
}

test("backend-only compatibility rejects a missing installed snapshot", windowsOnly, (context) => {
  const fixture = createFixture(context);
  fixture.previousRoot = path.join(fixture.root, "missing-installed");
  const result = runCompatibility(fixture);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes("requires an existing installed code snapshot"), result.stdout + result.stderr);
});

test("backend-only compatibility still rejects next-start proxy module changes", windowsOnly, (context) => {
  const fixture = createFixture(context);
  const relativePath = nextStartProxyPaths[0];
  write(path.join(fixture.nextRoot, relativePath), "changed next-start proxy\n");
  assertRejected(fixture, relativePath, "next-start proxy file changed");
});

test("backend-only compatibility still rejects a missing next-start proxy module", windowsOnly, (context) => {
  const fixture = createFixture(context);
  const relativePath = nextStartProxyPaths[0];
  fs.unlinkSync(path.join(fixture.nextRoot, relativePath));
  assertRejected(fixture, relativePath, "next-start proxy file is missing");
});
