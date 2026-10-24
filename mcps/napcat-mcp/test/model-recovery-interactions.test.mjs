import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";
import { createIncrementalResponsesTransport } from "../src/incremental-responses-transport.mjs";
import { createStreamRecovery } from "../src/codex-stream-recovery.mjs";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws");
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const message = text => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const answer = text => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const frame = event => `data: ${JSON.stringify(event)}\n\n`;
const parseEvents = text => text.split(/\r?\n\r?\n/u).flatMap(value => {
  try { return [JSON.parse(value.split("\n").find(line => line.startsWith("data:"))?.slice(5))]; }
  catch { return []; }
});

async function until(predicate, description, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(5);
  }
}

function complete(socket, id, text, output = [answer(text)]) {
  socket.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress" } }));
  if (text) socket.send(JSON.stringify({ type: "response.output_text.delta", delta: text }));
  socket.send(JSON.stringify({ type: "response.completed", response: { id, status: "completed", output } }));
}

function httpComplete(response, id, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(frame({ type: "response.created", response: { id, status: "in_progress" } })
    + frame({ type: "response.output_text.delta", delta: text })
    + frame({ type: "response.completed", response: { id, status: "completed", output: [answer(text)] } }));
}

function transient(response, status) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { code: "server_error", message: `temporary-${status}` } }));
}

