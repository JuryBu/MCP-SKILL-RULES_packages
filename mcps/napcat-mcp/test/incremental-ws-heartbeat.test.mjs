import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { connect, createServer as createTcpServer } from "node:net";
import { Duplex } from "node:stream";
import { setImmediate as yieldIO } from "node:timers/promises";
import test from "node:test";
import { createIncrementalResponsesTransport } from "../src/incremental-responses-transport.mjs";
import { classifyModelFailure } from "../src/model-failure-policy.mjs";

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws");
const fragmentBytes = 64 * 1024;
const payloadBytes = 13 * 1024 * 1024;
const bytesPerSecond = 4 * 1024 * 1024;
const heartbeatTimeoutMs = 600;
const digest = value => createHash("sha256").update(value).digest("hex");
const jsonWire = Buffer.from(JSON.stringify({ type: "response.create", input: "猫🌸".repeat(100) + "x".repeat(payloadBytes) }));

function assertBytesEqual(received, expected) {
  assert.ok(received.equals(expected), JSON.stringify({ receivedBytes: received.length,
    expectedBytes: expected.length, receivedHash: digest(received), expectedHash: digest(expected),
    receivedPrefix: received.subarray(0, 200).toString(), expectedPrefix: expected.subarray(0, 200).toString() }));
}

function observeFrames(chunk, state) {
  let offset = 0;
  while (offset < chunk.length) {
    if (!state.frame) {
      state.header = Buffer.concat([state.header, chunk.subarray(offset, offset + 1)]);
      offset += 1;
      if (state.header.length < 2) continue;
      const shortLength = state.header[1] & 127;
      const headerBytes = 2 + (shortLength === 126 ? 2 : shortLength === 127 ? 8 : 0)
        + (state.header[1] & 128 ? 4 : 0);
      if (state.header.length < headerBytes) continue;
      const length = shortLength === 126 ? state.header.readUInt16BE(2)
        : shortLength === 127 ? Number(state.header.readBigUInt64BE(2)) : shortLength;
      state.frame = { opcode: state.header[0] & 15, fin: Boolean(state.header[0] & 128),
        masked: Boolean(state.header[1] & 128), length, remaining: length };
      state.startedFrames.push({ ...state.frame });
      state.header = Buffer.alloc(0);
    }
    const consumed = Math.min(state.frame.remaining, chunk.length - offset);
    state.frame.remaining -= consumed;
    offset += consumed;
    if (state.frame.opcode <= 2) state.dataBytes += consumed;
    if (!state.frame.remaining) {
      state.frames.push(state.frame);
      state.frame = null;
    }
  }
}

function limitedTcpConnection(options, state) {
  assert.equal(options.host, "127.0.0.1");
  const raw = connect({ host: options.host, port: options.port, highWaterMark: 16 * 1024 });
  state.raw = raw;
  let timer;
  const stream = new Duplex({
    readableHighWaterMark: 16 * 1024,
    writableHighWaterMark: 16 * 1024,
    read() { raw.resume(); },
    write(chunk, _encoding, callback) {
      if (!state.pacing) return raw.write(chunk, callback);
      state.maxWritableBytes = Math.max(state.maxWritableBytes, stream.writableLength);
      let offset = 0;
      const began = performance.now();
      const forward = () => {
        if (stream.destroyed) return;
        const end = Math.min(offset + 16 * 1024, chunk.length);
        raw.write(chunk.subarray(offset, end), error => {
          if (error || stream.destroyed) return callback(error);
          offset = end;
          if (offset === chunk.length) return callback();
          timer = setTimeout(forward, Math.max(1, offset / bytesPerSecond * 1000 - (performance.now() - began)));
        });
      };
      forward();
    },
    final(callback) { raw.end(callback); },
    destroy(error, callback) {
      clearTimeout(timer);
      raw.destroy();
      callback(error);
    },
  });
  Object.defineProperty(stream, "connecting", { get: () => raw.connecting });
  raw.on("connect", () => stream.emit("connect"));
  raw.on("data", chunk => { if (!stream.push(chunk)) raw.pause(); });
  raw.on("end", () => stream.push(null));
  raw.on("close", () => stream.destroy());
  raw.on("error", error => stream.destroy(error));
  stream.on("error", () => {});
  state.stream = stream;
  return stream;
}

