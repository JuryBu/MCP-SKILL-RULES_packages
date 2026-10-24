import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { deflateSync, inflateSync } from "node:zlib";
import test from "node:test";
import { createIncrementalResponsesTransport } from "../src/incremental-responses-transport.mjs";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";
import { classifyModelFailure } from "../src/model-failure-policy.mjs";

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws");
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const message = text => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistant = text => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const body = input => ({ model: "fixture-model", instructions: "Loopback fixture", tools: [], input });
const fixtureHeaders = {
  Authorization: "Bearer fixture-token",
  "ChatGPT-Account-Id": "fixture-account",
  "OpenAI-Beta": "responses_websockets=2026-02-06",
  originator: "codex_cli_rs",
  "User-Agent": "fixture-native-version",
};

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  let checksum = 0xffffffff;
  for (const value of chunk.subarray(4, data.length + 8)) {
    checksum ^= value;
    for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, data.length + 8);
  return chunk;
}

function redBluePng() {
  const width = 512;
  const height = 256;
  const rowBytes = width * 3 + 1;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const offset = row * rowBytes + 1 + column * 3;
      pixels[offset + (column < width / 2 ? 0 : 2)] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function waitFor(predicate, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Fixture condition timed out");
    await delay(5);
  }
}

function complete(socket, id, output = [], delta = null) {
  socket.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress" } }));
  if (delta !== null) socket.send(JSON.stringify({ type: "response.output_text.delta", delta }));
  socket.send(JSON.stringify({ type: "response.completed", response: { id, status: "completed", output } }));
}

async function fixture(context, handler, options = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const messages = [];
  const connections = [];
  const sockets = new Set();
  server.on("connection", (socket, request) => {
    const connection = connections.length + 1;
    connections.push({ connection, headers: request.headers, socket });
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", raw => {
      const entry = { connection, packet: JSON.parse(raw), bytes: raw.length, socket, index: messages.length + 1 };
      messages.push(entry);
      if (handler) handler(entry);
      else complete(socket, `resp_${entry.index}`);
    });
  });
  const url = `ws://127.0.0.1:${server.address().port}/responses`;
  const transport = createIncrementalResponsesTransport({ responseTimeoutMs: 1500, maxPreviousResponseIdBytes: 16, ...options });
  context.after(async () => {
    transport.close();
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    assert.equal(transport.status().retainedBytes, 0);
    assert.equal(transport.status().active, 0);
    assert.equal(transport.status().connections, 0);
  });
  return { transport, messages, connections, sockets, url };
}

function start(fixtureState, operationId, payload, settings = {}) {
  const { transport, url } = fixtureState;
  const client = transport.createRequestClient({
    sessionKey: settings.sessionKey ?? "session-a", operationId, payload, url: settings.url ?? url,
    headers: settings.headers ?? fixtureHeaders,
    onPreparationProgress: settings.onPreparationProgress,
    onPacketSending: settings.onPacketSending,
    retryWithoutOutput: settings.retryWithoutOutput,
  });
  const request = client.request(url, { signal: settings.signal, headers: settings.requestHeaders });
  let response;
  let sse = "";
  let resolveDone;
  let resolved = false;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const finish = error => {
    if (resolved) return;
    resolved = true;
    resolveDone({ error, response, sse, request });
  };
  request.on("response", incoming => {
    response = incoming;
    incoming.setEncoding("utf8");
    incoming.on("data", chunk => { sse += chunk; });
    incoming.on("end", () => finish());
    incoming.on("error", finish);
  });
  request.on("error", finish);
  if (settings.end !== false) request.end("Ignored raw bytes: deliberately not JSON");
  return { request, done };
}

test("cancelled downstream can drain a matching completed response without replaying its output", async context => {
  const firstInput = [message("initial")];
  const firstOutput = [assistant("already delivered")];
  const state = await fixture(context, entry => {
    if (entry.index !== 1) return complete(entry.socket, `resp_${entry.index}`);
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_first", status: "in_progress" } }));
    entry.socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "already delivered" }));
  });
  const first = start(state, "cancel-drain-first", body(firstInput));
  await waitFor(() => state.transport.getOperation("cancel-drain-first")?.acceptance === true);
  assert.equal(first.request.cancelAndDrain(), true);
  first.request.destroy();
  const cancelled = await first.done;
  assert.equal(cancelled.error?.code, "ABORT_ERR");
  const next = start(state, "cancel-drain-next", body([...firstInput, ...firstOutput, message("new instruction")]));
  await delay(20);
  state.messages[0].socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_first", status: "completed", output: firstOutput } }));
  assert.equal((await next.done).error, undefined);
  assert.equal(state.connections.length, 1);
  assert.equal(state.messages[1].packet.previous_response_id, "resp_first");
  assert.deepEqual(state.messages[1].packet.input, [message("new instruction")]);
  assert.equal(cancelled.sse.includes('"type":"response.completed"'), false);
});

test("drain expiry remains bounded and rebuilds the next real input", async context => {
  const state = await fixture(context, entry => {
    if (entry.index !== 1) return complete(entry.socket, `resp_${entry.index}`);
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_first", status: "in_progress" } }));
    entry.socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "partial" }));
  });
  const first = start(state, "cancel-expire-first", body([message("initial")]));
  await waitFor(() => state.transport.getOperation("cancel-expire-first")?.acceptance === true);
  const started = performance.now();
  assert.equal(first.request.cancelAndDrain(), true);
  first.request.destroy();
  await first.done;
  await delay(150);
  assert.equal(first.request.cancelAndDrain(), true);
  const input = [message("initial"), message("changed")];
  const next = await start(state, "cancel-expire-next", body(input)).done;
  assert.equal(next.error, undefined);
  assert.ok(performance.now() - started < 800);
  assert.equal(state.connections.length, 2);
  assert.equal(state.messages[1].packet.previous_response_id, undefined);
  assert.deepEqual(state.messages[1].packet.input, input);
});

test("a truly cancelled queued request is never sent after the held response completes", async context => {
  const input = [message("initial")];
  const output = [assistant("delivered")];
  const state = await fixture(context, entry => {
    if (entry.index !== 1) return complete(entry.socket, `resp_${entry.index}`);
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_first", status: "in_progress" } }));
    entry.socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "delivered" }));
  });
  const first = start(state, "queue-first", body(input));
  await waitFor(() => state.transport.getOperation("queue-first")?.acceptance === true);
  assert.equal(first.request.cancelAndDrain(), true);
  first.request.destroy();
  await first.done;
  const superseded = start(state, "queue-superseded", body([...input, ...output, message("first update")]));
  let gotHeaders = false;
  superseded.request.once("response", () => { gotHeaders = true; });
  await waitFor(() => gotHeaders);
  superseded.request.destroy();
  assert.equal((await superseded.done).error?.code, "ABORT_ERR");
  const finalInput = [...input, ...output, message("first update"), message("second update")];
  const next = start(state, "queue-current", body(finalInput));
  state.messages[0].socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_first", status: "completed", output } }));
  assert.equal((await next.done).error, undefined);
  assert.equal(state.messages.length, 2);
  assert.deepEqual(state.messages[1].packet.input, finalInput.slice(2));
  assert.equal(state.transport.status().active, 0);
  assert.equal(state.transport.status().queued, 0);
});

test("requests queued before downstream cancellation receive headers and can be cancelled before sending", async context => {
  const input = [message("initial")];
  const output = [assistant("delivered")];
  const state = await fixture(context, entry => {
    if (entry.index !== 1) return complete(entry.socket, `resp_${entry.index}`);
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_first", status: "in_progress" } }));
    entry.socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "delivered" }));
  });
  const first = start(state, "queue-before-first", body(input));
  await waitFor(() => state.transport.getOperation("queue-before-first")?.acceptance === true);
  const superseded = start(state, "queue-before-superseded", body([...input, ...output, message("first update")]));
  let gotHeaders = false;
  superseded.request.once("response", () => { gotHeaders = true; });
  await waitFor(() => state.transport.status().queued === 1);
  assert.equal(gotHeaders, false);
  assert.equal(first.request.cancelAndDrain(), true);
  first.request.destroy();
  await first.done;
  await waitFor(() => gotHeaders);
  superseded.request.destroy();
  assert.equal((await superseded.done).error?.code, "ABORT_ERR");
  const finalInput = [...input, ...output, message("first update"), message("second update")];
  const next = start(state, "queue-before-current", body(finalInput));
  state.messages[0].socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_first", status: "completed", output } }));
  assert.equal((await next.done).error, undefined);
  assert.equal(state.messages.length, 2);
  assert.deepEqual(state.messages[1].packet.input, finalInput.slice(2));
  assert.equal(state.transport.status().active, 0);
  assert.equal(state.transport.status().queued, 0);
});

test("late output excluded from native history forces a full rebuild after draining", async context => {
  const input = [message("initial")];
  const state = await fixture(context, entry => {
    if (entry.index !== 1) return complete(entry.socket, `resp_${entry.index}`);
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_first", status: "in_progress" } }));
    entry.socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "partial" }));
  });
  const first = start(state, "late-first", body(input));
  await waitFor(() => state.transport.getOperation("late-first")?.acceptance === true);
  assert.equal(first.request.cancelAndDrain(), true);
  first.request.destroy();
  const cancelled = await first.done;
  const nextInput = [...input, message("new instruction")];
  const next = start(state, "late-next", body(nextInput));
  state.messages[0].socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "LATE_IGNORED" }));
  state.messages[0].socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_first", status: "completed", output: [assistant("LATE_IGNORED")] } }));
  assert.equal((await next.done).error, undefined);
  assert.equal(cancelled.sse.includes("LATE_IGNORED"), false);
  assert.equal(state.connections.length, 2);
  assert.deepEqual(state.messages[1].packet.input, nextInput);
});

test("decoded WebSocket packets discard HTTP entity headers while preserving authentication", async context => {
  const state = await fixture(context);
  const result = await start(state, "compressed-http-origin", body([message("decoded input")]), {
    headers: { ...fixtureHeaders, "Content-Encoding": "zstd", "Content-Type": "application/json", Expect: "100-continue" },
    requestHeaders: { "content-length": "42000", "transfer-encoding": "chunked" },
  }).done;
  assert.equal(result.error, undefined);
  const headers = state.connections[0].headers;
  for (const name of ["content-encoding", "content-type", "expect", "content-length", "transfer-encoding"]) {
    assert.equal(headers[name], undefined, name);
  }
  assert.equal(headers.authorization, fixtureHeaders.Authorization);
  assert.equal(headers["openai-beta"], fixtureHeaders["OpenAI-Beta"]);
  assert.deepEqual(state.messages[0].packet.input, [message("decoded input")]);
});

