import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createOuterEngine } from "./outer-engine.mjs";
import { createOuterRuntimeSelection, OUTER_RUNTIME_SELECTION_FILE } from "./outer-runtime-selection.mjs";

export const OUTER_ENGINE_API_VERSION = 1;
const methods = ["inspectThread", "subscribeThread", "subscribeTask", "wakeThread", "observeDownstream", "observeInjectedRequest", "observeInjectedResponse", "projectUpstream"];
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const fail = code => { throw new Error(code); };
const isResponse = message => message && Object.hasOwn(message, "id") && !message.method;
const threadId = message => message?.params?.threadId ?? message?.result?.thread?.id;
const turnId = message => message?.params?.turnId ?? message?.params?.expectedTurnId ?? message?.params?.turn?.id ?? message?.result?.turn?.id;

function resolveCandidateRoot(root) {
  try { return fs.realpathSync(root); }
  catch { return path.resolve(root); }
}

export function createOuterRuntime(options) {
  const instanceId = options.instanceId ?? crypto.randomUUID();
  const candidateRoot = options.candidateRoot ? resolveCandidateRoot(options.candidateRoot) : null;
  const slots = new Map();
  const entries = new Map();
  const receipts = new Map();
  const loadedHashes = new Set();
  const maximumEntries = options.maximumEntries ?? 32;
  const maximumTurns = options.maximumTurns ?? 2048;
  const selection = candidateRoot ? createOuterRuntimeSelection(candidateRoot, {
    fsImpl: options.selectionFs, maximumHistory: maximumEntries - 1,
  }) : null;
  let persistence = { enabled: Boolean(selection), state: selection ? "unread" : "disabled",
    record: selection ? OUTER_RUNTIME_SELECTION_FILE : null, recordSha256: null, persistedVersion: null,
    recoveryErrors: [], evidence: null, lastWriteError: null };
  let recoveryPromise;
  let revision = 0;
  let busy = false;
  let previous = [];
  let closed = false;
  let auditEnabled = Boolean(candidateRoot);
  const emit = event => {
    if (!auditEnabled) return;
    try { options.onEvent?.({ type: "outer_runtime", ...event }); } catch {}
  };
  function construct(factory, version, sha256 = null) {
    const entry = { id: crypto.randomUUID(), version, sha256, candidate: null, modulePath: null,
      activeOperations: 0, runnable: false, engine: null };
    entry.engine = factory(options.createHost(entry));
    if (entry.engine && typeof entry.engine.then === "function") {
      Promise.resolve(entry.engine).catch(() => {});
      fail("OUTER_ENGINE_ASYNC_FACTORY_INVALID");
    }
    if (!entry.engine || methods.some(method => typeof entry.engine[method] !== "function")) fail("OUTER_ENGINE_INTERFACE_INVALID");
    return entry;
  }
  let active = construct(createOuterEngine, "original");
  active.runnable = true;
  entries.set(active.id, active);
  function slot(client) {
    if (!slots.has(client)) slots.set(client, { rpc: new Map(), pendingTurns: new Map(), turns: new Map(), completedTurns: new Set(), tools: new Map() });
    return slots.get(client);
  }
  const key = message => threadId(message) && turnId(message) ? JSON.stringify([threadId(message), turnId(message)]) : null;
  function pinTurn(state, message, entry) {
    const identity = key(message);
    if (!identity) return;
    if (!state.turns.has(identity)) state.turns.set(identity, entry);
    if (state.turns.size > maximumTurns) {
      for (const oldest of state.completedTurns) {
        if ([...state.tools.values()].some(tool => tool.identity === oldest)) continue;
        state.completedTurns.delete(oldest);
        state.turns.delete(oldest);
        if (state.turns.size <= maximumTurns) break;
      }
    }
  }
  function bindRequest(state, message, entry) {
    if (message?.method && message.id != null) {
      state.rpc.set(message.id, { entry, method: message.method, threadId: threadId(message) });
      if (message.method === "turn/start") {
        const pending = state.pendingTurns.get(threadId(message)) ?? [];
        pending.push({ id: message.id, entry });
        state.pendingTurns.set(threadId(message), pending);
      }
    }
  }
  function consumeResponse(state, message, fallback) {
    const pending = state.rpc.get(message?.id);
    const entry = pending?.entry ?? fallback ?? active;
    if (pending) {
      state.rpc.delete(message.id);
      if (pending.method === "turn/start") {
        const pendingTurns = state.pendingTurns.get(pending.threadId) ?? [];
        const remaining = pendingTurns.filter(item => item.id !== message.id);
        if (remaining.length) state.pendingTurns.set(pending.threadId, remaining);
        else state.pendingTurns.delete(pending.threadId);
        pinTurn(state, { params: { threadId: pending.threadId, turn: message.result?.turn } }, entry);
      }
    }
    return entry;
  }
  function selectEvent(state, message) {
    const identity = key(message);
    if (identity && state.turns.has(identity)) return state.turns.get(identity);
    const pending = state.pendingTurns.get(threadId(message))?.find(item => !item.turnId);
    const entry = pending?.entry ?? active;
    if (message?.method === "turn/started") {
      if (pending) pending.turnId = turnId(message);
      pinTurn(state, message, entry);
    }
    return entry;
  }
  function downstream(client, message) {
    const state = slot(client);
    const tool = isResponse(message) ? state.tools.get(message.id) : null;
    const identity = key(message);
    const entry = tool?.entry ?? (["turn/interrupt", "turn/steer"].includes(message?.method) && identity
      ? state.turns.get(identity) : null) ?? active;
    if (tool) state.tools.delete(message.id);
    bindRequest(state, message, entry);
    entry.engine.observeDownstream(client, message);
    emit({ action: "downstream", version: entry.version, id: message?.id, method: message?.method });
    return entry;
  }
  function injectedRequest(client, message, entry = active) {
    bindRequest(slot(client), message, entry);
    entry.engine.observeInjectedRequest(client, message);
    emit({ action: "injected_request", version: entry.version, id: message.id, method: message.method });
  }
  function injectedResponse(client, message, entry) {
    const selected = consumeResponse(slot(client), message, entry);
    selected.engine.observeInjectedResponse(client, message);
    emit({ action: "injected_response", version: selected.version, id: message?.id });
  }
  function upstream(client, message, { projectionMessage = message } = {}) {
    const state = slot(client);
    const entry = isResponse(message) ? consumeResponse(state, message) : selectEvent(state, message);
    if (message?.method && message.id != null) state.tools.set(message.id, { entry, identity: key(message) });
    const projected = entry.engine.projectUpstream(client, projectionMessage);
    if (message?.method === "turn/completed" && key(message)) state.completedTurns.add(key(message));
    emit({ action: "upstream", version: entry.version, id: message?.id, method: message?.method, turnId: turnId(message) });
    return projected;
  }
  function forgetRequest(client, id, { retainTurn = false } = {}) {
    const state = slots.get(client);
    const pending = state?.rpc.get(id);
    if (retainTurn && pending?.method === "turn/start") return;
    state?.rpc.delete(id);
    if (pending?.method === "turn/start") {
      const remaining = (state.pendingTurns.get(pending.threadId) ?? []).filter(item => item.id !== id);
      if (remaining.length) state.pendingTurns.set(pending.threadId, remaining);
      else state.pendingTurns.delete(pending.threadId);
    }
  }
  async function invoke(method, input) {
    if (closed) fail("OUTER_RUNTIME_CLOSED");
    const entry = active;
    entry.activeOperations += 1;
    emit({ action: "operation_started", version: entry.version, method });
    try { return await entry.engine[method](input); }
    finally {
      entry.activeOperations -= 1;
      emit({ action: "operation_finished", version: entry.version, method });
    }
  }
  function identity(input) {
    if (input.instanceId !== instanceId) fail("OUTER_RUNTIME_INSTANCE_MISMATCH");
    if (input.revision !== revision) fail("OUTER_RUNTIME_REVISION_MISMATCH");
  }
  function candidate(input) {
    if (typeof input !== "string") {
      identity(input);
      if (!candidateRoot) fail("OUTER_RUNTIME_CONTROL_DISABLED");
      if (typeof input.candidate !== "string" || path.isAbsolute(input.candidate)) fail("OUTER_RUNTIME_PATH_INVALID");
    }
    const resolved = fs.realpathSync(typeof input === "string" ? input : path.resolve(candidateRoot, input.candidate));
    if (!candidateRoot) return resolved;
    const relative = path.relative(candidateRoot, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("OUTER_RUNTIME_PATH_OUTSIDE_ROOT");
    return resolved;
  }
  async function prepare(input) {
    if (closed) fail("OUTER_RUNTIME_CLOSED");
    if (busy) fail("OUTER_RUNTIME_PREPARE_BUSY");
    if (entries.size >= maximumEntries) fail("OUTER_RUNTIME_MODULE_LIMIT");
    busy = true;
    const preparingRevision = revision;
    try {
      const modulePath = candidate(input);
      if (path.extname(modulePath) !== ".mjs") fail("OUTER_RUNTIME_MODULE_REQUIRED");
      const bytes = fs.readFileSync(modulePath);
      if (bytes.length > 256 * 1024) fail("OUTER_RUNTIME_MODULE_TOO_LARGE");
      const sha256 = digest(bytes);
      if (typeof input !== "string" && input.sha256 !== sha256) fail("OUTER_RUNTIME_SHA_MISMATCH");
      if (!loadedHashes.has(sha256) && loadedHashes.size >= maximumEntries - 1) fail("OUTER_RUNTIME_MODULE_LIMIT");
      loadedHashes.add(sha256);
      const imported = await import(`data:text/javascript;base64,${bytes.toString("base64")}#${sha256}`);
      const module = imported.default ?? imported;
      if (module.apiVersion !== OUTER_ENGINE_API_VERSION || typeof module.version !== "string"
        || !module.version.trim() || module.version.length > 128 || typeof module.createEngine !== "function") fail("OUTER_ENGINE_MANIFEST_INVALID");
      const entry = construct(module.createEngine, module.version, sha256);
      entry.modulePath = modulePath;
      entry.candidate = candidateRoot ? path.relative(candidateRoot, modulePath).split(path.sep).join("/") : null;
      if (entry.engine.validate) await entry.engine.validate(Object.freeze({ phase: "prepare", apiVersion: OUTER_ENGINE_API_VERSION }));
      if (closed || preparingRevision !== revision) fail("OUTER_RUNTIME_PREPARATION_STALE");
      const receipt = Object.freeze({ instanceId, revision, preparationId: entry.id, version: entry.version, sha256 });
      entries.set(entry.id, entry);
      receipts.set(entry.id, { receipt, entry, modulePath, used: false });
      auditEnabled = true;
      emit({ action: "prepared", ...receipt });
      return receipt;
    } finally { busy = false; }
  }
  function checkActivation(entry) {
    const checked = entry.engine.beforeActivate?.(Object.freeze({ revision, previousVersion: active.version }));
    if (checked && typeof checked.then === "function") {
      Promise.resolve(checked).catch(() => {});
      fail("OUTER_RUNTIME_ASYNC_ACTIVATION_INVALID");
    }
    if (checked === false) fail("OUTER_RUNTIME_ACTIVATION_REJECTED");
  }
  const describe = entry => ({ candidate: entry.candidate, version: entry.version, sha256: entry.sha256 });
  function checkSelectionModule(entry) {
    if (entry.modulePath && (candidate({ instanceId, revision, candidate: entry.candidate }) !== entry.modulePath
      || digest(fs.readFileSync(entry.modulePath)) !== entry.sha256)) fail("OUTER_RUNTIME_SHA_MISMATCH");
  }
  function persistSelection(entry, history) {
    if (!selection) return;
    try {
      checkSelectionModule(entry);
      const saved = selection.save({ revision: revision + 1, selected: describe(entry), previous: history.map(describe) });
      persistence = { ...persistence, ...saved, lastWriteError: null };
    } catch (error) {
      persistence = { ...persistence, lastWriteError: error.failureCode ?? error.code ?? error.message };
      emit({ action: "selection_write_failed", version: entry.version, code: error.code ?? error.message, failureCode: persistence.lastWriteError });
      throw error;
    }
  }
  function activate(input) {
    if (closed) fail("OUTER_RUNTIME_CLOSED");
    const preparation = receipts.get(input?.preparationId);
    if (!preparation || Object.keys(preparation.receipt).some(field => input[field] !== preparation.receipt[field])) fail("OUTER_RUNTIME_PREPARATION_INVALID");
    if (preparation.used) return { ...status(), alreadyActivated: true };
    identity(input);
    if (digest(fs.readFileSync(preparation.modulePath)) !== input.sha256) fail("OUTER_RUNTIME_SHA_MISMATCH");
    checkActivation(preparation.entry);
    persistSelection(preparation.entry, [...previous, active]);
    previous.push(active);
    active = preparation.entry;
    active.runnable = true;
    preparation.used = true;
    revision += 1;
    emit({ action: "activated", version: active.version, revision });
    return status();
  }
  function restore(input = { instanceId, revision }) {
    if (closed) fail("OUTER_RUNTIME_CLOSED");
    identity(input);
    if (!previous.length) fail("OUTER_RUNTIME_RESTORE_UNAVAILABLE");
    const selected = previous.at(-1);
    persistSelection(selected, previous.slice(0, -1));
    active = previous.pop();
    revision += 1;
    emit({ action: "restored", version: active.version, revision });
    return status();
  }
  function status() {
    return { enabled: Boolean(candidateRoot), instanceId, revision, version: active.version, sha256: active.sha256,
      busy, closed, persistence: { ...persistence, recoveryErrors: [...persistence.recoveryErrors] },
      moduleCount: entries.size, importedHashCount: loadedHashes.size, activeOperationCount: [...entries.values()].reduce((total, entry) => total + entry.activeOperations, 0),
      trackedRequestCount: [...slots.values()].reduce((total, state) => total + state.rpc.size, 0),
      pendingToolCount: [...slots.values()].reduce((total, state) => total + state.tools.size, 0) };
  }
  async function recoverSelection() {
    if (!selection || persistence.state === "saved") return status();
    const saved = selection.read();
    persistence = { ...persistence, state: saved.state, recordSha256: saved.recordSha256 };
    const preserve = () => {
      try { persistence.evidence = selection.preserveEvidence(); }
      catch (error) { persistence.evidenceError = error.code ?? error.message; }
    };
    if (!saved.record) {
      if (saved.error) {
        persistence.recoveryErrors.push({ candidate: null, code: saved.error });
        preserve();
        emit({ action: "selection_fallback", version: active.version, persistence: status().persistence });
      }
      return status();
    }
    persistence.persistedVersion = saved.record.selected.version;
    const original = active;
    const descriptors = [...saved.record.previous, saved.record.selected];
    const loaded = new Map();
    async function load(index) {
      if (loaded.has(index)) return loaded.get(index);
      const descriptor = descriptors[index];
      let entry = null;
      try {
        if (descriptor.candidate === null) entry = original;
        else {
          const receipt = await prepare({ instanceId, revision, candidate: descriptor.candidate, sha256: descriptor.sha256 });
          entry = receipts.get(receipt.preparationId).entry;
          receipts.delete(receipt.preparationId);
          if (entry.version !== descriptor.version) fail("OUTER_RUNTIME_SELECTION_VERSION_MISMATCH");
          checkActivation(entry);
          checkSelectionModule(entry);
        }
      } catch (error) {
        entry = null;
        persistence.recoveryErrors.push({ candidate: descriptor.candidate, code: error.code ?? error.message });
      }
      loaded.set(index, entry);
      return entry;
    }
    let selectedIndex = descriptors.length - 1;
    let selected = null;
    while (selectedIndex >= 0 && !selected) {
      selected = await load(selectedIndex);
      if (!selected) selectedIndex -= 1;
    }
    const history = [];
    for (let index = 0; index < selectedIndex; index += 1) {
      const entry = await load(index);
      if (entry) { entry.runnable = true; history.push(entry); }
    }
    if (closed) fail("OUTER_RUNTIME_CLOSED");
    active = selected ?? original;
    active.runnable = true;
    previous = history;
    revision = saved.record.revision;
    persistence.state = selectedIndex === descriptors.length - 1 ? "recovered" : "fallback";
    if (persistence.recoveryErrors.length) preserve();
    emit({ action: "selection_recovered", version: active.version, revision, persistence: status().persistence });
    return status();
  }
  function reopenSelection() {
    if (closed) return Promise.reject(new Error("OUTER_RUNTIME_CLOSED"));
    recoveryPromise ??= recoverSelection();
    return recoveryPromise;
  }
  return { invoke, prepare, activate, restore, reopenSelection, status, downstream, upstream, injectedRequest, injectedResponse, forgetRequest,
    orphanResponse(client, message) {
      const state = slots.get(client);
      if (!state?.rpc.has(message.id)) return;
      const entry = consumeResponse(state, message);
      emit({ action: "orphan_response", version: entry.version, id: message.id });
    },
    closeClient(client) { slots.delete(client); },
    close() { closed = true; slots.clear(); },
  };
}
