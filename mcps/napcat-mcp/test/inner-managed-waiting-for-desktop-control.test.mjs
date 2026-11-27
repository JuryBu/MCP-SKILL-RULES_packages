import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createResidualFixture } from "./inner-startup-residual-native.mjs";
import { createManagedInnerProxySession, createManagedInnerProxySessionImplementation } from "../src/inner-managed-session.mjs";

function unitFixture(context, outer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "napcat-waiting-desktop-unit-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeStatePath = path.join(root, "outer-runtime.json");
  fs.writeFileSync(runtimeStatePath, JSON.stringify(outer));
  const source = { healthy: true, failureCode: null, delivered: 42 };
  const coordinator = {
    running: true, nativeHealthy: true, defaultWorkerId: "worker-1",
    activeHttp: 0, pendingControl: 0, transactionActive: false, workerMaintenance: false,
    workers: [{ workerId: "worker-1", alive: true, sourceHashes: { runner: "a", core: "b", helper: "c", control: "d" } }],
    threads: [],
  };
  const shared = {
    configuration: { ownerId: "test-owner", nativeSourceId: "test-native" },
    options: { runtimeStatePath, instanceToken: "test-instance" },
    onEvent: () => {}, serviceDependencies: {},
    started: true, closed: false, outerFinished: false,
    innerEndpoint: { host: "127.0.0.1", port: 41435 },
    controlRevision: 1, controlBusy: false, controlOperations: new Map(),
    nativeSource: { status: () => ({ ...source }) },
    coordinator: {
      status: () => coordinator,
      recoveryControl: async () => ({ accepted: true, ok: true }),
    },
  };
  const implementation = createManagedInnerProxySessionImplementation(shared);
  const binding = { ownerId: "test-owner", nativeSourceId: "test-native", instanceToken: "test-instance" };
  return { implementation, binding, source, coordinator, shared, runtimeStatePath };
}

test("diagnosticControlStatus and controlStatus treat clean waiting_for_desktop as healthy and ready", async context => {
  const value = unitFixture(context, {
    state: "waiting_for_desktop",
    waitingForDesktop: true,
    appServerPid: null,
    fallbackRequired: false,
    proxy: { clientCount: 0, outerRuntime: { activeOperationCount: 0, trackedRequestCount: 0, pendingToolCount: 0 } },
  });
  const status = await value.implementation.dispatchControl("status", value.binding);
  assert.equal(status.ok, true);
  assert.equal(status.healthy, true);
  assert.equal(status.state, "running");
  assert.equal(status.failureCode, null);
  assert.equal(status.inFlight.clientCount, 0);

  const cont = await value.implementation.dispatchControl("continue-http", value.binding);
  assert.equal(cont.ok, true);
});

test("malformed or degraded waiting_for_desktop and non-ready outer states stay strictly unhealthy and rejected", async context => {
  const invalidStates = [
    { name: "missing-waiting-flag", outer: { state: "waiting_for_desktop", waitingForDesktop: false, appServerPid: null, fallbackRequired: false } },
    { name: "nonzero-app-server-pid", outer: { state: "waiting_for_desktop", waitingForDesktop: true, appServerPid: 12345, fallbackRequired: false } },
    { name: "fallback-required", outer: { state: "waiting_for_desktop", waitingForDesktop: true, appServerPid: null, fallbackRequired: true } },
    { name: "starting", outer: { state: "starting", waitingForDesktop: false, appServerPid: null } },
    { name: "restarting", outer: { state: "restarting", waitingForDesktop: false, appServerPid: null } },
    { name: "degraded", outer: { state: "degraded", waitingForDesktop: false, appServerPid: null } },
    { name: "stopped", outer: { state: "stopped", waitingForDesktop: false, appServerPid: null } },
  ];
  for (const item of invalidStates) {
    const value = unitFixture(context, item.outer);
    const status = await value.implementation.dispatchControl("status", value.binding);
    assert.equal(status.ok, false, item.name);
    assert.equal(status.healthy, false, item.name);
    assert.equal(status.state, "degraded", item.name);
    assert.equal(status.failureCode, "MANAGED_SESSION_NOT_READY", item.name);
    await assert.rejects(
      value.implementation.dispatchControl("continue-http", value.binding),
      /INNER_CONTROL_NOT_READY/u,
      item.name,
    );
  }
});