test("frozen API forwards raw SSE, keeps headers, and sends only new input with terminal previous id", async context => {
  const output = [assistant("fixture output")];
  const state = await fixture(context, entry => complete(entry.socket, `resp_${entry.index}`, output, "raw delta"));
  const initial = [message("initial ".repeat(100))];
  const first = await start(state, "operation-1", { ...body(initial), stream: true, background: true, stream_id: "http-only", store: true }).done;
  assert.equal(first.error, undefined);
  assert.equal(first.response.statusCode, 200);
  assert.equal(first.response.headers["content-type"], "text/event-stream");
  assert.match(first.sse, /data: \{"type":"response.output_text.delta","delta":"raw delta"\}/);
  assert.equal(first.request.operationAcceptance, true);
  assert.equal(first.request.transport, "websocket");
  assert.equal(first.request.requestTransmissionState, "completed");
  const added = message("new question");
  const second = await start(state, "operation-2", body([...initial, ...output, added])).done;
  assert.equal(second.error, undefined);
  assert.equal(state.connections.length, 1);
  assert.equal(state.messages[1].packet.previous_response_id, "resp_1");
  assert.deepEqual(state.messages[1].packet.input, [added]);
  assert.ok(state.messages[1].bytes < state.messages[0].bytes);
  assert.equal(state.messages[0].packet.store, false);
  for (const field of ["stream", "background", "stream_id", "generate"]) assert.equal(field in state.messages[0].packet, false);
  assert.equal(state.connections[0].headers.authorization, fixtureHeaders.Authorization);
  assert.equal(state.connections[0].headers["user-agent"], fixtureHeaders["User-Agent"]);
  assert.equal(state.transport.getOperation("operation-1").state, "completed");
  assert.equal(JSON.stringify(state.transport.status()).includes("fixture-token"), false);
  context.diagnostic(`wire bytes: first=${state.messages[0].bytes}, incremental=${state.messages[1].bytes}; previous_response_id=resp_1; incremental items=1`);
});

test("dynamic turn tracing metadata preserves the exact prefix while semantic metadata changes invalidate it", async context => {
  const output = [assistant("first output")];
  const state = await fixture(context, entry => complete(entry.socket, `resp_meta_${entry.index}`, entry.index === 1 ? output : []));
  const input = [message("initial")];
  const metadata = (turn, sandbox = "read-only") => ({ thread_id: "trace-thread", turn_id: turn, root_turn_id: turn,
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "trace-thread", turn_id: turn,
      root_turn_id: turn, turn_started_at_unix_ms: turn === "one" ? 1 : 2, sandbox_mode: sandbox }) });
  await start(state, "trace-one", { ...body(input), client_metadata: metadata("one") }).done;
  const next = [message("next")];
  await start(state, "trace-two", { ...body([...input, ...output, ...next]), client_metadata: metadata("two") }).done;
  assert.equal(state.connections.length, 1);
  assert.equal(state.messages[1].packet.previous_response_id, "resp_meta_1");
  assert.deepEqual(state.messages[1].packet.input, next);
  assert.equal(state.messages[1].packet.client_metadata.turn_id, "two");
  await start(state, "trace-semantic", { ...body([...input, ...output, ...next, message("third")]),
    client_metadata: metadata("three", "workspace-write") }).done;
  assert.equal(state.connections.length, 2);
  assert.equal(state.messages[2].packet.previous_response_id, undefined);
});

test("two generate:false prewarms are followed by one generation; only generation SSE escapes", async context => {
  const state = await fixture(context, null, { maxMessageBytes: 500 });
  const input = [message("A".repeat(180)), message("B".repeat(180)), message("中文".repeat(40))];
  const result = await start(state, "prewarm-three", body(input)).done;
  assert.equal(result.error, undefined);
  assert.equal(state.messages.length, 3);
  assert.deepEqual(state.messages.map(entry => entry.packet.generate), [false, false, undefined]);
  assert.deepEqual(state.messages.flatMap(entry => entry.packet.input), input);
  assert.equal(state.messages[1].packet.previous_response_id, "resp_1");
  assert.equal(state.messages[2].packet.previous_response_id, "resp_2");
  assert.equal((result.sse.match(/event: response.completed/g) ?? []).length, 1);
  assert.ok(state.messages.every(entry => entry.bytes <= 500));
  context.diagnostic(`prewarm/generation UTF8 bytes=${state.messages.map(entry => entry.bytes).join(",")}; terminal ids=resp_1 -> resp_2 -> resp_3`);
});

test("explicit image-prewarm opt-in checks loopback atomic bytes only, including tool pairs", async context => {
  const state = await fixture(context, null, { maxMessageBytes: 850, allowImagePrewarm: true });
  const toolPair = [
    { type: "function_call", call_id: "call-a", name: "fixture_tool", arguments: JSON.stringify({ value: "A".repeat(100) }) },
    { type: "function_call", call_id: "call-b", name: "fixture_tool", arguments: "{}" },
    { type: "function_call_output", call_id: "call-a", output: "result-a" },
    { type: "function_call_output", call_id: "call-b", output: "result-b" },
  ];
  const imageUrl = `data:image/png;base64,${"A".repeat(400)}`;
  const image = { type: "message", role: "user", content: [{ type: "input_image", image_url: imageUrl }] };
  const input = [message("prefix".repeat(90)), ...toolPair, image, message("generate")];
  const result = await start(state, "atomic-tools-image", body(input)).done;
  assert.equal(result.error, undefined);
  assert.deepEqual(state.messages.flatMap(entry => entry.packet.input), input);
  const toolPacket = state.messages.find(entry => entry.packet.input.some(item => item.call_id === "call-a"));
  assert.deepEqual(toolPacket.packet.input.filter(item => item.call_id), toolPair);
  const imagePacket = state.messages.find(entry => entry.packet.input.some(item => item.content?.[0]?.type === "input_image"));
  assert.equal(imagePacket.packet.input.find(item => item.content?.[0]?.type === "input_image").content[0].image_url, imageUrl);
  assert.ok(state.messages.every(entry => entry.bytes <= 850));
});

