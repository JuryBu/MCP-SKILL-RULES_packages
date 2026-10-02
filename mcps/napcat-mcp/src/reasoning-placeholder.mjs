import { createHash } from "node:crypto";

const REQUEST_METHODS = new Set([
  "thread/read", "thread/resume", "thread/start", "thread/fork",
  "thread/turns/list", "thread/items/list", "turn/start",
]);
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "interrupted"]);

function textPresent(value) {
  if (typeof value === "string") return value.trim().length > 0;
  return Array.isArray(value) && value.some(part => typeof part === "string" && part.trim().length > 0);
}

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function scopeKey(threadId, turnId) {
  return validId(threadId) && validId(turnId)
    ? JSON.stringify([threadId, turnId]) : null;
}

export function createReasoningPlaceholderView(options = {}) {
  const allowedClients = new Set(options.clientNames ?? ["Codex Desktop"]);
  const maximumTurns = options.maximumTurns ?? 128;
  const maximumItems = options.maximumItems ?? 512;
  const maximumRequests = options.maximumRequests ?? 128;
  const maximumRetainedBytes = options.maximumRetainedBytes ?? 1024 * 1024;
  const turnHistory = Buffer.alloc(Math.min(8192, Math.floor(maximumRetainedBytes / 8)));
  const turns = new Map();
  const requests = new Map();
  let clientName = null;
  let enabled = false;
  let projectedItems = 0;
  let retainedBytes = turnHistory.length;
  let trackingAvailable = true;
  let disabledReason = null;
  let evictedTurns = 0;
  let requireKnownTurn = false;
  let capacityBypasses = 0;
  let lastCapacity = null;

  function historyPositions(key) {
    if (turnHistory.length === 0) return [];
    const hash = createHash("sha256").update(key).digest();
    return [0, 4, 8, 12].map(offset => hash.readUInt32LE(offset) % (turnHistory.length * 8));
  }

  function rememberUnavailableTurn(key) {
    for (const position of historyPositions(key)) turnHistory[position >>> 3] |= 1 << (position & 7);
  }

  function unavailableTurn(key) {
    const positions = historyPositions(key);
    return positions.length === 0 || positions.every(position => turnHistory[position >>> 3] & (1 << (position & 7)));
  }

  function disable(reason) {
    trackingAvailable = false;
    disabledReason = reason;
    return false;
  }

  function recordCapacity(reason, scope = null) {
    capacityBypasses += 1;
    lastCapacity = { reason, scope };
  }

  function suspendTurn(state, key, reason) {
    if (state.suspended) return;
    recordCapacity(reason, key);
    state.suspended = reason;
    retainedBytes -= state.bytes - state.baseBytes;
    state.bytes = state.baseBytes;
    state.items.clear();
  }

  function releaseInactiveTurn(protectedKey = null) {
    for (const [key, state] of turns) {
      if (key === protectedKey || state.active) continue;
      rememberUnavailableTurn(key);
      turns.delete(key);
      retainedBytes -= state.bytes;
      evictedTurns += 1;
      requireKnownTurn = true;
      return true;
    }
    return false;
  }

  function reserve(bytes, protectedKey = null) {
    while (retainedBytes + bytes > maximumRetainedBytes && releaseInactiveTurn(protectedKey)) {}
    if (retainedBytes + bytes > maximumRetainedBytes) return false;
    retainedBytes += bytes;
    return true;
  }

  function turnState(threadId, turnId, prefixKnown = false, allowNewTurn = false, active = false, confirmedFresh = false) {
    const key = scopeKey(threadId, turnId);
    if (!key || !trackingAvailable) return null;
    if (!turns.has(key)) {
      if (!confirmedFresh && unavailableTurn(key)) return null;
      if (requireKnownTurn && !allowNewTurn) return null;
      while (turns.size >= maximumTurns && releaseInactiveTurn()) {}
      if (turns.size >= maximumTurns) {
        recordCapacity("active_turns_capacity", key);
        rememberUnavailableTurn(key);
        requireKnownTurn = true;
        return null;
      }
      const bytes = Buffer.byteLength(key) + 128;
      if (!reserve(bytes)) {
        recordCapacity("retained_bytes_capacity", key);
        rememberUnavailableTurn(key);
        requireKnownTurn = true;
        return null;
      }
      turns.set(key, { items: new Map(), prefixKnown, bytes, baseBytes: bytes, completed: false, active, suspended: null });
    }
    const state = turns.get(key);
    if (active && !state.completed) state.active = true;
    return state;
  }

  function completeTurn(threadId, turnId) {
    for (const request of requests.values()) {
      if (request.method === "turn/start" && request.params.threadId === threadId) request.observedTerminal = true;
    }
    const key = scopeKey(threadId, turnId);
    const state = turns.get(key);
    if (!state) return;
    state.completed = true;
    state.active = false;
    turns.delete(key);
    turns.set(key, state);
  }

  function refreshIndexes(state) {
    let consecutiveEmpty = 0;
    let numberingKnown = state.prefixKnown;
    for (const record of state.items.values()) {
      record.index = null;
      if (!record.ordered) continue;
      if (record.visible) { consecutiveEmpty = 0; numberingKnown = true; }
      else if (!record.shapeKnown) numberingKnown = false;
      else if (numberingKnown) record.index = ++consecutiveEmpty;
    }
  }

  function observeItem(threadId, turnId, item, prefixKnown = false, ordered = true, live = false) {
    if (item?.type !== "reasoning") return null;
    for (const request of requests.values()) {
      if (request.method === "turn/start" && request.params.threadId === threadId) request.observedReasoning = true;
    }
    if (!validId(item.id)) { disable("invalid_item_id"); return null; }
    const state = turnState(threadId, turnId, prefixKnown, false, live);
    if (!state || state.suspended) return null;
    if (!state.items.has(item.id)) {
      const key = scopeKey(threadId, turnId);
      if (state.items.size >= maximumItems) { suspendTurn(state, key, "items_capacity"); return null; }
      const bytes = Buffer.byteLength(item.id) + 128;
      if (!reserve(bytes, key)) { suspendTurn(state, key, "retained_bytes_capacity"); return null; }
      state.bytes += bytes;
      state.items.set(item.id, { index: null, ordered, shapeKnown: false, visible: false, completed: false });
    }
    const record = state.items.get(item.id);
    if (ordered && !record.ordered) {
      state.items.delete(item.id);
      state.items.set(item.id, record);
      record.ordered = true;
    }
    if (Object.hasOwn(item, "summary") || Object.hasOwn(item, "content")) {
      record.shapeKnown = Array.isArray(item.summary) && Array.isArray(item.content)
        && item.summary.every(part => typeof part === "string") && item.content.every(part => typeof part === "string");
    }
    if (textPresent(item.summary) || textPresent(item.content)) record.visible = true;
    refreshIndexes(state);
    return record;
  }

  function projectItem(threadId, turnId, item, prefixKnown = false, completed = true, ordered = true, live = false) {
    if (!Array.isArray(item?.summary) || !Array.isArray(item?.content)
      || item.summary.some(part => typeof part !== "string") || item.content.some(part => typeof part !== "string")) {
      observeItem(threadId, turnId, item, prefixKnown, ordered, live);
      return item;
    }
    const record = observeItem(threadId, turnId, item, prefixKnown, ordered, live);
    if (!record) return item;
    if (completed) record.completed = true;
    if (!record.completed || record.visible || textPresent(item.summary) || textPresent(item.content)) return item;
    const label = !ordered || record.index === null ? "推理片段" : `推理片段${record.index}`;
    projectedItems += 1;
    return { ...item, summary: [`${label}已收到，摘要为空`] };
  }

  function projectTurn(threadId, turn) {
    const previousCount = projectedItems;
    if (!turn || !Array.isArray(turn.items)) {
      if (TERMINAL_TURN_STATUSES.has(turn?.status)) completeTurn(threadId, turn.id);
      return turn;
    }
    const prefixKnown = turn.itemsView === "full";
    const completed = turn.status === "completed";
    const terminal = TERMINAL_TURN_STATUSES.has(turn.status);
    if (prefixKnown) {
      const state = turnState(threadId, turn.id, true, false, turn.status === "inProgress");
      if (state && !state.suspended) {
        const orderedItems = new Map();
        for (const item of turn.items) {
          const record = observeItem(threadId, turn.id, item, false, false);
          if (record) { record.ordered = true; orderedItems.set(item.id, record); }
        }
        for (const [itemId, record] of state.items) {
          if (!orderedItems.has(itemId)) { record.ordered = false; orderedItems.set(itemId, record); }
        }
        if (!state.suspended) {
          state.items = orderedItems;
          state.prefixKnown = true;
          refreshIndexes(state);
        }
      }
    }
    const items = turn.items.map(item => projectItem(threadId, turn.id, item, prefixKnown, completed, prefixKnown));
    if (terminal) completeTurn(threadId, turn.id);
    if (turns.get(scopeKey(threadId, turn.id))?.suspended) {
      projectedItems = previousCount;
      return turn;
    }
    return items.some((item, index) => item !== turn.items[index]) ? { ...turn, items } : turn;
  }

  function projectThread(thread) {
    if (!thread || !Array.isArray(thread.turns)) return thread;
    const mappedTurns = thread.turns.map(turn => projectTurn(thread.id, turn));
    return mappedTurns.some((turn, index) => turn !== thread.turns[index]) ? { ...thread, turns: mappedTurns } : thread;
  }

  function observeRequest(message) {
    if (message?.method === "initialize") {
      clientName = validId(message.params?.clientInfo?.name) ? message.params.clientInfo.name : null;
      enabled = options.enabled !== false && allowedClients.has(clientName);
      requests.clear();
      turns.clear();
      turnHistory.fill(0);
      retainedBytes = turnHistory.length;
      trackingAvailable = true;
      disabledReason = null;
      evictedTurns = 0;
      requireKnownTurn = false;
      capacityBypasses = 0;
      lastCapacity = null;
    }
    if (!enabled || !trackingAvailable || !REQUEST_METHODS.has(message?.method) || !Object.hasOwn(message, "id")) return;
    if (!validId(message.id) && !Number.isFinite(message.id)) return;
    const originalParams = message.params ?? {};
    if (!validId(originalParams.threadId)) return;
    const params = { threadId: originalParams.threadId, hasCursor: Boolean(originalParams.cursor),
      descending: originalParams.sortDirection === "desc" };
    const previous = requests.get(message.id);
    if (previous) {
      previous.ambiguous = true;
      previous.pendingResponses = (previous.pendingResponses ?? 1) + 1;
      return;
    }
    if (requests.size >= maximumRequests) { recordCapacity("requests_capacity"); return; }
    const bytes = Buffer.byteLength(JSON.stringify([message.id, message.method, params])) + 128;
    if (!reserve(bytes)) { recordCapacity("retained_bytes_capacity"); return; }
    requests.set(message.id, { method: message.method, params, bytes });
  }

  function projectResponse(message, request) {
    if (message.error || !message.result || typeof message.result !== "object") return message;
    const result = message.result;
    if (request.method === "turn/start") {
      if (result.turn?.status === "inProgress" && Array.isArray(result.turn.items) && result.turn.items.length === 0
        && !request.observedReasoning && !request.observedTerminal) {
        turnState(request.params.threadId, result.turn.id, true, true, true, true);
      }
      return message;
    }
    if (request.method === "thread/items/list" && Array.isArray(result.data)) {
      const prefixKnown = !request.params.hasCursor && !request.params.descending;
      const groups = new Map();
      for (const entry of result.data) {
        if (!validId(entry?.turnId)) continue;
        if (!groups.has(entry.turnId)) groups.set(entry.turnId, []);
        groups.get(entry.turnId).push(entry);
      }
      const projections = new Map();
      for (const [turnId, entries] of groups) {
        if (prefixKnown) {
          const state = turnState(request.params.threadId, turnId, true);
          if (state && !state.suspended) {
            const orderedItems = new Map();
            for (const entry of entries) {
              const record = observeItem(request.params.threadId, turnId, entry.item, false, false);
              if (record) { record.ordered = true; orderedItems.set(entry.item.id, record); }
            }
            if (!state.suspended) {
              for (const [itemId, record] of state.items) {
                if (!orderedItems.has(itemId)) orderedItems.set(itemId, record);
              }
              state.items = orderedItems;
              state.prefixKnown = true;
              refreshIndexes(state);
            }
          }
        }
        const previousCount = projectedItems;
        const mapped = entries.map(entry => {
          if (!Number.isFinite(entry.completedAtMs)) return entry;
          const item = projectItem(request.params.threadId, entry.turnId, entry.item, prefixKnown, true, prefixKnown);
          return item === entry.item ? entry : { ...entry, item };
        });
        if (turns.get(scopeKey(request.params.threadId, turnId))?.suspended) {
          projectedItems = previousCount;
          continue;
        }
        for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) projections.set(entries[entryIndex], mapped[entryIndex]);
      }
      const data = result.data.map(entry => projections.get(entry) ?? entry);
      return data.some((entry, index) => entry !== result.data[index]) ? { ...message, result: { ...result, data } } : message;
    }
    if (request.method === "thread/turns/list" && Array.isArray(result.data)) {
      const data = result.data.map(turn => projectTurn(request.params.threadId, turn));
      return data.some((turn, index) => turn !== result.data[index]) ? { ...message, result: { ...result, data } } : message;
    }
    const thread = projectThread(result.thread);
    return thread !== result.thread ? { ...message, result: { ...result, thread } } : message;
  }

  function projectMessage(message) {
    if (!enabled || !trackingAvailable || !message || typeof message !== "object") return message;
    if (Object.hasOwn(message, "id")) {
      if (Object.hasOwn(message, "method")) return message;
      const request = requests.get(message.id);
      if (!request) return message;
      if (request.ambiguous) {
        request.pendingResponses -= 1;
        if (request.pendingResponses > 0) return message;
        requests.delete(message.id);
        retainedBytes -= request.bytes;
        return message;
      }
      requests.delete(message.id);
      retainedBytes -= request.bytes;
      return projectResponse(message, request);
    }
    const params = message.params;
    if (message.method === "turn/started") {
      turnState(params?.threadId, params?.turn?.id, true, true, true);
      return message;
    }
    if (message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/textDelta") {
      if (textPresent(params?.delta)) {
        const record = observeItem(params?.threadId, params?.turnId, { type: "reasoning", id: params?.itemId }, false, true, true);
        if (record) { record.visible = true; refreshIndexes(turnState(params.threadId, params.turnId)); }
      }
      return message;
    }
    if (message.method === "item/started") {
      observeItem(params?.threadId, params?.turnId, params?.item, false, true, true);
      return message;
    }
    if (message.method === "item/completed") {
      const item = projectItem(params?.threadId, params?.turnId, params?.item, false, true, true, true);
      return item === params?.item ? message : { ...message, params: { ...params, item } };
    }
    if (message.method === "turn/completed") {
      const turn = projectTurn(params?.threadId, params?.turn);
      completeTurn(params?.threadId, params?.turn?.id);
      return turn === params?.turn ? message : { ...message, params: { ...params, turn } };
    }
    if (message.method === "thread/started") {
      const thread = projectThread(params?.thread);
      return thread === params?.thread ? message : { ...message, params: { ...params, thread } };
    }
    return message;
  }

  function project(message) {
    const previousCount = projectedItems;
    const projected = projectMessage(message);
    if (trackingAvailable) return projected;
    projectedItems = previousCount;
    return message;
  }

  return {
    observeRequest,
    project,
    status: () => ({ enabled, trackingAvailable, disabledReason, retainedBytes, clientName, projectedItems,
      turnCount: turns.size, requestCount: requests.size, evictedTurns, capacityBypasses, lastCapacity,
      suspendedTurns: [...turns.values()].filter(state => state.suspended).length, turnHistoryBytes: turnHistory.length }),
    close: () => { enabled = false; requests.clear(); turns.clear(); turnHistory.fill(0); retainedBytes = 0; },
  };
}
