import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import net from "node:net";
import { createCodexAppServerProxy } from "./codex-app-server-proxy.mjs";
import { parseArguments, runCodexAppServerProxyService, waitForLaunchPublication } from "./codex-app-server-proxy-runner.mjs";
import { createInnerProxyCoordinator } from "./inner-proxy-coordinator.mjs";
import { createInnerNativeTurnSource } from "./inner-native-turn-source.mjs";
import { validateInnerRuntimeProfile, approvedInnerCandidate, readInnerCandidateRegistry } from "./inner-runtime-profile.mjs";
import { createProxyParentCodeRuntime } from "./proxy-live-parent-runtime.mjs";
import { createProxyClassCodeParticipant } from "./proxy-live-code-runtime.mjs";
import { createProxyWholeRuntimeControl } from "./proxy-whole-runtime-control.mjs";

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
    stopWritten: false, publicationStarted: false, cleanupError: null, coordinatorCloseTask: null,
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
  const publish = state => {
    if (!runtimeProfile) return;
    const statePath = runtimeProfile.managedStatePath;
    const temporary = `${statePath}.${crypto.randomUUID()}.pending`;
    const current = coordinator.status();
    const source = shared.nativeSource.status();
    const healthy = state === "running" && !shared.outerFinished && source.healthy && current.running
      && current.nativeHealthy && current.workers.some(worker => worker.workerId === current.defaultWorkerId && worker.alive);
    try {
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, state: state === "running" && !healthy ? "degraded" : state,
        healthy, livenessAt: new Date().toISOString(), ownerId: configuration.ownerId,
        nativeSourceId: configuration.nativeSourceId, pid: process.pid, instanceToken: options.instanceToken,
        front: { pid: process.pid, host: "127.0.0.1", port: shared.innerEndpoint?.port ?? null, listening: current.running },
        innerEndpoint: shared.innerEndpoint, nativeSource: source, stopFilePath: options.stopFilePath, outerResult: shared.outerResult,
        error: shared.cleanupError, coordinator: current, controlRevision: shared.controlRevision, controlBusy: shared.controlBusy,
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
    if (shared.stopWritten || shared.outerFinished) return;
    if (fs.existsSync(options.stopFilePath)) return;
    fs.writeFileSync(options.stopFilePath, shared.stopIdentity, { flag: "wx" });
    shared.stopWritten = true;
  }
  function controlStatus() {
    requireReady();
    const current = coordinator.status();
    const selected = current.workers.find(worker => worker.workerId === current.defaultWorkerId && worker.alive);
    if (!shared.innerEndpoint || readRuntime()?.state !== "running" || !selected) throw new Error("INNER_CONTROL_NOT_READY");
    return { ok: true, ownerId: configuration.ownerId, nativeSourceId: configuration.nativeSourceId,
      instanceToken: options.instanceToken, revision: shared.controlRevision, busy: shared.controlBusy,
      selectedWorkerId: selected.workerId, selectedSourceHashes: selected.sourceHashes,
      coordinator: current, operations: [...shared.controlOperations.values()] };
  }
  function bindControl(input) {
    if (input.ownerId !== configuration.ownerId || input.nativeSourceId !== configuration.nativeSourceId
      || input.instanceToken !== options.instanceToken) throw new Error("INNER_CONTROL_IDENTITY_MISMATCH");
  }
  async function dispatchControl(method, input, context = {}) {
    bindControl(input);
    const current = controlStatus();
    if (method === "status") return current;
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
      ...(shared.managedInnerControl ? { managedInnerControl: shared.managedInnerControl } : {}),
      onNativeTurn: shared.bindDispatch("handleNativeTurn"),
      onEvent: shared.bindDispatch("handleOuterEvent", proxyOptions) });
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
      onEvent(event);
      if (runtimeProfile && shared.publicationStarted && !shared.closed) refreshPublishedStatus();
    },
    handleNativeTurn(message) {
      if (shared.nativeSourceGeneration !== nativeSourceGeneration && shared.nativeSource.status().healthy) {
        shared.nativeSource = createInnerNativeTurnSource({ sourceId: configuration.nativeSourceId, coordinator,
          previousSource: shared.nativeSource });
        shared.nativeSourceGeneration = nativeSourceGeneration;
      }
      return shared.nativeSource.observe(message);
    },
    handleOuterEvent(proxyOptions, event) {
      if (event.type === "upstream_session_lost") shared.nativeSource.invalidate("APP_SERVER_EVENT_CONNECTION_LOST");
      proxyOptions.onEvent?.(event);
      onEvent({ type: "outer_event", event });
    },
    handleOuterResult(value) { shared.outerResult = value; },
    handleOuterFailure(error) { shared.outerResult = { state: "failed", error: { code: error.code ?? error.message } }; },
    handleControlDeadline(deadline) { deadline.resolve(); },
    handleServiceCodeParticipant(participant) {
      shared.serviceCodeParticipant = participant;
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