test("image prewarm is disabled by default and fails definitely not_sent before any connection", async context => {
  const state = await fixture(context, null, { maxMessageBytes: 500 });
  const payload = body([
    message("A".repeat(180)),
    { type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${"A".repeat(200)}` }] },
  ]);
  const client = state.transport.createRequestClient({ sessionKey: "image-default", operationId: "image-default", payload, url: state.url });
  assert.equal(client.operationAcceptance, false);
  const request = client.request(state.url);
  const failed = once(request, "error");
  request.end("ignored");
  const [error] = await failed;
  assert.equal(error.code, "unsupported_image_prewarm");
  assert.equal(error.requestAccepted, false);
  assert.equal(error.requestTransmissionState, "not_sent");
  assert.equal(client.operationAcceptance, false);
  assert.equal(client.requestTransmissionState, "not_sent");
  assert.equal(state.transport.getOperation("image-default").acceptance, false);
  assert.equal(state.transport.getOperation("image-default").requestTransmissionState, "not_sent");
  assert.equal(state.connections.length, 0);
  assert.equal(state.messages.length, 0);
});

test("ordinary tool prewarm remains enabled with complete call/result atoms", async context => {
  const state = await fixture(context, null, { maxMessageBytes: 600 });
  const call = { type: "function_call", call_id: "fixture-call", name: "fixture_tool", arguments: "{\"value\":7}" };
  const result = { type: "function_call_output", call_id: "fixture-call", output: "{\"result\":14}" };
  const input = [message("A".repeat(250)), call, result, message("B".repeat(250))];
  const response = await start(state, "tools-default", body(input)).done;
  assert.equal(response.error, undefined);
  assert.deepEqual(state.messages.flatMap(entry => entry.packet.input), input);
  const packet = state.messages.find(entry => entry.packet.input.some(item => item.call_id));
  assert.deepEqual(packet.packet.input.filter(item => item.call_id), [call, result]);
});

test("an oversized atomic item fails before connecting or sending", async context => {
  const state = await fixture(context, null, { maxMessageBytes: 250 });
  const result = await start(state, "oversize", body([message("X".repeat(300))])).done;
  assert.equal(result.error.code, "payload_too_large");
  assert.equal(result.error.requestAccepted, false);
  assert.equal(state.connections.length, 0);
  assert.equal(state.messages.length, 0);
  assert.equal(state.transport.getOperation("oversize").canRetry, true);
});

test("a packet upload allowance above ten minutes is accepted without changing the packet", async context => {
  const state = await fixture(context);
  const payload = body([message("long upload budget")]);
  const result = await start(state, "long-upload", payload, { onPacketSending: () => 4_295_040 }).done;
  assert.equal(result.error, undefined);
  assert.deepEqual(state.messages[0].packet.input, payload.input);
  assert.match(result.sse, /response.completed/u);
});

test("one session is serial while another session proceeds independently", async context => {
  let release;
  const state = await fixture(context, entry => {
    if (entry.index === 1) release = () => complete(entry.socket, "resp_first");
    else complete(entry.socket, `resp_${entry.index}`);
  });
  const firstInput = [message("first")];
  const first = start(state, "serial-1", body(firstInput));
  await waitFor(() => release);
  const second = start(state, "serial-2", body([...firstInput, message("second")]));
  const independent = await start(state, "isolated-1", body([message("independent")]), { sessionKey: "session-b" }).done;
  assert.equal(independent.error, undefined);
  assert.equal(state.messages.length, 2);
  assert.equal(state.transport.status().queued, 1);
  release();
  assert.equal((await first.done).error, undefined);
  assert.equal((await second.done).error, undefined);
  assert.equal(state.messages[2].connection, state.messages[0].connection);
  assert.notEqual(state.messages[1].connection, state.messages[0].connection);
  assert.equal(state.messages[2].packet.previous_response_id, "resp_first");
});

test("edited, compressed, semantic-config, authentication and URL changes rebuild full input", async context => {
  const state = await fixture(context);
  const initial = message("initial");
  assert.equal((await start(state, "binding-1", body([initial])).done).error, undefined);
  assert.equal((await start(state, "binding-2", body([message("edited")])).done).error, undefined);
  assert.equal((await start(state, "binding-3", { ...body([message("edited"), initial]), temperature: 0.5 }).done).error, undefined);
  assert.equal((await start(state, "binding-4", { ...body([message("edited"), initial]), temperature: 0.5 }, { headers: { ...fixtureHeaders, authorization: "Bearer fixture-rotated" } }).done).error, undefined);
  assert.equal((await start(state, "binding-5", body([])).done).error, undefined);
  assert.equal((await start(state, "binding-6", body([initial]), { url: `${state.url}?route=changed` }).done).error, undefined);
  assert.equal(state.connections.length, 6);
  assert.ok(state.messages.every(entry => !entry.packet.previous_response_id));
});

test("an idle disconnect drops connection-local IDs and rebuilds from full input", async context => {
  const state = await fixture(context);
  const input = [message("history")];
  await start(state, "disconnect-1", body(input)).done;
  state.connections[0].socket.terminate();
  await waitFor(() => state.transport.status().connections === 0);
  const result = await start(state, "disconnect-2", body([...input, message("next")])).done;
  assert.equal(result.error, undefined);
  assert.equal(state.connections.length, 2);
  assert.deepEqual(state.messages[1].packet.input, [...input, message("next")]);
  assert.equal(state.messages[1].packet.previous_response_id, undefined);
  assert.equal(state.transport.getOperation("disconnect-1").state, "completed");
});

test("a sent generation with no acceptance event remains unknown and duplicate operation is blocked", async context => {
  const state = await fixture(context, entry => entry.socket.terminate());
  const payload = body([message("no-replay")]);
  const first = await start(state, "unknown-operation", payload).done;
  assert.equal(first.error.requestAccepted, "unknown");
  assert.equal(first.error.requestTransmissionState, "generation_sent");
  state.transport.invalidate("session-a", "fixture invalidation");
  const duplicate = await start(state, "unknown-operation", payload).done;
  assert.equal(duplicate.error.code, "duplicate_operation");
  assert.equal(duplicate.error.requestAccepted, "unknown");
  assert.equal(state.messages.length, 1);
  assert.equal(state.transport.getOperation("unknown-operation").requiresReconciliation, true);
  assert.equal(state.transport.getOperation("unknown-operation").canRetry, false);
});

test("an accepted generation with no completed event is retained as accepted and cannot replay", async context => {
  const state = await fixture(context, entry => {
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_accepted" } }));
    entry.socket.close(1000);
  });
  const result = await start(state, "accepted-operation", body([message("accepted")])).done;
  assert.equal(result.error.requestAccepted, true);
  assert.equal(state.transport.getOperation("accepted-operation").requiresReconciliation, true);
  const duplicate = await start(state, "accepted-operation", body([message("accepted")])).done;
  assert.equal(duplicate.error.code, "duplicate_operation");
  assert.equal(state.messages.length, 1);
  assert.equal(result.sse.includes("response.completed"), false);
});

test("unknown prewarm acceptance prevents replay of the same packet", async context => {
  const state = await fixture(context, entry => entry.socket.terminate(), { maxMessageBytes: 500 });
  const payload = body([message("A".repeat(180)), message("B".repeat(180)), message("C".repeat(180))]);
  const first = await start(state, "unknown-prewarm", payload).done;
  assert.equal(first.error.requestAccepted, "unknown");
  assert.equal(first.error.requestTransmissionState, "prewarm_sent");
  assert.equal(first.response, undefined);
  const duplicate = await start(state, "unknown-prewarm", payload).done;
  assert.equal(duplicate.error.code, "duplicate_operation");
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].packet.generate, false);
});

test("1009 is surfaced once without re-sending the rejected packet", async context => {
  const state = await fixture(context, entry => entry.socket.close(1009, "fixture-limit"));
  const payload = body([message("1009")]);
  const first = await start(state, "too-large-operation", payload).done;
  assert.equal(first.error.code, "WS_MESSAGE_TOO_LARGE");
  assert.equal(first.error.direction, "send");
  assert.equal(first.error.closeCode, 1009);
  assert.equal(first.error.requestAccepted, "unknown");
  await delay(20);
  await start(state, "too-large-operation", payload).done;
  assert.equal(state.messages.length, 1);
  assert.equal(state.transport.status().connections, 0);
});

test("503 invalidates only the affected session and preserves earlier unknown records", async context => {
  const state = await fixture(context, entry => {
    if (entry.index === 1) entry.socket.terminate();
    else if (entry.packet.input[0]?.content?.[0]?.text === "503") entry.socket.send(JSON.stringify({ type: "error", error: { code: "server_error", status: 503 } }));
    else complete(entry.socket, `resp_${entry.index}`);
  });
  await start(state, "older-unknown", body([message("unknown")])).done;
  await start(state, "healthy-session", body([message("healthy")]), { sessionKey: "session-b" }).done;
  const healthySocket = state.connections[1].socket;
  const failed = await start(state, "service-unavailable", body([message("503")])).done;
  assert.equal(failed.error.code, "WS_HTTP_503");
  assert.equal(failed.error.httpStatus, 503);
  assert.equal(failed.error.requestAccepted, "unknown");
  assert.equal(state.transport.getOperation("older-unknown").acceptance, "unknown");
  assert.equal(healthySocket.readyState, WebSocket.OPEN);
  const healthy = await start(state, "healthy-increment", body([message("healthy"), message("next")]), { sessionKey: "session-b" }).done;
  assert.equal(healthy.error, undefined);
  assert.equal(state.messages.at(-1).packet.previous_response_id, "resp_2");
});

test("matching empty failed terminal permits a fresh connection without losing accepted history", async context => {
  const state = await fixture(context, entry => {
    const id = `resp_terminal_${entry.index}`;
    if (entry.index > 1) return complete(entry.socket, id);
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } }));
    entry.socket.send(JSON.stringify({ type: "response.failed", response: { id, status: "failed", output: [],
      error: { status: 503, code: "server_error" } } }));
  });
  const payload = body([message("safe-empty-terminal")]);
  const failed = await start(state, "empty-failed", payload).done;
  assert.equal(failed.error.requestAccepted, true);
  assert.equal(failed.request.terminalOutcome, "failed_no_output");
  assert.equal(state.transport.getOperation("empty-failed").canRetry, true);
  assert.equal(state.transport.getOperation("empty-failed").requiresReconciliation, false);
  assert.equal((await start(state, "empty-failed", payload).done).error, undefined);
  assert.equal(state.connections.length, 2);
  assert.equal(state.messages[1].packet.previous_response_id, undefined);
});

test("a failed terminal with missing output or prior business events stays replay protected", async context => {
  const cases = [null, { type: "response.output_text.delta", delta: "visible" },
    { type: "response.output_item.added", item: { type: "function_call", call_id: "fixture-tool", arguments: "{}" } },
    { type: "response.web_search_call.in_progress" }, { type: "response.reasoning_summary_text.delta", delta: "reasoning" }];
  for (const [index, progress] of cases.entries()) {
    const state = await fixture(context, entry => {
      const id = `resp_unsafe_${index}`;
      entry.socket.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } }));
      if (progress) entry.socket.send(JSON.stringify(progress));
      entry.socket.send(JSON.stringify({ type: "response.failed", response: { id, status: "failed",
        ...(progress ? { output: [] } : {}), error: { status: 503, code: "server_error" } } }));
    });
    const operation = `unsafe-${index}`;
    const failed = await start(state, operation, body([message("protected")])).done;
    assert.equal(failed.request.terminalOutcome, undefined);
    assert.equal(state.transport.getOperation(operation).canRetry, false);
    await start(state, operation, body([message("protected")])).done;
    assert.equal(state.messages.length, 1);
  }
});

test("conflicting response identities cannot hide business output before an empty failed terminal", async context => {
  const conflicts = [
    { type: "response.output_item.done", response_id: "resp_foreign", item: { type: "function_call", name: "counter", call_id: "fixture-call", arguments: "{}" } },
    { type: "response.failed", response_id: "resp_foreign", response: { id: "resp_active", status: "failed", output: [], error: { status: 503 } } },
  ];
  for (const [index, conflict] of conflicts.entries()) {
    const state = await fixture(context, entry => {
      entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_active", status: "in_progress", output: [] } }));
      entry.socket.send(JSON.stringify(conflict));
      entry.socket.send(JSON.stringify({ type: "response.failed", response: { id: "resp_active", status: "failed", output: [], error: { status: 503 } } }));
    });
    const operation = `conflicting-terminal-${index}`;
    const failed = await start(state, operation, body([message("identity guard")])).done;
    assert.equal(failed.error.code, "WS_RESPONSE_ID_CONFLICT");
    assert.equal(failed.request.terminalEvidence, undefined);
    assert.equal(state.transport.getOperation(operation).canRetry, false);
    await start(state, operation, body([message("identity guard")])).done;
    assert.equal(state.messages.length, 1);
  }
});

test("late prewarm business events cannot be mistaken for harmless completed response duplicates", async context => {
  const state = await fixture(context, entry => {
    if (entry.index === 1) return complete(entry.socket, "resp_warm_old");
    entry.socket.send(JSON.stringify({ type: "response.mcp_call.completed", response_id: "resp_warm_old" }));
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_new", status: "in_progress", output: [] } }));
    entry.socket.send(JSON.stringify({ type: "response.failed", response: { id: "resp_new", status: "failed", output: [], error: { status: 503 } } }));
  }, { maxMessageBytes: 1500 });
  const failed = await start(state, "late-warm-business", body([message("A".repeat(700)), message("B".repeat(700)), message("C".repeat(700))])).done;
  assert.equal(failed.error.code, "WS_RESPONSE_ID_CONFLICT");
  assert.equal(failed.request.terminalEvidence, undefined);
  assert.equal(state.transport.getOperation("late-warm-business").canRetry, false);
});

test("verified prewarm failures deliver an immutable internal proof without consuming SSE", async context => {
  const state = await fixture(context, entry => {
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_warm_failed", status: "in_progress", output: [] } }));
    entry.socket.send(JSON.stringify({ type: "response.failed", response: { id: "resp_warm_failed", status: "failed", output: [], error: { status: 503, code: "server_error" } } }));
  }, { maxMessageBytes: 1500 });
  const failed = await start(state, "warm-empty-failed", body([message("A".repeat(700)), message("B".repeat(700)), message("C".repeat(700))])).done;
  const evidence = failed.error.terminalEvidence;
  assert.equal(evidence, failed.request.terminalEvidence);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(evidence.responseId, "resp_warm_failed");
  assert.equal(evidence.operationId, "warm-empty-failed");
  assert.equal(state.messages[0].packet.generate, false);
  const policy = classifyModelFailure({ source: "transport", requestAccepted: failed.error.requestAccepted,
    statusCode: failed.error.httpStatus, code: failed.error.code, terminalEvidence: evidence });
  assert.equal(policy.acceptance, "accepted");
  assert.equal(policy.retryable, true);
  assert.equal(classifyModelFailure({ source: "transport", requestAccepted: true, statusCode: 503,
    terminalEvidence: { ...evidence } }).retryable, false);
});

test("projected prewarm cache and complete body budget is rejected before any packet", async context => {
  const state = await fixture(context, null, { maxMessageBytes: 500, maxSessionBytes: 1400 });
  const payload = body([message("A".repeat(180)), message("B".repeat(180)), message("C".repeat(180))]);
  const failed = await start(state, "projected-budget", payload).done;
  assert.equal(failed.error.code, "session_bytes_exceeded");
  assert.equal(failed.error.requestAccepted, false);
  assert.equal(state.messages.length, 0);
  assert.equal(state.connections.length, 0);
});

test("handshake rejection is definitely unsent and permits an explicit same-operation retry", async context => {
  const server = createServer();
  const websocketServer = new WebSocketServer({ noServer: true });
  let reject = true;
  let packets = 0;
  const sockets = new Set();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (request, socket, head) => {
    if (reject) socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    else websocketServer.handleUpgrade(request, socket, head, websocket => {
      websocket.on("message", () => { packets += 1; complete(websocket, "resp_retry"); });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const transport = createIncrementalResponsesTransport();
  context.after(async () => {
    transport.close();
    for (const socket of sockets) socket.destroy();
    websocketServer.close();
    await new Promise(resolve => server.close(resolve));
  });
  const state = { transport, url: `ws://127.0.0.1:${server.address().port}/responses` };
  const first = await start(state, "safe-retry", body([message("retry")])).done;
  assert.equal(first.error.requestAccepted, false);
  assert.equal(first.error.httpStatus, 401);
  assert.equal(transport.getOperation("safe-retry").canRetry, true);
  reject = false;
  const second = await start(state, "safe-retry", body([message("retry")])).done;
  assert.equal(second.error, undefined);
  assert.equal(packets, 1);
  assert.equal(transport.getOperation("safe-retry").attempt, 2);
});

test("queued cancellation removes only that job and leaves current and other-session sockets alive", async context => {
  let release;
  const state = await fixture(context, entry => {
    if (entry.index === 1) release = () => complete(entry.socket, "resp_live");
    else complete(entry.socket, `resp_${entry.index}`);
  });
  const first = start(state, "cancel-active-holder", body([message("holder")]));
  await waitFor(() => release);
  const controller = new AbortController();
  const queued = start(state, "cancel-queued", body([message("holder"), message("queued")]), { signal: controller.signal });
  await waitFor(() => state.transport.status().queued === 1);
  controller.abort();
  const cancelled = await queued.done;
  assert.equal(cancelled.error.code, "ABORT_ERR");
  assert.equal(cancelled.error.requestAccepted, false);
  assert.equal(state.connections[0].socket.readyState, WebSocket.OPEN);
  const independent = await start(state, "cancel-independent", body([message("other")]), { sessionKey: "session-b" }).done;
  assert.equal(independent.error, undefined);
  release();
  assert.equal((await first.done).error, undefined);
  assert.equal(state.messages.length, 2);
});

test("cancelling while awaiting a terminal preserves acceptance and rebuilds only its own session", async context => {
  const state = await fixture(context, entry => {
    if (entry.packet.input[0]?.content?.[0]?.text === "cancel") entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_cancel" } }));
    else complete(entry.socket, `resp_${entry.index}`);
  });
  await start(state, "other-live", body([message("other")]), { sessionKey: "session-b" }).done;
  const pending = start(state, "await-cancel", body([message("cancel")]));
  await waitFor(() => pending.request.operationAcceptance === true);
  pending.request.destroy();
  assert.equal((await pending.done).error.requestAccepted, true);
  assert.equal(state.connections[0].socket.readyState, WebSocket.OPEN);
  assert.equal(state.transport.getOperation("await-cancel").state, "cancelled");
  await start(state, "after-cancel", body([message("fresh")])).done;
  assert.equal(state.messages.at(-1).packet.previous_response_id, undefined);
});

test("connecting cancellation is unsent; Writable finish only reports local body completion", async context => {
  const server = createServer();
  const sockets = new Set();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", () => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const transport = createIncrementalResponsesTransport({ connectTimeoutMs: 1000 });
  context.after(async () => {
    transport.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  const state = { transport, url: `ws://127.0.0.1:${server.address().port}/responses` };
  const controller = new AbortController();
  const pending = start(state, "connect-cancel", body([message("connect")]), { signal: controller.signal, end: false });
  const finished = once(pending.request, "finish");
  pending.request.end("raw body");
  await finished;
  assert.equal(pending.request.operationAcceptance, false);
  await waitFor(() => pending.request.requestTransmissionState === "connecting");
  controller.abort();
  assert.equal((await pending.done).error.requestAccepted, false);
  assert.equal(transport.status().connections, 0);
});

test("PassThrough backpressure pauses and resumes the actual loopback websocket", async context => {
  let pauses = 0;
  let resumes = 0;
  const state = await fixture(context, entry => {
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_pressure" } }));
    for (let index = 0; index < 20; index += 1) entry.socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "X".repeat(400), index }));
    entry.socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_pressure", status: "completed", output: [] } }));
  }, {
    responseHighWaterMark: 64,
    createWebSocket(url, options) {
      const socket = new WebSocket(url, options);
      const pause = socket.pause.bind(socket);
      const resume = socket.resume.bind(socket);
      socket.pause = () => { pauses += 1; pause(); };
      socket.resume = () => { resumes += 1; resume(); };
      return socket;
    },
  });
  const request = state.transport.createRequestClient({ sessionKey: "pressure", operationId: "pressure", payload: body([message("pressure")]), url: state.url }).request(state.url);
  const incoming = once(request, "response");
  request.end("ignored");
  const [response] = await incoming;
  await waitFor(() => pauses > 0);
  assert.ok(response.readableLength > 0);
  let raw = "";
  for await (const chunk of response) raw += chunk.toString();
  assert.equal((raw.match(/event: response.output_text.delta/g) ?? []).length, 20);
  assert.equal((raw.match(/event: response.completed/g) ?? []).length, 1);
  assert.ok(resumes > 0);
  assert.equal(state.transport.getOperation("pressure").state, "completed");
  context.diagnostic(`backpressure pause=${pauses}, resume=${resumes}, delta events=20`);
});

test("close cancels receiving-body, awaiting, and queued requests, retains operation metadata, and releases resources", async context => {
  const state = await fixture(context, () => {});
  const receiving = start(state, "close-receiving", body([message("body")]), { end: false });
  const active = start(state, "close-active", body([message("active")]));
  await waitFor(() => state.messages.length === 1);
  const queued = start(state, "close-queued", body([message("active"), message("queued")]));
  await waitFor(() => state.transport.status().queued === 1);
  state.transport.close();
  state.transport.close();
  const results = await Promise.all([receiving.done, active.done, queued.done]);
  assert.deepEqual(results.map(result => result.error.requestAccepted), [false, "unknown", false]);
  const status = state.transport.status();
  assert.equal(status.closed, true);
  assert.equal(status.connections, 0);
  assert.equal(status.sessions, 0);
  assert.equal(status.queued, 0);
  assert.equal(status.active, 0);
  assert.equal(status.retainedBytes, 0);
  assert.equal(state.transport.getOperation("close-active").requiresReconciliation, true);
  assert.equal((await start(state, "after-close", body([])).done).error.code, "transport_closed");
});

test("missing terminal times out without fabricated completion or replay", async context => {
  const state = await fixture(context, entry => entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_no_terminal" } })), { responseTimeoutMs: 30 });
  const result = await start(state, "terminal-timeout", body([message("timeout")])).done;
  assert.equal(result.error.code, "WS_TERMINAL_TIMEOUT");
  assert.equal(result.error.requestAccepted, true);
  assert.equal(result.sse.includes("response.completed"), false);
  assert.equal(state.messages.length, 1);
  assert.equal(state.transport.status().connections, 0);
});

test("unsent failed operations are reclaimed before they exhaust the operation capacity", async context => {
  const state = await fixture(context, null, { maxOperations: 2, maxSessionBytes: 2048 });
  for (let index = 0; index < 5; index += 1) {
    const rejected = await start(state, `unsent-${index}`, body([message("X".repeat(3000))])).done;
    assert.equal(rejected.error.code, "session_bytes_exceeded");
    assert.equal(rejected.error.requestAccepted, false);
  }
  const result = await start(state, "after-unsent-rejections", body([message("healthy")])).done;
  assert.equal(result.error, undefined);
  assert.equal(state.messages.length, 1);
  assert.equal(state.transport.status().operations, 2);
});

test("resource limits reclaim unsent work without evicting unknown operation protection", async context => {
  const state = await fixture(context, () => {}, { maxSessions: 1, maxOperations: 3, maxSessionBytes: 2048 });
  const active = start(state, "resource-active", body([message("active")]));
  await waitFor(() => state.messages.length === 1);
  const other = await start(state, "resource-other", body([message("other")]), { sessionKey: "session-b" }).done;
  assert.equal(other.error.code, "session_limit");
  assert.equal(other.error.requestAccepted, false);
  const large = await start(state, "resource-large", body([message("X".repeat(3000))])).done;
  assert.equal(large.error.code, "session_bytes_exceeded");
  const limitResult = await start(state, "resource-operation-limit", body([]), { sessionKey: "session-b" }).done;
  assert.equal(limitResult.error.code, "session_limit");
  assert.equal(state.transport.getOperation("resource-other"), null);
  active.request.destroy();
  await active.done;
  state.transport.invalidate("session-a");
  assert.equal(state.transport.getOperation("resource-active").acceptance, "unknown");
  assert.equal(state.transport.getOperation("resource-active").canRetry, false);
});

test("unresolved and substantive operations retain protection under capacity and fallback notifications", async context => {
  const state = await fixture(context, () => {}, { maxOperations: 1 });
  const active = start(state, "protected-active", body([message("active")]));
  await waitFor(() => state.messages.length === 1);
  assert.equal(state.transport.completeHttpFallback("protected-active"), false);
  assert.equal(state.transport.completeHttpFallback("missing"), false);
  active.request.destroy();
  await active.done;
  const limited = await start(state, "another", body([message("next")])).done;
  assert.equal(limited.error.code, "operation_limit");
  assert.equal(state.transport.getOperation("protected-active").acceptance, "unknown");
  const duplicate = await start(state, "protected-active", body([message("active")])).done;
  assert.equal(duplicate.error.code, "duplicate_operation");

  const outputState = await fixture(context, entry => {
    entry.socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "delivered" }));
    entry.socket.close();
  });
  await start(outputState, "substantive", body([message("output")])).done;
  assert.equal(outputState.transport.completeHttpFallback("substantive"), false);
  assert.equal((await start(outputState, "substantive", body([message("output")])).done).error.code, "duplicate_operation");
});

