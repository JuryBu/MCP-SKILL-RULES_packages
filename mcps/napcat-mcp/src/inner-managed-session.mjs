import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import net from "node:net";
import { createCodexAppServerProxy } from "./codex-app-server-proxy.mjs";
import { parseArguments, runCodexAppServerProxyService, waitForLaunchPublication } from "./codex-app-server-proxy-runner.mjs";
import { createInnerProxyCoordinator, recordNativeWsRelayFailure, recordNativeRootPeerFailure } from "./inner-proxy-coordinator.mjs";
import { createInnerNativeTurnSource } from "./inner-native-turn-source.mjs";
import { validateInnerRuntimeProfile, approvedInnerCandidate, readInnerCandidateRegistry, checkedRuntimePath } from "./inner-runtime-profile.mjs";
import { createModelOperationLedger } from "./model-operation-ledger.mjs";
import { createProxyParentCodeRuntime } from "./proxy-live-parent-runtime.mjs";
import { createProxyClassCodeParticipant } from "./proxy-live-code-runtime.mjs";
import { createProxyWholeRuntimeControl } from "./proxy-whole-runtime-control.mjs";
import { createManagedNativeIdentitySupplier } from "./managed-native-process-identity.mjs";

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const nativeSourceGeneration = crypto.randomUUID();
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const implementationMethods = Object.freeze([
  "start", "prepareCandidate", "migrate", "activate", "rollbackActivation", "status", "waitForClose", "close",
  "dispatchControl", "handleCoordinatorEvent", "createOuterProxy", "handleNativeTurn", "handleOuterEvent",
  "handleOuterResult", "handleOuterFailure", "handleOuterFinished", "refreshPublishedStatus", "handleControlDeadline",
  "handleServiceCodeParticipant",
]);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const checkedImplementation = implementation => {
  if (!implementation || implementationMethods.some(name => typeof implementation[name] !== "function")) {
    fail("MANAGED_SESSION_LIVE_CODE_METHOD_MISSING");
  }
  return Object.freeze(Object.fromEntries(implementationMethods.map(name => [name, implementation[name]])));
};

function preparationView(shared) {
  let constructing = true;
  const views = new WeakMap();
  const originals = new WeakMap();
  const unwrap = value => originals.get(value) ?? value;
  const protect = value => {
    if (value === null || !["object", "function"].includes(typeof value)) return value;
    if (views.has(value)) return views.get(value);
    const mutate = action => (...args) => {
      if (constructing) fail("MANAGED_SESSION_LIVE_CODE_FACTORY_SIDE_EFFECT");
      return action(...args);
    };
    const view = typeof value === "function" ? function (...args) {
      if (constructing) fail("MANAGED_SESSION_LIVE_CODE_FACTORY_SIDE_EFFECT");
      return Reflect.apply(value, unwrap(this), args.map(unwrap));
    } : new Proxy(Object.create(null), {
      get(_target, key) {
        const member = Reflect.get(value, key, value);
        return constructing || typeof member === "function" ? protect(member) : member;
      },
      has: (_target, key) => Reflect.has(value, key),
      ownKeys: () => Reflect.ownKeys(value),
      getOwnPropertyDescriptor(_target, key) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        return descriptor ? { configurable: true, enumerable: descriptor.enumerable,
          writable: true, value: constructing ? protect(Reflect.get(value, key, value)) : Reflect.get(value, key, value) } : undefined;
      },
      set: mutate((_target, key, member) => Reflect.set(value, key, unwrap(member), value)),
      defineProperty: mutate((_target, key, descriptor) => Reflect.defineProperty(value, key, descriptor)),
      deleteProperty: mutate((_target, key) => Reflect.deleteProperty(value, key)),
      setPrototypeOf: mutate((_target, prototype) => Reflect.setPrototypeOf(value, prototype)),
      preventExtensions: () => fail("MANAGED_SESSION_LIVE_CODE_FACTORY_SIDE_EFFECT"),
    });
    views.set(value, view);
    originals.set(view, value);
    return view;
  };
  return { state: protect(shared), finish: () => { constructing = false; } };
}

function preparationIdentity(shared) {
  return [shared, shared.resources, shared.controlOperations, shared.resources.controlTimers].map(resource => ({
    resource,
    fields: Reflect.ownKeys(resource).map(key => [key, Reflect.getOwnPropertyDescriptor(resource, key)]),
    entries: resource instanceof Map || resource instanceof Set ? [...resource.entries()] : null,
  }));
}

function samePreparationIdentity(identity) {
  return identity.every(({ resource, fields, entries }) => Reflect.ownKeys(resource).length === fields.length
    && fields.every(([key, descriptor]) => {
      const current = Reflect.getOwnPropertyDescriptor(resource, key);
      return current && ["value", "get", "set", "writable", "enumerable", "configurable"]
        .every(name => Object.is(current[name], descriptor[name]));
    }) && (!entries || resource.size === entries.length && [...resource.entries()]
      .every((entry, index) => entry.every((value, position) => Object.is(value, entries[index][position])))));
}

export function validateManagedSessionConfiguration(configuration) {
  if (configuration?.mode === "production") {
    if (!Array.isArray(configuration.outerArguments)) throw new Error("MANAGED_SESSION_PRODUCTION_ARGUMENTS_REQUIRED");
    const options = parseArguments(configuration.outerArguments);
    let runtimeProfile = validateInnerRuntimeProfile(configuration, { options });
    const registry = readInnerCandidateRegistry(runtimeProfile);
    if (registry) runtimeProfile = validateInnerRuntimeProfile({ ...configuration, approvedCandidates: registry.candidates }, { options });
    return { root: runtimeProfile.checkpointRoot, home: runtimeProfile.codexHome, options, runtimeProfile };
  }
  if (configuration?.runtimeProfile || configuration?.stateRoot || configuration?.installationRoot
    || configuration?.approvedUpstreamOrigin) throw new Error("MANAGED_SESSION_PROFILE_MODE_MISMATCH");
  if (configuration?.mode !== "isolated") throw new Error("MANAGED_SESSION_ISOLATED_ONLY");
  const root = fs.realpathSync(configuration.checkpointRoot);
  if (!inside(fs.realpathSync(os.tmpdir()), root)) throw new Error("MANAGED_SESSION_TEMP_REQUIRED");
  const home = fs.realpathSync(configuration.codexHome);
  if (!inside(root, home)) throw new Error("MANAGED_SESSION_HOME_REQUIRED");
  const options = parseArguments(configuration.outerArguments);
  for (const [name, value] of Object.entries(options)) {
    if (!(name.endsWith("Path") && name !== "executablePath") && !["displayPolicyRoot", "outerRuntimeRoot"].includes(name)) continue;
    if (value === null) continue;
    const parent = fs.realpathSync(fs.existsSync(value) ? value : path.dirname(value));
    if (!inside(root, value) || (parent !== root && !inside(root, parent))) throw new Error("MANAGED_SESSION_PATH_OUTSIDE_ROOT");
  }
  if (!options.executablePath || !fs.statSync(options.executablePath).isFile()) throw new Error("MANAGED_SESSION_EXECUTABLE_REQUIRED");
  const ports = [configuration.innerPort, options.downstreamPort, options.controlPort, options.upstreamPort, options.probePort];
  if (ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535) || new Set(ports).size !== ports.length) {
    throw new Error("MANAGED_SESSION_DISTINCT_PORTS_REQUIRED");
  }
  if (fs.existsSync(options.stopFilePath)) throw new Error("MANAGED_SESSION_STOP_REQUIREMENT_PRESENT");
  return { root, home, options };
}

