import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { createRequestInspector, RequestInspectionError } from "../src/request-body-inspector.mjs";
import { classifyContextHint } from "../src/tool-preparation-deadline.mjs";
import { isCompleteZstdFrameSequence } from "../src/zstd-frame-validation.mjs";

function jsonBody(value) {
  return Buffer.from(JSON.stringify(value));
}

async function expectInspectionError(promise, code, statusCode, limit) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof RequestInspectionError);
    assert.equal(error.code, code);
    assert.equal(error.errorType, code);
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.limit, limit);
    assert.equal(error.message.length > 0, true);
    return true;
  });
}

test("metadata only, exact context hint semantics, model length and immutable source", async t => {
  const inspector = createRequestInspector();
  t.after(() => inspector.close());
  const payload = { model: "gpt-test", stream: true, input: [
    { role: "developer", content: "<context_window_reminder>ready</context_window_reminder>" },
    { encrypted_content: "opaque" },
  ], secret: "do-not-return" };
  const body = jsonBody(payload);
  const before = Buffer.from(body);
  const result = await inspector.inspect(body);
  assert.deepEqual(result, { model: "gpt-test", modelInvalid: false, stream: true, contextHint: classifyContextHint(payload),
    decodedBytes: body.length, contentEncoding: "identity" });
  assert.deepEqual(body, before);
  assert.equal(JSON.stringify(result).includes("do-not-return"), false);
  const invalidModel = await inspector.inspect(jsonBody({ model: "x".repeat(257), stream: 1 }));
  assert.equal(invalidModel.model, null);
  assert.equal(invalidModel.modelInvalid, true);
  assert.equal((await inspector.inspect(jsonBody({ stream: false }))).modelInvalid, false);
  assert.deepEqual(inspector.status(), { active: 0, queued: 0 });
});

test("legitimate body beyond a small former limit succeeds, exact byte boundary holds", async t => {
  const body = jsonBody({ model: "large", input: [{ role: "user", content: "x".repeat(96 * 1024) }] });
  const exact = createRequestInspector({ maxDecodedBytes: body.length });
  const short = createRequestInspector({ maxDecodedBytes: body.length - 1 });
  t.after(async () => { await Promise.all([exact.close(), short.close()]); });
  assert.equal((await exact.inspect(body)).decodedBytes, body.length);
  await expectInspectionError(short.inspect(body), "decoded_body_too_large", 413, body.length - 1);
  const compressed = zlib.gzipSync(body);
  assert.equal((await exact.inspect(compressed, "gzip")).decodedBytes, body.length);
  await expectInspectionError(short.inspect(compressed, "gzip"), "decoded_body_too_large", 413, body.length - 1);
});

test("identity, gzip, deflate, br and zstd decode in a short-lived worker", async t => {
  const inspector = createRequestInspector({ maxDecodedBytes: 4096 });
  t.after(() => inspector.close());
  const body = jsonBody({ model: "all", stream: false });
  const formats = [
    ["identity", body],
    ["gzip", zlib.gzipSync(body)],
    ["deflate", zlib.deflateSync(body)],
    ["br", zlib.brotliCompressSync(body)],
    ["zstd", zlib.zstdCompressSync(body)],
  ];
  for (const [encoding, encoded] of formats) {
    const result = await inspector.inspect(encoded, encoding);
    assert.equal(result.model, "all", encoding);
    assert.equal(result.decodedBytes, body.length, encoding);
    assert.equal(result.contentEncoding, encoding);
  }
  assert.deepEqual(inspector.status(), { active: 0, queued: 0 });
});

test("all compressors classify oversized decoded output as 413", async t => {
  const inspector = createRequestInspector({ maxDecodedBytes: 256 });
  t.after(() => inspector.close());
  const body = jsonBody({ input: "x".repeat(2048) });
  const formats = [
    ["gzip", zlib.gzipSync(body)],
    ["deflate", zlib.deflateSync(body)],
    ["br", zlib.brotliCompressSync(body)],
    ["zstd", zlib.zstdCompressSync(body)],
  ];
  for (const [encoding, encoded] of formats) {
    await expectInspectionError(inspector.inspect(encoded, encoding), "decoded_body_too_large", 413, 256);
  }
});

test("multiple encodings reverse correctly and each intermediate layer has the decoded limit", async t => {
  const inspector = createRequestInspector({ maxDecodedBytes: 1024 });
  t.after(() => inspector.close());
  const body = jsonBody({ model: "layered" });
  const gzip = zlib.gzipSync(body);
  const layered = zlib.brotliCompressSync(gzip);
  const result = await inspector.inspect(layered, "GZip, BR");
  assert.equal(result.model, "layered");
  assert.equal(result.contentEncoding, "gzip, br");
  const intermediate = Buffer.from("x".repeat(2048));
  const hugeIntermediate = zlib.gzipSync(intermediate);
  const outer = zlib.brotliCompressSync(hugeIntermediate);
  await expectInspectionError(inspector.inspect(outer, "gzip, br"), "decoded_body_too_large", 413, 1024);
});

