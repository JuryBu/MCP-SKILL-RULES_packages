import { setTimeout as delay } from "node:timers/promises";
import { PassThrough, Readable } from "node:stream";
import { collectBodySource, createSourceRequestBodyOwner } from "./request-body-source.mjs";
import { createRequestBodyOwner } from "./request-body-buffer.mjs";
import { prepareLocalNoticeHttpBody } from "./local-notice-normalization.mjs";
import { createSourceInputProof } from "./source-input-proof.mjs";

const COLLECTION_WORKSPACE_BYTES = 2 * 1024 * 1024;
const SOURCE_WORKSPACE_BYTES = 8 * 1024 * 1024;

export async function estimateBufferedJsonGraph(source, { signal, maxBytes = Number.MAX_SAFE_INTEGER } = {}) {
  if (signal?.aborted) throw signal.reason;
  let nodes = 0;
  let inString = false;
  let escaped = false;
  let inPrimitive = false;
  const estimate = () => source.bytes * 2 + nodes * 256;
  if (estimate() > maxBytes) return estimate();
  for await (const chunk of source.open({ signal })) {
    if (signal?.aborted) throw signal.reason;
    for (const byte of chunk) {
      if (inString) {
        if (escaped) escaped = false;
        else if (byte === 92) escaped = true;
        else if (byte === 34) inString = false;
      } else if (byte === 34) { inString = true; inPrimitive = false; nodes++; }
      else if (byte === 123 || byte === 91) { nodes++; inPrimitive = false; }
      else if (byte === 58 || byte === 44 || byte === 125 || byte === 93) inPrimitive = false;
      else if (byte === 32 || byte === 9 || byte === 10 || byte === 13) inPrimitive = false;
      else if (!inPrimitive) { nodes++; inPrimitive = true; }
      if (estimate() > maxBytes) return estimate();
    }
  }
  return estimate();
}

async function reserveWorkspace(lease, bytes, signal, onWaiting) {
  if (bytes > lease.maxBytes) throw Object.assign(new Error("Request inspection workspace exceeds the available request budget"), {
    code: "REQUEST_BUFFER_BUSY", statusCode: 503, errorType: "proxy_request_capacity", localRequestFailure: true,
  });
  let reported = false;
  while (!lease.reserve(bytes)) {
    if (!reported) { onWaiting?.(); reported = true; }
    await delay(25, undefined, { signal });
  }
}

async function readBounded(source, limit, signal) {
  if (source.bytes > limit) throw new RangeError("Request body cannot be materialized in this window");
  const output = Buffer.allocUnsafe(source.bytes);
  let offset = 0;
  for await (const chunk of source.open({ signal })) {
    if (offset + chunk.length > output.length) throw new Error("Request body source changed length");
    chunk.copy(output, offset);
    offset += chunk.length;
  }
  if (offset !== output.length) throw new Error("Request body source was truncated");
  return output;
}

async function collectRequestSource(request, options) {
  const input = new PassThrough({ highWaterMark: options.chunkBytes });
  const onError = error => input.destroy(error);
  const onAborted = () => input.destroy(Object.assign(new Error("Request upload was cancelled"), { code: "REQUEST_ABORTED", statusCode: 499 }));
  request.once("error", onError);
  request.once("aborted", onAborted);
  request.pipe(input);
  try { return await collectBodySource(input, options); }
  catch (error) { if (!request.destroyed) request.resume(); throw error; }
  finally { request.unpipe(input); request.off("error", onError); request.off("aborted", onAborted); }
}

function controlPayload(document, inspected) {
  const payload = { model: inspected.model, stream: inspected.stream, input: Object.freeze({}) };
  if (document.getNode(["compaction_trigger"])) payload.compaction_trigger = true;
  for (const name of ["type", "generate", "store", "previous_response_id"]) {
    const node = document.getNode([name]);
    if (node && node.end - node.start <= 8192) payload[name] = document.getSmall(node, { maxBytes: 8192 });
  }
  const client = document.getNode(["client_metadata"]);
  if (client?.type === "object") {
    const metadata = {};
    for (const name of ["x-codex-turn-metadata", "x-openai-subagent", "thread_id", "turn_id"]) {
      const node = document.field(client, name);
      if (!node) continue;
      if (node.end - node.start > 65536) throw Object.assign(new Error("Invalid request identity metadata"), {
        code: "INTERNAL_MEMORY_DESCRIPTOR_INVALID", statusCode: 403
      });
      Object.defineProperty(metadata, name, { value: document.getSmall(node), enumerable: true });
    }
    payload.client_metadata = metadata;
  }
  return payload;
}

