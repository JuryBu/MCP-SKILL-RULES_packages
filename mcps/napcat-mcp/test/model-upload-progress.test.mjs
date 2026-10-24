import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";
import { createIncrementalResponsesTransport } from "../src/incremental-responses-transport.mjs";

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws");
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sse = event => `data: ${JSON.stringify(event)}\n\n`;
const payload = { model: "fixture-model", stream: true, instructions: "Loopback integration", tools: [], input: [
  { type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(1_100_000) }] },
] };

async function until(predicate, description, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(5);
  }
}

function complete(socket, id) {
  socket.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress" } }));
  socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "UPLOAD_PROGRESS_OK" }));
  socket.send(JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "UPLOAD_PROGRESS_OK" }] },
  ] } }));
}

async function fixture(context, { acknowledgementDelayMs = 100, onPing, onPacket, transportOptions = {}, proxyOptions = {} } = {}) {
  const packets = [];
  const connections = [];
  const clients = [];
  const bindings = [];
  const events = [];
  const recovery = [];
  const httpRequests = [];
  const timers = new Set();
  const later = (action, milliseconds) => {
    const timer = setTimeout(() => { timers.delete(timer); action(); }, milliseconds);
    timers.add(timer);
    return timer;
  };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      httpRequests.push(Buffer.concat(chunks));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(sse({ type: "response.completed", response: { id: "http_completed", status: "completed", output: [] } }));
    });
  });
  const websocket = new WebSocketServer({ server, autoPong: false, perMessageDeflate: false });
  websocket.on("connection", (socket, request) => {
    const connection = { index: connections.length + 1, socket, network: request.socket, pings: [], pongs: [] };
    connections.push(connection);
    socket.on("error", () => {});
    socket.on("ping", token => {
      connection.pings.push(Buffer.from(token));
      if (onPing) onPing(connection, token, later);
      else later(() => { if (socket.readyState === WebSocket.OPEN) socket.pong(token); }, acknowledgementDelayMs);
    });
    socket.on("pong", token => connection.pongs.push(Buffer.from(token)));
    socket.on("message", raw => {
      const entry = { connection: connection.index, socket, raw: Buffer.from(raw), packet: JSON.parse(raw), observedAt: Date.now() };
      packets.push(entry);
      if (onPacket) onPacket(entry, later);
      else complete(socket, `resp_${packets.length}`);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const transport = createIncrementalResponsesTransport({ maxMessageBytes: 16 * 1024 * 1024,
    maxSessionBytes: 64 * 1024 * 1024, responseTimeoutMs: 140, ...transportOptions,
    createWebSocket(url, options) {
      const socket = new WebSocket(url, options);
      const client = { socket, pongs: [] };
      clients.push(client);
      socket.on("pong", token => client.pongs.push(Buffer.from(token)));
      return socket;
    },
  });
  const createClient = transport.createRequestClient.bind(transport);
  transport.createRequestClient = options => {
    const binding = { options, packet: null, uploads: [], returns: [] };
    bindings.push(binding);
    return createClient({ ...options,
      onPacketSending(progress) {
        binding.packet = progress;
        return options.onPacketSending?.(progress);
      },
      onUploadProgress(progress) {
        binding.uploads.push(progress);
        const allowance = options.onUploadProgress?.(progress);
        binding.returns.push(allowance);
        return allowance;
      },
    });
  };
  const proxy = createCodexModelStreamProxy({ port: 0, upstreamOrigin: origin,
    incrementalTransport: transport, incrementalUpstreamUrl: `${origin.replace("http:", "ws:")}/v1/responses`,
    managedRecovery: true, managedRetryBaseMs: 10, fastRetryDelayMs: 0,
    firstProgressTimeoutMs: 140, firstLastProgressTimeoutMs: 140, progressIdleTimeoutMs: 140,
    consecutiveWaitLimitMs: 800, adaptiveWaitLimitMs: 800,
    uploadAllowanceMsPerMiB: 120, maxUploadAllowanceMs: 2000,
    onEvent: event => events.push({ ...event, observedAt: Date.now() }),
    onRecoveryState: event => recovery.push(event), ...proxyOptions,
  });
  await proxy.start();
  context.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    await proxy.stop();
    for (const client of clients) client.socket.terminate();
    for (const client of websocket.clients) client.terminate();
    await new Promise(resolve => websocket.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(proxy.status().activeRequests, 0);
    assert.equal(proxy.status().requestBuffer.usedBytes, 0);
    for (const field of ["sessions", "connections", "active", "queued", "receiving", "retainedBytes"]) assert.equal(transport.status()[field], 0, field);
    assert.ok(connections.every(connection => connection.network.destroyed));
    context.diagnostic("cleanup: active=0, connections=0, requestBuffer=0, retainedBytes=0");
  });
  const request = ({ signal, input = payload } = {}) => {
    const encoded = Buffer.from(JSON.stringify(input));
    const done = new Promise((resolve, reject) => {
      const outgoing = http.request({ hostname: "127.0.0.1", port: proxy.status().port, path: "/v1/responses", method: "POST", signal,
        headers: { "content-type": "application/json", "content-length": encoded.length, authorization: "Bearer fixture-original",
          "chatgpt-account-id": "fixture-account", "user-agent": "fixture-native-0.159",
          "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", thread_id: "upload-progress-thread", turn_id: "upload-progress-turn" }) },
      }, incoming => {
        let text = "";
        incoming.on("data", chunk => { text += chunk; });
        incoming.once("error", reject);
        incoming.once("end", () => resolve({ status: incoming.statusCode, text, events: text.split(/\r?\n\r?\n/u).flatMap(value => {
          try { return [JSON.parse(value.split("\n").find(line => line.startsWith("data:"))?.slice(5))]; }
          catch { return []; }
        }) }));
      });
      outgoing.once("error", reject);
      outgoing.end(encoded);
    });
    done.catch(() => {});
    return { done, encoded };
  };
  return { proxy, transport, request, packets, connections, clients, bindings, events, recovery, httpRequests, later };
}

