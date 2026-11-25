import crypto from "node:crypto";
import { normalizeInputItemMetadataForComparison } from "./model-input-comparison.mjs";
import { sourceInputProof } from "./source-input-proof.mjs";

const validReason = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value);
const clone = value => JSON.parse(JSON.stringify(value));
const operationHash = key => crypto.createHash("sha256").update(key).digest("hex");
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const maxContinuationTools = 1024;

function itemHash(item, version = 2) {
  const comparable = normalizeInputItemMetadataForComparison(item, { version });
  return operationHash(JSON.stringify(comparable, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value));
}

function toolReceipt(item) {
  if (!["function_call", "custom_tool_call"].includes(item?.type)
    || typeof item.call_id !== "string" || !item.call_id || typeof item.name !== "string" || !item.name) return null;
  const content = item.type === "function_call" ? item.arguments : item.input;
  if (typeof content !== "string") return null;
  return { callIdHash: operationHash(item.call_id), callHash: itemHash({ type: item.type, call_id: item.call_id,
    name: item.name, content }), outputType: item.type === "function_call" ? "function_call_output" : "custom_tool_call_output" };
}

function continuationState(payload) {
  const source = sourceInputProof(payload);
  if (source) return source.continuationState();
  if (typeof payload?.model !== "string" || !payload.model || !Array.isArray(payload.input) || !payload.input.length) return null;
  const inputHashes = payload.input.map(item => itemHash(item, 1));
  const comparisonHashes = payload.input.map(item => itemHash(item));
  return { modelHash: operationHash(payload.model), inputTail: inputHashes.slice(-4),
    inputLength: inputHashes.length, inputHash: operationHash(JSON.stringify(inputHashes)),
    inputComparison: { version: 2, inputTail: comparisonHashes.slice(-4), inputLength: comparisonHashes.length,
      inputHash: operationHash(JSON.stringify(comparisonHashes)) },
    inputIsIncremental: typeof payload.previous_response_id === "string", tools: [], completedTools: [] };
}

function validContinuation(value) {
  return value && typeof value === "object" && !Array.isArray(value) && validHash(value.modelHash)
    && Array.isArray(value.inputTail) && value.inputTail.length > 0 && value.inputTail.length <= 4 && value.inputTail.every(validHash)
    && (value.inputHash === undefined && value.inputLength === undefined
      || validHash(value.inputHash) && Number.isSafeInteger(value.inputLength) && value.inputLength > 0)
    && (value.inputIsIncremental === undefined || typeof value.inputIsIncremental === "boolean")
    && (value.inputComparison === undefined || value.inputComparison?.version === 2
      && value.inputComparison.inputLength === value.inputLength && validHash(value.inputComparison.inputHash)
      && Array.isArray(value.inputComparison.inputTail) && value.inputComparison.inputTail.length === value.inputTail.length
      && value.inputComparison.inputTail.every(validHash))
    && (value.compaction === undefined || validCompaction(value.compaction, value.completedTools))
    && [value.tools, value.completedTools].every(receipts => Array.isArray(receipts) && receipts.length <= maxContinuationTools
      && receipts.every(receipt => receipt && validHash(receipt.callIdHash) && validHash(receipt.callHash)
        && ["function_call_output", "custom_tool_call_output"].includes(receipt.outputType)));
}

function canContinue(entry, payload) {
  const source = sourceInputProof(payload);
  if (source) return source.canContinue(entry);
  const proof = entry?.continuation;
  if (entry?.phase !== "unresolved" || entry.requiresReconciliation === true || !validContinuation(proof)
    || typeof payload?.model !== "string" || operationHash(payload.model) !== proof.modelHash || !Array.isArray(payload.input)) return false;
  const comparison = proof.inputComparison ?? proof;
  const hashes = payload.input.map(item => itemHash(item, proof.inputComparison ? 2 : 1));
  const receipts = payload.input.map(toolReceipt);
  for (let start = 0; start <= hashes.length - comparison.inputTail.length; start++) {
    if (!comparison.inputTail.every((hash, offset) => hashes[start + offset] === hash)) continue;
    const tailEnd = start + comparison.inputTail.length;
    if (comparison.inputHash !== undefined) {
      const inputStart = tailEnd - comparison.inputLength;
      if (inputStart < 0 || !proof.inputIsIncremental && inputStart !== 0
        || operationHash(JSON.stringify(hashes.slice(inputStart, tailEnd))) !== comparison.inputHash) continue;
    }
    if (!proof.tools.length) {
      if (!comparison.inputHash) continue;
      const continuation = payload.input.slice(tailEnd);
      const textItem = item => item?.type === "message" && item.role === "assistant"
        && (item.status === undefined || item.status === "completed") && Array.isArray(item.content) && item.content.length > 0
        && item.content.every(part => part?.type === "output_text" && typeof part.text === "string")
        && item.content.some(part => part.text.length > 0);
      if (continuation.some(textItem) && continuation.every(item => textItem(item)
        || item?.type === "reasoning" && (item.status === undefined || item.status === "completed"))) return true;
      continue;
    }
    if (proof.tools.every(receipt => receipts.some((candidate, index) => index >= tailEnd
      && candidate?.callHash === receipt.callHash && candidate.callIdHash === receipt.callIdHash
      && payload.input.some((item, outputIndex) => outputIndex > index && item?.type === receipt.outputType
        && typeof item.call_id === "string" && operationHash(item.call_id) === receipt.callIdHash
        && Object.hasOwn(item, "output"))))) return true;
  }
  return false;
}

