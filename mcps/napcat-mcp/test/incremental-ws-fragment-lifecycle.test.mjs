import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { createIncrementalResponsesTransport } from "../src/incremental-responses-transport.mjs";

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws");
const fragmentBytes = 64 * 1024;
const packetBytes = 16 * 1024 * 1024;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const nextIo = () => new Promise(resolve => setImmediate(resolve));
const message = text => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const body = input => ({ model: "fixture-model", instructions: "Fragment lifecycle loopback", tools: [], input });
const largeBody = label => body([message(`${label}: 汉字🙂e\u0301\\\"\n`.repeat(24000))]);

function imagePng(seed) {
  const chunk = (name, data) => {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length, 0);
    result.write(name, 4, 4, "ascii");
    data.copy(result, 8);
    let checksum = 0xffffffff;
    for (const value of result.subarray(4, data.length + 8)) {
      checksum ^= value;
      for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
    }
    result.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, data.length + 8);
    return result;
  };
  const width = 192;
  const height = 128;
  const rowBytes = width * 3 + 1;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width * 3; column += 1) pixels[row * rowBytes + column + 1] = (column * 13 + row * 31 + seed) & 0xff;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels, { level: 0 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function waitFor(predicate, description, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
    await delay(5);
  }
}

function observeWire(connection, network) {
  let pending = Buffer.alloc(0);
  network.on("data", chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const marker = pending[1] & 0x7f;
      const extended = marker === 127 ? 8 : marker === 126 ? 2 : 0;
      const masked = Boolean(pending[1] & 0x80);
      const headerBytes = 2 + extended + (masked ? 4 : 0);
      if (pending.length < headerBytes) return;
      const bytes = marker === 127 ? Number(pending.readBigUInt64BE(2))
        : marker === 126 ? pending.readUInt16BE(2) : marker;
      if (pending.length < headerBytes + bytes) return;
      connection.frames.push({ opcode: pending[0] & 0x0f, fin: Boolean(pending[0] & 0x80), masked, bytes });
      pending = pending.subarray(headerBytes + bytes);
    }
  });
}

function complete(socket, id) {
  socket.send(JSON.stringify({ type: "response.created", response: { id, status: "in_progress" } }));
  socket.send(JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [] } }));
}

async function fixture(context, { holdConnections = [], autoPong = true } = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: packetBytes, perMessageDeflate: false, autoPong });
  await once(server, "listening");
  const clients = [];
  const connections = [];
  const messages = [];
  const holds = new Set(holdConnections);
  server.on("connection", (socket, request) => {
    const connection = { socket, network: request.socket, frames: [], pings: [], pongs: [], index: connections.length + 1 };
    connections.push(connection);
    observeWire(connection, request.socket);
    socket.on("error", () => {});
    socket.on("ping", data => connection.pings.push(Buffer.from(data)));
    socket.on("pong", data => connection.pongs.push(data.toString("utf8")));
    socket.on("message", (raw, binary) => {
      const entry = { connection: connection.index, raw: Buffer.from(raw), binary, packet: JSON.parse(raw.toString("utf8")) };
      messages.push(entry);
      complete(socket, `resp_${messages.length}`);
    });
  });
  const transport = createIncrementalResponsesTransport({
    maxMessageBytes: packetBytes, maxSessionBytes: 64 * 1024 * 1024, responseTimeoutMs: 4000,
    createWebSocket(url, options) {
      const socket = new WebSocket(url, options);
      const client = { socket, sends: [], pongs: [], index: clients.length + 1 };
      clients.push(client);
      socket.on("pong", data => client.pongs.push(Buffer.from(data)));
      const send = socket.send.bind(socket);
      socket.send = (data, settings, callback) => {
        if (typeof settings === "function") {
          callback = settings;
          settings = undefined;
        }
        const entry = { data: Buffer.from(data), fin: settings?.fin ?? true, written: false, released: false };
        client.sends.push(entry);
        return send(data, settings ?? {}, error => {
          entry.written = true;
          entry.release = lateError => {
            if (entry.released) return;
            entry.released = true;
            callback?.(lateError ?? error);
          };
          if (!holds.has(client.index) || client.sends.length !== 1) entry.release();
        });
      };
      return socket;
    },
  });
  context.after(async () => {
    transport.close();
    for (const client of clients) {
      client.socket.terminate();
      for (const entry of client.sends) entry.release?.();
    }
    for (const connection of connections) connection.socket.terminate();
    await new Promise(resolve => server.close(resolve));
    await nextIo();
    const status = transport.status();
    for (const field of ["sessions", "connections", "active", "queued", "receiving", "retainedBytes"]) assert.equal(status[field], 0, field);
    assert.ok(connections.every(connection => connection.network.destroyed));
    context.diagnostic(`cleanup: closed=${status.closed}, sockets=${connections.length}, active=${status.active}, retainedBytes=${status.retainedBytes}`);
  });
  return { transport, clients, connections, messages, url: `ws://127.0.0.1:${server.address().port}/responses` };
}