async function fixture(context, { onPacket, onHttp, transportOptions = {}, proxyOptions = {} } = {}) {
  const packets = [];
  const connections = [];
  const httpRequests = [];
  const recovery = [];
  const events = [];
  const observations = [];
  const operationStates = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const entry = { path: request.url, body: Buffer.concat(chunks), headers: request.headers, index: httpRequests.length + 1 };
      httpRequests.push(entry);
      if (onHttp) onHttp(entry, response);
      else httpComplete(response, `http_${entry.index}`, "HTTP_INTERACTION_OK");
    });
  });
  const websocket = new WebSocketServer({ server });
  websocket.on("connection", (socket, request) => {
    const connection = { index: connections.length + 1, socket, network: request.socket };
    connections.push(connection);
    socket.on("error", () => {});
    socket.on("message", raw => {
      const entry = { packet: JSON.parse(raw), socket, connection: connection.index, index: packets.length + 1 };
      packets.push(entry);
      if (onPacket) onPacket(entry);
      else complete(socket, `ws_${entry.index}`, "WS_INTERACTION_OK");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const transport = createIncrementalResponsesTransport({ responseTimeoutMs: 2000, ...transportOptions });
  const fallbackCompletions = [];
  const completeFallback = transport.completeHttpFallback.bind(transport);
  transport.completeHttpFallback = (...args) => {
    const returned = completeFallback(...args);
    fallbackCompletions.push({ operationId: args[0], returned, operation: transport.getOperation(args[0]) });
    return returned;
  };
  const invalidations = [];
  const invalidate = transport.invalidate.bind(transport);
  transport.invalidate = (...args) => { invalidations.push(args[0]); return invalidate(...args); };
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: origin,
    incrementalTransport: transport, incrementalUpstreamUrl: `${origin.replace("http:", "ws:")}/v1/responses`,
    managedRecovery: true, managedRetryBaseMs: 10, fastRetryDelayMs: 0,
    firstProgressTimeoutMs: 2000, firstLastProgressTimeoutMs: 2000, progressIdleTimeoutMs: 2000,
    onEvent: event => events.push(event), onModelObservation: event => observations.push(event),
    onRecoveryState: event => recovery.push(event),
    onOperationStateChange: state => operationStates.push(structuredClone(state)), ...proxyOptions });
  await proxy.start();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await proxy.stop();
    for (const client of websocket.clients) client.terminate();
    await new Promise(resolve => websocket.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(proxy.status().activeRequests, 0);
    assert.equal(proxy.status().requestBuffer.usedBytes, 0);
    for (const field of ["sessions", "connections", "active", "queued", "receiving", "retainedBytes"]) assert.equal(transport.status()[field], 0, field);
    assert.ok(connections.every(connection => connection.network.destroyed));
    context.diagnostic("cleanup: active/requestBuffer/sessions/connections/queued/receiving/retainedBytes=0; owned TCP destroyed");
  };
  context.after(close);
  const request = ({ input = [message("original")], threadId = "interaction-thread", turnId = "interaction-turn",
    signal, kind = "turn", path = "/v1/responses", stream = true, compressed = true, tools = [] } = {}) => {
    const body = Buffer.from(JSON.stringify({ model: "fixture-model", instructions: "Recovery interaction fixture", tools, stream, input }));
    const encoded = compressed ? zstdCompressSync(body) : body;
    const done = new Promise((resolve, reject) => {
      const outgoing = http.request({ hostname: "127.0.0.1", port: proxy.status().port, method: "POST", path, signal,
        headers: { "content-type": "application/json", "content-length": encoded.length,
          ...(compressed ? { "content-encoding": "zstd" } : {}), authorization: "Bearer interaction-fixture",
          "chatgpt-account-id": "interaction-fixture", "user-agent": "fixture-native-0.159",
          "x-codex-turn-metadata": JSON.stringify({ request_kind: kind, thread_id: threadId, turn_id: turnId }) } }, incoming => {
        let text = "";
        incoming.on("data", chunk => { text += chunk; });
        incoming.once("error", reject);
        incoming.once("end", () => resolve({ status: incoming.statusCode, text, events: parseEvents(text) }));
      });
      outgoing.once("error", reject);
      outgoing.end(encoded);
    });
    done.catch(() => {});
    return { body, encoded, done };
  };
  return { proxy, transport, request, close, packets, connections, httpRequests, recovery, events, observations, operationStates,
    fallbackCompletions, invalidations };
}

test("locally generated notice IDs are not sent as persisted server items and delta reuse survives", { timeout: 7000 }, async context => {
  const localEvents = parseEvents(createStreamRecovery("11111111-2222-4333-8444-555555555555").finish("Stored local failure notice"));
  const notice = localEvents.find(event => event.type === "response.completed").response.output[0];
  const userMessage = { ...message("real user text"), id: "msg_proxy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  const serverMessage = { ...answer("real server text"), id: "msg_server_preserve" };
  const reference = { type: "item_reference", id: "msg_server_reference" };
  const reasoning = { type: "reasoning", id: "rs_server_preserve", summary: [], encrypted_content: "opaque-preserved" };
  const input = [userMessage, notice, serverMessage, reference, reasoning];
  const before = structuredClone(input);
  const setup = await fixture(context);
  assert.match((await setup.request({ input }).done).text, /WS_INTERACTION_OK/u);
  const sent = setup.packets[0].packet.input;
  const { id: localId, ...noticeWithoutLocalId } = notice;
  assert.deepEqual(sent, [userMessage, noticeWithoutLocalId, serverMessage, reference, reasoning]);
  assert.deepEqual(input, before);
  const followup = message("followup after local notice");
  const second = await setup.request({ input: [...input, answer("WS_INTERACTION_OK"), followup], turnId: "notice-followup" }).done;
  assert.match(second.text, /WS_INTERACTION_OK/u);
  assert.deepEqual(setup.packets[1].packet.input, [followup]);
  assert.equal(setup.httpRequests.length, 0);
  assert.equal(setup.connections.length, 1);
});

for (const code of ["unsupported_parameter", "unsupported_value"]) {
test(`prewarmed ${code} without output falls back once with the full payload and keeps the next request on HTTP`, { timeout: 7000 }, async context => {
  const privateMessage = "PRIVATE_UPSTREAM_COMPATIBILITY_MESSAGE";
  const privateInput = "PRIVATE_COMPATIBILITY_INPUT";
  const parameter = code === "unsupported_parameter" ? "tools[0].type" : "input[0].text\nPRIVATE_INVALID_PARAM";
  const tools = [{ type: "function", name: "fixture_tool", description: "PRIVATE_TOOL_DESCRIPTION", parameters: { type: "object", properties: { value: { type: "string" } } } }];
  const setup = await fixture(context, { transportOptions: { maxMessageBytes: 1800, allowImagePrewarm: true },
    proxyOptions: { incrementalImagesEnabled: true }, onPacket(entry) {
    const id = `compatibility_${entry.index}`;
    if (entry.packet.generate === false) return complete(entry.socket, id, null, []);
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress" } }));
    entry.socket.send(JSON.stringify({ type: "response.failed", response: { id, status: "failed", output: [],
      error: { code, param: parameter, message: privateMessage } } }));
  } });
  const input = [message(`${privateInput}${"a".repeat(800)}`), message("b".repeat(800)), message("c".repeat(800))];
  input[1].content.push({ type: "input_image", image_url: "data:image/png;base64,Zml4dHVyZQ==" });
  const original = setup.request({ input, tools });
  const result = await original.done;
  assert.equal(setup.packets.filter(entry => entry.packet.generate === false).length, 2, JSON.stringify(setup.recovery));
  assert.equal(setup.packets.length, 3);
  assert.ok(setup.packets[2].packet.previous_response_id);
  assert.equal(setup.httpRequests.length, 1);
  assert.deepEqual(setup.httpRequests[0].body, original.encoded);
  assert.deepEqual(zstdDecompressSync(setup.httpRequests[0].body), original.body);
  assert.deepEqual(JSON.parse(zstdDecompressSync(setup.httpRequests[0].body)).tools, tools);
  assert.ok(setup.packets.every(entry => JSON.stringify(entry.packet.tools) === JSON.stringify(tools)));
  assert.match(result.text, /HTTP_INTERACTION_OK/u);
  assert.equal(result.events.filter(event => event.type === "response.completed").length, 1);
  assert.equal(setup.proxy.status().counters.syntheticCompletions, 0);
  assert.equal(setup.fallbackCompletions.length, 1);
  assert.equal(setup.fallbackCompletions[0].returned, true);
  assert.equal(setup.fallbackCompletions[0].operation.state, "completed");
  const compatibility = setup.events.filter(event => event.type === "websocket_compatibility_fallback");
  assert.equal(compatibility.length, 1);
  assert.equal(compatibility[0].code, code);
  assert.equal(compatibility[0].terminalOutcome, "failed_no_output");
  assert.equal(compatibility[0].parameter, code === "unsupported_parameter" ? parameter : null);
  const diagnostics = JSON.stringify([setup.events, setup.observations, setup.recovery]);
  for (const secret of [privateMessage, privateInput, "PRIVATE_TOOL_DESCRIPTION", "PRIVATE_INVALID_PARAM", "data:image/png"]) assert.equal(diagnostics.includes(secret), false, secret);
  assert.ok(setup.recovery.some(event => event.reason === "websocket_parameters_require_http"));
  const next = setup.request({ input: [message("next request during cooldown")], tools, turnId: "compatibility-cooldown-next" });
  assert.match((await next.done).text, /HTTP_INTERACTION_OK/u);
  assert.equal(setup.packets.length, 3);
  assert.equal(setup.httpRequests.length, 2);
  assert.deepEqual(setup.httpRequests[1].body, next.encoded);
  assert.equal(setup.events.filter(event => event.type === "websocket_compatibility_fallback").length, 1);
  assert.equal(setup.proxy.status().operationLedger.protectedOperations, 0);
});
}

test("compatibility fallback stops when the one HTTP attempt is also permanent", { timeout: 7000 }, async context => {
  const setup = await fixture(context, { onPacket(entry) {
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "compatibility_permanent", status: "in_progress" } }));
    entry.socket.send(JSON.stringify({ type: "response.failed", response: { id: "compatibility_permanent", status: "failed", output: [],
      error: { code: "unsupported_parameter", param: "tools[0].type" } } }));
  }, onHttp(entry, response) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "unsupported_parameter", param: "tools[0].type", message: "PRIVATE_HTTP_PERMANENT_MESSAGE" } }));
  } });
  const original = setup.request();
  await original.done;
  await delay(30);
  assert.equal(setup.packets.length, 1);
  assert.equal(setup.httpRequests.length, 1);
  assert.deepEqual(setup.httpRequests[0].body, original.encoded);
  assert.equal(setup.events.filter(event => event.type === "websocket_compatibility_fallback").length, 1);
  assert.ok(setup.recovery.some(event => event.phase === "failed" && event.reason === "unsupported_parameter"));
  assert.equal(setup.proxy.status().counters.actualCompletions, 0);
  assert.equal(JSON.stringify(setup.events).includes("PRIVATE_HTTP_PERMANENT_MESSAGE"), false);
});

