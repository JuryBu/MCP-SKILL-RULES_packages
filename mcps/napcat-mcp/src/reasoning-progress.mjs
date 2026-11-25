import { createHash } from 'node:crypto';

export const DEFAULT_RESPONSES_SESSION_BYTES = 16 * 1024 * 1024;

export function createReasoningProgressBudget(maxBytes = DEFAULT_RESPONSES_SESSION_BYTES) {
  let retainedBytes = 0;
  const exceeded = () => Object.assign(new Error('Reasoning progress reached the existing request memory budget'),
    { code: 'NATIVE_WS_REASONING_PROGRESS_LIMIT', retainedBytes, maxBytes });
  return {
    get retainedBytes() { return retainedBytes; },
    setLimit(value) {
      if (Number.isSafeInteger(value) && value > 0) maxBytes = value;
      if (retainedBytes > maxBytes) throw exceeded();
    },
    reserve(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes - retainedBytes) throw exceeded();
      retainedBytes += bytes;
    },
    release(bytes) { retainedBytes = Math.max(0, retainedBytes - bytes); },
  };
}

export function createReasoningProgressTracker() {
  const completedIds = new Set();
  return event => {
    const item = event?.item;
    if (event?.type !== 'response.output_item.done' || item?.type !== 'reasoning'
      || typeof item.id !== 'string' || !item.id || completedIds.has(item.id)
      || typeof item.encrypted_content !== 'string' || !item.encrypted_content.trim()) return false;
    completedIds.add(item.id);
    return true;
  };
}

export function isNativeReasoningProgressEvent(event) {
  if (!event || event.item !== undefined && event.item?.type !== 'reasoning') return false;
  if (event.response?.output !== undefined && (!Array.isArray(event.response.output)
    || event.response.output.some(item => item?.type !== 'reasoning'))) return false;
  if (['response.output_item.added', 'response.output_item.done'].includes(event.type)) return event.item?.type === 'reasoning';
  return /^response\.(?:reasoning_text|reasoning_summary_text)\.(?:delta|done)$/.test(event.type)
    || /^response\.reasoning_summary_part\.(?:added|done)$/.test(event.type);
}

