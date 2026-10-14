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

test("native managed session survives repeated empty Desktop restarts with completed turn history", { timeout: 45000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "managed-desktop-restart-"));
  const fixture = await createResidualFixture(root);
  fixture.argv[fixture.argv.indexOf("--empty-client-restart-ms") + 1] = "200";
  const nativePath = fileURLToPath(new URL("./inner-runtime-profile-native.mjs", import.meta.url));
  const session = createManagedInnerProxySession({ ...fixture.profile, outerArguments: fixture.argv }, () => {}, {
    probeExecutable: async () => {}, verifyListenerOwner: async () => true,
    executableRefreshIntervalMs: 60000, lifecyclePollIntervalMs: 30, livenessIntervalMs: 100,
    spawnAppServer: (_executable, port, options) => ({ child: spawn(process.execPath, [nativePath, String(port)], {
      windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: options.env }), stderr: () => "" }),
  });
  let socket;
  const runtime = () => JSON.parse(fs.readFileSync(fixture.options.runtimeStatePath));
  const managed = () => JSON.parse(fs.readFileSync(fixture.profile.managedStatePath));
  try {
    await session.start();
    const workerPid = managed().coordinator.workers[0].pid;
    const appServerPids = [runtime().appServerPid];
    for (let iteration = 0; iteration < 2; iteration += 1) {
      socket = new WebSocket(`ws://127.0.0.1:${fixture.profile.ports.downstream}`);
      await once(socket, "open");
      await request(socket, { id: `initialize-${iteration}`, method: "initialize", params: { clientInfo: { name: "owned-desktop", version: "1" } } });
      await request(socket, { id: `turn-${iteration}`, method: "turn/start", params: { threadId: `owned-thread-${iteration}`, fixtureTurnId: `owned-turn-${iteration}` } });
      await until(() => managed().nativeSource.delivered >= (iteration + 1) * 2);
      const previousPid = runtime().appServerPid;
      const closed = once(socket, "close");
      socket.close();
      await closed;
      socket = null;
      await until(() => runtime().state === "running" && runtime().appServerPid !== previousPid);
      appServerPids.push(runtime().appServerPid);
      assert.equal(runtime().pid, process.pid);
      assert.equal(managed().state, "running");
      assert.equal(managed().nativeSource.healthy, true);
      assert.equal(managed().coordinator.workers[0].pid, workerPid);
      assert.equal(managed().coordinator.threads.length, iteration + 1);
    }
    assert.equal(new Set(appServerPids).size, 3);
    console.log(JSON.stringify({ ownedRuntimePid: process.pid, workerPid, appServerPids, deliveredEvents: managed().nativeSource.delivered, productionActions: 0 }));
  } finally {
    socket?.terminate();
    await session.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
