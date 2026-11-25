import crypto from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { jsonRequestChunks } from "./request-body-buffer.mjs";
import { normalizeInputItemMetadataForComparison } from "./model-input-comparison.mjs";

async function digest(value, signal) {
  const hash = crypto.createHash("sha256");
  let workBytes = 0;
  for (const chunk of jsonRequestChunks(value)) {
    if (signal?.aborted) throw signal.reason;
    hash.update(chunk);
    workBytes += chunk.length;
    if (workBytes >= 1024 * 1024) { await yieldTurn(); workBytes = 0; }
  }
  return hash.digest("hex");
}

function configuration(payload) {
  const result = { ...payload };
  for (const name of ["input", "previous_response_id", "client_metadata", "type", "generate"]) delete result[name];
  return result;
}

async function prefix(payload, length, signal) {
  const hash = crypto.createHash("sha256");
  for (let index = 0; index < length; index += 1) {
    hash.update(await digest(normalizeInputItemMetadataForComparison(payload.input[index]), signal));
  }
  return hash.digest("hex");
}

export function createWebSocketCapacityMemory({ maxEntries = 2048 } = {}) {
  const entries = new Map();
  return {
    async remember(key, payload, { signal } = {}) {
      if (!key || !Array.isArray(payload?.input)) return;
      const config = await digest(configuration(payload), signal);
      const input = await prefix(payload, payload.input.length, signal);
      entries.delete(key);
      entries.set(key, { config, input, length: payload.input.length });
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    async blocked(key, payload, { signal } = {}) {
      const entry = entries.get(key);
      if (!entry || !Array.isArray(payload?.input)) return false;
      if (payload.input.length >= entry.length && await digest(configuration(payload), signal) === entry.config
        && await prefix(payload, entry.length, signal) === entry.input) return true;
      entries.delete(key);
      return false;
    },
    clear(key) { entries.delete(key); },
  };
}