test("matched remote upload progress completes the full core chain beyond its initial static budget", { timeout: 5000 }, async context => {
  const setup = await fixture(context);
  const result = await setup.request().done;
  assert.equal(result.status, 200);
  assert.equal(setup.connections.length, 1);
  assert.equal(setup.packets.length, 1);
  assert.equal(setup.httpRequests.length, 0);
  assert.deepEqual(setup.packets[0].packet.input, payload.input);
  const started = setup.events.find(event => event.type === "incremental_packet_upload_started");
  const progress = setup.events.filter(event => event.type === "incremental_packet_upload_progress");
  assert.ok(started.packetWireBytes > 256 * 1024);
  assert.ok(setup.packets[0].observedAt > started.firstProgressDeadlineAt, "real upload must outlast the original unrefreshed deadline");
  assert.equal(progress.length, 4);
  assert.deepEqual(progress.map(event => event.acknowledgedBytes), [262144, 524288, 786432, 1048576]);
  assert.ok(progress.every(event => event.businessProgress === false && event.sequence === started.sequence && event.generation === started.generation));
  assert.deepEqual(setup.bindings[0].returns, progress.map(event => event.uploadAllowanceMs));
  assert.ok(progress.every((event, index) => event.uploadAllowanceMs === Math.ceil(event.remainingBytes / (1024 * 1024) * 120)
    && event.firstProgressDeadlineAt > (progress[index - 1] ?? started).firstProgressDeadlineAt));
  assert.equal(setup.events.filter(event => event.reason === "FIRST_PROGRESS_TIMEOUT" || event.code === "FIRST_PROGRESS_TIMEOUT").length, 0);
  assert.equal(result.events.filter(event => event.type === "response.completed").length, 1);
  assert.ok(result.events.some(event => event.delta === "UPLOAD_PROGRESS_OK"));
  assert.equal(setup.recovery.some(event => ["waiting", "resumed"].includes(event.phase)), false);
  assert.equal(setup.proxy.status().operationLedger.protectedOperations, 0);
  assert.equal(setup.transport.status().unknownOperations, 0);
  const last = setup.bindings[0].uploads.at(-1);
  const count = progress.length;
  assert.equal(setup.bindings[0].options.onUploadProgress({ ...last, acknowledgedBytes: last.acknowledgedBytes + 1 }), undefined);
  setup.connections[0].socket.pong(setup.connections[0].pings.at(-1));
  await until(() => setup.clients[0].pongs.length > count, "late Pong after completion");
  assert.equal(setup.bindings[0].uploads.length, count);
  assert.equal(setup.events.filter(event => event.type === "incremental_packet_upload_progress").length, count);
  context.diagnostic(`initial budget=${started.firstProgressDeadlineAt - started.observedAt}ms; actual upload=${setup.packets[0].observedAt - started.observedAt}ms; matched progress=${progress.length}; FIRST_PROGRESS_TIMEOUT=0`);
});