test("unknown encoding, corrupt compression, invalid JSON and non-object JSON are separate", async t => {
  const inspector = createRequestInspector({ maxDecodedBytes: 4096 });
  t.after(() => inspector.close());
  await expectInspectionError(inspector.inspect(jsonBody({}), "snappy"), "unsupported_content_encoding", 415, 4096);
  await assert.rejects(inspector.inspect(Buffer.from("not gzip"), "gzip"), error => {
    assert.equal(error.code, "invalid_compression");
    assert.equal(error.statusCode, 400);
    assert.equal(typeof error.cause?.code, "string");
    return true;
  });
  await assert.rejects(inspector.inspect(Buffer.from("{secret")), error => {
    assert.equal(error.code, "invalid_json");
    assert.equal(error.statusCode, 400);
    assert.equal(error.cause?.code, "SyntaxError");
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  await expectInspectionError(inspector.inspect(jsonBody([1, 2])), "invalid_json_object", 400, 4096);
  await expectInspectionError(inspector.inspect(jsonBody(null)), "invalid_json_object", 400, 4096);
});

test("queue cap rejects immediately and aborting a queued task does not stop its neighbor", async t => {
  const inspector = createRequestInspector({ concurrency: 1, maxQueued: 1, timeoutMs: 10_000 });
  t.after(() => inspector.close());
  const first = inspector.inspect(jsonBody({ model: "first" }));
  const controller = new AbortController();
  const waiting = inspector.inspect(jsonBody({ model: "waiting" }), "identity", { signal: controller.signal });
  assert.deepEqual(inspector.status(), { active: 1, queued: 1 });
  await expectInspectionError(inspector.inspect(jsonBody({})), "inspection_queue_full", 503, 96 * 1024 * 1024);
  controller.abort(new Error("cancel request"));
  await expectInspectionError(waiting, "inspection_aborted", 503, 96 * 1024 * 1024);
  assert.equal((await first).model, "first");
  assert.deepEqual(inspector.status(), { active: 0, queued: 0 });
});

test("aborting an active task waits for worker exit before freeing its lane", async t => {
  const inspector = createRequestInspector({ concurrency: 1, maxQueued: 1 });
  t.after(() => inspector.close());
  const controller = new AbortController();
  const aborted = inspector.inspect(jsonBody({ input: "x".repeat(1024 * 1024) }), "identity", {
    signal: controller.signal,
  });
  const waiting = inspector.inspect(jsonBody({ model: "next" }));
  controller.abort(new Error("cancel active"));
  assert.deepEqual(inspector.status(), { active: 1, queued: 1 });
  await expectInspectionError(aborted, "inspection_aborted", 503, 96 * 1024 * 1024);
  assert.equal((await waiting).model, "next");
  assert.deepEqual(inspector.status(), { active: 0, queued: 0 });
});

test("timeout includes time spent waiting in queue", async t => {
  const inspector = createRequestInspector({ concurrency: 1, maxQueued: 1, timeoutMs: 1 });
  t.after(() => inspector.close());
  const first = inspector.inspect(jsonBody({ model: "first" }));
  const waiting = inspector.inspect(jsonBody({ model: "waiting" }));
  assert.deepEqual(inspector.status(), { active: 1, queued: 1 });
  await expectInspectionError(waiting, "inspection_timeout", 503, 96 * 1024 * 1024);
  await expectInspectionError(first, "inspection_timeout", 503, 96 * 1024 * 1024);
  assert.deepEqual(inspector.status(), { active: 0, queued: 0 });
});

test("close cancels active and queued work, awaits worker exit and leaves no lanes", async () => {
  const inspector = createRequestInspector({ concurrency: 1, maxQueued: 1 });
  const active = inspector.inspect(jsonBody({ input: ["x".repeat(1024 * 1024)] }));
  const queued = inspector.inspect(jsonBody({ model: "queued" }));
  const closing = inspector.close();
  await Promise.all([
    expectInspectionError(active, "inspection_closed", 503, 96 * 1024 * 1024),
    expectInspectionError(queued, "inspection_closed", 503, 96 * 1024 * 1024),
    closing,
  ]);
  assert.deepEqual(inspector.status(), { active: 0, queued: 0 });
  await expectInspectionError(inspector.inspect(jsonBody({})), "inspection_closed", 503, 96 * 1024 * 1024);
  await inspector.close();
});

test("invalid signal cannot strand a timeout or lane", async () => {
  const inspector = createRequestInspector();
  await assert.rejects(inspector.inspect(jsonBody({}), "identity", { signal: {} }), TypeError);
  assert.deepEqual(inspector.status(), { active: 0, queued: 0 });
  await inspector.close();
});

test("production Node zstd truncated final block is rejected despite valid partial JSON", async t => {
  const inspector = createRequestInspector();
  t.after(() => inspector.close());
  const clear = JSON.stringify({ model: "test-model", input: [] }) + " ".repeat(300000);
  const compressed = zlib.zstdCompressSync(clear);
  const truncated = compressed.subarray(0, -1);
  assert.equal(isCompleteZstdFrameSequence(compressed), true);
  assert.equal(isCompleteZstdFrameSequence(truncated), false);
  const partial = zlib.zstdDecompressSync(truncated);
  assert.ok(partial.length < Buffer.byteLength(clear));
  assert.equal(JSON.parse(partial.toString()).model, "test-model");
  await assert.rejects(inspector.inspect(truncated, "zstd"), error => {
    assert.equal(error.code, "invalid_compression");
    assert.equal(error.statusCode, 400);
    assert.equal(error.cause?.code, "ZSTD_INVALID_FRAME");
    return true;
  });
  assert.equal((await inspector.inspect(compressed, "zstd")).model, "test-model");
});

test("zstd frame scanner accepts complete multi-frame and skippable sequences", async t => {
  const inspector = createRequestInspector();
  t.after(() => inspector.close());
  const clear = JSON.stringify({ model: "multi", input: [] });
  const split = Math.floor(clear.length / 2);
  const first = zlib.zstdCompressSync(clear.slice(0, split));
  const second = zlib.zstdCompressSync(clear.slice(split));
  const skippable = Buffer.alloc(11);
  skippable.writeUInt32LE(0x184d2a5f, 0);
  skippable.writeUInt32LE(3, 4);
  skippable.set([1, 2, 3], 8);
  const sequence = Buffer.concat([skippable, first, skippable, second, skippable]);
  assert.equal(isCompleteZstdFrameSequence(sequence), true);
  assert.equal(isCompleteZstdFrameSequence(sequence.subarray(0, -1)), false);
  assert.equal(isCompleteZstdFrameSequence(Buffer.concat([sequence, Buffer.from([0])])), false);
  assert.equal((await inspector.inspect(sequence, "zstd")).model, "multi");
});

test("zstd scanner requires optional checksum bytes and complete block payload", async t => {
  const inspector = createRequestInspector();
  t.after(() => inspector.close());
  const clear = jsonBody({ model: "checksum" });
  const checksummed = zlib.zstdCompressSync(clear, {
    params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
  });
  assert.equal(isCompleteZstdFrameSequence(checksummed), true);
  assert.equal(isCompleteZstdFrameSequence(checksummed.subarray(0, -1)), false);
  assert.equal((await inspector.inspect(checksummed, "zstd")).model, "checksum");
  await expectInspectionError(inspector.inspect(checksummed.subarray(0, -1), "zstd"), "invalid_compression", 400, 96 * 1024 * 1024);
  const corruptChecksum = Buffer.from(checksummed);
  corruptChecksum[corruptChecksum.length - 1] ^= 1;
  assert.equal(isCompleteZstdFrameSequence(corruptChecksum), true);
  await expectInspectionError(inspector.inspect(corruptChecksum, "zstd"), "invalid_compression", 400, 96 * 1024 * 1024);
  const ordinary = zlib.zstdCompressSync(clear);
  for (let length = 0; length < ordinary.length; length++) {
    assert.equal(isCompleteZstdFrameSequence(ordinary.subarray(0, length)), false, `length ${length}`);
  }
});

test("zstd concatenated frames enforce an aggregate decoded limit", async t => {
  const inspector = createRequestInspector({ maxDecodedBytes: 256 });
  t.after(() => inspector.close());
  const first = zlib.zstdCompressSync("{" + " ".repeat(200));
  const second = zlib.zstdCompressSync("}" + " ".repeat(200));
  await expectInspectionError(inspector.inspect(Buffer.concat([first, second]), "zstd"),
    "decoded_body_too_large", 413, 256);
});

test("worker uses only Uint8Array view bytes and does not copy a large invalid model back", async t => {
  const inspector = createRequestInspector({ maxDecodedBytes: 1024 * 1024 });
  t.after(() => inspector.close());
  const payload = jsonBody({ model: "x".repeat(300000) });
  const wrapped = Buffer.concat([Buffer.from("prefix"), payload, Buffer.from("suffix")]);
  const view = wrapped.subarray(6, -6);
  const result = await inspector.inspect(view);
  assert.equal(result.model, null);
  assert.equal(result.modelInvalid, true);
  assert.equal(result.decodedBytes, payload.length);
  assert.equal(JSON.stringify(result).includes("x".repeat(1000)), false);
});
