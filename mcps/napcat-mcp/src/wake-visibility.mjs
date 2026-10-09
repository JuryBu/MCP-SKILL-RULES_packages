import crypto from "node:crypto";

export const WAKE_VISIBILITY_VERSION = "2026-10-06.1";

function digest(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function bounded(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function remember(entries, key, value, limit) {
  entries.set(key, value);
  while (entries.size > limit) entries.delete(entries.keys().next().value);
}

function inputDigest(content) {
  if (!Array.isArray(content) || content.length !== 1) return null;
  const item = content[0];
  if (item?.type !== "text" || typeof item.text !== "string") return null;
  if (Array.isArray(item.text_elements) && item.text_elements.length) return null;
  return digest(item.text);
}

export function createWakeVisibilityAdapter(options = {}) {
  const maxWakes = bounded(options.maxWakes, 2048);
  const maxTurns = bounded(options.maxTurns, 256);
  const maxItemsPerTurn = bounded(options.maxItemsPerTurn, 256);
  const registrations = new Map();
  const turns = new Map();
  let suppressedEvents = 0;

  function registerWake({ threadId, wakeId, prompt, promptSha256, messageVisibility, turnId = null, injectionMethod = null, itemKey = null, visibilityClientId = null }) {
    const hash = typeof prompt === "string" ? digest(prompt) : promptSha256;
    if (typeof threadId !== "string" || !threadId || !/^[a-f0-9]{64}$/.test(hash ?? "")) return null;
    const key = JSON.stringify([threadId, hash]);
    const prior = registrations.get(key);
    const registration = {
      key,
      wakeId,
      hidden: messageVisibility === "hidden",
      ambiguous: Boolean(prior && (prior.ambiguous || prior.wakeId !== wakeId)),
      itemKey: prior?.wakeId === wakeId ? prior.itemKey : itemKey,
      turnId,
      injectionMethod,
      visibilityClientId,
    };
    remember(registrations, key, registration, maxWakes);
    return registration;
  }

  function forgetWake(registration) {
    if (registrations.get(registration?.key) === registration) {
      registrations.delete(registration.key);
    }
  }

  function createView() {
    let closed = false;
    const historyRequests = new Map();

    function decideItem(threadId, turnId, item, completeHistory = false) {
      if (closed) return false;
      if (typeof threadId !== "string" || !threadId || typeof turnId !== "string" || !turnId) return false;
      if (item?.type !== "userMessage" || typeof item.id !== "string" || !item.id) return false;
      const hash = inputDigest(item.content);
      const registration = hash === null ? null : registrations.get(JSON.stringify([threadId, hash]));
      const tagged = typeof registration?.visibilityClientId === "string" && registration.visibilityClientId === item.clientId;
      const eligibleClient = item.clientId == null || tagged;
      const inline = registration?.injectionMethod === "turn/steer" && registration.turnId === turnId;
      const turnKey = JSON.stringify([threadId, turnId]);
      let turn = turns.get(turnKey);
      if (!turn) {
        turn = { firstItemId: inline ? null : item.id, decisions: new Map() };
        remember(turns, turnKey, turn, maxTurns);
      } else if (turn.firstItemId === null && !inline) {
        turn.firstItemId = item.id;
      }
      const itemKey = JSON.stringify([threadId, turnId, item.id]);
      const sameTurn = registration?.turnId == null || registration.turnId === turnId;
      const previous = turn.decisions.get(item.id);
      const reconsiderOpening = completeHistory && previous?.opening && registration?.itemKey === itemKey;
      if (previous && !reconsiderOpening) {
        const suppress = previous.suppress && previous.hash === hash && item.clientId === previous.clientId;
        if (suppress) suppressedEvents += 1;
        return suppress;
      }
      if (tagged && sameTurn && !registration.ambiguous && !registration.itemKey) {
        registration.itemKey = itemKey;
        registration.turnId = turnId;
        if (options.onItemBound?.(registration) === false) registration.itemKey = null;
      }
      const suppress = (inline || item.id !== turn.firstItemId)
        && eligibleClient
        && sameTurn
        && registration?.hidden === true
        && !registration.ambiguous
        && registration.itemKey === itemKey;
      remember(turn.decisions, item.id, { hash, suppress, clientId: item.clientId, opening: item.id === turn.firstItemId }, maxItemsPerTurn);
      if (suppress) suppressedEvents += 1;
      return suppress;
    }

    function projectTurn(threadId, turn) {
      if (typeof threadId !== "string" || !threadId || !turn || typeof turn.id !== "string" || !Array.isArray(turn.items)) return turn;
      if (turn.itemsView && turn.itemsView !== "full") return turn;
      const first = turn.items.find(item => item?.type === "userMessage" && typeof item.id === "string");
      if (first) {
        const turnKey = JSON.stringify([threadId, turn.id]);
        const tracked = turns.get(turnKey);
        if (tracked) tracked.firstItemId = first.id;
        else remember(turns, turnKey, { firstItemId: first.id, decisions: new Map() }, maxTurns);
      }
      const items = turn.items.filter(item => !decideItem(threadId, turn.id, item, true));
      return items.length === turn.items.length ? turn : { ...turn, items };
    }

    return {
      observeRequest(message) {
        if (closed || !["thread/read", "thread/resume", "thread/turns/list", "thread/items/list"].includes(message?.method)) return;
        if (!["string", "number"].includes(typeof message.id) || typeof message.params?.threadId !== "string") return;
        remember(historyRequests, message.id, { method: message.method, threadId: message.params.threadId }, maxTurns);
      },
      shouldSuppress(message) {
        if (!message || Object.hasOwn(message, "id")) return false;
        if (!["item/started", "item/completed"].includes(message.method)) return false;
        const { threadId, turnId, item } = message.params ?? {};
        return decideItem(threadId, turnId, item);
      },
      project(message) {
        if (closed || !message) return message;
        if (["turn/started", "turn/completed"].includes(message.method) && !Object.hasOwn(message, "id")) {
          const turn = projectTurn(message.params?.threadId, message.params?.turn);
          return turn === message.params?.turn ? message : { ...message, params: { ...message.params, turn } };
        }
        if (Object.hasOwn(message, "method") || (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))) return message;
        const request = historyRequests.get(message.id);
        if (!request) return message;
        historyRequests.delete(message.id);
        if (message.error || !message.result) return message;
        if (request.method === "thread/items/list" && Array.isArray(message.result.data)) {
          const data = message.result.data.filter(entry => !decideItem(request.threadId, entry?.turnId, entry?.item));
          return data.length === message.result.data.length ? message : { ...message, result: { ...message.result, data } };
        }
        if (request.method === "thread/turns/list" && Array.isArray(message.result.data)) {
          const data = message.result.data.map(turn => projectTurn(request.threadId, turn));
          return data.every((turn, index) => turn === message.result.data[index])
            ? message : { ...message, result: { ...message.result, data } };
        }
        const thread = message.result.thread;
        if (thread?.id !== request.threadId || !Array.isArray(thread.turns)) return message;
        const projectedTurns = thread.turns.map(turn => projectTurn(thread.id, turn));
        return projectedTurns.every((turn, index) => turn === thread.turns[index])
          ? message : { ...message, result: { ...message.result, thread: { ...thread, turns: projectedTurns } } };
      },
      close() {
        closed = true;
        historyRequests.clear();
      },
      snapshot() {
        return { trackedTurns: closed ? 0 : turns.size };
      },
    };
  }

  return {
    registerWake,
    forgetWake,
    createView,
    close() {
      registrations.clear();
      turns.clear();
    },
    snapshot() {
      return { version: WAKE_VISIBILITY_VERSION, registeredWakes: registrations.size, trackedTurns: turns.size, suppressedEvents };
    },
  };
}