test("only explicit ws/wss endpoints are accepted; sensitive headers never select an address", async context => {
  const state = await fixture(context);
  const result = await start(state, "http-rejected", body([message("url")]), { url: "http://127.0.0.1/responses", headers: { Authorization: "wss://fixture.invalid/secret" } }).done;
  assert.equal(result.error.code, "invalid_websocket_url");
  assert.equal(result.error.requestAccepted, false);
  assert.equal(state.connections.length, 0);
  assert.equal(JSON.stringify(state.transport.getOperation("http-rejected")).includes("fixture.invalid"), false);
});

test("late events from an invalidated generation cannot contaminate a replacement connection", async context => {
  const clientSockets = [];
  const state = await fixture(context, null, { createWebSocket(url, options) {
    const socket = new WebSocket(url, options);
    clientSockets.push(socket);
    return socket;
  } });
  await start(state, "epoch-first", body([message("old")])).done;
  state.transport.invalidate("session-a", "replace");
  const next = start(state, "epoch-next", body([message("new")]));
  clientSockets[0].emit("message", Buffer.from(JSON.stringify({ type: "response.completed", response: { id: "resp_stale", output: [assistant("stale")] } })));
  const result = await next.done;
  assert.equal(result.error, undefined);
  assert.equal(result.sse.includes("resp_stale"), false);
  assert.equal(state.messages[1].packet.previous_response_id, undefined);
  assert.deepEqual(state.messages[1].packet.input, [message("new")]);
});

