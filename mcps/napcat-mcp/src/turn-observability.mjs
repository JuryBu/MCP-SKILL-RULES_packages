import { correlationQuality, hashIdentity } from "./observability-utils.mjs";

const DEFAULT_FIRST_OUTPUT_TIMEOUT_MS = 60_000;

function rpcKey(value) {
  if (typeof value === "string" || typeof value === "number") return `${typeof value}:${value}`;
  return null;
}

function turnIdentity(message) {
  const params = message?.params ?? {};
  const turn = params.turn ?? message?.result?.turn ?? {};
  return {
    threadId: params.threadId ?? turn.threadId ?? message?.result?.threadId ?? null,
    turnId: params.turnId ?? turn.id ?? message?.result?.turnId ?? null,
    status: turn.status ?? null,
  };
}

function meaningfulNotification(method) {
  return typeof method === "string" && (
    method.startsWith("item/")
    || method === "turn/plan/updated"
    || method === "turn/diff/updated"
  );
}

export function createTurnLifecycleObserver(options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? DEFAULT_FIRST_OUTPUT_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new Error("timeoutMs must be an integer between 1 and 300000");
  }
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimeoutImpl ?? setTimeout;
  const clearTimer = options.clearTimeoutImpl ?? clearTimeout;
  const onAnomaly = typeof options.onAnomaly === "function" ? options.onAnomaly : () => {};
  const byRequest = new Map();
  const byTurn = new Map();
  const counters = { observed: 0, meaningful: 0, deadlines: 0, recoveredAfterDeadline: 0, terminalWithoutOutput: 0 };

  const elapsedMs = (trace) => Math.max(0, new Date(now()).getTime() - trace.acceptedAtMs);
  const eventBase = (trace) => ({
    threadHash: trace.threadHash,
    turnHash: trace.turnHash,
    correlation: correlationQuality(trace.threadHash, trace.turnHash),
    acceptedAt: new Date(trace.acceptedAtMs).toISOString(),
    elapsedMs: elapsedMs(trace),
    forwarded: trace.forwarded,
    appServerAccepted: trace.appServerAccepted,
    turnStarted: trace.turnStarted,
  });
  const emit = (trace, type, details = {}) => onAnomaly({ type, ...eventBase(trace), ...details });
  const discard = (trace) => {
    clearTimer(trace.timer);
    if (trace.requestKey) byRequest.delete(trace.requestKey);
    if (trace.turnHash) byTurn.delete(trace.turnHash);
  };
  const findTrace = (message) => {
    const identity = turnIdentity(message);
    const turnHash = hashIdentity(identity.turnId);
    if (turnHash && byTurn.has(turnHash)) return { trace: byTurn.get(turnHash), identity };
    const threadHash = hashIdentity(identity.threadId);
    const candidates = [...byRequest.values()].filter((trace) => trace.threadHash === threadHash && !trace.turnHash);
    return { trace: candidates.length === 1 ? candidates[0] : null, identity };
  };

  return {
    observeDownstream(message) {
      if (message?.method !== "turn/start" || !message?.params?.threadId) return;
      const requestKey = rpcKey(message.id);
      if (!requestKey || byRequest.has(requestKey)) return;
      const trace = {
        requestKey,
        threadHash: hashIdentity(message.params.threadId),
        turnHash: null,
        acceptedAtMs: new Date(now()).getTime(),
        forwarded: false,
        appServerAccepted: false,
        turnStarted: false,
        deadlineExceeded: false,
        timer: null,
      };
      trace.timer = setTimer(() => {
        trace.deadlineExceeded = true;
        counters.deadlines += 1;
        emit(trace, "app_server_turn_first_output_deadline_exceeded", { timeoutMs });
      }, timeoutMs);
      trace.timer.unref?.();
      byRequest.set(requestKey, trace);
      counters.observed += 1;
    },
    markForwarded(message) {
      const trace = byRequest.get(rpcKey(message?.id));
      if (message?.method === "turn/start" && trace) trace.forwarded = true;
    },
    observeUpstream(message) {
      const requestKey = rpcKey(message?.id);
      if (requestKey && byRequest.has(requestKey)) {
        const trace = byRequest.get(requestKey);
        if (message.error) {
          emit(trace, "app_server_turn_start_rejected", { rpcCode: message.error.code ?? null });
          discard(trace);
          return;
        }
        const identity = turnIdentity(message);
        trace.turnHash = hashIdentity(identity.turnId);
        trace.appServerAccepted = true;
        if (trace.turnHash) byTurn.set(trace.turnHash, trace);
        if (["completed", "failed", "interrupted", "cancelled"].includes(String(identity.status).toLowerCase())) {
          counters.terminalWithoutOutput += 1;
          emit(trace, "app_server_turn_completed_without_meaningful_output", { status: identity.status });
          discard(trace);
        }
        return;
      }
      if (!message?.method) return;
      const { trace, identity } = findTrace(message);
      if (!trace) return;
      if (message.method === "turn/started") {
        trace.turnStarted = true;
        return;
      }
      if (meaningfulNotification(message.method)) {
        counters.meaningful += 1;
        if (trace.deadlineExceeded) {
          counters.recoveredAfterDeadline += 1;
          emit(trace, "app_server_turn_first_output_recovered_after_deadline", { firstMeaningfulMethod: message.method });
        }
        discard(trace);
        return;
      }
      if (message.method === "turn/completed") {
        counters.terminalWithoutOutput += 1;
        emit(trace, trace.deadlineExceeded
          ? "app_server_turn_ended_after_deadline"
          : "app_server_turn_completed_without_meaningful_output", { status: identity.status });
        discard(trace);
      }
    },
    close(reason = "observer_closed") {
      for (const trace of new Set(byRequest.values())) {
        if (trace.deadlineExceeded) emit(trace, "app_server_turn_observation_abandoned", { reason });
        discard(trace);
      }
    },
    status() {
      return { timeoutMs, active: byRequest.size, counters: { ...counters } };
    },
  };
}
