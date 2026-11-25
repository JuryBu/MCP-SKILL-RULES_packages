import { createHash } from "node:crypto";
import fs from "node:fs";
import files from "node:fs/promises";
import { ClientRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

export const BODY_SOURCE_MEMORY_BYTES = 1024 * 1024;
export const BODY_SOURCE_CHUNK_BYTES = 64 * 1024;
export const BODY_SOURCE_RANGE_BYTES = 64 * 1024;

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
  return value;
}

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, localRequestFailure: true, ...details });
}

function cancelled() {
  return failure("REQUEST_ABORTED", "Request body collection was cancelled", { statusCode: 499, errorType: "request_cancelled" });
}

function checkSignal(signal) {
  if (signal?.aborted) throw cancelled();
}

async function removeOwned(directory, file) {
  if (!directory) return;
  if (file) await files.unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
  await files.rmdir(directory).catch(error => { if (error.code !== "ENOENT") throw error; });
}

function stamp(stats) {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");
}

function assertUnchanged(state) {
  if (state.borrowedStamp && stamp(fs.fstatSync(state.file.fd)) !== state.borrowedStamp) {
    throw failure("BODY_SOURCE_CHANGED", "Borrowed request body file changed after it was opened");
  }
}

function dispose(state) {
  if (!state.disposal) {
    state.disposed = true;
    state.chunks = null;
    state.disposal = (async () => {
      try { await state.file?.close(); }
      finally { await removeOwned(state.directory, state.filename); }
    })();
    state.disposal.catch(() => {});
  }
  return state.disposal;
}

function dropReference(state) {
  state.references -= 1;
  if (state.references === 0) return dispose(state);
  return Promise.resolve();
}

function sourceReference(state) {
  state.references += 1;
  let released = false;
  let releasePromise;
  let bodySnapshot = null;
  const readers = new Set();
  const assertAvailable = () => {
    if (released || state.disposed) throw failure("BODY_SOURCE_RELEASED", "Request body source has been released");
  };
  const range = (start, endExclusive) => {
    integer(start, "start");
    integer(endExclusive, "endExclusive");
    if (endExclusive < start || endExclusive > state.bytes) throw new RangeError("Request body range is outside the source");
  };
  const readRangeSync = (start, endExclusive) => {
    assertAvailable();
    range(start, endExclusive);
    const length = endExclusive - start;
    if (length > BODY_SOURCE_RANGE_BYTES) throw new RangeError("Synchronous request body reads are limited to 64KiB");
    const output = Buffer.allocUnsafe(length);
    if (state.file) {
      assertUnchanged(state);
      let offset = 0;
      while (offset < length) {
        const count = fs.readSync(state.file.fd, output, offset, length - offset, start + offset);
        if (!count) throw failure("BODY_SOURCE_TRUNCATED", "Request body file ended before its recorded length");
        offset += count;
      }
      assertUnchanged(state);
    } else {
      let position = 0;
      for (const chunk of state.chunks) {
        const from = Math.max(start - position, 0);
        const to = Math.min(endExclusive - position, chunk.length);
        if (to > from) chunk.copy(output, position + from - start, from, to);
        position += chunk.length;
        if (position >= endExclusive) break;
      }
    }
    return output;
  };
  const reference = Object.freeze({
    get bytes() { return state.bytes; },
    get sha256() { return state.sha256; },
    get storage() { return state.file ? "file" : "memory"; },
    get released() { return released; },
    get body() {
      assertAvailable();
      if (state.file) return null;
      bodySnapshot ??= Buffer.concat(state.chunks, state.bytes);
      return bodySnapshot;
    },
    readRangeSync,
    async readAllBounded(limit, { signal } = {}) {
      assertAvailable();
      integer(limit, "materialization limit");
      if (state.bytes > limit) throw failure("BODY_SOURCE_MATERIALIZATION_LIMIT",
        "Request body exceeds the caller's bounded materialization limit", { bytes: state.bytes, limit });
      checkSignal(signal);
      const output = Buffer.allocUnsafe(state.bytes);
      let offset = 0;
      for await (const chunk of reference.open({ signal })) {
        chunk.copy(output, offset);
        offset += chunk.length;
      }
      if (offset !== state.bytes) throw failure("BODY_SOURCE_TRUNCATED", "Request body source ended before its recorded length");
      return output;
    },
    open({ start = 0, end = state.bytes - 1, signal } = {}) {
      assertAvailable();
      if (state.bytes === 0 && start === 0 && end === -1) end = -1;
      else integer(end, "end");
      range(start, end + 1);
      state.references += 1;
      async function* parts() {
        let position = start;
        if (state.file) {
          while (position <= end) {
            checkSignal(signal);
            assertUnchanged(state);
            const output = Buffer.allocUnsafe(Math.min(state.chunkBytes, end + 1 - position));
            const { bytesRead } = await state.file.read(output, 0, output.length, position);
            if (!bytesRead) throw failure("BODY_SOURCE_TRUNCATED", "Request body file ended before its recorded length");
            assertUnchanged(state);
            position += bytesRead;
            yield bytesRead === output.length ? output : output.subarray(0, bytesRead);
          }
        } else {
          let chunkStart = 0;
          for (const chunk of state.chunks) {
            checkSignal(signal);
            const from = Math.max(start - chunkStart, 0);
            const to = Math.min(end + 1 - chunkStart, chunk.length);
            if (to > from) yield Buffer.from(chunk.subarray(from, to));
            chunkStart += chunk.length;
            if (chunkStart > end) break;
          }
        }
      }
      let reader;
      try {
        reader = Readable.from(parts(), { objectMode: false, highWaterMark: state.chunkBytes, signal });
      } catch (error) {
        void dropReference(state);
        throw error;
      }
      readers.add(reader);
      reader.once("close", () => {
        readers.delete(reader);
        void dropReference(state);
      });
      return reader;
    },
    retain() { assertAvailable(); return sourceReference(state); },
    release() {
      if (releasePromise) return releasePromise;
      released = true;
      bodySnapshot = null;
      const closing = [...readers].map(reader => new Promise(resolve => {
        reader.once("close", resolve);
        reader.destroy();
      }));
      const dropped = dropReference(state);
      releasePromise = (async () => {
        await Promise.all(closing);
        await dropped;
        if (state.disposal) await state.disposal;
      })();
      releasePromise.catch(() => {});
      return releasePromise;
    },
  });
  return reference;
}

