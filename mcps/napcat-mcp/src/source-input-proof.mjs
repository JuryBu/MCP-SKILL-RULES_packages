import crypto from "node:crypto";

const registered = new WeakMap();
const hashText = value => crypto.createHash("sha256").update(value).digest("hex");
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

function abortIfNeeded(signal) {
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("Request aborted"), { code: "ABORT_ERR" });
}

function digestList() {
  const hash = crypto.createHash("sha256").update("[");
  let count = 0;
  return {
    add(value) { if (count++) hash.update(","); hash.update(JSON.stringify(value)); },
    finish() { return hash.digest("hex"); },
    close() { hash.update("]"); return this.finish(); }
  };
}

export function sourceInputProof(payload) {
  return payload && typeof payload === "object" ? registered.get(payload) ?? null : null;
}

export async function createSourceInputProof({ model, previousResponseId, inputIsIncremental = typeof previousResponseId === "string", records, compactionHash = null, signal }) {
  if (typeof records !== "function") throw new TypeError("A repeatable input record iterator is required");
  const versionOne = digestList();
  const versionTwo = digestList();
  const tailOne = [];
  const tailTwo = [];
  let length = 0;
  for await (const record of records()) {
    abortIfNeeded(signal);
    if (record.index !== length || !validHash(record.hashV1) || !validHash(record.hashV2)) {
      throw Object.assign(new Error("Invalid indexed input proof"), { code: "INVALID_SOURCE_INPUT_PROOF" });
    }
    versionOne.add(record.hashV1);
    versionTwo.add(record.hashV2);
    tailOne.push(record.hashV1);
    tailTwo.push(record.hashV2);
    if (tailOne.length > 4) tailOne.shift();
    if (tailTwo.length > 4) tailTwo.shift();
    length += 1;
  }
  const hashOne = versionOne.close();
  const hashTwo = versionTwo.close();
  const modelHash = typeof model === "string" ? hashText(model) : null;
  const continuation = typeof model === "string" && model && length ? { modelHash, inputTail: tailOne, inputLength: length, inputHash: hashOne,
    inputComparison: { version: 2, inputTail: tailTwo, inputLength: length, inputHash: hashTwo },
    inputIsIncremental, tools: [], completedTools: [] } : null;
  const preparedEntries = new WeakMap();
  const preparedCheckpoints = new WeakMap();

  async function inputHash(start, end, version) {
    const digest = digestList();
    let count = 0;
    for await (const record of records({ start, end })) {
      abortIfNeeded(signal);
      if (record.index < start) continue;
      if (record.index >= end) break;
      digest.add(version === 1 ? record.hashV1 : record.hashV2);
      count += 1;
    }
    return count === end - start ? digest.close() : null;
  }

  async function includesReceipts(receipts, start = 0) {
    if (!Array.isArray(receipts)) return false;
    if (!receipts.length) return true;
    const pending = new Map(receipts.map((receipt, index) => [index, { receipt, callIndex: null }]));
    for await (const record of records({ start })) {
      abortIfNeeded(signal);
      if (record.index < start) continue;
      for (const [index, match] of pending) {
        if (record.toolReceipt?.callHash === match.receipt.callHash
          && record.toolReceipt.callIdHash === match.receipt.callIdHash) match.callIndex ??= record.index;
        if (match.callIndex !== null && record.index > match.callIndex
          && record.outputReceipt?.type === match.receipt.outputType
          && record.outputReceipt.callIdHash === match.receipt.callIdHash && record.outputReceipt.hasOutput === true) pending.delete(index);
      }
      if (!pending.size) return true;
    }
    return false;
  }

  async function textContinuation(start) {
    let hasText = false;
    for await (const record of records({ start })) {
      abortIfNeeded(signal);
      if (record.index < start) continue;
      if (record.isAssistantText === true) hasText = true;
      else if (record.isReasoning !== true) return false;
    }
    return hasText;
  }

  async function checkContinuation(entry, valid) {
    const proof = entry?.continuation;
    if (!valid || entry.phase !== "unresolved" || entry.requiresReconciliation === true
      || modelHash !== proof?.modelHash || !continuation) return false;
    const comparison = proof.inputComparison ?? proof;
    const window = [];
    for await (const record of records()) {
      abortIfNeeded(signal);
      window.push(proof.inputComparison ? record.hashV2 : record.hashV1);
      if (window.length > comparison.inputTail.length) window.shift();
      if (window.length !== comparison.inputTail.length
        || !comparison.inputTail.every((hash, index) => hash === window[index])) continue;
      const tailEnd = record.index + 1;
      if (comparison.inputHash !== undefined) {
        const inputStart = tailEnd - comparison.inputLength;
        if (inputStart < 0 || !proof.inputIsIncremental && inputStart !== 0
          || await inputHash(inputStart, tailEnd, proof.inputComparison ? 2 : 1) !== comparison.inputHash) continue;
      }
      if (!proof.tools.length) {
        if (comparison.inputHash && await textContinuation(tailEnd)) return true;
      } else if (await includesReceipts(proof.tools, tailEnd)) return true;
    }
    return false;
  }

  async function checkCheckpoint(checkpoint) {
    if (modelHash !== checkpoint?.modelHash) return false;
    if (typeof checkpoint.responseId === "string" && previousResponseId === checkpoint.responseId) return true;
    if (await includesReceipts(checkpoint.tools)) return true;
    const compact = checkpoint.compaction;
    return compact?.version === 1 && validHash(compact.hash) && Number.isSafeInteger(compact.toolCount)
      && compact.toolCount >= 0 && compact.toolCount <= checkpoint.tools.length
      && compactionHash === compact.hash && await includesReceipts(checkpoint.tools.slice(compact.toolCount));
  }

  return {
    model, length, modelHash, inputHash: hashTwo, compactionHash,
    continuationState() { return continuation ? structuredClone(continuation) : null; },
    register(payload) {
      if (!payload || typeof payload !== "object") throw new TypeError("A source payload handle is required");
      registered.set(payload, this);
      if (payload.input && typeof payload.input === "object") registered.set(payload.input, this);
      return payload;
    },
    async prepare({ entry, checkpoint, entryValid = false }) {
      if (entry && !preparedEntries.has(entry)) preparedEntries.set(entry, await checkContinuation(entry, entryValid));
      if (checkpoint && !preparedCheckpoints.has(checkpoint)) preparedCheckpoints.set(checkpoint, await checkCheckpoint(checkpoint));
    },
    canContinue(entry) { return preparedEntries.get(entry) === true; },
    checkpointAccepts(checkpoint) { return preparedCheckpoints.get(checkpoint) === true; },
    async extendsClaim(previous) {
      const previousProof = previous?.sourceProof;
      const previousLength = previousProof?.length ?? previous?.hashes?.length;
      if (model !== previous?.model || !Number.isSafeInteger(previousLength) || length <= previousLength) return false;
      if (previousProof) {
        if (await inputHash(0, previousLength, 2) !== previousProof.inputHash) return false;
      } else {
        for await (const record of records({ end: previousLength })) {
          abortIfNeeded(signal);
          if (record.index >= previousLength) break;
          if (record.hashV2 !== previous.hashes[record.index]) return false;
        }
      }
      for await (const record of records({ start: previousLength })) {
        abortIfNeeded(signal);
        if (record.index >= previousLength && record.isUser === true) return true;
      }
      return false;
    },
    async isPrefixOfClaim(incoming) {
      if (incoming?.model !== model || !Array.isArray(incoming.hashes) || incoming.hashes.length <= length) return false;
      const digest = digestList();
      for (let index = 0; index < length; index += 1) digest.add(incoming.hashes[index]);
      return digest.close() === hashTwo && incoming.users.slice(length).some(Boolean);
    },
    claim() { return { sourceProof: this, model, hashes: { length } }; }
  };
}
