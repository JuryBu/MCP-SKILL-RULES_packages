import { createHmac, randomBytes } from "node:crypto";

const MAXIMUM_COUNT = Number.MAX_SAFE_INTEGER;
const DIRECTIONS = ["downstream", "upstream"];
const METHODS = [
  "initialize", "initialized", "thread/read", "thread/items/list", "thread/list", "thread/start",
  "thread/resume", "thread/unsubscribe", "turn/start", "turn/started",
  "turn/completed", "other", "unknown",
];
const RESULTS = ["success", "error_-32003", "standard_error", "other_error", "unknown"];
const UNKNOWN_REASONS = [
  "ttl", "capacity", "generationCapacity", "connectionClosed", "collectorClosed",
  "duplicate", "unsupportedId", "invalidGeneration",
];
const BYTE_BUCKETS = ["le_1KiB", "le_16KiB", "le_256KiB", "le_4MiB", "gt_4MiB", "unknown"];
const LATENCY_BUCKETS = ["le_10ms", "le_100ms", "le_1s", "le_10s", "le_60s", "gt_60s"];

function zeros(names) {
  return Object.fromEntries(names.map(name => [name, 0]));
}

function add(target, name, amount = 1) {
  target[name] = Math.min(MAXIMUM_COUNT, target[name] + amount);
}