export async function collectBodySource(readable, {
  signal,
  directory,
  memoryThresholdBytes = BODY_SOURCE_MEMORY_BYTES,
  idleTimeoutMs = 15_000,
  chunkBytes = BODY_SOURCE_CHUNK_BYTES,
} = {}) {
  integer(memoryThresholdBytes, "memoryThresholdBytes");
  integer(chunkBytes, "chunkBytes", 1);
  integer(idleTimeoutMs, "idleTimeoutMs");
  const controller = new AbortController();
  const onAbort = () => controller.abort(cancelled());
  const destroyInput = () => readable.destroy();
  signal?.addEventListener("abort", onAbort, { once: true });
  controller.signal.addEventListener("abort", destroyInput, { once: true });
  let timer;
  let bytes = 0;
  let chunks = [];
  let tail = null;
  let tailUsed = 0;
  let ownedDirectory;
  let filename;
  let file;
  const hash = createHash("sha256");
  const write = async buffer => {
    for (let offset = 0; offset < buffer.length;) {
      checkSignal(controller.signal);
      const length = Math.min(chunkBytes, buffer.length - offset);
      const { bytesWritten } = await file.write(buffer, offset, length);
      if (!bytesWritten) throw failure("BODY_SOURCE_WRITE_FAILED", "Request body temporary file made no write progress");
      offset += bytesWritten;
    }
  };
  try {
    checkSignal(signal);
    if (readable.aborted) throw cancelled();
    const iterator = readable[Symbol.asyncIterator]();
    while (true) {
      if (idleTimeoutMs) timer = setTimeout(() => controller.abort(failure("REQUEST_BODY_IDLE_TIMEOUT",
        "Request body stopped making upload progress", { statusCode: 408, errorType: "request_timeout", encodedBytes: bytes, idleTimeoutMs })), idleTimeoutMs);
      let next;
      try { next = await iterator.next(); }
      finally { clearTimeout(timer); }
      checkSignal(controller.signal);
      if (next.done) break;
      const input = typeof next.value === "string" ? Buffer.from(next.value) : next.value;
      if (!(input instanceof Uint8Array)) throw new TypeError("Request body chunks must be bytes or strings");
      if (!input.length) continue;
      if (!Number.isSafeInteger(bytes + input.length)) throw new RangeError("Request body exceeds safe integer byte length");
      if (!file && bytes + input.length > memoryThresholdBytes) {
        const parent = await files.realpath(directory ?? os.tmpdir());
        if (!(await files.stat(parent)).isDirectory()) throw new TypeError("Request body temporary parent must be a directory");
        ownedDirectory = await files.mkdtemp(path.join(parent, "napcat-body-"));
        filename = path.join(ownedDirectory, "body");
        file = await files.open(filename, "wx+", 0o600);
        for (let index = 0; index < chunks.length; index += 1) {
          await write(chunks[index]);
          chunks[index] = null;
        }
        chunks = [];
        if (tailUsed) await write(tail.subarray(0, tailUsed));
        tail = null;
        tailUsed = 0;
      }
      for (let offset = 0; offset < input.length;) {
        checkSignal(controller.signal);
        const length = Math.min(chunkBytes, input.length - offset);
        const part = Buffer.from(input.subarray(offset, offset + length));
        hash.update(part);
        if (file) await write(part);
        else {
          let copied = 0;
          while (copied < part.length) {
            if (!tail) tail = Buffer.allocUnsafe(Math.min(chunkBytes, memoryThresholdBytes - bytes));
            const count = Math.min(part.length - copied, tail.length - tailUsed);
            part.copy(tail, tailUsed, copied, copied + count);
            tailUsed += count;
            copied += count;
            bytes += count;
            if (tailUsed === tail.length) { chunks.push(tail); tail = null; tailUsed = 0; }
          }
        }
        if (file) bytes += part.length;
        offset += length;
      }
    }
    if (file) {
      await file.sync();
      await file.close();
      file = await files.open(filename, "r");
    } else if (tailUsed) chunks.push(tail.subarray(0, tailUsed));
    checkSignal(controller.signal);
    return sourceReference({ bytes, sha256: hash.digest("hex"), chunkBytes, chunks: file ? null : chunks,
      file, directory: ownedDirectory, filename, references: 0, disposed: false });
  } catch (error) {
    const cause = controller.signal.aborted ? controller.signal.reason : error;
    readable.destroy();
    try { await file?.close(); }
    catch (cleanupError) { cause.cleanupError = cleanupError; }
    try { await removeOwned(ownedDirectory, filename); }
    catch (cleanupError) { cause.cleanupError = cleanupError; }
    throw cause;
  } finally {
    clearTimeout(timer);
    chunks = null;
    tail = null;
    signal?.removeEventListener("abort", onAbort);
    controller.signal.removeEventListener("abort", destroyInput);
  }
}