test("send-callback failure remains unknown and is never automatically retried", async context => {
  const state = await fixture(context, () => {}, { createWebSocket(url, options) {
    const socket = new WebSocket(url, options);
    const send = socket.send.bind(socket);
    socket.send = (wire, callback) => send(wire, () => callback(new Error("fixture send uncertainty")));
    return socket;
  } });
  const result = await start(state, "send-failure", body([message("send")])).done;
  assert.equal(result.error.code, "WS_SEND_ERROR");
  assert.equal(result.error.requestAccepted, "unknown");
  assert.equal(state.transport.getOperation("send-failure").canRetry, false);
  await delay(20);
  assert.ok(state.messages.length <= 1);
});

test("a single item that exactly fits a generation frame is not rejected for unused prewarm overhead", async context => {
  const payload = body([message("exact boundary")]);
  const exactBytes = Buffer.byteLength(JSON.stringify({ model: payload.model, instructions: payload.instructions, tools: [], store: false, type: "response.create", input: payload.input }));
  const state = await fixture(context, null, { maxMessageBytes: exactBytes });
  const result = await start(state, "exact-boundary", payload).done;
  assert.equal(result.error, undefined);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].bytes, exactBytes);
  assert.equal(state.messages[0].packet.generate, undefined);
});

test("missing prior upstream output forces a rebuild; request payload snapshots resist caller mutation", async context => {
  const output = [assistant("must be in next prefix")];
  const state = await fixture(context, entry => complete(entry.socket, `resp_${entry.index}`, output));
  const firstInput = message("first");
  await start(state, "output-prefix-1", body([firstInput])).done;
  const pendingPayload = body([firstInput, message("second")]);
  const pending = start(state, "output-prefix-2", pendingPayload, { end: false });
  pendingPayload.input[1].content[0].text = "mutated after snapshot";
  pending.request.end("ignored");
  assert.equal((await pending.done).error, undefined);
  assert.equal(state.connections.length, 2);
  assert.equal(state.messages[1].packet.previous_response_id, undefined);
  assert.deepEqual(state.messages[1].packet.input, [firstInput, message("second")]);
});

test("duplicate queued operation is blocked conservatively while its original owner remains live", async context => {
  let release;
  const state = await fixture(context, entry => {
    if (entry.index === 1) release = () => complete(entry.socket, "resp_holder");
    else complete(entry.socket, "resp_queued");
  });
  const holder = start(state, "duplicate-holder", body([message("holder")]));
  await waitFor(() => release);
  const payload = body([message("holder"), message("queued")]);
  const original = start(state, "duplicate-queued", payload);
  await waitFor(() => state.transport.status().queued === 1);
  const duplicate = await start(state, "duplicate-queued", payload).done;
  assert.equal(duplicate.error.code, "duplicate_operation");
  assert.equal(duplicate.error.requestAccepted, "unknown");
  assert.equal(state.transport.getOperation("duplicate-queued").state, "queued");
  assert.equal(state.transport.getOperation("duplicate-queued").acceptance, false);
  release();
  await holder.done;
  assert.equal((await original.done).error, undefined);
  assert.equal(state.messages.length, 2);
});

test("receiving-body reservations obey session byte limits before any end or connection", async context => {
  const state = await fixture(context, null, { maxSessionBytes: 1500 });
  const first = start(state, "held-1", body([message("A".repeat(600))]), { end: false });
  assert.equal(state.transport.status().receiving, 1);
  assert.ok(state.transport.status().retainedBytes > 600);
  const second = await start(state, "held-2", body([message("B".repeat(600))])).done;
  assert.equal(second.error.code, "session_bytes_exceeded");
  assert.equal(second.error.requestAccepted, false);
  assert.equal(state.connections.length, 0);
  first.request.destroy(new Error("caller cancellation detail"));
  const result = await first.done;
  assert.equal(result.error.code, "ABORT_ERR");
  assert.equal(result.error.requestAccepted, false);
  assert.equal(result.error.message.includes("caller cancellation detail"), false);
  assert.equal(state.transport.status().retainedBytes, 0);
  assert.equal(state.transport.status().receiving, 0);
});

test("already-aborted signals never connect and client getters remain live during generation", async context => {
  let release;
  const state = await fixture(context, entry => {
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_getter" } }));
    release = () => entry.socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_getter", status: "completed", output: [] } }));
  });
  const controller = new AbortController();
  controller.abort();
  const cancelled = await start(state, "already-aborted", body([message("abort")]), { signal: controller.signal }).done;
  assert.equal(cancelled.error.requestAccepted, false);
  assert.equal(state.connections.length, 0);
  const client = state.transport.createRequestClient({ sessionKey: "getter", operationId: "getter", payload: body([message("getter")]), url: state.url });
  const request = client.request(state.url);
  request.on("response", response => response.resume());
  request.end("ignored");
  await waitFor(() => client.operationAcceptance === true);
  assert.equal(client.requestTransmissionState, "response_received");
  release();
  await waitFor(() => state.transport.getOperation("getter").state === "completed");
  assert.equal(client.operationAcceptance, true);
  assert.equal(client.requestTransmissionState, "completed");
});

test("an injected agent is passed to the websocket factory without touching a real proxy", async context => {
  const agent = { fixtureAgent: true };
  let seenAgent;
  const state = await fixture(context, null, { agent, createWebSocket(url, options) {
    seenAgent = options.agent;
    const { agent: _agent, ...directOptions } = options;
    return new WebSocket(url, directOptions);
  } });
  assert.equal((await start(state, "agent", body([message("agent")])).done).error, undefined);
  assert.equal(seenAgent, agent);
});

test("upstream failure event stays byte-for-byte SSE and never creates a successful terminal", async context => {
  const raw = '{ "type": "response.failed", "response": { "id": "resp_failed", "error": { "status_code": "503" } } }';
  const state = await fixture(context, entry => entry.socket.send(raw));
  const result = await start(state, "raw-failure", body([message("failure")])).done;
  assert.equal(result.error.httpStatus, 503);
  assert.equal(result.error.requestAccepted, true);
  assert.ok(result.sse.includes(`data: ${raw}\n\n`));
  assert.equal(result.sse.includes("response.completed"), false);
  assert.equal(state.transport.getOperation("raw-failure").acceptance, true);
});

test("backpressure across separate network reads preserves the terminal and the next queued operation", async context => {
  const state = await fixture(context, entry => {
    if (entry.index !== 1) return complete(entry.socket, "resp_after_pressure");
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "resp_slow_pressure" } }));
    setTimeout(() => {
      if (entry.socket.readyState !== WebSocket.OPEN) return;
      entry.socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "delayed" }));
      entry.socket.send(JSON.stringify({ type: "response.completed", response: { id: "resp_slow_pressure", status: "completed", output: [] } }));
    }, 20);
  }, { responseHighWaterMark: 32 });
  const payload = body([message("slow pressure")]);
  const request = state.transport.createRequestClient({ sessionKey: "session-a", operationId: "slow-pressure", payload, url: state.url, headers: fixtureHeaders }).request(state.url);
  const incoming = once(request, "response");
  request.end("ignored");
  const [response] = await incoming;
  const next = start(state, "after-slow-pressure", body([...payload.input, message("next")]));
  await delay(35);
  assert.equal(state.transport.status().queued, 1);
  let raw = "";
  for await (const chunk of response) raw += chunk.toString();
  assert.match(raw, /delayed/);
  assert.match(raw, /resp_slow_pressure/);
  assert.equal((await next.done).error, undefined);
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[1].packet.previous_response_id, "resp_slow_pressure");
  assert.deepEqual(state.messages[1].packet.input, [message("next")]);
  assert.equal(state.transport.status().retainedBytes > 0, true);
});