async function heartbeatFixture(context, { bufferedProxy = false, completeResponses = false, pauseUplinkMs = 0 } = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024 });
  await once(server, "listening");
  const peers = [];
  const clients = [];
  const links = [];
  const timers = new Set();
  let pauseFaultAvailable = pauseUplinkMs > 0;
  let proxy;
  if (bufferedProxy) {
    proxy = createTcpServer(downstream => {
      const link = links.find(entry => !entry.downstream);
      link.downstream = downstream;
      const upstream = connect({ host: "127.0.0.1", port: server.address().port });
      link.upstream = upstream;
      const queue = [];
      let queuedBytes = 0;
      let pumping = false;
      let queueOffset = 0;
      const forward = () => {
        if (upstream.destroyed || downstream.destroyed) return;
        if (link.pauseUntil > performance.now()) {
          timers.add(setTimeout(forward, link.pauseUntil - performance.now()));
          return;
        }
        if (link.pauseUntil) {
          link.resumedAfterMs = performance.now() - link.pausedAt;
          link.pauseUntil = 0;
        }
        const chunk = queue[0];
        if (!chunk) { pumping = false; return; }
        const end = Math.min(queueOffset + 64 * 1024, chunk.length);
        const part = chunk.subarray(queueOffset, end);
        upstream.write(part);
        queuedBytes -= part.length;
        link.queuedBytes = queuedBytes;
        link.forwardedBytes += part.length;
        queueOffset = end;
        if (end === chunk.length) { queue.shift(); queueOffset = 0; }
        timers.add(setTimeout(forward, Math.max(1, part.length / bytesPerSecond * 1000)));
      };
      downstream.setNoDelay(true);
      upstream.setNoDelay(true);
      downstream.on("data", chunk => {
        if (!link.pacing) return upstream.write(chunk);
        queue.push(chunk);
        queuedBytes += chunk.length;
        link.queuedBytes = queuedBytes;
        link.cachedBytes += chunk.length;
        link.maxQueuedBytes = Math.max(link.maxQueuedBytes, queuedBytes);
        if (!pumping) {
          pumping = true;
          timers.add(setTimeout(forward, 100));
        }
      });
      upstream.on("data", chunk => {
        if (!downstream.write(chunk)) upstream.pause();
      });
      downstream.on("drain", () => upstream.resume());
      for (const socket of [downstream, upstream]) socket.on("error", () => {});
      downstream.on("close", () => upstream.destroy());
      upstream.on("close", () => downstream.destroy());
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
  }
  server.on("connection", socket => {
    const state = { socket, header: Buffer.alloc(0), frame: null, frames: [], startedFrames: [],
      dataBytes: 0, pings: 0, pongs: 0, clientReadPings: 0, pongBeforeMessage: 0,
      maxPongRttMs: 0, messages: [], timedOut: false };
    state.link = links.find(link => (link.upstream?.localPort ?? link.raw?.localPort) === socket._socket.remotePort);
    assert.ok(state.link);
    peers.push(state);
    let deadline;
    let pending;
    let pingStartedAt;
    const ping = () => {
      if (socket.readyState !== WebSocket.OPEN || pending || state.messages.length) return;
      pending = `heartbeat-${++state.pings}`;
      pingStartedAt = performance.now();
      if (pauseFaultAvailable) {
        pauseFaultAvailable = false;
        state.link.pausedAt = performance.now();
        state.link.pauseUntil = state.link.pausedAt + pauseUplinkMs;
        state.link.pauseInjectedMs = pauseUplinkMs;
      }
      if (state.pings === 1) state.firstPing = { cachedBytes: state.link.cachedBytes,
        queuedBytes: state.link.queuedBytes, sendCallbacks: state.link.sendCallbacks, dataBytes: state.dataBytes };
      socket.ping(pending);
      deadline = setTimeout(() => {
        state.timedOut = true;
        state.sentCloseCode = 1011;
        socket.close(1011, "keepalive ping timeout");
        timers.add(setTimeout(() => socket.terminate(), 80));
      }, heartbeatTimeoutMs);
      timers.add(deadline);
    };
    socket.on("error", () => {});
    socket.on("ping", value => { if (/^read-through-\d+$/.test(value.toString())) state.clientReadPings += 1; });
    socket.on("pong", value => {
      if (value.toString() !== pending) return;
      clearTimeout(deadline);
      pending = null;
      state.pongs += 1;
      state.maxPongRttMs = Math.max(state.maxPongRttMs, performance.now() - pingStartedAt);
      if (!state.messages.length) state.pongBeforeMessage += 1;
      timers.add(setTimeout(ping, 80));
    });
    socket.on("message", (raw, binary) => {
      clearTimeout(deadline);
      state.messages.push({ raw: Buffer.from(raw), binary });
      if (completeResponses) {
        socket.send(JSON.stringify({ type: "response.created", response: { id: `response_${peers.indexOf(state)}`, status: "in_progress" } }));
        socket.send(JSON.stringify({ type: "response.completed", response: { id: `response_${peers.indexOf(state)}`, status: "completed", output: [] } }));
      }
    });
    socket._socket.on("data", chunk => {
      observeFrames(chunk, state);
      if (!state.pings && state.dataBytes >= fragmentBytes * 2) ping();
    });
    socket.on("close", () => clearTimeout(deadline));
  });
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    const ports = [server.address()?.port, proxy?.address()?.port].filter(Boolean);
    for (const timer of timers) clearTimeout(timer);
    for (const client of clients) client.terminate();
    for (const peer of peers) peer.socket.terminate();
    for (const link of links) {
      link.stream?.destroy();
      link.raw?.destroy();
      link.downstream?.destroy();
      link.upstream?.destroy();
    }
    await new Promise(resolve => server.close(resolve));
    if (proxy) await new Promise(resolve => proxy.close(resolve));
    assert.equal(server.address(), null);
    if (proxy) assert.equal(proxy.address(), null);
    assert.ok(links.every(link => link.raw.destroyed && (!link.stream || link.stream.destroyed)
      && (!link.downstream || link.downstream.destroyed) && (!link.upstream || link.upstream.destroyed)));
    context.diagnostic(`cleanup: ports=${ports.join(",")}; ${proxy ? 2 : 1} ephemeral listeners closed; ${clients.length} ws clients and ${links.length} TCP links destroyed`);
  };
  context.after(cleanup);
  const createClient = (url, socketOptions = {}) => {
    const link = { pacing: false, maxWritableBytes: 0, cachedBytes: 0, forwardedBytes: 0,
      queuedBytes: 0, maxQueuedBytes: 0, sendCallbacks: 0, readThroughPongs: 0 };
    links.push(link);
    const client = new WebSocket(url, {
      ...socketOptions, perMessageDeflate: false,
      createConnection: options => {
        if (!bufferedProxy) return limitedTcpConnection(options, link);
        link.raw = connect({ host: "127.0.0.1", port: proxy.address().port });
        link.raw.setNoDelay(true);
        return link.raw;
      },
    });
    const send = client.send.bind(client);
    client.send = (wire, options, callback) => {
      const done = typeof options === "function" ? options : callback;
      const observed = error => { link.sendCallbacks += 1; done?.(error); };
      return typeof options === "function" ? send(wire, observed) : send(wire, options, observed);
    };
    clients.push(client);
    link.client = client;
    client.on("error", () => {});
    client.on("pong", value => { if (/^read-through-\d+$/.test(value.toString())) link.readThroughPongs += 1; });
    link.basePongListeners = client.listenerCount("pong");
    client.on("close", (code, reason) => {
      link.closeCode = code;
      link.closeReason = reason.toString();
    });
    client.on("open", () => { link.pacing = true; });
    return { client, link };
  };
  const url = `ws://127.0.0.1:${server.address().port}/responses`;
  const connectClient = async () => {
    const state = createClient(url);
    const { client } = state;
    await once(client, "open");
    return { ...state, peer: peers.at(-1) };
  };
  return { connectClient, createClient, peers, links, url, cleanup };
}

