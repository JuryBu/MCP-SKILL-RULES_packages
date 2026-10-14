import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
const sourceRoot = process.env.CAPACITY_TEST_SOURCE_ROOT ?? fileURLToPath(new URL("../src/", import.meta.url));
const { createInnerProxyCoordinator } = await import(pathToFileURL(path.join(sourceRoot, "inner-proxy-coordinator.mjs")));
const { createInnerNativeTurnSource } = await import(pathToFileURL(path.join(sourceRoot, "inner-native-turn-source.mjs")));

test("real held HTTP survives terminal capacity reuse and a new request is accepted", { timeout: 30000 }, async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inner-capacity-live-"));
  const names = { runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" };
  let releaseHeld;
  let markHeld;
  let requests = 0;
  const heldReady = new Promise(resolve => { markHeld = resolve; });
  const ending = `data: ${JSON.stringify({ type: "response.failed", response: { id: "fixture", status: "failed",
    error: { code: "usage_limit_reached", message: "synthetic loopback only" } } })}\n\n`;
  const upstream = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    requests += 1;
    if (requests === 1) {
      releaseHeld = () => response.end(ending);
      markHeld();
    } else response.end(ending);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const events = [];
  const coordinator = createInnerProxyCoordinator({ ownerId: "capacity-fixture", nativeSourceId: "capacity-native",
    checkpointRoot: root, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    environment: { CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100", CODEX_MODEL_STREAM_PROXY_DRAIN_TIMEOUT_MS: "1000" },
    onEvent: event => events.push(event) });
  context.after(async () => {
    releaseHeld?.();
    await coordinator.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.writeFileSync(path.join(root, "evidence.json"), JSON.stringify({ status: coordinator.status(), events, requests }, null, 2));
    console.log(`capacity live evidence: ${root}`);
  });
  const endpoint = await coordinator.start({ runnerPath: path.join(sourceRoot, names.runner),
    expectedHashes: Object.fromEntries(Object.entries(names).map(([name, filename]) =>
      [name, crypto.createHash("sha256").update(fs.readFileSync(path.join(sourceRoot, filename))).digest("hex")])) });
  const native = createInnerNativeTurnSource({ sourceId: "capacity-native", coordinator });
  const notify = (threadId, phase) => native.observe({ method: `turn/${phase}`,
    params: { threadId, turn: { id: `${threadId}-turn`, ...(phase === "completed" ? { status: "completed" } : {}) } } });
  const send = async threadId => {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/backend-api/codex/responses`, { method: "POST",
      headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn",
        thread_id: threadId, turn_id: `${threadId}-turn` }) },
      body: JSON.stringify({ model: "synthetic", stream: true, input: [] }) });
    return { status: response.status, text: await response.text() };
  };
  await notify("held", "started");
  const heldResponse = send("held");
  await heldReady;
  try {
    for (let index = 0; index < 2300; index += 1) {
      await notify(`finished-${index}`, "started");
      await notify(`finished-${index}`, "completed");
    }
    assert.equal(native.status().healthy, true);
    assert.equal(coordinator.status().threads.find(thread => thread.threadId === "held").activeHttp, 1);
    await notify("new", "started");
    assert.equal((await send("new")).status, 200);
    await notify("new", "completed");
  } finally { releaseHeld(); }
  assert.equal((await heldResponse).status, 200);
  await notify("held", "completed");
  assert.equal(requests, 2);
  assert.equal(native.status().healthy, true);
});
