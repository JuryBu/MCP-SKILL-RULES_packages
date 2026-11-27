import crypto from "node:crypto";
import { createStreamRecovery } from "./codex-stream-recovery.mjs";
import { rootSourcePayload, isRootInputProjection, combineRootInputs, retainRootInput, releaseRootInput,
  rootInputBytes, projectRootSourcePayload, rootHasInputArray, rootHasCompactionTrigger } from "./source-root-admission.mjs";

export const rootAdmissionProtocolSupported = value => value?.version === 1 && typeof value.localStream === "function";
export const isInterruptedResponse = (event, responseId) => event?.type === "response.incomplete"
  && typeof responseId === "string" && event.response?.id === responseId
  && event.response?.status === "incomplete" && event.response?.incomplete_details?.reason === "interrupted"
  && Array.isArray(event.response.output) && !event.error && !event.response.error;
const rootResponsePrefix = "resp_proxy_root_";
const ordinary = (metadata, payload, requestPath, headers = {}) => (metadata?.request_kind === undefined || metadata.request_kind === "turn")
  && ["/v1/responses", "/backend-api/codex/responses"].includes(String(requestPath).split("?")[0])
  && payload?.generate !== false && rootHasInputArray(payload) && !Object.hasOwn(payload, "compaction_trigger")
  && !rootHasCompactionTrigger(payload)
  && metadata.thread_source !== "memory_consolidation" && metadata.turn_trigger !== "memory_consolidation"
  && payload.client_metadata?.["x-openai-subagent"] !== "memory_consolidation"
  && !Object.entries(headers).some(([key, value]) => key.toLowerCase() === "x-codex-internal-memory-connection"
    || key.toLowerCase() === "x-openai-subagent" && value === "memory_consolidation");
const failure = code => Object.assign(new Error(code), { code });
const rootStructureRejectionCodes = new Set([
  "invalid_request_error",
  "invalid_request",
  "invalid_argument",
  "unsupported_parameter",
  "unsupported_value",
  "previous_response_not_found",
]);
const isPermanentStructureTerminal = event => {
  if (!event || !["error", "response.failed"].includes(event.type)) return false;
  const err = event.response?.error ?? event.error;
  if (!err || typeof err !== "object") return false;
  const errCode = String(err.code ?? "").toLowerCase();
  if (errCode === "context_length_exceeded") return false;
  const statuses = [
    event.status, event.status_code, event.statusCode, event.httpStatus, event.http_status,
    err.status, err.status_code, err.statusCode, err.httpStatus, err.http_status,
    event.response?.status, event.response?.status_code, event.response?.statusCode, event.response?.httpStatus, event.response?.http_status,
  ].map(value => typeof value === "string" && /^\d{3}$/u.test(value) ? Number(value) : value);
  return statuses.includes(400) || statuses.includes(422)
    || err.type === "invalid_request_error"
    || rootStructureRejectionCodes.has(errCode)
    || err.param === "input" || err.param === "previous_response_id";
};
const isExplicitNotSent = (terminalEvent, recovery) => {
  const entries = [terminalEvent, terminalEvent?.error, terminalEvent?.response?.error].filter(Boolean);
  const delivery = recovery?.clientDelivery?.();
  return !delivery?.clientCanContinue && !delivery?.progressObserved && !delivery?.toolDelivered
    && !(terminalEvent?.response?.id ?? terminalEvent?.response_id)
    && !entries.some(entry => entry.requiresReconciliation === true || entry.requestAccepted === true
      || entry.requestAccepted === "unknown" || ["generation_sent", "response_received", "unknown"].includes(entry.requestTransmissionState))
    && terminalEvent?.error?.operationAcceptance === "not_sent"
    && terminalEvent.error.requestTransmissionState === "not_sent" && terminalEvent.error.requestAccepted === false;
};