function requestPayload() {
  return { model: "fixture-model", instructions: "Loopback fixture", tools: [],
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "猫🌸".repeat(100) + "x".repeat(payloadBytes) }] }] };
}

function expectedWire(payload) {
  return Buffer.from(JSON.stringify({ model: payload.model, instructions: payload.instructions,
    tools: payload.tools, store: false, type: "response.create", input: payload.input }));
}

function requestThroughTransport(transport, fixture, operationId, payload, settings = {}) {
  const client = transport.createRequestClient({ sessionKey: `session-${operationId}`, operationId,
    payload, url: fixture.url, ...settings });
  return new Promise(resolve => {
    const request = client.request(fixture.url);
    request.on("response", response => {
      response.resume();
      response.on("end", () => resolve({ code: null }));
      response.on("error", error => resolve({ code: error.code, error }));
    });
    request.on("error", error => resolve({ code: error.code, error }));
    request.end();
  });
}

function realTransport(fixture) {
  return createIncrementalResponsesTransport({ maxMessageBytes: 16 * 1024 * 1024,
    maxSessionBytes: 64 * 1024 * 1024, responseTimeoutMs: 15000,
    createWebSocket: (url, options) => fixture.createClient(url, options).client });
}

async function sendFragments(socket, wire, remoteBarrierBytes = 0) {
  for (let offset = 0; offset < wire.length; offset += fragmentBytes) {
    const end = Math.min(offset + fragmentBytes, wire.length);
    await new Promise((resolve, reject) => socket.send(wire.subarray(offset, end),
      { binary: false, compress: false, fin: end === wire.length }, error => error ? reject(error) : resolve()));
    await yieldIO();
    if (remoteBarrierBytes && end < wire.length && end % remoteBarrierBytes === 0) {
      const nonce = Buffer.from(`read-through-${end}`);
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer);
          socket.off("pong", onPong);
          socket.off("close", onClose);
          error ? reject(error) : resolve();
        };
        const onPong = value => { if (value.equals(nonce)) finish(); };
        const onClose = () => finish(new Error("connection closed while awaiting remote read-through Pong"));
        const timer = setTimeout(() => finish(new Error("remote read-through Pong timed out")), 3000);
        socket.on("pong", onPong);
        socket.once("close", onClose);
        socket.ping(nonce, error => { if (error) finish(error); });
      });
    }
  }
}

