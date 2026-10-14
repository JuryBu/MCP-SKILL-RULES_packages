import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { createRequestObservation } from "../src/model-observation-hooks.mjs";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";

test("missing response media type is provisional, explicit unsupported type stays evidence", () => {
  for (const contentType of [undefined, "", "  ", "text/html", "text/event-stream; charset=utf-8", "application/json"]) {
    const records = [];
    const observation = createRequestObservation({ emit: entry => records.push(entry), producerInstance: "fixture", requestId: "request", endpoint: "responses" });
    observation.parsed("model-A");
    observation.submitted();
    observation.headers(contentType === undefined ? {} : { "content-type": contentType }, 200);
    observation.event({ type: "response.completed", response: { model: "model-A" } });
    const expected = !contentType?.trim() ? "pending" : contentType.includes("event-stream") ? "sse" : contentType.includes("json") ? "json" : "unsupported";
    assert.equal(records.find(entry => entry.phase === "upstream.headers").protocol, expected);
    assert.equal(records.at(-1).protocol, "sse");
  }
});

test("unsupported endpoint is not reclassified by missing response media type", () => {
  const records = [];
  const observation = createRequestObservation({ emit: entry => records.push(entry), producerInstance: "fixture", requestId: "request", endpoint: "unsupported" });
  observation.headers({}, 200);
  assert.equal(records.at(-1).protocol, "unsupported");
});

test("real HTTP missing media type produces comparable SSE without hiding explicit conflicts", async () => {
  for (const contentType of [null, "text/html"]) {
    const records = [];
    const wire = ["response.created", "response.completed"].map(type => `data: ${JSON.stringify({ type, response: { id: "fixture", model: "model-A", output: [] } })}\n\n`).join("");
    const upstream = http.createServer((request, response) => {
      request.resume();
      request.once("end", () => {
        response.writeHead(200, contentType ? { "content-type": contentType } : {});
        response.end(wire);
      });
    });
    await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const proxy = createCodexModelStreamProxy({ upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, host: "127.0.0.1", port: 0,
      firstProgressTimeoutMs: 1500, progressIdleTimeoutMs: 1500, onModelObservation: entry => records.push(entry) });
    try {
      const status = await proxy.start();
      const response = await fetch(`http://127.0.0.1:${status.port}/backend-api/codex/responses`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "model-A", stream: true, input: "fixture" }), signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), wire);
      assert.equal(records.find(entry => entry.phase === "upstream.headers").protocol, contentType ? "unsupported" : "pending");
      assert.equal(records.find(entry => entry.phase === "response.completed").protocol, "sse");
      assert.equal(proxy.status().counters.actualCompletions, 1);
    } finally {
      await proxy.stop();
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
    }
  }
});