for (const code of ["unsupported_parameter", "unsupported_value"]) {
for (const [label, failure] of [
  ...[401, 402, 403, 451].map(status => [`status ${status}`, { status }]),
  ["safety message", { message: "Request blocked by safety policy: PRIVATE_SAFETY_DETAIL" }],
  ["authentication message", { message: "Authentication failed: PRIVATE_AUTH_DETAIL" }],
  ["quota message", { message: "Insufficient quota: PRIVATE_QUOTA_DETAIL" }],
]) {
test(`${code} with explicit ${label} never falls back to HTTP`, { timeout: 7000 }, async context => {
  const setup = await fixture(context, { onPacket(entry) {
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "status_conflict", status: "in_progress" } }));
    entry.socket.send(JSON.stringify({ type: "response.failed", response: { id: "status_conflict", status: "failed", output: [],
      error: { code, ...failure, param: "generate" } } }));
  } });
  await setup.request().done;
  assert.equal(setup.packets.length, 1);
  assert.equal(setup.httpRequests.length, 0);
  assert.equal(setup.events.filter(event => event.type === "websocket_compatibility_fallback").length, 0);
  assert.equal(setup.fallbackCompletions.length, 0);
  for (const privateValue of ["PRIVATE_SAFETY_DETAIL", "PRIVATE_AUTH_DETAIL", "PRIVATE_QUOTA_DETAIL"]) {
    assert.equal(JSON.stringify([setup.events, setup.recovery, setup.observations]).includes(privateValue), false);
  }
});
}
}