function assertDelivered(state, expected) {
  assert.equal(state.peer.timedOut, false);
  assert.equal(state.peer.messages.length, 1);
  assert.equal(state.peer.messages[0].binary, false);
  assertBytesEqual(state.peer.messages[0].raw, expected);
  assert.equal(digest(state.peer.messages[0].raw), digest(expected));
  assert.ok(state.peer.pongBeforeMessage > 0);
  const frames = state.peer.frames;
  const dataFrames = frames.filter(frame => frame.opcode <= 2);
  assert.ok(dataFrames.length > 1);
  assert.equal(dataFrames[0].opcode, 1);
  assert.equal(dataFrames[0].fin, false);
  assert.ok(dataFrames.slice(1).every(frame => frame.opcode === 0));
  assert.ok(dataFrames.every(frame => frame.masked && frame.length <= fragmentBytes));
  assert.ok(dataFrames.slice(0, -1).every(frame => !frame.fin));
  assert.equal(dataFrames.at(-1).fin, true);
  const pongIndex = frames.findIndex(frame => frame.opcode === 10);
  assert.ok(pongIndex > 0 && pongIndex < frames.lastIndexOf(dataFrames.at(-1)));
  assert.ok(state.link.maxWritableBytes >= fragmentBytes || state.link.maxQueuedBytes >= fragmentBytes);
  return { wireBytes: expected.length, sha256: digest(expected), dataFrames: dataFrames.length,
    pongs: state.peer.pongs, maxWritableBytes: state.link.maxWritableBytes };
}

