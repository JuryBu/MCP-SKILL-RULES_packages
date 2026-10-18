import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { HANDOFF_CHANNEL } from "./inner-runner-handoff-control.mjs";
import { fixedHandoffCompatibility } from "./inner-handoff-compatibility.mjs";
import { validateInnerRuntimeProfile, approvedInnerCandidate, seedInnerWorkerState } from "./inner-runtime-profile.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const validIdentity = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value);
const coordinatorStateSchema = "inner-coordinator-state-v1";
const implementationMethods = Object.freeze([
  "start", "prepareCandidate", "observeNativeMessage", "migrate", "activate", "rollbackActivation", "status", "close", "discardCandidate",
  "control", "launchWorker", "relayNative", "reclaimRetiredWorkers", "adoptForRequest", "handleHttpRequest",
  "handleWorkerMessage", "handleWorkerExit", "handleWorkerError", "handleWorkerReadyTimeout", "settleWorkerStartup",
  "handleControlTimeout", "handleControlSendError", "relayNativeEvent", "handleNativeRelayFailure",
  "handleHttpResponse", "handleHttpStreamError", "handleHttpError", "handleHttpAborted", "handleHttpClose",
  "releaseHttpRequest",
]);
const checkedImplementation = implementation => {
  if (!implementation || implementationMethods.some(name => typeof implementation[name] !== "function")) {
    fail("COORDINATOR_LIVE_CODE_METHOD_MISSING");
  }
  return Object.freeze(Object.fromEntries(implementationMethods.map(name => [name, implementation[name]])));
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
    sessionId: runtimeProfile ? crypto.randomUUID() : null, capability: crypto.randomBytes(32).toString("hex"),
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
    liveCodeParticipant: () => participant };
}