test("compatibility HTTP completion is recyclable while an independent WS stays live", { timeout: 7000 }, async context => {
  let healthyEntry;
  const setup = await fixture(context, { transportOptions: { maxOperations: 2 }, onPacket(entry) {
    const text = entry.packet.input[0].content[0].text;
    if (text === "HEALTHY_HELD") {
      healthyEntry = entry;
      entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "healthy_held", status: "in_progress" } }));
    } else if (text === "COMPAT_FAIL") {
      entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "compatibility_recycle", status: "in_progress" } }));
      entry.socket.send(JSON.stringify({ type: "response.failed", response: { id: "compatibility_recycle", status: "failed", output: [],
        error: { code: "unsupported_parameter", status: 400, param: "generate" } } }));
    } else complete(entry.socket, "fresh_ws", "FRESH_WS_OK");
  } });
  const healthy = setup.request({ threadId: "healthy-thread", input: [message("HEALTHY_HELD")] });
  await until(() => Boolean(healthyEntry), "independent WS active before compatibility failure");
  const failed = setup.request({ threadId: "compatibility-thread", input: [message("COMPAT_FAIL")] });
  assert.match((await failed.done).text, /HTTP_INTERACTION_OK/u);
  assert.deepEqual(setup.httpRequests[0].body, failed.encoded);
  assert.equal(setup.fallbackCompletions.length, 1);
  const completion = setup.fallbackCompletions[0];
  assert.equal(completion.returned, true);
  assert.equal(completion.operation.state, "completed");
  assert.equal(setup.transport.getOperation(completion.operationId).state, "completed");
  assert.equal(setup.transport.status().active, 1);
  assert.equal(healthyEntry.socket.readyState, 1);
  assert.equal(setup.connections.find(connection => connection.index === healthyEntry.connection).network.destroyed, false);
  assert.ok(setup.invalidations.includes("compatibility-thread"));
  assert.equal(setup.invalidations.includes("healthy-thread"), false);
  const fresh = await setup.request({ threadId: "fresh-thread", input: [message("FRESH")] }).done;
  assert.match(fresh.text, /FRESH_WS_OK/u);
  assert.equal(setup.transport.getOperation(completion.operationId), null);
  assert.equal(setup.transport.status().operations, 2);
  assert.equal(setup.httpRequests.length, 1);
  complete(healthyEntry.socket, "healthy_held", "HEALTHY_WS_OK");
  assert.match((await healthy.done).text, /HEALTHY_WS_OK/u);
  assert.equal(setup.packets.length, 3);
  assert.equal(setup.connections[0].network.destroyed, false);
});

test("accepted oversized WS failures completed on HTTP do not exhaust operation capacity", { timeout: 7000 }, async context => {
  const setup = await fixture(context, { transportOptions: { maxOperations: 8 }, onPacket(entry) {
    if (entry.packet.input[0].content[0].text === "HEALTHY_AFTER_PAYLOAD_FALLBACKS") {
      return complete(entry.socket, "healthy_after_payload", "HEALTHY_AFTER_PAYLOAD_OK");
    }
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: `payload_${entry.index}`, status: "in_progress" } }));
    entry.socket.close(1009, "fixture oversized request");
  } });
  for (let sequence = 0; sequence < 12; sequence += 1) {
    const result = await setup.request({ threadId: `payload-thread-${sequence}`, turnId: `payload-turn-${sequence}` }).done;
    assert.match(result.text, /HTTP_INTERACTION_OK/u);
    assert.equal(setup.fallbackCompletions.length, sequence + 1);
    assert.equal(setup.fallbackCompletions.at(-1).returned, true);
    assert.equal(setup.fallbackCompletions.at(-1).operation.state, "completed");
    assert.ok(setup.transport.status().operations <= 8);
  }
  const healthy = await setup.request({ threadId: "payload-followup", input: [message("HEALTHY_AFTER_PAYLOAD_FALLBACKS")] }).done;
  assert.match(healthy.text, /HEALTHY_AFTER_PAYLOAD_OK/u);
  assert.equal(setup.packets.length, 13);
  assert.equal(setup.httpRequests.length, 12);
  assert.equal(setup.proxy.status().operationLedger.protectedOperations, 0);
});

test("prewarm capacity diagnostics preserve managed WS recovery", { timeout: 7000 }, async context => {
  const setup = await fixture(context, { transportOptions: { maxMessageBytes: 1800 }, onPacket(entry) {
    const id = `capacity_prewarm_${entry.index}`;
    if (entry.index === 1) {
      entry.socket.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress" } }));
      return entry.socket.send(JSON.stringify({ type: "response.failed", response: { id, status: "failed", output: [],
        error: { code: "model_at_capacity", status: 503, param: "model", message: "PRIVATE_CAPACITY_DETAIL" } } }));
    }
    complete(entry.socket, id, entry.packet.generate === false ? null : "PREWARM_CAPACITY_RECOVERED", []);
  } });
  const result = await setup.request({ input: [message("a".repeat(800)), message("b".repeat(800)), message("c".repeat(800))] }).done;
  assert.match(result.text, /PREWARM_CAPACITY_RECOVERED/u);
  assert.equal(setup.packets.length, 4);
  assert.equal(setup.httpRequests.length, 0);
  assert.equal(setup.proxy.status().counters.actualCompletions, 1);
  assert.equal(setup.events.filter(event => event.type === "native_retry_signal").length, 0);
  assert.equal(JSON.stringify([setup.events, setup.observations]).includes("PRIVATE_CAPACITY_DETAIL"), false);
});

