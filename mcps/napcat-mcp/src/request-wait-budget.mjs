const MEBIBYTE = 1024 * 1024;
const MAX_PROGRESS_RESPONSES = 64;
const MAX_COMPLETED_PROGRESS_ITEMS = 4096;

export function mergeRequestProgressState(previous = {}, update = {}) {
  const sequences = new Map(previous?.sequences ?? []);
  let saturated = Boolean(previous?.saturated || update?.saturated);
  for (const [identity, sequence] of update?.sequences ?? []) {
    if (!sequences.has(identity) && sequences.size >= MAX_PROGRESS_RESPONSES) saturated = true;
    else sequences.set(identity, Math.max(sequences.get(identity) ?? -1, sequence));
  }
  const completedItems = new Set(previous?.completedItems ?? []);
  for (const identity of update?.completedItems ?? []) {
    if (!completedItems.has(identity) && completedItems.size >= MAX_COMPLETED_PROGRESS_ITEMS) saturated = true;
    else completedItems.add(identity);
  }
  return { sequences: [...sequences], completedItems: [...completedItems], saturated };
}

export function createRequestProgressTracker(previous, attemptIdentity) {
  const state = mergeRequestProgressState({}, previous);
  const sequences = new Map(state.sequences);
  const completedItems = new Set(state.completedItems);
  let saturated = state.saturated;
  let responseIdentity = null;
  return {
    observe(event) {
      if (!event || typeof event !== "object") return false;
      const explicitIdentity = event.response_id ?? event.response?.id;
      if (typeof explicitIdentity === "string" && explicitIdentity) responseIdentity = explicitIdentity;
      const scope = responseIdentity ?? attemptIdentity;
      if (Number.isSafeInteger(event.sequence_number) && event.sequence_number >= 0) {
        const sequence = event.sequence_number;
        if (sequence <= (sequences.get(scope) ?? -1)) return false;
        if (!sequences.has(scope) && (saturated || sequences.size >= MAX_PROGRESS_RESPONSES)) {
          saturated = true;
          return false;
        }
        sequences.set(scope, sequence);
      }
      if (["response.output_item.done", "response.function_call_arguments.done"].includes(event.type)) {
        const itemIdentity = event.item_id ?? event.item?.id;
        if (typeof itemIdentity === "string" && itemIdentity) {
          const identity = JSON.stringify([scope, event.type, itemIdentity]);
          if (completedItems.has(identity)) return false;
          if (saturated || completedItems.size >= MAX_COMPLETED_PROGRESS_ITEMS) {
            saturated = true;
            return false;
          }
          completedItems.add(identity);
        }
      }
      return true;
    },
    snapshot: () => ({ sequences: [...sequences], completedItems: [...completedItems], saturated }),
  };
}

export function requestUploadAllowanceMs(encodedBytes, millisecondsPerMiB = 1000, maximumMs = 128_000) {
  if (![encodedBytes, millisecondsPerMiB, maximumMs].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new RangeError("Upload allowance inputs must be nonnegative safe integers");
  }
  return Math.min(maximumMs, Math.ceil(encodedBytes / MEBIBYTE * millisecondsPerMiB));
}

export function mergeRequestWaitState(previous = {}, update = {}) {
  const previousProgressAt = previous.waitBudgetProgressAt ?? 0;
  const updateProgressAt = update.waitBudgetProgressAt ?? 0;
  const progressAt = Math.max(previousProgressAt, updateProgressAt);
  const spentMs = updateProgressAt > previousProgressAt ? update.waitBudgetSpentMs ?? 0
    : updateProgressAt < previousProgressAt ? previous.waitBudgetSpentMs ?? 0
      : Math.max(previous.waitBudgetSpentMs ?? 0, update.waitBudgetSpentMs ?? 0);
  return { waitBudgetProgressAt: progressAt, waitBudgetSpentMs: spentMs };
}

export function createRequestWaitBudget({ startedAt, uploadAllowanceMs, waitLimitMs, previous = {} }) {
  const previousState = previous ?? {};
  let anchorAt = startedAt;
  let allowanceMs = uploadAllowanceMs;
  let spentMs = previousState.waitBudgetSpentMs ?? 0;
  let progressAt = previousState.waitBudgetProgressAt ?? 0;
  let firstProgressAt = null;
  return {
    noteProgress(time) {
      const first = firstProgressAt === null;
      firstProgressAt ??= time;
      anchorAt = time;
      allowanceMs = 0;
      spentMs = 0;
      progressAt = time;
      return first;
    },
    hasProgress: () => firstProgressAt !== null,
    firstProgressDelayMs: () => firstProgressAt === null ? null : firstProgressAt - startedAt,
    deadline: () => anchorAt + allowanceMs + Math.max(0, waitLimitMs - spentMs),
    remainingMs(time) {
      return Math.max(0, waitLimitMs - spentMs - Math.max(0, time - anchorAt - allowanceMs));
    },
    snapshot(time) {
      return { waitBudgetProgressAt: progressAt,
        waitBudgetSpentMs: Math.min(waitLimitMs, spentMs + Math.max(0, time - anchorAt - allowanceMs)) };
    },
  };
}
