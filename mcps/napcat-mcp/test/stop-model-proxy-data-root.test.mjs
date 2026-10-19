import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const stopScript = path.join(repositoryRoot, "ops", "stop-codex-model-stream-proxy.ps1");
const runnerScript = path.join(repositoryRoot, "src", "codex-model-stream-proxy-runner.mjs");
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const windowsOnly = { skip: process.platform !== "win32" };

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

function createFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-stop-model-data-root-"));
  const userProfile = path.join(root, "user");
  const brokerRoot = path.join(root, "broker");
  const dataRoot = path.join(root, "state directory");
  const canonicalRoot = path.join(userProfile, ".codex-toolkit", "napcat-mcp");
  const legacyRoot = path.join(brokerRoot, "napcat-mcp");
  const environment = {
    ...process.env,
    USERPROFILE: userProfile,
    CODEX_TOOLKIT_BROKER_ROOT: brokerRoot,
    CODEX_TOOLKIT_NAPCAT_DATA_ROOT: "",
  };
  fs.mkdirSync(userProfile, { recursive: true });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, userProfile, brokerRoot, dataRoot, canonicalRoot, legacyRoot, environment };
}

function writeStoppedRuntime(dataRoot) {
  writeJson(path.join(dataRoot, "state", "codex-model-stream-proxy-runtime.json"), { pid: 2147483647 });
}

async function stopProxy(environment, argumentsList = []) {
  const { stdout } = await execFileAsync(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File", stopScript,
    "-TimeoutSeconds", "10", ...argumentsList,
  ], { env: environment, windowsHide: true, encoding: "utf8", timeout: 15000 });
  return JSON.parse(stdout.trim());
}

function assertNoStopMarkers(fixture) {
  for (const dataRoot of [fixture.dataRoot, fixture.canonicalRoot, fixture.legacyRoot]) {
    assert.equal(fs.existsSync(path.join(dataRoot, "state", "codex-model-stream-proxy.stop")), false);
  }
}

