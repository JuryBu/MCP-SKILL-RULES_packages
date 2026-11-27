import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { HANDOFF_CHANNEL } from "./inner-runner-handoff-control.mjs";
import { validateRecoveryEnvelope, canContinueRecovery, signRecoveryEnvelope } from "./model-recovery-notifications.mjs";
import { fixedHandoffCompatibility, reverseHandoffCompatibility } from "./inner-handoff-compatibility.mjs";
import { validateInnerRuntimeProfile, approvedInnerCandidate, seedInnerWorkerState, checkedRuntimePath } from "./inner-runtime-profile.mjs";
import { acquireInnerColdStart } from "./inner-cold-start-state.mjs";
import { readFailedWorkerRecovery, readRecoveredWorkerOperation, readRecoveredWorkerOperationSource, seedFailedWorkerRecovery, writeWorkerRecoveryCheckpoint } from "./inner-worker-recovery-state.mjs";
import { createStreamRecovery } from "./codex-stream-recovery.mjs";
import { classifyModelFailure, isKnownIncompleteResponse, modelRecoveryAction } from "./model-failure-policy.mjs";
import { attachNativeResponsesRelay, createNativeWsRetryGate, nativeResponseMetadataHeader,
  installNativeResponseSocketGuard } from "./native-responses-ws-bridge.mjs";
import { createInnerInternalMemoryRouter } from "./inner-internal-memory-router.mjs";
import { createManagedEventObserver } from "./inner-managed-events.mjs";
import { createRootAdmissionState, isInterruptedResponse, rootAdmissionProtocolSupported } from "./root-admission-state.mjs";
import { createRequestBodyOwner, createRequestBufferBudget, jsonRequestChunks } from "./request-body-buffer.mjs";
import { prepareRequestBodySource } from "./request-body-preparation.mjs";
import { collectBodySource } from "./request-body-source.mjs";
import { rootSourcePayload, registerRootSourcePayload, composeRootSourceBody, rootHasInputArray, rootHasCompactionTrigger } from "./source-root-admission.mjs";
import { createSseFrameParser, parseSseFrame, frameData } from "./sse-frame-parser.mjs";
import { createRequestInspector } from "./request-body-inspector.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const isOrdinaryClientTurn = (metadata, payload) => typeof metadata?.turn_id === "string"
  && (metadata.request_kind === undefined || metadata.request_kind === "turn")
  && payload?.generate !== false && !Object.hasOwn(payload ?? {}, "compaction_trigger")
  && !rootHasCompactionTrigger(payload);
const recoverableRootHttpStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const rootHttpRateLimitCodes = new Set(["rate_limit_exceeded", "rate_limit_error", "too_many_requests", "overloaded_error",
  "engine_overloaded", "server_is_overloaded", "server_overloaded", "model_at_capacity"]);
const rootHttpUnconfirmedErrors = new Set(["stream_error", "upstream_error"]);
const rootHttpTransportErrors = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENETRESET",
  "ERR_STREAM_PREMATURE_CLOSE", "ERR_SOCKET_CLOSED"]);
const terminalRejectionCategories = new Set(["safety", "authentication", "quota", "payload_too_large", "permanent"]);
const parseTerminalStatusCode = terminalEvent => [terminalEvent?.status, terminalEvent?.status_code,
  terminalEvent?.error?.status, terminalEvent?.error?.status_code,
  terminalEvent?.response?.error?.status, terminalEvent?.response?.error?.status_code]
  .map(value => typeof value === "string" && /^\d{3}$/u.test(value.trim()) ? Number(value.trim()) : value)
  .find(value => Number.isInteger(value) && value >= 100 && value <= 599);
const extractTransmissionSignal = terminalEvent => [terminalEvent, terminalEvent?.error, terminalEvent?.response?.error]
  .find(entry => entry?.requestAccepted !== undefined || typeof entry?.requestTransmissionState === "string");
const uncertainTransmission = terminalEvent => [terminalEvent, terminalEvent?.error, terminalEvent?.response?.error]
  .some(entry => entry?.requiresReconciliation === true || entry?.requestAccepted === true
    || entry?.requestAccepted === "unknown" || ["generation_sent", "response_received", "unknown"].includes(entry?.requestTransmissionState));
const knownLocalRefusal = event => event?.type === "error" && event.error?.operationAcceptance === "not_sent"
  && event.error.requestTransmissionState === "not_sent" && event.error.requestAccepted === false;
const terminalCarriesOutput = event => ["response.incomplete", "response.failed"].includes(event?.type) && event.response?.output != null
  && (!Array.isArray(event.response.output) || event.response.output.length > 0);
const isNoOutputRejection = policy => policy?.acceptance === "rejected" && policy?.category === "temporary";
const isConfirmedTemporaryFailure = (event, responseId, policy) => policy?.category === "temporary"
  && policy.acceptance !== "unknown" && event?.type === "response.failed"
  && typeof responseId === "string" && responseId.length > 0 && event.response?.id === responseId
  && event.response.status === "failed" && Array.isArray(event.response.output) && !uncertainTransmission(event);
const isOrdinaryRootHttp = (request, metadata, payload) => request.method === "POST"
  && ["/v1/responses", "/backend-api/codex/responses"].includes(String(request.url).split("?")[0])
  && isOrdinaryClientTurn(metadata, payload) && rootHasInputArray(payload)
  && metadata.thread_source !== "memory_consolidation" && metadata.turn_trigger !== "memory_consolidation"
  && payload?.client_metadata?.["x-openai-subagent"] !== "memory_consolidation"
  && !Object.hasOwn(request.headers, "x-codex-internal-memory-connection")
  && request.headers["x-openai-subagent"] !== "memory_consolidation";
const nativeTerminalPolicy = (terminalEvent, delivery) => {
  if (!delivery || !["error", "response.failed"].includes(terminalEvent?.type)) return null;
  const statusCode = parseTerminalStatusCode(terminalEvent);
  const signal = extractTransmissionSignal(terminalEvent);
  return classifyModelFailure({ source: "sse", message: terminalEvent,
    progressObserved: delivery.progressObserved, toolDelivered: delivery.toolDelivered,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(signal?.requestAccepted !== undefined ? { requestAccepted: signal.requestAccepted } : {}),
    ...(typeof signal?.requestTransmissionState === "string"
      ? { requestTransmissionState: signal.requestTransmissionState } : {}) });
};
const clientRecoveryAction = (terminalEvent, metadata, payload, responseStarted, nativeDelivery, terminalPolicy) => {
  const policy = terminalPolicy ?? (terminalEvent ? classifyModelFailure({ source: "sse", message: terminalEvent })
    : classifyModelFailure({ source: "transport", code: "WS_CONNECTION_CLOSED",
      progressObserved: nativeDelivery?.progressObserved ?? responseStarted, toolDelivered: nativeDelivery?.toolDelivered }));
  return modelRecoveryAction(policy, { ordinary: isOrdinaryClientTurn(metadata, payload),
    outputDelivered: nativeDelivery ? nativeDelivery.progressObserved || nativeDelivery.toolDelivered : responseStarted,
    clientCanContinue: nativeDelivery?.clientCanContinue ?? true });
};
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const validIdentity = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value);
const nativeTurnPublicationWaitMs = 1000;
const nativeRelayTransientCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "WS_CONNECT_TIMEOUT", "NATIVE_WS_WORKER_UNAVAILABLE"]);
const nativeRetryState = shared => shared.nativeWsRetryState ??= {
  gate: createNativeWsRetryGate(shared.options.nativeWsRetryOptions), connections: new Map(),
};

export function clearNativeRootFailedPeers(shared) {
  const registry = shared.nativeRootFailedPeers;
  if (!registry) return;
  clearInterval(registry.watcher);
  for (const entry of registry.entries.values()) {
    clearTimeout(entry.timer);
    entry.socket.off("close", entry.onClose);
  }
  registry.entries.clear();
  if (shared.nativeRootFailedPeers === registry) delete shared.nativeRootFailedPeers;
}

function trackNativeRootPeer(shared, request, connectionId) {
  const socket = request?.socket;
  if (!validIdentity(connectionId) || !socket || socket.destroyed
    || typeof socket.once !== "function" || typeof socket.destroy !== "function") return;
  let registry = shared.nativeRootFailedPeers;
  if (registry && (registry.implementation !== shared.implementation
    || registry.generation !== shared.implementationGeneration)) {
    clearNativeRootFailedPeers(shared);
    registry = null;
  }
  if (!registry) {
    registry = { implementation: shared.implementation, generation: shared.implementationGeneration,
      entries: new Map(), watcher: null };
    shared.nativeRootFailedPeers = registry;
    registry.watcher = setInterval(() => {
      if (shared.implementation !== registry.implementation || shared.implementationGeneration !== registry.generation
        || shared.closing || shared.nativeResponsesClosing) clearNativeRootFailedPeers(shared);
    }, 20);
    registry.watcher.unref?.();
  }
  const previous = registry.entries.get(connectionId);
  if (previous) {
    if (previous.socket !== socket || previous.request.socket !== socket) {
      clearTimeout(previous.timer);
      previous.socket.off("close", previous.onClose);
      registry.entries.delete(connectionId);
    }
    return;
  }
  if (registry.entries.size >= 32) return;
  const entry = { request, socket, failed: false, timer: null, onClose: null };
  entry.onClose = () => {
    clearTimeout(entry.timer);
    if (registry.entries.get(connectionId) === entry) registry.entries.delete(connectionId);
    if (registry.entries.size === 0 && shared.nativeRootFailedPeers === registry) clearNativeRootFailedPeers(shared);
  };
  registry.entries.set(connectionId, entry);
  socket.once("close", entry.onClose);
}

export function recordNativeRootPeerFailure(shared, event) {
  if (event?.type !== "native_ws_relay_failed" || !validIdentity(event.connectionId)) return false;
  const registry = shared.nativeRootFailedPeers;
  const entry = registry?.entries.get(event.connectionId);
  if (!entry || entry.failed || entry.socket.destroyed || entry.request.socket !== entry.socket
    || registry.implementation !== shared.implementation || registry.generation !== shared.implementationGeneration
    || shared.closing || shared.nativeResponsesClosing) return false;
  entry.failed = true;
  const written = entry.socket.bytesWritten;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (shared.nativeRootFailedPeers !== registry || registry.entries.get(event.connectionId) !== entry
      || shared.implementation !== registry.implementation || shared.implementationGeneration !== registry.generation
      || shared.closing || shared.nativeResponsesClosing || entry.request.socket !== entry.socket
      || entry.socket.destroyed) return;
    if (!Number.isFinite(written) || entry.socket.bytesWritten <= written) return;
    try { shared.onEvent?.({ type: "native_ws_failed_peer_closed", connectionId: event.connectionId,
      reason: "confirmed_relay_failure", closeBudgetMs: 1000 }); } catch {}
    entry.socket.destroy();
  }, 1000);
  entry.timer.unref?.();
  return true;
}

export function recordNativeWsRelayFailure(shared, event) {
  if (event?.type !== "native_ws_relay_failed" || !nativeRelayTransientCodes.has(event.code)) return false;
  const retry = shared.nativeWsRetryState;
  const lease = retry?.connections.get(event.connectionId);
  if (!lease || lease.routed.accounted || shared.requests.get(lease.routed.id) !== lease.routed
    || shared.threads.get(lease.metadata.thread_id) !== lease.routed.thread
    || lease.routed.thread.phase !== "active" || lease.routed.thread.turnId !== lease.metadata.turn_id) return false;
  retry.gate.record({ metadata: lease.metadata, error: { code: event.code }, elapsedMs: performance.now() - lease.startedAt });
  return true;
}
const coordinatorStateSchema = "inner-coordinator-state-v1";
const implementationMethods = Object.freeze([
  "start", "prepareCandidate", "observeNativeMessage", "migrate", "activate", "rollbackActivation", "status", "close", "discardCandidate",
  "control", "launchWorker", "relayNative", "reclaimRetiredWorkers", "adoptForRequest", "handleHttpRequest",
  "handleWorkerMessage", "handleWorkerExit", "handleWorkerError", "handleWorkerReadyTimeout", "settleWorkerStartup",
  "handleControlTimeout", "handleControlSendError", "relayNativeEvent", "handleNativeRelayFailure",
  "handleHttpResponse", "handleHttpStreamError", "handleHttpError", "handleHttpAborted", "handleHttpClose",
  "releaseHttpRequest",
  "recoveryControl",
]);
const checkedImplementation = implementation => {
  if (!implementation || implementationMethods.some(name => typeof implementation[name] !== "function")) {
    fail("COORDINATOR_LIVE_CODE_METHOD_MISSING");
  }
  return Object.freeze({ ...Object.fromEntries(implementationMethods.map(name => [name, implementation[name]])),
    ...(typeof implementation.acquireNativeResponse === "function" ? { acquireNativeResponse: implementation.acquireNativeResponse } : {}) });
};

export function createInnerProxyCoordinator(options) {
  const { ownerId, nativeSourceId, checkpointRoot, upstreamOrigin, onEvent = () => {}, environment = {} } = options;
  if (!validIdentity(ownerId) || !validIdentity(nativeSourceId)) fail("COORDINATOR_INVALID_IDENTITY");
  const root = fs.realpathSync(checkpointRoot);
  const upstream = new URL(upstreamOrigin);
  const runtimeProfile = options.mode === "production" ? validateInnerRuntimeProfile(options.runtimeProfile, { upstreamOrigin }) : null;
  if (options.mode !== undefined && !["isolated", "production"].includes(options.mode)) fail("COORDINATOR_MODE_INVALID");
  if (options.runtimeProfile && options.mode !== "production") fail("COORDINATOR_PROFILE_MODE_MISMATCH");
  if (runtimeProfile && (runtimeProfile.ownerId !== ownerId || runtimeProfile.nativeSourceId !== nativeSourceId
    || runtimeProfile.checkpointRoot !== root || runtimeProfile.innerPort !== options.port)) fail("COORDINATOR_PROFILE_MISMATCH");
  if (!runtimeProfile && (!inside(fs.realpathSync(os.tmpdir()), root) || upstream.protocol !== "http:"
    || upstream.hostname !== "127.0.0.1" || upstream.username || upstream.password)) fail("COORDINATOR_ISOLATED_ONLY");
  const state = { options, ownerId, nativeSourceId, root, upstreamOrigin, onEvent, environment, runtimeProfile,
    sessionId: crypto.randomUUID(), capability: crypto.randomBytes(32).toString("hex"),
    workers: new Map(), reclaimedWorkers: [], threads: new Map(), terminalThreads: new Map(), migrations: new Map(), pending: new Map(),
    adoptions: new Map(), requests: new Map(), activation: null, maxThreads: 128, defaultWorker: null,
    recycleRetiredWorkers: runtimeProfile?.workerLifecycle?.recycleRetiredWorkers !== false,
    workerSequence: 0, requestSequence: 0, nativeSequence: 0, httpSequence: 0, generation: 0,
    transactionActive: false, starting: false, closing: false, nativeHealthy: true, preparationTask: null,
    workerMaintenance: false, relay: Promise.resolve(), server: null, implementation: null, implementationGeneration: 0,
    recentRejections: [] };
  state.dispatch = (method, ...args) => state.implementation[method](...args);
  state.bindDispatch = (method, ...bound) => (...args) => state.dispatch(method, ...bound, ...args);
  state.implementation = checkedImplementation(createInnerProxyCoordinatorImplementation(state));
  state.server = http.createServer(state.bindDispatch("handleHttpRequest"));
  state.nativeResponsesRelay = attachNativeResponsesRelay({ server: state.server,
    acquire: input => {
      if (typeof state.implementation.acquireNativeResponse !== "function") fail("COORDINATOR_NATIVE_WS_UNAVAILABLE");
      return state.dispatch("acquireNativeResponse", input);
    }, isClosing: () => state.closing || state.nativeResponsesClosing || options.isShutdownRequested?.() === true,
    onEvent, maxPayload: options.nativeWsMaxPayload, maxConnections: options.nativeWsMaxConnections });
  const preparations = new WeakSet();
  const snapshots = new WeakSet();
  const snapshot = () => {
    const token = Object.freeze({ state, implementation: state.implementation, generation: state.implementationGeneration });
    snapshots.add(token);
    return token;
  };
  const participant = Object.freeze({ id: "inner-coordinator", stateSchema: coordinatorStateSchema,
    exportName: "createInnerProxyCoordinatorImplementation", snapshot,
    prepare(module) {
      const factory = module?.createInnerProxyCoordinatorImplementation;
      if (typeof factory !== "function") fail("COORDINATOR_LIVE_CODE_EXPORT_MISSING");
      const candidate = Object.freeze({ state, implementation: checkedImplementation(factory(state)) });
      preparations.add(candidate);
      return candidate;
    },
    activate(candidate) {
      if (!preparations.has(candidate) || candidate.state !== state) fail("COORDINATOR_LIVE_CODE_CANDIDATE_INVALID");
      const token = snapshot();
      state.implementation = candidate.implementation;
      state.implementationGeneration += 1;
      return token;
    },
    restore(token) {
      if (!snapshots.has(token) || token.state !== state) fail("COORDINATOR_LIVE_CODE_SNAPSHOT_INVALID");
      state.implementation = token.implementation;
      state.implementationGeneration += 1;
    },
  });
  return { ...Object.fromEntries(implementationMethods.slice(0, 9).map(name => [name, state.bindDispatch(name)])),
    async close() {
      if (state.transactionActive) fail("COORDINATOR_MIGRATION_BUSY");
      state.nativeResponsesClosing = true;
      await (state.nativeResponsesCloseTask ??= state.nativeResponsesRelay.close());
      return state.dispatch("close");
    },
    recoveryControl: state.bindDispatch("recoveryControl"),
    liveCodeParticipant: () => participant };
}

