import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { TextDecoder } from "node:util";
import { BODY_SOURCE_CHUNK_BYTES, BODY_SOURCE_MEMORY_BYTES, collectBodySource } from "./request-body-source.mjs";

const require = createRequire(import.meta.url);
const { Receiver, WebSocket } = require("ws");
export const NATIVE_WS_BODY_SOURCE = Symbol("native-ws-body-source");
export const NATIVE_WS_BODY_SOURCE_VERSION = "8.21.1";
const attached = new WeakMap();
const sending = new WeakSet();
const GET_INFO = 0;
const GET_DATA = 4;
const ASYNC_DATA = 5;

export function createNativeBodySourceWebSocketClass(options = {}) {
  return class NativeBodySourceWebSocket extends WebSocket {
    setSocket(socket, head, socketOptions) {
      socket.pause();
      try {
        super.setSocket(socket, Buffer.alloc(0), socketOptions);
        attachNativeWsBodySource(this, options);
        if (head.length) socket.unshift(head);
        if (!this.isPaused) socket.resume();
      } catch (error) { socket.destroy(); throw error; }
    }
  };
}

export async function sendSource(peer, source, { signal, binary = false, chunkBytes = BODY_SOURCE_CHUNK_BYTES } = {}) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > BODY_SOURCE_CHUNK_BYTES) {
    throw new RangeError("Native source send chunks must be between one byte and 64KiB");
  }
  if (peer.readyState !== 1 || sending.has(peer) || peer._sender?._firstFragment === false) {
    throw new Error("Native source sender requires an idle, open WebSocket");
  }
  const reference = source.retain();
  sending.add(peer);
  let bytes = 0;
  let frames = 0;
  let peakBufferedAmount = 0;
  let started = false;
  const cancelled = () => Object.assign(new Error("Native source send cancelled"), { code: "REQUEST_ABORTED" });
  const onAbort = () => { if (started) peer.terminate(); };
  signal?.addEventListener("abort", onAbort, { once: true });
  const send = (data, fin) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      peer.off("close", onClose);
      peer.off("error", finish);
      signal?.removeEventListener("abort", onCancelled);
      error ? reject(error) : resolve();
    };
    const onClose = () => finish(new Error("Native source socket closed during send"));
    const onCancelled = () => finish(cancelled());
    peer.once("close", onClose);
    peer.once("error", finish);
    signal?.addEventListener("abort", onCancelled, { once: true });
    started = true;
    try {
      peer.send(data, { binary, fin }, finish);
      peakBufferedAmount = Math.max(peakBufferedAmount, peer.bufferedAmount);
      frames += 1;
    } catch (error) { finish(error); }
  });
  try {
    if (signal?.aborted) throw cancelled();
    for await (const chunk of reference.open({ signal })) {
      for (let offset = 0; offset < chunk.length; offset += chunkBytes) {
        const part = chunk.subarray(offset, Math.min(offset + chunkBytes, chunk.length));
        bytes += part.length;
        await send(part, bytes === reference.bytes);
      }
    }
    if (bytes !== reference.bytes) throw new Error("Native source changed length during send");
    if (bytes === 0) await send(Buffer.alloc(0), true);
    return Object.freeze({ bytes, frames, peakBufferedAmount });
  } catch (error) {
    if (started) peer.terminate();
    throw signal?.aborted ? cancelled() : error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    sending.delete(peer);
    await reference.release();
  }
}