test("legacy single JSON frame deterministically blocks automatic Pong on a paced real TCP stream", { timeout: 15000 }, async context => {
  const fixture = await heartbeatFixture(context);
  const state = await fixture.connectClient();
  const closed = once(state.client, "close");
  state.client.send(jsonWire, { binary: false, compress: false }, () => {});
  const [code, reason] = await closed;
  assert.equal(code, 1011);
  assert.equal(reason.toString(), "keepalive ping timeout");
  assert.equal(state.peer.timedOut, true);
  assert.equal(state.peer.pongs, 0);
  assert.equal(state.peer.messages.length, 0);
  assert.equal(state.peer.startedFrames[0].opcode, 1);
  assert.equal(state.peer.startedFrames[0].fin, true);
  assert.equal(state.peer.startedFrames[0].length, jsonWire.length);
  assert.ok(state.peer.dataBytes < jsonWire.length);
  assert.ok(state.link.maxWritableBytes >= jsonWire.length);
  context.diagnostic(JSON.stringify({ mode: "legacy", closeCode: code, reason: reason.toString(),
    pongs: state.peer.pongs, receivedDataBytes: state.peer.dataBytes, wireBytes: jsonWire.length,
    bytesPerSecond, heartbeatTimeoutMs, maxWritableBytes: state.link.maxWritableBytes }));
  await fixture.cleanup();
});

test("transport sendNext survives two concurrent fast local TCP caches followed by slow remote readers", { timeout: 30000 }, async context => {
  const fixture = await heartbeatFixture(context, { bufferedProxy: true, completeResponses: true });
  const transport = createIncrementalResponsesTransport({
    maxMessageBytes: 16 * 1024 * 1024, maxSessionBytes: 64 * 1024 * 1024,
    responseTimeoutMs: 15000, createWebSocket: (url, options) => fixture.createClient(url, options).client,
  });
  context.after(() => transport.close());
  const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "猫🌸".repeat(100) + "x".repeat(payloadBytes) }] }];
  const payload = { model: "fixture-model", instructions: "Loopback fixture", tools: [], input };
  const outcomes = await Promise.all([0, 1].map(index => {
    const client = transport.createRequestClient({ sessionKey: `buffered-proxy-${index}`,
      operationId: `buffered-proxy-${index}`, payload, url: fixture.url });
    return new Promise(resolve => {
      const request = client.request(fixture.url);
      request.on("response", response => {
        response.resume();
        response.on("end", () => resolve({ code: null }));
        response.on("error", error => resolve({ code: error.code }));
      });
      request.on("error", error => resolve({ code: error.code }));
      request.end();
    });
  }));
  await yieldIO();
  for (const [index, peer] of fixture.peers.entries()) {
    const link = peer.link;
    context.diagnostic(JSON.stringify({ mode: "transport-buffered-proxy", connection: index + 1, outcome: outcomes[index],
      timedOut: peer.timedOut, messages: peer.messages.length, pongs: peer.pongs,
      firstPing: peer.firstPing, maxQueuedBytes: link.maxQueuedBytes, sendCallbacks: link.sendCallbacks,
      dataFrames: peer.frames.filter(frame => frame.opcode <= 2).length,
      serverCloseCode: peer.sentCloseCode, clientCloseCode: link.closeCode, clientCloseReason: link.closeReason }));
  }
  transport.close();
  await fixture.cleanup();
  assert.equal(transport.status().retainedBytes, 0);
  assert.equal(transport.status().active, 0);
  assert.equal(transport.status().connections, 0);
  assert.equal(fixture.peers.length, 2);
  const expected = Buffer.from(JSON.stringify({ model: payload.model, instructions: payload.instructions,
    tools: payload.tools, store: false, type: "response.create", input }));
  for (const [index, peer] of fixture.peers.entries()) {
    assert.equal(peer.timedOut, false, "server keepalive expired while the local TCP cache still held queued continuation frames");
    assert.equal(outcomes[index].code, null);
    context.diagnostic(JSON.stringify({ mode: "transport-delivered", connection: index + 1,
      ...assertDelivered({ peer, link: peer.link }, expected) }));
  }
});

