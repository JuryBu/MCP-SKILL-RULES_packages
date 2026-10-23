import crypto from "node:crypto";

const CHANNELS = ["attempts", "emptyIdleTurns", "businessProgress", "waitTerminals"];
const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_DURABLE_BYTES = 2 * 1024 * 1024;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function validThread(threadId) {
  return typeof threadId === "string" && threadId.length > 0 && threadId.length <= 512 && !threadId.includes("\u0000");
}

export function validateDurableRecoveryState(input, { policyKey, now = Date.now } = {}) {
  if (!input || input.schemaVersion !== 1 || typeof input.policyKey !== "string"
    || (policyKey !== undefined && input.policyKey !== policyKey)
    || !Number.isSafeInteger(input.capturedAt) || input.capturedAt < 0 || input.capturedAt > now()
    || !input.state || Object.keys(input.state).sort().join(",") !== [...CHANNELS].sort().join(",")
    || Buffer.byteLength(JSON.stringify(input)) > MAX_DURABLE_BYTES) fail("MODEL_OPERATION_RECOVERY_STATE_INVALID");
  for (const channel of CHANNELS) {
    const entries = input.state[channel];
    if (!Array.isArray(entries) || entries.length > 8192) fail("MODEL_OPERATION_RECOVERY_STATE_INVALID");
    const keys = new Set();
    for (const pair of entries) {
      if (!Array.isArray(pair) || pair.length !== 2) fail("MODEL_OPERATION_RECOVERY_STATE_INVALID");
      const [key, value] = pair;
      const threadId = typeof key === "string" ? key.split("\u0000")[0] : null;
      if (!validThread(threadId) || (channel !== "emptyIdleTurns" && !key.includes("\u0000")) || keys.has(key)
        || !value || typeof value !== "object" || Array.isArray(value)
        || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 || value.updatedAt > input.capturedAt
        || (channel === "emptyIdleTurns" && (!Number.isSafeInteger(value.count) || value.count < 1
          || typeof value.turnId !== "string" || !value.turnId
          || (value.terminalTurnId !== null && typeof value.terminalTurnId !== "string")))) {
        fail("MODEL_OPERATION_RECOVERY_STATE_INVALID");
      }
      keys.add(key);
    }
  }
  return JSON.parse(JSON.stringify(input));
}

