import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { createModelStreamFailureDiagnostics } from "../src/model-stream-failure-diagnostics.mjs";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";

const PRIVATE_VALUES = [
  "fixture-private-cookie-71", "fixture-private-token-72", "fixture-private-account-73",
  "203.0.113.74", "fixture-private-query-75", "fixture-private-message-76",
  "fixture-private-thread-77", "fixture-private-turn-78", "fixture-private-header-79",
];

function assertPrivateValuesAbsent(value) {
  const serialized = JSON.stringify(value);
  for (const privateValue of PRIVATE_VALUES) assert.equal(serialized.includes(privateValue), false, privateValue);
}

function assertClosedValues(value) {
  const enumerations = new Set([
    "unknown", "connection", "request_sending", "awaiting_response", "response_headers",
    "response_body", "stream_frames", "stream_progress", "request", "response", "ECONNRESET",
    "html", "json", "sse", "other", "challenge", "authentication", "security", "usage_limit", "multiple",
  ]);
  for (const field of Object.values(value)) {
    if (typeof field === "string") assert.ok(enumerations.has(field), field);
    else assert.ok(typeof field === "boolean" || (Number.isSafeInteger(field) && field >= 0));
  }
}

test("diagnostic stages follow observed connection, upload, response and stream progress", () => {
  const diagnostic = createModelStreamFailureDiagnostics();
  assert.equal(diagnostic.snapshot().stage, "unknown");
  diagnostic.socketAssigned();
  assert.equal(diagnostic.snapshot().stage, "connection");
  diagnostic.connected();
  assert.equal(diagnostic.snapshot().stage, "request_sending");
  diagnostic.requestFinished(42);
  assert.equal(diagnostic.snapshot().stage, "awaiting_response");
  diagnostic.responseStarted(200, { "content-type": "text/event-stream" });
  assert.equal(diagnostic.snapshot().stage, "response_headers");
  diagnostic.responseData(64);
  assert.equal(diagnostic.snapshot().stage, "response_body");
  assert.equal(diagnostic.snapshot({ frames: 1 }).stage, "stream_frames");
  assert.equal(diagnostic.snapshot({ frames: 1, progressObserved: true }).stage, "stream_progress");
  assert.equal(diagnostic.snapshot().tlsObserved, false);
  diagnostic.connected(true);
  assert.equal(diagnostic.snapshot().tlsObserved, true);
});

test("unknown HTML plus Cloudflare evidence stays unknown and arbitrary input cannot escape", () => {
  const diagnostic = createModelStreamFailureDiagnostics();
  diagnostic.responseStarted(403, {
    "content-type": `text/html; private=${PRIVATE_VALUES[8]}`,
    "cf-ray": PRIVATE_VALUES[3], "set-cookie": PRIVATE_VALUES[0], authorization: PRIVATE_VALUES[1],
    location: `https://fixture.invalid/?secret=${PRIVATE_VALUES[4]}`,
  });
  diagnostic.httpFailure(Buffer.from(PRIVATE_VALUES.join(" ")), {
    code: PRIVATE_VALUES[2], message: PRIVATE_VALUES[5], category: PRIVATE_VALUES[6],
  });
  diagnostic.transportError(PRIVATE_VALUES[7], { code: PRIVATE_VALUES[8], message: PRIVATE_VALUES[5] });
  const snapshot = diagnostic.snapshot({ frames: PRIVATE_VALUES[0], progressObserved: PRIVATE_VALUES[1] });
  assert.equal(snapshot.httpRefusalSignal, "unknown");
  assert.equal(snapshot.cfRayHeaderPresent, true);
  assert.equal(snapshot.transportCode, "unknown");
  assert.equal(snapshot.errorSource, "unknown");
  assertPrivateValuesAbsent(snapshot);
  assertClosedValues(snapshot);
});

