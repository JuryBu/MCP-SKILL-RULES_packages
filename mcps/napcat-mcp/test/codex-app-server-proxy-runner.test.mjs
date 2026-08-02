import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import {
  acquireInstanceLock,
  parseArguments,
  runCodexAppServerProxyService,
} from "../src/codex-app-server-proxy-runner.mjs";

const execFileAsync = promisify(execFile);

function runtimePaths(root) {
  return {
    runtimeStatePath: path.join(root, "proxy-runtime.json"),
    logPath: path.join(root, "proxy.jsonl"),
    stopFilePath: path.join(root, "proxy.stop"),
    lockPath: path.join(root, "proxy.lock"),
    journalPath: path.join(root, "wake-journal.json"),
    tokenFilePath: path.join(root, "proxy-token.txt"),
    maintenanceFilePath: path.join(root, "task-router.maintenance.json"),
    alertFilePath: path.join(root, "proxy-alert.json"),
    fallbackFilePath: path.join(root, "proxy-fallback.json"),
    downstreamPort: 18452,
    controlPort: 18451,
    upstreamPort: 18453,
    probePort: 18454,
    startTimeoutMs: 1000,
    requestTimeoutMs: 1000,
  };
}

function createProxyStub() {
  return {
    startedAt: null,
    async start() {
      this.startedAt = new Date().toISOString();
    },
    async close() {},
    status() {
      return { state: "running" };
    },
  };
}

function createChildThatRequiresForceVerification(onForceKill = () => {}) {
  const child = new EventEmitter();
  child.pid = 43210;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    if (signal === "SIGKILL") onForceKill(child);
    return true;
  };
  return child;
}

function createStoppingServiceOptions(paths, child, terminateChild) {
  return {
    ...paths,
    executablePath: process.execPath,
    pid: process.pid,
    probeExecutable: async () => {},
    createProxy: createProxyStub,
    spawnAppServer: () => ({ child, stderr: () => "" }),
    waitForWebSocketReady: async () => {
      fs.writeFileSync(paths.stopFilePath, "stop\n", "utf8");
    },
    ...(terminateChild ? { terminateChild } : {}),
    verifyPortReleased: async () => true,
  };
}

test("parseArguments requires all durable state paths", () => {
  const root = path.resolve("test-root");
  const parsed = parseArguments([
    "--runtime-state", path.join(root, "runtime.json"),
    "--log", path.join(root, "proxy.jsonl"),
    "--stop-file", path.join(root, "proxy.stop"),
    "--lock", path.join(root, "proxy.lock"),
    "--journal", path.join(root, "journal.json"),
    "--token-file", path.join(root, "token.txt"),
    "--maintenance-file", path.join(root, "maintenance.json"),
    "--alert-file", path.join(root, "alert.json"),
    "--fallback-file", path.join(root, "fallback.json"),
  ]);
  assert.equal(parsed.downstreamPort, 18432);
  assert.equal(parsed.controlPort, 18431);
  assert.equal(parsed.upstreamPort, 18433);
});

test("missing compatible Codex binary pauses automation and requests native fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-runner-test-"));
  const paths = runtimePaths(root);
  const result = await runCodexAppServerProxyService({
    ...paths,
    localAppData: path.join(root, "missing-local-app-data"),
    pid: process.pid,
  });
  assert.equal(result.state, "failed");
  const runtime = JSON.parse(fs.readFileSync(paths.runtimeStatePath, "utf8"));
  assert.equal(runtime.state, "degraded");
  assert.equal(runtime.automationEnabled, false);
  assert.equal(runtime.fallbackRequired, true);
  const maintenance = JSON.parse(fs.readFileSync(paths.maintenanceFilePath, "utf8"));
  assert.equal(typeof maintenance.reasons.codexAppServerProxy.message, "string");
  const alert = JSON.parse(fs.readFileSync(paths.alertFilePath, "utf8"));
  assert.equal(alert.pending, true);
  const fallback = JSON.parse(fs.readFileSync(paths.fallbackFilePath, "utf8"));
  assert.equal(fallback.pending, true);
});

test("proxy lock rejects a live PID whose instance token is stale", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-lock-test-"));
  const lockPath = path.join(root, "proxy.lock");
  try {
    fs.writeFileSync(lockPath, `${JSON.stringify({
      pid: process.pid,
      startedAt: "2026-07-24T07:00:00.000Z",
      token: "stale-token",
    })}\n`, "utf8");
    const lock = acquireInstanceLock(lockPath, {
      pid: process.pid,
      startedAt: "2026-07-24T08:00:00.000Z",
      validateExistingLock: () => false,
    });
    assert.equal(lock.acquired, true);
    assert.notEqual(lock.metadata.token, "stale-token");
    lock.release();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not write stopped state or clear appServerPid while child exit is unconfirmed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-stop-test-"));
  const paths = runtimePaths(root);
  const child = createChildThatRequiresForceVerification();
  try {
    await runCodexAppServerProxyService(createStoppingServiceOptions(paths, child, async () => {
      const error = new Error("child exit remains unconfirmed");
      error.code = "APP_SERVER_TERMINATION_FAILED";
      throw error;
    }));
    const runtime = JSON.parse(fs.readFileSync(paths.runtimeStatePath, "utf8"));

    assert.notEqual(runtime.state, "stopped");
    assert.equal(runtime.appServerPid, child.pid);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("waits for a forced child termination to be confirmed before completing shutdown", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-force-stop-test-"));
  const paths = runtimePaths(root);
  let forceExitConfirmed = false;
  const child = createChildThatRequiresForceVerification((processHandle) => {
    setTimeout(() => {
      forceExitConfirmed = true;
      processHandle.exitCode = 137;
      processHandle.emit("exit", 137, "SIGKILL");
    }, 25);
  });
  try {
    await runCodexAppServerProxyService(createStoppingServiceOptions(paths, child, async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      forceExitConfirmed = true;
      child.exitCode = 137;
      child.emit("exit", 137, "SIGKILL");
    }));
    assert.equal(forceExitConfirmed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("start script selects a backup loopback port when the default upstream port is occupied", { skip: process.platform !== "win32" }, async () => {
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, "127.0.0.1", resolve));
  const occupiedPort = holder.address().port;
  const startScriptPath = path.resolve("ops/start-codex-app-server-proxy.ps1");
  const startScript = fs.readFileSync(startScriptPath, "utf8");
  const selection = startScript.match(/function Test-LoopbackPortAvailable[\s\S]*?\n(?=function Quote-Argument)/)?.[0];
  assert.ok(selection, "start script must contain the upstream loopback-port selection block");

  try {
    const command = [
      `$DownstreamPort = ${occupiedPort + 1}`,
      `$ControlPort = ${occupiedPort + 3}`,
      `$UpstreamPort = ${occupiedPort}`,
      `$ProbePort = ${occupiedPort + 4}`,
      selection,
      "[Console]::Out.Write($UpstreamPort)",
    ].join("; ");
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
    const selectedPort = Number(stdout.trim());

    assert.notEqual(selectedPort, occupiedPort);
    assert.equal(selectedPort, occupiedPort + 2);
  } finally {
    await new Promise((resolve, reject) => holder.close((error) => error ? reject(error) : resolve()));
  }
});