test("failed prewarm retains safe compatibility diagnostics and completes the HTTP operation", { timeout: 7000 }, async context => {
  const setup = await fixture(context, { transportOptions: { maxMessageBytes: 1800 }, onPacket(entry) {
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "failed_prewarm", status: "in_progress" } }));
    entry.socket.send(JSON.stringify({ type: "response.failed", response: { id: "failed_prewarm", status: "failed", output: [],
      error: { code: "unsupported_parameter", status: 400, param: "generate", message: "PRIVATE_PREWARM_MESSAGE" } } }));
  } });
  const original = setup.request({ input: [message("a".repeat(800)), message("b".repeat(800)), message("c".repeat(800))] });
  assert.match((await original.done).text, /HTTP_INTERACTION_OK/u);
  assert.equal(setup.packets.length, 1);
  assert.equal(setup.packets[0].packet.generate, false);
  assert.equal(setup.httpRequests.length, 1);
  assert.deepEqual(setup.httpRequests[0].body, original.encoded);
  const compatibility = setup.events.filter(event => event.type === "websocket_compatibility_fallback");
  assert.equal(compatibility.length, 1);
  assert.equal(compatibility[0].code, "unsupported_parameter");
  assert.equal(compatibility[0].parameter, "generate");
  assert.equal(compatibility[0].terminalOutcome, "failed_no_output");
  assert.equal(JSON.stringify([setup.events, setup.recovery, setup.observations]).includes("PRIVATE_PREWARM_MESSAGE"), false);
  assert.equal(setup.fallbackCompletions[0].returned, true);
  assert.equal(setup.fallbackCompletions[0].operation.state, "completed");
});

for (const failedPhase of ["prewarm", "generation"]) {
test(`structured WS parameter rejection during ${failedPhase} falls back with the original body`, { timeout: 7000 }, async context => {
  const setup = await fixture(context, { transportOptions: { maxMessageBytes: 1800 }, onPacket(entry) {
    if (failedPhase === "generation" && entry.packet.generate === false) {
      return complete(entry.socket, `prewarmed_${entry.index}`, null, []);
    }
    entry.socket.send(JSON.stringify({ type: "codex.rate_limits", rate_limits: [] }));
    entry.socket.send(JSON.stringify({ type: "codex.response.metadata", metadata: {} }));
    entry.socket.send(JSON.stringify({ type: "error", status: 400, error: {
      type: "invalid_request_error", code: "unsupported_parameter", param: "input",
      message: "Supplied input item IDs require persisted-item lookup that is not supported by rustponsesapi." } }));
  } });
  const original = setup.request({ input: [message("a".repeat(800)), message("b".repeat(800)), message("c".repeat(800))] });
  const result = await original.done;
  assert.match(result.text, /HTTP_INTERACTION_OK/u);
  assert.equal(setup.httpRequests.length, 1);
  assert.deepEqual(setup.httpRequests[0].body, original.encoded);
  const fallback = setup.events.filter(event => event.type === "websocket_compatibility_fallback");
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].parameter, "input");
  assert.equal(setup.fallbackCompletions[0].returned, true);
  assert.equal(setup.fallbackCompletions[0].operation.state, "completed");
  assert.equal(JSON.stringify(setup.events).includes("persisted-item lookup"), false);
});
}

for (const scenario of ["accepted", "unauthorized", "safety", "outer-safety", "nested-status"]) {
test(`structured parameter error preserves ${scenario} protection`, { timeout: 7000 }, async context => {
  const setup = await fixture(context, { onPacket(entry) {
    if (scenario === "accepted") {
      entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "accepted_before_error", status: "in_progress" } }));
    }
    entry.socket.send(JSON.stringify({ type: "error", status: scenario === "unauthorized" ? 401 : 400,
      ...(scenario === "outer-safety" ? { code: "content_policy_violation" } : {}), error: {
      type: "invalid_request_error", code: "unsupported_parameter", param: "input",
      ...(scenario === "nested-status" ? { status: 401 } : {}),
      message: scenario === "safety" ? "Request blocked by safety policy" : "PRIVATE_REJECTION_DETAIL" } }));
  } });
  await setup.request().done;
  assert.equal(setup.httpRequests.length, 0);
  assert.equal(setup.events.filter(event => event.type === "websocket_compatibility_fallback").length, 0);
});
}

