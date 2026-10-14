import { randomUUID } from "node:crypto";

const bindingFields = ["ownerId", "ownerConnectionId", "backendGeneration", "subscriptionGeneration", "threadId"];
const trueFields = ["initialized", "upstreamOpen", "originalOwner", "subscribed", "loaded"];
const falseFields = ["reconnecting", "currentView", "activeTurn"];
const zeroFields = ["pendingCount", "activeWakeCount", "followCount", "activeRequestCount", "injectedCount", "desktopPendingCount"];
const ambiguousStates = new Set(["EXECUTING", "UNKNOWN"]);

export class ThreadUnsubscribeControlError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "ThreadUnsubscribeControlError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, details) {
  throw new ThreadUnsubscribeControlError(code, details);
}

function bindingOf(input) {
  const binding = {};
  for (const name of bindingFields) {
    const value = input?.[name];
    const valid = name.endsWith("Generation")
      ? Number.isSafeInteger(value) && value > 0
      : typeof value === "string" && value.length > 0 && value === value.trim() && value.length <= 512;
    if (!valid) fail("UNSUBSCRIBE_BINDING_REQUIRED", { field: name });
    binding[name] = value;
  }
  return Object.freeze(binding);
}

function checkSnapshot(snapshot, binding, connection, now, maxAgeMs, revision) {
  if (!snapshot || typeof snapshot !== "object") fail("UNSUBSCRIBE_STATE_UNKNOWN");
  for (const field of bindingFields) {
    if (snapshot[field] !== binding[field]) fail("UNSUBSCRIBE_BINDING_CHANGED", { field });
  }
  if (!connection || snapshot.connection !== connection) fail("UNSUBSCRIBE_ORIGINAL_CONNECTION_REQUIRED");
  if (!Number.isSafeInteger(snapshot.stateRevision) || snapshot.stateRevision < 0) fail("UNSUBSCRIBE_STATE_UNKNOWN", { field: "stateRevision" });
  if (revision !== undefined && snapshot.stateRevision !== revision) fail("UNSUBSCRIBE_PREPARATION_CHANGED");
  if (!Number.isFinite(snapshot.observedAt) || snapshot.observedAt > now || now - snapshot.observedAt > maxAgeMs) fail("UNSUBSCRIBE_STATE_STALE");
  for (const field of trueFields) {
    if (snapshot[field] !== true) fail("UNSUBSCRIBE_UNSAFE_STATE", { field, value: snapshot[field] ?? null });
  }
  for (const field of falseFields) {
    if (snapshot[field] !== false) fail("UNSUBSCRIBE_UNSAFE_STATE", { field, value: snapshot[field] ?? null });
  }
  for (const field of zeroFields) {
    if (snapshot[field] !== 0) fail("UNSUBSCRIBE_UNSAFE_STATE", { field, value: snapshot[field] ?? null });
  }
  if (snapshot.status !== "idle" || snapshot.ephemeral !== false) fail("UNSUBSCRIBE_THREAD_NOT_IDLE_OR_PERSISTED");
  return snapshot;
}

function errorEvidence(error) {
  return {
    code: error?.code ?? "UNEXPECTED_ERROR",
    message: error?.message ?? String(error),
    ...(error?.details !== undefined ? { details: error.details } : {}),
    ...(error?.data !== undefined ? { data: error.data } : {}),
    ...(error?.rpcError !== undefined ? { rpcError: error.rpcError } : {}),
    written: error?.written ?? null,
    outcomeUnknown: error?.outcomeUnknown ?? null,
  };
}

function checkInspection(result, threadId) {
  const thread = result?.thread;
  const status = typeof thread?.status === "object" ? thread.status?.type : thread?.status;
  if (thread?.id !== threadId || status !== "idle" || thread.ephemeral !== false) fail("UNSUBSCRIBE_INSPECTION_NOT_SAFE");
  if (Array.isArray(thread.turns) && thread.turns.some(turn => !["completed", "interrupted", "failed"].includes(turn?.status))) {
    fail("UNSUBSCRIBE_INSPECTION_NOT_SAFE");
  }
}

export function classifyUnsubscribeError(error) {
  const original = error?.rpcError ?? error?.details?.rpcError
    ?? (error?.rpcResponseReceived === true && Number.isInteger(error?.code) ? error : null);
  if (original) {
    return {
      state: "RPC_ERROR",
      category: /^thread not loaded\b/i.test(original.message ?? "") ? "thread_not_loaded" : "rpc_error",
      rpcError: original,
      retryAllowed: false,
    };
  }
  const notWritten = error?.written === false && error?.outcomeUnknown === false;
  return { state: notWritten ? "NOT_WRITTEN" : "UNKNOWN", retryAllowed: false };
}