export function createInnerProxyCoordinatorImplementation(shared) {
  const { options, ownerId, nativeSourceId, root, upstreamOrigin, onEvent, environment, runtimeProfile,
    sessionId, capability, workers, reclaimedWorkers, threads, migrations, pending, adoptions, maxThreads } = shared;
  const recycleRetiredWorkers = runtimeProfile?.workerLifecycle?.recycleRetiredWorkers !== false;
  const relayDiagnostics = runtimeProfile ? createManagedEventObserver({
    filePath: path.join(runtimeProfile.stateRoot, "native-turn-relay-events.jsonl"),
  }) : null;
  const emit = (type, fields = {}) => {
    const event = { type, ...fields };
    if (type.startsWith("native_relay_") || type.startsWith("native_control_")) relayDiagnostics?.(event);
    onEvent(event);
  };
  const alive = worker => worker?.ready && worker.child.connected && worker.child.exitCode === null && worker.child.signalCode === null;
  const shutdownRequested = () => shared.closing || shared.nativeResponsesClosing || options.isShutdownRequested?.() === true;
  const rootRecoveryRecords = shared.rootRecoveryRecords ??= new Map();
  const rootAdmissionOptions = {
    getThread: threadId => shared.nativeHealthy ? shared.threads.get(threadId) : null,
    getNativeIdentity: () => shared.options.getExpectedNativeIdentity?.({}),
    hasNativeIdentity: () => typeof shared.options.getExpectedNativeIdentity === "function",
    isNativeIdentityCurrent: identity => shared.options.getExpectedNativeIdentity?.isCurrent?.(identity) === true,
    isClosing: shutdownRequested,
    onProgress: (job, event) => publishRootRecovery(job, event),
    maxAnchorBytes: options.rootAdmissionMaxAnchorBytes,
  };
  let rootAdmissions = shared.rootAdmissions ??= createRootAdmissionState(rootAdmissionOptions);
  if (rootAdmissions.sourcePayloadVersion !== 1) fail("ROOT_ADMISSION_SOURCE_REQUIRES_COLD_START");
  const upgradeIdleRootLayersIfNeeded = () => {
    if (shared.closing || shared.nativeResponsesClosing || shared.implementation?.status !== implementation.status) return;
    if (shared.rootAdmissions && shared.rootAdmissions.anchorFixVersion !== 1) {
      const rootStatus = shared.rootAdmissions.status?.();
      const hasActiveThread = [...threads.values()].some(state => state.phase === "active");
      if (rootStatus && rootStatus.jobs === 0 && rootStatus.anchors === 0
        && shared.requests.size === 0 && !hasActiveThread) {
        const previousRoot = shared.rootAdmissions;
        shared.rootAdmissions = createRootAdmissionState(rootAdmissionOptions);
        rootAdmissions = shared.rootAdmissions;
        void Promise.resolve(previousRoot.close?.()).catch(() => {});
      }
    } else if (shared.rootAdmissions && rootAdmissions !== shared.rootAdmissions) {
      rootAdmissions = shared.rootAdmissions;
    }
    if (shared.server && shared.nativeResponsesRelay && shared.nativeResponsesRelay.anchorFixVersion !== 1) {
      const relayStatus = shared.nativeResponsesRelay.status?.();
      if (relayStatus && relayStatus.closed !== true && relayStatus.connections === 0) {
        const previousRelay = shared.nativeResponsesRelay;
        void Promise.resolve(previousRelay.close?.()).catch(() => {});
        shared.nativeResponsesRelay = attachNativeResponsesRelay({
          server: shared.server,
          acquire: input => {
            if (typeof shared.implementation.acquireNativeResponse !== "function") fail("COORDINATOR_NATIVE_WS_UNAVAILABLE");
            return shared.dispatch("acquireNativeResponse", input);
          },
          isClosing: () => shared.closing || shared.nativeResponsesClosing || options.isShutdownRequested?.() === true,
          onEvent,
          maxPayload: options.nativeWsMaxPayload,
          maxConnections: options.nativeWsMaxConnections,
        });
      }
    }
  };
  const rootBodyBudget = shared.rootBodyBudget ??= createRequestBufferBudget(options.rootAdmissionMaxBufferedBytes ?? 256 * 1024 * 1024);
  const rootProducerHashes = Object.fromEntries(Object.entries({ core: "inner-proxy-coordinator.mjs", helper: "root-admission-state.mjs",
    runner: "inner-managed-session.mjs", control: "native-responses-ws-bridge.mjs" }).map(([key, filename]) => {
      try { return [key, digest(fs.readFileSync(new URL(filename, import.meta.url)))]; }
      catch { return [key, "unavailable"]; }
    }));
  function publishRootRecovery(job, event) {
    const binding = rootAdmissions.binding(job);
    if (!binding?.connectionGeneration) return;
    const identity = { ownerId, nativeSourceId, producerId: `root-${sessionId}`, producerPid: process.pid,
      sourceHashes: rootProducerHashes, connectionGeneration: binding.connectionGeneration };
    const envelope = signRecoveryEnvelope(identity, { type: "model_recovery_state", requestId: job.id,
      threadId: job.metadata.thread_id, turnId: job.metadata.turn_id, requestKind: "turn", transport: job.transport,
      waitContext: "root_admission", acceptance: "not_sent", canContinueHttp: false, ...event }, capability);
    rootRecoveryRecords.set(job.id, { job, identity, envelope });
    for (const [requestId, record] of rootRecoveryRecords) {
      if (rootRecoveryRecords.size <= 128) break;
      if (!rootAdmissions.binding(record.job)) rootRecoveryRecords.delete(requestId);
    }
    emit("model_recovery_state", { envelope });
  }
  async function captureRootBody(request, source, { forceSourceInspection = false } = {}) {
    if (!source && request.readableEnded) fail("ROOT_ADMISSION_BODY_ALREADY_CONSUMED");
    const lease = rootBodyBudget.lease();
    let owner;
    const abort = new AbortController();
    const stop = () => abort.abort();
    request.once("aborted", stop);
    request.socket?.once("close", stop);
    const timer = setInterval(() => { if (shutdownRequested()) stop(); }, 20);
    try {
      const inspector = shared.rootBodyInspector ??= createRequestInspector({ maxDecodedBytes: options.rootAdmissionMaxBodyBytes ?? 192 * 1024 * 1024 });
      const prepared = await prepareRequestBodySource(request, { lease, inspector, source, signal: abort.signal,
        maxBufferedRequestBytes: options.rootAdmissionMaxBodyBytes ?? 192 * 1024 * 1024,
        contentEncoding: source ? "identity" : request.headers["content-encoding"], retainUntilReleased: true,
        forceSourceInspection });
      owner = prepared.requestBody;
      const payload = prepared.inspected.payload;
      if (prepared.sourceBased) await registerRootSourcePayload(payload, prepared.inspected.sourceDocument);
      return { payload, owner: prepared.requestBody, lease, reencoded: Boolean(source), contentEncoding: prepared.contentEncoding };
    } catch (error) { await owner?.releaseUnused(); lease.release(); throw error; }
    finally {
      clearInterval(timer);
      request.off("aborted", stop);
      request.socket?.off("close", stop);
    }
  }
  const internalMemoryRouter = () => shared.internalMemoryRouter ??= createInnerInternalMemoryRouter({
    getExpectedIdentity: Object.assign(input => options.getExpectedNativeIdentity?.(input), {
      isCurrent: identity => options.getExpectedNativeIdentity?.isCurrent?.(identity) === true,
    }),
    getDefaultWorker: () => shared.defaultWorker,
    isWorkerAlive: worker => alive(worker) && worker.reclamation !== "stopping",
    isClosing: () => shutdownRequested() || !shared.nativeHealthy,
    control: (worker, method, params) => shared.dispatch("control", worker, method, params),
    onEvent: event => onEvent(event),
  });
  const acquireInternalMemoryResponse = async (input, method = "acquire") => {
    shared.internalMemoryAcquires = (shared.internalMemoryAcquires ?? 0) + 1;
    shared.internalMemoryAcquireRevision = (shared.internalMemoryAcquireRevision ?? 0) + 1;
    try {
      const result = await internalMemoryRouter()[method](input);
      if (result?.state?.worker?.reclamation === "stopping") fail("COORDINATOR_WORKER_UNAVAILABLE");
      return result;
    }
    finally {
      shared.internalMemoryAcquires -= 1;
      shared.internalMemoryAcquireRevision += 1;
    }
  };
  shared.recentRejections ??= [];
  const recoveryRecords = shared.recoveryRecords ??= new Map();
  const rejectionErrors = shared.rejectionErrors ??= new WeakMap();
  const rejectionDetails = (metadata, state, decisionPoint, reason) => {
    const category = (value, allowed) => value === undefined ? "missing" : allowed.includes(value) ? value : "unknown";
    const current = threads.get(metadata?.thread_id);
    const terminal = current ? undefined : shared.terminalThreads?.get(metadata?.thread_id);
    const fields = { reason, decisionPoint, nativeHealthy: Boolean(shared.nativeHealthy), workerAlive: Boolean(alive(state?.worker)),
      coordinatorActiveHttp: shared.requests.size,
      requestKind: category(metadata?.request_kind, ["turn", "prewarm", "compaction", "memory"]),
      subagentKind: category(metadata?.subagent_kind, ["review", "compact", "thread_spawn", "memory_consolidation"]),
      threadRegistry: current ? "current" : terminal ? "terminal_history" : "absent" };
    if (terminal && validIdentity(metadata?.turn_id) && validIdentity(terminal.turnId)) {
      fields.terminalTurnMatches = terminal.turnId === metadata.turn_id;
    }
    for (const [name, value] of Object.entries({ threadHash: metadata?.thread_id, turnHash: metadata?.turn_id,
      currentTurnHash: state?.turnId, workerFingerprint: state?.worker?.workerId, parentThreadHash: metadata?.parent_thread_id })) {
      if (validIdentity(value)) fields[name] = digest(value).slice(0, 16);
    }
    if (["active", "terminal"].includes(state?.phase)) fields.phase = state.phase;
    for (const [name, value] of Object.entries({ activeHttp: state?.activeHttp, workerActiveHttp: state?.worker?.activeHttp })) {
      if (Number.isSafeInteger(value) && value >= 0) fields[name] = value;
    }
    return fields;
  };
  const unavailableReason = (metadata, state) => !shared.nativeHealthy ? "native_unhealthy" : !state ? "thread_not_found"
    : state.phase !== "active" ? "phase_not_active" : state.turnId !== metadata.turn_id ? "turn_mismatch" : "worker_dead";
  const nativeTurnPublicationPending = (metadata, state, deadline) => metadata && typeof metadata === "object"
    && !Array.isArray(metadata) && typeof metadata.thread_id === "string" && metadata.thread_id.length > 0
    && metadata.thread_id.length <= 512 && !metadata.thread_id.includes("\u0000")
    && typeof metadata.turn_id === "string" && metadata.turn_id.length > 0 && metadata.turn_id.length <= 512
    && !metadata.turn_id.includes("\u0000") && (metadata.request_kind === undefined || ["turn", "compaction"].includes(metadata.request_kind))
    && (!state || state.turnId !== metadata.turn_id) && Date.now() < deadline;
  const waitForNativeTurnPublication = (operation, deadline, isClosed, rootAttempt, lookupMetadata) => new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (error, open = true) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      if (error) reject(error); else resolve(open);
    };
    const check = (checkDeadline = true) => {
      if (isClosed()) return finish(null, false);
      if (checkDeadline && Date.now() >= deadline && rootAdmissions.trustedPending(rootAttempt)) rootAdmissions.notifyWaiting(rootAttempt);
      const code = shutdownRequested() ? "COORDINATOR_CLOSING" : !shared.nativeHealthy ? "COORDINATOR_TURN_UNAVAILABLE"
        : checkDeadline && Date.now() >= deadline && !rootAdmissions.trustedPending(rootAttempt)
          && !(lookupMetadata && options.nativeStartLookupPending?.(lookupMetadata) === true)
          ? "COORDINATOR_NATIVE_PUBLICATION_TIMEOUT" : null;
      if (code) finish(Object.assign(new Error(code), { code }));
    };
    timer = setInterval(check, 10);
    Promise.resolve(operation).then(() => finish(null), error => finish(error));
    check(false);
  });
  const reconcileNativeStart = async (metadata, isClosed) => {
    const previous = threads.get(metadata?.thread_id) ?? shared.terminalThreads?.get(metadata?.thread_id);
    const reuse = previous?.phase === "active" && metadata?.subagent_kind === "thread_spawn"
      && (metadata.request_kind === undefined || metadata.request_kind === "turn");
    if (!nativeTurnPublicationPending(metadata, previous, Date.now() + nativeTurnPublicationWaitMs)
      || previous && previous.phase !== "terminal" && !reuse) return;
    if (typeof options.reconcileNativeStart !== "function") emit("native_start_lookup_requested");
    if (typeof options.reconcileNativeStart !== "function") return;
    const controller = new AbortController();
    try {
      await waitForNativeTurnPublication(options.reconcileNativeStart(metadata, { isClosed, signal: controller.signal }),
        Date.now() + nativeTurnPublicationWaitMs, isClosed, null, metadata);
    } finally { controller.abort(); }
  };
  const rejectRequest = (code, metadata, state, decisionPoint, reason) => {
    const error = Object.assign(new Error(code), { code });
    rejectionErrors.set(error, rejectionDetails(metadata, state, decisionPoint, reason));
    throw error;
  };
  const identity = worker => ({ pid: worker.child.pid, instanceToken: worker.ready.instanceToken,
    core: worker.ready.sourceHashes.core, helper: worker.ready.sourceHashes.helper });
  const workerSpecification = worker => {
    if (worker?.specification) return worker.specification;
    const runnerPaths = worker?.child.spawnargs?.filter(argument => path.isAbsolute(argument)
      && path.basename(argument) === "codex-model-stream-proxy-runner.mjs") ?? [];
    if (!worker?.ready || runnerPaths.length !== 1
      || Object.keys(worker.ready.sourceHashes ?? {}).sort().join(",") !== "control,core,helper,runner") fail("WORKER_RECOVERY_SOURCE_UNAVAILABLE");
    const specification = { runnerPath: runnerPaths[0], expectedHashes: { ...worker.ready.sourceHashes } };
    if (runtimeProfile) {
      const candidate = runtimeProfile.approvedCandidates?.find(entry => path.resolve(entry.runnerPath) === path.resolve(specification.runnerPath)
        && Object.entries(specification.expectedHashes).every(([key, hash]) => entry.expectedHashes[key] === hash));
      if (candidate) specification.candidateApprovalId = candidate.id;
    }
    return specification;
  };
  const threadStates = () => [...threads.values(), ...(shared.terminalThreads?.values() ?? [])];
  const findThread = threadId => threads.get(threadId) ?? shared.terminalThreads?.get(threadId);
  const historyOwners = threadId => [...workers.values()].filter(worker => worker.threadHistory.has(threadId)
    && !worker.releasedThreadHistory?.has(threadId));
  const idleTerminalThread = (state, allowPendingActivation = false) => state.phase === "terminal" && state.activeHttp === 0 && state.nativeRelays === 0
    && (allowPendingActivation === true || !state.pendingActivation) && !state.activationError
    && !migrations.has(state.threadId) && !adoptions.has(state.threadId)
    && !state.worker.startup && !state.worker.cleanupPending && alive(state.worker)
    && ![...shared.requests.values()].some(request => request.thread === state);
  const idleTerminal = (state, allowPendingActivation = false) => idleTerminalThread(state, allowPendingActivation)
    && state.worker.activeHttp === 0 && ![...pending.values()].some(request => request.worker === state.worker);

  function reserveThreadSlot(threadId) {
    if (threads.size < maxThreads) return;
    if (shared.transactionActive || shared.workerMaintenance || shared.preparationTask || shared.closing
      || !shared.nativeHealthy) fail("COORDINATOR_THREAD_LIMIT");
    const retired = [...threads.values()].filter(state => idleTerminalThread(state)).sort((first, second) => first.epoch - second.epoch)[0];
    if (!retired) fail("COORDINATOR_THREAD_LIMIT");
    const history = shared.terminalThreads ??= new Map();
    if (history.has(threadId)) history.delete(threadId);
    else if (history.size >= maxThreads) {
      const expired = [...history.values()].find(state => {
        const owners = historyOwners(state.threadId);
        return state.threadId !== threadId && idleTerminalThread(state) && owners.length === 1 && owners[0] === state.worker;
      });
      if (!expired) fail("COORDINATOR_THREAD_LIMIT");
      history.delete(expired.threadId);
    }
    threads.delete(retired.threadId);
    history.set(retired.threadId, retired);
  }

  function control(worker, method, params = {}) {
    if (!alive(worker)) return Promise.reject(Object.assign(new Error("COORDINATOR_WORKER_UNAVAILABLE"), { code: "COORDINATOR_WORKER_UNAVAILABLE" }));
    if (pending.size >= 64) return Promise.reject(new Error("COORDINATOR_IPC_LIMIT"));
    const requestId = `coordinator-${++shared.requestSequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(shared.bindDispatch("handleControlTimeout", requestId, method), 10_000);
      pending.set(requestId, { worker, method, startedAt: Date.now(), resolve, reject, timer });
      worker.child.send({ channel: HANDOFF_CHANNEL, requestId, method, ...params,
        instanceToken: worker.ready.instanceToken, capability, ownerId }, shared.bindDispatch("handleControlSendError", requestId));
    });
  }

  function handleControlTimeout(requestId, method) {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    emit("native_control_timeout", { code: "COORDINATOR_IPC_TIMEOUT", method, requestId,
      workerId: entry.worker.workerId, elapsedMs: Date.now() - entry.startedAt, outcomeUnknown: true });
    entry.reject(Object.assign(new Error(`COORDINATOR_IPC_TIMEOUT:${method}`), {
      code: "COORDINATOR_IPC_TIMEOUT", method, requestId, outcomeUnknown: true,
    }));
  }

  function handleControlSendError(requestId, error) {
    if (!error) return;
    const entry = pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(requestId);
    entry.reject(error);
  }

  async function launchWorker(specification, { recoverySeed } = {}) {
    if (shutdownRequested()) fail("COORDINATOR_WORKER_LIMIT");
    if (!path.isAbsolute(specification.runnerPath)) fail("COORDINATOR_RUNNER_PATH_REQUIRED");
    const runnerPath = fs.realpathSync(specification.runnerPath);
    if (path.basename(runnerPath) !== "codex-model-stream-proxy-runner.mjs"
      || !specification.expectedHashes || Object.keys(specification.expectedHashes).sort().join(",") !== "control,core,helper,runner") {
      fail("COORDINATOR_UNVERIFIED_SOURCE");
    }
    const sourceRoot = path.dirname(runnerPath);
    for (const [key, name] of Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
      helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })) {
      if (digest(fs.readFileSync(path.join(sourceRoot, name))) !== specification.expectedHashes?.[key]) fail("COORDINATOR_UNVERIFIED_SOURCE");
    }
    let sourceProfile = runtimeProfile;
    if (runtimeProfile && specification.candidateApprovalId) {
      const approved = approvedInnerCandidate(runtimeProfile, specification.candidateApprovalId);
      if (runnerPath !== approved.runnerPath
        || Object.entries(approved.expectedHashes).some(([key, value]) => specification.expectedHashes[key] !== value)) fail("COORDINATOR_UNVERIFIED_SOURCE");
      sourceProfile = { ...runtimeProfile, installationRoot: approved.installationRoot, activeCandidateId: approved.id };
    } else if (runtimeProfile && (runnerPath !== runtimeProfile.initial.runnerPath
      || Object.entries(runtimeProfile.initial.expectedHashes).some(([key, value]) => specification.expectedHashes[key] !== value))) {
      fail("COORDINATOR_UNVERIFIED_SOURCE");
    }
    if (recycleRetiredWorkers && !recoverySeed) await shared.dispatch("reclaimRetiredWorkers");
    if (shutdownRequested()) fail("COORDINATOR_WORKER_CLOSING");
    const occupiedWorkers = new Set([...workers.values()]
      .filter(worker => worker.child.exitCode === null && worker.child.signalCode === null).map(worker => worker.workerId));
    for (const pendingId of shared.workerStartupCleanupPending ?? []) occupiedWorkers.add(pendingId);
    if (occupiedWorkers.size >= 4) fail("COORDINATOR_WORKER_LIMIT");
    const workerId = `${sessionId ? `${sessionId}-` : ""}worker-${++shared.workerSequence}`;
    const stateRoot = path.join(runtimeProfile?.stateRoot ?? root, workerId);
    const stderrPath = path.join(root, `${workerId}.stderr.log`);
    let finishStartup;
    const startupTask = new Promise(resolve => { finishStartup = resolve; });
    (shared.workerStartupTasks ??= new Set()).add(startupTask);
    let stage = "state_seed";
    let descriptor;
    let child;
    let worker;
    let forkAttempted = false;
    let forkReturned = false;
    let exitConfirmed = false;
    let spawnError;
    let finishExitWait;
    let ownsStateRoot = false;
    const observedExit = () => { exitConfirmed = true; finishExitWait?.(); };
    const observedError = error => { spawnError = error; };
    const errorCode = error => typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
      ? error.code : "COORDINATOR_WORKER_STARTUP_FAILED";
    try {
      if (fs.existsSync(stateRoot)) fail("COORDINATOR_STATE_EXISTS");
      ownsStateRoot = true;
      seedInnerWorkerState(runtimeProfile, stateRoot);
      stage = "cold_seed";
      if (!shared.coldStart) fail("COLD_START_PROTECTION_REQUIRED");
      shared.coldStart.seed(stateRoot, workerId);
      if (recoverySeed) { stage = "recovery_seed"; seedFailedWorkerRecovery(stateRoot, recoverySeed); }
      stage = "stderr_open";
      descriptor = fs.openSync(stderrPath, "wx");
      stage = "fork";
      forkAttempted = true;
      child = fork(runnerPath, [], { execPath: options.nodeExecutable ?? process.execPath,
        cwd: process.platform === "win32" && root.length >= 260 ? path.toNamespacedPath(root) : root, windowsHide: true,
        stdio: ["ignore", "ignore", descriptor, "ipc"], env: { ...process.env, ...environment,
          ...(runtimeProfile ? { CODEX_HOME: runtimeProfile.codexHome } : {}),
          CODEX_MODEL_STREAM_PROXY_STATE_ROOT: stateRoot, CODEX_MODEL_STREAM_PROXY_HOST: "127.0.0.1",
          CODEX_MODEL_STREAM_PROXY_PORT: String(specification.port ?? 0), CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN: upstreamOrigin,
          CODEX_MODEL_STREAM_PROXY_HANDOFF_CONTROL: JSON.stringify({ schemaVersion: 1, mode: runtimeProfile ? "production" : "isolated", ownerId, nativeSourceId,
            capability, checkpointRoot: root, allowRuntimeCompatibility: true,
            ...(runtimeProfile ? { nativeSourceId, runtimeProfile: { ...sourceProfile, initial: specification } } : {}) }) } });
      forkReturned = true;
      child.on("error", observedError);
      child.once("exit", observedExit);
      child.once("close", observedExit);
      stage = "fork_pid";
      if (!Number.isSafeInteger(child.pid) || child.pid < 1 || child.pid === process.pid) fail("COORDINATOR_WORKER_PID_MISSING");
      stage = "started";
      shared.coldStart.started(stateRoot, workerId, child.pid);
      stage = "stderr_close";
      fs.closeSync(descriptor);
      descriptor = undefined;
      worker = { workerId, child, stateRoot, stderrPath, ready: null, nativeSequence: 0, createdAt: new Date().toISOString(),
        threadHistory: new Set(), releasedThreadHistory: new Set(), activeHttp: 0, retired: false, cleanupPending: false, reclamation: null,
        preparedCandidate: false, wasDefault: false, wasActivated: false,
        specification: structuredClone(specification), nativeDelivered: new Map() };
      workers.set(workerId, worker);
      stage = "ready";
      const ready = new Promise((resolve, reject) => {
        worker.startup = { resolve, reject, specification,
          timer: setTimeout(shared.bindDispatch("handleWorkerReadyTimeout", worker), 15_000) };
        child.on("message", shared.bindDispatch("handleWorkerMessage", worker));
        child.once("error", shared.bindDispatch("handleWorkerError", worker));
        child.once("exit", shared.bindDispatch("handleWorkerExit", worker));
      });
      const result = await ready;
      if (shutdownRequested()) fail("COORDINATOR_WORKER_CLOSING");
      return result;
    } catch (error) {
      if (worker) worker.reclamation = "stopping";
      exitConfirmed ||= !forkAttempted || (child && (child.exitCode !== null && child.exitCode !== undefined
        || child.signalCode !== null && child.signalCode !== undefined));
      if (child) {
        if (!exitConfirmed) {
          let timer;
          try {
            await new Promise(resolve => {
              finishExitWait = resolve;
              timer = setTimeout(resolve, 1000);
              if (Number.isSafeInteger(child.pid) && child.pid > 0 && child.pid !== process.pid) {
                try { child.kill(); } catch {}
              }
              if (exitConfirmed) resolve();
            });
          } finally { clearTimeout(timer); finishExitWait = undefined; }
        }
        try { if (child.connected) child.disconnect(); } catch {}
      }
      const diagnostic = { schemaVersion: 1, workerId, stage, code: errorCode(stage === "fork_pid" && spawnError ? spawnError : error),
        childCode: spawnError ? errorCode(spawnError) : null,
        forkAttempted, forkReturned, pid: Number.isSafeInteger(child?.pid) && child.pid > 0 ? child.pid : null,
        exitConfirmed: exitConfirmed === true, exitCode: Number.isInteger(child?.exitCode) ? child.exitCode : null,
        signal: typeof child?.signalCode === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(child.signalCode) ? child.signalCode : null };
      if (forkAttempted && !exitConfirmed) (shared.workerStartupCleanupPending ??= new Set()).add(workerId);
      if (worker && exitConfirmed) workers.delete(workerId);
      else if (worker) worker.cleanupPending = true;
      if (ownsStateRoot) {
        let diagnosticDescriptor;
        try {
          checkedRuntimePath(root, { directory: true });
          diagnosticDescriptor = fs.openSync(path.join(root, `${workerId}.startup-failure.json`), "wx", 0o600);
          fs.writeFileSync(diagnosticDescriptor, JSON.stringify(diagnostic));
          fs.fsyncSync(diagnosticDescriptor);
        } catch (diagnosticError) { diagnostic.diagnosticCode = errorCode(diagnosticError); }
        finally { if (diagnosticDescriptor !== undefined) { try { fs.closeSync(diagnosticDescriptor); } catch {} } }
      }
      error.workerStartupFailure = diagnostic;
      throw error;
    } finally {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
      child?.off("error", observedError);
      child?.off("exit", observedExit);
      child?.off("close", observedExit);
      if (child && !exitConfirmed && shared.workerStartupCleanupPending?.has(workerId)) {
        const completeCleanup = () => {
          exitConfirmed = true;
          shared.workerStartupCleanupPending.delete(workerId);
          if (worker) workers.delete(workerId);
          child.off("exit", completeCleanup);
          child.off("close", completeCleanup);
        };
        child.on("error", () => {});
        child.once("exit", completeCleanup);
        child.once("close", completeCleanup);
        if (child.exitCode !== null && child.exitCode !== undefined || child.signalCode !== null && child.signalCode !== undefined) completeCleanup();
      }
      shared.workerStartupTasks.delete(startupTask);
      finishStartup();
    }
  }

  function settleWorkerStartup(worker, error) {
    const startup = worker.startup;
    if (!startup) return;
    clearTimeout(startup.timer);
    delete worker.startup;
    if (error) startup.reject(error);
    else startup.resolve(worker);
  }

  function handleWorkerMessage(worker, message) {
    if (message?.channel !== HANDOFF_CHANNEL || message.pid !== worker.child.pid) return;
    if (message.event === "recovery") {
      const envelope = message.envelope;
      const event = envelope?.recovery;
      const state = threads.get(event?.threadId);
      const expected = recoveryBinding(state);
      if (!shared.nativeHealthy || shared.closing || state?.phase !== "active" || state.worker !== worker
        || message.instanceToken !== worker.ready?.instanceToken || !alive(worker)
        || !validateRecoveryEnvelope(envelope, { ...expected, threadId: state.threadId, turnId: state.turnId }, capability)) return;
      const previous = recoveryRecords.get(event.requestId);
      if (previous && (previous.envelope.recovery.threadId !== event.threadId || previous.envelope.recovery.turnId !== event.turnId
        || previous.terminal || event.sequence <= previous.envelope.recovery.sequence)) return;
      if (!previous && ![...shared.requests.values()].some(request => request.thread === state && request.worker === worker)) return;
      if (!previous && recoveryRecords.size >= 128) {
        for (const [requestId, record] of recoveryRecords) {
          const active = threads.get(record.envelope.recovery.threadId);
          if (active?.phase !== "active" || active.turnId !== record.envelope.recovery.turnId) recoveryRecords.delete(requestId);
        }
        if (recoveryRecords.size >= 128) return;
      }
      const actionToken = canContinueRecovery(event) ? crypto.randomBytes(24).toString("hex") : null;
      recoveryRecords.set(event.requestId, { envelope: structuredClone(envelope), actionToken, consumed: false,
        terminal: ["completed", "failed", "stopped"].includes(event.phase) });
      emit("model_recovery_state", { envelope: structuredClone(envelope) });
      return;
    }
    if (message.event === "ready") {
      if (worker.ready || message.ownerId !== ownerId || !validIdentity(message.instanceToken)
        || !message.status?.running || !Number.isInteger(message.status.port) || message.status.port < 1
        || !worker.startup || Object.entries(worker.startup.specification.expectedHashes)
          .some(([key, value]) => message.sourceHashes?.[key] !== value)) {
        shared.dispatch("settleWorkerStartup", worker, new Error("COORDINATOR_READY_IDENTITY_MISMATCH"));
        return;
      }
      worker.ready = message;
      emit("worker_ready", { workerId: worker.workerId, pid: worker.child.pid, sourceHashes: message.sourceHashes });
      shared.dispatch("settleWorkerStartup", worker);
    }
    if (message.event === "startup_failed") shared.dispatch("settleWorkerStartup", worker, new Error("COORDINATOR_STARTUP_FAILED"));
    const awaiting = pending.get(message.requestId);
    if (!awaiting) {
      if (/^coordinator-\d+$/u.test(message.requestId ?? "") && message.instanceToken === worker.ready?.instanceToken) {
        emit("native_control_late_result", { requestId: message.requestId, workerId: worker.workerId,
          code: message.ok === true ? "COORDINATOR_LATE_ACK" : message.error?.code });
      }
      return;
    }
    if (awaiting.worker !== worker || message.instanceToken !== worker.ready?.instanceToken) return;
    clearTimeout(awaiting.timer);
    pending.delete(message.requestId);
    if (message.ok === true) awaiting.resolve(message.result);
    else awaiting.reject(Object.assign(new Error(message.error?.code ?? "COORDINATOR_CONTROL_FAILED"), { code: message.error?.code }));
  }

  function handleWorkerError(worker, error) {
    shared.dispatch("settleWorkerStartup", worker, error);
  }

  function handleWorkerReadyTimeout(worker) {
    shared.dispatch("settleWorkerStartup", worker, new Error("COORDINATOR_READY_TIMEOUT"));
  }

  function handleWorkerExit(worker, code, signal) {
    worker.exitedAt = new Date().toISOString();
    shared.dispatch("settleWorkerStartup", worker, new Error("COORDINATOR_WORKER_EXITED"));
    for (const [requestId, awaiting] of pending) {
      if (awaiting.worker !== worker) continue;
      clearTimeout(awaiting.timer);
      pending.delete(requestId);
      awaiting.reject(new Error("COORDINATOR_WORKER_EXITED"));
    }
    emit("worker_exited", { workerId: worker.workerId, pid: worker.child.pid, code, signal });
    if (shutdownRequested() || worker.reclamation === "stopping" || worker.recoveryTask
      || (!threadStates().some(state => state.worker === worker) && shared.defaultWorker !== worker)) return;
    worker.recoveryEvents = threadStates().filter(state => state.worker === worker)
      .flatMap(state => [state.start, state.completion].filter(Boolean)).map(event => ({ ...event }));
    const previous = shared.failureRecoveryTask ?? Promise.resolve();
    const preserveCandidate = process.platform === "win32" && code === 0x40010004 && signal === null;
    worker.recoveryTask = previous.catch(() => {}).then(() => recoverFailedWorker(worker, { preserveCandidate }));
    shared.failureRecoveryTask = worker.recoveryTask;
    worker.recoveryTask.catch(error => {
      worker.recoveryError = error.code ?? error.message;
      emit("worker_recovery_failed", { workerId: worker.workerId, code: worker.recoveryError });
    });
  }

  async function recoverFailedWorker(worker, { preserveCandidate = false } = {}) {
    if (worker.manualExitCommandId) return;
    const deadline = Date.now() + 15000;
    while (shared.transactionActive || shared.workerMaintenance || shared.preparationTask) {
      if (shutdownRequested() || worker.manualExitCommandId) return;
      if (Date.now() >= deadline) fail("WORKER_RECOVERY_BUSY");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (shutdownRequested() || worker.manualExitCommandId) return;
    const activation = shared.activation;
    const failedCandidate = activation?.target === worker;
    const fallback = failedCandidate && !preserveCandidate ? activation.source : worker;
    const rollbackCandidate = failedCandidate && activation.active && !preserveCandidate;
    let rollbackCommitted = false;
    const commitRollback = candidate => {
      if (!rollbackCandidate || rollbackCommitted || shutdownRequested() || !shared.nativeHealthy
        || !alive(candidate) || candidate === worker || shared.defaultWorker !== candidate) return;
      rollbackCommitted = true;
      emit("activation_automatically_rolled_back", { activationId: activation.id, failedWorkerId: activation.rollbackWorkerId ?? worker.workerId,
        defaultWorkerId: candidate.workerId });
    };
    if (rollbackCandidate) {
      const health = alive(fallback) ? await shared.dispatch("control", fallback, "check").catch(() => null) : null;
      if (shutdownRequested() || worker.manualExitCommandId) return;
      activation.active = false;
      if (alive(fallback) && health?.status?.running && !health.status.draining && shared.nativeHealthy) {
        shared.defaultWorker = fallback;
        fallback.retired = false;
      }
      for (const state of threadStates()) if (state.pendingActivation === activation) {
        delete state.pendingActivation;
        delete state.activationError;
      }
      worker.retired = true;
      commitRollback(fallback);
    }
    const affected = threadStates().filter(state => state.worker === worker);
    if (!affected.length && shared.defaultWorker !== worker) return;
    if (!fallback || (worker.recoveredFrom && !preserveCandidate && !rollbackCandidate)) fail("WORKER_RECOVERY_SOURCE_UNAVAILABLE");
    const fallbackSpecification = workerSpecification(fallback);
    const seed = readFailedWorkerRecovery({ root: runtimeProfile?.stateRoot ?? root, worker,
      ownerId, nativeSourceId, sessionId, threadIds: affected.map(state => state.threadId) });
    shared.workerMaintenance = true;
    let replacement;
    try {
      replacement = await shared.dispatch("launchWorker", fallbackSpecification, { recoverySeed: seed });
      if (worker.manualExitCommandId) fail("WORKER_MANUALLY_EXITED");
      replacement.recoveredFrom = worker.workerId;
      replacement.wasActivated = true;
      const validThreads = new Set(affected.map(state => state.threadId));
      let eventIndex = 0;
      const relayRecoveryEvents = async () => {
        while (eventIndex < worker.recoveryEvents.length) {
          const event = worker.recoveryEvents[eventIndex++];
          if (validThreads.has(event.threadId)) await shared.dispatch("relayNative", replacement, event);
        }
      };
      await relayRecoveryEvents();
      for (const state of affected) {
        const health = await shared.dispatch("control", replacement, "check", { threadId: state.threadId });
        const plan = { schemaVersion: 1, id: crypto.randomUUID(), generation: ++shared.generation,
          threadId: state.threadId, expiresAt: Date.now() + 120000, source: identity(worker), target: identity(replacement),
          compatibility: failedCandidate && !preserveCandidate ? reverseHandoffCompatibility(activation?.compatibility) ?? null : null };
        await shared.dispatch("control", replacement, "authorizeMigration", { role: "target", plan });
        const checkpoint = writeWorkerRecoveryCheckpoint({ root, ownerId, capability, worker, threadId: state.threadId,
          native: health.native, plan, seed });
        await shared.dispatch("control", replacement, "accept", checkpoint);
      }
      await relayRecoveryEvents();
      const replacementHealth = await shared.dispatch("control", replacement, "check");
      if (worker.manualExitCommandId) fail("WORKER_MANUALLY_EXITED");
      if (!alive(replacement) || shutdownRequested() || !shared.nativeHealthy
        || !replacementHealth.status.running || replacementHealth.status.draining) fail("WORKER_RECOVERY_TARGET_UNAVAILABLE");
      for (const state of affected) {
        if (state.worker !== worker) fail("WORKER_RECOVERY_OWNER_CHANGED");
        state.worker = replacement;
        delete state.pendingActivation;
        delete state.activationError;
        delete state.migrationCleanupError;
        worker.releasedThreadHistory.add(state.threadId);
      }
      if (shared.defaultWorker === worker) { shared.defaultWorker = replacement; replacement.wasDefault = true; }
      if (preserveCandidate && failedCandidate) {
        activation.rollbackWorkerId ??= worker.workerId;
        activation.target = replacement;
      }
      if (preserveCandidate && activation?.source === worker) activation.source = replacement;
      worker.replacementWorker = replacement;
      commitRollback(replacement);
      emit("worker_recovered", { workerId: worker.workerId, replacementWorkerId: replacement.workerId,
        threadIds: affected.map(state => state.threadId), protectedOperations: seed.operationState.entries.length,
        ...(preserveCandidate ? { selectionPreserved: true } : {}) });
    } catch (error) {
      if (replacement) {
        replacement.retired = true;
        try { await releaseWorker(replacement, candidate => !threadStates().some(state => state.worker === candidate)
          && candidate !== shared.defaultWorker && candidate.activeHttp === 0, "failed_recovery"); }
        catch { replacement.cleanupPending = true; }
      }
      throw error;
    } finally { shared.workerMaintenance = false; }
  }

  async function relayNative(worker, event) {
    worker.nativeDelivered ??= new Map();
    if ((worker.nativeDelivered.get(event.threadId) ?? -1) >= event.sequence) return;
    worker.threadHistory.add(event.threadId);
    const identity = worker.ready;
    const forwarded = { ...event, sequence: ++worker.nativeSequence };
    let result;
    try {
      result = await shared.dispatch("control", worker, "nativeTurn", { event: forwarded });
    } catch (error) {
      if (error.code !== "COORDINATOR_IPC_TIMEOUT" || error.method !== "nativeTurn" || !alive(worker)
        || worker.ready !== identity || shutdownRequested()) throw error;
      emit("native_relay_reconciling", { code: error.code, requestId: error.requestId,
        workerId: worker.workerId, threadHash: digest(event.threadId).slice(0, 16),
        turnHash: digest(event.turnId).slice(0, 16), phase: event.phase, sequence: forwarded.sequence });
      const checked = await shared.dispatch("control", worker, "check", { threadId: event.threadId });
      const native = checked?.native;
      if (!alive(worker) || worker.ready !== identity || shutdownRequested() || !checked?.status?.running
        || checked.status.draining || checked.prepared !== false || native?.turnId !== forwarded.turnId
        || native.phase !== forwarded.phase || native.sequence !== forwarded.sequence
        || (forwarded.phase === "terminal" && native.status !== forwarded.status)
        || (forwarded.connectionGeneration && native.connectionGeneration !== forwarded.connectionGeneration)) {
        throw Object.assign(new Error("COORDINATOR_NATIVE_RECONCILIATION_FAILED"), {
          code: "COORDINATOR_NATIVE_RECONCILIATION_FAILED", method: "nativeTurn", requestId: error.requestId, outcomeUnknown: true,
        });
      }
      result = { recorded: true, sequence: native.sequence, reconciled: true };
      emit("native_relay_reconciled", { code: "COORDINATOR_NATIVE_ACK_CONFIRMED", requestId: error.requestId,
        workerId: worker.workerId, threadHash: digest(event.threadId).slice(0, 16),
        turnHash: digest(event.turnId).slice(0, 16), phase: event.phase, sequence: forwarded.sequence });
    }
    worker.nativeDelivered.set(event.threadId, event.sequence);
    return result;
  }

  async function releaseWorker(worker, eligible, reason) {
    worker.reclamation = "stopping";
    if (alive(worker)) {
      try { await shared.dispatch("control", worker, "shutdown"); }
      catch (error) {
        if (worker.child.exitCode === null && worker.child.signalCode === null) {
          worker.reclamation = "cleanup_pending";
          throw error;
        }
      }
    }
    if (worker.child.exitCode === null && worker.child.signalCode === null) {
      if (worker.child.connected) worker.child.disconnect();
      let timer;
      try {
        await Promise.race([once(worker.child, "exit"), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("COORDINATOR_RECLAMATION_PENDING")), 15_000);
        })]);
      } catch (error) { worker.reclamation = "cleanup_pending"; throw error; }
      finally { clearTimeout(timer); }
    }
    if (!eligible(worker)) fail("COORDINATOR_RECLAMATION_REFERENCE_CHANGED");
    workers.delete(worker.workerId);
    const receipt = { workerId: worker.workerId, pid: worker.child.pid, sourceHashes: worker.ready?.sourceHashes ?? null,
      exitCode: worker.child.exitCode, signalCode: worker.child.signalCode, stateRoot: worker.stateRoot,
      reclaimedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
    reclaimedWorkers.push(receipt);
    if (reclaimedWorkers.length > 64) reclaimedWorkers.shift();
    emit("worker_reclaimed", receipt);
    return receipt;
  }

  async function discardCandidate({ workerId } = {}) {
    if (!validIdentity(workerId)) fail("COORDINATOR_INVALID_CANDIDATE");
    const worker = workers.get(workerId);
    if (!worker) {
      const receipt = reclaimedWorkers.find(entry => entry.workerId === workerId && entry.reason === "discarded_candidate");
      if (receipt) return { ...receipt, discarded: true, alreadyDiscarded: true };
      fail("COORDINATOR_WORKER_NOT_FOUND");
    }
    if (shared.transactionActive || shared.workerMaintenance || shared.preparationTask || shared.starting
      || shared.closing || !shared.nativeHealthy) fail("COORDINATOR_CANDIDATE_DISCARD_BUSY");
    const eligible = candidate => candidate.preparedCandidate === true && candidate.ready && !candidate.startup
      && !candidate.wasDefault && !candidate.wasActivated && !candidate.cleanupPending
      && candidate !== shared.defaultWorker && candidate !== shared.activation?.source && candidate !== shared.activation?.target
      && candidate.activeHttp === 0 && candidate.nativeSequence === 0 && candidate.threadHistory.size === 0
      && candidate.releasedThreadHistory.size === 0
      && !threadStates().some(state => state.worker === candidate
        || state.pendingActivation?.source === candidate || state.pendingActivation?.target === candidate)
      && ![...shared.requests.values()].some(request => request.worker === candidate || request.thread?.worker === candidate)
      && ![...pending.values()].some(request => request.worker === candidate);
    if (!eligible(worker)) fail("COORDINATOR_CANDIDATE_PROTECTED");
    shared.workerMaintenance = true;
    try {
      if (alive(worker)) {
        const health = await shared.dispatch("control", worker, "check");
        if (!health.status.running || health.status.draining || health.status.activeRequests !== 0
          || health.nativeHistory?.retained !== 0 || health.nativeHistory?.archived !== 0) fail("COORDINATOR_CANDIDATE_PROTECTED");
      }
      if (!eligible(worker)) fail("COORDINATOR_CANDIDATE_PROTECTED");
      const receipt = await releaseWorker(worker, eligible, "discarded_candidate");
      return { ...receipt, discarded: true, alreadyDiscarded: false };
    } finally { shared.workerMaintenance = false; }
  }

  async function reclaimRetiredWorkers() {
    await shared.relay;
    if (shared.transactionActive || shared.workerMaintenance || shared.closing || !shared.nativeHealthy) fail("COORDINATOR_RECLAMATION_BUSY");
    const memoryGuards = new Map();
    const memoryClear = worker => {
      try { return memoryGuards.get(worker)?.() === true; } catch { return false; }
    };
    const rootMemorySnapshot = () => {
      if ((shared.internalMemoryAcquires ?? 0) !== 0) fail("COORDINATOR_INTERNAL_MEMORY_ACQUIRING");
      const router = shared.internalMemoryRouter;
      if (!router) return { fingerprint: "absent", operations: [] };
      const status = router.status();
      if (![status.operations, status.connections].every(value => Number.isSafeInteger(value) && value >= 0)) {
        fail("COORDINATOR_INTERNAL_MEMORY_ROOT_UNVERIFIED");
      }
      if (status.operations === 0 && status.connections === 0) return { fingerprint: "empty", operations: [] };
      if (status.operations === 0) fail("COORDINATOR_INTERNAL_MEMORY_ROOT_UNVERIFIED");
      const snapshot = router.operationSnapshot?.();
      if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0
        || !Array.isArray(snapshot.operations) || snapshot.operations.length !== status.operations || snapshot.operations.length > 2048) {
        fail("COORDINATOR_INTERNAL_MEMORY_ASSOCIATION_UNAVAILABLE");
      }
      const ids = new Set();
      const operations = snapshot.operations.map(operation => {
        if (!validIdentity(operation.operationId) || !validIdentity(operation.workerId) || ids.has(operation.operationId)
          || !Number.isSafeInteger(operation.activeHttp) || operation.activeHttp < 0) fail("COORDINATOR_INTERNAL_MEMORY_ROOT_UNVERIFIED");
        ids.add(operation.operationId);
        return { operationId: operation.operationId, workerId: operation.workerId, activeHttp: operation.activeHttp };
      });
      return { fingerprint: JSON.stringify([snapshot.revision, status.connections, operations]), operations };
    };
    const inspectMemory = async worker => {
      try {
        const revision = shared.internalMemoryAcquireRevision ?? 0;
        const root = rootMemorySnapshot();
        const child = worker.child;
        const instanceToken = worker.ready?.instanceToken;
        const unchanged = () => shared.nativeHealthy && !shared.closing
          && worker.child === child && worker.ready?.instanceToken === instanceToken
          && (worker.reclamation === "stopping" && (child.exitCode !== null || child.signalCode !== null)
          || (shared.internalMemoryAcquires ?? 0) === 0
          && (shared.internalMemoryAcquireRevision ?? 0) === revision
          && rootMemorySnapshot().fingerprint === root.fingerprint);
        if (!shared.internalMemoryRouter && !worker.ready?.status?.internalMemory) return unchanged;
        const expected = root.operations.filter(operation => operation.workerId === worker.workerId);
        if (expected.some(operation => operation.activeHttp !== 0)) return null;
        const status = await shared.dispatch("control", worker, "internalMemoryStatus");
        if (!unchanged() || !status || status.blocked !== false || status.closed !== false
          || ![status.pendingPermits, status.sending, status.unknown].every(value => value === 0)
          || !Array.isArray(status.operationSummaries) || status.operationSummaries.length !== status.operations) return null;
        const summaries = new Map();
        for (const summary of status.operationSummaries) {
          if (!validIdentity(summary.operationId) || summaries.has(summary.operationId)
            || ![summary.pendingPermits, summary.sending, summary.unknown].every(value => value === 0)
            || summary.awaitingToolContinuation !== false || summary.lastResponseCompletedWithoutTools !== true
            || !["extract", "consolidate"].includes(summary.kind) || !Array.isArray(summary.steps)) return null;
          const generation = summary.steps.filter(step => step.kind === summary.kind
            && ["SENDING", "UNKNOWN", "COMPLETED", "RETRYABLE"].includes(step.state)).at(-1);
          if (generation?.state !== "COMPLETED" || generation.toolDelivered !== false) return null;
          summaries.set(summary.operationId, summary);
        }
        if (expected.some(operation => !summaries.has(operation.operationId))) return null;
        return unchanged;
      } catch (error) {
        emit("retired_internal_memory_preserved", { workerId: worker.workerId,
          code: error.code ?? "COORDINATOR_INTERNAL_MEMORY_STATUS_UNAVAILABLE" });
        return null;
      }
    };
    const eligible = worker => memoryClear(worker) && worker.retired && !worker.cleanupPending && worker !== shared.defaultWorker && worker.activeHttp === 0
      && shared.activation?.source !== worker
      && !threadStates().some(state => state.worker === worker
        || state.pendingActivation?.source === worker || state.pendingActivation?.target === worker)
      && ![...worker.threadHistory].some(threadId => !worker.releasedThreadHistory?.has(threadId) && !findThread(threadId))
      && ![...shared.requests.values()].some(request => request.worker === worker || request.thread?.worker === worker)
      && ![...pending.values()].some(request => request.worker === worker);
    shared.workerMaintenance = true;
    try {
      for (const worker of [...workers.values()]) {
        if (!worker.retired || worker === shared.defaultWorker || worker.cleanupPending || worker.activeHttp !== 0) continue;
        const guard = await inspectMemory(worker);
        if (!guard) continue;
        memoryGuards.set(worker, guard);
        const transferable = () => memoryClear(worker) && [...workers.values()].filter(candidate => alive(candidate)).length >= 4
          && shared.nativeHealthy && !shared.closing && worker.retired && alive(worker)
          && worker !== shared.defaultWorker && !worker.cleanupPending && !worker.startup && worker.activeHttp === 0
          && shared.activation?.source !== worker
          && !threadStates().some(state => state.pendingActivation
            && (state.worker === worker || state.pendingActivation.source === worker || state.pendingActivation.target === worker)
            && !idleTerminal(state, true))
          && threadStates().filter(state => state.worker === worker).every(state => idleTerminal(state, true))
          && ![...shared.requests.values()].some(request => request.worker === worker || request.thread?.worker === worker)
          && ![...pending.values()].some(request => request.worker === worker);
        if (transferable()) {
          for (const threadId of worker.threadHistory) {
            if (worker.releasedThreadHistory?.has(threadId)) continue;
            if (!transferable()) break;
            const target = [...new Set([shared.defaultWorker, shared.activation?.source, ...workers.values()])].find(candidate =>
              candidate && candidate !== worker && alive(candidate) && candidate.wasDefault
              && !candidate.startup && !candidate.cleanupPending && candidate.activeHttp === 0
              && !candidate.threadHistory.has(threadId)
              && ![...pending.values()].some(request => request.worker === candidate)
              && !threadStates().some(state => state.worker === candidate && (state.nativeRelays > 0
                || (state.pendingActivation && !idleTerminal(state, true))))
              && (identity(worker).core === identity(candidate).core && identity(worker).helper === identity(candidate).helper
                || shared.activation?.compatibility?.manifest.edges.some(edge => edge.source.core === identity(worker).core
                  && edge.source.helper === identity(worker).helper && edge.target.core === identity(candidate).core
                  && edge.target.helper === identity(candidate).helper)));
            if (!target) break;
            let state = findThread(threadId);
            if (state && state.worker !== worker) continue;
            if (!state) {
              const owners = historyOwners(threadId);
              if (owners.length !== 1 || owners[0] !== worker) continue;
              const health = await shared.dispatch("control", worker, "check", { threadId, inspectExpired: true });
              const native = health.native;
              if (!native && health.historicalRecovery?.empty === true
                && health.historicalRecovery.threadId === threadId && health.historicalRecovery.entries === 0
                && health.historicalRecovery.recoveryEntries === 0 && health.historicalRecovery.operationEntries === 0
                && health.historicalRecovery.operationStateVerified === true
                && (health.status.operationLedger?.protectedOperations ?? 0) === 0
                && health.status.running && !health.status.draining && health.status.activeRequests === 0
                && transferable() && !findThread(threadId) && historyOwners(threadId).length === 1) {
                (worker.releasedThreadHistory ??= new Set()).add(threadId);
                emit("retired_empty_history_released", { workerId: worker.workerId, threadId,
                  snapshotSha256: health.historicalRecovery.snapshotSha256 });
                continue;
              }
              if (!native || native.phase !== "terminal" || typeof native.turnId !== "string" || !native.turnId
                || native.turnId.length > 512 || native.turnId.includes("\u0000")
                || !["completed", "failed", "interrupted"].includes(native.status)) {
                emit("retired_history_preserved", { workerId: worker.workerId, threadId,
                  code: "COORDINATOR_TERMINAL_HISTORY_UNAVAILABLE" });
                continue;
              }
              const start = { threadId, turnId: native.turnId, phase: "active", sequence: ++shared.nativeSequence };
              const completion = { threadId, turnId: native.turnId, phase: "terminal", status: native.status,
                sequence: ++shared.nativeSequence };
              state = { threadId, turnId: native.turnId, phase: "terminal", epoch: completion.sequence,
                worker, activeHttp: 0, nativeRelays: 0, start, completion };
            }
            try {
              const receipt = await shared.dispatch("migrate", { threadId, candidateId: target.workerId,
                compatibility: shared.activation?.compatibility, drainTimeoutMs: 0 },
              { selectDefault: false, reclamation: true, historicalState: findThread(threadId) ? undefined : state });
              if (state.pendingActivation?.target === target) delete state.pendingActivation;
              emit("retired_history_transferred", { workerId: worker.workerId, targetWorkerId: target.workerId,
                threadId, checkpointSha256: receipt.checkpointSha256 });
            } catch (error) {
              emit("retired_history_preserved", { workerId: worker.workerId, threadId,
                code: error.code ?? "COORDINATOR_TERMINAL_TRANSFER_FAILED" });
              break;
            }
          }
        }
        if (!eligible(worker)) continue;
        await releaseWorker(worker, eligible);
      }
    } finally { shared.workerMaintenance = false; }
  }

  function observeNativeMessage(sourceId, message) {
    if (sourceId !== nativeSourceId) fail("COORDINATOR_NATIVE_SOURCE_MISMATCH");
    if (!["turn/started", "turn/completed"].includes(message?.method)) return shared.relay;
    const threadId = message.params?.threadId;
    const turnId = message.params?.turn?.id;
    const terminal = message.method === "turn/completed";
    if (typeof threadId !== "string" || !threadId || threadId.length > 512 || typeof turnId !== "string" || !turnId
      || turnId.length > 512 || (terminal && !["completed", "failed", "interrupted"].includes(message.params.turn.status))) fail("COORDINATOR_NATIVE_EVENT_INVALID");
    const previous = findThread(threadId);
    if (!terminal && previous?.pendingNativeStartRecovery && previous.turnId !== turnId) fail("COORDINATOR_NATIVE_SEQUENCE_INVALID");
    if (previous?.turnId === turnId && ((!terminal && ["active", "terminal"].includes(previous.phase))
      || (terminal && previous.phase === "terminal" && previous.completion?.status === message.params.turn.status))) {
      if (!terminal && previous.phase === "active") rootAdmissions.observeStart(previous, previous.start,
        "legacy_unknown", message.rootAdmissionNativeIdentity);
      if (!terminal && previous.phase === "active" && !previous.start.connectionGeneration && validIdentity(message.recoveryConnectionGeneration)) {
        queueRecoveryBinding(previous, { threadId, turnId, connectionGeneration: message.recoveryConnectionGeneration });
      }
      return shared.relay;
    }
    if ((!previous && terminal) || (previous && terminal && (previous.phase !== "active" || previous.turnId !== turnId))
      || (previous?.phase === "active" && !terminal)) fail("COORDINATOR_NATIVE_SEQUENCE_INVALID");
    const owners = previous ? [] : historyOwners(threadId);
    if (owners.length > 1) fail("COORDINATOR_THREAD_OWNER_AMBIGUOUS");
    if (!threads.has(threadId)) reserveThreadSlot(threadId);
    const event = { sequence: ++shared.nativeSequence, threadId, turnId, phase: terminal ? "terminal" : "active",
      ...(!terminal && validIdentity(message.recoveryConnectionGeneration) ? { connectionGeneration: message.recoveryConnectionGeneration } : {}),
      ...(terminal ? { status: message.params.turn.status } : {}) };
    const state = Object.assign(previous ?? {}, { threadId, turnId, phase: event.phase, epoch: event.sequence,
      worker: previous?.worker ?? owners[0] ?? shared.defaultWorker, activeHttp: previous?.activeHttp ?? 0,
      nativeRelays: (previous?.nativeRelays ?? 0) + 1,
      start: terminal ? previous.start : event, completion: terminal ? event : null });
    if (!terminal) delete state.recoveryBindingError;
    if (!terminal && shared.activation?.active && state.worker !== shared.activation.target) state.pendingActivation = shared.activation;
    shared.terminalThreads?.delete(threadId);
    threads.set(threadId, state);
    let admissionOrigin = message.rootAdmissionOrigin ?? "native_notification";
    if (admissionOrigin === "authoritative_lookup" && message.rootAdmissionNativeIdentity
      && options.getExpectedNativeIdentity?.isCurrent?.(message.rootAdmissionNativeIdentity) === true) admissionOrigin = "turn_start_rpc";
    if (!terminal) rootAdmissions.observeStart(state, event, admissionOrigin, message.rootAdmissionNativeIdentity);
    else rootAdmissions.observeTerminal(state, event);
    if (state.worker.recoveryTask && !state.worker.replacementWorker) state.worker.recoveryEvents.push({ ...event });
    shared.relay = shared.relay.then(shared.bindDispatch("relayNativeEvent", event))
      .catch(shared.bindDispatch("handleNativeRelayFailure"));
    return shared.relay;
  }

  async function relayNativeEvent(event) {
    const current = findThread(event.threadId);
    try {
      await migrations.get(event.threadId)?.done;
      const recovering = current.worker;
      if (recovering.recoveryTask) {
        try { await recovering.recoveryTask; }
        catch (error) {
          emit("native_turn_retained", { threadId: event.threadId, turnId: event.turnId,
            workerId: recovering.workerId, code: error.code ?? "WORKER_RECOVERY_FAILED" });
          return;
        }
      }
      await shared.dispatch("relayNative", current.worker, event);
      current.worker.releasedThreadHistory?.delete(event.threadId);
      emit("native_turn_relayed", { threadId: event.threadId, turnId: event.turnId, phase: event.phase,
        workerId: current.worker.workerId, sequence: event.sequence });
    } catch (error) {
      if (!alive(current.worker)) {
        emit("native_turn_retained", { threadId: event.threadId, turnId: event.turnId,
          workerId: current.worker.workerId, code: error.code ?? "WORKER_RECOVERY_PENDING" });
        return;
      }
      throw error;
    } finally { if (current?.nativeRelays > 0) current.nativeRelays -= 1; }
  }

  function recoveryBinding(state) {
    if (!state || state.phase !== "active" || !alive(state.worker) || !state.start?.connectionGeneration) return null;
    return { ownerId, nativeSourceId, producerId: state.worker.ready.instanceToken, producerPid: state.worker.child.pid,
      sourceHashes: state.worker.ready.sourceHashes, connectionGeneration: state.start.connectionGeneration };
  }

  function queueRecoveryBinding(state, input) {
    const start = state.start;
    state.nativeRelays = (state.nativeRelays ?? 0) + 1;
    const binding = shared.relay.then(async () => {
      await migrations.get(input.threadId)?.done;
      let current = findThread(input.threadId);
      if (current?.worker.recoveryTask) await current.worker.recoveryTask;
      current = findThread(input.threadId);
      if (!shared.nativeHealthy || shared.closing || current !== state || current.start !== start
        || current.phase !== "active" || current.turnId !== input.turnId || !alive(current.worker)) fail("RECOVERY_BINDING_INVALID");
      if (start.connectionGeneration === input.connectionGeneration) return;
      if (start.connectionGeneration) fail("RECOVERY_BINDING_CONFLICT");
      const worker = current.worker;
      const result = await shared.dispatch("control", worker, "bindRecovery", input);
      if (current.start !== start || current.phase !== "active" || current.worker !== worker || !alive(worker)) fail("RECOVERY_BINDING_INVALID");
      start.connectionGeneration = input.connectionGeneration;
      delete current.recoveryBindingError;
      emit("native_binding_confirmed", { threadId: input.threadId, turnId: input.turnId, workerId: worker.workerId });
      return result;
    }).catch(error => {
      if (state.start === start) state.recoveryBindingError = error.code ?? error.message;
      emit("native_binding_failed", { threadId: input.threadId, turnId: input.turnId,
        workerId: state.worker.workerId, code: error.code ?? "RECOVERY_BINDING_FAILED" });
      throw error;
    }).finally(() => { state.nativeRelays -= 1; });
    shared.relay = binding.catch(() => {});
    return binding;
  }

  function recoveryControl(method, input) {
    const state = threads.get(input.threadId);
    if (method === "bind-native") {
      if (!shared.nativeHealthy || state?.phase !== "active" || state.turnId !== input.turnId
        || !validIdentity(input.connectionGeneration)) fail("RECOVERY_BINDING_INVALID");
      if (state.start.connectionGeneration === input.connectionGeneration) return shared.relay;
      if (state.start.connectionGeneration) fail("RECOVERY_BINDING_CONFLICT");
      return queueRecoveryBinding(state, { ...input });
    }
    const rootRecord = rootRecoveryRecords.get(input.requestId);
    if (method === "binding" && rootRecord && rootRecord.job.metadata.thread_id === input.threadId
      && rootRecord.job.metadata.turn_id === input.turnId && rootAdmissions.binding(rootRecord.job)) {
      return { ...rootRecord.identity, current: rootRecord.envelope };
    }
    const binding = recoveryBinding(state);
    const record = recoveryRecords.get(input.requestId);
    if (method === "binding") return binding && state.turnId === input.turnId ? {
      ...binding, current: record?.envelope ?? null } : null;
    if (method !== "continue-http" || !shared.nativeHealthy || shared.closing || !binding || state.turnId !== input.turnId
      || !record || record.terminal || record.consumed || !canContinueRecovery(record.envelope.recovery)
      || input.sequence !== record.envelope.recovery.sequence || input.actionToken !== record.actionToken
      || !validateRecoveryEnvelope(record.envelope, { ...binding, threadId: input.threadId,
        turnId: input.turnId, requestId: input.requestId }, capability)
      || ["ownerId", "nativeSourceId", "producerId", "producerPid", "connectionGeneration"].some(key => input[key] !== binding[key])
      || Object.entries(binding.sourceHashes).some(([key, value]) => input.sourceHashes?.[key] !== value)) {
      fail("RECOVERY_ACTION_STALE_OR_DISABLED");
    }
    record.consumed = true;
    record.actionToken = null;
    rootAdmissions.beforeWorkerWrite({ thread_id: input.threadId, turn_id: input.turnId });
    return shared.dispatch("control", state.worker, "continueHttp", { threadId: input.threadId, turnId: input.turnId,
      recoveryRequestId: input.requestId, sequence: input.sequence, nativeSourceId, producerId: binding.producerId,
      producerPid: binding.producerPid, connectionGeneration: binding.connectionGeneration });
  }

  function handleNativeRelayFailure(error) {
    shared.nativeHealthy = false;
    const code = error.code ?? "NATIVE_RELAY_FAILED";
    emit("native_relay_failed", { code, ...(typeof error.method === "string" ? { method: error.method } : {}),
      ...(typeof error.requestId === "string" ? { requestId: error.requestId } : {}), outcomeUnknown: Boolean(error.outcomeUnknown) });
    throw Object.assign(error, { code });
  }

  function nativeResponseLease(routed, connectionId, binding) {
    const worker = routed.worker;
    const child = worker.child;
    const instanceToken = worker.ready.instanceToken;
    const implementation = shared.implementation;
    const generation = shared.implementationGeneration;
    const socket = routed.request.socket;
    const registry = shared.nativeRootFailedPeers;
    const entry = registry?.entries.get(connectionId);
    if (entry && entry.socket === socket) entry.lease = routed;
    let terminalEvidence = null;
    const memorySnapshot = () => {
      if ((shared.internalMemoryAcquires ?? 0) !== 0) return null;
      const router = shared.internalMemoryRouter;
      if (!router) return { fingerprint: "absent", operations: [] };
      const status = router.status();
      if (![status.operations, status.connections].every(value => Number.isSafeInteger(value) && value >= 0)
        || status.operations === 0 && status.connections !== 0) return null;
      if (status.operations === 0) return { fingerprint: "empty", operations: [] };
      const snapshot = router.operationSnapshot?.();
      if (!snapshot || !Number.isSafeInteger(snapshot.revision) || !Array.isArray(snapshot.operations)
        || snapshot.operations.length !== status.operations || snapshot.operations.length > 2048
        || snapshot.operations.some(operation => !validIdentity(operation.operationId) || !validIdentity(operation.workerId)
          || operation.activeHttp !== 0)) return null;
      return { fingerprint: JSON.stringify([snapshot.revision, status.connections, snapshot.operations]), operations: snapshot.operations };
    };
    const current = signal => !signal?.aborted && terminalEvidence !== null && routed.accounted
      && !shutdownRequested() && shared.nativeHealthy && !shared.transactionActive && !shared.workerMaintenance
      && shared.implementation === implementation && shared.implementationGeneration === generation
      && routed.implementationGeneration === generation && routed.worker === worker && routed.thread.worker === worker
      && worker.child === child && worker.ready?.instanceToken === instanceToken && alive(worker)
      && !worker.recoveryTask && !worker.recoveryError && !routed.thread.migrationCleanupError
      && worker.activeHttp === 0 && routed.thread.activeHttp === 0
      && ![...shared.requests.values()].some(request => request.worker === worker)
      && ![...pending.values()].some(request => request.worker === worker)
      && routed.request.socket === socket && !socket?.destroyed && !routed.request.aborted
      && shared.nativeRootFailedPeers === registry && registry?.entries.get(connectionId) === entry
      && entry !== undefined && entry.socket === socket && entry.lease === routed && !entry.failed
      && (routed.thread.operationId ? true : findThread(routed.thread.threadId) === routed.thread
        && routed.thread.phase === "terminal" && routed.thread.completion?.status === "completed"
        && !migrations.has(routed.thread.threadId) && !routed.thread.pendingActivation);
    return { ...binding,
      release(evidence) {
        if (routed.accounted) return;
        if (evidence?.connectionId === connectionId && evidence.completedWithoutTools === true
          && typeof evidence.responseId === "string" && evidence.responseId.length > 0 && evidence.responseId.length <= 512) {
          terminalEvidence = Object.freeze({ responseId: evidence.responseId });
        }
        shared.dispatch("releaseHttpRequest", routed);
      },
      async canReclaimConnection({ connectionId: requestedConnection, signal } = {}) {
        if (requestedConnection !== connectionId || !current(signal)) return false;
        try {
          const memory = memorySnapshot();
          if (!memory) return false;
          const revision = { http: shared.httpSequence, native: shared.nativeSequence, control: shared.requestSequence + 1,
            memory: shared.internalMemoryAcquireRevision ?? 0, worker: worker.nativeSequence };
          const checked = await shared.dispatch("control", worker, "check", { threadId: routed.thread.threadId });
          const status = checked?.status;
          const internal = status?.internalMemory;
          if (!current(signal) || checked.prepared !== false || status?.pid !== child.pid || status.instanceToken !== instanceToken
            || status.running !== true || status.draining !== false || status.activeRequests !== 0
            || status.operationLedger?.protectedOperations !== 0 || status.unresolvedOperations !== 0
            || status.recoveryWaitingRequests !== 0 || status.nativeWebSockets?.activeRequests !== 0
            || ![status.incrementalTransport?.active, status.incrementalTransport?.queued,
              status.incrementalTransport?.receiving, status.incrementalTransport?.unknownOperations].every(value => value === 0)
            || internal?.blocked !== false || internal.closed !== false
            || ![internal.pendingPermits, internal.sending, internal.unknown].every(value => value === 0)
            || !Array.isArray(internal.operationSummaries) || internal.operationSummaries.length !== internal.operations
            || internal.operationSummaries.some(operation => !validIdentity(operation.operationId)
              || ![operation.pendingPermits, operation.sending, operation.unknown].every(value => value === 0)
              || operation.awaitingToolContinuation !== false || operation.lastResponseCompletedWithoutTools !== true)) return false;
          const summaries = new Map(internal.operationSummaries.map(operation => [operation.operationId, operation]));
          if (memory.operations.some(operation => operation.workerId === worker.workerId && !summaries.has(operation.operationId))) return false;
          if (routed.thread.operationId) {
            if (!summaries.has(routed.thread.operationId)) return false;
          } else if (checked.native?.phase !== "terminal" || checked.native.status !== "completed"
            || checked.native.turnId !== routed.thread.turnId || checked.native.sequence !== routed.thread.completion?.sequence) return false;
          const validate = () => current(signal) && shared.httpSequence === revision.http && shared.nativeSequence === revision.native
            && shared.requestSequence === revision.control
            && (shared.internalMemoryAcquireRevision ?? 0) === revision.memory && worker.nativeSequence === revision.worker
            && memorySnapshot()?.fingerprint === memory.fingerprint;
          return validate() ? Object.freeze({ validate }) : false;
        } catch { return false; }
      },
    };
  }

  async function acquireNativeResponse(input) {
    const source = rootSourcePayload(input.payload);
    if (input.bodySource && (!source || source.document.source.bytes !== input.bodySource.bytes
      || typeof input.bodySource.sha256 !== "string" || source.document.source.sha256 !== input.bodySource.sha256)) {
      fail("COORDINATOR_INVALID_REQUEST_TARGET");
    }
    if (!rootAdmissionProtocolSupported(input.rootAdmissionProtocol)) return acquireNativeResponseLease(input);
    let metadata;
    try { metadata = JSON.parse(input.payload?.client_metadata?.["x-codex-turn-metadata"]); } catch {}
    const attempt = rootAdmissions.begin(metadata, { payload: input.payload, transport: "ws", requestPath: input.request.url,
      headers: input.request.headers,
      isClosed: () => input.request.aborted || input.request.socket?.destroyed });
    let lease;
    let retainedPayload;
    let forwardedResponseId;
    let ownedDocument;
    let handedOff = false;
    try {
      if (input.payload?.generate !== false) await reconcileNativeStart(metadata,
        () => input.request.aborted || input.request.socket?.destroyed);
      if (!rootSourcePayload(input.payload) && rootAdmissions.requiresSourcePayload?.(input.payload)) {
        const bodySource = await collectBodySource(Readable.from(jsonRequestChunks(input.payload)));
        try {
          const { inspectJsonBodySource } = await import("./source-json-inspection.mjs");
          ownedDocument = (await inspectJsonBodySource(bodySource)).document;
          await registerRootSourcePayload(input.payload, ownedDocument);
        } finally { await bodySource.release(); }
      }
      const payload = await rootAdmissions.preparePayload(attempt, input.payload);
      retainedPayload = payload;
      lease = await acquireNativeResponseLease({ ...input, payload, rootAttempt: attempt });
      await rootAdmissions.ready(attempt);
      const wrapped = Object.create(lease);
      Object.defineProperties(wrapped, { payload: { get: () => retainedPayload },
        tracksClientDelivery: { value: isOrdinaryClientTurn(metadata, retainedPayload) },
        beforeWorkerWrite: { value: () => rootAdmissions.beforeWorkerWrite(attempt ?? metadata) },
        markDelivered: { value: event => {
          if (event.type === "response.created") forwardedResponseId = event.response?.id;
          rootAdmissions.markDelivered(attempt, event);
        } },
        finishOrdinaryFailure: { value: (recovery, terminalEvent) => {
          if (isInterruptedResponse(terminalEvent, forwardedResponseId)
            || isKnownIncompleteResponse(terminalEvent, forwardedResponseId)) return null;
          const delivery = recovery.clientDelivery?.();
          const terminalPolicy = nativeTerminalPolicy(terminalEvent, delivery);
          const confirmedDelivery = !terminalEvent || terminalPolicy ? delivery : null;
          const action = clientRecoveryAction(terminalEvent, metadata, retainedPayload, Boolean(forwardedResponseId),
            confirmedDelivery, terminalPolicy);
          const reasonCode = String(terminalPolicy?.reasonCode ?? "").toLowerCase();
          const outputDelivered = Boolean(confirmedDelivery
            ? confirmedDelivery.progressObserved || confirmedDelivery.toolDelivered : forwardedResponseId);
          const canRetryUnknown = !forwardedResponseId && !uncertainTransmission(terminalEvent)
            && terminalPolicy?.acceptance !== "not_sent" && isNoOutputRejection(terminalPolicy);
          const effectiveAction = action === "retry_request" && !canRetryUnknown ? "finish" : action;
          if (effectiveAction === "retry_request" || effectiveAction === "continue_in_client"
            && isConfirmedTemporaryFailure(terminalEvent, forwardedResponseId, terminalPolicy)) {
            const frames = recovery.fail("server_error", "The model worker connection was interrupted. Continue from completed output items.",
              { completeDeliveredText: effectiveAction === "continue_in_client" });
            const events = frames.split(/\r?\n\r?\n/u).map(frame => parseSseFrame(frame).event).filter(Boolean);
            return { events, anchored: false, closeModelConnection: true };
          }
          const passthroughTerminal = effectiveAction === "finish" && (terminalPolicy?.category === "safety"
            || !uncertainTransmission(terminalEvent)
              && (!forwardedResponseId && !confirmedDelivery?.clientCanContinue && !outputDelivered && knownLocalRefusal(terminalEvent)
                || !outputDelivered && (terminalPolicy?.acceptance === "rejected"
                  || terminalRejectionCategories.has(terminalPolicy?.category)
                  || ["unknown_failure", "stream_error", "upstream_error"].includes(reasonCode))));
          return passthroughTerminal ? null
            : rootAdmissions.finishForwarded(attempt, recovery, retainedPayload, terminalEvent);
        } },
        release: { value: async evidence => {
          try { lease.release(evidence); } finally {
            rootAdmissions.end(attempt);
            if (attempt) attempt.payload = null;
            retainedPayload = null;
            await ownedDocument?.release();
          }
        } } });
      handedOff = true;
      return wrapped;
    } catch (error) {
      lease?.release();
      if (attempt?.protectedOperation) {
        let completion;
        try {
          await rootAdmissions.ready(attempt);
          completion = rootAdmissions.finishProtected(attempt, input.payload, attempt.protectedOperation, input.rootAdmissionProtocol);
        } catch (failure) { rootAdmissions.end(attempt); throw failure; }
        if (completion) return completion;
      }
      const completion = await rootAdmissions.localCompletion(attempt, input.payload, input.rootAdmissionProtocol);
      if (completion) return completion;
      rootAdmissions.end(attempt);
      throw error;
    } finally {
      if (!handedOff) await ownedDocument?.release();
    }
  }

  async function acquireNativeResponseLease({ payload, request, connectionId, rootAttempt }) {
    trackNativeRootPeer(shared, request, connectionId);
    const closed = () => request.aborted || request.socket?.destroyed;
    const requireOpen = () => {
      if (shutdownRequested()) fail("COORDINATOR_CLOSING");
      if (closed()) fail("COORDINATOR_NATIVE_WS_CLOSED");
      if (!shared.nativeHealthy) fail("COORDINATOR_TURN_UNAVAILABLE");
    };
    requireOpen();
    const requestPath = String(request.url ?? "").split("?")[0];
    if (!["/v1/responses", "/backend-api/codex/responses"].includes(requestPath)
      || !validIdentity(connectionId) || payload?.type !== "response.create" || !rootHasInputArray(payload)) {
      fail("COORDINATOR_INVALID_REQUEST_TARGET");
    }
    const rawMetadata = payload.client_metadata?.["x-codex-turn-metadata"];
    if (typeof rawMetadata !== "string" || rawMetadata.length > 8192) fail("COORDINATOR_TURN_IDENTITY_REQUIRED");
    let metadata;
    try { metadata = JSON.parse(rawMetadata); } catch { fail("COORDINATOR_TURN_IDENTITY_REQUIRED"); }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail("COORDINATOR_TURN_IDENTITY_REQUIRED");
    const prewarm = payload.generate === false && (rootSourcePayload(payload)?.input?.parts.reduce((count, part) => count + part.count, 0) ?? payload.input.length) === 0
      && (metadata.turn_id === undefined || metadata.turn_id === null || metadata.turn_id === "");
    const knownThread = typeof metadata.thread_id === "string" && metadata.thread_id.length > 0 && metadata.thread_id.length <= 512;
    {
      const headers = { ...request.headers };
      for (const key of Object.keys(headers)) if (key.toLowerCase() === "x-codex-turn-metadata") delete headers[key];
      headers["x-codex-turn-metadata"] = rawMetadata;
      const internalRequest = Object.assign(Object.create(request), { headers });
      const internal = await acquireInternalMemoryResponse({ payload, request: internalRequest }, prewarm ? "prepareConnection" : "acquire");
      if (internal) {
        requireOpen();
        internal.validate();
        const state = internal.state;
        const worker = state.worker;
        if (!alive(worker)) fail("COORDINATOR_WORKER_UNAVAILABLE");
        state.activeHttp += 1;
        worker.activeHttp += 1;
        const routed = { id: `native-memory-${++shared.httpSequence}`, thread: state, worker, request,
          response: { get destroyed() { return closed(); } }, onward: null, accounted: false,
          implementationGeneration: shared.implementationGeneration };
        shared.requests.set(routed.id, routed);
        return nativeResponseLease(routed, connectionId, {
          url: `ws://127.0.0.1:${worker.ready.status.port}${request.url}`, headers: internal.headers, validate: internal.validate });
      }
    }
    if (prewarm) {
      if (!knownThread && metadata.thread_id !== undefined && metadata.thread_id !== null && metadata.thread_id !== "") {
        fail("COORDINATOR_TURN_IDENTITY_REQUIRED");
      }
    } else if (!knownThread || typeof metadata.turn_id !== "string" || !metadata.turn_id || metadata.turn_id.length > 512
      || metadata.request_kind !== undefined && !["turn", "compaction"].includes(metadata.request_kind)) fail("COORDINATOR_TURN_IDENTITY_REQUIRED");
    const response = { get destroyed() { return closed(); } };
    const publicationDeadline = Date.now() + nativeTurnPublicationWaitMs;
    let state;
    let attemptStartedAt = performance.now();
    let retry;
    const abort = new AbortController();
    let trackedState = !prewarm && threads.get(metadata.thread_id)?.turnId === metadata.turn_id ? threads.get(metadata.thread_id) : null;
    const cancelled = () => Object.assign(new Error("Native WebSocket request wait cancelled"), { code: "NATIVE_WS_RETRY_CANCELLED" });
    const verify = () => {
      if (closed() || shutdownRequested() || trackedState && (threads.get(metadata.thread_id) !== trackedState
        || trackedState.phase !== "active" || trackedState.turnId !== metadata.turn_id)) abort.abort();
    };
    const onSocketClosed = () => abort.abort();
    const cancellable = promise => {
      const observed = Promise.resolve(promise);
      if (abort.signal.aborted) { observed.catch(() => {}); return Promise.reject(cancelled()); }
      return new Promise((resolve, reject) => {
        const onAbort = () => { abort.signal.removeEventListener("abort", onAbort); reject(cancelled()); };
        abort.signal.addEventListener("abort", onAbort, { once: true });
        observed.then(value => {
          abort.signal.removeEventListener("abort", onAbort); resolve(value);
        }, error => { abort.signal.removeEventListener("abort", onAbort); reject(error); });
        if (abort.signal.aborted) onAbort();
      });
    };
    request.socket?.once?.("close", onSocketClosed);
    request.socket?.once?.("error", onSocketClosed);
    const cancellationTimer = setInterval(verify, 20);
    cancellationTimer.unref?.();
    const waitForRetry = async current => {
      retry = nativeRetryState(shared);
      trackedState = current;
      const waitingAt = performance.now();
      verify();
      await retry.gate.wait({ metadata, signal: abort.signal });
      const waitedMs = performance.now() - waitingAt;
      if (waitedMs > 5) emit("native_ws_retry_wait_finished", { threadHash: digest(metadata.thread_id).slice(0, 16),
        turnHash: digest(metadata.turn_id).slice(0, 16), requestKind: metadata.request_kind ?? "turn", waitedMs: Math.round(waitedMs) });
      requireOpen();
      attemptStartedAt = performance.now();
    };
    try {
    if (!prewarm) await cancellable(reconcileNativeStart(metadata, closed));
    for (;;) {
      requireOpen();
      verify();
      await cancellable(migrations.get(metadata.thread_id)?.done);
      const observedRelay = shared.relay;
      await cancellable(observedRelay);
      requireOpen();
      if (migrations.has(metadata.thread_id) || observedRelay !== shared.relay) continue;
      state = knownThread ? (prewarm ? findThread(metadata.thread_id) : threads.get(metadata.thread_id))
        : undefined;
      if (prewarm && !state) state = { threadId: null, turnId: null, worker: shared.defaultWorker, activeHttp: 0 };
      if (!prewarm && nativeTurnPublicationPending(metadata, state, publicationDeadline)) {
        await cancellable(new Promise(resolve => setTimeout(resolve, 10)));
        continue;
      }
      if (!state) fail("COORDINATOR_TURN_UNAVAILABLE");
      if (!prewarm) {
        if (threads.get(metadata.thread_id) !== state || state.phase !== "active" || state.turnId !== metadata.turn_id) {
          rejectRequest("COORDINATOR_TURN_UNAVAILABLE", metadata, state, "before_adopt", unavailableReason(metadata, state));
        }
        await waitForRetry(state);
      }
      if (state.worker?.recoveryTask) await cancellable(rootAdmissions.recovery(state.worker.recoveryTask, rootAttempt, state.worker));
      requireOpen();
      if (!alive(state.worker) || state.worker.recoveryError || state.migrationCleanupError) {
        if (!prewarm && threads.get(metadata.thread_id) === state && state.phase === "active" && state.turnId === metadata.turn_id
          && !state.worker?.recoveryError && !state.migrationCleanupError) retry.gate.record({ metadata,
          error: { code: "COORDINATOR_WORKER_UNAVAILABLE" }, elapsedMs: performance.now() - attemptStartedAt });
        fail("COORDINATOR_WORKER_UNAVAILABLE");
      }
      if (!prewarm) {
        if (threads.get(metadata.thread_id) !== state || state.phase !== "active" || state.turnId !== metadata.turn_id) {
          rejectRequest("COORDINATOR_TURN_UNAVAILABLE", metadata, state, "before_adopt", unavailableReason(metadata, state));
        }
        const protectedBeforeAdopt = readRecoveredWorkerOperation(state.worker, metadata, { method: "POST", url: request.url }, payload);
        if (protectedBeforeAdopt) {
          if (rootAttempt) rootAttempt.protectedOperation = { ...protectedBeforeAdopt, worker: state.worker };
          fail("MODEL_OPERATION_REPLAY_BLOCKED");
        }
        await cancellable(shared.dispatch("adoptForRequest", state, metadata, request, response));
        requireOpen();
        if (threads.get(metadata.thread_id) !== state || state.phase !== "active" || state.turnId !== metadata.turn_id
          || !alive(state.worker) || state.worker.recoveryError || state.migrationCleanupError) {
          rejectRequest("COORDINATOR_TURN_UNAVAILABLE", metadata, state, "after_adopt", unavailableReason(metadata, state));
        }
      }
      if (migrations.has(metadata.thread_id) || observedRelay !== shared.relay) continue;
      if (state.activeHttp === 0) break;
      await cancellable(new Promise(resolve => setTimeout(resolve, 20)));
    }
    requireOpen();
    const worker = state.worker;
    const routedRequest = { method: "POST", url: request.url };
    const protectedOperation = !prewarm && readRecoveredWorkerOperation(worker, metadata, routedRequest, payload);
    if (protectedOperation) {
      if (rootAttempt) rootAttempt.protectedOperation = { ...protectedOperation, worker };
      fail("MODEL_OPERATION_REPLAY_BLOCKED");
    }
    const port = worker.ready.status.port;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail("COORDINATOR_WORKER_UNAVAILABLE");
    if (!rootAttempt && !prewarm) rootAdmissions.beforeWorkerWrite(metadata);
    state.activeHttp += 1;
    worker.activeHttp += 1;
    const routed = { id: `native-ws-${++shared.httpSequence}`, thread: state, worker, request, response, onward: null,
      accounted: false, implementationGeneration: shared.implementationGeneration };
    shared.requests.set(routed.id, routed);
    try {
    if (!prewarm) {
      retry.gate.clear(metadata);
      routed.nativeConnectionId = connectionId;
      retry.connections.set(connectionId, { metadata, routed, startedAt: attemptStartedAt });
    }
      emit("request_routed", { threadId: state.threadId, turnId: prewarm ? null : state.turnId, workerId: worker.workerId,
        pid: worker.child.pid, requestClass: prewarm ? "native_ws_prewarm" : metadata.request_kind === "compaction" ? "native_ws_compaction" : "native_ws_turn" });
      return nativeResponseLease(routed, connectionId, { url: `ws://127.0.0.1:${port}${request.url}`,
        headers: { ...request.headers, "x-codex-turn-metadata": nativeResponseMetadataHeader(metadata) } });
    } catch (error) { shared.dispatch("releaseHttpRequest", routed); throw error; }
    } finally {
      clearInterval(cancellationTimer);
      request.socket?.off?.("close", onSocketClosed);
      request.socket?.off?.("error", onSocketClosed);
    }
  }

  async function handleHttpRequest(request, response) {
    let state;
    let worker;
    let routed;
    let metadata;
    let internal;
    let rootAttempt;
    let rootBody;
    let ownershipClosed;
    let protectedOperation;
    let decisionPoint = "request_validation";
    const requestPath = String(request.url ?? "").split("?")[0];
    const catalog = request.method === "GET" && requestPath === "/backend-api/codex/models";
    const image = request.method === "POST" && ["/backend-api/codex/images/generations", "/backend-api/codex/images/edits"].includes(requestPath);
    const memory = request.method === "POST" && requestPath === "/backend-api/codex/memories/trace_summarize";
    try {
      if (shared.closing) fail("COORDINATOR_CLOSING");
      if (!request.url?.startsWith("/") || request.url.startsWith("//")) fail("COORDINATOR_INVALID_REQUEST_TARGET");
      const rawMetadata = request.headers["x-codex-turn-metadata"];
      if ((catalog || image || memory) && rawMetadata === undefined) {
        if (!alive(shared.defaultWorker)) {
          rejectRequest("COORDINATOR_WORKER_UNAVAILABLE", metadata, { worker: shared.defaultWorker }, "request_validation", "worker_dead");
        }
        state = { threadId: null, turnId: null, worker: shared.defaultWorker, activeHttp: 0 };
      } else {
        if (typeof rawMetadata !== "string" || rawMetadata.length > 8192) fail("COORDINATOR_TURN_IDENTITY_REQUIRED");
        try { metadata = JSON.parse(rawMetadata); } catch { fail("COORDINATOR_TURN_IDENTITY_REQUIRED"); }
        internal = await acquireInternalMemoryResponse({ request });
        if (internal) state = internal.state;
        else {
        const socketClosed = () => request.aborted || response.destroyed || request.socket?.destroyed;
        if (!catalog && !image && !memory && typeof metadata?.thread_id === "string" && typeof metadata.turn_id === "string") {
          ownershipClosed = () => {
            if (socketClosed()) return true;
            const current = findThread(metadata.thread_id);
            if (current?.turnId !== metadata.turn_id || current?.phase !== "terminal"
              || current.completion?.status !== "interrupted") return false;
            response.destroy();
            return true;
          };
        }
        const publicationClosed = ownershipClosed ?? socketClosed;
        rootAttempt = rootAdmissions.begin(metadata, { transport: "http", requestPath: request.url,
          headers: request.headers, isClosed: publicationClosed });
        let publicationDeadline = Date.now() + nativeTurnPublicationWaitMs;
        let ownershipReselected = false;
        const reselectOwnership = async () => {
          if (!ownershipReselected) {
            ownershipReselected = true;
            publicationDeadline = Math.max(publicationDeadline, Date.now() + nativeTurnPublicationWaitMs);
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        };
        decisionPoint = "native_publication";
        {
          rootBody = await captureRootBody(request);
          await reconcileNativeStart(metadata, publicationClosed);
          if (!rootSourcePayload(rootBody.payload) && rootAdmissions.requiresSourcePayload?.(rootBody.payload)) {
            const source = await collectBodySource(Readable.from([rootBody.owner.body]));
            let document;
            try {
              const { inspectJsonBodySource } = await import("./source-json-inspection.mjs");
              document = (await inspectJsonBodySource(source, request.headers["content-encoding"])).document;
              await registerRootSourcePayload(rootBody.payload, document);
            } catch (error) { await document?.release(); throw error; }
            finally { await source.release(); }
            const release = rootBody.owner.releaseUnused.bind(rootBody.owner);
            rootBody.owner.releaseUnused = () => { release(); return document.release(); };
          }
          const expanded = await rootAdmissions.preparePayload(rootAttempt, rootBody.payload);
          if (expanded !== rootBody.payload) {
            if (rootSourcePayload(expanded)) {
              const source = await composeRootSourceBody(expanded);
              const previous = rootBody;
              try {
                await previous.owner.releaseUnused();
                rootBody = await captureRootBody(request, source, { forceSourceInspection: true });
              } finally { await source.release(); }
            } else {
            const body = Buffer.from(JSON.stringify(expanded));
            rootBody.owner.releaseUnused();
            const lease = rootBodyBudget.lease();
            if (!lease.reserve(body.length)) fail("ROOT_ADMISSION_BUFFER_BUSY");
            const owner = createRequestBodyOwner(lease, { retainUntilReleased: true });
            owner.assign(body);
            rootBody = { payload: expanded, owner, lease, reencoded: true };
            }
          }
          if (rootAttempt) rootAttempt.payload = rootBody.payload;
        }
        for (;;) {
          if (publicationClosed()) return;
          if (shutdownRequested()) fail("COORDINATOR_CLOSING");
          if (ownershipReselected && Date.now() >= publicationDeadline && !rootAdmissions.trustedPending(rootAttempt)) {
            fail("COORDINATOR_NATIVE_PUBLICATION_TIMEOUT");
          }
          if (!await waitForNativeTurnPublication(migrations.get(metadata.thread_id)?.done, publicationDeadline, publicationClosed, rootAttempt)) return;
          const observedRelay = shared.relay;
          if (!await waitForNativeTurnPublication(observedRelay, publicationDeadline, publicationClosed, rootAttempt)) return;
          if (publicationClosed()) return;
          if (shutdownRequested()) fail("COORDINATOR_CLOSING");
          if (migrations.has(metadata.thread_id) || observedRelay !== shared.relay) {
            if (ownershipClosed) await reselectOwnership();
            continue;
          }
          state = threads.get(metadata.thread_id);
          if (shared.nativeHealthy && nativeTurnPublicationPending(metadata, state, publicationDeadline)) {
            await new Promise(resolve => setTimeout(resolve, 10));
            continue;
          }
          if (state?.worker.recoveryTask) await rootAdmissions.recovery(state.worker.recoveryTask, rootAttempt, state.worker);
          if (!shared.nativeHealthy || !state || state.phase !== "active" || state.turnId !== metadata.turn_id || !alive(state.worker)) {
            rejectRequest("COORDINATOR_TURN_UNAVAILABLE", metadata, state, "before_adopt", unavailableReason(metadata, state));
          }
          if (state.migrationCleanupError) fail("COORDINATOR_THREAD_CLEANUP_PENDING");
          decisionPoint = "during_adopt";
          await shared.dispatch("adoptForRequest", state, metadata, request, response);
          while (state.activeHttp > 0 && alive(state.worker) && state.phase === "active" && state.turnId === metadata.turn_id) {
            if (ownershipClosed ? publicationClosed() : request.aborted || response.destroyed || shared.closing) return;
            if (ownershipClosed && shutdownRequested()) fail("COORDINATOR_CLOSING");
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          if (state.worker.recoveryTask) await rootAdmissions.recovery(state.worker.recoveryTask, rootAttempt, state.worker);
          if (!shared.nativeHealthy || state.phase !== "active" || state.turnId !== metadata.turn_id || !alive(state.worker)) {
            rejectRequest("COORDINATOR_TURN_UNAVAILABLE", metadata, state, "after_adopt", unavailableReason(metadata, state));
          }
          if (state.migrationCleanupError) fail("COORDINATOR_THREAD_CLEANUP_PENDING");
          if (!ownershipClosed) break;
          const selectedWorker = state.worker;
          const ownershipCurrent = () => {
            if (shutdownRequested()) fail("COORDINATOR_CLOSING");
            if (!shared.nativeHealthy || threads.get(metadata.thread_id) !== state
              || state.phase !== "active" || state.turnId !== metadata.turn_id) {
              rejectRequest("COORDINATOR_TURN_UNAVAILABLE", metadata, state, "before_worker_write", unavailableReason(metadata, state));
            }
            if (state.migrationCleanupError) fail("COORDINATOR_THREAD_CLEANUP_PENDING");
            if (migrations.has(metadata.thread_id) || observedRelay !== shared.relay || state.pendingActivation
              || state.worker !== selectedWorker || selectedWorker.recoveryTask || state.activeHttp > 0) return false;
            if (!alive(selectedWorker) || selectedWorker.recoveryError) {
              rejectRequest("COORDINATOR_WORKER_UNAVAILABLE", metadata, state, "before_worker_write", "worker_unavailable");
            }
            return true;
          };
          if (publicationClosed()) return;
          if (!ownershipCurrent()) { await reselectOwnership(); continue; }
          let recovered;
          try {
            recovered = await readRecoveredWorkerOperationSource(selectedWorker, metadata, request, rootBody?.payload);
          } catch (error) {
            if (publicationClosed()) return;
            if (ownershipCurrent()) throw error;
            await reselectOwnership();
            continue;
          }
          if (publicationClosed()) return;
          if (!ownershipCurrent()) { await reselectOwnership(); continue; }
          if (recovered?.requestKind !== "compaction") {
            await rootAdmissions.ready(rootAttempt);
            if (publicationClosed()) return;
            if (!ownershipCurrent()) { await reselectOwnership(); continue; }
          }
          worker = selectedWorker;
          protectedOperation = recovered;
          break;
        }
        }
      }
      decisionPoint = "forwarding";
      if (request.aborted || response.destroyed) return;
      if (shared.closing) fail("COORDINATOR_CLOSING");
      worker ??= state.worker;
      internal?.validate();
      if (!ownershipClosed) {
        protectedOperation = internal ? null : await readRecoveredWorkerOperationSource(worker, metadata, request, rootBody?.payload);
      }
      if (protectedOperation) {
        const code = "proxy_recovery_failed";
        const message = "此前代理退出时，上游操作尚未核实，已保留状态并停止自动重发。可以发送新消息继续。";
        request.resume();
        if (protectedOperation.requestKind === "compaction") {
          response.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          response.end(JSON.stringify({ error: { code, message } }));
        } else {
          if (!ownershipClosed) await rootAdmissions.ready(rootAttempt);
          const completion = rootAdmissions.finishProtected(rootAttempt, rootBody?.payload, { ...protectedOperation, worker });
          if (!completion) fail("MODEL_OPERATION_REPLAY_BLOCKED");
          completion.validate();
          response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
          response.end(completion.frames);
        }
        if (!ownershipClosed) rootBody?.owner.releaseUnused();
        emit("recovered_operation_failed", { threadId: state.threadId, turnId: state.turnId,
          workerId: worker.workerId, acceptance: protectedOperation.entry.acceptance });
        return;
      }
      if (!internal && metadata) {
        if (!ownershipClosed) await rootAdmissions.ready(rootAttempt);
        rootAdmissions.beforeWorkerWrite(rootAttempt ?? metadata);
      }
      state.activeHttp += 1;
      worker.activeHttp += 1;
      routed = { id: `http-${++shared.httpSequence}`, thread: state, worker, request, response, onward: null,
        accounted: false, implementationGeneration: shared.implementationGeneration, rootAttempt,
        rootRecovery: rootAttempt ? createStreamRecovery(`root_${rootAttempt.id}`) : null };
      if (routed.rootRecovery && isOrdinaryRootHttp(request, rootAttempt.metadata, rootAttempt.payload)) {
        routed.rootRecovery.enableClientDelivery();
      }
      shared.requests.set(routed.id, routed);
      const releaseRootResources = () => {
        clearTimeout(routed.localAdmissionTimer);
        routed.rootParser?.dispose();
        rootAdmissions.end(rootAttempt);
        if (rootAttempt) rootAttempt.payload = null;
        rootBody?.owner.releaseUnused();
      };
      request.once("aborted", releaseRootResources);
      response.once("close", releaseRootResources);
      response.once("finish", releaseRootResources);
      const port = worker.ready.status.port;
      emit("request_routed", { threadId: state.threadId, turnId: state.turnId, workerId: worker.workerId, pid: worker.child.pid,
        requestClass: internal ? "internal_memory" : state.threadId === null ? (catalog ? "model_catalog" : memory ? "memory_background" : "image_background") : "turn" });
      const headers = { ...(internal?.headers ?? request.headers), host: `127.0.0.1:${port}` };
      if (rootBody) {
        delete headers["transfer-encoding"];
        if (rootBody.reencoded) delete headers["content-encoding"];
        if (rootBody.contentEncoding) headers["content-encoding"] = rootBody.contentEncoding;
        headers["content-length"] = rootBody.owner.bytes;
      }
      delete headers["x-codex-local-admission-nonce"];
      if (worker.ready?.status?.localAdmissionProofVersion === 1 && rootBody && rootAttempt && request.method === "POST"
        && ["/v1/responses", "/backend-api/codex/responses"].includes(requestPath)
        && [undefined, "turn"].includes(metadata?.request_kind) && rootHasInputArray(rootAttempt.payload)
        && rootAttempt.payload?.generate !== false && !Object.hasOwn(rootAttempt.payload ?? {}, "compaction_trigger")
        && !rootHasCompactionTrigger(rootAttempt.payload)) {
        routed.localAdmissionNonce = crypto.randomBytes(32).toString("hex");
        headers["x-codex-local-admission-nonce"] = routed.localAdmissionNonce;
        routed.localAdmissionOwner = rootBody.owner;
        routed.localAdmissionHeaders = headers;
        routed.localAdmissionWorker = worker.child;
        routed.localAdmissionInstance = worker.ready.instanceToken;
        routed.localAdmissionPort = port;
        routed.localAdmissionBinding = rootAdmissions.binding(rootAttempt);
      }
      request.once("aborted", shared.bindDispatch("handleHttpAborted", routed));
      response.once("close", shared.bindDispatch("handleHttpClose", routed));
      response.once("finish", shared.bindDispatch("releaseHttpRequest", routed));
      const onward = createRootHttpAttempt(routed, headers, port);
      if (rootBody) { rootBody.owner.submit(onward); rootBody.payload = null; } else request.pipe(onward);
    } catch (error) {
      if (routed) shared.dispatch("releaseHttpRequest", routed);
      if (!routed && ownershipClosed?.()) return;
      if (!routed && rootAttempt && !response.headersSent && !response.destroyed && !shutdownRequested()
        && await rootAdmissions.canComplete(rootAttempt)) {
        try {
          rootBody ??= await captureRootBody(request);
          const completion = await rootAdmissions.localCompletion(rootAttempt, rootBody.payload);
          if (completion) {
            completion.validate();
            response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
            response.end(completion.frames);
            completion.release();
            if (!ownershipClosed) rootBody.owner.releaseUnused();
            return;
          }
        } catch {}
      }
      rootAdmissions.end(rootAttempt);
      if (routed || !ownershipClosed) rootBody?.owner.releaseUnused();
      if (!response.headersSent) response.writeHead(503);
      response.end("COORDINATOR_REQUEST_NOT_ACCEPTED");
      const diagnostics = rejectionErrors.get(error) ?? rejectionDetails(metadata, state, decisionPoint, "request_failed");
      const recent = { at: new Date().toISOString(), ...diagnostics, pathSha256: digest(requestPath) };
      const code = error.code ?? "COORDINATOR_REQUEST_NOT_ACCEPTED";
      if (validIdentity(code)) recent.code = code;
      if (typeof request.method === "string" && /^[A-Z]{1,16}$/u.test(request.method)) recent.method = request.method;
      shared.recentRejections.push(recent);
      if (shared.recentRejections.length > 32) shared.recentRejections.splice(0, shared.recentRejections.length - 32);
      emit("request_rejected", { code: error.code ?? "COORDINATOR_REQUEST_NOT_ACCEPTED", method: request.method,
        path: catalog || image || memory ? requestPath : null, pathSha256: digest(requestPath), ...diagnostics });
    } finally {
      if (rootAttempt && !routed) rootAdmissions.end(rootAttempt);
      if (!routed && ownershipClosed) await rootBody?.owner.releaseUnused();
      else if (request.aborted || response.destroyed || shutdownRequested()) rootBody?.owner.releaseUnused();
    }
  }

  function createRootHttpAttempt(routed, headers, port = routed.worker.ready.status.port) {
    const onward = http.request({ hostname: "127.0.0.1", port, path: routed.request.url, method: routed.request.method,
      headers }, shared.bindDispatch("handleHttpResponse", routed));
    routed.onward = onward;
    onward.once("error", error => {
      if (routed.onward === onward && !routed.localAdmissionWaiting) shared.dispatch("handleHttpError", routed, error);
    });
    return onward;
  }

  function localAdmissionCurrent(routed) {
    const binding = routed.localAdmissionBinding;
    const state = routed.thread;
    return !routed.accounted && shared.requests.get(routed.id) === routed && !shutdownRequested()
      && !routed.request.aborted && !routed.response.destroyed && !routed.response.writableEnded
      && shared.nativeHealthy && !shared.transactionActive && !shared.workerMaintenance
      && shared.implementationGeneration === routed.implementationGeneration
      && threads.get(state.threadId) === state && state.phase === "active"
      && state.turnId === routed.rootAttempt?.metadata.turn_id && state.worker === routed.worker
      && alive(routed.worker) && routed.worker.child === routed.localAdmissionWorker
      && routed.worker.ready.instanceToken === routed.localAdmissionInstance
      && routed.worker.ready.status.port === routed.localAdmissionPort
      && !routed.worker.recoveryTask && !routed.worker.recoveryError && !state.migrationCleanupError
      && binding?.connectionGeneration === rootAdmissions.binding(routed.rootAttempt)?.connectionGeneration
      && binding?.nativeIdentity && options.getExpectedNativeIdentity?.isCurrent?.(binding.nativeIdentity) === true;
  }

  function publishLocalAdmission(routed, phase, delayMs = 0) {
    const attempt = routed.rootAttempt;
    attempt.sequence += 1;
    publishRootRecovery(attempt, { phase, sequence: attempt.sequence, reason: "LOCAL_REQUEST_ADMISSION_BUSY",
      category: "capacity", waitContext: "local_admission", transport: "http", retryAction: "retry",
      acceptance: "not_sent", willRetry: phase !== "resumed", canContinueHttp: false,
      retryNumber: routed.localAdmissionRetries, admissionRetryNumber: routed.localAdmissionRetries,
      retryAfterMs: delayMs, attemptStarted: phase === "retrying", httpStatusCode: 503 });
  }

  function waitLocalAdmission(routed, received) {
    if (received.statusCode !== 503 || !routed.localAdmissionOwner || routed.rootResponseId
      || typeof routed.localAdmissionNonce !== "string"
      || received.headers["x-codex-local-admission-proof"] !== routed.localAdmissionNonce
      || !localAdmissionCurrent(routed)) return false;
    routed.localAdmissionRetries = (routed.localAdmissionRetries ?? 0) + 1;
    routed.localAdmissionWaiting = true;
    const baseMs = options.mode === "isolated" ? Math.max(10, options.localAdmissionRetryBaseMs ?? 1000) : 1000;
    const delayMs = Math.min(30000, baseMs * 2 ** Math.min(5, routed.localAdmissionRetries - 1));
    publishLocalAdmission(routed, "waiting", delayMs);
    emit("root_local_admission_wait", { threadId: routed.thread.threadId, turnId: routed.thread.turnId,
      workerId: routed.worker.workerId, retryNumber: routed.localAdmissionRetries, retryAfterMs: delayMs,
      acceptance: "not_sent", retainedBytes: routed.localAdmissionOwner.bytes });
    if (!routed.response.headersSent) routed.response.writeHead(200,
      { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    routed.response.write(": local admission backoff\n\n");
    received.on("error", () => {});
    received.resume();
    routed.localAdmissionTimer = setTimeout(() => {
      routed.localAdmissionTimer = null;
      if (!localAdmissionCurrent(routed)) {
        if (!finishRootHttp(routed)) routed.response.destroy();
        return;
      }
      try {
        publishLocalAdmission(routed, "retrying");
        routed.localAdmissionOwner.approveReplay();
        routed.localAdmissionWaiting = false;
        const onward = createRootHttpAttempt(routed, routed.localAdmissionHeaders);
        routed.localAdmissionOwner.submit(onward);
      } catch { if (!finishRootHttp(routed)) routed.response.destroy(); }
    }, delayMs);
    routed.localAdmissionTimer.unref?.();
    return true;
  }

  function finishCommittedOpaqueResponse(routed, received, errorCode) {
    if (!routed.rootRecovery || !routed.response.headersSent || routed.response.destroyed
      || routed.response.writableEnded || !/^text\/event-stream\b/iu.test(String(routed.response.getHeader("content-type") ?? ""))) return false;
    const statusCode = received.statusCode ?? 502;
    const code = errorCode === "insufficient_quota" || errorCode === "usage_limit_reached" ? errorCode
      : statusCode === 409 ? "proxy_operation_in_progress" : "worker_http_" + statusCode;
    routed.rootSettled = true;
    routed.rootParser?.dispose();
    received.resume();
    routed.response.end(routed.rootRecovery.fail(code, "The worker returned HTTP " + statusCode + " after the event stream started."));
    return true;
  }

  async function respondWithBoundedRateLimit(routed, received, length) {
    const chunks = [];
    let size = 0;
    for await (const chunk of received) {
      size += chunk.length;
      if (size > length) throw new Error("ROOT_HTTP_429_LENGTH_MISMATCH");
      chunks.push(chunk);
    }
    if (size !== length || !received.complete) throw new Error("ROOT_HTTP_429_LENGTH_MISMATCH");
    if (routed.rootSettled || routed.response.destroyed || routed.response.writableEnded) return;
    const bytes = Buffer.concat(chunks, length);
    let message;
    try { message = JSON.parse(bytes.toString("utf8")); } catch {}
    const rawCode = message?.error?.code ?? message?.error?.type;
    const reason = typeof rawCode === "string" ? rawCode.toLowerCase() : undefined;
    if (rootHttpRateLimitCodes.has(reason)
      && recoverRootHttp(routed, { source: "http", statusCode: 429, code: reason, message })) return;
    if (finishCommittedOpaqueResponse(routed, received, reason)) return;
    routed.opaqueResponse = true;
    if (!routed.response.headersSent) routed.response.writeHead(429, received.headers);
    routed.response.end(bytes);
  }

  function handleHttpResponse(routed, received) {
    routed.received = received;
    if (waitLocalAdmission(routed, received)) return;
    if (routed.localAdmissionRetries && received.statusCode >= 200 && received.statusCode < 300
      && /^text\/event-stream\b/iu.test(received.headers["content-type"] ?? "")) publishLocalAdmission(routed, "resumed");
    if (received.statusCode === 429 && routed.rootRecovery && !received.headers["content-encoding"]
      && /^application\/(?:[a-z0-9.+-]+\+)?json\b/iu.test(received.headers["content-type"] ?? "")) {
      const length = Number(received.headers["content-length"]);
      if (Number.isSafeInteger(length) && length > 0 && length <= 16 * 1024) {
        respondWithBoundedRateLimit(routed, received, length).catch(() => {
          if (!finishRootHttp(routed)) routed.response.destroy();
        });
        return;
      }
    }
    if (received.statusCode !== 429 && recoverableRootHttpStatuses.has(received.statusCode) && !received.headers["content-encoding"]
      && recoverRootHttp(routed, { source: "http", statusCode: received.statusCode })) return;
    if (received.statusCode >= 400 && received.statusCode !== 429 && !received.headers["content-encoding"]
      && finishRootHttp(routed, { type: "error", status: received.statusCode, error: { status: received.statusCode } },
        { source: "http", statusCode: received.statusCode })) { received.resume(); return; }
    const stream = routed.rootRecovery && /^text\/event-stream\b/iu.test(received.headers["content-type"] ?? "")
      && !received.headers["content-encoding"];
    if (!stream) {
      if (finishCommittedOpaqueResponse(routed, received)) return;
      routed.opaqueResponse = true;
      if (!routed.response.headersSent) routed.response.writeHead(received.statusCode ?? 502, received.headers);
      received.on("error", shared.bindDispatch("handleHttpStreamError", routed));
      received.pipe(routed.response);
      return;
    }
    const headers = { ...received.headers };
    delete headers["content-length"];
    if (!routed.response.headersSent) routed.response.writeHead(received.statusCode ?? 502, headers);
    routed.rootParser = createSseFrameParser((wire, frame) => {
      if (routed.rootSettled) return;
      const { event, doneMarker } = parseSseFrame(frame);
      if (frameData(frame) && !event && !doneMarker) fail("ROOT_WORKER_INVALID_SSE");
      if (event) {
        const responseId = event.response?.id ?? event.response_id;
        if (responseId && routed.rootResponseId && responseId !== routed.rootResponseId) fail("ROOT_WORKER_RESPONSE_MISMATCH");
        if (responseId) routed.rootResponseId ??= responseId;
        routed.rootRecovery.observe(event);
        if (!isKnownIncompleteResponse(event, routed.rootResponseId) && (["error", "response.failed"].includes(event.type)
          || event.type === "response.incomplete" && !terminalCarriesOutput(event)
            && !isInterruptedResponse(event, routed.rootResponseId))
          && recoverRootHttp(routed, { source: "sse", terminalEvent: event })) return;
        if (["error", "response.failed", "response.incomplete"].includes(event.type)
          && finishRootHttp(routed, event, { source: "sse" })) return;
        if (["response.completed", "response.failed", "response.incomplete", "error"].includes(event.type)) routed.rootTerminal = true;
      }
      if (!routed.response.write(wire)) received.pause();
      if (event) { routed.rootRecovery.markDelivered(event); rootAdmissions.markDelivered(routed.rootAttempt, event); }
    }, { shouldPause: () => routed.response.writableNeedDrain,
      onError: () => shared.dispatch("handleHttpStreamError", routed) });
    routed.rootInputComplete = (recoverable = false) => {
      if (!recoverable) routed.rootInputNonRecoverable = true;
      routed.rootInputCanRecover = !routed.rootInputNonRecoverable && !routed.rootInputProtocolFailed;
      routed.rootInputEnded = true;
      settleRootHttpInput(routed);
    };
    routed.response.on("drain", () => {
      if (routed.rootSettled || routed.response.destroyed) return;
      routed.rootParser.resume();
      if (routed.response.writableNeedDrain) return;
      if (routed.rootInputEnded) settleRootHttpInput(routed);
      else received.resume();
    });
    received.on("data", chunk => routed.rootParser.push(chunk));
    received.once("end", () => routed.rootInputComplete(true));
    received.once("error", error => routed.rootInputComplete(rootHttpTransportErrors.has(error?.code)));
    received.once("aborted", () => routed.rootInputComplete(true));
  }

  function settleRootHttpInput(routed) {
    if (routed.rootSettled || !routed.rootInputEnded || routed.response.destroyed || routed.response.writableNeedDrain) return;
    routed.rootParser.resume();
    if (routed.rootSettled || routed.response.destroyed || routed.response.writableNeedDrain) return;
    routed.rootParser.dispose();
    if (routed.rootTerminal) { routed.rootSettled = true; routed.response.end(); }
    else if (routed.rootInputCanRecover && recoverRootHttp(routed, { source: "transport", code: "STREAM_ENDED_WITHOUT_COMPLETION" })) return;
    else if (!finishRootHttp(routed)) routed.response.destroy();
  }

  function recoverRootHttp(routed, { source, statusCode, terminalEvent, code, message }) {
    const delivery = routed.rootRecovery?.clientDelivery();
    if (!delivery || routed.rootSettled || routed.rootTerminal || routed.accounted || routed.request.aborted || routed.response.destroyed
      || routed.response.writableEnded || routed.opaqueResponse || routed.localAdmissionWaiting || routed.rootInputProtocolFailed
      || routed.rootInputNonRecoverable
      || routed.implementationGeneration !== shared.implementationGeneration) return false;
    const binding = rootAdmissions.binding(routed.rootAttempt);
    if (!binding?.nativeIdentity || options.getExpectedNativeIdentity?.isCurrent?.(binding.nativeIdentity) !== true) return false;
    if (terminalEvent) {
      statusCode = parseTerminalStatusCode(terminalEvent);
      const error = terminalEvent.response?.error ?? terminalEvent.error ?? terminalEvent;
      const incompleteReason = terminalEvent.response?.incomplete_details?.reason;
      const rawCode = error.code ?? incompleteReason ?? error.type;
      code = typeof rawCode === "string" ? rawCode.toLowerCase() : undefined;
      if (rootHttpUnconfirmedErrors.has(code) && !delivery.progressObserved && !delivery.toolDelivered) return false;
      if (statusCode >= 400 && (statusCode === 429
        ? !rootHttpRateLimitCodes.has(code) : !recoverableRootHttpStatuses.has(statusCode))) return false;
    }
    if (terminalCarriesOutput(terminalEvent) || uncertainTransmission(terminalEvent)) return false;
    const policy = classifyModelFailure({ source, statusCode, message: terminalEvent ?? message, code,
      progressObserved: delivery.progressObserved, toolDelivered: delivery.toolDelivered });
    if (source !== "transport" && policy.category !== "temporary") return false;
    const action = modelRecoveryAction(policy, { ordinary: true, clientCanContinue: delivery.clientCanContinue,
      outputDelivered: delivery.progressObserved || delivery.toolDelivered });
    if (action !== "retry_request" && action !== "continue_in_client") return false;
    if (action === "retry_request" && !isNoOutputRejection(policy)
      || action === "continue_in_client" && !isConfirmedTemporaryFailure(terminalEvent, routed.rootResponseId, policy)) return false;
    const frames = routed.rootRecovery.fail("server_error", "The model worker connection was interrupted. Continue from completed output items.",
      { completeDeliveredText: action === "continue_in_client" });
    routed.rootSettled = true;
    routed.rootParser?.dispose();
    if (!routed.response.headersSent) routed.response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    routed.response.end(frames);
    routed.received?.destroy();
    routed.onward?.destroy();
    emit("root_http_client_recovery", { threadId: routed.thread.threadId, turnId: routed.thread.turnId, source, statusCode,
      action, acceptance: policy.acceptance, reason: policy.reasonCode, replayed: false });
    return true;
  }

  function finishRootHttp(routed, terminalEvent, failureOptions = {}) {
    if (routed.rootSettled) return true;
    if (routed.request.aborted || routed.response.destroyed || routed.response.writableEnded || routed.opaqueResponse) return false;
    if (routed.received?.headers?.["content-encoding"]) return false;
    if (routed.rootTerminal) { routed.rootParser?.dispose(); routed.rootSettled = true; routed.response.end(); return true; }
    if (terminalCarriesOutput(terminalEvent) || isInterruptedResponse(terminalEvent, routed.rootResponseId)) return false;
    if (isKnownIncompleteResponse(terminalEvent, routed.rootResponseId)) return false;
    const delivery = routed.rootRecovery?.clientDelivery();
    const hasExplicitFailure = Boolean(terminalEvent || failureOptions.source || failureOptions.statusCode !== undefined || failureOptions.code);
    const source = failureOptions.source ?? (terminalEvent ? "sse" : "transport");
    const statusCode = failureOptions.statusCode ?? parseTerminalStatusCode(terminalEvent);
    const error = terminalEvent?.response?.error ?? terminalEvent?.error ?? terminalEvent;
    const incompleteReason = terminalEvent?.response?.incomplete_details?.reason;
    const rawCode = failureOptions.code ?? error?.code ?? incompleteReason ?? error?.type;
    const code = typeof rawCode === "string" ? rawCode : undefined;
    const signal = extractTransmissionSignal(terminalEvent);
    const terminalPolicy = hasExplicitFailure ? classifyModelFailure({
      source,
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(code !== undefined ? { code } : {}),
      ...(terminalEvent ? { message: terminalEvent } : {}),
      ...(delivery ? { progressObserved: delivery.progressObserved, toolDelivered: delivery.toolDelivered }
        : { responseStarted: Boolean(routed.rootResponseId) }),
      ...(signal?.requestAccepted !== undefined ? { requestAccepted: signal.requestAccepted } : {}),
      ...(typeof signal?.requestTransmissionState === "string"
        ? { requestTransmissionState: signal.requestTransmissionState } : {}),
    }) : null;
    const outputDelivered = Boolean(delivery ? delivery.progressObserved || delivery.toolDelivered : routed.rootResponseId);
    const reasonCode = String(terminalPolicy?.reasonCode ?? "").toLowerCase();
    const action = terminalPolicy ? clientRecoveryAction(terminalEvent, routed.rootAttempt?.metadata,
      routed.rootAttempt?.payload, Boolean(routed.rootResponseId), delivery, terminalPolicy) : "finish";
    const canRetryUnknown = !routed.rootResponseId && !uncertainTransmission(terminalEvent)
      && isNoOutputRejection(terminalPolicy)
      && (source !== "http" || recoverableRootHttpStatuses.has(statusCode)
        && (statusCode !== 429 || rootHttpRateLimitCodes.has(reasonCode)));
    const effectiveAction = action === "retry_request" && !canRetryUnknown ? "finish" : action;
    if (effectiveAction === "continue_in_client" && source === "sse"
      && isConfirmedTemporaryFailure(terminalEvent, routed.rootResponseId, terminalPolicy)
      || effectiveAction === "retry_request") return false;
    if (source === "http" && (terminalPolicy?.acceptance === "rejected" || terminalPolicy?.acceptance === "not_sent"
      || statusCode >= 400 && statusCode < 500 && !recoverableRootHttpStatuses.has(statusCode))) return false;
    if (terminalPolicy?.category === "safety") return false;
    if (source === "sse" && effectiveAction === "finish" && !uncertainTransmission(terminalEvent)
      && (knownLocalRefusal(terminalEvent) && !routed.rootResponseId && !delivery?.clientCanContinue && !outputDelivered
        || !outputDelivered && (terminalPolicy?.acceptance === "rejected"
          || terminalRejectionCategories.has(terminalPolicy?.category)
          || ["unknown_failure", "stream_error", "upstream_error"].includes(reasonCode)))) {
      return false;
    }
    const completion = rootAdmissions.finishForwarded(routed.rootAttempt, routed.rootRecovery, routed.rootAttempt?.payload, terminalEvent);
    if (!completion) return false;
    routed.rootParser?.dispose();
    routed.rootSettled = true;
    if (!routed.response.headersSent) routed.response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    routed.response.end(completion.frames);
    routed.received?.destroy();
    routed.onward?.destroy();
    emit("root_model_response_finished", { threadId: routed.thread.threadId, turnId: routed.thread.turnId,
      acceptance: completion.acceptance, replayed: false, anchored: completion.anchored });
    return true;
  }

  function handleHttpStreamError(routed) {
    if (routed.rootInputComplete) {
      routed.rootInputProtocolFailed = true;
      routed.rootInputComplete();
      return;
    }
    if (finishRootHttp(routed)) return;
    routed.response.destroy();
  }

  function handleHttpError(routed, error) {
    const code = error?.code;
    if (routed.rootInputComplete) { routed.rootInputComplete(rootHttpTransportErrors.has(code)); return; }
    if (rootHttpTransportErrors.has(code) && recoverRootHttp(routed, { source: "transport", code })) return;
    if (finishRootHttp(routed)) return;
    if (routed.response.headersSent) { routed.response.destroy(); return; }
    if (!routed.response.headersSent) routed.response.writeHead(502);
    routed.response.end("COORDINATOR_UPSTREAM_UNAVAILABLE");
  }

  function handleHttpAborted(routed) {
    routed.onward.destroy();
  }

  function handleHttpClose(routed) {
    shared.dispatch("releaseHttpRequest", routed);
    if (!routed.response.writableFinished) routed.onward.destroy();
  }

  function releaseHttpRequest(routed) {
    if (routed.accounted) return;
    routed.accounted = true;
    clearTimeout(routed.localAdmissionTimer);
    routed.localAdmissionOwner?.releaseUnused();
    if (routed.nativeConnectionId) {
      const connections = shared.nativeWsRetryState?.connections;
      if (connections?.get(routed.nativeConnectionId)?.routed === routed) connections.delete(routed.nativeConnectionId);
    }
    routed.thread.activeHttp -= 1;
    routed.worker.activeHttp -= 1;
    shared.requests.delete(routed.id);
    routed.rootParser?.dispose();
    if (routed.rootAttempt) routed.rootAttempt.payload = null;
  }

  async function migrate({ threadId, candidateId, compatibility, live = false, drainTimeoutMs = 1000 },
    { selectDefault = true, reclamation = false, historicalState } = {}) {
    if (typeof live !== "boolean" || !Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 0 || drainTimeoutMs > 5000) fail("COORDINATOR_INVALID_HANDOFF_OPTIONS");
    if (selectDefault && shared.activation?.active) fail("COORDINATOR_ACTIVATION_BUSY");
    if (shared.transactionActive || shared.closing || !shared.nativeHealthy || (shared.workerMaintenance && !reclamation)
      || (runtimeProfile && shared.preparationTask && !reclamation)) fail("COORDINATOR_MIGRATION_BUSY");
    shared.transactionActive = true;
    let finishMigration;
    let source;
    let candidate;
    let prepared;
    let committed = false;
    try {
      await shared.relay;
      const state = findThread(threadId) ?? historicalState;
      candidate = workers.get(candidateId);
      source = state?.worker;
      const phase = live ? "active" : "terminal";
      if (!state || state.phase !== phase || (!live && state.activeHttp !== 0) || !alive(source)
        || !alive(candidate) || candidate === source) fail("COORDINATOR_THREAD_NOT_READY");
      if (runtimeProfile && candidate.threadHistory.has(threadId)) fail("COORDINATOR_FRESH_WORKER_REQUIRED");
      const epoch = state.epoch;
      const done = new Promise(resolve => { finishMigration = resolve; });
      migrations.set(threadId, { done });
      const drainDeadline = Date.now() + drainTimeoutMs;
      if (state.activeHttp > 0) emit("migration_waiting_inflight", { threadId, activeHttp: state.activeHttp });
      while (state.activeHttp > 0) {
        if (state.epoch !== epoch || state.phase !== phase || !alive(source)) fail("COORDINATOR_COMMIT_PRECONDITION_CHANGED");
        if (Date.now() >= drainDeadline) fail("COORDINATOR_INFLIGHT_PENDING");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (state.epoch !== epoch || state.phase !== phase) fail("COORDINATOR_COMMIT_PRECONDITION_CHANGED");
      const approved = fixedHandoffCompatibility(compatibility);
      const plan = { schemaVersion: 1, id: crypto.randomUUID(), generation: ++shared.generation, threadId,
        expiresAt: Date.now() + 120_000, source: identity(source), target: identity(candidate), compatibility: approved };
      await shared.dispatch("control", source, "authorizeMigration", { role: "source", plan });
      await shared.dispatch("control", candidate, "authorizeMigration", { role: "target", plan });
      if (!live) {
        const sourceState = await shared.dispatch("control", source, "check", { threadId });
        if (!sourceState.native) await shared.dispatch("control", source, "restoreTerminal", {
          event: { ...state.completion, sequence: ++source.nativeSequence } });
      }
      (candidate.releasedThreadHistory ??= new Set()).add(threadId);
      await shared.dispatch("relayNative", candidate, state.start);
      if (!live) await shared.dispatch("relayNative", candidate, state.completion);
      const preparation = { threadId, fileName: `inner-runner-${plan.id}.json`, live };
      try { prepared = await shared.dispatch("control", source, "prepare", preparation); }
      catch (error) {
        if (!live || error.code !== "RECOVERY_HANDOFF_THREAD_BUSY") throw error;
        emit("migration_prepare_retry", { threadId, retryAttempt: 1, code: error.code });
        await new Promise(resolve => setTimeout(resolve, 25));
        prepared = await shared.dispatch("control", source, "prepare", preparation);
      }
      const accepted = await shared.dispatch("control", candidate, "accept", { threadId, fileName: prepared.fileName,
        sha256: prepared.sha256, sourceInstanceToken: source.ready.instanceToken, live });
      const health = await shared.dispatch("control", candidate, "check", { threadId });
      const current = findThread(threadId) ?? historicalState;
      if (current.epoch !== epoch || current.phase !== phase || current.activeHttp !== 0 || !alive(candidate) || !shared.nativeHealthy
        || !health.status.running || health.status.draining || health.native?.turnId !== state.turnId
        || health.native?.phase !== phase
        || accepted.threadId !== threadId) fail("COORDINATOR_COMMIT_PRECONDITION_CHANGED");
      current.worker = candidate;
      (source.releasedThreadHistory ??= new Set()).add(threadId);
      candidate.releasedThreadHistory.delete(threadId);
      if (selectDefault) { shared.defaultWorker = candidate; candidate.wasDefault = true; candidate.wasActivated = true; }
      committed = true;
      const receipt = { committed: true, generation: shared.generation, threadId, ...(live ? { live: true, turnId: state.turnId, phase } : {}), source: identity(source), target: identity(candidate),
        checkpointSha256: prepared.sha256, accepted, cleanupPending: false };
      try { await shared.dispatch("control", source, "cancel", { threadId, token: prepared.token }); }
      catch { receipt.cleanupPending = true; }
      source.retired = true;
      source.cleanupPending = source.cleanupPending === true || receipt.cleanupPending;
      if (selectDefault || candidate === shared.defaultWorker) candidate.retired = false;
      emit("migration_committed", { generation: shared.generation, threadId, sourceWorkerId: source.workerId, targetWorkerId: candidate.workerId,
        checkpointSha256: prepared.sha256, cleanupPending: receipt.cleanupPending });
      return receipt;
    } catch (error) {
      let cancelled = !prepared;
      if (prepared && !committed) {
        try { await shared.dispatch("control", source, "cancel", { threadId, token: prepared.token }); cancelled = true; }
        catch (cancelError) {
          const state = findThread(threadId) ?? historicalState;
          if (state?.worker === source) state.migrationCleanupError = cancelError.code ?? cancelError.message;
          source.cleanupPending = true;
        }
      }
      emit("migration_preserved_source", { threadId, code: error.code ?? error.message, cancelled });
      throw error;
    } finally {
      migrations.delete(threadId); finishMigration?.(); shared.transactionActive = false;
    }
  }

  async function adoptForRequest(state, metadata, request, response) {
    while (state.pendingActivation) {
      if (request.aborted || response.destroyed || shared.closing) return;
      const selected = state.pendingActivation;
      if (selected !== shared.activation || !selected.active) { delete state.pendingActivation; return; }
      if (state.activationError) fail(state.activationError);
      if (state.phase !== "active" || state.turnId !== metadata.turn_id) {
        rejectRequest("COORDINATOR_TURN_UNAVAILABLE", metadata, state, "during_adopt",
          state.phase !== "active" ? "phase_not_active" : "turn_mismatch");
      }
      if (!alive(state.worker) || !alive(selected.target)) {
        rejectRequest("COORDINATOR_WORKER_UNAVAILABLE", metadata, state, "during_adopt",
          !alive(state.worker) ? "worker_dead" : "adoption_target_dead");
      }
      if (state.worker === selected.target) { delete state.pendingActivation; return; }
      const existing = adoptions.get(state.threadId);
      if (existing) { await existing; continue; }
      if (state.activeHttp > 0 || shared.transactionActive || shared.workerMaintenance || shared.preparationTask) {
        await new Promise(resolve => setTimeout(resolve, 20));
        continue;
      }
      const adoption = shared.dispatch("migrate", { threadId: state.threadId, candidateId: selected.target.workerId,
        compatibility: selected.compatibility, live: true, drainTimeoutMs: 0 }, { selectDefault: false });
      adoptions.set(state.threadId, adoption);
      try {
        const receipt = await adoption;
        delete state.pendingActivation;
        emit("activation_thread_adopted", { activationId: selected.id, threadId: state.threadId,
          source: receipt.source, target: receipt.target, checkpointSha256: receipt.checkpointSha256 });
      } catch (error) {
        state.activationError = error.code ?? "COORDINATOR_ACTIVATION_THREAD_FAILED";
        throw error;
      } finally { adoptions.delete(state.threadId); }
    }
  }

  async function activate({ candidateId, compatibility }) {
    const pendingBusy = () => shared.activation?.active && threadStates().some(state =>
      state.pendingActivation === shared.activation && !idleTerminal(state, true));
    if (pendingBusy()
      || shared.transactionActive || shared.closing || shared.starting || shared.preparationTask || shared.workerMaintenance
      || !shared.nativeHealthy) fail("COORDINATOR_ACTIVATION_BUSY");
    shared.transactionActive = true;
    try {
      await shared.relay;
      const candidate = workers.get(candidateId);
      if (!alive(shared.defaultWorker) || !alive(candidate) || candidate === shared.defaultWorker) fail("COORDINATOR_THREAD_NOT_READY");
      const approved = fixedHandoffCompatibility(compatibility);
      for (const source of new Set([shared.defaultWorker, ...threadStates().map(state => state.worker),
        ...[...workers.values()].filter(worker => alive(worker)
          && [...worker.threadHistory].some(threadId => !worker.releasedThreadHistory?.has(threadId)))])) {
        const from = identity(source);
        const to = identity(candidate);
        if ((from.core !== to.core || from.helper !== to.helper) && !approved?.manifest.edges.some(edge =>
          edge.source.core === from.core && edge.source.helper === from.helper && edge.target.core === to.core && edge.target.helper === to.helper)) fail("CHECKPOINT_VERSION_EDGE_NOT_ALLOWED");
      }
      if (runtimeProfile && [...candidate.threadHistory].some(threadId => {
        const current = findThread(threadId);
        if (current) return current.worker !== candidate;
        const owners = historyOwners(threadId);
        return owners.length !== 1 || owners[0] !== candidate;
      })) fail("COORDINATOR_FRESH_WORKER_REQUIRED");
      const health = await shared.dispatch("control", candidate, "check");
      if (!alive(candidate) || !health.status.running || health.status.draining || !shared.nativeHealthy || shared.closing) fail("COORDINATOR_COMMIT_PRECONDITION_CHANGED");
      if (pendingBusy()) fail("COORDINATOR_ACTIVATION_BUSY");
      shared.activation = { id: crypto.randomUUID(), active: true, source: shared.defaultWorker, target: candidate, compatibility: approved ?? undefined };
      shared.activation.source.retired = true;
      shared.defaultWorker = candidate;
      candidate.wasDefault = true;
      candidate.wasActivated = true;
      for (const state of threadStates()) if (state.worker !== candidate) {
        if (idleTerminal(state, true)) delete state.pendingActivation;
        else state.pendingActivation = shared.activation;
        delete state.activationError;
      }
      candidate.retired = false;
      const receipt = { activationId: shared.activation.id, selectionCommitted: true, stateTransferComplete: false,
        sourceWorkerId: shared.activation.source.workerId, targetWorkerId: candidate.workerId,
        deferredThreadIds: threadStates().filter(state => state.pendingActivation === shared.activation).map(state => state.threadId) };
      receipt.stateTransferComplete = threadStates().every(state => state.worker === candidate);
      emit("worker_activated", receipt);
      return receipt;
    } finally { shared.transactionActive = false; }
  }

  function rollbackActivation({ activationId }) {
    if (shared.activation?.id === activationId && !shared.activation.active
      && shared.activation.target.recoveryTask) return { activationId,
        selectionRestored: alive(shared.defaultWorker) && shared.defaultWorker !== shared.activation.target,
        defaultWorkerId: shared.defaultWorker?.workerId, retainedThreadIds: threadStates()
          .filter(state => state.worker === shared.activation.target).map(state => state.threadId) };
    if (!shared.activation?.active || shared.activation.id !== activationId) fail("COORDINATOR_ACTIVATION_NOT_CURRENT");
    if (shared.transactionActive || shared.workerMaintenance || shared.preparationTask
      || shared.closing || !alive(shared.activation.source)) fail("COORDINATOR_ACTIVATION_BUSY");
    shared.activation.active = false;
    shared.defaultWorker = shared.activation.source;
    for (const state of threadStates()) if (state.pendingActivation === shared.activation) {
      delete state.pendingActivation;
      delete state.activationError;
    }
    shared.activation.source.retired = false;
    shared.activation.target.retired = true;
    const receipt = { activationId, selectionRestored: true, defaultWorkerId: shared.defaultWorker.workerId,
      retainedThreadIds: threadStates().filter(state => state.worker === shared.activation.target).map(state => state.threadId) };
    emit("activation_rolled_back", receipt);
    return receipt;
  }

  const implementation = {
    async start(initial) {
      if (shared.defaultWorker || shared.starting || shared.closing) fail("COORDINATOR_ALREADY_STARTED");
      shared.starting = true;
      try {
        shared.coldStart ??= acquireInnerColdStart({ stateRoot: runtimeProfile?.stateRoot ?? root,
          ownerId, nativeSourceId, sessionId });
        shared.defaultWorker = await shared.dispatch("launchWorker", initial);
        shared.defaultWorker.wasDefault = true;
        shared.server.listen(options.port ?? 0, "127.0.0.1");
        await once(shared.server, "listening");
        return { host: "127.0.0.1", port: shared.server.address().port, workerId: shared.defaultWorker.workerId };
      } finally { shared.starting = false; }
    },
    async prepareCandidate(specification) {
      if (shared.workerMaintenance || (runtimeProfile && (shared.preparationTask || shared.transactionActive
        || shared.starting || shared.closing))) fail("COORDINATOR_PREPARATION_BUSY");
      const task = shared.dispatch("launchWorker", specification);
      if (runtimeProfile) shared.preparationTask = task;
      try {
        const worker = await task;
        worker.preparedCandidate = true;
        return { workerId: worker.workerId };
      }
      finally { if (shared.preparationTask === task) shared.preparationTask = null; }
    },
    observeNativeMessage,
    migrate,
    activate,
    rollbackActivation,
    discardCandidate,
    control,
    launchWorker,
    relayNative,
    reclaimRetiredWorkers,
    adoptForRequest,
    handleHttpRequest,
    handleWorkerMessage,
    handleWorkerExit,
    handleWorkerError,
    handleWorkerReadyTimeout,
    settleWorkerStartup,
    handleControlTimeout,
    handleControlSendError,
    relayNativeEvent,
    handleNativeRelayFailure,
    handleHttpResponse,
    handleHttpStreamError,
    handleHttpError,
    handleHttpAborted,
    handleHttpClose,
    releaseHttpRequest,
    acquireNativeResponse,
    recoveryControl,
    status() {
      upgradeIdleRootLayersIfNeeded();
      const nativeResponses = shared.nativeResponsesRelay?.status();
      if (!shared.closing && !shared.nativeResponsesClosing && nativeResponses?.closed !== true
        && shared.implementation?.status === implementation.status && shared.server) installNativeResponseSocketGuard(shared.server, onEvent);
      return { running: shared.server.listening, nativeHealthy: shared.nativeHealthy,
      nativeResponseSocketGuardInstalled: Boolean(shared.server[Symbol.for("napcat.native.responses.endpointSocketGuard")]),
      nativeResponses: nativeResponses ? { closed: nativeResponses.closed, connections: nativeResponses.connections,
        ...(nativeResponses.anchorFixVersion ? { anchorFixVersion: nativeResponses.anchorFixVersion } : {}) } : null,
      ...(rootAdmissions.anchorFixVersion ? { rootAnchorFixVersion: rootAdmissions.anchorFixVersion } : {}),
      coldStart: shared.coldStart?.status ?? null,
      transactionActive: shared.transactionActive, defaultWorkerId: shared.defaultWorker?.workerId ?? null,
      liveCode: { stateSchema: coordinatorStateSchema, generation: shared.implementationGeneration },
      activeHttp: shared.requests.size, pendingControl: pending.size,
      recentRejections: shared.recentRejections.map(entry => ({ ...entry })),
      recoveryStates: [...recoveryRecords.values()].map(record => {
        const event = record.envelope.recovery;
        const active = threads.get(event.threadId);
        const binding = recoveryBinding(active);
        const enabled = !record.consumed && !record.terminal && active?.phase === "active" && active.turnId === event.turnId
          && Boolean(binding) && canContinueRecovery(event)
          && validateRecoveryEnvelope(record.envelope, { ...binding, threadId: event.threadId,
            turnId: event.turnId, requestId: event.requestId }, capability);
        return { ...record.envelope, ...event, canContinueHttp: enabled,
          displayState: active?.turnId === event.turnId && active.phase === "terminal"
            ? active.completion?.status === "interrupted" ? "cancelled" : active.completion?.status
            : event.phase === "stopped" ? "cancelled" : event.phase,
          actionRequired: active?.phase === "terminal" || record.terminal || record.consumed ? "none"
            : enabled ? "choose_http_or_cancel" : event.acceptance === "unknown" ? "verify_request_state"
            : event.phase === "waiting" && !event.willRetry ? "cancel_or_verify" : "none",
          actionToken: enabled ? record.actionToken : null, actionConsumed: record.consumed };
      }),
      sequences: { worker: shared.workerSequence, request: shared.requestSequence, native: shared.nativeSequence,
        http: shared.httpSequence, migration: shared.generation },
      activation: shared.activation ? { activationId: shared.activation.id, active: shared.activation.active, sourceWorkerId: shared.activation.source.workerId,
        targetWorkerId: shared.activation.target.workerId, deferredThreadIds: threadStates().filter(state => state.pendingActivation === shared.activation).map(state => state.threadId) } : null,
      ...(runtimeProfile ? { workerMaintenance: shared.workerMaintenance, maxLiveWorkers: 4, reclaimedWorkers: [...reclaimedWorkers] } : {}),
      terminalHistory: { retained: shared.terminalThreads?.size ?? 0, limit: maxThreads },
      threads: threadStates().map(state => ({ threadId: state.threadId, turnId: state.turnId, phase: state.phase,
        workerId: state.worker.workerId, activeHttp: state.activeHttp,
        recoveryState: state.worker.recoveryError ? "failed" : state.worker.recoveryTask && !state.worker.replacementWorker ? "recovering" : "ready",
        recoveryError: state.worker.recoveryError ?? null,
        migrationCleanupError: state.migrationCleanupError ?? null, recoveryBindingError: state.recoveryBindingError ?? null,
        pendingActivationId: state.pendingActivation?.id ?? null, activationError: state.activationError ?? null })),
      workers: [...workers.values()].map(worker => {
        let specification;
        try { specification = workerSpecification(worker); } catch {}
        return { workerId: worker.workerId, pid: worker.child.pid, ready: Boolean(worker.ready),
        alive: alive(worker), sourceHashes: worker.ready?.sourceHashes ?? null, exitCode: worker.child.exitCode, signalCode: worker.child.signalCode,
        candidateApprovalId: specification?.candidateApprovalId ?? null,
        sourceRunnerPath: specification?.runnerPath ?? null,
        recoveryError: worker.recoveryError ?? null, replacementWorkerId: worker.replacementWorker?.workerId ?? null,
        ...(runtimeProfile ? { retired: worker.retired, cleanupPending: worker.cleanupPending,
          threadHistoryCount: worker.threadHistory.size, reclamation: worker.reclamation } : {}) }; }) }; },
    async close() {
      if (shared.closeTask) return shared.closeTask;
      const closing = (async () => {
        if (runtimeProfile && shared.preparationTask) { try { await shared.preparationTask; } catch {} }
        if (shared.transactionActive) fail("COORDINATOR_MIGRATION_BUSY");
        shared.closing = true;
        await Promise.all(shared.workerStartupTasks ?? []);
        await shared.rootBodyInspector?.close();
        shared.internalMemoryRouter?.dispose();
        shared.nativeWsRetryState?.gate.close();
        shared.nativeWsRetryState?.connections.clear();
        clearNativeRootFailedPeers(shared);
        await shared.nativeResponsesRelay?.close();
        if (shared.server.listening) await new Promise(resolve => shared.server.close(resolve));
        await rootAdmissions.close?.();
        await shared.relay;
        for (const worker of workers.values()) {
          if (shared.workerStartupCleanupPending?.has(worker.workerId)) continue;
          if (alive(worker)) { try { await shared.dispatch("control", worker, "shutdown"); } catch {} }
          if (worker.child.exitCode === null && worker.child.signalCode === null) {
            if (worker.child.connected) worker.child.disconnect();
            let timer;
            try {
              await Promise.race([once(worker.child, "exit"), new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("COORDINATOR_CLEANUP_PENDING")), 15_000);
              })]);
            } finally { clearTimeout(timer); }
          }
        }
        if (shared.workerStartupCleanupPending?.size) fail("COORDINATOR_STARTUP_CLEANUP_PENDING");
        shared.coldStart?.release();
      })();
      shared.closeTask = closing;
      try { await closing; }
      catch (error) {
        if (shared.closeTask === closing) delete shared.closeTask;
        throw error;
      }
    },
  };
  return implementation;
}