function includesToolResults(receipts, payload) {
  if (!Array.isArray(payload?.input)) return false;
  const incoming = payload.input.map(toolReceipt);
  return receipts.every(receipt => incoming.some((candidate, index) => candidate?.callHash === receipt.callHash
    && candidate.callIdHash === receipt.callIdHash && payload.input.some((item, outputIndex) => outputIndex > index
      && item?.type === receipt.outputType && typeof item.call_id === "string" && operationHash(item.call_id) === receipt.callIdHash
      && Object.hasOwn(item, "output"))));
}

function validCompaction(proof, tools) {
  return proof?.version === 1 && validHash(proof.hash) && Array.isArray(tools)
    && Number.isSafeInteger(proof.toolCount) && proof.toolCount >= 0 && proof.toolCount <= tools.length;
}

function compactionHash(input) {
  const source = sourceInputProof(input);
  if (source) return source.compactionHash;
  if (!Array.isArray(input)) return null;
  const digest = crypto.createHash("sha256");
  let count = 0;
  for (const item of input) {
    if (item?.type !== "compaction") continue;
    if (typeof item.encrypted_content !== "string" || !item.encrypted_content) return null;
    const encoded = JSON.stringify({ id: typeof item.id === "string" ? item.id : null,
      encrypted_content: item.encrypted_content });
    digest.update(`${Buffer.byteLength(encoded)}:`).update(encoded);
    count += 1;
  }
  return count ? digest.digest("hex") : null;
}

function checkpointAccepts(checkpoint, payload) {
  const source = sourceInputProof(payload);
  if (source) return source.checkpointAccepts(checkpoint);
  if (typeof payload?.model !== "string" || operationHash(payload.model) !== checkpoint.modelHash) return false;
  if (typeof checkpoint.responseId === "string" && payload.previous_response_id === checkpoint.responseId) return true;
  if (includesToolResults(checkpoint.tools, payload)) return true;
  return validCompaction(checkpoint.compaction, checkpoint.tools)
    && compactionHash(payload.input) === checkpoint.compaction.hash
    && includesToolResults(checkpoint.tools.slice(checkpoint.compaction.toolCount), payload);
}