for (const scenario of ["unknown", "text", "tool", "invalid_api_key", "insufficient_quota", "content_policy_violation"]) {
test(`compatibility fallback excludes ${scenario}`, { timeout: 7000 }, async context => {
  const setup = await fixture(context, { onPacket(entry) {
    if (scenario === "unknown") {
      entry.socket.send(JSON.stringify({ type: "error", error: { code: "unsupported_parameter", message: "PRIVATE_UNKNOWN_MESSAGE" } }));
      return;
    }
    const id = `excluded_${scenario}`;
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress" } }));
    if (scenario === "text") entry.socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "OUTPUT_ALREADY_DELIVERED" }));
    if (scenario === "tool") entry.socket.send(JSON.stringify({ type: "response.output_item.done", item: {
      type: "function_call", call_id: "compatibility-tool", name: "fixture_tool", arguments: "{}" } }));
    const code = ["text", "tool"].includes(scenario) ? "unsupported_value" : scenario;
    entry.socket.send(JSON.stringify({ type: "response.failed", response: { id, status: "failed", output: [], error: { code } } }));
  } });
  const result = await setup.request().done;
  await delay(30);
  assert.equal(setup.packets.length, 1);
  assert.equal(setup.httpRequests.length, 0);
  assert.equal(setup.events.filter(event => event.type === "websocket_compatibility_fallback").length, 0);
  assert.equal(setup.recovery.some(event => event.reason === "websocket_parameters_require_http"), false);
  assert.equal(setup.proxy.status().counters.actualCompletions, 0);
  if (scenario === "text") assert.match(result.text, /OUTPUT_ALREADY_DELIVERED/u);
  if (scenario === "tool") assert.ok(setup.events.some(event => event.type === "turn_attempt_finished" && event.sawTool));
});
}

test("WS empty 503/504 then HTTP 503/504 recovers and same-turn appended text receives its own answer", { timeout: 7000 }, async context => {
  const setup = await fixture(context, { onPacket(entry) {
    const id = `empty_${entry.index}`;
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } }));
    entry.socket.send(JSON.stringify(entry.index === 1
      ? { type: "response.output_item.done", item: { type: "reasoning", id: "empty-reasoning", summary: [], encrypted_content: "" } }
      : { type: "response.output_text.delta", delta: "" }));
    entry.socket.send(JSON.stringify({ type: entry.index === 1 ? "response.failed" : "response.incomplete",
      response: { id, status: entry.index === 1 ? "failed" : "incomplete", output: [], error: { code: "server_error", status: entry.index === 1 ? 503 : 504 } } }));
  }, onHttp(entry, response) {
    if (entry.index < 3) transient(response, entry.index === 1 ? 503 : 504);
    else httpComplete(response, `http_${entry.index}`, entry.index === 3 ? "RECOVERED_AFTER_503_504" : "APPENDED_TEXT_已收到");
  } });
  const first = setup.request();
  const result = await first.done;
  assert.equal(setup.packets.length, 2);
  assert.equal(setup.httpRequests.length, 3);
  assert.ok(setup.httpRequests.every(entry => entry.body.equals(first.encoded)));
  assert.ok(setup.packets.every(entry => entry.packet.previous_response_id === undefined));
  assert.match(result.text, /RECOVERED_AFTER_503_504/u);
  assert.equal(result.events.filter(event => event.type === "response.completed").length, 1);
  assert.equal(result.events.some(event => event.type === "response.failed"), false);
  assert.doesNotMatch(result.text, /duplicate_operation|proxy_repeated_empty_idle/u);
  assert.equal(setup.proxy.status().counters.syntheticCompletions, 0);
  assert.equal(setup.proxy.status().counters.actualCompletions, 1);
  const appended = setup.request({ input: [message("original"), message("新追加正文，请独立回答")] });
  const next = await appended.done;
  assert.match(next.text, /APPENDED_TEXT_已收到/u);
  assert.deepEqual(setup.httpRequests.at(-1).body, appended.encoded);
  assert.equal(setup.packets.length, 2);
  assert.equal(setup.proxy.status().operationLedger.protectedOperations, 0);
  assert.equal(setup.transport.status().unknownOperations, 0);
  assert.ok(setup.recovery.some(event => event.httpStatusCode === 503));
  assert.ok(setup.recovery.some(event => event.httpStatusCode === 504));
  context.diagnostic("WS empty reasoning+503 -> WS empty delta+504 -> HTTP503 -> HTTP504 -> real answer -> same-turn appended full body+answer; no duplicate, false IDLE or synthetic success");
  context.diagnostic(JSON.stringify({ websocketResponseIds: setup.packets.map(entry => `empty_${entry.index}`),
    completedResponseIds: [result, next].map(response => response.events.at(-1).response.id),
    retryHttpStatuses: [...new Set(setup.recovery.map(event => event.httpStatusCode).filter(Boolean))],
    websocketAttempts: setup.packets.length, httpAttempts: setup.httpRequests.length,
    actualCompletions: setup.proxy.status().counters.actualCompletions, syntheticCompletions: setup.proxy.status().counters.syntheticCompletions }));
});

