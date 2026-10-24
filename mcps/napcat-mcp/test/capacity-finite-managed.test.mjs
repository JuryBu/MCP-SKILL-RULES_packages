import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sse = event => `data: ${JSON.stringify(event)}\n\n`;

async function fixture(context, { code, protocol = "sse" }) {
  const events = [];
  const requests = [];
  const sockets = new Set();
  let outgoing = null;
  let incoming = null;
  let capTimer = null;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    incoming?.destroy();
    outgoing?.destroy();
  };
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(Buffer.concat(chunks));
    assert.ok(requests.length <= 8, "Local probe request cap exceeded");
    if (protocol === "reset") {
      request.socket.resetAndDestroy();
    } else {
      const error = { code, message: code === "server_error" ? "temporary failure" : "Selected model is at capacity" };
      if (protocol === "http") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error }));
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse({ type: "response.failed", response: { id: `local-${code}-${requests.length}`,
          status: "failed", output: [], error } }));
      }
    }
    if (requests.length === 8) capTimer = setTimeout(cancel, 20);
  });
  upstream.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = createCodexModelStreamProxy({ host: "127.0.0.1", port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, managedRecovery: true,
    managedRetryBaseMs: 10, fastRetryDelayMs: 0, rapidRetryMinimumMs: 10,
    firstProgressTimeoutMs: 1000, onEvent: event => events.push(event) });
  await proxy.start();
  context.after(async () => {
    clearTimeout(capTimer);
    cancel();
    await proxy.stop();
    for (const socket of sockets) socket.destroy();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await delay(20);
    assert.equal(proxy.status().activeRequests, 0);
    assert.equal(proxy.status().requestBuffer.usedBytes, 0);
    assert.equal(sockets.size, 0);
    context.diagnostic("cleanup: owned sockets/activeRequests/requestBuffer=0");
  });
  const request = () => new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ stream: true, tools: [{ type: "function", name: "safe" }] }));
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    outgoing = http.request({ host: "127.0.0.1", port: proxy.status().port, agent: false,
      path: "/backend-api/codex/responses", method: "POST", headers: {
        "content-type": "application/json", "content-length": String(body.length),
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: `finite-${code}-${protocol}`, turn_id: "same-turn" }),
        authorization: "Bearer synthetic-local-only" } }, response => {
      incoming = response;
      response.on("data", chunk => chunks.push(chunk));
      response.once("end", finish);
      response.once("close", finish);
      response.once("error", error => cancelled ? finish() : reject(error));
    });
    outgoing.once("error", error => cancelled ? finish() : reject(error));
    outgoing.once("close", () => { if (cancelled) finish(); });
    outgoing.end(body);
  });
  return { events, requests, proxy, request, cancelled: () => cancelled };
}

const capacityCases = [
  ...["server_is_overloaded", "server_overloaded", "model_at_capacity"].map(code => ({ code, protocol: "sse" })),
  { code: "server_is_overloaded", protocol: "http" },
];

for (const definition of capacityCases) {
  test(`managed capacity ${definition.protocol} ${definition.code} ends after six native attempts`, { timeout: 8000 }, async context => {
    const setup = await fixture(context, definition);
    const bodies = [];
    for (let attempt = 1; attempt <= 6; attempt++) bodies.push(await setup.request());
    assert.equal(setup.requests.length, 6);
    assert.equal(setup.cancelled(), false);
    assert.equal(setup.events.filter(event => event.type === "native_retry_signal").length, 5);
    const exhausted = setup.events.filter(event => event.type === "retry_exhausted_terminal_failure");
    assert.equal(exhausted.length, 1);
    assert.equal(exhausted[0].category, "capacity");
    assert.deepEqual(setup.events.filter(event => event.type === "turn_attempt_started").map(event => event.attemptNumber), [1, 2, 3, 4, 5, 6]);
    assert.match(bodies.at(-1), /当前模型暂时满载.*六次/u);
    assert.match(bodies.at(-1), /response\.completed/u);
    assert.ok(setup.requests.every(body => body.equals(setup.requests[0])));
    await delay(100);
    assert.equal(setup.requests.length, 6);
    context.diagnostic("upstream=6 client=6 nativeRetry=5 capacityTerminal=1 response.completed=1 no seventh send");
  });
}

for (const definition of [{ code: "server_error", protocol: "http" }, { code: "ECONNRESET", protocol: "reset" }]) {
  test(`managed network ${definition.code} continues to eight and cancellation stops replay`, { timeout: 8000 }, async context => {
    const setup = await fixture(context, definition);
    const body = await setup.request();
    assert.equal(setup.cancelled(), true);
    assert.equal(setup.requests.length, 8);
    assert.equal(setup.events.filter(event => event.type === "turn_attempt_started").length, 1);
    assert.equal(setup.events.filter(event => event.type === "retry_exhausted_terminal_failure").length, 0);
    assert.doesNotMatch(body, /response\.completed|当前模型暂时满载/u);
    await delay(200);
    assert.equal(setup.requests.length, 8);
    assert.equal(setup.proxy.status().activeRequests, 0);
    assert.ok(setup.requests.every(requestBody => requestBody.equals(setup.requests[0])));
    context.diagnostic("upstream=8 client=1 exhausted=0; cancelled at cap; no ninth send after 200ms");
  });
}