export function rootSseEvents(frames) {
  return frames.split(/\r?\n\r?\n/u).filter(Boolean).map(frame => JSON.parse(frame.split(/\r?\n/u)
    .filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")));
}

export function createRootAdmissionState({ getThread, getNativeIdentity, isNativeIdentityCurrent, isClosing,
  hasNativeIdentity = () => true, onProgress = () => {}, maxAnchorBytes = 64 * 1024 * 1024, maxRecords = 128,
  externalAnchorBytes = () => 0 }) {
  const records = new Map();
  const jobs = new Map();
  const anchors = new Map();
  let anchorBytes = 0;
  const sweepAnchors = () => {
    for (const [responseId, anchor] of anchors) {
      if (anchor.references.size || !anchor.consumedCompleted && isNativeIdentityCurrent(anchor.nativeIdentity)) continue;
      anchors.delete(responseId);
      anchorBytes -= anchor.bytes;
      void releaseRootInput(anchor.input);
    }
  };
  const retainAnchors = (job, selected) => {
    job.anchors ??= new Set();
    for (const [responseId, anchor] of selected) {
      anchor.references.add(job.id);
      job.anchors.add(responseId);
    }
  };
  const consumedAnchors = job => {
    for (const responseId of job.anchors ?? []) anchors.get(responseId)?.consumedTurns.add(job.metadata.turn_id);
  };
  const activeRecord = metadata => {
    const state = getThread(metadata?.thread_id);
    const record = records.get(metadata?.thread_id);
    return state?.phase === "active" && state.turnId === metadata?.turn_id && record?.state === state
      && record.start === state.start && record.turnId === state.turnId ? record : null;
  };
  const current = job => {
    const record = activeRecord(job?.metadata);
    if (!record || job.record && job.record !== record || isClosing() || job.isClosed()) return null;
    job.record ??= record;
    return record;
  };
  const authority = job => {
    const record = current(job);
    return record?.fresh && record.pin && isNativeIdentityCurrent(record.pin) ? record : null;
  };
  const pinnedRecord = job => {
    const record = current(job);
    return record?.pin && isNativeIdentityCurrent(record.pin) ? record : null;
  };
  const progress = (job, phase, fields = {}) => {
    if (phase === "resumed" && job.sequence === 0) return;
    if (!authority(job)) return;
    job.sequence += 1;
    onProgress(job, { phase, sequence: job.sequence, ...fields });
  };
  const end = job => {
    if (!job) return;
    job.ended = true;
    jobs.delete(job.id);
    for (const responseId of job.anchors ?? []) anchors.get(responseId)?.references.delete(job.id);
    sweepAnchors();
  };
  const wait = (operation, job) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (error) reject(error); else resolve(value);
    };
    let lastProgress = Date.now();
    const check = () => {
      const record = current(job);
      if (!record) return finish(failure("ROOT_ADMISSION_CANCELLED"));
      if (record.pin && !isNativeIdentityCurrent(record.pin)) return finish(failure("ROOT_NATIVE_IDENTITY_UNVERIFIED"));
      if (Date.now() - lastProgress >= 1000) {
        lastProgress = Date.now();
        progress(job, "waiting", { willRetry: true });
      }
    };
    const timer = setInterval(check, 20);
    Promise.resolve(operation).then(value => finish(null, value), error => finish(error));
    check();
  });
  const payloadInput = (job, payload) => {
    if (!payload.previous_response_id) {
      retainAnchors(job, [...anchors].filter(([, anchor]) => anchor.threadId === job.metadata.thread_id
        && anchor.nativeGeneration === pinnedRecord(job)?.pin.generation));
      return rootSourcePayload(payload)?.input ?? payload.input;
    }
    const anchor = anchors.get(payload.previous_response_id);
    const record = pinnedRecord(job);
    if (!anchor || anchor.threadId !== job.metadata.thread_id || !record
      || anchor.nativeGeneration !== record.pin.generation) return null;
    retainAnchors(job, [[payload.previous_response_id, anchor]]);
    const source = rootSourcePayload(payload);
    if (source || isRootInputProjection(anchor.input)) return combineRootInputs(anchor.input, anchor.output, source?.input ?? payload.input);
    return [...anchor.input, ...anchor.output, ...payload.input];
  };
  const completionRecord = job => {
    const record = job && authority(job);
    const outcome = job?.recoveryFailure;
    return record && !record.egress && !record.claim && record.state.activeHttp === 0 && record.state.nativeRelays === 0
      && outcome && record.state.worker === outcome.worker && outcome.worker.recoveryTask === outcome.operation
      && outcome.worker.recoveryError && !outcome.worker.replacementWorker ? record : null;
  };
  const canComplete = async job => {
    const record = job && current(job);
    if (!record?.fresh || !job.recoveryFailure) return false;
    try { await wait(record.identityTask, job); } catch { return false; }
    return Boolean(completionRecord(job));
  };
  const finishKnown = (job, recovery, payload, terminalEvent, notice) => {
    const record = job && current(job);
    if (!record?.pin || !isNativeIdentityCurrent(record.pin) || job.workerCompleted || job.finished
      || !ordinary(job.metadata, payload, job.requestPath, job.headers)) return null;
    const frames = recovery.finish(notice, terminalEvent);
    const events = rootSseEvents(frames);
    const response = events.find(event => event.type === "response.completed").response;
    const input = payloadInput(job, payload);
    const output = [...response.output, ...[...(job.deliveredItems?.values() ?? [])]];
    const bytes = rootInputBytes(input, output);
    const anchored = !isPermanentStructureTerminal(terminalEvent)
      && bytes <= maxAnchorBytes - anchorBytes - externalAnchorBytes();
    if (anchored) {
      anchors.set(response.id, { threadId: job.metadata.thread_id, turnId: job.metadata.turn_id, nativeIdentity: record.pin,
        nativeGeneration: record.pin.generation, references: new Set(), consumedTurns: new Set(), consumedCompleted: false,
        input: retainRootInput(input), output, bytes });
      anchorBytes += bytes;
      record.state.rootLocalResponseHistory = true;
    }
    job.finished = true;
    consumedAnchors(job);
    end(job);
    return { frames, events, anchored, closeModelConnection: !anchored, acceptance: "unknown",
      validate() {
        if (current(job) !== record || !isNativeIdentityCurrent(record.pin)) throw failure("ROOT_ADMISSION_STALE_COMPLETION");
      }, release() { end(job); }, async canReclaimConnection() { return false; } };
  };
  return {
    sourcePayloadVersion: 1,
    anchorFixVersion: 1,
    observeStart(state, start, origin = "native_notification", suppliedIdentity) {
      const previous = records.get(state.threadId);
      if (previous?.start === start) {
        return;
      }
      const record = { state, start, turnId: state.turnId, fresh: ["native_notification", "turn_start_rpc"].includes(origin),
        nativeIdentityEnabled: hasNativeIdentity(), pin: null, pinError: null, egress: false, claim: null };
      record.identityTask = Promise.resolve().then(() => suppliedIdentity ?? getNativeIdentity()).then(pin => {
        if (!isNativeIdentityCurrent(pin)) throw failure("ROOT_NATIVE_IDENTITY_UNVERIFIED");
        record.pin = pin;
        sweepAnchors();
        return pin;
      }).catch(error => { record.pinError = error; throw error; });
      record.identityTask.catch(() => {});
      records.set(state.threadId, record);
      for (const [threadId, retained] of records) {
        if (records.size <= maxRecords) break;
        if (getThread(threadId)?.phase !== "active") records.delete(threadId);
      }
    },
    observeTerminal(state, event) {
      if (event.status !== "completed" || getThread(event.threadId) !== state || state.completion !== event) return;
      for (const anchor of anchors.values()) {
        if (anchor.threadId === event.threadId && anchor.consumedTurns.has(event.turnId)
          && (anchor.turnId !== event.turnId || anchor.references.size === 0)) {
          anchor.consumedCompleted = true;
        }
      }
      sweepAnchors();
    },
    begin(metadata, { transport, requestPath, isClosed, payload, headers } = {}) {
      if (!metadata || typeof metadata.thread_id !== "string" || typeof metadata.turn_id !== "string"
        || jobs.size >= maxRecords * 2) return null;
      const job = { id: crypto.randomUUID(), metadata, transport, requestPath, isClosed: isClosed ?? (() => false),
        payload, headers, record: null, sequence: 0, ended: false, recoveryFailure: null };
      jobs.set(job.id, job);
      return job;
    },
    trustedPending(job) {
      const record = job && current(job);
      return Boolean(record?.fresh && !record.pinError && !record.egress
        && (record.pin ? isNativeIdentityCurrent(record.pin) : true));
    },
    binding(job) {
      const record = job && authority(job);
      return record ? { connectionGeneration: record.start.connectionGeneration, nativeIdentity: record.pin } : null;
    },
    job(id) { return jobs.get(id); },
    wait,
    canComplete,
    async ready(job) {
      const record = job && current(job);
      if (!record?.nativeIdentityEnabled) return;
      await wait(record.identityTask, job);
      if (!record.pin || !isNativeIdentityCurrent(record.pin)) throw failure("ROOT_NATIVE_IDENTITY_UNVERIFIED");
    },
    notifyWaiting(job) {
      if (job && Date.now() - (job.lastProgressAt ?? 0) >= 1000) {
        job.lastProgressAt = Date.now();
        progress(job, "waiting", { willRetry: true });
      }
    },
    async recovery(operation, job, worker) {
      if (!job) return await operation;
      const outcome = await wait(Promise.resolve(operation).then(value => ({ ok: true, value }), error => ({ ok: false, error })), job);
      if (outcome.ok) return outcome.value;
      job.recoveryFailure = { operation, worker };
      throw outcome.error;
    },
    beforeWorkerWrite(jobOrMetadata) {
      const job = jobOrMetadata?.metadata ? jobOrMetadata : null;
      const record = job ? current(job) : activeRecord(jobOrMetadata);
      if (job?.record && !record) throw failure("ROOT_ADMISSION_STALE");
      if (job && record?.nativeIdentityEnabled && (!record.pin || !isNativeIdentityCurrent(record.pin))) throw failure("ROOT_NATIVE_IDENTITY_UNVERIFIED");
      if (record?.claim) throw failure("ROOT_ADMISSION_ALREADY_COMPLETING");
      if (record) record.egress = true;
      if (job) { job.forwarded = true; consumedAnchors(job); progress(job, "resumed"); end(job); }
    },
    hasAnchor(threadId) { return getThread(threadId)?.rootLocalResponseHistory === true
      || [...anchors.values()].some(anchor => anchor.threadId === threadId); },
    hasResponseAnchor(responseId) { return anchors.has(responseId); },
    requiresSourcePayload(payload) { return isRootInputProjection(anchors.get(payload?.previous_response_id)?.input); },
    async preparePayload(job, payload) {
      if (!job || !payload || typeof payload !== "object") return payload;
      if (typeof payload.previous_response_id !== "string" || !payload.previous_response_id.startsWith(rootResponsePrefix)
        && !anchors.has(payload.previous_response_id)) {
        if (!payload.previous_response_id && [...anchors.values()].some(anchor => anchor.threadId === job.metadata.thread_id)) {
          const currentRecord = current(job);
          if (currentRecord) { await wait(currentRecord.identityTask, job); payloadInput(job, payload); }
        }
        return payload;
      }
      const record = current(job);
      if (!record) throw failure("ROOT_LOCAL_ANCHOR_UNVERIFIED");
      await wait(record.identityTask, job);
      const input = payloadInput(job, payload);
      if (!input) throw failure("ROOT_LOCAL_ANCHOR_UNVERIFIED");
      if (isRootInputProjection(input)) return projectRootSourcePayload(payload, input);
      const expanded = { ...payload, input };
      delete expanded.previous_response_id;
      return expanded;
    },
    markDelivered(job, event) {
      if (!job) return;
      if (event.type === "response.completed") job.workerCompleted = true;
      if (event.type === "response.output_item.done" && event.item?.type !== "message") {
        job.deliveredItems ??= new Map();
        job.deliveredItems.set(event.output_index ?? 0, structuredClone(event.item));
      }
    },
    finishForwarded(job, recovery, payload, terminalEvent) {
      if (!job?.forwarded || isExplicitNotSent(terminalEvent, recovery)) return null;
      return finishKnown(job, recovery, payload, terminalEvent,
        "本次模型请求未能正常完成，已保留收到的内容和工具结果；上游操作仍待核实，未自动重发。");
    },
    finishProtected(job, payload, operation, protocol) {
      const record = job && current(job);
      if (!record || job.forwarded || operation?.worker !== record.state.worker || operation.requestKind !== "turn"
        || record.state.activeHttp !== 0 || record.state.nativeRelays !== 0
        || !["submitting", "unresolved"].includes(operation.entry?.phase)
        || !["unknown", "accepted"].includes(operation.entry?.acceptance)) return null;
      const result = finishKnown(job, createStreamRecovery(`root_${job.id}`), payload, undefined,
        "此前代理退出时，上游操作尚未核实，已保留状态并停止自动重发。可以发送新消息继续。");
      if (!result) return null;
      record.egress = true;
      return { ...result, kind: "root_local_response", protocol };
    },
    async localCompletion(job, payload, protocol) {
      if (!job || !ordinary(job.metadata, payload, job.requestPath, job.headers)) return null;
      if (!await canComplete(job)) return null;
      const record = completionRecord(job);
      if (!record) return null;
      const input = payloadInput(job, payload);
      if (!input) return null;
      const frames = createStreamRecovery(`root_${crypto.randomUUID()}`).finish("本机代理的恢复未能完成，本次请求尚未发送给模型，请稍后重试。");
      const events = rootSseEvents(frames);
      const response = events.find(event => event.type === "response.completed").response;
      const bytes = rootInputBytes(input, response.output);
      if (bytes > maxAnchorBytes || bytes > maxAnchorBytes - anchorBytes - externalAnchorBytes()) return null;
      const claim = Object.freeze({ id: job.id, responseId: response.id });
      record.claim = claim;
      record.state.rootLocalResponseHistory = true;
      consumedAnchors(job);
      anchors.set(response.id, { threadId: job.metadata.thread_id, turnId: job.metadata.turn_id, nativeIdentity: record.pin,
        nativeGeneration: record.pin.generation, references: new Set(), consumedTurns: new Set(), consumedCompleted: false,
        input: retainRootInput(input), output: response.output, bytes });
      anchorBytes += bytes;
      progress(job, "failed", { willRetry: false });
      const valid = () => authority(job) === record && record.claim === claim && !record.egress;
      return { kind: "root_local_response", protocol, frames, events,
        validate() { if (!valid()) throw failure("ROOT_ADMISSION_STALE_COMPLETION"); },
        release() { end(job); },
        async canReclaimConnection() {
          const state = getThread(job.metadata.thread_id);
          return state?.turnId === record.turnId && state.phase === "terminal" && state.activeHttp === 0
            && isNativeIdentityCurrent(record.pin) && record.claim === claim;
        } };
    },
    end,
    async close() {
      await Promise.all([...anchors.values()].map(anchor => releaseRootInput(anchor.input)));
      anchors.clear();
      anchorBytes = 0;
      jobs.clear();
      records.clear();
    },
    status() { return { protocolVersion: 1, anchorFixVersion: 1, records: records.size, jobs: jobs.size, anchors: anchors.size, anchorBytes }; },
  };
}