test("wrong packet generation byte reports and Pong noise cannot extend the core upload budget", { timeout: 5000 }, async context => {
  const setup = await fixture(context, { onPing(connection, token) {
    if (connection.index > 1 || connection.pings.length === 1) connection.socket.pong(token);
  } });
  const pending = setup.request();
  await until(() => setup.bindings[0]?.uploads.length === 1 && setup.connections[0]?.pings.length === 2, "second checkpoint after one matched acknowledgement");
  const binding = setup.bindings[0];
  const previous = binding.uploads[0];
  const variants = [
    { ...previous, sequence: previous.sequence + 1, acknowledgedBytes: previous.acknowledgedBytes + 1 },
    { ...previous, generation: previous.generation - 1, acknowledgedBytes: previous.acknowledgedBytes + 1 },
    { ...previous, wireBytes: previous.wireBytes + 1, acknowledgedBytes: previous.acknowledgedBytes + 1 },
    { ...previous },
    { ...previous, acknowledgedBytes: previous.acknowledgedBytes - 1 },
    { ...previous, acknowledgedBytes: previous.acknowledgedBytes + 0.5 },
    { ...previous, acknowledgedBytes: previous.wireBytes + 1 },
  ];
  assert.ok(variants.every(progress => binding.options.onUploadProgress(progress) === undefined));
  const acknowledged = setup.events.find(event => event.type === "incremental_packet_upload_progress");
  const wrong = Buffer.from(setup.connections[0].pings[1]);
  wrong[0] ^= 0xff;
  let pulses = 0;
  const pulse = () => {
    if (setup.connections[0].socket.readyState !== WebSocket.OPEN) return;
    pulses += 1;
    for (const progress of variants) binding.options.onUploadProgress(progress);
    setup.connections[0].socket.pong(wrong);
    setup.connections[0].socket.pong(setup.connections[0].pings[0]);
    setup.connections[0].socket.ping("ordinary-heartbeat-not-model-progress");
    setup.later(pulse, 20);
  };
  pulse();
  const result = await pending.done;
  const timeout = setup.events.find(event => event.type === "attempt_progress_timeout" && event.reason === "FIRST_PROGRESS_TIMEOUT");
  assert.ok(timeout, "invalid reports must leave the real first-progress timeout active");
  assert.ok(timeout.observedAt >= acknowledged.firstProgressDeadlineAt - 10);
  assert.ok(timeout.observedAt < acknowledged.firstProgressDeadlineAt + 600);
  assert.ok(pulses >= 2);
  assert.equal(binding.uploads.length, 1, "only the matching token may cross transport -> core");
  assert.equal(setup.events.filter(event => event.type === "incremental_packet_upload_progress" && event.generation === previous.generation).length, 1);
  assert.ok(setup.clients[0].pongs.some(token => token.equals(wrong)));
  assert.ok(setup.connections[0].pongs.length > 0);
  assert.equal(setup.connections.length, 2);
  assert.equal(setup.httpRequests.length, 0);
  assert.equal(result.events.filter(event => event.type === "response.completed").length, 1);
  assert.equal(setup.proxy.status().operationLedger.protectedOperations, 0);
  context.diagnostic(`invalid progress: 7 rejected shapes; ${pulses} noise batches; FIRST_PROGRESS_TIMEOUT at original refreshed deadline; second WS completed`);
});

