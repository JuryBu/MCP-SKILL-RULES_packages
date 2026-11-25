import { Readable } from "node:stream";
import { collectBodySource } from "./request-body-source.mjs";

const registryKey = Symbol.for("napcat.root-admission.source-registry.v1");
const registry = globalThis[registryKey] ?? Object.freeze({ payloads: new WeakMap(), projections: new WeakSet() });
if (!globalThis[registryKey]) Object.defineProperty(globalThis, registryKey, { value: registry });
const { payloads, projections } = registry;
const WINDOW_BYTES = 32 * 1024;

function documentSource(document) {
  let references = 1;
  let ownerReleased = false;
  const releaseDocument = document.release.bind(document);
  const drop = () => --references === 0 ? releaseDocument() : Promise.resolve();
  document.release = () => {
    if (ownerReleased) return Promise.resolve();
    ownerReleased = true;
    return drop();
  };
  const reference = () => {
    let released = false;
    return { readRangeSync: (start, end) => {
      if (released) throw new Error("ROOT_INPUT_RELEASED");
      return document.source.readRangeSync(start, end);
    }, retain() {
      if (released || references === 0) throw new Error("ROOT_INPUT_RELEASED");
      references++;
      return reference();
    }, release() {
      if (released) return Promise.resolve();
      released = true;
      return drop();
    } };
  };
  return reference();
}

export function rootSourcePayload(payload) { return payloads.get(payload) ?? null; }
export function isRootInputProjection(value) { return projections.has(value); }
export function rootHasInputArray(payload) { return rootSourcePayload(payload)?.input != null || Array.isArray(payload?.input); }
export function rootHasCompactionTrigger(payload) {
  return rootSourcePayload(payload)?.hasCompactionTrigger
    ?? (Array.isArray(payload?.input) && payload.input.some(item => item?.type === "compaction_trigger"));
}

function projection(parts) {
  const selected = parts.filter(part => part.count > 0);
  const result = { parts: selected, bytes: 2 + selected.reduce((total, part) => total + part.bytes, 0)
    + Math.max(0, selected.length - 1) };
  projections.add(result);
  return result;
}

export async function registerRootSourcePayload(payload, document) {
  const input = document.getNode(["input"]);
  let hasCompactionTrigger = false;
  if (input?.type === "array") {
    for await (const node of document.inputItems()) {
      if (node.type === "object" && document.smallField(node, "type") === "compaction_trigger") {
        hasCompactionTrigger = true;
        break;
      }
    }
  }
  if (document.getNode(["compaction_trigger"])) payload.compaction_trigger = true;
  const inputProjection = input?.type === "array" ? projection([{ source: documentSource(document),
    start: input.start + 1, end: input.end - 1, bytes: input.end - input.start - 2,
    retainedBytes: document.source.bytes, count: input.count }]) : null;
  payloads.set(payload, { document, input: inputProjection, hasCompactionTrigger });
  return payload;
}

export function combineRootInputs(...inputs) {
  const parts = [];
  for (const input of inputs) {
    if (isRootInputProjection(input)) parts.push(...input.parts);
    else if (Array.isArray(input)) {
      for (const item of input) {
        const body = Buffer.from(JSON.stringify(item));
        parts.push({ body, bytes: body.length, count: 1 });
      }
    } else return null;
  }
  return projection(parts);
}

export function retainRootInput(input) {
  if (!isRootInputProjection(input)) return [...input];
  return projection(input.parts.map(part => part.source ? { ...part, source: part.source.retain() } : part));
}

export function releaseRootInput(input) {
  if (!isRootInputProjection(input)) return Promise.resolve();
  return Promise.all(input.parts.map(part => part.source?.release()));
}

export function rootInputBytes(input, output) {
  if (!input) return Infinity;
  if (!isRootInputProjection(input)) return Buffer.byteLength(JSON.stringify({ input, output }));
  const sources = new Set();
  let retainedBytes = 0;
  for (const part of input.parts) {
    if (!part.source) retainedBytes += part.bytes;
    else if (!sources.has(part.source)) { sources.add(part.source); retainedBytes += part.retainedBytes; }
  }
  return Buffer.byteLength('{"input":,"output":}') + Math.max(input.bytes, retainedBytes)
    + Buffer.byteLength(JSON.stringify(output));
}

export function projectRootSourcePayload(payload, input) {
  const source = rootSourcePayload(payload);
  if (!source) throw Object.assign(new Error("ROOT_SOURCE_HISTORY_REQUIRES_HTTP"), { code: "ROOT_SOURCE_HISTORY_REQUIRES_HTTP" });
  const expanded = { ...payload, input: Object.freeze({}) };
  delete expanded.previous_response_id;
  payloads.set(expanded, { ...source, input, expanded: true });
  return expanded;
}

async function* inputChunks(input, signal) {
  yield Buffer.from("[");
  let first = true;
  for (const part of input.parts) {
    if (!first) yield Buffer.from(",");
    first = false;
    if (part.body) yield part.body;
    else {
      for (let offset = part.start; offset < part.end; offset += WINDOW_BYTES) {
        if (signal?.aborted) throw signal.reason;
        yield part.source.readRangeSync(offset, Math.min(part.end, offset + WINDOW_BYTES));
      }
    }
  }
  yield Buffer.from("]");
}

export async function composeRootSourceBody(payload, { signal, directory } = {}) {
  const source = rootSourcePayload(payload);
  if (!source?.expanded || !source.input) throw new TypeError("A projected root source payload is required");
  async function* chunks() {
    yield Buffer.from('{"input":');
    yield* inputChunks(source.input, signal);
    let pending;
    let first = true;
    for await (const chunk of source.document.originalChunks({ omitRootFields: ["input", "previous_response_id"], signal })) {
      if (first) { first = false; continue; }
      if (pending) yield pending;
      else if (chunk.toString() !== "}") yield Buffer.from(",");
      pending = chunk;
    }
    yield Buffer.from("}");
  }
  return collectBodySource(Readable.from(chunks()), { signal, directory });
}
