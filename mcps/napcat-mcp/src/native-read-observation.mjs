import { createHash } from "node:crypto";

const MAX_ITEMS = 20;
const MAX_PROOFS = 64;
const MAX_TEXT_BYTES = 64 * 1024;
const ITEM_TYPES = new Set(["userMessage", "agentMessage", "plan", "reasoning", "commandExecution", "fileChange",
  "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch", "imageView", "imageGeneration",
  "enteredReviewMode", "exitedReviewMode", "contextCompaction"]);
const identity = value => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/u.test(value);
const DESKTOP_CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ordinaryClientId = value => value == null ? null : (typeof value === "string" && DESKTOP_CLIENT_ID.test(value) ? value.toLowerCase() : undefined);
const ORDINARY_TURN_TRIGGERS = new Set(["composer", "edit_user_message"]);
const NULL_COMPANION_PAGE_RE = /^Companion Page snapshot part 1 of 1:\s*\{"page_id":null,"document_view":null\}$/u;
const BENIGN_ADDITIONAL_CONTEXT_KINDS = new Map([
  ["codex_apps_client_time_context", "application"],
  ["codex_git_state", "untrusted"],
  ["worktree_preference", "application"],
  ["worktree_preference_guidance", "application"],
  ["codex_apps_open_page", "untrusted"],
  ["codex_apps_selected_page_part_1_of_1", "untrusted"],
]);
function isBenignAdditionalContext(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0 && Object.keys(value).length === 0;
  if (typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Object.keys(value);
  if (keys.length > BENIGN_ADDITIONAL_CONTEXT_KINDS.size) return false;
  for (const key of keys) {
    const expectedKind = BENIGN_ADDITIONAL_CONTEXT_KINDS.get(key);
    if (!expectedKind) return false;
    const entry = value[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const eProto = Object.getPrototypeOf(entry);
    if (eProto !== Object.prototype && eProto !== null) return false;
    if (Object.keys(entry).some(k => k !== "kind" && k !== "value" && k !== "name")) return false;
    if (entry.kind !== expectedKind || typeof entry.value !== "string" || entry.value.length > MAX_TEXT_BYTES) return false;
    if (entry.name !== undefined && (expectedKind !== "untrusted" || typeof entry.name !== "string" || entry.name.length > 128)) return false;
    if (key === "codex_apps_open_page" && entry.value !== "{\"page_id\":null}") return false;
    if (key === "codex_apps_selected_page_part_1_of_1" && (entry.value.length > 256 || !NULL_COMPANION_PAGE_RE.test(entry.value))) return false;
  }
  return true;
}
function isBenignClientMetadata(value) {
  if (value == null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  if (Object.hasOwn(value, "source") && value.source != null && value.source !== "codex") return false;
  if (value.daybreak_propagation_source != null || value.prediction_source_thread_id != null
    || value.prediction_source_turn_id != null || value.prediction_trigger != null
    || value.misalignment_override != null) return false;
  const keys = Object.keys(value);
  if (keys.length > 32) return false;
  for (const key of keys) {
    const entry = value[key];
    if (entry != null && (typeof entry !== "string" || entry.length > 8192)) return false;
  }
  return true;
}
const digest = value => createHash("sha256").update(value).digest("hex");
const keyFor = (threadId, turnId) => JSON.stringify([threadId, turnId]);
const ownItem = (item, threadId, turnId) => (item.threadId === undefined || item.threadId === threadId)
  && (item.turnId === undefined || item.turnId === turnId);

function plainInput(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8) return null;
  const hash = createHash("sha256");
  let total = 0;
  for (const part of input) {
    if (part?.type !== "text" || typeof part.text !== "string" || part.text.length > MAX_TEXT_BYTES
      || (part.text_elements != null && (!Array.isArray(part.text_elements) || part.text_elements.length))) return null;
    const bytes = Buffer.byteLength(part.text);
    total += bytes;
    if (total > MAX_TEXT_BYTES) return null;
    hash.update(String(bytes)).update(":").update(part.text);
  }
  return hash.digest("hex");
}

function itemSeal(item) {
  if (!identity(item?.id) || !ITEM_TYPES.has(item.type)) return null;
  let body = null;
  if (item.type === "userMessage") {
    body = plainInput(item.content);
    const clientId = ordinaryClientId(item.clientId);
    if (!body || clientId === undefined) return null;
    return JSON.stringify([item.type, body, clientId]);
  } else if (item.type === "agentMessage") {
    const phase = item.phase ?? null;
    if (item.moderation?.moderated || typeof item.text !== "string" || item.text.length > MAX_TEXT_BYTES
      || Buffer.byteLength(item.text) > MAX_TEXT_BYTES
      || (phase !== null && phase !== "commentary" && phase !== "final_answer")) return null;
    return JSON.stringify([item.type, digest(item.text), phase]);
  }
  return JSON.stringify([item.type, body]);
}

function sameStamp(left, right) {
  return Boolean(left && right && left.length === right.length && left.every((value, index) => value === right[index]));
}

export function createNativeReadObservation({ allowed, registryStamp }) {
  const active = new Map();
  const sealed = new Map();
  const proofItems = new WeakMap();
  const captureOwner = Object.freeze({});
  const connectionKeys = new WeakMap();
  function connectionKey(connection) {
    if (!connection || typeof connection !== "object") return null;
    if (!connectionKeys.has(connection)) connectionKeys.set(connection, Object.freeze({}));
    return connectionKeys.get(connection);
  }
  function transport(client, epoch) {
    const desktop = connectionKey(client);
    const native = connectionKey(client?.upstream);
    if (!desktop || !native || typeof epoch !== "string" || !epoch.length) return null;
    return [desktop, native, client.metadataDownstreamGeneration, client.metadataUpstreamGeneration, epoch];
  }
  function stamp(threadId) { try { return registryStamp(threadId); } catch { return null; } }

  function capture(params) {
    if (!allowed.has(params?.threadId)) return null;
    if (params.toolOutput != null || params.parentTurnId != null || params.rootTurnId != null) return null;
    if (params.turnTrigger != null && !ORDINARY_TURN_TRIGGERS.has(params.turnTrigger)) return null;
    if (params.responsesapiClientMetadataPatch != null || !isBenignClientMetadata(params.responsesapiClientMetadata)) return null;
    if (!isBenignAdditionalContext(params.additionalContext)) return null;
    const clientId = ordinaryClientId(params.clientUserMessageId);
    if (clientId === undefined) return null;
    const hash = plainInput(params.input);
    return hash ? Object.freeze({ hash, clientId, owner: captureOwner }) : null;
  }
  function invalidate(threadId) {
    if (!allowed.has(threadId)) return;
    active.delete(threadId);
    for (const [key, proof] of sealed) if (proof.threadId === threadId) sealed.delete(key);
  }
  function forwarded(client, epoch, method, threadId, tracking) {
    if (!allowed.has(threadId)) return;
    if (method !== "turn/start" || tracking?.readInput?.owner !== captureOwner) {
      if (["turn/start", "turn/steer", "turn/interrupt", "thread/compact/start", "thread/rollback", "thread/inject_items", "thread/unsubscribe"].includes(method)) invalidate(threadId);
      return;
    }
    const connection = transport(client, epoch);
    if (!connection) { invalidate(threadId); return; }
    const earlier = active.get(threadId);
    if (earlier) {
      invalidate(threadId);
      if (sameStamp(earlier.transport, connection)) return;
    }
    const registries = stamp(threadId);
    if (!registries) return;
    active.set(threadId, { transport: connection, registries, tracking, threadId, items: new Map(),
      turnId: null, started: false, accepted: false, completed: null, userId: null, hasFinalAnswer: false });
  }
  function bind(state, turnId) {
    if (!identity(turnId) || (state.turnId !== null && state.turnId !== turnId)) return false;
    state.turnId = turnId;
    return true;
  }
  function settle(state) {
    if (!state.started || !state.accepted || !state.completed) return;
    active.delete(state.threadId);
    if (!state.userId || !state.hasFinalAnswer || [...state.items.values()].some(value => value.completed === null)
      || !sameStamp(state.registries, stamp(state.threadId))) return;
    const proof = Object.freeze({ threadId: state.threadId, turnId: state.turnId });
    proofItems.set(proof, { ...state, tracking: null, transport: state.transport, userId: state.userId });
    const key = keyFor(state.threadId, state.turnId);
    sealed.set(key, proof);
    if (sealed.size > MAX_PROOFS) sealed.delete(sealed.keys().next().value);
  }
  function reply(client, epoch, tracking, response) {
    const state = active.get(tracking?.threadId);
    if (!state || state.tracking !== tracking) return;
    const turn = response?.result?.turn;
    if (!sameStamp(state.transport, transport(client, epoch)) || response?.error || turn?.status !== "inProgress"
      || (response.result?.threadId != null && response.result.threadId !== state.threadId)
      || (response.result?.thread?.id != null && response.result.thread.id !== state.threadId)
      || (turn?.threadId != null && turn.threadId !== state.threadId) || !bind(state, turn?.id)) {
      invalidate(state.threadId);
      return;
    }
    state.accepted = true;
    settle(state);
  }
  function matchesCompletionItems(state, turn) {
    const seen = new Set();
    if (!Array.isArray(turn.items) || turn.items.length > MAX_ITEMS
      || !["full", "summary", "notLoaded"].includes(turn.itemsView)) return false;
    if (turn.itemsView === "notLoaded") return turn.items.length === 0;
    for (const item of turn.items) {
      const entry = state.items.get(item?.id);
      if (!entry || !ownItem(item, state.threadId, state.turnId) || entry.type !== item.type || entry.completed === null || seen.has(item.id)
        || (turn.itemsView === "full" && entry.completed !== itemSeal(item))) return false;
      seen.add(item.id);
    }
    return turn.itemsView !== "full" || seen.size === state.items.size;
  }
  function notify(client, epoch, message) {
    if (!["turn/started", "turn/completed", "item/started", "item/completed"].includes(message?.method)) return;
    const params = message.params;
    const threadId = params?.threadId;
    if (!allowed.has(threadId)) return;
    const state = active.get(threadId);
    const turnId = message.method.startsWith("turn/") ? params.turn?.id : params.turnId;
    if (!state) { if (identity(turnId)) sealed.delete(keyFor(threadId, turnId)); return; }
    if (!sameStamp(state.transport, transport(client, epoch))) { invalidate(threadId); return; }
    const key = keyFor(threadId, turnId);
    if (sealed.has(key)) { sealed.delete(key); return; }
    if (!bind(state, turnId) || state.completed) { invalidate(threadId); return; }
    if (message.method === "turn/started") {
      if (state.started || params.turn?.status !== "inProgress") { invalidate(threadId); return; }
      state.started = true;
    } else if (message.method === "turn/completed") {
      const turn = params.turn;
      if (!state.started || turn?.status !== "completed" || turn.error != null || !Number.isSafeInteger(turn.startedAt)
        || !Number.isSafeInteger(turn.completedAt) || turn.completedAt < turn.startedAt || !matchesCompletionItems(state, turn)) {
        invalidate(threadId); return;
      }
      state.completed = { began: params.turn.startedAt, ended: params.turn.completedAt };
    } else {
      const item = params.item;
      if (!identity(item?.id) || !ownItem(item, threadId, state.turnId) || !ITEM_TYPES.has(item.type)) { invalidate(threadId); return; }
      if (message.method === "item/started") {
        if (state.items.has(item.id) || state.items.size >= MAX_ITEMS
          || (item.type === "userMessage" && (state.userId || ordinaryClientId(item.clientId) !== state.tracking.readInput.clientId || plainInput(item.content) !== state.tracking.readInput.hash))) {
          invalidate(threadId); return;
        }
        if (item.type === "userMessage") state.userId = item.id;
        state.items.set(item.id, { type: item.type, completed: null });
      } else {
        const entry = state.items.get(item.id);
        const seal = itemSeal(item);
        if (!entry || entry.type !== item.type || entry.completed !== null || !seal
          || (item.type === "userMessage" && seal !== JSON.stringify(["userMessage", state.tracking.readInput.hash, state.tracking.readInput.clientId]))) {
          invalidate(threadId); return;
        }
        entry.completed = seal;
        if (item.type === "agentMessage" && item.phase === "final_answer") state.hasFinalAnswer = true;
      }
    }
    settle(state);
  }
  function coverage(client, epoch, threadId, turn) {
    const proof = sealed.get(keyFor(threadId, turn?.id));
    const state = proofItems.get(proof);
    return state && !active.has(threadId) && turn.status === "completed" && turn.startedAt === state.completed.began
      && turn.completedAt === state.completed.ended && sameStamp(state.transport, transport(client, epoch))
      && sameStamp(state.registries, stamp(threadId)) ? proof : null;
  }
  function verifyItems(proof, rows) {
    const state = proofItems.get(proof);
    return Boolean(state && rows.length === state.items.size && rows.every(row => {
      const expected = state.items.get(row.item.id)?.completed;
      return typeof expected === "string" && ownItem(row.item, state.threadId, state.turnId) && itemSeal(row.item) === expected;
    }));
  }
  const ownsInput = (proof, item) => proofItems.get(proof)?.userId === item.id;
  return { capture, forwarded, reply, invalidate, notify, coverage, verifyItems, ownsInput };
}
