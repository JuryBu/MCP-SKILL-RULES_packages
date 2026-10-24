import crypto from "node:crypto";

const validReason = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value);
const clone = value => JSON.parse(JSON.stringify(value));
const operationHash = key => crypto.createHash("sha256").update(key).digest("hex");

export function createModelOperationLedger({ state, onStateChange, maxEntries = 2048, now = Date.now } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000) {
    throw new RangeError("Invalid operation ledger capacity");
  }
  const entries = new Map();
  const snapshot = () => ({ schemaVersion: 1, entries: [...entries].map(([key, entry]) => [key, { ...entry }]) });
  const readState = value => {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== 1 || !Array.isArray(value.entries) || value.entries.length > maxEntries
      || Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) {
      throw new Error("INVALID_MODEL_OPERATION_STATE");
    }
    const restored = new Map();
    for (const pair of value.entries) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error("INVALID_MODEL_OPERATION_STATE");
      const [key, entry] = pair;
      if (typeof key !== "string" || !/^[a-f0-9]{64}$/u.test(key) || restored.has(key)
        || !entry || !["unknown", "accepted"].includes(entry.acceptance)
        || !["submitting", "unresolved"].includes(entry.phase) || !validReason(entry.reason)
        || !Number.isSafeInteger(entry.updatedAt) || entry.updatedAt < 0
        || entry.threadHash !== undefined && (typeof entry.threadHash !== "string" || !/^[a-f0-9]{64}$/u.test(entry.threadHash))) {
        throw new Error("INVALID_MODEL_OPERATION_STATE");
      }
      restored.set(key, { phase: "unresolved", acceptance: entry.acceptance,
        reason: "previous_proxy_interrupted", updatedAt: entry.updatedAt,
        ...(entry.threadHash ? { threadHash: entry.threadHash } : {}) });
    }
    return restored;
  };
  if (state !== undefined) {
    for (const [key, entry] of readState(state)) entries.set(key, entry);
  }
  const save = () => {
    try {
      const result = onStateChange?.(snapshot());
      if (result && typeof result.then === "function") throw new Error("Synchronous persistence is required");
    } catch (cause) {
      throw Object.assign(new Error("MODEL_OPERATION_STATE_PERSISTENCE_FAILED"), {
        code: "MODEL_OPERATION_STATE_PERSISTENCE_FAILED", cause,
      });
    }
  };
  return {
    get(key) {
      const entry = entries.get(operationHash(key));
      return entry ? { ...entry } : null;
    },
    begin(key) {
      const hash = operationHash(key);
      if (entries.has(hash)) throw Object.assign(new Error("MODEL_OPERATION_REPLAY_BLOCKED"), { code: "MODEL_OPERATION_REPLAY_BLOCKED" });
      if (entries.size >= maxEntries) throw Object.assign(new Error("MODEL_OPERATION_LEDGER_FULL"), { code: "MODEL_OPERATION_LEDGER_FULL" });
      entries.set(hash, { phase: "submitting", acceptance: "unknown", reason: "request_submitting", updatedAt: now(),
        threadHash: operationHash(key.split("\u0000")[0]) });
      save();
    },
    settle(key, outcome) {
      const hash = operationHash(key);
      if (!entries.has(hash)) return;
      if (outcome.localRejection && entries.get(hash).phase !== "submitting") return;
      const acceptance = outcome.policy?.acceptance ?? "unknown";
      const replayableWithoutTool = outcome.kind === "cancelled" || outcome.policy?.retryable === true
        || (["temporary", "acceptance_unknown"].includes(outcome.policy?.category)
          && !outcome.deliveredExecutableToolDone && !outcome.sawCompaction);
      if (outcome.localRejection || outcome.kind === "completed" || ["rejected", "not_sent"].includes(acceptance)
        || outcome.policy?.terminalOutcome === "failed_no_output" || replayableWithoutTool) {
        const previous = entries.get(hash);
        entries.delete(hash);
        try { save(); } catch (error) { entries.set(hash, previous); error.requestAccepted = acceptance; throw error; }
        return;
      }
      entries.set(hash, { ...entries.get(hash), phase: "unresolved", acceptance: acceptance === "accepted" ? "accepted" : "unknown",
        reason: validReason(outcome.policy?.reasonCode) ? outcome.policy.reasonCode : "upstream_acceptance_unresolved",
        updatedAt: now() });
      try { save(); } catch (error) { error.requestAccepted = acceptance; throw error; }
    },
    exportThread(threadId) {
      if ([...entries.values()].some(entry => !entry.threadHash)) {
        throw Object.assign(new Error("MODEL_OPERATION_THREAD_UNBOUND"), { code: "MODEL_OPERATION_THREAD_UNBOUND" });
      }
      const threadHash = operationHash(threadId);
      return clone({ schemaVersion: 1, threadHash,
        entries: [...entries].filter(([_key, entry]) => entry.threadHash === threadHash) });
    },
    importThread(threadId, state) {
      const threadHash = operationHash(threadId);
      if (state?.threadHash !== threadHash) throw new Error("INVALID_MODEL_OPERATION_THREAD_STATE");
      const incoming = readState(state);
      if ([...incoming.values()].some(entry => entry.threadHash !== threadHash)
        || [...incoming].some(([key]) => entries.has(key) && entries.get(key).threadHash !== threadHash)) {
        throw new Error("INVALID_MODEL_OPERATION_THREAD_STATE");
      }
      const added = [...incoming.keys()].filter(key => !entries.has(key)).length;
      if (entries.size + added > maxEntries) {
        throw Object.assign(new Error("MODEL_OPERATION_LEDGER_FULL"), { code: "MODEL_OPERATION_LEDGER_FULL" });
      }
      for (const [key, entry] of incoming) {
        const previous = entries.get(key);
        entries.set(key, { ...entry, acceptance: previous?.acceptance === "accepted" ? "accepted" : entry.acceptance });
      }
      save();
      return incoming.size;
    },
    snapshot() { return clone(snapshot()); },
    status() { return { protectedOperations: entries.size, maxEntries, persistent: typeof onStateChange === "function" }; },
  };
}