function limit(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function own(object, name) {
  if (object === null || typeof object !== "object" || Array.isArray(object)) return undefined;
  return Object.getOwnPropertyDescriptor(object, name);
}

function valueOf(object, name) {
  return own(object, name)?.value;
}

function methodBucket(method) {
  if (typeof method !== "string") return "unknown";
  return METHODS.includes(method) ? method : "other";
}

function resultBucket(parsed) {
  if (own(parsed, "error")) {
    const code = valueOf(valueOf(parsed, "error"), "code");
    if (code === -32003) return "error_-32003";
    if ([-32700, -32600, -32601, -32602, -32603].includes(code)) return "standard_error";
    return Number.isSafeInteger(code) ? "other_error" : "unknown";
  }
  return "success";
}

export function createCodexRequestMetadata(options = {}) {
  let enabled = false;
  let closed = false;
  let maxPending = 256;
  let maxGenerations = 8;
  let ttlMs = 60000;
  let now = () => performance.now();
  let secret = null;
  const pending = new Map();
  const generations = new Map();
  const counts = zeros([
    "requests", "notifications", "responses", "unknownFrames", "invalidDirections",
    "invalidByteLengths", "invalidGenerations", "failures", "duplicates",
    "unmatchedResponses", "completed", "unknownRequests", "trackedCurrent",
    "trackedPeak", "generationAdmissions", "generationEvictions", "connectionsClosed",
    "latencyCount", "latencyTotalMs", "latencyMaxMs",
  ]);
  const frames = Object.fromEntries(DIRECTIONS.map(direction => [direction, {
    count: 0, bytes: 0, sizeBuckets: zeros(BYTE_BUCKETS),
  }]));
  const methods = Object.fromEntries(METHODS.map(method => [method, {
    ...zeros(["requests", "notifications", "completed", "unknown"]), results: zeros(RESULTS),
    requestBytes: 0, responseBytes: 0,
    requestSizeBuckets: zeros(BYTE_BUCKETS), responseSizeBuckets: zeros(BYTE_BUCKETS),
    responseBytesByResult: zeros(RESULTS),
  }]));
  const results = zeros(RESULTS);
  const unknown = zeros(UNKNOWN_REASONS);
  const latencyBuckets = zeros(LATENCY_BUCKETS);
  let lastNow = 0;

  try {
    enabled = valueOf(options, "enabled") === true;
    if (enabled) {
      maxPending = limit(valueOf(options, "maxPending"), 256, 4096);
      maxGenerations = limit(valueOf(options, "maxGenerations"), 8, 64);
      ttlMs = limit(valueOf(options, "ttlMs"), 60000, 600000);
      const suppliedNow = valueOf(options, "now");
      if (typeof suppliedNow === "function") now = suppliedNow;
      secret = randomBytes(32);
    }
  } catch {
    enabled = false;
    add(counts, "failures");
  }

  function timestamp() {
    const current = now();
    if (!Number.isFinite(current) || current < 0 || current > MAXIMUM_COUNT - ttlMs) {
      throw new RangeError("Invalid metadata clock");
    }
    lastNow = Math.max(lastNow, current);
    return lastNow;
  }

  function digest(text) {
    return createHmac("sha256", secret).update(text).digest("hex");
  }

  function generationKey(generation) {
    if (typeof generation !== "string" || generation.length === 0 || generation.length > 96
      || !/^[A-Za-z0-9_-]+$/.test(generation)) return null;
    return digest(`generation:${generation}`);
  }

  function requestKey(generation, direction, identifier) {
    if (typeof identifier === "string") {
      if (identifier.length === 0 || identifier.length > 256
        || Buffer.byteLength(identifier, "utf8") > 256) return null;
    } else if (typeof identifier !== "number" || !Number.isSafeInteger(identifier)) return null;
    return digest(`${generation}:${direction}:${typeof identifier}:${identifier}`);
  }

  function markUnknown(method, reason) {
    add(counts, "unknownRequests");
    add(methods[method], "unknown");
    add(unknown, reason);
  }

  function removePending(key, reason) {
    const entry = pending.get(key);
    if (!entry) return;
    if (!entry.ambiguous) {
      counts.trackedCurrent -= 1;
      markUnknown(entry.method, reason);
    }
    pending.delete(key);
  }

  function removeGeneration(key, reason) {
    for (const [pendingKey, entry] of pending) {
      if (entry.generation === key) removePending(pendingKey, reason);
    }
    generations.delete(key);
  }

  function expire(current) {
    for (const [key, entry] of pending) {
      if (entry.expiresAt > current) break;
      removePending(key, "ttl");
    }
    for (const [key, lastSeen] of generations) {
      if (lastSeen + ttlMs <= current) removeGeneration(key, "ttl");
    }
  }

  function admitGeneration(key, current) {
    if (!generations.has(key)) {
      if (generations.size >= maxGenerations) {
        removeGeneration(generations.keys().next().value, "generationCapacity");
        add(counts, "generationEvictions");
      }
      add(counts, "generationAdmissions");
    }
    generations.set(key, current);
  }

  function recordMethodBytes(method, kind, byteLength, result = "unknown") {
    const methodCounts = methods[method];
    const sizeBuckets = methodCounts[`${kind}SizeBuckets`];
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      add(sizeBuckets, "unknown");
      return;
    }
    add(methodCounts, `${kind}Bytes`, byteLength);
    const sizeIndex = [1024, 16384, 262144, 4194304].findIndex(bound => byteLength <= bound);
    add(sizeBuckets, BYTE_BUCKETS[sizeIndex === -1 ? 4 : sizeIndex]);
    if (kind === "response") add(methodCounts.responseBytesByResult, result, byteLength);
  }

  function observe(input) {
    if (!enabled) return;
    try {
      const current = timestamp();
      expire(current);
      const direction = valueOf(input, "direction");
      if (!DIRECTIONS.includes(direction)) {
        add(counts, "invalidDirections");
        return;
      }
      const frame = frames[direction];
      add(frame, "count");
      const byteLength = valueOf(input, "byteLength");
      if (Number.isSafeInteger(byteLength) && byteLength >= 0) {
        add(frame, "bytes", byteLength);
        const sizeIndex = [1024, 16384, 262144, 4194304].findIndex(bound => byteLength <= bound);
        add(frame.sizeBuckets, BYTE_BUCKETS[sizeIndex === -1 ? 4 : sizeIndex]);
      } else {
        add(frame.sizeBuckets, "unknown");
        if (byteLength !== undefined && byteLength !== null) add(counts, "invalidByteLengths");
      }

      const parsed = valueOf(input, "parsed");
      const methodDescriptor = own(parsed, "method");
      const identifierDescriptor = own(parsed, "id");
      const resultDescriptor = own(parsed, "result");
      const errorDescriptor = own(parsed, "error");
      const hasMethod = methodDescriptor && Object.hasOwn(methodDescriptor, "value")
        && typeof methodDescriptor.value === "string";
      const isResponse = !methodDescriptor && identifierDescriptor
        && Boolean(resultDescriptor) !== Boolean(errorDescriptor);
      if ((!hasMethod && !isResponse) || (hasMethod && (resultDescriptor || errorDescriptor))) {
        add(counts, "unknownFrames");
        return;
      }
      const method = methodBucket(methodDescriptor?.value);
      if (hasMethod && !identifierDescriptor) {
        add(counts, "notifications");
        add(methods[method], "notifications");
        return;
      }
      if (hasMethod) {
        add(counts, "requests");
        add(methods[method], "requests");
        recordMethodBytes(method, "request", byteLength);
      } else {
        add(counts, "responses");
        add(results, resultBucket(parsed));
      }

      const generation = generationKey(valueOf(input, "generation"));
      if (!generation) {
        add(counts, "invalidGenerations");
        if (hasMethod) markUnknown(method, "invalidGeneration");
        else {
          add(counts, "unmatchedResponses");
          recordMethodBytes("unknown", "response", byteLength, resultBucket(parsed));
        }
        return;
      }
      const requestDirection = hasMethod ? direction : DIRECTIONS.find(candidate => candidate !== direction);
      const key = requestKey(generation, requestDirection, identifierDescriptor?.value);
      if (!key) {
        if (hasMethod) markUnknown(method, "unsupportedId");
        else {
          add(counts, "unmatchedResponses");
          recordMethodBytes("unknown", "response", byteLength, resultBucket(parsed));
        }
        return;
      }
      if (hasMethod) {
        admitGeneration(generation, current);
        const existing = pending.get(key);
        if (existing) {
          add(counts, "duplicates");
          if (!existing.ambiguous) {
            counts.trackedCurrent -= 1;
            markUnknown(existing.method, "duplicate");
            existing.ambiguous = true;
          }
          markUnknown(method, "duplicate");
          return;
        }
        if (pending.size >= maxPending) removePending(pending.keys().next().value, "capacity");
        pending.set(key, { generation, method, startedAt: current, expiresAt: current + ttlMs, ambiguous: false });
        add(counts, "trackedCurrent");
        counts.trackedPeak = Math.max(counts.trackedPeak, counts.trackedCurrent);
        return;
      }
      const entry = pending.get(key);
      if (!entry || entry.ambiguous) {
        add(counts, "unmatchedResponses");
        recordMethodBytes("unknown", "response", byteLength, resultBucket(parsed));
        return;
      }
      pending.delete(key);
      counts.trackedCurrent -= 1;
      add(counts, "completed");
      add(methods[entry.method], "completed");
      add(methods[entry.method].results, resultBucket(parsed));
      recordMethodBytes(entry.method, "response", byteLength, resultBucket(parsed));
      const elapsed = Math.floor(current - entry.startedAt);
      const latencyIndex = [10, 100, 1000, 10000, 60000].findIndex(bound => elapsed <= bound);
      add(latencyBuckets, LATENCY_BUCKETS[latencyIndex === -1 ? 5 : latencyIndex]);
      add(counts, "latencyCount");
      add(counts, "latencyTotalMs", elapsed);
      counts.latencyMaxMs = Math.max(counts.latencyMaxMs, elapsed);
    } catch {
      add(counts, "failures");
    }
  }

  function sweep() {
    if (!enabled) return;
    try { expire(timestamp()); } catch { add(counts, "failures"); }
  }

  function closeConnection(generation) {
    if (!enabled) return;
    try {
      const key = generationKey(generation);
      if (!key) return;
      if (generations.has(key)) add(counts, "connectionsClosed");
      removeGeneration(key, "connectionClosed");
    } catch { add(counts, "failures"); }
  }

  function close() {
    if (closed) return;
    for (const key of pending.keys()) removePending(key, "collectorClosed");
    generations.clear();
    secret?.fill(0);
    secret = null;
    enabled = false;
    closed = true;
  }

  function snapshot() {
    sweep();
    return {
      schemaVersion: 1, enabled, closed,
      limits: { maxPending, maxGenerations, ttlMs, maxIdBytes: 256, maxGenerationChars: 96 },
      storage: { pendingSlots: pending.size, generationSlots: generations.size },
      counts: { ...counts },
      frames: Object.fromEntries(DIRECTIONS.map(direction => [direction, {
        count: frames[direction].count, bytes: frames[direction].bytes,
        sizeBuckets: { ...frames[direction].sizeBuckets },
      }])),
      methods: Object.fromEntries(METHODS.map(method => [method, {
        ...methods[method], results: { ...methods[method].results },
        requestSizeBuckets: { ...methods[method].requestSizeBuckets },
        responseSizeBuckets: { ...methods[method].responseSizeBuckets },
        responseBytesByResult: { ...methods[method].responseBytesByResult },
      }])),
      results: { ...results }, unknown: { ...unknown }, latencyBuckets: { ...latencyBuckets },
    };
  }

  return Object.freeze({ observe, sweep, closeConnection, close, snapshot });
}
