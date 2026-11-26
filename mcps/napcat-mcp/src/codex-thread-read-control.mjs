import { createHash, timingSafeEqual } from "node:crypto";
import { THREAD_READ_BODY_BYTES, THREAD_READ_RESULT_BYTES, THREAD_READ_TIMEOUT_MS, ThreadReadError } from "./codex-thread-read.mjs";

const hash = token => createHash("sha256").update(token, "utf8").digest();
const loopback = address => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
const paths = new Map([["/v1/threads/list", "list"], ["/v1/threads/snapshot", "snapshot"]]);
export const isCodexThreadReadPath = url => paths.has(url);

function takeBody(request, signal) {
  if (request.destroyed || request.aborted) return Promise.reject(new ThreadReadError(499, "read_cancelled"));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0, finished = false;
    function finish(value, error) {
      if (finished) return;
      finished = true;
      request.off("data", collect).off("end", parse).off("aborted", interrupted).off("error", interrupted);
      signal.removeEventListener("abort", cancelled);
      if (error) {
        request.resume();
        reject(error);
      } else resolve(value);
    }
    function collect(chunk) {
      length += chunk.length;
      if (length > THREAD_READ_BODY_BYTES) finish(null, new ThreadReadError(413, "body_too_large"));
      else chunks.push(chunk);
    }
    function parse() {
      try { finish(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { finish(null, new ThreadReadError(400, "invalid_json")); }
    }
    function interrupted() { finish(null, new ThreadReadError(499, "read_cancelled")); }
    function cancelled() { finish(null, signal.reason); }
    if (signal.aborted) { cancelled(); return; }
    request.on("data", collect).once("end", parse).once("aborted", interrupted).once("error", interrupted);
    signal.addEventListener("abort", cancelled, { once: true });
  });
}

export function createCodexThreadReadHandler({ readToken, access, readThread, canRespond = () => true }) {
  if (typeof readToken !== "string" || !/^\S{32,128}$/u.test(readToken) || !(access?.threadIds instanceof Set)
    || typeof readThread !== "function" || typeof canRespond !== "function") {
    throw new TypeError("explicit local thread read authorization required");
  }
  const allowed = Object.freeze({ list: access.list === true,
    listScope: access.listScope === "current_account" ? "current_account" : "allowed_threads",
    threadIds: new Set(access.threadIds) });
  const expected = hash(readToken);
  let occupied = false;
  return async function handleThreadRead(request, response) {
    const kind = paths.get(request.url);
    if (!kind) return false;
    if (request.destroyed || request.aborted || response.destroyed) return true;
    const controller = new AbortController();
    const deadline = performance.now() + THREAD_READ_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(new ThreadReadError(504, "read_deadline")), THREAD_READ_TIMEOUT_MS);
    timer.unref();
    const disconnected = () => controller.abort(new ThreadReadError(499, "read_cancelled"));
    let ownsLane = false;
    response.once("close", disconnected);
    function respond(status, value) {
      if (response.destroyed || response.writableEnded) return;
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) > THREAD_READ_RESULT_BYTES) throw new ThreadReadError(500, "result_too_large");
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", connection: "close" });
      response.end(body);
    }
    try {
      if (!loopback(request.socket.remoteAddress)) throw new ThreadReadError(403, "loopback_required");
      const parts = typeof request.headers.authorization === "string" && /^Bearer (\S{32,128})$/iu.exec(request.headers.authorization);
      const repeated = request.rawHeaders.filter((key, index) => index % 2 === 0 && key.toLowerCase() === "authorization").length !== 1;
      if (repeated || !parts || !timingSafeEqual(hash(parts[1]), expected)) throw new ThreadReadError(401, "unauthorized");
      if (request.method !== "POST") throw new ThreadReadError(405, "method_not_allowed");
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/iu.test(request.headers["content-type"] ?? "")
        || ![undefined, "identity"].includes(request.headers["content-encoding"])) throw new ThreadReadError(415, "json_required");
      if (Number(request.headers["content-length"]) > THREAD_READ_BODY_BYTES) throw new ThreadReadError(413, "body_too_large");
      if (occupied) throw new ThreadReadError(429, "thread_read_busy");
      occupied = ownsLane = true;
      const input = await takeBody(request, controller.signal);
      let responseCheck;
      const result = await readThread(kind, input, allowed, {
        deadline,
        signal: controller.signal,
        registerResponseCheck(check) {
          if (responseCheck || typeof check !== "function") throw new ThreadReadError(500, "thread_read_failed");
          responseCheck = check;
        },
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!canRespond()) throw new ThreadReadError(503, "control_closing");
      responseCheck?.();
      respond(200, result);
    } catch (error) {
      request.resume();
      if (!(error instanceof ThreadReadError)) respond(500, { error: { code: "thread_read_failed" } });
      else if (error.status !== 499) respond(error.status, { error: { code: error.code } });
      else response.destroy();
    } finally {
      if (ownsLane) occupied = false;
      clearTimeout(timer);
      response.off("close", disconnected);
    }
    return true;
  };
}
