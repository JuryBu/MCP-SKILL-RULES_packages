function failure(code, statusCode, errorType, message, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, errorType, localRequestFailure: true, ...details });
}

export function createRequestBufferBudget(maxBytes) {
  let usedBytes = 0;
  return {
    status: () => ({ usedBytes, maxBytes }),
    lease() {
      let reservedBytes = 0;
      let released = false;
      return {
        reserve(bytes) {
          if (released || bytes > maxBytes - usedBytes) return false;
          usedBytes += bytes;
          reservedBytes += bytes;
          return true;
        },
        release() {
          if (released) return;
          released = true;
          usedBytes -= reservedBytes;
          reservedBytes = 0;
        },
      };
    },
  };
}

export function collectRequestBody(request, maximumBytes, lease, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
      signal?.removeEventListener("abort", onAborted);
    };
    const finish = (error, body) => {
      if (settled) return;
      settled = true;
      cleanup();
      chunks.length = 0;
      if (error) {
        request.resume();
        reject(error);
      } else resolve(body);
    };
    const onData = (chunk) => {
      length += chunk.length;
      if (length > maximumBytes) {
        finish(failure("ENCODED_BODY_TOO_LARGE", 413, "request_too_large",
          "Encoded model request exceeds the proxy wire-body limit.", { encodedBytes: length, limit: maximumBytes, stage: "receive" }));
        return;
      }
      if (!lease.reserve(chunk.length)) {
        finish(failure("REQUEST_BUFFER_BUSY", 503, "proxy_request_capacity",
          "Local model proxy request-buffer capacity is temporarily exhausted.", { encodedBytes: length, stage: "admission" }));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      try { finish(null, Buffer.concat(chunks, length)); }
      catch { finish(failure("REQUEST_BUFFER_ALLOCATION_FAILED", 503, "proxy_request_capacity", "Local model proxy could not allocate a bounded request buffer.")); }
    };
    const onAborted = () => finish(failure("REQUEST_ABORTED", 499, "request_cancelled", "Model request was cancelled before forwarding."));
    const onError = () => finish(failure("REQUEST_READ_FAILED", 400, "invalid_request_body", "Model request ended before the complete body was received."));
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
    signal?.addEventListener("abort", onAborted, { once: true });
    if (signal?.aborted || request.aborted) onAborted();
  });
}
