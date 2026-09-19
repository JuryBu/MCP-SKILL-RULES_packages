import crypto from "node:crypto";

export const WAKE_VISIBILITY_VERSION = "2026-09-19.1";

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

  function registerWake({ threadId, wakeId, prompt, messageVisibility }) {
    const key = JSON.stringify([threadId, digest(prompt)]);
    const prior = registrations.get(key);
    const registration = {
      key,
      wakeId,
      hidden: messageVisibility === "hidden",
      ambiguous: Boolean(prior && (prior.ambiguous || prior.wakeId !== wakeId)),
      itemKey: prior?.wakeId === wakeId ? prior.itemKey : null,
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
    return {
      shouldSuppress(message) {
        if (closed) return false;
        if (!message || Object.hasOwn(message, "id")) return false;
        if (!["item/started", "item/completed"].includes(message.method)) return false;
        const { threadId, turnId, item } = message.params ?? {};
        if (typeof threadId !== "string" || !threadId || typeof turnId !== "string" || !turnId) return false;
        if (item?.type !== "userMessage" || typeof item.id !== "string" || !item.id) return false;
        const turnKey = JSON.stringify([threadId, turnId]);
        let turn = turns.get(turnKey);
        if (!turn) {
          turn = { firstItemId: item.id, decisions: new Map() };
          remember(turns, turnKey, turn, maxTurns);
        }
        const hash = inputDigest(item.content);
        const previous = turn.decisions.get(item.id);
        if (previous) {
          const suppress = previous.suppress && previous.hash === hash && item.clientId == null;
          if (suppress) suppressedEvents += 1;
          return suppress;
        }
        const registration = hash === null ? null : registrations.get(JSON.stringify([threadId, hash]));
        const itemKey = JSON.stringify([threadId, turnId, item.id]);
        if (registration && !registration.ambiguous && item.clientId == null && !registration.itemKey) {
          registration.itemKey = itemKey;
        }
        const suppress = item.id !== turn.firstItemId
          && item.clientId == null
          && registration?.hidden === true
          && !registration.ambiguous
          && registration.itemKey === itemKey;
        remember(turn.decisions, item.id, { hash, suppress }, maxItemsPerTurn);
        if (suppress) suppressedEvents += 1;
        return suppress;
      },
      close() {
        closed = true;
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