test("large UTF8 histories remain atomic, every frame respects its limit, and the next turn is incremental", async context => {
  const state = await fixture(context, null, { maxMessageBytes: 4096 });
  const input = Array.from({ length: 2000 }, (_unused, index) => message(`条目${index}:${"完整文本".repeat(8)}`));
  const first = await start(state, "large-history", body(input)).done;
  assert.equal(first.error, undefined);
  assert.deepEqual(state.messages.flatMap(entry => entry.packet.input), input);
  assert.ok(state.messages.every(entry => entry.bytes <= 4096));
  const prewarmFrames = state.messages.length - 1;
  const terminalId = `resp_${state.messages.length}`;
  assert.ok(prewarmFrames > 10);
  const next = await start(state, "large-history-next", body([...input, message("next")])).done;
  assert.equal(next.error, undefined);
  assert.equal(state.connections.length, 1);
  assert.equal(state.messages.at(-1).packet.previous_response_id, terminalId);
  assert.deepEqual(state.messages.at(-1).packet.input, [message("next")]);
  context.diagnostic(`large history items=2000; prewarm frames=${prewarmFrames}; frame cap=4096B; next-turn bytes=${state.messages.at(-1).bytes}`);
});

test("idle session eviction never evicts its unknown operation ledger", async context => {
  const state = await fixture(context, entry => {
    if (entry.index === 1) entry.socket.terminate();
    else complete(entry.socket, "resp_other_session");
  }, { maxSessions: 1 });
  await start(state, "evicted-unknown", body([message("unknown")])).done;
  const other = await start(state, "replacement-session", body([message("new")]), { sessionKey: "session-b" }).done;
  assert.equal(other.error, undefined);
  assert.equal(state.transport.status().sessions, 1);
  assert.equal(state.transport.getOperation("evicted-unknown").acceptance, "unknown");
  const duplicate = await start(state, "evicted-unknown", body([message("unknown")])).done;
  assert.equal(duplicate.error.code, "duplicate_operation");
  assert.equal(duplicate.error.requestAccepted, "unknown");
  assert.equal(state.messages.length, 2);
});

test("opt-in loopback preserves a complete 512x256 PNG exactly at a prewarm packet boundary", async context => {
  const png = redBluePng();
  assert.equal(png.readUInt32BE(16), 512);
  assert.equal(png.readUInt32BE(20), 256);
  const idatOffset = png.indexOf(Buffer.from("IDAT"));
  const idatLength = png.readUInt32BE(idatOffset - 4);
  const pixels = inflateSync(png.subarray(idatOffset + 4, idatOffset + 4 + idatLength));
  const rowBytes = 512 * 3 + 1;
  for (const row of [0, 255]) {
    assert.deepEqual([...pixels.subarray(row * rowBytes + 1, row * rowBytes + 4)], [255, 0, 0]);
    assert.deepEqual([...pixels.subarray(row * rowBytes + 1 + 511 * 3, row * rowBytes + 4 + 511 * 3)], [0, 0, 255]);
  }
  const imageUrl = `data:image/png;base64,${png.toString("base64")}`;
  const image = { type: "message", role: "user", content: [{ type: "input_image", image_url: imageUrl }] };
  const imageEnvelope = { ...body([image]), type: "response.create", store: false, previous_response_id: "resp_1", generate: false };
  const cap = Buffer.byteLength(JSON.stringify(imageEnvelope));
  const input = [message("A".repeat(cap - 220)), image, message("generate")];
  const state = await fixture(context, null, { allowImagePrewarm: true, maxMessageBytes: cap, maxPreviousResponseIdBytes: 8 });
  const result = await start(state, "png-boundary", body(input)).done;
  assert.equal(result.error, undefined);
  assert.equal(state.messages.length, 3);
  assert.deepEqual(state.messages.map(entry => entry.packet.generate), [false, false, undefined]);
  assert.equal(state.messages[1].bytes, cap);
  assert.ok(state.messages.every(entry => entry.bytes <= cap));
  assert.deepEqual(state.messages.flatMap(entry => entry.packet.input), input);
  assert.deepEqual(state.messages[1].packet.input, [image]);
  const forwarded = state.messages[1].packet.input[0].content[0].image_url;
  assert.equal(forwarded, imageUrl);
  assert.deepEqual(Buffer.from(forwarded.slice("data:image/png;base64,".length), "base64"), png);
  assert.equal(state.messages[1].packet.previous_response_id, "resp_1");
  assert.equal(state.messages[2].packet.previous_response_id, "resp_2");
  assert.equal((result.sse.match(/event: response.completed/g) ?? []).length, 1);
  context.diagnostic(`loopback-only PNG bytes=${png.length}; exact image prewarm packet=${cap}B; complete image atoms=1; generation frames=1`);
});