export async function fromFileBodySource(filename, { owned = false, signal, chunkBytes = BODY_SOURCE_CHUNK_BYTES } = {}) {
  if (owned !== false) throw new TypeError("Only read-only borrowed files are accepted; use collectBodySource for owned temporary files");
  integer(chunkBytes, "chunkBytes", 1);
  checkSignal(signal);
  if ((await files.lstat(filename)).isSymbolicLink()) throw new TypeError("Borrowed request body file must not be a symbolic link");
  const file = await files.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new TypeError("Borrowed request body source must be a regular file");
    const bytes = integer(stats.size, "file byte length");
    const state = { bytes, file, chunkBytes, chunks: null, references: 0, disposed: false, borrowedStamp: stamp(stats) };
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(chunkBytes);
    for (let position = 0; position < bytes;) {
      checkSignal(signal);
      const { bytesRead } = await file.read(buffer, 0, Math.min(chunkBytes, bytes - position), position);
      if (!bytesRead) throw failure("BODY_SOURCE_TRUNCATED", "Borrowed request body file was truncated");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    checkSignal(signal);
    assertUnchanged(state);
    state.sha256 = hash.digest("hex");
    return sourceReference(state);
  } catch (error) {
    await file.close();
    throw error;
  }
}

export function createSourceRequestBodyOwner(source, { retainUntilReleased = false, onRelease } = {}) {
  const reference = source.retain();
  const bytes = reference.bytes;
  const attempts = new Set();
  let submitted = false;
  let replayApproved = false;
  let released = false;
  let releasePromise;
  const release = () => {
    if (releasePromise) return releasePromise;
    released = true;
    releasePromise = (async () => {
      try { await reference.release(); }
      finally { await onRelease?.(bytes); }
    })();
    releasePromise.catch(() => {});
    return releasePromise;
  };
  return {
    get bytes() { return bytes; },
    get body() { return released ? null : reference.body; },
    get used() { return submitted; },
    get released() { return released; },
    approveReplay() {
      if (!retainUntilReleased || released || !submitted) throw new Error("Retained request body is unavailable for replay");
      replayApproved = true;
    },
    releaseUnused() {
      for (const attempt of attempts) {
        attempt.stop();
        if (!attempt.responseSeen && !attempt.upstream.destroyed && !attempt.upstream.writableFinished) attempt.upstream.destroy();
      }
      return release();
    },
    submit(upstream, onFinished) {
      if (released || (submitted && !replayApproved)) throw new Error("Request body cannot be submitted twice");
      const reader = reference.open();
      submitted = true;
      replayApproved = false;
      let stopped = false;
      let complete = false;
      let writtenBytes = 0;
      let pump;
      let headerTimer;
      let pending;
      let drainWaiter;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        clearImmediate(pump);
        clearTimeout(headerTimer);
        pending?.(false);
        pending = null;
        drainWaiter = null;
        reader.destroy();
        upstream.off("finish", onFinish);
        upstream.off("abort", stop);
        upstream.off("drain", onDrain);
        if (!retainUntilReleased) void release();
      };
      const onDrain = () => drainWaiter?.();
      const onResponse = () => { attempt.responseSeen = true; stop(); };
      const onFinish = () => {
        const notify = !stopped && complete && writtenBytes === bytes && !upstream.destroyed;
        stop();
        if (notify) onFinished?.(bytes);
      };
      const onError = () => stop();
      const onClose = () => {
        stop();
        attempts.delete(attempt);
        upstream.off("response", onResponse);
        upstream.off("error", onError);
        upstream.off("close", onClose);
      };
      const attempt = { upstream, stop, responseSeen: false };
      attempts.add(attempt);
      reader.on("error", error => {
        if (stopped) return;
        stop();
        if (!attempt.responseSeen && !upstream.destroyed) upstream.destroy(error);
      });
      upstream.prependOnceListener("response", onResponse);
      upstream.once("finish", onFinish);
      upstream.once("abort", stop);
      upstream.on("drain", onDrain);
      upstream.on("error", onError);
      upstream.once("close", onClose);
      const writeChunk = chunk => new Promise((resolve, reject) => {
        let callbackDone = false;
        let drainDone = false;
        let returned = false;
        const done = event => {
          if (event === false) { pending = null; drainWaiter = null; resolve(false); return; }
          if (event === "drain") drainDone = true;
          if (returned && callbackDone && drainDone) { pending = null; drainWaiter = null; resolve(true); }
        };
        pending = done;
        drainWaiter = () => done("drain");
        try {
          const accepted = upstream.write(chunk, error => {
            if (error) {
              done(false);
              stop();
              if (!attempt.responseSeen && !upstream.destroyed) upstream.destroy(error);
              return;
            }
            callbackDone = true;
            done();
          });
          drainDone = accepted || drainDone;
          returned = true;
          done();
        } catch (error) { pending = null; drainWaiter = null; reject(error); }
      });
      const yieldToIo = (headerWindow = false) => new Promise(resolve => {
        pending = resolve;
        const resume = () => { pump = null; headerTimer = null; pending = null; resolve(true); };
        if (headerWindow) headerTimer = setTimeout(resume, 0);
        else pump = setImmediate(resume);
      });
      const waitForConnection = () => new Promise(resolve => {
        let socket;
        const done = value => {
          pending = null;
          upstream.off("socket", onSocket);
          socket?.off("connect", connected);
          socket?.off("secureConnect", connected);
          resolve(value);
        };
        const connected = () => done(true);
        const onSocket = value => {
          socket = value;
          if (socket.destroyed) { done(false); return; }
          if (!socket.connecting && (!socket.encrypted || socket.getProtocol?.())) { done(true); return; }
          socket.once(socket.encrypted ? "secureConnect" : "connect", connected);
        };
        pending = done;
        if (upstream.socket) onSocket(upstream.socket);
        else upstream.once("socket", onSocket);
      });
      const send = async () => {
        if (upstream instanceof ClientRequest) {
          if (!await waitForConnection() || stopped || !await yieldToIo(true) || !await yieldToIo(true)) { stop(); return; }
        }
        for await (const chunk of reader) {
          if (stopped || upstream.destroyed || upstream.writableEnded) { stop(); return; }
          writtenBytes += chunk.length;
          if (writtenBytes > bytes) throw failure("BODY_SOURCE_CHANGED", "Request body source exceeded its recorded length");
          if (!await writeChunk(chunk) || stopped || !await yieldToIo()) return;
        }
        if (stopped) return;
        if (writtenBytes !== bytes) throw failure("BODY_SOURCE_TRUNCATED", "Request body source ended before its recorded length");
        complete = true;
        upstream.end();
      };
      try {
        upstream.flushHeaders?.();
        pump = setImmediate(() => {
          if (stopped || upstream.destroyed || upstream.aborted || upstream.writableEnded) { stop(); return; }
          void send().catch(error => {
            if (stopped) return;
            stop();
            if (!attempt.responseSeen && !upstream.destroyed) upstream.destroy(error);
          });
        });
      } catch (error) {
        stop();
        if (!upstream.destroyed) upstream.destroy();
        throw error;
      }
      if (upstream.destroyed || upstream.aborted) stop();
      if (upstream.closed) onClose();
    },
  };
}
