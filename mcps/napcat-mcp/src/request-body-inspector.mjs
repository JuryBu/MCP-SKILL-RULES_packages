import { Worker } from "node:worker_threads";

const WORKER_URL = new URL("./request-body-inspector-worker.mjs", import.meta.url);
const WORKER_HEAP_MB = 384;

const ERRORS = {
  unsupported_content_encoding: [415, "Unsupported content encoding."],
  invalid_compression: [400, "Invalid compressed request body."],
  decoded_body_too_large: [413, "Decoded request body exceeds limit."],
  invalid_json: [400, "Invalid JSON request body."],
  invalid_json_object: [400, "JSON request body must be an object."],
  inspection_queue_full: [503, "Request inspection queue is full."],
  inspection_timeout: [503, "Request inspection timed out."],
  inspection_worker_failed: [503, "Request inspection worker failed."],
  inspection_aborted: [503, "Request inspection was aborted."],
  inspection_closed: [503, "Request inspector is closed."],
};

export class RequestInspectionError extends Error {
  constructor(code, { decodedBytes = null, limit = null, cause } = {}) {
    const [statusCode, message] = ERRORS[code];
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RequestInspectionError";
    this.code = code;
    this.statusCode = statusCode;
    this.errorType = code;
    this.decodedBytes = decodedBytes;
    this.limit = limit;
  }
}

function positiveInteger(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new RangeError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return value;
}

export function createRequestInspector({ maxDecodedBytes = 96 * 1024 * 1024, concurrency = 1,
  maxQueued = 16, timeoutMs = 15_000 } = {}) {
  positiveInteger(maxDecodedBytes, "maxDecodedBytes");
  positiveInteger(concurrency, "concurrency");
  positiveInteger(maxQueued, "maxQueued", true);
  positiveInteger(timeoutMs, "timeoutMs");
  const active = new Set();
  const queue = [];
  let closed = false;
  let closePromise;

  function removeQueued(task) {
    const index = queue.indexOf(task);
    if (index !== -1) queue.splice(index, 1);
  }

  function settle(task, error, value) {
    if (task.settled) return;
    task.settled = true;
    clearTimeout(task.timer);
    task.signal?.removeEventListener("abort", task.onAbort);
    if (error) task.reject(error);
    else task.resolve(value);
    task.complete();
  }

  function drain() {
    while (!closed && active.size < concurrency && queue.length > 0) start(queue.shift());
  }

  function cancel(task, error) {
    if (task.settled || task.terminalError) return;
    task.terminalError = error;
    if (!task.worker) {
      removeQueued(task);
      settle(task, error);
      drain();
    } else {
      task.worker.terminate().catch(terminationError => {
        task.terminationError = terminationError;
      });
    }
  }

  function start(task) {
    active.add(task);
    try {
      task.worker = new Worker(WORKER_URL, {
        workerData: { body: task.body, contentEncoding: task.contentEncoding, maxDecodedBytes },
        resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      });
    } catch (error) {
      active.delete(task);
      settle(task, new RequestInspectionError("inspection_worker_failed", { limit: maxDecodedBytes, cause: error }));
      drain();
      return;
    }
    task.worker.on("message", message => { task.result = message; });
    task.worker.on("error", error => { task.workerError = error; });
    task.worker.on("exit", exitCode => {
      active.delete(task);
      let error = task.terminalError;
      let value;
      if (!error && task.workerError) {
        error = new RequestInspectionError("inspection_worker_failed", { limit: maxDecodedBytes, cause: task.workerError });
      } else if (!error && task.result?.ok === true && exitCode === 0) {
        value = task.result.value;
      } else if (!error && task.result?.error && exitCode === 0) {
        const detail = task.result.error;
        const cause = detail.causeCode ? Object.assign(new Error(detail.causeCode), { code: detail.causeCode }) : undefined;
        error = new RequestInspectionError(detail.code, { decodedBytes: detail.decodedBytes,
          limit: maxDecodedBytes, cause });
      } else if (!error) {
        const causeCode = task.result?.causeCode;
        const cause = causeCode ? Object.assign(new Error(causeCode), { code: causeCode }) : new Error(`Worker exited with code ${exitCode}`);
        error = new RequestInspectionError("inspection_worker_failed", { limit: maxDecodedBytes, cause });
      }
      settle(task, error, value);
      drain();
    });
  }

  function inspect(body, contentEncoding, { signal } = {}) {
    if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
      return Promise.reject(new TypeError("body must be a Buffer or Uint8Array"));
    }
    if (signal != null && (typeof signal.addEventListener !== "function"
      || typeof signal.removeEventListener !== "function")) {
      return Promise.reject(new TypeError("signal must be an AbortSignal"));
    }
    if (closed) return Promise.reject(new RequestInspectionError("inspection_closed", { limit: maxDecodedBytes }));
    if (signal?.aborted) {
      return Promise.reject(new RequestInspectionError("inspection_aborted", { limit: maxDecodedBytes, cause: signal.reason }));
    }
    if (active.size >= concurrency && queue.length >= maxQueued) {
      return Promise.reject(new RequestInspectionError("inspection_queue_full", { limit: maxDecodedBytes }));
    }
    return new Promise((resolve, reject) => {
      const task = { body, contentEncoding, signal, resolve, reject, settled: false, terminalError: null,
        worker: null, result: null };
      task.done = new Promise(complete => { task.complete = complete; });
      task.onAbort = () => cancel(task, new RequestInspectionError("inspection_aborted", {
        limit: maxDecodedBytes, cause: signal.reason,
      }));
      task.timer = setTimeout(() => cancel(task, new RequestInspectionError("inspection_timeout", {
        limit: maxDecodedBytes,
      })), timeoutMs);
      signal?.addEventListener("abort", task.onAbort, { once: true });
      if (signal?.aborted) task.onAbort();
      else if (active.size < concurrency) start(task);
      else queue.push(task);
    });
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    for (const task of [...queue]) cancel(task, new RequestInspectionError("inspection_closed", { limit: maxDecodedBytes }));
    const exits = [...active].map(task => task.done);
    for (const task of [...active]) cancel(task, new RequestInspectionError("inspection_closed", { limit: maxDecodedBytes }));
    closePromise = Promise.all(exits).then(() => undefined);
    return closePromise;
  }

  return { inspect, status: () => ({ active: active.size, queued: queue.length }), close };
}