export function createThreadUnsubscribeControl(options) {
  if (typeof options?.withOwnerLease !== "function" || typeof options?.journal?.get !== "function" || typeof options?.journal?.put !== "function") {
    fail("UNSUBSCRIBE_HOST_ADAPTER_REQUIRED");
  }
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? 5000;
  const preparationTtlMs = options.preparationTtlMs ?? 30000;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 30000
    || !Number.isSafeInteger(preparationTtlMs) || preparationTtlMs < 1 || preparationTtlMs > 60000) fail("UNSUBSCRIBE_INVALID_TIME_BUDGET");
  const preparations = new Map();
  const busy = new Set();
  const keyOf = binding => JSON.stringify([binding.ownerId, binding.threadId]);
  const readJournal = key => {
    const outcome = options.journal.get(key);
    if (outcome?.then) fail("UNSUBSCRIBE_SYNCHRONOUS_JOURNAL_REQUIRED");
    if (outcome === undefined) fail("UNSUBSCRIBE_JOURNAL_STATE_UNKNOWN");
    if (ambiguousStates.has(outcome?.state)) fail("UNSUBSCRIBE_OUTCOME_UNRESOLVED", { state: outcome.state, attemptId: outcome.attemptId });
    return outcome;
  };
  const writeJournal = (key, outcome) => {
    const accepted = options.journal.put(key, structuredClone(outcome));
    if (accepted !== true) fail("UNSUBSCRIBE_OUTCOME_NOT_PERSISTED");
  };
  const exclusive = async (binding, operation) => {
    const key = keyOf(binding);
    if (busy.has(key)) fail("UNSUBSCRIBE_OPERATION_PENDING");
    busy.add(key);
    try {
      readJournal(key);
      return await operation(key);
    } finally {
      busy.delete(key);
    }
  };
  const assertLease = lease => {
    if (!lease?.connection || typeof lease.inspect !== "function" || typeof lease.snapshot !== "function"
      || typeof lease.injectRequest !== "function") fail("UNSUBSCRIBE_ORIGINAL_CONNECTION_REQUIRED");
  };

  async function prepare(input) {
    const binding = bindingOf(input);
    return exclusive(binding, async key => options.withOwnerLease(binding, async lease => {
      assertLease(lease);
      readJournal(key);
      const first = checkSnapshot(lease.snapshot(), binding, lease.connection, now(), maxAgeMs);
      const revision = first.stateRevision;
      checkInspection(await lease.inspect({ threadId: binding.threadId, connection: lease.connection, mutating: false }), binding.threadId);
      const snapshot = checkSnapshot(lease.snapshot(), binding, lease.connection, now(), maxAgeMs, revision);
      const receipt = Object.freeze({ receiptId: randomUUID(), ...binding, stateRevision: snapshot.stateRevision, preparedAt: now(), expiresAt: now() + preparationTtlMs });
      for (const [receiptId, preparation] of preparations) {
        if (preparation.key === key || preparation.receipt.expiresAt < now()) preparations.delete(receiptId);
      }
      preparations.set(receipt.receiptId, { receipt, key, connection: lease.connection });
      return { state: "PREPARED", receipt };
    }));
  }

  async function execute(input) {
    const binding = bindingOf(input);
    const preparation = preparations.get(input?.receiptId);
    if (!preparation) fail("UNSUBSCRIBE_PREPARATION_REQUIRED");
    const { receipt, connection } = preparation;
    for (const field of bindingFields) if (binding[field] !== receipt[field]) fail("UNSUBSCRIBE_RECEIPT_MISMATCH", { field });
    return exclusive(binding, async key => {
      preparations.delete(receipt.receiptId);
      if (now() < receipt.preparedAt || now() >= receipt.expiresAt) fail("UNSUBSCRIBE_PREPARATION_EXPIRED");
      return options.withOwnerLease(binding, async lease => {
        assertLease(lease);
        if (lease.connection !== connection) fail("UNSUBSCRIBE_ORIGINAL_CONNECTION_REQUIRED");
        const guard = () => {
          if (now() < receipt.preparedAt || now() >= receipt.expiresAt) fail("UNSUBSCRIBE_PREPARATION_EXPIRED");
          return checkSnapshot(lease.snapshot(), binding, connection, now(), maxAgeMs, receipt.stateRevision);
        };
        guard();
        checkInspection(await lease.inspect({ threadId: binding.threadId, connection, mutating: false }), binding.threadId);
        guard();
        readJournal(key);
        let outcome = { state: "EXECUTING", attemptId: randomUUID(), receiptId: receipt.receiptId, binding, startedAt: now(), mutating: true, method: "thread/unsubscribe" };
        writeJournal(key, outcome);
        let beforeWriteRan = false;
        let guardPassed = false;
        try {
          const response = lease.injectRequest("thread/unsubscribe", { threadId: binding.threadId }, {
            mutating: true,
            expectedConnection: connection,
            expectedBackendGeneration: binding.backendGeneration,
            beforeWrite() {
              beforeWriteRan = true;
              guard();
              guardPassed = true;
            },
          });
          if (!guardPassed) {
            Promise.resolve(response).catch(() => {});
            fail("UNSUBSCRIBE_WRITE_GUARD_NOT_RUN");
          }
          const result = await response;
          const knownStatus = ["unsubscribed", "notSubscribed", "notLoaded"].includes(result?.status);
          outcome = { ...outcome, state: knownStatus ? "VERIFIED" : "UNKNOWN", result, finishedAt: now(), retryAllowed: false };
        } catch (error) {
          const guardedRejection = beforeWriteRan && !guardPassed && error instanceof ThreadUnsubscribeControlError;
          const classification = guardedRejection ? { state: "NOT_WRITTEN", retryAllowed: false } : classifyUnsubscribeError(error);
          outcome = { ...outcome, ...classification, error: errorEvidence(error), finishedAt: now() };
        }
        try {
          writeJournal(key, outcome);
        } catch (error) {
          return { ...outcome, state: "UNKNOWN", retryAllowed: false, persistenceError: errorEvidence(error) };
        }
        return structuredClone(outcome);
      });
    });
  }

  return Object.freeze({ prepare, execute });
}