test("model proxy stop keeps both PID identity checks around the drain", () => {
  const source = fs.readFileSync(stopScript, "utf8");
  const identityChecks = [...source.matchAll(/if \(-not \(Test-ExpectedModelStreamProxyProcess /gu)].map((match) => match.index);
  const signalIndex = source.indexOf("Set-Content -LiteralPath $StopPath");
  const forceIndex = source.indexOf("Stop-Process -Id ([int]$Runtime.pid) -Force");
  assert.equal(identityChecks.length, 2);
  assert.ok(identityChecks[0] < signalIndex);
  assert.ok(signalIndex < identityChecks[1] && identityChecks[1] < forceIndex);
  assert.match(source, /\$CommandLine\.IndexOf\(\$ExpectedRunnerPath/u);
  assert.match(source, /\$Remaining\.WaitForExit\(3000\)/u);
});

test("explicit DataRoot wins over environment and broker configuration", windowsOnly, async (context) => {
  const fixture = createFixture(context);
  fixture.environment.CODEX_TOOLKIT_NAPCAT_DATA_ROOT = fixture.legacyRoot;
  writeJson(path.join(fixture.brokerRoot, "broker-private.env.json"), { CODEX_TOOLKIT_NAPCAT_DATA_ROOT: fixture.canonicalRoot });
  writeStoppedRuntime(fixture.dataRoot);
  assert.equal((await stopProxy(fixture.environment, ["-DataRoot", fixture.dataRoot])).reason, "process_not_running");
  assertNoStopMarkers(fixture);
});

test("model proxy stop resolves environment DataRoot with Unicode and spaces", windowsOnly, async (context) => {
  const fixture = createFixture(context);
  fixture.dataRoot = path.join(fixture.root, "状态 目录");
  fixture.environment.CODEX_TOOLKIT_NAPCAT_DATA_ROOT = fixture.dataRoot;
  writeStoppedRuntime(fixture.dataRoot);
  assert.equal((await stopProxy(fixture.environment)).reason, "process_not_running");
  assertNoStopMarkers(fixture);
});

test("model proxy stop uses the broker-private DataRoot", windowsOnly, async (context) => {
  const fixture = createFixture(context);
  writeJson(path.join(fixture.brokerRoot, "broker-private.env.json"), { CODEX_TOOLKIT_NAPCAT_DATA_ROOT: fixture.dataRoot });
  writeStoppedRuntime(fixture.dataRoot);
  assert.equal((await stopProxy(fixture.environment)).reason, "process_not_running");
  assertNoStopMarkers(fixture);
});

test("model proxy stop discovers broker root through the service manifest", windowsOnly, async (context) => {
  const fixture = createFixture(context);
  fixture.environment.CODEX_TOOLKIT_BROKER_ROOT = "";
  writeJson(path.join(fixture.userProfile, ".codex-toolkit", "services", "infrastructure", "service-manifest.json"), {
    broker: { brokerScript: path.join(fixture.brokerRoot, "broker.mjs") },
  });
  writeJson(path.join(fixture.brokerRoot, "broker-private.env.json"), { CODEX_TOOLKIT_NAPCAT_DATA_ROOT: fixture.dataRoot });
  writeStoppedRuntime(fixture.dataRoot);
  assert.equal((await stopProxy(fixture.environment)).reason, "process_not_running");
  assertNoStopMarkers(fixture);
});

test("model proxy stop resolves a single legacy task registry", windowsOnly, async (context) => {
  const fixture = createFixture(context);
  writeJson(path.join(fixture.legacyRoot, "state", "task-registry.json"), {});
  writeStoppedRuntime(fixture.legacyRoot);
  assert.equal((await stopProxy(fixture.environment)).reason, "process_not_running");
  assertNoStopMarkers(fixture);
});

test("model proxy stop preserves the canonical fallback", windowsOnly, async (context) => {
  const fixture = createFixture(context);
  writeStoppedRuntime(fixture.canonicalRoot);
  assert.equal((await stopProxy(fixture.environment)).reason, "process_not_running");
  assertNoStopMarkers(fixture);
});

test("ambiguous task registries refuse to select a stop target", windowsOnly, async (context) => {
  const fixture = createFixture(context);
  for (const dataRoot of [fixture.legacyRoot, fixture.canonicalRoot]) {
    writeJson(path.join(dataRoot, "state", "task-registry.json"), {});
    writeStoppedRuntime(dataRoot);
  }
  await assert.rejects(stopProxy(fixture.environment), /Multiple NapCat task registries/u);
  assertNoStopMarkers(fixture);
});

test("malformed broker-private configuration refuses to fall back silently", windowsOnly, async (context) => {
  const fixture = createFixture(context);
  fs.mkdirSync(fixture.brokerRoot, { recursive: true });
  fs.writeFileSync(path.join(fixture.brokerRoot, "broker-private.env.json"), "{", "utf8");
  writeStoppedRuntime(fixture.canonicalRoot);
  await assert.rejects(stopProxy(fixture.environment), /Unable to read broker-private NapCat DataRoot/u);
  assertNoStopMarkers(fixture);
});

test("resolved DataRoot rejects an unrelated live PID even with Force", windowsOnly, async (context) => {
  const fixture = createFixture(context);
  fixture.environment.CODEX_TOOLKIT_NAPCAT_DATA_ROOT = fixture.dataRoot;
  writeJson(path.join(fixture.dataRoot, "state", "codex-model-stream-proxy-runtime.json"), { pid: process.pid });
  await assert.rejects(stopProxy(fixture.environment, ["-Force"]), /Refusing to stop PID/u);
  assertNoStopMarkers(fixture);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

async function reservePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("resolved DataRoot gracefully stops only an isolated real model proxy runner", windowsOnly, async (context) => {
  const fixture = createFixture(context);
  fixture.environment.CODEX_TOOLKIT_NAPCAT_DATA_ROOT = fixture.dataRoot;
  const stateRoot = path.join(fixture.dataRoot, "state");
  const runtimePath = path.join(stateRoot, "codex-model-stream-proxy-runtime.json");
  fs.mkdirSync(stateRoot, { recursive: true });
  const child = spawn(process.execPath, [runnerScript], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...fixture.environment,
      CODEX_MODEL_STREAM_PROXY_STATE_ROOT: stateRoot,
      CODEX_MODEL_STREAM_PROXY_PORT: String(await reservePort()),
      CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN: "http://127.0.0.1:1",
    },
  });
  let errorOutput = "";
  child.stderr.on("data", (chunk) => { errorOutput += chunk.toString("utf8"); });
  try {
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(runtimePath)) {
      assert.equal(child.exitCode, null, errorOutput);
      assert.ok(Date.now() < deadline, `runner startup timed out: ${errorOutput}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(JSON.parse(fs.readFileSync(runtimePath, "utf8")).pid, child.pid);
    const result = await stopProxy(fixture.environment);
    assert.equal(result.stopped, true);
    assert.equal(result.clean, true);
    assert.equal(result.changed, true);
    assert.equal(result.pid, child.pid);
    assertNoStopMarkers(fixture);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});
