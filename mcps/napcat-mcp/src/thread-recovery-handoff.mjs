import crypto from "node:crypto";

const CHANNELS = ["attempts", "emptyIdleTurns", "businessProgress", "waitTerminals"];
const MAX_SNAPSHOT_BYTES = 1024 * 1024;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function validThread(threadId) {
  return typeof threadId === "string" && threadId.length > 0 && threadId.length <= 512 && !threadId.includes("\u0000");
}

export function createThreadRecoveryHandoff({ maps, active, policy, now = Date.now }) {
  const frozen = new Map();
  const used = new Map();
  const policyKey = JSON.stringify(policy);
  const belongs = (channel, key, threadId) => channel === "emptyIdleTurns"
    ? key === threadId : key.startsWith(`${threadId}\u0000`);
  const busy = threadId => [...active.values()].some(state => state.threadId === threadId);
  const clone = value => JSON.parse(JSON.stringify(value));
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
          && value.updatedAt >= capturedAt - policy.attemptStateTtlMs),
      ]));
      const snapshot = clone({ schemaVersion: 1, threadId, token, capturedAt, policyKey, state });
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
          if (value.updatedAt >= now() - policy.attemptStateTtlMs) pending.push({ channel, key, value });
        }
      }
      for (const { channel, key, value } of pending) maps[channel].set(key, value);
      used.set(threadId, now());
      return { threadId, token: snapshot.token, importedEntries: pending.length };
    },
  };
}
