import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { once } from "node:events";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createCodexModelStreamProxy } from "../src/codex-model-stream-proxy.mjs";
const createBaseline = process.env.BASELINE_MODEL_PROXY_FILE
  ? (await import(pathToFileURL(process.env.BASELINE_MODEL_PROXY_FILE))).createCodexModelStreamProxy : null;

const mebibyte = 1024 * 1024;
const encoding = process.env.LARGE_FIXTURE_ENCODING === "zstd" ? "zstd" : "gzip";
const completion = 'data: {"type":"response.completed","response":{"id":"large-fixture","status":"completed","model":"fixture-model","output":[]}}\n\n';
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function pngChunk(type, bytes) {
  const kind = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(zlib.crc32(bytes, zlib.crc32(kind)));
  return Buffer.concat([length, kind, bytes, checksum]);
}

function buildFixture() {
  const width = 1024;
  const height = 512;
  const pixels = crypto.randomBytes(height * (width * 4 + 1));
  for (let row = 0; row < height; row++) pixels[row * (width * 4 + 1)] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
  const url = `data:image/png;base64,${png.toString("base64")}`;
  const body = Buffer.from(JSON.stringify({ model: "fixture-model", stream: true, input: [{ role: "user", content: [
    { type: "input_text", text: "Synthetic PNG integrity fixture; never sent outside loopback." },
    ...Array.from({ length: 27 }, () => ({ type: "input_image", image_url: url })),
  ] }] }));
  const encoded = encoding === "zstd" ? zlib.zstdCompressSync(body) : zlib.gzipSync(body);
  return { encoded, decodedBytes: body.length, decodedHash: digest(body), encodedHash: digest(encoded), imageCount: 27, pngBytes: png.length };
}

async function serve(context, create, events) {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    const wireHash = crypto.createHash("sha256");
    const plainHash = crypto.createHash("sha256");
    let wireBytes = 0;
    let plainBytes = 0;
    request.on("data", chunk => { wireHash.update(chunk); wireBytes += chunk.length; });
    const decoded = request.headers["content-encoding"] === "gzip" ? request.pipe(zlib.createGunzip())
      : request.headers["content-encoding"] === "zstd" ? request.pipe(zlib.createZstdDecompress()) : request;
    for await (const chunk of decoded) { plainHash.update(chunk); plainBytes += chunk.length; }
    received.push({ wireBytes, wireHash: wireHash.digest("hex"), plainBytes, plainHash: plainHash.digest("hex") });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(completion);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = create({ port: 0, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, onEvent: event => events.push(event) });
  await proxy.start();
  const close = async () => { await proxy.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); };
  context.after(close);
  const send = (body, encoding, signal) => new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", "content-length": body.length };
    if (encoding) headers["content-encoding"] = encoding;
    const request = http.request({ host: "127.0.0.1", port: proxy.status().port, path: "/v1/responses", method: "POST", headers, signal }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.once("end", () => resolve({ status: response.statusCode, text }));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end(body);
  });
  return { proxy, send, received };
}