test("opt-in rejects a complete PNG one byte above a single-item packet cap without splitting or sending", async context => {
  const png = redBluePng();
  const image = { type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` }] };
  const payload = body([image]);
  const fullBytes = Buffer.byteLength(JSON.stringify({ ...payload, type: "response.create", store: false }));
  const state = await fixture(context, null, { allowImagePrewarm: true, maxMessageBytes: fullBytes - 1 });
  const result = await start(state, "png-over-boundary", payload).done;
  assert.equal(result.error.code, "payload_too_large");
  assert.equal(result.error.requestAccepted, false);
  assert.equal(result.error.requestTransmissionState, "not_sent");
  assert.equal(state.messages.length, 0);
  assert.equal(state.connections.length, 0);
  assert.equal(state.transport.getOperation("png-over-boundary").canRetry, true);
});

function synchronousFixture(context, handler, options = {}) {
  const packets = [];
  const sockets = [];
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      this.readyState = 0;
      sockets.push(this);
      queueMicrotask(() => { this.readyState = 1; this.emit("open"); });
    }
    send(wire, callback) {
      const packet = JSON.parse(wire);
      packets.push(packet);
      handler(this, packet, packets.length);
      callback?.();
    }
    terminate() { this.readyState = 3; }
    pause() {}
    resume() {}
    event(event) { this.emit("message", Buffer.from(JSON.stringify(event))); }
    complete(id, output = []) { this.event({ type: "response.completed", response: { id, status: "completed", output } }); }
  }
  const transport = createIncrementalResponsesTransport({ createWebSocket: () => new FakeSocket(), ...options });
  context.after(() => {
    transport.close();
    assert.equal(transport.status().retainedBytes, 0);
    assert.equal(transport.status().active, 0);
    assert.equal(transport.status().connections, 0);
  });
  return { transport, packets, sockets, url: "ws://127.0.0.1:9/responses" };
}

test("explicit no-output failures retain their original classification and allow the same internal operation", async context => {
  for (const error of [{ code: "server_error" }, { type: "server_error" }, { code: "rate_limit_exceeded" }, { code: "server_error", status: 503 }]) {
    const state = synchronousFixture(context, (socket, _packet, index) => {
      if (index === 1) socket.event({ type: "error", error });
      else socket.complete("recovered");
    });
    const input = body([message("recover original operation")]);
    const first = await start(state, "raw-failure", input).done;
    assert.deepEqual(first.error.upstreamError, error);
    const retry = await start(state, "raw-failure", input, { retryWithoutOutput: true }).done;
    assert.equal(retry.error, undefined);
    assert.equal(state.packets.length, 2);
    assert.equal(state.transport.getOperation("raw-failure").attempt, 2);
  }
});

test("a local duplicate preserves the original operation and its raw failure", async context => {
  const error = { code: "server_error", message: "original unavailable" };
  const state = synchronousFixture(context, socket => socket.event({ type: "error", error }));
  const input = body([message("original")]);
  await start(state, "local-rejection", input).done;
  const previous = state.transport.getOperation("local-rejection");
  const duplicate = await start(state, "local-rejection", input).done;
  assert.equal(duplicate.error.localRejection, true);
  assert.deepEqual(duplicate.error.upstreamError, error);
  assert.equal(duplicate.error.previousFailure.upstreamCode, "server_error");
  assert.deepEqual(state.transport.getOperation("local-rejection"), previous);
  assert.equal(state.packets.length, 1);
});

test("real output and permanent upstream failures remain protected from an internal replay", async context => {
  const cases = [
    { error: { code: "server_error", status: 503 }, output: [assistant("real output")] },
    { error: { code: "server_error", status: 503 }, output: [{ type: "reasoning", encrypted_content: "real reasoning" }] },
    { error: { code: "server_error", status: 503 }, output: [{ type: "function_call", name: "fixture", call_id: "protected-call", arguments: "{}" }] },
    ...["invalid_api_key", "insufficient_quota", "content_policy_violation", "unrecognized_failure"].map(code => ({ error: { code }, output: [] })),
  ];
  for (const scenario of cases) {
    const state = synchronousFixture(context, socket => {
      socket.event({ type: "response.created", response: { id: "protected", status: "in_progress" } });
      socket.event({ type: "response.failed", response: { id: "protected", status: "failed", ...scenario } });
    });
    const input = body([message("protected")]);
    await start(state, "protected-output", input).done;
    const previous = state.transport.getOperation("protected-output");
    assert.equal(previous.canRetry, false);
    const retry = await start(state, "protected-output", input, { retryWithoutOutput: true }).done;
    assert.equal(retry.error.code, "duplicate_operation");
    assert.deepEqual(state.transport.getOperation("protected-output"), previous);
    assert.equal(state.packets.length, 1);
  }
});

test("synchronous terminal consumer sees committed state and destruction leaves the next operation incremental", async context => {
  const output = [assistant("trusted output")];
  const state = synchronousFixture(context, (socket, _packet, index) => socket.complete(`resp_${index}`, output));
  const input = [message("first")];
  const request = state.transport.createRequestClient({ sessionKey: "session-a", operationId: "sync-first", payload: body(input), url: state.url, headers: fixtureHeaders }).request(state.url);
  const ended = new Promise(resolve => request.on("response", response => {
    response.on("data", chunk => {
      assert.match(String(chunk), /response.completed/);
      assert.equal(state.transport.getOperation("sync-first").state, "completed");
      request.destroy();
      response.destroy();
      resolve();
    });
  }));
  request.end("{}");
  await ended;
  const next = message("next");
  const result = await start(state, "sync-next", body([...input, ...output, next])).done;
  assert.equal(result.error, undefined);
  assert.equal(state.sockets.length, 1);
  assert.deepEqual(state.packets[1].input, [next]);
  assert.equal(state.packets[1].previous_response_id, "resp_1");
});

test("synchronous delta cancellation, failed and incomplete cannot complete or poison the queued operation", async context => {
  for (const type of ["response.output_text.delta", "error", "response.failed", "response.incomplete"]) {
    const state = synchronousFixture(context, (socket, _packet, index) => {
      if (index === 1) socket.event({ type, delta: "cancel here", error: { code: "fixture_failure" } });
      else socket.complete(`resp_${index}`);
    });
    const first = state.transport.createRequestClient({ sessionKey: "session-a", operationId: `failure-${type}`, payload: body([message("first")]), url: state.url }).request(state.url);
    first.on("response", response => response.on("data", () => { first.destroy(); response.destroy(); }));
    const failure = new Promise(resolve => { first.once("error", resolve); first.once("close", resolve); });
    first.end("{}");
    const queued = start(state, `next-${type}`, body([message("fresh")]));
    await failure;
    const result = await queued.done;
    assert.equal(result.error, undefined);
    assert.notEqual(state.transport.getOperation(`failure-${type}`).state, "completed");
    assert.equal(state.packets[1].previous_response_id, undefined);
    assert.deepEqual(state.packets[1].input, [message("fresh")]);
  }
});

test("invalid prewarm output and invalid completed status never publish success", async context => {
  for (const warm of [false, true]) {
    const state = synchronousFixture(context, socket => socket.event({ type: "response.completed", response: {
      id: "resp_bad", status: warm ? "completed" : "incomplete", output: [assistant("invalid")],
    } }), { maxMessageBytes: warm ? 600 : 2048, maxPreviousResponseIdBytes: 16 });
    const result = await start(state, `invalid-${warm}`, body(warm ? [message("a".repeat(300)), message("b".repeat(300))] : [message("first")])).done;
    assert.ok(result.error);
    assert.doesNotMatch(result.sse, /response.completed/);
    assert.notEqual(state.transport.getOperation(`invalid-${warm}`).state, "completed");
  }
});

test("all atomic groups and reserved future IDs are checked before the first send", async context => {
  for (const tail of [message("x".repeat(380)),
    { type: "message", role: "user", content: [{ type: "input_image", image_url: "x".repeat(380) }] },
    ...[[{ type: "function_call", call_id: "same", name: "tool", arguments: "x".repeat(200) }, { type: "function_call_output", call_id: "same", output: "y".repeat(150) }]]]) {
    const state = synchronousFixture(context, socket => socket.complete("resp_1"), {
      maxMessageBytes: 650, maxPreviousResponseIdBytes: 128, allowImagePrewarm: true,
    });
    const input = [message("first".repeat(45)), ...(Array.isArray(tail) ? tail : [tail])];
    const result = await start(state, "planned-too-large", body(input)).done;
    assert.equal(result.error?.code, "payload_too_large");
    assert.equal(result.error.requestAccepted, false);
    assert.equal(result.error.requestTransmissionState, "not_sent");
    assert.equal(state.packets.length, 0);
    assert.equal(state.sockets.length, 0);
  }
});

test("local ID byte contract prevents escaped oversized IDs from invalidating later planned frames", async context => {
  const state = synchronousFixture(context, socket => socket.complete("\"".repeat(40)), {
    maxMessageBytes: 600, maxPreviousResponseIdBytes: 32,
  });
  const result = await start(state, "id-contract", body([message("a".repeat(300)), message("b".repeat(300))])).done;
  assert.equal(result.error.code, "WS_RESPONSE_ID_LIMIT");
  assert.equal(state.packets.length, 1);
  assert.equal(state.transport.getOperation("id-contract").requiresReconciliation, true);
});

test("ws receive length errors preserve direction, original close code and unknown acceptance", async context => {
  const state = synchronousFixture(context, socket => {
    const error = new RangeError("Max payload size exceeded");
    error.code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
    error[Symbol("status-code")] = 1009;
    socket.emit("error", error);
  });
  const result = await start(state, "receive-limit", body([message("hello")])).done;
  assert.equal(result.error.code, "WS_MESSAGE_TOO_LARGE");
  assert.equal(result.error.direction, "receive");
  assert.equal(result.error.closeCode, 1009);
  assert.equal(result.error.wsErrorCode, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
  assert.equal(result.error.requestAccepted, "unknown");
  assert.equal((await start(state, "receive-limit", body([message("hello")])).done).error.code, "duplicate_operation");
  assert.equal(state.packets.length, 1);
});

test("completed operation recycling permits long trajectories while unknown entries stay protected", async context => {
  const state = synchronousFixture(context, (socket, _packet, index) => {
    if (index === 1) socket.emit("close", 1006);
    else socket.complete(`resp_${index}`);
  }, { maxOperations: 4096 });
  await start(state, "unknown-keep", body([message("unknown")])).done;
  for (let index = 0; index < 4100; index += 1) {
    const result = await start(state, `long-${index}`, body([message(`fresh-${index}`)])).done;
    assert.equal(result.error, undefined);
  }
  assert.equal(state.transport.getOperation("unknown-keep").acceptance, "unknown");
  assert.equal(state.transport.status().operations, 4096);
});

test("real ws receiver length failure preserves the local receive 1009 diagnostic", async context => {
  const state = await fixture(context, entry => {
    entry.socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(20000) }));
  }, { maxSessionBytes: 10000 });
  const result = await start(state, "real-receive-limit", body([message("hello")])).done;
  assert.equal(result.error.code, "WS_MESSAGE_TOO_LARGE");
  assert.equal(result.error.direction, "receive");
  assert.equal(result.error.closeCode, 1009);
  assert.equal(result.error.wsErrorCode, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
  assert.equal(result.error.requestAccepted, "unknown");
  assert.equal(state.messages.length, 1);
});

test("planned packets remain within the cap for a growing UTF8 and escaped previous ID", async context => {
  const ids = ["resp_1", "\"".repeat(18) + "汉".repeat(7), "resp_3"];
  const state = synchronousFixture(context, (socket, _packet, index) => socket.complete(ids[index - 1] ?? `resp_${index}`), {
    maxMessageBytes: 650, maxPreviousResponseIdBytes: 64,
  });
  const input = [message("a".repeat(300)), message("b".repeat(300)), message("c".repeat(300))];
  const result = await start(state, "growing-id", body(input)).done;
  assert.equal(result.error, undefined);
  assert.deepEqual(state.packets.flatMap(packet => packet.input), input);
  assert.ok(state.packets.every(packet => Buffer.byteLength(JSON.stringify(packet)) <= 650));
  assert.equal(state.packets[2].previous_response_id, ids[1]);
});

test("managed websocket recovery retries a verified empty failed response before actual completion", async context => {
  for (const prewarm of [false, true]) await context.test(prewarm ? "prewarm terminal" : "generation terminal", async context => {
  const state = await fixture(context, entry => {
    const id = `resp_managed_${entry.index}`;
    if (entry.index > 1) return entry.packet.generate === false ? complete(entry.socket, id)
      : complete(entry.socket, id, [assistant("actual completion")], "actual completion");
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } }));
    entry.socket.send(JSON.stringify({ type: "response.failed", response: { id, status: "failed", output: [],
      error: { status: 503, code: "server_error" } } }));
  }, prewarm ? { maxMessageBytes: 1500 } : {});
  const recovery = [];
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: "http://127.0.0.1:9", managedRecovery: true,
    managedRetryBaseMs: 10, incrementalTransport: state.transport, incrementalUpstreamUrl: state.url,
    onRecoveryState: entry => recovery.push(entry) });
  await proxy.start();
  context.after(() => proxy.stop());
  const text = await new Promise((resolve, reject) => {
    const input = prewarm ? [message("A".repeat(700)), message("B".repeat(700)), message("C".repeat(700))] : [message("recover")];
    const encoded = Buffer.from(JSON.stringify({ ...body(input), stream: true }));
    const request = httpRequest({ hostname: "127.0.0.1", port: proxy.status().port, method: "POST", path: "/v1/responses",
      headers: { "content-type": "application/json", "content-length": encoded.length,
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: "retry-thread", turn_id: "retry-turn" }) } }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.once("end", () => resolve(text));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.setTimeout(2500, () => request.destroy(new Error("Managed terminal fixture timeout")));
    const watchdog = setTimeout(() => request.destroy(new Error("Managed terminal wall-clock timeout")), 4000);
    request.once("close", () => clearTimeout(watchdog));
    request.end(encoded);
  });
  assert.ok(state.messages.length >= 2);
  if (!prewarm) assert.equal(state.messages.length, 2);
  else assert.equal(state.messages.filter(entry => entry.packet.generate !== false).length, 1);
  assert.equal(state.connections.length, 2);
  assert.equal((text.match(/event: response.completed/g) ?? []).length, 1);
  assert.equal((text.match(/event: response.failed/g) ?? []).length, 0);
  assert.equal(recovery.filter(entry => entry.phase === "waiting" && entry.willRetry).length, 1);
  assert.ok(recovery.filter(entry => entry.phase === "waiting").every(entry => entry.acceptance === "accepted"));
  assert.equal(proxy.status().operationLedger.protectedOperations, 0);
  });
});

test("managed independent sampling compaction keeps temporary failures inside its own recovery loop", async context => {
  let calls = 0;
  const upstream = createServer((request, response) => {
    request.resume();
    if (++calls <= 2) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "server_error", message: "temporary fixture" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_compact_actual","status":"completed","output":[{"type":"compaction","encrypted_content":"fixture-only"}]}}\n\n');
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  context.after(() => new Promise(resolve => upstream.close(resolve)));
  const recovery = [];
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`,
    managedRecovery: true, managedRetryBaseMs: 10, onRecoveryState: entry => recovery.push(entry) });
  await proxy.start();
  context.after(() => proxy.stop());
  const text = await new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify({ ...body([message("compact")]), stream: true }));
    const request = httpRequest({ hostname: "127.0.0.1", port: proxy.status().port, method: "POST", path: "/v1/responses",
      headers: { "content-type": "application/json", "content-length": encoded.length,
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction", thread_id: "compact-thread", turn_id: "compact-turn" }) } }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.once("end", () => resolve(text));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.setTimeout(2500, () => request.destroy(new Error("Compaction recovery fixture timeout")));
    request.end(encoded);
  });
  assert.equal(calls, 3);
  assert.match(text, /resp_compact_actual/);
  assert.equal(recovery.filter(entry => entry.phase === "waiting" && entry.willRetry).length, 2);
  assert.ok(recovery.every(entry => entry.requestKind === "compaction"));
});