export function createThreadRecoveryHandoff({ maps, active, policy, operationLedger, state, onStateChange, now = Date.now }) {
  const frozen = new Map();
  const used = new Map();
  const policyKey = JSON.stringify(policy);
  const belongs = (channel, key, threadId) => channel === "emptyIdleTurns"
    ? key === threadId : key.startsWith(`${threadId}\u0000`);
  const busy = threadId => [...active.values()].some(state => state.threadId === threadId);
  const clone = value => JSON.parse(JSON.stringify(value));
  if (state !== undefined) {
    const restored = validateDurableRecoveryState(state, { policyKey, now });
    for (const channel of CHANNELS) for (const [key, value] of restored.state[channel]) {
      if (value.updatedAt >= now() - policy.attemptStateTtlMs
        || (channel === "waitTerminals" && ["accepted", "unknown"].includes(value.acceptance))) maps[channel].set(key, value);
    }
  }
  if (onStateChange !== undefined) {
    if (typeof onStateChange !== "function") fail("MODEL_OPERATION_RECOVERY_STATE_INVALID");
    const save = () => {
      try {
        const snapshot = validateDurableRecoveryState({ schemaVersion: 1, policyKey, capturedAt: now(),
          state: Object.fromEntries(CHANNELS.map(channel => [channel, [...maps[channel]]])) }, { policyKey, now });
        if (onStateChange(snapshot)?.then) fail("MODEL_OPERATION_RECOVERY_STATE_ASYNC");
      } catch (cause) {
        throw Object.assign(new Error("MODEL_OPERATION_RECOVERY_STATE_PERSISTENCE_FAILED"), {
          code: "MODEL_OPERATION_RECOVERY_STATE_PERSISTENCE_FAILED", cause });
      }
    };
    save();
    for (const channel of CHANNELS) {
      const target = maps[channel];
      for (const method of ["set", "delete", "clear"]) Object.defineProperty(target, method, { configurable: true,
        value(...args) {
          const previous = new Map(target);
          const result = Map.prototype[method].apply(target, args);
          try { save(); }
          catch (error) {
            Map.prototype.clear.call(target);
            for (const [key, value] of previous) Map.prototype.set.call(target, key, value);
            throw error;
          }
          return result;
        } });
    }
  }
  const pruneUsed = () => {
    const cutoff = now() - policy.attemptStateTtlMs;
    for (const [threadId, updatedAt] of used) {
      if (updatedAt < cutoff && !frozen.has(threadId) && !busy(threadId)) used.delete(threadId);
    }
  };

  return {
    noteRequest(threadId) {
      pruneUsed();
      if (validThread(threadId)) used.set(threadId, now());
    },
    blocked(threadId) { return frozen.has(threadId); },
    prepare(threadId) {
      pruneUsed();
      if (!validThread(threadId)) fail("RECOVERY_HANDOFF_INVALID_THREAD");
      if (busy(threadId)) fail("RECOVERY_HANDOFF_THREAD_BUSY");
      if (frozen.has(threadId)) fail("RECOVERY_HANDOFF_ALREADY_PREPARED");
      const capturedAt = now();
      const token = crypto.randomUUID();
      const state = Object.fromEntries(CHANNELS.map(channel => [channel,
        [...maps[channel]].filter(([key, value]) => belongs(channel, key, threadId)
          && (value.updatedAt >= capturedAt - policy.attemptStateTtlMs
            || channel === "waitTerminals" && ["accepted", "unknown"].includes(value.acceptance))),
      ]));
      const snapshot = clone({ schemaVersion: 1, threadId, token, capturedAt, policyKey, state,
        ...(operationLedger ? { operationState: operationLedger.exportThread(threadId) } : {}) });
      if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_BYTES) fail("RECOVERY_HANDOFF_TOO_LARGE");
      frozen.set(threadId, token);
      return snapshot;
    },
    cancel(threadId, token) {
      if (!token || frozen.get(threadId) !== token) fail("RECOVERY_HANDOFF_TOKEN_MISMATCH");
      frozen.delete(threadId);
    },
    accept(input) {
      pruneUsed();
      let snapshot;
      try {
        const text = JSON.stringify(input);
        if (Buffer.byteLength(text, "utf8") > MAX_SNAPSHOT_BYTES) fail("RECOVERY_HANDOFF_TOO_LARGE");
        snapshot = JSON.parse(text);
      } catch (error) {
        if (error.code === "RECOVERY_HANDOFF_TOO_LARGE") throw error;
        fail("RECOVERY_HANDOFF_INVALID_SNAPSHOT");
      }
      if (!snapshot || snapshot.schemaVersion !== 1 || !validThread(snapshot.threadId)
        || typeof snapshot.token !== "string" || !/^[0-9a-f-]{36}$/u.test(snapshot.token)
        || snapshot.policyKey !== policyKey || !Number.isSafeInteger(snapshot.capturedAt)
        || snapshot.capturedAt > now() || snapshot.capturedAt < now() - policy.attemptStateTtlMs
        || !snapshot.state || typeof snapshot.state !== "object"
        || Object.keys(snapshot.state).length !== CHANNELS.length) fail("RECOVERY_HANDOFF_INVALID_SNAPSHOT");
      const threadId = snapshot.threadId;
      if (busy(threadId)) fail("RECOVERY_HANDOFF_THREAD_BUSY");
      if (used.has(threadId) || frozen.has(threadId)) fail("RECOVERY_HANDOFF_THREAD_ALREADY_USED");
      if (operationLedger && !snapshot.operationState) fail("RECOVERY_HANDOFF_LEDGER_STATE_REQUIRED");
      if (!operationLedger && snapshot.operationState) fail("RECOVERY_HANDOFF_LEDGER_UNSUPPORTED");
      const pending = [];
      for (const channel of CHANNELS) {
        const entries = snapshot.state[channel];
        if (!Array.isArray(entries)) fail("RECOVERY_HANDOFF_INVALID_SNAPSHOT");
        const keys = new Set();
        for (const entry of entries) {
          if (!Array.isArray(entry) || entry.length !== 2) fail("RECOVERY_HANDOFF_INVALID_SNAPSHOT");
          const [key, value] = entry;
          if (typeof key !== "string" || !belongs(channel, key, threadId) || keys.has(key)
            || !value || Array.isArray(value) || typeof value !== "object"
            || !Number.isSafeInteger(value.updatedAt) || value.updatedAt > snapshot.capturedAt) fail("RECOVERY_HANDOFF_INVALID_SNAPSHOT");
          keys.add(key);
          if (channel === "emptyIdleTurns" && (!Number.isSafeInteger(value.count) || value.count < 1
            || typeof value.turnId !== "string" || value.turnId.length === 0
            || (value.terminalTurnId !== null && typeof value.terminalTurnId !== "string"))) fail("RECOVERY_HANDOFF_INVALID_SNAPSHOT");
          if (value.updatedAt >= now() - policy.attemptStateTtlMs
            || channel === "waitTerminals" && ["accepted", "unknown"].includes(value.acceptance)) {
            pending.push({ channel, key, value });
          }
        }
      }
      const importedOperations = operationLedger?.importThread(threadId, snapshot.operationState) ?? 0;
      for (const { channel, key, value } of pending) maps[channel].set(key, value);
      used.set(threadId, now());
      return { threadId, token: snapshot.token, importedEntries: pending.length + importedOperations };
    },
  };
}