export function createManagedInnerProxySession(configuration, onEvent = () => {}, serviceDependencies = {}) {
  const { root, home, options, runtimeProfile } = validateManagedSessionConfiguration(configuration);
  const shared = { configuration, onEvent, serviceDependencies, root, home, options, runtimeProfile,
    coordinator: null, nativeSource: null, managedInnerControl: null, serviceCodeParticipant: null, parentCodeRuntime: null,
    stopIdentity: JSON.stringify({ ownerId: configuration.ownerId, nonce: crypto.randomUUID(), createdAt: new Date().toISOString() }),
    started: false, closed: false, innerEndpoint: null, outerTask: null, outerResult: null, outerFinished: false,
    stopWritten: false, shutdownRequested: false, publicationStarted: false, cleanupError: null, coordinatorCloseTask: null,
    controlRevision: 0, controlBusy: false, controlOperations: new Map(),
    resources: { publicationTimer: null, controlTimers: new Set() },
    completion: null, resolveCompletion: null, rejectCompletion: null,
    implementation: null, implementationGeneration: 0 };
  shared.completion = new Promise((resolve, reject) => { shared.resolveCompletion = resolve; shared.rejectCompletion = reject; });
  shared.completion.catch(() => {});
  shared.dispatch = (method, ...args) => shared.implementation[method](...args);
  shared.bindDispatch = (method, ...bound) => (...args) => shared.dispatch(method, ...bound, ...args);
  shared.coordinator = createInnerProxyCoordinator({ ownerId: configuration.ownerId, nativeSourceId: configuration.nativeSourceId,
    checkpointRoot: root, upstreamOrigin: configuration.upstreamOrigin, port: configuration.innerPort,
    mode: configuration.mode, runtimeProfile,
    nodeExecutable: configuration.nodeExecutable, environment: { ...configuration.environment, CODEX_HOME: home },
    isShutdownRequested: () => shared.shutdownRequested || shared.outerFinished
      || shared.serviceCodeParticipant?.snapshot().state.stopRequested === true || fs.existsSync(options.stopFilePath),
    onEvent: shared.bindDispatch("handleCoordinatorEvent") });
  shared.nativeSource = createInnerNativeTurnSource({ sourceId: configuration.nativeSourceId, coordinator: shared.coordinator });
  shared.nativeSourceGeneration = nativeSourceGeneration;
  shared.managedInnerControl = runtimeProfile ? { dispatch: shared.bindDispatch("dispatchControl") } : null;
  shared.implementation = checkedImplementation(createManagedInnerProxySessionImplementation(shared));
  const preparations = new WeakSet();
  const snapshots = new WeakSet();
  const snapshot = () => {
    const token = Object.freeze({ state: shared, implementation: shared.implementation, generation: shared.implementationGeneration });
    snapshots.add(token);
    return token;
  };
  const participant = Object.freeze({ id: "managed-session", stateSchema: "inner-managed-session-state-v1",
    exportName: "createManagedInnerProxySessionImplementation", snapshot,
    prepare(module) {
      const factory = module?.createManagedInnerProxySessionImplementation;
      if (typeof factory !== "function") fail("MANAGED_SESSION_LIVE_CODE_EXPORT_MISSING");
      const identity = preparationIdentity(shared);
      const view = preparationView(shared);
      let implementation;
      try {
        implementation = checkedImplementation(factory(view.state));
        if (!samePreparationIdentity(identity)) fail("MANAGED_SESSION_LIVE_CODE_RESOURCE_DRIFT");
      } finally { view.finish(); }
      const candidate = Object.freeze({ state: shared, implementation });
      preparations.add(candidate);
      return candidate;
    },
    activate(candidate) {
      if (!preparations.has(candidate) || candidate.state !== shared) fail("MANAGED_SESSION_LIVE_CODE_CANDIDATE_INVALID");
      const token = snapshot();
      shared.implementation = candidate.implementation;
      shared.implementationGeneration += 1;
      return token;
    },
    restore(token) {
      if (!snapshots.has(token) || token.state !== shared) fail("MANAGED_SESSION_LIVE_CODE_SNAPSHOT_INVALID");
      shared.implementation = token.implementation;
      shared.implementationGeneration += 1;
    },
  });
  shared.sessionCodeParticipant = participant;
  return { ...Object.fromEntries(implementationMethods.slice(0, 8).map(name => [name, shared.bindDispatch(name)])),
    liveCodeParticipant: () => participant, serviceCodeParticipant: () => shared.serviceCodeParticipant,
    parentCodeRuntime: () => shared.parentCodeRuntime };
}

