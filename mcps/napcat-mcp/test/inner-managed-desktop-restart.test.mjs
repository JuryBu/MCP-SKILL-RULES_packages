import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createResidualFixture } from "./inner-startup-residual-native.mjs";
import { createManagedInnerProxySession } from "../src/inner-managed-session.mjs";
import { createProxyServiceImplementation } from "../src/proxy-service-code-runtime.mjs";

async function until(check, budgetMs = 12000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error("OWNED_DESKTOP_RESTART_TIMEOUT");
}

async function request(socket, message) {
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OWNED_DESKTOP_RESPONSE_TIMEOUT")), 5000);
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

test("native managed session waits for Desktop and resumes queued initialization with completed history", { timeout: 45000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-desktop-restart-"));
  const fixture = await createResidualFixture(root);
  fixture.argv[fixture.argv.indexOf("--empty-client-restart-ms") + 1] = "200";
  const nativePath = fileURLToPath(new URL("./inner-runtime-profile-native.mjs", import.meta.url));
  let serviceParticipant;
  const session = createManagedInnerProxySession({ ...fixture.profile, outerArguments: fixture.argv }, () => {}, {
    onServiceCodeParticipant: participant => { serviceParticipant = participant; },
    probeExecutable: async () => {}, verifyListenerOwner: async () => true,
    executableRefreshIntervalMs: 60000, lifecyclePollIntervalMs: 30, livenessIntervalMs: 100,
    spawnAppServer: (_executable, port, options) => ({ child: spawn(process.execPath, [nativePath, String(port)], {
      windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: options.env }), stderr: () => "" }),
  });
  let socket;
  let siblingSocket;
  const runtime = () => JSON.parse(fs.readFileSync(fixture.options.runtimeStatePath));
  const managed = () => JSON.parse(fs.readFileSync(fixture.profile.managedStatePath));
  try {
    await session.start();
    const workerPid = managed().coordinator.workers[0].pid;
    const appServerPids = [runtime().appServerPid];
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(runtime().state, "running");
    assert.equal(runtime().appServerPid, appServerPids[0]);
    for (let iteration = 0; iteration < 2; iteration += 1) {
      socket = new WebSocket(`ws://127.0.0.1:${fixture.profile.ports.downstream}`);
      await once(socket, "open");
      await request(socket, { id: `initialize-${iteration}`, method: "initialize", params: { clientInfo: { name: "owned-desktop", version: "1" } } });
      if (iteration > 0) appServerPids.push(runtime().appServerPid);
      if (iteration === 0) {
        const previousPid = runtime().appServerPid;
        siblingSocket = new WebSocket(`ws://127.0.0.1:${fixture.profile.ports.downstream}`);
        await once(siblingSocket, "open");
        await request(siblingSocket, { id: "initialize-sibling", method: "initialize", params: {
          clientInfo: { name: "owned-sibling", version: "1" },
        } });
        const siblingClosed = once(siblingSocket, "close");
        siblingSocket.close();
        await siblingClosed;
        siblingSocket = null;
        const original = serviceParticipant.snapshot();
        serviceParticipant.activate(serviceParticipant.prepare({ createProxyServiceImplementation }));
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.equal(socket.readyState, WebSocket.OPEN);
        assert.equal(runtime().appServerPid, previousPid);
        assert.deepEqual((await request(socket, { id: "after-code-swap", method: "test/tool", params: { value: "same-connection" } })).result,
          { value: "same-connection" });
        serviceParticipant.restore(original);
      }
      await request(socket, { id: `turn-${iteration}`, method: "turn/start", params: { threadId: `owned-thread-${iteration}`, fixtureTurnId: `owned-turn-${iteration}` } });
      await until(() => managed().nativeSource.delivered >= (iteration + 1) * 2);
      const closed = once(socket, "close");
      socket.close();
      await closed;
      socket = null;
      await until(() => runtime().state === "waiting_for_desktop" && runtime().appServerPid === null);
      await new Promise(resolve => setTimeout(resolve, 450));
      assert.equal(runtime().state, "waiting_for_desktop");
      assert.equal(runtime().appServerPid, null);
      const control = await fetch(`http://127.0.0.1:${fixture.profile.ports.control}/status`, {
        headers: { authorization: `Bearer ${fs.readFileSync(fixture.options.tokenFilePath, "utf8").trim()}` },
      });
      assert.equal(control.status, 200);
      assert.equal((await control.json()).clientCount, 0);
      assert.equal(runtime().pid, process.pid);
      assert.equal(managed().state, "running");
      assert.equal(managed().nativeSource.healthy, true);
      assert.equal(managed().coordinator.workers[0].pid, workerPid);
      assert.equal(managed().coordinator.threads.length, iteration + 1);
    }
    socket = new WebSocket(`ws://127.0.0.1:${fixture.profile.ports.downstream}`);
    await once(socket, "open");
    await request(socket, { id: "initialize-final", method: "initialize", params: { clientInfo: { name: "owned-desktop", version: "1" } } });
    appServerPids.push(runtime().appServerPid);
    assert.equal(runtime().state, "running");
    assert.equal(runtime().waitingForDesktop, false);
    assert.equal(new Set(appServerPids).size, 3);
    const finalClosed = once(socket, "close");
    socket.close();
    await finalClosed;
    socket = null;
    await until(() => runtime().state === "waiting_for_desktop" && runtime().appServerPid === null);
    console.log(JSON.stringify({ ownedRuntimePid: process.pid, workerPid, appServerPids, deliveredEvents: managed().nativeSource.delivered, productionActions: 0 }));
  } finally {
    siblingSocket?.terminate();
    socket?.terminate();
    await session.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