function start(state, operationId, payload, { sessionKey = "session-a", signal } = {}) {
  const client = state.transport.createRequestClient({ sessionKey, operationId, payload, url: state.url, headers: { Authorization: "Bearer loopback-fixture" } });
  const request = client.request(state.url, { signal });
  let sse = "";
  let finish;
  const done = new Promise(resolve => { finish = error => resolve({ error, sse }); });
  request.on("response", response => {
    response.setEncoding("utf8");
    response.on("data", chunk => { sse += chunk; });
    response.on("error", finish);
    response.on("end", () => finish());
  });
  request.on("error", finish);
  request.end("The validated payload is supplied through createRequestClient");
  return { request, done };
}

async function firstFragment(state, connectionIndex) {
  await waitFor(() => state.clients[connectionIndex - 1]?.sends[0]?.written, "first native send callback");
  await waitFor(() => state.connections[connectionIndex - 1]?.frames.length, "first frame on the real socket");
  const connection = state.connections[connectionIndex - 1];
  const entry = state.clients[connectionIndex - 1].sends[0];
  assert.equal(entry.fin, false, "upload must still be inside one fragmented application message");
  assert.deepEqual(connection.frames[0], { opcode: 1, fin: false, masked: true, bytes: fragmentBytes });
  assert.equal(state.messages.filter(message => message.connection === connectionIndex).length, 0);
  return entry;
}

async function remoteReadBarrier(state, connectionIndex, checkpoint = 1) {
  await waitFor(() => state.connections[connectionIndex - 1]?.pings.length === checkpoint, "remote-read barrier Ping");
  const connection = state.connections[connectionIndex - 1];
  const client = state.clients[connectionIndex - 1];
  await waitFor(() => connection.frames.filter(frame => frame.opcode === 9).length === checkpoint, "barrier Ping on the real wire");
  assert.equal(client.sends.length, checkpoint * 4, "only 256KiB may pass before its matching remote Pong");
  assert.equal(client.sends.reduce((bytes, entry) => bytes + entry.data.length, 0), checkpoint * 256 * 1024);
  assert.ok(client.sends.every(entry => !entry.fin));
  assert.equal(connection.pings.at(-1).length, 16);
  assert.equal(client.socket.listenerCount("pong"), 2, "one fixture observer and one live acknowledgement listener");
  assert.equal(state.messages.filter(entry => entry.connection === connectionIndex).length, 0);
  return { connection, client, token: connection.pings.at(-1) };
}

function continueBarriers(connection, token) {
  connection.socket.on("ping", data => connection.socket.pong(data));
  connection.socket.pong(token);
}

test("cancelling a partial native WS upload stops its remaining frames and a new request completes", { timeout: 7000 }, async context => {
  const state = await fixture(context, { holdConnections: [1] });
  const controller = new AbortController();
  const pending = start(state, "fragment-cancel", largeBody("cancel"), { signal: controller.signal });
  const held = await firstFragment(state, 1);
  controller.abort();
  const cancelled = await pending.done;
  assert.equal(cancelled.error?.code, "ABORT_ERR");
  assert.equal(cancelled.error.requestAccepted, "unknown");
  const metadata = state.transport.getOperation("fragment-cancel");
  assert.equal(metadata.state, "cancelled");
  assert.equal(metadata.canRetry, false);
  assert.equal(metadata.requiresReconciliation, true);
  const next = await start(state, "fragment-after-cancel", body([message("new request after cancellation")])).done;
  assert.equal(next.error, undefined);
  held.release();
  await nextIo();
  await nextIo();
  assert.equal(state.clients[0].sends.length, 1, "cancelled upload must not schedule another frame");
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].connection, 2);
  assert.equal(state.messages[0].packet.previous_response_id, undefined);
  assert.equal(state.transport.status().unknownOperations, 1);
  context.diagnostic("cancel: one partial 65536-byte frame, no old application JSON, replacement completed, UNKNOWN retained");
});

