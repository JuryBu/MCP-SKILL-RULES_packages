import zlib from "node:zlib";

export function normalizeLocalNoticePayload(payload, referenceInputs = []) {
  if (!Array.isArray(payload?.input)) return payload;
  const referencedIds = new Set();
  for (const items of [payload.input, ...referenceInputs]) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (item?.type === "item_reference" && typeof item.id === "string") referencedIds.add(item.id);
    }
  }
  let changed = false;
  const input = payload.input.map(item => {
    if (item?.type !== "message" || item.role !== "assistant" || item.status !== "completed"
      || !/^msg_proxy_(?:root_)?[a-f0-9]{32}$/u.test(item.id ?? "") || referencedIds.has(item.id)
      || Object.hasOwn(item, "call_id") || !Array.isArray(item.content) || !item.content.length
      || !item.content.every(part => part?.type === "output_text" && typeof part.text === "string")) return item;
    changed = true;
    const { id: localId, ...message } = item;
    return message;
  });
  return changed ? { ...payload, input } : payload;
}

export function prepareLocalNoticeHttpBody(body, payload, contentEncoding, lease) {
  const normalized = normalizeLocalNoticePayload(payload);
  if (normalized === payload) return body;
  const rawEncoding = contentEncoding == null || contentEncoding === "" ? "identity"
    : Array.isArray(contentEncoding) ? contentEncoding.join(",") : contentEncoding;
  if (typeof rawEncoding !== "string" || rawEncoding.length > 256) return body;
  const encodings = rawEncoding.split(",").map(value => value.trim().toLowerCase());
  if (encodings.length > 16 || encodings.some(value => !["identity", "gzip", "deflate", "br", "zstd"].includes(value))) return body;
  let encoded = Buffer.from(JSON.stringify(normalized));
  for (const encoding of encodings) {
    if (encoding === "gzip") encoded = zlib.gzipSync(encoded);
    else if (encoding === "deflate") encoded = zlib.deflateSync(encoded);
    else if (encoding === "br") encoded = zlib.brotliCompressSync(encoded);
    else if (encoding === "zstd") encoded = zlib.zstdCompressSync(encoded);
  }
  if (encoded.length > body.length && lease && !lease.reserve(encoded.length - body.length)) {
    throw Object.assign(new Error("Normalized request cannot fit the aggregate request budget"), {
      code: "REQUEST_BUFFER_BUSY", statusCode: 503, errorType: "proxy_request_capacity", localRequestFailure: true,
    });
  }
  return encoded;
}