export function createManagedInnerProxySessionImplementation(shared) {
  const { configuration, onEvent, serviceDependencies, home, options, runtimeProfile, coordinator } = shared;
  const closeCoordinator = () => shared.coordinatorCloseTask ??= coordinator.close();
  const nativeIdentitySupplier = createManagedNativeIdentitySupplier({
    getServiceState: () => shared.serviceCodeParticipant?.snapshot().state,
  });
  const configureNativeIdentity = () => {
    const coordinatorOptions = coordinator.liveCodeParticipant().snapshot().state.options;
    coordinatorOptions.getExpectedNativeIdentity ??= nativeIdentitySupplier;
    coordinatorOptions.reconcileNativeStart = (metadata, context) => shared.dispatch("dispatchControl", "reconcile-root-start", metadata, context);
    coordinatorOptions.nativeStartLookupPending = metadata => {
      const lookup = shared.rootStartLookups?.get(JSON.stringify([metadata.thread_id, metadata.turn_id]));
      return lookup?.trusted === true && lookup.current();
    };
    return coordinatorOptions.getExpectedNativeIdentity;
  };
  const publish = state => {
    configureNativeIdentity();
    if (!runtimeProfile) return;
    const statePath = runtimeProfile.managedStatePath;
    const temporary = `${statePath}.${crypto.randomUUID()}.pending`;
    const current = coordinator.status();
    const source = shared.nativeSource.status();
    const healthy = state === "running" && !shared.outerFinished && source.healthy && current.running
      && current.nativeHealthy && !shared.selectionRecoveryError
      && current.workers.some(worker => worker.workerId === current.defaultWorkerId && worker.alive);
    try {
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, state: state === "running" && !healthy ? "degraded" : state,
        healthy, livenessAt: new Date().toISOString(), ownerId: configuration.ownerId,
        nativeSourceId: configuration.nativeSourceId, pid: process.pid, instanceToken: options.instanceToken,
        front: { pid: process.pid, host: "127.0.0.1", port: shared.innerEndpoint?.port ?? null, listening: current.running },
        innerEndpoint: shared.innerEndpoint, nativeSource: source, stopFilePath: options.stopFilePath, outerResult: shared.outerResult,
        error: shared.cleanupError, selectionRecoveryError: shared.selectionRecoveryError ?? null,
        coordinator: current, controlRevision: shared.controlRevision, controlBusy: shared.controlBusy,
        controlOperations: [...shared.controlOperations.values()] }), { flag: "wx" });
      fs.renameSync(temporary, statePath);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  };
  function refreshPublishedStatus() {
    try { publish(shared.innerEndpoint ? "running" : "starting"); }
    catch (error) { onEvent({ type: "managed_state_publish_failed", code: error.code ?? error.message }); }
  }
  function clearOwnedStop() {
    if (runtimeProfile && shared.stopWritten && fs.existsSync(options.stopFilePath)
      && fs.readFileSync(options.stopFilePath, "utf8") === shared.stopIdentity) fs.unlinkSync(options.stopFilePath);
  }
  const readRuntime = () => {
    try { return JSON.parse(fs.readFileSync(options.runtimeStatePath, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  const isOuterControlReady = outer => outer?.state === "running"
    || (outer?.state === "waiting_for_desktop" && outer?.waitingForDesktop === true
      && outer?.appServerPid === null && outer?.fallbackRequired !== true);
  function requireReady() {
    if (!shared.started || shared.closed || shared.outerFinished || !shared.nativeSource.status().healthy) throw new Error("MANAGED_SESSION_NOT_READY");
  }
  function requireIdle() {
    const current = coordinator.status();
    if (current.transactionActive || current.threads.some(thread => thread.phase === "active" || thread.activeHttp > 0)) {
      throw new Error("MANAGED_SESSION_BUSY");
    }
  }
  async function awaitOuterStop() {
    const deadline = Date.now() + 30000;
    while (!shared.outerFinished && Date.now() < deadline) await sleep(50);
    if (!shared.outerFinished) throw new Error("MANAGED_SESSION_OUTER_STOP_PENDING");
    await shared.outerTask;
  }
  function requestOwnedStop() {
    shared.shutdownRequested = true;
    if (shared.stopWritten || shared.outerFinished) return;
    if (fs.existsSync(options.stopFilePath)) return;
    fs.writeFileSync(options.stopFilePath, shared.stopIdentity, { flag: "wx" });
    shared.stopWritten = true;
  }
  function controlStatus() {
    requireReady();
    const current = coordinator.status();
    if (!current.nativeHealthy) throw new Error("MANAGED_SESSION_NOT_READY");
    const selected = current.workers.find(worker => worker.workerId === current.defaultWorkerId && worker.alive);
    if (!shared.innerEndpoint || !isOuterControlReady(readRuntime()) || !selected) throw new Error("INNER_CONTROL_NOT_READY");
    return { ok: true, ownerId: configuration.ownerId, nativeSourceId: configuration.nativeSourceId,
      instanceToken: options.instanceToken, revision: shared.controlRevision, busy: shared.controlBusy,
      selectedWorkerId: selected.workerId, selectedSourceHashes: selected.sourceHashes,
      coordinator: current, operations: [...shared.controlOperations.values()] };
  }
  function bindControl(input) {
    if (input.ownerId !== configuration.ownerId || input.nativeSourceId !== configuration.nativeSourceId
      || input.instanceToken !== options.instanceToken) throw new Error("INNER_CONTROL_IDENTITY_MISMATCH");
  }
  function diagnosticControlStatus() {
    const current = coordinator.status();
    const source = shared.nativeSource.status();
    const outer = readRuntime();
    const selected = current.workers.find(worker => worker.workerId === current.defaultWorkerId && worker.alive);
    const healthy = Boolean(shared.started && !shared.closed && !shared.outerFinished && shared.innerEndpoint
      && isOuterControlReady(outer) && source.healthy && current.running && current.nativeHealthy
      && !shared.selectionRecoveryError && selected);
    const operations = [...shared.controlOperations.values()];
    return { ok: healthy, healthy, state: healthy ? "running" : shared.closed ? "closed" : shared.started ? "degraded" : "starting",
      failureCode: source.failureCode ?? (!source.healthy || !current.nativeHealthy ? "NATIVE_SOURCE_UNAVAILABLE"
        : shared.selectionRecoveryError ?? (healthy ? null : "MANAGED_SESSION_NOT_READY")),
      ownerId: configuration.ownerId, nativeSourceId: configuration.nativeSourceId,
      pid: process.pid, instanceToken: options.instanceToken, revision: shared.controlRevision, busy: shared.controlBusy,
      selectedWorkerId: selected?.workerId ?? current.defaultWorkerId ?? null, selectedSourceHashes: selected?.sourceHashes ?? null,
      nativeSource: source, coordinator: current, operations,
      inFlight: { activeHttp: current.activeHttp ?? null, pendingControl: current.pendingControl ?? null,
        activeTurns: current.threads.filter(thread => thread.phase === "active").length,
        pendingControlOperations: operations.filter(operation => operation.state === "pending").length,
        unknownControlOperations: operations.filter(operation => operation.state === "unknown").length,
        transactionActive: current.transactionActive, workerMaintenance: current.workerMaintenance,
        clientCount: outer?.proxy?.clientCount ?? null,
        activeOperationCount: outer?.proxy?.outerRuntime?.activeOperationCount ?? null,
        trackedRequestCount: outer?.proxy?.outerRuntime?.trackedRequestCount ?? null,
        pendingToolCount: outer?.proxy?.outerRuntime?.pendingToolCount ?? null } };
  }
  async function dispatchControl(method, input, context = {}) {
    if (method === "reconcile-root-start") {
      if (typeof context.isClosed !== "function" || !(context.signal instanceof AbortSignal)) return { recovered: false };
      const threadId = input?.thread_id;
      const turnId = input?.turn_id;
      if (![threadId, turnId].every(value => typeof value === "string" && value.length > 0
        && value.length <= 512 && !value.includes("\u0000"))) return { recovered: false };
      const registry = shared.rootStartLookups ??= new Map();
      const key = JSON.stringify([threadId, turnId]);
      const waiter = { isClosed: context.isClosed, signal: context.signal };
      const waiting = value => !value.signal?.aborted && value.isClosed?.() !== true;
      let lookup = registry.get(key);
      if (lookup && !lookup.current()) { registry.delete(key); lookup = null; }
      if (!lookup) {
        const proxy = shared.recoveryProxy;
        const client = [...(proxy?.clients ?? [])].find(value => !value.closed && value.initialized === true
          && value.upstream?.readyState === proxy.WebSocketImpl.OPEN
          && (value.initializedUpstream === undefined || value.initializedUpstream === value.upstream));
        if (!client || registry.size >= 128) return { recovered: false };
        const upstream = client.upstream;
        const connectionGeneration = client.metadataUpstreamGeneration;
        if (typeof connectionGeneration !== "string" || !connectionGeneration) return { recovered: false };
        const source = shared.nativeSource;
        const generation = shared.nativeSourceGeneration;
        const implementationGeneration = shared.implementationGeneration;
        const revision = shared.controlRevision;
        const coordinatorState = coordinator.liveCodeParticipant().snapshot().state;
        const defaultWorker = coordinatorState.defaultWorker;
        const coordinatorGeneration = coordinatorState.generation;
        const coordinatorImplementation = coordinatorState.implementation;
        const coordinatorImplementationGeneration = coordinatorState.implementationGeneration;
        const previous = coordinatorState.threads.get(threadId) ?? coordinatorState.terminalThreads?.get(threadId);
        const previousTurnId = previous?.turnId;
        const previousEpoch = previous?.epoch;
        const previousWorker = previous?.worker;
        const previousPhase = previous?.phase;
        const previousStart = previous?.start;
        const previousConnectionGeneration = previousStart?.connectionGeneration;
        let expectedPhase = previousPhase;
        let expectedEpoch = previousEpoch;
        let recovery = previous?.pendingNativeStartRecovery;
        const reuse = (previousPhase === "active" || previousPhase === "terminal" && recovery)
          && previousTurnId !== turnId && input.subagent_kind === "thread_spawn"
          && (input.request_kind === undefined || input.request_kind === "turn");
        const workerChild = previousWorker?.child;
        const workerReady = previousWorker?.ready;
        const workerToken = workerReady?.instanceToken;
        const workerSource = JSON.stringify(workerReady?.sourceHashes);
        const workerStateRoot = previousWorker?.stateRoot;
        const targetIdle = () => previous.activeHttp === 0 && previous.nativeRelays === 0
          && ![...coordinatorState.requests.values()].some(request => request.thread === previous);
        const unchangedTarget = () => {
          const current = coordinatorState.threads.get(threadId) ?? coordinatorState.terminalThreads?.get(threadId);
          return previous ? current === previous && current.phase === (reuse ? expectedPhase : "terminal") && current.turnId === previousTurnId
            && current.turnId !== turnId && current.epoch === expectedEpoch && current.worker === previousWorker
            && (reuse || !current.pendingNativeStartRecovery && targetIdle())
            && current.pendingNativeStartRecovery === recovery
            && (!recovery || recovery.turnId === previousTurnId && recovery.worker === previousWorker
              && recovery.stateRoot === workerStateRoot && recovery.child === workerChild && recovery.ready === workerReady)
            && !current.pendingActivation && !current.activationError && !current.migrationCleanupError
            && (!reuse || current.start === previousStart && current.start?.connectionGeneration === previousConnectionGeneration
              && previousWorker.child === workerChild && previousWorker.ready === workerReady
              && workerReady?.instanceToken === workerToken && JSON.stringify(workerReady?.sourceHashes) === workerSource
              && previousWorker.stateRoot === workerStateRoot && workerChild?.connected === true
              && workerChild.exitCode === null && workerChild.signalCode === null && !previousWorker.startup
              && !previousWorker.cleanupPending && !previousWorker.recoveryTask && !previousWorker.recoveryError
              && !previousWorker.replacementWorker && previousWorker.reclamation !== "stopping") : !current;
        };
        const operationsClear = () => {
          const stateRoot = checkedRuntimePath(workerStateRoot, { directory: true });
          const file = checkedRuntimePath(path.join(stateRoot, "codex-model-operation-state.json"), { existing: true });
          if (fs.statSync(file).size > 2 * 1024 * 1024) return false;
          const bytes = fs.readFileSync(file);
          if (bytes.length > 2 * 1024 * 1024) return false;
          const operations = createModelOperationLedger({ state: JSON.parse(bytes.toString("utf8")) });
          return operations.exportThread(threadId).entries.length === 0;
        };
        const supplier = configureNativeIdentity();
        lookup = { threadId, turnId, trusted: false, invalid: false, waiters: new Set(), deadline: Date.now() + 5000 };
        lookup.current = () => !lookup.invalid && Date.now() < lookup.deadline
          && [...lookup.waiters].some(waiting) && !shared.closed && !shared.outerFinished && !shared.shutdownRequested
          && shared.nativeSource === source && shared.nativeSourceGeneration === generation
          && shared.implementationGeneration === implementationGeneration && shared.controlRevision === revision
          && source.status().healthy && coordinatorState.nativeHealthy && !coordinatorState.closing
          && !coordinatorState.transactionActive && !coordinatorState.workerMaintenance && !shared.controlBusy
          && coordinatorState.defaultWorker === defaultWorker && coordinatorState.generation === coordinatorGeneration
          && coordinatorState.implementation === coordinatorImplementation
          && coordinatorState.implementationGeneration === coordinatorImplementationGeneration
          && !coordinatorState.migrations.has(threadId) && !coordinatorState.adoptions.has(threadId) && unchangedTarget()
          && !client.closed && client.upstream === upstream && upstream.readyState === proxy.WebSocketImpl.OPEN
          && client.metadataUpstreamGeneration === connectionGeneration && client.initialized === true
          && (client.initializedUpstream === undefined || client.initializedUpstream === upstream)
          && (!lookup.identity || supplier.isCurrent?.(lookup.identity) === true);
        lookup.waiters.add(waiter);
        registry.set(key, lookup);
        lookup.done = (async () => {
          try {
            if (!lookup.current()) return { recovered: false };
            lookup.identity = await supplier({});
            if (!lookup.current()) return { recovered: false };
            const lookupTurns = params => proxy._liveInjectRequest(client, "thread/turns/list", params,
              { timeoutMs: Math.max(1, Math.min(1250, lookup.deadline - Date.now())) });
            lookup.trusted = true;
            let cursor;
            const cursors = new Set();
            let turn;
            let terminal;
            for (let page = 0; page < 4 && lookup.current(); page += 1) {
              const result = await lookupTurns({ threadId, limit: 8, sortDirection: "desc", itemsView: "notLoaded",
                ...(cursor ? { cursor } : {}) });
              if (!lookup.current() || !Array.isArray(result?.data)) return { recovered: false };
              turn ??= result.data.find(value => value.id === turnId);
              if (reuse) terminal ??= result.data.find(value => value.id === previousTurnId);
              if (turn && (!reuse || terminal)) break;
              const next = result.nextCursor;
              if (typeof next !== "string" || !next || next.length > 4096 || cursors.has(next)) break;
              cursors.add(next);
              cursor = next;
            }
            if (!lookup.current() || turn?.status !== "inProgress") return { recovered: false };
            if (reuse && !["completed", "failed", "interrupted"].includes(terminal?.status)) return { recovered: false };
            const commits = shared.rootStartCommits ??= new Map();
            const commit = Promise.resolve(commits.get(threadId)).catch(() => {}).then(async () => {
              if (!lookup.current()) return false;
              if (reuse) {
                while (lookup.current() && !targetIdle()) await sleep(20);
                if (!lookup.current() || !operationsClear() || !lookup.current() || !targetIdle()) return false;
                recovery ??= { turnId: previousTurnId, worker: previousWorker, stateRoot: workerStateRoot,
                  child: workerChild, ready: workerReady };
                previous.pendingNativeStartRecovery = recovery;
                if (previous.phase === "active") {
                  const completed = source.observe({ method: "turn/completed",
                    params: { threadId, turn: { id: previousTurnId, status: terminal.status } } });
                  completed.catch(() => {});
                  if (coordinatorState.threads.get(threadId) !== previous || previous.phase !== "terminal"
                    || previous.turnId !== previousTurnId || previous.worker !== previousWorker
                    || previous.completion?.status !== terminal.status) return false;
                  expectedPhase = "terminal";
                  expectedEpoch = previous.completion.sequence;
                }
                if (!lookup.current() || previous.activeHttp !== 0
                  || previous.nativeRelays !== (previousPhase === "active" ? 1 : 0) || !operationsClear()) return false;
                delete previous.pendingNativeStartRecovery;
              }
              try {
                await source.observe({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } },
                  rootAdmissionOrigin: "authoritative_lookup", rootAdmissionNativeIdentity: lookup.identity,
                  recoveryConnectionGeneration: connectionGeneration });
              } catch (error) {
                if (recovery && previous.turnId === previousTurnId) previous.pendingNativeStartRecovery = recovery;
                throw error;
              }
              return true;
            });
            commits.set(threadId, commit);
            try { if (!await commit) return { recovered: false }; }
            finally { if (commits.get(threadId) === commit) commits.delete(threadId); }
            if (reuse) onEvent({ type: "authoritative_terminal_recovery", threadId, turnId: previousTurnId,
              status: terminal.status, source: "thread/turns/list" });
            onEvent({ type: "authoritative_start_recovery", threadId, turnId, source: "thread/turns/list", connectionGeneration });
            return { recovered: true };
          } catch (error) {
            onEvent({ type: "authoritative_start_recovery_skipped", threadId, turnId, code: error.code ?? error.message });
            return { recovered: false };
          } finally {
            lookup.trusted = false;
            if (registry.get(key) === lookup) registry.delete(key);
          }
        })();
      } else lookup.waiters.add(waiter);
      const removeWaiter = () => {
        lookup.waiters.delete(waiter);
        if (![...lookup.waiters].some(waiting)) {
          lookup.invalid = true;
          if (registry.get(key) === lookup) registry.delete(key);
        }
      };
      context.signal.addEventListener("abort", removeWaiter, { once: true });
      if (context.signal.aborted) removeWaiter();
      try { return await lookup.done; }
      finally { context.signal.removeEventListener("abort", removeWaiter); removeWaiter(); }
    }
    if (method === "recover-before-turn" && typeof context.lookupTurns === "function"
      && typeof context.connectionActive === "function") {
      const originalSource = shared.nativeSource;
      await originalSource.observe(null);
      const before = coordinator.status();
      if (!before.nativeHealthy || !originalSource.status().healthy) throw new Error("INNER_NATIVE_SOURCE_UNAVAILABLE");
      const target = before.threads.find(thread => thread.threadId === input.threadId);
      if (!target || target.phase !== "active") return { recovered: false };
      if (!before.nativeHealthy || !shared.nativeSource.status().healthy || before.transactionActive
        || before.workerMaintenance || shared.controlBusy) {
        throw new Error("INNER_TURN_RECOVERY_BUSY");
      }
      let cursor;
      let terminal;
      const seen = new Set();
      const deadline = Date.now() + 5000;
      for (let page = 0; page < 4 && Date.now() < deadline; page += 1) {
        const result = await context.lookupTurns({ threadId: input.threadId, limit: 8,
          sortDirection: "desc", itemsView: "notLoaded", ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result?.data)) throw new Error("INNER_TURN_RECOVERY_INVALID_HISTORY");
        terminal = result.data.find(turn => turn.id === target.turnId);
        if (terminal) break;
        const next = result.nextCursor;
        if (typeof next !== "string" || !next || next.length > 4096 || seen.has(next)) break;
        seen.add(next);
        cursor = next;
      }
      const checkedTarget = () => {
        const current = coordinator.status();
        const currentTarget = current.threads.find(thread => thread.threadId === input.threadId);
        if (!context.connectionActive() || current.transactionActive || current.workerMaintenance || shared.controlBusy
          || !current.nativeHealthy || shared.nativeSource !== originalSource || !originalSource.status().healthy
          || !currentTarget || currentTarget.activationError) throw new Error("INNER_TURN_RECOVERY_STATE_CHANGED");
        return currentTarget;
      };
      let currentTarget = checkedTarget();
      if (currentTarget.turnId !== target.turnId) return { recovered: false, reason: "native_progress" };
      if (terminal?.status === "inProgress") return { recovered: false, reason: "active_turn" };
      if (!terminal || !["completed", "failed", "interrupted"].includes(terminal.status)) {
        throw new Error("INNER_PREVIOUS_TURN_NOT_TERMINAL");
      }
      while (currentTarget.activeHttp !== 0) {
        if (Date.now() >= deadline) throw new Error("INNER_PREVIOUS_TURN_HTTP_DRAIN_TIMEOUT");
        await new Promise(resolve => setTimeout(resolve, 20));
        currentTarget = checkedTarget();
        if (currentTarget.turnId !== target.turnId) return { recovered: false, reason: "native_progress" };
      }
      if (currentTarget.phase === "terminal") return { recovered: false };
      if (currentTarget.workerId !== target.workerId) throw new Error("INNER_TURN_RECOVERY_STATE_CHANGED");
      await shared.nativeSource.observe({ method: "turn/completed",
        params: { threadId: input.threadId, turn: { id: target.turnId, status: terminal.status } } });
      const reconciled = checkedTarget();
      if (reconciled.turnId !== target.turnId) return { recovered: false, reason: "native_progress" };
      if (reconciled.phase !== "terminal") {
        throw new Error("INNER_TURN_RECOVERY_NOT_CONFIRMED");
      }
      onEvent({ type: "authoritative_terminal_recovery", threadId: input.threadId, turnId: target.turnId,
        status: terminal.status, source: "thread/turns/list" });
      return { recovered: true };
    }
    bindControl(input);
    if (method === "status") return diagnosticControlStatus();
    const current = controlStatus();
    if (method === "continue-http") {
      const result = await coordinator.recoveryControl(method, input);
      return { ok: result.accepted === true, ...result };
    }
    if (shared.controlOperations.has(input.requestId)) throw new Error("INNER_CONTROL_DUPLICATE_REQUEST_CHECK_STATUS");
    if (shared.controlBusy) throw new Error("INNER_CONTROL_BUSY");
    if (typeof input.requestId !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(input.requestId)
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== shared.controlRevision
      || input.selectedWorkerId !== current.selectedWorkerId
      || Object.keys(input.selectedSourceHashes ?? {}).sort().join(",") !== "control,core,helper,runner"
      || Object.entries(current.selectedSourceHashes).some(([key, value]) => input.selectedSourceHashes[key] !== value)) {
      throw new Error("INNER_CONTROL_STALE_SELECTION_OR_REVISION");
    }
    const operationFields = {
      prepare: ["candidateId"],
      migrate: ["candidateId", "threadId", "compatibility", "live", "drainTimeoutMs"],
      activate: ["candidateId", "compatibility"],
      rollback: ["activationId"],
      "reconcile-terminal": ["threadId", "turnId", "status", "evidenceSha256"],
    };
    const allowed = ["ownerId", "nativeSourceId", "instanceToken", "requestId", "expectedRevision", "selectedWorkerId", "selectedSourceHashes",
      ...(operationFields[method] ?? [])];
    if (!operationFields[method] || Object.keys(input).some(key => !allowed.includes(key))) throw new Error("INNER_CONTROL_REQUEST_INVALID");
    if (shared.controlOperations.size >= 128) throw new Error("INNER_CONTROL_RECEIPT_LIMIT");
    let specification;
    if (method === "prepare") {
      const candidate = approvedInnerCandidate(runtimeProfile, input.candidateId);
      specification = { runnerPath: candidate.runnerPath, expectedHashes: candidate.expectedHashes, candidateApprovalId: candidate.id };
    } else if (method === "migrate") {
      if (input.live !== undefined && typeof input.live !== "boolean") throw new Error("INNER_CONTROL_REQUEST_INVALID");
      if (input.live === true) requireReady();
      else {
        requireIdle();
        if (context.outerBusy) throw new Error("INNER_CONTROL_BUSY");
      }
      if (typeof input.threadId !== "string" || !input.threadId || input.threadId.length > 512
        || !current.coordinator.workers.some(worker => worker.workerId === input.candidateId && worker.alive)) throw new Error("INNER_CONTROL_TARGET_INVALID");
    } else if (method === "reconcile-terminal") {
      const target = current.coordinator.threads.find(thread => thread.threadId === input.threadId);
      if (!/^[a-f0-9]{64}$/u.test(input.evidenceSha256 ?? "")
        || !["completed", "failed", "interrupted"].includes(input.status)
        || !target || target.turnId !== input.turnId || target.phase !== "active"
        || target.activeHttp !== 0 || target.pendingActivationId || target.activationError
        || current.coordinator.transactionActive || !current.coordinator.nativeHealthy
        || !shared.nativeSource.status().healthy) throw new Error("INNER_CONTROL_RECONCILE_PRECONDITION_FAILED");
    } else {
      requireReady();
      if (method === "activate" && !current.coordinator.workers.some(worker => worker.workerId === input.candidateId && worker.alive)) {
        throw new Error("INNER_CONTROL_TARGET_INVALID");
      }
      if (method === "rollback" && (typeof input.activationId !== "string" || !input.activationId || input.activationId.length > 128)) {
        throw new Error("INNER_CONTROL_TARGET_INVALID");
      }
    }
    const startedAt = Date.now();
    const receipt = { requestId: input.requestId, method, revision: ++shared.controlRevision, state: "pending",
      requestSha256: crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex"), actualMs: null };
    shared.controlOperations.set(input.requestId, receipt);
    shared.controlBusy = true;
    try { publish("running"); }
    catch (error) { shared.controlOperations.delete(input.requestId); shared.controlBusy = false; throw error; }
    const operation = Promise.resolve().then(() => {
      if (method === "reconcile-terminal") {
        const target = coordinator.status().threads.find(thread => thread.threadId === input.threadId);
        if (!target || target.turnId !== input.turnId || target.phase !== "active" || target.activeHttp !== 0
          || target.pendingActivationId || target.activationError || coordinator.status().transactionActive) {
          throw new Error("INNER_CONTROL_RECONCILE_PRECONDITION_FAILED");
        }
        onEvent({ type: "operator_terminal_reconciliation", threadId: input.threadId, turnId: input.turnId,
          status: input.status, evidenceSha256: input.evidenceSha256, requestId: input.requestId });
        return shared.nativeSource.observe({ method: "turn/completed",
          params: { threadId: input.threadId, turn: { id: input.turnId, status: input.status } } }).then(() => {
          const after = coordinator.status();
          const reconciled = after.threads.find(thread => thread.threadId === input.threadId);
          if (!after.nativeHealthy || reconciled?.turnId !== input.turnId || reconciled.phase !== "terminal") {
            throw new Error("INNER_CONTROL_RECONCILE_NOT_CONFIRMED");
          }
          return { threadId: input.threadId, turnId: input.turnId, phase: "terminal", evidenceSha256: input.evidenceSha256 };
        });
      }
      if (method === "prepare") return coordinator.prepareCandidate(specification);
      if (method === "activate") return coordinator.activate({ candidateId: input.candidateId, compatibility: input.compatibility });
      if (method === "rollback") return coordinator.rollbackActivation({ activationId: input.activationId });
      return coordinator.migrate({ threadId: input.threadId, candidateId: input.candidateId,
        compatibility: input.compatibility, live: input.live ?? false, drainTimeoutMs: input.drainTimeoutMs ?? 1000 });
    }).then(result => {
      receipt.state = "completed"; receipt.result = result;
    }, error => { receipt.state = "failed"; receipt.error = { code: error.code ?? error.message }; }).finally(() => {
      receipt.actualMs = Date.now() - startedAt;
      shared.controlBusy = false;
      try { publish("running"); } catch { receipt.publicationPending = true; }
    });
    const deadline = { timer: null, resolve: null };
    try {
      await Promise.race([operation, new Promise(resolve => {
        deadline.resolve = resolve;
        deadline.timer = setTimeout(shared.bindDispatch("handleControlDeadline", deadline), 5000);
        shared.resources.controlTimers.add(deadline);
      })]);
    } finally { clearTimeout(deadline.timer); shared.resources.controlTimers.delete(deadline); }
    if (receipt.state === "pending") {
      receipt.state = "unknown";
      try { publish("running"); } catch {}
      return { ok: false, httpStatus: 202, outcome: "unknown", requestId: input.requestId,
        revision: shared.controlRevision, error: { code: "INNER_CONTROL_RESULT_PENDING_CHECK_STATUS" } };
    }
    return { ok: receipt.state === "completed", httpStatus: receipt.state === "completed" ? 200 : 409,
      requestId: input.requestId, revision: shared.controlRevision, actualMs: receipt.actualMs,
      result: receipt.result, error: receipt.error };
  }
  function createOuterProxy(proxyOptions) {
    const proxy = createCodexAppServerProxy({ ...proxyOptions,
      modelRecoveryControl: { ownerId: configuration.ownerId, nativeSourceId: configuration.nativeSourceId,
        bindingFor: (threadId, turnId, requestId) => coordinator.recoveryControl("binding", { threadId, turnId, requestId }) },
      ...(shared.managedInnerControl ? { managedInnerControl: shared.managedInnerControl } : {}),
      onNativeTurn: shared.bindDispatch("handleNativeTurn"),
      onEvent: shared.bindDispatch("handleOuterEvent", proxyOptions) });
    shared.recoveryProxy = proxy;
    if (options.outerRuntimeRoot && shared.serviceCodeParticipant) {
      const wholeControl = runtimeProfile ? createProxyWholeRuntimeControl(null, coordinator, runtimeProfile,
        proxyOptions.instanceToken, options.outerRuntimeRoot) : null;
      const parentRuntime = createProxyParentCodeRuntime([
        createProxyClassCodeParticipant(proxy), coordinator.liveCodeParticipant(),
        shared.sessionCodeParticipant, shared.serviceCodeParticipant,
        ...(wholeControl ? [wholeControl.liveCodeParticipant()] : []),
      ], { candidateRoot: options.outerRuntimeRoot, instanceId: proxyOptions.instanceToken,
        validateActive: () => {
          if (proxy.closed || shared.closed || !coordinator.status().running || !shared.nativeSource.status().healthy) {
            throw new Error("LIVE_PARENT_RUNTIME_NOT_HEALTHY");
          }
        } });
      if (wholeControl) wholeControl.attachParent(parentRuntime);
      shared.parentCodeRuntime = wholeControl ?? parentRuntime;
      proxy.liveCodeRuntime = shared.parentCodeRuntime;
    }
    return proxy;
  }
  async function handleOuterFinished() {
    shared.outerFinished = true;
    if (runtimeProfile) {
      try {
        await closeCoordinator();
        shared.closed = true;
        clearInterval(shared.resources.publicationTimer);
        clearOwnedStop();
        publish("closed");
        shared.resolveCompletion(shared.outerResult);
      } catch (error) {
        clearInterval(shared.resources.publicationTimer);
        shared.cleanupError = { code: error.code ?? error.message };
        try { publish("cleanup_pending"); } catch {}
        shared.rejectCompletion(error);
      }
    }
  }
  return {
    dispatchControl, createOuterProxy, handleOuterFinished, refreshPublishedStatus,
    handleCoordinatorEvent(event) {
      if (event.type === "native_start_lookup_requested") configureNativeIdentity();
      if (event.type === "native_ws_relay_failed") {
        const state = coordinator.liveCodeParticipant().snapshot().state;
        recordNativeRootPeerFailure(state, event);
        recordNativeWsRelayFailure(state, event);
      }
      if (event.type === "model_recovery_state") shared.recoveryProxy?.publishRecoveryState(event.envelope);
      if (event.type === "activation_automatically_rolled_back" && shared.parentCodeRuntime?.recover) {
        shared.selectionRecoveryTask = Promise.resolve(shared.parentCodeRuntime.recover({ automaticRollback: event }))
          .then(receipt => {
            shared.selectionRecoveryError = null;
            onEvent({ type: receipt.selectionRestored ? "automatic_rollback_selection_saved" : "automatic_rollback_selection_skipped",
              activationId: event.activationId, ...receipt });
            if (runtimeProfile && shared.publicationStarted && !shared.closed) refreshPublishedStatus();
          }, error => {
            shared.selectionRecoveryError = error.code ?? error.message;
            onEvent({ type: "automatic_rollback_selection_failed", activationId: event.activationId,
              code: shared.selectionRecoveryError });
            if (runtimeProfile && shared.publicationStarted && !shared.closed) refreshPublishedStatus();
          });
      }
      onEvent(event);
      if (runtimeProfile && shared.publicationStarted && !shared.closed) refreshPublishedStatus();
    },
    handleNativeTurn(message, context = {}) {
      for (const lookup of shared.rootStartLookups?.values() ?? []) {
        if (lookup.threadId === message.params?.threadId && (message.method === "turn/started"
          || message.method === "turn/completed" && lookup.turnId === message.params?.turn?.id)) lookup.invalid = true;
      }
      if (shared.nativeSourceGeneration !== nativeSourceGeneration && shared.nativeSource.status().healthy) {
        shared.nativeSource = createInnerNativeTurnSource({ sourceId: configuration.nativeSourceId, coordinator,
          previousSource: shared.nativeSource });
        shared.nativeSourceGeneration = nativeSourceGeneration;
      }
      const rootContext = message.method === "turn/started" ? {
        rootAdmissionOrigin: context.admissionOrigin ?? "legacy_unknown",
        rootAdmissionNativeIdentity: configureNativeIdentity()(),
      } : {};
      rootContext.rootAdmissionNativeIdentity?.catch?.(() => {});
      const observed = shared.nativeSource.observe({ ...message, ...rootContext,
        ...(context.connectionGeneration ? { recoveryConnectionGeneration: context.connectionGeneration } : {}) });
      return context.connectionGeneration ? coordinator.recoveryControl("bind-native", {
        threadId: message.params.threadId, turnId: message.params.turn.id, connectionGeneration: context.connectionGeneration }) : observed;
    },
    handleOuterEvent(proxyOptions, event) {
      if (event.type === "upstream_session_lost") {
        onEvent({ type: "native_event_gap", reason: "APP_SERVER_EVENT_CONNECTION_LOST", instanceToken: options.instanceToken });
      }
      proxyOptions.onEvent?.(event);
      onEvent({ type: "outer_event", event });
    },
    handleOuterResult(value) { shared.outerResult = value; },
    handleOuterFailure(error) { shared.outerResult = { state: "failed", error: { code: error.code ?? error.message } }; },
    handleControlDeadline(deadline) { deadline.resolve(); },
    handleServiceCodeParticipant(participant) {
      shared.serviceCodeParticipant = participant;
      configureNativeIdentity();
      serviceDependencies.onServiceCodeParticipant?.(participant);
    },
    async start() {
      if (shared.started || shared.closed) throw new Error("MANAGED_SESSION_ALREADY_STARTED");
      shared.started = true;
      try {
        if (runtimeProfile) {
          validateInnerRuntimeProfile(configuration, { options });
          if (!await waitForLaunchPublication({ ...options, launchPublicationTimeoutMs: serviceDependencies.launchPublicationTimeoutMs })) {
            throw new Error("START_LAUNCH_NOT_PUBLISHED");
          }
          for (const port of Object.values(runtimeProfile.ports)) {
            const listener = net.createServer();
            await new Promise((resolve, reject) => {
              listener.once("error", reject);
              listener.listen(port, "127.0.0.1", () => listener.close(resolve));
            });
          }
          publish("starting");
          shared.publicationStarted = true;
        }
        shared.innerEndpoint = await coordinator.start(runtimeProfile?.initial ?? configuration.initial);
        shared.outerTask = runCodexAppServerProxyService({ ...options, ...serviceDependencies,
          env: { ...process.env, ...configuration.environment, CODEX_HOME: home },
          onServiceCodeParticipant: shared.bindDispatch("handleServiceCodeParticipant"),
          createProxy: shared.bindDispatch("createOuterProxy"),
        }).then(shared.bindDispatch("handleOuterResult"), shared.bindDispatch("handleOuterFailure"))
          .finally(shared.bindDispatch("handleOuterFinished"));
        const deadline = Date.now() + options.startupBudgetMs + 1000;
        while (!shared.outerFinished && Date.now() < deadline) {
          const runtime = readRuntime();
          if (runtime?.pid === process.pid && runtime.state === "running") {
            if (runtimeProfile && shared.parentCodeRuntime) await shared.parentCodeRuntime.recover();
            publish("running");
            if (runtimeProfile) {
              shared.resources.publicationTimer = setInterval(shared.bindDispatch("refreshPublishedStatus"), 1000);
              shared.resources.publicationTimer.unref();
            }
            return { innerEndpoint: shared.innerEndpoint, downstreamUrl: runtime.downstreamUrl,
              mode: configuration.mode, managedAppServerPid: runtime.appServerPid };
          }
          await sleep(50);
        }
        throw new Error(shared.outerResult?.error?.code ?? "MANAGED_SESSION_START_PENDING");
      } catch (error) {
        if (shared.outerTask) { requestOwnedStop(); await awaitOuterStop(); }
        await closeCoordinator();
        shared.closed = true;
        clearInterval(shared.resources.publicationTimer);
        clearOwnedStop();
        if (shared.publicationStarted) publish("closed");
        shared.rejectCompletion(error);
        throw error;
      }
    },
    async prepareCandidate(specification) { requireReady(); return coordinator.prepareCandidate(specification); },
    async migrate(request) { requireReady(); return coordinator.migrate(request); },
    async activate(request) { requireReady(); return coordinator.activate(request); },
    rollbackActivation(request) { requireReady(); return coordinator.rollbackActivation(request); },
    status() { return { started: shared.started, closed: shared.closed, mode: configuration.mode,
      innerEndpoint: shared.innerEndpoint, nativeSource: shared.nativeSource.status(), coordinator: coordinator.status(),
      outer: readRuntime(), outerFinished: shared.outerFinished, outerResult: shared.outerResult }; },
    waitForClose() { return shared.completion; },
    async close() {
      if (shared.closed) return;
      requireIdle();
      if (shared.outerTask && !shared.outerFinished) { requestOwnedStop(); await awaitOuterStop(); }
      await closeCoordinator();
      shared.closed = true;
      clearInterval(shared.resources.publicationTimer);
      clearOwnedStop();
      publish("closed");
      shared.resolveCompletion(shared.outerResult);
      if (shared.outerResult?.state !== "stopped") throw new Error(shared.outerResult?.error?.code ?? "MANAGED_SESSION_OUTER_FAILED");
    },
  };
}