export function createInnerProxyCoordinatorImplementation(shared) {
  const { options, ownerId, nativeSourceId, root, upstreamOrigin, onEvent, environment, runtimeProfile,
    sessionId, capability, workers, reclaimedWorkers, threads, migrations, pending, adoptions, maxThreads } = shared;
  const recycleRetiredWorkers = runtimeProfile?.workerLifecycle?.recycleRetiredWorkers !== false;
  const emit = (type, fields = {}) => onEvent({ type, ...fields });
  const alive = worker => worker?.ready && worker.child.connected && worker.child.exitCode === null && worker.child.signalCode === null;
  shared.recentRejections ??= [];
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
  const rejectRequest = (code, metadata, state, decisionPoint, reason) => {
    const error = Object.assign(new Error(code), { code });
    rejectionErrors.set(error, rejectionDetails(metadata, state, decisionPoint, reason));
    throw error;
  };
  const identity = worker => ({ pid: worker.child.pid, instanceToken: worker.ready.instanceToken,
    core: worker.ready.sourceHashes.core, helper: worker.ready.sourceHashes.helper });
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
      pending.set(requestId, { worker, resolve, reject, timer });
      worker.child.send({ channel: HANDOFF_CHANNEL, requestId, method, ...params,
        instanceToken: worker.ready.instanceToken, capability, ownerId }, shared.bindDispatch("handleControlSendError", requestId));
    });
  }

  function handleControlTimeout(requestId, method) {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    entry.reject(new Error(`COORDINATOR_IPC_TIMEOUT:${method}`));
  }

  function handleControlSendError(requestId, error) {
    if (!error) return;
    const entry = pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(requestId);
    entry.reject(error);
  }

  async function launchWorker(specification) {
    if (shared.closing) fail("COORDINATOR_WORKER_LIMIT");
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
    if (recycleRetiredWorkers) await shared.dispatch("reclaimRetiredWorkers");
    if ([...workers.values()].filter(worker => worker.child.exitCode === null && worker.child.signalCode === null).length >= 4) fail("COORDINATOR_WORKER_LIMIT");
    const workerId = `${sessionId ? `${sessionId}-` : ""}worker-${++shared.workerSequence}`;
    const stateRoot = path.join(runtimeProfile?.stateRoot ?? root, workerId);
    if (fs.existsSync(stateRoot)) fail("COORDINATOR_STATE_EXISTS");
    seedInnerWorkerState(runtimeProfile, stateRoot);
    const stderrPath = path.join(root, `${workerId}.stderr.log`);
    const descriptor = fs.openSync(stderrPath, "wx");
    let child;
    try {
      child = fork(runnerPath, [], { execPath: options.nodeExecutable ?? process.execPath,
        cwd: process.platform === "win32" && root.length >= 260 ? path.toNamespacedPath(root) : root, windowsHide: true,
        stdio: ["ignore", "ignore", descriptor, "ipc"], env: { ...process.env, ...environment,
          ...(runtimeProfile ? { CODEX_HOME: runtimeProfile.codexHome } : {}),
          CODEX_MODEL_STREAM_PROXY_STATE_ROOT: stateRoot, CODEX_MODEL_STREAM_PROXY_HOST: "127.0.0.1",
          CODEX_MODEL_STREAM_PROXY_PORT: String(specification.port ?? 0), CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN: upstreamOrigin,
          CODEX_MODEL_STREAM_PROXY_HANDOFF_CONTROL: JSON.stringify({ schemaVersion: 1, mode: runtimeProfile ? "production" : "isolated", ownerId,
            capability, checkpointRoot: root, allowRuntimeCompatibility: true,
            ...(runtimeProfile ? { nativeSourceId, runtimeProfile: { ...sourceProfile, initial: specification } } : {}) }) } });
    } finally { fs.closeSync(descriptor); }
    const worker = { workerId, child, stateRoot, stderrPath, ready: null, nativeSequence: 0, createdAt: new Date().toISOString(),
      threadHistory: new Set(), releasedThreadHistory: new Set(), activeHttp: 0, retired: false, cleanupPending: false, reclamation: null,
      preparedCandidate: false, wasDefault: false, wasActivated: false };
    workers.set(workerId, worker);
    const ready = new Promise((resolve, reject) => {
      worker.startup = { resolve, reject, specification,
        timer: setTimeout(shared.bindDispatch("handleWorkerReadyTimeout", worker), 15_000) };
      child.on("message", shared.bindDispatch("handleWorkerMessage", worker));
      child.once("error", shared.bindDispatch("handleWorkerError", worker));
      child.once("exit", shared.bindDispatch("handleWorkerExit", worker));
    });
    try { return await ready; }
    catch (error) { if (child.connected) child.disconnect(); throw error; }
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
    if (!awaiting || awaiting.worker !== worker || message.instanceToken !== worker.ready?.instanceToken) return;
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
  }

  function relayNative(worker, event) {
    worker.threadHistory.add(event.threadId);
    return shared.dispatch("control", worker, "nativeTurn", { event: { ...event, sequence: ++worker.nativeSequence } });
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
    const eligible = worker => worker.retired && !worker.cleanupPending && worker !== shared.defaultWorker && worker.activeHttp === 0
      && shared.activation?.source !== worker
      && !threadStates().some(state => state.worker === worker
        || state.pendingActivation?.source === worker || state.pendingActivation?.target === worker)
      && ![...worker.threadHistory].some(threadId => !worker.releasedThreadHistory?.has(threadId) && !findThread(threadId))
      && ![...shared.requests.values()].some(request => request.worker === worker || request.thread?.worker === worker)
      && ![...pending.values()].some(request => request.worker === worker);
    shared.workerMaintenance = true;
    try {
      for (const worker of [...workers.values()]) {
        const transferable = () => [...workers.values()].filter(candidate => alive(candidate)).length >= 4
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
              state = { threadId, turnId: native.turnId, phase: "terminal", epoch: shared.nativeSequence,
                worker, activeHttp: 0, nativeRelays: 0,
                start: { threadId, turnId: native.turnId, phase: "active", sequence: native.sequence },
                completion: { threadId, turnId: native.turnId, phase: "terminal", status: native.status, sequence: native.sequence } };
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
    if (previous?.turnId === turnId && ((!terminal && previous.phase === "active")
      || (terminal && previous.phase === "terminal" && previous.completion?.status === message.params.turn.status))) {
      return shared.relay;
    }
    if ((!previous && terminal) || (previous && terminal && (previous.phase !== "active" || previous.turnId !== turnId))
      || (previous?.phase === "active" && !terminal)) fail("COORDINATOR_NATIVE_SEQUENCE_INVALID");
    const owners = previous ? [] : historyOwners(threadId);
    if (owners.length > 1) fail("COORDINATOR_THREAD_OWNER_AMBIGUOUS");
    if (!threads.has(threadId)) reserveThreadSlot(threadId);
    const event = { sequence: ++shared.nativeSequence, threadId, turnId, phase: terminal ? "terminal" : "active",
      ...(terminal ? { status: message.params.turn.status } : {}) };
    const state = Object.assign(previous ?? {}, { threadId, turnId, phase: event.phase, epoch: event.sequence,
      worker: previous?.worker ?? owners[0] ?? shared.defaultWorker, activeHttp: previous?.activeHttp ?? 0,
      nativeRelays: (previous?.nativeRelays ?? 0) + 1,
      start: terminal ? previous.start : event, completion: terminal ? event : null });
    if (!terminal && shared.activation?.active && state.worker !== shared.activation.target) state.pendingActivation = shared.activation;
    shared.terminalThreads?.delete(threadId);
    threads.set(threadId, state);
    shared.relay = shared.relay.then(shared.bindDispatch("relayNativeEvent", event))
      .catch(shared.bindDispatch("handleNativeRelayFailure"));
    return shared.relay;
  }

  async function relayNativeEvent(event) {
    const current = findThread(event.threadId);
    try {
      await migrations.get(event.threadId)?.done;
      await shared.dispatch("relayNative", current.worker, event);
      current.worker.releasedThreadHistory?.delete(event.threadId);
      emit("native_turn_relayed", { threadId: event.threadId, turnId: event.turnId, phase: event.phase,
        workerId: current.worker.workerId, sequence: event.sequence });
    } finally { if (current?.nativeRelays > 0) current.nativeRelays -= 1; }
  }

  function handleNativeRelayFailure(error) {
    shared.nativeHealthy = false;
    emit("native_relay_failed", { code: error.code ?? "NATIVE_RELAY_FAILED" });
  }

  async function handleHttpRequest(request, response) {
    let state;
    let routed;
    let metadata;
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
        for (;;) {
          await migrations.get(metadata.thread_id)?.done;
          const observedRelay = shared.relay;
          await observedRelay;
          if (!migrations.has(metadata.thread_id) && observedRelay === shared.relay) break;
        }
        state = threads.get(metadata.thread_id);
        if (!shared.nativeHealthy || !state || state.phase !== "active" || state.turnId !== metadata.turn_id || !alive(state.worker)) {
          rejectRequest("COORDINATOR_TURN_UNAVAILABLE", metadata, state, "before_adopt", unavailableReason(metadata, state));
        }
        decisionPoint = "during_adopt";
        await shared.dispatch("adoptForRequest", state, metadata, request, response);
        if (!shared.nativeHealthy || state.phase !== "active" || state.turnId !== metadata.turn_id || !alive(state.worker)) {
          rejectRequest("COORDINATOR_TURN_UNAVAILABLE", metadata, state, "after_adopt", unavailableReason(metadata, state));
        }
      }
      decisionPoint = "forwarding";
      if (request.aborted || response.destroyed) return;
      if (shared.closing) fail("COORDINATOR_CLOSING");
      const worker = state.worker;
      state.activeHttp += 1;
      worker.activeHttp += 1;
      routed = { id: `http-${++shared.httpSequence}`, thread: state, worker, request, response, onward: null,
        accounted: false, implementationGeneration: shared.implementationGeneration };
      shared.requests.set(routed.id, routed);
      const port = worker.ready.status.port;
      emit("request_routed", { threadId: state.threadId, turnId: state.turnId, workerId: worker.workerId, pid: worker.child.pid,
        requestClass: state.threadId === null ? (catalog ? "model_catalog" : memory ? "memory_background" : "image_background") : "turn" });
      const onward = http.request({ hostname: "127.0.0.1", port, path: request.url, method: request.method,
        headers: { ...request.headers, host: `127.0.0.1:${port}` } }, shared.bindDispatch("handleHttpResponse", routed));
      routed.onward = onward;
      onward.once("error", shared.bindDispatch("handleHttpError", routed));
      request.once("aborted", shared.bindDispatch("handleHttpAborted", routed));
      response.once("close", shared.bindDispatch("handleHttpClose", routed));
      response.once("finish", shared.bindDispatch("releaseHttpRequest", routed));
      request.pipe(onward);
    } catch (error) {
      if (routed) shared.dispatch("releaseHttpRequest", routed);
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
    }
  }

  function handleHttpResponse(routed, received) {
    routed.response.writeHead(received.statusCode ?? 502, received.headers);
    received.on("error", shared.bindDispatch("handleHttpStreamError", routed));
    received.pipe(routed.response);
  }

  function handleHttpStreamError(routed) {
    routed.response.destroy();
  }

  function handleHttpError(routed) {
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
    routed.thread.activeHttp -= 1;
    routed.worker.activeHttp -= 1;
    shared.requests.delete(routed.id);
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
        catch { shared.nativeHealthy = false; }
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

  return {
    async start(initial) {
      if (shared.defaultWorker || shared.starting || shared.closing) fail("COORDINATOR_ALREADY_STARTED");
      shared.starting = true;
      try {
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
    status() { return { running: shared.server.listening, nativeHealthy: shared.nativeHealthy,
      transactionActive: shared.transactionActive, defaultWorkerId: shared.defaultWorker?.workerId ?? null,
      liveCode: { stateSchema: coordinatorStateSchema, generation: shared.implementationGeneration },
      activeHttp: shared.requests.size, pendingControl: pending.size,
      recentRejections: shared.recentRejections.map(entry => ({ ...entry })),
      sequences: { worker: shared.workerSequence, request: shared.requestSequence, native: shared.nativeSequence,
        http: shared.httpSequence, migration: shared.generation },
      activation: shared.activation ? { activationId: shared.activation.id, active: shared.activation.active, sourceWorkerId: shared.activation.source.workerId,
        targetWorkerId: shared.activation.target.workerId, deferredThreadIds: threadStates().filter(state => state.pendingActivation === shared.activation).map(state => state.threadId) } : null,
      ...(runtimeProfile ? { workerMaintenance: shared.workerMaintenance, maxLiveWorkers: 4, reclaimedWorkers: [...reclaimedWorkers] } : {}),
      terminalHistory: { retained: shared.terminalThreads?.size ?? 0, limit: maxThreads },
      threads: threadStates().map(state => ({ threadId: state.threadId, turnId: state.turnId, phase: state.phase,
        workerId: state.worker.workerId, activeHttp: state.activeHttp,
        pendingActivationId: state.pendingActivation?.id ?? null, activationError: state.activationError ?? null })),
      workers: [...workers.values()].map(worker => ({ workerId: worker.workerId, pid: worker.child.pid, ready: Boolean(worker.ready),
        alive: alive(worker), sourceHashes: worker.ready?.sourceHashes ?? null, exitCode: worker.child.exitCode, signalCode: worker.child.signalCode,
        ...(runtimeProfile ? { retired: worker.retired, cleanupPending: worker.cleanupPending,
          threadHistoryCount: worker.threadHistory.size, reclamation: worker.reclamation } : {}) })) }; },
    async close() {
      if (shared.closing) return;
      if (runtimeProfile && shared.preparationTask) { try { await shared.preparationTask; } catch {} }
      if (shared.transactionActive) fail("COORDINATOR_MIGRATION_BUSY");
      shared.closing = true;
      if (shared.server.listening) await new Promise(resolve => shared.server.close(resolve));
      await shared.relay;
      for (const worker of workers.values()) {
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
    },
  };
}