test("a slow native WS upload leaves independent session B and an interleaved Pong live", { timeout: 7000 }, async context => {
  const state = await fixture(context, { holdConnections: [1] });
  const pending = start(state, "fragment-slow-a", largeBody("slow-a"));
  const held = await firstFragment(state, 1);
  state.connections[0].socket.ping("fragment-upload-heartbeat");
  const independent = await start(state, "fragment-small-b", body([message("small independent request")]), { sessionKey: "session-b" }).done;
  assert.equal(independent.error, undefined);
  await waitFor(() => state.connections[0].pongs.includes("fragment-upload-heartbeat"), "Pong while A is held between frames");
  assert.equal(held.released, false);
  assert.equal(state.clients[0].sends.length, 1);
  assert.equal(state.transport.getOperation("fragment-slow-a").state, "awaiting_response");
  assert.deepEqual(state.messages.map(entry => entry.connection), [2]);
  held.release();
  assert.equal((await pending.done).error, undefined);
  assert.deepEqual(state.messages.map(entry => entry.connection), [2, 1]);
  const wire = state.connections[0].frames;
  const pongIndex = wire.findIndex(frame => frame.opcode === 10);
  const finalIndex = wire.findIndex(frame => frame.fin && frame.opcode === 0);
  assert.ok(pongIndex > 0 && finalIndex > pongIndex, "Pong must pass before the final data continuation");
  context.diagnostic(`concurrency: B completed before A; Pong frame index=${pongIndex}, final continuation index=${finalIndex}`);
});

for (const outcome of ["success", "error"]) test(`a late ${outcome} callback from a replaced WS upload cannot alter its new job`, { timeout: 7000 }, async context => {
  const state = await fixture(context, { holdConnections: [1, 2] });
  const previous = start(state, "fragment-replaced-old", largeBody("old"));
  const oldHeld = await firstFragment(state, 1);
  assert.equal(state.transport.invalidate("session-a", "replace connection during upload"), true);
  assert.equal((await previous.done).error?.code, "session_invalidated");
  const pending = start(state, "fragment-replacement-new", largeBody("new"));
  const newHeld = await firstFragment(state, 2);
  const newMetadata = state.transport.getOperation("fragment-replacement-new");
  const retained = state.transport.status().retainedBytes;
  oldHeld.release(outcome === "error" ? new Error("late old-connection send failure") : undefined);
  await nextIo();
  await nextIo();
  assert.deepEqual(state.transport.getOperation("fragment-replacement-new"), newMetadata);
  assert.equal(state.transport.status().retainedBytes, retained, "old callback must not clear the new packet's byte reservation");
  assert.equal(state.clients[0].sends.length, 1);
  assert.equal(state.clients[1].sends.length, 1);
  assert.equal(newHeld.released, false);
  newHeld.release();
  const result = await pending.done;
  assert.equal(result.error, undefined);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].connection, 2);
  assert.equal(state.messages[0].packet.previous_response_id, undefined);
  assert.equal(state.transport.getOperation("fragment-replaced-old").acceptance, "unknown");
  assert.equal(state.transport.getOperation("fragment-replacement-new").state, "completed");
  context.diagnostic(`replacement: generation ${newMetadata.generation}, stale ${outcome} callback ignored, only replacement JSON completed`);
});