export async function prepareRequestBodySource(request, { lease, inspector, contentEncoding, signal,
  maxBufferedRequestBytes, retainUntilReleased = false, idleTimeoutMs = 15000,
  source: suppliedSource, onWaiting, directory, forceSourceInspection = false } = {}) {
  let source;
  let document;
  let owner;
  let sourceWorkspaceReserved = false;
  let collectionReserved = 0;
  let rawReserved = 0;
  let decodedReserved = 0;
  let sourceInspection;
  const inspectSource = async () => {
    if (sourceInspection) return sourceInspection;
    if (!sourceWorkspaceReserved) {
      await reserveWorkspace(lease, SOURCE_WORKSPACE_BYTES, signal, onWaiting);
      sourceWorkspaceReserved = true;
    }
    const { inspectJsonBodySource } = await import("./source-json-inspection.mjs");
    sourceInspection = await inspectJsonBodySource(source, contentEncoding, { signal, directory });
    document = sourceInspection.document;
    return sourceInspection;
  };
  try {
    collectionReserved = Math.max(1, Math.min(COLLECTION_WORKSPACE_BYTES, Math.floor(lease.maxBytes / 4)));
    await reserveWorkspace(lease, collectionReserved, signal, onWaiting);
    source = suppliedSource ? suppliedSource.retain() : await collectRequestSource(request, { signal, idleTimeoutMs, directory,
      memoryThresholdBytes: Math.min(1024 * 1024, Math.floor(collectionReserved / 2)),
      chunkBytes: Math.max(1, Math.min(64 * 1024, Math.floor(collectionReserved / 2))) });
    lease.releaseBytes(collectionReserved);
    collectionReserved = 0;
    const encoded = contentEncoding != null && contentEncoding !== "" && String(contentEncoding).trim().toLowerCase() !== "identity";
    if (forceSourceInspection || encoded) await inspectSource();
    let graphBytes = null;
    if (sourceInspection) {
      const count = sourceInspection.nodeCount ?? document.nodeCount;
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("Source JSON inspection did not report its node count");
      graphBytes = sourceInspection.decodedBytes * 2 + count * 256;
    } else if (source.bytes > 1024 * 1024 && source.bytes <= maxBufferedRequestBytes) {
      const workspace = Math.min(64 * 1024, lease.maxBytes);
      await reserveWorkspace(lease, workspace, signal, onWaiting);
      try {
        graphBytes = await estimateBufferedJsonGraph(source, { signal,
          maxBytes: lease.maxBytes - SOURCE_WORKSPACE_BYTES - source.bytes });
      } finally { lease.releaseBytes(workspace); }
    }
    if (!forceSourceInspection && source.bytes <= maxBufferedRequestBytes
      && (graphBytes === null || graphBytes <= lease.maxBytes - SOURCE_WORKSPACE_BYTES - source.bytes)
      && lease.reserve(source.bytes)) {
      rawReserved = source.bytes;
      try {
        const graphAvailable = graphBytes === null || lease.reserve(graphBytes);
        if (graphBytes !== null && graphAvailable) decodedReserved = graphBytes;
        if (graphAvailable) {
          const body = await readBounded(source, maxBufferedRequestBytes, signal);
          const inspected = await inspector.inspect(body, contentEncoding, { signal, includePayload: true });
          if (decodedReserved || lease.reserve(inspected.decodedBytes)) {
            decodedReserved ||= inspected.decodedBytes;
            const normalized = prepareLocalNoticeHttpBody(body, inspected.payload, contentEncoding, lease);
            owner = createRequestBodyOwner(lease, { retainUntilReleased });
            owner.assign(normalized);
            await document?.release();
            document = null;
            await source.release();
            source = null;
            if (sourceWorkspaceReserved) lease.releaseBytes(SOURCE_WORKSPACE_BYTES);
            return { requestBody: owner, inspected, sourceBased: false, decodedReserved: true };
          }
        }
      } catch (error) {
        if (!["decoded_body_too_large", "inspection_timeout", "inspection_queue_full", "inspection_worker_failed", "REQUEST_BUFFER_BUSY"].includes(error.code)
          || signal?.aborted) throw error;
      }
      lease.releaseBytes(rawReserved + decodedReserved);
      rawReserved = 0;
      decodedReserved = 0;
    }
    const inspected = await inspectSource();
    const payload = controlPayload(document, inspected);
    const proof = await createSourceInputProof({ model: inspected.model, previousResponseId: payload.previous_response_id,
      inputIsIncremental: document.getNode(["previous_response_id"])?.type === "string",
      records: options => document.inputRecords(options), compactionHash: await document.compactionHash(), signal });
    proof.register(payload);
    inspected.payload = payload;
    inspected.sourceDocument = document;
    inspected.sourceProof = proof;
    let outgoing = source;
    let encoding = contentEncoding;
    const normalized = await document.normalizedOriginalChunks();
    if (normalized.changed) {
      outgoing = await collectBodySource(Readable.from(normalized.chunks), { signal, directory });
      encoding = "identity";
    }
    const originalRelease = outgoing !== source ? outgoing : null;
    owner = createSourceRequestBodyOwner(outgoing, { retainUntilReleased,
      onRelease: async () => {
        try { await document.release(); }
        finally { lease.release(); }
      } });
    if (originalRelease) await originalRelease.release();
    await source.release();
    source = null;
    return { requestBody: owner, inspected, sourceBased: true, decodedReserved: sourceWorkspaceReserved,
      contentEncoding: encoding ?? "identity", materializationEstimateBytes: graphBytes };
  } catch (error) {
    await owner?.releaseUnused();
    await document?.release();
    await source?.release();
    lease.release();
    throw error;
  }
}

export async function createSourceHttpRequestBody(document, { signal, directory } = {}) {
  async function* chunks() {
    yield Buffer.from('{"stream":true');
    let pending;
    let first = true;
    for await (const chunk of document.originalChunks({ omitRootFields: ["type", "generate", "previous_response_id", "stream"],
      normalizeLocalNotices: true, signal })) {
      if (first) { first = false; continue; }
      if (pending) yield pending;
      else if (chunk.toString() !== "}") yield Buffer.from(",");
      pending = chunk;
    }
    yield Buffer.from("}");
  }
  return collectBodySource(Readable.from(chunks()), { signal, directory });
}