for (const capacityLimit of ["session_limit", "operation_limit"]) {
test(`capacity fallback ${capacityLimit} survives 503/504 while another request stays active then cancellation permits same-turn appended content`, { timeout: 7000 }, async context => {
  const transportOptions = capacityLimit === "session_limit" ? { maxSessions: 1, maxOperations: 4 } : { maxSessions: 4, maxOperations: 1 };
  const setup = await fixture(context, { transportOptions, onPacket(entry) {
    if (entry.index === 1) entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "busy-original", status: "in_progress" } }));
    else complete(entry.socket, "after_cancel", "APPEND_AFTER_CANCEL_收到新正文");
  }, onHttp(entry, response) {
    if (entry.index < 3) transient(response, entry.index === 1 ? 503 : 504);
    else {
      const body = JSON.parse(zstdDecompressSync(entry.body));
      const appended = body.input.at(-1).content?.[0]?.text === "取消后同回合追加正文_新问题";
      httpComplete(response, appended ? "appended_after_cancel_http" : "capacity_recovered", appended ? "APPEND_AFTER_CANCEL_收到新正文" : "CAPACITY_RECOVERED");
    }
  } });
  const controller = new AbortController();
  const busy = setup.request({ signal: controller.signal });
  await until(() => setup.packets.length === 1, "busy websocket before overflow");
  const overflow = setup.request({ threadId: "capacity-other-thread", turnId: "other-turn", input: [message("independent B")] });
  const second = await overflow.done;
  assert.match(second.text, /CAPACITY_RECOVERED/u);
  assert.equal(setup.proxy.status().activeRequests, 1);
  assert.equal(setup.transport.status().active, 1);
  assert.equal(setup.connections[0].network.destroyed, false);
  assert.ok(setup.httpRequests.every(entry => entry.body.equals(overflow.encoded)));
  assert.equal(setup.packets.length, 1);
  controller.abort();
  await assert.rejects(busy.done);
  await until(() => setup.proxy.status().activeRequests === 0 && setup.transport.status().active === 0, "cancelled request release");
  const input = [message("original"), message("取消后同回合追加正文_新问题")];
  const appendedRequest = setup.request({ input });
  const appended = await appendedRequest.done;
  assert.match(appended.text, /APPEND_AFTER_CANCEL_收到新正文/u);
  assert.equal(setup.packets.length, capacityLimit === "session_limit" ? 2 : 1);
  assert.equal(setup.httpRequests.length, capacityLimit === "session_limit" ? 3 : 4);
  if (capacityLimit === "session_limit") assert.deepEqual(setup.packets.at(-1).packet.input, input);
  else assert.deepEqual(setup.httpRequests.at(-1).body, appendedRequest.encoded);
  assert.equal(appended.events.filter(event => event.type === "response.completed").length, 1);
  assert.equal(appended.events.some(event => event.type === "response.failed"), false);
  assert.equal(setup.proxy.status().counters.syntheticCompletions, 0);
  assert.equal(setup.proxy.status().operationLedger.protectedOperations, 0);
  const capacityRequestIds = new Set(setup.recovery.filter(event => event.reason === "websocket_capacity_requires_http").map(event => event.requestId));
  assert.equal(capacityRequestIds.size, capacityLimit === "session_limit" ? 1 : 2);
  context.diagnostic(`A held -> B ${capacityLimit} -> HTTP503/504 -> B answer while A remains active -> cancel A -> same-turn appended content -> correct new answer; transport=${JSON.stringify(setup.transport.status())}`);
  context.diagnostic(JSON.stringify({ busyResponseId: "busy-original", overflowResponseId: second.events.at(-1).response.id,
    appendedResponseId: appended.events.at(-1).response.id, fullAppendedBodyBytes: appendedRequest.body.length,
    websocketPackets: setup.packets.length, httpRequests: setup.httpRequests.length, capacityFallbackRequests: capacityRequestIds.size,
    protectedOperations: setup.proxy.status().operationLedger.protectedOperations }));
});
}