export function attachNativeWsBodySource(peer, {
  signal,
  directory,
  memoryThresholdBytes = BODY_SOURCE_MEMORY_BYTES,
  chunkBytes = BODY_SOURCE_CHUNK_BYTES,
  idleTimeoutMs = 15_000,
} = {}) {
  if (attached.has(peer)) return attached.get(peer);
  if (require("ws/package.json").version !== NATIVE_WS_BODY_SOURCE_VERSION) {
    throw new Error(`Native body receiver requires ws ${NATIVE_WS_BODY_SOURCE_VERSION}`);
  }
  const receiver = peer?._receiver;
  if (!(receiver instanceof Receiver) || !peer._isServer || peer.readyState !== 1
      || receiver._state !== GET_INFO || receiver._bufferedBytes !== 0
      || receiver._writableState.length !== 0 || receiver._fragmented !== 0
      || Object.keys(receiver._extensions).length !== 0) {
    throw new Error("Native body receiver requires a fresh, uncompressed server connection");
  }
  const methodArities = { getInfo: 1, getPayloadLength16: 1, getPayloadLength64: 1, haveLength: 1,
    getData: 1, startLoop: 1, controlMessage: 2, createError: 5, consume: 1, getMask: 0 };
  if (Object.getPrototypeOf(receiver) !== Receiver.prototype || !Array.isArray(receiver._buffers)
      || !Array.isArray(receiver._fragments) || receiver._buffers.length || receiver._fragments.length
      || receiver._isServer !== true || receiver._loop !== false || receiver._errored !== false) {
    throw new Error("Unsupported ws receiver state shape");
  }
  for (const [method, arity] of Object.entries(methodArities)) {
    if (typeof receiver[method] !== "function" || receiver[method] !== Receiver.prototype[method] || receiver[method].length !== arity) {
      throw new Error(`Unsupported ws receiver method shape: ${method}`);
    }
  }
  if (!Number.isSafeInteger(memoryThresholdBytes) || memoryThresholdBytes < 0 || memoryThresholdBytes > BODY_SOURCE_MEMORY_BYTES) {
    throw new RangeError("Native body memory threshold must be between zero and 1MiB");
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > BODY_SOURCE_CHUNK_BYTES) {
    throw new RangeError("Native body chunk size must be between one byte and 64KiB");
  }
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 0) throw new RangeError("Native body idle timeout must be a non-negative safe integer");
  const original = Object.fromEntries(["getInfo", "getPayloadLength16", "getPayloadLength64", "getData", "_destroy"]
    .map(method => [method, receiver[method]]));
  let message;
  let stopped = false;
  let concluded = false;
  let lengthEncoding = 0;
  let frameOffset = 0;
  let receivedBytes = 0;
  let completedMessages = 0;
  let largestChunkBytes = 0;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const ownedSources = new Set();

  const errorFor = (cause, status = 1011) => {
    if (cause?.code?.startsWith("WS_ERR_")) return cause;
    const error = receiver.createError(Error, cause?.message ?? String(cause), false, status,
      status === 1007 ? "WS_ERR_INVALID_UTF8" : status === 1002 ? "WS_ERR_INVALID_FRAME" : "WS_ERR_BODY_SOURCE");
    error.cause = cause;
    return error;
  };
  const stop = () => {
    stopped = true;
    message?.controller.abort();
    message?.input.destroy();
  };
  const cleanup = async () => {
    stop();
    const pending = message;
    if (pending) {
      const source = await pending.result.catch(() => null);
      if (source) await source.release();
    }
    await Promise.all([...ownedSources].map(source => source.release()));
    ownedSources.clear();
  };
  const begin = () => {
    const controller = new AbortController();
    const input = new PassThrough({ highWaterMark: chunkBytes });
    const current = {
      input, controller, binary: receiver._opcode === 2,
      decoder: receiver._opcode === 1 && !receiver._skipUTF8Validation ? new TextDecoder("utf-8", { fatal: true }) : null,
      result: collectBodySource(input, { signal: controller.signal, directory, memoryThresholdBytes, chunkBytes, idleTimeoutMs }),
    };
    current.result.catch(error => {
      if (!stopped && message === current) receiver.destroy(errorFor(error));
    });
    message = current;
    return current;
  };
  const writeChunk = (current, data) => new Promise((resolve, reject) => {
    current.input.write(data, error => error ? reject(error) : resolve());
  });
  const publish = async current => {
    try { current.decoder?.decode(); }
    catch (error) { throw errorFor(error, 1007); }
    current.input.end();
    const source = await current.result;
    ownedSources.add(source);
    try {
      if (!receiver._allowSynchronousEvents) await new Promise(resolve => setImmediate(resolve));
      if (stopped || peer.readyState !== 1) return;
      completedMessages += 1;
      if (source.storage === "memory") {
        let data = source.body;
        if (current.binary) {
          if (receiver._binaryType === "arraybuffer") data = data.buffer.slice(data.byteOffset, data.byteOffset + data.length);
          else if (receiver._binaryType === "blob") data = new Blob([data]);
          else if (receiver._binaryType === "fragments") data = data.length ? [data] : [];
        }
        receiver.emit("message", data, current.binary);
      } else {
        if (peer.listenerCount(NATIVE_WS_BODY_SOURCE) === 0) throw new Error("Native body source has no consumer");
        peer.emit(NATIVE_WS_BODY_SOURCE, source, current.binary);
      }
    } finally {
      ownedSources.delete(source);
      await source.release();
    }
  };

  receiver.getInfo = function(callback) {
    lengthEncoding = 0;
    return original.getInfo.call(this, callback);
  };
  receiver.getPayloadLength16 = function(callback) {
    lengthEncoding = 16;
    return original.getPayloadLength16.call(this, callback);
  };
  receiver.getPayloadLength64 = function(callback) {
    lengthEncoding = 64;
    return original.getPayloadLength64.call(this, callback);
  };
  receiver.haveLength = function(callback) {
    if ((lengthEncoding === 16 && this._payloadLength < 126) || (lengthEncoding === 64 && this._payloadLength < 65536)) {
      callback(errorFor(new Error("Non-minimal WebSocket payload length"), 1002));
      return;
    }
    if (this._opcode < 8) {
      if (!Number.isSafeInteger(this._totalPayloadLength + this._payloadLength)) {
        callback(errorFor(new Error("WebSocket message length exceeds safe integer range"), 1002));
        return;
      }
      this._totalPayloadLength += this._payloadLength;
      if (this._totalPayloadLength <= memoryThresholdBytes && this._maxPayload > 0 && this._totalPayloadLength > this._maxPayload) {
        callback(this.createError(RangeError, "Max payload size exceeded", false, 1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"));
        return;
      }
      this._numFragments += 1;
      if (this._maxFragments > 0 && this._numFragments > this._maxFragments) {
        callback(this.createError(RangeError, "Too many message fragments", false, 1008, "WS_ERR_TOO_MANY_BUFFERED_PARTS"));
        return;
      }
      frameOffset = 0;
    }
    this._state = this._masked ? 3 : GET_DATA;
  };
  receiver.getData = function(callback) {
    if (this._opcode > 7) return original.getData.call(this, callback);
    if (this._payloadLength > 0 && this._bufferedBytes === 0) {
      this._loop = false;
      return;
    }
    this._state = ASYNC_DATA;
    const current = message ?? begin();
    (async () => {
      await Promise.resolve();
      while (this._payloadLength > 0 && this._bufferedBytes > 0) {
        if (stopped) throw new Error("Native body reception stopped");
        const length = Math.min(this._payloadLength, this._bufferedBytes, chunkBytes);
        const data = this.consume(length);
        for (let index = 0; index < length; index += 1) data[index] ^= this._mask[(frameOffset + index) & 3];
        frameOffset += length;
        this._payloadLength -= length;
        largestChunkBytes = Math.max(largestChunkBytes, length);
        try { current.decoder?.decode(data, { stream: true }); }
        catch (error) { throw errorFor(error, 1007); }
        await writeChunk(current, data);
        receivedBytes += length;
      }
      if (this._payloadLength > 0) this._state = GET_DATA;
      else {
        this._numFragments = Math.max(0, this._numFragments - 1);
        if (this._fin) {
          await publish(current);
          message = undefined;
          this._totalPayloadLength = 0;
          this._messageLength = 0;
          this._fragmented = 0;
          this._numFragments = 0;
        }
        this._state = GET_INFO;
      }
      if (stopped && !concluded) callback(errorFor(new Error("Native body reception stopped")));
      else this.startLoop(callback);
    })().catch(error => {
      stop();
      callback(errorFor(error));
    });
  };
  receiver._final = function(callback) {
    const truncated = !concluded && (message || this._state !== GET_INFO || this._bufferedBytes !== 0);
    cleanup().then(() => callback(truncated ? errorFor(new Error("Truncated WebSocket message"), 1002) : undefined),
      error => callback(errorFor(error)));
  };
  receiver._destroy = function(error, callback) {
    cleanup().then(() => original._destroy.call(this, error, callback),
      cleanupError => original._destroy.call(this, error ?? errorFor(cleanupError), callback));
  };
  receiver.once("conclude", () => { concluded = true; stop(); });
  receiver.once("error", stop);
  const onSocketClose = () => { void cleanup().catch(() => {}); };
  peer._socket.once("close", onSocketClose);
  const onAbort = () => {
    stop();
    peer.terminate();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  peer.once("close", () => {
    signal?.removeEventListener("abort", onAbort);
    peer._socket.off("close", onSocketClose);
    cleanup().then(() => resolveClosed(), error => resolveClosed(error));
  });
  const handle = Object.freeze({
    closed,
    abort: onAbort,
    status: () => Object.freeze({ receivedBytes, completedMessages, largestChunkBytes, stopped,
      collecting: Boolean(message), bufferedBytes: receiver._bufferedBytes,
      writableBytes: receiver.writableLength, ownedSources: ownedSources.size }),
  });
  attached.set(peer, handle);
  if (signal?.aborted) onAbort();
  return handle;
}