test("native continuation frames preserve one complete UTF8 multi-image JSON and the next message", { timeout: 7000 }, async context => {
  const state = await fixture(context);
  const firstPng = imagePng(9);
  const secondPng = imagePng(37);
  const payload = body([{
    type: "message", role: "user", content: [
      { type: "input_text", text: "汉🙂é\\\"\n".repeat(25000) },
      { type: "input_image", image_url: `data:image/png;base64,${firstPng.toString("base64")}`, detail: "high" },
      { type: "input_text", text: "比較する画像\n🙂".repeat(9000) },
      { type: "input_image", image_url: `data:image/png;base64,${secondPng.toString("base64")}`, detail: "low" },
    ],
  }]);
  assert.equal((await start(state, "fragment-utf8-images", payload).done).error, undefined);
  const entry = state.messages[0];
  const sends = state.clients[0].sends;
  await waitFor(() => state.connections[0].frames.filter(frame => frame.opcode < 8).some(frame => frame.fin), "final native data frame");
  const frames = state.connections[0].frames.filter(frame => frame.opcode < 8);
  const acknowledgementFrames = state.connections[0].frames.filter(frame => frame.opcode === 9);
  assert.equal(state.messages.length, 1);
  assert.equal(entry.binary, false);
  assert.deepEqual(entry.packet.input, payload.input);
  assert.deepEqual(Buffer.from(entry.packet.input[0].content[1].image_url.split(",")[1], "base64"), firstPng);
  assert.deepEqual(Buffer.from(entry.packet.input[0].content[3].image_url.split(",")[1], "base64"), secondPng);
  assert.ok(firstPng.length > fragmentBytes && secondPng.length > fragmentBytes);
  assert.equal(entry.packet.type, "response.create");
  assert.equal(entry.packet.generate, undefined);
  assert.equal(entry.packet.store, false);
  assert.ok(entry.raw.length > fragmentBytes && entry.raw.length < packetBytes);
  assert.deepEqual(Buffer.concat(sends.map(send => send.data)), entry.raw);
  assert.ok(sends.length > 2);
  assert.equal(frames.length, sends.length);
  assert.equal(frames[0].opcode, 1);
  assert.ok(frames.slice(1).every(frame => frame.opcode === 0));
  assert.ok(frames.every(frame => frame.masked && frame.bytes <= fragmentBytes));
  assert.ok(frames.slice(0, -1).every(frame => !frame.fin && frame.bytes === fragmentBytes));
  assert.equal(frames.at(-1).fin, true);
  assert.equal(acknowledgementFrames.length, Math.floor((entry.raw.length - 1) / (256 * 1024)));
  assert.ok(acknowledgementFrames.every(frame => frame.masked && frame.bytes === 16));
  assert.equal(new Set(state.connections[0].pings.map(token => token.toString("hex"))).size, acknowledgementFrames.length);
  assert.ok(sends.some(send => !Buffer.from(send.data.toString("utf8")).equals(send.data)), "fixture must split at least one multibyte code point");
  const nextPayload = body([...payload.input, message("继续，两个图像和前文保持不变")]);
  assert.equal((await start(state, "fragment-utf8-follow-up", nextPayload).done).error, undefined);
  assert.equal(state.connections.length, 1);
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[1].binary, false);
  assert.equal(state.messages[1].packet.previous_response_id, "resp_1");
  assert.deepEqual(state.messages[1].packet.input, nextPayload.input.slice(-1));
  assert.equal(state.transport.status().maxMessageBytes, packetBytes);
  context.diagnostic(`UTF8/images: ${entry.raw.length} bytes, ${frames.length} native frames, one text JSON, hot-connection follow-up completed`);
});

test("cancelling at a remote-read barrier removes its waiter and a late Pong cannot restart the old job", { timeout: 7000 }, async context => {
  const state = await fixture(context, { autoPong: false });
  const controller = new AbortController();
  const pending = start(state, "barrier-cancel-old", largeBody("barrier-old"), { signal: controller.signal });
  const previous = await remoteReadBarrier(state, 1);
  controller.abort();
  const cancelled = await pending.done;
  assert.equal(cancelled.error?.code, "ABORT_ERR");
  assert.equal(cancelled.error.requestAccepted, "unknown");
  assert.equal(previous.client.socket.listenerCount("pong"), 0);
  assert.equal(state.transport.getOperation("barrier-cancel-old").canRetry, false);
  assert.equal(state.transport.getOperation("barrier-cancel-old").requiresReconciliation, true);
  const next = start(state, "barrier-cancel-new", largeBody("barrier-new"));
  const current = await remoteReadBarrier(state, 2);
  assert.notDeepEqual(current.token, previous.token);
  const metadata = state.transport.getOperation("barrier-cancel-new");
  const retained = state.transport.status().retainedBytes;
  current.connection.socket.pong(previous.token);
  await waitFor(() => current.client.pongs.some(token => token.equals(previous.token)), "old token delivered over the replacement socket");
  previous.client.socket.emit("pong", previous.token);
  await nextIo();
  await nextIo();
  assert.equal(previous.client.sends.length, 4);
  assert.equal(current.client.sends.length, 4);
  assert.deepEqual(state.transport.getOperation("barrier-cancel-new"), metadata);
  assert.equal(state.transport.status().retainedBytes, retained);
  continueBarriers(current.connection, current.token);
  assert.equal((await next.done).error, undefined);
  assert.deepEqual(state.messages.map(entry => entry.connection), [2]);
  assert.equal(state.messages[0].packet.previous_response_id, undefined);
  assert.equal(state.transport.status().unknownOperations, 1);
  assert.equal(current.client.socket.listenerCount("pong"), 1, "completion removes its acknowledgement listener");
  context.diagnostic("barrier cancellation: old upload stopped at 262144B; old listener removed; late old token ignored by replacement; UNKNOWN retained");
});

