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
        get maxBytes() { return maxBytes; },
        reserve(bytes) {
          if (released || bytes > maxBytes - usedBytes) return false;
          usedBytes += bytes;
          reservedBytes += bytes;
          return true;
        },
        releaseBytes(bytes) {
          if (released) return;
          if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > reservedBytes) throw new RangeError("Invalid request workspace release");
          usedBytes -= bytes;
          reservedBytes -= bytes;
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

export function createRequestBodyOwner(lease, { retainUntilReleased = false } = {}) {
  let body = null;
  let bytes = 0;
  let submitted = false;
  let replayApproved = false;
  return {
    get body() { return body; },
    get bytes() { return bytes; },
    approveReplay() {
      if (!retainUntilReleased || body === null || !submitted) throw new Error("Retained request body is unavailable for replay");
      replayApproved = true;
    },
    assign(value) {
      if (body !== null || submitted) throw new Error("Request body already assigned");
      body = value;
      bytes = value.length;
    },
    releaseUnused() {
      if (submitted && !retainUntilReleased) return;
      body = null;
      lease.release();
    },
    submit(upstream, onFinished) {
      if (submitted && !replayApproved || body === null) throw new Error("Request body cannot be submitted twice");
      submitted = true;
      replayApproved = false;
      const release = () => { if (!retainUntilReleased) lease.release(); };
      upstream.once("finish", () => {
        release();
        if (!upstream.destroyed) onFinished?.(bytes);
      });
      upstream.once("close", release);
      try { upstream.end(body); }
      catch (error) { upstream.destroy(); throw error; }
      finally { if (!retainUntilReleased) body = null; }
    },
  };
}

export function collectRequestBody(request, maximumBytes, lease, signal, { idleTimeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    let idleTimer = null;
    const cleanup = () => {
      clearTimeout(idleTimer);
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
        lease.release();
        request.resume();
        reject(error);
      } else resolve(body);
    };
    const armIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(failure("REQUEST_BODY_IDLE_TIMEOUT", 408, "request_timeout",
        "Model request body stopped making upload progress.", { encodedBytes: length, stage: "receive", idleTimeoutMs })), idleTimeoutMs);
      idleTimer.unref?.();
    };
    const onData = (chunk) => {
      if (chunk.length > 0) armIdleTimer();
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
    armIdleTimer();
    if (signal?.aborted || request.aborted) onAborted();
  });
}

export const JSON_REQUEST_CHUNK_BYTES = 64 * 1024;
export const JSON_REQUEST_WORKSPACE_BYTES = 12 * JSON_REQUEST_CHUNK_BYTES;
const STRING_CHARS = 8192;

function normalize(value, key) {
  if ((value !== null && ["object", "function"].includes(typeof value)) || typeof value === "bigint") {
    const toJSON = value.toJSON;
    if (typeof toJSON === "function") value = toJSON.call(value, key);
  }
  if (value instanceof Number || value instanceof String || value instanceof Boolean) value = value.valueOf();
  if (value !== null && typeof value === "object" && Object.prototype.toString.call(value) === "[object BigInt]") {
    try { value = BigInt.prototype.valueOf.call(value); } catch {}
  }
  return value;
}

function omitted(value) {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function* stringParts(value) {
  yield '"';
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + STRING_CHARS);
    if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff
      && value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff) end -= 1;
    yield JSON.stringify(value.slice(offset, end)).slice(1, -1);
    offset = end;
  }
  yield '"';
}

function* valueParts(value, ancestors) {
  if (typeof value === "string") { yield* stringParts(value); return; }
  if (value === null || typeof value !== "object") {
    yield JSON.stringify(value);
    return;
  }
  if (ancestors.has(value)) throw new TypeError("Converting circular structure to JSON");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      yield "[";
      const length = value.length;
      for (let index = 0; index < length; index += 1) {
        if (index) yield ",";
        const item = normalize(value[index], String(index));
        yield* valueParts(omitted(item) ? null : item, ancestors);
      }
      yield "]";
    } else {
      yield "{";
      let first = true;
      for (const key of Object.keys(value)) {
        const item = normalize(value[key], key);
        if (omitted(item)) continue;
        if (!first) yield ",";
        first = false;
        yield* stringParts(key);
        yield ":";
        yield* valueParts(item, ancestors);
      }
      yield "}";
    }
  } finally { ancestors.delete(value); }
}