test("legacy whole-frame control also times out behind the same fast-cache slow-remote proxy", { timeout: 15000 }, async context => {
  const fixture = await heartbeatFixture(context, { bufferedProxy: true });
  const state = await fixture.connectClient();
  const closed = once(state.client, "close");
  state.client.send(jsonWire, { binary: false, compress: false }, () => {});
  const [code, reason] = await closed;
  context.diagnostic(JSON.stringify({ mode: "legacy-buffered-proxy", closeCode: code,
    reason: reason.toString(), messages: state.peer.messages.length, pongs: state.peer.pongs,
    firstPing: state.peer.firstPing, maxQueuedBytes: state.link.maxQueuedBytes }));
  assert.equal(code, 1011);
  assert.equal(reason.toString(), "keepalive ping timeout");
  assert.equal(state.peer.timedOut, true);
  assert.equal(state.peer.pongs, 0);
  assert.equal(state.peer.messages.length, 0);
  assert.equal(state.peer.startedFrames[0].length, jsonWire.length);
  assert.ok(state.peer.firstPing.queuedBytes > 8 * 1024 * 1024);
  assert.equal(state.peer.firstPing.sendCallbacks, 1);
  await fixture.cleanup();
});

test("two concurrent 256 KiB remote read-through Ping barriers preserve JSON and server keepalive behind a fast cache", { timeout: 30000 }, async context => {
  const fixture = await heartbeatFixture(context, { bufferedProxy: true });
  const states = [await fixture.connectClient(), await fixture.connectClient()];
  await Promise.all(states.map(async state => {
    const received = once(state.peer.socket, "message");
    await Promise.all([sendFragments(state.client, jsonWire, 256 * 1024), received]);
    await yieldIO();
    context.diagnostic(JSON.stringify({ mode: "buffered-proxy-remote-barrier-reference",
      ...assertDelivered(state, jsonWire), firstPing: state.peer.firstPing, maxQueuedBytes: state.link.maxQueuedBytes,
      clientReadPingsAtServer: state.peer.clientReadPings, readThroughPongsAtClient: state.link.readThroughPongs }));
    assert.ok(state.link.maxQueuedBytes < 512 * 1024);
    const expectedBarriers = Math.floor((jsonWire.length - 1) / (256 * 1024));
    assert.equal(state.peer.clientReadPings, expectedBarriers);
    assert.equal(state.link.readThroughPongs, expectedBarriers);
  }));
  await fixture.cleanup();
});

test("two concurrent real ws 64 KiB continuation uploads interleave Pong and preserve one JSON message byte for byte", { timeout: 20000 }, async context => {
  const fixture = await heartbeatFixture(context);
  const states = [await fixture.connectClient(), await fixture.connectClient()];
  await Promise.all(states.map(async state => {
    const received = once(state.peer.socket, "message");
    await Promise.all([sendFragments(state.client, jsonWire), received]);
    await yieldIO();
    context.diagnostic(JSON.stringify({ mode: "fragmented-reference", ...assertDelivered(state, jsonWire), bytesPerSecond, heartbeatTimeoutMs }));
  }));
  await fixture.cleanup();
});