test("waiting_for_desktop remains unhealthy if nativeSource or coordinator is degraded", async context => {
  const value = unitFixture(context, {
    state: "waiting_for_desktop",
    waitingForDesktop: true,
    appServerPid: null,
    fallbackRequired: false,
  });
  value.source.healthy = false;
  value.source.failureCode = "NATIVE_SOURCE_RELAY_FAILED";
  const status = await value.implementation.dispatchControl("status", value.binding);
  assert.equal(status.ok, false);
  assert.equal(status.healthy, false);
  assert.equal(status.failureCode, "NATIVE_SOURCE_RELAY_FAILED");
});

async function until(check, budgetMs = 15000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error("WAITING_DESKTOP_E2E_TIMEOUT");
}

async function wsRequest(socket, message) {
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS_RESPONSE_TIMEOUT")), 5000);
    const listener = bytes => {
      const reply = JSON.parse(bytes.toString());
      if (reply.id !== message.id) return;
      clearTimeout(timer);
      socket.off("message", listener);
      resolve(reply);
    };
    socket.on("message", listener);
  });
  socket.send(JSON.stringify(message));
  return response;
}

test("real managed session exposes healthy /v1/inner/status while parked in waiting_for_desktop and resumes on desktop reconnect", { timeout: 45000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-waiting-desktop-e2e-"));
  const fixture = await createResidualFixture(root);
  fixture.argv[fixture.argv.indexOf("--empty-client-restart-ms") + 1] = "200";
  const nativePath = fileURLToPath(new URL("./inner-runtime-profile-native.mjs", import.meta.url));
  const session = createManagedInnerProxySession({ ...fixture.profile, outerArguments: fixture.argv }, () => {}, {
    probeExecutable: async () => {},
    verifyListenerOwner: async () => true,
    executableRefreshIntervalMs: 60000,
    lifecyclePollIntervalMs: 30,
    livenessIntervalMs: 100,
    spawnAppServer: (_executable, port, options) => ({
      child: spawn(process.execPath, [nativePath, String(port)], {
        windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: options.env,
      }),
      stderr: () => "",
    }),
  });
  let socket;
  const runtime = () => JSON.parse(fs.readFileSync(fixture.options.runtimeStatePath, "utf8"));
  try {
    await session.start();
    socket = new WebSocket(`ws://127.0.0.1:${fixture.profile.ports.downstream}`);
    await once(socket, "open");
    await wsRequest(socket, { id: "init-1", method: "initialize", params: { clientInfo: { name: "test-desktop", version: "1" } } });
    const closed = once(socket, "close");
    socket.close();
    await closed;
    socket = null;

    await until(() => runtime().state === "waiting_for_desktop" && runtime().waitingForDesktop === true && runtime().appServerPid === null);
    const rt = runtime();
    const token = fs.readFileSync(fixture.options.tokenFilePath, "utf8").trim();
    const res = await fetch(`http://127.0.0.1:${fixture.profile.ports.control}/v1/inner/status`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-inner-owner-id": fixture.profile.ownerId,
        "x-inner-native-source-id": fixture.profile.nativeSourceId,
        "x-inner-instance-token": rt.instanceToken,
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.healthy, true);
    assert.equal(body.state, "running");
    assert.equal(body.failureCode, null);
    assert.equal(body.inFlight.clientCount, 0);

    socket = new WebSocket(`ws://127.0.0.1:${fixture.profile.ports.downstream}`);
    await once(socket, "open");
    await wsRequest(socket, { id: "init-2", method: "initialize", params: { clientInfo: { name: "test-desktop-reopen", version: "1" } } });
    assert.equal(runtime().state, "running");
    assert.equal(runtime().waitingForDesktop, false);
  } finally {
    socket?.terminate();
    await session.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
