import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.join(root, "src");
const specification = () => ({ runnerPath: path.join(sourceRoot, "codex-model-stream-proxy-runner.mjs"),
  expectedHashes: Object.fromEntries(Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" }).map(([key, file]) => [key,
    crypto.createHash("sha256").update(fs.readFileSync(path.join(sourceRoot, file))).digest("hex")])) });

async function port() {
  const server = http.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
}

async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timed out: ${label}`);
}

test("normal session CLI connects upstream turn events, deduplicates and keeps a busy source running", { timeout: 30000 }, async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "inner-session-entry-"));
  const events = [];
  const messages = [];
  const app = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(app, "listening");
  const sockets = [];
  app.on("connection", socket => {
    sockets.push(socket);
    socket.on("message", data => {
      const message = JSON.parse(String(data));
      if (message.method === "initialize") socket.send(JSON.stringify({ id: message.id, result: { userAgent: "synthetic-app" } }));
    });
  });
  const upstream = http.createServer((request, response) => {
    request.resume(); response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ type: "response.failed", response: { id: "fixture", status: "failed",
      error: { code: "usage_limit_reached", message: "synthetic loopback only" } } })}\n\n`);
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const configuration = { mode: "isolated", checkpointRoot: directory, ownerId: "session-test", nativeSourceId: "real-upstream-socket",
    appServerUrl: `ws://127.0.0.1:${app.address().port}`, downstreamPort: await port(), controlPort: await port(),
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, initial: specification(),
    environment: { CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100", CODEX_MODEL_STREAM_PROXY_DRAIN_TIMEOUT_MS: "1000" } };
  const configPath = path.join(directory, "config.json"); fs.writeFileSync(configPath, JSON.stringify(configuration));
  const stderr = fs.openSync(path.join(directory, "stderr.log"), "wx");
  const child = spawn(process.execPath, [path.join(root, "ops/inner-proxy-session.mjs"), "--config", configPath], {
    stdio: ["pipe", "pipe", stderr], windowsHide: true, cwd: directory,
  }); fs.closeSync(stderr);
  readline.createInterface({ input: child.stdout }).on("line", line => {
    fs.appendFileSync(path.join(directory, "messages.jsonl"), `${line}\n`);
    messages.push(JSON.parse(line));
  });
  const clients = [];
  let requestSequence = 0;
  const control = async (method, parameters = {}) => {
    const id = `request-${++requestSequence}`;
    child.stdin.write(`${JSON.stringify({ id, method, ...parameters })}\n`);
    return until(() => messages.find(message => message.id === id), method);
  };
  context.after(async () => {
    clients.forEach(client => client.close());
    try {
      if (child.exitCode === null) {
        await control("close"); child.stdin.end();
        await until(() => child.exitCode !== null, "CLI exit");
      }
    } finally {
      child.stdin.end();
      sockets.forEach(socket => socket.close());
      app.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    }
    fs.writeFileSync(path.join(directory, "evidence.json"), JSON.stringify({ kind: "normal-cli-synthetic-upstream", events, messages,
      childExitCode: child.exitCode, childSignal: child.signalCode }, null, 2));
    console.log(`normal CLI evidence: ${directory}`);
  });
  const ready = await until(() => messages.find(message => message.event === "ready"), "ready");
  for (let count = 0; count < 2; count += 1) {
    const client = new WebSocket(ready.downstreamUrl); clients.push(client); await once(client, "open");
    client.on("message", data => events.push(JSON.parse(String(data))));
    client.send(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "synthetic", version: "1" } } }));
  }
  await until(() => sockets.length === 2 && events.filter(event => event.id === 1).length === 2, "initialize");
  const native = phase => ({ method: `turn/${phase}`, params: { threadId: "native-thread", turn: {
    id: "native-turn", ...(phase === "completed" ? { status: "completed" } : {}),
  } } });
  sockets.forEach(socket => socket.send(JSON.stringify(native("started"))));
  await until(async () => (await control("status")).result.nativeSource.duplicates === 1, "native duplicate");
  const response = await fetch(`http://127.0.0.1:${ready.innerEndpoint.port}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json", "x-codex-turn-metadata": JSON.stringify({ thread_id: "native-thread", turn_id: "native-turn" }) },
    body: JSON.stringify({ model: "synthetic", stream: true, input: [] }) });
  assert.equal(response.status, 200); await response.text();
  assert.equal((await control("close")).code, "INNER_SESSION_BUSY");
  sockets.forEach(socket => socket.send(JSON.stringify(native("completed"))));
  await until(async () => (await control("status")).result.nativeSource.duplicates === 2, "terminal duplicate");
  const prepared = await control("prepareCandidate", { specification: specification() });
  assert.equal(prepared.ok, true);
  const migrated = await control("migrate", { request: { threadId: "native-thread", candidateId: prepared.result.workerId } });
  assert.equal(migrated.ok, true); assert.equal(migrated.result.committed, true);
  const final = await control("status");
  assert.equal(final.result.nativeSource.delivered, 2); assert.equal(final.result.nativeSource.healthy, true);
});