test("real transport survives a 200 ms TCP forwarding outage and receives server Pong before its deadline", { timeout: 20000 }, async context => {
  const fixture = await heartbeatFixture(context, { bufferedProxy: true, completeResponses: true, pauseUplinkMs: 200 });
  const transport = realTransport(fixture);
  context.after(() => transport.close());
  const payload = requestPayload();
  const result = await requestThroughTransport(transport, fixture, "short-outage", payload);
  await yieldIO();
  const peer = fixture.peers[0];
  const link = peer.link;
  context.diagnostic(JSON.stringify({ mode: "real-transport-short-outage", code: result.code,
    pauseInjectedMs: link.pauseInjectedMs, resumedAfterMs: link.resumedAfterMs,
    maxServerPongRttMs: peer.maxPongRttMs, ...assertDelivered({ peer, link }, expectedWire(payload)) }));
  assert.equal(result.code, null);
  assert.equal(link.pauseInjectedMs, 200);
  assert.ok(link.resumedAfterMs >= 195);
  assert.ok(peer.maxPongRttMs >= 195 && peer.maxPongRttMs < heartbeatTimeoutMs);
  assert.equal(link.client.listenerCount("pong"), link.basePongListeners);
  transport.close();
  await fixture.cleanup();
  assert.equal(transport.status().retainedBytes, 0);
});

test("real TCP outage beyond keepalive retains UNKNOWN and follows the existing explicit no-output recovery", { timeout: 20000 }, async context => {
  const fixture = await heartbeatFixture(context, { bufferedProxy: true, completeResponses: true, pauseUplinkMs: 1200 });
  const transport = realTransport(fixture);
  context.after(() => transport.close());
  const payload = requestPayload();
  const first = await requestThroughTransport(transport, fixture, "long-outage", payload);
  const failed = transport.getOperation("long-outage");
  assert.equal(first.code, "WS_CONNECTION_CLOSED");
  assert.equal(first.error.closeCode, 1011);
  assert.equal(first.error.requestAccepted, "unknown");
  assert.equal(first.error.requestTransmissionState, "generation_sent");
  assert.equal(failed.requiresReconciliation, true);
  assert.equal(failed.canRetry, false);
  assert.equal(fixture.peers[0].messages.length, 0);
  assert.equal(fixture.links[0].client.listenerCount("pong"), 0);
  const classification = classifyModelFailure({ source: "transport", code: first.code,
    requestAccepted: first.error.requestAccepted, requestTransmissionState: first.error.requestTransmissionState,
    wsCloseCode: first.error.closeCode, progressObserved: false });
  assert.equal(classification.category, "acceptance_unknown");
  assert.equal(classification.retryable, true);
  const duplicate = await requestThroughTransport(transport, fixture, "long-outage", payload);
  assert.equal(duplicate.code, "duplicate_operation");
  assert.equal(fixture.peers.length, 1);
  const recovered = await requestThroughTransport(transport, fixture, "long-outage", payload, { retryWithoutOutput: true });
  await yieldIO();
  assert.equal(recovered.code, null);
  assert.equal(fixture.peers.length, 2);
  const peer = fixture.peers[1];
  context.diagnostic(JSON.stringify({ mode: "real-transport-long-outage-recovery",
    firstCode: first.code, firstCloseCode: first.error.closeCode, acceptance: failed.acceptance,
    requiresReconciliation: failed.requiresReconciliation, canRetry: failed.canRetry,
    classification, duplicateCode: duplicate.code, recoveredCode: recovered.code,
    ...assertDelivered({ peer, link: peer.link }, expectedWire(payload)) }));
  assert.equal(fixture.peers.reduce((total, entry) => total + entry.messages.length, 0), 1);
  assert.equal(transport.getOperation("long-outage").state, "completed");
  assert.equal(peer.link.client.listenerCount("pong"), peer.link.basePongListeners);
  transport.close();
  await fixture.cleanup();
  assert.equal(transport.status().retainedBytes, 0);
});