test("explicit refusal signals stay independent and a snapshot cannot mutate subsequent evidence", () => {
  const diagnostic = createModelStreamFailureDiagnostics();
  diagnostic.responseStarted(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
  diagnostic.httpFailure(Buffer.from("/cdn-cgi/challenge-platform/"), { code: "cyber_policy", category: "usage_limit" });
  const snapshot = diagnostic.snapshot();
  assert.equal(snapshot.httpRefusalSignal, "multiple");
  assert.equal(snapshot.challengeSignal, true);
  assert.equal(snapshot.securitySignal, true);
  assert.equal(snapshot.usageLimitSignal, true);
  snapshot.challengeSignal = false;
  assert.equal(diagnostic.snapshot().challengeSignal, true);
  assertClosedValues(snapshot);
});

test("challenge scanning and counters are bounded and successful HTTP has no refusal signal", () => {
  const diagnostic = createModelStreamFailureDiagnostics();
  diagnostic.responseStarted(403, { "content-type": "text/html" });
  diagnostic.httpFailure(Buffer.from("x".repeat(64 * 1024) + "/cdn-cgi/challenge-platform/"));
  diagnostic.responseData(Number.MAX_SAFE_INTEGER);
  diagnostic.responseData(42);
  diagnostic.requestFinished(Infinity);
  assert.equal(diagnostic.snapshot().httpRefusalSignal, "unknown");
  assert.equal(diagnostic.snapshot().responseBytes, Number.MAX_SAFE_INTEGER);
  assert.equal(diagnostic.snapshot().requestBodyBytes, 0);
  const successful = createModelStreamFailureDiagnostics();
  successful.responseStarted(200, { "cf-mitigated": "challenge", "www-authenticate": "Bearer" });
  successful.httpFailure(Buffer.from("/cdn-cgi/challenge-platform/"), { code: "insufficient_quota" });
  assert.equal(successful.snapshot().httpRefusalSignal, "unknown");
});

async function startFixture(context, handler) {
  const events = [];
  const upstream = http.createServer(handler);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = createCodexModelStreamProxy({ port: 0,
    upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    onEvent: event => events.push(event),
  });
  context.after(async () => {
    await proxy.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });
  await proxy.start();
  return { events, proxy };
}

async function sendRequest(proxy) {
  const body = Buffer.from(JSON.stringify({ stream: true,
    input: [{ role: "user", content: [{ type: "input_text", text: PRIVATE_VALUES[2] }] }],
    tools: [{ type: "function", name: "safe", parameters: { type: "object" } }],
  }));
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: "127.0.0.1", port: proxy.status().port,
      path: `/backend-api/codex/responses?private=${PRIVATE_VALUES[4]}`, method: "POST",
      headers: { "content-type": "application/json", "content-length": body.length,
        authorization: `Bearer ${PRIVATE_VALUES[1]}`, cookie: PRIVATE_VALUES[0],
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn",
          thread_id: PRIVATE_VALUES[6], turn_id: PRIVATE_VALUES[7] }),
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

function attemptEvidence(events) {
  const event = events.find(candidate => candidate.type === "turn_attempt_finished");
  assert.ok(event);
  assert.match(event.requestId, /^[a-f0-9-]{36}$/u);
  assert.match(event.threadHash, /^[a-f0-9]{16}$/u);
  assert.match(event.turnHash, /^[a-f0-9]{16}$/u);
  assert.equal(event.correlation, "exact");
  assertPrivateValuesAbsent(events);
  assertClosedValues(event.failureDiagnostics);
  return event;
}

const refusals = [
  { name: "unknown HTML and CF header", body: `<html>${PRIVATE_VALUES.join(" ")}</html>`, format: "text/html",
    expected: "unknown", kind: "retryable_failure", retry: true },
  { name: "explicit HTML challenge marker", body: `<html>/cdn-cgi/challenge-platform/ ${PRIVATE_VALUES[5]}</html>`,
    format: "text/html", expected: "challenge", kind: "retryable_failure", retry: true },
  { name: "explicit challenge header", body: "<html>opaque</html>", format: "text/html",
    headers: { "cf-mitigated": "challenge" }, expected: "challenge", kind: "retryable_failure", retry: true },
  { name: "authentication code", error: { code: "invalid_api_key", message: PRIVATE_VALUES[5] },
    expected: "authentication", kind: "permanent_failure", retry: false },
  { name: "security code wins over quota wording", error: { code: "cyber_policy", message: `quota exceeded ${PRIVATE_VALUES[5]}` },
    expected: "security", kind: "permanent_failure", retry: false },
  { name: "quota code", error: { code: "insufficient_quota", message: PRIVATE_VALUES[5] },
    expected: "usage_limit", kind: "usage_limit", retry: false },
];

for (const refusal of refusals) test(`synthetic HTTP403: ${refusal.name}`, { timeout: 5000 }, async context => {
  let requests = 0;
  const { proxy, events } = await startFixture(context, (request, response) => {
    requests += 1;
    request.resume();
    response.writeHead(403, { "content-type": refusal.format ?? "application/json",
      "set-cookie": PRIVATE_VALUES[0], "cf-ray": PRIVATE_VALUES[8], ...refusal.headers });
    response.end(refusal.body ?? JSON.stringify({ error: refusal.error }));
  });
  await sendRequest(proxy);
  const event = attemptEvidence(events);
  assert.equal(requests, 1);
  assert.equal(event.kind, refusal.kind);
  assert.equal(event.reason === "HTTP_403" || event.reason === refusal.error?.code, true);
  assert.equal(event.failureDiagnostics.httpRefusalSignal, refusal.expected);
  assert.equal(event.failureDiagnostics.statusCode, 403);
  assert.equal(event.failureDiagnostics.stage, "response_body");
  const retry = events.find(candidate => candidate.type === "native_retry_signal");
  assert.equal(Boolean(retry), refusal.retry);
  if (retry) {
    assert.deepEqual(retry.failureDiagnostics, event.failureDiagnostics);
    assert.equal(retry.requestId, event.requestId);
    assert.equal(retry.threadHash, event.threadHash);
    assert.equal(retry.turnHash, event.turnHash);
    assert.equal(retry.category, "transient");
  }
});

test("reset before HTTP response is a request error after local request handoff", { timeout: 5000 }, async context => {
  const { proxy, events } = await startFixture(context, request => request.socket.destroy());
  await sendRequest(proxy);
  const event = attemptEvidence(events);
  assert.equal(event.reason, "ECONNRESET");
  assert.equal(event.endCause, "upstream_transport");
  assert.equal(event.failureDiagnostics.errorSource, "request");
  assert.equal(event.failureDiagnostics.transportCode, "ECONNRESET");
  assert.equal(event.failureDiagnostics.responseStarted, false);
  assert.equal(event.failureDiagnostics.stage, "awaiting_response");
  assert.equal(event.failureDiagnostics.httpRefusalSignal, "unknown");
});

test("truncated HTTP403 body records response reset and preserves the original terminal branch", { timeout: 5000 }, async context => {
  const { proxy, events } = await startFixture(context, (request, response) => {
    request.resume();
    response.writeHead(403, { "content-type": "text/html", "content-length": 4096 });
    response.write(`<html>${PRIVATE_VALUES[5]}`);
    setTimeout(() => response.destroy(), 20);
  });
  await sendRequest(proxy);
  const event = attemptEvidence(events);
  assert.equal(event.reason, "HTTP_403");
  assert.equal(event.kind, "permanent_failure");
  assert.equal(event.failureDiagnostics.errorSource, "response");
  assert.equal(event.failureDiagnostics.transportCode, "ECONNRESET");
  assert.equal(event.failureDiagnostics.stage, "response_body");
  assert.equal(event.failureDiagnostics.httpRefusalSignal, "unknown");
  assert.equal(events.some(candidate => candidate.type === "native_retry_signal"), false);
});

test("HTTP403 and request reset retain 1/2 retry correlation then a real completion resets attempts", { timeout: 5000 }, async context => {
  let requests = 0;
  const { proxy, events } = await startFixture(context, (request, response) => {
    requests += 1;
    request.resume();
    if (requests === 1) {
      response.writeHead(403, { "content-type": "text/html", "cf-ray": PRIVATE_VALUES[8] });
      response.end("<html>opaque</html>");
    } else if (requests === 2) request.socket.destroy();
    else {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"type":"response.completed"}\n\n');
    }
  });
  await sendRequest(proxy);
  await sendRequest(proxy);
  assert.ok((await sendRequest(proxy)).includes("response.completed"));
  await sendRequest(proxy);
  const retries = events.filter(event => event.type === "native_retry_signal");
  assert.deepEqual(retries.map(event => event.attemptNumber), [1, 2]);
  assert.deepEqual(retries.map(event => event.category), ["transient", "network"]);
  assert.notEqual(retries[0].requestId, retries[1].requestId);
  assert.equal(retries[0].threadHash, retries[1].threadHash);
  assert.equal(retries[0].turnHash, retries[1].turnHash);
  assert.equal(retries[0].failureDiagnostics.httpRefusalSignal, "unknown");
  assert.equal(retries[1].failureDiagnostics.errorSource, "request");
  assert.equal(events.filter(event => event.type === "turn_attempt_started").at(-1).attemptNumber, 1);
  assert.equal(requests, 4);
  assertPrivateValuesAbsent(events);
});

