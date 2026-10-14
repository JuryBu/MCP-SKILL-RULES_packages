import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createInnerProxyCoordinator } from "../src/inner-proxy-coordinator.mjs";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test("independent auxiliary HTTP classification and transport", { timeout: 30000 }, async context => {
  const coordinatorHash = digest(fs.readFileSync(path.join(sourceRoot, "inner-proxy-coordinator.mjs")));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "request-classification-review-"));
  const events = [];
  const calls = [];
  const sockets = new Set();
  let streamClosed = false;
  let uploadClosed = false;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    const entry = { path: request.url, method: request.method, headers: request.headers };
    calls.push(entry);
    if (request.url.includes("mode=upload")) {
      request.on("data", () => {});
      request.once("aborted", () => { uploadClosed = true; });
      return;
    }
    request.on("data", chunk => chunks.push(chunk));
    request.once("end", () => {
      entry.bytes = Buffer.concat(chunks);
      if (request.url.includes("mode=cancel")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: owned-first\n\n");
        response.once("close", () => { streamClosed = true; });
      } else if (request.url.includes("mode=stream")) {
        response.writeHead(200, { "content-type": "text/event-stream", "x-owned-response": "preserved" });
        response.write("data: owned-first\n\n");
        setTimeout(() => response.end("data: owned-last\n\n"), 20);
      } else if (request.url.includes("mode=denied")) {
        response.writeHead(401, { "content-type": "application/json", "www-authenticate": "owned-fixture" });
        response.end("{\"error\":\"owned-denied\"}");
      } else {
        response.writeHead(200, { "content-type": "application/octet-stream", "x-owned-response": "preserved" });
        response.end(entry.bytes.length ? entry.bytes : Buffer.from([0, 255, 128, 10]));
      }
    });
  });
  upstream.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const environment = {};
  for (const name of Object.keys(process.env)) {
    if (/^(CODEX|OPENAI|MCP|MODEL_OBSERVER|ANTHROPIC|GEMINI|AZURE_OPENAI)_/u.test(name)) environment[name] = "";
  }
  Object.assign(environment, { MODEL_OBSERVER_ENABLED: "false", CODEX_MODEL_STREAM_PROXY_HEARTBEAT_INTERVAL_MS: "100" });
  const coordinator = createInnerProxyCoordinator({ ownerId: "classification-review-owned", nativeSourceId: "classification-review-native",
    checkpointRoot: root, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, environment, onEvent: event => events.push(event) });
  context.after(async () => {
    await coordinator.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
    assert.ok(coordinator.status().workers.every(worker => !worker.alive && worker.exitCode === 0));
    assert.equal(path.dirname(root), os.tmpdir());
    fs.rmSync(root, { recursive: true });
    console.log(JSON.stringify({ evidence: "owned-loopback-real-http", upstreamCalls: calls.length,
      coordinatorHash, coordinatorHashAfter: digest(fs.readFileSync(path.join(sourceRoot, "inner-proxy-coordinator.mjs"))),
      routedClasses: [...new Set(events.filter(event => event.type === "request_routed").map(event => event.requestClass))],
      rejectionCodes: [...new Set(events.filter(event => event.type === "request_rejected").map(event => event.code))],
      streamClosed, uploadClosed, workersClean: true }));
  });
  const expectedHashes = Object.fromEntries(Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
    helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" }).map(([name, filename]) => [name, digest(fs.readFileSync(path.join(sourceRoot, filename)))]));
  const endpoint = await coordinator.start({ runnerPath: path.join(sourceRoot, "codex-model-stream-proxy-runner.mjs"), expectedHashes });
  const request = (target, method = "GET", headers = {}, body = undefined) => new Promise((resolve, reject) => {
    const client = http.request({ hostname: "127.0.0.1", port: endpoint.port, path: target, method, headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    client.once("error", reject);
    client.end(body);
  });
  const waitUntil = async predicate => {
    const deadline = Date.now() + 2500;
    while (!predicate()) { assert.ok(Date.now() < deadline, "owned transport deadline"); await pause(10); }
  };

  await context.test("exact methods, query, binary request and response, synthetic auth headers", async () => {
    const catalog = await request("/backend-api/codex/models?client_version=owned-review&cursor=owned%2Fvalue", "GET",
      { authorization: "Bearer owned-fixture", "x-owned-header": "retained", accept: "application/octet-stream" });
    assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.bytes, Buffer.from([0, 255, 128, 10]));
    assert.equal(calls.at(-1).path, "/backend-api/codex/models?client_version=owned-review&cursor=owned%2Fvalue");
    assert.equal(calls.at(-1).headers.authorization, "Bearer owned-fixture");
    assert.equal(calls.at(-1).headers["x-owned-header"], "retained");
    assert.equal(catalog.headers["x-owned-response"], "preserved");
    for (const target of ["/backend-api/codex/images/generations", "/backend-api/codex/images/edits", "/backend-api/codex/memories/trace_summarize"]) {
      const body = Buffer.from([0, 255, 128, 13, 10]);
      const result = await request(target, "POST", { "content-type": "application/octet-stream", authorization: "Bearer owned-fixture" }, body);
      assert.equal(result.status, 200);
      assert.deepEqual(result.bytes, body);
      assert.deepEqual(calls.at(-1).bytes, body);
      assert.equal(calls.at(-1).headers.authorization, "Bearer owned-fixture");
    }
    assert.equal(coordinator.status().threads.length, 0);
  });

  await context.test("wrong methods, unknown paths and invalid targets never gain auxiliary classification", async () => {
    const before = calls.length;
    for (const [target, method] of [["/backend-api/codex/models", "POST"], ["/backend-api/codex/models", "HEAD"],
      ["/backend-api/codex/images/generations", "GET"], ["/backend-api/codex/images/edits", "PUT"],
      ["/backend-api/codex/memories/trace_summarize", "GET"], ["/backend-api/codex/memories/trace_summarize", "PUT"],
      ["/backend-api/codex/memories/trace_summarize/extra", "POST"],
      ["/v1/responses", "POST"], ["/backend-api/codex/responses", "POST"], ["/backend-api/images/generations", "POST"], ["/backend-api/codex/models/", "GET"],
      ["/backend-api/codex/models/extra", "GET"], ["//backend-api/codex/models", "GET"], ["http://127.0.0.1/backend-api/codex/models", "GET"]]) {
      assert.equal((await request(target, method)).status, 503, `${method} ${target}`);
    }
    assert.equal(calls.length, before);
  });

  await context.test("present malformed or inactive metadata stays guarded; valid active and completed identity", async () => {
    const before = calls.length;
    for (const raw of ["", "{", "null", "[]", "{}", "true", JSON.stringify({ thread_id: "owned-missing", turn_id: "owned-missing" }), "x".repeat(8193)]) {
      assert.equal((await request("/backend-api/codex/models", "GET", { "x-codex-turn-metadata": raw })).status, 503);
      assert.equal((await request("/backend-api/codex/images/edits", "POST", { "x-codex-turn-metadata": raw })).status, 503);
      assert.equal((await request("/backend-api/codex/memories/trace_summarize", "POST", { "x-codex-turn-metadata": raw })).status, 503);
    }
    assert.equal(calls.length, before);
    coordinator.observeNativeMessage("classification-review-native", { method: "turn/started", params: { threadId: "owned-thread", turn: { id: "owned-turn" } } });
    await waitUntil(() => coordinator.status().threads.some(entry => entry.phase === "active"));
    const metadata = JSON.stringify({ thread_id: "owned-thread", turn_id: "owned-turn" });
    assert.equal((await request("/backend-api/codex/models", "GET", { "x-codex-turn-metadata": metadata })).status, 200);
    assert.equal((await request("/backend-api/codex/images/edits", "POST", { "x-codex-turn-metadata": metadata }, "owned-body")).status, 200);
    assert.equal((await request("/backend-api/codex/memories/trace_summarize", "POST", { "x-codex-turn-metadata": metadata }, "owned-body")).status, 200);
    const upstreamCount = calls.length;
    assert.equal((await request("/backend-api/codex/models", "GET", { "x-codex-turn-metadata": JSON.stringify({ thread_id: "owned-thread", turn_id: "owned-wrong" }) })).status, 503);
    assert.equal(calls.length, upstreamCount);
    coordinator.observeNativeMessage("classification-review-native", { method: "turn/completed", params: { threadId: "owned-thread", turn: { id: "owned-turn", status: "completed" } } });
    await waitUntil(() => coordinator.status().threads.some(entry => entry.phase === "terminal"));
    assert.equal((await request("/backend-api/codex/models", "GET", { "x-codex-turn-metadata": metadata })).status, 503);
    assert.equal((await request("/backend-api/codex/memories/trace_summarize", "POST", { "x-codex-turn-metadata": metadata })).status, 503);
    assert.equal(calls.length, upstreamCount);
  });

  await context.test("ordinary refusal is forwarded once and auxiliary SSE completes unchanged", async () => {
    const before = calls.length;
    const denied = await request("/backend-api/codex/images/generations?mode=denied", "POST", {}, "owned-body");
    assert.equal(denied.status, 401);
    assert.equal(denied.headers["www-authenticate"], "owned-fixture");
    assert.equal(calls.length, before + 1);
    const stream = await request("/backend-api/codex/images/generations?mode=stream", "POST", {}, "owned-body");
    assert.equal(stream.status, 200);
    assert.equal(stream.bytes.toString(), "data: owned-first\n\ndata: owned-last\n\n");
  });

  await context.test("response and request cancellation reach the owned upstream and release accounting", async () => {
    await new Promise((resolve, reject) => {
      const client = http.request({ hostname: "127.0.0.1", port: endpoint.port, path: "/backend-api/codex/images/edits?mode=cancel", method: "POST" }, response => {
        response.once("data", () => { response.destroy(); client.destroy(); resolve(); });
      });
      client.once("error", error => { if (error.code !== "ECONNRESET") reject(error); });
      client.end("owned-body");
    });
    await waitUntil(() => streamClosed);
    const before = calls.length;
    const upload = http.request({ hostname: "127.0.0.1", port: endpoint.port, path: "/backend-api/codex/images/edits?mode=upload", method: "POST" });
    upload.on("error", () => {});
    upload.write(Buffer.alloc(256, 7));
    await waitUntil(() => calls.length > before);
    upload.destroy();
    await waitUntil(() => uploadClosed);
    await waitUntil(() => coordinator.status().threads.every(entry => entry.activeHttp === 0));
    assert.equal((await request("/backend-api/codex/models")).status, 200);
  });
});