test("a remote-read barrier ignores a wrong token and a late Pong from the previous checkpoint", { timeout: 7000 }, async context => {
  const state = await fixture(context, { autoPong: false });
  const pending = start(state, "barrier-token-match", largeBody("barrier-tokens"));
  const first = await remoteReadBarrier(state, 1);
  const wrong = Buffer.from(first.token);
  wrong[0] ^= 0xff;
  first.connection.socket.pong(wrong);
  await waitFor(() => first.client.pongs.some(token => token.equals(wrong)), "wrong token delivered over the real socket");
  await nextIo();
  assert.equal(first.client.sends.length, 4);
  assert.equal(first.client.socket.listenerCount("pong"), 2);
  first.connection.socket.pong(first.token);
  const second = await remoteReadBarrier(state, 1, 2);
  assert.notDeepEqual(second.token, first.token);
  second.connection.socket.pong(first.token);
  await waitFor(() => second.client.pongs.filter(token => token.equals(first.token)).length === 2, "late Pong from the previous checkpoint");
  await nextIo();
  assert.equal(second.client.sends.length, 8);
  assert.equal(second.client.socket.listenerCount("pong"), 2);
  continueBarriers(second.connection, second.token);
  assert.equal((await pending.done).error, undefined);
  assert.equal(state.messages.length, 1);
  assert.equal(state.transport.getOperation("barrier-token-match").state, "completed");
  assert.equal(second.client.socket.listenerCount("pong"), 1);
  assert.equal(new Set(second.connection.pings.map(token => token.toString("hex"))).size, second.connection.pings.length);
  context.diagnostic("barrier token matching: wrong token held at 262144B; previous-checkpoint Pong held at 524288B; matching Pongs completed the original JSON");
});

test("a remote-read barrier resumes after a short peer pause while B and heartbeat Pong remain live", { timeout: 7000 }, async context => {
  const state = await fixture(context, { autoPong: false });
  const payload = largeBody("barrier-pause");
  const pending = start(state, "barrier-short-pause", payload);
  const waiting = await remoteReadBarrier(state, 1);
  await delay(40);
  assert.equal(waiting.client.sends.length, 4);
  waiting.connection.socket.ping("barrier-wait-heartbeat");
  const independent = await start(state, "barrier-independent-b", body([message("small B during remote acknowledgement wait")]), { sessionKey: "session-b" }).done;
  assert.equal(independent.error, undefined);
  await waitFor(() => waiting.connection.pongs.includes("barrier-wait-heartbeat"), "heartbeat Pong during remote acknowledgement wait");
  assert.equal(waiting.client.sends.length, 4);
  assert.deepEqual(state.messages.map(entry => entry.connection), [2]);
  continueBarriers(waiting.connection, waiting.token);
  assert.equal((await pending.done).error, undefined);
  assert.deepEqual(state.messages.map(entry => entry.connection), [2, 1]);
  assert.deepEqual(state.messages[1].packet.input, payload.input);
  assert.equal(state.transport.getOperation("barrier-short-pause").state, "completed");
  assert.equal(waiting.client.socket.listenerCount("pong"), 1);
  assert.equal(state.transport.status().unknownOperations, 0);
  context.diagnostic(`barrier pause: at least 40ms held at 262144B; B and heartbeat Pong completed first; ${waiting.connection.pings.length} remote checkpoints; original JSON completed once`);
});
