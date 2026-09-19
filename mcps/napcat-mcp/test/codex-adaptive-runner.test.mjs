import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { deliveryProfileKey } from "../src/adaptive-delivery.mjs";

async function runner(context, initialState) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-adaptive-runner-test-"));
  fs.writeFileSync(path.join(directory, "codex-model-adaptive-delivery.json"), JSON.stringify(initialState));
  const placeholder = net.createServer();
  placeholder.listen(0, "127.0.0.1");
  await once(placeholder, "listening");
  const port = placeholder.address().port;
  await new Promise(resolve => placeholder.close(resolve));
  const process = spawn(globalThis.process.execPath, [fileURLToPath(new URL("../src/codex-model-stream-proxy-runner.mjs", import.meta.url))], {
    env: { ...globalThis.process.env, CODEX_MODEL_STREAM_PROXY_STATE_ROOT: directory, CODEX_MODEL_STREAM_PROXY_PORT: String(port) },
    stdio: "ignore", windowsHide: true,
  });
  const closed = once(process, "exit");
  context.after(async () => {
    fs.writeFileSync(path.join(directory, "codex-model-stream-proxy.stop"), "test complete");
    const fallback = setTimeout(() => process.kill(), 2000);
    await closed;
    clearTimeout(fallback);
    if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unexpected cleanup path");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let health;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { health = await fetch(`http://127.0.0.1:${port}/health`).then(response => response.json()); } catch {}
    if (health?.pid === process.pid) return { health, directory };
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error("Runner did not become healthy");
}

test("runner restores private adaptive delivery state and reports both deadlines", async context => {
  const now = Date.now();
  const key = deliveryProfileKey({ "chatgpt-account-id": "synthetic" }, { model: "model" }, "https://chatgpt.com");
  const setup = await runner(context, { schemaVersion: 1, profiles: [{ key, mode: "buffered", updatedAt: now, probeAfter: 0, evidenceStartedAt: now - 1 }] });
  assert.equal(setup.health.adaptiveDelivery.buffered, 1);
  assert.equal(setup.health.adaptiveWaitLimitMs, 300_000);
  assert.equal(setup.health.upstreamIdleTimeoutMs, 90_000);
  assert.equal(setup.health.firstProgressTimeoutMs, 40_000);
  const runtime = JSON.parse(fs.readFileSync(path.join(setup.directory, "codex-model-stream-proxy-runtime.json"), "utf8"));
  assert.equal(runtime.adaptiveDelivery.buffered, 1);
});

test("damaged adaptive state does not prevent startup or expose its contents", async context => {
  const setup = await runner(context, { broken: "DO_NOT_LOG_THIS_VALUE" });
  assert.equal(setup.health.adaptiveDelivery.profiles, 0);
  const log = fs.readFileSync(path.join(setup.directory, "codex-model-stream-proxy.jsonl"), "utf8");
  assert.match(log, /adaptive_delivery_state_ignored/u);
  assert.equal(log.includes("DO_NOT_LOG_THIS_VALUE"), false);
});