export function* jsonRequestParts(payload) {
  const value = normalize(payload, "");
  if (omitted(value)) throw new TypeError("Request body has no JSON representation");
  yield* valueParts(value, new Set());
}

export function measureJsonRequestBody(payload) {
  let bytes = 0;
  for (const part of jsonRequestParts(payload)) bytes += Buffer.byteLength(part);
  if (!Number.isSafeInteger(bytes)) throw new RangeError("JSON request byte length exceeds safe integer range");
  return bytes;
}

export function* jsonRequestChunks(payload) {
  let output = Buffer.allocUnsafe(JSON_REQUEST_CHUNK_BYTES);
  let used = 0;
  for (const part of jsonRequestParts(payload)) {
    const fragment = Buffer.from(part);
    for (let offset = 0; offset < fragment.length;) {
      const copied = fragment.copy(output, used, offset, offset + Math.min(fragment.length - offset, output.length - used));
      used += copied;
      offset += copied;
      if (used === output.length) {
        yield output;
        output = Buffer.allocUnsafe(JSON_REQUEST_CHUNK_BYTES);
        used = 0;
      }
    }
  }
  if (used) yield output.subarray(0, used);
}

export function createJsonRequestBodyOwner(lease, { payload, bytes = measureJsonRequestBody(payload), retainUntilReleased = false } = {}) {
  let body = payload;
  let available = true;
  let submitted = false;
  let replayApproved = false;
  let active = null;
  const requests = new Set();
  let leaseReleased = false;
  const releaseLease = () => {
    if (leaseReleased) return;
    leaseReleased = true;
    lease.release();
  };
  return {
    get body() { return available ? body : null; },
    get bytes() { return bytes; },
    approveReplay() {
      if (!retainUntilReleased || !available || !submitted || active) throw new Error("Retained request body is unavailable for replay");
      replayApproved = true;
    },
    releaseUnused() {
      if (!available && leaseReleased) return;
      available = false;
      body = null;
      active?.stop();
      for (const request of requests) {
        if (!request.destroyed && !request.writableFinished) request.destroy();
      }
      releaseLease();
    },
    submit(upstream, onFinished) {
      if (!available || active || (submitted && !replayApproved)) throw new Error("Request body cannot be submitted twice");
      submitted = true;
      replayApproved = false;
      const iterator = jsonRequestChunks(body);
      let stopped = false;
      let responseSeen = false;
      let endCalled = false;
      let finishedNotified = false;
      let writtenBytes = 0;
      let pending = null;
      let drainWaiter = null;
      let ioYield = null;
      let ioYieldIsTimer = false;
      let requestError = null;
      const errorConsumers = upstream instanceof JsonBodyClientRequest ? upstream.rawListeners("error") : [];
      for (const consumer of errorConsumers) upstream.off("error", consumer);
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (ioYieldIsTimer) clearTimeout(ioYield);
        else clearImmediate(ioYield);
        ioYield = null;
        pending?.(false);
        pending = null;
        drainWaiter = null;
        iterator.return();
        upstream.off("drain", onDrain);
        upstream.off("finish", onFinish);
        upstream.off("abort", onAbort);
        if (active === attempt) active = null;
        if (!retainUntilReleased) {
          available = false;
          body = null;
          releaseLease();
        }
      };
      const onDrain = () => drainWaiter?.();
      const onResponse = () => { responseSeen = true; stop(); };
      const onError = error => { requestError ??= error; stop(); };
      const onAbort = () => stop();
      const onClose = () => {
        stop();
        upstream.off("error", onError);
        upstream.off("close", onClose);
        upstream.off("response", onResponse);
        requests.delete(upstream);
        if (requestError && !responseSeen) {
          for (const consumer of errorConsumers) consumer.call(upstream, requestError);
        }
        errorConsumers.length = 0;
      };
      const onFinish = () => {
        if (!stopped && endCalled && writtenBytes === bytes && !finishedNotified) {
          finishedNotified = true;
          stop();
          if (!upstream.destroyed) onFinished?.(bytes);
        }
      };
      const attempt = { upstream, stop };
      active = attempt;
      requests.add(upstream);
      upstream.prependOnceListener("response", onResponse);
      upstream.once("finish", onFinish);
      upstream.on("drain", onDrain);
      upstream.once("abort", onAbort);
      upstream.on("error", onError);
      upstream.once("close", onClose);
      const writeChunk = chunk => new Promise((resolve, reject) => {
        let callbackDone = false;
        let drainDone = false;
        let writeReturned = false;
        const complete = event => {
          if (event === false) { pending = null; drainWaiter = null; resolve(false); return; }
          if (event === "drain") drainDone = true;
          if (writeReturned && callbackDone && drainDone) { pending = null; drainWaiter = null; resolve(true); }
        };
        pending = complete;
        drainWaiter = () => complete("drain");
        try {
          const accepted = upstream.write(chunk, error => {
            if (error) { stop(); resolve(false); return; }
            callbackDone = true;
            complete();
          });
          drainDone = accepted || drainDone;
          writeReturned = true;
          complete();
        } catch (error) { pending = null; drainWaiter = null; reject(error); }
      });
      const yieldToIo = (headerWindow = false) => new Promise(resolve => {
        pending = value => { pending = null; resolve(value); };
        const resume = () => {
          ioYield = null;
          const complete = pending;
          pending = null;
          complete?.(true);
        };
        ioYieldIsTimer = headerWindow;
        ioYield = headerWindow ? setTimeout(resume, 0) : setImmediate(resume);
      });
      const waitForConnection = () => new Promise(resolve => {
        let socket = null;
        const complete = value => {
          pending = null;
          upstream.off("socket", onSocket);
          socket?.off("connect", connected);
          socket?.off("secureConnect", connected);
          resolve(value);
        };
        const connected = () => complete(true);
        const onSocket = value => {
          socket = value;
          if (socket.destroyed) { complete(false); return; }
          if (!socket.connecting && (!socket.encrypted || socket.getProtocol?.())) { complete(true); return; }
          socket.once(socket.encrypted ? "secureConnect" : "connect", connected);
        };
        pending = complete;
        if (upstream.socket) onSocket(upstream.socket);
        else upstream.once("socket", onSocket);
      });
      const pump = async () => {
        if (upstream instanceof JsonBodyClientRequest) {
          upstream.flushHeaders();
          if (!await waitForConnection() || !await yieldToIo(true) || !await yieldToIo(true)) return;
        }
        let firstChunk = true;
        while (!stopped && !upstream.destroyed && !upstream.writableEnded) {
          const next = iterator.next();
          if (next.done) {
            if (writtenBytes !== bytes) throw new Error("JSON request changed between measurement and submission");
            endCalled = true;
            upstream.end();
            return;
          }
          if (writtenBytes + next.value.length > bytes) throw new Error("JSON request grew between measurement and submission");
          writtenBytes += next.value.length;
          if (!await writeChunk(next.value) || stopped) return;
          if (firstChunk && upstream instanceof JsonBodyClientRequest) {
            firstChunk = false;
            if (!await yieldToIo(true) || !await yieldToIo(true)) return;
          }
          if (!await yieldToIo()) return;
        }
        stop();
      };
      void pump().catch(error => {
        stop();
        if (!responseSeen && !upstream.destroyed) upstream.destroy(error);
      });
      if (upstream.destroyed || upstream.aborted) stop();
    },
  };
}
import { ClientRequest as JsonBodyClientRequest } from "node:http";