export function createNativeReasoningProgressForwarder({ maxBytes = DEFAULT_RESPONSES_SESSION_BYTES } = {}) {
  const budget = createReasoningProgressBudget(maxBytes);
  let retainedBytes = 0;
  let attemptBytes = 0;
  const reserve = (bytes, transient = false) => {
    budget.reserve(bytes);
    retainedBytes += bytes;
    if (transient) attemptBytes += bytes;
  };
  const stringBytes = value => typeof value === 'string' ? value.length * 2 : 0;
  const items = new Map();
  const indicesById = new Map();
  let attemptIndices = new Map();
  let attemptOffsets = new Map();
  let attemptEvents = new Map();
  let attemptNumber = 0;
  let nextOutputIndex = 0;
  const conflict = () => Object.assign(new Error('Reasoning replay differs from delivered progress'),
    { code: 'NATIVE_WS_REASONING_REPLAY_CONFLICT' });
  const fingerprint = value => createHash('sha256').update(JSON.stringify(value, (_key, nested) =>
    nested && typeof nested === 'object' && !Array.isArray(nested)
      ? Object.fromEntries(Object.keys(nested).sort().map(key => [key, nested[key]])) : nested)).digest('hex');
  return {
    budget,
    clear() {
      budget.release(retainedBytes);
      retainedBytes = 0;
      attemptBytes = 0;
      items.clear();
      indicesById.clear();
      attemptIndices.clear();
      attemptOffsets.clear();
      attemptEvents.clear();
    },
    beginAttempt() {
      budget.release(attemptBytes);
      retainedBytes -= attemptBytes;
      attemptBytes = 0;
      attemptNumber += 1;
      attemptIndices = new Map();
      attemptOffsets = new Map();
      attemptEvents = new Map();
    },
    forward(raw) {
      if (['output_index', 'content_index'].some(key => raw[key] !== undefined
        && (!Number.isSafeInteger(raw[key]) || raw[key] < 0 || raw[key] > 65535))) return raw;
      const reasoning = isNativeReasoningProgressEvent(raw);
      if (reasoning && Number.isSafeInteger(raw.sequence_number) && raw.sequence_number >= 0) {
        const identity = JSON.stringify([raw.response?.id ?? raw.response_id ?? null, raw.sequence_number]);
        const content = fingerprint(raw);
        if (attemptEvents.has(identity)) {
          if (attemptEvents.get(identity) !== content) throw conflict();
          return null;
        }
        reserve(64 + stringBytes(identity) + stringBytes(content), true);
        attemptEvents.set(identity, content);
      }
      const upstreamIndex = raw.output_index;
      const knownIndex = attemptIndices.get(upstreamIndex);
      const itemId = raw.item?.id ?? raw.item_id ?? knownIndex?.id;
      let event = raw;
      if (Number.isSafeInteger(upstreamIndex) && upstreamIndex >= 0) {
        let index = typeof itemId === 'string' ? indicesById.get(itemId) : knownIndex?.index;
        if (knownIndex && typeof itemId === 'string' && knownIndex.id && knownIndex.id !== itemId) throw conflict();
        if (index === undefined) index = attemptNumber <= 1 ? upstreamIndex : nextOutputIndex;
        nextOutputIndex = Math.max(nextOutputIndex, index + 1);
        if (typeof itemId === 'string' && itemId) {
          if (!indicesById.has(itemId)) reserve(64 + stringBytes(itemId));
          indicesById.set(itemId, index);
        }
        if (!attemptIndices.has(upstreamIndex)) reserve(80 + stringBytes(itemId), true);
        attemptIndices.set(upstreamIndex, { id: itemId, index });
        if (index !== upstreamIndex) event = { ...event, output_index: index };
      }
      if (!reasoning) return event;
      if (typeof itemId !== 'string' || !itemId) {
        if (attemptNumber > 1) throw conflict();
        return event;
      }
      let item = items.get(itemId);
      if (!item) {
        reserve(512 + stringBytes(itemId) * 4);
        item = { events: new Map(), text: new Map(), textBytes: 0, completed: false };
        items.set(itemId, item);
      }
      const key = JSON.stringify([event.type, event.summary_index ?? 0, event.content_index ?? 0]);
      const completedEvent = event.type.endsWith('.done');
      const eventFingerprint = completedEvent ? fingerprint({ type: event.type, item: event.item, text: event.text, part: event.part }) : null;
      if (completedEvent && item.events.has(key) && item.events.get(key) !== eventFingerprint) throw conflict();
      if (item.completed) {
        if (event.type === 'response.output_item.done' && item.completed !== fingerprint(event.item)) throw conflict();
        return null;
      }
      const lane = JSON.stringify([event.type.replace(/\.(?:delta|done)$/, ''), event.summary_index ?? 0, event.content_index ?? 0]);
      if (/\.(?:reasoning_text|reasoning_summary_text)\.delta$/.test(event.type) && typeof event.delta === 'string') {
        const key = JSON.stringify([itemId, lane]);
        const offset = attemptOffsets.get(key) ?? 0;
        const previous = item.text.get(lane) ?? '';
        const overlap = Math.min(event.delta.length, Math.max(0, previous.length - offset));
        if (previous.slice(offset, offset + overlap) !== event.delta.slice(0, overlap)) throw conflict();
        if (!attemptOffsets.has(key)) reserve(72 + stringBytes(key), true);
        attemptOffsets.set(key, offset + event.delta.length);
        if (overlap === event.delta.length) return null;
        const delta = event.delta.slice(overlap);
        const bytes = stringBytes(delta) + (item.text.has(lane) ? 0 : 64 + stringBytes(lane));
        reserve(bytes);
        item.textBytes += bytes;
        item.text.set(lane, previous + delta);
        return delta === event.delta ? event : { ...event, delta };
      }
      if (/\.(?:reasoning_text|reasoning_summary_text)\.done$/.test(event.type) && typeof event.text === 'string') {
        const previous = item.text.get(lane) ?? '';
        if (!event.text.startsWith(previous) || item.events.has(key) && event.text !== previous) throw conflict();
        const bytes = stringBytes(event.text) - stringBytes(previous) + (item.text.has(lane) ? 0 : 64 + stringBytes(lane));
        reserve(bytes);
        item.textBytes += bytes;
        item.text.set(lane, event.text);
      }
      if (event.type === 'response.reasoning_summary_part.done' && typeof event.part?.text === 'string') {
        const textLane = JSON.stringify(['response.reasoning_summary_text', event.summary_index ?? 0, event.content_index ?? 0]);
        const previous = item.text.get(textLane) ?? '';
        if (!event.part.text.startsWith(previous)) throw conflict();
        const bytes = stringBytes(event.part.text) - stringBytes(previous) + (item.text.has(textLane) ? 0 : 64 + stringBytes(textLane));
        reserve(bytes);
        item.textBytes += bytes;
        item.text.set(textLane, event.part.text);
      }
      if (item.events.has(key)) return null;
      reserve(64 + stringBytes(key) + stringBytes(eventFingerprint));
      item.events.set(key, eventFingerprint);
      if (event.type === 'response.output_item.done') {
        item.completed = fingerprint(event.item);
        budget.release(item.textBytes);
        retainedBytes -= item.textBytes;
        item.textBytes = 0;
        item.text.clear();
      }
      return event;
    },
  };
}