test("real 27-PNG request over 64 MiB decoded preserves all bytes repeatedly", { timeout: 120000, skip: process.env.RUN_LARGE_REQUEST_TESTS !== "1" }, async context => {
  const fixture = buildFixture();
  assert.ok(fixture.decodedBytes > 64 * mebibyte && fixture.decodedBytes < 96 * mebibyte);
  assert.ok(fixture.encoded.length < 64 * mebibyte);
  global.gc?.();
  if (createBaseline) {
    const baseline = await serve(context, createBaseline, []);
    const rejected = await baseline.send(fixture.encoded, encoding);
    assert.equal(rejected.status, 400);
    assert.equal(baseline.received.length, 0);
    await baseline.proxy.stop();
  }
  global.gc?.();
  const events = [];
  const candidate = await serve(context, createCodexModelStreamProxy, events);
  const samples = [];
  const cycleResults = [];
  const initialRss = process.memoryUsage().rss;
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const sampler = setInterval(() => samples.push({ rss: process.memoryUsage().rss, ...candidate.proxy.status().requestInspection }), 10);
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const started = performance.now();
      const response = await candidate.send(fixture.encoded, encoding);
      assert.equal(response.status, 200);
      assert.equal(response.text, completion);
      assert.deepEqual(candidate.received[cycle], { wireBytes: fixture.encoded.length, wireHash: fixture.encodedHash,
        plainBytes: fixture.decodedBytes, plainHash: fixture.decodedHash });
      assert.equal(candidate.proxy.status().requestInspection.active, 0);
      assert.equal(candidate.proxy.status().requestBuffer.usedBytes, 0);
      global.gc?.();
      await delay(50);
      cycleResults.push({ elapsedMs: Math.round(performance.now() - started), settledRss: process.memoryUsage().rss });
    }
    const controller = new AbortController();
    const cancelled = candidate.send(fixture.encoded, encoding, controller.signal);
    cancelled.catch(() => {});
    for (let attempts = 0; attempts < 1000 && candidate.proxy.status().requestInspection.active === 0; attempts++) await delay(2);
    assert.equal(candidate.proxy.status().requestInspection.active, 1);
    const healthy = candidate.send(Buffer.from('{"model":"fixture-model","input":[]}'));
    controller.abort();
    await assert.rejects(cancelled);
    assert.equal((await healthy).status, 200);
    assert.equal(candidate.received.length, 4);
    assert.ok(candidate.received[3].plainBytes < 100);
    assert.equal(candidate.proxy.status().requestInspection.active, 0);
    assert.equal(candidate.proxy.status().requestBuffer.usedBytes, 0);
    const parallel = await Promise.all([candidate.send(fixture.encoded, encoding), candidate.send(fixture.encoded, encoding)]);
    assert.ok(parallel.every(response => response.status === 200 && response.text === completion));
    assert.equal(candidate.received.length, 6);
    for (const item of candidate.received.slice(4)) {
      assert.equal(item.plainHash, fixture.decodedHash);
      assert.equal(item.wireHash, fixture.encodedHash);
    }
    assert.equal(candidate.proxy.status().requestBuffer.usedBytes, 0);
    assert.ok(samples.every(sample => sample.active <= 1 && sample.queued <= 16));
  } finally { clearInterval(sampler); eventLoop.disable(); }
  const inspected = events.filter(event => event.type === "request_body_inspected" && event.decodedBytes === fixture.decodedBytes);
  assert.equal(inspected.length, 5);
  context.diagnostic(JSON.stringify({ node: process.version, encoding, baselineCompared: Boolean(createBaseline), imageCount: fixture.imageCount, pngBytes: fixture.pngBytes,
    decodedBytes: fixture.decodedBytes, encodedBytes: fixture.encoded.length, decodedHash: fixture.decodedHash, encodedHash: fixture.encodedHash,
    initialRss, peakRss: Math.max(initialRss, ...samples.map(sample => sample.rss)), eventLoopMaxMs: eventLoop.max / 1e6, cycleResults,
    cancellationPreventedLargeUpstreamRequest: true, budgetAfter: candidate.proxy.status().requestBuffer }));
});

test("actual 96 MiB decoded boundary: exact accepted and plus one rejected before upstream", { timeout: 60000, skip: process.env.RUN_LARGE_REQUEST_TESTS !== "1" }, async context => {
  let plain = Buffer.from(JSON.stringify({ data: "x".repeat(96 * mebibyte - 11) }));
  assert.equal(plain.length, 96 * mebibyte);
  const exact = zlib.zstdCompressSync(plain);
  const expectedHash = digest(plain);
  const over = zlib.zstdCompressSync(Buffer.concat([plain, Buffer.from(" ")]));
  plain = null;
  global.gc?.();
  const state = await serve(context, createCodexModelStreamProxy, []);
  const accepted = await state.send(exact, "zstd");
  assert.equal(accepted.status, 200);
  assert.equal(accepted.text, completion);
  assert.equal(state.received[0].plainHash, expectedHash);
  const rejected = await state.send(over, "zstd");
  assert.equal(rejected.status, 413);
  assert.equal(JSON.parse(rejected.text).error.code, "decoded_body_too_large");
  assert.equal(state.received.length, 1);
  assert.equal(state.proxy.status().requestBuffer.usedBytes, 0);
});