test("tool-result recovery then compaction invalidates old WS state and persisted live checkpoint blocks replay after reload", { timeout: 10000 }, async context => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "napcat-recovery-interactions-"));
  const checkpointPath = join(stateDirectory, "interrupted-operation.json");
  context.after(() => {
    rmSync(checkpointPath, { force: true });
    rmdirSync(stateDirectory);
  });
  const call = { type: "function_call", call_id: "interaction-execute-once", name: "fixture_tool", arguments: "{}" };
  const compacted = { type: "compaction", id: "compact-interaction", encrypted_content: "opaque+/原样==" };
  let now = 1000;
  const setup = await fixture(context, { proxyOptions: { websocketNow: () => now }, onPacket(entry) {
    if (entry.index === 1) {
      entry.socket.send(JSON.stringify({ type: "response.output_item.done", item: call }));
      complete(entry.socket, "tool_delivered", null, [call]);
    } else if (entry.index <= 3) {
      entry.socket.send(JSON.stringify({ type: "response.failed", response: { id: `tool_result_${entry.index}`, status: "failed", output: [],
        error: { code: "server_error", status: entry.index === 2 ? 503 : 504 } } }));
    } else if (entry.index === 4) complete(entry.socket, "after_compaction", "COMPACTED_TOOL_VALUE_1");
    else entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "interrupted_checkpoint", status: "in_progress" } }));
  }, onHttp(entry, response) {
    if (entry.path.endsWith("/compact")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "compact_original", output: [compacted] }));
    } else httpComplete(response, "tool_result_http", "TOOL_VALUE_1");
  } });
  const input = [message("run the safe fixture tool exactly once")];
  let executions = 0;
  const execute = result => result.events.filter(event => event.type === "response.output_item.done" && event.item?.call_id === call.call_id).map(() => {
    executions += 1;
    return { type: "function_call_output", call_id: call.call_id, output: `TOOL_VALUE_${executions}` };
  });
  const first = await setup.request({ input }).done;
  const results = execute(first);
  assert.equal(executions, 1);
  const withResult = [...input, call, ...results];
  const continuation = setup.request({ input: withResult });
  const recovered = await continuation.done;
  execute(recovered);
  assert.equal(executions, 1);
  assert.match(recovered.text, /TOOL_VALUE_1/u);
  assert.equal(setup.packets[1].packet.previous_response_id, "tool_delivered");
  assert.deepEqual(setup.packets[1].packet.input, results);
  assert.deepEqual(setup.packets[2].packet.input, withResult);
  assert.deepEqual(setup.httpRequests[0].body, continuation.encoded);
  const compact = await setup.request({ input: withResult, kind: "compaction", path: "/v1/responses/compact", stream: false }).done;
  assert.deepEqual(JSON.parse(compact.text).output, [compacted]);
  now += 60_001;
  const compactInput = [compacted, message("remember TOOL_VALUE_1 and answer the new question")];
  const afterCompact = await setup.request({ input: compactInput, turnId: "post-compaction" }).done;
  execute(afterCompact);
  assert.match(afterCompact.text, /COMPACTED_TOOL_VALUE_1/u);
  assert.equal(setup.packets[3].packet.previous_response_id, undefined);
  assert.deepEqual(setup.packets[3].packet.input, compactInput);
  assert.notEqual(setup.packets[3].connection, setup.packets[0].connection);
  const controller = new AbortController();
  const unfinished = setup.request({ input: [...compactInput, message("interrupted before output")], turnId: "old-interrupted", signal: controller.signal });
  await until(() => setup.packets.length === 5, "live unfinished request checkpoint");
  const checkpoint = setup.operationStates.at(-1);
  assert.equal(checkpoint.entries.length, 1);
  writeFileSync(checkpointPath, JSON.stringify(checkpoint), "utf8");
  controller.abort();
  await assert.rejects(unfinished.done);
  await setup.close();
  const restored = await fixture(context, { proxyOptions: { operationState: JSON.parse(readFileSync(checkpointPath, "utf8")) } });
  const protectedResult = await restored.request({ input: [...compactInput, message("interrupted before output")], turnId: "old-interrupted" }).done;
  assert.equal(protectedResult.events.at(-1).response.error.code, "proxy_operation_recovery_protected");
  assert.equal(restored.packets.length, 0);
  assert.equal(restored.httpRequests.length, 0);
  const fresh = await restored.request({ input: compactInput, turnId: "fresh-after-reload" }).done;
  execute(fresh);
  assert.match(fresh.text, /WS_INTERACTION_OK/u);
  assert.deepEqual(restored.packets[0].packet.input, compactInput);
  assert.equal(restored.packets[0].packet.previous_response_id, undefined);
  assert.equal(executions, 1);
  assert.equal(restored.proxy.status().operationLedger.protectedOperations, 1);
  context.diagnostic("tool executed once -> same-turn result WS503/504+HTTP -> real compact HTTP output preserved -> fresh WS full compacted input -> disk checkpoint from live unfinished request -> reload protects old turn without network -> fresh turn succeeds; fixture tool execution=1");
  context.diagnostic(JSON.stringify({ toolCallId: call.call_id, executions, toolResultResponseId: recovered.events.at(-1).response.id,
    compactionId: JSON.parse(compact.text).id, afterCompactionResponseId: afterCompact.events.at(-1).response.id,
    checkpointEntries: checkpoint.entries.length, restoredOldError: protectedResult.events.at(-1).response.error.code,
    freshResponseId: fresh.events.at(-1).response.id, restoredWebsocketAttempts: restored.packets.length,
    restoredHttpAttempts: restored.httpRequests.length, protectedOldOperations: restored.proxy.status().operationLedger.protectedOperations }));
});