test("cancelling during an upload checkpoint stops progress callbacks and all deadline updates", { timeout: 5000 }, async context => {
  const setup = await fixture(context, { onPing(connection, token) {
    if (connection.pings.length === 1) connection.socket.pong(token);
  } });
  const controller = new AbortController();
  const pending = setup.request({ signal: controller.signal });
  await until(() => setup.bindings[0]?.uploads.length === 1 && setup.connections[0]?.pings.length === 2, "checkpoint before cancellation");
  const binding = setup.bindings[0];
  const last = binding.uploads[0];
  controller.abort();
  await assert.rejects(pending.done, error => error.code === "ABORT_ERR");
  await until(() => setup.proxy.status().activeRequests === 0 && setup.transport.status().active === 0, "cancelled core and transport release");
  const before = setup.events.filter(event => event.type === "incremental_packet_upload_progress").length;
  assert.equal(binding.options.onUploadProgress({ ...last, acknowledgedBytes: last.acknowledgedBytes + 1 }), undefined);
  setup.clients[0].socket.emit("pong", setup.connections[0].pings[1]);
  await delay(20);
  assert.equal(setup.events.filter(event => event.type === "incremental_packet_upload_progress").length, before);
  assert.equal(binding.uploads.length, 1);
  assert.equal(setup.clients[0].socket.listenerCount("pong"), 0);
  assert.equal(setup.connections.length, 1);
  assert.equal(setup.httpRequests.length, 0);
  assert.equal(setup.proxy.status().operationLedger.protectedOperations, 0);
  const metadata = setup.transport.getOperation(binding.options.operationId);
  assert.equal(metadata.state, "cancelled");
  assert.equal(metadata.acceptance, "unknown");
  assert.equal(metadata.canRetry, false);
  context.diagnostic("cancel: upload callbacks=1 before/after cancellation; late callback and Pong ignored; no retry or HTTP; UNKNOWN retained");
});

test("upload acknowledgements after real output cannot refresh its idle deadline or permit replay", { timeout: 5000 }, async context => {
  const setup = await fixture(context, { acknowledgementDelayMs: 0, transportOptions: { responseTimeoutMs: 2000 }, onPacket(entry) {
    entry.socket.send(JSON.stringify({ type: "response.created", response: { id: "output-before-late-pong", status: "in_progress" } }));
    entry.socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "REAL_OUTPUT_BEFORE_LATE_PONG" }));
  } });
  const pending = setup.request();
  await until(() => setup.events.some(event => event.type === "first_progress_observed"), "real model output before late upload reports");
  const binding = setup.bindings[0];
  const previous = binding.uploads.at(-1);
  const progressCount = setup.events.filter(event => event.type === "incremental_packet_upload_progress").length;
  const output = setup.events.find(event => event.type === "first_progress_observed");
  let pulses = 0;
  const pulse = () => {
    if (setup.proxy.status().activeRequests === 0) return;
    pulses += 1;
    assert.equal(binding.options.onUploadProgress({ ...previous, acknowledgedBytes: previous.acknowledgedBytes + pulses }), undefined);
    assert.equal(binding.options.onPacketSending({ ...binding.packet, sequence: binding.packet.sequence + pulses }), 0);
    if (setup.connections[0].socket.readyState === WebSocket.OPEN) setup.connections[0].socket.pong(setup.connections[0].pings.at(-1));
    setup.later(pulse, 15);
  };
  pulse();
  const result = await pending.done;
  const timeout = setup.events.find(event => event.type === "attempt_progress_timeout" && event.reason === "PROGRESS_IDLE_TIMEOUT");
  assert.ok(timeout, "late upload reports must leave the model-output idle timeout active");
  assert.ok(timeout.observedAt >= output.observedAt + 120);
  assert.ok(timeout.observedAt < output.observedAt + 700);
  assert.ok(pulses >= 3);
  assert.equal(setup.events.filter(event => event.type === "incremental_packet_upload_progress").length, progressCount);
  assert.equal(setup.events.filter(event => event.type === "incremental_packet_upload_started").length, 1);
  assert.equal(binding.uploads.length, progressCount);
  assert.ok(setup.clients[0].pongs.length > progressCount, "late Pong must actually arrive over the loopback network");
  assert.match(result.text, /REAL_OUTPUT_BEFORE_LATE_PONG/u);
  assert.equal(result.events.some(event => event.type === "response.completed"), false);
  assert.equal(setup.connections.length, 1);
  assert.equal(setup.packets.length, 1);
  assert.equal(setup.httpRequests.length, 0);
  assert.equal(setup.proxy.status().counters.syntheticCompletions, 0);
  assert.equal(setup.proxy.status().operationLedger.protectedOperations, 0);
  context.diagnostic(JSON.stringify({ requestId: timeout.requestId, responseId: "output-before-late-pong", reason: timeout.reason,
    sawContent: timeout.sawContent, lastProgressType: timeout.lastProgressType, pulses,
    observedIdleMs: timeout.observedAt - output.observedAt, actualProgressIdleMs: timeout.msSinceLastProgress,
    uploadProgressBefore: progressCount, uploadProgressAfter: binding.uploads.length,
    receivedPongs: setup.clients[0].pongs.length, websocketAttempts: setup.packets.length, httpAttempts: setup.httpRequests.length }));
});