export function createModelOperationLedger({ state, onStateChange, maxEntries = 2048, now = Date.now } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000) {
    throw new RangeError("Invalid operation ledger capacity");
  }
  const entries = new Map();
  const completed = new Map();
  const compactionTickets = new WeakMap();
  const requestGeneration = Symbol("model-operation-request-generation");
  const snapshot = () => ({ schemaVersion: 1, entries: [...entries].map(([key, entry]) => [key, clone(entry)]) });
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
        || entry.threadHash !== undefined && !validHash(entry.threadHash)
        || entry.continuation !== undefined && !validContinuation(entry.continuation)
        || entry.requiresReconciliation !== undefined && entry.requiresReconciliation !== true
        || entry.reconciliationProof !== undefined
          && (entry.requiresReconciliation !== true || !validContinuation(entry.reconciliationProof))) {
        throw new Error("INVALID_MODEL_OPERATION_STATE");
      }
      restored.set(key, { phase: "unresolved", acceptance: entry.acceptance,
        reason: "previous_proxy_interrupted", updatedAt: entry.updatedAt,
        ...(entry.threadHash ? { threadHash: entry.threadHash } : {}),
        ...(entry.requiresReconciliation === true ? { requiresReconciliation: true,
          ...(entry.reconciliationProof || entry.continuation
            ? { reconciliationProof: clone(entry.reconciliationProof ?? entry.continuation) } : {}) }
          : entry.continuation ? { continuation: clone(entry.continuation) } : {}) });
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
      return entry ? clone(entry) : null;
    },
    canContinue(key, payload) { return canContinue(entries.get(operationHash(key)), payload); },
    async prepareSource(key, payload, turnKey = null) {
      const source = sourceInputProof(payload);
      if (!source) return;
      const hash = operationHash(key);
      const entry = entries.get(hash);
      await source.prepare({ entry, checkpoint: completed.get(hash), entryValid: validContinuation(entry?.continuation) });
      if (turnKey && turnKey !== key) await source.prepare({ checkpoint: completed.get(operationHash(turnKey)) });
    },
    begin(key, payload) {
      const hash = operationHash(key);
      const previous = entries.get(hash);
      if (previous && !canContinue(previous, payload)) throw Object.assign(new Error("MODEL_OPERATION_REPLAY_BLOCKED"), { code: "MODEL_OPERATION_REPLAY_BLOCKED" });
      const checkpoint = completed.get(hash);
      if (!previous && checkpoint && !checkpointAccepts(checkpoint, payload)) {
        throw Object.assign(new Error("MODEL_OPERATION_REPLAY_BLOCKED"), { code: "MODEL_OPERATION_REPLAY_BLOCKED" });
      }
      if (!previous && entries.size >= maxEntries) throw Object.assign(new Error("MODEL_OPERATION_LEDGER_FULL"), { code: "MODEL_OPERATION_LEDGER_FULL" });
      const continuation = continuationState(payload);
      if (continuation && previous?.continuation) {
        continuation.completedTools = [...previous.continuation.completedTools, ...previous.continuation.tools];
        if (previous.continuation.compaction) continuation.compaction = clone(previous.continuation.compaction);
        if (continuation.completedTools.length > maxContinuationTools) {
          throw Object.assign(new Error("MODEL_OPERATION_LEDGER_FULL"), { code: "MODEL_OPERATION_LEDGER_FULL" });
        }
      } else if (continuation && checkpoint) {
        continuation.completedTools = clone(checkpoint.tools);
        if (checkpoint.compaction) continuation.compaction = clone(checkpoint.compaction);
      }
      entries.set(hash, { [requestGeneration]: {}, phase: "submitting", acceptance: "unknown", reason: "request_submitting", updatedAt: now(),
        threadHash: operationHash(key.split("\u0000")[0]), ...(continuation ? { continuation } : {}) });
      try { save(); } catch (error) { if (previous) entries.set(hash, previous); else entries.delete(hash); throw error; }
    },
    captureCompaction(turnKey, requestKey, payload) {
      if (typeof turnKey !== "string" || typeof requestKey !== "string"
        || turnKey.split("\u0000").slice(0, 2).join("\u0000") !== requestKey.split("\u0000").slice(0, 2).join("\u0000")) return null;
      const turnHash = operationHash(turnKey);
      const requestHash = operationHash(requestKey);
      const checkpoint = completed.get(turnHash);
      const request = entries.get(requestHash);
      const proposed = continuationState(payload);
      if (!checkpoint || !request || request.phase !== "submitting" || !proposed
        || request.continuation?.inputComparison?.inputHash !== proposed.inputComparison.inputHash
        || request.continuation.modelHash !== proposed.modelHash
        || turnHash !== requestHash && entries.has(turnHash) || !checkpointAccepts(checkpoint, payload)) return null;
      const ticket = Object.freeze({});
      compactionTickets.set(ticket, { turnHash, requestHash, checkpoint, request, generation: request[requestGeneration] });
      return ticket;
    },
    settleCompaction(ticket, requestKey, outcome, event) {
      const proof = ticket && compactionTickets.get(ticket);
      if (ticket) compactionTickets.delete(ticket);
      const requestHash = operationHash(requestKey);
      if (!proof || proof.requestHash !== requestHash
        || entries.get(requestHash)?.[requestGeneration] !== proof.generation) return false;
      const hash = outcome.kind === "completed" && event?.type === "response.completed"
        && event.response?.status === "completed" && !event.error && !event.response.error
        && Array.isArray(event.response.output) && !event.response.output.some(item => toolReceipt(item))
        ? compactionHash(event.response.output) : null;
      const authorized = proof && proof.requestHash === requestHash && entries.get(requestHash) === proof.request
        && completed.get(proof.turnHash) === proof.checkpoint
        && (proof.turnHash === requestHash || !entries.has(proof.turnHash)) && hash;
      this.settle(requestKey, outcome);
      if (!authorized || entries.has(proof.turnHash)) return false;
      const checkpoint = completed.get(proof.turnHash);
      if (!checkpoint || proof.turnHash !== requestHash && checkpoint !== proof.checkpoint) return false;
      completed.set(proof.turnHash, { ...checkpoint,
        compaction: { version: 1, hash, toolCount: checkpoint.tools.length } });
      return true;
    },
    recordTool(key, item) {
      const hash = operationHash(key);
      const previous = entries.get(hash);
      const receipt = toolReceipt(item);
      if (!previous?.continuation || !receipt) return false;
      if (previous.continuation.completedTools.some(value => value.callIdHash === receipt.callIdHash)
        || previous.continuation.tools.some(value => value.callIdHash === receipt.callIdHash)) {
        throw Object.assign(new Error("MODEL_TOOL_REPLAY_BLOCKED"), { code: "MODEL_TOOL_REPLAY_BLOCKED", httpStatus: 409 });
      }
      if (previous.continuation.tools.length >= maxContinuationTools
        || previous.continuation.compaction
          && previous.continuation.completedTools.length + previous.continuation.tools.length >= maxContinuationTools) {
        throw Object.assign(new Error("MODEL_OPERATION_LEDGER_FULL"), { code: "MODEL_OPERATION_LEDGER_FULL" });
      }
      entries.set(hash, { ...previous, continuation: { ...previous.continuation,
        tools: [...previous.continuation.tools, receipt] }, updatedAt: now() });
      try { save(); } catch (error) { entries.set(hash, previous); throw error; }
      return true;
    },
    settle(key, outcome) {
      const hash = operationHash(key);
      if (!entries.has(hash)) return;
      if (outcome.localRejection && entries.get(hash).phase !== "submitting") return;
      const acceptance = outcome.policy?.acceptance ?? "unknown";
      const replayableWithoutTool = outcome.kind === "cancelled" || outcome.policy?.retryable === true
        || (["temporary", "acceptance_unknown"].includes(outcome.policy?.category)
          && !outcome.deliveredExecutableToolDone && !outcome.sawCompaction);
      const requiresReconciliation = entries.get(hash).requiresReconciliation === true
        || outcome.requiresReconciliation === true && ["accepted", "unknown"].includes(acceptance);
      if (!requiresReconciliation && (outcome.localRejection || outcome.kind === "completed" || ["rejected", "not_sent"].includes(acceptance)
        || outcome.policy?.terminalOutcome === "failed_no_output" || replayableWithoutTool)) {
        const previous = entries.get(hash);
        entries.delete(hash);
        try { save(); } catch (error) { entries.set(hash, previous); error.requestAccepted = acceptance; throw error; }
        const tools = previous.continuation?.compaction
          ? [...previous.continuation.completedTools, ...previous.continuation.tools] : previous.continuation?.completedTools;
        if (outcome.kind === "completed" && tools?.length) {
          completed.delete(hash);
          completed.set(hash, { modelHash: previous.continuation.modelHash, tools: clone(tools),
            responseId: typeof outcome.responseId === "string" && outcome.responseId ? outcome.responseId : null,
            ...(previous.continuation.compaction ? { compaction: clone(previous.continuation.compaction) } : {}) });
          if (completed.size > maxEntries) completed.delete(completed.keys().next().value);
        }
        return;
      }
      const previous = entries.get(hash);
      const unresolved = { ...previous, phase: "unresolved", acceptance: acceptance === "accepted" ? "accepted" : "unknown",
        reason: validReason(outcome.policy?.reasonCode) ? outcome.policy.reasonCode : "upstream_acceptance_unresolved",
        updatedAt: now() };
      if (requiresReconciliation) {
        unresolved.requiresReconciliation = true;
        const proof = previous.reconciliationProof ?? previous.continuation;
        if (proof) unresolved.reconciliationProof = clone(proof);
        delete unresolved.continuation;
      }
      entries.set(hash, unresolved);
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
        const merged = { ...entry, acceptance: previous?.acceptance === "accepted" ? "accepted" : entry.acceptance };
        if (previous?.requiresReconciliation === true) {
          merged.requiresReconciliation = true;
          delete merged.continuation;
          if (previous.reconciliationProof) merged.reconciliationProof = clone(previous.reconciliationProof);
          else delete merged.reconciliationProof;
        }
        entries.set(key, merged);
      }
      save();
      return incoming.size;
    },
    snapshot() { return clone(snapshot()); },
    status() { return { protectedOperations: entries.size, maxEntries, persistent: typeof onStateChange === "function" }; },
  };
}
