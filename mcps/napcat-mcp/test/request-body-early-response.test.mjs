import assert from "node:assert/strict";
import http from "node:http";
import { Duplex } from "node:stream";
import test from "node:test";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

class BlockedSocket extends Duplex {
  constructor(responseWire) {
    super();
    this.responseWire = responseWire;
  }
  _read() {}
  _write(chunk, encoding, callback) {
    this.pendingWrite = callback;
    if (!this.replied) {
      this.replied = true;
      setImmediate(() => { if (!this.destroyed) this.push(Buffer.from(this.responseWire)); });
    }
  }
  _destroy(error, callback) {
    this.requestWritableFinishedAtDestroy = this.request?.writableFinished;
    const pendingWrite = this.pendingWrite;
    this.pendingWrite = null;
    pendingWrite?.(error ?? new Error("fixture cleanup"));
    callback(null);
  }
  setKeepAlive() {}
  setNoDelay() {}
  setTimeout() { return this; }
}

test("terminal responses close unfinished uploads without retaining encoded quota", async context => {
  const scenarios = [
    { name: "turn early HTTP error", path: "/v1/responses", requestKind: "turn", stream: true,
      statusCode: 413, responseBody: '{"error":{"message":"too large"}}' },
    { name: "unary compaction early success", path: "/v1/responses/compact", requestKind: "compaction", stream: false,
      statusCode: 200, responseBody: '{"id":"fixture-result"}' },
    { name: "sampling compaction early HTTP error", path: "/v1/responses", requestKind: "compaction", stream: true,
      statusCode: 413, responseBody: '{"error":{"code":"invalid_request","message":"invalid request"}}' },
  ];
  for (const scenario of scenarios) {
    await context.test(scenario.name, async () => {
      const originalRequest = http.request;
      const upstreams = [];
      const responseWire = `HTTP/1.1 ${scenario.statusCode} Fixture\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(scenario.responseBody)}\r\nConnection: keep-alive\r\n\r\n${scenario.responseBody}`;
      http.request = function (target, options, ...rest) {
        if (target instanceof URL && target.hostname === "budget-fixture.invalid") {
          const socket = new BlockedSocket(responseWire);
          const upstream = originalRequest.call(this, target, { ...options, createConnection: () => socket }, ...rest);
          socket.request = upstream;
          upstreams.push(upstream);
          return upstream;
        }
        return originalRequest.call(this, target, options, ...rest);
      };
      const body = Buffer.from(JSON.stringify({ model: "fixture", input: "x".repeat(65536), stream: scenario.stream }));
      const events = [];
      const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: "http://budget-fixture.invalid",
        maxBufferedRequestBytes: body.length, maxTotalRequestBytes: body.length,
        firstProgressTimeoutMs: 1000, progressIdleTimeoutMs: 1000, uploadAllowanceMsPerMiB: 0,
        onEvent: event => events.push(event) });
      const send = () => new Promise((resolve, reject) => {
        const request = originalRequest({ host: "127.0.0.1", port: proxy.status().port, path: scenario.path, method: "POST",
          headers: { "content-type": "application/json", "content-length": body.length,
            "x-codex-turn-metadata": JSON.stringify({ request_kind: scenario.requestKind,
              thread_id: "early-response-fixture", turn_id: scenario.name }) } }, response => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", chunk => { text += chunk; });
          response.once("end", () => resolve({ statusCode: response.statusCode, text }));
          response.once("error", reject);
        });
        request.once("error", reject);
        request.end(body);
      });
      try {
        await proxy.start();
        const first = await send();
        for (let attempt = 0; attempt < 100 && proxy.status().requestBuffer.usedBytes !== 0; attempt += 1) await delay(5);
        assert.equal(proxy.status().activeRequests, 0);
        assert.equal(proxy.status().requestBuffer.usedBytes, 0);
        assert.equal(upstreams.length, 1);
        assert.equal(upstreams[0].socket.requestWritableFinishedAtDestroy, false);
        assert.equal(upstreams[0].destroyed, true);
        assert.equal(upstreams[0].res.complete, true);
        assert.equal(events.some(event => event.type === "upstream_request_finished"), false);
        assert.equal(events.find(event => event.type === "request_observed")?.requestKind, scenario.requestKind);
        const second = await send();
        assert.equal(upstreams.length, 2);
        assert.equal(second.statusCode, first.statusCode);
        assert.doesNotMatch(second.text, /REQUEST_BUFFER_BUSY/u);
        if (scenario.requestKind === "compaction" && !scenario.stream) {
          assert.equal(first.statusCode, scenario.statusCode);
          assert.equal(first.text, scenario.responseBody);
          assert.equal(second.text, scenario.responseBody);
        } else if (scenario.requestKind === "compaction") {
          for (const result of [first, second]) {
            const frames = result.text.split(/\r?\n/u).filter(line => line.startsWith("data: "))
              .map(line => line.slice(6)).filter(data => data !== "[DONE]").map(data => JSON.parse(data));
            assert.equal(result.statusCode, 200);
            assert.ok(frames.some(frame => frame.type === "response.failed" && /compaction/u.test(frame.response?.error?.code ?? "")));
            assert.equal(frames.some(frame => frame.type === "response.completed" || frame.item?.type === "message"), false);
          }
          assert.equal(events.some(event => event.type === "compaction_stream_terminal_failure"), true);
        }
        for (let attempt = 0; attempt < 100 && proxy.status().requestBuffer.usedBytes !== 0; attempt += 1) await delay(5);
        assert.equal(proxy.status().requestBuffer.usedBytes, 0);
        assert.equal(upstreams[1].socket.requestWritableFinishedAtDestroy, false);
        assert.equal(upstreams[1].destroyed, true);
      } finally {
        http.request = originalRequest;
        for (const upstream of upstreams) upstream.destroy();
        await proxy.stop();
      }
    });
  }
});