test("real proxy adapter consumes synchronous FakeSocket completion and the next tool sampling safely", async context => {
  const call = { type: "function_call", call_id: "sync-call", name: "fixture", arguments: "{}" };
  const state = synchronousFixture(context, (socket, _packet, index) => socket.complete(`resp_${index}`, index === 1 ? [call] : []));
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: "http://127.0.0.1:9", managedRecovery: true,
    incrementalTransport: state.transport, incrementalUpstreamUrl: state.url });
  await proxy.start();
  context.after(() => proxy.stop());
  async function invoke(input) {
    return new Promise((resolve, reject) => {
      const encoded = Buffer.from(JSON.stringify({ ...body(input), stream: true }));
      const request = httpRequest({ hostname: "127.0.0.1", port: proxy.status().port, method: "POST", path: "/v1/responses",
        headers: { "content-type": "application/json", "content-length": encoded.length,
          "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: "sync-thread", turn_id: "sync-turn" }) } }, response => {
        let text = "";
        response.on("data", chunk => { text += chunk; });
        response.once("end", () => resolve(text));
        response.once("error", reject);
      });
      request.once("error", reject);
      request.setTimeout(2500, () => request.destroy(new Error("Adapter timeout")));
      request.end(encoded);
    });
  }
  const input = [message("tool question")];
  assert.match(await invoke(input), /response.completed/);
  const result = { type: "function_call_output", call_id: "sync-call", output: "tool result" };
  assert.match(await invoke([...input, call, result]), /response.completed/);
  assert.equal(state.packets.length, 2);
  assert.deepEqual(state.packets[1].input, [result]);
  assert.equal(state.packets[1].previous_response_id, "resp_1");
});

test("body reasoning and tool progress each keep generation alive across its former fixed deadline", async context => {
  for (const type of ["response.output_text.delta", "response.reasoning_summary_text.delta", "response.function_call_arguments.delta"]) {
    const state = synchronousFixture(context, socket => {
      let ticks = 0;
      const timer = setInterval(() => {
        socket.event({ type, delta: "actual progress" });
        if (++ticks === 16) {
          clearInterval(timer);
          socket.complete("resp_long");
        }
      }, 5);
      context.after(() => clearInterval(timer));
    }, { responseTimeoutMs: 50 });
    const result = await start(state, `long-${type}`, body([message("long")])).done;
    assert.equal(result.error, undefined);
    assert.match(result.sse, /response.completed/);
    assert.equal(state.transport.getOperation(`long-${type}`).state, "completed");
    assert.equal(state.packets.length, 1);
  }
});

test("heartbeats cannot hide a genuinely idle unknown operation", async context => {
  const state = synchronousFixture(context, socket => {
    const timer = setInterval(() => socket.event({ type: "ping" }), 5);
    context.after(() => clearInterval(timer));
  }, { responseTimeoutMs: 40 });
  const result = await start(state, "idle-unknown", body([message("idle")])).done;
  assert.equal(result.error.code, "WS_TERMINAL_TIMEOUT");
  assert.equal(result.error.requestAccepted, "unknown");
  assert.equal(state.transport.getOperation("idle-unknown").requiresReconciliation, true);
  assert.equal((await start(state, "idle-unknown", body([message("idle")])).done).error.code, "duplicate_operation");
  assert.equal(state.packets.length, 1);
});

test("empty business deltas do not refresh the generation idle deadline", async context => {
  const state = synchronousFixture(context, socket => {
    const timer = setInterval(() => socket.event({ type: "response.output_text.delta", delta: "" }), 5);
    context.after(() => clearInterval(timer));
  }, { responseTimeoutMs: 40 });
  const result = await start(state, "empty-progress", body([message("idle")])).done;
  assert.equal(result.error.code, "WS_TERMINAL_TIMEOUT");
  assert.equal(result.error.requestAccepted, true);
  assert.equal(state.transport.getOperation("empty-progress").requiresReconciliation, true);
  assert.equal(state.packets.length, 1);
});

test("accepted progress followed by silence times out accurately and cancellation never replays", async context => {
  for (const cancelRequest of [false, true]) {
    const state = synchronousFixture(context, socket => socket.event({ type: "response.output_text.delta", delta: "once" }), { responseTimeoutMs: 40 });
    const operationId = `idle-accepted-${cancelRequest}`;
    const active = start(state, operationId, body([message("accepted")]));
    if (cancelRequest) {
      await waitFor(() => state.transport.getOperation(operationId)?.acceptance === true);
      active.request.destroy();
    }
    const result = await active.done;
    assert.equal(result.error.code, cancelRequest ? "ABORT_ERR" : "WS_TERMINAL_TIMEOUT");
    assert.equal(result.error.requestAccepted, true);
    assert.notEqual(state.transport.getOperation(operationId).state, "completed");
    assert.equal((await start(state, operationId, body([message("accepted")])).done).error.code, "duplicate_operation");
    assert.equal(state.packets.length, 1);
  }
});

test("prewarm acknowledgements expose preparation progress without a response or business event", async context => {
  const progress = [];
  let sawResponse = false;
  const state = synchronousFixture(context, (socket, _packet, index) => {
    const timer = setTimeout(() => socket.complete(`resp_${index}`), 25);
    context.after(() => clearTimeout(timer));
  }, { responseTimeoutMs: 40, prewarmTimeoutMs: 70, maxMessageBytes: 650, maxPreviousResponseIdBytes: 16 });
  const active = start(state, "preparation", body(Array.from({ length: 5 }, () => message("x".repeat(300)))), {
    onPreparationProgress(event) {
      assert.equal(sawResponse, false);
      assert.equal(event.phase, "prewarm_completed");
      assert.equal(event.businessProgress, false);
      assert.equal(event.operationId, "preparation");
      progress.push(event);
    },
  });
  active.request.on("response", () => { sawResponse = true; });
  const result = await active.done;
  assert.equal(result.error, undefined);
  assert.ok(progress.length >= 3);
  assert.deepEqual(progress.map(event => event.sequence), progress.map((_event, index) => index + 1));
  assert.equal((result.sse.match(/response.completed/g) ?? []).length, 2);
  assert.equal(progress.at(-1).preparedInputItems, 4);
});

test("prewarm confirmation has a finite independent deadline despite incoming deltas", async context => {
  const progress = [];
  const state = synchronousFixture(context, socket => {
    const timer = setInterval(() => socket.event({ type: "response.output_text.delta", delta: "invalid warm activity" }), 5);
    context.after(() => clearInterval(timer));
  }, { responseTimeoutMs: 200, prewarmTimeoutMs: 40, maxMessageBytes: 650, maxPreviousResponseIdBytes: 16,
    onPreparationProgress: event => progress.push(event) });
  const result = await start(state, "warm-idle", body([message("a".repeat(300)), message("b".repeat(300))])).done;
  assert.equal(result.error.code, "WS_PREWARM_TIMEOUT");
  assert.equal(result.error.requestAccepted, true);
  assert.equal(result.response, undefined);
  assert.deepEqual(progress, []);
  assert.equal(state.packets.length, 1);
});

test("preparation callback cancellation prevents the next prewarm or generation send", async context => {
  const state = synchronousFixture(context, (socket, _packet, index) => socket.complete(`resp_${index}`), {
    maxMessageBytes: 650, maxPreviousResponseIdBytes: 16,
  });
  let active;
  active = start(state, "cancel-preparation", body([message("a".repeat(300)), message("b".repeat(300))]), {
    onPreparationProgress() { active.request.destroy(); },
  });
  const result = await active.done;
  assert.equal(result.error.code, "ABORT_ERR");
  await delay(10);
  assert.equal(state.packets.length, 1);
  assert.equal(state.transport.getOperation("cancel-preparation").state, "cancelled");
});

test("the independent transport timer protects the first prewarm later prewarms and final generation upload", async context => {
  for (const uploadAllowanceMs of [0, 150]) {
    const uploads = [];
    const state = synchronousFixture(context, (socket, _packet, index) => {
      const timer = setTimeout(() => socket.complete(`resp_${index}`), 90);
      context.after(() => clearTimeout(timer));
    }, { responseTimeoutMs: 40, prewarmTimeoutMs: 40, maxMessageBytes: 650, maxPreviousResponseIdBytes: 16 });
    const result = await start(state, `transport-upload-${uploadAllowanceMs}`,
      body(Array.from({ length: 4 }, () => message("x".repeat(300)))), {
        onPacketSending(event) { uploads.push(event); return uploadAllowanceMs; },
      }).done;
    if (uploadAllowanceMs === 0) {
      assert.equal(result.error.code, "WS_PREWARM_TIMEOUT");
      assert.equal(state.packets.length, 1);
    } else {
      assert.equal(result.error, undefined);
      assert.equal(state.packets.length, 4);
      assert.deepEqual(uploads.map(event => event.warm), [true, true, true, false]);
      assert.deepEqual(uploads.map(event => event.sequence), [1, 2, 3, 4]);
      assert.ok(uploads.every(event => event.businessProgress === false));
    }
  }
});

test("business progress removes upload protection from the normal generation silence timer", async context => {
  const state = synchronousFixture(context, socket => {
    const timer = setTimeout(() => socket.event({ type: "response.output_text.delta", delta: "actual progress" }), 15);
    context.after(() => clearTimeout(timer));
  }, { responseTimeoutMs: 40 });
  const startedAt = Date.now();
  const result = await start(state, "upload-then-silence", body([message("single")]), {
    onPacketSending: () => 500,
  }).done;
  assert.equal(result.error.code, "WS_TERMINAL_TIMEOUT");
  assert.equal(result.error.requestAccepted, true);
  assert.ok(Date.now() - startedAt < 400);
  assert.equal(state.packets.length, 1);
});
