const HISTORY_METHODS = new Set([
  "thread/read", "thread/resume", "thread/start", "thread/fork",
  "thread/turns/list", "thread/items/list",
]);

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
  const turns = new Map();
  const requests = new Map();
  let clientName = null;
  let enabled = false;
  let projectedItems = 0;
  let retainedBytes = 0;
  let trackingAvailable = true;

  function reserve(bytes) {
    if (retainedBytes + bytes > maximumRetainedBytes) { trackingAvailable = false; return false; }
    retainedBytes += bytes;
    return true;
  }

  function turnState(threadId, turnId, prefixKnown = false) {
    const key = scopeKey(threadId, turnId);
    if (!key || !trackingAvailable) return null;
    if (!turns.has(key)) {
      if (turns.size >= maximumTurns) { trackingAvailable = false; return null; }
      if (!reserve(Buffer.byteLength(key) + 128)) return null;
      turns.set(key, { items: new Map(), prefixKnown });
    }
    return turns.get(key);
  }

  function observeItem(threadId, turnId, item, prefixKnown = false) {
    if (item?.type !== "reasoning" || !validId(item.id)) return null;
    const state = turnState(threadId, turnId, prefixKnown);
    if (!state) return null;
    if (!state.items.has(item.id)) {
      if (state.items.size >= maximumItems) { trackingAvailable = false; return null; }
      if (!reserve(Buffer.byteLength(item.id) + 128)) return null;
      state.items.set(item.id, { index: state.prefixKnown ? state.items.size + 1 : null, visible: false, completed: false });
    }
    const record = state.items.get(item.id);
    if (textPresent(item.summary) || textPresent(item.content)) record.visible = true;
    return record;
  }

  function projectItem(threadId, turnId, item, prefixKnown = false, completed = true, canonicalIndex) {
    if (!Array.isArray(item?.summary) || !Array.isArray(item?.content)
      || item.summary.some(part => typeof part !== "string") || item.content.some(part => typeof part !== "string")) return item;
    const record = observeItem(threadId, turnId, item, prefixKnown);
    if (!record) return item;
    if (Number.isInteger(canonicalIndex) && canonicalIndex > 0) record.index = canonicalIndex;
    if (completed) record.completed = true;
    if (!record.completed || record.visible || textPresent(item.summary) || textPresent(item.content)) return item;
    const label = record.index === null ? "推理片段" : `推理片段${record.index}`;
    projectedItems += 1;
    return { ...item, summary: [`${label}已收到，摘要为空`] };
  }

  function projectTurn(threadId, turn) {
    if (!turn || !Array.isArray(turn.items)) return turn;
    const prefixKnown = turn.itemsView === "full";
    const completed = turn.status === "completed";
    let reasoningIndex = 0;
    const items = turn.items.map(item => {
      if (item?.type === "reasoning") reasoningIndex += 1;
      return projectItem(threadId, turn.id, item, prefixKnown, completed, prefixKnown ? reasoningIndex : undefined);
    });
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
      retainedBytes = 0;
      trackingAvailable = true;
    }
    if (!enabled || !trackingAvailable || !HISTORY_METHODS.has(message?.method) || !Object.hasOwn(message, "id")) return;
    if (!validId(message.id) && !Number.isFinite(message.id)) return;
    const originalParams = message.params ?? {};
    if (!validId(originalParams.threadId)) return;
    if (requests.size >= maximumRequests) { trackingAvailable = false; return; }
    const params = { threadId: originalParams.threadId, hasCursor: Boolean(originalParams.cursor), descending: originalParams.sortDirection === "desc" };
    const bytes = Buffer.byteLength(JSON.stringify([message.id, message.method, params])) + 128;
    if (!reserve(bytes)) return;
    const previous = requests.get(message.id);
    if (previous) retainedBytes -= previous.bytes;
    requests.set(message.id, { method: message.method, params, bytes });
  }

  function projectResponse(message, request) {
    if (message.error || !message.result || typeof message.result !== "object") return message;
    const result = message.result;
    if (request.method === "thread/items/list" && Array.isArray(result.data)) {
      const prefixKnown = !request.params.hasCursor && !request.params.descending;
      const data = result.data.map(entry => {
        if (!entry || !Number.isFinite(entry.completedAtMs)) return entry;
        const item = projectItem(request.params.threadId, entry.turnId, entry.item, prefixKnown);
        return item === entry.item ? entry : { ...entry, item };
      });
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
      const request = requests.get(message.id);
      if (!request) return message;
      requests.delete(message.id);
      retainedBytes -= request.bytes;
      return projectResponse(message, request);
    }
    const params = message.params;
    if (message.method === "turn/started") {
      turnState(params?.threadId, params?.turn?.id, true);
      return message;
    }
    if (message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/textDelta") {
      if (textPresent(params?.delta)) {
        const record = observeItem(params?.threadId, params?.turnId, { type: "reasoning", id: params?.itemId });
        if (record) record.visible = true;
      }
      return message;
    }
    if (message.method === "item/started") {
      observeItem(params?.threadId, params?.turnId, params?.item);
      return message;
    }
    if (message.method === "item/completed") {
      const item = projectItem(params?.threadId, params?.turnId, params?.item);
      return item === params?.item ? message : { ...message, params: { ...params, item } };
    }
    if (message.method === "turn/completed") {
      const turn = projectTurn(params?.threadId, params?.turn);
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
    status: () => ({ enabled, trackingAvailable, retainedBytes, clientName, projectedItems, turnCount: turns.size, requestCount: requests.size }),
    close: () => { enabled = false; requests.clear(); turns.clear(); retainedBytes = 0; },
  };
}