test("reset after SSE progress is a response error with unchanged native retry", { timeout: 5000 }, async context => {
  const { proxy, events } = await startFixture(context, (request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: PRIVATE_VALUES[5] })}\n\n`);
    setTimeout(() => response.destroy(), 20);
  });
  const body = await sendRequest(proxy);
  assert.ok(body.includes(PRIVATE_VALUES[5]));
  const event = attemptEvidence(events);
  assert.equal(event.reason, "ECONNRESET");
  assert.equal(event.failureDiagnostics.errorSource, "response");
  assert.equal(event.failureDiagnostics.stage, "stream_progress");
  assert.equal(event.failureDiagnostics.responseFrames, 1);
  assert.equal(event.failureDiagnostics.progressObserved, true);
  assert.equal(events.filter(candidate => candidate.type === "native_retry_signal").length, 1);
});

test("reset before completion cannot expose a buffered executable tool or dispatch a side effect", { timeout: 5000 }, async context => {
  let requests = 0;
  const { proxy, events } = await startFixture(context, (request, response) => {
    requests += 1;
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    const item = { type: "function_call", id: "fixture-tool", call_id: "fixture-call", name: "safe", arguments: "{}" };
    response.write(`data: ${JSON.stringify({ type: "response.output_item.added", item })}\n\n`);
    response.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
    setTimeout(() => response.destroy(), 20);
  });
  const body = await sendRequest(proxy);
  const executableFrames = body.split("\n").filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6))).filter(event => event.type === "response.output_item.done" && event.item?.type === "function_call");
  assert.equal(executableFrames.length, 0);
  assert.equal(requests, 1);
  const event = attemptEvidence(events);
  assert.equal(event.sawExecutableToolDone, true);
  assert.equal(event.failureDiagnostics.errorSource, "response");
  assert.equal(event.phase, "tool_completion_barrier");
});
