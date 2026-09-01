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
  atomicWriteJson,
  findExecutableRefresh,
  observeEmptyDesktopRestart,
  parseArguments,
  runCodexAppServerProxyService,
  terminateManagedAppServer,
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
  assert.equal(parsed.requestTimeoutMs, 30000);
  assert.equal(parsed.resumeRequestTimeoutMs, 120000);
  assert.equal(parsed.emptyClientRestartMs, 10000);
});

test("empty Desktop restart waits for a real client disconnect epoch", () => {
  let observed = observeEmptyDesktopRestart({}, { clientCount: 0, nowMs: 0, restartMs: 10 });
  assert.equal(observed.shouldRestart, false);
  assert.deepEqual(observed.state, { sawDesktopClient: false, emptySinceMs: null });

  observed = observeEmptyDesktopRestart(observed.state, { clientCount: 1, nowMs: 1, restartMs: 10 });
  assert.equal(observed.shouldRestart, false);
  assert.deepEqual(observed.state, { sawDesktopClient: true, emptySinceMs: null });

  observed = observeEmptyDesktopRestart(observed.state, { clientCount: 0, nowMs: 2, restartMs: 10 });
  assert.equal(observed.shouldRestart, false);
  assert.deepEqual(observed.state, { sawDesktopClient: true, emptySinceMs: 2 });

  observed = observeEmptyDesktopRestart(observed.state, { clientCount: 1, nowMs: 8, restartMs: 10 });
  assert.equal(observed.shouldRestart, false);
  assert.deepEqual(observed.state, { sawDesktopClient: true, emptySinceMs: null });

  observed = observeEmptyDesktopRestart(observed.state, { clientCount: 0, nowMs: 9, restartMs: 10 });
  assert.equal(observed.shouldRestart, false);
  observed = observeEmptyDesktopRestart(observed.state, { clientCount: 0, nowMs: 19, restartMs: 10 });
  assert.equal(observed.shouldRestart, true);
  assert.equal(observed.emptyForMs, 10);

  observed = observeEmptyDesktopRestart({ sawDesktopClient: true, emptySinceMs: 0 }, {
    clientCount: "not-a-number",
    nowMs: 100,
    restartMs: 10,
  });
  assert.equal(observed.shouldRestart, false);
  assert.deepEqual(observed.state, { sawDesktopClient: true, emptySinceMs: null });

  observed = observeEmptyDesktopRestart({ sawDesktopClient: true, emptySinceMs: null }, {
    clientCount: 2,
    nowMs: 100,
    restartMs: 10,
  });
  assert.equal(observed.shouldRestart, false);
  observed = observeEmptyDesktopRestart(observed.state, { clientCount: 1, nowMs: 110, restartMs: 10 });
  assert.equal(observed.shouldRestart, false);
  assert.deepEqual(observed.state, { sawDesktopClient: true, emptySinceMs: null });

  observed = observeEmptyDesktopRestart({ sawDesktopClient: true, emptySinceMs: 0 }, {
    clientCount: 0,
    nowMs: 100,
    restartMs: 0,
  });
  assert.equal(observed.shouldRestart, false);
  assert.deepEqual(observed.state, { sawDesktopClient: false, emptySinceMs: null });
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

test("atomic runtime writes remove temporary files after rename failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-atomic-cleanup-test-"));
  const runtimePath = path.join(root, "runtime.json");
  const fsImpl = {
    ...fs,
    renameSync() {
      const error = new Error("simulated rename failure");
      error.code = "EIO";
      throw error;
    },
  };
  try {
    assert.throws(() => atomicWriteJson(runtimePath, { state: "running" }, fsImpl), /simulated rename failure/);
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".tmp")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("proxy lock remains valid for a matching live instance after long idle time", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-live-lock-test-"));
  const paths = runtimePaths(root);
  const startedAt = "2026-07-24T07:00:00.000Z";
  const token = "matching-live-token";
  try {
    fs.writeFileSync(paths.lockPath, `${JSON.stringify({ pid: process.pid, startedAt, token })}\n`, "utf8");
    fs.writeFileSync(paths.runtimeStatePath, `${JSON.stringify({
      pid: process.pid,
      instanceToken: token,
      startedAt,
      state: "running",
    })}\n`, "utf8");

    const result = await runCodexAppServerProxyService({
      ...paths,
      now: () => new Date("2026-07-24T09:00:00.000Z"),
      processCommandLine: () => `node codex-app-server-proxy-runner.mjs --runtime-state ${paths.runtimeStatePath} --lock ${paths.lockPath}`,
    });

    assert.equal(result.state, "duplicate");
    assert.equal(JSON.parse(fs.readFileSync(paths.lockPath, "utf8")).token, token);
    assert.equal(fs.readdirSync(root).some((name) => name.includes(".stale-")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("proxy startup grace keeps a matching live owner while runtime state is not published yet", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-startup-lock-test-"));
  const paths = runtimePaths(root);
  const startedAt = "2026-07-24T08:59:30.000Z";
  try {
    fs.writeFileSync(paths.lockPath, `${JSON.stringify({ pid: process.pid, startedAt, token: "starting-token" })}\n`, "utf8");
    const result = await runCodexAppServerProxyService({
      ...paths,
      now: () => new Date("2026-07-24T09:00:00.000Z"),
      processCommandLine: () => `node codex-app-server-proxy-runner.mjs --runtime-state ${paths.runtimeStatePath} --lock ${paths.lockPath}`,
    });
    assert.equal(result.state, "duplicate");
    assert.equal(fs.readdirSync(root).some((name) => name.includes(".stale-")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an old lock owner cannot release a replacement owner lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-lock-fence-test-"));
  const lockPath = path.join(root, "proxy.lock");
  try {
    const first = acquireInstanceLock(lockPath, { pid: process.pid, startedAt: "2026-07-24T09:00:00.000Z" });
    assert.equal(first.acquired, true);
    fs.rmSync(lockPath, { force: true });
    const second = acquireInstanceLock(lockPath, { pid: process.pid, startedAt: "2026-07-24T09:00:01.000Z" });
    assert.equal(second.acquired, true);
    assert.equal(first.isOwner(), false);
    first.release();
    assert.equal(second.isOwner(), true);
    second.release();
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

test("managed App Server shutdown tolerates delayed loopback-port release", async () => {
  const child = createChildThatRequiresForceVerification();
  let checks = 0;
  await terminateManagedAppServer(child, 18453, {
    terminateChild: async () => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
    },
    verifyPortReleased: async () => {
      checks += 1;
      return checks >= 3;
    },
    portReleaseTimeoutMs: 100,
    portReleasePollIntervalMs: 1,
  });
  assert.equal(checks, 3);
});

test("managed App Server shutdown does not probe an unrelated listener after its child is cleared", async () => {
  let checks = 0;
  await terminateManagedAppServer(null, 18453, {
    verifyPortReleased: async () => {
      checks += 1;
      return false;
    },
  });
  assert.equal(checks, 0);
});

test("proxy listener starts before Codex binary probing and managed App Server launch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-boot-order-test-"));
  const paths = runtimePaths(root);
  const events = [];
  const child = createChildThatRequiresForceVerification((processHandle) => {
    processHandle.exitCode = 137;
    processHandle.emit("exit", 137, "SIGKILL");
  });
  try {
    await runCodexAppServerProxyService({
      ...createStoppingServiceOptions(paths, child),
      createProxy: () => ({
        startedAt: null,
        async start() {
          events.push("proxy_start");
          this.startedAt = new Date().toISOString();
        },
        async close() {},
        status() { return { state: "running" }; },
      }),
      probeExecutable: async () => { events.push("probe_executable"); },
      spawnAppServer: () => {
        events.push("spawn_app_server");
        return { child, stderr: () => "" };
      },
      waitForWebSocketReady: async () => {
        events.push("upstream_ready");
        fs.writeFileSync(paths.stopFilePath, "stop\n", "utf8");
      },
    });
    assert.deepEqual(events, ["proxy_start", "probe_executable", "spawn_app_server", "upstream_ready"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("empty Desktop restart does not fire before any Desktop client has connected", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-empty-start-test-"));
  const paths = runtimePaths(root);
  const child = createChildThatRequiresForceVerification((processHandle) => {
    processHandle.exitCode = 0;
    processHandle.emit("exit", 0, null);
  });
  let spawnCount = 0;
  try {
    const result = await runCodexAppServerProxyService({
      ...paths,
      executablePath: process.execPath,
      pid: process.pid,
      emptyClientRestartMs: 3,
      lifecyclePollIntervalMs: 1,
      probeExecutable: async () => {},
      createProxy: () => ({
        async start() {},
        async close() {},
        status() { return { clientCount: 0 }; },
      }),
      spawnAppServer: () => {
        spawnCount += 1;
        return { child, stderr: () => "" };
      },
      waitForWebSocketReady: async () => {
        setTimeout(() => fs.writeFileSync(paths.stopFilePath, "stop\n", "utf8"), 15);
      },
      terminateChild: async () => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      },
      verifyPortReleased: async () => true,
    });
    assert.equal(result.state, "stopped");
    assert.equal(spawnCount, 1);
    const logText = fs.readFileSync(paths.logPath, "utf8");
    assert.equal(logText.includes("app_server_desktop_empty_restart"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("empty Desktop restart fires once after the last Desktop client disconnects", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-empty-restart-test-"));
  const paths = runtimePaths(root);
  let clientCount = 1;
  let spawnCount = 0;
  let nextPid = 43210;
  try {
    const result = await runCodexAppServerProxyService({
      ...paths,
      executablePath: process.execPath,
      pid: process.pid,
      emptyClientRestartMs: 5,
      lifecyclePollIntervalMs: 1,
      probeExecutable: async () => {},
      createProxy: () => ({
        async start() {},
        async close() {},
        status() { return { clientCount }; },
      }),
      spawnAppServer: () => {
        spawnCount += 1;
        const child = createChildThatRequiresForceVerification();
        child.pid = nextPid;
        nextPid += 1;
        return { child, stderr: () => "" };
      },
      waitForWebSocketReady: async () => {
        if (spawnCount === 1) {
          clientCount = 1;
          setTimeout(() => { clientCount = 0; }, 2);
          return;
        }
        fs.writeFileSync(paths.stopFilePath, "stop\n", "utf8");
      },
      terminateChild: async (child) => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
      },
      verifyPortReleased: async () => true,
    });
    assert.equal(result.state, "stopped");
    assert.equal(spawnCount, 2);
    const logEntries = fs.readFileSync(paths.logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(logEntries.some((entry) => entry.type === "app_server_desktop_empty_restart"), true);
    assert.equal(logEntries.some((entry) => entry.type === "app_server_exited"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Codex executable refresh is accepted only while the Desktop proxy has no clients", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-refresh-test-"));
  const executablePath = path.join(root, "codex.exe");
  try {
    fs.writeFileSync(executablePath, "new-binary", "utf8");
    const currentRevision = { executablePath, modifiedAt: 1, size: 1 };
    let probes = 0;
    const active = await findExecutableRefresh(currentRevision, {
      executablePath,
      probePort: 18454,
      proxyStatus: () => ({ clientCount: 1 }),
      probeExecutable: async () => { probes += 1; },
    });
    assert.equal(active, null);
    assert.equal(probes, 0);

    const idle = await findExecutableRefresh(currentRevision, {
      executablePath,
      probePort: 18454,
      proxyStatus: () => ({ clientCount: 0 }),
      probeExecutable: async () => { probes += 1; },
    });
    assert.equal(idle.executablePath, path.resolve(executablePath));
    assert.equal(probes, 1);

    const clientCounts = [0, 1];
    const connectedDuringProbe = await findExecutableRefresh(currentRevision, {
      executablePath,
      probePort: 18454,
      proxyStatus: () => ({ clientCount: clientCounts.shift() ?? 1 }),
      probeExecutable: async () => { probes += 1; },
    });
    assert.equal(connectedDuringProbe, null);
    assert.equal(probes, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a healthy managed App Server supersedes stale proxy alerts and fallback requests", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-recovery-artifacts-test-"));
  const paths = runtimePaths(root);
  const child = createChildThatRequiresForceVerification((processHandle) => {
    processHandle.exitCode = 137;
    processHandle.emit("exit", 137, "SIGKILL");
  });
  fs.writeFileSync(paths.alertFilePath, `${JSON.stringify({
    pending: true,
    status: "pending",
    source: "codex-app-server-proxy",
    code: "APP_SERVER_RESTART_EXHAUSTED",
  })}\n`, "utf8");
  fs.writeFileSync(paths.fallbackFilePath, `${JSON.stringify({
    pending: true,
    expectedProxyUrl: `ws://127.0.0.1:${paths.downstreamPort}`,
  })}\n`, "utf8");
  try {
    const result = await runCodexAppServerProxyService(createStoppingServiceOptions(paths, child));
    assert.equal(result.state, "stopped");
    const alert = JSON.parse(fs.readFileSync(paths.alertFilePath, "utf8"));
    assert.equal(alert.pending, false);
    assert.equal(alert.status, "superseded");
    assert.equal(fs.existsSync(paths.fallbackFilePath), false);
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

    assert.ok(selectedPort > occupiedPort && selectedPort <= occupiedPort + 32);
    assert.notEqual(selectedPort, occupiedPort + 1);
    assert.notEqual(selectedPort, occupiedPort + 3);
    assert.notEqual(selectedPort, occupiedPort + 4);
  } finally {
    await new Promise((resolve, reject) => holder.close((error) => error ? reject(error) : resolve()));
  }
});

test("start script ignores stale degraded runtime state from the previous proxy PID", () => {
  const startScript = fs.readFileSync(path.resolve("ops/start-codex-app-server-proxy.ps1"), "utf8");
  const staleGuardIndex = startScript.indexOf("[int]$CandidateState.pid -ne [int]$Process.Id");
  const degradedCheckIndex = startScript.indexOf('[string]$CandidateState.state -eq "degraded"');
  assert.ok(staleGuardIndex >= 0, "start script must fence runtime state by the newly spawned PID");
  assert.ok(degradedCheckIndex > staleGuardIndex, "stale PID fencing must run before degraded-state handling");
});
