import { parentPort, workerData } from "node:worker_threads";
import zlib from "node:zlib";
import { classifyContextHint } from "./tool-preparation-deadline.mjs";
import { isCompleteZstdFrameSequence, visitZstdFrames } from "./zstd-frame-validation.mjs";

const ERROR_DETAILS = {
  unsupported_content_encoding: [415, "Unsupported content encoding."],
  invalid_compression: [400, "Invalid compressed request body."],
  decoded_body_too_large: [413, "Decoded request body exceeds limit."],
  invalid_json: [400, "Invalid JSON request body."],
  invalid_json_object: [400, "JSON request body must be an object."],
};

function failure(code, decodedBytes = null, causeCode = null) {
  const [statusCode, message] = ERROR_DETAILS[code];
  return { ok: false, error: { code, statusCode, errorType: code, message, decodedBytes,
    limit: workerData.maxDecodedBytes, causeCode } };
}

function inspect() {
  const header = workerData.contentEncoding;
  const rawEncoding = header == null || header === "" ? "identity" : Array.isArray(header) ? header.join(",") : header;
  if (typeof rawEncoding !== "string" || rawEncoding.length > 256) return failure("unsupported_content_encoding");
  const encodings = rawEncoding.split(",").map(value => value.trim().toLowerCase());
  if (encodings.length > 16 || encodings.some(value => !["identity", "gzip", "deflate", "br", "zstd"].includes(value))) {
    return failure("unsupported_content_encoding");
  }
  const contentEncoding = encodings.join(", ");
  const body = workerData.body;
  let decoded = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  for (const encoding of encodings.reverse()) {
    if (decoded.length > workerData.maxDecodedBytes && encoding === "identity") {
      return failure("decoded_body_too_large", decoded.length);
    }
    if (encoding === "identity") continue;
    try {
      const options = { maxOutputLength: workerData.maxDecodedBytes };
      if (encoding === "gzip") decoded = zlib.gunzipSync(decoded, options);
      else if (encoding === "deflate") decoded = zlib.inflateSync(decoded, options);
      else if (encoding === "br") decoded = zlib.brotliDecompressSync(decoded, options);
      else {
        if (!isCompleteZstdFrameSequence(decoded)) return failure("invalid_compression", null, "ZSTD_INVALID_FRAME");
        const parts = [];
        let totalBytes = 0;
        let aggregateTooLarge = false;
        const complete = visitZstdFrames(decoded, frame => {
          const part = zlib.zstdDecompressSync(frame, options);
          if (part.length > workerData.maxDecodedBytes - totalBytes) {
            aggregateTooLarge = true;
            return false;
          }
          totalBytes += part.length;
          if (part.length > 0) parts.push(part);
          return true;
        });
        if (aggregateTooLarge) return failure("decoded_body_too_large", null, "ZSTD_AGGREGATE_LIMIT");
        if (!complete) return failure("invalid_compression", null, "ZSTD_INVALID_FRAME");
        decoded = parts.length === 1 ? parts[0] : Buffer.concat(parts, totalBytes);
      }
    } catch (error) {
      return failure(error?.code === "ERR_BUFFER_TOO_LARGE" ? "decoded_body_too_large" : "invalid_compression",
        null, typeof error?.code === "string" ? error.code : null);
    }
  }
  if (decoded.length > workerData.maxDecodedBytes) return failure("decoded_body_too_large", decoded.length);
  const decodedBytes = decoded.length;
  let payload;
  try {
    payload = JSON.parse(decoded.toString("utf8"));
  } catch {
    return failure("invalid_json", decodedBytes, "SyntaxError");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return failure("invalid_json_object", decodedBytes);
  }
  const validModel = typeof payload.model === "string" && payload.model.length <= 256;
  return { ok: true, value: {
    model: validModel ? payload.model : null,
    modelInvalid: payload.model != null && !validModel,
    stream: payload.stream === true,
    contextHint: classifyContextHint(payload),
    decodedBytes,
    contentEncoding,
  } };
}

try {
  parentPort.postMessage(inspect());
} catch (error) {
  parentPort.postMessage({ ok: false, unexpected: true, causeCode: typeof error?.code === "string" ? error.code : null });
} finally {
  parentPort.close();
}
